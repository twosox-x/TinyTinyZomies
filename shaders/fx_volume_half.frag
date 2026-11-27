#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel fx volumes at reduced resolution (offscreen, far faces: the camera is inside the box). Also writes the hit
// voxel for fx_composite.frag. See include/fx_volume_frag.glsl.
#define FX_HALF
#include "fx_volume_frag.glsl"
