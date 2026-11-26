#include "city/CityRenderer.h"

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
};
struct GpuMat {              // std430, shaders/city.frag
    float albedo[4];         // linear rgb, w gloss
    float emis[4];           // x night strength, y mode (EmissiveMode), z roughness
    uint32_t info[4];        // x flags (CityMatFlags)
};
struct GpuInst {             // std430, shaders/city.vert
    float pos[4];            // xyz, w kind (0 vehicle, 1 prop)
    float quat[4];
    float paint[4];          // linear rgb, w tint flag (vehicles) / signal phase (props)
};
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
        mats[i] = {{m.r, m.g, m.b, m.gloss}, {m.emissiveNight, (float)m.emissiveMode, m.roughness, 0}, {m.flags, 0, 0, 0}};
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

    // instanced models: vehicle variants then prop types; LOD1 falls back to LOD0
    for (const auto* list : {&asset.variants, &asset.props})
        for (const ModelVariant& v : *list) {
            models_[0].push_back(uploadMesh(v.lod0, "cityModelLod0"));
            models_[1].push_back(v.lod1.idx.empty() ? models_[0].back() : uploadMesh(v.lod1, "cityModelLod1"));
            if (v.lod1.idx.empty()) models_[1].back().vb = nullptr;   // shared: drawn through models_[0]
        }
    asset.start();
    return true;
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
    return g;
}

void CityRenderer::shutdown() {
    if (!gpu_) return;
    if (asset_) asset_->stop();
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (auto& [k, t] : tiles_) {
        if (t.vb) SDL_ReleaseGPUBuffer(d, t.vb);
        if (t.ib) SDL_ReleaseGPUBuffer(d, t.ib);
    }
    tiles_.clear();
    for (int l = 1; l >= 0; --l) {
        for (GpuMesh& m : models_[l])
            if (m.vb) { gpu_->releaseBuffer(m.vb); gpu_->releaseBuffer(m.ib); }
        models_[l].clear();
    }
    gpu_->releaseBuffer(materials_);
    gpu_->releaseBuffer(instances_);
    gpu_->releaseBuffer(dummy_);
    if (instTB_) SDL_ReleaseGPUTransferBuffer(d, instTB_);
    instTB_ = nullptr;
    for (auto p : {pipe_, pipeNoCull_})
        if (p) SDL_ReleaseGPUGraphicsPipeline(d, p);
    pipe_ = pipeNoCull_ = nullptr;
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

void CityRenderer::upload(SDL_GPUCopyPass* cp, TileCPU& t) {
    SDL_GPUDevice* d = gpu_->device();
    GpuTile g;
    uint32_t nv = 0, ni = 0;
    for (int l = 0; l < 2; ++l) {
        g.vtxOffset[l] = nv;
        g.idxOffset[l] = ni;
        g.idxCount[l] = (uint32_t)t.lod[l].idx.size();
        nv += (uint32_t)t.lod[l].verts.size();
        ni += (uint32_t)t.lod[l].idx.size();
        g.origin[l][0] = t.lod[l].origin[0]; g.origin[l][1] = t.lod[l].origin[1]; g.origin[l][2] = t.lod[l].origin[2];
        g.origin[l][3] = 0;
        g.scale[l][0] = t.lod[l].scaleXZ; g.scale[l][1] = t.lod[l].scaleY; g.scale[l][2] = g.scale[l][3] = 0;
    }
    if (g.idxCount[1] == 0) {   // no far LOD baked: reuse LOD0
        g.idxOffset[1] = g.idxOffset[0]; g.idxCount[1] = g.idxCount[0]; g.vtxOffset[1] = g.vtxOffset[0];
        std::memcpy(g.origin[1], g.origin[0], sizeof(g.origin[0]));
        std::memcpy(g.scale[1], g.scale[0], sizeof(g.scale[0]));
    }
    const CityMesh& m0 = t.lod[0].idx.empty() ? t.lod[1] : t.lod[0];
    std::memcpy(g.bmin, m0.bmin, sizeof(g.bmin));
    std::memcpy(g.bmax, m0.bmax, sizeof(g.bmax));
    if (t.lod[0].idx.empty() && t.lod[1].idx.empty()) {   // instances only: bounds = tile rectangle
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
    g.instances = std::move(t.instances);
    for (const CityInstance& v : g.instances) {   // instances may stand on the tile edge: grow the bounds
        g.bmin[0] = std::min(g.bmin[0], v.x - 3.f); g.bmax[0] = std::max(g.bmax[0], v.x + 3.f);
        g.bmin[2] = std::min(g.bmin[2], v.z - 3.f); g.bmax[2] = std::max(g.bmax[2], v.z + 3.f);
        g.bmax[1] = std::max(g.bmax[1], v.y + 8.f);
    }
    // 16-bit indices when every LOD fits (indices are relative to the LOD's vertex offset)
    g.index16 = t.lod[0].verts.size() <= 65535 && t.lod[1].verts.size() <= 65535;
    const uint32_t isz = g.index16 ? 2 : 4;
    uint32_t vbBytes = nv * sizeof(CityVertex), ibBytes = ni * isz;
    if (vbBytes && ibBytes) {
        SDL_GPUBufferCreateInfo bi{SDL_GPU_BUFFERUSAGE_VERTEX, vbBytes, 0};
        g.vb = SDL_CreateGPUBuffer(d, &bi);
        bi = {SDL_GPU_BUFFERUSAGE_INDEX, ibBytes, 0};
        g.ib = SDL_CreateGPUBuffer(d, &bi);
        SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, vbBytes + ibBytes, 0};
        SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(d, &tci);
        auto* p = (uint8_t*)SDL_MapGPUTransferBuffer(d, tb, false);
        uint8_t* q = p;
        for (int l = 0; l < 2; ++l) { std::memcpy(q, t.lod[l].verts.data(), t.lod[l].verts.size() * sizeof(CityVertex)); q += t.lod[l].verts.size() * sizeof(CityVertex); }
        for (int l = 0; l < 2; ++l) {
            if (g.index16) {
                auto* d16 = (uint16_t*)q;
                for (uint32_t v : t.lod[l].idx) *d16++ = (uint16_t)v;
            } else {
                std::memcpy(q, t.lod[l].idx.data(), t.lod[l].idx.size() * 4);
            }
            q += t.lod[l].idx.size() * isz;
        }
        SDL_UnmapGPUTransferBuffer(d, tb);
        SDL_GPUTransferBufferLocation src{tb, 0};
        SDL_GPUBufferRegion dst{g.vb, 0, vbBytes};
        SDL_UploadToGPUBuffer(cp, &src, &dst, false);
        src.offset = vbBytes;
        dst = {g.ib, 0, ibBytes};
        SDL_UploadToGPUBuffer(cp, &src, &dst, false);
        SDL_ReleaseGPUTransferBuffer(d, tb);   // released once the copy has executed
    }
    g.bytes = vbBytes + ibBytes;
    stats_.uploadedBytes += g.bytes;
    stats_.uploadedTiles++;
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
        tiles_.erase(e.second);
    }
}

