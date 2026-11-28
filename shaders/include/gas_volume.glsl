// Corpse gas voxel fog (owner round 15 item 10: "same style voxel-art gas clouds" as the explosion / flame volumes):
// shared by gas_volume.vert / gas_volume.frag. One box per active gas region (CorpseGasRender: the gas cells of a
// 16 m world tile with gas, inflated, snapped to the 1 m world grid so the voxel grid of neighbouring boxes lines up).
// Must match GasVolumeUniforms in src/game/CorpseGasRender.cpp. Define GAS_SET (1 vertex, 3 fragment) first.
#ifndef TTZ_GAS_VOLUME_GLSL
#define TTZ_GAS_VOLUME_GLSL
#define MAX_GAS_BOXES 32
layout(std140, set = GAS_SET, binding = 1) uniform GasVolumes {
    vec4 gLo[MAX_GAS_BOXES];   // xyz box min (m), w street level: the lowest ground under the gas (m)
    vec4 gHi[MAX_GAS_BOXES];   // xyz box max (m)
    vec4 gOrigin;              // x originX, y originZ, z gas cell (m), w sim cell (m)
    uvec4 gDim;                // x gasW, y gasH, z simW, w simH
    vec4 gStyle;               // x opacity scale, y time (s), z voxel size per metre of distance (0 = 0.25 m), w max alpha
};
#endif
