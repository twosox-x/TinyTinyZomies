#include "city/CityWater.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
struct WaterU { float level[4]; };   // std140, shaders/city_water.vert slot 1: x level
struct FolU {                        // std140, shaders/city_foliage.vert slot 1
    float tile[4];                   // x0, z0 (tile corner), lod (0 / 1)
    float origin[4];                 // model quantisation origin
    float scale[4];                  // x xz, y y metres per unit
    float params[4];                 // x sway, y model height, z fadeStart, w fadeDist
    uint32_t first, pad0, pad1, pad2;
};

SDL_GPUGraphicsPipeline* makePipe(GpuContext& gpu, const char* vs, const char* fs, const SDL_GPUVertexBufferDescription& vbd,
                                  const SDL_GPUVertexAttribute* attrs, uint32_t nattrs, bool cull, SDL_GPUSampleCount samples,
                                  SDL_GPUTextureFormat color, SDL_GPUTextureFormat depth) {
    SDL_GPUDevice* d = gpu.device();
    SDL_GPUShader* v = gpu.loadShader(vs, SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu.loadShader(fs, SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) {
        if (v) SDL_ReleaseGPUShader(d, v);
        if (f) SDL_ReleaseGPUShader(d, f);
        return nullptr;
    }
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_input_state = {&vbd, 1, attrs, nattrs};
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = cull ? SDL_GPU_CULLMODE_BACK : SDL_GPU_CULLMODE_NONE;
    ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    ci.multisample_state.sample_count = samples;
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = true;
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = color;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
    ci.target_info.depth_stencil_format = depth;
    ci.target_info.has_depth_stencil_target = true;
    SDL_GPUGraphicsPipeline* p = SDL_CreateGPUGraphicsPipeline(d, &ci);
    if (!p) SDL_Log("city pipeline %s: %s", vs, SDL_GetError());
    SDL_ReleaseGPUShader(d, v);
    SDL_ReleaseGPUShader(d, f);
    return p;
}

SDL_GPUBuffer* uploadBytes(GpuContext& gpu, SDL_GPUCopyPass* cp, SDL_GPUBufferUsageFlags usage, const void* data, uint32_t bytes) {
    SDL_GPUDevice* d = gpu.device();
    SDL_GPUBufferCreateInfo bi{usage, bytes, 0};
    SDL_GPUBuffer* b = SDL_CreateGPUBuffer(d, &bi);
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, bytes, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
    void* p = SDL_MapGPUTransferBuffer(d, tb, false);
    std::memcpy(p, data, bytes);
    SDL_UnmapGPUTransferBuffer(d, tb);
    SDL_GPUTransferBufferLocation src{tb, 0};
    SDL_GPUBufferRegion dst{b, 0, bytes};
    SDL_UploadToGPUBuffer(cp, &src, &dst, false);
    SDL_ReleaseGPUTransferBuffer(d, tb);
    return b;
}
} // namespace

