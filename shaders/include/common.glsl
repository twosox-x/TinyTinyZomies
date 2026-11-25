// Tiny Tiny Zombies - shared GPU definitions.
// Must stay in sync with src/sim/GpuTypes.h (std430 / std140 layouts).
//
// SDL3 GPU SPIR-V binding convention (compute):
//   set 0: read-only storage buffers   (binding 0..n-1, in declaration order)
//   set 1: read-write storage buffers  (binding 0..m-1)
//   set 2: uniform buffers
// SDL_shadercross remaps these to Metal [[buffer(n)]] automatically.

#ifndef TTZ_COMMON_GLSL
#define TTZ_COMMON_GLSL

// ---- Agent states -------------------------------------------------------
#define ST_WALK   0u   // grounded or riding the crowd, steering along the flow field
#define ST_CLIMB  1u   // actively climbing onto a blocking neighbour
#define ST_FALL   2u   // knocked / airborne, no steering (stun timer)
#define ST_DYING  3u   // lethal hit, ragdoll-ish fall until settled
#define ST_DEAD   4u   // settled; converted to a corpse; removed at next sort

struct Agent {
    vec4 pos;   // xyz feet position (y up), w = prone factor 0 (upright) .. 1 (crawling/flat)
    vec4 vel;   // xyz velocity, w = animation phase
    vec4 prev;  // xyz position at start of step, w = "blocked" pressure EMA 0..1
    vec4 dirs;  // xy desired horizontal dir, z = heading (rad), w = state timer (s)
    uvec4 info; // x = state(8) | look bits 8..31, y = look bits (see LOOK LAYOUT), z = see AGENT Z, w = climb target (float bits)
};
/* AGENT Z (info.z): bits 0..15 health (half float), 16..25 severed-segment mask (bit = slot), 26..27 bloodiness 0..3.
   While FALLING / DYING, dirs.xy holds the tumble (x = roll angle, y = roll rate rad/s) instead of the desired velocity. */
float agentHealth(uint z) { return unpackHalf2x16(z & 0xFFFFu).x; }
uint  agentSevered(uint z) { return (z >> 16) & 0x3FFu; }
uint  agentBlood(uint z) { return (z >> 26) & 3u; }
uint  packAgentZ(float health, uint severed, uint blood) {
    return (packHalf2x16(vec2(clamp(health, -60000.0, 60000.0), 0.0)) & 0xFFFFu) | ((severed & 0x3FFu) << 16) | (min(blood, 3u) << 26);
}
#define SEVER_ALL 0x3FFu

struct Corpse {
    vec4 pos;   // xyz resting position (feet), w = yaw
    uvec4 info; // x = look bits (same as Agent.info.x, state bits = 0), y = look bits (Agent.info.y),
                // z = alive (bit 0) | bloodiness << 1 | pose library index << 8 | severed mask << 16,
                // w = height contribution per splat point (float bits)
};
uint corpseSevered(uint z) { return (z >> 16) & 0x3FFu; }
uint corpseBlood(uint z) { return (z >> 1) & 3u; }
#define CORPSE_POSES 64u

/* LOOK LAYOUT — every zombie's modular appearance, generated once at spawn, kept by its corpse.
   info.x: 8..10 head, 11..13 torso, 14..16 upperArmL, 17..19 upperArmR, 20..22 forearmL, 23..25 forearmR,
           26..28 thighL, 29..31 thighR
   info.y: 0..2 shinL, 3..5 shinR, 6..7 detail tier, 8..9 decomposition bucket, 10..12 skin, 13..16 top,
           17..18 shirt, 19..21 pants, 22..24 hair, 25..26 tie, 27..29 hat, 30..31 shoe            */
uint lookBits(uint w, uint lo, uint n) { return (w >> lo) & ((1u << n) - 1u); }

// Indirect / counters layout (uint indices into the counters buffer)
#define C_LIVE          0u
#define C_APPEND        1u
#define C_CORPSES       2u
#define C_DEATHS_TOTAL  3u
#define C_CLIMBING      4u
#define C_AIRBORNE      5u
#define C_MAX_HEIGHT_MM 6u
#define C_REACTIVATED   7u
#define C_ELEVATED      8u
#define C_CORPSE_OVERFLOW 9u
#define C_PREV_LIVE     10u
#define C_COUNT         16u

// Indirect args buffer layout (uint indices)
#define I_AGENT_DISPATCH  0u   // 3 uints
#define I_CORPSE_DISPATCH 4u   // 3 uints
#define I_ZOMBIE_DRAW     8u   // 5 uints (indexed indirect)
#define I_CORPSE_DRAW     16u  // 5 uints

