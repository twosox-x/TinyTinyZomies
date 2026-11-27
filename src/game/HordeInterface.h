#pragma once
// What the gameplay layer needs from the GPU horde, as plain data with explicit latency.
//
// Two implementations:
//   HordeBridge (HordeBridge.h, WS-A): the real one. Uploads soldiers / hits / attractors once per game tick, records
//     compute passes around CrowdSim::step, and harvests results through an async readback ring (2-3 frames late,
//     never a synchronous wait during gameplay; GAME_DESIGN 12).
//   FakeHorde (tests, WS-C/WS-D): CPU zombies as points; same interface, zero latency or a configurable one.
// Gameplay code (SoldierAI, Combat, Economy) only ever sees this interface, so WS-C/WS-D can be built and tested
// before WS-A lands.
//
// Identity: GPU agents are re-sorted by cell every step, so there is no stable zombie index on the CPU. The CPU never
// names a zombie. It aims at a *point* (from the coarse zombie field) and the GPU resolves which zombie a round
// actually hits (first capsule along the ray). Kill credit comes back as KillEvents (see GameEvents.h for dedupe).
#include "game/GameEvents.h"

#include <cstdint>
#include <vector>

namespace ttz::game {

// Soldier as the horde sees it (uploaded each game tick, <= kMaxGpuSoldiers).
struct HordeSoldier {
    V3 pos;                  // feet
    float radius = 0.35f;    // capsule (zombies collide with it: sim_solve treats it as infinite mass)
    float height = 1.75f;
    uint32_t packedId = 0;   // Handle::packed()
    float attraction = 1.f;  // attractor strength (0: invisible to the horde, e.g. while under canopy)
};
constexpr uint32_t kMaxGpuSoldiers = 2048;   // stress target is 1000 (GAME_DESIGN 14b); not a gameplay limit
constexpr uint32_t kMaxHitsPerTick = 4096;
constexpr uint32_t kMaxKillsPerFrame = 1024;  // overflow is counted (killsOverflowed), never lost for rewards

// Ray-cast round. Resolved on the GPU against the agents in the cells along the ray (cell lists of the last step),
// stopped by static geometry (sim static height grid, includes vehicles). Damage goes through sim_predict's existing
// health / blood / dismember / death path (GAME_DESIGN 14b).
struct HitRequest {
    V3 origin, dir;
    float maxDist = 50.f;
    float damage = 0.6f;
    uint32_t shooterPacked = 0;
    uint32_t flags = 0;      // bit 0: headshot (kill + sever head if this ray hits), bit 1: suppressed (less blood spray)
};

// Coarse zombie occupancy for target acquisition: the sim window split into tiles of kFieldTileCells x kFieldTileCells
// sim cells (6 m at 0.75 m). Per tile: live walker count and up to kFieldSamples sample positions.
constexpr uint32_t kFieldTileCells = 8, kFieldSamples = 4;
struct ZombieFieldTile {
    uint32_t count = 0;
    uint32_t samples = 0;    // valid entries in pos (<= kFieldSamples)
    V3 pos[kFieldSamples];
};
struct ZombieField {
    uint64_t frame = 0;      // frame the GPU produced it (latency = current frame - frame)
    float originX = 0, originZ = 0, tileSize = 6.f;
    uint32_t tilesX = 0, tilesZ = 0;
    std::vector<ZombieFieldTile> tiles;   // tilesX * tilesZ, row = z
    const ZombieFieldTile* at(float x, float z) const {
        int i = (int)((x - originX) / tileSize), j = (int)((z - originZ) / tileSize);
        if (i < 0 || j < 0 || i >= (int)tilesX || j >= (int)tilesZ) return nullptr;
        return &tiles[(size_t)j * tilesX + (size_t)i];
    }
};

// Zombies pressing on a soldier (per uploaded soldier, same order as the last uploadSoldiers()).
struct SoldierContact {
    uint32_t packedId = 0;
    uint16_t attackers = 0;   // live walkers / climbers within ThreatConfig.attackReach of the capsule
    uint16_t nearby = 0;      // within 8 m (threat response)
    float nearestDist = 1e9f;
};

// Horde attractor (zombies' flow field source): soldiers, noise. Bounded list (kMaxAttractors; HordeBridge keeps the
// strongest). Zombies whose path distance to it is within awareness x strength steer towards it; zombies beyond the
// reach of every attractor get no flow and wander. radius: footprint seeded around pos (0.75..8 m).
// awareness 0: the bridge default (ZombieThreatConfig.awarenessRadius via HordeBridge::setAwarenessRadius).
struct Attractor { V3 pos; float strength = 1.f, radius = 2.f, awareness = 0.f; };
constexpr uint32_t kMaxAttractors = 256;

class HordeInterface {
public:
    virtual ~HordeInterface() = default;
    // ---- inputs, once per game tick (applied by the next simulation step) ---------------------------------------
    virtual void uploadSoldiers(const std::vector<HordeSoldier>& soldiers) = 0;
    virtual void queueHits(const std::vector<HitRequest>& hits) = 0;
    virtual void setAttractors(const std::vector<Attractor>& attractors) = 0;
    virtual void requestExplosion(V3 pos, float scale) = 0;   // existing CrowdSim path (grenades later; vehicles today)
    // ---- outputs, newest harvested data (never blocks) ------------------------------------------------------------
    virtual const ZombieField& field() const = 0;
    virtual const std::vector<SoldierContact>& contacts() const = 0;
    // Kill events harvested since the last call, already deduplicated by seq.
    virtual void takeKills(std::vector<KillEvent>& out) = 0;
    virtual uint64_t killsOverflowed() const = 0;   // total kills the ring could not hold (rewarded anonymously)
    // Is this point inside the simulated region? (B1: the moving window; outside it zombies are parked.)
    virtual bool simulated(float x, float z) const = 0;
};

} // namespace ttz::game
