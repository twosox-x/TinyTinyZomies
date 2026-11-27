// Physical ammunition supply (WS-D): container + airdrop crates, finite stock, slot reservations (GAME_DESIGN 4, 14b).
#include "game/Logistics.h"

#include "game/Config.h"
#include "game/Deploy.h"
#include "game/GameEvents.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
// container_supply body: 6.06 x 2.44 m (props.json bounds incl. apron: x -4 .. 3.15, z -2.2 .. 2.25; door socket at +x 4.25)
constexpr float kCrateHalf = 0.6f;

V3 local(V3 c, float yaw, float u, float v) {
    const float cs = std::cos(yaw), sn = std::sin(yaw);
    return {c.x + u * cs + v * sn, c.y, c.z - u * sn + v * cs};
}

bool simulatedAt(const GameContext& ctx, float x, float z) { return !ctx.horde || ctx.horde->simulated(x, z); }
float dist2(V3 a, V3 b) { return (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z); }

// Access slot near `want` on the same surface as the supply point (walkable when the grid knows walkability).
bool slotAt(const GameContext& ctx, V3 want, float surfaceY, V3& out) {
    const NavGrid& nav = *ctx.nav;
    V3 w = want;
    if (nav.nearestWalkable(want, 1.2f, w) && std::fabs(nav.surface(w.x, w.z) - surfaceY) < 0.4f) { out = {w.x, nav.surface(w.x, w.z), w.z}; return true; }
    if (flatFootprint(ctx, want, 0.35f, 0.35f, 0.f, 0.3f) && std::fabs(nav.surface(want.x, want.z) - surfaceY) < 0.4f) {
        out = {want.x, nav.surface(want.x, want.z), want.z};
        return true;
    }
    return false;
}
} // namespace

bool Logistics::canPlaceContainer(const GameContext& ctx, V3 pos, float yaw, const char** why) const {
    auto no = [&](const char* r) { if (why) *why = r; return false; };
    if (!ctx.nav || !ctx.nav->ready()) return no("no navigation grid");
    if (!simulatedAt(ctx, pos.x, pos.z)) return no("outside the simulated area");
    // B2: the body (6.1 x 2.5 m) must be flat and free; the apron / door swing may touch walls, so a container can be
    // set flush against a wall line to plug a gap (GAME_DESIGN 14c: containers wall things off)
    float y = 0;
    if (!flatFootprint(ctx, pos, 3.05f, 1.25f, yaw, 0.4f, &y)) return no("blocked: needs a flat 6 x 2.5 m spot (no wall, vehicle or edge)");
    for (const SupplyPoint& p : points_)
        if (p.alive && (p.pos.x - pos.x) * (p.pos.x - pos.x) + (p.pos.z - pos.z) * (p.pos.z - pos.z) < 7.f * 7.f) return no("too close to another supply point");
    int slots = 0;
    V3 s;
    for (float v : {-0.8f, 0.8f}) slots += slotAt(ctx, local(pos, yaw, 4.4f, v), y, s) ? 1 : 0;
    for (float v : {-2.9f, 2.9f}) slots += slotAt(ctx, local(pos, yaw, 0.f, v), y, s) ? 1 : 0;
    if (!slots) return no("no access to the container doors");
    if (why) *why = "";
    return true;
}

SupplyId Logistics::placeContainer(GameContext& ctx, V3 pos, float yaw) {
    SupplyPoint sp;
    sp.kind = SupplyKind::Container;
    sp.yaw = yaw;
    sp.pos = {pos.x, ctx.nav ? ctx.nav->surface(pos.x, pos.z) : pos.y, pos.z};
    for (size_t a = 0; a < kAmmoTypes; ++a) sp.stock[a] = ctx.cfg->logistics.containerStock[a];
    const int want = std::max(1, ctx.cfg->logistics.containerSlots);
    const V3 cand[6] = {local(sp.pos, yaw, 4.4f, -0.8f), local(sp.pos, yaw, 4.4f, 0.8f), local(sp.pos, yaw, 0.f, 2.9f),
                        local(sp.pos, yaw, 0.f, -2.9f), local(sp.pos, yaw, -4.8f, 0.f), local(sp.pos, yaw, 2.2f, 2.9f)};
    for (const V3& c : cand) {
        if ((int)sp.slots.size() >= want) break;
        V3 s;
        if (ctx.nav && slotAt(ctx, c, sp.pos.y, s)) sp.slots.push_back(s);
    }
    if (sp.slots.empty()) sp.slots.push_back(cand[0]);
    sp.slotUser.assign(sp.slots.size(), SoldierId{});
    sp.slotStale.assign(sp.slots.size(), 0.f);
    // B2 / GAME_DESIGN 14c: the container arrives by parachute (two cargo canopies, heavier descent than a crate) and
    // becomes usable (and a physical obstacle, Fortifications) once it has landed; it never disappears.
    sp.landed = false;
    sp.phase = 0;
    sp.startAlt = sp.altitude = ctx.cfg ? ctx.cfg->fort.containerAltitude : 40.f;
    sp.groundT = -1.f;
    sp.initialTotal = sp.total();
    uint32_t idx = (uint32_t)points_.size();
    for (uint32_t i = 0; i < points_.size(); ++i) if (!points_[i].alive) { idx = i; break; }
    if (idx == points_.size()) { points_.push_back(sp); gen_.push_back(1); }
    else { ++gen_[idx]; points_[idx] = sp; }
    points_[idx].id.index = idx;
    points_[idx].id.gen = gen_[idx];
    return points_[idx].id;
}

