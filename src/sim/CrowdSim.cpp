#include "sim/CrowdSim.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr SDL_GPUBufferUsageFlags kStorage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ |
                                             SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE |
                                             SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
uint32_t groups(uint32_t n, uint32_t g) { return (n + g - 1) / g; }
} // namespace

bool CrowdSim::createPipelines() {
    struct { SDL_GPUComputePipeline** p; const char* n; } list[] = {
        {&pSpawn_, "sim_spawn"}, {&pCorpseBlast_, "sim_corpse_blast"}, {&pCommitAppend_, "sim_commit_append"},
        {&pClear_, "sim_clear"}, {&pPredict_, "sim_predict"}, {&pScanLocal_, "scan_local"},
        {&pScanBlocks_, "scan_blocks"}, {&pScanAdd_, "scan_add"}, {&pScatter_, "sim_scatter"},
        {&pCommitSort_, "sim_commit_sort"}, {&pSolve_, "sim_solve"}, {&pFinalize_, "sim_finalize"},
        {&pDensity_, "sim_density"}, {&pNavRelax_, "nav_relax"}, {&pNavDir_, "nav_dir"}, {&pDrawArgs_, "sim_draw_args"}};
    for (auto& e : list) {
        // every per-agent pass shares the 256-wide indirect dispatch args
        *e.p = gpu_->loadCompute(e.n, std::string(e.n).rfind("nav_", 0) == 0 ? 16 : (std::string(e.n).find("commit") != std::string::npos || std::string(e.n) == "sim_draw_args") ? 1 : 256);
        if (!*e.p) return false;
    }
    return true;
}

bool CrowdSim::init(GpuContext& gpu, const SimParams& p, const Sandbox& sb) {
    gpu_ = &gpu;
    p_ = p;
    if (!createPipelines()) return false;
    const uint32_t cap = (uint32_t)p_.agentCapacity;
    const uint32_t cells = numCells();
    const uint32_t blocks = groups(cells + 1, 256);
    auto mk = [&](uint32_t size, const char* name) { return gpu_->createBuffer(kStorage, size, name); };
    agentsA_ = mk(cap * sizeof(GpuAgent), "agentsA");
    agentsB_ = mk(cap * sizeof(GpuAgent), "agentsB");
    posP_ = mk(cap * 16, "posP");
    posQ_ = mk(cap * 16, "posQ");
    prevS_ = mk(cap * 16, "prevSorted");
    contactAux_ = mk(cap * 16, "contactAux");
    cellLocal_ = mk(cap * 8, "cellLocal");
    cellCount_ = mk((cells + 1) * 4, "cellCount");
    cellStart_ = mk((cells + 1) * 4, "cellStart");
    blockSums_ = mk(std::max(blocks, 256u) * 4, "blockSums");
    density_ = mk(cells * 16, "density");
    staticH_ = mk(cells * 4, "staticH");
    corpseH_ = mk(cells * 4, "corpseH");
    navDist_[0] = mk(cells * 4, "navDist0");
    navDist_[1] = mk(cells * 4, "navDist1");
    navDir_ = mk(cells * 8, "navDir");
    corpses_ = mk((uint32_t)p_.corpseCapacity * sizeof(GpuCorpse), "corpses");
    counters_ = mk(C_COUNT * 4, "counters");
    indirect_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_INDIRECT | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ |
                                       SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE,
                                   I_COUNT * 4, "indirect");
    for (auto& r : rb_) {
        SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, C_COUNT * 4 + 256, 0};
        r.tb = SDL_CreateGPUTransferBuffer(gpu_->device(), &tci);
    }
    if (!agentsA_ || !corpses_ || !indirect_) return false;
    reset(sb);
    return true;
}

void CrowdSim::shutdown() {
    if (!gpu_) return;
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (auto& r : rb_) {
        if (r.fence) SDL_ReleaseGPUFence(d, r.fence);
        if (r.tb) SDL_ReleaseGPUTransferBuffer(d, r.tb);
        r = {};
    }
    SDL_GPUBuffer** bufs[] = {&agentsA_, &agentsB_, &posP_, &posQ_, &prevS_, &contactAux_, &cellLocal_, &cellCount_,
                              &cellStart_, &blockSums_, &density_, &staticH_, &corpseH_, &navDist_[0], &navDist_[1],
                              &navDir_, &corpses_, &counters_, &indirect_};
    for (auto b : bufs) gpu_->releaseBuffer(*b);
    SDL_GPUComputePipeline** pipes[] = {&pSpawn_, &pCorpseBlast_, &pCommitAppend_, &pClear_, &pPredict_, &pScanLocal_,
                                        &pScanBlocks_, &pScanAdd_, &pScatter_, &pCommitSort_, &pSolve_, &pFinalize_,
                                        &pDensity_, &pNavRelax_, &pNavDir_, &pDrawArgs_};
    for (auto p : pipes) {
        if (*p) SDL_ReleaseGPUComputePipeline(d, *p);
        *p = nullptr;
    }
    gpu_ = nullptr;
}

