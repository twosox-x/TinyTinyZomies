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

#include <vector>

namespace ttz::game {

struct DropPlan {
    bool valid = false;
    const char* reason = "";
    bool rooftop = false;
    std::vector<V3> landing;          // one landing point per member (y = surface)
    int price = 0;
};

class Deploy {
public:
    float dropAltitude = 45.f;        // m above the landing surface (visual; not balance)
    DropPlan plan(const GameContext& ctx, SquadType type, V3 dest) const;          // preview + validation (no side effects)
    SquadId execute(GameContext& ctx, SquadType type, const DropPlan& plan);      // after Economy::spend succeeded
    void tick(GameContext& ctx);       // descent / landing / recovery transitions for soldiers in deploy states
};

} // namespace ttz::game
