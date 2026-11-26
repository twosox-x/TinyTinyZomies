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
#include "render/ShadowPass.h"
#include "sim/CrowdSim.h"

#include <array>
#include <string>
#include <vector>

namespace ttz {

struct CharacterSettings {
    int geometryLevel = 3;      // 0 naive cubes, 1 hidden faces removed (Zombie Lab mesher), 2 greedy by material,
                                // 3 greedy by AO with per-voxel material lookup (default, lossless)
    int classMode = 1;          // 0 one batch per body-part family, 1 batches by vertex-count size class (default)
    bool frustumCull = true;
    bool poseInVertexShader = false;   // comparison mode: evaluate the joint hierarchy per vertex
    bool occlusionCull = true;  // conservative culling behind static buildings
    uint32_t forcedAnim = 0;    // ANIM_* override for previews (0 = from simulation state)
    bool quadIndexing = true;   // draw faces as indexed quads (4 shaded vertices per face instead of 6)
};

struct CharacterStats {         // from the GPU counters (async in the app, exact in benchmarks)
    uint32_t visible = 0, visibleAgents = 0, visibleCorpses = 0, overflow = 0, segments = 0, triangles = 0, vsInvocations = 0, occluded = 0,
             visibleGibs = 0;
};

class CharacterRenderer {
public:
    bool init(GpuContext& gpu, const SimParams& p, const std::string& assetPath, uint32_t visibleCapacity);
    void shutdown();

    // Records passes 1-3 (outside any render pass).
    void prepare(SDL_GPUCommandBuffer* cmd, const CrowdSim& sim, const float viewProj[16], const float eye[3], double time, const CharacterSettings& cs);
    // static occluders (tall buildings and walls of the current map)
    void setOccluders(const std::vector<float>& boxesMinMax);
    void setShadowField(SDL_GPUBuffer* b) { shadowField_ = b; }   // owned by the Renderer
    void setShadowMap(const ShadowMapBinding& b) { shadowMap_ = b; }   // key-light shadow map (owned by the Renderer)
    // Records the draws inside the scene render pass (frame uniforms already pushed to slot 0).
    void draw(SDL_GPUCommandBuffer* cmd, SDL_GPURenderPass* pass, const CrowdSim& sim, double time, const CharacterSettings& cs,
              bool depthOnly = false);
    // The same characters into the key-light shadow pass (light view-projection in vertex slot 0; camera-culled list).
    void drawShadow(SDL_GPUCommandBuffer* cmd, SDL_GPURenderPass* pass, const CrowdSim& sim, double time, const CharacterSettings& cs) {
        draw(cmd, pass, sim, time, cs, true);
    }

    // Military Asset Lab: draw `count` externally posed body segments (SegInst layout, e.g. from shaders/mil_pose.comp)
    // with the approved segment meshes / material shader (geometry level 3, triangle lists, one draw padded to the
    // largest mesh). Separate from the zombie path: no culling, no counters, nothing shared is written.
    void drawExternal(SDL_GPUCommandBuffer* cmd, SDL_GPURenderPass* pass, const CrowdSim& sim, SDL_GPUBuffer* segs, uint32_t count,
                      bool depthOnly = false);

    uint32_t drawCalls(const CharacterSettings& cs) const { return (uint32_t)classSet(cs).maxVerts.size(); }
    bool quadIndexingAvailable(int level) const { return quadOK_[level]; }
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
    SDL_GPUBuffer* shadowField_ = nullptr;
    ShadowMapBinding shadowMap_;
    SDL_GPUGraphicsPipeline* pShadow_ = nullptr;
    struct ClassSet { std::vector<uint32_t> maxVerts; SDL_GPUBuffer* meshInfo = nullptr; SDL_GPUBuffer* classInfo = nullptr; };
    bool loadAsset(const std::string& path);
    void buildQuads();
    void buildClasses();
    bool indexed(const CharacterSettings& cs) const { return cs.quadIndexing && quadOK_[cs.geometryLevel]; }
    const ClassSet& classSet(const CharacterSettings& cs) const { return classes_[cs.geometryLevel][cs.classMode][indexed(cs) ? 1 : 0]; }

    GpuContext* gpu_ = nullptr;
    float scale_ = 1.7f / 18.f;
    uint32_t capacity_ = 0, corpseCapacity_ = 0, meshCount_ = 0;
    uint64_t assetBytes_ = 0;
    std::vector<uint32_t> words_;                       // all three levels, concatenated
    std::array<uint32_t, 4> levelBase_{};
    std::vector<uint32_t> meshVox_, tagWords_;
    std::vector<uint32_t> meshTable_;                   // [mesh*3+level]*2: offset, count
    std::vector<uint32_t> meshFamily_;
    LevelStats levelStats_[4];
    ClassSet classes_[4][2][2];                         // [level][class mode][indexed quads]
    std::vector<uint32_t> quadWords_, quadTable_;       // quad layout: 4 vertices per face; [mesh*4+level]*2: offset, count
    bool quadOK_[4] = {false, false, false, false};
    uint32_t maxQuadIndices_ = 0;

    SDL_GPUComputePipeline *pCull_ = nullptr, *pPrefix_ = nullptr, *pPose_ = nullptr, *pLib_ = nullptr;
    SDL_GPUGraphicsPipeline* pDraw_ = nullptr;
    SDL_GPUBuffer *verts_ = nullptr, *counters_ = nullptr, *args_ = nullptr, *visList_ = nullptr, *segLocal_ = nullptr,
                  *segInsts_ = nullptr, *poseLib_ = nullptr;
    SDL_GPUBuffer *meshVoxBuf_ = nullptr, *tagBuf_ = nullptr, *occluders_ = nullptr, *quadVerts_ = nullptr, *quadIndex_ = nullptr;
    uint32_t occluderCount_ = 0;
    SDL_GPUBuffer* extCounters_ = nullptr;   // all zero: class base 0 for drawExternal
    SDL_GPUTransferBuffer* zeros_ = nullptr;
};

} // namespace ttz
