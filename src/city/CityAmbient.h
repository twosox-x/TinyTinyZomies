#pragma once
// Ambient zombie population of the city: where idle zombies stand when nothing has drawn them anywhere, and the
// roaming behaviour parameters (GPU side: sim_predict roamVelocity). Values come from the "ambient" section of
// config/balance.json and are UNAPPROVED provisional values.
//
// Placement (CPU, once per window / newly visited 48 m block) from the window's static heights only:
//   open ground = cells with no static height; distance to the nearest building (chamfer) and local building
//   coverage (40 m box) weight the cells: sidewalks and building entrances (1-4 m from a wall) most, streets and
//   plazas normally, open fields (> 25 m from any building) little; denser built-up blocks hold more zombies.
//   Groups: scattered singles, small groups of 2-8, occasional clusters of 10-24 in the most built-up spots.
#include "sim/GpuTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ttz {

struct SimParams;

struct AmbientConfig {
    // population
    float densityPerHa = 220.f;      // zombies per hectare of open ground (before the built-up weighting)
    float singleChance = 0.55f;      // per group: a lone zombie
    float clusterChance = 0.03f;     // per group: a larger cluster (10-24) in a built-up spot; the rest: 2-8
    float edgeWeight = 1.8f;         // 1-4 m from a building (sidewalks, entrances)
    float openWeight = 0.2f;         // > 25 m from any building (open fields, parks)
    float builtUpWeight = 1.6f;      // extra weight x local building coverage (0..1)
    // behaviour (SimParams roam*)
    float wanderSpeed = 0.45f, pauseFraction = 0.35f, alertMemory = 25.f, separation = 0.6f;
    float lurkerFraction = 0.12f, crawlerFraction = 0.03f, fieldWavelength = 70.f;

    bool load(const std::string& balancePath, std::string* error = nullptr);   // "ambient" section; missing keys keep defaults
    void apply(SimParams& p) const;                                            // roam* parameters, roamEnabled = true
};

// Spawn points {x, z, jitter, 0} for the open cells of a window (heights gw x gh at origin ox, oz, cell size `cell`)
// accepted by `include(x, z)` (empty: all). count < 0: from the density; otherwise exactly `count` (if there is room).
std::vector<Vec4> ambientSpawnPoints(const std::vector<float>& heights, int gw, int gh, float ox, float oz, float cell,
                                     const AmbientConfig& cfg, uint32_t seed, int count,
                                     const std::function<bool(float, float)>& include = {});

// Spatial statistics of a set of positions (self-test, tools): nearest-neighbour distances and single-linkage
// clusters (link distance `link` m).
struct SpreadStats {
    size_t n = 0;
    float nnMedian = 0, nnP10 = 0, nnMean = 0, fracNnBelow1m = 0;
    size_t clusters = 0, largestCluster = 0, singles = 0;
    float meanClusterSize = 0, fracInClustersOver20 = 0;
};
SpreadStats spreadStats(const std::vector<float>& xz, float link = 2.0f);

} // namespace ttz
