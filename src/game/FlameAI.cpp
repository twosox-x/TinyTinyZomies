// Flamethrower squad behaviour (GAME_DESIGN 14d). See FlameAI.h.
#include "game/FlameAI.h"

#include "game/Config.h"
#include "game/Deploy.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kMuzzleHeight = 1.25f, kMuzzleForward = 0.7f;
constexpr float kMaxSpraySeconds = 0.4f;      // one spray never stands for more than this (clip pauses, reloads)
constexpr float kBurnTimeout = 30.f;          // s spraying one pile before giving up (unreachable / shielded bodies)
constexpr float kApproachTimeout = 40.f;      // s walking to a pile
float dist2(V3 a, V3 b) { return (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z); }
bool busy(SoldierState s) {
    return s == SoldierState::Engaging || s == SoldierState::Hit || s == SoldierState::Reloading || s == SoldierState::Resupplying ||
           s == SoldierState::Collecting || s == SoldierState::Dying || s == SoldierState::Dead;
}
constexpr float kBurstMin = 2.2f, kBurstMax = 3.6f;   // owner 14e "spray longer": sustained bursts (s)
constexpr float kBurstPause = 1.2f;                   // s between pile bursts (let it burn, look again)
constexpr float kZombieBurst = 2.0f;                  // s a burst at zombies keeps going after the target fell
// Ground under a point (the nav heights carry cars and walls: a pile next to a wall / between cars read the wall or car
// top -> "roof vs street" skipped it, aim too high): the lowest walkable surface within ~1.5 m.
float groundNear(const NavGrid* nav, V3 p) {
    if (!nav || !nav->ready()) return p.y;
    float best = 1e9f;
    for (float dz = -1.5f; dz <= 1.51f; dz += 0.5f)
        for (float dx = -1.5f; dx <= 1.51f; dx += 0.5f)
            if (nav->walkable(p.x + dx, p.z + dz)) best = std::min(best, nav->surface(p.x + dx, p.z + dz));
    return best < 1e8f ? best : nav->surface(p.x, p.z);
}
// Highest obstacle top (shot layer: cars, walls, gates) between a nozzle at `a` and the pile at `b`, ignoring the last
// `skipEnd` m (the pile's own cell, a wall right behind it); its distance from a in `at`.
float obstacleTop(const NavGrid* nav, V3 a, V3 b, float skipEnd, float& at) {
    at = 0.f;
    if (!nav || !nav->ready()) return -1e9f;
    const float dx = b.x - a.x, dz = b.z - a.z, L = std::sqrt(dx * dx + dz * dz);
    float top = -1e9f;
    for (float s = 0.6f; s < L - skipEnd; s += 0.375f) {
        const float h = nav->shotHeight(a.x + dx / L * s, a.z + dz / L * s);
        if (h > top) { top = h; at = s; }
    }
    return top;
}
} // namespace

// Stand-off spot for spraying a pile (owner 14e: "trouble burning corpses next to walls and between cars"): 16
// directions x 3 distances around the pile; walkable, on the squad's island, at street level with the pile; the spray
// line from the nozzle may cross low obstacles (cars, low walls <= 1.9 m above the ground: the jet arcs over them, the
// cone ignites through) but not a building / tall wall. Score: walking distance from the squad + obstacle penalty.
bool FlameAI::pickStand(const GameContext& ctx, V3 pile, V3 from, float standoff, V3& out, float& facing) const {
    const NavGrid* nav = ctx.nav;
    if (!nav || !nav->ready()) return false;
    const float gy = groundNear(nav, pile);
    const uint32_t isl = nav->island(from.x, from.z);
    float best = 1e9f;
    for (float r : {standoff, standoff * 0.7f, standoff * 1.2f})
        for (int k = 0; k < 16; ++k) {
            const float a = (float)k * 0.392699f;
            V3 q = pile + V3{std::sin(a) * r, 0, std::cos(a) * r}, w;
            if (!nav->nearestWalkable(q, 0.8f, w, isl)) continue;
            const float wy = nav->surface(w.x, w.z);
            if (std::fabs(wy - gy) > 1.0f) continue;   // street level with the pile (not a roof / container top)
            const float d = std::sqrt(dist2(w, pile));
            if (d < 2.5f || d > 8.2f) continue;
            float at;
            const float top = obstacleTop(nav, V3{w.x, wy + kMuzzleHeight, w.z}, V3{pile.x, gy, pile.z}, 1.0f, at);
            if (top > gy + 1.9f) continue;   // building / tall wall in the way
            const float pen = top > gy + 0.4f ? 6.f + 3.f * (top - gy) : 0.f;
            const float sc = std::sqrt(dist2(w, from)) + pen + std::fabs(d - standoff) * 0.5f;
            if (sc < best) { best = sc; out = w; facing = std::atan2(pile.x - w.x, pile.z - w.z); }
        }
    return best < 1e8f;
}

