#version 450
// Instanced voxel foliage of the baked city (FOLI + foliage.bin): crops, grass tufts, reeds, rocks, hay bales.
// Instance record (2 u32): x | z << 16 (1/512 m from the tile corner), y mm (i16) | yaw << 16 (2 pi / 256) |
// scale << 24 (1/100). Density thins out with distance (per-instance hash), wind sway grows with height.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "frame.glsl"
layout(location = 0) in ivec4 inPos;
layout(location = 1) in ivec4 inNrm;
layout(std140, set = 1, binding = 1) uniform FoliageDraw {
    vec4 tile;       // x0, z0, lod
    vec4 origin;     // model quantisation origin
    vec4 qscale;     // x xz, y y
    vec4 params;     // x sway, y model height, z fade start, w fade end (m)
    uvec4 first;     // x first instance
};
layout(std430, set = 0, binding = 0) readonly buffer Insts { uint inst[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out uint vMat;
layout(location = 3) flat out float vTint;
float h11(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return float(x & 0xffffffu) / 16777216.0; }
void main() {
    uint id = first.x + uint(gl_InstanceIndex);
    uint a = inst[id * 2u], b = inst[id * 2u + 1u];
    vec3 base = vec3(tile.x + float(a & 0xffffu) / 512.0, float(int(b << 16) >> 16) * 0.001, tile.y + float(a >> 16) / 512.0);
    float yaw = float((b >> 16) & 255u) * (6.2831853 / 256.0), sc = float(b >> 24) * 0.01;
    float h = h11(a ^ (b * 0x9e3779b9u));
    float d = length(camPos.xyz - base);
    float dens = 1.0 - smoothstep(params.z, params.w, d);
    // fade by shrinking the thinned-out instances (no popping), tallest first stays
    float keep = clamp((dens - h) * 6.0, 0.0, 1.0);
    vec3 p = (origin.xyz + vec3(inPos.xyz) * qscale.xyx) * sc * vec3(1.0, keep, 1.0);
    vec3 n = vec3(inNrm.xyz) * (1.0 / 127.0);
    float c = cos(yaw), s = sin(yaw);
    p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
    n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
    // wind: gusts travelling across the fields
    float k = clamp(p.y / max(params.y * sc, 0.1), 0.0, 1.5);
    float t = camPos.w;
    float gust = sin(dot(base.xz, vec2(0.11, 0.07)) - t * 1.3) * 0.5 + 0.5;
    vec2 w = vec2(sin(t * 2.1 + base.x * 0.7 + base.z * 0.3), cos(t * 1.7 + base.z * 0.6)) * (0.05 + 0.12 * gust);
    p.xz += w * params.x * k * k * params.y * sc;
    vec3 P = base + p;
    if (keep <= 0.0) P = vec3(0.0, -1000.0, 0.0);
    vWorld = P;
    vNormal = n;
    vMat = uint(inNrm.w) & 255u;
    vTint = h;
    gl_Position = viewProj * vec4(P, 1.0);
}
