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

// A landing spot: walkable, on a navigation island, a 1.2 m footprint flat within 0.3 m (one soldier: GAME_DESIGN 14c
// owner feedback, the old 3.6 m roof rule refused most roofs), and no wall / parapet / obstacle rising more than
// 1.5 m within `clear` metres (canopy and body never inside geometry).
static bool landable(const GameContext& ctx, V3 c, float clear, float* surface) {
    const NavGrid& nav = *ctx.nav;
    float y;
    if (!flatFootprint(ctx, c, 0.6f, 0.6f, 0.f, 0.3f, &y)) return false;
    if (!nav.island(c.x, c.z)) return false;
    for (int k = 0; k < 12; ++k) {
        const float a = (float)k * kPi / 6.f;
        for (float r = 0.75f; r <= clear + 1e-3f; r += 0.75f)
            if (nav.surface(c.x + std::cos(a) * r, c.z + std::sin(a) * r) > y + 1.5f) return false;
    }
    if (surface) *surface = y;
    return true;
}

// Fraction of 16 horizontal directions blocked within 14 m by a wall more than 3 m above the spot: a courtyard, light
// well or slot between towers reads as "inside a building" from the RTS camera and has no room for a canopy.
static float enclosure(const NavGrid& nav, V3 c, float y) {
    int blocked = 0;
    for (int k = 0; k < 16; ++k) {
        const float a = (float)k * kPi / 8.f;
        for (float r = 1.5f; r <= 14.f; r += 0.75f)
            if (nav.surface(c.x + std::cos(a) * r, c.z + std::sin(a) * r) > y + 3.f) { ++blocked; break; }
    }
    return (float)blocked / 16.f;
}

