#pragma once
#include "assets/Model.h"
#include "debug/Profiler.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "render/Renderer.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"
#include "sim/SimParams.h"

#include <array>
#include <string>
#include <vector>

namespace ttz {

struct AppOptions {
    int traceEvery = 0;           // headless: log stats every N frames
    bool headless = false;
    int width = 1600, height = 900;
    std::string screenshot;       // save a PNG after `frames` frames, then exit
    int frames = -1;              // run this many frames then exit (-1 = interactive)
    int scenario = 0;
    int count = -1;               // initial zombie count (-1 = scenario default)
    std::string config = "config/sim.cfg";
    bool vsync = true;
    bool gpuDebug = false;
    float camYaw = 0.75f, camPitch = 0.75f, camDist = 70.f;
    float camX = -40.f, camZ = 0.f, camY = 0.f;
    bool camSet = false;
    std::vector<std::array<float, 3>> scriptedBlasts;   // (frame, x, z)
    uint32_t debugFlags = 0;
    int characterModel = 1;        // --chars placeholder|modular
    CharacterSettings charSettings;
    bool studio = false, noGround = false, freeCam = false;
    float fovDeg = 0.f;
    int showcase = -1;             // --showcase N: character validation scenes (see App::loadShowcase)
};

enum class Tool : int { Explosion = 0, SetGoal = 1, Spawn = 2 };

struct AppState {
    GpuContext gpu;
    SDL_Window* window = nullptr;
    Sandbox sandbox;
    std::vector<float> staticHeights;   // CPU copy for camera obstacle avoidance
    SimParams params;
    CrowdSim sim;
    Renderer renderer;
    CharacterRenderer chars;
    Camera camera;
    float trauma = 0.f;            // screen shake energy (explosions), decays over ~1 s
    bool screenShake = true;
    Model zombieModel;
    RenderSettings renderSettings;
    AppOptions opt;

    bool paused = false, showUI = true, quit = false;
    float simSpeed = 1.0f;
    double simAccumulator = 0.0;
    double renderTime = 0.0;
    int scenario = 0;
    int spawnCount = 1000;
    Tool tool = Tool::Explosion;
    bool resetRequested = false, paramsDirty = false;
    int showcaseRequested = -1;

    // profiling
    RunningStat cpuFrame, cpuSim, cpuRender, cpuUI, frameTotal;
    FrameHistory history;
    int stepsLastFrame = 0;
    uint64_t droppedSimTime = 0;
    uint64_t frameIndex = 0;
};

class App {
public:
    int run(const AppOptions& opt);
private:
    bool init();
    void shutdown();
    void loadScenario(int index, int count);
    void loadShowcase(int which);
    void handleEvent(const SDL_Event& e);
    void frame(double dt);
    AppState s_;
    bool mmbDown_ = false, altDrag_ = false;
    float rotDx_ = 0, rotDy_ = 0, wheel_ = 0;
};

} // namespace ttz
