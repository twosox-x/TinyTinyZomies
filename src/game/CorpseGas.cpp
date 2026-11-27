// Corpse rot gas + flamethrower fire on the GPU (GAME_DESIGN 14d). See CorpseGas.h.
#include "game/CorpseGas.h"

#include "game/Config.h"
#include "game/Soldiers.h"
#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz::game {

namespace {
constexpr SDL_GPUBufferUsageFlags kStorage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
constexpr uint32_t kStatWords = 16;          // == GAS_STAT_WORDS (gas.glsl)
enum : uint32_t { ST_BURNED = 0, ST_BURNING = 1, ST_ROTTING = 2, ST_CORPSES = 3, ST_FLAMED = 4, ST_IGNITED = 5 };
constexpr uint32_t kBoxesPerCell = 9, kVertsPerCell = kBoxesPerCell * 36;   // == gas.vert

struct GasUniforms {   // std140, == GasUniforms in shaders/include/gas.glsl
    UVec4 gdim;
    int32_t gshift[4];
    Vec4 rotP, airP, fireP, miscP;
    Vec4 coneA[CorpseGas::kMaxCones];
    Vec4 coneB[CorpseGas::kMaxCones];
    UVec4 coneC[CorpseGas::kMaxCones];
};
uint32_t fbits(float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; }
} // namespace

bool CorpseGas::init(GpuContext& gpu, CrowdSim& sim) {
    gpu_ = &gpu;
    sim_ = &sim;
    const SimParams& p = sim.params();
    gw_ = (uint32_t)p.gridW / kDiv;
    gh_ = (uint32_t)p.gridH / kDiv;
    cells_ = gw_ * gh_;
    corpseCap_ = (uint32_t)p.corpseCapacity;
    cell_ = p.cellSize * (float)kDiv;
    pCorpse_ = gpu.loadCompute("game_gas_corpse", 256);
    pField_ = gpu.loadCompute("game_gas_field", 16);
    pAgents_ = gpu.loadCompute("game_gas_agents", 256);
    field_[0] = gpu.createBuffer(kStorage, cells_ * 16, "gasFieldA");
    field_[1] = gpu.createBuffer(kStorage, cells_ * 16, "gasFieldB");
    accum_ = gpu.createBuffer(kStorage, cells_ * 16, "gasAccum");
    out_ = gpu.createBuffer(kStorage, (cells_ + kStatWords) * 4, "gasOut");
    list_ = gpu.createBuffer(kStorage | SDL_GPU_BUFFERUSAGE_INDIRECT | SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (cells_ + 4) * 4, "gasList");
    rot_buf_ = gpu.createBuffer(kStorage, corpseCap_ * 16, "corpseRot");
    for (Slot& s : ring_) {
        SDL_GPUTransferBufferCreateInfo dn{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, (cells_ + kStatWords) * 4, 0};
        s.tb = SDL_CreateGPUTransferBuffer(gpu.device(), &dn);
    }
    if (!pCorpse_ || !pField_ || !pAgents_ || !field_[0] || !field_[1] || !accum_ || !out_ || !list_ || !rot_buf_ || !ring_[2].tb) {
        SDL_Log("corpse gas: init failed (pipelines / buffers)");
        shutdown();
        return false;
    }
    std::vector<uint32_t> zero(std::max(cells_ * 4, corpseCap_ * 4), 0u);
    gpu.uploadNow(field_[0], zero.data(), cells_ * 16);
    gpu.uploadNow(field_[1], zero.data(), cells_ * 16);
    gpu.uploadNow(accum_, zero.data(), cells_ * 16);
    gpu.uploadNow(out_, zero.data(), (cells_ + kStatWords) * 4);
    gpu.uploadNow(rot_buf_, zero.data(), corpseCap_ * 16);
    zero[0] = kVertsPerCell;
    gpu.uploadNow(list_, zero.data(), (cells_ + 4) * 4);
    cpu_.assign(cells_ + kStatWords, 0u);
    navCost_.assign(cells_, 0u);
    return true;
}

void CorpseGas::shutdown() {
    if (!gpu_) return;
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (Slot& s : ring_) { if (s.tb) SDL_ReleaseGPUTransferBuffer(d, s.tb); s = Slot{}; }
    for (SDL_GPUBuffer** b : {&field_[0], &field_[1], &accum_, &out_, &list_, &rot_buf_}) gpu_->releaseBuffer(*b);
    for (SDL_GPUComputePipeline** p : {&pCorpse_, &pField_, &pAgents_}) { if (*p) SDL_ReleaseGPUComputePipeline(d, *p); *p = nullptr; }
    gpu_ = nullptr;
}

