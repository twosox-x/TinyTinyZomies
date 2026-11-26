// RTS screenshots of a grown map (generateCity opts.scale): the page and its workers are served from disk, with
// city_core.js prefixed by `self.CITY_LAB_SCALE = N` (generateCity's dev default), so page and workers agree.
//   node tools/city_lab/dev/grow_shots.js '<json [[name, x, z] | [name, tx, ty, tz, ex, ey, ez], ...]>' [--scale=5] [--seed=1] [--out=DIR]
const fs = require('fs'), path = require('path');
const PW = require('./lib/pw.js');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const SCALE = +opt('scale', 5), SEED = +opt('seed', 1), OUT = opt('out', process.env.OUT || '/tmp/city_shots');
const VIEWS = JSON.parse(args.find(a => a.startsWith('[')) || '[]');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await PW.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 760 } });
  await PW.serve(ctx);
  const core = fs.readFileSync(path.join(PW.ROOT, 'city_core.js'), 'utf8');
  await ctx.route(PW.HOST + '/city_core.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: `self.CITY_LAB_SCALE = ${SCALE};\n` + core }));
  const p = await ctx.newPage();
  const logs = []; p.on('pageerror', e => logs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
  await PW.freezeClock(p);
  const t0 = Date.now();
  await p.goto(PW.HOST + '/city_lab.html');
  if (SEED !== 1) { await p.evaluate((s) => { const e = document.getElementById('seed'); e.value = s; e.dispatchEvent(new Event('change')); }, SEED); }
  await PW.waitBuilt(p, 1500000);
  console.log('built s', (Date.now() - t0) / 1000);
  await p.evaluate(() => document.getElementById('collapse').click());
  for (const v of VIEWS) {
    if (v.length === 3) await p.evaluate(([x, z]) => window.cityLab.focus(x, z, 'rts'), [v[1], v[2]]);
    else await p.evaluate((a) => window.cityLab.cam(...a), v.slice(1));
    await p.waitForTimeout(5000);
    fs.writeFileSync(`${OUT}/rts_${v[0]}.png`, await p.screenshot({ timeout: 300000 }));
    console.log('shot', v[0]);
  }
  if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  await b.close();
})();
