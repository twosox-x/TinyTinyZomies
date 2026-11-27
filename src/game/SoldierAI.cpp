// Soldier behaviour (WS-C): squad anchors + formation slots, per-soldier state machine, perception from the zombie
// field with target hysteresis, path following with separation and stuck recovery, resupply trips. See SoldierAI.h.
#include "game/SoldierAI.h"

#include "game/Config.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
inline float dist2D(V3 a, V3 b) { const float dx = a.x - b.x, dz = a.z - b.z; return std::sqrt(dx * dx + dz * dz); }
inline float yawTo(V3 from, V3 to) { return std::atan2(to.x - from.x, to.z - from.z); }   // yaw 0 faces +z
inline float wrapPi(float a) { while (a > kPi) a -= 2 * kPi; while (a < -kPi) a += 2 * kPi; return a; }
inline bool deployState(SoldierState s) { return s == SoldierState::Descending || s == SoldierState::Landing || s == SoldierState::Recovering; }
inline uint32_t cellKey(float x, float z) {
    const uint32_t cx = (uint32_t)((int)std::floor(x * 0.5f) + 32768) & 0xFFFFu, cz = (uint32_t)((int)std::floor(z * 0.5f) + 32768) & 0xFFFFu;
    return (cx << 16) | cz;
}
// Formation offsets (right, forward) in units of the squad spacing.
void slotOffset(SquadType t, int slot, float& r, float& f) {
    static const float wedge[5][2] = {{0, 0}, {-1, -1}, {1, -1}, {-2, -2}, {2, -2}};
    static const float line[3][2] = {{0, 0}, {-1, 0}, {1, 0}};
    if (t == SquadType::Rifle) { const int k = slot % 5; r = wedge[k][0]; f = wedge[k][1] - (float)(slot / 5) * 3.f; }
    else if (t == SquadType::MachineGun) { const int k = slot % 3; r = line[k][0]; f = line[k][1] - (float)(slot / 3) * 1.5f; }
    else { r = (float)slot; f = 0; }
}
void requestAnim(GameContext& ctx, uint32_t i, AnimAction a, float speed) {
    AnimPlayback& p = ctx.soldiers->anim[i];
    if (ctx.animator) ctx.animator->request(p, a, speed);
    else { p.requested = a; p.requestedSpeed = speed; }
}
} // namespace

// ---------------------------------------------------------------------------------------------------------------------
V3 SoldierAI::formationSlot(const GameContext& ctx, SquadId squad, int slot, V3 dest, float facing) const {
    const Squad* s = ctx.squads ? ctx.squads->get(squad) : nullptr;
    const SquadType t = s ? s->type : SquadType::Rifle;
    const float sp = ctx.cfg ? std::max(0.8f, ctx.cfg->squad[(int)t].formationSpacing) : 2.f;
    float r, f;
    slotOffset(t, slot, r, f);
    const V3 fw{std::sin(facing), 0, std::cos(facing)}, rt{std::cos(facing), 0, -std::sin(facing)};
    V3 p = dest + rt * (r * sp) + fw * (f * sp);
    if (!ctx.nav || !ctx.nav->ready()) return p;
    V3 d = dest, out;
    if (!ctx.nav->walkable(d.x, d.z) && !ctx.nav->nearestWalkable(dest, 6.f, d)) d = dest;
    const uint32_t isl = ctx.nav->island(d.x, d.z);
    if (ctx.nav->nearestWalkable(p, 4.f, out, isl)) return out;
    return isl ? d : p;
}

SquadId SoldierAI::spawnLanded(GameContext& ctx, SquadType type, V3 dest, float facing, uint32_t seed) {
    SquadId id = ctx.squads->create(type);
    const SquadDef& d = ctx.cfg->squad[(int)type];
    SoldierAI tmp;
    for (int k = 0; k < d.size; ++k) {
        V3 p = tmp.formationSlot(ctx, id, k, dest, facing);
        if (ctx.nav && ctx.nav->ready()) p.y = ctx.nav->surface(p.x, p.z);
        SoldierId s = ctx.soldiers->spawn(d.cls, 0, id, k, p, facing, seed + (uint32_t)k * 7919u);
        ctx.soldiers->equip(s.index, *ctx.cfg);
        ctx.soldiers->setState(s.index, SoldierState::Forming);
        ctx.squads->get(id)->members.push_back(s);
    }
    Squad* sq = ctx.squads->get(id);
    sq->deploying = false;
    return id;
}

