#include "render/CharacterRenderer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr uint32_t kMaxClasses = 16;
constexpr uint32_t kCounterWords = 48;      // CC_SIZE
constexpr uint32_t kArgWords = 84;          // 16 classes * 5 (indexed or not) + pose dispatch (3) + pad
constexpr uint32_t kArgStride = 5;
constexpr uint32_t kCorpsePoses = 64;
constexpr uint32_t kLevels = 4;

struct CharUniforms {
    Vec4 planes[6];
    Vec4 cparams;   // metres per voxel, time, bounding radius, bounding centre height
    UVec4 ccfg;     // mode, capacity, class count, flags
    UVec4 ccfg2;    // forced anim, corpse capacity, occluder count
    Vec4 eye;
};
struct CharDraw {
    UVec4 draw;     // class, pose in VS
    Vec4 dparams;   // metres per voxel, time, forced anim
};

// Gribb-Hartmann frustum planes from a column-major view-projection with [0,1] depth.
void frustumPlanes(const float m[16], Vec4 out[6]) {
    auto row = [&](int r) { return std::array<float, 4>{m[r], m[4 + r], m[8 + r], m[12 + r]}; };
    auto r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    std::array<float, 4> p[6];
    for (int k = 0; k < 4; ++k) {
        p[0][k] = r3[k] + r0[k]; p[1][k] = r3[k] - r0[k];
        p[2][k] = r3[k] + r1[k]; p[3][k] = r3[k] - r1[k];
        p[4][k] = r2[k];         p[5][k] = r3[k] - r2[k];
    }
    for (int i = 0; i < 6; ++i) {
        float l = std::sqrt(p[i][0] * p[i][0] + p[i][1] * p[i][1] + p[i][2] * p[i][2]);
        out[i] = {p[i][0] / l, p[i][1] / l, p[i][2] / l, p[i][3] / l};
    }
}
} // namespace

bool CharacterRenderer::loadAsset(const std::string& path) {
    size_t size = 0;
    void* data = SDL_LoadFile(path.c_str(), &size);
    if (!data || size < 64) { SDL_Log("character asset %s not found", path.c_str()); return false; }
    const uint32_t* w = (const uint32_t*)data;
    if (w[0] != 0x435a5454u || w[1] != 2u || w[3] != kLevels) { SDL_Log("character asset %s: bad header (re-run tools/convert_characters.mjs)", path.c_str()); SDL_free(data); return false; }
    meshCount_ = w[2];
    uint32_t slots = w[9];
    const uint32_t* meshTable = w + 16 + slots * 4;
    meshTable_.assign(meshTable, meshTable + meshCount_ * kLevels * 2);
    const uint32_t* voxTable = meshTable + meshCount_ * kLevels * 2;
    meshVox_.assign(voxTable, voxTable + meshCount_ * 4);
    // slot table: baseMesh, moduleCount, stumpStates, family -> family of every mesh (meshes are stored slot by slot)
    meshFamily_.assign(meshCount_, 0);
    for (uint32_t s = 0; s < slots; ++s) {
        uint32_t base = w[16 + s * 4], next = s + 1 < slots ? w[16 + (s + 1) * 4] : meshCount_;
        for (uint32_t m = base; m < next && m < meshCount_; ++m) meshFamily_[m] = w[16 + s * 4 + 3];
    }
    const uint32_t* blob = voxTable + meshCount_ * 4;
    uint64_t total = (uint64_t)w[5] + w[6] + w[7] + w[8];
    if ((const uint8_t*)(blob + total + w[10]) > (const uint8_t*)data + size) { SDL_Log("character asset truncated"); SDL_free(data); return false; }
    words_.assign(blob, blob + total);
    tagWords_.assign(blob + total, blob + total + w[10]);
    levelBase_ = {0, w[5], w[5] + w[6], w[5] + w[6] + w[7]};
    for (uint32_t l = 0; l < kLevels; ++l) levelStats_[l] = {w[5 + l], (uint64_t)w[5 + l] * 4};
    assetBytes_ = size;
    SDL_free(data);
    SDL_Log("character asset: %u segment meshes, vertices naive %u / culled %u / greedy %u / voxel-material %u", meshCount_,
            (unsigned)levelStats_[0].vertices, (unsigned)levelStats_[1].vertices, (unsigned)levelStats_[2].vertices,
            (unsigned)levelStats_[3].vertices);
    return true;
}

