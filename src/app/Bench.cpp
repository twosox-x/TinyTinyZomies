// Headless benchmark. For every (configuration, scenario, count): reset, spawn, warm up, then measure N
// frames. Each frame is three separately submitted command buffers, each waited on with a fence:
//   sim   = one fixed simulation step (+ draw-arg generation)
//   char  = character culling / compaction / pose passes (modular characters only)
//   draw  = the scene render pass (ground, buildings, characters) at the chosen resolution
// SDL3 GPU has no timestamp queries, so GPU times include submission and fence latency.
// Exact counters (visible characters, segments, triangles, vertex invocations) are read back after
// measuring (synchronous reads are acceptable here, never in gameplay).
#include "app/Bench.h"

#include "assets/Model.h"
#include "debug/Profiler.h"
#include "gpu/GpuContext.h"
#include "render/CharacterRenderer.h"
#include "render/Math.h"
#include "render/Renderer.h"
#include "sim/CrowdSim.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <numeric>

namespace ttz {

namespace {
struct Series {
    std::vector<double> v;
    double avg() const { return v.empty() ? 0 : std::accumulate(v.begin(), v.end(), 0.0) / v.size(); }
    double pct(double p) const {
        if (v.empty()) return 0;
        auto s = v;
        std::sort(s.begin(), s.end());
        return s[std::min(s.size() - 1, (size_t)(p * s.size()))];
    }
    double worstAvg(double frac) const {   // mean of the worst `frac` of samples (for 1 % lows)
        if (v.empty()) return 0;
        auto s = v;
        std::sort(s.begin(), s.end(), std::greater<double>());
        size_t n = std::max<size_t>(1, (size_t)(s.size() * frac));
        return std::accumulate(s.begin(), s.begin() + n, 0.0) / n;
    }
};

double submitAndWait(GpuContext& gpu, SDL_GPUCommandBuffer* cmd) {
    double t = nowMs();
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
    SDL_ReleaseGPUFence(gpu.device(), f);
    return nowMs() - t;
}

// Occlusion study (city scenario): fraction of frustum-visible zombies that buildings hide completely.
// Conservative: a zombie counts as occluded only if rays to its feet, its head and its sides are all blocked
// by static geometry (DDA through the building height grid). Measures the upper bound of what an
// occlusion-culling system could save before building one.
double occludedFraction(GpuContext& gpu, CrowdSim& sim, const Sandbox& sb, const Camera& cam, float aspect, uint32_t live) {
    if (!live) return 0;
    std::vector<GpuAgent> ag(live);
    gpu.downloadNow(sim.agents(), ag.data(), live * sizeof(GpuAgent));
    std::vector<float> h = sb.rasterize();
    M4 vp = mul(cam.proj(aspect), cam.view());
    V3 eye = cam.eye();
    auto blocked = [&](V3 to) {
        V3 d = to - eye;
        float len = std::sqrt(dot(d, d));
        int steps = (int)(len / (sb.cellSize * 0.5f)) + 1;
        for (int i = 1; i < steps; ++i) {
            V3 p = eye + d * ((float)i / steps);
            int cx = (int)std::floor((p.x - sb.originX) / sb.cellSize), cz = (int)std::floor((p.z - sb.originZ) / sb.cellSize);
            if (cx < 0 || cz < 0 || cx >= sb.gridW || cz >= sb.gridH) continue;
            if (p.y < h[(size_t)cz * sb.gridW + cx]) return true;
        }
        return false;
    };
    uint32_t inFrustum = 0, occluded = 0;
    for (auto& a : ag) {
        V3 c{a.pos.x, a.pos.y + 0.9f, a.pos.z};
        float clip[4] = {0, 0, 0, 0};
        for (int r = 0; r < 4; ++r) clip[r] = vp(r, 0) * c.x + vp(r, 1) * c.y + vp(r, 2) * c.z + vp(r, 3);
        if (clip[3] <= 0 || std::fabs(clip[0]) > clip[3] * 1.05f || std::fabs(clip[1]) > clip[3] * 1.05f) continue;
        ++inFrustum;
        V3 pts[4] = {{a.pos.x, a.pos.y + 0.05f, a.pos.z}, {a.pos.x, a.pos.y + 1.75f, a.pos.z},
                     {a.pos.x + 0.3f, a.pos.y + 1.f, a.pos.z}, {a.pos.x - 0.3f, a.pos.y + 1.f, a.pos.z + 0.3f}};
        bool all = true;
        for (auto& p : pts) if (!blocked(p)) { all = false; break; }
        occluded += all;
    }
    return inFrustum ? (double)occluded / inFrustum : 0.0;
}

std::string dataPath(const std::string& rel) {
    SDL_PathInfo info;
    if (!rel.empty() && (rel[0] == '/' || rel[0] == '\\' || (rel.size() > 1 && rel[1] == ':'))) return rel;
    if (SDL_GetPathInfo(rel.c_str(), &info)) return rel;
    const char* base = SDL_GetBasePath();
    std::string p = std::string(base ? base : "") + rel;
    if (SDL_GetPathInfo(p.c_str(), &info)) return p;
#ifdef TTZ_SOURCE_DIR
    return std::string(TTZ_SOURCE_DIR) + "/" + rel;
#else
    return rel;
#endif
}

bool applyConfig(const std::string& name, RenderSettings& rs) {
    rs = RenderSettings{};
    CharacterSettings& c = rs.chars;
    if (name == "placeholder") { rs.characterModel = 0; return true; }
    rs.characterModel = 1;
    if (name == "naive")        { c.geometryLevel = 0; c.poseInVertexShader = true;  c.classMode = 0; c.frustumCull = false; return true; }
    if (name == "culled")       { c.geometryLevel = 1; c.poseInVertexShader = false; c.classMode = 0; c.frustumCull = false; return true; }
    if (name == "greedy")       { c.geometryLevel = 2; c.poseInVertexShader = false; c.classMode = 0; c.frustumCull = false; return true; }
    if (name == "classes")      { c.geometryLevel = 2; c.poseInVertexShader = false; c.classMode = 1; c.frustumCull = false; return true; }
    if (name == "culling")      { c.geometryLevel = 2; c.poseInVertexShader = false; c.classMode = 1; c.frustumCull = true;  return true; }
    if (name == "final")        { c.geometryLevel = 3; c.poseInVertexShader = false; c.classMode = 1; c.frustumCull = true;  return true; }
    if (name == "final-posevs") { c.geometryLevel = 3; c.poseInVertexShader = true;  c.classMode = 1; c.frustumCull = true;  return true; }
    return false;
}
} // namespace

int runBenchmarks(const BenchOptions& o) {
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "offscreen");
        if (!SDL_Init(SDL_INIT_VIDEO)) return 2;
    }
    GpuContext gpu;
    if (!gpu.init(nullptr, o.gpuDebug)) return 2;
    SimParams params;
    params.load(dataPath(o.config));
    int maxCount = *std::max_element(o.counts.begin(), o.counts.end());
    params.agentCapacity = std::max(params.agentCapacity, maxCount + 4096);
    Sandbox sb;
    sb.build(params.cellSize, params.gridW, params.gridH);
    Model model;
    if (!model.load(dataPath("assets/models/zombie.glb"), params.standHeight)) return 2;
    CrowdSim sim;
    if (!sim.init(gpu, params, sb)) return 2;
    Renderer renderer;
    if (!renderer.init(gpu, model, sb, params, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM)) return 2;
    CharacterRenderer chars;
    if (!chars.init(gpu, params, dataPath("assets/characters/zombie_parts.ttzc"), (uint32_t)params.visibleCharacterCapacity)) return 2;
    renderer.skipCharacterPrepare_ = true;   // recorded separately so it can be timed
    Camera cam;
    cam.settings.maxDistance = 400.f;

    FILE* csv = std::fopen(o.csv.c_str(), "w");
    if (csv)
        std::fprintf(csv, "config,scenario,agents,live,corpses_settled,bodies_active,visible_chars,draw_calls,segments,triangles,vs_invocations,"
                          "sim_ms,char_ms,draw_ms,frame_ms_avg,frame_ms_median,frame_ms_p95,frame_ms_p99,fps_avg,fps_1pct_low,cpu_record_ms,"
                          "climbing,elevated,max_height_m,gpu_buffers_mb\n");
    std::printf("\nbackend: %s, %dx%d, MSAA x%d, solver iterations %d, vertical %s, corpses %s, %d measured frames\n",
                gpu.driverName(), o.width, o.height, renderer.msaaSamples(), params.solverIterations,
                params.verticalEnabled ? "on" : "off", params.corpsesEnabled ? "on" : "off", o.measureFrames);
    std::printf("| config | scenario | agents | visible | draws | triangles | sim ms | char ms | draw ms | frame ms avg / p95 / p99 | fps avg / 1%% low |\n");
    std::printf("|---|---|---|---|---|---|---|---|---|---|---|\n");

    for (const std::string& cfgName : o.configs) {
        RenderSettings rs;
        if (!applyConfig(cfgName, rs)) { std::printf("unknown config %s\n", cfgName.c_str()); continue; }
        for (const std::string& scen : o.scenarios) {
            for (int count : o.counts) {
                // ---- scenario setup
                bool siege = scen == "siege", city = scen == "city", offscreen = scen == "offscreen", corpses = scen == "corpses";
                if (city && count > 15000) continue;                    // the city streets cannot hold more
                MapKind map = city ? MapKind::City : MapKind::Arena;
                if (sb.map != map) {
                    sb.build(params.cellSize, params.gridW, params.gridH, map);
                    renderer.setSandbox(sb);
                }
                sim.reset(sb);
                const Scenario& sc = sb.scenarios[city ? 3 : siege ? 5 : 4];
                sim.setGoals(sc.goals);
                Rect r = sc.spawns[0];
                if (siege) r.minX = r.maxX - std::max(10.f, count / 3.5f / (r.maxZ - r.minZ));   // ~3.5 agents / m^2
                if (corpses) {
                    // a large persistent corpse field (spawned as settling bodies) plus 2000 living zombies
                    sim.requestSpawnCorpses(Rect{-90.f, -90.f, sb.wallX - 5.f, 90.f}, (uint32_t)count);
                    sim.requestSpawn(r, 2000);
                } else {
                    sim.requestSpawn(r, (uint32_t)count);
                }
                if (siege) cam.setImmediate({sb.wallX - 15.f, 0, 0}, 0.9f, 0.75f, 70.f);
                else if (city) cam.setImmediate({-20.f, 0, 0}, -1.45f, 0.45f, 60.f);      // along the avenue, buildings occlude
                else if (offscreen) cam.setImmediate({sb.wallX + 20.f, 0, 60.f}, 0.2f, 0.4f, 40.f);   // looking away from the horde
                else cam.setImmediate({-30.f, 0, 0}, 0.9f, 0.75f, 140.f);
                int warm = siege ? o.warmupSiege : o.warmupDispersed;
                if (corpses) warm = std::max(warm, 20);
                for (int i = 0; i < warm; i += 30) {
                    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                    for (int k = 0; k < std::min(30, warm - i); ++k) sim.step(cmd);
                    submitAndWait(gpu, cmd);
                }
                // ---- measure
                Series simMs, charMs, drawMs, frameMs, cpuMs;
                for (int f = 0; f < o.measureFrames; ++f) {
                    if (siege && f % 10 == 5) {   // repeated explosions in the horde during the worst case
                        float x = sb.wallX - 4.f - (f % 20 == 5 ? 0.f : 6.f);
                        sim.requestExplosion(x, 0.4f, (f % 30 == 5) ? -12.f : 10.f);
                        renderer.addBlast(x, 0.4f, 0.f);
                    }
                    double t0 = nowMs();
                    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                    sim.step(cmd);
                    sim.writeDrawArgs(cmd, renderer.zombieIndexCount());
                    double rec = nowMs() - t0;
                    simMs.v.push_back(submitAndWait(gpu, cmd));
                    double t1 = nowMs();
                    SDL_GPUCommandBuffer* ccmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                    renderer.prepareCharacters(ccmd, (uint32_t)o.width, (uint32_t)o.height, cam, sim, f / 60.0, rs, &chars);
                    rec += nowMs() - t1;
                    charMs.v.push_back(submitAndWait(gpu, ccmd));
                    double t2 = nowMs();
                    SDL_GPUCommandBuffer* rcmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                    renderer.update(1.f / 60.f);
                    renderer.render(rcmd, nullptr, (uint32_t)o.width, (uint32_t)o.height, cam, sim, f / 60.0, rs, &chars);
                    rec += nowMs() - t2;
                    drawMs.v.push_back(submitAndWait(gpu, rcmd));
                    cpuMs.v.push_back(rec);
                    frameMs.v.push_back(nowMs() - t0);
                }
                uint32_t c[C_COUNT];
                gpu.downloadNow(sim.counters(), c, sizeof(c));
                CharacterStats cst;
                if (rs.characterModel == 1) chars.readStatsNow(cst);
                uint32_t live = c[C_LIVE];
                uint32_t visible = rs.characterModel == 1 ? cst.visible : live + std::min<uint32_t>(c[C_CORPSES], params.corpseCapacity);
                uint32_t tris = rs.characterModel == 1 ? cst.triangles : visible * (renderer.zombieIndexCount() / 3);
                uint32_t invoc = rs.characterModel == 1 ? cst.vsInvocations : visible * renderer.zombieIndexCount();
                uint32_t draws = renderer.drawCalls(rs, &chars);
                if (city && cfgName == "final")
                    std::printf("  occlusion study (city): %.1f %% of frustum-visible zombies are completely hidden by buildings\n",
                                100.0 * occludedFraction(gpu, sim, sb, cam, (float)o.width / o.height, live));
                double fpsAvg = 1000.0 / frameMs.avg(), fpsLow = 1000.0 / frameMs.worstAvg(0.01);
                std::printf("| %s | %s | %d | %u | %u | %u | %.2f | %.2f | %.2f | %.1f / %.1f / %.1f | %.2f / %.2f |\n", cfgName.c_str(),
                            scen.c_str(), count, visible, draws, tris, simMs.avg(), charMs.avg(), drawMs.avg(), frameMs.avg(),
                            frameMs.pct(0.95), frameMs.pct(0.99), fpsAvg, fpsLow);
                std::fflush(stdout);
                if (csv)
                    std::fprintf(csv, "%s,%s,%d,%u,%u,%u,%u,%u,%u,%u,%u,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%u,%u,%.2f,%.1f\n",
                                 cfgName.c_str(), scen.c_str(), count, live, std::min<uint32_t>(c[C_CORPSES], params.corpseCapacity),
                                 c[C_AIRBORNE], visible, draws, cst.segments, tris, invoc, simMs.avg(), charMs.avg(), drawMs.avg(),
                                 frameMs.avg(), frameMs.pct(0.5), frameMs.pct(0.95), frameMs.pct(0.99), fpsAvg, fpsLow, cpuMs.avg(),
                                 c[C_CLIMBING], c[C_ELEVATED], c[C_MAX_HEIGHT_MM] * 0.001, gpu.gpuBytesAllocated() / 1048576.0);
                if (csv) std::fflush(csv);
            }
        }
    }
    if (csv) std::fclose(csv);
    std::printf("\nGPU buffers allocated by the engine: %.1f MB (character asset %.1f MB), process RSS: %.0f MB\n",
                gpu.gpuBytesAllocated() / 1048576.0, chars.assetBytes() / 1048576.0, processResidentBytes() / 1048576.0);
    chars.shutdown();
    renderer.shutdown();
    sim.shutdown();
    gpu.shutdown();
    SDL_Quit();
    return 0;
}

} // namespace ttz
