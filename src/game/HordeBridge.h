#pragma once
// GPU implementation of HordeInterface (WS-A). Owns every GPU resource of the gameplay <-> horde coupling.
//
// Per frame, recorded into the frame's command buffer (App::frame, through GameWorld):
//   preSim(cmd)   [before the first CrowdSim::step of the frame]
//     copy pass   : soldiers (HordeSoldier[]), hit requests, attractors -> GPU (one cycled transfer buffer, no allocs)
//     game_stamp  : clear last tick's soldier cells, stamp soldier indices into soldierCell[] (sim grid, for sim_solve)
//     game_hits   : one thread per HitRequest: DDA along the ray through sim cells; per cell, the agents of the cell
//                   (cellStart / agentsA of the last step, re-sorted order is consistent until the next scatter);
//                   first live capsule hit -> gameIO damage[agent] {atomicAdd damage (1/65536), atomicOr flags +
//                   count, atomicMax shooter, last dir}; static height above the ray -> stopped (hitResults())
//   CrowdSim::step x N (sim_predict applies damage[i] through the existing health / blood / sever / DYING path
//                   with bullet parameters: small blood puff, limb loss on heavy rounds, headshot flag takes the head;
//                   on the alive -> DYING transition (any cause) it appends a kill record {seq = atomicAdd(seq),
//                   cause, shooter, pos}; damage cleared. Exactly one thread sees the
//                   transition of an agent, and reactivated corpses re-enter as DYING, so a kill is emitted once.)
//                   sim_solve pushes zombies out of soldier capsules (soldierCell[] 3x3 lookup, infinite mass).
//                   nav_relax seeds attractors (game_attract -> navSeed), nav_dir zeroes the flow beyond the
//                   awareness reach of every attractor (zombies far from the action wander).
//   postSim(cmd)  [after the last step, before CrowdSim::writeDrawArgs]
//     game_field  : indirect over live agents: per 6 m tile atomic count, first kFieldSamples walker positions
//     game_contacts: one thread per soldier: attackers within reach (5x5 cells), nearby within 8 m (coarse tiles)
//     copy pass   : [kill header + records | hit results | contacts | field] -> readback ring slot (3 slots);
//                   then the kill ring count is reset (if no slot is free, records stay on the GPU for the next one)
//   harvest()     [after submit, next frames] : slots whose frame <= CrowdSim::lastCompletedFrame() are mapped and
//                   parsed (no fence of its own: CrowdSim owns the frame fence).
//
// CrowdSim side (implemented): cellStart()/cellCount()/cellGridValid(), recordingFrame()/lastCompletedFrame()/
//   pollFences() (fence queue: CrowdSim owns the frame fence), setGameInputs(flags, awareness gate) (SimUniforms
//   goreQ.zw; 0 = showcase behaviour, bit-identical paths), merged buffers because SDL3 GPU allows 8 RO + 8 RW
//   storage buffers per compute stage: gameIO (kill ring + per-agent bullet damage, sim_predict), gameSolid (soldier
//   capsules + soldier cells, sim_solve), navSeed (attractor sources, nav_relax); nav_dir zeroes the flow beyond the
//   gate. reset() clears damage / cells / seeds (kill seq continues); relocate() clears damage and invalidates the
//   cell lists until the next step (rounds wait a frame). Agent layout stays 80 B.
// Attractors: seed = (gate - awareness x strength) + distance to the attractor inside its footprint, so a nav distance
//   above the gate means "beyond this source's awareness"; gate = max(setAwarenessRadius, every reach), sticky.
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
    bool spawnZombie(V3 pos, float yaw, float health, uint32_t lookX, uint32_t lookY) override;
    const ZombieField& field() const override { return field_; }
    const std::vector<SoldierContact>& contacts() const override { return contacts_; }
    void takeKills(std::vector<KillEvent>& out) override { out.insert(out.end(), kills_.begin(), kills_.end()); kills_.clear(); }
    uint64_t killsOverflowed() const override { return killsOverflowed_; }
    bool simulated(float x, float z) const override;

    // tuning (GameWorld copies ZombieThreatConfig here; defaults match config/balance.json)
    void setAwarenessRadius(float m) { awareness_ = m; }   // attractor reach when Attractor::awareness == 0
    void setAttackReach(float m) { attackReach_ = m; }      // capsule surface to zombie centre
    void setNearbyRadius(float m) { nearbyRadius_ = m; }    // SoldierContact::nearby
    // Tests / --game-sync only: harvest() waits for the GPU (deterministic latency). Never in normal play.
    void setSync(bool on) { sync_ = on; }

    // Rounds resolved by the GPU, in queue order, from the newest harvested frame (FX / tests).
    enum class HitKind : uint8_t { Miss = 0, Zombie = 1, Static = 2 };
    struct HitResult { HitKind kind = HitKind::Miss; float dist = 0.f; uint32_t shooterPacked = 0; };
    const std::vector<HitResult>& hitResults() const { return hitResults_; }
    uint64_t hitResultsFrame() const { return hitResultsFrame_; }
    uint64_t lastHarvestedFrame() const { return harvested_; }
    uint64_t lastKillSeq() const { return lastKillSeq_; }

    struct Stats {
        uint32_t hitsQueued = 0, hitsResolved = 0, killsHarvested = 0, latencyFrames = 0;
        uint64_t hitsTotal = 0, hitsOnZombies = 0, hitsOnStatic = 0, killsTotal = 0, duplicatesDropped = 0, slotsSkipped = 0;
        double cpuMs = 0;
    };
    const Stats& stats() const { return st_; }

