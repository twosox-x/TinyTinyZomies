// Page timings and frame stats (seed 1): build time split, then for a few camera views the frame rate, draw calls
// and triangles drawn as the page's stats panel reports them. Software GL (SwiftShader) here, so absolute fps is
// low; compare runs on the same machine.  node tools/city_lab/dev/perf.js [--root=DIR]
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const a = process.argv.find(x => x.startsWith('--root='));
const ROOT = path.resolve(a ? a.slice(7) : __dirname + '/..');
const VIEWS = [['towers', -91, 30, -21, 40, 140, 140], ['block', -230, 12, 120, -205, 52, 150], ['roofs', 150, 10, -90, 205, 80, -25], ['overview', 0, 0, 0, 260, 420, 420]];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 960, height: 640 } });
  await ctx.route('http://citylab.local/**', (route) => {
    const u = new URL(route.request().url()), f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: f.endsWith('.html') ? 'text/html' : 'application/javascript', body: fs.readFileSync(f) });
  });
  const p = await ctx.newPage();
  const t0 = Date.now();
  await p.goto('http://citylab.local/city_lab.html');
  await p.waitForFunction(() => document.getElementById('progress').hidden && document.querySelector('#stats dd'), null, { timeout: 600000 });
  const stat = () => p.evaluate(() => { const o = {}; const dt = [...document.querySelectorAll('#stats dt')]; dt.forEach(d => { o[d.textContent] = d.nextElementSibling.textContent; }); return o; });
  await p.waitForTimeout(1500);
  const s0 = await stat();
  console.log(`load ${((Date.now() - t0) / 1000).toFixed(1)} s | build ${s0['Build time']} | fields ${s0['· distance fields']} | roads CPU ${s0['· voxels + meshing (CPU)']} | buildings ${s0['· plots, buildings, props']} | building tris ${s0['Building triangles']} | memory ${s0['Geometry memory']}`);
  for (const [name, ...v] of VIEWS) {
    await p.evaluate((v) => window.cityLab.cam(...v), v);
    await p.waitForTimeout(6000);
    const s = await stat();
    console.log(`${name}: ${s['Frame rate']}, ${s['Draw calls / frame']} draw calls, ${s['Triangles drawn']} triangles drawn`);
  }
  await b.close();
})();
