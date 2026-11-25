// Modular appearance generation (runs once per zombie, at spawn). Requires common.glsl + zombie_parts.glsl.
// Category weights come from SimUniforms.lookA / lookB (see SimParams: look* parameters).
// The rules mirror Zombie Lab's randomSpec(): per-slot module choice weighted by decomposition level,
// mostly symmetric limbs, consistent garments (shorts -> bare shins, trousers -> trousered shins),
// sleeveless torsos -> bare arms, independent palette picks from the approved colour lists.
#ifndef TTZ_ZOMBIE_LOOK_GLSL
#define TTZ_ZOMBIE_LOOK_GLSL

#define CAT_RECENT   0u
#define CAT_CLOTHED  1u
#define CAT_LIGHT    2u
#define CAT_HEAVY    3u
#define CAT_SKELETAL 4u
#define CAT_MISSING  5u

// probability of decay level 0 / 1 / 2 for a module, by category (level 2 = remainder)
vec2 catLevels(uint cat, bool limb) {
    if (cat == CAT_RECENT)  return vec2(1.0, 0.0);
    if (cat == CAT_CLOTHED) return vec2(1.0, 0.0);
    if (cat == CAT_LIGHT)   return vec2(0.65, 0.35);
    if (cat == CAT_HEAVY)   return vec2(0.25, 0.45);
    if (cat == CAT_SKELETAL) return limb ? vec2(0.08, 0.17) : vec2(0.25, 0.25);
    return vec2(0.25, 0.45);   // missing-limb: heavy body plus a missing forearm
}

// pick a module of a family with the requested decay level (never the "missing" forearm here)
uint pickModule(uint family, uint level, inout uint rng) {
    uint first = ZP_FAMILY_FIRST[family], count = ZP_FAMILY_COUNT[family];
    for (int attempt = 0; attempt < 3; ++attempt) {
        uint n = 0u;
        for (uint m = 0u; m < count; ++m)
            if (ZP_MODULE_DECAY[first + m] == level && !(family == 3u && m == ZP_FOREARM_MISSING)) ++n;
        if (n > 0u) {
            uint k = uint(rand01(rng) * float(n));
            for (uint m = 0u; m < count; ++m)
                if (ZP_MODULE_DECAY[first + m] == level && !(family == 3u && m == ZP_FOREARM_MISSING)) { if (k == 0u) return m; --k; }
        }
        if (level == 0u) break;
        --level;                       // fall back to a less decomposed module
    }
    return 0u;
}
uint pickLevel(uint cat, bool limb, inout uint rng) {
    vec2 p = catLevels(cat, limb);
    float r = rand01(rng);
    return r < p.x ? 0u : (r < p.x + p.y ? 1u : 2u);
}

