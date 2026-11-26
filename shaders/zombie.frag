#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#include "lighting.glsl"
layout(set = 2, binding = 0) uniform sampler2D palette;
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) in vec2 vUv;
layout(location = 3) in float vAo;
layout(location = 0) out vec4 outColor;
void main() {
    vec3 albedo = texture(palette, vUv).rgb;
    albedo = pow(albedo, vec3(2.2));
    vec3 N = normalize(vNormal);
    vec3 col = shade(albedo, N, vWorld, vAo);
    // cool rim light so silhouettes read against the dark street
    vec3 V = normalize(camPos.xyz - vWorld);
    col += vec3(0.10, 0.12, 0.22) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * vAo;
    outColor = finishA(col, vWorld);
}
