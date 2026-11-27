// HordeVertical: building-local zombie navigation (B3b). See HordeVertical.h for the design and
// shaders/game_vertical.comp for the GPU passes.
#include "game/HordeVertical.h"

#include "game/HordeBridge.h"
#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz::game {

namespace {
constexpr SDL_GPUBufferUsageFlags kStorage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
constexpr uint32_t kNodeBytes = 48, kEntrBytes = 32;
constexpr uint32_t kOccWords = 8, kOccHeader = 4;
constexpr uint32_t kTotals = kVMaxNodes * 4;               // VSTATE_TOTALS (game_vertical.comp)
constexpr uint32_t kStateWords = kTotals + 16;
constexpr uint32_t kOccBytes = (kOccHeader + kVMaxOccupants * kOccWords) * 4;
constexpr uint32_t VN_STAY = 0xFFFFFFFFu, VN_EMIT = 0xFFFFFFFEu;
constexpr uint32_t VF_BARRICADED = 1u, VF_STREET = 2u;
uint32_t groups(uint32_t n, uint32_t g) { return (n + g - 1) / g; }
uint32_t fbits(float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; }
double msSince(uint64_t t0) { return (double)(SDL_GetPerformanceCounter() - t0) * 1000.0 / (double)SDL_GetPerformanceFrequency(); }

struct NodeRec { float p[4]; uint32_t q[4]; uint32_t r[4]; };
struct EntrRec { float p[4]; uint32_t q[4]; };
static_assert(sizeof(NodeRec) == kNodeBytes && sizeof(EntrRec) == kEntrBytes, "game_vertical.comp layouts");
} // namespace

const char* HordeVertical::unsupportedWhy(const Building& b) {
    bool door = false;
    for (const Opening& o : b.openings) door |= o.type == OpeningType::Door;
    if (!door) return "no door (zombies cannot enter; low roofs only by corpse piles)";
    if (b.floors > kVMaxFloors) return "more than 22 floors (interior graph limit)";
    return "";
}

bool HordeVertical::init(GpuContext& gpu, CrowdSim& sim, HordeBridge& bridge) {
    gpu_ = &gpu;
    sim_ = &sim;
    bridge_ = &bridge;
    pipe_ = gpu.loadCompute("game_vertical", 64);
    nodes_ = gpu.createBuffer(kStorage, kVMaxNodes * kNodeBytes, "vertNodes");
    entr_ = gpu.createBuffer(kStorage, kVMaxEntrances * kEntrBytes, "vertEntrances");
    state_ = gpu.createBuffer(kStorage, kStateWords * 4, "vertState");
    occ_[0] = gpu.createBuffer(kStorage, kOccBytes, "vertOccA");
    occ_[1] = gpu.createBuffer(kStorage, kOccBytes, "vertOccB");
    SDL_GPUTransferBufferCreateInfo up{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, kVMaxNodes * kNodeBytes + kVMaxEntrances * kEntrBytes, 0};
    upload_ = SDL_CreateGPUTransferBuffer(gpu.device(), &up);
    for (RbSlot& s : ring_) {
        SDL_GPUTransferBufferCreateInfo dn{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, kStateWords * 4, 0};
        s.tb = SDL_CreateGPUTransferBuffer(gpu.device(), &dn);
        if (!s.tb) { shutdown(); return false; }
    }
    if (!pipe_ || !nodes_ || !entr_ || !state_ || !occ_[0] || !occ_[1] || !upload_) { shutdown(); return false; }
    nodeData_.assign(kVMaxNodes * kNodeBytes, 0);
    entrData_.assign(kVMaxEntrances * kEntrBytes, 0);
    for (uint32_t n = 0; n < kVMaxNodes; ++n) {   // unused nodes: stay forever, no capacity
        NodeRec r{};
        r.q[0] = VN_STAY;
        std::memcpy(nodeData_.data() + n * kNodeBytes, &r, sizeof(r));
    }
    std::vector<uint32_t> z(std::max<uint32_t>(kStateWords, kOccBytes / 4), 0u);
    gpu.uploadNow(state_, z.data(), kStateWords * 4);
    gpu.uploadNow(occ_[0], z.data(), kOccBytes);
    gpu.uploadNow(occ_[1], z.data(), kOccBytes);
    lastStep_ = sim.stepIndex();
    dirty_ = true;
    return true;
}

