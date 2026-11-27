#pragma once
// Territory (Milestone B2, GAME_DESIGN 5 / 14b). CPU only.
//
// Event-driven rebuild (wall built / destroyed / breached, container landed): walls (gates count as closed), posts,
// supply containers and environment-blocked cells (buildings, water: base heights, cached per world cell while the
// simulation window covers them, so regions persist when the window moves away) are rasterised into a world-anchored
// grid (FortConfig::territoryCell, 1 m) over the bounding box of every structure plus a margin. A 4-connected flood
// fill from the grid border marks the outside; every remaining open 4-connected component that touches a player
// structure and covers >= minRegionArea is a region (irregular shapes, several regions, merges / splits on rebuild).
// Regions keep a stable id and their state across rebuilds by majority overlap with the previous raster (a merge
// takes the worst state of its parts, a split inherits its parent's).
//
// States (GAME_DESIGN 14b): Unsecured (open wall lines: no region), Uncleared (enclosed, zombies inside or count not
// known yet), Controlled (enclosed and zero zombies for clearDelay s), Threatened (controlled, zombies inside: income
// paused; after lossTime s it falls back to Uncleared). A breach that opens the perimeter removes the region (the
// cells become outside). Zombie counts per region come from the GPU (TerritoryGpu: one atomic per live agent into
// its cell's region slot); a region the simulation window does not cover keeps its last state.
// Income (PROPOSED rule, values UNAPPROVED): controlled area x incomePerHectarePerMin; Threatened pays nothing.
#include "game/Walls.h"

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ttz::game {

enum class RegionState : uint8_t { Unsecured = 0, Uncleared = 1, Controlled = 2, Threatened = 3 };
const char* regionStateName(RegionState s);

struct Region {
    uint32_t id = 0;              // stable across rebuilds (inherited by overlap)
    int cells = 0;
    float area = 0;               // m^2
    float cx = 0, cz = 0;         // centroid
    float x0 = 0, z0 = 0, x1 = 0, z1 = 0;   // bounds
    RegionState state = RegionState::Uncleared;
    int zombies = -1;             // latest count inside (-1: not known yet)
    float clearT = 0, threatT = 0;
    bool underAttack = false;     // a perimeter piece is losing health
    std::vector<uint32_t> perimeter;   // wall pieces bordering the region
};

struct TerritoryInput {
    const Walls* walls = nullptr;
    std::vector<Obb> containers;                    // landed supply containers (wall pieces for enclosure)
    std::function<int(float, float)> env;           // 0 unknown (outside the window), 1 open, 2 blocked (building / water)
};

struct TerritoryNotice { std::string text; bool bad = false; float x = 0, z = 0; };

class Territory {
public:
    void configure(const FortConfig& cfg);
    void reset();
    void markDirty() { dirty_ = true; }
    bool dirty() const { return dirty_; }
    void rebuild(const TerritoryInput& in);
    // Zombies per region slot (index into regions()), from the GPU count (or a test). -1 = not covered: keep state.
    void setZombieCounts(uint64_t version, const std::vector<int>& perSlot);
    void tick(float dt, const Walls* walls);

    const std::vector<Region>& regions() const { return regions_; }
    int slotAt(float x, float z) const;             // region slot (index into regions()) or -1
    const Region* regionAt(float x, float z) const { const int s = slotAt(x, z); return s >= 0 ? &regions_[(size_t)s] : nullptr; }
    float controlledArea() const;                   // m^2 (Controlled only)
    float enclosedArea() const;                     // m^2 (every region)
    double incomePerMin() const;
    uint64_t version() const { return version_; }   // bumps on every rebuild (GPU id grid, renderer)
    uint64_t rebuilds() const { return rebuilds_; }
    double lastRebuildMs() const { return rebuildMs_; }
    void takeNotices(std::vector<TerritoryNotice>& out) { out.insert(out.end(), notices_.begin(), notices_.end()); notices_.clear(); }

    // Perimeter outline for the renderer: merged cell-boundary runs, with the inward normal (towards the region).
    struct Edge { float x0, z0, x1, z1, nx, nz; uint16_t slot; };
    const std::vector<Edge>& edges() const { return edges_; }
    // Raster (tests / debug): 0 open outside, 1 open enclosed (region), 2 structure, 3 environment blocked
    float originX() const { return ox_; }
    float originZ() const { return oz_; }
    float cell() const { return cell_; }
    int width() const { return w_; }
    int height() const { return h_; }

private:
    float cell_ = 1.f, minArea_ = 16.f, clearDelay_ = 3.f, lossTime_ = 20.f;
    double incomeRate_ = 1000;
    float ox_ = 0, oz_ = 0;
    int w_ = 0, h_ = 0;
    std::vector<uint16_t> slot_;        // per cell: region slot + 1 (0 none)
    std::vector<Region> regions_;
    std::vector<Edge> edges_;
    std::unordered_map<int64_t, uint8_t> envCache_;   // world cell -> 1 open / 2 blocked (persisted beyond the window)
    std::vector<TerritoryNotice> notices_;
    uint64_t version_ = 0, rebuilds_ = 0, countsVersion_ = 0;
    uint32_t nextId_ = 1;
    double rebuildMs_ = 0;
    bool dirty_ = false;
};

} // namespace ttz::game
