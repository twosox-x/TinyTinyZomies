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
    std::array<int, kAmmoTypes> stock{};      // rounds per AmmoType (Fuel: flamethrower fuel units)
    std::vector<V3> slots;                    // access points (world)
    std::vector<SoldierId> slotUser;          // reservation per slot
    std::vector<float> slotStale;             // s the slot's user has not been resupplying (stale reservations freed)
    bool landed = true;                       // airdrop crates: false while descending
    float descentT = 0.f, altitude = 0.f;     // crate descent (renderer reads these for the canopy / crate tracks)
    float emptyFor = 0.f;
    // WS-D additions (additive): crate drop timeline for the renderer, lifetime
    bool alive = true;                        // false: removed (empty crate dissolved); slot reusable
    float startAlt = 0.f;                     // crate: altitude at release (m above pos.y)
    int phase = 0;                            // crate: 0 descent, 1 land clip, 2 on the ground (container: 2)
    float phaseT = 0.f;                       // s in the current phase
    float groundT = -1.f;                     // s since the cargo canopy settled (dissolve clock), -1 not yet
    float dissolve = 0.f;                     // 0 visible .. 1 gone (empty crates fade out)
    int initialTotal = 0;                     // rounds at creation (UI: stock bar)
    int total() const { return stock[0] + stock[1] + stock[2]; }
};

class Logistics {
public:
    // Placement (validated against NavGrid: footprint walkable and flat, not inside geometry, inside the sim window).
    bool canPlaceContainer(const GameContext& ctx, V3 pos, float yaw, const char** why = nullptr) const;
    SupplyId placeContainer(GameContext& ctx, V3 pos, float yaw);       // caller (Commands) charged Economy first
    bool canAirdrop(const GameContext& ctx, V3 pos, const char** why = nullptr) const;
    // Crate landing spot for a drop requested at pos (owner feedback round 3: crates onto rooftops for snipers): the
    // clicked surface (street or ANY roof level of a stepped building), snapped within 2.5 m to a flat 1.2 m spot on
    // that same surface with a walkable access cell next to it. spot.y = surface.
    bool airdropSpot(const GameContext& ctx, V3 pos, V3& spot, const char** why = nullptr) const;
    SupplyId airdrop(GameContext& ctx, V3 pos);
    // Soldier side.
    SupplyId findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) const;
    bool reserve(SupplyId sp, SoldierId soldier, V3& slotPos);          // false: full (queue / try another)
    void releaseReservation(SupplyId sp, SoldierId soldier);
    int collect(SupplyId sp, AmmoType type, int wanted);                // on `grab`: rounds actually transferred
    void tick(GameContext& ctx);                                        // crate descents, landing events, cleanup
    const std::vector<SupplyPoint>& points() const { return points_; }
    const SupplyPoint* get(SupplyId id) const;
    // WS-D additions (additive)
    float crateDescentSpeed = 5.f, crateLandDuration = 1.5f;     // crate/descent, crate/land (GameWorld sets them from the clips)
    float emptyCrateLinger = 20.f, emptyCrateDissolve = 3.f;     // s: empty crates stay as props, then dissolve
    void reset() { points_.clear(); gen_.clear(); }
    int queued(SupplyId sp) const;                                // soldiers waiting (reservation refused) last tick
    uint64_t roundsDelivered(AmmoType t) const { return delivered_[(size_t)t]; }
    // Soldiers waiting for a slot register here (AI calls reserve() each tick until it succeeds; counted for the UI).
private:
    SupplyPoint* getMut(SupplyId id);
    std::array<uint64_t, kAmmoTypes> delivered_{};
    std::vector<int> waiting_, waitingNow_;
    std::vector<SupplyPoint> points_;
    std::vector<uint32_t> gen_;
};

} // namespace ttz::game
