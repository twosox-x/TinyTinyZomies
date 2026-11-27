#pragma once
// Soldier behaviour (WS-C): one lightweight state machine per soldier, ticked at 30 Hz (GAME_DESIGN 3 / 14b).
//
// Priorities (highest first), evaluated per soldier per tick:
//   Dying / Dead          (health <= 0: death clip, weapon drop, body stays)
//   Deploy phases         (Descending .. Forming: owned by Deploy, AI only watches for weapon_draw / formation)
//   Hit                   (short reaction when contact damage starts; not re-triggered within a cooldown)
//   Reloading             (mag empty and reserve > 0; finishes unless dying)
//   Move order            (squad order newer than the soldier's: follow the path to the formation slot; orders are
//                          never abandoned for a target. A zombie within moveThreatRadius stops the soldier to fire for
//                          at most moveStopMax s (then not again for moveStopCooldown), then the order resumes. A new
//                          order also cancels a resupply trip (player orders take priority over autonomy).)
//   Resupply              (Idle, total ammo below lowAmmoFraction and a supply point with stock within the search
//                          radius; reserve a slot (SupplyAccess -> Logistics), or queue on a ring and retry; path there,
//                          Collecting cycles until full or stock empty, then back to the formation slot)
//                          Multi-soldier squads send ONE ammo runner instead (ammoRunners): when the squad's rounds
//                          fall below logistics.runnerTrigger of its full load, the member with the fewest visible
//                          threats goes, collects his own need plus runnerCarryMagazines for the others (debited from
//                          the supply point), returns and hands rounds to each squad mate in need (collect_ammo clip,
//                          grab event = hand-over). The others keep holding and fighting; a member only goes himself
//                          when completely dry and no runner is alive. A dead runner is replaced (rotation).
//   Engage                (target lock in range with LOS: aim -> acquire -> fire; hold position)
//   Idle                  (scan; face the threat sector)
//
// Threat-driven behaviour (owner feedback after B1): every tick each soldier reads the EXACT positions / velocities
// of its 4 nearest live zombies (GPU nearest list, HordeBridge game_contacts, <= 24 m, any height). A visible one
// within threatRadius (12 m, any direction, LOS from a 2 m eye so cars do not hide it) interrupts move orders,
// formation and resupply: the soldier stops, turns and fires, then resumes the order (a threat within mustFight 8 m
// is never ignored; farther ones at most moveStopMax s per stop). Targets are scored (distance, closing speed, zombies
// on a squad mate) and the lock FOLLOWS that zombie (exact lock, aim led by its velocity); when it dies it leaves the
// list and the lock drops within 0.2 s (no firing into an empty area). A clearly closer threat (< 0.6 x) takes over.
// Beyond the exact radius the coarse 6 m field is used (snipers, long-range rifles).
// Pace: auto = run unless tired (stamina) or wounded, sprint (x sprintScale) when threatened / out of ammo; Shift
// forces a run, Ctrl / Alt a walk. Wounded soldiers walk (they fall behind; the squad does not wait, B3 medics).
//
// Anti-oscillation rules (GAME_DESIGN 14b):
//   * target hysteresis: keep the locked point while a field sample stays within 2.5 m of it (re-associated each
//     field refresh); switch only when it is lost for > 0.6 s, or a zombie is within 4 m and the lock is > 10 m away
//   * no chasing: soldiers never path toward zombies; targets beyond range are ignored (no "distant zombie chase")
//   * state minimum dwell times (e.g. Engaging >= 0.8 s) before a lower-priority transition
//   * stuck detection: no progress for 3 s along a path -> re-request once, then hold and flag the squad
#include "game/GameContext.h"
#include "game/SupplyAccess.h"

#include <functional>
#include <vector>

