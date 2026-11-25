#pragma once
// Voxel character asset loaded from glTF/GLB (Blockbench export compatible).
// Body parts are identified by node name so the GPU can animate them procedurally:
//   0 body/torso, 1 head, 2 left arm, 3 right arm, 4 left leg, 5 right leg.
// Each vertex carries its part id and the part pivot (joint position, from the node transform).
#include <cstdint>
#include <string>
#include <vector>

namespace ttz {

enum PartId : int { PART_BODY = 0, PART_HEAD = 1, PART_ARM_L = 2, PART_ARM_R = 3, PART_LEG_L = 4, PART_LEG_R = 5 };

struct ModelVertex {
    float pos[3];
    float normal[3];
    float uv[2];
    float pivot[3];
    float part;
};
static_assert(sizeof(ModelVertex) == 48);

struct Model {
    std::vector<ModelVertex> vertices;
    std::vector<uint32_t> indices;
    std::vector<uint8_t> rgba;   // base colour texture (white 1x1 if none)
    int texW = 1, texH = 1;
    int variantRows = 1;         // texture holds N vertically stacked appearance variants
    float height = 0;

    // Loads a .glb/.gltf; rescales so the model is targetHeight tall with feet at y = 0.
    bool load(const std::string& path, float targetHeight);
};

int partIdFromName(const std::string& name);

} // namespace ttz
