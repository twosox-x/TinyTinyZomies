#pragma once
// Soldier animation playback on the CPU, in the GAME TICK (WS-B). Deterministic and headless-safe: it needs only the
// clip data (MilitaryLibrary::keyClips from assets/military/anims.*), never the GPU.
//
//   AI   -> request(action, speed)           : what the soldier should look like now
//   tick -> advance clips, cross-fade per the anims.json transition table (phase-matched locomotion), root motion,
//           and report clip EVENTS crossed this tick (muzzle_flash, suppressed, mag_in, grab, weapon_draw, touchdown,
//           harness_release, canopy_ground, footstep, body_fall, ...). Gameplay reacts to events:
//             muzzle_flash / suppressed -> Combat fires one round (fire sync, GAME_DESIGN 14b)
//             mag_in                    -> Combat moves rounds reserve -> magazine
//             grab                      -> Logistics transfers ammo from the supply point
//             weapon_draw               -> Deploy: recovery done, soldier joins the squad
//   render -> MilitaryRenderer samples the pose from the same AnimPlayback at render time (interpolated between ticks).
//
// Fire rate: the fire clip loops; its playback rate is WeaponStats.fireInterval-matched (clip shot spacing /
// fireInterval, clamped to [0.6, 1.8]) so every round has a visible muzzle flash. Same for reload (reloadTime).
// Locomotion: rate = speed / clip speed (no foot sliding), walk <-> run chosen by speed.
// "Constantly interrupted animations" are prevented here: a non-interruptible clip (reload, hit, collect, death,
// para_*) finishes before a new request takes effect, except death (always wins).
#include "game/GameTypes.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ttz {
struct MilitaryLibrary;
}

namespace ttz::game {

struct AnimPlayback {                // per soldier (SoldierPool::anim). Same fields the lab's Soldier struct uses.
    AnimAction action = AnimAction::Idle, requested = AnimAction::Idle;
    int clip = -1;                   // MilInfantry::clips index
    float t = 0.f, rate = 1.f;
    int prevClip = -1;               // cross-fade source
    float prevT = 0.f, blend = 0.f, blendDur = 0.f;
    float prevDelta[4] = {0, 0, 0, 0};
    float requestedSpeed = 0.f;
    uint8_t deathVariant = 0;        // death_a / b / c
    bool locked = false;             // non-interruptible clip playing
};

struct AnimEvent {
    uint32_t soldier = 0;            // SoldierPool slot
    std::string type;                // anims.json event type
    float t = 0.f;                   // clip time of the event
};

class SoldierAnimator {
public:
    bool init(const MilitaryLibrary& lib);             // resolves clip indices per class / infantry
    void reset(AnimPlayback& a, int infantry, AnimAction start);
    void request(AnimPlayback& a, AnimAction action, float speed = 0.f);
    // Advance one game tick; appends crossed events. `rootDelta` (x, z, yaw) receives committed root motion
    // (landing, turns, deaths) that the caller applies to the soldier's transform.
    void tick(uint32_t soldier, int infantry, AnimPlayback& a, float dt, std::vector<AnimEvent>& events, float rootDelta[3]);
    bool finished(const AnimPlayback& a, int infantry) const;   // one-shot clip at its end
    float clipShotInterval(SoldierClass c) const;               // seconds between muzzle_flash events in <class>/fire

private:
    const MilitaryLibrary* lib_ = nullptr;
};

} // namespace ttz::game
