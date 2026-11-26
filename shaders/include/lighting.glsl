// Lighting: hemispheric ambient, key light (warm sun by day, cool moon by night; TimeOfDay.h), warm point lights,
// explosion flashes (stronger at night, todP.y), fog.
#ifndef TTZ_LIGHTING_GLSL
#define TTZ_LIGHTING_GLSL
vec3 pointLights(vec3 P, vec3 N) {
    vec3 c = vec3(0.0);
    for (uint i = 0u; i < gridDim.z; ++i) {
        vec3 L = lightPos[i].xyz - P;
        float d = length(L);
        float att = clamp(1.0 - d / lightPos[i].w, 0.0, 1.0);
        att *= att;
        c += lightCol[i].rgb * lightCol[i].w * att * (0.25 + 0.75 * max(dot(N, L / max(d, 1e-3)), 0.0));
    }
    // explosions: a short intense white flash (~0.1 s), then a flickering orange fire light that rises with the
    // fireball and fades (~1.5 s x sqrt(scale)); blastsP.x = effect scale (1 car, 2.2 fuel tanker)
    for (int i = 0; i < MAX_BLASTS; ++i) {
        float age = blasts[i].w;
        float s = max(blastsP[i].x, 0.1), ss = sqrt(s);
        float fireDur = 1.6 * ss;
        if (age < 0.0 || age > fireDur) continue;
        vec3 L = blasts[i].xyz + vec3(0.0, 1.5 + 1.2 * age * ss, 0.0) - P;
        float d = length(L);
        float flash = age < 0.1 ? 1.0 - age / 0.1 : 0.0;
        float fire = smoothstep(0.0, 0.06, age) * (1.0 - age / fireDur);
        fire *= fire * (0.75 + 0.25 * sin(age * 41.0 + float(i) * 2.1) * sin(age * 23.0 + 1.3));
        float attF = clamp(1.0 - d / (20.0 * ss), 0.0, 1.0), attR = clamp(1.0 - d / (15.0 * ss), 0.0, 1.0);
        float lam = max(dot(N, L / max(d, 1e-3)), 0.15);
        c += (vec3(1.0, 0.88, 0.7) * 5.0 * flash * attF * attF + vec3(1.0, 0.42, 0.1) * 2.6 * fire * attR * attR) * ss * lam * todP.y;
    }
    return c;
}
// Street lamps (CityRenderer::rebuildLampGrid): every lamp of the resident city tiles, looked up in a world-space grid of
// 8 m cells. A lamp is a downward pool (sodium orange / LED white): smooth inverse-square falloff windowed to the grid
// radius, a soft cone (bright under the head, dimmer sideways onto lower facades), on with the night factor todP.x.
// Shaders opt in with #define LAMP_GRID_BINDING <set 2 storage binding> before including this file.
#ifdef LAMP_GRID_BINDING
layout(std430, set = 2, binding = LAMP_GRID_BINDING) readonly buffer LampGrid { uint lampGrid[]; };
vec3 lampLights(vec3 P, vec3 N) {
    uint W = lampGrid[0], H = lampGrid[1];
    if (W == 0u || todP.x <= 0.002) return vec3(0.0);
    vec2 o = vec2(uintBitsToFloat(lampGrid[4]), uintBitsToFloat(lampGrid[5]));
    float inv = uintBitsToFloat(lampGrid[6]), R = uintBitsToFloat(lampGrid[7]), gain = uintBitsToFloat(lampGrid[8]);
    ivec2 c = ivec2(floor((P.xz - o) * inv));
    if (c.x < 0 || c.y < 0 || c.x >= int(W) || c.y >= int(H)) return vec3(0.0);
    uint ci = 12u + 2u * (uint(c.y) * W + uint(c.x));
    uint first = lampGrid[ci], cnt = min(lampGrid[ci + 1u], 32u);
    uint lampOff = lampGrid[2], idxOff = lampGrid[3];
    vec3 acc = vec3(0.0);
    for (uint k = 0u; k < cnt; ++k) {
        uint li = lampOff + 4u * lampGrid[idxOff + first + k];
        vec3 Lp = vec3(uintBitsToFloat(lampGrid[li]), uintBitsToFloat(lampGrid[li + 1u]), uintBitsToFloat(lampGrid[li + 2u]));
        vec4 col = unpackUnorm4x8(lampGrid[li + 3u]);
        vec3 L = Lp - P;
        float d2 = dot(L, L);
        float x = d2 / (R * R);
        if (x >= 1.0) continue;
        float win = (1.0 - x * x);
        float att = win * win * 26.0 / (d2 + 5.0);                   // ~ inverse square, soft core (lamp ~5.5 m up)
        vec3 l = L * inversesqrt(max(d2, 1e-4));
        float cone = mix(0.07, 1.0, smoothstep(0.35, 0.9, l.y));     // l.y: how far the lamp is above the point (pool ~6 m)
        acc += col.rgb * (col.a * att * cone * (0.15 + 0.85 * max(dot(N, l), 0.0)));
    }
    return acc * gain * todP.x;
}
#else
vec3 lampLights(vec3 P, vec3 N) { return vec3(0.0); }
#endif
// vis: key-light visibility (1 lit, 0 in shadow), see shadow.glsl
vec3 shadeV(vec3 albedo, vec3 N, vec3 P, float ao, float vis) {
    vec3 hemi = mix(groundColor.rgb, skyColor.rgb, N.y * 0.5 + 0.5) * ao;
    vec3 key = sunColor.rgb * max(dot(N, sunDir.xyz), 0.0) * vis;
    return albedo * (hemi + key + pointLights(P, N) + lampLights(P, N));
}
vec3 shade(vec3 albedo, vec3 N, vec3 P, float ao) { return shadeV(albedo, N, P, ao, 1.0); }
// Fog (fogColor.w density per metre, starting groundColor.w metres from the eye, capped so distant blocks keep their
// colours), exposure (sunColor.w, 0 = 1) and a soft highlight roll-off; returns display (gamma) colour.
vec3 finish(vec3 col, vec3 P) {
    float d = length(P - camPos.xyz);
    float f = (1.0 - exp(-fogColor.w * max(d - groundColor.w, 0.0))) * 0.7;
    col = mix(col, fogColor.rgb, clamp(f, 0.0, 1.0));
    col *= sunColor.w > 0.0 ? sunColor.w : 1.0;
    col = col / (1.0 + col * 0.3);          // soft highlight roll-off
    return pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
}
// finish() plus the miniature depth of field's circle of confusion in alpha: thin lens focused at sunDir.w (the RTS
// pivot distance), CoC = aperture * (d - focus) / d (skyColor.w = aperture in units of the max blur radius, 0 = off),
// stored as 0.5 + 0.5 * clamp(CoC, -1, 1) (below 0.5 = near field). See shaders/post_dof_*.frag.
vec4 finishA(vec3 col, vec3 P) {
    float d = max(length(P - camPos.xyz), 1e-3);
    float coc = clamp(skyColor.w * (d - sunDir.w) / d, -1.0, 1.0);
    return vec4(finish(col, P), 0.5 + 0.5 * coc);
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
#endif
