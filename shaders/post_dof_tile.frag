#version 450
// Miniature DOF pass 2 (half -> tile resolution, tile = d1.z half-res px): the largest near-field CoC in the tile.
#extension GL_GOOGLE_include_directive : require
#include "dof.glsl"
layout(set = 2, binding = 0) uniform sampler2D pre;   // prefiltered half-res colour, a = signed CoC
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;   // r max near CoC (positive px), g max |CoC|
void main() {
    int T = int(d1.z);
    ivec2 sz = textureSize(pre, 0);
    ivec2 base = ivec2(gl_FragCoord.xy) * T;
    float nearMax = 0.0, absMax = 0.0;
    for (int y = 0; y < T; ++y)
        for (int x = 0; x < T; ++x) {
            float c = texelFetch(pre, min(base + ivec2(x, y), sz - 1), 0).a;
            nearMax = max(nearMax, -c);
            absMax = max(absMax, abs(c));
        }
    outColor = vec4(nearMax, absMax, 0.0, 1.0);
}
