// Z-fighting check: builds a seed headlessly (houses, block buildings, towers, roof kit, service-yard dressing)
// and lists coplanar faces that face the same way and overlap (they flicker). Opposite-facing coincident faces are
// not reported: the renderer draws front faces only, so they never fight.
//   node --max-old-space-size=8000 tools/city_lab/dev/zfight.js [seed] [--all] [--raw] [--props] [--list=N]
//   --all    also same-material pairs (they shade identically, so they cannot flicker visibly)
//   --raw    test the mesh before buildAll's z-fight pass (cullHidden resolve), to see what that pass fixes
//   --props  also street furniture (each placed prop model, in world space) against everything else
// Detection (dev/meshcheck.js zfight): every quad bucketed by quantised normal and plane offset (tolerance 1 mm),
// then within a plane cluster a sweep tests 2D polygon overlap: positive area, thicker than 5 mm (pure edge
// contact and the 2 mm strips where pre-grown VoxModel quads meet are ignored).
// Output: count, breakdown by building type (pairs inside one building / between two), and world positions (m).
const MC = require('./meshcheck.js');
const args = process.argv.slice(2);
const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
const ALL = args.includes('--all'), RAW = args.includes('--raw'), PROPS = args.includes('--props');
const la = args.find(a => a.startsWith('--list=')), LIST = la ? +la.slice(7) : 20;

let rawMB = null;
const B = MC.build(seed, { props: PROPS, beforeCull: RAW ? (mb) => { rawMB = MC.clone(mb); } : null });
let mb = RAW && rawMB ? rawMB : B.raw;
const { list, end } = MC.segments(B.res);
list.push({ id: 'extra', q0: end, q1: mb.quads, info: { kind: 'service / extra', type: 'service' } });
let segs = list;
if (RAW && rawMB) segs = [{ id: 'all', q0: 0, q1: mb.quads, info: { type: 'buildings (pre-pass)' } }];
let nProps = 0;
if (PROPS && B.props) {
  // place every prop model in world space (road-voxel units like the buildings) and append it as one segment
  const meshes = MC.C.buildPropMeshes(), v = 0.1, q0 = mb.quads;
  const out = MC.clone(mb);
  const propOf = []; global.__propOf = propOf;
  for (const p of B.props) {
    const m = meshes[p.type]; if (!m || !m.nvec && !m.nrm) continue;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
    for (let q = 0; q < m.pos.length / 12; ++q) {
      // a prop's underside rests on the ground / sidewalk / stoop and can never be seen: not a z-fight
      if ((m.nvec ? m.nvec[q * 12 + 1] : (m.nrm[q * 4] === 5 ? -1 : 0)) < -0.9) continue;
      for (let k = 0; k < 4; ++k) {
        const x = m.pos[q * 12 + k * 3], y = m.pos[q * 12 + k * 3 + 1], z = m.pos[q * 12 + k * 3 + 2];
        out.pos.push((p.x + c * x + s * z) / v, (p.y + y) / v, (p.z - s * x + c * z) / v);
        const n = m.nvec ? [m.nvec[q * 12], m.nvec[q * 12 + 1], m.nvec[q * 12 + 2]] : NV[m.nrm[q * 4]];
        out.nvec.push(c * n[0] + s * n[2], n[1], -s * n[0] + c * n[2]);
      }
      for (let k = 0; k < 4; ++k) { out.mat.push(1000 + m.mat[q * 4]); out.nrm.push(0); }
      propOf[out.quads] = p.type; out.quads++;
    }
    nProps++;
  }
  mb = out;
  segs = segs.concat([{ id: 'props', q0, q1: mb.quads, info: { type: 'street furniture' } }]);
}
const t = Date.now();
const hits = MC.zfight(mb, { all: ALL });
const name = (s) => s ? (s.info.type || s.info.kind || s.id) : '?';
const by = {};
for (const h of hits) {
  const a = MC.segOf(segs, h.a), b = MC.segOf(segs, h.b);
  h.k = a === b ? 'within ' + name(a) : 'between ' + [name(a), name(b)].sort().join(' | ');
  h.ids = [a && a.id, b && b.id];
  if (global.__propOf) h.ptypes = [global.__propOf[h.a], global.__propOf[h.b]].filter(Boolean);
  by[h.k] = (by[h.k] || 0) + 1;
}
console.log(`seed ${seed}: ${mb.quads} quads${nProps ? ` (incl. ${nProps} props)` : ''}, ${hits.length} z-fighting overlaps${ALL ? ' (incl. same-material)' : ''} [${Date.now() - t} ms]`);
for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
for (const h of hits.slice(0, LIST)) console.log(`  at x ${h.at[0].toFixed(1)} y ${h.at[1].toFixed(1)} z ${h.at[2].toFixed(1)}  ${(h.area / 100).toFixed(4)} m2  mats ${mb.mat[h.a * 4]}/${mb.mat[h.b * 4]}  ${h.k} ${h.ids.join(",")} ${(h.ptypes || []).join("+")}`);
process.exitCode = hits.length ? 1 : 0;