bool Logistics::canAirdrop(const GameContext& ctx, V3 pos, const char** why) const {
    V3 spot;
    return airdropSpot(ctx, pos, spot, why);
}

bool Logistics::airdropSpot(const GameContext& ctx, V3 pos, V3& spot, const char** why) const {
    auto no = [&](const char* r) { if (why) *why = r; return false; };
    if (!ctx.nav || !ctx.nav->ready()) return no("no navigation grid");
    if (!simulatedAt(ctx, pos.x, pos.z)) return no("outside the simulated area");
    const NavGrid& nav = *ctx.nav;
    const float clicked = nav.surface(pos.x, pos.z);
    // a spot: crate footprint flat (roof gravel / curbs within 0.35 m), on the clicked surface level (a stepped roof's
    // levels are separate surfaces), not on a vehicle / wall top, and a walkable access cell on that level next to it
    const char* reason = "blocked: inside geometry, a vehicle or an edge";
    auto ok = [&](V3 c, float& y) {
        if (!simulatedAt(ctx, c.x, c.z)) return false;
        if (!flatFootprint(ctx, c, kCrateHalf, kCrateHalf, 0.f, 0.35f, &y)) return false;
        if (std::fabs(y - clicked) > 1.0f) return false;
        float ground = y;
        for (int k = 0; k < 8; ++k) ground = std::min(ground, nav.surface(c.x + 8.f * std::cos(k * kPi / 4), c.z + 8.f * std::sin(k * kPi / 4)));
        if (y - ground > 0.5f && y - ground <= 2.5f) { reason = "blocked: on a vehicle, wall or obstacle"; return false; }
        V3 w;
        if (!nav.nearestWalkable(c, 1.6f, w) || std::fabs(nav.surface(w.x, w.z) - y) > 0.4f) return false;
        return true;
    };
    float y;
    if (ok(pos, y)) { spot = {pos.x, y, pos.z}; if (why) *why = ""; return true; }
    float best = 1e9f;
    for (float r = 0.5f; r <= 2.5f + 1e-3f; r += 0.5f)
        for (int k = 0; k < 16; ++k) {
            const float a = (float)k * kPi / 8.f;
            V3 c{pos.x + std::cos(a) * r, 0, pos.z + std::sin(a) * r};
            if (!ok(c, y)) continue;
            const float sc = r + std::fabs(y - clicked);
            if (sc < best) { best = sc; spot = {c.x, y, c.z}; }
        }
    if (best > 1e8f) return no(reason);
    if (why) *why = "";
    return true;
}

