#pragma once
// Dynamic city vehicles: the baked VEHI instances react to explosions.
//
//  - State lives on the CPU (up to ~15 k vehicles city-wide, a few thousand in the simulation window; only the ones
//    hit by a blast integrate, the rest sleep). Per vehicle: pose (centre of mass + quaternion), linear / angular
//    velocity, health, fuse / burn timers, state (intact -> damaged -> burning -> wrecked), current variant / paint.
//    Keyed by tile + index (registerTile, from the renderer's tile uploads): what happened to a vehicle persists when
//    the window or the renderer's residency moves away and back.
//  - Blasts: every explosion accepted by CrowdSim (player, scripted, vehicles) is read from its explosion log. Vehicles
//    inside the window within the blast radius (distance to the box surface) take damage and an impulse at the
//    nearest point of their box (push + lift + tumble). Rigid bodies (box inertia) integrate at 120 Hz with gravity
//    and corner contacts against the window's height grid: ground / roofs / parked vehicles from above, walls
//    sideways; restitution + friction; they sleep once settled (on wheels, side or roof).
//  - Burning vehicles explode after a 0.5-3 s fuse: a new CrowdSim explosion (zombies, gibs, blood, scorch, fireball;
//    fuel tankers 2.2x) that feeds back into the log -> chain reactions through jammed traffic. At most
//    kMaxBlastsPerFrame vehicle explosions per frame (the rest wait their turn). Wrecks swap to the kind's burnt (or
//    crashed) variant and keep burning for a while (flame / smoke emitters through CrowdSim::requestFire, point lights).
//  - Obstacles: the sim's static height grid of the window = baked heights with the baked vehicle footprints replaced
//    by the ground, plus every vehicle stamped at its current pose (sleeping vehicles always; moving ones while within
//    2 m of the ground). Rows that change are uploaded each frame (CrowdSim::uploadStaticRows); agents inside a newly
//    stamped cell leave through its nearest face (sim_solve). Vehicles outside the window stay as they are.
#include "city/CityAsset.h"

#include <SDL3/SDL_gpu.h>

#include <cstdint>
#include <algorithm>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ttz {

class CrowdSim;
struct PointLight;
struct FireVolume;

enum class VehState : uint8_t { Intact = 0, Damaged = 1, Burning = 2, Wrecked = 3 };

struct VehicleModel {
    std::string kind;
    int stateTag = 0;                   // 0 ok, 1 damaged, 2 crashed, 3 burnt (from the variant key)
    float bmin[3] = {-2, 0, -1}, bmax[3] = {2, 1.5f, 1};   // model space
    float mass = 1.f, blastScale = 1.f;
    bool dynamic = true;                // false: traffic props (cones, debris ...)
    int damaged = -1, burnt = -1;       // variant indices (self if none)
    bool darkenBurnt = false;           // no burnt mesh for the kind: tint the paint charcoal
};

struct Vehicle {
    float bp[3], bq[4];                 // baked model origin / rotation
    float p[3], q[4];                   // centre of mass, rotation
    float v[3] = {0, 0, 0}, w[3] = {0, 0, 0};
    float ro[3];                        // render: model origin = p - R com
    float paint[4];
    float health = 100.f, fuse = 0.f, burn = 0.f, still = 0.f, awake = 0.f;
    uint16_t variant = 0, bakedVariant = 0;
    VehState state = VehState::Intact;
    bool custom = false;                // pose / variant / paint differ from the baked instance
    bool active = false;                // integrating (not asleep)
    bool queued = false;                // waiting for an explosion slot
    bool inWindow = false;
    bool contact = false;
    bool removed = false;               // cleared by engineers (GAME_DESIGN 14d): not drawn, no collision, persistent
    bool drained = false;               // fuel siphoned by engineers (GAME_DESIGN 14e): never ignites / explodes
    int16_t sx0 = 0, sz0 = 0, sx1 = -1, sz1 = -1;   // cells it is stamped into (sim grid), empty if x1 < x0
};

