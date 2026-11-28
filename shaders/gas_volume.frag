#version 450
#extension GL_GOOGLE_include_directive : require
// Corpse gas voxel fog (owner round 15 item 10), the explosion / flame volumes' technique (include/fx_volume_frag.glsl:
// Amanatides-Woo DDA over the world-aligned voxel grid, density at each voxel centre, per-voxel colour jitter) made
// translucent: every voxel the ray crosses holds one constant density, so the fog is built of soft cubes (voxel art,
// 0.25 m close / 0.5 m / 1 m far by projected size) composited front to back. Density: the gas field bilinearly
// interpolated (never a 1.5 m cell edge) under a slow domain warp, a low rolling top (0.5-2.4 m by gas level, churned by
// drifting noise), thinning towards the top; the walk stops at the ground / buildings / cars / corpse piles (sim height
// field), so the fog hugs the street and never shows through walls. Shading: sickly yellow-green, lit like the scene
// (sun, cloud shadows, moon, point lights: fires glow in it), darker deep inside / low down, lighter on top, a faint
// own glow so it reads at night. Opacity is capped (gStyle.w) so units stay readable through it.
#define FRAME_SET 3
#define GAS_SET 3
#include "frame.glsl"
#include "lighting.glsl"
#include "gas_volume.glsl"
layout(std430, set = 2, binding = 0) readonly buffer Field   { uvec4 field[]; };
layout(std430, set = 2, binding = 1) readonly buffer StaticH { float staticH[]; };
layout(std430, set = 2, binding = 2) readonly buffer CorpseH { int corpseH[]; };
layout(location = 0) in vec3 vWorld;
layout(location = 1) flat in int vIdx;
layout(location = 0) out vec4 outColor;

uint gHash(uvec3 p) {
    uint h = p.x * 73856093u ^ p.y * 19349663u ^ p.z * 83492791u;
    h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
    return h;
}
float gH01(ivec3 p) { return float(gHash(uvec3(p)) & 0xFFFFFFu) / 16777216.0; }
float gNoise(vec3 p) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(gH01(i), gH01(i + ivec3(1, 0, 0)), f.x), b = mix(gH01(i + ivec3(0, 1, 0)), gH01(i + ivec3(1, 1, 0)), f.x);
    float c = mix(gH01(i + ivec3(0, 0, 1)), gH01(i + ivec3(1, 0, 1)), f.x), d = mix(gH01(i + ivec3(0, 1, 1)), gH01(i + ivec3(1, 1, 1)), f.x);
    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float simTop(vec2 xz) {
    ivec2 c = clamp(ivec2(floor((xz - gOrigin.xy) / gOrigin.w)), ivec2(0), ivec2(gDim.zw) - 1);
    uint id = uint(c.y) * gDim.z + uint(c.x);
    return max(staticH[id], 0.0) + float(corpseH[id]) * 0.001;
}
float gasCell(ivec2 c) {
    if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(gDim.xy)))) return 0.0;
    return max(uintBitsToFloat(field[uint(c.y) * gDim.x + uint(c.x)].x), 0.0);
}
float gasAt(vec2 xz) {   // bilinear between gas cell centres
    vec2 g = (xz - gOrigin.xy) / gOrigin.z - 0.5;
    ivec2 i = ivec2(floor(g));
    vec2 f = g - vec2(i);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gasCell(i), gasCell(i + ivec2(1, 0)), f.x), mix(gasCell(i + ivec2(0, 1)), gasCell(i + ivec2(1, 1)), f.x), f.y);
}
const vec2 GAS_WIND = vec2(0.22, 0.10);   // slow drift of the churn (m/s)

// density (extinction per metre) of the voxel centred at q; hf: height in the fog layer 0 (ground) .. 1 (top)
float gasDensity(vec3 q, float ground, float t, out float hf) {
    hf = 0.0;
    vec2 drift = GAS_WIND * t;
    vec2 w = vec2(gNoise(vec3((q.xz - drift) * 0.21, t * 0.05)), gNoise(vec3((q.xz - drift) * 0.21 + 19.7, t * 0.05 + 3.1))) - 0.5;
    float g = gasAt(q.xz + w * 2.6);                          // warped: rolling, rounded lobes, no cell squares
    if (g < 0.01) return 0.0;
    float lvl = min(g * 4.0, 3.0);                            // in-game gas: ~0.05 thin .. 0.25 thick .. 0.75+ dense
    float roll = gNoise(vec3((q.xz - drift * 1.6) * 0.33, t * 0.08 + 7.0));   // rolling, churning top
    float top = (0.5 + 0.85 * sqrt(lvl)) * (0.7 + 0.6 * roll);
    float h = q.y - ground;
    hf = clamp(h / max(top, 0.1), 0.0, 1.0);
    if (h > top) return 0.0;
    float edge = smoothstep(0.01, 0.1, g);                    // thin rim where the gas runs out
    float churn = gNoise(vec3(q.x - drift.x * 2.0, q.y * 1.4 - t * 0.12, q.z - drift.y * 2.0) * 0.9);
    float d = edge * (0.45 + 0.55 * min(lvl, 1.0)) * (1.0 - smoothstep(0.45, 1.0, hf)) * (0.45 + 1.1 * churn);
    return d > 0.12 ? d * (1.2 + 0.4 * min(lvl, 3.0)) : 0.0;                         // clumps of filled voxels and clear gaps between them
}