// Indexed quads. The converter writes every face as two triangles (6 vertices) sharing a diagonal. Pairs are
// re-joined into 4-vertex quads in an order where the static index pattern (0,1,2)(0,2,3) reproduces exactly
// the same two triangles (same winding, same diagonal - Zombie Lab's AO diagonal rule is kept). With an index
// buffer the vertex shader runs ~4 times per face instead of 6. A level whose meshes do not all pair up
// cleanly keeps the triangle-list path.
void CharacterRenderer::buildQuads() {
    quadTable_.assign(meshCount_ * kLevels * 2, 0);
    quadWords_.clear();
    for (uint32_t level = 0; level < kLevels; ++level) {
        bool ok = true;
        size_t levelStart = quadWords_.size();
        for (uint32_t m = 0; m < meshCount_ && ok; ++m) {
            uint32_t off = levelBase_[level] + meshTable_[(m * kLevels + level) * 2], n = meshTable_[(m * kLevels + level) * 2 + 1];
            quadTable_[(m * kLevels + level) * 2] = (uint32_t)quadWords_.size();
            if (n % 6 != 0) { ok = false; break; }
            for (uint32_t f = 0; f < n; f += 6) {
                const uint32_t* t1 = &words_[off + f];
                const uint32_t* t2 = t1 + 3;
                bool found = false;
                // try every rotation of both triangles: quad (x0,x1,x2,x3) with tri A = (x0,x1,x2), tri B = (x0,x2,x3)
                for (int ab = 0; ab < 2 && !found; ++ab) {
                    const uint32_t* A = ab ? t2 : t1;
                    const uint32_t* B = ab ? t1 : t2;
                    for (int ra = 0; ra < 3 && !found; ++ra)
                        for (int rb = 0; rb < 3 && !found; ++rb) {
                            uint32_t a0 = A[ra], a1 = A[(ra + 1) % 3], a2 = A[(ra + 2) % 3];
                            uint32_t b0 = B[rb], b1 = B[(rb + 1) % 3], b2 = B[(rb + 2) % 3];
                            if (a0 == b0 && a2 == b1) {
                                quadWords_.insert(quadWords_.end(), {a0, a1, a2, b2});
                                found = true;
                            }
                        }
                }
                if (!found) { ok = false; break; }
            }
            quadTable_[(m * kLevels + level) * 2 + 1] = (uint32_t)quadWords_.size() - quadTable_[(m * kLevels + level) * 2];
        }
        quadOK_[level] = ok;
        if (!ok) quadWords_.resize(levelStart);
        SDL_Log("character geometry level %u: indexed quads %s", level, ok ? "yes" : "no (triangle lists)");
    }
}

