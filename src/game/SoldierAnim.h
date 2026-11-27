#pragma once
// Soldier animation playback on the CPU, in the GAME TICK (WS-B). Deterministic and headless-safe: it needs only the
// clip data (MilitaryLibrary::keyClips from assets/military/anims.*), never the GPU. The clip playback arithmetic
// (cross-fade per the anims.json transition table, phase-matched locomotion, root motion, event crossing) is the
// lab's own (milSwitchClip / milAdvance in MilitaryAssets.h): one implementation for lab and game.
//
//   AI   -> request(action, speed)           : what the soldier should look like now
//   tick -> advance clips, cross-fade, root motion, and report clip EVENTS crossed this tick. Gameplay reacts:
//             muzzle_flash                     -> Combat fires one round (fire sync, GAME_DESIGN 14b). Sniper clips
//                                                 also carry `suppressed` at the same instant (FX only, not a round)
//             mag_in                           -> Combat moves rounds reserve -> magazine
//             grab (action CollectAmmo)        -> Logistics transfers ammo from the supply point (MG reload also
//                                                 has a `grab`: check AnimEvent::action)
//             weapon_draw                      -> Deploy: recovery done, soldier joins the squad
//             touchdown / canopy_ground / harness_release -> Deploy (canopy dissolve clock, release)
//             weapon_drop / body_fall          -> death (weapon leaves the hand / body hits the ground)
//           synthetic events (type, at clip start / end): reload_start, reload_end, collect_end, hit_end,
//           death_end, land_end, recover_end, turn_end
//   render -> GameRender samples the pose from the same AnimPlayback (interpolated between ticks).
//
// Fire rate: the fire clip loops; its playback rate is fireInterval-matched (clip shot spacing / fireInterval,
// clamped to [0.6, 1.8]) so every round has a visible muzzle flash; the same for reload (clip length / reloadTime).
// Without configure() the clips play at their authored rate. Locomotion: rate = speed / clip speed (no foot sliding,
// clamped [0.5, 1.6]); a Walk request too fast for the walk clip plays Run and vice versa.
// Interruption rules ("no constantly interrupted animations"): one-shot clips (reload, hit, collect_ammo, turn_*,
// para_land, para_recover) start on a NEW request (edge: the previous request was a different action) and finish
// before another request takes effect; para_descent loops until ParaLand; Death always wins and holds its last frame
// until reset(). The first tick of a clip includes events at t = 0 (the first round of a fire burst is immediate).
// Root motion (turns, para_land, ...) is committed when the finished clip is left: tick() reports it in rootDelta
// in the SOLDIER's frame (x right-handed lateral, z forward, yaw); apply it with applyRootMotion().
#include "game/GameTypes.h"
#include "lab/MilitaryAssets.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace ttz::game {

struct BalanceConfig;

struct AnimPlayback : MilPlayback {  // per soldier (SoldierPool::anim). MilPlayback: clip, t, rate, prevClip, prevT, blend, blendDur, prevDelta
    AnimAction action = AnimAction::Idle, requested = AnimAction::Idle;
    float requestedSpeed = 0.f;
    uint8_t deathVariant = 0;        // 0 auto (per-soldier hash), 1..3 = death_a / b / c
    bool locked = false;             // non-interruptible clip playing
    bool pending = false;            // a one-shot action was newly requested and has not started yet
    bool fresh = true;               // the current clip has not advanced yet (events at t = 0 included)
    bool ended = false;              // the current one-shot clip reported its end event
    AnimPlayback() { clip = -1; }
};

struct AnimEvent {
    uint32_t soldier = 0;            // SoldierPool slot
    std::string type;                // anims.json event type (or a synthetic *_start / *_end, see above)
    float t = 0.f;                   // clip time of the event
    AnimAction action = AnimAction::Count;   // action of the clip that carried the event
};

class SoldierAnimator {
public:
    bool init(const MilitaryLibrary& lib);             // resolves clip indices per class / infantry
    void configure(const BalanceConfig& cfg);           // fire / reload rate matching from the weapon stats
    void setWeaponTiming(SoldierClass c, float fireInterval, float reloadTime);
    void reset(AnimPlayback& a, int infantry, AnimAction start);
    void request(AnimPlayback& a, AnimAction action, float speed = 0.f);
    // Advance one game tick; appends crossed events. `rootDelta` (x, z, yaw) receives committed root motion in the
    // soldier's frame (see applyRootMotion).
    void tick(uint32_t soldier, int infantry, AnimPlayback& a, float dt, std::vector<AnimEvent>& events, float rootDelta[3]);
    bool finished(const AnimPlayback& a, int infantry) const;   // one-shot clip at its end (true without a clip)
    float clipShotInterval(SoldierClass c) const;               // seconds between muzzle_flash events in <class>/fire
    int clipFor(int infantry, AnimAction action, uint8_t deathVariant = 1) const;   // MilInfantry::clips index, -1 none
    float clipLength(int infantry, int clip) const;
    const MilitaryLibrary* library() const { return lib_; }
    // Render-time sample of the playback `ahead` seconds after the last tick (pose interpolation between ticks):
    // clip / prev clip times and blend advanced without events or clip switches.
    AnimPlayback sampleAhead(const AnimPlayback& a, int infantry, float ahead) const;

    // Facing: a turn clip for a large heading change while standing (|error| > threshold), else AnimAction::Count
    // (rotate the soldier directly, at most turnRate rad/s while moving or aiming).
    static AnimAction turnFor(float yawError, float threshold = 1.2f);
    static float turnToward(float yaw, float target, float maxStep);   // shortest-arc step, result unwrapped
    static void applyRootMotion(V3& pos, float& yaw, const float rootDelta[3]);
    static bool oneShot(AnimAction a);

private:
    struct InfClips { int cls = 0; std::array<int, (size_t)AnimAction::Count> clip; int death[3] = {-1, -1, -1}; float walkSpeed = 1.3f, runSpeed = 3.8f; };
    void start(uint32_t soldier, int infantry, AnimPlayback& a, AnimAction act, std::vector<AnimEvent>& events, float rootDelta[3]);
    void emit(std::vector<AnimEvent>& ev, uint32_t s, const char* type, float t, AnimAction a) const;
    float rateFor(const InfClips& ic, const AnimPlayback& a, AnimAction act) const;
    const MilitaryLibrary* lib_ = nullptr;
    std::vector<InfClips> inf_;
    float shotInterval_[3] = {0.3f, 1.f / 12.f, 1.9f};
    float fireInterval_[3] = {0, 0, 0}, reloadTime_[3] = {0, 0, 0};   // 0: authored rate
};

} // namespace ttz::game
