#pragma once
// Smooth water surfaces and instanced voxel foliage of the baked city (FORMAT.md 3: WATR, FOLI; foliage.bin).
//  - CityWater: per tile, 2 m quads of the shore-distance grid at the water level (shaders/city_water.*): depth tint
//    from the shore distance, foam line, animated ripple normals, Fresnel sky + moon + street-lamp reflections.
//  - CityFoliage: per tile, instances sorted by 32 m chunk then type; per visible chunk within fadeDist one instanced
//    draw per type (LOD0 model near, LOD1 beyond lod1Dist), density thinned with distance in the vertex shader,
//    wind sway (shaders/city_foliage.*).
// Both are owned by CityRenderer (hooks: init / upload / release / draw).
#include "city/CityAsset.h"
#include "gpu/GpuContext.h"

#include <functional>
#include <unordered_map>
#include <vector>

namespace ttz {

using BoxVisibleFn = std::function<bool(const float* mn, const float* mx)>;

class CityWater {
public:
    SDL_GPUBuffer* lampGrid = nullptr;   // street-lamp light grid (CityRenderer), fragment storage slot 0
    bool init(GpuContext& gpu, SDL_GPUSampleCount samples, SDL_GPUTextureFormat color, SDL_GPUTextureFormat depth);
    void shutdown();
    uint32_t upload(SDL_GPUCopyPass* cp, int key, const TileCPU& t);   // returns quads (for the shared index buffer)
    void release(int key);
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* quadIB, const BoxVisibleFn& visible);
    uint32_t lastTris = 0;
    bool enabled = true;

private:
    struct Tile { SDL_GPUBuffer* vb = nullptr; uint32_t quads = 0; float level = 0, bmin[3], bmax[3]; };
    GpuContext* gpu_ = nullptr;
    SDL_GPUGraphicsPipeline* pipe_ = nullptr;
    std::unordered_map<int, Tile> tiles_;
};

struct FoliageStats { uint64_t instances = 0, triangles = 0; uint32_t draws = 0; };

class CityFoliage {
public:
    SDL_GPUBuffer* lampGrid = nullptr;   // street-lamp light grid (CityRenderer), fragment storage slot 1
    bool init(GpuContext& gpu, const CityAsset& asset, SDL_GPUSampleCount samples, SDL_GPUTextureFormat color, SDL_GPUTextureFormat depth);
    void shutdown();
    void upload(SDL_GPUCopyPass* cp, int key, const TileCPU& t, float tileX0, float tileZ0);
    void release(int key);
    // tiles: keys of the tiles the city renderer draws this frame
    void draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, const float eye[3], const std::vector<int>& tiles,
              SDL_GPUBuffer* materials, const BoxVisibleFn& visible);
    // Distances (m from the eye): full model below lod1Dist, simple model up to fadeDist, density thinned from fadeStart.
    float lod1Dist = 45.f, fadeStart = 70.f, fadeDist = 150.f;
    bool enabled = true;
    FoliageStats stats;

private:
    struct Tile {
        SDL_GPUBuffer* inst = nullptr;
        std::vector<uint32_t> start;
        uint32_t types = 0, chunks = 0;
        float x0 = 0, z0 = 0;
    };
    struct Model { SDL_GPUBuffer *vb = nullptr, *ib = nullptr; uint32_t idx = 0, quads = 0; float origin[3], scale[2], height = 1.f; };
    GpuContext* gpu_ = nullptr;
    SDL_GPUGraphicsPipeline* pipe_ = nullptr;
    std::vector<Model> models_[2];
    std::vector<float> sway_;
    std::unordered_map<int, Tile> tiles_;
    SDL_GPUBuffer* dummy_ = nullptr;
};

} // namespace ttz
