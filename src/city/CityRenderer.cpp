#include "city/CityRenderer.h"

#include "city/CityVehicles.h"

#include "debug/Profiler.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
struct DrawU {               // std140, vertex uniform slot 1 (shaders/city.vert)
    float origin[4];         // xyz
    float scale[4];          // x = metres per unit in x/z, y = in y
    uint32_t mode, instOffset, pad0, pad1;   // mode 0 tile, 1 instanced model
    float clampRect[4] = {0, 0, 0, 0};       // external deformed props: roof footprint (x0, z0, x1, z1)
    float clampH[4] = {0, 0, 0, 0};          // x inside, y outside, w 1 = use
};
struct GpuMat {              // std430, shaders/city.frag
    float albedo[4];         // linear rgb, w gloss
    float emis[4];           // x night strength, y mode (EmissiveMode), z roughness, w day strength
    // info: x flags (CityMatFlags), y day material (windows)
    uint32_t info[4];        // x flags (CityMatFlags)
};
using GpuInst = CityRenderer::GpuInstance;   // std430, shaders/city.vert
constexpr SDL_GPUTextureFormat kColorFormat = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
constexpr SDL_GPUTextureFormat kDepthFormat = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
} // namespace

bool CityRenderer::init(GpuContext& gpu, CityAsset& asset, SDL_GPUSampleCount samples) {
    gpu_ = &gpu;
    asset_ = &asset;
    SDL_GPUDevice* d = gpu.device();
    for (int k = 0; k < 2; ++k) {
        SDL_GPUShader* v = gpu.loadShader("city.vert", SDL_GPU_SHADERSTAGE_VERTEX);
        SDL_GPUShader* f = gpu.loadShader("city.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        if (!v || !f) return false;
        SDL_GPUVertexBufferDescription vbd{0, sizeof(CityVertex), SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
        SDL_GPUVertexAttribute attrs[2]{};
        attrs[0] = {0, 0, SDL_GPU_VERTEXELEMENTFORMAT_SHORT4, 0};
        attrs[1] = {1, 0, SDL_GPU_VERTEXELEMENTFORMAT_BYTE4, 8};
        SDL_GPUGraphicsPipelineCreateInfo ci{};
        ci.vertex_input_state = {&vbd, 1, attrs, 2};
        ci.vertex_shader = v;
        ci.fragment_shader = f;
        ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        ci.rasterizer_state.cull_mode = k == 0 ? SDL_GPU_CULLMODE_BACK : SDL_GPU_CULLMODE_NONE;
        ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        ci.multisample_state.sample_count = samples;
        ci.depth_stencil_state.enable_depth_test = true;
        ci.depth_stencil_state.enable_depth_write = true;
        ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
        SDL_GPUColorTargetDescription ctd{};
        ctd.format = kColorFormat;
        ci.target_info.color_target_descriptions = &ctd;
        ci.target_info.num_color_targets = 1;
        ci.target_info.depth_stencil_format = kDepthFormat;
        ci.target_info.has_depth_stencil_target = true;
        (k == 0 ? pipe_ : pipeNoCull_) = SDL_CreateGPUGraphicsPipeline(d, &ci);
        if (k == 0) pipeShadow_ = makeShadowPipeline(gpu, ci);   // same vertex stage, depth only
        if (k == 0) pipeShadowExt_ = makeShadowPipeline(gpu, ci, "city_shadow.frag");   // external draws: + voxel dissolve
        SDL_ReleaseGPUShader(d, v);
        SDL_ReleaseGPUShader(d, f);
        if (!(k == 0 ? pipe_ : pipeNoCull_)) {
            SDL_Log("city pipeline: %s", SDL_GetError());
            return false;
        }
    }
    // material palette (max 256 ids; unknown ids fall back to grey)
    std::vector<GpuMat> mats(256);
    for (auto& m : mats) m = {{0.5f, 0.5f, 0.5f, 0.f}, {0, 0, 0.8f, 0}, {0, 0, 0, 0}};
    for (size_t i = 0; i < asset.materials.size() && i < 256; ++i) {
        const CityMaterial& m = asset.materials[i];
        mats[i] = {{m.r, m.g, m.b, m.gloss}, {m.emissiveNight, (float)m.emissiveMode, m.roughness, m.emissiveDay},
                   {m.flags, m.dayMaterial >= 0 && m.dayMaterial < 256 ? (uint32_t)m.dayMaterial : (uint32_t)i, 0, 0}};
    }
    materials_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(mats.size() * sizeof(GpuMat)), "cityMaterials");
    gpu.uploadNow(materials_, mats.data(), (uint32_t)(mats.size() * sizeof(GpuMat)));
    dummy_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, 64, "cityDummy");
    std::vector<uint8_t> zeros(64, 0);
    gpu.uploadNow(dummy_, zeros.data(), 64);
    instCapacity_ = 16384;
    instances_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, instCapacity_ * sizeof(GpuInst), "cityVehicleInstances");
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, instCapacity_ * (uint32_t)sizeof(GpuInst), 0};
    instTB_ = SDL_CreateGPUTransferBuffer(d, &tci);

    // instanced models: vehicle variants then prop types: full, mid (derived), box (vehicle LOD1, baked)
    for (const auto* list : {&asset.variants, &asset.props})
        for (const ModelVariant& v : *list) {
            models_[0].push_back(uploadMesh(v.lod0, "cityModelLod0"));
            CityMesh mid = midMesh(v.lod0, asset.materials);
            models_[1].push_back(mid.quads ? uploadMesh(mid, "cityModelMid") : GpuMesh{});
            models_[2].push_back(v.lod1.idx.empty() ? GpuMesh{} : uploadMesh(v.lod1, "cityModelLod1"));
            for (int l = 1; l < 3; ++l) models_[l].back().radius = models_[0].back().radius;
        }
    if (const char* e = SDL_getenv("TTZ_CITY_LOD")) {   // "lod1Dist,lod2Dist" (comparisons / tuning)
        float a = 0, b = 0;
        if (SDL_sscanf(e, "%f,%f", &a, &b) == 2) { settings.lod1Dist = a; settings.lod2Dist = b; }
    }
    if (!water.init(gpu, samples, kColorFormat, kDepthFormat)) SDL_Log("city: water pipeline unavailable");
    if (!asset.foliage.empty() && !foliage.init(gpu, asset, samples, kColorFormat, kDepthFormat)) SDL_Log("city: foliage pipeline unavailable");
    asset.start();
    return true;
}

