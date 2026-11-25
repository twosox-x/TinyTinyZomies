/* City Lab architecture — voxel-art buildings (phase 5B).
 *
 * Every building is a standalone voxel model built on its own upright grid (BV = 25 cm voxels), then placed
 * as a rigid mesh rotated to face its street. Nothing is carved out of a building: each lot gets the largest
 * clean rectangle that fits, facing the street.
 *
 *  - Facades are relief maps (depth per voxel cell: window insets, sills, lintels, pilasters, cornices, bay
 *    windows, storefronts, awnings) meshed with the same greedy column mesher as the streets.
 *  - Roofs are height maps (parapets, gables with overhangs, penthouses, chimneys, rooftop units).
 *  - Small 3D parts (porches, stoops, water tanks, spires) are voxel boxes.
 *
 * Styles follow density, from the outskirts to the core: suburban houses -> DC rowhouses -> mid-rise
 * limestone / brick -> New York towers (Art Deco setbacks or glass curtain walls on a stone podium).
 * Renderer-free; positions in road-voxel units, explicit normals.
 */
(function (root) {
'use strict';
const BV = 0.25;                                   // building voxel (m)

// ------------------------------------------------------------------------------------------------ materials
const BM = {
  BRICK_RED: 71, BRICK_DARK: 72, BRICK_BROWN: 73, LIMESTONE: 74, LIMESTONE_DARK: 75, BUFF: 76,
  SIDING_WHITE: 77, SIDING_YELLOW: 78, SIDING_BLUE: 79, SIDING_SAGE: 80, PAINT_CREAM: 81, PAINT_BLUE: 82, PAINT_YELLOW: 83,
  TRIM: 84, TRIM_DARK: 85, GLASS: 86, GLASS_LIT: 87, CURTAIN: 88, CURTAIN_LIT: 89, MULLION: 90, SPANDREL: 91,
  ROOF_TAR: 92, SHINGLE_GRAY: 93, SHINGLE_BROWN: 94, DOOR_RED: 95, AWNING_RED: 96, AWNING_GREEN: 97, AWNING_BLUE: 98,
  METAL: 99, WOOD: 100, COPPER: 101, STOREFRONT: 102, SHUTTER_GREEN: 103, SHUTTER_BLACK: 104, DOOR_NAVY: 105,
  PAINT_SALMON: 106, PAINT_SAGE: 107, SIDING_GRAY: 108, CONCRETE: 109, SHINGLE_SLATE: 110, SIDING_SHADE: 111, BRICK_SHADE: 112,
  GRANITE_PINK: 141, GRANITE_DARK: 142, BRONZE: 143, TERRACOTTA: 144, PRECAST: 145, GLASS_GREEN: 146, GLASS_DARK: 147,
  GLASS_GREEN_LIT: 148, GLASS_DARK_LIT: 149, BEACON: 150, LOUVER: 151, WATER: 152,
  NEON: 153, LED: 154, GRASS: 155, STEEL_DARK: 156, WHITE_CONCRETE: 157, GLASS_BLUE: 158, GLASS_BLUE_LIT: 159,
  LEAF: 133, LEAF_DARK: 134, TRUNK: 135
};
// muted, slightly washed-out sRGB colours; lit glass glows at night (renderer)
const ARCH_PALETTE = {
  71: [168, 92, 74], 72: [134, 72, 62], 73: [150, 108, 84], 74: [214, 204, 184], 75: [186, 176, 158], 76: [206, 182, 142],
  77: [222, 220, 212], 78: [232, 218, 168], 79: [176, 196, 210], 80: [176, 190, 160], 81: [228, 214, 186], 82: [150, 170, 186], 83: [226, 202, 132],
  84: [226, 222, 210], 85: [88, 84, 80], 86: [92, 108, 120], 87: [250, 214, 150], 88: [118, 142, 160], 89: [244, 222, 170], 90: [72, 78, 84], 91: [84, 92, 100],
  92: [108, 106, 104], 93: [96, 98, 102], 94: [112, 90, 76], 95: [150, 52, 46], 96: [168, 64, 56], 97: [72, 110, 84], 98: [70, 96, 130],
  99: [150, 154, 156], 100: [140, 108, 78], 101: [110, 150, 134], 102: [70, 86, 98], 103: [58, 84, 66], 104: [44, 46, 50], 105: [48, 62, 92],
  106: [214, 156, 136], 107: [160, 176, 146], 108: [196, 198, 198], 109: [176, 172, 166], 110: [84, 92, 104], 111: [0, 0, 0], 112: [0, 0, 0],
  141: [178, 146, 136], 142: [92, 88, 90], 143: [104, 88, 70], 144: [182, 148, 124], 145: [184, 180, 170], 146: [92, 122, 122], 147: [62, 70, 80],
  148: [246, 226, 176], 149: [240, 214, 160], 150: [230, 60, 50], 151: [124, 128, 130], 152: [104, 146, 168],
  153: [236, 96, 128], 154: [214, 232, 250], 155: [122, 150, 92], 156: [58, 62, 68], 157: [224, 222, 214], 158: [104, 136, 168], 159: [244, 222, 172]
};
const LIT = new Set([87, 89, 148, 149, 159]);

// ------------------------------------------------------------------------------------------------ emitter
// Writes quads in building-local voxel coordinates (x along the street, y up, z into the lot) into a mesh
// buffer in world road-voxel units, with explicit normals. Winding is fixed per quad from its normal.
class Emitter {
  constructor(mb, O, e1, e2, y0, voxel) { this.mb = mb; this.O = O; this.e1 = e1; this.e2 = e2; this.y0 = y0; this.v = voxel; }
  P(x, y, z) {
    const a = x * BV, b = z * BV;
    return [(this.O[0] + a * this.e1[0] + b * this.e2[0]) / this.v, (this.y0 + y * BV) / this.v, (this.O[1] + a * this.e1[1] + b * this.e2[1]) / this.v];
  }
  N(nx, ny, nz) { return [nx * this.e1[0] + nz * this.e2[0], ny, nx * this.e1[1] + nz * this.e2[1]]; }
  quad(p, q, r, s, m, n) {
    const A = this.P(...p), B = this.P(...q), C = this.P(...r), D = this.P(...s), N = this.N(...n);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * N[0] + cy * N[1] + cz * N[2] < 0) this.mb.quadN(...A, ...D, ...C, ...B, m, ...N);
    else this.mb.quadN(...A, ...B, ...C, ...D, m, ...N);
  }
  box(x0, y0, z0, x1, y1, z1, m, noBottom) {
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], m, [0, 1, 0]);
    if (!noBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], m, [0, -1, 0]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], m, [0, 0, -1]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], m, [0, 0, 1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], m, [-1, 0, 0]);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], m, [1, 0, 0]);
  }
  // a VoxModel (voxel = BV) placed with its model origin at building-local (x, y, z); greedy-meshed once
  vox(C, M, x, y, z) {
    const m = M._mesh || (M._mesh = C.meshVoxels3D(M));
    const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]], P = m.pos, s = 1 / C.PV;
    for (let q = 0; q < m.quads; ++q) {
      const k = q * 12, c = (i) => [P[k + i] * s + x, P[k + i + 1] * s + y, P[k + i + 2] * s + z];
      this.quad(c(0), c(3), c(6), c(9), m.mat[q * 4], NV[m.nrm[q * 4]]);
    }
  }
  // relief / height map meshed by the column mesher, then mapped: map(rx, ry, rz) -> local (x, y, z)
  relief(H, M, w, d, map, wallMat, C, clampDepth) {
    const t = new C.MeshBuffer();
    C.meshColumns(H, M, w, d, 0, 0, wallMat, t);
    if (clampDepth) {
      // facade reliefs extend BASE voxels into the building; their outer boundary faces there (tops under the
      // roof, bottoms on podiums, ends at the corners) would be coplanar with the roof / neighbouring walls:
      // pull them out to the wall plane. Window reveals (depth 1..2) are untouched.
      const P = t.pos;
      for (let q = 0; q < t.quads; ++q) {
        const nn = t.nrm[q * 4];
        if (nn === 0) continue;
        const k = q * 12;
        // only faces on the relief's outer boundary (wall ends, top and bottom edges); the side walls of
        // recesses inside the facade (portals, lobbies, glazed slots) must stay, or the building is see-through
        const ax = nn <= 2 ? 0 : 2, lim = nn <= 2 ? w : d;
        let edge = true;
        for (let c = ax; c < 12; c += 3) if (P[k + c] !== 0 && P[k + c] !== lim) { edge = false; break; }
        if (!edge) continue;
        let mn = 1e9; for (let c = 1; c < 12; c += 3) mn = Math.min(mn, P[k + c]);
        if (mn > 0) continue;
        let mx = -1e9;
        for (let c = 1; c < 12; c += 3) { if (P[k + c] < clampDepth) P[k + c] = clampDepth; mx = Math.max(mx, P[k + c]); }
        if (mx <= clampDepth) t.mat[q * 4] = 255;                         // degenerate: drop
      }
    }
    const o = map(0, 0, 0);
    const dir = (dx, dy, dz) => { const p = map(dx, dy, dz); return [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; };
    const NR = [dir(0, 1, 0), dir(1, 0, 0), dir(-1, 0, 0), dir(0, 0, 1), dir(0, 0, -1)];
    for (let q = 0; q < t.quads; ++q) {
      const k = q * 12, P = t.pos;
      if (t.mat[q * 4] === 255) continue;
      this.quad(map(P[k], P[k + 1], P[k + 2]), map(P[k + 3], P[k + 4], P[k + 5]), map(P[k + 6], P[k + 7], P[k + 8]),
        map(P[k + 9], P[k + 10], P[k + 11]), t.mat[q * 4], NR[t.nrm[q * 4]]);
    }
  }
}

