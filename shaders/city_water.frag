#version 450
// Water, voxel style (matches the miniature voxel city): the surface is shaded per 0.5 m grid cell, like the tops of
// voxel columns. Per cell: the shore distance at the cell centre picks one of four posterised depth bands (olive
// shallows -> deep blue-green), ripple normals sampled at the cell centre (each cell is a flat, tilted tile: blocky
// ripple highlights), sun / moon / lamp glints quantised to on/off cells, and foam as whole cells along the shore
// (a broken one- to two-cell rim that flickers in steps). Faint cell seams keep the grid readable up close; cell detail
// fades with distance so far water does not shimmer.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 0
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in float vShore;
layout(location = 0) out vec4 outColor;

const float CELL = 0.5;          // m: water "voxel" size (the city's ground raster is 0.1 m, buildings 0.25 m)

vec2 waveGrad(vec2 p, float t) {
    vec2 g = vec2(0.0);
    const vec2 D[4] = vec2[](vec2(0.94, 0.34), vec2(-0.45, 0.89), vec2(0.71, -0.70), vec2(0.20, 0.98));
    const float F[4] = float[](0.35, 0.62, 1.05, 1.7);
    const float A[4] = float[](0.060, 0.045, 0.030, 0.018);
    for (int i = 0; i < 4; ++i) {
        float ph = dot(D[i], p) * F[i] + t * sqrt(9.8 * F[i]) * 0.45;
        g += D[i] * (A[i] * F[i] * cos(ph));
    }
    return g;
}
void main() {
    float t = camPos.w;
    vec3 V = normalize(camPos.xyz - vWorld);
    float dist = length(camPos.xyz - vWorld);
    float near = 1.0 - clamp((dist - 60.0) / 260.0, 0.0, 1.0);        // cell detail fades out from 60 to 320 m

    // ---- the cell and the shore distance at its centre (sd is ~linear over a 2 m quad: extrapolate with its gradient)
    vec2 cell = floor(vWorld.xz / CELL);
    vec2 cc = (cell + 0.5) * CELL;
    vec2 dx = dFdx(vWorld.xz), dy = dFdy(vWorld.xz);
    float sx = dFdx(vShore), sy = dFdy(vShore);
    float det = dx.x * dy.y - dx.y * dy.x;
    vec2 gsd = abs(det) > 1e-9 ? vec2(sx * dy.y - sy * dx.y, sy * dx.x - sx * dy.x) / det : vec2(0.0);
    gsd = clamp(gsd, vec2(-2.0), vec2(2.0));
    float sd = vShore + dot(gsd, cc - vWorld.xz);
    float h0 = hash12(cell * 1.37 + 11.0);

    // ---- posterised depth bands
    float depth = clamp((sd + 0.4) / 7.0, 0.0, 1.0);
    float bandIx = min(3.0, floor(sqrt(depth) * 4.0 + (h0 - 0.5) * 0.35 * near));   // dithered band edges, one cell at a time
    const vec3 BAND[4] = vec3[](vec3(0.085, 0.092, 0.060), vec3(0.050, 0.068, 0.058), vec3(0.026, 0.050, 0.056), vec3(0.014, 0.034, 0.048));
    vec3 body = BAND[int(bandIx)];

    // ---- blocky ripples: one normal per cell, stepped in time (8 Hz) so the tiles tilt like a stop-motion miniature
    float tq = floor(t * 8.0) / 8.0;
    vec2 g = waveGrad(cc, tq) * mix(0.45, 1.0, near);
    vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
    float lam = max(dot(N, sunDir.xyz), 0.0);
    lam = floor(lam * 4.0 + 0.5) / 4.0;                                  // posterised diffuse
    float cs = cloudShadow(vWorld);                                     // voxel cloud shadows (sun term only)
    vec3 col = body * (mix(groundColor.rgb, skyColor.rgb, 0.7) + sunColor.rgb * 0.3 * lam * cs);
    col += body * (pointLights(vWorld, vec3(0, 1, 0)) + lampLights(vWorld, vec3(0, 1, 0))) * 0.6;

    // Fresnel sky reflection, posterised
    vec3 R = reflect(-V, N);
    vec3 sky = mix(fogColor.rgb * 1.1, skyColor.rgb * 1.5, clamp(R.y * 1.6, 0.0, 1.0));
    float fr = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    fr = floor(clamp(fr, 0.0, 0.85) * 6.0 + 0.5) / 6.0;
    col = mix(col, sky, fr);

    // ---- glints: whole cells light up (sun / moon), and lamp streaks as cell runs
    float sp = pow(max(dot(R, normalize(sunDir.xyz)), 0.0), 60.0);
    col += sunColor.rgb * step(0.7, sp + 0.2 * (h0 - 0.5)) * 0.9 * cs;
    for (uint i = 0u; i < gridDim.z; ++i) {
        vec3 L = lightPos[i].xyz - vec3(cc.x, vWorld.y, cc.y);
        float d = length(L);
        float att = clamp(1.0 - d / (abs(lightPos[i].w) * 3.0), 0.0, 1.0);   // w < 0: sharp muzzle light
        if (att <= 0.0) continue;
        vec3 H = normalize(L / d + V);
        float s = pow(max(dot(N, H), 0.0), 40.0) * att;
        col += lightCol[i].rgb * lightCol[i].w * step(0.35, s) * 0.9 * att;
    }
    // sparse ripple caps: a few cells at a time catch the light, re-dealt 3 times a second
    float tick = floor(t * 3.0);
    float cap = step(0.993, hash12(cell + vec2(tick * 7.13, tick * 3.71))) * near * smoothstep(0.5, 2.5, sd);
    col = mix(col, sky * 1.15 + sunColor.rgb * 0.1, cap * 0.35);

    // ---- foam: whole cells along the shore (rim 1-2 cells wide, broken by hash, stepping at 2 Hz), a second sparse ring
    float ft = floor(t * 2.0);
    float hf = hash12(cell * 0.71 + vec2(ft * 1.3, -ft * 0.7));
    float rim = step(sd, 0.35 + 0.55 * h0) * step(0.18, hf);
    float ring = step(abs(sd - (1.25 + 0.35 * sin(t * 0.7 + cc.x * 0.05))), 0.25) * step(0.72, hf);
    float foam = max(rim, ring * 0.7) * mix(0.6, 1.0, near);
    vec3 foamCol = vec3(0.46, 0.49, 0.50) * (skyColor.rgb * 2.0 + sunColor.rgb * 0.6) + pointLights(vWorld, vec3(0, 1, 0)) * 0.35;
    col = mix(col, foamCol, foam * 0.8);

    // ---- cell seams (anti-aliased with the pixel footprint; vanish with distance)
    vec2 f = fract(vWorld.xz / CELL), w = fwidth(vWorld.xz / CELL) * 1.2;
    vec2 e = smoothstep(vec2(0.0), w, f) * smoothstep(vec2(0.0), w, 1.0 - f);
    float seam = 1.0 - min(e.x, e.y);
    col *= 1.0 - 0.10 * seam * near * clamp(1.0 - max(w.x, w.y) * 2.0, 0.0, 1.0);

    outColor = finishA(col, vWorld);
}
