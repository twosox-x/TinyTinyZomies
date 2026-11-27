#version 450
// Baked city shading: palette material per vertex, night lighting (moon + shadows + street lamps), glass and
// water Fresnel sky reflection, emissive modes (FORMAT.md section 6), blood / scorch decals from the gore
// simulation on ground, roofs and walls inside the simulation window.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 5
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in uint vMat;
layout(location = 3) flat in vec4 vPaint;
layout(location = 4) flat in float vPhase;
layout(location = 5) flat in float vDissolve;
layout(location = 6) in vec3 vCell;
#include "dissolve.glsl"
layout(location = 0) out vec4 outColor;
struct Mat { vec4 albedo; vec4 emis; uvec4 info; };   // albedo: linear rgb, w gloss; emis: x night, y mode, z roughness
layout(std430, set = 2, binding = 1) readonly buffer Mats    { Mat mats[]; };
layout(std430, set = 2, binding = 2) readonly buffer Decals  { uint decals[]; };
layout(std430, set = 2, binding = 3) readonly buffer ShadowH { float shadowH[]; };
layout(std430, set = 2, binding = 4) readonly buffer CorpseH { int corpseH[]; };
#include "shadow.glsl"
#define M_GLASS 1u
#define M_EMISSIVE 2u
#define M_WATER 4u
#define M_FOLIAGE 8u

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
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float wallH(vec2 xz) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    ivec2 c = ivec2(floor((xz - gridP.xy) * gridP.w * 3.0));
    if (c.x < 0 || c.y < 0 || c.x >= d.x || c.y >= d.y) return 0.0;
    return float(decals[uint(d.x * d.y) + uint(c.y) * uint(d.x) + uint(c.x)]) * 0.001;
}
// Wall blood: the gore simulation stores the highest splat (m) in the decal cell just outside the wall it hit, on the
// 0.75 m simulation height grid, so the rendered facade can be up to ~1 m behind or in front of that cell: search
// outwards along the normal (and a little sideways). Shape: noisy splatter blobs below the splat height, sparse
// spatter above it, and drips running down.
float wallBlood(vec3 P, vec3 N, float u) {
    vec2 n = normalize(N.xz + vec2(1e-5)), t = vec2(-n.y, n.x);
    float h = 0.0;
    for (int k = 0; k < 5; ++k) {
        vec2 q = P.xz + n * (-0.12 + 0.25 * float(k));
        h = max(h, max(wallH(q), 0.8 * max(wallH(q + t * 0.3), wallH(q - t * 0.3))));
    }
    if (h <= 0.0) return 0.0;
    float dy = P.y - h;                                    // > 0 above the highest splat
    if (dy > 1.2) return 0.0;
    vec2 q = vec2(u, P.y);
    float nz = vnoise(q * 2.6) * 0.55 + vnoise(q * 7.0 + 13.1) * 0.3 + vnoise(q * 19.0 + 3.7) * 0.15;
    // dense below the splat height, thinning out above it into droplets
    float thresh = mix(0.42, 0.78, smoothstep(-1.6, 0.9, dy));
    float splat = smoothstep(thresh, thresh + 0.04, nz) * step(P.y, h + 1.2) * smoothstep(-3.5, -1.5, dy + 0.0);
    // drips: thin streaks hanging from the splat line, varying length per column
    float col = floor(u * 9.0);
    float r = hash12(vec2(col, floor(h * 3.0) + 17.0));
    float fx = fract(u * 9.0);
    float len = 0.4 + 2.2 * fract(r * 17.3);
    float drip = step(0.55, r) * step(abs(fx - 0.5), 0.12 * (1.0 - clamp((h - P.y) / len, 0.0, 1.0)) + 0.04)
               * step(P.y, h + 0.05) * step(h - P.y, len);
    return clamp(max(splat, drip), 0.0, 1.0);
}
float sq(float t, float hz) { return step(0.5, fract(t * hz)); }

