// Headless regression check for the downtown / old-town / core buildings and towers.
//   node --max-old-space-size=8000 tools/city_lab/dev/regress.js            compare seeds 1-3 with baseline_downtown.json
//   node --max-old-space-size=8000 tools/city_lab/dev/regress.js --update   rewrite the baseline
//   options: --seeds=1,2  --no-props  --no-zfight  --baseline=other.json
//
// Per building (every block-placed / lot building and tower, in build order): kind, type, floors, footprint
// (origin, frame, width, depth) and a geometry signature; suburban houses are one entry; anything emitted after
// the buildings ("extra") is one entry; the street-furniture list is hashed per seed.
//
// The geometry signature tolerates removing faces that can never be seen, and re-splitting surfaces into quads:
//  1. normalise: the raw building mesh is run through CityArch.lib.cullHidden() (drops zero-area quads, downward
//     faces on the ground plane, and the overlap of coplanar opposite-facing faces = two solids pressed flush
//     together). The approved mesh and an optimised one that already culls those faces normalise to the same
//     visible surface;
//  2. per (normal, material): surface area and first / second moments of the surface (exact integrals per
//     rectangle, additive over any partition), rounded to 10 significant digits and hashed.
// So merging coplanar quads or cutting hidden overlaps keeps the hash; moving, recolouring, adding or removing a
// visible face changes it. A mismatch prints the area per material and bounding box for diagnosis.
// Also counts same-facing coplanar overlaps (z-fighting, see zfight.js): fails if a seed has more than the baseline.
const fs = require('fs');
const MC = require('./meshcheck.js');
const args = process.argv.slice(2);
const UPDATE = args.includes('--update'), NOPROPS = args.includes('--no-props'), NOZ = args.includes('--no-zfight');
const sa = args.find(a => a.startsWith('--seeds='));
const SEEDS = sa ? sa.slice(8).split(',').map(Number) : [1, 2, 3];
const ba = args.find(a => a.startsWith('--baseline='));
const FILE = ba ? ba.slice(11) : __dirname + '/baseline_downtown.json';
const r3 = (v) => Math.round(v * 1000) / 1000;

function fingerprint(seed) {
  const t0 = Date.now();
  const B = MC.build(seed, { props: !NOPROPS });
  const raw = B.raw, rawQuads = raw.quads;
  const { list, end } = MC.segments(B.res);
  list.push({ id: 'extra', q0: end, q1: raw.quads, info: { kind: 'extra' } });
  const zf = NOZ ? null : MC.zfight(raw);
  const mb = MC.clone(raw);
  const marks = [];
  for (const s of list) marks.push(s.q0, s.q1);
  const cr = MC.L.cullHidden(mb, B.groundY, marks);
  const out = { buildMs: B.ms, rawTris: rawQuads * 2, visibleTris: mb.quads * 2, buildings: [] };
  list.forEach((s, i) => {
    const sig = MC.signature(mb, cr.marks[2 * i], cr.marks[2 * i + 1]);
    const f = s.info;
    const e = { id: s.id, kind: f.kind };
    if (f.type) e.type = f.type;
    if (f.floors !== undefined) e.floors = f.floors;
    if (f.O) { e.O = f.O.map(r3); e.e1 = f.e1.map(r3); e.w = r3(f.w); e.d = r3(f.d); }
    Object.assign(e, sig);
    out.buildings.push(e);
  });
  if (B.props) {
    const lines = B.props.map(p => [p.type, p.x, p.y, p.z, p.yaw].map(v => typeof v === 'number' ? v.toFixed(3) : v).join(','));
    const counts = {}; for (const p of B.props) counts[p.type] = (counts[p.type] || 0) + 1;
    out.props = { n: B.props.length, counts, hash: require('crypto').createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16) };
  }
  if (zf) {
    const by = {};
    for (const h of zf) { const s = MC.segOf(list, h.a), t = MC.segOf(list, h.b); const k = [s, t].map(x => x ? (x.info.type || x.id) : '?').join('|'); by[k] = (by[k] || 0) + 1; }
    out.zfight = zf.length; out.zfightBy = by;
  }
  out.checkMs = Date.now() - t0;
  return out;
}

