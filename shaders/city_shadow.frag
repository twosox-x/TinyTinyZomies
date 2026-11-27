#version 450
// Depth-only key-light shadow pass for city.vert casters drawn through CityRenderer::drawExternalShadow (lab props):
// like shadow_depth.frag, plus the voxel dissolve of deformed props (lab canopies), so their shadow dissolves too.
#extension GL_GOOGLE_include_directive : require
layout(location = 5) flat in float vDissolve;
layout(location = 6) in vec3 vCell;
#include "dissolve.glsl"
void main() {
    if (voxelDissolved(vCell, vDissolve)) discard;
}