// ============================================================================================== water
bool CityWater::init(GpuContext& gpu, SDL_GPUSampleCount samples, SDL_GPUTextureFormat color, SDL_GPUTextureFormat depth) {
    gpu_ = &gpu;
    SDL_GPUVertexBufferDescription vbd{0, 12, SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
    SDL_GPUVertexAttribute attrs[1] = {{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0}};
    pipe_ = makePipe(gpu, "city_water.vert", "city_water.frag", vbd, attrs, 1, true, samples, color, depth);
    return pipe_ != nullptr;
}

void CityWater::shutdown() {
    if (!gpu_) return;
    SDL_Log("city water: last frame %u tris, %zu tiles with water resident", lastTris, tiles_.size());
    for (auto& [k, t] : tiles_) gpu_->releaseBuffer(t.vb);
    tiles_.clear();
    if (pipe_) SDL_ReleaseGPUGraphicsPipeline(gpu_->device(), pipe_);
    pipe_ = nullptr;
    gpu_ = nullptr;
}

uint32_t CityWater::upload(SDL_GPUCopyPass* cp, int key, const TileCPU& t) {
    release(key);
    if (!gpu_ || t.water.empty()) return 0;
    Tile w;
    w.quads = (uint32_t)(t.water.size() / 12);
    w.level = t.waterLevel;
    w.bmin[0] = w.bmin[2] = 1e30f; w.bmax[0] = w.bmax[2] = -1e30f;
    for (size_t k = 0; k < t.water.size(); k += 3) {
        w.bmin[0] = std::min(w.bmin[0], t.water[k]); w.bmax[0] = std::max(w.bmax[0], t.water[k]);
        w.bmin[2] = std::min(w.bmin[2], t.water[k + 1]); w.bmax[2] = std::max(w.bmax[2], t.water[k + 1]);
    }
    w.bmin[1] = w.level - 0.5f; w.bmax[1] = w.level + 0.5f;
    w.vb = uploadBytes(*gpu_, cp, SDL_GPU_BUFFERUSAGE_VERTEX, t.water.data(), (uint32_t)(t.water.size() * 4));
    tiles_[key] = w;
    return w.quads;
}

void CityWater::release(int key) {
    auto it = tiles_.find(key);
    if (it == tiles_.end()) return;
    gpu_->releaseBuffer(it->second.vb);
    tiles_.erase(it);
}

void CityWater::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* quadIB, const BoxVisibleFn& visible) {
    lastTris = 0;
    if (!enabled || !pipe_ || !quadIB || tiles_.empty()) return;
    SDL_BindGPUGraphicsPipeline(pass, pipe_);
    SDL_GPUBufferBinding ib{quadIB, 0};
    SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    for (auto& [k, t] : tiles_) {
        if (!t.vb || !visible(t.bmin, t.bmax)) continue;
        WaterU u{{t.level, 0, 0, 0}};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{t.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_DrawGPUIndexedPrimitives(pass, t.quads * 6, 1, 0, 0, 0);
        lastTris += t.quads * 2;
    }
}

// ============================================================================================== foliage
bool CityFoliage::init(GpuContext& gpu, const CityAsset& asset, SDL_GPUSampleCount samples, SDL_GPUTextureFormat color,
                       SDL_GPUTextureFormat depth) {
    gpu_ = &gpu;
    SDL_GPUVertexBufferDescription vbd{0, sizeof(CityVertex), SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
    SDL_GPUVertexAttribute attrs[2] = {{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_SHORT4, 0}, {1, 0, SDL_GPU_VERTEXELEMENTFORMAT_BYTE4, 8}};
    pipe_ = makePipe(gpu, "city_foliage.vert", "city_foliage.frag", vbd, attrs, 2, false, samples, color, depth);
    if (!pipe_) return false;
    sway_ = asset.foliageSway;
    for (const ModelVariant& v : asset.foliage)
        for (int l = 0; l < 2; ++l) {
            const CityMesh& m = l == 0 || v.lod1.verts.empty() ? v.lod0 : v.lod1;
            Model g;
            if (!m.verts.empty() && !m.idx.empty()) {
                g.vb = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_VERTEX, (uint32_t)(m.verts.size() * sizeof(CityVertex)), "cityFoliageModel");
                g.ib = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_INDEX, (uint32_t)(m.idx.size() * 4), "cityFoliageModel");
                gpu.uploadNow(g.vb, m.verts.data(), (uint32_t)(m.verts.size() * sizeof(CityVertex)));
                gpu.uploadNow(g.ib, m.idx.data(), (uint32_t)(m.idx.size() * 4));
                g.idx = (uint32_t)m.idx.size();
                g.quads = m.quads;
            }
            std::memcpy(g.origin, m.origin, sizeof(g.origin));
            g.scale[0] = m.scaleXZ; g.scale[1] = m.scaleY;
            g.height = std::max(0.2f, m.bmax[1]);
            models_[l].push_back(g);
        }
    dummy_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, 64, "cityFoliageDummy");
    std::vector<uint8_t> zeros(64, 0);
    gpu.uploadNow(dummy_, zeros.data(), 64);
    return true;
}

