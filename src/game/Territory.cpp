// Territory raster, flood fill, regions, states and income (Milestone B2). See Territory.h.
#include "game/Territory.h"

#include "game/Config.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>

namespace ttz::game {

const char* regionStateName(RegionState s) {
    switch (s) {
    case RegionState::Unsecured: return "unsecured";
    case RegionState::Uncleared: return "enclosed, uncleared";
    case RegionState::Controlled: return "controlled";
    case RegionState::Threatened: return "breached / threatened";
    }
    return "?";
}

namespace {
constexpr int kMargin = 4;
constexpr int kMaxSide = 1536;   // cells per side (1.5 km at 1 m): structures farther apart than this are clipped
int badness(RegionState s) { return s == RegionState::Uncleared ? 3 : s == RegionState::Threatened ? 2 : s == RegionState::Controlled ? 1 : 0; }
int64_t key(int x, int z) { return ((int64_t)x << 32) ^ (int64_t)(uint32_t)z; }
} // namespace

void Territory::configure(const FortConfig& c) {
    cell_ = std::max(0.25f, c.territoryCell);
    minArea_ = c.minRegionArea;
    clearDelay_ = c.clearDelay;
    lossTime_ = c.lossTime;
    incomeRate_ = c.incomePerHectarePerMin;
}

void Territory::reset() {
    slot_.clear(); regions_.clear(); edges_.clear(); envCache_.clear(); notices_.clear();
    w_ = h_ = 0;
    ++version_;
    dirty_ = false;
}

int Territory::slotAt(float x, float z) const {
    const int i = (int)std::floor((x - ox_) / cell_), j = (int)std::floor((z - oz_) / cell_);
    if (i < 0 || j < 0 || i >= w_ || j >= h_) return -1;
    return (int)slot_[(size_t)j * w_ + i] - 1;
}

void Territory::rebuild(const TerritoryInput& in) {
    const auto t0 = std::chrono::steady_clock::now();
    dirty_ = false;
    ++rebuilds_;
    // ---- previous raster (state inheritance)
    const std::vector<uint16_t> oldSlot = slot_;
    const std::vector<Region> oldRegions = regions_;
    const float oox = ox_, ooz = oz_;
    const int ow = w_, oh = h_;
    auto oldSlotAt = [&](float x, float z) -> int {
        const int i = (int)std::floor((x - oox) / cell_), j = (int)std::floor((z - ooz) / cell_);
        if (i < 0 || j < 0 || i >= ow || j >= oh) return -1;
        return (int)oldSlot[(size_t)j * ow + i] - 1;
    };
    // ---- bounds of every structure
    float bx0 = 1e30f, bz0 = 1e30f, bx1 = -1e30f, bz1 = -1e30f;
    std::vector<Obb> boxes;
    std::vector<int> boxPiece;   // wall piece index per box (-2: post / container)
    if (in.walls) {
        const Walls& W = *in.walls;
        for (uint32_t i = 0; i < W.pieces().size(); ++i) if (W.pieces()[i].solid()) { boxes.push_back(W.pieceBox(i)); boxPiece.push_back((int)i); }
        for (uint32_t n = 0; n < W.nodes().size(); ++n) if (W.nodes()[n].alive && W.nodes()[n].solidDeg) boxes.push_back(W.postBox(n));
    }
    boxPiece.resize(boxes.size(), -2);
    for (const Obb& c : in.containers) { boxes.push_back(c); boxPiece.push_back(-2); }
    for (const Obb& b : boxes) {
        const float r = std::sqrt(b.hx * b.hx + b.hz * b.hz);
        bx0 = std::min(bx0, b.cx - r); bz0 = std::min(bz0, b.cz - r); bx1 = std::max(bx1, b.cx + r); bz1 = std::max(bz1, b.cz + r);
    }
    regions_.clear();
    edges_.clear();
    ++version_;
    if (boxes.empty()) {
        slot_.clear(); w_ = h_ = 0;
    } else {
        ox_ = std::floor(bx0 / cell_ - kMargin) * cell_;
        oz_ = std::floor(bz0 / cell_ - kMargin) * cell_;
        w_ = std::min(kMaxSide, (int)std::ceil((bx1 - ox_) / cell_) + kMargin);
        h_ = std::min(kMaxSide, (int)std::ceil((bz1 - oz_) / cell_) + kMargin);
        const size_t N = (size_t)w_ * h_;
        // 0 open, 2 structure, 3 environment blocked; flood marks outside 1
        std::vector<uint8_t> g(N, 0);
        const int bi0 = (int)std::lround(ox_ / cell_), bj0 = (int)std::lround(oz_ / cell_);
        for (int j = 0; j < h_; ++j)
            for (int i = 0; i < w_; ++i) {
                const int64_t k = key(bi0 + i, bj0 + j);
                uint8_t e = 0;
                const float x = ox_ + (i + 0.5f) * cell_, z = oz_ + (j + 0.5f) * cell_;
                const int q = in.env ? in.env(x, z) : 0;
                if (q) { e = (uint8_t)q; envCache_[k] = e; }
                else if (auto it = envCache_.find(k); it != envCache_.end()) e = it->second;
                if (e == 2) g[(size_t)j * w_ + i] = 3;
            }
        std::vector<int32_t> owner(N, -1);   // structure cells: wall piece index (containers / posts: -2)
        for (size_t b = 0; b < boxes.size(); ++b) {
            Obb o = boxes[b];
            (void)o;   // touched cells (sampled every half cell) keep diagonal walls 4-connected; no inflation: breaches open
            const int pieceIdx = boxPiece[b];
            forEachObbCell(o, ox_, oz_, cell_, w_, h_, [&](int cx, int cz) {
                const size_t c = (size_t)cz * w_ + cx;
                g[c] = 2;
                if (pieceIdx >= 0) owner[c] = pieceIdx;
                else if (owner[c] < 0) owner[c] = -2;
            });
        }
        // flood the outside from the border (4-connected)
        std::vector<uint32_t> st;
        auto seed = [&](int i, int j) { const size_t c = (size_t)j * w_ + i; if (g[c] == 0) { g[c] = 1; st.push_back((uint32_t)c); } };
        for (int i = 0; i < w_; ++i) { seed(i, 0); seed(i, h_ - 1); }
        for (int j = 0; j < h_; ++j) { seed(0, j); seed(w_ - 1, j); }
        const int d4[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        while (!st.empty()) {
            const uint32_t c = st.back(); st.pop_back();
            const int ci = (int)(c % w_), cj = (int)(c / w_);
            for (auto& d : d4) {
                const int x = ci + d[0], z = cj + d[1];
                if (x < 0 || z < 0 || x >= w_ || z >= h_) continue;
                const size_t n = (size_t)z * w_ + x;
                if (g[n] == 0) { g[n] = 1; st.push_back((uint32_t)n); }
            }
        }
        // enclosed components
        slot_.assign(N, 0);
        std::vector<uint32_t> members;
        const float cellArea = cell_ * cell_;
        for (size_t c0 = 0; c0 < N; ++c0) {
            if (g[c0] != 0) continue;
            members.clear();
            st.assign(1, (uint32_t)c0);
            g[c0] = 4;   // visited
            bool touchesStructure = false;
            std::vector<uint32_t> perim;
            while (!st.empty()) {
                const uint32_t c = st.back(); st.pop_back();
                members.push_back(c);
                const int ci = (int)(c % w_), cj = (int)(c / w_);
                for (auto& d : d4) {
                    const int x = ci + d[0], z = cj + d[1];
                    if (x < 0 || z < 0 || x >= w_ || z >= h_) continue;
                    const size_t n = (size_t)z * w_ + x;
                    if (g[n] == 2) {
                        touchesStructure = true;
                        if (owner[n] >= 0 && std::find(perim.begin(), perim.end(), (uint32_t)owner[n]) == perim.end()) perim.push_back((uint32_t)owner[n]);
                    }
                    if (g[n] == 0) { g[n] = 4; st.push_back((uint32_t)n); }
                }
            }
            const float area = (float)members.size() * cellArea;
            if (!touchesStructure || area < minArea_ || regions_.size() >= 65000) continue;
            Region r;
            r.cells = (int)members.size();
            r.area = area;
            r.x0 = r.z0 = 1e30f; r.x1 = r.z1 = -1e30f;
            double sx = 0, sz = 0;
            const uint16_t s = (uint16_t)(regions_.size() + 1);
            // inheritance votes: old slot -> overlapping cells
            std::unordered_map<int, int> votes;
            for (uint32_t c : members) {
                slot_[c] = s;
                const float x = ox_ + ((int)(c % w_) + 0.5f) * cell_, z = oz_ + ((int)(c / w_) + 0.5f) * cell_;
                sx += x; sz += z;
                r.x0 = std::min(r.x0, x); r.x1 = std::max(r.x1, x); r.z0 = std::min(r.z0, z); r.z1 = std::max(r.z1, z);
                const int os = oldSlotAt(x, z);
                if (os >= 0) ++votes[os];
            }
            r.cx = (float)(sx / members.size()); r.cz = (float)(sz / members.size());
            r.perimeter = perim;
            int bestOld = -1, bestVotes = 0;
            RegionState worst = RegionState::Controlled;
            bool any = false;
            for (auto& [os, v] : votes) {
                if (v > bestVotes) { bestVotes = v; bestOld = os; }
                if (v * 4 >= oldRegions[(size_t)os].cells || v * 4 >= r.cells) {   // a real part of this region
                    if (!any || badness(oldRegions[(size_t)os].state) > badness(worst)) worst = oldRegions[(size_t)os].state;
                    any = true;
                }
            }
            if (bestOld >= 0 && any) {
                const Region& o = oldRegions[(size_t)bestOld];
                r.id = o.id;
                r.state = worst;
                r.zombies = o.zombies;
                r.clearT = worst == o.state ? o.clearT : 0.f;
                r.threatT = worst == RegionState::Threatened ? o.threatT : 0.f;
                for (const Region& q : regions_) if (q.id == r.id) { r.id = nextId_++; break; }   // split: the larger part keeps the id
            } else {
                r.id = nextId_++;
                r.state = RegionState::Uncleared;
                r.zombies = -1;
                char t[96];
                std::snprintf(t, sizeof(t), "Perimeter closed: %.0f m2 enclosed. Clear it to take control.", r.area);
                notices_.push_back({t, false, r.cx, r.cz});
            }
            regions_.push_back(std::move(r));
        }
        // perimeter edges (merged runs along rows / columns), inward normal towards the region
        auto at = [&](int i, int j) -> uint16_t { return (i < 0 || j < 0 || i >= w_ || j >= h_) ? 0 : slot_[(size_t)j * w_ + i]; };
        for (int j = 0; j <= h_; ++j)        // horizontal boundaries between rows j - 1 and j
            for (int side = 0; side < 2; ++side) {
                int run = -1;
                uint16_t rs = 0;
                for (int i = 0; i <= w_; ++i) {
                    const uint16_t in1 = side ? at(i, j - 1) : at(i, j), out1 = side ? at(i, j) : at(i, j - 1);
                    const bool e = i < w_ && in1 && in1 != out1;
                    if (run >= 0 && (!e || in1 != rs)) {
                        const float z = oz_ + j * cell_;
                        edges_.push_back({ox_ + run * cell_, z, ox_ + i * cell_, z, 0.f, side ? -1.f : 1.f, (uint16_t)(rs - 1)});
                        run = -1;
                    }
                    if (e && run < 0) { run = i; rs = in1; }
                }
            }
        for (int i = 0; i <= w_; ++i)        // vertical boundaries between columns i - 1 and i
            for (int side = 0; side < 2; ++side) {
                int run = -1;
                uint16_t rs = 0;
                for (int j = 0; j <= h_; ++j) {
                    const uint16_t in1 = side ? at(i - 1, j) : at(i, j), out1 = side ? at(i, j) : at(i - 1, j);
                    const bool e = j < h_ && in1 && in1 != out1;
                    if (run >= 0 && (!e || in1 != rs)) {
                        const float x = ox_ + i * cell_;
                        edges_.push_back({x, oz_ + run * cell_, x, oz_ + j * cell_, side ? -1.f : 1.f, 0.f, (uint16_t)(rs - 1)});
                        run = -1;
                    }
                    if (e && run < 0) { run = j; rs = in1; }
                }
            }
    }
    // controlled regions that vanished: the perimeter was breached
    for (const Region& o : oldRegions) {
        if (o.state != RegionState::Controlled && o.state != RegionState::Threatened) continue;
        bool alive = false;
        for (const Region& r : regions_) alive |= r.id == o.id;
        if (!alive) {
            bool merged = false;   // still inside some region (merged into a bigger one)?
            for (const Region& r : regions_) merged |= o.cx >= r.x0 && o.cx <= r.x1 && o.cz >= r.z0 && o.cz <= r.z1 && slotAt(o.cx, o.cz) >= 0;
            if (!merged) notices_.push_back({"Breach! A controlled territory is open to the horde", true, o.cx, o.cz});
        }
    }
    rebuildMs_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

void Territory::setZombieCounts(uint64_t version, const std::vector<int>& perSlot) {
    if (version != version_) return;   // counted against an older raster: wait for the next readback
    for (size_t s = 0; s < regions_.size() && s < perSlot.size(); ++s)
        if (perSlot[s] >= 0) regions_[s].zombies = perSlot[s];
    countsVersion_ = version;
}

void Territory::tick(float dt, const Walls* walls) {
    for (Region& r : regions_) {
        r.underAttack = false;
        if (walls)
            for (uint32_t p : r.perimeter)
                if (p < walls->pieces().size() && walls->pieces()[p].alive && walls->pieces()[p].damageRate > 0.5f) { r.underAttack = true; break; }
        if (r.zombies < 0) continue;   // not counted yet
        if (r.zombies > 0) {
            r.clearT = 0.f;
            if (r.state == RegionState::Controlled) {
                r.state = RegionState::Threatened;
                r.threatT = 0.f;
                notices_.push_back({"Zombies inside a controlled territory: income paused", true, r.cx, r.cz});
            }
            if (r.state == RegionState::Threatened) {
                r.threatT += dt;
                if (r.threatT >= lossTime_) {
                    r.state = RegionState::Uncleared;
                    notices_.push_back({"Territory lost: clear the zombies inside to retake it", true, r.cx, r.cz});
                }
            }
        } else {
            r.clearT += dt;
            if (r.state == RegionState::Threatened) { r.state = RegionState::Controlled; r.threatT = 0.f; }
            else if (r.state == RegionState::Uncleared && r.clearT >= clearDelay_) {
                r.state = RegionState::Controlled;
                char t[96];
                std::snprintf(t, sizeof(t), "Territory secured: %.0f m2 under control", r.area);
                notices_.push_back({t, false, r.cx, r.cz});
            }
        }
    }
}

float Territory::controlledArea() const {
    float a = 0;
    for (const Region& r : regions_) a += r.state == RegionState::Controlled ? r.area : 0.f;
    return a;
}

float Territory::enclosedArea() const {
    float a = 0;
    for (const Region& r : regions_) a += r.area;
    return a;
}

double Territory::incomePerMin() const { return (double)controlledArea() / 10000.0 * incomeRate_; }

} // namespace ttz::game
