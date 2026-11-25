// Ten-segment procedural zombie animation (shared by the pose compute pass, the vertex-shader pose
// mode and the corpse pose library). Requires common.glsl + zombie_parts.glsl.
//
// Hierarchy and joints are Zombie Lab's: torso and thighs hang off the root (hips), head and upper
// arms off the torso, forearms off the upper arms, shins off the thighs. Local rotations are
// Euler XYZ (three.js order) about each segment's pivot; walk / reach / idle curves are the
// approved Zombie Lab curves. Climb/crawl, flail, dying and corpse poses extend them for the game.
#ifndef TTZ_ZOMBIE_POSE_GLSL
#define TTZ_ZOMBIE_POSE_GLSL

#define ANIM_AUTO   0u
#define ANIM_IDLE   1u
#define ANIM_WALK   2u
#define ANIM_REACH  3u
#define ANIM_CLIMB  4u
#define ANIM_FLAIL  5u
#define ANIM_DYING  6u
#define ANIM_CORPSE 7u

#ifndef TTZ_QUAT_HELPERS
#define TTZ_QUAT_HELPERS
vec4 qmul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
vec3 qrot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
vec4 qaxis(vec3 axis, float a) { return vec4(axis * sin(0.5 * a), cos(0.5 * a)); }
#endif
vec4 qeulerXYZ(vec3 e) { return qmul(qmul(qaxis(vec3(1, 0, 0), e.x), qaxis(vec3(0, 1, 0), e.y)), qaxis(vec3(0, 0, 1), e.z)); }

struct PoseInput {
    uint  anim;      // ANIM_* (ANIM_AUTO: derive from state)
    uint  state;     // ST_*
    float speed;     // horizontal speed m/s
    float phase;     // gait phase (rad), advanced by the simulation
    float prone;     // 0 upright .. 1 crawling / lying
    float blocked;   // crowd pressure EMA 0..1
    float timer;     // state timer (s)
    float vary;      // stable per-zombie random
    float time;      // render time (s)
    float roll;      // falling / dying: tumble angle (rad), integrated by the simulation
    float flail;     // falling / dying: 0 limp (resting on something) .. 1 flying, limbs flailing
};
// PoseInput defaults for the new fields; character code fills them from the agent record
void poseTumble(inout PoseInput p, vec4 dirs, vec3 vel) {
    bool tumbling = p.state == ST_FALL || p.state == ST_DYING;
    p.roll = (tumbling && p.state == ST_DYING) ? dirs.x : 0.0;
    p.flail = tumbling ? smoothstep(0.8, 3.5, length(vel)) : 0.0;
}

// Previews (ANIM_* forced from the debug UI / command line) also force the matching body posture.
void applyForcedPosture(inout PoseInput p) {
    if (p.anim == ANIM_CLIMB) p.prone = 1.0;
    if (p.anim == ANIM_DYING) { p.prone = 1.0; p.timer = mod(p.time, 2.5); }
    if (p.anim == ANIM_FLAIL) p.prone = 0.6;
}

