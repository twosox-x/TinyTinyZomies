// Purchase -> parachute drop (WS-D): STUB (every plan refused until implemented).
#include "game/Deploy.h"

namespace ttz::game {

DropPlan Deploy::plan(const GameContext& ctx, SquadType type, V3 dest) const {
    DropPlan p;
    p.reason = "deployment not implemented yet";
    return p;
}
SquadId Deploy::execute(GameContext& ctx, SquadType type, const DropPlan& plan) { return {}; }
void Deploy::tick(GameContext& ctx) {}

} // namespace ttz::game
