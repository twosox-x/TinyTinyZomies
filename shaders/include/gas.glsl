// Corpse rot gas + flamethrower fire (GAME_DESIGN 14d; src/game/CorpseGas.*). A coarse grid over the simulation window
// (gas cell = GAS_DIV x GAS_DIV sim cells = 1.5 m), ping-ponged each update:
//   GasCell (uvec4): x gas level (float bits, 0..maxGas), y ground-fire seconds left (float bits), z packed id of the
//                    soldier who lit it (kill credit), w corpses in the cell (bits 0..15) | rotting corpses (16..31)
//   accum (uint x4 per cell, cleared by the field pass): emission (1/65536 gas units), corpses, rotting, fire (1/256 s, max)
//   corpse rot (uvec4 per corpse slot): x key (position hash: a new corpse in a reused / reset slot starts fresh),
//                    y age s, z ignition progress s, w burn time s (float bits; w > 0: burning)
// Must match GasUniforms in src/game/CorpseGas.cpp. Uniform slot 1 (slot 0 = SimUniforms).
#ifndef TTZ_GAS_GLSL
#define TTZ_GAS_GLSL
#define GAS_DIV 2u
#define GAS_MAX_CONES 16
#define GAS_STAT_BURNED 0u      // corpses burnt away (session total)
#define GAS_STAT_BURNING 1u     // per update: corpses burning now
#define GAS_STAT_ROTTING 2u     // per update: rotting corpses in the window
#define GAS_STAT_CORPSES 3u     // per update: corpses in the window
#define GAS_STAT_FLAMED 4u      // reserved (zombie flame damage goes through HordeBridge hit rays, FlameAI::coneRays)
#define GAS_STAT_IGNITED 5u     // corpses ignited (session total)
#define GAS_STAT_WORDS 16u
layout(std140, set = 2, binding = 1) uniform GasUniforms {
    uvec4 gdim;     // x gasW, y gasH, z cells, w number of flame cones
    ivec4 gshift;   // x, y: shift (gas cells) of the window since the last update (field pass reads src at +shift), z flags (1 rot on), w frame
    vec4  rotP;     // x dt (s), y rot delay, z ramp, w emission per rotten corpse per s
    vec4  airP;     // x diffusion /s, y decay /s, z max gas, w ground-fire time (s)
    vec4  fireP;    // x ignite time, y burn time, z cone dps, w ground-fire dps
    vec4  miscP;    // x corpse capacity, y time (s), z gas burnt off per s in fire, w building height (m: no gas above)
    vec4  coneA[GAS_MAX_CONES];   // xyz nozzle, w range (m)
    vec4  coneB[GAS_MAX_CONES];   // xyz unit direction, w cos(half angle)
    uvec4 coneC[GAS_MAX_CONES];   // x shooter packed id, y spray seconds (float bits)
};
uint gasIndex(ivec2 g) { return uint(g.y) * gdim.x + uint(g.x); }
ivec2 gasCoord(vec2 xz) {
    vec2 g = (xz - world.xy) * (world.w / float(GAS_DIV));
    return ivec2(floor(g));
}
bool gasInside(ivec2 g) { return g.x >= 0 && g.y >= 0 && g.x < int(gdim.x) && g.y < int(gdim.y); }
vec2 gasCentre(ivec2 g) { return world.xy + (vec2(g) + 0.5) * (world.z * float(GAS_DIV)); }
// spray seconds of every cone that covers point p (lateral slack `slack` m)
float coneCover(vec3 p, float slack, out uint owner) {
    float s = 0.0;
    owner = 0u;
    for (uint k = 0u; k < gdim.w && k < uint(GAS_MAX_CONES); ++k) {
        vec3 d = p - coneA[k].xyz;
        float along = dot(d, coneB[k].xyz);
        if (along < 0.0 || along > coneA[k].w) continue;
        float l = length(d);
        float lat = sqrt(max(l * l - along * along, 0.0));
        float rad = along * sqrt(max(1.0 - coneB[k].w * coneB[k].w, 0.0)) / max(coneB[k].w, 0.2);
        if (lat > rad + slack) continue;
        float t = uintBitsToFloat(coneC[k].y);
        if (t > s) { s = t; owner = coneC[k].x; }
    }
    return s;
}
#endif
