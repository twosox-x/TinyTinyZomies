// Purchase -> parachute drop -> squad ready (WS-D). See Deploy.h for the sequence (GAME_DESIGN 14b).
#include "game/Deploy.h"

#include "game/Config.h"
#include "game/GameEvents.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;

// NavGrid::walkable is only meaningful once the navigation grid computes it; probe a few cells so placement keeps
// working (flatness only) on a grid without walkability (e.g. tests that only fill heights).
bool walkKnown(const NavGrid& nav) {
    if (!nav.ready()) return false;
    const int gw = nav.width(), gh = nav.height();
    uint32_t s = 12345u;
    for (int k = 0; k < 256; ++k) {
        s = pcg(s);
        const float x = nav.originX() + (float)(s % (uint32_t)gw + 0.5f) * nav.cell();
        s = pcg(s);
        const float z = nav.originZ() + (float)(s % (uint32_t)gh + 0.5f) * nav.cell();
        if (nav.walkable(x, z)) return true;
    }
    return false;
}

bool insideGrid(const NavGrid& nav, float x, float z, float margin) {
    return x >= nav.originX() + margin && z >= nav.originZ() + margin && x < nav.originX() + nav.width() * nav.cell() - margin &&
           z < nav.originZ() + nav.height() * nav.cell() - margin;
}

// Roof footprint around p (the flat region at p's height, scanned along +-x / +-z), for the canopy ground clamp.
void roofClamp(const NavGrid& nav, V3 p, float out[8]) {
    const float y = nav.surface(p.x, p.z), step = nav.cell();
    float e[4];
    const float dx[4] = {-1, 0, 1, 0}, dz[4] = {0, -1, 0, 1};
    for (int k = 0; k < 4; ++k) {
        float d = 0;
        while (d < 60.f && std::fabs(nav.surface(p.x + dx[k] * (d + step), p.z + dz[k] * (d + step)) - y) < 0.6f) d += step;
        e[k] = d;
    }
    out[0] = p.x - e[0]; out[1] = p.z - e[1]; out[2] = p.x + e[2]; out[3] = p.z + e[3];
    out[4] = y; out[5] = 0; out[6] = 0; out[7] = 1;
}
} // namespace

bool flatFootprint(const GameContext& ctx, V3 c, float halfX, float halfZ, float yaw, float tol, float* surface) {
    if (!ctx.nav || !ctx.nav->ready()) return false;
    const NavGrid& nav = *ctx.nav;
    const float y0 = nav.surface(c.x, c.z);
    if (surface) *surface = y0;
    const float cs = std::cos(yaw), sn = std::sin(yaw), step = 0.5f;
    for (float u = -halfX; u <= halfX + 1e-3f; u += step)
        for (float v = -halfZ; v <= halfZ + 1e-3f; v += step) {
            const float x = c.x + u * cs + v * sn, z = c.z - u * sn + v * cs;
            if (!insideGrid(nav, x, z, 1.f)) return false;
            if (std::fabs(nav.surface(x, z) - y0) > tol) return false;
        }
    return true;
}

