#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "frame.glsl"
struct BoxInst { vec4 mn; vec4 mx; };   // mn.w = kind, mx.w = seed
layout(location = 0) in vec3 inPos;     // unit cube 0..1
layout(location = 1) in vec3 inNormal;
layout(std430, set = 0, binding = 0) readonly buffer Boxes { BoxInst boxes[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out vec2 vKindSeed;
layout(location = 3) out vec3 vLocal;   // metres from the box min corner
void main() {
    BoxInst b = boxes[gl_InstanceIndex];
    vec3 size = b.mx.xyz - b.mn.xyz;
    vWorld = b.mn.xyz + inPos * size;
    vNormal = inNormal;
    vKindSeed = vec2(b.mn.w, b.mx.w);
    vLocal = inPos * size;
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
