// Ammunition supply (WS-D): STUB (placement refused until implemented).
#include "game/Logistics.h"

namespace ttz::game {

bool Logistics::canPlaceContainer(const GameContext& ctx, V3 pos, float yaw, const char** why) const { if (why) *why = "not implemented"; return false; }
SupplyId Logistics::placeContainer(GameContext& ctx, V3 pos, float yaw) { return {}; }
bool Logistics::canAirdrop(const GameContext& ctx, V3 pos, const char** why) const { if (why) *why = "not implemented"; return false; }
SupplyId Logistics::airdrop(GameContext& ctx, V3 pos) { return {}; }
SupplyId Logistics::findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) const { return {}; }
bool Logistics::reserve(SupplyId sp, SoldierId soldier, V3& slotPos) { return false; }
void Logistics::releaseReservation(SupplyId sp, SoldierId soldier) {}
int Logistics::collect(SupplyId sp, AmmoType type, int wanted) { return 0; }
void Logistics::tick(GameContext& ctx) {}
const SupplyPoint* Logistics::get(SupplyId id) const { return nullptr; }

} // namespace ttz::game
