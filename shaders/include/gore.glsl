// Gore: blood / fire / smoke / debris particles, flying body parts (gibs), blood and scorch decals.
// Layouts must match src/sim/GpuTypes.h. Requires common.glsl.
//
// Particle (32 B): pos (xyz, remaining life s), vel (xyz, type + size in metres: floor = type, fract = size)
// Gib      (64 B): pos (xyz, age s), vel (xyz, state 0 free / 1 flying / 2 resting), rot (quaternion),
//                  info (x = look X with slot in bits 0..3 and stump flag in bit 4, y = look Y,
//                        z = packHalf2x16(angular velocity xy), w = packHalf2x16(angular velocity z, bloodiness))
// Decals: uint[3 * D] over the map at (sim cell / 3) resolution: [0, D) ground blood (amount),
//         [D, 2D) wall blood (highest splat in mm, the cell in front of the wall), [2D, 3D) scorch (0..255)
#ifndef TTZ_GORE_GLSL
#define TTZ_GORE_GLSL

struct Particle { vec4 pos; vec4 vel; };
struct Gib { vec4 pos; vec4 vel; vec4 rot; uvec4 info; };

#define PT_BLOOD  0u
#define PT_FIRE   1u
#define PT_SMOKE  2u
#define PT_DEBRIS 3u
#define PT_SPARK  4u

#define G_PARTICLE_HEAD   0u
#define G_GIB_HEAD        1u
#define G_PARTICLES_ALIVE 2u
#define G_GIBS_ALIVE      3u
#define G_SEVERED         4u
#define G_GIBBED          5u
#define G_DRAW_ARGS       8u   // 4 uints: vertex count, instance count, first vertex, first instance

float ptType(Particle p) { return floor(p.vel.w); }
float ptSize(Particle p) { return fract(p.vel.w); }

uint decalCount() { return goreCap.z * goreCap.w; }
ivec2 decalCoord(vec2 xz) { return ivec2(floor((xz - world.xy) * world.w * 3.0)); }
bool decalInside(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < int(goreCap.z) && c.y < int(goreCap.w); }
uint decalIndex(ivec2 c) { return uint(c.y) * goreCap.z + uint(c.x); }

// quaternion helpers (also in zombie_pose.glsl; guarded so both can be included)
#ifndef TTZ_QUAT_HELPERS
#define TTZ_QUAT_HELPERS
vec4 qmul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }
vec3 qrot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
vec4 qaxis(vec3 axis, float ang) { return vec4(axis * sin(ang * 0.5), cos(ang * 0.5)); }
#endif

vec3 randDir(inout uint s) {
    float z = rand01(s) * 2.0 - 1.0, a = rand01(s) * 6.2831853;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), z, r * sin(a));
}

#endif