void SoldierAI::assignSlots(GameContext& ctx, Squad& s, V3 dest, float facing) {
    SoldierPool& P = *ctx.soldiers;
    s.anchor = dest; s.anchorFacing = facing; s.hasAnchor = true; s.stuck = false;
    std::vector<V3> taken;
    const uint32_t isl = ctx.nav && ctx.nav->ready() ? ctx.nav->island(dest.x, dest.z) : 0u;
    for (const SoldierId& m : s.members) {
        if (!P.valid(m) || !P.alive(m.index)) continue;
        V3 p = formationSlot(ctx, s.id, P.slotInSquad[m.index], dest, facing);
        auto clash = [&](V3 q) { for (const V3& t : taken) if (dist2D(t, q) < 0.9f) return true; return false; };
        for (int ring = 1; ring <= 3 && clash(p); ++ring)
            for (int a = 0; a < 8; ++a) {
                V3 q = p + V3{std::cos(a * kPi / 4), 0, std::sin(a * kPi / 4)} * (float)ring, o;
                if (ctx.nav && ctx.nav->ready()) { if (!ctx.nav->nearestWalkable(q, 0.8f, o, isl)) continue; q = o; }
                if (!clash(q)) { p = q; break; }
            }
        taken.push_back(p);
        P.home[m.index] = p;
        P.homeYaw[m.index] = facing;
    }
}

void SoldierAI::squadOrders(GameContext& ctx, SupplyAccess& sup) {
    SoldierPool& P = *ctx.soldiers;
    for (Squad& s : ctx.squads->squads) {
        V3 c{};
        float fx = 0, fz = 0;
        int n = 0;
        for (const SoldierId& m : s.members) {
            if (!P.valid(m) || !P.alive(m.index) || P.state[m.index] == SoldierState::Descending) continue;
            c = c + P.pos[m.index]; fx += std::sin(P.yaw[m.index]); fz += std::cos(P.yaw[m.index]); ++n;
        }
        if (n) c = c * (1.f / n);
        if (s.order.serial != s.seenSerial) {
            s.seenSerial = s.order.serial;
            if (s.order.active) {
                float facing = s.order.facing;
                if (std::fabs(facing) < 1e-6f && n && dist2D(c, s.order.dest) > 1.f) facing = yawTo(c, s.order.dest);   // 0: face the way of travel
                V3 d = s.order.dest;
                if (ctx.nav && ctx.nav->ready()) d.y = ctx.nav->surface(d.x, d.z);
                assignSlots(ctx, s, d, facing);
            } else {   // Stop: hold where everyone stands
                s.anchor = n ? c : s.anchor; s.hasAnchor = true; s.stuck = false;
                for (const SoldierId& m : s.members)
                    if (P.valid(m)) { P.home[m.index] = P.pos[m.index]; P.homeYaw[m.index] = P.yaw[m.index]; }
            }
        } else if (!s.hasAnchor && n) {
            assignSlots(ctx, s, c, std::atan2(fx, fz));
        }
    }
    (void)sup;
}

// ---------------------------------------------------------------------------------------------------------------------
bool SoldierAI::nearestSample(const GameContext& ctx, V3 p, float r, V3& out) const {
    if (!ctx.horde) return false;
    const ZombieField& f = ctx.horde->field();
    if (!f.tilesX || f.tileSize <= 0.f) return false;
    const int i0 = std::max(0, (int)std::floor((p.x - r - f.originX) / f.tileSize)), i1 = std::min((int)f.tilesX - 1, (int)std::floor((p.x + r - f.originX) / f.tileSize));
    const int j0 = std::max(0, (int)std::floor((p.z - r - f.originZ) / f.tileSize)), j1 = std::min((int)f.tilesZ - 1, (int)std::floor((p.z + r - f.originZ) / f.tileSize));
    float best = r;
    bool found = false;
    for (int j = j0; j <= j1; ++j)
        for (int i = i0; i <= i1; ++i) {
            const ZombieFieldTile& t = f.tiles[(size_t)j * f.tilesX + (size_t)i];
            for (uint32_t k = 0; k < t.samples; ++k) {
                const float d = dist2D(p, t.pos[k]);
                if (d <= best) { best = d; out = t.pos[k]; found = true; }
            }
        }
    return found;
}

