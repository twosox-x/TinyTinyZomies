// HordeBridge: GPU side of the gameplay <-> horde coupling (WS-A). See HordeBridge.h for the pass list and
// docs/GAMEPLAY_ARCHITECTURE.md 3.3 for the design. Everything is bounded (soldiers, hits, attractors, kill records,
// tiles) and asynchronous (3-slot readback ring released by CrowdSim's frame fences): no per-zombie CPU work, no waits.
#include "game/HordeBridge.h"

#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz::game {

namespace {
static_assert(kMaxGpuSoldiers == kGameMaxSoldiers && kMaxKillsPerFrame == kGameKillCap, "GpuTypes.h and HordeInterface.h disagree");
constexpr SDL_GPUBufferUsageFlags kStorage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
uint32_t groups(uint32_t n, uint32_t g) { return (n + g - 1) / g; }
// upload transfer buffer layout
constexpr uint32_t kUpSoldiers = 0;
constexpr uint32_t kUpHits = kUpSoldiers + kMaxGpuSoldiers * (uint32_t)sizeof(GpuSoldier);
constexpr uint32_t kUpAttr = kUpHits + kMaxHitsPerTick * (uint32_t)sizeof(GpuHitRequest);
constexpr uint32_t kUpBytes = kUpAttr + kMaxAttractors * 32;
// readback slot layout
constexpr uint32_t kRbKills = 0, kKillBytes = kGameKillWords * 4;
constexpr uint32_t kRbHits = kRbKills + kKillBytes, kHitResBytes = kMaxHitsPerTick * 8;
constexpr uint32_t kRbContacts = kRbHits + kHitResBytes, kContactBytes = kMaxGpuSoldiers * 16;
constexpr uint32_t kRbField = kRbContacts + kContactBytes;
uint32_t fieldBytes(uint32_t tiles) { return tiles * 4 + tiles * kFieldSamples * 16; }
double msSince(uint64_t t0) { return (double)(SDL_GetPerformanceCounter() - t0) * 1000.0 / (double)SDL_GetPerformanceFrequency(); }
} // namespace

bool HordeBridge::init(GpuContext& gpu, CrowdSim& sim) {
    gpu_ = &gpu;
    sim_ = &sim;
    pStamp_ = gpu.loadCompute("game_stamp", 64);
    pHits_ = gpu.loadCompute("game_hits", 64);
    pAttract_ = gpu.loadCompute("game_attract", 64);
    pField_ = gpu.loadCompute("game_field", 256);
    pContacts_ = gpu.loadCompute("game_contacts", 64);
    if (!pStamp_ || !pHits_ || !pAttract_ || !pField_ || !pContacts_) { shutdown(); return false; }
    const SimParams& p = sim.params();
    tilesX_ = (uint32_t)(p.gridW + (int)kFieldTileCells - 1) / kFieldTileCells;
    tilesZ_ = (uint32_t)(p.gridH + (int)kFieldTileCells - 1) / kFieldTileCells;
    const uint32_t tiles = tilesX_ * tilesZ_;
    hitReq_ = gpu.createBuffer(kStorage, kMaxHitsPerTick * sizeof(GpuHitRequest), "gameHitReq");
    hitRes_ = gpu.createBuffer(kStorage, kHitResBytes, "gameHitRes");
    stamped_ = gpu.createBuffer(kStorage, kMaxGpuSoldiers * 4, "gameStamped");
    attrBuf_ = gpu.createBuffer(kStorage, kMaxAttractors * 32, "gameAttractors");
    fieldBuf_ = gpu.createBuffer(kStorage, fieldBytes(tiles), "gameField");
    contactBuf_ = gpu.createBuffer(kStorage, kContactBytes, "gameContacts");
    SDL_GPUTransferBufferCreateInfo up{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, kUpBytes, 0};
    upload_ = SDL_CreateGPUTransferBuffer(gpu.device(), &up);
    for (Slot& s : ring_) {
        SDL_GPUTransferBufferCreateInfo dn{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, kRbField + fieldBytes(tiles), 0};
        s.tb = SDL_CreateGPUTransferBuffer(gpu.device(), &dn);
        if (!s.tb) { shutdown(); return false; }
    }
    if (!hitReq_ || !hitRes_ || !stamped_ || !attrBuf_ || !fieldBuf_ || !contactBuf_ || !upload_) { shutdown(); return false; }
    std::vector<uint32_t> none(kMaxGpuSoldiers, kGameNoSeed);
    gpu.uploadNow(stamped_, none.data(), kMaxGpuSoldiers * 4);
    std::vector<uint32_t> zero(tiles, 0u);
    gpu.uploadNow(fieldBuf_, zero.data(), tiles * 4);
    field_.tilesX = tilesX_;
    field_.tilesZ = tilesZ_;
    field_.tileSize = p.cellSize * (float)kFieldTileCells;
    field_.tiles.assign(tiles, ZombieFieldTile{});
    return true;
}