// ------------------------------------------------------------------------------------------------ facades
// Relief grid: width w (voxels along the wall, plus `ext` cells beyond each end for corner returns), height h.
// Depth values: 2 = wall plane, 1 = inset (glass, doors), 3..6 = projections. -1 = nothing.
const BASE = 2;
class Relief {
  constructor(w, h, ext, wall) {
    this.w0 = w; this.ext = ext; this.w = w + 2 * ext; this.h = h;
    const W2 = this.w + 2;
    this.H = new Int16Array(W2 * (h + 2)).fill(-1);
    this.M = new Uint8Array(W2 * (h + 2));
    for (let v = 0; v < h; ++v) for (let u = 0; u < w; ++u) this.set(u, v, BASE, wall);
  }
  idx(u, v) { return (v + 1) * (this.w + 2) + (u + this.ext + 1); }
  set(u, v, d, m) { if (u < -this.ext || u >= this.w0 + this.ext || v < 0 || v >= this.h) return; const i = this.idx(u, v); this.H[i] = d; this.M[i] = m; }
  get(u, v) { if (u < -this.ext || u >= this.w0 + this.ext || v < 0 || v >= this.h) return -1; return this.H[this.idx(u, v)]; }
  rect(u0, v0, u1, v1, d, m) { for (let v = v0; v < v1; ++v) for (let u = u0; u < u1; ++u) this.set(u, v, d, m); }
  // carry projecting rows around the corners (cornices, bands): no notches at building edges
  returns() {
    for (let v = 0; v < this.h; ++v) {
      const dl = this.get(0, v), dr = this.get(this.w0 - 1, v);
      for (let e = 1; e <= this.ext; ++e) {
        if (dl > BASE + e - 1) this.set(-e, v, dl, this.M[this.idx(0, v)]);
        if (dr > BASE + e - 1) this.set(this.w0 - 1 + e, v, dr, this.M[this.idx(this.w0 - 1, v)]);
      }
    }
  }
}
function bays(W, bayW, margin) {
  // window bay centres, symmetric
  const n = Math.max(1, Math.floor((W - 2 * margin) / bayW));
  const used = n * bayW, off = Math.floor((W - used) / 2);
  const c = [];
  for (let i = 0; i < n; ++i) c.push(off + i * bayW + Math.floor(bayW / 2));
  return c;
}
const H2 = (a, b, c) => { let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function glass(seed, a, b, lit) { return H2(seed, a, b) < (lit === undefined ? 0.32 : lit) ? BM.GLASS_LIT : BM.GLASS; }
// a punched window with sill and lintel
function punch(F, cu, v0, ww, wh, seed, k, trim, sill, lintel) {
  const u0 = cu - (ww >> 1);
  F.rect(u0, v0, u0 + ww, v0 + wh, 1, glass(seed, k, v0));
  if (ww >= 4 && wh >= 7) F.rect(u0, v0 + Math.floor(wh * 0.62), u0 + ww, v0 + Math.floor(wh * 0.62) + 1, 1, BM.TRIM_DARK);   // transom bar
  if (sill) F.rect(u0 - 1, v0 - 1, u0 + ww + 1, v0, 3, trim);
  if (lintel) F.rect(u0 - 1, v0 + wh, u0 + ww + 1, v0 + wh + 1, 3, trim);
}

// ---- style: suburban house (lap siding, shutters, door; roof is separate)
function facadeHouse(W, floors, fh, S, side, front) {
  const h = floors * fh;
  const F = new Relief(W, h, 0, S.wall);
  for (let v = 2; v < h; v += 2) F.rect(0, v, W, v + 1, BASE, S.wallShade);           // lap siding courses
  F.rect(0, 0, W, 2, BASE, BM.CONCRETE);                                                // foundation
  F.rect(0, 2, 1, h, 3, BM.TRIM); F.rect(W - 1, 2, W, h, 3, BM.TRIM);                   // corner boards
  const cs = bays(W, side ? 16 : 14, 3);
  for (let f = 0; f < floors; ++f) {
    const v0 = f * fh + 4;
    cs.forEach((c, k) => {
      if (front && f === 0 && k === (cs.length >> 1)) {                                 // front door with trim
        F.rect(c - 3, 2, c + 3, 12, 3, BM.TRIM); F.rect(c - 2, 2, c + 2, 11, 1, S.door);
        return;
      }
      punch(F, c, v0, 4, 6, S.seed, k + f * 31 + (side ? 7 : 0), BM.TRIM, true, true);
      if (!side) { F.rect(c - 4, v0, c - 3, v0 + 6, 3, S.shutter); F.rect(c + 3, v0, c + 4, v0 + 6, 3, S.shutter); }
    });
  }
  return F;
}
// ---- style: DC / Brooklyn rowhouse (brick or painted, tall windows, projecting bay, bracketed cornice)
function facadeRow(W, floors, fh, S, side, front) {
  const corn = 4, h = floors * fh + corn;
  const F = new Relief(W, h, 4, S.wall);
  F.rect(0, 0, W, 4, BASE, BM.LIMESTONE);                                                  // raised basement
  F.rect(0, 4, W, 5, 3, BM.LIMESTONE);                                                     // water table
  if (!side) {
    const bayW = S.bay ? Math.min(W - 10, 16) : 0, bu0 = 2, bu1 = bu0 + bayW;
    if (bayW > 0) F.rect(bu0, 5, bu1, floors * fh, 5, S.wall);                            // projecting bay, full height
    for (let f = 0; f < floors; ++f) {
      const v0 = f * fh + (f === 0 ? 7 : 3);
      const cs = bays(W, 8, 2);
      cs.forEach((c, k) => {
        const inBay = bayW > 0 && c >= bu0 && c < bu1;
        if (front && f === 0 && k === cs.length - 1) {                                     // door with transom
          F.rect(c - 3, 4, c + 3, 16, 3, BM.LIMESTONE); F.rect(c - 2, 5, c + 2, 14, 1, S.door);
          F.rect(c - 2, 14, c + 2, 15, 1, glass(S.seed, k, 99, 0.5));
          return;
        }
        const d = inBay ? 4 : 1;
        const u0 = c - 2;
        F.rect(u0, v0, u0 + 4, v0 + 8, d, glass(S.seed, k, f));
        F.rect(u0 - 1, v0 - 1, u0 + 5, v0, inBay ? 6 : 3, BM.LIMESTONE);                   // sill
        F.rect(u0 - 1, v0 + 8, u0 + 5, v0 + 9, inBay ? 6 : 3, S.lintel);                   // lintel
      });
    }
  } else {
    for (let f = 1; f < floors; ++f) F.rect(0, f * fh, W, f * fh + 1, 3, S.wallShadeOr);  // party wall: plain, with belt courses
  }
  // bracketed cornice
  const t = floors * fh;
  F.rect(0, t, W, t + 1, 3, S.corniceMat);
  for (let u = 0; u < W; ++u) F.rect(u, t + 1, u + 1, t + 3, (u % 4 === 0) ? 4 : 3, S.corniceMat);   // brackets
  F.rect(0, t + 3, W, t + 4, 4, S.corniceMat);
  F.returns();
  return F;
}
// ---- style: mid-rise (limestone / brick, rusticated base or storefronts, pilasters, heavy cornice)
function facadeMid(W, floors, fh, S, side) {
  const corn = 5, h = floors * fh + corn;
  const F = new Relief(W, h, 6, S.wall);
  const bayW = S.bayW, cs = bays(W, bayW, 3);
  // ground floor
  if (S.shops && !side) {
    F.rect(0, 0, W, fh, BASE, S.base);
    cs.forEach((c, k) => {
      F.rect(c - (bayW >> 1) + 2, 1, c + (bayW >> 1) - 1, fh - 4, 1, k === 1 ? BM.DOOR_NAVY : BM.STOREFRONT);
      F.rect(c - (bayW >> 1) + 2, fh - 4, c + (bayW >> 1) - 1, fh - 3, 1, BM.TRIM_DARK);   // sign band
      F.rect(c - (bayW >> 1) + 1, fh - 3, c + (bayW >> 1), fh - 1, 6, S.awning);           // awning
    });
  } else {
    F.rect(0, 0, W, fh, BASE, S.base);
    for (let v = 1; v < fh; v += 2) F.rect(0, v, W, v + 1, 3, S.base);                     // rustication
    cs.forEach((c, k) => F.rect(c - 2, 3, c + 2, fh - 3, 1, glass(S.seed, k, 0)));
  }
  F.rect(0, fh, W, fh + 1, 4, BM.TRIM);                                                     // band over the base
  // shaft
  for (let f = 1; f < floors; ++f) {
    const v0 = f * fh + 3;
    cs.forEach((c, k) => {
      punch(F, c, v0, 5, 8, S.seed, k * 7 + f, BM.TRIM, true, S.lintels);
      if (k % 2 === 0) F.rect(c + (bayW >> 1) - 1, f * fh, c + (bayW >> 1) + 1, (f + 1) * fh, 3, S.wall);   // pilaster
    });
  }
  if (floors > 4) F.rect(0, (floors - 1) * fh, W, (floors - 1) * fh + 1, 3, BM.TRIM);        // band under the top floor
  const t = floors * fh;                                                                    // heavy cornice
  F.rect(0, t, W, t + 1, 3, BM.LIMESTONE_DARK); F.rect(0, t + 1, W, t + 2, 4, BM.LIMESTONE);
  for (let u = 0; u < W; ++u) F.rect(u, t + 2, u + 1, t + 4, (u % 3 === 0) ? 5 : 4, S.corniceMat || BM.LIMESTONE_DARK);
  F.rect(0, t + 4, W, t + 5, 5, BM.TRIM);
  F.returns();
  return F;
}
// ---- style: Art Deco tower tier (continuous piers, dark spandrels, vertical emphasis)
function facadeDeco(W, floors, fh, S, crown) {
  const h = floors * fh + (crown ? 4 : 1);
  const F = new Relief(W, h, 2, S.wall);
  const cs = bays(W, 6, 2);
  for (let f = 0; f < floors; ++f) cs.forEach((c, k) => {
    F.rect(c - 2, f * fh + 2, c + 2, f * fh + fh - 2, 1, glass(S.seed, k * 13 + f, f, 0.35));
    F.rect(c - 2, f * fh + fh - 2, c + 2, f * fh + fh + 2, 1, BM.SPANDREL);
  });
  cs.forEach((c) => F.rect(c + 2, 0, c + 4, floors * fh, 3, S.wall));                         // piers
  F.rect(0, floors * fh, W, floors * fh + 1, 3, S.trim);
  if (crown) for (let u = 0; u < W; ++u) F.rect(u, floors * fh + 1, u + 1, floors * fh + 4, (u % 6 < 3) ? 4 : 3, S.trim);
  F.returns();
  return F;
}
// ---- style: glass curtain wall (mullion grid, spandrel bands)
function facadeGlass(W, floors, fh, S) {
  const h = floors * fh + 2;
  const F = new Relief(W, h, 1, BM.CURTAIN);
  for (let f = 0; f < floors; ++f) {
    for (let u = 0; u < W; u += 6) F.rect(u, f * fh + 2, u + 6, (f + 1) * fh - 1, BASE, H2(S.seed, u, f) < 0.33 ? BM.CURTAIN_LIT : BM.CURTAIN);
    F.rect(0, f * fh, W, f * fh + 2, BASE, BM.SPANDREL);
  }
  for (let u = 0; u < W; u += 6) F.rect(u, 0, u + 1, floors * fh, 3, BM.MULLION);
  F.rect(0, floors * fh, W, h, 3, BM.MULLION);
  F.returns();
  return F;
}

// ------------------------------------------------------------------------------------------------ building parts
// four facades of a box [x0,x1] x [z0,z1] (voxels) starting at height y0; facade(len, side, front) -> Relief
function facades(E, x0, z0, x1, z1, y0, facadeFn, C, frontSides, party) {
  // party: { l, r } - an attached neighbour at the x0 (l) / x1 (r) end. Those ends get a plain flush party wall
  // and no corner returns, so neighbouring cornices / bands never overlap (no coplanar faces between buildings).
  party = party || {};
  const W = x1 - x0, D = z1 - z0;
  const wall = (m) => m;
  const sides = [
    { len: W, map: (F) => (rx, ry, rz) => [x0 + rx - F.ext, y0 + rz, z0 + BASE - ry], side: false, front: true, lo: 'l', hi: 'r' },
    { len: W, map: (F) => (rx, ry, rz) => [x1 - (rx - F.ext), y0 + rz, z1 + (ry - BASE)], side: false, front: false, lo: 'r', hi: 'l' },
    { len: D, map: (F) => (rx, ry, rz) => [x0 + BASE - ry, y0 + rz, z1 - (rx - F.ext)], side: true, front: false, at: 'l' },
    { len: D, map: (F) => (rx, ry, rz) => [x1 + (ry - BASE), y0 + rz, z0 + (rx - F.ext)], side: true, front: false, at: 'r' }
  ];
  for (const sd of sides) {
    let F = facadeFn(sd.len, sd.side && !(frontSides || false), sd.front);
    if (sd.side && party[sd.at]) {                                // plain party wall, same height
      const P = new Relief(sd.len, F.h, 0, F.M[F.idx(0, 0)]);
      F = P;
    }
    if (sd.side) {                                                // side facades: no corner returns (front/back carry them)
      for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) { F.set(-e, v, -1, 0); F.set(sd.len - 1 + e, v, -1, 0); }
    } else {
      for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) {
        if (party[sd.lo]) F.set(-e, v, -1, 0);
        if (party[sd.hi]) F.set(sd.len - 1 + e, v, -1, 0);
      }
    }
    E.relief(F.H, F.M, F.w, F.h, sd.map(F), wall, C, BASE);
  }
}
// an emitter for a part rotated by th about building-local voxel point (cx, cz); the part's local origin is at
// the rotated offset (ox, oz) from that point. Rigid rotation of the mesh: no carving, no grid rotation.
function rotated(E, cx, cz, th, ox, oz) {
  const c = Math.cos(th), s = Math.sin(th);
  const e1 = [c * E.e1[0] + s * E.e2[0], c * E.e1[1] + s * E.e2[1]], e2 = [-s * E.e1[0] + c * E.e2[0], -s * E.e1[1] + c * E.e2[1]];
  const C0 = [E.O[0] + cx * BV * E.e1[0] + cz * BV * E.e2[0], E.O[1] + cx * BV * E.e1[1] + cz * BV * E.e2[1]];
  return new Emitter(E.mb, [C0[0] + ox * BV * e1[0] + oz * BV * e2[0], C0[1] + ox * BV * e1[1] + oz * BV * e2[1]], e1, e2, E.y0, E.v);
}
// flat roof: parapet, tar, optional penthouse and rooftop units
function flatRoof(E, x0, z0, x1, z1, yTop, S, C, opts) {
  const W = x1 - x0, D = z1 - z0, W2 = W + 2;
  const H = new Int16Array(W2 * (D + 2)).fill(-1), M = new Uint8Array(W2 * (D + 2));
  const par = opts.parapet === undefined ? 3 : opts.parapet;
  for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
    const edge = x < 1 || z < 1 || x >= W - 1 || z >= D - 1;
    const i = (z + 1) * W2 + x + 1;
    H[i] = edge ? par : 0; M[i] = edge ? (opts.parapetMat || S.trim || BM.TRIM) : BM.ROOF_TAR;
  }
  const R = C.mulberry32((S.seed * 977) | 0);
  const put = (bx, bz, bw, bd, bh, m) => {
    for (let z = bz; z < bz + bd; ++z) for (let x = bx; x < bx + bw; ++x) {
      if (x < 3 || z < 3 || x >= W - 3 || z >= D - 3) continue;
      const i = (z + 1) * W2 + x + 1; if (H[i] < bh) { H[i] = bh; M[i] = m; }
    }
  };
  if (opts.penthouse && W > 24 && D > 24) put(Math.floor(W * 0.3), Math.floor(D * 0.35), Math.floor(W * 0.4), Math.floor(D * 0.3), 12, S.wall);
  const units = opts.units === undefined ? Math.floor(W * D / 500) : opts.units;
  for (let k = 0; k < units; ++k) put(2 + Math.floor(R() * (W - 8)), 2 + Math.floor(R() * (D - 8)), 4 + Math.floor(R() * 3), 3 + Math.floor(R() * 3), 3 + Math.floor(R() * 2), BM.METAL);
  E.relief(H, M, W, D, (rx, ry, rz) => [x0 + rx, yTop + ry, z0 + rz], (m) => (m === BM.ROOF_TAR ? BM.ROOF_TAR : m), C);
  return { H, M };
}
// New York rooftop water tank: wooden barrel on a steel frame (voxel boxes)
function waterTank(E, cx, cz, y, C) {
  // wooden barrel on a steel frame, one voxel model (no overlapping boxes)
  const M = new C.VoxModel(10, 22, 10, 5, 5);
  for (const [dx, dz] of [[-4, -4], [3, -4], [-4, 3], [3, 3]]) M.box(dx, 0, dz, dx + 1, 7, dz + 1, BM.METAL);
  M.box(-4, 7, -4, 4, 8, 4, BM.METAL);
  for (let yy = 8; yy < 18; ++yy) for (let z = -4; z < 4; ++z) for (let x = -4; x < 4; ++x) {
    const r = Math.hypot(x + 0.5, z + 0.5);
    if (r < 4.1) M.box(x, yy, z, x + 1, yy + 1, z + 1, (yy === 11 || yy === 15) && r > 3.1 ? BM.METAL : BM.WOOD);
  }
  for (let k = 0; k < 3; ++k) M.box(-3 + k, 18 + k, -3 + k, 3 - k, 19 + k, 3 - k, BM.WOOD);
  E.vox(C, M, cx, y, cz);
}
// gable roof with overhangs, ridge along x; gable end triangles in the wall colour; chimney
function gableRoof(E, x0, z0, x1, z1, yTop, S, C) {
  const ov = 2, W = x1 - x0 + 2 * ov, D = z1 - z0 + 2 * ov, W2 = W + 2;
  const H = new Int16Array(W2 * (D + 2)).fill(-1), M = new Uint8Array(W2 * (D + 2));
  const slope = S.slope || 0.7;
  for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
    const i = (z + 1) * W2 + x + 1;
    const h = 1 + Math.floor(Math.min(z, D - 1 - z) * slope);
    H[i] = h;
    const gableEnd = x < ov + 1 || x >= W - ov - 1;
    const ridge = Math.min(z, D - 1 - z) >= Math.floor((D - 1) / 2) - 0;
    M[i] = ridge ? BM.TRIM_DARK : (gableEnd ? S.wall : S.roof);
  }
  // chimney
  const cx = S.chimneyLeft ? ov + 3 : W - ov - 6, cz = Math.floor(D * 0.35);
  for (let z = cz; z < cz + 3; ++z) for (let x = cx; x < cx + 3; ++x) { const i = (z + 1) * W2 + x + 1; H[i] += 6; M[i] = BM.BRICK_RED; }
  E.relief(H, M, W, D, (rx, ry, rz) => [x0 - ov + rx, yTop + ry, z0 - ov + rz], (m) => m, C);
}

// ------------------------------------------------------------------------------------------------ building types
function pick(R, a) { return a[Math.floor(R() * a.length) % a.length]; }
function buildHouse(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  const S = {
    seed: spec.seed, wall: pick(R, [BM.SIDING_WHITE, BM.SIDING_YELLOW, BM.SIDING_BLUE, BM.SIDING_SAGE, BM.SIDING_GRAY, BM.PAINT_CREAM]),
    shutter: pick(R, [BM.SHUTTER_GREEN, BM.SHUTTER_BLACK, BM.DOOR_NAVY]), door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.WOOD, BM.SHUTTER_GREEN]),
    roof: pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_BROWN, BM.SHINGLE_SLATE]), chimneyLeft: R() < 0.5, slope: 0.6 + R() * 0.25
  };
  S.wallShade = S.wall + 1000;                                     // resolved below to a shade of the siding
  S.wallShade = shadeOf(S.wall);
  const floors = spec.floors, fh = 12;
  facades(E, 0, 0, W, D, 0, (len, side, front) => facadeHouse(len, floors, fh, S, side, front), C);
  gableRoof(E, 0, 0, W, D, floors * fh, S, C);
  // front porch: deck, posts, roof, steps
  const pw = Math.min(W - 4, 24), px0 = Math.floor((W - pw) / 2);
  E.box(px0, 0, -8, px0 + pw, 2, 0, BM.WOOD);
  for (const x of [px0, px0 + pw - 1]) E.box(x, 2, -8, x + 1, 13, -7, BM.TRIM, true);
  E.box(px0 - 1, 13, -9, px0 + pw + 1, 14, 0, S.roof);
  E.box(px0 + (pw >> 1) - 3, 0, -10, px0 + (pw >> 1) + 3, 1, -8, BM.CONCRETE);
  if (spec.setback) {
    const sb = Math.round(spec.setback);
    const flat = (x0, z0, x1, z1) => E.quad([x0, 0.25, z0], [x1, 0.25, z0], [x1, 0.25, z1], [x0, 0.25, z1], BM.CONCRETE, [0, 1, 0]);
    flat(px0 + (pw >> 1) - 2, -sb, px0 + (pw >> 1) + 2, -10);                    // front walk to the sidewalk
    if (spec.garage) {                                                           // attached garage + driveway
      const gw = 14, gd = Math.min(D - 4, 22);
      E.box(W, 0, 2, W + gw, 11, 2 + gd, S.wall);
      E.box(W - 1, 11, 1, W + gw + 1, 12, 3 + gd, S.roof);
      E.box(W + 2, 0, 1, W + gw - 2, 9, 2, BM.TRIM);                             // garage door
      for (let v = 2; v < 9; v += 2) E.box(W + 2, v, 0.8, W + gw - 2, v + 0.3, 1, S.wallShade);
      flat(W + 1, -sb, W + gw - 1, 1);
    } else flat(W + 1, -sb, W + 12, Math.floor(D * 0.6));                         // driveway along the side
  }
}
function buildRows(E, W, D, spec, C) {
  // a terrace of attached rowhouses along the frontage, each 5.5-7 m wide with its own colour and detail
  const R = C.mulberry32(spec.seed);
  let x = 0, k = 0;
  while (W - x >= 20) {
    let w = 22 + Math.floor(R() * 7);
    if (W - x - w < 20) w = W - x;
    const S = {
      seed: spec.seed * 31 + k, wall: pick(R, [BM.BRICK_RED, BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN, BM.PAINT_CREAM, BM.PAINT_BLUE, BM.PAINT_YELLOW, BM.PAINT_SALMON, BM.PAINT_SAGE]),
      door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.SHUTTER_BLACK, BM.WOOD]), lintel: pick(R, [BM.LIMESTONE, BM.TRIM]), bay: R() < 0.55, trim: BM.TRIM_DARK,
      corniceMat: pick(R, [BM.TRIM_DARK, BM.TRIM, BM.LIMESTONE_DARK])
    };
    S.wallShadeOr = shadeOf(S.wall);
    const floors = spec.floors + (R() < 0.25 ? 1 : 0), fh = 13;
    facades(E, x, 0, x + w, D, 0, (len, side, front) => facadeRow(len, floors, fh, S, side, front), C, false,
      { l: x > 0 || !!(spec.party && spec.party.l), r: x + w < W || !!(spec.party && spec.party.r) });
    flatRoof(E, x, 0, x + w, D, floors * fh + 4, S, C, { parapet: 1, parapetMat: S.corniceMat, units: 1 });
    // stoop: limestone steps up to the door
    const dc = bays(w, 8, 2); const c = x + dc[dc.length - 1];
    for (let s = 0; s < 3; ++s) E.box(c - 3, 0, -4 - (3 - s) * 2, c + 3, 1 + s, -4 - (3 - s) * 2 + 2, BM.LIMESTONE);
    E.box(c - 3, 0, -4, c + 3, 4, 0, BM.LIMESTONE);
    if (R() < 0.3 && w > 24 && D > 30) waterTank(E, x + (w >> 1), Math.floor(D * 0.6), floors * fh + 4, C);
    x += w; ++k;
  }
}
function buildMid(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  const brick = R() < 0.45;
  const S = {
    seed: spec.seed, wall: brick ? pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK]) : pick(R, [BM.LIMESTONE, BM.BUFF, BM.LIMESTONE_DARK]),
    base: pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK]), awning: pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]),
    shops: spec.shops, bayW: pick(R, [9, 10, 11]), lintels: R() < 0.6, trim: BM.TRIM
  };
  const floors = spec.floors, fh = 14;
  facades(E, 0, 0, W, D, 0, (len, side) => facadeMid(len, floors, fh, S, side), C, true, spec.party);
  flatRoof(E, 0, 0, W, D, floors * fh + 5, S, C, { parapet: 2, parapetMat: BM.LIMESTONE_DARK, penthouse: floors >= 7 });
  if (R() < 0.45 && W > 30 && D > 30) waterTank(E, Math.floor(W * (0.2 + R() * 0.5)), Math.floor(D * 0.6), floors * fh + 5, C);
}
// ================================================================================================ signature towers
// Every high-rise is its own project: a base built for it (or an older building it rises from), a body with its
// own facade system, and a top that finishes the idea. Eight archetypes, dealt from a shuffled deck so
// neighbouring towers never share a design. Rectangular tiers use facades() (corner returns), notched tiers use
// prism() (facades along every outline run). Roofs know which part is covered by the next tier: no parapets or
// tar under walls, so nothing is coplanar.
const FH = 14;                                                     // storey height in voxels (3.5 m)
function rectMask(W, D, x0, z0, x1, z1, notch) {
  const m = new Uint8Array(W * D);
  for (let z = Math.max(0, z0); z < Math.min(D, z1); ++z) for (let x = Math.max(0, x0); x < Math.min(W, x1); ++x) {
    if (notch && (x < x0 + notch || x >= x1 - notch) && (z < z0 + notch || z >= z1 - notch)) continue;
    m[z * W + x] = 1;
  }
  return m;
}
function stripExt(F) { for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) { F.set(-e, v, -1, 0); F.set(F.w0 - 1 + e, v, -1, 0); } return F; }
// facades along every straight run of a mask outline
function prism(E, C, mask, W, D, y0, h, skin) {
  const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1;
  const runs = [];
  for (let z = 0; z <= D; ++z) {
    let cur = null;
    for (let x = 0; x <= W; ++x) {
      const a = inn(x, z - 1), b = inn(x, z), t = x < W ? (b && !a ? 'nz' : a && !b ? 'pz' : null) : null;
      if (cur && cur.t !== t) { runs.push(cur); cur = null; }
      if (t && !cur) cur = { t, s: x, e: x + 1, L: z };
      else if (t) cur.e = x + 1;
    }
  }
  for (let x = 0; x <= W; ++x) {
    let cur = null;
    for (let z = 0; z <= D; ++z) {
      const a = inn(x - 1, z), b = inn(x, z), t = z < D ? (b && !a ? 'nx' : a && !b ? 'px' : null) : null;
      if (cur && cur.t !== t) { runs.push(cur); cur = null; }
      if (t && !cur) cur = { t, s: z, e: z + 1, L: x };
      else if (t) cur.e = z + 1;
    }
  }
  let minZ = D; for (const r of runs) if (r.t === 'nz') minZ = Math.min(minZ, r.L);
  for (const r of runs) {
    const len = r.e - r.s;
    if (len < 1) continue;
    const F = stripExt(skin(len, h, { front: r.t === 'nz' && r.L <= minZ + 2, side: r.t === 'nx' || r.t === 'px' }));
    const map = r.t === 'nz' ? (rx, ry, rz) => [r.s + rx - F.ext, y0 + rz, r.L + BASE - ry]
      : r.t === 'pz' ? (rx, ry, rz) => [r.e - (rx - F.ext), y0 + rz, r.L + (ry - BASE)]
      : r.t === 'nx' ? (rx, ry, rz) => [r.L + BASE - ry, y0 + rz, r.e - (rx - F.ext)]
      : (rx, ry, rz) => [r.L + (ry - BASE), y0 + rz, r.s + (rx - F.ext)];
    E.relief(F.H, F.M, F.w, F.h, map, (m) => m, C, BASE);
  }
}
// flat roof over a mask; cells under the next tier are left out; parapet on the outline; rooftop units
function roofMask(E, C, mask, cover, W, D, yTop, o, seed) {
  const W2 = W + 2, H = new Int16Array(W2 * (D + 2)).fill(-1), M = new Uint8Array(W2 * (D + 2));
  const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1;
  const cov = (x, z) => cover && cover[z * W + x] === 1;
  const par = o.parapet === undefined ? 2 : o.parapet;
  for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
    if (!inn(x, z) || cov(x, z)) continue;
    const edge = !inn(x - 1, z) || !inn(x + 1, z) || !inn(x, z - 1) || !inn(x, z + 1);
    const i = (z + 1) * W2 + x + 1;
    H[i] = edge ? par : 0; M[i] = edge ? (o.mat || BM.LIMESTONE_DARK) : (o.deck || BM.ROOF_TAR);
  }
  const R = C.mulberry32(seed | 0);
  const free = (bx, bz, bw, bd) => { for (let z = bz - 1; z <= bz + bd; ++z) for (let x = bx - 1; x <= bx + bw; ++x) { if (!inn(x, z) || cov(x, z)) return false; const i = (z + 1) * W2 + x + 1; if (H[i] !== 0) return false; } return true; };
  let tries = 0, placed = 0;
  while (placed < (o.units || 0) && tries++ < 60) {
    const bw = 4 + Math.floor(R() * 5), bd = 3 + Math.floor(R() * 4), bx = Math.floor(R() * W), bz = Math.floor(R() * D);
    if (!free(bx, bz, bw, bd)) continue;
    const bh = 3 + Math.floor(R() * 3);
    for (let z = bz; z < bz + bd; ++z) for (let x = bx; x < bx + bw; ++x) { const i = (z + 1) * W2 + x + 1; H[i] = bh; M[i] = (x - bx) % 2 ? BM.METAL : BM.LOUVER; }
    placed++;
  }
  E.relief(H, M, W, D, (rx, ry, rz) => [rx, yTop + ry, rz], (m) => m, C);
}
// tiers: { x0,z0,x1,z1 [,notch] | mask, h, skin, roof, party, noRoof, floating } or { gap: h } (open storeys).
// A tier after a gap, or marked floating, gets a soffit (its underside). Returns the top y (voxels).
function soffit(E, mask, W, D, y, mat) {
  for (let z = 0; z < D; ++z) {
    let x = 0;
    while (x < W) {
      if (!mask[z * W + x]) { ++x; continue; }
      let x1 = x; while (x1 < W && mask[z * W + x1]) ++x1;
      E.quad([x, y, z], [x1, y, z], [x1, y, z + 1], [x, y, z + 1], mat, [0, -1, 0]);
      x = x1;
    }
  }
}
function buildTiers(E, C, W, D, tiers, seed) {
  let y = 0;
  const maskOf = (t) => t.mask || rectMask(W, D, t.x0, t.z0, t.x1, t.z1, t.notch || 0);
  tiers.forEach((t, i) => {
    t.y = y;
    if (t.gap) { y += t.gap; return; }
    const mask = maskOf(t);
    if (!t.mask && !t.notch) facades(E, t.x0, t.z0, t.x1, t.z1, y, (len, side, front) => t.skin(len, t.h, { side, front }), C, true, t.party);
    else prism(E, C, mask, W, D, y, t.h, t.skin);
    const pv = tiers[i - 1];
    if (i > 0 && (pv.gap || t.floating)) soffit(E, mask, W, D, y, t.soffit || BM.CONCRETE);
    const nx = tiers[i + 1];
    const cover = nx && !nx.floating && !nx.gap ? maskOf(nx) : null;
    if (!t.noRoof) roofMask(E, C, mask, cover, W, D, y + t.h, t.roof || {}, seed + i * 31);
    y += t.h;
  });
  return y;
}
function inset(W, D, l, f, r, b) { return { x0: l, z0: f, x1: W - r, z1: D - b }; }

