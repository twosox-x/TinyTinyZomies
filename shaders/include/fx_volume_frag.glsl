// Fragment stage of the voxel fx volumes, shared by fx_volume.frag (camera inside a box: its far faces) and
// fx_volume_near.frag (camera outside: near faces, conservative depth). Included after #version / #extension.
#ifndef TTZ_FX_VOLUME_FRAG_GLSL
#define TTZ_FX_VOLUME_FRAG_GLSL
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
#ifdef FX_HALF
// reduced-resolution pass (Renderer: fxHalfRes): also the hit voxel (xyz centre, w = voxel size + 8 x entry axis), so
// fx_composite.frag can re-intersect the exact voxel cubes per full-resolution pixel (crisp edges, exact depth)
layout(location = 1) out vec4 outVox;
#endif
#ifdef FX_NEAR
// near-face pass (camera outside the box): the voxel hit lies on the ray behind the rasterised entry face, so the depth
// written is never nearer than the face's -> early depth rejection stays on (volumes behind buildings / earlier voxels)
layout(depth_greater) out float gl_FragDepth;
#endif

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
    float ss = sqrt(s);
    if (q.y < c.y - 0.55) return -1.0;
    float thr = blastThreshold(s, t);                          // erosion: shrinks, breaks up, vanishes
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
    const float amp = FX_NOISE_AMP;
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

