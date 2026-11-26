#pragma once
// Glue between the baked city and the horde simulation.
//
// Simulation window: CrowdSim keeps a fixed-size static height grid plus per-cell density, navigation, corpse
// and decal fields (about 140 B per cell including the 3x decal layers). The whole 2.3 x 2.0 km city at 0.75 m
// would be ~8.4 M cells (~1.2 GB, and the Eikonal relaxation would sweep all of it every step), so the sim runs
// in a window (default 512 x 512 cells = 384 m) placed on the city and filled from the tiles' 0.5 m HGT0 grids.
// Zombies live inside the window; the rendered city streams around it independently. The window follows the camera
// (CitySimWindow + CrowdSim::relocate); zombies it leaves behind are parked until it comes back.
#include "city/CityAsset.h"
#include "sim/Sandbox.h"

#include <functional>
#include <string>
#include <vector>

namespace ttz {

// Fills `sb` (map = Baked) with a window of gw x gh cells of size `cell` centred near (cx, cz): static heights from
// the collision grids (max of the 0.5 m samples inside each cell), scenarios from the spawn points in the window.
bool buildCityWindow(const CityAsset& city, float cx, float cz, float cell, int gw, int gh, Sandbox& sb);

// Static height of the cells [ox, ox + w * cell) x [oz, oz + h * cell): max of the tiles' 0.5 m collision samples whose
// centre is in the cell (conservative: no leaking into walls), water as a 1 m wall. getTile(i, j) returns a decoded
// tile (heightCm / flags) or null. Returns the number of tiles sampled.
int rasterCityHeights(const CityAsset& city, const std::function<const TileCPU*(int, int)>& getTile, float ox, float oz, float cell,
                      int w, int h, std::vector<float>& out);

// Moon shadows (see shaders/include/shadow.glsl). Rays are marched up to kShadowReach metres towards the moon, so the
// field of a window needs the static heights of the window extended by `margins` cells on the moon side; with that,
// the value of a cell does not depend on where the window is (a moving window can keep the overlap and only compute
// the newly exposed strips).
constexpr float kShadowReach = 120.f;   // shadows of buildings up to ~165 m
struct ShadowMargins { int x0, z0, x1, z1; };   // extra cells before / after the window on each axis
ShadowMargins cityShadowMargins(float cell);
// field: (3 gw) x (3 gh) samples of the window at (ox, oz); ext: ew x eh static heights at (ex0, ez0) (the extended
// window). Samples for which skip(sx, sz) is true are left as they are. threads = 0: all hardware threads (max 16).
void cityShadowField(const std::vector<float>& ext, int ew, int eh, float ex0, float ez0, float cell, float ox, float oz, int gw, int gh,
                     std::vector<float>& field, const std::function<bool(int, int)>& skip = {}, int threads = 0);

// Writes a tiny synthetic package in the baked format (tests / before the real bake exists): ni x nj tiles of
// blocks and streets, a few cars, lamps and spawns.
bool writeSyntheticCity(const std::string& dir, int ni = 4, int nj = 3);

} // namespace ttz