// Euler targets for the 10 slots (head, torso, uaL, faL, uaR, faR, thL, shL, thR, shR) + torso bob (voxels).
void animTargets(PoseInput p, out vec3 E[10], out float bob, out float tilt, out float roll) {
    for (int i = 0; i < 10; ++i) E[i] = vec3(0.0);
    bob = 0.0; tilt = 0.0; roll = 0.0;
    uint anim = p.anim;
    float wWalk = 0.0, wReach = 0.0, wIdle = 0.0, wClimb = 0.0, wFlail = 0.0;
    if (anim == ANIM_AUTO) {
        if (p.state == ST_FALL || p.state == ST_DYING) wFlail = 1.0;
        else {
            wClimb = p.state == ST_CLIMB ? 1.0 : smoothstep(0.35, 0.9, p.prone);
            wWalk = smoothstep(0.12, 0.6, p.speed);
            wReach = (1.0 - wWalk) * smoothstep(0.2, 0.55, p.blocked);
            wIdle = 1.0 - wWalk - wReach;
        }
    } else if (anim == ANIM_IDLE) wIdle = 1.0;
    else if (anim == ANIM_WALK) wWalk = 1.0;
    else if (anim == ANIM_REACH) wReach = 1.0;
    else if (anim == ANIM_CLIMB) wClimb = 1.0;
    else wFlail = 1.0;

    float upright = 1.0 - wClimb;
    if (wWalk > 0.0) {                                   // Zombie Lab "walk"
        float ph = anim == ANIM_WALK ? p.time * 4.6 * (0.85 + 0.3 * p.vary) + p.vary * 20.0 : p.phase;   // preview: Lab timing
        float k = wWalk * upright;
        E[6].x += k * sin(ph) * 0.5;               E[8].x += k * -sin(ph) * 0.5;
        E[7].x += k * max(0.0, cos(ph)) * 0.75;    E[9].x += k * max(0.0, -cos(ph)) * 0.75;
        E[2].x += k * (-1.3 + 0.12 * sin(ph * 0.5 + 1.1)); E[4].x += k * (-1.22 + 0.12 * sin(ph * 0.5));
        E[3].x += k * (0.18 + 0.12 * sin(ph * 0.5 + 2.0)); E[5].x += k * (0.25 + 0.12 * sin(ph * 0.5 + 0.4));
        E[2].z += k * 0.07;                        E[4].z += k * -0.07;
        E[1].x += k * 0.14;                        E[1].y += k * sin(ph) * 0.07;
        E[0].x += k * 0.12;                        E[0].z += k * sin(ph * 0.5) * 0.14;
        bob += k * abs(sin(ph)) * 0.3;
    }
    if (wReach > 0.0) {                                  // Zombie Lab "reach"
        float ph = p.time * 2.3 * (0.85 + 0.3 * p.vary) + p.vary * 20.0;
        float k = wReach * upright;
        E[2].x += k * (-1.75 + 0.3 * sin(ph));     E[4].x += k * (-1.75 + 0.3 * sin(ph + 3.14159265));
        E[3].x += k * (-0.15 - 0.35 * max(0.0, sin(ph + 0.6)));
        E[5].x += k * (-0.15 - 0.35 * max(0.0, sin(ph + 3.14159265 + 0.6)));
        E[2].z += k * (0.14 + 0.1 * sin(ph * 1.3)); E[4].z += k * -(0.14 + 0.1 * sin(ph * 1.3 + 1.0));
        E[1].x += k * (0.3 + 0.06 * sin(ph * 0.5)); E[1].z += k * 0.07 * sin(ph * 0.4);
        E[0].x += k * -0.22;                       E[0].y += k * 0.25 * sin(ph * 0.3);
        E[6].x += k * -0.25; E[7].x += k * 0.35;   E[8].x += k * 0.2; E[9].x += k * 0.15;
        bob += k * 0.1 * sin(ph);
    }
    if (wIdle > 0.0) {                                   // Zombie Lab "idle"
        float ph = p.time * 1.1 + p.vary * 20.0;
        float k = wIdle * upright;
        E[2].x += k * (-0.15 + 0.05 * sin(ph));    E[4].x += k * (-0.1 + 0.05 * sin(ph + 2.0));
        E[3].x += k * -0.3;                        E[5].x += k * -0.2;
        E[2].z += k * 0.05;                        E[4].z += k * -0.05;
        E[8].x += k * -0.12;                       E[9].x += k * 0.22;
        E[1].x += k * 0.08;                        E[1].z += k * 0.05 * sin(ph * 0.7);
        E[0].z += k * (0.2 + 0.06 * sin(ph));      E[0].x += k * 0.14;
    }
    if (wClimb > 0.0) {                                  // climbing / crawling over the crowd (body prone)
        float ph = anim == ANIM_CLIMB ? p.time * 9.0 + p.vary * 20.0 : p.phase, k = wClimb;
        E[2].x += k * (-2.6 + 0.5 * sin(ph));      E[4].x += k * (-2.6 + 0.5 * sin(ph + 3.14159265));
        E[3].x += k * (-0.3 - 0.45 * max(0.0, sin(ph + 0.8))); E[5].x += k * (-0.3 - 0.45 * max(0.0, sin(ph + 3.94159265)));
        E[2].z += k * 0.12;                        E[4].z += k * -0.12;
        E[6].x += k * 0.35 * sin(ph + 3.14159265); E[8].x += k * 0.35 * sin(ph);
        E[7].x += k * (0.4 + 0.4 * max(0.0, cos(ph)));  E[9].x += k * (0.4 + 0.4 * max(0.0, -cos(ph)));
        E[0].x += k * -0.7;
    }
    if (wFlail > 0.0) {                                  // thrown / falling / dying: limbs flail while airborne
        float ft = p.time * (3.1 + p.vary * 2.0) + p.vary * 30.0;
        float fk = anim == ANIM_AUTO ? p.flail : 1.0;
        E[2] = vec3(-2.6 + 1.1 * sin(ft + 2.0), 0.0, 0.5 + 0.3 * sin(ft * 1.7));
        E[4] = vec3(-2.6 + 1.1 * sin(ft - 2.0), 0.0, -(0.5 + 0.3 * sin(ft * 1.7 + 1.0)));
        E[3] = vec3(-0.6 * max(0.0, sin(ft * 1.3 + 1.0)), 0.0, 0.0);
        E[5] = vec3(-0.6 * max(0.0, sin(ft * 1.3 - 1.0)), 0.0, 0.0);
        E[6] = vec3(0.7 * sin(ft * 0.9 + 1.5), 0.0, 0.3);
        E[8] = vec3(0.7 * sin(ft * 0.9 - 1.5), 0.0, -0.3);
        E[7] = vec3(0.3 + 0.5 * max(0.0, sin(ft + 1.0)), 0.0, 0.0);
        E[9] = vec3(0.3 + 0.5 * max(0.0, sin(ft - 1.0)), 0.0, 0.0);
        E[0] = vec3(0.3 * sin(ft * 0.6), 0.0, 0.0);
        E[1] = vec3(0.0, 0.0, 0.2 * sin(ft * 0.8));
        // limp, splayed limbs once the body rests on something (matches the corpse library's poses)
        float sgn = p.vary > 0.5 ? 1.0 : -1.0;
        vec3 L[10] = vec3[10](vec3(0.3, 0.0, 0.25 * sgn), vec3(0.0), vec3(-2.6 + 0.4 * p.vary, 0.0, 0.45), vec3(-0.3, 0.0, 0.0),
                              vec3(-2.75 + 0.3 * p.vary, 0.0, -0.4), vec3(-0.2, 0.0, 0.0), vec3(-0.1, 0.0, 0.3), vec3(0.3, 0.0, 0.0),
                              vec3(-0.15, 0.0, -0.32), vec3(0.25, 0.0, 0.0));
        for (int i = 0; i < 10; ++i) E[i] = mix(L[i], E[i], fk);
    }
    tilt = p.prone * 1.45;                               // forward onto the belly when prone / lying
    if (anim == ANIM_DYING) roll = p.timer * (2.0 + 3.0 * p.vary) * (p.vary > 0.5 ? 1.0 : -1.0);   // preview only
    else if (anim == ANIM_AUTO && p.state == ST_DYING) roll = p.roll;                             // simulated tumble
}

