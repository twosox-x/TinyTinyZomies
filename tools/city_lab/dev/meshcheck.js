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
