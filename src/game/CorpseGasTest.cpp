// Self-test section "corpse gas / flamethrowers" (GAME_DESIGN 14d): CorpseGas against a real CrowdSim + HordeBridge on a
// small empty sandbox (synchronous readbacks: setSync), plus CPU checks of FlameAI fuel use, friendly-fire safety and
// fuel resupply through the generic resupply path (FakeSupply). Test values (short rot delay, fast decay) are local.
#include "game/CorpseGas.h"
#include "game/Combat.h"
#include "game/Config.h"
#include "game/FakeHorde.h"
#include "game/FlameAI.h"
#include "game/HordeBridge.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/Soldiers.h"

#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace ttz::game {

namespace {
int g_gfail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_gfail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d);
    return buf;
}

struct GasRig {
    GpuContext* gpu = nullptr;
    CrowdSim sim;
    HordeBridge bridge;
    CorpseGas gas;
    Sandbox sb;
    uint32_t counters[C_COUNT] = {};
    void frame(int steps = 2) {
        SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu->device());
        bridge.preSim(cmd);
        for (int i = 0; i < steps; ++i) sim.step(cmd);
        bridge.postSim(cmd, 0);
        gas.postSim(cmd);
        sim.recordStatsReadback(cmd);
        sim.onFrameSubmitted(SDL_SubmitGPUCommandBufferAndAcquireFence(cmd));
        bridge.harvest();
        gas.harvest();
    }
    void seconds(float s, const std::function<void()>& each = {}) {   // 2 steps (1/30 s) per frame
        const int n = (int)std::lround(s * 30.f);
        for (int k = 0; k < n; ++k) { if (each) each(); frame(); }
    }
    void read() { gpu->downloadNow(sim.counters(), counters, sizeof(counters)); }
    float gasAround(V3 c, float r) const {   // max gas in cells within r
        float m = 0.f;
        for (float dz = -r; dz <= r; dz += 0.75f)
            for (float dx = -r; dx <= r; dx += 0.75f) m = std::max(m, gas.gasAt(c.x + dx, c.z + dz));
        return m;
    }
};

FlameCone coneAt(V3 from, V3 to, float secs, uint32_t shooter) {
    FlameCone c;
    c.origin = from;
    V3 d = to - from;
    c.dir = d * (1.f / std::sqrt(dot(d, d)));
    c.range = 9.f; c.coneDeg = 18.f; c.seconds = secs; c.shooterPacked = shooter;
    return c;
}

void cpuTests(const BalanceConfig& base) {
    // flat 90 m test street
    constexpr int W = 120, H = 120;
    BalanceConfig cfg = base;
    NavGrid nav;
    nav.build(std::vector<float>((size_t)W * H, 0.f), W, H, 0.f, 0.f, 0.75f);
    SoldierPool pool;
    SquadList squads;
    FakeHorde horde;
    horde.nav = &nav;
    horde.setBounds(0, 0, W * 0.75f, H * 0.75f);
    FakeSupply supply;
    TickEvents ev;
    std::vector<AnimEvent> animEv;
    SoldierAI ai;
    Combat combat;
    FlameAI flame;
    ai.supply = &supply;
    combat.supply = &supply;
    GameContext ctx;
    ctx.cfg = &cfg; ctx.soldiers = &pool; ctx.squads = &squads; ctx.nav = &nav; ctx.horde = &horde;
    ctx.events = &ev; ctx.animEvents = &animEv; ctx.flame = &flame;
    auto tick = [&] {
        ev.clear(); animEv.clear();
        horde.takeKills(ev.kills);
        ai.tick(ctx);
        flame.tick(ctx);
        combat.tick(ctx);
        horde.step(ctx.dt);
        ctx.time += kTickDt;
        ++ctx.tick;
    };
    const SquadId sq = SoldierAI::spawnLanded(ctx, SquadType::Flamethrower, {30, 0, 30}, 0.f, 77);
    const Squad* s = squads.get(sq);
    check(s && (int)s->members.size() == cfg.squad[(size_t)SquadType::Flamethrower].size && pool.cls[s->members[0].index] == SoldierClass::Flamethrower &&
              ammoOf(SoldierClass::Flamethrower) == AmmoType::Fuel,
          "flamethrower squad: size from config, class flamethrower, fuel ammo type",
          fmt("size %.0f (config %.0f)", s ? (double)s->members.size() : -1.0, (double)cfg.squad[(size_t)SquadType::Flamethrower].size));
    if (!s) return;
    for (int k = 0; k < 30; ++k) tick();
    const uint32_t a = s->members[0].index, b = s->members[1].index;
    // fuel by spray time: 20 sprays 1 fireInterval apart = 20 fuel units
    const WeaponStats& w = cfg.weapon[(size_t)SoldierClass::Flamethrower];
    const int fuel0 = pool.mag[a];
    pool.yaw[a] = 0.f;
    pool.pos[b] = {pool.pos[a].x + 5.f, 0.f, pool.pos[a].z - 3.f};   // squad mate out of the cone (+z)
    int ok = 0;
    for (int k = 0; k < 20; ++k) {
        ctx.time += w.fireInterval;
        ok += flame.spray(ctx, a, pool.pos[a] + V3{0, 0.5f, 7.f}) ? 1 : 0;
    }
    check(ok == 20 && fuel0 - pool.mag[a] == 20, "fuel: 20 sprays of one fireInterval each use 20 fuel units",
          fmt("%.0f sprays, fuel %.0f -> %.0f", ok, fuel0, pool.mag[a]));
    // friendly-fire safety: a squad mate 4 m ahead in the cone blocks the spray (no fuel used)
    pool.pos[b] = pool.pos[a] + V3{0.3f, 0.f, 4.f};
    const int fuel1 = pool.mag[a];
    ctx.time += w.fireInterval;
    const bool sprayed = flame.spray(ctx, a, pool.pos[a] + V3{0, 0.5f, 7.f});
    check(!sprayed && pool.mag[a] == fuel1 && flame.blocked() > 0, "friendly-fire safety: no spray through a squad mate", fmt("fuel %.0f -> %.0f", fuel1, pool.mag[a]));
    pool.pos[b] = pool.pos[a] + V3{2.f, 0.f, 0.f};
    // resupply: tanks nearly empty -> the generic resupply path fetches FUEL from a supply point
    for (const SoldierId& m : s->members) { pool.mag[m.index] = 5; pool.reserve[m.index] = 0; }
    const SupplyId sp = supply.add({40, 0, 30}, {0, 0, 0, 600}, 2);
    for (int k = 0; k < 60 * 30; ++k) tick();
    int fuelNow = 0;
    for (const SoldierId& m : s->members) fuelNow += pool.mag[m.index] + pool.reserve[m.index];
    check(fuelNow > 10 + 300 && supply.stock(sp, AmmoType::Fuel) < 600 && 600 - supply.stock(sp, AmmoType::Fuel) == fuelNow - 10,
          "fuel resupply: flamethrowers refill their tanks from a supply point's fuel stock (conserved)",
          fmt("fuel %.0f (was 10), stock %.0f (was 600)", fuelNow, supply.stock(sp, AmmoType::Fuel)));
}
} // namespace

