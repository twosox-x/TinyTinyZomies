// Soldier navigation (WS-C): walkability + islands from the live window height grid, budgeted FIFO A*, string
// pulling, shooting line of sight. See NavGrid.h.
#include "game/NavGrid.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr int kMinIslandCells = 16;   // smaller flat patches (car roofs, kiosks, poles) are not walkable
constexpr float kSqrt2 = 1.41421356f;
constexpr float kGraze = 0.3f, kCoverReach = 2.5f;   // = GRAZE / COVER_REACH in shaders/game_hits.comp
}

bool NavGrid::cellOf(float x, float z, int& i, int& j) const {
    i = (int)std::floor((x - ox_) / cell_);
    j = (int)std::floor((z - oz_) / cell_);
    return i >= 0 && j >= 0 && i < gw_ && j < gh_;
}

V3 NavGrid::centre(int i, int j) const {
    return {ox_ + (i + 0.5f) * cell_, h_[(size_t)j * gw_ + i], oz_ + (j + 0.5f) * cell_};
}

void NavGrid::build(const std::vector<float>& heights, int gw, int gh, float ox, float oz, float cell, float stepUp, float clearance) {
    h_ = heights; gw_ = gw; gh_ = gh; ox_ = ox; oz_ = oz; cell_ = cell; stepUp_ = stepUp; clearance_ = clearance;
    if ((int)h_.size() != gw * gh) { gw_ = gh_ = 0; h_.clear(); shotH_.clear(); walk_.clear(); island_.clear(); return; }
    shotH_ = h_;
    walk_.assign(h_.size(), 0);
    island_.assign(h_.size(), 0);
    const size_t n = h_.size();
    g_.assign(n, 0.f); parent_.assign(n, 0); stamp_.assign(n, 0); closed_.assign(n, 0); searchStamp_ = 0;
    computeWalk(0, gh_);
    computeIslands();
    edgeD_.assign(n, kRoofScan); obsD_.assign(n, kRoofScan);
    computeRoof(0, gh_);
    for (Query& q : queries_) q.started = false;   // grid changed: restart searches in flight
}

void NavGrid::updateRows(const std::vector<float>& heights, int z0, int rows) {
    if (!ready() || (int)heights.size() != gw_ * gh_) return;
    const int a = std::max(0, z0), b = std::min(gh_, z0 + rows);
    for (int j = a; j < b; ++j)
        std::copy(heights.begin() + (size_t)j * gw_, heights.begin() + (size_t)(j + 1) * gw_, h_.begin() + (size_t)j * gw_);
    if (shotH_.size() == h_.size())   // default: the shot layer follows the walk heights (updateShotRows overrides)
        for (int j = a; j < b; ++j)
            std::copy(heights.begin() + (size_t)j * gw_, heights.begin() + (size_t)(j + 1) * gw_, shotH_.begin() + (size_t)j * gw_);
    computeWalk(std::max(0, a - 1), std::min(gh_, b + 1));
    computeIslands();
    const int R = (int)std::ceil(kRoofScan / cell_) + 3;   // clearances depend on cells up to kRoofScan (+ min5) away
    computeRoof(std::max(0, a - R), std::min(gh_, b + R));
    for (Query& q : queries_) if (!q.done) q.started = false;
}

void NavGrid::computeWalk(int z0, int z1) {
    // A cell is walkable when the soldier can step to at least one 4-neighbour; with a clearance wider than half a
    // cell, every 4-neighbour must be passable (dilation by one cell).
    const bool dilate = clearance_ > cell_ * 0.5f;
    for (int j = z0; j < z1; ++j)
        for (int i = 0; i < gw_; ++i) {
            const float h = h_[(size_t)j * gw_ + i];
            int ok = 0, total = 0;
            const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
            for (auto& o : d) {
                const int x = i + o[0], z = j + o[1];
                if (x < 0 || z < 0 || x >= gw_ || z >= gh_) continue;
                ++total;
                ok += std::fabs(h_[(size_t)z * gw_ + x] - h) <= stepUp_ ? 1 : 0;
            }
            walk_[(size_t)j * gw_ + i] = (uint8_t)(dilate ? (ok == total && total > 0) : ok > 0);
        }
}

