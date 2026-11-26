#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 3
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in vec2 vKindSeed;
layout(location = 3) in vec3 vLocal;
layout(location = 0) out vec4 outColor;
layout(std430, set = 2, binding = 1) readonly buffer Decals  { uint decals[]; };
layout(std430, set = 2, binding = 2) readonly buffer ShadowH { float shadowH[]; };
#include "shadow.glsl"
// Blood splatter on walls: the gore simulation records the highest splat per cell in front of a wall;
// the face shows a ragged band up to that height with drips running down.
float wallBlood(vec3 P, vec3 N, float u) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    ivec2 c = ivec2(floor((P.xz + N.xz * 0.13 - gridP.xy) * gridP.w * 3.0));
    if (c.x < 0 || c.y < 0 || c.x >= d.x || c.y >= d.y) return 0.0;
    float h = float(decals[uint(d.x * d.y) + uint(c.y) * uint(d.x) + uint(c.x)]) * 0.001;
    if (h <= 0.0) return 0.0;
    float col = floor(u * 12.0);
    float r = hash12(vec2(col, float(c.x * 7 + c.y * 13)));
    float top = h + 0.2 * (r - 0.4);
    if (P.y > top) return 0.0;
    float band = smoothstep(0.9 + r * 0.6, 0.0, top - P.y);          // splat band, fading downwards
    float drip = step(0.62, r) * step(top - P.y, 0.4 + 2.5 * fract(r * 17.3));
    float speck = step(0.55, hash12(floor(vec2(u, P.y) * 14.0))) * smoothstep(0.6, 0.0, top - P.y);
    return clamp(max(max(band * step(0.35, hash12(floor(vec2(u, P.y) * 9.0))), drip), speck), 0.0, 1.0);
}

// Procedural placeholder facades (stage 4 replaces these with voxel architecture).
void main() {
    int kind = int(vKindSeed.x + 0.5);
    float seed = vKindSeed.y;
    vec3 N = normalize(vNormal);
    vec3 albedo = vec3(0.3);
    vec3 emissive = vec3(0.0);
    float ao = 1.0;
    // facade coordinates: u along the face, v = height
    float u = abs(N.x) > 0.5 ? vLocal.z : vLocal.x;
    float v = vLocal.y;
    bool side = abs(N.y) < 0.5;
    if (kind == 0) {                         // building: brick + windows
        vec3 brickA = mix(vec3(0.36, 0.13, 0.10), vec3(0.26, 0.15, 0.20), fract(seed * 7.13));
        vec2 brick = vec2(u * 4.0 + floor(v * 8.0) * 0.5, v * 8.0);
        float mortar = step(0.9, fract(brick.x)) + step(0.86, fract(brick.y));
        albedo = brickA * (0.85 + 0.3 * hash12(floor(brick) + seed)) * (1.0 - 0.35 * clamp(mortar, 0.0, 1.0));
        if (side) {
            float floorH = 3.2;
            float fl = floor(v / floorH);
            vec2 cellW = vec2(2.6, floorH);
            vec2 f = vec2(fract(u / cellW.x), fract(v / cellW.y));
            vec2 id = vec2(floor(u / cellW.x), fl);
            bool groundFloor = fl < 1.0;
            vec2 wMin = groundFloor ? vec2(0.08, 0.06) : vec2(0.25, 0.28);
            vec2 wMax = groundFloor ? vec2(0.92, 0.72) : vec2(0.75, 0.80);
            bool win = all(greaterThan(f, wMin)) && all(lessThan(f, wMax));
            if (win) {
                float h = hash12(id + seed * 3.1);
                albedo = vec3(0.04, 0.05, 0.08);
                if (h > (groundFloor ? 0.55 : 0.78)) emissive = mix(vec3(1.0, 0.62, 0.28), vec3(0.9, 0.85, 0.6), fract(h * 17.0)) * (groundFloor ? 1.2 : 0.8);
                else if (h > 0.70) emissive = vec3(0.12, 0.18, 0.35) * 0.6;   // TV glow
            }
            if (fract(v / floorH) < 0.06) albedo *= 0.6;    // floor ledges
        } else {
            albedo = vec3(0.10, 0.10, 0.14) * (0.8 + 0.4 * hash12(floor(vWorld.xz * 0.5)));
        }
        ao = clamp(0.45 + v * 0.12, 0.45, 1.0);
    } else if (kind == 1) {                  // defensive wall: concrete + hazard stripe
        albedo = vec3(0.30, 0.30, 0.32) * (0.85 + 0.2 * hash12(floor(vec2(u, v) * 3.0)));
        if (v > 2.9 && side) albedo = fract((u + v) * 1.2) < 0.5 ? vec3(0.75, 0.6, 0.1) : vec3(0.05);
        ao = clamp(0.5 + v * 0.2, 0.5, 1.0);
    } else if (kind == 2) {                  // barricade
        albedo = fract(u * 0.8) < 0.5 ? vec3(0.6, 0.08, 0.06) : vec3(0.75);
        ao = 0.8;
    } else if (kind == 3) {                  // abandoned car
        vec3 paints[4] = vec3[4](vec3(0.8, 0.6, 0.05), vec3(0.45, 0.06, 0.06), vec3(0.08, 0.15, 0.35), vec3(0.6, 0.6, 0.62));
        albedo = paints[int(fract(seed * 3.7) * 4.0) & 3];
        if (v > 0.8 && side) albedo = vec3(0.05, 0.06, 0.09);   // windows
        if (v < 0.35) albedo = vec3(0.03);                        // tyres / shadow band
        ao = 0.75;
    } else {                                 // lamp post
        albedo = vec3(0.08);
        if (v > 5.1) emissive = vec3(1.0, 0.7, 0.4) * 3.0;
    }
    if (side && kind != 4) {
        float b = wallBlood(vWorld, N, u);
        if (b > 0.0) { albedo = mix(albedo, vec3(0.28, 0.01, 0.015), b * 0.95); emissive *= 1.0 - b; }
    }
    albedo = pow(albedo, vec3(2.2)) * 2.0;
    vec3 col = shadeV(albedo, N, vWorld, ao, moonVisibility(vWorld, N)) + emissive;
    outColor = finishA(col, vWorld);
}
