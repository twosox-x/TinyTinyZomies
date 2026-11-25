#include "app/App.h"

#include "debug/DebugUI.h"
#include "imgui.h"
#include "imgui_impl_sdl3.h"
#include "imgui_impl_sdlgpu3.h"
#include "sim/Look.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz {

static std::string dataPath(const std::string& rel) {
    SDL_PathInfo info;
    if (!rel.empty() && (rel[0] == '/' || rel[0] == '\\' || (rel.size() > 1 && rel[1] == ':'))) return rel;   // absolute
    if (SDL_GetPathInfo(rel.c_str(), &info)) return rel;                                                   // relative to cwd
    const char* base = SDL_GetBasePath();
    std::string p = std::string(base ? base : "") + rel;
    if (SDL_GetPathInfo(p.c_str(), &info)) return p;
#ifdef TTZ_SOURCE_DIR
    std::string q = std::string(TTZ_SOURCE_DIR) + "/" + rel;
    if (SDL_GetPathInfo(q.c_str(), &info)) return q;
#endif
    return rel;
}

bool App::init() {
    AppOptions& o = s_.opt;
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen");
        if (!SDL_Init(SDL_INIT_VIDEO)) {
            SDL_Log("SDL_Init failed: %s", SDL_GetError());
            return false;
        }
        o.headless = true;
    }
    if (!o.headless) {
        s_.window = SDL_CreateWindow("Tiny Tiny Zombies - engine prototype", o.width, o.height,
                                     SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY);
        if (!s_.window) {
            SDL_Log("SDL_CreateWindow failed: %s (falling back to headless)", SDL_GetError());
            o.headless = true;
        }
    }
    if (!s_.gpu.init(s_.window, o.gpuDebug)) return false;
    if (s_.window)
        SDL_SetGPUSwapchainParameters(s_.gpu.device(), s_.window, SDL_GPU_SWAPCHAINCOMPOSITION_SDR,
                                      o.vsync ? SDL_GPU_PRESENTMODE_VSYNC : SDL_GPU_PRESENTMODE_IMMEDIATE);

    std::string cfg = dataPath(o.config);
    s_.opt.config = cfg;
    s_.params.load(cfg);
    s_.sandbox.build(s_.params.cellSize, s_.params.gridW, s_.params.gridH);
    if (!s_.zombieModel.load(dataPath("assets/models/zombie.glb"), s_.params.standHeight)) return false;
    if (!s_.sim.init(s_.gpu, s_.params, s_.sandbox)) return false;
    SDL_GPUTextureFormat swapFmt = s_.window ? SDL_GetGPUSwapchainTextureFormat(s_.gpu.device(), s_.window)
                                             : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    if (!s_.renderer.init(s_.gpu, s_.zombieModel, s_.sandbox, s_.params, swapFmt)) return false;
    if (!s_.chars.init(s_.gpu, s_.params, dataPath("assets/characters/zombie_parts.ttzc"), (uint32_t)s_.params.visibleCharacterCapacity)) return false;
    s_.sim.setExtraReadback(s_.chars.counters(), 48 * 4);
    s_.chars.setOccluders(s_.sandbox.occluders());
    s_.renderSettings.debugFlags = o.debugFlags;
    s_.renderSettings.characterModel = o.characterModel;
    s_.renderSettings.chars = o.charSettings;
    s_.renderSettings.studioLighting = o.studio;
    s_.renderSettings.drawGround = !o.noGround;
    if (o.studio) { s_.renderSettings.drawBoxes = !o.noGround; s_.renderSettings.fogDensity = 0.f; }
    if (o.freeCam) { s_.camera.settings.minDistance = 1.0f; s_.camera.settings.minPitch = -0.3f; }
    if (o.fovDeg > 0) s_.camera.settings.fovY = o.fovDeg * 3.14159265f / 180.f;

    if (s_.window) {
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGui::GetIO().IniFilename = nullptr;
        ImGui::StyleColorsDark();
        float scale = SDL_GetWindowDisplayScale(s_.window);
        ImGui::GetStyle().ScaleAllSizes(scale);
        ImGui::GetIO().FontGlobalScale = scale;
        ImGui_ImplSDL3_InitForSDLGPU(s_.window);
        ImGui_ImplSDLGPU3_InitInfo ii{};
        ii.Device = s_.gpu.device();
        ii.ColorTargetFormat = swapFmt;
        ii.MSAASamples = SDL_GPU_SAMPLECOUNT_1;
        ImGui_ImplSDLGPU3_Init(&ii);
    }
    s_.scenario = std::clamp(o.scenario, 0, (int)s_.sandbox.scenarios.size() - 1);
    if (o.showcase >= 0) loadShowcase(o.showcase);
    else loadScenario(s_.scenario, o.count);
    if (o.camSet) s_.camera.setImmediate({o.camX, o.camY, o.camZ}, o.camYaw, o.camPitch, o.camDist);
    return true;
}