bool NavGrid::edge(int i, int j, int di, int dj) const {
    const int x = i + di, z = j + dj;
    if (x < 0 || z < 0 || x >= gw_ || z >= gh_) return false;
    const size_t a = (size_t)j * gw_ + i, b = (size_t)z * gw_ + x;
    if (!walk_[a] || !walk_[b] || std::fabs(h_[a] - h_[b]) > stepUp_) return false;
    if (di != 0 && dj != 0)   // diagonal: no corner cutting
        return edge(i, j, di, 0) && edge(i, j, 0, dj) && edge(i + di, j, 0, dj) && edge(i, j + dj, di, 0);
    return true;
}

void NavGrid::computeIslands() {
    std::fill(island_.begin(), island_.end(), 0u);
    std::vector<uint32_t> stack, members, sizes(1, 0);
    islandRoof_.assign(1, 0);
    uint32_t next = 1;
    for (int j = 0; j < gh_; ++j)
        for (int i = 0; i < gw_; ++i) {
            const size_t c0 = (size_t)j * gw_ + i;
            if (!walk_[c0] || island_[c0]) continue;
            members.clear();
            stack.assign(1, (uint32_t)c0);
            island_[c0] = next;
            while (!stack.empty()) {
                const uint32_t c = stack.back(); stack.pop_back();
                members.push_back(c);
                const int ci = (int)(c % gw_), cj = (int)(c / gw_);
                const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
                for (auto& o : d)
                    if (edge(ci, cj, o[0], o[1])) {
                        const size_t n = (size_t)(cj + o[1]) * gw_ + (ci + o[0]);
                        if (!island_[n]) { island_[n] = next; stack.push_back((uint32_t)n); }
                    }
            }
            if ((int)members.size() < kMinIslandCells) {
                for (uint32_t c : members) { walk_[c] = 0; island_[c] = 0; }
                continue;
            }
            // roof island: a drop of more than 2.5 m somewhere along its rim
            bool drop = false;
            for (uint32_t c : members) {
                const int ci = (int)(c % gw_), cj = (int)(c / gw_);
                const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
                for (auto& o : d) {
                    const int x = ci + o[0], z = cj + o[1];
                    if (x >= 0 && z >= 0 && x < gw_ && z < gh_ && h_[(size_t)z * gw_ + x] < h_[c] - 2.5f) { drop = true; break; }
                }
                if (drop) break;
            }
            if (islandRoof_.size() <= next) islandRoof_.resize(next + 1, 0);
            islandRoof_[next] = drop ? 1 : 0;
            sizes.resize(next + 1, 0);
            sizes[next] = (uint32_t)members.size();
            ++next;
        }
    // the largest island is the street network, never a roof
    uint32_t big = 0;
    for (uint32_t k = 1; k < sizes.size(); ++k) if (sizes[k] > sizes[big]) big = k;
    if (big < islandRoof_.size()) islandRoof_[big] = 0;
    islandRoof_.resize(next, 0);
}

void NavGrid::computeRoof(int z0, int z1) {
    if (edgeD_.size() != h_.size()) return;
    // lowest height within 2 cells of every cell (separable min filter; parapet = a raised cell next to a drop)
    min5_.assign(h_.size(), 0.f);
    std::vector<float> rowMin(h_.size());
    for (int j = 0; j < gh_; ++j)
        for (int i = 0; i < gw_; ++i) {
            float m = h_[(size_t)j * gw_ + i];
            for (int d = -2; d <= 2; ++d) { const int x = i + d; if (x >= 0 && x < gw_) m = std::min(m, h_[(size_t)j * gw_ + x]); }
            rowMin[(size_t)j * gw_ + i] = m;
        }
    for (int j = 0; j < gh_; ++j)
        for (int i = 0; i < gw_; ++i) {
            float m = rowMin[(size_t)j * gw_ + i];
            for (int d = -2; d <= 2; ++d) { const int z = j + d; if (z >= 0 && z < gh_) m = std::min(m, rowMin[(size_t)z * gw_ + i]); }
            min5_[(size_t)j * gw_ + i] = m;
        }
    const int R = (int)std::ceil(kRoofScan / cell_);
    for (int j = std::max(0, z0); j < std::min(gh_, z1); ++j)
        for (int i = 0; i < gw_; ++i) {
            const size_t c = (size_t)j * gw_ + i;
            float e = kRoofScan, o = kRoofScan;
            if (walk_[c] && roofIsland(island_[c])) {
                const float y = h_[c];
                const uint32_t I = island_[c];
                for (int dj = -R; dj <= R; ++dj)
                    for (int di = -R; di <= R; ++di) {
                        const int x = i + di, z = j + dj;
                        if (x < 0 || z < 0 || x >= gw_ || z >= gh_) continue;
                        const size_t b = (size_t)z * gw_ + x;
                        if (island_[b] == I) continue;
                        const float ax = std::max(0.f, (float)std::abs(di) - 0.5f), az = std::max(0.f, (float)std::abs(dj) - 0.5f);
                        const float d = cell_ * std::sqrt(ax * ax + az * az);
                        if (d >= e && d >= o) continue;
                        const float hb = h_[b];
                        const bool edge = hb < y - 1.5f || (hb > y - stepUp_ && min5_[b] < y - 1.5f);
                        if (edge) e = std::min(e, d); else o = std::min(o, d);
                    }
            }
            edgeD_[c] = e; obsD_[c] = o;
        }
}

