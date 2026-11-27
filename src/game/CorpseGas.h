#pragma once
// Corpse rot gas + flamethrower fire (GAME_DESIGN 14d: APPROVED mechanic; every value UNAPPROVED, config/balance.json
// "rot" / "flame"). GPU side, one module:
//
//   * corpse rot  (shaders/game_gas_corpse.comp, one thread per corpse slot): per-corpse age in an own buffer (uvec4 per
//     slot, keyed by the corpse's position so a reset / reused slot starts fresh); after rot.delay s a corpse rots and
//     emits gas into a coarse grid over the simulation window (gas cell = 2 x 2 sim cells = 1.5 m), the emission ramps up
//     over rot.ramp s (the gas spreads further the longer bodies stay). Corpses in a flame cone / ground fire ignite after
//     flame.corpseIgnite s, burn flame.corpseBurnTime s and are then removed (alive bit cleared, height un-splatted: the
//     pile shrinks and its gas source is gone). Rot level 0..63 -> corpse info.z bits 26..31 (free bits) for renderers.
//   * gas field   (game_gas_field.comp, one thread per gas cell, ping-pong): follows window moves (shift), diffusion
//     (buildings hold no gas), emission, decay, fire burns gas off; ground fire ages, flame cones light the cells they
//     cover (contained: never spreads). Packed CPU readback (gas, fire, corpses, rotting per cell) + render list.
//   * flame damage (game_gas_agents.comp, one thread per live zombie): cone / ground-fire damage through the existing
//     bullet-damage queue (HordeBridge gameIO), credited to the flamethrower -> kills, rewards, gore unchanged.
//
// Updates run in GameWorld::postSim (after the last horde step of a frame, like HordeBridge's field passes) with the
// simulation time elapsed since the last update (pause / sim speed respected). Readback is async (ring of 3, every
// kReadbackEvery s, never blocks; `sync` waits for tests). CPU side: soldier gas damage + squad warning, NavGrid
// gas cost, burn-target search for FlameAI, fire volumes for the renderer (CorpseGasRender.cpp, game binary only).
#include "game/GameContext.h"
#include "sim/GpuTypes.h"

#include <SDL3/SDL_gpu.h>
#include <array>
#include <cstdint>
#include <vector>

namespace ttz {
class GpuContext;
class CrowdSim;
struct SimParams;
struct FireVolume;
}

namespace ttz::game {

struct RotConfig;
struct FlameConfig;

// One spray tick of a flamethrower (Combat / FlameAI produce them; CorpseGas consumes them on the GPU, GameRender draws
// the flame stream). `seconds` = spray time this cone stands for (the weapon's fireInterval).
struct FlameCone {
    V3 origin, dir;                    // nozzle, unit direction
    float range = 9.f, coneDeg = 18.f, seconds = 0.1f;
    uint32_t shooterPacked = 0;        // kill credit (Handle::packed)
};

struct GasCell { float gas = 0.f, fire = 0.f; int corpses = 0, rotting = 0; };

class CorpseGas {
public:
    static constexpr uint32_t kDiv = 2;              // sim cells per gas cell (1.5 m at 0.75 m)
    static constexpr int kMaxCones = 16;             // per GPU update (more are merged into the next update)
    static constexpr float kReadbackEvery = 0.25f;   // s of sim time between readbacks

    bool init(GpuContext& gpu, CrowdSim& sim);
    void shutdown();
    void configure(const RotConfig& rot, const FlameConfig& flame);
    void setSync(bool s) { sync_ = s; }

    // ---- inputs (game tick)
    void queueFlame(const FlameCone& c);
    // ---- GPU (after the last horde step of the frame; records into cmd)
    void postSim(SDL_GPUCommandBuffer* cmd);
    void harvest();                                  // after submit (non-blocking unless setSync)