SupplyId Logistics::airdrop(GameContext& ctx, V3 pos) {
    SupplyPoint sp;
    sp.kind = SupplyKind::Crate;
    const LogisticsConfig& L = ctx.cfg->logistics;
    // scatter (deterministic per drop): the crate lands near, not exactly at, the requested point
    uint32_t seed = pcg((uint32_t)points_.size() * 7919u + (uint32_t)(ctx.tick * 31u) + 17u);
    V3 land = pos;
    V3 base;
    const bool snapped = airdropSpot(ctx, pos, base);
    if (snapped) land = base;
    // scatter stays on the requested surface: the same level and navigation island (a crate for a rooftop sniper lands
    // on his roof, never in the street below or on the next roof level)
    const uint32_t isl = snapped && ctx.nav ? ctx.nav->island(base.x, base.z) : 0u;
    for (int k = 0; k < 8 && snapped; ++k) {
        const float a = rand01(seed) * 2.f * kPi, r = rand01(seed) * L.airdropScatter;
        V3 c{base.x + std::cos(a) * r, base.y, base.z + std::sin(a) * r}, s2;
        if (!airdropSpot(ctx, c, s2) || std::fabs(s2.y - base.y) > 0.4f || dist2(s2, base) > (L.airdropScatter + 0.5f) * (L.airdropScatter + 0.5f)) continue;
        V3 w;
        if (isl && (!ctx.nav->nearestWalkable(s2, 1.6f, w) || ctx.nav->island(w.x, w.z) != isl)) continue;
        land = s2;
        break;
    }
    land.y = ctx.nav ? ctx.nav->surface(land.x, land.z) : pos.y;
    sp.pos = land;
    sp.yaw = rand01(seed) * 2.f * kPi;
    for (size_t a = 0; a < kAmmoTypes; ++a) sp.stock[a] = L.crateStock[a];
    const int want = std::max(1, L.crateSlots);
    for (int k = 0; k < 8 && (int)sp.slots.size() < want; ++k) {
        static const float off[8] = {0.f, kPi, kPi / 2, -kPi / 2, kPi / 4, 3 * kPi / 4, -kPi / 4, -3 * kPi / 4};
        const float a = sp.yaw + off[k];
        V3 c{land.x + std::cos(a) * 1.1f, land.y, land.z + std::sin(a) * 1.1f}, s;
        if (ctx.nav && slotAt(ctx, c, land.y, s)) sp.slots.push_back(s);
    }
    if (sp.slots.empty() && ctx.nav) {   // small roof: the nearest walkable cell on the crate's level
        V3 w;
        if (ctx.nav->nearestWalkable(land, 1.6f, w) && std::fabs(ctx.nav->surface(w.x, w.z) - land.y) < 0.4f) sp.slots.push_back({w.x, ctx.nav->surface(w.x, w.z), w.z});
    }
    if (sp.slots.empty()) sp.slots.push_back({land.x + 1.1f, land.y, land.z});
    sp.slotUser.assign(sp.slots.size(), SoldierId{});
    sp.slotStale.assign(sp.slots.size(), 0.f);
    sp.landed = false;
    sp.startAlt = sp.altitude = L.airdropAltitude;
    sp.phase = 0;
    sp.initialTotal = sp.total();
    uint32_t idx = (uint32_t)points_.size();
    for (uint32_t i = 0; i < points_.size(); ++i) if (!points_[i].alive) { idx = i; break; }
    if (idx == points_.size()) { points_.push_back(sp); gen_.push_back(1); }
    else { ++gen_[idx]; points_[idx] = sp; }
    points_[idx].id.index = idx;
    points_[idx].id.gen = gen_[idx];
    return points_[idx].id;
}

const SupplyPoint* Logistics::get(SupplyId id) const {
    return id.index < points_.size() && gen_[id.index] == id.gen && points_[id.index].alive ? &points_[id.index] : nullptr;
}
SupplyPoint* Logistics::getMut(SupplyId id) {
    return id.index < points_.size() && gen_[id.index] == id.gen && points_[id.index].alive ? &points_[id.index] : nullptr;
}

SupplyId Logistics::findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) const {
    SupplyId best;
    float bestD = maxDist * maxDist;
    const uint32_t isl = ctx.nav && ctx.nav->ready() ? ctx.nav->island(from.x, from.z) : 0;
    for (const SupplyPoint& p : points_) {
        if (!p.alive || !p.landed || p.stock[(size_t)type] <= 0) continue;
        const float d = (p.pos.x - from.x) * (p.pos.x - from.x) + (p.pos.z - from.z) * (p.pos.z - from.z);
        if (d > bestD) continue;
        if (isl && !p.slots.empty() && ctx.nav->island(p.slots[0].x, p.slots[0].z) != isl) continue;   // other roof / street
        bestD = d;
        best = p.id;
    }
    return best;
}

bool Logistics::reserve(SupplyId id, SoldierId soldier, V3& slotPos) {
    SupplyPoint* p = getMut(id);
    if (!p || !p->landed) return false;
    for (size_t k = 0; k < p->slots.size(); ++k)
        if (p->slotUser[k] == soldier) { slotPos = p->slots[k]; p->slotStale[k] = 0; return true; }   // already holds one
    // nearest free slot to the soldier is not known here: take the first free (slots are listed door-first)
    for (size_t k = 0; k < p->slots.size(); ++k)
        if (!p->slotUser[k].valid()) { p->slotUser[k] = soldier; p->slotStale[k] = 0; slotPos = p->slots[k]; return true; }
    if (id.index < waitingNow_.size()) ++waitingNow_[id.index];
    return false;
}