// ---- skins: (len, h, info) -> Relief. h is the exact height in voxels.
function glassMat(seed, a, b, lit, dark) {
  const on = H2(seed, a, b) < (lit === undefined ? 0.3 : lit);
  if (dark === 'green') return on ? BM.GLASS_GREEN_LIT : BM.GLASS_GREEN;
  if (dark === 'dark') return on ? BM.GLASS_DARK_LIT : BM.GLASS_DARK;
  if (dark === 'blue') return on ? BM.GLASS_BLUE_LIT : BM.GLASS_BLUE;
  if (dark === 'curtain') return on ? BM.CURTAIN_LIT : BM.CURTAIN;
  return on ? BM.GLASS_LIT : BM.GLASS;
}
// storefront base: lobby with revolving door + canopy on the front, shops elsewhere, stone above
function skinPodium(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 2, S.stone), gH = 18;
    F.rect(0, 0, len, gH, BASE, S.stoneDark);
    F.rect(0, gH, len, gH + 1, 3, S.stoneDark);
    const cs = bays(len, 12, 3), mid = cs.length >> 1;
    cs.forEach((c, k) => {
      if (info.front && k === mid && len > 30) {
        F.rect(c - 9, 0, c + 9, gH - 1, 0, glassMat(S.seed, k, 1, 0.6, 'dark'));            // double-height lobby
        for (let u = c - 9; u <= c + 8; u += 4) F.rect(u, 0, u + 1, gH - 1, 1, BM.BRONZE);
        F.rect(c - 2, 0, c + 2, 9, 1, BM.BRONZE);                                           // revolving door
        F.rect(c - 12, gH - 4, c + 12, gH - 2, 7, S.canopy || BM.BRONZE);                   // canopy
        return;
      }
      F.rect(c - 5, 1, c + 5, gH - 6, 1, glassMat(S.seed, k, 2, 0.45, 'dark'));            // shop window
      F.rect(c - 5, gH - 6, c + 5, gH - 4, 1, BM.TRIM_DARK);                                // sign band
      F.rect(c - 6, 0, c - 5, gH - 3, 3, S.stoneDark); F.rect(c + 5, 0, c + 6, gH - 3, 3, S.stoneDark);
    });
    const n = Math.floor((h - gH - 3) / FH);
    for (let f = 0; f < n; ++f) cs.forEach((c, k) => {
      const v0 = gH + 1 + f * FH + 3;
      F.rect(c - 4, v0, c + 4, v0 + 8, 1, glassMat(S.seed, k * 3 + f, 7));
      F.rect(c - 4, v0 + 3, c + 4, v0 + 4, 1, BM.BRONZE);
      F.rect(c - 5, v0 - 1, c + 5, v0, 3, S.stoneDark);
    });
    F.rect(0, h - 3, len, h - 1, 3, S.stoneDark); F.rect(0, h - 1, len, h, 4, S.stone);
    F.returns();
    return F;
  };
}
// Art Deco: continuous stone piers, recessed windows over chevron spandrels, crowned bands
function skinDeco(S, crown) {
  return (len, h) => {
    const F = new Relief(len, h, 2, S.stone);
    const cs = bays(len, 6, 3), n = Math.floor((h - (crown ? 6 : 2)) / FH);
    for (let f = 0; f < n; ++f) cs.forEach((c, k) => {
      const v = f * FH;
      F.rect(c - 2, v + 3, c + 2, v + FH - 2, 1, glassMat(S.seed, k * 13 + f, f, 0.35));
      F.rect(c - 2, v + FH - 2, c + 2, v + FH, 1, BM.BRONZE);
      F.rect(c - 1, v + FH - 1, c + 1, v + FH, 1, S.trim);                                  // chevron accent
      F.rect(c - 2, v, c + 2, v + 3, 1, BM.BRONZE);
    });
    cs.forEach((c) => F.rect(c + 2, 0, c + 4, n * FH, 3, S.stone));                         // piers
    F.rect(0, 0, 3, h, 4, S.stone); F.rect(len - 3, 0, len, h, 4, S.stone);                 // corner piers
    if (crown) {
      F.rect(0, h - 6, len, h - 5, 3, S.trim);
      for (let u = 0; u < len; ++u) F.rect(u, h - 5, u + 1, h, (u % 6) < 3 ? 4 : 3, (u % 6) < 3 ? S.stone : S.trim);
    } else F.rect(0, h - 2, len, h, 3, S.trim);
    F.returns();
    return F;
  };
}
function skinDecoBase(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 2, S.stone), gH = 20;
    F.rect(0, 0, len, gH, BASE, BM.GRANITE_DARK);
    for (let v = 2; v < gH; v += 3) F.rect(0, v, len, v + 1, 3, BM.GRANITE_DARK);           // rusticated granite
    const cs = bays(len, 12, 3), mid = cs.length >> 1;
    cs.forEach((c, k) => {
      if (info.front && k === mid && len > 30) {                                            // grand portal, 3 storeys
        F.rect(c - 7, 0, c + 7, gH + 2 * FH, 0, BM.BRONZE);
        for (let v = 4; v < gH + 2 * FH; v += 5) F.rect(c - 6, v, c + 6, v + 3, 0, glassMat(S.seed, v, 3, 0.6, 'dark'));
        F.rect(c - 9, 0, c - 7, gH + 2 * FH + 3, 4, S.stone); F.rect(c + 7, 0, c + 9, gH + 2 * FH + 3, 4, S.stone);
        F.rect(c - 9, gH + 2 * FH, c + 9, gH + 2 * FH + 3, 4, S.stone);
        return;
      }
      F.rect(c - 4, 2, c + 4, gH - 4, 1, glassMat(S.seed, k, 2, 0.45, 'dark'));
      F.rect(c - 4, gH - 4, c + 4, gH - 3, 1, BM.BRONZE);
    });
    const n = Math.floor((h - gH - 4) / FH);
    for (let f = 0; f < n; ++f) cs.forEach((c, k) => {
      if (info.front && k === mid && len > 30 && f < 2) return;
      const v0 = gH + f * FH + 3;
      F.rect(c - 3, v0, c + 3, v0 + 9, 1, glassMat(S.seed, k * 7 + f, 5));
      F.rect(c - 4, v0 - 1, c + 4, v0, 3, S.trim);
      F.rect(c + 5, gH, c + 6, h - 4, 3, S.stone);
    });
    F.rect(0, h - 4, len, h - 3, 3, S.trim); F.rect(0, h - 3, len, h - 1, 4, S.stone); F.rect(0, h - 1, len, h, 5, S.trim);
    F.returns();
    return F;
  };
}
// curtain wall: per-floor spandrel + slab edge, projecting mullions, mechanical louver floors
function skinCurtain(S, o) {
  o = o || {};
  return (len, h) => {
    const F = new Relief(len, h, 1, BM.CURTAIN), pitch = o.pitch || 5, n = Math.floor(h / FH);
    for (let f = 0; f < n; ++f) {
      const v = f * FH, mech = o.mech && o.mech.includes(f);
      if (mech) {
        for (let r = 0; r < FH; ++r) F.rect(0, v + r, len, v + r + 1, BASE, r % 2 ? BM.LOUVER : BM.METAL);
        continue;
      }
      for (let u = 0; u < len; u += pitch) F.rect(u, v + 2, Math.min(len, u + pitch), v + FH, BASE, glassMat(S.seed, u + f * 101, f, o.lit, o.tint || 'curtain'));
      F.rect(0, v, len, v + 2, BASE, o.spandrel || BM.SPANDREL);
      if (o.slabs) F.rect(0, v, len, v + 1, 4, o.slabMat || BM.TRIM);
    }
    for (let u = 0; u <= len - 1; u += pitch) F.rect(u, 0, u + 1, n * FH, o.fin ? 4 : 3, o.mullion || BM.MULLION);
    F.rect(len - 1, 0, len, n * FH, 3, o.mullion || BM.MULLION);
    if (h > n * FH) F.rect(0, n * FH, len, h, 3, o.cap || o.mullion || BM.MULLION);
    F.returns();
    return F;
  };
}
// International Style: bronze I-beam mullions every 4 voxels, dark glass, bronze spandrels
function skinBronze(S, o) {
  o = o || {};
  return (len, h) => {
    const F = new Relief(len, h, 2, BM.BRONZE), n = Math.floor(h / FH);
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      if (o.mech && o.mech.includes(f)) { for (let r = 1; r < FH; r += 2) F.rect(0, v + r, len, v + r + 1, 1, BM.LOUVER); continue; }
      for (let u = 0; u < len; u += 6) F.rect(u, v + 3, u + 6, v + FH, 1, glassMat(S.seed, u, f, 0.28, 'dark'));
      F.rect(0, v, len, v + 3, BASE, BM.BRONZE);
    }
    for (let u = 0; u < len; u += 6) F.rect(u, 0, u + 1, n * FH, 3, BM.BRONZE);
    if (h > n * FH) F.rect(0, n * FH, len, h, 3, BM.BRONZE);
    F.returns();
    return F;
  };
}
// pilotis: deeply recessed glass lobby behind columns, transfer beam on top
function skinPilotis(S) {
  return (len, h) => {
    const F = new Relief(len, h, 0, S.col);
    F.rect(0, 0, len, h - 3, 0, glassMat(S.seed, 1, 1, 0.7, 'dark'));
    for (let u = 0; u < len; u += 4) F.rect(u, 0, u + 1, h - 3, 0, BM.BRONZE);
    for (let u = 3; u < len - 2; u += 14) F.rect(u, 0, u + 3, h - 3, 4, S.col);
    F.rect(0, 0, 3, h, 4, S.col); F.rect(len - 3, 0, len, h, 4, S.col);
    F.rect(0, h - 3, len, h, 4, S.col);
    return F;
  };
}
// slim residential: limestone / terracotta fins, recessed glass, bronze spandrels, banded every 4 floors
function skinFins(S) {
  return (len, h) => {
    const F = new Relief(len, h, 2, S.stone), n = Math.floor(h / FH);
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      for (let u = 0; u < len; u += 4) F.rect(u + 1, v + 3, Math.min(len, u + 4), v + FH, 1, glassMat(S.seed, u, f, 0.38, 'green'));
      F.rect(0, v, len, v + 3, 1, BM.BRONZE);
      if (f % 4 === 3) F.rect(0, v + FH - 1, len, v + FH, 4, S.stone);
    }
    for (let u = 0; u < len; u += 4) F.rect(u, 0, u + 1, n * FH, 4, (u / 4) % 2 ? S.stone : S.alt);
    F.rect(0, 0, 2, h, 4, S.stone); F.rect(len - 2, 0, len, h, 4, S.stone);
    if (h > n * FH) F.rect(0, n * FH, len, h, 3, S.stone);
    F.returns();
    return F;
  };
}
// postmodern: polished granite, paired punched windows, dark bands, a recessed glass slot up the middle
function skinPomo(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 2, S.stone), n = Math.floor(h / FH);
    const cs = bays(len, 10, 3), mid = len >> 1;
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      cs.forEach((c, k) => {
        if (Math.abs(c - mid) < 6) return;
        F.rect(c - 4, v + 4, c - 1, v + 11, 1, glassMat(S.seed, k * 2 + f * 17, f, 0.3, 'green'));
        F.rect(c + 1, v + 4, c + 4, v + 11, 1, glassMat(S.seed, k * 2 + 1 + f * 17, f, 0.3, 'green'));
        F.rect(c - 5, v + 3, c + 5, v + 4, 3, S.dark);
      });
      if (f % 4 === 0) F.rect(0, v, len, v + 2, 3, S.dark);
    }
    if (len > 24) {
      F.rect(mid - 4, 0, mid + 4, n * FH, 0, BM.GLASS_GREEN);
      for (let f = 0; f < n; ++f) F.rect(mid - 4, f * FH, mid + 4, f * FH + 1, 0, S.dark);
      if (H2(S.seed, 1, 1) < 0.5) for (let f = 0; f < n; ++f) F.rect(mid - 4, f * FH + 2, mid + 4, f * FH + FH - 1, 0, glassMat(S.seed, 9, f, 0.4, 'green'));
    }
    if (h > n * FH) F.rect(0, n * FH, len, h, 4, S.dark);
    F.returns();
    return F;
  };
}
function skinArcade(S) {
  return (len, h) => {
    const F = new Relief(len, h, 2, S.stone), aH = 2 * FH + 4;
    F.rect(0, 0, len, aH, 0, S.dark);
    const cs = bays(len, 10, 2);
    cs.forEach((c, k) => F.rect(c - 3, 1, c + 3, aH - 6, 0, glassMat(S.seed, k, 4, 0.5, 'green')));
    for (let u = 0; u < len; u += 10) F.rect(u, 0, Math.min(len, u + 3), aH, 4, S.stone);  // square piers
    F.rect(0, aH - 3, len, aH, 4, S.stone);
    F.rect(len - 3, 0, len, aH, 4, S.stone);
    for (let f = 0; aH + f * FH + 12 < h; ++f) cs.forEach((c, k) => F.rect(c - 3, aH + f * FH + 3, c + 3, aH + f * FH + 10, 1, glassMat(S.seed, k, f + 9, 0.3, 'green')));
    F.rect(0, h - 2, len, h, 4, S.dark);
    F.returns();
    return F;
  };
}
// brutalist precast: deep concrete frames around every window
function skinPrecast(S) {
  return (len, h) => {
    const F = new Relief(len, h, 2, S.conc), n = Math.floor(h / FH);
    for (let f = 0; f < n; ++f) for (let u = 0; u + 6 <= len; u += 6) {
      const v = f * FH;
      F.rect(u, v, u + 6, v + FH, 3, S.conc);
      F.rect(u + 1, v + 3, u + 6, v + FH - 1, 1, glassMat(S.seed, u, f, 0.3, 'dark'));
      F.rect(u + 1, v + 2, u + 6, v + 3, 2, S.conc);
    }
    if (h > n * FH) for (let u = 0; u < len; u += 3) F.rect(u, n * FH, u + 2, h, 3, S.conc);
    F.returns();
    return F;
  };
}
function skinLouver(S) {
  return (len, h) => {
    const F = new Relief(len, h, 1, BM.METAL);
    for (let v = 0; v < h; ++v) F.rect(0, v, len, v + 1, v % 2 ? 3 : 2, v % 2 ? BM.LOUVER : BM.METAL);
    for (let u = 0; u < len; u += 8) F.rect(u, 0, u + 1, h, 4, S.frame || BM.MULLION);
    F.rect(0, h - 1, len, h, 4, S.frame || BM.MULLION);
    F.returns();
    return F;
  };
}

