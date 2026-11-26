// usage: node dev/cam.js '<json>' [test] [night]; screenshots to $OUT (default /tmp/city_shots). Needs: cd tools/city_lab && python3 -m http.server 8765
require('fs').mkdirSync(process.env.OUT || '/tmp/city_shots', { recursive: true });
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
  await p.goto('http://localhost:8765/city_lab.html?legacy=1');
  await p.waitForFunction(() => document.getElementById('progress').hidden && document.querySelector('#stats dd'), null, { timeout: 300000 });
  await p.click('#collapse', { noWaitAfter: true });
  const shots = JSON.parse(process.argv[2]);
  for (const [name, tx, ty, tz, px, py, pz] of shots) {
    await p.evaluate(([tx, ty, tz, px, py, pz]) => { const s = window.cityLab; s.focus(tx, tz, 'rts'); }, [tx, ty, tz, px, py, pz]);
    await p.waitForTimeout(2000);
    await p.evaluate(([tx, ty, tz, px, py, pz]) => { window.cityLab.cam(tx, ty, tz, px, py, pz); }, [tx, ty, tz, px, py, pz]);
    await p.waitForTimeout(6000);
    await p.screenshot({ path: (process.env.OUT || '/tmp/city_shots') + `/cam_${name}.png`, timeout: 180000 });
  }
  await b.close();
})();