void HordeBridge::shutdown() {
    if (gpu_) {
        SDL_GPUDevice* d = gpu_->device();
        SDL_WaitForGPUIdle(d);
        if (sim_) sim_->setGameInputs(0, 0.f);
        for (Slot& s : ring_) {
            if (s.tb) SDL_ReleaseGPUTransferBuffer(d, s.tb);
            s = Slot{};
        }
        if (upload_) SDL_ReleaseGPUTransferBuffer(d, upload_);
        upload_ = nullptr;
        SDL_GPUBuffer** bufs[] = {&hitReq_, &hitRes_, &stamped_, &attrBuf_, &fieldBuf_, &contactBuf_};
        for (auto b : bufs) gpu_->releaseBuffer(*b);
        SDL_GPUComputePipeline** pipes[] = {&pStamp_, &pHits_, &pAttract_, &pField_, &pContacts_};
        for (auto p : pipes) {
            if (*p) SDL_ReleaseGPUComputePipeline(d, *p);
            *p = nullptr;
        }
    }
    soldiers_.clear(); hits_.clear(); attractors_.clear(); contacts_.clear(); kills_.clear(); hitResults_.clear();
    gpu_ = nullptr; sim_ = nullptr;
}

void HordeBridge::reset() {
    hits_.clear(); kills_.clear(); contacts_.clear(); hitResults_.clear();
    const uint32_t tiles = tilesX_ * tilesZ_;
    field_ = ZombieField{};
    field_.tilesX = tilesX_;
    field_.tilesZ = tilesZ_;
    if (sim_) field_.tileSize = sim_->params().cellSize * (float)kFieldTileCells;
    field_.tiles.assign(tiles, ZombieFieldTile{});
    for (Slot& s : ring_) s.pending = false;   // kill seq continues (GPU counter and lastKillSeq_ are kept)
    seedsDirty_ = true;
}