void CityFoliage::shutdown() {
    if (!gpu_) return;
    SDL_Log("city foliage: last frame %llu instances submitted (%.2f M tris before distance thinning), %u draws, %zu tiles resident",
            (unsigned long long)stats.instances, stats.triangles / 1e6, stats.draws, tiles_.size());
    for (auto& [k, t] : tiles_) gpu_->releaseBuffer(t.inst);
    tiles_.clear();
    for (auto& L : models_) {
        for (Model& m : L) { if (m.vb) gpu_->releaseBuffer(m.vb); if (m.ib) gpu_->releaseBuffer(m.ib); }
        L.clear();
    }
    if (dummy_) gpu_->releaseBuffer(dummy_);
    if (pipe_) SDL_ReleaseGPUGraphicsPipeline(gpu_->device(), pipe_);
    pipe_ = nullptr;
    gpu_ = nullptr;
}

void CityFoliage::upload(SDL_GPUCopyPass* cp, int key, const TileCPU& t, float tileX0, float tileZ0) {
    release(key);
    if (!gpu_ || !pipe_ || t.foliage.empty() || t.foliChunks != 16) return;
    Tile f;
    f.inst = uploadBytes(*gpu_, cp, SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, t.foliage.data(), (uint32_t)(t.foliage.size() * 4));
    f.start = t.foliStart;
    f.types = t.foliTypes;
    f.chunks = t.foliChunks;
    f.x0 = tileX0;
    f.z0 = tileZ0;
    tiles_[key] = std::move(f);
}

void CityFoliage::release(int key) {
    auto it = tiles_.find(key);
    if (it == tiles_.end()) return;
    gpu_->releaseBuffer(it->second.inst);
    tiles_.erase(it);
}

void CityFoliage::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, const float eye[3], const std::vector<int>& keys,
                       SDL_GPUBuffer* materials, const BoxVisibleFn& visible) {
    stats = {};
    if (!enabled || !pipe_ || tiles_.empty() || models_[0].empty()) return;
    bool bound = false;
    for (int key : keys) {
        auto it = tiles_.find(key);
        if (it == tiles_.end()) continue;
        const Tile& t = it->second;
        bool tileBound = false;
        for (uint32_t c = 0; c < t.chunks; ++c) {
            const float cx0 = t.x0 + (c % 4) * 32.f, cz0 = t.z0 + (c / 4) * 32.f;
            const float mn[3] = {cx0 - 1.f, -4.f, cz0 - 1.f}, mx[3] = {cx0 + 33.f, 3.5f, cz0 + 33.f};
            const float dx = std::max({mn[0] - eye[0], 0.f, eye[0] - mx[0]}), dz = std::max({mn[2] - eye[2], 0.f, eye[2] - mx[2]});
            const float dy = std::max(eye[1] - mx[1], 0.f), dist = std::sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > fadeDist || !visible(mn, mx)) continue;
            // nearest point -> lod; the vertex shader thins by each instance's own distance
            const int lod = dist < lod1Dist ? 0 : 1;
            for (uint32_t ty = 0; ty < t.types && ty < models_[lod].size(); ++ty) {
                const uint32_t a = t.start[c * t.types + ty], b = t.start[c * t.types + ty + 1];
                const Model& m = models_[lod][ty];
                if (b <= a || !m.vb) continue;
                if (!bound) {
                    SDL_BindGPUGraphicsPipeline(pass, pipe_);
                    SDL_BindGPUFragmentStorageBuffers(pass, 0, &materials, 1);
                    bound = true;
                }
                if (!tileBound) { SDL_BindGPUVertexStorageBuffers(pass, 0, &t.inst, 1); tileBound = true; }
                FolU u{{t.x0, t.z0, (float)lod, 0}, {m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0},
                       {ty < sway_.size() ? sway_[ty] : 0.f, m.height, fadeStart, fadeDist}, a, 0, 0, 0};
                SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
                SDL_GPUBufferBinding vb{m.vb, 0};
                SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
                SDL_GPUBufferBinding ib{m.ib, 0};
                SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_DrawGPUIndexedPrimitives(pass, m.idx, b - a, 0, 0, 0);
                stats.instances += b - a;
                stats.triangles += (uint64_t)(b - a) * m.quads * 2;
                stats.draws++;
            }
        }
    }
}

} // namespace ttz
