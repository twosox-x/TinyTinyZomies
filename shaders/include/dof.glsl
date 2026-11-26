// Miniature depth of field (post_dof_*.frag): shared uniforms and colour helpers.
// Technique after KinoBokeh by Keijiro Takahashi / Unity Technologies (MIT, see THIRD_PARTY_NOTICES.md): half-resolution
// prefilter with CoC-weighted downsample, disk-kernel gather with separate near / far fields, tent post-filter, upsample
// and composite. Extended here with a thin-lens CoC encoded by the scene shaders (finishA in lighting.glsl), a tile max of
// the near-field CoC (so in-focus pixels gather blurred foreground; scatter-as-gather, Jimenez 2014), a kernel that
// scales with the local CoC (no ring banding), area-normalised near-field coverage, highlight boost for bokeh discs and a
// CoC-aware (bilateral) upsample.
#ifndef DOF_GLSL
#define DOF_GLSL
layout(std140, set = 3, binding = 0) uniform Dof {
    vec4 d0;   // x max CoC radius (half-res px), y half-res texel w (uv), z half-res texel h (uv), w highlight gain
    vec4 d1;   // x highlight threshold (display luma), y aperture shape (0 circle .. 1 hexagon), z tile size (half px), w dilate (tiles)
    vec4 d2;   // x hexagon rotation (rad), yzw unused
};
// alpha written by finishA: 0.5 + 0.5 * signed normalised CoC (negative = nearer than the focus distance)
float decodeCoc(float a) { return (a * 2.0 - 1.0) * d0.x; }
// display (gamma, rolled-off) colour -> scene-linear, undoing finish() in lighting.glsl
vec3 toLinear(vec3 c) {
    vec3 l = pow(clamp(c, 0.0, 1.0), vec3(2.2));
    return l / max(vec3(1.0) - 0.3 * l, vec3(0.3));
}
vec3 toDisplay(vec3 c) {
    c = max(c, vec3(0.0));
    return pow(clamp(c / (1.0 + c * 0.3), 0.0, 1.0), vec3(1.0 / 2.2));
}
#endif
