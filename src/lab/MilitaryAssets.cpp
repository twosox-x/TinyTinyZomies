#include "lab/MilitaryAssets.h"

#include "city/Json.h"
#include "sim/Look.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

// ---------------------------------------------------------------------------------------------------------------
// mesher
CityMesh meshVoxelModel(const MilVoxelModel& m) {
    CityMesh out;
    out.scaleXZ = m.voxel;
    out.scaleY = m.voxel;
    out.origin[0] = -m.pivot[0] * m.voxel;
    out.origin[1] = -m.pivot[1] * m.voxel;
    out.origin[2] = -m.pivot[2] * m.voxel;
    static const int N[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
    for (int y = 0; y < m.ny; ++y)
        for (int z = 0; z < m.nz; ++z)
            for (int x = 0; x < m.nx; ++x) {
                uint8_t v = m.get(x, y, z);
                if (!v) continue;
                for (int f = 0; f < 6; ++f) {
                    const int* n = N[f];
                    if (m.get(x + n[0], y + n[1], z + n[2])) continue;
                    int d = n[0] ? 0 : n[1] ? 1 : 2, s = n[0] + n[1] + n[2];
                    int u = (d + 1) % 3, w = (d + 2) % 3;
                    int base[3] = {x, y, z};
                    if (s > 0) base[d] += 1;
                    int c[4][3];
                    for (int k = 0; k < 4; ++k) {
                        std::memcpy(c[k], base, sizeof(base));
                        if (k == 1 || k == 2) c[k][u] += 1;
                        if (k == 2 || k == 3) c[k][w] += 1;
                    }
                    // u x w points along +d: keep the order for +faces, reverse for -faces (CCW seen from outside)
                    int order[4] = {0, 1, 2, 3};
                    if (s < 0) { order[1] = 3; order[3] = 1; }
                    uint32_t first = (uint32_t)out.verts.size();
                    for (int k = 0; k < 4; ++k) {
                        CityVertex cv{};
                        cv.x = (int16_t)c[order[k]][0]; cv.y = (int16_t)c[order[k]][1]; cv.z = (int16_t)c[order[k]][2];
                        cv.flags = 0;
                        cv.nx = (int8_t)(n[0] * 127); cv.ny = (int8_t)(n[1] * 127); cv.nz = (int8_t)(n[2] * 127);
                        cv.mat = (uint8_t)(v - 1);
                        out.verts.push_back(cv);
                    }
                    for (uint32_t i : {0u, 1u, 2u, 0u, 2u, 3u}) out.idx.push_back(first + i);
                }
            }
    for (int k = 0; k < 3; ++k) {
        float e = (k == 0 ? m.nx : k == 1 ? m.ny : m.nz) * m.voxel;
        out.bmin[k] = out.origin[k];
        out.bmax[k] = out.origin[k] + e;
    }
    return out;
}

void eulerXYZToQuat(const float e[3], float q[4]) {
    float cx = std::cos(e[0] * 0.5f), sx = std::sin(e[0] * 0.5f), cy = std::cos(e[1] * 0.5f), sy = std::sin(e[1] * 0.5f);
    float cz = std::cos(e[2] * 0.5f), sz = std::sin(e[2] * 0.5f);
    q[0] = sx * cy * cz + cx * sy * sz; q[1] = cx * sy * cz - sx * cy * sz;
    q[2] = cx * cy * sz + sx * sy * cz; q[3] = cx * cy * cz - sx * sy * sz;
}

void MilKeyClip::sample(float t, MilPoseKey& out) const {
    if (keys.empty()) { out = MilPoseKey{}; return; }
    if (keys.size() == 1 || t <= keys.front().t) { out = keys.front(); return; }
    if (t >= keys.back().t) {
        if (!loop || length <= keys.back().t) { out = keys.back(); return; }
    }
    size_t i = 0;
    while (i + 1 < keys.size() && keys[i + 1].t <= t) ++i;
    const MilPoseKey& a = keys[i];
    const MilPoseKey& b = i + 1 < keys.size() ? keys[i + 1] : keys.front();   // looping: last -> first
    float tb = i + 1 < keys.size() ? b.t : length + b.t;
    float f = tb > a.t ? (t - a.t) / (tb - a.t) : 0.f;
    f = std::clamp(f, 0.f, 1.f);
    auto L = [f](float x, float y) { return x + (y - x) * f; };
    out = a;
    out.t = t;
    for (int s = 0; s < 10; ++s) for (int k = 0; k < 3; ++k) out.rot[s][k] = L(a.rot[s][k], b.rot[s][k]);
    out.bob = L(a.bob, b.bob); out.tilt = L(a.tilt, b.tilt); out.roll = L(a.roll, b.roll); out.prone = L(a.prone, b.prone);
    for (int k = 0; k < 3; ++k) { out.root[k] = L(a.root[k], b.root[k]); out.weaponMount[k] = L(a.weaponMount[k], b.weaponMount[k]); }
    out.hasMount = a.hasMount || b.hasMount;
}

// ---------------------------------------------------------------------------------------------------------------
// placeholder library
namespace {
enum PalId : uint8_t {
    P_OLIVE = 0, P_OLIVE_DARK, P_KHAKI, P_GUNMETAL, P_WOOD, P_WOOD_DARK, P_CONCRETE, P_CONCRETE_DARK, P_SANDBAG, P_CANOPY,
    P_CANOPY_DARK, P_RED, P_WHITE, P_STEEL, P_FLASH, P_TRACER, P_RULER_W, P_RULER_R, P_GRID, P_CORD, P_BLACK, P_COUNT
};

struct Builder {
    MilVoxelModel m;
    Builder(const char* name, int nx, int ny, int nz, float voxel) {
        m.name = name; m.nx = nx; m.ny = ny; m.nz = nz; m.voxel = voxel;
        m.vox.assign((size_t)nx * ny * nz, 0);
        m.pivot[0] = nx * 0.5f; m.pivot[1] = 0; m.pivot[2] = nz * 0.5f;
    }
    void box(int x0, int y0, int z0, int x1, int y1, int z1, uint8_t pal) {   // inclusive-exclusive
        for (int y = std::max(0, y0); y < std::min(m.ny, y1); ++y)
            for (int z = std::max(0, z0); z < std::min(m.nz, z1); ++z)
                for (int x = std::max(0, x0); x < std::min(m.nx, x1); ++x) m.at(x, y, z) = (uint8_t)(pal + 1);
    }
    void centred(float px, float py, float pz) { m.pivot[0] = px; m.pivot[1] = py; m.pivot[2] = pz; }
};

CityMaterial mat(float r, float g, float b, float rough = 0.85f, float gloss = 0.f, uint32_t flags = 0, uint32_t em = EM_NONE,
                 float emNight = 0.f, const char* name = "") {
    CityMaterial c;
    auto lin = [](float s) { return s <= 0.04045f ? s / 12.92f : std::pow((s + 0.055f) / 1.055f, 2.4f); };
    c.r = lin(r); c.g = lin(g); c.b = lin(b);
    c.roughness = rough; c.gloss = gloss; c.flags = flags; c.emissiveMode = em; c.emissiveNight = emNight; c.name = name;
    return c;
}
} // namespace

void MilitaryLibrary::basePalette() {
    palette.assign(P_COUNT, CityMaterial{});
    palette[P_OLIVE] = mat(0.36f, 0.38f, 0.24f, 0.9f, 0, 0, 0, 0, "olive");
    palette[P_OLIVE_DARK] = mat(0.24f, 0.26f, 0.17f, 0.9f, 0, 0, 0, 0, "olive_dark");
    palette[P_KHAKI] = mat(0.55f, 0.50f, 0.36f, 0.9f, 0, 0, 0, 0, "khaki");
    palette[P_GUNMETAL] = mat(0.13f, 0.13f, 0.14f, 0.5f, 0.25f, 0, 0, 0, "gunmetal");
    palette[P_WOOD] = mat(0.52f, 0.38f, 0.22f, 0.9f, 0, 0, 0, 0, "wood");
    palette[P_WOOD_DARK] = mat(0.33f, 0.24f, 0.14f, 0.9f, 0, 0, 0, 0, "wood_dark");
    palette[P_CONCRETE] = mat(0.60f, 0.59f, 0.55f, 0.95f, 0, 0, 0, 0, "concrete");
    palette[P_CONCRETE_DARK] = mat(0.43f, 0.42f, 0.40f, 0.95f, 0, 0, 0, 0, "concrete_dark");
    palette[P_SANDBAG] = mat(0.62f, 0.56f, 0.40f, 0.95f, 0, 0, 0, 0, "sandbag");
    palette[P_CANOPY] = mat(0.70f, 0.70f, 0.62f, 0.9f, 0, 0, 0, 0, "canopy");
    palette[P_CANOPY_DARK] = mat(0.40f, 0.44f, 0.30f, 0.9f, 0, 0, 0, 0, "canopy_olive");
    palette[P_RED] = mat(0.70f, 0.08f, 0.07f, 0.8f, 0, 0, 0, 0, "red_cross");
    palette[P_WHITE] = mat(0.85f, 0.85f, 0.82f, 0.8f, 0, 0, 0, 0, "white");
    palette[P_STEEL] = mat(0.42f, 0.44f, 0.46f, 0.45f, 0.35f, 0, 0, 0, "steel");
    palette[P_FLASH] = mat(1.0f, 0.85f, 0.45f, 0.5f, 0, MAT_EMISSIVE, EM_STEADY, 4.0f, "muzzle_flash");
    palette[P_TRACER] = mat(1.0f, 0.55f, 0.2f, 0.5f, 0, MAT_EMISSIVE, EM_STEADY, 5.0f, "tracer");
    palette[P_RULER_W] = mat(0.9f, 0.9f, 0.85f, 0.8f, 0, 0, 0, 0, "ruler_white");
    palette[P_RULER_R] = mat(0.85f, 0.25f, 0.1f, 0.8f, 0, 0, 0, 0, "ruler_red");
    palette[P_GRID] = mat(0.62f, 0.66f, 0.48f, 0.8f, 0, MAT_EMISSIVE, EM_STEADY, 0.12f, "grid_line");
    palette[P_CORD] = mat(0.75f, 0.73f, 0.66f, 0.9f, 0, 0, 0, 0, "cord");
    palette[P_BLACK] = mat(0.06f, 0.06f, 0.06f, 0.7f, 0, 0, 0, 0, "black");
}

void MilitaryLibrary::buildPlaceholders(float bodyVoxel) {
    placeholder = true;
    source = "built-in placeholders (assets/military/ not found)";
    models.clear(); infantry.clear(); props.clear();
    basePalette();

    auto add = [&](Builder& b) { models.push_back(b.m); return (int)models.size() - 1; };
    // ---- attachments: half body-voxel resolution, pivot = model centre (offsets are given to the model centre)
    const float av = bodyVoxel * 0.5f;
    auto centre = [](Builder& b) { b.centred(b.m.nx * 0.5f, b.m.ny * 0.5f, b.m.nz * 0.5f); };
    Builder helmet("helmet", 12, 5, 12, av);
    helmet.box(1, 1, 1, 11, 5, 11, P_OLIVE); helmet.box(0, 0, 0, 12, 1, 12, P_OLIVE_DARK); helmet.box(2, 4, 2, 10, 5, 10, P_OLIVE_DARK);
    centre(helmet);
    int mHelmet = add(helmet);
    Builder beret("beret", 11, 3, 11, av);
    beret.box(0, 0, 0, 11, 2, 11, P_OLIVE_DARK); beret.box(1, 2, 0, 9, 3, 9, P_OLIVE_DARK); beret.box(1, 0, 9, 4, 2, 11, P_RED);
    centre(beret);
    int mBeret = add(beret);
    Builder vest("vest", 11, 11, 8, av);
    vest.box(0, 0, 0, 11, 11, 8, P_OLIVE_DARK); vest.box(1, 1, 7, 4, 5, 8, P_KHAKI); vest.box(4, 1, 7, 7, 5, 8, P_KHAKI); vest.box(7, 1, 7, 10, 5, 8, P_KHAKI);
    centre(vest);
    int mVest = add(vest);
    Builder medVest("vest_medic", 11, 11, 8, av);
    medVest.box(0, 0, 0, 11, 11, 8, P_WHITE); medVest.box(4, 3, 7, 7, 9, 8, P_RED); medVest.box(2, 5, 7, 9, 7, 8, P_RED);
    medVest.box(4, 3, 0, 7, 9, 1, P_RED); medVest.box(2, 5, 0, 9, 7, 1, P_RED);
    centre(medVest);
    int mMedVest = add(medVest);
    Builder pack("backpack", 9, 10, 4, av);
    pack.box(0, 0, 0, 9, 10, 4, P_OLIVE); pack.box(1, 8, 0, 8, 10, 4, P_OLIVE_DARK); pack.box(0, 0, 0, 9, 2, 4, P_KHAKI);
    centre(pack);
    int mPack = add(pack);
    Builder radio("radio_pack", 9, 13, 5, av);
    radio.box(0, 0, 0, 9, 11, 5, P_OLIVE_DARK); radio.box(1, 2, 0, 8, 6, 1, P_GUNMETAL); radio.box(7, 11, 2, 8, 13, 3, P_BLACK);
    centre(radio);
    int mRadio = add(radio);
    Builder rifle("rifle", 3, 5, 22, av);   // along +Z (forward when the forearm hangs): stock z 0..5, barrel to 22
    rifle.box(0, 1, 0, 3, 4, 6, P_GUNMETAL); rifle.box(0, 2, 6, 3, 4, 15, P_GUNMETAL); rifle.box(1, 2, 15, 2, 3, 22, P_GUNMETAL);
    rifle.box(1, 0, 9, 2, 2, 11, P_BLACK); rifle.box(0, 4, 8, 3, 5, 12, P_BLACK);
    centre(rifle);
    int mRifle = add(rifle);
    Builder mg("machine_gun", 4, 6, 26, av);
    mg.box(0, 1, 0, 4, 5, 7, P_GUNMETAL); mg.box(0, 2, 7, 4, 5, 17, P_GUNMETAL); mg.box(1, 2, 17, 3, 4, 26, P_GUNMETAL);
    mg.box(0, 0, 9, 4, 2, 13, P_OLIVE_DARK);
    centre(mg);
    int mMG = add(mg);
    Builder pistol("pistol", 2, 4, 6, av);
    pistol.box(0, 1, 0, 2, 3, 6, P_BLACK); pistol.box(0, 0, 0, 2, 2, 2, P_BLACK);
    centre(pistol);
    int mPistol = add(pistol);
    Builder medkit("medkit", 6, 5, 3, av);
    medkit.box(0, 0, 0, 6, 5, 3, P_WHITE); medkit.box(2, 1, 0, 4, 4, 3, P_RED); medkit.box(1, 2, 0, 5, 3, 3, P_RED);
    centre(medkit);
    int mMedkit = add(medkit);
    buildLabHelpers();
    const int mFlash = flashModel;

    // ---- infantry (bodies: zombie body standard module combos, no decay)
    auto look = [](uint32_t head, uint32_t torso, uint32_t top, uint32_t pants, uint32_t skin, uint32_t hat, uint32_t& x, uint32_t& y) {
        LookSpec l;
        l.head = head; l.torso = torso; l.tier = 0; l.decayBucket = 0;
        l.skin = skin; l.top = top; l.shirt = 2; l.pants = pants; l.hair = 0; l.tie = 0; l.hat = hat; l.shoe = 0;
        encodeLook(l, x, y);
    };
    auto clipsFor = [](MilInfantry& inf) {
        inf.clips = {{"rest pose", -1, 8, 1.f, 0.f, true, true},
                     {"idle (zombie clip)", -1, 1, 4.f, 0.f, true, true},
                     {"walk (zombie clip)", -1, 2, 1.6f, 1.3f, true, true},
                     {"reach (zombie clip)", -1, 3, 2.f, 0.f, true, true},
                     {"climb (zombie clip)", -1, 4, 2.f, 0.f, true, true},
                     {"flail (zombie clip)", -1, 5, 2.f, 0.f, true, true},
                     {"dying (zombie clip)", -1, 6, 2.5f, 0.f, false, true}};
        for (const char* n : {"aim", "fire", "reload", "run", "crouch", "prone", "throw", "die"})
            inf.clips.push_back({n, -1, 8, 1.f, 0.f, true, false});
    };
    auto att = [](const char* name, int slot, int model, float x, float y, float z, bool fx = false) {
        MilAttachment a;
        a.name = name; a.slot = slot; a.model = model; a.offset[0] = x; a.offset[1] = y; a.offset[2] = z; a.fx = fx;
        return a;
    };
    // offsets from the slot pivots: head pivot is the neck (y 14), the torso pivot the hips (y 8); forearmR pivot the elbow
    auto soldier = [&](const char* cls, const char* var, int headMod, int torsoMod, uint32_t top, uint32_t pants, uint32_t skin,
                       int headGear, int vestModel, int backModel, int weapon, float weaponLen) {
        MilInfantry inf;
        inf.cls = cls; inf.variant = var;
        look((uint32_t)headMod, (uint32_t)torsoMod, top, pants, skin, 0, inf.lookX, inf.lookY);
        if (headGear >= 0) inf.atts.push_back(att(headGear == mBeret ? "beret" : "helmet", 0, headGear, 0.f, headGear == mBeret ? 3.9f : 3.4f, 0.f));
        if (vestModel >= 0) inf.atts.push_back(att("vest", 1, vestModel, 0.f, 3.2f, 0.2f));
        if (backModel >= 0) inf.atts.push_back(att(backModel == mRadio ? "radio" : "backpack", 1, backModel, 0.f, 3.6f, -2.6f));
        if (weapon >= 0) {
            // weapon in the right hand (forearmR, hand ~3.5 voxels below the elbow), pointing forward
            inf.atts.push_back(att("weapon", 5, weapon, 0.f, -3.6f, weaponLen * 0.5f * 0.5f - 1.5f));
            inf.atts.push_back(att("muzzle flash", 5, mFlash, 0.f, -3.4f, weaponLen * 0.5f - 1.5f + 1.5f, true));
            inf.muzzleAtt = (int)inf.atts.size() - 1;
            inf.muzzle[0] = 0.f; inf.muzzle[1] = -3.4f; inf.muzzle[2] = weaponLen * 0.5f - 1.5f + 1.5f;
        }
        clipsFor(inf);
        infantry.push_back(inf);
        return (int)infantry.size() - 1;
    };
    soldier("Rifleman", "A (helmet, rifle)", 1, 1, 6, 3, 2, mHelmet, mVest, mPack, mRifle, 22.f);
    soldier("Rifleman", "B (no pack)", 0, 1, 6, 3, 4, mHelmet, mVest, -1, mRifle, 22.f);
    soldier("Machine gunner", "A", 1, 2, 6, 3, 1, mHelmet, mVest, mPack, mMG, 26.f);
    soldier("Radio operator", "A", 1, 1, 6, 3, 0, mHelmet, mVest, mRadio, mRifle, 22.f);
    int med = soldier("Medic", "A", 1, 1, 6, 3, 3, mHelmet, mMedVest, -1, mPistol, 6.f);
    infantry[(size_t)med].atts.push_back(att("medkit", 3, mMedkit, 0.f, -3.f, 0.8f));
    soldier("Officer", "A (beret)", 1, 1, 6, 3, 2, mBeret, -1, -1, mPistol, 6.f);

    // ---- props (0.1 m voxels, pivot = footprint centre at ground level)
    auto prop = [&](Builder& b, const char* cat) {
        MilProp p;
        p.name = b.m.name; p.category = cat; p.model = add(b);
        p.footprint[0] = b.m.nx * b.m.voxel; p.footprint[1] = b.m.nz * b.m.voxel;
        props.push_back(p);
    };
    const float pv = 0.1f;
    { Builder b("supply_crate", 12, 8, 8, pv);
      b.box(0, 0, 0, 12, 8, 8, P_WOOD); b.box(0, 0, 0, 1, 8, 8, P_WOOD_DARK); b.box(11, 0, 0, 12, 8, 8, P_WOOD_DARK);
      b.box(0, 3, 0, 12, 5, 8, P_WOOD_DARK); b.box(4, 7, 3, 8, 8, 5, P_WHITE); prop(b, "Supply"); }
    { Builder b("ammo_container", 6, 5, 3, pv);
      b.box(0, 0, 0, 6, 4, 3, P_OLIVE); b.box(0, 3, 0, 6, 4, 3, P_OLIVE_DARK); b.box(2, 4, 1, 4, 5, 2, P_GUNMETAL); prop(b, "Supply"); }
    { Builder b("ammo_crate_stack", 14, 10, 7, pv);
      b.box(0, 0, 0, 14, 5, 7, P_OLIVE_DARK); b.box(1, 5, 1, 13, 10, 6, P_OLIVE); b.box(0, 4, 0, 14, 5, 7, P_KHAKI); prop(b, "Supply"); }
    { Builder b("t_wall", 30, 34, 6, pv);
      b.box(0, 0, 0, 30, 4, 6, P_CONCRETE_DARK); b.box(0, 0, 2, 30, 34, 4, P_CONCRETE); b.box(0, 33, 2, 30, 34, 4, P_CONCRETE_DARK);
      b.box(0, 0, 0, 30, 3, 0, P_CONCRETE); prop(b, "Fortification"); }
    { Builder b("wall_corner", 30, 34, 30, pv);
      b.box(0, 0, 0, 30, 34, 4, P_CONCRETE); b.box(0, 0, 0, 4, 34, 30, P_CONCRETE); b.box(0, 33, 0, 30, 34, 4, P_CONCRETE_DARK);
      b.box(0, 33, 0, 4, 34, 30, P_CONCRETE_DARK); prop(b, "Fortification"); }
    { Builder b("gate", 40, 30, 6, pv);
      b.box(0, 0, 0, 5, 30, 6, P_CONCRETE); b.box(35, 0, 0, 40, 30, 6, P_CONCRETE);
      b.box(5, 9, 2, 35, 11, 4, P_RED); b.box(5, 11, 2, 35, 13, 4, P_WHITE); b.box(5, 2, 2, 7, 9, 4, P_STEEL); prop(b, "Fortification"); }
    { Builder b("sandbag_barricade", 24, 9, 6, pv);
      for (int row = 0; row < 3; ++row)
          for (int k = 0; k < 4; ++k) {
              int x0 = k * 6 + (row % 2) * 3 - 1;
              b.box(std::max(0, x0 + 0), row * 3, 0, std::min(24, x0 + 6), row * 3 + 3, 6, P_SANDBAG);
              b.box(std::max(0, x0 + 5), row * 3, 0, std::min(24, x0 + 6), row * 3 + 3, 6, P_KHAKI);
          }
      prop(b, "Barricade"); }
    { Builder b("czech_hedgehog", 14, 10, 14, pv);
      for (int i = 0; i < 14; ++i) { b.box(i, i * 10 / 14, 6, i + 1, i * 10 / 14 + 1, 8, P_STEEL); b.box(6, i * 10 / 14, i, 8, i * 10 / 14 + 1, i + 1, P_STEEL);
                                     b.box(13 - i, i * 10 / 14, 6, 14 - i, i * 10 / 14 + 1, 8, P_GUNMETAL); }
      prop(b, "Barricade"); }
    { Builder b("window_armour_plate", 20, 26, 3, pv);
      b.box(0, 0, 0, 20, 26, 2, P_STEEL); b.box(7, 14, 0, 13, 16, 2, P_BLACK);
      for (int x : {1, 18}) for (int y : {1, 24}) b.box(x, y, 1, x + 1, y + 1, 3, P_GUNMETAL);
      prop(b, "Reinforcement"); }
    { Builder b("door_barricade_beams", 14, 22, 3, pv);
      for (int k = 0; k < 4; ++k) b.box(0, 2 + k * 5, 0, 14, 4 + k * 5, 3, k % 2 ? P_WOOD : P_WOOD_DARK);
      b.box(1, 0, 1, 3, 22, 2, P_WOOD_DARK); b.box(11, 0, 1, 13, 22, 2, P_WOOD_DARK); prop(b, "Reinforcement"); }
    { Builder b("garrison_tent", 40, 26, 30, pv);
      for (int y = 0; y < 26; ++y) { int half = 20 - y * 20 / 26; b.box(20 - half, y, 0, 20 + half, y + 1, 30, y % 6 == 5 ? P_OLIVE_DARK : P_OLIVE); }
      b.box(17, 0, 0, 23, 16, 1, P_BLACK); prop(b, "Garrison"); }
    { Builder b("field_cot", 20, 5, 8, pv);
      b.box(0, 3, 0, 20, 4, 8, P_OLIVE); b.box(0, 0, 0, 1, 3, 1, P_STEEL); b.box(19, 0, 0, 20, 3, 1, P_STEEL); b.box(0, 0, 7, 1, 3, 8, P_STEEL);
      b.box(19, 0, 7, 20, 3, 8, P_STEEL); b.box(15, 4, 1, 19, 5, 7, P_KHAKI); prop(b, "Garrison"); }
    { Builder b("field_radio_table", 12, 10, 7, pv);
      b.box(0, 7, 0, 12, 8, 7, P_WOOD); for (int x : {0, 11}) for (int z : {0, 6}) b.box(x, 0, z, x + 1, 7, z + 1, P_WOOD_DARK);
      b.box(2, 8, 2, 8, 10, 5, P_OLIVE_DARK); b.box(9, 8, 2, 10, 10, 3, P_BLACK); prop(b, "Garrison"); }
    { Builder b("hospital_tent", 44, 28, 34, pv);
      for (int y = 0; y < 28; ++y) { int half = 22 - y * 22 / 28; b.box(22 - half, y, 0, 22 + half, y + 1, 34, P_WHITE); }
      b.box(18, 12, 0, 26, 14, 1, P_RED); b.box(21, 9, 0, 23, 17, 1, P_RED); prop(b, "Hospital"); }
    { Builder b("stretcher", 20, 3, 6, pv);
      b.box(0, 2, 0, 20, 3, 6, P_KHAKI); b.box(0, 0, 0, 20, 2, 1, P_WOOD_DARK); b.box(0, 0, 5, 20, 2, 6, P_WOOD_DARK); prop(b, "Hospital"); }
    { Builder b("medical_crate", 8, 6, 6, pv);
      b.box(0, 0, 0, 8, 6, 6, P_WHITE); b.box(3, 1, 0, 5, 5, 6, P_RED); b.box(2, 2, 0, 6, 4, 6, P_RED); b.box(0, 0, 0, 8, 1, 6, P_CONCRETE_DARK);
      prop(b, "Hospital"); }
    premeshed.resize(models.size());
    SDL_Log("military lab: placeholder library: %zu infantry, %zu props, %zu voxel models", infantry.size(), props.size(), models.size());
}

void MilitaryLibrary::buildLabHelpers() {
    auto add = [&](Builder& b) { models.push_back(b.m); return (int)models.size() - 1; };
    { const float av = 1.7f / 36.f;   // muzzle flash, half body voxels, centred
      Builder b("muzzle_flash", 5, 5, 6, av);
      b.box(1, 1, 0, 4, 4, 6, P_FLASH); b.box(0, 2, 1, 5, 3, 4, P_FLASH); b.box(2, 0, 1, 3, 5, 4, P_FLASH);
      b.centred(2.5f, 2.5f, 0.f); flashModel = add(b); }
    // scale ruler: 2 m post with 0.25 m alternating bands, a 1 m foot bar
    { Builder b("scale_ruler", 10, 40, 2, 0.05f);
      for (int k = 0; k < 8; ++k) b.box(0, k * 5, 0, 2, k * 5 + 5, 2, k % 2 ? P_RULER_W : P_RULER_R);
      b.box(0, 0, 0, 10, 1, 2, P_RULER_W); b.box(0, 20, 0, 4, 21, 2, P_RULER_W); b.centred(1, 0, 1); rulerModel = add(b); }
    // ground grid: 16 x 16 m, 1 m lines (2 cm thick, 1 cm high), the 4 m lines bolder
    { Builder b("ground_grid", 481, 1, 481, 0.025f);   // 12 x 12 m, 1 m lines 2.5 cm wide
      for (int k = 0; k <= 12; ++k) { b.box(k * 40, 0, 0, k * 40 + 1, 1, 481, P_GRID); b.box(0, 0, k * 40, 481, 1, k * 40 + 1, P_GRID); }
      gridModel = add(b);
      models.back().pivot[1] = -0.6f; }   // 1.5 cm above the street
    // parachute canopy (open): hollow dome, radius 3 m at 0.15 m voxels, with rigging lines to a point 5 m below
    { const int R = 20, H = 34;
      Builder b("parachute_open", 2 * R + 1, H + R / 2 + 2, 2 * R + 1, 0.15f);
      for (int y = 0; y < b.m.ny; ++y)
          for (int z = 0; z < b.m.nz; ++z)
              for (int x = 0; x < b.m.nx; ++x) {
                  float dx = x - R, dz = z - R, dy = (float)(y - H);
                  float r = std::sqrt(dx * dx + dz * dz + dy * dy * 4.f);
                  if (dy >= 0 && r <= R && r > R - 1.6f) {
                      float ang = std::atan2(dz, dx);
                      b.m.at(x, y, z) = (uint8_t)(1 + ((int)std::floor((ang + 3.14159f) / (3.14159f / 4.f)) % 2 ? P_CANOPY : P_CANOPY_DARK));
                  }
              }
      for (int k = 0; k < 8; ++k) {   // rigging lines from the canopy rim to the harness point (bottom centre)
          float a = k * 3.14159f / 4.f;
          for (int s = 0; s <= 60; ++s) {
              float f = s / 60.f;
              int x = (int)std::lround(R + std::cos(a) * (R - 1) * f), z = (int)std::lround(R + std::sin(a) * (R - 1) * f);
              int y = (int)std::lround(H * f);
              if (!b.m.get(x, y, z)) b.m.at(x, y, z) = 1 + P_CORD;
          }
      }
      b.centred((float)R, 0.f, (float)R); chuteOpenModel = add(b); }
    // collapsed canopy: flat draped cloth on the ground with a few folds
    { Builder b("parachute_collapsed", 50, 4, 26, 0.15f);
      for (int z = 0; z < 26; ++z)
          for (int x = 0; x < 50; ++x) {
              float e = (x - 25.f) * (x - 25.f) / 625.f + (z - 13.f) * (z - 13.f) / 169.f;
              if (e > 1.f) continue;
              int h = 1 + (int)(1.5f + 1.5f * std::sin(x * 0.45f) * (1.f - e));
              b.box(x, 0, z, x + 1, h, z + 1, (x / 6) % 2 ? P_CANOPY : P_CANOPY_DARK);
          }
      chuteCollapsedModel = add(b); }
    { Builder b("drop_crate", 10, 9, 10, 0.1f);
      b.box(0, 0, 0, 10, 9, 10, P_OLIVE); b.box(0, 0, 0, 10, 1, 10, P_WOOD_DARK); b.box(0, 4, 0, 10, 5, 10, P_KHAKI); b.box(4, 0, 0, 6, 9, 10, P_KHAKI);
      dropCrateModel = add(b); }
    { Builder b("tracer", 1, 1, 30, 0.04f); b.box(0, 0, 0, 1, 1, 30, P_TRACER); b.centred(0.5f, 0.5f, 0.f); tracerModel = add(b); }
}

// ---------------------------------------------------------------------------------------------------------------
// authored assets (assets/military/*.ttzm + *.json, docs/MILITARY_ASSETS.md)
static bool readAll(const std::string& path, std::vector<uint8_t>& out) {
    size_t n = 0;
    void* d = SDL_LoadFile(path.c_str(), &n);
    if (!d) return false;
    out.assign((uint8_t*)d, (uint8_t*)d + n);
    SDL_free(d);
    return true;
}

bool MilitaryLibrary::loadTtzm(const std::string& jsonPath, const std::string& binPath, bool inf, float bodyVoxel) {
    std::vector<uint8_t> jt, bin;
    if (!readAll(jsonPath, jt) || !readAll(binPath, bin) || bin.size() < 32) return false;
    json::Value j;
    if (!json::parse(std::string(jt.begin(), jt.end()), j) || j["format"].str != "TTZM") { SDL_Log("military: %s: bad manifest", jsonPath.c_str()); return false; }
    const uint32_t* w = (const uint32_t*)bin.data();
    if (w[0] != 0x4D5A5454u || w[1] != 1u) { SDL_Log("military: %s: bad header", binPath.c_str()); return false; }
    const uint32_t palN = w[2], vtxN = w[3];
    if (bin.size() < 32 + (size_t)palN * 8 + (size_t)vtxN * 8) { SDL_Log("military: %s truncated", binPath.c_str()); return false; }
    // palette -> city materials, appended after the lab palette (ids remapped)
    const uint32_t palBase = (uint32_t)palette.size();
    for (uint32_t i = 0; i < palN; ++i) {
        uint32_t rgba = w[8 + i * 2], fl = w[8 + i * 2 + 1];
        bool emissive = fl & 1, metal = fl & 2, glass = fl & 4;
        CityMaterial m = mat((rgba & 255) / 255.f, ((rgba >> 8) & 255) / 255.f, ((rgba >> 16) & 255) / 255.f, metal ? 0.45f : 0.85f, metal ? 0.3f : 0.f,
                             (emissive ? MAT_EMISSIVE : 0u) | (glass ? MAT_GLASS : 0u), emissive ? EM_STEADY : EM_NONE, emissive ? 2.f : 0.f);
        m.name = j["palette"][i]["name"].str;
        palette.push_back(m);
    }
    if (palette.size() > 256) SDL_Log("military: palette exceeds 256 materials (%zu): later ids render grey", palette.size());
    const uint32_t* vtx = w + 8 + palN * 2;
    static const int8_t NRM[6][3] = {{127, 0, 0}, {-127, 0, 0}, {0, 127, 0}, {0, -127, 0}, {0, 0, 127}, {0, 0, -127}};
    auto partMesh = [&](uint32_t first, uint32_t count, float unit) {
        CityMesh m;
        m.scaleXZ = m.scaleY = 0.5f * unit;
        for (uint32_t k = 0; k < count && first + k < vtxN; ++k) {
            uint32_t a = vtx[(first + k) * 2], b = vtx[(first + k) * 2 + 1];
            CityVertex v{};
            v.x = (int16_t)((int)(a & 1023) - 512); v.y = (int16_t)((int)((a >> 10) & 1023) - 512); v.z = (int16_t)((int)((a >> 20) & 1023) - 512);
            uint32_t f = std::min(b & 7u, 5u);
            v.nx = NRM[f][0]; v.ny = NRM[f][1]; v.nz = NRM[f][2];
            v.mat = (uint8_t)std::min<uint32_t>(255u, palBase + ((b >> 5) & 255u));
            m.verts.push_back(v);
            m.idx.push_back(k);
        }
        return m;
    };
    auto addMesh = [&](const std::string& name, CityMesh&& cm) {
        MilVoxelModel stub;
        stub.name = name;
        models.push_back(stub);
        premeshed.resize(models.size() - 1);
        premeshed.push_back(std::move(cm));
        return (int)models.size() - 1;
    };
    static const char* kSlots[10] = {"head", "torso", "upperArmL", "forearmL", "upperArmR", "forearmR", "thighL", "shinL", "thighR", "shinR"};
    auto slotOf = [](const std::string& s) { for (int i = 0; i < 10; ++i) if (s == kSlots[i]) return i; return -1; };
    for (const json::Value& mj : j["models"].arr) {
        const json::Value& parts = mj["parts"];
        if (inf) {
            MilInfantry I;
            I.cls = mj["class"].str; I.variant = mj["label"].str.empty() ? mj["name"].str : mj["label"].str;
            I.ownBody = true;
            const json::Value& rest = mj["poses"]["rest"];
            for (size_t p = 0; p < parts.size(); ++p) {
                const json::Value& pj = parts[p];
                int slot = slotOf(pj["slot"].str);
                int par = (int)pj["parent"].n(-1);
                if (slot < 0 && par >= 0) slot = slotOf(parts[(size_t)par]["slot"].str);
                if (slot < 0) continue;
                MilAttachment A;
                A.name = pj["name"].str; A.slot = slot;
                A.model = addMesh(mj["name"].str + "/" + A.name, partMesh((uint32_t)pj["first"].n(), (uint32_t)pj["count"].n(), (float)pj["unit"].n(bodyVoxel)));
                if (A.name == "weapon") {   // grip at the hand: (0, -3.5, 0) V below the elbow, rest-pose mount rotation
                    A.offset[1] = -3.5f;
                    const json::Value& e = rest["weaponMount"];
                    float eu[3] = {(float)e[0].n(), (float)e[1].n(), (float)e[2].n()};
                    eulerXYZToQuat(eu, A.quat);
                    const json::Value& mz = mj["weapon"]["muzzle"];
                    for (int k = 0; k < 3; ++k) I.muzzleW[k] = (float)mz[k].n();
                    I.weaponAtt = (int)I.atts.size();
                    I.muzzle[0] = (float)mz[0].n() / bodyVoxel; I.muzzle[1] = -3.5f + (float)mz[1].n() / bodyVoxel; I.muzzle[2] = (float)mz[2].n() / bodyVoxel;
                }
                I.atts.push_back(A);
            }
            if (flashModel >= 0) {
                MilAttachment F;
                F.name = "muzzle flash"; F.slot = 5; F.model = flashModel; F.fx = true;
                std::memcpy(F.offset, I.muzzle, sizeof(F.offset));
                I.atts.push_back(F);
                I.muzzleAtt = (int)I.atts.size() - 1;
            }
            I.model = mj["name"].str;
            I.clips.clear();
            for (const char* pn : {"rest", "carry"}) {   // reference poses of infantry.json as one-key clips
                const json::Value& pj = mj["poses"][pn];
                if (pj.type != json::Value::Object) continue;
                MilKeyClip kc;
                kc.name = std::string(pn) + " pose";
                kc.loop = true;
                MilPoseKey k;
                for (int s = 0; s < 10; ++s) for (int a = 0; a < 3; ++a) k.rot[s][a] = (float)pj["rot"][kSlots[s]][(size_t)a].n();
                for (int a = 0; a < 3; ++a) k.weaponMount[a] = (float)pj["weaponMount"][(size_t)a].n();
                k.hasMount = true;
                kc.keys.push_back(k);
                keyClips.push_back(kc);
                MilClip c;
                c.name = kc.name; c.keyClip = (int)keyClips.size() - 1; c.anim = 9; c.length = 1.f;
                I.clips.push_back(c);
            }
            I.clips.push_back({"idle (zombie clip)", -1, 1, 4.f, 0.f, true, true});
            I.clips.push_back({"walk (zombie clip)", -1, 2, 1.6f, 1.3f, true, true});
            infantry.push_back(I);
        } else {
            MilProp P;
            P.name = mj["name"].str;
            P.category = P.name.substr(0, P.name.find('_'));
            const json::Value& fp = mj["footprint"];
            if (fp.size() >= 2) { P.footprint[0] = (float)fp[0].n(1); P.footprint[1] = (float)fp[1].n(1); }
            for (size_t p = 0; p < parts.size(); ++p) {
                const json::Value& pj = parts[p];
                int model = addMesh(P.name + "/" + pj["name"].str, partMesh((uint32_t)pj["first"].n(), (uint32_t)pj["count"].n(), (float)pj["unit"].n(0.05)));
                P.parts.push_back({model, {(float)pj["pivot"][0].n(), (float)pj["pivot"][1].n(), (float)pj["pivot"][2].n()}});
            }
            if (!P.parts.empty()) P.model = P.parts[0].first;
            props.push_back(P);
        }
    }
    return true;
}

bool MilitaryLibrary::load(const std::string& dir, float bodyVoxel) {
    SDL_PathInfo info;
    if (!SDL_GetPathInfo((dir + "/infantry.json").c_str(), &info) && !SDL_GetPathInfo((dir + "/props.json").c_str(), &info)) return false;
    models.clear(); premeshed.clear(); infantry.clear(); props.clear();
    basePalette();
    buildLabHelpers();
    premeshed.resize(models.size());
    bool a = loadTtzm(dir + "/infantry.json", dir + "/infantry.ttzm", true, bodyVoxel);
    bool b = loadTtzm(dir + "/props.json", dir + "/props.ttzm", false, bodyVoxel);
    if (!a && !b) return false;
    premeshed.resize(models.size());
    placeholder = false;
    source = dir + " (" + std::to_string(infantry.size()) + " infantry, " + std::to_string(props.size()) + " props)";
    SDL_Log("military lab: loaded %s", source.c_str());
    return true;
}

} // namespace ttz
