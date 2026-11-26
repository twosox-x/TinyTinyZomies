// Voxel explosion / fire volumes (fx_volume.vert / fx_volume.frag): every blast and every burning wreck is a
// procedural density field (a few evolving metaballs + animated value-noise) sampled at the CENTRES of a world-aligned
// voxel grid (0.25 m, the building voxel size; 0.5 m far away), so the fireball, smoke and dust read as chunky,
// hard-edged clouds of cubes like the rest of the voxel city. The vertex shader draws each volume's bounding box; the
// fragment shader walks the grid (Amanatides-Woo DDA) to the first voxel whose density passes the threshold.
// Must match FxVolumeUniforms in src/render/Renderer.h. Define FX_SET (1 vertex, 3 fragment) first.
#ifndef TTZ_FX_VOLUME_GLSL
#define TTZ_FX_VOLUME_GLSL
#define MAX_FX_VOLUMES 24
layout(std140, set = FX_SET, binding = 1) uniform FxVolumes {
    vec4 fxA[MAX_FX_VOLUMES];   // xyz origin (blast centre / wreck centre), w age (s)
    vec4 fxB[MAX_FX_VOLUMES];   // x scale (blast 1 car .. 2.2 tanker; wreck: footprint length m), y kind (0 blast,
                                // 1 burning wreck), z seed, w strength (wreck fire 0..1)
    uvec4 fxCount;              // x number of volumes, y pass: 0 volumes containing the camera (far faces),
                                // 1 the others (near faces, conservative depth: fx_volume_near.frag)
};
const vec3 FX_WIND = vec3(0.55, 0.0, 0.25);   // drift of smoke (m/s), same direction as the particle smoke had

float fxLife(float s) { return 5.5 + 2.0 * s; }   // blast volume lifetime: car ~7.5 s, tanker ~10 s
const float FX_NOISE_AMP = 0.7;                   // density = shape + amp * fbm (-1..1) - threshold
// erosion threshold of a blast at age t: shrinks, breaks up, vanishes
float blastThreshold(float s, float t) { float life = fxLife(s); return 0.05 + 1.8 * pow(smoothstep(0.12 * life, 0.85 * life, t), 1.1); }

