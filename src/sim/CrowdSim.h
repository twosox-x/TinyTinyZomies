#pragma once
// GPU-resident hybrid crowd simulation: individual agents + uniform grid (counting sort)
// + density field + shared navigation field + position-based contacts with vertical support
// + persistent corpse height field. All state lives on the GPU; the CPU only records commands,
// pushes small uniform blocks (spawn requests, explosions, goals) and reads statistics back
// asynchronously a few frames late.
#include "gpu/GpuContext.h"
#include "sim/GpuTypes.h"
#include "sim/Sandbox.h"
#include "sim/SimParams.h"

#include <array>
#include <vector>

namespace ttz {

struct SimStats {
    uint32_t live = 0, corpses = 0, deaths = 0, climbing = 0, airborne = 0, elevated = 0, reactivated = 0;
    uint32_t corpseOverflow = 0;
    uint32_t particlesAlive = 0, gibsSpawned = 0, limbsSevered = 0, tornApart = 0;
    uint32_t parked = 0, parkDropped = 0;   // moving window: agents waiting outside it / despawned (parked list full)
    float maxStackHeight = 0.f;
    uint64_t frameOfData = 0;
};

class CrowdSim {
public:
    bool init(GpuContext& gpu, const SimParams& p, const Sandbox& sb);
    void shutdown();
    void reset(const Sandbox& sb);          // clears agents, corpses, nav; re-uploads static geometry

    void requestSpawn(const Rect& r, uint32_t count);
    // spawn with a fixed appearance (showcase / validation) or as settling corpses (benchmarks / tests)
    void requestSpawnLook(const Rect& r, uint32_t count, uint32_t lookX, uint32_t lookY, bool asCorpse = false);
    void requestSpawnCorpses(const Rect& r, uint32_t count);
    // scale: blast radius / strength / effect size multiplier (vehicles: 1-2.2). Every accepted explosion is also
    // appended to explosionLog() (consumers such as CityVehicles take it once per frame).
    void requestExplosion(float x, float y, float z, float scale = 1.f);
    // Flames + smoke only (a burning vehicle, footprint `size` m): uses explosion slots left free in the next step.
    void requestFire(float x, float y, float z, float size);
    struct ExplosionEvent { float x, y, z, scale; };
    std::vector<ExplosionEvent> takeExplosionLog() { std::vector<ExplosionEvent> v; v.swap(explosionLog_); return v; }
    // Rows [z0, z0 + rows) of the static height grid (gridW floats per row), recorded into cmd (dynamic obstacles).
    void uploadStaticRows(SDL_GPUCommandBuffer* cmd, uint32_t z0, uint32_t rows, const float* data);
    void setGoals(const std::vector<float>& xz);
    const std::vector<float>& goals() const { return goals_; }

    // Records one fixed simulation step into cmd.
    void step(SDL_GPUCommandBuffer* cmd);
    // Records draw-argument generation (after the last step of a frame).
    void writeDrawArgs(SDL_GPUCommandBuffer* cmd, uint32_t zombieIndexCount);

    // Async statistics readback (never blocks).
    void recordStatsReadback(SDL_GPUCommandBuffer* cmd);
    void onFrameSubmitted(SDL_GPUFence* fence);   // takes ownership of the fence
    const SimStats& stats() const { return stats_; }
    // Another GPU buffer to download in the same async readback (e.g. character render counters).
    void setExtraReadback(SDL_GPUBuffer* buf, uint32_t bytes) { extraBuf_ = buf; extraBytes_ = bytes; extra_.assign(bytes / 4, 0); }
    const std::vector<uint32_t>& extraReadback() const { return extra_; }

    SimParams& params() { return p_; }
    double simTime() const { return simTime_; }
    uint64_t stepIndex() const { return stepIndex_; }

    // Buffers for rendering / tests
    SDL_GPUBuffer* agents() const { return agentsA_; }
    SDL_GPUBuffer* corpses() const { return corpses_; }
    SDL_GPUBuffer* indirect() const { return indirect_; }
    SDL_GPUBuffer* counters() const { return counters_; }
    SDL_GPUBuffer* density() const { return density_; }
    SDL_GPUBuffer* navDist() const { return navDist_[0]; }
    SDL_GPUBuffer* navDir() const { return navDir_; }
    SDL_GPUBuffer* corpseHeight() const { return corpseH_; }
    SDL_GPUBuffer* staticHeight() const { return staticH_; }
    uint32_t numCells() const { return (uint32_t)(p_.gridW * p_.gridH); }
    // gore (see shaders/include/gore.glsl)
    SDL_GPUBuffer* particles() const { return particles_; }
    SDL_GPUBuffer* particleList() const { return particleList_; }
    SDL_GPUBuffer* gibs() const { return gibs_; }
    SDL_GPUBuffer* goreCounters() const { return gore_; }
    SDL_GPUBuffer* decals() const { return decals_; }
    uint32_t gibCapacity() const { return (uint32_t)p_.gibCapacity; }
    uint32_t decalW() const { return (uint32_t)p_.gridW * kDecalScale; }
    uint32_t decalH() const { return (uint32_t)p_.gridH * kDecalScale; }
    void clearGore();                       // remove all blood, parts, particles and scorch marks

