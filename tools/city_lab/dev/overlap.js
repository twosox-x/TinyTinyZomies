// Solid-object clipping check: objects passing through each other (zfight.js only finds coplanar faces).
//   node --max-old-space-size=8000 tools/city_lab/dev/overlap.js [seed] [--list=N] [--tol=0.05] [--all-props]
//
// Builds a seed headlessly (meshcheck.build with street furniture) with the CityArch.lib.debugPlace hook set, so the
// park kit (towers/parkkit.js put / pad) and the yard kit (towers/yardkit.js put / house) report every placed model
// copy with its model-local -> world map. Each object becomes one or more solid parts in world metres:
//   tree (park / yard)     trunk: box round the TRUNK-material faces rising from the ground (the bole, not the limbs); crown: cylinder (0.85 x the half extent of
//                          everything else: octagonal blobs) over its height range
//   service kit            each servicekit put() (dumpsters, pallets, vans, fences, dock doors): box round the model
//   bush, item, fence...   box round the whole model (oriented with the copy)
//   street furniture       placeProps output: box below 2.4 m ('low': poles, bins, hydrants, benches...) and box above
//                          ('high': lamp heads / arms, signal mast arms, shelter roofs); street 'tree': trunk + crown
//   buildings              footprints of the block buildings / towers (res.footprints) up to their mesh top;
//                          suburban houses from the yard kit's lot.house (9 m)
//   pads                   park paths, plaza paving, tree grates (not solids: used for "tree on paving")
// A pair counts when the parts interpenetrate by more than --tol (default 5 cm) in plan AND in height.
// Intended contact is excluded: crowns with crowns, trunk in another tree's crown, bushes with crowns / bushes,
// fence / hedge pieces with each other and with the house they meet, hedges with crowns, planter trees with their planter, parts of one object.
// Bushes may touch anything by 15 cm. Street furniture against street furniture is reported on its own line
// (downtown is locked: placement there changes only to remove genuine clipping).
// Also: a park tree whose trunk stands on a path or on plaza paving outside a tree grate / planter.
//
// For the traffic agent: require('./overlap.js').footprints(seed) -> [{ kind: 'prop' | 'tree' | 'item' | 'building'
//   | 'house', name, part, x, z, yaw, hu, hv, r, y0, y1 }] (metres, world): every street-furniture part, every park /
//   yard tree (trunk box + crown cylinder r), park / yard items, building and house footprints. Boxes: centre (x, z),
//   half sizes hu along (cos yaw, sin yaw) and hv across; cylinders: r (hu = hv = r). Use it to keep vehicles off them.
//   footprints(seed, B) reuses a build from meshcheck.build(seed, { props: true }) made with the hook already set
//   (see collect()).
const MC = require('./meshcheck.js');
const L = MC.L;
const TRUNK = new Set([135, 64, 58]);                    // TRUNK; birch stems (white, black marks)
const CROWN = +(process.env.OVERLAP_CROWN || 0.85);     // crown cylinder radius / half extent (octagonal blobs)

