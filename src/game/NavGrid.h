#pragma once
// Soldier navigation (WS-C): grid A* on the simulation window's live height grid + local steering.
//
// Source: CityVehicles::simHeights() (the window's static 0.75 m heights = max of the baked 0.5 m HGT0 samples, with
// every vehicle stamped at its current pose; water is a 1 m wall), refreshed when the window moves or vehicle rows
// change (event driven, never a per-frame rebuild). Walkable = |height - neighbour| <= stepUp (curbs 0.15 m pass,
// car roofs / walls do not). Rooftops are walkable islands: a squad dropped on a flat roof can move on that roof only
// (B1: no stairs / interiors, GAME_DESIGN 7 is B3).
// A*: 8-connected, octile heuristic, clearance (soldier radius) pre-dilated, node budget per query (bounded CPU per
// tick; queries queue and are served round-robin across ticks). Paths are string-pulled (line of sight on the grid).
// Local steering: follow the polyline, separation from squad mates, slow at the last waypoint; zombies are NOT
// avoided by the planner (they are dynamic; the AI decides to engage / hold instead).
#include "game/GameTypes.h"

#include <cstdint>
#include <vector>

namespace ttz::game {

struct PathFollow {                  // per soldier (SoldierPool::path)
    std::vector<V3> points;          // string-pulled waypoints, world (y = surface height)
    uint32_t next = 0;
    uint32_t request = 0;            // pending NavGrid request id (0: none)
    bool failed = false;             // no path: AI holds and reports (no endless retries)
    float best = 1e9f;               // stuck detection: closest approach to waypoint `bestNext` so far
    uint32_t bestNext = 0;
    float blockedFor = 0.f;          // s the straight leg to the next waypoint has been blocked (vehicle moved in)
    uint32_t quickReplans = 0;       // re-plans from a blocked leg (cheap, bounded per path)
    bool done() const { return next >= points.size(); }
};

class NavGrid {
public:
    // Rebuild walkability from a gw x gh height grid (row = z) at (ox, oz) with cell size `cell`.
    void build(const std::vector<float>& heights, int gw, int gh, float ox, float oz, float cell, float stepUp = 0.5f,
               float clearance = 0.35f);
    // Update rows [z0, z0 + rows) after vehicles moved (cheap, local).
    void updateRows(const std::vector<float>& heights, int z0, int rows);
    bool ready() const { return gw_ > 0; }

    bool walkable(float x, float z) const;
    float surface(float x, float z) const;           // walkable surface height (ground, roof)
    bool lineOfSight(V3 a, V3 b) const;              // shooting LOS: ray vs height grid (buildings / vehicles)
    // Rounds (owner feedback B1 round 3): the GPU stops rounds at the ZOMBIES' static grid, which differs from the
    // walk grid where gates are lowered (soldiers pass them). The shot layer is that grid (gates included); without
    // setShotHeights it equals the walk heights. shotLine marches it like the GPU hit test: from the muzzle cell to
    // `skipEnd` metres short of the aim point (the capsule surface), static cells above the ray stop it, except cells
    // less than 0.3 m above it within 2.5 m of the target (partial cover: car roofs; game_hits.comp does the same).
    void setShotHeights(const std::vector<float>& heights);
    void updateShotRows(const std::vector<float>& heights, int z0, int rows);
    float shotHeight(float x, float z) const;
    bool shotLine(V3 a, V3 b, float skipEnd = 0.35f) const;
    // Extra traversal cost (GAME_DESIGN 14d corpse gas, CorpseGas::navCost): a coarse w x h layer at (ox, oz) with
    // `cell` m cells, value v (0..255) adds v / 64 x scale per metre walked through it (A* only: heavy gas is avoided
    // when a way around exists, never blocked). The layer is referenced, not copied; null clears it.
    void setCostLayer(const std::vector<uint8_t>* layer, int w, int h, float ox, float oz, float cell, float scale) {
        costL_ = layer; costW_ = w; costH_ = h; costOx_ = ox; costOz_ = oz; costCell_ = cell; costScale_ = scale;
    }
    float extraCost(float x, float z) const;
    // Nearest walkable point within maxR (drop placement, formation slots, supply-point slots).
    bool nearestWalkable(V3 p, float maxR, V3& out) const;
    // Same, restricted to one island (formation slots stay reachable from the order point); island 0 = any.
    bool nearestWalkable(V3 p, float maxR, V3& out, uint32_t onIsland) const;
    // Walkable straight segment (no wall, no step > stepUp along the cells it crosses): string pulling, steering.
    bool walkLine(V3 a, V3 b) const;
    // Island id of a walkable cell (connected component; street network vs each roof). Same island = reachable.
    uint32_t island(float x, float z) const;
    // Nearest walkable point within maxR on the level `y` (|surface - y| <= tol): a soldier standing on a roof rim cell
    // snaps onto his roof, never onto the street a metre away (path starts, recovery).
    bool nearestWalkableLevel(V3 p, float maxR, float y, float tol, V3& out) const;

