#include "debug/DebugUI.h"

#include "app/App.h"
#include "imgui.h"

namespace ttz {

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
                ImGui::Text("visible %u of %u (%u zombies, %u corpses)", st.visible, s.sim.stats().live + s.sim.stats().corpses,
                            st.visibleAgents, st.visibleCorpses);
                ImGui::Text("segments %u  triangles %.2fM  VS invocations %.2fM", st.segments, st.triangles / 1e6, st.vsInvocations / 1e6);
                if (st.overflow) ImGui::TextColored(ImVec4(1, 0.4f, 0.3f, 1), "render capacity exceeded: %u not drawn", st.overflow);
            }
            ImGui::Text("draw calls: %u (characters %u)", s.renderer.drawCalls(rs, &s.chars), s.chars.drawCalls(cs));
            const char* geo[] = {"naive cubes", "hidden faces removed", "greedy by material", "greedy + voxel materials"};
            ImGui::Combo("geometry", &cs.geometryLevel, geo, 4);
            const char* cls[] = {"per body-part family", "vertex-count size classes"};
            ImGui::Combo("batching", &cs.classMode, cls, 2);
            ImGui::Checkbox("frustum culling", &cs.frustumCull);
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
            if (ImGui::Button("Lab lineup")) s.showcaseRequested = 0;
            ImGui::SameLine();
            if (ImGui::Button("Lineup corpses")) s.showcaseRequested = 1;
            ImGui::SameLine();
            if (ImGui::Button("Random grid")) s.showcaseRequested = 2;
        }
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
