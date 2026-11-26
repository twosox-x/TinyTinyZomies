#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel explosion / fire volumes: the bounding box of each volume, drawn inside-out (its far faces) so the fragment
// shader also runs when the camera is inside; see include/fx_volume.glsl.
#define FRAME_SET 1
#define FX_SET 1
#include "frame.glsl"
#include "fx_volume.glsl"
layout(location = 0) out vec3 vWorld;
layout(location = 1) flat out int vIdx;
const ivec3 CORNER[24] = ivec3[24](ivec3(1, 0, 0), ivec3(1, 1, 0), ivec3(1, 1, 1), ivec3(1, 0, 1),
                                   ivec3(0, 0, 1), ivec3(0, 1, 1), ivec3(0, 1, 0), ivec3(0, 0, 0),
                                   ivec3(0, 1, 0), ivec3(0, 1, 1), ivec3(1, 1, 1), ivec3(1, 1, 0),
                                   ivec3(0, 0, 1), ivec3(0, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 1),
                                   ivec3(1, 0, 1), ivec3(1, 1, 1), ivec3(0, 1, 1), ivec3(0, 0, 1),
                                   ivec3(0, 0, 0), ivec3(0, 1, 0), ivec3(1, 1, 0), ivec3(1, 0, 0));
const int QUAD[6] = int[6](0, 2, 1, 0, 3, 2);   // reversed winding: the inside faces are front-facing
void main() {
    int i = gl_InstanceIndex;
    vec3 lo, hi;
    fxBox(i, lo, hi);
    vec3 c = vec3(CORNER[(gl_VertexIndex / 6) * 4 + QUAD[gl_VertexIndex % 6]]);
    vWorld = mix(lo, hi, c);
    vIdx = i;
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
