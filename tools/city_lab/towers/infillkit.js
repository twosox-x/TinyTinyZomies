// Infill kit: urban ground that no block, lot, park or service plan claimed (the bare PLOT / LOT raster left between
// the waterfront roads and the river, along the rail corridor, in odd block corners).
//
// CityArch.lib.infillKit(K) -> stats   (bake.js worker, per 128 m tile, after the tile's buildings / kits are built)
//   K = { net, C, R, F, mb, hs, voxel, region {x0, z0, x1, z1}, road (raster mesh, voxel units), bld (finished
//         building + kit mesh of the tile), plan (pagesPlan: halo jobs + kit of the pages around), props, owns }
//
// 1. An occupancy grid (0.5 m) of the tile: a cell is FREE when the road raster's top there is bare plot / lot
//    ground and no building, kit or halo-building quad, prop or neighbour lot covers it (walls are sampled along
//    their extent, not by bounding box). Water banks (sd > -7 m) and rail ballast are never free.
// 2. Free cells -> distance to the nearest non-free cell; candidates in order of decreasing room (hash tie-break).
//    Each candidate gets a use from its land use, its distance to the street and a position hash:
//      warehouse (industrial, rail-side, riverfront), small commercial building / gas station (commercial,
//      transition, old town, downtown near a street), surface parking lot with parked cars, vacant lot (chain-link
//      fence, weeds, rubble, a skip). Footprints are oriented to the nearest street (front faces it) and must lie on
//      free cells with a 1 m margin.
// 3. What is left: scrub (bushes, weeds, small trees) on a jittered grid so no large bare patch remains.
// Everything is deterministic from world-position hashes. Models are 25 cm voxels (cars: CityCore.Vehicles, 5 cm),
// sunk a few millimetres; slabs sit 2-3 cm above the ground so nothing is coplanar with the raster.
(function () {
'use strict';
const A = self.CityArch, L = A.lib;
const M_ = { PLOT: 11, LOT: 17, PARKING: 23, PAINT_W: 4, PAINT_Y: 5, CURB: 6, CONC: 70, BRICK: 71, BRICK_D: 72, BRICK_B: 73, BUFF: 76,
  SID_W: 77, CREAM: 81, TRIM: 84, TRIM_D: 85, GLASS: 86, GLASS_L: 87, TAR: 92, DOOR: 95, AWN_R: 96, AWN_G: 97, AWN_B: 98, METAL: 99,
  WOOD: 100, STORE: 102, SHUT_B: 104, SID_G: 108, CONC2: 109, DUMP_G: 126, DUMP_B: 127, PALLET: 129, STEEL: 130, LEAF: 133, LEAF_D: 134,
  TRUNK: 135, PAPER: 138, SOIL: 140, LOUVER: 151, GRASS: 155, STEEL_D: 156, WCONC: 157, TYRE: 176, RUST: 187, TUFT: 213, ROCK: 216,
  GRAVEL: 207, SIGN_W: 64, SIGN_R: 63, NEON: 153, LED: 154 };
const BV = 0.25;
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const CACHE = new Map();
const cached = (key, make) => { let v = CACHE.get(key); if (!v) { v = make(); CACHE.set(key, v); } return v; };
const FREE_MATS = new Set([M_.PLOT, M_.LOT]); for (let m = 30; m <= 53; ++m) FREE_MATS.add(m);

function oct(M, cx, cz, r, y0, y1, m) {
  if (y1 <= y0) return;
  const r2 = Math.max(1, Math.round(r * 0.62));
  M.box(cx - r, y0, cz - r2, cx + r, y1, cz + r2, m); M.box(cx - r2, y0, cz - r, cx + r2, y1, cz + r, m);
}
// ------------------------------------------------------------------------------------------------ models (+z = front)
function warehouse(C, w, d, h, vr) {         // w, d, h in voxels (25 cm)
  return cached(`wh${w},${d},${h},${vr}`, () => {
    const VM = C.VoxModel, M = new VM(w + 4, h + 4, d + 4, (w >> 1) + 2, (d >> 1) + 2);
    const x0 = -(w >> 1), z0 = -(d >> 1), x1 = x0 + w, z1 = z0 + d;
    const wall = [M_.METAL, M_.SID_G, M_.BRICK_D, M_.BUFF, M_.CONC][vr % 5], band = [M_.STEEL_D, M_.TRIM_D, M_.CONC2, M_.BRICK_B, M_.STEEL][vr % 5];
    M.box(x0, 0, z0, x1, h, z1, wall);
    M.box(x0, 0, z0, x1, 2, z1, M_.CONC);                                      // plinth
    M.box(x0 - 1, h, z0 - 1, x1 + 1, h + 1, z1 + 1, band);                     // parapet cap
    M.box(x0, h, z0, x1, h + 1, z1, M_.TAR);
    if (wall === M_.METAL || wall === M_.SID_G) for (let x = x0; x < x1; x += 3) { M.box(x, 2, z1, x + 1, h, z1 + 1, band); M.box(x, 2, z0 - 1, x + 1, h, z0, band); }
    const nd = Math.max(1, Math.floor((w - 8) / 18));                          // roll-up dock doors on the front
    for (let k = 0; k < nd; ++k) {
      const cx = x0 + Math.round((k + 0.5) * w / nd) - 7;
      M.box(cx, 0, z1, cx + 14, 16, z1 + 1, M_.STEEL);
      for (let y = 2; y < 16; y += 2) M.box(cx, y, z1, cx + 14, y + 1, z1 + 1, M_.STEEL_D);
      M.box(cx - 1, 16, z1, cx + 15, 17, z1 + 2, M_.TRIM_D);
      M.box(cx + 5, 17, z1, cx + 9, 18, z1 + 1, M_.LED);
    }
    M.box(x1 - 8, 0, z1, x1 - 4, 9, z1 + 1, M_.DOOR);                          // office door + window band
    for (let x = x0 + 3; x < x1 - 10; x += 8) if (h > 22) M.box(x, h - 8, z1, x + 5, h - 5, z1 + 1, M_.GLASS);
    for (let x = x0 + 3; x < x1 - 3; x += 8) M.box(x, h - 8, z0 - 1, x + 5, h - 5, z0, M_.GLASS);
    if (vr & 1) { M.box(x0 + 4, h + 1, z0 + 4, x0 + 10, h + 4, z0 + 9, M_.LOUVER); M.box(x1 - 12, h + 1, z0 + 6, x1 - 7, h + 3, z0 + 10, M_.METAL); }
    M.box(x0 + 2, h - 4, z1, x0 + 14, h - 1, z1 + 1, M_.SIGN_W);                // company sign
    return { mesh: C.meshVoxels3D(M) };
  });
}
function shop(C, w, d, h, vr) {             // one- / two-storey commercial building with a storefront band
  return cached(`sh${w},${d},${h},${vr}`, () => {
    const VM = C.VoxModel, M = new VM(w + 6, h + 6, d + 8, (w >> 1) + 3, (d >> 1) + 3);
    const x0 = -(w >> 1), z0 = -(d >> 1), x1 = x0 + w, z1 = z0 + d;
    const wall = [M_.BRICK, M_.BUFF, M_.CREAM, M_.BRICK_B, M_.SID_W, M_.CONC2][vr % 6], awn = [M_.AWN_R, M_.AWN_G, M_.AWN_B][vr % 3];
    M.box(x0, 0, z0, x1, h, z1, wall);
    M.box(x0 - 1, h, z0 - 1, x1 + 1, h + 2, z1 + 1, M_.TRIM);
    M.box(x0, h, z0, x1, h + 1, z1, M_.TAR);
    M.box(x0 + 1, 0, z1, x1 - 1, 11, z1 + 1, M_.STORE);                        // storefront
    for (let x = x0 + 2; x < x1 - 2; x += 6) M.box(x, 1, z1, x + 5, 10, z1 + 1, (x / 6 + vr) & 1 ? M_.GLASS_L : M_.GLASS);
    M.box(-2, 0, z1, 2, 9, z1 + 1, M_.DOOR);
    M.box(x0 + 1, 11, z1, x1 - 1, 14, z1 + 1, M_.SIGN_W);                       // sign band
    M.box(x0 + 3, 12, z1 + 1, x1 - 3, 13, z1 + 2, vr & 1 ? M_.NEON : M_.SIGN_R);
    if (vr % 3 !== 2) for (let k = 0; k < 4; ++k) M.box(x0 + 1, 10 - k, z1 + 1 + k, x1 - 1, 11 - k, z1 + 2 + k, k & 1 ? M_.TRIM : awn);   // awning
    if (h > 18) for (let x = x0 + 2; x < x1 - 2; x += 6) { M.box(x, 18, z1, x + 4, 23, z1 + 1, M_.GLASS); M.box(x, 18, z0 - 1, x + 4, 23, z0, M_.GLASS); }
    M.box(x1 - 7, h + 1, z0 + 3, x1 - 3, h + 4, z0 + 7, M_.METAL);              // rooftop AC
    M.box(x0 + 3, 0, z0 - 1, x0 + 7, 9, z0, M_.SHUT_B);                         // back door
    return { mesh: C.meshVoxels3D(M) };
  });
}
function gasStation(C, vr) {               // canopy over two pump islands, kiosk store behind (front = +z)
  return cached('gas' + vr, () => {
    const VM = C.VoxModel, M = new VM(80, 26, 88, 40, 44);
    const col = [M_.AWN_R, M_.AWN_B, M_.AWN_G][vr % 3];
    M.box(-36, 0, -40, 36, 1, 40, M_.CONC);                                      // forecourt slab (1 voxel)
    M.box(-30, 1, 6, 30, 18, 7, M_.STEEL);                                       // (hidden) canopy spine below the deck
    M.box(-32, 18, -4, 32, 21, 30, M_.WCONC); M.box(-32, 19, -4, 32, 20, 30, col);
    M.box(-32, 18, 29, 32, 21, 30, col); M.box(-32, 18, -4, 32, 21, -3, col);
    for (const x of [-22, 18]) for (const z of [4, 20]) M.box(x, 1, z, x + 4, 18, z + 2, M_.WCONC);
    for (const x of [-24, 16]) { M.box(x, 1, 2, x + 8, 2, 24, M_.CURB); for (const z of [8, 16]) M.box(x + 2, 2, z, x + 6, 8, z + 3, col); }
    M.box(-26, 1, -38, 26, 14, -20, M_.WCONC);                                   // store
    M.box(-24, 1, -20, 24, 10, -19, M_.GLASS_L); M.box(-3, 1, -20, 3, 9, -19, M_.DOOR);
    M.box(-26, 14, -38, 26, 16, -19, col);
    M.box(30, 1, 32, 32, 26, 34, M_.STEEL); M.box(28, 18, 31, 34, 25, 35, col);  // price pylon
    return { mesh: C.meshVoxels3D(M) };
  });
}
function fencePanel(C, len, gate) {        // chain-link: posts every 2.5 m, 5 wires (reads see-through at RTS range), along +x, 10 cm voxels
  return cached('fen' + len + (gate ? 'g' : ''), () => {
    const VM = C.VoxModel, n = Math.round(len / 0.1), M = new VM(n + 2, 22, 2, 0, 1);
    for (let x = 0; x <= n; x += 25) M.box(x, 0, 0, x + 1, 21, 1, M_.STEEL);
    M.box(n - 1, 0, 0, n, 21, 1, M_.STEEL);
    for (const y of [2, 6, 10, 14, 19]) M.box(0, y, 0, n, y + 1, 1, M_.STEEL_D);
    M.box(0, 20, 0, n, 21, 1, M_.STEEL);
    if (gate) M.box(Math.round(n / 2) - 1, 0, 0, Math.round(n / 2) + 1, 21, 1, M_.STEEL);
    return { mesh: C.meshVoxels3D(M) };
  });
}
function bush(C, vr) {
  return cached('bu' + vr, () => {
    const R = C.mulberry32(4447 + vr * 31), VM = C.VoxModel, r = 3 + Math.floor(R() * 4), h = 3 + Math.floor(R() * 5), M = new VM(2 * r + 4, h + 2, 2 * r + 4, r + 2, r + 2);
    oct(M, 0, 0, r, 0, h, [M_.LEAF_D, M_.LEAF, M_.GRASS, M_.TUFT][vr % 4]);
    oct(M, Math.round(R() * 2 - 1), Math.round(R() * 2 - 1), Math.max(1, r - 2), h, h + 1, M_.LEAF);
    return { mesh: C.meshVoxels3D(M), r: r * BV };
  });
}
function weeds(C, vr) {                    // a patch of tall weeds / grass (10 cm voxels)
  return cached('we' + vr, () => {
    const R = C.mulberry32(7121 + vr * 17), VM = C.VoxModel, M = new VM(34, 10, 34, 17, 17);
    for (let k = 0; k < 40; ++k) { const x = Math.floor((R() - 0.5) * 28), z = Math.floor((R() - 0.5) * 28); if (x * x + z * z > 196) continue; M.box(x, 0, z, x + 1, 2 + Math.floor(R() * 7), z + 1, R() < 0.6 ? M_.TUFT : R() < 0.5 ? M_.GRASS : M_.LEAF_D); }
    return { mesh: C.meshVoxels3D(M) };
  });
}
function scrubTree(C, vr) {
  return cached('st' + vr, () => {
    const R = C.mulberry32(5521 + vr * 13), VM = C.VoxModel, ht = 22 + Math.floor(R() * 14), rc = 6 + Math.floor(R() * 4);
    const M = new VM(2 * rc + 6, ht + 2, 2 * rc + 6, rc + 3, rc + 3);
    M.box(-1, 0, -1, 1, Math.round(ht * 0.6), 1, M_.TRUNK);
    const lo = [M_.LEAF_D, M_.GRASS, M_.LEAF][vr % 3];
    oct(M, 0, 0, rc, Math.round(ht * 0.35), Math.round(ht * 0.8), lo);
    oct(M, Math.round(R() * 4 - 2), Math.round(R() * 4 - 2), Math.max(2, rc - 3), Math.round(ht * 0.8), ht, M_.LEAF);
    return { mesh: C.meshVoxels3D(M), r: rc * BV };
  });
}
function rubble(C, vr) {                   // debris pile / pallets / tyres / a skip (25 cm voxels)
  return cached('ru' + vr, () => {
    const R = C.mulberry32(6007 + vr * 19), VM = C.VoxModel, M = new VM(20, 10, 20, 10, 10), k = vr % 4;
    if (k === 0) { for (let i = 0; i < 18; ++i) { const x = Math.floor((R() - 0.5) * 10), z = Math.floor((R() - 0.5) * 10), hh = Math.max(1, 4 - Math.round(Math.hypot(x, z) / 2)); M.box(x, 0, z, x + 2, hh, z + 2, [M_.CONC, M_.BRICK, M_.SOIL, M_.ROCK][i % 4]); } }
    else if (k === 1) { for (let i = 0; i < 3; ++i) M.box(-3 + i, i, -3, 3 + i, i + 1, 2, M_.PALLET); M.box(-2, 3, -2, 2, 6, 1, M_.PAPER); }
    else if (k === 2) { for (let i = 0; i < 4; ++i) { const x = (i % 2) * 4 - 3, z = Math.floor(i / 2) * 4 - 3; M.box(x, 0, z, x + 3, 1 + (i & 1), z + 3, M_.TYRE); } }
    else { M.box(-7, 0, -3, 7, 5, 4, R() < 0.5 ? M_.DUMP_G : M_.RUST); M.box(-6, 1, -2, 6, 5, 3, M_.SOIL); M.box(-6, 4, -2, 6, 5, 3, M_.CONC); }
    return { mesh: C.meshVoxels3D(M) };
  });
}
function slab(C, w, d, mat, stripes) {      // ground slab (10 cm voxels, 1 voxel thick: top 0.1 m over its base) with stall stripes along +x
  return cached(`sl${w},${d},${mat},${stripes ? 1 : 0}`, () => {
    const VM = C.VoxModel, M = new VM(w + 2, 3, d + 2, (w >> 1) + 1, (d >> 1) + 1);
    const x0 = -(w >> 1), z0 = -(d >> 1);
    M.box(x0, 0, z0, x0 + w, 1, z0 + d, mat);
    if (stripes) for (const zr of stripes) for (let x = x0 + 4; x < x0 + w - 4; x += 26) M.box(x, 1, zr[0], x + 1, 2, zr[1], M_.PAINT_W);
    return { mesh: C.meshVoxels3D(M) };
  });
}

function infillKit(K) {
  const { net, C, mb, hs, voxel: V, region: rg } = K;
  if (!net || !rg || !K.road) return null;
  const t0 = Date.now(), q0 = mb.quads, PV = C.PV, seed = (net.seed | 0) + 7717;
  const stats = { warehouse: 0, shop: 0, gas: 0, parking: 0, cars: 0, vacant: 0, scrub: 0, freeM2: 0, quads: 0, ms: 0 };
  const CELL = 0.5, N = Math.round((rg.x1 - rg.x0) / CELL), NZ = Math.round((rg.z1 - rg.z0) / CELL);
  const gm = new Int16Array(N * NZ).fill(-1), gy = new Float32Array(N * NZ).fill(-1e9), occ = new Uint8Array(N * NZ);
  const ci = (x, z) => { const ix = Math.floor((x - rg.x0) / CELL), iz = Math.floor((z - rg.z0) / CELL); return ix < 0 || iz < 0 || ix >= N || iz >= NZ ? -1 : iz * N + ix; };
  // ---- 1. ground raster tops (axis-aligned up quads)
  const Rm = K.road;
  for (let q = 0; q < Rm.quads; ++q) {
    if (Rm.nrm[q * 4] !== 0) continue;
    const o = q * 12, P = Rm.pos;
    const ax = Math.min(P[o], P[o + 3], P[o + 6], P[o + 9]) * V, bx = Math.max(P[o], P[o + 3], P[o + 6], P[o + 9]) * V;
    const az = Math.min(P[o + 2], P[o + 5], P[o + 8], P[o + 11]) * V, bz = Math.max(P[o + 2], P[o + 5], P[o + 8], P[o + 11]) * V, y = P[o + 1] * V;
    for (let iz = Math.max(0, Math.floor((az - rg.z0) / CELL)); iz < Math.min(NZ, Math.ceil((bz - rg.z0) / CELL)); ++iz)
      for (let ix = Math.max(0, Math.floor((ax - rg.x0) / CELL)); ix < Math.min(N, Math.ceil((bx - rg.x0) / CELL)); ++ix) {
        const cx = rg.x0 + (ix + 0.5) * CELL, cz = rg.z0 + (iz + 0.5) * CELL;
        if (cx < ax || cx > bx || cz < az || cz > bz) continue;
        const k = iz * N + ix; if (y > gy[k]) { gy[k] = y; gm[k] = Rm.mat[q * 4]; }
      }
  }
  // ---- occupancy: every quad of a mesh sampled over its extent (0.35 m steps), anything above ground + 3 cm
  const markMesh = (Mh, unit, filter) => {
    if (!Mh) return;
    const P = Mh.pos;
    for (let q = 0; q < Mh.quads; ++q) {
      if (filter && !filter(q)) continue;
      const o = q * 12, x0 = P[o] * unit, y0 = P[o + 1] * unit, z0 = P[o + 2] * unit;
      const ux = (P[o + 3] - P[o]) * unit, uz = (P[o + 5] - P[o + 2]) * unit, vx = (P[o + 9] - P[o]) * unit, vz = (P[o + 11] - P[o + 2]) * unit;
      const ymax = Math.max(P[o + 1], P[o + 4], P[o + 7], P[o + 10]) * unit;
      if (ymax < hs + 0.03 && y0 < hs + 0.03) continue;
      const nu = Math.max(1, Math.ceil(Math.hypot(ux, uz) / 0.35)), nv = Math.max(1, Math.ceil(Math.hypot(vx, vz) / 0.35));
      if (nu * nv > 40000) continue;
      for (let a = 0; a <= nu; ++a) for (let b = 0; b <= nv; ++b) { const k = ci(x0 + ux * a / nu + vx * b / nv, z0 + uz * a / nu + vz * b / nv); if (k >= 0) occ[k] = 1; }
    }
  };
  markMesh(K.bld, V);
  const pl = K.plan;
  if (pl && pl.kit && pl.kitB) {                     // kit quads of the pages around (neighbours' parks / service yards)
    const KB = pl.kitB;
    markMesh(pl.kit, V, (q) => KB[q * 4 + 2] * V > rg.x0 - 2 && KB[q * 4] * V < rg.x1 + 2 && KB[q * 4 + 3] * V > rg.z0 - 2 && KB[q * 4 + 1] * V < rg.z1 + 2);
  }
  const markRect = (O, e1, e2, w, d, pad) => {      // oriented rectangle (frame O + a e1 + b e2, a in [0, w], b in [0, d])
    const nu = Math.ceil((w + 2 * pad) / 0.35), nv = Math.ceil((d + 2 * pad) / 0.35);
    for (let a = 0; a <= nu; ++a) for (let b = 0; b <= nv; ++b) {
      const s = -pad + (w + 2 * pad) * a / nu, t = -pad + (d + 2 * pad) * b / nv;
      const k = ci(O[0] + e1[0] * s + e2[0] * t, O[1] + e1[1] * s + e2[1] * t); if (k >= 0) occ[k] = 1;
    }
  };
  if (pl && pl.jobs) for (const J of pl.jobs) {      // lots of every job near the tile (own and halo): their whole frame
    if (!J.bb || J.bb[2] < rg.x0 - 4 || J.bb[0] > rg.x1 + 4 || J.bb[3] < rg.z0 - 4 || J.bb[1] > rg.z1 + 4) continue;
    if (J.O && J.e1 && J.e2 && J.W && J.D) markRect(J.O, J.e1, J.e2, J.W * 0.25, J.D * 0.25, 0.5);
    else if (J.L && J.L.O) markRect(J.L.O, J.L.e1, J.L.e2, J.L.w * V, J.L.d * V, 0.5);
  }
  for (const p of K.props || []) { const r = 1.0; for (let dz = -r; dz <= r; dz += 0.5) for (let dx = -r; dx <= r; dx += 0.5) { const k = ci(p.x + dx, p.z + dz); if (k >= 0) occ[k] = 1; } }
  // free cells
  const free = new Uint8Array(N * NZ);
  let nFree = 0;
  for (let iz = 0; iz < NZ; ++iz) for (let ix = 0; ix < N; ++ix) {
    const k = iz * N + ix;
    if (occ[k] || !FREE_MATS.has(gm[k]) || gy[k] < 0.05 || gy[k] > 0.4) continue;
    const x = rg.x0 + (ix + 0.5) * CELL, z = rg.z0 + (iz + 0.5) * CELL;
    if (C.waterSD && C.waterSD(net, x, z) > -7) continue;
    free[k] = 1; ++nFree;
  }
  stats.freeM2 = nFree * CELL * CELL;
  if (nFree < 40) { stats.ms = Date.now() - t0; return stats; }
  // distance (m) to the nearest non-free cell (two-pass chamfer)
  const D = new Float32Array(N * NZ);
  for (let k = 0; k < N * NZ; ++k) D[k] = free[k] ? 1e9 : 0;
  const c1 = CELL, c2 = CELL * Math.SQRT2;
  for (let iz = 0; iz < NZ; ++iz) for (let ix = 0; ix < N; ++ix) { const k = iz * N + ix; if (!D[k]) continue; let d = D[k];
    if (ix > 0) d = Math.min(d, D[k - 1] + c1); else d = Math.min(d, c1);
    if (iz > 0) { d = Math.min(d, D[k - N] + c1); if (ix > 0) d = Math.min(d, D[k - N - 1] + c2); if (ix < N - 1) d = Math.min(d, D[k - N + 1] + c2); } else d = Math.min(d, c1 * 40);
    D[k] = d; }
  for (let iz = NZ - 1; iz >= 0; --iz) for (let ix = N - 1; ix >= 0; --ix) { const k = iz * N + ix; if (!D[k]) continue; let d = D[k];
    if (ix < N - 1) d = Math.min(d, D[k + 1] + c1);
    if (iz < NZ - 1) { d = Math.min(d, D[k + N] + c1); if (ix < N - 1) d = Math.min(d, D[k + N + 1] + c2); if (ix > 0) d = Math.min(d, D[k + N - 1] + c2); }
    D[k] = d; }
  // (cells at the tile edge: the neighbour tile has its own grid, so the edge is treated as 20 m of open room; footprints
  //  must still lie fully inside this tile)
  // ---- emit helpers (as ruralkit put: copies sunk a few mm; faces resting on the ground skipped)
  const quadW = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, Nx, Ny, Nz) => {
    const Ax = ax / V, Ay = ay / V, Az = az / V, Bx = bx / V, By = by / V, Bz = bz / V, Cx = cx / V, Cy = cy / V, Cz = cz / V, Dx = dx / V, Dy = dy / V, Dz = dz / V;
    const ux = Bx - Ax, uy = By - Ay, uz = Bz - Az, vx = Cx - Ax, vy = Cy - Ay, vz = Cz - Az;
    const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
    if (crx * Nx + cry * Ny + crz * Nz < 0) mb.quadN(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz, Bx, By, Bz, m, Nx, Ny, Nz);
    else mb.quadN(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz, Dx, Dy, Dz, m, Nx, Ny, Nz);
  };
  const put = (m, x, y, z, yaw, sh) => {             // y: world metres of the model's base
    const c = Math.cos(yaw), s = Math.sin(yaw), P = m.pos, fh = sh / PV;
    if (L.debugPlace) L.debugPlace({ kit: 'infill', mesh: m, map: (u, yy, v) => [x + (u * c - v * s) * fh, y + yy * fh, z + (u * s + v * c) * fh] });
    const X = new Float64Array(4), Y = new Float64Array(4), Z = new Float64Array(4);
    for (let q = 0; q < m.quads; ++q) {
      const n = m.nrm[q * 4], o = q * 12;
      if (n === 5 && P[o + 1] === 0 && P[o + 4] === 0 && P[o + 7] === 0 && P[o + 10] === 0) continue;
      for (let i = 0; i < 4; ++i) { const u = P[o + i * 3] * fh, v = P[o + i * 3 + 2] * fh; X[i] = x + u * c - v * s; Y[i] = y + P[o + i * 3 + 1] * fh; Z[i] = z + u * s + v * c; }
      const Nn = NV[n];
      quadW(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], X[3], Y[3], Z[3], m.mat[q * 4], Nn[0] * c - Nn[2] * s, Nn[1], Nn[0] * s + Nn[2] * c);
    }
  };
  // ---- local frame: front (+z of a model) faces the nearest street; -grad of the carriageway distance field
  const F = K.F, o = {};
  const carD = (x, z) => { F.sample(x, z, o); return o.road < 0 || o.car > 900 ? 999 : o.car; };
  const frame = (x, z) => {
    const e = 1.5, gx = carD(x + e, z) - carD(x - e, z), gz = carD(x, z + e) - carD(x, z - e), l = Math.hypot(gx, gz);
    if (!(l > 1e-6) || carD(x, z) > 400) return { f: [0, 1], d: 999 };
    // snap to 15 degrees: straight streets give exact frames, curved ones near enough
    let a = Math.atan2(-gz / l, -gx / l); a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    return { f: [Math.cos(a), Math.sin(a)], d: carD(x, z) };
  };
  const used = new Uint8Array(N * NZ);
  // does an oriented rect centred at (x, z), front f, half sizes (hw along the street, hd towards it) fit?
  const fits = (x, z, f, hw, hd, pad) => {
    const r = [f[1], -f[0]];
    for (let a = -hw - pad; a <= hw + pad + 1e-6; a += 0.4) for (let b = -hd - pad; b <= hd + pad + 1e-6; b += 0.4) {
      const px = x + r[0] * a + f[0] * b, pz = z + r[1] * a + f[1] * b;
      if (px < rg.x0 + 0.3 || px >= rg.x1 - 0.3 || pz < rg.z0 + 0.3 || pz >= rg.z1 - 0.3) return false;
      const k = ci(px, pz); if (k < 0 || !free[k] || used[k]) return false;
    }
    return true;
  };
  const claim = (x, z, f, hw, hd, pad) => {
    const r = [f[1], -f[0]];
    for (let a = -hw - pad; a <= hw + pad + 1e-6; a += 0.35) for (let b = -hd - pad; b <= hd + pad + 1e-6; b += 0.35) { const k = ci(x + r[0] * a + f[0] * b, z + r[1] * a + f[1] * b); if (k >= 0) used[k] = 1; }
  };
  const baseY = (x, z, f, hw, hd) => {               // highest ground under the footprint
    const r = [f[1], -f[0]]; let y = -1e9;
    for (const a of [-hw, 0, hw]) for (const b of [-hd, 0, hd]) { const k = ci(x + r[0] * a + f[0] * b, z + r[1] * a + f[1] * b); if (k >= 0 && gy[k] > -1e8) y = Math.max(y, gy[k]); }
    return y > -1e8 ? y : hs;
  };
  const yawOf = (f) => Math.atan2(-f[0], f[1]);        // model +z -> f
  let sinkN = 0;
  const sink = () => 0.002 + 0.004 * (sinkN++ % 12);
  // ---- 2. candidates by decreasing room
  const cand = [];
  for (let iz = 1; iz < NZ - 1; iz += 4) for (let ix = 1; ix < N - 1; ix += 4) { const k = iz * N + ix; if (free[k] && D[k] >= 2.5) cand.push([D[k] + 0.5 * C.hash2(ix, iz, seed), ix, iz]); }
  cand.sort((a, b) => b[0] - a[0]);
  const H = (x, z, s) => C.hash2(Math.round(x * 2), Math.round(z * 2), seed + s);
  for (const [, ix, iz] of cand) {
    const k = iz * N + ix; if (used[k]) continue;
    const x = rg.x0 + (ix + 0.5) * CELL, z = rg.z0 + (iz + 0.5) * CELL;
    const { f, d: dr } = frame(x, z), r = [f[1], -f[0]];
    const lu = C.landUseAt ? C.landUseAt(net, x, z) : 'transition', h1 = H(x, z, 1), h2 = H(x, z, 2), h3 = H(x, z, 3);
    const riverside = C.waterSD && C.waterSD(net, x, z) > -45;
    const indus = lu === 'industial' || lu === 'industrial' || lu === 'rail' || (net.plan && net.plan.rail && C.isRural && false);
    const urban = ['core', 'downtown', 'oldtown', 'commercial', 'transition', 'industrial'].includes(lu);
    const tries = [];
    if (urban && dr < 30 && h1 < 0.12 && (lu === 'commercial' || lu === 'transition')) tries.push('gas');
    if (indus || riverside || (urban && h1 < 0.35)) tries.push('warehouse');
    if (urban && dr < 26) tries.push('shop');
    tries.push('parking', 'vacant');
    if (h2 < 0.5 && tries.length > 2) { const t = tries.shift(); tries.splice(1, 0, t); }
    let done = false;
    for (const t of tries) {
      if (done) break;
      if (t === 'warehouse') {
        for (const sc of [1, 0.75, 0.55]) {
          const w = Math.round((18 + 16 * h3) * sc / 2) * 2, d = Math.round((14 + 10 * h2) * sc / 2) * 2, apron = 6;
          const hw = w / 2, hd = (d + apron) / 2;
          if (w < 10 || d < 9) continue;
          if (!fits(x, z, f, hw, hd, 1)) continue;
          const cz = -apron / 2;                     // building at the back, apron in front (towards the street)
          const bx = x + f[0] * cz, bz = z + f[1] * cz, y = baseY(x, z, f, hw, hd);
          const hv = 24 + Math.floor(h1 * 12);
          put(warehouse(C, Math.round(w / BV), Math.round(d / BV), hv, Math.floor(h3 * 97) % 10).mesh, bx, y - sink(), bz, yawOf(f), BV);
          const ax = x + f[0] * (d / 2), az = z + f[1] * (d / 2);
          put(slab(C, Math.round(w * 10) - 4, Math.round(apron * 10) - 4, M_.CONC, null).mesh, ax, y + 0.02 + sink() * 0.5, az, yawOf(f), 0.1);
          // a truck or van at a dock door, pallets
          if (h2 < 0.6 && C.Vehicles) { const vk = h2 < 0.3 ? 'box_truck' : 'panel_van', vm = vehMesh(C, vk, Math.floor(h1 * 7));
            if (vm) { const px = ax + r[0] * (-hw * 0.35), pz = az + r[1] * (-hw * 0.35); put(vm.mesh, px, y + 0.12 + 0.002, pz, Math.atan2(f[1], f[0]), 0.05 * vm.sc); stats.cars++; } }
          put(rubble(C, 1 + 4 * Math.floor(h3 * 3)).mesh, ax + r[0] * hw * 0.7, y + 0.12, az + r[1] * hw * 0.7, yawOf(f), BV);
          claim(x, z, f, hw, hd, 1.5); stats.warehouse++; done = true; break;
        }
      } else if (t === 'shop') {
        for (const sc of [1, 0.8]) {
          const w = Math.round((10 + 8 * h3) * sc), d = Math.round((10 + 5 * h2) * sc), hw = w / 2, hd = d / 2 + 1.5;
          if (!fits(x, z, f, hw, hd, 0.8)) continue;
          const y = baseY(x, z, f, hw, hd), hv = h1 < 0.5 ? 16 : 26;
          put(shop(C, Math.round(w / BV), Math.round(d / BV), hv, Math.floor(h3 * 89) % 12).mesh, x - f[0] * 0.75, y - sink(), z - f[1] * 0.75, yawOf(f), BV);
          claim(x, z, f, hw, hd, 1.2); stats.shop++; done = true; break;
        }
      } else if (t === 'gas') {
        if (!fits(x, z, f, 9.5, 10.5, 0.8)) continue;
        const y = baseY(x, z, f, 9, 10);
        put(gasStation(C, Math.floor(h3 * 3)).mesh, x, y + 0.02 - 0.2, z, yawOf(f), BV);
        claim(x, z, f, 9.5, 10.5, 1.2); stats.gas++; done = true;
      } else if (t === 'parking') {
        // rows of 2.6 m stalls, 5.2 m deep, a 6.5 m aisle between double rows; along the street
        for (const rows of [2, 1]) {
          const dd = rows === 2 ? 5.2 * 2 + 6.5 : 5.2 + 6.5;
          for (const ww of [26, 18, 10.4]) {
            const hw = ww / 2, hd = dd / 2;
            if (!fits(x, z, f, hw, hd, 0.6)) continue;
            const y = baseY(x, z, f, hw, hd), yaw = yawOf(f);
            const W10 = Math.round(ww * 10), D10 = Math.round(dd * 10);
            const zr = rows === 2 ? [[-(D10 >> 1), -(D10 >> 1) + 52], [(D10 >> 1) - 52, D10 >> 1]] : [[-(D10 >> 1), -(D10 >> 1) + 52]];
            put(slab(C, W10, D10, M_.PARKING, zr).mesh, x, y + 0.02 + 0.001 * (sinkN++ % 5), z, yaw, 0.1);
            const nst = Math.floor((ww - 0.8) / 2.6);
            for (let rI = 0; rI < rows; ++rI) for (let sI = 0; sI < nst; ++sI) {
              const hh = C.hash2(Math.round(x * 3) + sI, Math.round(z * 3) + rI * 31, seed + 17);
              if (hh > 0.62) continue;
              const a = -hw + 0.4 + 1.3 + sI * 2.6, b = rI === 0 ? -hd + 2.6 : hd - 2.6;
              const px = x + r[0] * a + f[0] * b, pz = z + r[1] * a + f[1] * b;
              const kinds = ['sedan', 'suv', 'hatchback', 'pickup', 'minivan', 'sedan', 'coupe', 'suv'];
              const vm = vehMesh(C, kinds[Math.floor(hh * 13) % kinds.length], Math.floor(hh * 977) % 9);
              if (!vm) continue;
              // car +x = nose: nose into the stall (towards the slab edge) or reversed in
              const nose = (rI === 0 ? -1 : 1) * (hh < 0.15 ? -1 : 1), dir = [f[0] * nose, f[1] * nose];
              put(vm.mesh, px, y + 0.12 + 0.002, pz, Math.atan2(dir[1], dir[0]), 0.05 * vm.sc);
              stats.cars++;
            }
            claim(x, z, f, hw, hd, 1.0); stats.parking++; done = true; break;
          }
          if (done) break;
        }
      } else if (t === 'vacant') {
        // fenced vacant lot: chain-link on the street side and the sides, weeds, rubble, a skip, scrub
        for (const sz of [[22, 16], [14, 12], [9, 8]]) {
          const hw = sz[0] / 2, hd = sz[1] / 2;
          if (!fits(x, z, f, hw, hd, 0.4)) continue;
          const y = baseY(x, z, f, hw, hd);
          const fy = y - 0.003 - 0.002 * (sinkN++ % 4);
          const fl = fencePanel(C, sz[0], true), fs = fencePanel(C, sz[1], false);
          put(fl.mesh, x + f[0] * hd - r[0] * hw, fy, z + f[1] * hd - r[1] * hw, Math.atan2(r[1], r[0]), 0.1);   // front: +x along r
          put(fs.mesh, x - r[0] * hw - f[0] * hd, fy, z - r[1] * hw - f[1] * hd, Math.atan2(f[1], f[0]), 0.1);
          put(fs.mesh, x + r[0] * hw - f[0] * hd, fy, z + r[1] * hw - f[1] * hd, Math.atan2(f[1], f[0]), 0.1);
          const R = C.mulberry32((seed ^ Math.round(x * 7) * 73856093 ^ Math.round(z * 7) * 19349663) >>> 0);
          const nW = Math.round(sz[0] * sz[1] / 14);
          for (let i = 0; i < nW; ++i) { const a = (R() - 0.5) * (sz[0] - 2), b = (R() - 0.5) * (sz[1] - 2); put(weeds(C, Math.floor(R() * 6)).mesh, x + r[0] * a + f[0] * b, y - 0.001 * (i % 5), z + r[1] * a + f[1] * b, R() * 6.28, 0.1); }
          for (let i = 0; i < Math.max(1, Math.round(sz[0] * sz[1] / 90)); ++i) { const a = (R() - 0.5) * (sz[0] - 5), b = (R() - 0.5) * (sz[1] - 5); put(rubble(C, Math.floor(R() * 8)).mesh, x + r[0] * a + f[0] * b, y - 0.004 - 0.001 * i, z + r[1] * a + f[1] * b, R() * 6.28, BV); }
          if (sz[0] > 12) { const T = scrubTree(C, Math.floor(R() * 6)), a = (R() < 0.5 ? -1 : 1) * (hw - T.r - 0.6), b = -hd + T.r + 0.6; put(T.mesh, x + r[0] * a + f[0] * b, y - 0.005, z + r[1] * a + f[1] * b, R() * 6.28, BV); }
          claim(x, z, f, hw, hd, 0.8); stats.vacant++; done = true; break;
        }
      }
    }
  }
  // ---- 3. scrub on what is left (jittered 3.5 m grid): bushes, weed patches, the odd small tree
  const S = 3.5;
  for (let gz = Math.floor(rg.z0 / S); gz * S < rg.z1; ++gz) for (let gx = Math.floor(rg.x0 / S); gx * S < rg.x1; ++gx) {
    const h1 = C.hash2(gx, gz, seed + 51), h2 = C.hash2(gx, gz, seed + 53), h3 = C.hash2(gx, gz, seed + 57);
    const x = (gx + 0.2 + 0.6 * h1) * S, z = (gz + 0.2 + 0.6 * h2) * S, k = ci(x, z);
    if (k < 0 || !free[k] || used[k] || D[k] < 1.2) continue;
    if (h3 < 0.16 && D[k] > 2.6) { const T = scrubTree(C, Math.floor(h1 * 61) % 6); if (D[k] < T.r + 0.6) continue; put(T.mesh, x, gy[k] - 0.004 - 0.002 * (gx & 3), z, h2 * 6.28, BV); }
    else if (h3 < 0.5) { const B = bush(C, Math.floor(h2 * 53) % 8); if (D[k] < B.r + 0.4) continue; put(B.mesh, x, gy[k] - 0.003 - 0.002 * (gz & 3), z, h1 * 6.28, BV); }
    else if (h3 < 0.9) put(weeds(C, Math.floor(h1 * 41) % 6).mesh, x, gy[k] - 0.001 - 0.001 * ((gx + gz) & 3), z, h2 * 6.28, 0.1);
    else if (D[k] > 2) put(rubble(C, Math.floor(h2 * 37) % 8).mesh, x, gy[k] - 0.005, z, h1 * 6.28, BV);
    else continue;
    stats.scrub++;
  }
  stats.quads = mb.quads - q0; stats.ms = Date.now() - t0;
  return stats;
}
// CityCore.Vehicles model, meshed once per (kind, variant); sc: shrink so it fits a 2.0 x 5.0 m stall
function vehMesh(C, kind, vr) {
  return cached('veh' + kind + vr, () => {
    try {
      const r = C.Vehicles.model(kind, { seed: 101 + vr * 7919 });
      const sc = Math.min(1, (kind === 'box_truck' ? 8.5 : 4.9) / r.len, 2.2 / r.wid);
      return { mesh: C.meshVoxels3D(r.M), sc };
    } catch (e) { return null; }
  });
}
L.infillKit = infillKit;
})();
