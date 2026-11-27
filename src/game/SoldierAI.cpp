// Soldier behaviour (WS-C): STUB.
#include "game/SoldierAI.h"

namespace ttz::game {

void SoldierAI::tick(GameContext& ctx) {}
V3 SoldierAI::formationSlot(const GameContext& ctx, SquadId squad, int slot, V3 dest, float facing) const { return dest; }

} // namespace ttz::game
