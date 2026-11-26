#!/usr/bin/env node
// Reads a baked city package back (FORMAT.md) and reports counts; exit 1 on a structural error.
// node verify.js assets/city/seed1 [--hash]
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const B = require('./lib.js'), L = require('./lod.js');
const dir = process.argv[2] || 'assets/city/seed1', wantHash = process.argv.includes('--hash');
const errs = [], err = (s) => { if (errs.length < 30) errs.push(s); };
const city = JSON.parse(fs.readFileSync(path.join(dir, 'city.json'), 'utf8'));
if (city.format !== 'ttz-city' || city.version !== 1) err('city.json format/version');
const hash = crypto.createHash('sha256');
let bytes = fs.statSync(path.join(dir, 'city.json')).size;

function checkMesh(b, where, nMat, quantRange) {
  const m = B.readMesh(b);
  if (!(m.flags & 1) || m.I !== 0) err(where + ': not an implicit quad list');
  if (m.V !== m.quads * 4 || m.lod1Quads > m.quads) err(where + ': quad counts');
  if (b.length < 72 + m.V * 12) err(where + ': truncated');
  let badMat = 0, badN = 0;
  for (let v = 0; v < m.V; v += 7) {                   // sample
    const o = m.vo + v * 12, nx = b.readInt8(o + 8), ny = b.readInt8(o + 9), nz = b.readInt8(o + 10), mat = b[o + 11];
    if (mat >= nMat) badMat++;
    const l = Math.hypot(nx, ny, nz); if (l < 120 || l > 134) badN++;
  }
  if (badMat) err(where + `: ${badMat} sampled vertices with material >= ${nMat}`);
  if (badN) err(where + `: ${badN} sampled vertices with non-unit normals`);
  return m;
}

