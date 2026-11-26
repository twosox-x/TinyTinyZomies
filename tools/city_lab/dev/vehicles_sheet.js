// usage: node dev/vehicles_sheet.js <out.png> "<query>" [w] [h]
//   query e.g. "vehicles=sedan,suv&states=ok,damaged,crashed,burnt,rolled,open&seeds=1&yaw=2.4&pitch=0.5&dist=40"
// Renders the vehicle sheet preview mode of city_lab.html (rows = kinds, columns = states x seeds); no http server
// needed (route interception from disk, like dev/shots.js).
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname + '/..');
(async () => {
  const [out, q, w, h] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: +(w || 1400), height: +(h || 1000) } });
  await ctx.route('http://citylab.local/**', (route) => {
    const u = new URL(route.request().url()), f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    const ext = path.extname(f), type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(f) });
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  await p.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf(() => cb(1000)); });
  await p.goto('http://citylab.local/city_lab.html?' + (q || 'vehicles=all'));
  try { await p.waitForFunction(() => window.__previewReady, null, { timeout: 120000 }); } catch (e) { errs.push('not ready'); }
  await p.waitForTimeout(2500);
  await p.screenshot({ path: out });
  console.log(await p.title()); if (errs.length) console.log(errs.join('\n'));
  await b.close();
})();
