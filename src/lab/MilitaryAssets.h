#pragma once
// Military asset library for the Military Asset Lab (`ttz --lab military`).
//
// Assets are voxel models (palette indices on a regular grid) plus infantry definitions: a body on the approved
// zombie body standard (10 segments, docs/CHARACTER_STANDARD.md) with attachments parented to body slots (helmet ->
// head, vest / backpack -> torso, weapon -> forearmR, ...), and an animation clip list. Props are standalone
// voxel models. Everything is meshed on load into the city vertex layout (CityMesh) and drawn with the city
// material / lighting / shadow path.
//
// Sources: assets/military/ (tools/convert_military.mjs, docs/MILITARY_ASSETS.md) when present; otherwise a
// built-in placeholder library (zombie module combos for the infantry bodies, simple voxel props) so the lab and
// its review workflow run before the authored assets exist.
#include "city/CityAsset.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace ttz {

struct MilVoxelModel {
    std::string name;
    int nx = 0, ny = 0, nz = 0;
    float voxel = 0.1f;               // metres per voxel
    float pivot[3] = {0, 0, 0};       // model origin, in voxels (props: centre of the footprint at ground level)
    std::vector<uint8_t> vox;         // nx*ny*nz, x fastest then z then y; 0 empty, else palette index + 1
    uint8_t& at(int x, int y, int z) { return vox[((size_t)y * nz + z) * nx + x]; }
    uint8_t get(int x, int y, int z) const {
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
        return vox[((size_t)y * nz + z) * nx + x];
    }
};

struct MilAttachment {
    std::string name;                 // helmet, vest, backpack, weapon, muzzle ...
    int slot = 0;                     // body slot 0..9 (head, torso, uaL, faL, uaR, faR, thL, shL, thR, shR)
    int model = -1;
    float offset[3] = {0, 0, 0};      // from the slot pivot, body voxels (character space: +Y up, +Z forward, +X left)
    float quat[4] = {0, 0, 0, 1};
    bool fx = false;                  // effect attachment (muzzle flash): hidden unless triggered
};

// Authored clips (docs/MILITARY_ANIMS.md, assets/military/anims.{json,bin}): dense 30 Hz frames, linear interpolation.
// body frame (44 floats): rot[10][3] (Euler XYZ, zombie slot order), rootPos[3], rootRot[3], weaponMount[3], supportW,
// supportTarget[3], flags. canopy frame (12): pos[3], rot[3], radial, height, clamp, visible, slack, -. crate (6): pos, rot.
enum { MB_ROT = 0, MB_ROOTPOS = 30, MB_ROOTROT = 33, MB_MOUNT = 36, MB_SUPPORTW = 39, MB_SUPPORT = 40, MB_FLAGS = 43, MB_STRIDE = 44 };
enum { MC_POS = 0, MC_ROT = 3, MC_RADIAL = 6, MC_HEIGHT = 7, MC_CLAMP = 8, MC_VISIBLE = 9, MC_SLACK = 10, MC_STRIDE = 12 };
struct MilFxEvent {
    float t = 0.f;
    std::string type;                             // muzzle_flash, tracer, shell_eject, suppressed, footstep, ...
    std::string fx;                               // rifle / mg / sniper
};
struct MilKeyClip {
    std::string name, cls, action;                // "<class>/<action>"
    float duration = 1.f, speed = 0.f, descentSpeed = 0.f;
    float delta[4] = {0, 0, 0, 0};
    bool loop = true, rootMotion = false;
    int frames = 0;
    std::vector<float> body, canopy, crate;       // frames * stride (empty = no such track)
    std::vector<MilFxEvent> events;
    // t in seconds (wrapped for loops, clamped otherwise); out has the track's stride; false if the track is absent
    bool sample(const std::vector<float>& track, int stride, float t, float* out) const;
    bool sampleBody(float t, float* out) const { return sample(body, MB_STRIDE, t, out); }
    bool sampleCanopy(float t, float* out) const { return sample(canopy, MC_STRIDE, t, out); }
    bool sampleCrate(float t, float* out) const { return sample(crate, 6, t, out); }
};

