#version 450
// Baked city shading: palette material per vertex, night lighting (moon + shadows + street lamps), glass and
// water Fresnel sky reflection, emissive modes (FORMAT.md section 6), blood / scorch decals from the gore
// simulation on ground, roofs and walls inside the simulation window.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in uint vMat;
layout(location = 3) flat in vec4 vPaint;
layout(location = 4) flat in float vPhase;
layout(location = 0) out vec4 outColor;
struct Mat { vec4 albedo; vec4 emis; uvec4 info; };   // albedo: linear rgb, w gloss; emis: x night, y mode, z roughness
layout(std430, set = 2, binding = 0) readonly buffer Mats    { Mat mats[]; };
layout(std430, set = 2, binding = 1) readonly buffer Decals  { uint decals[]; };
layout(std430, set = 2, binding = 2) readonly buffer ShadowH { float shadowH[]; };
layout(std430, set = 2, binding = 3) readonly buffer CorpseH { int corpseH[]; };
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
    float band = smoothstep(0.9 + r * 0.6, 0.0, top - P.y);
    float drip = step(0.62, r) * step(top - P.y, 0.4 + 2.5 * fract(r * 17.3));
    return clamp(max(band * step(0.35, hash12(floor(vec2(u, P.y) * 9.0))), drip), 0.0, 1.0);
}
float sq(float t, float hz) { return step(0.5, fract(t * hz)); }

void main() {
    Mat m = mats[vMat];
    vec3 N = normalize(vNormal);
    vec3 albedo = m.albedo.rgb;
    if (vPaint.w > 0.5) albedo = vPaint.rgb;
    uint flags = m.info.x;
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
            albedo = mix(albedo, vec3(0.075, 0.001, 0.002), b * 0.95);
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
    // emission (the engine runs at night: uNight = 1)
    if ((flags & M_EMISSIVE) != 0u) {
        float s = m.emis.x;
        int mode = int(m.emis.y + 0.5);
        float e = s;
        if (mode == 2) e = 1.3;                                                  // lit windows
        else if (mode == 3) e = s * (0.6 + 0.4 * sq(t, 0.5));                    // aircraft beacon
        else if (mode == 4) e = s * (0.25 + 0.75 * sq(t + (vMat == 190u ? 0.3125 : 0.0), 1.6));   // light bars
        else if (mode == 5) {                                                    // traffic / pedestrian signals, 30 s cycle
            float c = mod(t + vPhase * 15.0, 30.0);
            bool green = c < 12.0, amber = c >= 12.0 && c < 15.0;
            bool lit = vMat == 60u ? !(green || amber) : vMat == 61u ? amber : vMat == 62u ? green : vMat == 69u ? green : !green;
            e = lit ? 3.2 : 0.3;
        }
        col += m.albedo.rgb * e;
    }
    outColor = vec4(finish(col, vWorld), 1.0);
}