void App::loadScenario(int index, int count) {
    Scenario sc = s_.sandbox.scenarios[index];
    if (sc.map != s_.sandbox.map) {
        SDL_WaitForGPUIdle(s_.gpu.device());
        s_.sandbox.build(s_.params.cellSize, s_.params.gridW, s_.params.gridH, sc.map);
        s_.renderer.setSandbox(s_.sandbox);
        s_.chars.setOccluders(s_.sandbox.occluders());
    }
    s_.staticHeights = s_.sandbox.rasterize();
    s_.sim.reset(s_.sandbox);
    s_.sim.setGoals(sc.goals);
    int n = count > 0 ? count : sc.defaultCount;
    s_.spawnCount = n;
    int per = n / (int)sc.spawns.size();
    for (const Rect& r : sc.spawns) s_.sim.requestSpawn(r, (uint32_t)per);
    const Rect& r = sc.spawns[0];
    s_.camera.setImmediate({(r.minX + r.maxX) * 0.5f + 15.f, 0, (r.minZ + r.maxZ) * 0.5f}, 0.9f, 0.8f, 75.f);
    (void)r;
    s_.simAccumulator = 0;
}

// Character validation scenes (open arena, no destination: zombies stand where they are placed).
//  0: Zombie Lab lineup (Office Drone, Street Walker, Rotter; Lab spacing of 14 voxels)
//  1: the same three as settled corpses
//  2: 8 x 6 grid of randomly generated zombies
//  3: large randomised crowd (2000) for gameplay-distance views
void App::loadShowcase(int which) {
    AppState& s = s_;
    if (s.sandbox.map != MapKind::Arena) {
        SDL_WaitForGPUIdle(s.gpu.device());
        s.sandbox.build(s.params.cellSize, s.params.gridW, s.params.gridH, MapKind::Arena);
        s.renderer.setSandbox(s.sandbox);
        s.chars.setOccluders(s.sandbox.occluders());
    }
    s.staticHeights = s.sandbox.rasterize();
    s.sim.reset(s.sandbox);
    s.sim.setGoals({});
    const float cx = -60.f, cz = 0.f, spacing = 14.f * s.chars.metresPerVoxel();
    if (which >= 10 && which <= 12) {                   // single Lab design at the origin of the scene
        LookSpec l = which == 10 ? labOfficeDrone() : which == 11 ? labStreetWalker() : labRotter();
        uint32_t x, y;
        encodeLook(l, x, y);
        s.sim.requestSpawnLook({cx - 0.001f, cz - 0.001f, cx + 0.001f, cz + 0.001f}, 1, x, y);
    } else if (which == 0 || which == 1) {
        LookSpec looks[3] = {labOfficeDrone(), labStreetWalker(), labRotter()};
        for (int i = 0; i < 3; ++i) {
            uint32_t x, y;
            encodeLook(looks[i], x, y);
            float px = cx + (i - 1) * spacing;
            s.sim.requestSpawnLook({px - 0.001f, cz - 0.001f, px + 0.001f, cz + 0.001f}, 1, x, y, which == 1);
        }
    } else if (which == 2) {
        for (int r = 0; r < 6; ++r) s.sim.requestSpawn({cx - 7.f, cz - 5.f + r * 2.f, cx + 7.f, cz - 4.9f + r * 2.f}, 8);
    } else {
        s.sim.requestSpawn({cx - 30.f, cz - 30.f, cx + 30.f, cz + 30.f}, 2000);
    }
    s.camera.setImmediate({cx, 0.85f, cz}, 0.55f, 0.35f, 6.f);
    s.simAccumulator = 0;
}

