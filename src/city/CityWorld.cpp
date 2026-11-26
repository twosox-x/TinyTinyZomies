#include "city/CityWorld.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <thread>

namespace ttz {

bool buildCityWindow(const CityAsset& city, float cx, float cz, float cell, int gw, int gh, Sandbox& sb) {
    sb = Sandbox{};
    sb.map = MapKind::Baked;
    sb.cellSize = cell;
    sb.gridW = gw;
    sb.gridH = gh;
    // snap the window corner to the collision grid and keep it inside the city
    const float W = gw * cell, H = gh * cell;
    float ox = std::clamp(cx - 0.5f * W, city.x0, std::max(city.x0, city.x1 - W));
    float oz = std::clamp(cz - 0.5f * H, city.z0, std::max(city.z0, city.z1 - H));
    sb.originX = std::round(ox / city.collisionCell) * city.collisionCell;
    sb.originZ = std::round(oz / city.collisionCell) * city.collisionCell;
    sb.wallX = sb.originX + 0.5f * W;
    std::vector<float>& h = sb.heightOverride;
    h.assign((size_t)gw * gh, 0.f);
    int i0 = (int)std::floor((sb.originX - city.x0) / city.tileSize), i1 = (int)std::floor((sb.originX + W - city.x0) / city.tileSize);
    int j0 = (int)std::floor((sb.originZ - city.z0) / city.tileSize), j1 = (int)std::floor((sb.originZ + H - city.z0) / city.tileSize);
    int tiles = 0;
    for (int j = std::max(0, j0); j <= std::min(city.nj - 1, j1); ++j)
        for (int i = std::max(0, i0); i <= std::min(city.ni - 1, i1); ++i) {
            TileCPU t;
            if (!city.decodeTileNow(i, j, t) || t.heightCm.empty()) continue;
            ++tiles;
            // every 0.5 m sample raises the sim cell containing its centre (max = conservative: no leaking into walls)
            for (int z = 0; z < t.gh; ++z) {
                float wz = t.gz0 + (z + 0.5f) * t.gcell;
                int cz2 = (int)std::floor((wz - sb.originZ) / cell);
                if (cz2 < 0 || cz2 >= gh) continue;
                for (int x = 0; x < t.gw; ++x) {
                    float wx = t.gx0 + (x + 0.5f) * t.gcell;
                    int cx2 = (int)std::floor((wx - sb.originX) / cell);
                    if (cx2 < 0 || cx2 >= gw) continue;
                    size_t k = (size_t)z * t.gw + x;
                    float top = t.heightCm[k] * 0.01f;
                    // water is not walkable: treat it as a low wall the horde flows around
                    if ((t.flags[k] & CELL_WATER) && top < 1.0f) top = 1.0f;
                    float& c = h[(size_t)cz2 * gw + cx2];
                    c = std::max(c, top);
                }
            }
        }
    // scenarios: spawn points inside the window (with a margin), goal = the window centre's nearest spawn
    Scenario sc;
    sc.name = "City (baked): street horde";
    sc.map = MapKind::Baked;
    float best = 1e30f, gx = sb.wallX, gz = sb.originZ + 0.5f * H;
    std::vector<Rect> spawns;
    for (const CitySpawn& s : city.spawns) {
        if (s.x < sb.originX + 8 || s.z < sb.originZ + 8 || s.x > sb.originX + W - 8 || s.z > sb.originZ + H - 8) continue;
        spawns.push_back({s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r});
        float dx = s.x - (sb.originX + 0.5f * W), dz = s.z - (sb.originZ + 0.5f * H);
        if (dx * dx + dz * dz < best) { best = dx * dx + dz * dz; gx = s.x; gz = s.z; }
    }
    if (spawns.empty()) spawns.push_back({sb.originX + 0.5f * W - 4, sb.originZ + 0.5f * H - 4, sb.originX + 0.5f * W + 4, sb.originZ + 0.5f * H + 4});
    // horde: spawns away from the goal; converge on it
    Scenario horde = sc;
    for (const Rect& r : spawns) {
        float dx = 0.5f * (r.minX + r.maxX) - gx, dz = 0.5f * (r.minZ + r.maxZ) - gz;
        if (dx * dx + dz * dz > 60.f * 60.f) horde.spawns.push_back(r);
    }
    if (horde.spawns.empty()) horde.spawns = spawns;
    horde.goals = {gx, gz};
    horde.defaultCount = 6000;
    sb.scenarios.push_back(horde);
    Scenario wander{"City (baked): dispersed, no destination", MapKind::Baked, spawns, {}, 4000};
    sb.scenarios.push_back(wander);
    SDL_Log("city window: origin (%.1f, %.1f), %d x %d cells of %.2f m, %d tiles sampled, %zu spawn points", sb.originX, sb.originZ,
            gw, gh, cell, tiles, spawns.size());
    return tiles > 0;
}

// For a fixed moon direction L, a point at height y over (x, z) is shadowed iff some sample along the ray towards
// the moon is below the static top: threshold(x, z) = max_t (H(p + t * Lxz) - t * L.y / |Lxz|). Marching at
// 0.25 m to the highest roof's shadow reach; rows in parallel.
std::vector<float> cityShadowField(const std::vector<float>& heights, int gw, int gh, float cell, float originX, float originZ) {
    const float Lx = -0.35f, Ly = 0.8f, Lz = 0.45f;   // must match Renderer (normalised there; only ratios matter here)
    const float lh = std::sqrt(Lx * Lx + Lz * Lz), dx = Lx / lh, dz = Lz / lh, rise = Ly / lh;   // rise per horizontal metre
    const int W = gw * 3, H = gh * 3;
    const float sc = cell / 3.f;
    float maxH = 0;
    for (float v : heights) maxH = std::max(maxH, v);
    const float reach = maxH / rise, step = 0.25f;
    std::vector<float> field((size_t)W * H, -1.f);
    auto worker = [&](int r0, int r1) {
        for (int cz = r0; cz < r1; ++cz)
            for (int cx = 0; cx < W; ++cx) {
                float x = originX + (cx + 0.5f) * sc, z = originZ + (cz + 0.5f) * sc, best = -1.f;
                for (float t = 0; t <= reach; t += step) {
                    int gx = (int)std::floor((x + dx * t - originX) / cell), gz = (int)std::floor((z + dz * t - originZ) / cell);
                    if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) break;
                    float v = heights[(size_t)gz * gw + gx];
                    if (v > 0) best = std::max(best, v - t * rise);
                    if (maxH - t * rise < best) break;   // nothing further can be higher
                }
                field[(size_t)cz * W + cx] = best;
            }
    };
    int n = std::max(1u, std::min(16u, std::thread::hardware_concurrency()));
    std::vector<std::thread> th;
    for (int k = 0; k < n; ++k) th.emplace_back(worker, H * k / n, H * (k + 1) / n);
    for (auto& t : th) t.join();
    return field;
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic package (FORMAT.md v1 subset): MSH0 + VEHI + PROP + HGT0 per tile, one car variant, one lamp type.
namespace {
struct Bin {
    std::vector<uint8_t> b;
    template <class T> void put(T v) { raw(&v, sizeof(T)); }
    void raw(const void* p, size_t n) {
        size_t o = b.size();
        b.resize(o + n);
        std::memcpy(b.data() + o, p, n);
    }
    void tag(const char* t) { raw(t, 4); }
    void align() { while (b.size() & 3) b.push_back(0); }
};
struct MeshBuilder {
    float sxz, sy, ox, oy, oz;
    std::vector<CityVertex> v;
    std::vector<uint32_t> idx;
    float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
    void box(float x0, float y0, float z0, float x1, float y1, float z1, uint8_t mat, uint16_t flags = 0, bool top = true) {
        const int C[6][4][3] = {{{1, 0, 0}, {1, 1, 0}, {1, 1, 1}, {1, 0, 1}}, {{0, 0, 1}, {0, 1, 1}, {0, 1, 0}, {0, 0, 0}},
                                {{0, 1, 0}, {0, 1, 1}, {1, 1, 1}, {1, 1, 0}}, {{0, 0, 1}, {0, 0, 0}, {1, 0, 0}, {1, 0, 1}},
                                {{1, 0, 1}, {1, 1, 1}, {0, 1, 1}, {0, 0, 1}}, {{0, 0, 0}, {0, 1, 0}, {1, 1, 0}, {1, 0, 0}}};
        const int8_t N[6][3] = {{127, 0, 0}, {-127, 0, 0}, {0, 127, 0}, {0, -127, 0}, {0, 0, 127}, {0, 0, -127}};
        for (int f = 0; f < 6; ++f) {
            if (f == 3 || (f == 2 && !top)) continue;   // no bottoms
            uint32_t base = (uint32_t)v.size();
            for (int k = 0; k < 4; ++k) {
                float p[3] = {C[f][k][0] ? x1 : x0, C[f][k][1] ? y1 : y0, C[f][k][2] ? z1 : z0};
                for (int c = 0; c < 3; ++c) { mn[c] = std::min(mn[c], p[c]); mx[c] = std::max(mx[c], p[c]); }
                v.push_back({(int16_t)std::lround((p[0] - ox) / sxz), (int16_t)std::lround((p[1] - oy) / sy), (int16_t)std::lround((p[2] - oz) / sxz),
                             flags, N[f][0], N[f][1], N[f][2], mat});
            }
            for (uint32_t t : {0u, 1u, 2u, 0u, 2u, 3u}) idx.push_back(base + t);
        }
    }
    void quadUp(float x0, float z0, float x1, float z1, float y, uint8_t mat) {
        uint32_t base = (uint32_t)v.size();
        const float P[4][2] = {{x0, z0}, {x0, z1}, {x1, z1}, {x1, z0}};   // CCW seen from +y
        for (auto& p : P) {
            v.push_back({(int16_t)std::lround((p[0] - ox) / sxz), (int16_t)std::lround((y - oy) / sy), (int16_t)std::lround((p[1] - oz) / sxz), 0, 0, 127, 0, mat});
            mn[0] = std::min(mn[0], p[0]); mx[0] = std::max(mx[0], p[0]); mn[2] = std::min(mn[2], p[1]); mx[2] = std::max(mx[2], p[1]);
            mn[1] = std::min(mn[1], y); mx[1] = std::max(mx[1], y);
        }
        for (uint32_t t : {0u, 1u, 2u, 0u, 2u, 3u}) idx.push_back(base + t);
    }
    std::vector<uint8_t> section() const {
        Bin o;
        o.put((uint32_t)v.size()); o.put((uint32_t)idx.size()); o.put((uint32_t)4); o.put((uint32_t)0);
        o.put(sxz); o.put(sy); o.put(ox); o.put(oy); o.put(oz);
        for (int k = 0; k < 3; ++k) o.put(0.f);
        for (int k = 0; k < 3; ++k) o.put(mn[k]);
        for (int k = 0; k < 3; ++k) o.put(mx[k]);
        o.raw(v.data(), v.size() * sizeof(CityVertex));
        for (uint32_t i : idx) o.put(i);
        return o.b;
    }
};
bool writeBin(const std::string& path, const char* magic, uint32_t reserved, const std::vector<std::pair<std::string, std::vector<uint8_t>>>& secs) {
    Bin f;
    f.tag(magic); f.put((uint32_t)1); f.put((uint32_t)secs.size()); f.put(reserved);
    uint32_t off = 16 + (uint32_t)secs.size() * 12;
    for (auto& s : secs) { f.tag(s.first.c_str()); f.put(off); f.put((uint32_t)s.second.size()); off += ((uint32_t)s.second.size() + 3) & ~3u; }
    for (auto& s : secs) { f.raw(s.second.data(), s.second.size()); f.align(); }
    FILE* fp = std::fopen(path.c_str(), "wb");
    if (!fp) return false;
    bool ok = std::fwrite(f.b.data(), 1, f.b.size(), fp) == f.b.size();
    std::fclose(fp);
    return ok;
}
} // namespace

bool writeSyntheticCity(const std::string& dir, int ni, int nj) {
    std::error_code ec;
    std::filesystem::create_directories(dir + "/tiles", ec);
    const float T = 128.f, X0 = -0.5f * ni * T, Z0 = -0.5f * nj * T;
    // materials: 0 asphalt, 1 sidewalk, 2 concrete, 3 glass, 4 lit window, 5 car paint, 6 tyre, 7 lamp lens, 8 tree
    std::string present, spawns;
    for (int j = 0; j < nj; ++j)
        for (int i = 0; i < ni; ++i) {
            float tx = X0 + i * T, tz = Z0 + j * T;
            MeshBuilder m{1.f / 64.f, 1.f / 32.f, tx, 0.f, tz};
            std::vector<int16_t> top(256 * 256, 0);
            std::vector<uint8_t> fl(256 * 256, CELL_ROAD);
            auto stamp = [&](float x0, float z0, float x1, float z1, float h, uint8_t f) {
                for (int z = std::max(0, (int)((z0 - tz) * 2)); z < std::min(256, (int)std::ceil((z1 - tz) * 2)); ++z)
                    for (int x = std::max(0, (int)((x0 - tx) * 2)); x < std::min(256, (int)std::ceil((x1 - tx) * 2)); ++x) {
                        top[z * 256 + x] = std::max<int16_t>(top[z * 256 + x], (int16_t)(h * 100));
                        fl[z * 256 + x] = f;
                    }
            };
            m.quadUp(tx, tz, tx + T, tz + T, 0.f, 0);   // road
            // two 48 m blocks per axis (streets 16 m wide at the tile edges and centre)
            for (int bz = 0; bz < 2; ++bz)
                for (int bx = 0; bx < 2; ++bx) {
                    float x0 = tx + 8 + bx * 64, z0 = tz + 8 + bz * 64, x1 = x0 + 48, z1 = z0 + 48;
                    m.box(x0, 0, z0, x1, 0.15f, z1, 1);   // sidewalk
                    stamp(x0, z0, x1, z1, 0.15f, CELL_WALK);
                    uint32_t hsh = (uint32_t)(i * 73856093 ^ j * 19349663 ^ (bx + 2 * bz) * 83492791);
                    float h = 9.f + (hsh % 60);
                    m.box(x0 + 4, 0.15f, z0 + 4, x1 - 4, h, z1 - 4, (hsh >> 8) % 3 == 0 ? 3 : 2);
                    for (float y = 3.f; y < h - 2; y += 3.2f)   // a band of lit windows on the +z face
                        if (((hsh >> 4) + (int)y) % 3 == 0) m.box(x0 + 8, y, z1 - 4, x1 - 8, y + 1.4f, z1 - 3.9f, 4);
                    stamp(x0 + 4, z0 + 4, x1 - 4, z1 - 4, h, CELL_BUILDING | CELL_BLOCKED);
                }
            Bin vehi;
            vehi.put((uint32_t)3);
            for (int k = 0; k < 3; ++k) {
                float x = tx + 20 + 30 * k, z = tz + 3.5f;
                vehi.put((uint16_t)0); vehi.put((uint16_t)0);
                uint8_t paint[4] = {(uint8_t)(60 + 80 * k), 30, (uint8_t)(200 - 60 * k), 5};
                vehi.raw(paint, 4);
                vehi.put(x); vehi.put(0.f); vehi.put(z);
                float yaw = k * 0.3f;
                int16_t q[4] = {0, (int16_t)(std::sin(yaw * 0.5f) * 32767), 0, (int16_t)(std::cos(yaw * 0.5f) * 32767)};
                for (int16_t c : q) vehi.put(c);
                stamp(x - 2.2f, z - 1.f, x + 2.2f, z + 1.f, 1.5f, CELL_VEHICLE | CELL_BLOCKED);
            }
            Bin prop;
            prop.put((uint32_t)4);
            for (int k = 0; k < 4; ++k) {
                float x = tx + 8.5f + 32 * k, z = tz + 7.5f;
                prop.put((uint16_t)0); prop.put((uint16_t)0); prop.put(x); prop.put(0.15f); prop.put(z); prop.put(0.f); prop.put(0.f);
                stamp(x - 0.25f, z - 0.25f, x + 0.25f, z + 0.25f, 6.f, CELL_BLOCKED);
            }
            Bin hgt;
            hgt.put((uint32_t)256); hgt.put((uint32_t)256); hgt.put(0.5f); hgt.put(tx); hgt.put(tz);
            for (int16_t v : top) hgt.put(v);
            hgt.raw(fl.data(), fl.size());
            char path[512];
            std::snprintf(path, sizeof(path), "%s/tiles/%d_%d.bin", dir.c_str(), i, j);
            if (!writeBin(path, "TTZT", (uint32_t)(i | j << 16), {{"MSH0", m.section()}, {"VEHI", vehi.b}, {"PROP", prop.b}, {"HGT0", hgt.b}}))
                return false;
            char e[96];
            std::snprintf(e, sizeof(e), "%s[%d,%d,0]", present.empty() ? "" : ",", i, j);
            present += e;
            std::snprintf(e, sizeof(e), "%s[%.1f,%.1f],[%.1f,%.1f]", spawns.empty() ? "" : ",", tx + 64.f, tz + 30.f, tx + 30.f, tz + 64.f);
            spawns += e;
        }
    MeshBuilder car{1.f / 512.f, 1.f / 512.f, 0, 0, 0}, carBox{1.f / 512.f, 1.f / 512.f, 0, 0, 0}, lamp{1.f / 512.f, 1.f / 512.f, 0, 0, 0};
    car.box(-2.2f, 0.3f, -0.9f, 2.2f, 1.0f, 0.9f, 5, 1);
    car.box(-1.2f, 1.0f, -0.8f, 1.0f, 1.5f, 0.8f, 3);
    for (float x : {-1.4f, 1.4f}) for (float z : {-0.95f, 0.75f}) car.box(x - 0.35f, 0, z, x + 0.35f, 0.6f, z + 0.2f, 6);
    carBox.box(-2.2f, 0, -0.9f, 2.2f, 1.5f, 0.9f, 5, 1);
    lamp.box(-0.08f, 0, -0.08f, 0.08f, 6.f, 0.08f, 2);
    lamp.box(-0.3f, 5.8f, -0.3f, 0.3f, 6.1f, 0.3f, 7);
    if (!writeBin(dir + "/vehicles.bin", "TTZV", 0, {{"V000", car.section()}, {"W000", carBox.section()}})) return false;
    if (!writeBin(dir + "/props.bin", "TTZP", 0, {{"P000", lamp.section()}})) return false;
    FILE* f = std::fopen((dir + "/city.json").c_str(), "w");
    if (!f) return false;
    std::fprintf(f,
                 "{\"format\":\"ttz-city\",\"version\":1,\"compression\":\"none\",\"seed\":0,\n"
                 "\"bounds\":{\"x0\":%g,\"z0\":%g,\"x1\":%g,\"z1\":%g},\n"
                 "\"tile\":{\"size\":128,\"ni\":%d,\"nj\":%d,\"files\":\"tiles/{i}_{j}.bin\",\"present\":[%s]},\n"
                 "\"palette\":[{\"id\":0,\"name\":\"ASPHALT\",\"linear\":[0.02,0.02,0.025],\"flags\":[]},\n"
                 "{\"id\":1,\"name\":\"SIDEWALK\",\"linear\":[0.09,0.09,0.09],\"flags\":[]},\n"
                 "{\"id\":2,\"name\":\"CONCRETE\",\"linear\":[0.2,0.19,0.18],\"flags\":[]},\n"
                 "{\"id\":3,\"name\":\"GLASS\",\"linear\":[0.02,0.03,0.05],\"gloss\":1.0,\"flags\":[\"glass\"]},\n"
                 "{\"id\":4,\"name\":\"GLASS_LIT\",\"linear\":[0.9,0.6,0.3],\"flags\":[\"glass\",\"emissive\"],\"emissive\":{\"mode\":\"windows\",\"day\":0.1,\"night\":2.0,\"dayMaterial\":3}},\n"
                 "{\"id\":5,\"name\":\"PAINT\",\"linear\":[0.5,0.5,0.5],\"flags\":[\"paint\"]},\n"
                 "{\"id\":6,\"name\":\"TYRE\",\"linear\":[0.01,0.01,0.01],\"flags\":[]},\n"
                 "{\"id\":7,\"name\":\"LAMP_LENS\",\"linear\":[1.0,0.7,0.4],\"flags\":[\"emissive\"],\"emissive\":{\"mode\":\"steady\",\"day\":0.1,\"night\":3.0}}],\n"
                 "\"vehicles\":{\"paintPlaceholder\":5,\"variants\":[{\"key\":\"synthetic_sedan\",\"kind\":\"sedan\",\"lod1\":true}]},\n"
                 "\"props\":{\"types\":[{\"name\":\"lamp\"}]},\n"
                 "\"roads\":[],\"spawns\":[%s]}\n",
                 X0, Z0, X0 + ni * T, Z0 + nj * T, ni, nj, present.c_str(), spawns.c_str());
    std::fclose(f);
    return true;
}

} // namespace ttz