// Size classes: draws are non-indexed with a fixed vertex count per batch, so every instance in a batch
// costs the batch's largest mesh. Geometric classes (x1.35) bound that padding at ~35 % worst case.
void CharacterRenderer::buildClasses() {
    for (uint32_t level = 0; level < kLevels; ++level)
        for (int mode = 0; mode < 2; ++mode)
        for (int idx = 0; idx < 2; ++idx) {
            if (idx && !quadOK_[level]) continue;
            ClassSet& cs = classes_[level][mode][idx];
            const uint32_t unit = idx ? 4u : 3u;       // vertices per quad / per triangle
            const std::vector<uint32_t>& table = idx ? quadTable_ : meshTable_;
            std::vector<uint32_t> counts(meshCount_);
            for (uint32_t m = 0; m < meshCount_; ++m) counts[m] = table[(m * kLevels + level) * 2 + 1];
            std::vector<uint32_t> cls(meshCount_, 0);
            if (mode == 0) {
                cs.maxVerts.assign(6, 0);
                for (uint32_t m = 0; m < meshCount_; ++m) {
                    uint32_t fam = meshFamily_[m];
                    cls[m] = fam;
                    cs.maxVerts[fam] = std::max(cs.maxVerts[fam], counts[m]);
                }
            } else {
                uint32_t lo = UINT32_MAX, hi = 0;
                for (uint32_t c : counts) if (c) { lo = std::min(lo, c); hi = std::max(hi, c); }
                std::vector<uint32_t> bounds;
                double b = lo;
                while (bounds.empty() || bounds.back() < hi) {
                    uint32_t v = (uint32_t)std::ceil(b / unit) * unit;
                    if (bounds.empty() || v > bounds.back()) bounds.push_back(v);
                    b *= 1.35;
                    if (bounds.size() == kMaxClasses - 1) { bounds.push_back(hi); break; }
                }
                bounds.back() = std::max(bounds.back(), hi);
                cs.maxVerts.assign(bounds.size(), 0);
                for (uint32_t m = 0; m < meshCount_; ++m) {
                    uint32_t k = 0;
                    while (bounds[k] < counts[m]) ++k;
                    cls[m] = k;
                    cs.maxVerts[k] = std::max(cs.maxVerts[k], counts[m]);
                }
            }
            std::vector<uint32_t> info(meshCount_ * 4);
            for (uint32_t m = 0; m < meshCount_; ++m) {
                info[m * 4 + 0] = idx ? quadTable_[(m * kLevels + level) * 2] : levelBase_[level] + meshTable_[(m * kLevels + level) * 2];
                info[m * 4 + 1] = counts[m];
                info[m * 4 + 2] = cls[m];
                info[m * 4 + 3] = cs.maxVerts[cls[m]];
            }
            cs.meshInfo = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                                             (uint32_t)(info.size() * 4), "charMeshInfo");
            gpu_->uploadNow(cs.meshInfo, info.data(), (uint32_t)(info.size() * 4));
            std::vector<uint32_t> ci(kMaxClasses, 0);
            for (size_t k = 0; k < cs.maxVerts.size(); ++k) ci[k] = cs.maxVerts[k];
            if (idx) for (uint32_t v : cs.maxVerts) maxQuadIndices_ = std::max(maxQuadIndices_, v / 4 * 6);
            cs.classInfo = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ, kMaxClasses * 4, "charClassInfo");
            gpu_->uploadNow(cs.classInfo, ci.data(), kMaxClasses * 4);
        }
}

bool CharacterRenderer::init(GpuContext& gpu, const SimParams& p, const std::string& assetPath, uint32_t visibleCapacity) {
    gpu_ = &gpu;
    scale_ = p.standHeight / 18.0f;    // the approved template is 18 voxels tall
    capacity_ = visibleCapacity;
    corpseCapacity_ = (uint32_t)p.corpseCapacity;
    if (!loadAsset(assetPath)) return false;
    pCull_ = gpu.loadCompute("char_cull", 256);
    pPrefix_ = gpu.loadCompute("char_prefix", 1);
    pPose_ = gpu.loadCompute("char_pose", 64);
    pLib_ = gpu.loadCompute("pose_library", 64);
    if (!pCull_ || !pPrefix_ || !pPose_ || !pLib_) return false;

    constexpr SDL_GPUBufferUsageFlags rw = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE |
                                           SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    verts_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(words_.size() * 4), "charVerts");
    gpu.uploadNow(verts_, words_.data(), (uint32_t)(words_.size() * 4));
    meshVoxBuf_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(meshVox_.size() * 4), "charMeshVoxels");
    gpu.uploadNow(meshVoxBuf_, meshVox_.data(), (uint32_t)(meshVox_.size() * 4));
    tagBuf_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(tagWords_.size() * 4), "charVoxelTags");
    gpu.uploadNow(tagBuf_, tagWords_.data(), (uint32_t)(tagWords_.size() * 4));
    counters_ = gpu.createBuffer(rw, kCounterWords * 4, "charCounters");
    args_ = gpu.createBuffer(rw | SDL_GPU_BUFFERUSAGE_INDIRECT, kArgWords * 4, "charArgs");
    visList_ = gpu.createBuffer(rw, capacity_ * 4, "charVisList");
    segLocal_ = gpu.createBuffer(rw, capacity_ * 10 * 4, "charSegLocal");
    segInsts_ = gpu.createBuffer(rw, capacity_ * 10 * 32, "charSegInsts");
    poseLib_ = gpu.createBuffer(rw, kCorpsePoses * 10 * 32, "corpsePoseLib");
    std::vector<uint32_t> z(std::max(kCounterWords, kArgWords), 0);
    gpu.uploadNow(counters_, z.data(), kCounterWords * 4);
    gpu.uploadNow(args_, z.data(), kArgWords * 4);
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, kCounterWords * 4, 0};
    zeros_ = SDL_CreateGPUTransferBuffer(gpu.device(), &tci);
    std::memset(SDL_MapGPUTransferBuffer(gpu.device(), zeros_, false), 0, kCounterWords * 4);
    SDL_UnmapGPUTransferBuffer(gpu.device(), zeros_);

    buildQuads();
    buildClasses();
    if (!quadWords_.empty()) {
        quadVerts_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(quadWords_.size() * 4), "charQuadVerts");
        gpu.uploadNow(quadVerts_, quadWords_.data(), (uint32_t)(quadWords_.size() * 4));
        std::vector<uint32_t> ib(maxQuadIndices_);
        const uint32_t pat[6] = {0, 1, 2, 0, 2, 3};
        for (uint32_t i = 0; i < maxQuadIndices_; ++i) ib[i] = (i / 6) * 4 + pat[i % 6];
        quadIndex_ = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_INDEX, (uint32_t)(ib.size() * 4), "charQuadIndices");
        gpu.uploadNow(quadIndex_, ib.data(), (uint32_t)(ib.size() * 4));
    }

    // graphics pipeline: no vertex buffers (vertex pulling)
    SDL_GPUShader* vs = gpu.loadShader("character.vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* fs = gpu.loadShader("character.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!vs || !fs) return false;
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_shader = vs;
    ci.fragment_shader = fs;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
    ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    ci.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;   // patched by the renderer (setSampleCount)
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = true;
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
    ci.target_info.depth_stencil_format = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
    ci.target_info.has_depth_stencil_target = true;
    ci.multisample_state.sample_count =
        SDL_GPUTextureSupportsSampleCount(gpu.device(), SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM, SDL_GPU_SAMPLECOUNT_4) ? SDL_GPU_SAMPLECOUNT_4
                                                                                                                 : SDL_GPU_SAMPLECOUNT_1;
    pDraw_ = SDL_CreateGPUGraphicsPipeline(gpu.device(), &ci);
    SDL_ReleaseGPUShader(gpu.device(), vs);
    SDL_ReleaseGPUShader(gpu.device(), fs);
    if (!pDraw_) { SDL_Log("character pipeline: %s", SDL_GetError()); return false; }

    // bake the static corpse pose library once
    CharUniforms u{};
    u.cparams = {scale_, 0, 0, 0};
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
    dispatch(Dispatch{cmd, pLib_, {}, {poseLib_}, &u, sizeof(u)}, 1);
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
    SDL_ReleaseGPUFence(gpu.device(), f);
    return true;
}

