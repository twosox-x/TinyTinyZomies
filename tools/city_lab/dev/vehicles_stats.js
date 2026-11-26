// usage: node dev/vehicles_stats.js  -> triangles / size per vehicle kind and state (City Lab vehicle library)
const C = require('../city_core.js'), V = C.Vehicles;
const states = ['ok', 'damaged', 'crashed', 'burnt', 'rolled'];
const t0 = Date.now();
for (const k of V.KINDS) {
  const row = [];
  for (const st of states) { const r = V.mesh(k, { seed: 1, state: st }); row.push(st + ' ' + (r.mesh.quads * 2)); }
  const r = V.mesh(k, { seed: 1 }), d = V.mesh(k, { seed: 1, doors: true, lights: true });
  console.log(k.padEnd(15), `${r.len.toFixed(2)} x ${r.wid.toFixed(2)} x ${r.h.toFixed(2)} m`.padEnd(24), row.join('  '), ' doors+lights', d.mesh.quads * 2);
}
console.log('total ms', Date.now() - t0);