void FlameAI::usePlaceholderAssets(DeployTiming& t) {
    const size_t f = (size_t)SoldierClass::Flamethrower, r = (size_t)SoldierClass::Rifleman;
    if (t.variants[f].empty()) t.variants[f] = t.variants[r];   // swap hook: approved flamethrower variants replace these
    t.descentSpeed[f] = t.descentSpeed[r];
    t.landDuration[f] = t.landDuration[r];
    t.recoverDuration[f] = t.recoverDuration[r];
}

void FlameAI::ensure(const GameContext& ctx) {
    const size_t n = ctx.soldiers->capacity();
    if (last_.size() < n) {
        last_.resize(n, -1.0); fuelAcc_.resize(n, 0.f); lastGen_.resize(n, ~0u); noiseAt_.resize(n, -1e9); burnAnim_.resize(n, 0);
        burstStart_.resize(n, -1e9); pauseUntil_.resize(n, -1e9); lastAim_.resize(n, V3{});
    }
    for (size_t i = 0; i < n; ++i)
        if (lastGen_[i] != ctx.soldiers->gen[i]) {
            lastGen_[i] = ctx.soldiers->gen[i]; last_[i] = -1.0; fuelAcc_[i] = 0.f; noiseAt_[i] = -1e9; burnAnim_[i] = 0;
            burstStart_[i] = -1e9; pauseUntil_[i] = -1e9;
        }
}