// ---- voxel parts (VoxModel at building voxel scale): crowns, lanterns, masts, cranes, plaza pieces
function decoCrownModel(s, S) {
  const M = new C_VoxModel(s + 4, 120, s + 4, (s >> 1) + 2, (s >> 1) + 2), h0 = s >> 1;
  let r = h0, y = 0, k = 0;
  while (r > 3) {
    const t = k % 2 ? S.trim : S.stone;
    M.box(-r, y, -r, r, y + 7, r, t);
    for (let u = -r + 2; u < r - 1; u += 3) { M.box(u, y + 2, -r - 1, u + 1, y + 6, -r, BM.BRONZE); M.box(u, y + 2, r, u + 1, y + 6, r + 1, BM.BRONZE); M.box(-r - 1, y + 2, u, -r, y + 6, u + 1, BM.BRONZE); M.box(r, y + 2, u, r + 1, y + 6, u + 1, BM.BRONZE); }
    y += 7; r -= 3; ++k;
  }
  M.box(-2, y, -2, 2, y + 6, 2, BM.BRONZE); M.box(-1, y + 6, -1, 1, y + 40, 1, BM.METAL); M.box(-1, y + 40, -1, 1, y + 41, 1, BM.BEACON);
  return M;
}
function lanternModel(w, d, S) {
  // open structural crown: corner posts, mid posts, beams at two levels; sky visible through it
  const M = new C_VoxModel(w + 2, 40, d + 2, 1, 1);
  const posts = [];
  for (let x = 0; x <= w - 2; x += Math.max(4, (w - 2) >> 2)) { posts.push([x, 0]); posts.push([x, d - 2]); }
  for (let z = 0; z <= d - 2; z += Math.max(4, (d - 2) >> 2)) { posts.push([0, z]); posts.push([w - 2, z]); }
  for (const [x, z] of posts) M.box(x, 0, z, x + 2, 28, z + 2, S.stone);
  for (const y of [13, 26]) { M.box(0, y, 0, w, y + 2, 2, S.stone); M.box(0, y, d - 2, w, y + 2, d, S.stone); M.box(0, y, 2, 2, y + 2, d - 2, S.stone); M.box(w - 2, y, 2, w, y + 2, d - 2, S.stone); }
  M.box((w >> 1) - 1, 28, (d >> 1) - 1, (w >> 1) + 1, 38, (d >> 1) + 1, BM.METAL); M.box((w >> 1) - 1, 38, (d >> 1) - 1, (w >> 1) + 1, 39, (d >> 1) + 1, BM.BEACON);
  return M;
}
function mastsModel(R) {
  const M = new C_VoxModel(16, 80, 16, 8, 8);
  M.box(-5, 0, -5, 5, 3, 5, BM.METAL);
  const n = 2 + Math.floor(R() * 2);
  for (let k = 0; k < n; ++k) {
    const x = -4 + k * 4, hgt = 30 + Math.floor(R() * 40);
    M.box(x, 3, -1, x + 1, hgt, 0, BM.METAL); M.box(x, hgt, -1, x + 1, hgt + 1, 0, BM.BEACON);
    for (let y = 10; y < hgt; y += 12) M.box(x - 1, y, -2, x + 2, y + 1, 1, BM.METAL);
  }
  return M;
}
function craneModel(L) {
  // window-washing gantry: rail ring + small jib
  const M = new C_VoxModel(L + 4, 14, 10, 2, 5);
  M.box(0, 0, -1, L, 1, 1, BM.METAL);
  M.box(2, 1, -2, 6, 5, 2, BM.METAL); M.box(3, 5, -1, 5, 12, 1, BM.METAL); M.box(3, 11, -1, 14, 12, 0, BM.METAL);
  return M;
}
function pyramidModel(w, d, S) {
  const M = new C_VoxModel(w + 2, 80, d + 2, 1, 1);
  let y = 0, a = 0;
  while (w - 2 * a > 4 && d - 2 * a > 4) { M.box(a, y, a, w - a, y + 3, d - a, (a / 2) % 2 ? S.dark : S.stone); y += 3; a += 2; }
  M.box((w >> 1) - 1, y, (d >> 1) - 1, (w >> 1) + 1, y + 14, (d >> 1) + 1, BM.BRONZE);
  return M;
}
function pedimentModel(w, d, S) {
  // broken pediment: a stepped gable along x with a round-ish notch cut out of the apex
  const M = new C_VoxModel(w + 2, 60, d + 2, 1, 1);
  const half = w >> 1, rise = Math.min(30, half);
  for (let x = 0; x < w; ++x) {
    const hh = Math.round(rise * (1 - Math.abs(x - half + 0.5) / half));
    for (let y = 0; y < hh; ++y) {
      const dx = x - half + 0.5, dy = y - rise + 4;
      if (dx * dx + dy * dy < 30 && y > rise - 9) continue;                          // the notch
      M.box(x, y, 0, x + 1, y + 1, d, y >= hh - 2 ? S.dark : S.stone);
    }
  }
  return M;
}
function plazaModel(w, d, R) {
  // corporate plaza: granite paving, two fountain basins, planters with trees
  const M = new C_VoxModel(w, 40, d, 0, 0);
  M.box(0, 0, 0, w, 1, d, BM.GRANITE_DARK);
  for (let x = 4; x < w - 4; x += 8) M.box(x, 0, 2, x + 7, 1, d - 2, BM.LIMESTONE);
  const bw = Math.min(22, (w >> 1) - 8), bd = Math.min(12, d - 10);
  if (bd >= 6) for (const x0 of [4, w - 4 - bw]) {
    M.box(x0, 1, 4, x0 + bw, 3, 4 + bd, BM.LIMESTONE);
    M.box(x0 + 1, 1, 5, x0 + bw - 1, 2, 3 + bd, BM.WATER);
  }
  for (let x = 3; x < w - 6; x += 16) {
    const z = d - 6;
    M.box(x, 1, z, x + 5, 4, z + 5, BM.GRANITE_DARK); M.box(x + 2, 4, z + 2, x + 3, 14, z + 3, 135);
    M.box(x - 2, 12, z - 2, x + 7, 18, z + 7, 133); M.box(x, 18, z, x + 5, 21, z + 5, 134);
  }
  return M;
}
function planterRowModel(len) {
  const M = new C_VoxModel(len, 10, 4, 0, 0);
  for (let x = 0; x + 4 <= len; x += 6) { M.box(x, 0, 0, x + 4, 3, 4, BM.CONCRETE); M.box(x, 3, 0, x + 4, 6, 4, x % 12 ? 133 : 134); }
  return M;
}
let C_VoxModel = null;                                             // set by buildAll (CityCore.VoxModel)

// ---- detail parts for the signature towers: trees, planted beds, arches, columns, roof caps
// a street / terrace tree grown into any VoxModel at (x, y, z); returns its height
function addTree(M, x, y, z, R, s) {
  s = s || 1;
  const th = Math.round((8 + R() * 5) * s), cr = Math.max(3, Math.round((3.5 + R() * 2) * s));
  const a = R() < 0.6 ? BM.LEAF : BM.LEAF_DARK, b = a === BM.LEAF ? BM.LEAF_DARK : BM.LEAF;
  M.box(x - 1, y, z - 1, x + 1, y + th, z + 1, BM.TRUNK);
  M.box(x - cr, y + th - 2, z - cr + 1, x + cr, y + th + cr - 1, z + cr - 1, a);
  M.box(x - cr + 1, y + th - 3, z - cr, x + cr - 1, y + th + cr, z + cr, a);
  M.box(x - cr + 2, y + th + cr, z - cr + 2, x + cr - 2, y + th + cr + 2, z + cr - 2, b);
  return th + cr + 2;
}
// planted bed w x d (rim, grass, shrubs, optional trees every o.tree voxels); origin at its corner, sits on a deck
function gardenModel(w, d, R, o) {
  o = o || {};
  const pad = 10, M = new C_VoxModel(w + 2 * pad, 52, d + 2 * pad, pad, pad), rim = o.rim || BM.CONCRETE;
  M.box(0, 0, 0, w, 3, d, rim);
  M.box(1, 1, 1, w - 1, 2, d - 1, BM.GRASS);
  M.box(1, 2, 1, w - 1, 3, d - 1, -1);
  const along = w >= d, L = along ? w : d, T = along ? d : w;
  const n = Math.floor(L * T / 26);
  for (let i = 0; i < n; ++i) {
    const a = 2 + Math.floor(R() * Math.max(1, L - 5)), b = 1 + Math.floor(R() * Math.max(1, T - 3)), hh = 4 + Math.floor(R() * 3);
    const [x, z] = along ? [a, b] : [b, a];
    M.box(x - 1, 2, z - 1, Math.min(w - 1, x + 2), hh, Math.min(d - 1, z + 2), R() < 0.5 ? BM.LEAF_DARK : BM.LEAF);
  }
  if (o.tree && T >= 4) {
    const k = Math.max(1, Math.round((L - 4) / o.tree)), st = (L - 4) / k;
    for (let i = 0; i < k; ++i) {
      const a = Math.round(2 + st * (i + 0.5)), b = T >> 1;
      const [x, z] = along ? [a, b] : [b, a];
      addTree(M, x, 2, z, R, o.treeSize || 1);
    }
  }
  return M;
}
// planted beds along the exposed edges of a setback terrace: outer = the roof the beds sit on, inner = the tier above
function terraceGardens(E, C, outer, inner, y, R, o) {
  o = o || {};
  const g = { f: inner.z0 - outer.z0, b: outer.z1 - inner.z1, l: inner.x0 - outer.x0, r: outer.x1 - inner.x1 };
  const bt = (gap) => Math.min(o.max || 6, gap - 4);
  const fz = g.f >= 7 ? bt(g.f) : 0, bz = g.b >= 7 ? bt(g.b) : 0, nt = o.notch || 0;
  if (fz) E.vox(C, gardenModel(outer.x1 - outer.x0 - 4 - 2 * nt, fz, R, { rim: o.rim, tree: fz >= 5 && o.trees ? o.tree || 16 : 0, treeSize: o.treeSize }), outer.x0 + 2 + nt, y, outer.z0 + 2);
  if (bz && o.back) E.vox(C, gardenModel(outer.x1 - outer.x0 - 4 - 2 * nt, bz, R, { rim: o.rim }), outer.x0 + 2 + nt, y, outer.z1 - 2 - bz);
  const za = Math.max(outer.z0 + 2 + nt, outer.z0 + 2 + (fz ? fz + 2 : 0)), zb = Math.min(outer.z1 - 2 - nt, outer.z1 - 2 - (bz && o.back ? bz + 2 : 0));
  if (zb - za >= 8) for (const [gap, x] of [[g.l, outer.x0 + 2], [g.r, null]]) {
    if (gap < 7) continue;
    const t = bt(gap);
    E.vox(C, gardenModel(t, zb - za, R, { rim: o.rim, tree: t >= 5 && o.trees ? o.tree || 16 : 0, treeSize: o.treeSize }), x === null ? outer.x1 - 2 - t : x, y, za);
  }
}
// round arch opening in a relief: u0..u1 wide, from v0 to the springing line vs, semicircular head; ring of voussoirs
function reliefArch(F, u0, u1, v0, vs, d, m, ringM, ringD) {
  const a = (u1 - u0) / 2, c = (u0 + u1) / 2, top = [];
  for (let u = u0; u < u1; ++u) { const x = u + 0.5 - c; top.push(vs + Math.round(Math.sqrt(Math.max(0, a * a - x * x)))); }
  for (let u = u0; u < u1; ++u) {
    const i = u - u0, t = top[i], hi = Math.max(t + 2, (top[i - 1] === undefined ? vs : top[i - 1]) + 1, (top[i + 1] === undefined ? vs : top[i + 1]) + 1);
    if (ringM) F.rect(u, t, u + 1, hi, ringD, ringM);
    F.rect(u, v0, u + 1, t, d, m);
  }
  if (ringM) { F.rect(u0 - 1, vs - 1, u0, vs + 2, ringD, ringM); F.rect(u1, vs - 1, u1 + 1, vs + 2, ringD, ringM); }
}
// one free-standing column (shared model per size / material); bottom at y
const _cols = {};
function columnModel(sx, sz, h, m, cap) {
  const k = [sx, sz, h, m, cap || 0].join();
  if (_cols[k] && _cols[k].C === C_VoxModel) return _cols[k].M;
  const M = new C_VoxModel(sx + 2, h, sz + 2, 1, 1);
  M.box(0, 0, 0, sx, h, sz, m);
  if (cap) M.box(-1, h - cap, -1, sx + 1, h, sz + 1, m);
  _cols[k] = { M, C: C_VoxModel };
  return M;
}

