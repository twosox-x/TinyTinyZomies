#pragma once
// GAME_DESIGN 14e structures (mechanics APPROVED, values UNAPPROVED in balance.json "structures"):
//   Defense tower : built by engineers (a construction job like a wall piece). Snipers / riflemen ordered to occupy it walk
//                   to the ladder, climb (climbTime) and hold a post on the deck (POST_FIRING, kStructurePost | tower):
//                   eyes at deck + eye height, they fire over the parapet. Zombies cannot climb it (owner decision
//                   2026-11-28): the base is a tall obstacle (towerObstacleTop) they press against and heap up around
//                   (the existing crowd / corpse-pile rules), and four base proxies (Combat::extraCapsules) report the
//                   zombies at the base: (attackers - towerPressureThreshold) x towerDamagePerZombie hp / s. A destroyed
//                   tower collapses: obstacle removed, occupants fall (fallDamage) and are released.
//   Generator     : built by engineers. Runs while it powers at least one floodlight, has fuel in its tank and (PROPOSED
//                   lightsOnlyAtNight) it is night or the lights are forced on; burns generatorBurn + burnPerLight x lit
//                   lights l / s. The tank refills from a fuel store within fuelLinkRange (base fuel stock).
//                   Noise (owner decision 2026-11-28): running generators attract zombies; generators within
//                   noiseStackRadius form one area whose strength ADDS UP (n x noiseIntensity, capped at noiseCap; reach
//                   noiseRadius x sqrt(sum / noiseIntensity), capped at noiseRadiusCap): one noise pulse per area every
//                   noiseInterval s (Combat::addNoise -> horde attractors).
//   Floodlight    : placed within cableRange of a generator (built or planned), built by engineers; lit while a running
//                   generator powers it (each generator powers up to generatorMaxLights, nearest first). Lit lights are
//                   real point lights (StructuresGame.cpp -> renderer lights).
//   Fuel store    : base fuel stock (fuelStoreCapacity l each, fuelStoreStart l when built). Engineers deliver fuel here
//                   (FuelLogistics: siphoned / disassembled cars), generators draw from it.
// No GPU and no App here (CPU, testable); the App side (obstacles, drawing, lights, UI, script verbs) is StructuresGame.cpp.
#include "game/EngineerAI.h"
#include "game/GameContext.h"
#include "game/GameEvents.h"
#include "game/HordeInterface.h"

#include <array>
#include <functional>
#include <string>
#include <vector>

namespace ttz::game {

enum class StructureKind : uint8_t { Tower = 0, Generator = 1, Light = 2, FuelStore = 3, Count = 4 };
const char* structureName(StructureKind k);
bool structureKindFrom(const std::string& s, StructureKind& out);   // tower | generator | light | fuel

struct Structure {
    StructureKind kind = StructureKind::Tower;
    V3 pos;                          // footprint centre on the ground
    float yaw = 0.f;                 // Obb / prop convention (front = local +Z)
    float build = 0.f;               // 0..1 (engineers); >= 1 solid
    float health = 1.f;
    bool alive = true;
    bool solid() const { return alive && build >= 1.f; }
    // tower
    std::array<SoldierId, 4> occ{};  // occupants (towerCapacity <= 4)
    uint32_t obstacle = ~0u;         // CityVehicles obstacle id (towers, generators)
    int attackers = 0;               // zombies at the base (latest horde contacts of the proxies)
    // generator
    float tank = 0.f;
    bool running = false;
    int powered = 0;                 // lights it powers now
    // floodlight
    int source = -1;                 // generator index powering it (-1 none)
    bool lit = false;
    // fuel store
    float fuel = 0.f;
};

struct StructureNotice { std::string text; bool bad = false; V3 pos; };

class Structures {
public:
    // ---- App hooks (StructuresGame.cpp; null in CPU tests)
    std::function<uint32_t(const Structure&)> addObstacle;      // stamp the base (returns an obstacle id)
    std::function<void(uint32_t)> removeObstacle;
    std::function<bool(float x, float z, float r)> blockedAt;   // parked vehicle / building / water under the footprint
    bool night = false;              // GameWorld: time of day (18:00 .. 06:00)
    bool forceLights = false;        // script / UI: lights on by day too