// Mid LOD of an instanced model: the quads whose longest edge is >= 0.25 m plus emissive / signal quads (lights stay
// lit at night). Empty when it would keep more than 85 % of the quads.
CityMesh CityRenderer::midMesh(const CityMesh& m, const std::vector<CityMaterial>& mats) {
    CityMesh out;
    if (!m.quads || m.verts.size() < (size_t)m.quads * 4) return out;
    out.origin[0] = m.origin[0]; out.origin[1] = m.origin[1]; out.origin[2] = m.origin[2];
    out.scaleXZ = m.scaleXZ; out.scaleY = m.scaleY;
    std::memcpy(out.bmin, m.bmin, sizeof(out.bmin));
    std::memcpy(out.bmax, m.bmax, sizeof(out.bmax));
    const float e2min = 0.25f * 0.25f;
    for (uint32_t q = 0; q < m.quads; ++q) {
        const CityVertex* v = &m.verts[(size_t)q * 4];
        auto d2 = [&](int a, int b) {
            float x = (v[b].x - v[a].x) * m.scaleXZ, y = (v[b].y - v[a].y) * m.scaleY, z = (v[b].z - v[a].z) * m.scaleXZ;
            return x * x + y * y + z * z;
        };
        const uint32_t f = v[0].mat < mats.size() ? mats[v[0].mat].flags : 0;
        if (std::max(d2(0, 1), d2(1, 2)) < e2min && !(f & (MAT_EMISSIVE | MAT_SIGNAL))) continue;
        out.verts.insert(out.verts.end(), v, v + 4);
    }
    out.quads = (uint32_t)(out.verts.size() / 4);
    if (out.quads * 100 > m.quads * 85) return CityMesh{};
    out.lod1Quads = out.quads;
    out.idx.resize((size_t)out.quads * 6);
    for (uint32_t q = 0; q < out.quads; ++q) {
        uint32_t b0 = q * 4, *o = &out.idx[(size_t)q * 6];
        o[0] = b0; o[1] = b0 + 1; o[2] = b0 + 2; o[3] = b0; o[4] = b0 + 2; o[5] = b0 + 3;
    }
    return out;
}

CityRenderer::GpuMesh CityRenderer::uploadMesh(const CityMesh& m, const char* name) {
    GpuMesh g;
    if (m.verts.empty() || m.idx.empty()) return g;
    g.vb = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_VERTEX, (uint32_t)(m.verts.size() * sizeof(CityVertex)), name);
    g.ib = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_INDEX, (uint32_t)(m.idx.size() * 4), name);
    gpu_->uploadNow(g.vb, m.verts.data(), (uint32_t)(m.verts.size() * sizeof(CityVertex)));
    gpu_->uploadNow(g.ib, m.idx.data(), (uint32_t)(m.idx.size() * 4));
    g.idxCount = (uint32_t)m.idx.size();
    g.origin[0] = m.origin[0]; g.origin[1] = m.origin[1]; g.origin[2] = m.origin[2]; g.origin[3] = 0;
    g.scale[0] = m.scaleXZ; g.scale[1] = m.scaleY; g.scale[2] = g.scale[3] = 0;
    g.top = m.bmax[1];
    g.radius = 0.f;
    for (int c = 0; c < 8; ++c) {
        float x = c & 1 ? m.bmax[0] : m.bmin[0], y = c & 2 ? m.bmax[1] : m.bmin[1], z = c & 4 ? m.bmax[2] : m.bmin[2];
        g.radius = std::max(g.radius, std::sqrt(x * x + y * y + z * z));
    }
    return g;
}

void CityRenderer::shutdown() {
    if (!gpu_) return;
    const CityRenderStats& c = stats_;
    SDL_Log("city render: last frame %u tile draws (%u chunks visible, %u at LOD1; %u tiles at LOD1, %u at LOD2), %.2f M tile tris, "
            "%.2f M total, %llu instances, %u draws; decoded %u tiles, decode ms avg %.2f max %.2f",
            c.tileDraws, c.visibleChunks, c.lod1Chunks, c.lod1Tiles, c.lod2Tiles, c.tileTriangles / 1e6, c.triangles / 1e6,
            (unsigned long long)c.vehicles, c.drawCalls, c.decodedTiles, c.decodedTiles ? c.decodeMsSum / c.decodedTiles : 0.0, c.decodeMsMax);
    if (asset_) asset_->stop();
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    water.shutdown();
    foliage.shutdown();
    for (auto& [k, t] : tiles_) {
        if (t.vb) SDL_ReleaseGPUBuffer(d, t.vb);
        if (t.ib) SDL_ReleaseGPUBuffer(d, t.ib);
    }
    tiles_.clear();
    for (int l = 2; l >= 0; --l) {
        for (GpuMesh& m : models_[l])
            if (m.vb) { gpu_->releaseBuffer(m.vb); gpu_->releaseBuffer(m.ib); }
        models_[l].clear();
    }
    gpu_->releaseBuffer(materials_);
    if (quadIB_) SDL_ReleaseGPUBuffer(d, quadIB_);
    quadIB_ = nullptr;
    quadIBQuads_ = 0;
    gpu_->releaseBuffer(instances_);
    gpu_->releaseBuffer(dummy_);
    gpu_->releaseBuffer(lampGrid_);
    lampSig_ = 0;
    if (indirect_) gpu_->releaseBuffer(indirect_);
    if (indirectTB_) SDL_ReleaseGPUTransferBuffer(d, indirectTB_);
    indirect_ = nullptr;
    indirectTB_ = nullptr;
    indirectCap_ = 0;
    if (instTB_) SDL_ReleaseGPUTransferBuffer(d, instTB_);
    instTB_ = nullptr;
    for (auto p : {pipe_, pipeNoCull_, pipeShadow_, pipeShadowExt_})
        if (p) SDL_ReleaseGPUGraphicsPipeline(d, p);
    pipe_ = pipeNoCull_ = pipeShadow_ = pipeShadowExt_ = nullptr;
    gpu_ = nullptr;
}

// Tiles under the view frustum's ground footprint (+1 tile ring), nearest to the pivot first (City Lab's rule).
void CityRenderer::computeWanted(const Camera& cam, float aspect, std::vector<int>& out) const {
    const CityAsset& a = *asset_;
    V3 piv = cam.target(), eye = cam.eye();
    float xs[5], zs[5];
    const float corners[5][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}, {0.5f, 0.5f}};
    for (int k = 0; k < 5; ++k) {
        V3 hit;
        bool ok = cam.screenToGround(corners[k][0] * aspect, corners[k][1], aspect, 1.f, 0.f, hit);
        if (!ok || dot(hit - eye, hit - eye) > 900.f * 900.f) {
            // ray misses the ground (above the horizon) or is very far: clamp at 2.2x the max zoom distance
            V3 d = hit - eye;
            if (!ok) {
                float yaw = cam.yaw();
                d = V3{-std::sin(yaw), 0, -std::cos(yaw)};
            }
            d.y = 0;
            d = normalize(d) * (300.f * 2.2f);
            hit = piv + d;
        }
        xs[k] = hit.x;
        zs[k] = hit.z;
    }
    float mnx = *std::min_element(xs, xs + 5), mxx = *std::max_element(xs, xs + 5);
    float mnz = *std::min_element(zs, zs + 5), mxz = *std::max_element(zs, zs + 5);
    int i0 = (int)std::floor((std::max(a.x0, mnx) - a.x0) / a.tileSize) - 1, i1 = (int)std::floor((std::min(a.x1, mxx) - a.x0) / a.tileSize) + 1;
    int j0 = (int)std::floor((std::max(a.z0, mnz) - a.z0) / a.tileSize) - 1, j1 = (int)std::floor((std::min(a.z1, mxz) - a.z0) / a.tileSize) + 1;
    out.clear();
    std::vector<std::pair<float, int>> order;
    for (int j = std::max(0, j0); j <= std::min(a.nj - 1, j1); ++j)
        for (int i = std::max(0, i0); i <= std::min(a.ni - 1, i1); ++i) {
            if (!a.tilePresent[(size_t)j * a.ni + i]) continue;
            float cx = a.x0 + (i + 0.5f) * a.tileSize - piv.x, cz = a.z0 + (j + 0.5f) * a.tileSize - piv.z;
            order.push_back({cx * cx + cz * cz, j * a.ni + i});
        }
    std::sort(order.begin(), order.end());
    for (auto& o : order) out.push_back(o.second);
}