const T = { stored: 0, raw: 0, chunkTiles: 0, chunks: 0, tiles: 0, missing: 0, quads: 0, quads1: 0, vehicles: 0, props: 0, cells: 0, blocked: 0, road: 0, walk: 0, building: 0, water: 0, veg: 0, vehicleCells: 0, maxTop: 0, maxY: 0, waterTiles: 0, foliage: 0, folTiles: 0, folTypes: {} };
const nVar = city.vehicles.variants.length, nProp = city.props.types.length, nMat = city.palette.length;
for (const [i, j] of city.tile.present) {
  const fp = path.join(dir, 'tiles', `${i}_${j}.bin`);
  if (!fs.existsSync(fp)) { T.missing++; continue; }
  const buf = fs.readFileSync(fp); bytes += buf.length; if (wantHash) hash.update(buf);
  const f = B.readFile(buf); T.tiles++;
  if (f.magic !== 'TTZT' || (f.ver !== 1 && f.ver !== 2) || (f.reserved & 0xffff) !== i || (f.reserved >>> 16) !== j) err(`${i}_${j}: header`);
  const ms = f.sections.get('MESH');
  if (ms) { const m = checkMesh(ms, `${i}_${j} MESH`, nMat); T.quads += m.quads; T.quads1 += m.lod1Quads; T.maxY = Math.max(T.maxY, m.aabb[4]);
    const cs = f.sections.get('CHNK');
    if (!!cs !== !!(m.flags & 2)) err(`${i}_${j}: MESH chunk flag / CHNK mismatch`);
    if (cs) {
      const c = L.readChunks(cs); let w = 0, n1 = 0; T.chunkTiles++;
      for (const k of c.chunks) {
        if (k.first !== w || k.n1 > k.n0) err(`${i}_${j} CHNK ranges`);
        w += k.n0; n1 += k.n1; if (k.n0) T.chunks++;
        for (let q = k.first; q < k.first + k.n0; q += 13) for (let v = 0; v < 4; ++v) {   // sampled: vertices inside the chunk AABB
          const o = m.vo + (q * 4 + v) * 12, p = [m.origin[0] + ms.readInt16LE(o) * m.sxz, m.origin[1] + ms.readInt16LE(o + 2) * m.sy, m.origin[2] + ms.readInt16LE(o + 4) * m.sxz];
          for (let a = 0; a < 3; ++a) if (p[a] < k.bmin[a] - 1e-3 || p[a] > k.bmax[a] + 1e-3) { err(`${i}_${j} CHNK aabb`); break; }
        }
      }
      if (w !== m.quads || n1 !== m.lod1Quads) err(`${i}_${j} CHNK totals ${w}/${m.quads} ${n1}/${m.lod1Quads}`);
    }
    for (const [t, s] of Object.entries(f.stored)) { T.stored += s.bytes; T.raw += s.raw; } }
  const vs = f.sections.get('VEHI');
  if (vs) {
    const n = vs.readUInt32LE(0); if (vs.length !== 4 + n * 28) err(`${i}_${j} VEHI size`);
    for (let k = 0; k < n; ++k) {
      const o = 4 + k * 28, v = vs.readUInt16LE(o), x = vs.readFloatLE(o + 8), z = vs.readFloatLE(o + 16);
      if (v >= nVar) err(`${i}_${j} VEHI variant ${v}`);
      const q = [0, 1, 2, 3].map(c => vs.readInt16LE(o + 20 + c * 2) / 32767), l = Math.hypot(...q);
      if (Math.abs(l - 1) > 0.01) err(`${i}_${j} VEHI quaternion |q| = ${l}`);
      const x0 = city.bounds.x0 + i * city.tile.size, z0 = city.bounds.z0 + j * city.tile.size;
      if (x < x0 - 30 || x > x0 + city.tile.size + 30 || z < z0 - 30 || z > z0 + city.tile.size + 30) err(`${i}_${j} VEHI instance far outside its tile`);
    }
    T.vehicles += n;
  }
  const ps = f.sections.get('PROP');
  if (ps) { const n = ps.readUInt32LE(0); if (ps.length !== 4 + n * 24) err(`${i}_${j} PROP size`); for (let k = 0; k < n; ++k) if (ps.readUInt16LE(4 + k * 24) >= nProp) err(`${i}_${j} PROP type`); T.props += n; }
  const ws = f.sections.get('WATR');                 // optional: shore-distance grid
  if (ws) { const n = ws.readUInt32LE(0), m = ws.readUInt32LE(4); if (ws.length < 32 + n * m * 2 || n < 2 || m < 2) err(`${i}_${j} WATR size`); T.waterTiles++; }
  const fs2 = f.sections.get('FOLI');                // optional: foliage instances (chunk, type ranges)
  if (fs2) {
    const n = fs2.readUInt32LE(0), nc = fs2.readUInt32LE(4), nt = fs2.readUInt32LE(8), o = 16 + (nc * nt + 1) * 4;
    if (fs2.length !== o + n * 8 || fs2.readUInt32LE(16 + nc * nt * 4) !== n) err(`${i}_${j} FOLI size`);
    const nTypes = (city.foliage && city.foliage.types.length) || 0;
    for (let c = 0; c < nc * nt; ++c) { const a = fs2.readUInt32LE(16 + c * 4), b = fs2.readUInt32LE(20 + c * 4); if (b < a) err(`${i}_${j} FOLI ranges`); if (b > a) { const t = c % nt; if (t >= nTypes) err(`${i}_${j} FOLI type ${t}`); T.folTypes[t] = (T.folTypes[t] || 0) + b - a; } }
    T.foliage += n; T.folTiles++;
  }
  const hs = f.sections.get('HGT0');
  if (!hs) err(`${i}_${j}: no HGT0`);
  else {
    const nx = hs.readUInt32LE(0), nz = hs.readUInt32LE(4), to = 20, fo = to + nx * nz * 2;
    if (nx !== 256 || nz !== 256 || hs.readFloatLE(8) !== 0.5) err(`${i}_${j} HGT0 dims`);
    for (let k = 0; k < nx * nz; ++k) {
      const fl = hs[fo + k], top = hs.readInt16LE(to + k * 2); T.cells++;
      if (top > T.maxTop) T.maxTop = top;
      if (fl & 1) T.road++; if (fl & 2) T.walk++; if (fl & 4) T.building++; if (fl & 8) T.water++; if (fl & 16) T.veg++; if (fl & 32) T.blocked++; if (fl & 64) T.vehicleCells++;
    }
  }
}
function checkModels(file, magic, n, pre, pre1) {
  const buf = fs.readFileSync(path.join(dir, file)); bytes += buf.length; if (wantHash) hash.update(buf);
  const f = B.readFile(buf); if (f.magic !== magic) err(file + ' magic');
  let q = 0, l1 = 0, paintV = 0;
  for (let k = 0; k < n; ++k) {
    const id = String(k).padStart(3, '0'), s = f.sections.get(pre + id);
    if (!s) { err(`${file}: missing ${pre + id}`); continue; }
    const m = checkMesh(s, file + ' ' + pre + id, nMat); q += m.quads;
    for (let v = 0; v < m.V; ++v) if (s.readUInt16LE(m.vo + v * 12 + 6) & 1) paintV++;
    if (pre1 && f.sections.get(pre1 + id)) { checkMesh(f.sections.get(pre1 + id), file + ' ' + pre1 + id, nMat); l1++; }
  }
  return { meshes: n, quads: q, lod1: l1, paintVerts: paintV };
}
const veh = checkModels('vehicles.bin', 'TTZV', nVar, 'V', 'W');
const prp = checkModels('props.bin', 'TTZP', nProp, 'P');
const fol = city.foliage ? checkModels(city.foliage.file || 'foliage.bin', 'TTZF', city.foliage.types.length, 'F', 'G') : null;
const lb = fs.readFileSync(path.join(dir, 'landuse.bin')); bytes += lb.length; if (wantHash) hash.update(lb);
const lu = B.readFile(lb).sections.get('LUSE'), lnx = lu.readUInt32LE(0), lnz = lu.readUInt32LE(4);
const luHist = {}; for (let k = 0; k < lnx * lnz; ++k) { const n = city.landUse.legend[lu[20 + k]]; luHist[n] = (luHist[n] || 0) + 1; }
if (wantHash) { const c = Object.assign({}, city, { stats: Object.assign({}, city.stats, { bakeSeconds: 0, tileMsMedian: 0, tileMsMax: 0, workers: 0, workerHeapMaxMB: 0 }) }); hash.update(JSON.stringify(c)); }

