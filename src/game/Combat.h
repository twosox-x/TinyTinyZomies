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
#include "game/SupplyAccess.h"

namespace ttz::game {

// Event sync and its fallback: rounds, magazine refills and supply grabs happen on the animator's clip events
// (`muzzle_flash`, `mag_in`, `grab`). Without an animator (ctx.animator == nullptr: headless tests) or when the clip
// never reports the event (missing clip, stub animator), a watchdog produces the same effect from the weapon stats
// so gameplay never stalls: rounds every fireInterval, mag_in at 62 % of reloadTime, grab at 39 % of collectTime.
// The watchdog waits 2.5 x fireInterval (+0.25 s) / 1.5 x reloadTime when an animator is present, so real events
// always win and nothing is counted twice (PH_RELOADED / PH_GRABBED make each transfer once per clip).
class Combat {
public:
    SupplyAccess* supply = nullptr;            // null: ctx.logistics (LogisticsSupply); tests: FakeSupply
    bool forceSyntheticEvents = false;         // ignore the animator's events (debug)
    float hitCooldown = 3.f;                   // s between hit reactions of one soldier (no constant interruptions)
    float collectTime = 3.2f;                  // s, collect_ammo clip (grab at 1.25 s)
    float muzzleHeight = 1.4f, aimHeight = 1.1f;
    float aimLead = 0.12f;
    float coverReach = 1.5f, coverMaxHeight = 2.8f;   // m: walls / containers right in front are fired over
    uint64_t roundsOverCover() const { return overCover_; }           // s: lead along an exact lock's velocity (SoldierAI exact locks)
    float noiseMergeRadius = 8.f;
    uint32_t maxAttractors = kMaxAttractors;
    // GAME_DESIGN 14e: extra capsules uploaded after the soldiers (Structures: tower base proxies; ids with index 0xFFFF,
    // never a soldier): zombies collide with them and the horde reports their attackers (tower pressure damage).
    std::vector<HordeSoldier> extraCapsules;

    void tick(GameContext& ctx);               // after SoldierAI and SoldierAnimator::tick (events of this tick)
    // An external noise source (scripts / tests; later: explosions, vehicles): joins the aged noise list -> attractors.
    void addNoise(const NoiseEvent& e) { if (noise_.size() < 128) { Noise n; n.e = e; noise_.push_back(n); } }
    // Helpers exposed for tests.
    static V3 spreadDir(V3 dir, float spreadDeg, uint32_t& rng);
    uint64_t roundsFired() const { return roundsFired_; }
    uint64_t syntheticRounds() const { return syntheticRounds_; }
    uint64_t reloads() const { return reloads_; }
    uint64_t roundsCollected() const { return collected_; }
    uint64_t roundsHandedOver() const { return handedOver_; }   // ammo runner -> squad mates
    uint64_t soldierKills() const { return kills_; }
    double damageTaken() const { return damageTaken_; }
    const std::vector<Attractor>& attractors() const { return attractors_; }
private:
    LogisticsSupply logisticsSupply_;
    void fire(GameContext& ctx, uint32_t i, bool synthetic);
    void reload(GameContext& ctx, uint32_t i);
    void grab(GameContext& ctx, SupplyAccess& sup, uint32_t i);
    uint64_t overCover_ = 0;
    uint64_t syntheticRounds_ = 0, reloads_ = 0, collected_ = 0, kills_ = 0, handedOver_ = 0;
    double damageTaken_ = 0;
    std::vector<HitRequest> hits_;
    std::vector<HordeSoldier> upload_;
    std::vector<Attractor> attractors_;
    struct Noise { NoiseEvent e; float age = 0.f; };
    std::vector<Noise> noise_;
    uint64_t roundsFired_ = 0;
};

} // namespace ttz::game
