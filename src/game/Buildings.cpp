// Building registry (B3a; shared with B3b): BLDG parsing, derived openings / firing positions, spatial queries,
// barricade state. See Buildings.h.
#include "game/Buildings.h"

#include "city/CityAsset.h"
#include "game/Config.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz::game {

const char* roleName(BuildingRole r) { return r == BuildingRole::Garrison ? "Garrison" : r == BuildingRole::Hospital ? "Hospital" : "None"; }
const char* kindName(BuildingKind k) {
    switch (k) {
    case BuildingKind::House: return "house";
    case BuildingKind::Row: return "row house";
    case BuildingKind::Mid: return "mid-rise";
    case BuildingKind::Tower: return "tower";
    case BuildingKind::Shop: return "commercial";
    case BuildingKind::Other: return "other";
    default: return "unknown";
    }
}
const char* captureName(CaptureState s) {
    switch (s) {
    case CaptureState::Capturing: return "capturing";
    case CaptureState::Captured: return "captured";
    case CaptureState::Contested: return "contested";
    default: return "unclaimed";
    }
}
const char* barricadeName(BarricadeType b) {
    switch (b) {
    case BarricadeType::Planks: return "planks";
    case BarricadeType::Plate: return "plate";
    case BarricadeType::Sandbags: return "sandbags";
    default: return "none";
    }
}

int Building::floorAt(float y) const {
    if (flatRoof && y >= roofY - 0.5f) return kRoofFloor;
    const int f = (int)std::floor((y - y0 + 0.5f) / std::max(1.f, floorHeight));
    return std::clamp(f, 0, (int)floors - 1);
}

namespace {
template <class T> T rd(const uint8_t* p) { T v; std::memcpy(&v, p, sizeof(T)); return v; }
constexpr float kBucket = 16.f;
uint64_t bucketKey(int bx, int bz) { return ((uint64_t)(uint32_t)bx << 32) | (uint32_t)bz; }
} // namespace

bool parseBldg(const std::vector<uint8_t>& b, std::vector<Building>& out) {
    if (b.size() < 8) return false;
    const uint32_t n = rd<uint32_t>(b.data()), rb = rd<uint32_t>(b.data() + 4);
    if (rb < 140 || 8 + (size_t)n * rb > b.size()) return false;
    for (uint32_t k = 0; k < n; ++k) {
        const uint8_t* r = b.data() + 8 + (size_t)k * rb;
        Building B;
        B.bakeId = rd<uint32_t>(r);
        B.kind = (BuildingKind)std::min<uint8_t>(r[4], 6);
        B.floors = std::max<uint8_t>(1, r[5]);
        B.flatRoof = (r[6] & 1) != 0;
        const int nd = std::min<int>(r[7], 4);
        float f[9];
        for (int q = 0; q < 9; ++q) f[q] = rd<float>(r + 8 + q * 4);
        B.ox = f[0]; B.oz = f[1]; B.e1x = f[2]; B.e1z = f[3]; B.w = f[4]; B.d = f[5]; B.y0 = f[6]; B.roofY = f[7]; B.topY = f[8];
        const float l1 = std::sqrt(B.e1x * B.e1x + B.e1z * B.e1z);
        if (l1 < 1e-3f || B.w < 1.f || B.d < 1.f) continue;
        B.e1x /= l1; B.e1z /= l1;
        // e2: into the lot. The bake stores only e1; the lot frame is right-handed or left-handed depending on the
        // street side, so e2 is taken from the stored door normals (doors face -e2) when present.
        B.e2x = -B.e1z; B.e2z = B.e1x;
        for (int d = 0; d < nd; ++d) {
            const uint8_t* q = r + 44 + d * 24;
            Opening o;
            o.type = OpeningType::Door;
            o.floor = 0;
            o.pos = {rd<float>(q), rd<float>(q + 4), rd<float>(q + 8)};
            o.nx = rd<float>(q + 12); o.nz = rd<float>(q + 16);
            o.width = std::clamp(rd<float>(q + 20), 1.0f, 2.4f);
            o.height = 2.3f;
            B.openings.push_back(o);
        }
        if (!B.openings.empty()) {
            const Opening& d0 = B.openings[0];
            // front doors face -e2 (the first door is always on the front facade)
            if (d0.nx * B.e2x + d0.nz * B.e2z > 0.f) { B.e2x = -B.e2x; B.e2z = -B.e2z; }
        }
        B.floorHeight = B.flatRoof ? std::max(2.6f, (B.roofY - B.y0) / (float)B.floors) : 3.0f;
        B.stairU = B.w * 0.5f; B.stairV = B.d * 0.6f;
        out.push_back(std::move(B));
    }
    return true;
}

