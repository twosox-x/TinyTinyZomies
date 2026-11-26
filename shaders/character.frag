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
layout(location = 2) centroid in vec3 vRest;   // centroid: stays inside the face under MSAA
layout(location = 3) in float vAO;
layout(location = 4) flat in uvec4 vInfo;
layout(location = 0) out vec4 outColor;
// geometry level 3: merged faces span several materials; the voxel behind each fragment decides
layout(std430, set = 2, binding = 0) readonly buffer MeshVox { uvec4 meshVox[]; };   // tag byte offset, min*2+128, dims
layout(std430, set = 2, binding = 1) readonly buffer VoxTags { uint voxTags[]; };
layout(std430, set = 2, binding = 2) readonly buffer ShadowH { float shadowH[]; };
#include "shadow.glsl"
#define TAG_LOOKUP 31u

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
    uint ni = vInfo.z & 7u;
    // centre of the voxel behind this fragment, in rest-pose body space (exact: faces lie on the voxel grid)
    const vec3 NRM[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
    vec3 g = vec3(0.0, 0.5, (vInfo.z & 8u) != 0u ? 0.5 : 0.0);      // voxel-centre grid offsets of this body part
    vec3 ctr = round(vRest - NRM[ni] * 0.5 - g) + g;
    if (tag == TAG_LOOKUP) {
        uvec4 mv = meshVox[vInfo.w];
        vec3 mn = (vec3(float(mv.y & 255u), float((mv.y >> 8) & 255u), float((mv.y >> 16) & 255u)) - 128.0) * 0.5;
        uvec3 dims = uvec3(mv.z & 15u, (mv.z >> 4) & 15u, (mv.z >> 8) & 15u);
        // A fragment exactly on the outer edge of a merged face can round into the empty neighbour cell:
        // step back towards the face's own voxel along the tangent axis on which it sits on the boundary.
        vec3 f = (vRest - NRM[ni] * 0.5 - g) - (ctr - g);           // offset from the chosen centre, |f| <= 0.5
        vec3 step3 = sign(f) * step(vec3(0.45), abs(f)) * (1.0 - abs(NRM[ni]));
        vec3 cands[4] = vec3[4](ctr, ctr + vec3(step3.x, 0, 0), ctr + vec3(0, step3.y, 0), ctr + vec3(0, 0, step3.z));
        tag = 0xFFFFFFFFu;
        for (int k = 0; k < 4 && tag == 0xFFFFFFFFu; ++k) {
            uvec3 i = uvec3(clamp(ivec3(round(cands[k] - mn)), ivec3(0), ivec3(dims) - 1));
            uint b = mv.x + i.x + dims.x * (i.y + dims.y * i.z);
            tag = ((voxTags[b >> 2] >> ((b & 3u) * 8u)) & 255u) - 1u;
            if (tag != 0xFFFFFFFFu && k > 0) ctr = cands[k];
        }
    }
    vec3 N = normalize(vNormal);
    bool dead = (vInfo.z & (1u << 24)) != 0u;
    if (tag == TAG_EYE && !dead) {                // emissive, unlit (Zombie Lab: 0.55, 2.2, 0.45 linear)
        outColor = finishA(vec3(0.55, 2.2, 0.45), vWorld);
        return;
    }
    // dead eyes: dull, lit like the rest of the body
    vec3 albedo = tag == TAG_EYE ? vec3(0.05, 0.07, 0.045) : srgbToLinear(clamp(tagColorSRGB(tag, look), 0.0, 1.0));
    // per-voxel tonal noise, exactly Zombie Lab: voxel centre from the rest-pose surface position
    uint tier = (look >> 22) & 3u;
    float amp = tier == 0u ? 0.0 : (tier == 1u ? 0.07 : 0.13);
    if (amp > 0.0) albedo *= 1.0 + (labHash3(ctr, ZP_SEEDS[(look >> 27) & 3u]) - 0.5) * 2.0 * amp;
    // gore: raw flesh where a neighbouring segment was blown off (stumps and the cut ends of flying parts),
    // blood splashes on zombies hit by explosions (bloodiness 0..3)
    uint slot = (vInfo.z >> 4) & 15u, sev = (vInfo.z >> 8) & 0xFFFFu;
    if (sev != 0u) {
        float cut = 0.0;
        int par = (slot == 6u || slot == 8u) ? 1 : ZP_SLOT_PARENT[slot];      // legs hang from the torso's hips
        if (par >= 0 && (sev & (1u << uint(par))) != 0u) cut = max(cut, 1.0 - length(ctr - ZP_PIVOT[slot]) / 1.4);
        for (uint c = 0u; c < 10u; ++c)
            if ((ZP_SLOT_PARENT[c] == int(slot) || (slot == 1u && (c == 6u || c == 8u))) && (sev & (1u << c)) != 0u)
                cut = max(cut, 1.0 - length(ctr - ZP_PIVOT[c]) / 1.4);
        if (cut > 0.0) {
            float h = labHash3(ctr, 0x9E3779B9u);
            albedo = srgbToLinear(h < 0.35 ? ZP_FIXED[TAG_BLOOD - TAG_BLOOD] : (h < 0.7 ? ZP_FIXED[TAG_MEAT - TAG_BLOOD] : ZP_FIXED[TAG_GORE - TAG_BLOOD]));
            if (cut > 0.5 && h > 0.85) albedo = srgbToLinear(ZP_FIXED[TAG_BONE - TAG_BLOOD]);
        }
    }
    uint bloodLvl = (look >> 29) & 3u;
    if (bloodLvl > 0u) {
        float h = labHash3(ctr, 0x5BD1E995u ^ ZP_SEEDS[(look >> 27) & 3u]);
        float hs = labHash3(floor(ctr * 0.5) * 2.0, 0x27D4EB2Fu);                 // splashes cover small clusters
        if (h * 0.55 + hs * 0.45 < 0.11 * float(bloodLvl))
            albedo = srgbToLinear(h < 0.06 * float(bloodLvl) ? ZP_FIXED[TAG_BLOOD_DARK - TAG_BLOOD] : ZP_FIXED[0]);
    }
    albedo *= vAO;
    vec3 col = shadeV(albedo * 2.0, N, vWorld, 1.0, moonVisibility(vWorld, N));
    vec3 V = normalize(camPos.xyz - vWorld);
    col += vec3(0.10, 0.12, 0.22) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * vAO;   // rim, as the previous renderer
    outColor = finishA(col, vWorld);
}
