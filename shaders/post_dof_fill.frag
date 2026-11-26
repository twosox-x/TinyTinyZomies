#version 450
// Miniature DOF pass 5 (half resolution): 9-tap fill / post-filter at half the ring spacing of the gather kernel, closing
// the gaps between kernel taps so bright bokeh discs read as solid discs (KinoBokeh's tent post-filter, scaled to the
// CoC like Jimenez' second "fill" pass). The far-field fill only takes samples at least as blurred as the centre.
#extension GL_GOOGLE_include_directive : require
#include "dof.glsl"
layout(set = 2, binding = 0) uniform sampler2D bgTex;
layout(set = 2, binding = 1) uniform sampler2D fgTex;
layout(set = 2, binding = 2) uniform sampler2D tiles;
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outBg;
layout(location = 1) out vec4 outFg;
void main() {
    vec4 b0 = texture(bgTex, vUv);
    vec4 f0 = texture(fgTex, vUv);
    float R = min(max(abs(b0.a), texture(tiles, vUv).r), d0.x);
    float r = max(R / 6.0, 0.75);   // 3 rings -> half the ring spacing
    vec2 texel = vec2(d0.y, d0.z) * r;
    vec4 bg = vec4(b0.rgb, 1.0) * 2.0;
    vec4 fg = vec4(f0.rgb * f0.a, f0.a) * 2.0;   // premultiplied
    for (int i = 0; i < 8; ++i) {
        float ang = float(i) * 0.785398 + 0.3927;
        vec2 uv = vUv + vec2(cos(ang), sin(ang)) * texel;
        vec4 b = texture(bgTex, uv);
        float w = clamp(1.0 + min(b.a, b0.a) - b0.a, 0.0, 1.0) * step(0.0, b0.a);   // never pull sharper colour in
        bg += vec4(b.rgb, 1.0) * w;
        vec4 f = texture(fgTex, uv);
        fg += vec4(f.rgb * f.a, f.a);
    }
    outBg = vec4(bg.rgb / bg.a, b0.a);
    outFg = vec4(fg.a > 1e-5 ? fg.rgb / fg.a : f0.rgb, fg.a / 10.0);
}