void HordeVertical::shutdown() {
    if (gpu_) {
        SDL_GPUDevice* d = gpu_->device();
        SDL_WaitForGPUIdle(d);
        for (RbSlot& s : ring_) {
            if (s.tb) SDL_ReleaseGPUTransferBuffer(d, s.tb);
            s = RbSlot{};
        }
        if (upload_) SDL_ReleaseGPUTransferBuffer(d, upload_);
        upload_ = nullptr;
        SDL_GPUBuffer** bufs[] = {&nodes_, &entr_, &state_, &occ_[0], &occ_[1]};
        for (auto b : bufs) gpu_->releaseBuffer(*b);
        if (pipe_) SDL_ReleaseGPUComputePipeline(d, pipe_);
        pipe_ = nullptr;
    }
    gpu_ = nullptr; sim_ = nullptr; bridge_ = nullptr;
}

void HordeVertical::reset() {
    if (!gpu_) return;
    SDL_WaitForGPUIdle(gpu_->device());
    std::vector<uint32_t> z(std::max<uint32_t>(kStateWords, kOccBytes / 4), 0u);
    gpu_->uploadNow(state_, z.data(), kStateWords * 4);
    gpu_->uploadNow(occ_[0], z.data(), kOccBytes);
    gpu_->uploadNow(occ_[1], z.data(), kOccBytes);
    for (Slot& s : slots_) s = Slot{};
    for (RbSlot& r : ring_) r.pending = false;
    for (uint32_t n = 0; n < kVMaxNodes; ++n) {
        NodeRec r{};
        r.q[0] = VN_STAY;
        std::memcpy(nodeData_.data() + n * kNodeBytes, &r, sizeof(r));
    }
    nEntr_ = 0;
    view_.clear();
    interior_.clear();
    st_ = Stats{};
    lastStep_ = sim_ ? sim_->stepIndex() : 0;
    dirty_ = true;
    if (bridge_) { bridge_->setEntranceAttractors({}); bridge_->setInteriorAttackers({}); }
}

int HordeVertical::slotOf(BuildingId id) const {
    for (uint32_t s = 0; s < kVMaxActive; ++s)
        if (slots_[s].used && slots_[s].id == id) return (int)s;
    return -1;
}

BuildingId HordeVertical::find(float x, float z) const {
    if (lookup) return lookup(x, z);
    BuildingId id;
    if (!buildings) return id;
    for (uint32_t i = 0; i < buildings->size(); ++i)
        if ((*buildings)[i].contains(x, z)) { id.v = i; break; }
    return id;
}

