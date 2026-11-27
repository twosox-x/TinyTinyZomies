// Self-test section "ai / nav" (WS-C): soldiers, squads, navigation, AI and combat logic against the CPU FakeHorde /
// FakeSupply on a synthetic height map. No GPU. Called from SelfTest.cpp (testGameCore); returns the failure count.
#include "game/Combat.h"
#include "game/Config.h"
#include "game/FakeHorde.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>

namespace ttz::game {

namespace {

int g_soldierFail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_soldierFail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d);
    return buf;
}
float d2(V3 a, V3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)); }

// 120 x 120 cells of 0.75 m (90 m): street level 0, a 15 m block in the middle (12 m tall), a flat roof (8 m) in a
// corner, a curb strip (0.15 m) that must stay walkable.
constexpr int kW = 120, kH = 120;
constexpr float kCell = 0.75f;
std::vector<float> testHeights() {
    std::vector<float> h((size_t)kW * kH, 0.f);
    for (int j = 0; j < kH; ++j)
        for (int i = 0; i < kW; ++i) {
            float& v = h[(size_t)j * kW + i];
            if (i >= 50 && i < 70 && j >= 50 && j < 70) v = 12.f;           // block (x, z 37.5 .. 52.5)
            if (i >= 8 && i < 22 && j >= 96 && j < 110) v = 8.f;            // roof island (x 6..16.5, z 72..82.5)
            if (j >= 20 && j < 22) v = std::max(v, 0.15f);                    // curb
        }
    return h;
}

struct TestWorld {
    BalanceConfig cfg;
    SoldierPool pool;
    SquadList squads;
    NavGrid nav;
    FakeHorde horde;
    FakeSupply supply;
    TickEvents ev;
    std::vector<AnimEvent> animEv;
    SoldierAI ai;
    Combat combat;
    GameContext ctx;
    std::function<void()> beforeCombat;   // inject clip events (event-sync test)
    explicit TestWorld(const BalanceConfig& c) : cfg(c) {
        nav.build(testHeights(), kW, kH, 0.f, 0.f, kCell);
        horde.nav = &nav;
        horde.setBounds(0, 0, kW * kCell, kH * kCell);
        horde.attackReach = cfg.threat.attackReach;
        ai.supply = &supply;
        combat.supply = &supply;
        ctx.cfg = &cfg; ctx.soldiers = &pool; ctx.squads = &squads; ctx.nav = &nav; ctx.horde = &horde;
        ctx.events = &ev; ctx.animEvents = &animEv; ctx.animator = nullptr;
    }
    void tick() {
        ev.clear();
        animEv.clear();
        horde.takeKills(ev.kills);
        ai.tick(ctx);
        if (beforeCombat) beforeCombat();
        combat.tick(ctx);
        horde.step(ctx.dt);
        ctx.time += kTickDt;
        ++ctx.tick;
    }
    void run(float seconds, const std::function<void()>& each = {}) {
        const int n = (int)std::lround(seconds / kTickDt);
        for (int k = 0; k < n; ++k) { tick(); if (each) each(); }
    }
    int totalAmmo(SquadId id) const {
        int n = 0;
        for (const SoldierId& m : squads.get(id)->members) n += pool.mag[m.index] + pool.reserve[m.index] + pool.carry[m.index];
        return n;
    }
    void order(SquadId id, V3 dest, float facing = 0.f, bool run = false) {
        Squad* s = squads.get(id);
        s->order.active = true; s->order.dest = dest; s->order.facing = facing; s->order.run = run; ++s->order.serial;
    }
};

float pathLength(V3 from, const std::vector<V3>& pts) {
    float l = 0;
    V3 p = from;
    for (const V3& q : pts) { l += d2(p, q); p = q; }
    return l;
}

bool solvePath(NavGrid& nav, V3 a, V3 b, std::vector<V3>& out, int budget = 1000000) {
    const uint32_t id = nav.requestPath(a, b);
    bool failed = false;
    for (int k = 0; k < 200; ++k) {
        nav.tick(budget);
        if (nav.poll(id, out, failed)) return !failed;
    }
    return false;
}

} // namespace