float NavGrid::roofPenalty(size_t c) const {
    if (c >= edgeD_.size() || !walk_[c] || !roofIsland(island_[c])) return 0.f;
    return std::max(0.f, roofEdgeInset - edgeD_[c]) * 3.f + std::max(0.f, roofObstacleMargin - obsD_[c]) * 3.f;
}

float NavGrid::cellEdge(float x, float z) const {
    int i, j;
    return ready() && cellOf(x, z, i, j) && edgeD_.size() == h_.size() ? edgeD_[(size_t)j * gw_ + i] : kRoofScan;
}

float NavGrid::cellObstacle(float x, float z) const {
    int i, j;
    return ready() && cellOf(x, z, i, j) && obsD_.size() == h_.size() ? obsD_[(size_t)j * gw_ + i] : kRoofScan;
}

float NavGrid::clearanceAt(float x, float z, bool wantEdge) const {
    int ci, cj;
    if (!ready() || !cellOf(x, z, ci, cj) || min5_.size() != h_.size()) return kRoofScan;
    const size_t c = (size_t)cj * gw_ + ci;
    // a point on a rim cell that is not part of the roof (parapet top, ledge): clearance 0 from the island beside it
    uint32_t I = island_[c];
    float y = h_[c];
    if (!I || !roofIsland(I)) {
        V3 o;
        if (!nearestWalkableLevel({x, y, z}, 1.6f, y, 0.6f, o) || !onRoof(o.x, o.z)) return kRoofScan;
        return 0.f;
    }
    const int R = (int)std::ceil(kRoofScan / cell_) + 1;
    float best = kRoofScan;
    for (int dj = -R; dj <= R; ++dj)
        for (int di = -R; di <= R; ++di) {
            const int i = ci + di, j = cj + dj;
            if (i < 0 || j < 0 || i >= gw_ || j >= gh_) continue;
            const size_t b = (size_t)j * gw_ + i;
            if (island_[b] == I) continue;
            const float hb = h_[b];
            const bool edge = hb < y - 1.5f || (hb > y - stepUp_ && min5_[b] < y - 1.5f);
            if (edge != wantEdge) continue;
            const float bx = ox_ + (i + 0.5f) * cell_, bz = oz_ + (j + 0.5f) * cell_;
            const float ax = std::max(0.f, std::fabs(x - bx) - cell_ * 0.5f), az = std::max(0.f, std::fabs(z - bz) - cell_ * 0.5f);
            best = std::min(best, std::sqrt(ax * ax + az * az));
        }
    return best;
}

float NavGrid::edgeClearance(float x, float z) const { return clearanceAt(x, z, true); }
float NavGrid::obstacleClearance(float x, float z) const { return clearanceAt(x, z, false); }

bool NavGrid::insetSpot(V3 p, float maxR, float minEdge, float minObs, uint32_t isl, V3& out) const {
    if (!ready() || edgeD_.size() != h_.size()) return false;
    if (!isl) isl = island(p.x, p.z);
    const int ci = (int)std::floor((p.x - ox_) / cell_), cj = (int)std::floor((p.z - oz_) / cell_);
    const int r = (int)std::ceil(maxR / cell_);
    float best = maxR * maxR;
    bool found = false;
    for (int j = cj - r; j <= cj + r; ++j)
        for (int i = ci - r; i <= ci + r; ++i) {
            if (i < 0 || j < 0 || i >= gw_ || j >= gh_) continue;
            const size_t c = (size_t)j * gw_ + i;
            if (!walk_[c]) continue;
            if (isl ? island_[c] != isl : std::fabs(h_[c] - p.y) > 0.6f) continue;
            if (edgeD_[c] < minEdge || obsD_[c] < minObs) continue;
            const V3 q = centre(i, j);
            const float d2 = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
            if (d2 <= best) { best = d2; out = q; found = true; }
        }
    return found;
}

