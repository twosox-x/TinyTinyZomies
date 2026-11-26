#version 450
// Fullscreen triangle for post-processing passes (no vertex input). vUv: top-left origin, like SDL GPU textures.
layout(location = 0) out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexIndex << 1) & 2), float(gl_VertexIndex & 2));
    vUv = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
