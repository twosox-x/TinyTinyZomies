#pragma once
// Scene renderer: GPU-instanced zombies and corpses (one indirect draw each, instance data read
// straight from the simulation buffers), instanced boxes for the sandbox, a ground pass with debug
// overlays, MSAA offscreen target -> resolve -> blit to the swapchain. ImGui is drawn by the app.
#include "assets/Model.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "render/CharacterRenderer.h"
#include "render/ShadowPass.h"
#include "render/TimeOfDay.h"
#include "sim/CrowdSim.h"
#include "sim/GpuTypes.h"
#include "sim/Sandbox.h"

#include <functional>
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
    Vec4 todP;                  // x night 0..1, y fire-light gain, z moon key light, w hours
    float shadowVP[16];         // world -> shadow map clip
    Vec4 shadowP;               // x on, y m / texel, z depth bias, w uv / texel
};

// Voxel explosion / fire volumes (shaders/include/fx_volume.glsl): pushed to vertex and fragment uniform slot 1.
constexpr int kMaxFxVolumes = 24;
struct FxVolumeUniforms {   // std140
    Vec4 a[kMaxFxVolumes];  // xyz origin, w age (s)
    Vec4 b[kMaxFxVolumes];  // x scale (blast) / footprint length (wreck), y kind (0 blast, 1 wreck), z seed, w strength
    UVec4 count;
};

struct RenderSettings {
    uint32_t debugFlags = 0;      // DBG_* bits (see frame.glsl)
    bool drawZombies = true, drawCorpses = true, drawBoxes = true, drawGround = true;
    // time of day (TimeOfDay.h): sun / moon, ambient, fog and exposure per hour; the app advances the clock
    TimeOfDaySettings tod;
    // light atmospheric fog from fogStart x camera distance on, exposure (x the time of day's) before the highlight roll-off
    float fogDensity = 0.0011f;
    float fogStart = 0.75f;          // x camera (pivot) distance: the area around the pivot stays clear
    float exposure = 1.0f;
    // miniature look: thin-lens depth of field focused on the RTS camera pivot (macro-lens shallow focus with bokeh
    // discs, see Renderer::postProcess / shaders/post_dof_*.frag), plus a small saturation / contrast boost
    bool tiltShift = true;           // miniature depth of field on / off (name kept for the lab's "+notilt")
    float dofStrength = 1.0f;        // 0..1 blend of the bokeh layers
    float dofAperture = 0.836f;       // CoC = aperture * (d - focus) / d, in units of the max blur radius (thin lens)
    float dofFocusOffset = 0.0f;     // focus distance = pivot distance * (1 + offset)
    float dofMaxBlur = 0.015f;       // max CoC radius, fraction of the screen height
    float dofHighlightGain = 2.062f;  // extra brightness of highlights in the blur (bokeh discs of lamps / windows / fire)
    float dofHighlightThreshold = 0.564f;  // display luma where the highlight boost starts
    float dofHexAperture = 0.0f;     // 0 = round bokeh, 1 = hexagonal (six aperture blades)
    bool dofDebug = false;           // show the CoC (red near, blue far)
    float saturation = 1.18f, contrast = 1.06f, vignette = 0.12f;
    int characterModel = 1;          // 0 = phase-1 placeholder mesh, 1 = approved modular characters
    CharacterSettings chars;
    bool studioLighting = false;     // neutral sage studio (Zombie Lab comparison), no fog
    bool shadows = true;             // key-light (sun / moon) shadows
    // shadow map (shaders/include/shadow.glsl): one depth map per frame from the key light, fitted to the visible
    // ground (within shadowRange of the pivot), texel-snapped; off = the legacy fixed-direction moon height field
    bool shadowMap = true;
    int shadowMapSize = 2048;        // texels per side (1024 / 2048 / 4096)
    float shadowRange = 170.f;       // max distance (m) from the pivot the map covers
    float shadowSoftness = 1.0f;     // PCF tap spacing in texels
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

    // flash + fire light + a voxel fireball / smoke / dust volume (scale: effect size, 1 car .. 2.2 fuel tanker)
    void addBlast(float x, float y, float z, float scale = 1.f);
    void setFireVolumes(const std::vector<FireVolume>& fires) { fires_ = fires; }   // burning wrecks, this frame
    void update(float dt);   // ages blast effects
    uint32_t fxVolumesDrawn() const { return fxDrawn_; }

