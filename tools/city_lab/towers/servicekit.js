/* City Lab service kit: the back-of-house of downtown and old-town blocks.
 *
 * Runs once at the end of CityArch.buildAll, after every building is emitted, and dresses the land the block placer
 * left free (service courts in deep blocks, yards behind alley buildings, the 4-6 m gaps between buildings) and the
 * alleys themselves:
 *  - along back and side walls: dumpsters (sizes, colours, lids open or shut, bags beside them), grease bins, rows of
 *    roll carts, pallet stacks, cardboard, gas-meter manifolds, electric meter panels, back doors with a lamp;
 *  - gaps that open onto a street are closed by a chain-link fence with a double gate (wire or privacy slats), or
 *    used as a loading bay (van / box truck nosed out, roll-up dock door on the wall);
 *  - alleys get dumpsters and carts against the curbs and the odd parked van; blind alleys are gated at the mouth,
 *    some through alleys have their gates swung open.
 * Models are 5 cm voxels (CityCore.PV, the street-furniture scale), meshed once per variant and emitted into the
 * building mesh as rigidly placed copies. Ground items are sunk one voxel into the ground slab, wall items are
 * recessed into the wall plane, fence posts keep a voxel clear of the walls: no coplanar faces. Deterministic per
 * seed (hashes of block / lot ids and positions).
 */
