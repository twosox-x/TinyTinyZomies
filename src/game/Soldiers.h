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

struct TargetLock {                  // a point the soldier aims at (the GPU decides which zombie a round hits)
    bool active = false;
    V3 pos;                          // last associated field sample (re-associated to the nearest sample each refresh)
    float age = 0.f;                 // s since the last association; dropped after a timeout (no flip-flopping)
    float acquire = 0.f;             // s spent acquiring (WeaponStats.acquireTime before the first shot)
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

    SoldierId spawn(SoldierClass c, int infantryIndex, SquadId sq, int slot, V3 p, float yawRad, uint32_t seed);
    void release(SoldierId id);      // body removed: slot reusable (generation increments)
    bool valid(SoldierId id) const { return id.index < gen.size() && used[id.index] && gen[id.index] == id.gen; }
    SoldierId idOf(uint32_t index) const { SoldierId s; s.index = index; s.gen = gen[index]; return s; }
    bool alive(uint32_t i) const { return used[i] && state[i] != SoldierState::Dying && state[i] != SoldierState::Dead; }
    size_t capacity() const { return gen.size(); }
    size_t liveCount() const;
private:
    std::vector<uint32_t> free_;
};

struct MoveOrder {
    bool active = false;
    V3 dest;
    float facing = 0.f;              // formation facing at the destination (rad)
    bool run = false;
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
