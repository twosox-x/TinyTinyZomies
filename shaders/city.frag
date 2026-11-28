#version 450
// Baked city shading: palette material per vertex, night lighting (moon + shadows + street lamps), glass and
// water Fresnel sky reflection, emissive modes (FORMAT.md section 6), blood / scorch decals from the gore
// simulation on ground, roofs and walls inside the simulation window.
#extension GL_GOOGLE_include_directive : require
#define FRAME_SET 3
#include "frame.glsl"
#define LAMP_GRID_BINDING 5
#include "lighting.glsl"
layout(location = 0) in vec3 vWorld;
layout(location = 1) in vec3 vNormal;
layout(location = 2) flat in uint vMat;
layout(location = 3) flat in vec4 vPaint;
layout(location = 4) flat in float vPhase;
layout(location = 5) flat in float vDissolve;
layout(location = 6) in vec3 vCell;
#include "dissolve.glsl"
layout(location = 0) out vec4 outColor;
struct Mat { vec4 albedo; vec4 emis; uvec4 info; };   // albedo: linear rgb, w gloss; emis: x night, y mode, z roughness
layout(std430, set = 2, binding = 1) readonly buffer Mats    { Mat mats[]; };
layout(std430, set = 2, binding = 2) readonly buffer Decals  { uint decals[]; };
layout(std430, set = 2, binding = 3) readonly buffer ShadowH { float shadowH[]; };
layout(std430, set = 2, binding = 4) readonly buffer CorpseH { int corpseH[]; };
#include "shadow.glsl"
// Facade cutouts (CityRenderer::setCutouts, GAME_DESIGN 14e garrison window posts): oriented boxes around opened
// windows; tile fragments inside are discarded so the room drawn behind the opening shows. a: centre of the opening on
// the glass plane, w half width; b: xy outward normal (xz), z half height, w depth behind the plane. Count 0 for
// instanced draws.
layout(std140, set = 3, binding = 1) uniform Cutouts { uvec4 cutCount; vec4 cutBox[128]; };
bool facadeCut(vec3 P) {
    for (uint i = 0u; i < cutCount.x; ++i) {
        vec4 a = cutBox[2u * i], b = cutBox[2u * i + 1u];
        vec3 d = P - a.xyz;
        float o = dot(d.xz, b.xy);
        if (o > 0.14 || o < -b.w || abs(d.y) > b.z || abs(dot(d.xz, vec2(-b.y, b.x))) > a.w) continue;
        return true;
    }
    return false;
}
#define M_GLASS 1u
#define M_EMISSIVE 2u
#define M_WATER 4u
#define M_FOLIAGE 8u