    // ---- CPU view of the latest readback (window-relative grid; world queries)
    bool ready() const { return have_; }
    GasCell at(float x, float z) const;
    float gasAt(float x, float z) const { return at(x, z).gas; }
    // Best burn target (most corpses, rotting / gas weighted) within r of c; false when nothing worth a trip.
    bool findPile(V3 c, float r, int minCorpses, float minGas, V3& out, int* corpses = nullptr) const;
    int corpsesNear(V3 c, float r) const;            // corpses (readback) in gas cells whose centre is within r
    struct Stats { uint32_t burned = 0, burning = 0, rotting = 0, corpses = 0, flamed = 0, ignited = 0; float maxGas = 0, totalGas = 0; int fireCells = 0, gasCells = 0; };
    const Stats& stats() const { return stats_; }
    uint64_t readbacks() const { return readbacks_; }
    uint64_t updates() const { return updates_; }

    // ---- gameplay (game tick, after Combat): gas damage to soldiers (Combat owns health writes otherwise; gas is a
    // second, independent damage source), squad SQ_GAS warning flag, per-soldier exposure for the UI.
    void tick(GameContext& ctx);
    float soldierGas(uint32_t i) const { return i < exposure_.size() ? exposure_[i] : 0.f; }
    double gasDamage() const { return gasDamage_; }
    // NavGrid gas cost layer (cells above rot.navAvoidLevel cost extra): rebuilt per readback.
    const std::vector<uint8_t>& navCost() const { return navCost_; }
    float originX() const { return ox_; }
    float originZ() const { return oz_; }
    float cellSize() const { return cell_; }
    int width() const { return (int)gw_; }
    int height() const { return (int)gh_; }

    // ---- rendering hooks (CorpseGasRender.cpp)
    SDL_GPUBuffer* fieldBuffer() const { return field_[cur_]; }
    SDL_GPUBuffer* listBuffer() const { return list_; }
    const std::vector<FlameCone>& recentCones() const { return drawn_; }   // cones of the last update (FX)
    // ground fire (burning cells, clustered into pools) for the voxel fire volumes, nearest to (x, z) first:
    // x, radius (m), z, strength 0..1
    void fireSpots(float x, float z, int maxN, std::vector<std::array<float, 4>>& out) const;

private:
    GpuContext* gpu_ = nullptr;
    CrowdSim* sim_ = nullptr;
    const RotConfig* rot_ = nullptr;
    const FlameConfig* flame_ = nullptr;
    SDL_GPUComputePipeline *pCorpse_ = nullptr, *pField_ = nullptr, *pAgents_ = nullptr;
    SDL_GPUBuffer *field_[2] = {nullptr, nullptr}, *accum_ = nullptr, *out_ = nullptr, *list_ = nullptr, *rot_buf_ = nullptr;
    uint32_t gw_ = 0, gh_ = 0, cells_ = 0, corpseCap_ = 0;
    int cur_ = 0;
    double lastSim_ = -1.0;
    float sinceReadback_ = 1e9f;
    float lastOx_ = 1e30f, lastOz_ = 1e30f;
    std::vector<FlameCone> cones_, drawn_;
    struct Slot { SDL_GPUTransferBuffer* tb = nullptr; uint64_t frame = 0; bool pending = false; float ox = 0, oz = 0; };
    std::array<Slot, 3> ring_{};
    bool sync_ = false, have_ = false;
    std::vector<uint32_t> cpu_;                       // packed cells of the latest readback
    float ox_ = 0, oz_ = 0, cell_ = 1.5f;             // origin / cell of the readback grid
    Stats stats_;
    uint64_t readbacks_ = 0, updates_ = 0;
    std::vector<float> exposure_;
    std::vector<uint8_t> navCost_;
    double gasDamage_ = 0.0;
    float warnHold_ = 0.f;
};

// Self-test section "corpse gas / flamethrowers" (CorpseGasTest.cpp): rot delay, gas, soldier damage, burning, flame kills,
// fuel use / friendly-fire safety / fuel resupply. Returns the number of failed checks.
int selfTestCorpseGas(GpuContext& gpu, const SimParams& params);

} // namespace ttz::game