void App::handleEvent(const SDL_Event& e) {
    if (s_.window) ImGui_ImplSDL3_ProcessEvent(&e);
    bool uiMouse = s_.window && ImGui::GetIO().WantCaptureMouse;
    bool uiKeys = s_.window && ImGui::GetIO().WantCaptureKeyboard;
    switch (e.type) {
    case SDL_EVENT_QUIT: s_.quit = true; break;
    case SDL_EVENT_KEY_DOWN:
        if (uiKeys) break;
        switch (e.key.key) {
        case SDLK_ESCAPE: s_.quit = true; break;
        case SDLK_SPACE: s_.paused = !s_.paused; break;
        case SDLK_R: s_.resetRequested = true; break;
        case SDLK_F1: s_.showUI = !s_.showUI; break;
        case SDLK_1: s_.tool = Tool::Explosion; break;
        case SDLK_2: s_.tool = Tool::SetGoal; break;
        case SDLK_3: s_.tool = Tool::Spawn; break;
        case SDLK_V: s_.renderSettings.debugFlags ^= 1u; break;
        case SDLK_F: s_.renderSettings.debugFlags ^= 2u; break;
        case SDLK_G: s_.renderSettings.debugFlags ^= 4u; break;
        case SDLK_EQUALS: s_.simSpeed = std::min(4.f, s_.simSpeed * 1.25f); break;
        case SDLK_MINUS: s_.simSpeed = std::max(0.05f, s_.simSpeed / 1.25f); break;
        case SDLK_F12: {
            char name[64];
            std::snprintf(name, sizeof(name), "screenshot_%llu.png", (unsigned long long)s_.frameIndex);
            s_.renderer.saveScreenshot(name);
            break;
        }
        default: break;
        }
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        if (!uiMouse) wheel_ += e.wheel.y;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        if (uiMouse) break;
        if (e.button.button == SDL_BUTTON_MIDDLE) mmbDown_ = true;
        if (e.button.button == SDL_BUTTON_LEFT && (SDL_GetModState() & SDL_KMOD_ALT)) altDrag_ = true;
        else if (e.button.button == SDL_BUTTON_LEFT) {
            int w, h;
            SDL_GetWindowSize(s_.window, &w, &h);
            V3 hit;
            if (s_.camera.screenToGround(e.button.x, e.button.y, (float)w, (float)h, 0.f, hit)) {
                if (s_.tool == Tool::Explosion) {
                    s_.sim.requestExplosion(hit.x, 0.4f, hit.z);
                    s_.renderer.addBlast(hit.x, 0.4f, hit.z);
                } else if (s_.tool == Tool::SetGoal) {
                    s_.sim.setGoals({hit.x, hit.z});
                } else {
                    s_.sim.requestSpawn({hit.x - 4.f, hit.z - 4.f, hit.x + 4.f, hit.z + 4.f}, 500);
                }
            }
        }
        break;
    case SDL_EVENT_MOUSE_BUTTON_UP:
        if (e.button.button == SDL_BUTTON_MIDDLE) mmbDown_ = false;
        if (e.button.button == SDL_BUTTON_LEFT) altDrag_ = false;
        break;
    case SDL_EVENT_MOUSE_MOTION:
        if (mmbDown_ || altDrag_) {
            rotDx_ += e.motion.xrel;
            rotDy_ += e.motion.yrel;
        }
        break;
    default: break;
    }
}

