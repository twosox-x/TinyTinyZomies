// HordeBridge: STUB (interface step). WS-A replaces the bodies; see HordeBridge.h for the pass list.
#include "game/HordeBridge.h"

#include "sim/CrowdSim.h"

namespace ttz::game {

bool HordeBridge::init(GpuContext& gpu, CrowdSim& sim) {
    gpu_ = &gpu;
    sim_ = &sim;
    return true;
}

void HordeBridge::shutdown() {
    soldiers_.clear(); hits_.clear(); attractors_.clear(); contacts_.clear(); kills_.clear();
    gpu_ = nullptr; sim_ = nullptr;
}

void HordeBridge::reset() {
    hits_.clear(); kills_.clear(); contacts_.clear();
    field_ = ZombieField{};
    for (Slot& s : ring_) s.pending = false;
}

void HordeBridge::preSim(SDL_GPUCommandBuffer* cmd) {
    st_.hitsQueued = (uint32_t)hits_.size();
    hits_.clear();   // stub: rounds vanish (no GPU resolve yet)
}

void HordeBridge::postSim(SDL_GPUCommandBuffer* cmd, uint64_t frameIndex) {}

void HordeBridge::harvest() {}

void HordeBridge::requestExplosion(V3 pos, float scale) {
    if (sim_) sim_->requestExplosion(pos.x, pos.y, pos.z, scale);
}

bool HordeBridge::simulated(float x, float z) const {
    if (!sim_) return false;
    const SimParams& p = const_cast<CrowdSim*>(sim_)->params();
    const float x0 = sim_->originX(), z0 = sim_->originZ();
    return x >= x0 && z >= z0 && x < x0 + p.gridW * p.cellSize && z < z0 + p.gridH * p.cellSize;
}

} // namespace ttz::game