void CorpseGas::configure(const RotConfig& rot, const FlameConfig& flame) { rot_ = &rot; flame_ = &flame; }

void CorpseGas::queueFlame(const FlameCone& c) {
    if (cones_.size() < 256) cones_.push_back(c);
}

void CorpseGas::postSim(SDL_GPUCommandBuffer* cmd) {
    if (!gpu_ || !cmd || !rot_ || !flame_) return;
    const double now = sim_->simTime();
    if (lastSim_ < 0.0) lastSim_ = now;
    const float dt = (float)std::min(now - lastSim_, 0.5);
    if (dt < 1.f / 40.f && cones_.empty() && sinceReadback_ < kReadbackEvery) return;   // ~30 Hz is plenty
    lastSim_ = now;
    sinceReadback_ += dt;
    const SimUniforms su = sim_->uniforms();
    const float ox = su.world.x, oz = su.world.y;
    GasUniforms u{};
    u.gdim = {gw_, gh_, cells_, 0};
    if (lastOx_ < 1e29f) {   // the window moved: the field pass reads the previous grid shifted
        u.gshift[0] = (int32_t)std::lround((ox - lastOx_) / cell_);
        u.gshift[1] = (int32_t)std::lround((oz - lastOz_) / cell_);
    }
    lastOx_ = ox; lastOz_ = oz;
    u.gshift[2] = rot_->enabled ? 1 : 0;
    u.gshift[3] = (int32_t)updates_;
    u.rotP = {dt, rot_->delay, rot_->ramp, rot_->emitPerCorpse};
    u.airP = {rot_->diffusion, rot_->decay, rot_->maxGas, flame_->groundFireTime};
    u.fireP = {flame_->corpseIgnite, flame_->corpseBurnTime, flame_->zombieDps, flame_->groundFireDps};
    u.miscP = {(float)corpseCap_, (float)now, 0.6f, 2.5f};
    // cones: the strongest kMaxCones of this update (more than 16 flamers spraying at once share the next update)
    drawn_.clear();
    uint32_t n = 0;
    for (size_t k = 0; k < cones_.size() && n < (uint32_t)kMaxCones; ++k, ++n) {
        const FlameCone& c = cones_[k];
        u.coneA[n] = {c.origin.x, c.origin.y, c.origin.z, c.range};
        u.coneB[n] = {c.dir.x, c.dir.y, c.dir.z, std::cos(c.coneDeg * 3.14159265f / 180.f)};
        u.coneC[n] = {c.shooterPacked, fbits(c.seconds), 0, 0};
        drawn_.push_back(c);
    }
    u.gdim.w = n;
    cones_.erase(cones_.begin(), cones_.begin() + (ptrdiff_t)n);
    if (cones_.size() > 64) cones_.clear();   // runaway backlog (paused sim): drop

    const uint32_t U = sizeof(SimUniforms);
    sim_->fillBuffer(cmd, out_, cells_ + ST_BURNING, 4, 0u);   // per-update stats (burned / ignited are totals)
    sim_->fillBuffer(cmd, list_, 1, 1, 0u);                     // render list instance count
    SDL_PushGPUComputeUniformData(cmd, 1, &u, sizeof(u));
    // 1. corpses: age, emit, count, ignite, burn, remove
    dispatchIndirect(Dispatch{cmd, pCorpse_, {sim_->counters(), field_[cur_]}, {sim_->corpses(), sim_->corpseHeight(), rot_buf_, accum_, out_}, &su, U},
                     sim_->indirect(), I_CORPSE_DISPATCH * 4);
    // 2. field: shift + diffuse + emit + decay, fire, readback cells, render list
    SDL_PushGPUComputeUniformData(cmd, 1, &u, sizeof(u));
    dispatch(Dispatch{cmd, pField_, {sim_->staticHeight(), field_[cur_]}, {field_[1 - cur_], accum_, out_, list_}, &su, U}, (gw_ + 15) / 16, (gh_ + 15) / 16);
    cur_ = 1 - cur_;
    // 3. zombies in cones / ground fire -> damage queue (indices of the last step's sort, consumed by the next predict)
    if (sim_->cellGridValid() && sim_->gameIO()) {
        SDL_PushGPUComputeUniformData(cmd, 1, &u, sizeof(u));
        dispatchIndirect(Dispatch{cmd, pAgents_, {sim_->agents(), sim_->counters(), field_[cur_]}, {sim_->gameIO(), out_}, &su, U},
                         sim_->indirect(), I_AGENT_DISPATCH * 4);
    }
    ++updates_;
    // 4. readback (async ring)
    if (sinceReadback_ < kReadbackEvery && !sync_) return;
    int si = -1;
    for (int i = 0; i < (int)ring_.size(); ++i) if (!ring_[(size_t)i].pending) { si = i; break; }
    if (si < 0) return;
    sinceReadback_ = 0.f;
    Slot& s = ring_[(size_t)si];
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUBufferRegion r{out_, 0, (cells_ + kStatWords) * 4};
    SDL_GPUTransferBufferLocation dst{s.tb, 0};
    SDL_DownloadFromGPUBuffer(cp, &r, &dst);
    SDL_EndGPUCopyPass(cp);
    s.frame = sim_->recordingFrame();
    s.ox = ox; s.oz = oz;
    s.pending = true;
}