// Shared u32 index buffer of the implicit quad pattern (FORMAT.md 2): quad q = vertices 4q + (0,1,2), (0,2,3).
void CityRenderer::ensureQuadIB(SDL_GPUCopyPass* cp, uint32_t quads) {
    if (quads <= quadIBQuads_) return;
    uint32_t n = std::max<uint32_t>(quadIBQuads_ ? quadIBQuads_ * 2 : 1u << 17, quads);
    SDL_GPUDevice* d = gpu_->device();
    if (quadIB_) SDL_ReleaseGPUBuffer(d, quadIB_);   // deferred until the GPU is done with it
    SDL_GPUBufferCreateInfo bi{SDL_GPU_BUFFERUSAGE_INDEX, n * 24, 0};
    quadIB_ = SDL_CreateGPUBuffer(d, &bi);
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, n * 24, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
    auto* o = (uint32_t*)SDL_MapGPUTransferBuffer(d, tb, false);
    for (uint32_t q = 0; q < n; ++q, o += 6) {
        uint32_t b0 = q * 4;
        o[0] = b0; o[1] = b0 + 1; o[2] = b0 + 2; o[3] = b0; o[4] = b0 + 2; o[5] = b0 + 3;
    }
    SDL_UnmapGPUTransferBuffer(d, tb);
    SDL_GPUTransferBufferLocation src{tb, 0};
    SDL_GPUBufferRegion dst{quadIB_, 0, n * 24};
    SDL_UploadToGPUBuffer(cp, &src, &dst, false);
    SDL_ReleaseGPUTransferBuffer(d, tb);
    quadIBQuads_ = n;
}

void CityRenderer::upload(SDL_GPUCopyPass* cp, TileCPU& t) {
    SDL_GPUDevice* d = gpu_->device();
    GpuTile g;
    // vertex buffer: LOD0 (LOD1 = its leading quads), legacy explicit LOD1, LOD2; index buffer only for explicit meshes
    uint32_t nv = 0, ni = 0, maxQuads = 0;
    bool has[3];
    for (int l = 0; l < 3; ++l) {
        const CityMesh& m = t.lod[l];
        has[l] = !m.verts.empty();
        if (!has[l]) continue;
        GpuTile::Lod& L = g.lods[l];
        L.vtxOffset = nv;
        L.shared = m.idx.empty();
        L.first = L.shared ? 0 : ni;
        L.count = L.shared ? m.quads * 6 : (uint32_t)m.idx.size();
        nv += (uint32_t)m.verts.size();
        ni += (uint32_t)m.idx.size();
        maxQuads = std::max(maxQuads, m.quads);
        L.origin[0] = m.origin[0]; L.origin[1] = m.origin[1]; L.origin[2] = m.origin[2];
        L.scale[0] = m.scaleXZ; L.scale[1] = m.scaleY;
    }
    if (!has[1] && has[0]) {   // LOD1 = leading lod1Quads quads of LOD0
        g.lods[1] = g.lods[0];
        if (g.lods[0].shared) g.lods[1].count = t.lod[0].lod1Quads * 6;
    }
    g.hasLod2 = has[2];
    if (!has[2]) g.lods[2] = g.lods[1];
    if (!has[0]) g.lods[0] = g.lods[1];
    if (maxQuads) ensureQuadIB(cp, maxQuads);
    const CityMesh& m0 = has[0] ? t.lod[0] : has[1] ? t.lod[1] : t.lod[2];
    std::memcpy(g.bmin, m0.bmin, sizeof(g.bmin));
    std::memcpy(g.bmax, m0.bmax, sizeof(g.bmax));
    if (!has[0] && !has[1] && !has[2]) {   // instances only: bounds = tile rectangle
        g.bmin[0] = asset_->x0 + t.i * asset_->tileSize; g.bmax[0] = g.bmin[0] + asset_->tileSize;
        g.bmin[2] = asset_->z0 + t.j * asset_->tileSize; g.bmax[2] = g.bmin[2] + asset_->tileSize;
        g.bmin[1] = 0; g.bmax[1] = 1;
    }
    if (!t.heightCm.empty()) {
        g.coarse.assign(32 * 32, 0.f);
        g.cx0 = t.gx0; g.cz0 = t.gz0;
        const int f = std::max(1, t.gw / 32);
        for (int z = 0; z < t.gh; ++z)
            for (int x = 0; x < t.gw; ++x) {
                float& c = g.coarse[std::min(31, z / f) * 32 + std::min(31, x / f)];
                c = std::max(c, t.heightCm[(size_t)z * t.gw + x] * 0.01f);
            }
    }
    if (has[0] && g.lods[0].shared && !t.chunks.empty()) {
        g.chunks = std::move(t.chunks);
        g.chunkLod.assign(g.chunks.size(), 0);
    }
    stats_.decodedTiles++;
    stats_.decodeMsSum += t.decodeMs;
    stats_.decodeMsMax = std::max(stats_.decodeMsMax, t.decodeMs);
    g.instances = std::move(t.instances);
    if (vehicles_) vehicles_->registerTile(t.j * asset_->ni + t.i, g.instances);   // first sight: dynamic state (kept for good)
    for (const CityInstance& v : g.instances) {   // instances may stand on the tile edge: grow the bounds
        g.bmin[0] = std::min(g.bmin[0], v.x - 3.f); g.bmax[0] = std::max(g.bmax[0], v.x + 3.f);
        g.bmin[2] = std::min(g.bmin[2], v.z - 3.f); g.bmax[2] = std::max(g.bmax[2], v.z + 3.f);
        g.bmax[1] = std::max(g.bmax[1], v.y + 8.f);
    }
    uint32_t vbBytes = nv * sizeof(CityVertex), ibBytes = ni * 4;
    if (vbBytes) {
        SDL_GPUBufferCreateInfo bi{SDL_GPU_BUFFERUSAGE_VERTEX, vbBytes, 0};
        g.vb = SDL_CreateGPUBuffer(d, &bi);
        if (ibBytes) {
            bi = {SDL_GPU_BUFFERUSAGE_INDEX, ibBytes, 0};
            g.ib = SDL_CreateGPUBuffer(d, &bi);
        }
        SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, vbBytes + ibBytes, 0};
        SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
        auto* p = (uint8_t*)SDL_MapGPUTransferBuffer(d, tb, false);
        uint8_t* q = p;
        for (int l = 0; l < 3; ++l) { std::memcpy(q, t.lod[l].verts.data(), t.lod[l].verts.size() * sizeof(CityVertex)); q += t.lod[l].verts.size() * sizeof(CityVertex); }
        for (int l = 0; l < 3; ++l) { std::memcpy(q, t.lod[l].idx.data(), t.lod[l].idx.size() * 4); q += t.lod[l].idx.size() * 4; }
        SDL_UnmapGPUTransferBuffer(d, tb);
        SDL_GPUTransferBufferLocation src{tb, 0};
        SDL_GPUBufferRegion dst{g.vb, 0, vbBytes};
        SDL_UploadToGPUBuffer(cp, &src, &dst, false);
        if (ibBytes) {
            src.offset = vbBytes;
            dst = {g.ib, 0, ibBytes};
            SDL_UploadToGPUBuffer(cp, &src, &dst, false);
        }
        SDL_ReleaseGPUTransferBuffer(d, tb);   // released once the copy has executed
    }
    g.bytes = vbBytes + ibBytes;
    stats_.uploadedBytes += g.bytes;
    stats_.uploadedTiles++;
    {   // water surface + foliage instances (CityWater.h)
        const int key = t.j * asset_->ni + t.i;
        if (uint32_t wq = water.upload(cp, key, t)) ensureQuadIB(cp, wq);
        foliage.upload(cp, key, t, asset_->x0 + t.i * asset_->tileSize, asset_->z0 + t.j * asset_->tileSize);
    }
    tiles_[t.j * asset_->ni + t.i] = std::move(g);
}