// Corpse library pose k: lying face down or up, limbs splayed (static; computed once at start-up).
void corpseTargets(uint k, out vec3 E[10], out float tilt, out float roll, out float lift) {
    float v[8];
    for (int i = 0; i < 8; ++i) v[i] = hash01(k * 8u + uint(i) + 9137u);
    roll = (v[0] > 0.5 ? 3.14159265 : 0.0) + (v[1] - 0.5) * 0.5;
    tilt = 1.45;
    lift = 0.0;                                          // face-up bodies: evaluatePose lifts by the roll (0.26 m on the back)
    E[0] = vec3(0.3, 0.0, (v[2] - 0.5) * 0.8);
    E[1] = vec3(0.0);
    E[2] = vec3(-2.8 + 0.4 * v[3], 0.0, 0.2 + 0.5 * v[4]);  E[3] = vec3(-0.5 * v[5], 0.0, 0.0);
    E[4] = vec3(-2.8 + 0.4 * v[6], 0.0, -(0.2 + 0.5 * v[7])); E[5] = vec3(-0.5 * v[2], 0.0, 0.0);
    E[6] = vec3(-0.2 * v[4], 0.0, 0.25 + 0.2 * v[3]);       E[7] = vec3(0.4 * v[5], 0.0, 0.0);
    E[8] = vec3(-0.2 * v[1], 0.0, -(0.25 + 0.2 * v[6]));    E[9] = vec3(0.4 * v[7], 0.0, 0.0);
}

// Hierarchical evaluation. Output: per-slot rotation q[i] and translation t[i] such that a mesh vertex v
// (voxel units, relative to the slot pivot) lands at  t[i] + qrot(q[i], v * scale)  in body-root space
// (metres, origin at the feet before yaw), i.e. heading and world position are applied by the caller.
void evaluatePose(vec3 E[10], float bob, float tilt, float roll, float prone, float lift, float scale,
                  out vec4 q[10], out vec3 t[10]) {
    // body root: tilt/roll about the body centre, lowered onto the ground when lying (as the original renderer)
    vec3 c = vec3(0.0, 9.0, 0.0);                        // body centre, voxels
    vec4 qb = qmul(qaxis(vec3(1, 0, 0), tilt), qaxis(vec3(0, 0, 1), roll));
    lift += 0.13 * (1.0 - cos(roll)) * prone;            // lying on the back: chest depth (as the corpse poses)
    vec3 tb = (-qrot(qb, c) + mix(c, vec3(0.0, 1.8, 0.0), prone)) * scale + vec3(0.0, lift, 0.0);
    // order: torso, head, uaL, faL, uaR, faR, thL, shL, thR, shR (parents before children)
    const int ORDER[10] = int[10](1, 0, 2, 3, 4, 5, 6, 7, 8, 9);
    for (int n = 0; n < 10; ++n) {
        int i = ORDER[n];
        int par = ZP_SLOT_PARENT[i];
        vec3 local = par < 0 ? ZP_PIVOT[i] : ZP_PIVOT[i] - ZP_PIVOT[par];
        if (i == 1) local.y += bob;
        vec4 ql = qeulerXYZ(E[i]);
        if (par < 0) { q[i] = qmul(qb, ql); t[i] = tb + qrot(qb, local * scale); }
        else { q[i] = qmul(q[par], ql); t[i] = t[par] + qrot(q[par], local * scale); }
    }
}
#endif
