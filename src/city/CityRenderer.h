#pragma once
// Streams baked city tiles to the GPU and draws them inside the scene pass.
//  - residency: tiles under the camera's ground footprint (+1 tile ring) are requested nearest-first from the
//    CityAsset decode thread; decoded tiles are uploaded on the main thread within a per-frame byte budget;
//    an LRU keeps at most `maxResident` tiles (tiles in the wanted set are never evicted).
//  - LOD / culling: per tile AABB (frustum); LOD2 (baked 2 m block model) for tiles beyond lod2Dist; otherwise per
//    sub-tile chunk (CHNK, 4 x 4 chunks of 32 m: frustum-culled by AABB, LOD0 near / LOD1 beyond lod1Dist, with
//    hysteresis). v1 tiles without chunks: per-tile LOD0 / LOD1 (leading quads of LOD0).
//  - draw: one pipeline; per visible tile one bind and one indexed draw per run of contiguous visible chunk ranges
//    (implicit quad lists through one shared quad index buffer); per-vertex material from a palette storage buffer.
//    Vehicles / props: instances frustum-culled per bounding sphere, full / mid (derived at load) / box (vehicles)
//    LOD by distance, one instanced draw per model and LOD from a per-frame storage buffer.
#include "city/CityAsset.h"
#include "city/CityWater.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "render/ShadowPass.h"
#include "sim/Sandbox.h"

#include <unordered_map>
#include <vector>

namespace ttz {

struct CityRenderStats {
    uint32_t resident = 0, visible = 0, wanted = 0, pending = 0, drawCalls = 0, lod1Tiles = 0, lod2Tiles = 0;
    uint32_t visibleChunks = 0, lod1Chunks = 0, tileDraws = 0;   // sub-tile chunks drawn (LOD0 + LOD1), tile mesh ranges
    // drawCalls = API draw calls (with indirect: one multi-draw per visible tile + instanced draws); tileDraws = the
    // ranges they contain
    uint32_t decodedTiles = 0;                                   // cumulative: tiles decoded, their decode ms
    double decodeMsSum = 0, decodeMsMax = 0;
    uint64_t tileTriangles = 0;   // tile meshes only (triangles = tiles + instanced vehicles / props)
    uint64_t triangles = 0, vehicles = 0, gpuBytes = 0;
    double uploadMs = 0;       // CPU time spent recording uploads this frame
    uint32_t uploadedTiles = 0;
    uint64_t uploadedBytes = 0;
};

struct CitySettings {
    bool draw = true, vehicles = true;
    // Tile LOD by distance from the eye to the tile AABB (m), with hysteresis lodHyst going back to a finer LOD.
    // RTS rig: pitch 35-70 deg, distance 30-300 m. At max zoom / 35 deg the eye is 172 m up and the bottom of the
    // screen meets the ground ~205 m away (~190 m to a low tile's AABB), so lod1Dist = 210 keeps the ground nearest the camera at LOD0 in every
    // rig pose; LOD2 (2 m block model, ~4 % of LOD0) from 420 m, where its 2 m steps are ~3-4 px at 1080p.
    float lod1Dist = 210.f, lod2Dist = 420.f, lodHyst = 20.f;
    // Instances (frustum-culled per instance by bounding sphere): full mesh near, mid mesh (quads with an edge
    // >= 0.25 m, emissive quads kept; derived at load) beyond *MidDist, vehicle box proxy beyond vehicleBoxDist,
    // street furniture: baked coarse model (if any, else the mid mesh) beyond propDist. Distances are measured from
    // the nearer of the eye and the camera target (focus). Nothing is culled by distance: an instance is dropped only
    // when its bounding radius projects below minProjectedRadius (radians; ~0.4 px at 1080p / 43 deg).
    float vehicleMidDist = 60.f, vehicleBoxDist = 130.f;
    float propMidDist = 60.f, propDist = 200.f;
    float minProjectedRadius = 0.00028f;
    bool chunks = true;                             // per-chunk culling / LOD (packages with CHNK)
    bool indirect = true;                           // one multi-draw-indirect call per tile for its chunk ranges
    bool props = true;
    uint64_t uploadBudgetBytes = 8ull << 20;        // per frame
    int maxResident = 96;
    bool backfaceCull = true;
    // Street-lamp light pools: every lamp of the resident tiles lights the city through a world-space light grid
    // (lampGrid(), shaders/include/lighting.glsl lampLights); radius / intensity of each lamp's downward pool.
    bool lamps = true;                              // off: empty grid (studio lighting)
    float lampRadius = 18.f, lampIntensity = 1.0f;
    float lampLedShare = 0.2f;                      // fraction of cool-white LED lamps (the rest sodium)
};

class CityVehicles;
struct Vehicle;

class CityRenderer {
public:
    struct GpuInstance {          // std430, shaders/city.vert
        float pos[4];            // xyz, w kind (0 vehicle, 1 prop)
        float quat[4];
        float paint[4];          // linear rgb, w tint flag (vehicles) / signal phase (props)
    };
    // Dynamic vehicles: tiles register their vehicles on upload; changed vehicles are drawn from it (null = baked).
    void setVehicles(CityVehicles* v) { vehicles_ = v; }
    bool init(GpuContext& gpu, CityAsset& asset, SDL_GPUSampleCount samples);
    void shutdown();

