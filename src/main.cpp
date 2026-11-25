// Tiny Tiny Zombies - phase 1 engine prototype.
//   ttz                          interactive sandbox
//   ttz --scenario 2 --count 8000
//   ttz --headless --frames 600 --screenshot out.png [--cam x z yaw pitch dist] [--blast frame x z]
//   ttz --bench [--bench-counts 1000,5000,10000] [--bench-scenarios dispersed,siege] [--bench-csv file]
//   ttz --selftest               (same as the ttz_selftest executable)
#include "app/App.h"
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
    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
        if (!std::strcmp(a, "--headless")) o.headless = true;
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
            o.scriptedBlasts.push_back({f, x, z});
        } else if (!std::strcmp(a, "--bench")) bench = true;
        else if (!std::strcmp(a, "--bench-counts")) b.counts = parseInts(next());
        else if (!std::strcmp(a, "--bench-scenarios")) b.scenarios = parseStrs(next());
        else if (!std::strcmp(a, "--bench-csv")) b.csv = next();
        else if (!std::strcmp(a, "--bench-frames")) b.measureFrames = std::atoi(next());
        else if (!std::strcmp(a, "--bench-warmup")) b.warmupSiege = std::atoi(next());
        else if (!std::strcmp(a, "--selftest")) selftest = true;
        else { SDL_Log("unknown argument %s", a); return 2; }
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
