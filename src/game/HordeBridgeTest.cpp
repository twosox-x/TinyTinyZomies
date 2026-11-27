// Self-test section "combat GPU" (WS-A, docs/GAMEPLAY_ARCHITECTURE.md 3.7): HordeBridge against a real CrowdSim on a
// small empty sandbox. Synchronous downloads are used to inspect agents (test only); the bridge itself runs exactly as
// in the game (async ring), with setSync(true) so that every frame is harvested deterministically.
#include "game/HordeBridge.h"

#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace ttz::game {

namespace {
int g_hfail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_hfail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d);
    return buf;
}
float halfToFloat(uint16_t h) {
    uint32_t s = (h >> 15) & 1, e = (h >> 10) & 31, m = h & 1023;
    float v = e == 0 ? std::ldexp((float)m, -24) : e == 31 ? INFINITY : std::ldexp((float)(m | 1024), (int)e - 25);
    return s ? -v : v;
}

struct Rig {
    GpuContext* gpu = nullptr;
    CrowdSim sim;
    HordeBridge bridge;
    Sandbox sb;
    std::vector<GpuAgent> agents;
    uint32_t counters[C_COUNT] = {};

    void frame(int steps) {
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu->device());
        bridge.preSim(cmd);
        for (int i = 0; i < steps; ++i) sim.step(cmd);
        bridge.postSim(cmd, 0);
        sim.recordStatsReadback(cmd);
        sim.onFrameSubmitted(SDL_SubmitGPUCommandBufferAndAcquireFence(cmd));
        bridge.harvest();
    }
    void frames(int n, int steps = 1) { for (int i = 0; i < n; ++i) frame(steps); }
    void read() {
        gpu->downloadNow(sim.counters(), counters, sizeof(counters));
        agents.resize(counters[C_LIVE]);
        if (!agents.empty()) gpu->downloadNow(sim.agents(), agents.data(), (uint32_t)(agents.size() * sizeof(GpuAgent)));
    }
    void spawnAt(float x, float z, uint32_t n = 1, float half = 0.02f) { sim.requestSpawnLook({x - half, z - half, x + half, z + half}, n, 0, 0); }
    static float health(const GpuAgent& a) { return halfToFloat((uint16_t)(a.info.z & 0xFFFF)); }
    static uint32_t state(const GpuAgent& a) { return a.info.x & 0xFF; }
    void restart() {
        sim.reset(sb);
        bridge.reset();
        bridge.uploadSoldiers({});
        bridge.setAttractors({});
        std::vector<KillEvent> drop;
        bridge.takeKills(drop);
    }
};

HitRequest ray(V3 o, V3 d, float dmg, uint32_t shooter, uint32_t flags = 0, float range = 60.f) {
    HitRequest h;
    h.origin = o; h.dir = d; h.damage = dmg; h.shooterPacked = shooter; h.flags = flags; h.maxDist = range;
    return h;
}
} // namespace

