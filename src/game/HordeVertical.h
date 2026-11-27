#pragma once
// Vertical warfare for the zombie horde (Milestone B3b, GAME_DESIGN 7, docs/GAMEPLAY_ARCHITECTURE.md section 9).
//
// Zombies stay 2D GPU agents on the street grid (the height grid has no interiors and is NOT extended). A building
// becomes ACTIVE while soldiers are inside it or on its roof (at most kVMaxActive at a time). An active building gets a
// compact building-local graph in a slot of a small GPU node table, rebuilt only for that slot when its state changes
// (no global navigation rebuild):
//
//     door 0..7  ->  floor 0 (stair core) -> floor 1 -> ... -> floor n-1  ->  roof hatch  ->  roof (agent again)
//
// Navigation: the street-side point of every door of an active building is an extra attractor (HordeBridge::
// setEntranceAttractors) whose reach is shortened by the interior route, so the shared flow field leads the horde to
// the doors; the flow never runs up tall facades (nav_relax, GAME_VERTICAL), roofs are walkable plateaus for agents
// already up there, and low roofs keep the old corpse-pile climbing.
// GPU (shaders/game_vertical.comp, after the frame's last sim step, cost ~ entrances + occupants, never cells):
//   capture : walkers inside an open door's capture radius leave the agent list (ST_DEAD, no corpse, removed by the next
//             sort) and become OCCUPANTS (look, health, node, timer) while the door node has capacity (else they queue
//             outside); at a barricaded door they batter it instead (breach damage per zombie per second)
//   advance : occupants move node to node: traverse time per node (door, crossing to the stairs, one flight per
//             floor, hatch), per-node capacity (stairs congest), a barricaded hatch is battered until broken, defenders
//             on a floor kill occupants there (kill ring: rewards / dedupe unchanged); at the roof they re-enter the
//             agent list at the hatch and chase the roof soldiers with the normal flow / contact / gore paths
// CPU (per tick, cost ~ soldiers + active buildings): building activity / target level from the uploaded soldiers,
//   node + entrance upload when a slot changes, async readback (3 slots) -> barricade damage (BuildingRegistry::
//   damageBarricade through a callback), zombie counts per building / floor, interior attackers for soldiers on a
//   floor with occupants (HordeBridge::setInteriorAttackers -> SoldierContact::attackers -> Combat contact damage).
// Inactive buildings drain: their occupants walk back down and leave by the main door.
#include "game/Buildings.h"
#include "game/Config.h"
#include "game/HordeInterface.h"

#include <SDL3/SDL_gpu.h>
#include <array>
#include <functional>
#include <vector>

namespace ttz {
class GpuContext;
class CrowdSim;
}

namespace ttz::game {

class HordeBridge;

// Tuning: VerticalConfig (Config.h, config/balance.json "vertical", UNAPPROVED).

constexpr uint32_t kVMaxActive = 32;        // active buildings (slots)
constexpr uint32_t kVNodesPerSlot = 32;     // 0..7 doors, 8..29 floors 0..21, 30 hatch
constexpr uint32_t kVMaxDoors = 8, kVFloorBase = 8, kVMaxFloors = 22, kVHatch = 30;
constexpr uint32_t kVMaxNodes = kVMaxActive * kVNodesPerSlot;
constexpr uint32_t kVMaxEntrances = kVMaxActive * kVMaxDoors;
constexpr uint32_t kVMaxOccupants = 4096;

class HordeVertical {
public:
    bool init(GpuContext& gpu, CrowdSim& sim, HordeBridge& bridge);
    void shutdown();
    void reset();                    // drops every occupant (scenario reset)
    VerticalConfig cfg;
    float awareness = 60.f;          // HordeBridge awareness radius (door attractor reach is a fraction of it)

    // ---- building source (B3a's BuildingRegistry in the game, a hand-made list in the self-test) ----------------
    const std::vector<Building>* buildings = nullptr;
    std::function<BuildingId(float, float)> lookup;                                   // optional (registry.at)
    std::function<void(BuildingId, uint16_t, float)> damageBarricade;                  // registry.damageBarricade
    std::function<void(BuildingId, int, int, const int16_t*, int)> setZombieCounts;     // registry.setZombieCounts