bool FlameAI::spray(GameContext& ctx, uint32_t i, V3 aim, float arcUp) {
    SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const WeaponStats& w = cfg.weapon[(size_t)SoldierClass::Flamethrower];
    const FlameConfig& F = cfg.flame;
    ensure(ctx);
    if (P.mag[i] <= 0) return false;
    const V3 fw{std::sin(P.yaw[i]), 0, std::cos(P.yaw[i])};
    const V3 origin = P.firePos(i) + V3{0, kMuzzleHeight, 0} + fw * kMuzzleForward;
    V3 d = aim - origin;
    const float len = std::sqrt(dot(d, d));
    d = len > 1e-3f ? d * (1.f / len) : fw;
    // friendly-fire safety: nobody (squad mate or other soldier) inside the cone + clearance
    const float tanA = std::tan(F.coneDeg * 3.14159265f / 180.f);
    for (uint32_t j = 0; j < (uint32_t)P.capacity(); ++j) {
        if (j == i || !P.used[j] || !P.alive(j) || P.state[j] == SoldierState::Descending || P.post[j] == POST_INSIDE) continue;
        const V3 q = P.pos[j] + V3{0, 0.9f, 0} - origin;
        const float along = dot(q, d);
        if (along < -0.5f || along > w.range + F.friendlyClearance) continue;
        const float lat = std::sqrt(std::max(0.f, dot(q, q) - along * along));
        if (lat < std::max(along, 0.f) * tanA + F.friendlyClearance) { ++blocked_; return false; }
    }
    const double now = ctx.time;
    if (last_[i] < 0.0 || now - last_[i] > 0.6) burstStart_[i] = now;   // a new burst
    lastAim_[i] = aim;
    float secs = last_[i] < 0.0 ? w.fireInterval : (float)std::clamp(now - last_[i], 0.0, (double)kMaxSpraySeconds);
    if (secs <= 0.f) secs = w.fireInterval;
    last_[i] = now;
    // fuel: one unit per fireInterval of spray time
    fuelAcc_[i] += secs / std::max(1e-3f, w.fireInterval);
    while (fuelAcc_[i] >= 1.f && P.mag[i] > 0) { fuelAcc_[i] -= 1.f; --P.mag[i]; ++fuelUsed_; }
    ++P.rounds[i];
    ++sprays_;
    FlameCone c;
    c.origin = origin; c.dir = d; c.range = w.range; c.coneDeg = F.coneDeg; c.seconds = secs; c.shooterPacked = P.idOf(i).packed();
    if (ctx.gas) ctx.gas->queueFlame(c);
    if (ctx.horde) {   // zombies in the cone: 15 rays through the bullet-hit path (first zombie per ray, credited)
        std::vector<HitRequest> hits;
        coneRays(c, F.zombieDps, (uint32_t)sprays_, hits);
        ctx.horde->queueHits(hits);
    }
    if (ctx.events) {
        // the jet arcs over a low obstacle (car, low wall) between the nozzle and the pile: FX direction lifted, the
        // cone (ignition, zombie rays) stays on the aim point
        V3 fd = d;
        if (arcUp > 0.f) fd = normalize(d + V3{0, std::tan(std::min(arcUp, 0.6f)) * std::sqrt(d.x * d.x + d.z * d.z), 0});
        ctx.events->fx.push_back(FxEvent{FxKind::Flame, P.idOf(i), origin, fd});
        if (now - noiseAt_[i] > 1.0) {   // loud, but one noise source per second per flamethrower
            noiseAt_[i] = now;
            NoiseEvent n;
            n.pos = P.pos[i]; n.intensity = w.noise; n.radius = w.noiseRadius;
            ctx.events->noise.push_back(n);
            noise_.push_back(n);
        }
    }
    return true;
}

void FlameAI::coneRays(const FlameCone& c, float zombieDps, uint32_t pattern, std::vector<HitRequest>& out) {
    const V3 d = c.dir;
    const V3 t = std::fabs(d.y) < 0.99f ? normalize(cross(d, V3{0, 1, 0})) : V3{1, 0, 0};
    const V3 b = cross(d, t);
    auto ray = [&](float ang, float phi) {
        const float ca = std::cos(ang), sa = std::sin(ang);
        HitRequest h;
        h.origin = c.origin; h.dir = normalize(d * ca + t * (sa * std::cos(phi)) + b * (sa * std::sin(phi)));
        h.maxDist = c.range; h.damage = zombieDps * c.seconds; h.shooterPacked = c.shooterPacked; h.flags = 2u;   // quiet: small puff
        out.push_back(h);
    };
    const float A = c.coneDeg * 3.14159265f / 180.f;
    const float rot = (float)(pattern % 7u) * 0.9f;   // the pattern rotates between sprays: no blind lanes
    ray(0.f, 0.f);
    for (int k = 0; k < 6; ++k) ray(A * 0.5f, rot + (float)k * 1.0472f);
    for (int k = 0; k < 8; ++k) ray(A * 0.95f, rot + 0.39f + (float)k * 0.7854f);
}

bool FlameAI::burning(SquadId s) const { return s.index < mem_.size() && mem_[s.index].gen == s.gen && mem_[s.index].phase > 0; }