// One slot's graph. soldiersPerLevel: [0, floors) floors, [floors] roof. Draining: everything leads out of door 0.
void HordeVertical::buildSlot(uint32_t s, const Building& b, const std::vector<int>& perLevel, const std::vector<uint32_t>& shooter) {
    Slot& sl = slots_[s];
    const uint32_t base = s * kVNodesPerSlot;
    auto node = [&](uint32_t local) -> NodeRec& { return *(NodeRec*)(nodeData_.data() + (base + local) * kNodeBytes); };
    for (uint32_t l = 0; l < kVNodesPerSlot; ++l) { node(l) = NodeRec{}; node(l).q[0] = VN_STAY; }
    const int F = std::min<int>(b.floors, (int)kVMaxFloors);
    sl.nFloors = F;
    sl.nDoors = 0;
    sl.hasHatch = false;
    sl.hatchOpening = 0xFFFF;
    const Opening* hatch = nullptr;
    for (size_t i = 0; i < b.openings.size(); ++i) {
        const Opening& o = b.openings[i];
        if (o.type == OpeningType::Door && sl.nDoors < (int)kVMaxDoors) sl.doorOpening[sl.nDoors++] = (uint16_t)i;
        if (o.type == OpeningType::RoofHatch && b.flatRoof && !hatch) { hatch = &o; sl.hatchOpening = (uint16_t)i; }
    }
    sl.hasHatch = hatch != nullptr;
    // target level: the lowest level holding soldiers (the defenders the horde meets first); roof only via a hatch
    int target = -1;
    for (int f = 0; f < F && target < 0; ++f) if (perLevel[(size_t)f] > 0) target = f;
    if (target < 0) target = sl.hasHatch && perLevel[(size_t)F] > 0 ? (int)kRoofFloor : F - 1;
    sl.target = (uint8_t)target;
    const V3 stair0 = b.toWorld(b.stairU, b.stairV, b.y0);
    // doors
    for (int k = 0; k < sl.nDoors; ++k) {
        const Opening& o = b.openings[sl.doorOpening[k]];
        NodeRec& n = node((uint32_t)k);
        V3 street{o.pos.x + o.nx * 0.9f, o.pos.y, o.pos.z + o.nz * 0.9f};
        n.p[0] = street.x; n.p[1] = street.y; n.p[2] = street.z; n.p[3] = cfg.doorTime;
        n.q[0] = sl.draining ? VN_EMIT : base + kVFloorBase;
        n.q[1] = (uint32_t)std::max(cfg.doorCapacity, 1);
        n.q[2] = sl.draining ? VF_STREET : 0u;
        n.r[1] = s;
        n.r[2] = 0;
    }
    // floors (node f: crossing to the stairs on the ground floor, one flight above)
    for (int f = 0; f < F; ++f) {
        NodeRec& n = node(kVFloorBase + (uint32_t)f);
        V3 p = b.toWorld(b.stairU, b.stairV, b.floorY(f));
        float t = cfg.climbTimePerFloor;
        if (f == 0) {
            float dmax = 0.f;
            for (int k = 0; k < sl.nDoors; ++k) {
                const Opening& o = b.openings[sl.doorOpening[k]];
                dmax = std::max(dmax, std::hypot(o.pos.x - stair0.x, o.pos.z - stair0.z));
            }
            t = std::max(1.f, dmax / std::max(cfg.walkSpeed, 0.1f));
        }
        n.p[0] = p.x; n.p[1] = p.y; n.p[2] = p.z; n.p[3] = t;
        const bool isTarget = !sl.draining && target == f;
        n.q[1] = (uint32_t)std::max(isTarget ? cfg.floorCapacity : cfg.stairCapacity, 1);
        if (sl.draining) n.q[0] = f == 0 ? base + 0u : base + kVFloorBase + (uint32_t)(f - 1);
        else if (isTarget) n.q[0] = VN_STAY;
        else if (target == (int)kRoofFloor && f == F - 1) n.q[0] = base + kVHatch;
        else if (f < target || target == (int)kRoofFloor) n.q[0] = base + kVFloorBase + (uint32_t)(f + 1);
        else n.q[0] = base + kVFloorBase + (uint32_t)(f - 1);   // above the target (cannot happen while climbing)
        const int def = sl.draining ? 0 : perLevel[(size_t)f];
        n.q[3] = fbits(def > 0 ? cfg.defenderDps * (float)def : 0.f);
        n.r[0] = shooter[(size_t)f];
        n.r[1] = s;
        n.r[2] = (uint32_t)f;
    }
    if (hatch) {
        NodeRec& n = node(kVHatch);
        n.p[0] = hatch->pos.x; n.p[1] = std::max(hatch->pos.y, b.roofY); n.p[2] = hatch->pos.z; n.p[3] = cfg.hatchTime;   // roof surface at the hatch
        n.q[0] = sl.draining ? base + kVFloorBase + (uint32_t)(F - 1) : VN_EMIT;
        n.q[1] = (uint32_t)std::max(cfg.hatchCapacity, 1);
        n.q[2] = (!sl.draining && !hatch->open()) ? VF_BARRICADED : 0u;
        n.r[1] = s;
        n.r[2] = kRoofFloor;
    }
    dirty_ = true;
}