    // Renders the scene into the internal target, then blits into `target` (swapchain) if given.
    void render(SDL_GPUCommandBuffer* cmd, SDL_GPUTexture* target, uint32_t w, uint32_t h, const Camera& cam,
                const CrowdSim& sim, double time, const RenderSettings& rs, CharacterRenderer* chars = nullptr);
    // Split variant for profiling: record the character compute passes only / the scene pass only.
    void prepareCharacters(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const Camera& cam, const CrowdSim& sim,
                           double time, const RenderSettings& rs, CharacterRenderer* chars);
    uint32_t drawCalls(const RenderSettings& rs, const CharacterRenderer* chars) const;
    // Key-light shadow map for this frame: the light's view-projection (fitted to the camera's visible ground).
    // Returns false when no shadow map is drawn (studio lighting / shadows off / key light below the horizon).
    // The app calls it before CityRenderer::update so the city can cull its casters with the same box.
    bool shadowView(const Camera& cam, float aspect, const RenderSettings& rs, M4& lightVP, float* texelMetres = nullptr) const;
    uint32_t shadowDrawCalls() const { return shadowDraws_; }
    TimeOfDayLight lightAt(const RenderSettings& rs) const { return evalTimeOfDay(rs.tod); }
    uint32_t zombieIndexCount() const { return zombieIndexCount_; }
    // Synchronous screenshot of the last rendered frame (PNG).
    bool saveScreenshot(const std::string& path);
    int msaaSamples() const;

private:
    void ensureTargets(uint32_t w, uint32_t h);
    SDL_GPUGraphicsPipeline* makePipeline(const char* vs, const char* fs, bool modelVertex, bool cubeVertex, bool cull, bool cullFront = false,
                                          SDL_GPUGraphicsPipeline** shadowOut = nullptr);

    GpuContext* gpu_ = nullptr;
    SDL_GPUTextureFormat swapFormat_ = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUSampleCount samples_ = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUGraphicsPipeline *pZombie_ = nullptr, *pCorpse_ = nullptr, *pBox_ = nullptr, *pGround_ = nullptr, *pParticle_ = nullptr, *pFx_ = nullptr,
                            *pFxNear_ = nullptr;
    SDL_GPUBuffer *zombieVB_ = nullptr, *zombieIB_ = nullptr, *cubeVB_ = nullptr, *cubeIB_ = nullptr, *boxes_ = nullptr,
                  *shadowH_ = nullptr;
    void buildShadowField(const Sandbox& sb);
    // key-light shadow map
    SDL_GPUTexture* shadowTex_ = nullptr;
    SDL_GPUSampler* shadowCmp_ = nullptr;
    SDL_GPUGraphicsPipeline* pBoxShadow_ = nullptr;
    uint32_t shadowSize_ = 0, shadowDraws_ = 0;
    void ensureShadowMap(uint32_t size);
    SDL_GPUBuffer* shadowExt_ = nullptr;
    SDL_GPUBuffer* lampDummy_ = nullptr;   // empty street-lamp grid (no city)
    SDL_GPUBuffer* shadow() const { return shadowExt_ ? shadowExt_ : shadowH_; }
    SDL_GPUTexture *palette_ = nullptr, *colorMS_ = nullptr, *depth_ = nullptr, *resolved_ = nullptr;
    SDL_GPUSampler* nearest_ = nullptr;
    // post-processing: half-res blur ping-pong, final composite (blitted to the swapchain, read by screenshots)
    // miniature DOF: half-res prefilter (colour + CoC), near-CoC tile max + dilation, gather / fill ping-pong (far and
    // near field as two render targets each), full-res composite
    SDL_GPUGraphicsPipeline *pDofPre_ = nullptr, *pDofTile_ = nullptr, *pDofDilate_ = nullptr, *pDofGather_ = nullptr,
                            *pDofFill_ = nullptr, *pComposite_ = nullptr;
    SDL_GPUTexture *dofPre_ = nullptr, *dofBgA_ = nullptr, *dofFgA_ = nullptr, *dofBgB_ = nullptr, *dofFgB_ = nullptr,
                   *dofTile_ = nullptr, *dofTileD_ = nullptr, *final_ = nullptr;
    SDL_GPUSampler* linear_ = nullptr;
    SDL_GPUGraphicsPipeline* makePostPipeline(const char* fs, uint32_t targets = 1, bool hdr = false);
    void postProcess(SDL_GPUCommandBuffer* cmd, uint32_t w, uint32_t h, const RenderSettings& rs);
    uint32_t zombieIndexCount_ = 0, boxCount_ = 0, targetW_ = 0, targetH_ = 0;
    int variantRows_ = 1;
    float modelHeight_ = 1.7f;
    SimParams params_;
    Sandbox sandbox_;
    class CityRenderer* city_ = nullptr;
    struct Blast { float x, y, z, age, scale; };
    std::vector<Blast> blasts_;
    struct FxBlast { float x, y, z, age, scale, seed; };
    std::vector<FxBlast> fxBlasts_;   // voxel fireball volumes (live ~7-10 s, see fxLife in fx_volume.glsl)
    std::vector<FireVolume> fires_;
    uint32_t fxSeed_ = 1;
    uint32_t fxDrawn_ = 0;            // voxel volumes drawn last frame (blasts + wreck fires)
public:
    // Optional extensions (Military Asset Lab): compute work recorded before the scene pass, and draws inside the scene
    // pass after the characters (frame uniforms in slot 0; buffers: gore decals, moon-shadow field, corpse heights).
    std::function<void(SDL_GPUCommandBuffer*)> extPrepare;
    std::function<void(SDL_GPURenderPass*, SDL_GPUCommandBuffer*, SDL_GPUBuffer*, SDL_GPUBuffer*, SDL_GPUBuffer*)> extDraw;
    std::function<void(SDL_GPURenderPass*, SDL_GPUCommandBuffer*)> extShadowDraw;   // casters into the shadow pass (depth only)
    bool skipCharacterPrepare_ = false;   // benchmark: prepare recorded separately for timing
};

} // namespace ttz
