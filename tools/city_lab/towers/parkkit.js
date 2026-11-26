// Park kit: makes the leftover land of the suburban blocks look intentional.
//
// CityArch.lib.parkKit(K) -> { regions: [...], stats }   (called from buildAll right after emitSuburbs)
//   K = { PL, C, blocks, sub, mb, hs, voxel }
//
// 1. Leftovers. Per suburban block (sub.blocks: residential / transition / commercial): the block land (PL grid,
//    0.5 m cells, blocks.lab) minus every lot rectangle (house, townhouse, apartments, main street, gas station,
//    strip mall...: the plug-ins own their whole lot) minus a clearance band along the sidewalk. Connected
//    components (4-connected) with area, thickness (largest distance to the component edge), principal axes,
//    frontage and the uses of the lots around them.
// 2. Fill, by size, shape and zone:
//    - wedge   an acute tip (elongated, tapering to a street corner): triangle park - a memorial (obelisk or
//              flagpole with a plaque) on a round paved pad, a "welcome" sign wall facing the junction, flower beds
//              and low planting towards the tip, a path from the sidewalk, trees in the wide part;
//    - park    residential, large: neighbourhood park - paths from 1-2 sidewalk points to a hub (gazebo or flower
//              circle), a playground and / or a half basketball court, benches, lamps and bins along the paths, a
//              wooded edge along the lots, scattered shade trees, open lawn;
//    - grove   residential strips, corners and backs: dense woods of large trees (8-16 m, broad layered crowns in
//              several greens, spruces and pines), crowns overlapping, thick undergrowth;
//    - plaza   transition / commercial, on a street: a paved pocket plaza (benches, planters with trees, bike rack,
//              bins, a lamp) at the sidewalk, the rest a landscaped buffer;
//    - buffer  transition / commercial, elsewhere: rows of trees over clipped shrubs.
// Geometry: every part is a cached VoxModel meshed once by meshVoxels3D and emitted as rigidly rotated copies
// (arbitrary yaw) straight into the building mesh; faces resting on the ground are skipped, models are sunk a few
// millimetres (a random amount per copy) so nothing shares a plane with the ground, the sidewalk or each other.
// Nothing enters a lot (crowns may reach <= 1 m over a house lot's line above 3.5 m), the sidewalk band or a path.
// Deterministic per seed (hashes of block ids, component index and the city seed).
(function () {
'use strict';
const A = self.CityArch, L = A.lib, BM = L.BM;
const K = {
  PARK: 14, MGRASS: 10, PLAZA: 12, PLAZA_J: 13, PATH: 18, ASPH: 2, LEAF: 133, LEAF_D: 134, TRUNK: 135, WOOD: 136, EVER: 137,
  SOIL: 140, DGREEN: 126, SHUT_G: 103, AWN_G: 97, SGREEN: 65, GRASS: 155, WHITE: 64, PWHITE: 157, CONC: 70, POLE: 54, POLE_D: 55,
  LED: 154, RED: 131, YEL: 132, BLUE: 139, ORANGE: 170, SRED: 63, BLACK: 58, STEEL: 130, GRAN_D: 142, LIME: 74, BRICK: 71,
  BRONZE: 143, SHINGLE: 93, SLATE: 110, SALMON: 106, TRIM: 84, CREAM: 81, BIN: 126
};
const DARK = [K.DGREEN, K.SHUT_G, K.EVER, K.LEAF_D], MID = [K.AWN_G, K.SGREEN, K.LEAF_D, K.LEAF], LIGHT = [K.LEAF, K.GRASS, K.PARK, K.MGRASS];
const BV = 0.25;
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const VM = (w, h, d, ox, oz) => new (L.VoxModel())(w, h, d, ox, oz);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const pick = (R, a) => a[Math.floor(R() * a.length) % a.length];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const faceYaw = (fx, fz) => Math.atan2(-fx, fz);        // yaw turning a model's +z towards (fx, fz)
const SLOTS = [];                                         // copy offsets (m), see sink() in parkKit; 3..103 mm: a one-voxel (12.5 cm) part
                                                          // resting on the ground keeps its top >= 2 cm above the ground (groundfight)
for (let s = 0; s < 26; ++s) { const mm = 3 + 4 * s, ph = ((mm % 15.625) + 15.625) % 15.625; if (Math.abs(ph - 7.8125) > 1.6) SLOTS.push(mm / 1000); }
const CACHE = new Map();
L.debugParkCache = CACHE;                                  // dev/overlap.js names placed models
const cached = (key, make) => { let v = CACHE.get(key); if (!v) { v = make(); CACHE.set(key, v); } return v; };

// ------------------------------------------------------------------------------------------ model helpers
function oct(M, cx, cz, r, y0, y1, m) {
  if (y1 <= y0) return;
  if (r < 1) { M.box(cx - 1, y0, cz - 1, cx + 1, y1, cz + 1, m); return; }
  const r2 = Math.max(1, Math.round(r * 0.62));
  M.box(cx - r, y0, cz - r2, cx + r, y1, cz + r2, m); M.box(cx - r2, y0, cz - r, cx + r2, y1, cz + r, m);
}
function blob2(M, cx, cy, cz, r, hy, mLow, mTop) {
  const b = cy + Math.round(hy * 0.4);
  oct(M, cx, cz, r, cy - hy, b, mLow);
  oct(M, cx, cz, Math.max(1, Math.round(r * 0.66)), b, cy + hy, mTop || mLow);
}

// ------------------------------------------------------------------------------------------ trees (25 cm voxels)
// { mesh, rc (crown radius, m), base (crown underside, m), h (m), kind }
const SPECIES = {
  oak: { w: 1 }, maple: { w: 1 }, tulip: { w: 1 }, spruce: { w: 1 }, pine: { w: 1 }, young: { w: 1 }, red: { w: 1 }
};
function treeModel(C, sp, vr) {
  return cached('t:' + sp + ':' + vr, () => {
    const R = C.mulberry32(hash('parktree' + sp + vr));
    let M, ht, rc, base;
    const lo = pick(R, DARK), mid = pick(R, MID), hi = pick(R, LIGHT);
    if (sp === 'oak' || sp === 'maple' || sp === 'red') {
      // broad layered crown on a tall trunk: a wide lower skirt, lobes around, a lighter dome
      const oak = sp === 'oak';
      ht = oak ? 46 + Math.floor(R() * 16) : 40 + Math.floor(R() * 14);
      rc = oak ? 17 + Math.floor(R() * 5) : 13 + Math.floor(R() * 4);
      M = VM(2 * rc + 6, ht + 2, 2 * rc + 6, rc + 3, rc + 3);
      base = Math.round(ht * (0.3 + R() * 0.08));
      const cLo = sp === 'red' ? pick(R, [BM.BRICK_RED, K.SRED]) : lo, cMid = sp === 'red' ? pick(R, [BM.AWNING_RED, K.SALMON]) : mid, cHi = sp === 'red' ? K.ORANGE : hi;
      const tt = Math.round(base + (ht - base) * 0.45), tw = oak ? 2 : 1;
      M.box(-tw, 0, -tw, tw, tt, tw, K.TRUNK);
      const a0 = R() * 6.28;
      for (let i = 0; i < 2; ++i) {                                  // two limbs into the crown
        const an = a0 + i * 3.1, dx = Math.round(Math.cos(an) * 3), dz = Math.round(Math.sin(an) * 3);
        M.box(Math.min(0, dx) - 1, base - 2 + i * 3, Math.min(0, dz) - 1, Math.max(0, dx) + 1, base + i * 3, Math.max(0, dz) + 1, K.TRUNK);
        M.box(dx - 1, base, dz - 1, dx + 1, base + 6 + i * 2, dz + 1, K.TRUNK);
      }
      const skirt = Math.round((ht - base) * 0.32);
      oct(M, 0, 0, Math.round(rc * 0.78), base, base + skirt, cLo);
      const n = oak ? 4 : 3;
      for (let i = 0; i < n; ++i) {
        const an = a0 + 0.6 + i * 6.283 / n + (R() - 0.5) * 0.6, rr = Math.round(rc * (0.42 + R() * 0.1)), dist = rc - rr;
        const cy = base + skirt + Math.round((R() - 0.2) * (ht - base) * 0.25);
        blob2(M, Math.round(Math.cos(an) * dist), cy, Math.round(Math.sin(an) * dist), rr, Math.round(rr * 0.7), i & 1 ? cLo : cMid, cMid);
      }
      blob2(M, 0, ht - Math.round(rc * 0.55), 0, Math.round(rc * 0.62), Math.round(rc * 0.45), cMid, cHi);
    } else if (sp === 'tulip') {
      // tall, narrow, straight: a column of crowns from half height
      ht = 54 + Math.floor(R() * 10); rc = 10 + Math.floor(R() * 3);
      M = VM(2 * rc + 6, ht + 2, 2 * rc + 6, rc + 3, rc + 3);
      base = Math.round(ht * 0.42);
      M.box(-1, 0, -1, 1, ht - 8, 1, K.TRUNK);
      const n = 3, seg = (ht - base) / n;
      for (let i = 0; i < n; ++i) {
        const r = Math.round(rc * (i === 1 ? 1 : i === 0 ? 0.85 : 0.7)), cy = Math.round(base + (i + 0.5) * seg);
        const ox = Math.round((R() - 0.5) * 4), oz = Math.round((R() - 0.5) * 4);
        blob2(M, ox, cy, oz, r, Math.round(seg * 0.62), i === 2 ? mid : lo, i === 2 ? hi : mid);
      }
    } else if (sp === 'spruce') {
      // spruce / fir: skirts of branches stepping in, drooping slightly, from near the ground
      ht = 44 + Math.floor(R() * 20); rc = 9 + Math.floor(R() * 4);
      M = VM(2 * rc + 4, ht + 3, 2 * rc + 4, rc + 2, rc + 2);
      const m1 = pick(R, [K.EVER, K.DGREEN, K.SHUT_G]), m2 = m1 === K.EVER ? K.DGREEN : K.EVER;
      M.box(-1, 0, -1, 1, ht - 2, 1, K.TRUNK);
      base = 3 + Math.floor(R() * 4);
      const tiers = clamp(Math.round((ht - base) / 7), 6, 9), th = (ht - base) / tiers;
      for (let t = 0; t < tiers; ++t) {
        const f = 1 - t / tiers, r = Math.max(1, Math.round(rc * Math.pow(f, 0.85))), y0 = Math.round(base + t * th), y1 = Math.round(base + (t + 1) * th);
        oct(M, 0, 0, r, y0, y0 + Math.max(2, Math.round((y1 - y0) * 0.55)), t & 1 ? m2 : m1);
        oct(M, 0, 0, Math.max(1, Math.round(r * 0.62)), y0, y1, m1);
      }
      M.box(-1, ht - 2, -1, 1, ht + 2, 1, m1);
    } else if (sp === 'pine') {
      // white pine: tall bare trunk, irregular flat clumps of needles in the upper half
      ht = 52 + Math.floor(R() * 12); rc = 11 + Math.floor(R() * 4);
      M = VM(2 * rc + 6, ht + 2, 2 * rc + 6, rc + 3, rc + 3);
      base = Math.round(ht * 0.5);
      M.box(-1, 0, -1, 1, ht - 3, 1, K.TRUNK);
      const m1 = pick(R, [K.EVER, K.DGREEN]), m2 = pick(R, [K.SGREEN, K.AWN_G]);
      const n = 5, a0 = R() * 6.28;
      for (let i = 0; i < n; ++i) {
        const y = Math.round(base + (ht - base - 6) * i / (n - 1)), an = a0 + i * 2.4, dist = Math.round((rc - 5) * (1 - i / n));
        const cx = Math.round(Math.cos(an) * dist), cz = Math.round(Math.sin(an) * dist), r = Math.max(3, Math.round(rc * (0.62 - i * 0.07)));
        M.box(Math.min(0, cx), y - 1, Math.min(0, cz), Math.max(0, cx) + 1, y, Math.max(0, cz) + 1, K.TRUNK);
        oct(M, cx, cz, r, y, y + 3, i & 1 ? m2 : m1);
        oct(M, cx, cz, Math.max(1, r - 2), y + 3, y + 5, m1);
      }
    } else if (sp === 'street') {
      // street-side shade tree: clear trunk to ~3.5 m, compact rounded crown
      ht = 30 + Math.floor(R() * 9); rc = 8 + Math.floor(R() * 3);
      M = VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
      base = 14 + Math.floor(R() * 3);
      M.box(-1, 0, -1, 1, ht - 5, 1, K.TRUNK);
      const cy = Math.round((base + ht) / 2);
      blob2(M, 0, cy, 0, rc, Math.round((ht - base) / 2) - 1, lo, mid);
      const an = R() * 6.28;
      blob2(M, Math.round(Math.cos(an) * rc * 0.4), cy + 2, Math.round(Math.sin(an) * rc * 0.4), Math.round(rc * 0.6), 3, mid, hi);
    } else {                                                            // young understory tree (dogwood / redbud / maple)
      ht = 22 + Math.floor(R() * 8); rc = 7 + Math.floor(R() * 3);
      M = VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
      base = 8;
      M.box(0, 0, 0, 1, ht - 6, 1, K.TRUNK);
      const flower = R() < 0.25 ? pick(R, [K.CREAM, K.SALMON]) : null;                    // blossom: cream or pink, never paint white
      blob2(M, 0, ht - rc + 1, 0, rc, Math.round(rc * 0.6), lo, flower || mid);
      blob2(M, Math.round((R() - 0.5) * 4), ht - 3, Math.round((R() - 0.5) * 4), Math.round(rc * 0.6), 2, mid, flower || hi);
      if (flower) L.dappleTop(M, rc + 2, mid, 4, 1);
    }
    return { mesh: C.meshVoxels3D(M), rc: rc * BV + 0.25, base: base * BV, h: ht * BV, sp };
  });
}
// bushes / undergrowth (12.5 cm voxels): rounded shrubs, spreading mounds, flowers, clipped boxes
function bushModel(C, kind, vr) {
  return cached('b:' + kind + ':' + vr, () => {
    const R = C.mulberry32(hash('parkbush' + kind + vr));
    let M, r;
    if (kind === 'shrub') {
      r = 6 + Math.floor(R() * 5); const h = 7 + Math.floor(R() * 7);
      M = VM(2 * r + 4, h + 2, 2 * r + 4, r + 2, r + 2);
      const lo = pick(R, DARK), hi = pick(R, MID);
      oct(M, 0, 0, r, 0, Math.round(h * 0.6), lo);
      oct(M, 0, 0, Math.round(r * 0.66), Math.round(h * 0.6), h, hi);
      const an = R() * 6.28;
      oct(M, Math.round(Math.cos(an) * r * 0.6), Math.round(Math.sin(an) * r * 0.6), Math.round(r * 0.55), 0, Math.round(h * 0.75), hi);
    } else if (kind === 'mound') {                                    // spreading juniper / fern mound
      r = 8 + Math.floor(R() * 5); const h = 3 + Math.floor(R() * 3);
      M = VM(2 * r + 4, h + 2, 2 * r + 4, r + 2, r + 2);
      const m = pick(R, [K.EVER, K.SGREEN, K.LEAF_D, K.AWN_G]);
      oct(M, 0, 0, r, 0, h - 1, m); oct(M, 1, -1, Math.round(r * 0.6), h - 1, h + 1, pick(R, LIGHT));
    } else if (kind === 'flowers' || kind === 'bed') {
      r = kind === 'bed' ? 3 + Math.floor(R() * 2) : 5 + Math.floor(R() * 3);
      M = VM(2 * r + 4, 6, 2 * r + 4, r + 2, r + 2);
      oct(M, 0, 0, r, 0, 3, K.LEAF_D);
      const cols = [K.RED, K.YEL, K.PWHITE, K.SALMON, BM.PAINT_BLUE, K.ORANGE], c1 = pick(R, cols), c2 = pick(R, cols);
      for (let i = -r + 1; i < r - 1; i += 2) for (let j = -r + 1; j < r - 1; j += 2) if (i * i + j * j < (r - 1) * (r - 1) && R() < 0.55) M.box(i, 3, j, i + 1, 4, j + 1, R() < 0.5 ? c1 : c2);
    } else {                                                          // clipped box shrub
      const w = 5 + Math.floor(R() * 4), h = 5 + Math.floor(R() * 3); r = w;
      M = VM(2 * w + 2, h + 1, 2 * w + 2, w + 1, w + 1);
      M.box(-w, 0, -w + 1, w, h, w - 1, pick(R, [K.LEAF_D, K.SGREEN, K.EVER]));
    }
    return { mesh: C.meshVoxels3D(M), r: r * 0.125 + 0.1 };
  });
}

// ------------------------------------------------------------------------------------------ park furniture (12.5 cm voxels unless noted)
const ITEMS = {
  bench(C, vr) {             // origin centre of the seat front edge line; sitter faces +z; 1.75 x 0.7 m
    const R = C.mulberry32(hash('bench' + vr)), M = VM(16, 8, 7, 8, 1);
    const wood = pick(R, [K.WOOD, K.WOOD, BM.SHUTTER_GREEN]), leg = pick(R, [K.POLE_D, K.BLACK]);
    for (const x of [-7, 5]) { M.box(x, 0, -1, x + 2, 3, 3, leg); M.box(x, 3, -1, x + 2, 7, 0, leg); }
    M.box(-8, 3, -1, 8, 4, 3, wood); M.box(-8, 4, -1, 8, 5, 0, wood); M.box(-8, 6, -1, 8, 7, 0, wood);
    return { M, sc: 0.125, fp: [-1, -0.25, 1, 0.5] };
  },
  picnic(C, vr) {            // 1.9 x 1.6 m
    const R = C.mulberry32(hash('picnic' + vr)), M = VM(16, 7, 14, 8, 7), w = pick(R, [K.WOOD, BM.WOOD, K.TRIM]);
    M.box(-7, 5, -3, 7, 6, 3, w);
    for (const z of [-6, 4]) M.box(-7, 3, z, 7, 4, z + 2, w);
    for (const x of [-5, 4]) { M.box(x, 0, -6, x + 1, 1, 6, w); M.box(x, 1, -1, x + 1, 5, 1, w); }
    return { M, sc: 0.125, fp: [-1, -0.9, 1, 0.9] };
  },
  lamp(C) {                  // park lantern 3.6 m
    const M = VM(5, 31, 5, 2, 2);
    M.box(-1, 0, -1, 2, 2, 2, K.POLE_D); M.box(0, 2, 0, 1, 26, 1, K.POLE_D);
    M.box(-1, 26, -1, 2, 29, 2, K.LED); M.box(-2, 29, -2, 3, 30, 3, K.POLE_D); M.box(0, 30, 0, 1, 31, 1, K.POLE_D);
    return { M, sc: 0.125, fp: [-0.3, -0.3, 0.3, 0.3] };
  },
  bin(C) {
    const M = VM(5, 8, 5, 2, 2);
    M.box(-2, 0, -2, 3, 7, 3, K.BIN); M.box(-2, 7, -2, 3, 8, 3, K.BLACK);
    return { M, sc: 0.125, fp: [-0.3, -0.3, 0.4, 0.4] };
  },
  bikerack(C) {
    const M = VM(18, 7, 3, 9, 1);
    for (let x = -8; x <= 6; x += 4) { M.box(x, 0, 0, x + 1, 6, 1, K.STEEL); M.box(x, 6, 0, x + 3, 7, 1, K.STEEL); M.box(x + 2, 0, 0, x + 3, 6, 1, K.STEEL); }
    return { M, sc: 0.125, fp: [-1.1, -0.2, 1.1, 0.3] };
  },
  planter(C, vr) {           // concrete planter 1.5 m square, soil and a shrub skirt; a tree is planted on top
    const R = C.mulberry32(hash('planter' + vr)), M = VM(13, 7, 13, 6, 6), m = pick(R, [K.CONC, K.GRAN_D, K.LIME]);
    M.box(-6, 0, -6, 7, 5, 7, m); M.box(-5, 5, -5, 6, 6, 6, K.SOIL);
    for (const [x, z] of [[-5, -5], [3, 3], [-5, 3], [3, -5]]) M.box(x, 5, z, x + 2, 7, z + 2, pick(R, [K.LEAF_D, K.SGREEN]));
    return { M, sc: 0.125, fp: [-0.8, -0.8, 0.9, 0.9], top: 6 * 0.125 };
  },
  playground(C, vr) {        // 8.5 x 6.5 m on wood-chip mulch: tower with roof and slide, swing set, spring riders
    const R = C.mulberry32(hash('play' + vr)), M = VM(70, 34, 54, 35, 27);
    const c1 = pick(R, [K.RED, K.BLUE, K.SGREEN]), c2 = pick(R, [K.YEL, K.ORANGE]), post = pick(R, [K.SGREEN, K.BLUE, K.POLE_D]);
    // tower: 4 posts, deck at 1.25 m, rails, pyramid roof
    const tx = -22, tz = -10;
    for (const [x, z] of [[0, 0], [13, 0], [0, 13], [13, 13]]) M.box(tx + x, 0, tz + z, tx + x + 1, 24, tz + z + 1, post);
    M.box(tx, 10, tz, tx + 14, 11, tz + 14, K.WOOD);
    M.box(tx, 11, tz, tx + 14, 15, tz + 1, c1); M.box(tx, 11, tz + 13, tx + 7, 15, tz + 14, c1);
    for (let i = 0; i < 4; ++i) M.box(tx - 1 + i * 2, 24 + i * 2, tz - 1 + i * 2, tx + 15 - i * 2, 26 + i * 2, tz + 15 - i * 2, c1);
    // slide down +x from the deck
    for (let i = 0; i < 18; ++i) { const y = 10 - Math.round(i * 9 / 18); M.box(tx + 14 + i, y, tz + 4, tx + 15 + i, y + 1, tz + 10, c2); M.box(tx + 14 + i, y + 1, tz + 3, tx + 15 + i, y + 3, tz + 4, c2); M.box(tx + 14 + i, y + 1, tz + 10, tx + 15 + i, y + 3, tz + 11, c2); }
    // ladder up -z side
    for (let y = 2; y < 10; y += 2) M.box(tx + 3, y, tz - 3, tx + 10, y + 1, tz - 2, K.STEEL);
    M.box(tx + 3, 0, tz - 3, tx + 4, 11, tz - 2, K.STEEL); M.box(tx + 9, 0, tz - 3, tx + 10, 11, tz - 2, K.STEEL);
    // swing set: A-frames at both ends, top bar, two swings
    const sx = 8, sz = 8, sw = 22;
    for (const x of [sx, sx + sw]) { for (let y = 0; y < 18; ++y) { const o = Math.round((18 - y) * 0.33); M.box(x, y, sz - o, x + 1, y + 1, sz - o + 1, K.STEEL); M.box(x, y, sz + o, x + 1, y + 1, sz + o + 1, K.STEEL); } }
    M.box(sx, 18, sz, sx + sw + 1, 19, sz + 1, K.STEEL);
    for (const x of [sx + 6, sx + 15]) { M.box(x, 4, sz, x + 1, 18, sz + 1, K.POLE_D); M.box(x + 2, 4, sz, x + 3, 18, sz + 1, K.POLE_D); M.box(x, 3, sz - 1, x + 3, 4, sz + 2, K.BLACK); }
    // spring riders
    for (const [x, z, c] of [[sx + 4, -18, c2], [sx + 14, -16, c1]]) { M.box(x, 0, z, x + 1, 4, z + 1, K.STEEL); M.box(x - 2, 4, z - 1, x + 3, 7, z + 2, c); M.box(x + 2, 7, z - 1, x + 3, 9, z + 2, c); }
    return { M, sc: 0.125, fp: [-4.4, -3.4, 4.4, 3.4] };
  },
  gazebo(C, vr) {            // 25 cm voxels: octagonal pavilion 5 m across on a low deck
    const R = C.mulberry32(hash('gazebo' + vr)), M = VM(26, 22, 26, 13, 13);
    const roof = pick(R, [K.SHINGLE, BM.SHINGLE_BROWN, K.AWN_G, K.SLATE]), wood = pick(R, [K.PWHITE, K.TRIM, K.WOOD]);
    oct(M, 0, 0, 10, 0, 2, wood);
    for (const [x, z] of [[-9, -5], [8, -5], [-9, 4], [8, 4], [-5, -9], [4, -9], [-5, 8], [4, 8]]) M.box(x, 2, z, x + 1, 12, z + 1, wood);
    oct(M, 0, 0, 10, 12, 13, wood);
    for (let i = 0; i < 6; ++i) oct(M, 0, 0, 11 - i * 2, 13 + i, 14 + i, roof);
    M.box(-1, 19, -1, 1, 21, 1, wood);
    return { M, sc: 0.25, fp: [-2.7, -2.7, 2.7, 2.7] };
  },
  hoop(C, vr) {              // basketball hoop on a pole (12.5 cm voxels); faces +z
    const M = VM(14, 32, 10, 7, 2);
    M.box(-1, 0, -2, 1, 26, 0, K.POLE_D); M.box(-1, 22, 0, 1, 24, 3, K.POLE_D);
    M.box(-6, 22, 3, 6, 30, 4, K.PWHITE); M.box(-2, 23, 3, 2, 26, 4, K.SRED);
    M.box(-2, 23, 4, 2, 24, 8, K.ORANGE);
    return { M, sc: 0.125, fp: [-0.8, -0.3, 0.8, 1.0] };
  },
  flagpole(C, vr) {          // 9.5 m flagpole on a concrete base (12.5 cm voxels)
    const M = VM(16, 80, 8, 4, 4);
    oct(M, 0, 0, 3, 0, 2, K.CONC); M.box(0, 2, 0, 1, 76, 1, K.PWHITE); M.box(-1, 76, -1, 2, 78, 2, K.YEL);
    for (let y = 0; y < 7; ++y) M.box(1, 66 + y, 0, 12, 67 + y, 1, y & 1 ? K.PWHITE : K.SRED);
    M.box(1, 69, 0, 6, 73, 1, BM.DOOR_NAVY);
    return { M, sc: 0.125, fp: [-0.4, -0.4, 0.4, 0.4] };
  },
  obelisk(C, vr) {           // 25 cm voxels: granite plinth, limestone shaft, pyramidion; ~6 m
    const R = C.mulberry32(hash('obelisk' + vr)), M = VM(12, 26, 12, 6, 6), st = pick(R, [K.LIME, K.CREAM, K.CONC]);
    M.box(-5, 0, -5, 5, 1, 5, K.GRAN_D); M.box(-4, 1, -4, 4, 3, 4, K.GRAN_D); M.box(-2, 3, -2, 2, 5, 2, st);
    for (let y = 5; y < 21; ++y) { const r = y < 13 ? 2 : 1; M.box(-r, y, -r, r, y + 1, r, st); }
    M.box(-1, 21, -1, 1, 23, 1, st); M.box(-1, 3, -3, 1, 4, -2, K.BRONZE);
    return { M, sc: 0.25, fp: [-1.3, -1.3, 1.3, 1.3] };
  },
  welcome(C, vr) {           // low sign wall with a sign board, piers and caps (12.5 cm voxels); reads towards +z
    const R = C.mulberry32(hash('welcome' + vr)), M = VM(34, 13, 6, 17, 3);
    const wall = pick(R, [K.BRICK, K.LIME, BM.BUFF, K.GRAN_D]), board = pick(R, [K.SGREEN, BM.DOOR_NAVY, K.WOOD]);
    M.box(-14, 0, -1, 14, 5, 2, wall);
    for (const x of [-17, 14]) { M.box(x, 0, -2, x + 3, 9, 3, wall); M.box(x, 9, -2, x + 3, 10, 3, K.CONC); }
    M.box(-13, 5, 0, 13, 12, 1, board);
    for (const [y, a, b] of [[10, -9, 9], [8, -11, 11], [6, -6, 6]]) M.box(a, y, 1, b, y + 1, 2, K.PWHITE);
    return { M, sc: 0.125, fp: [-2.2, -0.4, 2.2, 0.5] };
  },
  fountain(C, vr) {          // 25 cm voxels: octagonal basin 3.5 m across, water, a two-tier pedestal and jet
    const R = C.mulberry32(hash('fountain' + vr)), M = VM(16, 9, 16, 8, 8), st = pick(R, [K.CONC, K.LIME, K.GRAN_D]);
    oct(M, 0, 0, 7, 0, 2, st);
    // hollow the basin above the water line (y 1): clear the inner octagon at y = 1
    const r = 6, r2 = Math.round(r * 0.62);
    for (let z = -r; z < r; ++z) for (let x = -r; x < r; ++x) {
      if (!((x >= -r && x < r && z >= -r2 && z < r2) || (x >= -r2 && x < r2 && z >= -r && z < r))) continue;
      M.v[(1 * M.d + z + M.oz) * M.w + x + M.ox] = 0;
    }
    oct(M, 0, 0, 6, 0, 1, BM.WATER);
    M.box(-1, 1, -1, 1, 4, 1, st); oct(M, 0, 0, 3, 4, 5, st); M.box(-1, 5, -1, 1, 6, 1, st); M.box(0, 6, 0, 1, 8, 1, K.PWHITE);
    return { M, sc: 0.25, fp: [-1.9, -1.9, 1.9, 1.9] };
  },
  plaque(C, vr) {            // memorial stone with a bronze plaque (12.5 cm voxels)
    const M = VM(12, 8, 6, 6, 3);
    M.box(-5, 0, -2, 5, 6, 2, K.GRAN_D); M.box(-4, 6, -2, 4, 7, 2, K.GRAN_D); M.box(-3, 2, 2, 3, 5, 3, K.BRONZE);
    return { M, sc: 0.125, fp: [-0.7, -0.3, 0.7, 0.4] };
  }
};
function itemModel(C, name, vr) {
  return cached('i:' + name + ':' + (vr || 0), () => { const it = ITEMS[name](C, vr || 0); it.mesh = C.meshVoxels3D(it.M); it.M = null; return it; });
}

// ------------------------------------------------------------------------------------------ the kit
function parkKit(K0) {
  const { PL, C, blocks, sub, mb, hs, voxel } = K0, Ra = K0.R;
  if (!sub || !blocks || !PL || !PL.base) return null;
  const t0 = Date.now(), q0 = mb.quads;
  const PV = C.PV, lab = blocks.lab, cell = PL.cell, nx = PL.nx, nz = PL.nz;
  const seed0 = (PL.seed || 1) >>> 0;
  const stats = { regions: 0, park: 0, grove: 0, wedge: 0, plaza: 0, buffer: 0, trees: 0, bushes: 0, items: 0, quads: 0, ms: 0, area: 0 };
  const regionsOut = [];
  const allTrees = [], allBushes = [], allSlots = Object.assign(new Map(), { maxR: 0 });   // every component's trees / bushes (beds on a wedge nose reach past their component); allSlots: placed copies by 16 m cell (see sink)

  // ---- emission: mesh m (meshVoxels3D, PV units) at world (x, y above yard level, z), yaw, voxel sizes sh / sv (m)
  const quadW = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, Nx, Ny, Nz) => {
    const v = voxel, y0 = hs;
    const Ax = ax / v, Ay = (y0 + ay) / v, Az = az / v, Bx = bx / v, By = (y0 + by) / v, Bz = bz / v;
    const Cx = cx / v, Cy = (y0 + cy) / v, Cz = cz / v, Dx = dx / v, Dy = (y0 + dy) / v, Dz = dz / v;
    const ux = Bx - Ax, uy = By - Ay, uz = Bz - Az, vx = Cx - Ax, vy = Cy - Ay, vz = Cz - Az;
    const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
    if (crx * Nx + cry * Ny + crz * Nz < 0) mb.quadN(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz, Bx, By, Bz, m, Nx, Ny, Nz);
    else mb.quadN(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz, Dx, Dy, Dz, m, Nx, Ny, Nz);
  };
  const put = (m, x, y, z, yaw, sh, sv) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), P = m.pos, fh = sh / PV, fv = (sv || sh) / PV;
    // dev hook (dev/overlap.js): every placed copy with its model-local -> world (m) map
    if (L.debugPlace) L.debugPlace({ kit: 'park', mesh: m, map: (u, yy, v) => [x + (u * c - v * s) * fh, hs + y + yy * fv, z + (u * s + v * c) * fh] });
    const X = new Float64Array(4), Y = new Float64Array(4), Z = new Float64Array(4);
    for (let q = 0; q < m.quads; ++q) {
      const n = m.nrm[q * 4], o = q * 12;
      if (n === 5 && P[o + 1] === 0 && P[o + 4] === 0 && P[o + 7] === 0 && P[o + 10] === 0) continue;   // rests on the ground
      for (let i = 0; i < 4; ++i) {
        const u = P[o + i * 3] * fh, v = P[o + i * 3 + 2] * fh;
        X[i] = x + u * c - v * s; Y[i] = y + P[o + i * 3 + 1] * fv; Z[i] = z + u * s + v * c;
      }
      const N = NV[n];
      quadW(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], X[3], Y[3], Z[3], m.mat[q * 4], N[0] * c - N[2] * s, N[1], N[0] * s + N[2] * c);
    }
  };
  // flat pad (box without bottom): centre (x, z), yaw, half sizes (along / across), y0..y1 (m above yard)
  const pad = (x, z, yaw, hu, hv, y0, y1, m, tag) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    if (L.debugPlace) L.debugPlace({ kit: 'park', pad: tag || 'pad', x, z, yaw, hu, hv, y1: hs + y1 });
    const W = (u, v) => [x + u * c - v * s, z + u * s + v * c];
    const p = [W(-hu, -hv), W(hu, -hv), W(hu, hv), W(-hu, hv)];
    quadW(p[0][0], y1, p[0][1], p[1][0], y1, p[1][1], p[2][0], y1, p[2][1], p[3][0], y1, p[3][1], m, 0, 1, 0);
    const sides = [[0, 1, 0, -1], [1, 2, 1, 0], [2, 3, 0, 1], [3, 0, -1, 0]];
    for (const [a, b, nu, nv] of sides)
      quadW(p[a][0], y0, p[a][1], p[b][0], y0, p[b][1], p[b][0], y1, p[b][1], p[a][0], y1, p[a][1], m, nu * c - nv * s, 0, nu * s + nv * c);
  };

  // ---- lots per region
  const lotsBy = new Map();
  for (const Lt of sub.lots) { let a = lotsBy.get(Lt.g.id); if (!a) lotsBy.set(Lt.g.id, a = []); a.push(Lt); }
  const roads = PL.net.roads;

  for (const b of sub.blocks) {
    const g = b.g;
    if (!g.cells || !g.cells.length) continue;
    // ---- raster (PL cells, 0.5 m), bbox + 4 cells
    let i0 = 1e9, i1 = -1, j0 = 1e9, j1 = -1;
    for (const q of g.cells) { const i = q % nx, j = (q / nx) | 0; if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    i0 -= 4; j0 -= 4; i1 += 4; j1 += 4;
    const W = i1 - i0 + 1, H = j1 - j0 + 1, N = W * H;
    const X = (i) => PL.x0 + (i0 + i + 0.5) * cell, Z = (j) => PL.z0 + (j0 + j + 0.5) * cell;
    const inR = new Uint8Array(N);
    for (const q of g.cells) { const i = q % nx - i0, j = ((q / nx) | 0) - j0; inR[j * W + i] = 1; }
    const lots = lotsBy.get(g.id) || [];
    const lotId = new Int16Array(N).fill(-1);
    lots.forEach((Lt, li) => {
      const m = 0.35;
      const cs = [[-m, -m], [Lt.w + m, -m], [-m, Lt.d + m], [Lt.w + m, Lt.d + m]].map(([a, bb]) => [Lt.O[0] + a * Lt.e1[0] + bb * Lt.e2[0], Lt.O[1] + a * Lt.e1[1] + bb * Lt.e2[1]]);
      const xa = Math.min(...cs.map(p => p[0])), xb = Math.max(...cs.map(p => p[0])), za = Math.min(...cs.map(p => p[1])), zb = Math.max(...cs.map(p => p[1]));
      const ia = Math.max(0, Math.floor((xa - PL.x0) / cell) - i0), ib = Math.min(W - 1, Math.ceil((xb - PL.x0) / cell) - i0);
      const ja = Math.max(0, Math.floor((za - PL.z0) / cell) - j0), jb = Math.min(H - 1, Math.ceil((zb - PL.z0) / cell) - j0);
      for (let j = ja; j <= jb; ++j) for (let i = ia; i <= ib; ++i) {
        const dx = X(i) - Lt.O[0], dz = Z(j) - Lt.O[1], a = dx * Lt.e1[0] + dz * Lt.e1[1], bb = dx * Lt.e2[0] + dz * Lt.e2[1];
        if (a > -m && a < Lt.w + m && bb > -m && bb < Lt.d + m) lotId[j * W + i] = li;
      }
    });
    // distances (m, chamfer): to the street side (outside the block), to the nearest lot (+ its index)
    const dOut = chamfer(W, H, (k) => !inR[k], cell);
    const lotNear = new Int16Array(N).fill(-1);
    const dLot = chamfer(W, H, (k) => lotId[k] >= 0, cell, lotId, lotNear);
    const BAND = 1.0;
    const free = new Uint8Array(N);
    for (let k = 0; k < N; ++k) free[k] = inR[k] && lotId[k] < 0 && dOut[k] >= BAND ? 1 : 0;
    // ---- components
    const comp = new Int32Array(N).fill(-1), comps = [];
    for (let k = 0; k < N; ++k) {
      if (!free[k] || comp[k] >= 0) continue;
      const id = comps.length, cells = [k], st = [k]; comp[k] = id;
      while (st.length) {
        const q = st.pop(), i = q % W;
        for (const r of [i > 0 ? q - 1 : -1, i < W - 1 ? q + 1 : -1, q >= W ? q - W : -1, q + W < N ? q + W : -1])
          if (r >= 0 && free[r] && comp[r] < 0) { comp[r] = id; cells.push(r); st.push(r); }
      }
      comps.push({ id, cells });
    }
    const used = new Uint8Array(N);                       // 1 path / pad / item footprint
    const kAt = (x, z) => { const i = Math.floor((x - PL.x0) / cell) - i0, j = Math.floor((z - PL.z0) / cell) - j0; return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i; };
    let plazaDone = false;
    const slots = allSlots;                              // offsets of the placed copies (see sink), shared by every block: crowns and beds reach over block edges
    comps.sort((p, q) => q.cells.length - p.cells.length);
    for (const cp of comps) {
      const area = cp.cells.length * cell * cell;
      if (area < 12) continue;
      const dEdge = chamfer(W, H, (k) => comp[k] !== cp.id, cell);
      let mx = 0, mz = 0, T = 0, kT = cp.cells[0];
      for (const k of cp.cells) { mx += X(k % W); mz += Z((k / W) | 0); if (dEdge[k] > T) { T = dEdge[k]; kT = k; } }
      mx /= cp.cells.length; mz /= cp.cells.length;
      let sxx = 0, szz = 0, sxz = 0;
      for (const k of cp.cells) { const dx = X(k % W) - mx, dz = Z((k / W) | 0) - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
      sxx /= cp.cells.length; szz /= cp.cells.length; sxz /= cp.cells.length;
      const tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
      let ax = Math.abs(sxz) > 1e-9 ? [l1 - szz, sxz] : sxx >= szz ? [1, 0] : [0, 1];
      { const l = Math.hypot(ax[0], ax[1]); ax = [ax[0] / l, ax[1] / l]; }
      const len = Math.sqrt(12 * l1), wid = Math.sqrt(12 * l2);
      // frontage and the uses around it
      let front = 0; const near = {};
      for (const k of cp.cells) {
        if (dOut[k] < BAND + 0.75) ++front;
        if (dLot[k] < 3 && lotNear[k] >= 0) { const u = lots[lotNear[k]].use; near[u] = (near[u] || 0) + 1; }
      }
      front *= cell;
      const nearCom = Object.keys(near).filter(u => u !== 'house').reduce((s, u) => s + near[u], 0), nearHouse = near.house || 0;
      const zone = b.use === 'residential' ? 'residential' : nearHouse > nearCom * 1.5 ? 'residential' : b.use;
      // wedge: elongated, one end tapering, that end on the street
      const NS = 8, cnt = new Array(NS).fill(0), fr = new Array(NS).fill(0);
      let pmin = 1e9, pmax = -1e9;
      for (const k of cp.cells) { const p = (X(k % W) - mx) * ax[0] + (Z((k / W) | 0) - mz) * ax[1]; if (p < pmin) pmin = p; if (p > pmax) pmax = p; }
      for (const k of cp.cells) {
        const p = (X(k % W) - mx) * ax[0] + (Z((k / W) | 0) - mz) * ax[1], s = Math.min(NS - 1, Math.floor((p - pmin) / (pmax - pmin + 1e-9) * NS));
        cnt[s]++; if (dOut[k] < BAND + 0.75) fr[s]++;
      }
      const cmax = Math.max(...cnt), endA = cnt[0] + cnt[1], endB = cnt[NS - 1] + cnt[NS - 2];
      let wedge = null;
      if (len / wid >= 1.8 && area >= 200 && T >= 2.5) {
        const tipB = endB < endA;
        const e = tipB ? endB : endA, eo = tipB ? endA : endB;
        if (e <= 0.45 * cmax && e < 0.5 * eo) {
          // a real tip: the frontage of the narrow end runs along two different streets (they meet at the tip)
          const rs = new Map();
          for (const k of cp.cells) {
            if (dOut[k] >= BAND + 0.75) continue;
            const p = (X(k % W) - mx) * ax[0] + (Z((k / W) | 0) - mz) * ax[1], s = Math.min(NS - 1, Math.floor((p - pmin) / (pmax - pmin + 1e-9) * NS));
            if (tipB ? s < NS - 2 : s > 1) continue;
            const rid = roadNear(X(k % W), Z((k / W) | 0));
            if (rid >= 0) rs.set(rid, (rs.get(rid) || 0) + 1);
          }
          if ([...rs.values()].filter(v => v >= 3).length >= 2) wedge = tipB ? 1 : -1;
        }
      }
      let type;
      if (wedge && area >= 150) type = 'wedge';
      else if (zone === 'residential') type = area >= 650 && T >= 7 ? 'park' : 'grove';
      else if (zone === 'transition' && area >= 900 && T >= 8) type = 'park';
      else type = front >= 8 && T >= 2.5 && area >= 120 && !plazaDone ? 'plaza' : 'buffer';
      if (type === 'plaza') plazaDone = true;                   // one pocket plaza per block, the rest landscaped
      const Rc = C.mulberry32(((g.sid !== undefined ? g.sid : g.id) * 7919 + cp.id * 104729 + seed0 * 31337 + 0x9a7c) >>> 0);
      const info = { block: g.id, comp: cp.id, zone, type, area: Math.round(area), c: [+mx.toFixed(1), +mz.toFixed(1)], T: +T.toFixed(1), len: Math.round(len), wid: Math.round(wid), front: Math.round(front), trees: 0, bushes: 0, items: [] };
      const S = { slots, inR, cp, comp, dOut, dLot, lotNear, dEdge, used, W, H, X, Z, kAt, lots, R: Rc, info, trees: [], bushes: [], tall: [] };
      fill(S, type, { ax, mx, mz, kT, pmin, pmax, wedge, g, b });
      if (L.parkDebug) info.treeList = S.trees.map(t => [+t.x.toFixed(2), +t.z.toFixed(2), +t.rc.toFixed(2), +t.base.toFixed(2), t.sp]);
      stats[type]++; stats.regions++; stats.area += area;
      stats.trees += info.trees; stats.bushes += info.bushes; stats.items += info.items.length;
      regionsOut.push(info);
    }
  }

  // ---------------------------------------------------------------------------------- helpers on a component
  // Vertical offset of a placed copy (m, <= 0: sunk into the ground). Every model face lies at offset + k * 12.5 cm,
  // so two overlapping copies must not share an offset (their horizontal faces would be coplanar): each copy takes
  // the first free slot (4 mm apart, 3..103 mm deep) among the copies it overlaps, preferring one >= 2.1 cm (mod 12.5 cm)
  // from all of them (low bush / bed tops of crowded copies stay outside groundfight's 2 cm, L.sinkPick); slots in phase with the yard kit
  // (k / 16 + 1 / 32 voxel = 7.8 mm mod 15.6 mm) are skipped, so crowns reaching over a lot line stay clear of it too.
  function sink(S, x, z, r) {
    const taken = new Set(), G = S.slots, gx = Math.floor(x / 16), gz = Math.floor(z / 16), e = Math.ceil((r + G.maxR + 0.3) / 16);
    for (let dz = -e; dz <= e; ++dz) for (let dx = -e; dx <= e; ++dx) for (const o of G.get((gx + dx) + ',' + (gz + dz)) || [])
      if (Math.abs(o[0] - x) < r + o[2] + 0.3 && Math.abs(o[1] - z) < r + o[2] + 0.3) taken.add(o[3]);
    const st = Math.floor(S.R() * SLOTS.length), si = L.sinkPick(SLOTS, taken, st), key = gx + ',' + gz;
    let a = G.get(key); if (!a) G.set(key, a = []);
    a.push([x, z, r, si]); G.maxR = Math.max(G.maxR, r);
    return -SLOTS[si];
  }
  function roadNear(x, z) {                          // id of the street next to a block-edge point (-1: none)
    for (let r = 0.5; r <= 3; r += 0.5) for (let a = 0; a < 8; ++a) {
      const i = Math.floor((x + Math.cos(a * 0.785) * r - PL.x0) / cell), j = Math.floor((z + Math.sin(a * 0.785) * r - PL.z0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const q = j * nx + i;
      if (PL.base[q] === 3 || PL.base[q] === 4) { const r0 = roads[PL.near[q]]; return r0 && r0.P.id !== 'alley' ? PL.near[q] : -1; }
    }
    return -1;
  }
  function cellOk(S, x, z, need, band) {             // inside the component, not used, need = min distance to its edge
    const k = S.kAt(x, z);
    if (band) return k >= 0 && S.inR[k] && !S.used[k] && S.dLot[k] >= 0.6 && S.dOut[k] >= band;   // also on the street band
    return k >= 0 && S.comp[k] === S.cp.id && !S.used[k] && S.dEdge[k] >= (need || 0);
  }
  function houseClear(S, x, z, r) {
    for (const Lt of S.lots) {
      if (Lt.use !== 'house' || !Lt.H) continue;
      const dx = x - Lt.O[0], dz = z - Lt.O[1], a = dx * Lt.e1[0] + dz * Lt.e1[1], b = dx * Lt.e2[0] + dz * Lt.e2[1], H = Lt.H;
      const da = Math.max(H.x0 - a, 0, a - H.x0 - H.w), db = Math.max(H.z0 - b, 0, b - H.z0 - H.d);
      if (Math.hypot(da, db) < r) return false;
    }
    return true;
  }
  function lotOvh(S, k) { const li = S.lotNear[k]; return li >= 0 && S.lots[li].use === 'house' ? 1.4 : 0.0; }
  // oriented rectangle samples (every 0.5 m): all must satisfy ok(x, z)
  function rectAll(cx, cz, yaw, u0, v0, u1, v1, ok) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nu = Math.max(1, Math.ceil((u1 - u0) / 0.5)), nv = Math.max(1, Math.ceil((v1 - v0) / 0.5));
    for (let a = 0; a <= nu; ++a) for (let bb = 0; bb <= nv; ++bb) {
      const u = u0 + (u1 - u0) * a / nu, v = v0 + (v1 - v0) * bb / nv;
      if (!ok(cx + u * c - v * s, cz + u * s + v * c)) return false;
    }
    return true;
  }
  function markRect(S, cx, cz, yaw, u0, v0, u1, v1) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nu = Math.max(1, Math.ceil((u1 - u0) / 0.25)), nv = Math.max(1, Math.ceil((v1 - v0) / 0.25));
    for (let a = 0; a <= nu; ++a) for (let bb = 0; bb <= nv; ++bb) {
      const u = u0 + (u1 - u0) * a / nu, v = v0 + (v1 - v0) * bb / nv, k = S.kAt(cx + u * c - v * s, cz + u * s + v * c);
      if (k >= 0) S.used[k] = 1;
    }
  }
  function placeItem(S, name, vr, x, z, yaw, margin, band) {
    const it = itemModel(C, name, vr), f = it.fp, mg = margin === undefined ? 0.3 : margin;
    if (!rectAll(x, z, yaw, f[0] - mg, f[1] - mg, f[2] + mg, f[3] + mg, (px, pz) => cellOk(S, px, pz, 0.3, band))) return false;
    if (S.trees.some(t => Math.hypot(t.x - x, t.z - z) < 0.6 + Math.max(-f[0], f[2], -f[1], f[3]) && (it.tall || t.base < 3.2))) return false;
    markRect(S, x, z, yaw, f[0] - 0.2, f[1] - 0.2, f[2] + 0.2, f[3] + 0.2);
    put(it.mesh, x, sink(S, x, z, Math.max(-f[0], f[2], -f[1], f[3])), z, yaw, it.sc, it.sc);
    S.info.items.push(name);
    return it;
  }
  // trees: largest fitting variant of the preferred species; dens = spacing factor (crowns overlap below 1)
  function tryTree(S, x, z, spList, dens, opts) {
    opts = opts || {};
    const k = S.kAt(x, z);
    if (k < 0 || S.comp[k] !== S.cp.id || S.used[k]) return null;
    const dStreet = S.dOut[k] - 0.25, dl = S.dLot[k] - 0.3;
    if (dStreet < (opts.streetMin || 1.6) || dl < 0.5) return null;
    for (const sp of spList) for (let tries = 0; tries < 3; ++tries) {
      const T = treeModel(C, sp, Math.floor(S.R() * 4));
      const rc = T.rc;
      if (rc > dStreet + (T.base >= 3.5 ? 1.2 : 0.35)) continue;      // high crowns may reach over the back of the sidewalk
      if (rc > dl + (T.base >= 3.5 ? lotOvh(S, k) : 0)) continue;
      if (rc > dl && !houseClear(S, x, z, rc + 0.8)) continue;       // a crown over a yard stays well clear of the house
      if (opts.avoid && opts.avoid.some(a => Math.hypot(a[0] - x, a[1] - z) < a[2] + rc)) continue;
      // trunk clear of used cells (paths, pads, items) by 0.7 m; low crowns clear of them entirely
      const clr = T.base < 2.6 ? rc * 0.8 : 0.7;
      let ok = true;
      for (const [du, dv] of [[0, 0], [clr, 0], [-clr, 0], [0, clr], [0, -clr]]) { const kk = S.kAt(x + du, z + dv); if (kk < 0 || S.used[kk]) { ok = false; break; } }
      if (!ok) continue;
      if (S.trees.some(t => Math.hypot(t.x - x, t.z - z) < dens * (t.rc + rc) || Math.hypot(t.x - x, t.z - z) < 1.4)) continue;
      if (allBushes.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 0.45)) continue;    // trunk clear of earlier bushes (dev/overlap.js)
      if (S.tall.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] + rc)) continue;
      const tr = { x, z, rc, base: T.base, sp };
      S.trees.push(tr); allTrees.push(tr);
      put(T.mesh, x, sink(S, x, z, rc), z, S.R() * 6.283, BV, BV);
      S.info.trees++;
      return tr;
    }
    return null;
  }
  function tryBush(S, x, z, kinds, opts) {
    opts = opts || {};
    const k = S.kAt(x, z);
    const inside = (kk) => kk >= 0 && (opts.band ? S.inR[kk] && S.dLot[kk] > 0 : S.comp[kk] === S.cp.id);
    if (!inside(k) || S.used[k]) return false;
    const kind = pick(S.R, kinds), Bm = bushModel(C, kind, Math.floor(S.R() * 5)), r = Bm.r;
    if (S.dOut[k] - 0.25 < r + (opts.streetMin || 0.6) || S.dLot[k] - 0.3 < r + 0.15) return false;
    for (const [du, dv] of [[r, 0], [-r, 0], [0, r], [0, -r]]) { const kk = S.kAt(x + du, z + dv); if (!inside(kk) || S.used[kk]) return false; }
    if (S.trees.some(t => Math.hypot(t.x - x, t.z - z) < 0.45 + r)) return false;
    if (S.bushes.some(o => Math.hypot(o[0] - x, o[1] - z) < (opts.dens || 0.85) * (o[2] + r))) return false;
    if (S.tall.some(t => Math.hypot(t[0] - x, t[1] - z) < t[2] + r)) return false;
    if (allTrees.some(t => Math.hypot(t.x - x, t.z - z) < 0.45 + r)) return false;
    S.bushes.push([x, z, r]); allBushes.push([x, z, r]);
    put(Bm.mesh, x, sink(S, x, z, r), z, S.R() * 6.283, 0.125, 0.125);
    S.info.bushes++;
    return true;
  }
  // candidate points: a jittered grid over the component, shuffled deterministically
  function candidates(S, step, filter) {
    const out = [], R = S.R;
    const xs = S.cp.cells.map(k => S.X(k % S.W)), zs = S.cp.cells.map(k => S.Z((k / S.W) | 0));
    let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity;                 // no spread: huge components (scale 5) overflow the stack
    for (let i = 0; i < xs.length; ++i) { if (xs[i] < xa) xa = xs[i]; if (xs[i] > xb) xb = xs[i]; if (zs[i] < za) za = zs[i]; if (zs[i] > zb) zb = zs[i]; }
    for (let z = za; z <= zb; z += step) for (let x = xa; x <= xb; x += step) {
      const px = x + (R() - 0.5) * step * 0.9, pz = z + (R() - 0.5) * step * 0.9, k = S.kAt(px, pz);
      if (k < 0 || S.comp[k] !== S.cp.id) continue;
      if (filter && !filter(k, px, pz)) continue;
      out.push([px, pz, R(), k]);
    }
    return out.sort((a, b) => a[2] - b[2]);
  }
  // woods: big trees first (largest crowns first), then understory trees, then undergrowth
  function forest(S, filter, o) {
    o = o || {};
    const big = o.species || ['oak', 'oak', 'maple', 'tulip', 'spruce', 'pine', 'maple', 'spruce'];
    for (const [x, z] of candidates(S, o.step || 3.2, filter)) {
      const sp = pick(S.R, big), alt = sp === 'spruce' || sp === 'pine' ? ['spruce', 'young'] : ['maple', 'young'];
      tryTree(S, x, z, [sp].concat(alt), o.dens || 0.6, o);
    }
    // street-side trees where the big crowns do not fit (near the sidewalk)
    for (const [x, z] of candidates(S, 3, (k, x, z) => S.dOut[k] < 5.5 && (!filter || filter(k, x, z)))) tryTree(S, x, z, ['street'], o.dens ? o.dens + 0.08 : 0.68, { streetMin: 1.15, avoid: o.avoid });
    if (o.under !== false) {
      for (const [x, z] of candidates(S, 2.6, filter)) tryTree(S, x, z, ['young', 'spruce'], 0.55, { streetMin: 1.4, avoid: o.avoid });
      for (const [x, z] of candidates(S, o.bushStep || 1.7, filter)) tryBush(S, x, z, o.bushes || ['shrub', 'shrub', 'mound', 'shrub'], { dens: 0.8 });
    }
  }
  // the street side of a component: nearest road id and the outward normal at a point near the block edge
  function edgeInfo(S, x, z) {
    let best = null;
    for (let r = 0.5; r <= 6 && !best; r += 0.5) for (let a = 0; a < 16; ++a) {
      const px = x + Math.cos(a * 0.3927) * r, pz = z + Math.sin(a * 0.3927) * r;
      const i = Math.floor((px - PL.x0) / cell), j = Math.floor((pz - PL.z0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const q = j * nx + i;
      if (PL.base[q] === 3 || PL.base[q] === 4) { const d = Math.hypot(px - x, pz - z); if (!best || d < best.d) best = { d, rid: PL.near[q], nx: (px - x) / d, nz: (pz - z) / d }; }
    }
    if (!best) return null;
    const r = roads[best.rid];
    if (r && r.pts && r.pts.length > 1) {
      const pr = L.roadProject(r, x, z), p = L.roadAt(r, pr.s);
      let nx0 = -p[3], nz0 = p[2];                                   // left normal of the road
      if (nx0 * best.nx + nz0 * best.nz < 0) { nx0 = -nx0; nz0 = -nz0; }
      best.nx = nx0; best.nz = nz0; best.tx = p[2]; best.tz = p[3];
    } else { best.tx = -best.nz; best.tz = best.nx; }
    return best;                                                     // (nx, nz): towards the street
  }
  // distance from (x, z) along (nx, nz) to ~6 cm short of the back of the sidewalk (street raster), searched around t0
  function lawnEnd(x, z, nx0, nz0, t0) {
    if (Ra && Ra.classify) {
      const o2 = {}, cls = [0, 0], MAT = C.MAT;
      for (let u = Math.max(0, t0 - 1); u < t0 + 2; u += 0.04) {
        Ra.classify(x + nx0 * u, z + nz0 * u, o2, cls);
        if (cls[1] !== MAT.YARD && cls[1] !== MAT.PLOT) return u - 0.06;
      }
    }
    return t0 + 0.25;
  }
  // a path stub from a component point out to the sidewalk; returns the outer end or null
  function stubOut(S, x, z, ei, wpath) {
    let t = 0;
    for (; t < 8; t += 0.1) {
      const px = x + ei.nx * t, pz = z + ei.nz * t, k = S.kAt(px, pz);
      if (k < 0 || S.dOut[k] === 0) break;
      // never across a lot
      for (const s of [-wpath / 2 - 0.3, 0, wpath / 2 + 0.3]) { const kk = S.kAt(px - ei.nz * s, pz + ei.nx * s); if (kk >= 0 && S.dLot[kk] < 0.4) return null; }
    }
    if (t >= 8) return null;
    const u = lawnEnd(x, z, ei.nx, ei.nz, t);
    return [x + ei.nx * u, z + ei.nz * u];
  }
  function pathSeg(S, a, b, w, m, h, flushA) {           // flushA: a is the sidewalk end (no overrun there)
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 0.05) return;
    const yaw = Math.atan2(dz, dx), e0 = flushA ? 0 : w * 0.15, e1 = w * 0.15, c = (e1 - e0) / 2;
    pad((a[0] + b[0]) / 2 + dx / l * c, (a[1] + b[1]) / 2 + dz / l * c, yaw, l / 2 + (e0 + e1) / 2, w / 2, -0.02, h || 0.045, m, 'path');
    markRect(S, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, yaw, -l / 2 - 0.3, -w / 2 - 0.25, l / 2 + 0.3, w / 2 + 0.25);
  }
  function segClear(S, a, b, w) {                    // a straight path inside the component (or its street band)
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), n = Math.ceil(l / 0.4);
    for (let i = 0; i <= n; ++i) {
      const x = a[0] + dx * i / n, z = a[1] + dz * i / n;
      for (const s of [-w / 2, 0, w / 2]) { const k = S.kAt(x - dz / l * s, z + dx / l * s); if (k < 0 || S.dLot[k] < 0.5 || S.used[k] && i > 0 && i < n) return false; if (S.comp[k] !== S.cp.id && S.dOut[k] >= 1.0) return false; }
    }
    return true;
  }
  // street entries of a component: frontage cells, grouped per road, best (deepest behind) first
  function entries(S, minDepth) {
    const byRoad = new Map();
    for (const k of S.cp.cells) {
      if (S.dOut[k] > 1.6 || S.dEdge[k] < 0.75 || ((k % S.W) + ((k / S.W) | 0)) % 3) continue;
      const x = S.X(k % S.W), z = S.Z((k / S.W) | 0), ei = edgeInfo(S, x, z);
      if (!ei) continue;
      // depth behind the entry along the inward normal
      let d = 0; while (d < 30 && cellOk(S, x - ei.nx * (d + 0.5), z - ei.nz * (d + 0.5), 0.9)) d += 0.5;
      if (d < minDepth) continue;
      const e = { x, z, ei, d, sc: d + S.dEdge[k] * 2 + S.R() * 0.5 };
      const a = byRoad.get(ei.rid); if (!a || e.sc > a.sc) byRoad.set(ei.rid, e);
    }
    return [...byRoad.values()].sort((a, b) => b.sc - a.sc);
  }

  // ---------------------------------------------------------------------------------- fills
  function fill(S, type, F) {
    if (type === 'grove') return fillGrove(S);
    if (type === 'park') return fillPark(S, F);
    if (type === 'wedge') return fillWedge(S, F);
    if (type === 'plaza') return fillPlaza(S, F);
    return fillBuffer(S);
  }
  function fillGrove(S) {
    const T = S.info.T;
    if (T < 1.6) { for (const [x, z] of candidates(S, 1.4)) tryBush(S, x, z, ['shrub', 'mound', 'box'], { dens: 0.9 }); for (const [x, z] of candidates(S, 2.5)) tryTree(S, x, z, ['young', 'street'], 0.6, { streetMin: 1.3 }); return; }
    forest(S, null, { dens: 0.52, step: 2.5 });
  }
  function fillBuffer(S) {
    // landscaped: deciduous shade trees and some evergreens, clipped shrubs, flowers at the street corners
    forest(S, null, { species: ['maple', 'oak', 'tulip', 'maple', 'spruce', 'red'], dens: 0.72, step: 3.4, bushes: ['box', 'shrub', 'mound', 'flowers'], bushStep: 2.2 });
  }
  function fillPark(S, F) {
    const R = S.R, info = S.info;
    // hub: the most interior point
    const kT = F.kT, hx = S.X(kT % S.W), hz = S.Z((kT / S.W) | 0);
    const ens = entries(S, 6);
    const ent = [];
    if (ens.length) ent.push(ens[0]);
    for (const e of ens.slice(1)) if (Math.hypot(e.x - ent[0].x, e.z - ent[0].z) > 18) { ent.push(e); break; }
    const yaw0 = ent.length ? Math.atan2(ent[0].ei.tz, ent[0].ei.tx) : Math.atan2(F.ax[1], F.ax[0]);
    // hub: gazebo on a round pad, or a flower circle with benches
    const PW = 1.7, pm = R() < 0.5 ? K.PATH : K.PLAZA;
    const hubR = info.T >= 9 ? 4.2 : 3.2;
    const tall = [];
    let paths = 0;
    for (const e of ent) {
      const out = stubOut(S, e.x, e.z, e.ei, PW);
      if (!out) continue;
      // a straight leg to the hub, else a dog-leg through a point behind the entry
      const a = [e.x, e.z], h = [hx, hz];
      if (segClear(S, a, h, PW)) { pathSeg(S, out, a, PW, pm, 0, true); pathSeg(S, a, h, PW, pm); paths++; continue; }
      const mid = [e.x - e.ei.nx * Math.min(e.d - 1, 10), e.z - e.ei.nz * Math.min(e.d - 1, 10)];
      if (segClear(S, a, mid, PW) && segClear(S, mid, h, PW)) { pathSeg(S, out, a, PW, pm, 0, true); pathSeg(S, a, mid, PW, pm); pathSeg(S, mid, h, PW, pm); paths++; }
    }
    info.paths = paths;
    // hub pad (octagon of two crossed pads)
    pad(hx, hz, yaw0, hubR, hubR * 0.62, -0.02, 0.05, pm); pad(hx, hz, yaw0, hubR * 0.62, hubR, -0.02, 0.05, pm);
    markRect(S, hx, hz, yaw0, -hubR - 0.3, -hubR - 0.3, hubR + 0.3, hubR + 0.3);
    if (hubR >= 4) {
      const gz = itemModel(C, 'gazebo', Math.floor(R() * 3));
      put(gz.mesh, hx, 0.05 + sink(S, hx, hz, 3), hz, yaw0 + (R() < 0.5 ? 0 : Math.PI / 2), 0.25, 0.25);
      S.tall.push([hx, hz, 3.2]); info.items.push('gazebo');
    } else {
      const fl = bushModel(C, 'flowers', Math.floor(R() * 5));
      put(fl.mesh, hx, 0.05 + sink(S, hx, hz, 1.2), hz, R() * 6.28, 0.18, 0.125); info.items.push('flowerbed');
      for (let i = 0; i < 4; ++i) {                                   // benches round the circle, facing in
        const an = yaw0 + Math.PI / 4 + i * Math.PI / 2, bx = hx + Math.cos(an) * (hubR + 1.15), bz = hz + Math.sin(an) * (hubR + 1.15);
        placeItem(S, 'bench', Math.floor(R() * 3), bx, bz, faceYaw(-Math.cos(an), -Math.sin(an)), 0.1);
      }
    }
    S.tall.push([hx, hz, hubR]);
    // facilities: playground and / or half court near the hub, square to the street
    const want = [];
    if (info.area >= 900 || R() < 0.7) want.push('playground');
    if (info.area >= 1400 || (info.area >= 1000 && R() < 0.5)) want.push('court');
    if (!want.length) want.push('picnic');
    const cands = S.cp.cells.filter(k => S.dEdge[k] >= 3 && !S.used[k]).map(k => [S.X(k % S.W), S.Z((k / S.W) | 0)])
      .sort((p, q) => Math.hypot(p[0] - hx, p[1] - hz) - Math.hypot(q[0] - hx, q[1] - hz));
    for (const w of want) {
      const hu = w === 'playground' ? 4.9 : w === 'court' ? 5.6 : 3, hv = w === 'playground' ? 3.9 : w === 'court' ? 5.1 : 2.6;
      for (let i = 0; i < cands.length; i += 3) {
        const [cx, cz] = cands[i];
        if (Math.hypot(cx - hx, cz - hz) < hubR + Math.min(hu, hv) + 1.5) continue;
        let done = false;
        for (const yaw of [yaw0, yaw0 + Math.PI / 2]) {
          if (!rectAll(cx, cz, yaw, -hu - 0.8, -hv - 0.8, hu + 0.8, hv + 0.8, (x, z) => cellOk(S, x, z, 0.6) && S.dOut[S.kAt(x, z)] >= 2.5)) continue;
          if (w === 'playground') {
            pad(cx, cz, yaw, hu, hv, -0.02, 0.06, K.SOIL); pad(cx, cz, yaw, hu - 0.25, hv - 0.25, -0.02, 0.09, R() < 0.5 ? K.WOOD : BM.WOOD);
            const pg = itemModel(C, 'playground', Math.floor(R() * 3));
            put(pg.mesh, cx, 0.09 + sink(S, cx, cz, 5), cz, yaw + (R() < 0.5 ? 0 : Math.PI), 0.125, 0.125);
            S.tall.push([cx, cz, Math.hypot(hu, hv) * 0.8]);
          } else if (w === 'court') {
            const cm = pick(R, [K.ASPH, K.SGREEN, BM.SLATE || K.SLATE]);
            pad(cx, cz, yaw, hu, hv, -0.02, 0.05, cm);
            // painted lines: a 0.12 m border and a key, 2.5 cm proud of the court (less fights the court in the depth buffer)
            const lm = K.PWHITE, c = Math.cos(yaw), s = Math.sin(yaw), Wp = (u, v) => [cx + u * c - v * s, cz + u * s + v * c];
            for (const [u, v, a, bb] of [[0, -hv + 0.3, hu - 0.3, 0.06], [0, hv - 0.3, hu - 0.3, 0.06], [-hu + 0.3, 0, 0.06, hv - 0.3], [hu - 0.3, 0, 0.06, hv - 0.3], [hu - 2.9, 0, 0.06, 1.8], [hu - 1.6, -1.8, 1.3, 0.06], [hu - 1.6, 1.8, 1.3, 0.06]]) {
              const p = Wp(u, v); pad(p[0], p[1], yaw, a, bb, 0.03, 0.075, lm);
            }
            const hp = itemModel(C, 'hoop'), p = Wp(hu - 0.55, 0);
            put(hp.mesh, p[0], 0.075 + sink(S, p[0], p[1], 1), p[1], faceYaw(-c, -s), 0.125, 0.125);
            S.tall.push([cx, cz, Math.hypot(hu, hv) * 0.75]);
          } else {
            for (const [u, v] of [[-1.4, 0], [1.4, 0]]) { const c = Math.cos(yaw), s = Math.sin(yaw); placeItem(S, 'picnic', Math.floor(R() * 3), cx + u * c - v * s, cz + u * s + v * c, yaw, 0.2); }
          }
          markRect(S, cx, cz, yaw, -hu - 0.5, -hv - 0.5, hu + 0.5, hv + 0.5);
          info.items.push(w); done = true; break;
        }
        if (done) break;
      }
    }
    // benches, lamps and bins along the paths: sample used path cells near the paths
    // (done via the recorded entries: points along each entry -> hub leg)
    for (const e of ent) {
      const dx = hx - e.x, dz = hz - e.z, l = Math.hypot(dx, dz);
      if (l < 6) continue;
      const tx = dx / l, tz = dz / l;
      let side = 1, k = 0;
      for (let t = 4; t < l - hubR - 1.5; t += 6.5, side = -side, ++k) {
        const px = e.x + tx * t + (-tz) * side * 1.95, pz = e.z + tz * t + tx * side * 1.95;
        if (k % 3 === 2) { placeItem(S, 'lamp', 0, e.x + tx * t + (-tz) * side * 1.6, e.z + tz * t + tx * side * 1.6, 0, 0.1); continue; }
        if (placeItem(S, 'bench', Math.floor(R() * 3), px, pz, faceYaw(tz * side, -tx * side), 0.1) && R() < 0.4)
          placeItem(S, 'bin', 0, px + tx * 1.4, pz + tz * 1.4, 0, 0.1);
      }
    }
    // open lawn: a clearing (no trees) somewhere away from the hub
    let lawn = null;
    {
      let best = -1;
      for (const k of S.cp.cells) {
        if (S.dEdge[k] < 4) continue;
        const x = S.X(k % S.W), z = S.Z((k / S.W) | 0), d = Math.hypot(x - hx, z - hz);
        const sc = Math.min(d, 14) + S.dEdge[k];
        if (d > hubR + 4 && sc > best) { best = sc; lawn = [x, z, clamp(S.dEdge[k] * 0.8, 4, 9)]; }
      }
    }
    const avoid = [[hx, hz, hubR + 0.5]].concat(lawn ? [lawn] : []);
    // the wooded edge along the lots (backs of the yards), then shade trees in the open
    forest(S, (k) => S.dLot[k] < 8 && S.dOut[k] > 3, { dens: 0.6, step: 3, avoid });
    for (const [x, z] of candidates(S, 5)) tryTree(S, x, z, [pick(R, ['oak', 'maple', 'oak', 'tulip', 'red'])], 1.05, { avoid, streetMin: 2.2 });
    // shrubs round the hub and the facilities (planted beds, not scattered over the lawn)
    for (const [x, z] of candidates(S, 1.6, (k, x, z) => S.tall.some(t => { const d = Math.hypot(t[0] - x, t[1] - z); return d > t[2] + 0.6 && d < t[2] + 2.2; }))) tryBush(S, x, z, ['shrub', 'flowers', 'box'], { dens: 0.9, streetMin: 2 });
  }
  function fillWedge(S, F) {
    const R = S.R, info = S.info, ax = F.ax, sg = F.wedge;              // tip at +ax (sg 1) or -ax (sg -1)
    const dir = [ax[0] * sg, ax[1] * sg];
    // the tip: the frontage cell farthest along dir
    let tip = null, tp = -1e9;
    for (const k of S.cp.cells) { const x = S.X(k % S.W), z = S.Z((k / S.W) | 0), p = (x - F.mx) * dir[0] + (z - F.mz) * dir[1]; if (p > tp) { tp = p; tip = [x, z]; } }
    // memorial: walk back from the tip until there is room for a 2.6 m pad
    let mon = null;
    for (let t = 0; t < 60; t += 0.5) {
      const x = tip[0] - dir[0] * t, z = tip[1] - dir[1] * t;
      // re-centre across the wedge: the deepest cell on this cross line
      let best = null;
      for (let s = -10; s <= 10; s += 0.5) { const px = x - dir[1] * s, pz = z + dir[0] * s, k = S.kAt(px, pz); if (k >= 0 && S.comp[k] === S.cp.id && (!best || S.dEdge[k] > best[2])) best = [px, pz, S.dEdge[k]]; }
      if (best && best[2] >= 3.2) { mon = best; break; }
    }
    // the nose: the block land beyond the component's tip (the street band narrows to the corner) farthest from the
    // memorial; everything between them is planted low
    let nose = tip, tdir = dir;
    if (mon) {
      let best = -1;
      for (let j = 0; j < S.H; ++j) for (let i = 0; i < S.W; ++i) {
        const k = j * S.W + i;
        if (!S.inR[k] || S.dLot[k] <= 0) continue;
        const x = S.X(i), z = S.Z(j);
        if ((x - F.mx) * dir[0] + (z - F.mz) * dir[1] < tp - 3) continue;
        const d = Math.hypot(x - mon[0], z - mon[1]);
        if (d > best && d < 60) { best = d; nose = [x, z]; }
      }
      const l = Math.hypot(nose[0] - mon[0], nose[1] - mon[1]);
      if (l > 1) tdir = [(nose[0] - mon[0]) / l, (nose[1] - mon[1]) / l];
    }
    const yaw = Math.atan2(tdir[1], tdir[0]);
    const avoid = [];
    if (mon) {
      const [x, z] = mon, pr = Math.min(2.6, mon[2] - 0.6), pm = pick(R, [K.PLAZA, K.PATH, K.CONC]);
      pad(x, z, yaw, pr, pr * 0.62, -0.02, 0.05, pm); pad(x, z, yaw, pr * 0.62, pr, -0.02, 0.05, pm);
      markRect(S, x, z, yaw, -pr - 0.2, -pr - 0.2, pr + 0.2, pr + 0.2);
      const kind = R() < 0.5 ? 'obelisk' : 'flagpole';
      const it = itemModel(C, kind, Math.floor(R() * 3));
      put(it.mesh, x, 0.05 + sink(S, x, z, 1.5), z, yaw + Math.PI / 2, it.sc, it.sc);
      info.items.push(kind);
      if (kind === 'flagpole') { const pq = itemModel(C, 'plaque'); put(pq.mesh, x + tdir[0] * 1.1, 0.05 + sink(S, x + tdir[0] * 1.1, z + tdir[1] * 1.1, 0.8), z + tdir[1] * 1.1, faceYaw(tdir[0], tdir[1]), 0.125, 0.125); info.items.push('plaque'); }
      S.tall.push([x, z, pr + 0.6]);
      avoid.push([x, z, pr + 3.5]);
      // flower beds round the pad
      for (let i = 0; i < 6; ++i) { const an = yaw + i * 1.047 + 0.5; tryBush(S, x + Math.cos(an) * (pr + 1.2), z + Math.sin(an) * (pr + 1.2), ['flowers', 'box'], { dens: 0.7, streetMin: 0.5 }); }
      // the welcome sign between the memorial and the tip, facing the junction
      const nl = Math.hypot(nose[0] - x, nose[1] - z);
      for (let t = Math.min(pr + 2.5, nl * 0.5); t < nl - 1; t += 0.5) {
        const sx = x + tdir[0] * t, sz = z + tdir[1] * t;
        const vs = Math.floor(R() * 3);
        if (placeItem(S, 'welcome', vs, sx, sz, faceYaw(tdir[0], tdir[1]), 0.15, 0.6) || placeItem(S, 'welcome', vs, sx, sz, faceYaw(-tdir[1], tdir[0]), 0.15, 0.6) ||
            placeItem(S, 'welcome', vs, sx, sz, faceYaw(tdir[1], -tdir[0]), 0.15, 0.6)) {
          avoid.push([sx, sz, 3]); info.items.push('sign');
          for (const s of [-1, 1]) tryBush(S, sx + tdir[0] * 1.0 - tdir[1] * s * 1.2, sz + tdir[1] * 1.0 + tdir[0] * s * 1.2, ['bed'], { dens: 0.6, streetMin: 0.05, band: true });
          break;
        }
      }
      // a path from the nearest sidewalk to the pad
      const ens = entries(S, 2).filter(e => Math.hypot(e.x - x, e.z - z) < 30).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      for (const e of ens) {
        const out = stubOut(S, e.x, e.z, e.ei, 1.5);
        if (!out) continue;
        const dx = x - e.x, dz = z - e.z, l = Math.hypot(dx, dz), end = [x - dx / l * (pr - 0.3), z - dz / l * (pr - 0.3)];
        if (l > pr + 0.5 && !segClear(S, [e.x, e.z], end, 1.5)) continue;
        pathSeg(S, out, [e.x, e.z], 1.5, pm, 0, true); if (l > pr + 0.5) pathSeg(S, [e.x, e.z], end, 1.5, pm);
        for (const s of [-1, 1]) placeItem(S, 'bench', Math.floor(R() * 3), x - dir[0] * (pr + 1.1) - dir[1] * s * 1.3, z - dir[1] * (pr + 1.1) + dir[0] * s * 1.3, faceYaw(dir[0], dir[1]), 0.05);
        info.paths = 1; break;
      }
    }
    // low planting towards the tip, trees in the wide part
    const tipZone = mon ? (k) => (S.X(k % S.W) - mon[0]) * tdir[0] + (S.Z((k / S.W) | 0) - mon[1]) * tdir[1] > -1
      : (k) => (S.X(k % S.W) - tip[0]) * -dir[0] + (S.Z((k / S.W) | 0) - tip[1]) * -dir[1] < 8;
    for (const [x, z] of candidates(S, 1.8, tipZone)) tryBush(S, x, z, ['mound', 'flowers', 'box', 'shrub'], { dens: 1.0, streetMin: 0.5 });
    // a planted nose: flowers and low junipers on the narrow part, right out to the tip
    {
      const o = mon || tip, Rt = mon ? Math.hypot(nose[0] - o[0], nose[1] - o[1]) + 1 : 8;
      for (let t = mon ? 1 : -8; t < Rt; t += 1.0) for (let s = -7; s <= 7; s += 1.0) {
        const x = o[0] + tdir[0] * t - tdir[1] * s, z = o[1] + tdir[1] * t + tdir[0] * s;
        tryBush(S, x, z, ['bed', 'bed', 'flowers', 'mound'], { dens: 0.9, streetMin: 0.05, band: true });
      }
      // past the block land the nose goes on as lawn of the street ground (too thin to be buildable): beds along
      // its middle while the street raster says lawn all round them
      if (mon && Ra && Ra.classify) {
        const o2 = {}, cls = [0, 0], MAT = C.MAT;
        const lawn = (x, z) => { Ra.classify(x, z, o2, cls); return cls[1] === MAT.YARD || cls[1] === MAT.PLOT; };
        for (let t = Rt - 1; t < Rt + 40; t += 1.1) {
          let any = false;
          for (let s = -4; s <= 4; s += 1.1) {
            const x = o[0] + tdir[0] * t - tdir[1] * s, z = o[1] + tdir[1] * t + tdir[0] * s;
            if (!lawn(x, z)) continue;
            any = true;
            const Bm = bushModel(C, S.R() < 0.7 ? 'bed' : 'mound', Math.floor(S.R() * 5)), r = Bm.r;
            if (![[r + 0.45, 0], [-r - 0.45, 0], [0, r + 0.45], [0, -r - 0.45]].every(([a, b]) => lawn(x + a, z + b))) continue;
            const k = S.kAt(x, z);
            if (k >= 0 && (S.used[k] || (S.inR[k] && S.dLot[k] <= r + 0.3))) continue;
            if (S.bushes.some(q => Math.hypot(q[0] - x, q[1] - z) < 0.9 * (q[2] + r)) || S.trees.some(q => Math.hypot(q.x - x, q.z - z) < q.rc * 0.6)) continue;
            if (allTrees.some(q => Math.hypot(q.x - x, q.z - z) < Math.max(q.rc * 0.6, r + 0.45))) continue;   // other components' trunks too
            S.bushes.push([x, z, r]); allBushes.push([x, z, r]);
            put(Bm.mesh, x, sink(S, x, z, r), z, S.R() * 6.283, 0.125, 0.125);
            S.info.bushes++;
          }
          if (!any && t > Rt + 3) break;
        }
      }
    }
    const zoneRes = info.zone === 'residential';
    forest(S, (k) => !tipZone(k), { dens: zoneRes ? 0.62 : 0.75, step: 3.2, avoid, species: zoneRes ? undefined : ['maple', 'oak', 'tulip', 'spruce', 'red', 'maple'], bushes: zoneRes ? undefined : ['box', 'shrub', 'mound'] });
  }
  function fillPlaza(S, F) {
    const R = S.R, info = S.info;
    // the best paved rectangle at the sidewalk, square to the street
    const ens = entries(S, 2.5);
    let best = null;
    for (const e of ens.slice(0, 3)) {
      const tx = e.ei.tx, tz = e.ei.tz, nx0 = -e.ei.nx, nz0 = -e.ei.nz, yaw = Math.atan2(tz, tx);
      for (let off = -10; off <= 10; off += 1) {
        const bx = e.x + tx * off, bz = e.z + tz * off;
        // the block edge behind (street side) this point
        let t = 0; while (t < 4 && S.kAt(bx - nx0 * t, bz - nz0 * t) >= 0 && S.dOut[S.kAt(bx - nx0 * t, bz - nz0 * t)] > 0) t += 0.1;
        const te = lawnEnd(bx, bz, -nx0, -nz0, t), ex = bx - nx0 * te, ez = bz - nz0 * te;
        for (const hw of [8, 6.5, 5, 4]) for (const dp of [11, 9, 7, 5, 4]) {
          // in the frame (u along the street, v into the block: yaw' so that +v = inward)
          const ok = (() => {
            for (let u = -hw; u <= hw; u += 0.5) for (let v = 0.6; v <= dp; v += 0.5) {
              const x = ex + tx * u + nx0 * v, z = ez + tz * u + nz0 * v, k = S.kAt(x, z);
              if (k < 0 || S.dLot[k] < 0.6 || S.used[k]) return false;
              if (S.comp[k] !== S.cp.id && S.dOut[k] >= 1.0) return false;
              if (S.dOut[k] === 0 && v > 1.2) return false;
            }
            return true;
          })();
          if (ok) { const sc = hw * 2 * dp - Math.abs(off) * 0.5; if (!best || sc > best.sc) best = { sc, ex, ez, tx, tz, nx0, nz0, hw, dp, yaw }; break; }
        }
      }
    }
    if (best && best.hw * 2 * best.dp >= 24) {
      const { ex, ez, tx, tz, nx0, nz0, hw, dp } = best;
      const cx = ex + nx0 * dp / 2, cz = ez + nz0 * dp / 2, yaw = Math.atan2(tz, tx);
      const pm = pick(R, [K.PLAZA, K.PLAZA, K.CONC, BM.BRICK_RED]), em = pm === K.CONC ? K.PLAZA : K.CONC;
      pad(cx, cz, yaw, hw, dp / 2, -0.02, 0.05, em, 'plaza');
      // the field stands 3.5 cm proud of its edge band: stacked surfaces closer than ~2 cm fight in the depth buffer
      // at RTS distance (dev/groundfight.js --self)
      const PT = 0.085;
      pad(cx, cz, yaw, hw - 0.35, dp / 2 - 0.35, -0.02, PT, pm, 'plaza');
      markRect(S, cx, cz, yaw, -hw - 0.3, -dp / 2 - 0.3, hw + 0.3, dp / 2 + 0.3);
      // undo the mark so items can stand on the pad: items check their own free cells via a pad-local list
      const U = (u, v) => [ex + tx * u + nx0 * v, ez + tz * u + nz0 * v];
      const put2 = (name, u, v, yawI) => { const it = itemModel(C, name, Math.floor(R() * 3)), p = U(u, v); put(it.mesh, p[0], PT + sink(S, p[0], p[1], 1.2), p[1], yawI, it.sc, it.sc); info.items.push(name); return p; };
      // planters with trees along the back edge, benches between them facing the street
      // three layouts: trees in raised planters, trees in grates flush with the paving, or a fountain in the middle
      const style = hw >= 5 && dp >= 7.5 && R() < 0.4 ? 'fountain' : R() < 0.5 ? 'planters' : 'grates';
      info.plazaStyle = style;
      const treeAt = (p, y0, cap) => {
        const T = treeModel(C, pick(R, ['young', 'maple', 'young', 'street']), Math.floor(R() * 4));
        // crown kept off the lots around (the plaza's back edge often meets a building lot)
        const kp = S.kAt(p[0], p[1]), room = kp >= 0 ? Math.min(S.dLot[kp] - 0.35, S.dOut[kp] + 1.0) : 0;
        const scl = Math.min(cap, room / T.rc);
        if (scl < 0.4) return;
        put(T.mesh, p[0], y0 + sink(S, p[0], p[1], T.rc * scl), p[1], R() * 6.28, BV * scl, BV * scl);
        const tr = { x: p[0], z: p[1], rc: T.rc * scl, base: T.base * scl + y0, sp: T.sp }; S.trees.push(tr); allTrees.push(tr); info.trees++;
      };
      const n = Math.max(2, Math.round(hw * 2 / (style === 'grates' ? 4 : 5)));
      for (let i = 0; i < n; ++i) {
        const u = -hw + 1.3 + i * (2 * hw - 2.6) / Math.max(1, n - 1), v = dp - 1.3;
        if (style === 'fountain' && i > 0 && i < n - 1) continue;
        if (style === 'grates') {
          const p = U(u, v);
          pad(p[0], p[1], yaw, 0.6, 0.6, -0.02, PT + 0.025, K.POLE_D, 'grate'); pad(p[0], p[1], yaw, 0.45, 0.45, -0.02, PT + 0.05, K.SOIL);
          treeAt(p, PT + 0.05, 0.85);
        } else treeAt(put2('planter', u, v, yaw), PT + 0.75, 0.75);
        if (i < n - 1 && dp >= 5 && style !== 'fountain') put2('bench', u + (2 * hw - 2.6) / Math.max(1, n - 1) / 2, dp - 1.9, faceYaw(-nx0, -nz0));
      }
      if (style === 'fountain') {
        const p = U(0, dp / 2 + 0.3), fm = itemModel(C, 'fountain', Math.floor(R() * 3));
        put(fm.mesh, p[0], PT + sink(S, p[0], p[1], 2), p[1], yaw, fm.sc, fm.sc); info.items.push('fountain');
        for (const sgn of [-1, 1]) put2('bench', sgn * 3.6, dp / 2 + 0.3, faceYaw(-tx * sgn, -tz * sgn));
      }
      if (dp >= 7 && style !== 'fountain') { put2('bench', -hw + 1.0, dp / 2 - 0.5, faceYaw(tx, tz)); }
      put2('bin', hw - 0.8, 1.6, 0);
      if (hw >= 5 && R() < 0.6) put2('bikerack', hw - 2.5, 1.4, yaw);
      if (dp >= 6 && R() < 0.7) put2('lamp', -hw + 0.8, 1.2, 0);
      S.tall.push([cx, cz, Math.hypot(hw, dp / 2) * 0.9]);
      info.plaza = [Math.round(hw * 2), Math.round(dp)];
    }
    fillBuffer(S);
  }

  stats.quads = mb.quads - q0; stats.ms = Date.now() - t0; stats.area = Math.round(stats.area);
  return { regions: regionsOut, stats };
}