void CharacterRenderer::shutdown() {
    if (!gpu_) return;
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (auto& lv : classes_) for (auto& md : lv) for (auto& cs : md) { gpu_->releaseBuffer(cs.meshInfo); gpu_->releaseBuffer(cs.classInfo); }
    for (auto b : {&occluders_, &meshVoxBuf_, &tagBuf_, &verts_, &counters_, &args_, &visList_, &segLocal_, &segInsts_, &poseLib_, &quadVerts_, &quadIndex_}) gpu_->releaseBuffer(*b);
    for (auto p : {pCull_, pPrefix_, pPose_, pLib_}) if (p) SDL_ReleaseGPUComputePipeline(d, p);
    if (pDraw_) SDL_ReleaseGPUGraphicsPipeline(d, pDraw_);
    if (zeros_) SDL_ReleaseGPUTransferBuffer(d, zeros_);
    gpu_ = nullptr;
}

void CharacterRenderer::setOccluders(const std::vector<float>& b) {
    gpu_->releaseBuffer(occluders_);
    occluderCount_ = (uint32_t)(b.size() / 8);
    std::vector<float> data = b.empty() ? std::vector<float>(8, 0.f) : b;
    occluders_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ, (uint32_t)(data.size() * 4), "charOccluders");
    gpu_->uploadNow(occluders_, data.data(), (uint32_t)(data.size() * 4));
}

