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
    // same arithmetic as P() / N(), without the temporary arrays (this is the hot path of the building build)
    const O0 = this.O[0], O1 = this.O[1], a0 = this.e1[0], a1 = this.e1[1], b0 = this.e2[0], b1 = this.e2[1], y0 = this.y0, v = this.v;
    let a, b;
    a = p[0] * BV; b = p[2] * BV; const Ax = (O0 + a * a0 + b * b0) / v, Ay = (y0 + p[1] * BV) / v, Az = (O1 + a * a1 + b * b1) / v;
    a = q[0] * BV; b = q[2] * BV; const Bx = (O0 + a * a0 + b * b0) / v, By = (y0 + q[1] * BV) / v, Bz = (O1 + a * a1 + b * b1) / v;
    a = r[0] * BV; b = r[2] * BV; const Cx = (O0 + a * a0 + b * b0) / v, Cy = (y0 + r[1] * BV) / v, Cz = (O1 + a * a1 + b * b1) / v;
    a = s[0] * BV; b = s[2] * BV; const Dx = (O0 + a * a0 + b * b0) / v, Dy = (y0 + s[1] * BV) / v, Dz = (O1 + a * a1 + b * b1) / v;
    const Nx = n[0] * a0 + n[2] * b0, Ny = n[1], Nz = n[0] * a1 + n[2] * b1;
    const ux = Bx - Ax, uy = By - Ay, uz = Bz - Az, vx = Cx - Ax, vy = Cy - Ay, vz = Cz - Az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * Nx + cy * Ny + cz * Nz < 0) this.mb.quadN(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz, Bx, By, Bz, m, Nx, Ny, Nz);
    else this.mb.quadN(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz, Dx, Dy, Dz, m, Nx, Ny, Nz);
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
    const m = M._mesh || (M._mesh = C.meshVoxels3D(cropModel(M)));
    const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]], P = m.pos, s = 1 / C.PV;
    for (let q = 0; q < m.quads; ++q) {
      const k = q * 12, c = (i) => [P[k + i] * s + x, P[k + i + 1] * s + y, P[k + i + 2] * s + z];
      this.quad(c(0), c(3), c(6), c(9), m.mat[q * 4], NV[m.nrm[q * 4]]);
    }
    // vehicles parked on this part (M.vehicles, from the plug-ins' car() helpers): CityCore.Vehicles models,
    // placed at their footprint centre in the part's voxel frame (1 / BV voxels per metre)
    // (skipped when the finished part has anything inside the vehicle's footprint above the ground: shrubs, awnings)
    if (M.vehicles) for (const v of M.vehicles) {
      if (v.fit) {
        const a = (v.dir < 2 ? v.fit[1] : v.fit[0]) / BV / 2, b = (v.dir < 2 ? v.fit[0] : v.fit[1]) / BV / 2;
        let hit = false;
        for (let yy = v.y + 1; yy < v.y + 6 && !hit; ++yy) for (let zz = Math.floor(v.z - b + 0.5); zz < Math.ceil(v.z + b - 0.5) && !hit; ++zz)
          for (let xx = Math.floor(v.x - a + 0.5); xx < Math.ceil(v.x + a - 0.5); ++xx) if (M.at(xx + M.ox, yy, zz + M.oz)) { hit = true; break; }
        if (hit) continue;
      }
      C.Vehicles.emit(this, v.kind, v.opts, x + v.x, y + v.y, z + v.z, v.dir, 1 / BV, v.fit);
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
        // only faces on the relief's outer boundary (wall ends, top and bottom edges, and the ends of corner
        // returns that were cleared to -1): the cell on the face's outward side is empty (-1). The side walls of
        // recesses inside the facade (portals, lobbies, glazed slots) border cells of depth >= 0 and must stay,
        // or the building is see-through.
        const W2 = w + 2, X = P[k], Z = P[k + 2];
        let edge = true;
        if (nn <= 2) {
          const xo = nn === 1 ? X : X - 1, z0 = Math.min(P[k + 2], P[k + 5], P[k + 8], P[k + 11]), z1 = Math.max(P[k + 2], P[k + 5], P[k + 8], P[k + 11]);
          for (let z = z0; z < z1 && edge; ++z) if (H[(z + 1) * W2 + xo + 1] !== -1) edge = false;
        } else {
          const zo = nn === 3 ? Z : Z - 1, x0 = Math.min(P[k], P[k + 3], P[k + 6], P[k + 9]), x1 = Math.max(P[k], P[k + 3], P[k + 6], P[k + 9]);
          for (let x = x0; x < x1 && edge; ++x) if (H[(zo + 1) * W2 + x + 1] !== -1) edge = false;
        }
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

// A VoxModel cut down to its occupied columns and rows (x, z both sides, y above; the origin column and y = 0 stay
// put), so the mesher scans less empty space. The mesh is identical: coordinates relative to the origin are the
// same integers, and the slices visited keep their order.
function cropModel(M) {
  const w = M.w, h = M.h, d = M.d, V = M.v;
  let x0 = w, x1 = -1, z0 = d, z1 = -1, y1 = -1;
  for (let yy = 0; yy < h; ++yy) for (let zz = 0; zz < d; ++zz) {
    const r = (yy * d + zz) * w;
    let a = 0; while (a < w && !V[r + a]) ++a;
    if (a === w) continue;
    let b = w - 1; while (!V[r + b]) --b;
    if (a < x0) x0 = a; if (b > x1) x1 = b; if (zz < z0) z0 = zz; if (zz > z1) z1 = zz; y1 = yy;
  }
  if (y1 < 0) return M;
  const w2 = x1 - x0 + 1, d2 = z1 - z0 + 1, h2 = y1 + 1;
  if (w2 * d2 * h2 > 0.8 * w * h * d) return M;
  const K = new M.constructor(w2, h2, d2, M.ox - x0, M.oz - z0), V2 = K.v;
  for (let yy = 0; yy < h2; ++yy) for (let zz = 0; zz < d2; ++zz) {
    const r = (yy * d + zz + z0) * w + x0;
    V2.set(V.subarray(r, r + w2), (yy * d2 + zz) * w2);
  }
  return K;
}

// Sink slot shared by the dressing kits (parkkit, ruralkit): copies of kit models are sunk a few mm, one slot per copy,
// so overlapping copies never share a horizontal face plane. slots: offsets (m); taken: Set of slot indices used by the
// copies this one overlaps; st: start index (the copy's hash). Takes the first slot from st that is >= 2.1 cm from every
// taken one modulo 12.5 cm (model faces lie on 12.5 / 25 cm steps, so low tops of overlapping copies stay clear of the
// 2 cm depth tolerance, dev/groundfight.js), else the first free one (distinct: never coplanar), else st.
function sinkPick(slots, taken, st) {
  const n = slots.length;
  if (!taken.size) return st;
  let free = -1;
  for (let i = 0; i < n; ++i) {
    const k = (st + i) % n;
    if (taken.has(k)) continue;
    if (free < 0) free = k;
    let ok = true;
    for (const t of taken) { const d = Math.abs(slots[k] - slots[t]) % 0.125; if (Math.min(d, 0.125 - d) < 0.021) { ok = false; break; } }
    if (ok) return k;
  }
  return free < 0 ? st : free;
}

// ------------------------------------------------------------------------------------------------ mesh analysis
// Plane of quad q of a MeshBuffer with explicit normals (nvec): normal, offset d = n.p, and a key nk for the normal
// quantised to 1e-3. Used by cullHidden() (build) and by the dev checks (dev/regress.js, dev/zfight.js).
const sround = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
function planeOf(P, N, q) {
  const o = q * 12, nx = N[o], ny = N[o + 1], nz = N[o + 2];
  return { nx, ny, nz, d: nx * P[o] + ny * P[o + 1] + nz * P[o + 2],
    nk: (sround(nx * 1000) + 1000) * 4004001 + (sround(ny * 1000) + 1000) * 2001 + (sround(nz * 1000) + 1000) };
}
// Pairs of coplanar quads (plane offsets within tol) whose in-plane bounding rectangles overlap by more than
// minExt in both directions. same: same-facing pairs (z-fighting candidates), else opposite-facing pairs (solids
// pressed flush). Calls fn(a, b) for each candidate pair. Per normal: sort by plane offset, cluster, then sweep
// each cluster along the plane: O(n log n + pairs).
function coplanarPairs(mb, q0, q1, same, tol, minExt, fn) {
  const P = mb.pos, N = mb.nvec, byN = new Map();
  for (let q = q0; q < q1; ++q) {
    const o = q * 12;
    const nk = (sround(N[o] * 1000) + 1000) * 4004001 + (sround(N[o + 1] * 1000) + 1000) * 2001 + (sround(N[o + 2] * 1000) + 1000);
    let a = byN.get(nk); if (!a) byN.set(nk, a = []);
    a.push(q);
  }
  const done = new Set();
  let S0 = new Float64Array(64), S1 = new Float64Array(64), T0 = new Float64Array(64), T1 = new Float64Array(64), DD = new Float64Array(64), SD = new Uint8Array(64), QQ = new Int32Array(64);
  for (const [nk, A] of byN) {
    if (done.has(nk)) continue;
    done.add(nk);
    const o0 = A[0] * 12, nx = N[o0], ny = N[o0 + 1], nz = N[o0 + 2];
    let B = null;
    if (!same) {
      const ok = (sround(-nx * 1000) + 1000) * 4004001 + (sround(-ny * 1000) + 1000) * 2001 + (sround(-nz * 1000) + 1000);
      B = byN.get(ok); if (!B) continue;
      done.add(ok);
    } else if (A.length < 2) continue;
    // in-plane frame
    const rx = Math.abs(ny) < 0.9 ? 0 : 1, ry = Math.abs(ny) < 0.9 ? 1 : 0;
    let Ux = ny * 0 - nz * ry, Uy = nz * rx - nx * 0, Uz = nx * ry - ny * rx;
    const lu = Math.hypot(Ux, Uy, Uz); Ux /= lu; Uy /= lu; Uz /= lu;
    const Vx = ny * Uz - nz * Uy, Vy = nz * Ux - nx * Uz, Vz = nx * Uy - ny * Ux;
    const all = B ? A.concat(B) : A, nA = A.length, n = all.length;
    const d = new Float64Array(n);
    // plane offset from each quad's own normal: a group shares a quantised normal only, and on a rotated frame (streets
    // at arbitrary angles) the normals of different buildings differ in the 4th decimal: measuring every quad with the
    // first one's normal put two coplanar faces of one wall up to ~1 mm per 10 m of wall apart and missed the pair
    for (let i = 0; i < n; ++i) { const o = all[i] * 12; d[i] = (B && i >= nA ? -1 : 1) * (N[o] * P[o] + N[o + 1] * P[o + 1] + N[o + 2] * P[o + 2]); }
    const ord = new Int32Array(n); for (let i = 0; i < n; ++i) ord[i] = i;
    ord.sort((a, b) => d[a] - d[b]);
    for (let i = 0; i < n;) {
      let j = i + 1; while (j < n && d[ord[j]] - d[ord[j - 1]] < tol) ++j;
      const m = j - i;
      if (m > 1) {
        if (m > S0.length) { const L = 2 * m; S0 = new Float64Array(L); S1 = new Float64Array(L); T0 = new Float64Array(L); T1 = new Float64Array(L); DD = new Float64Array(L); SD = new Uint8Array(L); QQ = new Int32Array(L); }
        let sides = 0;
        for (let k = 0; k < m; ++k) {
          const e = ord[i + k], q = all[e], o = q * 12;
          let s0 = 1e18, s1 = -1e18, t0 = 1e18, t1 = -1e18;
          for (let v = 0; v < 12; v += 3) {
            const x = P[o + v], y = P[o + v + 1], z = P[o + v + 2];
            const s = x * Ux + y * Uy + z * Uz, t = x * Vx + y * Vy + z * Vz;
            if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t;
          }
          S0[k] = s0; S1[k] = s1; T0[k] = t0; T1[k] = t1; DD[k] = d[e]; SD[k] = e < nA ? 0 : 1; QQ[k] = q; sides |= 1 << SD[k];
        }
        if (same || sides === 3) {
          const so = new Int32Array(m); for (let k = 0; k < m; ++k) so[k] = k;
          so.sort((a, b) => S0[a] - S0[b]);
          for (let x = 0; x < m; ++x) {
            const a = so[x];
            for (let y = x + 1; y < m && S0[so[y]] < S1[a] - minExt; ++y) {
              const b = so[y];
              if (!same && SD[a] === SD[b]) continue;
              if (Math.min(S1[a], S1[b]) - Math.max(S0[a], S0[b]) <= minExt || Math.min(T1[a], T1[b]) - Math.max(T0[a], T0[b]) <= minExt) continue;
              if (Math.abs(DD[a] - DD[b]) > tol) continue;
              fn(QQ[a], QQ[b]);
            }
          }
        }
      }
      i = j;
    }
  }
}
// Rewrites the quads of a MeshBuffer in place (mb.pos / mat / nrm / nvec / idx / quads; still plain arrays):
//  - drops zero-area quads;
//  - resolve: settles z-fighting: where two coplanar quads facing the same way overlap (within 1 mm, thicker than
//    5 mm), the one emitted later wins and the overlap is cut out of the earlier one ("painter's order": a part
//    added onto a wall replaces the wall there; a side facade beats the corner end of the front facade's bands).
//    Same-material overlaps look the same whichever wins: the earlier quad is only dropped when it is covered whole;
//  - faces that can never be seen, unless kept with keep = { flush: true, ground: true }: the overlap of two
//    coplanar opposite-facing quads (two solids pressed flush together: party walls of attached buildings, a part's
//    underside on a roof) and downward faces on the ground plane (y = groundY). The build keeps them: the shadow
//    pass renders back faces (three.js shadowSide), so with a ~25 cm shadow texel removing them shifts
//    self-shadowing near corners and party walls; and cutting flush faces splits more quads than it removes.
//    dev/regress.js uses the full cull to normalise meshes before comparing them.
// Cut quads are re-emitted as convex pieces (quads; a triangle repeats its last vertex) with the same winding,
// material and normal. marks: old quad indices to remap (range starts / ends); returned in the new numbering.
function cullHidden(mb, groundY, marks, q0, resolve, keep) {
  q0 = q0 || 0; keep = keep || {};
  const P = mb.pos, N = mb.nvec, n = mb.quads, MAT = mb.mat;
  const TOL = 1e-3, MIN = 1e-4;
  const cut = new Map();
  const add = (a, b) => { let x = cut.get(a); if (!x) cut.set(a, x = []); x.push(b); };
  if (!keep.flush) coplanarPairs(mb, q0, n, false, TOL, MIN, (a, b) => { add(a, b); add(b, a); });
  if (resolve) coplanarPairs(mb, q0, n, true, 0.01, 0.05, (a, b) => add(Math.min(a, b), Math.max(a, b)));
  // quad q as a CCW convex polygon in a frame (o, U, V) of its plane, V = n x U (so CCW <=> facing n)
  const frameOf = (q) => {
    const o = q * 12, nx = N[o], ny = N[o + 1], nz = N[o + 2];
    for (let k = 1; k < 4; ++k) {
      let ux = P[o + k * 3] - P[o], uy = P[o + k * 3 + 1] - P[o + 1], uz = P[o + k * 3 + 2] - P[o + 2];
      const l = Math.hypot(ux, uy, uz);
      if (l < 1e-9) continue;
      ux /= l; uy /= l; uz /= l;
      return { o: [P[o], P[o + 1], P[o + 2]], U: [ux, uy, uz], V: [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux] };
    }
    return null;
  };
  const polyIn = (F, q) => {
    const o = q * 12, pts = [];
    for (let k = 0; k < 4; ++k) {
      const x = P[o + k * 3] - F.o[0], y = P[o + k * 3 + 1] - F.o[1], z = P[o + k * 3 + 2] - F.o[2];
      const p = [x * F.U[0] + y * F.U[1] + z * F.U[2], x * F.V[0] + y * F.V[1] + z * F.V[2]];
      if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) > 1e-7) pts.push(p);
    }
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-7) pts.pop();
    if (pts.length < 3) return null;
    if (area2(pts) < 0) pts.reverse();
    return pts;
  };
  const zeroArea = (o) => {
    const ax = P[o + 6] - P[o], ay = P[o + 7] - P[o + 1], az = P[o + 8] - P[o + 2];
    const bx = P[o + 3] - P[o], by = P[o + 4] - P[o + 1], bz = P[o + 5] - P[o + 2];
    const cx = P[o + 9] - P[o], cy = P[o + 10] - P[o + 1], cz = P[o + 11] - P[o + 2];
    const a1 = Math.hypot(by * az - bz * ay, bz * ax - bx * az, bx * ay - by * ax), a2 = Math.hypot(ay * cz - az * cy, az * cx - ax * cz, ax * cy - ay * cx);
    return a1 + a2 < 2e-8;
  };
  // pass 1: what becomes of each quad: 1 keep, 0 drop, 2 pieces (polygons in its frame)
  const fate = new Uint8Array(n).fill(1), pieceOf = new Map();
  let dropped = 0, split = 0, outQ = 0;
  for (let q = q0; q < n; ++q) {
    const o = q * 12;
    if (zeroArea(o)) { fate[q] = 0; dropped++; continue; }
    if (!keep.ground && N[o + 1] < -0.9999 && Math.abs(P[o + 1] - groundY) < 1e-6 && Math.abs(P[o + 4] - groundY) < 1e-6 &&
        Math.abs(P[o + 7] - groundY) < 1e-6 && Math.abs(P[o + 10] - groundY) < 1e-6) { fate[q] = 0; dropped++; continue; }
    const cand = cut.get(q);
    if (!cand) continue;
    const F = frameOf(q), A = F && polyIn(F, q);
    if (!A) continue;
    let pieces = null;
    for (const r of cand) {
      const B = polyIn(F, r);
      if (!B) continue;
      const sameMat = MAT[r * 4] === MAT[q * 4] && N[r * 12] * N[q * 12] + N[r * 12 + 1] * N[q * 12 + 1] + N[r * 12 + 2] * N[q * 12 + 2] > 0;
      const next = [];
      for (const p of (pieces || [A])) {
        // p minus convex B: the parts of p outside each edge of B in turn
        let rem = p;
        const parts = [];
        for (let i = 0; i < B.length && rem.length >= 3; ++i) {
          const a = B[i], b = B[(i + 1) % B.length];
          const outside = clipPoly(rem, b[0], b[1], a[0], a[1]);
          if (outside.length >= 3 && area2(outside) > 2 * MIN * MIN) parts.push(outside);
          rem = clipPoly(rem, a[0], a[1], b[0], b[1]);
        }
        const hit = rem.length >= 3 && area2(rem) > 2e-6;
        if (!hit || (sameMat && parts.length)) next.push(p); else for (const x of parts) next.push(x);
      }
      if (pieces || next.length !== 1 || next[0] !== A) pieces = next;
      if (pieces && !pieces.length) break;
    }
    if (!pieces) continue;
    split++;
    if (!pieces.length) { fate[q] = 0; dropped++; continue; }
    fate[q] = 2; pieceOf.set(q, { F, pieces });
  }
  for (let q = 0; q < n; ++q) {
    if (fate[q] === 1) ++outQ;
    else if (fate[q] === 2) for (const p of pieceOf.get(q).pieces) outQ += (p.length - 1) >> 1;
  }
  // pass 2: write the new arrays
  const pos = new Float64Array(outQ * 12), nv = new Float64Array(outQ * 12), mat = new Uint8Array(outQ * 4), nrm = new Uint8Array(outQ * 4), idx = new Uint32Array(outQ * 6);
  const start = new Int32Array(n + 1), src = new Int32Array(outQ);
  let w = 0;
  for (let q = 0; q < n; ++q) {
    start[q] = w;
    if (!fate[q]) continue;
    const o = q * 12, m = MAT[q * 4], nr = mb.nrm[q * 4];
    const put = () => { for (let k = 0; k < 12; ++k) nv[w * 12 + k] = N[o + k]; for (let k = 0; k < 4; ++k) { mat[w * 4 + k] = m; nrm[w * 4 + k] = nr; } src[w] = q; w++; };
    if (fate[q] === 1) { for (let k = 0; k < 12; ++k) pos[w * 12 + k] = P[o + k]; put(); continue; }
    const { F, pieces } = pieceOf.get(q);
    for (const p of pieces) {                                                 // convex polygon -> fan of quads
      for (let i = 1; i + 1 < p.length; i += 2) {
        const vs = [p[0], p[i], p[i + 1], p[Math.min(i + 2, p.length - 1)]];
        for (let v = 0; v < 4; ++v) for (let k = 0; k < 3; ++k) pos[w * 12 + v * 3 + k] = F.o[k] + F.U[k] * vs[v][0] + F.V[k] * vs[v][1];
        put();
      }
    }
  }
  start[n] = w;
  for (let k = 0; k < w; ++k) { const b = k * 4, i = k * 6; idx[i] = b; idx[i + 1] = b + 1; idx[i + 2] = b + 2; idx[i + 3] = b; idx[i + 4] = b + 2; idx[i + 5] = b + 3; }
  mb.pos = pos; mb.mat = mat; mb.nrm = nrm; mb.nvec = nv; mb.idx = idx; mb.quads = w;
  // typed arrays now (finish() reads them as they are); anything appended later turns them back into plain arrays
  if (!Object.prototype.hasOwnProperty.call(mb, 'quad')) {
    const proto = Object.getPrototypeOf(mb);
    mb.quad = function () {
      for (const k of ['pos', 'mat', 'nrm', 'nvec', 'idx']) if (this[k] && !Array.isArray(this[k])) this[k] = Array.from(this[k]);
      delete this.quad;
      return proto.quad.apply(this, arguments);
    };
  }
  return { marks: (marks || []).map(m => start[m]), dropped, split, removedQuads: n - w, src };
}
// twice the signed area of a 2D polygon; keep the part of poly left of the directed line a->b
function area2(p) { let s = 0; for (let i = 0; i < p.length; ++i) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; }
function clipPoly(poly, ax, ay, bx, by) {
  const out = [], dx = bx - ax, dy = by - ay;
  for (let i = 0; i < poly.length; ++i) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = dx * (p[1] - ay) - dy * (p[0] - ax), sq = dx * (q[1] - ay) - dy * (q[0] - ax);
    if (sp >= -1e-9) out.push(p);
    if ((sp > 1e-9 && sq < -1e-9) || (sp < -1e-9 && sq > 1e-9)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  }
  return out;
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
  if (LIB.waterTankImpl) return LIB.waterTankImpl(E, cx, cz, y, C);
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
    flatRoof(E, x, 0, x + w, D, floors * fh + 4, S, C, { parapet: 1, parapetMat: S.corniceMat, units: LIB.roofKit ? 0 : 1 });
    if (LIB.roofKit) LIB.roofKit(E, C, x + 1, 1, x + w - 1, D - 1, floors * fh + 4, R, { style: 'residential', floors });
    // stoop: limestone steps up to the door
    const dc = bays(w, 8, 2); const c = x + dc[dc.length - 1];
    for (let s = 0; s < 3; ++s) E.box(c - 3, 0, -4 - (3 - s) * 2, c + 3, 1 + s, -4 - (3 - s) * 2 + 2, BM.LIMESTONE);
    E.box(c - 3, 0, -4, c + 3, 4, 0, BM.LIMESTONE);
    if (!LIB.roofKit && R() < 0.3 && w > 24 && D > 30) waterTank(E, x + (w >> 1), Math.floor(D * 0.6), floors * fh + 4, C);
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
  flatRoof(E, 0, 0, W, D, floors * fh + 5, S, C, { parapet: 2, parapetMat: BM.LIMESTONE_DARK, penthouse: floors >= 7, units: LIB.roofKit ? 0 : undefined });
  if (LIB.roofKit) LIB.roofKit(E, C, 1, 1, W - 1, D - 1, floors * fh + 5, R, { style: brick ? 'historic' : 'office', floors });
  else if (R() < 0.45 && W > 30 && D > 30) waterTank(E, Math.floor(W * (0.2 + R() * 0.5)), Math.floor(D * 0.6), floors * fh + 5, C);
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
  let pitch = 5; while (n * 2 * (tw.x1 - tw.x0 + tw.z1 - tw.z0) / pitch > 2600) ++pitch;        // triangle budget
  const glassSkin = skinCurtain(S, { fin: R() < 0.5, mech, tint, pitch, mullion: mull, cap: mull, slabs: R() < 0.5, slabMat: mull });
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
  for (let x = 0; x < sw; x += pitch) { M.box(x, 0, -1, x + 1, sh(0) + 1, 0, mull); M.box(x, 0, sdp, x + 1, sh(sdp - 1) + 1, sdp + 1, mull); }
  for (let z = 0; z < sdp; z += pitch) { M.box(-1, 0, z, 0, sh(z) + 1, z + 1, mull); M.box(sw, 0, z, sw + 1, sh(z) + 1, z + 1, mull); }
  M.box(-1, 0, -1, 0, sh(0) + 1, 0, mull); M.box(sw, 0, -1, sw + 1, sh(0) + 1, 0, mull);
  M.box(-1, 0, sdp, 0, sh(sdp - 1) + 1, sdp + 1, mull); M.box(sw, 0, sdp, sw + 1, sh(sdp - 1) + 1, sdp + 1, mull);
  const px0 = Math.round(sw * 0.3), px1 = Math.round(sw * 0.7), pz0 = Math.round(sdp * 0.35), pz1 = Math.round(sdp * 0.75);
  M.box(px0, 0, pz0, px1, 10, pz1, BM.LOUVER);                                              // plant room behind the screen
  for (let x = px0; x < px1; x += 4) M.box(x, 0, pz0 - 1, x + 1, 11, pz0, BM.METAL);
  M.box(px0, 10, pz0, px1, 11, pz1, BM.METAL);
  E.vox(C, M, tw.x0, y, tw.z0);
  E.vox(C, craneModel(Math.min(40, sw - 12)), tw.x0 + 6, y, tw.z0 + pz0 - 8);
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
  const n = Math.max(18, Math.min(40, spec.floors));
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
    Object.assign({}, slab, { h: hS, skin: skinBrutal(S), floating: true, soffit: BM.CONCRETE, noRoof: true }),
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
  const n = Math.min(50, Math.max(26, Math.round(spec.floors * (1 + R() * 0.3))));
  const total = (0.6 + R() * 1.0) * (R() < 0.5 ? 1 : -1), prof = pick(R, ['lin', 'ease', 'late']);
  const P = (t) => prof === 'lin' ? t : prof === 'ease' ? t * t * (3 - 2 * t) : t * t;
  const taper = R() < 0.4 ? 0.8 + R() * 0.1 : 1;
  const crown = pick(R, ['slope', 'spire', 'lantern']);
  const K = crown === 'slope' ? 5 + Math.floor(R() * 3) : 0;
  let pitch = accent === 'fins' ? pick(R, [5, 6]) : pick(R, [4, 5, 6]);
  while (n * 2 * (w0 + d0) / pitch > 3500) ++pitch;                                         // triangle budget
  const spand = R() < 0.5 ? BM.SPANDREL : edge, finD = accent === 'fins' ? 5 : 3;
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
// Mid-rise registry (downtown / old town 3-14 storey buildings): fn(E, C, W, D, spec, R, L) with
// spec { seed, floors, party:{l,r}, shops, corner, zone }. opts: { minW, maxW (metres), minFloors, maxFloors, zones:['mid','row','core'] }
// Suburban lots also pass spec.use (gas | strip | diner | store | mixed | apartments | townhouse): types registered with
// opts.uses (or, without it, named after the use) are preferred for it.
const MIDS = [];
function registerMid(name, fn, opts) { MIDS.push(Object.assign({ name, fn, minW: 8, maxW: 60, minFloors: 2, maxFloors: 16, zones: ['mid', 'core', 'row'] }, opts || {})); }
let midDecks = {}, MID_LOG = [];
registerMid('classic_mid', (E, C, W, D, spec) => buildMid(E, W, D, spec, C), { zones: ['mid', 'core'], minW: 10 });
registerMid('classic_rows', (E, C, W, D, spec) => buildRows(E, W, D, spec, C), { zones: ['row'], maxFloors: 5 });
// House registry (suburbs): fn(E, C, W, D, spec, R, L) builds a detached / semi-detached house on a W x D voxel
// footprint (front at z = 0, facing the street). spec { seed, floors, garage, setback (voxels to the sidewalk), style hint,
// lot: { w, d, front, back } in metres }. opts { minW, maxW (m), minD, maxD, floors: [min,max], weight }.
var HOUSES = [];
function registerHouse(name, fn, opts) { HOUSES.push(Object.assign({ name, fn, minW: 6, maxW: 30, minD: 6, maxD: 30, weight: 1 }, opts || {})); }
var HOUSE_LOG = [];
function buildHouseAny(E, W, D, spec, C) {
  const wm = W * BV, dm = D * BV;
  const fits = HOUSES.filter(h => wm >= h.minW && wm <= h.maxW && dm >= h.minD && dm <= h.maxD);
  if (!fits.length) { HOUSE_LOG.push({ type: 'classic_house' }); return buildHouse(E, W, D, spec, C); }
  const R = C.mulberry32(spec.seed ^ 0x2545f491);
  let t = R() * fits.reduce((a, h) => a + h.weight, 0), h = fits[0];
  for (const x of fits) { t -= x.weight; if (t <= 0) { h = x; break; } }
  HOUSE_LOG.push({ type: h.name });
  h.fn(E, C, W, D, spec, C.mulberry32(spec.seed), LIB);
  return h.name;
}
// Deck dealing is a plan-time pre-pass (assignTypes, in global job order), so a building's type never depends on
// which other buildings a tile happens to build: chooseMid / dealTower pop the decks, buildMidAny / buildTower take
// the pre-dealt choice from spec.pre (and only deal themselves when called without one, e.g. previews).
function chooseMid(W, spec, C, zone) {
  const wm = W * BV;
  let fits = MIDS.filter(m => m.zones.includes(zone) && wm >= m.minW && wm <= m.maxW);
  // prefer types whose storey range contains the requested height (keeps old town low, avenues tall)
  const hfit = fits.filter(m => spec.floors >= m.minFloors && spec.floors <= m.maxFloors);
  if (hfit.length) fits = hfit;
  if (spec.use) {                     // suburban lots: prefer types registered for this use (opts.uses), or named after it
    const uf = fits.filter(m => m.uses ? m.uses.includes(spec.use) : m.name.includes(spec.use));
    if (uf.length) fits = uf;
  }
  if (!fits.length) return null;
  const key = zone + ':' + fits.map(m => m.name).join(',');
  let deck = midDecks[key];
  if (!deck || !deck.length) {
    deck = midDecks[key] = fits.slice();
    const Rd = C.mulberry32(spec.seed ^ 0x51ed27);
    for (let i = deck.length - 1; i > 0; --i) { const j = Math.floor(Rd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  }
  return deck.pop();
}
function buildMidAny(E, W, D, spec, C, zone) {
  const m = spec.pre ? spec.pre.m : chooseMid(W, spec, C, zone);
  if (!m) { if (zone === 'row') buildRows(E, W, D, spec, C); else buildMid(E, W, D, spec, C); return zone === 'row' ? 'classic_rows' : 'classic_mid'; }
  const floors = Math.max(m.minFloors, Math.min(m.maxFloors, spec.floors));
  MID_LOG.push({ type: m.name, zone, floors });
  const s2 = Object.assign({}, spec, { floors, zone }); delete s2.pre;
  m.fn(E, C, W, D, s2, C.mulberry32(spec.seed), LIB);
  return m.name;
}
function dealTower(spec, C) {
  if (!towerDeck.length) {                                         // deal the next round of designs
    const order = TOWERS.filter(t => !(t.unique && usedUnique.has(t.name)));
    const Rd = C.mulberry32((spec.seed ^ 0x9e3779b9) + dealt++);
    for (let i = order.length - 1; i > 0; --i) { const j = Math.floor(Rd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    towerDeck = order;
  }
  const t = towerDeck.pop();
  if (t.unique) usedUnique.add(t.name);
  return t;
}
function buildTower(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed);
  const t = spec.pre ? spec.pre.t : dealTower(spec, C);
  TOWER_LOG.push({ type: t.name, x: E.O[0] + (W / 2) * BV * E.e1[0] + (D / 2) * BV * E.e2[0], z: E.O[1] + (W / 2) * BV * E.e1[1] + (D / 2) * BV * E.e2[1], floors: spec.floors });
  const s2 = Object.assign({}, spec); delete s2.pre;
  t.fn(E, C, W, D, s2, R, LIB);
  return t.name;
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
  constructor(b) { this.c = 0.5; this.x0 = b.x0 - 10; this.z0 = b.z0 - 10; this.nx = Math.ceil((b.x1 - b.x0 + 20) / this.c); this.nz = Math.ceil((b.z1 - b.z0 + 20) / this.c); this.g = new Uint8Array(this.nx * this.nz); this.ang = new Uint8Array(this.nx * this.nz); }
  // oriented rectangle: origin O, axes e1/e2, extents [a0,a1] x [b0,b1] (metres).
  // mark: false -> returns the covered fraction; true -> marks with 1; a number -> marks with that value
  // (1 block buildings, 2 houses, 3+ one value per street pass of an irregular block).
  // foreign (a predicate on non-zero values and the marked frame angle): returns the number of covered cells it
  // accepts instead. ang: frame angle (degrees mod 90) stored with a mark.
  rect(O, e1, e2, a0, a1, b0, b1, mark, foreign, ang) {
    const pts = [[a0, b0], [a1, b0], [a0, b1], [a1, b1]].map(([a, b]) => [O[0] + a * e1[0] + b * e2[0], O[1] + a * e1[1] + b * e2[1]]);
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - this.x0) / this.c)), i1 = Math.min(this.nx - 1, Math.ceil((Math.max(...xs) - this.x0) / this.c));
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - this.z0) / this.c)), j1 = Math.min(this.nz - 1, Math.ceil((Math.max(...zs) - this.z0) / this.c));
    const val = mark === true ? 1 : mark || 0;
    let inside = 0, hit = 0;
    for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) {
      const x = this.x0 + (i + 0.5) * this.c - O[0], z = this.z0 + (j + 0.5) * this.c - O[1];
      const a = x * e1[0] + z * e1[1], b = x * e2[0] + z * e2[1];
      if (a < a0 || a > a1 || b < b0 || b > b1) continue;
      ++inside;
      const k = j * this.nx + i, g = this.g[k];
      if (foreign) { if (g && foreign(g, this.ang[k])) ++hit; continue; }
      if (g) ++hit;
      if (val) { this.g[k] = val; if (ang !== undefined) this.ang[k] = ang; }
    }
    return foreign ? hit : inside ? hit / inside : 0;
  }
  at(x, z) {
    const i = Math.floor((x - this.x0) / this.c), j = Math.floor((z - this.z0) / this.c);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? 0 : this.g[j * this.nx + i];
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

// ================================================================================================ suburbs (phase 3)
// Land use and lots for the residential quarter: every block the block placer leaves to the suburbs (most frontage
// on residential streets). Deterministic per seed.
//  1. Faces. A block (connected buildable land between streets) has one face per street side it fronts (a run of
//     frontage along one road) and one per cul-de-sac bulb.
//  2. Land use, decided per block; one block face never mixes houses with anything else:
//     - transition: blocks that face downtown / old town across a through street (Division, Grand). Mixed-use 2-3
//       storey main-street buildings (attached, at the sidewalk) on the faces towards the city (garden apartments
//       where the city across is farther from the core), garden apartments on the other through streets,
//       townhouse terraces on the local streets: a step down in height and grain from the mid-rises to the houses;
//     - commercial: blocks at a junction of an arterial with another through street, away from the city: a gas
//       station on the corner, a strip mall / diner / corner store along the arterial. Small blocks and blocks
//       mostly on arterials are commercial throughout (their local-street sides stay landscaped); larger blocks keep
//       houses on their other faces, backing onto the commercial lots across fenced rear lines;
//     - residential: detached houses on every face, pie lots around cul-de-sac bulbs.
//  3. Lots. Faces are cut into lot rectangles (house lots 15-18 m, equal widths along one face, corner lots wider),
//     square to the street (on curves each lot takes the chord of its frontage, set back by the sagitta). Lots take
//     their frontage in priority order (commercial and main street first: they own their corners; then terraces and
//     apartments; then cul-de-sac bulbs, houses on the long faces, the rest), then grow back towards the middle of
//     the block in 0.5 m steps, round robin, until they meet the lot behind (rear lot lines meet back to back) or
//     reach the depth cap of their use. Lots never overlap (exact rectangle tests) and stay on block land.
//  4. Buildings: houses (buildHouseAny) at a common setback per face with side yards and a driveway side (paired
//     along the face, away from the side street on corner lots); commercial / transition buildings become jobs
//     built by buildMidAny (zones 'commercial' / 'transition', spec.use = gas | strip | diner | store | mixed |
//     apartments | townhouse; a plain fallback builds them while no plug-in fits). Every lot is dressed by
//     L.yardKit in its lot frame, with the neighbour flags of the lot ownership rule (towers/AGENT_BRIEF.md).
const SUB_FRONT = 0.4;                        // lot front line: back of sidewalk + 0.4 m (block land starts 0.3 m in)
const SUB_USE = {        // metres: frontage range, min frontage, min / initial depth, depth cap
  house:      { w: [15, 18.5], minW: 12, minD: 14, cap: 40 },
  bulb:       { w: [13, 15], minW: 11, minD: 14, cap: 26 },
  townhouse:  { w: [24, 34], minW: 15, minD: 22, cap: 34 },
  apartments: { w: [30, 40], minW: 22, minD: 24, cap: 38 },
  mixed:      { w: [10, 19], minW: 8, minD: 16, cap: 28 },
  gas:        { w: [30, 36], minW: 26, minD: 26, cap: 36 },
  strip:      { w: [44, 76], minW: 36, minD: 30, cap: 46 },
  diner:      { w: [22, 30], minW: 22, minD: 24, cap: 38 },
  store:      { w: [18, 26], minW: 18, minD: 22, cap: 34 }
};
const SUB_COMMERCIAL = new Set(['gas', 'strip', 'diner', 'store']);
// polyline helpers with smooth tangents (vertex tangents interpolated along each segment)
function roadGeo(r) {
  if (r._geo && r._geo.pts === r.pts) return r._geo;
  const pts = r.pts, n = pts.length, cum = [0], seg = [];
  for (let i = 0; i + 1 < n; ++i) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz);
    cum.push(cum[i] + l); seg.push(l > 1e-9 ? [dx / l, dz / l] : (seg[i - 1] || [1, 0]));
  }
  const vt = pts.map((_, i) => {
    const a = seg[Math.max(0, i - 1)], b = seg[Math.min(seg.length - 1, i)], x = a[0] + b[0], z = a[1] + b[1], l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  });
  return (r._geo = { pts, cum, seg, vt, len: cum[n - 1] });
}
function roadAt(r, s) {                       // [x, z, tx, tz]; extrapolates straight beyond the ends
  const G = roadGeo(r), n = G.pts.length;
  let i = 0;
  while (i < n - 2 && G.cum[i + 1] < s) ++i;
  const l = G.cum[i + 1] - G.cum[i] || 1, f = (s - G.cum[i]) / l, t = G.seg[i];
  const p = G.pts[i];
  if (f < 0 || f > 1) return [p[0] + t[0] * (s - G.cum[i]), p[1] + t[1] * (s - G.cum[i]), t[0], t[1]];
  const a = G.vt[i], b = G.vt[i + 1], tx = a[0] + (b[0] - a[0]) * f, tz = a[1] + (b[1] - a[1]) * f, tl = Math.hypot(tx, tz) || 1;
  return [p[0] + t[0] * (s - G.cum[i]), p[1] + t[1] * (s - G.cum[i]), tx / tl, tz / tl];
}
function roadProject(r, x, z) {               // { s, u }: arc length and signed offset (+ left of the road direction)
  const G = roadGeo(r);
  let best = 1e18, s = 0, u = 0;
  for (let i = 0; i + 1 < G.pts.length; ++i) {
    const [ax, az] = G.pts[i], l = G.cum[i + 1] - G.cum[i];
    if (l < 1e-9) continue;
    const [tx, tz] = G.seg[i];
    const t = Math.max(0, Math.min(l, (x - ax) * tx + (z - az) * tz)), qx = ax + tx * t, qz = az + tz * t, d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d < best) { best = d; s = G.cum[i] + t; u = -tz * (x - ax) + tx * (z - az); }
  }
  return { s, u };
}
// oriented rectangles { O, e1, e2, w, d } (metres): interiors overlap by more than tol on every separating axis
function rectsOverlap(A, B, tol) {
  for (const ax of [A.e1, A.e2, B.e1, B.e2]) {
    const pa = A.O[0] * ax[0] + A.O[1] * ax[1], pb = B.O[0] * ax[0] + B.O[1] * ax[1];
    const a1 = A.w * (A.e1[0] * ax[0] + A.e1[1] * ax[1]), a2 = A.d * (A.e2[0] * ax[0] + A.e2[1] * ax[1]);
    const b1 = B.w * (B.e1[0] * ax[0] + B.e1[1] * ax[1]), b2 = B.d * (B.e2[0] * ax[0] + B.e2[1] * ax[1]);
    const amin = pa + Math.min(0, a1) + Math.min(0, a2), amax = pa + Math.max(0, a1) + Math.max(0, a2);
    const bmin = pb + Math.min(0, b1) + Math.min(0, b2), bmax = pb + Math.max(0, b1) + Math.max(0, b2);
    if (amax - bmin <= tol || bmax - amin <= tol) return false;
  }
  return true;
}
function planSuburbs(PL, C, blocks) {
  const net = PL.net, roads = net.roads, lab = blocks.lab, nx = PL.nx, nz = PL.nz, cell = PL.cell;
  const core = (net.origins && net.origins.core) || [0, 0];
  const seed0 = (PL.seed || 1) >>> 0;
  const idxAt = (x, z) => { const i = Math.floor((x - PL.x0) / cell), j = Math.floor((z - PL.z0) / cell); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
  const regions = [];
  for (const g of blocks.regs) {
    if (blocks.handled.has(g.id) || g.area < 300) continue;
    let res = 0, tot = 0;
    for (const [rid, cells] of g.front) { const r = roads[rid]; if (r.P.id === 'alley') continue; tot += cells.length; if (r.district === 'residential') res += cells.length; }
    if (tot && res >= tot * 0.5) regions.push(g);
  }
  // ---- faces
  const faceAt = (f, t) => {                     // [x, z, nx, nz]: lot front line point, inward normal
    if (f.kind === 'bulb') { const a = t / f.rb, c = Math.cos(a), s = Math.sin(a); return [f.c[0] + c * f.rb, f.c[1] + s * f.rb, c, s]; }
    const p = roadAt(f.road, t), qx = -p[3] * f.side, qz = p[2] * f.side;
    return [p[0] + qx * f.uF, p[1] + qz * f.uF, qx, qz];
  };
  const facesOf = (g) => {
    const out = [];
    for (const [rid, cells] of g.front) {
      const r = roads[rid];
      if (r.P.id === 'alley' || !r.len) continue;
      const P = r.P, G = roadGeo(r), uF = P.half + P.sidewalk + SUB_FRONT;
      const bc = r.bulbEnd ? r.pts[r.pts.length - 1] : null, rb = r.bulbEnd ? r.bulbEnd + P.sidewalk + SUB_FRONT : 0;
      const side = { 1: [], '-1': [] }, bulb = [];
      for (const q of cells) {
        const x = PL.x0 + (q % nx + 0.5) * cell, z = PL.z0 + (((q / nx) | 0) + 0.5) * cell, pr = roadProject(r, x, z);
        if (bc && pr.s > G.len - r.bulbEnd - 3 && Math.hypot(x - bc[0], z - bc[1]) < rb + 3) bulb.push(Math.atan2(z - bc[1], x - bc[0]));
        else side[pr.u >= 0 ? 1 : -1].push(pr.s);
      }
      for (const sd of [1, -1]) {
        const ss = side[sd].sort((a, b) => a - b);
        if (ss.length < 8) continue;
        let a = ss[0], prev = ss[0];
        const flush = (b) => { if (b - a >= 4) out.push({ g, road: r, rid, kind: 'side', side: sd, uF, t0: a, t1: b, rank: RANK[P.cls] }); };
        for (const s of ss) { if (s - prev > 5) { flush(prev); a = s; } prev = s; }
        flush(prev);
      }
      if (bulb.length >= 8) {
        bulb.sort((a, b) => a - b);
        let gi = 0, gmax = bulb[0] + 2 * Math.PI - bulb[bulb.length - 1];
        for (let i = 1; i < bulb.length; ++i) if (bulb[i] - bulb[i - 1] > gmax) { gmax = bulb[i] - bulb[i - 1]; gi = i; }
        const un = bulb.slice(gi).concat(bulb.slice(0, gi).map(a => a + 2 * Math.PI));
        let a = un[0], prev = un[0];
        const flush = (b) => { if ((b - a) * rb >= 4) out.push({ g, road: r, rid, kind: 'bulb', c: bc, rb, t0: a * rb, t1: b * rb, rank: 1 }); };
        for (const t of un) { if ((t - prev) * rb > 5) { flush(prev); a = t; } prev = t; }
        flush(prev);
      }
    }
    for (const f of out) f.len = f.t1 - f.t0;
    return out;
  };
  // what lies across the street from a face: 'urban' (a block of the block placer), 'sub', 'open', 'none'
  const across = (f) => {
    if (f.kind === 'bulb') return 'sub';
    const votes = {};
    for (const k of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      const [x, z, qx, qz] = faceAt(f, f.t0 + k * f.len);
      let v = 'none';
      for (let off = f.uF; off < 2 * f.uF + 16; off += 0.5) {     // across the carriageway to the first land
        const i = idxAt(x - qx * off, z - qz * off);
        if (i < 0) break;
        if (PL.base[i] === 1 && lab[i] !== f.g.id) { v = blocks.handled.has(lab[i]) ? 'urban' : 'sub'; break; }
        if (PL.base[i] === 2) { v = 'open'; break; }
      }
      if (v !== 'none') votes[v] = (votes[v] || 0) + 1;              // junctions / alley mouths across: no vote
    }
    const pr = { urban: 3, open: 2, sub: 1 };
    return Object.keys(votes).sort((a, b) => votes[b] - votes[a] || pr[b] - pr[a])[0] || 'none';
  };
  const ends = (f) => [faceAt(f, f.t0), faceAt(f, f.t1)];
  const near = (p, q, d) => Math.hypot(p[0] - q[0], p[1] - q[1]) < d;
  // ---- land use per block
  const B = regions.map(g => {
    const faces = facesOf(g);
    for (const f of faces) f.across = across(f);
    const per = faces.reduce((a, f) => a + f.len, 0);
    const urban = faces.filter(f => f.across === 'urban' && f.rank >= 2).reduce((a, f) => a + f.len, 0);
    const art = faces.filter(f => f.rank >= 3).reduce((a, f) => a + f.len, 0);
    const dc = Math.hypot(g.mx - core[0], g.mz - core[1]) / (net.zoneScale || 1);
    // corners between an arterial face and another through-street face (score: arterial x arterial > collector)
    let corner = 0;
    for (const f of faces) for (const h of faces) {
      if (f === h || f.rank < 3 || h.rank < 2 || f.rid === h.rid || f.len < 25) continue;
      if (ends(f).some(p => ends(h).some(q => near(p, q, 24)))) corner = Math.max(corner, h.rank >= 3 ? 2 : 1);
    }
    return { g, faces, per, urban, art, dc, corner, use: 'residential' };
  });
  const isCommercialSite = (b) => b.corner && b.art >= 30 && !(b.urban >= 30 && b.dc < 280);
  const cand = B.filter(isCommercialSite).sort((a, b) => (b.corner * 100 + b.art) - (a.corner * 100 + a.art) || a.g.id - b.g.id);
  // a commercial corner is a local decision (streaming pages never see the whole map): every arterial x arterial site,
  // and a hashed share of the arterial x collector ones (was: the best 3 x scale sites of the whole map)
  if (PL.pageMode) cand.forEach(b => { if (b.corner >= 2 || C.hash2(b.g.sid, 17, seed0 + 911) < 0.35) b.use = 'commercial'; });
  else {
    const K = Math.max(1, Math.min(3 * Math.round(net.plan ? net.plan.scale : 1), Math.round(B.length / 4)));
    cand.slice(0, K).forEach(b => { b.use = 'commercial'; });
  }
  for (const b of B) if (b.use === 'residential' && b.urban >= 30 && b.dc < 275) b.use = 'transition';   // farther out: houses
  for (const b of B) {
    const whole = b.use === 'commercial' && (b.g.area < 2500 || b.art >= 0.45 * b.per);
    const maxHouse = Math.max(0, ...b.faces.filter(f => f.kind === 'side').map(f => f.len));
    for (const f of b.faces) {
      if (b.use === 'transition') f.use = f.rank >= 3 || (f.across === 'urban' && f.rank >= 2) ? (b.dc < 255 ? 'mixed' : 'apartments') : f.rank >= 2 ? 'apartments' : 'townhouse';
      else if (b.use === 'commercial') f.use = f.rank >= 3 || (whole && f.rank >= 2) ? 'commercial' : whole ? 'none' : 'house';
      else f.use = 'house';
      f.group = f.use === 'commercial' || f.use === 'mixed' ? 0 : f.use === 'apartments' || f.use === 'townhouse' ? 1 :
        f.use === 'none' ? -1 : f.kind === 'bulb' ? 2 : f.len >= 0.6 * maxHouse ? 3 : 4;
      const Rf = C.mulberry32((b.g.sid * 7919 + f.rid * 104729 + Math.round(f.t0) * 31 + seed0 * 977) >>> 0);
      f.R = Rf;
      f.setback = f.use === 'house' ? 5.5 + Rf() * 1.5 : f.use === 'townhouse' ? 4 + Rf() * 1 : f.use === 'apartments' ? 6 + Rf() * 1.5 : 0;
      const U = SUB_USE[f.kind === 'bulb' ? 'bulb' : f.use] || SUB_USE.house;
      f.target = U.w[0] + Rf() * (U.w[1] - U.w[0]);
      // grown maps: exurban / rural-edge houses get larger lots (wider, deeper, set farther back)
      if (net.plan && f.use === 'house') {
        const [fx, fz, qx, qz] = faceAt(f, f.t0 + f.len / 2), zu = C.landUseAt(net, fx + qx * 12, fz + qz * 12);
        if (zu !== 'suburban' && zu !== 'transition' && zu !== 'commercial') {
          const h = C.hash2(b.g.sid, f.rid, seed0 + 4441);
          f.target *= f.kind === 'bulb' ? 1.35 : 1.5 + 0.3 * h; f.setback += 3 + 4 * h; f.capK = 1.45;
        }
      }
    }
  }
  // ---- lots
  const lots = [], byRegion = new Map();
  const regionLots = (g) => { let a = byRegion.get(g.id); if (!a) byRegion.set(g.id, a = []); return a; };
  const P = (L, a, b) => [L.O[0] + a * L.e1[0] + b * L.e2[0], L.O[1] + a * L.e1[1] + b * L.e2[1]];
  const inReg = (g, x, z) => { const i = idxAt(x, z); return i >= 0 && lab[i] === g.id; };
  const outFrac = (L, a0, a1, b0, b1) => {       // fraction of block-land samples (0.5 m) the rectangle misses
    let n = 0, out = 0;
    const na = Math.max(1, Math.round((a1 - a0) / 0.5)), nb = Math.max(1, Math.round((b1 - b0) / 0.5));
    for (let j = 0; j < nb; ++j) for (let i = 0; i < na; ++i) {
      const [x, z] = P(L, a0 + (i + 0.5) * (a1 - a0) / na, b0 + (j + 0.5) * (b1 - b0) / nb);
      ++n; if (!inReg(L.g, x, z)) ++out;
    }
    return out / n;
  };
  const clash = (L, a0, a1, b0, b1) => {
    const T = { O: P(L, a0, b0), e1: L.e1, e2: L.e2, w: a1 - a0, d: b1 - b0 };
    const [tx, tz] = P(L, (a0 + a1) / 2, (b0 + b1) / 2), tr = Math.hypot(a1 - a0, b1 - b0) / 2;
    for (const M of regionLots(L.g)) {
      if (M === L) continue;
      const mx = M.O[0] + (M.e1[0] * M.w + M.e2[0] * M.d) / 2, mz = M.O[1] + (M.e1[1] * M.w + M.e2[1] * M.d) / 2;
      if (Math.hypot(mx - tx, mz - tz) > tr + Math.hypot(M.w, M.d) / 2) continue;
      if (rectsOverlap(T, M, 0.02)) return true;
    }
    return false;
  };
  // probe at one front-line point: 0 free, 1 off the block (a street / corner), 2 taken by a lot
  const probe = (f, t) => {
    const [x, z, qx, qz] = faceAt(f, t);
    for (const dd of [0.35, 3, 8]) {
      const px = x + qx * dd, pz = z + qz * dd;
      if (!inReg(f.g, px, pz)) return 1;
      for (const M of regionLots(f.g)) {
        const dx = px - M.O[0], dz = pz - M.O[1];
        if (dx * dx + dz * dz > (M.w + M.d + 1) * (M.w + M.d + 1)) continue;
        const a = dx * M.e1[0] + dz * M.e1[1], b = dx * M.e2[0] + dz * M.e2[1];
        if (a > -0.05 && a < M.w + 0.05 && b > -0.05 && b < Math.max(M.d, M.minD) + 0.05) return 2;
      }
    }
    return 0;
  };
  const freeRuns = (f) => {
    const out = [], st = 0.25;
    let cur = null, last = 1;
    const tA = f.kind === 'bulb' ? f.t0 : f.t0 - 4, tB = f.kind === 'bulb' ? f.t1 : f.t1 + 4;
    for (let t = tA; t <= tB + 1e-6; t += st) {
      const c = probe(f, t);
      if (!c) { if (!cur) cur = { a: t, b: t, ca: last === 1 }; cur.b = t; }
      else if (cur) { cur.cb = c === 1; out.push(cur); cur = null; }
      last = c;
    }
    if (cur) { cur.cb = true; out.push(cur); }
    for (const r of out) {                       // keep 0.5 m off the side street at a corner
      if (r.ca && f.kind === 'side') r.a += 0.5;
      if (r.cb && f.kind === 'side') r.b -= 0.5;
      r.ca = r.ca && f.kind === 'side'; r.cb = r.cb && f.kind === 'side';
    }
    return out.filter(r => r.b - r.a > 0);
  };
  // which through street a corner at the run end turns onto: the best other face of the block ending near it
  const cornerRank = (f, t) => {
    const p = faceAt(f, t);
    let best = 0;
    for (const h of f.blk.faces) if (h.rid !== f.rid && ends(h).some(q => near(p, q, 22))) best = Math.max(best, h.rank);
    return best;
  };
  const widths = (len, f, use, R, run) => {      // lot frontages along one free run
    const U = SUB_USE[use];
    if (len < U.minW) return [];
    if (use === 'mixed') {
      const out = [];
      let rem = len;
      while (rem > 0) { let w = U.w[0] + R() * (U.w[1] - U.w[0]); if (rem - w < U.minW) w = rem; out.push(w); rem -= w; }
      return out;
    }
    let n = Math.max(1, Math.round(len / f.target));
    while (n > 1 && len / n < U.minW) --n;
    const wt = [];
    for (let i = 0; i < n; ++i) wt.push((i === 0 && run.ca) || (i === n - 1 && run.cb) ? 1.15 : 1);
    const s = wt.reduce((a, b) => a + b, 0);
    return wt.map(x => len * x / s);
  };
  const gasSites = [];
  const commercialWidths = (len, f, R, run) => {   // [use, width] along an arterial run: gas station on the corner
    const rA = run.ca ? cornerRank(f, run.a) : 0, rB = run.cb ? cornerRank(f, run.b) : 0;
    let gasAt = (rA >= 2 || rB >= 2) && len >= 28 ? (rA > rB || (rA === rB && R() < 0.5) ? 'a' : 'b') : null;
    if (gasAt) {                                 // at most two gas stations, never two within 160 m
      const [gx, gz] = faceAt(f, gasAt === 'a' ? run.a : run.b);
      if (gasSites.length >= 2 || gasSites.some(([x, z]) => Math.hypot(x - gx, z - gz) < 160)) gasAt = null;
    }
    let gas = gasAt ? Math.min(len, 30 + R() * 4) : 0, rem = len - gas;
    const mid = [], minS = SUB_USE.store.minW;
    while (rem >= minS) {
      let use, w;
      if (rem >= 44 && R() < 0.75) { use = 'strip'; w = Math.min(rem, 44 + R() * 32); }
      else if (rem >= 22) { use = R() < 0.6 ? 'diner' : 'store'; w = Math.min(rem, use === 'diner' ? 22 + R() * 8 : 18 + R() * 8); }
      else { use = 'store'; w = rem; }
      if (rem - w < minS) w = rem;
      mid.push([use, w]); rem -= w;
    }
    if (rem > 0) { if (mid.length) mid[mid.length - 1][1] += rem; else gas += rem; }
    if (!gasAt) return mid;
    return gasAt === 'a' ? [['gas', gas], ...mid] : [...mid, ['gas', gas]];
  };
  let nid = 0;
  const makeLot = (f, a, b, use, extra) => {
    const A = faceAt(f, a), Bp = faceAt(f, b), M = faceAt(f, (a + b) / 2);
    let e1 = [Bp[0] - A[0], Bp[1] - A[1]];
    const w0 = Math.hypot(e1[0], e1[1]);
    if (w0 < 1) return null;
    e1 = [e1[0] / w0, e1[1] / w0];
    let e2 = [-e1[1], e1[0]], O = [A[0], A[1]], flip = false;
    if (e2[0] * M[2] + e2[1] * M[3] < 0) { e1 = [-e1[0], -e1[1]]; e2 = [-e2[0], -e2[1]]; O = [Bp[0], Bp[1]]; flip = true; }
    const sag = (M[0] - O[0]) * e2[0] + (M[1] - O[1]) * e2[1];
    if (sag > 0) O = [O[0] + e2[0] * sag, O[1] + e2[1] * sag];
    const w = f.kind === 'side' && Math.abs(w0 - (b - a)) < 0.02 ? Math.round(w0 / BV) * BV : Math.floor(w0 / BV) * BV;
    const U = SUB_USE[use === 'house' && f.kind === 'bulb' ? 'bulb' : use];
    return Object.assign({ id: ++nid, g: f.g, f, use, O, e1, e2, w, d: 0, minD: U.minD, cap: U.cap * (f.capK || 1), flip, a, b, done: false }, extra || {});
  };
  const place = (L, minD) => {
    const U = minD || L.minD;
    for (let k = 0; k <= 6; ++k) {             // shave the sides a little when the frontage just misses
      const ins = k * 0.25;
      if (L.w - 2 * ins < SUB_USE[L.use === 'house' && L.f.kind === 'bulb' ? 'bulb' : L.use].minW) break;
      const T = Object.assign({}, L, { O: P(L, ins, 0), w: L.w - 2 * ins });
      if (outFrac(T, 0, T.w, 0, U) <= 0.04 && !clash(T, 0, T.w, 0, U)) { Object.assign(L, { O: T.O, w: T.w, d: U }); regionLots(L.g).push(L); lots.push(L); return true; }
    }
    return false;
  };
  const grow = (group) => {
    let any = true;
    while (any) {
      any = false;
      for (const L of group) {
        if (L.done) continue;
        if (L.d + 0.5 > L.cap + 1e-6 || outFrac(L, 0, L.w, L.d, L.d + 0.5) > 0.05 || clash(L, 0, L.w, L.d, L.d + 0.5)) { L.done = true; continue; }
        L.d += 0.5; any = true;
      }
    }
  };
  // a lot over [a, b] of a face; when it does not fit, the largest part of it that does (shortened from either end)
  const placeFlex = (f, a, b, use, extra, minD) => {
    const minW = SUB_USE[use === 'house' && f.kind === 'bulb' ? 'bulb' : use].minW;
    for (let k = 0; b - a - k >= minW - 1e-6; k += 1) {
      for (const [a1, b1] of k ? [[a, b - k], [a + k, b]] : [[a, b]]) {
        const L = makeLot(f, a1, b1, use, Object.assign({}, extra, { ca: extra.ca && a1 === a, cb: extra.cb && b1 === b }));
        if (L && place(L, minD)) return L;
      }
    }
    return null;
  };
  const allFaces = B.flatMap(b => b.faces.map(f => Object.assign(f, { blk: b })));
  // two rounds: the plan, then a fill round on frontage still free (shallower lots, no second gas station)
  for (const fill of [false, true]) for (const grp of [0, 1, 2, 3, 4]) {
    const fs = allFaces.filter(f => f.group === grp).sort((a, b) => b.len - a.len || a.g.id - b.g.id || a.rid - b.rid);
    const placed = [];
    for (const f of fs) {
      let k = fill ? 100 : 0;
      for (const run0 of freeRuns(f)) {
        const run = fill ? Object.assign({}, run0, { ca: false, cb: false }) : run0;
        const len = Math.floor((run.b - run.a) / BV) * BV;
        const seq = f.use === 'commercial' ? commercialWidths(len, f, f.R, run) : widths(len, f, f.use, f.R, run).map(w => [f.use, w]);
        let t = run.a;
        seq.forEach(([use, w], i) => {
          const a = t, b = i === seq.length - 1 ? run.a + len : Math.round((t + w - run.a) / BV) * BV + run.a;
          t = b;
          const U = SUB_USE[use === 'house' && f.kind === 'bulb' ? 'bulb' : use];
          const ex = { ca: i === 0 && run0.ca, cb: i === seq.length - 1 && run0.cb, k: k++ };
          let L = placeFlex(f, a, b, use, ex, fill && use !== 'house' ? Math.max(12, Math.round(U.minD * 0.7)) : 0);
          if (!L && use === 'gas') L = placeFlex(f, a, b, 'diner', ex, 0) || placeFlex(f, a, b, 'store', ex, 0);   // no room for the canopy
          if (L && L.use === 'gas') gasSites.push(faceAt(f, (a + b) / 2));
          if (L) placed.push(L);
        });
      }
    }
    grow(placed);
  }
  // ---- per lot: corner sides (lot frame: left = origin side), order along the face, seed, house layout; lots too
  // shallow for a house are given back to the lawn; then the neighbours of the lot ownership rule
  const order = new Map();
  for (const L of lots) {
    L.cornerL = L.flip ? !!L.cb : !!L.ca; L.cornerR = L.flip ? !!L.ca : !!L.cb;
    let a = order.get(L.f); if (!a) order.set(L.f, a = []); a.push(L);
  }
  for (const a of order.values()) a.sort((p, q) => p.a - q.a).forEach((L, i) => { L.k = i; });
  for (const L of lots) {
    L.seed = (L.g.sid * 7919 + L.f.rid * 104729 + L.k * 31337 + Math.round(L.a * 4) * 13 + seed0 * 7 + 0x51b) >>> 0;
    if (L.use === 'house') L.H = layoutHouse(L, C.mulberry32(L.seed), L.flip ? L.k + 1 : L.k);
  }
  const kept = lots.filter(L => L.use !== 'house' || L.H);
  lots.length = 0; lots.push(...kept);
  for (const [id, a] of byRegion) byRegion.set(id, a.filter(L => L.use !== 'house' || L.H));
  for (const L of lots) {
    const same = (M) => M !== L && M.f === L.f && Math.abs(M.e1[0] * L.e1[0] + M.e1[1] * L.e1[1]) > 0.99995 && (SUB_COMMERCIAL.has(M.use) === SUB_COMMERCIAL.has(L.use)) && (M.use === 'house') === (L.use === 'house');
    const touch = (M, a) => { const [x, z] = P(L, a, Math.min(L.d, M.d) * 0.5); const dx = x - M.O[0], dz = z - M.O[1], u = dx * M.e1[0] + dz * M.e1[1], v = dx * M.e2[0] + dz * M.e2[1]; return u > -0.06 && u < M.w + 0.06 && v > 0 && v < M.d; };
    const rl = regionLots(L.g);
    L.nb = { l: rl.some(M => same(M) && touch(M, -0.03)), r: rl.some(M => same(M) && touch(M, L.w + 0.03)), b: false };
    const back = { O: P(L, 0.3, L.d + 0.02), e1: L.e1, e2: L.e2, w: Math.max(0.1, L.w - 0.6), d: 0.8 };
    L.nb.b = rl.some(M => M !== L && rectsOverlap(back, M, 0.0));
  }
  const stats = { regions: B.length, uses: {}, blocks: {} };
  for (const b of B) stats.blocks[b.use] = (stats.blocks[b.use] || 0) + 1;
  for (const L of lots) stats.uses[L.use] = (stats.uses[L.use] || 0) + 1;
  stats.debug = B.map(b => ({ id: b.g.id, c: [Math.round(b.g.mx), Math.round(b.g.mz)], area: Math.round(b.g.area), use: b.use, dc: Math.round(b.dc), urban: Math.round(b.urban), art: Math.round(b.art), corner: b.corner,
    faces: b.faces.map(f => [f.road.name, f.kind, Math.round(f.len), f.across, f.rank, f.use, f.group, lots.filter(L => L.f === f).length].join('/')) }));
  return { regions: new Set(regions.map(g => g.id)), blocks: B, lots, stats, core };
}
// footprint of the building on a suburban lot (metres, lot frame) and its yard description
function houseFits(Wm, Dm) { return HOUSES.some(h => Wm >= h.minW && Wm <= h.maxW && Dm >= h.minD && Dm <= h.maxD); }
function layoutHouse(L, R, k) {
  const f = L.f, w = L.w, d = L.d, sy = 1.6, cx = 1.4;
  const sb = Math.min(f.setback, Math.max(4, d - 14.5));
  let side = (k % 2 === 0) ? 'r' : 'l';
  if (L.cornerL && !L.cornerR) side = 'r'; else if (L.cornerR && !L.cornerL) side = 'l';
  const xl = sy + (L.cornerL ? cx : 0), xr = w - sy - (L.cornerR ? cx : 0), avail = xr - xl;
  // footprint 10-16 m wide (garage wing included) x 9-13 m deep, a rear yard of at least 4.5 m
  let Dh = Math.min(9.5 + R() * 3.5, d - sb - 4.5);
  if (Dh < 7.5) Dh = Math.min(7.5, d - sb - 3);                 // shallow lot: smaller rear yard
  if (Dh < 6.5 || avail < 8) return null;
  let garage = HOUSES.length > 0 && avail >= 11 && R() < 0.75;
  let Wh = garage ? Math.min(avail, 12 + R() * 4) : Math.min(avail - 3.8, 10 + R() * 2.5);
  if (!garage && Wh < 8) { if (HOUSES.length && avail >= 10) { garage = true; Wh = avail; } else Wh = Math.min(avail, 9); }
  Wh = Math.round(Wh / BV) * BV;
  const reg = houseFits(Wh, Math.round(Dh / BV) * BV);
  if (!reg) garage = false;                       // the classic fallback house: no garage, driveway alongside
  let x0;
  if (garage) x0 = side === 'r' ? xr - Wh : xl;
  else x0 = side === 'r' ? xl : xr - Wh;
  x0 = Math.round(x0 / BV) * BV;
  let drive = null;
  if (garage) drive = side === 'r' ? [x0 + Wh - 3.4, x0 + Wh - 0.2] : [x0 + 0.2, x0 + 3.4];
  else if (side === 'r' && x0 + Wh + 3.7 <= w - 0.6) drive = [x0 + Wh + 0.6, x0 + Wh + 3.6];
  else if (side === 'l' && x0 - 3.7 >= 0.6) drive = [x0 - 3.6, x0 - 0.6];
  return { x0, z0: Math.round(sb / BV) * BV, w: Wh, d: Math.round(Dh / BV) * BV, garage, drive, side, reg };
}
// ---- fallbacks while the suburban plug-ins are stubs (towers/houses.js, yardkit.js, commercial.js)
// plain one-storey commercial building / gas station / parking lot, built only when no 'commercial' / 'transition'
// plug-in fits the lot
function flatQuad(E, x0, z0, x1, z1, y, m) { if (x1 - x0 > 0.01 && z1 - z0 > 0.01) E.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], m, [0, 1, 0]); }
function storeSkin(S) {
  return (len, side, front) => {
    const h = S.h, F = new Relief(len, h, 2, S.wall);
    if (front) {
      for (let u = 2; u < len - 2; u += S.bay) {
        const u1 = Math.min(len - 2, u + S.bay - 1);
        F.rect(u, 1, u1, h - 7, 1, H2(S.seed, u, 3) < 0.4 ? BM.GLASS_LIT : BM.STOREFRONT);
        F.rect(u1, 0, u1 + 1, h - 6, 3, S.trim);
      }
      F.rect(0, h - 6, len, h - 2, 3, S.sign);
      if (S.awning) F.rect(1, h - 8, len - 1, h - 6, 5, S.awning);
    } else if (!side) F.rect(Math.floor(len / 2) - 2, 0, Math.floor(len / 2) + 2, 9, 1, BM.DOOR_NAVY);
    F.rect(0, h - 2, len, h, 4, S.trim);
    F.returns();
    return F;
  };
}
function buildCommercialFallback(E, W, D, spec, C) {
  const R = C.mulberry32(spec.seed ^ 0x5eed);
  const use = spec.use || 'store';
  const S = { seed: spec.seed, h: 18, bay: 12 + Math.floor(R() * 6), wall: pick(R, [BM.PAINT_CREAM, BM.BUFF, BM.WHITE_CONCRETE, BM.BRICK_BROWN, BM.PAINT_SAGE]),
    trim: pick(R, [BM.TRIM, BM.TRIM_DARK]), sign: pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.TRIM_DARK]), awning: R() < 0.5 ? pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]) : 0 };
  if (use === 'gas') {
    // kiosk at the back, canopy over two pump islands, concrete forecourt
    const kw = Math.min(W - 8, 40), kd = Math.min(28, Math.floor(D * 0.35)), kx = W - 4 - kw, kz = D - 4 - kd;
    facades(E, kx, kz, kx + kw, kz + kd, 0, storeSkin(Object.assign({}, S, { awning: 0 })), C);
    flatRoof(E, kx, kz, kx + kw, kz + kd, S.h, S, C, { parapet: 1, parapetMat: S.trim, units: 0 });
    if (LIB.roofKit) LIB.roofKit(E, C, kx + 1, kz + 1, kx + kw - 1, kz + kd - 1, S.h, R, { style: 'industrial', floors: 1 });
    flatQuad(E, 0, 0, W, kz, 0.25, BM.CONCRETE); flatQuad(E, 0, kz, kx, D, 0.25, BM.CONCRETE);
    const cw = Math.min(W - 16, 64), cd = Math.min(kz - 14, 40), cx0 = Math.floor((W - cw) / 2), cz0 = Math.max(8, Math.floor((kz - cd) / 2));
    if (cd >= 16) {
      const M = new C_VoxModel(cw, 23, cd, 0, 0);
      M.box(0, 20, 0, cw, 23, cd, S.sign); M.box(1, 19, 1, cw - 1, 20, cd - 1, BM.WHITE_CONCRETE);
      for (const px of [6, cw - 8]) for (const pz of [Math.floor(cd / 2) - 7, Math.floor(cd / 2) + 5]) M.box(px, 0, pz, px + 2, 19, pz + 2, BM.WHITE_CONCRETE);
      for (const px of [6, cw - 8]) { M.box(px - 2, 0, Math.floor(cd / 2) - 9, px + 4, 1, Math.floor(cd / 2) + 9, BM.CONCRETE); M.box(px - 1, 1, Math.floor(cd / 2) - 2, px + 3, 7, Math.floor(cd / 2), BM.METAL); M.box(px - 1, 5, Math.floor(cd / 2) - 2, px + 3, 6, Math.floor(cd / 2), S.sign); }
      E.vox(C, M, cx0, 0, cz0);
    }
    return 'fallback_gas';
  }
  // strip mall / diner / store: building at the back, striped parking in front
  const bd = Math.min(D - 4, use === 'strip' ? 64 + Math.floor(R() * 12) : 48 + Math.floor(R() * 12)), bz = D - 2 - bd, bx = 2, bw = W - 4;
  facades(E, bx, bz, bx + bw, bz + bd, 0, storeSkin(S), C);
  flatRoof(E, bx, bz, bx + bw, bz + bd, S.h, S, C, { parapet: 1, parapetMat: S.trim, units: 0 });
  if (LIB.roofKit) LIB.roofKit(E, C, bx + 1, bz + 1, bx + bw - 1, bz + bd - 1, S.h, R, { style: 'office', floors: 1 });
  flatQuad(E, 0, bz - 8, W, bz, 0.25, BM.CONCRETE);                              // walk along the storefronts
  const pz0 = 4, pz1 = bz - 8;
  if (pz1 - pz0 >= 18) {                                                          // stalls 2.75 m, painted lines
    const sw = 11, row = Math.min(20, Math.floor((pz1 - pz0) / 2));
    let x = 2;
    flatQuad(E, 0, 0, W, pz0, 0.25, BM.CONCRETE);
    flatQuad(E, 0, pz0, 2, pz1, 0.25, BM.ROOF_TAR);
    while (x + sw + 2 <= W) {
      for (const [z0, z1] of [[pz0, pz0 + row], [pz1 - row, pz1]]) { flatQuad(E, x, z0, x + 0.5, z1, 0.25, BM.TRIM); flatQuad(E, x + 0.5, z0, x + sw, z1, 0.25, BM.ROOF_TAR); }
      flatQuad(E, x, pz0 + row, x + sw, pz1 - row, 0.25, BM.ROOF_TAR);
      x += sw;
    }
    flatQuad(E, x, pz0, W, pz1, 0.25, BM.ROOF_TAR);
  } else flatQuad(E, 0, 0, W, Math.max(0, bz - 8), 0.25, BM.CONCRETE);
  return 'fallback_' + use;
}
function buildSuburbAny(E, W, D, spec, C, zone) {
  const wm = W * BV;
  if (MIDS.some(m => m.zones.includes(zone) && wm >= m.minW && wm <= m.maxW)) return buildMidAny(E, W, D, spec, C, zone);
  if (zone === 'commercial') { const t = buildCommercialFallback(E, W, D, spec, C); MID_LOG.push({ type: t, zone, floors: 1 }); return t; }
  // transition fallback: rowhouse terraces / small mid-rises of the old town at 2-3 storeys
  const t = spec.use === 'townhouse' ? 'classic_rows' : 'classic_mid';
  if (t === 'classic_rows') buildRows(E, W, D, spec, C); else buildMid(E, W, D, spec, C);
  MID_LOG.push({ type: t, zone, floors: spec.floors });
  return t;
}
// minimal yard dressing while towers/yardkit.js is a stub: driveway, front walk, hedges on the owned lot lines
function yardFallback(E, C, lot, R, opts) {
  const W = lot.w, D = lot.d, h = lot.house, nb = opts.neighbours || {};
  if (lot.drive) flatQuad(E, lot.drive.x0, 0, lot.drive.x1, h ? Math.min(D - 2, h.z0 + (lot.garage ? 0 : (h.z1 - h.z0) * 0.6)) : 20, 0.25, BM.CONCRETE);
  if (h && opts.style !== 'commercial') { const c = (h.x0 + h.x1) >> 1; flatQuad(E, c - 2, 0, c + 2, Math.max(0, h.z0 - 10), 0.25, BM.CONCRETE); }
  const M = new C_VoxModel(W, 28, D, 0, 0), hm = opts.style === 'commercial' ? BM.LEAF : BM.LEAF_DARK;
  const zf = h ? Math.min(D - 4, h.z1) : 0;
  M.box(1, 0, D - 3, W - 1, 4, D - 1, hm);                                      // back line
  M.box(1, 0, zf, 3, 4, D - 1, hm);                                             // left line
  if (!nb.r) M.box(W - 3, 0, zf, W - 1, 4, D - 1, hm);                          // right line (nobody else draws it)
  if (h && opts.style !== 'commercial' && D - h.z1 >= 16 && W >= 24) addTree(M, Math.max(6, Math.min(W - 6, (h.x0 + h.x1) >> 1)), 0, Math.min(D - 7, h.z1 + 9), R, 0.9);
  E.vox(C, M, 0, 0, 0);
}
// houses and yards of the residential lots (emitted now), jobs for the transition / commercial lots
function emitSuburbs(sub, mb, hs, voxel, C, occ, addJob) {
  const lots = sub.lots, BVv = (m) => Math.round(m / BV);
  const P = (L, a, b) => [L.O[0] + a * L.e1[0] + b * L.e2[0], L.O[1] + a * L.e1[1] + b * L.e2[1]];
  let houses = 0;
  const yard = (L, lot, style, seed) => {
    const E = new Emitter(mb, L.O, L.e1, L.e2, hs, voxel);
    const opts = { style, neighbours: L.nb, seed };
    if (LIB.yardKit) LIB.yardKit(E, C, lot, C.mulberry32(seed ^ 0x9a4d), opts); else yardFallback(E, C, lot, C.mulberry32(seed ^ 0x9a4d), opts);
  };
  for (const L of lots) {
    const seed = L.seed;
    const Wl = Math.floor(L.w / BV + 1e-6), Dl = Math.floor(L.d / BV + 1e-6);
    const R = C.mulberry32(seed);
    if (L.use === 'house') {
      const H = L.H;
      let lot = { w: Wl, d: Dl, house: null, drive: null, garage: false };
      if (H) {
        const W = BVv(H.w), D = BVv(H.d), O = P(L, H.x0, H.z0);
        const E = new Emitter(mb, O, L.e1, L.e2, hs, voxel);
        const spec = { seed, floors: C.mulberry32(seed ^ 77)() < 0.6 ? 2 : 1, garage: H.garage, setback: H.reg ? BVv(H.z0) : 0,
          lot: { w: L.w, d: L.d }, side: H.side, corner: !!(L.cornerL || L.cornerR) };
        buildHouseAny(E, W, D, spec, C);
        if (occ) occ.rect(O, L.e1, L.e2, 0, H.w, 0, H.d, 2);
        lot = { w: Wl, d: Dl, house: { x0: BVv(H.x0), z0: BVv(H.z0), x1: BVv(H.x0) + W, z1: BVv(H.z0) + D }, drive: H.drive ? { x0: BVv(H.drive[0]), x1: BVv(H.drive[1]) } : null, garage: H.garage };
        ++houses;
      }
      yard(L, lot, L.cornerL || L.cornerR ? 'corner' : 'suburban', seed);
      continue;
    }
    // transition / commercial: the plug-in gets the whole lot (its own setbacks, gardens, parking and ground surface,
    // so no yard kit on top); attached neighbours (main street rows, a gas station next to a strip mall) become party
    // sides through the occupancy map in emitJobs
    const zone = SUB_COMMERCIAL.has(L.use) ? 'commercial' : 'transition';
    const cx = L.O[0] + L.e1[0] * L.w / 2 + L.e2[0] * L.d / 2, cz = L.O[1] + L.e1[1] * L.w / 2 + L.e2[1] * L.d / 2;
    const dcore = Math.hypot(cx - sub.core[0], cz - sub.core[1]);
    const floors = L.use === 'townhouse' ? (R() < 0.45 ? 3 : 2) : L.use === 'apartments' ? (dcore > 330 ? 2 : 3) :
      L.use === 'mixed' ? (dcore < 210 || R() < 0.5 ? 3 : 2) : 1;
    if (occ) occ.rect(L.O, L.e1, L.e2, 0, Wl * BV, 0, Dl * BV, 1);
    if (addJob) addJob(L.O, L.e1, L.e2, Wl, Dl, { kind: zone, floors, seed, use: L.use, zone, corner: !!(L.cornerL || L.cornerR), shops: L.use === 'mixed' || zone === 'commercial',
      lot: { w: L.w, d: L.d } });
  }
  return houses;
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
  const dc = Math.hypot(x - core[0], z - core[1]) / (net.zoneScale || 1);      // grown maps: the zones widen with the inner city
  const d = r.district;
  if (d === 'residential') return 'house';
  if (d === 'oldtown') return dc < 180 && r.P.cls !== 'local' ? 'mid' : 'row';
  if (dc < 172) return 'tower';
  if (dc < 230) return 'mid';
  return r.P.cls === 'arterial' ? 'mid' : 'row';
}
// ------------------------------------------------------------------------------------------------ block placement
// Downtown and old-town land is laid out block by block, like a real US city block. A block is a connected piece of
// buildable land between streets, alleys and open areas (Plots.base). In the frame of its main street:
//  - the largest rectangle of the block is cut into a front strip along the main street and a back strip along the
//    opposite street, each made of a corner lot at either end (its own building, wrapping onto the side street) and
//    mid-block lots of varied widths between; the two strips meet back to back, or, in deep blocks, side-street lots
//    close the ends and leave a small service court in the middle;
//  - on alley blocks every lot runs back to the alley: a deep building, or a front building, a yard and an
//    alley-facing rear building;
//  - land the rectangle misses (wedges on diagonal streets) is packed street by street, clear of other buildings.
// Lot edges are snapped to the voxel grid (0.25 m) of the block frame, so attached buildings are exactly flush; the
// buildings are never closer than 4 m otherwise. Heights follow the street (avenues taller), the distance to the
// core and a gentle walk along each strip.
const RANK = { arterial: 3, collector: 2, local: 1, alley: 0 };
const ZONE_LOTS = {     // metres: strip depth cap, min depth, min width, corner width range, frontage widths
  row:  { cap: 24, minD: 8, minW: 6.5, corner: [9, 15], width: (R) => R() < 0.6 ? 7 + R() * 5 : 11 + R() * 9 },
  mid:  { cap: 32, minD: 9, minW: 10, corner: [12, 22], width: (R) => 10 + Math.pow(R(), 1.2) * 21 },
  core: { cap: 34, minD: 12, minW: 12, corner: [16, 26], width: (R) => 14 + R() * 16 }
};
function blockRegions(PL) {
  const nx = PL.nx, nz = PL.nz, B = PL.base, N = PL.near, n = B.length, c = PL.cell;
  const lab = new Int32Array(n).fill(-1), regs = [], st = [];
  for (let i = 0; i < n; ++i) {
    if (B[i] !== 1 || lab[i] >= 0) continue;
    const id = regs.length, cells = [];
    lab[i] = id; st.push(i);
    while (st.length) {
      const q = st.pop(), x = q % nx; cells.push(q);
      if (x > 0 && B[q - 1] === 1 && lab[q - 1] < 0) { lab[q - 1] = id; st.push(q - 1); }
      if (x < nx - 1 && B[q + 1] === 1 && lab[q + 1] < 0) { lab[q + 1] = id; st.push(q + 1); }
      if (q >= nx && B[q - nx] === 1 && lab[q - nx] < 0) { lab[q - nx] = id; st.push(q - nx); }
      if (q + nx < n && B[q + nx] === 1 && lab[q + nx] < 0) { lab[q + nx] = id; st.push(q + nx); }
    }
    // seed id: hash of the region's first cell in scan order, in global plot-grid coordinates, so a block gets the same
    // seeds from the whole-map plan and from any streaming page whose window contains it (local ids follow scan order)
    const gx = (PL.gix || 0) + i % nx, gz = (PL.giz || 0) + ((i / nx) | 0);
    regs.push({ id, cells, sid: (Math.imul(gz + 1, 73856093) ^ Math.imul(gx + 1, 19349663)) >>> 8 });
  }
  for (const g of regs) {
    let mx = 0, mz = 0;
    const fr = new Map();                      // street id -> frontage cells
    for (const q of g.cells) {
      const x = q % nx, z = (q / nx) | 0; mx += x; mz += z;
      for (const r of [x > 0 ? q - 1 : -1, x < nx - 1 ? q + 1 : -1, z > 0 ? q - nx : -1, z < nz - 1 ? q + nx : -1]) {
        if (r < 0 || (B[r] !== 3 && B[r] !== 4)) continue;
        let a = fr.get(N[r]); if (!a) fr.set(N[r], a = []);
        a.push(q); break;
      }
    }
    g.mx = PL.x0 + (mx / g.cells.length + 0.5) * c; g.mz = PL.z0 + (mz / g.cells.length + 0.5) * c;
    g.area = g.cells.length * c * c;
    g.front = fr;
  }
  return { lab, regs };
}
// the region in a street-aligned frame (origin O, axes e1/e2) as a mask of 0.5 m cells; free: also clear of occ
function frameMask(PL, lab, g, O, e1, e2, occ) {
  const nx = PL.nx, nz = PL.nz, c = PL.cell;
  let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
  for (const q of g.cells) {
    const x = PL.x0 + (q % nx + 0.5) * c - O[0], z = PL.z0 + (((q / nx) | 0) + 0.5) * c - O[1];
    const a = x * e1[0] + z * e1[1], b = x * e2[0] + z * e2[1];
    if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  a0 = Math.floor(a0 / c) * c - c; b0 = Math.floor(b0 / c) * c - c; a1 += 2 * c; b1 += 2 * c;
  const w = Math.ceil((a1 - a0) / c), d = Math.ceil((b1 - b0) / c), mask = new Uint8Array(w * d);
  for (let j = 0; j < d; ++j) for (let i = 0; i < w; ++i) {
    const a = a0 + (i + 0.5) * c, b = b0 + (j + 0.5) * c;
    const x = O[0] + a * e1[0] + b * e2[0], z = O[1] + a * e1[1] + b * e2[1];
    const ix = Math.floor((x - PL.x0) / c), iz = Math.floor((z - PL.z0) / c);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz || lab[iz * nx + ix] !== g.id) continue;
    if (occ && occ.at(x, z)) continue;
    mask[j * w + i] = 1;
  }
  return { a0, b0, w, d, c, mask };
}
// largest axis-aligned rectangle of a mask (histogram method): { i0, i1, j0, j1 } in cells
function maxRect(mask, w, d) {
  const hgt = new Int32Array(w);
  let best = 0, R = null;
  for (let j = 0; j < d; ++j) {
    for (let i = 0; i < w; ++i) hgt[i] = mask[j * w + i] ? hgt[i] + 1 : 0;
    const st = [];
    for (let i = 0; i <= w; ++i) {
      const hh = i < w ? hgt[i] : 0;
      while (st.length && hgt[st[st.length - 1]] >= hh) {
        const top = st.pop(), hTop = hgt[top], left = st.length ? st[st.length - 1] + 1 : 0, area = hTop * (i - left);
        if (area > best) { best = area; R = { i0: left, i1: i, j0: j - hTop + 1, j1: j + 1 }; }
      }
      st.push(i);
    }
  }
  return R;
}
// what lies beyond one side of a block rectangle: samples just outside the side, first thing that is not this block
function sideKind(PL, lab, g, pts, out) {
  const nx = PL.nx, nz = PL.nz, c = PL.cell, roads = PL.net.roads;
  const votes = new Map();
  for (const [x, z] of pts) {
    let k = 'land', road = -1;
    for (const t of [0.75, 1.75, 3, 4.5]) {
      const ix = Math.floor((x + out[0] * t - PL.x0) / c), iz = Math.floor((z + out[1] * t - PL.z0) / c);
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) { k = 'open'; break; }
      const i = iz * nx + ix, b = PL.base[i];
      if (b === 1 && lab[i] === g.id) continue;
      if (b === 3 || b === 4) { road = PL.near[i]; k = roads[road].P.id === 'alley' || b === 4 ? 'alley' : 'street'; }
      else k = b === 2 ? 'open' : 'land';
      break;
    }
    const key = k + ':' + road;
    votes.set(key, (votes.get(key) || 0) + 1);
  }
  let best = null, bn = 0;
  for (const [k, v] of votes) if (v > bn) { bn = v; best = k; }
  const [type, rd] = best.split(':');
  const road = +rd >= 0 ? roads[+rd] : null;
  return { type, road, rank: type === 'street' ? RANK[road.P.cls] : type === 'open' ? 0.5 : 0 };
}
// split a run of len voxels into lot widths: optional corner lots at either end, varied widths between
function splitRun(len, R, Z, cwL, cwR) {
  const v = (m) => Math.max(1, Math.round(m / BV)), minW = v(Z.minW);
  if (len < 2 * minW) return [len];
  cwL = Math.min(cwL || 0, len); cwR = Math.min(cwR || 0, len - cwL);
  let mid = len - cwL - cwR;
  if (mid < minW && (cwL || cwR)) {                  // too short for a middle lot: the corner lots take it
    if (cwL && cwR) { const h = mid >> 1; cwL += h; cwR += mid - h; } else if (cwL) cwL += mid; else cwR += mid;
    mid = 0;
  }
  const out = [];
  if (cwL) out.push(cwL);
  let rem = mid;
  while (rem > 0) {
    let x = v(Z.width(R));
    if (rem - x < minW) x = rem;
    out.push(x); rem -= x;
  }
  if (cwR) out.push(cwR);
  return out;
}
// Lay out one block rectangle (W x D voxels; front side b = 0 on the main street). sides: { F, B, L, R } from
// sideKind. lot(a0, a1, b0, b1, face, props) places a lot (it trims against what is already placed).
function cutBlock(W, D, sides, zone, R, lot, dcore) {
  const Z = ZONE_LOTS[zone] || ZONE_LOTS.mid, v = (m) => Math.round(m / BV);
  const Dm = D * BV, Wm = W * BV;
  const st = (s) => s.type === 'street', strip = (s) => s.type === 'street' || s.type === 'open';
  const rnd = (r) => r[0] + R() * (r[1] - r[0]);
  // depth split between the front strip and the back strip (street or open space behind)
  let df = D, db = 0, court = 0;
  const backStrip = strip(sides.B) && Dm >= 2 * Math.max(Z.minD, 11);
  if (backStrip) {
    const share = Math.max(0.4, Math.min(0.62, 0.5 + 0.06 * (sides.F.rank - sides.B.rank)));
    let fm = Math.min(Z.cap, Dm * share), bm = Math.min(Z.cap, Dm - fm);
    if (Dm - fm - bm < 5) { fm += (Dm - fm - bm) / 2; bm = Dm - fm; }
    df = v(fm); db = D - df - v(Math.max(0, Dm - fm - bm));
    db = Math.max(0, Math.min(db, D - df));
    court = D - df - db;
  }
  // side-street lots close the ends of a deep block (around the service court)
  let dsL = 0, dsR = 0;
  if (court > 0) {
    const both = st(sides.L) && st(sides.R);
    let ds = Math.min(Z.cap, both ? Wm / 2 : Wm);
    if (Wm - (both ? 2 : 1) * ds < 5) ds = both ? Wm / 2 : Wm;
    if (st(sides.L)) dsL = v(ds);
    if (st(sides.R)) dsR = both ? W - dsL - Math.max(0, W - 2 * v(ds)) : v(ds);
    if (both && W - dsL - dsR < v(5)) dsR = W - dsL;
  }
  const corner = (s, ds) => st(s) ? (ds || v(Math.min(rnd(Z.corner), Wm / 2))) : 0;
  // towers (core blocks): a corner lot of the front strip, sometimes the opposite corner of the back strip
  // (both corners of a strip close to the centre)
  const towerAt = { F: {}, B: {} };
  if (zone === 'core' && Wm >= 24) {
    const k = st(sides.L) && (!st(sides.R) || R() < 0.5) ? 'L' : 'R', o = k === 'L' ? 'R' : 'L';
    towerAt.F[k] = true;
    if (Wm >= 50 && dcore < 120 && R() < 0.5) towerAt.F[o] = true;
    if (backStrip && db * BV >= 18) {
      if (R() < 0.85) towerAt.B[o] = true;
      if (Wm >= 50 && dcore < 120 && R() < 0.35) towerAt.B[k] = true;
    }
  }
  const alleyBack = sides.B.type === 'alley';
  // one strip of lots over [s0, s1] (block a); F runs left to right, B (facing the back street) right to left
  const run = (face, depth, s0, s1) => {
    const F = face === 'F', len = s1 - s0;
    if (len < v(Z.minW) * 0.7) return null;
    const atL = F ? s0 === 0 : s1 === W, atR = F ? s1 === W : s0 === 0;          // run start / end at a block corner
    let cwL = atL ? corner(F ? sides.L : sides.R, F ? dsL : dsR) : 0;
    let cwR = atR ? corner(F ? sides.R : sides.L, F ? dsR : dsL) : 0;
    const tw = towerAt[face], tl = !!tw[F ? 'L' : 'R'], tr = !!tw[F ? 'R' : 'L'];   // run start / end
    const tWidth = () => v(Math.min(Wm * (tl && tr ? 0.48 : 0.6), 24 + R() * 14));
    if (tl && atL) cwL = Math.max(cwL, tWidth());
    if (tr && atR) cwR = Math.max(cwR, tWidth());
    const ws = splitRun(len, R, Z, cwL, cwR);
    let a = 0;
    const through = [];
    ws.forEach((w, i) => {
      const isL = i === 0 && cwL > 0, isR = i === ws.length - 1 && cwR > 0, isCorner = isL || isR;
      const tower = (tl && isL && atL) || (tr && isR && atR) ||
        (zone === 'core' && !isCorner && w * BV >= 22 && depth * BV >= 20 && R() < 0.4);
      const a0 = F ? s0 + a : s1 - a - w, a1 = a0 + w;
      a += w;
      let d = depth, rear = 0;
      if (tower) {
        d = Dm <= 46 ? D : Math.min(v(46), Math.max(depth, v(18)));
        if (d === D) through.push([a0, a1]);
      } else if (F && !backStrip && Dm > Z.cap + 4) {
        // lots running back to an alley (or to land behind): deep building, or front building + yard (+ rear building)
        const p = R(), cap = Z.cap;
        if (alleyBack && w * BV >= 6 && Dm >= Z.minD + 13 && p < (isCorner ? 0.2 : 0.35)) {
          const rm = Math.min(12, Math.max(8, Dm - cap - 5)), ym = 4 + R() * 1.5;
          if (Dm - rm - ym >= Z.minD) { rear = v(rm); d = D - rear - v(ym); }
        } else if (Dm <= cap + 12 && p < 0.82) d = D;
        else d = v(Math.max(Z.minD, Math.min(cap, Dm - 4 - R() * 4)));
      }
      const pr = { corner: isCorner, tower, strip: face, idx: i };
      if (F) lot(a0, a1, 0, d, 'F', pr); else lot(a0, a1, D - d, D, 'B', pr);
      if (rear) lot(a0, a1, D - rear, D, 'B', { rear: true, strip: 'A', idx: i });
    });
    return through;
  };
  const thr = run('F', df, 0, W) || [];
  if (backStrip) {                                  // the back strip runs between towers that go through the block
    thr.sort((p, q) => p[0] - q[0]);
    let s0 = 0;
    for (const [t0, t1] of thr) { if (t0 > s0) run('B', db, s0, t0); s0 = Math.max(s0, t1); }
    if (s0 < W) run('B', db, s0, W);
  }
  // side-street lots between the strips
  for (const [k, ds] of [['L', dsL], ['R', dsR]]) {
    if (!ds) continue;
    const len = D - df - db;
    if (len < v(Z.minW)) continue;
    const ws = splitRun(len, R, Z, 0, 0);
    let b = df;
    ws.forEach((w, i) => {
      if (k === 'L') lot(0, ds, b, b + w, 'L', { strip: 'L', idx: i }); else lot(W - ds, W, b, b + w, 'R', { strip: 'R', idx: i });
      b += w;
    });
  }
  return { df, db, court };
}
// storeys of one lot: block base (zone, distance to the core) + street rank + corner + a gentle walk along the strip
function blockBase(zone, district, dc, R) {
  const cl = (x) => Math.max(0, Math.min(1, x));
  let b;
  if (zone === 'core') b = 10.5 - 2.5 * cl(dc / 160);
  else if (zone === 'mid') b = district === 'oldtown' ? 5.2 - 1.2 * cl((dc - 80) / 120) : 7.2 - 2.7 * cl((dc - 160) / 140);
  else b = district === 'oldtown' ? 3.8 - cl((dc - 120) / 220) : 4.2 - 0.8 * cl((dc - 230) / 150);
  return b + (R() - 0.5) * 1.2;
}
function lotFloors(zone, road, pr, base, walk, R) {
  const rk = road ? RANK[road.P.cls] : 0;
  let f = base + walk;
  if (zone === 'row') f += (rk >= 3 ? 1 : rk === 2 ? 0.5 : 0) + (pr.corner ? 0.6 : 0);
  else f += (rk >= 3 ? 1.5 : rk === 2 ? 0.6 : 0) + (pr.corner ? 0.7 : 0) + (R() < 0.06 ? 2 + R() * 1.5 : 0);
  const lim = zone === 'row' ? [2, 6] : zone === 'core' ? [7, 16] : [3, 12];
  return Math.max(lim[0], Math.min(lim[1], Math.round(f)));
}
// Lay out every downtown / old-town block; addJob(O, e1, e2, W, D, props) with W, D in voxels (front at z = 0).
// Residential blocks (most frontage on residential streets) are left to the subdivisions and house rows.
const frameAngle = (e1) => Math.round(((Math.atan2(e1[1], e1[0]) * 180 / Math.PI) % 90 + 90) % 90) % 90;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); };
function placeBlocks(PL, C, occ, addJob) {
  const net = PL.net, roads = net.roads, core = (net.origins && net.origins.core) || [0, 0];
  const { lab, regs } = blockRegions(PL);
  const handled = new Set(), stats = { blocks: 0, rect: 0, packed: 0, lots: 0 };
  const zkey = (z) => z === 'tower' ? 'core' : z === 'house' ? 'row' : z;
  let pass = 3;
  for (const g of regs) {
    if (g.area < 120) continue;
    let best = -1, bs = -1, res = 0, tot = 0;
    for (const [rid, cells] of g.front) {
      const r = roads[rid]; if (r.P.id === 'alley') continue;
      const sc = cells.length * (1 + RANK[r.P.cls]);
      tot += cells.length; if (r.district === 'residential') res += cells.length;
      if (sc > bs) { bs = sc; best = rid; }
    }
    if (best < 0 || res >= tot * 0.5) continue;
    handled.add(g.id); stats.blocks++;
    const dcB = Math.hypot(g.mx - core[0], g.mz - core[1]) / (net.zoneScale || 1);
    const rzone = zkey(zoneOf(net, roads[best], g.mx, g.mz));
    const district = roads[best].district;
    const Rb = C.mulberry32((g.sid * 2654435761 ^ (PL.seed * 40503)) >>> 0);
    const base = blockBase(rzone, district, dcB, Rb);
    const walks = {};
    // one lot -> one job (world frame), with its storeys and type
    const emitLot = (O, e1, e2, W, D, road, pr, markVal) => {
      const wm = W * BV, dm = D * BV;
      // overlap test inset by 0.3 m: cells on a shared edge belong to both flush neighbours
      if (occ.rect(O, e1, e2, 0.3, wm - 0.3, 0.3, dm - 0.3, false) > 0.02) return false;
      if (occ.rect(O, e1, e2, -4, wm + 4, -4, dm + 4, false, (v) => v === 2)) return false;   // clear of houses
      const cx = O[0] + e1[0] * wm / 2 + e2[0] * dm / 2, cz = O[1] + e1[1] * wm / 2 + e2[1] * dm / 2;
      const zone = pr.rear ? 'row' : road ? zkey(zoneOf(net, road, cx, cz)) : rzone;
      const zb = zone === rzone ? base : blockBase(zone, road ? road.district : district, Math.hypot(cx - core[0], cz - core[1]), Rb);
      const wk = walks[pr.strip] = Math.max(-1.5, Math.min(1.5, (walks[pr.strip] || 0) + [-1, 0, 0, 1][Math.floor(Rb() * 4)]));
      const seed = (g.sid * 7919 + (pr.strip || 'X').charCodeAt(0) * 104729 + (pr.idx || 0) * 31337 + PL.seed * 977) >>> 0;
      const Rl = C.mulberry32(seed ^ 0x2545f491);
      let kind, floors;
      if (pr.tower && wm >= 18 && dm >= 18) {
        kind = 'tower';
        floors = Math.min(44, 18 + Math.floor(Rl() * Rl() * 26) + Math.round(6 * Math.max(0, 1 - Math.hypot(cx - core[0], cz - core[1]) / 160)));
      } else if (pr.rear) { kind = 'row'; floors = 2 + (Rl() < 0.35 ? 1 : 0); }
      else { kind = zone === 'row' ? 'row' : 'mid'; floors = lotFloors(zone, road, pr, zb, wk, Rl); }
      occ.rect(O, e1, e2, 0, wm, 0, dm, markVal, undefined, frameAngle(e1));
      addJob(O, e1, e2, W, D, { kind, floors, seed, zone: zone === 'core' ? 'core' : zone === 'row' ? 'row' : 'mid',
        tag: g.sid + ':' + pr.strip + (pr.idx || 0), corner: !!pr.corner, shops: !pr.rear && !!road && (RANK[road.P.cls] >= 2 || !!pr.corner || zone === 'core') });
      stats.lots++;
      return true;
    };
    // main street frame
    const fc = g.front.get(best);
    let fx = 0, fz = 0;
    for (const q of fc) { fx += q % PL.nx; fz += (q / PL.nx) | 0; }
    fx = PL.x0 + (fx / fc.length + 0.5) * PL.cell; fz = PL.z0 + (fz / fc.length + 0.5) * PL.cell;
    const [tx, tz] = PL.tangentNear(roads[best], fx, fz);
    let E1 = [tx, tz], E2 = [-tz, tx];
    if ((g.mx - fx) * E2[0] + (g.mz - fz) * E2[1] < 0) { E1 = [-E1[0], -E1[1]]; E2 = [-E2[0], -E2[1]]; }
    const fm = frameMask(PL, lab, g, [fx, fz], E1, E2, occ);
    const mr = maxRect(fm.mask, fm.w, fm.d);
    const P = (a, b) => [fx + a * E1[0] + b * E2[0], fz + a * E1[1] + b * E2[1]];
    if (mr && (mr.i1 - mr.i0) * fm.c >= 14 && (mr.j1 - mr.j0) * fm.c >= 14 && (mr.i1 - mr.i0) * (mr.j1 - mr.j0) * fm.c * fm.c >= 0.55 * g.area) {
      stats.rect++;
      const pvA = 3 + (pass++ % 250);
      let A0 = fm.a0 + mr.i0 * fm.c, A1 = fm.a0 + mr.i1 * fm.c, B0 = fm.b0 + mr.j0 * fm.c, B1 = fm.b0 + mr.j1 * fm.c;
      const W = Math.round((A1 - A0) / BV), D = Math.round((B1 - B0) / BV);
      const samp = (f) => [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9].map(f);
      let sides = {
        F: sideKind(PL, lab, g, samp((t) => P(A0 + t * (A1 - A0), B0)), [-E2[0], -E2[1]]),
        B: sideKind(PL, lab, g, samp((t) => P(A0 + t * (A1 - A0), B1)), E2),
        L: sideKind(PL, lab, g, samp((t) => P(A0, B0 + t * (B1 - B0))), [-E1[0], -E1[1]]),
        R: sideKind(PL, lab, g, samp((t) => P(A1, B0 + t * (B1 - B0))), E1)
      };
      // the rectangle's front must be the better street: turn the frame around if the back side is
      if (sides.B.rank > sides.F.rank) {
        E1 = [-E1[0], -E1[1]]; E2 = [-E2[0], -E2[1]];
        [A0, A1, B0, B1] = [-A1, -A0, -B1, -B0];
        sides = { F: sides.B, B: sides.F, L: sides.R, R: sides.L };
      }
      const bo = new Uint8Array(W * D), lots = [];
      const rowFree = (b, a0, a1) => { for (let a = a0; a < a1; ++a) if (bo[b * W + a]) return false; return true; };
      const colFree = (a, b0, b1) => { for (let b = b0; b < b1; ++b) if (bo[b * W + a]) return false; return true; };
      const lot = (a0, a1, b0, b1, face, pr) => {
        a0 = Math.max(0, a0); b0 = Math.max(0, b0); a1 = Math.min(W, a1); b1 = Math.min(D, b1);
        if (a1 - a0 < 8 || b1 - b0 < 8) return;
        // keep the frontage, cut the depth where it meets an earlier lot
        if (face === 'F') { if (!rowFree(b0, a0, a1)) return; let b = b0; while (b < b1 && rowFree(b, a0, a1)) ++b; b1 = b; }
        else if (face === 'B') { if (!rowFree(b1 - 1, a0, a1)) return; let b = b1; while (b > b0 && rowFree(b - 1, a0, a1)) --b; b0 = b; }
        else if (face === 'L') { if (!colFree(a0, b0, b1)) return; let a = a0; while (a < a1 && colFree(a, b0, b1)) ++a; a1 = a; }
        else { if (!colFree(a1 - 1, b0, b1)) return; let a = a1; while (a > a0 && colFree(a - 1, b0, b1)) --a; a0 = a; }
        const wv = face === 'F' || face === 'B' ? a1 - a0 : b1 - b0, dv = face === 'F' || face === 'B' ? b1 - b0 : a1 - a0;
        if (wv * BV < 5 || dv * BV < (pr.rear ? 6 : 8)) return;
        for (let b = b0; b < b1; ++b) bo.fill(1, b * W + a0, b * W + a1);
        lots.push({ a0, a1, b0, b1, face, pr });
      };
      const Rc = C.mulberry32((g.sid * 40503 + PL.seed * 7) >>> 0);
      cutBlock(W, D, sides, rzone, Rc, lot, dcB);
      const Ob = P(A0, B0), Q = (a, b) => [Ob[0] + a * BV * E1[0] + b * BV * E2[0], Ob[1] + a * BV * E1[1] + b * BV * E2[1]];
      for (const L of lots) {
        const { a0, a1, b0, b1, face, pr } = L;
        let O, e1, e2, W2, D2;
        if (face === 'F') { O = Q(a0, b0); e1 = E1; e2 = E2; W2 = a1 - a0; D2 = b1 - b0; }
        else if (face === 'B') { O = Q(a1, b1); e1 = [-E1[0], -E1[1]]; e2 = [-E2[0], -E2[1]]; W2 = a1 - a0; D2 = b1 - b0; }
        else if (face === 'L') { O = Q(a0, b1); e1 = [-E2[0], -E2[1]]; e2 = E1; W2 = b1 - b0; D2 = a1 - a0; }
        else { O = Q(a1, b0); e1 = E2; e2 = [-E1[0], -E1[1]]; W2 = b1 - b0; D2 = a1 - a0; }
        const sd = sides[face === 'F' ? 'F' : face === 'B' ? 'B' : face === 'L' ? 'L' : 'R'];
        emitLot(O, e1, e2, W2, D2, sd.type === 'street' ? sd.road : null, pr, pvA);
      }
    }
    // the rest (irregular blocks, wedges): packed street by street, 4 m clear of buildings from other passes
    const order = [...g.front.entries()].filter(([rid]) => roads[rid].P.id !== 'alley')
      .sort((a, b) => b[1].length * (1 + RANK[roads[b[0]].P.cls]) - a[1].length * (1 + RANK[roads[a[0]].P.cls]));
    const Z = ZONE_LOTS[rzone] || ZONE_LOTS.mid;
    for (const [rid, cells] of order) {
      if (cells.length < 2 * Z.minW / PL.cell) continue;
      const road = roads[rid], pv = 3 + (pass++ % 250);
      let cx = 0, cz = 0;
      for (const q of cells) { cx += q % PL.nx; cz += (q / PL.nx) | 0; }
      cx = PL.x0 + (cx / cells.length + 0.5) * PL.cell; cz = PL.z0 + (cz / cells.length + 0.5) * PL.cell;
      const [ux, uz] = PL.tangentNear(road, cx, cz);
      let e1 = [ux, uz], e2 = [-uz, ux];
      if ((g.mx - cx) * e2[0] + (g.mz - cz) * e2[1] < 0) { e1 = [-e1[0], -e1[1]]; e2 = [-e2[0], -e2[1]]; }
      const m = frameMask(PL, lab, g, [cx, cz], e1, e2, occ), myAng = frameAngle(e1);
      let fa0 = 1e9, fa1 = -1e9;
      const bs = [];
      for (const q of cells) {
        const x = PL.x0 + (q % PL.nx + 0.5) * PL.cell - cx, z = PL.z0 + (((q / PL.nx) | 0) + 0.5) * PL.cell - cz;
        const a = x * e1[0] + z * e1[1]; bs.push(x * e2[0] + z * e2[1]);
        if (a < fa0) fa0 = a; if (a > fa1) fa1 = a;
      }
      bs.sort((p, q) => p - q);
      const bF = Math.ceil((bs[bs.length >> 1] - 0.25) / BV) * BV;
      const jF = Math.floor((bF + 0.25 - m.b0) / m.c);
      if (jF < 0 || jF >= m.d) continue;
      const fits = (a, w) => {                       // depth (m) of the free rectangle [a, a+w] behind the frontage
        const i0 = Math.floor((a + 0.1 - m.a0) / m.c), i1 = Math.ceil((a + w - 0.1 - m.a0) / m.c);
        if (i0 < 0 || i1 > m.w) return 0;
        let j = jF;
        const capJ = jF + Math.round(Z.cap / m.c);
        for (; j < m.d && j < capJ; ++j) { let ok = true; for (let i = i0; i < i1; ++i) if (!m.mask[j * m.w + i]) { ok = false; break; } if (!ok) break; }
        return j === jF ? 0 : m.b0 + j * m.c - bF;
      };
      const Rp = C.mulberry32((g.sid * 977 + rid * 7919 + PL.seed) >>> 0);
      let a = Math.ceil((fa0 - 0.25) / BV) * BV, lastEnd = -1e9, k = 0;
      const end = fa1 + 0.25;
      while (a + Z.minW <= end) {
        if (a > lastEnd && a < lastEnd + 4) { a = lastEnd + 4; continue; }
        let w = Math.min(Math.round(Z.width(Rp) / BV) * BV, end - a), placed = false;
        if (end - a - w < Z.minW) w = Math.floor((end - a) / BV) * BV;
        for (; w >= Z.minW; w -= 1) {
          let d = fits(a, w);
          d = Math.floor(Math.min(d, Z.cap) / BV) * BV;
          if (d < Z.minD) continue;
          const O = [cx + a * e1[0] + bF * e2[0], cz + a * e1[1] + bF * e2[1]];
          // 4.5 m clear of buildings in (nearly) the same grid; skewed ones (diagonal streets) may come closer
          if (occ.rect(O, e1, e2, -4.5, w + 4.5, -4.5, d + 4.5, false, (v, an) => v !== pv && (v === 2 || angDiff(an, myAng) < 25)) ||
              occ.rect(O, e1, e2, -0.6, w + 0.6, -0.6, d + 0.6, false, (v) => v !== pv)) continue;
          if (emitLot(O, e1, e2, Math.round(w / BV), Math.round(d / BV), road, { strip: 'P' + rid, idx: k++ }, pv)) {
            stats.packed++; placed = true; a += w; lastEnd = a; break;
          }
        }
        if (!placed) a += 1;
      }
    }
  }
  return { lab, handled, stats, regs };
}
// ------------------------------------------------------------------------------------------------ plan + tiles
// The build is split in two so the page can stream a map of any size:
//   planAll(PL, R, voxel, C)   global and geometry-free: block / suburb / lot placement -> one job per building (with
//                              its party sides from the complete occupancy map), then assignTypes() deals the tower /
//                              mid-rise decks in global job order. The dressing kits that work across lots (service
//                              yards, parks; towers/servicekit.js, parkkit.js) run here too, into their own mesh, which
//                              is binned per tile by quad centre.
//   buildTile(plan, x0, z0, x1, z1)  the buildings whose footprint centre lies in the rectangle (metres), plus a halo
//                              of neighbours within TILE_HALO m: everything is z-fight-resolved together (cullHidden in
//                              global emission order, so a pair split by a tile edge is settled the same way from both
//                              sides), then only the tile's own quads are kept. Pure function of (plan, rectangle).
//   buildAll(PL, R, voxel, C, opts)  plan + every tile (opts.tile metres, default one tile = the whole map), concatenated.
const TILE_HALO = 6;
function assignTypes(jobs, C, banUnique) {
  towerDeck = []; dealt = 0; usedUnique = new Set(banUnique || []); midDecks = {};
  for (const J of jobs) {
    const spec = { seed: J.seed, floors: J.floors, use: J.use };
    if (J.kind === 'row') J.pre = { m: chooseMid(J.W, spec, C, 'row') };
    else if (J.kind === 'mid') J.pre = { m: chooseMid(J.W, spec, C, J.zone === 'core' ? 'core' : 'mid') };
    else if (J.kind === 'commercial' || J.kind === 'transition') {
      const zone = J.kind, wm = J.W * BV;
      if (MIDS.some(m => m.zones.includes(zone) && wm >= m.minW && wm <= m.maxW)) J.pre = { m: chooseMid(J.W, spec, C, zone) };
    } else if (J.kind === 'tower') J.pre = { t: dealTower(spec, C) };
    if (J.pre && J.pre.m) J.type = J.pre.m.name; else if (J.pre && J.pre.t) J.type = J.pre.t.name;
  }
}
function planAll(PL, R, voxel, C, popts) {
  popts = popts || {};
  C_VoxModel = C.VoxModel;
  CUTS = []; CUT_WHY = {}; CUT_R = R && R.F ? R : null;                           // driveway curb cuts, see curbProbe()
  if (CUT_R && CUT_R.setCuts) CUT_R.setCuts(null);
  const hs = R.hs * voxel, counts = { house: 0 };
  const occ = new Occupancy(PL.occBounds || PL.net.bounds);
  const jobs = [];
  const addJob = (O, e1, e2, W, D, p) => jobs.push(Object.assign({ O, e1, e2, W, D }, p));
  const tb = Date.now();
  const blocks = PL.base ? placeBlocks(PL, C, occ, addJob) : null;
  counts.placeMs = Date.now() - tb;
  let sub = null;
  if (blocks) {
    const ts = Date.now();
    sub = planSuburbs(PL, C, blocks);
    // suburban houses (+ their yards) become jobs too, emitted before every other job (as the monolithic build did)
    const BVv = (m) => Math.round(m / BV);
    for (const L of sub.lots) {
      if (L.use !== 'house') continue;
      const H = L.H;
      if (H) occ.rect([L.O[0] + H.x0 * L.e1[0] + H.z0 * L.e2[0], L.O[1] + H.x0 * L.e1[1] + H.z0 * L.e2[1]], L.e1, L.e2, 0, H.w, 0, H.d, 2);
      jobs.push({ O: L.O, e1: L.e1, e2: L.e2, W: Math.floor(L.w / BV + 1e-6), D: Math.floor(L.d / BV + 1e-6), kind: 'shouse', L, seed: L.seed, floors: 0 });
      if (H) ++counts.house;
    }
    emitSuburbs(Object.assign({}, sub, { lots: sub.lots.filter(L => L.use !== 'house') }), null, hs, voxel, C, occ, addJob);
    counts.suburbMs = Date.now() - ts;
  }
  const lots = lotRectangles(PL, C);
  const place = (L, a0, a1, b0, b1, kind, floors, seed) => {
    const W = Math.floor((a1 - a0) / BV), D = Math.floor((b1 - b0) / BV);
    if (W < 16 || D < 16) return;
    const Oc = [L.mx, L.mz];
    if (occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, false) > 0.02) return;
    occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, kind === 'house' ? 2 : 1);
    const O = [L.mx + a0 * L.e1[0] + b0 * L.e2[0], L.mz + a0 * L.e1[1] + b0 * L.e2[1]];
    const zone = kind === 'mid' && zoneOf(PL.net, L.road, L.mx, L.mz) === 'tower' ? 'core' : kind === 'row' ? 'row' : 'mid';
    addJob(O, L.e1, L.e2, W, D, { kind, floors, seed, zone, shops: L.road.P.cls !== 'local' && L.part === 0 });
  };
  for (const L of lots) {
    const zone = zoneOf(PL.net, L.road, L.mx, L.mz);
    if (blocks) {                                   // skip plots inside blocks laid out above
      const a = (L.a0 + L.a1) / 2, b = (L.b0 + L.b1) / 2;
      const ix = Math.floor((L.mx + a * L.e1[0] + b * L.e2[0] - PL.x0) / PL.cell), iz = Math.floor((L.mz + a * L.e1[1] + b * L.e2[1] - PL.z0) / PL.cell);
      const rg = ix >= 0 && iz >= 0 && ix < PL.nx && iz < PL.nz ? blocks.lab[iz * PL.nx + ix] : -1;
      if (rg >= 0 && (blocks.handled.has(rg) || (sub && sub.regions.has(rg)))) continue;
    }
    const seed0 = ((L.id * 2654435761) ^ (L.part * 40503)) >>> 0;
    const Rn = C.mulberry32(seed0);
    const lw = L.a1 - L.a0, ld = L.b1 - L.b0;
    if (zone === 'house') {
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
      continue;
    }
    let a = L.a0, k = 0;
    while (L.a1 - a >= 8) {
      const tower = zone === 'tower' && k === 0 && lw >= 18 && ld >= 18;
      let pw = tower ? Math.min(lw, 26 + Rn() * 14) : 12 + Rn() * 14;
      if (L.a1 - a - pw < 10) pw = L.a1 - a;
      const seed = (seed0 + k * 104729) >>> 0;
      const Rk = C.mulberry32(seed);
      if (tower && pw >= 18) place(L, a, a + pw, L.b0, L.b0 + Math.min(ld, 46), 'tower', 18 + Math.floor(Rk() * Rk() * 26), seed);
      else if (pw >= 10 && ld >= 9) place(L, a, a + pw, L.b0, L.b0 + Math.min(ld, 34), 'mid', zone === 'tower' ? 8 + Math.floor(Rk() * 7) : 4 + Math.floor(Rk() * 6), seed);
      else place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 14), 'row', 4, seed);
      a += pw; ++k;
    }
  }
  // global emission order: suburban houses first, then the other jobs in placement order
  const order = jobs.filter(J => J.kind === 'shouse').concat(jobs.filter(J => J.kind !== 'shouse'));
  order.forEach((J, i) => {
    J.ord = i;
    const wm = J.W * BV, dm = J.D * BV;
    J.cx = J.O[0] + J.e1[0] * wm / 2 + J.e2[0] * dm / 2; J.cz = J.O[1] + J.e1[1] * wm / 2 + J.e2[1] * dm / 2;
    const xs = [0, wm].flatMap(a => [0, dm].map(b => J.O[0] + a * J.e1[0] + b * J.e2[0])), zs = [0, wm].flatMap(a => [0, dm].map(b => J.O[1] + a * J.e1[1] + b * J.e2[1]));
    J.bb = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    if (J.kind !== 'shouse') {                       // attached neighbours at either end become party walls
      const { O, e1, e2 } = J, bi0 = Math.min(1, dm / 4), bi1 = dm - Math.min(1, dm / 4), ai0 = Math.min(1, wm / 4), ai1 = wm - Math.min(1, wm / 4);
      J.party = { l: occ.rect(O, e1, e2, -0.75, -0.25, bi0, bi1, false) > 0.5, r: occ.rect(O, e1, e2, wm + 0.25, wm + 0.75, bi0, bi1, false) > 0.5,
                  b: occ.rect(O, e1, e2, ai0, ai1, dm + 0.25, dm + 0.75, false) > 0.5 };
    }
  });
  const tt = Date.now();
  if (PL.pageMode) {                                 // decks dealt per streaming page (pageOf), in placement order
    const byPage = new Map();
    for (const J of jobs) if (J.kind !== 'shouse') { const k = pageOf(PL.net, J.cx, J.cz).join(','); let a = byPage.get(k); if (!a) byPage.set(k, a = []); a.push(J); }
    const corePage = pageOf(PL.net, ...((PL.net.origins && PL.net.origins.core) || [0, 0])).join(',');
    for (const [k, a] of byPage) if (!popts.core || k === popts.pageKey) assignTypes(a, C, k === corePage ? null : TOWERS.filter(t => t.unique).map(t => t.name));
  } else assignTypes(jobs.filter(J => J.kind !== 'shouse'), C);
  counts.typesMs = Date.now() - tt;
  const plan = { PL, R, voxel, C, hs, occ, jobs: order, blockJobs: jobs.filter(J => J.kind !== 'shouse'), blocks, sub, counts, cuts: [], kit: null };
  // cross-lot dressing (service yards, parks) into their own mesh; quads binned per tile at build time
  const kmb = new C.MeshBuffer();
  if (LIB.serviceKit) { const ts = Date.now(); counts.service = LIB.serviceKit({ PL, R, C, occ, blocks, jobs: plan.blockJobs, hs, voxel, mb: kmb }); counts.serviceMs = Date.now() - ts; }
  if (sub && LIB.parkKit) { const tp = Date.now(); sub.leftovers = LIB.parkKit({ PL, C, R, blocks, sub, mb: kmb, hs, voxel }); counts.parkMs = Date.now() - tp; }
  plan.kit = kmb; plan.kitCuts = CUTS; CUTS = [];
  // per-quad centre + bounds (voxel units) of the kit mesh for binning
  const n = kmb.quads, KC = new Float32Array(n * 2), KB = new Float32Array(n * 4);
  for (let q = 0; q < n; ++q) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let k = 0; k < 4; ++k) { const x = kmb.pos[q * 12 + k * 3], z = kmb.pos[q * 12 + k * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    KC[q * 2] = (x0 + x1) / 2; KC[q * 2 + 1] = (z0 + z1) / 2; KB[q * 4] = x0; KB[q * 4 + 1] = z0; KB[q * 4 + 2] = x1; KB[q * 4 + 3] = z1;
  }
  plan.kitC = KC; plan.kitB = KB;
  CUT_R = null;
  return plan;
}
// ---- regional planning (streaming pages). The map is cut into PAGE x PAGE m pages on the global grid (from the map's
// x0/z0 corner). A page is planned on its own: fields, plots, block regions, placeBlocks / planSuburbs / lots, kits,
// in a window of PAGE_HALO m around it (planAll with PL.pageMode: local rules), then keeps only what it owns: jobs and
// kit quads whose centre lies in the page, curb cuts whose midpoint does, and the block classes of its field cells.
// A block fully inside two windows comes out the same from both (seeds hashed from the block's global first cell,
// same grid origins, same relative scan order), so a tile assembles the jobs / kit of the pages around it.
const PAGE = 256, PAGE_HALO = 128;
function pageOf(net, x, z) { const b = net.bounds; return [Math.floor((x - b.x0) / PAGE), Math.floor((z - b.z0) / PAGE)]; }
function pageRect(net, pi, pj) { const b = net.bounds; return [b.x0 + pi * PAGE, b.z0 + pj * PAGE, b.x0 + (pi + 1) * PAGE, b.z0 + (pj + 1) * PAGE]; }
function classKinds(net) { const k = ['pocket']; for (const a of net.areas || []) if (!k.includes(a.kind)) k.push(a.kind); return k; }
function planPage(net, C, voxel, pi, pj, opts) {
  opts = opts || {};
  const t0 = Date.now(), H = opts.halo || PAGE_HALO, rect = pageRect(net, pi, pj), b = net.bounds;
  const win = [rect[0] - H, rect[1] - H, rect[2] + H, rect[3] + H];
  const F = new C.FieldSampler(net, 0.5, [win[0] - 4, win[1] - 4, win[2] + 4, win[3] + 4]); F.build(null, true);
  const R = new C.Rasterizer(net, F, voxel); R.blockAreas();
  const tf = Date.now();
  const PL = new C.Plots(net, F, R, 0.5, net.seed || 1, win); PL.pageMode = true;
  const ox = b.x0 + Math.floor((win[0] - b.x0) / 0.5) * 0.5, oz = b.z0 + Math.floor((win[1] - b.z0) / 0.5) * 0.5;
  PL.occBounds = { x0: ox, z0: oz, x1: win[2], z1: win[3] };
  PL.build();
  const tp = Date.now();
  const key = pi + ',' + pj, own = (x, z) => x >= rect[0] && x < rect[2] && z >= rect[1] && z < rect[3];
  const plan = planAll(PL, R, voxel, C, { core: rect, pageKey: key });
  const jobs = plan.jobs.filter(J => own(J.cx, J.cz)).map(J => {
    const o = Object.assign({}, J); delete o.type; o.page = key; o.pord = J.ord;
    if (J.pre) o.pre = { mi: J.pre.m ? MIDS.indexOf(J.pre.m) : -1, ti: J.pre.t ? TOWERS.indexOf(J.pre.t) : -1 };
    if (J.L) { const L = J.L; o.L = { H: L.H, O: L.O, e1: L.e1, e2: L.e2, w: L.w, d: L.d, cornerL: L.cornerL, cornerR: L.cornerR, nb: L.nb, seed: L.seed, use: L.use }; }
    return o;
  });
  // owned kit quads (centre in the page), compact
  const K = plan.kit, v = voxel, sel = [];
  for (let q = 0; q < K.quads; ++q) if (own(plan.kitC[q * 2] * v, plan.kitC[q * 2 + 1] * v)) sel.push(q);
  const n = sel.length, kit = { quads: n, pos: new Float64Array(n * 12), mat: new Uint16Array(n * 4), nrm: new Uint8Array(n * 4), nvec: K.nvec ? new Float64Array(n * 12) : null };
  sel.forEach((q, k) => {
    for (let e = 0; e < 12; ++e) kit.pos[k * 12 + e] = K.pos[q * 12 + e];
    for (let e = 0; e < 4; ++e) { kit.mat[k * 4 + e] = K.mat[q * 4 + e]; kit.nrm[k * 4 + e] = K.nrm[q * 4 + e]; }
    if (kit.nvec) for (let e = 0; e < 12; ++e) kit.nvec[k * 12 + e] = K.nvec[q * 12 + e];
  });
  const kitCuts = plan.kitCuts.filter(c => own((c.ax + c.bx) / 2, (c.az + c.bz) / 2)).map(c => Object.assign({}, c));
  // block classes of the page's field cells (global field grid; 255 = no block): what a tile raster needs
  const kinds = classKinds(net), gix0 = Math.round((rect[0] - F.bX0) / 0.5), giz0 = Math.round((rect[1] - F.bZ0) / 0.5), N = Math.round(PAGE / 0.5);
  const cls = new Uint8Array(N * N).fill(255);
  for (let z = 0; z < N; ++z) for (let x = 0; x < N; ++x) {
    const ix = gix0 + x - F.oix, iz = giz0 + z - F.oiz;
    if (ix < 0 || iz < 0 || ix >= F.nx || iz >= F.nz) continue;
    const c = F.comp[iz * F.nx + ix]; if (c < 0) continue;
    const kd = R.blockArea.get(c);
    cls[z * N + x] = (kd ? kinds.indexOf(kd) + 1 : 0) * 2 + (R.suburb && R.suburb.has(c) ? 1 : 0);
  }
  const counts = plan.counts;
  return { key, pi, pj, rect, jobs, kit, kitCuts, cls: { gix0, giz0, N, data: cls }, core: plan.sub ? plan.sub.core : null, hs: plan.hs,
    ms: { fields: tf - t0, plots: tp - tf, plan: Date.now() - tp, park: counts.parkMs || 0, service: counts.serviceMs || 0, total: Date.now() - t0 } };
}
// a tile's plan from the pages around it (jobs in a fixed global order: suburban houses first, then by page, then by
// placement order within the page; kit quads by page), for buildTile
function pagesPlan(pages, net, C, voxel, hs) {
  const ord = (k) => { const [a, b] = k.split(',').map(Number); return b * 4096 + a; };
  pages = pages.slice().sort((p, q) => ord(p.key) - ord(q.key));
  const jobs = [];
  for (const P of pages) for (const J of P.jobs) jobs.push(J);
  const rank = (J) => (J.kind === 'shouse' ? 0 : 1e9) + ord(J.page) * 1e5 + J.pord;
  jobs.sort((a, b) => rank(a) - rank(b));
  for (const J of jobs) if (J.pre && (J.pre.mi !== undefined)) { const p = {}; if (J.pre.mi >= 0) p.m = MIDS[J.pre.mi]; if (J.pre.ti >= 0) p.t = TOWERS[J.pre.ti]; J.pre = p; }
  let nq = 0; for (const P of pages) nq += P.kit.quads;
  const hasN = pages.some(P => P.kit.nvec), K = { quads: nq, pos: new Float64Array(nq * 12), mat: new Uint16Array(nq * 4), nrm: new Uint8Array(nq * 4), nvec: hasN ? new Float64Array(nq * 12) : null };
  let o = 0;
  for (const P of pages) {
    const k = P.kit; K.pos.set(k.pos, o * 12); K.mat.set(k.mat, o * 4); K.nrm.set(k.nrm, o * 4);
    if (hasN) { if (k.nvec) K.nvec.set(k.nvec, o * 12); else for (let q = 0; q < k.quads; ++q) { const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]][k.nrm[q * 4]]; for (let e = 0; e < 4; ++e) K.nvec.set(NV, (o + q) * 12 + e * 3); } }
    o += k.quads;
  }
  const plan = { C, voxel, hs, jobs, sub: { core: (pages.find(P => P.core) || {}).core || null }, R: null };
  setKit(plan, K);
  return plan;
}
// block-class lookup over the pages' cells (global field grid indices) for Rasterizer.useClassGrid
function pagesClassGrid(pages) {
  const m = new Map(); for (const P of pages) m.set(P.cls.gix0 + ',' + P.cls.giz0, P.cls);
  const N = Math.round(PAGE / 0.5);
  return (gix, giz) => {
    const off = (g) => g - ((g - 12) % N + N) % N;   // field index of the page corner (gix0 = 2 * (pi * PAGE + 6))
    const c = m.get(off(gix) + ',' + off(giz)); if (!c) return 254;
    return c.data[(giz - c.giz0) * N + (gix - c.gix0)];
  };
}
// one job into mb (building-local emitter); returns its type
function emitJob(plan, J, mb) {
  const { C, hs, voxel } = plan;
  if (J.kind === 'shouse') {                          // suburban house + yard (emitSuburbs, one lot)
    emitSuburbs({ lots: [J.L], core: plan.sub.core }, mb, hs, voxel, C, null, null);
    return J.L.H ? 'house' : 'yard';
  }
  const { O, e1, e2, W, D, kind, floors, seed } = J;
  const E = new Emitter(mb, O, e1, e2, hs, voxel);
  const spec = { seed, floors, party: J.party, shops: !!J.shops };
  if (J.corner) spec.corner = true;
  if (J.pre) spec.pre = J.pre;
  if (kind === 'house') return buildHouseAny(E, W, D, spec, C) || 'house';
  if (kind === 'row') return buildMidAny(E, W, D, spec, C, 'row');
  if (kind === 'mid') return buildMidAny(E, W, D, spec, C, J.zone === 'core' ? 'core' : 'mid');
  if (kind === 'commercial' || kind === 'transition') { Object.assign(spec, { use: J.use, lot: J.lot }); return buildSuburbAny(E, W, D, spec, C, kind); }
  return buildTower(E, W, D, spec, C);
}
function copyQuads(src, dst, q0, q1) {
  for (let q = q0; q < q1; ++q) {
    for (let k = 0; k < 12; ++k) dst.pos.push(src.pos[q * 12 + k]);
    for (let k = 0; k < 4; ++k) { dst.mat.push(src.mat[q * 4 + k]); dst.nrm.push(src.nrm[q * 4 + k]); }
    if (!dst.nvec) dst.nvec = [];
    if (src.nvec) for (let k = 0; k < 12; ++k) dst.nvec.push(src.nvec[q * 12 + k]);
    else { const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]][src.nrm[q * 4]]; for (let k = 0; k < 4; ++k) dst.nvec.push(NV[0], NV[1], NV[2]); }
    const b = dst.quads * 4; dst.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    dst.quads++;
  }
}
// The tile's buildings (+ halo) emitted in global order, kit quads near the tile after them, one z-fight pass, own quads
// kept. Returns { mb (unfinished MeshBuffer), jobs (own, with q0/q1 in mb), cuts, kitQuads, ms }
const FAR_LOD_MIN = 0.35;                               // m: ~1 px at the far-LOD switch distance (city_stream.js)
function buildTile(plan, x0, z0, x1, z1, opts) {
  opts = opts || {};
  const t0 = Date.now(), { C, R, voxel, hs } = plan, v = voxel;
  C_VoxModel = C.VoxModel;
  const inT = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
  const H = TILE_HALO;
  // halo: every job within H of the tile or of any own building (own buildings reach past the tile edge)
  let ex0 = x0, ez0 = z0, ex1 = x1, ez1 = z1;
  for (const J of plan.jobs) if (inT(J.cx, J.cz)) { ex0 = Math.min(ex0, J.bb[0]); ez0 = Math.min(ez0, J.bb[1]); ex1 = Math.max(ex1, J.bb[2]); ez1 = Math.max(ez1, J.bb[3]); }
  const sel = plan.jobs.filter(J => inT(J.cx, J.cz) || (J.bb[2] > ex0 - H && J.bb[0] < ex1 + H && J.bb[3] > ez0 - H && J.bb[1] < ez1 + H));
  CUTS = []; CUT_WHY = {}; CUT_R = R && R.F ? R : null;
  const cutsBefore = R.cuts; if (CUT_R && CUT_R.setCuts) CUT_R.setCuts(null);
  const mb = new C.MeshBuffer();
  const segs = [];
  for (const J of sel) {
    const q0 = mb.quads, c0 = CUTS.length;
    J.type = emitJob(plan, J, mb) || J.type;
    segs.push({ J, q0, q1: mb.quads, own: inT(J.cx, J.cz), c0, c1: CUTS.length });
  }
  const kq0 = mb.quads;
  const K = plan.kit, KC = plan.kitC, KB = plan.kitB, kown = [];
  if (!opts.noKit) for (let q = 0; q < K.quads; ++q) {
    const bx0 = KB[q * 4] * v, bz0 = KB[q * 4 + 1] * v, bx1 = KB[q * 4 + 2] * v, bz1 = KB[q * 4 + 3] * v;
    if (bx1 < ex0 - H || bx0 > ex1 + H || bz1 < ez0 - H || bz0 > ez1 + H) continue;
    copyQuads(K, mb, q, q + 1); kown.push(inT(KC[q * 2] * v, KC[q * 2 + 1] * v));
  }
  const marks = []; for (const s of segs) marks.push(s.q0, s.q1); marks.push(kq0, mb.quads);
  if (LIB.debugBeforeCull && opts.debug) LIB.debugBeforeCull(mb);
  const cr = cullHidden(mb, hs / voxel, marks, 0, true, { flush: true, ground: true });
  segs.forEach((s, i) => { s.q0 = cr.marks[2 * i]; s.q1 = cr.marks[2 * i + 1]; });
  // kit quads after the cull: cullHidden keeps the order of surviving quads and appends split pieces of quad q
  // in place of q (src maps output -> input quad), so ownership follows the source quad
  const out = new C.MeshBuffer(), jobs = [], cuts = [];
  // far LOD (streaming, tiles beyond FAR_LOD_DIST of the camera): quads under FAR_LOD_MIN in both directions are
  // dropped (trim, sills, small props, kit dressing details: under a pixel at that distance); everything else stays
  const far = opts.lod === 'far', lim2 = (FAR_LOD_MIN / v) * (FAR_LOD_MIN / v);
  const keepQ = (q) => {
    const P = mb.pos, o = q * 12;
    const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2], bx = P[o + 9] - P[o], by = P[o + 10] - P[o + 1], bz = P[o + 11] - P[o + 2];
    return ax * ax + ay * ay + az * az >= lim2 || bx * bx + by * by + bz * bz >= lim2;
  };
  const copy = (q0, q1) => { if (!far) return copyQuads(mb, out, q0, q1); for (let q = q0; q < q1; ++q) if (keepQ(q)) copyQuads(mb, out, q, q + 1); };
  for (const s of segs) if (s.own) {
    const a = out.quads; copy(s.q0, s.q1);
    jobs.push(Object.assign(s.J, { q0: a, q1: out.quads, tris: 2 * (s.q1 - s.q0) }));
    for (let c = s.c0; c < s.c1; ++c) cuts.push(CUTS[c]);
  }
  const ka = cr.marks[2 * segs.length], kb = cr.marks[2 * segs.length + 1];
  const kitStart = out.quads;
  for (let q = ka; q < kb; ++q) { const sq = cr.src ? cr.src[q] - kq0 : q - ka; if (sq >= 0 && sq < kown.length ? kown[sq] : true) copy(q, q + 1); }
  const allCuts = opts.allCuts ? CUTS.map(c => Object.assign({}, c)) : null;   // own + halo buildings' curb cuts (streaming road raster / traffic)
  CUTS = []; CUT_R = null; if (R.setCuts) R.setCuts(cutsBefore || null);
  return { mb: out, jobs, cuts, allCuts, kitQuads: out.quads - kitStart, ms: Date.now() - t0, halo: sel.length - jobs.length };
}
// Streaming hand-off: the planner worker exports what buildTile needs (jobs, suburban core, kit mesh + bins, kit curb
// cuts, the block classes of the road raster) as plain data + typed arrays; the tile workers rebuild only the road
// network and sample their fields per tile window (FieldSampler win), so their memory does not grow with the map.
function exportPlan(plan) {
  const K = plan.kit, strip = (J) => {
    const o = Object.assign({}, J); delete o.type;
    if (J.pre) o.pre = { mi: J.pre.m ? MIDS.indexOf(J.pre.m) : -1, ti: J.pre.t ? TOWERS.indexOf(J.pre.t) : -1 };   // registry index (same plug-ins everywhere)
    return o;
  };
  const kit = { quads: K.quads, pos: Float64Array.from(K.pos), mat: Uint16Array.from(K.mat), nrm: Uint8Array.from(K.nrm), nvec: K.nvec ? Float64Array.from(K.nvec) : null };
  const jobs = plan.jobs.map(strip);
  // suburban lots: only what emitSuburbs / the yard kit read (the lot's face graph stays with the planner)
  for (const J of jobs) if (J.L) { const L = J.L; J.L = { H: L.H, O: L.O, e1: L.e1, e2: L.e2, w: L.w, d: L.d, cornerL: L.cornerL, cornerR: L.cornerR, nb: L.nb, seed: L.seed, use: L.use }; }
  const out = { jobs, core: plan.sub ? plan.sub.core : null, kit, kitC: plan.kitC, kitB: plan.kitB, kitCuts: plan.kitCuts.map(c => Object.assign({}, c)),
    hs: plan.hs, voxel: plan.voxel, bc: plan.R.blockClasses(), counts: { jobs: plan.jobs.length, kitQuads: K.quads } };
  out.transfer = [kit.pos.buffer, kit.mat.buffer, kit.nrm.buffer, out.kitC.buffer, out.kitB.buffer, out.bc.runs.buffer, out.bc.rowAt.buffer].concat(kit.nvec ? [kit.nvec.buffer] : []);
  return out;
}
// the kit quads of one tile request (the page bins the planner's kit mesh and sends each tile its slice, in global order)
function kitSlice(kit, idx) {
  const n = idx.length, o = { quads: n, pos: new Float64Array(n * 12), mat: new Uint16Array(n * 4), nrm: new Uint8Array(n * 4), nvec: kit.nvec ? new Float64Array(n * 12) : null };
  for (let k = 0; k < n; ++k) {
    const q = idx[k];
    o.pos.set(kit.pos.subarray(q * 12, q * 12 + 12), k * 12); o.mat.set(kit.mat.subarray(q * 4, q * 4 + 4), k * 4); o.nrm.set(kit.nrm.subarray(q * 4, q * 4 + 4), k * 4);
    if (o.nvec) o.nvec.set(kit.nvec.subarray(q * 12, q * 12 + 12), k * 12);
  }
  return o;
}
function setKit(plan, K) {
  const n = K.quads, KC = new Float32Array(n * 2), KB = new Float32Array(n * 4);
  for (let q = 0; q < n; ++q) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let k = 0; k < 4; ++k) { const x = K.pos[q * 12 + k * 3], z = K.pos[q * 12 + k * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    KC[q * 2] = (x0 + x1) / 2; KC[q * 2 + 1] = (z0 + z1) / 2; KB[q * 4] = x0; KB[q * 4 + 1] = z0; KB[q * 4 + 2] = x1; KB[q * 4 + 3] = z1;
  }
  plan.kit = K; plan.kitC = KC; plan.kitB = KB;
}
function importPlan(cp, net, C) {
  for (const J of cp.jobs) if (J.pre) { const p = {}; if (J.pre.mi >= 0) p.m = MIDS[J.pre.mi]; if (J.pre.ti >= 0) p.t = TOWERS[J.pre.ti]; J.pre = p; }
  return { C, voxel: cp.voxel, hs: cp.hs, jobs: cp.jobs, sub: { core: cp.core }, kit: cp.kit, kitC: cp.kitC, kitB: cp.kitB, kitCuts: cp.kitCuts, bc: cp.bc, R: null };
}
function buildAll(PL, R, voxel, C, opts) {
  opts = opts || {};
  towerDeck = []; TOWER_LOG = []; dealt = 0; usedUnique = new Set(); midDecks = {}; MID_LOG = []; HOUSE_LOG = [];
  const legacy = !PL.base || PL.net.kind === 'test';
  if (legacy) return buildAllLegacy(PL, R, voxel, C);
  const plan = planAll(PL, R, voxel, C);
  const counts = plan.counts, b = PL.net.bounds;
  const T = opts.tile || Math.max(b.x1 - b.x0, b.z1 - b.z0) + 1;
  const tiles = [];
  for (let z = b.z0 - 20; z < b.z1 + 20; z += T) for (let x = b.x0 - 20; x < b.x1 + 20; x += T) tiles.push([x, z, x + T, z + T]);
  if (opts.tile === undefined) tiles.splice(0, tiles.length, [-1e6, -1e6, 1e6, 1e6]);
  const mb = new C.MeshBuffer(), jobs = [];
  let cuts = plan.kitCuts.slice();
  const tb = Date.now(); counts.tileMs = [];
  for (const t of tiles) {
    const r = buildTile(plan, t[0], t[1], t[2], t[3]);
    const off = mb.quads; copyQuads(r.mb, mb, 0, r.mb.quads);
    for (const J of r.jobs) { J.q0 += off; J.q1 += off; jobs.push(J); }
    cuts = cuts.concat(r.cuts); counts.tileMs.push(r.ms);
  }
  counts.tilesMs = Date.now() - tb; counts.tiles = tiles.length;
  jobs.sort((a, b) => a.ord - b.ord);
  // segments for the checkers: suburban houses first (one range), then each job
  const houses = jobs.filter(J => J.kind === 'shouse'), rest = jobs.filter(J => J.kind !== 'shouse');
  counts.houseQuads = 0;
  for (const J of rest) { counts[J.kind] = (counts[J.kind] || 0) + 1; counts[J.kind + 'Tris'] = (counts[J.kind + 'Tris'] || 0) + J.tris; }
  if (R && R.setCuts) R.setCuts(cuts);
  if (LIB.onCuts) LIB.onCuts(cuts);
  counts.cuts = cuts.length;
  let TRAFFIC = null;
  if (LIB.trafficKit && plan.blocks) { const tt = Date.now(); counts.traffic = LIB.trafficKit({ PL, C, R, jobs: rest, mb, hs: plan.hs, voxel }); counts.trafficMs = Date.now() - tt; if (counts.traffic && counts.traffic.out) { TRAFFIC = counts.traffic.out; delete counts.traffic.out; } }
  const res = mb.finish(0.002);
  res.counts = counts; res.traffic = TRAFFIC;
  // logs from own jobs only (halo copies are built again by their own tile)
  res.towers = rest.filter(J => J.kind === 'tower').map(J => ({ type: J.type, x: J.cx, z: J.cz, floors: J.floors })); res.mids = MID_LOG; res.houses = HOUSE_LOG;
  res.blocks = plan.blocks ? plan.blocks.stats : null; res.cuts = cuts; res.plan = opts.keepPlan ? plan : null;
  res.footprints = rest.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * BV, d: J.D * BV, kind: J.kind, floors: J.floors, tag: J.tag, tris: J.tris, type: J.type, q0: J.q0, q1: J.q1, use: J.use }));
  res.houseSegs = houses.map(J => [J.q0, J.q1]);
  const sub = plan.sub;
  res.suburbs = sub ? Object.assign({}, sub.stats, { ms: counts.suburbMs, lots: sub.lots.map(L => ({ O: L.O, e1: L.e1, e2: L.e2, w: L.w, d: L.d, use: L.use, nb: L.nb })) }) : null;
  res.leftovers = sub && sub.leftovers ? sub.leftovers : null;
  return res;
}
function buildAllLegacy(PL, R, voxel, C) {
  C_VoxModel = C.VoxModel;
  towerDeck = []; TOWER_LOG = []; dealt = 0; usedUnique = new Set(); midDecks = {}; MID_LOG = []; HOUSE_LOG = [];
  CUTS = []; CUT_WHY = {}; CUT_R = R && R.F ? R : null;                           // driveway curb cuts, see curbProbe()
  if (CUT_R && CUT_R.setCuts) CUT_R.setCuts(null);
  const mb = new C.MeshBuffer();
  const hs = R.hs * voxel;
  const counts = {};
  counts.house = 0;
  const occ = new Occupancy(PL.net.bounds);
  // the road test area has no block map: its houses are the street-following subdivisions of subdivide()
  const legacy = !PL.base || PL.net.kind === 'test';
  if (legacy) {
    counts.house = subdivide(PL.net, R, C, occ, (Oc, e1, e2, w, d, seed, garage) => {
      const W = Math.floor(w / BV), D = Math.floor(d / BV);
      const O = [Oc[0] - (W * BV / 2) * e1[0] - (D * BV / 2) * e2[0], Oc[1] - (W * BV / 2) * e1[1] - (D * BV / 2) * e2[1]];
      const E = new Emitter(mb, O, e1, e2, hs, voxel);
      buildHouseAny(E, W, D, { seed, floors: C.mulberry32(seed ^ 77)() < 0.6 ? 2 : 1, garage, setback: 5.5 / BV + 0 }, C);
    });
    for (let i = 0; i < occ.g.length; ++i) if (occ.g[i]) occ.g[i] = 2;        // houses: kept 4 m clear of city blocks
  }
  // jobs: O = front-left corner, e1 along the frontage, e2 into the lot, W x D voxels
  const jobs = [];
  const addJob = (O, e1, e2, W, D, p) => jobs.push(Object.assign({ O, e1, e2, W, D }, p));
  const tb = Date.now();
  const blocks = PL.base ? placeBlocks(PL, C, occ, addJob) : null;
  counts.placeMs = Date.now() - tb;
  // suburbs (after the city blocks, which do not depend on them): land use, lots, houses + yards now (the 'houses'
  // part of the mesh), transition / commercial buildings as jobs after the block buildings
  let sub = null;
  if (!legacy && blocks) {
    const ts = Date.now();
    sub = planSuburbs(PL, C, blocks);
    counts.house = emitSuburbs(sub, mb, hs, voxel, C, occ, addJob);
    counts.suburbMs = Date.now() - ts;
  }
  let houseQuads = mb.quads;                                                      // houses: quads [0, houseQuads)
  // the remaining plots (residential house rows, blocks the block placer leaves alone): largest clean rectangles
  const lots = lotRectangles(PL, C);
  const place = (L, a0, a1, b0, b1, kind, floors, seed) => {
    const W = Math.floor((a1 - a0) / BV), D = Math.floor((b1 - b0) / BV);
    if (W < 16 || D < 16) return;
    const Oc = [L.mx, L.mz];
    if (occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, false) > 0.02) return;
    occ.rect(Oc, L.e1, L.e2, a0, a1, b0, b1, kind === 'house' ? 2 : 1);
    const O = [L.mx + a0 * L.e1[0] + b0 * L.e2[0], L.mz + a0 * L.e1[1] + b0 * L.e2[1]];
    const zone = kind === 'mid' && zoneOf(PL.net, L.road, L.mx, L.mz) === 'tower' ? 'core' : kind === 'row' ? 'row' : 'mid';
    addJob(O, L.e1, L.e2, W, D, { kind, floors, seed, zone, shops: L.road.P.cls !== 'local' && L.part === 0 });
  };
  const emitJobs = () => {
    // second pass: with every footprint known, attached neighbours at either end become party walls
    for (const J of jobs) {
      const { O, e1, e2, W, D, kind, floors, seed } = J;
      const wm = W * BV, dm = D * BV, bi0 = Math.min(1, dm / 4), bi1 = dm - Math.min(1, dm / 4);
      const ai0 = Math.min(1, wm / 4), ai1 = wm - Math.min(1, wm / 4);
      const party = { l: occ.rect(O, e1, e2, -0.75, -0.25, bi0, bi1, false) > 0.5,
                      r: occ.rect(O, e1, e2, wm + 0.25, wm + 0.75, bi0, bi1, false) > 0.5,
                      b: occ.rect(O, e1, e2, ai0, ai1, dm + 0.25, dm + 0.75, false) > 0.5 };   // rear attached (info)
      const E = new Emitter(mb, O, e1, e2, hs, voxel);
      const spec = { seed, floors, party, shops: !!J.shops };
      if (J.corner) spec.corner = true;
      const q0 = mb.quads;
      if (kind === 'house') { J.type = buildHouseAny(E, W, D, spec, C) || 'house'; }
      else if (kind === 'row') J.type = buildMidAny(E, W, D, spec, C, 'row');
      else if (kind === 'mid') J.type = buildMidAny(E, W, D, spec, C, J.zone === 'core' ? 'core' : 'mid');
      else if (kind === 'commercial' || kind === 'transition') {
        Object.assign(spec, { use: J.use, lot: J.lot });
        J.type = buildSuburbAny(E, W, D, spec, C, kind);
      }
      else J.type = buildTower(E, W, D, spec, C);
      counts[kind] = (counts[kind] || 0) + 1;
      J.q0 = q0; J.q1 = mb.quads;
    }
  };
  // after everything is emitted: z-fighting overlaps are settled (later geometry wins) and zero-area quads
  // dropped, see cullHidden()
  const cullPass = () => {
    const marks = [houseQuads]; for (const J of jobs) marks.push(J.q0, J.q1);
    if (LIB.debugBeforeCull) LIB.debugBeforeCull(mb);                          // dev/zfight.js --raw
    const tc = Date.now(), cr = cullHidden(mb, hs / voxel, marks, 0, true, { flush: true, ground: true });
    counts.cullMs = Date.now() - tc; counts.culled = cr.removedQuads;
    houseQuads = cr.marks[0]; jobs.forEach((J, i) => { J.q0 = cr.marks[1 + 2 * i]; J.q1 = cr.marks[2 + 2 * i]; });
    counts.houseQuads = houseQuads;
    for (const J of jobs) { J.tris = 2 * (J.q1 - J.q0); counts[J.kind + 'Tris'] = (counts[J.kind + 'Tris'] || 0) + J.tris; }
  };
  for (const L of lots) {
    const zone = zoneOf(PL.net, L.road, L.mx, L.mz);
    if (blocks) {                                   // skip plots inside blocks laid out above
      const a = (L.a0 + L.a1) / 2, b = (L.b0 + L.b1) / 2;
      const ix = Math.floor((L.mx + a * L.e1[0] + b * L.e2[0] - PL.x0) / PL.cell), iz = Math.floor((L.mz + a * L.e1[1] + b * L.e2[1] - PL.z0) / PL.cell);
      const rg = ix >= 0 && iz >= 0 && ix < PL.nx && iz < PL.nz ? blocks.lab[iz * PL.nx + ix] : -1;
      if (rg >= 0 && (blocks.handled.has(rg) || (sub && sub.regions.has(rg)))) continue;
    }
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
      if (tower && pw >= 18) place(L, a, a + pw, L.b0, L.b0 + Math.min(ld, 46), 'tower', 18 + Math.floor(Rk() * Rk() * 26), seed);
      else if (pw >= 10 && ld >= 9) place(L, a, a + pw, L.b0, L.b0 + Math.min(ld, 34), 'mid', zone === 'tower' ? 8 + Math.floor(Rk() * 7) : 4 + Math.floor(Rk() * 6), seed);
      else place(L, a, a + pw, L.b0, Math.min(L.b1, L.b0 + 14), 'row', 4, seed);
      a += pw; ++k;
    }
  }
  emitJobs();
  // back-of-house dressing (towers/servicekit.js): service courts, gaps between buildings, alleys
  if (LIB.serviceKit) counts.service = LIB.serviceKit({ PL, R, C, occ, blocks, jobs, hs, voxel, mb });
  // leftover suburban block land (not in any lot): parks, groves, wedge memorials, pocket plazas (towers/parkkit.js).
  // Emitted after every building: cullHidden() groups faces by quantised normal and measures planes with the first
  // face of each group, so these freely rotated parts must not come first in a group the buildings use
  if (sub && LIB.parkKit) { const tp = Date.now(); sub.leftovers = LIB.parkKit({ PL, C, R, blocks, sub, mb, hs, voxel }); counts.parkMs = Date.now() - tp; }
  // countryside past the county line (towers/ruralkit.js; only on grown maps, generateCity opts.scale > 1)
  if (LIB.ruralKit && PL.net.plan) counts.rural = LIB.ruralKit({ PL, C, R, mb, hs, voxel });
  // every curb cut is known now: the rasterizer drops the curbs (the page re-meshes the road chunks they touch)
  const cuts = CUTS; CUT_R = null; CUTS = [];
  if (R && R.setCuts) R.setCuts(cuts);
  if (LIB.onCuts) LIB.onCuts(cuts);
  counts.cuts = cuts.length; counts.cutRefused = CUT_WHY;
  // abandoned traffic on the roads (towers/traffickit.js): emitted last (freely rotated parts), with the final cuts
  // (GPU-instanced: the kit returns variant meshes + instance arrays in .out, handed on as res.traffic, nothing in mb)
  let TRAFFIC = null;
  if (LIB.trafficKit && blocks) { const tt = Date.now(); counts.traffic = LIB.trafficKit({ PL, C, R, jobs, mb, hs, voxel }); counts.trafficMs = Date.now() - tt; if (counts.traffic && counts.traffic.out) { TRAFFIC = counts.traffic.out; delete counts.traffic.out; } }
  cullPass();
  const res = mb.finish(0.002);
  res.counts = counts;
  res.traffic = TRAFFIC;
  res.towers = TOWER_LOG;
  res.mids = MID_LOG;
  res.houses = HOUSE_LOG;
  res.blocks = blocks ? blocks.stats : null;
  res.cuts = cuts;
  res.footprints = jobs.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * BV, d: J.D * BV, kind: J.kind, floors: J.floors, tag: J.tag, tris: J.tris, type: J.type, q0: J.q0, q1: J.q1, use: J.use }));
  res.suburbs = sub ? Object.assign({}, sub.stats, { ms: counts.suburbMs, lots: sub.lots.map(L => ({ O: L.O, e1: L.e1, e2: L.e2, w: L.w, d: L.d, use: L.use, nb: L.nb })) }) : null;
  res.leftovers = sub && sub.leftovers ? sub.leftovers : null;          // debugging: leftover regions and what fills them
  return res;
}

