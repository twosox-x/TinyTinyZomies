// Ground z-fighting check: flat overlays (park paving, paths, plaza floors, pads, lawns, yard surfaces, driveways,
// lot slabs, building / plug-in up-facing faces, street furniture (placeProps) up faces) against the road / ground raster mesh
// (city_core buildChunk: greedy-meshed columns, the roads, sidewalks, plots and park ground) and against each other.
// zfight.js only compares quads inside the building mesh (+ props): the raster is a separate mesh, so an overlay
// lying (almost) on the ground plane was invisible to it.
//   node --max-old-space-size=8000 tools/city_lab/dev/groundfight.js [seed] [--tol=0.02] [--list=N] [--self]
//   --tol   vertical separation (m) below which two up-facing surfaces count as fighting (default 0.02 = 2 cm: at
//           RTS distance the depth buffer cannot separate less; exactly coplanar faces always fight)
//   --self  also overlay-vs-overlay pairs at a separation in (1 mm, tol) (exactly coplanar ones are zfight.js' job),
//           ground-level surfaces only (up to 0.5 m above the sidewalk level)
// Pairs: up-facing quads (normal y > 0.99) whose xz projections overlap by more than 0.01 m2 and 5 cm thickness,
// whose heights differ by less than tol, different material (same material shades identically). Raster quads count
// only where they are visible (a top face): the overlay can sit above or below it (sunk overlays still fight
// when they are within tol below).
const MC = require('./meshcheck.js');
const args = process.argv.slice(2);
const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
const ta = args.find(a => a.startsWith('--tol=')), TOL = ta ? +ta.slice(6) : 0.02;
const la = args.find(a => a.startsWith('--list=')), LIST = la ? +la.slice(7) : 25;
const SELF = args.includes('--self');
const C = MC.C;

