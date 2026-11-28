// Headless validation of the GPU crowd simulation. Uses synchronous readbacks (test-only).
#include "app/SelfTest.h"

#include "city/CityAmbient.h"
#include "city/CityVehicles.h"
#include "game/Combat.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/HordeBridge.h"
#include "game/HordeVertical.h"
#include "game/CorpseGas.h"
#include "game/Soldiers.h"
#include "lab/TracerMotion.h"

#include "render/CharacterRenderer.h"
#include "render/Math.h"
#include "render/TimeOfDay.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <array>
#include <set>
#include <unordered_map>
#include <cstring>
#include <vector>

namespace ttz::game {
int runSoldierSelfTest(const BalanceConfig& cfg);
int runSupplySelfTest(const BalanceConfig& cfg);   // WS-D (src/game/SupplySelfTest.cpp)
int runFortSelfTest(const BalanceConfig& cfg);     // B2 (src/game/FortSelfTest.cpp)
int runSoldierAnimSelfTest(const std::string& assetDir);   // WS-B (src/game/SoldierAnimSelfTest.cpp)
}

namespace ttz {
namespace {

struct World {
    GpuContext* gpu;
    CrowdSim sim;
    Sandbox sb;
    SimParams p;
    std::vector<GpuAgent> agents;
    std::vector<float> staticH;
    std::vector<int> corpseH;
    uint32_t counters[C_COUNT];

    void run(int steps) {
        int done = 0;
        while (done < steps) {
            SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu->device());
            int n = std::min(30, steps - done);
            for (int i = 0; i < n; ++i) sim.step(cmd);
            SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
            SDL_WaitForGPUFences(gpu->device(), true, &f, 1);
            SDL_ReleaseGPUFence(gpu->device(), f);
            done += n;
        }
    }
    void read() {
        gpu->downloadNow(sim.counters(), counters, sizeof(counters));
        agents.resize(counters[C_LIVE]);
        if (!agents.empty()) gpu->downloadNow(sim.agents(), agents.data(), (uint32_t)(agents.size() * sizeof(GpuAgent)));
        staticH.resize(sim.numCells());
        corpseH.resize(sim.numCells());
        gpu->downloadNow(sim.staticHeight(), staticH.data(), (uint32_t)(staticH.size() * 4));
        gpu->downloadNow(sim.corpseHeight(), corpseH.data(), (uint32_t)(corpseH.size() * 4));
    }
    int cellOf(float x, float z) const {
        int cx = std::clamp((int)std::floor((x - sb.originX) / p.cellSize), 0, p.gridW - 1);
        int cz = std::clamp((int)std::floor((z - sb.originZ) / p.cellSize), 0, p.gridH - 1);
        return cz * p.gridW + cx;
    }
    float corpseAt(float x, float z) const { return corpseH[cellOf(x, z)] * 0.001f; }
    float ground(float x, float z, float feet) const {
        float s = staticH[cellOf(x, z)];
        return (feet >= s - p.stepUp ? s : 0.f) + corpseAt(x, z);
    }
};


// ------------------------------------------------------------------ character helpers (look layout, see common.glsl)
struct Look { uint32_t m[10]; uint32_t tier, decay, pal[8]; };
Look decodeLook(uint32_t x, uint32_t y) {
    Look l{};
    auto b = [](uint32_t w, int lo, int n) { return (w >> lo) & ((1u << n) - 1u); };
    // slot order: head, torso, uaL, faL, uaR, faR, thL, shL, thR, shR
    l.m[0] = b(x, 8, 3); l.m[1] = b(x, 11, 3); l.m[2] = b(x, 14, 3); l.m[4] = b(x, 17, 3); l.m[3] = b(x, 20, 3); l.m[5] = b(x, 23, 3);
    l.m[6] = b(x, 26, 3); l.m[8] = b(x, 29, 3); l.m[7] = b(y, 0, 3); l.m[9] = b(y, 3, 3);
    l.tier = b(y, 6, 2); l.decay = b(y, 8, 2);
    const int lo[8] = {10, 13, 17, 19, 22, 25, 27, 30}, n[8] = {3, 4, 2, 3, 3, 2, 3, 2};
    for (int i = 0; i < 8; ++i) l.pal[i] = b(y, lo[i], n[i]);
    return l;
}
// family module counts and decay levels (assets/characters/zombie_parts.json)
const uint32_t kFamCount[6] = {8, 7, 5, 6, 5, 6};
const uint32_t kSlotFam[10] = {0, 1, 2, 3, 2, 3, 4, 5, 4, 5};
const uint32_t kPalCount[8] = {8, 9, 4, 6, 6, 3, 5, 3};
const uint32_t kDecay[6][8] = {{0, 0, 0, 0, 1, 1, 2, 2}, {0, 0, 0, 0, 1, 2, 2}, {0, 0, 1, 1, 2}, {0, 0, 1, 1, 2, 2}, {0, 0, 1, 1, 2}, {0, 0, 1, 1, 1, 2}};
const float kPivot[10][3] = {{0, 14, 0}, {0, 8, 0}, {3, 13.5f, 0}, {3, 10, 0}, {-3, 13.5f, 0}, {-3, 10, 0}, {1.5f, 8, 0}, {1.5f, 4, 0}, {-1.5f, 8, 0}, {-1.5f, 4, 0}};
const int kParent[10] = {1, -1, 1, 2, 1, 4, -1, 6, -1, 8};
float halfToFloat(uint16_t h) {
    uint32_t s = (h >> 15) & 1, e = (h >> 10) & 31, m = h & 1023;
    float v = e == 0 ? std::ldexp((float)m, -24) : e == 31 ? INFINITY : std::ldexp((float)(m | 1024), (int)e - 25);
    return s ? -v : v;
}
V3 qrotCpu(const float q[4], V3 v) {
    V3 u{q[0], q[1], q[2]};
    V3 t = cross(u, v) * 2.0f;
    return v + t * q[3] + cross(u, t);
}

int g_fail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_fail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c);
    return buf;
}

struct Metrics {
    int nan = 0, penetrating = 0, deepOverlap = 0, elevated = 0, floating = 0;
    float maxFeet = 0, meanX = 0, p999Feet = 0;
    int byState[5] = {};
};

Metrics measure(World& w) {
    Metrics m;
    const float R = w.p.radius;
    std::unordered_map<int, std::vector<int>> grid;
    for (int i = 0; i < (int)w.agents.size(); ++i) grid[w.cellOf(w.agents[i].pos.x, w.agents[i].pos.z)].push_back(i);
    for (int i = 0; i < (int)w.agents.size(); ++i) {
        const GpuAgent& a = w.agents[i];
        uint32_t st = a.info.x & 0xFF;
        if (st < 5) m.byState[st]++;
        if (!std::isfinite(a.pos.x) || !std::isfinite(a.pos.y) || !std::isfinite(a.pos.z)) { ++m.nan; continue; }
        m.meanX += a.pos.x;
        float s = w.staticH[w.cellOf(a.pos.x, a.pos.z)];
        if (s > 0 && a.pos.y < s - w.p.stepUp - 0.05f) ++m.penetrating;
        float g = w.ground(a.pos.x, a.pos.z, a.pos.y);
        float elev = a.pos.y - g;
        m.maxFeet = std::max(m.maxFeet, a.pos.y);
        float hi = w.p.standHeight + (w.p.proneHeight - w.p.standHeight) * std::clamp(a.pos.w, 0.f, 1.f);
        bool hasSupport = elev < 0.35f;
        float worst = 0;
        int cx = w.cellOf(a.pos.x, a.pos.z);
        for (int dz = -1; dz <= 1; ++dz)
            for (int dx = -1; dx <= 1; ++dx) {
                auto it = grid.find(cx + dz * w.p.gridW + dx);
                if (it == grid.end()) continue;
                for (int j : it->second) {
                    if (j == i) continue;
                    const GpuAgent& b = w.agents[j];
                    float ddx = a.pos.x - b.pos.x, ddz = a.pos.z - b.pos.z;
                    float hd = std::sqrt(ddx * ddx + ddz * ddz);
                    float hj = w.p.standHeight + (w.p.proneHeight - w.p.standHeight) * std::clamp(b.pos.w, 0.f, 1.f);
                    // capsule-capsule distance (vertical segments)
                    float a0 = a.pos.y + R, a1 = a.pos.y + std::max(hi - R, R);
                    float b0 = b.pos.y + R, b1 = b.pos.y + std::max(hj - R, R);
                    float gap = a0 > b1 ? a0 - b1 : (b0 > a1 ? b0 - a1 : 0.f);
                    float dist = std::sqrt(hd * hd + gap * gap);
                    worst = std::max(worst, 2 * R - dist);
                    if (hd < 2.2f * R && b.pos.y + hj >= a.pos.y - 0.35f && b.pos.y < a.pos.y) hasSupport = true;
                }
            }
        if (worst > R) ++m.deepOverlap;   // centres closer than one radius
        if (elev > 0.5f && st != ST_FALL && st != ST_DYING) {
            ++m.elevated;
            if (!hasSupport) ++m.floating;
        }
    }
    if (!w.agents.empty()) {
        m.meanX /= w.agents.size();
        std::vector<float> ys;
        for (auto& a : w.agents) ys.push_back(a.pos.y);
        std::sort(ys.begin(), ys.end());
        m.p999Feet = ys[std::min(ys.size() - 1, (size_t)(ys.size() * 0.999))];
    }
    return m;
}

void dump(World& w, const char* dir, const char* name) {
    if (!dir) return;
    std::string path = std::string(dir) + "/" + name + ".csv";
    FILE* f = std::fopen(path.c_str(), "w");
    if (!f) return;
    std::fprintf(f, "x,y,z,prone,state\n");
    for (auto& a : w.agents) std::fprintf(f, "%.3f,%.3f,%.3f,%.2f,%u\n", a.pos.x, a.pos.y, a.pos.z, a.pos.w, a.info.x & 0xFF);
    std::fclose(f);
}

void dumpFields(World& w, const char* dir) {
    if (!dir) return;
    uint32_t n = w.sim.numCells();
    std::vector<float> dist(n), dir2(n * 2);
    w.gpu->downloadNow(w.sim.navDist(), dist.data(), n * 4);
    w.gpu->downloadNow(w.sim.navDir(), dir2.data(), n * 8);
    std::string path = std::string(dir) + "/nav.csv";
    FILE* f = std::fopen(path.c_str(), "w");
    std::fprintf(f, "cx,cz,dist,dx,dz,static\n");
    for (uint32_t i = 0; i < n; ++i)
        std::fprintf(f, "%u,%u,%.2f,%.3f,%.3f,%.1f\n", i % w.p.gridW, i / w.p.gridW, dist[i], dir2[2 * i], dir2[2 * i + 1], w.staticH[i]);
    std::fclose(f);
}