void HordeVertical::tick(const std::vector<HordeSoldier>& soldiers, double time) {
    if (!gpu_ || !buildings) return;
    const uint64_t t0 = SDL_GetPerformanceCounter();
    time_ = time;
    // ---- soldiers -> buildings / levels (cost ~ soldiers) ----------------------------------------------------------
    struct Act { BuildingId id; std::vector<int> perLevel; std::vector<uint32_t> shooter; };
    std::vector<Act> acts;
    placed_.clear();
    for (const HordeSoldier& h : soldiers) {
        if (h.attraction <= 0.f) continue;
        BuildingId id = find(h.pos.x, h.pos.z);
        if (!id.valid() || id.v >= buildings->size()) continue;
        const Building& b = (*buildings)[id.v];
        if (*unsupportedWhy(b)) continue;
        const int F = std::min<int>(b.floors, (int)kVMaxFloors);
        int level;
        if (h.pos.y >= b.roofY - 0.8f) level = F;   // roof
        else level = std::clamp((int)std::floor((h.pos.y - b.y0) / std::max(b.floorHeight, 1.f) + 0.35f), 0, F - 1);
        Act* a = nullptr;
        for (Act& x : acts) if (x.id == id) { a = &x; break; }
        if (!a) { acts.push_back({id, std::vector<int>((size_t)F + 1, 0), std::vector<uint32_t>((size_t)F + 1, 0)}); a = &acts.back(); }
        a->perLevel[(size_t)level]++;
        a->shooter[(size_t)level] = h.packedId;
        placed_.push_back({h.packedId, -1, (uint8_t)(level == F ? kRoofFloor : level)});
        placed_.back().slot = -2 - (int)(&*a - &acts[0]);   // resolved to a slot below
    }
    // ---- slots: keep / assign / drain / free --------------------------------------------------------------------
    std::vector<int> actSlot(acts.size(), -1);
    for (size_t i = 0; i < acts.size(); ++i) actSlot[i] = slotOf(acts[i].id);
    for (size_t i = 0; i < acts.size(); ++i) {
        if (actSlot[i] >= 0) continue;
        for (uint32_t s = 0; s < kVMaxActive; ++s)
            if (!slots_[s].used) {
                slots_[s] = Slot{};
                slots_[s].used = true;
                slots_[s].id = acts[i].id;
                clearSlots_.push_back(s);
                actSlot[i] = (int)s;
                break;
            }
    }
    for (uint32_t s = 0; s < kVMaxActive; ++s) {
        Slot& sl = slots_[s];
        if (!sl.used) continue;
        int ai = -1;
        for (size_t i = 0; i < acts.size(); ++i) if (actSlot[i] == (int)s) ai = (int)i;
        const Building& b = (*buildings)[sl.id.v];
        if (ai >= 0) {
            sl.lastActive = time;
            bool wasDraining = sl.draining;
            sl.draining = false;
            // rebuild only when something this slot depends on changed (target, defenders, barricades)
            static thread_local std::vector<int> sig;
            sig = acts[(size_t)ai].perLevel;
            for (const Opening& o : b.openings) sig.push_back(o.open() ? 1 : 0);
            uint64_t h = 1469598103934665603ull;
            for (int v : sig) h = (h ^ (uint64_t)(uint32_t)v) * 1099511628211ull;
            for (uint32_t v : acts[(size_t)ai].shooter) h = (h ^ v) * 1099511628211ull;
            if (wasDraining || (uint32_t)h != sl.breachSeen[kVNodesPerSlot - 1] || sl.nFloors == 0) {
                sl.breachSeen[kVNodesPerSlot - 1] = (uint32_t)h;   // node 31 is unused: its breach word holds the signature
                buildSlot(s, b, acts[(size_t)ai].perLevel, acts[(size_t)ai].shooter);
            }
        } else if (!sl.draining) {
            if (time - sl.lastActive > 2.0) {   // soldiers gone for 2 s: the occupants walk back out
                sl.draining = true;
                sl.drainSince = time;
                std::vector<int> none((size_t)std::min<int>(b.floors, (int)kVMaxFloors) + 1, 0);
                std::vector<uint32_t> ns(none.size(), 0);
                buildSlot(s, b, none, ns);
            }
        } else if (sl.occupants == 0 && time - sl.drainSince > 1.5) {   // empty (readback latency covered): free
            for (uint32_t l = 0; l < kVNodesPerSlot; ++l) {
                NodeRec r{};
                r.q[0] = VN_STAY;
                std::memcpy(nodeData_.data() + (s * kVNodesPerSlot + l) * kNodeBytes, &r, sizeof(r));
            }
            if (setZombieCounts) setZombieCounts(sl.id, -1, -1, nullptr, 0);   // not simulated any more (B3a fallbacks resume)
            sl = Slot{};
            dirty_ = true;
        }
    }
    // ---- entrances + attractors (doors of active, non-draining slots) ----------------------------------------------
    std::vector<Attractor> attr;
    uint32_t ne = 0;
    int nActive = 0;
    for (uint32_t s = 0; s < kVMaxActive; ++s) {
        const Slot& sl = slots_[s];
        if (!sl.used || sl.draining) continue;
        ++nActive;
        const Building& b = (*buildings)[sl.id.v];
        const V3 stair0 = b.toWorld(b.stairU, b.stairV, b.y0);
        const int levels = sl.target == kRoofFloor ? sl.nFloors : sl.target;
        for (int k = 0; k < sl.nDoors && ne < kVMaxEntrances; ++k) {
            const Opening& o = b.openings[sl.doorOpening[k]];
            EntrRec e{};
            const float off = 0.9f;
            e.p[0] = o.pos.x + o.nx * off; e.p[1] = o.pos.y; e.p[2] = o.pos.z + o.nz * off; e.p[3] = cfg.captureRadius;
            e.q[0] = s * kVNodesPerSlot + (uint32_t)k;
            e.q[1] = s;
            e.q[2] = o.open() ? 0u : VF_BARRICADED;
            e.q[3] = sl.doorOpening[k];
            if (std::memcmp(entrData_.data() + ne * kEntrBytes, &e, sizeof(e)) != 0) { std::memcpy(entrData_.data() + ne * kEntrBytes, &e, sizeof(e)); dirty_ = true; }
            ++ne;
            // flow: the door is a source whose reach is shortened by the interior route (stairs count double)
            const float route = std::hypot(o.pos.x - stair0.x, o.pos.z - stair0.z) + 2.f * (float)levels * b.floorHeight;
            const float A = awareness;
            float reach = std::max(A - cfg.routeWeight * route, A * cfg.minReachFraction);
            Attractor at;
            at.pos = {e.p[0], o.pos.y, e.p[2]};
            at.radius = cfg.entranceRadius;
            at.strength = 1.f;
            at.awareness = reach;
            attr.push_back(at);
        }
    }
    if (ne != nEntr_) dirty_ = true;
    nEntr_ = ne;
    bridge_->setEntranceAttractors(attr);
    // ---- interior attackers: occupants at a soldier's floor (shared over the soldiers on that floor) -----------------
    interior_.clear();
    {
        // soldiers per (act, level) first: cost ~ soldiers inside buildings
        std::vector<std::vector<int>> onLevel(acts.size());
        for (size_t i = 0; i < acts.size(); ++i) onLevel[i] = acts[i].perLevel;
        for (const Placed& p : placed_) {
            if (p.level == kRoofFloor) continue;   // the roof fight is between real agents (game_contacts)
            const size_t ai = (size_t)(-2 - p.slot);
            if (ai >= acts.size() || actSlot[ai] < 0) continue;
            const BuildingState* v = nullptr;
            for (const BuildingState& x : view_) if (x.id == acts[ai].id) { v = &x; break; }
            if (!v || p.level >= v->perFloor.size() || v->perFloor[p.level] <= 0) continue;
            const int share = std::max(onLevel[ai][p.level], 1);
            const int n = std::min(cfg.attackersPerSoldier, (v->perFloor[p.level] + share - 1) / share);
            if (n > 0) interior_.push_back({p.packed, (uint16_t)n});
        }
    }
    bridge_->setInteriorAttackers(interior_);
    st_.activeBuildings = nActive;
    st_.entrances = (int)ne;
    st_.cpuMs = msSince(t0);
}

