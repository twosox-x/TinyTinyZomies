// Tiny Tiny Zombies - phase 1 engine prototype.
//   ttz                          interactive sandbox
//   ttz --scenario 2 --count 8000
//   ttz --headless --frames 600 --screenshot out.png [--cam x z yaw pitch dist] [--blast frame x z]
//   ttz --bench [--bench-counts 1000,5000,10000] [--bench-scenarios dispersed,siege,city,offscreen,corpses]
//               [--bench-configs placeholder,naive,culled,greedy,classes,final,final-posevs] [--bench-csv file]
//   ttz --selftest               (same as the ttz_selftest executable)
//   ttz --save-config path       write all simulation parameters with their defaults
#include "app/App.h"
#include "city/CityWorld.h"

#include <algorithm>
#include "app/Bench.h"
#include "app/SelfTest.h"

#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <cstdlib>
#include <cstring>
#include <sstream>

static std::vector<int> parseInts(const char* s) {
    std::vector<int> v;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) v.push_back(std::atoi(item.c_str()));
    return v;
}
static std::vector<std::string> parseStrs(const char* s) {
    std::vector<std::string> v;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) v.push_back(item);
    return v;
}

int main(int argc, char** argv) {
    ttz::AppOptions o;
    ttz::BenchOptions b;
    bool bench = false, selftest = false;
    float blastScale = 1.f;   // --blast-scale: effect scale of the following --blast options
    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
        if (!std::strcmp(a, "--headless")) o.headless = true;
        else if (!std::strcmp(a, "--trace")) o.traceEvery = std::atoi(next());
        else if (!std::strcmp(a, "--width")) o.width = b.width = std::atoi(next());
        else if (!std::strcmp(a, "--height")) o.height = b.height = std::atoi(next());
        else if (!std::strcmp(a, "--frames")) o.frames = std::atoi(next());
        else if (!std::strcmp(a, "--screenshot")) o.screenshot = next();
        else if (!std::strcmp(a, "--scenario")) o.scenario = std::atoi(next());
        else if (!std::strcmp(a, "--count")) o.count = std::atoi(next());
        else if (!std::strcmp(a, "--config")) o.config = b.config = next();
        else if (!std::strcmp(a, "--no-vsync")) o.vsync = false;
        else if (!std::strcmp(a, "--gpu-debug")) o.gpuDebug = b.gpuDebug = true;
        else if (!std::strcmp(a, "--debug-flags")) o.debugFlags = (uint32_t)std::atoi(next());
        else if (!std::strcmp(a, "--cam")) {
            o.camX = (float)std::atof(next()); o.camZ = (float)std::atof(next());
            o.camYaw = (float)std::atof(next()); o.camPitch = (float)std::atof(next()); o.camDist = (float)std::atof(next());
            o.camSet = true;
        } else if (!std::strcmp(a, "--blast")) {
            float f = (float)std::atof(next()), x = (float)std::atof(next()), z = (float)std::atof(next());
            o.scriptedBlasts.push_back({f, x, z, blastScale});
        } else if (!std::strcmp(a, "--blast-scale")) blastScale = (float)std::atof(next()); else if (!std::strcmp(a, "--chars")) o.characterModel = std::strcmp(next(), "placeholder") ? 1 : 0;
        else if (!std::strcmp(a, "--geom")) { const char* g = next(); o.charSettings.geometryLevel = !std::strcmp(g, "naive") ? 0 : !std::strcmp(g, "culled") ? 1 : !std::strcmp(g, "greedy") ? 2 : 3; }
        else if (!std::strcmp(a, "--classes")) o.charSettings.classMode = std::strcmp(next(), "family") ? 1 : 0;
        else if (!std::strcmp(a, "--no-cull")) o.charSettings.frustumCull = false;
        else if (!std::strcmp(a, "--pose-vs")) o.charSettings.poseInVertexShader = true;
        else if (!std::strcmp(a, "--no-occlusion")) o.charSettings.occlusionCull = false;
        else if (!std::strcmp(a, "--anim")) {
            const char* n = next();
            const char* names[] = {"auto", "idle", "walk", "reach", "climb", "flail", "dying", "corpse"};
            for (uint32_t k = 0; k < 8; ++k) if (!std::strcmp(n, names[k])) o.charSettings.forcedAnim = k;
        }
        else if (!std::strcmp(a, "--studio")) o.studio = true;
        else if (!std::strcmp(a, "--no-ground")) o.noGround = true;
        else if (!std::strcmp(a, "--free-cam")) o.freeCam = true;
        else if (!std::strcmp(a, "--cam-y")) o.camY = (float)std::atof(next());
        else if (!std::strcmp(a, "--fov")) o.fovDeg = (float)std::atof(next());
        else if (!std::strcmp(a, "--showcase")) o.showcase = std::atoi(next());
        else if (!std::strcmp(a, "--map")) o.cityMap = !std::strcmp(next(), "city");
        else if (!std::strcmp(a, "--city")) { o.cityMap = true; o.cityDir = next(); }
        else if (!std::strcmp(a, "--city-window")) o.cityWindow = std::atoi(next());
        else if (!std::strcmp(a, "--city-at")) { o.cityAtX = (float)std::atof(next()); o.cityAtZ = (float)std::atof(next()); }
        else if (!std::strcmp(a, "--city-synth")) { const char* d = next(); return ttz::writeSyntheticCity(d) ? 0 : 1; }
        else if (!std::strcmp(a, "--city-follow")) o.cityFollow = std::atoi(next()) != 0;
        else if (!std::strcmp(a, "--city-pan")) { o.panX = (float)std::atof(next()); o.panZ = (float)std::atof(next()); o.panSpeed = (float)std::atof(next()); }
        else if (!std::strcmp(a, "--city-pan-start")) o.panStart = std::atoi(next());
        else if (!std::strcmp(a, "--city-verify")) o.cityVerify = std::atoi(next());
        else if (!std::strcmp(a, "--shots")) { for (int v : parseInts(next())) o.shotFrames.push_back(v); }
        else if (!std::strcmp(a, "--shot-dir")) o.shotDir = next();
        else if (!std::strcmp(a, "--shots-on-move")) o.shotsOnMove = std::atoi(next());
        else if (!std::strcmp(a, "--city-pan-spawn")) o.panSpawnEvery = std::atoi(next());
        else if (!std::strcmp(a, "--bench")) bench = true;
        else if (!std::strcmp(a, "--bench-counts")) b.counts = parseInts(next());
        else if (!std::strcmp(a, "--bench-scenarios")) b.scenarios = parseStrs(next());
        else if (!std::strcmp(a, "--bench-csv")) b.csv = next();
        else if (!std::strcmp(a, "--bench-configs")) b.configs = parseStrs(next());
        else if (!std::strcmp(a, "--bench-frames")) b.measureFrames = std::atoi(next());
        else if (!std::strcmp(a, "--bench-warmup")) b.warmupSiege = std::atoi(next());
        else if (!std::strcmp(a, "--selftest")) selftest = true;
        else if (!std::strcmp(a, "--save-config")) { ttz::SimParams p; return p.save(next()) ? 0 : 1; }
        else { SDL_Log("unknown argument %s", a); return 2; }
    }
    // City map benchmark: the real game loop, headless, camera flying across the baked city (see App::cityBenchStep).
    if (bench && std::find(b.scenarios.begin(), b.scenarios.end(), "citymap") != b.scenarios.end()) {
        b.scenarios.erase(std::find(b.scenarios.begin(), b.scenarios.end(), "citymap"));
        o.cityMap = true;
        o.headless = true;
        o.vsync = false;
        o.width = b.width;
        o.height = b.height;
        o.cityBench = o.frames = o.frames > 0 ? o.frames : 600;
        int rc = ttz::App().run(o);
        if (rc || b.scenarios.empty()) return rc;
    }
    if (bench) return ttz::runBenchmarks(b);
    if (selftest) {
        if (!SDL_Init(SDL_INIT_VIDEO)) { SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen"); SDL_Init(SDL_INIT_VIDEO); }
        ttz::GpuContext gpu;
        if (!gpu.init(nullptr, o.gpuDebug)) return 2;
        ttz::SimParams p;
        int rc = ttz::runSelfTest(gpu, p, nullptr);
        gpu.shutdown();
        SDL_Quit();
        return rc;
    }
    ttz::App app;
    return app.run(o);
}
