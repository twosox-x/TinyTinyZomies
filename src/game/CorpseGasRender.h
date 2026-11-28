#pragma once
// Corpse gas / ground fire rendering (GAME_DESIGN 14d), game binary only (needs the Renderer). The gas is a translucent
// voxel fog volume (owner round 15 item 10; shaders/gas_volume.vert / .frag, the fx volumes' DDA technique): one box per
// 16 m world tile holding gas (from the CPU readback, nearest kMaxGasBoxes to the camera), density from the GPU gas
// field. Plus one indirect instanced draw (shaders/gas.vert / gas.frag) of the cells game_gas_field listed: flies over
// rotting bodies, a few glowing embers on ground fire. Registered as a Renderer extension (scene pass, after
// the characters). The fire itself (flame streams, ground-fire pools) is drawn as voxel volumes in the explosions' style
// (Renderer::setFlameVolumes -> fx_volume kinds 2 / 3, half-res fx path and budget).
#include "game/GameEvents.h"

#include <SDL3/SDL_gpu.h>
#include <vector>

namespace ttz {
struct AppState;
struct FireVolume;
struct FlameVolume;
struct PointLight;
}

namespace ttz::game {

class CorpseGas;

class CorpseGasRender {
public:
    bool init(AppState& app, CorpseGas& gas);
    void shutdown(AppState& app);
    // Flamethrower fire in the explosions' voxel-volume style (fx_volume kinds 2 / 3): one stream per spraying
    // flamethrower (from FxKind::Flame events; fades in 0.12 s, out 0.3 s after the last spray) + ground-fire pools
    // (clustered burning gas cells). Bounded: maxStreams + maxPools, nearest to the camera.
    void noteFlames(const std::vector<FxEvent>& fx, double time, float range);
    void flameVolumes(float camX, float camZ, double time, std::vector<FlameVolume>& out, int maxStreams = 6, int maxPools = 6) const;
    void flameLights(double time, std::vector<PointLight>& out) const;   // warm flickering light along each jet + its impact
    float hazeAlpha = 1.f;     // x the gas fog's opacity (UI / screenshots)
    bool voxelFog = true;      // gas as the voxel fog volume; false = the legacy drifting puffs (gas.vert boxes 0..4)
    float gasMaxAlpha = 0.72f; // opacity cap of the gas fog (units stay readable through it)
    static constexpr int kMaxGasBoxes = 32;   // == MAX_GAS_BOXES (shaders/include/gas_volume.glsl)
    int gasBoxesDrawn() const { return gasBoxes_; }
private:
    AppState* app_ = nullptr;
    CorpseGas* gas_ = nullptr;
    SDL_GPUGraphicsPipeline* pipe_ = nullptr;
    SDL_GPUGraphicsPipeline* pipeVol_ = nullptr;   // gas voxel fog
    int gasBoxes_ = 0;
    void drawGasVolume(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* corpseH);
    int ext_ = 0;
    struct Stream { uint32_t id = 0; V3 o, d; double start = 0, last = -1e9; float range = 9.f; };
    std::vector<Stream> streams_;
    struct Pool { float x, y, z, r, k; uint32_t seed; };
    mutable std::vector<Pool> pools_;   // ground-fire pools drawn last frame (flameLights: one light each while burning)
    float groundY(float x, float z) const;                       // ground without vehicles
    bool onObstacle(float x, float z, float ground) const;       // a parked car / obstacle above that ground
    static float visualReach(const Stream& s, double time);
    bool impact(const Stream& s, float reach, V3& out) const;
};

} // namespace ttz::game
