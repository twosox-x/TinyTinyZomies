#!/usr/bin/env node
// Repacks an existing package in place, no re-bake (FORMAT.md): every tile gets the far LOD (LOD2) and the stricter
// LOD1 when missing (--force recomputes them), sub-tile chunks (CHNK, MESH in chunk order) and per-section zstd
// compression (file format v2); vehicles.bin / props.bin / landuse.bin are recompressed too. Idempotent.
//   node relod.js assets/city/seed1 [--jobs=4] [--force] [--level=19] [--no-compress] [--no-chunks]
// bake.js runs the same code (lod.js processTile) on new bakes.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
if (!isMainThread) {
  const L = require('./lod.js'), B = require('./lib.js');
  const out = [];
  for (const fp of workerData.files) {
    const old = fs.readFileSync(fp), t0 = Date.now();
    const nb = L.processTile(old, workerData.opts);
    const ms = Date.now() - t0;
    if (!nb.equals(old)) { fs.writeFileSync(fp + '.tmp', nb); fs.renameSync(fp + '.tmp', fp); }
    const t1 = process.hrtime.bigint(), f = B.readFile(nb), decMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const m = f.sections.get('MESH'), l2 = f.sections.get('LOD2');
    out.push({ name: path.basename(fp, '.bin'), bytes: nb.length, rawBytes: Object.values(f.stored).reduce((s, x) => s + x.raw, 0), ms, decMs,
      q1: m ? B.readMesh(m).lod1Quads : 0, q2: l2 ? B.readMesh(l2).quads : 0 });
  }
  parentPort.postMessage(out);
} else {
  const arg = (k, d) => { const a = process.argv.find(s => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
  const dir = process.argv[2], jobs = +arg('jobs', Math.max(1, os.cpus().length));
  const level = process.argv.includes('--no-compress') ? 0 : +arg('level', 19);
  const opts = { force: process.argv.includes('--force'), zstd: level, chunks: !process.argv.includes('--no-chunks') };
  const files = fs.readdirSync(path.join(dir, 'tiles')).filter(f => f.endsWith('.bin')).sort().map(f => path.join(dir, 'tiles', f));
  const t0 = Date.now(), parts = [...Array(jobs)].map(() => []);
  files.forEach((f, k) => parts[k % jobs].push(f));
  Promise.all(parts.filter(p => p.length).map(p => new Promise((res, rej) => { const w = new Worker(__filename, { workerData: { files: p, opts } }); w.on('message', res); w.on('error', rej); })))
    .then(rs => {
      const B = require('./lib.js');
      for (const [file, magic] of [['vehicles.bin', 'TTZV'], ['props.bin', 'TTZP'], ['landuse.bin', 'TTZL']]) {
        const fp = path.join(dir, file); if (!fs.existsSync(fp)) continue;
        const f = B.readFile(fs.readFileSync(fp));
        fs.writeFileSync(fp, B.writeFile(magic, f.reserved, f.order.map(t => [t, f.sections.get(t)]), { v2: true, zstd: level }));
      }
      const all = rs.flat(), byName = new Map(all.map(r => [r.name, r]));
      const cj = path.join(dir, 'city.json'), city = JSON.parse(fs.readFileSync(cj, 'utf8'));
      updateCityJson(city, all, level, opts.chunks);
      city.tile.present = city.tile.present.map(([i, j, b]) => { const r = byName.get(`${i}_${j}`); return [i, j, r ? r.bytes : b]; });
      city.stats.bytes = fs.readdirSync(dir).filter(f => f.endsWith('.bin') || f.endsWith('.json')).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) + all.reduce((s, r) => s + r.bytes, 0);
      fs.writeFileSync(cj, JSON.stringify(city, null, 1));
      const sorted = all.map(r => r.decMs).sort((a, b) => a - b);
      console.log(`relod: ${all.length} tiles, ${((Date.now() - t0) / 1000).toFixed(1)} s, tiles ${(all.reduce((s, r) => s + r.bytes, 0) / 1048576).toFixed(1)} MB` +
        ` (raw ${(all.reduce((s, r) => s + r.rawBytes, 0) / 1048576).toFixed(1)} MB), package ${(city.stats.bytes / 1048576).toFixed(1)} MB;` +
        ` JS decode ms median ${sorted[sorted.length >> 1].toFixed(1)} max ${sorted[sorted.length - 1].toFixed(1)}; tris0 ${city.stats.tris0}, tris1 ${city.stats.tris1}, tris2 ${city.stats.tris2}`);
    }).catch(e => { console.error(e); process.exit(1); });
}

function updateCityJson(city, all, level, chunks) {
  const L = require('./lod.js');
  city.compression = level ? 'zstd' : 'none';
  city.tile.lod2 = true;
  if (chunks) city.tile.chunks = { n: L.CH_N, size: L.CH_SIZE }; else delete city.tile.chunks;
  city.stats.tris1 = all.reduce((s, r) => s + r.q1 * 2, 0);
  city.stats.tris2 = all.reduce((s, r) => s + r.q2 * 2, 0);
  city.stats.rawBytes = all.reduce((s, r) => s + r.rawBytes, 0);
}
module.exports = { updateCityJson };
