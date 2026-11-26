// Readers for the baked city package, format v1 (tools/city_lab/bake/FORMAT.md).
#include "city/CityAsset.h"
#include "city/Json.h"

#include <SDL3/SDL.h>
#include <cmath>
#include <cstring>
#include <map>

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

// Section table: tag -> (offset, bytes).
bool sections(const std::vector<uint8_t>& b, const char* magic, std::map<std::string, std::pair<uint32_t, uint32_t>>& out) {
    if (b.size() < 16 || std::memcmp(b.data(), magic, 4) != 0) return false;
    Reader r{b.data(), b.size()};
    uint32_t ver = 0, count = 0;
    r.get(4, ver);
    r.get(8, count);
    if (ver != 1 || 16 + (size_t)count * 12 > b.size()) return false;
    for (uint32_t k = 0; k < count; ++k) {
        uint32_t off = 0, len = 0;
        r.get(16 + k * 12 + 4, off);
        r.get(16 + k * 12 + 8, len);
        if ((size_t)off + len > b.size()) return false;
        out[std::string((const char*)b.data() + 16 + k * 12, 4)] = {off, len};
    }
    return true;
}

bool parseMesh(const uint8_t* p, size_t n, CityMesh& m) {
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
    std::map<std::string, std::pair<uint32_t, uint32_t>> sec;
    if (!readFileBytes(path, b) || !sections(b, magic, sec)) return false;
    for (size_t k = 0; k < out.size(); ++k) {
        char t0[8], t1[8];
        std::snprintf(t0, sizeof(t0), "%c%03d", lod0, (int)k);
        std::snprintf(t1, sizeof(t1), "%c%03d", lod1, (int)k);
        auto a = sec.find(t0);
        if (a != sec.end()) parseMesh(b.data() + a->second.first, a->second.second, out[k].lod0);
        auto c = sec.find(t1);
        if (c != sec.end()) parseMesh(b.data() + c->second.first, c->second.second, out[k].lod1);
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
    dir_ = dir;
    if (!variants.empty() && !loadVariants(dir + "/vehicles.bin", "TTZV", 'V', 'W', variants)) SDL_Log("city: vehicles.bin missing or invalid");
    if (!props.empty() && !loadVariants(dir + "/props.bin", "TTZP", 'P', 'Q', props)) SDL_Log("city: props.bin missing or invalid");
    size_t present = 0;
    for (uint8_t p : tilePresent) present += p;
    SDL_Log("city: %s: %d x %d tiles (%zu present), %zu materials, %zu vehicle variants, %zu prop types, %zu spawns",
            dir.c_str(), ni, nj, present, materials.size(), variants.size(), props.size(), spawns.size());
    return true;
}

bool decodeTileBytes(const std::vector<uint8_t>& b, TileCPU& out) {
    std::map<std::string, std::pair<uint32_t, uint32_t>> sec;
    if (!sections(b, "TTZT", sec)) return false;
    const char* meshTags[2] = {"MSH0", "MSH1"};
    for (int l = 0; l < 2; ++l) {
        auto it = sec.find(meshTags[l]);
        if (it != sec.end() && !parseMesh(b.data() + it->second.first, it->second.second, out.lod[l])) return false;
    }
    Reader r{b.data(), b.size()};
    auto it = sec.find("VEHI");
    if (it != sec.end()) {
        uint32_t off = it->second.first, count = 0;
        r.get(off, count);
        if ((size_t)count * 28 + 4 > it->second.second) return false;
        for (uint32_t k = 0; k < count; ++k) {
            size_t o = off + 4 + (size_t)k * 28;
            CityInstance v{};
            uint8_t paint[4];
            int16_t q[4];
            r.get(o, v.variant);
            std::memcpy(paint, b.data() + o + 4, 4);
            r.get(o + 8, v.x); r.get(o + 12, v.y); r.get(o + 16, v.z);
            std::memcpy(q, b.data() + o + 20, 8);
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
        uint32_t off = it->second.first, count = 0;
        r.get(off, count);
        if ((size_t)count * 24 + 4 > it->second.second) return false;
        for (uint32_t k = 0; k < count; ++k) {
            size_t o = off + 4 + (size_t)k * 24;
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
        uint32_t off = it->second.first, nx = 0, nz = 0;
        r.get(off, nx); r.get(off + 4, nz);
        r.get(off + 8, out.gcell); r.get(off + 12, out.gx0); r.get(off + 16, out.gz0);
        size_t cells = (size_t)nx * nz;
        if (20 + cells * 3 > it->second.second) return false;
        out.gw = (int)nx;
        out.gh = (int)nz;
        out.heightCm.resize(cells);
        std::memcpy(out.heightCm.data(), b.data() + off + 20, cells * 2);
        out.flags.assign(b.data() + off + 20 + cells * 2, b.data() + off + 20 + cells * 3);
    }
    return true;
}

} // namespace ttz
