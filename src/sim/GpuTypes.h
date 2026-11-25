#pragma once
// CPU mirrors of GPU structures. Must match shaders/include/common.glsl.
#include <cstdint>

namespace ttz {

struct alignas(16) Vec4 { float x = 0, y = 0, z = 0, w = 0; };
struct alignas(16) UVec4 { uint32_t x = 0, y = 0, z = 0, w = 0; };

constexpr int kMaxGoals = 4;
constexpr int kMaxExplosions = 8;

enum AgentState : uint32_t { ST_WALK = 0, ST_CLIMB = 1, ST_FALL = 2, ST_DYING = 3, ST_DEAD = 4 };

struct GpuAgent {           // 80 bytes, std430
    Vec4 pos, vel, prev, dirs;
    UVec4 info;
};
static_assert(sizeof(GpuAgent) == 80);

struct GpuCorpse {          // 32 bytes
    Vec4 pos, info;
};
static_assert(sizeof(GpuCorpse) == 32);

struct SimUniforms {        // std140, all vec4 members
    Vec4 world;
    UVec4 grid;
    Vec4 timeP;
    Vec4 agentP;
    Vec4 moveP;
    Vec4 crowdP;
    Vec4 solverP;
    Vec4 climbP;
    Vec4 corpseP;
    Vec4 navP;
    Vec4 goals[kMaxGoals];
    Vec4 explo[kMaxExplosions];
    Vec4 exploP[kMaxExplosions];
    UVec4 counts;
    Vec4 spawnRect;
    UVec4 misc;
    Vec4 extraP;
};

// counters buffer indices
enum : uint32_t {
    C_LIVE = 0, C_APPEND = 1, C_CORPSES = 2, C_DEATHS_TOTAL = 3, C_CLIMBING = 4, C_AIRBORNE = 5,
    C_MAX_HEIGHT_MM = 6, C_REACTIVATED = 7, C_ELEVATED = 8, C_CORPSE_OVERFLOW = 9, C_PREV_LIVE = 10,
    C_COUNT = 16
};
// indirect buffer indices (uint32)
enum : uint32_t { I_AGENT_DISPATCH = 0, I_CORPSE_DISPATCH = 4, I_ZOMBIE_DRAW = 8, I_CORPSE_DRAW = 16, I_COUNT = 24 };

constexpr uint32_t FLAG_VERTICAL = 1u;
constexpr uint32_t FLAG_CORPSES = 2u;

} // namespace ttz
