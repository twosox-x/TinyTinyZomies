#ifndef TTZ_CHAR_UNIFORMS_GLSL
#define TTZ_CHAR_UNIFORMS_GLSL
layout(std140, set = 2, binding = 0) uniform CharUniforms {
    vec4  planes[6];   // frustum planes (xyz normal, w distance), inside: dot(n, p) + w >= 0
    vec4  cparams;     // x metres per voxel, y render time, z bounding radius (m), w bounding centre height (m)
    uvec4 ccfg;        // x mode (0 agents, 1 corpses), y visible capacity, z class count, w flags (1 cull, 2 pose in VS)
    uvec4 ccfg2;       // x forced animation (ANIM_*), y corpse capacity
};
#define CF_CULL 1u
#define CF_POSE_VS 2u
#endif
