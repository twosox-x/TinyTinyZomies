#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel fx volumes rendered at reduced resolution (fx_volume_half*.frag) composited into the full-resolution MSAA scene
// pass: each pixel re-intersects its camera ray with the voxel cubes hit by the 3x3 nearest low-res texels (the voxel
// centre / size are stored per texel) and takes the nearest hit, so voxel silhouettes and depth stay exact at full
// resolution (no blocky upsample, correct intersections with the city); the colour is that texel's shaded face. The
// hardware depth test (LESS against the scene) handles occlusion; no hit = discard.
#define FRAME_SET 3
#include "frame.glsl"
layout(set = 2, binding = 0) uniform sampler2D fxCol;   // display colour + CoC code (finishA)
layout(set = 2, binding = 1) uniform sampler2D fxVox;   // xyz voxel centre, w size + 8 x entry axis (0 = empty)
layout(std140, set = 3, binding = 1) uniform FxComposite {
    mat4 invViewProj;
    vec4 cp;   // xy full-res target size, zw low-res / full-res scale
};
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
    vec2 ndc = vec2(gl_FragCoord.x / cp.x * 2.0 - 1.0, 1.0 - gl_FragCoord.y / cp.y * 2.0);
    vec4 wp = invViewProj * vec4(ndc, 0.5, 1.0);
    vec3 ro = camPos.xyz, rd = normalize(wp.xyz / wp.w - ro);
    vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
    ivec2 sz = textureSize(fxVox, 0);
    ivec2 c0 = ivec2(gl_FragCoord.xy * cp.zw);
    float best = 1e30;
    ivec2 pick = ivec2(-1);
    for (int y = -1; y <= 1; ++y)
        for (int x = -1; x <= 1; ++x) {
            ivec2 q = clamp(c0 + ivec2(x, y), ivec2(0), sz - 1);
            vec4 vx = texelFetch(fxVox, q, 0);
            if (vx.w <= 0.0) continue;
            float ax = floor(vx.w / 8.0), v = vx.w - 8.0 * ax;
            vec3 ta = (vx.xyz - 0.5 * v - ro) * inv, tb = (vx.xyz + 0.5 * v - ro) * inv;
            vec3 mn = min(ta, tb), mx = max(ta, tb);
            float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z);
            if (t1 < max(t0, 0.0)) continue;
            int hitAx = mn.x >= mn.y && mn.x >= mn.z ? 0 : (mn.y >= mn.z ? 1 : 2);
            float score = max(t0, 0.0) + (float(hitAx) == ax ? 0.0 : 1e-3);   // same cube: prefer the texel shading this face
            if (score < best) { best = score; pick = q; }
        }
    if (pick.x < 0) discard;
    vec3 P = ro + rd * best;
    vec4 clip = viewProj * vec4(P, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w, 0.0, 1.0);
    outColor = texelFetch(fxCol, pick, 0);
}