void CrowdSim::reset(const Sandbox& sb) {
    sandbox_ = sb;
    const uint32_t cells = numCells();
    std::vector<uint8_t> zeros((size_t)std::max<uint32_t>(cells * 16, C_COUNT * 4), 0);
    gpu_->uploadNow(counters_, zeros.data(), C_COUNT * 4);
    gpu_->uploadNow(density_, zeros.data(), cells * 16);
    gpu_->uploadNow(corpseH_, zeros.data(), cells * 4);
    gpu_->uploadNow(navDir_, zeros.data(), cells * 8);
    std::vector<float> big(cells, 1.0e7f);
    gpu_->uploadNow(navDist_[0], big.data(), cells * 4);
    gpu_->uploadNow(navDist_[1], big.data(), cells * 4);
    std::vector<float> h = sb.rasterize();
    gpu_->uploadNow(staticH_, h.data(), cells * 4);
    uint32_t ind[I_COUNT] = {};
    ind[I_AGENT_DISPATCH] = ind[I_AGENT_DISPATCH + 1] = ind[I_AGENT_DISPATCH + 2] = 1;
    ind[I_CORPSE_DISPATCH] = ind[I_CORPSE_DISPATCH + 1] = ind[I_CORPSE_DISPATCH + 2] = 1;
    gpu_->uploadNow(indirect_, ind, sizeof(ind));
    pendingSpawns_.clear();
    pendingExplosions_.clear();
    simTime_ = 0.0;
    stepIndex_ = 0;
    stats_ = {};
}

void CrowdSim::requestSpawn(const Rect& r, uint32_t count) {
    if (count > 0) pendingSpawns_.push_back({r, count});
}

void CrowdSim::requestSpawnLook(const Rect& r, uint32_t count, uint32_t lookX, uint32_t lookY, bool asCorpse) {
    if (count > 0) pendingSpawns_.push_back({r, count, lookX, lookY, true, asCorpse});
}

void CrowdSim::requestSpawnCorpses(const Rect& r, uint32_t count) {
    if (count > 0) pendingSpawns_.push_back({r, count, 0, 0, false, true});
}

void CrowdSim::requestExplosion(float x, float y, float z) {
    if (pendingExplosions_.size() < (size_t)kMaxExplosions) pendingExplosions_.push_back({x, y, z});
}

void CrowdSim::setGoals(const std::vector<float>& xz) {
    goals_ = xz;
    if (goals_.size() > 2 * kMaxGoals) goals_.resize(2 * kMaxGoals);
}

SimUniforms CrowdSim::baseUniforms() const {
    SimUniforms u{};
    u.world = {sandbox_.originX, sandbox_.originZ, p_.cellSize, 1.0f / p_.cellSize};
    u.grid = {(uint32_t)p_.gridW, (uint32_t)p_.gridH, numCells(), (uint32_t)p_.agentCapacity};
    u.timeP = {p_.fixedDt, (float)simTime_, (float)(stepIndex_ & 0xFFFFFF), (float)p_.solverIterations};
    u.agentP = {p_.radius, p_.standHeight, p_.proneHeight, p_.baseSpeed};
    u.moveP = {p_.accel, p_.gravity, p_.climbSpeed, p_.stepUp};
    u.crowdP = {p_.densityComfort, p_.densityMax, p_.minSpeedFactor, p_.lookAhead};
    u.solverP = {p_.sor, p_.stiffness, p_.massScaleK, p_.friction};
    u.climbP = {p_.verticalEnabled ? 1.f : 0.f, p_.climbBlockThreshold, p_.supportCos, p_.climbMaxTime};
    u.corpseP = {p_.corpsesEnabled ? 1.f : 0.f, p_.corpseSplatHeight, p_.corpseSettleSpeed, (float)p_.corpseCapacity};
    u.navP = {p_.navDensityWeight, p_.navClimbWeight, p_.navClimbLimit, p_.goalRadius};
    uint32_t ng = 0;
    for (size_t i = 0; i + 1 < goals_.size() && ng < (uint32_t)kMaxGoals; i += 2, ++ng)
        u.goals[ng] = {goals_[i], 0.f, goals_[i + 1], 1.f};
    u.counts = {ng, 0, 0, spawnSeed_};
    u.misc = {(uint32_t)p_.maxNeighbors, 0, 0,
              (p_.verticalEnabled ? FLAG_VERTICAL : 0u) | (p_.corpsesEnabled ? FLAG_CORPSES : 0u)};
    u.extraP = {p_.maxSpeed, p_.wander, p_.proneRate, p_.crawlSpeed};
    u.lookA = {p_.lookRecent, p_.lookClothed, p_.lookLight, p_.lookHeavy};
    u.lookB = {p_.lookSkeletal, p_.lookMissing, 0.f, 0.f};
    return u;
}