void HordeBridge::preSim(SDL_GPUCommandBuffer* cmd) {
    if (!sim_ || !upload_) return;
    const uint64_t t0 = SDL_GetPerformanceCounter();
    SDL_GPUDevice* d = gpu_->device();
    const SimParams& p = sim_->params();
    const uint32_t cells = sim_->numCells();

    // ---- inputs of this frame ----------------------------------------------------------------------------------
    const uint32_t nS = (uint32_t)std::min<size_t>(soldiers_.size(), kMaxGpuSoldiers);
    // rounds need the cell lists of the last step; after a window move (or before the first step) they wait a frame
    if (hits_.size() > 4 * (size_t)kMaxHitsPerTick) hits_.erase(hits_.begin(), hits_.end() - 4 * (size_t)kMaxHitsPerTick);
    const uint32_t nH = sim_->cellGridValid() ? (uint32_t)std::min<size_t>(hits_.size(), kMaxHitsPerTick) : 0u;
    // attractors: strongest kMaxAttractors with a positive reach
    struct A { const Attractor* a; float reach; };
    std::vector<A> at;
    at.reserve(attractors_.size());
    for (const Attractor& a : attractors_) {
        float reach = (a.awareness > 0.f ? a.awareness : awareness_) * std::clamp(a.strength, 0.f, 4.f);
        if (reach > 0.f && std::isfinite(a.pos.x) && std::isfinite(a.pos.z)) at.push_back({&a, reach});
    }
    if (at.size() > kMaxAttractors) {
        std::nth_element(at.begin(), at.begin() + kMaxAttractors, at.end(), [](const A& x, const A& y) { return x.reach > y.reach; });
        at.resize(kMaxAttractors);
    }
    const uint32_t nA = (uint32_t)at.size();
    if (nA) {
        float g = awareness_;
        for (const A& a : at) g = std::max(g, a.reach);
        gate_ = g;   // sticky once set: stale flow left by vanished attractors is gated as its distance rises
    }

    auto* up = (uint8_t*)SDL_MapGPUTransferBuffer(d, upload_, true);   // cycle: the GPU may still read last frame's
    if (!up) return;
    frameIds_.resize(nS);
    for (uint32_t i = 0; i < nS; ++i) {
        const HordeSoldier& s = soldiers_[i];
        GpuSoldier g;
        g.posR = {s.pos.x, s.pos.y, s.pos.z, std::max(s.radius, 0.05f)};
        float idBits;
        std::memcpy(&idBits, &s.packedId, 4);
        g.info = {std::max(s.height, 0.2f), s.attraction, idBits, 0.f};
        std::memcpy(up + kUpSoldiers + i * sizeof(GpuSoldier), &g, sizeof(g));
        frameIds_[i] = s.packedId;
    }
    frameShooters_.resize(nH);
    for (uint32_t i = 0; i < nH; ++i) {
        const HitRequest& h = hits_[i];
        V3 dir = h.dir;
        float l = std::sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
        dir = l > 1e-6f ? V3{dir.x / l, dir.y / l, dir.z / l} : V3{0, 0, 1};
        GpuHitRequest g;
        g.o = {h.origin.x, h.origin.y, h.origin.z, std::max(h.maxDist, 0.f)};
        g.d = {dir.x, dir.y, dir.z, std::max(h.damage, 0.f)};
        g.info = {h.shooterPacked, h.flags, 0, 0};
        std::memcpy(up + kUpHits + i * sizeof(GpuHitRequest), &g, sizeof(g));
        frameShooters_[i] = h.shooterPacked;
    }
    for (uint32_t i = 0; i < nA; ++i) {
        const Attractor& a = *at[i].a;
        float g[8] = {a.pos.x, a.pos.y, a.pos.z, std::clamp(a.radius, 0.75f, 8.f), gate_ - at[i].reach, 0, 0, 0};
        std::memcpy(up + kUpAttr + i * 32, g, 32);
    }
    SDL_UnmapGPUTransferBuffer(d, upload_);
    if (nS || nH || nA) {
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        auto put = [&](uint32_t off, SDL_GPUBuffer* dst, uint32_t bytes) {
            if (!bytes) return;
            SDL_GPUTransferBufferLocation src{upload_, off};
            SDL_GPUBufferRegion r{dst, 0, bytes};
            SDL_UploadToGPUBuffer(cp, &src, &r, false);
        };
        put(kUpSoldiers, sim_->gameSolid(), nS * (uint32_t)sizeof(GpuSoldier));
        put(kUpHits, hitReq_, nH * (uint32_t)sizeof(GpuHitRequest));
        put(kUpAttr, attrBuf_, nA * 32);
        SDL_EndGPUCopyPass(cp);
    }

    SimUniforms u = sim_->uniforms();
    const uint32_t U = sizeof(SimUniforms);
    // ---- soldier colliders: clear last frame's cells, stamp this frame's -------------------------------------------
    if (prevStamped_) {
        u.misc.y = 0; u.misc.z = prevStamped_;
        dispatch(Dispatch{cmd, pStamp_, {}, {sim_->gameSolid(), stamped_}, &u, U}, groups(prevStamped_, 64));
    }
    if (nS) {
        u.misc.y = 1; u.misc.z = nS;
        dispatch(Dispatch{cmd, pStamp_, {}, {sim_->gameSolid(), stamped_}, &u, U}, groups(nS, 64));
    }
    prevStamped_ = nS;
    // ---- rounds ------------------------------------------------------------------------------------------------
    if (nH) {
        u.misc.y = 0; u.misc.z = nH;
        dispatch(Dispatch{cmd, pHits_, {hitReq_, sim_->agents(), sim_->cellStart(), sim_->cellCount(), sim_->staticHeight(), sim_->counters()},
                          {sim_->gameIO(), hitRes_}, &u, U},
                 groups(nH, 64));
        hits_.erase(hits_.begin(), hits_.begin() + nH);
    }
    frameHits_ = nH;
    frameSoldiers_ = nS;
    st_.hitsQueued = nH;
    st_.hitsTotal += nH;
    // ---- attractor sources for the navigation field ----------------------------------------------------------------
    if (nA || seedsDirty_) {
        sim_->fillBuffer(cmd, sim_->navSeed(), 0, cells, kGameNoSeed);
        if (nA) {
            float maxR = 0.75f;
            for (const A& a : at) maxR = std::max(maxR, std::clamp(a.a->radius, 0.75f, 8.f));
            uint32_t side = 2u * (uint32_t)std::ceil(maxR / p.cellSize) + 2u;
            u.misc.y = 0; u.misc.z = side; u.counts.x = nA;
            dispatch(Dispatch{cmd, pAttract_, {attrBuf_, sim_->staticHeight()}, {sim_->navSeed()}, &u, U}, groups(side * side, 64), nA);
        }
        seedsDirty_ = nA > 0;
    }
    sim_->setGameInputs(GAME_HITS | (nS ? GAME_SOLDIERS : 0u) | (nA ? GAME_SEEDS : 0u), gate_);
    st_.cpuMs = msSince(t0);
}