private:
    void parseSlot(int slot);

    GpuContext* gpu_ = nullptr;
    CrowdSim* sim_ = nullptr;
    std::vector<HordeSoldier> soldiers_;
    std::vector<HitRequest> hits_;
    std::vector<Attractor> attractors_;
    ZombieField field_;
    std::vector<SoldierContact> contacts_;
    std::vector<KillEvent> kills_;
    std::vector<HitResult> hitResults_;
    uint64_t hitResultsFrame_ = 0, harvested_ = 0;
    uint64_t lastKillSeq_ = 0, killsOverflowed_ = 0;
    Stats st_;
    float awareness_ = 60.f, attackReach_ = 0.9f, nearbyRadius_ = 8.f, gate_ = 0.f;
    bool sync_ = false, seedsDirty_ = false;
    uint32_t prevStamped_ = 0;     // soldier cells stamped last frame (cleared before the new stamp)
    uint32_t tilesX_ = 0, tilesZ_ = 0;

    // GPU: pipelines and buffers owned here (sim-side buffers live in CrowdSim: hitDamage, killRing, gameSoldiers,
    // soldierCell, navSeed)
    SDL_GPUComputePipeline *pStamp_ = nullptr, *pHits_ = nullptr, *pAttract_ = nullptr, *pField_ = nullptr, *pContacts_ = nullptr;
    SDL_GPUBuffer *hitReq_ = nullptr, *hitRes_ = nullptr, *stamped_ = nullptr, *attrBuf_ = nullptr, *fieldBuf_ = nullptr,
                  *contactBuf_ = nullptr;
    SDL_GPUTransferBuffer* upload_ = nullptr;   // cycled each frame: soldiers | hits | attractors

    // this frame (preSim -> postSim)
    uint32_t frameSoldiers_ = 0, frameHits_ = 0;
    std::vector<uint32_t> frameIds_, frameShooters_;
    bool frameHitsResolved_ = false;

    struct Slot {
        SDL_GPUTransferBuffer* tb = nullptr;
        uint64_t frame = 0;
        bool pending = false;
        bool hasGrid = false;       // field / contacts valid (the cell lists were current at postSim)
        uint32_t nSoldiers = 0, nHits = 0, tilesX = 0, tilesZ = 0;
        float originX = 0, originZ = 0;
        std::vector<uint32_t> ids, shooters;
    };
    std::array<Slot, 3> ring_{};
};

} // namespace ttz::game

namespace ttz { struct SimParams; }
namespace ttz::game {
// Self-test section "combat GPU" (src/game/HordeBridgeTest.cpp). Returns the number of failed checks.
int selfTestHordeBridge(GpuContext& gpu, const SimParams& params);
}