    // ---- Rooftops (owner feedback 2026-11-28, GAME_DESIGN 14e: "units on roofs respect the roof collisions, pathfind
    // properly and keep back from the edge"). A roof island is an elevated island (a drop of more than 2.5 m at its
    // rim; never the largest island = the street network). For each of its cells two clearances are kept, from the cell
    // centre to the nearest cell that is not part of the island (capped at kRoofScan m):
    //   edge     : the roof edge = a drop of more than 1.5 m, or a raised rim cell (parapet / ledge) with such a drop
    //              within 2 cells of it
    //   obstacle : anything else rising out of the roof or a small step down (HVAC units, water tanks, stair housings,
    //              skylights, the other level of a stepped roof)
    // A* adds a cost for roof cells closer than roofEdgeInset to the edge or roofObstacleMargin to an obstacle (paths
    // keep off the rim and go around roof objects with a margin), and string pulling never cuts a leg through cells
    // closer to the rim than the A* path itself went.
    static constexpr float kRoofScan = 3.0f;
    float roofEdgeInset = 1.2f;      // m: idle / standing positions keep at least this far from the roof edge
    float roofObstacleMargin = 0.6f; // m: clearance margin kept from roof objects (A* cost, standing positions)
    bool roofIsland(uint32_t island) const { return island < islandRoof_.size() && islandRoof_[island]; }
    bool onRoof(float x, float z) const { return roofIsland(island(x, z)); }
    // Clearances of the cell containing (x, z) (cell centre; kRoofScan when off a roof island or farther).
    float cellEdge(float x, float z) const;
    float cellObstacle(float x, float z) const;
    // Exact clearance of the POINT (x, z) to the nearest edge / obstacle cell square of its roof island (kRoofScan when
    // not on a roof island): tests, steering decisions.
    float edgeClearance(float x, float z) const;
    float obstacleClearance(float x, float z) const;
    // Nearest standing spot (cell centre) on `island` (0: the island at p) within maxR whose clearances are at least
    // minEdge / minObs. Relaxes nothing: false when no such cell exists.
    bool insetSpot(V3 p, float maxR, float minEdge, float minObs, uint32_t island, V3& out) const;
    // Cells of one island reachable from p (flood over the island, at most maxCells, within maxR of p), nearest first:
    // the roof-surface picker of drops / crates searches these.
    void islandCells(V3 p, float maxR, int maxCells, std::vector<V3>& out) const;

    // Asynchronous-style queries served in budgeted slices from tick(): returns a request id (> 0).
    uint32_t requestPath(V3 from, V3 to);
    bool poll(uint32_t request, std::vector<V3>& out, bool& failed);   // true when finished (out valid unless failed)
    void tick(int nodeBudget = 20000);               // expand pending queries (called once per game tick)
    void cancel(uint32_t request);                   // forget a query (soldier died / got a new order)
    size_t pending() const { return queries_.size(); }
    int maxNodesPerQuery = 150000;                   // a query expanding more nodes fails (no endless searches)
    struct Stats { uint64_t queries = 0, failed = 0, expanded = 0, ticksBusy = 0; };
    const Stats& stats() const { return st_; }

    float originX() const { return ox_; }
    float originZ() const { return oz_; }
    float cell() const { return cell_; }
    int width() const { return gw_; }
    int height() const { return gh_; }

private:
    int gw_ = 0, gh_ = 0;
    float ox_ = 0, oz_ = 0, cell_ = 0.75f, stepUp_ = 0.5f, clearance_ = 0.35f;
    std::vector<float> h_;
    std::vector<float> shotH_;       // zombies' static grid (rounds), same layout as h_
    std::vector<uint8_t> walk_;
    const std::vector<uint8_t>* costL_ = nullptr;   // setCostLayer
    int costW_ = 0, costH_ = 0;
    float costOx_ = 0, costOz_ = 0, costCell_ = 1.f, costScale_ = 0.f;
    std::vector<uint32_t> island_;
    std::vector<uint8_t> islandRoof_;   // per island id: elevated roof island
    std::vector<float> edgeD_, obsD_;   // roof clearances per cell (kRoofScan off roofs)
    std::vector<float> min5_;           // lowest height within 2 cells (parapet test)
    void computeRoof(int z0, int z1);
    float roofPenalty(size_t c) const;  // A* extra cost per step of a roof cell near the rim / an obstacle
    bool walkLinePen(V3 a, V3 b, float maxPen) const;   // walkLine that never crosses a cell with a higher penalty
    float clearanceAt(float x, float z, bool edge) const;
    struct Query { uint32_t id; V3 from, to; bool done = false, failed = false, started = false; std::vector<V3> result; int expanded = 0; };
    std::vector<Query> queries_;
    uint32_t nextId_ = 1;
    Stats st_;
    // A* state of the query in progress (one at a time, FIFO; arrays stamped by search id, no per-query clears)
    struct Open { float f; uint32_t c; };
    std::vector<float> g_;
    std::vector<uint32_t> parent_, stamp_;
    std::vector<uint32_t> closed_;
    std::vector<Open> open_;
    uint32_t searchStamp_ = 0;
    uint32_t goalCell_ = 0;
    void computeWalk(int z0, int z1);
    void computeIslands();
    bool edge(int i, int j, int di, int dj) const;   // passable step from cell (i, j) to (i + di, j + dj)
    bool cellOf(float x, float z, int& i, int& j) const;
    V3 centre(int i, int j) const;
    bool startQuery(Query& q);
    bool expand(Query& q, int& budget);
    void finish(Query& q, uint32_t goal);
};

} // namespace ttz::game
