#pragma once
// Soldier behaviour (WS-C): one lightweight state machine per soldier, ticked at 30 Hz (GAME_DESIGN 3 / 14b).
//
// Priorities (highest first), evaluated per soldier per tick:
//   Dying / Dead          (health <= 0: death clip, weapon drop, body stays)
//   Deploy phases         (Descending .. Forming: owned by Deploy, AI only watches for weapon_draw / formation)
//   Hit                   (short reaction when contact damage starts; not re-triggered within a cooldown)
//   Reloading             (mag empty and reserve > 0; finishes unless dying)
//   Resupply              (total ammo below lowAmmoFraction and a reachable supply point with stock within the search
//                          radius; reserve a slot (Logistics), path there, Collecting until full or stock empty)
//   Move order            (squad order newer than the soldier's: follow the path to the formation slot; may fire at
//                          targets in range while moving only if `fireOnMove`; orders are never abandoned for a target)
//   Engage                (target lock in range with LOS: aim -> acquire -> fire; hold position)
//   Idle                  (scan; face the threat sector)
//
// Anti-oscillation rules (GAME_DESIGN 14b):
//   * target hysteresis: keep the locked point while a field sample stays within 2.5 m of it (re-associated each
//     field refresh); switch only when it is lost for > 0.6 s, or a zombie is within 4 m and the lock is > 10 m away
//   * no chasing: soldiers never path toward zombies; targets beyond range are ignored (no "distant zombie chase")
//   * state minimum dwell times (e.g. Engaging >= 0.8 s) before a lower-priority transition
//   * stuck detection: no progress for 3 s along a path -> re-request once, then hold and flag the squad
#include "game/GameContext.h"

namespace ttz::game {

struct AiTuning {                     // behaviour constants (not balance): kept here, not in balance.json
    float targetKeepRadius = 2.5f, targetLostTime = 0.6f, closeThreat = 4.f, closeSwitchMinDist = 10.f;
    float engageMinDwell = 0.8f, stuckTime = 3.f, arriveRadius = 0.6f, separation = 0.8f;
    bool fireOnMove = false;
};

class SoldierAI {
public:
    AiTuning tuning;
    // Per tick: perception (field, contacts), decisions, movement, animation requests.
    void tick(GameContext& ctx);
    // Formation slot of a member (world) for a squad order: line / wedge by squad type, snapped walkable.
    V3 formationSlot(const GameContext& ctx, SquadId squad, int slot, V3 dest, float facing) const;
};

} // namespace ttz::game