    static Obb footprint(StructureKind k, V3 pos, float yaw, const StructureConfig& S);
    // placement rule: engineer range (unless instant build), lights need a generator within cableRange, no overlap
    bool canPlace(const GameContext& ctx, StructureKind k, V3 pos, float yaw, const char** why) const;
    int place(GameContext& ctx, StructureKind k, V3 pos, float yaw);   // the caller charged it; blueprint (or built: cheat)
    int price(const BalanceConfig& cfg, StructureKind k) const;

    // towers
    bool occupy(GameContext& ctx, SquadId squad, int tower, std::string& msg);   // free posts filled by the squad
    void release(GameContext& ctx, uint32_t soldier);                            // back on the ground at the ladder foot
    int nearest(StructureKind k, float x, float z, float r, bool solidOnly = false) const;
    V3 postPos(int tower, int slot, const StructureConfig& S) const;
    V3 ladderFoot(int tower, const StructureConfig& S) const;
    int occupants(int tower) const;
    void forceAttackers(int tower, int n) { if (tower >= 0) { if (forced_.size() <= (size_t)tower) forced_.resize((size_t)tower + 1, -1); forced_[(size_t)tower] = n; } }   // TEST HOOK
    void damage(int s, float hp);                                                // TEST HOOK / explosions later

    // tick order (GameWorld): preAi before SoldierAI (new orders release tower posts), tick after BuildingPlay::tick
    // (climb, posts pinned, tower pressure, generators, lights, noise), preCombat fills Combat::extraCapsules.
    void preAi(GameContext& ctx);
    void tick(GameContext& ctx);
    void preCombat(const GameContext& ctx, std::vector<HordeSoldier>& capsules) const;

    // EngineerAI external jobs (owner 1): every blueprint
    void jobs(const GameContext& ctx, std::vector<EngineerAI::ExternalJob>& out) const;
    float work(GameContext& ctx, const EngineerAI::ExternalJob& j, float add);

    // fuel stock (all fuel stores)
    float fuelStock() const;
    float fuelCapacity() const;
    int storeFor(V3 from) const;                                   // nearest solid fuel store with room (-1 none)
    V3 deliveryPoint(int store, const StructureConfig& S) const;
    float addFuel(int store, float litres);                        // returns what fit

    const std::vector<Structure>& all() const { return list_; }
    std::vector<NoiseEvent>& noise() { return noise_; }
    void takeNotices(std::vector<StructureNotice>& out) { out.insert(out.end(), notices_.begin(), notices_.end()); notices_.clear(); }
    struct Area { V3 pos; int generators = 0; float strength = 0.f, radius = 0.f; };
    const std::vector<Area>& noiseAreas() const { return areas_; }   // last pulse (tests / HUD)
    struct Stats { uint32_t placed[4] = {0, 0, 0, 0}, built[4] = {0, 0, 0, 0}, towersDestroyed = 0, climbed = 0, released = 0; double fuelBurned = 0, fuelIn = 0; };
    const Stats& stats() const { return stats_; }
    bool onTower(uint32_t soldier) const { return soldier < phase_.size() && phase_[soldier] == 3; }
    int towerOf(uint32_t soldier) const { return soldier < tower_.size() ? tower_[soldier] : -1; }

private:
    void finish(GameContext& ctx, int s);
    void collapse(GameContext& ctx, int t);
    void walkTo(GameContext& ctx, uint32_t i, V3 goal);
    void notice(const std::string& t, bool bad, V3 p) { notices_.push_back({t, bad, p}); }
    std::vector<Structure> list_;
    std::vector<int> forced_;
    std::vector<NoiseEvent> noise_;
    std::vector<StructureNotice> notices_;
    std::vector<Area> areas_;
    float noiseT_ = 0.f;
    // per soldier slot: tower (-1), phase (0 none, 1 to the ladder, 2 climbing, 3 posted), post slot, timer, order serial
    std::vector<int> tower_, slot_;
    std::vector<uint8_t> phase_;
    std::vector<float> t_;
    std::vector<uint32_t> serial_;
    std::vector<V3> from_;
    Stats stats_;
};

} // namespace ttz::game