void CorpseGas::harvest() {
    if (!gpu_ || !sim_) return;
    if (sync_) SDL_WaitForGPUIdle(gpu_->device());
    sim_->pollFences();
    const uint64_t done = sim_->lastCompletedFrame();
    int best = -1;
    for (int i = 0; i < (int)ring_.size(); ++i)
        if (ring_[(size_t)i].pending && (ring_[(size_t)i].frame <= done || sync_) && (best < 0 || ring_[(size_t)i].frame > ring_[(size_t)best].frame)) best = i;
    if (best < 0) return;
    for (Slot& s : ring_) if (s.pending && (s.frame <= done || sync_) && &s != &ring_[(size_t)best]) s.pending = false;
    Slot& s = ring_[(size_t)best];
    s.pending = false;
    const auto* b = (const uint32_t*)SDL_MapGPUTransferBuffer(gpu_->device(), s.tb, false);
    if (!b) return;
    std::memcpy(cpu_.data(), b, (cells_ + kStatWords) * 4);
    SDL_UnmapGPUTransferBuffer(gpu_->device(), s.tb);
    ox_ = s.ox; oz_ = s.oz;
    have_ = true;
    ++readbacks_;
    const uint32_t* st = cpu_.data() + cells_;
    stats_.burned = st[ST_BURNED]; stats_.burning = st[ST_BURNING]; stats_.rotting = st[ST_ROTTING];
    stats_.corpses = st[ST_CORPSES]; stats_.flamed = st[ST_FLAMED]; stats_.ignited = st[ST_IGNITED];
    stats_.maxGas = 0.f; stats_.totalGas = 0.f; stats_.fireCells = 0; stats_.gasCells = 0;
    const float avoid = rot_ ? rot_->navAvoidLevel : 0.35f;
    for (uint32_t c = 0; c < cells_; ++c) {
        const float g = (float)(cpu_[c] & 0xFFu) / 64.f;
        stats_.maxGas = std::max(stats_.maxGas, g);
        stats_.totalGas += g;
        stats_.gasCells += g > 0.05f ? 1 : 0;
        stats_.fireCells += (cpu_[c] >> 8 & 0xFFu) ? 1 : 0;
        navCost_[c] = g >= avoid ? (uint8_t)std::min(255.f, g * 64.f) : 0u;
    }
}

GasCell CorpseGas::at(float x, float z) const {
    GasCell r;
    if (!have_) return r;
    const int i = (int)std::floor((x - ox_) / cell_), j = (int)std::floor((z - oz_) / cell_);
    if (i < 0 || j < 0 || i >= (int)gw_ || j >= (int)gh_) return r;
    const uint32_t v = cpu_[(size_t)j * gw_ + (size_t)i];
    r.gas = (float)(v & 0xFFu) / 64.f;
    r.fire = (float)(v >> 8 & 0xFFu) / 32.f;
    r.corpses = (int)(v >> 16 & 0xFFu);
    r.rotting = (int)(v >> 24);
    return r;
}

