// Shared helpers for the headless checks (regress.js, zfight.js): full building build of one seed with the raw
// (pre-finish) building mesh captured, a visibility-independent per-building signature, and a coplanar-overlap
// (z-fighting) detector. Positions are in road-voxel units (0.1 m).
const fs = require('fs');
const C = require(__dirname + '/../city_core.js');
const A = require(__dirname + '/../city_arch.js');
global.self = global; self.CityArch = A;
self.TOWER_FILES = null; eval(fs.readFileSync(__dirname + '/../towers/manifest.js', 'utf8'));
for (const f of self.TOWER_FILES) eval(fs.readFileSync(__dirname + '/../towers/' + f, 'utf8'));
const L = A.lib;

// build one seed; returns { raw (MeshBuffer as left by buildAll, before finish()), res, ctx, ms }
function build(seed, opts) {
  opts = opts || {};
  let raw = null;
  // opts.stacks: Set of raw quad indices whose emitting call stack is recorded (debugging which code made a face)
  const stacks = new Map();
  class Capture extends C.MeshBuffer {
    finish(eps) { if (eps === 0.002 && !raw) raw = this; return super.finish(eps); }
    quadN(...a) { if (opts.stacks && opts.stacks.has(this.quads) && !raw) stacks.set(this.quads, new Error().stack.split('\n').slice(2, 6).map(l => l.trim().replace(/\(.*\/(\w+\.js):(\d+):\d+\)/, '$1:$2')).join(' < ')); return super.quadN(...a); }
  }
  const CC = Object.assign({}, C, { MeshBuffer: Capture });
  if (process.env.CITY_REGIONAL || process.env.CITY_REGION) return buildRegional(seed, opts, CC, () => raw);
  const net = C.generateCity(seed), ctx = C.prepareBuild(net, 0.1);
  const PL = new C.Plots(net, ctx.F, ctx.R, 0.5, net.seed || 1); PL.build();
  const t = Date.now();
  L.debugBeforeCull = opts.beforeCull || null;
  const res = A.buildAll(PL, ctx.R, 0.1, CC, process.env.CITY_TILE ? { tile: +process.env.CITY_TILE } : undefined);
  L.debugBeforeCull = null;
  const ms = Date.now() - t;
  ctx.footprints = res.footprints || null;
  const props = opts.props ? C.placeProps(ctx) : null;
  return { raw, res, ctx, ms, props, groundY: ctx.R.hs, stacks };
}
// Regional build (the streaming path, any map size): CITY_REGIONAL=1 [CITY_REGION=x0,z0,x1,z1 metres, default the
// whole map] [CITY_TILE=128]. Tiles of the region are built like city_worker.js 'rtile' (pages from CityArch.planPage,
// buildTile, traffic per tile with its own + halo curb cuts) into one mesh, so the checks see only the region:
// memory is bounded by the region, not the map (the whole-map build overflows JS arrays above ~5 M quads).
function buildRegional(seed, opts, CC, getRaw) {
  const t = Date.now(), v = 0.1;
  const net = C.generateCity(seed), b = net.bounds;
  new C.FieldSampler(net, 0.5, [0, 0, 1, 1]).computeJunctions();
  const rg = process.env.CITY_REGION ? process.env.CITY_REGION.split(',').map(Number) : [b.x0, b.z0, b.x1, b.z1];
  const TILE = +(process.env.CITY_TILE || 128), M = 48;
  // tiles on the streaming grid (from the map corner) that overlap the region
  const ti0 = Math.floor((rg[0] - b.x0) / TILE), tj0 = Math.floor((rg[1] - b.z0) / TILE), ti1 = Math.ceil((rg[2] - b.x0) / TILE), tj1 = Math.ceil((rg[3] - b.z0) / TILE);
  const X0 = b.x0 + ti0 * TILE, Z0 = b.z0 + tj0 * TILE, X1 = b.x0 + ti1 * TILE, Z1 = b.z0 + tj1 * TILE;
  const npi = Math.ceil((b.x1 - b.x0) / A.PAGE), npj = Math.ceil((b.z1 - b.z0) / A.PAGE), pages = new Map();
  const pagesIn = (x0, z0, x1, z1) => { const [pa, pb] = A.pageOf(net, x0, z0), [pc, pd] = A.pageOf(net, x1, z1), o = [];
    for (let pj = Math.max(0, pb); pj <= Math.min(npj - 1, pd); ++pj) for (let pi = Math.max(0, pa); pi <= Math.min(npi - 1, pc); ++pi) {
      const k = pi + ',' + pj; if (!pages.has(k)) pages.set(k, A.planPage(net, C, v, pi, pj)); o.push(pages.get(k)); }
    return o; };
  const all = pagesIn(X0 - M, Z0 - M, X1 + M, Z1 + M);
  const F = new C.FieldSampler(net, 0.5, [X0 - M, Z0 - M, X1 + M, Z1 + M]); F.build(null, true);
  const R = new C.Rasterizer(net, F, v); R.useClassGrid(A.pagesClassGrid(all), A.classKinds(net));
  const mb = new CC.MeshBuffer(), jobs = [], houseSegs = [], meshCache = new Map();
  let cuts = []; const tr = [];
  for (const P of all) cuts = cuts.concat(P.kitCuts);
  const counts = { tileMs: [], trafficMs: 0 };
  for (let tj = tj0; tj < tj1; ++tj) for (let ti = ti0; ti < ti1; ++ti) {
    const x0 = b.x0 + ti * TILE, z0 = b.z0 + tj * TILE, x1 = x0 + TILE, z1 = z0 + TILE;
    const plan = A.pagesPlan(structuredClone(pagesIn(x0 - M, z0 - M, x1 + M, z1 + M)), net, C, v, all[0].hs); plan.R = R;
    const r = A.buildTile(plan, x0, z0, x1, z1, { allCuts: true });
    const off = mb.quads; copyAll(r.mb, mb);
    for (const J of r.jobs) { J.q0 += off; J.q1 += off; jobs.push(J); if (J.kind === 'shouse') houseSegs.push([J.q0, J.q1]); }
    cuts = cuts.concat(r.cuts); counts.tileMs.push(r.ms);
    if (L.trafficKit) {
      const tt = Date.now(); R.setCuts(cuts.concat(r.allCuts));
      const near = plan.jobs.filter(J => J.bb[2] > x0 - 30 && J.bb[0] < x1 + 30 && J.bb[3] > z0 - 30 && J.bb[1] < z1 + 30 && J.kind !== 'shouse');
      const st = L.trafficKit({ PL: { net, seed: net.seed || 1 }, C, R, jobs: near, hs: R.hs * v, voxel: v, box: [x0 - 12, z0 - 12, x1 + 12, z1 + 12], own: [x0, z0, x1, z1], meshCache });
      if (st && st.out) tr.push(st.out); counts.trafficMs += Date.now() - tt; R.setCuts(null);
    }
  }
  const res = mb.finish(0.002);
  R.setCuts(cuts);
  // traffic of every tile as one set (variants deduplicated by key)
  // (seams: an instance overlapping one kept from an earlier tile is dropped, as city_stream.js mergeTraffic does)
  const keepT = L.trafficSeams ? L.trafficSeams(tr) : tr.map(t => new Uint8Array(t.count).fill(1));
  const vk = new Map(), variants = []; let n = 0; for (const K of keepT) for (const f of K) n += f;
  const T = { M: new Float32Array(n * 12), vid: new Uint16Array(n), paint: new Uint8Array(n), obb: new Float32Array(n * 8), count: n, variants, paintPH: tr.length ? tr[0].paintPH : 0 };
  let o = 0;
  tr.forEach((t, ti) => {
    const map = t.variants.map(x => { let k = vk.get(x.key); if (k === undefined) { k = variants.length; vk.set(x.key, k); variants.push(Object.assign({}, x, { n: 0 })); } return k; });
    for (let i = 0; i < t.count; ++i) {
      if (!keepT[ti][i]) continue;
      T.M.set(t.M.subarray(i * 12, i * 12 + 12), o * 12); T.obb.set(t.obb.subarray(i * 8, i * 8 + 8), o * 8); T.paint[o] = t.paint[i];
      T.vid[o] = map[t.vid[i]]; variants[T.vid[o]].n++; ++o;
    }
  });
  jobs.sort((a, c) => (a.kind === 'shouse' ? 0 : 1) - (c.kind === 'shouse' ? 0 : 1));
  const rest = jobs.filter(J => J.kind !== 'shouse');
  res.counts = counts; res.traffic = T; res.cuts = cuts; res.houseSegs = houseSegs; res.net = net;
  res.footprints = rest.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind, floors: J.floors, tag: J.tag, tris: J.tris, type: J.type, q0: J.q0, q1: J.q1, use: J.use }));
  const grid = C.chunkGrid(net, v), CH = Math.round(48 / v);
  const chunks = [];
  for (let oz = Math.round(X0 * 0 + Z0 / v); oz < Math.round(Z1 / v); oz += CH) for (let ox = Math.round(X0 / v); ox < Math.round(X1 / v); ox += CH)
    chunks.push({ ox, oz, w: Math.min(CH, Math.round(X1 / v) - ox), d: Math.min(CH, Math.round(Z1 / v) - oz) });
  const ctx = Object.assign({ net, voxel: v, F, R }, grid, { chunks, footprints: res.footprints, box: { x0: b.x0 + Math.floor((X0 - b.x0) / 4) * 4, z0: b.z0 + Math.floor((Z0 - b.z0) / 4) * 4, x1: X1, z1: Z1 } });
  let props = null;
  if (opts.props) {                                     // street furniture of the region's pages (placed like city_worker 'rpage')
    props = C.placeProps(ctx).filter(p => p.x >= X0 && p.x < X1 && p.z >= Z0 && p.z < Z1);
  }
  ctx.region = [X0, Z0, X1, Z1];
  return { raw: getRaw(), res, ctx, ms: Date.now() - t, props, groundY: R.hs, stacks: new Map(), pages: pages.size };
}
function copyAll(src, dst) {
  for (let q = 0; q < src.quads; ++q) {
    for (let k = 0; k < 12; ++k) dst.pos.push(src.pos[q * 12 + k]);
    for (let k = 0; k < 4; ++k) { dst.mat.push(src.mat[q * 4 + k]); dst.nrm.push(src.nrm[q * 4 + k]); }
    if (!dst.nvec) dst.nvec = [];
    if (src.nvec) for (let k = 0; k < 12; ++k) dst.nvec.push(src.nvec[q * 12 + k]);
    const b0 = dst.quads * 4; dst.idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3); dst.quads++;
  }
}
// copy of a MeshBuffer's arrays (cullHidden works in place)
function clone(mb) { return { pos: Array.from(mb.pos), mat: Array.from(mb.mat), nrm: Array.from(mb.nrm), nvec: Array.from(mb.nvec), idx: [], quads: mb.quads }; }

