#pragma once
#include "assets/Model.h"
#include "city/CityAsset.h"
#include "city/CityRenderer.h"
#include "city/CitySimWindow.h"
#include "city/CityVehicles.h"
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
namespace game { class GameWorld; }

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
    std::vector<std::array<float, 4>> scriptedBlasts;   // (frame, x, z, effect scale)
    uint32_t debugFlags = 0;
    int characterModel = 1;        // --chars placeholder|modular
    CharacterSettings charSettings;
    bool studio = false, noGround = false, freeCam = false;
    float fovDeg = 0.f;
    int showcase = -1;             // --showcase N: character validation scenes (see App::loadShowcase)
    // baked city (--map city)
    bool cityMap = false;
    std::string cityDir = "assets/city/seed1";
    int cityWindow = 512;          // simulation window, cells per side (0.75 m)
    float cityAtX = 1e9f, cityAtZ = 1e9f;   // window centre (default: spawn nearest the map centre)
    int cityBench = 0;             // > 0: headless city benchmark of N frames (camera flies a scripted path)
    bool cityFollow = true;        // the simulation window follows the camera pivot (CitySimWindow)
    float panX = 0, panZ = 0, panSpeed = 0;   // --city-pan X Z SPEED: scripted pivot pan towards (X, Z) from frame panStart
    int panStart = 60;
    std::vector<int> shotFrames;   // --shots F1,F2,..: PNGs <shotDir>/fNNNNN.png at these frames
    std::string shotDir = ".";
    int shotsOnMove = -1;          // >= 0: screenshot the frame before each window move and K frames after it
    int panSpawnEvery = 0;         // scripted pan: every N frames spawn 300 zombies and blast near the pivot
    int cityVerify = 0;            // > 0: every N frames a synchronous check of the horde against the window (test only)
    // time of day (TimeOfDay.h): --time H (0..24, start clock), --tod-speed X (cycle rate multiplier, 0 = frozen),
    // --tod-paused, --day-cycle MIN (real minutes per 24 h, default 30). Default start: 16:30 (late afternoon).
    float todHours = -1.f, todSpeed = 1.f, dayCycleMinutes = 30.f;
    bool todPaused = false;
    bool noDof = false;            // --no-dof: miniature depth of field off (comparison shots)
    int shadowMode = 1;            // --shadows 0 off | 1 key-light shadow map | 2 legacy moon height field
    std::string lab;               // --lab military: Military Asset Lab (src/lab/MilitaryLab.h)
    std::vector<std::string> labViews;   // --lab-views v1,v2,..: lab camera preset per --shots frame (headless review captures)
    std::vector<int> labStress;    // --lab-stress 10,50,..: soldier presets (headless: benchmark table, then exit)
    int labBenchFrames = 300;      // --bench-frames with --lab-stress: measured frames per preset
    int labZombies = 2000;         // --lab-zombies: zombie horde alongside the stress soldiers
    // --spam-blasts RATE SECONDS X Z: scripted click spam (RATE blasts / s for SECONDS from frame spamStart, scattered
    // +-spamSpread m around (X, Z); X = nan: the densest vehicle cluster near the window centre). Prints a per-subsystem
    // timing table at exit (--perf-report: the same table without spam; --perf-split: GPU sim / render measured apart).
    float spamRate = 0, spamSeconds = 0, spamX = 0, spamZ = 0, spamSpread = 10.f;
    int spamStart = 120;
    bool perfReport = false, perfSplit = false;
    // --perf-off fx,particles,gibs,lights,shadows,dof (comma list: switch those off), --fx-full-res (legacy full-res
    // fx volumes), --render-scale X (3D resolution x window pixels), --perf-hud (on-screen frame / pass timings)
    std::string perfOff;
    bool fxFullRes = false, perfHud = false;
    float renderScale = 1.f;
    std::string perfCsv;
    // --game: gameplay mode on the baked city (src/game/GameWorld.h; docs/GAMEPLAY_ARCHITECTURE.md)
    bool game = false;
    std::string gameScript;        // --game-script FILE: headless scenario (exit code = failed expectations)
    bool gameSync = false;         // --game-sync: wait for each horde readback (deterministic tests)
    bool gameDemoRender = false;   // --game-demo-render: static soldiers playing clips through GameRender (screenshots)
    std::string balance = "config/balance.json";   // --balance FILE
};

enum class Tool : int { Explosion = 0, SetGoal = 1, Spawn = 2 };

struct AppState {
    GpuContext gpu;
    SDL_Window* window = nullptr;
    Sandbox sandbox;
    std::vector<float> staticHeights;   // CPU copy for camera obstacle avoidance
    CityAsset city;
    CityRenderer cityRenderer;
    CitySimWindow simWindow;
    CityVehicles vehicles;             // dynamic vehicles (blasts, wrecks, chain reactions)
    Sandbox cityHome;                  // the initial window (scenario reset)
    bool cityMode = false, debugCam = false;
    std::vector<double> benchFrameMs, benchUploadMs;
    CityRenderStats benchMax;
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
    class MilitaryLab* lab = nullptr;   // --lab military
    game::GameWorld* game = nullptr;   // --game
    int exitCode = 0;

    // on-screen perf readout (F3, debug panel "Performance"): last frame / 1 s averages in ms
    struct PerfHud { float frame = 0, veh = 0, simRec = 0, renderRec = 0, ui = 0, acquire = 0, submitWait = 0; };
    PerfHud hud, hudAvg, hudMax;
    int hudFrames = 0;
    PerfHud hudAcc, hudAccMax;
    double hudT0 = 0;
    bool perfHud = false;
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
    bool initCity();
    bool headlessImGui_ = false;   // --game headless: ImGui context for HUD screenshots
    void applyCameraRig();
    void cityBenchStep();
    void printCityBench();
    void cityVerify(const char* why);
    int moves_ = 0;
    // --spam-blasts / --perf-report
    struct PerfRow {
        float frame, vehTotal, vehBlast, vehFuse, vehIntegrate, vehGrid, simRec, gpuSim, renderRec, gpuRender;
        uint32_t vehActive, uploadBytes, fxVolumes, particles, gibs, blasts, explosions;
    };
    std::vector<PerfRow> perf_;
    float spamAcc_ = 0.f;
    uint32_t spamRng_ = 12345u, spamCount_ = 0;
    void spamStep(double dt);
    void printPerf();
    std::vector<std::pair<uint64_t, int>> postShots_;
    bool mmbDown_ = false, altDrag_ = false, rmbDown_ = false;
    float rotDx_ = 0, rotDy_ = 0, wheel_ = 0, panDx_ = 0, panDy_ = 0;
};

} // namespace ttz
