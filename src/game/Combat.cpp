// Combat logic (WS-C): rounds from clip events (with a watchdog fallback), reload / grab transfers, contact damage,
// hit requests, noise, horde uploads and attractors. See Combat.h.
#include "game/Combat.h"

#include "game/Config.h"
#include "game/FlameAI.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

V3 Combat::spreadDir(V3 dir, float spreadDeg, uint32_t& rng) {
    const float a = spreadDeg * 3.14159265f / 180.f;
    const float u = rand01(rng), v = rand01(rng);
    const float cosT = 1.f - u * (1.f - std::cos(a)), sinT = std::sqrt(std::max(0.f, 1.f - cosT * cosT)), phi = v * 6.2831853f;
    V3 d = normalize(dir);
    V3 t = std::fabs(d.y) < 0.99f ? normalize(cross(d, V3{0, 1, 0})) : V3{1, 0, 0};
    V3 b = cross(d, t);
    return normalize(d * cosT + t * (sinT * std::cos(phi)) + b * (sinT * std::sin(phi)));
}

void Combat::fire(GameContext& ctx, uint32_t i, bool synthetic) {
    SoldierPool& P = *ctx.soldiers;
    if (P.cls[i] == SoldierClass::Flamethrower && ctx.flame) {   // GAME_DESIGN 14d: a flame cone, not a hit ray (FlameAI.h)
        if (ctx.flame->spray(ctx, i, P.target[i].pos + P.target[i].vel * aimLead + V3{0, 0.8f, 0})) ++roundsFired_;
        return;
    }
    const WeaponStats& w = ctx.cfg->weapon[(int)P.cls[i]];
    --P.mag[i];
    ++P.rounds[i];
    ++roundsFired_;
    if (synthetic) ++syntheticRounds_;
    const V3 fw{std::sin(P.yaw[i]), 0, std::cos(P.yaw[i])};
    V3 origin = P.pos[i] + V3{0, muzzleHeight, 0} + fw * 0.5f;
    const bool posted = P.post[i] == POST_FIRING;   // B3a window / roof-edge position: rounds leave past the facade
    if (posted) origin = P.firePos(i) + V3{0, muzzleHeight, 0};
    // Firing over cover: a wall / container / low obstacle right in front (within coverReach, at most coverMaxHeight
    // above the feet) does not stop the soldier's own rounds. The round starts just past it, above its top (the
    // soldier leans / raises the weapon over it); the hit ray then ignores that obstacle (GPU stops rays at static cells).
    if (ctx.nav && ctx.nav->ready() && !posted) {
        const V3 tgt = P.target[i].active ? P.target[i].pos : P.pos[i] + fw * 10.f;
        V3 d{tgt.x - P.pos[i].x, 0, tgt.z - P.pos[i].z};
        const float l = std::sqrt(d.x * d.x + d.z * d.z);
        if (l > 1.f) {
            d = d * (1.f / l);
            const float base = P.pos[i].y;
            float top = -1e9f, end = 0.f;
            for (float s = 0.25f; s <= coverReach; s += 0.25f) {
                const float h = ctx.nav->shotHeight(P.pos[i].x + d.x * s, P.pos[i].z + d.z * s);   // gates included
                if (h > base + 0.4f) { top = std::max(top, h); end = s; }
            }
            if (top > base + 0.4f && top - base <= coverMaxHeight) {
                origin = V3{P.pos[i].x + d.x * (end + 0.45f), std::max(origin.y, top + 0.3f), P.pos[i].z + d.z * (end + 0.45f)};
                ++overCover_;
            }
        }
    }
    // exact locks: lead the zombie along its velocity (readback latency + flight time); field locks: the sample point
    float aimH = aimHeight + (0.25f - aimHeight) * std::clamp(P.target[i].prone, 0.f, 1.f);   // crawlers: aim low
    if (P.target[i].aimY >= 0.f) aimH = P.target[i].aimY;   // SoldierAI's clear firing line (head over a car roof)
    const V3 aim = P.target[i].pos + P.target[i].vel * aimLead + V3{0, aimH, 0};
    // Accuracy: cone = spreadDeg / accuracy (accuracy 1 -> spreadDeg), wider while wounded.
    const float cone = w.spreadDeg / std::max(0.1f, w.accuracy) * (P.wounded[i] ? 1.5f : 1.f);
    const V3 dir = spreadDir(aim - origin, cone, P.rng[i]);
    const bool head = rand01(P.rng[i]) < w.headshotChance;
    const bool quiet = P.cls[i] == SoldierClass::Sniper;   // suppressed rifle
    HitRequest h;
    h.origin = origin; h.dir = dir; h.maxDist = w.range; h.damage = w.damage;
    h.shooterPacked = P.idOf(i).packed();
    h.flags = (head ? 1u : 0u) | (quiet ? 2u : 0u);
    if (hits_.size() < kMaxHitsPerTick) hits_.push_back(h);
    if (ctx.events) {
        ShotEvent s;
        s.shooter = P.idOf(i); s.cls = P.cls[i]; s.origin = origin; s.dir = dir; s.maxDist = w.range; s.damage = w.damage; s.headshot = head;
        ctx.events->shots.push_back(s);
        NoiseEvent n;
        n.pos = P.pos[i]; n.intensity = w.noise; n.radius = w.noiseRadius;
        ctx.events->noise.push_back(n);
        ctx.events->fx.push_back(FxEvent{FxKind::Shot, P.idOf(i), origin, dir});
    }
    // Aged noise list -> attractors (merged per spot so a firing MG is one loud source, not 12 per second).
    Noise* m = nullptr;
    for (Noise& o : noise_)
        if (std::fabs(o.e.pos.x - P.pos[i].x) < noiseMergeRadius && std::fabs(o.e.pos.z - P.pos[i].z) < noiseMergeRadius) { m = &o; break; }
    if (m) { m->age = 0.f; m->e.intensity = std::max(m->e.intensity, w.noise); m->e.radius = std::max(m->e.radius, w.noiseRadius); }
    else if (noise_.size() < 128) { Noise n; n.e.pos = P.pos[i]; n.e.intensity = w.noise; n.e.radius = w.noiseRadius; noise_.push_back(n); }
}

