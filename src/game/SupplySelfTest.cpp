// Self-test section "economy / logistics / deploy" (WS-D): funding ledger, kill rewards, purchases, drop placement and
// the parachute timeline, container / crate stock, slot sharing, a full resupply trip through the real Logistics with
// SoldierAI + Combat on the CPU FakeHorde. No GPU. Called from SelfTest.cpp (testGameCore); returns the failure count.
#include "game/Combat.h"
#include "game/Config.h"
#include "game/Deploy.h"
#include "game/Economy.h"
#include "game/FakeHorde.h"
#include "game/Logistics.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/Soldiers.h"

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>

namespace ttz::game {

namespace {
int g_fail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_fail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d);
    return buf;
}
float d2(V3 a, V3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)); }

// 120 x 120 cells of 0.75 m: street at 0, a 15 m block (12 m) in the middle, a 10.5 m flat roof (8 m) in a corner,
// a parked "vehicle" (1.5 m box) on the street.
constexpr int kW = 120, kH = 120;
constexpr float kCell = 0.75f;
std::vector<float> heights() {
    std::vector<float> h((size_t)kW * kH, 0.f);
    for (int j = 0; j < kH; ++j)
        for (int i = 0; i < kW; ++i) {
            float& v = h[(size_t)j * kW + i];
            if (i >= 50 && i < 70 && j >= 50 && j < 70) v = 12.f;   // block x, z 37.5 .. 52.5
            if (i >= 8 && i < 22 && j >= 96 && j < 110) v = 8.f;    // roof x 6 .. 16.5, z 72 .. 82.5
            if (i >= 20 && i < 26 && j >= 20 && j < 23) v = 1.5f;   // vehicle x 15 .. 19.5, z 15 .. 17.25
        }
    return h;
}

struct World {
    BalanceConfig cfg;
    SoldierPool pool;
    SquadList squads;
    NavGrid nav;
    FakeHorde horde;
    TickEvents ev;
    std::vector<AnimEvent> animEv;
    Economy eco;
    Logistics lg;
    Deploy deploy;
    SoldierAI ai;
    Combat combat;
    GameContext ctx;
    explicit World(const BalanceConfig& c) : cfg(c) {
        nav.build(heights(), kW, kH, 0.f, 0.f, kCell);
        horde.nav = &nav;
        horde.setBounds(0, 0, kW * kCell, kH * kCell);
        eco.reset(cfg);
        ctx.cfg = &cfg; ctx.soldiers = &pool; ctx.squads = &squads; ctx.nav = &nav; ctx.horde = &horde; ctx.economy = &eco;
        ctx.logistics = &lg; ctx.deploy = &deploy; ctx.events = &ev; ctx.animEvents = &animEv; ctx.animator = nullptr;
    }
    // GameWorld's order (no animator: the AI / Deploy fall back to clip durations)
    void tick() {
        ev.clear();
        animEv.clear();
        horde.takeKills(ev.kills);
        for (const KillEvent& k : ev.kills) eco.creditKill(k, ctx.time);
        deploy.tick(ctx);
        ai.tick(ctx);
        deploy.onAnimEvents(ctx);
        combat.tick(ctx);
        lg.tick(ctx);
        eco.tick(ctx);
        horde.step(ctx.dt);
        ctx.time += kTickDt;
        ++ctx.tick;
    }
    void run(float s, const std::function<void()>& each = {}) {
        for (int k = 0, n = (int)std::lround(s / kTickDt); k < n; ++k) { tick(); if (each) each(); }
    }
};
} // namespace