void CityRenderer::evict(uint64_t frame) {
    if ((int)tiles_.size() <= settings.maxResident) return;
    std::vector<std::pair<uint64_t, int>> lru;
    std::vector<uint8_t> want(asset_->ni * asset_->nj, 0);
    for (int k : wanted_) want[k] = 1;
    for (auto& [k, t] : tiles_)
        if (!want[k]) lru.push_back({t.lastUsed, k});
    std::sort(lru.begin(), lru.end());
    SDL_GPUDevice* d = gpu_->device();
    for (auto& e : lru) {
        if ((int)tiles_.size() <= settings.maxResident) break;
        GpuTile& t = tiles_[e.second];
        if (t.vb) SDL_ReleaseGPUBuffer(d, t.vb);   // deferred by SDL until the GPU no longer uses it
        if (t.ib) SDL_ReleaseGPUBuffer(d, t.ib);
        water.release(e.second);
        foliage.release(e.second);
        tiles_.erase(e.second);
    }
}

// One instance into the per-model / LOD lists: distance LOD, frustum culling by bounding sphere.
void CityRenderer::gatherInstance(std::vector<std::vector<GpuInstance>> (&byModel)[3], uint32_t kind, uint32_t variant, const float* pos,
                                  const float* q, const float* paint) {
    const size_t nModels = models_[0].size(), nVeh = asset_->variants.size();
    size_t model = kind == 0 ? variant : nVeh + variant;
    if (model >= nModels || (kind == 0 && variant >= nVeh)) return;
    if (kind == 0 ? !settings.vehicles : !settings.props) return;
    // LOD distance from the nearer of eye and focus (see update); visibility by projected size from the eye: an
    // instance is only dropped when it would be smaller than ~half a pixel (never by a fixed distance).
    float ex = pos[0] - eye_.x, ey = pos[1] - eye_.y, ez = pos[2] - eye_.z, de2 = ex * ex + ey * ey + ez * ez;
    float fx = pos[0] - focus_.x, fy = pos[1] - focus_.y, fz = pos[2] - focus_.z, d2 = std::min(de2, fx * fx + fy * fy + fz * fz);
    const float r = models_[0][model].radius;
    if (r * r < de2 * settings.minProjectedRadius * settings.minProjectedRadius) return;
    int lod = 0;
    if (kind == 0) lod = d2 > settings.vehicleBoxDist * settings.vehicleBoxDist ? 2 : d2 > settings.vehicleMidDist * settings.vehicleMidDist ? 1 : 0;
    else lod = d2 > settings.propDist * settings.propDist ? 2 : d2 > settings.propMidDist * settings.propMidDist ? 1 : 0;
    if (!sphereVisible(pos[0], pos[1], pos[2], r)) return;
    while (lod > 0 && !models_[lod][model].vb) --lod;   // coarser mesh missing: next finer one
    byModel[lod][model].push_back({{pos[0], pos[1], pos[2], (float)kind}, {q[0], q[1], q[2], q[3]}, {paint[0], paint[1], paint[2], paint[3]}});
}

