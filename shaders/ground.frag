#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 8
#include "lighting.glsl"
layout(std430, set = 2, binding = 1) readonly buffer StaticH { float staticH[]; };
layout(std430, set = 2, binding = 2) readonly buffer CorpseH { int corpseH[]; };
layout(std430, set = 2, binding = 3) readonly buffer Density { vec4 density[]; };
layout(std430, set = 2, binding = 4) readonly buffer NavDir  { vec2 navDir[]; };
layout(std430, set = 2, binding = 5) readonly buffer NavDist { float navDist[]; };
layout(std430, set = 2, binding = 6) readonly buffer Decals  { uint decals[]; };   // blood, wall blood, scorch (gore.glsl)
layout(std430, set = 2, binding = 7) readonly buffer ShadowH { float shadowH[]; };
#include "shadow.glsl"
// decal value with bilinear filtering (organic splat edges instead of 25 cm squares)
float decalAt(ivec2 c, uint layer) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    if (c.x < 0 || c.y < 0 || c.x >= d.x || c.y >= d.y) return 0.0;
    return float(decals[layer * uint(d.x * d.y) + uint(c.y) * uint(d.x) + uint(c.x)]);
}
float decalBilinear(vec2 xz, uint layer) {
    vec2 g = (xz - gridP.xy) * gridP.w * 3.0 - 0.5;
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    return mix(mix(decalAt(c0, layer), decalAt(c0 + ivec2(1, 0), layer), f.x), mix(decalAt(c0 + ivec2(0, 1), layer), decalAt(c0 + ivec2(1, 1), layer), f.x), f.y);
}
layout(location = 0) in vec3 vWorld;
layout(location = 0) out vec4 outColor;

bool inGrid(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < int(gridDim.x) && c.y < int(gridDim.y); }
uint cid(ivec2 c) { return uint(c.y) * gridDim.x + uint(c.x); }

vec3 heat(float t) { t = clamp(t, 0.0, 1.0); return clamp(vec3(1.5 * t, 1.5 * t - 0.5, 0.5 - t) * 1.5, 0.0, 1.0) + vec3(0.0, 0.0, 0.25 * (1.0 - t)); }

