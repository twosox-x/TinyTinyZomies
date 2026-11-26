#version 450
#extension GL_GOOGLE_include_directive : require
// Voxel explosion / fire volumes, near faces (the camera is outside the box): conservative depth keeps early-Z.
#define FX_NEAR
#include "fx_volume_frag.glsl"
