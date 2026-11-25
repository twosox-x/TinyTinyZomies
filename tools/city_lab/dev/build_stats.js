// headless full build: node dev/build_stats.js [seed] -> build time, triangles, tower and mid-rise counts
const C = require(''+__dirname+'/../city_core.js');
const A = require(''+__dirname+'/../city_arch.js');
global.self = global; self.CityArch = A;
const fs = require('fs');
self.TOWER_FILES = null; eval(fs.readFileSync(__dirname + '/../towers/manifest.js', 'utf8'));
for (const f of self.TOWER_FILES.map(x => x.replace('.js', ''))) eval(fs.readFileSync(''+__dirname+'/../towers/' + f + '.js', 'utf8'));
const net = C.generateCity(+(process.argv[2]||1)), ctx = C.prepareBuild(net, 0.1);
const PL = new C.Plots(net, ctx.F, ctx.R, 0.5, 1); PL.build();
const t = Date.now();
const r = A.buildAll(PL, ctx.R, 0.1, C);
console.log('ms', Date.now() - t, 'tris', r.idx.length / 3, 'towers', r.towers.length);
const c = {}; for (const x of r.towers) c[x.type] = (c[x.type] || 0) + 1; console.log(JSON.stringify(c));
const m = {}; for (const x of r.mids || []) m[x.type] = (m[x.type] || 0) + 1; console.log(JSON.stringify(m));
