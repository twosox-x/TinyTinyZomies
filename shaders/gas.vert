#version 450
#extension GL_GOOGLE_include_directive : require
// Corpse gas haze, flies and ground fire (GAME_DESIGN 14d; src/game/CorpseGas.cpp). One instance per listed gas cell
// (game_gas_field appends cells with gas, fire or rotting corpses), 9 voxel boxes per instance (vertex pulling):
//   0..4  legacy drifting gas puffs, drawn only when the voxel fog volume (gas_volume.*, owner round 15 item 10) is off
//         (owner 2026-11-28 / GAME_DESIGN 14e: "no grid overlay, the gas particles more noticeable"):
//         voxel cubes of 0.375-1.25 m (0.125 m steps) swirling slowly round the cell and rising, more and bigger with
//         the gas level; spread over +-0.9 cell so neighbouring cells overlap (no cell-aligned slab / grid look);
//         sickly yellow-green with a faint glow (reads at dusk / night), alpha <= 0.24 each (units stay readable)
//   5..7  flies: tiny dark voxels circling over rotting bodies
//   8     ground fire: a sparse rising ember (the flames are fx_volume pools, Renderer::setFlameVolumes)
// Unused boxes collapse to a point (no fragments).
#define FRAME_SET 1
#include "common.glsl"
#include "frame.glsl"
layout(std430, set = 0, binding = 0) readonly buffer List    { uint list[]; };
layout(std430, set = 0, binding = 1) readonly buffer Field   { uvec4 field[]; };
layout(std430, set = 0, binding = 2) readonly buffer StaticH { float staticH[]; };
layout(std430, set = 0, binding = 3) readonly buffer CorpseH { int corpseH[]; };
layout(std140, set = 1, binding = 1) uniform GasDraw {
    vec4 gOrigin;   // x originX, y originZ, z gas cell (m), w sim cell (m)
    uvec4 gDim;     // x gasW, y gasH, z simW, w simH
    vec4 gStyle;    // x puff alpha scale, y time (s), z 1 = legacy puffs (CorpseGasRender::voxelFog off), w unused
};
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out vec4 vColor;      // rgb linear, a alpha
layout(location = 3) flat out float vEmissive;  // 1: emissive (fire), 0: lit
const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
const ivec3 CORNER[24] = ivec3[24](ivec3(1, 0, 0), ivec3(1, 1, 0), ivec3(1, 1, 1), ivec3(1, 0, 1),
                                   ivec3(0, 0, 1), ivec3(0, 1, 1), ivec3(0, 1, 0), ivec3(0, 0, 0),
                                   ivec3(0, 1, 0), ivec3(0, 1, 1), ivec3(1, 1, 1), ivec3(1, 1, 0),
                                   ivec3(0, 0, 1), ivec3(0, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 1),
                                   ivec3(1, 0, 1), ivec3(1, 1, 1), ivec3(0, 1, 1), ivec3(0, 0, 1),
                                   ivec3(0, 0, 0), ivec3(0, 1, 0), ivec3(1, 1, 0), ivec3(1, 0, 0));
