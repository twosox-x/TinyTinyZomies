// Readers for the baked city package, file format v1 and v2 (zstd sections, chunk tables; tools/city_lab/bake/FORMAT.md).
#include "city/CityAsset.h"
#include "city/Json.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <map>
#include <zstd.h>

namespace ttz {

namespace {
struct Reader {
    const uint8_t* p;
    size_t n;
    template <class T> bool get(size_t off, T& v) const {
        if (off + sizeof(T) > n) return false;
        std::memcpy(&v, p + off, sizeof(T));
        return true;
    }
};

// Section table (v1: 12-byte entries; v2: 20-byte entries with raw size and encoding). Encoded sections are
// decompressed (zstd, then the SHUF12 vertex byte-plane filter undone) into `store`; out maps tag -> (data, bytes).
struct Sections {
    std::map<std::string, std::pair<const uint8_t*, size_t>> map;
    std::deque<std::vector<uint8_t>> store;
    uint64_t raw = 0;
    auto find(const char* t) const { return map.find(t); }
    auto end() const { return map.end(); }
};
constexpr uint32_t kEncZstd = 1, kEncShuf12 = 256;

bool sections(const std::vector<uint8_t>& b, const char* magic, Sections& out) {
    if (b.size() < 16 || std::memcmp(b.data(), magic, 4) != 0) return false;
    Reader r{b.data(), b.size()};
    uint32_t ver = 0, count = 0;
    r.get(4, ver);
    r.get(8, count);
    const size_t es = ver == 2 ? 20 : 12;
    if ((ver != 1 && ver != 2) || 16 + (size_t)count * es > b.size()) return false;
    for (uint32_t k = 0; k < count; ++k) {
        uint32_t off = 0, len = 0, raw = 0, enc = 0;
        const size_t e = 16 + k * es;
        r.get(e + 4, off);
        r.get(e + 8, len);
        if (ver == 2) { r.get(e + 12, raw); r.get(e + 16, enc); } else raw = len;
        if ((size_t)off + len > b.size()) return false;
        const std::string tag((const char*)b.data() + e, 4);
        out.raw += raw;
        if (!enc) { out.map[tag] = {b.data() + off, len}; continue; }
        if ((enc & 255) != kEncZstd) { SDL_Log("city: section %s: unknown encoding %u", tag.c_str(), enc); return false; }
        std::vector<uint8_t>& d = out.store.emplace_back(raw);
        size_t got = ZSTD_decompress(d.data(), raw, b.data() + off, len);
        if (ZSTD_isError(got) || got != raw) { SDL_Log("city: section %s: zstd: %s", tag.c_str(), ZSTD_isError(got) ? ZSTD_getErrorName(got) : "size"); return false; }
        if ((enc & kEncShuf12) && raw >= 72) {   // vertex region [72, 72 + 12 V) stored as 12 byte planes
            uint32_t V = 0;
            std::memcpy(&V, d.data(), 4);
            if (72 + (size_t)V * 12 <= raw) {
                std::vector<uint8_t> tmp(d.begin() + 72, d.begin() + 72 + (size_t)V * 12);
                uint8_t* dst = d.data() + 72;
                for (int c = 0; c < 12; ++c) {
                    const uint8_t* plane = tmp.data() + (size_t)c * V;
                    for (uint32_t v = 0; v < V; ++v) dst[(size_t)v * 12 + c] = plane[v];
                }
            }
        }
        out.map[tag] = {d.data(), d.size()};
    }
    return true;
}

// Implicit quad lists keep no index data (tiles: the renderer's shared quad index buffer) unless makeIdx (instanced models).
bool parseMesh(const uint8_t* p, size_t n, CityMesh& m, bool makeIdx = false) {
    Reader r{p, n};
    uint32_t V = 0, I = 0, isz = 0;
    if (!r.get(0, V) || !r.get(4, I) || !r.get(8, isz)) return false;
    float sxz = 0, sy = 0;
    r.get(16, sxz);
    r.get(20, sy);
    m.scaleXZ = sxz;
    m.scaleY = sy;
    for (int k = 0; k < 3; ++k) {
        r.get(24 + 4 * k, m.origin[k]);
        r.get(48 + 4 * k, m.bmin[k]);
        r.get(60 + 4 * k, m.bmax[k]);
    }
    size_t vo = 72, io = vo + (size_t)V * 12;
    uint32_t flags = 0, lod1Quads = 0;
    r.get(12, flags);
    r.get(36, lod1Quads);
    if ((flags & 1) && I == 0 && isz == 0) {               // FORMAT.md: implicit quad list (LOD1 = leading lod1Quads quads)
        if (vo + (size_t)V * 12 > n || (V & 3)) return false;
        const uint32_t Q = V / 4;
        m.quads = Q;
        m.lod1Quads = std::min(lod1Quads ? lod1Quads : Q, Q);
        m.verts.resize((size_t)Q * 4);
        std::memcpy(m.verts.data(), p + vo, (size_t)Q * 48);
        if (makeIdx) {
            m.idx.resize((size_t)Q * 6);
            for (uint32_t q = 0; q < Q; ++q) {
                uint32_t b0 = q * 4, *o = &m.idx[(size_t)q * 6];
                o[0] = b0; o[1] = b0 + 1; o[2] = b0 + 2; o[3] = b0; o[4] = b0 + 2; o[5] = b0 + 3;
            }
        }
        return true;
    }
    if ((isz != 2 && isz != 4) || io + (size_t)I * isz > n) return false;
    m.verts.resize(V);
    std::memcpy(m.verts.data(), p + vo, (size_t)V * 12);
    m.idx.resize(I);
    if (isz == 4) std::memcpy(m.idx.data(), p + io, (size_t)I * 4);
    else
        for (uint32_t k = 0; k < I; ++k) {
            uint16_t v;
            std::memcpy(&v, p + io + k * 2, 2);
            m.idx[k] = v;
        }
    for (uint32_t k = 0; k < I; ++k)
        if (m.idx[k] >= V) return false;
    return true;
}

float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }

bool loadVariants(const std::string& path, const char* magic, char lod0, char lod1, std::vector<ModelVariant>& out) {
    std::vector<uint8_t> b;
    Sections sec;
    if (!readFileBytes(path, b) || !sections(b, magic, sec)) return false;
    for (size_t k = 0; k < out.size(); ++k) {
        char t0[8], t1[8];
        std::snprintf(t0, sizeof(t0), "%c%03d", lod0, (int)k);
        std::snprintf(t1, sizeof(t1), "%c%03d", lod1, (int)k);
        auto a = sec.find(t0);
        if (a != sec.end()) parseMesh(a->second.first, a->second.second, out[k].lod0, true);
        auto c = sec.find(t1);
        if (c != sec.end()) parseMesh(c->second.first, c->second.second, out[k].lod1, true);
    }
    return true;
}
} // namespace