(function () {
'use strict';
const A = self.CityArch, L = A.lib, BM = L.BM;

function serviceKit(K) {
  const { PL, R: Ra, C, occ, blocks, jobs, hs, voxel, mb } = K;
  if (!blocks || !PL.base) return null;
  const PM = C.PM, PV = C.PV, MAT = C.MAT;
  const V = C.VoxModel;
  const H2 = L.H2;
  const counts = { tris: 0, q0: mb.quads, where: {} };
  const cnt = (k, x, z) => { counts[k] = (counts[k] || 0) + 1; if (x !== undefined && (counts.where[k] = counts.where[k] || []).length < 4) counts.where[k].push([+x.toFixed(1), +z.toFixed(1)]); };

  // ------------------------------------------------------------------------------------------ models (5 cm voxels)
  // Local frame: +x along the wall, +z away from the wall (z = 0 is the wall plane / the back of the item), y up.
  const cache = new Map();
  const mesh = (key, fn) => { let m = cache.get(key); if (!m) { m = C.meshVoxels3D(fn()); cache.set(key, m); } return m; };
  const rnd = (s) => { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // front-load dumpster: w x d x h voxels, sloped front, black plastic lids (one may be flipped open against the
  // wall, trash showing), fork pockets, casters, a small decal
  function dumpster(w, d, h, col, open, seed) {
    const hw = w >> 1, M = new V(w + 4, open ? h + d - 7 : h + 2, d + 4, hw + 2, 3);
    for (let y = 2; y < h; ++y) {
      const z1 = y > h - 7 ? d - 1 - (y - (h - 7)) : d - 1;
      M.box(-hw + 1, y, 2, hw - 1, y + 1, z1, col);
    }
    M.box(-hw + 1, 1, 3, hw - 1, 2, d - 2, PM.POLE_DARK);
    for (const x of [-hw + 2, hw - 5]) for (const z of [3, d - 5]) M.box(x, 0, z, x + 3, 2, z + 3, PM.HOUSING);
    for (const x of [-hw, hw - 1]) M.box(x, h - 11, 6, x + 1, h - 8, d - 6, PM.POLE_DARK);
    M.box(-hw + 1, h - 2, 1, hw - 1, h - 1, 3, PM.POLE_DARK);                           // hinge rail at the back
    const zl = d - 7;                                                                  // lid depth (top is level)
    if (open === 0) M.box(-hw + 1, h, 2, hw - 1, h + 1, zl, PM.HOUSING);
    else {
      const side = open > 0 ? 1 : -1, xs = side > 0 ? [1, hw - 1] : [-hw + 1, -1], xo = side > 0 ? [-hw + 1, 0] : [0, hw - 1];
      M.box(xo[0], h, 2, xo[1], h + 1, zl, PM.HOUSING);
      M.box(xs[0], h, 0, xs[1], h + zl - 2, 1, PM.HOUSING);                             // lid flipped up, leaning back
      const R = rnd(seed);
      for (let x = xs[0]; x < xs[1] - 2; x += 3) for (let z = 3; z < zl - 1; z += 3) {
        const t = R(); M.box(x, h - 2, z, x + 3, h - (t < 0.3 ? 0 : 1), z + 3, t < 0.55 ? PM.HOUSING : t < 0.8 ? PM.PAPER : PM.CARDBOARD);
      }
    }
    M.box(-4, 8, d - 1, 4, 12, d, PM.SIGN_WHITE);
    return M;
  }
  function bags(seed, n) {               // a heap of tied garbage bags (black, white, the odd green)
    const R = rnd(seed), M = new V(30, 18, 22, 15, 1);
    for (let k = 0; k < n; ++k) {
      const x = -13 + Math.round(R() * 18), z = Math.round(R() * 10), s = 6 + Math.round(R() * 3), y0 = k >= 4 ? 5 : 0;
      const m = R() < 0.6 ? PM.HOUSING : R() < 0.75 ? PM.PAPER : PM.DUMP_GREEN;
      M.box(x, y0, z, x + s, y0 + s - 1, z + s, m).box(x + 1, y0 + s - 1, z + 1, x + s - 1, y0 + s, z + s - 1, m);
      M.box(x + (s >> 1) - 1, y0 + s, z + (s >> 1) - 1, x + (s >> 1) + 1, y0 + s + 2, z + (s >> 1) + 1, m);
    }
    return M;
  }
  function greaseBin() {                  // used cooking oil bin: dark body, black lid with a lock, yellow label
    const M = new V(20, 24, 16, 10, 1);
    M.box(-8, 1, 1, 8, 19, 13, PM.POLE_DARK).box(-9, 19, 0, 9, 21, 14, PM.HOUSING).box(-2, 16, 14, 2, 19, 15, PM.STEEL);
    M.box(-6, 8, 13, 6, 13, 14, PM.UMB_YELLOW);
    for (const x of [-8, 5]) M.box(x, 0, 2, x + 3, 1, 12, PM.HOUSING);
    return M;
  }
  function rollCarts(cols) {              // a row of wheeled carts, lids shut, wheels and handles at the wall side
    const n = cols.length, M = new V(n * 14 + 4, 24, 18, n * 7 + 2, 1);
    cols.forEach((c, k) => {
      const x = -n * 7 + k * 14 + 1;
      M.box(x, 2, 1, x + 12, 19, 14, c).box(x, 19, 1, x + 12, 21, 15, c === PM.STEEL ? PM.HOUSING : c);
      M.box(x + 1, 19, 0, x + 11, 20, 1, PM.HOUSING);
      for (const xx of [x, x + 10]) M.box(xx, 0, 1, xx + 2, 4, 4, PM.HOUSING);
    });
    return M;
  }
  function pallets(k, seed) {             // a stack of k wooden pallets (1.2 x 1.0 m), slightly out of line
    const R = rnd(seed), M = new V(30, k * 3 + 2, 24, 15, 1);
    for (let i = 0; i < k; ++i) {
      const dx = Math.round(R() * 2 - 1), y = i * 3;
      for (const x of [-12, -2, 9]) M.box(x + dx, y, 1, x + dx + 3, y + 2, 21, PM.CARDBOARD);
      for (let z = 1; z < 21; z += 3) M.box(-12 + dx, y + 2, z, 12 + dx, y + 3, z + 2, PM.PALLET);
    }
    return M;
  }
  function cardboard() {                  // flattened cardboard tied in a bale, a couple of loose boxes on top
    const M = new V(26, 22, 20, 13, 1);
    M.box(-11, 0, 1, 11, 12, 17, PM.CARDBOARD).box(-11, 12, 1, 11, 13, 17, PM.BENCH_WOOD);
    for (const x of [-6, 4]) M.box(x, 0, 0, x + 1, 13, 18, PM.HOUSING);
    M.box(-8, 13, 4, 0, 19, 12, PM.CARDBOARD).box(2, 13, 6, 8, 17, 14, PM.BENCH_WOOD);
    return M;
  }
  function gasMeters(n) {                 // gas service: riser from the ground, manifold, n meters, pipes into the wall
    const w = n * 9 + 4, M = new V(w + 4, 30, 10, (w >> 1) + 2, 3);
    const x0 = -(w >> 1);
    M.box(x0, 0, 2, x0 + 2, 9, 4, PM.UMB_YELLOW).box(x0, 7, 2, x0 + w, 9, 4, PM.UMB_YELLOW);
    for (let k = 0; k < n; ++k) {
      const x = x0 + 3 + k * 9;
      M.box(x + 2, 9, 2, x + 4, 12, 4, PM.UMB_YELLOW);
      M.box(x, 12, 1, x + 7, 20, 6, PM.STEEL).box(x + 2, 15, 6, x + 5, 18, 7, PM.PAPER);
      M.box(x + 2, 20, -2, x + 4, 22, 3, PM.UMB_YELLOW);                               // into the wall
    }
    return M;
  }
  function electricPanel() {             // meter bank on the wall, conduit down into the ground
    const M = new V(26, 46, 10, 13, 3);
    M.box(-10, 24, -2, 10, 40, 3, PM.STEEL).box(-10, 40, -2, 10, 41, 4, PM.POLE);
    for (const x of [-7, -1, 5]) M.box(x, 30, 3, x + 3, 34, 4, PM.PAPER);
    M.box(-8, 0, 1, -6, 24, 3, PM.POLE).box(6, 0, 1, 8, 24, 3, PM.POLE);
    M.box(-3, 36, 3, 3, 38, 4, PM.SIGN_RED);
    return M;
  }
  // dumpster enclosure: concrete-block walls on three sides with a cap, chain-link gates swung open at the front
  function enclosure(w, d) {
    const hw = w >> 1, M = new V(w + 4, 40, d + 40, hw + 2, 2);
    const wall = (x0, z0, x1, z1) => M.box(x0, 0, z0, x1, 34, z1, PM.CONCRETE).box(x0, 34, z0, x1, 36, z1, BM.LIMESTONE_DARK);
    wall(-hw, 0, hw, 4); wall(-hw, 4, -hw + 4, d); wall(hw - 4, 4, hw, d);
    for (const sx of [-1, 1]) {                                    // open gate leaves, swung out against the wall ends
      const x = sx < 0 ? -hw + 1 : hw - 2;
      M.box(x, 2, d + 1, x + 1, 32, d + 2, PM.POLE);
      M.box(sx < 0 ? x - 1 : x + 1, 2, d + 2, sx < 0 ? x : x + 2, 32, d + 30, PM.POLE);
      for (let z = d + 4; z < d + 30; z += 3) M.box(sx < 0 ? x - 1 : x + 1, 4, z, sx < 0 ? x : x + 2, 30, z + 1, PM.STEEL);
    }
    return M;
  }
  function backDoor(col) {                // steel service door in a frame, recessed into the wall, step, lamp above
    const M = new V(30, 58, 12, 15, 3);
    M.box(-11, 1, -2, 11, 48, 1, PM.POLE_DARK).box(-9, 1, -2, 9, 44, 2, col);
    M.box(4, 20, 2, 7, 22, 3, PM.STEEL);
    M.box(-13, 0, -2, 13, 3, 6, PM.CONCRETE);
    M.box(-3, 50, -2, 3, 54, 4, PM.POLE_DARK).box(-2, 49, 0, 2, 50, 3, PM.LAMP_LENS);
    return M;
  }
  function dockDoor() {                   // roll-up loading door, bumpers, lamp
    const M = new V(70, 72, 12, 35, 3);
    M.box(-32, 1, -2, 32, 66, 1, PM.POLE_DARK);
    for (let y = 1; y < 62; y += 3) M.box(-30, y, -2, 30, y + 2, 2, PM.STEEL).box(-30, y + 2, -2, 30, y + 3, 1, PM.POLE);
    for (const x of [-26, 22]) M.box(x, 18, -2, x + 4, 26, 4, PM.HOUSING);
    M.box(-3, 67, -2, 3, 70, 4, PM.POLE_DARK).box(-2, 66, 0, 2, 67, 3, PM.LAMP_LENS);
    return M;
  }
  // chain-link fence with a double gate across a span of len voxels (+x), posts a voxel clear of the walls at
  // both ends. slats: privacy slats (solid panels) instead of open wire. open: leaves swung back against the sides
  function fence(len, slats, col, open) {
    const M = open ? new V(len + 2, 46, 40, 1, 4) : new V(len + 2, 46, 6, 1, 4);
    const post = (x) => M.box(x, 0, -2, x + 3, 42, 1, PM.POLE);
    const mid = len >> 1;
    const panel = (x0, x1, z0, z1) => {           // one leaf: frame + fabric between x0..x1 (or along z when z1 > z0 + 1)
      const alongZ = z1 - z0 > 1;
      const B = (a0, y0, a1, y1, m) => alongZ ? M.box(x0, y0, Math.min(a0, a1), x0 + 1, y1, Math.max(a0, a1), m) : M.box(a0, y0, z0, a1, y1, z0 + 1, m);
      const a0 = alongZ ? z0 : x0, a1 = alongZ ? z1 : x1;
      B(a0, 3, a1, 5, PM.POLE); B(a0, 37, a1, 39, PM.POLE);
      B(a0, 5, a0 + 1, 37, PM.POLE); B(a1 - 1, 5, a1, 37, PM.POLE);
      if (slats) B(a0 + 1, 5, a1 - 1, 37, col);
      else { for (let a = a0 + 3; a < a1 - 1; a += 3) B(a, 5, a + 1, 37, PM.STEEL); B(a0 + 1, 20, a1 - 1, 21, PM.POLE); }
    };
    post(1); post(len - 4);
    if (!open) {
      post(mid - 2);
      panel(4, mid - 2, -1, 0); panel(mid + 1, len - 4, -1, 0);
      M.box(mid - 2, 0, -2, mid + 1, 42, 1, PM.POLE);
      M.box(mid - 1, 18, 1, mid + 1, 22, 2, PM.HOUSING);                              // padlock + chain
    } else {
      // leaves swung back, parallel to the sides of the opening
      panel(4, 0, 2, Math.min(34, mid - 2));
      panel(len - 5, 0, 2, Math.min(34, mid - 2));
    }
    for (const x of [1, len - 4]) for (let k = 0; k < 3; ++k) M.box(x + 1, 42 + k, -1 - k, x + 2, 43 + k, 0 - k, PM.POLE_DARK);
    M.box(1, 43, -2, len - 1, 44, -1, PM.POLE_DARK);                                  // barbed strand
    return M;
  }
  // vehicles are shared with the street furniture (CityCore.PROP_TYPES: van*, truck*), +x is the front
  const VAN = ['van', 'van', 'vanBlue', 'vanGrey'], TRUCK = ['truck', 'truckBlue', 'truckGreen'];
  const vehicle = (k) => mesh(k, C.PROP_TYPES[k]);

  // ------------------------------------------------------------------------------------------ emission
  // a model at world (ox, oz) with its +x along (ax, az), its +z along (bx, bz), base at height y0 (metres)
  const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  function put(m, ox, oz, ax, az, bx, bz, y0) {
    const P = m.pos, iv = 1 / voxel;
    const W = (k) => [(ox + P[k] * ax + P[k + 2] * bx) * iv, (y0 + P[k + 1]) * iv, (oz + P[k] * az + P[k + 2] * bz) * iv];
    for (let q = 0; q < m.quads; ++q) {
      const k = q * 12, n = NV[m.nrm[q * 4]], N = [n[0] * ax + n[2] * bx, n[1], n[0] * az + n[2] * bz];
      const a = W(k), b = W(k + 3), c = W(k + 6), d = W(k + 9);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const s = (uy * vz - uz * vy) * N[0] + (uz * vx - ux * vz) * N[1] + (ux * vy - uy * vx) * N[2];
      if (s < 0) mb.quadN(...a, ...d, ...c, ...b, m.mat[q * 4], ...N);
      else mb.quadN(...a, ...b, ...c, ...d, m.mat[q * 4], ...N);
    }
    counts.tris += m.quads * 2;
  }

  // ------------------------------------------------------------------------------------------ land
  const nx = PL.nx, nz = PL.nz, cell = PL.cell, lab = blocks.lab, handled = blocks.handled;
  const pIdx = (x, z) => { const i = Math.floor((x - PL.x0) / cell), j = Math.floor((z - PL.z0) / cell); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
  // what is at a point: 'free' (buildable block land, nothing on it), 'bld', 'street', 'alley', 'open', 'out'
  const uc = 0.25, ux0 = occ.x0, uz0 = occ.z0, unx = Math.ceil(occ.nx * occ.c / uc), unz = Math.ceil(occ.nz * occ.c / uc);
  const used = new Uint8Array(unx * unz);
  const usedAt = (x, z) => { const i = Math.floor((x - ux0) / uc), j = Math.floor((z - uz0) / uc); return i < 0 || j < 0 || i >= unx || j >= unz ? 1 : used[j * unx + i]; };
  const what = (x, z) => {
    if (inFootprint(x, z, 0.04)) return 'bld';
    const i = pIdx(x, z); if (i < 0) return 'out';
    const b = PL.base[i];
    if (b === 1) return handled.has(lab[i]) ? 'free' : 'out';
    return b === 3 ? 'street' : b === 4 ? 'alley' : b === 2 ? 'open' : 'out';
  };
  // exact footprints (the occupancy grid is 0.5 m): spatial hash of job rectangles, 0.08 m margin
  const fpHash = new Map(), FH = 8;
  jobs.forEach((J, k) => {
    const wm = J.W * A.BV, dm = J.D * A.BV, xs = [0, wm].flatMap(a => [0, dm].map(b => J.O[0] + a * J.e1[0] + b * J.e2[0])), zs = [0, wm].flatMap(a => [0, dm].map(b => J.O[1] + a * J.e1[1] + b * J.e2[1]));
    for (let j = Math.floor(Math.min(...zs) / FH); j <= Math.floor(Math.max(...zs) / FH); ++j)
      for (let i = Math.floor(Math.min(...xs) / FH); i <= Math.floor(Math.max(...xs) / FH); ++i) { const key = i * 65537 + j; let a = fpHash.get(key); if (!a) fpHash.set(key, a = []); a.push(k); }
  });
  const inFootprint = (x, z, mg) => {
    for (const k of fpHash.get(Math.floor(x / FH) * 65537 + Math.floor(z / FH)) || []) {
      const J = jobs[k], dx = x - J.O[0], dz = z - J.O[1], a = dx * J.e1[0] + dz * J.e1[1], b = dx * J.e2[0] + dz * J.e2[1];
      if (a > -mg && a < J.W * A.BV + mg && b > -mg && b < J.D * A.BV + mg) return true;
    }
    return false;
  };
  const free = (x, z) => what(x, z) === 'free' && !usedAt(x, z);
  // a frame: origin o, along a (unit), out b (unit); point at (u, v)
  const F = (o, a, b) => ({ o, a, b, at: (u, v) => [o[0] + u * a[0] + v * b[0], o[1] + u * a[1] + v * b[1]] });
  const rectAll = (f, u0, u1, v0, v1, test, step) => {
    step = step || 0.25;
    for (let v = v0; v <= v1 + 1e-6; v += step) for (let u = u0; u <= u1 + 1e-6; u += step) { const [x, z] = f.at(Math.min(u, u1), Math.min(v, v1)); if (!test(x, z)) return false; }
    return true;
  };
  const mark = (f, u0, u1, v0, v1) => {
    for (let v = v0; v <= v1 + 1e-6; v += uc * 0.7) for (let u = u0; u <= u1 + 1e-6; u += uc * 0.7) {
      const [x, z] = f.at(Math.min(u, u1), Math.min(v, v1));
      const i = Math.floor((x - ux0) / uc), j = Math.floor((z - uz0) / uc);
      if (i >= 0 && j >= 0 && i < unx && j < unz) used[j * unx + i] = 1;
    }
  };
  const nearStreet = (f, u0, u1, v0, v1, pad) => !rectAll(f, u0 - pad, u1 + pad, v0 - pad, v1 + pad, (x, z) => { const w = what(x, z); return w !== 'street' && w !== 'open'; }, 0.5);
  const yG = hs - PV;                                         // ground items: one voxel into the slab

  // exact distance from p along unit dir to the nearest building footprint (jobs), up to max
  function rayToBuilding(p, dir, max) {
    let best = max;
    for (const J of jobs) {
      const wm = J.W * A.BV, dm = J.D * A.BV, dx = p[0] - J.O[0], dz = p[1] - J.O[1];
      if (Math.abs(dx) + Math.abs(dz) > wm + dm + max + 1) continue;
      const pa = dx * J.e1[0] + dz * J.e1[1], pb = dx * J.e2[0] + dz * J.e2[1];
      const da = dir[0] * J.e1[0] + dir[1] * J.e1[1], db = dir[0] * J.e2[0] + dir[1] * J.e2[1];
      let t0 = 0, t1 = best;
      for (const [p0, d0, lo, hi] of [[pa, da, 0, wm], [pb, db, 0, dm]]) {
        if (Math.abs(d0) < 1e-9) { if (p0 < lo || p0 > hi) { t0 = 1; t1 = 0; } continue; }
        let a = (lo - p0) / d0, b = (hi - p0) / d0; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (t0 <= t1 && t0 < best) best = t0;
    }
    return best;
  }
  // ------------------------------------------------------------------------------------------ catalogue
  const DCOL = [PM.DUMP_GREEN, PM.DUMP_GREEN, PM.DUMP_BLUE, PM.RUST, PM.STEEL, PM.DUMP_BLUE];
  const CART = [PM.DUMP_GREEN, PM.DUMP_BLUE, PM.HOUSING, PM.STEEL, PM.DUMP_GREEN];
  const DOOR = [BM.DOOR_RED, BM.DOOR_NAVY, PM.STEEL, BM.SHUTTER_GREEN, PM.POLE_DARK, BM.TRIM];
  // item: { m: mesh, w: width (m, along the wall), d: depth (m), wall: true if mounted on / recessed into the wall }
  const item = (kind, R, small) => {
    const s = (R() * 1e9) >>> 0;
    switch (kind) {
      case 'dumpster': {
        const big = !small && R() < 0.55, col = DCOL[Math.floor(R() * DCOL.length)], open = R() < 0.35 ? (R() < 0.5 ? 1 : -1) : 0;
        const w = big ? 40 : 32, d = big ? 32 : 24, h = big ? 28 : 24;
        return { m: mesh(`d${w}_${col}_${open}_${open ? s % 2 : 0}`, () => dumpster(w, d, h, col, open, s % 2)), w: w * PV + 0.3, d: d * PV + 0.3, kind };
      }
      case 'bags': { const v = s % 5; return { m: mesh('b' + v, () => bags(v * 7919 + 3, 3 + v)), w: 1.5, d: 1.1, kind }; }
      case 'grease': return { m: mesh('g', greaseBin), w: 1.0, d: 0.8, kind };
      case 'carts': {
        const n = 2 + (s % 3), k = (s >> 3) % 3, cols = []; for (let i = 0; i < n; ++i) cols.push(CART[(k + (i === n - 1 ? 2 : 0)) % CART.length]);
        return { m: mesh('c' + cols.join('_'), () => rollCarts(cols)), w: n * 0.7 + 0.2, d: 0.85, kind };
      }
      case 'pallets': { const k = 1 + (s % 5); return { m: mesh('p' + k, () => pallets(k, k * 31)), w: 1.5, d: 1.15, kind }; }
      case 'cardboard': return { m: mesh('cb', cardboard), w: 1.3, d: 1.0, kind };
      case 'gas': { const n = 2 + (s % 3); return { m: mesh('gas' + n, () => gasMeters(n)), w: (n * 9 + 8) * PV, d: 0.4, wall: true, kind }; }
      case 'panel': return { m: mesh('ep', electricPanel), w: 1.3, d: 0.25, wall: true, kind };
      case 'enclosure': {
        const two = R() < 0.6, w = two ? 96 : 54, d = 44;
        const parts = [{ m: mesh('enc' + w, () => enclosure(w, d)), du: 0, dv: 0 }];
        for (let k = 0; k < (two ? 2 : 1); ++k) {
          const col = DCOL[Math.floor(R() * DCOL.length)], open = R() < 0.4 ? 1 : 0;
          parts.push({ m: mesh(`d40_${col}_${open}_${open ? s % 2 : 0}`, () => dumpster(40, 32, 28, col, open, s % 2)), du: two ? (k ? 1.1 : -1.1) : 0, dv: 0.3 });
        }
        return { m: null, parts, w: w * PV + 0.2, d: d * PV + 1.4, kind };
      }
      case 'door': { const c = DOOR[s % DOOR.length]; return { m: mesh('door' + c, () => backDoor(c)), w: 1.5, d: 0.35, wall: true, kind }; }
    }
    return null;
  };

  // lay out items along a wall frame f (u along the wall, v away from it) within [u0, u1], needing `depth` of
  // free land in front of each item plus an access strip; returns the number placed
  function alongWall(f, u0, u1, list, R, wallOk) {
    let u = u0, placed = 0;
    for (const it of list) {
      if (!it) continue;
      if (it.wall && !wallOk) continue;
      const need = it.d + (it.kind === 'dumpster' ? 0.8 : 0.5), v0 = it.wall ? 0.06 : 0.15;
      let at = -1;
      for (let t = u; t + it.w <= u1; t += 0.25) {
        if (!rectAll(f, t, t + it.w, v0, need, free)) continue;
        if (nearStreet(f, t, t + it.w, 0, it.d, 1.2)) continue;
        at = t; break;
      }
      if (at < 0) continue;
      const vv = it.wall ? 0 : 0.15 + R() * 0.15, cu = at + it.w / 2;
      const [ox, oz] = f.at(cu, vv);
      if (it.parts) for (const pt of it.parts) { const [px, pz] = f.at(cu + pt.du, vv + pt.dv); put(pt.m, px, pz, f.a[0], f.a[1], f.b[0], f.b[1], yG); }
      else put(it.m, ox, oz, f.a[0], f.a[1], f.b[0], f.b[1], yG);
      if (counts.where && (counts.where[it.kind] = counts.where[it.kind] || []).length < 4) counts.where[it.kind].push([+ox.toFixed(1), +oz.toFixed(1)]);
      mark(f, at - 0.1, at + it.w + 0.1, 0, it.d + 0.5);
      cnt(it.kind); placed++;
      u = at + it.w + 0.2 + R() * (it.kind === 'dumpster' ? 0.6 : 1.2);
    }
    return placed;
  }
  // free depth profile in front of a wall: for u in [0, len] step 0.5 -> { d, stop }
  function profile(f, len) {
    const out = [];
    for (let u = 0.25; u < len; u += 0.5) {
      let v = 0.3, stop = 'max';
      for (; v < 10; v += 0.25) { const [x, z] = f.at(u, v); const w = what(x, z); if (w !== 'free') { stop = w; break; } }
      out.push({ u, d: v - 0.3, stop });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ building sides
  for (const J of jobs) {
    if (J.tag === undefined || J.kind === 'house') continue;           // block-placed (downtown / old town) only
    const wm = J.W * A.BV, dm = J.D * A.BV, e1 = J.e1, e2 = J.e2, O = J.O;
    const R = rnd((H2(J.seed, 77, 5) * 4294967296) >>> 0);
    const P = (a, b) => [O[0] + a * e1[0] + b * e2[0], O[1] + a * e1[1] + b * e2[1]];
    const small = J.kind === 'row', wallOk = J.kind !== 'tower';
    const sides = [
      { name: 'back', f: F(P(0, dm), e1, e2), len: wm },
      { name: 'left', f: F(P(0, 0), e2, [-e1[0], -e1[1]]), len: dm },
      { name: 'right', f: F(P(wm, 0), e2, e1), len: dm }
    ];
    for (const S of sides) {
      if (S.len < 3) continue;
      // quick reject: no free land 1 m out from the wall at any of 9 points along it
      let any = false;
      for (let k = 0; k < 9 && !any; ++k) { const [x, z] = S.f.at(S.len * (k + 0.5) / 9, 1.0); any = what(x, z) === 'free'; }
      if (!any) continue;
      const pr = profile(S.f, S.len);
      const deep = pr.filter(p => p.d >= 1.6).length * 0.5;
      if (deep < 1.6) continue;
      let u0 = 0.4;
      if (S.name !== 'back') {
        // a gap between buildings that opens onto the street: fence it, or use it as a loading bay
        const fr = pr.slice(0, 3);
        let gw = Math.min(...fr.map(p => p.d)) + 0.3;
        const toStreet = [-0.75, -1.5, -2.5].some(du => { const [sx, sz] = S.f.at(du, Math.max(0.6, gw / 2)); return what(sx, sz) === 'street'; });
        if (toStreet && gw >= 3.4 && gw <= 9 && fr.every(p => p.stop === 'bld')) {
          const uf = 0.6 + R() * 0.8;
          gw = Math.min(gw + 0.6, rayToBuilding(S.f.at(uf, 0.01), S.f.b, 10)) - 0.01;   // exact width at the fence
          const gf = F(S.f.at(uf, 0), S.f.b, S.f.a);                       // along the gap's width
          const run = pr.filter(p => p.d >= gw - 0.6).length * 0.5;
          if (rectAll(gf, 0.2, gw - 0.2, -0.2, 0.2, (x, z) => !usedAt(x, z))) {
            let loading = run >= 9.5 && gw >= 4.2 && R() < 0.35;
            if (loading && !rectAll(S.f, 0.6, 0.9 + 7.6, gw / 2 - 1.3, gw / 2 + 1.3, free)) loading = false;
            if (loading) {
              const truck = run >= 11 && gw >= 4.6 && R() < 0.6, Lm = truck ? 7.6 : 5.8;
              const vm = vehicle(truck ? TRUCK[Math.floor(R() * TRUCK.length)] : VAN[Math.floor(R() * VAN.length)]);
              const cu = 0.8 + Lm / 2, cv = gw / 2;
              const [ox, oz] = S.f.at(cu, cv);
              put(vm, ox, oz, -S.f.a[0], -S.f.a[1], S.f.b[0], S.f.b[1], yG);
              mark(S.f, 0, cu + Lm / 2 + 0.6, 0.1, gw - 0.1);
              cnt(truck ? 'truck' : 'van', ox, oz);
              // the vehicle drives in over a curb cut across the sidewalk at the gap's mouth
              if (L.cutWorld) { const [ax, az] = S.f.at(0, 0.1), [bx, bz] = S.f.at(0, gw - 0.1); L.cutWorld(ax, az, bx, bz, -S.f.a[0], -S.f.a[1], 'loading'); }
              // dock door on the wall behind the vehicle's rear
              const du = cu + Lm / 2 + 0.4;
              if (du + 3.6 < S.len && rectAll(S.f, du, du + 3.4, 0.1, 1.2, free)) {
                const [dx, dz] = S.f.at(du + 1.7, 0);
                put(mesh('dock', dockDoor), dx, dz, S.f.a[0], S.f.a[1], S.f.b[0], S.f.b[1], yG);
                mark(S.f, du, du + 3.4, 0, 1.8); cnt('dock');
              }
              u0 = cu + Lm / 2 + 4.2;
            } else {
              const slats = R() < 0.45, col = slats ? (R() < 0.6 ? PM.DUMP_GREEN : PM.POLE_DARK) : 0;
              const len = Math.round((gw - 0.1) / PV);
              const open = R() < 0.18;
              const fm = mesh(`f${len}_${slats ? col : 0}_${open ? 1 : 0}`, () => fence(len, slats, col, open));
              // fence model: +x across the gap from this wall, +z towards the back of the gap
              const [ox, oz] = gf.at(0.05, 0);
              put(fm, ox, oz, gf.a[0], gf.a[1], gf.b[0], gf.b[1], yG);
              mark(gf, 0, gw, -0.3, 0.3);
              cnt(open ? 'gateOpen' : 'fence', ox, oz);
              u0 = uf + 1.4;
            }
          }
        }
      }
      // the dressing: a cluster or two of bins and stuff, the odd wall item
      if (R() > (S.name === 'back' ? 0.92 : 0.7)) continue;
      const clusters = S.len > 26 ? 3 : S.len > 14 ? 2 : 1;
      const span = (S.len - u0) / clusters;
      for (let c = 0; c < clusters; ++c) {
        const a = u0 + c * span, b = a + span;
        const list = [];
        if (small) {
          list.push(item('carts', R)); if (R() < 0.5) list.push(item('bags', R));
          if (R() < 0.3) list.push(item('dumpster', R, true));
          if (R() < 0.5) list.unshift(item('gas', R));
        } else {
          const k = R();
          if (R() < 0.6) list.push(item(R() < 0.6 ? 'door' : 'panel', R));
          list.push(item(R() < 0.3 ? 'enclosure' : 'dumpster', R));
          if (k < 0.55) list.push(item('bags', R));
          if (R() < 0.45) list.push(item('dumpster', R));
          if (R() < 0.3) list.push(item('grease', R));
          if (R() < 0.35) list.push(item('carts', R));
          if (R() < 0.35) list.push(item(R() < 0.6 ? 'pallets' : 'cardboard', R));
          if (R() < 0.35) list.push(item('gas', R));
        }
        const st = a + R() * Math.max(0, span - 6) * 0.5;
        alongWall(S.f, st, b - 0.3, list, R, wallOk);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ alleys
  const o = {}, cls = [0, 0];
  const isAlley = (x, z, id) => { Ra.classify(x, z, o, cls); return o.road === id && cls[1] === MAT.ALLEY; };
  for (const r of PL.net.roads) {
    if (r.P.id !== 'alley' || !r.len) continue;
    const half = r.P.half;
    const R = rnd((r.id * 2654435761 ^ (PL.seed || 1) * 40503) >>> 0);
    const Js = (r.junctions || []);
    const fr = (s) => { const [px, pz, tx, tz] = C.pointAt(r, s); return { p: [px, pz], t: [tx, tz], n: [tz, -tx] }; };
    const inJ = (s, pad) => Js.some(j => s > j.a - pad && s < j.b + pad);
    // mouths: alley ends that meet another road; blind ends do not
    const atStart = Js.find(j => j.a < 4), atEnd = Js.find(j => j.b > r.len - 4);
    const blind = !atStart || !atEnd;
    for (const [jj, dir] of [[atStart, 1], [atEnd, -1]]) {
      if (!jj) continue;
      if (!blind && R() > 0.35) continue;
      for (const off of [2.2, 3, 4, 5]) {
        const s = dir > 0 ? jj.b + off : jj.a - off;
        if (s < 1 || s > r.len - 1 || inJ(s, 0.5)) continue;
        const f = fr(s), sp = half + 0.42;
        const ends = [[-1], [1]].map(([k]) => [f.p[0] + f.n[0] * sp * k, f.p[1] + f.n[1] * sp * k]);
        if (ends.some(([x, z]) => { const w = what(x, z); return w === 'bld' || w === 'street'; })) continue;
        const len = Math.round((2 * sp) / PV), open = !blind;
        const m = mesh(`f${len}_0_${open ? 1 : 0}`, () => fence(len, false, 0, open));
        // +x across the alley, +z into the alley (away from the mouth)
        const bx = f.t[0] * dir, bz = f.t[1] * dir;
        put(m, ends[0][0], ends[0][1], f.n[0], f.n[1], bx, bz, -PV);
        cnt(open ? 'alleyGateOpen' : 'alleyGate', ends[0][0], ends[0][1]);
        break;
      }
    }
    // dumpsters, carts and bags against the curbs, a parked van now and then (one side at a time)
    let s = 7 + R() * 6, last = { 1: -99, [-1]: -99 };
    while (s < r.len - 7) {
      if (inJ(s, 6)) { s += 2; continue; }
      const side = R() < 0.5 ? 1 : -1, t = R();
      const it = t < 0.5 ? item('dumpster', R) : t < 0.68 ? item('carts', R) : t < 0.8 ? item('bags', R) : t < 0.88 ? item('grease', R) : null;
      const f = fr(s);
      if (!it) {                                       // a van along the curb
        if (s + 6 < r.len - 7 && !inJ(s + 6, 6) && s - last[-side] > 7) {
          const vm = vehicle(VAN[Math.floor(R() * VAN.length)]), c = fr(s + 2.9);
          const u = side * (half - 0.35 - 1.05);
          const ok = [-2.6, 0, 2.6].every(ds => { const q = fr(s + 2.9 + ds); return isAlley(q.p[0] + q.n[0] * side * (half - 0.45), q.p[1] + q.n[1] * side * (half - 0.45), r.id); });
          if (ok) {
            put(vm, c.p[0] + c.n[0] * u, c.p[1] + c.n[1] * u, c.t[0], c.t[1], c.n[0] * side, c.n[1] * side, -PV);
            cnt('alleyVan', c.p[0], c.p[1]); last[side] = s + 6;
            s += 6 + 6 + R() * 10; continue;
          }
        }
        s += 3; continue;
      }
      if (s - last[-side] < 1 && it.d > 1) { s += 1; continue; }
      // wall frame along the curb: u along +t (side +1) or -t, v from the curb into the alley
      const a = side > 0 ? [-f.t[0], -f.t[1]] : f.t, b = [-f.n[0] * side, -f.n[1] * side];
      const base = [f.p[0] + f.n[0] * side * (half - 0.32), f.p[1] + f.n[1] * side * (half - 0.32)];
      const wf = F(base, a, b);
      const okA = rectAll(wf, -it.w / 2, it.w / 2, 0, it.d, (x, z) => isAlley(x, z, r.id), 0.3);
      if (okA) {
        const [ox, oz] = wf.at(-it.w / 2 + it.w / 2, 0);
        put(it.m, ox, oz, a[0], a[1], b[0], b[1], -PV);
        cnt('alley_' + it.kind); last[side] = s + it.w / 2;
        if (it.kind === 'dumpster' && R() < 0.4) {
          const bg = item('bags', R), [bx2, bz2] = wf.at(-it.w / 2 - 0.2 - bg.w / 2, 0);
          if (rectAll(wf, -it.w / 2 - 0.2 - bg.w, -it.w / 2 - 0.2, 0, bg.d, (x, z) => isAlley(x, z, r.id), 0.3)) { put(bg.m, bx2, bz2, a[0], a[1], b[0], b[1], -PV); cnt('alley_bags'); }
        }
      }
      s += it.w + 4 + R() * 12;
    }
  }
  counts.models = cache.size; counts.q1 = mb.quads;
  return counts;
}
L.serviceKit = serviceKit;
})();
