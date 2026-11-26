// usage: node dev/spots.js '<json>' [test] [night]; screenshots to $OUT (default /tmp/city_shots). Needs: cd tools/city_lab && python3 -m http.server 8765
require('fs').mkdirSync(process.env.OUT || '/tmp/city_shots', { recursive: true });
const { chromium } = require('playwright');
const spots = JSON.parse(process.argv[2]);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
  const logs = []; p.on('pageerror', e => logs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
  await p.goto('http://localhost:8765/city_lab.html?legacy=1');
  await p.waitForFunction(() => document.getElementById('progress').hidden && document.querySelector('#stats dd'), null, { timeout: 300000 });
  await p.click('#collapse', { noWaitAfter: true });
  if (process.argv[3] === 'test') { await p.evaluate(() => document.getElementById('sceneTest').click()); await p.waitForTimeout(1500); await p.waitForFunction(() => document.getElementById('progress').hidden, null, { timeout: 300000 }); }
  if (process.argv[4] === 'night') await p.evaluate(() => document.getElementById('lNight').click());
  for (const [name, x, z, view, yawDeg] of spots) {
    await p.evaluate(([x, z, view]) => window.cityLab.focus(x, z, view), [x, z, view]);
    await p.waitForTimeout(4000);
    await p.screenshot({ path: (process.env.OUT || '/tmp/city_shots') + `/spot_${name}.png` });
  }
  console.log(logs.join('\n'));
  await b.close();
})();
