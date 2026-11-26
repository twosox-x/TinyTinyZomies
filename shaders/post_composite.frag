#version 450
// Miniature ("tilt-shift") composite: sharp scene vs. half-resolution blur, mixed by a circle of confusion from the
// depth term the scene shaders wrote into alpha (1 = at the camera pivot distance, see finishA in lighting.glsl) and a
// vertical screen gradient (sharp band around the pivot row, blurred towards the top and bottom); then a small
// saturation / contrast boost (toy look).
layout(set = 2, binding = 0) uniform sampler2D sharpTex;
layout(set = 2, binding = 1) uniform sampler2D blurTex;
layout(std140, set = 3, binding = 0) uniform Post {
    vec4 p0;   // x strength (0 = off), y band centre (uv), z band half-width, w band softness
    vec4 p1;   // x saturation, y contrast, z depth-term weight, w vignette
};
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
    vec4 s = texture(sharpTex, vUv);
    vec3 col = s.rgb;
    if (p0.x > 0.0) {
        vec4 b = texture(blurTex, vUv);
        float grad = smoothstep(p0.z, p0.z + p0.w, abs(vUv.y - p0.y));
        // depth term: the sharp pixel's own weight, widened by the blurred one so in-focus edges over a blurred
        // background do not leave a sharp halo
        float depthC = max(1.0 - s.a, (1.0 - b.a) * 0.6) * p1.z;
        float coc = clamp(max(grad, depthC) * p0.x, 0.0, 1.0);
        col = mix(col, b.rgb, coc);
    }
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, p1.x);
    col = (col - 0.5) * p1.y + 0.5;
    vec2 v = vUv - 0.5;
    col *= 1.0 - p1.w * dot(v, v) * 1.6;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
