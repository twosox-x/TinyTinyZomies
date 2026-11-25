#pragma once
// Scene renderer: GPU-instanced zombies and corpses (one indirect draw each, instance data read
// straight from the simulation buffers), instanced boxes for the sandbox, a ground pass with debug
// overlays, MSAA offscreen target -> resolve -> blit to the swapchain. ImGui is drawn by the app.
#include "assets/Model.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "sim/CrowdSim.h"
#include "sim/GpuTypes.h"
#include "sim/Sandbox.h"

#include <string>
#include <vector>

namespace ttz {

constexpr int kMaxLights = 24;
constexpr int kMaxBlasts = 8;

struct FrameUniforms {   // std140, matches shaders/include/frame.glsl
    float viewProj[16];
    Vec4 camPos, sunDir, sunColor, skyColor, groundColor, fogColor, gridP;
    UVec4 gridDim;
    Vec4 modelP;
    Vec4 goals[4];
    Vec4 blasts[kMaxBlasts];
    Vec4 lightPos[kMaxLights];
    Vec4 lightCol[kMaxLights];
};

struct RenderSettings {
    uint32_t debugFlags = 0;      // DBG_* bits (see frame.glsl)
    bool drawZombies = true, drawCorpses = true, drawBoxes = true;
    float fogDensity = 0.0045f;
};

class Renderer {
public:
    bool init(GpuContext& gpu, const Model& zombie, const Sandbox& sb, const SimParams& p, SDL_GPUTextureFormat swapchainFormat);
    void shutdown();
    void setSandbox(const Sandbox& sb);

    void addBlast(float x, float y, float z);
    void update(float dt);   // ages blast effects

    // Renders the scene into the internal target, then blits into `target` (swapchain) if given.
    void render(SDL_GPUCommandBuffer* cmd, SDL_GPUTexture* target, uint32_t w, uint32_t h, const Camera& cam,
                const CrowdSim& sim, double time, const RenderSettings& rs);
    uint32_t zombieIndexCount() const { return zombieIndexCount_; }
    // Synchronous screenshot of the last rendered frame (PNG).
    bool saveScreenshot(const std::string& path);
    int msaaSamples() const;

private:
    void ensureTargets(uint32_t w, uint32_t h);
    SDL_GPUGraphicsPipeline* makePipeline(const char* vs, const char* fs, bool modelVertex, bool cubeVertex, bool cull);

    GpuContext* gpu_ = nullptr;
    SDL_GPUTextureFormat swapFormat_ = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount samples_ = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUGraphicsPipeline *pZombie_ = nullptr, *pCorpse_ = nullptr, *pBox_ = nullptr, *pGround_ = nullptr;
    SDL_GPUBuffer *zombieVB_ = nullptr, *zombieIB_ = nullptr, *cubeVB_ = nullptr, *cubeIB_ = nullptr, *boxes_ = nullptr;
    SDL_GPUTexture *palette_ = nullptr, *colorMS_ = nullptr, *depth_ = nullptr, *resolved_ = nullptr;
    SDL_GPUSampler* nearest_ = nullptr;
    uint32_t zombieIndexCount_ = 0, boxCount_ = 0, targetW_ = 0, targetH_ = 0;
    int variantRows_ = 1;
    float modelHeight_ = 1.7f;
    SimParams params_;
    Sandbox sandbox_;
    struct Blast { float x, y, z, age; };
    std::vector<Blast> blasts_;
};

} // namespace ttz
