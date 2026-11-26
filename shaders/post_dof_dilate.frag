#version 450
// Miniature DOF pass 3 (tile resolution): neighbourhood max of the tile CoCs (d1.w tiles each way), so a pixel next to
// a blurred foreground object knows how far that object's bokeh reaches.
#extension GL_GOOGLE_include_directive : require
#include "dof.glsl"
layout(set = 2, binding = 0) uniform sampler2D tiles;
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
    int R = int(d1.w);
    ivec2 sz = textureSize(tiles, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 m = vec2(0.0);
    for (int y = -R; y <= R; ++y)
        for (int x = -R; x <= R; ++x) m = max(m, texelFetch(tiles, clamp(p + ivec2(x, y), ivec2(0), sz - 1), 0).rg);
    outColor = vec4(m, 0.0, 1.0);
}