void main() {
    if (voxelDissolved(vCell, vDissolve)) discard;   // lab canopies after landing (docs/MILITARY_ANIMS.md 2.3.3)
    Mat m = mats[vMat];
    vec3 N = normalize(vNormal);
    vec3 albedo = m.albedo.rgb;
    if (vPaint.w > 0.5) albedo = vPaint.rgb;
    uint flags = m.info.x;
    if ((flags & M_EMISSIVE) != 0u && int(m.emis.y + 0.5) == 2 && todP.x < 1.0) {   // lit windows by day: the unlit glass
        Mat dm = mats[m.info.y];
        albedo = mix(dm.albedo.rgb, albedo, todP.x);
        if (todP.x < 0.5) { flags |= dm.info.x & M_GLASS; m.albedo.w = dm.albedo.w; }
    }
    float t = camPos.w;
    if ((flags & M_FOLIAGE) != 0u) albedo *= 0.8 + 0.4 * hash12(floor(vWorld.xz * 0.7) + floor(vWorld.y * 0.7));

    // gore decals inside the simulation window
    vec2 g = (vWorld.xz - gridP.xy) * gridP.w;
    bool inWin = g.x >= 0.0 && g.y >= 0.0 && g.x < float(gridDim.x) && g.y < float(gridDim.y);
    float wet = 0.0;
    if (inWin) {
        if (N.y > 0.7) {
            ivec2 c = ivec2(floor(g));
            float corpse = float(corpseH[uint(c.y) * gridDim.x + uint(c.x)]) * 0.001;
            if (corpse > 0.0 && vWorld.y < 0.6) albedo = mix(albedo, vec3(0.03, 0.001, 0.002), clamp(corpse * 4.0, 0.0, 0.85));
            float scorch = decalBilinear(vWorld.xz, 2u) / 255.0;
            albedo *= 1.0 - 0.85 * smoothstep(0.15, 0.6, scorch + (hash12(floor(vWorld.xz * 6.0)) - 0.5) * 0.3);
            float bloodAmt = decalBilinear(vWorld.xz, 0u);
            float bn = hash12(floor(vWorld.xz * 8.0)) * 0.5 + hash12(floor(vWorld.xz * 3.0)) * 0.5;
            float cov = smoothstep(0.45, 0.6, bloodAmt / 160.0 + (bn - 0.5) * 0.55);
            if (cov > 0.0) {
                vec3 bc = mix(vec3(0.075, 0.001, 0.002), vec3(0.02, 0.0, 0.0005), smoothstep(200.0, 900.0, bloodAmt));
                albedo = mix(albedo, bc, cov * 0.92);
                wet = cov;
            }
        } else if (abs(N.y) < 0.3) {
            float u = dot(vWorld.xz, vec2(-N.z, N.x));
            float b = wallBlood(vWorld, N, u);
            albedo = mix(albedo, vec3(0.085, 0.002, 0.003), b * 0.95);
            wet = b * 0.7;
        }
    }

    vec3 col = shadeV(albedo * 2.0, N, vWorld, 1.0, moonVisibility(vWorld, N));
    vec3 V = normalize(camPos.xyz - vWorld);
    float gloss = m.albedo.w;
    if ((flags & (M_GLASS | M_WATER)) != 0u || wet > 0.0) {
        // Fresnel reflection of the night sky (purple zenith, fog-coloured horizon)
        vec3 R = reflect(-V, N);
        vec3 sky = mix(fogColor.rgb * 1.2, skyColor.rgb * 1.6, clamp(R.y * 1.5, 0.0, 1.0));
        float f = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        float k = (flags & M_WATER) != 0u ? 1.0 : (flags & M_GLASS) != 0u ? max(gloss, 0.5) : wet * 0.6;
        col = mix(col, sky, clamp(f * k, 0.0, 1.0)) + sky * 0.15 * k * ((flags & M_GLASS) != 0u ? 1.0 : 0.0);
    }
    // emission (FORMAT.md section 6, City Lab's uNight = todP.x: 0 day .. 1 night)
    if ((flags & M_EMISSIVE) != 0u) {
        float night = todP.x;
        float steady = mix(m.emis.w, m.emis.x, night);                          // day .. night strength
        int mode = int(m.emis.y + 0.5);
        float e = steady;
        if (mode == 2) e = 1.3 * night;                                          // lit windows (day: unlit glass, below)
        else if (mode == 3) e = steady * (0.6 + 0.4 * sq(t, 0.5));               // aircraft beacon
        else if (mode == 4) e = steady * (0.25 + 0.75 * sq(t + (vMat == 190u ? 0.3125 : 0.0), 1.6));   // light bars
        else if (mode == 5) {                                                    // traffic / pedestrian signals, 30 s cycle
            float c = mod(t + vPhase * 15.0, 30.0);
            bool green = c < 12.0, amber = c >= 12.0 && c < 15.0;
            bool lit = vMat == 60u ? !(green || amber) : vMat == 61u ? amber : vMat == 62u ? green : vMat == 69u ? green : !green;
            e = lit ? 1.4 + 1.8 * night : 0.3;
        }
        col += m.albedo.rgb * e;
    }
    outColor = finishA(col, vWorld);
}
