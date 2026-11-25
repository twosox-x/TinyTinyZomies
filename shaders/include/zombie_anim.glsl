// Procedural GPU animation of voxel body parts (no skeletons, no CPU work).
// Part ids: 0 body, 1 head, 2 arm L, 3 arm R, 4 leg L, 5 leg R.
#ifndef TTZ_ZOMBIE_ANIM_GLSL
#define TTZ_ZOMBIE_ANIM_GLSL
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }

struct Pose {
    float phase;    // gait phase (rad)
    float speed;    // horizontal speed (m/s)
    float prone;    // 0 upright .. 1 lying / crawling
    float flail;    // 0..1 falling / dying limb flail
    float climb;    // 0..1 climbing reach
    float roll;     // body roll (rad), for tumbling / corpses
    float vary;     // per-instance random 0..1
    float dead;     // 1 for corpses: limp, splayed
};

// Transforms a model-space vertex (feet at origin, facing +Z). Returns the position and rotates n.
vec3 animateVertex(vec3 p, vec3 pivot, int part, Pose s, inout vec3 n) {
    float sw = sin(s.phase);
    float gait = clamp(s.speed / 1.6, 0.0, 1.0);
    mat3 R = mat3(1.0);
    if (part == 4 || part == 5) {
        float side = part == 4 ? 1.0 : -1.0;
        float a = side * sw * 0.55 * max(gait, s.climb);
        a += s.flail * side * sin(s.phase * 2.7 + s.vary * 9.0) * 0.8;
        R = rotX(a) * rotZ(s.dead * side * (0.25 + 0.2 * s.vary));
    } else if (part == 2 || part == 3) {
        float side = part == 2 ? 1.0 : -1.0;
        // classic zombie reach: arms raised forward, swaying out of phase
        float reach = -1.35 + 0.12 * sin(s.phase * 0.5 + side + s.vary * 6.0);
        float climbReach = -2.4 + 0.6 * sin(s.phase + (side > 0.0 ? 0.0 : 3.14159));
        float a = mix(reach, climbReach, s.climb);
        a = mix(a, -2.6 + sin(s.phase * 3.1 + side * 2.0) * 1.1, s.flail);
        a = mix(a, -2.8 + side * 0.4 * s.vary, s.dead);
        float splay = side * (0.08 + 0.5 * s.flail + 0.6 * s.dead * s.vary);
        R = rotX(a) * rotZ(splay);
    } else if (part == 1) {
        R = rotZ(0.25 * sin(s.phase * 0.5 + s.vary * 5.0) * (1.0 - s.dead) + (s.vary - 0.5) * 0.5) * rotX(0.15 + 0.2 * s.dead);
    }
    vec3 q = pivot + R * (p - pivot);
    n = R * n;
    // gait bob, upright lean forward
    q.y += abs(sw) * 0.05 * gait * (1.0 - s.prone);
    mat3 B = rotX(0.12 * gait * (1.0 - s.prone) + s.prone * 1.45) * rotZ(s.roll);
    // when lying, centre the body on the agent position and rest it on the ground
    vec3 c = vec3(0.0, modelP.y * 0.5, 0.0);
    q = B * (q - c) + mix(c, vec3(0.0, 0.17, 0.0), s.prone);
    n = B * n;
    return q;
}
#endif
