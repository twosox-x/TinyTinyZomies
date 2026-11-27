#pragma once
// Physical ammunition supply (WS-D). GAME_DESIGN 4: finite, physical, no global refill, no teleporting.
//
// SupplyPoint: the central container (bought, placed; B2 restricts placement to controlled territory) or an airdrop
// crate (bought, descends by parachute with the approved crate clips, becomes a supply point on landing).
// Stock per AmmoType. Access slots (walkable points around the footprint, NavGrid::nearestWalkable) are reserved
// one soldier each, so several soldiers share a point without blocking each other; extra soldiers queue at a
// waiting ring and take the next free slot. Transfer happens on the soldier's `grab` clip event, limited by stock
// and by the soldier's missing rounds. Empty crates stay as props for a while, then dissolve (crate reuse of the
// canopy dissolve); containers stay forever (B1: not destroyable).
#include "game/GameContext.h"

#include <array>
#include <vector>

namespace ttz::game {

enum class SupplyKind : uint8_t { Container, Crate };

struct SupplyPoint {
    SupplyId id;
    SupplyKind kind = SupplyKind::Crate;
    V3 pos;
    float yaw = 0.f;
    std::array<int, 3> stock = {0, 0, 0};     // rounds per AmmoType
    std::vector<V3> slots;                    // access points (world)
    std::vector<SoldierId> slotUser;          // reservation per slot
    bool landed = true;                       // airdrop crates: false while descending
    float descentT = 0.f, altitude = 0.f;     // crate descent (renderer reads these for the canopy / crate tracks)
    float emptyFor = 0.f;
};

class Logistics {
public:
    // Placement (validated against NavGrid: footprint walkable and flat, not inside geometry, inside the sim window).
    bool canPlaceContainer(const GameContext& ctx, V3 pos, float yaw, const char** why = nullptr) const;
    SupplyId placeContainer(GameContext& ctx, V3 pos, float yaw);       // caller (Commands) charged Economy first
    bool canAirdrop(const GameContext& ctx, V3 pos, const char** why = nullptr) const;
    SupplyId airdrop(GameContext& ctx, V3 pos);
    // Soldier side.
    SupplyId findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) const;
    bool reserve(SupplyId sp, SoldierId soldier, V3& slotPos);          // false: full (queue / try another)
    void releaseReservation(SupplyId sp, SoldierId soldier);
    int collect(SupplyId sp, AmmoType type, int wanted);                // on `grab`: rounds actually transferred
    void tick(GameContext& ctx);                                        // crate descents, landing events, cleanup
    const std::vector<SupplyPoint>& points() const { return points_; }
    const SupplyPoint* get(SupplyId id) const;
private:
    std::vector<SupplyPoint> points_;
    std::vector<uint32_t> gen_;
};

} // namespace ttz::game
