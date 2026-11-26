#version 450
// Separable Gaussian (9 taps folded into 5 bilinear fetches) for the miniature depth-of-field. Run horizontally while
// downsampling to half resolution, then vertically. dir.xy: tap step in source uv.
layout(set = 2, binding = 0) uniform sampler2D src;
layout(std140, set = 3, binding = 0) uniform Blur { vec4 dir; };
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
    vec4 c = texture(src, vUv) * 0.2270270;
    vec2 o1 = dir.xy * 1.3846154, o2 = dir.xy * 3.2307692;
    c += (texture(src, vUv + o1) + texture(src, vUv - o1)) * 0.3162162;
    c += (texture(src, vUv + o2) + texture(src, vUv - o2)) * 0.0702703;
    outColor = c;
}
