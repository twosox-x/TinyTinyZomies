// Vehicle-access audit: does every parking area, garage entrance, drive-through, loading bay and gas-station
// forecourt have a drive aisle to a street, and a curb cut where it crosses the sidewalk?
//   node --max-old-space-size=8000 tools/city_lab/dev/access.js [seeds, default 1,2,3] [--root=DIR] [--list=N] [--json=FILE]
// --root builds another checkout of the city lab (e.g. an export of HEAD) for before / after counts.
//
// The check reads the geometry the plug-ins actually build, not what they declare:
//  - every commercial / transition lot (and downtown mid-rise) is built with a recording VoxModel; the lot's ground
//    models (placed at the lot origin) give, per 25 cm cell, the ground material at y = 0 and whether y = 1..6 is
//    free (2 m clearance). A cell is DRIVABLE when it is paved (asphalt, concrete, paint) and clear, or part of a
//    parked car (cars are recognised from their box pattern: body 7 x 15..19 voxels, wheels below);
//  - all lots are rasterised into one world grid (0.25 m, 2 x 2 supersampled), so rear lots shared by attached
//    neighbours count as one paved area; beds, curbs, walks, fences, walls, hedges, buildings and lawn block;
//  - a VEHICLE AREA is a 4-connected component of drivable cells that holds a parked car or a striped stall, or is
//    at least 40 m2 of paving (forecourts, drive-thru lanes);
//  - FRONTAGE: the area reaches a drivable cell on the lot's street edge (z = 0) of one of its lots;
//  - STREET: the area touches a registered curb cut (res.cuts: lot-line segment + depth to the carriageway), i.e.
//    the drive crosses the sidewalk at a lowered curb;
//  - garages (parking_garage portals), house driveways (yard kit lot.drive) and service-kit loading bays
//    (gaps with a van / truck) are counted separately: they need a curb cut over the drive's width;
//  - dumpster pens in commercial lots: the cells in front of the gates must belong to a street-connected area.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const ra = args.find(a => a.startsWith('--root=')), ROOT = path.resolve(ra ? ra.slice(7) : __dirname + '/..');
const la = args.find(a => a.startsWith('--list=')), LIST = la ? +la.slice(7) : 12;
const ja = args.find(a => a.startsWith('--json=')), JSONF = ja ? ja.slice(7) : null;
const SEEDS = (args.find(a => /^[\d,]+$/.test(a)) || '1,2,3').split(',').map(Number);

const C = require(ROOT + '/city_core.js');
const A = require(ROOT + '/city_arch.js');
global.self = global; self.CityArch = A;
self.TOWER_FILES = null; eval(fs.readFileSync(ROOT + '/towers/manifest.js', 'utf8'));
for (const f of self.TOWER_FILES) eval(fs.readFileSync(ROOT + '/towers/' + f, 'utf8'));
const L = A.lib, BM = A.BM, BV = A.BV;

// ---- instrumentation
let CUR = null;
class RecVM extends C.VoxModel {
  constructor(...a) { super(...a); this.rec = CUR ? [] : null; }
  box(x0, y0, z0, x1, y1, z1, m) { if (this.rec) this.rec.push([x0, y0, z0, x1, y1, z1, m]); return super.box(x0, y0, z0, x1, y1, z1, m); }
}
const CC = Object.assign({}, C, { VoxModel: RecVM });
let LOTS = [], HOUSES = [];
for (const m of A.mids) {
  if (m.__wrapped) continue;
  const fn = m.fn, name = m.name;
  m.fn = function (E, Cx, W, D, spec, R, Lb) {
    const rec = { name, W, D, use: spec.use, zone: spec.zone, O: E.O, e1: E.e1, e2: E.e2, placed: [] };
    const prev = CUR; CUR = rec;
    const ov = E.vox;
    E.vox = function (Cy, M, x, y, z) { if (CUR === rec) rec.placed.push([M, x, y, z]); return ov.call(this, Cy, M, x, y, z); };
    try { return fn.call(this, E, Cx, W, D, spec, R, Lb); }
    finally { E.vox = ov; CUR = prev; LOTS.push(rec); }
  };
  m.__wrapped = true;
}
if (L.yardKit && !L.yardKit.__wrapped) {
  const yk = L.yardKit;
  L.yardKit = function (E, Cx, lot, R, opts) { HOUSES.push({ O: E.O, e1: E.e1, e2: E.e2, drive: lot.drive, w: lot.w }); return yk.call(this, E, Cx, lot, R, opts); };
  L.yardKit.__wrapped = true;
}