void FlameAI::order(GameContext& ctx, Squad& s, Mem& m, V3 dest, float facing) {
    s.order.active = true;
    s.order.dest = dest;
    s.order.facing = facing;
    s.order.run = false;
    s.order.walk = false;
    ++s.order.serial;
    m.ownSerial = s.order.serial;
    (void)ctx;
}

void FlameAI::tick(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.squads || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const FlameConfig& F = cfg.flame;
    const WeaponStats& w = cfg.weapon[(size_t)SoldierClass::Flamethrower];
    ensure(ctx);
    if (mem_.size() < ctx.squads->squads.size()) mem_.resize(ctx.squads->squads.size());
    // zombie bursts (owner 14e: "they insta-spray and then stop"): a burst started at zombies keeps going for
    // kZombieBurst s after the target fell (or the engagement ended), sweeping over where it was: the zombies around
    // it and bodies there keep getting the flame. Engaging soldiers with a live target are Combat's.
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i) || P.cls[i] != SoldierClass::Flamethrower || P.mag[i] <= 0) continue;
        const SoldierState st = P.state[i];
        if (!(st == SoldierState::Idle || (st == SoldierState::Engaging && !P.target[i].active))) continue;
        if (ctx.time - last_[i] > 0.5 || ctx.time - burstStart_[i] > kZombieBurst || ctx.time - last_[i] < w.fireInterval - 1e-4) continue;
        if (st == SoldierState::Idle && ctx.squads) {   // not when the squad is on a pile (its own bursts below)
            const Squad* sq = ctx.squads->get(P.squad[i]);
            if (sq && burning(sq->id)) continue;
        }
        const V3 side{std::cos(P.yaw[i]), 0, -std::sin(P.yaw[i])};
        spray(ctx, i, lastAim_[i] + side * (std::sin((float)ctx.time * 3.1f + (float)i) * 0.25f));
    }
    for (size_t si = 0; si < ctx.squads->squads.size(); ++si) {
        Squad& s = ctx.squads->squads[si];
        if (s.type != SquadType::Flamethrower) continue;
        Mem& m = mem_[si];
        if (m.gen != s.id.gen) { m = Mem{}; m.gen = s.id.gen; m.seenSerial = s.order.serial; }
        if (s.deploying) continue;
        V3 c{};
        int alive = 0;
        bool anyBusy = false;
        for (const SoldierId& id : s.members)
            if (P.valid(id) && P.alive(id.index)) { c = c + P.pos[id.index]; ++alive; anyBusy |= busy(P.state[id.index]); }
        if (!alive) continue;
        c = c * (1.f / (float)alive);
        if (!m.hasPost) { m.hasPost = true; m.post = s.hasAnchor ? s.anchor : c; }
        m.seekT -= ctx.dt;
        m.phaseT += ctx.dt;
        // a new player order: new post; an order onto corpses = burn them there
        if (s.order.serial != m.ownSerial && s.order.serial != m.seenSerial) {
            m.seenSerial = s.order.serial;
            m.post = s.order.dest;
            m.phase = 0;
            V3 pile;
            if (ctx.gas && ctx.gas->findPile(s.order.dest, 6.f, 1, 1e9f, pile)) {
                V3 dir{pile.x - c.x, 0, pile.z - c.z};
                const float l = std::sqrt(dir.x * dir.x + dir.z * dir.z);
                dir = l > 0.5f ? dir * (1.f / l) : V3{0, 0, 1};
                V3 stand = pile - dir * F.standoff, sw;
                float face = std::atan2(dir.x, dir.z);
                if (!pickStand(ctx, pile, c, F.standoff, stand, face))
                    if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
                m.target = pile; m.phase = 1; m.phaseT = 0.f;
                order(ctx, s, m, stand, face);
                ++trips_;
            }
        }
        if (!ctx.gas || !ctx.gas->ready()) continue;
        // idle: look for a pile / gas source within the leash of the post
        if (m.phase == 0 && m.seekT <= 0.f && !anyBusy && !(s.flags & SQ_UNDER_ATTACK)) {
            m.seekT = F.seekInterval;
            V3 pile;
            if (ctx.gas->findPile(m.post, F.seekRadius, F.seekMinCorpses, cfg.rot.warnLevel, pile)) {
                V3 dir{pile.x - c.x, 0, pile.z - c.z};
                const float l = std::sqrt(dir.x * dir.x + dir.z * dir.z);
                dir = l > 0.5f ? dir * (1.f / l) : V3{0, 0, 1};
                V3 stand = pile - dir * F.standoff, sw;
                float face = std::atan2(dir.x, dir.z);
                const bool picked = pickStand(ctx, pile, c, F.standoff, stand, face);
                if (!picked && ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
                m.target = pile; m.phase = 1; m.phaseT = 0.f;
                if (std::sqrt(dist2(c, pile)) > F.standoff + 2.f || (picked && std::sqrt(dist2(c, stand)) > 2.f)) order(ctx, s, m, stand, face);
                ++trips_;
            }
        }
        if (m.phase == 0) continue;
        // approach / spray: members standing (not fighting) within range spray the pile, sweeping across it
        const float reach = w.range * 0.92f;
        // fuel economy: once every body at the pile is alight, stop spraying and let it burn (re-light if one is left)
        const bool unlit = ctx.gas->corpsesNear(m.target, 2.3f, true) > 0;
        const int leftNow = ctx.gas->corpsesNear(m.target, 2.3f);
        bool anySpray = false, arrived = true, anyBlocked = false;
        for (const SoldierId& id : s.members) {
            if (!P.valid(id) || !P.alive(id.index)) continue;
            const uint32_t i = id.index;
            const SoldierState st = P.state[i];
            if (st == SoldierState::Moving || st == SoldierState::Forming) arrived = false;
            if (st != SoldierState::Idle) continue;   // moving / fighting / reloading members are the AI's
            const V3 tgt = m.target;
            if (dist2(P.pos[i], tgt) > reach * reach || P.mag[i] <= 0) continue;
            const float gy = groundNear(ctx.nav, tgt);   // the street under the pile, not a car roof / wall top next to it
            if (std::fabs(P.pos[i].y - gy) > 2.5f) continue;   // roof vs street
            m.phase = 2;
            // sustained bursts (owner 14e): kBurstMin..kBurstMax s while bodies there are unlit (or the pile no longer
            // burns), sweeping across and along the pile; then a short pause to let it burn, then look again
            const double now = ctx.time;
            const bool inBurst = now - last_[i] < 0.6;
            const float el = (float)(now - burstStart_[i]);
            const float burstLen = kBurstMin + (kBurstMax - kBurstMin) * (float)((i * 2654435761u) >> 24) / 255.f;
            const bool burnsAlready = ctx.gas->at(tgt.x, tgt.z).fire > 0.5f;
            bool needFire;
            if (inBurst) {
                needFire = el < burstLen || (unlit && el < kBurstMax);
                if (!needFire) pauseUntil_[i] = now + kBurstPause;
            } else needFire = now >= pauseUntil_[i] && (unlit || (leftNow > 0 && !burnsAlready));
            const float sweep = std::sin((float)ctx.time * 1.7f + (float)i) * 1.3f, depth = std::sin((float)ctx.time * 0.9f + 1.3f * (float)i) * 0.7f;
            const V3 side{std::cos(P.yaw[i]), 0, -std::sin(P.yaw[i])}, fwd{std::sin(P.yaw[i]), 0, std::cos(P.yaw[i])};
            const V3 aim = V3{tgt.x, gy + 0.35f, tgt.z} + side * sweep + fwd * depth;
            // a car / low wall between the nozzle and the pile: arc the jet over it (FX), the cone still lights the pile
            float at, arc = 0.f;
            const V3 nozzle = P.firePos(i) + V3{0, kMuzzleHeight, 0};
            const float top = obstacleTop(ctx.nav, nozzle, aim, 0.9f, at);
            if (top > gy + 0.4f && at > 0.3f) {
                const float dAim = std::sqrt(dist2(nozzle, aim));
                arc = std::max(0.f, std::atan2(top + 0.3f - nozzle.y, at) - std::atan2(aim.y - nozzle.y, dAim));
            }
            const float want = std::atan2(tgt.x - P.pos[i].x, tgt.z - P.pos[i].z);
            P.yaw[i] = SoldierAnimator::turnToward(P.yaw[i], want, 7.f * ctx.dt);
            P.vel[i] = {};
            if (ctx.animator) {   // approved flamer clips: ignite -> burn_ground (sweep at the pile) -> stop
                const bool was = burnAnim_[i] != 0;
                if (needFire && !was) ctx.animator->request(P.anim[i], AnimAction::FlameIgnite);
                else if (!needFire && was) ctx.animator->request(P.anim[i], AnimAction::FlameStop);
                else ctx.animator->request(P.anim[i], needFire ? AnimAction::BurnGround : AnimAction::Aim);
                burnAnim_[i] = needFire ? 1 : 0;
            }
            float err = std::remainder(want - P.yaw[i], 6.2831853f);
            if (!needFire) { anySpray = true; continue; }   // burning: hold, facing the pile
            if (std::fabs(err) < 0.35f && (last_[i] < 0.0 || ctx.time - last_[i] >= w.fireInterval - 1e-4)) {
                const uint64_t b0 = blocked_;
                anySpray |= spray(ctx, i, aim, arc);
                anyBlocked |= blocked_ != b0;
            } else anySpray = true;
        }
        // friendly soldiers in the way for a while: walk round the pile to another side (100 deg further)
        m.blockedT = anyBlocked && !anySpray ? m.blockedT + ctx.dt : 0.f;
        if (m.blockedT > 2.5f) {
            m.blockedT = 0.f;
            const float a0 = std::atan2(c.x - m.target.x, c.z - m.target.z) + 1.75f;
            V3 stand = m.target + V3{std::sin(a0), 0, std::cos(a0)} * F.standoff, sw;
            if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
            order(ctx, s, m, stand, a0 + 3.14159265f);
            ++repositions_;
        }
        // done: no corpse left at the pile (readback), or timeouts; back to the post when it went on a trip
        const int left = ctx.gas->corpsesNear(m.target, 2.3f);
        const GasCell gc = ctx.gas->at(m.target.x, m.target.z);
        const bool done = (m.phase == 2 && left == 0 && gc.fire <= 0.f) || (m.phase == 2 && m.phaseT > kBurnTimeout + kApproachTimeout) ||
                          (m.phase == 1 && m.phaseT > kApproachTimeout) || (m.phase == 1 && arrived && !anySpray && m.phaseT > 4.f && left == 0);
        if (m.phase == 1 && arrived && !anySpray && m.phaseT > 6.f && left > 0) {   // arrived but out of reach: step closer
            V3 dir{m.target.x - c.x, 0, m.target.z - c.z};
            const float l = std::sqrt(dir.x * dir.x + dir.z * dir.z);
            if (l > reach * 0.8f && l > 0.5f) {
                dir = dir * (1.f / l);
                V3 stand = m.target - dir * (reach * 0.6f), sw;
                if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
                order(ctx, s, m, stand, std::atan2(dir.x, dir.z));
                m.phaseT = 0.f;
            }
        }
        if (done) {
            m.phase = 0;
            m.seekT = F.seekInterval;
            if (std::sqrt(dist2(c, m.post)) > 4.f && s.order.serial == m.ownSerial) {   // our trip: return to the post
                V3 dir{m.post.x - c.x, 0, m.post.z - c.z};
                order(ctx, s, m, m.post, std::atan2(dir.x, dir.z));
            }
        }
    }
}

} // namespace ttz::game
