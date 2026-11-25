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
    for (int i = 0; i < MAX_BLASTS; ++i) {
        float age = blasts[i].w;
        if (age < 0.0 || age > 0.9) continue;
        vec3 L = blasts[i].xyz + vec3(0.0, 2.0, 0.0) - P;
        float d = length(L);
        float att = clamp(1.0 - d / 28.0, 0.0, 1.0);
        float k = (1.0 - age / 0.9);
        c += vec3(1.0, 0.55, 0.2) * 9.0 * k * k * att * att * max(dot(N, L / max(d, 1e-3)), 0.2);
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
vec3 finish(vec3 col, vec3 P) {
    float d = length(P - camPos.xyz);
    float f = 1.0 - exp(-fogColor.w * d);
    col = mix(col, fogColor.rgb, clamp(f, 0.0, 1.0));
    col = col / (1.0 + col * 0.35);          // soft highlight roll-off
    return pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
#endif
