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
layout(std430, set = 0, binding = 0) readonly buffer Agents { Agent agents[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) out vec2 vUv;
layout(location = 3) out float vAo;
void main() {
    Agent a = agents[gl_InstanceIndex];
    uint st = a.info.x & 0xFFu;
    uint variant = (a.info.x >> 8) & 0xFFu;
    float vary = hash01(a.info.y);
    Pose s;
    s.phase = a.vel.w;
    s.speed = length(a.vel.xz);
    s.prone = clamp(a.pos.w, 0.0, 1.0);
    s.climb = st == ST_CLIMB ? 1.0 : s.prone * 0.6;
    s.flail = (st == ST_FALL || st == ST_DYING) ? 1.0 : 0.0;
    s.roll = st == ST_DYING ? a.dirs.w * (2.0 + 3.0 * vary) * (vary > 0.5 ? 1.0 : -1.0) : 0.0;
    s.vary = vary;
    s.dead = 0.0;
    if (st == ST_DYING || st == ST_FALL) s.phase = camPos.w * 6.0 + vary * 20.0;
    vec3 n = inNormal;
    vec3 q = animateVertex(inPos * (0.9 + 0.2 * vary), inPivot * (0.9 + 0.2 * vary), int(inPart + 0.5), s, n);
    mat3 Y = rotY(a.dirs.z);
    vWorld = a.pos.xyz + Y * q;
    vNormal = Y * n;
    vUv = inUv + vec2(0.0, float(variant % uint(modelP.x)) / modelP.x);
    vAo = clamp(0.45 + inPos.y / modelP.y * 0.7, 0.0, 1.0) * (st == ST_DYING ? 0.7 : 1.0);
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
