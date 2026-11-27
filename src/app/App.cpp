#include "app/App.h"

#include "city/CityWorld.h"
#include "debug/DebugUI.h"
#include "lab/MilitaryLab.h"
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
    if (o.lab == "military") { o.cityMap = true; o.cityFollow = false; }   // the lab diorama is a fixed patch of the city
    s_.sandbox.build(s_.params.cellSize, s_.params.gridW, s_.params.gridH);
    if (o.cityMap && !initCity()) return false;
    if (!s_.zombieModel.load(dataPath("assets/models/zombie.glb"), s_.params.standHeight)) return false;
    if (!s_.sim.init(s_.gpu, s_.params, s_.sandbox)) return false;
    SDL_GPUTextureFormat swapFmt = s_.window ? SDL_GetGPUSwapchainTextureFormat(s_.gpu.device(), s_.window)
                                             : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    if (!s_.renderer.init(s_.gpu, s_.zombieModel, s_.sandbox, s_.params, swapFmt)) return false;
    if (!s_.chars.init(s_.gpu, s_.params, dataPath("assets/characters/zombie_parts.ttzc"), (uint32_t)s_.params.visibleCharacterCapacity)) return false;
    s_.sim.setExtraReadback(s_.chars.counters(), 48 * 4);
    s_.chars.setOccluders(s_.sandbox.occluders());
    if (s_.cityMode) {
        if (!s_.cityRenderer.init(s_.gpu, s_.city, s_.renderer.msaaSamples() == 4 ? SDL_GPU_SAMPLECOUNT_4 : SDL_GPU_SAMPLECOUNT_1)) return false;
        s_.renderer.setCity(&s_.cityRenderer);
        s_.vehicles.init(s_.city.variants);
        s_.cityRenderer.setVehicles(&s_.vehicles);
        s_.cityHome = s_.sandbox;
        if (!s_.simWindow.init(s_.gpu, s_.city, s_.sandbox, s_.renderer)) return false;
        s_.simWindow.enabled = o.cityFollow;
    }
    applyCameraRig();
    s_.renderSettings.debugFlags = o.debugFlags;
    s_.renderSettings.characterModel = o.characterModel;
    s_.renderSettings.chars = o.charSettings;
    s_.renderSettings.studioLighting = o.studio;
    {   // time of day: city, lab and showcases start in the late afternoon (long warm shadows, dusk within ~3 min)
        TimeOfDaySettings& t = s_.renderSettings.tod;
        t.hours = o.todHours >= 0.f ? std::fmod(o.todHours, 24.f) : o.lab == "military" ? 15.0f : 16.5f;
        t.speed = o.todSpeed;
        t.paused = o.todPaused;
        t.cycleMinutes = std::max(0.1f, o.dayCycleMinutes);
    }
    if (o.noDof) s_.renderSettings.tiltShift = false;
    {   // perf toggles (attribute explosion cost on the target machine)
        RenderSettings& rs = s_.renderSettings;
        auto off = [&](const char* k) { return ("," + o.perfOff + ",").find(std::string(",") + k + ",") != std::string::npos; };
        if (off("fx")) rs.drawFxVolumes = false;
        if (off("particles")) rs.drawParticles = false;
        if (off("gibs")) rs.chars.drawGibs = false;
        if (off("lights")) rs.fireLights = false;
        if (off("shadows")) rs.shadowMap = false;
        if (off("dof")) rs.tiltShift = false;
        if (off("dofzoom")) rs.dofZoomAdapt = false;   // the fixed (pre zoom-adaptive) DOF at every zoom
        if (o.fxFullRes) rs.fxHalfRes = false;
        if (off("legacy")) { rs.perfLegacy = true; rs.chars.gibShadows = true; }   // A/B: the pre-budget explosion path
        rs.renderScale = std::clamp(o.renderScale, 0.25f, 1.f);
        s_.perfHud = o.perfHud;
    }
    s_.renderSettings.shadows = o.shadowMode != 0;
    s_.renderSettings.shadowMap = o.shadowMode != 2;
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
    // scripted headless captures: stream the visible tiles in before the first frame (benchmarks measure streaming)
    if (o.lab == "military") {
        s_.lab = new MilitaryLab();
        if (!s_.lab->init(s_)) { SDL_Log("military lab: init failed"); return false; }
    }
    if (s_.cityMode && o.headless && o.frames > 0 && o.cityBench == 0) s_.cityRenderer.flush(s_.camera, (float)o.width / (float)o.height);
    return true;
}

