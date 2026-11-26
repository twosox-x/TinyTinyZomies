#version 450
// Miniature composite (full resolution): the sharp scene, the half-resolution far-field bokeh (CoC-aware bilateral
// upsample: half-res texels whose CoC differs from this pixel's full-res CoC are rejected, so blurred background does not
// ghost over in-focus edges) and the near-field bokeh layered on top by its coverage. Blending happens in scene-linear
// colour so boosted highlights (bokeh discs) roll off like the scene shaders' tone curve. Then the miniature grade: a
// small saturation / contrast boost and vignette.
layout(set = 2, binding = 0) uniform sampler2D sharpTex;   // rgb display colour, a = CoC code (finishA)
layout(set = 2, binding = 1) uniform sampler2D bgTex;      // half-res far field: rgb linear, a = CoC (half px)
layout(set = 2, binding = 2) uniform sampler2D fgTex;      // half-res near field: rgb linear, a = coverage
layout(std140, set = 3, binding = 0) uniform Post {
    vec4 p0;   // x DOF strength (0 = off), y max CoC (half px), z debug view (1 = CoC), w unused
    vec4 p1;   // x saturation, y contrast, z unused, w vignette
};
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
vec3 toLinear(vec3 c) {
    vec3 l = pow(clamp(c, 0.0, 1.0), vec3(2.2));
    return l / max(vec3(1.0) - 0.3 * l, vec3(0.3));
}
vec3 toDisplay(vec3 c) {
    c = max(c, vec3(0.0));
    return pow(clamp(c / (1.0 + c * 0.3), 0.0, 1.0), vec3(1.0 / 2.2));
}
void main() {
    vec4 s = texture(sharpTex, vUv);
    vec3 col = s.rgb;
    if (p0.x > 0.0) {
        float coc = (s.a * 2.0 - 1.0) * p0.y;
        vec3 lin = toLinear(col);
        // bilateral upsample of the far field
        ivec2 hs = textureSize(bgTex, 0);
        vec2 pos = vUv * vec2(hs) - 0.5;
        ivec2 i0 = ivec2(floor(pos));
        vec2 f = pos - vec2(i0);
        vec4 acc = vec4(0.0);
        for (int y = 0; y < 2; ++y)
            for (int x = 0; x < 2; ++x) {
                vec4 b = texelFetch(bgTex, clamp(i0 + ivec2(x, y), ivec2(0), hs - 1), 0);
                float wb = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
                float wd = 1.0 / (0.3 + abs(b.a - coc));
                acc += vec4(b.rgb, 1.0) * (wb * wd + 1e-4);
            }
        vec3 bg = acc.rgb / acc.a;
        lin = mix(lin, bg, smoothstep(0.25, 1.0, coc) * p0.x);
        // near field: its coverage spreads blurred foreground over whatever lies behind; a near pixel itself always takes
        // its blurred colour (else silhouettes of near objects would stay sharper than their insides)
        vec4 fg = texture(fgTex, vUv);
        lin = mix(lin, fg.rgb, max(fg.a, smoothstep(0.25, 1.0, -coc)) * p0.x);
        col = toDisplay(lin);
        if (p0.z > 0.5) {   // debug: CoC (red = near field, blue = far field, black = in focus)
            float c = clamp(coc / p0.y, -1.0, 1.0);
            col = mix(col * 0.25, vec3(max(-c, 0.0), 0.0, max(c, 0.0)), 0.85);
        }
    }
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, p1.x);
    col = (col - 0.5) * p1.y + 0.5;
    vec2 v = vUv - 0.5;
    col *= 1.0 - p1.w * dot(v, v) * 1.6;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
