// Night-time lighting: hemispheric ambient, cool moonlight, warm point lights, explosion flashes, fog.
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
        c += (vec3(1.0, 0.88, 0.7) * 5.0 * flash * attF * attF + vec3(1.0, 0.42, 0.1) * 2.6 * fire * attR * attR) * ss * lam;
    }
    return c;
}
// vis: moon visibility (1 lit, 0 in a building's shadow), see shadow.glsl
vec3 shadeV(vec3 albedo, vec3 N, vec3 P, float ao, float vis) {
    vec3 hemi = mix(groundColor.rgb, skyColor.rgb, N.y * 0.5 + 0.5) * ao;
    vec3 moon = sunColor.rgb * max(dot(N, sunDir.xyz), 0.0) * vis;
    return albedo * (hemi + moon + pointLights(P, N));
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
