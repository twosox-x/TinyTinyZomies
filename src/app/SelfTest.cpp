// Headless validation of the GPU crowd simulation. Uses synchronous readbacks (test-only).
#include "app/SelfTest.h"

#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unordered_map>
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

} // namespace

int runSelfTest(GpuContext& gpu, const SimParams& params, const char* dumpDir) {
    auto t0 = std::chrono::steady_clock::now();
    World w;
    w.gpu = &gpu;
    w.p = params;
    w.sb.build(params.cellSize, params.gridW, params.gridH);
    if (!w.sim.init(gpu, params, w.sb)) { std::printf("sim init failed\n"); return 2; }

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
    w.run(60 * 4);
    w.read();
    m = measure(w);
    printSummary(w, m, "4.5 s after blast");
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

    w.sim.shutdown();
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("selftest: %s (%d failures, %.1f s wall time)\n", g_fail ? "FAILED" : "PASSED", g_fail, secs);
    return g_fail ? 1 : 0;
}

} // namespace ttz