bool SoldierAI::findTarget(const GameContext& ctx, uint32_t i, float range, V3& out) const {
    if (!ctx.horde) return false;
    const SoldierPool& P = *ctx.soldiers;
    const V3 p = P.pos[i];
    const ZombieField& f = ctx.horde->field();
    if (!f.tilesX || f.tileSize <= 0.f) return false;
    constexpr int K = 6;
    V3 cand[K];
    float cd[K];
    int nc = 0;
    const int i0 = std::max(0, (int)std::floor((p.x - range - f.originX) / f.tileSize)), i1 = std::min((int)f.tilesX - 1, (int)std::floor((p.x + range - f.originX) / f.tileSize));
    const int j0 = std::max(0, (int)std::floor((p.z - range - f.originZ) / f.tileSize)), j1 = std::min((int)f.tilesZ - 1, (int)std::floor((p.z + range - f.originZ) / f.tileSize));
    for (int j = j0; j <= j1; ++j)
        for (int ti = i0; ti <= i1; ++ti) {
            const ZombieFieldTile& t = f.tiles[(size_t)j * f.tilesX + (size_t)ti];
            for (uint32_t k = 0; k < t.samples; ++k) {
                const float d = dist2D(p, t.pos[k]);
                if (d > range) continue;
                int at = nc < K ? nc++ : K;   // insertion into the K nearest
                if (at == K) { if (d >= cd[K - 1]) continue; at = K - 1; }
                while (at > 0 && cd[at - 1] > d) { cd[at] = cd[at - 1]; cand[at] = cand[at - 1]; --at; }
                cd[at] = d; cand[at] = t.pos[k];
            }
        }
    // Line of sight (nearest first); squad mates spread over the visible candidates close to the nearest one.
    V3 vis[K];
    int nv = 0;
    const V3 eye = p + V3{0, 1.5f, 0};
    for (int k = 0; k < nc; ++k) {
        if (nv && cd[k] > dist2D(p, vis[0]) + 4.f) break;
        if (!ctx.nav || ctx.nav->lineOfSight(eye, cand[k] + V3{0, 1.f, 0})) vis[nv++] = cand[k];
    }
    if (!nv) return false;
    out = vis[P.slotInSquad[i] % nv];
    return true;
}

void SoldierAI::face(GameContext& ctx, uint32_t i, V3 at) {
    SoldierPool& P = *ctx.soldiers;
    if (dist2D(P.pos[i], at) < 0.05f) return;
    const float want = yawTo(P.pos[i], at), d = wrapPi(want - P.yaw[i]), mx = tuning.turnRate * ctx.dt;
    P.yaw[i] = wrapPi(P.yaw[i] + std::clamp(d, -mx, mx));
}

void SoldierAI::steer(GameContext& ctx, uint32_t i, V3 desired) {
    SoldierPool& P = *ctx.soldiers;
    const V3 p = P.pos[i];
    const bool moving = desired.x * desired.x + desired.z * desired.z > 1e-4f;
    // Separation from nearby soldiers (squad mates and others), via the 2 m cell hash.
    V3 push{};
    const float sep = tuning.separation, hard = 0.6f;
    const int cx = (int)std::floor(p.x * 0.5f), cz = (int)std::floor(p.z * 0.5f);
    for (int dz = -1; dz <= 1; ++dz)
        for (int dx = -1; dx <= 1; ++dx) {
            const uint32_t key = cellKey((float)(cx + dx) * 2.f + 1.f, (float)(cz + dz) * 2.f + 1.f);
            auto it = std::lower_bound(hash_.begin(), hash_.end(), key, [](const Cell& c, uint32_t k) { return c.key < k; });
            for (; it != hash_.end() && it->key == key; ++it) {
                const uint32_t j = it->idx;
                if (j == i) continue;
                const float ox = p.x - P.pos[j].x, oz = p.z - P.pos[j].z, d = std::sqrt(ox * ox + oz * oz);
                const float lim = moving ? sep : hard;
                if (d >= lim) continue;
                if (d < 1e-4f) { const float a = (float)(i % 8) * kPi / 4; push = push + V3{std::cos(a), 0, std::sin(a)}; continue; }
                push = push + V3{ox / d, 0, oz / d} * ((lim - d) / lim * 1.6f);
            }
        }
    V3 v = desired + push;
    const float vl = std::sqrt(v.x * v.x + v.z * v.z), cap = std::max(1.2f, std::sqrt(desired.x * desired.x + desired.z * desired.z) * 1.25f);
    if (vl > cap) v = v * (cap / vl);
    V3 np{p.x + v.x * ctx.dt, p.y, p.z + v.z * ctx.dt};
    if (ctx.nav && ctx.nav->ready()) {
        NavGrid& nav = *ctx.nav;
        auto ok = [&](V3 q) { return nav.walkLine(p, q) || (!nav.walkable(p.x, p.z) && nav.walkable(q.x, q.z)); };
        if (!ok(np)) {
            V3 a{np.x, p.y, p.z}, b{p.x, p.y, np.z};
            np = ok(a) ? a : ok(b) ? b : p;
        }
        np.y = nav.surface(np.x, np.z);
    }
    P.vel[i] = V3{(np.x - p.x) / ctx.dt, 0, (np.z - p.z) / ctx.dt};
    P.pos[i] = np;
    if (moving) face(ctx, i, p + desired);
}