    // Main thread, before the scene render pass: residency, LOD, uploads (own copy pass), instance upload.
    void update(SDL_GPUCommandBuffer* cmd, const Camera& cam, float aspect, uint64_t frame);
    // Inside the scene pass (frame uniforms already pushed to vertex/fragment slot 0).
    // frag buffers: decals, shadow field, corpse heights (sim window); null-safe for tests.
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadowH,
              SDL_GPUBuffer* corpseH);
    // Key-light shadow map: casters for the next update() are the tiles / chunks inside the light's clip box
    // (lightViewProj, column-major; null = no shadow pass). Instances: the camera-visible vehicles / props.
    void setShadowCaster(const float* lightViewProj);
    void setShadowMap(const ShadowMapBinding& b) { shadowMap_ = b; }
    // Inside the shadow pass (light view-projection pushed to vertex slot 0): tiles (multi-draw indirect) + instances.
    void drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd);
    uint32_t shadowDrawCalls() const { return shadowCalls_; }
    // Highest static top (m) near (x, z) from resident tiles (4 m cells; camera obstacle avoidance), 0 if unknown.
    float heightAt(float x, float z) const;
    // World-space light grid of every street lamp in the resident tiles (rebuilt when residency changes; 8 m cells
    // listing the lamps whose pool reaches them). Never null after init (all-zero header = no lamps).
    SDL_GPUBuffer* lampGrid() const { return lampGrid_ && settings.lamps ? lampGrid_ : dummy_; }
    uint32_t lampCount() const { return lampCount_; }
    // Street-lamp point lights nearest to (x, z) among visible tiles.
    void nearestLamps(float x, float z, int maxCount, std::vector<PointLight>& out) const;
    // Blocks until every wanted tile is resident (benchmarks / headless screenshots).
    void flush(const Camera& cam, float aspect);

    // Instanced model on the GPU (explicitly indexed CityMesh).
    struct GpuMesh {
        SDL_GPUBuffer *vb = nullptr, *ib = nullptr;
        uint32_t idxCount = 0;
        float origin[4], scale[4];
        float top = 0, radius = 1.f;
    };
    // --- external instanced models (Military Asset Lab): same pipeline, material / lighting / shadow path as the city
    GpuMesh uploadExternalMesh(const CityMesh& m, const char* name) { return uploadMesh(m, name); }
    void releaseMesh(GpuMesh& m);
    // A 256-entry material palette in the city.frag layout (ids beyond the list fall back to grey).
    SDL_GPUBuffer* createMaterialBuffer(const std::vector<CityMaterial>& mats) const;
    SDL_GPUBuffer* materials() const { return materials_; }
    const GpuMesh* vehicleModel(size_t variant) const {
        return variant < models_[0].size() && variant < asset_->variants.size() && models_[0][variant].vb ? &models_[0][variant] : nullptr;
    }
    size_t vehicleVariantCount() const { return asset_ ? asset_->variants.size() : 0; }
    struct ExtDraw { const GpuMesh* mesh; uint32_t first, count; float clamp[8] = {0, 0, 0, 0, 0, 0, 0, 0}; };   // clamp: rect + heights (city.vert)
    // Inside the scene pass: instances (GpuInstance layout, `insts`) drawn with the given palette.
    void drawExternal(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* materials, SDL_GPUBuffer* insts,
                      SDL_GPUBuffer* decals, SDL_GPUBuffer* shadowH, SDL_GPUBuffer* corpseH, const std::vector<ExtDraw>& draws);
    // The same instances into the shadow pass (depth only).
    void drawExternalShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* insts, const std::vector<ExtDraw>& draws);

    // Facade cutouts (GAME_DESIGN 14e garrison window posts): tile fragments inside these oriented boxes are discarded
    // (city.frag), so an opened window shows the room drawn behind it. 8 floats per box: centre of the opening on the
    // glass plane (x, y, z), half width; outward normal (x, z), half height, depth behind the plane. Instances
    // (drawExternal) are never cut. At most kMaxCutouts; set every frame (empty = none).
    static constexpr int kMaxCutouts = 64;
    void setCutouts(const float* boxes, uint32_t n);
    // Palette ids of the garrison room interior materials (CityRenderer.cpp; free ids above the baked palette).
    static constexpr int kInteriorMat = 240, kInteriorMats = 12;

    CitySettings settings;
    CityWater water;          // smooth water surfaces (WATR)
    CityFoliage foliage;      // instanced crops / grass / reeds (FOLI)
    const CityRenderStats& stats() const { return stats_; }

