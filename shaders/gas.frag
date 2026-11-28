#version 450
#extension GL_GOOGLE_include_directive : require
// Corpse gas puffs / flies / ground fire (gas.vert). Translucent haze is blended over the scene; the destination alpha
// (depth of field circle of confusion) is kept by the pipeline's blend state.
#define FRAME_SET 3
#include "frame.glsl"
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in vec4 vColor;
layout(location = 3) flat in float vEmissive;
layout(location = 0) out vec4 outColor;
void main() {
    // haze: lit, plus a faint sickly glow so it still reads at dusk / night
    // puffs: face-shaded voxels (top lighter, sides darker: reads as volume, not a flat overlay) + a sickly glow
    float face = vNormal.y > 0.5 ? 1.0 : (vNormal.y < -0.5 ? 0.7 : 0.85);
    vec3 col = vEmissive > 0.5 ? vColor.rgb : shade(vColor.rgb * 1.6 * face, normalize(vNormal), vWorld, 1.0) + vColor.rgb * 0.3 * face * step(vColor.a, 0.99);
    outColor = vec4(finish(col, vWorld), vColor.a);
}