void HordeBridge::postSim(SDL_GPUCommandBuffer* cmd, uint64_t frameIndex) {
    if (!sim_ || !upload_) return;
    const uint64_t t0 = SDL_GetPerformanceCounter();
    const uint32_t tiles = tilesX_ * tilesZ_;
    const bool grid = sim_->cellGridValid();
    SimUniforms u = sim_->uniforms();
    const uint32_t U = sizeof(SimUniforms);
    if (grid) {   // ---- coarse field, then contacts (which read it) ---------------------------------------------------
        u.counts.x = tilesX_; u.counts.z = tiles;
        u.misc.y = 0;
        dispatch(Dispatch{cmd, pField_, {sim_->agents(), sim_->counters()}, {fieldBuf_}, &u, U}, groups(tiles, 256));
        u.misc.y = 1;
        dispatchIndirect(Dispatch{cmd, pField_, {sim_->agents(), sim_->counters()}, {fieldBuf_}, &u, U}, sim_->indirect(), I_AGENT_DISPATCH * 4);
        if (frameSoldiers_) {
            u.misc.y = 0; u.misc.z = frameSoldiers_;
            u.extraP.x = attackReach_; u.extraP.y = nearbyRadius_;
            dispatch(Dispatch{cmd, pContacts_, {sim_->gameSolid(), sim_->agents(), sim_->cellStart(), sim_->cellCount(), sim_->counters(), fieldBuf_},
                              {contactBuf_}, &u, U},
                     groups(frameSoldiers_, 64));
        }
    }
    // ---- readback slot (skip when all are in flight: kill records stay in the GPU ring for the next frame) ----------
    int si = -1;
    for (int i = 0; i < (int)ring_.size(); ++i)
        if (!ring_[i].pending) { si = i; break; }
    if (si < 0) { ++st_.slotsSkipped; st_.cpuMs += msSince(t0); return; }
    Slot& s = ring_[si];
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    auto get = [&](SDL_GPUBuffer* src, uint32_t bytes, uint32_t dstOff) {
        if (!bytes) return;
        SDL_GPUBufferRegion r{src, 0, bytes};
        SDL_GPUTransferBufferLocation dst{s.tb, dstOff};
        SDL_DownloadFromGPUBuffer(cp, &r, &dst);
    };
    get(sim_->gameIO(), kKillBytes, kRbKills);
    get(hitRes_, frameHits_ * 8, kRbHits);
    if (grid) {
        get(contactBuf_, frameSoldiers_ * 16, kRbContacts);
        get(fieldBuf_, fieldBytes(tiles), kRbField);
    }
    SDL_EndGPUCopyPass(cp);
    sim_->fillBuffer(cmd, sim_->gameIO(), 0, 1, 0u);   // records copied: the ring restarts (seq counter continues)
    s.frame = sim_->recordingFrame();
    s.pending = true;
    s.hasGrid = grid;
    s.nSoldiers = grid ? frameSoldiers_ : 0;
    s.nHits = frameHits_;
    s.tilesX = tilesX_; s.tilesZ = tilesZ_;
    s.originX = sim_->originX(); s.originZ = sim_->originZ();
    s.ids.assign(frameIds_.begin(), frameIds_.begin() + s.nSoldiers);
    s.shooters.assign(frameShooters_.begin(), frameShooters_.begin() + frameHits_);
    frameHits_ = 0;
    st_.cpuMs += msSince(t0);
}

void HordeBridge::harvest() {
    if (!sim_ || !upload_) return;
    const uint64_t t0 = SDL_GetPerformanceCounter();
    if (sync_) SDL_WaitForGPUIdle(gpu_->device());
    sim_->pollFences();
    const uint64_t done = sim_->lastCompletedFrame();
    st_.killsHarvested = 0;
    for (;;) {   // oldest finished slot first: kill seqs then arrive in increasing order
        int best = -1;
        for (int i = 0; i < (int)ring_.size(); ++i)
            if (ring_[i].pending && ring_[i].frame <= done && (best < 0 || ring_[i].frame < ring_[best].frame)) best = i;
        if (best < 0) break;
        parseSlot(best);
    }
    st_.cpuMs += msSince(t0);
}

