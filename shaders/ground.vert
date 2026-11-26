#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "frame.glsl"
layout(location = 0) out vec3 vWorld;
void main() {
    // two triangles covering the simulation area (+ margin), no vertex buffer
    const vec2 corners[6] = vec2[6](vec2(0, 0), vec2(1, 1), vec2(1, 0), vec2(0, 0), vec2(0, 1), vec2(1, 1));
    vec2 c = corners[gl_VertexIndex];
    vec2 size = vec2(gridDim.xy) * gridP.z;
    vec2 xz = gridP.xy - 40.0 + c * (size + 80.0);
    vWorld = vec3(xz.x, (gridDim.w & GRID_CITY) != 0u ? 0.03 : 0.0, xz.y);   // city: overlay just above the baked road
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