int runSupplySelfTest(const BalanceConfig& cfgIn) {
    g_fail = 0;
    std::printf("economy / logistics / deploy (WS-D, CPU FakeHorde)\n");
    // ---- economy
    {
        World w(cfgIn);
        const double f0 = w.eco.funding();
        w.run(60.f);
        const double passive = w.eco.totalByKind(LedgerKind::PassiveIncome);
        check(std::fabs(w.eco.funding() - f0 - w.cfg.economy.baseIncomePerMin) < 0.5 && std::fabs(passive - w.cfg.economy.baseIncomePerMin) < 0.5,
              "base income: 60 s of game time pays baseIncomePerMin (ledger per second)", fmt("+%.2f, ledger %.2f, rate %.0f/min", w.eco.funding() - f0, passive, w.eco.incomePerMinute()));
        KillEvent k;
        uint64_t seq = 0;
        for (int i = 0; i < 40; ++i) {   // soldier and explosion kills, every record delivered twice (overlapping readbacks)
            k.seq = ++seq; k.cause = i % 4 == 3 ? KillCause::Explosion : KillCause::Soldier;
            w.eco.creditKill(k, w.ctx.time);
            w.eco.creditKill(k, w.ctx.time);
        }
        const double expect = 30 * w.cfg.economy.killReward[0] + 10 * w.cfg.economy.killReward[1];
        check(w.eco.kills() == 40 && w.eco.duplicatesDropped() == 40 && std::fabs(w.eco.totalByKind(LedgerKind::KillReward) - expect) < 1e-9,
              "kill rewards == kills x reward per cause, duplicates dropped (explosion kills pay: provisional)",
              fmt("kills %.0f, dupes %.0f, rewards %.0f (expected %.0f)", (double)w.eco.kills(), (double)w.eco.duplicatesDropped(), w.eco.totalByKind(LedgerKind::KillReward), expect));
        w.eco.creditAnonymousKills(3, w.ctx.time);
        double sum = 0;
        for (const LedgerEntry& e : w.eco.ledger()) sum += e.amount;
        check(w.eco.kills() == 43 && std::fabs(sum - w.eco.funding()) < 1e-6, "ring-overflow kills counted and paid; funding == ledger sum", fmt("%.3f vs %.3f", sum, w.eco.funding()));
    }
    // ---- drop placement
    {
        World w(cfgIn);
        DropPlan street = w.deploy.plan(w.ctx, SquadType::Rifle, {20, 0, 40});
        bool apart = street.valid && street.landing.size() == 5;
        for (size_t a = 0; apart && a < street.landing.size(); ++a)
            for (size_t b = a + 1; b < street.landing.size(); ++b) apart &= d2(street.landing[a], street.landing[b]) >= 3.0f;
        check(apart && !street.rooftop, "street drop: 5 landing points, spread >= 3 m apart", street.valid ? "valid" : street.reason);
        DropPlan roof = w.deploy.plan(w.ctx, SquadType::Sniper, {11, 0, 77});
        check(roof.valid && roof.rooftop && std::fabs(roof.landing[0].y - 8.f) < 0.01f, "sniper rooftop drop accepted (lands on the roof surface)", roof.valid ? "valid" : roof.reason);
        DropPlan roofSquad = w.deploy.plan(w.ctx, SquadType::Rifle, {11, 0, 77});
        bool onRoof = true;
        for (const V3& p : roofSquad.landing) onRoof &= std::fabs(p.y - 8.f) < 0.01f;
        check(!roofSquad.valid || onRoof, "rifle squad on a small roof: every member on the roof, or refused", roofSquad.valid ? "valid, all on the roof" : roofSquad.reason);
        DropPlan edge = w.deploy.plan(w.ctx, SquadType::Rifle, {37.6f, 0, 45});
        DropPlan car = w.deploy.plan(w.ctx, SquadType::Sniper, {17, 0, 16});
        DropPlan out = w.deploy.plan(w.ctx, SquadType::Rifle, {200, 0, 45});
        // a click on a building edge is refused or snapped onto the clicked surface (never below it, never on the edge)
        bool edgeOk = !edge.valid;
        if (edge.valid) {
            edgeOk = true;
            const float clicked = w.nav.surface(37.6f, 45.f);
            for (const V3& p : edge.landing) edgeOk &= std::fabs(p.y - clicked) < 1.f && std::fabs(w.nav.surface(p.x, p.z) - p.y) < 0.01f &&
                                                      flatFootprint(w.ctx, p, 0.6f, 0.6f, 0.f, 0.3f);
        }
        check(edgeOk && !car.valid && !out.valid, "invalid drops refused: vehicle, outside the area; a building-edge click snaps onto the clicked surface or is refused",
              std::string(edge.valid ? "edge snapped" : edge.reason) + " / " + car.reason + " / " + out.reason);
    }
    // ---- deploy timeline: purchase -> descent -> landing -> recovery -> autonomous, exactly 5 / 3 / 1
    {
        World w(cfgIn);
        const double f0 = w.eco.funding();
        SquadId ids[3];
        const V3 at[3] = {{20, 0, 40}, {75, 0, 25}, {11, 0, 77}};
        for (int t = 0; t < 3; ++t) {
            DropPlan p = w.deploy.plan(w.ctx, (SquadType)t, at[t]);
            if (p.valid && w.eco.spend(p.price, "squad", 0)) ids[t] = w.deploy.execute(w.ctx, (SquadType)t, p);
        }
        const double spent = f0 - w.eco.funding();
        bool startHigh = true;
        for (int t = 0; t < 3; ++t)
            if (const Squad* s = w.squads.get(ids[t]))
                for (const SoldierId& m : s->members) startHigh &= w.pool.pos[m.index].y > 30.f && w.pool.state[m.index] == SoldierState::Descending;
        bool landedEarly = false;
        w.run(4.f, [&] { for (uint32_t i = 0; i < w.pool.capacity(); ++i) landedEarly |= w.pool.used[i] && w.pool.state[i] != SoldierState::Descending; });
        w.run(30.f);
        int n[3] = {0, 0, 0}, chute = 0, ground = 0, auto_ = 0;
        for (int t = 0; t < 3; ++t)
            if (const Squad* s = w.squads.get(ids[t])) {
                n[t] = (int)s->members.size();
                for (const SoldierId& m : s->members) {
                    chute += w.deploy.parachuted(m) ? 1 : 0;
                    const float surf = w.nav.surface(w.pool.pos[m.index].x, w.pool.pos[m.index].z);
                    ground += std::fabs(w.pool.pos[m.index].y - surf) < 0.3f ? 1 : 0;
                    const SoldierState st = w.pool.state[m.index];
                    auto_ += st != SoldierState::Descending && st != SoldierState::Landing && st != SoldierState::Recovering ? 1 : 0;
                }
            }
        check(n[0] == 5 && n[1] == 3 && n[2] == 1 && chute == 9, "squads arrive whole by parachute: 5 / 3 / 1, every soldier touched down from altitude",
              fmt("%.0f / %.0f / %.0f, parachuted %.0f", n[0], n[1], n[2], chute));
        check(startHigh && !landedEarly, "drops start under canopy (never spawned on the ground)", "");
        check(ground == 9 && auto_ == 9, "after landing + recovery all 9 are on their surface and autonomous", fmt("on surface %.0f, autonomous %.0f", ground, auto_));
        const double price = cfgIn.squad[0].price + cfgIn.squad[1].price + cfgIn.squad[2].price;
        check(std::fabs(spent - price) < 1e-9 && w.eco.spentTotal() == price, "each squad charged exactly once", fmt("spent %.0f of %.0f", spent, price));
        const Squad* sn = w.squads.get(ids[2]);
        bool stayed = sn && std::fabs(w.pool.pos[sn->members[0].index].y - 8.f) < 0.3f;
        check(stayed, "rooftop sniper stays on its roof", "");
    }
    // ---- container / crate stock, slots
    {
        World w(cfgIn);
        const char* why = "";
        const bool ok = w.lg.canPlaceContainer(w.ctx, {20, 0, 40}, 0.f, &why);
        const bool blocked = !w.lg.canPlaceContainer(w.ctx, {40, 0, 45}, 0.f) && !w.lg.canPlaceContainer(w.ctx, {17, 0, 16}, 0.f);
        check(ok && blocked, "container placement: open street accepted, building / vehicle refused", why);
        SupplyId c = w.lg.placeContainer(w.ctx, {20, 0, 40}, 0.f);
        {   // B2 / GAME_DESIGN 14c: the container arrives by parachute, usable only once landed
            V3 sp0;
            SoldierId f0; f0.index = 99; f0.gen = 1;
            const bool air = w.lg.get(c) && !w.lg.get(c)->landed && !w.lg.reserve(c, f0, sp0) && w.lg.collect(c, AmmoType::Rifle, 5) == 0;
            w.run(cfgIn.fort.containerAltitude / cfgIn.fort.containerDescentSpeed + cfgIn.fort.containerLandDuration + 0.5f);
            check(air && w.lg.get(c) && w.lg.get(c)->landed, "container: parachute descent (not usable in the air), then lands and stays", "");
        }
        const SupplyPoint* p = w.lg.get(c);
        const int slots = p ? (int)p->slots.size() : 0;
        int got = 0;
        V3 sp;
        SoldierId fake[6];
        for (int k = 0; k < 6; ++k) { fake[k].index = 100 + k; fake[k].gen = 1; got += w.lg.reserve(c, fake[k], sp) ? 1 : 0; }
        check(slots == cfgIn.logistics.containerSlots && got == slots, "container: one reservation per slot, extra soldiers queue", fmt("slots %.0f, reserved %.0f of 6", slots, got));
        const int before = p->stock[0];
        const int a = w.lg.collect(c, AmmoType::Rifle, 150), b = w.lg.collect(c, AmmoType::Rifle, 1000000);
        check(a == 150 && b == before - 150 && w.lg.get(c)->stock[0] == 0 && w.lg.collect(c, AmmoType::Rifle, 10) == 0,
              "finite stock: transfers limited by stock, never below zero", fmt("%.0f + %.0f of %.0f", a, b, before));
        w.tick();   // fake users are not soldiers: their reservations are freed
        check(w.lg.get(c)->slotUser[0].valid() == false, "stale reservations (dead / unknown soldier) are released", "");
        SupplyId cr = w.lg.airdrop(w.ctx, {30, 0, 30});
        const bool early = w.lg.get(cr) && !w.lg.get(cr)->landed && !w.lg.reserve(cr, fake[0], sp) && w.lg.collect(cr, AmmoType::Rifle, 5) == 0;
        w.run(cfgIn.logistics.airdropAltitude / w.lg.crateDescentSpeed + w.lg.crateLandDuration + 0.5f);
        const SupplyPoint* q = w.lg.get(cr);
        check(early && q && q->landed && q->total() == cfgIn.logistics.crateStock[0] + cfgIn.logistics.crateStock[1] + cfgIn.logistics.crateStock[2] &&
                  d2(q->pos, {30, 0, 30}) <= cfgIn.logistics.airdropScatter + 0.01f,
              "airdrop: crate descends (not collectable in the air), lands within the scatter radius with full stock", "");
    }
    // ---- full resupply trips (real Logistics + SoldierAI + Combat): container and crate, stock conserved
    for (int kind = 0; kind < 2; ++kind) {
        World w(cfgIn);
        SquadId sq = SoldierAI::spawnLanded(w.ctx, SquadType::Rifle, {20, 0, 30}, 0, 11);
        w.run(3.f);
        SupplyId spid = kind == 0 ? w.lg.placeContainer(w.ctx, {30, 0, 12}, 0.f) : w.lg.airdrop(w.ctx, {28, 0, 14});
        const Squad* s = w.squads.get(sq);
        int start = 0;
        for (const SoldierId& m : s->members) { w.pool.mag[m.index] = 2; w.pool.reserve[m.index] = 0; start += 2; }
        const int stock0 = kind == 0 ? cfgIn.logistics.containerStock[0] : cfgIn.logistics.crateStock[0];
        w.run(60.f);
        int now = 0;
        for (const SoldierId& m : s->members) now += w.pool.mag[m.index] + w.pool.reserve[m.index];
        const SupplyPoint* p = w.lg.get(spid);
        const int stock = p ? p->stock[0] : 0;
        const int gained = now - start, taken = stock0 - stock;
        check(gained > 0 && gained == taken, kind == 0 ? "resupply from the container: rounds walked in, stock - taken == soldiers + gained (no teleport)"
                                                       : "resupply from an airdrop crate (5 soldiers share 2 slots): stock conserved",
              fmt("soldiers gained %.0f, stock gave %.0f, delivered counter %.0f", gained, taken, (double)w.lg.roundsDelivered(AmmoType::Rifle)));
    }
    return g_fail;
}

} // namespace ttz::game
