#version 450
// Miniature DOF pass 1 (full -> half resolution): 2x2 downsample of the resolved scene to scene-linear colour, CoC from
// the alpha the scene shaders wrote (thin lens), highlight boost so lit windows / lamps / fire turn into bright bokeh
// discs. CoC-weighted average (premultiplied by |CoC|, KinoBokeh) keeps sharp in-focus colour out of blurred pixels;
// a mild luma weight damps single-pixel flicker.
#extension GL_GOOGLE_include_directive : require
#include "dof.glsl"
layout(set = 2, binding = 0) uniform sampler2D src;   // full-res resolved scene: rgb display colour, a CoC code
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;   // rgb scene-linear (highlights boosted), a signed CoC in half-res px
vec3 boost(vec3 c) {
    float h = smoothstep(d1.x, 1.0, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    return toLinear(c) * (1.0 + d0.w * h * h);
}
float flick(vec3 c) { return 1.0 / (1.0 + 0.5 * max(c.r, max(c.g, c.b))); }   // display colour: damps lone bright texels
void main() {
    vec2 t = vec2(d0.y, d0.z) * 0.25;   // a quarter half-res texel = half a full-res texel
    vec4 s0 = texture(src, vUv + vec2(-t.x, -t.y));
    vec4 s1 = texture(src, vUv + vec2( t.x, -t.y));
    vec4 s2 = texture(src, vUv + vec2(-t.x,  t.y));
    vec4 s3 = texture(src, vUv + vec2( t.x,  t.y));
    vec4 cocs = vec4(decodeCoc(s0.a), decodeCoc(s1.a), decodeCoc(s2.a), decodeCoc(s3.a));
    vec3 c0 = boost(s0.rgb), c1 = boost(s1.rgb), c2 = boost(s2.rgb), c3 = boost(s3.rgb);
    vec4 w = clamp(abs(cocs) / d0.x, 0.02, 1.0);
    w *= vec4(flick(s0.rgb), flick(s1.rgb), flick(s2.rgb), flick(s3.rgb));
    vec3 avg = (c0 * w.x + c1 * w.y + c2 * w.z + c3 * w.w) / dot(w, vec4(1.0));
    // CoC: the nearest one when the quad straddles a near-field edge (keeps the foreground silhouette), else the mean
    float cmin = min(min(cocs.x, cocs.y), min(cocs.z, cocs.w));
    float coc = cmin < -1.0 ? cmin : dot(cocs, vec4(0.25));
    outColor = vec4(avg, coc);
}