void main() {
    vec2 xz = vWorld.xz;
    vec2 g = (xz - gridP.xy) * gridP.w;
    ivec2 c = ivec2(floor(g));
    bool inside = inGrid(c);
    // asphalt with subtle wet patches
    float n = hash12(floor(xz * 2.0)) * 0.5 + hash12(floor(xz * 0.35)) * 0.5;
    vec3 albedo = vec3(0.075, 0.072, 0.09) * (0.8 + 0.4 * n);
    float wet = smoothstep(0.55, 0.75, hash12(floor(xz * 0.15)) * 0.6 + n * 0.4);
    // sidewalks next to buildings
    float nearSolid = 0.0;
    if (inside && (gridDim.w & GRID_CITY) == 0u) {
        for (int dy = -2; dy <= 2; ++dy)
        for (int dx = -2; dx <= 2; ++dx) {
            ivec2 cc = c + ivec2(dx, dy);
            if (inGrid(cc) && staticH[cid(cc)] > 6.0) nearSolid = 1.0;
        }
    }
    if (nearSolid > 0.5) {
        vec2 tile = fract(xz * 0.8);
        albedo = vec3(0.16, 0.15, 0.17) * (0.85 + 0.2 * n) * (min(tile.x, tile.y) < 0.04 ? 0.6 : 1.0);
        wet *= 0.4;
    } else {
        // lane markings along the avenue / cross street
        if (abs(xz.y) < 0.09 && fract(xz.x * 0.125) < 0.55 && abs(xz.x) > 8.0) albedo = vec3(0.55, 0.42, 0.08);
        if (abs(xz.x) < 0.09 && fract(xz.y * 0.125) < 0.55 && abs(xz.y) > 8.0) albedo = vec3(0.55, 0.42, 0.08);
        // crosswalks around the intersection
        if ((abs(xz.x) > 7.5 && abs(xz.x) < 10.0 && abs(xz.y) < 6.5 && fract(xz.y * 1.1) < 0.5) ||
            (abs(xz.y) > 7.5 && abs(xz.y) < 10.0 && abs(xz.x) < 6.5 && fract(xz.x * 1.1) < 0.5))
            albedo = vec3(0.35, 0.35, 0.36);
    }
    float ao = 1.0;
    vec3 overlay = vec3(0.0);
    float overlayA = 0.0;
    if (inside) {
        uint id = cid(c);
        vec4 d = density[id];
        ao = 1.0 / (1.0 + d.x * 0.35);                  // crowd contact shadow
        float corpse = float(corpseH[id]) * 0.001;
        if (corpse > 0.0) {
            albedo = mix(albedo, vec3(0.16, 0.015, 0.02), clamp(corpse * 4.0, 0.0, 0.85));   // blood
            wet = max(wet, clamp(corpse * 3.0, 0.0, 1.0));
        }
        uint dbg = gridDim.w;
        if ((dbg & DBG_DENSITY) != 0u) { overlay = heat(d.x / 4.0); overlayA = d.x > 0.05 ? 0.75 : 0.2; }
        if ((dbg & DBG_FLOW) != 0u) {
            vec2 dir = navDir[id];
            if (dot(dir, dir) > 1e-4) {
                float ang = atan(dir.y, dir.x);
                vec3 hue = 0.5 + 0.5 * cos(ang + vec3(0.0, 2.094, 4.188));
                // arrow stripes moving along the flow
                vec2 f = fract(g) - 0.5;
                float along = dot(f, dir);
                float across = abs(f.x * dir.y - f.y * dir.x);
                float arrow = step(across, 0.07 + (0.35 - along) * 0.25) * step(-0.35, along) * step(along, 0.35);
                overlay = mix(overlay, hue * (0.4 + 0.6 * arrow), 0.85);
                overlayA = max(overlayA, 0.7);
            }
        }
        if ((dbg & DBG_NAVDIST) != 0u) {
            float dd = navDist[id];
            if (dd < 1e6) { float iso = smoothstep(0.92, 1.0, fract(dd / 5.0)); overlay = mix(overlay, vec3(0.2, 0.9, 1.0), iso); overlayA = max(overlayA, iso * 0.9); }
        }
        if ((dbg & DBG_CORPSEH) != 0u && corpse > 0.0) { overlay = mix(overlay, heat(corpse / 1.5), 0.9); overlayA = max(overlayA, 0.8); }
        if ((dbg & DBG_GRID) != 0u) {
            vec2 f = fract(g);
            float line = step(min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y)), 0.04);
            overlay = mix(overlay, vec3(0.45, 0.5, 0.6), line);
            overlayA = max(overlayA, line * 0.6);
        }
    } else {
        albedo *= 0.5;
    }
    // goals
    for (int i = 0; i < 4; ++i) {
        if (goalsF[i].w < 0.5) continue;
        float r = length(xz - goalsF[i].xz);
        float ring = smoothstep(0.25, 0.0, abs(r - 4.0)) * (0.6 + 0.4 * sin(camPos.w * 4.0));
        overlay = mix(overlay, vec3(0.2, 1.0, 0.4), ring); overlayA = max(overlayA, ring);
    }
    // persistent scorch marks and blood (written by the gore simulation)
    float scorch = decalBilinear(xz, 2u) / 255.0;
    float sn = hash12(floor(xz * 6.0));
    albedo *= 1.0 - 0.85 * smoothstep(0.15, 0.6, scorch + (sn - 0.5) * 0.3);
    float bloodAmt = decalBilinear(xz, 0u);
    float bn = hash12(floor(xz * 8.0)) * 0.5 + hash12(floor(xz * 3.0)) * 0.5;
    float bloodCov = smoothstep(0.45, 0.6, bloodAmt / 160.0 + (bn - 0.5) * 0.55);
    if (bloodCov > 0.0) {
        vec3 bc = mix(vec3(0.30, 0.012, 0.02), vec3(0.15, 0.005, 0.01), smoothstep(200.0, 900.0, bloodAmt));
        albedo = mix(albedo, bc, bloodCov * 0.92);
        wet = max(wet, bloodCov);
    }
    // explosion ground flash (the expanding shock ring was removed: owner feedback)
    vec3 emissive = vec3(0.0);
    // (baked city: drawn additively by city.frag instead; this opaque ground plane would paint dark rings over the street)
    for (int i = 0; i < MAX_BLASTS && (gridDim.w & GRID_CITY) == 0u; ++i) {
        if (blasts[i].w < 0.0) continue;
        float r = length(xz - blasts[i].xz);
        float age = blasts[i].w;
        if (age < 0.8) {
            emissive += vec3(1.0, 0.7, 0.3) * smoothstep(3.0, 0.0, r) * (1.0 - age / 0.8) * 4.0;
        }
    }
    albedo = pow(albedo, vec3(2.2)) * 2.0;
    vec3 N = vec3(0.0, 1.0, 0.0);
    vec3 col = shadeV(albedo, N, vWorld, ao, moonVisibility(vWorld, N));
    // fake wet reflections of the street lights
    vec3 V = normalize(camPos.xyz - vWorld);
    for (uint i = 0u; i < gridDim.z; ++i) {
        vec3 L = lightPos[i].xyz - vWorld;
        vec3 H = normalize(normalize(L) + V);
        float spec = pow(max(H.y, 0.0), 180.0) * wet;
        col += lightCol[i].rgb * lightCol[i].w * spec * 0.8 * clamp(1.0 - length(L) / (lightPos[i].w * 2.5), 0.0, 1.0);
    }
    if ((gridDim.w & GRID_CITY) != 0u) {   // baked city: only overlays and blast light; the city shader draws the street
        if (overlayA < 0.02 && dot(emissive, emissive) < 1e-4) discard;
        outColor = finishA(overlay * overlayA + emissive, vWorld);
        return;
    }
    col = mix(col, overlay, overlayA);
    outColor = finishA(col + emissive, vWorld);
}
