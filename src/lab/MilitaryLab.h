#pragma once
// Military Asset Lab (`ttz --lab military`): an in-engine review diorama for the military assets. No gameplay.
//
// Scene: a street patch of the baked city (same renderer, night tone, moon shadows, street lamps, tilt-shift, fog),
// its parked civilian vehicles, a lineup of approved zombies (real simulation agents, the unchanged zombie path),
// the military infantry (the zombie body standard posed by shaders/mil_pose.comp with the SAME joint hierarchy and
// clips, attachments parented to body slots) and props (voxel meshes drawn with the city material / lighting path).
// UI: asset browser, turntable, view / lighting presets, comparison toggles, animation scaffold (clip list,
// play / pause / loop / speed / scrub), parachute supply-drop timeline, muzzle flash / tracer / suppressed-shot stubs.
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
    void setupScene(AppState& s);     // simulation reset: zombie lineup (no goals: they stand)
    void update(AppState& s, float dt);
    void injectLights(std::vector<PointLight>& lights) const;   // muzzle flash light
    void prepare(SDL_GPUCommandBuffer* cmd);
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH);
    void drawUI(AppState& s);
    bool applyView(AppState& s, const std::string& name);   // closeup, front, rear, side, top, lineup, rts110, rts300, props, parachute

private:
    struct Placed { int model; float x, y, z, yaw; };
    V3 world(float lx, float lz, float y = 0.f) const;
    float worldYaw(float localYaw) const { return frameYaw_ + localYaw; }
    void findSpot(AppState& s);
    void select(AppState& s, int kind, int index);

    AppState* app_ = nullptr;
    MilitaryLibrary lib_;
    GpuContext* gpu_ = nullptr;
    CityRenderer* city_ = nullptr;
    class CharacterRenderer* chars_ = nullptr;
    const class CrowdSim* sim_ = nullptr;
    SDL_GPUComputePipeline* pPose_ = nullptr;
    SDL_GPUBuffer *poseBuf_ = nullptr, *segs_ = nullptr, *insts_ = nullptr, *mats_ = nullptr;
    SDL_GPUTransferBuffer* instTB_ = nullptr;
    std::vector<CityRenderer::GpuMesh> meshes_;
    float bodyVoxel_ = 1.7f / 18.f;

    // lab frame: world = origin + rotY(frameYaw) * local
    float ox_ = 0, oz_ = 0, oy_ = 0, frameYaw_ = 0;
    bool spotFound_ = false;

    // per-frame lists
    std::vector<uint8_t> poseU_;                 // MilPose uniform block (shaders/mil_pose.comp)
    uint32_t charCount_ = 0, attCount_ = 0;
    std::vector<CityRenderer::GpuInstance> cpuInst_;
    std::vector<CityRenderer::ExtDraw> attDraws_, milDraws_, vehDraws_;
    uint32_t vehFirst_ = 0;

    // UI state
    int selKind_ = 0, selIndex_ = 0;             // 0 infantry, 1 prop
    bool turntable_ = false;
    float turnAngle_ = 0.f;
    bool showLineup_ = true, showGrid_ = true, showProps_ = true, showVehicles_ = true, showRuler_ = true;
    bool lineupZombies_ = true;
    int clip_ = 1;
    bool playing_ = true, loop_ = true;
    float animSpeed_ = 1.f, animTime_ = 0.f;
    bool lineupAnimated_ = false;                // lineup infantry play the selected clip too
    // parachute supply drop demo: descent -> landing -> collapse
    bool chutePlaying_ = true;
    float chuteTime_ = 0.f;
    static constexpr float kChuteDrop = 6.f, kChuteLand = 0.6f, kChuteCollapse = 2.4f, kChuteHold = 2.f;
    // FX stubs
    float flashTimer_ = 0.f;
    bool holdFlash_ = false, suppressed_ = false;
    struct Tracer { V3 p, d; float age; };
    std::vector<Tracer> tracers_;
    bool holdTracer_ = false;
    std::string lastView_ = "closeup";
    int pendingView_ = -1;
    V3 muzzleWorld_{};
};

} // namespace ttz
