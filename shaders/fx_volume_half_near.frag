#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel fx volumes at reduced resolution (offscreen, near faces, conservative depth). See include/fx_volume_frag.glsl.
#define FX_HALF
#define FX_NEAR
#include "fx_volume_frag.glsl"