int selfTestCorpseGas(GpuContext& gpu, const SimParams& base) {
    std::printf("corpse gas / flamethrowers (GAME_DESIGN 14d)\n");
    g_gfail = 0;
    BalanceConfig cfg;
    cfg.load("config/balance.json");
    cpuTests(cfg);

    SimParams p = base;
    p.gridW = p.gridH = 128;            // 96 m, empty
    p.agentCapacity = 8192;
    p.corpseCapacity = 8192;
    p.wander = 0.f;
    GasRig r;
    r.gpu = &gpu;
    r.sb.build(p.cellSize, p.gridW, p.gridH, MapKind::Arena);
    r.sb.boxes.clear();
    r.sb.scenarios.clear();
    if (!r.sim.init(gpu, p, r.sb)) { check(false, "sim init", ""); return 1; }
    r.sim.setGoals({});
    if (!r.bridge.init(gpu, r.sim)) { check(false, "bridge init", ""); r.sim.shutdown(); return 1; }
    r.bridge.setSync(true);
    if (!r.gas.init(gpu, r.sim)) { check(false, "corpse gas init (game_gas_* pipelines)", ""); r.bridge.shutdown(); r.sim.shutdown(); return 1; }
    RotConfig rot = cfg.rot;
    rot.delay = 3.f; rot.ramp = 2.f; rot.emitPerCorpse = 0.08f; rot.decay = 0.15f;
    r.gas.configure(rot, cfg.flame);
    r.gas.setSync(true);
    r.frame();

    // ---- 1. corpses rot: no gas until the delay, then gas over the pile that spreads -------------------------------
    const V3 pile{-20.f, 0.f, -20.f};
    r.sim.requestSpawnCorpses({pile.x - 1.f, pile.z - 1.f, pile.x + 1.f, pile.z + 1.f}, 40);
    int waited = 0;
    for (; waited < 400; ++waited) { r.frame(); r.read(); if (r.counters[C_CORPSES] > 0) break; }
    const float gas0 = r.gasAround(pile, 3.f);
    r.seconds(6.f);   // all bodies settled (<= 4 s) and the first ones rotting for a while
    r.read();
    const float gas1 = r.gasAround(pile, 3.f);
    const int cells1 = r.gas.stats().gasCells;
    r.seconds(4.f);
    const float gas2 = r.gasAround(pile, 3.f);
    const int cells2 = r.gas.stats().gasCells;
    check(r.counters[C_CORPSES] >= 35 && gas0 == 0.f && gas1 > 0.05f && r.gas.stats().rotting > 0,
          "corpses rot: no gas before the rot delay, gas over the pile after it",
          fmt("%.0f corpses, gas %.3f at the first corpse, %.3f after 6 s (rotting %.0f)", r.counters[C_CORPSES], gas0, gas1, r.gas.stats().rotting));
    check(gas2 >= gas1 && cells2 > cells1, "the gas spreads further the longer the corpses stay",
          fmt("gas cells %.0f -> %.0f, max %.2f -> %.2f", cells1, cells2, gas1, gas2));

    // ---- 2. soldiers in gas lose health (CPU tick on the readback); a far soldier does not ---------------------------
    {
        SoldierPool pool;
        SquadList squads;
        GameContext ctx;
        ctx.cfg = &cfg; ctx.soldiers = &pool; ctx.squads = &squads;
        const SquadId qa = squads.create(SquadType::Rifle), qb = squads.create(SquadType::Rifle);
        const SoldierId in = pool.spawn(SoldierClass::Rifleman, 0, qa, 0, pile, 0.f, 1), out = pool.spawn(SoldierClass::Rifleman, 0, qb, 0, {25.f, 0.f, 25.f}, 0.f, 2);
        squads.get(qa)->members.push_back(in);
        squads.get(qb)->members.push_back(out);
        pool.equip(in.index, cfg); pool.equip(out.index, cfg);
        for (uint32_t i : {in.index, out.index}) pool.setState(i, SoldierState::Idle);
        const float h0 = pool.health[in.index];
        for (int k = 0; k < 90; ++k) { for (Squad& s : squads.squads) s.flags = 0; r.gas.tick(ctx); ctx.time += kTickDt; }
        check(pool.health[in.index] < h0 - 1.f && pool.health[out.index] == h0 && (squads.get(qa)->flags & SQ_GAS) && !(squads.get(qb)->flags & SQ_GAS),
              "a soldier standing in gas loses health and his squad shows the gas warning; one outside does not",
              fmt("health %.1f -> %.1f in gas (%.2f), %.1f outside", h0, pool.health[in.index], r.gas.soldierGas(in.index), pool.health[out.index]));
    }

    // ---- 3. a flamethrower burns the pile: corpses gone (list + height field), the gas source stops, gas decays -------
    r.read();
    const uint32_t corpses0 = r.gas.stats().corpses;
    const V3 nozzle{pile.x - 6.f, 1.25f, pile.z};
    r.seconds(2.f, [&] { r.gas.queueFlame(coneAt(nozzle, {pile.x, 0.3f, pile.z}, 1.f / 30.f, 0x10001u)); });
    r.seconds(cfg.flame.corpseBurnTime + 2.f);
    std::vector<int32_t> ch((size_t)p.gridW * p.gridH);
    gpu.downloadNow(r.sim.corpseHeight(), ch.data(), (uint32_t)(ch.size() * 4));
    float maxH = 0.f;
    for (int32_t v : ch) maxH = std::max(maxH, std::fabs((float)v) * 0.001f);
    const CorpseGas::Stats st = r.gas.stats();
    check(corpses0 >= 35 && st.corpses == 0 && st.burned >= corpses0 && maxH < 0.02f && r.gas.corpsesNear(pile, 4.f) == 0,
          "flamethrower burns the corpse pile: every corpse burnt away (corpse list and height field)",
          fmt("%.0f corpses before, %.0f left, %.0f burnt, max pile height %.3f m", corpses0, st.corpses, st.burned, maxH));
    const float gasA = r.gasAround(pile, 6.f);
    r.seconds(8.f);
    const float gasB = r.gasAround(pile, 6.f);
    check(gasB < gasA * 0.5f + 1e-3f && r.gas.stats().rotting == 0, "after burning the gas source is gone and the gas decays",
          fmt("max gas %.3f -> %.3f over 8 s", gasA, gasB));

    // ---- 4. flame kills zombies (credited to the flamethrower through the kill ring) ------------------------------------
    {
        std::vector<KillEvent> kills;
        r.bridge.takeKills(kills);
        kills.clear();
        const V3 z0{20.f, 0.f, 20.f};
        r.sim.requestSpawnLook({z0.x - 1.f, z0.z - 1.f, z0.x + 1.f, z0.z + 1.f}, 6, 0, 0);
        r.seconds(1.f);
        r.read();
        const uint32_t live0 = r.counters[C_LIVE];
        const uint32_t shooter = (5u & 0xFFFFu) | (2u << 16);
        const V3 from{z0.x - 6.f, 1.25f, z0.z};
        r.seconds(3.f, [&] { r.gas.queueFlame(coneAt(from, {z0.x, 0.9f, z0.z}, 1.f / 30.f, shooter)); });
        r.seconds(1.f);
        r.read();
        std::vector<KillEvent> k2;
        r.bridge.takeKills(k2);
        int credited = 0;
        for (const KillEvent& k : k2) credited += k.shooterPacked == shooter ? 1 : 0;
        check(live0 >= 6 && r.counters[C_LIVE] + 5 <= live0 && credited >= 5, "flame kills zombies in the cone (kills credited to the flamethrower)",
              fmt("live %.0f -> %.0f, %.0f kills credited", live0, r.counters[C_LIVE], credited));
    }
    r.gas.shutdown();
    r.bridge.shutdown();
    r.sim.shutdown();
    return g_gfail;
}

} // namespace ttz::game
