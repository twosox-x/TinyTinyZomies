// Self-test section "vertical horde" (B3b): HordeVertical + HordeBridge against a real CrowdSim on a small arena with
// one representative building (12 x 12 m, 4 floors, 12 m flat roof, one street door, a roof hatch). Synchronous
// downloads inspect the agents (test only); the bridge / vertical passes run exactly as in the game.
#include "game/HordeVertical.h"

#include "game/HordeBridge.h"
#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace ttz::game {

namespace {
int g_vfail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_vfail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0, double e = 0) {
    char buf[320];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d, e);
    return buf;
}

// The test building: footprint x 12..24, z -6..6, roof 12 m; door on the south facade (z = -6) facing -z.
constexpr float BX0 = 12.f, BX1 = 24.f, BZ0 = -6.f, BZ1 = 6.f, ROOF = 12.f;
Building testBuilding() {
    Building b;
    b.kind = BuildingKind::Mid;
    b.floors = 4;
    b.floorHeight = 3.f;
    b.ox = BX0; b.oz = BZ0; b.e1x = 1; b.e1z = 0; b.e2x = 0; b.e2z = 1;
    b.w = BX1 - BX0; b.d = BZ1 - BZ0;
    b.y0 = 0.f; b.roofY = ROOF; b.topY = ROOF; b.flatRoof = true;
    b.stairU = 6.f; b.stairV = 4.f;
    Opening door;
    door.type = OpeningType::Door; door.floor = 0; door.pos = {18.f, 0.f, BZ0}; door.nx = 0; door.nz = -1;
    b.openings.push_back(door);
    Opening hatch;
    hatch.type = OpeningType::RoofHatch; hatch.floor = kRoofFloor; hatch.pos = {18.f, ROOF, -2.f}; hatch.nx = 0; hatch.nz = 0;
    b.openings.push_back(hatch);
    b.prepared = b.supported = true;
    return b;
}

struct Rig {
    GpuContext* gpu = nullptr;
    CrowdSim sim;
    HordeBridge bridge;
    HordeVertical vert;
    Sandbox sb;
    std::vector<Building> blds;
    std::vector<HordeSoldier> soldiers;
    std::vector<GpuAgent> agents;
    uint32_t counters[C_COUNT] = {};
    double t = 0;
    float breachDealt = 0;
    int broken = 0;

    void frame(int steps) {
        bridge.uploadSoldiers(soldiers);
        vert.tick(soldiers, t);
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu->device());
        bridge.preSim(cmd);
        for (int i = 0; i < steps; ++i) sim.step(cmd);
        bridge.postSim(cmd, 0);
        vert.postSim(cmd);
        sim.recordStatsReadback(cmd);
        sim.onFrameSubmitted(SDL_SubmitGPUCommandBufferAndAcquireFence(cmd));
        bridge.harvest();
        vert.harvest();
        t += steps * sim.params().fixedDt;
    }
    void read() {
        gpu->downloadNow(sim.counters(), counters, sizeof(counters));
        agents.resize(counters[C_LIVE]);
        if (!agents.empty()) gpu->downloadNow(sim.agents(), agents.data(), (uint32_t)(agents.size() * sizeof(GpuAgent)));
    }
    int onRoof() const {
        int n = 0;
        for (const GpuAgent& a : agents)
            if ((a.info.x & 0xFF) < ST_DYING && a.pos.y > ROOF - 1.f && a.pos.x > BX0 && a.pos.x < BX1 && a.pos.z > BZ0 && a.pos.z < BZ1) ++n;
        return n;
    }
    int elevated(float minY) const {
        int n = 0;
        for (const GpuAgent& a : agents) if ((a.info.x & 0xFF) < ST_DEAD && a.pos.y > minY) ++n;
        return n;
    }
    void restart(const Building& b) {
        sim.reset(sb);
        bridge.reset();
        vert.reset();
        blds = {b};
        soldiers.clear();
        bridge.uploadSoldiers({});
        bridge.setAttractors({});
        std::vector<KillEvent> drop;
        bridge.takeKills(drop);
        breachDealt = 0;
        broken = 0;
    }
    int attackersOn(uint32_t packed) const {
        for (const SoldierContact& c : bridge.contacts()) if (c.packedId == packed) return c.attackers;
        return 0;
    }
};

