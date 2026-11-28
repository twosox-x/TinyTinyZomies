#pragma once
// Reusable GPU renderer for the approved military assets (WS-B), extracted from MilitaryLab so the lab and the game
// draw soldiers, props, canopies, crates and weapon FX through ONE path (no second implementation to drift).
//
// Owns: library load + meshing + GPU mesh upload, mil_pose / mil_attach pipelines and buffers, per-mesh instance
// buckets, pose sampling with cross-fade + left-arm re-solve, weapon slung / dropped tracks, hand items, distance LOD
// + per-soldier frustum culling, the FX pool (muzzle flashes, tracers, casings, suppressor puffs, dust) with the flash
// point lights, parachute canopy / cargo crate tracks (canopy deformation, roof clamp, voxel dissolve), world-space
// RTS markers (rings, class icons; emissive, no shadow), prepare / draw / drawShadow. Shadows: every soldier, prop,
// canopy and crate is a caster of the key-light shadow map (drawShadow); markers are not.
// The lab keeps: scene layout, review views, UI panel, stress scripts, bench table, moon-shadow height field.
//
// Frame protocol (main thread; game state is read-only here):
//   beginFrame(camera, aspect) -> add*() / advanceDrop() / fxEvent() -> updateFx(dt) -> endFrame()
//   -> (Renderer hooks) prepare / draw / drawShadow, lights via injectLights (or the hook's lights callback).
// Pose sampling is CPU (clip playback state MilPlayback, shared with game::SoldierAnimator), so a client may sample at
// any time between its ticks (pass the interpolated clip time).
#include "city/CityRenderer.h"
#include "lab/MilitaryAssets.h"
#include "render/Math.h"

#include <array>
#include <cstdint>
#include <functional>
#include <vector>

namespace ttz {

class GpuContext;
class CharacterRenderer;
class CrowdSim;
class Camera;
class Renderer;
struct PointLight;

// Everything needed to pose one soldier (playback fields shared with the lab's Soldier and game::AnimPlayback).
struct MilPoseInput : MilPlayback {
    int infantry = 0;                 // MilitaryLibrary::infantry index
    V3 pos;
    float yaw = 0.f;
    int lod = -1;                     // -1: frustum cull + distance LOD here; >= 0: forced LOD, never culled
    bool noWeapon = false;            // weapon not drawn with the body (game: a rising dead soldier left it on the ground)
};

// A parachute sequence (docs/MILITARY_ANIMS.md 2.3): soldier (street / rooftop) or cargo crate.
// advanceDrop runs descent (descentSpeed) -> touchdown -> land -> recover -> settled with the clip events (harness
// release freezes the canopy, canopy_ground starts the hold + voxel dissolve clock, dust on touch events).
struct MilDrop {
    bool cargo = false;
    int inf = 0;                      // infantry index (canopy clip class); cargo: unused
    V3 xz{};                          // landing point (y = surface)
    float yaw = 0, startH = 40.f;
    int phase = 0;                    // 0 descent, 1 land, 2 recover, 3 settled
    float t = 0, alt = 0, hold = 0;
    bool released = false;            // harness released: canopy frozen
    float groundT = -1.f;             // seconds since canopy_ground (-1: not yet): hold, then voxel dissolve
    float relCanopy[MC_STRIDE] = {};
    V3 relPos{};
    float clamp[8] = {0, 0, 0, 0, 0, 0, 0, 0};   // canopy clamp: roof footprint rect + heights (city.vert)
    // client options (defaults = lab behaviour)
    bool drawBody = true;             // false: the soldier body is drawn by the client (game: SoldierPool soldier)
    bool demoLoop = true;             // lab: settled for 6 s -> drop again
    bool externalDescent = false;     // phase 0 altitude / time set by the client (game: Logistics crate); never auto-lands
    float crateDissolve = 0.f;        // cargo: crate voxel dissolve 0..1 (empty crates removed)
};

// World-space RTS feedback (game UI). Emissive, subtle, not shadow casters.
enum class MilMarker : uint8_t { Ring = 0, RingSelected, IconRifle, IconMG, IconSniper, MoveTarget, Count };
enum MilMarkerColor : uint8_t { MK_WHITE = 0, MK_GREEN, MK_AMBER, MK_CYAN, MK_RED, MK_BLUE, MK_COUNT };

struct MilRenderStats { uint32_t soldiers = 0, visible = 0, instances = 0, draws = 0, fx = 0, lod[3] = {0, 0, 0}; uint64_t tris = 0; double cpuMs = 0; uint64_t upload = 0; };

class MilitaryRenderer {
public:
    struct CharU { float posYaw[4]; float anim[4]; uint32_t look[4]; float rot[10][4]; float rootQ[4]; float rootPos[4]; };
    struct AttU { uint32_t info[4]; float offset[4]; float quat[4]; };
    using Inst = CityRenderer::GpuInstance;