void printSummary(World& w, const Metrics& m, const char* label) {
    std::printf("  %-28s live=%zu corpses=%u deaths=%u walk=%d climb=%d fall=%d dying=%d elevated=%d maxFeet=%.2f\n", label,
                w.agents.size(), std::min<uint32_t>(w.counters[C_CORPSES], w.p.corpseCapacity), w.counters[C_DEATHS_TOTAL],
                m.byState[0], m.byState[1], m.byState[2], m.byState[3], m.elevated, m.maxFeet);
}

void testMovingWindow(World& w, GpuContext& gpu, const SimParams& params) {
    // ---------------------------------------------------------------- 9. moving simulation window (city)
    std::printf("[9] moving simulation window: grid fields shift, agents park and return, obstacles follow\n");
    {
        w.sim.reset(w.sb);
        w.sim.setGoals({});
        w.sim.requestSpawn(Rect{-70.f, -60.f, 40.f, 60.f}, 4000);
        w.run(30);
        w.read();
        for (int k = 0; k < 10; ++k) {
            const GpuAgent& t = w.agents[(size_t)(k * 2654435761u) % w.agents.size()];
            w.sim.requestExplosion(t.pos.x, 0.3f, t.pos.z);
            w.run(20);
        }
        w.run(60 * 4);
        w.read();
        const uint32_t W = (uint32_t)params.gridW, H = (uint32_t)params.gridH, DW = W * 3, DH = H * 3;
        auto snapshot = [&](std::vector<uint32_t>& dec, std::vector<GpuAgent>& all, uint32_t& n) {
            dec.resize((size_t)3 * DW * DH);
            gpu.downloadNow(w.sim.decals(), dec.data(), (uint32_t)(dec.size() * 4));
            gpu.downloadNow(w.sim.counters(), w.counters, sizeof(w.counters));
            n = w.counters[C_LIVE] + w.counters[C_APPEND];
            all.resize(n);
            if (n) gpu.downloadNow(w.sim.agents(), all.data(), n * (uint32_t)sizeof(GpuAgent));
            w.staticH.resize(W * H);
            w.corpseH.resize(W * H);
            gpu.downloadNow(w.sim.staticHeight(), w.staticH.data(), W * H * 4);
            gpu.downloadNow(w.sim.corpseHeight(), w.corpseH.data(), W * H * 4);
        };
        auto livePositions = [&](const std::vector<GpuAgent>& all) {
            std::vector<std::array<float, 3>> v;
            for (auto& a : all) if ((a.info.x & 0xFF) != ST_DEAD) v.push_back({a.pos.x, a.pos.y, a.pos.z});
            std::sort(v.begin(), v.end());
            return v;
        };
        std::vector<uint32_t> decA, decB;
        std::vector<GpuAgent> agA, agB;
        uint32_t nA, nB;
        snapshot(decA, agA, nA);
        std::vector<int> corA = w.corpseH;
        w.read();
        Metrics mBefore = measure(w);
        std::printf("  before the move: live %zu, penetrating %d\n", w.agents.size(), mBefore.penetrating);
        auto posA = livePositions(agA);
        const int dx = 64, dz = 32;
        Sandbox moved = w.sb;
        moved.originX += dx * params.cellSize;
        moved.originZ += dz * params.cellSize;
        std::vector<float> hMoved = moved.rasterize();
        auto relocate = [&](int sx, int sz, const std::vector<float>& h) {
            SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
            w.sim.relocate(cmd, sx, sz, h);
            SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
            SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
            SDL_ReleaseGPUFence(gpu.device(), f);
        };
        relocate(dx, dz, hMoved);
        snapshot(decB, agB, nB);
        long decalMismatch = 0, exposedDirty = 0, corpseMismatch = 0;
        double bloodOverlap = 0;
        for (uint32_t l = 0; l < 3; ++l)
            for (uint32_t z = 0; z < DH; ++z)
                for (uint32_t x = 0; x < DW; ++x) {
                    int ox = (int)x + 3 * dx, oz = (int)z + 3 * dz;
                    uint32_t b = decB[(size_t)l * DW * DH + z * DW + x];
                    if (ox < (int)DW && oz < (int)DH) {
                        uint32_t a = decA[(size_t)l * DW * DH + oz * DW + ox];
                        decalMismatch += a != b;
                        if (l == 0) bloodOverlap += b;
                    } else exposedDirty += b != 0;
                }
        for (uint32_t z = 0; z + dz < H; ++z)
            for (uint32_t x = 0; x + dx < W; ++x) corpseMismatch += w.corpseH[z * W + x] != corA[(z + dz) * W + x + dx];
        check(decalMismatch == 0 && exposedDirty == 0 && bloodOverlap > 0, "blood / scorch decals shift with the window (overlap kept, new strips clean)",
              fmt("mismatch=%.0f dirty=%.0f blood in overlap=%.0f", (double)decalMismatch, (double)exposedDirty, bloodOverlap));
        check(corpseMismatch == 0, "corpse heights shift with the window", fmt("mismatch=%.0f", (double)corpseMismatch));
        bool staticOk = std::equal(hMoved.begin(), hMoved.end(), w.staticH.begin());
        check(staticOk, "static heights of the new window uploaded", "");
        std::vector<uint32_t> pc(4);
        gpu.downloadNow(w.sim.parkCounts(), pc.data(), 16);
        uint32_t parked = pc[w.sim.parkedList()];
        auto posB = livePositions(agB);
        const float x0 = moved.originX, z0 = moved.originZ, x1 = x0 + W * params.cellSize, z1 = z0 + H * params.cellSize;
        int outside = 0;
        for (auto& p : posB) outside += p[0] < x0 || p[0] > x1 || p[2] < z0 || p[2] > z1;
        check(parked > 0 && posB.size() + parked == posA.size() && outside == 0 && pc[2] == 0,
              "agents leaving the window are parked, the others continue untouched",
              fmt("live %.0f -> %.0f + parked %.0f", (double)posA.size(), (double)posB.size(), (double)parked));
        // and back: parked agents return unchanged; strips that were dropped get their corpse heights back from the corpse list
        relocate(-dx, -dz, w.sb.rasterize());
        std::vector<uint32_t> decC;
        std::vector<GpuAgent> agC;
        uint32_t nC;
        snapshot(decC, agC, nC);
        auto posC = livePositions(agC);
        long corpseDiff = 0;
        for (uint32_t i = 0; i < W * H; ++i) corpseDiff += std::abs(w.corpseH[i] - corA[i]) > 2;
        check(posC == posA, "round trip: every agent is back where it was", fmt("%.0f of %.0f", (double)posC.size(), (double)posA.size()));
        check(corpseDiff == 0, "round trip: corpse height field rebuilt from the corpses in re-exposed strips",
              fmt("cells off by > 2 mm: %.0f", (double)corpseDiff));
        // keep simulating after a move: the horde must still collide with the moved obstacles
        relocate(dx, dz, hMoved);
        w.sb = moved;
        w.sim.setGoals({0.f, 100.f});   // up the cross street, inside the moved window
        w.run(1);
        w.read();
        Metrics m0 = measure(w);
        w.run(60 * 6);
        w.read();
        Metrics mm = measure(w);
        std::printf("  after the move: penetrating %d (1 step) -> %d (6 s)\n", m0.penetrating, mm.penetrating);
        int outsideNow = 0;
        for (auto& a : w.agents) outsideNow += a.pos.x < x0 || a.pos.x > x1 || a.pos.z < z0 || a.pos.z > z1;
        check(mm.nan == 0 && mm.penetrating <= (int)(w.agents.size() / 200) && outsideNow == 0, "after the move agents stay out of obstacles and inside the window",
              fmt("live=%.0f penetrating=%.0f outside=%.0f", (double)w.agents.size(), mm.penetrating, outsideNow));
    }
}