void HordeVertical::postSim(SDL_GPUCommandBuffer* cmd) {
    if (!gpu_ || !pipe_) return;
    const uint64_t t0 = SDL_GetPerformanceCounter();
    SDL_GPUDevice* d = gpu_->device();
    const uint64_t steps = sim_->stepIndex() - lastStep_;
    lastStep_ = sim_->stepIndex();
    // ---- uploads (only when a slot / entrance changed) --------------------------------------------------------------
    if (dirty_) {
        auto* up = (uint8_t*)SDL_MapGPUTransferBuffer(d, upload_, true);
        if (up) {
            std::memcpy(up, nodeData_.data(), nodeData_.size());
            std::memcpy(up + nodeData_.size(), entrData_.data(), std::max<uint32_t>(nEntr_, 1) * kEntrBytes);
            SDL_UnmapGPUTransferBuffer(d, upload_);
            SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
            SDL_GPUTransferBufferLocation a{upload_, 0};
            SDL_GPUBufferRegion ra{nodes_, 0, (uint32_t)nodeData_.size()};
            SDL_UploadToGPUBuffer(cp, &a, &ra, false);
            SDL_GPUTransferBufferLocation b{upload_, (uint32_t)nodeData_.size()};
            SDL_GPUBufferRegion rb{entr_, 0, std::max<uint32_t>(nEntr_, 1) * kEntrBytes};
            SDL_UploadToGPUBuffer(cp, &b, &rb, false);
            SDL_EndGPUCopyPass(cp);
            dirty_ = false;
            ++st_.uploads;
        }
    }
    for (uint32_t s : clearSlots_) {
        sim_->fillBuffer(cmd, state_, s * kVNodesPerSlot * 4, kVNodesPerSlot * 4, 0u);
        slots_[s].validFrom = sim_->recordingFrame();
    }
    clearSlots_.clear();
    if (steps == 0 || !sim_->cellGridValid()) { st_.cpuMs += msSince(t0); return; }
    // ---- passes ----------------------------------------------------------------------------------------------------
    SimUniforms u = sim_->uniforms();
    const uint32_t U = sizeof(SimUniforms);
    u.extraP = {(float)steps * sim_->params().fixedDt, cfg.breachPerZombie, (float)kVMaxOccupants, cfg.captureRadius};
    SDL_GPUBuffer* in = occ_[occIn_];
    SDL_GPUBuffer* out = occ_[1 - occIn_];
    sim_->fillBuffer(cmd, out, 0, 1, 0u);
    u.misc.y = 1;
    dispatch(Dispatch{cmd, pipe_, {nodes_, entr_, sim_->cellStart(), sim_->cellCount(), in, sim_->staticHeight()},
                      {sim_->agents(), sim_->counters(), state_, out, sim_->gameIO()}, &u, U},
             groups(kVMaxOccupants, 64));
    if (nEntr_) {
        u.misc.y = 0; u.counts.x = nEntr_;
        dispatch(Dispatch{cmd, pipe_, {nodes_, entr_, sim_->cellStart(), sim_->cellCount(), in, sim_->staticHeight()},
                          {sim_->agents(), sim_->counters(), state_, out, sim_->gameIO()}, &u, U},
                 1, nEntr_);
    }
    occIn_ = 1 - occIn_;
    // ---- readback: node state + totals -----------------------------------------------------------------------------
    int si = -1;
    for (int i = 0; i < (int)ring_.size(); ++i) if (!ring_[i].pending) { si = i; break; }
    if (si >= 0) {
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUBufferRegion r{state_, 0, kStateWords * 4};
        SDL_GPUTransferBufferLocation dst{ring_[si].tb, 0};
        SDL_DownloadFromGPUBuffer(cp, &r, &dst);
        SDL_EndGPUCopyPass(cp);
        ring_[si].frame = sim_->recordingFrame();
        ring_[si].pending = true;
    }
    st_.cpuMs += msSince(t0);
}

