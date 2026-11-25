#ifndef TTZ_CHAR_UNIFORMS_GLSL
#define TTZ_CHAR_UNIFORMS_GLSL
layout(std140, set = 2, binding = 0) uniform CharUniforms {
    vec4  planes[6];   // frustum planes (xyz normal, w distance), inside: dot(n, p) + w >= 0
    vec4  cparams;     // x metres per voxel, y render time, z bounding radius (m), w bounding centre height (m)
    uvec4 ccfg;        // x mode (0 agents, 1 corpses, 2 gibs), y visible capacity, z class count, w flags (1 cull, 2 pose in VS)
    uvec4 ccfg2;       // x forced animation (ANIM_*), y corpse capacity, z occluder count, w gib capacity
    vec4  eye;         // camera position (occlusion test)
};
#define CF_CULL 1u
#define CF_POSE_VS 2u
#define CF_OCCLUSION 4u
#define CF_QUADS 8u      // indexed quads: mesh vertex counts are 4 per face
#endif