void CityRenderer::update(SDL_GPUCommandBuffer* cmd, const Camera& cam, float aspect, uint64_t frame) {
    double t0 = nowMs();
    stats_.uploadedTiles = 0;
    stats_.uploadedBytes = 0;
    eye_ = cam.eye();
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
            for (int l = 0; l < 2; ++l) bytes += decoded_[n].lod[l].verts.size() * sizeof(CityVertex) + decoded_[n].lod[l].idx.size() * 2;
            upload(cp, decoded_[n]);
            tiles_[decoded_[n].j * asset_->ni + decoded_[n].i].lastUsed = frame;
            ++n;
        }
        decoded_.erase(decoded_.begin(), decoded_.begin() + (long)n);
        SDL_EndGPUCopyPass(cp);
    }
    evict(frame);

    // visibility + LOD (hysteresis) + vehicle gathering
    stats_.visible = stats_.lod1Tiles = 0;
    stats_.triangles = stats_.vehicles = stats_.gpuBytes = 0;
    const size_t nModels = models_[0].size(), nVeh = asset_->variants.size();
    std::vector<std::vector<GpuInst>> byModel[2] = {std::vector<std::vector<GpuInst>>(nModels), std::vector<std::vector<GpuInst>>(nModels)};
    for (auto& [k, g] : tiles_) {
        stats_.gpuBytes += g.bytes;
        bool vis = true;
        for (auto& p : frustum_) {
            float x = p[0] > 0 ? g.bmax[0] : g.bmin[0], y = p[1] > 0 ? g.bmax[1] : g.bmin[1], z = p[2] > 0 ? g.bmax[2] : g.bmin[2];
            if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) { vis = false; break; }
        }
        g.visible = vis;
        if (!vis) continue;
        g.lastUsed = frame;
        float dx = std::max({g.bmin[0] - eye_.x, 0.f, eye_.x - g.bmax[0]});
        float dy = std::max({g.bmin[1] - eye_.y, 0.f, eye_.y - g.bmax[1]});
        float dz = std::max({g.bmin[2] - eye_.z, 0.f, eye_.z - g.bmax[2]});
        float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
        if (g.lod == 0 && dist > settings.lodFar) g.lod = 1;
        else if (g.lod == 1 && dist < settings.lodNear) g.lod = 0;
        stats_.visible++;
        stats_.lod1Tiles += g.lod;
        stats_.triangles += g.idxCount[g.lod] / 3;
        for (const CityInstance& v : g.instances) {
            size_t model = v.kind == 0 ? v.variant : nVeh + v.variant;
            if (model >= nModels || (v.kind == 0 && v.variant >= nVeh)) continue;
            if (v.kind == 0 ? !settings.vehicles : !settings.props) continue;
            float ex = v.x - eye_.x, ey = v.y - eye_.y, ez = v.z - eye_.z, d2 = ex * ex + ey * ey + ez * ez;
            int lod = 0;
            if (v.kind == 0) lod = d2 > settings.vehicleBoxDist * settings.vehicleBoxDist ? 1 : 0;
            else if (d2 > settings.propDist * settings.propDist) continue;
            byModel[lod][model].push_back({{v.x, v.y, v.z, (float)v.kind}, {v.q[0], v.q[1], v.q[2], v.q[3]},
                                           {v.paint[0], v.paint[1], v.paint[2], v.paint[3]}});
        }
    }
    vdraws_.clear();
    std::vector<GpuInst> all;
    for (size_t m = 0; m < nModels; ++m)
        for (uint32_t lod = 0; lod < 2; ++lod) {
            auto& list = byModel[lod][m];
            if (list.empty()) continue;
            uint32_t n = std::min<uint32_t>((uint32_t)list.size(), instCapacity_ - (uint32_t)all.size());
            if (!n) break;
            const GpuMesh& mesh = models_[lod][m].vb ? models_[lod][m] : models_[0][m];
            if (!mesh.vb) continue;
            vdraws_.push_back({(uint32_t)m, (uint32_t)all.size(), n, models_[lod][m].vb ? lod : 0u});
            all.insert(all.end(), list.begin(), list.begin() + n);
            stats_.vehicles += n;
            stats_.triangles += (uint64_t)n * (mesh.idxCount / 3);
        }
    if (!all.empty()) {
        SDL_GPUDevice* d = gpu_->device();
        std::memcpy(SDL_MapGPUTransferBuffer(d, instTB_, true), all.data(), all.size() * sizeof(GpuInst));
        SDL_UnmapGPUTransferBuffer(d, instTB_);
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTransferBufferLocation src{instTB_, 0};
        SDL_GPUBufferRegion dst{instances_, 0, (uint32_t)(all.size() * sizeof(GpuInst))};
        SDL_UploadToGPUBuffer(cp, &src, &dst, true);
        SDL_EndGPUCopyPass(cp);
    }
    stats_.resident = (uint32_t)tiles_.size();
    stats_.wanted = (uint32_t)wanted_.size();
    stats_.pending = (uint32_t)(pending_.size() + decoded_.size());
    stats_.drawCalls = stats_.visible + (uint32_t)vdraws_.size();
    stats_.uploadMs = nowMs() - t0;
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
    SDL_BindGPUGraphicsPipeline(pass, settings.backfaceCull ? pipe_ : pipeNoCull_);
    SDL_GPUBuffer* fb[4] = {materials_, decals ? decals : dummy_, shadowH ? shadowH : dummy_, corpseH ? corpseH : dummy_};
    SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 4);
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
        int l = g->lod;
        if (!g->vb || !g->idxCount[l]) continue;
        DrawU u{{g->origin[l][0], g->origin[l][1], g->origin[l][2], 0}, {g->scale[l][0], g->scale[l][1], 0, 0}, 0, 0, 0, 0};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{g->vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{g->ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, g->index16 ? SDL_GPU_INDEXELEMENTSIZE_16BIT : SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, g->idxCount[l], 1, g->idxOffset[l], (int32_t)g->vtxOffset[l], 0);
    }
    for (const VDraw& v : vdraws_) {
        const GpuMesh& m = models_[v.lod][v.model];
        if (!m.vb) continue;
        DrawU u{{m.origin[0], m.origin[1], m.origin[2], 0}, {m.scale[0], m.scale[1], 0, 0}, 1, v.first, 0, 0};
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_GPUBufferBinding vb{m.vb, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &vb, 1);
        SDL_GPUBufferBinding ib{m.ib, 0};
        SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        SDL_DrawGPUIndexedPrimitives(pass, m.idxCount, v.count, 0, 0, 0);
    }
}

} // namespace ttz