void NavGrid::islandCells(V3 p, float maxR, int maxCells, std::vector<V3>& out) const {
    out.clear();
    int si, sj;
    if (!ready() || !cellOf(p.x, p.z, si, sj) || !walk_[(size_t)sj * gw_ + si]) return;
    std::vector<uint32_t> q{(uint32_t)(sj * gw_ + si)};
    std::vector<uint8_t> seen((size_t)gw_ * gh_, 0);
    seen[q[0]] = 1;
    const float r2 = maxR * maxR;
    for (size_t k = 0; k < q.size() && (int)out.size() < maxCells; ++k) {
        const int ci = (int)(q[k] % gw_), cj = (int)(q[k] / gw_);
        out.push_back(centre(ci, cj));
        const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (auto& o : d) {
            if (!edge(ci, cj, o[0], o[1])) continue;
            const uint32_t n = (uint32_t)((cj + o[1]) * gw_ + ci + o[0]);
            const V3 c = centre(ci + o[0], cj + o[1]);
            if ((c.x - p.x) * (c.x - p.x) + (c.z - p.z) * (c.z - p.z) > r2) continue;
            if (seen[n]) continue;
            seen[n] = 1;
            q.push_back(n);
        }
    }
    std::sort(out.begin(), out.end(), [&](const V3& a, const V3& b) {
        return (a.x - p.x) * (a.x - p.x) + (a.z - p.z) * (a.z - p.z) < (b.x - p.x) * (b.x - p.x) + (b.z - p.z) * (b.z - p.z);
    });
}

bool NavGrid::walkable(float x, float z) const {
    int i, j;
    return ready() && cellOf(x, z, i, j) && walk_[(size_t)j * gw_ + i];
}

float NavGrid::surface(float x, float z) const {
    int i, j;
    if (!ready()) return 0.f;
    i = std::clamp((int)std::floor((x - ox_) / cell_), 0, gw_ - 1);
    j = std::clamp((int)std::floor((z - oz_) / cell_), 0, gh_ - 1);
    return h_[(size_t)j * gw_ + i];
}

uint32_t NavGrid::island(float x, float z) const {
    int i, j;
    return ready() && cellOf(x, z, i, j) ? island_[(size_t)j * gw_ + i] : 0u;
}

bool NavGrid::lineOfSight(V3 a, V3 b) const {
    if (!ready()) return true;
    const V3 d = b - a;
    const float len = std::sqrt(d.x * d.x + d.z * d.z);
    const float step = cell_ * 0.5f, skip = 0.6f;   // the shooter's and the target's own cells are not occluders
    for (float s = skip; s < len - skip; s += step) {
        const float t = s / len;
        int i, j;
        if (!cellOf(a.x + d.x * t, a.z + d.z * t, i, j)) continue;
        if (h_[(size_t)j * gw_ + i] > a.y + d.y * t) return false;
    }
    return true;
}

void NavGrid::setShotHeights(const std::vector<float>& heights) {
    if (ready() && heights.size() == h_.size()) shotH_ = heights;
}

void NavGrid::updateShotRows(const std::vector<float>& heights, int z0, int rows) {
    if (!ready() || heights.size() != h_.size() || shotH_.size() != h_.size()) return;
    const int a = std::max(0, z0), b = std::min(gh_, z0 + rows);
    for (int j = a; j < b; ++j)
        std::copy(heights.begin() + (size_t)j * gw_, heights.begin() + (size_t)(j + 1) * gw_, shotH_.begin() + (size_t)j * gw_);
}

float NavGrid::shotHeight(float x, float z) const {
    if (!ready()) return 0.f;
    const int i = std::clamp((int)std::floor((x - ox_) / cell_), 0, gw_ - 1), j = std::clamp((int)std::floor((z - oz_) / cell_), 0, gh_ - 1);
    const std::vector<float>& H = shotH_.size() == h_.size() ? shotH_ : h_;
    return H[(size_t)j * gw_ + i];
}