// ---- skins for the signature towers
// Art Deco base: rusticated granite ground storey, a three-storey stepped portal, bronze shopfronts, stone above
function skinDecoBase2(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 3, S.stone), gH = 24, top = h - 7;
    F.rect(0, 0, len, gH, 3, S.granite);                                                    // rusticated plinth
    for (let v = 4; v < gH; v += 5) F.rect(0, v, len, v + 1, 2, S.granite);
    F.rect(0, gH, len, gH + 2, 4, S.granite);
    const cs = bays(len, 14, 5), c0 = len >> 1, portal = info.front && len > 48, pH = gH + 2 * FH;
    const nf = Math.floor((top - gH - 2) / FH);
    cs.forEach((c, k) => {
      const nearP = portal && Math.abs(c - c0) < 25;
      if (!nearP) {                                                                         // bronze shopfront
        F.rect(c - 5, 2, c + 5, gH - 3, 1, BM.BRONZE);
        F.rect(c - 4, 3, c + 4, gH - 8, 0, glassMat(S.seed, k, 2, 0.5, 'dark'));
        F.rect(c - 4, gH - 7, c + 4, gH - 4, 0, glassMat(S.seed, k, 3, 0.5, 'dark'));
      }
      for (let f = 0; f < nf; ++f) {                                                        // windows + spandrels
        if (nearP && f < 2) continue;
        const v0 = gH + 2 + f * FH;
        F.rect(c - 3, v0 + 2, c + 3, v0 + FH - 3, 1, glassMat(S.seed, k * 7 + f, 5, 0.35));
        F.rect(c - 3, v0 + FH - 3, c + 3, v0 + FH, 1, BM.BRONZE);
        F.rect(c - 4, v0 + 1, c + 4, v0 + 2, 3, S.trim);
      }
      if (!nearP || Math.abs(c - c0) > 19) F.rect(c + 6, gH + 2, c + 8, top, 3, S.stone);   // piers
    });
    if (portal) {
      const c = c0;
      F.rect(c - 16, 0, c + 16, pH + 7, 5, S.stone);                                       // stepped frame, 3 orders
      F.rect(c - 13, 0, c + 13, pH + 5, 4, S.trim);
      F.rect(c - 11, 0, c + 11, pH + 3, 3, S.stone);
      F.rect(c - 9, 0, c + 9, pH - 9, 0, BM.GLASS_DARK_LIT);                               // opening, ziggurat head
      F.rect(c - 6, pH - 9, c + 6, pH - 5, 0, BM.GLASS_DARK_LIT);
      F.rect(c - 3, pH - 5, c + 3, pH, 0, BM.GLASS_DARK_LIT);
      for (let u = c - 7; u < c + 8; u += 3) F.rect(u, 13, u + 1, pH - 9, 1, BM.BRONZE);    // bronze screen
      for (const v of [13, gH + 6, gH + FH + 6]) F.rect(c - 9, v, c + 9, v + 1, 1, BM.BRONZE);
      F.rect(c - 9, 0, c + 9, 13, 0, BM.BRONZE);                                           // doors
      for (const u of [c - 8, c - 5, c - 2, c + 1, c + 4, c + 7]) F.rect(u, 2, u + 1, 11, 0, BM.GLASS_DARK_LIT);
      F.rect(c - 16, 13, c + 16, 14, 6, BM.BRONZE);                                        // marquee over the doors
      for (let u = c - 16; u < c + 16; ++u) F.rect(u, pH + 7, u + 1, pH + 10, (u - c + 16) % 4 < 2 ? 4 : 3, (u - c + 16) % 4 < 2 ? S.trim : S.stone);  // frieze
    }
    F.rect(0, top, len, top + 1, 3, S.trim);                                                // cornice
    F.rect(0, top + 1, len, top + 4, 4, S.stone);
    for (let u = 0; u < len; u += 2) F.rect(u, top + 2, u + 1, top + 4, 5, S.stone);
    F.rect(0, top + 4, len, top + 5, 5, S.trim);
    F.rect(0, top + 5, len, h, 3, S.stone);
    F.returns();
    return F;
  };
}
// International Style slab: wide bays, I-beam mullions, a clear spandrel band per floor, louvred plant floors
function skinIntl(S, o) {
  return (len, h) => {
    const F = new Relief(len, h, 2, o.spandrel), n = Math.floor(h / FH);
    const nb = Math.max(1, Math.round(len / o.pitch)), P = len / nb;
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      if (o.mech.includes(f)) { F.rect(0, v + 2, len, v + FH - 1, 1, BM.LOUVER); for (let r = v + 3; r < v + FH - 1; r += 3) F.rect(0, r, len, r + 1, 2, BM.METAL); continue; }
      for (let b = 0; b < nb; ++b) F.rect(Math.round(b * P), v + 4, Math.round((b + 1) * P), v + FH, 1, glassMat(S.seed, b * 31 + f * 7, f, 0.3, o.tint));
    }
    for (let b = 1; b < nb; ++b) { const u = Math.round(b * P); F.rect(u, 0, u + 1, n * FH, 3, o.mull); }
    F.rect(0, 0, 2, h, 3, o.mull); F.rect(len - 2, 0, len, h, 3, o.mull);
    if (h > n * FH) F.rect(0, n * FH, len, h, 3, o.mull);
    F.returns();
    return F;
  };
}
// glass lobby behind the columns: tall panes, revolving doors on the front
function skinLobby(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 0, S.mull);
    for (let u = 0; u < len; u += 6) F.rect(u + 1, 1, Math.min(len, u + 6), h - 2, 1, glassMat(S.seed, u, 77, 0.8, 'dark'));
    if (info.front) {
      const c = len >> 1;
      for (const o of [-10, -3, 4]) { F.rect(c + o, 1, c + o + 6, 11, 0, BM.STEEL_DARK); F.rect(c + o + 1, 2, c + o + 5, 10, 0, BM.GLASS_DARK_LIT); }
    }
    return F;
  };
}
// postmodern shaft: polished stone, proper paired windows with dark sills, banding, recessed glass slot up the middle
function skinPomo2(S, slotOn, arches) {
  return (len, h, info) => {
    const F = new Relief(len, h, 2, S.stone), n = Math.floor(h / FH), mid = len >> 1, slot = slotOn && len > 44;
    const cs = bays(len, 14, 4);
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      cs.forEach((c, k) => {
        if (slot && Math.abs(c - mid) < 10) return;
        if (arches && f >= n - 2) {                                                          // arched loggia storey on top
          if (f === n - 2) { reliefArch(F, c - 5, c + 5, v + 3, v + FH + 3, 0, glassMat(S.seed, k, 99, 0.6, S.tint), S.dark, 3); F.rect(c - 6, v + 2, c + 6, v + 3, 3, S.dark); }
          return;
        }
        F.rect(c - 5, v + 4, c - 1, v + 12, 1, glassMat(S.seed, k * 2 + f * 17, f, 0.3, S.tint));
        F.rect(c + 1, v + 4, c + 5, v + 12, 1, glassMat(S.seed, k * 2 + 1 + f * 17, f, 0.3, S.tint));
        F.rect(c - 6, v + 3, c + 6, v + 4, 3, S.dark);                                    // sill
        if (f % 4 === 3) F.rect(c - 1, v + 12, c + 1, v + 14, 3, S.dark);                  // keystone
      });
      if (f % 4 === 0) F.rect(0, v, len, v + 2, 3, S.dark);                                // banding
    }
    if (slot) {
      F.rect(mid - 7, 0, mid + 7, n * FH, 3, S.dark);                                       // slot frame
      F.rect(mid - 5, 0, mid + 5, n * FH, 0, BM.GLASS_GREEN);
      for (let f = 0; f < n; ++f) {
        F.rect(mid - 5, f * FH + 2, mid + 5, f * FH + FH - 1, 0, glassMat(S.seed, 9, f, 0.45, S.tint));
        F.rect(mid - 5, f * FH, mid + 5, f * FH + 1, 1, S.dark);
      }
    }
    F.rect(0, 0, 2, h, 3, S.dark); F.rect(len - 2, 0, len, h, 3, S.dark);                 // quoins
    if (h > n * FH) F.rect(0, n * FH, len, h, 4, S.dark);
    F.returns();
    return F;
  };
}
// postmodern base: round-arched arcade on dark granite piers, a grand entrance arch, cornice band
function skinPomoBase(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 3, S.stone), aH = 2 * FH + 6;
    F.rect(0, 0, len, aH, 2, S.dark);
    const cs = bays(len, 16, 4), c0 = len >> 1, mid = cs.length >> 1, grand = info.front && cs.length >= 3;
    cs.forEach((c, k) => {
      if (grand && Math.abs(k - mid) === 1 && cs.length >= 5) { F.rect(c - 4, 6, c + 4, aH - 12, 1, S.stone); return; }
      if (grand && k === mid) {
        reliefArch(F, c - 10, c + 10, 0, aH - 10, 0, BM.GLASS_GREEN_LIT, S.stone, 4);
        F.rect(c - 10, 12, c + 10, 13, 1, S.dark);
        for (let u = c - 8; u < c + 9; u += 4) F.rect(u, 13, u + 1, aH - 4, 1, S.dark);
        return;
      }
      reliefArch(F, c - 6, c + 6, 0, aH - 10, 0, glassMat(S.seed, k, 4, 0.5, S.tint), S.stone, 3);
      F.rect(c - 6, 14, c + 6, 15, 1, S.dark);
    });
    F.rect(0, aH, len, aH + 2, 4, S.stone);
    const cw = bays(len, 14, 4);
    cw.forEach((c, k) => {
      const v = aH + 4;
      F.rect(c - 5, v, c - 1, v + 8, 1, glassMat(S.seed, k, 31, 0.3, S.tint)); F.rect(c + 1, v, c + 5, v + 8, 1, glassMat(S.seed, k, 32, 0.3, S.tint));
      F.rect(c - 6, v - 1, c + 6, v, 3, S.dark);
    });
    F.rect(0, h - 4, len, h - 2, 4, S.dark); F.rect(0, h - 2, len, h, 5, S.stone);
    F.returns();
    return F;
  };
}
// brutalist slab: expressed cross walls, recessed loggias behind proud balustrades, corridor floor every third storey
function skinBrutal(S) {
  return (len, h) => {
    const F = new Relief(len, h, 4, S.conc), n = Math.floor(h / FH);
    const nb = Math.max(1, Math.round(len / 13)), P = len / nb;
    for (let f = 0; f < n; ++f) {
      const v = f * FH, corr = f % 3 === 1;
      for (let b = 0; b < nb; ++b) {
        const u0 = Math.round(b * P) + 1, u1 = Math.round((b + 1) * P) - 1;
        if (corr) {
          for (let u = u0 + 2; u + 3 <= u1 - 1; u += 5) F.rect(u, v + 5, u + 3, v + 9, 1, glassMat(S.seed, u, f, 0.5, 'dark'));
          F.rect(u0, v, u1, v + 1, 3, S.conc);
        } else {
          F.rect(u0, v + 5, u1, v + FH, 0, glassMat(S.seed, b * 5 + f * 3, f, 0.3, 'dark'));
          for (let u = u0 + 3; u < u1 - 1; u += 4) F.rect(u, v + 5, u + 1, v + FH, 1, BM.STEEL_DARK);
          F.rect(u0, v, u1, v + 5, 4, (b * 7 + f * 3) % 5 === 0 ? S.panel : S.conc);        // balustrade
        }
      }
    }
    for (let b = 0; b <= nb; ++b) { const u = Math.round(b * P); F.rect(u - 1, 0, u + 1, n * FH, 6, S.rib); }
    if (h > n * FH) F.rect(0, n * FH, len, h, 6, S.rib);
    F.returns();
    return F;
  };
}
// board-marked concrete core: vertical ribs, a stair slot of staggered windows on the long faces
function skinCore(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 2, S.rib);
    for (let u = 2; u < len - 2; u += 4) F.rect(u, 0, u + 1, h, 1, S.rib);
    const c = len >> 1;
    if (!info.side || S.slotSides) for (let v = 6; v + 6 < h; v += 7) {
      F.rect(c - 2, v, c + 2, v + 4, 0, glassMat(S.seed, v, 3, 0.6, 'dark'));
    }
    F.rect(0, 0, 2, h, 3, S.rib); F.rect(len - 2, 0, len, h, 3, S.rib);
    F.returns();
    return F;
  };
}
// the boiler house: cantilevered concrete head with slot windows
function skinBoiler(S) {
  return (len, h) => {
    const F = new Relief(len, h, 2, S.conc);
    for (let u = 3; u + 2 < len - 2; u += 5) F.rect(u, 6, u + 2, h - 6, 0, glassMat(S.seed, u, 9, 0.5, 'dark'));
    F.rect(0, 0, len, 3, 3, S.rib); F.rect(0, h - 3, len, h, 3, S.rib);
    F.returns();
    return F;
  };
}
// twist podium, two parts: a glazed ground storey behind slender columns under a deep fascia, and set back above
// it the podium proper, ribbon windows behind a screen of fins (or plain bands); planted terrace in front
function skinTwistGround(S) {
  return (len, h, info) => {
    const F = new Relief(len, h, 3, S.clad), gH = h - 5;
    F.rect(0, 0, len, gH, 0, BM.STEEL_DARK);
    for (let u = 0; u < len; u += 5) F.rect(u + 1, 1, Math.min(len, u + 5), gH - 1, 0, glassMat(S.seed, u, 1, 0.55, 'dark'));
    for (let u = 0; u < len; u += 5) F.rect(u, gH - 7, u + 5, gH - 6, 0, BM.STEEL_DARK);
    const cs = bays(len, 16, 4), c0 = len >> 1;
    cs.forEach((c) => F.rect(c - 1, 0, c + 1, gH, 3, S.col));
    if (info.front) {
      F.rect(c0 - 10, 0, c0 + 10, gH, 0, BM.STEEL_DARK);                                     // lobby doors
      for (let u = c0 - 9; u < c0 + 9; u += 4) F.rect(u, 1, u + 3, 11, 0, BM.GLASS_DARK_LIT);
      F.rect(c0 - 9, 12, c0 + 9, gH - 1, 0, BM.GLASS_DARK_LIT);
      F.rect(c0 - 12, gH - 4, c0 + 12, gH - 3, 7, S.canopy);                                 // entrance canopy
    }
    F.rect(0, gH, len, h, 4, S.clad);
    F.rect(0, gH + 1, len, gH + 2, 3, S.col);
    F.returns();
    return F;
  };
}
function skinTwistUpper(S) {
  return (len, h) => {
    const F = new Relief(len, h, 3, S.clad), n = Math.floor((h - 4) / FH);
    for (let f = 0; f < n; ++f) {
      const v = f * FH;
      F.rect(0, v + 3, len, v + FH, 1, BM.STEEL_DARK);
      for (let u = 0; u < len; u += 4) F.rect(u, v + 3, Math.min(len, u + 3), v + FH, 1, glassMat(S.seed, u, f + 3, 0.35, S.tint));
      if (S.screen) for (let u = 1; u < len; u += 3) F.rect(u, v + 3, u + 1, v + FH, 4, S.col);
    }
    F.rect(0, h - 4, len, h, 4, S.clad);
    F.returns();
    return F;
  };
}

