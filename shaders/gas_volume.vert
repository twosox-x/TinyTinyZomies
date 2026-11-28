#version 450
#extension GL_GOOGLE_include_directive : require
// Corpse gas voxel fog: the near faces of each active gas box (include/gas_volume.glsl); the fragment shader walks the
// world voxel grid through it (gas_volume.frag). The RTS camera is always above the low fog (boxes <= ~4 m tall): a box
// containing the camera is skipped (no far-face pass).
#define FRAME_SET 1
#define GAS_SET 1
#include "frame.glsl"
#include "gas_volume.glsl"
layout(location = 0) out vec3 vWorld;
layout(location = 1) flat out int vIdx;
const ivec3 CORNER[24] = ivec3[24](ivec3(1, 0, 0), ivec3(1, 1, 0), ivec3(1, 1, 1), ivec3(1, 0, 1),
                                   ivec3(0, 0, 1), ivec3(0, 1, 1), ivec3(0, 1, 0), ivec3(0, 0, 0),
                                   ivec3(0, 1, 0), ivec3(0, 1, 1), ivec3(1, 1, 1), ivec3(1, 1, 0),
                                   ivec3(0, 0, 1), ivec3(0, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 1),
                                   ivec3(1, 0, 1), ivec3(1, 1, 1), ivec3(0, 1, 1), ivec3(0, 0, 1),
                                   ivec3(0, 0, 0), ivec3(0, 1, 0), ivec3(1, 1, 0), ivec3(1, 0, 0));
const int QUAD[6] = int[6](0, 1, 2, 0, 2, 3);   // outward faces, counter-clockwise (back-face culling keeps the near ones)
void main() {
    int i = gl_InstanceIndex;
    vec3 lo = gLo[i].xyz, hi = gHi[i].xyz;
    vIdx = i;
    bool inside = all(greaterThan(camPos.xyz, lo - 0.3)) && all(lessThan(camPos.xyz, hi + 0.3));
    if (inside || any(lessThanEqual(hi - lo, vec3(1e-3)))) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vWorld = vec3(0.0); return; }
    vec3 c = vec3(CORNER[(gl_VertexIndex / 6) * 4 + QUAD[gl_VertexIndex % 6]]);
    vWorld = mix(lo, hi, c);
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
