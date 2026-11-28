// Building registry (B3a; shared with B3b): BLDG parsing, derived openings / firing positions, spatial queries,
// barricade state. See Buildings.h.
#include "game/Buildings.h"

#include "city/CityAsset.h"
#include "game/Config.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
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
float d2(V3 a, V3 b) { return (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z); }
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
    readGlass(t);
    ++version_;
}

// Window rects of the facade art (GAME_DESIGN 14e window posts): every vertical glass quad of the tile's LOD0 mesh is
// mapped to the facade of the building whose footprint edge it lies on, then panes of one window (mullions, transoms)
// are merged into one rect. Buildings not prepared yet only (prepare turns the rects into window positions).
void BuildingRegistry::readGlass(const TileCPU& t) {
    const CityMesh& m = t.lod[0];
    if (glassMat_.empty() || !m.idx.empty() || m.verts.size() < 4) return;
    const size_t nq = m.verts.size() / 4;
    std::vector<std::vector<FacadeGlass>> raw(b_.size()), rawDoor(b_.size());
    for (size_t q = 0; q < nq; ++q) {
        const CityVertex* v = &m.verts[q * 4];
        const bool glass = v[0].mat < glassMat_.size() && glassMat_[v[0].mat];
        const bool door = !glass && v[0].mat < doorMat_.size() && doorMat_[v[0].mat];
        if (!glass && !door) continue;
        const float nx = v[0].nx / 127.f, ny = v[0].ny / 127.f, nz = v[0].nz / 127.f;
        if (std::fabs(ny) > 0.3f) continue;
        V3 p[4], c{0, 0, 0};
        for (int k = 0; k < 4; ++k) {
            p[k] = {m.origin[0] + v[k].x * m.scaleXZ, m.origin[1] + v[k].y * m.scaleY, m.origin[2] + v[k].z * m.scaleXZ};
            c = c + p[k] * 0.25f;
        }
        const BuildingId id = at(c.x, c.z, door ? 3.0f : 1.5f);
        if (!id.valid() || b_[id.v].prepared) continue;
        const Building& B = b_[id.v];
        if (door && c.y > B.y0 + 3.6f) continue;   // doors: ground floor only
        const float dots[4] = {-(nx * B.e2x + nz * B.e2z), nx * B.e1x + nz * B.e1z, nx * B.e2x + nz * B.e2z, -(nx * B.e1x + nz * B.e1z)};
        int side = 0;
        for (int k = 1; k < 4; ++k) if (dots[k] > dots[side]) side = k;
        if (dots[side] < 0.9f) continue;
        FacadeGlass g;
        g.side = (uint8_t)side;
        g.s0 = g.y0 = 1e9f; g.s1 = g.y1 = -1e9f;
        float ins = 0.f;
        for (int k = 0; k < 4; ++k) {
            float u, w2;
            B.toLocal(p[k].x, p[k].z, u, w2);
            const float s = side == 0 ? u : side == 1 ? w2 : side == 2 ? B.w - u : B.d - w2;
            const float in = side == 0 ? w2 : side == 1 ? B.w - u : side == 2 ? B.d - w2 : u;
            g.s0 = std::min(g.s0, s); g.s1 = std::max(g.s1, s);
            g.y0 = std::min(g.y0, p[k].y); g.y1 = std::max(g.y1, p[k].y);
            ins += in * 0.25f;
        }
        g.inset = ins;
        const float L = (side & 1) ? B.d : B.w;
        if (ins < -0.6f || ins > (door ? 3.0f : 1.6f) || g.s1 - g.s0 < 0.05f || g.y1 - g.y0 < 0.2f || g.s1 < 0.f || g.s0 > L) continue;
        (door ? rawDoor : raw)[id.v].push_back(g);
    }
    // merge panes of one window (mullions, transoms) / quads of one door leaf: same facade and plane, touching side by
    // side or stacked
    auto merge = [](std::vector<FacadeGlass>& r) {
        for (bool merged = true; merged;) {
            merged = false;
            for (size_t i = 0; i < r.size(); ++i)
                for (size_t j = i + 1; j < r.size(); ++j) {
                    FacadeGlass &a = r[i], &c = r[j];
                    if (a.side != c.side || std::fabs(a.inset - c.inset) > 0.15f) continue;
                    const float sOv = std::min(a.s1, c.s1) - std::max(a.s0, c.s0), yOv = std::min(a.y1, c.y1) - std::max(a.y0, c.y0);
                    const float minW = std::min(a.s1 - a.s0, c.s1 - c.s0), minH = std::min(a.y1 - a.y0, c.y1 - c.y0);
                    const bool beside = sOv > -0.3f && yOv > 0.5f * minH, stacked = sOv > 0.5f * minW && yOv > -0.4f;
                    if (!beside && !stacked) continue;
                    const float wa = (a.s1 - a.s0) * (a.y1 - a.y0), wc = (c.s1 - c.s0) * (c.y1 - c.y0);
                    a.inset = (a.inset * wa + c.inset * wc) / std::max(1e-4f, wa + wc);
                    a.s0 = std::min(a.s0, c.s0); a.s1 = std::max(a.s1, c.s1);
                    a.y0 = std::min(a.y0, c.y0); a.y1 = std::max(a.y1, c.y1);
                    r[j] = r.back();
                    r.pop_back();
                    j = i;   // a grew: scan the others again
                    merged = true;
                }
        }
    };
    for (size_t b = 0; b < raw.size(); ++b) {
        std::vector<FacadeGlass>& r = raw[b];
        merge(r);
        b_[b].glass.insert(b_[b].glass.end(), r.begin(), r.end());
        std::vector<FacadeGlass>& d = rawDoor[b];
        merge(d);
        for (const FacadeGlass& g : d)   // a door leaf: from the ground floor, door sized
            if (g.y0 < b_[b].y0 + 1.4f && g.y1 - g.y0 >= 1.6f && g.y1 - g.y0 <= 3.8f && g.s1 - g.s0 >= 0.6f && g.s1 - g.s0 <= 4.0f) b_[b].doorArt.push_back(g);
    }
}

