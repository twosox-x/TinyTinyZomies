// Voxel dissolve (docs/MILITARY_ANIMS.md 2.3.3): every voxel gets a random threshold in [0, 1); it disappears once the
// dissolve value passes it. Shared by city.frag and city_shadow.frag, so shadows dissolve with the surface.
bool voxelDissolved(vec3 cell, float d) {
    if (d <= 0.0) return false;
    vec3 c = floor(cell);
    vec3 q = fract(c * vec3(0.1031, 0.1030, 0.0973) + 0.37);
    q += dot(q, q.yzx + 33.33);
    float h = fract((q.x + q.y) * q.z);
    return h < d * 1.0001;
}