const int QUAD[6] = int[6](0, 1, 2, 0, 2, 3);
float simTop(vec2 xz) {
    ivec2 c = clamp(ivec2(floor((xz - gOrigin.xy) / gOrigin.w)), ivec2(0), ivec2(gDim.zw) - 1);
    uint id = uint(c.y) * gDim.z + uint(c.x);
    return max(staticH[id], 0.0) + float(corpseH[id]) * 0.001;
}
void main() {
    uint cell = list[4u + uint(gl_InstanceIndex)];
    uvec4 f = field[cell];
    float gas = uintBitsToFloat(f.x), fire = uintBitsToFloat(f.y);
    uint rotting = f.w >> 16;
    ivec2 g = ivec2(cell % gDim.x, cell / gDim.x);
    vec2 c0 = gOrigin.xy + vec2(g) * gOrigin.z;
    vec2 cc = c0 + 0.5 * gOrigin.z;
    int box = gl_VertexIndex / 36, v = gl_VertexIndex % 36, face = v / 6;
    vec3 corner = vec3(CORNER[face * 4 + QUAD[v % 6]]);
    float t = gStyle.y;
    uint seed = cell * 2654435761u + uint(box) * 40503u;
    float h1 = hash01(seed), h2 = hash01(seed ^ 0x9E3779B9u), h3 = hash01(seed * 7u + 3u);
    vec3 lo = vec3(0.0), size = vec3(0.0);
    vec4 col = vec4(0.0);
    float em = 0.0;
    bool on = false;
    float ground = simTop(cc);
    if (box <= 4 && gStyle.z > 0.5) {   // legacy drifting puffs (only with the voxel fog off): puff k appears above its own gas threshold
        const float TH[5] = float[5](0.03, 0.10, 0.22, 0.40, 0.65);
        float th = TH[box];
        if (gas > th) {
            float lvl = clamp((gas - th) / 0.6, 0.0, 1.0);              // how far past its threshold
            float ph = fract(t * (0.045 + 0.035 * h3) + h1);              // rise / fade cycle (14-40 s)
            float sw = t * (0.12 + 0.10 * h2) * (h3 > 0.5 ? 1.0 : -1.0) + h1 * 6.2831853;   // slow swirl
            float rad = (0.35 + 0.55 * h2) * gOrigin.z;
            vec2 ctr = cc + (vec2(h1, h2) - 0.5) * gOrigin.z * 0.9 + vec2(cos(sw), sin(sw * 0.8)) * rad;
            ctr += vec2(0.6, 0.25) * t * 0.04 * (0.5 + h3);              // a faint drift with the wind
            ctr = cc + mod(ctr - cc + 0.9 * gOrigin.z, 1.8 * gOrigin.z) - 0.9 * gOrigin.z;   // stays over its cell
            float s = 0.125 * floor((0.375 + (0.35 + 0.55 * lvl) * (0.6 + 0.8 * ph) * min(1.0 + 0.3 * gas, 1.6)) / 0.125);
            s = clamp(s, 0.375, 1.25);
            float y = simTop(ctr) + 0.05 + ph * (0.5 + 0.55 * min(gas, 2.0));
            lo = vec3(ctr.x - 0.5 * s, y, ctr.y - 0.5 * s);
            size = vec3(s);
            float env = smoothstep(0.0, 0.18, ph) * (1.0 - smoothstep(0.6, 1.0, ph));
            vec3 green = mix(vec3(0.36, 0.56, 0.08), vec3(0.58, 0.70, 0.16), h3);
            col = vec4(green, clamp((0.09 + 0.15 * min(gas, 1.5)) * env * gStyle.x, 0.0, 0.24));
            on = col.a > 0.01;
        }
    } else if (box >= 5 && box <= 7 && rotting > 0u) {   // flies over rotting bodies
        float a = t * (2.2 + 1.3 * h1) * (h2 > 0.5 ? 1.0 : -1.0) + h3 * 6.2831;
        float r = 0.3 + 0.45 * h2;
        float s = 0.09;
        lo = vec3(cc.x + cos(a) * r, ground + 0.45 + 0.4 * h1 + 0.12 * sin(t * 7.0 + h3 * 10.0), cc.y + sin(a * 1.3) * r) - vec3(0.5 * s);
        size = vec3(s);
        col = vec4(0.015, 0.015, 0.012, 1.0);
        on = true;
    } else if (box == 8 && fire > 0.0 && h3 < 0.5) {   // ground fire: a sparse rising ember (the fire is an fx volume)
        float ph = fract(t * (0.6 + 0.5 * h3) + h1);
        float s = 0.07;
        lo = vec3(c0.x + 0.15 + h1 * (gOrigin.z - 0.3 - s), ground + 0.4 + ph * 2.5, c0.y + 0.15 + h2 * (gOrigin.z - 0.3 - s));
        size = vec3(s);
        vec3 hot = mix(vec3(9.0, 6.5, 2.4), vec3(5.5, 1.6, 0.25), smoothstep(0.0, 0.5, ph));
        col = vec4(mix(hot, vec3(1.6, 0.25, 0.04), smoothstep(0.5, 1.0, ph)), 0.95);
        em = 1.0;
        on = true;
    }
    if (!on) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vColor = vec4(0.0); vEmissive = 0.0; return; }
    vWorld = lo + corner * size;
    vNormal = NRM[face];
    vColor = col;
    vEmissive = em;
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
