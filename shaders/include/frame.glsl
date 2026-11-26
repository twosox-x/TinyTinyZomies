// Per-frame graphics uniforms (pushed to vertex slot 0 and fragment slot 0).
// Must match FrameUniforms in src/render/Renderer.h. Define FRAME_SET (1 = vertex, 3 = fragment) first.
#ifndef TTZ_FRAME_GLSL
#define TTZ_FRAME_GLSL
#define MAX_LIGHTS 24
#define MAX_BLASTS 8
layout(std140, set = FRAME_SET, binding = 0) uniform Frame {
    mat4  viewProj;
    vec4  camPos;       // xyz, w = time (s)
    vec4  sunDir;       // xyz towards the moon, w unused
    vec4  sunColor;
    vec4  skyColor;
    vec4  groundColor;
    vec4  fogColor;     // rgb, w = density
    vec4  gridP;        // originX, originZ, cellSize, invCellSize
    uvec4 gridDim;      // w, h, numLights, debug flags
    vec4  modelP;       // x variantRows, y modelHeight, z standHeight, w proneHeight
    vec4  goalsF[4];    // xz goal, w active
    vec4  blasts[MAX_BLASTS];     // xyz, w age (s), < 0 inactive
    vec4  lightPos[MAX_LIGHTS];   // xyz, w radius
    vec4  lightCol[MAX_LIGHTS];   // rgb, w intensity
    vec4  blastsP[MAX_BLASTS];    // x effect scale (1 car / grenade, 2.2 fuel tanker), yzw unused
};
#define DBG_DENSITY 1u
#define DBG_FLOW    2u
#define DBG_GRID    4u
#define DBG_NAVDIST 8u
#define DBG_CORPSEH 16u
#define GRID_CITY   64u   // baked city map: the ground pass only draws debug overlays / effects (city.frag shades the ground)
#endif
