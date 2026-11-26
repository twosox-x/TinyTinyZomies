#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel explosion / fire volumes: walk the world voxel grid through the volume's box (Amanatides-Woo DDA), evaluate
// the procedural density at each voxel centre, stop at the first solid voxel and shade it as a hard-edged cube face
// (temperature -> white-yellow / orange / red emission; cooled soot and smoke lit by moon and fire). Writes the
// voxel's depth so it occludes and is occluded by the city, vehicles and zombies. See include/fx_volume.glsl.
#define FRAME_SET 3
#define FX_SET 3
#include "frame.glsl"
#include "lighting.glsl"
#include "fx_volume.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) flat in int vIdx;
layout(location = 0) out vec4 outColor;

uint fxHash(uvec3 p) {
    uint h = p.x * 73856093u ^ p.y * 19349663u ^ p.z * 83492791u;
    h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
    return h;
}
float fxH01(ivec3 p) { return float(fxHash(uvec3(p)) & 0xFFFFFFu) / 16777216.0; }
float vnoise(vec3 p) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(fxH01(i), fxH01(i + ivec3(1, 0, 0)), f.x), b = mix(fxH01(i + ivec3(0, 1, 0)), fxH01(i + ivec3(1, 1, 0)), f.x);
    float c = mix(fxH01(i + ivec3(0, 0, 1)), fxH01(i + ivec3(1, 0, 1)), f.x), d = mix(fxH01(i + ivec3(0, 1, 1)), fxH01(i + ivec3(1, 1, 1)), f.x);
    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float fbm(vec3 p) { return (0.65 * vnoise(p) + 0.35 * vnoise(p * 2.13 + 17.1)) * 2.0 - 1.0; }   // -1..1

vec3 firePalette(float k) {   // 0 white-hot .. 1 deep red (linear, emissive)
    vec3 c = mix(vec3(9.0, 8.0, 5.5), vec3(6.0, 2.6, 0.45), smoothstep(0.0, 0.3, k));
    c = mix(c, vec3(2.2, 0.38, 0.05), smoothstep(0.3, 0.65, k));
    return mix(c, vec3(0.5, 0.06, 0.01), smoothstep(0.65, 1.0, k));
}

// Density at a voxel centre (> 0 solid) and its material: x temperature 0..1, y 0 smoke / 1 dust, z soot darkness
float blastDensity(vec3 q, vec3 c, float s, float t, float seed, BlastShape b, out vec3 mat) {
    mat = vec3(0.0);
    float life = fxLife(s), ss = sqrt(s);
    if (q.y < c.y - 0.55) return -1.0;
    float thr = 0.05 + 1.8 * pow(smoothstep(0.12 * life, 0.85 * life, t), 1.1);   // erosion: shrinks, breaks up, vanishes
    vec3 d = q - b.ball;
    d.y /= 1.0 - 0.45 * b.flt;
    d.xz /= 1.0 + 0.55 * b.flt;
    float fb = 1.0 - length(d) / max(b.r, 1e-3);
    if (b.flt > 0.0 && d.y < 0.0) fb -= 0.35 * b.flt * smoothstep(0.0, 0.6, -d.y / b.r) * (1.0 - length(d.xz) / b.r);   // rolled-up underside
    float hh = clamp((q.y - c.y) / max(b.ball.y - c.y, 1e-3), 0.0, 1.0);
    vec3 axis = mix(c, b.ball, hh);
    float fs = b.stemR > 0.01 && q.y < b.ball.y ? 0.85 * (1.0 - length(q.xz - axis.xz) / (b.stemR * (0.7 + 0.5 * hh))) : -1.0;
    float rr = length(q.xz - c.xz) - b.ringR;
    float fr = b.ringK > 0.0 ? (1.0 - length(vec2(rr, (q.y - c.y + 0.25) * 1.6)) / b.ringT) * b.ringK : -1.0;
    float base = max(fb, fs);
    bool dust = fr > base;
    base = max(base, fr);
    const float amp = 0.7;
    if (base + amp < thr) return -1.0;                         // empty space: skip the noise
    float n = fbm(q * (0.5 / ss) + vec3(seed, seed * 0.37 - t * 1.1, seed * 1.7));
    float dens = base + amp * n - thr;
    if (dens <= 0.0) return dens;
    // temperature: the young fireball's interior (hot pockets follow the noise); stem and dust are cold
    float T = clamp(1.0 - t / (1.1 * ss), 0.0, 1.0);
    T *= clamp(fb * 2.2 + 0.35 + 0.5 * n, 0.0, 1.0);
    if (t < 0.09) T = max(T, step(-0.2, fb));                  // the 50-100 ms flash: the whole ball white-hot
    mat = vec3(dust ? 0.0 : T, dust ? 1.0 : 0.0, 1.0 - smoothstep(0.6, 3.5 * ss, t));
    return dens;
}
float wreckDensity(vec3 q, vec3 c, float len, float t, float k, float seed, out vec3 mat) {
    mat = vec3(0.0);
    float y = q.y - (c.y - 0.5);
    if (y < 0.0) return -1.0;
    // flames: tongues over the wreck, flickering upward (fast noise scroll)
    float rf = 0.32 * len + 0.3;
    float ff = 1.0 - length(q.xz - c.xz) / rf - y / (0.6 + 1.8 * k);
    if (ff > -0.6) {
        float n = fbm(q * 1.3 + vec3(seed, seed - t * 4.0, seed * 0.5));
        float df = ff + 0.6 * n - 0.1;
        if (df > 0.0) { mat = vec3(clamp(0.35 + 0.8 * ff + 0.3 * n, 0.0, 1.0), 0.0, 1.0); return df; }
    }
    // smoke column: bends with the wind, widens, rises in puffs, erodes with height (gone at the top)
    if (y < 0.9) return -1.0;
    vec3 axis = c + FX_WIND * y * 0.45;
    float rc = (0.7 + 0.16 * y) * (0.6 + 0.4 * k);
    float fsm = 1.0 - length(q.xz - axis.xz) / rc;
    float thr = 0.15 + 1.2 * pow(y / WRECK_H, 0.8) + 0.6 * (1.0 - k);
    if (fsm + 0.7 < thr) return -1.0;
    float n2 = fbm(q * 0.6 + vec3(seed * 3.0, seed - t * 2.4, seed * 2.0));
    float ds = fsm + 0.7 * n2 - thr;
    mat = vec3(0.0, 0.0, 1.0 - smoothstep(2.0, 10.0, y));
    return ds;
}