struct VehicleStats {
    uint32_t known = 0, inWindow = 0, active = 0, burning = 0, wrecked = 0, custom = 0;
    uint32_t explosions = 0, blastsTaken = 0;       // cumulative
    uint32_t uploadedRows = 0;                       // last frame
    // last update(): CPU ms per phase (blasts from the log, fuses + explosions, rigid bodies, obstacle grid + upload)
    float msBlast = 0, msFuse = 0, msIntegrate = 0, msGrid = 0;
    uint32_t uploadBytes = 0, substeps = 0;
};

class CityVehicles {
public:
    static constexpr int kMaxBlastsPerFrame = 2;
    void init(const std::vector<ModelVariant>& variants);   // variant names = city.json keys
    void initModels(std::vector<VehicleModel> models);       // tests: explicit models
    void clear();                                             // forget every vehicle (new city)

    // Vehicles (kind 0) of a tile, in instance order (they come first). Tiles already known are ignored (the state
    // persists); a new tile overlapping the window is folded into its height grids.
    void registerTile(int key, const std::vector<CityInstance>& instances);
    // The simulation window (origin, cells) and its baked static heights (as CrowdSim got them). Uploads the dynamic
    // grid with the next update().
    void setWindow(float ox, float oz, float cell, int gw, int gh, const std::vector<float>& heights);
    // Per frame (before the simulation steps): blasts from sim's explosion log, rigid bodies, fuses, explosions,
    // flames; uploads changed rows of the obstacle grid. dt = simulated seconds (0 when paused).
    // onBlast(x, y, z, scale) for every vehicle explosion (renderer flash, camera shake).
    void update(SDL_GPUCommandBuffer* cmd, float dt, CrowdSim& sim, const std::function<void(float, float, float, float)>& onBlast = {});

    // Rendering: the vehicles of a tile (null if unknown), parallel to its kind-0 instances.
    const Vehicle* tileVehicles(int key, uint32_t& count) const;
    // Vehicles whose pose / look differ from the bake (drawn from here, not from the tile's instance list).
    const std::vector<uint32_t>& customList() const { return custom_; }
    const Vehicle& vehicle(uint32_t i) const { return all_[i]; }
    Vehicle& vehicle(uint32_t i) { return all_[i]; }
    uint32_t count() const { return (uint32_t)all_.size(); }
    const VehicleModel& model(uint32_t v) const { return models_[v]; }
    uint32_t vehicleIndex(int key, uint32_t i) const;   // UINT32_MAX if unknown
    // Up to maxCount flickering lights of burning vehicles nearest (x, z).
    void fireLights(float x, float z, double time, int maxCount, std::vector<PointLight>& out) const;
    // Burning vehicles nearest (x, z) as voxel fire / smoke volumes for the renderer (centre, length, strength 0..1).
    void fireVolumes(float x, float z, int maxCount, std::vector<FireVolume>& out) const;

    // Window grids (tests): the obstacle heights uploaded to the sim, the ground used for vehicle collisions.
    const std::vector<float>& simHeights() const { return simH_; }
    float groundAt(float x, float z) const;             // base heights (no vehicles)
    float solidAt(float x, float z) const;              // base + sleeping vehicles
    void worldCorners(const Vehicle& v, float out[8][3]) const;
    const std::vector<Vehicle>& vehicles() const { return all_; }   // read-only (Military Lab landing spots)
    const VehicleStats& stats() const { return stats_; }

