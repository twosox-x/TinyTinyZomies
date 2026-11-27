// Per-frame graphics uniforms (pushed to vertex slot 0 and fragment slot 0).
// Must match FrameUniforms in src/render/Renderer.h. Define FRAME_SET (1 = vertex, 3 = fragment) first.
#ifndef TTZ_FRAME_GLSL
#define TTZ_FRAME_GLSL
#define MAX_LIGHTS 24
#define MAX_BLASTS 8
layout(std140, set = FRAME_SET, binding = 0) uniform Frame {
    mat4  viewProj;
    vec4  camPos;       // xyz, w = time (s)
    vec4  sunDir;       // xyz towards the key light (sun by day, moon by night), w DOF focus distance
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
    vec4  todP;         // time of day: x night 0..1 (windows / lamp lenses), y fire-light gain, z 1 = moon is the key light, w hours
    mat4  shadowVP;     // world -> key-light (sun / moon) shadow map clip space
    vec4  shadowP;      // x 1 = shadow map on, y metres per texel, z depth bias (clip units), w uv per texel
    vec4  dofP;         // x DOF in-focus band (zoom-adaptive, see RenderSettings::dofAt), yzw unused
};
#define DBG_DENSITY 1u
#define DBG_FLOW    2u
#define DBG_GRID    4u
#define DBG_NAVDIST 8u
#define DBG_CORPSEH 16u
#define GRID_CITY   64u   // baked city map: the ground pass only draws debug overlays / effects (city.frag shades the ground)
#endif