void SoldierAI::startPath(GameContext& ctx, uint32_t i, V3 goal) {
    SoldierPool& P = *ctx.soldiers;
    PathFollow& pf = P.path[i];
    if (pf.request && ctx.nav) ctx.nav->cancel(pf.request);
    pf = PathFollow{};
    P.goal[i] = goal;
    P.stuckTime[i] = 0; P.progressPos[i] = P.pos[i]; P.repaths[i] = 0;
    if (ctx.nav && ctx.nav->ready()) pf.request = ctx.nav->requestPath(P.pos[i], goal);
    else pf.points = {goal};
}

int SoldierAI::followPath(GameContext& ctx, uint32_t i, float speed) {
    SoldierPool& P = *ctx.soldiers;
    PathFollow& pf = P.path[i];
    const V3 p = P.pos[i], goal = P.goal[i];
    auto replan = [&]() {
        const uint8_t r = P.repaths[i];
        startPath(ctx, i, goal);
        P.repaths[i] = (uint8_t)(r + 1);
    };
    if (pf.request) {
        std::vector<V3> out;
        bool failed = false;
        if (!ctx.nav || !ctx.nav->poll(pf.request, out, failed)) { steer(ctx, i, {}); return 0; }   // waiting: not stuck
        pf.request = 0;
        if (failed) { pf.failed = true; steer(ctx, i, {}); return 2; }
        pf.points.swap(out); pf.next = 0;
        P.stuckTime[i] = 0; P.progressPos[i] = p;
    }
    if (pf.failed) { steer(ctx, i, {}); return 2; }
    while (!pf.done()) {
        const bool last = pf.next + 1 == pf.points.size();
        if (dist2D(p, pf.points[pf.next]) < (last ? tuning.arriveRadius : tuning.waypointRadius)) ++pf.next;
        else break;
    }
    if (pf.done()) {
        if (dist2D(p, goal) < tuning.arriveRadius * 2.5f) { steer(ctx, i, {}); return 1; }
        if (P.repaths[i] < 2) { replan(); return 0; }
        steer(ctx, i, {});
        return 2;
    }
    const V3 t = pf.points[pf.next];
    const float dx = t.x - p.x, dz = t.z - p.z, d = std::max(1e-4f, std::sqrt(dx * dx + dz * dz));
    // A leg that became blocked (vehicle stamped in, wall built, pushed off the line): quick re-plan from here.
    if (ctx.nav && ctx.nav->ready() && !ctx.nav->walkLine(p, t)) pf.blockedFor += ctx.dt; else pf.blockedFor = 0.f;
    if (pf.blockedFor > 0.4f && pf.quickReplans < 3) {
        const uint32_t q = pf.quickReplans + 1;
        const float st = P.stuckTime[i];
        const uint8_t r = P.repaths[i];
        startPath(ctx, i, goal);
        P.path[i].quickReplans = q; P.stuckTime[i] = st; P.repaths[i] = r;
        steer(ctx, i, {});
        return 0;
    }
    float v = speed;
    if (pf.next + 1 == pf.points.size()) v *= std::clamp(d / 1.2f, 0.35f, 1.f);
    steer(ctx, i, V3{dx / d * v, 0, dz / d * v});
    // Stuck: no 0.5 m of progress toward the current waypoint for stuckTime -> one re-plan, then give up (the
    // caller holds and flags the squad). Creeping sideways along a wall is not progress.
    const float nd = dist2D(P.pos[i], t);
    if (pf.next != pf.bestNext || nd < pf.best - 0.5f) { pf.bestNext = pf.next; pf.best = nd; P.stuckTime[i] = 0; }
    else P.stuckTime[i] += ctx.dt;
    if (P.stuckTime[i] > tuning.stuckTime) {
        if (P.repaths[i] < 1) { replan(); return 0; }
        return 2;
    }
    return 0;
}

void SoldierAI::dropSupply(GameContext& ctx, SupplyAccess& sup, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    if (P.supply[i].valid()) sup.release(P.supply[i], P.idOf(i));
    P.supply[i] = SupplyId{};
}

void SoldierAI::tryResupply(GameContext& ctx, SupplyAccess& sup, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    const SoldierStats& ss = ctx.cfg->soldier[(int)P.cls[i]];
    const SupplyId sp = sup.findNearest(ctx, P.pos[i], ammoOf(P.cls[i]), ss.resupplySearchRadius);
    if (!sp.valid()) { P.retry[i] = tuning.supplySearchInterval; return; }
    P.supply[i] = sp;
    V3 slot;
    if (sup.reserve(sp, P.idOf(i), slot)) {
        P.setState(i, SoldierState::Resupplying);
        startPath(ctx, i, slot);
        return;
    }
    // Every slot taken: queue on a ring around the point and retry (no blocking at the slots).
    V3 c = P.pos[i];
    sup.position(sp, c);
    V3 d = P.pos[i] - c;
    const float l = std::max(1e-3f, std::sqrt(d.x * d.x + d.z * d.z));
    V3 q = c + V3{d.x / l, 0, d.z / l} * tuning.queueRadius, o;
    if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(q, 2.f, o, ctx.nav->island(P.pos[i].x, P.pos[i].z))) q = o;
    P.setState(i, SoldierState::Resupplying);
    P.phase[i] |= PH_WAITING;
    startPath(ctx, i, q);
    P.retry[i] = tuning.supplyRetry;
}

