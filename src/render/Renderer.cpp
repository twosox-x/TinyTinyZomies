#include "render/Renderer.h"

#include "city/CityRenderer.h"
#include "stb_image_write.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
struct CubeVertex { float p[3], n[3]; };

void buildCube(std::vector<CubeVertex>& v, std::vector<uint16_t>& idx) {
    const float N[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    const int C[6][4][3] = {{{1, 0, 0}, {1, 1, 0}, {1, 1, 1}, {1, 0, 1}}, {{0, 0, 1}, {0, 1, 1}, {0, 1, 0}, {0, 0, 0}},
                            {{0, 1, 0}, {0, 1, 1}, {1, 1, 1}, {1, 1, 0}}, {{0, 0, 1}, {0, 0, 0}, {1, 0, 0}, {1, 0, 1}},
                            {{1, 0, 1}, {1, 1, 1}, {0, 1, 1}, {0, 0, 1}}, {{0, 0, 0}, {0, 1, 0}, {1, 1, 0}, {1, 0, 0}}};
    for (int f = 0; f < 6; ++f) {
        uint16_t b = (uint16_t)v.size();
        for (int k = 0; k < 4; ++k)
            v.push_back({{(float)C[f][k][0], (float)C[f][k][1], (float)C[f][k][2]}, {N[f][0], N[f][1], N[f][2]}});
        uint16_t t[6] = {b, (uint16_t)(b + 1), (uint16_t)(b + 2), b, (uint16_t)(b + 2), (uint16_t)(b + 3)};   // CCW from outside
        idx.insert(idx.end(), t, t + 6);
    }
}
constexpr SDL_GPUTextureFormat kColorFormat = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
constexpr SDL_GPUTextureFormat kDepthFormat = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
constexpr SDL_GPUTextureFormat kDofFormat = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;   // half-res DOF layers (HDR bokeh)
constexpr SDL_GPUTextureFormat kFxVoxFormat = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT;   // fx hit voxel (centre, size)
constexpr uint32_t kDofTile = 8;   // half-res px per near-CoC tile (shaders/post_dof_tile.frag)
} // namespace

int Renderer::msaaSamples() const {
    switch (samples_) {
    case SDL_GPU_SAMPLECOUNT_2: return 2;
    case SDL_GPU_SAMPLECOUNT_4: return 4;
    case SDL_GPU_SAMPLECOUNT_8: return 8;
    default: return 1;
    }
}

