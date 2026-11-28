#include "debug/DebugUI.h"

#include "app/App.h"
#include "imgui.h"
#include "sim/Look.h"

namespace ttz {

void drawPerfHud(AppState& s) {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + vp->WorkSize.x - 10, vp->WorkPos.y + 10), ImGuiCond_Always, ImVec2(1, 0));
    ImGui::SetNextWindowBgAlpha(0.6f);
    ImGui::Begin("perf", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoInputs |
                                      ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    const AppState::PerfHud &a = s.hudAvg, &m = s.hudMax;
    ImGui::Text("frame %5.2f ms (%3.0f fps)  max %5.1f", a.frame, a.frame > 0 ? 1000.f / a.frame : 0.f, m.frame);
    ImGui::Text("CPU  vehicles %5.2f  max %5.2f", a.veh, m.veh);
    ImGui::Text("     sim rec  %5.2f  max %5.2f", a.simRec, m.simRec);
    ImGui::Text("     render   %5.2f  max %5.2f", a.renderRec, m.renderRec);
    ImGui::Text("     ui       %5.2f", a.ui);
    ImGui::Text("GPU-bound wait (swapchain) %5.2f  max %5.2f", a.acquire, m.acquire);
    const Renderer::FxStats& fx = s.renderer.fxStats();
    const RenderSettings& rs = s.renderSettings;
    ImGui::Text("fx vols %u (%u coarse) cover %.2f  merged %u", fx.volumes, fx.coarse, fx.coverage, fx.merged);
    ImGui::Text("fire lights %u (+%u culled)  particles %u", fx.lights, fx.lightsCulled, s.sim.stats().particlesAlive);
    ImGui::Text("shadow draws %u  vehicle blasts %u", s.renderer.shadowDrawCalls(), s.vehicles.stats().explosions);
    ImGui::Text("off:%s%s%s%s%s%s  fx %s  scale %.2f", rs.drawFxVolumes ? "" : " fx", rs.drawParticles ? "" : " particles",
                rs.chars.drawGibs ? "" : " gibs", rs.fireLights ? "" : " lights", rs.shadowMap ? "" : " shadows", rs.tiltShift ? "" : " dof",
                rs.fxHalfRes ? (rs.fxResDiv >= 4 ? "1/4 res" : "1/2 res") : "full res", rs.renderScale);
    ImGui::End();
}