// ------------------------------------------------------------------------------------------------ driveway curb cuts
// Every parking lot, garage portal, drive-through, loading bay and house driveway meets its street across the
// sidewalk at a curb cut. Plug-ins (and the yard / service kits) work in their lot frame (an Emitter: O, e1 along
// the frontage, e2 into the lot, front at z = 0 = the lot line) and ask:
//   L.curbOK(E, x0, x1)                 can a drive of local x range [x0, x1) (voxels) cross the sidewalk here?
//   L.curbFit(E, x0, x1, lo, hi)        the nearest valid placement of that width inside [lo, hi], or null
//   L.driveway(E, x0, x1, kind)         register the curb cut (returns false where none is possible)
//   L.cutWorld(ax, az, bx, bz, nx, nz, kind)  the same from a world segment on the lot line and normal to the street
//   L.curbOKSide / L.drivewaySide(E, 'l' | 'r', W, z0, z1, kind)  a drive across a side line onto a side street
// A cut is valid where the sidewalk in front is a plain stretch of one (non-alley) street: the carriageway edge
// within 9 m everywhere from 3 m before to 3 m past the cut, one street all along with a smoothly changing curb
// (no corner curb return), only lot / sidewalk / curb on the way, carriageway in front and no crosswalk in front
// of the cut or its wings. Refusals are counted by reason in res.counts.cutRefused.
// buildAll returns the cuts as res.cuts and hands them to the rasterizer (city_core Rasterizer.setCuts), which
// drops the curb and paves the apron; placeProps keeps street furniture off them. Without a road raster (single
// building preview) everything is allowed and nothing is registered.
let CUTS = [], CUT_R = null, CUT_WHY = {};
const CUT_MAT_OK = new Set([7, 8, 6]);              // city_core MAT: SIDEWALK, SIDEWALK_JOINT, CURB
const CUT_XWALK = 24, CUT_PLAZA = new Set([12, 13]);  // MAT.CROSSWALK, PLAZA / PLAZA_JOINT
const CUT_CARRIAGE = new Set([0, 1, 2, 3, 4, 5, 23]);  // asphalt, gutter, paint, parking lane
const cutNo = (why) => { CUT_WHY[why] = (CUT_WHY[why] || 0) + 1; return null; };
// from a point on the lot line, walk towards the street to the carriageway edge: { depth, road, s } or null
// loose: a fixed opening near a corner, where the nearest street may change on the way (only the curb counts)
function curbProbe(X, Z, nx, nz, loose) {
  const R = CUT_R, F = R.F, o = {}, cls = [0, 0];
  let road = -1, prevCar = 1e9;
  for (let d = 0.05; d < 9; d += 0.1) {
    const x = X + nx * d, z = Z + nz * d;
    F.sample(x, z, o);
    if (o.road < 0) return cutNo('no road');
    const car = o.car / (o.g || 1);
    if (road < 0 || loose) road = o.road;
    if (o.road !== road) return cutNo('two streets');
    if (car <= 0) {
      const r = R.roads[road];
      if (!r || r.P.id === 'alley') return cutNo('alley');
      if (prevCar > 1e8) return cutNo('lot line on the carriageway');
      // just behind the curb: a sidewalk / curb of this road (not a crosswalk landing, plaza, median)
      R.classify(x - nx * 0.3, z - nz * 0.3, o, cls);
      if (o.road !== road || !CUT_MAT_OK.has(cls[1])) return cutNo('not a sidewalk');
      return { depth: d, road, s: o.s, u: o.u, x, z };
    }
    // nothing but lot, sidewalk and curb on the way (a plaza, park or square in front is no driveway)
    if (d > 0.5 && prevCar < 1e8) { R.classify(x, z, o, cls); if (CUT_PLAZA.has(cls[1])) return cutNo('plaza'); }
    prevCar = car;
  }
  return cutNo('no street within 9 m');
}
// world segment on the lot line (a -> b) and normal to the street: the cut, or null
function cutFor(ax, az, bx, bz, nx, nz, margin) {
  if (!CUT_R) return null;
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 0.5) return null;
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  // walk the curb from mg before to mg past the cut, probing from the lot line every 0.5 m: one street all along,
  // the curb depth changing smoothly (a gentle curve such as a cul-de-sac bulb is fine; a corner's curb return
  // swings away: the probe meets the cross street, or the depth jumps), sidewalk behind the curb, carriageway in
  // front, and no crosswalk in front of the cut and its wings. A fixed opening (a downtown garage portal, a
  // loading gap) keeps 1 m clear and only its own width off crosswalks; drives a plug-in can still move keep 3 m.
  const fixed = margin !== undefined, mg = fixed ? margin : 3, xw = fixed ? 0.1 : 1.6;
  const o = {}, cls = [0, 0];
  let road = -1, prev = -1, dmax = 0, s0 = 1e9, s1 = -1e9, side = 0;
  for (let t = -mg; t <= L + mg + 1e-6; t += 0.5) {
    const tt = Math.min(Math.max(t, t < 0 || t > L ? t : 0.1), t > L ? t : L - 0.1), px = ax + ux * tt, pz = az + uz * tt;
    let q;
    if (fixed && (t < 0 || t > L) && prev >= 0) {                 // a fixed opening's wings: sidewalk at the same depth
      q = { x: px + nx * prev, z: pz + nz * prev, depth: prev, road };
      CUT_R.classify(q.x - nx * 0.35, q.z - nz * 0.35, o, cls);
      if (o.road !== road || !CUT_MAT_OK.has(cls[1])) return cutNo('corner');
    } else q = curbProbe(px, pz, nx, nz, fixed);
    if (!q) return t < 0 || t > L ? cutNo('corner') : null;
    if (road < 0) road = q.road;
    if (q.road !== road) return cutNo('two streets');
    if (prev >= 0 && Math.abs(q.depth - prev) > 0.6) return cutNo('corner');
    prev = q.depth;
    if (t >= 0 && t <= L) { dmax = Math.max(dmax, q.depth); if (q.s !== undefined) { s0 = Math.min(s0, q.s); s1 = Math.max(s1, q.s); side = q.u; } }
    CUT_R.classify(q.x + nx * 0.6, q.z + nz * 0.6, o, cls);
    if (!CUT_CARRIAGE.has(cls[1]) && !(fixed && cls[1] === CUT_XWALK)) return cutNo(cls[1] === CUT_XWALK ? 'crosswalk' : 'corner');
    if (t > -xw && t < L + xw) for (let e = 0.6; e < 4.6; e += 0.5) { CUT_R.classify(q.x + nx * e, q.z + nz * e, o, cls); if (cls[1] === CUT_XWALK) return cutNo('crosswalk'); }
  }
  // a movable drive also keeps 6.5 m from the junction (crosswalk, stop line, the signal mast or stop sign on the
  // approach); intervals longer than 40 m are merged junction clusters along an avenue, measured by the curb walk
  if (s1 >= s0) for (const j of CUT_R.roads[road].junctions || []) {
    if (!j.major) continue;
    if (!fixed && j.b - j.a <= 40 && s1 > j.a - 6.5 && s0 < j.b + 6.5) return cutNo('junction');
    // where placeProps puts the approach's signal mast / stop sign (5.2 m before the interval, right-hand side)
    if ((side < 0 && s1 > j.a - 5.2 - 1.6 && s0 < j.a - 5.2 + 1.6) || (side > 0 && s1 > j.b + 5.2 - 1.6 && s0 < j.b + 5.2 + 1.6)) return cutNo('junction');
  }
  return { ax, az, bx, bz, nx, nz, depth: dmax + 0.05, road };
}
// fixed openings that cannot move (a downtown garage portal, a loading gap between buildings) only need their
// wings clear of the corner (1 m); drives a plug-in can still place keep 3 m
const CUT_MARGIN = { garage: 1, loading: 1 };
function cutLocal(E, x0, x1, kind) {
  const O = E.O, e1 = E.e1, e2 = E.e2;
  return cutFor(O[0] + e1[0] * x0 * BV, O[1] + e1[1] * x0 * BV, O[0] + e1[0] * x1 * BV, O[1] + e1[1] * x1 * BV, -e2[0], -e2[1], CUT_MARGIN[kind]);
}
function curbOK(E, x0, x1) { return !CUT_R || !!cutLocal(E, x0, x1); }
// a drive across a SIDE line of a corner lot onto the side street: side 'l' (x = 0) or 'r' (x = xs, the lot width),
// local z range [z0, z1)
function cutSide(E, side, xs, z0, z1, kind) {
  const O = E.O, e1 = E.e1, e2 = E.e2, x = side === 'l' ? 0 : xs, sg = side === 'l' ? -1 : 1;
  const P = (z) => [O[0] + (e1[0] * x + e2[0] * z) * BV, O[1] + (e1[1] * x + e2[1] * z) * BV];
  const [ax, az] = P(side === 'l' ? z1 : z0), [bx, bz] = P(side === 'l' ? z0 : z1);
  return cutFor(ax, az, bx, bz, sg * e1[0], sg * e1[1], CUT_MARGIN[kind]);
}
function curbOKSide(E, side, xs, z0, z1) { return !CUT_R || !!cutSide(E, side, xs, z0, z1); }
function drivewaySide(E, side, xs, z0, z1, kind) {
  if (!CUT_R) return false;
  const c = cutSide(E, side, xs, z0, z1, kind);
  if (!c) return false;
  c.kind = kind || 'drive'; CUTS.push(c);
  return true;
}
function curbFit(E, x0, x1, lo, hi) {
  if (!CUT_R) return [x0, x1];
  const w = x1 - x0;
  for (let k = 0; k <= Math.max(0, hi - lo); k += 2) for (const s of [-1, 1]) {
    const a = x0 + s * k;
    if (a < lo || a + w > hi) continue;
    if (cutLocal(E, a, a + w)) return [a, a + w];
    if (!k) break;
  }
  return null;
}
function driveway(E, x0, x1, kind) {
  if (!CUT_R) return false;
  const c = cutLocal(E, x0, x1, kind);
  if (!c) return false;
  c.kind = kind || 'drive'; CUTS.push(c);
  return true;
}
function cutWorld(ax, az, bx, bz, nx, nz, kind) {
  const c = cutFor(ax, az, bx, bz, nx, nz, CUT_MARGIN[kind]);
  if (!c) return false;
  c.kind = kind || 'drive'; CUTS.push(c);
  return true;
}

