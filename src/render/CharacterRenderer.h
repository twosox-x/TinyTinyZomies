#pragma once
// GPU-driven modular zombie rendering.
//
// Assets: tools/convert_characters.mjs bakes every body-segment variant of the approved Zombie Lab
// library into assets/characters/zombie_parts.ttzc (packed 4-byte vertices, three geometry levels).
// Per frame (all on the GPU, no readback):
//   1. char_cull   frustum-cull zombies and corpses, append visible characters, count segments per size class
//   2. char_prefix class offsets + indirect draw args + pose dispatch size
//   3. char_pose   evaluate 10 joint transforms once per visible character, scatter 32-byte segment instances
//   4. draw        one non-indexed indirect draw per size class, vertices pulled from a storage buffer
// A zombie is never a CPU object: its appearance is 56 bits in its agent record (and its corpse record).
#include "gpu/GpuContext.h"
#include "sim/CrowdSim.h"

#include <array>
#include <string>
#include <vector>

namespace ttz {

struct CharacterSettings {
    int geometryLevel = 2;      // 0 naive cubes, 1 hidden faces removed (Zombie Lab mesher), 2 greedy (default)
    int classMode = 1;          // 0 one batch per body-part family, 1 batches by vertex-count size class (default)
    bool frustumCull = true;
    bool poseInVertexShader = false;   // comparison mode: evaluate the joint hierarchy per vertex
    uint32_t forcedAnim = 0;    // ANIM_* override for previews (0 = from simulation state)
};

struct CharacterStats {         // from the GPU counters (async in the app, exact in benchmarks)
    uint32_t visible = 0, visibleAgents = 0, visibleCorpses = 0, overflow = 0, segments = 0, triangles = 0, vsInvocations = 0;
};

class CharacterRenderer {
public:
    bool init(GpuContext& gpu, const SimParams& p, const std::string& assetPath, uint32_t visibleCapacity);
    void shutdown();

    // Records passes 1-3 (outside any render pass).
    void prepare(SDL_GPUCommandBuffer* cmd, const CrowdSim& sim, const float viewProj[16], double time, const CharacterSettings& cs);
    // Records the draws inside the scene render pass (frame uniforms already pushed to slot 0).
    void draw(SDL_GPUCommandBuffer* cmd, SDL_GPURenderPass* pass, const CrowdSim& sim, double time, const CharacterSettings& cs);

    uint32_t drawCalls(const CharacterSettings& cs) const { return (uint32_t)classes_[cs.geometryLevel][cs.classMode].maxVerts.size(); }
    SDL_GPUBuffer* counters() const { return counters_; }
    SDL_GPUBuffer* segmentInstances() const { return segInsts_; }
    static CharacterStats parseCounters(const uint32_t* cc);
    bool readStatsNow(CharacterStats& out);   // synchronous (tests/benchmarks only)

    struct LevelStats { uint64_t vertices = 0, bytes = 0; };
    const LevelStats& levelStats(int level) const { return levelStats_[level]; }
    uint32_t meshCount() const { return meshCount_; }
    uint64_t assetBytes() const { return assetBytes_; }
    float metresPerVoxel() const { return scale_; }

private:
    struct ClassSet { std::vector<uint32_t> maxVerts; SDL_GPUBuffer* meshInfo = nullptr; SDL_GPUBuffer* classInfo = nullptr; };
    bool loadAsset(const std::string& path);
    void buildClasses();

    GpuContext* gpu_ = nullptr;
    float scale_ = 1.7f / 18.f;
    uint32_t capacity_ = 0, corpseCapacity_ = 0, meshCount_ = 0;
    uint64_t assetBytes_ = 0;
    std::vector<uint32_t> words_;                       // all three levels, concatenated
    std::array<uint32_t, 3> levelBase_{};
    std::vector<uint32_t> meshTable_;                   // [mesh*3+level]*2: offset, count
    std::vector<uint32_t> meshFamily_;
    LevelStats levelStats_[3];
    ClassSet classes_[3][2];

    SDL_GPUComputePipeline *pCull_ = nullptr, *pPrefix_ = nullptr, *pPose_ = nullptr, *pLib_ = nullptr;
    SDL_GPUGraphicsPipeline* pDraw_ = nullptr;
    SDL_GPUBuffer *verts_ = nullptr, *counters_ = nullptr, *args_ = nullptr, *visList_ = nullptr, *segLocal_ = nullptr,
                  *segInsts_ = nullptr, *poseLib_ = nullptr;
    SDL_GPUTransferBuffer* zeros_ = nullptr;
};

} // namespace ttz
