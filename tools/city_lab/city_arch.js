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
  GLASS_GREEN_LIT: 148, GLASS_DARK_LIT: 149, BEACON: 150, LOUVER: 151, WATER: 152
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
  148: [246, 226, 176], 149: [240, 214, 160], 150: [230, 60, 50], 151: [124, 128, 130], 152: [104, 146, 168]
};
const LIT = new Set([87, 89, 148, 149]);

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
        if (t.nrm[q * 4] === 0) continue;
        const k = q * 12;
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
function buildTiers(E, C, W, D, tiers, seed) {
  let y = 0;
  tiers.forEach((t, i) => {
    const mask = rectMask(W, D, t.x0, t.z0, t.x1, t.z1, t.notch || 0);
    t.y = y;
    if (!t.notch) facades(E, t.x0, t.z0, t.x1, t.z1, y, (len, side, front) => t.skin(len, t.h, { side, front }), C, true, t.party);
    else prism(E, C, mask, W, D, y, t.h, t.skin);
    const nx = tiers[i + 1];
    const cover = nx && !nx.floating ? rectMask(W, D, nx.x0, nx.z0, nx.x1, nx.z1, nx.notch || 0) : null;
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

// ---- the eight archetypes. Each returns nothing; spec.party carries attached neighbours for the base.
function towerDeco(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, stone: pick(R, [BM.LIMESTONE, BM.BUFF, BM.TERRACOTTA]), trim: pick(R, [BM.LIMESTONE_DARK, BM.BRONZE]) };
  const n = Math.max(20, spec.floors), b = 5, n1 = Math.round(n * 0.32), n2 = Math.round(n * 0.25), n3 = Math.max(6, n - b - n1 - n2);
  const t1 = inset(W, D, Math.round(W * 0.1), Math.round(D * 0.12), Math.round(W * 0.1), Math.round(D * 0.06));
  const t2 = inset(W, D, Math.round(W * 0.2), Math.round(D * 0.22), Math.round(W * 0.2), Math.round(D * 0.16));
  const s = Math.min(t2.x1 - t2.x0, t2.z1 - t2.z0) - 12, cx = (t2.x0 + t2.x1) >> 1, cz = (t2.z0 + t2.z1) >> 1;
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: 20 + 4 * FH + 4, skin: skinDecoBase(S), party: spec.party, roof: { mat: S.trim } }),
    Object.assign(t1, { h: n1 * FH + 2, skin: skinDeco(S, false), roof: { mat: S.trim } }),
    Object.assign(t2, { notch: 6, h: n2 * FH + 2, skin: skinDeco(S, false), roof: { mat: S.trim } }),
    { x0: cx - (s >> 1), z0: cz - (s >> 1), x1: cx + (s >> 1), z1: cz + (s >> 1), h: n3 * FH + 6, skin: skinDeco(S, true), roof: { mat: S.trim, units: 0 } }
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  E.vox(C, decoCrownModel(Math.max(10, s - 6), S), cx, y, cz);
}
function towerReuse(E, C, W, D, spec, R) {
  // a 1900s building kept as the base; the glass tower rises from it behind a recessed reveal floor
  const brick = R() < 0.5;
  const SH = { seed: spec.seed, wall: brick ? pick(R, [BM.BRICK_RED, BM.BRICK_BROWN]) : pick(R, [BM.LIMESTONE, BM.BUFF]), base: BM.LIMESTONE_DARK,
    awning: pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]), shops: true, bayW: pick(R, [9, 10, 11]), lintels: true, trim: BM.TRIM };
  const bf = 5 + Math.floor(R() * 2), bh = bf * 14 + 5;
  const tw = inset(W, D, Math.round(W * 0.1), Math.max(12, Math.round(D * 0.14)), Math.round(W * 0.1), Math.round(D * 0.08));
  const rv = { x0: tw.x0 + 4, z0: tw.z0 + 4, x1: tw.x1 - 4, z1: tw.z1 - 4 };
  const n = Math.max(14, spec.floors - bf);
  const S = { seed: spec.seed + 3 };
  const mech = [Math.round(n * 0.5), n - 1];
  const tint = pick(R, ['curtain', 'green', 'dark']);
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: bh, skin: (len, h, info) => facadeMid(len, bf, 14, SH, false), party: spec.party, roof: { mat: SH.wall, units: 0 } }),
    Object.assign(rv, { h: 12, skin: (len, h) => { const F = new Relief(len, h, 0, BM.GLASS_DARK); for (let u = 0; u < len; u += 6) F.rect(u, 0, u + 1, h, 3, BM.MULLION); return F; }, noRoof: true }),
    Object.assign(tw, { notch: 4, h: n * FH + 3, skin: skinCurtain(S, { fin: true, mech, tint, pitch: 5, mullion: BM.MULLION, cap: BM.MULLION }), roof: { mat: BM.MULLION, units: 2 } })
  ];
  // the reveal floor has no roof of its own: the tower above it is wider, so its underside closes it
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  E.quad([tw.x0, bh + 12, tw.z0], [tw.x1, bh + 12, tw.z0], [tw.x1, bh + 12, tw.z1], [tw.x0, bh + 12, tw.z1], BM.MULLION, [0, -1, 0]);
  E.vox(C, craneModel(Math.min(40, tw.x1 - tw.x0 - 12)), tw.x0 + 6, y, (tw.z0 + tw.z1) >> 1);
  if (R() < 0.6) E.vox(C, mastsModel(R), (tw.x0 + tw.x1) >> 1, y, tw.z1 - 10);
}
function towerInternational(E, C, W, D, spec, R) {
  // set back behind its own granite plaza; raised on a glass lobby; bronze I-beam slab; mechanical penthouse
  const S = { seed: spec.seed, col: pick(R, [BM.GRANITE_DARK, BM.BRONZE]) };
  const zf = Math.max(24, Math.round(D * 0.38)), slabD = Math.min(D - zf - 2, Math.max(36, Math.round(D * 0.5)));
  const t0 = { x0: Math.round(W * 0.12), z0: zf, x1: W - Math.round(W * 0.12), z1: zf + slabD };
  if (t0.x1 - t0.x0 < 30 || slabD < 30) return towerReuse(E, C, W, D, spec, R);
  const n = Math.max(18, spec.floors);
  const tiers = [
    Object.assign({}, t0, { h: 18, skin: skinPilotis(S), noRoof: false, roof: { parapet: 0, deck: S.col } }),
    Object.assign({}, t0, { h: n * FH + 2, skin: skinBronze(S, { mech: [Math.round(n * 0.55)] }), roof: { mat: BM.BRONZE, units: 0 } }),
    { x0: t0.x0 + 8, z0: t0.z0 + 8, x1: t0.x1 - 8, z1: t0.z1 - 8, h: 12, skin: skinLouver({ frame: BM.BRONZE }), roof: { mat: BM.BRONZE, units: 2 } }
  ];
  tiers[0].h = 18;
  buildTiers(E, C, W, D, tiers, spec.seed);
  E.vox(C, plazaModel(W - 4, zf - 4, R), 2, 0, 2);
}
function towerPencil(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, stone: pick(R, [BM.LIMESTONE, BM.BUFF]), alt: pick(R, [BM.TERRACOTTA, BM.LIMESTONE_DARK]), stoneDark: BM.GRANITE_DARK, canopy: BM.BRONZE };
  const sw = Math.min(W - 16, 76), sd = Math.min(D - 30, 84);
  if (sw < 32 || sd < 32) return towerDeco(E, C, W, D, spec, R);
  const x0 = (W - sw) >> 1, z0 = Math.max(14, Math.round((D - sd) * 0.4));
  const n = Math.max(30, spec.floors + 14), top = 6;
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: 18 + 5 * FH + 3, skin: skinPodium(S), party: spec.party, roof: { mat: S.stone, deck: BM.CONCRETE } }),
    { x0, z0, x1: x0 + sw, z1: z0 + sd, h: (n - top) * FH, skin: skinFins(S), roof: { mat: S.stone } },
    { x0: x0 + 6, z0: z0 + 6, x1: x0 + sw - 6, z1: z0 + sd - 6, notch: 6, h: top * FH + 2, skin: skinFins(S), roof: { mat: S.stone, units: 0 } }
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  const p0 = 18 + 5 * FH + 3;
  for (const zz of [3, D - 7]) if (z0 > 10 || zz > 3) E.vox(C, planterRowModel(W - 8), 4, p0, zz);    // podium roof garden
  E.vox(C, lanternModel(sw - 16, sd - 16, S), x0 + 8, y, z0 + 8);
}
function towerPomo(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, stone: pick(R, [BM.GRANITE_PINK, BM.GRANITE_PINK, BM.BUFF]), dark: BM.GRANITE_DARK };
  const n = Math.max(18, spec.floors);
  const t1 = inset(W, D, 10, 12, 10, 8), n1 = Math.round(n * 0.7);
  const t2 = { x0: t1.x0 + 10, z0: t1.z0 + 10, x1: t1.x1 - 10, z1: t1.z1 - 10 };
  const tiers = [
    Object.assign(inset(W, D, 0, 0, 0, 0), { h: 2 * FH + 4 + FH + 2, skin: skinArcade(S), party: spec.party, roof: { mat: S.dark } }),
    Object.assign(t1, { notch: 6, h: n1 * FH + 2, skin: skinPomo(S), roof: { mat: S.dark } }),
    Object.assign(t2, { notch: 4, h: (n - n1) * FH + 2, skin: skinPomo(S), roof: { mat: S.dark, units: 0 } })
  ];
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  const w = t2.x1 - t2.x0 - 8, d = t2.z1 - t2.z0 - 8;
  if (R() < 0.5) E.vox(C, pyramidModel(w, d, S), t2.x0 + 4, y, t2.z0 + 4);
  else E.vox(C, pedimentModel(w, Math.max(6, d), S), t2.x0 + 4, y, t2.z0 + 4);
}
function towerBrutal(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, conc: BM.PRECAST, col: BM.PRECAST };
  const n = Math.max(16, Math.min(28, spec.floors));
  const t = inset(W, D, 6, 8, 6, 6);
  const tiers = [
    Object.assign({}, t, { h: 20, skin: skinPilotis(S), roof: { parapet: 0, deck: BM.PRECAST } }),
    Object.assign({}, inset(W, D, 2, 4, 2, 2), { h: n * FH + 6, skin: skinPrecast(S), floating: true, roof: { mat: BM.PRECAST, units: 3 } })
  ];
  // the body overhangs the recessed base: its underside is a soffit
  const y = buildTiers(E, C, W, D, tiers, spec.seed);
  const b = tiers[1];
  E.quad([b.x0, 20, b.z0], [b.x1, 20, b.z0], [b.x1, 20, b.z1], [b.x0, 20, b.z1], BM.PRECAST, [0, -1, 0]);
  E.vox(C, mastsModel(R), (b.x0 + b.x1) >> 1, y, (b.z0 + b.z1) >> 1);
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
function towerTwist(E, C, W, D, spec, R) {
  const S = { seed: spec.seed, stone: pick(R, [BM.LIMESTONE_DARK, BM.GRANITE_DARK]), stoneDark: BM.GRANITE_DARK, canopy: BM.MULLION };
  const pH = 18 + 3 * FH + 3;
  buildTiers(E, C, W, D, [Object.assign(inset(W, D, 0, 0, 0, 0), { h: pH, skin: skinPodium(S), party: spec.party, roof: { mat: S.stone, deck: BM.CONCRETE } })], spec.seed);
  const n = Math.max(20, spec.floors - 4), side = Math.floor(Math.min(W, D) * 0.6), cx = W / 2, cz = D * 0.55;
  const total = (0.7 + R() * 0.7) * (R() < 0.5 ? 1 : -1), Sg = { seed: spec.seed };
  for (let k = 0; k < n; ++k) {
    const th = total * k / Math.max(1, n - 1);
    const Ek = rotated(E, cx, cz, th, -side / 2, -side / 2);
    facades(Ek, 0, 0, side, side, pH + k * FH + 1, (len) => facadeGlassFloor(len, FH - 1, Sg, k), C, true);
    Ek.box(-1, pH + k * FH, -1, side + 1, pH + k * FH + 1, side + 1, BM.TRIM, k > 0);
    if (k === n - 1) {
      flatRoof(Ek, 0, 0, side, side, pH + n * FH, { seed: spec.seed, trim: BM.MULLION }, C, { parapet: 3, parapetMat: BM.MULLION, units: 2 });
      Ek.vox(C, mastsModel(R), side >> 1, pH + n * FH, side >> 1);
    }
  }
}
const TOWER_TYPES = [towerDeco, towerReuse, towerInternational, towerPencil, towerPomo, towerBrutal, towerTerraced, towerTwist];
let towerDeck = [], TOWER_LOG = [];
function buildTower(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  if (!towerDeck.length) {                                         // deal the next round of designs
    const order = TOWER_TYPES.slice();
    const Rd = C.mulberry32(spec.seed ^ 0x9e3779b9);
    for (let i = order.length - 1; i > 0; --i) { const j = Math.floor(Rd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    towerDeck = order;
  }
  const fn = towerDeck.pop();
  TOWER_LOG.push({ type: fn.name, x: E.O[0] + (W / 2) * BV * E.e1[0] + (D / 2) * BV * E.e2[0], z: E.O[1] + (W / 2) * BV * E.e1[1] + (D / 2) * BV * E.e2[1], floors: spec.floors });
  fn(E, C, W, D, spec, R);
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
  towerDeck = []; TOWER_LOG = [];
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

const CityArch = { BV, BM, ARCH_PALETTE, LIT: [...LIT], buildAll, lotRectangles };
if (typeof module !== 'undefined' && module.exports) module.exports = CityArch; else root.CityArch = CityArch;
})(typeof self !== 'undefined' ? self : this);