    bool init(GpuContext& gpu, CityRenderer& city, CharacterRenderer& chars, const CrowdSim& sim, float bodyVoxel);
    void shutdown();
    const MilitaryLibrary& library() const { return lib_; }
    int findClip(int infantry, const char* action) const;   // per-infantry clip index (MilInfantry::clips), -1 none
    int findProp(const char* name) const;                   // MilitaryLibrary::props index, -1 none
    float bodyVoxel() const { return bodyVoxel_; }
    const std::vector<std::array<float, 6>>& meshBounds() const { return meshBounds_; }   // model-space AABB per mesh

    // Renderer extension registration (Renderer::addExtension): prepare / draw / shadow / lights. Several clients may
    // be registered at once (lab, game); each draws only what it was given this frame.
    void installHooks(Renderer& r, bool lights = true);
    void removeHooks(Renderer& r);

    // options
    bool fxEnabled = true;                                  // clip events -> FX (lab "FX from clip events")
    std::function<float(float, float)> groundHeight;        // casings bounce on it (default: y = 0)

    // ---- frame
    void beginFrame(const Camera& camera, float aspect);    // frustum + eye; clears this frame's lists
    bool visible(V3 p, float r) const;                      // per-soldier frustum test (p at the feet)
    int lodAt(V3 p) const;                                  // 0 < 70 m, 1 < 180 m, 2 beyond
    bool addSoldier(const MilPoseInput& s);                 // false: culled / over capacity
    void addModel(int model, V3 p, const float q[4], int kind = 1, const float* paint = nullptr);   // raw mesh instance
    void addModelYaw(int model, V3 p, float yaw);
    void addProp(int prop, V3 pos, float yaw, float dissolve = 0.f);
    // Raw CPU instance of a model (B2 walls: kind 2 = deformed prop with xz / y scale in paint.xy, dissolve in pos.w).
    void addInstance(int model, const Inst& gi) { if (model >= 0 && model < (int)instBuckets_.size()) instBuckets_[(size_t)model].push_back(gi); }
    // The weapon a death clip dropped, alone, where the clip's weapon track left it at time so.t (the body is gone or
    // drawn with noWeapon). False when the clip has no weapon track.
    bool addDroppedWeapon(const MilPoseInput& so);
    void addCityMesh(const CityRenderer::GpuMesh* mesh, V3 p, const float q[4]);   // city palette (comparison vehicles)
    void addMarker(MilMarker shape, int color, V3 p, float yaw);   // icons: yaw ignored, they face the camera
    void advanceDrop(MilDrop& d, float dt);
    void addDrop(const MilDrop& d);
    // FX at the posed weapon of `s` (render-time muzzle / ejection port): e.type = anims.json event type
    // ("muzzle_flash", "tracer", "shell_eject", "suppressed", "footstep", "body_fall"); others are ignored.
    void fxEvent(const MilPoseInput& s, const MilFxEvent& e);
    void fxShot(const MilPoseInput& s);                     // one full shot of the class weapon (flash, tracer, casing)
    void fxBurst(V3 pos, int kind);                         // 0 small dust (footstep), 1 landing dust ring
    // One round fired along a known ray (game: Combat shot + HordeBridge hit): flash (or suppressor puff + faint glint)
    // at the posed muzzle, optional casing, optional tracer from the posed muzzle to `hit`. Returns the tracer id
    // (0: none) for fxTracerEnd once the GPU resolves where the round stopped.
    uint32_t fxShotRay(const MilPoseInput& s, V3 hit, bool tracer, bool casing);
    // Bright emissive streak travelling from `from` to `to` (style 0 rifle, 1 MG, 2 sniper: thinner, faster).
    uint32_t fxTracer(V3 from, V3 to, int style);
    // Flamethrower spray (GAME_DESIGN 14d, game FxKind::Flame): nozzle glow + light at the posed muzzle of `s` and a rare
    // small ember along `dir`. The flame stream itself is a voxel fx volume (Renderer::setFlameVolumes, kind 2).
    void fxFlame(const MilPoseInput& s, V3 dir, float range);
    void fxTracerEnd(uint32_t id, float distFromStart);     // shorten / lengthen a live tracer (hit resolved)
    float tracerLength = 4.5f;                              // m, short visible streak behind the head (owner 14e)
    float tracerWidth = 1.f;                                // x the minimum angular width (1: ~1.2 px at 1080p)
    float flashScale = 1.f;                                 // x the minimum angular size of muzzle flashes (~3 px)
    void clearFx() { fx_.clear(); flashes_.clear(); }
    void updateFx(float dt);                                // age / move FX, emit their instances (before endFrame)
    void endFrame();                                        // parts sorted by mesh, CPU instances, canopies, vehicles
    void injectLights(std::vector<PointLight>& lights) const;   // muzzle flash lights, nearest first, at most 4
    const std::vector<std::vector<Inst>>& cpuBuckets() const { return instBuckets_; }   // this frame's CPU instances by mesh

