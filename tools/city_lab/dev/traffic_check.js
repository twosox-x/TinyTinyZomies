// Road-traffic clearance check (GPU-instanced vehicles from towers/traffickit.js, which zfight.js cannot see).
//   node --max-old-space-size=8000 tools/city_lab/dev/traffic_check.js [seed] [--list=N] [--gap=0.15]
// Builds the seed headlessly, reads res.traffic (variant meshes + 3x4 instance transforms) and derives every
// instance's oriented box from its variant's real vertices transformed by its matrix (rolled vehicles included).
// Reports:
//   veh-veh     two instances closer than gap (default 0.15 m) in plan (separating-axis test); 'overlap' if they
//               interpenetrate
//   veh-prop    street furniture (placeProps, prop-mesh parts lower than the vehicle's top) closer than gap
//   veh-bldg    a building footprint closer than gap
//   bounds      a corner outside the world bounds minus 3 m
//   surface     a corner / the centre not on a surface at the vehicle's base height (road y = 0 on carriageway or
//               gutter; sidewalk cars at curb height on sidewalk), or on a curb / median / alley / plot
const MC = require('./meshcheck.js');
const C = MC.C || require(__dirname + '/../city_core.js');
const args = process.argv.slice(2);
const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
const LIST = +((args.find(a => a.startsWith('--list=')) || '--list=20').slice(7));
const GAP = +((args.find(a => a.startsWith('--gap=')) || '--gap=0.15').slice(6));
const B = MC.build(seed, { props: true });
const T = B.res.traffic;
if (!T) { console.log('no traffic output'); process.exit(1); }
const n = T.count, M = T.M;
// variant vertex bounds
const vb = T.variants.map(v => { const P = v.hi.pos; let a = [1e9, 1e9, 1e9], b = [-1e9, -1e9, -1e9]; for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; ++c) { a[c] = Math.min(a[c], P[i + c]); b[c] = Math.max(b[c], P[i + c]); } return [a, b]; });
const boxes = [];
for (let i = 0; i < n; ++i) {
  const o = i * 12, [a, bb] = vb[T.vid[i]];
  let ex = [M[o], M[o + 8]]; const l = Math.hypot(ex[0], ex[1]) || 1; ex = [ex[0] / l, ex[1] / l]; const ez = [-ex[1], ex[0]];
  let u0 = 1e9, u1 = -1e9, w0 = 1e9, w1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let k = 0; k < 8; ++k) {
    const p = [(k & 1) ? bb[0] : a[0], (k & 2) ? bb[1] : a[1], (k & 4) ? bb[2] : a[2]];
    const X = M[o] * p[0] + M[o + 1] * p[1] + M[o + 2] * p[2] + M[o + 3], Y = M[o + 4] * p[0] + M[o + 5] * p[1] + M[o + 6] * p[2] + M[o + 7], Z = M[o + 8] * p[0] + M[o + 9] * p[1] + M[o + 10] * p[2] + M[o + 11];
    const u = X * ex[0] + Z * ex[1], w = X * ez[0] + Z * ez[1];
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
  }
  const cu = (u0 + u1) / 2, cw = (w0 + w1) / 2;
  boxes.push({ i, kind: T.variants[T.vid[i]].kind, x: cu * ex[0] + cw * ez[0], z: cu * ex[1] + cw * ez[1], hx: (u1 - u0) / 2, hz: (w1 - w0) / 2, c: ex[0], s: ex[1], y0, y1, base: y0 });
}
// separation distance lower bound along the separating axes (negative = overlap)
function sep(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z; let best = -1e9;
  for (const [ux, uz] of [[a.c, a.s], [-a.s, a.c], [b.c, b.s], [-b.s, b.c]]) {
    const ra = a.hx * Math.abs(a.c * ux + a.s * uz) + a.hz * Math.abs(-a.s * ux + a.c * uz);
    const rb = b.hx * Math.abs(b.c * ux + b.s * uz) + b.hz * Math.abs(-b.s * ux + b.c * uz);
    best = Math.max(best, Math.abs(dx * ux + dz * uz) - ra - rb);
  }
  return best;
}
const issues = { 'veh-veh': [], 'veh-prop': [], 'veh-bldg': [], bounds: [], surface: [] };
let overlaps = 0;
const HC = 10, H = new Map(), key = (i, j) => i * 100003 + j;
const cellsOf = (o, pad) => { const r = Math.abs(o.c) * o.hx + Math.abs(o.s) * o.hz + pad, q = Math.abs(o.s) * o.hx + Math.abs(o.c) * o.hz + pad, out = []; for (let i = Math.floor((o.x - r) / HC); i <= Math.floor((o.x + r) / HC); ++i) for (let j = Math.floor((o.z - q) / HC); j <= Math.floor((o.z + q) / HC); ++j) out.push(key(i, j)); return out; };
for (const a of boxes) {
  const seen = new Set();
  for (const k of cellsOf(a, GAP)) { const l = H.get(k); if (l) for (const b of l) { if (seen.has(b)) continue; seen.add(b); const d = sep(a, b); if (d < GAP - 1e-3) { issues['veh-veh'].push([a.i, b.i, a.kind, b.kind, d.toFixed(3), a.x.toFixed(1), a.z.toFixed(1)]); if (d < 0) ++overlaps; } } }
  for (const k of cellsOf(a, 0)) { let l = H.get(k); if (!l) H.set(k, l = []); l.push(a); }
}
// street furniture: footprint of the prop mesh parts below the vehicle's top (buckets)
const PM = C.buildPropMeshes(), LV = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
const PF = {};
for (const t in PM) {
  const P = PM[t].pos, nq = P.length / 12;
  PF[t] = LV.map(lim => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let q = 0; q < nq; ++q) { let y = 1e9; for (let k = 0; k < 4; ++k) y = Math.min(y, P[q * 12 + k * 3 + 1]); if (y >= lim) continue; for (let k = 0; k < 4; ++k) { x0 = Math.min(x0, P[q * 12 + k * 3]); x1 = Math.max(x1, P[q * 12 + k * 3]); z0 = Math.min(z0, P[q * 12 + k * 3 + 2]); z1 = Math.max(z1, P[q * 12 + k * 3 + 2]); } } return x0 < 1e8 ? [x0, x1, z0, z1] : null; });
}
for (const p of B.props || []) {
  const F = PF[p.type]; if (!F) continue;
  const c = Math.cos(p.yaw), s = -Math.sin(p.yaw);
  const pb = { x: p.x, z: p.z, hx: 6, hz: 6, c: 1, s: 0 };
  const near = new Set(); for (const k of cellsOf(pb, 0)) { const l = H.get(k); if (l) for (const b of l) near.add(b); }
  for (const v of near) {
    const top = v.y1 - (v.base || 0), li = LV.findIndex(L => L >= top), Bx = F[li < 0 ? LV.length - 1 : li];
    if (!Bx) continue;
    const cu = (Bx[0] + Bx[1]) / 2, cv = (Bx[2] + Bx[3]) / 2;
    const ob = { x: p.x + cu * c - cv * s, z: p.z + cu * s + cv * c, hx: (Bx[1] - Bx[0]) / 2, hz: (Bx[3] - Bx[2]) / 2, c, s };
    const d = sep(v, ob);
    if (d < GAP - 1e-3) { issues['veh-prop'].push([v.i, v.kind, p.type, d.toFixed(3), v.x.toFixed(1), v.z.toFixed(1)]); if (d < 0) ++overlaps; }
  }
}
for (const f of B.res.footprints) {
  const l = Math.hypot(f.e1[0], f.e1[1]) || 1, c = f.e1[0] / l, s = f.e1[1] / l;
  const ob = { x: f.O[0] + f.e1[0] * f.w / 2 + f.e2[0] * f.d / 2, z: f.O[1] + f.e1[1] * f.w / 2 + f.e2[1] * f.d / 2, hx: f.w / 2, hz: f.d / 2, c, s };
  const near = new Set(); for (const k of cellsOf(ob, GAP)) { const L = H.get(k); if (L) for (const b of L) near.add(b); }
  for (const v of near) { const d = sep(v, ob); if (d < GAP - 1e-3) { issues['veh-bldg'].push([v.i, v.kind, f.type || f.kind, d.toFixed(3), v.x.toFixed(1), v.z.toFixed(1)]); if (d < 0) ++overlaps; } }
}
const net = B.ctx.net || B.res.net, R = B.ctx.R, bd = (B.ctx.net || net).bounds, MAT = C.MAT;
const ROAD = new Set([MAT.ASPHALT, MAT.ASPHALT_B, MAT.ASPHALT_C, MAT.GUTTER, MAT.PAINT_WHITE, MAT.PAINT_YELLOW, MAT.PARKING, MAT.CROSSWALK]);
const WALK = new Set([MAT.SIDEWALK, MAT.SIDEWALK_JOINT]);
const o = {}, cls = [0, 0];
for (const v of boxes) {
  if (v.kind.startsWith('prop:') && false) continue;
  const pts = [[0, 0]]; for (const [a, d] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([a * v.hx, d * v.hz]);
  let bad = null;
  for (const [u, w] of pts) {
    const x = v.x + u * v.c - w * v.s, z = v.z + u * v.s + w * v.c;
    if (x < bd.x0 + 3 - 1e-3 || x > bd.x1 - 3 + 1e-3 || z < bd.z0 + 3 - 1e-3 || z > bd.z1 - 3 + 1e-3) { issues.bounds.push([v.i, v.kind, x.toFixed(1), z.toFixed(1)]); break; }
    R.classify(x, z, o, cls);
    const okM = v.base > 0.01 ? WALK.has(cls[1]) : ROAD.has(cls[1]);
    const rd = o.road >= 0 ? R.roads[o.road] : null;
    if (o.road < 0 || Math.abs(cls[0] * 0.1 - v.base) > 0.02 || !okM || (rd && rd.P.id === 'alley')) { bad = [v.i, v.kind, 'mat' + cls[1], 'y' + cls[0], v.x.toFixed(1), v.z.toFixed(1)]; break; }
  }
  if (bad) issues.surface.push(bad);
}
const kinds = {}; for (const v of boxes) { const k = v.kind.startsWith('prop:') ? 'props' : 'vehicles'; kinds[k] = (kinds[k] || 0) + 1; }
console.log(`seed ${seed}: ${n} instances (${kinds.vehicles || 0} vehicles, ${kinds.props || 0} props), ${T.variants.length} variants, build ${B.ms} ms, traffic ${B.res.counts.trafficMs} ms`);
let total = 0;
for (const k in issues) { total += issues[k].length; console.log(`  ${k}: ${issues[k].length}`); for (const e of issues[k].slice(0, LIST)) console.log('    ', e.join(' ')); }
console.log(`issues: ${total} (interpenetrating: ${overlaps})`);
process.exitCode = total ? 1 : 0;
