#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel particles: every live particle is a small spinning cube (vertex pulling, 36 vertices, one indirect draw).
#define FRAME_SET 1
#include "common.glsl"
#include "frame.glsl"
#include "gore.glsl"
layout(std430, set = 0, binding = 0) readonly buffer Particles { Particle particles[]; };
layout(std430, set = 0, binding = 1) readonly buffer PList     { uint plist[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out vec4 vColor;      // rgb linear albedo (or emission), a = 1 emissive / 0 lit
const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
const ivec3 CORNER[24] = ivec3[24](ivec3(1, 0, 0), ivec3(1, 1, 0), ivec3(1, 1, 1), ivec3(1, 0, 1),
                                   ivec3(0, 0, 1), ivec3(0, 1, 1), ivec3(0, 1, 0), ivec3(0, 0, 0),
                                   ivec3(0, 1, 0), ivec3(0, 1, 1), ivec3(1, 1, 1), ivec3(1, 1, 0),
                                   ivec3(0, 0, 1), ivec3(0, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 1),
                                   ivec3(1, 0, 1), ivec3(1, 1, 1), ivec3(0, 1, 1), ivec3(0, 0, 1),
                                   ivec3(0, 0, 0), ivec3(0, 1, 0), ivec3(1, 1, 0), ivec3(1, 0, 0));
const int QUAD[6] = int[6](0, 1, 2, 0, 2, 3);
void main() {
    uint idx = plist[gl_InstanceIndex];
    Particle pt = particles[idx];
    uint type = uint(ptType(pt));
    float size = ptSize(pt), life = pt.pos.w;
    int f = gl_VertexIndex / 6;
    vec3 c = vec3(CORNER[f * 4 + QUAD[gl_VertexIndex % 6]]) - 0.5;
    float h = hash01(idx * 2654435761u);
    float spin = (type == PT_BLOOD) ? 0.0 : (type == PT_DEBRIS ? 9.0 : 2.0);
    vec4 q = qaxis(normalize(vec3(h - 0.5, 0.7, fract(h * 13.7) - 0.5)), h * 6.2831 + camPos.w * spin * (h - 0.5));
    vec3 col; float emissive = 0.0;
    vec3 scale3 = vec3(size);
    if (type == PT_BLOOD) {
        col = mix(vec3(0.055, 0.002, 0.004), vec3(0.11, 0.004, 0.008), fract(h * 7.3));
        float sp = length(pt.vel.xyz);                                // stretch droplets along their motion
        if (sp > 2.0) { vec3 d = pt.vel.xyz / sp; q = vec4(normalize(cross(vec3(0, 1, 0), d) + vec3(1e-4, 0, 0)) * sin(0.5 * acos(clamp(d.y, -1.0, 1.0))), cos(0.5 * acos(clamp(d.y, -1.0, 1.0)))); scale3.y *= 1.0 + min(sp * 0.08, 0.8); }
    } else if (type == PT_FIRE) {
        float k = clamp(life / 0.6, 0.0, 1.0);
        col = mix(vec3(1.6, 0.25, 0.03), vec3(5.0, 3.2, 0.9), k * k) * (0.7 + 0.6 * h);
        emissive = 1.0;
        scale3 *= 0.35 + 0.9 * k;
    } else if (type == PT_SMOKE) {
        col = vec3(0.05, 0.045, 0.05) * (0.7 + 0.6 * h);
        scale3 *= 1.0 + 0.4 * clamp(1.0 - life / 2.2, 0.0, 1.0);
        scale3 *= clamp(life * 2.0, 0.0, 1.0);
    } else if (type == PT_DEBRIS) {
        col = vec3(0.05, 0.048, 0.055) * (0.7 + 0.6 * h);
        scale3 *= clamp(life * 2.0, 0.0, 1.0);
    } else {
        col = vec3(6.0, 4.0, 1.5);
        emissive = 1.0;
        scale3 *= clamp(life * 4.0, 0.0, 1.0);
    }
    vWorld = pt.pos.xyz + qrot(q, c * scale3);
    vNormal = qrot(q, NRM[f]);
    vColor = vec4(col, emissive);
    gl_Position = viewProj * vec4(vWorld, 1.0);
}