int runSoldierSelfTest(const BalanceConfig& cfg) {
    g_soldierFail = 0;
    std::printf("ai / nav (WS-C, CPU FakeHorde)\n");

    // ---- squads: approved compositions, equipment from the config
    {
        TestWorld w(cfg);
        SquadId r = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 0, 1);
        SquadId m = SoldierAI::spawnLanded(w.ctx, SquadType::MachineGun, {30, 0, 30}, 0, 2);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Sniper, {40, 0, 20}, 0, 3);
        const Squad *R = w.squads.get(r), *M = w.squads.get(m), *S = w.squads.get(s);
        bool classes = true, equip = true;
        for (const Squad* q : {R, M, S})
            for (const SoldierId& id : q->members) {
                const uint32_t i = id.index;
                const SoldierClass want = q == R ? SoldierClass::Rifleman : q == M ? SoldierClass::MachineGunner : SoldierClass::Sniper;
                classes &= w.pool.cls[i] == want;
                equip &= w.pool.health[i] == cfg.soldier[(int)want].health && w.pool.mag[i] == cfg.weapon[(int)want].magazine &&
                         w.pool.reserve[i] == cfg.weapon[(int)want].reserve;
            }
        check(R->members.size() == 5 && M->members.size() == 3 && S->members.size() == 1 && classes,
              "squads spawn whole: 5 riflemen / 3 machine gunners / 1 sniper", fmt("%.0f / %.0f / %.0f", (double)R->members.size(), (double)M->members.size(), (double)S->members.size()));
        check(equip, "soldiers equipped from balance.json (health, magazine, reserve)", "");
        w.run(3.f);
        int idle = 0;
        for (const Squad* q : {R, M, S}) for (const SoldierId& id : q->members) idle += w.pool.state[id.index] == SoldierState::Idle ? 1 : 0;
        check(idle == 9, "landed squads form up and hold (Forming -> Idle)", fmt("%.0f of 9 idle", idle));
    }

    // ---- navigation
    {
        NavGrid nav;
        nav.build(testHeights(), kW, kH, 0.f, 0.f, kCell);
        std::vector<V3> path;
        const V3 a{30, 0, 45}, b{60, 0, 45};   // straight line crosses the block
        const bool ok = solvePath(nav, a, b, path);
        bool clean = ok;
        V3 prev = a;
        for (const V3& p : path) { clean &= nav.walkLine(prev, p) && nav.surface(p.x, p.z) < 1.f; prev = p; }
        check(ok && clean && pathLength(a, path) > 30.5f && path.size() <= 6, "A* path around a building, string-pulled, every leg walkable",
              fmt("ok=%.0f legs=%.0f length=%.1f m (straight 30)", ok, (double)path.size(), pathLength(a, path)));
        const V3 roof{11, 8, 77};
        const bool toRoof = solvePath(nav, a, roof, path);   // snaps to the street next to the building
        const bool endsOnStreet = toRoof && !path.empty() && nav.island(path.back().x, path.back().z) == nav.island(a.x, a.z);
        check(nav.walkable(roof.x, roof.z) && nav.island(roof.x, roof.z) != nav.island(a.x, a.z) && endsOnStreet,
              "flat roof is its own island: walkable, a street path never ends on it", fmt("islands %.0f vs %.0f", nav.island(roof.x, roof.z), nav.island(a.x, a.z)));
        check(nav.walkable(20, 15.5f) && solvePath(nav, {20, 0, 10}, {20, 0, 25}, path), "curb (0.15 m) is walkable and crossable", "");
        check(!nav.lineOfSight({30, 1.5f, 45}, {60, 1.f, 45}) && nav.lineOfSight({10, 1.5f, 10}, {80, 1.f, 10}), "line of sight blocked by buildings only", "");
        const uint32_t id = nav.requestPath({2, 0, 2}, {88, 0, 88});
        std::vector<V3> out;
        bool failed = false;
        nav.tick(200);
        const bool early = nav.poll(id, out, failed);
        int ticks = 1;
        while (!nav.poll(id, out, failed) && ticks < 500) { nav.tick(200); ++ticks; }
        check(!early && !failed && ticks > 3, "path queries are time-sliced (node budget per tick)", fmt("%.0f ticks at 200 nodes", ticks));
        V3 snapped;
        const bool snappedOk = nav.nearestWalkable({45, 0, 45}, 9.f, snapped, nav.island(a.x, a.z));
        check(snappedOk && nav.walkable(snapped.x, snapped.z) && nav.surface(snapped.x, snapped.z) < 1.f,
              "nearest walkable street point from a building footprint (order / drop snapping)", fmt("(%.1f, %.1f)", snapped.x, snapped.z));
    }

    // ---- autonomous engagement against a fake horde (+ determinism, ammo accounting, leash)
    auto engageRun = [&](uint64_t& rounds, int& kills, double& sig, float& maxDisp, int& ammoDelta, uint32_t& switches, uint64_t& hitsQueued) {
        TestWorld w(cfg);
        SquadId r = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 1.5708f, 11);
        w.horde.speed = 0.8f;
        w.horde.spawn({50, 0, 28}, 4.f, 30, 99);
        w.run(2.f);
        const int ammo0 = w.totalAmmo(r);
        const uint64_t r0 = w.combat.roundsFired();
        maxDisp = 0;
        w.run(40.f, [&] {
            for (const SoldierId& m : w.squads.get(r)->members) maxDisp = std::max(maxDisp, d2(w.pool.pos[m.index], w.pool.home[m.index]));
        });
        rounds = w.combat.roundsFired() - r0;
        kills = (int)w.horde.killsTotal;
        ammoDelta = ammo0 - w.totalAmmo(r);
        hitsQueued = w.horde.hitsQueued;
        switches = w.ai.status(w.ctx, r).targetSwitches;
        sig = 0;
        for (const SoldierId& m : w.squads.get(r)->members) sig += w.pool.pos[m.index].x * 1.7 + w.pool.pos[m.index].z * 3.1 + w.pool.health[m.index];
        sig += (double)w.combat.roundsFired() * 0.01;
    };
    {
        uint64_t rounds, rounds2, hq, hq2;
        int kills, kills2, ammoDelta, ammoDelta2;
        double sig, sig2;
        float disp, disp2;
        uint32_t sw, sw2;
        engageRun(rounds, kills, sig, disp, ammoDelta, sw, hq);
        engageRun(rounds2, kills2, sig2, disp2, ammoDelta2, sw2, hq2);
        check(kills >= 15 && rounds > 0, "rifle squad engages a fake horde autonomously", fmt("%.0f kills of 30, %.0f rounds", kills, (double)rounds));
        check(ammoDelta == (int)rounds && hq >= rounds, "ammo decreases by exactly the rounds fired (each round = one hit request)",
              fmt("ammo -%.0f, rounds %.0f, hit requests %.0f", ammoDelta, (double)rounds, (double)hq));
        check(disp < cfg.squad[0].formationSpacing + 3.5f, "no chasing: soldiers hold near their formation slots", fmt("max %.2f m from home", disp));
        check(sw <= (uint32_t)kills + 10, "target switches bounded by kills (hysteresis, no flip-flopping)", fmt("%.0f switches, %.0f kills", sw, kills));
        check(sig == sig2 && rounds == rounds2 && kills == kills2, "deterministic with a seed (two runs identical)", fmt("%.0f vs %.0f rounds", (double)rounds, (double)rounds2));
    }

    // ---- reload synced to the magazine, finite ammo
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 1.5708f, 5);
        Squad* q = w.squads.get(s);
        for (size_t k = 1; k < q->members.size(); ++k) w.pool.health[q->members[k].index] = 0.f;   // keep one rifleman
        const uint32_t i = q->members[0].index;
        w.horde.immortal = true; w.horde.speed = 0.f;
        w.horde.add({38, 0, 30});
        bool sawReload = false, sawEmpty = false;
        int magAfter = -1, reserveAfter = -1;
        uint64_t roundsAtReload = 0;
        w.run(20.f, [&] {
            if (w.pool.mag[i] == 0) sawEmpty = true;
            if (w.pool.state[i] == SoldierState::Reloading && !sawReload) { sawReload = true; roundsAtReload = w.pool.rounds[i]; }
            if (sawReload && magAfter < 0 && (w.pool.phase[i] & PH_RELOADED)) { magAfter = w.pool.mag[i]; reserveAfter = w.pool.reserve[i]; }
        });
        const WeaponStats& wr = cfg.weapon[0];
        check(sawEmpty && sawReload && roundsAtReload == (uint64_t)wr.magazine && magAfter == wr.magazine && reserveAfter == wr.reserve - wr.magazine,
              "empty magazine -> reload moves magazine rounds from the reserve", fmt("rounds before reload %.0f, mag %.0f, reserve %.0f", (double)roundsAtReload, magAfter, reserveAfter));
        // run dry: fires until mag + reserve == 0, then stops shooting
        w.run(90.f);
        const uint64_t r1 = w.pool.rounds[i];
        w.run(5.f);
        check(w.pool.mag[i] + w.pool.reserve[i] == 0 && w.pool.rounds[i] == r1 && r1 == (uint64_t)(wr.magazine + wr.reserve) &&
              (w.squads.get(s)->flags & SQ_OUT_OF_AMMO),
              "ammo is finite: a dry soldier stops firing and the squad shows OUT_OF_AMMO", fmt("%.0f rounds in total", (double)r1));
    }

    // ---- event sync: rounds come from muzzle_flash events (no watchdog double count) when an animator runs
    {
        TestWorld w(cfg);
        SoldierAnimator anim;   // only request() is used (the test injects the clip events itself)
        w.ctx.animator = &anim;
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 1.5708f, 5);
        Squad* q = w.squads.get(s);
        for (size_t k = 1; k < q->members.size(); ++k) w.pool.health[q->members[k].index] = 0.f;
        const uint32_t i = q->members[0].index;
        w.horde.immortal = true; w.horde.speed = 0.f;
        w.horde.add({38, 0, 30});
        int injected = 0;
        w.beforeCombat = [&] {
            if (w.pool.state[i] == SoldierState::Engaging && (w.pool.phase[i] & PH_ACQUIRED) && w.ctx.tick % 9 == 0 && w.pool.mag[i] > 0) {
                AnimEvent e; e.soldier = i; e.type = "muzzle_flash"; w.animEv.push_back(e);
                AnimEvent e2 = e; e2.type = "suppressed"; w.animEv.push_back(e2);   // same instant: still one round
                ++injected;
            }
        };
        w.run(6.f);
        check(injected > 10 && w.pool.rounds[i] == (uint32_t)injected && w.combat.syntheticRounds() == 0,
              "fire sync: one round per muzzle_flash clip event, no extra rounds", fmt("%.0f events, %.0f rounds, %.0f synthetic", injected, w.pool.rounds[i], (double)w.combat.syntheticRounds()));
    }

    // ---- resupply trip: low ammo -> walk to the supply point -> collect -> back to the slot
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 0, 7);
        Squad* q = w.squads.get(s);
        for (size_t k = 1; k < q->members.size(); ++k) w.pool.health[q->members[k].index] = 0.f;
        const uint32_t i = q->members[0].index;
        w.run(1.f);
        const V3 home = w.pool.home[i];
        w.pool.mag[i] = 20; w.pool.reserve[i] = 0;
        SupplyId sp = w.supply.add({32, 0, 30}, {100, 0, 0}, 2);
        bool sawTrip = false, sawCollect = false;
        float far = 0;
        w.run(40.f, [&] {
            sawTrip |= w.pool.state[i] == SoldierState::Resupplying;
            sawCollect |= w.pool.state[i] == SoldierState::Collecting;
            far = std::max(far, d2(w.pool.pos[i], home));
        });
        check(sawTrip && sawCollect && w.pool.mag[i] + w.pool.reserve[i] == 120 && w.supply.stock(sp, AmmoType::Rifle) == 0 && w.supply.collected == 100,
              "resupply: walks to the supply point, collects its finite stock (stock - n, soldier + n)",
              fmt("ammo %.0f (expected 120), stock left %.0f", w.pool.mag[i] + w.pool.reserve[i], w.supply.stock(sp, AmmoType::Rifle)));
        check(far > 8.f && d2(w.pool.pos[i], home) < 1.f && w.pool.state[i] == SoldierState::Idle && w.supply.reservations(sp) == 0,
              "after collecting the soldier returns to its slot and frees the reservation", fmt("%.2f m from home", d2(w.pool.pos[i], home)));
    }
    {   // five soldiers resupplied from one 1-slot crate (ammo runner fetches for the squad), stock conserved
        BalanceConfig big = cfg;
        big.logistics.runnerCarryMagazines = 40;   // enough for the whole squad in one trip
        TestWorld w(big);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 0, 8);
        w.run(1.f);
        for (const SoldierId& m : w.squads.get(s)->members) { w.pool.mag[m.index] = 0; w.pool.reserve[m.index] = 20; }
        SupplyId sp = w.supply.add({30, 0, 36}, {5000, 0, 0}, 1);
        const int before = w.totalAmmo(s);
        int full = 0;
        w.run(150.f);
        for (const SoldierId& m : w.squads.get(s)->members) full += w.pool.mag[m.index] + w.pool.reserve[m.index] == w.pool.fullLoad(m.index, cfg) ? 1 : 0;
        check(full == 5 && w.totalAmmo(s) - before == 5000 - w.supply.stock(sp, AmmoType::Rifle) && w.supply.reservations(sp) == 0,
              "five soldiers resupplied from a one-slot supply point (ammo runner, no deadlock, conserved)", fmt("%.0f of 5 full, refused reservations %.0f", full, (double)w.supply.reserveRefused));
    }

    // ---- player move order takes priority over autonomy
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 1.5708f, 9);
        w.horde.immortal = true; w.horde.speed = 0.f;
        for (int k = 0; k < 6; ++k) w.horde.add({44, 0, 26.f + k * 1.5f});
        w.run(5.f);
        int engaged = 0;
        for (const SoldierId& m : w.squads.get(s)->members) engaged += w.pool.state[m.index] == SoldierState::Engaging ? 1 : 0;
        const V3 dest{70, 0, 75};   // behind the block: path around it
        w.order(s, dest, 0.f, true);
        w.run(0.2f);
        int moving = 0;
        for (const SoldierId& m : w.squads.get(s)->members) {
            const SoldierState st = w.pool.state[m.index];
            moving += st == SoldierState::Moving || st == SoldierState::Reloading || st == SoldierState::Hit ? 1 : 0;
        }
        w.run(40.f);
        int arrived = 0;
        float worst = 0;
        for (const SoldierId& m : w.squads.get(s)->members) {
            const float d = d2(w.pool.pos[m.index], w.pool.home[m.index]);
            worst = std::max(worst, d);
            arrived += d < 1.f && d2(w.pool.home[m.index], dest) < 8.f ? 1 : 0;
        }
        check(engaged >= 3 && moving == 5, "a move order interrupts engagement at once (order priority)", fmt("%.0f engaged before, %.0f moving after 0.2 s", engaged, moving));
        check(arrived == 5 && !w.squads.get(s)->stuck, "the squad reaches its formation slots around the order point (path around a block)", fmt("%.0f of 5, worst %.2f m", arrived, worst));
    }

    // ---- no oscillation: a slowly closing ring of zombies (immortal) for 30 s
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {25, 0, 25}, 0, 13);
        w.horde.immortal = true; w.horde.speed = 0.25f;
        for (int k = 0; k < 24; ++k) { const float a = k * 6.2831853f / 24; w.horde.add({25 + std::cos(a) * 16, 0, 25 + std::sin(a) * 16}); }
        w.run(1.f);
        const SoldierAI::SquadStatus a = w.ai.status(w.ctx, s);
        w.run(30.f);
        const SoldierAI::SquadStatus b = w.ai.status(w.ctx, s);
        const uint32_t sw = b.targetSwitches - a.targetSwitches, sc = b.stateChanges - a.stateChanges;
        // per soldier over 30 s: a handful of reloads / re-locks, never tick-rate flapping
        check(sw <= 5 * 6 && sc <= 5 * 14, "no oscillation: target switches and state changes stay bounded under pressure",
              fmt("%.0f switches, %.0f state changes (5 soldiers, 30 s)", sw, sc));
    }

    // ---- stuck recovery: a wall appears across the path -> one re-plan around it; a sealed goal -> hold + flag
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Sniper, {10, 0, 10}, 0, 21);
        w.run(1.f);
        const uint32_t i = w.squads.get(s)->members[0].index;
        w.order(s, {10, 0, 34});
        w.run(1.5f);   // path computed (straight north), walking
        std::vector<float> h = testHeights();
        for (int i2 = 6; i2 < 22; ++i2) h[(size_t)24 * kW + i2] = 3.f;   // wall at z = 18 from x 4.5 .. 16.5
        w.nav.updateRows(h, 24, 1);
        bool arrived = false;
        w.run(35.f, [&] {
            arrived |= d2(w.pool.pos[i], w.pool.home[i]) < 1.f && w.pool.state[i] == SoldierState::Idle;
            if (std::getenv("TTZ_AI_TRACE") && w.ctx.tick % 15 == 0)
                std::printf("    t=%.1f %s pos %.2f %.2f home %.2f %.2f stuck %.2f rep %d pts %d/%d\n", w.ctx.time, stateName(w.pool.state[i]), w.pool.pos[i].x, w.pool.pos[i].z,
                            w.pool.home[i].x, w.pool.home[i].z, w.pool.stuckTime[i], w.pool.repaths[i], (int)w.pool.path[i].next, (int)w.pool.path[i].points.size());
        });
        check(arrived && w.pool.repaths[i] <= 1 && !w.squads.get(s)->stuck, "stuck on a new obstacle -> re-plan once -> arrives",
              fmt("arrived=%.0f repaths=%.0f", arrived, w.pool.repaths[i]));
        // seal the goal area: the order cannot be reached -> hold where it is, squad flagged, no flapping
        for (int j = 60; j < 76; ++j) for (int i2 = 0; i2 < 120; ++i2) if (j == 60 || j == 75) h[(size_t)j * kW + i2] = 3.f;
        for (int j = 60; j < 76; ++j) { h[(size_t)j * kW + 0] = 3.f; h[(size_t)j * kW + 119] = 3.f; }
        w.nav.build(h, kW, kH, 0.f, 0.f, kCell);
        const uint32_t sc0 = w.pool.stateChanges[i];
        w.order(s, {30, 0, 51});
        w.run(20.f);
        check(w.squads.get(s)->stuck && w.pool.state[i] == SoldierState::Idle && w.pool.stateChanges[i] - sc0 <= 4,
              "unreachable order: soldier holds, squad flagged stuck, no retry loop", fmt("state changes %.0f", (double)(w.pool.stateChanges[i] - sc0)));
    }

    {   // no progress at all (soldier cannot advance): stuckTime -> one re-plan -> hold + flag, never an endless loop
        BalanceConfig slow = cfg;
        slow.soldier[(int)SoldierClass::Sniper].walkSpeed = 0.f;
        slow.soldier[(int)SoldierClass::Sniper].runSpeed = 0.f;
        TestWorld w(slow);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::Sniper, {10, 0, 10}, 0, 23);
        w.run(1.f);
        const uint32_t i = w.squads.get(s)->members[0].index;
        int maxRepaths = 0;
        w.order(s, {30, 0, 10});
        w.run(15.f, [&] { maxRepaths = std::max(maxRepaths, (int)w.pool.repaths[i]); });
        check(maxRepaths == 1 && w.squads.get(s)->stuck && w.pool.state[i] == SoldierState::Idle && d2(w.pool.home[i], w.pool.pos[i]) < 0.5f,
              "no progress for stuckTime -> one re-plan -> holds in place, squad flagged", fmt("repaths %.0f", maxRepaths));
    }

    // ---- zombie contact damage, hit reaction cooldown, death, casualties flag, attractors
    {
        TestWorld w(cfg);
        SquadId s = SoldierAI::spawnLanded(w.ctx, SquadType::MachineGun, {30, 0, 30}, 0, 31);
        w.run(1.f);
        const uint32_t i = w.squads.get(s)->members[0].index;
        w.pool.mag[i] = 0; w.pool.reserve[i] = 0;   // cannot shoot back
        for (const SoldierId& m : w.squads.get(s)->members) if (m.index != i) { w.pool.mag[m.index] = 0; w.pool.reserve[m.index] = 0; }
        w.horde.immortal = true; w.horde.speed = 1.5f; w.horde.awareness = 3.f;
        const V3 p = w.pool.pos[i];
        w.horde.add({p.x, 0, p.z + 1.5f}); w.horde.add({p.x, 0, p.z - 1.5f});   // the line runs along x
        bool attacked = false;
        int hits = 0;
        SoldierState prev = w.pool.state[i];
        w.run(12.f, [&] {
            attacked |= (w.squads.get(s)->flags & SQ_UNDER_ATTACK) != 0;
            if (w.pool.state[i] == SoldierState::Hit && prev != SoldierState::Hit) ++hits;
            prev = w.pool.state[i];
        });
        const float maxHits = 12.f / w.combat.hitCooldown + 1.f;
        check(attacked && hits >= 1 && hits <= (int)maxHits, "zombie contact damages soldiers; hit reaction at most once per cooldown",
              fmt("%.0f hit reactions in 12 s (cooldown %.1f s)", hits, w.combat.hitCooldown));
        check(w.pool.state[i] == SoldierState::Dead && w.pool.health[i] <= 0.f && (w.squads.get(s)->flags & SQ_CASUALTIES) && w.squads.aliveMembers(*w.squads.get(s), w.pool) < 3,
              "health 0 -> Dying -> Dead; squad survives with a casualty flag", std::string("state ") + stateName(w.pool.state[i]));
        check(!w.combat.attractors().empty(), "living squads are uploaded as horde attractors", fmt("%.0f attractors", (double)w.combat.attractors().size()));
    }

    // ---- noise: MG loud, suppressed sniper quiet (per-shot noise events + suppressed hit flag)
    {
        TestWorld w(cfg);
        SoldierAI::spawnLanded(w.ctx, SquadType::MachineGun, {20, 0, 30}, 1.5708f, 41);
        SoldierAI::spawnLanded(w.ctx, SquadType::Sniper, {20, 0, 10}, 1.5708f, 42);
        w.horde.immortal = true; w.horde.speed = 0.f;
        w.horde.add({40, 0, 30}); w.horde.add({60, 0, 10});
        float mgNoise = 0, snNoise = 1e9f;
        int mgShots = 0, snShots = 0;
        w.run(12.f, [&] {
            for (const ShotEvent& e : w.ev.shots) (e.cls == SoldierClass::Sniper ? snShots : mgShots)++;
            for (size_t k = 0; k < w.ev.noise.size(); ++k) {
                const float r = w.ev.noise[k].radius;
                if (w.ev.noise[k].pos.z > 20) mgNoise = std::max(mgNoise, r); else snNoise = std::min(snNoise, r);
            }
        });
        check(mgShots > snShots * 10 && snShots > 0 && mgNoise > snNoise * 4,
              "MG fires fast and loud, the suppressed sniper slow and quiet", fmt("MG %.0f rounds (radius %.0f m), sniper %.0f (radius %.0f m)", mgShots, mgNoise, snShots, snNoise));
    }

    if (std::getenv("TTZ_AI_BENCH")) {   // CPU cost of SoldierAI + Combat per tick (informational, not a check)
        for (int nsq : {10, 50, 200}) {
            TestWorld w(cfg);
            w.horde.speed = 0.f;   // static zombies: the O(n^2) fake is not part of the measurement
            for (int k = 0; k < nsq; ++k) SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {6.f + (k % 10) * 8.f, 0, 4.f + (k / 10) * 3.f}, 0, (uint32_t)k);
            w.horde.immortal = true;
            for (int k = 0; k < 400; ++k) w.horde.add({2.f + (k % 40) * 2.f, 0, 86.f - (k / 40) * 0.8f});
            w.horde.step(w.ctx.dt);
            double ms = 0;
            for (int t = 0; t < 120; ++t) {
                w.ev.clear(); w.animEv.clear();
                const auto a = std::chrono::steady_clock::now();
                w.ai.tick(w.ctx); w.combat.tick(w.ctx);
                ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
                w.horde.step(w.ctx.dt);
                w.ctx.time += kTickDt; ++w.ctx.tick;
            }
            std::printf("  bench: %d soldiers, 400 zombies: AI + combat %.3f ms / tick\n", nsq * 5, ms / 120);
        }
    }
    std::printf("ai / nav: %d failure(s)\n", g_soldierFail);
    return g_soldierFail;
}

} // namespace ttz::game