void main() {
    int i = vIdx;
    vec4 A = fxA[i], B = fxB[i];
    vec3 lo, hi;
    fxBox(i, lo, hi);
    vec3 ro = camPos.xyz, rd = normalize(vWorld - ro);
    vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
    vec3 ta = (lo - ro) * inv, tb = (hi - ro) * inv;
    vec3 tmin = min(ta, tb), tmax = max(ta, tb);
    float t0 = max(max(tmin.x, tmin.y), tmin.z), t1 = min(min(tmax.x, tmax.y), tmax.z);
    if (t1 <= max(t0, 0.0)) discard;
    int axis0 = tmin.x >= tmin.y && tmin.x >= tmin.z ? 0 : (tmin.y >= tmin.z ? 1 : 2);
    if (t0 < 0.0) { t0 = 0.0; vec3 a = abs(rd); axis0 = a.x >= a.y && a.x >= a.z ? 0 : (a.y >= a.z ? 1 : 2); }
    // voxel size: the building voxel (0.25 m); 0.5 m far away or for very long walks
    float dist = length(0.5 * (lo + hi) - ro);
    float v = dist > 110.0 ? 0.5 : 0.25;
    if ((t1 - t0) / v > 150.0) v = 0.5;
    vec3 p = ro + rd * (t0 + 1e-4);
    ivec3 cell = ivec3(floor(p / v));
    ivec3 stp = ivec3(sign(rd));
    vec3 tMax = ((vec3(cell) + step(vec3(0.0), rd)) * v - ro) * inv;
    vec3 tDel = abs(v * inv);
    float tEnter = t0;
    int ax = axis0;
    bool blast = B.y < 0.5;
    BlastShape bs;
    if (blast) bs = blastShape(A.xyz, B.x, A.w);
    vec3 mat;
    bool hit = false;
    for (int k = 0; k < 160; ++k) {
        vec3 q = (vec3(cell) + 0.5) * v;
        float d = blast ? blastDensity(q, A.xyz, B.x, A.w, B.z, bs, mat) : wreckDensity(q, A.xyz, B.x, A.w, B.w, B.z, mat);
        if (d > 0.0) { hit = true; break; }
        ax = tMax.x < tMax.y ? (tMax.x < tMax.z ? 0 : 2) : (tMax.y < tMax.z ? 1 : 2);
        tEnter = tMax[ax];
        if (tEnter > t1) break;
        cell[ax] += stp[ax];
        tMax[ax] += tDel[ax];
    }
    if (!hit) discard;
    vec3 P = ro + rd * tEnter;
    vec3 N = vec3(0.0);
    N[ax] = -float(stp[ax]);
    float jit = fxH01(cell * 7 + ivec3(i * 131)) ;            // per-voxel colour variation (MagicaVoxel look)
    vec3 col;
    float T = mat.x;
    if (T > 0.06) {
        col = firePalette(clamp(1.0 - T + 0.15 * (jit - 0.5), 0.0, 1.0)) * (0.85 + 0.3 * jit);
    } else {
        vec3 alb = mat.y > 0.5 ? vec3(0.12, 0.115, 0.105) : mix(vec3(0.1, 0.098, 0.097), vec3(0.022, 0.02, 0.019), mat.z);
        alb *= 0.82 + 0.36 * jit;
        col = shade(alb * 2.0, N, P, 1.0);
        // soot still glowing from the fire inside / under it
        float glow = blast ? (1.0 - smoothstep(0.4, 1.6 * sqrt(B.x), A.w)) * (1.0 - mat.y) : 0.0;
        col += vec3(1.6, 0.35, 0.05) * glow * (0.3 + 0.7 * max(-N.y, 0.0)) * (0.5 + jit);
    }
    vec4 clip = viewProj * vec4(P, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w, 0.0, 1.0);
    outColor = finishA(col, P);
}