void BuildingRegistry::prepare(const std::function<float(float, float)>& heightAt, const BuildingConfig& cfg) {
    for (uint32_t bi = 0; bi < (uint32_t)b_.size(); ++bi) {
        Building& B = b_[bi];
        if (B.prepared) continue;
        // every footprint corner must be inside the height grid (the window): otherwise wait for a later window
        bool inside = true;
        for (int c = 0; c < 4 && inside; ++c) {
            const V3 p = B.toWorld((c & 1) ? B.w : 0.f, (c & 2) ? B.d : 0.f, 0.f);
            inside = !std::isnan(heightAt(p.x + ((c & 1) ? 3.f : -3.f) * B.e1x, p.z + ((c & 1) ? 3.f : -3.f) * B.e1z));
        }
        if (!inside) continue;
        B.prepared = true;
        // facade frame: side 0 front (v = 0, out -e2), 1 right (u = w, +e1), 2 back (v = d, +e2), 3 left (u = 0, -e1)
        const float sideLen[4] = {B.w, B.d, B.w, B.d};
        const float outX[4] = {-B.e2x, B.e1x, B.e2x, -B.e1x}, outZ[4] = {-B.e2z, B.e1z, B.e2z, -B.e1z};
        auto facadeUV = [&](int side, float s, float inset) -> std::pair<float, float> {
            switch (side) {
            case 0: return {s, inset};
            case 1: return {B.w - inset, s};
            case 2: return {B.w - s, B.d - inset};
            default: return {inset, B.d - s};
            }
        };
        auto facadeAt = [&](int side, float s, float inset, float y) { auto [u, v] = facadeUV(side, s, inset); return B.toWorld(u, v, y); };
        auto sideOf = [&](float nx, float nz) {
            int best = 0;
            for (int k = 1; k < 4; ++k) if (nx * outX[k] + nz * outZ[k] > nx * outX[best] + nz * outZ[best]) best = k;
            return best;
        };
        auto sAlong = [&](int side, float x, float z) {
            float u, v;
            B.toLocal(x, z, u, v);
            return side == 0 ? u : side == 1 ? v : side == 2 ? B.w - u : B.d - v;
        };
        auto streetOut = [&](V3 p, float nx, float nz) {   // walkable ground in front of a door (street / yard)
            // from the leaf out past the footprint edge (porches / stoops / canopies are inside the footprint)
            float u, v;
            B.toLocal(p.x, p.z, u, v);
            const float ins = std::max(0.f, std::max({-(nx * B.e2x + nz * B.e2z) * v, (nx * B.e1x + nz * B.e1z) * (B.w - u),
                                                      (nx * B.e2x + nz * B.e2z) * (B.d - v), -(nx * B.e1x + nz * B.e1z) * u}));
            const float h1 = heightAt(p.x + nx * (ins + 1.5f), p.z + nz * (ins + 1.5f)), h2 = heightAt(p.x + nx * (ins + 3.0f), p.z + nz * (ins + 3.0f));
            return !std::isnan(h1) && !std::isnan(h2) && h1 < B.y0 + 0.6f && h2 < B.y0 + 0.9f;
        };
        // ---- doors (owner round 15: every building has an entrance). Bake doors are snapped onto the door leaf of the
        // facade art (position along the facade, plane, width, height) so barricades sit in the real opening; doors that
        // open onto another building are dropped; with no usable door an entrance is added on the street-facing facade
        // (an art door when there is one, else the facade point with open street in front of it).
        std::vector<uint8_t> artUsed(B.doorArt.size(), 0);
        auto snapArt = [&](Opening& o, int side, int k) {
            const FacadeGlass& g = B.doorArt[(size_t)k];
            artUsed[(size_t)k] = 1;
            o.pos = facadeAt(side, 0.5f * (g.s0 + g.s1), g.inset, g.y0);
            o.nx = outX[side]; o.nz = outZ[side];
            o.width = g.s1 - g.s0; o.height = g.y1 - g.y0;
            o.art = true;
        };
        for (Opening& o : B.openings) {
            if (o.type != OpeningType::Door) continue;
            const int side = sideOf(o.nx, o.nz);
            const float s = sAlong(side, o.pos.x, o.pos.z);
            int best = -1;
            float bd = 6.f;
            for (size_t k = 0; k < B.doorArt.size(); ++k) {
                const FacadeGlass& g = B.doorArt[k];
                const float dk = std::fabs(0.5f * (g.s0 + g.s1) - s) + 2.f * std::max(0.f, g.y0 - B.y0);   // prefer street-level leaves
                if (g.side == side && !artUsed[k] && dk < bd) { bd = dk; best = (int)k; }
            }
            if (best >= 0) snapArt(o, side, best);
            else {
                o.nx = outX[side]; o.nz = outZ[side];
                o.pos = facadeAt(side, s, 0.f, B.y0);
                o.height = std::min(2.3f, B.floorHeight - 0.3f);
            }
        }
        std::vector<Opening> doors;
        for (const Opening& o : B.openings) if (o.type == OpeningType::Door && streetOut(o.pos, o.nx, o.nz)) doors.push_back(o);
        if (doors.empty()) {
            for (size_t k = 0; k < B.doorArt.size() && doors.empty(); ++k) {
                Opening o;
                snapArt(o, B.doorArt[k].side, (int)k);
                if (streetOut(o.pos, o.nx, o.nz)) doors.push_back(o);
            }
            for (int pass = 0; pass < 4 && doors.empty(); ++pass) {
                const int side = pass;   // front first, then right, back, left
                const float L = sideLen[side];
                for (float off = 0.f; off <= 0.5f * L - 1.2f && doors.empty(); off += 0.5f)
                    for (int sg = -1; sg <= 1 && doors.empty(); sg += 2) {
                        Opening o;
                        o.pos = facadeAt(side, 0.5f * L + off * (float)sg, 0.f, B.y0);
                        o.nx = outX[side]; o.nz = outZ[side];
                        o.width = std::min(1.4f, L - 0.8f); o.height = std::min(2.3f, B.floorHeight - 0.3f);
                        if (streetOut(o.pos, o.nx, o.nz)) doors.push_back(o);
                    }
            }
            if (doors.empty()) {   // enclosed lot: the front middle all the same (the height grid has no way in)
                Opening o;
                o.pos = facadeAt(0, 0.5f * B.w, 0.f, B.y0);
                o.nx = outX[0]; o.nz = outZ[0];
                o.width = std::min(1.4f, B.w - 0.8f); o.height = std::min(2.3f, B.floorHeight - 0.3f);
                doors.push_back(o);
            }
            B.doorAdded = true;
        }
        for (Opening& o : doors) {
            o.type = OpeningType::Door; o.floor = 0;
            if (!o.art) {
                const float h = heightAt(o.pos.x + o.nx * 1.5f, o.pos.z + o.nz * 1.5f);
                o.pos.y = std::isnan(h) ? B.y0 : std::min(h, B.y0 + 0.6f);
            }
        }
        B.openings = doors;
        // windows: floors 1..windowFloors (single-storey houses: ground-floor windows; tall buildings: the lower floors
        // plus the roof), all four facades, kept where the view out is open: no neighbouring building within 4 m in
        // front of the window and lower ground / roof just outside
        const int f0 = B.floors <= 1 ? 0 : 1, f1 = std::min((int)B.floors - 1, std::max(f0, cfg.windowFloors));
        struct Cand { FiringPosition fp; Opening op; int prio; int side = 0; float s = 0, hw = 0; };
        std::vector<Cand> cands;
        auto viewOpen = [&](int side, float s, float fy, float sill, int f) {
            const V3 pe = facadeAt(side, s, 0.3f, fy);
            const float ox = outX[side], oz = outZ[side];
            const float hOut = heightAt(pe.x + ox * 2.3f, pe.z + oz * 2.3f);
            if (std::isnan(hOut) || hOut > fy - (f == 0 ? -0.5f : 1.0f)) return false;   // party wall / neighbour
            for (float t = 1.0f; t <= 4.0f; t += 0.5f) {                              // a neighbour's facade in front
                const float x = pe.x + ox * t, z = pe.z + oz * t;
                const BuildingId nb = at(x, z, 0.f);
                if (!nb.valid() || nb.v == bi) continue;
                const float h = heightAt(x, z);
                if (!std::isnan(h) && h > sill - 0.3f) return false;
            }
            return true;
        };
        auto genSide = [&](int side, bool derived, bool relax) {
            const float ox = outX[side], oz = outZ[side];
            const float L = sideLen[side];
            const float yawOut = std::atan2(ox, oz);
            const float depthAvail = (side & 1) ? B.w : B.d;   // footprint depth behind this facade
            // Window posts (GAME_DESIGN 14e): real windows of the facade art when the tile mesh has glass for this
            // building (a facade without glass then has no window post: party wall / blank wall); otherwise windows
            // every windowSpacing m (older packages / fallback). Each post is an opening the renderer cuts out of the
            // facade with a small room behind it (floor = the soldier's feet).
            struct Win { float s, hw, a, b, inset; bool real; };
            for (int f = f0; f <= f1; ++f) {
                const float fy = B.y0 + f * B.floorHeight, top = fy + B.floorHeight;
                std::vector<Win> ws;
                if (!B.glass.empty() && !derived) {
                    for (const FacadeGlass& g : B.glass) {
                        if (g.side != side) continue;
                        const float a = std::max(g.y0, fy + 0.05f), b = std::min(g.y1, top - 0.12f);
                        if (b - a < 0.6f || 0.5f * (a + b) < fy || 0.5f * (a + b) > top) continue;
                        const float width = g.s1 - g.s0;
                        if (width < 0.45f) continue;
                        const int n = std::max(1, (int)std::ceil(width / 2.4f));   // curtain walls / shop glazing: panels
                        const float seg = width / (float)n;
                        for (int i = 0; i < n; ++i) {
                            const float c = g.s0 + (i + 0.5f) * seg;
                            const float hw = n > 1 ? std::min(0.8f, 0.5f * seg - 0.06f) : 0.5f * width;
                            ws.push_back({c, hw, a, b, g.inset, true});
                        }
                    }
                    std::sort(ws.begin(), ws.end(), [](const Win& x, const Win& y) { return x.s < y.s; });
                    // spread: at most one post per ~0.75 x windowSpacing (rooms never overlap, positions spread out)
                    std::vector<Win> keep;
                    for (const Win& w : ws) {
                        if (w.s - w.hw < 0.35f || w.s + w.hw > L - 0.35f) continue;
                        if (!keep.empty() && w.s - keep.back().s < 0.75f * cfg.windowSpacing) continue;
                        keep.push_back(w);
                    }
                    ws.swap(keep);
                } else if (B.glass.empty() || derived) {
                    const int nW = std::max(1, (int)std::floor((L - 2.f) / std::max(1.f, cfg.windowSpacing)));
                    for (int k = 0; k < nW; ++k) {
                        const float s = (L - (nW - 1) * cfg.windowSpacing) * 0.5f + k * cfg.windowSpacing;
                        if (s < 1.f || s > L - 1.f) continue;
                        ws.push_back({s, 0.6f, fy + 0.9f, std::min(top - 0.3f, fy + 2.3f), 0.12f, false});
                    }
                }
                int rank = 0;
                for (size_t k = 0; k < ws.size(); ++k) {
                    Win w = ws[k];
                    if (!relax && !viewOpen(side, w.s, fy, w.a, f)) continue;
                    const float feet = std::max(fy, w.a - 1.15f);                     // sill at chest height at most
                    float ceil = std::min(top - 0.03f, std::max(w.b + 0.3f, feet + 2.5f));
                    if (w.b > ceil - 0.03f) w.b = ceil - 0.03f;
                    float rhw = std::min({w.hw + 0.9f, w.s - 0.25f, L - w.s - 0.25f});
                    if (k > 0) rhw = std::min(rhw, 0.5f * (w.s - ws[k - 1].s) - 0.05f);
                    if (k + 1 < ws.size()) rhw = std::min(rhw, 0.5f * (ws[k + 1].s - w.s) - 0.05f);
                    if (rhw < w.hw + 0.1f) w.hw = std::max(0.3f, rhw - 0.1f);
                    const float stand = w.inset + 0.55f;                              // behind the glass, inside the room
                    Cand c;
                    c.fp.kind = FiringKind::Window; c.fp.floor = (uint8_t)f; c.fp.pos = facadeAt(side, w.s, stand, feet); c.fp.yaw = yawOut; c.fp.arcHalf = 1.05f;
                    c.fp.outReach = stand + 0.6f;                                     // firing point 0.6 m outside the footprint
                    c.fp.realWindow = w.real;
                    c.fp.win = facadeAt(side, w.s, w.inset, w.a);
                    c.fp.winHalfW = w.hw; c.fp.winH = w.b - w.a;
                    c.fp.roomHalfW = std::max(rhw, w.hw + 0.1f);
                    c.fp.roomDepth = std::clamp(depthAvail - w.inset - 0.8f, 1.2f, 2.4f);
                    c.fp.roomFloor = feet; c.fp.roomCeil = ceil;
                    c.op.type = OpeningType::Window; c.op.floor = (uint8_t)f;
                    c.op.pos = c.fp.win;
                    c.op.nx = ox; c.op.nz = oz; c.op.width = 2.f * w.hw; c.op.height = w.b - w.a;
                    // every facade gets its first windows early (owner round 15: posts on every facade with windows)
                    c.prio = rank * 8 + (f - f0) * 2 + (side == 0 ? 0 : 1);
                    c.side = side; c.s = w.s; c.hw = w.hw;
                    cands.push_back(c);
                    ++rank;
                }
            }
            // roof posts (flat roofs, GAME_DESIGN 14e): set back from the edge (the soldier 1.9 m in, the sandbag ring /
            // position in front of him ~1 m in), on a flat patch of the actual roof surface (no HVAC, hatch, parapet
            // or other prop under the ring), over a drop to a lower surface
            if (B.flatRoof && !derived) {
                const float ring = 1.8f;                                             // fort_roof_ring radius
                const int nR = std::max(1, (int)std::floor((L - 3.f) / std::max(1.f, cfg.roofSpacing)));
                const V3 avoid[3] = {B.toWorld(1.0f, 1.0f, 0), B.toWorld(B.w - 1.2f, B.d - 1.2f, 0), B.toWorld(B.stairU, B.stairV, 0) + V3{B.e1x * 0.6f, 0, B.e1z * 0.6f}};
                for (int k = 0; k < nR; ++k) {
                    const float s0 = (L - (nR - 1) * cfg.roofSpacing) * 0.5f + k * cfg.roofSpacing;
                    {
                        const V3 e = facadeAt(side, s0, 0.f, B.roofY);
                        const float hOut = heightAt(e.x + ox * 1.7f, e.z + oz * 1.7f);
                        if (std::isnan(hOut) || hOut > B.roofY - 2.f) continue;      // no drop: neighbour / lower roof
                    }
                    // search: set back 1.6 .. 3 m, slid along the edge up to 2.25 m; the U position (2.6 x 1.8 m around
                    // him) must fit on flat roof; the ring (3.6 m) is drawn only where it fits too (else the U position)
                    bool placed = false;
                    static const float insets[4] = {1.6f, 1.9f, 2.4f, 3.0f}, slide[7] = {0.f, 0.75f, -0.75f, 1.5f, -1.5f, 2.25f, -2.25f};
                    for (int t = 0; t < 28 && !placed; ++t) {
                        const float s = s0 + slide[t % 7];
                        // the real roof edge along this line (the footprint can include awnings / canopies below it)
                        float edge = -1.f;
                        for (float o = 0.f; o <= 6.f && edge < 0.f; o += 0.25f) {
                            const V3 w = facadeAt(side, s, o, 0.f);
                            const float h = heightAt(w.x, w.z);
                            if (!std::isnan(h) && h >= B.roofY - 0.7f) edge = o;
                        }
                        if (edge < 0.f) continue;
                        const float ins = edge + insets[t / 7];
                        if (s < 1.6f || s > L - 1.6f || ins + 1.4f > depthAvail - 0.6f) continue;
                        const V3 p = facadeAt(side, s, ins, B.roofY);
                        const float hc = heightAt(p.x, p.z);
                        if (std::isnan(hc) || hc < B.roofY - 0.7f || hc > std::min(B.topY - 0.5f, B.roofY + 3.5f)) continue;   // roof levels (setbacks)
                        auto flat = [&](float sa, float sb, float oa, float ob) {   // facade-frame rect: s range, inset range
                            for (float q = sa; q <= sb + 1e-3f; q += 0.4f)
                                for (float o = oa; o <= ob + 1e-3f; o += 0.4f) {
                                    const V3 w = facadeAt(side, s + q, ins + o, 0.f);
                                    const float h = heightAt(w.x, w.z);
                                    if (std::isnan(h) || h < hc - 0.35f || h > hc + 0.3f) return false;
                                }
                            return true;
                        };
                        if (!flat(-1.3f, 1.3f, -0.6f, 1.3f)) continue;
                        const V3 cc = facadeAt(side, s, ins + 0.9f, B.roofY);
                        bool ok = true;
                        for (const V3& a : avoid) ok = ok && d2(a, p) > 2.0f * 2.0f;
                        for (const Cand& o : cands)
                            if (o.fp.kind == FiringKind::RoofEdge) ok = ok && d2(o.fp.pos, p) > 3.9f * 3.9f;
                        if (!ok) continue;
                        bool ringOk = ins + 0.9f + ring <= depthAvail - 0.6f && flat(-ring, ring, 0.9f - ring, 0.9f + ring);
                        for (const V3& a : avoid) ringOk = ringOk && d2(a, cc) > (ring + 0.7f) * (ring + 0.7f);
                        Cand c;
                        c.fp.kind = FiringKind::RoofEdge; c.fp.floor = kRoofFloor; c.fp.pos = {p.x, hc, p.z}; c.fp.yaw = yawOut; c.fp.arcHalf = 1.4f;
                        c.fp.outReach = ins + 0.6f;
                        c.fp.ringFits = ringOk;
                        c.prio = (side == 0 ? 1 : 3) + 8 * k;   // a few roof edges early: a squad gets windows and the roof
                        c.side = side;
                        cands.push_back(c);
                        placed = true;
                    }
                }
            }
        };
        for (int side = 0; side < 4; ++side) genSide(side, false, false);
        // no post from the facade art (blank / party walls everywhere): derived windows where the view is open, at
        // worst on the front facade regardless (every building can be garrisoned)
        if (cands.empty()) for (int side = 0; side < 4; ++side) genSide(side, true, false);
        if (cands.empty()) genSide(0, true, true);
        std::stable_sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) { return a.prio < b.prio; });
        if ((int)cands.size() > cfg.maxPositions) cands.resize((size_t)cfg.maxPositions);
        // firing positions in priority order (garrisons fill them first to last); window openings by floor
        std::vector<size_t> byFloor(cands.size());
        for (size_t k = 0; k < cands.size(); ++k) byFloor[k] = k;
        std::stable_sort(byFloor.begin(), byFloor.end(), [&](size_t a, size_t b) { return cands[a].fp.floor < cands[b].fp.floor; });
        for (size_t k : byFloor)
            if (cands[k].fp.kind == FiringKind::Window) { cands[k].fp.opening = (uint16_t)B.openings.size(); B.openings.push_back(cands[k].op); }
        for (Cand& c : cands) B.firing.push_back(c.fp);
        // closed windows of the lower floors (ground + first): the fortification's window covers, flush on the glass of
        // the facade art; never on a firing window, never over a door leaf
        B.covers.clear();
        const int cf1 = std::min((int)B.floors - 1, 1);
        for (const FacadeGlass& g : B.glass) {
            for (int f = 0; f <= cf1; ++f) {
                const float fy = B.y0 + f * B.floorHeight, top = fy + B.floorHeight;
                const float a = std::max(g.y0, fy), b = std::min(g.y1, top);
                if (b - a < 0.4f || g.s1 - g.s0 < 0.3f) continue;
                const float width = g.s1 - g.s0;
                const int n = std::max(1, (int)std::ceil(width / 1.8f));
                const float seg = width / (float)n;
                for (int i = 0; i < n; ++i) {
                    const float p0 = g.s0 + i * seg, p1 = p0 + seg;
                    bool skip = false;
                    for (const Cand& c : cands)
                        if (c.fp.kind == FiringKind::Window && c.side == g.side && c.fp.floor == f && c.s + c.hw > p0 - 0.05f && c.s - c.hw < p1 + 0.05f) skip = true;
                    for (const FacadeGlass& d : B.doorArt)
                        if (d.side == g.side && d.s1 > p0 && d.s0 < p1 && d.y1 > a && d.y0 < b) skip = true;
                    for (const Opening& o : B.openings) {
                        if (o.type != OpeningType::Door || sideOf(o.nx, o.nz) != g.side) continue;
                        const float sd = sAlong(g.side, o.pos.x, o.pos.z);
                        if (sd + 0.5f * o.width > p0 && sd - 0.5f * o.width < p1 && a < o.pos.y + o.height) skip = true;
                    }
                    if (skip) continue;
                    WindowCover wc;
                    wc.floor = (uint8_t)f; wc.side = g.side;
                    wc.c = facadeAt(g.side, 0.5f * (p0 + p1), g.inset, a);
                    wc.nx = outX[g.side]; wc.nz = outZ[g.side];
                    wc.halfW = 0.5f * seg; wc.h = b - a;
                    B.covers.push_back(wc);
                }
            }
        }
        if (B.flatRoof) {   // roof hatch at the stair core
            Opening h;
            h.type = OpeningType::RoofHatch; h.floor = kRoofFloor; h.nx = 0; h.nz = 0; h.width = 1.0f; h.height = 1.0f;
            const V3 c = B.toWorld(B.stairU, B.stairV, B.roofY);
            const float hy = heightAt(c.x, c.z);
            h.pos = {c.x, std::isnan(hy) ? B.roofY : hy, c.z};
            B.openings.push_back(h);
        }
        // owner round 15: every building is supported (no "too tall" / "no entrance" / footprint refusals)
        B.unsupportedWhy = "";
        B.supported = true;
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
