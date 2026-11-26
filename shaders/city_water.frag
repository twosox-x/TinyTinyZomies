#version 450
// Water: colour from the depth (shore distance), a soft foam line at the bank, animated ripple normals (sums of
// travelling waves, flowing along +x), Fresnel reflection of the night sky, the moon glint and street-lamp streaks.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 0
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in float vShore;
layout(location = 0) out vec4 outColor;

vec2 waveGrad(vec2 p, float t) {
    vec2 g = vec2(0.0);
    const vec2 D[5] = vec2[](vec2(0.94, 0.34), vec2(-0.45, 0.89), vec2(0.71, -0.70), vec2(0.20, 0.98), vec2(-0.86, -0.51));
    const float F[5] = float[](0.55, 0.9, 1.6, 2.7, 4.1);
    const float A[5] = float[](0.040, 0.028, 0.018, 0.010, 0.006);
    for (int i = 0; i < 5; ++i) {
        float ph = dot(D[i], p) * F[i] + t * sqrt(9.8 * F[i]) * 0.55;
        g += D[i] * (A[i] * F[i] * cos(ph));
    }
    return g;
}
float vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
void main() {
    float t = camPos.w;
    float sd = vShore;
    vec3 V = normalize(camPos.xyz - vWorld);
    float dist = length(camPos.xyz - vWorld);
    // ripples (fade the fine detail with distance against aliasing)
    vec2 g = waveGrad(vWorld.xz, t) * mix(1.0, 0.35, clamp(dist / 250.0, 0.0, 1.0));
    vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
    // depth tint: shallow olive-brown at the bank -> deep blue-green
    float depth = clamp((sd + 0.6) / 6.0, 0.0, 1.0);
    vec3 shallow = vec3(0.075, 0.085, 0.055), deep = vec3(0.012, 0.03, 0.045);
    vec3 body = mix(shallow, deep, sqrt(depth));
    vec3 col = body * (mix(groundColor.rgb, skyColor.rgb, 0.7) + sunColor.rgb * 0.25 * max(dot(N, sunDir.xyz), 0.0));
    // diffuse lamp light on the water body (weak)
    col += body * (pointLights(vWorld, vec3(0, 1, 0)) + lampLights(vWorld, vec3(0, 1, 0))) * 0.6;
    // Fresnel sky reflection
    vec3 R = reflect(-V, N);
    vec3 sky = mix(fogColor.rgb * 1.1, skyColor.rgb * 1.5, clamp(R.y * 1.6, 0.0, 1.0));
    float fr = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = mix(col, sky, clamp(fr, 0.0, 0.85));
    // moon glint
    float sp = pow(max(dot(R, normalize(sunDir.xyz)), 0.0), 180.0);
    col += sunColor.rgb * sp * 2.5;
    // street lamps / windows: Blinn-Phong streaks of the nearest point lights
    for (uint i = 0u; i < gridDim.z; ++i) {
        vec3 L = lightPos[i].xyz - vWorld;
        float d = length(L);
        float att = clamp(1.0 - d / (lightPos[i].w * 3.0), 0.0, 1.0);
        if (att <= 0.0) continue;
        vec3 H = normalize(L / d + V);
        col += lightCol[i].rgb * lightCol[i].w * att * pow(max(dot(N, H), 0.0), 90.0) * 1.6;
    }
    // foam: a soft broken line where the water meets the bank (bank meets the surface near sd = -0.55)
    float n = vnoise2(vWorld.xz * 1.3 + vec2(t * 0.25, t * 0.1)) * 0.6 + vnoise2(vWorld.xz * 3.7 - vec2(t * 0.4, 0.0)) * 0.4;
    float band = 1.0 - smoothstep(-0.2, 0.9 + 0.6 * n, sd);
    float foam = band * smoothstep(0.35, 0.75, n + band * 0.35);
    col = mix(col, vec3(0.42, 0.45, 0.46) * (skyColor.rgb * 2.0 + sunColor.rgb * 0.6) + pointLights(vWorld, vec3(0, 1, 0)) * 0.35, foam * 0.75);
    outColor = finishA(col, vWorld);
}
