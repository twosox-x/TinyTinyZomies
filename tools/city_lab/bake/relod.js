#!/usr/bin/env node
// Adds the far LOD to an existing package (FORMAT.md 3, LOD2) and reorders MESH for the stricter LOD1, in place:
//   node relod.js assets/city/seed1 [--jobs=4] [--force]
// bake.js does the same for new bakes; tiles that already have LOD2 are skipped unless --force.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
if (!isMainThread) {
  const L = require('./lod.js'), B = require('./lib.js');
  const out = [];
  for (const fp of workerData.files) {
    const nb = L.relodTile(fs.readFileSync(fp), workerData.force);
    if (nb) { fs.writeFileSync(fp + '.tmp', nb); fs.renameSync(fp + '.tmp', fp); }
    const f = B.readFile(nb || fs.readFileSync(fp)), m = f.sections.get('MESH'), l2 = f.sections.get('LOD2');
    out.push({ name: path.basename(fp, '.bin'), bytes: (nb || fs.statSync(fp)).length || fs.statSync(fp).size,
      q1: m ? B.readMesh(m).lod1Quads : 0, q2: l2 ? B.readMesh(l2).quads : 0 });
  }
  parentPort.postMessage(out);
} else {
  const dir = process.argv[2], jobs = +((process.argv.find(a => a.startsWith('--jobs=')) || '').split('=')[1] || Math.max(1, os.cpus().length));
  const files = fs.readdirSync(path.join(dir, 'tiles')).filter(f => f.endsWith('.bin')).sort().map(f => path.join(dir, 'tiles', f));
  const t0 = Date.now(), parts = [...Array(jobs)].map(() => []);
  files.forEach((f, k) => parts[k % jobs].push(f));
  Promise.all(parts.filter(p => p.length).map(p => new Promise((res, rej) => { const w = new Worker(__filename, { workerData: { files: p, force: process.argv.includes('--force') } }); w.on('message', res); w.on('error', rej); })))
    .then(rs => {
      const all = rs.flat(), byName = new Map(all.map(r => [r.name, r]));
      const cj = path.join(dir, 'city.json'), city = JSON.parse(fs.readFileSync(cj, 'utf8'));
      city.tile.lod2 = true;
      city.tile.present = city.tile.present.map(([i, j, b]) => { const r = byName.get(`${i}_${j}`); return [i, j, r ? r.bytes : b]; });
      city.stats.tris1 = all.reduce((s, r) => s + r.q1 * 2, 0);
      city.stats.tris2 = all.reduce((s, r) => s + r.q2 * 2, 0);
      city.stats.bytes = fs.readdirSync(dir).filter(f => f.endsWith('.bin') || f.endsWith('.json')).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) + all.reduce((s, r) => s + r.bytes, 0);
      fs.writeFileSync(cj, JSON.stringify(city, null, 1));
      console.log(`relod: ${all.length} tiles, ${((Date.now() - t0) / 1000).toFixed(1)} s, tris0 ${city.stats.tris0}, tris1 ${city.stats.tris1}, tris2 ${city.stats.tris2}`);
    }).catch(e => { console.error(e); process.exit(1); });
}