// ---------------------------------------------------------------- 10. dynamic city vehicles
// A jammed row of cars (+ a fuel tanker at the end) on an open street of the test map, zombies around them; one blast
// at the head of the row. Rigid bodies, fuses, chain reaction, settling, obstacle stamping, persistence.
void testVehicles(World& w, GpuContext& gpu, const SimParams& params) {
    std::printf("[10] city vehicles: blast -> move, fuse, explode, chain reaction, settle, obstacles for zombies\n");
    Sandbox street = w.sb;   // the test map without its abandoned cars / barricades: an open avenue between buildings
    if (std::getenv("TTZ_VEH_SHIFT")) { street.originX += 64 * params.cellSize; street.originZ += 32 * params.cellSize; w.sb = street; }
    street.boxes.erase(std::remove_if(street.boxes.begin(), street.boxes.end(),
                                      [](const Box& b) { return b.kind == BoxKind::Car || b.kind == BoxKind::Barricade; }),
                       street.boxes.end());
    w.sim.reset(street);
    w.sim.setGoals({});
    const std::vector<float> heights = street.rasterize();
    const int W = params.gridW, H = params.gridH;
    const float cell = params.cellSize, ox = w.sb.originX, oz = w.sb.originZ;
    // open strip 66 x 9 cells (~50 x 7 m) with a building within 8 m of its side
    int bx = -1, bz = -1;
    for (int z = 12; z + 21 < H && bx < 0; ++z)
        for (int x = 8; x + 74 < W && bx < 0; x += 2) {
            bool open = true;
            for (int k = 0; k < 9 && open; ++k)
                for (int i = 0; i < 66 && open; ++i) open = heights[(size_t)(z + k) * W + x + i] == 0.f;
            if (!open) continue;
            bool wall = false;
            for (int k = -10; k < 19 && !wall; ++k)
                if (k < 0 || k >= 9) wall = heights[(size_t)(z + k) * W + x + 33] > 2.f;
            if (wall) { bx = x; bz = z; }
        }
    check(bx >= 0, "test map has an open street next to a building", fmt("cell (%.0f, %.0f)", bx, bz));
    if (bx < 0) return;
    const float rowZ = oz + (bz + 4.5f) * cell, rowX = ox + (bx + 4) * cell;
    // models: sedan ok / damaged / burnt (lower), fuel tanker (no burnt mesh: damaged + charcoal paint)
    std::vector<VehicleModel> models(4);
    auto box = [](VehicleModel& m, float l, float h, float wd) { m.bmin[0] = -l / 2; m.bmax[0] = l / 2; m.bmin[1] = 0; m.bmax[1] = h; m.bmin[2] = -wd / 2; m.bmax[2] = wd / 2; };
    for (int k = 0; k < 3; ++k) { models[k].kind = "sedan"; models[k].stateTag = k == 2 ? 3 : k; box(models[k], 4.8f, k == 2 ? 1.3f : 1.5f, 2.f); models[k].damaged = 1; models[k].burnt = 2; }
    models[3].kind = "tanker_trailer"; box(models[3], 12.f, 3.6f, 2.5f); models[3].mass = 4.5f; models[3].blastScale = 2.2f; models[3].darkenBurnt = true;
    CityVehicles veh;
    veh.initModels(models);
    if (const char* sd = std::getenv("TTZ_VEH_SEED")) veh.seed((uint32_t)std::atoi(sd));
    veh.setWindow(ox, oz, cell, W, H, heights);
    std::vector<CityInstance> inst;
    const int nCars = 7;
    for (int k = 0; k < nCars; ++k) inst.push_back({rowX + 2.4f + k * 5.4f, 0.f, rowZ, {0, 0, 0, 1}, {0.5f, 0.1f, 0.1f, 1.f}, 0, 0});
    inst.push_back({rowX + 2.4f + (nCars - 1) * 5.4f + 2.4f + 2.2f + 6.f, 0.f, rowZ, {0, 0, 0, 1}, {0.8f, 0.8f, 0.8f, 1.f}, 3, 0});
    veh.registerTile(0, inst);
    const uint32_t nV = veh.count();
    auto frame = [&](float dt) {
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
        veh.update(cmd, dt, w.sim);
        if (dt > 0) w.sim.step(cmd);
        SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
        SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
        SDL_ReleaseGPUFence(gpu.device(), f);
    };
    frame(0.f);   // parked cars stamped into the obstacle grid
    w.read();
    bool stamped = std::equal(veh.simHeights().begin(), veh.simHeights().end(), w.staticH.begin());
    int carCells = 0;
    for (size_t c = 0; c < w.staticH.size(); ++c) carCells += w.staticH[c] > 1.f && heights[c] == 0.f;
    check(stamped && carCells > nCars * 12, "parked vehicles are obstacles in the simulation grid", fmt("vehicle cells=%.0f", carCells));
    // zombies on both sides of the row
    w.sim.requestSpawn(Rect{rowX - 6.f, rowZ - 3.2f, rowX + 50.f, rowZ - 1.4f}, 300);
    w.sim.requestSpawn(Rect{rowX - 6.f, rowZ + 1.4f, rowX + 50.f, rowZ + 3.2f}, 300);
    for (int k = 0; k < 30; ++k) frame(1.f / 60.f);
    // the blast: just off the head of the row
    w.sim.requestExplosion(rowX - 1.5f, 0.4f, rowZ - 0.5f);
    std::vector<float> explodedAt(nV, -1.f);
    float maxMove0 = 0, maxAngle0 = 0, maxHeight = 0;
    int nanFrames = 0, explosionsPerFrameMax = 0;
    const float dt = 1.f / 60.f;
    float t = 0;
    auto runUntilSettled = [&](float maxSeconds) {
        for (int f = 0; f < (int)(60 * maxSeconds); ++f, t += dt) {
            uint32_t before = veh.stats().explosions;
            frame(dt);
            explosionsPerFrameMax = std::max(explosionsPerFrameMax, (int)(veh.stats().explosions - before));
            bool fuses = false;
            for (uint32_t i = 0; i < nV; ++i) {
                const Vehicle& v = veh.vehicle(i);
                if (!std::isfinite(v.p[0]) || !std::isfinite(v.p[1]) || !std::isfinite(v.p[2]) || !std::isfinite(v.q[3])) ++nanFrames;
                if (v.state == VehState::Wrecked && explodedAt[i] < 0) explodedAt[i] = t;
                maxHeight = std::max(maxHeight, v.p[1]);
                fuses |= v.state == VehState::Burning;
            }
            const Vehicle& v0 = veh.vehicle(0);
            maxMove0 = std::max(maxMove0, std::hypot(v0.ro[0] - v0.bp[0], v0.ro[2] - v0.bp[2]));
            maxAngle0 = std::max(maxAngle0, 2.f * std::acos(std::min(1.f, std::fabs(v0.q[3]))) * 57.3f);
            if (f > 60 * 4 && veh.stats().active == 0 && !fuses) break;
        }
    };
    runUntilSettled(25.f);
    // the fuel tanker at the end of the row: blown up directly if the chain did not reach it
    const float tankerHit = t;
    if (explodedAt[nV - 1] < 0) {
        const Vehicle& tk = veh.vehicle(nV - 1);
        w.sim.requestExplosion(tk.p[0], 0.4f, tk.p[2] - 2.5f);
        runUntilSettled(15.f);
    }
    int carsExploded = 0;
    for (int k = 0; k < nCars; ++k) carsExploded += explodedAt[k] >= 0;
    std::printf("  exploded at (s):");
    for (uint32_t i = 0; i < nV; ++i) std::printf(" %.2f", explodedAt[i]);
    std::printf("   (%u explosions, max %d per frame, peak height %.1f m)\n", veh.stats().explosions, explosionsPerFrameMax, maxHeight);
    check(maxMove0 > 0.8f || maxAngle0 > 25.f, "the blast moves / tumbles the nearest car", fmt("moved %.2f m, turned %.0f deg", maxMove0, maxAngle0));
    check(explodedAt[0] >= 0.4f && explodedAt[0] <= 3.7f, "the car blows up after a 0.5-3 s fuse", fmt("%.2f s", explodedAt[0]));
    // (each explosion also throws the next car away, so the chain may stop before the end of the row)
    check(carsExploded >= 3, "chain reaction along the jammed row", fmt("%.0f of %.0f cars", carsExploded, nCars));
    check(explodedAt[nV - 1] > explodedAt[0], explodedAt[nV - 1] <= tankerHit ? "the fuel tanker explodes (chain)" : "the fuel tanker explodes (direct hit)",
          fmt("at %.2f s", explodedAt[nV - 1]));
    bool ordered = true;   // the chain travels down the row (later cars do not go first)
    for (int k = 2; k < nCars; ++k) ordered &= explodedAt[k] < 0 || explodedAt[k] >= explodedAt[0];
    check(ordered && explosionsPerFrameMax <= CityVehicles::kMaxBlastsPerFrame, "chain is sequential, explosions per frame capped",
          fmt("max per frame %.0f", explosionsPerFrameMax));
    check(nanFrames == 0, "no NaN vehicle states", fmt("%.0f", nanFrames));
    check(veh.vehicle(0).variant == 2 && veh.vehicle(nV - 1).paint[0] < 0.05f, "wrecks swap to the burnt variant (charcoal paint without one)", "");
    // settled: asleep, resting on the ground (or another wreck), not sunk, not inside a building
    int awake = 0, floating = 0, sunk = 0, inBuilding = 0, onSideOrRoof = 0;
    for (uint32_t i = 0; i < nV; ++i) {
        const Vehicle& v = veh.vehicle(i);
        awake += v.active;
        float c[8][3], clear = 1e9f;
        veh.worldCorners(v, c);
        for (auto& k : c) {
            // corners pulled 0.2 m towards the centre: the contact skin (corners resolve against 0.75 m cells)
            float dx = v.p[0] - k[0], dz = v.p[2] - k[2], dl = std::max(1e-3f, std::hypot(dx, dz));
            k[0] += dx / dl * 0.2f;
            k[2] += dz / dl * 0.2f;
            float g = veh.groundAt(k[0], k[2]);
            clear = std::min(clear, k[1] - g);
            if (g > k[1] + 1.0f) ++inBuilding;
        }
        if (veh.groundAt(v.p[0], v.p[2]) > v.p[1] + 0.3f) ++inBuilding;
        bool onOther = false;
        for (uint32_t j = 0; j < nV; ++j)
            if (j != i && std::hypot(veh.vehicle(j).p[0] - v.p[0], veh.vehicle(j).p[2] - v.p[2]) < 5.f && veh.vehicle(j).p[1] < v.p[1]) onOther = true;
        if (std::getenv("TTZ_VEH_DEBUG"))
            std::printf("  vehicle %u: p (%.2f %.2f %.2f) state %d clear %.2f ground %.2f baked (%.1f %.1f)\n", i, v.p[0], v.p[1], v.p[2], (int)v.state,
                        clear, veh.groundAt(v.p[0], v.p[2]), v.bp[0], v.bp[2]);
        if (std::getenv("TTZ_VEH_DEBUG"))
            for (auto& k : c) std::printf("     corner (%.2f %.2f %.2f) ground %.2f\n", k[0], k[1], k[2], veh.groundAt(k[0], k[2]));
        if (clear > 0.4f && !onOther) ++floating;
        if (clear < -0.3f) ++sunk;
        float uy = 1 - 2 * (v.q[0] * v.q[0] + v.q[2] * v.q[2]);   // local up . world up
        onSideOrRoof += uy < 0.5f;
    }
    std::printf("  settled: %d on side / roof of %u\n", onSideOrRoof, nV);
    check(awake == 0 && floating == 0 && sunk == 0, "vehicles settle on the ground", fmt("awake=%.0f floating=%.0f sunk=%.0f", awake, floating, sunk));
    check(inBuilding == 0, "no vehicle inside a building", fmt("corners / centres inside=%.0f", inBuilding));
    // zombies vs vehicles: obstacle grid uploaded, nobody walking inside a car
    for (int k = 0; k < 90; ++k) frame(dt);
    w.read();
    stamped = std::equal(veh.simHeights().begin(), veh.simHeights().end(), w.staticH.begin());
    int inside = 0, checkedAgents = 0;
    for (const GpuAgent& a : w.agents) {
        uint32_t st = a.info.x & 0xFF;
        if (st == ST_FALL || st == ST_DYING || st == ST_DEAD || !std::isfinite(a.pos.x)) continue;
        ++checkedAgents;
        for (uint32_t i = 0; i < nV; ++i) {
            const Vehicle& v = veh.vehicle(i);
            const VehicleModel& M = veh.model(v.variant);
            // agent position in the vehicle frame (model origin)
            float d[3] = {a.pos.x - v.ro[0], a.pos.y + 0.5f - v.ro[1], a.pos.z - v.ro[2]};
            float qx = -v.q[0], qy = -v.q[1], qz = -v.q[2], qw = v.q[3];   // inverse rotation
            float tx = 2 * (qy * d[2] - qz * d[1]), ty = 2 * (qz * d[0] - qx * d[2]), tz = 2 * (qx * d[1] - qy * d[0]);
            float l[3] = {d[0] + qw * tx + (qy * tz - qz * ty), d[1] + qw * ty + (qz * tx - qx * tz), d[2] + qw * tz + (qx * ty - qy * tx)};
            const float in = 0.25f;
            if (l[0] > M.bmin[0] + in && l[0] < M.bmax[0] - in && l[1] > M.bmin[1] + in && l[1] < M.bmax[1] - in && l[2] > M.bmin[2] + in &&
                l[2] < M.bmax[2] - in) {
                if (std::getenv("TTZ_VEH_DEBUG"))
                    std::printf("  inside: agent (%.2f %.2f %.2f) st %u local (%.2f %.2f %.2f) of vehicle %u, cell top %.2f\n", a.pos.x, a.pos.y,
                                a.pos.z, st, l[0], l[1], l[2], i, w.staticH[w.cellOf(a.pos.x, a.pos.z)]);
                ++inside;
                break;
            }
        }
    }
    check(stamped, "moved vehicles update the simulation's obstacle grid", "");
    check(checkedAgents > 100 && inside <= std::max(2, checkedAgents / 200), "zombies are not inside vehicles",
          fmt("%.0f of %.0f standing zombies inside a vehicle box", inside, checkedAgents));
    // persistence: window away and back -> same wrecks, same poses, same obstacle grid
    std::vector<Vehicle> snap;
    for (uint32_t i = 0; i < nV; ++i) snap.push_back(veh.vehicle(i));
    std::vector<float> gridBefore = veh.simHeights();
    std::vector<float> away(heights.size(), 0.f);
    veh.setWindow(ox + 300.f, oz, cell, W, H, away);
    frame(0.f);
    veh.registerTile(0, inst);   // the renderer re-uploading the tile must not reset it
    veh.setWindow(ox, oz, cell, W, H, heights);
    frame(0.f);
    bool same = true;
    for (uint32_t i = 0; i < nV; ++i)
        same &= std::memcmp(snap[i].ro, veh.vehicle(i).ro, 12) == 0 && snap[i].state == veh.vehicle(i).state && snap[i].variant == veh.vehicle(i).variant;
    check(same && veh.simHeights() == gridBefore, "destroyed vehicles persist when the window moves away and back", "");
    w.sim.reset(w.sb);
}
} // namespace

