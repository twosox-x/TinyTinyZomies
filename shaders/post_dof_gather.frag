#version 450
// Miniature DOF pass 4 (half resolution): bokeh gather with a 49-tap disk kernel (centre + rings of 8, 16, 24) scaled to
// the local CoC, so the blur grows continuously with depth (no ring bands). Far field: a sample counts when both it and
// the centre pixel are blurred that much (min CoC, KinoBokeh) - in-focus foreground never bleeds into the background.
// Near field: every sample whose own CoC reaches the centre, weighted by 1 / its disc area (scatter-as-gather), so a
// blurred foreground object spreads over in-focus pixels with the right coverage (alpha) and no hard silhouette.
// The kernel radius comes from the dilated tile max of the near CoC; an optional hexagonal aperture (d1.y) shapes the
// bokeh discs.
#extension GL_GOOGLE_include_directive : require
#include "dof.glsl"
layout(set = 2, binding = 0) uniform sampler2D pre;     // half-res scene-linear colour, a = signed CoC (half px)
layout(set = 2, binding = 1) uniform sampler2D tiles;   // dilated tile max: r near CoC
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 outBg;   // far field: rgb colour, a = centre CoC
layout(location = 1) out vec4 outFg;   // near field: rgb colour, a = coverage
const int RINGS = 3;
const float PI = 3.14159265;
float apertureScale(float ang) {   // 1 = circle; hexagon (circumradius 1) blended in by d1.y
    float seg = PI / 3.0;
    float a = mod(ang - d2.x, seg) - seg * 0.5;
    return mix(1.0, cos(seg * 0.5) / cos(a), d1.y);
}
void main() {
    vec4 c0 = texture(pre, vUv);
    float coc0 = c0.a;
    float nearMax = texture(tiles, vUv).r;
    float R = min(max(abs(coc0), nearMax), d0.x);
    if (R < 0.5) { outBg = c0; outFg = vec4(c0.rgb, 0.0); return; }
    vec2 texel = vec2(d0.y, d0.z);
    float spacing = R / float(RINGS);
    float m = spacing * 0.5 + 0.5;   // coverage edge softness (px)
    float N = 1.0 + 4.0 * float(RINGS * (RINGS + 1));   // 49 taps
    float areaK = R * R / N;          // sample footprint (px^2) / pi

    vec4 bg = vec4(c0.rgb, 1.0);
    vec4 fg = vec4(0.0);
    float fgA = 0.0;
    {   // centre sample in the near field
        float nc = -coc0;
        if (nc > 0.5) {
            float a = areaK / max(nc * nc, 1.0) * smoothstep(0.5, 2.0, nc);
            fg += vec4(c0.rgb, 1.0) * a;
            fgA += a;
        }
    }
    for (int k = 1; k <= RINGS; ++k) {
        float rho = spacing * float(k);
        int n = 8 * k;
        float step = 2.0 * PI / float(n);
        float ang = float(k) * 0.37;   // stagger the rings
        vec2 dir = vec2(cos(ang), sin(ang));
        mat2 rot = mat2(cos(step), sin(step), -sin(step), cos(step));   // tap direction advances by rotation
        for (int i = 0; i < n; ++i, ang += step, dir = rot * dir) {
            vec2 o = dir * (rho * (d1.y > 0.0 ? apertureScale(ang) : 1.0));
            vec4 s = texture(pre, vUv + o * texel);
            float cs = s.a;
            float wb = clamp((max(min(coc0, cs), 0.0) - rho + m) / m, 0.0, 1.0);
            bg += vec4(s.rgb, 1.0) * wb;
            float nc = -cs;
            float wf = clamp((nc - rho + m) / m, 0.0, 1.0) * smoothstep(0.5, 2.0, nc);
            float a = wf * areaK / max(nc * nc, 1.0);
            fg += vec4(s.rgb, 1.0) * a;
            fgA += a;
        }
    }
    outBg = vec4(bg.rgb / bg.a, coc0);
    outFg = vec4(fg.a > 1e-5 ? fg.rgb / fg.a : c0.rgb, clamp(fgA, 0.0, 1.0));
}