void Combat::reload(GameContext& ctx, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    const int cap = ctx.cfg->weapon[(int)P.cls[i]].magazine;
    const int n = std::max(0, std::min(cap - P.mag[i], P.reserve[i]));
    P.mag[i] += n; P.reserve[i] -= n;
    P.phase[i] |= PH_RELOADED;
    ++reloads_;
}

void Combat::grab(GameContext& ctx, SupplyAccess& sup, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    P.phase[i] |= PH_GRABBED;
    if (P.deliverTo[i].valid()) {   // ammo runner hand-over: carried rounds -> the squad mate's reserve (conserved)
        const SoldierId m = P.deliverTo[i];
        if (P.valid(m) && P.alive(m.index)) {
            const int need = std::max(0, P.fullLoad(m.index, *ctx.cfg) - P.mag[m.index] - P.reserve[m.index]);
            const int n = std::min(need, P.carry[i]);
            P.carry[i] -= n; P.reserve[m.index] += n;
            handedOver_ += (uint64_t)n;
        }
        return;
    }
    if (!P.supply[i].valid()) return;
    const int missing = std::max(0, P.fullLoad(i, *ctx.cfg) - P.mag[i] - P.reserve[i]);
    int extra = 0;
    if (P.runner[i]) {   // the runner carries what his squad mates miss, at most runnerCarryMagazines magazines
        int mates = 0;
        if (ctx.squads)
            if (const Squad* s = ctx.squads->get(P.squad[i]))
                for (const SoldierId& m : s->members)
                    if (m.index != i && P.valid(m) && P.alive(m.index) && P.cls[m.index] == P.cls[i])
                        mates += std::max(0, P.fullLoad(m.index, *ctx.cfg) - P.mag[m.index] - P.reserve[m.index]);
        extra = std::max(0, std::min(ctx.cfg->logistics.runnerCarryMagazines * ctx.cfg->weapon[(int)P.cls[i]].magazine, mates) - P.carry[i]);
    }
    const int n = missing + extra > 0 ? sup.collect(P.supply[i], ammoOf(P.cls[i]), missing + extra) : 0;
    const int own = std::min(n, missing);
    P.reserve[i] += own;
    P.carry[i] += n - own;   // the runner's load for his squad mates
    collected_ += (uint64_t)n;
}

