#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel particles (vertex pulling, 36 vertices, one indirect draw): blood droplets are small spinning cubes; explosion /
// fire particles are axis-aligned voxels on a world grid with fire-palette colours over their life.
#define FRAME_SET 1
#include "common.glsl"
#include "frame.glsl"
#include "gore.glsl"
layout(std430, set = 0, binding = 0) readonly buffer Particles { Particle particles[]; };
layout(std430, set = 0, binding = 1) readonly buffer PList     { uint plist[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out vec4 vColor;      // rgb linear albedo (or emission), a = 1 emissive / 0 lit
layout(location = 3) flat out vec3 vGlow;       // lit voxels: added self-glow (hot soot, glowing debris)
layout(location = 4) flat out float vFade;      // 1 solid .. 0 gone: ordered-dither dissolve in particle.frag
const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
const ivec3 CORNER[24] = ivec3[24](ivec3(1, 0, 0), ivec3(1, 1, 0), ivec3(1, 1, 1), ivec3(1, 0, 1),
                                   ivec3(0, 0, 1), ivec3(0, 1, 1), ivec3(0, 1, 0), ivec3(0, 0, 0),
                                   ivec3(0, 1, 0), ivec3(0, 1, 1), ivec3(1, 1, 1), ivec3(1, 1, 0),
                                   ivec3(0, 0, 1), ivec3(0, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 1),
                                   ivec3(1, 0, 1), ivec3(1, 1, 1), ivec3(0, 1, 1), ivec3(0, 0, 1),
                                   ivec3(0, 0, 0), ivec3(0, 1, 0), ivec3(1, 1, 0), ivec3(1, 0, 0));
const int QUAD[6] = int[6](0, 1, 2, 0, 2, 3);
float smokeMergeFrac(float age) { return clamp((age - 0.8) * 0.2, 0.0, 0.8); }   // = gore_update.comp
// fire palette over a 0..1 cooling parameter: white-yellow core -> orange -> deep red -> soot (linear, emissive scale)
vec3 firePalette(float k) {
    vec3 c = mix(vec3(9.0, 8.0, 5.5), vec3(6.0, 2.6, 0.45), smoothstep(0.0, 0.3, k));
    c = mix(c, vec3(2.2, 0.38, 0.05), smoothstep(0.3, 0.65, k));
    return mix(c, vec3(0.45, 0.05, 0.01), smoothstep(0.65, 1.0, k));
}
void main() {
    uint idx = plist[gl_InstanceIndex];
    Particle pt = particles[idx];
    uint type = uint(ptType(pt));
    float size = ptSize(pt), life = max(pt.pos.w, 0.0), life0 = ptLife0(pt), age = max(life0 - life, 0.0);
    int f = gl_VertexIndex / 6;
    vec3 c = vec3(CORNER[f * 4 + QUAD[gl_VertexIndex % 6]]) - 0.5;
    float h = hash01(ptHash(idx)), h2 = fract(h * 97.31);
    vec3 col = vec3(0.0), glow = vec3(0.0);
    float emissive = 0.0;
    vec3 scale3 = vec3(size);
    if (type == PT_BLOOD) {   // blood droplets: small spinning cubes stretched along their motion (unchanged)
        vec4 q = qaxis(normalize(vec3(h - 0.5, 0.7, fract(h * 13.7) - 0.5)), h * 6.2831);
        col = mix(vec3(0.055, 0.002, 0.004), vec3(0.11, 0.004, 0.008), fract(h * 7.3));
        float sp = length(pt.vel.xyz);
        if (sp > 2.0) { vec3 d = pt.vel.xyz / sp; q = vec4(normalize(cross(vec3(0, 1, 0), d) + vec3(1e-4, 0, 0)) * sin(0.5 * acos(clamp(d.y, -1.0, 1.0))), cos(0.5 * acos(clamp(d.y, -1.0, 1.0)))); scale3.y *= 1.0 + min(sp * 0.08, 0.8); }
        vWorld = pt.pos.xyz + qrot(q, c * scale3);
        vNormal = qrot(q, NRM[f]);
        vColor = vec4(col, 0.0);
        vGlow = vec3(0.0);
        vFade = 1.0;
        gl_Position = viewProj * vec4(vWorld, 1.0);
        return;
    }
    // Explosion voxels: axis-aligned cubes, size quantised to multiples of a world voxel grid and snapped to it
    // (debris / sparks: 0.125 m, half the building voxel; fire / smoke / dust are voxel volumes, see fx_volume.frag).
    float grow = 1.0, fade = 1.0;
    if (type == PT_FIRE) {
        // fireball voxel: flash-white for ~0.08 s, orange, deep red, then soot that keeps growing (lit by fire / moon)
        float fireT = 0.25 * life0;                                   // fire phase (see gore_update.comp)
        float k = age / fireT;
        float flick = 0.8 + 0.4 * fract(h * 31.0 + floor(camPos.w * 24.0) * 0.37);   // per-voxel flicker, 24 Hz steps
        if (k < 1.0) {
            col = firePalette(clamp(k + 0.25 * (h - 0.5), 0.0, 1.0)) * mix(flick, 1.0, smoothstep(0.0, 0.2, 1.0 - k));
            emissive = 1.0;
            grow = 0.55 + 0.7 * smoothstep(0.0, 0.12, age) + 0.4 * k;   // flash-expands in the first ~0.1 s
        } else {
            float sk = clamp((age - fireT) / (life0 - fireT), 0.0, 1.0);
            // dark soot near the fire, greying as it rises away; dissolves (dither) over the second half
            col = mix(vec3(0.03, 0.026, 0.024), vec3(0.16, 0.155, 0.15), smoothstep(0.0, 0.5, sk)) * (0.8 + 0.4 * h);
            glow = vec3(1.2, 0.25, 0.04) * (1.0 - smoothstep(0.0, 0.18, sk)) * 1.5;   // embers glowing inside fresh soot
            grow = 1.3 + 0.4 * sk;
            fade = 1.0 - smoothstep(0.35, 1.0, sk);
        }
        grow /= pow(1.0 - smokeMergeFrac(age), 0.2);
    } else if (type == PT_SMOKE) {
        // lingering column: hidden inside the fireball at first, then grows into big dark billows
        float sk = clamp(age / life0, 0.0, 1.0);
        col = mix(vec3(0.03, 0.027, 0.025), vec3(0.17, 0.165, 0.16), smoothstep(0.0, 0.45, sk)) * (0.8 + 0.4 * h);
        glow = vec3(0.9, 0.22, 0.04) * (1.0 - smoothstep(0.3, 1.2, age)) * 0.8;
        grow = smoothstep(0.15, 0.6, age) * (1.0 + 0.4 * sk) / pow(1.0 - smokeMergeFrac(age), 0.2);
        fade = 1.0 - smoothstep(0.3, 1.0, sk);
    } else if (type == PT_DEBRIS) {
        // material voxels: asphalt, concrete, car metal / paint, glass, charcoal; fresh chunks glow hot for a moment
        float m = fract(h * 5.31);
        col = m < 0.35 ? vec3(0.045, 0.045, 0.05) : m < 0.6 ? vec3(0.32, 0.31, 0.29) : m < 0.78 ? vec3(0.2, 0.21, 0.23)
            : m < 0.88 ? vec3(0.28, 0.05, 0.035) : m < 0.94 ? vec3(0.35, 0.45, 0.5) : vec3(0.02, 0.018, 0.016);
        col *= 0.8 + 0.4 * h2;
        if (h2 < 0.2) glow = vec3(3.0, 0.9, 0.15) * (1.0 - smoothstep(0.2, 1.4, age));
        grow = min(1.0, life * 1.2);
    } else if (type == PT_SPARK) {
        // sparks: white-yellow, cooling to orange-red; embers flicker deep orange
        float k = clamp(age / life0, 0.0, 1.0);
        col = h < 0.45 ? firePalette(0.45 + 0.4 * k) * (0.6 + 0.6 * fract(h * 17.0 + floor(camPos.w * 18.0) * 0.41))
                       : firePalette(k * 0.8) * 1.2;
        emissive = 1.0;
        grow = min(1.0, life * 4.0);
    } else if (type == PT_DUST) {
        // ground dust: grey-brown voxels billowing out low; they grow and dissolve
        float k = clamp(age / life0, 0.0, 1.0);
        col = vec3(0.1, 0.095, 0.09) * (0.8 + 0.4 * h);
        grow = 1.0 + 0.8 * k;
        fade = 1.0 - smoothstep(0.3, 1.0, k);
    } else if (type == PT_FLAME) {
        float k = clamp(age / life0, 0.0, 1.0);
        col = firePalette(0.15 + 0.85 * k) * (0.75 + 0.5 * fract(h * 29.0 + floor(camPos.w * 20.0) * 0.43));
        emissive = 1.0;
        grow = 1.0 - 0.6 * k;
    } else {                                                          // PT_FLASH: white-hot core, ~0.1 s
        float k = clamp(age / 0.1, 0.0, 1.0);
        col = vec3(12.0, 10.5, 7.5) * (1.0 - 0.6 * k);
        emissive = 1.0;
        grow = (1.0 + 1.5 * k) * step(age, 0.1);
    }
    // distance LOD for the big gas clouds: far away, keep half the cubes (twice the volume each)
    float dist = length(camPos.xyz - pt.pos.xyz);
    if ((type == PT_SMOKE || type == PT_FIRE || type == PT_DUST) && dist > 70.0) {
        float drop = clamp((dist - 70.0) / 60.0, 0.0, 0.5);
        grow = h < drop ? 0.0 : grow * pow(1.0 / (1.0 - drop), 0.3333);
    }
    float sz = size * grow;
    if (type == PT_FIRE || type == PT_SMOKE || type == PT_DUST) sz = min(sz, 0.5);   // gas cubes: at most 50 cm
    float g = (type == PT_DEBRIS || type == PT_SPARK) ? 0.125 : (sz < 0.14 ? 0.05 : (sz < 0.6 ? 0.1 : 0.25));
    float n = floor(sz / g + 0.5);                                    // whole voxels (0 = gone)
    float S = n * g;
    vec3 lo = floor((pt.pos.xyz - 0.5 * S) / g + 0.5) * g;           // min corner on the world voxel grid
    vWorld = lo + (c + 0.5) * S;
    vNormal = NRM[f];
    vColor = vec4(col, emissive);
    vGlow = glow;
    vFade = fade;
    gl_Position = n > 0.0 && fade > 0.02 ? viewProj * vec4(vWorld, 1.0) : vec4(0.0, 0.0, -2.0, 1.0);
}
