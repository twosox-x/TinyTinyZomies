// Rural kit: the countryside past the county line road (city_core growOutskirts, generateCity opts.scale > 1).
//
// CityArch.lib.ruralKit(K) -> stats   (called from buildAll after parkKit)
//   K = { PL, C, R (Rasterizer), mb, hs, voxel, region? {x0, z0, x1, z1} (default: the whole map) }
//
// The ground itself (crop rows, wheat, ploughed soil, pasture, forest floor, lake, farmyard gravel, verges) is the
// road raster (city_core ruralGround). This kit adds the 3D parts:
//  - woods: dense stands of large trees where ruralGround says 'forest' (noise woods and woodlot parcels), on a
//    jittered 5.5 m grid, a few cached models (broad oaks, maples, spruces, pines);
//  - tree lines along the rural roads (5-7.5 m from the carriageway);
//  - hedgerows: lines of bushy trees on some parcel boundaries (hash of the parcel), on the 1.6 m grass headland;
//  - fences: post-and-rail along the boundaries of pasture parcels;
//  - farmsteads (net.plan.farms): farmhouse facing the road, red gambrel barn, silos, an equipment shed.
// Everything is keyed by position / parcel / farm hashes, so any region can be built on its own in any order.
// Copies are sunk a few millimetres (a per-copy slot, distinct among overlapping copies) and skip faces resting on
// the ground: nothing is coplanar with the ground or with another copy.
(function () {
'use strict';
const A = self.CityArch, L = A.lib;
const K = { LEAF: 133, LEAF_D: 134, TRUNK: 135, EVER: 137, DGREEN: 126, SGREEN: 65, AWN_G: 97, SHUT_G: 103, GRASS: 155,
  WHITE: 64, RED: 95, RED_D: 72, ROOF: 93, ROOF_D: 104, CONC: 70, STEEL: 130, WOOD: 136, CREAM: 81, TRIM: 84, DOOR: 102 };
const BV = 0.25;
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const CACHE = new Map();
const cached = (key, make) => { let v = CACHE.get(key); if (!v) { v = make(); CACHE.set(key, v); } return v; };
// 1 + 4k mm (1..101 mm): never equal to the park kit's 3 + 4k mm slots (in-town woods meet parks), yard-kit phase skipped like there
const SLOTS = []; for (let s = 0; s < 26; ++s) { const mm = 1 + 4 * s, ph = ((mm % 15.625) + 15.625) % 15.625; if (Math.abs(ph - 7.8125) > 1.6) SLOTS.push(mm / 1000); }

function oct(M, cx, cz, r, y0, y1, m) {
  if (y1 <= y0) return;
  const r2 = Math.max(1, Math.round(r * 0.62));
  M.box(cx - r, y0, cz - r2, cx + r, y1, cz + r2, m); M.box(cx - r2, y0, cz - r, cx + r2, y1, cz + r, m);
}
// trees (25 cm voxels): { mesh, rc, h }
function treeModel(C, kind, vr) {
  return cached('t' + kind + vr, () => {
    const R = C.mulberry32(9137 + vr * 101 + kind.length * 7), VM = (L.VoxModel() || C.VoxModel);
    let M, rc, ht;
    if (kind === 'spruce') {
      ht = 40 + Math.floor(R() * 20); rc = 8 + Math.floor(R() * 3);
      M = new VM(2 * rc + 4, ht + 3, 2 * rc + 4, rc + 2, rc + 2);
      M.box(-1, 0, -1, 1, ht - 2, 1, K.TRUNK);
      const m1 = R() < 0.5 ? K.EVER : K.DGREEN, tiers = 6;
      for (let t = 0; t < tiers; ++t) {
        const f = 1 - t / tiers, r = Math.max(1, Math.round(rc * f)), y0 = 4 + Math.round(t * (ht - 6) / tiers), y1 = 4 + Math.round((t + 1) * (ht - 6) / tiers);
        oct(M, 0, 0, r, y0, y1, t & 1 ? K.DGREEN : m1);
      }
      M.box(-1, ht - 3, -1, 1, ht + 1, 1, m1);
    } else if (kind === 'hedge') {
      ht = 12 + Math.floor(R() * 8); rc = 5 + Math.floor(R() * 3);
      M = new VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
      M.box(0, 0, 0, 1, 4, 1, K.TRUNK);
      oct(M, 0, 0, rc, 2, ht - 3, R() < 0.5 ? K.LEAF_D : K.SHUT_G);
      oct(M, Math.round((R() - 0.5) * 3), 0, Math.max(2, rc - 2), ht - 3, ht, K.LEAF);
    } else {                                                   // broad deciduous (oak / maple)
      ht = 38 + Math.floor(R() * 18); rc = 11 + Math.floor(R() * 6);
      M = new VM(2 * rc + 6, ht + 2, 2 * rc + 6, rc + 3, rc + 3);
      const base = Math.round(ht * 0.32), lo = [K.LEAF_D, K.DGREEN, K.SHUT_G][vr % 3], hi = [K.LEAF, K.AWN_G, K.SGREEN][vr % 3];
      M.box(-1, 0, -1, 1, Math.round(ht * 0.7), 1, K.TRUNK);
      oct(M, 0, 0, Math.round(rc * 0.85), base, base + Math.round((ht - base) * 0.4), lo);
      const a0 = R() * 6.28;
      for (let i = 0; i < 3; ++i) {
        const an = a0 + i * 2.09, rr = Math.round(rc * 0.5), d = rc - rr;
        oct(M, Math.round(Math.cos(an) * d), Math.round(Math.sin(an) * d), rr, base + Math.round((ht - base) * 0.3), base + Math.round((ht - base) * 0.75), i & 1 ? lo : hi);
      }
      oct(M, 0, 0, Math.round(rc * 0.55), base + Math.round((ht - base) * 0.6), ht, hi);
    }
    return { mesh: C.meshVoxels3D(M), rc: rc * BV, h: ht * BV };
  });
}
// farm buildings (25 cm voxels), +z = front (towards the road)
function farmModel(C, kind, vr) {
  return cached('f' + kind + vr, () => {
    const VM = (L.VoxModel() || C.VoxModel);
    let M;
    if (kind === 'house') {                                    // two-storey white farmhouse, gable roof, porch
      const W = 36, D = 28, H = 24;
      M = new VM(W + 4, H + 16, D + 10, (W + 4) >> 1, (D + 10) >> 1);
      const x0 = -(W >> 1), z0 = -(D >> 1);
      M.box(x0, 0, z0, x0 + W, H, z0 + D, vr & 1 ? K.WHITE : K.CREAM);
      for (let k = 0; k < 14; ++k) M.box(x0 - 1, H + k, z0 - 1 + k, x0 + W + 1, H + k + 1, z0 + D + 1 - k, k < 13 ? K.ROOF : K.ROOF_D);
      M.box(x0 + 3, 0, z0 + D, x0 + W - 3, 1, z0 + D + 6, K.WOOD);                       // porch deck + roof
      M.box(x0 + 3, 11, z0 + D, x0 + W - 3, 12, z0 + D + 6, K.ROOF);
      for (const x of [x0 + 3, x0 + W - 4]) M.box(x, 1, z0 + D + 5, x + 1, 11, z0 + D + 6, K.TRIM);
      M.box(-2, 1, z0 + D, 2, 9, z0 + D + 1, K.DOOR);
      for (const x of [x0 + 5, x0 + 13, x0 + W - 17, x0 + W - 9]) for (const y of [4, 15]) M.box(x, y, z0 + D, x + 4, y + 5, z0 + D + 1, K.TRIM);
      M.box(x0 + W - 8, H, z0 + 6, x0 + W - 5, H + 12, z0 + 9, K.RED_D);                  // chimney
    } else if (kind === 'barn') {                              // red gambrel barn, white trim, big doors on the gable end
      const W = 48, D = 72, H = 20;
      M = new VM(W + 4, H + 26, D + 4, (W + 4) >> 1, (D + 4) >> 1);
      const x0 = -(W >> 1), z0 = -(D >> 1);
      M.box(x0, 0, z0, x0 + W, H, z0 + D, K.RED);
      // gambrel: steep lower slope, shallow upper slope (stepped boxes, full length)
      const prof = [[0, 0], [1, 3], [2, 6], [3, 9], [4, 11], [5, 13], [6, 15], [7, 18], [8, 21], [9, 24]];
      for (const [k, inset] of prof) { const y = H + k * 2; if (W / 2 - inset < 2) break; M.box(x0 + inset - 1, y, z0 - 1, x0 + W - inset + 1, y + 2, z0 + D + 1, K.ROOF_D); }
      for (const z of [z0 + D, z0 - 1]) {
        M.box(-8, 0, z, 8, 16, z + 1, K.RED_D);
        M.box(-8, 15, z, 8, 16, z + 1, K.WHITE); M.box(-8, 0, z, -7, 16, z + 1, K.WHITE); M.box(7, 0, z, 8, 16, z + 1, K.WHITE);
        M.box(-3, 24, z, 3, 30, z + 1, K.WHITE);
      }
    } else if (kind === 'silo') {                              // concrete stave silo with a steel dome
      const r = 7 + vr, H = 56 + vr * 8;
      M = new VM(2 * r + 4, H + 8, 2 * r + 4, r + 2, r + 2);
      for (let z = -r; z <= r; ++z) for (let x = -r; x <= r; ++x) if (x * x + z * z <= r * r) M.box(x, 0, z, x + 1, H, z + 1, K.CONC);
      for (let k = 0; k < 6; ++k) { const rr = Math.round(r * Math.cos(k / 6 * 1.5)); for (let z = -rr; z <= rr; ++z) for (let x = -rr; x <= rr; ++x) if (x * x + z * z <= rr * rr) M.box(x, H + k, z, x + 1, H + k + 1, z + 1, K.STEEL); }
    } else {                                                   // open equipment shed: steel roof on posts
      const W = 40, D = 24;
      M = new VM(W + 2, 22, D + 2, (W + 2) >> 1, (D + 2) >> 1);
      const x0 = -(W >> 1), z0 = -(D >> 1);
      M.box(x0, 0, z0, x0 + W, 16, z0 + 2, K.WOOD);
      for (let x = x0; x < x0 + W; x += 10) M.box(x, 0, z0 + D - 2, x + 2, 16, z0 + D, K.WOOD);
      M.box(x0 - 1, 16, z0 - 1, x0 + W + 1, 18, z0 + D + 1, K.STEEL);
    }
    return { mesh: C.meshVoxels3D(M) };
  });
}
function fenceModel(C) {                                       // 3 m post-and-rail section along +x (25 cm voxels)
  return cached('fence', () => {
    const M = new ((L.VoxModel() || C.VoxModel))(14, 6, 2, 0, 1);
    M.box(0, 0, 0, 1, 5, 1, K.WOOD);
    M.box(0, 2, 0, 12, 3, 1, K.WHITE); M.box(0, 4, 0, 12, 5, 1, K.WHITE);
    return { mesh: C.meshVoxels3D(M) };
  });
}

function ruralKit(K0) {
  const { PL, C, mb, hs, voxel } = K0, Ra = K0.R, net = PL && PL.net;
  if (!net || !net.plan || !C.ruralGround) return null;
  const t0 = Date.now(), q0 = mb.quads, PV = C.PV, seed = net.seed | 0, F = Ra.F;
  const rg = K0.region || net.bounds;
  const stats = { trees: 0, hedge: 0, fence: 0, farms: 0, quads: 0, ms: 0 };
  const quadW = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, Nx, Ny, Nz) => {
    const v = voxel, y0 = hs;
    const Ax = ax / v, Ay = (y0 + ay) / v, Az = az / v, Bx = bx / v, By = (y0 + by) / v, Bz = bz / v;
    const Cx = cx / v, Cy = (y0 + cy) / v, Cz = cz / v, Dx = dx / v, Dy = (y0 + dy) / v, Dz = dz / v;
    const ux = Bx - Ax, uy = By - Ay, uz = Bz - Az, vx = Cx - Ax, vy = Cy - Ay, vz = Cz - Az;
    const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
    if (crx * Nx + cry * Ny + crz * Nz < 0) mb.quadN(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz, Bx, By, Bz, m, Nx, Ny, Nz);
    else mb.quadN(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz, Dx, Dy, Dz, m, Nx, Ny, Nz);
  };
  const put = (m, x, y, z, yaw, sh) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), P = m.pos, fh = sh / PV;
    if (L.debugPlace) L.debugPlace({ kit: 'rural', mesh: m, map: (u, yy, v) => [x + (u * c - v * s) * fh, hs + y + yy * fh, z + (u * s + v * c) * fh] });
    const X = new Float64Array(4), Y = new Float64Array(4), Z = new Float64Array(4);
    for (let q = 0; q < m.quads; ++q) {
      const n = m.nrm[q * 4], o = q * 12;
      if (n === 5 && P[o + 1] === 0 && P[o + 4] === 0 && P[o + 7] === 0 && P[o + 10] === 0) continue;
      for (let i = 0; i < 4; ++i) { const u = P[o + i * 3] * fh, v = P[o + i * 3 + 2] * fh; X[i] = x + u * c - v * s; Y[i] = y + P[o + i * 3 + 1] * fh; Z[i] = z + u * s + v * c; }
      const N = NV[n];
      quadW(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], X[3], Y[3], Z[3], m.mat[q * 4], N[0] * c - N[2] * s, N[1], N[0] * s + N[2] * c);
    }
  };
  // sink slot: distinct among overlapping copies (spatial hash of placed copies, 16 m cells)
  const grid = new Map();
  const sink = (x, z, r, h) => {
    const taken = new Set(), gx = Math.floor(x / 16), gz = Math.floor(z / 16);
    for (let dz = -1; dz <= 1; ++dz) for (let dx = -1; dx <= 1; ++dx) for (const o of grid.get((gx + dx) + ',' + (gz + dz)) || []) if (Math.hypot(o[0] - x, o[1] - z) < r + o[2] + 0.3) taken.add(o[3]);
    const st = Math.floor(h * SLOTS.length) % SLOTS.length;
    const si = L.sinkPick(SLOTS, taken, st);
    const key = gx + ',' + gz; let a = grid.get(key); if (!a) grid.set(key, a = []); a.push([x, z, r, si]);
    return -SLOTS[si];
  };
  const o = {};
  const verge = (x, z) => { F.sample(x, z, o); return o.road < 0 || o.car > 900 ? 99 : o.car - o.sw; };
  const inR = (x, z) => x >= rg.x0 && x < rg.x1 && z >= rg.z0 && z < rg.z1;
  const farms = net.plan.farms.filter(f => inR(f.c[0], f.c[1]));
  const nearFarm = (x, z, m) => net.plan.farms.some(f => C.inFarm(f, x, z, m));
  // ---- farmsteads
  for (const f of farms) {
    const R = C.mulberry32(f.seed ^ 0x6a5d), yaw = Math.atan2(-f.n[0], f.n[1]);
    const at = (a, b) => [f.c[0] + f.n[1] * a + f.n[0] * b, f.c[1] - f.n[0] * a + f.n[1] * b];   // a: along the road, b: towards it
    const side = R() < 0.5 ? 1 : -1;
    const h = at(side * 10, 9), bq = at(-side * 6, -6), si = at(-side * 19.5, -11), sh = at(side * 11, -10);
    put(farmModel(C, 'house', f.seed & 3).mesh, h[0], -0.004, h[1], yaw, BV);
    put(farmModel(C, 'barn', 0).mesh, bq[0], -0.006, bq[1], yaw + Math.PI / 2, BV);
    put(farmModel(C, 'silo', f.seed % 3).mesh, si[0], -0.005, si[1], 0, BV);
    if (R() < 0.6) { const s2 = at(-side * 19.5, -2); put(farmModel(C, 'silo', (f.seed + 1) % 3).mesh, s2[0], -0.007, s2[1], 0, BV); }
    put(farmModel(C, 'shed', 0).mesh, sh[0], -0.008, sh[1], yaw, BV);
    stats.farms++;
  }
  // ---- woods: jittered 5.5 m grid (crowns 5.5-8.5 m across: a closed canopy), a third of them spruce / pine
  const S = 5.5;
  for (let gz = Math.floor(rg.z0 / S); gz * S < rg.z1; ++gz) for (let gx = Math.floor(rg.x0 / S); gx * S < rg.x1; ++gx) {
    const h1 = C.hash2(gx, gz, seed + 401), h2 = C.hash2(gx, gz, seed + 409), h3 = C.hash2(gx, gz, seed + 419);
    const x = (gx + 0.15 + 0.7 * h1) * S, z = (gz + 0.15 + 0.7 * h2) * S;
    if (!inR(x, z) || !C.isRural(net, x, z)) continue;
    const vg = verge(x, z);
    const g = C.ruralGround(net, x, z, vg);
    if (!g || g.kind !== 'forest' || vg < 4.5 || nearFarm(x, z, 6)) continue;
    const kind = h3 < 0.3 ? 'spruce' : 'broad', T = treeModel(C, kind, Math.floor(h3 * 97) % 5);
    if (vg < T.rc + 1.5) continue;
    put(T.mesh, x, sink(x, z, T.rc, h1), z, h2 * 6.283, BV); stats.trees++;
  }
  // ---- tree lines along the rural roads: a jittered 9 m grid, kept where the point falls 5-7.5 m from the
  // carriageway (just past the verge), on field / pasture / headland ground; gaps by hash so rows read as planted lines
  const SR = 9;
  for (let gz = Math.floor(rg.z0 / SR); gz * SR < rg.z1; ++gz) for (let gx = Math.floor(rg.x0 / SR); gx * SR < rg.x1; ++gx) {
    const h1 = C.hash2(gx, gz, seed + 461), h2 = C.hash2(gx, gz, seed + 467), h3 = C.hash2(gx, gz, seed + 479);
    if (h3 > 0.6) continue;
    const x = (gx + 0.1 + 0.8 * h1) * SR, z = (gz + 0.1 + 0.8 * h2) * SR;
    if (!inR(x, z) || !C.isRural(net, x, z)) continue;
    const vg = verge(x, z);
    if (vg < 5 || vg > 7.5 || nearFarm(x, z, 8)) continue;
    const g = C.ruralGround(net, x, z, vg);
    if (!g || !['field', 'pasture', 'headland', 'verge'].includes(g.kind) || C.waterSD(net, x, z) > -8) continue;
    const T = treeModel(C, h3 < 0.12 ? 'spruce' : h3 < 0.3 ? 'hedge' : 'broad', Math.floor(h3 * 97) % 5);
    if (vg < T.rc + 1.2) continue;
    put(T.mesh, x, sink(x, z, T.rc, h1), z, h2 * 6.283, BV); stats.roadTrees = (stats.roadTrees || 0) + 1;
  }
  // ---- parcel boundaries: hedgerows / pasture fences (3 m steps along each boundary line, deduplicated by key)
  const seen = new Set();
  const edgeAt = (x, z, alongX) => {                  // a point on a boundary line; alongX: the line runs along x
    const key = Math.round(x * 2) + ',' + Math.round(z * 2) + (alongX ? 'x' : 'z');
    if (seen.has(key)) return; seen.add(key);
    if (!inR(x, z) || !C.isRural(net, x, z)) return;
    const vg = verge(x, z); if (vg < 4) return;
    const e = 1.0, n = alongX ? [0, e] : [e, 0];
    const ga = C.ruralGround(net, x - n[0] * 2.5, z - n[1] * 2.5, 99), gb = C.ruralGround(net, x + n[0] * 2.5, z + n[1] * 2.5, 99);
    if (!ga || !gb || !ga.p || !gb.p || ga.kind === 'forest' || gb.kind === 'forest' || ['water', 'shore', 'farmyard'].includes(ga.kind) || ['water', 'shore', 'farmyard'].includes(gb.kind)) return;
    if (nearFarm(x, z, 4)) return;
    const hedge = Math.min(ga.p.hedge, gb.p.hedge) < 0.3, past = ga.kind === 'pasture' || gb.kind === 'pasture';
    const hk = C.hash2(Math.round(x), Math.round(z), seed + 431);
    if (hedge) {
      if (((alongX ? x : z) / 3 | 0) % 2) return;
      const T = treeModel(C, hk < 0.15 ? 'broad' : 'hedge', Math.floor(hk * 89) % 5);
      if (vg < T.rc + 1) return;
      put(T.mesh, x, sink(x, z, T.rc, hk), z, hk * 6.283, BV); stats.hedge++;
    } else if (past) {
      put(fenceModel(C).mesh, x, -0.002 - 0.004 * ((alongX ? x : z) / 3 & 1), z, alongX ? 0 : -Math.PI / 2, BV); stats.fence++;
    }
  };
  const step = 3;
  for (let z = Math.floor(rg.z0 / step) * step; z < rg.z1; z += step) for (let x = Math.floor(rg.x0 / step) * step; x < rg.x1; x += step) {
    if (!C.isRural(net, x, z)) continue;
    const p = C.ruralParcel(net, x, z);
    if (p.x1 - x < step) edgeAt(p.x1, Math.round(z / 3) * 3, false);
    if (p.z1 - z < step) edgeAt(Math.round(x / 3) * 3, p.z1, true);
  }
  stats.quads = mb.quads - q0; stats.ms = Date.now() - t0;
  return stats;
}
L.ruralKit = ruralKit;
})();