// ---- the eight archetypes. Each returns nothing; spec.party carries attached neighbours for the base.
// Art Deco: rusticated granite base with a three-storey portal, setbacks with planted terraces, a stepped crown
// with slit windows and corner pinnacles ending in a needle.
function decoCrown2(s, S, R) {
  const H = 240, M = new C_VoxModel(s + 4, H, s + 4, (s >> 1) + 2, (s >> 1) + 2);
  let r = Math.round(s * 0.42), y = 0, k = 0;
  const steps = 3 + (R() < 0.5 ? 1 : 0), pin = S.pinnacles, hs = [28, 22, 18, 14];
  while (k < steps && r > 5) {
    const th = hs[k], c = Math.max(2, Math.round(r * 0.34)), c2 = c >> 1, m = S.crown;
    M.box(-r + c, y, -r, r - c, y + th, r, m);                                              // stepped octagon
    M.box(-r, y, -r + c, r, y + th, r - c, m);
    if (c2 > 0) M.box(-r + c2, y, -r + c2, r - c2, y + th, r - c2, m);
    M.box(-r + c, y + th - 2, -r, r - c, y + th, r, S.crownAlt);                           // band at the top
    M.box(-r, y + th - 2, -r + c, r, y + th, r - c, S.crownAlt);
    if (c2 > 0) M.box(-r + c2, y + th - 2, -r + c2, r - c2, y + th, r - c2, S.crownAlt);
    for (let u = -r + c + 1; u + 1 < r - c; u += 3) {                                       // slit windows, often lit
      const g = H2(S.seed, u, k) < 0.6 ? BM.GLASS_LIT : BM.GLASS_DARK, v0 = y + 3, v1 = y + th - 4;
      M.box(u, v0, -r, u + 1, v1, -r + 1, -1); M.box(u, v0, -r + 1, u + 1, v1, -r + 2, g);
      M.box(u, v0, r - 1, u + 1, v1, r, -1); M.box(u, v0, r - 2, u + 1, v1, r - 1, g);
      M.box(-r, v0, u, -r + 1, v1, u + 1, -1); M.box(-r + 1, v0, u, -r + 2, v1, u + 1, g);
      M.box(r - 1, v0, u, r, v1, u + 1, -1); M.box(r - 2, v0, u, r - 1, v1, u + 1, g);
    }
    if (pin) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {                         // pinnacles on the chamfers
      const px = sx > 0 ? r - c : -r + c - 2, pz = sz > 0 ? r - c : -r + c - 2;
      M.box(px, y, pz, px + 2, y + th + 6, pz + 2, S.crownAlt);
      M.box(px, y + th + 6, pz, px + 1, y + th + 10, pz + 1, S.crownAlt);
    }
    y += th; r -= Math.max(3, Math.round(r * 0.25)); ++k;
  }
  M.box(-3, y, -3, 3, y + 6, 3, S.crownAlt);                                                // tapering spire
  M.box(-2, y + 6, -2, 2, y + 22, 2, S.crownAlt);
  M.box(-1, y + 22, -1, 1, y + 52, 1, BM.METAL); M.box(-1, y + 52, -1, 1, y + 53, 1, BM.BEACON);
  return M;
}
function towerDeco(E, C, W, D, spec, R) {
  const pal = pick(R, [[BM.LIMESTONE, BM.LIMESTONE_DARK], [BM.PRECAST, BM.LIMESTONE_DARK], [BM.LIMESTONE, BM.BRONZE], [BM.LIMESTONE_DARK, BM.GRANITE_DARK]]);
  const S = { seed: spec.seed, stone: pal[0], trim: pal[1], granite: BM.GRANITE_DARK, pinnacles: R() < 0.7 };
  const cr = R();
  S.crown = cr < 0.35 ? BM.COPPER : pal[0]; S.crownAlt = cr < 0.35 ? BM.BRONZE : cr < 0.7 ? pal[1] : BM.BRONZE;
  const n = Math.max(20, spec.floors), b = 5, n1 = Math.round(n * 0.32), n2 = Math.round(n * 0.25), n3 = Math.max(6, n - b - n1 - n2);
  const t1 = inset(W, D, Math.round(W * 0.1), Math.round(D * 0.12), Math.round(W * 0.1), Math.round(D * 0.06));
  const t2 = inset(W, D, Math.round(W * 0.2), Math.round(D * 0.24), Math.round(W * 0.2), Math.round(D * 0.16));
  let s = Math.min(t2.x1 - t2.x0, t2.z1 - t2.z0) - 16; s -= s & 1;
  const cx = (t2.x0 + t2.x1) >> 1, cz = (t2.z0 + t2.z1) >> 1;
  const t3 = { x0: cx - (s >> 1), z0: cz - (s >> 1), x1: cx + (s >> 1), z1: cz + (s >> 1) };
  const bh = 24 + 3 * FH + 9;
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: bh, skin: skinDecoBase2(S), party: spec.party, roof: { mat: S.stone, deck: BM.CONCRETE } }),
    Object.assign({}, t1, { h: n1 * FH + 2, skin: skinDeco(S, false), roof: { mat: S.trim, deck: BM.CONCRETE } }),
    Object.assign({}, t2, { notch: 6, h: n2 * FH + 2, skin: skinDeco(S, false), roof: { mat: S.trim, deck: BM.CONCRETE } }),
    Object.assign({}, t3, { h: n3 * FH + 6, skin: skinDeco(S, true), roof: { mat: S.trim, units: 0 } })
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  terraceGardens(E, C, inset(W, D, 0, 0, 0, 0), t1, tiers[1].y, R, { rim: S.trim, trees: true, tree: 18 });
  terraceGardens(E, C, t1, t2, tiers[2].y, R, { rim: S.trim, max: 5 });
  terraceGardens(E, C, t2, t3, tiers[3].y, R, { rim: S.trim, max: 4, back: true, notch: 6 });
  E.vox(C, decoCrown2(s, S, R), cx, y, cz);
}
// Reuse: a 1900s building kept whole, cornice intact; the glass tower stands back from its front on a two-storey
// open steel frame with a glazed sky lobby, and its roof becomes a planted terrace.
function skinSkyLobby(S) {
  return (len, h) => {
    const F = new Relief(len, h, 0, BM.STEEL_DARK);
    for (let u = 0; u < len; u += 6) F.rect(u + 1, 1, Math.min(len, u + 6), h - 1, 1, glassMat(S.seed, u, 55, 0.7, 'dark'));
    for (let v = FH; v < h - 2; v += FH) F.rect(0, v, len, v + 1, 2, BM.STEEL_DARK);
    return F;
  };
}
function towerReuse(E, C, W, D, spec, R) {
  const brick = R() < 0.5;
  const SH = { seed: spec.seed, wall: brick ? pick(R, [BM.BRICK_RED, BM.BRICK_BROWN]) : pick(R, [BM.LIMESTONE, BM.BUFF]), base: BM.LIMESTONE_DARK,
    awning: pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]), shops: true, bayW: pick(R, [9, 10, 11]), lintels: true, trim: BM.TRIM };
  const bf = 5 + Math.floor(R() * 2), bh = bf * 14 + 5;
  const zf = Math.max(22, Math.round(D * (0.26 + R() * 0.1)));
  const tw = { x0: Math.round(W * 0.1), z0: zf, x1: W - Math.round(W * 0.1), z1: D - Math.max(8, Math.round(D * 0.06)) };
  if (tw.z1 - tw.z0 < 40) tw.z0 = Math.max(12, tw.z1 - 40);
  const gap = 2 * FH, rv = { x0: tw.x0 + 10, z0: tw.z0 + 10, x1: tw.x1 - 10, z1: tw.z1 - 8 };
  const n = Math.max(14, spec.floors - bf - 2);
  const S = { seed: spec.seed + 3 };
  const mech = [Math.round(n * 0.5)];
  const tint = pick(R, ['curtain', 'green', 'dark', 'blue']), mull = pick(R, [BM.MULLION, BM.STEEL_DARK, BM.METAL]);
  const glassSkin = skinCurtain(S, { fin: R() < 0.5, mech, tint, pitch: 5, mullion: mull, cap: mull, slabs: R() < 0.5, slabMat: mull });
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: bh, skin: (len) => facadeMid(len, bf, 14, SH, false), party: spec.party, roof: { mat: SH.wall, deck: BM.WOOD } }),
    Object.assign({}, rv, { h: gap, skin: skinSkyLobby(S), noRoof: true }),
    Object.assign({}, tw, { h: n * FH + 2, skin: glassSkin, floating: true, soffit: BM.TRIM, roof: { mat: mull, parapet: 0, units: 0 } })
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  // the steel frame: columns on the tower's edges through the open storeys, aligned with the old building's bays
  const cm = columnModel(2, 2, gap, BM.STEEL_DARK, 0);
  const nx = Math.max(2, Math.round((tw.x1 - tw.x0) / 24)), nz = Math.max(2, Math.round((tw.z1 - tw.z0) / 24));
  for (let i = 0; i <= nx; ++i) { const x = Math.round(tw.x0 + 1 + i * (tw.x1 - tw.x0 - 4) / nx); E.vox(C, cm, x, bh, tw.z0 + 1); E.vox(C, cm, x, bh, tw.z1 - 3); }
  for (let i = 1; i < nz; ++i) { const z = Math.round(tw.z0 + 1 + i * (tw.z1 - tw.z0 - 4) / nz); E.vox(C, cm, tw.x0 + 1, bh, z); E.vox(C, cm, tw.x1 - 3, bh, z); }
  // roof terrace on the old building, in front of the tower
  const fz = tw.z0 - 8;
  if (fz >= 8) {
    const gw = W - 8, k = Math.max(1, Math.round(gw / 40));
    for (let i = 0; i < k; ++i) {
      const x0 = 4 + Math.round(i * gw / k) + 2, x1 = 4 + Math.round((i + 1) * gw / k) - 2;
      E.vox(C, gardenModel(x1 - x0, Math.min(8, fz - 2), R, { rim: BM.LIMESTONE_DARK, tree: 14 }), x0, bh, 4);
    }
  }
  // crown: the curtain wall runs on past the roof as a glass screen, rising towards the back (or level), hiding the plant
  const sw = tw.x1 - tw.x0, sdp = tw.z1 - tw.z0, h0 = FH + 4, rise = R() < 0.65 ? 2 * FH : 0;
  const M = new C_VoxModel(sw + 2, h0 + rise + 4, sdp + 2, 1, 1);
  const sh = (z) => h0 + Math.round(rise * z / sdp);
  for (let z = 0; z < sdp; ++z) for (const x of [0, sw - 1]) M.box(x, 0, z, x + 1, sh(z), z + 1, BM.CURTAIN);
  for (let x = 1; x < sw - 1; ++x) { M.box(x, 0, 0, x + 1, sh(0), 1, BM.CURTAIN); M.box(x, 0, sdp - 1, x + 1, sh(sdp - 1), sdp, BM.CURTAIN); }
  for (let x = 0; x < sw; x += 5) { M.box(x, 0, -1, x + 1, sh(0) + 1, 0, mull); M.box(x, 0, sdp, x + 1, sh(sdp - 1) + 1, sdp + 1, mull); }
  for (let z = 0; z < sdp; z += 5) { M.box(-1, 0, z, 0, sh(z) + 1, z + 1, mull); M.box(sw, 0, z, sw + 1, sh(z) + 1, z + 1, mull); }
  M.box(-1, 0, -1, 0, sh(0) + 1, 0, mull); M.box(sw, 0, -1, sw + 1, sh(0) + 1, 0, mull);
  M.box(-1, 0, sdp, 0, sh(sdp - 1) + 1, sdp + 1, mull); M.box(sw, 0, sdp, sw + 1, sh(sdp - 1) + 1, sdp + 1, mull);
  M.box(8, 0, 8, sw - 8, 10, sdp - 8, BM.LOUVER);                                           // plant room behind the screen
  for (let x = 8; x < sw - 8; x += 4) M.box(x, 0, 7, x + 1, 11, 8, BM.METAL);
  E.vox(C, M, tw.x0, y, tw.z0);
  E.vox(C, craneModel(Math.min(40, sw - 24)), tw.x0 + 12, y + 10, (tw.z0 + tw.z1) >> 1);
}
// International Style: a bronze / black steel / green glass slab set back behind its own plaza with fountains,
// raised on columns over a recessed glass lobby; louvred plant floors and penthouse.
function intlPlazaModel(W, zEnd, zf, R) {
  const M = new C_VoxModel(W, 44, zEnd, 0, 0), cx = W >> 1;
  M.box(0, 0, 0, W, 1, 3, BM.GRANITE_DARK);                                                 // steps up from the street
  M.box(0, 0, 3, W, 2, zEnd, BM.GRANITE_DARK);
  for (let x = 3; x < W - 3; x += 10) for (let z = 6; z < zEnd - 2; z += 10) M.box(x, 1, z, Math.min(W - 3, x + 9), 2, Math.min(zEnd - 2, z + 9), BM.LIMESTONE);  // travertine paving
  const pw = Math.min(30, (W >> 1) - 16), pz0 = 8, pz1 = zf - 8;
  if (pw >= 10 && pz1 - pz0 >= 8) for (const x0 of [cx - 6 - pw, cx + 6]) {                // two fountain pools
    M.box(x0, 2, pz0, x0 + pw, 4, pz1, BM.GRANITE_DARK);
    M.box(x0 + 1, 3, pz0 + 1, x0 + pw - 1, 4, pz1 - 1, -1);
    M.box(x0 + 1, 2, pz0 + 1, x0 + pw - 1, 3, pz1 - 1, BM.WATER);
    for (let x = x0 + 3; x < x0 + pw - 2; x += 4) M.box(x, 3, (pz0 + pz1) >> 1, x + 1, 7 + ((x >> 2) & 1) * 2, ((pz0 + pz1) >> 1) + 1, BM.WATER);
    M.box(x0, 2, pz1 + 2, x0 + pw, 4, pz1 + 4, BM.LIMESTONE);                               // granite bench ledge
  }
  for (const x of [5, W - 6]) for (let z = 10; z < zf - 6; z += 16) { M.box(x - 3, 2, z - 3, x + 3, 4, z + 3, BM.GRANITE_DARK); addTree(M, x, 4, z, R, 1.1); }
  return M;
}
function towerInternational(E, C, W, D, spec, R) {
  const kind = pick(R, ['bronze', 'black', 'green']);
  const o = kind === 'bronze' ? { mull: BM.BRONZE, spandrel: BM.TRIM_DARK, tint: 'dark', col: BM.BRONZE }
    : kind === 'black' ? { mull: BM.STEEL_DARK, spandrel: BM.STEEL_DARK, tint: 'dark', col: BM.STEEL_DARK }
    : { mull: BM.METAL, spandrel: BM.SPANDREL, tint: 'green', col: BM.METAL };
  const S = { seed: spec.seed, mull: o.mull };
  const zf = Math.max(28, Math.round(D * 0.36)), slabD = Math.min(D - zf - 4, Math.max(40, Math.round(D * 0.5)));
  const t0 = { x0: Math.round(W * 0.12), z0: zf, x1: W - Math.round(W * 0.12), z1: zf + slabD };
  if (t0.x1 - t0.x0 < 40 || slabD < 36) return towerReuse(E, C, W, D, spec, R);
  const n = Math.max(18, spec.floors), lH = 26, mech = [Math.round(n * 0.55)];
  o.pitch = 10; o.mech = mech;
  const lob = { x0: t0.x0 + 10, z0: t0.z0 + 12, x1: t0.x1 - 10, z1: t0.z1 - 10 };
  const tiers = [
    Object.assign({}, lob, { h: lH, skin: skinLobby(S), noRoof: true }),
    Object.assign({}, t0, { h: n * FH + 2, skin: skinIntl(S, o), floating: true, soffit: kind === 'green' ? BM.WHITE_CONCRETE : BM.LIMESTONE, roof: { mat: o.mull, units: 0 } }),
    { x0: t0.x0 + 8, z0: t0.z0 + 8, x1: t0.x1 - 8, z1: t0.z1 - 8, h: 2 * FH, skin: skinLouver({ frame: o.mull }), roof: { mat: o.mull, units: 3 } }
  ];
  buildTiers(E, C, W, D, tiers, spec.seed);
  // columns on the slab's grid: every third bay, set 1 voxel behind the facade
  const cm = columnModel(3, 3, lH, o.col, 0);
  const lenX = t0.x1 - t0.x0, nbX = Math.max(1, Math.round(lenX / 10)), cX = Math.max(2, Math.round(nbX / 3));
  for (let i = 0; i <= cX; ++i) {
    const x = Math.round(t0.x0 + 1 + i * (lenX - 5) / cX);
    E.vox(C, cm, x, 0, t0.z0 + 1); E.vox(C, cm, x, 0, t0.z1 - 4);
  }
  const lenZ = t0.z1 - t0.z0, cZ = Math.max(2, Math.round(lenZ / 30));
  for (let i = 1; i < cZ; ++i) { const z = Math.round(t0.z0 + 1 + i * (lenZ - 5) / cZ); E.vox(C, cm, t0.x0 + 1, 0, z); E.vox(C, cm, t0.x1 - 4, 0, z); }
  E.vox(C, intlPlazaModel(W, t0.z1 + 2 <= D ? t0.z1 + 2 : D, zf, R), 0, 0, 0);
}
// Pencil: a slender stone-finned residential shaft on a limestone podium; the top feathers back in shallow steps
// (from the sides, or from the back) to a thin blade with a bronze pinnacle.
function towerPencil(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, stone: pick(R, [BM.LIMESTONE, BM.BUFF, BM.PRECAST]), alt: pick(R, [BM.TERRACOTTA, BM.LIMESTONE_DARK, BM.BRONZE]), stoneDark: BM.GRANITE_DARK, canopy: BM.BRONZE };
  const sw0 = Math.min(W - 16, 76), sd = Math.min(D - 30, 84);
  if (sw0 < 32 || sd < 32) return towerDeco(E, C, W, D, spec, R);
  const sw = sw0 - (sw0 & 1);
  const x0 = (W - sw) >> 1, z0 = Math.max(14, Math.round((D - sd) * 0.4));
  const n = Math.max(32, spec.floors + 14), pH = 18 + 4 * FH + 3;
  const mode = pick(R, ['sides', 'back', 'both']), fins = skinFins(S);
  const tiers = [Object.assign(inset(W, D, 0, 0, 0, 0), { h: pH, skin: skinPodium(S), party: spec.party, roof: { mat: S.stone, deck: BM.CONCRETE } })];
  const sx = mode === 'back' ? 0 : 4, sz = mode === 'sides' ? 0 : mode === 'back' ? 6 : 4;
  let steps = 0;
  while (sw - 2 * sx * (steps + 1) >= 24 && sd - sz * (steps + 1) >= 26 && steps < 9) ++steps;
  const per = 2, shaft = n - steps * per;
  tiers.push({ x0, z0, x1: x0 + sw, z1: z0 + sd, notch: 4, h: shaft * FH, skin: fins, roof: { mat: S.stone } });
  for (let i = 1; i <= steps; ++i) {
    const last = i === steps;
    tiers.push({ x0: x0 + sx * i, z0, x1: x0 + sw - sx * i, z1: z0 + sd - sz * i, notch: 4, h: per * FH + (last ? 3 : 0), skin: fins, roof: { mat: S.stone, units: 0 } });
  }
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  terraceGardens(E, C, inset(W, D, 0, 0, 0, 0), { x0, z0, x1: x0 + sw, z1: z0 + sd }, pH, R, { rim: S.stone, trees: true, tree: 18, back: true });
  const lt = tiers[tiers.length - 1], lw = lt.x1 - lt.x0, ld = lt.z1 - lt.z0;
  const M = new C_VoxModel(lw + 2, 90, ld + 2, 1, 1), cxm = lw >> 1, czm = ld >> 1;
  // bronze crown: a ring of fins rising from the parapet, then a stepped pinnacle
  for (let u = 5; u < lw - 5; u += 3) { const hh = 10 + Math.round(8 * Math.sin(Math.PI * u / lw)); M.box(u, 0, 1, u + 1, hh, 2, S.alt); M.box(u, 0, ld - 2, u + 1, hh, ld - 1, S.alt); }
  for (let v = 5; v < ld - 5; v += 3) { const hh = 10 + Math.round(8 * Math.sin(Math.PI * v / ld)); M.box(1, 0, v, 2, hh, v + 1, S.alt); M.box(lw - 2, 0, v, lw - 1, hh, v + 1, S.alt); }
  M.box(cxm - 5, 0, czm - 5, cxm + 5, 14, czm + 5, S.stone);
  M.box(cxm - 3, 14, czm - 3, cxm + 3, 26, czm + 3, BM.BRONZE);
  M.box(cxm - 2, 26, czm - 2, cxm + 2, 40, czm + 2, BM.BRONZE);
  M.box(cxm - 1, 40, czm - 1, cxm + 1, 70, czm + 1, BM.BRONZE);
  M.box(cxm - 1, 70, czm - 1, cxm + 1, 71, czm + 1, BM.BEACON);
  E.vox(C, M, lt.x0, y, lt.z0);
}
// Postmodern: pink granite on a round-arched arcade with a grand entrance arch; paired windows, a glass slot,
// banding; capped by a stepped pyramid with a lantern, or a broken pediment with an oculus.
function towerPomo(E, C, W, D, spec, R) {
  const pal = pick(R, [[BM.GRANITE_PINK, BM.GRANITE_DARK, 'green'], [BM.BUFF, BM.TERRACOTTA, 'dark'], [BM.LIMESTONE, BM.GRANITE_PINK, 'blue'], [BM.GRANITE_PINK, BM.TERRACOTTA, 'green']]);
  const S = { seed: spec.seed, stone: pal[0], dark: pal[1], tint: pal[2] };
  const n = Math.max(18, spec.floors);
  const t1 = inset(W, D, 10, 12, 10, 8), n1 = Math.round(n * 0.7);
  const t2 = { x0: t1.x0 + 10, z0: t1.z0 + 10, x1: t1.x1 - 10, z1: t1.z1 - 10 };
  const slot = R() < 0.6;
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: 2 * FH + 6 + FH + 6, skin: skinPomoBase(S), party: spec.party, roof: { mat: S.dark } }),
    Object.assign(t1, { notch: 6, h: n1 * FH + 2, skin: skinPomo2(S, slot), roof: { mat: S.dark } }),
    Object.assign(t2, { notch: 4, h: (n - n1) * FH + 2, skin: skinPomo2(S, slot, true), roof: { mat: S.dark, units: 0 } })
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  const w = t2.x1 - t2.x0 - 8, d = t2.z1 - t2.z0 - 8;
  if (R() < 0.5) {
    const M = pyramidModel(w, d, S);
    // a lantern with an oculus on each face on top of the stepped pyramid
    let a = 0, yy = 0; while (w - 2 * a > 4 && d - 2 * a > 4) { yy += 3; a += 2; }
    M.box((w >> 1) - 3, yy, (d >> 1) - 3, (w >> 1) + 3, yy + 8, (d >> 1) + 3, S.stone);
    M.box((w >> 1) - 1, yy + 3, (d >> 1) - 3, (w >> 1) + 1, yy + 6, (d >> 1) + 3, BM.GLASS_LIT);
    M.box((w >> 1) - 3, yy + 3, (d >> 1) - 1, (w >> 1) + 3, yy + 6, (d >> 1) + 1, BM.GLASS_LIT);
    M.box((w >> 1) - 4, yy + 8, (d >> 1) - 4, (w >> 1) + 4, yy + 10, (d >> 1) + 4, S.dark);
    E.vox(C, M, t2.x0 + 4, y, t2.z0 + 4);
  } else {
    const M = pedimentModel(w, Math.max(6, d), S);
    E.vox(C, M, t2.x0 + 4, y, t2.z0 + 4);
  }
}
// Brutalist: a slab of loggias and cross walls on splayed piers, served by a separate board-marked concrete core
// linked by bridges every third floor; the core carries a cantilevered boiler house above the slab roof.
function towerBrutal(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, conc: BM.PRECAST, rib: BM.CONCRETE, panel: pick(R, [BM.WHITE_CONCRETE, BM.PRECAST, BM.TERRACOTTA]) };
  const n = Math.max(18, Math.min(32, spec.floors)), lH = 20;
  const sideCore = W >= 76 || D < 100, cs = W < 96 ? 16 : 20, g = W < 96 ? 7 : 10;
  let slab, core, dir;
  if (sideCore) {
    const left = R() < 0.5, sw = W - 8 - cs - g, sd = Math.min(52, D - 30), z0 = Math.max(16, Math.round((D - sd) * 0.45));
    slab = left ? { x0: 4 + cs + g, z0, x1: 4 + cs + g + sw, z1: z0 + sd } : { x0: 4, z0, x1: 4 + sw, z1: z0 + sd };
    const cz = (slab.z0 + slab.z1) >> 1;
    core = left ? { x0: 4, z0: cz - (cs >> 1), x1: 4 + cs, z1: cz + (cs >> 1) } : { x0: W - 4 - cs, z0: cz - (cs >> 1), x1: W - 4, z1: cz + (cs >> 1) };
    dir = 'x';
  } else {
    const sd = 44, z0 = Math.max(16, D - 8 - cs - g - sd);
    slab = { x0: 4, z0, x1: W - 4, z1: z0 + sd };
    const cx = W >> 1;
    core = { x0: cx - (cs >> 1), z0: slab.z1 + g, x1: cx + (cs >> 1), z1: slab.z1 + g + cs };
    dir = 'z';
  }
  const lob = { x0: slab.x0 + 5, z0: slab.z0 + 8, x1: slab.x1 - 5, z1: slab.z1 - 8 };
  const hS = n * FH + 4, hC = lH + hS + 2 * FH + 6, bH = 2 * FH + 6;
  buildTiers(E, C, W, D, [
    Object.assign({}, lob, { h: lH, skin: skinLobby({ seed: spec.seed, mull: BM.STEEL_DARK }), noRoof: true }),
    Object.assign({}, slab, { h: hS, skin: skinBrutal(S), floating: true, soffit: BM.CONCRETE, roof: { mat: S.conc } }),
    { x0: slab.x0 - 3, z0: slab.z0 - 4, x1: slab.x1 + 3, z1: slab.z1 + 4, h: FH + 6, skin: skinBoiler(S), floating: true, soffit: BM.CONCRETE, roof: { mat: S.rib, units: 4 } }
  ], spec.seed);
  const over = 7;
  const boiler = { x0: Math.max(1, core.x0 - over), z0: core.z0 - over, x1: Math.min(W - 1, core.x1 + over), z1: Math.min(D - 1, core.z1 + over) };
  const yB = buildTiers(E, C, W, D, [
    Object.assign({}, core, { h: hC, skin: skinCore(S), noRoof: true }),
    Object.assign({}, boiler, { h: bH, skin: skinBoiler(S), floating: true, soffit: BM.CONCRETE, roof: { mat: S.rib, units: 2 } })
  ], spec.seed + 5);
  // splayed piers under the slab's cross walls, front and back
  const pier = new C_VoxModel(5, lH, 12, 2, 0);
  pier.box(-1, 0, 0, 2, lH, 6, S.rib); pier.box(-1, lH - 6, 0, 2, lH, 9, S.rib); pier.box(-2, lH - 3, 0, 3, lH, 11, S.rib);
  const pierB = new C_VoxModel(5, lH, 12, 2, 11);
  pierB.box(-1, 0, -6, 2, lH, 0, S.rib); pierB.box(-1, lH - 6, -9, 2, lH, 0, S.rib); pierB.box(-2, lH - 3, -11, 3, lH, 0, S.rib);
  const len = slab.x1 - slab.x0, nb = Math.max(1, Math.round(len / 13)), P = len / nb;
  for (let b = 1; b < nb; b += (nb > 6 ? 2 : 1)) { const x = slab.x0 + Math.round(b * P); E.vox(C, pier, x, 0, slab.z0 + 1); E.vox(C, pierB, x, 0, slab.z1 - 1); }
  // bridges from the corridor floors to the core
  const br = new C_VoxModel(dir === 'x' ? g + 2 : 8, FH, dir === 'x' ? 8 : g + 2, 0, 0);
  if (dir === 'x') { br.box(0, 0, 0, g + 2, FH - 3, 8, S.conc); br.box(0, 4, 0, g + 2, 8, 1, BM.GLASS_DARK_LIT); br.box(0, 4, 7, g + 2, 8, 8, BM.GLASS_DARK_LIT); }
  else { br.box(0, 0, 0, 8, FH - 3, g + 2, S.conc); br.box(0, 4, 0, 1, 8, g + 2, BM.GLASS_DARK_LIT); br.box(7, 4, 0, 8, 8, g + 2, BM.GLASS_DARK_LIT); }
  for (let f = 1; f < n; f += 3) {
    const yb = lH + f * FH + 2;
    if (dir === 'x') { const left = core.x0 < slab.x0; E.vox(C, br, left ? core.x1 - 1 : slab.x1 - 1, yb, ((core.z0 + core.z1) >> 1) - 4); }
    else E.vox(C, br, ((core.x0 + core.x1) >> 1) - 4, yb, slab.z1 - 1);
  }
  // brutalist forecourt: concrete planters with trees
  if (slab.z0 >= 16) {
    const k = Math.max(1, Math.round((W - 8) / 36));
    for (let i = 0; i < k; ++i) { const a = 4 + Math.round(i * (W - 8) / k) + 3, b = 4 + Math.round((i + 1) * (W - 8) / k) - 3; E.vox(C, gardenModel(b - a, 8, R, { rim: BM.CONCRETE, tree: 14 }), a, 0, 3); }
  }
  E.vox(C, mastsModel(R), (boiler.x0 + boiler.x1) >> 1, yB, (boiler.z0 + boiler.z1) >> 1);
}
function towerTerraced(E, C, W, D, spec, R) {
  // glass that steps back in planted terraces towards the rear; stepped glass crown
  const S = { seed: spec.seed, stone: pick(R, [BM.LIMESTONE, BM.GRANITE_DARK]), stoneDark: BM.GRANITE_DARK, canopy: BM.MULLION };
  const n = Math.max(18, spec.floors), tint = pick(R, ['green', 'curtain', 'dark']);
  const x0 = 8, x1 = W - 8;
  let z0 = Math.max(10, Math.round(D * 0.12));
  const z1 = D - 6, tiers = [Object.assign(inset(W, D, 0, 0, 0, 0), { h: 18 + 3 * FH + 3, skin: skinPodium(S), party: spec.party, roof: { mat: S.stone, deck: BM.CONCRETE } })];
  let left = n - 4, step = Math.max(6, Math.round((z1 - z0) * 0.12));
  while (left > 0 && z1 - z0 > 24) {
    const k = Math.min(left, 5 + Math.floor(R() * 4));
    tiers.push({ x0, z0, x1, z1, h: k * FH + 1, skin: skinCurtain(S, { slabs: true, slabMat: BM.TRIM, tint, pitch: 6, cap: BM.TRIM }), roof: { mat: BM.MULLION, deck: BM.CONCRETE } });
    left -= k; z0 += step;
  }
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  // planters along every terrace edge
  for (let i = 2; i < tiers.length; ++i) { const t = tiers[i - 1]; E.vox(C, planterRowModel(x1 - x0 - 4), x0 + 2, tiers[i].y, t.z0 + 2); }
  const last = tiers[tiers.length - 1];
  E.vox(C, craneModel(Math.min(40, x1 - x0 - 12)), x0 + 6, y, (last.z0 + last.z1) >> 1);
}
// Twist (one per city): every instance is its own design - square or oblong plate, amount / direction / profile of
// the rotation, an optional taper, slab-edge colour, glass tint, an accent (stacked balconies, corner loggias or deep
// fins) and a crown (a stepped sloping top, a twisting lattice spire, or a glass lantern behind a fin screen). It
// stands on a purpose-built podium with a planted roof.
// slab under floor k (sized to the plate below it, so the step between rotated plates is always covered)
function twistSlabModel(pw, pd, s, o) {
  const M = new C_VoxModel(pw + 2 * s + 12, 8, pd + 2 * s + 12, (pw >> 1) + s + 6, (pd >> 1) + s + 6);
  const hw = pw >> 1, hd = pd >> 1;
  M.box(-hw - s, 0, -hd - s, hw + s, 1, hd + s, o.edge);
  if (o.balc) for (const sz of [-1, 1]) {                                                    // balconies on the long faces
    const bw = Math.min(28, pw - 16) >> 1, z0 = sz < 0 ? -hd - s - 4 : hd + s, z1 = z0 + 4;
    M.box(-bw, 0, z0, bw, 1, z1, o.edge);
    const zr = sz < 0 ? z0 : z1 - 1;
    M.box(-bw, 1, zr, bw, 5, zr + 1, BM.GLASS_DARK);
    M.box(-bw, 1, z0, -bw + 1, 5, z1, BM.GLASS_DARK); M.box(bw - 1, 1, z0, bw, 5, z1, BM.GLASS_DARK);
    M.box(-bw, 5, zr, bw, 6, zr + 1, o.rail);
  }
  if (o.rail && o.railBack !== undefined) {                                                  // terrace rail on a stepped top
    const zb = hd + s - 1, za = -hd - s + o.railBack;
    M.box(-hw - s, 1, zb, hw + s, 5, zb + 1, BM.GLASS_DARK);
    M.box(-hw - s, 1, za, -hw - s + 1, 5, zb, BM.GLASS_DARK); M.box(hw + s - 1, 1, za, hw + s, 5, zb, BM.GLASS_DARK);
    for (let x = -hw - s + 3; x < hw + s - 3; x += 9) M.box(x, 1, zb - 5, x + 4, 4, zb - 1, BM.LEAF_DARK);
  }
  return M;
}
function twistRoofModel(pw, pd, s, o, R) {
  const hw = pw >> 1, hd = pd >> 1, H = o.crown === 'lantern' ? 60 : 12;
  const M = new C_VoxModel(pw + 2 * s + 4, H, pd + 2 * s + 4, hw + s + 2, hd + s + 2);
  M.box(-hw - s, 0, -hd - s, hw + s, 2, hd + s, o.edge);
  M.box(-hw - s + 1, 1, -hd - s + 1, hw + s - 1, 2, hd + s - 1, BM.ROOF_TAR);
  M.box(-hw, 2, -hd, hw, 5, -hd + 1, o.edge); M.box(-hw, 2, hd - 1, hw, 5, hd, o.edge);
  M.box(-hw, 2, -hd + 1, -hw + 1, 5, hd - 1, o.edge); M.box(hw - 1, 2, -hd + 1, hw, 5, hd - 1, o.edge);
  if (o.crown === 'lantern') {
    // a screen of fins continuing the facade rhythm, taller towards the corners, LED-capped
    const fin = (x, z, h) => { M.box(x, 2, z, x + 1, h, z + 1, o.mull); M.box(x, h, z, x + 1, h + 1, z + 1, BM.LED); };
    const ht = (t) => 30 + Math.round(18 * Math.abs(t * 2 - 1));
    for (let x = -hw; x < hw; x += 4) { fin(x, -hd - 2, ht((x + hw) / pw)); fin(x, hd + 1, ht((x + hw) / pw)); }
    for (let z = -hd; z < hd; z += 4) { fin(-hw - 2, z, ht((z + hd) / pd)); fin(hw + 1, z, ht((z + hd) / pd)); }
    M.box(-6, 2, -6, 6, 10, 6, BM.LOUVER);
  } else {
    for (let k = 0; k < 2; ++k) { const x = -hw + 6 + Math.floor(R() * Math.max(1, pw - 20)), z = -hd + 6 + Math.floor(R() * Math.max(1, pd - 18)); M.box(x, 2, z, x + 6, 6, z + 5, BM.METAL); }
  }
  return M;
}
function towerTwist(E, C, W, D, spec, R) {
  const edge = pick(R, [BM.WHITE_CONCRETE, BM.TRIM, BM.STEEL_DARK, BM.BRONZE, BM.METAL]);
  const mull = edge === BM.BRONZE || edge === BM.STEEL_DARK ? edge : pick(R, [BM.MULLION, BM.METAL, BM.STEEL_DARK]);
  const tint = mull === BM.STEEL_DARK || mull === BM.BRONZE ? pick(R, ['curtain', 'blue', 'green']) : pick(R, ['curtain', 'blue', 'dark', 'green']);
  const S = { seed: spec.seed, clad: pick(R, [BM.WHITE_CONCRETE, BM.LIMESTONE, BM.METAL, BM.PRECAST]), col: mull, canopy: edge === BM.BRONZE ? BM.BRONZE : BM.STEEL_DARK, tint, screen: R() < 0.6 };
  const gH = 28, uH = (1 + Math.floor(R() * 2)) * FH + 4, pH = gH + uH, fb = Math.max(14, Math.round(D * 0.1));
  const up = inset(W, D, 0, fb, 0, 0);
  buildTiers(E, C, W, D, [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: gH, skin: skinTwistGround(S), party: spec.party, roof: { mat: S.clad, deck: BM.CONCRETE } }),
    Object.assign({}, up, { h: uH, skin: skinTwistUpper(S), party: spec.party, roof: { mat: S.clad, deck: BM.CONCRETE } })], spec.seed);
  terraceGardens(E, C, inset(W, D, 0, 0, 0, 0), up, gH, R, { rim: S.clad, trees: true, tree: 16 });
  // plan
  const lim = Math.min(W, D - fb) - 6, oblong = R() < 0.5, asp = oblong ? 1.35 + R() * 0.35 : 1;
  const accent = oblong ? pick(R, ['balc', 'fins', 'balc']) : pick(R, ['loggia', 'fins', 'loggia']);
  const s = 3, ev = (v) => Math.max(24, v - (v & 1));
  const d0 = ev(Math.floor(lim / Math.hypot(asp, 1) - 2 * s - (accent === 'balc' ? 2 : 0))), w0 = ev(Math.floor(d0 * asp));
  const n = Math.max(26, Math.round(spec.floors * (1 + R() * 0.3)));
  const total = (0.6 + R() * 1.0) * (R() < 0.5 ? 1 : -1), prof = pick(R, ['lin', 'ease', 'late']);
  const P = (t) => prof === 'lin' ? t : prof === 'ease' ? t * t * (3 - 2 * t) : t * t;
  const taper = R() < 0.4 ? 0.8 + R() * 0.1 : 1;
  const crown = pick(R, ['slope', 'spire', 'lantern']);
  const K = crown === 'slope' ? 5 + Math.floor(R() * 3) : 0;
  const pitch = accent === 'fins' ? pick(R, [5, 6]) : pick(R, [4, 5, 6]), spand = R() < 0.5 ? BM.SPANDREL : edge, finD = accent === 'fins' ? 5 : 3;
  const cx = W / 2, cz = fb + (D - fb) / 2;
  const dims = [];
  for (let k = 0; k < n; ++k) {
    const t = k / (n - 1), sc = 1 - (1 - taper) * t;
    const w = ev(Math.round(w0 * sc)), d = ev(Math.round(d0 * sc));
    const j = k - (n - K);
    dims.push([w, j >= 0 ? ev(Math.round(d * (1 - 0.6 * (j + 1) / (K + 1)))) : d, d]);
  }
  const floorSkin = (k) => (len) => {
    const hh = FH - 1, F = new Relief(len, hh, 1, BM.CURTAIN);
    for (let u = 0; u < len; u += pitch) F.rect(u, 2, Math.min(len, u + pitch), hh, 1, glassMat(spec.seed, u + k * 101, k, 0.3, tint));
    F.rect(0, 0, len, 2, BASE, spand);
    for (let u = 0; u < len; u += pitch) F.rect(u, 0, u + 1, hh, accent === 'fins' && (u / pitch) % 2 === 0 ? finD : 3, mull);
    F.rect(0, 0, 1, hh, 3, mull); F.rect(len - 1, 0, len, hh, 3, mull);
    F.returns();
    return F;
  };
  const slabs = {};
  let th = 0;
  for (let k = 0; k < n; ++k) {
    th = total * P(k / (n - 1));
    const [w, d, dFull] = dims[k], y = pH + k * FH;
    const Ec = rotated(E, cx, cz, th, 0, 0);
    const [pw, pd] = k ? dims[k - 1] : [w, d];
    const z0 = -dFull / 2;                                                                    // plates stay flush at the front
    const rb = k > 0 && pd > d ? d + 2 * s - 2 : undefined;
    const key = [pw, pd, rb].join();
    const sm = slabs[key] || (slabs[key] = twistSlabModel(pw, pd, s, { edge, rail: mull, balc: accent === 'balc', railBack: rb }));
    Ec.vox(C, sm, 0, y, z0 + pd / 2);
    const x0 = -w / 2;
    if (accent === 'loggia') prism(rotated(E, cx, cz, th, x0, z0), C, rectMask(w, d, 0, 0, w, d, 8), w, d, y + 1, FH - 1, floorSkin(k));
    else facades(rotated(E, cx, cz, th, x0, z0), 0, 0, w, d, y + 1, floorSkin(k), C, true);
    if (accent === 'loggia') {                                                                // loggia rails at the four corners
      const L = new C_VoxModel(w + 4, 6, d + 4, 2, 2);
      for (const [ax, az] of [[0, 0], [w - 8, 0], [0, d - 8], [w - 8, d - 8]]) {
        const zr = az === 0 ? 0 : d - 1, xr = ax === 0 ? 0 : w - 1;
        L.box(ax, 0, zr, ax + 8, 4, zr + 1, BM.GLASS_DARK); L.box(xr, 0, az, xr + 1, 4, az + 8, BM.GLASS_DARK);
        L.box(ax, 4, zr, ax + 8, 5, zr + 1, mull); L.box(xr, 4, az, xr + 1, 5, az + 8, mull);
      }
      rotated(E, cx, cz, th, x0, z0).vox(C, L, 0, y + 1, 0);
    }
  }
  const [w, d, dFull] = dims[n - 1], yTop = pH + n * FH, Ec = rotated(E, cx, cz, th, 0, 0);
  Ec.vox(C, twistRoofModel(w, d, s, { edge, mull, crown }, R), 0, yTop, -dFull / 2 + d / 2);
  if (crown === 'spire') {
    // a lattice spire that keeps turning: four posts drawing in, ring beams, a needle
    const segs = 16, r0 = Math.min(w, d) * 0.32, rate = (total / n) * 1.5;
    for (let j = 0; j < segs; ++j) {
      const r = r0 * (1 - j / segs) + 1.5, y = yTop + 2 + j * 8, Es = rotated(E, cx, cz, th + rate * (j + 1), 0, -dFull / 2 + d / 2);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) Es.box(sx * r - 1, y, sz * r - 1, sx * r + 1, y + 8, sz * r + 1, mull, j > 0);
      if (j % 3 === 2) for (const sz of [-1, 1]) { Es.box(-r + 1, y + 6, sz * r - 0.5, r - 1, y + 7, sz * r + 0.5, mull, false); Es.box(sz * r - 0.5, y + 6, -r + 1, sz * r + 0.5, y + 7, r - 1, mull, false); }
    }
    const Es = rotated(E, cx, cz, th, 0, -dFull / 2 + d / 2), yS = yTop + 2 + segs * 8;
    Es.box(-1, yS, -1, 1, yS + 30, 1, BM.METAL, true); Es.box(-1, yS + 30, -1, 1, yS + 31, 1, BM.BEACON);
  }
  // planted podium roof around the tower
  const rr = Math.hypot(w0 + 2 * s, d0 + 2 * s) / 2 + 3;
  for (const [fx, fz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    let bw = Math.floor(W / 2) - 6, bd = Math.floor((D - fb) / 2) - 6;
    const far = (bw2, bd2) => Math.hypot(cx - 4 - bw2, cz - fb - 4 - bd2);
    while ((bw > 8 || bd > 8) && far(bw, bd) < rr) { if (bw >= bd) --bw; else --bd; }
    if (bw < 6 || bd < 6 || far(bw, bd) < rr) continue;
    const x0 = fx ? W - 4 - bw : 4, z0 = fz ? D - 4 - bd : fb + 4;
    E.vox(C, gardenModel(bw, bd, R, { rim: S.clad, tree: bw >= 10 && bd >= 10 ? 14 : 0 }), x0, pH, z0);
  }
}
// Tower registry: built-in archetypes + plug-in files (towers/*.js call CityArch.registerTower).
// fn(E, C, W, D, spec, R, L): E emitter (building-local voxels, x along street, z into lot, y up), W/D lot size in
// voxels, spec { seed, floors, party }, R seeded random, L the shared toolkit (CityArch.lib).
const TOWERS = [];
function registerTower(name, fn, opts) { TOWERS.push({ name, fn, unique: !!(opts && opts.unique) }); }
[['deco', towerDeco], ['reuse', towerReuse], ['international', towerInternational], ['pencil', towerPencil], ['pomo', towerPomo],
 ['brutalist', towerBrutal], ['terraced', towerTerraced]].forEach(([n, f]) => registerTower(n, f));
