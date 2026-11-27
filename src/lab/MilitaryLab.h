#pragma once
// Military Asset Lab (`ttz --lab military`): an in-engine review diorama for the military assets. No gameplay, no AI.
//
// Scene: a street patch of the baked city (same renderer, night tone, moon shadows, street lamps, tilt-shift, fog),
// its parked civilian vehicles, a lineup of approved zombies (real simulation agents, the unchanged zombie path),
// the military infantry and props.
// Soldiers: authored clips (docs/MILITARY_ANIMS.md) are sampled on the CPU (per-slot Euler, clip root, weapon mount);
// shaders/mil_pose.comp evaluates the joints with the zombie hierarchy (one thread per soldier), shaders/mil_attach.comp
// places every part (one thread per part); parts are sorted by mesh, so each mesh is ONE instanced draw through the
// city material / lighting path. Distance LOD (pose rate, small gear dropped) and frustum culling per soldier.
// FX (docs/MILITARY_ANIMS.md 6): small voxel muzzle flashes, tracers, casings, suppressor puffs, dust, from clip events
// at the authored muzzle / ejection port of the posed weapon (CPU forward kinematics of the right arm), budgeted.
// Parachute drops (soldier street + rooftop, cargo crate) play the authored canopy / crate tracks.
// Stress mode: N scripted soldiers (mixed classes, cycling idle / walk / run / aim / fire / reload / death) with the
// zombie horde; headless `--lab-stress` prints a benchmark table.
// Lab props and soldiers are added to the moon-shadow height field (they cast shadows like buildings and cars).
#include "city/CityRenderer.h"
#include "lab/MilitaryAssets.h"

#include <string>
#include <vector>

namespace ttz {

struct AppState;

class MilitaryLab {
public:
    bool init(AppState& s);           // after the App's renderers exist (city mode)
    void shutdown();
    void setupScene(AppState& s);     // simulation reset: zombie lineup (no goals: they stand) / stress horde
    void update(AppState& s, float dt);
    void injectLights(std::vector<PointLight>& lights) const;   // muzzle flash lights
    void prepare(SDL_GPUCommandBuffer* cmd);
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH);
    void drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd);   // casters into the key-light shadow map
    void drawUI(AppState& s);
    bool applyView(AppState& s, const std::string& name);

    struct CharU { float posYaw[4]; float anim[4]; uint32_t look[4]; float rot[10][4]; float rootQ[4]; float rootPos[4]; };
    struct AttU { uint32_t info[4]; float offset[4]; float quat[4]; };

