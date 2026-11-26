// Gore write helpers. Include AFTER declaring the buffers they use:
//   TTZ_GORE_SPAWN:  Particle particles[]; Gib gibs[]; uint gore[];      TTZ_GORE_DECALS: uint decals[];
#ifndef TTZ_GORE_WRITE_GLSL
#define TTZ_GORE_WRITE_GLSL
#ifdef TTZ_GORE_SPAWN
void spawnParticle(vec3 pos, vec3 vel, float life, uint type, float size) {
    if (goreP.w < 0.5) return;
    uint slot = atomicAdd(gore[G_PARTICLE_HEAD], 1u) % goreCap.x;
    float k = clamp(floor(life * 8.0 + 0.5), 1.0, 127.0);     // initial life, quantised to 1/8 s
    particles[slot].pos = vec4(pos, k * 0.125);
    particles[slot].vel = vec4(vel, float(type) + 8.0 * k + clamp(size, 0.01, 0.99));
}
// A spray of blood droplets: n drops around pos, thrown along base velocity plus a random spread.
void spawnBlood(vec3 pos, vec3 baseVel, float spread, float count, inout uint rng) {
    int n = int(count * goreP.x + rand01(rng));
    for (int k = 0; k < n && k < 48; ++k) {
        vec3 d = randDir(rng);
        d.y = abs(d.y) * 0.8 + 0.2;
        spawnParticle(pos + d * 0.12, baseVel + d * spread * (0.3 + rand01(rng)), 2.5 + rand01(rng) * 1.5, PT_BLOOD,
                      0.045 + 0.06 * rand01(rng));
    }
}
void spawnGib(vec3 pos, vec3 vel, vec4 rot, vec3 angVel, uint lookX, uint lookY, uint slot, bool stump, uint blood) {
    if (goreP.w < 0.5) return;
    uint g = atomicAdd(gore[G_GIB_HEAD], 1u) % goreCap.y;
    Gib o;
    o.pos = vec4(pos, 0.0);
    o.vel = vec4(vel, 1.0);
    o.rot = rot;
    o.info = uvec4((lookX & 0xFFFFFF00u) | slot | (stump ? 16u : 0u), lookY, packHalf2x16(angVel.xy), packHalf2x16(vec2(angVel.z, float(blood))));
    gibs[g] = o;
}
#endif

#ifdef TTZ_GORE_DECALS
void addGroundBlood(vec2 xz, uint amount) {
    ivec2 c = decalCoord(xz);
    if (!decalInside(c)) return;
    uint i = decalIndex(c);
    if (decals[i] < 4000u) atomicAdd(decals[i], amount);
}
// a round pool of blood (corpses, gibs landing): radius in metres
void addBloodPool(vec2 xz, float radius, uint amount) {
    float cell = 1.0 / (world.w * 3.0);
    int r = int(ceil(radius / cell));
    ivec2 c0 = decalCoord(xz);
    for (int y = -r; y <= r; ++y)
        for (int x = -r; x <= r; ++x) {
            ivec2 c = c0 + ivec2(x, y);
            if (!decalInside(c)) continue;
            float d = length(vec2(x, y)) * cell / radius;
            if (d > 1.0) continue;
            uint i = decalIndex(c);
            if (decals[i] < 4000u) atomicAdd(decals[i], uint(float(amount) * (1.2 - d)));
        }
}
void addWallBlood(vec2 xzOutside, float height) {
    ivec2 c = decalCoord(xzOutside);
    if (!decalInside(c)) return;
    atomicMax(decals[decalCount() + decalIndex(c)], uint(clamp(height, 0.0, 60.0) * 1000.0));
}
void addScorch(vec2 xz, uint v) {
    ivec2 c = decalCoord(xz);
    if (!decalInside(c)) return;
    atomicMax(decals[2u * decalCount() + decalIndex(c)], min(v, 255u));
}
#endif
#endif
