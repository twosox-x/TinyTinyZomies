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

float CorpseGasRender::visualReach(const Stream& s, double time) { return 0.85f * s.range * (float)std::clamp((time - s.start) / 0.2, 0.25, 1.0); }

// where the jet's centreline (fx_volume.glsl flameCentre: droop 0.0128 s^2) reaches the ground (~1.25 m below the nozzle)
bool CorpseGasRender::impact(const Stream& s, float reach, V3& out) const {
    float ground = s.o.y - 1.25f;
    if (app_) { const float h = app_->cityRenderer.heightAt(s.o.x + s.d.x * reach, s.o.z + s.d.z * reach); if (h > ground - 3.f && h < ground + 1.f) ground = h; }
    for (float d = 0.5f; d <= reach + 0.01f; d += 0.25f) {
        const float y = s.o.y + s.d.y * d - 0.0128f * d * d;
        if (y <= ground + 0.15f || d + 0.25f > reach) {
            out = {s.o.x + s.d.x * d, ground, s.o.z + s.d.z * d};
            return y <= ground + 0.6f;   // a jet ending in the air makes no pool
        }
    }
    return false;
}

void CorpseGasRender::flameLights(double time, std::vector<PointLight>& out) const {
    for (const Stream& s : streams_) {
        if (time - s.last > 0.45) continue;
        const float reach = visualReach(s, time);
        const float fl = 0.8f + 0.12f * std::sin((float)time * 37.f + (float)(s.id & 63u)) + 0.08f * std::sin((float)time * 23.f);
        const V3 m = s.o + s.d * (reach * 0.55f);
        out.push_back({m.x, m.y + 0.2f, m.z, 7.5f, 1.0f, 0.62f, 0.24f, 2.4f * fl});
        V3 hit;
        if (impact(s, reach, hit)) out.push_back({hit.x, hit.y + 0.4f, hit.z, 5.f, 1.0f, 0.55f, 0.18f, 1.6f * fl});
    }
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
        // the jet grows to its reach over the first 0.2 s of a burst (visual reach ~0.85 x the weapon range: v4 ~7.5 m)
        const float reach = visualReach(s, time);
        const float str = std::min(in, outF);
        out.push_back({s.o.x, s.o.y, s.o.z, reach, yaw, pitch, str, s.id * 2654435761u, 2});
        V3 hit;
        if (impact(s, reach, hit)) out.push_back({hit.x, hit.y, hit.z, 0.5f, 0.f, 0.f, str, s.id * 747796405u, 3});   // pool where it lands
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
