#pragma once
// Soldier and squad storage (WS-C). Structure of arrays: every soldier is a slot; hot loops (AI, combat, render
// gather) walk the arrays they need. Slots are recycled with a generation counter (handles in GameTypes.h).
// Other modules read these arrays freely but only these owners WRITE a field:
//   pos / vel / yaw (+ path)       : SoldierAI (movement), Deploy (while Descending / Landing)
//   state / stateTime / target     : SoldierAI
//   health                         : Combat (zombie contact damage), later Hospital
//   mag / reserve                  : Combat (shots, reload), Logistics (collect)
//   anim                           : SoldierAnimator (SoldierAnim.h), from AI requests
#include "game/GameTypes.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"

#include <vector>

namespace ttz::game {

struct BalanceConfig;

struct TargetLock {                  // a point the soldier aims at (the GPU decides which zombie a round hits)
    bool active = false;
    V3 pos;                          // last associated field sample (re-associated to the nearest sample each refresh)
    float age = 0.f;                 // s since the last association; dropped after a timeout (no flip-flopping)
    float acquire = 0.f;             // s spent acquiring (WeaponStats.acquireTime before the first shot)
    bool exact = false;              // pos / vel follow one real zombie (GPU nearest list), not a coarse field sample
    V3 vel;                          // its velocity (aim lead)
    float prone = 0.f;               // its prone factor (legless crawlers: aim at the ground, not at chest height)
    float blocked = 0.f;             // s without a clear firing line to it (dropped after AiTuning::blockedDrop)
};

struct SoldierPool {
    // --- identity
    std::vector<uint32_t> gen;
    std::vector<uint8_t> used;
    std::vector<SoldierClass> cls;
    std::vector<uint16_t> infantry;  // MilitaryLibrary::infantry index (visual variant of the class)
    std::vector<SquadId> squad;
    std::vector<uint8_t> slotInSquad;
    // --- kinematics
    std::vector<V3> pos, vel;
    std::vector<float> yaw;
    std::vector<PathFollow> path;
    // --- combat
    std::vector<float> health;
    std::vector<int> mag, reserve;
    std::vector<TargetLock> target;
    std::vector<float> fireCooldown;
    // --- behaviour
    std::vector<SoldierState> state;
    std::vector<float> stateTime;
    std::vector<SupplyId> supply;    // reserved supply point (Resupplying / Collecting)
    std::vector<uint32_t> rng;       // deterministic per-soldier stream
    // --- animation (playback state; poses are sampled per render frame by the renderer)
    std::vector<AnimPlayback> anim;
    // --- AI bookkeeping (WS-C; written by SoldierAI unless noted)
    std::vector<uint8_t> equipped;   // health / mag / reserve set from the balance config (equip())
    std::vector<float> maxHealth;
    std::vector<V3> home;            // guard position (formation slot of the squad anchor / last order)
    std::vector<float> homeYaw;
    std::vector<uint32_t> orderSerial;   // squad order serial this soldier has taken over
    std::vector<SoldierState> resume;    // state to resume after a threat stop (Moving / Resupplying), Idle: none
    std::vector<float> stuckTime;
    std::vector<V3> progressPos;
    std::vector<uint8_t> repaths;    // re-plans of the current path (stuck recovery: one, then hold)
    std::vector<uint8_t> phase;      // per-state progress bits (PH_*), cleared on every state change
    std::vector<float> hitCooldown, contactAge;   // Combat: hit reaction cooldown, s since last zombie contact
    std::vector<float> retry;        // AI: s until the next resupply search / reservation retry
    std::vector<float> stopCooldown; // AI: s until a moving soldier may stop again for a close threat
    std::vector<V3> goal;            // AI: destination of the current path (home, supply slot, queue point)
    std::vector<uint8_t> wounded;    // health below SoldierPool::woundedFraction (slower, wider spread)
    std::vector<uint32_t> targetSwitches, stateChanges, rounds;   // diagnostics (tests, UI)
    std::vector<float> stamina;      // SoldierAI: 0..StaminaConfig.max, drains while running, recovers otherwise
    std::vector<uint8_t> tired;      // SoldierAI: stamina ran low; walks until it recovered to resumeRun (hysteresis)
    std::vector<uint8_t> running;    // SoldierAI: moved at run speed this tick (UI, tests)
    std::vector<int> carry;          // ammo runner: rounds carried for squad mates (not his own reserve)
    std::vector<uint8_t> runner;     // ammo runner role: 0 none, 1 on the way to / at a supply point, 2 handing out
    std::vector<SoldierId> deliverTo;// ammo runner: the squad mate he is walking to / handing rounds to
    std::vector<float> scanT;        // SoldierAI: s until a rooftop marksman re-picks his firing position
    std::vector<uint8_t> unarmed;    // Reanimation: the weapon lies on the ground (rising body drawn without it)