HordeSoldier soldierAt(V3 p, uint32_t id) {
    HordeSoldier h;
    h.pos = p; h.packedId = id; h.attraction = 1.f;
    return h;
}
} // namespace

int selfTestHordeVertical(GpuContext& gpu, const SimParams& base) {
    std::printf("vertical horde (B3b: entrances, stairs, roof, barricades)\n");
    g_vfail = 0;
    SimParams p = base;
    p.gridW = p.gridH = 128;            // 96 m arena, one building
    p.agentCapacity = 8192;
    p.corpseCapacity = 8192;
    p.wander = 0.f;
    Rig r;
    r.gpu = &gpu;
    r.sb.build(p.cellSize, p.gridW, p.gridH, MapKind::Arena);
    r.sb.boxes.clear();
    r.sb.scenarios.clear();
    r.sb.boxes.push_back({BX0, BZ0, BX1, BZ1, ROOF, BoxKind::Building, true});
    if (!r.sim.init(gpu, p, r.sb)) { check(false, "sim init", ""); return 1; }
    r.sim.setGoals({});
    if (!r.bridge.init(gpu, r.sim)) { check(false, "bridge init", ""); r.sim.shutdown(); return 1; }
    if (!r.vert.init(gpu, r.sim, r.bridge)) { check(false, "vertical init (game_vertical pipeline)", ""); r.bridge.shutdown(); r.sim.shutdown(); return 1; }
    r.bridge.setSync(true);
    r.vert.setSync(true);
    r.bridge.setVertical(true);
    r.bridge.setAwarenessRadius(60.f);
    r.vert.buildings = &r.blds;
    r.vert.damageBarricade = [&r](BuildingId id, uint16_t op, float dmg) {
        Opening& o = r.blds[id.v].openings[op];
        if (o.open()) return;
        r.breachDealt += dmg;
        o.barricadeHealth -= dmg;
        if (o.barricadeHealth <= 0.f) { o.barricadeHealth = 0.f; ++r.broken; }
    };
    const uint32_t S1 = 1u | (1u << 16), S2 = 2u | (1u << 16);
    const Rect horde{11.f, -32.f, 25.f, -22.f};   // 16-26 m south of the door
    const int N = 150;

    // ---- 1. soldiers on the roof: the horde enters, climbs the stairs, reaches the roof, attacks ---------------------
    double tCapture = -1, tRoof = -1, tAttack = -1, tRoofA = -1;
    int maxRoof = 0, maxAtt = 0, wallClimbers = 0;
    {
        r.restart(testBuilding());
        r.sim.requestSpawnLook(horde, N, 0, 0);
        r.soldiers = {soldierAt({16.f, ROOF, 3.f}, S1), soldierAt({20.f, ROOF, 3.f}, S2)};
        r.bridge.setAttractors({{{18.f, ROOF, 3.f}, 1.f, 3.f, 0.f}});
        const double t0 = r.t;
        for (int f = 0; f < 60 * 30; ++f) {   // 60 s at 2 steps / frame
            r.frame(2);
            const auto& s = r.vert.stats();
            if (tCapture < 0 && s.captured > 0) tCapture = r.t - t0;
            if ((f % 15) == 0) {
                r.read();
                int roof = r.onRoof();
                maxRoof = std::max(maxRoof, roof);
                if (tRoof < 0 && roof > 0) tRoof = r.t - t0;
                // nobody gets up the 12 m facade except through the building (no wall climbing / teleports)
                for (const GpuAgent& a : r.agents)
                    if ((a.info.x & 0xFF) < ST_DEAD && a.pos.y > 4.5f && !(a.pos.x > BX0 - 0.5f && a.pos.x < BX1 + 0.5f && a.pos.z > BZ0 - 0.5f && a.pos.z < BZ1 + 0.5f)) {
                        ++wallClimbers;
                        if (std::getenv("TTZ_VDEBUG")) std::printf("    climber t %.1f pos %.2f %.2f %.2f vel %.2f %.2f %.2f st %u\n", r.t - t0, a.pos.x, a.pos.y, a.pos.z, a.vel.x, a.vel.y, a.vel.z, a.info.x & 0xFF);
                    }
                if (std::getenv("TTZ_VDEBUG") && roof > 0 && tAttack < 0)
                    for (const GpuAgent& a : r.agents)
                        if (a.pos.y > ROOF - 1.f) std::printf("    roof t %.1f pos %.2f %.2f %.2f vel %.2f %.2f dirs %.2f %.2f st %u\n", r.t - t0, a.pos.x, a.pos.y, a.pos.z, a.vel.x, a.vel.z, a.dirs.x, a.dirs.y, a.info.x & 0xFF);
            }
            int att = r.attackersOn(S1) + r.attackersOn(S2);
            maxAtt = std::max(maxAtt, att);
            if (tAttack < 0 && att > 0) tAttack = r.t - t0;
            if (tRoofA < 0 && s.emitted > 0) tRoofA = r.t - t0;
            if (tAttack > 0 && r.t - t0 > tAttack + 5.0) break;
        }
        const auto& s = r.vert.stats();
        std::printf("  roof: first capture %.1f s, first out of the hatch %.1f s, first agent on the roof %.1f s, first attack %.1f s; "
                    "captured %llu, emitted %llu, inside %d, max on roof %d, max attackers %d, uploads %llu, cpu %.3f ms\n",
                    tCapture, tRoofA, tRoof, tAttack, (unsigned long long)s.captured, (unsigned long long)s.emitted, s.occupants, maxRoof, maxAtt,
                    (unsigned long long)s.uploads, s.cpuMs);
        check(tCapture > 0 && tCapture < 30.0, "zombies attracted by roof soldiers go in through the door", fmt("first capture %.1f s", tCapture));
        check(tRoof > 0 && tRoof < 50.0 && tRoof > tCapture + 15.0,
              "they climb the stairs (4 floors) and come out on the roof in the expected time",
              fmt("first on the roof %.1f s (capture + %.1f s; graph minimum ~22 s)", tRoof, tRoof - tCapture));
        check(tAttack > 0 && maxAtt > 0, "roof zombies reach the soldiers and attack them (contact attackers)", fmt("first attack %.1f s, max attackers %.0f", tAttack, maxAtt));
        check(wallClimbers == 0, "nobody climbs the 12 m facade (crowd piles at the jammed door stay below 4.5 m)", fmt("%.0f samples", wallClimbers));
    }

    // ---- 2. barricaded door: delays them until breached -------------------------------------------------------------
    {
        Building b = testBuilding();
        b.openings[0].barricade = BarricadeType::Planks;
        b.openings[0].barricadeHealth = b.openings[0].barricadeMax = 240.f;
        r.restart(b);
        r.sim.requestSpawnLook(horde, N, 0, 0);
        r.soldiers = {soldierAt({16.f, ROOF, 3.f}, S1), soldierAt({20.f, ROOF, 3.f}, S2)};
        r.bridge.setAttractors({{{18.f, ROOF, 3.f}, 1.f, 3.f, 0.f}});
        const double t0 = r.t;
        double tBroken = -1, tCap = -1;
        uint64_t capturedBeforeBreak = 0;
        for (int f = 0; f < 60 * 30; ++f) {
            r.frame(2);
            if (tBroken < 0 && r.broken > 0) { tBroken = r.t - t0; capturedBeforeBreak = r.vert.stats().captured; }
            if (tCap < 0 && r.vert.stats().captured > 0) tCap = r.t - t0;
            if (tCap > 0 && r.t - t0 > tCap + 3.0) break;
        }
        std::printf("  barricade: breach damage %.1f of 240, broken at %.1f s, first capture %.1f s (unbarricaded %.1f s)\n", r.breachDealt, tBroken, tCap, tCapture);
        check(tBroken > 0 && capturedBeforeBreak == 0, "a barricaded door holds them (battered) until breached", fmt("broken at %.1f s, captured before %.0f", tBroken, (double)capturedBeforeBreak));
        check(tCap > 0 && tCap > tCapture + 3.0, "the breach delays the entry", fmt("first capture %.1f s vs %.1f s open", tCap, tCapture));
    }

    // ---- 3. a building without soldiers is ignored (a street soldier right next to its door) ------------------------
    {
        r.restart(testBuilding());
        r.sim.requestSpawnLook(horde, N, 0, 0);
        r.soldiers = {soldierAt({18.f, 0.f, -11.f}, S1)};
        r.bridge.setAttractors({{{18.f, 0.f, -11.f}, 1.f, 2.f, 0.f}});
        int elev = 0;
        for (int f = 0; f < 30 * 30; ++f) {
            r.frame(2);
            if ((f % 30) == 0) { r.read(); elev = std::max(elev, r.elevated(4.5f) + r.onRoof()); }
        }
        const auto& s = r.vert.stats();
        check(s.captured == 0 && s.activeBuildings == 0 && elev == 0, "unbarricaded building with no soldiers: zombies at its door do not go in",
              fmt("captured %.0f, active %.0f, above 4.5 m / on the roof %.0f", (double)s.captured, s.activeBuildings, elev));
    }

    // ---- 4. soldiers on the 2nd floor: the horde stops there and fights inside; drains when they leave ------------
    {
        r.restart(testBuilding());
        r.sim.requestSpawnLook(horde, N, 0, 0);
        r.soldiers = {soldierAt({16.f, 6.f, 2.f}, S1), soldierAt({20.f, 6.f, 2.f}, S2)};
        r.bridge.setAttractors({{{18.f, 6.f, 2.f}, 1.f, 3.f, 0.f}});
        int maxFloor = 0, maxAtt2 = 0;
        std::vector<KillEvent> kills;
        for (int f = 0; f < 60 * 30; ++f) {
            r.frame(2);
            for (const auto& v : r.vert.active())
                if (v.perFloor.size() > 2) maxFloor = std::max<int>(maxFloor, v.perFloor[2]);
            maxAtt2 = std::max(maxAtt2, r.attackersOn(S1) + r.attackersOn(S2));
            r.bridge.takeKills(kills);
        }
        const auto& s = r.vert.stats();
        int interiorKills = 0;
        for (const KillEvent& k : kills) interiorKills += (k.cause == KillCause::Soldier && (k.shooterPacked == S1 || k.shooterPacked == S2)) ? 1 : 0;
        std::printf("  floor 2: max occupants there %d, max interior attackers %d, killed inside %llu (kill events %d), emitted %llu\n",
                    maxFloor, maxAtt2, (unsigned long long)s.killedInside, interiorKills, (unsigned long long)s.emitted);
        check(maxFloor > 0 && s.emitted == 0, "soldiers on floor 2: occupants stop at floor 2 (none go on to the roof)", fmt("max at floor 2 %.0f, emitted %.0f", maxFloor, (double)s.emitted));
        check(maxAtt2 > 0, "occupants on the soldiers' floor attack them (interior attackers)", fmt("max %.0f", maxAtt2));
        check(s.killedInside > 0 && interiorKills == (int)s.killedInside, "defenders kill occupants inside; each kill is one kill event credited to a defender",
              fmt("killed inside %.0f, kill events %.0f", (double)s.killedInside, interiorKills));
        // soldiers leave: the building drains through its door
        r.soldiers.clear();
        r.bridge.setAttractors({});
        const int inside0 = r.vert.stats().occupants;
        for (int f = 0; f < 45 * 30; ++f) r.frame(2);
        check(inside0 > 0 && r.vert.stats().occupants == 0 && r.vert.stats().leftByDoor > 0, "without soldiers the occupants walk back out of the door",
              fmt("inside %.0f -> %.0f, left by the door %.0f", inside0, r.vert.stats().occupants, (double)r.vert.stats().leftByDoor));
    }

    r.vert.shutdown();
    r.bridge.shutdown();
    r.sim.shutdown();
    std::printf("vertical horde: %s (%d failed)\n", g_vfail ? "FAILED" : "passed", g_vfail);
    return g_vfail;
}

} // namespace ttz::game