void roofLevels(const GameContext& ctx, V3 click, std::vector<V3>& starts) {
    starts.clear();
    if (!ctx.nav || !ctx.nav->ready()) return;
    const NavGrid& nav = *ctx.nav;
    const float clicked = nav.surface(click.x, click.z), c = nav.cell();
    auto islandSize = [&](V3 s0) { std::vector<V3> cells; nav.islandCells(s0, 60.f, 40, cells); return (int)cells.size(); };
    auto add = [&](V3 q) {
        for (const V3& s0 : starts) if (nav.island(s0.x, s0.z) == nav.island(q.x, q.z)) return;
        starts.push_back(q);
    };
    const bool onRoof = nav.walkable(click.x, click.z) && nav.onRoof(click.x, click.z);
    if (onRoof) add({click.x, clicked, click.z});
    if (onRoof || !nav.walkable(click.x, click.z)) {
        // parapet / ledge / roof object / rim (or a thin raised ring the click is on): the nearest roof cell of another
        // island beside it, on a level at or below the click
        const uint32_t own = onRoof ? nav.island(click.x, click.z) : 0u;
        float best = 1e9f;
        V3 bq;
        for (float dz = -3.5f; dz <= 3.5f + 1e-3f; dz += c * 0.5f)
            for (float dx = -3.5f; dx <= 3.5f + 1e-3f; dx += c * 0.5f) {
                const float x = click.x + dx, z = click.z + dz, d2 = dx * dx + dz * dz;
                if (d2 > 3.5f * 3.5f || d2 >= best || !nav.walkable(x, z) || !nav.onRoof(x, z)) continue;
                if (own && nav.island(x, z) == own) continue;
                const float y = nav.surface(x, z);
                if (y > clicked + (onRoof ? -0.4f : 0.5f) || y < clicked - 4.f) continue;
                best = d2; bq = {x, y, z};
            }
        if (best < 1e8f) add(bq);
    }
    if (starts.empty()) return;
    // a small raised top (stair housing, tank, kiosk roof): the roof around it is what the player means
    if (islandSize(starts[0]) < 40) {
        const V3 s0 = starts[0];
        float best = 1e9f;
        V3 bq;
        for (float dz = -6.f; dz <= 6.f + 1e-3f; dz += c)
            for (float dx = -6.f; dx <= 6.f + 1e-3f; dx += c) {
                const float x = s0.x + dx, z = s0.z + dz, d2 = dx * dx + dz * dz;
                if (d2 > 36.f || d2 >= best || !nav.walkable(x, z) || !nav.onRoof(x, z) || nav.island(x, z) == nav.island(s0.x, s0.z)) continue;
                const float y = nav.surface(x, z);
                if (y > s0.y - 0.5f || y < s0.y - 6.f) continue;
                best = d2; bq = {x, y, z};
            }
        if (best < 1e8f) { starts.insert(starts.begin(), bq); }
    }
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
    const bool known = walkKnown(nav);
    // Rooftops (GAME_DESIGN 14e): the roof-surface picker resolves the roof level under the click and searches that
    // whole roof island for the nearest walkable, clear spot inset from the edge (never refused while the roof has room).
    {
        std::vector<V3> roofs;
        if (known) roofLevels(ctx, dest, roofs);
        const char* why = nullptr;
        for (const V3& start : roofs) {
            if (planRoof(ctx, type, dest, start, p)) return p;
            why = p.reason;
        }
        if (why) { p.reason = why; return p; }
    }
    // The clicked surface (street, roof, parapet). Snap to the nearest landing spot on that same surface within 2.5 m:
    // a click near a roof edge, on a parapet or a roof fixture lands on the roof next to it, never below it.
    const float clicked = nav.surface(dest.x, dest.z);
    const float clear = 1.5f;
    float ys = 0;
    auto spotOk = [&](V3 c, float* y) {
        if (!insideGrid(nav, c.x, c.z, 2.f) || (ctx.horde && !ctx.horde->simulated(c.x, c.z))) return false;
        if (known && !nav.walkable(c.x, c.z)) return false;
        return landable(ctx, c, clear, y);
    };
    if (!spotOk(dest, &ys) || std::fabs(ys - clicked) > 1.f) {
        bool found = false;
        float best = 1e9f;
        V3 bestC = dest;
        float bestY = 0;
        for (float r = 0.5f; r <= 2.5f + 1e-3f; r += 0.5f)
            for (int k = 0; k < 16; ++k) {
                const float a = (float)k * kPi / 8.f;
                V3 c{dest.x + std::cos(a) * r, 0, dest.z + std::sin(a) * r};
                float y;
                if (!spotOk(c, &y) || std::fabs(y - clicked) > 1.f) continue;
                const float score = r + std::fabs(y - clicked);
                if (score < best) { best = score; bestC = c; bestY = y; found = true; }
            }
        if (!found) { p.reason = "blocked: inside geometry, a vehicle or an edge"; return p; }
        dest = bestC; ys = bestY;
    }
    // street or roof: the drop surface against the lowest ground within 15 m
    float ground = ys;
    for (int k = 0; k < 16; ++k) {
        const float a = k * kPi / 8.f;
        for (float r : {6.f, 10.f, 15.f}) ground = std::min(ground, nav.surface(dest.x + std::cos(a) * r, dest.z + std::sin(a) * r));
    }
    const float rise = ys - ground;
    if (rise > 0.5f && rise <= 2.5f) { p.reason = "blocked: on a vehicle, wall or obstacle"; return p; }   // also water (1 m wall)
    p.rooftop = rise > 2.5f;
    if (!p.rooftop && enclosure(nav, dest, ys) > 0.8f) { p.reason = "enclosed: courtyard or gap between buildings"; return p; }
    const uint32_t isl = nav.island(dest.x, dest.z);
    dest.y = ys;
    const int n = std::max(1, def.size);
    auto ok = [&](V3 c, float& y) {
        if (!spotOk(c, &y) || std::fabs(y - ys) > 0.4f) return false;
        if (isl && nav.island(c.x, c.z) != isl) return false;   // the exact surface (roof island) that was chosen
        return true;
    };
    for (float spacing : {dropSpacing, dropSpacing * 0.7f, dropSpacing * 0.5f}) {
        p.landing.assign(1, dest);
        for (int ring = 1; ring <= 5 && (int)p.landing.size() < n; ++ring) {
            const int m = 6 * ring;
            for (int k = 0; k < m && (int)p.landing.size() < n; ++k) {
                const float a = (k + 0.5f * (ring & 1)) * 2.f * kPi / (float)m;
                V3 c{dest.x + std::cos(a) * spacing * ring, ys, dest.z + std::sin(a) * spacing * ring};
                float y;
                if (!ok(c, y)) continue;
                bool apart = true;
                for (const V3& q : p.landing) apart &= (q.x - c.x) * (q.x - c.x) + (q.z - c.z) * (q.z - c.z) >= spacing * spacing * 0.8f;
                if (!apart) continue;
                c.y = y;   // landing height = the surface at the final spot
                p.landing.push_back(c);
            }
        }
        if ((int)p.landing.size() >= n) break;
    }
    if ((int)p.landing.size() < n) { p.reason = p.rooftop ? "roof too small for the squad" : "not enough open ground for the squad"; p.landing.clear(); return p; }
    // nearest-first order is already ring order; the first member lands at the (snapped) clicked point
    p.valid = true;
    return p;
}