const pct = (a) => (100 * a / Math.max(1, T.cells)).toFixed(1) + '%';
console.log(`package ${dir}: seed ${city.seed} scale ${city.scale}, map ${(city.bounds.x1 - city.bounds.x0).toFixed(0)} x ${(city.bounds.z1 - city.bounds.z0).toFixed(0)} m, grid ${city.tile.ni} x ${city.tile.nj}`);
console.log(`tiles: ${T.tiles} read, ${T.missing} missing; ${(bytes / 1048576).toFixed(1)} MB total`);
console.log(`tile sections: ${(T.stored / 1048576).toFixed(1)} MB stored, ${(T.raw / 1048576).toFixed(1)} MB raw (${(T.raw / Math.max(1, T.stored)).toFixed(2)}x); chunked tiles ${T.chunkTiles}, non-empty chunks ${T.chunks}`);
console.log(`mesh: LOD0 ${T.quads} quads (${2 * T.quads} tris), LOD1 ${T.quads1} quads (${(100 * T.quads1 / Math.max(1, T.quads)).toFixed(0)} %), highest vertex ${T.maxY.toFixed(1)} m`);
console.log(`instances: ${T.vehicles} vehicles / traffic props (${nVar} variants, ${veh.lod1} with LOD1, ${veh.paintVerts} body-paint vertices), ${T.props} street props (${nProp} types, ${prp.quads} quads)`);
console.log(`height grid: ${T.cells} cells; road ${pct(T.road)}, walk ${pct(T.walk)}, building ${pct(T.building)}, water ${pct(T.water)}, veg ${pct(T.veg)}, blocked ${pct(T.blocked)}, vehicle ${pct(T.vehicleCells)}; max top ${(T.maxTop / 100).toFixed(1)} m`);
if (fol) console.log(`foliage: ${T.foliage} instances in ${T.folTiles} tiles (` + city.foliage.types.map((t, n) => `${t.name} ${T.folTypes[n] || 0}`).join(', ') + `), ${fol.meshes} models (${fol.quads} LOD0 quads, ${fol.lod1} LOD1)`);
if (city.water) console.log(`water: ${T.waterTiles} tiles with WATR (level ${city.water.level} m), ${city.water.bridges.length} bridges (` + city.water.bridges.map(b => b.kind + ' ' + b.width + ' m').join(', ') + ')');
console.log(`land use ${lnx} x ${lnz} @ ${city.landUse.cell} m: ` + Object.entries(luHist).map(([k, v]) => `${k} ${(100 * v / (lnx * lnz)).toFixed(1)}%`).join(', '));
console.log(`roads ${city.roads.length}, spawns ${city.spawns.length}, palette ${nMat} (${city.palette.filter(p => p.emissive).length} emissive)`);
if (wantHash) console.log('sha256 ' + hash.digest('hex'));
if (errs.length) { console.log('ERRORS:\n  ' + errs.join('\n  ')); process.exit(1); }
console.log('OK');
