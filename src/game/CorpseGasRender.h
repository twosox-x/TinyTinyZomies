#pragma once
// Corpse gas / ground fire rendering (GAME_DESIGN 14d), game binary only (needs the Renderer). One indirect instanced
// draw (shaders/gas.vert / gas.frag) of the cells game_gas_field listed: a low translucent voxel haze slab per gassed
// cell (0.25 m height steps: blocky, low patches that never hide the battlefield), sparse rising puffs where it is thick,
// flies over rotting bodies, flickering emissive voxels on ground fire. Registered as a Renderer extension (scene pass,
// after the characters). Burning piles also become small voxel fire volumes (fx_volume wreck-fire style).
#include <SDL3/SDL_gpu.h>
#include <vector>

namespace ttz {
struct AppState;
struct FireVolume;
}

namespace ttz::game {

class CorpseGas;

class CorpseGasRender {
public:
    bool init(AppState& app, CorpseGas& gas);
    void shutdown(AppState& app);
    void fireVolumes(float camX, float camZ, std::vector<FireVolume>& out, int maxN = 6) const;
    float hazeAlpha = 1.f;     // x the shader's base opacity (UI / screenshots)
private:
    AppState* app_ = nullptr;
    CorpseGas* gas_ = nullptr;
    SDL_GPUGraphicsPipeline* pipe_ = nullptr;
    int ext_ = 0;
};

} // namespace ttz::game