void BuildingRegistry::clear() { b_.clear(); tiles_.clear(); grid_.clear(); broken_.clear(); ++version_; }

void BuildingRegistry::bucketAdd(uint32_t idx) {
    const Building& B = b_[idx];
    float x0 = 1e9f, z0 = 1e9f, x1 = -1e9f, z1 = -1e9f;
    for (int c = 0; c < 4; ++c) {
        const V3 p = B.toWorld((c & 1) ? B.w : 0.f, (c & 2) ? B.d : 0.f, 0.f);
        x0 = std::min(x0, p.x); x1 = std::max(x1, p.x); z0 = std::min(z0, p.z); z1 = std::max(z1, p.z);
    }
    for (int bz = (int)std::floor(z0 / kBucket); bz <= (int)std::floor(z1 / kBucket); ++bz)
        for (int bx = (int)std::floor(x0 / kBucket); bx <= (int)std::floor(x1 / kBucket); ++bx) grid_[bucketKey(bx, bz)].push_back(idx);
}

void BuildingRegistry::addTile(const TileCPU& t) {
    const uint32_t key = (uint32_t)t.i | ((uint32_t)t.j << 16);
    if (std::find(tiles_.begin(), tiles_.end(), key) != tiles_.end()) return;
    tiles_.push_back(key);
    if (t.bldg.empty()) return;
    std::vector<Building> add;
    if (!parseBldg(t.bldg, add)) return;
    for (Building& B : add) {
        b_.push_back(std::move(B));
        bucketAdd((uint32_t)b_.size() - 1);
    }
    ++version_;
}