void App::frame(double dt) {
    double t0 = nowMs();
    AppState& s = s_;
    if (s.resetRequested) {
        SDL_WaitForGPUIdle(s.gpu.device());
        loadScenario(s.scenario, s.spawnCount);
        s.resetRequested = false;
    }
    if (s.showcaseRequested >= 0) {
        SDL_WaitForGPUIdle(s.gpu.device());
        loadShowcase(s.showcaseRequested);
        s.showcaseRequested = -1;
    }
    // camera input
    const bool* keys = SDL_GetKeyboardState(nullptr);
    bool uiKeys = s.window && ImGui::GetIO().WantCaptureKeyboard;
    float mx = 0, mz = 0, turn = 0;
    if (!uiKeys) {
        mx = (keys[SDL_SCANCODE_D] || keys[SDL_SCANCODE_RIGHT]) - (float)(keys[SDL_SCANCODE_A] || keys[SDL_SCANCODE_LEFT]);
        mz = (keys[SDL_SCANCODE_W] || keys[SDL_SCANCODE_UP]) - (float)(keys[SDL_SCANCODE_S] || keys[SDL_SCANCODE_DOWN]);
        turn = (float)keys[SDL_SCANCODE_E] - (float)keys[SDL_SCANCODE_Q];
    }
    float boost = (keys[SDL_SCANCODE_LSHIFT] || keys[SDL_SCANCODE_RSHIFT]) ? 2.5f : 1.f;
    s.camera.update((float)dt, mx, mz, wheel_, rotDx_ + turn * 300.f * (float)dt, rotDy_, boost);
    float halfX = 0.5f * s.params.gridW * s.params.cellSize, halfZ = 0.5f * s.params.gridH * s.params.cellSize;
    s.camera.clampTarget(-halfX, -halfZ, halfX, halfZ);
    s.camera.avoidObstacles([&](float x, float z) {
        const Sandbox& sb = s.sandbox;
        int cx = (int)std::floor((x - sb.originX) / sb.cellSize), cz = (int)std::floor((z - sb.originZ) / sb.cellSize);
        if (cx < 0 || cz < 0 || cx >= sb.gridW || cz >= sb.gridH) return 0.f;
        return s.staticHeights[(size_t)cz * sb.gridW + cx];
    });
    wheel_ = rotDx_ = rotDy_ = 0;

    // scripted blasts (for reproducible demo footage / screenshots)
    for (auto& b : s.opt.scriptedBlasts)
        if ((uint64_t)b[0] == s.frameIndex) {
            s.sim.requestExplosion(b[1], 0.4f, b[2]);
            s.renderer.addBlast(b[1], 0.4f, b[2]);
        }

    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(s.gpu.device());
    // fixed-timestep simulation, decoupled from rendering
    double t1 = nowMs();
    int steps = 0;
    if (!s.paused) {
        s.simAccumulator += dt * s.simSpeed;
        const double fdt = s.sim.params().fixedDt;
        while (s.simAccumulator >= fdt && steps < s.sim.params().maxStepsPerFrame) {
            s.sim.step(cmd);
            s.simAccumulator -= fdt;
            ++steps;
        }
        if (s.simAccumulator > fdt) {   // cannot keep up: drop time instead of spiralling
            s.droppedSimTime++;
            s.simAccumulator = 0;
        }
    }
    s.stepsLastFrame = steps;
    s.sim.writeDrawArgs(cmd, s.renderer.zombieIndexCount());
    s.sim.recordStatsReadback(cmd);
    s.cpuSim.add(nowMs() - t1);

    double t2 = nowMs();
    s.renderer.update((float)dt);
    SDL_GPUTexture* swap = nullptr;
    uint32_t w = (uint32_t)s.opt.width, h = (uint32_t)s.opt.height;
    if (s.window && !SDL_WaitAndAcquireGPUSwapchainTexture(cmd, s.window, &swap, &w, &h)) swap = nullptr;
    if (!s.window || swap) {
        s.renderTime += dt;
        s.renderer.render(cmd, swap, w, h, s.camera, s.sim, s.renderTime, s.renderSettings, &s.chars);
    }
    s.cpuRender.add(nowMs() - t2);

    double t3 = nowMs();
    if (s.window) {
        ImGui_ImplSDLGPU3_NewFrame();
        ImGui_ImplSDL3_NewFrame();
        ImGui::NewFrame();
        if (s.showUI) drawDebugUI(s);
        ImGui::Render();
        ImDrawData* dd = ImGui::GetDrawData();
        if (swap && dd->DisplaySize.x > 0) {
            ImGui_ImplSDLGPU3_PrepareDrawData(dd, cmd);
            SDL_GPUColorTargetInfo ct{};
            ct.texture = swap;
            ct.load_op = SDL_GPU_LOADOP_LOAD;
            ct.store_op = SDL_GPU_STOREOP_STORE;
            SDL_GPURenderPass* rp = SDL_BeginGPURenderPass(cmd, &ct, 1, nullptr);
            ImGui_ImplSDLGPU3_RenderDrawData(dd, cmd, rp);
            SDL_EndGPURenderPass(rp);
        }
    }
    s.cpuUI.add(nowMs() - t3);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    s.sim.onFrameSubmitted(fence);
    // Without a swapchain nothing paces the CPU: keep headless runs to one frame in flight.
    if (!s.window) SDL_WaitForGPUIdle(s.gpu.device());
    s.cpuFrame.add(nowMs() - t0);
    ++s.frameIndex;
}