    // Gameplay obstacles (B2 walls, gate / joint posts, supply containers): oriented boxes (centre, half extents, yaw
    // in the yawQuat convention: local X = (cos yaw, -sin yaw)) whose cells are raised to `top` (absolute height) in
    // the zombies' obstacle grid on top of the baked heights (not in groundAt / solidAt). They are kept across window
    // moves; add / remove only mark the rows they cover, which go up with the next update() (event driven).
    uint32_t addObstacle(float cx, float cz, float halfX, float halfZ, float yaw, float top);
    // Engineers (GAME_DESIGN 14d): the parked (sleeping, intact or wrecked) vehicle in the window nearest (x, z) whose
    // box is within maxR (UINT32_MAX: none), its ground box (centre, half extents, yaw as above), and its removal:
    // the instance is no longer drawn, its cells return to the ground (rows re-uploaded), it never comes back.
    uint32_t parkedAt(float x, float z, float maxR) const;
    void groundBox(uint32_t i, float& cx, float& cz, float& hx, float& hz, float& yaw) const;
    bool removeVehicle(uint32_t i);
    // GAME_DESIGN 14e: the fuel was siphoned; a blast can still damage / wreck it but it never burns or explodes.
    void setDrained(uint32_t i) { if (i < all_.size()) all_[i].drained = true; }
    void removeObstacle(uint32_t id);
    uint32_t obstacleCount() const { uint32_t n = 0; for (const GameObstacle& o : gobst_) n += o.alive ? 1 : 0; return n; }
    // Row runs (first row, count) the last update() uploaded, and a counter bumped by every update() (consumers
    // such as the soldiers' NavGrid patch the same rows instead of rebuilding).
    const std::vector<std::pair<uint32_t, uint32_t>>& uploadedRuns() const { return runs_; }
    uint64_t updateSerial() const { return updateSerial_; }
    void seed(uint32_t s) { rng_ = s ? s : 1u; }
    bool enabled = true;

private:
    struct GameObstacle { float cx, cz, hx, hz, yaw, top; bool alive; };
    void stampObstacle(const GameObstacle& o, std::vector<float>& grid) const;
    std::vector<GameObstacle> gobst_;
    uint64_t updateSerial_ = 0;
    void wake(uint32_t i);
    void sleep(uint32_t i);
    void blast(uint32_t i, float cx, float cy, float cz, float scale);
    void explode(uint32_t i, CrowdSim& sim, const std::function<void(float, float, float, float)>& onBlast);
    void setVariant(Vehicle& v, uint16_t variant);
    void integrate(uint32_t i, float dt);
    void updateRenderOrigin(Vehicle& v) const;
    void com(const Vehicle& v, float out[3]) const;
    // grids
    void addToWindow(uint32_t i);
    void computeRect(Vehicle& v) const;
    void clearBakedFootprint(const Vehicle& v);
    void stamp(const Vehicle& v, std::vector<float>& grid, const int* rows, float inset) const;
    void restampSolid(int x0, int z0, int x1, int z1, uint32_t except);
    void markDirty(int z0, int z1) {
        z0 = std::max(z0, 0); z1 = std::min(z1, gh_ - 1);
        for (int z = z0; z <= z1; ++z) rowDirty_[(size_t)z] = 1;
    }
    float rand01();

    std::vector<VehicleModel> models_;
    std::vector<Vehicle> all_;
    std::unordered_map<int, std::pair<uint32_t, uint32_t>> tiles_;   // key -> (first, count)
    std::vector<uint32_t> custom_, window_, explodeQueue_;
    float ox_ = 0, oz_ = 0, cell_ = 0.75f;
    int gw_ = 0, gh_ = 0;
    // base_: baked heights without the baked vehicles; solid_: + sleeping vehicles (inset 0.25 m, vehicle physics);
    // obst_: + sleeping vehicles (whole box): the static part of the zombies' obstacle grid simH_, kept up to date on
    // wake / sleep, so a frame only rebuilds the rows active vehicles touch (copy obst_ + stamp the low active ones)
    std::vector<float> base_, solid_, obst_, simH_, uploaded_;
    std::vector<uint8_t> rowDirty_;        // rows of simH_ to recompute / compare / upload
    std::vector<uint32_t> act_;            // scratch (active vehicles of this update)
    std::vector<std::pair<uint32_t, uint32_t>> runs_;   // scratch (changed row runs)
    float acc_ = 0.f;
    uint32_t rng_ = 0x9E3779B9u, fireCursor_ = 0;
    VehicleStats stats_;
};

} // namespace ttz
