#include "sim/Sandbox.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace ttz {

static float hashf(int i) {
    uint32_t x = (uint32_t)i * 2654435761u;
    x ^= x >> 15; x *= 2246822519u; x ^= x >> 13;
    return (x & 0xFFFFFF) / 16777216.0f;
}

void Sandbox::build(float cs, int gw, int gh, MapKind mapKind) {
    map = mapKind;
    cellSize = cs;
    gridW = gw;
    gridH = gh;
    originX = -0.5f * gw * cs;
    originZ = -0.5f * gh * cs;
    const float ext = 0.5f * gw * cs;       // half extent in x
    const float extZ = 0.5f * gh * cs;
    boxes.clear();
    lights.clear();
    scenarios.clear();

    const float street = 7.0f;              // half width of avenue (z) and cross street (x)
    wallX = 0.62f * ext;                    // defensive wall position on the avenue
    if (map == MapKind::City) {
    // Building blocks in the four quadrants, separated by alleys perpendicular to the avenue.
    int seed = 1;
    for (int qx = -1; qx <= 1; qx += 2)
    for (int qz = -1; qz <= 1; qz += 2) {
        float x = street;
        while (x < ext - 1.0f) {
            float w = 12.0f + 10.0f * hashf(seed++);
            float x0 = x, x1 = std::min(x + w, ext);
            // keep the wall anchored to solid buildings on both sides (no bypass)
            if (qx > 0 && x0 < wallX + 2.0f && x1 > wallX - 2.0f) { x1 = std::max(x1, wallX + 6.0f); }
            float stories = 5.0f + std::floor(10.0f * hashf(seed++));
            float h = stories * 3.2f;
            float depth = extZ - street;
            float bx0 = qx > 0 ? x0 : -x1, bx1 = qx > 0 ? x1 : -x0;
            float bz0 = qz > 0 ? street : -street - depth, bz1 = qz > 0 ? street + depth : -street;
            // split deep blocks into a front and back building with different heights
            float split = 18.0f + 8.0f * hashf(seed++);
            if (qz > 0) {
                boxes.push_back({bx0, bz0, bx1, bz0 + split, h, BoxKind::Building});
                boxes.push_back({bx0, bz0 + split, bx1, bz1, h * (0.6f + 0.6f * hashf(seed++)), BoxKind::Building});
            } else {
                boxes.push_back({bx0, bz1 - split, bx1, bz1, h, BoxKind::Building});
                boxes.push_back({bx0, bz0, bx1, bz1 - split, h * (0.6f + 0.6f * hashf(seed++)), BoxKind::Building});
            }
            x = x1 + 3.0f;                  // 3 m alley
        }
    }

    // Defensive wall across the avenue (3.5 m, ~11 stories lower than the buildings).
    boxes.push_back({wallX, -street - 1.0f, wallX + 1.5f, street + 1.0f, 3.5f, BoxKind::Wall});

    // Barricade bottleneck on the west avenue: 3 m gap in the middle.
    float bx = -0.45f * ext;
    boxes.push_back({bx, -street, bx + 1.5f, -1.5f, 2.2f, BoxKind::Barricade});
    boxes.push_back({bx, 1.5f, bx + 1.5f, street, 2.2f, BoxKind::Barricade});

    // Abandoned cars: the crowd splits around them and merges again.
    const float cars[][3] = {{-28.f, -2.5f, 0}, {-18.f, 3.0f, 1}, {-8.5f, -4.0f, 0}, {14.f, 1.5f, 0},
                             {26.f, -3.5f, 1}, {38.f, 3.5f, 0}, {2.5f, -24.f, 2}, {-3.0f, 30.f, 2}};
    for (auto& c : cars) {
        bool alongX = c[2] < 2;
        float hl = 2.2f, hw = 1.0f;
        if (alongX) boxes.push_back({c[0] - hl, c[1] - hw, c[0] + hl, c[1] + hw, 1.5f, BoxKind::Car});
        else boxes.push_back({c[0] - hw, c[1] - hl, c[0] + hw, c[1] + hl, 1.5f, BoxKind::Car});
    }

    // Street lamps (decorative, not solid) + warm point lights along the avenue.
    for (float x = -ext + 10.f; x < ext - 5.f; x += 18.f) {
        float z = (int(x) / 18) % 2 ? street - 0.6f : -street + 0.6f;
        boxes.push_back({x - 0.12f, z - 0.12f, x + 0.12f, z + 0.12f, 5.5f, BoxKind::Lamp, false});
        lights.push_back({x, 5.3f, z * 0.85f, 16.f, 1.0f, 0.62f, 0.32f, 2.2f});
    }
    lights.push_back({wallX + 3.f, 4.f, 0.f, 18.f, 1.0f, 0.25f, 0.15f, 2.0f});   // red emergency light at the wall
    } else {
        // Arena: full-width wall, a field of pillars (crowd splits and merges), lamps along the wall.
        wallX = 0.42f * ext;
        boxes.push_back({wallX, -extZ, wallX + 1.5f, extZ, 3.5f, BoxKind::Wall});
        int k = 0;
        for (float x = -0.6f * ext; x < wallX - 15.f; x += 14.f)
            for (float z = -extZ + 10.f; z < extZ - 8.f; z += 14.f, ++k) {
                float o = (k % 2) ? 7.f : 0.f;
                boxes.push_back({x - 1.5f, z + o - 1.5f, x + 1.5f, z + o + 1.5f, 6.f + 10.f * hashf(k), BoxKind::Building});
            }
        for (float z = -extZ + 8.f; z < extZ; z += 20.f) {
            boxes.push_back({wallX + 2.5f, z - 0.12f, wallX + 2.74f, z + 0.12f, 5.5f, BoxKind::Lamp, false});
            lights.push_back({wallX + 2.6f, 5.3f, z, 18.f, 1.0f, 0.62f, 0.32f, 2.2f});
        }
    }

    // Snap solid boxes to the simulation grid so rendered and simulated geometry agree exactly.
    for (Box& b : boxes) {
        if (!b.solid) continue;
        auto snap = [&](float v, float o) { return o + std::round((v - o) / cellSize) * cellSize; };
        b.minX = snap(b.minX, originX); b.maxX = std::max(snap(b.maxX, originX), b.minX + cellSize);
        b.minZ = snap(b.minZ, originZ); b.maxZ = std::max(snap(b.maxZ, originZ), b.minZ + cellSize);
    }

    // Scenarios (spawn areas sized for realistic densities: a single layer packs ~4 agents / m^2).
    const float sx = -ext + 2.f;
    const float cityWall = 0.62f * ext, arenaWall = 0.42f * ext;
    scenarios.push_back({"City: avenue march (bottleneck, cars, wall)", MapKind::City,
                         {{sx, -street + 0.5f, -0.5f * ext, street - 0.5f}}, {ext - 12.f, 0.f}, 2500});
    scenarios.push_back({"City: intersection merge (N + S streams)", MapKind::City,
                         {{-street + 0.5f, -extZ + 2.f, street - 0.5f, -0.5f * extZ},
                          {-street + 0.5f, 0.5f * extZ, street - 0.5f, extZ - 2.f}},
                         {ext - 12.f, 0.f}, 3000});
    scenarios.push_back({"City: wall siege", MapKind::City, {{cityWall - 50.f, -street + 0.5f, cityWall - 2.f, street - 0.5f}},
                         {ext - 12.f, 0.f}, 4000});
    scenarios.push_back({"City: dispersed (all streets)", MapKind::City, {{-ext + 2.f, -extZ + 2.f, ext - 2.f, extZ - 2.f}},
                         {0.f, 0.f}, 5000});
    scenarios.push_back({"Arena: dispersed horde", MapKind::Arena, {{-ext + 2.f, -extZ + 2.f, arenaWall - 10.f, extZ - 2.f}},
                         {ext - 10.f, 0.f}, 20000});
    scenarios.push_back({"Arena: wall siege", MapKind::Arena, {{arenaWall - 30.f, -extZ + 2.f, arenaWall - 1.f, extZ - 2.f}},
                         {ext - 10.f, 0.f}, 20000});
}

std::vector<float> Sandbox::rasterize() const {
    std::vector<float> h((size_t)gridW * gridH, 0.0f);
    for (const Box& b : boxes) {
        if (!b.solid) continue;
        int x0 = std::max(0, (int)std::floor((b.minX - originX) / cellSize));
        int x1 = std::min(gridW - 1, (int)std::ceil((b.maxX - originX) / cellSize) - 1);
        int z0 = std::max(0, (int)std::floor((b.minZ - originZ) / cellSize));
        int z1 = std::min(gridH - 1, (int)std::ceil((b.maxZ - originZ) / cellSize) - 1);
        for (int z = z0; z <= z1; ++z)
            for (int x = x0; x <= x1; ++x) {
                float cx = originX + (x + 0.5f) * cellSize, cz = originZ + (z + 0.5f) * cellSize;
                bool core = cx > b.minX && cx < b.maxX && cz > b.minZ && cz < b.maxZ;
                if (core) h[(size_t)z * gridW + x] = std::max(h[(size_t)z * gridW + x], b.height);
            }
    }
    return h;
}

} // namespace ttz
