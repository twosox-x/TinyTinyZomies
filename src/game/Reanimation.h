#pragma once
// Dead soldiers rise again as tougher zombies (GAME_DESIGN 14c, APPROVED rule; values in balance.json "reanimation",
// UNAPPROVED). Not instant:
//   1 Dying -> Dead: the death clip plays and holds its last frame (SoldierAI); the weapon lies where the clip dropped it.
//   2 the body lies dead for a random delay in [delayMin, delayMax] s (deterministic per soldier).
//   3 rise: the body cross-fades from the death pose to a standing pose over riseTime s; the weapon stays on the
//     ground (it becomes a DroppedWeapon, drawn for good, and the rising body is drawn without it).
//   4 the soldier entity is released (no duplicate remains) and one GPU zombie agent takes its place through the
//     existing spawn path (HordeInterface::spawnZombie): "zombie soldier" look (olive jacket and trousers, olive cap,
//     torn sleeve, zombie skin, glowing eyes, shambling zombie animation) with health x healthMul. Killing it pays
//     the normal kill reward (the GPU kill ring and its dedupe, like any zombie).
// Limitation (B1): the GPU horde only spawns agents on open ground. A soldier who died on a roof (or anywhere the
// spawn pass cannot place an agent) stays dead; rooftop zombies need roof agents (B3).
#include "game/GameContext.h"

#include <vector>

namespace ttz::game {

class SoldierAnimator;

struct DroppedWeapon {               // a weapon left on the ground for good (renderer: death clip weapon track at t)
    int infantry = 0, clip = -1;
    float t = 0.f;
    V3 pos;
    float yaw = 0.f;
};

// GPU look bits (Agent.info.x / info.y, shaders/include/zombie_look.glsl) of the zombie-soldier appearance.
void zombieSoldierLook(uint32_t seed, uint32_t& lookX, uint32_t& lookY);

class Reanimation {
public:
    void tick(GameContext& ctx, SoldierAnimator* animator);
    const std::vector<DroppedWeapon>& weapons() const { return weapons_; }
    uint64_t risen() const { return risen_; }          // zombie agents requested from dead soldiers
    uint64_t rising() const;                           // bodies in the get-up transition now
    uint64_t stayDead() const { return stayDead_; }    // bodies that cannot rise (roof, outside the simulated area)
    size_t maxWeapons = 256;                           // oldest dropped weapons are removed beyond this
    void reset() { bodies_.clear(); weapons_.clear(); risen_ = stayDead_ = 0; }
private:
    struct Body { SoldierId id; float t = 0.f, riseAt = 0.f, rise = -1.f; bool never = false; };
    std::vector<Body> bodies_;
    std::vector<DroppedWeapon> weapons_;
    uint64_t risen_ = 0, stayDead_ = 0;
};

} // namespace ttz::game
