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
    // Nearest walkable point within maxR (drop placement, formation slots, supply-point slots).
    bool nearestWalkable(V3 p, float maxR, V3& out) const;
    // Island id of a walkable cell (connected component; street network vs each roof). Same island = reachable.
    uint32_t island(float x, float z) const;

    // Asynchronous-style queries served in budgeted slices from tick(): returns a request id (> 0).
    uint32_t requestPath(V3 from, V3 to);
    bool poll(uint32_t request, std::vector<V3>& out, bool& failed);   // true when finished (out valid unless failed)
    void tick(int nodeBudget = 20000);               // expand pending queries (called once per game tick)

    float originX() const { return ox_; }
    float originZ() const { return oz_; }
    float cell() const { return cell_; }
    int width() const { return gw_; }
    int height() const { return gh_; }

private:
    int gw_ = 0, gh_ = 0;
    float ox_ = 0, oz_ = 0, cell_ = 0.75f, stepUp_ = 0.5f, clearance_ = 0.35f;
    std::vector<float> h_;
    std::vector<uint8_t> walk_;
    std::vector<uint32_t> island_;
    struct Query { uint32_t id; V3 from, to; bool done = false, failed = false; std::vector<V3> result; };
    std::vector<Query> queries_;
    uint32_t nextId_ = 1;
};

} // namespace ttz::game
