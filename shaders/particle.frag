#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in vec4 vColor;
layout(location = 0) out vec4 outColor;
void main() {
    if (vColor.a > 0.5) { outColor = vec4(finish(vColor.rgb, vWorld), 1.0); return; }
    vec3 N = normalize(vNormal);
    vec3 col = shade(vColor.rgb * 2.0, N, vWorld, 1.0);
    vec3 V = normalize(camPos.xyz - vWorld);
    col += vec3(0.25, 0.2, 0.22) * pow(max(dot(reflect(-sunDir.xyz, N), V), 0.0), 24.0) * step(vColor.r, 0.4) * step(vColor.g * 10.0, vColor.r);   // wet blood glint
    outColor = vec4(finish(col, vWorld), 1.0);
}