// Flame jet (kind 2), v4 (docs/MILITARY_ANIMS.md 7.5): one continuous rope of fire at character voxel scale (5 cm up
// close). With sr = distance to the centreline / r: the core sr <= 0.6 is always filled (it shrinks only in the last
// 25 % of the tip); outside it a voxel is filled when 1 - sr + a(k) n > 0, the noise scrolling up (9 / 16 m/s): calm at
// the nozzle, the rolling tip breaks into licking tongues. Smoke only above the tip (0.3 m up, rising, thin, lit).
// mat: x = kk on the v4 colour ramp (0 white .. 0.8 orange, 0.95 red-orange fringe), y = 2 (flame ramp) / 0 (smoke).
float vn01(vec3 p) { return vnoise(p); }
float streamDensity(vec3 q, vec3 o, vec3 d, float L, float t, float kStr, float seed, out vec3 mat) {
    mat = vec3(0.0);
    float s = dot(q - o, d);
    if (s < -0.05) return -1.0;
    vec3 e = flameCentre(o, d, L, L);
    // smoke: starts 0.3 m above the tip, rises 1.8 m/s with the wind (never inside the flame), thin and broken
    vec3 sm = q - (e + vec3(0.0, 0.3, 0.0));
    if (sm.y > -0.05 && sm.y < 1.8) {
        vec3 ax = FX_WIND * sm.y * 0.5;
        float rs = (0.14 + 0.08 * sm.y) * kStr;
        float fs = 1.0 - length(sm.xz - ax.xz) / max(rs, 0.02);
        if (fs > -1.0) {
            float n = vn01(q * 6.0 + vec3(seed, -t * 1.8 * 6.0, seed * 0.7)) * 2.0 - 1.0;
            float ds = 0.15 + fs + 0.9 * n - 0.45 - 0.35 * sm.y;
            if (ds > 0.0 && s > L - 0.6) { mat = vec3(0.0, 0.0, 0.25 + 0.2 * smoothstep(0.0, 0.3, sm.y)); return ds; }
        }
    }
    if (s > L + 0.35) return -1.0;
    float k = clamp(s / max(L, 0.5), 0.0, 1.0);
    vec3 c = flameCentre(o, d, L, min(s, L));
    float r = flameRadius(min(s, L), L) * mix(0.35, 1.0, kStr);
    float sr = length(q - c) / r;
    if (sr > 2.6) return -1.0;
    float n = 0.65 * vn01(9.0 * q + vec3(seed, -9.0 * 9.0 * t * 0.111, seed)) + 0.35 * vn01(20.0 * q + vec3(seed * 1.7, -16.0 * 20.0 * t * 0.05, 0.0));
    n = n * 2.0 - 1.0;
    float a = 0.75 * (0.35 + 0.65 * smoothstep(0.35, 1.0, k)) + 0.6 * smoothstep(0.75, 1.0, k);
    float core = 0.6 * (1.0 - smoothstep(0.75, 1.0, k) * 0.8);
    float dens = sr <= core ? 1.0 - sr + 0.5 : 1.0 - sr + a * n;
    if (s > L) dens -= (s - L) / 0.25;                         // past the reach: the licks die out
    if (dens <= 0.0) return dens;
    float jitv = fract(sin(dot(floor(q * 20.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float kk = min(0.8, 0.12 * k + 0.55 * sr + 0.18 * k * k + 0.08 * (jitv - 0.5));
    // red-orange only on a flickering 30 % of the outer fringe in the last 22 % of the tip (re-rolled 12x / s)
    float roll = fract(sin(dot(floor(q * 20.0), vec3(7.1, 3.3, 5.9)) + floor(t * 12.0) * 1.37) * 43758.5453);
    if (sr > 0.9 && k > 0.78 && roll < 0.3) kk = 0.95;
    mat = vec3(kk, 2.0, 0.0);
    return dens;
}
vec3 srgbHex(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
// v4 ramp: white #fffbe6 -> pale yellow #fff09a -> yellow #ffd24a -> yellow-orange #ffa82a -> orange #ff8418 -> red-orange #f0561a
vec3 flameRamp(float kk) {
    vec3 c0 = srgbHex(255.0, 251.0, 230.0), c1 = srgbHex(255.0, 240.0, 154.0), c2 = srgbHex(255.0, 210.0, 74.0);
    vec3 c3 = srgbHex(255.0, 168.0, 42.0), c4 = srgbHex(255.0, 132.0, 24.0), c5 = srgbHex(240.0, 86.0, 26.0);
    if (kk < 0.18) return mix(c0, c1, kk / 0.18);
    if (kk < 0.36) return mix(c1, c2, (kk - 0.18) / 0.18);
    if (kk < 0.55) return mix(c2, c3, (kk - 0.36) / 0.19);
    if (kk < 0.72) return mix(c3, c4, (kk - 0.55) / 0.17);
    return mix(c4, c5, clamp((kk - 0.72) / 0.18, 0.0, 1.0));
}
// Ray interval through the jet's bent tube (cylinder around nozzle -> end, inflated for droop / tip lift / edge noise).
bool streamRayInterval(vec3 o, vec3 d, float L, vec3 ro, vec3 rd, out float ta, out float tb) {
    ta = 0.0; tb = 0.0;
    float R = flameRadiusMax(L) * 1.3 + FLAME_DROOP * L * L + 0.35;
    vec3 oc = ro - o;
    vec3 rp = rd - d * dot(rd, d), op = oc - d * dot(oc, d);
    float A2 = dot(rp, rp), B2 = dot(op, rp), C2 = dot(op, op) - R * R;
    float x = -1e30, y = 1e30;
    if (A2 < 1e-8) { if (C2 > 0.0) return false; }
    else {
        float disc = B2 * B2 - A2 * C2;
        if (disc <= 0.0) return false;
        float sq = sqrt(disc);
        x = (-B2 - sq) / A2; y = (-B2 + sq) / A2;
    }
    float dd = dot(rd, d), s0 = dot(oc, d);
    if (abs(dd) > 1e-6) {
        float a = (-0.3 - s0) / dd, b = (L + 1.2 - s0) / dd;
        x = max(x, min(a, b)); y = min(y, max(a, b));
    } else if (s0 < -0.3 || s0 > L + 1.2) return false;
    // union with the smoke box above the tip (hull of both intervals)
    vec3 e = flameCentre(o, d, L, L);
    vec3 slo = e + vec3(-0.6, 0.2, -0.6) + min(FX_WIND, vec3(0.0)) * 0.9, shi = e + vec3(0.6, 2.1, 0.6) + max(FX_WIND, vec3(0.0)) * 0.9;
    vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
    vec3 t1 = (slo - ro) * inv, t2 = (shi - ro) * inv;
    vec3 mn = min(t1, t2), mx = max(t1, t2);
    float sx = max(max(mn.x, mn.y), mn.z), sy = min(min(mx.x, mx.y), mx.z);
    bool tube = y > x, smoke = sy > sx;
    if (!tube && !smoke) return false;
    ta = tube ? (smoke ? min(x, sx) : x) : sx;
    tb = tube ? (smoke ? max(y, sy) : y) : sy;
    return true;
}
// Ground-fire pool (kind 3), v5 (owner 2026-11-28 / GAME_DESIGN 14e: "puddles behave like fire"): flames on the
// 5-10 cm grid in separate licking tongues (one per ~0.45 m patch, each with its own flicker rate and height, scrolling
// noise along the tongue), a wobbling edge (the puddle spreads / shrinks), the burning bed always filled; strength k
// (fxB.w: the cell's remaining fire) lowers the tongues as it burns down, the bed turns to glowing embers and thin grey
// smoke wisps rise above it (more when dying). Colour: v4 ramp (yellow base -> orange tips, capped at 0.78).
float poolDensity(vec3 q, vec3 c, float R, float t, float k, float seed, out vec3 mat) {
    mat = vec3(0.0);
    float y = q.y - (c.y - 0.03);
    if (y < 0.0) return -1.0;
    vec2 rel = q.xz - c.xz;
    float edge = 0.86 + 0.28 * vnoise(vec3(rel * 1.4 + seed, t * 0.35));   // spreading / shrinking outline
    float dd = length(rel) / (R * edge);
    if (dd > 1.0 || y > 2.3) return -1.0;
    ivec2 gi = ivec2(floor(q.xz * 2.2 + seed * 0.37));
    float tid = fxH01(ivec3(gi, int(seed)));
    float flick = 0.62 + 0.38 * sin(t * (8.0 + 6.0 * tid) + tid * 40.0) * sin(t * (3.1 + 2.0 * tid) + tid * 13.0);
    float hMax = (0.3 + 0.8 * k) * (1.0 - dd * dd) * flick * (0.45 + 0.9 * vnoise(vec3(vec2(gi) * 0.9, t * 1.6 + tid * 7.0)))
                 * clamp(R / 0.6, 0.8, 1.5);
    float lick = vnoise(vec3(q.x * 4.5, q.y * 2.6 - t * 7.5, q.z * 4.5) + vec3(seed, 0.0, seed * 0.5));
    float bed = y < 0.06 && dd < 0.97 ? 1.0 : 0.0;
    float dens = max(bed, (hMax * (0.5 + 0.95 * lick) - y) / max(hMax, 0.05));
    if (dens > 0.0) {
        float h = clamp(y / max(hMax * 1.3, 0.05), 0.0, 1.0);
        float ember = bed > 0.5 && k < 0.5 ? step(0.55 + 0.35 * k, vnoise(vec3(q.xz * 9.0, t * 0.8))) : 0.0;   // dying bed
        mat = vec3(min(0.78, 0.25 + 0.55 * h + 0.15 * dd + 0.5 * ember), 2.0, 0.0);
        return dens;
    }
    // thin smoke wisps above the tongues (rising, drifting with the wind; thicker while it burns down)
    vec3 sq = q - FX_WIND * min(y, 2.0) * 0.5;
    float sy = y - (0.35 + 0.6 * k);
    if (sy > 0.0 && length(sq.xz - c.xz) < R * 0.55) {
        float n = vnoise(vec3(sq.x * 2.2, sq.y * 1.6 - t * 1.3, sq.z * 2.2) + seed);
        if (n > 0.74 - 0.12 * (1.0 - k) + 0.05 * sy) { mat = vec3(0.0, 0.0, clamp(sy * 0.5, 0.0, 1.0)); return 0.5; }
    }
    return -1.0;
}
// Ray interval [ta, tb] (hull) where a blast's parts, inflated by m (boxes: their own >= 0.5 m margins), can be: the ellipsoid of the ball, the stem's
// box, the ring's cylinder slab. Voxels whose centre has density > 0 lie wholly inside the parts inflated by the
// voxel's half diagonal, so the walk can skip what is before ta and stop after tb.
bool blastRayInterval(BlastBounds bb, vec3 c, vec3 ro, vec3 rd, vec3 inv, float m, out float ta, out float tb) {
    ta = 1e30;
    tb = -1e30;
    if (bb.ball) {   // ellipsoid (+ m: scaled up uniformly, E + B(m) lies in (1 + m / min radius) E)
        vec3 R = bb.ballR * (1.0 + m / max(min(bb.ballR.x, bb.ballR.y), 1e-3)) + 1e-3;
        vec3 o = (ro - bb.ballC) / R, d = rd / R;
        float A2 = dot(d, d), B2 = dot(o, d), C2 = dot(o, o) - 1.0, disc = B2 * B2 - A2 * C2;
        if (disc > 0.0) { float sq = sqrt(disc); ta = min(ta, (-B2 - sq) / A2); tb = max(tb, (-B2 + sq) / A2); }
    }
    if (bb.stem) {
        vec3 t1 = (bb.stemLo - vec3(0.0, 0.3, 0.0) - ro) * inv, t2 = (bb.stemHi - ro) * inv;   // voxels reach v/2 below c.y - 0.55
        vec3 mn = min(t1, t2), mx = max(t1, t2);
        float x = max(max(mn.x, mn.y), mn.z), y = min(min(mx.x, mx.y), mx.z);
        if (y > x) { ta = min(ta, x); tb = max(tb, y); }
    }
    if (bb.ring) {   // vertical cylinder of radius ringE around c, between ringY0 and ringY1
        vec2 o = ro.xz - c.xz;
        float A2 = dot(rd.xz, rd.xz), B2 = dot(o, rd.xz), C2 = dot(o, o) - bb.ringE * bb.ringE;
        float x = -1e30, y = 1e30;
        if (A2 < 1e-8) { if (C2 > 0.0) y = x; }
        else {
            float disc = B2 * B2 - A2 * C2;
            if (disc > 0.0) { float sq = sqrt(disc); x = (-B2 - sq) / A2; y = (-B2 + sq) / A2; } else y = x;
        }
        float ya = (bb.ringY0 - 0.3 - ro.y) * inv.y, yb = (bb.ringY1 - ro.y) * inv.y;
        x = max(x, min(ya, yb));
        y = min(y, max(ya, yb));
        if (y > x) { ta = min(ta, x); tb = max(tb, y); }
    }
    return tb > ta;
}

void main() {
    int i = vIdx;
    vec4 A = fxA[i], B = fxB[i];
    bool blast = B.y < 0.5;
    BlastShape bs;
    BlastBounds bb;
    vec3 lo, hi;   // the reference box: voxel size and walk start as before the tight bounds (same image)
    if (blast) {
        bs = blastShape(A.xyz, B.x, A.w);
        bb = blastBounds(A.xyz, bs, B.x, A.w);
        blastBoxRef(A.xyz, bs, lo, hi);
    } else fxBox(i, lo, hi);
    const int kind = int(B.y + 0.5);   // 0 blast, 1 wreck, 2 flame stream, 3 ground-fire pool
    vec3 fdir = kind == 2 ? flameDir(i) : vec3(0.0);
    vec3 ro = camPos.xyz, rd = normalize(vWorld - ro);
    vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
    vec3 ta = (lo - ro) * inv, tb = (hi - ro) * inv;
    vec3 tmin = min(ta, tb), tmax = max(ta, tb);
    float t0 = max(max(tmin.x, tmin.y), tmin.z), t1 = min(min(tmax.x, tmax.y), tmax.z);
    if (t1 <= max(t0, 0.0)) discard;
    int axis0 = tmin.x >= tmin.y && tmin.x >= tmin.z ? 0 : (tmin.y >= tmin.z ? 1 : 2);
    if (t0 < 0.0) { t0 = 0.0; vec3 a = abs(rd); axis0 = a.x >= a.y && a.x >= a.z ? 0 : (a.y >= a.z ? 1 : 2); }
    // voxel size: the building voxel (0.25 m); 0.5 m far away or for very long walks
    // LOD by projected size: the smallest of 0.25 / 0.5 / 1 m covering the wanted pixels per voxel (fxCount.z), one
    // level coarser when the frame's fx budget is exceeded (fxC.x); and coarser for walks longer than the step cap
    float dist = length(0.5 * (lo + hi) - ro);
    float mpp = uintBitsToFloat(fxCount.z);
    float v;
    if (mpp > 0.0) {
        float want = dist * mpp * fxC[i].x;
        v = want <= 0.25 ? 0.25 : (want <= 0.5 ? 0.5 : 1.0);
        if (kind == 2) v = want <= 0.05 ? 0.05 : (want <= 0.1 ? 0.1 : (want <= 0.25 ? 0.25 : 0.5));   // jet: gear-scale voxels
        if (kind == 3) v = want <= 0.1 ? 0.1 : (want <= 0.25 ? 0.25 : 0.5);                          // fire carpet: fine too
    }
    else v = dist > 110.0 ? 0.5 : 0.25;
    int maxSteps = int(fxC[i].y);
    if (kind == 2) {   // thin tube around the jet path: walk only that interval (bounded cost at 5 cm voxels)
        float sa, sb;
        if (!streamRayInterval(A.xyz, fdir, B.x, ro, rd, sa, sb)) discard;
        if (sa > t0) { t0 = sa; vec3 a = abs(rd); axis0 = a.x >= a.y && a.x >= a.z ? 0 : (a.y >= a.z ? 1 : 2); }
        t1 = min(t1, sb);
        if (t1 <= t0) discard;
        maxSteps *= 3;
    }
    if ((t1 - t0) / v > 0.94 * float(maxSteps) && v < 1.0) v *= 2.0;
    vec3 p = ro + rd * (t0 + 1e-4);
    ivec3 cell = ivec3(floor(p / v));
    ivec3 stp = ivec3(sign(rd));
    vec3 tMax = ((vec3(cell) + step(vec3(0.0), rd)) * v - ro) * inv;
    vec3 tDel = abs(v * inv);
    float tEnter = t0, tEnd = t1;
    int ax = axis0, k0 = 0;
    if (blast) {   // empty-space skip: start at the parts' entry (that voxel's own entry face), stop at their exit
        float sa, sb;
        if (!blastRayInterval(bb, A.xyz, ro, rd, inv, 0.87 * v + 0.01, sa, sb)) discard;
        tEnd = min(t1, sb);
        if (tEnd <= max(t0, sa)) discard;
        if (sa > t0) {
            ivec3 c2 = ivec3(floor((ro + rd * sa) / v));
            vec3 tv3 = ((vec3(c2) + vec3(lessThan(stp, ivec3(0)))) * v - ro) * inv;
            tv3 = mix(tv3, vec3(-1e30), equal(stp, ivec3(0)));
            int axv = tv3.x >= tv3.y && tv3.x >= tv3.z ? 0 : (tv3.y >= tv3.z ? 1 : 2);
            if (tv3[axv] > t0) {   // a later voxel than the first one: as if the walk had stepped there (k0 steps)
                ivec3 dc = abs(c2 - cell);
                k0 = dc.x + dc.y + dc.z;
                cell = c2;
                tMax = ((vec3(cell) + step(vec3(0.0), rd)) * v - ro) * inv;
                tEnter = tv3[axv];
                ax = axv;
            }
        }
    }
    vec3 mat;
    bool hit = false;
    for (int k = k0; k < maxSteps; ++k) {
        vec3 q = (vec3(cell) + 0.5) * v;
        float d = blast ? blastDensity(q, A.xyz, B.x, A.w, B.z, bs, mat)
                : kind == 1 ? wreckDensity(q, A.xyz, B.x, A.w, B.w, B.z, mat)
                : kind == 2 ? streamDensity(q, A.xyz, fdir, B.x, A.w, B.w, B.z, mat)
                            : poolDensity(q, A.xyz, B.x, A.w, B.w, B.z, mat);
        if (d > 0.0) { hit = true; break; }
        ax = tMax.x < tMax.y ? (tMax.x < tMax.z ? 0 : 2) : (tMax.y < tMax.z ? 1 : 2);
        tEnter = tMax[ax];
        if (tEnter > tEnd) break;
        cell[ax] += stp[ax];
        tMax[ax] += tDel[ax];
    }
    if (!hit) discard;
    vec3 P = ro + rd * tEnter;
    vec3 N = vec3(0.0);
    N[ax] = -float(stp[ax]);
    float jit = fxH01(cell * 7 + ivec3(int(B.z) * 131));      // per-voxel colour variation (MagicaVoxel look; per volume seed: stable when the draw order changes)
    vec3 col;
    float T = mat.x;
    if (mat.y > 1.5) {   // flamethrower v4 ramp: emissive, face shaded (top 1.0, sides 0.78-0.86, bottom 0.62), HDR gain
        float face = ax == 1 ? (stp[1] < 0 ? 1.0 : 0.62) : (ax == 0 ? 0.86 : 0.78);
        col = flameRamp(T) * (1.0 + 0.35 * (1.0 - T)) * face * 2.6 * (0.94 + 0.12 * jit);
    } else if (T > 0.06) {
        col = firePalette(clamp(1.0 - T + 0.15 * (jit - 0.5), 0.0, 1.0)) * (0.85 + 0.3 * jit);
    } else {
        vec3 alb = kind >= 2 ? mix(vec3(0.24, 0.22, 0.20), vec3(0.16, 0.146, 0.135), mat.z) : mat.y > 0.5 ? vec3(0.12, 0.115, 0.105) : mix(vec3(0.1, 0.098, 0.097), vec3(0.022, 0.02, 0.019), mat.z);
        alb *= 0.82 + 0.36 * jit;
        col = shade(alb * 2.0, N, P, 1.0);
        // soot still glowing from the fire inside / under it
        float glow = blast ? (1.0 - smoothstep(0.4, 1.6 * sqrt(B.x), A.w)) * (1.0 - mat.y) : 0.0;
        col += vec3(1.6, 0.35, 0.05) * glow * (0.3 + 0.7 * max(-N.y, 0.0)) * (0.5 + jit);
    }
    vec4 clip = viewProj * vec4(P, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w, 0.0, 1.0);
#ifdef FX_NEAR
    gl_FragDepth = max(gl_FragDepth, gl_FragCoord.z);         // float noise at the entry face: keep the promise
#endif
    outColor = finishA(col, P);
#ifdef FX_HALF
    outVox = vec4((vec3(cell) + 0.5) * v, v + 8.0 * float(ax));
#endif
}
#endif
