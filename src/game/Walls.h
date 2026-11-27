#pragma once
// Free-form wall construction (Milestone B2, GAME_DESIGN 5 / 14b). CPU only (no GPU, no SDL): placement planning
// and validation, the wall network (nodes + 4 m pieces), joint selection, health / pressure damage / breaches, and
// the oriented footprints that GameWorld stamps into the zombies' static height grid (CityVehicles::addObstacle) and
// that Territory rasterises.
//
// Network: a wall is a set of nodes (joints, snapped to the 1 m grid or to existing nodes) and pieces between two
// nodes. A drawn leg of length L is split into n = round(L / 4) pieces of the approved 4 m straight (or gate) asset,
// uniformly scaled by L / 4n (0.75 .. 1.33; the collision footprint uses the same scale). Each node shows the joint
// asset its connections need: 1 piece -> end cap, 2 (bent > 8 deg) -> corner post, 2 straight -> nothing (butt joint),
// 3 -> T post, 4+ -> X post. Every connected node also gets a square collision post so bends never leave a gap.
// Mixed types at a node take the taller post.
// Validation (plan): every piece footprint sampled every 0.5 m: inside the simulated window, no building / water /
// steep step (base heights), no vehicle (solid heights), no overlap with other pieces / posts / supply containers,
// no joint sharper than 35 degrees, length >= 2.5 m per leg. The first failing reason is reported.
// Gates (PROPOSED, GAME_DESIGN 14b OPEN): a gate piece blocks zombies exactly like a wall (stamped into the sim grid)
// but its cells stay walkable in the soldiers' NavGrid (GameWorld lowers them), and it counts as closed for territory.
#include "game/GameTypes.h"

#include <cmath>
#include <cstdint>
#include <functional>
#include <vector>

namespace ttz::game {

struct FortConfig;

enum class WallType : uint8_t { Cheap = 0, Reinforced = 1 };
enum class JointShape : uint8_t { None = 0, End, Corner, T, X };

// Oriented box on the ground: centre, half extents along its local X / Z, yaw (yawQuat convention: local X axis =
// (cos yaw, -sin yaw)), top = height above the ground at the centre.
struct Obb {
    float cx = 0, cz = 0, hx = 0, hz = 0, yaw = 0, top = 0;
    bool contains(float x, float z, float shrink = 0.f) const {
        const float dx = x - cx, dz = z - cz, c = std::cos(yaw), s = std::sin(yaw);
        const float u = dx * c - dz * s, v = dx * s + dz * c;
        return std::fabs(u) <= hx - shrink && std::fabs(v) <= hz - shrink;
    }
    // world point of local (u, v)
    void at(float u, float v, float& x, float& z) const {
        const float c = std::cos(yaw), s = std::sin(yaw);
        x = cx + u * c + v * s; z = cz - u * s + v * c;
    }
};

// Cells (gw x gh grid at origin, cell size) touched by the box, sampled every half cell (the same rule CityVehicles
// uses for its obstacle stamps, so masks and stamps agree).
template <class F> void forEachObbCell(const Obb& b, float ox, float oz, float cell, int gw, int gh, F&& fn) {
    const float step = 0.5f * cell;
    const int nu = std::max(1, (int)std::ceil(2.f * b.hx / step)), nv = std::max(1, (int)std::ceil(2.f * b.hz / step));
    int lastX = -1, lastZ = -1;
    for (int i = 0; i <= nu; ++i)
        for (int j = 0; j <= nv; ++j) {
            float x, z;
            b.at(-b.hx + 2.f * b.hx * (float)i / (float)nu, -b.hz + 2.f * b.hz * (float)j / (float)nv, x, z);
            const int cx = (int)std::floor((x - ox) / cell), cz = (int)std::floor((z - oz) / cell);
            if (cx < 0 || cz < 0 || cx >= gw || cz >= gh || (cx == lastX && cz == lastZ)) continue;
            lastX = cx; lastZ = cz;
            fn(cx, cz);
        }
}

struct WallNode {
    float x = 0, z = 0, y = 0;
    uint16_t degree = 0;          // alive pieces attached
    bool alive = false;
    uint32_t obstacle = ~0u;      // CityVehicles obstacle id of the post (GameWorld)
};

struct WallPiece {
    uint32_t a = 0, b = 0;        // nodes
    WallType type = WallType::Cheap;
    bool gate = false;
    bool alive = false;
    float hp = 0, maxHp = 1;
    float age = 0;                // s since built (rise animation)
    float pressure = 0;           // zombies pressing on it (latest GPU count)
    float damageRate = 0;         // hp / s being lost (UI: under attack)
    float gateOpen = 0;           // 0 closed .. 1 open (visual: soldiers nearby)
    uint32_t obstacle = ~0u;      // CityVehicles obstacle id (GameWorld)
    uint32_t gen = 0;
};

struct WallRubble { Obb box; WallType type; bool gate; float y = 0, t = 0; };   // destroyed piece (visual)

// What placement validation needs from the world (GameWorld fills it from CityVehicles / HordeBridge; tests fake it).
struct WallEnv {
    std::function<float(float, float)> ground;     // static heights without vehicles / walls (buildings, water, curbs)
    std::function<float(float, float)> solid;      // ground + parked vehicles
    std::function<bool(float, float)> simulated;   // inside the simulated window
    std::vector<Obb> containers;                   // supply containers (landed or on their way down)
    float streetY = 0.f;                           // street level of the window (walls stand on the street, not on roofs)
};

struct WallPlanPiece {
    float ax = 0, az = 0, bx = 0, bz = 0, y = 0;
    int nodeA = -1, nodeB = -1;   // existing nodes snapped to (-1: new)
    bool ok = true;
    const char* why = "";
};

struct WallPlan {
    std::vector<WallPlanPiece> pieces;
    WallType type = WallType::Cheap;
    bool gate = false;
    bool valid = false;
    const char* reason = "empty";
    int price = 0;
    float length = 0;
};

class Walls {
public:
    void configure(const FortConfig& cfg);
    void reset() { nodes_.clear(); pieces_.clear(); rubble_.clear(); destroyed_.clear(); changed_ = false; }