void SoldierAI::leave(GameContext& ctx, SupplyAccess& sup, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    const SoldierState r = P.resume[i];
    P.resume[i] = SoldierState::Idle;
    if (r == SoldierState::Moving || r == SoldierState::Forming) { P.setState(i, r); return; }
    if (r == SoldierState::Resupplying && P.supply[i].valid()) {
        V3 slot;
        const bool have = sup.reserve(P.supply[i], P.idOf(i), slot);   // idempotent for the holder
        P.setState(i, SoldierState::Resupplying);
        if (have) { if (dist2D(slot, P.goal[i]) > 0.3f) startPath(ctx, i, slot); }
        else { P.phase[i] |= PH_WAITING; P.retry[i] = tuning.supplyRetry; }
        return;
    }
    P.setState(i, SoldierState::Idle);
}

// ---------------------------------------------------------------------------------------------------------------------
void SoldierAI::soldier(GameContext& ctx, SupplyAccess& sup, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const float dt = ctx.dt;
    P.stateTime[i] += dt;
    if (P.state[i] == SoldierState::Dead) { P.vel[i] = {}; return; }
    if (!P.equipped[i]) P.equip(i, cfg);
    if (deployState(P.state[i])) return;   // Deploy owns descent, landing and recovery
    Squad* sq = ctx.squads->get(P.squad[i]);
    const int c = (int)P.cls[i];
    const WeaponStats& w = cfg.weapon[c];
    const SoldierStats& ss = cfg.soldier[c];
    P.stopCooldown[i] -= dt;
    P.retry[i] -= dt;

    // ---- death (always wins)
    if (P.health[i] <= 0.f && P.state[i] != SoldierState::Dying) {
        dropSupply(ctx, sup, i);
        if (P.path[i].request && ctx.nav) ctx.nav->cancel(P.path[i].request);
        P.path[i] = PathFollow{};
        P.target[i] = TargetLock{};
        P.setState(i, SoldierState::Dying);
    }
    if (P.state[i] == SoldierState::Dying) {
        P.vel[i] = {};
        requestAnim(ctx, i, AnimAction::Death, 0.f);
        const bool clipDone = !ctx.animator || ctx.animator->finished(P.anim[i], P.infantry[i]);
        if ((P.stateTime[i] >= tuning.dyingTime && clipDone) || P.stateTime[i] >= tuning.dyingTime * 3.f) P.setState(i, SoldierState::Dead);
        return;
    }
    P.wounded[i] = P.health[i] < P.woundedFraction * std::max(1.f, P.maxHealth[i]) ? 1 : 0;
    const bool outside = ctx.horde && !ctx.horde->simulated(P.pos[i].x, P.pos[i].z);   // B1: no fighting there

    // ---- a fresh squad order takes over (Reloading / Hit finish first: non-interruptible clips)
    if (sq && P.orderSerial[i] != sq->seenSerial) {
        const SoldierState s = P.state[i];
        if (s != SoldierState::Reloading && s != SoldierState::Hit) {
            P.orderSerial[i] = sq->seenSerial;
            dropSupply(ctx, sup, i);
            P.target[i].active = false;
            P.resume[i] = SoldierState::Idle;
            if (sq->order.active) {
                P.setState(i, SoldierState::Moving);
                P.phase[i] = 0;
                startPath(ctx, i, P.home[i]);
                P.stopCooldown[i] = 1.f;
            } else {
                if (P.path[i].request && ctx.nav) ctx.nav->cancel(P.path[i].request);
                P.path[i] = PathFollow{};
                P.setState(i, SoldierState::Idle);
            }
        }
    }

    // ---- target lock maintenance (hysteresis, GAME_DESIGN 14b: no endless switching)
    TargetLock& L = P.target[i];
    const bool perceive = tuning.perceptionStride <= 1 || (ctx.tick + i) % (uint64_t)tuning.perceptionStride == 0;
    const V3 eye = P.pos[i] + V3{0, 1.5f, 0};
    V3 close;
    const bool hasClose = !outside && nearestSample(ctx, P.pos[i], tuning.closeThreat, close);
    if (L.active) {
        V3 s;
        if (nearestSample(ctx, L.pos, tuning.targetKeepRadius, s)) { L.pos = s; L.age = 0.f; }
        else L.age += dt;
        if (perceive && ctx.nav && !ctx.nav->lineOfSight(eye, L.pos + V3{0, 1.f, 0})) L.age += dt * (float)tuning.perceptionStride;
        const float d = dist2D(P.pos[i], L.pos);
        if (L.age > tuning.targetLostTime || d > w.acquireRange * 1.05f || outside) L.active = false;
        else if (hasClose && d > tuning.closeSwitchMinDist && dist2D(P.pos[i], close) < tuning.closeThreat) {
            L.pos = close; L.age = 0.f; L.acquire = std::min(L.acquire, w.acquireTime * 0.5f);
            ++P.targetSwitches[i];
        }
    }
    auto lockNew = [&](bool countSwitch) {
        V3 t;
        if (outside || !findTarget(ctx, i, w.acquireRange, t)) return false;
        L = TargetLock{}; L.active = true; L.pos = t;
        if (countSwitch) ++P.targetSwitches[i];
        return true;
    };

    const float speedMul = P.wounded[i] ? tuning.woundedSpeed : 1.f;
    switch (P.state[i]) {
    case SoldierState::Forming:
    case SoldierState::Moving: {
        if (P.state[i] == SoldierState::Forming && dist2D(P.goal[i], P.home[i]) > 0.5f) startPath(ctx, i, P.home[i]);
        if (P.state[i] == SoldierState::Moving && !tuning.fireOnMove && P.stopCooldown[i] <= 0.f && P.mag[i] > 0 && !outside) {
            V3 t;   // threat stop: a zombie this close is shot first, then the order resumes (never abandoned)
            if (nearestSample(ctx, P.pos[i], tuning.moveThreatRadius, t) && (!ctx.nav || ctx.nav->lineOfSight(eye, t + V3{0, 1.f, 0}))) {
                L = TargetLock{}; L.active = true; L.pos = t;
                P.resume[i] = SoldierState::Moving;
                P.setState(i, SoldierState::Engaging);
                P.stopCooldown[i] = tuning.moveStopMax + tuning.moveStopCooldown;
                P.vel[i] = {};
                break;
            }
        }
        const bool run = P.state[i] == SoldierState::Moving && sq && sq->order.run && !(P.phase[i] & PH_RETURNING);
        const int r = followPath(ctx, i, (run ? ss.runSpeed : ss.walkSpeed) * speedMul);
        if (r == 1) P.setState(i, SoldierState::Idle);
        else if (r == 2) {   // unreachable / stuck after the re-plan: hold here and flag the squad (no endless retries)
            V3 h = P.pos[i];
            if (ctx.nav && ctx.nav->ready() && !ctx.nav->walkable(h.x, h.z)) ctx.nav->nearestWalkable(P.pos[i], 2.f, h);
            P.home[i] = h;
            if (sq) sq->stuck = true;
            P.path[i] = PathFollow{};
            P.setState(i, SoldierState::Idle);
        }
        break;
    }
    case SoldierState::Engaging: {
        steer(ctx, i, {});
        if (!L.active && (perceive || hasClose)) lockNew(true);
        if (P.mag[i] <= 0) {
            if (P.reserve[i] > 0) P.setState(i, SoldierState::Reloading);
            else leave(ctx, sup, i);
            break;
        }
        if (L.active) {
            face(ctx, i, L.pos);
            const float d = dist2D(P.pos[i], L.pos), off = std::fabs(wrapPi(yawTo(P.pos[i], L.pos) - P.yaw[i]));
            if (off < tuning.aimTolerance) L.acquire += dt;
            const bool acquired = L.acquire >= w.acquireTime && d <= w.range && !outside;
            if (acquired && !(P.phase[i] & PH_ACQUIRED)) { P.phase[i] |= PH_ACQUIRED; P.fireCooldown[i] = -1.f; }   // Combat arms the clock
            if (!acquired) P.phase[i] &= (uint8_t)~PH_ACQUIRED;
        } else P.phase[i] &= (uint8_t)~PH_ACQUIRED;
        const bool fromMove = P.resume[i] != SoldierState::Idle;
        const float threatLimit = fromMove ? tuning.moveThreatRadius + 2.f : 1e9f;
        const bool threatGone = !L.active || dist2D(P.pos[i], L.pos) > threatLimit;
        if (P.stateTime[i] >= tuning.engageMinDwell && (threatGone || (P.resume[i] == SoldierState::Moving && P.stateTime[i] > tuning.moveStopMax))) {
            L.active = L.active && !fromMove;
            leave(ctx, sup, i);
        }
        break;
    }
    case SoldierState::Reloading: {
        steer(ctx, i, {});
        const bool done = (P.phase[i] & PH_RELOADED) && P.stateTime[i] >= w.reloadTime * 0.95f;
        if (done || (!(P.phase[i] & PH_RELOADED) && P.reserve[i] <= 0) || P.stateTime[i] > w.reloadTime * 3.f + 2.f) leave(ctx, sup, i);
        break;
    }
    case SoldierState::Hit:
        steer(ctx, i, {});
        if (P.stateTime[i] >= tuning.hitDuration) leave(ctx, sup, i);
        break;
    case SoldierState::Resupplying: {
        if (!P.supply[i].valid() || sup.stock(P.supply[i], ammoOf(P.cls[i])) <= 0) {
            dropSupply(ctx, sup, i);
            P.retry[i] = tuning.supplySearchInterval;
            P.setState(i, SoldierState::Idle);
            break;
        }
        if (hasClose && P.mag[i] > 0 && P.stopCooldown[i] <= 0.f) {
            L = TargetLock{}; L.active = true; L.pos = close;
            P.resume[i] = SoldierState::Resupplying;
            P.setState(i, SoldierState::Engaging);
            P.stopCooldown[i] = tuning.moveStopCooldown;
            break;
        }
        const bool waiting = P.phase[i] & PH_WAITING;
        if (waiting && P.retry[i] <= 0.f) {
            V3 slot;
            if (sup.reserve(P.supply[i], P.idOf(i), slot)) { P.phase[i] &= (uint8_t)~PH_WAITING; startPath(ctx, i, slot); }
            else P.retry[i] = tuning.supplyRetry;
        }
        const bool outOfAmmo = P.mag[i] + P.reserve[i] == 0;
        const int r = followPath(ctx, i, (outOfAmmo ? ss.runSpeed : ss.walkSpeed) * speedMul);
        if (P.phase[i] & PH_WAITING) { if (r != 0) { P.path[i].points.clear(); P.path[i].failed = false; steer(ctx, i, {}); } break; }
        if (r == 1) P.setState(i, SoldierState::Collecting);
        else if (r == 2) {
            dropSupply(ctx, sup, i);
            if (sq) sq->stuck = true;
            P.retry[i] = tuning.supplySearchInterval * 3.f;
            P.setState(i, SoldierState::Idle);
        }
        break;
    }
    case SoldierState::Collecting: {
        P.vel[i] = {};
        V3 sp;
        if (P.supply[i].valid() && sup.position(P.supply[i], sp)) face(ctx, i, sp);
        if (P.stateTime[i] >= tuning.collectTime) {
            const int total = P.mag[i] + P.reserve[i], full = P.fullLoad(i, cfg);
            const bool more = (P.phase[i] & PH_GRABBED) && total < full && P.supply[i].valid() && sup.stock(P.supply[i], ammoOf(P.cls[i])) > 0;
            if (more) { P.stateTime[i] = 0.f; P.phase[i] = 0; ++P.stateChanges[i]; }   // another collect cycle
            else {
                dropSupply(ctx, sup, i);
                P.setState(i, SoldierState::Moving);
                P.phase[i] |= PH_RETURNING;
                startPath(ctx, i, P.home[i]);
                P.stopCooldown[i] = 1.f;
            }
        }
        break;
    }
    case SoldierState::Idle:
    default: {
        steer(ctx, i, {});
        if (outside) break;
        const float off = wrapPi(P.homeYaw[i] - P.yaw[i]);
        if (std::fabs(off) > 0.05f) P.yaw[i] = wrapPi(P.yaw[i] + std::clamp(off, -tuning.turnRate * 0.5f * dt, tuning.turnRate * 0.5f * dt));
        const int total = P.mag[i] + P.reserve[i];
        const bool low = total < (int)std::ceil(ss.lowAmmoFraction * (float)P.fullLoad(i, cfg));
        if (P.mag[i] > 0 && (L.active || ((perceive || hasClose) && lockNew(false)))) { P.setState(i, SoldierState::Engaging); break; }
        if (dist2D(P.pos[i], P.home[i]) > tuning.leash && !hasClose) {
            P.setState(i, SoldierState::Moving);
            P.phase[i] |= PH_RETURNING;
            startPath(ctx, i, P.home[i]);
            break;
        }
        if (P.mag[i] < (int)(w.magazine * tuning.tacticalReloadFraction) && P.reserve[i] > 0) { P.setState(i, SoldierState::Reloading); break; }
        if (low && P.retry[i] <= 0.f) { tryResupply(ctx, sup, i); if (P.state[i] != SoldierState::Idle) break; }
        if (P.wounded[i] && medicalSeek && medicalSeek(ctx, i)) break;
        break;
    }
    }

    // ---- animation request for the resulting state
    const bool heavy = P.cls[i] != SoldierClass::Rifleman;   // MG and sniper fire from a crouch
    switch (P.state[i]) {
    case SoldierState::Moving:
    case SoldierState::Forming:
    case SoldierState::Resupplying: {
        const float v = std::sqrt(P.vel[i].x * P.vel[i].x + P.vel[i].z * P.vel[i].z);
        requestAnim(ctx, i, v < 0.05f ? AnimAction::Idle : v > ss.walkSpeed * 1.3f ? AnimAction::Run : AnimAction::Walk, v);
        break;
    }
    case SoldierState::Engaging: {
        const bool firing = (P.phase[i] & PH_ACQUIRED) && P.mag[i] > 0;
        requestAnim(ctx, i, firing ? (heavy ? AnimAction::CrouchFire : AnimAction::Fire) : (heavy ? AnimAction::CrouchAim : AnimAction::Aim), 0.f);
        break;
    }
    case SoldierState::Reloading: requestAnim(ctx, i, AnimAction::Reload, 0.f); break;
    case SoldierState::Collecting: requestAnim(ctx, i, AnimAction::CollectAmmo, 0.f); break;
    case SoldierState::Hit: requestAnim(ctx, i, AnimAction::Hit, 0.f); break;
    case SoldierState::Dying: requestAnim(ctx, i, AnimAction::Death, 0.f); break;
    default: requestAnim(ctx, i, AnimAction::Idle, 0.f); break;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
void SoldierAI::tick(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.squads || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    logisticsSupply_.lg = ctx.logistics;
    SupplyAccess& sup = supply ? *supply : logisticsSupply_;
    if (ctx.nav) ctx.nav->tick(tuning.pathBudget);
    hash_.clear();
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i)
        if (P.alive(i) && P.state[i] != SoldierState::Descending) hash_.push_back({cellKey(P.pos[i].x, P.pos[i].z), i});
    std::sort(hash_.begin(), hash_.end(), [](const Cell& a, const Cell& b) { return a.key != b.key ? a.key < b.key : a.idx < b.idx; });
    squadOrders(ctx, sup);
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i)
        if (P.used[i]) soldier(ctx, sup, i);
    // Squad status flags (UI markers, GAME_DESIGN 14b).
    for (Squad& s : ctx.squads->squads) {
        uint32_t f = 0;
        bool deploying = false;
        for (const SoldierId& m : s.members) {
            if (!P.valid(m)) { f |= SQ_CASUALTIES; continue; }
            const uint32_t i = m.index;
            const SoldierState st = P.state[i];
            if (st == SoldierState::Dying || st == SoldierState::Dead) { f |= SQ_CASUALTIES; continue; }
            if (deployState(st)) { f |= SQ_DEPLOYING; deploying = true; continue; }
            const int total = P.mag[i] + P.reserve[i];
            if (total == 0) f |= SQ_OUT_OF_AMMO;
            if (total < (int)std::ceil(ctx.cfg->soldier[(int)P.cls[i]].lowAmmoFraction * (float)P.fullLoad(i, *ctx.cfg))) f |= SQ_LOW_AMMO;
            if (st == SoldierState::Moving || st == SoldierState::Forming) f |= SQ_MOVING;
            if (st == SoldierState::Resupplying || st == SoldierState::Collecting) f |= SQ_RESUPPLYING;
            if (st == SoldierState::Engaging) f |= SQ_ENGAGED;
            if (P.contactAge[i] < 2.f) f |= SQ_UNDER_ATTACK;
        }
        s.flags = f;
        s.deploying = deploying;
    }
}

SoldierAI::SquadStatus SoldierAI::status(const GameContext& ctx, SquadId id) const {
    SquadStatus st;
    const Squad* s = ctx.squads ? ctx.squads->get(id) : nullptr;
    if (!s) return st;
    const SoldierPool& P = *ctx.soldiers;
    st.size = (int)s->members.size();
    st.stuck = s->stuck;
    st.minHealth = 1e9f;
    for (const SoldierId& m : s->members) {
        if (!P.valid(m)) continue;
        const uint32_t i = m.index;
        st.targetSwitches += P.targetSwitches[i];
        st.stateChanges += P.stateChanges[i];
        st.roundsFired += P.rounds[i];
        if (!P.alive(i)) continue;
        ++st.alive;
        st.rounds += P.mag[i] + P.reserve[i];
        st.fullRounds += P.fullLoad(i, *ctx.cfg);
        st.minHealth = std::min(st.minHealth, P.health[i]);
    }
    if (!st.alive) st.minHealth = 0.f;
    return st;
}

} // namespace ttz::game