float decalAt(ivec2 c, uint layer) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    if (c.x < 0 || c.y < 0 || c.x >= d.x || c.y >= d.y) return 0.0;
    return float(decals[layer * uint(d.x * d.y) + uint(c.y) * uint(d.x) + uint(c.x)]);
}
float decalBilinear(vec2 xz, uint layer) {
    vec2 g = (xz - gridP.xy) * gridP.w * 3.0 - 0.5;
    ivec2 c0 = ivec2(floor(g));
    vec2 f = g - vec2(c0);
    return mix(mix(decalAt(c0, layer), decalAt(c0 + ivec2(1, 0), layer), f.x), mix(decalAt(c0 + ivec2(0, 1), layer), decalAt(c0 + ivec2(1, 1), layer), f.x), f.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float wallH(vec2 xz) {
    ivec2 d = ivec2(gridDim.xy) * 3;
    ivec2 c = ivec2(floor((xz - gridP.xy) * gridP.w * 3.0));
    if (c.x < 0 || c.y < 0 || c.x >= d.x || c.y >= d.y) return 0.0;
    return float(decals[uint(d.x * d.y) + uint(c.y) * uint(d.x) + uint(c.x)]) * 0.001;
}
// Wall blood: the gore simulation stores the highest splat (m) in the decal cell just outside the wall it hit, on the
// 0.75 m simulation height grid, so the rendered facade can be up to ~1 m behind or in front of that cell: search
// outwards along the normal (and a little sideways). Shape: noisy splatter blobs below the splat height, sparse
// spatter above it, and drips running down.
float wallBlood(vec3 P, vec3 N, float u) {
    vec2 n = normalize(N.xz + vec2(1e-5)), t = vec2(-n.y, n.x);
    float h = 0.0;
    for (int k = 0; k < 5; ++k) {
        vec2 q = P.xz + n * (-0.12 + 0.25 * float(k));
        h = max(h, max(wallH(q), 0.8 * max(wallH(q + t * 0.3), wallH(q - t * 0.3))));
    }
    if (h <= 0.0) return 0.0;
    float dy = P.y - h;                                    // > 0 above the highest splat
    if (dy > 1.2) return 0.0;
    vec2 q = vec2(u, P.y);
    float nz = vnoise(q * 2.6) * 0.55 + vnoise(q * 7.0 + 13.1) * 0.3 + vnoise(q * 19.0 + 3.7) * 0.15;
    // dense below the splat height, thinning out above it into droplets
    float thresh = mix(0.42, 0.78, smoothstep(-1.6, 0.9, dy));
    float splat = smoothstep(thresh, thresh + 0.04, nz) * step(P.y, h + 1.2) * smoothstep(-3.5, -1.5, dy + 0.0);
    // drips: thin streaks hanging from the splat line, varying length per column
    float col = floor(u * 9.0);
    float r = hash12(vec2(col, floor(h * 3.0) + 17.0));
    float fx = fract(u * 9.0);
    float len = 0.4 + 2.2 * fract(r * 17.3);
    float drip = step(0.55, r) * step(abs(fx - 0.5), 0.12 * (1.0 - clamp((h - P.y) / len, 0.0, 1.0)) + 0.04)
               * step(P.y, h + 0.05) * step(h - P.y, len);
    return clamp(max(splat, drip), 0.0, 1.0);
}
float sq(float t, float hz) { return step(0.5, fract(t * hz)); }

// ---- Day-time glass (mirror-like windows, curtain walls, vehicle glass) ----
// From the RTS camera a vertical pane physically reflects the street below (R.y < 0), so the sun would almost never
// show up in a facade. Stylised instead: the reflection is mirrored into the upper hemisphere (Rs, |R.y| slightly
// flattened), the environment is a procedural sky (gradient, warm aureole, cloud streaks) above a hint of the opposite
// city (a dark skyline band, lower floors reflect it), and the sun is an anisotropic GGX-like lobe in that mirrored
// frame: tight across the facade (glints move window to window as the camera pans), loose vertically (panes bow), so
// whenever the sun is behind the camera on a facade's side a band of its windows catches it, with a broad warm sheen
// over the whole sun-facing side (blazing orange at golden hour). Per-room pane tilt + a slow facade warp make it
// shimmer; both fade into a wider lobe once a room is only a few pixels (no sub-pixel sparkle).
vec3 glassSky(vec3 Rs, vec3 P) {
    vec3 L = sunDir.xyz;
    float e = Rs.y;
    vec3 hor = fogColor.rgb * 1.15, zen = skyColor.rgb * 2.6;
    vec3 sky = mix(hor, zen, smoothstep(0.02, 0.9, e));
    float mu = max(dot(Rs, L), 0.0);
    float low = 1.0 - smoothstep(0.1, 0.6, L.y);                     // a low sun warms a wider part of the sky
    sky += sunColor.rgb * (pow(mu, 5.0) * (0.10 + 0.25 * low) + pow(mu, 48.0) * 0.5);
    // cloud streaks on a plane above (world-anchored; the reflection pans across them)
    vec2 cp = Rs.xz / (e + 0.15) * 2.2 + P.xz * 0.002;
    float cl = vnoise(cp * vec2(0.7, 2.4)) * 0.65 + vnoise(cp * vec2(1.9, 5.3) + 7.3) * 0.35;
    cl = smoothstep(0.52, 0.85, cl) * smoothstep(0.0, 0.25, e);
    vec3 cloudCol = hor * 1.25 + sunColor.rgb * (0.25 + 0.35 * mu);
    return mix(sky, cloudCol, cl * 0.55);
}
// opposite city: buildings ~24 m across the street, roofline hashed per ~16 m; Rs climbs above it on higher floors
vec3 glassEnv(vec3 Rs, vec3 P, vec3 N) {
    vec3 sky = glassSky(Rs, P);
    float hl = max(length(Rs.xz), 0.05);
    vec2 t = vec2(-N.z, N.x);
    float D = 24.0;
    float hitAlong = dot(P.xz, t) + dot(Rs.xz, t) / hl * D;
    float cell = floor(hitAlong / 16.0);
    float Hopp = 8.0 + 34.0 * hash12(vec2(cell, floor(dot(P.xz, N.xz) / 40.0)));
    float hH = P.y + Rs.y / hl * D;                                   // height where the mirrored ray meets it
    float city = 1.0 - smoothstep(Hopp - 2.0, Hopp + 2.0, hH);
    if (city <= 0.0) return sky;
    float rowsLit = step(0.55, fract(hH / 3.0)) * step(0.3, fract(hitAlong / 3.2));
    vec3 cityCol = mix(groundColor.rgb * 2.2 + skyColor.rgb * 0.5, fogColor.rgb * 0.75, 0.35) * (0.75 + 0.35 * rowsLit);
    return mix(sky, cityCol, city * 0.85);
}
// base: the diffuse-lit glass body; room / rh: the window room cell and its hash (main); rough: material roughness
// (0.15 building glass, 0.66 vehicle glass); vis: sun visibility (shadow map)
vec3 glassDay(vec3 base, vec3 N, vec3 V, vec3 P, vec2 room, float rh, float rough, float gloss, float vis) {
    vec3 L = sunDir.xyz;
    bool wall = abs(N.y) < 0.3;
    // pixel footprint in metres: pane jitter fades and the lobe widens once rooms are a few pixels (temporal stability)
    float px = length(P - camPos.xyz) * 0.0015;                                     // ~ metres per pixel (0.75 rad fov, 540p)
    float fine = 1.0 - smoothstep(0.25, 0.9, px);
    vec3 T = wall ? normalize(vec3(-N.z, 0.0, N.x)) : vec3(1.0, 0.0, 0.0);
    vec3 B = cross(N, T);
    vec3 Ng = N;
    if (wall) {
        float along = dot(P.xz, T.xz);
        float warpU = (vnoise(vec2(along, P.y) * 0.09) - 0.5) * 0.10;    // slow facade warp (oil-canning)
        float warpV = (vnoise(vec2(along, P.y) * 0.07 + 31.7) - 0.5) * 0.08;
        float ju = (rh - 0.5) * 0.16 * fine, jv = (hash12(room * 1.37 + 5.1) - 0.5) * 0.10 * fine;   // per-room pane tilt
        Ng = normalize(N + T * (warpU + ju) + vec3(0.0, warpV + jv, 0.0));
    } else {
        Ng = normalize(N + (T * (rh - 0.5) + B * (hash12(room * 1.37 + 5.1) - 0.5)) * 0.08 * fine);
    }
    vec3 R = reflect(-V, Ng);
    vec3 Rs = normalize(vec3(R.x, abs(R.y) * 0.75, R.z));                          // mirrored into the sky (see above)
    float NoV = max(dot(Ng, V), 1e-3);
    float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    float mirror = max(gloss, 0.6);
    float refl = mix(0.26, 1.0, F) * mirror;                                       // coated glass: mirror-like
    vec3 env = glassEnv(Rs, P, N);
    vec3 col = base * (1.0 - refl) * 0.7 + env * refl;
    // sun: anisotropic lobe around the mirrored reflection (tight across the facade, loose vertically)
    float a = mix(0.07, 0.16, clamp(rough, 0.0, 1.0));
    float jit = wall ? 0.11 : 0.08;
    float ax = sqrt(a * a + jit * jit * (1.0 - fine)) * 3.2;                      // reflection angles = 2x normal, widened
    float ay = ax * (wall ? 2.5 : 1.0);
    vec3 d = L - Rs;
    float dh = dot(d, T), dv = wall ? d.y : dot(d, B);
    float q = dh * dh / (ax * ax) + dv * dv / (ay * ay);
    float core = 1.0 / ((1.0 + q) * (1.0 + q));                                    // mirror-aligned glare
    float qb = q * 0.12;
    float sheen = 1.0 / ((1.0 + qb) * (1.0 + qb));                                 // broad lobe
    // sun on the facade (not the exact mirror direction) drives the look: any sunlit pane glows warm
    float sunFace = smoothstep(0.0, 0.35, dot(N, L)) * vis * smoothstep(-0.02, 0.05, L.y) * (1.0 - todP.z);
    float Fk = mix(0.55, 1.0, F) * mirror;
    // per-window sparkle: ~1 in 7 rooms flashes; which ones shifts as the view direction changes (camera pan / zoom)
    float h2 = hash12(room * 0.517 + vec2(3.1, 8.7));
    float ph = fract(h2 * 7.0 + dot(V, T) * 2.2 + V.y * 1.7);
    float spark = 1.0 - smoothstep(0.0, 0.075, abs(ph - 0.5));
    spark *= 0.6 + 0.4 * fine;
    float veh = step(0.4, rough);                                                  // vehicle glass: small panes, extra sparkle
    float glint = core * 5.0 * mix(0.5, 1.0, fine) * refl + sheen * 0.5 * Fk + 1.0 * Fk + spark * 6.0 * Fk
                + veh * (1.6 + core * 6.0) * Fk;
    vec3 sunTint = sunColor.rgb / max(max(sunColor.r, max(sunColor.g, sunColor.b)), 1e-3);   // hue of the sun
    float sunI = max(sunColor.r, max(sunColor.g, sunColor.b));
    col += sunTint * min(glint * sunI, 6.0) * sunFace;
    // vehicle glass (windshields: small, slanted, often turned away from the sun, so the facade glint above rarely
    // reads at the RTS camera): a slightly lighter sky-tinted pane plus a small sun sparkle that only needs the sun up
    // and roughly on the glass side; ~1 in 3 panes flashes brighter, which ones shift with the view (pan / zoom).
    // Point-like at 50-110 m (a windshield is 5-10 px there), never at night (todP.z) or under a shadow / cloud (vis).
    if (veh > 0.5) {
        col = mix(col, env + skyColor.rgb * 0.5, 0.4);
        float up = smoothstep(-0.02, 0.12, L.y) * (1.0 - todP.z) * vis;
        float side = smoothstep(-0.6, 0.2, dot(N, L));
        float hv = hash12(room * 0.731 + vec2(11.3, 2.9));
        float pv = fract(hv * 5.0 + dot(V, T) * 1.6 + V.y * 1.3);
        float vflash = 1.0 - smoothstep(0.0, 0.16, abs(pv - 0.5));
        float vglint = (1.4 + 3.0 * core + 10.0 * vflash) * mix(0.7, 1.0, F);
        col += sunTint * min(vglint * sunI, 6.0) * up * side;
    }
    // low sun (golden hour): glass in its own shade still reflects the glowing sunset sky (orange-pink, brighter
    // towards the horizon) and a few panes flash, so reflections read at any camera yaw; subtler than the sunlit glint
    float lowSun = (1.0 - smoothstep(0.15, 0.45, L.y)) * smoothstep(-0.02, 0.06, L.y) * (1.0 - todP.z);
    float shade = 1.0 - smoothstep(0.0, 0.35, dot(N, L)) * vis;
    vec3 sunset = mix(vec3(1.0, 0.42, 0.22), vec3(0.95, 0.55, 0.6), smoothstep(0.1, 0.8, Rs.y));
    col += sunset * (sunI * lowSun * shade * Fk) * (0.45 + 2.4 * spark);
    return col;
}

void main() {
    if (voxelDissolved(vCell, vDissolve)) discard;   // lab canopies after landing (docs/MILITARY_ANIMS.md 2.3.3)
    if (cutCount.x > 0u && facadeCut(vWorld)) discard;   // opened garrison windows
    Mat m = mats[vMat];
    vec3 N = normalize(vNormal);
    vec3 albedo = m.albedo.rgb;
    if (vPaint.w > 0.5) albedo = vPaint.rgb;
    uint flags = m.info.x;
    if ((flags & M_EMISSIVE) != 0u && int(m.emis.y + 0.5) == 2 && todP.x < 1.0) {   // lit windows by day: the unlit glass
        Mat dm = mats[m.info.y];
        albedo = mix(dm.albedo.rgb, albedo, todP.x);
        if (todP.x < 0.5) { flags |= dm.info.x & M_GLASS; m.albedo.w = dm.albedo.w; }
    }
    float t = camPos.w;
    if ((flags & M_FOLIAGE) != 0u) albedo *= 0.8 + 0.4 * hash12(floor(vWorld.xz * 0.7) + floor(vWorld.y * 0.7));

    // gore decals inside the simulation window
    vec2 g = (vWorld.xz - gridP.xy) * gridP.w;
    bool inWin = g.x >= 0.0 && g.y >= 0.0 && g.x < float(gridDim.x) && g.y < float(gridDim.y);
    float wet = 0.0;
    if (inWin) {
        if (N.y > 0.7) {
            ivec2 c = ivec2(floor(g));
            float corpse = float(corpseH[uint(c.y) * gridDim.x + uint(c.x)]) * 0.001;
            if (corpse > 0.0 && vWorld.y < 0.6) albedo = mix(albedo, vec3(0.03, 0.001, 0.002), clamp(corpse * 4.0, 0.0, 0.85));
            float scorch = decalBilinear(vWorld.xz, 2u) / 255.0;
            albedo *= 1.0 - 0.85 * smoothstep(0.15, 0.6, scorch + (hash12(floor(vWorld.xz * 6.0)) - 0.5) * 0.3);
            float bloodAmt = decalBilinear(vWorld.xz, 0u);
            float bn = hash12(floor(vWorld.xz * 8.0)) * 0.5 + hash12(floor(vWorld.xz * 3.0)) * 0.5;
            float cov = smoothstep(0.45, 0.6, bloodAmt / 160.0 + (bn - 0.5) * 0.55);
            if (cov > 0.0) {
                vec3 bc = mix(vec3(0.075, 0.001, 0.002), vec3(0.02, 0.0, 0.0005), smoothstep(200.0, 900.0, bloodAmt));
                albedo = mix(albedo, bc, cov * 0.92);
                wet = cov;
            }
        } else if (abs(N.y) < 0.3) {
            float u = dot(vWorld.xz, vec2(-N.z, N.x));
            float b = wallBlood(vWorld, N, u);
            albedo = mix(albedo, vec3(0.085, 0.002, 0.003), b * 0.95);
            wet = b * 0.7;
        }
    }

    float vis = moonVisibility(vWorld, N);
    vec3 col = shadeV(albedo * 2.0, N, vWorld, 1.0, vis);
    vis *= cloudShadow(vWorld);   // glass glints / day reflections below: under the cloud shadows too
    vec3 V = normalize(camPos.xyz - vWorld);
    float gloss = m.albedo.w;
    // window "room" cell: ~3.2 m along the facade x one 3 m storey, sampled just inside the wall (one hash per room:
    // lit-window brightness / colour at night, pane tilt for the day-time sun glints)
    vec3 Pin = vWorld - N * 0.1;
    float along = dot(Pin.xz, vec2(-N.z, N.x));
    vec2 room = vec2(floor(along / 3.2), floor(Pin.y / 3.0)) + floor(dot(Pin.xz, N.xz) * 0.25) * vec2(17.0, 31.0);
    float rh = hash12(room + vec2(N.x * 3.0, N.z * 7.0));
    if ((flags & (M_GLASS | M_WATER)) != 0u || wet > 0.0) {
        // Fresnel reflection of the sky (purple zenith, fog-coloured horizon)
        bool glass = (flags & M_GLASS) != 0u && (flags & M_WATER) == 0u;
        vec3 Ng = N;
        if (glass && abs(N.y) < 0.3) {   // panes are not perfectly coplanar: a slight per-room tilt so glints sparkle
            float a = (rh - 0.5) * 0.09, b = (hash12(room * 1.37 + 5.1) - 0.5) * 0.06;
            Ng = normalize(N + vec3(-N.z, 0.0, N.x) * a + vec3(0.0, b, 0.0));
        }
        vec3 R = reflect(-V, Ng);
        vec3 sky = mix(fogColor.rgb * 1.2, skyColor.rgb * 1.6, clamp(R.y * 1.5, 0.0, 1.0));
        float f = 0.04 + 0.96 * pow(1.0 - max(dot(Ng, V), 0.0), 5.0);
        float k = (flags & M_WATER) != 0u ? 1.0 : glass ? max(gloss, 0.5) : wet * 0.6;
        vec3 base = col;
        col = mix(col, sky, clamp(f * k, 0.0, 1.0)) + sky * 0.15 * k * (glass ? 1.0 : 0.0);
        if (glass) {   // the sun (or moon) in the glass: a sharp specular glint, Fresnel-weighted, shadowed with the facade
            float sp = max(dot(R, sunDir.xyz), 0.0);
            float glint = pow(sp, 900.0) * 60.0 + pow(sp, 60.0) * 0.6;
            col += sunColor.rgb * glint * (0.25 + 0.75 * f) * vis * k;
        }
        float day = glass ? clamp(1.0 - todP.x * 1.25, 0.0, 1.0) : 0.0;   // night: the shading above, unchanged
        if (day > 0.0) col = mix(col, glassDay(base, N, V, vWorld, room, rh, m.emis.z, gloss, vis), day);
    }
    // emission (FORMAT.md section 6, City Lab's uNight = todP.x: 0 day .. 1 night)
    if ((flags & M_EMISSIVE) != 0u) {
        float night = todP.x;
        float steady = mix(m.emis.w, m.emis.x, night);                          // day .. night strength
        int mode = int(m.emis.y + 0.5);
        float e = steady;
        if (mode == 2) {   // lit windows (day: unlit glass, above): per-room brightness and colour temperature
            float r2 = hash12(room * 0.731 + 11.3), r3 = hash12(room * 1.913 + 3.7);
            float lvl = rh < 0.16 ? 0.0 : rh < 0.38 ? 0.25 + 0.3 * r2 : rh < 0.85 ? 0.7 + 0.5 * r2 : 1.3 + 0.6 * r2;   // off / dim / lit / bright
            vec3 tint = r3 < 0.55 ? vec3(1.0, 0.78, 0.5)                    // warm incandescent
                      : r3 < 0.8 ? vec3(1.0, 0.92, 0.78)                     // neutral
                      : r3 < 0.97 ? vec3(0.78, 0.92, 1.0)                    // cool fluorescent
                                  : vec3(0.45, 0.62, 1.0);                   // TV blue, flickering
            if (r3 >= 0.97) lvl = 0.5 * (0.55 + 0.45 * sin(t * 7.3 + rh * 40.0) * sin(t * 2.9 + r2 * 13.0));
            float lum = dot(m.albedo.rgb, vec3(0.3, 0.55, 0.15));
            col += mix(m.albedo.rgb, tint * lum * 1.25, 0.75) * (1.3 * night * lvl);
            e = 0.0;
        }
        else if (mode == 3) e = steady * (0.6 + 0.4 * sq(t, 0.5));               // aircraft beacon
        else if (mode == 4) e = steady * (0.25 + 0.75 * sq(t + (vMat == 190u ? 0.3125 : 0.0), 1.6));   // light bars
        else if (mode == 5) {                                                    // traffic / pedestrian signals, 30 s cycle
            float c = mod(t + vPhase * 15.0, 30.0);
            bool green = c < 12.0, amber = c >= 12.0 && c < 15.0;
            bool lit = vMat == 60u ? !(green || amber) : vMat == 61u ? amber : vMat == 62u ? green : vMat == 69u ? green : !green;
            e = lit ? 1.4 + 1.8 * night : 0.3;
        }
        col += m.albedo.rgb * e;
    }
    outColor = finishA(col, vWorld);
}
