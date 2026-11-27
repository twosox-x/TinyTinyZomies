#pragma once
// GPU implementation of HordeInterface (WS-A). Owns every GPU resource of the gameplay <-> horde coupling.
//
// Per frame, recorded into the frame's command buffer (App::frame, through GameWorld):
//   preSim(cmd)   [before the first CrowdSim::step of the frame]
//     copy pass   : soldiers (HordeSoldier[]), hit requests, attractors -> GPU (one cycled transfer buffer, no allocs)
//     game_stamp  : clear last tick's soldier cells, stamp soldier indices into soldierCell[] (sim grid, for sim_solve)
//     game_hits   : one thread per HitRequest: DDA along the ray through sim cells; per cell, the agents of the cell
//                   (cellStart / agentsA of the last step, re-sorted order is consistent until the next scatter);
//                   first capsule hit -> atomicAdd(damage[agent], fixed point), atomicMax(lastHitter[agent]);
//                   static height above the ray -> stopped (impact point for FX)
//   CrowdSim::step x N (sim_predict applies damage[i] through the existing explosion-damage path: health, blood,
//                   dismember, DYING; on the alive -> DYING transition it appends a KillRecord {seq = atomicAdd(
//                   killSeq), shooter = lastHitter[i], pos}; damage / lastHitter cleared. Exactly one thread sees the
//                   transition of an agent, and reactivated corpses re-enter as DYING, so a kill is emitted once.)
//                   sim_solve pushes zombies out of soldier capsules (soldierCell[] 3x3 lookup, infinite mass).
//                   nav_relax seeds attractors (distance offset = -strength), nav_dir zeroes the flow beyond
//                   ThreatConfig.awarenessRadius of every attractor (zombies far from the action wander).
//   postSim(cmd)  [after the last step, before CrowdSim::writeDrawArgs]
//     game_field  : indirect over live agents: per 6 m tile atomic count, first kFieldSamples walker positions
//     game_contacts: one thread per soldier: attackers within reach (3x3 cells), nearby within 8 m (coarse tiles)
//     copy pass   : [header | kill records | contacts | field] -> readback ring slot (3 slots)
//   harvest()     [after submit, next frames] : slots whose frame <= CrowdSim::lastCompletedFrame() are mapped and
//                   parsed (no fence of its own: CrowdSim owns the frame fence; WS-A adds lastCompletedFrame()).
//
// Required CrowdSim / shader changes (all WS-A, see docs/GAMEPLAY_ARCHITECTURE.md 3.3):
//   CrowdSim: accessors cellStart()/cellCount(), lastCompletedFrame(); bindings for damage / lastHitter / kill ring /
//   soldierCell / attractors in predict, solve, nav_relax, nav_dir; reset() clears them; relocate() clears damage.
//   Agent layout stays 80 B (no new per-agent field: damage / lastHitter are separate cap-sized uint buffers).
#include "game/HordeInterface.h"

#include <SDL3/SDL_gpu.h>
#include <array>

namespace ttz {
class GpuContext;
class CrowdSim;
}

namespace ttz::game {

class HordeBridge final : public HordeInterface {
public:
    bool init(GpuContext& gpu, CrowdSim& sim);
    void shutdown();
    void reset();                                   // scenario reset / sim reset: clears rings, seq continues

    // frame hooks (GameWorld calls them; GameWorld is called by App::frame)
    void preSim(SDL_GPUCommandBuffer* cmd);
    void postSim(SDL_GPUCommandBuffer* cmd, uint64_t frameIndex);
    void harvest();                                 // non-blocking; call once per frame after submit

    // HordeInterface
    void uploadSoldiers(const std::vector<HordeSoldier>& soldiers) override { soldiers_ = soldiers; }
    void queueHits(const std::vector<HitRequest>& hits) override { hits_.insert(hits_.end(), hits.begin(), hits.end()); }
    void setAttractors(const std::vector<Attractor>& a) override { attractors_ = a; }
    void requestExplosion(V3 pos, float scale) override;
    const ZombieField& field() const override { return field_; }
    const std::vector<SoldierContact>& contacts() const override { return contacts_; }
    void takeKills(std::vector<KillEvent>& out) override { out.insert(out.end(), kills_.begin(), kills_.end()); kills_.clear(); }
    uint64_t killsOverflowed() const override { return killsOverflowed_; }
    bool simulated(float x, float z) const override;

    struct Stats { uint32_t hitsQueued = 0, hitsResolved = 0, killsHarvested = 0, latencyFrames = 0; double cpuMs = 0; };
    const Stats& stats() const { return st_; }

private:
    GpuContext* gpu_ = nullptr;
    CrowdSim* sim_ = nullptr;
    std::vector<HordeSoldier> soldiers_;
    std::vector<HitRequest> hits_;
    std::vector<Attractor> attractors_;
    ZombieField field_;
    std::vector<SoldierContact> contacts_;
    std::vector<KillEvent> kills_;
    uint64_t lastKillSeq_ = 0, killsOverflowed_ = 0;
    Stats st_;
    // GPU resources (created by WS-A): pipelines game_stamp / game_hits / game_field / game_contacts, buffers
    // soldiers, hits, attractors, soldierCell, damage, lastHitter, killRing, field, contacts, readback ring.
    struct Slot { SDL_GPUTransferBuffer* tb = nullptr; uint64_t frame = 0; bool pending = false; };
    std::array<Slot, 3> ring_{};
};

} // namespace ttz::game