// Per-building segments: houses (all suburban houses as one entry), every job (block building / tower), extra
// (anything emitted after the jobs). Returns [{ id, q0, q1, info }].
function segments(res) {
  // tiled builds (CITY_TILE): houses are one segment per house lot (res.houseSegs), possibly spread over tiles
  const out = res.houseSegs ? res.houseSegs.map((s, i) => ({ id: 'h' + i, q0: s[0], q1: s[1], info: { kind: 'houses' } }))
    : [{ id: 'houses', q0: 0, q1: res.counts.houseQuads, info: { kind: 'houses' } }];
  let end = res.houseSegs ? Math.max(0, ...res.houseSegs.map(s => s[1])) : res.counts.houseQuads;
  res.footprints.forEach((f, i) => {
    out.push({ id: 'b' + i, q0: f.q0, q1: f.q1, info: f });
    end = Math.max(end, f.q1);
  });
  return { list: out, end };
}

// Signature of a set of quads that does not depend on how surfaces are split into quads: per (normal, material)
// the area, first and second moments of the covered surface (all additive over any partition), hashed.
function signature(mb, q0, q1) {
  const P = mb.pos, N = mb.nvec, G = new Map();
  let x0 = 1e18, y0 = 1e18, z0 = 1e18, x1 = -1e18, y1 = -1e18, z1 = -1e18, area = 0;
  const mats = {};
  for (let q = q0; q < q1; ++q) {
    const o = q * 12;
    let qa = 0;
    const m = mb.mat[q * 4];
    let g = null;
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) {          // two triangles: exact integrals, any quad shape
      const p0 = [P[o + i * 3], P[o + i * 3 + 1], P[o + i * 3 + 2]], p1 = [P[o + j * 3], P[o + j * 3 + 1], P[o + j * 3 + 2]], p2 = [P[o + k * 3], P[o + k * 3 + 1], P[o + k * 3 + 2]];
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      const ar = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
      if (ar < 1e-9) continue;
      if (!g) { const key = L.planeOf(P, N, q).nk * 256 + m; g = G.get(key); if (!g) G.set(key, g = new Float64Array(7)); }
      g[0] += ar; qa += ar;
      for (let c = 0; c < 3; ++c) {
        g[1 + c] += ar * (p0[c] + p1[c] + p2[c]) / 3;
        g[4 + c] += ar / 6 * (p0[c] * p0[c] + p1[c] * p1[c] + p2[c] * p2[c] + p0[c] * p1[c] + p0[c] * p2[c] + p1[c] * p2[c]);
      }
    }
    if (!qa) continue;
    area += qa; mats[m] = (mats[m] || 0) + qa;
    for (let k = 0; k < 4; ++k) {
      const X = P[o + k * 3], Y = P[o + k * 3 + 1], Z = P[o + k * 3 + 2];
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
  }
  const lines = [...G.keys()].sort((a, b) => a - b).map(k => k + ':' + [...G.get(k)].map(v => (Math.abs(v) < 1e-6 ? 0 : v).toPrecision(10)).join(','));
  const hash = require('crypto').createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
  const r1 = (v) => Math.round(v * 10) / 10;
  for (const k in mats) mats[k] = r1(mats[k] / 100);                 // m2
  return { hash, area: r1(area / 100), mats, bbox: area ? [x0, y0, z0, x1, y1, z1].map(v => r1(v / 10)) : null };
}

