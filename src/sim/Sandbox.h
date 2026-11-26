#pragma once
// Minimal simulation sandboxes.
//  City:  building blocks, avenue + cross street (intersection), alleys, a barricade bottleneck,
//         abandoned cars, and a defensive wall with a safe zone behind it.
//  Arena: open ground with a few pillars and a full-width wall, for large-count benchmarks
//         (the city streets physically hold only ~20k agents at full packing).
// Pure data: rasterised into the static height grid for the simulation and drawn as boxes.
#include <string>
#include <vector>

namespace ttz {

enum class BoxKind : int { Building = 0, Wall = 1, Barricade = 2, Car = 3, Lamp = 4 };

struct Box {
    float minX, minZ, maxX, maxZ, height;
    BoxKind kind;
    bool solid = true;   // rasterised into the simulation grid
};

struct Rect { float minX, minZ, maxX, maxZ; };

enum class MapKind : int { City = 0, Arena = 1, Baked = 2 };   // Baked: a window of the baked city (src/city/CityWorld)

struct Scenario {
    std::string name;
    MapKind map;
    std::vector<Rect> spawns;
    std::vector<float> goals;   // x,z pairs
    int defaultCount;
};

struct PointLight { float x, y, z, radius, r, g, b, intensity; };

struct Sandbox {
    float originX = -96.f, originZ = -96.f, cellSize = 0.75f;
    int gridW = 256, gridH = 256;
    std::vector<Box> boxes;
    std::vector<PointLight> lights;
    std::vector<Scenario> scenarios;

    MapKind map = MapKind::City;
    std::vector<float> heightOverride;   // Baked map: static height grid (gridW x gridH) sampled from the city's collision tiles
    float wallX = 0.f;          // x of the defensive wall (both maps)

    void build(float cellSize, int gridW, int gridH, MapKind map = MapKind::City);
    std::vector<float> rasterize() const;   // static obstacle top per cell
    std::vector<float> occluders(float minHeight = 3.0f) const;   // solid boxes tall enough to hide a zombie: min xyz, 0, max xyz, 0
};

} // namespace ttz
