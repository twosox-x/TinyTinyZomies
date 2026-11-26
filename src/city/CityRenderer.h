#pragma once
// Streams baked city tiles to the GPU and draws them inside the scene pass.
//  - residency: tiles under the camera's ground footprint (+1 tile ring) are requested nearest-first from the
//    CityAsset decode thread; decoded tiles are uploaded on the main thread within a per-frame byte budget;
//    an LRU keeps at most `maxResident` tiles (tiles in the wanted set are never evicted).
//  - LOD: per tile, LOD1 beyond lodFar metres from the eye, back to LOD0 inside lodNear (hysteresis).
//  - draw: one pipeline, one indexed draw per visible tile (frustum-culled by AABB); per-vertex material
//    from a palette storage buffer. Vehicles: one instanced draw per variant and LOD (mesh near, box far),
//    instances gathered from visible tiles into a per-frame storage buffer.
#include "city/CityAsset.h"
#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "sim/Sandbox.h"

#include <unordered_map>
#include <vector>

namespace ttz {

struct CityRenderStats {
    uint32_t resident = 0, visible = 0, wanted = 0, pending = 0, drawCalls = 0, lod1Tiles = 0;
    uint64_t triangles = 0, vehicles = 0, gpuBytes = 0;
    double uploadMs = 0;       // CPU time spent recording uploads this frame
    uint32_t uploadedTiles = 0;
    uint64_t uploadedBytes = 0;
};

struct CitySettings {
    bool draw = true, vehicles = true;
    float lodFar = 420.f, lodNear = 380.f;          // m (City Lab: FAR 420, NEAR = FAR - 40)
    float vehicleBoxDist = 160.f;                   // vehicles beyond this distance draw their LOD1 box proxy
    float propDist = 260.f;                         // street furniture beyond this distance is not drawn
    bool props = true;
    uint64_t uploadBudgetBytes = 8ull << 20;        // per frame
    int maxResident = 96;
    bool backfaceCull = true;
};

class CityRenderer {
public:
    bool init(GpuContext& gpu, CityAsset& asset, SDL_GPUSampleCount samples);
    void shutdown();

    // Main thread, before the scene render pass: residency, LOD, uploads (own copy pass), instance upload.
    void update(SDL_GPUCommandBuffer* cmd, const Camera& cam, float aspect, uint64_t frame);
    // Inside the scene pass (frame uniforms already pushed to vertex/fragment slot 0).
    // frag buffers: decals, shadow field, corpse heights (sim window); null-safe for tests.
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadowH,
              SDL_GPUBuffer* corpseH);
    // Highest static top (m) near (x, z) from resident tiles (4 m cells; camera obstacle avoidance), 0 if unknown.
    float heightAt(float x, float z) const;
    // Street-lamp point lights nearest to (x, z) among visible tiles.
    void nearestLamps(float x, float z, int maxCount, std::vector<PointLight>& out) const;
    // Blocks until every wanted tile is resident (benchmarks / headless screenshots).
    void flush(const Camera& cam, float aspect);

    CitySettings settings;
    const CityRenderStats& stats() const { return stats_; }

private:
    struct GpuTile {
        SDL_GPUBuffer *vb = nullptr, *ib = nullptr;
        uint32_t idxOffset[2] = {0, 0}, idxCount[2] = {0, 0}, vtxOffset[2] = {0, 0};
        float origin[2][4], scale[2][4];    // per LOD
        float bmin[3], bmax[3];
        std::vector<CityInstance> instances;
        std::vector<float> coarse;          // 32 x 32 max-height cells of 4 m (camera avoidance)
        float cx0 = 0, cz0 = 0;
        uint64_t lastUsed = 0, bytes = 0;
        int lod = 0;
        bool visible = false, index16 = false;
    };
    struct GpuMesh {
        SDL_GPUBuffer *vb = nullptr, *ib = nullptr;
        uint32_t idxCount = 0;
        float origin[4], scale[4];
        float top = 0;
    };
    void upload(SDL_GPUCopyPass* cp, TileCPU& t);
    GpuMesh uploadMesh(const CityMesh& m, const char* name);
    void computeWanted(const Camera& cam, float aspect, std::vector<int>& out) const;
    void evict(uint64_t frame);

    GpuContext* gpu_ = nullptr;
    CityAsset* asset_ = nullptr;
    SDL_GPUGraphicsPipeline *pipe_ = nullptr, *pipeNoCull_ = nullptr;
    SDL_GPUBuffer *materials_ = nullptr, *instances_ = nullptr, *dummy_ = nullptr;
    SDL_GPUTransferBuffer* instTB_ = nullptr;
    uint32_t instCapacity_ = 0;
    std::unordered_map<int, GpuTile> tiles_;      // key = j * ni + i
    std::unordered_map<int, bool> pending_;      // requested, not yet uploaded
    std::vector<int> wanted_;
    std::vector<TileCPU> decoded_;               // decoded, waiting for upload budget
    std::vector<GpuMesh> models_[2];             // [lod][vehicle variants..., props...]
    struct VDraw { uint32_t model, first, count, lod; };
    std::vector<VDraw> vdraws_;
    float frustum_[6][4];
    V3 eye_{};
    CityRenderStats stats_;
};

} // namespace ttz
