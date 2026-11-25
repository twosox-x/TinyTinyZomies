// Field sampling helpers. The including shader must declare:
//   float staticH[]  (static obstacle top per cell, 0 = open ground)
//   int   corpseH[]  (accumulated corpse height per cell, millimetres)
#ifndef TTZ_FIELDS_GLSL
#define TTZ_FIELDS_GLSL

float corpseAt(ivec2 c) {
    c = clamp(c, ivec2(0), ivec2(int(grid.x) - 1, int(grid.y) - 1));
    return float(corpseH[cellIndex(c)]) * 0.001;
}

// Bilinear corpse height (smooth ramps over piles of bodies).
float corpseBilinear(vec2 xz) {
    vec2 g = (xz - world.xy) * world.w - 0.5;
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    float h00 = corpseAt(c0), h10 = corpseAt(c0 + ivec2(1, 0));
    float h01 = corpseAt(c0 + ivec2(0, 1)), h11 = corpseAt(c0 + ivec2(1, 1));
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float staticAt(ivec2 c) {
    if (c.x < 0 || c.y < 0 || c.x >= int(grid.x) || c.y >= int(grid.y)) return 1000.0; // world border is solid
    return staticH[cellIndex(c)];
}

// Ground support under a body whose feet are at feetY.
// Static geometry only supports the agent if it is already (almost) on top of it;
// otherwise it is a wall handled by the box collision.
float groundHeight(vec2 xz, float feetY) {
    float s = staticH[cellIndex(cellCoord(xz))];
    float base = (feetY >= s - moveP.w) ? s : 0.0;
    return base + corpseBilinear(xz);
}

#ifdef TTZ_CORPSE_WRITABLE
// Splat a corpse body point into the corpse height field (bilinear weights, fixed point).
void splatCorpse(vec2 xz, float heightM) {
    vec2 g = (xz - world.xy) * world.w - 0.5;
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    float w[4] = float[4]((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    ivec2 o[4] = ivec2[4](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 1));
    for (int k = 0; k < 4; ++k) {
        ivec2 c = c0 + o[k];
        if (c.x < 0 || c.y < 0 || c.x >= int(grid.x) || c.y >= int(grid.y)) continue;
        // 4 cells share the body; scale so that the volume matches one full cell of heightM
        atomicAdd(corpseH[cellIndex(c)], int(round(heightM * w[k] * 1000.0)));
    }
}
#endif // TTZ_CORPSE_WRITABLE
#endif