SDL_GPUGraphicsPipeline* Renderer::makePipeline(const char* vs, const char* fs, bool modelVertex, bool cubeVertex, bool cull, bool cullFront,
                                                SDL_GPUGraphicsPipeline** shadowOut) {
    SDL_GPUShader* v = gpu_->loadShader(std::string(vs) + ".vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu_->loadShader(std::string(fs) + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) return nullptr;
    SDL_GPUVertexBufferDescription vbd{};
    SDL_GPUVertexAttribute attrs[5]{};
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    if (modelVertex) {
        vbd = {0, sizeof(ModelVertex), SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
        attrs[0] = {0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(ModelVertex, pos)};
        attrs[1] = {1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(ModelVertex, normal)};
        attrs[2] = {2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, offsetof(ModelVertex, uv)};
        attrs[3] = {3, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, offsetof(ModelVertex, pivot)};
        attrs[4] = {4, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT, offsetof(ModelVertex, part)};
        ci.vertex_input_state = {&vbd, 1, attrs, 5};
    } else if (cubeVertex) {
        vbd = {0, sizeof(CubeVertex), SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
        attrs[0] = {0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
        attrs[1] = {1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 12};
        ci.vertex_input_state = {&vbd, 1, attrs, 2};
    }
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = cullFront ? SDL_GPU_CULLMODE_FRONT : cull ? SDL_GPU_CULLMODE_BACK : SDL_GPU_CULLMODE_NONE;
    ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    ci.multisample_state.sample_count = samples_;
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = true;
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = kColorFormat;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
    ci.target_info.depth_stencil_format = kDepthFormat;
    ci.target_info.has_depth_stencil_target = true;
    SDL_GPUGraphicsPipeline* p = SDL_CreateGPUGraphicsPipeline(gpu_->device(), &ci);
    if (!p) SDL_Log("pipeline %s/%s: %s", vs, fs, SDL_GetError());
    if (shadowOut) *shadowOut = makeShadowPipeline(*gpu_, ci);
    SDL_ReleaseGPUShader(gpu_->device(), v);
    SDL_ReleaseGPUShader(gpu_->device(), f);
    return p;
}

SDL_GPUGraphicsPipeline* Renderer::makePostPipeline(const char* fs, uint32_t targets, bool hdr) {
    SDL_GPUShader* v = gpu_->loadShader("post.vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu_->loadShader(std::string(fs) + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) return nullptr;
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    SDL_GPUColorTargetDescription ctd[2]{};
    ctd[0].format = ctd[1].format = hdr ? kDofFormat : kColorFormat;
    ci.target_info.color_target_descriptions = ctd;
    ci.target_info.num_color_targets = targets;
    SDL_GPUGraphicsPipeline* p = SDL_CreateGPUGraphicsPipeline(gpu_->device(), &ci);
    if (!p) SDL_Log("pipeline post/%s: %s", fs, SDL_GetError());
    SDL_ReleaseGPUShader(gpu_->device(), v);
    SDL_ReleaseGPUShader(gpu_->device(), f);
    return p;
}

bool Renderer::init(GpuContext& gpu, const Model& zombie, const Sandbox& sb, const SimParams& p,
                    SDL_GPUTextureFormat swapchainFormat) {
    gpu_ = &gpu;
    params_ = p;
    swapFormat_ = swapchainFormat;
    SDL_GPUDevice* d = gpu.device();
    samples_ = SDL_GPUTextureSupportsSampleCount(d, kColorFormat, SDL_GPU_SAMPLECOUNT_4) ? SDL_GPU_SAMPLECOUNT_4
                                                                                         : SDL_GPU_SAMPLECOUNT_1;
    // Cull: the voxel model and cube are closed meshes with CCW outward faces. The procedural
    // animation never mirrors geometry, so back-face culling is safe.
    pZombie_ = makePipeline("zombie", "zombie", true, false, true);
    pCorpse_ = makePipeline("corpse", "zombie", true, false, true);
    pBox_ = makePipeline("box", "box", false, true, true, false, &pBoxShadow_);
    pGround_ = makePipeline("ground", "ground", false, false, false);
    pParticle_ = makePipeline("particle", "particle", false, false, true);
    pFx_ = makePipeline("fx_volume", "fx_volume", false, false, true);                 // camera inside: far faces
    pFxNear_ = makePipeline("fx_volume", "fx_volume_near", false, false, true, true);  // outside: near faces, early-Z
    {   // reduced-resolution fx volumes (offscreen: colour + hit voxel, own depth) and their full-res composite
        SDL_GPUShader* v = gpu_->loadShader("fx_volume.vert", SDL_GPU_SHADERSTAGE_VERTEX);
        SDL_GPUShader* f0 = gpu_->loadShader("fx_volume_half.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        SDL_GPUShader* f1 = gpu_->loadShader("fx_volume_half_near.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        SDL_GPUShader* pv = gpu_->loadShader("post.vert", SDL_GPU_SHADERSTAGE_VERTEX);
        SDL_GPUShader* fc = gpu_->loadShader("fx_composite.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        if (!v || !f0 || !f1 || !pv || !fc) return false;
        SDL_GPUGraphicsPipelineCreateInfo ci{};
        ci.vertex_shader = v;
        ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        ci.depth_stencil_state.enable_depth_test = true;
        ci.depth_stencil_state.enable_depth_write = true;
        ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
        SDL_GPUColorTargetDescription ctd[2]{};
        ctd[0].format = kColorFormat;
        ctd[1].format = kFxVoxFormat;
        ci.target_info.color_target_descriptions = ctd;
        ci.target_info.num_color_targets = 2;
        ci.target_info.depth_stencil_format = kDepthFormat;
        ci.target_info.has_depth_stencil_target = true;
        ci.fragment_shader = f0;
        ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pFxHalf_ = SDL_CreateGPUGraphicsPipeline(d, &ci);
        ci.fragment_shader = f1;
        ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_FRONT;
        pFxHalfNear_ = SDL_CreateGPUGraphicsPipeline(d, &ci);
        ci.vertex_shader = pv;
        ci.fragment_shader = fc;
        ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        ci.multisample_state.sample_count = samples_;
        ci.target_info.num_color_targets = 1;
        pFxComp_ = SDL_CreateGPUGraphicsPipeline(d, &ci);
        for (SDL_GPUShader* sh : {v, f0, f1, pv, fc}) SDL_ReleaseGPUShader(d, sh);
        if (!pFxHalf_ || !pFxHalfNear_ || !pFxComp_) { SDL_Log("fx half-res pipelines: %s", SDL_GetError()); return false; }
    }
    pDofPre_ = makePostPipeline("post_dof_prefilter", 1, true);
    pDofTile_ = makePostPipeline("post_dof_tile", 1, true);
    pDofDilate_ = makePostPipeline("post_dof_dilate", 1, true);
    pDofGather_ = makePostPipeline("post_dof_gather", 2, true);
    pDofFill_ = makePostPipeline("post_dof_fill", 2, true);
    pComposite_ = makePostPipeline("post_composite");
    if (!pZombie_ || !pCorpse_ || !pBox_ || !pGround_ || !pParticle_ || !pFx_ || !pFxNear_ || !pDofPre_ || !pDofTile_ || !pDofDilate_ ||
        !pDofGather_ || !pDofFill_ || !pComposite_) return false;
    {
        SDL_GPUSamplerCreateInfo sci{};
        sci.min_filter = sci.mag_filter = SDL_GPU_FILTER_LINEAR;
        sci.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        sci.address_mode_u = sci.address_mode_v = sci.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        linear_ = SDL_CreateGPUSampler(d, &sci);
        sci.enable_compare = true;                       // shadow map: hardware depth comparison, bilinear PCF
        sci.compare_op = SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
        shadowCmp_ = SDL_CreateGPUSampler(d, &sci);
    }
    ensureShadowMap(2048);
    lampDummy_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, 64, "lampGridEmpty");
    {
        std::vector<uint32_t> z(16, 0);
        gpu.uploadNow(lampDummy_, z.data(), 64);
    }

    zombieIndexCount_ = (uint32_t)zombie.indices.size();
    variantRows_ = zombie.variantRows;
    modelHeight_ = zombie.height;
    zombieVB_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_VERTEX, (uint32_t)(zombie.vertices.size() * sizeof(ModelVertex)), "zombieVB");
    zombieIB_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_INDEX, (uint32_t)(zombie.indices.size() * 4), "zombieIB");
    gpu.uploadNow(zombieVB_, zombie.vertices.data(), (uint32_t)(zombie.vertices.size() * sizeof(ModelVertex)));
    gpu.uploadNow(zombieIB_, zombie.indices.data(), (uint32_t)(zombie.indices.size() * 4));

    std::vector<CubeVertex> cv;
    std::vector<uint16_t> ci;
    buildCube(cv, ci);
    cubeVB_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_VERTEX, (uint32_t)(cv.size() * sizeof(CubeVertex)), "cubeVB");
    cubeIB_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_INDEX, (uint32_t)(ci.size() * 2), "cubeIB");
    gpu.uploadNow(cubeVB_, cv.data(), (uint32_t)(cv.size() * sizeof(CubeVertex)));
    gpu.uploadNow(cubeIB_, ci.data(), (uint32_t)(ci.size() * 2));

    // palette texture (nearest filtering keeps voxel colours crisp)
    SDL_GPUTextureCreateInfo tci{};
    tci.type = SDL_GPU_TEXTURETYPE_2D;
    tci.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    tci.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    tci.width = (Uint32)zombie.texW;
    tci.height = (Uint32)zombie.texH;
    tci.layer_count_or_depth = 1;
    tci.num_levels = 1;
    palette_ = SDL_CreateGPUTexture(d, &tci);
    {
        uint32_t size = (uint32_t)zombie.rgba.size();
        SDL_GPUTransferBufferCreateInfo tb{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, size, 0};
        SDL_GPUTransferBuffer* t = SDL_CreateGPUTransferBuffer(d, &tb);
        std::memcpy(SDL_MapGPUTransferBuffer(d, t, false), zombie.rgba.data(), size);
        SDL_UnmapGPUTransferBuffer(d, t);
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(d);
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTextureTransferInfo src{t, 0, 0, 0};
        SDL_GPUTextureRegion dst{};
        dst.texture = palette_;
        dst.w = tci.width;
        dst.h = tci.height;
        dst.d = 1;
        SDL_UploadToGPUTexture(cp, &src, &dst, false);
        SDL_EndGPUCopyPass(cp);
        SDL_SubmitGPUCommandBuffer(cmd);
        SDL_ReleaseGPUTransferBuffer(d, t);
    }
    SDL_GPUSamplerCreateInfo sci{};
    sci.min_filter = SDL_GPU_FILTER_NEAREST;
    sci.mag_filter = SDL_GPU_FILTER_NEAREST;
    sci.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sci.address_mode_u = sci.address_mode_v = sci.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    nearest_ = SDL_CreateGPUSampler(d, &sci);
    setSandbox(sb);
    return true;
}

void Renderer::setSandbox(const Sandbox& sb) {
    sandbox_ = sb;
    shadowExt_ = nullptr;
    std::vector<Vec4> data;
    int i = 0;
    for (const Box& b : sb.boxes) {
        float seed = std::fmod(0.5f + 0.61803398f * (float)(i++), 1.0f);   // golden-ratio sequence
        data.push_back({b.minX, 0.f, b.minZ, (float)(int)b.kind});
        data.push_back({b.maxX, b.height, b.maxZ, seed});
    }
    boxCount_ = (uint32_t)sb.boxes.size();
    gpu_->releaseBuffer(boxes_);
    if (!data.empty()) {
        boxes_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(data.size() * sizeof(Vec4)), "boxes");
        gpu_->uploadNow(boxes_, data.data(), (uint32_t)(data.size() * sizeof(Vec4)));
    }
    buildShadowField(sb);
}

// Moon shadow height field (see shaders/include/shadow.glsl): for each cell, the highest point that a box
// occluder hides from the moon. A ray from (x, y, z) towards the moon L hits box B iff its horizontal
// projection enters B's footprint at some t >= 0 (entry ta) while still below the box top:
// y + ta * L.y <= height  ->  shadowed for y <= height - ta * L.y. Each box only touches its shadow footprint.
void Renderer::buildShadowField(const Sandbox& sb) {
    const V3 L = normalize(V3{-0.35f, 0.8f, 0.45f});           // must match the moon direction in render()
    const uint32_t W = (uint32_t)params_.gridW * kDecalScale, H = (uint32_t)params_.gridH * kDecalScale;
    const float cell = params_.cellSize / kDecalScale;
    std::vector<float> field((size_t)W * H, -1.0f);
    for (const Box& b : sb.boxes) {
        float reach = b.height * std::sqrt(L.x * L.x + L.z * L.z) / L.y;
        float rx0 = std::min(b.minX, b.minX - L.x / std::sqrt(L.x * L.x + L.z * L.z) * reach);
        float rx1 = std::max(b.maxX, b.maxX - L.x / std::sqrt(L.x * L.x + L.z * L.z) * reach);
        float rz0 = std::min(b.minZ, b.minZ - L.z / std::sqrt(L.x * L.x + L.z * L.z) * reach);
        float rz1 = std::max(b.maxZ, b.maxZ - L.z / std::sqrt(L.x * L.x + L.z * L.z) * reach);
        int cx0 = std::max(0, (int)std::floor((rx0 - sandbox_.originX) / cell) - 1);
        int cx1 = std::min((int)W - 1, (int)std::ceil((rx1 - sandbox_.originX) / cell) + 1);
        int cz0 = std::max(0, (int)std::floor((rz0 - sandbox_.originZ) / cell) - 1);
        int cz1 = std::min((int)H - 1, (int)std::ceil((rz1 - sandbox_.originZ) / cell) + 1);
        for (int cz = cz0; cz <= cz1; ++cz)
            for (int cx = cx0; cx <= cx1; ++cx) {
                float x = sandbox_.originX + (cx + 0.5f) * cell, z = sandbox_.originZ + (cz + 0.5f) * cell;
                float ta = 0.0f, tb = 1e9f;
                auto slab = [&](float o, float d, float lo, float hi) {
                    if (std::fabs(d) < 1e-6f) { if (o < lo || o > hi) tb = -1.0f; return; }
                    float t0 = (lo - o) / d, t1 = (hi - o) / d;
                    ta = std::max(ta, std::min(t0, t1));
                    tb = std::min(tb, std::max(t0, t1));
                };
                slab(x, L.x, b.minX, b.maxX);
                slab(z, L.z, b.minZ, b.maxZ);
                if (ta > tb) continue;
                float thr = b.height - ta * L.y;
                float& f = field[(size_t)cz * W + cx];
                f = std::max(f, thr);
            }
    }
    gpu_->releaseBuffer(shadowH_);
    shadowH_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(field.size() * 4), "moonShadowField");
    gpu_->uploadNow(shadowH_, field.data(), (uint32_t)(field.size() * 4));
}

