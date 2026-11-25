// Character rendering: shared buffer layouts and helpers. Requires common.glsl + zombie_parts.glsl.
#ifndef TTZ_CHAR_COMMON_GLSL
#define TTZ_CHAR_COMMON_GLSL

#define CHAR_MAX_CLASSES 16u
// charCounters layout (uint)
#define CC_VISIBLE      0u
#define CC_OVERFLOW     1u
#define CC_TRIANGLES    2u   // useful triangles of all visible segments
#define CC_SEGMENTS     3u
#define CC_VIS_AGENTS   4u
#define CC_VIS_CORPSES  5u
#define CC_VS_INVOC     6u   // vertex shader invocations incl. size-class padding
#define CC_CLASS_COUNT  16u  // + class
#define CC_CLASS_BASE   32u  // + class
#define CC_SIZE         48u
// charArgs layout (uint): per class 4 uints (vertexCount, instanceCount, firstVertex, firstInstance), then pose dispatch
#define CA_POSE_DISPATCH 64u
#define SEG_SKIP 0xFFFFFFFFu
#define REF_CORPSE 0x80000000u

// One visible body segment, 32 bytes: rotation (half4), world translation, mesh/slot, appearance.
struct SegInst {
    uvec4 a;   // x,y = packHalf2x16 quaternion, z = meshId (12) | slot << 12, w = appearance word
    vec4  b;   // xyz = world translation (m), w = character reference (uint bits)
};

// mesh id of a slot for a character's look (see LOOK LAYOUT in common.glsl, converter mesh order)
uint slotModule(uint lx, uint ly, uint slot) {
    if (slot == 0u) return lookBits(lx, 8u, 3u);
    if (slot == 1u) return lookBits(lx, 11u, 3u);
    if (slot == 2u) return lookBits(lx, 14u, 3u);
    if (slot == 3u) return lookBits(lx, 20u, 3u);
    if (slot == 4u) return lookBits(lx, 17u, 3u);
    if (slot == 5u) return lookBits(lx, 23u, 3u);
    if (slot == 6u) return lookBits(lx, 26u, 3u);
    if (slot == 7u) return lookBits(ly, 0u, 3u);
    if (slot == 8u) return lookBits(lx, 29u, 3u);
    return lookBits(ly, 3u, 3u);
}
uint lookSeedVar(uint lx, uint ly) { return pcgHash((lx >> 8) ^ (ly * 2246822519u)) & 3u; }
uint meshIdFor(uint lx, uint ly, uint slot) {
    uint m = slotModule(lx, ly, slot);
    uint stump = 0u;
    if (slot == 2u) stump = slotModule(lx, ly, 3u) == ZP_FOREARM_MISSING ? 1u : 0u;
    if (slot == 4u) stump = slotModule(lx, ly, 5u) == ZP_FOREARM_MISSING ? 1u : 0u;
    uint tier = lookBits(ly, 6u, 2u), decay = lookBits(ly, 8u, 2u);
    uint deco = tier == 0u ? 0u : 1u + (tier - 1u) * 16u + decay * 4u + lookSeedVar(lx, ly);
    return ZP_SLOT_BASE[slot] + (m * ZP_SLOT_STUMPS[slot] + stump) * uint(ZP_DECO_COUNT) + deco;
}
// appearance word for the fragment shader: palette (22 bits) | tier << 22 | torso << 24 | seedVar << 27
uint appearanceWord(uint lx, uint ly) {
    return (ly >> 10) | (lookBits(ly, 6u, 2u) << 22) | (lookBits(lx, 11u, 3u) << 24) | (lookSeedVar(lx, ly) << 27);
}
#endif
