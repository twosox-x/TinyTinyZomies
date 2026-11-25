#pragma once
// CPU encoder for the 56-bit modular appearance (LOOK LAYOUT in shaders/include/common.glsl).
// Used for the showcase / validation scenes; normal zombies are generated on the GPU at spawn.
#include <cstdint>

namespace ttz {

struct LookSpec {
    // module index per slot in Zombie Lab family order (see assets/characters/zombie_parts.json)
    uint32_t head = 0, torso = 0, upperArmL = 0, upperArmR = 0, forearmL = 0, forearmR = 0, thighL = 0, thighR = 0, shinL = 0, shinR = 0;
    uint32_t tier = 0, decayBucket = 0;
    uint32_t skin = 0, top = 0, shirt = 0, pants = 0, hair = 0, tie = 0, hat = 0, shoe = 0;   // palette indices
};

inline void encodeLook(const LookSpec& l, uint32_t& x, uint32_t& y) {
    x = (l.head << 8) | (l.torso << 11) | (l.upperArmL << 14) | (l.upperArmR << 17) | (l.forearmL << 20) | (l.forearmR << 23) |
        (l.thighL << 26) | (l.thighR << 29);
    y = l.shinL | (l.shinR << 3) | (l.tier << 6) | (l.decayBucket << 8) | (l.skin << 10) | (l.top << 13) | (l.shirt << 17) |
        (l.pants << 19) | (l.hair << 22) | (l.tie << 25) | (l.hat << 27) | (l.shoe << 30);
}

// The three Zombie Lab example designs (DESIGNS in assets/characters/source/zombie_lab_v3.html), exact
// module and palette choices. Decomposition 0.55 / 0.9 are baked buckets 1 / 3.
inline LookSpec labOfficeDrone() {
    LookSpec l; l.head = 1; l.torso = 1;                         // short_hair, shirt_tie, sleeves, trousers
    l.tier = 0; l.skin = 4; l.top = 3; l.shirt = 0; l.pants = 1; l.hair = 0; l.tie = 0; l.hat = 1; l.shoe = 2;
    return l;
}
inline LookSpec labStreetWalker() {
    LookSpec l; l.head = 3; l.torso = 2;                         // beanie, hoodie
    l.upperArmL = 2; l.forearmL = 2; l.upperArmR = 0; l.forearmR = 3;   // torn sleeve + bloody / sleeve + skinned
    l.thighL = 0; l.shinL = 0; l.thighR = 2; l.shinR = 3;        // trousers / torn
    l.tier = 1; l.decayBucket = 1; l.skin = 1; l.top = 0; l.shirt = 1; l.pants = 0; l.hair = 1; l.tie = 1; l.hat = 0; l.shoe = 0;
    return l;
}
inline LookSpec labRotter() {
    LookSpec l; l.head = 6; l.torso = 5;                         // jawless, ribcage
    l.upperArmL = 3; l.forearmL = 4; l.upperArmR = 4; l.forearmR = 5;   // muscle + bone forearm / bone + missing
    l.thighL = 3; l.shinL = 4; l.thighR = 4; l.shinR = 5;        // muscle + skinned / femur + bone
    l.tier = 2; l.decayBucket = 3; l.skin = 3; l.top = 2; l.shirt = 3; l.pants = 3; l.hair = 5; l.tie = 2; l.hat = 3; l.shoe = 1;
    return l;
}

} // namespace ttz