function collect(seed) {
  const recs = [];
  L.debugPlace = (r) => recs.push(r);
  let B;
  try { B = MC.build(seed, { props: true }); } finally { L.debugPlace = null; }
  const names = new Map();
  for (const [k, v] of (L.debugParkCache || new Map())) if (v && v.mesh) names.set(v.mesh, k);
  for (const [k, v] of (L.debugYardCache || new Map())) if (v) { names.set(v, k); if (v.M) names.set(v.M, k); }
  const parts = [], pads = [];
  let oid = 0;
  const bbCache = new WeakMap();
  const classBoxes = (m, tree) => {
    let c = bbCache.get(m); if (c) return c;
    c = {};
    for (let q = 0; q < m.quads; ++q) {
      let ymin = 1e9; for (let k = 0; k < 4; ++k) ymin = Math.min(ymin, m.pos[q * 12 + k * 3 + 1]);
      const cls = tree ? (TRUNK.has(m.mat[q * 4]) ? (ymin <= 1e-6 ? 'trunk' : null) : 'crown') : 'body';
      if (!cls) continue;
      let b = c[cls]; if (!b) b = c[cls] = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      for (let k = 0; k < 4; ++k) for (let a = 0; a < 3; ++a) { const v = m.pos[q * 12 + k * 3 + a]; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
    }
    bbCache.set(m, c); return c;
  };
  const obbFrom = (map, b) => {
    const p0 = map(b[0], b[1], b[2]), pu = map(b[3], b[1], b[2]), pv = map(b[0], b[1], b[5]), py = map(b[0], b[4], b[2]);
    const ux = pu[0] - p0[0], uz = pu[2] - p0[2], vx = pv[0] - p0[0], vz = pv[2] - p0[2];
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    return { x: p0[0] + (ux + vx) / 2, z: p0[2] + (uz + vz) / 2, yaw: Math.atan2(uz, ux), hu: lu / 2, hv: lv / 2, y0: Math.min(p0[1], py[1]), y1: Math.max(p0[1], py[1]) };
  };
  for (const r of recs) {
    if (r.pad) { pads.push(r); continue; }
    if (r.house) {
      const E = r.E, h = r.house, BV = L.BV;
      const map = (a, y, b) => [E.O[0] + a * BV * E.e1[0] + b * BV * E.e2[0], E.y0 + y, E.O[1] + a * BV * E.e1[1] + b * BV * E.e2[1]];
      parts.push(Object.assign(obbFrom(map, [h.x0, 0, h.z0, h.x1, 9, h.z1]), { o: oid++, kit: 'yard', kind: 'house', name: 'house', part: 'body' }));
      continue;
    }
    const key = r.kit === 'service' ? 'service-' + (r.name || '?') : names.get(r.kit === 'yard' ? r.model : r.mesh) || (r.kit === 'yard' ? 'car?' : '?');
    const base = key.replace(/^i:/, '').split(':')[0];
    const tree = /^(t|tree)$/.test(base);
    const kind = tree ? 'tree' : /^(b|bush)$/.test(base) ? 'bush' : /^seg:(low)?hedge/.test(key) ? 'hedge' : /^(seg|gate|arbor)$/.test(base) ? 'fence' : base === 'car?' ? 'car' : 'item';
    const name = tree ? 'tree' : kind === 'bush' ? 'bush' : base;
    const cb = classBoxes(r.mesh, tree), o = oid++;
    for (const cls in cb) {
      const p = obbFrom(r.map, cb[cls]);
      Object.assign(p, { o, kit: r.kit, kind, name, part: cls, key });
      if (cls === 'crown' || kind === 'bush') { p.r = Math.max(p.hu, p.hv) * CROWN; p.cyl = true; }
      parts.push(p);
    }
  }
  // street furniture
  const meshes = MC.C.buildPropMeshes();
  for (const p of B.props || []) {
    const m = meshes[p.type]; if (!m) continue;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw), o = oid++;
    const map = (x, y, z) => [p.x + c * x + s * z, p.y + y, p.z - s * x + c * z];
    const lo = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9], hi = lo.slice();
    const add = (b, x, y, z) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z; if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z; };
    for (let q = 0; q < m.pos.length / 12; ++q) {           // faces split at 2.4 m (a pole is one tall quad)
      let y0 = 1e9, y1 = -1e9; for (let k = 0; k < 4; ++k) { const y = m.pos[q * 12 + k * 3 + 1]; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (let k = 0; k < 4; ++k) {
        const x = m.pos[q * 12 + k * 3], y = m.pos[q * 12 + k * 3 + 1], z = m.pos[q * 12 + k * 3 + 2];
        if (y0 < 2.4) add(lo, x, Math.min(y, 2.4), z);
        if (y1 > 2.4) add(hi, x, Math.max(y, 2.4), z);
      }
    }
    const tree = /tree/i.test(p.type);
    for (const [b, cls] of [[lo, tree ? 'trunk' : 'low'], [hi, tree ? 'crown' : 'high']]) {
      if (b[0] > b[3]) continue;
      const q = Object.assign(obbFrom(map, b), { o, kit: 'street', kind: tree ? 'tree' : 'prop', name: p.type, part: cls });
      if (tree && cls === 'trunk') { q.hu = Math.min(q.hu, 0.15); q.hv = Math.min(q.hv, 0.15); }   // pit / grate below is flat
      if (cls === 'crown') { q.r = Math.max(q.hu, q.hv) * CROWN; q.cyl = true; }
      parts.push(q);
    }
  }
  // buildings (block buildings, towers, lot buildings)
  const raw = B.raw, v = B.ctx.voxel;
  for (const f of B.res.footprints || []) {
    let top = 0; for (let q = f.q0; q < f.q1; ++q) for (let k = 0; k < 4; ++k) top = Math.max(top, raw.pos[q * 12 + k * 3 + 1] * v);
    const O = f.O, e1 = f.e1, e2 = f.e2 || [-e1[1], e1[0]];
    parts.push({ x: O[0] + e1[0] * f.w / 2 + e2[0] * f.d / 2, z: O[1] + e1[1] * f.w / 2 + e2[1] * f.d / 2, yaw: Math.atan2(e1[1], e1[0]), hu: f.w / 2, hv: f.d / 2,
      y0: B.groundY * v, y1: top, o: oid++, kit: 'building', kind: 'building', name: f.type || f.kind, part: 'body' });
  }
  return { B, parts, pads, recs };
}