const PAVE = new Set([BM.GRANITE_DARK, BM.ROOF_TAR, BM.CONCRETE, BM.PRECAST, BM.TRIM, BM.AWNING_BLUE, BM.PAINT_YELLOW, BM.WHITE_CONCRETE].map(m => m + 1));
const CARLEN = new Set([15, 17, 18, 19]);
const isCarBody = (b, nx) => b[1] === 2 && (b[4] - b[1] === 3 || b[4] - b[1] === 4) && nx && nx[6] === BM.SHUTTER_BLACK && nx[1] === 1 &&
  ((b[3] - b[0] === 7 && CARLEN.has(b[5] - b[2])) || (b[5] - b[2] === 7 && CARLEN.has(b[3] - b[0])));

const RAD = 4;          // a car (1.75 m wide) needs a clear square of 2 * RAD - 1 cells of 0.25 m round its path
function audit(seed) {
  LOTS = []; HOUSES = [];
  const net = C.generateCity(seed), ctx = C.prepareBuild(net, 0.1);
  const PL = new C.Plots(net, ctx.F, ctx.R, 0.5, net.seed || 1); PL.build();
  const res = A.buildAll(PL, ctx.R, 0.1, CC);
  const cuts = res.cuts || [];
  // ---- per lot: local grids. cell kind: 1 free paving (aisles, aprons, lanes), 2 parking stall, 0 blocked
  const lots = [];
  for (const r of LOTS) {
    if (r.zone !== 'commercial' && r.zone !== 'transition' && r.name !== 'parking_garage') continue;
    const W = r.W, D = r.D, ground = new Uint8Array(W * D), clear = new Uint8Array(W * D).fill(1), car = new Uint8Array(W * D), stall = new Uint8Array(W * D);
    const targets = [];          // { kind, cells: [[x, z], ...] } in lot voxels: served when a car can reach one of them
    const portals = [];
    const rect = (kind, x0, z0, x1, z1) => { const cells = []; for (let z = Math.max(0, z0); z < Math.min(D, z1); ++z) for (let x = Math.max(0, x0); x < Math.min(W, x1); ++x) cells.push([x, z]); if (cells.length) targets.push({ kind, cells, at: [(x0 + x1) / 2, (z0 + z1) / 2] }); };
    let any = false;
    for (const [M, px, py, pz] of r.placed) {
      if (px !== 0 || py !== 0 || pz !== 0 || !M.rec) continue;
      any = true;
      const rec = M.rec, lines = [];
      for (let i = 0; i < rec.length; ++i) {
        const b = rec[i], n = rec[i + 1], dx = b[3] - b[0], dz = b[5] - b[2];
        if (isCarBody(b, n)) for (let z = b[2]; z < b[5]; ++z) for (let x = b[0]; x < b[3]; ++x) if (x >= 0 && x < W && z >= 0 && z < D) car[z * W + x] = 1;
        // stall lines (paint inlaid in the slab, 17 / 19 voxels long)
        if (b[6] === BM.TRIM && b[1] === 0 && b[4] === 1 && ((dx === 1 && (dz === 17 || dz === 19)) || (dz === 1 && (dx === 17 || dx === 19)))) lines.push(b);
        // dumpster pen: solid block, carved inside, gates on the -z (or +z) face
        if (n && b[1] === 0 && b[4] === 8 && n[6] === -1 && n[0] === b[0] + 1 && n[2] === b[2] + 1 && n[3] === b[3] - 1 && n[5] === b[5] - 1 && n[1] === 1) {
          const g = rec.slice(i + 2, i + 7).find(q => q[1] === 1 && q[4] === 7 && (q[5] - q[2] === 1 || q[3] - q[0] === 1));
          if (g && g[5] - g[2] === 1 && g[2] === b[5] - 1) rect('dumpster', b[0] + 1, b[5], b[3] - 1, b[5] + 3);
          else if (g && g[3] - g[0] === 1 && g[0] === b[0]) rect('dumpster', b[0] - 3, b[2] + 1, b[0], b[5] - 1);
          else if (g && g[3] - g[0] === 1 && g[0] === b[3] - 1) rect('dumpster', b[3], b[2] + 1, b[3] + 3, b[5] - 1);
          else rect('dumpster', b[0] + 1, b[2] - 3, b[3] - 1, b[2]);
        }
        // gas pump island (22 x 5, curb height): fuelling positions on both sides
        if (b[6] === BM.CONCRETE && b[1] === 0 && b[4] === 3 && dx === 22 && dz === 5) { rect('pump', b[0], b[2] - 4, b[3], b[2]); rect('pump', b[0], b[5], b[3], b[5] + 4); }
        // drive-thru: fast-food clearance bar, pharmacy stop bar, bank ATM island
        if ((b[6] === BM.SHUTTER_BLACK || b[6] === BM.PAINT_YELLOW) && b[1] === 15 && b[4] === 17 && dx === 1 && dz === 2 && rec[i - 1] && rec[i - 1][1] !== 15) rect('drive-thru', b[0] + 2, b[2], b[0] + 7, b[5]);
        if (b[6] === BM.TRIM && b[1] === 0 && b[4] === 1 && dz === 1 && dx === 8) rect('drive-thru', b[0], b[2] + 1, b[3], b[2] + 4);
        if (b[6] === BM.CONCRETE && b[1] === 0 && b[4] === 3 && dx === 4 && dz >= 18 && dz <= 30) {
          const both = [[b[0] - 7, b[0] - 2], [b[3] + 2, b[3] + 7]];
          const cells = []; for (const [a, c] of both) for (let z = b[2] + 6; z < b[5] - 6; ++z) for (let x = Math.max(0, a); x < Math.min(W, c); ++x) cells.push([x, z]);
          targets.push({ kind: 'drive-thru', cells, at: [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2] });
        }
        if (r.name === 'parking_garage' && b[6] === -1 && b[1] === 1 && b[4] === 12 && b[2] === 0 && dx === 30) portals.push({ x0: b[0], x1: b[3] });
      }
      // stalls: the rectangle between two lines 10 voxels apart (rows along x, columns along z)
      const key = (b) => b.slice(0, 6).join(',');
      const set = new Set(lines.map(key));
      for (const b of lines) {
        const vert = b[3] - b[0] === 1;
        const nb = vert ? [b[0] + 10, b[1], b[2], b[3] + 10, b[4], b[5]] : [b[0], b[1], b[2] + 10, b[3], b[4], b[5] + 10];
        if (!set.has(nb.join(','))) continue;
        const x0 = vert ? b[0] + 1 : b[0] - 2, x1 = vert ? b[0] + 10 : b[3] + 2, z0 = vert ? b[2] - 2 : b[2] + 1, z1 = vert ? b[5] + 2 : b[2] + 10;
        const cells = [];
        for (let z = Math.max(0, z0); z < Math.min(D, z1); ++z) for (let x = Math.max(0, x0); x < Math.min(W, x1); ++x) { stall[z * W + x] = 1; cells.push([x, z]); }
        targets.push({ kind: 'stall', cells, at: [(x0 + x1) / 2, (z0 + z1) / 2] });
      }
      for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
        const g = M.at(x + M.ox, 0, z + M.oz);
        if (g) ground[z * W + x] = g;
        for (let y = 1; y < 7; ++y) if (M.at(x + M.ox, y, z + M.oz)) { if (!car[z * W + x]) clear[z * W + x] = 0; break; }
      }
    }
    if (!any) continue;
    const kind = new Uint8Array(W * D);
    for (let i = 0; i < W * D; ++i) {
      const paved = PAVE.has(ground[i]) || (!ground[i] && i < 3 * W);         // a driveway ramp: slab carved at the lot line
      kind[i] = stall[i] && (paved || car[i]) ? 2 : (paved && clear[i]) || car[i] ? 1 : 0;
    }
    lots.push({ r, W, D, kind, targets, portals, type: r.use || r.name });
  }
  // ---- world grid (0.25 m): st 1 free paving, 2 stall, 4 blocked lot cell, 0 outside the lots
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (const l of lots) for (const [a, b] of [[0, 0], [l.W, 0], [0, l.D], [l.W, l.D]]) {
    const X = l.r.O[0] + (a * l.r.e1[0] + b * l.r.e2[0]) * BV, Z = l.r.O[1] + (a * l.r.e1[1] + b * l.r.e2[1]) * BV;
    x0 = Math.min(x0, X); x1 = Math.max(x1, X); z0 = Math.min(z0, Z); z1 = Math.max(z1, Z);
  }
  const G = 0.25; x0 -= 15; z0 -= 15; x1 += 15; z1 += 15;
  const nx = Math.ceil((x1 - x0) / G), nz = Math.ceil((z1 - z0) / G), N = nx * nz;
  const st = new Uint8Array(N), lotOf = new Int32Array(N).fill(-1), street = new Uint8Array(N), band = new Uint8Array(N);
  const cellOf = (X, Z) => { const i = Math.floor((X - x0) / G), k = Math.floor((Z - z0) / G); return i >= 0 && k >= 0 && i < nx && k < nz ? k * nx + i : -1; };
  const W2 = (l, x, z) => [l.r.O[0] + (x * l.r.e1[0] + z * l.r.e2[0]) * BV, l.r.O[1] + (x * l.r.e1[1] + z * l.r.e2[1]) * BV];
  lots.forEach((l, li) => {
    for (let z = -12; z < l.D; ++z) for (let x = 0; x < l.W; ++x) {
      const v = z >= 0 ? l.kind[z * l.W + x] : 0;
      for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [X, Z] = W2(l, x + a, z + b), c = cellOf(X, Z); if (c < 0) continue;
        if (z < 0) { band[c] = 1; continue; }
        if (lotOf[c] < 0 || v) { lotOf[c] = li; st[c] = v ? v : 4; }
      }
    }
  });
  // curb cuts: the apron and 3 m of the carriageway beyond it are street
  for (const c of cuts) {
    const dx = c.bx - c.ax, dz = c.bz - c.az, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
    for (let t = 0; t <= len; t += G / 2) for (let d = 0; d <= c.depth + 3; d += G / 2) {
      const k = cellOf(c.ax + ux * t + c.nx * d, c.az + uz * t + c.nz * d);
      if (k >= 0 && st[k] !== 4 && st[k] !== 2) street[k] = 1;
    }
  }
  // clearance (Chebyshev distance to the nearest obstacle, two-pass), then reach from the given open cells
  const reach = (open, seed) => {
    const dist = new Int16Array(N);
    for (let i = 0; i < N; ++i) dist[i] = open(i) ? 999 : 0;
    for (let k = 0; k < nz; ++k) for (let i = 0; i < nx; ++i) { const c = k * nx + i; if (!dist[c]) continue; let m = dist[c];
      if (i > 0) m = Math.min(m, dist[c - 1] + 1); if (k > 0) { m = Math.min(m, dist[c - nx] + 1); if (i > 0) m = Math.min(m, dist[c - nx - 1] + 1); if (i < nx - 1) m = Math.min(m, dist[c - nx + 1] + 1); }
      if (i === 0 || i === nx - 1 || k === 0 || k === nz - 1) m = Math.min(m, 1); dist[c] = m; }
    for (let k = nz - 1; k >= 0; --k) for (let i = nx - 1; i >= 0; --i) { const c = k * nx + i; if (!dist[c]) continue; let m = dist[c];
      if (i < nx - 1) m = Math.min(m, dist[c + 1] + 1); if (k < nz - 1) { m = Math.min(m, dist[c + nx] + 1); if (i < nx - 1) m = Math.min(m, dist[c + nx + 1] + 1); if (i > 0) m = Math.min(m, dist[c + nx - 1] + 1); } dist[c] = m; }
    const got = new Uint8Array(N), q = new Int32Array(N);
    let h = 0, t = 0;
    for (let i = 0; i < N; ++i) if (seed(i) && dist[i] >= RAD) { got[i] = 1; q[t++] = i; }
    while (h < t) {
      const c = q[h++], ci = c % nx;
      for (const d of [ci > 0 ? -1 : 0, ci < nx - 1 ? 1 : 0, -nx, nx]) { const e = c + d; if (!d || e < 0 || e >= N || got[e] || dist[e] < RAD) continue; got[e] = 1; q[t++] = e; }
    }
    // served: within RAD of a path centre (the car's body sweeps that far)
    const served = new Uint8Array(N);
    for (let c = 0; c < N; ++c) if (got[c]) { const ci = c % nx, ck = (c - ci) / nx;
      for (let k = Math.max(0, ck - RAD); k <= Math.min(nz - 1, ck + RAD); ++k) served.fill(1, k * nx + Math.max(0, ci - RAD), k * nx + Math.min(nx - 1, ci + RAD) + 1); }
    return served;
  };
  const viaStreet = reach((i) => st[i] === 1 || street[i], (i) => street[i]);
  const viaFront = reach((i) => st[i] === 1 || (st[i] === 0 && band[i]), (i) => st[i] === 0 && band[i]);
  // --dump=x,z: ASCII picture of the lot at that world point (. free  = stall  # blocked  * served free  + served stall  T target)
  const da = args.find(a => a.startsWith('--dump='));
  if (da) {
    const [qx, qz] = da.slice(7).split(',').map(Number);
    for (const l of lots) {
      const dx = qx - l.r.O[0], dz = qz - l.r.O[1], a = (dx * l.r.e1[0] + dz * l.r.e1[1]) / BV, b = (dx * l.r.e2[0] + dz * l.r.e2[1]) / BV;
      if (a < 0 || b < 0 || a > l.W || b > l.D) continue;
      const tg = new Set(); for (const T of l.targets) for (const [x, z] of T.cells) tg.add(z * l.W + x);
      console.log(`lot ${l.type} W ${l.W} D ${l.D} (z = 0 at the bottom row printed last)`);
      for (let z = l.D - 1; z >= -6; z -= 2) { let line = ''; for (let x = 0; x < l.W; x += 1) {
        const [X, Z] = W2(l, x + 0.5, z + 0.5), c = cellOf(X, Z), k = z >= 0 ? l.kind[z * l.W + x] : -1, sv = c >= 0 && viaStreet[c];
        line += z < 0 ? (c >= 0 && street[c] ? 'C' : ' ') : tg.has(z * l.W + x) && !k ? 'T' : k === 1 ? (sv ? '*' : '.') : k === 2 ? (sv ? '+' : '=') : '#'; }
        console.log(String(z).padStart(4) + ' ' + line); }
    }
  }
  const out = { seed, types: {}, bad: [], houses: { n: 0, cut: 0 }, garages: { n: 0, cut: 0 }, loading: { n: 0, cut: 0 }, cuts: cuts.length };
  for (const l of lots) {
   const agg = new Map();
   for (const T of l.targets) {
    let sS = false, sF = false;
    for (const [x, z] of T.cells) { const [X, Z] = W2(l, x + 0.5, z + 0.5), c = cellOf(X, Z); if (c < 0) continue; if (viaStreet[c]) sS = true; if (viaFront[c]) sF = true; if (sS) break; }
    const key = l.type + ' ' + T.kind, o = out.types[key] || (out.types[key] = { n: 0, front: 0, street: 0 });
    o.n++; o.front += sF || sS ? 1 : 0; o.street += sS ? 1 : 0;
    if (!sS) { const k2 = key + (sF ? ': aisle reaches the frontage but no curb cut' : ': NO drive aisle to the frontage'); const a = agg.get(k2); if (a) a.n++; else agg.set(k2, { n: 1, at: W2(l, T.at[0], T.at[1]) }); }
   }
   for (const [k2, a] of agg) out.bad.push(`${a.n} x ${k2} (lot at ${a.at.map(v => v.toFixed(1)).join(',')})`);
  }
  // drives of local x range [a, b) on the lot line: cut when >= 80 % of it has a cut in front
  const covered = (O, e1, e2, a, b) => {
    let n = 0, k = 0;
    for (let x = a + 0.5; x < b; x += 1) {
      ++n;
      const X = O[0] + x * e1[0] * BV, Z = O[1] + x * e1[1] * BV;
      if (cuts.some(c => { const dx = c.bx - c.ax, dz = c.bz - c.az, len = Math.hypot(dx, dz); const t = ((X - c.ax) * dx + (Z - c.az) * dz) / len, d = (X - c.ax) * c.nx + (Z - c.az) * c.nz; return t >= -0.15 && t <= len + 0.15 && Math.abs(d) < 0.6; })) ++k;
    }
    return n && k >= 0.8 * n;
  };
  for (const l of lots) for (const p of l.portals) {
    out.garages.n++;
    if (covered(l.r.O, l.r.e1, l.r.e2, p.x0, p.x1)) out.garages.cut++;
    else out.bad.push(`parking_garage portal without curb cut at ${(l.r.O[0] + (p.x0 + 15) * l.r.e1[0] * BV).toFixed(1)},${(l.r.O[1] + (p.x0 + 15) * l.r.e1[1] * BV).toFixed(1)}`);
  }
  const badH = [];
  for (const h of HOUSES) {
    if (!h.drive) continue;
    out.houses.n++;
    if (covered(h.O, h.e1, h.e2, h.drive.x0, h.drive.x1)) out.houses.cut++;
    else badH.push(`${(h.O[0] + (h.drive.x0 + h.drive.x1) / 2 * h.e1[0] * BV).toFixed(1)},${(h.O[1] + (h.drive.x0 + h.drive.x1) / 2 * h.e1[1] * BV).toFixed(1)}`);
  }
  if (badH.length) out.bad.push(`${badH.length} house driveway(s) without curb cut, e.g. at ${badH.slice(0, 4).join(' ')}`);
  const sv = res.counts.service || {};
  out.loading.n = (sv.truck || 0) + (sv.van || 0); out.why = res.counts.cutRefused;
  out.loading.cut = cuts.filter(c => c.kind === 'loading').length;
  if (out.loading.cut < out.loading.n) out.bad.push(`${out.loading.n - out.loading.cut} service loading bay(s) without curb cut`);
  return out;
}