bool CityAsset::load(const std::string& dir) {
    std::vector<uint8_t> text;
    if (!readFileBytes(dir + "/city.json", text)) {
        SDL_Log("city: cannot read %s/city.json", dir.c_str());
        return false;
    }
    json::Value j;
    if (!json::parse(std::string(text.begin(), text.end()), j) || j["format"].str != "ttz-city" || j["version"].i() != 1) {
        SDL_Log("city: %s/city.json is not a ttz-city v1 package", dir.c_str());
        return false;
    }
    const json::Value& b = j["bounds"];
    x0 = b["x0"].f(); z0 = b["z0"].f(); x1 = b["x1"].f(); z1 = b["z1"].f();
    tileSize = j["tile"]["size"].f(128.f);
    ni = j["tile"]["ni"].i();
    nj = j["tile"]["nj"].i();
    if (ni <= 0 || nj <= 0) return false;
    tilePresent.assign((size_t)ni * nj, 0);
    for (const json::Value& e : j["tile"]["present"].arr) {
        int i = e[0].i(-1), k = e[1].i(-1);
        if (i >= 0 && k >= 0 && i < ni && k < nj) tilePresent[(size_t)k * ni + i] = 1;
    }
    materials.clear();
    for (const json::Value& m : j["palette"].arr) {
        size_t id = (size_t)m["id"].i((int)materials.size());
        if (id >= 256) continue;
        if (materials.size() <= id) materials.resize(id + 1);
        CityMaterial& c = materials[id];
        c.name = m["name"].str;
        c.r = m["linear"][0].f(0.5f); c.g = m["linear"][1].f(0.5f); c.b = m["linear"][2].f(0.5f);
        c.roughness = m["roughness"].f(0.8f);
        c.gloss = m["gloss"].f(0.f);
        for (const json::Value& f : m["flags"].arr) {
            if (f.str == "glass") c.flags |= MAT_GLASS;
            else if (f.str == "emissive") c.flags |= MAT_EMISSIVE;
            else if (f.str == "water") c.flags |= MAT_WATER;
            else if (f.str == "foliage") c.flags |= MAT_FOLIAGE;
            else if (f.str == "paint") c.flags |= MAT_PAINT;
            else if (f.str == "signal") c.flags |= MAT_SIGNAL;
        }
        const json::Value& e = m["emissive"];
        if (e.type == json::Value::Object) {
            const std::string& mode = e["mode"].str;
            c.emissiveMode = mode == "steady" || mode == "night" ? EM_STEADY : mode == "windows" ? EM_WINDOWS : mode == "blink" ? EM_BLINK
                           : mode == "flash" ? EM_FLASH : mode == "signal" ? EM_SIGNAL : EM_STEADY;
            c.emissiveNight = e["night"].f(1.f);
            c.emissiveDay = e["day"].f(0.f);
            c.dayMaterial = (int)e["dayMaterial"].f(-1.f);
            c.flags |= MAT_EMISSIVE;
        }
    }
    variants.assign(j["vehicles"]["variants"].size(), {});
    for (size_t k = 0; k < variants.size(); ++k) variants[k].name = j["vehicles"]["variants"][k]["key"].str;
    props.assign(j["props"]["types"].size(), {});
    lampProp = -1;
    for (size_t k = 0; k < props.size(); ++k) {
        props[k].name = j["props"]["types"][k]["name"].str;
        if (lampProp < 0 && props[k].name.find("lamp") != std::string::npos) lampProp = (int)k;
    }
    spawns.clear();
    for (const json::Value& s : j["spawns"].arr) spawns.push_back({s[0].f(), s[1].f(), 3.f});
    roads.clear();
    for (const json::Value& r : j["roads"].arr) {
        std::vector<float> pl;
        for (const json::Value& p : r["pts"].arr) { pl.push_back(p[0].f()); pl.push_back(p[1].f()); }
        roads.push_back(std::move(pl));
    }
    foliage.assign(j["foliage"]["types"].size(), {});
    foliageSway.assign(foliage.size(), 0.f);
    for (size_t k = 0; k < foliage.size(); ++k) {
        foliage[k].name = j["foliage"]["types"][k]["name"].str;
        foliageSway[k] = j["foliage"]["types"][k]["sway"].f(0.f);
    }
    dir_ = dir;
    if (!foliage.empty() && !loadVariants(dir + "/foliage.bin", "TTZF", 'F', 'G', foliage)) { SDL_Log("city: foliage.bin missing or invalid"); foliage.clear(); }
    if (!variants.empty() && !loadVariants(dir + "/vehicles.bin", "TTZV", 'V', 'W', variants)) SDL_Log("city: vehicles.bin missing or invalid");
    if (!props.empty() && !loadVariants(dir + "/props.bin", "TTZP", 'P', 'Q', props)) SDL_Log("city: props.bin missing or invalid");
    size_t present = 0;
    for (uint8_t p : tilePresent) present += p;
    SDL_Log("city: %s: %d x %d tiles (%zu present), %zu materials, %zu vehicle variants, %zu prop types, %zu spawns",
            dir.c_str(), ni, nj, present, materials.size(), variants.size(), props.size(), spawns.size());
    return true;
}

