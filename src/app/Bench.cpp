// Headless benchmark: for each (scenario, agent count) it warms the simulation up, then measures
// N frames. Simulation and rendering are submitted as separate command buffers and timed with
// fences (SDL3 GPU has no timestamp queries), so "GPU" times include submission + wait overhead.
#include "app/Bench.h"

#include "assets/Model.h"
#include "debug/Profiler.h"
#include "gpu/GpuContext.h"
#include "render/Renderer.h"
#include "sim/CrowdSim.h"

#include <SDL3/SDL.h>
#include <algorithm>
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
    double max() const { return v.empty() ? 0 : *std::max_element(v.begin(), v.end()); }
};

double submitAndWait(GpuContext& gpu, SDL_GPUCommandBuffer* cmd) {
    double t = nowMs();
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(gpu.device(), true, &f, 1);
    SDL_ReleaseGPUFence(gpu.device(), f);
    return nowMs() - t;
}

std::string dataPath(const std::string& rel) {
    SDL_PathInfo info;
    if (!rel.empty() && (rel[0] == '/' || rel[0] == '\\' || (rel.size() > 1 && rel[1] == ':'))) return rel;   // absolute
    if (SDL_GetPathInfo(rel.c_str(), &info)) return rel;                                                   // relative to cwd
    const char* base = SDL_GetBasePath();
    std::string p = std::string(base ? base : "") + rel;
    if (SDL_GetPathInfo(p.c_str(), &info)) return p;
#ifdef TTZ_SOURCE_DIR
    return std::string(TTZ_SOURCE_DIR) + "/" + rel;
#else
    return rel;
#endif
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
    params.agentCapacity = std::max(params.agentCapacity, maxCount + 1024);
    Sandbox sb;
    sb.build(params.cellSize, params.gridW, params.gridH);
    Model model;
    if (!model.load(dataPath("assets/models/zombie.glb"), params.standHeight)) return 2;
    CrowdSim sim;
    if (!sim.init(gpu, params, sb)) return 2;
    Renderer renderer;
    if (!renderer.init(gpu, model, sb, params, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM)) return 2;
    Camera cam;

    FILE* csv = std::fopen(o.csv.c_str(), "w");
    if (csv)
        std::fprintf(csv, "scenario,agents,live,sim_ms_avg,sim_ms_p95,sim_ms_max,render_ms_avg,render_ms_p95,cpu_record_ms,"
                          "frame_ms_avg,climbing,elevated,max_height_m,corpses,gpu_buffers_mb,rss_mb\n");
    std::printf("\nbackend: %s, resolution %dx%d, MSAA x%d, solver iterations %d, vertical %s, corpses %s\n",
                gpu.driverName(), o.width, o.height, renderer.msaaSamples(), params.solverIterations,
                params.verticalEnabled ? "on" : "off", params.corpsesEnabled ? "on" : "off");
    std::printf("| scenario | agents | sim ms avg / p95 / max | render ms avg / p95 | frame ms | climbing | elevated | max h | corpses |\n");
    std::printf("|---|---|---|---|---|---|---|---|---|\n");

    for (const std::string& scen : o.scenarios) {
        bool siege = scen == "siege";
        const Scenario& sc = sb.scenarios[siege ? 5 : 4];   // arena maps (room for 50k agents)
        if (sb.map != sc.map) {
            sb.build(params.cellSize, params.gridW, params.gridH, sc.map);
            renderer.setSandbox(sb);
        }
        for (int count : o.counts) {
            sim.reset(sb);
            sim.setGoals(sc.goals);
            Rect r = sc.spawns[0];
            if (siege) {
                // ~3.5 agents/m^2 initially, so density is comparable across counts
                float depth = std::max(10.f, count / 3.5f / (r.maxZ - r.minZ));
                r.minX = r.maxX - depth;
            }
            sim.requestSpawn(r, (uint32_t)count);
            cam.setImmediate({siege ? sb.wallX - 15.f : -30.f, 0, 0}, 0.9f, 0.75f, siege ? 70.f : 140.f);
            int warm = siege ? o.warmupSiege : o.warmupDispersed;
            for (int i = 0; i < warm; i += 30) {
                SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                for (int k = 0; k < std::min(30, warm - i); ++k) sim.step(cmd);
                submitAndWait(gpu, cmd);
            }
            Series simMs, renderMs, cpuMs, frameMs;
            for (int f = 0; f < o.measureFrames; ++f) {
                if (siege && f % 30 == 10) {   // explosions during the worst case
                    float x = sb.wallX - 4.f - (f % 60 == 10 ? 0.f : 6.f);
                    sim.requestExplosion(x, 0.4f, (f % 90 == 10) ? -3.f : 2.f);
                    renderer.addBlast(x, 0.4f, 0.f);
                }
                double c0 = nowMs();
                SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                sim.step(cmd);
                sim.writeDrawArgs(cmd, renderer.zombieIndexCount());
                sim.recordStatsReadback(cmd);
                double rec = nowMs() - c0;
                double s = submitAndWait(gpu, cmd);
                SDL_GPUFence* dummy = nullptr;
                sim.onFrameSubmitted(dummy);
                double c1 = nowMs();
                SDL_GPUCommandBuffer* rcmd = SDL_AcquireGPUCommandBuffer(gpu.device());
                renderer.update(1.f / 60.f);
                renderer.render(rcmd, nullptr, (uint32_t)o.width, (uint32_t)o.height, cam, sim, f / 60.0, RenderSettings{});
                rec += nowMs() - c1;
                double r2 = submitAndWait(gpu, rcmd);
                simMs.v.push_back(s);
                renderMs.v.push_back(r2);
                cpuMs.v.push_back(rec);
                frameMs.v.push_back(nowMs() - c0);
            }
            // exact stats (synchronous readback is fine here)
            uint32_t c[C_COUNT];
            gpu.downloadNow(sim.counters(), c, sizeof(c));
            double gpuMb = gpu.gpuBytesAllocated() / 1048576.0, rssMb = processResidentBytes() / 1048576.0;
            std::printf("| %s | %d | %.2f / %.2f / %.2f | %.2f / %.2f | %.2f | %u | %u | %.2f | %u |\n", scen.c_str(), count,
                        simMs.avg(), simMs.pct(0.95), simMs.max(), renderMs.avg(), renderMs.pct(0.95), frameMs.avg(),
                        c[C_CLIMBING], c[C_ELEVATED], c[C_MAX_HEIGHT_MM] * 0.001, c[C_CORPSES]);
            std::fflush(stdout);
            if (csv)
                std::fprintf(csv, "%s,%d,%u,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%u,%u,%.2f,%u,%.1f,%.1f\n", scen.c_str(), count,
                             c[C_LIVE], simMs.avg(), simMs.pct(0.95), simMs.max(), renderMs.avg(), renderMs.pct(0.95),
                             cpuMs.avg(), frameMs.avg(), c[C_CLIMBING], c[C_ELEVATED], c[C_MAX_HEIGHT_MM] * 0.001,
                             c[C_CORPSES], gpuMb, rssMb);
        }
    }
    if (csv) std::fclose(csv);
    std::printf("\nGPU buffers allocated by the engine: %.1f MB, process RSS: %.0f MB\n", gpu.gpuBytesAllocated() / 1048576.0,
                processResidentBytes() / 1048576.0);
    renderer.shutdown();
    sim.shutdown();
    gpu.shutdown();
    SDL_Quit();
    return 0;
}

} // namespace ttz