DropPlan Deploy::plan(const GameContext& ctx, SquadType type, V3 dest) const {
    DropPlan p;
    const SquadDef& def = ctx.cfg->squad[(size_t)type];
    p.price = def.price;
    if (!ctx.nav || !ctx.nav->ready()) { p.reason = "no navigation grid"; return p; }
    const NavGrid& nav = *ctx.nav;
    if (!insideGrid(nav, dest.x, dest.z, 4.f) || (ctx.horde && !ctx.horde->simulated(dest.x, dest.z))) {
        p.reason = "outside the simulated area";
        return p;
    }
    float ys = 0;
    if (!flatFootprint(ctx, dest, 0.7f, 0.7f, 0.f, 0.3f, &ys)) { p.reason = "blocked: inside geometry, a vehicle or an edge"; return p; }
    const bool known = walkKnown(nav);
    if (known && !nav.walkable(dest.x, dest.z)) { p.reason = "not walkable"; return p; }
    // street or roof: the drop surface against the lowest ground within 15 m
    float ground = ys;
    for (int k = 0; k < 16; ++k) {
        const float a = k * kPi / 8.f;
        for (float r : {6.f, 10.f, 15.f}) ground = std::min(ground, nav.surface(dest.x + std::cos(a) * r, dest.z + std::sin(a) * r));
    }
    p.rooftop = ys - ground > 2.5f;
    const uint32_t isl = nav.island(dest.x, dest.z);
    dest.y = ys;
    const int n = std::max(1, def.size);
    auto ok = [&](V3 c) {
        if (!insideGrid(nav, c.x, c.z, 2.f) || (ctx.horde && !ctx.horde->simulated(c.x, c.z))) return false;
        float y;
        if (!flatFootprint(ctx, c, 0.6f, 0.6f, 0.f, 0.3f, &y) || std::fabs(y - ys) > 0.4f) return false;
        if (known && !nav.walkable(c.x, c.z)) return false;
        if (isl && nav.island(c.x, c.z) != isl) return false;
        return true;
    };
    for (float spacing : {dropSpacing, dropSpacing * 0.7f}) {
        p.landing.assign(1, dest);
        for (int ring = 1; ring <= 4 && (int)p.landing.size() < n; ++ring) {
            const int m = 6 * ring;
            for (int k = 0; k < m && (int)p.landing.size() < n; ++k) {
                const float a = (k + 0.5f * (ring & 1)) * 2.f * kPi / (float)m;
                V3 c{dest.x + std::cos(a) * spacing * ring, ys, dest.z + std::sin(a) * spacing * ring};
                if (!ok(c)) continue;
                bool apart = true;
                for (const V3& q : p.landing) apart &= (q.x - c.x) * (q.x - c.x) + (q.z - c.z) * (q.z - c.z) >= spacing * spacing * 0.8f;
                if (!apart) continue;
                c.y = nav.surface(c.x, c.z);
                p.landing.push_back(c);
            }
        }
        if ((int)p.landing.size() >= n) break;
    }
    if ((int)p.landing.size() < n) { p.reason = p.rooftop ? "roof too small for the squad" : "not enough open ground for the squad"; p.landing.clear(); return p; }
    // nearest-first order is already ring order; the first member lands at the clicked point
    p.valid = true;
    return p;
}

SquadId Deploy::execute(GameContext& ctx, SquadType type, const DropPlan& plan) {
    if (!plan.valid || plan.landing.empty() || !ctx.squads || !ctx.soldiers) return {};
    const SquadDef& def = ctx.cfg->squad[(size_t)type];
    const SoldierClass cls = def.cls;
    const size_t c = (size_t)cls;
    SquadId sq = ctx.squads->create(type);
    Squad* squad = ctx.squads->get(sq);
    squad->deploying = true;
    squad->flags = SQ_DEPLOYING;
    const V3 dest = plan.landing[0];
    const float facing = std::atan2(dest.x, dest.z) + 0.6f * (float)sq.index;   // arbitrary but deterministic
    for (int k = 0; k < (int)plan.landing.size(); ++k) {
        const V3 land = plan.landing[(size_t)k];
        uint32_t seed = pcg((uint32_t)(sq.index * 977u + (uint32_t)k * 131u + 7u));
        const std::vector<int>& vars = timing.variants[c];
        const int inf = vars.empty() ? 0 : vars[(size_t)((seed >> 8) % vars.size())];
        DropTrack d;
        d.squad = sq;
        d.landing = land;
        d.rooftop = plan.rooftop;
        const float da = rand01(seed) * 2.f * kPi, dr = 3.f + rand01(seed) * 4.f;
        d.drift = {std::cos(da) * dr, 0.f, std::sin(da) * dr};
        d.startAlt = d.alt = dropAltitude + 2.5f * (float)k + rand01(seed) * 2.f;   // staggered: no simultaneous landing
        if (plan.rooftop && ctx.nav) roofClamp(*ctx.nav, land, d.clamp);
        const float yaw = facing + (rand01(seed) - 0.5f) * 0.6f;
        V3 p0{land.x + d.drift.x, land.y + d.alt, land.z + d.drift.z};
        d.soldier = ctx.soldiers->spawn(cls, inf, sq, k, p0, yaw, seed);
        const uint32_t i = d.soldier.index;
        SoldierPool& P = *ctx.soldiers;
        P.health[i] = ctx.cfg->soldier[c].health;
        P.mag[i] = ctx.cfg->weapon[c].magazine;
        P.reserve[i] = ctx.cfg->weapon[c].reserve;
        P.state[i] = SoldierState::Descending;
        P.stateTime[i] = 0;
        if (ctx.animator) ctx.animator->reset(P.anim[i], inf, AnimAction::ParaDescent);
        squad->members.push_back(d.soldier);
        drops_.push_back(d);
        ++dropped_;
    }
    squad->order.active = false;
    squad->order.dest = dest;
    squad->order.facing = facing;
    return sq;
}

