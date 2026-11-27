// Flamethrower squad behaviour (GAME_DESIGN 14d). See FlameAI.h.
#include "game/FlameAI.h"

#include "game/Config.h"
#include "game/Deploy.h"
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
} // namespace

void FlameAI::usePlaceholderAssets(DeployTiming& t) {
    const size_t f = (size_t)SoldierClass::Flamethrower, r = (size_t)SoldierClass::Rifleman;
    if (t.variants[f].empty()) t.variants[f] = t.variants[r];   // swap hook: approved flamethrower variants replace these
    t.descentSpeed[f] = t.descentSpeed[r];
    t.landDuration[f] = t.landDuration[r];
    t.recoverDuration[f] = t.recoverDuration[r];
}

void FlameAI::ensure(const GameContext& ctx) {
    const size_t n = ctx.soldiers->capacity();
    if (last_.size() < n) { last_.resize(n, -1.0); fuelAcc_.resize(n, 0.f); lastGen_.resize(n, ~0u); noiseAt_.resize(n, -1e9); }
    for (size_t i = 0; i < n; ++i)
        if (lastGen_[i] != ctx.soldiers->gen[i]) { lastGen_[i] = ctx.soldiers->gen[i]; last_[i] = -1.0; fuelAcc_[i] = 0.f; noiseAt_[i] = -1e9; }
}

bool FlameAI::spray(GameContext& ctx, uint32_t i, V3 aim) {
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
    if (ctx.events) {
        ctx.events->fx.push_back(FxEvent{FxKind::Flame, P.idOf(i), origin, d});
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
                if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
                m.target = pile; m.phase = 1; m.phaseT = 0.f;
                order(ctx, s, m, stand, std::atan2(dir.x, dir.z));
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
                if (ctx.nav && ctx.nav->ready() && ctx.nav->nearestWalkable(stand, 3.f, sw)) stand = sw;
                m.target = pile; m.phase = 1; m.phaseT = 0.f;
                if (std::sqrt(dist2(c, pile)) > F.standoff + 2.f) order(ctx, s, m, stand, std::atan2(dir.x, dir.z));
                ++trips_;
            }
        }
        if (m.phase == 0) continue;
        // approach / spray: members standing (not fighting) within range spray the pile, sweeping across it
        const float reach = w.range * 0.92f;
        bool anySpray = false, arrived = true;
        for (const SoldierId& id : s.members) {
            if (!P.valid(id) || !P.alive(id.index)) continue;
            const uint32_t i = id.index;
            const SoldierState st = P.state[i];
            if (st == SoldierState::Moving || st == SoldierState::Forming) arrived = false;
            if (st != SoldierState::Idle) continue;   // moving / fighting / reloading members are the AI's
            const V3 tgt = m.target;
            if (dist2(P.pos[i], tgt) > reach * reach || P.mag[i] <= 0) continue;
            if (std::fabs(P.pos[i].y - (ctx.nav && ctx.nav->ready() ? ctx.nav->surface(tgt.x, tgt.z) : P.pos[i].y)) > 2.5f) continue;   // roof vs street
            m.phase = 2;
            const float sweep = std::sin((float)ctx.time * 2.3f + (float)i) * 1.0f;
            const V3 side{std::cos(P.yaw[i]), 0, -std::sin(P.yaw[i])};
            const float gy = ctx.nav && ctx.nav->ready() ? ctx.nav->surface(tgt.x, tgt.z) : tgt.y;
            const V3 aim = V3{tgt.x, gy + 0.35f, tgt.z} + side * sweep;
            const float want = std::atan2(tgt.x - P.pos[i].x, tgt.z - P.pos[i].z);
            P.yaw[i] = SoldierAnimator::turnToward(P.yaw[i], want, 7.f * ctx.dt);
            P.vel[i] = {};
            if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::Fire);
            float err = std::remainder(want - P.yaw[i], 6.2831853f);
            if (std::fabs(err) < 0.35f && (last_[i] < 0.0 || ctx.time - last_[i] >= w.fireInterval - 1e-4)) anySpray |= spray(ctx, i, aim);
            else anySpray = true;
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