void Logistics::releaseReservation(SupplyId id, SoldierId soldier) {
    if (id.index >= points_.size() || gen_[id.index] != id.gen) return;
    SupplyPoint& p = points_[id.index];
    for (size_t k = 0; k < p.slotUser.size(); ++k)
        if (p.slotUser[k] == soldier) { p.slotUser[k] = SoldierId{}; p.slotStale[k] = 0; }
}

int Logistics::collect(SupplyId id, AmmoType type, int wanted) {
    SupplyPoint* p = getMut(id);
    if (!p || !p->landed || wanted <= 0) return 0;
    const int n = std::min(wanted, p->stock[(size_t)type]);
    p->stock[(size_t)type] -= n;
    delivered_[(size_t)type] += (uint64_t)n;
    return n;
}

int Logistics::queued(SupplyId id) const { return id.index < waiting_.size() ? waiting_[id.index] : 0; }

void Logistics::tick(GameContext& ctx) {
    const float dt = ctx.dt;
    waiting_ = waitingNow_;
    waitingNow_.assign(points_.size(), 0);
    for (SupplyPoint& p : points_) {
        if (!p.alive) continue;
        p.phaseT += dt;
        if (p.groundT >= 0 && p.groundT < 1e8f) p.groundT += dt;
        if (p.kind == SupplyKind::Container && p.phase < 2) {   // B2: container drop (descent -> touchdown -> settle)
            const FortConfig& F = ctx.cfg->fort;
            if (p.phase == 0) {
                p.altitude = std::max(0.f, p.altitude - F.containerDescentSpeed * dt);
                p.descentT += dt;
                if (p.altitude <= 0.f) {
                    p.phase = 1; p.phaseT = 0;
                    if (ctx.events) { ctx.events->fx.push_back({FxKind::CrateTouch, SoldierId{}, p.pos, {0, 1, 0}}); ctx.events->noise.push_back({p.pos, 0.6f, 30.f, 2.f}); }
                }
            } else if (p.phaseT >= F.containerLandDuration) {
                p.phase = 2; p.phaseT = 0;
                p.landed = true;
                p.groundT = 0.f;
            }
        }
        if (p.kind == SupplyKind::Crate) {
            if (p.phase == 0) {
                p.altitude = std::max(0.f, p.altitude - crateDescentSpeed * dt);
                p.descentT += dt;
                if (p.altitude <= 0.f) {
                    p.phase = 1; p.phaseT = 0;
                    if (ctx.events) { ctx.events->fx.push_back({FxKind::CrateTouch, SoldierId{}, p.pos, {0, 1, 0}}); ctx.events->noise.push_back({p.pos, 0.2f, 15.f, 1.5f}); }
                }
            } else if (p.phase == 1 && p.phaseT >= crateLandDuration) {
                p.phase = 2; p.phaseT = 0;
                p.landed = true;                 // collectable once the land clip settled
                if (p.groundT < 0) p.groundT = 0;
            }
            if (p.landed && p.total() <= 0) {
                p.emptyFor += dt;
                p.dissolve = std::clamp((p.emptyFor - emptyCrateLinger) / emptyCrateDissolve, 0.f, 1.f);
                if (p.dissolve >= 1.f) {
                    p.alive = false;
                    for (SoldierId& u : p.slotUser) u = SoldierId{};
                    continue;
                }
            }
        }
        // stale reservations: the user died, was released, or stopped resupplying for > 1 s (orders, combat)
        for (size_t k = 0; k < p.slotUser.size(); ++k) {
            SoldierId u = p.slotUser[k];
            if (!u.valid()) continue;
            bool keep = ctx.soldiers && ctx.soldiers->valid(u) && ctx.soldiers->alive(u.index);
            if (keep) {
                const SoldierState st = ctx.soldiers->state[u.index];
                const bool using_ = st == SoldierState::Resupplying || st == SoldierState::Collecting;
                p.slotStale[k] = using_ ? 0.f : p.slotStale[k] + dt;
                keep = p.slotStale[k] < 1.0f;
            }
            if (!keep) { p.slotUser[k] = SoldierId{}; p.slotStale[k] = 0; }
        }
    }
}

} // namespace ttz::game