// Gameplay core (CPU, docs/GAMEPLAY_ARCHITECTURE.md 3.7): balance file, approved squad compositions, kill dedupe,
// handle generations, deterministic spread. Workstreams extend this section with their acceptance tests.
void testGameCore() {
    using namespace game;
    std::printf("game core\n");
    BalanceConfig cfg;
    std::string err;
    const bool loaded = cfg.load(std::string(TTZ_SOURCE_DIR) + "/config/balance.json", &err);
    check(loaded && cfg.status == "UNAPPROVED" && !cfg.approved(), "balance.json loads and is labelled UNAPPROVED", loaded ? cfg.status : err);
    check(cfg.squad[0].size == 5 && cfg.squad[1].size == 3 && cfg.squad[2].size == 1 && cfg.squad[1].cls == SoldierClass::MachineGunner,
          "squad compositions: rifle 5, machine gun 3, sniper 1", fmt("%.0f / %.0f / %.0f", cfg.squad[0].size, cfg.squad[1].size, cfg.squad[2].size));
    Economy eco;
    eco.reset(cfg);
    const double f0 = eco.funding();
    KillEvent k;
    k.cause = KillCause::Soldier;
    int credited = 0;
    for (uint64_t seq : {1ull, 2ull, 2ull, 3ull, 1ull, 3ull, 4ull}) { k.seq = seq; credited += eco.creditKill(k, 0.0) ? 1 : 0; }
    check(credited == 4 && eco.kills() == 4 && std::fabs(eco.funding() - (f0 + 4 * cfg.economy.killReward[0])) < 1e-6,
          "kill rewards deduplicated by sequence number", fmt("credited %.0f of 7 records, funding +%.0f", credited, eco.funding() - f0));
    const double f1 = eco.funding();
    check(!eco.spend(f1 + 1, "too much", 0) && eco.funding() == f1 && eco.spend(100, "squad", 0) && eco.funding() == f1 - 100,
          "purchases: unaffordable refused without charge, affordable charged once", "");
    SoldierPool pool;
    SquadId sq;
    sq.index = 0; sq.gen = 1;
    SoldierId a = pool.spawn(SoldierClass::Rifleman, 0, sq, 0, {}, 0, 1);
    pool.release(a);
    SoldierId b = pool.spawn(SoldierClass::Sniper, 0, sq, 0, {}, 0, 2);
    check(a.index == b.index && !pool.valid(a) && pool.valid(b), "soldier handles: a reused slot invalidates the old handle", "");
    uint32_t r1 = 7, r2 = 7;
    V3 d1 = Combat::spreadDir({0, 0, 1}, 2.f, r1), d2 = Combat::spreadDir({0, 0, 1}, 2.f, r2);
    check(d1.x == d2.x && d1.y == d2.y && d1.z == d2.z && d1.z > std::cos(2.01f * 3.14159265f / 180.f), "shot spread is deterministic and inside the cone", "");
    {   // owner 2026-11-28: rounds cluster toward the cone axis (rifle cone 1.0 deg): body hits at 50 m with perfect aim
        uint32_t rs = 99;
        int in50 = 0, inCone = 0;
        for (int k = 0; k < 4000; ++k) {
            const V3 d = Combat::spreadDir({0, 0, 1}, 1.f, rs);
            inCone += d.z >= std::cos(1.0001f * 3.14159265f / 180.f) ? 1 : 0;
            const float x = d.x / d.z * 50.f, y = 1.1f + d.y / d.z * 50.f;
            in50 += std::fabs(x) < 0.26f && y > 0.f && y < 1.75f ? 1 : 0;
        }
        check(inCone == 4000 && in50 > 4000 * 0.6, "shot spread: inside the cone, >= 60 % body hits at 50 m (1 deg cone)", fmt("%.1f %%", in50 / 40.0));
    }
    {   // owner 2026-11-28 (14e): tracers start at the barrel and travel visibly (TracerMotion, MilitaryRenderer::fxTracer)
        float head, tail;
        TracerMotion::span(0.f, TracerMotion::kSpeedRifle, 60.f, 4.5f, head, tail);
        const bool atMuzzle = tail == 0.f && head > 0.5f && head <= 1.5f;
        int frames60 = 0, frames20 = 0;   // frames with the head short of the target (travelling), 60 / 20 fps
        for (float fdt : {1.f / 60.f, 1.f / 20.f}) {
            float age = 0.f;
            int n = 0;
            for (int f = 0; f < 200 && age < TracerMotion::life(TracerMotion::kSpeedRifle, 60.f, 4.5f); ++f) {
                TracerMotion::span(age, TracerMotion::kSpeedRifle, 60.f, 4.5f, head, tail);
                n += head < 60.f ? 1 : 0;
                age += TracerMotion::step(fdt, TracerMotion::kSpeedRifle, 60.f);
            }
            (fdt < 0.02f ? frames60 : frames20) = n;
        }
        check(atMuzzle && frames60 >= 5 && frames20 >= 5 && TracerMotion::kSpeedRifle <= 0.81f * 750.f,
              "tracer: head at the muzzle at t = 0, a 60 m shot travels over >= 5 frames (60 and 20 fps), 20 % slower",
              fmt("frames %.0f / %.0f at 60 / 20 fps, muzzle start %.0f", frames60, frames20, atMuzzle ? 1.0 : 0.0));
    }
    g_fail += runSoldierSelfTest(cfg);   // WS-C section "ai / nav" (src/game/SoldierSelfTest.cpp)
    g_fail += runSupplySelfTest(cfg);    // WS-D section "economy / logistics / deploy" (src/game/SupplySelfTest.cpp)
    g_fail += runFortSelfTest(cfg);      // B2 section "walls / territory" (src/game/FortSelfTest.cpp)
    g_fail += runSoldierAnimSelfTest(std::string(TTZ_SOURCE_DIR) + "/assets/military");   // WS-B section "anim"
}