bool CorpseGas::findPile(V3 c, float r, int minCorpses, float minGas, V3& out, int* corpses) const {
    if (!have_) return false;
    const int i0 = std::max(0, (int)std::floor((c.x - r - ox_) / cell_)), i1 = std::min((int)gw_ - 1, (int)std::floor((c.x + r - ox_) / cell_));
    const int j0 = std::max(0, (int)std::floor((c.z - r - oz_) / cell_)), j1 = std::min((int)gh_ - 1, (int)std::floor((c.z + r - oz_) / cell_));
    float best = 0.f;
    bool found = false;
    for (int j = j0; j <= j1; ++j)
        for (int i = i0; i <= i1; ++i) {
            const uint32_t v = cpu_[(size_t)j * gw_ + (size_t)i];
            const int n = (int)(v >> 16 & 0xFFu), rotting = (int)(v >> 24);
            const float g = (float)(v & 0xFFu) / 64.f;
            if (n <= 0 || (v >> 8 & 0xFFu)) continue;   // nothing to burn / already burning
            if (n < minCorpses && !(g >= minGas && rotting > 0)) continue;
            const float x = ox_ + ((float)i + 0.5f) * cell_, z = oz_ + ((float)j + 0.5f) * cell_;
            const float d = std::sqrt((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z));
            if (d > r) continue;
            // whole pile around the cell (3 x 3) counts; rotting / gas weigh more; nearer piles win ties
            int pile = 0;
            for (int dj = -1; dj <= 1; ++dj)
                for (int di = -1; di <= 1; ++di) {
                    const int a = i + di, b = j + dj;
                    if (a >= 0 && b >= 0 && a < (int)gw_ && b < (int)gh_) pile += (int)(cpu_[(size_t)b * gw_ + (size_t)a] >> 16 & 0xFFu);
                }
            const float score = (float)pile + 2.f * (float)rotting + 6.f * g - 0.05f * d;
            if (score > best) { best = score; out = {x, c.y, z}; found = true; if (corpses) *corpses = pile; }
        }
    return found;
}

int CorpseGas::corpsesNear(V3 c, float r) const {
    if (!have_) return 0;
    int n = 0;
    const int i0 = std::max(0, (int)std::floor((c.x - r - ox_) / cell_)), i1 = std::min((int)gw_ - 1, (int)std::floor((c.x + r - ox_) / cell_));
    const int j0 = std::max(0, (int)std::floor((c.z - r - oz_) / cell_)), j1 = std::min((int)gh_ - 1, (int)std::floor((c.z + r - oz_) / cell_));
    for (int j = j0; j <= j1; ++j)
        for (int i = i0; i <= i1; ++i) {
            const float x = ox_ + ((float)i + 0.5f) * cell_ - c.x, z = oz_ + ((float)j + 0.5f) * cell_ - c.z;
            if (x * x + z * z <= r * r) n += (int)(cpu_[(size_t)j * gw_ + (size_t)i] >> 16 & 0xFFu);
        }
    return n;
}

void CorpseGas::fireSpots(float x, float z, int maxN, std::vector<std::array<float, 4>>& out) const {
    if (!have_ || maxN <= 0) return;
    struct S { float d; std::array<float, 4> v; };
    std::vector<S> all;
    for (uint32_t c = 0; c < cells_; ++c) {
        const uint32_t v = cpu_[c];
        if (!(v >> 8 & 0xFFu) || !(v >> 16 & 0xFFu)) continue;   // burning bodies only (bare ground fire: gas.vert voxels)
        const float wx = ox_ + ((float)(c % gw_) + 0.5f) * cell_, wz = oz_ + ((float)(c / gw_) + 0.5f) * cell_;
        const float d = (wx - x) * (wx - x) + (wz - z) * (wz - z);
        all.push_back({d, {wx, 0.f, wz, std::min(1.f, 0.35f + 0.1f * (float)(v >> 16 & 0xFFu))}});
    }
    std::sort(all.begin(), all.end(), [](const S& a, const S& b) { return a.d < b.d; });
    for (size_t k = 0; k < all.size() && (int)k < maxN; ++k) out.push_back(all[k].v);
}

void CorpseGas::tick(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    const RotConfig& R = ctx.cfg->rot;
    exposure_.resize(P.capacity(), 0.f);
    std::fill(exposure_.begin(), exposure_.end(), 0.f);
    if (!have_) return;
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i) || P.state[i] == SoldierState::Descending) continue;
        if (P.post[i] == POST_INSIDE) continue;                       // hospital patients are indoors
        const GasCell g = at(P.pos[i].x, P.pos[i].z);
        if (P.pos[i].y > 3.f && g.gas <= 0.f) continue;
        exposure_[i] = g.gas;
        if (g.gas <= R.damageThreshold) continue;
        const float dmg = std::min(R.maxDamagePerSecond, R.damagePerSecond * g.gas) * ctx.dt;
        P.health[i] -= dmg;
        gasDamage_ += dmg;
    }
    if (ctx.squads)
        for (Squad& s : ctx.squads->squads)
            for (const SoldierId& m : s.members)
                if (P.valid(m) && P.alive(m.index) && exposure_[m.index] > R.warnLevel) { s.flags |= SQ_GAS; break; }
}

} // namespace ttz::game