void HordeBridge::parseSlot(int si) {
    Slot& s = ring_[si];
    SDL_GPUDevice* d = gpu_->device();
    const auto* b = (const uint8_t*)SDL_MapGPUTransferBuffer(d, s.tb, false);
    s.pending = false;
    if (!b) return;
    // kills: sort by seq (append order on the GPU is arbitrary), drop anything already seen
    uint32_t hdr[kGameKillHeader];
    std::memcpy(hdr, b + kRbKills, sizeof(hdr));
    const uint32_t n = std::min(hdr[0], kGameKillCap);
    killsOverflowed_ = std::max<uint64_t>(killsOverflowed_, hdr[2]);
    std::vector<GpuKillRecord> recs(n);
    if (n) std::memcpy(recs.data(), b + kRbKills + kGameKillHeader * 4, n * sizeof(GpuKillRecord));
    std::sort(recs.begin(), recs.end(), [](const GpuKillRecord& x, const GpuKillRecord& y) { return x.a.x < y.a.x; });
    for (const GpuKillRecord& r : recs) {
        const uint64_t seq = r.a.x;
        if (seq == 0 || seq <= lastKillSeq_) { ++st_.duplicatesDropped; continue; }
        lastKillSeq_ = seq;
        KillEvent k;
        k.seq = seq;
        k.cause = r.a.y == 0 ? KillCause::Soldier : r.a.y == 1 ? KillCause::Explosion : KillCause::Other;
        k.shooterPacked = r.a.z;
        k.pos = {r.p.x, r.p.y, r.p.z};
        kills_.push_back(k);
        ++st_.killsHarvested;
        ++st_.killsTotal;
    }
    // rounds of that frame
    hitResults_.resize(s.nHits);
    st_.hitsResolved = 0;
    for (uint32_t i = 0; i < s.nHits; ++i) {
        uint32_t w[2];
        std::memcpy(w, b + kRbHits + i * 8, 8);
        HitResult& h = hitResults_[i];
        h.kind = (HitKind)std::min<uint32_t>(w[0], 2u);
        std::memcpy(&h.dist, &w[1], 4);
        h.shooterPacked = s.shooters[i];
        if (h.kind == HitKind::Zombie) { ++st_.hitsResolved; ++st_.hitsOnZombies; }
        if (h.kind == HitKind::Static) ++st_.hitsOnStatic;
    }
    hitResultsFrame_ = s.frame;
    if (s.hasGrid && s.frame >= field_.frame) {
        contacts_.resize(s.nSoldiers);
        for (uint32_t i = 0; i < s.nSoldiers; ++i) {
            uint32_t w[4];
            std::memcpy(w, b + kRbContacts + i * 16, 16);
            SoldierContact& c = contacts_[i];
            c.packedId = s.ids[i];
            c.attackers = (uint16_t)std::min<uint32_t>(w[0], 0xFFFFu);
            c.nearby = (uint16_t)std::min<uint32_t>(w[1], 0xFFFFu);
            std::memcpy(&c.nearestDist, &w[2], 4);
        }
        const uint32_t tiles = s.tilesX * s.tilesZ;
        field_.frame = s.frame;
        field_.originX = s.originX;
        field_.originZ = s.originZ;
        field_.tilesX = s.tilesX;
        field_.tilesZ = s.tilesZ;
        field_.tiles.resize(tiles);
        const uint32_t* cnt = (const uint32_t*)(b + kRbField);
        const float* smp = (const float*)(b + kRbField + tiles * 4);
        for (uint32_t t = 0; t < tiles; ++t) {
            ZombieFieldTile& z = field_.tiles[t];
            z.count = cnt[t];
            z.samples = std::min(cnt[t], kFieldSamples);
            for (uint32_t k = 0; k < z.samples; ++k) {
                const float* q = smp + (t * kFieldSamples + k) * 4;
                z.pos[k] = {q[0], q[1], q[2]};
            }
        }
    }
    SDL_UnmapGPUTransferBuffer(d, s.tb);
    harvested_ = std::max(harvested_, s.frame);
    st_.latencyFrames = (uint32_t)(sim_->submittedFrames() - s.frame);
}

void HordeBridge::requestExplosion(V3 pos, float scale) {
    if (sim_) sim_->requestExplosion(pos.x, pos.y, pos.z, scale);
}

bool HordeBridge::simulated(float x, float z) const {
    if (!sim_) return false;
    const SimParams& p = const_cast<CrowdSim*>(sim_)->params();
    const float x0 = sim_->originX(), z0 = sim_->originZ();
    return x >= x0 && z >= z0 && x < x0 + p.gridW * p.cellSize && z < z0 + p.gridH * p.cellSize;
}

} // namespace ttz::game
