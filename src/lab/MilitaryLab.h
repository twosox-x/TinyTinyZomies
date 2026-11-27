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
#include "lab/MilitaryRenderer.h"

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

    MilitaryRenderer& renderer() { return mil_; }

private:
    struct Soldier : MilPoseInput {   // the renderer's pose input + lab script state
        int script = -1;           // stress script state (-1: none)
        float stateLeft = 0;
        bool fxEvents = true;
        V3 home{};
        bool mover = false;                  // stress: walk / run along the street instead of in place
    };
    using Drop = MilDrop;              // parachute sequence (MilitaryRenderer)
    V3 world(float lx, float lz, float y = 0.f) const;
    float worldYaw(float localYaw) const { return frameYaw_ + localYaw; }
    void findSpot(AppState& s);
    void findRoof(AppState& s);
    void select(AppState& s, int kind, int index);
    void triggerFx(const std::string& type);                     // FX buttons (selected soldier)
    void placeDrops(AppState& s);
    void updateDrops(AppState& s, float dt);
    void setupStress(AppState& s, int n);
    void rebuildShadows(AppState& s);
    void benchStep(AppState& s);
    int clipByAction(const MilInfantry& inf, const char* action) const { return milClipByAction(inf, action); }

    AppState* app_ = nullptr;
    MilitaryRenderer mil_;
    const MilitaryLibrary& lib_ = mil_.library();
    GpuContext* gpu_ = nullptr;
    CityRenderer* city_ = nullptr;
    SDL_GPUBuffer* shadowBuf_ = nullptr;
    float bodyVoxel_ = 1.7f / 18.f;

    // lab frame: world = origin + rotY(frameYaw) * local
    float ox_ = 0, oz_ = 0, oy_ = 0, frameYaw_ = 0;
    bool spotFound_ = false;
    V3 roof_{};
    bool roofFound_ = false;

    bool dropsPlaced_ = false;
    Soldier sel_;                    // the turntable soldier (persistent: cross-fades between clips)
    bool seq_ = false;               // transition demo sequence
    float seqT_ = 0.f;
    int seqIdx_ = 0;

    // scene
    std::vector<Soldier> lineup_, stress_;
    std::vector<Drop> drops_;

    // UI state
    int selKind_ = 0, selIndex_ = 0;             // 0 infantry, 1 prop
    bool turntable_ = false;
    float turnAngle_ = 0.f;
    bool showLineup_ = true, showGrid_ = true, showProps_ = true, showVehicles_ = true, showRuler_ = true, showDrops_ = true;
    bool lineupZombies_ = true, labShadows_ = true;
    int clip_ = 1;
    bool playing_ = true, loop_ = true;
    float animSpeed_ = 1.f, animTime_ = 0.f;
    bool lineupAnimated_ = false;
    bool holdFx_ = false;                        // freeze FX ages (inspection)
    std::string lastView_ = "closeup";
    bool shadowsDirty_ = true;
    int stressN_ = 0;

    // stats / bench
    struct BenchRow { int n; double frameAvg, frameP95, cpuAvg; uint32_t visible, instances, draws, fx; uint64_t tris, upload; double gpuMB; };
    std::vector<BenchRow> bench_;
    int benchPreset_ = -1, benchFrame_ = 0;
    std::vector<double> benchFrames_, benchCpu_;
    uint64_t lastCounter_ = 0;
};

} // namespace ttz