void CharacterRenderer::prepare(SDL_GPUCommandBuffer* cmd, const CrowdSim& sim, const float viewProj[16], const float eye[3], double time,
                                const CharacterSettings& cs) {
    if (!occluders_) setOccluders({});
    const ClassSet& set = classSet(cs);
    // reset counters (copy from a static zero buffer: no CPU writes per frame)
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTransferBufferLocation src{zeros_, 0};
    SDL_GPUBufferRegion dst{counters_, 0, kCounterWords * 4};
    SDL_UploadToGPUBuffer(cp, &src, &dst, false);
    SDL_EndGPUCopyPass(cp);

    CharUniforms u{};
    frustumPlanes(viewProj, u.planes);
    u.cparams = {scale_, (float)time, 2.0f, 0.9f};
    u.ccfg = {0, capacity_, (uint32_t)set.maxVerts.size(),
              (cs.frustumCull ? 1u : 0u) | (cs.poseInVertexShader ? 2u : 0u) | (cs.occlusionCull && occluderCount_ ? 4u : 0u) |
                  (indexed(cs) ? 8u : 0u)};
    u.ccfg2 = {cs.forcedAnim, corpseCapacity_, occluderCount_, sim.gibCapacity()};
    u.eye = {eye[0], eye[1], eye[2], 0};
    auto D = [&](SDL_GPUComputePipeline* p, std::initializer_list<SDL_GPUBuffer*> ro, std::initializer_list<SDL_GPUBuffer*> rw) {
        return Dispatch{cmd, p, ro, rw, &u, sizeof(u)};
    };
    auto cullRO = {sim.agents(), sim.corpses(), sim.counters(), set.meshInfo, occluders_, sim.gibs()};
    dispatchIndirect(D(pCull_, cullRO, {counters_, visList_, segLocal_}), sim.indirect(), I_AGENT_DISPATCH * 4);
    u.ccfg.x = 1;
    dispatchIndirect(D(pCull_, cullRO, {counters_, visList_, segLocal_}), sim.indirect(), I_CORPSE_DISPATCH * 4);
    u.ccfg.x = 2;                                   // flying / resting body parts
    dispatch(D(pCull_, cullRO, {counters_, visList_, segLocal_}), (sim.gibCapacity() + 255) / 256);
    u.ccfg.x = 0;
    dispatch(D(pPrefix_, {set.classInfo}, {counters_, args_}), 1);
    dispatchIndirect(D(pPose_, {sim.agents(), sim.corpses(), visList_, segLocal_, poseLib_, counters_, sim.gibs()}, {segInsts_}),
                     args_, 80 * 4);
}

void CharacterRenderer::draw(SDL_GPUCommandBuffer* cmd, SDL_GPURenderPass* pass, const CrowdSim& sim, double time,
                             const CharacterSettings& cs) {
    const ClassSet& set = classSet(cs);
    const bool quads = indexed(cs);
    SDL_BindGPUGraphicsPipeline(pass, pDraw_);
    SDL_GPUBuffer* vsb[7] = {segInsts_, quads ? quadVerts_ : verts_, set.meshInfo, counters_, sim.agents(), sim.corpses(), poseLib_};
    SDL_BindGPUVertexStorageBuffers(pass, 0, vsb, 7);
    if (quads) { SDL_GPUBufferBinding ib{quadIndex_, 0}; SDL_BindGPUIndexBuffer(pass, &ib, SDL_GPU_INDEXELEMENTSIZE_32BIT); }
    SDL_GPUBuffer* fsb[3] = {meshVoxBuf_, tagBuf_, shadowField_ ? shadowField_ : tagBuf_};
    SDL_BindGPUFragmentStorageBuffers(pass, 0, fsb, 3);
    for (uint32_t c = 0; c < set.maxVerts.size(); ++c) {
        CharDraw d{};
        d.draw = {c, cs.poseInVertexShader ? 1u : 0u, 0, 0};
        d.dparams = {scale_, (float)time, (float)cs.forcedAnim, 0};
        SDL_PushGPUVertexUniformData(cmd, 1, &d, sizeof(d));
        if (quads) SDL_DrawGPUIndexedPrimitivesIndirect(pass, args_, c * kArgStride * 4, 1);
        else SDL_DrawGPUPrimitivesIndirect(pass, args_, c * kArgStride * 4, 1);
    }
}

CharacterStats CharacterRenderer::parseCounters(const uint32_t* cc) {
    CharacterStats s;
    s.visible = cc[0]; s.overflow = cc[1]; s.triangles = cc[2]; s.segments = cc[3];
    s.visibleAgents = cc[4]; s.visibleCorpses = cc[5]; s.vsInvocations = cc[6]; s.occluded = cc[7]; s.visibleGibs = cc[8];
    return s;
}

bool CharacterRenderer::readStatsNow(CharacterStats& out) {
    uint32_t cc[kCounterWords];
    if (!gpu_->downloadNow(counters_, cc, sizeof(cc))) return false;
    out = parseCounters(cc);
    return true;
}

} // namespace ttz