int App::run(const AppOptions& opt) {
    s_.opt = opt;
    if (!init()) {
        shutdown();
        return 1;
    }
    double last = nowMs();
    while (!s_.quit) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) handleEvent(e);
        double now = nowMs();
        double dt = std::min((now - last) / 1000.0, 0.1);
        if (s_.opt.frames > 0) dt = 1.0 / 60.0;   // deterministic pacing for scripted runs
        last = now;
        s_.frameTotal.add(dt * 1000.0);
        s_.history.push((float)(dt * 1000.0));
        frame(dt);
        if (s_.opt.frames > 0 && (int)s_.frameIndex == s_.opt.frames / 2) SDL_Log("halfway: frame %d", (int)s_.frameIndex);
        if (s_.opt.frames > 0 && (int)s_.frameIndex >= s_.opt.frames) {
            SDL_WaitForGPUIdle(s_.gpu.device());
            if (!s_.opt.screenshot.empty()) s_.renderer.saveScreenshot(s_.opt.screenshot);
            const SimStats& st = s_.sim.stats();
            SDL_Log("finished %d frames: live=%u corpses=%u climbing=%u elevated=%u maxH=%.2f", s_.opt.frames, st.live,
                    st.corpses, st.climbing, st.elevated, st.maxStackHeight);
            break;
        }
    }
    shutdown();
    return 0;
}

void App::shutdown() {
    if (s_.gpu.device()) SDL_WaitForGPUIdle(s_.gpu.device());
    if (s_.window && ImGui::GetCurrentContext()) {
        ImGui_ImplSDLGPU3_Shutdown();
        ImGui_ImplSDL3_Shutdown();
        ImGui::DestroyContext();
    }
    s_.renderer.shutdown();
    s_.chars.shutdown();
    s_.sim.shutdown();
    s_.gpu.shutdown();
    if (s_.window) SDL_DestroyWindow(s_.window);
    SDL_Quit();
}

} // namespace ttz