// ---- coplanar overlap detection
// Same-material pairs are skipped unless opts.all: same plane, normal and material shade identically, so whichever
// wins the depth test the pixel is the same (no visible flicker).
// Quads facing the same way in the same plane (within tol voxels) whose interiors overlap by more than minArea
// (voxels^2) and are thicker than minExt voxels (default 0.05 = 5 mm: the 2 mm strips where VoxModel quads, grown
// by meshVoxels3D to close T-junctions, overlap their neighbours are below a pixel and ignored) z-fight. Returns [{ a, b, area, at:[x,y,z] (m) }].
function clip(poly, ax, ay, bx, by) {                 // keep the part left of a->b
  const out = [];
  for (let i = 0; i < poly.length; ++i) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax), sq = (bx - ax) * (q[1] - ay) - (by - ay) * (q[0] - ax);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  }
  return out;
}
const polyArea = (p) => { let s = 0; for (let i = 0; i < p.length; ++i) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
function overlapArea(A2, B2) {
  let a = A2; if (polyArea(a) < 0) a = a.slice().reverse();
  let b = B2; if (polyArea(b) < 0) b = b.slice().reverse();
  let r = a;
  for (let i = 0; i < b.length && r.length; ++i) r = clip(r, b[i][0], b[i][1], b[(i + 1) % b.length][0], b[(i + 1) % b.length][1]);
  if (r.length < 3) return { area: 0, ext: 0 };
  // thickness of the overlap: its extent across its longest edge direction
  let best = 0, ext = 0;
  for (let i = 0; i < r.length; ++i) {
    const p = r[i], q = r[(i + 1) % r.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l <= best) continue;
    best = l; const nx = -(q[1] - p[1]) / l, ny = (q[0] - p[0]) / l;
    let lo = 1e18, hi = -1e18; for (const v of r) { const d = v[0] * nx + v[1] * ny; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    ext = hi - lo;
  }
  return { area: Math.abs(polyArea(r)), ext };
}
function zfight(mb, opts) {
  opts = opts || {};
  const tol = opts.tol || 0.01, minArea = opts.minArea || 1e-3, minExt = opts.minExt || 0.05, q0 = opts.q0 || 0, q1 = opts.q1 === undefined ? mb.quads : opts.q1;
  const P = mb.pos, N = mb.nvec, byN = new Map();
  for (let q = q0; q < q1; ++q) {
    const pl = L.planeOf(P, N, q);
    let a = byN.get(pl.nk); if (!a) byN.set(pl.nk, a = []);
    a.push([pl.d, q]);
  }
  const hits = [];
  for (const [, arr] of byN) {
    arr.sort((a, b) => a[0] - b[0]);
    const q = arr[0][1], o = q * 12, n = [N[o], N[o + 1], N[o + 2]];
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let U = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
    const lu = Math.hypot(...U); U = U.map(v => v / lu);
    const V = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
    for (let i = 0; i < arr.length;) {
      let j = i + 1; while (j < arr.length && arr[j][0] - arr[j - 1][0] < tol) ++j;
      if (j - i > 1) {
        const items = [];
        for (let k = i; k < j; ++k) {
          const qq = arr[k][1], oo = qq * 12, poly = [];
          let s0 = 1e18, s1 = -1e18, t0 = 1e18, t1 = -1e18;
          for (let v = 0; v < 4; ++v) {
            const x = P[oo + v * 3], y = P[oo + v * 3 + 1], z = P[oo + v * 3 + 2];
            const s = x * U[0] + y * U[1] + z * U[2], t = x * V[0] + y * V[1] + z * V[2];
            poly.push([s, t]); s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
          }
          items.push({ q: qq, poly, s0, s1, t0, t1 });
        }
        items.sort((a, b) => a.s0 - b.s0);
        for (let a = 0; a < items.length; ++a) {
          const A2 = items[a];
          for (let b = a + 1; b < items.length && items[b].s0 < A2.s1; ++b) {
            const B2 = items[b];
            if (B2.t0 >= A2.t1 || B2.t1 <= A2.t0) continue;
            if (!opts.all && mb.mat[A2.q * 4] === mb.mat[B2.q * 4]) continue;
            const ov = overlapArea(A2.poly, B2.poly), ar = ov.area;
            if (ar > minArea && ov.ext > minExt) {
              const oo = A2.q * 12;
              hits.push({ a: A2.q, b: B2.q, area: ar, at: [P[oo] / 10, P[oo + 1] / 10, P[oo + 2] / 10] });
            }
          }
        }
      }
      i = j;
    }
  }
  return hits;
}
// segment (building) index of a quad
function segOf(segs, q) {
  for (const s of segs) if (q >= s.q0 && q < s.q1) return s;
  return null;
}
module.exports = { C, A, L, build, clone, segments, signature, zfight, segOf, overlapArea };
