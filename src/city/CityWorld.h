#pragma once
// Glue between the baked city and the horde simulation.
//
// Simulation window: CrowdSim keeps a fixed-size static height grid plus per-cell density, navigation, corpse
// and decal fields (about 140 B per cell including the 3x decal layers). The whole 2.3 x 2.0 km city at 0.75 m
// would be ~8.4 M cells (~1.2 GB, and the Eikonal relaxation would sweep all of it every step), so the sim runs
// in a window (default 512 x 512 cells = 384 m) placed on the city and filled from the tiles' 0.5 m HGT0 grids.
// Zombies live inside the window; the rendered city streams around it independently.
#include "city/CityAsset.h"
#include "sim/Sandbox.h"

#include <string>
#include <vector>

namespace ttz {

// Fills `sb` (map = Baked) with a window of gw x gh cells of size `cell` centred near (cx, cz): static heights from
// the collision grids (max of the 0.5 m samples inside each cell), scenarios from the spawn points in the window.
bool buildCityWindow(const CityAsset& city, float cx, float cz, float cell, int gw, int gh, Sandbox& sb);

// Moon-shadow height field (3x the sim grid, see shaders/include/shadow.glsl) from a static height grid.
std::vector<float> cityShadowField(const std::vector<float>& heights, int gw, int gh, float cell, float originX, float originZ);

// Writes a tiny synthetic package in the baked format (tests / before the real bake exists): ni x nj tiles of
// blocks and streets, a few cars, lamps and spawns.
bool writeSyntheticCity(const std::string& dir, int ni = 4, int nj = 3);

} // namespace ttz
