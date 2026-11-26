// Headless validation of the GPU crowd simulation. Uses synchronous readbacks (test-only).
#include "app/SelfTest.h"

#include "render/CharacterRenderer.h"
#include "render/Math.h"
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

} // namespace

int runSelfTest(GpuContext& gpu, const SimParams& params, const char* dumpDir) {
    auto t0 = std::chrono::steady_clock::now();
    World w;
    w.gpu = &gpu;
    w.p = params;
    w.sb.build(params.cellSize, params.gridW, params.gridH);
    if (!w.sim.init(gpu, params, w.sb)) { std::printf("sim init failed\n"); return 2; }

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

    w.sim.shutdown();
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("selftest: %s (%d failures, %.1f s wall time)\n", g_fail ? "FAILED" : "PASSED", g_fail, secs);
    return g_fail ? 1 : 0;
}

} // namespace ttz