// ---- geometry
function depthXZ(a, b) {
  if (a.cyl && b.cyl) return a.r + b.r - Math.hypot(a.x - b.x, a.z - b.z);
  if (a.cyl || b.cyl) {
    const c = a.cyl ? a : b, o = a.cyl ? b : a, cs = Math.cos(o.yaw), sn = Math.sin(o.yaw);
    const dx = c.x - o.x, dz = c.z - o.z, lu = dx * cs + dz * sn, lv = -dx * sn + dz * cs;
    const qu = Math.max(-o.hu, Math.min(o.hu, lu)), qv = Math.max(-o.hv, Math.min(o.hv, lv));
    if (Math.abs(lu) <= o.hu && Math.abs(lv) <= o.hv) return c.r + Math.min(o.hu - Math.abs(lu), o.hv - Math.abs(lv));
    return c.r - Math.hypot(lu - qu, lv - qv);
  }
  let best = 1e9;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const yaw of [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2]) {
    const ax = Math.cos(yaw), az = Math.sin(yaw);
    const ra = a.hu * Math.abs(Math.cos(a.yaw) * ax + Math.sin(a.yaw) * az) + a.hv * Math.abs(-Math.sin(a.yaw) * ax + Math.cos(a.yaw) * az);
    const rb = b.hu * Math.abs(Math.cos(b.yaw) * ax + Math.sin(b.yaw) * az) + b.hv * Math.abs(-Math.sin(b.yaw) * ax + Math.cos(b.yaw) * az);
    best = Math.min(best, ra + rb - Math.abs(dx * ax + dz * az));
    if (best <= 0) return best;
  }
  return best;
}
function aabb(p) {
  if (p.cyl) return [p.x - p.r, p.z - p.r, p.x + p.r, p.z + p.r];
  const c = Math.abs(Math.cos(p.yaw)), s = Math.abs(Math.sin(p.yaw)), ex = p.hu * c + p.hv * s, ez = p.hu * s + p.hv * c;
  return [p.x - ex, p.z - ez, p.x + ex, p.z + ez];
}
// pair rule: null = intended contact (skip), else the tolerance (m)
function rule(a, b, tol) {
  if (a.o === b.o) return null;
  const k = (p) => p.kind + '.' + p.part;
  const A = k(a), Bk = k(b), has = (x) => A === x || Bk === x, both = (x) => A === x && Bk === x;
  if (both('tree.crown')) return null;
  if (has('tree.crown') && has('tree.trunk')) return null;
  if (a.kind === 'bush' || b.kind === 'bush') { if (has('tree.crown') || both('bush.body')) return null; return 0.15; }
  const bnd = (p) => p.kind === 'fence' || p.kind === 'hedge';
  if (bnd(a) && bnd(b)) return null;                                     // runs abut end to end
  if ((bnd(a) && b.kind === 'house') || (bnd(b) && a.kind === 'house')) return null;   // wing fences meet the house
  if ((a.kind === 'hedge' && has('tree.crown')) || (b.kind === 'hedge' && has('tree.crown'))) return null;   // clipped hedge under a crown
  if ((a.name === 'planter' && b.kind === 'tree') || (b.name === 'planter' && a.kind === 'tree')) return null;
  if (a.kind === 'building' && b.kind === 'building') return null;
  if ((a.kit === 'service' && b.kind === 'building') || (b.kit === 'service' && a.kind === 'building')) return null;   // dock doors, fences, bins against walls
  if (a.kit === 'service' && b.kit === 'service') return null;                                // composed parts (dock + door, fence runs)
  if ((a.kind === 'building' || a.kind === 'house') && (b.kind === 'building' || b.kind === 'house')) return null;
  return tol;
}
function check(C, opts) {
  opts = opts || {};
  const tol = opts.tol === undefined ? 0.05 : opts.tol;
  const P = C.parts, CS = 4, G = new Map(), key = (i, j) => i * 100003 + j;
  P.forEach((p, i) => { const b = aabb(p); p.bb = b; for (let x = Math.floor(b[0] / CS); x <= Math.floor(b[2] / CS); ++x) for (let z = Math.floor(b[1] / CS); z <= Math.floor(b[3] / CS); ++z) { const kk = key(x, z); let a = G.get(kk); if (!a) G.set(kk, a = []); a.push(i); } });
  const hits = [], seen = new Set();
  for (const [, list] of G) for (let i = 0; i < list.length; ++i) for (let j = i + 1; j < list.length; ++j) {
    const a = P[list[i]], b = P[list[j]];
    const t = rule(a, b, tol); if (t === null) continue;
    if (a.bb[2] <= b.bb[0] || b.bb[2] <= a.bb[0] || a.bb[3] <= b.bb[1] || b.bb[3] <= a.bb[1]) continue;
    const yov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); if (yov <= t) continue;
    const pk = list[i] < list[j] ? list[i] * 1e7 + list[j] : list[j] * 1e7 + list[i]; if (seen.has(pk)) continue; seen.add(pk);
    const d = depthXZ(a, b); if (d <= t) continue;
    hits.push({ a, b, depth: Math.min(d, yov) });
  }
  // trees on paving: a park tree trunk on a path / plaza pad and not in a grate
  const inPad = (p, x, z, m) => { const c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = x - p.x, dz = z - p.z; return Math.abs(dx * c + dz * s) < p.hu + m && Math.abs(-dx * s + dz * c) < p.hv + m; };
  for (const t of P) if (t.kind === 'tree' && t.part === 'trunk' && t.kit === 'park') {
    const on = C.pads.filter(p => (p.pad === 'path' || p.pad === 'plaza') && inPad(p, t.x, t.z, 0.2));
    if (on.length && !C.pads.some(p => p.pad === 'grate' && inPad(p, t.x, t.z, 0)) && !P.some(q => q.name === 'planter' && Math.hypot(q.x - t.x, q.z - t.z) < 0.5))
      hits.push({ a: t, b: { kit: 'park', kind: 'pad', name: on[0].pad, part: 'paving', x: on[0].x, z: on[0].z }, depth: 0, paving: true });
  }
  return hits;
}
const label = (p) => `${p.kit}:${p.kind === 'tree' || p.kind === 'bush' ? p.kind : p.name}.${p.part}`;
function footprints(seed) {
  const C = collect(seed);
  return C.parts.filter(p => p.kit === 'street' || p.kind === 'tree' || p.kind === 'item' || p.kind === 'building' || p.kind === 'house' || p.kind === 'car')
    .map(p => ({ kind: p.kit === 'street' ? (p.kind === 'tree' ? 'tree' : 'prop') : p.kind, name: p.name, part: p.part, x: p.x, z: p.z, yaw: p.yaw, hu: p.cyl ? p.r : p.hu, hv: p.cyl ? p.r : p.hv, r: p.cyl ? p.r : undefined, y0: p.y0, y1: p.y1 }));
}
module.exports = { collect, check, footprints, depthXZ };