bool Deploy::planRoof(const GameContext& ctx, SquadType type, V3 click, V3 start, DropPlan& p) const {
    const NavGrid& nav = *ctx.nav;
    const int n = std::max(1, ctx.cfg->squad[(size_t)type].size);
    std::vector<V3> cells;
    nav.islandCells(start, 45.f, 8000, cells);
    // nearest to the click first (the island flood is sorted from the start point, a few cm away)
    std::sort(cells.begin(), cells.end(), [&](const V3& a, const V3& b) {
        return (a.x - click.x) * (a.x - click.x) + (a.z - click.z) * (a.z - click.z) < (b.x - click.x) * (b.x - click.x) + (b.z - click.z) * (b.z - click.z);
    });
    struct Tier { float edge, obs, clear; };
    static const Tier tiers[] = {{1.5f, 0.6f, 1.5f}, {1.2f, 0.6f, 1.0f}, {1.0f, 0.4f, 0.75f}};
    std::vector<V3> ok;
    for (const Tier& t : tiers) {
        ok.clear();
        for (const V3& c : cells) {
            if (!insideGrid(nav, c.x, c.z, 2.f) || (ctx.horde && !ctx.horde->simulated(c.x, c.z))) continue;
            if (nav.cellEdge(c.x, c.z) < t.edge || nav.cellObstacle(c.x, c.z) < t.obs) continue;
            float y;
            if (!landable(ctx, c, t.clear, &y)) continue;
            ok.push_back({c.x, y, c.z});
        }
        if ((int)ok.size() < n) continue;
        const V3 first = ok[0];
        std::sort(ok.begin() + 1, ok.end(), [&](const V3& a, const V3& b) {
            return (a.x - first.x) * (a.x - first.x) + (a.z - first.z) * (a.z - first.z) < (b.x - first.x) * (b.x - first.x) + (b.z - first.z) * (b.z - first.z);
        });
        for (float spacing : {dropSpacing, 3.0f, 2.2f, 1.6f}) {
            p.landing.assign(1, first);
            for (size_t k = 1; k < ok.size() && (int)p.landing.size() < n; ++k) {
                bool apart = true;
                for (const V3& q : p.landing) apart &= (q.x - ok[k].x) * (q.x - ok[k].x) + (q.z - ok[k].z) * (q.z - ok[k].z) >= spacing * spacing;
                if (apart) p.landing.push_back(ok[k]);
            }
            if ((int)p.landing.size() >= n) { p.valid = true; p.rooftop = true; p.reason = ""; return true; }
        }
    }
    p.landing.clear();
    p.reason = cells.empty() ? "blocked: no walkable roof here" : ok.empty() ? "no clear spot on this roof" : "roof too small for the squad";
    return false;
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
        const std::vector<int>& vars = type == SquadType::Engineer && !timing.engineerVariants.empty() ? timing.engineerVariants : timing.variants[c];
        const int inf = vars.empty() ? 0 : vars[(size_t)((seed >> 8) % vars.size())];
        DropTrack d;
        d.squad = sq;
        d.landing = land;
        d.rooftop = plan.rooftop;
        const float da = rand01(seed) * 2.f * kPi, dr = 3.f + rand01(seed) * 4.f;
        d.startAlt = d.alt = dropAltitude + 2.5f * (float)k + rand01(seed) * 2.f;   // staggered: no simultaneous landing
        d.drift = {};
        if (ctx.nav && ctx.nav->ready()) {   // the descent never passes through a building: a drift whose path is clear
            const NavGrid& nav = *ctx.nav;
            for (int t = 0; t < 8; ++t) {
                const float a = da + (float)t * kPi / 4.f;
                const V3 dv{std::cos(a) * dr, 0.f, std::sin(a) * dr};
                bool clearPath = true;
                for (int s2 = 0; s2 <= 16 && clearPath; ++s2) {
                    const float f = (float)s2 / 16.f, e = f * f * (3.f - 2.f * f);   // same easing as the descent
                    const float x = land.x + dv.x * e, z = land.z + dv.z * e, y = land.y + d.startAlt * f;
                    for (int r = 0; r < 4 && clearPath; ++r)   // canopy / body radius ~1.5 m
                        clearPath = nav.surface(x + std::cos(r * kPi / 2.f) * 1.5f, z + std::sin(r * kPi / 2.f) * 1.5f) < y - 0.5f || f < 0.06f;
                }
                if (clearPath) { d.drift = dv; break; }
            }
        } else d.drift = {std::cos(da) * dr, 0.f, std::sin(da) * dr};
        if (plan.rooftop && ctx.nav) roofClamp(*ctx.nav, land, d.clamp);
        const float yaw = facing + (rand01(seed) - 0.5f) * 0.6f;
        V3 p0{land.x + d.drift.x, land.y + d.alt, land.z + d.drift.z};
        d.soldier = ctx.soldiers->spawn(cls, inf, sq, k, p0, yaw, seed);
        const uint32_t i = d.soldier.index;
        SoldierPool& P = *ctx.soldiers;
        P.equip(i, *ctx.cfg);   // health / magazine / reserve from the balance config
        P.setState(i, SoldierState::Descending);
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
        P.setState(i, SoldierState::Forming);   // SoldierAI walks it to its formation slot, then Idle (autonomous)
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
                P.setState(i, SoldierState::Landing);
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
                P.setState(i, SoldierState::Recovering);
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