void main() {
    int i = vIdx;
    vec3 lo = gLo[i].xyz, hi = gHi[i].xyz;
    vec3 ro = camPos.xyz, rd = normalize(vWorld - ro);
    vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
    vec3 ta = (lo - ro) * inv, tb = (hi - ro) * inv;
    vec3 tmin = min(ta, tb), tmax = max(ta, tb);
    float t0 = max(max(max(tmin.x, tmin.y), tmin.z), 0.0), t1 = min(min(tmax.x, tmax.y), tmax.z);
    if (t1 <= t0) discard;
    float dist = length(0.5 * (lo + hi) - ro);
    float want = dist * gStyle.z;
    float v = gStyle.z <= 0.0 ? 0.25 : (want <= 0.25 ? 0.25 : (want <= 0.5 ? 0.5 : 1.0));
    const int MAX_STEPS = 128;
    if ((t1 - t0) / v > 0.94 * float(MAX_STEPS) && v < 1.0) v *= 2.0;
    vec3 p = ro + rd * (t0 + 1e-4);
    ivec3 cell = ivec3(floor(p / v));
    ivec3 stp = ivec3(sign(rd));
    vec3 tMax = ((vec3(cell) + step(vec3(0.0), rd)) * v - ro) * inv;
    vec3 tDel = abs(v * inv);
    float tEnter = t0, time = gStyle.y;
    float T = 1.0;
    vec3 acc = vec3(0.0);
    vec3 Pfirst = vec3(0.0);
    bool any_ = false;
    float night = todP.x;
    for (int k = 0; k < MAX_STEPS; ++k) {
        int ax = tMax.x < tMax.y ? (tMax.x < tMax.z ? 0 : 2) : (tMax.y < tMax.z ? 1 : 2);
        float tExit = min(tMax[ax], t1);
        vec3 q = (vec3(cell) + 0.5) * v;
        float ground = simTop(q.xz);
        if (q.y < ground) break;                              // ground / wall / car / corpse pile: the fog ends there
        float hf;
        // the fog layer stands on the street (box's lowest ground, gLo.w) and corpse piles; cars / walls poke out of it
        float d = gasDensity(q, min(ground, gLo[i].w + 0.7), time, hf);
        if (d > 0.0) {
            float seg = max(tExit - tEnter, 0.0);
            float a = 1.0 - exp(-d * seg * 2.4 * gStyle.x);
            float jit = gH01(cell * 7 + ivec3(3, 11, 5));
            d *= 0.6 + 0.8 * gH01(cell * 3 + ivec3(17, 5, 29));   // per-voxel density: the cubes read individually
            vec3 alb = mix(vec3(0.26, 0.38, 0.05), vec3(0.60, 0.68, 0.16), clamp(0.25 + 0.6 * hf + 0.3 * (jit - 0.5), 0.0, 1.0));
            vec3 lit = shade(alb * 1.5, vec3(0.0, 1.0, 0.0), q, 1.0) * (0.5 + 0.5 * hf);   // deep / low inside: darker
            lit += alb * (0.04 + 0.07 * night) * (0.5 + 0.5 * hf) * (0.7 + 0.6 * jit);   // faint sickly glow: reads at night, not a lamp
            if (!any_) { Pfirst = q; any_ = true; }
            acc += T * a * lit;
            T *= 1.0 - a;
            if (T < 0.03) break;
        }
        if (tMax[ax] > t1) break;
        tEnter = tMax[ax];
        cell[ax] += stp[ax];
        tMax[ax] += tDel[ax];
    }
    float alpha = 1.0 - T;
    if (alpha < 0.004) discard;
    vec3 col = acc / alpha;
    outColor = vec4(finish(col, Pfirst), min(alpha, gStyle.w));
}