void Renderer::setShadowField(const std::vector<float>& field) {
    const size_t n = (size_t)params_.gridW * kDecalScale * params_.gridH * kDecalScale;
    if (field.size() != n) return;
    gpu_->releaseBuffer(shadowH_);
    shadowH_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(n * 4), "moonShadowField");
    gpu_->uploadNow(shadowH_, field.data(), (uint32_t)(n * 4));
}

void Renderer::shutdown() {
    if (!gpu_) return;
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (auto p : {pFxHalf_, pFxHalfNear_, pFxComp_}) if (p) SDL_ReleaseGPUGraphicsPipeline(d, p);
    for (auto t : {fxCol_, fxVox_, fxDepth_}) if (t) SDL_ReleaseGPUTexture(d, t);
    for (auto p : {pBoxShadow_, pZombie_, pCorpse_, pBox_, pGround_, pParticle_, pFx_, pFxNear_, pDofPre_, pDofTile_, pDofDilate_, pDofGather_,
                   pDofFill_, pComposite_})
        if (p) SDL_ReleaseGPUGraphicsPipeline(d, p);
    for (auto b : {&zombieVB_, &zombieIB_, &cubeVB_, &cubeIB_, &boxes_, &shadowH_, &lampDummy_}) gpu_->releaseBuffer(*b);
    for (auto t : {palette_, colorMS_, depth_, resolved_, dofPre_, dofBgA_, dofFgA_, dofBgB_, dofFgB_, dofTile_, dofTileD_, final_})
        if (t) SDL_ReleaseGPUTexture(d, t);
    if (nearest_) SDL_ReleaseGPUSampler(d, nearest_);
    if (linear_) SDL_ReleaseGPUSampler(d, linear_);
    if (shadowCmp_) SDL_ReleaseGPUSampler(d, shadowCmp_);
    if (shadowTex_) SDL_ReleaseGPUTexture(d, shadowTex_);
    shadowTex_ = nullptr;
    gpu_ = nullptr;
}

void Renderer::ensureTargets(uint32_t w, uint32_t h) {
    if (w == targetW_ && h == targetH_ && resolved_) return;
    SDL_GPUDevice* d = gpu_->device();
    for (auto t : {colorMS_, depth_, resolved_, dofPre_, dofBgA_, dofFgA_, dofBgB_, dofFgB_, dofTile_, dofTileD_, final_})
        if (t) SDL_ReleaseGPUTexture(d, t);
    colorMS_ = nullptr;
    SDL_GPUTextureCreateInfo ci{};
    ci.type = SDL_GPU_TEXTURETYPE_2D;
    ci.width = w;
    ci.height = h;
    ci.layer_count_or_depth = 1;
    ci.num_levels = 1;
    ci.format = kColorFormat;
    ci.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    resolved_ = SDL_CreateGPUTexture(d, &ci);
    final_ = SDL_CreateGPUTexture(d, &ci);
    ci.format = kDofFormat;
    ci.width = std::max(1u, w / 2);
    ci.height = std::max(1u, h / 2);
    for (SDL_GPUTexture** t : {&dofPre_, &dofBgA_, &dofFgA_, &dofBgB_, &dofFgB_}) *t = SDL_CreateGPUTexture(d, &ci);
    ci.width = (ci.width + kDofTile - 1) / kDofTile;
    ci.height = (ci.height + kDofTile - 1) / kDofTile;
    dofTile_ = SDL_CreateGPUTexture(d, &ci);
    dofTileD_ = SDL_CreateGPUTexture(d, &ci);
    ci.format = kColorFormat;
    ci.width = w;
    ci.height = h;
    if (samples_ != SDL_GPU_SAMPLECOUNT_1) {
        ci.sample_count = samples_;
        ci.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
        colorMS_ = SDL_CreateGPUTexture(d, &ci);
    }
    ci.format = kDepthFormat;
    ci.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    ci.sample_count = samples_;
    depth_ = SDL_CreateGPUTexture(d, &ci);
    targetW_ = w;
    targetH_ = h;
}

void Renderer::ensureFxTargets(uint32_t w, uint32_t h) {
    if (w == fxW_ && h == fxH_ && fxCol_) return;
    SDL_GPUDevice* d = gpu_->device();
    for (auto t : {fxCol_, fxVox_, fxDepth_}) if (t) SDL_ReleaseGPUTexture(d, t);
    SDL_GPUTextureCreateInfo ci{};
    ci.type = SDL_GPU_TEXTURETYPE_2D;
    ci.width = w;
    ci.height = h;
    ci.layer_count_or_depth = 1;
    ci.num_levels = 1;
    ci.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    ci.format = kColorFormat;
    fxCol_ = SDL_CreateGPUTexture(d, &ci);
    ci.format = kFxVoxFormat;
    fxVox_ = SDL_CreateGPUTexture(d, &ci);
    ci.format = kDepthFormat;
    ci.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    fxDepth_ = SDL_CreateGPUTexture(d, &ci);
    fxW_ = w;
    fxH_ = h;
}

void Renderer::ensureShadowMap(uint32_t size) {
    size = size <= 1024 ? 1024u : size <= 2048 ? 2048u : 4096u;
    if (size == shadowSize_ && shadowTex_) return;
    SDL_GPUDevice* d = gpu_->device();
    if (shadowTex_) SDL_ReleaseGPUTexture(d, shadowTex_);
    SDL_GPUTextureCreateInfo ci{};
    ci.type = SDL_GPU_TEXTURETYPE_2D_ARRAY;   // two layers: the sun at two neighbouring clock keys (cross-faded)
    ci.format = kShadowDepthFormat;
    ci.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    ci.width = ci.height = size;
    ci.layer_count_or_depth = 2;
    ci.num_levels = 1;
    shadowTex_ = SDL_CreateGPUTexture(d, &ci);
    shadowSize_ = shadowTex_ ? size : 0;
    layerKey_[0] = layerKey_[1] = -1;
    if (!shadowTex_) { SDL_Log("shadow map %u: %s", size, SDL_GetError()); return; }
    // clear once: the map is bound (never sampled) on frames without a shadow pass
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(d);
    for (Uint8 layer = 0; layer < 2; ++layer) {
        SDL_GPUDepthStencilTargetInfo st{};
        st.texture = shadowTex_;
        st.clear_depth = 1.0f;
        st.load_op = SDL_GPU_LOADOP_CLEAR;
        st.store_op = SDL_GPU_STOREOP_STORE;
        st.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
        st.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
        st.layer = layer;
        SDL_EndGPURenderPass(SDL_BeginGPURenderPass(cmd, nullptr, 0, &st));
    }
    SDL_SubmitGPUCommandBuffer(cmd);
}

