#version 450
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "common.glsl"
#include "frame.glsl"
#include "zombie_anim.glsl"
layout(location = 0) in vec3 inPos;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in vec2 inUv;
layout(location = 3) in vec3 inPivot;
layout(location = 4) in float inPart;
layout(std430, set = 0, binding = 0) readonly buffer Corpses { Corpse corpses[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) out vec2 vUv;
layout(location = 3) out float vAo;
void main() {
    Corpse c = corpses[gl_InstanceIndex];
    vec3 n = inNormal;
    if ((c.info.z & 1u) == 0u) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vWorld = vec3(0); vNormal = n; vUv = inUv; vAo = 0.0; return; }
    float vary = hash01(c.info.y ^ (c.info.x >> 8) * 2654435761u);
    Pose s;
    s.phase = vary * 20.0;
    s.speed = 0.0;
    s.prone = 1.0;
    s.climb = 0.0;
    s.flail = 0.0;
    s.roll = vary > 0.5 ? 3.14159 : 0.0;     // face down or face up
    s.roll += (fract(vary * 13.7) - 0.5) * 0.5;
    s.vary = vary;
    s.dead = 1.0;
    vec3 q = animateVertex(inPos, inPivot, int(inPart + 0.5), s, n);
    if (s.roll > 1.5) q.y += 0.26;           // face-up bodies rest on their back
    mat3 Y = rotY(c.pos.w);
    vWorld = c.pos.xyz + Y * q;
    vNormal = Y * n;
    vUv = inUv + vec2(0.0, float(((c.info.x >> 8) & 0xFFu) % uint(modelP.x)) / modelP.x);
    vAo = 0.55;
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