void BuildingRegistry::prepare(const std::function<float(float, float)>& heightAt, const BuildingConfig& cfg) {
    for (Building& B : b_) {
        if (B.prepared) continue;
        // every footprint corner must be inside the height grid (the window): otherwise wait for a later window
        bool inside = true;
        for (int c = 0; c < 4 && inside; ++c) {
            const V3 p = B.toWorld((c & 1) ? B.w : 0.f, (c & 2) ? B.d : 0.f, 0.f);
            inside = !std::isnan(heightAt(p.x + ((c & 1) ? 3.f : -3.f) * B.e1x, p.z + ((c & 1) ? 3.f : -3.f) * B.e1z));
        }
        if (!inside) continue;
        B.prepared = true;
        // support (GAME_DESIGN 14b: unsupported buildings are documented)
        const int doors = (int)std::count_if(B.openings.begin(), B.openings.end(), [](const Opening& o) { return o.type == OpeningType::Door; });
        if (B.kind == BuildingKind::Tower) B.unsupportedWhy = "tower: no usable firing floors (B3 scope: <= 12 floors)";
        else if (B.floors > cfg.maxFloors) B.unsupportedWhy = "too tall (> buildings.maxFloors)";
        else if (!doors) B.unsupportedWhy = "no entrance in the bake";
        else if (B.w < 4.f || B.d < 4.f) B.unsupportedWhy = "footprint under 4 m";
        // the front door must open onto walkable ground (street / yard), not onto another building
        bool doorOk = false;
        for (Opening& o : B.openings) {
            if (o.type != OpeningType::Door) continue;
            const float h = heightAt(o.pos.x + o.nx * 1.5f, o.pos.z + o.nz * 1.5f);
            o.pos.y = std::isnan(h) ? B.y0 : std::min(h, B.y0 + 0.6f);
            doorOk = doorOk || (!std::isnan(h) && h < B.y0 + 0.6f);
        }
        if (!*B.unsupportedWhy && !doorOk) B.unsupportedWhy = "entrance blocked (no street at the door)";
        // windows: floors 1..windowFloors (single-storey houses: ground-floor windows), all four facades, kept where
        // the air outside is open (lower than the sill by 1 m: street, yard or a lower roof)
        const int f0 = B.floors <= 1 ? 0 : 1, f1 = std::min((int)B.floors - 1, std::max(f0, cfg.windowFloors));
        struct Cand { FiringPosition fp; Opening op; int prio; };
        std::vector<Cand> cands;
        const float sideLen[4] = {B.w, B.d, B.w, B.d};
        for (int side = 0; side < 4; ++side) {   // 0 front (v = 0, out -e2), 1 right (u = w, +e1), 2 back (v = d, +e2), 3 left (u = 0, -e1)
            const float ox = side == 0 ? -B.e2x : side == 1 ? B.e1x : side == 2 ? B.e2x : -B.e1x;
            const float oz = side == 0 ? -B.e2z : side == 1 ? B.e1z : side == 2 ? B.e2z : -B.e1z;
            const float L = sideLen[side];
            auto at = [&](float s, float inset) -> std::pair<float, float> {   // local (u, v) along the facade
                switch (side) {
                case 0: return {s, inset};
                case 1: return {B.w - inset, s};
                case 2: return {B.w - s, B.d - inset};
                default: return {inset, B.d - s};
                }
            };
            const float yawOut = std::atan2(ox, oz);
            const int nW = std::max(1, (int)std::floor((L - 2.f) / std::max(1.f, cfg.windowSpacing)));
            for (int f = f0; f <= f1; ++f) {
                const float fy = B.y0 + f * B.floorHeight;
                for (int k = 0; k < nW; ++k) {
                    const float s = (L - (nW - 1) * cfg.windowSpacing) * 0.5f + k * cfg.windowSpacing;
                    if (s < 1.f || s > L - 1.f) continue;
                    auto [u, v] = at(s, 0.3f);
                    const V3 p = B.toWorld(u, v, fy);
                    const float hOut = heightAt(p.x + ox * 2.3f, p.z + oz * 2.3f);
                    if (std::isnan(hOut) || hOut > fy - (f == 0 ? -0.5f : 1.0f)) continue;   // party wall / neighbour
                    Cand c;
                    c.fp.kind = FiringKind::Window; c.fp.floor = (uint8_t)f; c.fp.pos = p; c.fp.yaw = yawOut; c.fp.arcHalf = 1.05f;
                    c.op.type = OpeningType::Window; c.op.floor = (uint8_t)f;
                    auto [u2, v2] = at(s, 0.f);
                    c.op.pos = B.toWorld(u2, v2, fy + 0.9f);
                    c.op.nx = ox; c.op.nz = oz; c.op.width = 1.2f; c.op.height = 1.4f;
                    c.prio = (side == 0 ? 0 : 20) + f * 3 + k % 2;
                    cands.push_back(c);
                }
            }
            // roof edges (flat roofs): 0.8 m in from the edge, on the roof, over a drop to a lower surface
            if (B.flatRoof) {
                const int nR = std::max(1, (int)std::floor((L - 3.f) / std::max(1.f, cfg.roofSpacing)));
                for (int k = 0; k < nR; ++k) {
                    const float s = (L - (nR - 1) * cfg.roofSpacing) * 0.5f + k * cfg.roofSpacing;
                    if (s < 1.5f || s > L - 1.5f) continue;
                    auto [u, v] = at(s, 0.8f);
                    const V3 p = B.toWorld(u, v, B.roofY);
                    const float hIn = heightAt(p.x, p.z), hOut = heightAt(p.x + ox * 2.5f, p.z + oz * 2.5f);
                    if (std::isnan(hIn) || std::isnan(hOut) || std::fabs(hIn - B.roofY) > 0.7f || hOut > B.roofY - 2.f) continue;
                    Cand c;
                    c.fp.kind = FiringKind::RoofEdge; c.fp.floor = kRoofFloor; c.fp.pos = {p.x, hIn, p.z}; c.fp.yaw = yawOut; c.fp.arcHalf = 1.4f;
                    c.prio = (side == 0 ? 2 : 5) + k % 2;   // a few roof edges early: a squad gets windows and the roof
                    cands.push_back(c);
                }
            }
        }
        std::stable_sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) { return a.prio < b.prio; });
        if ((int)cands.size() > cfg.maxPositions) cands.resize((size_t)cfg.maxPositions);
        // firing positions in priority order (garrisons fill them first to last); window openings by floor
        std::vector<size_t> byFloor(cands.size());
        for (size_t k = 0; k < cands.size(); ++k) byFloor[k] = k;
        std::stable_sort(byFloor.begin(), byFloor.end(), [&](size_t a, size_t b) { return cands[a].fp.floor < cands[b].fp.floor; });
        for (size_t k : byFloor)
            if (cands[k].fp.kind == FiringKind::Window) { cands[k].fp.opening = (uint16_t)B.openings.size(); B.openings.push_back(cands[k].op); }
        for (Cand& c : cands) B.firing.push_back(c.fp);
        if (B.flatRoof) {   // roof hatch at the stair core
            Opening h;
            h.type = OpeningType::RoofHatch; h.floor = kRoofFloor; h.nx = 0; h.nz = 0; h.width = 1.0f; h.height = 1.0f;
            const V3 c = B.toWorld(B.stairU, B.stairV, B.roofY);
            const float hy = heightAt(c.x, c.z);
            h.pos = {c.x, std::isnan(hy) ? B.roofY : hy, c.z};
            B.openings.push_back(h);
        }
        if (!*B.unsupportedWhy && B.firing.empty()) B.unsupportedWhy = "no firing position (party walls / no open facade)";
        B.supported = !*B.unsupportedWhy;
        B.capacity = (int)B.firing.size();
        B.zombiesPerFloor.assign(B.floors, (int16_t)-1);
        ++version_;
    }
}