void HordeVertical::harvest() {
    if (!gpu_) return;
    if (sync_) SDL_WaitForGPUIdle(gpu_->device());
    sim_->pollFences();
    const uint64_t done = sim_->lastCompletedFrame();
    int best = -1;   // newest finished slot (older ones are superseded: the state is cumulative)
    for (int i = 0; i < (int)ring_.size(); ++i)
        if (ring_[i].pending && ring_[i].frame <= done && (best < 0 || ring_[i].frame > ring_[best].frame)) best = i;
    if (best < 0) return;
    for (RbSlot& r : ring_) if (r.pending && r.frame <= ring_[best].frame && &r != &ring_[best]) r.pending = false;
    RbSlot& rs = ring_[best];
    rs.pending = false;
    const auto* w = (const uint32_t*)SDL_MapGPUTransferBuffer(gpu_->device(), rs.tb, false);
    if (!w) return;
    st_.captured = w[kTotals];
    st_.emitted = w[kTotals + 1];
    st_.killedInside = w[kTotals + 2];
    st_.dropped = w[kTotals + 3];
    st_.leftByDoor = w[kTotals + 4];
    view_.clear();
    int total = 0;
    for (uint32_t s = 0; s < kVMaxActive; ++s) {
        Slot& sl = slots_[s];
        if (!sl.used || rs.frame < sl.validFrom) continue;   // readbacks from before the slot's (re)use are stale
        const uint32_t base = s * kVNodesPerSlot;
        BuildingState v;
        v.id = sl.id;
        v.draining = sl.draining;
        v.target = sl.target;
        v.perFloor.assign((size_t)sl.nFloors, 0);
        for (uint32_t l = 0; l < kVNodesPerSlot - 1; ++l) {
            int occ = (int)w[(base + l) * 4];
            if (occ < 0 || occ > (int)kVMaxOccupants) occ = 0;
            v.occupants += occ;
            if (l >= kVFloorBase && l < kVFloorBase + (uint32_t)sl.nFloors) v.perFloor[l - kVFloorBase] = (int16_t)occ;
            // barricade damage: accumulated on the GPU (1/256), applied as deltas
            const uint32_t acc = w[(base + l) * 4 + 1];
            if (acc != sl.breachSeen[l]) {
                const float dmg = (float)(uint32_t)(acc - sl.breachSeen[l]) / 256.f;
                sl.breachSeen[l] = acc;
                uint16_t op = 0xFFFF;
                if (l < (uint32_t)sl.nDoors) op = sl.doorOpening[l];
                else if (l == kVHatch) op = sl.hatchOpening;
                if (op != 0xFFFF && damageBarricade) damageBarricade(sl.id, op, dmg);
            }
        }
        if (sl.target != kRoofFloor && sl.target < v.perFloor.size()) v.atTarget = v.perFloor[sl.target];
        sl.occupants = v.occupants;
        total += v.occupants;
        if (setZombieCounts) setZombieCounts(sl.id, v.occupants, -1, v.perFloor.data(), (int)v.perFloor.size());
        view_.push_back(std::move(v));
    }
    st_.occupants = total;
    SDL_UnmapGPUTransferBuffer(gpu_->device(), rs.tb);
}

} // namespace ttz::game