// returns (info.x look bits, info.y look bits)
uvec2 generateLook(inout uint rng) {
    if (forcedLook.z != 0u) return forcedLook.xy;
    float w[6] = float[6](lookA.x, lookA.y, lookA.z, lookA.w, lookB.x, lookB.y);
    float total = 0.0;
    for (int i = 0; i < 6; ++i) total += max(w[i], 0.0);
    float r = rand01(rng) * max(total, 1e-6);
    uint cat = 0u;
    for (uint i = 0u; i < 6u; ++i) { r -= max(w[i], 0.0); if (r <= 0.0) { cat = i; break; } }

    // modules per slot: head, torso, uaL, uaR, faL, faR, thL, thR, shL, shR
    uint m[10];
    m[0] = pickModule(0u, pickLevel(cat, false, rng), rng);
    m[1] = pickModule(1u, pickLevel(cat, false, rng), rng);
    m[2] = pickModule(2u, pickLevel(cat, true, rng), rng);
    m[3] = pickModule(2u, pickLevel(cat, true, rng), rng);
    m[4] = pickModule(3u, pickLevel(cat, true, rng), rng);
    m[5] = pickModule(3u, pickLevel(cat, true, rng), rng);
    m[6] = pickModule(4u, pickLevel(cat, true, rng), rng);
    m[7] = pickModule(4u, pickLevel(cat, true, rng), rng);
    m[8] = pickModule(5u, pickLevel(cat, true, rng), rng);
    m[9] = pickModule(5u, pickLevel(cat, true, rng), rng);
    if (cat == CAT_CLOTHED) {                       // fully clothed: sleeves and trousers
        m[2] = m[3] = m[4] = m[5] = ZP_ARM_SLEEVE;
        m[6] = m[7] = ZP_THIGH_PANTS; m[8] = m[9] = ZP_SHIN_PANTS;
        if (ZP_TORSO_SLEEVE[m[1]] == 2u) m[1] = 0u;  // no tank tops
    }
    // mostly symmetric (Zombie Lab: 55 % of limb pairs copy the left side)
    if (rand01(rng) < 0.55) m[3] = m[2];
    if (rand01(rng) < 0.55) m[5] = m[4];
    if (rand01(rng) < 0.55) m[7] = m[6];
    if (rand01(rng) < 0.55) m[9] = m[8];
    if (cat == CAT_MISSING) {
        float q = rand01(rng);
        if (q < 0.45 || q >= 0.8) m[4] = ZP_FOREARM_MISSING;
        if (q >= 0.45) m[5] = ZP_FOREARM_MISSING;    // 20 % lose both
    }
    // garment consistency
    for (int sd = 0; sd < 2; ++sd) {
        if (m[6 + sd] == ZP_THIGH_SHORTS && m[8 + sd] == ZP_SHIN_PANTS) m[8 + sd] = ZP_SHIN_SKIN;
        if (m[6 + sd] == ZP_THIGH_PANTS && m[8 + sd] == ZP_SHIN_SKIN) m[8 + sd] = ZP_SHIN_PANTS;
    }
    if (ZP_TORSO_SLEEVE[m[1]] == 2u) {
        if (m[2] == ZP_ARM_SLEEVE) m[2] = ZP_UPPER_BARE;
        if (m[3] == ZP_ARM_SLEEVE) m[3] = ZP_UPPER_BARE;
        if (m[4] == ZP_ARM_SLEEVE) m[4] = ZP_FORE_BARE;
        if (m[5] == ZP_ARM_SLEEVE) m[5] = ZP_FORE_BARE;
    }
    // detail tier and decomposition bucket follow the category
    uint tier, decay;
    float t = rand01(rng);
    if (cat == CAT_RECENT)       { tier = t < 0.7 ? 0u : 1u; decay = 0u; }
    else if (cat == CAT_CLOTHED) { tier = t < 0.5 ? 0u : 1u; decay = uint(rand01(rng) * 2.0); }
    else if (cat == CAT_LIGHT)   { tier = t < 0.7 ? 1u : 2u; decay = 1u + uint(rand01(rng) * 2.0); }
    else if (cat == CAT_SKELETAL){ tier = 2u; decay = 3u; }
    else                         { tier = t < 0.3 ? 1u : 2u; decay = 2u + uint(rand01(rng) * 2.0); }
    decay = min(decay, 3u);

    uint x = (m[0] << 8) | (m[1] << 11) | (m[2] << 14) | (m[3] << 17) | (m[4] << 20) | (m[5] << 23) | (m[6] << 26) | (m[7] << 29);
    uint y = m[8] | (m[9] << 3) | (tier << 6) | (decay << 8);
    y |= uint(rand01(rng) * 8.0) << 10;                    // skin   (8)
    y |= min(uint(rand01(rng) * 9.0), 8u) << 13;           // top    (9)
    y |= uint(rand01(rng) * 4.0) << 17;                    // shirt  (4)
    y |= min(uint(rand01(rng) * 6.0), 5u) << 19;           // pants  (6)
    y |= min(uint(rand01(rng) * 6.0), 5u) << 22;           // hair   (6)
    y |= min(uint(rand01(rng) * 3.0), 2u) << 25;           // tie    (3)
    y |= min(uint(rand01(rng) * 5.0), 4u) << 27;           // hat    (5)
    y |= min(uint(rand01(rng) * 3.0), 2u) << 30;           // shoe   (3)
    return uvec2(x, y);
}
#endif