    SoldierId spawn(SoldierClass c, int infantryIndex, SquadId sq, int slot, V3 p, float yawRad, uint32_t seed);
    // Health, full magazine and reserve from the config (Deploy calls it on purchase; SoldierAI equips any soldier
    // it meets unequipped, so an omitted call cannot leave a soldier at health 0).
    void equip(uint32_t i, const BalanceConfig& cfg);
    // The only way states change (resets stateTime / phase, counts transitions for the oscillation tests).
    void setState(uint32_t i, SoldierState s) {
        if (state[i] == s) return;
        state[i] = s; stateTime[i] = 0.f; phase[i] = 0; ++stateChanges[i];
    }
    int fullLoad(uint32_t i, const BalanceConfig& cfg) const;     // magazine + reserve of the class weapon
    float woundedFraction = 0.35f;   // behaviour constant: health / max below which a soldier counts as wounded
    void release(SoldierId id);      // body removed: slot reusable (generation increments)
    bool valid(SoldierId id) const { return id.index < gen.size() && used[id.index] && gen[id.index] == id.gen; }
    SoldierId idOf(uint32_t index) const { SoldierId s; s.index = index; s.gen = gen[index]; return s; }
    bool alive(uint32_t i) const { return used[i] && state[i] != SoldierState::Dying && state[i] != SoldierState::Dead; }
    size_t capacity() const { return gen.size(); }
    size_t liveCount() const;
private:
    std::vector<uint32_t> free_;
};

enum SoldierPhase : uint8_t { PH_RELOADED = 1, PH_GRABBED = 2, PH_WAITING = 4, PH_RETURNING = 8, PH_ACQUIRED = 16 };

struct MoveOrder {
    bool active = false;
    V3 dest;
    float facing = 0.f;              // formation facing at the destination (rad)
    bool run = false;                // forced run (Shift + RMB)
    bool walk = false;               // forced walk (Ctrl / Alt + RMB); neither: auto pace (SoldierAI::paceFor)
    uint32_t serial = 0;             // increments on every new order (AI notices a fresh order)
};

struct Squad {
    SquadId id;
    SquadType type = SquadType::Rifle;
    std::vector<SoldierId> members;  // founding members; dead ones stay listed (casualty display) with state Dead
    MoveOrder order;
    uint32_t flags = 0;              // SquadFlags (recomputed each tick)
    uint32_t number = 0;             // display number (1, 2, ...) per type, for the marker / list
    bool deploying = true;
    // --- WS-C (SoldierAI)
    bool hasAnchor = false;          // anchor: where the squad holds (last order destination, else landing centroid)
    V3 anchor;
    float anchorFacing = 0.f;
    uint32_t seenSerial = 0;         // last order serial turned into formation slots
    bool stuck = false;              // a member gave up a path (holds where it is; UI warning)
    SoldierId runner;                // ammo runner of the squad (multi-soldier squads), invalid: none
    float runnerGrace = 0.f;         // s after a runner died during which members wait for a replacement
};

struct SquadList {
    std::vector<Squad> squads;       // stable order of purchase; removed when every member's body is gone
    std::vector<uint32_t> gen;
    SquadId create(SquadType t);
    Squad* get(SquadId id);
    const Squad* get(SquadId id) const;
    int aliveMembers(const Squad& s, const SoldierPool& pool) const;
};

} // namespace ttz::game