// Key-light shadow map fit. The light's view is anchored at the world origin (its x / y axes depend only on the light
// direction), the ortho box covers the camera's visible ground (5 x 5 screen rays to y = 0 and 25 m above it, clamped
// to shadowRange from the pivot) in light space; its half extents snap up to 1/8-octave steps and its centre to whole
// texels, so panning moves the map by whole texels (no shimmer) and zooming changes its size only in steps. Depth:
// 500 m towards the light .. 500 m beyond the pivot, nearer casters are depth-clamped (ShadowPass.h).
bool Renderer::shadowView(const Camera& cam, float aspect, const RenderSettings& rs, M4& lightVP, float* texelMetres) const {
    if (rs.studioLighting || !rs.shadows || !rs.shadowMap || !shadowTex_) return false;
    const TimeOfDayLight tl = evalTimeOfDay(rs.tod);
    if (tl.color.x + tl.color.y + tl.color.z < 1e-4f) return false;
    // Smooth sun without crawling edges: a light that rotates every frame re-orients the texel grid every frame and
    // every shadow edge shimmers, a stepped one jumps. So each map is rendered from a fixed direction, the clock key
    // k * kShadowKeyH (1/150 h, ~0.1 deg of sun path; ~0.7 s real by day), and the receivers cross-fade between the
    // maps of the two keys around the clock (shadowBlend). The two keys live in the two layers of the map (key parity);
    // the frames alternate which layer is re-rendered (re-fitted to the camera, texel-snapped), so the cost stays one
    // shadow pass per frame and a layer is at most one frame old.
    const int layer = (int)(shadowFrame_ & 1u);
    const int key = shadowKeyFor(rs.tod.hours, layer);
    TimeOfDaySettings qt = rs.tod;
    qt.hours = std::fmod((float)key * kShadowKeyH, 24.f);
    const TimeOfDayLight ql = evalTimeOfDay(qt);
    const V3 L = (ql.moon == tl.moon) ? ql.dir : tl.dir, tgt = cam.target();
    const M4 view = lookAt(L * 500.f, V3{0, 0, 0}, std::fabs(L.y) > 0.99f ? V3{0, 0, 1} : V3{0, 1, 0});
    V3 fwd = tgt - cam.eye();
    fwd.y = 0;
    fwd = std::sqrt(dot(fwd, fwd)) > 1e-3f ? normalize(fwd) : V3{0, 0, 1};
    const float range = std::max(rs.shadowRange, 10.f), Hs = 1000.f, Ws = Hs * std::max(aspect, 0.1f);
    float mnx = 1e30f, mny = 1e30f, mxx = -1e30f, mxy = -1e30f;
    for (int j = 0; j <= 4; ++j)
        for (int i = 0; i <= 4; ++i) {
            V3 p;
            if (!cam.screenToGround(Ws * (float)i / 4.f, Hs * (float)j / 4.f, Ws, Hs, 0.f, p) || dot(p - tgt, fwd) > range) p = tgt + fwd * range;
            V3 dxz = p - tgt;
            dxz.y = 0;
            float l = std::sqrt(dot(dxz, dxz));
            if (l > range) p = tgt + dxz * (range / l);
            for (float y : {0.f, 25.f}) {
                V3 q{p.x, y, p.z};
                float x = view(0, 0) * q.x + view(0, 1) * q.y + view(0, 2) * q.z + view(0, 3);
                float yy = view(1, 0) * q.x + view(1, 1) * q.y + view(1, 2) * q.z + view(1, 3);
                mnx = std::min(mnx, x); mxx = std::max(mxx, x);
                mny = std::min(mny, yy); mxy = std::max(mxy, yy);
            }
        }
    auto stepUp = [](float v) { return std::exp2(std::ceil(std::log2(std::max(v, 8.f)) * 8.f) / 8.f); };
    // size hysteresis: grow at once, shrink only when the fit needs < 3/4 of the current box (rotating / tilting the
    // camera near a step boundary no longer flips the map size, which re-samples every shadow edge)
    auto sticky = [](float want, float& cur) { if (want > cur || want < cur * 0.75f) cur = want; return cur; };
    const float hx = sticky(stepUp(0.5f * (mxx - mnx) + 3.f), shadowHx_[layer]), hy = sticky(stepUp(0.5f * (mxy - mny) + 3.f), shadowHy_[layer]);
    const float n = (float)shadowSize_, tx = 2.f * hx / n, ty = 2.f * hy / n;
    const float cx = std::round(0.5f * (mnx + mxx) / tx) * tx, cy = std::round(0.5f * (mny + mxy) / ty) * ty;
    const float zn = std::floor(-dot(L, tgt) / 4.f) * 4.f, zf = zn + 1000.f;   // depth window in 4 m steps (stable depths while panning)   // view-space distance range along -L: 500 m above .. 500 m below the pivot
    M4 proj;
    proj(0, 0) = 1.f / hx; proj(0, 3) = -cx / hx;
    proj(1, 1) = 1.f / hy; proj(1, 3) = -cy / hy;
    proj(2, 2) = -1.f / (zf - zn); proj(2, 3) = -zn / (zf - zn);
    proj(3, 3) = 1.f;
    lightVP = mul(proj, view);
    if (texelMetres) *texelMetres = std::max(tx, ty);
    return true;
}

// Auto focus: distance along five view rays (screen centre and a small cross, +-4 % of the height) to the first
// point below the city's coarse height grid (4 m cells of max heights: roofs, walls, vehicles), marched in 0.5 m steps
// near the eye growing with distance and refined by bisection; the median of the five (stable at roof edges).
float Renderer::measureFocus(const Camera& cam, uint32_t w, uint32_t h) const {
    const float camDist = std::max(1.f, cam.distance());
    if (!city_) return camDist;
    const V3 eye = cam.eye();
    const float W = (float)std::max(1u, w), H = (float)std::max(1u, h), o = 0.04f * H;
    const float pts[5][2] = {{0, 0}, {o, 0}, {-o, 0}, {0, o}, {0, -o}};
    float ds[5];
    for (int k = 0; k < 5; ++k) {
        V3 g;
        float dist = camDist;
        if (cam.screenToGround(W * 0.5f + pts[k][0], H * 0.5f + pts[k][1], W, H, cam.target().y - 50.f, g)) {
            const V3 dir = normalize(g - eye);
            const float tMax = camDist * 3.f + 100.f;
            float t = 0.f, prev = 0.f;
            bool hit = false;
            while (t < tMax) {
                const V3 p = eye + dir * t;
                if (p.y <= city_->heightAt(p.x, p.z) || p.y < cam.target().y - 0.5f) { hit = true; break; }
                prev = t;
                t += std::max(0.5f, t * 0.006f);
            }
            if (hit) {
                for (int it = 0; it < 6; ++it) {
                    const float m = 0.5f * (prev + t);
                    const V3 p = eye + dir * m;
                    if (p.y <= city_->heightAt(p.x, p.z) || p.y < cam.target().y - 0.5f) t = m; else prev = m;
                }
                dist = t;
            }
        }
        ds[k] = std::clamp(dist, 2.f, camDist * 3.f + 100.f);
    }
    std::sort(ds, ds + 5);
    // never focus beyond the pivot: the rig's pivot sits on the ground (so a hit is nearer: a roof, a wall), and a
    // raised pivot (close-up of a soldier, whom the height grid does not contain) is the subject itself
    return std::min(ds[2], camDist);
}

void Renderer::addBlast(float x, float y, float z, float scale) {
    blasts_.push_back({x, y, z, 0.f, std::max(scale, 0.1f)});
    // chain reactions: a blast going off inside a young fireball (< 0.6 s, within ~its radius) grows that volume
    // (volume-additive scale, centre pulled towards the new one) instead of stacking a second overlapping ray-march
    const float sc = std::clamp(scale, 0.3f, 3.f);
    for (auto it = fxBlasts_.rbegin(); it != fxBlasts_.rend() && mergeBlasts; ++it) {
        FxBlast& b = *it;
        if (b.age > 0.6f) continue;
        const float r = 1.9f * std::pow(std::max(b.scale, sc), 0.8f) + 1.2f;
        const float dx = x - b.x, dy = y - b.y, dz = z - b.z;
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        const float s3 = b.scale * b.scale * b.scale, n3 = sc * sc * sc, ns = std::min(3.f, std::cbrt(s3 + n3));
        const float wgt = n3 / (s3 + n3);
        b.x += dx * wgt; b.y += dy * wgt; b.z += dz * wgt;
        b.scale = ns;
        ++fxMerged_;
        if (blasts_.size() > (size_t)kMaxBlasts) blasts_.erase(blasts_.begin());
        return;
    }
    fxBlasts_.push_back({x, y, z, 0.f, sc, (float)((fxSeed_++ * 2654435761u) % 997u)});
    if (fxBlasts_.size() > (size_t)kMaxFxVolumes) fxBlasts_.erase(fxBlasts_.begin());
    if (blasts_.size() > (size_t)kMaxBlasts) blasts_.erase(blasts_.begin());
}

void Renderer::update(float dt) {
    for (auto& b : blasts_) b.age += dt;
    for (auto& b : fxBlasts_) b.age += dt;
    fxBlasts_.erase(std::remove_if(fxBlasts_.begin(), fxBlasts_.end(), [](const FxBlast& b) { return b.age > 5.5f + 2.f * b.scale; }),
                    fxBlasts_.end());   // = fxLife()
    blasts_.erase(std::remove_if(blasts_.begin(), blasts_.end(), [](const Blast& b) { return b.age > 20.f; }), blasts_.end());
}

void Renderer::prepareCharacters(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const Camera& cam, const CrowdSim& sim,
                                 double time, const RenderSettings& rs, CharacterRenderer* chars) {
    if (!chars || rs.characterModel != 1) return;
    M4 vp = mul(cam.proj((float)w / (float)h), cam.view());
    V3 e = cam.eye();
    float eye[3] = {e.x, e.y, e.z};
    chars->prepare(cmd, sim, vp.m, eye, time, rs.chars);
}

uint32_t Renderer::drawCalls(const RenderSettings& rs, const CharacterRenderer* chars) const {
    uint32_t n = (rs.drawGround ? 1u : 0u) + (rs.drawBoxes && boxCount_ ? 1u : 0u) + (rs.drawParticles ? 1u : 0u);
    if (city_) n += city_->stats().drawCalls;
    if (rs.characterModel == 1 && chars) n += chars->drawCalls(rs.chars);
    else n += (rs.drawZombies ? 1u : 0u) + (rs.drawCorpses ? 1u : 0u);
    return n;
}