    // Per game tick, after Combat uploaded the soldiers (same list as HordeBridge::uploadSoldiers).
    void tick(const std::vector<HordeSoldier>& soldiers, double time);
    // After the frame's last CrowdSim::step (and after HordeBridge::postSim).
    void postSim(SDL_GPUCommandBuffer* cmd);
    void harvest();                  // after submit (non-blocking unless setSync)
    void setSync(bool on) { sync_ = on; }

    // ---- results (newest harvested frame) -------------------------------------------------------------------------
    struct BuildingState {
        BuildingId id;
        bool draining = false;
        uint8_t target = 0;          // level the occupants head for (floor index, kRoofFloor = roof)
        int occupants = 0;           // all nodes of the building
        int atTarget = 0;
        std::vector<int16_t> perFloor;
    };
    const std::vector<BuildingState>& active() const { return view_; }
    struct Stats {
        uint64_t captured = 0, emitted = 0, killedInside = 0, dropped = 0, leftByDoor = 0;
        int occupants = 0, activeBuildings = 0, entrances = 0;
        double cpuMs = 0;
        uint64_t uploads = 0;
    };
    const Stats& stats() const { return st_; }
    // Is this building (by id) currently active and its door open? (tests / UI)
    int slotOf(BuildingId id) const;
    // Why a building cannot be entered by zombies ("" = supported). GAME_DESIGN 14b: unsupported cases documented.
    static const char* unsupportedWhy(const Building& b);

private:
    struct Slot {
        BuildingId id;
        bool used = false, draining = false;
        double lastActive = 0, drainSince = 0;
        uint8_t target = 0;
        int nDoors = 0, nFloors = 0;
        bool hasHatch = false;
        uint16_t doorOpening[kVMaxDoors] = {};
        uint16_t hatchOpening = 0xFFFF;
        uint32_t breachSeen[kVNodesPerSlot] = {};
        int occupants = 0;           // from the last readback
        uint64_t validFrom = ~0ull;  // first readback frame after the slot's node state was cleared on the GPU
    };
    void buildSlot(uint32_t s, const Building& b, const std::vector<int>& soldiersPerLevel, const std::vector<uint32_t>& shooterPerLevel);
    BuildingId find(float x, float z) const;

    GpuContext* gpu_ = nullptr;
    CrowdSim* sim_ = nullptr;
    HordeBridge* bridge_ = nullptr;
    SDL_GPUComputePipeline* pipe_ = nullptr;
    SDL_GPUBuffer *nodes_ = nullptr, *entr_ = nullptr, *state_ = nullptr, *occ_[2] = {nullptr, nullptr};
    SDL_GPUTransferBuffer* upload_ = nullptr;
    int occIn_ = 0;
    std::array<Slot, kVMaxActive> slots_{};
    std::vector<uint8_t> nodeData_, entrData_;   // CPU images (48 B / 32 B records)
    uint32_t nEntr_ = 0;
    bool dirty_ = true, sync_ = false;
    uint64_t lastStep_ = 0;
    std::vector<uint32_t> clearSlots_;
    std::vector<BuildingState> view_;
    std::vector<std::pair<uint32_t, uint16_t>> interior_;
    std::vector<HordeSoldier> soldiers_;
    // per soldier (tick): building slot / level, for interior attackers
    struct Placed { uint32_t packed; int slot; uint8_t level; };
    std::vector<Placed> placed_;
    Stats st_;
    struct RbSlot { SDL_GPUTransferBuffer* tb = nullptr; uint64_t frame = 0; bool pending = false; };
    std::array<RbSlot, 3> ring_{};
    double time_ = 0;
};

} // namespace ttz::game

namespace ttz { struct SimParams; }
namespace ttz::game {
// Self-test section "vertical horde" (src/game/HordeVerticalTest.cpp). Returns the number of failed checks.
int selfTestHordeVertical(GpuContext& gpu, const SimParams& params);
}