    // Moving simulation window (city): moves the grid by (dx, dz) cells, recorded into cmd before the next step().
    // Persistent grid fields (corpse heights, navigation distance, density, flow, blood / wall blood / scorch decals)
    // are shifted on the GPU, newly exposed strips cleared; `staticHeights` (gridW x gridH, the new window) is
    // uploaded; corpses re-splat their height into the exposed strips. Live agents leaving the window are parked
    // (frozen, not drawn) in a GPU list and rejoin unchanged when the window covers them again.
    void relocate(SDL_GPUCommandBuffer* cmd, int dx, int dz, const std::vector<float>& staticHeights);
    float originX() const { return sandbox_.originX; }
    float originZ() const { return sandbox_.originZ; }
    SDL_GPUBuffer* parkedAgents() const { return park_[parkIn_]; }
    SDL_GPUBuffer* parkCounts() const { return parkCnt_; }   // uint[0], [1]: list counts (parkedList() selects), [2]: dropped
    uint32_t parkedList() const { return (uint32_t)parkIn_; }

    struct Timing { double cpuRecordMs = 0; };

private:
    SimUniforms baseUniforms() const;
    bool createPipelines();

    GpuContext* gpu_ = nullptr;
    SimParams p_;
    Sandbox sandbox_;

    SDL_GPUComputePipeline *pSpawn_ = nullptr, *pCorpseBlast_ = nullptr, *pCommitAppend_ = nullptr, *pClear_ = nullptr,
                           *pPredict_ = nullptr, *pScanLocal_ = nullptr, *pScanBlocks_ = nullptr, *pScanAdd_ = nullptr,
                           *pScatter_ = nullptr, *pCommitSort_ = nullptr, *pSolve_ = nullptr, *pFinalize_ = nullptr,
                           *pDensity_ = nullptr, *pNavRelax_ = nullptr, *pNavDir_ = nullptr, *pDrawArgs_ = nullptr,
                           *pGore_ = nullptr, *pShift_ = nullptr, *pRelocate_ = nullptr;

    SDL_GPUBuffer *agentsA_ = nullptr, *agentsB_ = nullptr, *posP_ = nullptr, *posQ_ = nullptr, *prevS_ = nullptr,
                  *contactAux_ = nullptr, *cellLocal_ = nullptr, *cellCount_ = nullptr, *cellStart_ = nullptr,
                  *blockSums_ = nullptr, *density_ = nullptr, *staticH_ = nullptr, *corpseH_ = nullptr,
                  *navDist_[2] = {nullptr, nullptr}, *navDir_ = nullptr, *corpses_ = nullptr, *counters_ = nullptr,
                  *indirect_ = nullptr, *particles_ = nullptr, *particleList_ = nullptr, *gibs_ = nullptr, *gore_ = nullptr,
                  *decals_ = nullptr, *park_[2] = {nullptr, nullptr}, *parkCnt_ = nullptr, *shiftScratch_ = nullptr;
    int parkIn_ = 0;
    uint32_t parkCapacity_ = 0;
    void shiftField(SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* buf, uint32_t w, uint32_t h, uint32_t words, uint32_t layers, int sx,
                    int sz, uint32_t fill);

    std::vector<float> goals_;
    struct SpawnRequest { Rect rect; uint32_t count; uint32_t lookX = 0, lookY = 0; bool forced = false, corpse = false; };
    std::vector<SpawnRequest> pendingSpawns_;   // one request is consumed per step
    std::vector<std::array<float, 4>> pendingExplosions_;
    std::vector<std::array<float, 4>> pendingFires_;
    std::vector<ExplosionEvent> explosionLog_;
    double simTime_ = 0.0;
    uint64_t stepIndex_ = 0;
    uint32_t spawnSeed_ = 1;

    struct Readback { SDL_GPUTransferBuffer* tb = nullptr; SDL_GPUFence* fence = nullptr; bool recorded = false; uint64_t frame = 0; };
    std::array<Readback, 3> rb_{};
    int rbRecordSlot_ = -1;
    uint64_t frameCounter_ = 0;
    SimStats stats_;
    SDL_GPUBuffer* extraBuf_ = nullptr;
    uint32_t extraBytes_ = 0;
    std::vector<uint32_t> extra_;
};

} // namespace ttz