const all = [];
for (const seed of SEEDS) {
  const o = audit(seed);
  all.push(o);
  let n = 0, f = 0, st = 0;
  for (const k in o.types) { n += o.types[k].n; f += o.types[k].front; st += o.types[k].street; }
  console.log(`cut refusals: ${JSON.stringify(o.why || {})}`);
  console.log(`seed ${seed}: ${n} vehicle targets in lots (stalls, pumps, drive-thru lanes, dumpster pens): ${f} with a drive aisle to the frontage, ${st} reach the street over a curb cut | garage portals ${o.garages.cut}/${o.garages.n} | loading bays ${o.loading.cut}/${o.loading.n} | house driveways ${o.houses.cut}/${o.houses.n} | ${o.cuts} cuts`);
  for (const [k, v] of Object.entries(o.types).sort()) console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(4)}  frontage ${String(v.front).padStart(4)}  street ${String(v.street).padStart(4)}`);
  for (const b of o.bad.slice(0, LIST)) console.log('  - ' + b);
  if (o.bad.length > LIST) console.log(`  ... ${o.bad.length - LIST} more`);
}
if (JSONF) fs.writeFileSync(JSONF, JSON.stringify(all, null, 1));
process.exitCode = all.some(o => o.bad.length) ? 1 : 0;    // any vehicle target without a drive aisle / curb cut fails (check.js)