void Deploy::finishRecovery(GameContext& ctx, DropTrack& d) {
    if (d.phase == DropPhase::Done) return;
    d.phase = DropPhase::Done;
    d.t = 0;
    if (d.groundT < 0) d.groundT = 0;
    SoldierPool& P = *ctx.soldiers;
    if (!P.valid(d.soldier)) return;
    const uint32_t i = d.soldier.index;
    if (P.state[i] == SoldierState::Recovering || P.state[i] == SoldierState::Landing) {
        P.state[i] = SoldierState::Forming;   // SoldierAI walks it to its formation slot, then Idle (autonomous)
        P.stateTime[i] = 0;
        if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::Idle);
    }
}

void Deploy::tick(GameContext& ctx) {
    if (!ctx.soldiers) return;
    SoldierPool& P = *ctx.soldiers;
    const float dt = ctx.dt;
    for (DropTrack& d : drops_) {
        d.total += dt;
        d.t += dt;
        if (d.groundT >= 0) d.groundT += dt;
        if (!P.valid(d.soldier)) { if (d.phase != DropPhase::Done) d.phase = DropPhase::Done; continue; }
        const uint32_t i = d.soldier.index;
        const size_t c = (size_t)P.cls[i];
        const SoldierState st = P.state[i];
        const bool deploying = st == SoldierState::Descending || st == SoldierState::Landing || st == SoldierState::Recovering;
        if (!deploying && d.phase != DropPhase::Done) { d.phase = DropPhase::Done; if (d.groundT < 0) d.groundT = 0; continue; }
        switch (d.phase) {
        case DropPhase::Descent: {
            d.alt = std::max(0.f, d.alt - timing.descentSpeed[c] * dt);
            const float f = d.startAlt > 0 ? d.alt / d.startAlt : 0.f;
            const float ease = f * f * (3.f - 2.f * f);   // drift settles before touchdown
            V3 np{d.landing.x + d.drift.x * ease, d.landing.y + d.alt, d.landing.z + d.drift.z * ease};
            P.vel[i] = (np - P.pos[i]) * (1.f / dt);
            P.pos[i] = np;
            if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::ParaDescent);
            if (d.alt <= 0.f) {
                d.phase = DropPhase::Land;
                d.t = 0;
                P.pos[i] = d.landing;
                P.vel[i] = {};
                P.state[i] = SoldierState::Landing;
                P.stateTime[i] = 0;
                if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::ParaLand);
                ++landed_;
                if (d.startAlt >= 20.f) touchedDown_.push_back(d.soldier);
                if (ctx.events) {
                    ctx.events->fx.push_back({FxKind::Landing, d.soldier, d.landing, {0, 1, 0}});
                    ctx.events->noise.push_back({d.landing, 0.3f, 20.f, 2.f});
                }
            }
            break;
        }
        case DropPhase::Land:
            P.pos[i] = d.landing;
            if (d.groundT < 0 && d.t >= timing.landDuration[c]) d.groundT = 0;   // canopy settled (if no clip event came)
            if (d.t >= timing.landDuration[c]) {
                d.phase = DropPhase::Recover;
                d.t = 0;
                P.state[i] = SoldierState::Recovering;
                P.stateTime[i] = 0;
                if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::ParaRecover);
            }
            break;
        case DropPhase::Recover:
            if (d.t >= timing.recoverDuration[c] + 0.1f) finishRecovery(ctx, d);   // weapon_draw normally ends it first
            break;
        case DropPhase::Done: break;
        }
    }
    // canopies are gone 2.5 s hold + 2.5 s dissolve after settling: drop the track a little later
    drops_.erase(std::remove_if(drops_.begin(), drops_.end(), [](const DropTrack& d) { return d.phase == DropPhase::Done && d.groundT > 7.f; }),
                 drops_.end());
    // Squad::deploying / flags: SoldierAI recomputes them every tick (single owner, from the soldier states)
}

bool Deploy::parachuted(SoldierId s) const {
    for (const SoldierId& t : touchedDown_) if (t == s) return true;
    return false;
}

void Deploy::onAnimEvents(GameContext& ctx) {
    if (!ctx.animEvents || drops_.empty()) return;
    for (const AnimEvent& e : *ctx.animEvents)
        for (DropTrack& d : drops_) {
            if (d.soldier.index != e.soldier || d.phase == DropPhase::Done) continue;
            if (e.type == "canopy_ground" && d.groundT < 0) d.groundT = 0;
            else if (e.type == "harness_release") d.released = true;
            else if (e.type == "weapon_draw" && d.phase == DropPhase::Recover) finishRecovery(ctx, d);
        }
}

} // namespace ttz::game
