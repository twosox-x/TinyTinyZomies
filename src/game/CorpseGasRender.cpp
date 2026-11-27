// Corpse gas / ground fire rendering (GAME_DESIGN 14d). See CorpseGasRender.h.
#include "game/CorpseGasRender.h"

#include "app/App.h"
#include "game/CorpseGas.h"
#include "render/Renderer.h"

#include <SDL3/SDL.h>
#include <array>

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
        u.style[0] = hazeAlpha; u.style[1] = (float)app_->renderTime; u.style[2] = 0.35f; u.style[3] = 1.0f;
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

void CorpseGasRender::fireVolumes(float camX, float camZ, std::vector<FireVolume>& out, int maxN) const {
    if (!gas_ || !app_) return;
    std::vector<std::array<float, 4>> spots;
    gas_->fireSpots(camX, camZ, maxN, spots);
    for (const auto& s : spots) {
        float y = app_->cityRenderer.heightAt(s[0], s[2]);
        if (!(y > -50.f && y < 3.f)) y = 0.f;   // piles burn in the street (a roof's fire volume would float)
        FireVolume f{s[0], y + 0.2f, s[2], 1.6f, s[3] * 0.55f, (uint32_t)(s[0] * 31.f + s[2] * 17.f)};
        out.push_back(f);
    }
}

} // namespace ttz::game