bool NavGrid::shotLine(V3 a, V3 b, float skipEnd) const {
    if (!ready()) return true;
    const std::vector<float>& H = shotH_.size() == h_.size() ? shotH_ : h_;
    const V3 d = b - a;
    const float len = std::sqrt(d.x * d.x + d.z * d.z);
    const float step = cell_ * 0.25f;
    for (float s = 0.f; s < len - skipEnd; s += step) {
        const float t = s / std::max(len, 1e-4f);
        int i, j;
        if (!cellOf(a.x + d.x * t, a.z + d.z * t, i, j)) continue;
        const float h = H[(size_t)j * gw_ + i], y = a.y + d.y * t;
        if (h <= y) continue;
        if (h - y < kGraze && s > len - kCoverReach) continue;   // partial cover right in front of the target (game_hits.comp)
        return false;
    }
    return true;
}

float NavGrid::extraCost(float x, float z) const {
    if (!costL_ || costScale_ <= 0.f) return 0.f;
    const int i = (int)std::floor((x - costOx_) / costCell_), j = (int)std::floor((z - costOz_) / costCell_);
    if (i < 0 || j < 0 || i >= costW_ || j >= costH_ || (size_t)(j * costW_ + i) >= costL_->size()) return 0.f;
    return std::min(4.f, (float)(*costL_)[(size_t)j * costW_ + i] / 64.f) * costScale_;
}

bool NavGrid::walkLine(V3 a, V3 b) const {
    if (!ready()) return true;
    int pi, pj;
    if (!cellOf(a.x, a.z, pi, pj) || !walk_[(size_t)pj * gw_ + pi]) return false;
    const float dx = b.x - a.x, dz = b.z - a.z, len = std::sqrt(dx * dx + dz * dz);
    const int n = std::max(1, (int)std::ceil(len / (cell_ * 0.25f)));
    for (int k = 1; k <= n; ++k) {
        const float t = (float)k / n;
        int i, j;
        if (!cellOf(a.x + dx * t, a.z + dz * t, i, j)) return false;
        if (i == pi && j == pj) continue;
        const int di = i - pi, dj = j - pj;
        if (std::abs(di) > 1 || std::abs(dj) > 1 || !edge(pi, pj, di, dj)) return false;
        pi = i; pj = j;
    }
    return true;
}

bool NavGrid::walkLinePen(V3 a, V3 b, float maxPen) const {
    if (!walkLine(a, b)) return false;
    const float dx = b.x - a.x, dz = b.z - a.z, len = std::sqrt(dx * dx + dz * dz);
    const int n = std::max(1, (int)std::ceil(len / (cell_ * 0.25f)));
    for (int k = 0; k <= n; ++k) {
        const float t = (float)k / n;
        int i, j;
        if (!cellOf(a.x + dx * t, a.z + dz * t, i, j)) return false;
        if (roofPenalty((size_t)j * gw_ + i) > maxPen + 1e-3f) return false;
    }
    return true;
}

bool NavGrid::nearestWalkable(V3 p, float maxR, V3& out) const { return nearestWalkable(p, maxR, out, 0u); }

bool NavGrid::nearestWalkable(V3 p, float maxR, V3& out, uint32_t onIsland) const {
    if (!ready()) return false;
    const int ci = (int)std::floor((p.x - ox_) / cell_), cj = (int)std::floor((p.z - oz_) / cell_);
    const int r = (int)std::ceil(maxR / cell_);
    float best = maxR * maxR;
    bool found = false;
    for (int j = cj - r; j <= cj + r; ++j)
        for (int i = ci - r; i <= ci + r; ++i) {
            if (i < 0 || j < 0 || i >= gw_ || j >= gh_) continue;
            const size_t c = (size_t)j * gw_ + i;
            if (!walk_[c] || (onIsland && island_[c] != onIsland)) continue;
            const V3 q = centre(i, j);
            // the point itself when it is inside this cell, else the cell centre
            const bool inside = i == ci && j == cj;
            const float dx = inside ? 0.f : q.x - p.x, dz = inside ? 0.f : q.z - p.z, d2 = dx * dx + dz * dz;
            if (d2 <= best) { best = d2; out = inside ? V3{p.x, q.y, p.z} : q; found = true; }
        }
    return found;
}