// Baked city: load the package, place the simulation window, size the sim grid to it.
bool App::initCity() {
    AppOptions& o = s_.opt;
    std::string dir = dataPath(o.cityDir);
    if (!s_.city.load(dir) && !o.lab.empty()) {   // lab fallback: a small synthetic street block in the baked format
        const char* pref = SDL_GetPrefPath("ttz", "military_lab");
        std::string syn = std::string(pref ? pref : "./") + "synthetic_city";
        SDL_Log("city: no baked package at %s; the lab uses a synthetic street block (%s)", dir.c_str(), syn.c_str());
        if (writeSyntheticCity(syn)) dir = syn;
    }
    if (!s_.city.loaded() && !s_.city.load(dir)) {
        SDL_Log("city: no baked package at %s (bake it: see tools/city_lab/bake/FORMAT.md, or run with --city-synth)", dir.c_str());
        return false;
    }
    float cx = 0.5f * (s_.city.x0 + s_.city.x1), cz = 0.5f * (s_.city.z0 + s_.city.z1);
    if (o.cityAtX < 1e8f) { cx = o.cityAtX; cz = o.cityAtZ; }
    else {   // spawn point nearest the map centre: the window sits on streets
        float best = 1e30f, bx = cx, bz = cz;
        for (const CitySpawn& sp : s_.city.spawns) {
            float d = (sp.x - cx) * (sp.x - cx) + (sp.z - cz) * (sp.z - cz);
            if (d < best) { best = d; bx = sp.x; bz = sp.z; }
        }
        cx = bx; cz = bz;
    }
    s_.params.gridW = s_.params.gridH = std::clamp(o.cityWindow, 64, 1024);
    if (!buildCityWindow(s_.city, cx, cz, s_.params.cellSize, s_.params.gridW, s_.params.gridH, s_.sandbox)) {
        SDL_Log("city: no collision tiles under the simulation window");
        return false;
    }
    s_.cityMode = true;
    return true;
}

// RTS rig (City Lab's: pivot on the ground, pitch 35-70 deg, distance 30-300 m) or the free debug camera (F2).
void App::applyCameraRig() {
    CameraSettings& c = s_.camera.settings;
    const float deg = 3.14159265f / 180.f;
    if (!s_.cityMode) return;
    if (s_.debugCam) { c.minDistance = 1.5f; c.maxDistance = 1800.f; c.minPitch = 0.05f; c.maxPitch = 89.f * deg; }
    else {   // min zoom 45 m: closer the voxel city and the crowd fall apart; damped pan / zoom / rotate (Camera::update)
        c.minDistance = 45.f; c.maxDistance = 300.f; c.minPitch = 35.f * deg; c.maxPitch = 70.f * deg;
        c.smoothing = 9.f; c.zoomSmoothing = 7.f; c.rotateSmoothing = 11.f;
    }
}