function run(seed) {
  const B = MC.build(seed, { props: true });
  const ctx = B.ctx, v = ctx.voxel, tolV = TOL / v;
  // raster top faces (after cuts, like the page)
  const ground = [];
  for (const c of ctx.chunks) {
    const m = C.buildChunk(ctx, c);
    for (let q = 0; q < m.quads; ++q) {
      if (m.nrm[q * 4] !== 0) continue;
      const o = q * 12, P = m.pos;
      const poly = [[P[o], P[o + 2]], [P[o + 3], P[o + 5]], [P[o + 6], P[o + 8]], [P[o + 9], P[o + 11]]];
      ground.push({ y: P[o + 1], mat: m.mat[q * 4], poly, ...ext(poly), src: 'ground' });
    }
  }
  const mb = B.raw, { list, end } = MC.segments(B.res);
  list.push({ id: 'extra', q0: end, q1: mb.quads, info: { kind: 'service / park / extra', type: 'extra' } });
  const over = [];
  for (let q = 0; q < mb.quads; ++q) {
    const o = q * 12;
    if (mb.nvec[o + 1] < 0.99) continue;
    const P = mb.pos;
    const ys = [P[o + 1], P[o + 4], P[o + 7], P[o + 10]];
    if (Math.max(...ys) - Math.min(...ys) > 0.01) continue;
    const poly = [[P[o], P[o + 2]], [P[o + 3], P[o + 5]], [P[o + 6], P[o + 8]], [P[o + 9], P[o + 11]]];
    over.push({ y: ys[0], mat: mb.mat[q * 4], poly, ...ext(poly), q });
  }
  // street furniture (placeProps): up faces of every placed prop model, world space (as zfight.js --props)
  const meshes = C.buildPropMeshes();
  for (const p of B.props || []) {
    const m = meshes[p.type]; if (!m) continue;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    for (let q = 0; q < m.pos.length / 12; ++q) {
      const up = m.nvec ? m.nvec[q * 12 + 1] > 0.99 : m.nrm[q * 4] === 0;
      if (!up) continue;
      const o = q * 12, poly = [];
      for (let k = 0; k < 4; ++k) { const x = m.pos[o + k * 3], z = m.pos[o + k * 3 + 2]; poly.push([(p.x + c * x + s * z) / v, (p.z - s * x + c * z) / v]); }
      over.push({ y: (p.y + m.pos[o + 1]) / v, mat: 1000 + m.mat[q * 4], poly, ...ext(poly), q: -1, prop: p.type });
    }
  }
  // spatial hash of the ground tops (4 m cells)
  const CS = 4 / v, G = new Map();
  const key = (i, j) => i * 100003 + j;
  const ins = (map, g, idx) => {
    for (let i = Math.floor(g.x0 / CS); i <= Math.floor(g.x1 / CS); ++i) for (let j = Math.floor(g.z0 / CS); j <= Math.floor(g.z1 / CS); ++j) {
      const k = key(i, j); let a = map.get(k); if (!a) map.set(k, a = []); a.push(idx);
    }
  };
  ground.forEach((g, i) => ins(G, g, i));
  const hits = [], seen = new Set();
  const test = (a, b, kind) => {
    if (a.mat === b.mat) return;
    if (Math.abs(a.y - b.y) >= tolV) return;
    if (b.x0 >= a.x1 || b.x1 <= a.x0 || b.z0 >= a.z1 || b.z1 <= a.z0) return;
    const ov = MC.overlapArea(a.poly, b.poly);
    if (ov.area * v * v > 0.01 && ov.ext * v > 0.05) hits.push({ a, b, kind, dy: (a.y - b.y) * v, area: ov.area * v * v });
  };
  for (const a of over) {
    const cand = new Set();
    for (let i = Math.floor(a.x0 / CS); i <= Math.floor(a.x1 / CS); ++i) for (let j = Math.floor(a.z0 / CS); j <= Math.floor(a.z1 / CS); ++j) for (const k of (G.get(key(i, j)) || [])) cand.add(k);
    for (const k of cand) test(a, ground[k], 'ground');
  }
  if (SELF) {
    const O = new Map();
    over.forEach((g, i) => ins(O, g, i));
    const yMax = (B.groundY + 0.5 / v);               // ground-level overlays only (pads, paths, lawns, beds; not crowns)
    for (let ai = 0; ai < over.length; ++ai) {
      const a = over[ai], cand = new Set();
      if (a.y > yMax) continue;
      for (let i = Math.floor(a.x0 / CS); i <= Math.floor(a.x1 / CS); ++i) for (let j = Math.floor(a.z0 / CS); j <= Math.floor(a.z1 / CS); ++j) for (const k of (O.get(key(i, j)) || [])) if (k > ai && over[k].y <= yMax) cand.add(k);
      for (const k of cand) { const b = over[k]; if (Math.abs(a.y - b.y) * v > 0.001) test(a, b, 'overlay'); }
    }
  }
  const segName = (q, o) => { if (q < 0) return 'street furniture ' + ((o && o.prop) || ''); const s = MC.segOf(list, q); return s ? (s.info.type || s.info.kind || s.id) : '?'; };
  const by = {};
  for (const h of hits) {
    h.k = h.kind === 'ground' ? `${segName(h.a.q, h.a)} | ground` : [segName(h.a.q, h.a), segName(h.b.q, h.b)].sort().join(' | ');
    h.k += h.kind === 'ground' ? ` mat ${h.a.mat}/g${h.b.mat}` : '';
    by[h.k] = (by[h.k] || 0) + 1;
  }
  return { hits, by, nGround: ground.length, nOver: over.length };
}
function ext(poly) {
  let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}
if (require.main === module) {
  const t = Date.now();
  const r = run(seed);
  console.log(`seed ${seed}: ${r.nOver} up-facing overlay quads vs ${r.nGround} ground tops, ${r.hits.length} fights (|dy| < ${TOL} m; ground${SELF ? " + overlay" : ""}) [${Date.now() - t} ms]`);
  for (const [k, n] of Object.entries(r.by).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  const bins = {}; for (const h of r.hits) { const b = Math.abs(h.dy) < 0.001 ? '<1mm' : Math.abs(h.dy) < 0.005 ? '1-5mm' : Math.abs(h.dy) < 0.01 ? '5-10mm' : '10mm+'; bins[b] = (bins[b] || 0) + 1; }
  console.log('  by separation: ' + JSON.stringify(bins));
  for (const h of r.hits.slice(0, LIST)) {
    const cx = (h.a.x0 + h.a.x1) / 2 * 0.1, cz = (h.a.z0 + h.a.z1) / 2 * 0.1;
    console.log(`  at x ${cx.toFixed(1)} z ${cz.toFixed(1)} y ${(h.a.y * 0.1).toFixed(3)} dy ${(h.dy * 1000).toFixed(1)} mm ${h.area.toFixed(2)} m2  mats ${h.a.mat}/${h.b.mat}  ${h.k}`);
  }
  process.exitCode = r.hits.length ? 1 : 0;
}
module.exports = { run };
