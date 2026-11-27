// Soldier navigation (WS-C): STUB. build() keeps the grid; walkability / A* are WS-C work (see NavGrid.h).
#include "game/NavGrid.h"

#include <cmath>

namespace ttz::game {

void NavGrid::build(const std::vector<float>& heights, int gw, int gh, float ox, float oz, float cell, float stepUp, float clearance) {
    h_ = heights; gw_ = gw; gh_ = gh; ox_ = ox; oz_ = oz; cell_ = cell; stepUp_ = stepUp; clearance_ = clearance;
    walk_.assign(h_.size(), 0);
    island_.assign(h_.size(), 0);
}
void NavGrid::updateRows(const std::vector<float>& heights, int z0, int rows) {}
bool NavGrid::walkable(float x, float z) const { return false; }
float NavGrid::surface(float x, float z) const {
    int i = (int)std::floor((x - ox_) / cell_), j = (int)std::floor((z - oz_) / cell_);
    return i >= 0 && j >= 0 && i < gw_ && j < gh_ ? h_[(size_t)j * gw_ + i] : 0.f;
}
bool NavGrid::lineOfSight(V3 a, V3 b) const { return false; }
bool NavGrid::nearestWalkable(V3 p, float maxR, V3& out) const { return false; }
uint32_t NavGrid::island(float x, float z) const { return 0; }
uint32_t NavGrid::requestPath(V3 from, V3 to) { return 0; }
bool NavGrid::poll(uint32_t request, std::vector<V3>& out, bool& failed) { failed = true; return true; }
void NavGrid::tick(int nodeBudget) {}

} // namespace ttz::game
