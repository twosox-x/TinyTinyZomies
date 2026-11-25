// usage: node preview.js <tower> <out.png> [query extras like "w=40&d=44&floors=30&seed=7&yaw=0.6&pitch=0.25&dist=120&night=1"]
const { chromium } = require('playwright');
(async () => {
  const [name, out, extra] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  await p.goto(`http://localhost:8765/city_lab.html?tower=${name}&${extra || ''}`);
  try { await p.waitForFunction(() => window.__previewReady, null, { timeout: 120000 }); } catch (e) { errs.push('not ready'); }
  await p.waitForTimeout(2500);
  await p.screenshot({ path: out });
  console.log(await p.title()); if (errs.length) console.log(errs.join('\n'));
  await b.close();
})();
