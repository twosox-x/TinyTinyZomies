// Dead soldiers rise again as tougher zombies (GAME_DESIGN 14c). See Reanimation.h.
#include "game/Reanimation.h"

#include "game/Config.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

void zombieSoldierLook(uint32_t seed, uint32_t& lookX, uint32_t& lookY) {
    // modules (zombie_parts.json): head 3 beanie (an olive cap reads as the helmet), torso 3 open jacket (cloth sleeves),
    // sleeves + hands, trousers; one torn sleeve and a little decay so it reads as a zombie at RTS distance
    uint32_t s = pcg(seed * 2654435761u + 0x5EED5u);
    const uint32_t torn = (s & 1u) ? 2u : 0u;
    const uint32_t m[10] = {3u, 3u, torn, torn ? 0u : 2u, 0u, 0u, 0u, 0u, 0u, 0u};
    s = pcg(s);
    const uint32_t tier = 1u, decay = 1u + (s & 1u);
    const uint32_t skin = (s >> 4) % 2u == 0u ? 1u : 7u;   // the greener skins
    const uint32_t top = 0u;      // ZP_TOPS[0]  olive jacket
    const uint32_t shirt = 1u, pants = 4u /* olive drab */, hair = 2u, tie = 2u /* green */, hat = 2u /* olive */, shoe = 2u /* black boots */;
    lookX = (m[0] << 8) | (m[1] << 11) | (m[2] << 14) | (m[3] << 17) | (m[4] << 20) | (m[5] << 23) | (m[6] << 26) | (m[7] << 29);
    lookY = m[8] | (m[9] << 3) | (tier << 6) | (decay << 8) | (skin << 10) | (top << 13) | (shirt << 17) | (pants << 19) | (hair << 22) |
            (tie << 25) | (hat << 27) | (shoe << 30);
}

uint64_t Reanimation::rising() const {
    uint64_t n = 0;
    for (const Body& b : bodies_) n += b.rise >= 0.f ? 1 : 0;
    return n;
}

void Reanimation::tick(GameContext& ctx, SoldierAnimator* animator) {
    if (!ctx.soldiers || !ctx.cfg) return;
    const ReanimationConfig& rc = ctx.cfg->reanimation;
    SoldierPool& P = *ctx.soldiers;
    if (!rc.enabled) return;
    // new bodies (Dead: the death clip has played and holds its last frame)
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || P.state[i] != SoldierState::Dead) continue;
        const SoldierId id = P.idOf(i);
        if (std::any_of(bodies_.begin(), bodies_.end(), [&](const Body& b) { return b.id == id; })) continue;
        Body b;
        b.id = id;
        uint32_t s = pcg(P.rng[i] ^ 0xDEADu);
        b.riseAt = rc.delayMin + rand01(s) * std::max(0.f, rc.delayMax - rc.delayMin);
        bodies_.push_back(b);
    }
    for (Body& b : bodies_) {
        if (!P.valid(b.id) || b.never) continue;
        const uint32_t i = b.id.index;
        b.t += ctx.dt;
        if (b.rise < 0.f) {
            if (b.t < b.riseAt) continue;
            // can the horde place a walker here? (open ground in the simulated window; roofs: B3)
            const V3 p = P.pos[i];
            bool ok = ctx.horde && ctx.horde->simulated(p.x, p.z);
            if (ok && ctx.nav && ctx.nav->ready()) {
                float g = p.y;
                for (int k = 0; k < 8; ++k) g = std::min(g, ctx.nav->surface(p.x + 6.f * std::cos(k * 0.785398f), p.z + 6.f * std::sin(k * 0.785398f)));
                ok = p.y - g < 1.0f;
            }
            if (!ok) { b.never = true; ++stayDead_; continue; }
            // the weapon stays where the death clip dropped it; the body gets up without it
            AnimPlayback& a = P.anim[i];
            DroppedWeapon w;
            w.infantry = P.infantry[i]; w.clip = a.clip; w.t = a.t; w.pos = P.pos[i]; w.yaw = P.yaw[i];
            weapons_.push_back(w);
            if (weapons_.size() > maxWeapons) weapons_.erase(weapons_.begin());
            P.unarmed[i] = 1;
            if (animator) {   // get-up: cross-fade from the held death pose to a standing pose (no get-up clip exists)
                const int deathClip = a.clip;
                const float deathT = a.t;
                animator->reset(a, P.infantry[i], AnimAction::Idle);
                if (deathClip >= 0 && a.clip >= 0 && a.clip != deathClip) {
                    a.prevClip = deathClip; a.prevT = deathT; a.blend = 0.f; a.blendDur = std::max(0.2f, rc.riseTime);
                }
            }
            b.rise = 0.f;
            continue;
        }
        b.rise += ctx.dt;
        if (b.rise < rc.riseTime) continue;
        uint32_t lx, ly;
        zombieSoldierLook(P.rng[i], lx, ly);
        if (ctx.horde && ctx.horde->spawnZombie(P.pos[i], P.yaw[i], std::max(0.1f, rc.healthMul), lx, ly)) {
            ++risen_;
            P.release(b.id);   // the soldier entity is gone: the zombie agent takes its place
        } else { b.never = true; ++stayDead_; }
    }
    bodies_.erase(std::remove_if(bodies_.begin(), bodies_.end(), [&](const Body& b) { return !P.valid(b.id); }), bodies_.end());
}

} // namespace ttz::game