private:
    struct Soldier {
        int inf = 0;
        V3 pos{};
        float yaw = 0;
        int clip = 0;              // index into the infantry's clip list
        float t = 0, rate = 1.f;
        int script = -1;           // stress script state (-1: none)
        float stateLeft = 0;
        bool fxEvents = true;
        // cross-fade (anims.json transitions): previous clip keeps playing underneath for blendDur
        int prevClip = -1;
        float prevT = 0, blend = 0, blendDur = 0;
        float prevDelta[4] = {0, 0, 0, 0};   // root motion already committed while the previous clip still blends out
        V3 home{};
        bool mover = false;                  // stress: walk / run along the street instead of in place
    };
    struct Drop {                  // parachute sequence
        bool cargo = false;
        int inf = 0;
        V3 xz{};                   // landing point (y = surface)
        float yaw = 0, startH = 40.f;
        int phase = 0;             // 0 descent, 1 land, 2 recover, 3 settled
        float t = 0, alt = 0, hold = 0;
        bool released = false;     // harness released: canopy frozen
        float groundT = -1.f;      // seconds since canopy_ground (-1: not yet): hold, then voxel dissolve (MILITARY_ANIMS.md 2.3.3)
        float relCanopy[MC_STRIDE] = {};
        V3 relPos{};
        float clamp[8] = {0, 0, 0, 0, 0, 0, 0, 0};   // canopy clamp: roof footprint rect + heights (city.vert)
    };
    struct Fx { int model; V3 p, v; float q[4]; float age, life; int kind; };   // kind 0 static, 1 ballistic, 2 drift, 3 tracer
    V3 world(float lx, float lz, float y = 0.f) const;
    float worldYaw(float localYaw) const { return frameYaw_ + localYaw; }
    void findSpot(AppState& s);
    void findRoof(AppState& s);
    void select(AppState& s, int kind, int index);
    void triggerFx(const std::string& type);                     // FX buttons (selected soldier)
    void soldierEvent(const Soldier& so, const CharU& C, const MilFxEvent& e);
    void pushSoldier(const Soldier& so, int lod, CharU* out = nullptr);
    void sampleSoldier(const Soldier& so, CharU& C, float mountQ[4], int lod) const;
    bool sampleBody(const Soldier& so, int lod, float* B) const;      // blended clip pose + left-arm re-solve
    void switchClip(Soldier& so, int clip);                           // cross-fade per the transition table
    void commitRootMotion(Soldier& so, const MilKeyClip& k);
    void placeDrops(AppState& s);
    void muzzleFrame(const Soldier& so, const CharU& C, const float mountQ[4], const float wsPoint[3], V3& outP, float outQ[4]) const;
    void spawnFx(int model, V3 p, V3 v, const float q[4], float life, int kind);
    void putInst(int model, V3 p, const float q[4], const CityRenderer::GpuMesh* mesh = nullptr, int kind = 1, const float* paint = nullptr);
    void putYaw(int model, V3 p, float yaw) { float q[4] = {0, std::sin(0.5f * yaw), 0, std::cos(0.5f * yaw)}; putInst(model, p, q); }
    void updateDrops(AppState& s, float dt);
    void drawDrop(const Drop& d);
    void setupStress(AppState& s, int n);
    void rebuildShadows(AppState& s);
    void benchStep(AppState& s);
    int clipByAction(const MilInfantry& inf, const char* action) const;

    AppState* app_ = nullptr;
    MilitaryLibrary lib_;
    GpuContext* gpu_ = nullptr;
    CityRenderer* city_ = nullptr;
    class CharacterRenderer* chars_ = nullptr;
    const class CrowdSim* sim_ = nullptr;
    SDL_GPUComputePipeline *pPose_ = nullptr, *pAttach_ = nullptr;
    SDL_GPUBuffer *charBuf_ = nullptr, *attBuf_ = nullptr, *joints_ = nullptr, *segs_ = nullptr, *insts_ = nullptr, *mats_ = nullptr;
    SDL_GPUBuffer* shadowBuf_ = nullptr;
    SDL_GPUTransferBuffer* tb_ = nullptr;
    std::vector<CityRenderer::GpuMesh> meshes_;
    std::vector<std::array<float, 6>> meshBounds_;   // model-space AABB per mesh
    std::vector<uint32_t> meshTris_;
    float bodyVoxel_ = 1.7f / 18.f;
    int fxModel_[16];

    // lab frame: world = origin + rotY(frameYaw) * local
    float ox_ = 0, oz_ = 0, oy_ = 0, frameYaw_ = 0;
    bool spotFound_ = false;
    V3 roof_{};
    bool roofFound_ = false;

    // per-frame lists
    std::vector<CharU> charsU_;
    std::vector<std::vector<AttU>> attBuckets_;
    std::vector<AttU> atts_;
    uint32_t placeholderChars_ = 0;
    std::vector<std::vector<CityRenderer::GpuInstance>> instBuckets_;
    std::vector<CityRenderer::GpuInstance> cpuInst_;
    std::vector<CityRenderer::ExtDraw> draws_, vehDraws_;
    std::vector<CityRenderer::GpuInstance> vehInst_, canopyInst_;
    std::vector<CityRenderer::ExtDraw> canopyDraws_;
    bool dropsPlaced_ = false;
    Soldier sel_;                    // the turntable soldier (persistent: cross-fades between clips)
    bool seq_ = false;               // transition demo sequence
    float seqT_ = 0.f;
    int seqIdx_ = 0;
    float frustum_[6][4];
    V3 eye_{};

    // scene
    std::vector<Soldier> lineup_, stress_;
    std::vector<Drop> drops_;
    std::vector<Fx> fx_;
    struct Flash { V3 p; float life; float radius; };
    std::vector<Flash> flashes_;
    int mgRound_ = 0;

    // UI state
    int selKind_ = 0, selIndex_ = 0;             // 0 infantry, 1 prop
    bool turntable_ = false;
    float turnAngle_ = 0.f;
    bool showLineup_ = true, showGrid_ = true, showProps_ = true, showVehicles_ = true, showRuler_ = true, showDrops_ = true;
    bool lineupZombies_ = true, fxOn_ = true, labShadows_ = true;
    int clip_ = 1;
    bool playing_ = true, loop_ = true;
    float animSpeed_ = 1.f, animTime_ = 0.f;
    bool lineupAnimated_ = false;
    bool holdFx_ = false;                        // freeze FX ages (inspection)
    std::string lastView_ = "closeup";
    bool shadowsDirty_ = true;
    int stressN_ = 0;

    // stats / bench
    struct Stats { uint32_t soldiers = 0, visible = 0, instances = 0, draws = 0, fx = 0, lod[3] = {0, 0, 0}; uint64_t tris = 0; double cpuMs = 0; uint64_t upload = 0; } st_;
    struct BenchRow { int n; double frameAvg, frameP95, cpuAvg; uint32_t visible, instances, draws, fx; uint64_t tris, upload; double gpuMB; };
    std::vector<BenchRow> bench_;
    int benchPreset_ = -1, benchFrame_ = 0;
    std::vector<double> benchFrames_, benchCpu_;
    uint64_t lastCounter_ = 0;
};

} // namespace ttz