private:
    struct GpuTile {
        SDL_GPUBuffer *vb = nullptr, *ib = nullptr;   // ib only for legacy explicitly indexed meshes
        struct Lod {
            uint32_t vtxOffset = 0, first = 0, count = 0;   // indices; shared = the renderer's quad index buffer
            bool shared = true;
            float origin[4] = {0, 0, 0, 0}, scale[4] = {0, 0, 0, 0};
        } lods[3];
        float bmin[3], bmax[3];
        std::vector<CityChunk> chunks;      // empty: one range per LOD
        std::vector<uint8_t> chunkLod;
        bool hasLod2 = false;                // baked LOD2 (else chunked tiles draw LOD1 chunks far away)
        std::vector<std::pair<uint32_t, uint32_t>> ranges;   // this frame: (first index, index count), merged when contiguous
        uint32_t indFirst = 0;              // this frame: first command of its ranges in the indirect buffer
        std::vector<std::pair<uint32_t, uint32_t>> sranges;   // this frame: shadow-caster ranges (LOD slod)
        uint32_t sindFirst = 0;
        int slod = 0;
        std::vector<CityInstance> instances;
        std::vector<float> coarse;          // 32 x 32 max-height cells of 4 m (camera avoidance)
        float cx0 = 0, cz0 = 0;
        uint64_t lastUsed = 0, bytes = 0;
        int lod = 0;
        bool visible = false;
    };
    void upload(SDL_GPUCopyPass* cp, TileCPU& t);
    GpuMesh uploadMesh(const CityMesh& m, const char* name);
    static CityMesh midMesh(const CityMesh& m, const std::vector<CityMaterial>& mats);
    bool sphereVisible(float x, float y, float z, float r) const;
    void gatherInstance(std::vector<std::vector<GpuInstance>> (&byModel)[3], uint32_t kind, uint32_t variant, const float* pos,
                        const float* q, const float* paint);
    CityVehicles* vehicles_ = nullptr;
    bool boxVisible(const float* mn, const float* mx) const;
    void computeWanted(const Camera& cam, float aspect, std::vector<int>& out) const;
    void evict(uint64_t frame);

    GpuContext* gpu_ = nullptr;
    CityAsset* asset_ = nullptr;
    SDL_GPUGraphicsPipeline *pipe_ = nullptr, *pipeNoCull_ = nullptr, *pipeShadow_ = nullptr, *pipeShadowExt_ = nullptr;   // Ext: lab draws (dissolve)
    bool boxInPlanes(const float (*planes)[4], int n, const float* mn, const float* mx) const;
    float shadowPlanes_[5][4];                    // light clip box minus its near plane (depth clamped)
    bool shadowCull_ = false;
    uint32_t shadowCalls_ = 0;
    ShadowMapBinding shadowMap_;
    SDL_GPUBuffer* lampGrid_ = nullptr;
    uint32_t lampCount_ = 0;
    uint64_t lampSig_ = 0;
    void rebuildLampGrid(SDL_GPUCommandBuffer* cmd);
    void bindShadowMap(SDL_GPURenderPass* pass) const;
    void pushCutouts(SDL_GPUCommandBuffer* cmd, bool tiles) const;
    std::vector<float> cutouts_;
    SDL_GPUBuffer *materials_ = nullptr, *instances_ = nullptr, *dummy_ = nullptr;
    SDL_GPUBuffer* quadIB_ = nullptr;            // shared u32 index buffer of the implicit quad pattern
    uint32_t quadIBQuads_ = 0;
    void ensureQuadIB(SDL_GPUCopyPass* cp, uint32_t quads);
    SDL_GPUTransferBuffer* instTB_ = nullptr;
    SDL_GPUBuffer* indirect_ = nullptr;           // per frame: indexed indirect commands of all tile ranges
    SDL_GPUTransferBuffer* indirectTB_ = nullptr;
    uint32_t indirectCap_ = 0;
    bool indirectReady_ = false;
    uint32_t instCapacity_ = 0;
    std::unordered_map<int, GpuTile> tiles_;      // key = j * ni + i
    std::unordered_map<int, bool> pending_;      // requested, not yet uploaded
    std::vector<int> wanted_;
    std::vector<TileCPU> decoded_;               // decoded, waiting for upload budget
    std::vector<GpuMesh> models_[3];             // [full / mid / box][vehicle variants..., props...]; vb null = use a finer one
    struct VDraw { uint32_t model, first, count, lod; };
    std::vector<VDraw> vdraws_;
    float frustum_[6][4];
    V3 eye_{}, focus_{};   // LOD reference: min(distance to eye, distance to the camera target)
    CityRenderStats stats_;
};

} // namespace ttz