// ---------------------------------------------------------------------------------------------- ambient roaming
// Idle zombies spread over the streets (no tight clumps), wander (move, pause, follow streets, lurkers at walls), are
// pulled by a noise source within the awareness gate, then disperse gradually after it fades (alert memory).
uint32_t pcgHashCpu(uint32_t v) {
    uint32_t state = v * 747796405u + 2891336453u;
    uint32_t word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
uint32_t roamKindCpu(uint32_t lookY, const SimParams& p) {
    float h = (float)(pcgHashCpu(lookY * 2246822519u + 3266489917u) & 0x00FFFFFFu) / 16777216.f;
    return h < p.roamLurkers ? 1u : (h < p.roamLurkers + p.roamCrawlers ? 2u : 0u);
}
void testRoaming(World& w, GpuContext& gpu, const SimParams& params) {
    std::printf("[R] ambient roaming: spread, wandering, noise pull and dispersal\n");
    (void)gpu;
    AmbientConfig amb;   // built-in (UNAPPROVED) defaults, denser than the city default for the statistics
    amb.densityPerHa = 400.f;
    SimParams& sp = w.sim.params();
    const SimParams saved = sp;
    amb.apply(sp);
    w.p = sp;
    const Sandbox keep = w.sb;
    w.sb.build(params.cellSize, params.gridW, params.gridH, MapKind::City);   // the synthetic street map, whatever ran before
    w.sim.reset(w.sb);
    w.sim.setGoals({});
    const std::vector<float> heights = w.sb.rasterize();
    std::vector<Vec4> pts = ambientSpawnPoints(heights, params.gridW, params.gridH, w.sb.originX, w.sb.originZ, params.cellSize, amb, 7, -1);
    {
        std::vector<float> xz;
        for (const Vec4& q : pts) { xz.push_back(q.x); xz.push_back(q.y); }
        SpreadStats st = spreadStats(xz, 2.0f);
        std::printf("  placement: %zu points, nn median %.2f m (p10 %.2f), clusters %zu (singles %zu, largest %zu, mean %.2f)\n", st.n,
                    st.nnMedian, st.nnP10, st.clusters, st.singles, st.largestCluster, st.meanClusterSize);
        size_t openCells = 0;
        for (int z = 1; z < params.gridH - 1; ++z)
            for (int x = 1; x < params.gridW - 1; ++x) openCells += heights[(size_t)z * params.gridW + x] <= 0.f ? 1 : 0;
        const double expect = amb.densityPerHa * openCells * params.cellSize * params.cellSize / 1e4;
        check(st.n > 100 && std::fabs((double)st.n - expect) < expect * 0.1, "ambient placement fills the window from the density",
              fmt("%.0f zombies, %.0f expected (%.2f ha open)", (double)st.n, expect, openCells * params.cellSize * params.cellSize / 1e4));
        check(st.singles > st.n / 12 && st.largestCluster <= 40 && st.fracInClustersOver20 < 0.3f,
              "placement: scattered singles, small groups, few large clusters",
              fmt("singles %.0f, largest %.0f, in clusters > 20: %.2f", (double)st.singles, (double)st.largestCluster, st.fracInClustersOver20));
    }
    auto dump = [&](const char* tag) {
        const char* dir = std::getenv("TTZ_ROAM_DUMP");
        if (!dir) return;
        std::string path = std::string(dir) + "/roam_" + tag + ".csv";
        if (FILE* f = std::fopen(path.c_str(), "w")) {
            for (const GpuAgent& a : w.agents) std::fprintf(f, "%.2f,%.2f,%u,%u\n", a.pos.x, a.pos.z, a.info.z >> 28, roamKindCpu(a.info.y, sp));
            std::fclose(f);
        }
    };
    auto live = [&]() {
        std::vector<float> xz;
        for (const GpuAgent& a : w.agents)
            if ((a.info.x & 0xFF) < ST_DYING) { xz.push_back(a.pos.x); xz.push_back(a.pos.z); }
        return xz;
    };
    auto keyOf = [](const GpuAgent& a) { return ((uint64_t)a.info.x << 32) ^ a.info.y; };   // look bits: identity across sorts
    w.sim.requestSpawnPoints(pts);
    w.run(2);
    w.read();
    const size_t n0 = w.agents.size();
    check(n0 + 5 >= pts.size() * 98 / 100, "every ambient point spawns (open ground)", fmt("%.0f of %.0f", (double)n0, (double)pts.size()));
    std::unordered_map<uint64_t, std::array<float, 2>> start;
    for (const GpuAgent& a : w.agents) start[keyOf(a)] = {a.pos.x, a.pos.z};
    dump("t0");
    // ---- idle: 60 s
    w.run(60 * 60);
    w.read();
    dump("idle60");
    {
        std::vector<float> xz = live();
        SpreadStats st = spreadStats(xz, 1.5f);
        double moved = 0;
        int movedFar = 0, matched = 0, inWall = 0, alerted = 0, lurkers = 0, lurkersAtWall = 0, crawlers = 0, crawlersProne = 0;
        auto wallNear = [&](float x, float z, float r) {
            for (int k = 0; k < 16; ++k) {
                float an = k * 0.3927f;
                for (float d = 0.375f; d <= r; d += 0.375f) {
                    float px = x + std::cos(an) * d, pz = z + std::sin(an) * d;
                    if (w.staticH[w.cellOf(px, pz)] > sp.stepUp) return true;
                }
            }
            return false;
        };
        for (const GpuAgent& a : w.agents) {
            if ((a.info.x & 0xFF) >= ST_DYING) continue;
            auto it = start.find(keyOf(a));
            if (it != start.end()) {
                float d = std::hypot(a.pos.x - it->second[0], a.pos.z - it->second[1]);
                moved += d; ++matched; movedFar += d > 3.f ? 1 : 0;
            }
            float sh = w.staticH[w.cellOf(a.pos.x, a.pos.z)];
            if (sh > sp.stepUp && a.pos.y < sh - 0.3f) ++inWall;
            alerted += (a.info.z >> 28) != 0 ? 1 : 0;
            uint32_t kind = roamKindCpu(a.info.y, sp);
            if (kind == 1) { ++lurkers; lurkersAtWall += wallNear(a.pos.x, a.pos.z, 1.6f) ? 1 : 0; }
            if (kind == 2) { ++crawlers; crawlersProne += a.pos.w > 0.6f ? 1 : 0; }
        }
        std::printf("  idle 60 s: nn median %.2f m (p10 %.2f, < 1 m %.2f), clusters(1.5 m) %zu, largest %zu, mean %.2f, in > 20: %.2f\n",
                    st.nnMedian, st.nnP10, st.fracNnBelow1m, st.clusters, st.largestCluster, st.meanClusterSize, st.fracInClustersOver20);
        check(st.nnMedian > 1.2f && st.fracNnBelow1m < 0.2f, "idle zombies keep their distance (no tight clumps)",
              fmt("nn median %.2f m, fraction closer than 1 m %.2f", st.nnMedian, st.fracNnBelow1m));
        check(st.largestCluster <= 45 && st.fracInClustersOver20 < 0.25f, "no condensed hordes form while idle (cluster sizes)",
              fmt("largest %.0f, fraction in clusters > 20: %.2f", (double)st.largestCluster, st.fracInClustersOver20));
        check(matched > 0 && moved / matched > 4.0 && movedFar > matched / 2, "idle zombies wander (most move several metres per minute)",
              fmt("mean displacement %.1f m, moved > 3 m: %.2f", moved / std::max(matched, 1), (double)movedFar / std::max(matched, 1)));
        check(inWall <= (int)(n0 / 500) + 1, "wanderers stay out of buildings", fmt("inside static geometry: %.0f", inWall));
        check(alerted == 0, "nothing to notice: nobody is alerted", fmt("alerted %.0f", alerted));
        check(lurkers > 0 && lurkersAtWall > lurkers * 6 / 10, "lurkers stand at walls / doors",
              fmt("%.0f of %.0f within 1.6 m of a wall", lurkersAtWall, lurkers));
        check(crawlers == 0 || crawlersProne > crawlers * 6 / 10, "calm crawlers lie in the street", fmt("%.0f of %.0f prone", crawlersProne, crawlers));
    }
    // ---- noise: a source with a 30 m awareness gate for 25 s
    const float gx = -20.f, gz = 0.f, gate = 30.f;
    auto nearCount = [&](float r) {
        int c = 0;
        for (const GpuAgent& a : w.agents)
            if ((a.info.x & 0xFF) < ST_DYING && std::hypot(a.pos.x - gx, a.pos.z - gz) < r) ++c;
        return c;
    };
    std::unordered_map<uint64_t, float> dist0;
    for (const GpuAgent& a : w.agents) dist0[keyOf(a)] = std::hypot(a.pos.x - gx, a.pos.z - gz);
    const int near0 = nearCount(12.f);
    w.sim.setGameInputs(GAME_SEEDS, gate);
    w.sim.setGoals({gx, gz});
    w.run(25 * 60);
    w.read();
    dump("noise25");
    const int nearPeak = nearCount(12.f), corePeak = nearCount(5.f);
    {
        double inSum0 = 0, inSum1 = 0, farMove = 0;
        int inN = 0, farN = 0, farAlert = 0;
        for (const GpuAgent& a : w.agents) {
            auto it = dist0.find(keyOf(a));
            if (it == dist0.end() || (a.info.x & 0xFF) >= ST_DYING) continue;
            float d1 = std::hypot(a.pos.x - gx, a.pos.z - gz);
            if (it->second < 20.f) { inSum0 += it->second; inSum1 += d1; ++inN; }
            if (it->second > 55.f) { ++farN; farAlert += (a.info.z >> 28) != 0 ? 1 : 0; }
        }
        (void)farMove;
        std::printf("  noise 25 s: within 12 m of the source %d -> %d; zombies that started within 20 m: mean distance %.1f -> %.1f m\n",
                    near0, nearPeak, inN ? inSum0 / inN : 0.0, inN ? inSum1 / inN : 0.0);
        check(inN > 0 && inSum1 < inSum0 * 0.6 && nearPeak > near0 * 2 + 10, "a noise source pulls the zombies within its reach",
              fmt("mean distance %.1f -> %.1f m, near the source %.0f", inSum0 / std::max(inN, 1), inSum1 / std::max(inN, 1), nearPeak));
        check(farN > 0 && farAlert < farN / 10 + 1, "zombies far beyond the awareness reach keep wandering",
              fmt("%.0f of %.0f beyond 55 m alerted", farAlert, farN));
    }
    // ---- the source fades: memory, then dispersal back to wandering
    w.sim.setGoals({});
    w.run(3 * 60);
    w.read();
    int stillAlert = 0;
    for (const GpuAgent& a : w.agents)
        if (std::hypot(a.pos.x - gx, a.pos.z - gz) < 12.f && (a.info.z >> 28) >= 8) ++stillAlert;
    check(stillAlert > nearCount(12.f) / 2, "after the source fades the crowd stays alert for a while (no snapping)",
          fmt("%.0f of %.0f near the source still alert after 3 s", stillAlert, nearCount(12.f)));
    w.run(57 * 60);
    w.read();
    dump("after60");
    {
        const int nearAfter = nearCount(12.f);
        int alerted = 0;
        for (const GpuAgent& a : w.agents) alerted += (a.info.z >> 28) != 0 ? 1 : 0;
        std::vector<float> xz = live();
        SpreadStats st = spreadStats(xz, 1.5f);
        const int coreAfter = nearCount(5.f);
        std::printf("  60 s after: within 12 m %d (peak %d), within 5 m %d (peak %d), alerted %d, nn median %.2f m, largest cluster %zu\n",
                    nearAfter, nearPeak, coreAfter, corePeak, alerted, st.nnMedian, st.largestCluster);
        check(coreAfter < corePeak * 0.5 && st.largestCluster <= 12, "the pulled crowd disperses after the source fades (no clump left)",
              fmt("within 5 m of the source %.0f -> %.0f, largest cluster %.0f", corePeak, coreAfter, (double)st.largestCluster));
        check(alerted == 0, "alert memory decays back to idle", fmt("alerted %.0f", alerted));
    }
    w.sim.setGameInputs(0, 0.f);
    sp = saved;
    w.p = params;
    w.sb = keep;
    w.sim.reset(w.sb);
    w.sim.setGoals({});
}

// Day / night timing (GAME_DESIGN: 20 real minutes of day, 7 of night): integrate the clock at 60 Hz.
void testTimeOfDay() {
    std::printf("time of day\n");
    TimeOfDaySettings t;
    t.hours = 6.f;
    float dayS = 0.f, nightS = 0.f;
    bool night = false;
    for (int i = 0; i < 60 * 60 * 60 && !(night && t.hours >= 6.f && t.hours < 7.f); ++i) {
        (t.hours >= 6.f && t.hours < 18.f ? dayS : nightS) += 1.f / 60.f;
        if (t.hours >= 18.f || t.hours < 6.f) night = true;
        t.advance(1.f / 60.f);
    }
    check(std::fabs(dayS / 60.f - 20.f) < 0.5f && std::fabs(nightS / 60.f - 7.f) < 0.5f, "day 20 min (06-18 h), night 7 min (18-06 h)",
          fmt("day %.2f min, night %.2f min", dayS / 60.f, nightS / 60.f));
}

int runSelfTest(GpuContext& gpu, const SimParams& params, const char* dumpDir) {
    auto t0 = std::chrono::steady_clock::now();
    testTimeOfDay();
    testGameCore();
    if (std::getenv("TTZ_SELFTEST_GAME")) return g_fail ? 1 : 0;   // only the gameplay core
    if (!std::getenv("TTZ_SELFTEST_NO_HORDE")) g_fail += game::selfTestHordeBridge(gpu, params);   // combat GPU (WS-A)
    if (!std::getenv("TTZ_SELFTEST_NO_VERTICAL")) g_fail += game::selfTestHordeVertical(gpu, params);   // vertical horde (B3b)
    if (!std::getenv("TTZ_SELFTEST_NO_GAS")) g_fail += game::selfTestCorpseGas(gpu, params);   // corpse rot gas / flamethrowers (14d)
    if (std::getenv("TTZ_SELFTEST_GAS")) return g_fail ? 1 : 0;   // only gameplay core + combat GPU + vertical + gas
    if (std::getenv("TTZ_SELFTEST_VERTICAL")) return g_fail ? 1 : 0;   // only gameplay core + combat GPU + vertical
    if (std::getenv("TTZ_SELFTEST_HORDE")) return g_fail ? 1 : 0;   // only gameplay core + combat GPU
    World w;
    w.gpu = &gpu;
    w.p = params;
    w.sb.build(params.cellSize, params.gridW, params.gridH);
    if (!w.sim.init(gpu, params, w.sb)) { std::printf("sim init failed\n"); return 2; }

    if (std::getenv("TTZ_SELFTEST_VEHICLES")) {   // only the vehicle test
        testVehicles(w, gpu, params);
        w.sim.shutdown();
        return g_fail ? 1 : 0;
    }
    if (std::getenv("TTZ_SELFTEST_ROAM")) {   // only the roaming test
        testRoaming(w, gpu, params);
        w.sim.shutdown();
        return g_fail ? 1 : 0;
    }
    if (std::getenv("TTZ_SELFTEST_MOVE")) {   // only the moving-window test
        testMovingWindow(w, gpu, params);
        w.sim.shutdown();
        return g_fail ? 1 : 0;
    }
    if (std::getenv("TTZ_TRACE2")) {
        w.sim.setGoals({});
        w.sim.requestSpawn(Rect{-30.f, 1.f, -20.f, 6.f}, 400);
        for (int k = 0; k < 6; ++k) {
            w.run(k == 0 ? 1 : 30);
            w.read();
            double mx = 0, mz = 0, minz = 1e9, maxz = -1e9;
            for (auto& a : w.agents) { mx += a.pos.x; mz += a.pos.z; minz = std::min<double>(minz, a.pos.z); maxz = std::max<double>(maxz, a.pos.z); }
            std::printf("t=%.2f n=%zu mean=(%.2f %.2f) z=[%.2f %.2f] live=%u\n", w.sim.simTime(), w.agents.size(), mx / w.agents.size(),
                        mz / w.agents.size(), minz, maxz, w.counters[C_LIVE]);
        }
        return 0;
    }
    if (std::getenv("TTZ_TRACE")) {
        w.sim.setGoals(w.sb.scenarios[0].goals);
        w.sim.requestSpawn(Rect{-80.f, 3.f, -79.f, 4.f}, 1);
        for (int k = 0; k < 40; ++k) {
            w.run(k == 0 ? 1 : 120);
            w.read();
            for (auto& a : w.agents)
                std::printf("t=%.2f pos=(%.2f %.2f %.2f) vel=(%.2f %.2f %.2f) desired=(%.2f %.2f) st=%u blocked=%.2f\n",
                            w.sim.simTime(), a.pos.x, a.pos.y, a.pos.z, a.vel.x, a.vel.y, a.vel.z, a.dirs.x, a.dirs.y,
                            a.info.x & 0xFF, a.prev.w);
        }
        return 0;
    }
    // ---------------------------------------------------------------- 1. spawn + sort
    std::printf("[1] spawn and counting sort\n");
    const Scenario& march = w.sb.scenarios[0];
    w.sim.setGoals(march.goals);
    w.sim.requestSpawn(march.spawns[0], 3000);
    w.run(1);
    w.read();
    Metrics m = measure(w);
    check(w.agents.size() == 3000, "all spawned agents alive after first sort", fmt("live=%.0f", (double)w.agents.size()));
    check(m.nan == 0, "no NaN positions", fmt("nan=%.0f", m.nan));

    // ---------------------------------------------------------------- 2. flow through the city
    std::printf("[2] avenue march: flow field, bottleneck, obstacle avoidance (25 s)\n");
    float x0 = m.meanX;
    w.run(60 * 25);
    w.read();
    m = measure(w);
    printSummary(w, m, "after 25 s");
    dump(w, dumpDir, "march_25s");
    check(m.nan == 0, "no NaN positions", fmt("nan=%.0f", m.nan));
    check(m.meanX - x0 > 15.f, "crowd advances along the flow field", fmt("mean x %.1f -> %.1f", x0, m.meanX));
    check(m.penetrating <= (int)(w.agents.size() / 200), "agents stay out of static obstacles",
          fmt("penetrating=%.0f", m.penetrating));
    check(m.deepOverlap <= (int)(w.agents.size() / 50), "bounded interpenetration (<2%% deep overlaps)",
          fmt("deep=%.0f", m.deepOverlap));

    // ---------------------------------------------------------------- 3. wall siege: stacking
    std::printf("[3] wall siege: compression, climbing, vertical accumulation (30 s)\n");
    w.sim.reset(w.sb);
    const Scenario& siege = w.sb.scenarios[2];
    w.sim.setGoals(siege.goals);
    w.sim.requestSpawn(siege.spawns[0], 6000);
    w.run(60 * 30);
    w.read();
    m = measure(w);
    printSummary(w, m, "after 30 s");
    dump(w, dumpDir, "siege_30s");
    dumpFields(w, dumpDir);
    check(m.nan == 0, "no NaN positions", fmt("nan=%.0f", m.nan));
    check(m.elevated > 100, "zombies climb onto each other (elevated > 100)", fmt("elevated=%.0f", m.elevated));
    check(m.maxFeet > 1.2f, "pile grows above 1.2 m", fmt("max feet=%.2f m", m.maxFeet));
    check(m.p999Feet < 3.5f + 3.0f, "pile height bounded (99.9th pct feet < wall + 3 m)",
          fmt("p99.9=%.2f m, max=%.2f m", m.p999Feet, m.maxFeet));
    check(m.floating <= std::max(5, m.elevated / 50), "elevated zombies are supported (<2%% floating)",
          fmt("floating=%.0f of %.0f", m.floating, m.elevated));
    check(m.penetrating <= (int)(w.agents.size() / 200), "no wall penetration under pressure",
          fmt("penetrating=%.0f", m.penetrating));
    check(m.deepOverlap <= (int)(w.agents.size() / 33), "bounded compression (<3%% deep overlaps)",
          fmt("deep=%.0f", m.deepOverlap));

    // count how many crossed the wall
    float wallX = 0.62f * 0.5f * params.gridW * params.cellSize;
    int crossed = 0;
    for (auto& a : w.agents) crossed += a.pos.x > wallX + 1.5f;
    std::printf("  agents over the wall: %d\n", crossed);

    // ---------------------------------------------------------------- 4. explosion
    std::printf("[4] explosion: kill, throw, corpses, refill\n");
    // find the densest point in front of the wall
    float ex = wallX - 6.f, ez = 0.f;
    auto countNear = [&](float r) {
        int n = 0;
        for (auto& a : w.agents) {
            uint32_t st = a.info.x & 0xFF;
            if (st == ST_DYING || st == ST_DEAD) continue;
            float dx = a.pos.x - ex, dz = a.pos.z - ez;
            n += dx * dx + dz * dz < r * r;
        }
        return n;
    };
    auto elevatedNear = [&](float r) {
        int n = 0;
        for (auto& a : w.agents) {
            uint32_t st = a.info.x & 0xFF;
            float dx = a.pos.x - ex, dz = a.pos.z - ez;
            if ((st == ST_WALK || st == ST_CLIMB) && dx * dx + dz * dz < r * r && a.pos.y - w.ground(a.pos.x, a.pos.z, a.pos.y) > 0.5f) ++n;
        }
        return n;
    };
    int before = countNear(4.f);
    int elevatedLocalBefore = elevatedNear(6.f);
    w.sim.requestExplosion(ex, 0.5f, ez);
    w.run(30);
    w.read();
    m = measure(w);
    printSummary(w, m, "0.5 s after blast");
    dump(w, dumpDir, "blast_0.5s");
    int justAfter = countNear(4.f);
    int elevatedLocalAfter = elevatedNear(6.f);
    int airborne = m.byState[ST_FALL] + m.byState[ST_DYING];
    check(airborne > 30, "explosion throws / kills agents", fmt("fall+dying=%.0f", airborne));
    check(justAfter < before * 0.6, "explosion opens a hole in the horde", fmt("near=%.0f -> %.0f", before, justAfter));
    w.run(60 * 2);
    w.read();
    m = measure(w);
    printSummary(w, m, "2.5 s after blast");
    {   // regression: dying bodies used to keep tumbling (spinning) for up to 8 s when jammed against walls or bodies
        uint32_t deaths = w.counters[C_DEATHS_TOTAL];
        int dying = m.byState[ST_DYING];
        check(dying <= std::max(3, (int)((deaths + dying) * 0.15)), "dead bodies come to rest quickly (no endless tumbling)",
              fmt("still tumbling at 2.5 s: %.0f of %.0f killed", dying, deaths + dying));
    }
    w.run(60 * 2);
    w.read();
    m = measure(w);
    printSummary(w, m, "4.5 s after blast");
    {   // gore: severed limbs, flying body parts, blood particles, blood decals, legless crawlers
        uint32_t g[G_COUNT];
        w.gpu->downloadNow(w.sim.goreCounters(), g, sizeof(g));
        std::vector<float> gibs((size_t)params.gibCapacity * 16);
        w.gpu->downloadNow(w.sim.gibs(), gibs.data(), (uint32_t)(gibs.size() * 4));
        int gibActive = 0, gibBad = 0, gibResting = 0;
        for (int i = 0; i < params.gibCapacity; ++i) {
            const float* gb = &gibs[(size_t)i * 16];
            if (gb[7] < 0.5f) continue;
            ++gibActive;
            bool finite = std::isfinite(gb[0]) && std::isfinite(gb[1]) && std::isfinite(gb[2]) && std::isfinite(gb[8]);
            float ground = w.ground(gb[0], gb[2], gb[1]);
            if (!finite || gb[1] < ground - 0.3f) ++gibBad;
            if (gb[7] > 1.5f) ++gibResting;
        }
        std::vector<uint32_t> decals(3 * w.sim.decalW() * w.sim.decalH());
        w.gpu->downloadNow(w.sim.decals(), decals.data(), (uint32_t)(decals.size() * 4));
        uint64_t blood = 0, scorch = 0;
        for (uint32_t i = 0; i < w.sim.decalW() * w.sim.decalH(); ++i) { blood += decals[i]; scorch += decals[2 * w.sim.decalW() * w.sim.decalH() + i] > 0; }
        int severedAlive = 0, leglessUpright = 0;
        for (auto& a : w.agents) {
            uint32_t sev = (a.info.z >> 16) & 0x3FF, st = a.info.x & 0xFF;
            if (sev && st == ST_WALK) { ++severedAlive; if ((sev & 0x3C0) && a.pos.w < 0.5f) ++leglessUpright; }
        }
        std::printf("  gore: severed=%u torn apart=%u parts spawned=%u active=%d resting=%d particles spawned=%u blood=%llu scorch cells=%llu survivors with wounds=%d\n",
                    g[G_SEVERED], g[G_GIBBED], g[G_GIB_HEAD], gibActive, gibResting, g[G_PARTICLE_HEAD], (unsigned long long)blood,
                    (unsigned long long)scorch, severedAlive);
        check(g[G_SEVERED] > 0 && g[G_GIB_HEAD] > 0, "explosions blow limbs off as flying body parts", fmt("severed=%.0f parts=%.0f", g[G_SEVERED], g[G_GIB_HEAD]));
        check(gibActive > 0 && gibBad == 0, "body parts stay finite and above the ground", fmt("active=%.0f bad=%.0f", gibActive, gibBad));
        check(gibResting > gibActive * 0.8, "body parts come to rest", fmt("resting=%.0f of %.0f", gibResting, gibActive));
        check(g[G_PARTICLE_HEAD] > 100 && blood > 0 && scorch > 0, "blood spray lands as decals, blasts leave scorch marks",
              fmt("particles=%.0f blood=%.0f scorch cells=%.0f", g[G_PARTICLE_HEAD], (double)blood, (double)scorch));
        check(leglessUpright == 0, "zombies that lost a leg crawl", fmt("legless but upright: %.0f", leglessUpright));
    }
    uint32_t corpses = std::min<uint32_t>(w.counters[C_CORPSES], params.corpseCapacity);
    int maxCorpseMm = *std::max_element(w.corpseH.begin(), w.corpseH.end());
    check(corpses > 10, "dead bodies persist as corpses", fmt("corpses=%.0f", corpses));
    check(maxCorpseMm > 50, "corpses build the height field", fmt("max corpse height=%.0f mm", maxCorpseMm));
    check(elevatedLocalAfter < elevatedLocalBefore * 0.5, "local pile collapses under the blast",
          fmt("elevated within 6 m: %.0f -> %.0f (0.5 s)", elevatedLocalBefore, elevatedLocalAfter));
    w.run(60 * 8);
    w.read();
    m = measure(w);
    int refill = countNear(4.f);
    printSummary(w, m, "12.5 s after blast");
    check(refill > justAfter && refill > before * 0.5, "crowd refills the gap",
          fmt("near: before=%.0f after=%.0f refill=%.0f", before, justAfter, refill));
    check(m.nan == 0, "no NaN positions", fmt("nan=%.0f", m.nan));

    // ---------------------------------------------------------------- 5. corpse ramp
    std::printf("[5] corpse accumulation: repeated blasts in front of the wall\n");
    for (int k = 0; k < 8; ++k) {
        w.sim.requestExplosion(wallX - 3.f, 0.3f, -3.f + (k % 3) * 3.f);
        w.run(60 * 3);
    }
    w.run(60 * 3);
    w.read();
    m = measure(w);
    printSummary(w, m, "after 8 blasts");
    dump(w, dumpDir, "corpses");
    maxCorpseMm = *std::max_element(w.corpseH.begin(), w.corpseH.end());
    long long totalMm = 0;
    for (int v : w.corpseH) totalMm += v;
    int onCorpses = 0;
    for (auto& a : w.agents) {
        float c = w.corpseAt(a.pos.x, a.pos.z);
        if (c > 0.2f && (a.info.x & 0xFF) == ST_WALK && a.pos.y >= c * 0.6f) ++onCorpses;
    }
    std::printf("  corpses=%u total corpse volume=%.1f m^3 max height=%.2f m\n",
                std::min<uint32_t>(w.counters[C_CORPSES], params.corpseCapacity),
                totalMm * 0.001 * params.cellSize * params.cellSize, maxCorpseMm * 0.001);
    check(maxCorpseMm > 250, "corpse piles accumulate (>0.25 m)", fmt("max=%.0f mm", maxCorpseMm));
    check(onCorpses > 20, "living zombies walk on top of corpse piles", fmt("on corpses=%.0f", onCorpses));
    check(totalMm >= 0, "corpse field non-negative in total", fmt("total=%.0f mm", (double)totalMm));
    check(m.nan == 0, "no NaN positions", fmt("nan=%.0f", m.nan));


    // ---------------------------------------------------------------- 6. modular appearance generation
    std::printf("[6] modular appearance generation (5000 zombies, default weights)\n");
    w.sim.reset(w.sb);
    w.sim.setGoals({});
    w.sim.requestSpawn(Rect{-90.f, -90.f, -10.f, 90.f}, 5000);
    w.run(2);
    w.read();
    {
        int bad = 0, garment = 0, sleeveless = 0, anyDecomposed = 0, missing = 0, clothed = 0;
        std::set<uint64_t> unique;
        for (auto& a : w.agents) {
            Look l = decodeLook(a.info.x & 0xFFFFFF00u, a.info.y);
            unique.insert(((uint64_t)(a.info.x >> 8) << 32) | a.info.y);
            bool dec = false, miss = false, cloth = l.m[2] == 0 && l.m[3] == 0 && l.m[4] == 0 && l.m[5] == 0 && l.m[6] == 0 && l.m[7] == 0 && l.m[8] == 0 && l.m[9] == 0;
            for (int s2 = 0; s2 < 10; ++s2) {
                if (l.m[s2] >= kFamCount[kSlotFam[s2]]) ++bad;
                else if (kDecay[kSlotFam[s2]][l.m[s2]] == 2) dec = true;
            }
            for (int i = 0; i < 8; ++i) if (l.pal[i] >= kPalCount[i]) ++bad;
            if (l.tier > 2) ++bad;
            for (int sd = 0; sd < 2; ++sd) {
                uint32_t th = l.m[6 + sd * 2], sh = l.m[7 + sd * 2];
                if ((th == 1 && sh == 0) || (th == 0 && sh == 1)) ++garment;   // shorts->trousered shin, trousers->bare shin
            }
            if ((l.m[1] == 4 || l.m[1] == 5) && (l.m[2] == 0 || l.m[3] == 0 || l.m[4] == 0 || l.m[5] == 0)) ++sleeveless;
            miss = l.m[3] == 5 || l.m[5] == 5;
            anyDecomposed += dec; missing += miss; clothed += cloth;
        }
        double n = (double)w.agents.size();
        check(bad == 0, "module / palette / tier indices in range", fmt("bad=%.0f", bad));
        check(garment == 0 && sleeveless == 0, "garment consistency rules hold", fmt("garment=%.0f sleeveless=%.0f", garment, sleeveless));
        check(unique.size() > n * 0.97, "zombies look unique", fmt("%.0f distinct of %.0f", (double)unique.size(), n));
        check(missing / n > 0.04 && missing / n < 0.12, "missing forearms follow the configured weight (7%%)", fmt("%.1f%%", 100.0 * missing / n));
        check(anyDecomposed / n > 0.12 && anyDecomposed / n < 0.45, "decomposed parts are a minority (not every zombie extreme)",
              fmt("%.1f%% with a decomposed part", 100.0 * anyDecomposed / n));
        check(clothed / n > 0.25, "plenty of fully clothed zombies", fmt("%.1f%%", 100.0 * clothed / n));
    }

    // ---------------------------------------------------------------- 7. character rendering: culling + segments
    std::printf("[7] GPU character pipeline: culling, compaction, joint integrity\n");
    CharacterRenderer chars;
    bool charsOk = chars.init(gpu, params, std::string(TTZ_SOURCE_DIR) + "/assets/characters/zombie_parts.ttzc", 16384);
    check(charsOk, "character asset and pipelines load", "");
    if (charsOk) {
        auto prepare = [&](V3 eye, V3 target, uint32_t anim, int level, int classMode, bool occl = false, bool quads = true) {
            M4 vp = mul(perspective(0.9f, 16.f / 9.f, 0.5f, 600.f), lookAt(eye, target, {0, 1, 0}));
            CharacterSettings cs;
            cs.forcedAnim = anim; cs.geometryLevel = level; cs.classMode = classMode; cs.occlusionCull = occl; cs.quadIndexing = quads;
            SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
            float e[3] = {eye.x, eye.y, eye.z};
            chars.prepare(cmd, w.sim, vp.m, e, 1.234, cs);
            SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
            SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
            SDL_ReleaseGPUFence(gpu.device(), f);
            CharacterStats st;
            chars.readStatsNow(st);
            return st;
        };
        uint32_t expectSegs = 0;
        for (auto& a : w.agents) { Look l = decodeLook(a.info.x & 0xFFFFFF00u, a.info.y); expectSegs += 10 - (l.m[3] == 5) - (l.m[5] == 5); }
        CharacterStats all = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 3, 1);
        check(all.visible == w.agents.size() && all.overflow == 0, "camera over the crowd sees every zombie",
              fmt("visible=%.0f of %.0f", all.visible, (double)w.agents.size()));
        check(all.segments == expectSegs, "one segment instance per present body part (missing forearms skipped)",
              fmt("segments=%.0f expected=%.0f", all.segments, expectSegs));
        CharacterStats away = prepare({-50, 5, 95}, {-50, 5, 300}, 0, 3, 1);
        check(away.visible == 0, "camera looking away culls everything", fmt("visible=%.0f", away.visible));
        CharacterStats tri = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 3, 1, false, false);
        check(chars.quadIndexingAvailable(3) && tri.segments == all.segments && tri.triangles == all.triangles &&
                  all.vsInvocations < tri.vsInvocations * 0.75,
              "indexed quads: same triangles, fewer vertex-shader invocations",
              fmt("tris %.0f vs %.0f, invocations %.0f (quads)", all.triangles, tri.triangles, all.vsInvocations) +
                  fmt(" vs %.0f (triangle lists)", tri.vsInvocations));
        CharacterStats fam = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 3, 0);
        check(fam.segments == all.segments && fam.triangles == all.triangles, "family batches draw the same geometry as size classes",
              fmt("tris %.0f vs %.0f", fam.triangles, all.triangles));
        check(all.vsInvocations <= fam.vsInvocations, "size classes reduce vertex-shader padding",
              fmt("invocations size-class %.0f vs family %.0f (useful %.0f)", all.vsInvocations, fam.vsInvocations, all.triangles * 3.0));
        CharacterStats naive = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 0, 1), culled = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 1, 1),
                       greedy = prepare({-50, 260, 1}, {-50, 0, 0}, 0, 2, 1);
        std::printf("  triangles for 5000 zombies: naive %u, culled %u, greedy %u, voxel-material %u\n", naive.triangles, culled.triangles,
                    greedy.triangles, all.triangles);
        check(greedy.segments == all.segments && all.triangles < greedy.triangles && greedy.triangles < culled.triangles,
              "each geometry level draws the same segments with fewer triangles", fmt("%.0f -> %.0f -> %.0f", culled.triangles, greedy.triangles, all.triangles));


        // ---- occlusion culling in the city: conservative (nothing visible may be culled)
        {
            Sandbox city;
            city.build(params.cellSize, params.gridW, params.gridH, MapKind::City);
            w.sim.reset(city);
            w.sim.setGoals({});
            w.sim.requestSpawn(city.scenarios[3].spawns[0], 4000);
            w.run(2);
            w.read();
            std::vector<float> occ = city.occluders();
            chars.setOccluders(occ);
            V3 eye{-20.f + std::sin(-1.45f) * std::cos(0.45f) * 60.f, std::sin(0.45f) * 60.f, std::cos(-1.45f) * std::cos(0.45f) * 60.f};
            V3 tgt{-20.f, 0.f, 0.f};
            auto visibleSet = [&](bool occl) {
                CharacterStats st = prepare(eye, tgt, 0, 3, 1, occl);
                std::vector<uint32_t> vis(std::max(1u, st.visible));
                if (st.visible) {
                    // visList lives right after the counters in no particular buffer: read via segment refs instead
                    std::vector<uint32_t> raw((size_t)st.segments * 8);
                    gpu.downloadNow(chars.segmentInstances(), raw.data(), (uint32_t)(raw.size() * 4));
                    std::set<uint32_t> refs;
                    for (uint32_t i = 0; i < st.segments; ++i) { uint32_t r; std::memcpy(&r, &raw[i * 8 + 7], 4); refs.insert(r); }
                    return std::make_pair(st, refs);
                }
                return std::make_pair(st, std::set<uint32_t>{});
            };
            auto [stOff, setOff] = visibleSet(false);
            auto [stOn, setOn] = visibleSet(true);
            int culled = 0, wrong = 0;
            uint32_t rng = 12345;
            auto rnd = [&]() { rng = rng * 1664525u + 1013904223u; return (rng >> 8) / 16777216.0f; };
            auto segHits = [&](V3 p0, V3 p1, const float* b) {
                float t0 = 0, t1 = 1;
                float p[3] = {p0.x, p0.y, p0.z}, d[3] = {p1.x - p0.x, p1.y - p0.y, p1.z - p0.z};
                for (int k = 0; k < 3; ++k) {
                    if (std::fabs(d[k]) < 1e-9f) { if (p[k] < b[k] || p[k] > b[4 + k]) return false; continue; }
                    float a = (b[k] - p[k]) / d[k], c = (b[4 + k] - p[k]) / d[k];
                    t0 = std::max(t0, std::min(a, c)); t1 = std::min(t1, std::max(a, c));
                }
                return t0 <= t1;
            };
            for (uint32_t r : setOff) {
                if (setOn.count(r)) continue;
                ++culled;
                const GpuAgent& a = w.agents[r];
                for (int k = 0; k < 64; ++k) {   // random points of the character's bounding volume must all be hidden
                    V3 p{a.pos.x - 1.1f + 2.2f * rnd(), a.pos.y - 0.2f + 2.6f * rnd(), a.pos.z - 1.1f + 2.2f * rnd()};
                    bool hidden = false;
                    for (size_t b = 0; b < occ.size() / 8 && !hidden; ++b) hidden = segHits(eye, p, &occ[b * 8]);
                    if (!hidden) { ++wrong; break; }
                }
            }
            check(stOn.occluded > 0 && (uint32_t)culled == stOn.occluded, "occlusion culling removes zombies hidden behind buildings",
                  fmt("frustum-visible %.0f, occluded %.0f, drawn %.0f", stOff.visible, stOn.occluded, stOn.visible));
            check(wrong == 0, "occlusion culling is conservative (no visible zombie culled)", fmt("culled=%.0f, wrongly culled=%.0f", culled, wrong));
            chars.setOccluders({});
            w.sim.reset(w.sb);                       // restore the arena crowd for the following tests
            w.sim.setGoals({});
            w.sim.requestSpawn(Rect{-90.f, -90.f, -10.f, 90.f}, 5000);
            w.run(2);
            w.read();
        }

        const char* animNames[8] = {"auto", "idle", "walk", "reach", "climb", "flail", "dying", "corpse"};
        for (uint32_t anim = 0; anim < 8; ++anim) {
            CharacterStats st = prepare({-50, 260, 1}, {-50, 0, 0}, anim, 3, 1);
            std::vector<uint32_t> raw((size_t)st.segments * 8);
            gpu.downloadNow(chars.segmentInstances(), raw.data(), (uint32_t)(raw.size() * 4));
            std::unordered_map<uint32_t, std::array<int, 10>> bySlot;
            for (uint32_t i = 0; i < st.segments; ++i) {
                uint32_t ref; std::memcpy(&ref, &raw[i * 8 + 7], 4);
                auto& e = bySlot.try_emplace(ref, std::array<int, 10>{-1, -1, -1, -1, -1, -1, -1, -1, -1, -1}).first->second;
                e[(raw[i * 8 + 2] >> 12) & 0xF] = (int)i;
            }
            float worst = 0; int checked = 0;
            const float sc = chars.metresPerVoxel();
            for (auto& [ref, idx] : bySlot)
                for (int c = 0; c < 10; ++c) {
                    int p = kParent[c];
                    if (p < 0 || idx[c] < 0 || idx[p] < 0) continue;
                    auto quat = [&](int i, float q[4]) {
                        uint32_t a0 = raw[i * 8], a1 = raw[i * 8 + 1];
                        q[0] = halfToFloat(a0 & 0xFFFF); q[1] = halfToFloat(a0 >> 16); q[2] = halfToFloat(a1 & 0xFFFF); q[3] = halfToFloat(a1 >> 16);
                        float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
                        for (int k = 0; k < 4; ++k) q[k] /= l;
                    };
                    auto pos = [&](int i) { float f[3]; std::memcpy(f, &raw[i * 8 + 4], 12); return V3{f[0], f[1], f[2]}; };
                    float qp[4]; quat(idx[p], qp);
                    V3 rel{(kPivot[c][0] - kPivot[p][0]) * sc, (kPivot[c][1] - kPivot[p][1]) * sc, (kPivot[c][2] - kPivot[p][2]) * sc};
                    V3 expect = pos(idx[p]) + qrotCpu(qp, rel);
                    V3 d = expect - pos(idx[c]);
                    worst = std::max(worst, std::sqrt(dot(d, d)));
                    ++checked;
                }
            check(checked > 1000 && worst < 0.006f, (std::string("joints stay attached: ") + animNames[anim]).c_str(),
                  fmt("%.0f joints, max gap %.2f mm", checked, worst * 1000.0));
        }
    }

    // ---------------------------------------------------------------- 8. corpses keep their zombie's appearance
    std::printf("[8] corpses keep the exact appearance of the zombie that died\n");
    {
        std::set<uint64_t> looks;
        for (auto& a : w.agents) looks.insert(((uint64_t)(a.info.x & 0xFFFFFF00u) << 32) | a.info.y);
        for (int k = 0; k < 24; ++k) {   // blasts centred on zombies, several per step
            const GpuAgent& t = w.agents[(size_t)(k * 2654435761u) % w.agents.size()];
            w.sim.requestExplosion(t.pos.x, 0.3f, t.pos.z);
            if (k % 6 == 5) w.run(60);
        }
        w.run(60 * 6);
        w.read();
        uint32_t nc = std::min<uint32_t>(w.counters[C_CORPSES], params.corpseCapacity);
        std::vector<GpuCorpse> cs(nc);
        if (nc) gpu.downloadNow(w.sim.corpses(), cs.data(), nc * sizeof(GpuCorpse));
        int unknown = 0;
        for (auto& c : cs) if (!looks.count(((uint64_t)c.info.x << 32) | c.info.y)) ++unknown;
        check(nc > 20, "explosions produced corpses", fmt("corpses=%.0f", nc));
        check(unknown == 0, "every corpse has the look of a zombie that existed", fmt("unknown=%.0f of %.0f", unknown, nc));
    }
    chars.shutdown();

    testMovingWindow(w, gpu, params);
    testVehicles(w, gpu, params);
    // last: the earlier sections keep their spawn seeds (CrowdSim's spawn seed counter is not reset by reset())
    if (!std::getenv("TTZ_SELFTEST_NO_ROAM")) testRoaming(w, gpu, params);

    w.sim.shutdown();
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("selftest: %s (%d failures, %.1f s wall time)\n", g_fail ? "FAILED" : "PASSED", g_fail, secs);
    return g_fail ? 1 : 0;
}

} // namespace ttz