bool NavGrid::nearestWalkableLevel(V3 p, float maxR, float y, float tol, V3& out) const {
    if (!ready()) return false;
    const int ci = (int)std::floor((p.x - ox_) / cell_), cj = (int)std::floor((p.z - oz_) / cell_);
    const int r = (int)std::ceil(maxR / cell_);
    float best = maxR * maxR;
    bool found = false;
    for (int j = cj - r; j <= cj + r; ++j)
        for (int i = ci - r; i <= ci + r; ++i) {
            if (i < 0 || j < 0 || i >= gw_ || j >= gh_) continue;
            const size_t c = (size_t)j * gw_ + i;
            if (!walk_[c] || std::fabs(h_[c] - y) > tol) continue;
            const V3 q = centre(i, j);
            const bool inside = i == ci && j == cj;
            const float dx = inside ? 0.f : q.x - p.x, dz = inside ? 0.f : q.z - p.z, d2 = dx * dx + dz * dz;
            if (d2 <= best) { best = d2; out = inside ? V3{p.x, q.y, p.z} : q; found = true; }
        }
    return found;
}

uint32_t NavGrid::requestPath(V3 from, V3 to) {
    Query q;
    q.id = nextId_++;
    if (nextId_ == 0) nextId_ = 1;
    q.from = from; q.to = to;
    ++st_.queries;
    if (!ready()) { q.done = true; q.result = {to}; }   // no grid (tests without a map): straight line
    queries_.push_back(q);
    return q.id;
}

void NavGrid::cancel(uint32_t request) {
    for (size_t k = 0; k < queries_.size(); ++k)
        if (queries_[k].id == request) { queries_.erase(queries_.begin() + (long)k); return; }
}

bool NavGrid::poll(uint32_t request, std::vector<V3>& out, bool& failed) {
    for (size_t k = 0; k < queries_.size(); ++k) {
        Query& q = queries_[k];
        if (q.id != request) continue;
        if (!q.done) return false;
        failed = q.failed;
        out.swap(q.result);
        queries_.erase(queries_.begin() + (long)k);
        return true;
    }
    failed = true;   // unknown id (cancelled, or the grid was never ready)
    return true;
}

bool NavGrid::startQuery(Query& q) {
    q.started = true; q.expanded = 0; q.result.clear();
    int si, sj, ti, tj;
    V3 from = q.from, to = q.to;
    // off-grid start (roof rim, a level's edge): snap onto the SAME level first (never onto the street below)
    if (!walkable(from.x, from.z) && !nearestWalkableLevel(from, 2.f, from.y, 0.6f, from) && !nearestWalkable(from, 2.f, from)) return false;
    cellOf(from.x, from.z, si, sj);
    const uint32_t isl = island_[(size_t)sj * gw_ + si];
    if (island(to.x, to.z) != isl && !nearestWalkable(to, 6.f, to, isl)) return false;
    cellOf(to.x, to.z, ti, tj);
    q.from = from; q.to = to;
    const uint32_t s = (uint32_t)(sj * gw_ + si);
    goalCell_ = (uint32_t)(tj * gw_ + ti);
    if (s == goalCell_) { q.result = {to}; q.done = true; return true; }
    if (++searchStamp_ == 0) { std::fill(stamp_.begin(), stamp_.end(), 0u); std::fill(closed_.begin(), closed_.end(), 0u); searchStamp_ = 1; }
    open_.clear();
    g_[s] = 0.f; stamp_[s] = searchStamp_; parent_[s] = s;
    open_.push_back({0.f, s});
    return true;
}