void Renderer::setLights(const std::vector<PointLight>& lights) {
    sandbox_.lights = lights;
    for (auto& [id, e] : exts_) if (e.lights) e.lights(sandbox_.lights);
}

int Renderer::addExtension(Extension e) {
    exts_.push_back({nextExt_, std::move(e)});
    return nextExt_++;
}

void Renderer::removeExtension(int id) {
    for (size_t i = 0; i < exts_.size(); ++i)
        if (exts_[i].first == id) { exts_.erase(exts_.begin() + (long)i); return; }
}

void Renderer::render(SDL_GPUCommandBuffer* cmd, SDL_GPUTexture* target, uint32_t w, uint32_t h, const Camera& cam,
                      const CrowdSim& sim, double time, const RenderSettings& rs, CharacterRenderer* chars, uint32_t outW,
                      uint32_t outH) {
    ensureTargets(w, h);
    ensureShadowMap((uint32_t)rs.shadowMapSize);
    const bool modular = chars && rs.characterModel == 1;
    if (modular && !skipCharacterPrepare_) prepareCharacters(cmd, w, h, cam, sim, time, rs, chars);
    if (extPrepare) extPrepare(cmd);
    for (auto& [id, e] : exts_) if (e.prepare) e.prepare(cmd);
    FrameUniforms fu{};
    M4 vp = mul(cam.proj((float)w / (float)h), cam.view());
    std::memcpy(fu.viewProj, vp.m, sizeof(fu.viewProj));
    V3 e = cam.eye();
    fu.camPos = {e.x, e.y, e.z, (float)time};
    // time of day (TimeOfDay.h): key light (sun / moon), hemisphere ambient, fog, exposure, night emissives. The .w slots
    // carry exposure (sunColor), miniature depth-of-field focus / range (sunDir / skyColor) and the fog start (groundColor)
    const TimeOfDayLight tl = evalTimeOfDay(rs.tod);
    const float camDist = cam.distance();
    const bool dof = rs.tiltShift && !rs.studioLighting && rs.dofStrength > 0.f;
    // focus: the scene under the screen centre (auto focus, smoothed in log distance), else the pivot
    float focus = camDist;
    if (dof && rs.dofAutoFocus && city_) {
        const float want = measureFocus(cam, w, h);
        const double dtf = time - focusTime_;
        if (focusDist_ <= 0.f || dtf <= 0.0 || dtf > 0.5) focusDist_ = want;
        else {
            const float k = 1.f - std::exp(-(float)dtf / std::max(0.01f, rs.dofFocusTime));
            focusDist_ = std::exp(std::log(focusDist_) + (std::log(want) - std::log(focusDist_)) * k);
        }
        focusTime_ = time;
        focus = focusDist_;
    } else focusDist_ = -1.f;
    fu.sunDir = {tl.dir.x, tl.dir.y, tl.dir.z, std::max(1.f, focus * (1.f + rs.dofFocusOffset))};   // w: thin-lens focus (finishA)
    fu.sunColor = {tl.color.x, tl.color.y, tl.color.z, tl.exposure * rs.exposure};
    const RenderSettings::DofAt da = rs.dofAt(camDist);   // zoom-adaptive aperture / max blur / in-focus band / tilt-shift
    fu.skyColor = {tl.sky.x, tl.sky.y, tl.sky.z, dof ? std::max(1e-3f, da.aperture) : 0.f};   // aperture, 0 = CoC 0
    fu.dofP = {dof ? da.band : 0.f, dof ? da.tilt : 0.f, std::clamp(rs.dofTiltSharp, 0.f, 0.95f), 0.f};
    dofMaxBlurEff_ = da.maxBlur;
    fu.groundColor = {tl.ground.x, tl.ground.y, tl.ground.z, rs.fogStart * camDist};
    fu.fogColor = {tl.fog.x, tl.fog.y, tl.fog.z, rs.fogDensity};
    fu.todP = {tl.night, 1.f + 0.6f * tl.night, tl.moon ? 1.f : 0.f, rs.tod.hours};
    M4 lightVP;
    float texelM = 0.1f;
    const bool shadowMap = shadowView(cam, (float)w / (float)h, rs, lightVP, &texelM);
    const int shLayer = (int)(shadowFrame_ & 1u);
    if (shadowMap) {
        layerKey_[shLayer] = shadowKeyFor(rs.tod.hours, shLayer);
        layerVP_[shLayer] = lightVP;
    }
    {   // cross-fade between the maps of the clock keys n and n + 1 (whichever are rendered; see shadowView)
        const float kh = std::fmod(std::fmod(rs.tod.hours, 24.f) + 24.f, 24.f) / kShadowKeyH;
        const int n = (int)std::floor(kh) % kShadowKeys, n1 = (n + 1) % kShadowKeys;
        const float f = kh - std::floor(kh);
        const bool va = layerKey_[n & 1] == n, vb = layerKey_[n1 & 1] == n1;
        int la = n & 1, lb = n1 & 1;
        float wb = f;
        if (!va || !vb) { la = lb = shLayer; wb = 0.f; }   // a key not rendered yet (clock jump, first frames): this frame's map only
        std::memcpy(fu.shadowVP, layerVP_[la].m, sizeof(fu.shadowVP));
        std::memcpy(fu.shadowVP2, layerVP_[lb].m, sizeof(fu.shadowVP2));
        fu.shadowP2 = {wb, (float)la, (float)lb, 0.f};
    }
    fu.shadowP = {shadowMap ? 1.f : 0.f, texelM, 3e-5f, std::max(0.25f, rs.shadowSoftness) / (float)std::max(1u, shadowSize_)};
    if (rs.studioLighting) {   // neutral studio close to Zombie Lab's "Neutral" mode (sage backdrop, warm key)
        V3 key = normalize(V3{0.47f, 0.76f, 0.40f});
        fu.sunDir = {key.x, key.y, key.z, 0};
        fu.sunColor = {0.62f, 0.58f, 0.50f, 0};
        fu.skyColor = {0.42f, 0.45f, 0.38f, 0};
        fu.groundColor = {0.16f, 0.17f, 0.12f, 0};
        fu.fogColor = {0.424f, 0.463f, 0.322f, 0.0f};
        fu.sunDir.w = fu.skyColor.w = fu.groundColor.w = 0.f;
        fu.sunColor.w = 1.f;
        fu.todP = {1.f, 1.f, 0.f, 0.f};   // emissives as at night (the pre-day/night studio look)
    }
    fu.gridP = {sandbox_.originX, sandbox_.originZ, params_.cellSize, 1.0f / params_.cellSize};
    // dynamic point lights (burning wrecks, lab lights): drop those whose sphere is off-screen, merge fire lights
    // closer than 6 m (a burning row of cars = a few big lights), cap at maxFireLights (nearest the pivot first)
    std::vector<PointLight> lights;
    fxStats_.lightsCulled = 0;
    if (!rs.studioLighting && rs.fireLights) {
        float pl[6][4];
        for (int c = 0; c < 4; ++c) {   // frustum planes (Gribb-Hartmann, depth 0..1)
            pl[0][c] = vp(3, c) + vp(0, c); pl[1][c] = vp(3, c) - vp(0, c); pl[2][c] = vp(3, c) + vp(1, c);
            pl[3][c] = vp(3, c) - vp(1, c); pl[4][c] = vp(2, c); pl[5][c] = vp(3, c) - vp(2, c);
        }
        auto visible = [&](const PointLight& L) {
            for (auto& q : pl) {
                float n = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
                if ((q[0] * L.x + q[1] * L.y + q[2] * L.z + q[3]) / std::max(n, 1e-6f) < -std::fabs(L.radius)) return false;
            }
            return true;
        };
        for (const PointLight& L : sandbox_.lights) {
            if (rs.perfLegacy) { if (lights.size() < 16) lights.push_back(L); continue; }
            if (!visible(L)) { ++fxStats_.lightsCulled; continue; }
            bool merged = false;
            for (PointLight& M : lights) {
                if (L.radius < 0.f || M.radius < 0.f) continue;   // sharp muzzle lights stay small and separate
                float dx = L.x - M.x, dz = L.z - M.z;
                if (dx * dx + dz * dz > 36.f || std::fabs(L.radius - M.radius) > 0.5f * M.radius + 4.f) continue;
                float wa = M.intensity, wb = L.intensity, ws = std::max(wa + wb, 1e-4f);
                M.x = (M.x * wa + L.x * wb) / ws; M.y = (M.y * wa + L.y * wb) / ws; M.z = (M.z * wa + L.z * wb) / ws;
                M.radius = std::max(M.radius, L.radius) + 0.5f * std::sqrt(dx * dx + dz * dz);
                M.intensity = std::max(wa, wb) + 0.35f * std::min(wa, wb);
                merged = true;
                break;
            }
            if (!merged) lights.push_back(L);
            if ((int)lights.size() >= std::min(rs.maxFireLights, kMaxLights)) break;
        }
    }
    fxStats_.lights = (uint32_t)lights.size();
    mergeBlasts = !rs.perfLegacy;
    uint32_t nl = (uint32_t)lights.size();
    fu.gridDim = {(uint32_t)params_.gridW, (uint32_t)params_.gridH, nl,
                  rs.debugFlags | (rs.shadows && !rs.studioLighting ? 32u : 0u) | (city_ ? 64u : 0u)};
    fu.modelP = {(float)variantRows_, modelHeight_, params_.standHeight, params_.proneHeight};
    const auto& g = sim.goals();
    for (size_t i = 0; i + 1 < g.size() && i / 2 < 4; i += 2) fu.goals[i / 2] = {g[i], 0, g[i + 1], 1};
    for (int i = 0; i < kMaxBlasts; ++i) fu.blasts[i] = {0, 0, 0, -1};
    for (size_t i = 0; i < blasts_.size() && rs.fireLights; ++i) {
        fu.blasts[i] = {blasts_[i].x, blasts_[i].y, blasts_[i].z, blasts_[i].age};
        fu.blastsP[i] = {blasts_[i].scale, 0, 0, 0};
    }
    const float lampScale = city_ ? 1.f : tl.night;   // city: the app scales its street lamps (fire lights stay)
    for (uint32_t i = 0; i < nl; ++i) {
        const PointLight& L = lights[i];
        fu.lightPos[i] = {L.x, L.y, L.z, L.radius};
        fu.lightCol[i] = {L.r, L.g, L.b, L.intensity * lampScale};
    }
    const ShadowMapBinding smb{shadowTex_, shadowCmp_};
    if (city_) city_->setShadowMap(smb);
    if (chars) chars->setShadowMap(smb);
    if (city_) city_->settings.lamps = !rs.studioLighting;
    SDL_GPUBuffer* lampGrid = city_ && !rs.studioLighting ? city_->lampGrid() : lampDummy_;
    if (chars) chars->setLampGrid(lampGrid);
    shadowDraws_ = 0;
    if (shadowMap) {   // key-light depth pass: the scene's vertex stages with the light's view-projection
        FrameUniforms su = fu;
        std::memcpy(su.viewProj, lightVP.m, sizeof(su.viewProj));
        SDL_PushGPUVertexUniformData(cmd, 0, &su, sizeof(su));
        SDL_PushGPUFragmentUniformData(cmd, 0, &su, sizeof(su));
        SDL_GPUDepthStencilTargetInfo st{};
        st.texture = shadowTex_;
        st.clear_depth = 1.0f;
        st.load_op = SDL_GPU_LOADOP_CLEAR;
        st.store_op = SDL_GPU_STOREOP_STORE;
        st.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
        st.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
        st.layer = (Uint8)shLayer;
        SDL_GPURenderPass* sp = SDL_BeginGPURenderPass(cmd, nullptr, 0, &st);
        if (city_) { city_->drawShadow(sp, cmd); shadowDraws_ += city_->shadowDrawCalls(); }
        if (rs.drawBoxes && boxCount_ && pBoxShadow_) {
            SDL_BindGPUGraphicsPipeline(sp, pBoxShadow_);
            SDL_GPUBufferBinding vb{cubeVB_, 0};
            SDL_BindGPUVertexBuffers(sp, 0, &vb, 1);
            SDL_GPUBufferBinding ib{cubeIB_, 0};
            SDL_BindGPUIndexBuffer(sp, &ib, SDL_GPU_INDEXELEMENTSIZE_16BIT);
            SDL_BindGPUVertexStorageBuffers(sp, 0, &boxes_, 1);
            SDL_DrawGPUIndexedPrimitives(sp, 36, boxCount_, 0, 0, 0);
            shadowDraws_++;
        }
        if (modular) { chars->drawShadow(cmd, sp, sim, time, rs.chars); shadowDraws_ += chars->drawCalls(rs.chars); }
        if (extShadowDraw) extShadowDraw(sp, cmd);
        for (auto& [id, e] : exts_) if (e.shadowDraw) e.shadowDraw(sp, cmd);
        SDL_EndGPURenderPass(sp);
    }
    SDL_PushGPUVertexUniformData(cmd, 0, &fu, sizeof(fu));
    SDL_PushGPUFragmentUniformData(cmd, 0, &fu, sizeof(fu));

    // ---- voxel fireballs / smoke / wreck fires: volume list, screen budget, LOD; reduced-resolution pass -------------
    fxDrawn_ = 0;
    uint32_t fxN = 0;
    FxVolumeUniforms fx{};
    const int fxDiv = std::clamp(rs.fxResDiv, 1, 4);
    const bool fxHalf = rs.fxHalfRes && fxDiv > 1 && pFxHalf_ && !rs.perfLegacy;
    SDL_Rect fxScissor{0, 0, 0, 0};
    fxStats_ = FxStats{0, 0, fxMerged_, fxStats_.lights, fxStats_.lightsCulled, 0.f};
    if (rs.drawFxVolumes && (!fxBlasts_.empty() || !fires_.empty())) {
        // nearest first: with conservative depth the near-face pass rejects voxels behind closer ones early
        struct Vol { Vec4 a, b; float d; };
        Vol vols[kMaxFxVolumes];
        uint32_t n = 0;
        for (auto it = fxBlasts_.rbegin(); it != fxBlasts_.rend() && n < (uint32_t)kMaxFxVolumes; ++it, ++n)
            vols[n] = {{it->x, it->y, it->z, it->age}, {it->scale, 0.f, it->seed, 1.f}, 0.f};
        for (const FireVolume& f : fires_) {
            if (n >= (uint32_t)kMaxFxVolumes) break;
            vols[n++] = {{f.x, f.y, f.z, (float)time}, {f.length, 1.f, (float)(f.seed % 997u), f.strength}, 0.f};
        }
        for (uint32_t k = 0; k < n; ++k) vols[k].d = (vols[k].a.x - e.x) * (vols[k].a.x - e.x) + (vols[k].a.z - e.z) * (vols[k].a.z - e.z);
        std::stable_sort(vols, vols + n, [](const Vol& a, const Vol& b) { return a.d < b.d; });
        int sx0 = (int)w, sy0 = (int)h, sx1 = 0, sy1 = 0;
        float cover = 0.f;
        for (uint32_t k = 0; k < n; ++k) {
            fx.a[k] = vols[k].a;
            fx.b[k] = vols[k].b;
            // conservative world box (mirrors blastShape / wreckBox in fx_volume.glsl) -> screen coverage and scissor
            const Vec4& A = vols[k].a;
            const Vec4& B = vols[k].b;
            float rx, y0 = A.y - 1.f, y1;
            if (B.y < 0.5f) {
                const float sb = std::pow(B.x, 0.8f), ss = std::sqrt(B.x), t = A.w, R = 1.9f * sb;
                const float r = R * (1.f + 0.22f * t), hc = 0.55f * R + 2.6f * ss * t / (1.f + 0.12f * t);
                rx = std::max(r * 2.5f + 0.5f, t < 2.4f ? 0.8f + 3.8f * sb + 2.f * ss : 0.f) + 0.4f * t + 0.6f;
                y1 = A.y + hc + r * 1.6f + 1.f;
            } else { rx = 0.6f * B.x + 4.5f; y1 = A.y + 14.f; }
            float vx0 = 1e9f, vy0 = 1e9f, vx1 = -1e9f, vy1 = -1e9f;
            bool behind = false;
            for (int c = 0; c < 8; ++c) {
                const float px = A.x + ((c & 1) ? rx : -rx), py = (c & 2) ? y1 : y0, pz = A.z + ((c & 4) ? rx : -rx);
                const float cx = vp(0, 0) * px + vp(0, 1) * py + vp(0, 2) * pz + vp(0, 3);
                const float cy = vp(1, 0) * px + vp(1, 1) * py + vp(1, 2) * pz + vp(1, 3);
                const float cw = vp(3, 0) * px + vp(3, 1) * py + vp(3, 2) * pz + vp(3, 3);
                if (cw < 0.5f) { behind = true; break; }
                vx0 = std::min(vx0, cx / cw); vx1 = std::max(vx1, cx / cw); vy0 = std::min(vy0, cy / cw); vy1 = std::max(vy1, cy / cw);
            }
            if (behind) { vx0 = vy0 = -1.f; vx1 = vy1 = 1.f; }
            vx0 = std::max(vx0, -1.f); vy0 = std::max(vy0, -1.f); vx1 = std::min(vx1, 1.f); vy1 = std::min(vy1, 1.f);
            const float area = vx1 > vx0 && vy1 > vy0 ? (vx1 - vx0) * (vy1 - vy0) * 0.25f * 0.6f : 0.f;   // ~60 % of its box
            cover += area;
            const bool coarse = cover > rs.fxBudget && k > 0 && !rs.perfLegacy;   // over budget: the farther volumes one LOD coarser
            fx.c[k] = {coarse ? 2.f : 1.f, coarse ? 96.f : 160.f, 0.f, 0.f};
            fxStats_.coarse += coarse ? 1u : 0u;
            if (area > 0.f) {
                sx0 = std::min(sx0, (int)std::floor((vx0 * 0.5f + 0.5f) * (float)w) - 2);
                sx1 = std::max(sx1, (int)std::ceil((vx1 * 0.5f + 0.5f) * (float)w) + 2);
                sy0 = std::min(sy0, (int)std::floor((0.5f - vy1 * 0.5f) * (float)h) - 2);
                sy1 = std::max(sy1, (int)std::ceil((0.5f - vy0 * 0.5f) * (float)h) + 2);
            }
        }
        sx0 = std::max(sx0, 0); sy0 = std::max(sy0, 0); sx1 = std::min(sx1, (int)w); sy1 = std::min(sy1, (int)h);
        if (sx1 > sx0 && sy1 > sy0) fxScissor = {sx0, sy0, sx1 - sx0, sy1 - sy0};
        fxStats_.coverage = cover;
        fxN = n;
        fxDrawn_ = n;
        fxStats_.volumes = n;
        const uint32_t fxTargetH = fxHalf ? std::max(1u, h / (uint32_t)fxDiv) : h;
        const float voxPerM = rs.perfLegacy ? 0.f : 2.f * std::tan(cam.settings.fovY * 0.5f) / (float)fxTargetH * std::max(0.5f, rs.fxVoxelPx);
        std::memcpy(&fx.count.z, &voxPerM, 4);
        fx.count.x = n;
    }
    if (fxN > 0 && fxHalf) {   // reduced resolution offscreen: colour + hit voxel + own depth (fx occlude each other)
        ensureFxTargets(std::max(1u, w / (uint32_t)fxDiv), std::max(1u, h / (uint32_t)fxDiv));
        SDL_GPUColorTargetInfo fct[2]{};
        fct[0].texture = fxCol_;
        fct[1].texture = fxVox_;
        for (auto& c : fct) { c.load_op = SDL_GPU_LOADOP_CLEAR; c.store_op = SDL_GPU_STOREOP_STORE; c.clear_color = {0, 0, 0, 0}; }
        SDL_GPUDepthStencilTargetInfo fdt{};
        fdt.texture = fxDepth_;
        fdt.clear_depth = 1.0f;
        fdt.load_op = SDL_GPU_LOADOP_CLEAR;
        fdt.store_op = SDL_GPU_STOREOP_DONT_CARE;
        fdt.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
        fdt.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
        SDL_GPURenderPass* fp = SDL_BeginGPURenderPass(cmd, fct, 2, &fdt);
        for (uint32_t passIdx = 0; passIdx < 2; ++passIdx) {
            fx.count.y = passIdx;
            SDL_PushGPUVertexUniformData(cmd, 1, &fx, sizeof(fx));
            SDL_PushGPUFragmentUniformData(cmd, 1, &fx, sizeof(fx));
            SDL_BindGPUGraphicsPipeline(fp, passIdx ? pFxHalfNear_ : pFxHalf_);
            SDL_DrawGPUPrimitives(fp, 36, fxN, 0, 0);
        }
        SDL_EndGPURenderPass(fp);
    }

    SDL_GPUColorTargetInfo ct{};
    // sky: fog colour in display space (scene shaders write gamma colours), alpha = CoC code of infinity (finishA)
    auto toDisplay = [&](float c) { c *= rs.studioLighting ? 1.f : fu.sunColor.w; return std::pow(std::clamp(c / (1.f + c * 0.3f), 0.f, 1.f), 1.f / 2.2f); };
    ct.clear_color = rs.studioLighting ? SDL_FColor{fu.fogColor.x, fu.fogColor.y, fu.fogColor.z, 1.0f}
                                       : SDL_FColor{toDisplay(fu.fogColor.x), toDisplay(fu.fogColor.y), toDisplay(fu.fogColor.z),
                                                    0.5f + 0.5f * std::min(fu.skyColor.w, 1.f)};
    ct.load_op = SDL_GPU_LOADOP_CLEAR;
    if (colorMS_) {
        ct.texture = colorMS_;
        ct.store_op = SDL_GPU_STOREOP_RESOLVE;
        ct.resolve_texture = resolved_;
    } else {
        ct.texture = resolved_;
        ct.store_op = SDL_GPU_STOREOP_STORE;
    }
    SDL_GPUDepthStencilTargetInfo dt{};
    dt.texture = depth_;
    dt.clear_depth = 1.0f;
    dt.load_op = SDL_GPU_LOADOP_CLEAR;
    dt.store_op = SDL_GPU_STOREOP_DONT_CARE;
    dt.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    dt.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    SDL_GPURenderPass* pass = SDL_BeginGPURenderPass(cmd, &ct, 1, &dt);

    // ground + debug overlays
    if (rs.drawGround) {
        SDL_BindGPUGraphicsPipeline(pass, pGround_);
        SDL_GPUBuffer* gb[8] = {sim.staticHeight(), sim.corpseHeight(), sim.density(), sim.navDir(), sim.navDist(), sim.decals(), shadow(),
                                lampGrid};
        SDL_BindGPUFragmentStorageBuffers(pass, 0, gb, 8);
        SDL_GPUTextureSamplerBinding sb{shadowTex_, shadowCmp_};
        SDL_BindGPUFragmentSamplers(pass, 0, &sb, 1);
        SDL_DrawGPUPrimitives(pass, 6, 1, 0, 0);
    }
    if (city_) city_->draw(pass, cmd, sim.decals(), shadow(), sim.corpseHeight());

    if (rs.drawBoxes && boxCount_) {
        SDL_BindGPUGraphicsPipeline(pass, pBox_);
        SDL_GPUBufferBinding vb{cubeVB_, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{cubeIB_, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_16BIT);
        SDL_BindGPUVertexStorageBuffers(pass, 0, &boxes_, 1);
        SDL_GPUBuffer* fb[3] = {sim.decals(), shadow(), lampGrid};
        SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 3);
        SDL_GPUTextureSamplerBinding sb{shadowTex_, shadowCmp_};
        SDL_BindGPUFragmentSamplers(pass, 0, &sb, 1);
        SDL_DrawGPUIndexedPrimitives(pass, 36, boxCount_, 0, 0, 0);
    }
    if (rs.drawParticles) {             // blood droplets, fire, smoke, debris: one indirect draw
        SDL_BindGPUGraphicsPipeline(pass, pParticle_);
        SDL_GPUBuffer* pb[2] = {sim.particles(), sim.particleList()};
        SDL_BindGPUVertexStorageBuffers(pass, 0, pb, 2);
        SDL_DrawGPUPrimitivesIndirect(pass, sim.goreCounters(), G_DRAW_ARGS * 4, 1);
    }
    if (fxN > 0 && !fxHalf) {   // full resolution: ray-marched inside the scene pass
        for (uint32_t passIdx = 0; passIdx < 2; ++passIdx) {   // 0: volumes around the camera, 1: the rest (near faces)
            fx.count.y = passIdx;
            SDL_PushGPUVertexUniformData(cmd, 1, &fx, sizeof(fx));
            SDL_PushGPUFragmentUniformData(cmd, 1, &fx, sizeof(fx));
            SDL_BindGPUGraphicsPipeline(pass, passIdx ? pFxNear_ : pFx_);
            SDL_DrawGPUPrimitives(pass, 36, fxN, 0, 0);
        }
    } else if (fxN > 0 && fxScissor.w > 0 && fxScissor.h > 0) {   // reduced resolution: exact-edge composite
        M4 ivp;
        invert(vp, ivp);
        struct { float ivp[16]; float cp[4]; } cu{};
        std::memcpy(cu.ivp, ivp.m, sizeof(cu.ivp));
        cu.cp[0] = (float)w; cu.cp[1] = (float)h; cu.cp[2] = (float)fxW_ / (float)w; cu.cp[3] = (float)fxH_ / (float)h;
        SDL_PushGPUFragmentUniformData(cmd, 1, &cu, sizeof(cu));
        SDL_SetGPUScissor(pass, &fxScissor);
        SDL_BindGPUGraphicsPipeline(pass, pFxComp_);
        SDL_GPUTextureSamplerBinding tb[2] = {{fxCol_, nearest_}, {fxVox_, nearest_}};
        SDL_BindGPUFragmentSamplers(pass, 0, tb, 2);
        SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        SDL_Rect full{0, 0, (int)w, (int)h};
        SDL_SetGPUScissor(pass, &full);
    }

    SDL_GPUBufferBinding zvb{zombieVB_, 0};
    SDL_GPUBufferBinding zib{zombieIB_, 0};
    SDL_GPUTextureSamplerBinding pal{palette_, nearest_};
    if (modular) { chars->setShadowField(shadow()); chars->draw(cmd, pass, sim, time, rs.chars); }
    if (extDraw) extDraw(pass, cmd, sim.decals(), shadow(), sim.corpseHeight());
    for (auto& [id, e] : exts_) if (e.draw) e.draw(pass, cmd, sim.decals(), shadow(), sim.corpseHeight());
    if (!modular && rs.drawCorpses) {
        SDL_BindGPUGraphicsPipeline(pass, pCorpse_);
        SDL_BindGPUVertexBuffers(pass, 0, &zvb, 1);
        SDL_BindGPUIndexBuffer(pass, &zib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_GPUBuffer* cb = sim.corpses();
        SDL_BindGPUVertexStorageBuffers(pass, 0, &cb, 1);
        SDL_BindGPUFragmentSamplers(pass, 0, &pal, 1);
        SDL_DrawGPUIndexedPrimitivesIndirect(pass, sim.indirect(), I_CORPSE_DRAW * 4, 1);
    }
    if (!modular && rs.drawZombies) {
        // one draw call for every living zombie; the instance count comes from the GPU
        SDL_BindGPUGraphicsPipeline(pass, pZombie_);
        SDL_BindGPUVertexBuffers(pass, 0, &zvb, 1);
        SDL_BindGPUIndexBuffer(pass, &zib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_GPUBuffer* ab = sim.agents();
        SDL_BindGPUVertexStorageBuffers(pass, 0, &ab, 1);
        SDL_BindGPUFragmentSamplers(pass, 0, &pal, 1);
        SDL_DrawGPUIndexedPrimitivesIndirect(pass, sim.indirect(), I_ZOMBIE_DRAW * 4, 1);
    }
    SDL_EndGPURenderPass(pass);

    postProcess(cmd, w, h, rs);
    ++shadowFrame_;   // the other shadow map layer next frame (shadowView)
    if (target) {
        SDL_GPUBlitInfo bi{};
        bi.source.texture = final_;
        bi.source.w = w;
        bi.source.h = h;
        bi.destination.texture = target;
        bi.destination.w = outW ? outW : w;
        bi.destination.h = outH ? outH : h;
        bi.load_op = SDL_GPU_LOADOP_DONT_CARE;
        bi.filter = bi.destination.w == w && bi.destination.h == h ? SDL_GPU_FILTER_NEAREST : SDL_GPU_FILTER_LINEAR;
        SDL_BlitGPUTexture(cmd, &bi);
    }
}

// Miniature look: thin-lens depth of field with bokeh (technique after KinoBokeh, MIT; see shaders/include/dof.glsl).
//   1 prefilter  full -> half    colour to scene-linear + highlight boost, CoC from the scene alpha (4 taps)
//   2 tile       half -> 1/8     max near-field CoC per 8x8 tile (64 fetches per tile texel)
//   3 dilate     1/8             neighbourhood max (5x5 at the default max blur)
//   4 gather     half            49-tap disk / hexagon kernel scaled to the local CoC; far + near field (2 targets)
//   5 fill       half            9-tap fill at half the ring spacing (2 targets)
//   6 composite  full            CoC-aware bilateral upsample of the far field, near field by coverage, grade
void Renderer::postProcess(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const RenderSettings& rs) {
    const bool dof = rs.tiltShift && !rs.studioLighting && rs.dofStrength > 0.f;
    const uint32_t hw = std::max(1u, w / 2), hh = std::max(1u, h / 2);
    auto fullscreen = [&](SDL_GPUTexture* dst, SDL_GPUTexture* dst2, SDL_GPUGraphicsPipeline* p, SDL_GPUTextureSamplerBinding* tex,
                          uint32_t ntex, const void* ub, uint32_t ubSize) {
        SDL_GPUColorTargetInfo ct[2]{};
        ct[0].texture = dst;
        ct[1].texture = dst2;
        for (auto& c : ct) { c.load_op = SDL_GPU_LOADOP_DONT_CARE; c.store_op = SDL_GPU_STOREOP_STORE; }
        SDL_PushGPUFragmentUniformData(cmd, 0, ub, ubSize);
        SDL_GPURenderPass* pass = SDL_BeginGPURenderPass(cmd, ct, dst2 ? 2 : 1, nullptr);
        SDL_BindGPUGraphicsPipeline(pass, p);
        SDL_BindGPUFragmentSamplers(pass, 0, tex, ntex);
        SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        SDL_EndGPURenderPass(pass);
    };
    // max CoC radius in half-res px (the scene alpha encodes CoC / max CoC); the tile dilation must reach that far
    const float maxCoc = std::clamp(dofMaxBlurEff_ * (float)h * 0.5f, 1.f, 48.f);   // zoom-adaptive (RenderSettings::dofAt)
    if (dof) {
        const float dilate = std::ceil(maxCoc / (float)kDofTile);
        float u[12] = {maxCoc, 1.f / (float)hw, 1.f / (float)hh, rs.dofHighlightGain,
                       rs.dofHighlightThreshold, rs.dofHexAperture, (float)kDofTile, dilate,
                       0.26f, 0, 0, 0};
        SDL_GPUTextureSamplerBinding t0{resolved_, linear_};
        fullscreen(dofPre_, nullptr, pDofPre_, &t0, 1, u, sizeof(u));
        SDL_GPUTextureSamplerBinding t1{dofPre_, linear_};
        fullscreen(dofTile_, nullptr, pDofTile_, &t1, 1, u, sizeof(u));
        SDL_GPUTextureSamplerBinding t2{dofTile_, linear_};
        fullscreen(dofTileD_, nullptr, pDofDilate_, &t2, 1, u, sizeof(u));
        SDL_GPUTextureSamplerBinding t3[2] = {{dofPre_, linear_}, {dofTileD_, linear_}};
        fullscreen(dofBgA_, dofFgA_, pDofGather_, t3, 2, u, sizeof(u));
        SDL_GPUTextureSamplerBinding t4[3] = {{dofBgA_, linear_}, {dofFgA_, linear_}, {dofTileD_, linear_}};
        fullscreen(dofBgB_, dofFgB_, pDofFill_, t4, 3, u, sizeof(u));
    }
    const bool grade = !rs.studioLighting;
    float post[8] = {dof ? rs.dofStrength : 0.f, maxCoc, rs.dofDebug ? 1.f : 0.f, 0.f,
                     grade ? rs.saturation : 1.f, grade ? rs.contrast : 1.f, 0.f, grade ? rs.vignette : 0.f};
    SDL_GPUTextureSamplerBinding tc[3] = {{resolved_, linear_}, {dof ? dofBgB_ : resolved_, linear_}, {dof ? dofFgB_ : resolved_, linear_}};
    fullscreen(final_, nullptr, pComposite_, tc, 3, post, sizeof(post));
}

bool Renderer::saveScreenshot(const std::string& path) {
    if (!final_) return false;
    SDL_GPUDevice* d = gpu_->device();
    uint32_t size = targetW_ * targetH_ * 4;
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, size, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(d);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTextureRegion src{};
    src.texture = final_;
    src.w = targetW_;
    src.h = targetH_;
    src.d = 1;
    SDL_GPUTextureTransferInfo dst{tb, 0, 0, 0};
    SDL_DownloadFromGPUTexture(cp, &src, &dst);
    SDL_EndGPUCopyPass(cp);
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(d, true, &f, 1);
    SDL_ReleaseGPUFence(d, f);
    auto* px = (uint8_t*)SDL_MapGPUTransferBuffer(d, tb, false);
    for (uint32_t i = 0; i < targetW_ * targetH_; ++i) px[i * 4 + 3] = 255;
    bool ok = stbi_write_png(path.c_str(), (int)targetW_, (int)targetH_, 4, px, (int)targetW_ * 4) != 0;
    SDL_UnmapGPUTransferBuffer(d, tb);
    SDL_ReleaseGPUTransferBuffer(d, tb);
    SDL_Log("screenshot %s: %s", path.c_str(), ok ? "ok" : "failed");
    return ok;
}

} // namespace ttz