// two-pass chamfer distance (m) to the cells where src(k) is true; optional label propagation
function chamfer(W, H, src, c, labIn, labOut) {
  const N = W * H, D = new Float32Array(N), a = c, b = c * Math.SQRT2;
  for (let k = 0; k < N; ++k) { D[k] = src(k) ? 0 : 1e9; if (labOut) labOut[k] = D[k] === 0 ? labIn[k] : -1; }
  const rel = (k, r, w) => { const v = D[r] + w; if (v < D[k]) { D[k] = v; if (labOut) labOut[k] = labOut[r]; } };
  for (let j = 0; j < H; ++j) for (let i = 0; i < W; ++i) {
    const k = j * W + i;
    if (!D[k]) continue;
    if (i > 0) rel(k, k - 1, a);
    if (j > 0) { rel(k, k - W, a); if (i > 0) rel(k, k - W - 1, b); if (i < W - 1) rel(k, k - W + 1, b); }
  }
  for (let j = H - 1; j >= 0; --j) for (let i = W - 1; i >= 0; --i) {
    const k = j * W + i;
    if (!D[k]) continue;
    if (i < W - 1) rel(k, k + 1, a);
    if (j < H - 1) { rel(k, k + W, a); if (i < W - 1) rel(k, k + W + 1, b); if (i > 0) rel(k, k + W - 1, b); }
  }
  return D;
}

L.parkKit = parkKit;
})();