registerTower('twist', towerTwist, { unique: true });
let towerDeck = [], TOWER_LOG = [], dealt = 0, usedUnique = new Set();
function buildTower(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  if (!towerDeck.length) {                                         // deal the next round of designs
    const order = TOWERS.filter(t => !(t.unique && usedUnique.has(t.name)));
    const Rd = C.mulberry32((spec.seed ^ 0x9e3779b9) + dealt++);
    for (let i = order.length - 1; i > 0; --i) { const j = Math.floor(Rd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    towerDeck = order;
  }
  const t = towerDeck.pop();
  if (t.unique) usedUnique.add(t.name);
  TOWER_LOG.push({ type: t.name, x: E.O[0] + (W / 2) * BV * E.e1[0] + (D / 2) * BV * E.e2[0], z: E.O[1] + (W / 2) * BV * E.e1[1] + (D / 2) * BV * E.e2[1], floors: spec.floors });
  t.fn(E, C, W, D, spec, R, LIB);
}
function facadeGlassFloor(W, fh, S, k, fin) {
  const F = new Relief(W, fh, 0, BM.CURTAIN);
  for (let u = 0; u < W; u += 5) F.rect(u, 2, u + 5, fh, BASE, H2(S.seed, u, k) < 0.33 ? BM.CURTAIN_LIT : BM.CURTAIN);
  F.rect(0, 0, W, 2, BASE, BM.SPANDREL);
  for (let u = 0; u < W; u += 5) F.rect(u, 1, u + 1, fh, fin ? 4 : 3, BM.MULLION);
  return F;
}
function shadeOf(m) {
  // a slightly darker companion colour for siding courses / belt courses (registered in the palette below)
  return SHADES[m] || m;
}
const SHADES = {};
let nextShade = 113;
for (const m of [BM.SIDING_WHITE, BM.SIDING_YELLOW, BM.SIDING_BLUE, BM.SIDING_SAGE, BM.SIDING_GRAY, BM.PAINT_CREAM,
                 BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN, BM.PAINT_BLUE, BM.PAINT_YELLOW, BM.PAINT_SALMON, BM.PAINT_SAGE]) {
  const c = ARCH_PALETTE[m];
  ARCH_PALETTE[nextShade] = c.map(v => Math.round(v * 0.9));
  SHADES[m] = nextShade++;
}


// ------------------------------------------------------------------------------------------------ occupancy
class Occupancy {
  constructor(b) { this.c = 0.5; this.x0 = b.x0 - 10; this.z0 = b.z0 - 10; this.nx = Math.ceil((b.x1 - b.x0 + 20) / this.c); this.nz = Math.ceil((b.z1 - b.z0 + 20) / this.c); this.g = new Uint8Array(this.nx * this.nz); }
  // oriented rectangle: origin O, axes e1/e2, extents [a0,a1] x [b0,b1] (metres); mode 'test' returns covered fraction
  rect(O, e1, e2, a0, a1, b0, b1, mark) {
    const pts = [[a0, b0], [a1, b0], [a0, b1], [a1, b1]].map(([a, b]) => [O[0] + a * e1[0] + b * e2[0], O[1] + a * e1[1] + b * e2[1]]);
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - this.x0) / this.c)), i1 = Math.min(this.nx - 1, Math.ceil((Math.max(...xs) - this.x0) / this.c));
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - this.z0) / this.c)), j1 = Math.min(this.nz - 1, Math.ceil((Math.max(...zs) - this.z0) / this.c));
    let inside = 0, hit = 0;
    for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) {
      const x = this.x0 + (i + 0.5) * this.c - O[0], z = this.z0 + (j + 0.5) * this.c - O[1];
      const a = x * e1[0] + z * e1[1], b = x * e2[0] + z * e2[1];
      if (a < a0 || a > a1 || b < b0 || b > b1) continue;
      ++inside;
      const k = j * this.nx + i;
      if (this.g[k]) ++hit;
      if (mark) this.g[k] = 1;
    }
    return inside ? hit / inside : 0;
  }
}