BuildingId BuildingRegistry::at(float x, float z, float margin) const {
    auto it = grid_.find(bucketKey((int)std::floor(x / kBucket), (int)std::floor(z / kBucket)));
    if (it == grid_.end()) return {};
    BuildingId best;
    float bestA = 1e30f;
    for (uint32_t k : it->second)
        if (b_[k].contains(x, z, margin) && b_[k].area() < bestA) { bestA = b_[k].area(); best.v = k; }
    return best;
}

void BuildingRegistry::inRect(float x0, float z0, float x1, float z1, std::vector<BuildingId>& out) const {
    out.clear();
    for (int bz = (int)std::floor(z0 / kBucket); bz <= (int)std::floor(z1 / kBucket); ++bz)
        for (int bx = (int)std::floor(x0 / kBucket); bx <= (int)std::floor(x1 / kBucket); ++bx) {
            auto it = grid_.find(bucketKey(bx, bz));
            if (it == grid_.end()) continue;
            for (uint32_t k : it->second) {
                BuildingId id; id.v = k;
                if (std::find(out.begin(), out.end(), id) == out.end()) out.push_back(id);
            }
        }
}

BuildingId BuildingRegistry::nearest(float x, float z, float maxDist, BuildingRole role, bool supportedOnly) const {
    std::vector<BuildingId> c;
    inRect(x - maxDist, z - maxDist, x + maxDist, z + maxDist, c);
    BuildingId best;
    float bd = maxDist;
    for (BuildingId id : c) {
        const Building& B = b_[id.v];
        if (role != BuildingRole::None && B.role != role) continue;
        if (supportedOnly && !B.supported) continue;
        const V3 cc = B.centre();
        const float d = std::sqrt((cc.x - x) * (cc.x - x) + (cc.z - z) * (cc.z - z));
        if (d < bd) { bd = d; best = id; }
    }
    return best;
}

int BuildingRegistry::nearestEntrance(BuildingId id, float x, float z) const {
    const Building* B = get(id);
    if (!B) return -1;
    int best = -1;
    float bd = 1e30f;
    for (size_t k = 0; k < B->openings.size(); ++k) {
        const Opening& o = B->openings[k];
        if (o.type != OpeningType::Door) continue;
        const float d = (o.pos.x - x) * (o.pos.x - x) + (o.pos.z - z) * (o.pos.z - z);
        if (d < bd) { bd = d; best = (int)k; }
    }
    return best;
}

bool BuildingRegistry::setBarricade(BuildingId id, uint16_t opening, BarricadeType t, float health) {
    Building* B = get(id);
    if (!B || opening >= B->openings.size()) return false;
    Opening& o = B->openings[opening];
    o.barricade = t;
    o.barricadeHealth = t == BarricadeType::None ? 0.f : health;
    o.barricadeMax = o.barricadeHealth;
    ++version_;
    return true;
}

bool BuildingRegistry::damageBarricade(BuildingId id, uint16_t opening, float damage) {
    Building* B = get(id);
    if (!B || opening >= B->openings.size()) return false;
    Opening& o = B->openings[opening];
    if (o.open()) return false;
    o.barricadeHealth -= damage;
    if (o.barricadeHealth > 0.f) return false;
    o.barricadeHealth = 0.f;
    broken_.push_back({id, opening, o.barricade, o.pos});
    ++version_;
    return true;
}

void BuildingRegistry::setZombieCounts(BuildingId id, int inside, int onRoof, const int16_t* perFloor, int nFloors) {
    Building* B = get(id);
    if (!B) return;
    B->zombiesInside = inside;
    B->zombiesOnRoof = onRoof;
    if (perFloor) B->zombiesPerFloor.assign(perFloor, perFloor + std::max(0, nFloors));
}

void BuildingRegistry::packOpenings(std::vector<OpeningGpu>& out, std::vector<uint32_t>& first) const {
    out.clear();
    first.assign(b_.size() + 1, 0);
    for (uint32_t b = 0; b < (uint32_t)b_.size(); ++b) {
        first[b] = (uint32_t)out.size();
        for (const Opening& o : b_[b].openings) {
            OpeningGpu g;
            g.x = o.pos.x; g.y = o.pos.y; g.z = o.pos.z; g.building = b;
            g.nx = o.nx; g.nz = o.nz; g.health = o.open() ? 0.f : o.barricadeHealth;
            g.flags = (uint32_t)o.type | ((uint32_t)o.floor << 8) | (o.open() ? 0u : 1u << 16);
            out.push_back(g);
        }
    }
    first[b_.size()] = (uint32_t)out.size();
}

int BuildingRegistry::supportedCount() const {
    int n = 0;
    for (const Building& B : b_) n += B.supported ? 1 : 0;
    return n;
}

} // namespace ttz::game