void CrowdSim::step(SDL_GPUCommandBuffer* cmd) {
    SimUniforms u = baseUniforms();
    const uint32_t cells = numCells();
    const uint32_t blocks = groups(cells + 1, 256);
    const uint32_t U = sizeof(SimUniforms);
    auto D = [&](SDL_GPUComputePipeline* p, std::initializer_list<SDL_GPUBuffer*> ro,
                 std::initializer_list<SDL_GPUBuffer*> rw) { return Dispatch{cmd, p, ro, rw, &u, U}; };

    // explosions for this step
    uint32_t ne = (uint32_t)pendingExplosions_.size();
    for (uint32_t e = 0; e < ne; ++e) {
        auto& x = pendingExplosions_[e];
        u.explo[e] = {x[0], x[1], x[2], p_.explosionRadius};
        u.exploP[e] = {p_.explosionStrength, p_.explosionLethality, p_.explosionUpBias, 1.f};
    }
    u.counts.y = ne;
    pendingExplosions_.clear();

    // 1. appends: spawn requests and corpse reactivation
    if (!pendingSpawns_.empty()) {
        SpawnRequest req = pendingSpawns_.front();
        pendingSpawns_.erase(pendingSpawns_.begin());
        u.counts.z = req.count;
        u.spawnRect = {req.rect.minX, req.rect.minZ, req.rect.maxX, req.rect.maxZ};
        u.counts.w = spawnSeed_++;
        u.forcedLook = {req.lookX, req.lookY, req.forced ? 1u : 0u, 0};
        u.lookB.z = req.corpse ? 1.f : 0.f;
        dispatch(D(pSpawn_, {staticH_}, {agentsA_, counters_}), groups(req.count, 256));
        u.counts.z = 0;
        u.forcedLook = {};
        u.lookB.z = 0.f;
    }
    if (ne > 0 && p_.corpsesEnabled)
        dispatchIndirect(D(pCorpseBlast_, {staticH_}, {corpses_, agentsA_, corpseH_, counters_}), indirect_,
                         I_CORPSE_DISPATCH * 4);
    dispatch(D(pCommitAppend_, {}, {counters_, indirect_}), 1);

    // 2. predict + histogram
    dispatch(D(pClear_, {}, {cellCount_}), groups(cells + 1, 256));
    dispatchIndirect(D(pPredict_, {navDir_, density_, staticH_, corpseH_}, {agentsA_, cellCount_, cellLocal_, counters_}),
                     indirect_, I_AGENT_DISPATCH * 4);

    // 3. counting sort: prefix sum + scatter (dead agents fall into the graveyard bucket and vanish)
    dispatch(D(pScanLocal_, {cellCount_}, {cellStart_, blockSums_}), blocks);
    u.misc.y = blocks;
    dispatch(D(pScanBlocks_, {}, {blockSums_}), 1);
    u.misc.y = 0;
    dispatch(D(pScanAdd_, {blockSums_}, {cellStart_}), blocks);
    dispatchIndirect(D(pScatter_, {agentsA_, cellLocal_, cellStart_, counters_}, {agentsB_, posP_, prevS_}), indirect_,
                     I_AGENT_DISPATCH * 4);
    dispatch(D(pCommitSort_, {cellStart_}, {counters_, indirect_}), 1);

    // 4. constraint iterations (Jacobi, ping-pong)
    SDL_GPUBuffer* in = posP_;
    SDL_GPUBuffer* out = posQ_;
    const int iters = std::max(1, p_.solverIterations);
    for (int it = 0; it < iters; ++it) {
        u.misc.y = (it == iters - 1) ? 1u : 0u;
        dispatchIndirect(D(pSolve_, {in, prevS_, cellStart_, cellCount_, staticH_, corpseH_, counters_}, {out, contactAux_}),
                         indirect_, I_AGENT_DISPATCH * 4);
        std::swap(in, out);
    }
    u.misc.y = 0;
    SDL_GPUBuffer* posFinal = in;

    // 5. finalize (velocities, states, corpses) -> agentsA stays sorted
    dispatchIndirect(D(pFinalize_, {agentsB_, posFinal, contactAux_, staticH_}, {agentsA_, corpses_, corpseH_, counters_}),
                     indirect_, I_AGENT_DISPATCH * 4);

    // 6. fields: density + navigation
    dispatch(D(pDensity_, {cellStart_, cellCount_, posFinal}, {density_}), groups(cells, 256));
    const uint32_t gx = groups(p_.gridW, 16), gy = groups(p_.gridH, 16);
    for (int it = 0; it < std::max(1, p_.navIterationsPerStep); ++it) {
        for (uint32_t parity = 0; parity < 2; ++parity) {   // red-black Gauss-Seidel, in place
            u.misc.y = parity;
            dispatch(D(pNavRelax_, {staticH_, corpseH_, density_}, {navDist_[0]}), gx, gy);
        }
    }
    u.misc.y = 0;
    dispatch(D(pNavDir_, {navDist_[0]}, {navDir_}), gx, gy);

    simTime_ += p_.fixedDt;
    ++stepIndex_;
}