void CityRenderer::update(SDL_GPUCommandBuffer* cmd, const Camera& cam, float aspect, uint64_t frame) {
    double t0 = nowMs();
    stats_.uploadedTiles = 0;
    stats_.uploadedBytes = 0;
    eye_ = cam.eye();
    focus_ = cam.target();
    // frustum planes (clip = VP * p, depth 0..1)
    M4 vp = mul(cam.proj(aspect), cam.view());
    auto row = [&](int r, int c) { return vp(r, c); };
    for (int c = 0; c < 4; ++c) {
        frustum_[0][c] = row(3, c) + row(0, c);
        frustum_[1][c] = row(3, c) - row(0, c);
        frustum_[2][c] = row(3, c) + row(1, c);
        frustum_[3][c] = row(3, c) - row(1, c);
        frustum_[4][c] = row(2, c);
        frustum_[5][c] = row(3, c) - row(2, c);
    }
    for (auto& p : frustum_) {   // normalised: sphere tests use true distances
        float l = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        if (l > 0) for (float& c : p) c /= l;
    }
    computeWanted(cam, aspect, wanted_);
    // request missing tiles nearest first; drop queued requests that are no longer wanted
    for (auto& ij : asset_->cancelQueued()) pending_.erase(ij.second * asset_->ni + ij.first);
    for (int k : wanted_) {
        auto it = tiles_.find(k);
        if (it != tiles_.end()) { it->second.lastUsed = frame; continue; }
        if (pending_.count(k)) continue;
        asset_->request(k % asset_->ni, k / asset_->ni);
        pending_[k] = true;
    }
    // collect decoded tiles (stale ones are dropped)
    std::vector<uint8_t> want(asset_->ni * asset_->nj, 0);
    for (int k : wanted_) want[k] = 1;
    TileCPU t;
    while (asset_->pop(t)) {
        int k = t.j * asset_->ni + t.i;
        pending_.erase(k);
        if (t.ok && want[t.j * asset_->ni + t.i] && !tiles_.count(t.j * asset_->ni + t.i)) decoded_.push_back(std::move(t));
    }
    decoded_.erase(std::remove_if(decoded_.begin(), decoded_.end(), [&](const TileCPU& d) { return !want[d.j * asset_->ni + d.i]; }), decoded_.end());
    // upload within the per-frame budget, nearest wanted first
    if (!decoded_.empty()) {
        std::vector<int> rank(asset_->ni * asset_->nj, 1 << 30);
        for (size_t r = 0; r < wanted_.size(); ++r) rank[wanted_[r]] = (int)r;
        std::sort(decoded_.begin(), decoded_.end(), [&](const TileCPU& a, const TileCPU& b) {
            return rank[a.j * asset_->ni + a.i] < rank[b.j * asset_->ni + b.i];
        });
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        size_t n = 0;
        uint64_t bytes = 0;
        while (n < decoded_.size() && (n == 0 || bytes < settings.uploadBudgetBytes)) {
            for (int l = 0; l < 3; ++l) bytes += decoded_[n].lod[l].verts.size() * sizeof(CityVertex) + decoded_[n].lod[l].idx.size() * 4;
            upload(cp, decoded_[n]);
            tiles_[decoded_[n].j * asset_->ni + decoded_[n].i].lastUsed = frame;
            ++n;
        }
        decoded_.erase(decoded_.begin(), decoded_.begin() + (long)n);
        SDL_EndGPUCopyPass(cp);
    }
    evict(frame);
    rebuildLampGrid(cmd);

    // visibility + LOD (hysteresis) + per-chunk ranges + instance gathering
    stats_.visible = stats_.lod1Tiles = stats_.lod2Tiles = stats_.visibleChunks = stats_.lod1Chunks = stats_.tileDraws = 0;
    stats_.triangles = stats_.tileTriangles = stats_.vehicles = stats_.gpuBytes = 0;
    const size_t nModels = models_[0].size();
    std::vector<std::vector<GpuInstance>> byModel[3];
    for (auto& b : byModel) b.resize(nModels);
    const float h = settings.lodHyst;
    // LOD distance: the nearer of the eye and the camera's focus (RTS pivot). Zoomed out, the eye is 200-300 m from
    // everything on screen, but the area the player looks at (around the pivot) must stay at full detail; the
    // transitions then move outwards from the focus instead of covering it.
    auto distTo = [&](const float* mn, const float* mx) {
        auto d = [&](V3 e) {
            float dx = std::max({mn[0] - e.x, 0.f, e.x - mx[0]});
            float dy = std::max({mn[1] - e.y, 0.f, e.y - mx[1]});
            float dz = std::max({mn[2] - e.z, 0.f, e.z - mx[2]});
            return std::sqrt(dx * dx + dy * dy + dz * dz);
        };
        return std::min(d(eye_), d(focus_));
    };
    auto pickLod = [&](float dist, int prev) {   // finer only once well inside the threshold (hysteresis)
        int want = dist > settings.lod2Dist ? 2 : dist > settings.lod1Dist ? 1 : 0;
        if (want < prev) want = std::max(want, dist > settings.lod2Dist - h ? 2 : dist > settings.lod1Dist - h ? 1 : 0);
        return want;
    };
    for (auto& [k, g] : tiles_) {
        stats_.gpuBytes += g.bytes;
        g.ranges.clear();
        g.visible = boxVisible(g.bmin, g.bmax);
        if (!g.visible) continue;
        g.lastUsed = frame;
        g.lod = pickLod(distTo(g.bmin, g.bmax), g.lod);
        stats_.visible++;
        stats_.lod1Tiles += g.lod == 1;
        stats_.lod2Tiles += g.lod == 2;
        auto addRange = [&](uint32_t firstIdx, uint32_t count) {
            if (!count) return;
            if (!g.ranges.empty() && g.ranges.back().first + g.ranges.back().second == firstIdx) g.ranges.back().second += count;
            else g.ranges.push_back({firstIdx, count});
            stats_.tileTriangles += count / 3;
        };
        if ((g.lod == 2 && g.hasLod2) || g.chunks.empty()) {
            addRange(g.lods[g.lod].first, g.lods[g.lod].count);
        } else {
            // chunk ranges index the LOD0 quads (shared quad index buffer: index 6q = quad q)
            for (size_t c = 0; c < g.chunks.size(); ++c) {
                const CityChunk& ch = g.chunks[c];
                if (!ch.n0) continue;
                int lod = g.lod;
                if (settings.chunks) {
                    if (!boxVisible(ch.bmin, ch.bmax)) continue;
                    lod = std::min(1, pickLod(distTo(ch.bmin, ch.bmax), g.chunkLod[c]));
                }
                g.chunkLod[c] = (uint8_t)lod;
                stats_.visibleChunks++;
                stats_.lod1Chunks += lod == 1;
                addRange(g.lods[0].first + ch.first * 6, (lod ? ch.n1 : ch.n0) * 6);
            }
        }
        stats_.tileDraws += (uint32_t)g.ranges.size();
        uint32_t nDyn = 0;   // dynamic vehicles (CityVehicles) of this tile: changed ones are drawn from its list below
        const Vehicle* dyn = vehicles_ ? vehicles_->tileVehicles(k, nDyn) : nullptr;
        for (size_t n = 0; n < g.instances.size(); ++n) {
            const CityInstance& v = g.instances[n];
            if (v.kind == 0 && n < nDyn && dyn[n].custom) continue;
            gatherInstance(byModel, v.kind, v.variant, &v.x, v.q, v.paint);
        }
    }
    // shadow casters: tiles / chunks inside the key light's clip box. LOD: the camera's choice where the camera sees the
    // chunk (receiver and caster then match), else by eye distance (no hysteresis).
    shadowCalls_ = 0;
    for (auto& [k, g] : tiles_) {
        g.sranges.clear();
        if (!shadowCull_ || !boxInPlanes(shadowPlanes_, 5, g.bmin, g.bmax)) continue;
        auto lodAt = [&](float dist) { return dist > settings.lod2Dist ? 2 : dist > settings.lod1Dist ? 1 : 0; };
        g.slod = g.visible ? g.lod : lodAt(distTo(g.bmin, g.bmax));
        auto addRange = [&](uint32_t firstIdx, uint32_t count) {
            if (!count) return;
            if (!g.sranges.empty() && g.sranges.back().first + g.sranges.back().second == firstIdx) g.sranges.back().second += count;
            else g.sranges.push_back({firstIdx, count});
        };
        if ((g.slod == 2 && g.hasLod2) || g.chunks.empty()) {
            addRange(g.lods[g.slod].first, g.lods[g.slod].count);
        } else {
            for (size_t c = 0; c < g.chunks.size(); ++c) {
                const CityChunk& ch = g.chunks[c];
                if (!ch.n0) continue;
                int lod = std::min(1, g.slod);
                if (settings.chunks) {
                    if (!boxInPlanes(shadowPlanes_, 5, ch.bmin, ch.bmax)) continue;
                    lod = g.visible && boxVisible(ch.bmin, ch.bmax) ? g.chunkLod[c] : std::min(1, lodAt(distTo(ch.bmin, ch.bmax)));
                }
                addRange(g.lods[0].first + ch.first * 6, (lod ? ch.n1 : ch.n0) * 6);
            }
        }
    }
    if (vehicles_)
        for (uint32_t i : vehicles_->customList()) {
            const Vehicle& v = vehicles_->vehicle(i);
            if (v.removed) continue;   // cleared by engineers
            gatherInstance(byModel, 0, v.variant, v.ro, v.q, v.paint);
        }
    stats_.triangles = stats_.tileTriangles;
    vdraws_.clear();
    std::vector<GpuInst> all;
    for (size_t m = 0; m < nModels; ++m)
        for (uint32_t lod = 0; lod < 3; ++lod) {
            auto& list = byModel[lod][m];
            if (list.empty()) continue;
            uint32_t n = std::min<uint32_t>((uint32_t)list.size(), instCapacity_ - (uint32_t)all.size());
            if (!n) break;
            const GpuMesh& mesh = models_[lod][m];
            if (!mesh.vb) continue;
            vdraws_.push_back({(uint32_t)m, (uint32_t)all.size(), n, lod});
            all.insert(all.end(), list.begin(), list.begin() + n);
            stats_.vehicles += n;
            stats_.triangles += (uint64_t)n * (mesh.idxCount / 3);
        }
    // indirect commands: every visible tile's ranges, contiguous per tile
    std::vector<SDL_GPUIndexedIndirectDrawCommand> cmds;
    if (settings.indirect)
        for (auto& [k, g] : tiles_) {
            g.indFirst = (uint32_t)cmds.size();
            const GpuTile::Lod& Q = ((g.lod == 2 && g.hasLod2) || g.chunks.empty()) ? g.lods[g.lod] : g.lods[0];
            for (auto& r : g.ranges) cmds.push_back({r.second, 1, r.first, (int32_t)Q.vtxOffset, 0});
        }
    if (settings.indirect)   // shadow-caster ranges after the camera's
        for (auto& [k, g] : tiles_) {
            g.sindFirst = (uint32_t)cmds.size();
            const GpuTile::Lod& Q = ((g.slod == 2 && g.hasLod2) || g.chunks.empty()) ? g.lods[g.slod] : g.lods[0];
            for (auto& r : g.sranges) cmds.push_back({r.second, 1, r.first, (int32_t)Q.vtxOffset, 0});
        }
    SDL_GPUDevice* d = gpu_->device();
    if (cmds.size() > indirectCap_) {
        if (indirect_) gpu_->releaseBuffer(indirect_);
        if (indirectTB_) SDL_ReleaseGPUTransferBuffer(d, indirectTB_);
        indirectCap_ = std::max<uint32_t>((uint32_t)cmds.size() * 2, 1024);
        const uint32_t bytes = indirectCap_ * (uint32_t)sizeof(SDL_GPUIndexedIndirectDrawCommand);
        indirect_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_INDIRECT, bytes, "cityIndirect");
        SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, bytes, 0};
        indirectTB_ = SDL_CreateGPUTransferBuffer(d, &tci);
    }
    indirectReady_ = !cmds.empty() && indirect_ && indirectTB_;
    if (!all.empty() || indirectReady_) {
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        if (!all.empty()) {
            std::memcpy(SDL_MapGPUTransferBuffer(d, instTB_, true), all.data(), all.size() * sizeof(GpuInst));
            SDL_UnmapGPUTransferBuffer(d, instTB_);
            SDL_GPUTransferBufferLocation src{instTB_, 0};
            SDL_GPUBufferRegion dst{instances_, 0, (uint32_t)(all.size() * sizeof(GpuInst))};
            SDL_UploadToGPUBuffer(cp, &src, &dst, true);
        }
        if (indirectReady_) {
            const uint32_t bytes = (uint32_t)(cmds.size() * sizeof(SDL_GPUIndexedIndirectDrawCommand));
            std::memcpy(SDL_MapGPUTransferBuffer(d, indirectTB_, true), cmds.data(), bytes);
            SDL_UnmapGPUTransferBuffer(d, indirectTB_);
            SDL_GPUTransferBufferLocation src{indirectTB_, 0};
            SDL_GPUBufferRegion dst{indirect_, 0, bytes};
            SDL_UploadToGPUBuffer(cp, &src, &dst, true);
        }
        SDL_EndGPUCopyPass(cp);
    }
    stats_.resident = (uint32_t)tiles_.size();
    stats_.wanted = (uint32_t)wanted_.size();
    stats_.pending = (uint32_t)(pending_.size() + decoded_.size());
    uint32_t tileCalls = 0;
    for (auto& [k, g] : tiles_) tileCalls += !g.ranges.empty();
    stats_.drawCalls = (indirectReady_ ? tileCalls : stats_.tileDraws) + (uint32_t)vdraws_.size();
    stats_.uploadMs = nowMs() - t0;
}

