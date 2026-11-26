// Moon shadows of the static city, from a precomputed shadow height field: for every ground cell
// (sim cell / 3) the height below which the moon is hidden by a building, car, wall or lamp post.
// Exact for box occluders and a fixed moon direction; computed once per map on the CPU (Renderer).
// Include after declaring: float shadowH[];  Requires frame.glsl.
#ifndef TTZ_SHADOW_GLSL
#define TTZ_SHADOW_GLSL
#define DBG_SHADOWS 32u
float shadowAt(ivec2 c) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    c = clamp(c, ivec2(0), d - 1);
    return shadowH[uint(c.y) * uint(d.x) + uint(c.x)];
}
// 1 = moonlit, 0 = in shadow. P is offset along the normal so lit faces do not shadow themselves.
float moonVisibility(vec3 P, vec3 N) {
    if ((gridDim.w & DBG_SHADOWS) == 0u) return 1.0;
    vec3 Q = P + N * 0.12;
    vec2 g = (Q.xz - gridP.xy) * gridP.w * 3.0 - 0.5;
    if (g.x < -1.0 || g.y < -1.0 || g.x > float(gridDim.x * 3u) || g.y > float(gridDim.y * 3u)) return 1.0;   // outside the field (city: beyond the sim window)
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    float h = mix(mix(shadowAt(c0), shadowAt(c0 + ivec2(1, 0)), f.x), mix(shadowAt(c0 + ivec2(0, 1)), shadowAt(c0 + ivec2(1, 1)), f.x), f.y);
    return smoothstep(-0.08, 0.08, Q.y - h);
}
#endif