    // Renderer extension hooks
    void prepare(SDL_GPUCommandBuffer* cmd);
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH);
    void drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd);
    const MilRenderStats& stats() const { return st_; }
    MilRenderStats& stats() { return st_; }

    static constexpr uint32_t kMaxChars = 1280, kMaxAtts = 28672, kMaxCpuInst = 8192, kMaxFx = 4000, kMaxFlashLights = 4;

private:
    // kind 0 static, 1 ballistic, 2 drift, 3 tracer (clip event), 4 ray tracer (p start, v unit dir, a length, b style)
    struct Fx { int model; V3 p, v; float q[4]; float age, life; int kind; float glow = 0.f, a = 0.f, b = 0.f, speed = 0.f; uint32_t id = 0; bool fresh = false; };
    static constexpr float kStreakVoxel = 0.05f, kStreakLength = 0.8f;   // FX_STREAK model: 1 x 16 x 1 voxels of 5 cm
    struct Flash { V3 p; float life; float radius; float intensity; };
    uint32_t flameSeq_ = 0;   // fxFlame jitter stream
    void soldierEvent(const MilPoseInput& so, const CharU& C, const MilFxEvent& e);
    void pushSoldier(const MilPoseInput& so, int lod);
    void sampleSoldier(const MilPoseInput& so, CharU& C, float mountQ[4], int lod) const;
    bool sampleBody(const MilPoseInput& so, int lod, float* B) const;
    void muzzleFrame(const MilPoseInput& so, const CharU& C, const float mountQ[4], const float wsPoint[3], V3& outP, float outQ[4]) const;
    void addHose(const MilPoseInput& so, const CharU& C, const float mountQ[4], const MilInfantry& inf);
    void spawnFx(int model, V3 p, V3 v, const float q[4], float life, int kind, float glow = 0.f);
    void addGlow(int model, V3 p, const float q[4], float sxz, float sy);
    void buildMarkers();

    MilitaryLibrary lib_;
    MilRenderStats st_;
    GpuContext* gpu_ = nullptr;
    CityRenderer* city_ = nullptr;
    CharacterRenderer* chars_ = nullptr;
    const CrowdSim* sim_ = nullptr;
    SDL_GPUComputePipeline *pPose_ = nullptr, *pAttach_ = nullptr;
    SDL_GPUBuffer *charBuf_ = nullptr, *attBuf_ = nullptr, *joints_ = nullptr, *segs_ = nullptr, *insts_ = nullptr, *mats_ = nullptr;
    SDL_GPUTransferBuffer* tb_ = nullptr;
    std::vector<CityRenderer::GpuMesh> meshes_;
    std::vector<std::array<float, 6>> meshBounds_;
    std::vector<uint32_t> meshTris_;
    float bodyVoxel_ = 1.7f / 18.f;
    int markerMesh_[(int)MilMarker::Count][MK_COUNT];
    int hookId_ = -1;

    float frustum_[6][4] = {};
    V3 eye_{}, focus_{};
    V3 lastMuzzle_{};
    uint32_t fxIds_ = 0;

    // per-frame lists
    std::vector<CharU> charsU_;
    std::vector<std::vector<AttU>> attBuckets_;
    std::vector<AttU> atts_;
    uint32_t placeholderChars_ = 0;
    std::vector<std::vector<Inst>> instBuckets_;
    std::vector<Inst> cpuInst_;
    std::vector<CityRenderer::ExtDraw> draws_, vehDraws_, markerDraws_;
    std::vector<Inst> vehInst_, canopyInst_, markerInst_;
    std::vector<CityRenderer::ExtDraw> canopyDraws_;
    std::vector<std::vector<Inst>> markerBuckets_;

    std::vector<Fx> fx_;
    float pxAngle_ = 0.0007f;   // rad per pixel at 1080p (beginFrame: camera fovY / 1080)
    std::vector<Flash> flashes_;
    int mgRound_ = 0;
};

} // namespace ttz
