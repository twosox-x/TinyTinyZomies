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
  PAINT_SALMON: 106, PAINT_SAGE: 107, SIDING_GRAY: 108, CONCRETE: 109, SHINGLE_SLATE: 110, SIDING_SHADE: 111, BRICK_SHADE: 112
};
// muted, slightly washed-out sRGB colours; lit glass glows at night (renderer)
const ARCH_PALETTE = {
  71: [168, 92, 74], 72: [134, 72, 62], 73: [150, 108, 84], 74: [214, 204, 184], 75: [186, 176, 158], 76: [206, 182, 142],
  77: [222, 220, 212], 78: [232, 218, 168], 79: [176, 196, 210], 80: [176, 190, 160], 81: [228, 214, 186], 82: [150, 170, 186], 83: [226, 202, 132],
  84: [226, 222, 210], 85: [88, 84, 80], 86: [92, 108, 120], 87: [250, 214, 150], 88: [118, 142, 160], 89: [244, 222, 170], 90: [72, 78, 84], 91: [84, 92, 100],
  92: [108, 106, 104], 93: [96, 98, 102], 94: [112, 90, 76], 95: [150, 52, 46], 96: [168, 64, 56], 97: [72, 110, 84], 98: [70, 96, 130],
  99: [150, 154, 156], 100: [140, 108, 78], 101: [110, 150, 134], 102: [70, 86, 98], 103: [58, 84, 66], 104: [44, 46, 50], 105: [48, 62, 92],
  106: [214, 156, 136], 107: [160, 176, 146], 108: [196, 198, 198], 109: [176, 172, 166], 110: [84, 92, 104], 111: [0, 0, 0], 112: [0, 0, 0]
};
const LIT = new Set([87, 89]);

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
  // relief / height map meshed by the column mesher, then mapped: map(rx, ry, rz) -> local (x, y, z)
  relief(H, M, w, d, map, wallMat, C) {
    const t = new C.MeshBuffer();
    C.meshColumns(H, M, w, d, 0, 0, wallMat, t);
    const o = map(0, 0, 0);
    const dir = (dx, dy, dz) => { const p = map(dx, dy, dz); return [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; };
    const NR = [dir(0, 1, 0), dir(1, 0, 0), dir(-1, 0, 0), dir(0, 0, 1), dir(0, 0, -1)];
    for (let q = 0; q < t.quads; ++q) {
      const k = q * 12, P = t.pos;
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
function facades(E, x0, z0, x1, z1, y0, facadeFn, C, frontSides) {
  const W = x1 - x0, D = z1 - z0;
  const wall = (m) => m;
  const sides = [
    { len: W, map: (F) => (rx, ry, rz) => [x0 + rx - F.ext, y0 + rz, z0 + BASE - ry], side: false, front: true },
    { len: W, map: (F) => (rx, ry, rz) => [x1 - (rx - F.ext), y0 + rz, z1 + (ry - BASE)], side: false, front: false },
    { len: D, map: (F) => (rx, ry, rz) => [x0 + BASE - ry, y0 + rz, z1 - (rx - F.ext)], side: true, front: false },
    { len: D, map: (F) => (rx, ry, rz) => [x1 + (ry - BASE), y0 + rz, z0 + (rx - F.ext)], side: true, front: false }
  ];
  for (const sd of sides) {
    const F = facadeFn(sd.len, sd.side && !(frontSides || false), sd.front);
    if (sd.side) {                                                // side facades: no corner returns (front/back carry them)
      for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) { F.set(-e, v, -1, 0); F.set(sd.len - 1 + e, v, -1, 0); }
    }
    E.relief(F.H, F.M, F.w, F.h, sd.map(F), wall, C);
  }
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
function waterTank(E, cx, cz, y) {
  for (const [dx, dz] of [[-3, -3], [2, -3], [-3, 2], [2, 2]]) E.box(cx + dx, y, cz + dz, cx + dx + 1, y + 7, cz + dz + 1, BM.METAL, true);
  E.box(cx - 4, y + 7, cz - 4, cx + 4, y + 8, cz + 4, BM.METAL, true);
  E.box(cx - 4, y + 8, cz - 3, cx + 4, y + 18, cz + 3, BM.WOOD, true);
  E.box(cx - 3, y + 8, cz - 4, cx + 3, y + 18, cz + 4, BM.WOOD, true);
  for (let k = 0; k < 3; ++k) E.box(cx - 3 + k, y + 18 + k, cz - 3 + k, cx + 3 - k, y + 19 + k, cz + 3 - k, BM.WOOD, true);   // conical lid
  E.box(cx - 4, y + 11, cz - 4, cx + 4, y + 12, cz + 4, BM.METAL, true);                          // hoop
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
  E.relief(H, M, W, D, (rx, ry, rz) => [x0 - ov + rx, yTop + ry, z0 - ov + rz], (m) => (m === S.roof ? BM.TRIM : m), C);
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
  for (const x of [px0, px0 + pw - 1]) E.box(x, 2, -8, x + 1, 11, -7, BM.TRIM, true);
  E.box(px0 - 1, 11, -9, px0 + pw + 1, 12, 0, S.roof);
  E.box(px0 + (pw >> 1) - 3, 0, -10, px0 + (pw >> 1) + 3, 1, -8, BM.CONCRETE);
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
    facades(E, x, 0, x + w, D, 0, (len, side, front) => facadeRow(len, floors, fh, S, side, front), C);
    flatRoof(E, x, 0, x + w, D, floors * fh + 4, S, C, { parapet: 1, parapetMat: S.corniceMat, units: 1 });
    // stoop: limestone steps up to the door
    const dc = bays(w, 8, 2); const c = x + dc[dc.length - 1];
    for (let s = 0; s < 4; ++s) E.box(c - 3, 0, -4 - (3 - s) * 2, c + 3, 1 + s, -4 - (3 - s) * 2 + 2, BM.LIMESTONE);
    E.box(c - 3, 0, -4, c + 3, 4, 0, BM.LIMESTONE);
    if (R() < 0.3 && w > 24 && D > 30) waterTank(E, x + (w >> 1), Math.floor(D * 0.6), floors * fh + 4);
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
  facades(E, 0, 0, W, D, 0, (len, side) => facadeMid(len, floors, fh, S, side), C, true);
  flatRoof(E, 0, 0, W, D, floors * fh + 5, S, C, { parapet: 2, parapetMat: BM.LIMESTONE_DARK, penthouse: floors >= 7 });
  if (R() < 0.45 && W > 30 && D > 30) waterTank(E, Math.floor(W * (0.2 + R() * 0.5)), Math.floor(D * 0.6), floors * fh + 5);
}
function buildTower(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  const deco = R() < 0.62;
  const fh = 14;
  if (deco) {
    // Art Deco: podium, two setbacks, crown with a stepped top and a spire
    const S = { seed: spec.seed, wall: pick(R, [BM.LIMESTONE, BM.BUFF, BM.BRICK_BROWN]), trim: BM.TRIM };
    const tiers = [];
    let x0 = 0, z0 = 0, x1 = W, z1 = D, y = 0, fl = spec.floors;
    const plan = [Math.round(fl * 0.25), Math.round(fl * 0.45), fl - Math.round(fl * 0.25) - Math.round(fl * 0.45)];
    plan.forEach((n, t) => {
      if (n <= 0 || x1 - x0 < 16 || z1 - z0 < 16) return;
      tiers.push({ x0, z0, x1, z1, y, n, crown: t === 2 });
      y += n * fh + (t === 2 ? 4 : 1);
      const ix = Math.max(4, Math.round((x1 - x0) * 0.14)), iz = Math.max(4, Math.round((z1 - z0) * 0.14));
      x0 += ix; x1 -= ix; z0 += iz; z1 -= iz;
    });
    for (const t of tiers) {
      facades(E, t.x0, t.z0, t.x1, t.z1, t.y, (len) => facadeDeco(len, t.n, fh, S, t.crown), C, true);
      flatRoof(E, t.x0, t.z0, t.x1, t.z1, t.y + t.n * fh + (t.crown ? 4 : 1), S, C, { parapet: 2, parapetMat: S.wall, units: 0 });
    }
    const top = tiers[tiers.length - 1];
    const cx = (top.x0 + top.x1) >> 1, cz = (top.z0 + top.z1) >> 1, yt = top.y + top.n * fh + 4;
    for (let k = 0; k < 4; ++k) E.box(cx - 8 + 2 * k, yt + k * 6, cz - 8 + 2 * k, cx + 8 - 2 * k, yt + (k + 1) * 6, cz + 8 - 2 * k, k % 2 ? S.wall : BM.TRIM);
    E.box(cx - 1, yt + 24, cz - 1, cx + 1, yt + 64, cz + 1, BM.METAL);                           // spire
  } else {
    // glass tower on a stone podium
    const SP = { seed: spec.seed, wall: pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK]), base: BM.LIMESTONE_DARK, awning: BM.AWNING_BLUE, shops: true, bayW: 10, lintels: false, trim: BM.TRIM };
    const podF = 4;
    facades(E, 0, 0, W, D, 0, (len, side) => facadeMid(len, podF, fh, SP, side), C, true);
    flatRoof(E, 0, 0, W, D, podF * fh + 5, SP, C, { parapet: 2, parapetMat: SP.wall, units: 2 });
    const ix = Math.max(6, Math.round(W * 0.16)), iz = Math.max(6, Math.round(D * 0.16));
    const S = { seed: spec.seed + 7 };
    const n = spec.floors - podF, y0 = podF * fh + 5;
    facades(E, ix, iz, W - ix, D - iz, y0, (len) => facadeGlass(len, n, fh, S), C, true);
    flatRoof(E, ix, iz, W - ix, D - iz, y0 + n * fh + 2, { seed: spec.seed, trim: BM.MULLION }, C, { parapet: 6, parapetMat: BM.MULLION, units: 3, penthouse: true });
  }
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
  const mb = new C.MeshBuffer();
  const lots = lotRectangles(PL, C);
  const hs = R.hs * voxel;
  const counts = {};
  const place = (L, a0, a1, b0, b1, kind, floors, seed) => {
    const W = Math.floor((a1 - a0) / BV), D = Math.floor((b1 - b0) / BV);
    if (W < 16 || D < 16) return;
    const O = [L.mx + a0 * L.e1[0] + b0 * L.e2[0], L.mz + a0 * L.e1[1] + b0 * L.e2[1]];
    const E = new Emitter(mb, O, L.e1, L.e2, hs, voxel);
    const spec = { seed, floors, shops: L.road.P.cls !== 'local' && L.part === 0 };
    if (kind === 'house') buildHouse(E, W, D, spec, C);
    else if (kind === 'row') buildRows(E, W, D, spec, C);
    else if (kind === 'mid') buildMid(E, W, D, spec, C);
    else buildTower(E, W, D, spec, C);
    counts[kind] = (counts[kind] || 0) + 1;
  };
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
      place(L, L.a0, L.a1, L.b0, Math.min(L.b1, L.b0 + 12 + Rn() * 4), 'row', 3 + (Rn() < 0.4 ? 1 : 0), seed0);
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
      if (tower && pw >= 18) place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 40), 'tower', 18 + Math.floor(Rk() * Rk() * 26), seed);
      else if (pw >= 10 && ld >= 9) {
        const core = zone === 'tower';
        place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 18 + Rk() * 10), 'mid', core ? 8 + Math.floor(Rk() * 7) : 4 + Math.floor(Rk() * 6), seed);
      } else place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 14), 'row', 4, seed);
      a += pw; ++k;
    }
  }
  const res = mb.finish(0.002);
  res.counts = counts;
  return res;
}

const CityArch = { BV, BM, ARCH_PALETTE, LIT: [...LIT], buildAll, lotRectangles };
if (typeof module !== 'undefined' && module.exports) module.exports = CityArch; else root.CityArch = CityArch;
})(typeof self !== 'undefined' ? self : this);
