// B2 GPU counts (territory regions + wall pressure). See TerritoryGpu.h.
#include "game/TerritoryGpu.h"

#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"

#include <SDL3/SDL.h>
#include <cstring>

namespace ttz::game {

namespace {
constexpr SDL_GPUBufferUsageFlags kStorage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
constexpr uint32_t kOutWords = TerritoryGpu::kRegionSlots + TerritoryGpu::kPieceSlots;
}

bool TerritoryGpu::init(GpuContext& gpu, CrowdSim& sim) {
    gpu_ = &gpu;
    sim_ = &sim;
    pipe_ = gpu.loadCompute("game_territory", 256);
    const SimParams& p = sim.params();
    cells_ = (uint32_t)p.gridW * (uint32_t)p.gridH;
    idBuf_ = gpu.createBuffer(kStorage, cells_ * 4, "territoryIds");
    outBuf_ = gpu.createBuffer(kStorage, kOutWords * 4, "territoryCounts");
    SDL_GPUTransferBufferCreateInfo up{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, cells_ * 4, 0};
    upload_ = SDL_CreateGPUTransferBuffer(gpu.device(), &up);
    for (Slot& s : ring_) {
        SDL_GPUTransferBufferCreateInfo dn{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, kOutWords * 4, 0};
        s.tb = SDL_CreateGPUTransferBuffer(gpu.device(), &dn);
    }
    if (!pipe_ || !idBuf_ || !outBuf_ || !upload_ || !ring_[2].tb) { shutdown(); return false; }
    std::vector<uint32_t> zero(cells_, 0u);
    gpu.uploadNow(idBuf_, zero.data(), cells_ * 4);
    regions_.assign(kRegionSlots, 0u);
    pieces_.assign(kPieceSlots, 0u);
    return true;
}

void TerritoryGpu::shutdown() {
    if (!gpu_) return;
    SDL_GPUDevice* d = gpu_->device();
    SDL_WaitForGPUIdle(d);
    for (Slot& s : ring_) { if (s.tb) SDL_ReleaseGPUTransferBuffer(d, s.tb); s = Slot{}; }
    if (upload_) SDL_ReleaseGPUTransferBuffer(d, upload_);
    upload_ = nullptr;
    gpu_->releaseBuffer(idBuf_);
    gpu_->releaseBuffer(outBuf_);
    if (pipe_) SDL_ReleaseGPUComputePipeline(d, pipe_);
    pipe_ = nullptr;
    gpu_ = nullptr;
}

void TerritoryGpu::postSim(SDL_GPUCommandBuffer* cmd) {
    if (!gpu_ || !pipe_ || !cmd) return;
    SDL_GPUDevice* d = gpu_->device();
    if (idsDirty_ && ids_.size() == cells_) {   // event-driven id grid upload (cycled transfer buffer)
        if (void* m = SDL_MapGPUTransferBuffer(d, upload_, true)) {
            std::memcpy(m, ids_.data(), cells_ * 4);
            SDL_UnmapGPUTransferBuffer(d, upload_);
            SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
            SDL_GPUTransferBufferLocation src{upload_, 0};
            SDL_GPUBufferRegion dst{idBuf_, 0, cells_ * 4};
            SDL_UploadToGPUBuffer(cp, &src, &dst, true);
            SDL_EndGPUCopyPass(cp);
            gpuVersion_ = idsVersion_;
            haveIds_ = true;
        }
        idsDirty_ = false;
    }
    if (!haveIds_ || ++frame_ < kEveryFrames || !sim_->cellGridValid()) return;
    int si = -1;
    for (int i = 0; i < (int)ring_.size(); ++i) if (!ring_[i].pending) { si = i; break; }
    if (si < 0) return;
    frame_ = 0;
    SimUniforms u = sim_->uniforms();
    const uint32_t U = sizeof(SimUniforms);
    u.counts.x = kRegionSlots; u.counts.y = kPieceSlots;
    u.misc.y = 0;
    dispatch(Dispatch{cmd, pipe_, {sim_->agents(), sim_->counters(), idBuf_}, {outBuf_}, &u, U}, (kOutWords + 255) / 256);
    u.misc.y = 1;
    dispatchIndirect(Dispatch{cmd, pipe_, {sim_->agents(), sim_->counters(), idBuf_}, {outBuf_}, &u, U}, sim_->indirect(), I_AGENT_DISPATCH * 4);
    Slot& s = ring_[(size_t)si];
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUBufferRegion r{outBuf_, 0, kOutWords * 4};
    SDL_GPUTransferBufferLocation dst{s.tb, 0};
    SDL_DownloadFromGPUBuffer(cp, &r, &dst);
    SDL_EndGPUCopyPass(cp);
    s.frame = sim_->recordingFrame();
    s.version = gpuVersion_;
    s.pending = true;
    ++passes_;
}

void TerritoryGpu::harvest(bool sync) {
    if (!gpu_ || !sim_) return;
    if (sync) SDL_WaitForGPUIdle(gpu_->device());
    sim_->pollFences();
    const uint64_t done = sim_->lastCompletedFrame();
    int best = -1;
    for (int i = 0; i < (int)ring_.size(); ++i)   // newest finished slot wins; older finished ones are released
        if (ring_[i].pending && ring_[i].frame <= done && (best < 0 || ring_[i].frame > ring_[best].frame)) best = i;
    if (best < 0) return;
    for (Slot& s : ring_) if (s.pending && s.frame <= done && &s != &ring_[(size_t)best]) s.pending = false;
    Slot& s = ring_[(size_t)best];
    s.pending = false;
    const auto* b = (const uint32_t*)SDL_MapGPUTransferBuffer(gpu_->device(), s.tb, false);
    if (!b) return;
    std::memcpy(regions_.data(), b, kRegionSlots * 4);
    std::memcpy(pieces_.data(), b + kRegionSlots, kPieceSlots * 4);
    SDL_UnmapGPUTransferBuffer(gpu_->device(), s.tb);
    countsVersion_ = s.version;
    fresh_ = true;
}

} // namespace ttz::game