bool CityRenderer::boxVisible(const float* mn, const float* mx) const {
    for (auto& p : frustum_) {
        float x = p[0] > 0 ? mx[0] : mn[0], y = p[1] > 0 ? mx[1] : mn[1], z = p[2] > 0 ? mx[2] : mn[2];
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
}

bool CityRenderer::sphereVisible(float x, float y, float z, float r) const {
    for (auto& p : frustum_)
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
    return true;
}

float CityRenderer::heightAt(float x, float z) const {
    int i = (int)std::floor((x - asset_->x0) / asset_->tileSize), j = (int)std::floor((z - asset_->z0) / asset_->tileSize);
    if (i < 0 || j < 0 || i >= asset_->ni || j >= asset_->nj) return 0.f;
    auto it = tiles_.find(j * asset_->ni + i);
    if (it == tiles_.end() || it->second.coarse.empty()) return 0.f;
    const GpuTile& g = it->second;
    int cx = std::clamp((int)((x - g.cx0) / 4.f), 0, 31), cz = std::clamp((int)((z - g.cz0) / 4.f), 0, 31);
    return g.coarse[cz * 32 + cx];
}

void CityRenderer::nearestLamps(float x, float z, int maxCount, std::vector<PointLight>& out) const {
    out.clear();
    if (asset_->lampProp < 0) return;
    const size_t model = asset_->variants.size() + (size_t)asset_->lampProp;
    const float top = model < models_[0].size() ? std::max(2.5f, models_[0][model].top - 0.4f) : 5.5f;
    std::vector<std::pair<float, PointLight>> c;
    for (auto& [k, g] : tiles_) {
        if (!g.visible) continue;
        for (const CityInstance& v : g.instances)
            if (v.kind == 1 && (int)v.variant == asset_->lampProp) {
                float dx = v.x - x, dz = v.z - z;
                c.push_back({dx * dx + dz * dz, PointLight{v.x, v.y + top, v.z, 16.f, 1.0f, 0.62f, 0.32f, 2.0f}});
            }
    }
    size_t n = std::min(c.size(), (size_t)maxCount);
    std::partial_sort(c.begin(), c.begin() + (long)n, c.end(), [](auto& a, auto& b) { return a.first < b.first; });
    for (size_t k = 0; k < n; ++k) out.push_back(c[k].second);
}

void CityRenderer::flush(const Camera& cam, float aspect) {
    for (int it = 0; it < 2000; ++it) {
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu_->device());
        uint64_t budget = settings.uploadBudgetBytes;
        settings.uploadBudgetBytes = ~0ull >> 1;
        update(cmd, cam, aspect, 0);
        settings.uploadBudgetBytes = budget;
        SDL_SubmitGPUCommandBuffer(cmd);
        bool all = std::all_of(wanted_.begin(), wanted_.end(), [&](int k) { return tiles_.count(k) != 0; });
        if (all) break;
        SDL_Delay(2);
    }
    SDL_WaitForGPUIdle(gpu_->device());
}

