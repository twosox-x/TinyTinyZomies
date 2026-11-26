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

struct MilClip {
    std::string name;
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
    // lab-only helper models (scale ruler, ground grid, parachute demo, tracer)
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

} // namespace ttz
