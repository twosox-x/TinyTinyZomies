// usage: node shot.js "<view.html url>" out.png  (headless screenshot of bake/view.html; Playwright + SwiftShader)
const { chromium } = require('playwright');
(async () => {
  const [url, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url);
  try { await p.waitForFunction(() => window.__ready, null, { timeout: 180000 }); } catch (e) { errs.push('not ready'); }
  await p.waitForTimeout(1500); await p.screenshot({ path: out });
  console.log(await p.evaluate(() => document.getElementById('info').textContent)); if (errs.length) console.log(errs.join('\n'));
  await b.close();
})();
