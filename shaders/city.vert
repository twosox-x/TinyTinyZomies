#version 450
// Baked city geometry (tiles, vehicles, street furniture). Vertex layout = FORMAT.md section 2 (12 bytes):
// SHORT4 (quantised xyz, w = vertex flags: bit 0 body paint), BYTE4 (normal * 127, w = material id).
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 1
#include "frame.glsl"
layout(location = 0) in ivec4 inPos;
layout(location = 1) in ivec4 inNrm;
layout(std140, set = 1, binding = 1) uniform CityDraw {
    vec4 origin;      // xyz: world (tiles) or model (instances) position of quantised 0
    vec4 qscale;      // x metres per unit in x / z, y in y
    uvec4 mode;       // x: 0 tile, 1 instanced model; y: first instance
};
struct Inst { vec4 pos; vec4 quat; vec4 paint; };   // pos.w kind (0 vehicle, 1 prop); paint.w tint / signal phase
layout(std430, set = 0, binding = 0) readonly buffer Insts { Inst inst[]; };
layout(location = 0) out vec3 vWorld;
layout(location = 1) out vec3 vNormal;
layout(location = 2) flat out uint vMat;
layout(location = 3) flat out vec4 vPaint;   // rgb, w = 1 paint this vertex
layout(location = 4) flat out float vPhase;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
    vec3 p = origin.xyz + vec3(inPos.xyz) * qscale.xyx;
    vec3 n = vec3(inNrm.xyz) * (1.0 / 127.0);
    vMat = uint(inNrm.w) & 255u;
    vPaint = vec4(0.0);
    vPhase = 0.0;
    if (mode.x == 1u) {
        Inst I = inst[mode.y + uint(gl_InstanceIndex)];
        if (I.pos.w > 1.5) {   // deformed prop (parachute canopy, docs/MILITARY_ANIMS.md 2.3): xz radial / y height scale
            vec2 sh = unpackHalf2x16(floatBitsToUint(I.paint.z));   // shear x, z (collapse drift), proportional to height
            p = I.pos.xyz + qrot(I.quat, vec3(p.x * I.paint.x + sh.x * p.y, p.y * I.paint.y, p.z * I.paint.x + sh.y * p.y));
            float x = (p.y - I.paint.w) / 0.08;   // soft ground clamp (paint.w = surface height, < -1000 off)
            if (I.paint.w > -1000.0 && x < 20.0) p.y = I.paint.w + 0.08 * log(1.0 + exp(x));
        } else p = I.pos.xyz + qrot(I.quat, p);
        n = qrot(I.quat, n);
        if (I.pos.w > 1.5) {}
        else if (I.pos.w < 0.5) { if ((inPos.w & 1) != 0 && I.paint.w > 0.5) vPaint = vec4(I.paint.rgb, 1.0); }
        else vPhase = I.paint.w;
    }
    vWorld = p;
    vNormal = n;
    gl_Position = viewProj * vec4(p, 1.0);
}
