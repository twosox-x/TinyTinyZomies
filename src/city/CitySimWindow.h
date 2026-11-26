#pragma once
// Moving simulation window for the baked city: the horde simulation's fixed-size grid (CityWorld) follows the
// camera pivot in steps of `stepCells`, so zombies, blood, corpses and moon shadows exist wherever the player looks.
//
//  main thread (update, once per frame)          worker thread
//  ------------------------------------          -------------
//  pivot > trigger from the window centre  ->    static heights of the new window (+ shadow margin) from the
//                                                tiles' HGT0 grids (own cache, decoded from disk with
//                                                CityAsset::decodeTileNow, so it does not depend on what the
//                                                renderer has resident); moon-shadow samples of the newly exposed
//                                                strips only (the overlap is copied: see cityShadowField)
//  shadow field uploaded into the standby GPU  <-  done
//  buffer, `uploadBudget` bytes per frame
//  commit: CrowdSim::relocate (GPU shift of the grid fields, new static heights, agents parked / restored),
//  renderer origin + shadow buffer swapped, all in the same command buffer
#include "city/CityAsset.h"
#include "gpu/GpuContext.h"

#include <atomic>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace ttz {

class CrowdSim;
class Renderer;
struct Sandbox;

struct SimWindowStats {
    int relocations = 0, discarded = 0;
    double lastJobMs = 0, maxJobMs = 0, lastCommitCpuMs = 0, maxCommitCpuMs = 0;
    int tilesCached = 0;
    bool busy = false;
};

class CitySimWindow {
public:
    ~CitySimWindow() { shutdown(); }
    // Synchronous first build for the window of `sb` (Baked sandbox from buildCityWindow): computes the moon-shadow
    // field, creates the two GPU shadow buffers and points the renderer at the window. Starts the worker.
    bool init(GpuContext& gpu, const CityAsset& city, const Sandbox& sb, Renderer& renderer);
    void shutdown();
    // Per frame, before the simulation steps are recorded into cmd. Returns true when the window moved this frame
    // (the caller's Sandbox copy is updated through `sb`).
    bool update(SDL_GPUCommandBuffer* cmd, float pivotX, float pivotZ, CrowdSim& sim, Renderer& renderer, Sandbox& sb);
    // Window back to `sb` (scenario reset): synchronous, the simulation must be reset with `sb` afterwards.
    void resetTo(const Sandbox& sb, Renderer& renderer);

    float originX() const { return ox_; }
    float originZ() const { return oz_; }
    const SimWindowStats& stats() const { return stats_; }

    int stepCells = 64;                 // the window moves in multiples of this (48 m at 0.75 m)
    float triggerFraction = 0.25f;      // start a move when the pivot is this fraction of the window off-centre
    uint32_t uploadBudget = 2u << 20;   // shadow-field bytes uploaded per frame
    bool enabled = true;

private:
    struct Job {
        float ox = 0, oz = 0, prevX = 0, prevZ = 0;
        std::shared_ptr<const std::vector<float>> prevShadow;   // null: compute every sample
        std::vector<float> heights;                             // out: gw x gh
        std::shared_ptr<std::vector<float>> shadow;             // out: 3gw x 3gh
        double ms = 0, rasterMs = 0;
        int tilesCached = 0;
    };
    double lastRasterMs_ = 0;
    void compute(Job& job);             // worker (or main thread before the worker starts)
    const TileCPU* tile(int i, int j);
    void workerLoop();
    void uploadShadowNow(SDL_GPUBuffer* dst, const std::vector<float>& field);

    GpuContext* gpu_ = nullptr;
    const CityAsset* city_ = nullptr;
    float cell_ = 0.75f;
    int gw_ = 0, gh_ = 0;
    float ox_ = 0, oz_ = 0;
    std::shared_ptr<const std::vector<float>> shadow_;   // CPU copy of the current window's field
    SDL_GPUBuffer* shadowBuf_[2] = {nullptr, nullptr};
    int shadowCur_ = 0;
    SDL_GPUTransferBuffer* staging_ = nullptr;

    // tile height cache (worker thread only after init)
    std::map<std::pair<int, int>, std::unique_ptr<TileCPU>> tiles_;

    enum class State { Idle, Computing, Uploading };
    State state_ = State::Idle;
    uint32_t uploaded_ = 0;
    std::unique_ptr<Job> job_;
    std::thread thread_;
    std::mutex m_;
    std::condition_variable cv_;
    bool quit_ = false, hasJob_ = false, jobDone_ = false;
    SimWindowStats stats_;
};

} // namespace ttz