if (require.main === module) {
  const args = process.argv.slice(2);
  const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
  const la = args.find(a => a.startsWith('--list=')), LIST = la ? +la.slice(7) : 30;
  const ta = args.find(a => a.startsWith('--tol=')), tol = ta ? +ta.slice(6) : 0.05;
  const t0 = Date.now();
  const C = collect(seed);
  const hits = check(C, { tol });
  const by = {};
  for (const h of hits) { h.k = h.paving ? `${label(h.a)} on ${h.b.name} paving` : [label(h.a), label(h.b)].sort().join(' | '); by[h.k] = (by[h.k] || 0) + 1; }
  const nStreet = hits.filter(h => h.a.kit === 'street' && h.b.kit === 'street').length;
  console.log(`seed ${seed}: ${C.parts.length} solid parts (${C.recs.length} kit placements), ${hits.length} interpenetrations > ${tol} m (${nStreet} street furniture vs street furniture) [${Date.now() - t0} ms]`);
  for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  hits.sort((a, b) => b.depth - a.depth);
  for (const h of hits.slice(0, LIST)) console.log(`  at x ${h.a.x.toFixed(1)} z ${h.a.z.toFixed(1)} / x ${h.b.x.toFixed(1)} z ${h.b.z.toFixed(1)}  depth ${h.depth.toFixed(2)} m  ${h.k}`);
  process.exitCode = hits.length ? 1 : 0;
}