void App::loadScenario(int index, int count) {
    Scenario sc = s_.sandbox.scenarios[index];
    if (sc.map != s_.sandbox.map) {
        SDL_WaitForGPUIdle(s_.gpu.device());
        s_.sandbox.build(s_.params.cellSize, s_.params.gridW, s_.params.gridH, sc.map);
        s_.renderer.setSandbox(s_.sandbox);
        s_.chars.setOccluders(s_.sandbox.occluders());
    }
    if (s_.cityMode && s_.sandbox.map == MapKind::Baked && (s_.sandbox.originX != s_.cityHome.originX || s_.sandbox.originZ != s_.cityHome.originZ)) {
        SDL_WaitForGPUIdle(s_.gpu.device());   // the scenario's spawns and goal are in the initial window
        s_.sandbox = s_.cityHome;
        s_.simWindow.resetTo(s_.sandbox, s_.renderer);
    }
    s_.staticHeights = s_.sandbox.rasterize();
    s_.sim.reset(s_.sandbox);
    if (s_.cityMode && s_.sandbox.map == MapKind::Baked)   // vehicles keep their state; their obstacles go back in
        s_.vehicles.setWindow(s_.sandbox.originX, s_.sandbox.originZ, s_.sandbox.cellSize, s_.sandbox.gridW, s_.sandbox.gridH, s_.staticHeights);
    s_.sim.setGoals(sc.goals);
    int n = count > 0 ? count : sc.defaultCount;
    s_.spawnCount = n;
    int per = n / (int)sc.spawns.size();
    for (const Rect& r : sc.spawns) s_.sim.requestSpawn(r, (uint32_t)per);
    const Rect& r = sc.spawns[0];
    if (sc.map == MapKind::Baked && !sc.goals.empty()) s_.camera.setImmediate({sc.goals[0], 0, sc.goals[1]}, 0.9f, 0.9f, 110.f);
    else s_.camera.setImmediate({(r.minX + r.maxX) * 0.5f + 15.f, 0, (r.minZ + r.maxZ) * 0.5f}, 0.9f, 0.8f, 75.f);
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
        case SDLK_F3: s_.perfHud = !s_.perfHud; break;   // on-screen frame time + per-pass CPU timings
        case SDLK_F2: s_.debugCam = !s_.debugCam; applyCameraRig(); break;   // free debug camera (city RTS rig off)
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
        if (e.button.button == SDL_BUTTON_RIGHT) rmbDown_ = true;
        if (e.button.button == SDL_BUTTON_LEFT && (SDL_GetModState() & SDL_KMOD_ALT)) altDrag_ = true;
        else if (e.button.button == SDL_BUTTON_LEFT && !s_.lab) {   // the lab has no gameplay tools
            int w, h;
            SDL_GetWindowSize(s_.window, &w, &h);
            V3 hit;
            if (s_.camera.screenToGround(e.button.x, e.button.y, (float)w, (float)h, 0.f, hit)) {
                if (s_.tool == Tool::Explosion) {
                    s_.sim.requestExplosion(hit.x, 0.4f, hit.z);
                    s_.renderer.addBlast(hit.x, 0.4f, hit.z);
                    s_.trauma = std::min(1.0f, s_.trauma + 0.75f);
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
        if (e.button.button == SDL_BUTTON_RIGHT) rmbDown_ = false;
        if (e.button.button == SDL_BUTTON_LEFT) altDrag_ = false;
        break;
    case SDL_EVENT_MOUSE_MOTION:
        if (mmbDown_ || altDrag_) {
            rotDx_ += e.motion.xrel;
            rotDy_ += e.motion.yrel;
        }
        if (rmbDown_) { panDx_ += e.motion.xrel; panDy_ += e.motion.yrel; }   // right drag: pan (grab the ground)
        break;
    default: break;
    }
}

void App::frame(double dt) {
    double t0 = nowMs();
    AppState& s = s_;
    if (s.resetRequested && s.lab) { s.lab->setupScene(s); s.resetRequested = false; }
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
    if (s.cityMode && s.window && dt > 0) {
        // RTS panning: right-drag moves the ground with the cursor; the window edge pans (City Lab rig)
        float wx, wy;
        int ww, wh;
        SDL_GetMouseState(&wx, &wy);
        SDL_GetWindowSize(s.window, &ww, &wh);
        bool focus = (SDL_GetWindowFlags(s.window) & SDL_WINDOW_MOUSE_FOCUS) != 0 && !(ImGui::GetIO().WantCaptureMouse);
        const float edge = 6.f;
        if (focus && !rmbDown_ && !mmbDown_) {
            if (wx < edge) mx -= 1; else if (wx > ww - edge) mx += 1;
            if (wy < edge) mz += 1; else if (wy > wh - edge) mz -= 1;
        }
        // metres per pixel at the pivot ~ 2 * dist * tan(fov/2) / height; convert to the camera's per-second input
        float mpp = 2.f * s.camera.distance() * std::tan(s.camera.settings.fovY * 0.5f) / std::max(1, wh);
        float speed = s.camera.settings.moveSpeed * (s.camera.distance() / 80.f);
        mx -= panDx_ * mpp / (speed * (float)dt);
        mz += panDy_ * mpp / (speed * (float)dt) / std::sin(std::max(0.3f, s.camera.pitch()));
    }
    panDx_ = panDy_ = 0;
    if (s.opt.panSpeed > 0 && (int)s.frameIndex >= s.opt.panStart) {   // scripted pan (headless window-follow test)
        V3 p = s.camera.target();
        float dx = s.opt.panX - p.x, dz = s.opt.panZ - p.z, d = std::sqrt(dx * dx + dz * dz), stepM = s.opt.panSpeed * (float)dt;
        if (d > 1e-3f) s.camera.setImmediate({p.x + dx / d * std::min(d, stepM), p.y, p.z + dz / d * std::min(d, stepM)}, s.camera.yaw(),
                                             s.camera.pitch(), s.camera.distance());
    }
    if (s.opt.cityBench > 0) cityBenchStep();
    else s.camera.update((float)dt, mx, mz, wheel_, rotDx_ + turn * 300.f * (float)dt, rotDy_, boost);
    if (s.cityMode) {
        s.camera.softClampTarget(s.city.x0, s.city.z0, s.city.x1, s.city.z1, 40.f, (float)dt);
        if (!s.debugCam)
            s.camera.avoidObstacles([&](float x, float z) { return s.cityRenderer.heightAt(x, z); });
    } else {
        float halfX = 0.5f * s.params.gridW * s.params.cellSize, halfZ = 0.5f * s.params.gridH * s.params.cellSize;
        s.camera.clampTarget(-halfX, -halfZ, halfX, halfZ);
        s.camera.avoidObstacles([&](float x, float z) {
            const Sandbox& sb = s.sandbox;
            int cx = (int)std::floor((x - sb.originX) / sb.cellSize), cz = (int)std::floor((z - sb.originZ) / sb.cellSize);
            if (cx < 0 || cz < 0 || cx >= sb.gridW || cz >= sb.gridH) return 0.f;
            return s.staticHeights[(size_t)cz * sb.gridW + cx];
        });
    }
    wheel_ = rotDx_ = rotDy_ = 0;

    // scripted blasts (for reproducible demo footage / screenshots)
    for (auto& b : s.opt.scriptedBlasts)
        if ((uint64_t)b[0] == s.frameIndex) {
            s.sim.requestExplosion(b[1], 0.4f, b[2], b[3]);
            s.renderer.addBlast(b[1], 0.4f, b[2], b[3]);
            if (s.window) s.trauma = std::min(1.0f, s.trauma + 0.75f);   // no shake in headless captures
        }
    if (s.opt.spamRate > 0) spamStep(dt);
    // screen shake: offset ~ trauma^2, smooth pseudo-noise, scaled with zoom so it reads the same at any distance
    {
        float t = (float)s.renderTime, k = s.screenShake ? s.trauma * s.trauma : 0.f;
        float amp = k * (0.25f + 0.012f * s.camera.distance());
        s.camera.setShake({amp * (std::sin(t * 37.f) + 0.5f * std::sin(t * 61.f + 1.3f)),
                           amp * 0.7f * (std::sin(t * 43.f + 2.1f) + 0.5f * std::sin(t * 71.f)),
                           amp * (std::sin(t * 41.f + 4.2f) + 0.5f * std::sin(t * 67.f + 0.4f))});
        s.trauma = std::max(0.f, s.trauma - (float)dt * 1.4f);
    }

    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(s.gpu.device());
    // fixed-timestep simulation, decoupled from rendering
    double t1 = nowMs();
    int steps = 0;
    // the simulation window follows the camera pivot (heavy work on a worker; the move itself is GPU passes)
    bool moved = false;
    if (s.cityMode && !s.paused) {
        V3 p = s.camera.target();
        moved = s.simWindow.update(cmd, p.x, p.z, s.sim, s.renderer, s.sandbox);
        if (moved && s.opt.shotsOnMove >= 0) {   // test: the last frame rendered before the move
            char name[512];
            std::snprintf(name, sizeof(name), "%s/move%02d_pre_f%05d.png", s.opt.shotDir.c_str(), moves_, (int)s.frameIndex - 1);
            SDL_WaitForGPUIdle(s.gpu.device());
            s.renderer.saveScreenshot(name);
            postShots_.push_back({s.frameIndex + (uint64_t)s.opt.shotsOnMove, moves_});
        }
        moves_ += moved ? 1 : 0;
        if (moved) s.vehicles.setWindow(s.sandbox.originX, s.sandbox.originZ, s.sandbox.cellSize, s.sandbox.gridW, s.sandbox.gridH,
                                        s.sandbox.heightOverride);
    }
    if (s.opt.panSpawnEvery > 0 && s.opt.panSpeed > 0 && (int)s.frameIndex >= s.opt.panStart) {
        int k = ((int)s.frameIndex - s.opt.panStart) / s.opt.panSpawnEvery, r = ((int)s.frameIndex - s.opt.panStart) % s.opt.panSpawnEvery;
        V3 p = s.camera.target();
        float ax = p.x + 15.f * std::cos(k * 2.4f), az = p.z + 15.f * std::sin(k * 2.4f);
        if (r == 0) s.sim.requestSpawn({ax - 40.f, az - 40.f, ax + 40.f, az + 40.f}, 400);   // lands on the streets in the rect
        if (r == s.opt.panSpawnEvery / 2) { s.sim.requestExplosion(ax, 0.4f, az); s.renderer.addBlast(ax, 0.4f, az); }
    }
    const bool perf = s.opt.perfReport || s.opt.spamRate > 0;
    PerfRow pr{};
    double tv = nowMs();
    if (s.cityMode && !s.paused) {   // vehicles: blasts of this frame, rigid bodies, fuses -> new explosions, obstacle rows
        s.vehicles.update(cmd, (float)(dt * s.simSpeed), s.sim, [&](float x, float y, float z, float scale) {
            s.renderer.addBlast(x, y, z, scale);
            if (s.window) s.trauma = std::min(1.0f, s.trauma + 0.3f * scale);
        });
    }
    pr.vehTotal = (float)(nowMs() - tv);
    double ts = nowMs();
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
    pr.simRec = (float)(nowMs() - ts);
    if (perf && s.opt.perfSplit && !s.window) {   // measure the simulation's GPU work on its own (headless only)
        double tg = nowMs();
        SDL_SubmitGPUCommandBuffer(cmd);
        SDL_WaitForGPUIdle(s.gpu.device());
        pr.gpuSim = (float)(nowMs() - tg);
        cmd = SDL_AcquireGPUCommandBuffer(s.gpu.device());
    }

    double t2 = nowMs();
    s.renderer.update((float)dt);
    s.renderSettings.tod.advance((float)dt);
    if (s.lab) s.lab->update(s, (float)dt);
    SDL_GPUTexture* swap = nullptr;
    uint32_t w = (uint32_t)s.opt.width, h = (uint32_t)s.opt.height;
    double ta = nowMs();   // waiting for a swapchain image: large when the GPU is the bottleneck
    if (s.window && !SDL_WaitAndAcquireGPUSwapchainTexture(cmd, s.window, &swap, &w, &h)) swap = nullptr;
    const float acquireMs = (float)(nowMs() - ta);
    const uint32_t outW = w, outH = h;   // render scale: the 3D image at a fraction of the window's pixels, upscaled
    if (s.renderSettings.renderScale < 0.999f) {
        w = std::max(1u, (uint32_t)((float)w * s.renderSettings.renderScale));
        h = std::max(1u, (uint32_t)((float)h * s.renderSettings.renderScale));
    }
    if (s.cityMode) {   // streaming, LOD, uploads (copy passes before the scene pass), street-lamp lights
        {   // key-light shadow casters: the city culls its tiles against the same light box the renderer draws
            M4 lightVP;
            const bool sm = s.renderer.shadowView(s.camera, (float)w / (float)std::max(1u, h), s.renderSettings, lightVP);
            s.cityRenderer.setShadowCaster(sm ? lightVP.m : nullptr);
        }
        s.cityRenderer.update(cmd, s.camera, (float)w / (float)std::max(1u, h), s.frameIndex);
        // street lamps are lit by the city's lamp grid (all resident lamps, CityRenderer::lampGrid); the dynamic point
        // lights are left to burning vehicles (+ lab lights); explosions have their own flash / fire lights
        std::vector<PointLight> lamps;
        V3 p = s.camera.target();
        s.vehicles.fireLights(p.x, p.z, s.renderTime, 16, lamps);
        if (s.lab) s.lab->injectLights(lamps);
        s.renderer.setLights(lamps);
        std::vector<FireVolume> fireVols;   // burning wrecks: voxel flames + smoke columns
        s.vehicles.fireVolumes(p.x, p.z, 10, fireVols);
        s.renderer.setFireVolumes(fireVols);
    }
    if (!s.window || swap) {
        s.renderTime += dt;
        s.renderer.render(cmd, swap, w, h, s.camera, s.sim, s.renderTime, s.renderSettings, &s.chars, outW, outH);
    }
    s.cpuRender.add(nowMs() - t2);
    pr.renderRec = (float)(nowMs() - t2);

    double t3 = nowMs();
    if (s.window) {
        ImGui_ImplSDLGPU3_NewFrame();
        ImGui_ImplSDL3_NewFrame();
        ImGui::NewFrame();
        if (s.showUI) drawDebugUI(s);
        if (s.perfHud) drawPerfHud(s);
        if (s.showUI && s.lab) s.lab->drawUI(s);
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
    double tw = nowMs();
    if (!s.window) SDL_WaitForGPUIdle(s.gpu.device());
    pr.gpuRender = (float)(nowMs() - tw);
    s.cpuFrame.add(nowMs() - t0);
    {   // perf HUD: this frame, and averages / maxima over ~1 s
        AppState::PerfHud& h0 = s.hud;
        h0.frame = (float)(nowMs() - t0); h0.veh = pr.vehTotal; h0.simRec = pr.simRec; h0.renderRec = pr.renderRec;
        h0.ui = (float)s.cpuUI.last; h0.acquire = acquireMs; h0.submitWait = pr.gpuRender;
        float* a = &s.hudAcc.frame; float* m = &s.hudAccMax.frame; const float* c = &h0.frame;
        for (int i = 0; i < 7; ++i) { a[i] += c[i]; m[i] = std::max(m[i], c[i]); }
        ++s.hudFrames;
        if (nowMs() - s.hudT0 > 1000.0) {
            float* av = &s.hudAvg.frame;
            for (int i = 0; i < 7; ++i) av[i] = a[i] / (float)s.hudFrames;
            s.hudMax = s.hudAccMax;
            s.hudAcc = {}; s.hudAccMax = {}; s.hudFrames = 0; s.hudT0 = nowMs();
        }
    }
    if (perf) {
        const VehicleStats& vs = s.vehicles.stats();
        pr.frame = (float)(nowMs() - t0);
        pr.vehBlast = vs.msBlast; pr.vehFuse = vs.msFuse; pr.vehIntegrate = vs.msIntegrate; pr.vehGrid = vs.msGrid;
        pr.vehActive = vs.active; pr.uploadBytes = vs.uploadBytes; pr.explosions = vs.explosions;
        pr.fxVolumes = s.renderer.fxVolumesDrawn();
        pr.particles = s.sim.stats().particlesAlive;
        if (s.sim.extraReadback().size() >= 9) pr.gibs = CharacterRenderer::parseCounters(s.sim.extraReadback().data()).visibleGibs;
        pr.blasts = spamCount_;
        perf_.push_back(pr);
    }
    if (s.opt.cityVerify > 0 && (moved || s.frameIndex % (uint64_t)s.opt.cityVerify == 0)) cityVerify(moved ? "after move" : "periodic");
    for (auto& ps : postShots_)
        if (ps.first == s.frameIndex) {
            char name[512];
            std::snprintf(name, sizeof(name), "%s/move%02d_post_f%05d.png", s.opt.shotDir.c_str(), ps.second, (int)s.frameIndex);
            SDL_WaitForGPUIdle(s.gpu.device());
            s.renderer.saveScreenshot(name);
        }
    if (std::find(s.opt.shotFrames.begin(), s.opt.shotFrames.end(), (int)s.frameIndex) != s.opt.shotFrames.end()) {
        char name[512];
        std::snprintf(name, sizeof(name), "%s/f%05d.png", s.opt.shotDir.c_str(), (int)s.frameIndex);
        SDL_WaitForGPUIdle(s.gpu.device());
        s.renderer.saveScreenshot(name);
        SDL_Log("  frame %d: particles alive %u (read back a few frames late)", (int)s.frameIndex, s.sim.stats().particlesAlive);
    }
    if (s.opt.cityBench > 0) {
        s.benchFrameMs.push_back(nowMs() - t0);
        const CityRenderStats& cs = s.cityRenderer.stats();
        s.benchUploadMs.push_back(cs.uploadMs);
        CityRenderStats& m = s.benchMax;
        m.resident = std::max(m.resident, cs.resident); m.visible = std::max(m.visible, cs.visible);
        m.drawCalls = std::max(m.drawCalls, cs.drawCalls); m.triangles = std::max(m.triangles, cs.triangles);
        m.vehicles = std::max(m.vehicles, cs.vehicles); m.gpuBytes = std::max(m.gpuBytes, cs.gpuBytes);
        m.uploadedTiles += cs.uploadedTiles; m.uploadedBytes += cs.uploadedBytes; m.lod1Tiles = std::max(m.lod1Tiles, cs.lod1Tiles);
        m.lod2Tiles = std::max(m.lod2Tiles, cs.lod2Tiles); m.tileTriangles = std::max(m.tileTriangles, cs.tileTriangles);
    }
    ++s.frameIndex;
}

// --spam-blasts: player click spam at RATE blasts / s (deterministic scatter), like left clicks with the blast tool.
void App::spamStep(double dt) {
    AppState& s = s_;
    AppOptions& o = s.opt;
    const int f = (int)s.frameIndex;
    const int setup = std::min(2, o.spamStart);   // the jam, the camera and the horde are set up before the measurement
    if (f == setup && std::isnan(o.spamX)) {   // auto: the densest vehicle cluster within 80 m of the window centre
        V3 c = s.camera.target();
        const std::vector<Vehicle>& vs = s.vehicles.vehicles();
        int best = -1;
        float bestScore = -1;
        for (size_t i = 0; i < vs.size(); ++i) {
            const Vehicle& v = vs[i];
            if (!v.inWindow || v.health < -1e8f) continue;
            float dx = v.p[0] - c.x, dz = v.p[2] - c.z;
            if (dx * dx + dz * dz > 80.f * 80.f) continue;
            int n = 0;
            for (const Vehicle& w : vs) {
                float ex = w.p[0] - v.p[0], ez = w.p[2] - v.p[2];
                n += w.inWindow && ex * ex + ez * ez < 12.f * 12.f;
            }
            if (n > bestScore) { bestScore = (float)n; best = (int)i; }
        }
        o.spamX = best >= 0 ? vs[(size_t)best].p[0] : c.x;
        o.spamZ = best >= 0 ? vs[(size_t)best].p[2] : c.z;
        SDL_Log("spam blasts: centre (%.1f, %.1f), %d vehicles within 12 m", o.spamX, o.spamZ, (int)bestScore);
    }
    if (f == setup) {   // the camera on the jam, and a horde in it (lands on the streets of the rect)
        s.camera.setImmediate({o.spamX, 0, o.spamZ}, s.camera.yaw(), s.camera.pitch(), s.camera.distance());
        s.sim.requestSpawn({o.spamX - 25.f, o.spamZ - 25.f, o.spamX + 25.f, o.spamZ + 25.f}, 4000);
    }
    if (f < o.spamStart || f >= o.spamStart + (int)(o.spamSeconds * 60.f)) return;
    spamAcc_ += (float)dt * o.spamRate;
    while (spamAcc_ >= 1.f) {
        spamAcc_ -= 1.f;
        auto rnd = [&]() { spamRng_ ^= spamRng_ << 13; spamRng_ ^= spamRng_ >> 17; spamRng_ ^= spamRng_ << 5; return (spamRng_ >> 8) * (1.f / 16777216.f); };
        float x = o.spamX + (rnd() * 2.f - 1.f) * o.spamSpread, z = o.spamZ + (rnd() * 2.f - 1.f) * o.spamSpread;
        s.sim.requestExplosion(x, 0.4f, z);
        s.renderer.addBlast(x, 0.4f, z);
        ++spamCount_;
    }
}

void App::printPerf() {
    if (perf_.empty()) return;
    const AppOptions& o = s_.opt;
    if (!o.perfCsv.empty()) {
        if (FILE* fp = std::fopen(o.perfCsv.c_str(), "w")) {
            std::fprintf(fp, "frame,ms,veh,vehBlast,vehFuse,vehIntegrate,vehGrid,simRec,gpuSim,renderRec,gpuRender,vehActive,uploadBytes,fxVolumes,particles,gibs,blasts,explosions\n");
            for (size_t i = 0; i < perf_.size(); ++i) {
                const PerfRow& r = perf_[i];
                std::fprintf(fp, "%zu,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%u,%u,%u,%u,%u,%u,%u\n", i, r.frame, r.vehTotal, r.vehBlast,
                             r.vehFuse, r.vehIntegrate, r.vehGrid, r.simRec, r.gpuSim, r.renderRec, r.gpuRender, r.vehActive, r.uploadBytes,
                             r.fxVolumes, r.particles, r.gibs, r.blasts, r.explosions);
            }
            std::fclose(fp);
        }
    }
    const int spam0 = o.spamRate > 0 ? o.spamStart : (int)perf_.size(), spam1 = o.spamRate > 0 ? o.spamStart + (int)(o.spamSeconds * 60.f) : (int)perf_.size();
    struct Seg { const char* name; int a, b; };
    Seg segs[3] = {{"before", 30, spam0}, {"spam", spam0, spam1}, {"after", spam1, (int)perf_.size()}};
    std::printf("\nperf report (%s, %dx%d%s; ms avg / p95 / max; headless: gpu = waiting for the GPU)\n", s_.gpu.driverName(), o.width, o.height,
                o.perfSplit ? ", sim GPU submitted apart" : "");
    std::printf("| segment | frames | frame | veh total | veh blast | veh fuse | veh integrate | veh grid+upload | sim rec | gpu sim | render rec | gpu render | veh active max | upload KB max | fx vols max | particles max | gibs vis max |\n");
    std::printf("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n");
    for (const Seg& g : segs) {
        int a = std::max(0, g.a), b = std::min((int)perf_.size(), g.b);
        if (b - a < 2) continue;
        auto stat = [&](float PerfRow::*m) {
            std::vector<float> v;
            for (int i = a; i < b; ++i) v.push_back(perf_[(size_t)i].*m);
            double avg = 0;
            for (float x : v) avg += x;
            avg /= v.size();
            std::sort(v.begin(), v.end());
            static char buf[8][64];
            static int k = 0;
            char* out = buf[k++ & 7];
            std::snprintf(out, 64, "%.2f / %.2f / %.2f", avg, v[std::min(v.size() - 1, (size_t)(0.95 * v.size()))], v.back());
            return (const char*)out;
        };
        auto mx = [&](uint32_t PerfRow::*m) { uint32_t r = 0; for (int i = a; i < b; ++i) r = std::max(r, perf_[(size_t)i].*m); return r; };
        std::printf("| %s | %d | %s | %s | %s | %s |", g.name, b - a, stat(&PerfRow::frame), stat(&PerfRow::vehTotal), stat(&PerfRow::vehBlast),
                    stat(&PerfRow::vehFuse));
        std::printf(" %s | %s | %s | %s |", stat(&PerfRow::vehIntegrate), stat(&PerfRow::vehGrid), stat(&PerfRow::simRec), stat(&PerfRow::gpuSim));
        std::printf(" %s | %s | %u | %.0f | %u | %u | %u |\n", stat(&PerfRow::renderRec), stat(&PerfRow::gpuRender), mx(&PerfRow::vehActive),
                    mx(&PerfRow::uploadBytes) / 1024.0, mx(&PerfRow::fxVolumes), mx(&PerfRow::particles), mx(&PerfRow::gibs));
    }
    std::printf("blasts clicked %u, vehicle explosions %u\n", spamCount_, s_.vehicles.stats().explosions);
    std::fflush(stdout);
}

// City benchmark camera: starts over the simulation window, then flies a straight 1.4 km line across the map at
// 40 m/s (pitch and zoom sweep the RTS range), so tiles stream in and out and LODs switch.
void App::cityBenchStep() {
    AppState& s = s_;
    float t = (float)s.frameIndex / 60.f;
    float cx = 0.5f * (s.city.x0 + s.city.x1), cz = 0.5f * (s.city.z0 + s.city.z1);
    const Scenario& sc = s.sandbox.scenarios[(size_t)s.scenario];
    float gx = sc.goals.size() >= 2 ? sc.goals[0] : cx, gz = sc.goals.size() >= 2 ? sc.goals[1] : cz;
    float dirx = cx - gx, dirz = cz - gz, len = std::sqrt(dirx * dirx + dirz * dirz);
    if (len < 1.f) { dirx = 1; dirz = 0.3f; len = std::sqrt(1.09f); }
    float along = std::max(0.f, t - 2.f) * 40.f;
    float dist = 120.f + 150.f * (0.5f - 0.5f * std::cos(t * 0.4f));
    float pitch = (35.f + 35.f * (0.5f + 0.5f * std::sin(t * 0.3f))) * 3.14159265f / 180.f;
    s.camera.setImmediate({gx + dirx / len * along, 0, gz + dirz / len * along}, 0.9f + 0.1f * t, pitch, dist);
}

// Test only (--city-verify): synchronous readback of the horde and the grid fields. Logs agents inside static
// obstacles (feet below the obstacle top), outside the window, NaNs, parked agents and the blood in the window.
void App::cityVerify(const char* why) {
    AppState& s = s_;
    SDL_WaitForGPUIdle(s.gpu.device());
    const CrowdSim& sim = s.sim;
    uint32_t c[C_COUNT];
    s.gpu.downloadNow(sim.counters(), c, sizeof(c));
    std::vector<GpuAgent> ag(c[C_LIVE]);
    if (!ag.empty()) s.gpu.downloadNow(sim.agents(), ag.data(), (uint32_t)(ag.size() * sizeof(GpuAgent)));
    const uint32_t W = (uint32_t)s.params.gridW, H = (uint32_t)s.params.gridH, n = W * H;
    std::vector<float> st(n);
    std::vector<uint32_t> dec(9u * n), pk(4);
    s.gpu.downloadNow(sim.staticHeight(), st.data(), n * 4);
    s.gpu.downloadNow(sim.decals(), dec.data(), 9u * n * 4);
    s.gpu.downloadNow(sim.parkCounts(), pk.data(), 16);
    const float ox = sim.originX(), oz = sim.originZ(), cs = s.params.cellSize;
    int inside = 0, outside = 0, nan = 0, live = 0;
    for (const GpuAgent& a : ag) {
        if ((a.info.x & 0xFF) == ST_DEAD) continue;
        ++live;
        if (!std::isfinite(a.pos.x) || !std::isfinite(a.pos.y) || !std::isfinite(a.pos.z)) { ++nan; continue; }
        int cx = (int)std::floor((a.pos.x - ox) / cs), cz = (int)std::floor((a.pos.z - oz) / cs);
        if (cx < 0 || cz < 0 || cx >= (int)W || cz >= (int)H) { ++outside; continue; }
        float top = st[(size_t)cz * W + cx];
        if (top > 0 && a.pos.y < top - s.params.stepUp - 0.05f) ++inside;
    }
    double blood = 0;
    for (uint32_t i = 0; i < 9u * n; ++i) blood += dec[i];
    V3 p = s.camera.target();
    SDL_Log("verify f%llu (%s): window (%.1f, %.1f) pivot (%.1f, %.1f) live %d parked %u inside-obstacles %d outside-window %d nan %d blood %.0f corpses %u",
            (unsigned long long)s.frameIndex, why, ox, oz, p.x, p.z, live, std::min(pk[sim.parkedList()], 1u << 30), inside, outside, nan, blood,
            std::min<uint32_t>(c[C_CORPSES], (uint32_t)s.params.corpseCapacity));
}

void App::printCityBench() {
    AppState& s = s_;
    auto pct = [](std::vector<double> v, double p) {
        if (v.empty()) return 0.0;
        std::sort(v.begin(), v.end());
        return v[std::min(v.size() - 1, (size_t)(p * v.size()))];
    };
    double avg = 0, up = 0;
    for (double v : s.benchFrameMs) avg += v;
    for (double v : s.benchUploadMs) up += v;
    avg /= std::max<size_t>(1, s.benchFrameMs.size());
    up /= std::max<size_t>(1, s.benchUploadMs.size());
    const CityRenderStats& m = s.benchMax;
    std::printf("\ncity benchmark (%s, %dx%d, %d frames, zombies live %u; headless: frame ms include waiting for the GPU)\n",
                s.gpu.driverName(), s.opt.width, s.opt.height, (int)s.benchFrameMs.size(), s.sim.stats().live);
    std::printf("| frame ms avg / p50 / p95 / max | city update+upload ms avg / p95 / max | resident max | visible max | lod1 / lod2 max | draws max | city tris max (tiles) | instances max | tiles uploaded | MB uploaded | city GPU MB max |\n");
    std::printf("|---|---|---|---|---|---|---|---|---|---|---|\n");
    std::printf("| %.2f / %.2f / %.2f / %.2f | %.3f / %.3f / %.3f | %u | %u | %u / %u | %u | %llu (%llu) | %llu | %u | %.1f | %.1f |\n", avg,
                pct(s.benchFrameMs, 0.5), pct(s.benchFrameMs, 0.95), pct(s.benchFrameMs, 1.0), up, pct(s.benchUploadMs, 0.95),
                pct(s.benchUploadMs, 1.0), m.resident, m.visible, m.lod1Tiles, m.lod2Tiles, m.drawCalls, (unsigned long long)m.triangles,
                (unsigned long long)m.tileTriangles,
                (unsigned long long)m.vehicles, m.uploadedTiles, m.uploadedBytes / 1048576.0, m.gpuBytes / 1048576.0);
    std::fflush(stdout);
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
        if (s_.opt.traceEvery > 0 && s_.frameIndex % (uint64_t)s_.opt.traceEvery == 0) {
            const SimStats& st = s_.sim.stats();
            SDL_Log("trace frame %d: live=%u airborne=%u deaths=%u corpses=%u climbing=%u", (int)s_.frameIndex, st.live, st.airborne,
                    st.deaths, st.corpses, st.climbing);
        }
        if (s_.opt.frames > 0 && (int)s_.frameIndex >= s_.opt.frames) {
            SDL_WaitForGPUIdle(s_.gpu.device());
            if (!s_.opt.screenshot.empty()) s_.renderer.saveScreenshot(s_.opt.screenshot);
            if (s_.opt.cityBench > 0) printCityBench();
            printPerf();
            if (s_.cityMode) {
                const CityRenderStats& c = s_.cityRenderer.stats();
                SDL_Log("city view: resident %u, visible %u (LOD1 %u, LOD2 %u), draws %u, triangles %.2f M (tiles %.2f M), instances %llu, GPU %.0f MB",
                        c.resident, c.visible, c.lod1Tiles, c.lod2Tiles, c.drawCalls, c.triangles / 1e6, c.tileTriangles / 1e6,
                        (unsigned long long)c.vehicles, c.gpuBytes / 1048576.0);
            }
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
    if (s_.lab) {
        s_.renderer.extPrepare = nullptr;
        s_.renderer.extDraw = nullptr;
        s_.renderer.extShadowDraw = nullptr;
        s_.lab->shutdown();
        delete s_.lab;
        s_.lab = nullptr;
    }
    s_.simWindow.shutdown();
    s_.cityRenderer.shutdown();
    s_.renderer.shutdown();
    s_.chars.shutdown();
    s_.sim.shutdown();
    s_.gpu.shutdown();
    if (s_.window) SDL_DestroyWindow(s_.window);
    SDL_Quit();
}

} // namespace ttz
