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
} // namespace

int Renderer::msaaSamples() const {
    switch (samples_) {
    case SDL_GPU_SAMPLECOUNT_2: return 2;
    case SDL_GPU_SAMPLECOUNT_4: return 4;
    case SDL_GPU_SAMPLECOUNT_8: return 8;
    default: return 1;
    }
}

SDL_GPUGraphicsPipeline* Renderer::makePipeline(const char* vs, const char* fs, bool modelVertex, bool cubeVertex, bool cull) {
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
    ci.rasterizer_state.cull_mode = cull ? SDL_GPU_CULLMODE_BACK : SDL_GPU_CULLMODE_NONE;
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
    SDL_ReleaseGPUShader(gpu_->device(), v);
    SDL_ReleaseGPUShader(gpu_->device(), f);
    return p;
}

SDL_GPUGraphicsPipeline* Renderer::makePostPipeline(const char* fs) {
    SDL_GPUShader* v = gpu_->loadShader("post.vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu_->loadShader(std::string(fs) + ".frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) return nullptr;
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = kColorFormat;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
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
    pBox_ = makePipeline("box", "box", false, true, true);
    pGround_ = makePipeline("ground", "ground", false, false, false);
    pParticle_ = makePipeline("particle", "particle", false, false, true);
    pBlur_ = makePostPipeline("post_blur");
    pComposite_ = makePostPipeline("post_composite");
    if (!pZombie_ || !pCorpse_ || !pBox_ || !pGround_ || !pParticle_ || !pBlur_ || !pComposite_) return false;
    {
        SDL_GPUSamplerCreateInfo sci{};
        sci.min_filter = sci.mag_filter = SDL_GPU_FILTER_LINEAR;
        sci.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        sci.address_mode_u = sci.address_mode_v = sci.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        linear_ = SDL_CreateGPUSampler(d, &sci);
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
    for (auto p : {pZombie_, pCorpse_, pBox_, pGround_, pParticle_, pBlur_, pComposite_})
        if (p) SDL_ReleaseGPUGraphicsPipeline(d, p);
    for (auto b : {&zombieVB_, &zombieIB_, &cubeVB_, &cubeIB_, &boxes_, &shadowH_}) gpu_->releaseBuffer(*b);
    for (auto t : {palette_, colorMS_, depth_, resolved_, halfA_, halfB_, final_})
        if (t) SDL_ReleaseGPUTexture(d, t);
    if (nearest_) SDL_ReleaseGPUSampler(d, nearest_);
    if (linear_) SDL_ReleaseGPUSampler(d, linear_);
    gpu_ = nullptr;
}

void Renderer::ensureTargets(uint32_t w, uint32_t h) {
    if (w == targetW_ && h == targetH_ && resolved_) return;
    SDL_GPUDevice* d = gpu_->device();
    for (auto t : {colorMS_, depth_, resolved_, halfA_, halfB_, final_})
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
    ci.width = std::max(1u, w / 2);
    ci.height = std::max(1u, h / 2);
    halfA_ = SDL_CreateGPUTexture(d, &ci);
    halfB_ = SDL_CreateGPUTexture(d, &ci);
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

void Renderer::addBlast(float x, float y, float z, float scale) {
    blasts_.push_back({x, y, z, 0.f, std::max(scale, 0.1f)});
    if (blasts_.size() > (size_t)kMaxBlasts) blasts_.erase(blasts_.begin());
}

void Renderer::update(float dt) {
    for (auto& b : blasts_) b.age += dt;
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

void Renderer::render(SDL_GPUCommandBuffer* cmd, SDL_GPUTexture* target, uint32_t w, uint32_t h, const Camera& cam,
                      const CrowdSim& sim, double time, const RenderSettings& rs, CharacterRenderer* chars) {
    ensureTargets(w, h);
    const bool modular = chars && rs.characterModel == 1;
    if (modular && !skipCharacterPrepare_) prepareCharacters(cmd, w, h, cam, sim, time, rs, chars);
    FrameUniforms fu{};
    M4 vp = mul(cam.proj((float)w / (float)h), cam.view());
    std::memcpy(fu.viewProj, vp.m, sizeof(fu.viewProj));
    V3 e = cam.eye();
    fu.camPos = {e.x, e.y, e.z, (float)time};
    V3 sun = normalize(V3{-0.35f, 0.8f, 0.45f});
    fu.sunDir = {sun.x, sun.y, sun.z, 0};
    // moonlit-blue night with a generous ambient so the palette colours read (City Lab look); .w slots carry
    // exposure (sunColor), miniature depth-of-field focus / range (sunDir / skyColor) and the fog start (groundColor)
    const float camDist = cam.distance();
    fu.sunDir.w = camDist;
    fu.sunColor = {0.13f, 0.16f, 0.24f, rs.exposure};    // moonlight
    fu.skyColor = {0.10f, 0.12f, 0.21f, rs.tiltShift ? std::max(1.f, rs.tiltDepthRange * camDist) : 0.f};
    fu.groundColor = {0.035f, 0.035f, 0.05f, rs.fogStart * camDist};
    fu.fogColor = {0.05f, 0.065f, 0.12f, rs.fogDensity};
    if (rs.studioLighting) {   // neutral studio close to Zombie Lab's "Neutral" mode (sage backdrop, warm key)
        V3 key = normalize(V3{0.47f, 0.76f, 0.40f});
        fu.sunDir = {key.x, key.y, key.z, 0};
        fu.sunColor = {0.62f, 0.58f, 0.50f, 0};
        fu.skyColor = {0.42f, 0.45f, 0.38f, 0};
        fu.groundColor = {0.16f, 0.17f, 0.12f, 0};
        fu.fogColor = {0.424f, 0.463f, 0.322f, 0.0f};
        fu.sunDir.w = fu.skyColor.w = fu.groundColor.w = 0.f;
        fu.sunColor.w = 1.f;
    }
    fu.gridP = {sandbox_.originX, sandbox_.originZ, params_.cellSize, 1.0f / params_.cellSize};
    uint32_t nl = rs.studioLighting ? 0u : (uint32_t)std::min<size_t>(sandbox_.lights.size(), kMaxLights);
    fu.gridDim = {(uint32_t)params_.gridW, (uint32_t)params_.gridH, nl,
                  rs.debugFlags | (rs.shadows && !rs.studioLighting ? 32u : 0u) | (city_ ? 64u : 0u)};
    fu.modelP = {(float)variantRows_, modelHeight_, params_.standHeight, params_.proneHeight};
    const auto& g = sim.goals();
    for (size_t i = 0; i + 1 < g.size() && i / 2 < 4; i += 2) fu.goals[i / 2] = {g[i], 0, g[i + 1], 1};
    for (int i = 0; i < kMaxBlasts; ++i) fu.blasts[i] = {0, 0, 0, -1};
    for (size_t i = 0; i < blasts_.size(); ++i) {
        fu.blasts[i] = {blasts_[i].x, blasts_[i].y, blasts_[i].z, blasts_[i].age};
        fu.blastsP[i] = {blasts_[i].scale, 0, 0, 0};
    }
    for (uint32_t i = 0; i < nl; ++i) {
        const PointLight& L = sandbox_.lights[i];
        fu.lightPos[i] = {L.x, L.y, L.z, L.radius};
        fu.lightCol[i] = {L.r, L.g, L.b, L.intensity};
    }
    SDL_PushGPUVertexUniformData(cmd, 0, &fu, sizeof(fu));
    SDL_PushGPUFragmentUniformData(cmd, 0, &fu, sizeof(fu));

    SDL_GPUColorTargetInfo ct{};
    // sky: fog colour in display space (scene shaders write gamma colours), alpha 0 = blurred by the miniature pass
    auto toDisplay = [&](float c) { c *= rs.studioLighting ? 1.f : rs.exposure; return std::pow(std::clamp(c / (1.f + c * 0.3f), 0.f, 1.f), 1.f / 2.2f); };
    ct.clear_color = rs.studioLighting ? SDL_FColor{fu.fogColor.x, fu.fogColor.y, fu.fogColor.z, 1.0f}
                                       : SDL_FColor{toDisplay(fu.fogColor.x), toDisplay(fu.fogColor.y), toDisplay(fu.fogColor.z), 0.0f};
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
        SDL_GPUBuffer* gb[7] = {sim.staticHeight(), sim.corpseHeight(), sim.density(), sim.navDir(), sim.navDist(), sim.decals(), shadow()};
        SDL_BindGPUFragmentStorageBuffers(pass, 0, gb, 7);
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
        SDL_GPUBuffer* fb[2] = {sim.decals(), shadow()};
        SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 2);
        SDL_DrawGPUIndexedPrimitives(pass, 36, boxCount_, 0, 0, 0);
    }
    if (rs.drawParticles) {             // blood droplets, fire, smoke, debris: one indirect draw
        SDL_BindGPUGraphicsPipeline(pass, pParticle_);
        SDL_GPUBuffer* pb[2] = {sim.particles(), sim.particleList()};
        SDL_BindGPUVertexStorageBuffers(pass, 0, pb, 2);
        SDL_DrawGPUPrimitivesIndirect(pass, sim.goreCounters(), G_DRAW_ARGS * 4, 1);
    }

    SDL_GPUBufferBinding zvb{zombieVB_, 0};
    SDL_GPUBufferBinding zib{zombieIB_, 0};
    SDL_GPUTextureSamplerBinding pal{palette_, nearest_};
    if (modular) { chars->setShadowField(shadow()); chars->draw(cmd, pass, sim, time, rs.chars); }
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
    if (target) {
        SDL_GPUBlitInfo bi{};
        bi.source.texture = final_;
        bi.source.w = w;
        bi.source.h = h;
        bi.destination.texture = target;
        bi.destination.w = w;
        bi.destination.h = h;
        bi.load_op = SDL_GPU_LOADOP_DONT_CARE;
        bi.filter = SDL_GPU_FILTER_NEAREST;
        SDL_BlitGPUTexture(cmd, &bi);
    }
}

// Miniature look: resolved scene -> (H blur, half res) -> (V blur) -> composite with the sharp scene into final_.
void Renderer::postProcess(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const RenderSettings& rs) {
    const bool tilt = rs.tiltShift && !rs.studioLighting && rs.tiltStrength > 0.f;
    const uint32_t hw = std::max(1u, w / 2), hh = std::max(1u, h / 2);
    auto fullscreen = [&](SDL_GPUTexture* dst, SDL_GPUGraphicsPipeline* p, SDL_GPUTextureSamplerBinding* tex, uint32_t ntex,
                          const void* ub, uint32_t ubSize) {
        SDL_GPUColorTargetInfo ct{};
        ct.texture = dst;
        ct.load_op = SDL_GPU_LOADOP_DONT_CARE;
        ct.store_op = SDL_GPU_STOREOP_STORE;
        SDL_PushGPUFragmentUniformData(cmd, 0, ub, ubSize);
        SDL_GPURenderPass* pass = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
        SDL_BindGPUGraphicsPipeline(pass, p);
        SDL_BindGPUFragmentSamplers(pass, 0, tex, ntex);
        SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        SDL_EndGPURenderPass(pass);
    };
    if (tilt) {
        // tap spacing scales with the resolution so the blur looks the same at 720p and on a Retina display
        float r = rs.tiltRadius * std::max(0.5f, (float)h / 720.f);
        float dirH[4] = {r / (float)hw, 0, 0, 0};   // steps in half-res texels (uv)
        SDL_GPUTextureSamplerBinding t0{resolved_, linear_};
        fullscreen(halfA_, pBlur_, &t0, 1, dirH, sizeof(dirH));
        float dirV[4] = {0, r / (float)hh, 0, 0};
        SDL_GPUTextureSamplerBinding t1{halfA_, linear_};
        fullscreen(halfB_, pBlur_, &t1, 1, dirV, sizeof(dirV));
        // second, wider iteration: smoother bokeh-like falloff for the strongly blurred top / bottom
        float dirH2[4] = {r * 2.f / (float)hw, 0, 0, 0};
        SDL_GPUTextureSamplerBinding t2{halfB_, linear_};
        fullscreen(halfA_, pBlur_, &t2, 1, dirH2, sizeof(dirH2));
        float dirV2[4] = {0, r * 2.f / (float)hh, 0, 0};
        fullscreen(halfB_, pBlur_, &t1, 1, dirV2, sizeof(dirV2));
    }
    const bool grade = !rs.studioLighting;
    float post[8] = {tilt ? rs.tiltStrength : 0.f, 0.5f, rs.tiltBand, rs.tiltSoftness,
                     grade ? rs.saturation : 1.f, grade ? rs.contrast : 1.f, rs.tiltDepthWeight, grade ? rs.vignette : 0.f};
    SDL_GPUTextureSamplerBinding tc[2] = {{resolved_, linear_}, {tilt ? halfB_ : resolved_, linear_}};
    fullscreen(final_, pComposite_, tc, 2, post, sizeof(post));
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