const base = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { seeds: {} };
let fails = 0;
for (const seed of SEEDS) {
  const cur = fingerprint(seed);
  console.log(`seed ${seed}: build ${cur.buildMs} ms, raw ${cur.rawTris} tris, visible ${cur.visibleTris} tris, ${cur.buildings.length - 2} buildings` +
    (cur.zfight !== undefined ? `, z-fighting overlaps ${cur.zfight}` : '') + (cur.props ? `, props ${cur.props.n}` : ''));
  if (UPDATE) { base.seeds[seed] = cur; continue; }
  const old = base.seeds[seed];
  if (!old) { console.log('  no baseline for this seed (run with --update)'); fails++; continue; }
  if (old.buildings.length !== cur.buildings.length) { console.log(`  FAIL building count ${old.buildings.length} -> ${cur.buildings.length}`); fails++; }
  const n = Math.min(old.buildings.length, cur.buildings.length);
  let bad = 0;
  const idx = (b) => b.id === 'houses' || b.id === 'extra' ? b.id : b.id;
  const oldBy = new Map(old.buildings.map(b => [idx(b), b]));
  for (const c of cur.buildings) {
    const o = oldBy.get(idx(c));
    if (!o) { console.log(`  FAIL ${c.id} new`); bad++; continue; }
    const diffs = [];
    for (const k of ['kind', 'type', 'floors', 'w', 'd']) if (o[k] !== c[k]) diffs.push(`${k} ${o[k]} -> ${c[k]}`);
    if (JSON.stringify(o.O) !== JSON.stringify(c.O) || JSON.stringify(o.e1) !== JSON.stringify(c.e1)) diffs.push('footprint moved');
    if (o.hash !== c.hash) {
      diffs.push(`geometry (area ${o.area} -> ${c.area} m2)`);
      const ms = new Set([...Object.keys(o.mats), ...Object.keys(c.mats)]);
      const md = [...ms].filter(m => o.mats[m] !== c.mats[m]).map(m => `mat ${m}: ${o.mats[m] || 0} -> ${c.mats[m] || 0}`);
      if (md.length) diffs.push(md.slice(0, 6).join('; '));
      if (JSON.stringify(o.bbox) !== JSON.stringify(c.bbox)) diffs.push(`bbox ${JSON.stringify(o.bbox)} -> ${JSON.stringify(c.bbox)}`);
    }
    if (diffs.length) {
      bad++;
      if (bad <= 25) console.log(`  FAIL ${c.id} ${c.type || c.kind}${c.O ? ' at ' + c.O.map(v => (v).toFixed(1)).join(',') : ''}: ${diffs.join(' | ')}`);
    }
  }
  if (bad) { console.log(`  ${bad} of ${n} entries differ`); fails += bad; }
  if (cur.props && old.props && cur.props.hash !== old.props.hash) { console.log(`  FAIL props ${JSON.stringify(old.props.counts)} -> ${JSON.stringify(cur.props.counts)}`); fails++; }
  if (cur.zfight !== undefined && old.zfight !== undefined && cur.zfight > old.zfight) {
    console.log(`  FAIL z-fighting overlaps ${old.zfight} -> ${cur.zfight}: ${JSON.stringify(cur.zfightBy)}`); fails++;
  }
  if (!bad) console.log(`  ok: all ${n} entries match (baseline raw ${old.rawTris} tris, build ${old.buildMs} ms)`);
}
if (UPDATE) { fs.writeFileSync(FILE, JSON.stringify(base, null, 0).replace(/\{"id"/g, '\n{"id"')); console.log('baseline written', FILE); }
else { console.log(fails ? `REGRESSION: ${fails} failures` : 'PASS'); process.exitCode = fails ? 1 : 0; }
