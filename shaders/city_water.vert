#version 450
// Smooth water surface of the baked city (WATR): 2 m quads at the water level, per vertex the signed shore
// distance (m, > 0 over the water; the banks hide the part under them).
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "frame.glsl"
layout(location = 0) in vec3 inPos;   // x, z, shore distance
layout(std140, set = 1, binding = 1) uniform WaterDraw { vec4 level; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out float vShore;
void main() {
    vec3 p = vec3(inPos.x, level.x, inPos.y);
    vWorld = p;
    vShore = inPos.z;
    gl_Position = viewProj * vec4(p, 1.0);
}