// ---- blast field ----------------------------------------------------------------------------------------------
struct BlastShape { vec3 ball; float r; float flt; float stemR; float hc; float ringR; float ringT; float ringK; vec3 drift; };
BlastShape blastShape(vec3 c, float s, float t) {
    BlastShape b;
    float sb = pow(s, 0.8), ss = sqrt(s);
    float R = 1.9 * sb;                                       // fireball radius: car 1.9 m, tanker ~3.6 m
    float grow = 1.0 - exp(-t / 0.08);                        // fast expansion in the first ~0.2 s
    b.r = R * grow * (1.0 + 0.22 * t);                        // then slowly billows out as it cools
    b.hc = 0.55 * R + 2.6 * ss * t / (1.0 + 0.12 * t);        // lifts off and keeps rising
    b.drift = FX_WIND * t * 0.6;
    b.ball = c + vec3(0.0, b.hc, 0.0) + b.drift;
    b.flt = s > 1.4 ? smoothstep(0.4, 2.0, t) : 0.25 * smoothstep(0.6, 2.5, t);   // cap flattens (mushroom)
    b.stemR = R * (s > 1.4 ? 0.38 : 0.22) * smoothstep(0.25, 1.2, t);
    b.ringR = 0.8 + 3.8 * sb * (1.0 - exp(-t / 0.3));         // ground dust pushed outward
    b.ringT = (0.35 + 0.15 * t) * ss;
    b.ringK = 1.0 - smoothstep(0.6, 2.4, t);
    return b;
}
// The box only has to hold the voxel centres where the density can be > 0 (+ 0.5 m: half a far voxel's diagonal).
// The erosion threshold grows with age, so the reach of each part shrinks: ball |d_scaled| < r (1 + amp - thr),
// stem max 0.85 + amp, ring max ringK + amp. The parts that cannot pass any more drop out of the box (an aging
// cloud's box shrinks to the rising, eroding ball; a fully eroded blast gets an empty box). Never larger than the
// original fixed-factor box, so the image is unchanged; only the empty space the rays walked through goes.
void blastBox(vec3 c, float s, float t, out vec3 lo, out vec3 hi) {
    BlastShape b = blastShape(c, s, t);
    float thr = blastThreshold(s, t);
    float kb = 1.0 + FX_NOISE_AMP - thr;                          // ball reach in units of r (scaled metric)
    bool stem = b.stemR > 0.01 && 0.85 + FX_NOISE_AMP > thr, ring = b.ringK > 0.0 && b.ringK + FX_NOISE_AMP > thr;
    lo = vec3(1e9);
    hi = vec3(-1e9);
    if (kb > 0.0) {
        float rx = min(b.r * (1.6 + 0.9 * b.flt), b.r * kb * (1.0 + 0.55 * b.flt)) + 0.5;
        float ry = b.r * kb * (1.0 - 0.45 * b.flt) + 0.5;
        lo = vec3(b.ball.x - rx, max(c.y - 0.6, b.ball.y - ry), b.ball.z - rx);
        hi = vec3(b.ball.x + rx, b.ball.y + min(b.r * 1.6, b.r * kb * (1.0 - 0.45 * b.flt)) + 0.5, b.ball.z + rx);
    }
    float slack = max(FX_NOISE_AMP - thr, 0.0);                 // how far below 0 a shape term may still pass
    if (stem) {   // from the ground to the ball's centre, axis from c towards the ball (radius <= 1.2 stemR)
        float e = max(b.stemR + 0.6, 1.2 * b.stemR * (1.0 + slack / 0.85) + 0.5);
        lo = min(lo, vec3(min(c.x, b.ball.x) - e, c.y - 0.6, min(c.z, b.ball.z) - e));
        hi = max(hi, vec3(max(c.x, b.ball.x) + e, b.ball.y + 0.5, max(c.z, b.ball.z) + e));
    }
    if (ring) {   // torus around c at y = c.y - 0.25, tube ringT (vertically / 1.6)
        float tube = b.ringT * (1.0 + slack / b.ringK);
        float e = b.ringR + max(b.ringT * 1.6, tube) + 0.5;
        lo = min(lo, vec3(c.x - e, c.y - 0.6, c.z - e));
        hi = max(hi, vec3(c.x + e, c.y - 0.25 + tube / 1.6 + 0.5, c.z + e));
    }
    if (hi.x < lo.x) { lo = c; hi = c; }                         // nothing left: an empty box (culled)
    // never beyond the original box (which clipped the flattened cap a little: keep that look exactly)
    float rx0 = b.r * (1.6 + 0.9 * b.flt) + 0.5;
    vec3 lo0 = vec3(min(b.ball.x - rx0, c.x - b.stemR - 0.6), c.y - 0.6, min(b.ball.z - rx0, c.z - b.stemR - 0.6));
    vec3 hi0 = vec3(max(b.ball.x + rx0, c.x + b.stemR + 0.6), b.ball.y + b.r * 1.6 + 0.5, max(b.ball.z + rx0, c.z + b.stemR + 0.6));
    if (b.ringK > 0.0) {
        float e = b.ringR + b.ringT * 1.6 + 0.5;
        lo0.xz = min(lo0.xz, c.xz - e);
        hi0.xz = max(hi0.xz, c.xz + e);
    }
    lo = clamp(lo, lo0, hi0);
    hi = clamp(hi, lo0, hi0);
}
// ---- wreck field: flames licking off the car + a bending, breaking smoke column ----------------------------
const float WRECK_H = 13.0;
void wreckBox(vec3 c, float len, out vec3 lo, out vec3 hi) {
    float rTop = (0.7 + 0.16 * WRECK_H) * 1.7;
    vec3 top = c + vec3(0.0, WRECK_H, 0.0) + FX_WIND * WRECK_H * 0.45;
    float rf = (0.32 * len + 0.3) * 1.6 + 0.5;
    lo = min(c - vec3(rf, 0.6, rf), top - vec3(rTop, 0.0, rTop));
    hi = max(c + vec3(rf, 3.0, rf), top + vec3(rTop, 0.5, rTop));
}
void fxBox(int i, out vec3 lo, out vec3 hi) {
    if (fxB[i].y < 0.5) blastBox(fxA[i].xyz, fxB[i].x, fxA[i].w, lo, hi);
    else wreckBox(fxA[i].xyz, fxB[i].x, lo, hi);
}
#endif