void CrowdSim::writeDrawArgs(SDL_GPUCommandBuffer* cmd, uint32_t zombieIndexCount) {
    SimUniforms u = baseUniforms();
    u.misc.z = zombieIndexCount;
    dispatch(Dispatch{cmd, pDrawArgs_, {counters_}, {indirect_}, &u, sizeof(u)}, 1);
}

void CrowdSim::recordStatsReadback(SDL_GPUCommandBuffer* cmd) {
    SDL_GPUDevice* d = gpu_->device();
    // harvest finished slots
    for (auto& r : rb_) {
        if (r.recorded && r.fence && SDL_QueryGPUFence(d, r.fence)) {
            uint32_t c[C_COUNT];
            void* p = SDL_MapGPUTransferBuffer(d, r.tb, false);
            std::memcpy(c, p, sizeof(c));
            if (extraBytes_ && r.frame >= stats_.frameOfData) std::memcpy(extra_.data(), (uint8_t*)p + C_COUNT * 4, std::min<uint32_t>(extraBytes_, 256));
            SDL_UnmapGPUTransferBuffer(d, r.tb);
            if (r.frame >= stats_.frameOfData) {
                stats_.live = c[C_LIVE];
                stats_.corpses = std::min<uint32_t>(c[C_CORPSES], (uint32_t)p_.corpseCapacity);
                stats_.deaths = c[C_DEATHS_TOTAL];
                stats_.climbing = c[C_CLIMBING];
                stats_.airborne = c[C_AIRBORNE];
                stats_.elevated = c[C_ELEVATED];
                stats_.reactivated = c[C_REACTIVATED];
                stats_.corpseOverflow = c[C_CORPSE_OVERFLOW];
                stats_.maxStackHeight = c[C_MAX_HEIGHT_MM] * 0.001f;
                stats_.frameOfData = r.frame;
            }
            SDL_ReleaseGPUFence(d, r.fence);
            r.fence = nullptr;
            r.recorded = false;
        }
    }
    rbRecordSlot_ = -1;
    for (int i = 0; i < (int)rb_.size(); ++i)
        if (!rb_[i].recorded) { rbRecordSlot_ = i; break; }
    ++frameCounter_;
    if (rbRecordSlot_ < 0) return;   // all in flight: skip this frame, never stall
    Readback& r = rb_[rbRecordSlot_];
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUBufferRegion src{counters_, 0, C_COUNT * 4};
    SDL_GPUTransferBufferLocation dst{r.tb, 0};
    SDL_DownloadFromGPUBuffer(cp, &src, &dst);
    if (extraBuf_) {
        SDL_GPUBufferRegion src2{extraBuf_, 0, std::min<uint32_t>(extraBytes_, 256)};
        SDL_GPUTransferBufferLocation dst2{r.tb, C_COUNT * 4};
        SDL_DownloadFromGPUBuffer(cp, &src2, &dst2);
    }
    SDL_EndGPUCopyPass(cp);
    r.recorded = true;
    r.frame = frameCounter_;
}

void CrowdSim::onFrameSubmitted(SDL_GPUFence* fence) {
    if (rbRecordSlot_ >= 0 && fence) {
        rb_[rbRecordSlot_].fence = fence;
        rbRecordSlot_ = -1;
    } else if (fence) {
        SDL_ReleaseGPUFence(gpu_->device(), fence);
    } else if (rbRecordSlot_ >= 0) {
        rb_[rbRecordSlot_].recorded = false;   // submitted without a fence: discard this slot
        rbRecordSlot_ = -1;
    }
}

} // namespace ttz
