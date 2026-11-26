#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in vec4 vColor;
layout(location = 3) flat in vec3 vGlow;
layout(location = 4) flat in float vFade;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
layout(location = 0) out vec4 outColor;
void main() {
    // thinning smoke / dust: 4x4 ordered dither in 2x2-pixel blocks (reads as pixelated stipple, not soft alpha)
    if (vFade < 0.999) { ivec2 q = ivec2(gl_FragCoord.xy) / 2 & 3; if ((BAYER[q.y * 4 + q.x] + 0.5) / 16.0 > vFade) discard; }
    if (vColor.a > 0.5) { outColor = finishA(vColor.rgb, vWorld); return; }
    vec3 N = normalize(vNormal);
    vec3 col = shade(vColor.rgb * 2.0, N, vWorld, 1.0) + vGlow * (0.6 + 0.4 * max(-N.y, 0.0));
    vec3 V = normalize(camPos.xyz - vWorld);
    col += vec3(0.25, 0.2, 0.22) * pow(max(dot(reflect(-sunDir.xyz, N), V), 0.0), 24.0) * step(vColor.r, 0.4) * step(vColor.g * 10.0, vColor.r);   // wet blood glint
    outColor = finishA(col, vWorld);
}
