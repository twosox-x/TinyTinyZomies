#version 450
// Instanced voxel foliage: palette colour with a per-instance tint, darker towards the ground (self-shadowed
// crop rows), night lighting and fog like the city tiles.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 1
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in uint vMat;
layout(location = 3) flat in float vTint;
layout(location = 0) out vec4 outColor;
struct Mat { vec4 albedo; vec4 emis; uvec4 info; };
layout(std430, set = 2, binding = 0) readonly buffer Mats { Mat mats[]; };
void main() {
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 albedo = mats[vMat].albedo.rgb * (0.82 + 0.36 * vTint);
    float ao = mix(0.55, 1.0, clamp((vWorld.y + 0.1) / 1.2, 0.0, 1.0));
    vec3 col = shade(albedo * 2.0, N, vWorld, ao);
    outColor = finishA(col, vWorld);
}
