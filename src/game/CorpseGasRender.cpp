// Corpse gas / ground fire rendering (GAME_DESIGN 14d). See CorpseGasRender.h.
#include "game/CorpseGasRender.h"

#include "app/App.h"
#include "game/CorpseGas.h"
#include "render/Renderer.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <array>
#include <cmath>

namespace ttz::game {

namespace {
struct GasDraw {   // std140, == GasDraw in shaders/gas.vert
    float origin[4];
    uint32_t dim[4];
    float style[4];
};
} // namespace

bool CorpseGasRender::init(AppState& app, CorpseGas& gas) {
    app_ = &app;
    gas_ = &gas;
    GpuContext& gpu = app.gpu;
    SDL_GPUShader* v = gpu.loadShader("gas.vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu.loadShader("gas.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) return false;
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
    ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    ci.multisample_state.sample_count = app.renderer.msaaSamples() == 4 ? SDL_GPU_SAMPLECOUNT_4 : SDL_GPU_SAMPLECOUNT_1;
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = false;   // translucent haze: never hides what is behind / inside it
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;   // == Renderer kColorFormat
    ctd.blend_state.enable_blend = true;
    ctd.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_SRC_ALPHA;
    ctd.blend_state.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    ctd.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    ctd.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ZERO;   // keep the scene alpha (depth-of-field CoC)
    ctd.blend_state.dst_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    ctd.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
    ci.target_info.depth_stencil_format = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;   // == Renderer kDepthFormat
    ci.target_info.has_depth_stencil_target = true;
    pipe_ = SDL_CreateGPUGraphicsPipeline(gpu.device(), &ci);
    SDL_ReleaseGPUShader(gpu.device(), v);
    SDL_ReleaseGPUShader(gpu.device(), f);
    if (!pipe_) { SDL_Log("corpse gas: pipeline: %s", SDL_GetError()); return false; }
    Renderer::Extension e;
    e.draw = [this](SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer*, SDL_GPUBuffer*, SDL_GPUBuffer* corpseH) {
        if (!gas_ || !gas_->listBuffer() || !app_) return;
        const CrowdSim& sim = app_->sim;
        const SimUniforms su = sim.uniforms();
        GasDraw u{};
        u.origin[0] = su.world.x; u.origin[1] = su.world.y; u.origin[2] = gas_->cellSize(); u.origin[3] = su.world.z;
        u.dim[0] = (uint32_t)gas_->width(); u.dim[1] = (uint32_t)gas_->height(); u.dim[2] = su.grid.x; u.dim[3] = su.grid.y;
        u.style[0] = hazeAlpha; u.style[1] = (float)app_->renderTime; u.style[2] = 0.25f; u.style[3] = 1.0f;
        SDL_BindGPUGraphicsPipeline(pass, pipe_);
        SDL_GPUBuffer* vb[4] = {gas_->listBuffer(), gas_->fieldBuffer(), sim.staticHeight(), corpseH ? corpseH : sim.corpseHeight()};
        SDL_BindGPUVertexStorageBuffers(pass, 0, vb, 4);
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_DrawGPUPrimitivesIndirect(pass, gas_->listBuffer(), 0, 1);
    };
    ext_ = app.renderer.addExtension(e);
    return true;
}

void CorpseGasRender::shutdown(AppState& app) {
    if (ext_) app.renderer.removeExtension(ext_);
    ext_ = 0;
    if (pipe_) SDL_ReleaseGPUGraphicsPipeline(app.gpu.device(), pipe_);
    pipe_ = nullptr;
    gas_ = nullptr;
}

void CorpseGasRender::noteFlames(const std::vector<FxEvent>& fx, double time, float range) {
    for (const FxEvent& e : fx) {
        if (e.kind != FxKind::Flame) continue;
        const uint32_t id = e.soldier.packed();
        auto it = std::find_if(streams_.begin(), streams_.end(), [&](const Stream& s) { return s.id == id; });
        if (it == streams_.end()) { streams_.push_back({}); it = streams_.end() - 1; it->id = id; it->start = time; }
        if (time - it->last > 0.6) it->start = time;   // a new burst
        it->o = e.pos; it->d = e.dir; it->last = time; it->range = range;
    }
    streams_.erase(std::remove_if(streams_.begin(), streams_.end(), [&](const Stream& s) { return time - s.last > 1.0; }), streams_.end());
}

void CorpseGasRender::flameVolumes(float camX, float camZ, double time, std::vector<FlameVolume>& out, int maxStreams, int maxPools) const {
    std::vector<const Stream*> live;
    for (const Stream& s : streams_) if (time - s.last < 0.45) live.push_back(&s);
    std::sort(live.begin(), live.end(), [&](const Stream* a, const Stream* b) {
        return (a->o.x - camX) * (a->o.x - camX) + (a->o.z - camZ) * (a->o.z - camZ) < (b->o.x - camX) * (b->o.x - camX) + (b->o.z - camZ) * (b->o.z - camZ);
    });
    for (size_t k = 0; k < live.size() && (int)k < maxStreams; ++k) {
        const Stream& s = *live[k];
        const float in = (float)std::clamp((time - s.start) / 0.12, 0.0, 1.0), outF = (float)std::clamp(1.0 - (time - s.last - 0.15) / 0.3, 0.0, 1.0);
        const float yaw = std::atan2(s.d.x, s.d.z), pitch = std::asin(std::clamp(s.d.y, -1.f, 1.f));
        // the stream grows to its reach over the first 0.2 s of a burst
        const float reach = s.range * (float)std::clamp((time - s.start) / 0.2, 0.25, 1.0);
        out.push_back({s.o.x, s.o.y, s.o.z, reach, yaw, pitch, std::min(in, outF), s.id * 2654435761u, 2});
    }
    if (!gas_) return;
    std::vector<std::array<float, 4>> spots;
    gas_->fireSpots(camX, camZ, maxPools, spots);
    for (const auto& p : spots) {
        float y = app_ ? app_->cityRenderer.heightAt(p[0], p[2]) : 0.f;
        if (!(y > -50.f && y < 3.f)) y = 0.f;
        out.push_back({p[0], y + 0.05f, p[2], p[1], 0.f, 0.f, p[3], (uint32_t)(p[0] * 31.f + p[2] * 17.f), 3});
    }
}

} // namespace ttz::game