void CityRenderer::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadowH,
                        SDL_GPUBuffer* corpseH) {
    if (!settings.draw || tiles_.empty()) return;
    {   // foliage + water first (own pipelines); the tile pipeline is bound after them
        std::vector<int> vis;
        for (auto& [k, g] : tiles_)
            if (g.visible) vis.push_back(k);
        auto boxVis = [this](const float* mn, const float* mx) { return boxVisible(mn, mx); };
        const float eye[3] = {eye_.x, eye_.y, eye_.z};
        foliage.lampGrid = water.lampGrid = lampGrid();
        const float focus[3] = {focus_.x, focus_.y, focus_.z};
        foliage.draw(pass, cmd, eye, focus, vis, materials_, boxVis);
        water.draw(pass, cmd, quadIB_, boxVis);
    }
    SDL_BindGPUGraphicsPipeline(pass, settings.backfaceCull ? pipe_ : pipeNoCull_);
    SDL_GPUBuffer* fb[5] = {materials_, decals ? decals : dummy_, shadowH ? shadowH : dummy_, corpseH ? corpseH : dummy_, lampGrid()};
    SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 5);
    bindShadowMap(pass);
    SDL_BindGPUVertexStorageBuffers(pass, 0, &instances_, 1);
    // front to back (early depth rejection)
    std::vector<std::pair<float, const GpuTile*>> order;
    for (auto& [k, g] : tiles_)
        if (g.visible) {
            float cx = 0.5f * (g.bmin[0] + g.bmax[0]) - eye_.x, cz = 0.5f * (g.bmin[2] + g.bmax[2]) - eye_.z;
            order.push_back({cx * cx + cz * cz, &g});
        }
    std::sort(order.begin(), order.end(), [](auto& a, auto& b) { return a.first < b.first; });
    for (auto& [dist, g] : order) {
        const GpuTile::Lod& L = g->lods[g->lod];
        if (!g->vb || g->ranges.empty() || (L.shared ? !quadIB_ : !g->ib)) continue;
        // chunk ranges use LOD0's vertex offset / quantisation (lods[0] == lods[1] for implicit quad lists)
        const GpuTile::Lod& Q = ((g->lod == 2 && g->hasLod2) || g->chunks.empty()) ? L : g->lods[0];
        DrawU u{{Q.origin[0], Q.origin[1], Q.origin[2], 0}, {Q.scale[0], Q.scale[1], 0, 0}, 0, 0, 0, 0, {}, {}};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{g->vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{Q.shared ? quadIB_ : g->ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        if (indirectReady_)
            SDL_DrawGPUIndexedPrimitivesIndirect(pass, indirect_, g->indFirst * (uint32_t)sizeof(SDL_GPUIndexedIndirectDrawCommand),
                                                 (uint32_t)g->ranges.size());
        else
            for (auto& r : g->ranges) SDL_DrawGPUIndexedPrimitives(pass, r.second, 1, r.first, (int32_t)Q.vtxOffset, 0);
    }
    for (const VDraw& v : vdraws_) {
        const GpuMesh& m = models_[v.lod][v.model];
        if (!m.vb) continue;
        DrawU u{{m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0}, 1, v.first, 0, 0, {}, {}};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{m.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{m.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, m.idxCount, v.count, 0, 0, 0);
    }
}

// ---- external instanced models (Military Asset Lab) ----
void CityRenderer::releaseMesh(GpuMesh& m) {
    if (!gpu_) return;
    gpu_->releaseBuffer(m.vb);
    gpu_->releaseBuffer(m.ib);
    m = GpuMesh{};
}

SDL_GPUBuffer* CityRenderer::createMaterialBuffer(const std::vector<CityMaterial>& list) const {
    std::vector<GpuMat> mats(256);
    for (auto& m : mats) m = {{0.5f, 0.5f, 0.5f, 0.f}, {0, 0, 0.8f, 0}, {0, 0, 0, 0}};
    for (size_t i = 0; i < list.size() && i < 256; ++i) {
        const CityMaterial& m = list[i];
        mats[i] = {{m.r, m.g, m.b, m.gloss}, {m.emissiveNight, (float)m.emissiveMode, m.roughness, m.emissiveDay},
                   {m.flags, m.dayMaterial >= 0 && m.dayMaterial < 256 ? (uint32_t)m.dayMaterial : (uint32_t)i, 0, 0}};
    }
    SDL_GPUBuffer* b = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(mats.size() * sizeof(GpuMat)), "extMaterials");
    gpu_->uploadNow(b, mats.data(), (uint32_t)(mats.size() * sizeof(GpuMat)));
    return b;
}

void CityRenderer::drawExternal(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* materials, SDL_GPUBuffer* insts,
                                SDL_GPUBuffer* decals, SDL_GPUBuffer* shadowH, SDL_GPUBuffer* corpseH, const std::vector<ExtDraw>& draws) {
    if (draws.empty() || !insts || !pipe_) return;
    SDL_BindGPUGraphicsPipeline(pass, settings.backfaceCull ? pipe_ : pipeNoCull_);
    SDL_GPUBuffer* fb[5] = {materials ? materials : materials_, decals ? decals : dummy_, shadowH ? shadowH : dummy_, corpseH ? corpseH : dummy_,
                            lampGrid()};
    SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 5);
    bindShadowMap(pass);
    SDL_BindGPUVertexStorageBuffers(pass, 0, &insts, 1);
    for (const ExtDraw& d : draws) {
        if (!d.mesh || !d.mesh->vb || !d.count) continue;
        const GpuMesh& m = *d.mesh;
        DrawU u{{m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0}, 1, d.first, 0, 0, {}, {}};
        std::memcpy(u.clampRect, d.clamp, sizeof(u.clampRect));
        std::memcpy(u.clampH, d.clamp + 4, sizeof(u.clampH));
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{m.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{m.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, m.idxCount, d.count, 0, 0, 0);
    }
}

void CityRenderer::bindShadowMap(SDL_GPURenderPass* pass) const {
    if (!shadowMap_.valid()) return;
    SDL_GPUTextureSamplerBinding b{shadowMap_.texture, shadowMap_.sampler};
    SDL_BindGPUFragmentSamplers(pass, 0, &b, 1);
}

bool CityRenderer::boxInPlanes(const float (*planes)[4], int n, const float* mn, const float* mx) const {
    for (int i = 0; i < n; ++i) {
        const float* p = planes[i];
        float x = p[0] > 0 ? mx[0] : mn[0], y = p[1] > 0 ? mx[1] : mn[1], z = p[2] > 0 ? mx[2] : mn[2];
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
}

void CityRenderer::setShadowCaster(const float* lightViewProj) {
    shadowCull_ = lightViewProj != nullptr && pipeShadow_ != nullptr;
    if (!shadowCull_) return;
    M4 vp;
    std::memcpy(vp.m, lightViewProj, sizeof(vp.m));
    // left, right, bottom, top, far (no near plane: casters towards the light are depth-clamped)
    for (int c = 0; c < 4; ++c) {
        shadowPlanes_[0][c] = vp(3, c) + vp(0, c);
        shadowPlanes_[1][c] = vp(3, c) - vp(0, c);
        shadowPlanes_[2][c] = vp(3, c) + vp(1, c);
        shadowPlanes_[3][c] = vp(3, c) - vp(1, c);
        shadowPlanes_[4][c] = vp(3, c) - vp(2, c);
    }
}

void CityRenderer::drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd) {
    shadowCalls_ = 0;
    if (!settings.draw || tiles_.empty() || !pipeShadow_ || !shadowCull_) return;
    SDL_BindGPUGraphicsPipeline(pass, pipeShadow_);
    SDL_BindGPUVertexStorageBuffers(pass, 0, &instances_, 1);
    for (auto& [k, g] : tiles_) {
        const GpuTile::Lod& L = g.lods[g.slod];
        if (!g.vb || g.sranges.empty() || (L.shared ? !quadIB_ : !g.ib)) continue;
        const GpuTile::Lod& Q = ((g.slod == 2 && g.hasLod2) || g.chunks.empty()) ? L : g.lods[0];
        DrawU u{{Q.origin[0], Q.origin[1], Q.origin[2], 0}, {Q.scale[0], Q.scale[1], 0, 0}, 0, 0, 0, 0, {}, {}};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{g.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{Q.shared ? quadIB_ : g.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        if (indirectReady_) {
            SDL_DrawGPUIndexedPrimitivesIndirect(pass, indirect_, g.sindFirst * (uint32_t)sizeof(SDL_GPUIndexedIndirectDrawCommand),
                                                 (uint32_t)g.sranges.size());
            shadowCalls_++;
        } else {
            for (auto& r : g.sranges) SDL_DrawGPUIndexedPrimitives(pass, r.second, 1, r.first, (int32_t)Q.vtxOffset, 0);
            shadowCalls_ += (uint32_t)g.sranges.size();
        }
    }
    for (const VDraw& v : vdraws_) {   // vehicles / props (camera-visible instances)
        const GpuMesh& m = models_[v.lod][v.model];
        if (!m.vb) continue;
        DrawU u{{m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0}, 1, v.first, 0, 0, {}, {}};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{m.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{m.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, m.idxCount, v.count, 0, 0, 0);
        shadowCalls_++;
    }
}

void CityRenderer::drawExternalShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* insts,
                                      const std::vector<ExtDraw>& draws) {
    SDL_GPUGraphicsPipeline* pipe = pipeShadowExt_ ? pipeShadowExt_ : pipeShadow_;
    if (draws.empty() || !insts || !pipe) return;
    SDL_BindGPUGraphicsPipeline(pass, pipe);
    SDL_BindGPUVertexStorageBuffers(pass, 0, &insts, 1);
    for (const ExtDraw& d : draws) {
        if (!d.mesh || !d.mesh->vb || !d.count) continue;
        const GpuMesh& m = *d.mesh;
        DrawU u{{m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0}, 1, d.first, 0, 0, {}, {}};
        std::memcpy(u.clampRect, d.clamp, sizeof(u.clampRect));
        std::memcpy(u.clampH, d.clamp + 4, sizeof(u.clampH));
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{m.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{m.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, m.idxCount, d.count, 0, 0, 0);
    }
}

// Street-lamp light grid (std430 uint array, read by lampLights() in shaders/include/lighting.glsl):
//   [0..11]  header: grid w, h, lamp offset, index offset, origin x, origin z (float bits), 1 / cell (float), radius (float),
//            intensity (float), lamp count, 0, 0
//   [12..]   per cell (row-major): first index, count
//   lamps:   4 words each: x, y, z (float bits), rgba8 colour (a = relative intensity)
//   indices: lamp ids per cell
// Every lamp of every resident tile is in it (residency covers the view footprint + a tile ring), so lamps never
// switch on or off with distance or count; rebuilt only when the resident set or the lamp settings change.
void CityRenderer::rebuildLampGrid(SDL_GPUCommandBuffer* cmd) {
    if (asset_->lampProp < 0) return;
    uint64_t sig = 1469598103934665603ull;
    {
        std::vector<int> keys;
        keys.reserve(tiles_.size());
        for (auto& [k, g] : tiles_) keys.push_back(k);
        std::sort(keys.begin(), keys.end());
        for (int k : keys) sig = (sig ^ (uint64_t)(k + 1)) * 1099511628211ull;
        uint32_t bits[3];
        std::memcpy(&bits[0], &settings.lampRadius, 4);
        std::memcpy(&bits[1], &settings.lampIntensity, 4);
        std::memcpy(&bits[2], &settings.lampLedShare, 4);
        for (uint32_t b : bits) sig = (sig ^ b) * 1099511628211ull;
    }
    if (sig == lampSig_) return;
    lampSig_ = sig;
    const size_t model = asset_->variants.size() + (size_t)asset_->lampProp;
    const float top = model < models_[0].size() ? std::max(2.5f, models_[0][model].top - 0.4f) : 5.5f;
    struct L { float x, y, z; uint32_t rgba; };
    std::vector<L> lamps;
    float mnx = 1e30f, mnz = 1e30f, mxx = -1e30f, mxz = -1e30f;
    for (auto& [k, g] : tiles_)
        for (const CityInstance& v : g.instances)
            if (v.kind == 1 && (int)v.variant == asset_->lampProp) {
                // sodium (warm orange) or LED (cool white) by a position hash; slight per-lamp intensity variation
                uint32_t h = (uint32_t)((int32_t)std::floor(v.x * 2.f) * 73856093) ^ (uint32_t)((int32_t)std::floor(v.z * 2.f) * 19349663);
                h = (h ^ (h >> 13)) * 1274126177u;
                const float r = (float)(h & 0xffff) / 65535.f, r2 = (float)((h >> 16) & 0xff) / 255.f;
                const bool led = r < settings.lampLedShare;
                const float c[4] = {led ? 0.86f : 1.00f, led ? 0.92f : 0.58f, led ? 1.00f : 0.26f, 0.85f + 0.15f * r2};
                uint32_t rgba = 0;
                for (int i = 0; i < 4; ++i) rgba |= (uint32_t)std::lround(std::clamp(c[i], 0.f, 1.f) * 255.f) << (8 * i);
                lamps.push_back({v.x, v.y + top, v.z, rgba});
                mnx = std::min(mnx, v.x); mxx = std::max(mxx, v.x);
                mnz = std::min(mnz, v.z); mxz = std::max(mxz, v.z);
            }
    const float R = std::max(2.f, settings.lampRadius), cell = 8.f;
    std::vector<uint32_t> buf(12, 0);
    uint32_t W = 0, H = 0;
    if (!lamps.empty()) {
        const float ox = std::floor((mnx - R) / cell) * cell, oz = std::floor((mnz - R) / cell) * cell;
        W = (uint32_t)std::ceil((mxx + R - ox) / cell) + 1;
        H = (uint32_t)std::ceil((mxz + R - oz) / cell) + 1;
        std::vector<std::vector<uint32_t>> cells((size_t)W * H);
        for (uint32_t i = 0; i < (uint32_t)lamps.size(); ++i) {
            const L& l = lamps[i];
            int x0 = (int)std::floor((l.x - R - ox) / cell), x1 = (int)std::floor((l.x + R - ox) / cell);
            int z0 = (int)std::floor((l.z - R - oz) / cell), z1 = (int)std::floor((l.z + R - oz) / cell);
            for (int z = std::max(z0, 0); z <= std::min(z1, (int)H - 1); ++z)
                for (int x = std::max(x0, 0); x <= std::min(x1, (int)W - 1); ++x) {
                    // cell rectangle within R of the lamp (xz)
                    float cx = std::clamp(l.x, ox + x * cell, ox + (x + 1) * cell), cz = std::clamp(l.z, oz + z * cell, oz + (z + 1) * cell);
                    if ((cx - l.x) * (cx - l.x) + (cz - l.z) * (cz - l.z) <= R * R) cells[(size_t)z * W + x].push_back(i);
                }
        }
        const uint32_t lampOff = 12 + 2 * W * H, idxOff = lampOff + 4 * (uint32_t)lamps.size();
        buf.resize(idxOff, 0);
        uint32_t next = 0;
        for (size_t c = 0; c < cells.size(); ++c) {
            buf[12 + 2 * c] = next;
            buf[12 + 2 * c + 1] = (uint32_t)cells[c].size();
            next += (uint32_t)cells[c].size();
        }
        for (size_t i = 0; i < lamps.size(); ++i) std::memcpy(&buf[lampOff + 4 * i], &lamps[i], 16);
        for (auto& c : cells) buf.insert(buf.end(), c.begin(), c.end());
        const float inv = 1.f / cell, gain = settings.lampIntensity;
        buf[0] = W; buf[1] = H; buf[2] = lampOff; buf[3] = idxOff;
        std::memcpy(&buf[4], &ox, 4); std::memcpy(&buf[5], &oz, 4); std::memcpy(&buf[6], &inv, 4); std::memcpy(&buf[7], &R, 4);
        std::memcpy(&buf[8], &gain, 4);
        buf[9] = (uint32_t)lamps.size();
    }
    lampCount_ = (uint32_t)lamps.size();
    const uint32_t bytes = (uint32_t)(buf.size() * 4);
    gpu_->releaseBuffer(lampGrid_);   // deferred by SDL until frames in flight are done with it
    lampGrid_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, bytes, "cityLampGrid");
    SDL_GPUDevice* d = gpu_->device();
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, bytes, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
    std::memcpy(SDL_MapGPUTransferBuffer(d, tb, false), buf.data(), bytes);
    SDL_UnmapGPUTransferBuffer(d, tb);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTransferBufferLocation src{tb, 0};
    SDL_GPUBufferRegion dst{lampGrid_, 0, bytes};
    SDL_UploadToGPUBuffer(cp, &src, &dst, false);
    SDL_EndGPUCopyPass(cp);
    SDL_ReleaseGPUTransferBuffer(d, tb);
}

} // namespace ttz