#define MAX_GOALS 4
#define MAX_EXPLOSIONS 8

layout(std140, set = 2, binding = 0) uniform SimUniforms {
    vec4  world;     // x originX, y originZ, z cellSize, w invCellSize
    uvec4 grid;      // x gridW, y gridH, z numCells, w agentCapacity
    vec4  timeP;     // x dt, y simTime, z stepIndex, w iterations
    vec4  agentP;    // x radius, y standHeight, z proneHeight, w baseSpeed
    vec4  moveP;     // x accel, y gravity, z climbSpeed, w stepUp
    vec4  crowdP;    // x densityComfort, y densityMax, z minSpeedFactor, w lookAhead
    vec4  solverP;   // x sor, y stiffness, z massScaleK, w friction
    vec4  climbP;    // x enabled, y blockThreshold, z supportCos, w climbMaxTime
    vec4  corpseP;   // x enabled, y splatHeight, z settleSpeed, w corpseCapacity
    vec4  navP;      // x wDensity, y wClimb, z climbLimit, w goalRadius
    vec4  goals[MAX_GOALS];        // xyz, w active
    vec4  explo[MAX_EXPLOSIONS];   // xyz, w radius
    vec4  exploP[MAX_EXPLOSIONS];  // x strength(impulse m/s), y lethal fraction, z up bias, w active
    uvec4 counts;    // x numGoals, y numExplosions, z spawnCount, w seed
    vec4  spawnRect; // minX, minZ, maxX, maxZ
    uvec4 misc;      // x maxNeighbors, y pass param, z indexCount (zombie mesh), w flags
    vec4  extraP;    // x maxSpeed, y wanderStrength, z proneRate, w crawlSpeed
    vec4  lookA;     // appearance category weights: recently infected, fully clothed, lightly damaged, heavily damaged
    vec4  lookB;     // x skeletal, y missing-limb, z spawnAsCorpse (bench/test), w unused
    uvec4 forcedLook;// x info.x look bits, y info.y look bits, z = 1 to force (showcase / validation)
    vec4  goreP;     // x blood amount, y dismember chance, z gib threshold (blast closeness), w enabled
    uvec4 goreCap;   // x particle capacity, y gib capacity, z decal grid width, w decal grid height
    vec4  goreQ;     // x tumble damping (1/s), y metres per voxel
};

#define FLAG_VERTICAL 1u
#define FLAG_CORPSES  2u

// ---- helpers ------------------------------------------------------------
uint agentState(Agent a)   { return a.info.x & 0xFFu; }
uint agentVariant(Agent a) { return (a.info.x >> 8) & 0xFFu; }   // legacy placeholder palette row
uint agentLookX(Agent a)   { return a.info.x & 0xFFFFFF00u; }

uint pcgHash(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
float rand01(inout uint s) { s = pcgHash(s); return float(s & 0x00FFFFFFu) / 16777216.0; }
float hash01(uint v) { return float(pcgHash(v) & 0x00FFFFFFu) / 16777216.0; }
// stable per-agent random value (look bits double as the agent's identity seed)
float agentVary(Agent a)   { return hash01(a.info.y ^ (a.info.x >> 8) * 2654435761u); }


ivec2 cellCoord(vec2 xz) {
    vec2 g = (xz - world.xy) * world.w;
    return clamp(ivec2(floor(g)), ivec2(0), ivec2(int(grid.x) - 1, int(grid.y) - 1));
}
uint cellIndex(ivec2 c) { return uint(c.y) * grid.x + uint(c.x); }

// Desired horizontal velocity encoded in one always-normal float: angle in [0, 8) + 8 * quantised speed.
// (Bit-packing two halfs into a float is unsafe: denormal patterns may be flushed to zero.)
float encodeDesired(vec2 v) {
    float s = length(v);
    if (s < 1e-3) return 0.0;
    float ang = atan(v.y, v.x) + 3.14159265;            // (0, 2pi]
    return ang + 8.0 * round(min(s, 50.0) * 100.0);
}
vec2 decodeDesired(float e) {
    if (e <= 0.0) return vec2(0.0);
    float q = floor(e / 8.0);
    float ang = e - 8.0 * q - 3.14159265;
    return vec2(cos(ang), sin(ang)) * (q * 0.01);
}

float bodyHeight(float prone) { return mix(agentP.y, agentP.z, clamp(prone, 0.0, 1.0)); }

#endif