bool decodeTileBytes(const std::vector<uint8_t>& b, TileCPU& out) {
    Sections sec;
    if (!sections(b, "TTZT", sec)) return false;
    out.rawBytes = sec.raw;
    // MESH = LOD0 (v1: LOD1 = its leading lod1Quads quads; v2 with CHNK: chunk ordered); LOD2 = far block model
    // (optional); legacy MSH0 / MSH1
    const char* meshTags[4] = {"MESH", "MSH0", "MSH1", "LOD2"};
    const int meshLod[4] = {0, 0, 1, 2};
    for (int k = 0; k < 4; ++k) {
        auto it = sec.find(meshTags[k]);
        if (it != sec.end() && !parseMesh(it->second.first, it->second.second, out.lod[meshLod[k]])) return false;
    }
    auto it = sec.find("CHNK");
    if (it != sec.end() && !out.lod[0].verts.empty()) {
        Reader r{it->second.first, it->second.second};
        uint32_t n = 0, w = 0, n1 = 0;
        r.get(0, n);
        if (24 + (size_t)n * 40 > r.n) return false;
        out.chunks.resize(n);
        for (uint32_t c = 0; c < n; ++c) {
            CityChunk& k = out.chunks[c];
            const size_t o = 24 + (size_t)c * 40;
            r.get(o, k.first); r.get(o + 4, k.n1); r.get(o + 8, k.n0);
            for (int a = 0; a < 3; ++a) { r.get(o + 16 + 4 * a, k.bmin[a]); r.get(o + 28 + 4 * a, k.bmax[a]); }
            if (k.first != w || k.n1 > k.n0) return false;
            w += k.n0;
            n1 += k.n1;
        }
        if (w != out.lod[0].quads) return false;
        out.lod[0].lod1Quads = n1;   // total only: LOD1 is per chunk
    }
    it = sec.find("VEHI");
    if (it != sec.end()) {
        const uint8_t* p = it->second.first;
        Reader r{p, it->second.second};
        uint32_t count = 0;
        r.get(0, count);
        if ((size_t)count * 28 + 4 > r.n) return false;
        for (uint32_t k = 0; k < count; ++k) {
            size_t o = 4 + (size_t)k * 28;
            CityInstance v{};
            uint8_t paint[4];
            int16_t q[4];
            r.get(o, v.variant);
            std::memcpy(paint, p + o + 4, 4);
            r.get(o + 8, v.x); r.get(o + 12, v.y); r.get(o + 16, v.z);
            std::memcpy(q, p + o + 20, 8);
            float len = 0;
            for (int c = 0; c < 4; ++c) { v.q[c] = q[c] / 32767.f; len += v.q[c] * v.q[c]; }
            len = len > 0 ? 1.f / std::sqrt(len) : 0.f;
            for (float& c : v.q) c *= len;
            for (int c = 0; c < 3; ++c) v.paint[c] = srgbToLinear(paint[c] / 255.f);
            v.paint[3] = paint[3] ? 1.f : 0.f;
            v.kind = 0;
            out.instances.push_back(v);
        }
    }
    it = sec.find("PROP");
    if (it != sec.end()) {
        Reader r{it->second.first, it->second.second};
        uint32_t count = 0;
        r.get(0, count);
        if ((size_t)count * 24 + 4 > r.n) return false;
        for (uint32_t k = 0; k < count; ++k) {
            size_t o = 4 + (size_t)k * 24;
            CityInstance v{};
            float yaw = 0, phase = 0;
            r.get(o, v.variant);
            r.get(o + 4, v.x); r.get(o + 8, v.y); r.get(o + 12, v.z);
            r.get(o + 16, yaw);
            r.get(o + 20, phase);
            v.q[0] = 0; v.q[1] = std::sin(yaw * 0.5f); v.q[2] = 0; v.q[3] = std::cos(yaw * 0.5f);   // rotation about +y
            v.paint[3] = phase;
            v.kind = 1;
            out.instances.push_back(v);
        }
    }
    it = sec.find("HGT0");
    if (it != sec.end()) {
        const uint8_t* p = it->second.first;
        Reader r{p, it->second.second};
        uint32_t nx = 0, nz = 0;
        r.get(0, nx); r.get(4, nz);
        r.get(8, out.gcell); r.get(12, out.gx0); r.get(16, out.gz0);
        size_t cells = (size_t)nx * nz;
        if (20 + cells * 3 > r.n) return false;
        out.gw = (int)nx;
        out.gh = (int)nz;
        out.heightCm.resize(cells);
        std::memcpy(out.heightCm.data(), p + 20, cells * 2);
        out.flags.assign(p + 20 + cells * 2, p + 20 + cells * 3);
    }
    // WATR: (n x n) grid of shore distances (cm) -> 2 m surface quads where the water can show (shore distance > -1.6 m)
    it = sec.find("WATR");
    if (it != sec.end()) {
        Reader r{it->second.first, it->second.second};
        uint32_t nx = 0, nz = 0;
        float cell = 1.f, gx0 = 0, gz0 = 0;
        r.get(0, nx); r.get(4, nz); r.get(8, cell); r.get(12, gx0); r.get(16, gz0); r.get(20, out.waterLevel);
        if (32 + (size_t)nx * nz * 2 > r.n || nx < 2 || nz < 2) return false;
        const int16_t* sd = (const int16_t*)(it->second.first + 32);
        const uint32_t st = 2;
        for (uint32_t z = 0; z + st < nz; z += st)
            for (uint32_t x = 0; x + st < nx; x += st) {
                const int16_t c[4] = {sd[z * nx + x], sd[(z + st) * nx + x], sd[(z + st) * nx + x + st], sd[z * nx + x + st]};
                if (std::max(std::max(c[0], c[1]), std::max(c[2], c[3])) < -160) continue;
                const uint32_t px[4] = {x, x, x + st, x + st}, pz[4] = {z, z + st, z + st, z};   // CCW seen from +y
                for (int k = 0; k < 4; ++k) {
                    out.water.push_back(gx0 + px[k] * cell);
                    out.water.push_back(gz0 + pz[k] * cell);
                    out.water.push_back(c[k] * 0.01f);
                }
            }
    }
    it = sec.find("BLDG");
    if (it != sec.end()) out.bldg.assign(it->second.first, it->second.first + it->second.second);
    it = sec.find("FOLI");
    if (it != sec.end()) {
        Reader r{it->second.first, it->second.second};
        uint32_t count = 0;
        r.get(0, count); r.get(4, out.foliChunks); r.get(8, out.foliTypes);
        const size_t ns = (size_t)out.foliChunks * out.foliTypes + 1, o = 16 + ns * 4;
        if (o + (size_t)count * 8 > r.n || out.foliChunks > 64 || out.foliTypes > 64) return false;
        out.foliStart.resize(ns);
        std::memcpy(out.foliStart.data(), it->second.first + 16, ns * 4);
        out.foliage.resize((size_t)count * 2);
        std::memcpy(out.foliage.data(), it->second.first + o, (size_t)count * 8);
        if (out.foliStart.back() != count) return false;
    }
    return true;
}

} // namespace ttz