void drawDebugUI(AppState& s) {
    ImGui::SetNextWindowPos(ImVec2(10, 10), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(380, 0), ImGuiCond_FirstUseEver);
    ImGui::Begin("Tiny Tiny Zombies - debug", nullptr, ImGuiWindowFlags_NoFocusOnAppearing);
    const SimStats& st = s.sim.stats();
    ImGui::Text("%s | %s | MSAA x%d", SDL_GetPlatform(), s.gpu.driverName(), s.renderer.msaaSamples());
    ImGui::Text("frame %.2f ms (avg %.2f, p95 %.2f, max %.1f)", s.frameTotal.last, s.frameTotal.avg,
                s.history.percentile(0.95f), s.frameTotal.max);
    ImGui::Text("CPU: sim record %.2f  render record %.2f  ui %.2f ms", s.cpuSim.avg, s.cpuRender.avg, s.cpuUI.avg);
    ImGui::Text("sim steps/frame %d   sim time %.1f s", s.stepsLastFrame, s.sim.simTime());
    ImGui::PlotLines("##ft", s.history.ms.data(), (int)s.history.ms.size(), s.history.head, "frame ms", 0.f, 50.f, ImVec2(-1, 50));
    ImGui::Text("GPU mem (ours) %.1f MB   process RSS %.0f MB", s.gpu.gpuBytesAllocated() / 1048576.0,
                processResidentBytes() / 1048576.0);
    ImGui::Separator();
    ImGui::Text("zombies %u   corpses %u (settled)   active bodies %u   deaths %u", st.live, st.corpses, st.airborne, st.deaths);
    ImGui::Text("climbing %u   elevated %u   airborne %u", st.climbing, st.elevated, st.airborne);
    ImGui::Text("max stack height %.2f m   reactivated %u", st.maxStackHeight, st.reactivated);
    if (st.corpseOverflow) ImGui::TextColored(ImVec4(1, 0.4f, 0.3f, 1), "corpse instance buffer full: %u (height kept)", st.corpseOverflow);

    ImGui::Separator();
    const char* names[8];
    int n = 0;
    for (auto& sc : s.sandbox.scenarios) if (n < 8) names[n++] = sc.name.c_str();
    if (ImGui::Combo("scenario", &s.scenario, names, n)) s.resetRequested = true;
    ImGui::SliderInt("count", &s.spawnCount, 100, s.params.agentCapacity);
    if (ImGui::Button("Reset (R)")) s.resetRequested = true;
    ImGui::SameLine();
    if (ImGui::Button(s.paused ? "Resume (Space)" : "Pause (Space)")) s.paused = !s.paused;
    ImGui::SameLine();
    if (ImGui::Button("Spawn +1000")) {
        const Scenario& sc = s.sandbox.scenarios[s.scenario];
        for (size_t i = 0; i < sc.spawns.size(); ++i) s.sim.requestSpawn(sc.spawns[i], 1000);
    }
    ImGui::SliderFloat("sim speed", &s.simSpeed, 0.0f, 4.0f, "%.2fx");
    ImGui::Text("Left click tool:");
    ImGui::SameLine();
    ImGui::RadioButton("explode (1)", (int*)&s.tool, 0);
    ImGui::SameLine();
    ImGui::RadioButton("goal (2)", (int*)&s.tool, 1);
    ImGui::SameLine();
    ImGui::RadioButton("spawn (3)", (int*)&s.tool, 2);

    SimParams& p = s.sim.params();
    ImGui::Checkbox("vertical accumulation", &p.verticalEnabled);
    ImGui::SameLine();
    ImGui::Checkbox("corpses", &p.corpsesEnabled);

    uint32_t& f = s.renderSettings.debugFlags;
    auto flag = [&](const char* label, uint32_t bit) {
        bool on = (f & bit) != 0;
        if (ImGui::Checkbox(label, &on)) f = on ? (f | bit) : (f & ~bit);
    };
    flag("density (V)", 1);
    ImGui::SameLine();
    flag("flow (F)", 2);
    ImGui::SameLine();
    flag("grid (G)", 4);
    flag("nav distance", 8);
    ImGui::SameLine();
    flag("corpse height", 16);

    if (s.cityMode) {   // moving simulation window (CitySimWindow)
        const SimWindowStats& w = s.simWindow.stats();
        ImGui::Checkbox("sim window follows camera", &s.simWindow.enabled);
        ImGui::Text("sim window (%.0f, %.0f): %d moves (%d discarded)%s, worker last %.0f / max %.0f ms, commit max %.2f ms", s.simWindow.originX(),
                    s.simWindow.originZ(), w.relocations, w.discarded, w.busy ? ", preparing" : "", w.lastJobMs, w.maxJobMs, w.maxCommitCpuMs);
        ImGui::Text("parked zombies %u (despawned: list full %u), height tiles cached %d", s.sim.stats().parked, s.sim.stats().parkDropped, w.tilesCached);
    }
    if (s.cityMode && ImGui::CollapsingHeader("City", ImGuiTreeNodeFlags_DefaultOpen)) {
        const CityRenderStats& c = s.cityRenderer.stats();
        CitySettings& cs = s.cityRenderer.settings;
        ImGui::Text("tiles resident %u / wanted %u / visible %u (LOD1 %u, LOD2 %u), pending %u", c.resident, c.wanted, c.visible, c.lod1Tiles, c.lod2Tiles, c.pending);
        ImGui::Text("tile triangles %.2f M, %u tile draws, chunks visible %u (LOD1 %u)", c.tileTriangles / 1e6, c.tileDraws, c.visibleChunks, c.lod1Chunks);
        ImGui::Text("tile decode avg %.2f ms, max %.2f ms (%u tiles)", c.decodedTiles ? c.decodeMsSum / c.decodedTiles : 0.0, c.decodeMsMax, c.decodedTiles);
        ImGui::Text("draws %u, triangles %.2f M, instances %llu, GPU %.1f MB", c.drawCalls, c.triangles / 1e6, (unsigned long long)c.vehicles,
                    c.gpuBytes / 1048576.0);
        ImGui::Text("update + upload %.2f ms (%u tiles, %.1f MB this frame)", c.uploadMs, c.uploadedTiles, c.uploadedBytes / 1048576.0);
        ImGui::Checkbox("draw city", &cs.draw);
        ImGui::SameLine();
        ImGui::Checkbox("vehicles", &cs.vehicles);
        ImGui::SameLine();
        ImGui::Checkbox("props", &cs.props);
        ImGui::SameLine();
        ImGui::Checkbox("back-face cull", &cs.backfaceCull);
        ImGui::SameLine();
        ImGui::Checkbox("chunks", &cs.chunks);
        ImGui::SliderFloat("LOD1 distance", &cs.lod1Dist, 50.f, 1000.f);
        ImGui::SliderFloat("LOD2 distance", &cs.lod2Dist, 100.f, 1500.f);
        ImGui::SliderFloat("vehicle mid distance", &cs.vehicleMidDist, 10.f, 300.f);
        ImGui::SliderFloat("vehicle box distance", &cs.vehicleBoxDist, 30.f, 600.f);
        ImGui::SliderFloat("prop mid distance", &cs.propMidDist, 10.f, 300.f);
        ImGui::SliderFloat("prop distance", &cs.propDist, 50.f, 600.f);
        ImGui::Text("F2: %s camera", s.debugCam ? "debug (free)" : "RTS");
    }

    if (ImGui::CollapsingHeader("Time of day & shadows", ImGuiTreeNodeFlags_DefaultOpen)) {
        RenderSettings& rs = s.renderSettings;
        TimeOfDaySettings& t = rs.tod;
        const TimeOfDayLight tl = s.renderer.lightAt(rs);
        int hh = (int)t.hours, mm = (int)((t.hours - (float)hh) * 60.f);
        ImGui::Text("%02d:%02d  %s elevation %.1f deg  night %.2f", hh, mm, tl.moon ? "moon" : "sun", tl.moon ? std::asin(tl.dir.y) * 57.2958f : tl.sunElevation, tl.night);
        ImGui::SliderFloat("time (h)", &t.hours, 0.f, 23.99f, "%.2f");
        ImGui::Checkbox("pause clock", &t.paused);
        ImGui::SameLine();
        if (ImGui::Button("dawn")) t.hours = 6.2f;
        ImGui::SameLine();
        if (ImGui::Button("noon")) t.hours = 12.f;
        ImGui::SameLine();
        if (ImGui::Button("golden")) t.hours = 16.4f;
        ImGui::SameLine();
        if (ImGui::Button("dusk")) t.hours = 18.3f;
        ImGui::SameLine();
        if (ImGui::Button("night")) t.hours = 0.f;
        ImGui::SliderFloat("clock speed", &t.speed, 0.f, 60.f, "%.1fx", ImGuiSliderFlags_Logarithmic);
        ImGui::SliderFloat("day (real min, 06-18 h)", &t.dayMinutes, 1.f, 90.f, "%.1f");
        ImGui::SliderFloat("night (real min, 18-06 h)", &t.nightMinutes, 1.f, 60.f, "%.1f");
        ImGui::SliderFloat("sun max elevation", &t.sunMaxElevation, 15.f, 85.f, "%.0f deg");
        ImGui::SliderFloat("sun azimuth offset", &t.sunAzimuthOffset, -180.f, 180.f, "%.0f deg");
        ImGui::SliderFloat("sun strength", &t.sunStrength, 0.f, 2.f);
        ImGui::SliderFloat("night brightness", &t.nightBrightness, 0.2f, 3.f);
        ImGui::Checkbox("shadows", &rs.shadows);
        ImGui::SameLine();
        ImGui::Checkbox("shadow map (off: legacy moon field)", &rs.shadowMap);
        int sz = rs.shadowMapSize <= 1024 ? 0 : rs.shadowMapSize <= 2048 ? 1 : 2;
        if (ImGui::Combo("shadow map size", &sz, "1024\0" "2048\0" "4096\0")) rs.shadowMapSize = 1024 << sz;
        ImGui::SliderFloat("shadow range (m)", &rs.shadowRange, 40.f, 400.f, "%.0f");
        ImGui::SliderFloat("shadow softness (texels)", &rs.shadowSoftness, 0.25f, 3.f);
        ImGui::Text("shadow pass: %u draw calls", s.renderer.shadowDrawCalls());
        ImGui::Checkbox("cloud shadows (voxel)", &rs.clouds);
        if (rs.clouds) {
            ImGui::SliderFloat("cloud strength (sun dimmed)", &rs.cloudStrength, 0.f, 1.f);
            ImGui::SliderFloat("cloud coverage", &rs.cloudCoverage, 0.f, 0.6f);
            ImGui::SliderFloat("cloud voxel (m)", &rs.cloudCell, 0.05f, 2.f, "%.2f", ImGuiSliderFlags_Logarithmic);
            ImGui::SliderFloat("cloud wind (m/s)", &rs.cloudSpeed, 0.f, 20.f, "%.1f");
            ImGui::SliderFloat("cloud wind heading", &rs.cloudWindDeg, -180.f, 180.f, "%.0f deg");
            ImGui::SliderFloat("cloud deck height (m)", &rs.cloudHeight, 50.f, 600.f, "%.0f");
        }
        if (s.cityMode) {
            CitySettings& c = s.cityRenderer.settings;
            ImGui::SliderFloat("lamp intensity", &c.lampIntensity, 0.f, 3.f);
            ImGui::SliderFloat("lamp radius (m)", &c.lampRadius, 6.f, 40.f, "%.0f");
            ImGui::SliderFloat("LED lamp share", &c.lampLedShare, 0.f, 1.f);
            ImGui::Text("street lamps lit: %u (all resident)", s.cityRenderer.lampCount());
        }
    }

    if (ImGui::CollapsingHeader("Performance (explosion cost)")) {
        RenderSettings& rs = s.renderSettings;
        ImGui::Checkbox("perf HUD (F3)", &s.perfHud);
        if (ImGui::Checkbox("A/B: legacy explosion rendering", &rs.perfLegacy)) rs.chars.gibShadows = rs.perfLegacy;
        ImGui::Checkbox("fx volumes (voxel fireballs / smoke / wreck fires)", &rs.drawFxVolumes);
        ImGui::Checkbox("fx at reduced resolution", &rs.fxHalfRes);
        if (rs.fxHalfRes) { ImGui::SameLine(); ImGui::RadioButton("1/2", &rs.fxResDiv, 2); ImGui::SameLine(); ImGui::RadioButton("1/4", &rs.fxResDiv, 4); }
        ImGui::SliderFloat("fx min px per voxel (LOD)", &rs.fxVoxelPx, 0.5f, 4.f);
        ImGui::SliderFloat("fx full-quality coverage budget", &rs.fxBudget, 0.05f, 3.f);
        ImGui::Checkbox("particles (blood, fire, smoke, debris)", &rs.drawParticles);
        ImGui::Checkbox("body parts (gibs)", &rs.chars.drawGibs);
        ImGui::Checkbox("body parts cast shadows", &rs.chars.gibShadows);
        ImGui::Checkbox("fire / blast lights", &rs.fireLights);
        ImGui::SliderInt("max fire lights", &rs.maxFireLights, 0, 24);
        ImGui::Checkbox("shadow map", &rs.shadowMap);
        ImGui::Checkbox("depth of field", &rs.tiltShift);
        ImGui::SliderFloat("render scale (x window pixels)", &rs.renderScale, 0.25f, 1.f);
    }

    if (ImGui::CollapsingHeader("Look (fog, exposure, miniature)")) {
        RenderSettings& rs = s.renderSettings;
        ImGui::SliderFloat("exposure (x time of day)", &rs.exposure, 0.4f, 2.5f);
        ImGui::SliderFloat("fog density", &rs.fogDensity, 0.0f, 0.006f, "%.4f");
        ImGui::SliderFloat("fog start (x cam dist)", &rs.fogStart, 0.0f, 2.0f);
        ImGui::SliderFloat("saturation", &rs.saturation, 0.5f, 1.8f);
        ImGui::SliderFloat("contrast", &rs.contrast, 0.7f, 1.5f);
        ImGui::SliderFloat("vignette", &rs.vignette, 0.0f, 0.6f);
        ImGui::Checkbox("miniature depth of field", &rs.tiltShift);
        if (rs.tiltShift) {
            ImGui::SliderFloat("DOF strength", &rs.dofStrength, 0.0f, 1.0f);
            ImGui::SliderFloat("aperture", &rs.dofAperture, 0.2f, 5.0f);
            ImGui::SliderFloat("focus offset (x pivot dist)", &rs.dofFocusOffset, -0.5f, 0.5f);
            ImGui::SliderFloat("max blur (x screen height)", &rs.dofMaxBlur, 0.004f, 0.04f, "%.3f");
            ImGui::SliderFloat("bokeh highlight gain", &rs.dofHighlightGain, 0.0f, 10.0f);
            ImGui::SliderFloat("bokeh highlight threshold", &rs.dofHighlightThreshold, 0.3f, 0.95f);
            ImGui::SliderFloat("hexagonal aperture", &rs.dofHexAperture, 0.0f, 1.0f);
            ImGui::Checkbox("show CoC (red near, blue far)", &rs.dofDebug);
            ImGui::Checkbox("auto focus (scene under the screen centre)", &rs.dofAutoFocus);
            ImGui::Checkbox("zoom-adaptive DOF (city reads when zoomed out)", &rs.dofZoomAdapt);
            if (rs.dofZoomAdapt) {
                ImGui::SliderFloat("full DOF up to (m)", &rs.dofZoomNear, 45.f, 300.f, "%.0f");
                ImGui::SliderFloat("far DOF at (m)", &rs.dofZoomFar, 45.f, 300.f, "%.0f");
                ImGui::SliderFloat("far aperture (x)", &rs.dofFarAperture, 0.0f, 2.0f);
                ImGui::SliderFloat("far max blur (x)", &rs.dofFarMaxBlur, 0.0f, 1.0f);
                ImGui::SliderFloat("far in-focus band", &rs.dofFarBand, 0.0f, 0.5f);
                ImGui::SliderFloat("far tilt-shift", &rs.dofFarTilt, 0.0f, 1.0f);
                ImGui::SliderFloat("tilt-shift sharp centre", &rs.dofTiltSharp, 0.0f, 0.9f);
            }
        }
    }

    if (ImGui::CollapsingHeader("Characters", ImGuiTreeNodeFlags_DefaultOpen)) {
        RenderSettings& rs = s.renderSettings;
        CharacterSettings& cs = rs.chars;
        ImGui::RadioButton("approved modular", &rs.characterModel, 1);
        ImGui::SameLine();
        ImGui::RadioButton("placeholder", &rs.characterModel, 0);
        if (rs.characterModel == 1) {
            const auto& ex = s.sim.extraReadback();
            if (ex.size() >= 7) {
                CharacterStats st = CharacterRenderer::parseCounters(ex.data());
                ImGui::Text("visible %u (%u zombies, %u corpses, %u body parts)", st.visible, st.visibleAgents, st.visibleCorpses,
                            st.visibleGibs);
                ImGui::Text("segments %u  triangles %.2fM  VS invocations %.2fM", st.segments, st.triangles / 1e6, st.vsInvocations / 1e6);
                ImGui::Text("hidden behind buildings (culled): %u", st.occluded);
                if (st.overflow) ImGui::TextColored(ImVec4(1, 0.4f, 0.3f, 1), "render capacity exceeded: %u not drawn", st.overflow);
            }
            ImGui::Text("draw calls: %u (characters %u)", s.renderer.drawCalls(rs, &s.chars), s.chars.drawCalls(cs));
            const char* geo[] = {"naive cubes", "hidden faces removed", "greedy by material", "greedy + voxel materials"};
            ImGui::Combo("geometry", &cs.geometryLevel, geo, 4);
            const char* cls[] = {"per body-part family", "vertex-count size classes"};
            ImGui::Combo("batching", &cs.classMode, cls, 2);
            ImGui::Checkbox("frustum culling", &cs.frustumCull);
            ImGui::SameLine();
            ImGui::Checkbox("occlusion", &cs.occlusionCull);
            ImGui::SameLine();
            ImGui::Checkbox("pose per vertex", &cs.poseInVertexShader);
            const char* anims[] = {"from simulation", "idle", "walk", "reach", "climb", "flail", "dying", "corpse pose"};
            int fa = (int)cs.forcedAnim;
            if (ImGui::Combo("animation", &fa, anims, 8)) cs.forcedAnim = (uint32_t)fa;
            ImGui::Text("appearance weights (new spawns):");
            SimParams& sp = s.sim.params();
            ImGui::SliderFloat("recently infected", &sp.lookRecent, 0.f, 1.f);
            ImGui::SliderFloat("fully clothed", &sp.lookClothed, 0.f, 1.f);
            ImGui::SliderFloat("lightly damaged", &sp.lookLight, 0.f, 1.f);
            ImGui::SliderFloat("heavily damaged", &sp.lookHeavy, 0.f, 1.f);
            ImGui::SliderFloat("skeletal", &sp.lookSkeletal, 0.f, 1.f);
            ImGui::SliderFloat("missing limbs", &sp.lookMissing, 0.f, 1.f);
            if (ImGui::TreeNode("Custom zombie (pick every variant)")) {
                static int mods[10] = {1, 1, 0, 0, 0, 0, 0, 0, 0, 0}, tier = 1, decay = 1, pal[8] = {};
                static const char* heads[] = {"bald", "short hair", "long hair", "beanie", "scalp wound", "lost eye", "missing jaw", "half skull"};
                static const char* torsos[] = {"t-shirt", "shirt and tie", "hoodie", "open jacket", "tank top", "open ribcage", "gutted"};
                static const char* uppers[] = {"sleeve", "bare", "torn sleeve", "exposed muscle", "bone"};
                static const char* fores[] = {"sleeve + hand", "bare + hand", "bloody", "skinned", "bone + bony hand", "missing (stump)"};
                static const char* thighs[] = {"trousers", "shorts", "torn trousers", "exposed muscle", "bare femur"};
                static const char* shins[] = {"trousers + shoe", "bare shin + shoe", "barefoot", "torn + bloody", "skinned", "bone + bony foot"};
                ImGui::Combo("head", &mods[0], heads, 8);
                ImGui::Combo("torso", &mods[1], torsos, 7);
                ImGui::Combo("L upper arm", &mods[2], uppers, 5); ImGui::Combo("L forearm", &mods[3], fores, 6);
                ImGui::Combo("R upper arm", &mods[4], uppers, 5); ImGui::Combo("R forearm", &mods[5], fores, 6);
                ImGui::Combo("L thigh", &mods[6], thighs, 5); ImGui::Combo("L shin", &mods[7], shins, 6);
                ImGui::Combo("R thigh", &mods[8], thighs, 5); ImGui::Combo("R shin", &mods[9], shins, 6);
                ImGui::SliderInt("detail tier", &tier, 0, 2);
                ImGui::SliderInt("decomposition", &decay, 0, 3);
                ImGui::SliderInt("skin", &pal[0], 0, 7); ImGui::SliderInt("top", &pal[1], 0, 8); ImGui::SliderInt("shirt", &pal[2], 0, 3);
                ImGui::SliderInt("trousers", &pal[3], 0, 5); ImGui::SliderInt("hair", &pal[4], 0, 5); ImGui::SliderInt("hat", &pal[6], 0, 4);
                if (ImGui::Button("Spawn at camera target")) {
                    LookSpec l;
                    l.head = mods[0]; l.torso = mods[1]; l.upperArmL = mods[2]; l.forearmL = mods[3]; l.upperArmR = mods[4]; l.forearmR = mods[5];
                    l.thighL = mods[6]; l.shinL = mods[7]; l.thighR = mods[8]; l.shinR = mods[9];
                    l.tier = tier; l.decayBucket = decay;
                    l.skin = pal[0]; l.top = pal[1]; l.shirt = pal[2]; l.pants = pal[3]; l.hair = pal[4]; l.tie = pal[5]; l.hat = pal[6]; l.shoe = pal[7];
                    uint32_t x, y;
                    encodeLook(l, x, y);
                    V3 t = s.camera.target();
                    s.sim.requestSpawnLook({t.x - 0.5f, t.z - 0.5f, t.x + 0.5f, t.z + 0.5f}, 1, x, y);
                }
                ImGui::TreePop();
            }
            if (ImGui::Button("Lab lineup")) s.showcaseRequested = 0;
            ImGui::SameLine();
            if (ImGui::Button("Lineup corpses")) s.showcaseRequested = 1;
            ImGui::SameLine();
            if (ImGui::Button("Random grid")) s.showcaseRequested = 2;
        }
    }
    if (ImGui::CollapsingHeader("Gore & effects", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::Checkbox("gore", &p.goreEnabled);
        ImGui::SameLine();
        ImGui::Checkbox("screen shake", &s.screenShake);
        ImGui::SameLine();
        ImGui::Checkbox("shadows", &s.renderSettings.shadows);
        ImGui::SameLine();
        ImGui::Checkbox("particles", &s.renderSettings.drawParticles);
        ImGui::SliderFloat("blood amount", &p.bloodAmount, 0.0f, 4.0f);
        ImGui::SliderFloat("dismemberment", &p.dismemberChance, 0.0f, 6.0f);
        ImGui::SliderFloat("tear-apart closeness", &p.gibThreshold, 0.3f, 1.01f);
        ImGui::SliderFloat("tumble damping", &p.tumbleDamping, 0.5f, 20.0f);
        ImGui::Text("particles %u   limbs blown off %u   torn apart %u", st.particlesAlive, st.limbsSevered, st.tornApart);
        ImGui::Text("body parts: %u spawned (%d kept)", st.gibsSpawned, p.gibCapacity);
        if (ImGui::Button("Clean up blood and body parts")) s.sim.clearGore();
    }
    if (ImGui::CollapsingHeader("Simulation parameters")) {
        ImGui::SliderInt("solver iterations", &p.solverIterations, 1, 8);
        ImGui::SliderFloat("SOR", &p.sor, 0.5f, 2.0f);
        ImGui::SliderFloat("stiffness", &p.stiffness, 0.1f, 1.0f);
        ImGui::SliderFloat("mass scaling k", &p.massScaleK, 0.0f, 4.0f);
        ImGui::SliderFloat("support friction", &p.friction, 0.0f, 1.0f);
        ImGui::SliderFloat("support cone cos", &p.supportCos, 0.3f, 0.95f);
        ImGui::SliderFloat("base speed", &p.baseSpeed, 0.2f, 5.0f);
        ImGui::SliderFloat("crawl speed", &p.crawlSpeed, 0.1f, 3.0f);
        ImGui::SliderFloat("accel", &p.accel, 0.5f, 20.0f);
        ImGui::SliderFloat("wander", &p.wander, 0.0f, 1.0f);
        ImGui::SliderFloat("density comfort", &p.densityComfort, 0.2f, 4.0f);
        ImGui::SliderFloat("density max", &p.densityMax, 1.0f, 8.0f);
        ImGui::SliderFloat("min speed factor", &p.minSpeedFactor, 0.0f, 1.0f);
        ImGui::SliderFloat("climb threshold", &p.climbBlockThreshold, 0.1f, 1.0f);
        ImGui::SliderFloat("climb speed", &p.climbSpeed, 0.2f, 4.0f);
        ImGui::SliderFloat("corpse height / splat", &p.corpseSplatHeight, 0.0f, 0.4f);
        ImGui::SliderFloat("nav density weight", &p.navDensityWeight, 0.0f, 4.0f);
        ImGui::SliderFloat("nav climb weight", &p.navClimbWeight, 0.0f, 50.0f);
        ImGui::SliderInt("nav sweeps / step", &p.navIterationsPerStep, 1, 32);
        ImGui::SliderFloat("explosion radius", &p.explosionRadius, 1.0f, 20.0f);
        ImGui::SliderFloat("explosion impulse", &p.explosionStrength, 1.0f, 40.0f);
        ImGui::SliderFloat("explosion lethality", &p.explosionLethality, 0.0f, 6.0f);
        if (ImGui::Button("Save config/sim.cfg")) p.save(s.opt.config);
        ImGui::SameLine();
        if (ImGui::Button("Reload")) { p.load(s.opt.config); }
    }
    if (ImGui::CollapsingHeader("Camera")) {
        ImGui::SliderFloat("move speed", &s.camera.settings.moveSpeed, 5.f, 100.f);
        ImGui::SliderFloat("smoothing", &s.camera.settings.smoothing, 2.f, 30.f);
        ImGui::SliderFloat("min pitch", &s.camera.settings.minPitch, 0.1f, 1.0f);
        ImGui::SliderFloat("max distance", &s.camera.settings.maxDistance, 50.f, 400.f);
        ImGui::Text("target (%.1f, %.1f) yaw %.2f pitch %.2f dist %.1f", s.camera.target().x, s.camera.target().z,
                    s.camera.yaw(), s.camera.pitch(), s.camera.distance());
    }
    ImGui::TextDisabled("WASD move, wheel zoom, MMB/Alt+LMB drag rotate, Q/E turn");
    ImGui::TextDisabled("LMB tool, Space pause, R reset, F1 UI, F12 screenshot");
    ImGui::End();
}

} // namespace ttz
