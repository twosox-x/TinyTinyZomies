#pragma once
// Reusable GPU renderer for the approved military assets (WS-B), extracted from MilitaryLab so the lab and the game
// draw soldiers, props, canopies, crates and weapon FX through ONE path (no second implementation to drift).
//
// What moves here from MilitaryLab.cpp (unchanged behaviour, the lab becomes a client):
//   library load + meshing + GPU mesh upload (init), mil_pose / mil_attach pipelines and buffers, per-mesh instance
//   buckets, pose sampling with cross-fade + left-arm re-solve (sampleBody / sampleSoldier), weapon slung / dropped
//   tracks, hand items, distance LOD + per-soldier frustum culling, FX pool (muzzle flashes, tracers, casings,
//   suppressor puffs, dust) with the flash point lights, canopy / crate track drawing with roof clamp and the voxel
//   dissolve, prepare / draw / drawShadow.
// What stays in MilitaryLab: scene layout, review views, UI panel, stress scripts, bench table, lineup / turntable.
//
// Frame protocol (render thread = main thread; game state is read-only here):
//   beginFrame(camera)  -> add*() for everything visible this frame -> (Renderer calls) prepare / draw / drawShadow
// The game samples poses at render time from its AnimPlayback (interpolating between 30 Hz ticks is free: clip time
// advances continuously with frame dt between ticks, the tick re-syncs it).
#include "city/CityRenderer.h"
#include "lab/MilitaryAssets.h"
#include "render/Math.h"

#include <cstdint>
#include <vector>

namespace ttz {

class GpuContext;
class CharacterRenderer;
class CrowdSim;
class Camera;
struct PointLight;

// Everything needed to pose one soldier (same fields as the lab's Soldier and game::AnimPlayback).
struct MilPoseInput {
    int infantry = 0;                 // MilitaryLibrary::infantry index
    V3 pos;
    float yaw = 0.f;
    int clip = 0;                     // MilInfantry::clips index
    float t = 0.f;
    int prevClip = -1;                // cross-fade source (-1: none)
    float prevT = 0.f, blend = 0.f, blendDur = 0.f;
    float dissolve = 0.f;             // 0 visible .. 1 gone (bodies removed later, OPEN)
    uint32_t marker = 0;              // squad marker colour / class tint for the selection ring (0 none)
};

struct MilDropInput {                 // a canopy (infantry or cargo) or a crate in its descent / landing sequence
    bool cargo = false;
    int infantry = 0;                 // canopy clip class (infantry drops)
    V3 pos;                           // harness / load point (world)
    float yaw = 0.f;
    int clip = -1;                    // keyClips index of the current phase (descent / land / recover)
    float t = 0.f;
    bool released = false;            // harness released: canopy frozen at relCanopy
    float relCanopy[MC_STRIDE] = {};
    float clamp[8] = {0, 0, 0, 0, 0, 0, 0, 0};   // roof footprint for the canopy collapse (city.vert)
    float groundT = -1.f;             // seconds since canopy_ground (dissolve clock), -1 not yet
};

struct MilRenderStats { uint32_t soldiers = 0, visible = 0, instances = 0, draws = 0, fx = 0, lod[3] = {0, 0, 0}; uint64_t tris = 0; double cpuMs = 0; uint64_t upload = 0; };

class MilitaryRenderer {
public:
    bool init(GpuContext& gpu, CityRenderer& city, CharacterRenderer& chars, const CrowdSim& sim, float bodyVoxel);
    void shutdown();
    const MilitaryLibrary& library() const { return lib_; }
    int findClip(int infantry, const char* action) const;   // per-infantry clip index (MilInfantry::clips)

    void beginFrame(const Camera& camera, float aspect);
    void addSoldier(const MilPoseInput& s);
    void addProp(int prop, V3 pos, float yaw, float dissolve = 0.f);       // MilitaryLibrary::props index
    void addDrop(const MilDropInput& d);
    // FX at the posed weapon of `s` (render-time muzzle / ejection port): type = anims.json event type
    // ("muzzle_flash", "tracer", "shell_eject", "suppressed", "footstep", "body_fall"), weapon kind from the class.
    void fxEvent(const MilPoseInput& s, const char* type);
    void fxBurst(V3 pos, int kind);   // landing dust, crate touch, impacts
    void updateFx(float dt);
    void injectLights(std::vector<PointLight>& lights) const;

    // Renderer extension hooks (Renderer::extPrepare / extDraw / extShadowDraw)
    void prepare(SDL_GPUCommandBuffer* cmd);
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH);
    void drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd);
    const MilRenderStats& stats() const { return st_; }

private:
    MilitaryLibrary lib_;
    MilRenderStats st_;
    // WS-B moves the MilitaryLab GPU members here (pipelines, buffers, meshes, buckets, fx pool).
};

} // namespace ttz