bool NavGrid::expand(Query& q, int& budget) {
    const int ti = (int)(goalCell_ % gw_), tj = (int)(goalCell_ / gw_);
    auto heur = [&](int i, int j) {
        const float dx = (float)std::abs(i - ti), dz = (float)std::abs(j - tj);
        return (dx + dz) + (kSqrt2 - 2.f) * std::min(dx, dz);
    };
    auto cmp = [](const Open& a, const Open& b) { return a.f > b.f; };
    while (budget > 0) {
        if (open_.empty()) { q.failed = q.done = true; return true; }
        std::pop_heap(open_.begin(), open_.end(), cmp);
        const Open o = open_.back(); open_.pop_back();
        if (closed_[o.c] == searchStamp_) continue;
        closed_[o.c] = searchStamp_;
        --budget; ++q.expanded; ++st_.expanded;
        if (o.c == goalCell_) { finish(q, o.c); return true; }
        if (q.expanded > maxNodesPerQuery) { q.failed = q.done = true; return true; }
        const int ci = (int)(o.c % gw_), cj = (int)(o.c / gw_);
        for (int dj = -1; dj <= 1; ++dj)
            for (int di = -1; di <= 1; ++di) {
                if ((!di && !dj) || !edge(ci, cj, di, dj)) continue;
                const uint32_t n = (uint32_t)((cj + dj) * gw_ + ci + di);
                if (closed_[n] == searchStamp_) continue;
                float g = g_[o.c] + ((di && dj) ? kSqrt2 : 1.f);
                if (costL_) { const V3 cn = centre(ci + di, cj + dj); g += ((di && dj) ? kSqrt2 : 1.f) * extraCost(cn.x, cn.z); }   // gas (14d)
                g += ((di && dj) ? kSqrt2 : 1.f) * roofPenalty(n);   // roofs: keep off the rim, a margin around roof objects
                if (stamp_[n] == searchStamp_ && g >= g_[n]) continue;
                stamp_[n] = searchStamp_; g_[n] = g; parent_[n] = o.c;
                open_.push_back({g + heur(ci + di, cj + dj), n});
                std::push_heap(open_.begin(), open_.end(), cmp);
            }
    }
    return false;
}

void NavGrid::finish(Query& q, uint32_t goal) {
    std::vector<uint32_t> cells;
    for (uint32_t c = goal;; c = parent_[c]) { cells.push_back(c); if (parent_[c] == c) break; }
    std::reverse(cells.begin(), cells.end());
    std::vector<V3> pts;
    pts.reserve(cells.size());
    for (uint32_t c : cells) pts.push_back(centre((int)(c % gw_), (int)(c / gw_)));
    pts.front() = {q.from.x, pts.front().y, q.from.z};
    pts.back() = {q.to.x, pts.back().y, q.to.z};
    // String pulling: from each anchor, jump to the farthest point reachable in a walkable straight line. On roofs a leg
    // never crosses a cell nearer the rim / a roof object than the A* path between its ends went (no shortcut along the
    // edge the planner avoided).
    std::vector<float> pen(cells.size()), runMax(cells.size());
    bool anyPen = false;
    for (size_t k = 0; k < cells.size(); ++k) { pen[k] = roofPenalty(cells[k]); anyPen |= pen[k] > 0.f; }
    std::vector<V3> out;
    size_t a = 0;
    while (a + 1 < pts.size()) {
        size_t b = a + 1;
        if (anyPen) { float m = pen[a]; for (size_t k = a; k < pts.size(); ++k) { m = std::max(m, pen[k]); runMax[k] = m; } }
        for (size_t k = pts.size() - 1; k > a + 1; --k) {
            // the leg must stay walkable when followed 0.3 m off its axis (steering, separation): no corner hugging
            const float dx = pts[k].x - pts[a].x, dz = pts[k].z - pts[a].z, l = std::max(1e-4f, std::sqrt(dx * dx + dz * dz));
            const V3 o{-dz / l * 0.3f, 0, dx / l * 0.3f};
            if (!anyPen) {
                if (walkLine(pts[a], pts[k]) && (k + 1 == pts.size() || (walkLine(pts[a] + o, pts[k] + o) && walkLine(pts[a] - o, pts[k] - o)))) { b = k; break; }
                continue;
            }
            const float mp = runMax[k];
            if (walkLinePen(pts[a], pts[k], mp) && (k + 1 == pts.size() || (walkLinePen(pts[a] + o, pts[k] + o, mp) && walkLinePen(pts[a] - o, pts[k] - o, mp)))) { b = k; break; }
        }
        out.push_back(pts[b]);
        a = b;
    }
    q.result.swap(out);
    q.done = true;
}

void NavGrid::tick(int nodeBudget) {
    if (!ready()) return;
    int budget = nodeBudget;
    bool busy = false;
    for (Query& q : queries_) {   // FIFO: the oldest unfinished query gets the budget first
        if (q.done) continue;
        busy = true;
        if (!q.started && !startQuery(q)) { q.failed = q.done = true; ++st_.failed; continue; }
        if (q.done) continue;
        if (!expand(q, budget)) break;   // budget exhausted: continue this query next tick
        if (q.failed) ++st_.failed;
        if (budget <= 0) break;
    }
    if (busy) ++st_.ticksBusy;
}

} // namespace ttz::game
