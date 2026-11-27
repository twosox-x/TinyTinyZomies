#pragma once
// Purchase -> parachute drop -> squad ready (WS-D). GAME_DESIGN 3 / 14b deployment sequence:
//   1 placement preview  : validate(dest) every frame while the purchase tool is active (GameUI draws it)
//   2 confirm            : Economy::spend; on success soldiers are created in state Descending
//   3 descent            : <class>/para_descent at the clip's descentSpeed from `dropAltitude`, small lateral drift,
//                          landing points = formation slots around dest (spread so canopies do not overlap)
//   4 landing            : para_land at touchdown (surface = NavGrid::surface: street or flat roof)
//   5 canopy collapse + dissolve: canopy_ground event starts the approved dissolve (renderer, MILITARY_ANIMS 2.3.3)
//   6 recovery           : para_recover; weapon_draw event -> Forming
//   7 formation          : SoldierAI moves to the formation slot
//   8 autonomous         : Idle (AI takes over)
// Invalid destinations are refused with a reason (inside solid geometry, water, no flat area for the squad, outside
// the simulated window in B1, roof too small). Soldiers under canopy are not attackable / attractors until touchdown.
#include "game/GameContext.h"

#include <array>
#include <vector>

namespace ttz::game {

struct DropPlan {
    bool valid = false;
    const char* reason = "";
    bool rooftop = false;
    std::vector<V3> landing;          // one landing point per member (y = surface)
    int price = 0;
};

// Timeline constants of the approved clips (filled by GameWorld from the MilitaryLibrary when it is loaded; the
// defaults are the clip values of assets/military/anims.json at Stage A approval, used headless without a library).
struct DeployTiming {
    std::array<float, kSoldierClasses> descentSpeed = {5.f, 5.f, 5.f, 5.f};      // m/s per SoldierClass (<class>/para_descent)
    std::array<float, kSoldierClasses> landDuration = {1.2f, 1.2f, 1.2f, 1.2f};   // s (<class>/para_land)
    std::array<float, kSoldierClasses> recoverDuration = {2.0f, 2.0f, 2.0f, 2.0f};// s (<class>/para_recover)
    float crateDescentSpeed = 5.f, crateLandDuration = 1.5f;  // crate/descent, crate/land
    std::vector<int> engineerVariants;   // 14d engineers (riflemen by class): approved "engineer" infantry, else the placeholder
    std::array<std::vector<int>, kSoldierClasses> variants;   // MilitaryLibrary::infantry indices per class (flamethrower:
                                                              // rifleman variants until its approved assets exist, FlameAI.h)
};

// One parachute in flight / on the ground (renderer: canopy + harness tracks; Deploy: soldier transform).
enum class DropPhase : uint8_t { Descent, Land, Recover, Done };
struct DropTrack {
    SoldierId soldier;
    SquadId squad;
    V3 landing;                       // touchdown point (y = surface)
    V3 drift;                         // lateral offset at the start of the descent (shrinks to 0 at touchdown)
    float startAlt = 45.f, alt = 45.f;   // m above landing.y
    float t = 0.f;                    // time in the current phase (s)
    float total = 0.f;                // time since the drop started
    float groundT = -1.f;             // s since the canopy settled (canopy_ground, or touchdown + land duration)
    bool released = false;            // harness_release seen (canopy frozen where it lies)
    bool rooftop = false;
    DropPhase phase = DropPhase::Descent;
    float clamp[8] = {0, 0, 0, 0, 0, 0, 0, 0};   // roof footprint for the canopy collapse (minX minZ maxX maxZ y 0 0 on)
};

// Flat-footprint test on the live height grid (NavGrid::surface), shared by Deploy and Logistics:
// every sample of a halfX x halfZ rectangle (rotated by yaw) within `tol` of the centre's surface.
bool flatFootprint(const GameContext& ctx, V3 c, float halfX, float halfZ, float yaw, float tol, float* surface = nullptr);

class Deploy {
public:
    float dropAltitude = 45.f;        // m above the landing surface (visual; not balance)
    float dropSpacing = 4.5f;         // m between landing points (canopies are ~7 m wide and collapse sideways)
    DeployTiming timing;
    DropPlan plan(const GameContext& ctx, SquadType type, V3 dest) const;          // preview + validation (no side effects)
    SquadId execute(GameContext& ctx, SquadType type, const DropPlan& plan);      // after Economy::spend succeeded
    void tick(GameContext& ctx);       // descent / landing / recovery transitions for soldiers in deploy states
    void onAnimEvents(GameContext& ctx);   // after SoldierAnimator::tick: touchdown / canopy_ground / weapon_draw
    const std::vector<DropTrack>& drops() const { return drops_; }
    void reset() { drops_.clear(); }
    uint64_t soldiersDropped() const { return dropped_; }
    uint64_t soldiersLanded() const { return landed_; }
    bool parachuted(SoldierId s) const;   // touched down at the end of a parachute descent (acceptance tests)
private:
    std::vector<SoldierId> touchedDown_;
    std::vector<DropTrack> drops_;
    uint64_t dropped_ = 0, landed_ = 0;
    void finishRecovery(GameContext& ctx, DropTrack& d);
};

} // namespace ttz::game
