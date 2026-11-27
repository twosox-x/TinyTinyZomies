// Key-light (sun by day, moon by night) shadows.
//  - Shadow map (default): one depth map rendered each frame from the key light's direction over the visible part of
//    the map (city tiles, vehicles, props, characters, lab objects; Renderer::renderShadowMap), sampled with hardware
//    depth comparison as a 3 x 3 grid of bilinear taps (soft 4 x 4 texel tent). Receivers offset along the normal.
//  - Legacy height field (fallback when the map is off): for every ground cell (sim cell / 3) the height below which
//    the fixed default moon direction is hidden by a building, car, wall or lamp post (CPU, per sim window).
// Include after declaring: float shadowH[]; and with set 2 binding 0 free (the shadow map sampler). Requires frame.glsl.
#ifndef TTZ_SHADOW_GLSL
#define TTZ_SHADOW_GLSL
#define DBG_SHADOWS 32u
layout(set = 2, binding = 0) uniform sampler2DArrayShadow shadowMap;   // 2 layers: neighbouring sun keys
float shadowAt(ivec2 c) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    c = clamp(c, ivec2(0), d - 1);
    return shadowH[uint(c.y) * uint(d.x) + uint(c.x)];
}
float shadowFieldVisibility(vec3 P, vec3 N) {
    vec3 Q = P + N * 0.12;
    vec2 g = (Q.xz - gridP.xy) * gridP.w * 3.0 - 0.5;
    if (g.x < -1.0 || g.y < -1.0 || g.x > float(gridDim.x * 3u) || g.y > float(gridDim.y * 3u)) return 1.0;   // outside the field (city: beyond the sim window)
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    float h = mix(mix(shadowAt(c0), shadowAt(c0 + ivec2(1, 0)), f.x), mix(shadowAt(c0 + ivec2(0, 1)), shadowAt(c0 + ivec2(1, 1)), f.x), f.y);
    return smoothstep(-0.08, 0.08, Q.y - h);
}
float shadowMapLayer(vec3 Q, mat4 vp, float layer) {
    vec4 c = vp * vec4(Q, 1.0);
    float edge = max(abs(c.x), abs(c.y));
    if (edge >= 1.0 || c.z <= 0.0) return 1.0;
    vec2 uv = vec2(c.x * 0.5 + 0.5, 0.5 - 0.5 * c.y);
    float z = min(c.z - shadowP.z, 1.0);
    float d = shadowP.w;
    float s = 0.0;
    for (int j = -1; j <= 1; ++j)
        for (int i = -1; i <= 1; ++i) s += texture(shadowMap, vec4(uv + vec2(i, j) * d, layer, z));
    s *= 1.0 / 9.0;
    return mix(s, 1.0, smoothstep(0.88, 1.0, edge));   // fade out towards the map's border
}
float shadowMapVisibility(vec3 P, vec3 N) {
    // normal offset grows at grazing angles (where depth slopes are steep); a little extra towards the light
    float ndl = dot(N, sunDir.xyz);
    vec3 Q = P + N * shadowP.y * (1.2 + 1.8 * (1.0 - abs(ndl))) + sunDir.xyz * shadowP.y * 0.5;
    // smooth sun: cross-fade the maps of the two clock keys around the current time (Renderer::shadowView)
    float w = shadowP2.x;
    float a = w < 0.999 ? shadowMapLayer(Q, shadowVP, shadowP2.y) : 1.0;
    float b = w > 0.001 ? shadowMapLayer(Q, shadowVP2, shadowP2.z) : 1.0;
    return w < 0.001 ? a : w > 0.999 ? b : mix(a, b, w);
}
// 1 = lit by the key light, 0 = in shadow. (Name kept from the night-only engine.)
float moonVisibility(vec3 P, vec3 N) {
    if ((gridDim.w & DBG_SHADOWS) == 0u) return 1.0;
    if (shadowP.x > 0.5) return shadowMapVisibility(P, N);
    return shadowFieldVisibility(P, N);
}
#endif