void Combat::tick(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const float dt = ctx.dt;
    logisticsSupply_.lg = ctx.logistics;
    SupplyAccess& sup = supply ? *supply : logisticsSupply_;
    const bool realEvents = ctx.animator && !forceSyntheticEvents;
    hits_.clear();

    // ---- zombie contact damage -> health, hit reaction (once per cooldown), death
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) { P.contactAge[i] += dt; P.hitCooldown[i] -= dt; }
    if (ctx.horde)
        for (const SoldierContact& c : ctx.horde->contacts()) {
            const uint32_t i = c.packedId & 0xFFFFu;
            if (i >= P.capacity() || !P.used[i] || (P.gen[i] & 0xFFFFu) != (c.packedId >> 16) || !P.alive(i) || c.attackers == 0) continue;
            if (P.state[i] == SoldierState::Descending) continue;
            const float dmg = (float)c.attackers * cfg.threat.damagePerSecond * dt;
            P.health[i] -= dmg;
            damageTaken_ += dmg;
            const bool fresh = P.contactAge[i] > 1.f;
            P.contactAge[i] = 0.f;
            if (P.health[i] <= 0.f) continue;   // SoldierAI turns it into Dying this tick or the next
            const SoldierState s = P.state[i];
            const bool interruptible = s == SoldierState::Idle || s == SoldierState::Engaging || s == SoldierState::Moving ||
                                       s == SoldierState::Forming || s == SoldierState::Resupplying;
            if (fresh && interruptible && P.hitCooldown[i] <= 0.f) {
                if (s == SoldierState::Moving || s == SoldierState::Forming || s == SoldierState::Resupplying) P.resume[i] = s;
                P.vel[i] = {};
                P.setState(i, SoldierState::Hit);
                P.hitCooldown[i] = hitCooldown;
            }
        }
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i)
        if (P.used[i] && P.health[i] <= 0.f && P.alive(i) && P.state[i] != SoldierState::Descending) {
            if (P.supply[i].valid()) { sup.release(P.supply[i], P.idOf(i)); P.supply[i] = SupplyId{}; }
            P.target[i] = TargetLock{};
            P.setState(i, SoldierState::Dying);
        }

    auto canFire = [&](uint32_t i) {
        return P.alive(i) && P.state[i] == SoldierState::Engaging && (P.phase[i] & PH_ACQUIRED) && P.target[i].active && P.mag[i] > 0;
    };
    // ---- clip events of this tick (fire / reload / collect sync)
    if (ctx.animEvents)
        for (const AnimEvent& e : *ctx.animEvents) {
            const uint32_t i = e.soldier;
            if (i >= P.capacity() || !P.used[i]) continue;
            const WeaponStats& w = cfg.weapon[(int)P.cls[i]];
            if (e.type == "muzzle_flash") {   // sniper clips also carry `suppressed` at the same time: one round
                if (canFire(i)) { fire(ctx, i, false); P.fireCooldown[i] = w.fireInterval * 2.5f + 0.25f; }
            } else if (e.type == "mag_in") {
                if (P.state[i] == SoldierState::Reloading && !(P.phase[i] & PH_RELOADED)) reload(ctx, i);
            } else if (e.type == "grab") {    // MG reload also has a `grab`: only while Collecting
                if (P.state[i] == SoldierState::Collecting && !(P.phase[i] & PH_GRABBED)) grab(ctx, sup, i);
            }
        }
    // ---- watchdog / synthetic clock
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i)) continue;
        const WeaponStats& w = cfg.weapon[(int)P.cls[i]];
        const SoldierState s = P.state[i];
        if (canFire(i)) {
            if (P.fireCooldown[i] < 0.f) P.fireCooldown[i] = realEvents ? w.fireInterval * 2.5f + 0.25f : 0.f;   // just acquired
            P.fireCooldown[i] -= dt;
            if (P.fireCooldown[i] <= 0.f) { fire(ctx, i, true); P.fireCooldown[i] += std::max(w.fireInterval, 1e-3f); }
        } else if (s == SoldierState::Reloading && !(P.phase[i] & PH_RELOADED)) {
            if (P.stateTime[i] >= (realEvents ? w.reloadTime * 1.5f + 0.5f : w.reloadTime * 0.62f)) reload(ctx, i);
        } else if (s == SoldierState::Collecting && !(P.phase[i] & PH_GRABBED)) {
            if (P.stateTime[i] >= (realEvents ? collectTime * 1.5f : collectTime * 0.39f)) grab(ctx, sup, i);
        }
    }
    if (ctx.events)
        for (const KillEvent& k : ctx.events->kills) kills_ += k.cause == KillCause::Soldier ? 1u : 0u;

    // ---- horde inputs: soldier capsules, rounds, attractors (squads + aged noise)
    if (!ctx.horde) return;
    upload_.clear();
    for (uint32_t i = 0; i < (uint32_t)P.capacity() && upload_.size() < kMaxGpuSoldiers; ++i) {
        if (!P.used[i] || !P.alive(i) || P.state[i] == SoldierState::Descending) continue;   // under canopy: invisible
        if (P.post[i] == POST_INSIDE) continue;   // B3a: hospital patients are inside (PROPOSED: not a zombie target)
        HordeSoldier h;
        h.pos = P.pos[i]; h.packedId = P.idOf(i).packed(); h.attraction = cfg.threat.soldierAttraction;
        upload_.push_back(h);
    }
    ctx.horde->uploadSoldiers(upload_);
    ctx.horde->queueHits(hits_);
    attractors_.clear();
    if (ctx.squads)
        for (const Squad& s : ctx.squads->squads) {
            V3 c{};
            int n = 0;
            for (const SoldierId& m : s.members)
                if (P.valid(m) && P.alive(m.index) && P.state[m.index] != SoldierState::Descending) { c = c + P.pos[m.index]; ++n; }
            if (!n || attractors_.size() >= maxAttractors) continue;
            c = c * (1.f / n);
            float r = 2.f;
            for (const SoldierId& m : s.members)
                if (P.valid(m) && P.alive(m.index)) r = std::max(r, std::sqrt((P.pos[m.index].x - c.x) * (P.pos[m.index].x - c.x) + (P.pos[m.index].z - c.z) * (P.pos[m.index].z - c.z)) + 1.f);
            attractors_.push_back({c, cfg.threat.soldierAttraction, std::min(r, 8.f), 0.f});   // awareness: bridge default
        }
    for (size_t k = 0; k < noise_.size();) {
        noise_[k].age += dt;
        if (noise_[k].age > noise_[k].e.duration) { noise_[k] = noise_.back(); noise_.pop_back(); continue; }
        ++k;
    }
    std::sort(noise_.begin(), noise_.end(), [](const Noise& a, const Noise& b) {
        const float sa = a.e.intensity * (1.f - a.age / a.e.duration), sb = b.e.intensity * (1.f - b.age / b.e.duration);
        return sa != sb ? sa > sb : (a.e.pos.x != b.e.pos.x ? a.e.pos.x < b.e.pos.x : a.e.pos.z < b.e.pos.z);
    });
    for (const Noise& n : noise_) {
        if (attractors_.size() >= maxAttractors) break;
        // reach = awareness x strength = noise radius, fading with age (GAME_DESIGN 8: spatial noise)
        const float st = std::max(0.01f, n.e.intensity * (1.f - n.age / n.e.duration));
        attractors_.push_back({n.e.pos, st, 2.f, n.e.radius * (1.f - n.age / n.e.duration) / st});
    }
    ctx.horde->setAttractors(attractors_);
}

} // namespace ttz::game
