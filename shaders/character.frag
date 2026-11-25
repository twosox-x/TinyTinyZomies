#version 450
#extension GL_GOOGLE_include_directive : require
// Zombie Lab material model: palette tag -> colour (per-zombie palette, sleeves follow the torso
// garment, Lab's dark/light multipliers), exact Lab per-voxel tonal noise (same hash, same seeds,
// tier amplitude), Lab ambient occlusion levels; emissive eyes. Lit with the engine's lighting.
#define FRAME_SET 3
#include "common.glsl"
#include "frame.glsl"
#include "lighting.glsl"
#include "zombie_parts.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) in vec3 vRest;
layout(location = 3) in float vAO;
layout(location = 4) flat in uvec4 vInfo;
layout(location = 0) out vec4 outColor;

vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
// Zombie Lab hash3 (Math.imul arithmetic == 32-bit unsigned wrap-around)
float labHash3(vec3 p, uint s) {
    uint h = uint(int(round(p.x * 2.0)) + 1000) * 73856093u ^ uint(int(round(p.y * 2.0)) + 1000) * 19349663u
           ^ uint(int(round(p.z * 2.0)) + 1000) * 83492791u ^ s;
    h = (h ^ (h >> 13)) * 1274126177u;
    return float(h ^ (h >> 16)) / 4294967296.0;
}
vec3 tagColorSRGB(uint tag, uint look) {
    uint skin = look & 7u, top = (look >> 3) & 15u, shirt = (look >> 7) & 3u, pants = (look >> 9) & 7u;
    uint hair = (look >> 12) & 7u, tie = (look >> 15) & 3u, hat = (look >> 17) & 7u, shoe = (look >> 20) & 3u;
    uint torso = (look >> 24) & 7u;
    if (tag == TAG_SLEEVE || tag == TAG_SLEEVE_DARK) {
        uint sl = ZP_TORSO_SLEEVE[torso];     // 0 cloth, 1 shirt, 2 skin
        bool dark = tag == TAG_SLEEVE_DARK;
        tag = sl == 0u ? (dark ? TAG_CLOTH_DARK : TAG_CLOTH) : sl == 1u ? (dark ? TAG_TOP2_DARK : TAG_TOP2) : (dark ? TAG_SKIN_DARK : TAG_SKIN);
    }
    if (tag == TAG_SKIN) return ZP_SKINS[skin];
    if (tag == TAG_SKIN_DARK) return ZP_SKINS[skin] * 0.74;
    if (tag == TAG_CLOTH) return ZP_TOPS[top];
    if (tag == TAG_CLOTH_DARK) return ZP_TOPS[top] * 0.7;
    if (tag == TAG_TOP2) return ZP_SHIRTS[shirt];
    if (tag == TAG_TOP2_DARK) return ZP_SHIRTS[shirt] * 0.75;
    if (tag == TAG_PANTS) return ZP_PANTS[pants];
    if (tag == TAG_PANTS_DARK) return ZP_PANTS[pants] * 0.72;
    if (tag == TAG_PANTS_LIGHT) return ZP_PANTS[pants] * 1.22;
    if (tag == TAG_HAIR) return ZP_HAIRS[hair];
    if (tag == TAG_TIE) return ZP_TIES[tie];
    if (tag == TAG_HAT) return ZP_HATS[hat];
    if (tag == TAG_HAT_DARK) return ZP_HATS[hat] * 0.72;
    if (tag == TAG_SHOE) return ZP_SHOES[shoe];
    if (tag >= TAG_BLOOD && tag <= TAG_BELT) return ZP_FIXED[tag - TAG_BLOOD];
    return vec3(1.0, 0.0, 1.0);
}
void main() {
    uint tag = vInfo.x, look = vInfo.y;
    vec3 N = normalize(vNormal);
    if (tag == TAG_EYE) {                         // emissive, unlit (Zombie Lab: 0.55, 2.2, 0.45 linear)
        outColor = vec4(finish(vec3(0.55, 2.2, 0.45), vWorld), 1.0);
        return;
    }
    vec3 albedo = srgbToLinear(clamp(tagColorSRGB(tag, look), 0.0, 1.0));
    // per-voxel tonal noise, exactly Zombie Lab: voxel centre from the rest-pose surface position
    uint tier = (look >> 22) & 3u;
    float amp = tier == 0u ? 0.0 : (tier == 1u ? 0.07 : 0.13);
    if (amp > 0.0) {
        const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
        vec3 q = vRest - NRM[vInfo.z] * 0.5;
        vec3 g = vec3(0.0, 0.5, vInfo.w == 1u ? 0.5 : 0.0);      // voxel-centre grid offsets of this body part
        vec3 ctr = round(q - g) + g;
        albedo *= 1.0 + (labHash3(ctr, ZP_SEEDS[(look >> 27) & 3u]) - 0.5) * 2.0 * amp;
    }
    albedo *= vAO;
    vec3 col = shade(albedo * 2.0, N, vWorld, 1.0);
    vec3 V = normalize(camPos.xyz - vWorld);
    col += vec3(0.10, 0.12, 0.22) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * vAO;   // rim, as the previous renderer
    outColor = vec4(finish(col, vWorld), 1.0);
}