struct MilClip {
    std::string name;
    int keyClip = -1;                 // >= 0: authored clip (MilitaryLibrary::keyClips), anim ignored
    uint32_t anim = 1;                // pose clip id (zombie_pose.glsl ANIM_*, 8 = rest pose)
    float length = 2.f;               // s
    float speed = 0.f;                // m/s (gait phase)
    bool loop = true;
    bool available = true;            // false: slot reserved for the upcoming infantry animation set
};

struct MilInfantry {
    std::string cls, variant;
    uint32_t lookX = 0, lookY = 0;    // body: 56-bit modular appearance (zombie body standard meshes)
    std::vector<MilAttachment> atts;
    std::vector<MilClip> clips;
    bool ownBody = false;             // authored soldier: body segments are attachments; the zombie-mesh body is hidden
    int muzzleAtt = -1;               // index into atts of the muzzle effect (or -1)
    int weaponAtt = -1;               // index into atts of the weapon (or -1)
    float muzzleW[3] = {0, 0, 0};     // muzzle in weapon space (m, grip origin, barrel +Z)
    std::string model;                // authored model name (infantry.json), anim clips bind by model / class
    std::string weaponKind;           // rifle / mg / sniper
    float support[3] = {0, 0, 0};     // weapon space (m)
    float paraSocket[3] = {0, 1.369f, -0.047f};   // model space: parachute harness socket
    float muzzle[3] = {0, 0, 0};      // muzzle position, body voxels from the forearmR pivot (FX hooks)
};

struct MilProp {
    std::string name, category;
    int model = -1;
    std::vector<std::pair<int, std::array<float, 3>>> parts;   // authored: (model, part pivot in model space, m)
    float footprint[2] = {1, 1};      // m (x, z)
};

struct MilitaryLibrary {
    std::vector<CityMaterial> palette;   // city material model (linear albedo, emissive, roughness, flags)
    std::vector<MilVoxelModel> models;
    std::vector<CityMesh> premeshed;     // parallel to models: authored meshes (.ttzm parts); empty = mesh the voxels
    std::vector<MilInfantry> infantry;
    std::vector<MilProp> props;
    std::vector<MilKeyClip> keyClips;
    std::string animSource;           // anims.json status
    int findClip(const std::string& cls, const std::string& action) const;
    bool loadAnims(const std::string& dir);   // assets/military/anims.{json,bin}: per-class clips appended to the infantry
    // lab-only helper models (scale ruler, ground grid, parachute demo, tracer)
    enum { FX_FLASH_RIFLE = 0, FX_FLASH_RIFLE_HALF, FX_FLASH_MG, FX_FLASH_MG_SMALL, FX_TRACER, FX_CASING, FX_PUFF_S, FX_PUFF_M, FX_PUFF_L,
           FX_DUST, FX_DUST_L, FX_COUNT };
    int fxModels[FX_COUNT] = {};      // docs/MILITARY_ANIMS.md 6: voxel FX meshes
    int flashModel = -1, rulerModel = -1, gridModel = -1, chuteOpenModel = -1, chuteCollapsedModel = -1, dropCrateModel = -1, tracerModel = -1;
    bool placeholder = true;
    std::string source;

    // assets/military/ (format per docs/MILITARY_ASSETS.md); false if absent or unreadable
    bool load(const std::string& dir, float bodyVoxel);
    void buildPlaceholders(float bodyVoxel);
    void buildLabHelpers();
private:
    void basePalette();
    bool loadTtzm(const std::string& json, const std::string& bin, bool infantryFile, float bodyVoxel);
};

// Visible-face voxel mesher (one quad per exposed voxel face, explicit indices), model space in metres:
// (v - pivot) * voxel. Material ids = palette index.
CityMesh meshVoxelModel(const MilVoxelModel& m);
void eulerXYZToQuat(const float e[3], float q[4]);   // q = qx * qy * qz (zombie_pose.glsl qeulerXYZ)

} // namespace ttz