    // Geometry per type
    static float width(WallType t) { return t == WallType::Reinforced ? 1.3f : 1.0f; }
    static float postSize(WallType t) { return t == WallType::Reinforced ? 1.2f : 1.0f; }
    float height(WallType t) const { return height_[(size_t)t]; }

    // Snapping for the tool: an existing node within 1.5 m wins (node >= 0); else, from `from` (drag), the length is
    // snapped to whole 4 m pieces along the drag direction unless `fine`; else the 1 m grid.
    V3 snap(V3 p, const V3* from, bool fine, int& node) const;
    // Plan a polyline (>= 2 points, already snapped). Cost, validity and per-piece reasons; never changes anything.
    WallPlan plan(const std::vector<V3>& pts, WallType type, bool gate, const WallEnv& env) const;
    // Build a valid plan (the caller charged Economy first). Returns the indices of the new pieces.
    std::vector<uint32_t> commit(const WallPlan& plan);

    // Damage / destruction
    void addPressure(uint32_t piece, float zombies, float dt);       // pressure damage (FortConfig rate / threshold)
    void damage(uint32_t piece, float hp);                           // direct damage (tests, explosions)
    bool destroy(uint32_t piece);                                    // breach: piece removed, rubble left
    void tick(float dt, const std::function<bool(float, float, float)>& soldierNear);   // ages, gate leaves, rubble
    // Destroyed since the last call (piece index, centre): GameWorld unstamps them, FX, notices, territory.
    struct Destroyed { uint32_t piece; float x, y, z; Obb box; };
    void takeDestroyed(std::vector<Destroyed>& out) { out.insert(out.end(), destroyed_.begin(), destroyed_.end()); destroyed_.clear(); }
    bool takeChanged() { bool c = changed_; changed_ = false; return c; }   // network changed (build / destroy)

    // Queries
    const std::vector<WallNode>& nodes() const { return nodes_; }
    std::vector<WallNode>& nodes() { return nodes_; }
    const std::vector<WallPiece>& pieces() const { return pieces_; }
    std::vector<WallPiece>& pieces() { return pieces_; }
    const std::vector<WallRubble>& rubble() const { return rubble_; }
    Obb pieceBox(uint32_t i) const;                  // collision / raster footprint (top = type height)
    Obb postBox(uint32_t node) const;                // square post (type = tallest piece at the node)
    float pieceScale(uint32_t i) const;              // render / footprint scale of the 4 m asset
    JointShape joint(uint32_t node, float& yaw, WallType& type) const;
    int nearestNode(float x, float z, float maxR) const;
    int nearestPiece(float x, float z, float maxR) const;
    uint32_t alivePieces() const;
    uint32_t aliveGates() const;
    float totalLength() const;
    int piecePrice(WallType t, bool gate) const;

    // Placement preview of the wall tool (GameUI sets it, the renderer draws ghosts of the valid pieces).
    WallPlan preview;
    bool previewOn = false;

private:
    uint32_t addNode(float x, float z, float y);
    void detach(uint32_t node);
    std::vector<WallNode> nodes_;
    std::vector<WallPiece> pieces_;
    std::vector<WallRubble> rubble_;
    std::vector<Destroyed> destroyed_;
    bool changed_ = false;
    float height_[2] = {1.6f, 2.4f}, health_[2] = {600.f, 1800.f};
    int price_[2] = {40, 110};
    float gateMul_ = 3.f, dmgPerZombie_ = 1.f, buildTime_ = 0.6f;
    int threshold_ = 3;
};

} // namespace ttz::game
