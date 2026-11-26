#pragma once
// Key-light shadow map (shaders/include/shadow.glsl): shared state handed from the Renderer to the city / character
// renderers, and the depth-only pipeline variant every caster pipeline derives from its scene pipeline.
#include "gpu/GpuContext.h"

namespace ttz {

constexpr SDL_GPUTextureFormat kShadowDepthFormat = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;

struct ShadowMapBinding {
    SDL_GPUTexture* texture = nullptr;   // depth (kShadowDepthFormat), sampled with a comparison sampler
    SDL_GPUSampler* sampler = nullptr;
    bool valid() const { return texture && sampler; }
};

// Depth-only copy of a scene pipeline description: the vertex stage and input layout are kept, the fragment stage is
// the empty shadow_depth.frag, no colour targets, single-sampled, no culling (thin voxel walls cast from both sides),
// slope-scaled depth bias, depth clamping (casters between the sun and the near plane still cast).
inline SDL_GPUGraphicsPipeline* makeShadowPipeline(GpuContext& gpu, SDL_GPUGraphicsPipelineCreateInfo ci) {
    SDL_GPUShader* f = gpu.loadShader("shadow_depth.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!f) return nullptr;
    ci.fragment_shader = f;
    ci.target_info = {};
    ci.target_info.num_color_targets = 0;
    ci.target_info.depth_stencil_format = kShadowDepthFormat;
    ci.target_info.has_depth_stencil_target = true;
    ci.multisample_state = {};
    ci.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    ci.rasterizer_state.enable_depth_bias = true;
    ci.rasterizer_state.depth_bias_constant_factor = 0.f;
    ci.rasterizer_state.depth_bias_slope_factor = 1.5f;
    ci.rasterizer_state.depth_bias_clamp = 0.f;
    ci.rasterizer_state.enable_depth_clip = false;
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = true;
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
    SDL_GPUGraphicsPipeline* p = SDL_CreateGPUGraphicsPipeline(gpu.device(), &ci);
    if (!p) SDL_Log("shadow pipeline: %s", SDL_GetError());
    SDL_ReleaseGPUShader(gpu.device(), f);
    return p;
}

} // namespace ttz
