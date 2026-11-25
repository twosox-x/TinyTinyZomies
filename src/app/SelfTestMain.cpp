// Standalone headless test runner: ttz_selftest [--config path] [--dump dir]
#include "app/SelfTest.h"
#include <SDL3/SDL.h>
#include <cstring>

int main(int argc, char** argv) {
    const char* config = nullptr;
    const char* dump = nullptr;
    bool debug = false;
    for (int i = 1; i < argc; ++i) {
        if (!std::strcmp(argv[i], "--config") && i + 1 < argc) config = argv[++i];
        else if (!std::strcmp(argv[i], "--dump") && i + 1 < argc) dump = argv[++i];
        else if (!std::strcmp(argv[i], "--gpu-debug")) debug = true;
    }
    // SDL GPU needs the video subsystem; fall back to the offscreen driver when no display exists.
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen");
        if (!SDL_Init(SDL_INIT_VIDEO)) { SDL_Log("SDL_Init: %s", SDL_GetError()); return 2; }
    }
    ttz::SimParams params;
    if (config) params.load(config);
    ttz::GpuContext gpu;
    if (!gpu.init(nullptr, debug)) return 2;
    int rc = ttz::runSelfTest(gpu, params, dump);
    gpu.shutdown();
    SDL_Quit();
    return rc;
}
