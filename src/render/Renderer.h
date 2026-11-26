#pragma once
// Scene renderer: GPU-instanced zombies and corpses (one indirect draw each, instance data read
// straight from the simulation buffers), instanced boxes for the sandbox, a ground pass with debug
// overlays, MSAA offscreen target -> resolve -> blit to the swapchain. ImGui is drawn by the app.
#include "assets/Model.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "render/CharacterRenderer.h"
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
    Vec4 blastsP[kMaxBlasts];   // x effect scale
};

struct RenderSettings {
    uint32_t debugFlags = 0;      // DBG_* bits (see frame.glsl)
    bool drawZombies = true, drawCorpses = true, drawBoxes = true, drawGround = true;
    // night look (city): light atmospheric fog from fogStart x camera distance on, exposure before the highlight roll-off
    float fogDensity = 0.0011f;
    float fogStart = 0.75f;          // x camera (pivot) distance: the area around the pivot stays clear
    float exposure = 1.15f;
    // miniature post-process ("tilt-shift"): half-resolution blur mixed in by depth difference to the camera pivot and
    // a vertical screen gradient, plus a small saturation / contrast boost
    bool tiltShift = true;
    float tiltStrength = 0.9f;        // 0..1 blend towards the blurred image
    float tiltBand = 0.20f;          // half-height (uv) of the sharp band around the screen centre
    float tiltSoftness = 0.34f;      // gradient width (uv) from sharp to fully blurred
    float tiltDepthRange = 1.5f;     // depth difference (x pivot distance) that is fully blurred
    float tiltDepthWeight = 0.8f;
    float tiltRadius = 1.6f;         // blur tap spacing (half-res texels at 720p)
    float saturation = 1.18f, contrast = 1.06f, vignette = 0.12f;
    int characterModel = 1;          // 0 = phase-1 placeholder mesh, 1 = approved modular characters
    CharacterSettings chars;
    bool studioLighting = false;     // neutral sage studio (Zombie Lab comparison), no fog
    bool shadows = true;             // moon shadows of buildings / cars / walls (precomputed height field)
    bool drawParticles = true;       // blood, fire, smoke, debris
};

class Renderer {
public:
    bool init(GpuContext& gpu, const Model& zombie, const Sandbox& sb, const SimParams& p, SDL_GPUTextureFormat swapchainFormat);
    void shutdown();
    void setSandbox(const Sandbox& sb);
    // Baked city: moon-shadow height field computed from the city height grid (CityWorld), street-lamp lights,
    // and the tile renderer drawn inside the scene pass.
    void setShadowField(const std::vector<float>& field);
    void setLights(const std::vector<PointLight>& lights) { sandbox_.lights = lights; }
    // Moving simulation window (city): grid origin of the gore / shadow fields and the moon-shadow buffer to use
    // (owned by the caller; null = the renderer's own field).
    void setSimWindow(float originX, float originZ, SDL_GPUBuffer* shadowField) {
        sandbox_.originX = originX;
        sandbox_.originZ = originZ;
        shadowExt_ = shadowField;
    }
    void setCity(class CityRenderer* city) { city_ = city; }

    void addBlast(float x, float y, float z, float scale = 1.f);   // flash + fire light (scale: effect size)
    void update(float dt);   // ages blast effects

    // Renders the scene into the internal target, then blits into `target` (swapchain) if given.
    void render(SDL_GPUCommandBuffer* cmd, SDL_GPUTexture* target, uint32_t w, uint32_t h, const Camera& cam,
                const CrowdSim& sim, double time, const RenderSettings& rs, CharacterRenderer* chars = nullptr);
    // Split variant for profiling: record the character compute passes only / the scene pass only.
    void prepareCharacters(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const Camera& cam, const CrowdSim& sim,
                           double time, const RenderSettings& rs, CharacterRenderer* chars);
    uint32_t drawCalls(const RenderSettings& rs, const CharacterRenderer* chars) const;
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
    SDL_GPUGraphicsPipeline *pZombie_ = nullptr, *pCorpse_ = nullptr, *pBox_ = nullptr, *pGround_ = nullptr, *pParticle_ = nullptr;
    SDL_GPUBuffer *zombieVB_ = nullptr, *zombieIB_ = nullptr, *cubeVB_ = nullptr, *cubeIB_ = nullptr, *boxes_ = nullptr,
                  *shadowH_ = nullptr;
    void buildShadowField(const Sandbox& sb);
    SDL_GPUBuffer* shadowExt_ = nullptr;
    SDL_GPUBuffer* shadow() const { return shadowExt_ ? shadowExt_ : shadowH_; }
    SDL_GPUTexture *palette_ = nullptr, *colorMS_ = nullptr, *depth_ = nullptr, *resolved_ = nullptr;
    SDL_GPUSampler* nearest_ = nullptr;
    // post-processing: half-res blur ping-pong, final composite (blitted to the swapchain, read by screenshots)
    SDL_GPUGraphicsPipeline *pBlur_ = nullptr, *pComposite_ = nullptr;
    SDL_GPUTexture *halfA_ = nullptr, *halfB_ = nullptr, *final_ = nullptr;
    SDL_GPUSampler* linear_ = nullptr;
    SDL_GPUGraphicsPipeline* makePostPipeline(const char* fs);
    void postProcess(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const RenderSettings& rs);
    uint32_t zombieIndexCount_ = 0, boxCount_ = 0, targetW_ = 0, targetH_ = 0;
    int variantRows_ = 1;
    float modelHeight_ = 1.7f;
    SimParams params_;
    Sandbox sandbox_;
    class CityRenderer* city_ = nullptr;
    struct Blast { float x, y, z, age, scale; };
    std::vector<Blast> blasts_;
public:
    bool skipCharacterPrepare_ = false;   // benchmark: prepare recorded separately for timing
};

} // namespace ttz
