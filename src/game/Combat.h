#pragma once
// Combat logic (WS-C) on the CPU side of the horde interface.
//
//   fire     : for soldiers whose AI state is Engaging with an acquired lock, keep the fire clip requested; every
//              `muzzle_flash` / `suppressed` clip event of that soldier = one round: magazine - 1, accuracy roll ->
//              spread direction (deterministic per-soldier stream), ShotEvent + NoiseEvent + FxEvent; the round
//              becomes a HitRequest (HordeInterface::queueHits). Empty magazine -> AI reloads.
//   reload   : `mag_in` event moves min(magazine - mag, reserve) rounds.
//   damage   : SoldierContact from the horde (attackers * damagePerSecond * dt) -> health; the first contact of an
//              engagement requests the Hit reaction (once per cooldown); health <= 0 -> Dying.
//   kills    : KillEvents from the horde -> Economy::creditKill (Economy dedupes by seq again: defence in depth).
//   attract  : each tick, horde attractors = alive soldiers on the ground (+ recent noise events, aged).
#include "game/GameContext.h"
#include "game/HordeInterface.h"

namespace ttz::game {

class Combat {
public:
    void tick(GameContext& ctx);               // after SoldierAI and SoldierAnimator::tick (events of this tick)
    // Helpers exposed for tests.
    static V3 spreadDir(V3 dir, float spreadDeg, uint32_t& rng);
    uint64_t roundsFired() const { return roundsFired_; }
private:
    std::vector<HitRequest> hits_;
    std::vector<HordeSoldier> upload_;
    std::vector<Attractor> attractors_;
    struct Noise { NoiseEvent e; float age = 0.f; };
    std::vector<Noise> noise_;
    uint64_t roundsFired_ = 0;
};

} // namespace ttz::game
