#version 450
#extension GL_GOOGLE_include_directive : require
// Modular zombie segments, vertex pulling. One indirect draw per size class; every instance is one
// visible body segment. Instances whose mesh is shorter than the class size emit degenerate triangles.
#define FRAME_SET 1
#include "common.glsl"
#include "frame.glsl"
#include "zombie_parts.glsl"
#include "zombie_pose.glsl"
#include "char_common.glsl"
layout(std430, set = 0, binding = 0) readonly buffer SegInsts { SegInst segs[]; };
layout(std430, set = 0, binding = 1) readonly buffer Verts    { uint verts[]; };
layout(std430, set = 0, binding = 2) readonly buffer MeshInfo { uvec4 meshInfo[]; };
layout(std430, set = 0, binding = 3) readonly buffer CharCnt  { uint cc[]; };
layout(std430, set = 0, binding = 4) readonly buffer Agents   { Agent agents[]; };
layout(std430, set = 0, binding = 5) readonly buffer Corpses  { Corpse corpses[]; };
layout(std430, set = 0, binding = 6) readonly buffer PoseLib  { vec4 poseLib[]; };
layout(std140, set = 1, binding = 1) uniform CharDraw {
    uvec4 draw;   // x size class, y pose evaluated in the vertex shader (comparison mode)
    vec4  dparams;// x metres per voxel, y render time, z forced animation
};
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) centroid out vec3 vRest;           // body-space rest position (voxels): per-voxel colour noise
layout(location = 3) out float vAO;
layout(location = 4) flat out uvec4 vInfo;     // x tag (31 = per-voxel lookup), y appearance word,
                                                // z normal index | leg-grid flag << 3 | slot << 4 | severed mask << 8, w mesh id
const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
const float AOV[4] = float[4](0.5, 0.67, 0.84, 1.0);
void main() {
    SegInst s = segs[cc[CC_CLASS_BASE + draw.x] + uint(gl_InstanceIndex)];
    uint meshId = s.a.z & 0xFFFu, slot = (s.a.z >> 12) & 0xFu;
    uvec4 mi = meshInfo[meshId];
    if (uint(gl_VertexIndex) >= mi.y) {           // padding to the class size: degenerate, clipped
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vRest = vec3(0.0); vAO = 1.0; vInfo = uvec4(0u);
        return;
    }
    uint w = verts[mi.x + uint(gl_VertexIndex)];
    vec3 lp = vec3(float(int(w & 127u) - 64), float(int((w >> 7) & 127u) - 64), float(int((w >> 14) & 127u) - 64)) * 0.5;
    uint ni = (w >> 21) & 7u;
    vec4 q; vec3 t;
    if (draw.y == 0u || (floatBitsToUint(s.b.w) & REF_GIB) != 0u) {
        q = normalize(vec4(unpackHalf2x16(s.a.x), unpackHalf2x16(s.a.y)));
        t = s.b.xyz;
    } else {
        // comparison mode: evaluate the hierarchy per vertex (no pose pass)
        uint ref = floatBitsToUint(s.b.w);
        vec4 qs[10]; vec3 ts[10];
        float yaw;
        if ((ref & REF_CORPSE) != 0u) {
            Corpse c = corpses[ref & REF_INDEX];
            uint k = (c.info.z >> 8) % CORPSE_POSES;
            qs[slot] = poseLib[(k * 10u + slot) * 2u]; ts[slot] = poseLib[(k * 10u + slot) * 2u + 1u].xyz;
            yaw = c.pos.w;
        } else {
            Agent a = agents[ref];
            PoseInput p;
            p.anim = uint(dparams.z); p.state = a.info.x & 0xFFu; p.speed = length(a.vel.xz); p.phase = a.vel.w;
            p.prone = clamp(a.pos.w, 0.0, 1.0); p.blocked = a.prev.w; p.timer = a.dirs.w; p.vary = agentVary(a); p.time = dparams.y;
            poseTumble(p, a.dirs, a.vel.xyz);
            applyForcedPosture(p);
            vec3 E[10]; float bob, tilt, roll;
            animTargets(p, E, bob, tilt, roll);
            evaluatePose(E, bob, tilt, roll, p.prone, 0.0, dparams.x, qs, ts);
            yaw = a.dirs.z;
        }
        vec4 qy = qaxis(vec3(0.0, 1.0, 0.0), yaw);
        q = qmul(qy, qs[slot]);
        t = s.b.xyz + qrot(qy, ts[slot]);
    }
    vWorld = t + qrot(q, lp * dparams.x);
    vNormal = qrot(q, NRM[ni]);
    vRest = lp + ZP_PIVOT[slot];
    vAO = AOV[(w >> 24) & 3u];
    int fam = ZP_SLOT_FAMILY[slot];
    vInfo = uvec4((w >> 26) & 31u, s.a.w, ni | ((fam == 4 || fam == 5) ? 8u : 0u) | (slot << 4) | ((s.a.z >> 16) << 8), meshId);
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
