#pragma once
// GPU counts for B2 (territory + wall pressure), one small pass per few frames after the simulation steps:
// game_territory.comp adds one per live zombie into the region slot and the wall piece of its sim cell (an id grid
// the CPU uploads when the territory raster, the walls or the window change: event driven, through the frame's
// command buffer). Results come back through a 3-slot readback ring released by CrowdSim's frame fences (never a
// synchronous wait). Counts carry the id-grid version they were made with; stale ones are dropped by the consumer.
#include <SDL3/SDL_gpu.h>

#include <array>
#include <cstdint>
#include <vector>

namespace ttz {
class GpuContext;
class CrowdSim;
}

namespace ttz::game {

class TerritoryGpu {
public:
    static constexpr uint32_t kRegionSlots = 1024;   // id bits 0..11 (slot + 1 < kRegionSlots counted)
    static constexpr uint32_t kPieceSlots = 8192;    // id bits 12..31 (piece + 1 < kPieceSlots counted)
    static constexpr int kEveryFrames = 3;

    bool init(GpuContext& gpu, CrowdSim& sim);
    void shutdown();
    // New id grid (sim window cells, row = z): region slot + 1 | (piece + 1) << 12. Uploaded with the next postSim.
    void setIds(std::vector<uint32_t> ids, uint64_t version) { ids_ = std::move(ids); idsVersion_ = version; idsDirty_ = true; }
    void postSim(SDL_GPUCommandBuffer* cmd);
    void harvest(bool sync);
    // Newest harvested counts (index = slot + 1 / piece + 1), with the id-grid version they were counted against.
    bool fresh() const { return fresh_; }
    void consume() { fresh_ = false; }
    const std::vector<uint32_t>& regionCounts() const { return regions_; }
    const std::vector<uint32_t>& pieceCounts() const { return pieces_; }
    uint64_t countsVersion() const { return countsVersion_; }
    uint64_t passes() const { return passes_; }

private:
    GpuContext* gpu_ = nullptr;
    CrowdSim* sim_ = nullptr;
    SDL_GPUComputePipeline* pipe_ = nullptr;
    SDL_GPUBuffer *idBuf_ = nullptr, *outBuf_ = nullptr;
    SDL_GPUTransferBuffer* upload_ = nullptr;
    uint32_t cells_ = 0;
    std::vector<uint32_t> ids_;
    uint64_t idsVersion_ = 0, gpuVersion_ = 0, countsVersion_ = 0, passes_ = 0;
    bool idsDirty_ = false, haveIds_ = false, fresh_ = false;
    int frame_ = 0;
    std::vector<uint32_t> regions_, pieces_;
    struct Slot { SDL_GPUTransferBuffer* tb = nullptr; uint64_t frame = 0, version = 0; bool pending = false; };
    std::array<Slot, 3> ring_{};
};

} // namespace ttz::game