const LIB = {
  sinkPick, curbOK, curbFit, driveway, cutWorld, curbOKSide, drivewaySide, cutWhy: () => CUT_WHY,
  BV, BM, FH, BASE, Relief, bays, H2, pick, glassMat, facades, prism, roofMask, buildTiers, soffit, inset, rectMask, rotated, flatRoof,
  facadeMid, facadeGlassFloor, waterTank, skinPodium, skinDeco, skinDecoBase, skinCurtain, skinBronze, skinPilotis, skinFins, skinPomo,
  skinArcade, skinPrecast, skinLouver, decoCrownModel, lanternModel, mastsModel, craneModel, pyramidModel, pedimentModel, plazaModel,
  planterRowModel, VoxModel: () => C_VoxModel, cullHidden, coplanarPairs, planeOf, planSuburbs, roadAt, roadProject
};
// Blossom / flowering crowns: recolour the topmost voxel of a regular scatter of columns within r of the model's
// origin column to m (green showing through), so a flowering crown never reads as one flat pale slab. Every
// `every`-th column on a diagonal lattice (offset k); no new geometry.
LIB.dappleTop = function (M, r, m, every, k) {
  for (let x = -r; x <= r; ++x) for (let z = -r; z <= r; ++z) {
    if (x * x + z * z > r * r || ((x * 2 + z * 3 + k) % every + every) % every) continue;
    const X = x + M.ox, Z = z + M.oz;
    for (let y = M.h - 1; y >= 0; --y) if (M.at(X, y, Z)) { M.v[(y * M.d + Z) * M.w + X] = m + 1; break; }
  }
};
// Preview one tower type on an empty lot (tools / review): lot Wm x Dm metres, origin at the lot's front-left corner
function previewTower(name, Wm, Dm, floors, seed, C) {
  C_VoxModel = C.VoxModel;
  const t = TOWERS.find(x => x.name === name) || MIDS.find(x => x.name === name) || HOUSES.find(x => x.name === name);
  if (!t) throw new Error('unknown tower ' + name + '; known: ' + TOWERS.concat(MIDS, HOUSES).map(x => x.name).join(', '));
  const mb = new C.MeshBuffer();
  const E = new Emitter(mb, [0, 0], [1, 0], [0, 1], 0.15, 0.1);
  const W = Math.floor(Wm / BV), D = Math.floor(Dm / BV);
  t.fn(E, C, W, D, { seed, floors, party: {} }, C.mulberry32(seed), LIB);
  return mb.finish(0.002);
}
const CityArch = { registerHouse, houses: HOUSES, registerMid, mids: MIDS, previewTower, BV, BM, ARCH_PALETTE, LIT: [...LIT], buildAll, planAll, buildTile, exportPlan, importPlan, kitSlice, setKit, TILE_HALO, PAGE, PAGE_HALO, pageOf, pageRect, planPage, pagesPlan, pagesClassGrid, classKinds, lotRectangles, registerTower, lib: LIB, towers: TOWERS };
if (typeof module !== 'undefined' && module.exports) module.exports = CityArch; else root.CityArch = CityArch;
})(typeof self !== 'undefined' ? self : this);