int selfTestHordeBridge(GpuContext& gpu, const SimParams& base) {
    std::printf("combat GPU (horde bridge)\n");
    g_hfail = 0;
    SimParams p = base;
    p.gridW = p.gridH = 128;            // 96 m, empty except for one test wall
    p.agentCapacity = 8192;
    p.corpseCapacity = 8192;
    p.wander = 0.f;
    Rig r;
    r.gpu = &gpu;
    r.sb.build(p.cellSize, p.gridW, p.gridH, MapKind::Arena);
    r.sb.boxes.clear();
    r.sb.scenarios.clear();
    r.sb.boxes.push_back({30.f, -4.f, 31.f, 4.f, 3.f, BoxKind::Wall, true});   // x 30..31, 3 m high
    if (!r.sim.init(gpu, p, r.sb)) { check(false, "sim init", ""); return 1; }
    r.sim.setGoals({});
    if (!r.bridge.init(gpu, r.sim)) { check(false, "bridge init (game_* pipelines)", ""); r.sim.shutdown(); return 1; }
    r.bridge.setSync(true);

    // ---- 1. a ray through a line of zombies hits the first one only -------------------------------------------------
    for (float x : {10.f, 12.f, 14.f, 16.f, 18.f}) r.spawnAt(x, 0.f);
    r.frames(5);
    r.frames(20);
    const uint32_t shooterA = (7u & 0xFFFFu) | (3u << 16);
    r.bridge.queueHits({ray({0, 1.2f, 0}, {1, 0, 0}, 0.3f, shooterA)});
    r.frame(1);
    r.read();
    int damaged = 0;
    float damagedX = 0;
    for (const GpuAgent& a : r.agents)
        if (Rig::health(a) < 0.99f) { ++damaged; damagedX = a.pos.x; }
    const auto hr = r.bridge.hitResults();
    check(r.agents.size() == 5 && damaged == 1 && std::fabs(damagedX - 10.f) < 0.5f && hr.size() == 1 &&
              hr[0].kind == HordeBridge::HitKind::Zombie && std::fabs(hr[0].dist - 9.74f) < 0.3f,
          "ray through a line of 5 zombies damages only the first",
          fmt("%.0f damaged, at x %.2f, hit dist %.2f, live %.0f", damaged, damagedX, hr.empty() ? -1.0 : hr[0].dist, (double)r.agents.size()));

    // ---- 2. many hits on one zombie in one frame: exactly one kill record, credited to the shooter --------------------
    std::vector<KillEvent> kills;
    r.bridge.takeKills(kills);
    const uint32_t deaths0 = r.sim.stats().deaths;
    r.bridge.queueHits({ray({0, 1.2f, 0}, {1, 0, 0}, 0.6f, shooterA), ray({0, 1.2f, 0}, {1, 0, 0}, 0.6f, shooterA),
                        ray({0, 1.2f, 0}, {1, 0, 0}, 0.6f, shooterA), ray({0, 1.2f, 0}, {1, 0, 0}, 0.6f, shooterA)});
    r.frame(1);
    r.frames(3);   // further frames: the dying body must not be reported again
    kills.clear();
    r.bridge.takeKills(kills);
    check(kills.size() == 1 && kills[0].cause == KillCause::Soldier && kills[0].shooterPacked == shooterA && std::fabs(kills[0].pos.x - 10.f) < 0.8f,
          "4 lethal rounds on one zombie in one frame: exactly one kill (cause soldier, shooter credited)",
          fmt("%.0f kills, shooter %.0f, x %.2f", (double)kills.size(), kills.empty() ? 0.0 : (double)kills[0].shooterPacked,
              kills.empty() ? 0.0 : kills[0].pos.x));
    // rounds pass through the dying body and hit the next zombie; a headshot kills and takes the head
    r.read();
    uint32_t sevBefore = 0;
    r.gpu->downloadNow(r.sim.goreCounters(), &sevBefore, 4, G_SEVERED * 4);
    r.bridge.queueHits({ray({0, 1.2f, 0}, {1, 0, 0}, 0.1f, shooterA, 1u)});
    r.frame(1);
    r.read();
    uint32_t sevAfter = 0;
    r.gpu->downloadNow(r.sim.goreCounters(), &sevAfter, 4, G_SEVERED * 4);
    std::vector<KillEvent> k2;
    r.bridge.takeKills(k2);
    bool headless = false;
    for (const GpuAgent& a : r.agents)
        if (std::fabs(a.pos.x - 12.f) < 0.8f) headless = (a.info.z >> 16 & 1u) != 0 && Rig::state(a) == ST_DYING;
    check(k2.size() == 1 && std::fabs(k2[0].pos.x - 12.f) < 0.8f && k2[0].seq > kills.back().seq && headless && sevAfter > sevBefore,
          "headshot passes the dying body, kills the next zombie and severs its head",
          fmt("%.0f kills, x %.2f, head severed %.0f, severed parts +%.0f", (double)k2.size(), k2.empty() ? 0.0 : k2[0].pos.x, headless ? 1 : 0,
              (double)(sevAfter - sevBefore)));
    // kills reported == bodies settled (C_DEATHS_TOTAL delta)
    r.frames(240);
    check(r.sim.stats().deaths - deaths0 == 2, "kill records == C_DEATHS_TOTAL delta", fmt("deaths +%.0f, kills 2", r.sim.stats().deaths - deaths0));

    // ---- 3. static geometry stops rounds ------------------------------------------------------------------------------
    r.spawnAt(36.f, 0.f);
    r.frames(10);
    r.bridge.queueHits({ray({26.f, 1.2f, 0}, {1, 0, 0}, 5.f, shooterA)});
    r.frame(1);
    r.read();
    bool behindAlive = false;
    for (const GpuAgent& a : r.agents)
        if (std::fabs(a.pos.x - 36.f) < 1.f) behindAlive = Rig::health(a) > 0.99f;
    const auto hr3 = r.bridge.hitResults();
    check(hr3.size() == 1 && hr3[0].kind == HordeBridge::HitKind::Static && std::fabs(hr3[0].dist - 4.f) < 0.8f && behindAlive,
          "a wall stops the round; the zombie behind it is untouched",
          fmt("kind %.0f dist %.2f", hr3.empty() ? -1.0 : (double)hr3[0].kind, hr3.empty() ? -1.0 : hr3[0].dist));

    // ---- 4. kill stream over a crowd: unique, strictly increasing seqs, nothing lost or repeated ----------------------
    r.restart();
    r.sim.requestSpawn({-20.f, -30.f, -10.f, -20.f}, 300);
    r.frames(30);
    std::vector<KillEvent> all;
    const uint32_t d0 = r.sim.stats().deaths;
    for (int f = 0; f < 60; ++f) {
        std::vector<HitRequest> hs;
        for (int k = 0; k < 24; ++k) {
            float zz = -29.5f + (float)((f * 24 + k) % 40) * 0.25f;
            hs.push_back(ray({-35.f, 1.0f, zz}, {1, 0, 0.02f * (float)((k % 5) - 2)}, 0.55f, 100u + (uint32_t)k));
        }
        r.bridge.queueHits(hs);
        r.frame(1);
        r.bridge.takeKills(all);
    }
    r.frames(300);
    r.bridge.takeKills(all);
    bool increasing = true;
    for (size_t i = 1; i < all.size(); ++i) increasing &= all[i].seq == all[i - 1].seq + 1;
    std::vector<KillEvent> again;
    r.bridge.takeKills(again);
    r.frames(2);
    r.bridge.takeKills(again);
    check(all.size() > 20 && increasing && again.empty() && r.bridge.killsOverflowed() == 0 && r.sim.stats().deaths - d0 == all.size(),
          "kill stream: consecutive seqs, no duplicates, == settled deaths",
          fmt("%.0f kills, deaths +%.0f, dup dropped %.0f, overflow %.0f", (double)all.size(), r.sim.stats().deaths - d0,
              (double)r.bridge.stats().duplicatesDropped, (double)r.bridge.killsOverflowed()));
    // field: the crowd shows up in its tiles
    const ZombieField& zf = r.bridge.field();
    uint32_t inField = 0;
    for (const ZombieFieldTile& t : zf.tiles) inField += t.count;
    r.read();
    uint32_t aliveNow = 0;
    for (const GpuAgent& a : r.agents) aliveNow += Rig::state(a) < ST_DYING ? 1 : 0;
    const ZombieFieldTile* t0 = nullptr;
    float tx = 0, tz = 0;
    for (const GpuAgent& a : r.agents)
        if (Rig::state(a) < ST_DYING) { t0 = zf.at(a.pos.x, a.pos.z); tx = a.pos.x; tz = a.pos.z; break; }
    bool inTile = t0 && t0->samples > 0;
    for (uint32_t k = 0; t0 && k < t0->samples; ++k)
        inTile &= (int)std::floor((t0->pos[k].x - zf.originX) / zf.tileSize) == (int)std::floor((tx - zf.originX) / zf.tileSize) &&
                  (int)std::floor((t0->pos[k].z - zf.originZ) / zf.tileSize) == (int)std::floor((tz - zf.originZ) / zf.tileSize);
    check(aliveNow > 0 && inField == aliveNow && t0 && t0->count > 0 && inTile,
          "zombie field: tile counts == live walkers, samples inside their tile",
          fmt("field %.0f, live %.0f, tile of a survivor %.0f", inField, aliveNow, t0 ? t0->count : 0));

    // ---- 5. soldier collider + contacts: zombies drawn to a soldier stop at its capsule and are reported ---------------
    r.restart();
    const V3 sp{0.f, 0.f, 20.f};
    HordeSoldier so;
    so.pos = sp; so.radius = 0.35f; so.height = 1.75f; so.packedId = 42u | (1u << 16);
    r.bridge.uploadSoldiers({so});
    Attractor at;
    at.pos = sp; at.radius = 1.5f; at.awareness = 30.f;
    r.bridge.setAttractors({at});
    r.sim.requestSpawn({-6.f, 8.f, 6.f, 12.f}, 60);
    float minD = 1e9f;
    for (int f = 0; f < 300; ++f) {   // 10 s
        r.frame(2);
        if (f > 150 && f % 10 == 0) {
            r.read();
            for (const GpuAgent& a : r.agents) minD = std::min(minD, std::hypot(a.pos.x - sp.x, a.pos.z - sp.z));
        }
    }
    const auto& cs = r.bridge.contacts();
    check(minD > 0.55f && minD < 1.2f, "soldier capsule keeps zombies out (infinite mass)", fmt("closest zombie centre %.2f m (R + r = 0.61)", minD));
    check(cs.size() == 1 && cs[0].packedId == so.packedId && cs[0].attackers >= 3 && cs[0].nearby >= cs[0].attackers && cs[0].nearestDist < 1.2f,
          "contacts: attackers within reach, nearby, nearest distance",
          fmt("attackers %.0f nearby %.0f nearest %.2f", cs.empty() ? 0 : cs[0].attackers, cs.empty() ? 0 : cs[0].nearby, cs.empty() ? -1 : cs[0].nearestDist));

    // ---- 6. attractor awareness: zombies within reach come, zombies beyond stay ---------------------------------------
    r.restart();
    r.bridge.uploadSoldiers({});
    const V3 ap{0.f, 0.f, 25.f};
    Attractor a6;
    a6.pos = ap; a6.radius = 1.5f; a6.awareness = 20.f;
    r.bridge.setAttractors({a6});
    r.sim.requestSpawn({-3.f, 9.f, 3.f, 13.f}, 25);      // ~14 m away: inside
    r.sim.requestSpawn({-3.f, -24.f, 3.f, -20.f}, 25);   // ~47 m away: outside
    r.frames(3);
    auto meanDist = [&](float zMin, float zMax, int& n) {
        r.read();
        double s = 0;
        n = 0;
        for (const GpuAgent& a : r.agents)
            if (a.pos.z >= zMin && a.pos.z <= zMax) { s += std::hypot(a.pos.x - ap.x, a.pos.z - ap.z); ++n; }
        return n ? s / n : 0.0;
    };
    int nn, nf;
    double near0 = meanDist(0.f, 30.f, nn), far0 = meanDist(-40.f, -10.f, nf);
    r.frames(240, 2);   // 8 s
    int nn1, nf1;
    double near1 = meanDist(0.f, 40.f, nn1), far1 = meanDist(-40.f, -10.f, nf1);
    check(nn1 > 15 && near1 < near0 - 6.0 && nf1 == nf && std::fabs(far1 - far0) < 1.5,
          "attractor: zombies within its awareness radius converge, those beyond do not",
          fmt("near %.1f -> %.1f m, far %.1f -> %.1f m", near0, near1, far0, far1));
    // without attractors the flow decays: the near group stops converging (no global goal in game mode)
    r.bridge.setAttractors({});
    r.frames(60, 2);
    double nearA = meanDist(0.f, 40.f, nn1);
    r.frames(60, 2);
    double nearB = meanDist(0.f, 40.f, nn1);
    check(std::fabs(nearB - nearA) < 1.0, "attractor removed: flow gated, the group stops", fmt("%.2f -> %.2f m", nearA, nearB));

    // ---- 7. async: harvest never waits ------------------------------------------------------------------------------
    r.bridge.setSync(false);
    double worst = 0;
    uint64_t first = r.bridge.lastHarvestedFrame();
    for (int f = 0; f < 12; ++f) {
        r.bridge.queueHits({ray({0, 1.2f, 0}, {0, 0, 1}, 0.2f, 5u)});
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
        r.bridge.preSim(cmd);
        r.sim.step(cmd);
        r.bridge.postSim(cmd, 0);
        r.sim.onFrameSubmitted(SDL_SubmitGPUCommandBufferAndAcquireFence(cmd));
        const uint64_t t0 = SDL_GetPerformanceCounter();
        r.bridge.harvest();
        worst = std::max(worst, (double)(SDL_GetPerformanceCounter() - t0) * 1000.0 / (double)SDL_GetPerformanceFrequency());
    }
    SDL_WaitForGPUIdle(gpu.device());
    r.bridge.harvest();
    check(r.bridge.lastHarvestedFrame() > first && r.bridge.lastHarvestedFrame() <= r.sim.submittedFrames() && worst < 20.0,
          "readback ring: harvest() never waits, data arrives by frame number",
          fmt("worst harvest %.2f ms, harvested frame %.0f of %.0f, skipped slots %.0f", worst, (double)r.bridge.lastHarvestedFrame(),
              (double)r.sim.submittedFrames(), (double)r.bridge.stats().slotsSkipped));

    r.bridge.shutdown();
    r.sim.shutdown();
    return g_hfail;
}

} // namespace ttz::game
