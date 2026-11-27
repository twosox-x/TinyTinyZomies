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

struct GpuCorpse {          // 32 bytes: pos(xyz, yaw), info(lookX, lookY, alive|pose<<8, height bits)
    Vec4 pos;
    UVec4 info;
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
    Vec4 lookA;       // appearance category weights: recent, clothed, light damage, heavy damage
    Vec4 lookB;       // x skeletal, y missing limb, z spawn as corpse
    UVec4 forcedLook; // x/y look bits, z = 1 to force
    Vec4 goreP;       // x blood amount, y dismember chance, z gib threshold, w enabled
    UVec4 goreCap;    // x particle capacity, y gib capacity, z decal grid width, w decal grid height
    Vec4 goreQ;       // x tumble damping, y metres per voxel
    Vec4 roamP;       // ambient roaming: x enabled, y wander speed, z pause fraction, w alert memory (s)
    Vec4 roamQ;       // x separation, y lurker fraction, z crawler fraction, w noise-field wavelength (m)
};
// gore buffers: counters (uint) and per-element layouts (see shaders/include/gore.glsl)
enum : uint32_t { G_PARTICLE_HEAD = 0, G_GIB_HEAD = 1, G_PARTICLES_ALIVE = 2, G_GIBS_ALIVE = 3, G_SEVERED = 4, G_GIBBED = 5,
                  G_DRAW_ARGS = 8, G_COUNT = 16 };
constexpr uint32_t kParticleBytes = 32, kGibBytes = 64, kDecalScale = 3;

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

// ---- gameplay coupling (src/game/HordeBridge, docs/GAMEPLAY_ARCHITECTURE.md 3.3) ----------------------------------
// SimUniforms.goreQ.z = awareness gate (nav distance beyond which the flow is zeroed, 0 = off),
// SimUniforms.goreQ.w = GAME_* flags (as a float). All zero unless a HordeBridge drives the sim: the showcase is unchanged.
enum : uint32_t { GAME_HITS = 1u, GAME_SOLDIERS = 2u, GAME_SEEDS = 4u, GAME_VERTICAL = 8u };   // GAME_VERTICAL: B3b (HordeVertical)
constexpr uint32_t kGameMaxSoldiers = 2048;   // == game::kMaxGpuSoldiers
constexpr uint32_t kGameKillCap = 1024;       // kill records per readback (== game::kMaxKillsPerFrame)
constexpr uint32_t kGameKillHeader = 16;      // uints: [0] records this readback, [1] session seq, [2] overflow total
constexpr uint32_t kGameNoSeed = 0xFFFFFFFFu; // navSeed: no attractor source in this cell
// SDL3 GPU allows 8 read-only + 8 read-write storage buffers per compute stage, so the coupling buffers are merged:
//   gameIO    (uint): [0, kGameKillWords) kill ring (header + records), then 4 uints per agent of queued bullet damage
//   gameSolid (uint): [0, kGameSoldierWords) GpuSoldier[kGameMaxSoldiers], then 2 layers x cells soldier index + 1
constexpr uint32_t kGameKillWords = kGameKillHeader + kGameKillCap * 8;
constexpr uint32_t kGameSoldierWords = kGameMaxSoldiers * 8;
struct GpuSoldier {         // 32 bytes: feet xyz + capsule radius, x height, y attraction, z packed id
    Vec4 posR;
    Vec4 info;
};
static_assert(sizeof(GpuSoldier) == 32);
struct GpuHitRequest {      // 48 bytes: origin + max distance, unit dir + damage, x shooter, y flags
    Vec4 o;
    Vec4 d;
    UVec4 info;
};
static_assert(sizeof(GpuHitRequest) == 48);
struct GpuKillRecord {      // 32 bytes: x seq (1-based, session), y cause, z shooter; pos xyz
    UVec4 a;
    Vec4 p;
};
static_assert(sizeof(GpuKillRecord) == 32);

} // namespace ttz