namespace ttz::game {

struct Squad;
struct SoldierContact;

struct AiTuning {                     // behaviour constants (not balance): kept here, not in balance.json
    float targetKeepRadius = 2.5f, targetLostTime = 0.6f, closeThreat = 4.f, closeSwitchMinDist = 10.f;
    float engageMinDwell = 0.8f, stuckTime = 3.f, arriveRadius = 0.6f, separation = 0.8f;
    bool fireOnMove = false;
    // --- added in B1 (WS-C)
    float leash = 3.f;               // m from home: a displaced soldier walks back (soldiers never advance on zombies)
    float moveThreatRadius = 5.f;    // a moving soldier stops to fire at a zombie this close, then resumes the order
    float moveStopMax = 3.f, moveStopCooldown = 4.f;   // ... at most this long, then not again for this long
    float turnRate = 7.f;            // rad/s
    float aimTolerance = 0.26f;      // rad: acquisition only counts while facing the lock within this
    float hitDuration = 0.6f, dyingTime = 1.4f, collectTime = 3.2f;
    float tacticalReloadFraction = 0.5f;   // idle with no target and magazine below this: reload
    float supplyRetry = 0.5f, supplySearchInterval = 2.f, queueRadius = 3.2f;
    float woundedSpeed = 0.6f;       // speed factor while wounded
    float waypointRadius = 0.4f;
    int pathBudget = 20000;          // NavGrid A* nodes per game tick (SoldierAI::tick drives NavGrid::tick)
    int perceptionStride = 3;        // full (coarse field) target search every N ticks; exact threats every tick
    // --- owner feedback after B1: threat-driven behaviour from the exact GPU nearest-zombie lists
    float scanRadius = 24.f;         // m: HordeBridge returns each soldier's 4 nearest live zombies within this (exact)
    float threatRadius = 12.f;       // m: a visible zombie this close is an immediate threat (any direction, 360 deg):
                                     //    it interrupts move orders, formation and resupply trips (fight, then resume)
    float mustFight = 8.f;           // m: a threat this close is never ignored to keep moving (no moveStopMax cap)
    float eyeHeight = 2.0f;          // m: line-of-sight eye (cars ~1.5 m do not hide a zombie behind them)
    float lockMatch = 1.8f;          // m: an exact lock follows the zombie nearest its predicted position within this
    float lockLostExact = 0.2f;      // s: an exact lock whose zombie left the list (killed) is dropped this fast
    float aimLead = 0.12f;           // s: aim ahead along the zombie velocity (readback latency + flight)
    float switchRatio = 0.6f;        // switch to a new threat this much closer than the lock (similar threats: keep)
    float buddyRadius = 2.5f;        // m: a zombie this close to a squad mate counts as threatening him (mutual support)
};

class SoldierAI {
public:
    AiTuning tuning;
    SupplyAccess* supply = nullptr;  // null: ctx.logistics (LogisticsSupply); tests: FakeSupply
    // B3 hospitals: called for wounded soldiers that are Idle; return true when the hook took the soldier over
    // (state / path set by the hook). B1: unset (wounded soldiers keep fighting, slower and less accurate).
    std::function<bool(GameContext&, uint32_t)> medicalSeek;

    // Per tick: NavGrid budget, squad orders -> formation slots, perception (field), decisions, movement, anim requests.
    void tick(GameContext& ctx);
    // Formation slot of a member (world) for a squad order: line / wedge by squad type, snapped walkable.
    V3 formationSlot(const GameContext& ctx, SquadId squad, int slot, V3 dest, float facing) const;
    // Tests / scripts / debug: a whole squad (cfg.squad[type].size members) standing at dest, equipped, state Forming.
    static SquadId spawnLanded(GameContext& ctx, SquadType type, V3 dest, float facing, uint32_t seed);

    struct SquadStatus {
        int size = 0, alive = 0, rounds = 0, fullRounds = 0;
        uint32_t targetSwitches = 0, stateChanges = 0, roundsFired = 0;
        float minHealth = 0.f;
        bool stuck = false;
    };
    SquadStatus status(const GameContext& ctx, SquadId id) const;
    uint8_t threats(uint32_t i) const { return i < threats_.size() ? threats_[i] : 0; }   // visible zombies within threatRadius (debug overlay)

private:
    LogisticsSupply logisticsSupply_;
    struct Cell { uint32_t key, idx; };
    std::vector<Cell> hash_;          // separation: soldiers sorted by 2 m cell
    void squadOrders(GameContext& ctx, SupplyAccess& sup);
    void assignSlots(GameContext& ctx, Squad& s, V3 dest, float facing);
    void soldier(GameContext& ctx, SupplyAccess& sup, uint32_t i);
    bool findTarget(const GameContext& ctx, uint32_t i, float range, V3& out) const;
    // Best immediate threat of soldier i from its exact nearest list (visible, scored by distance, closing speed and
    // pressure on squad mates); n = visible zombies within threatRadius.
    bool bestThreat(const GameContext& ctx, uint32_t i, V3& pos, V3& vel, float& dist, int& n) const;
    const SoldierContact* contactOf(const GameContext& ctx, uint32_t i) const;
    std::vector<int> contactIndex_;
    std::vector<uint8_t> threats_;  // soldier slot -> index into horde contacts (rebuilt per tick)
    // Pace of a move: run speed x (sprint when threatened and fresh), walk when tired / wounded / ordered to walk.
    float paceFor(GameContext& ctx, uint32_t i, bool forceRun, bool forceWalk, bool highStakes, bool& running) const;
    bool nearestSample(const GameContext& ctx, V3 p, float r, V3& out) const;
    void startPath(GameContext& ctx, uint32_t i, V3 goal);
    int followPath(GameContext& ctx, uint32_t i, float speed);   // 0 moving, 1 arrived, 2 failed / gave up
    void steer(GameContext& ctx, uint32_t i, V3 desiredVel);
    void face(GameContext& ctx, uint32_t i, V3 at);
    void leave(GameContext& ctx, SupplyAccess& sup, uint32_t i);  // end of an interruption: resume or Idle
    void dropSupply(GameContext& ctx, SupplyAccess& sup, uint32_t i);
    void tryResupply(GameContext& ctx, SupplyAccess& sup, uint32_t i);
    // Ammo runner (multi-soldier squads): one member fetches ammo for the squad and hands it out; the rest hold.
    void ammoRunners(GameContext& ctx, SupplyAccess& sup);
};

} // namespace ttz::game