// ------------------------------------------------------------------------------------------------ suburban subdivision
// Planned subdivisions along every local residential street: lots at a fixed pitch on both sides, houses at a
// common setback facing the street (following curves), pie-shaped lots radiating around cul-de-sac bulbs.
// Every house gets a driveway (with an attached garage on wide lots) and a front walk. The footprint must lie
// on yard (not road, sidewalk, park or plaza) and clear of everything already placed.
function subdivide(net, Ra, C, occ, emitHouse) {
  const o = {}, cls = [0, 0];
  const MAT = C.MAT;
  const okGround = (x, z) => { Ra.classify(x, z, o, cls); return cls[1] === MAT.YARD || cls[1] === MAT.PLOT; };
  let n = 0;
  const tryHouse = (cx, cz, e1, e2, w, d, seed, garage) => {
    // footprint + garage + driveway envelope in the house frame (centre at cx, cz)
    const gw = garage ? 3.6 : 0, dw = 3.2;
    const a0 = -w / 2, a1 = w / 2 + Math.max(gw, dw) + 0.3;
    const O = [cx, cz];
    const pts = [];
    for (const a of [a0, 0, a1]) for (const b of [-d / 2, 0, d / 2]) pts.push([cx + a * e1[0] + b * e2[0], cz + a * e1[1] + b * e2[1]]);
    if (!pts.every(([x, z]) => okGround(x, z))) return false;
    if (occ.rect(O, e1, e2, a0 - 1.2, a1 + 1.2, -d / 2 - 1, d / 2 + 1, false) > 0) return false;
    occ.rect(O, e1, e2, a0, a1, -d / 2, d / 2, true);
    emitHouse(O, e1, e2, w, d, seed, garage);
    ++n;
    return true;
  };
  for (const r of net.roads) {
    if (r.district !== 'residential' || r.P.cls !== 'local' || !r.len) continue;
    const P = r.P, pitch = r.P.id === 'lane' ? 15 : 16.5;
    const J = (r.junctions || []).filter(j => j.major);
    const front = P.half + P.sidewalk + 5.5;                    // centreline -> house front
    for (const side of [1, -1]) {
      let k = 0;
      for (let s = 8; s < r.len - (r.bulbEnd ? 4 : 8); s += pitch, ++k) {
        if (J.some(j => s > j.a - 12 && s < j.b + 12)) continue;
        const [px, pz, tx, tz] = C.pointAt(r, s);
        const nx = tz * side, nz = -tx * side;                     // away from the street on this side
        let e1 = [tx, tz], e2 = [-tz, tx];
        if (e2[0] * nx + e2[1] * nz < 0) { e1 = [-tx, -tz]; e2 = [tz, -tx]; }
        const seed = (r.id * 7919 + k * 104729 + (side > 0 ? 1 : 2) * 31337) >>> 0;
        const Rn = C.mulberry32(seed);
        const w = 8.5 + Rn() * 2.5, d = 8 + Rn() * 2.5;
        const dc = front + d / 2;
        tryHouse(px + nx * dc, pz + nz * dc, e1, e2, w, d, seed, Rn() < 0.55);
      }
    }
    if (r.bulbEnd) {                                               // pie lots around the turning circle
      const [ex, ez] = r.pts[r.pts.length - 1], [qx, qz] = r.pts[r.pts.length - 2];
      const back = Math.atan2(qz - ez, qx - ex);
      const rb = r.bulbEnd + P.sidewalk + 5;
      for (let k = 0; k < 9; ++k) {
        const ang = back + 0.75 + k * 0.6;
        if (ang > back + 2 * Math.PI - 0.75) break;
        const dir = [Math.cos(ang), Math.sin(ang)];
        const e2 = dir, e1 = [dir[1], -dir[0]];
        const seed = (r.id * 7919 + 977 * k + 5) >>> 0, Rn = C.mulberry32(seed);
        const w = 8.5 + Rn() * 2, d = 8 + Rn() * 2;
        tryHouse(ex + dir[0] * (rb + d / 2), ez + dir[1] * (rb + d / 2), e1, e2, w, d, seed, Rn() < 0.5);
      }
    }
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ placement
// Largest clean rectangle of each plot (in the plot's street-aligned frame, 0.5 m cells), preferring
// rectangles that front the street; style and size from the zone.
function lotRectangles(PL, C) {
  const nx = PL.nx, nz = PL.nz, P = PL.plot, cell = PL.cell;
  const lists = new Map();
  for (let i = 0; i < P.length; ++i) { const id = P[i]; if (id < 0) continue; let a = lists.get(id); if (!a) lists.set(id, a = []); a.push(i); }
  const out = [];
  for (const [id, list] of lists) {
    const road = PL.net.roads[Math.floor(id / 32768)];
    let mx = 0, mz = 0;
    for (const i of list) { mx += i % nx; mz += (i / nx) | 0; }
    mx = PL.x0 + (mx / list.length + 0.5) * cell; mz = PL.z0 + (mz / list.length + 0.5) * cell;
    let [tx, tz] = PL.tangentNear(road, mx, mz);
    let e1 = [tx, tz], e2 = [-tz, tx];
    // e2 must point from the street into the lot (rotate the frame by 180 degrees if not: no mirroring)
    let best = 1e9, rp = null;
    for (let i = 0; i + 1 < road.pts.length; ++i) {
      const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((mx - ax) * dx + (mz - az) * dz) / l2));
      const qx = ax + t * dx, qz = az + t * dz, d = Math.hypot(mx - qx, mz - qz);
      if (d < best) { best = d; rp = [qx, qz]; }
    }
    if ((mx - rp[0]) * e2[0] + (mz - rp[1]) * e2[1] < 0) { e1 = [-e1[0], -e1[1]]; e2 = [-e2[0], -e2[1]]; }
    // plot mask in the local frame
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const i of list) {
      const x = PL.x0 + (i % nx + 0.5) * cell - mx, z = PL.z0 + (((i / nx) | 0) + 0.5) * cell - mz;
      const a = x * e1[0] + z * e1[1], b = x * e2[0] + z * e2[1];
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    a0 -= cell; b0 -= cell; a1 += cell; b1 += cell;
    const w = Math.ceil((a1 - a0) / cell), d = Math.ceil((b1 - b0) / cell);
    const mask = new Uint8Array(w * d);
    for (let j = 0; j < d; ++j) for (let i = 0; i < w; ++i) {
      const a = a0 + (i + 0.5) * cell, b = b0 + (j + 0.5) * cell;
      const x = mx + a * e1[0] + b * e2[0], z = mz + a * e1[1] + b * e2[1];
      const ix = Math.floor((x - PL.x0) / cell), iz = Math.floor((z - PL.z0) / cell);
      // a cell is usable when it and its 4 neighbours belong to the plot (keeps a margin to the plot edge)
      const ok = (u, v) => u >= 0 && v >= 0 && u < nx && v < nz && P[v * nx + u] === id;
      mask[j * w + i] = ok(ix, iz) ? 1 : 0;
    }
    // decompose the plot into clean rectangles: repeatedly take the best maximal rectangle (histogram method,
    // rows from the street inward, preferring street frontage) and remove it, until nothing usable is left
    for (let pass = 0; pass < 6; ++pass) {
      const hgt = new Int32Array(w);
      let bestS = -1, R = null;
      for (let j = 0; j < d; ++j) {
        for (let i = 0; i < w; ++i) hgt[i] = mask[j * w + i] ? hgt[i] + 1 : 0;
        const st = [];
        for (let i = 0; i <= w; ++i) {
          const hh = i < w ? hgt[i] : 0;
          while (st.length && hgt[st[st.length - 1]] >= hh) {
            const top = st.pop(), hTop = hgt[top];
            const left = st.length ? st[st.length - 1] + 1 : 0, width = i - left;
            const front = j - hTop + 1;
            const score = width * Math.min(hTop, 90) - front * width * 0.8;
            if (hTop >= 10 && width >= 10 && score > bestS) { bestS = score; R = { i0: left, i1: i, j0: front, j1: j + 1 }; }
          }
          st.push(i);
        }
      }
      if (!R) break;
      for (let j = R.j0; j < R.j1; ++j) for (let i = R.i0; i < R.i1; ++i) mask[j * w + i] = 0;
      out.push({ id, part: pass, road, e1, e2, mx, mz, a0: a0 + R.i0 * cell, a1: a0 + R.i1 * cell, b0: b0 + R.j0 * cell, b1: b0 + R.j1 * cell,
        front: (b0 + R.j0 * cell), info: PL.info.get(id) });
    }
  }
  return out;
}
function zoneOf(net, r, x, z) {
  const core = (net.origins && net.origins.core) || [0, 0];
  const dc = Math.hypot(x - core[0], z - core[1]);
  const d = r.district;
  if (d === 'residential') return 'house';
  if (d === 'oldtown') return dc < 180 && r.P.cls !== 'local' ? 'mid' : 'row';
  if (dc < 160) return 'tower';
  if (dc < 230) return 'mid';
  return r.P.cls === 'arterial' ? 'mid' : 'row';
}
function buildAll(PL, R, voxel, C) {
  C_VoxModel = C.VoxModel;
  towerDeck = []; TOWER_LOG = []; dealt = 0; usedUnique = new Set();
  const mb = new C.MeshBuffer();
  const lots = lotRectangles(PL, C);
  const hs = R.hs * voxel;
  const counts = {};
  counts.house = 0;
  const occ = new Occupancy(PL.net.bounds);
  counts.house = subdivide(PL.net, R, C, occ, (Oc, e1, e2, w, d, seed, garage) => {
    const W = Math.floor(w / BV), D = Math.floor(d / BV);
    const O = [Oc[0] - (W * BV / 2) * e1[0] - (D * BV / 2) * e2[0], Oc[1] - (W * BV / 2) * e1[1] - (D * BV / 2) * e2[1]];
    const E = new Emitter(mb, O, e1, e2, hs, voxel);
    buildHouse(E, W, D, { seed, floors: C.mulberry32(seed ^ 77)() < 0.6 ? 2 : 1, garage, setback: 5.5 / BV + 0 }, C);
  });
  const place = (L, a0, a1, b0, b1, kind, floors, seed) => {
    const W = Math.floor((a1 - a0) / BV), D = Math.floor((b1 - b0) / BV);
    if (W < 16 || D < 16) return;
    const Oc = [L.mx, L.mz];
    if (occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, false) > 0.02) return;
    occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, true);
    jobs.push({ L, a0, a1, b0, b1, W, D, kind, floors, seed });
  };
  const jobs = [];
  const emitJobs = () => {
    // second pass: with every footprint known, attached neighbours at either end become party walls
    for (const J of jobs) {
      const { L, a0, a1, b0, b1, W, D, kind, floors, seed } = J;
      const Oc = [L.mx, L.mz], bi0 = b0 + Math.min(1, (b1 - b0) / 4), bi1 = b1 - Math.min(1, (b1 - b0) / 4);
      const party = { l: occ.rect(Oc, L.e1, L.e2, a0 - 0.75, a0 - 0.25, bi0, bi1, false) > 0.5,
                      r: occ.rect(Oc, L.e1, L.e2, a1 + 0.25, a1 + 0.75, bi0, bi1, false) > 0.5 };
      const O = [L.mx + a0 * L.e1[0] + b0 * L.e2[0], L.mz + a0 * L.e1[1] + b0 * L.e2[1]];
      const E = new Emitter(mb, O, L.e1, L.e2, hs, voxel);
      const spec = { seed, floors, party, shops: L.road.P.cls !== 'local' && L.part === 0 };
      if (kind === 'house') buildHouse(E, W, D, spec, C);
      else if (kind === 'row') buildRows(E, W, D, spec, C);
      else if (kind === 'mid') buildMid(E, W, D, spec, C);
      else buildTower(E, W, D, spec, C);
      counts[kind] = (counts[kind] || 0) + 1;
    }
  };
  const housesBefore = counts.house;
  for (const L of lots) {
    const zone = zoneOf(PL.net, L.road, L.mx, L.mz);
    const seed0 = ((L.id * 2654435761) ^ (L.part * 40503)) >>> 0;
    const Rn = C.mulberry32(seed0);
    const lw = L.a1 - L.a0, ld = L.b1 - L.b0;
    if (zone === 'house') {
      // a row of detached houses along the frontage, 13-17 m lots, set back with side yards
      let a = L.a0, k = 0;
      while (L.a1 - a >= 10) {
        let pw = 13 + Rn() * 4; if (L.a1 - a - pw < 10) pw = L.a1 - a;
        const w = Math.min(pw - 3, 8.5 + Rn() * 3.5), dd = Math.min(ld - 5, 8.5 + Rn() * 3.5);
        if (w >= 6 && dd >= 6) {
          const ac = a + pw / 2, bb = L.b0 + Math.min(4.5, ld - dd - 0.5);
          place(L, ac - w / 2, ac + w / 2, bb, bb + dd, 'house', Rn() < 0.6 ? 2 : 1, (seed0 + k * 7919) >>> 0);
        }
        a += pw; ++k;
      }
      continue;
    }
    if (zone === 'row') {
      if (lw < 5.5) continue;
      const rd = Math.min(ld, 26);
      place(L, L.a0, L.a1, L.b0, L.b0 + rd, 'row', 3 + (Rn() < 0.4 ? 1 : 0), seed0);
      if (ld - rd >= 8) place(L, L.a0, L.a1, L.b0 + rd, L.b1, lw >= 10 ? 'mid' : 'row', 4, (seed0 ^ 0x5bd1e995) >>> 0);
      continue;
    }
    // mid-rise / tower zones: split long frontages into separate buildings of different heights and styles
    let a = L.a0, k = 0;
    while (L.a1 - a >= 8) {
      const tower = zone === 'tower' && k === 0 && lw >= 18 && ld >= 18;
      let pw = tower ? Math.min(lw, 26 + Rn() * 14) : 12 + Rn() * 14;
      if (L.a1 - a - pw < 10) pw = L.a1 - a;
      const seed = (seed0 + k * 104729) >>> 0;
      const Rk = C.mulberry32(seed);
      if (tower && pw >= 18) {
        const td = Math.min(ld, 46);
        place(L, a, a + pw, L.b0, L.b0 + td, 'tower', 18 + Math.floor(Rk() * Rk() * 26), seed);
        if (ld - td >= 8) place(L, a, a + pw, L.b0 + td, L.b1, 'mid', 5, (seed ^ 0x27d4eb2f) >>> 0);
      }
      else if (pw >= 10 && ld >= 9) {
        const core = zone === 'tower';
        const md = Math.min(ld, 34);
        place(L, a, a + pw, L.b0, L.b0 + md, 'mid', core ? 8 + Math.floor(Rk() * 7) : 4 + Math.floor(Rk() * 6), seed);
        if (ld - md >= 8) place(L, a, a + pw, L.b0 + md, L.b1, 'mid', 3 + Math.floor(Rk() * 4), (seed ^ 0x27d4eb2f) >>> 0);   // rear building
      } else place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 14), 'row', 4, seed);
      a += pw; ++k;
    }
  }
  emitJobs();
  const res = mb.finish(0.002);
  res.counts = counts;
  res.towers = TOWER_LOG;
  return res;
}

const LIB = {
  BV, BM, FH, BASE, Relief, bays, H2, pick, glassMat, facades, prism, roofMask, buildTiers, soffit, inset, rectMask, rotated, flatRoof,
  facadeMid, facadeGlassFloor, waterTank, skinPodium, skinDeco, skinDecoBase, skinCurtain, skinBronze, skinPilotis, skinFins, skinPomo,
  skinArcade, skinPrecast, skinLouver, decoCrownModel, lanternModel, mastsModel, craneModel, pyramidModel, pedimentModel, plazaModel,
  planterRowModel, VoxModel: () => C_VoxModel
};
// Preview one tower type on an empty lot (tools / review): lot Wm x Dm metres, origin at the lot's front-left corner
function previewTower(name, Wm, Dm, floors, seed, C) {
  C_VoxModel = C.VoxModel;
  const t = TOWERS.find(x => x.name === name);
  if (!t) throw new Error('unknown tower ' + name + '; known: ' + TOWERS.map(x => x.name).join(', '));
  const mb = new C.MeshBuffer();
  const E = new Emitter(mb, [0, 0], [1, 0], [0, 1], 0.15, 0.1);
  const W = Math.floor(Wm / BV), D = Math.floor(Dm / BV);
  t.fn(E, C, W, D, { seed, floors, party: {} }, C.mulberry32(seed), LIB);
  return mb.finish(0.002);
}
const CityArch = { previewTower, BV, BM, ARCH_PALETTE, LIT: [...LIT], buildAll, lotRectangles, registerTower, lib: LIB, towers: TOWERS };
if (typeof module !== 'undefined' && module.exports) module.exports = CityArch; else root.CityArch = CityArch;
})(typeof self !== 'undefined' ? self : this);
