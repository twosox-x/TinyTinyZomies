// Fixed-camera screenshot comparison (final visual check for the building geometry; seed 1, day).
//   node tools/city_lab/dev/shots.js            render, compare with dev/baseline_shots/*.png, write diffs to $OUT
//   node tools/city_lab/dev/shots.js --update   rewrite the baseline images
//   options: --root=DIR (serve the city lab from DIR, default this checkout), --props (keep street furniture on;
//            off by default so only buildings / streets are compared), --out=DIR (default /tmp/city_shots)
// No http server needed: the page and its workers are served from disk by Playwright route interception (three.js
// still comes from its CDN). Animation time is frozen (blinking beacons, signals) so frames are repeatable.
// A view fails when more than MAX_FRAC of its pixels differ by more than TOL in any channel; a diff image (changed
// pixels in red over a dimmed render) is written next to each render.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const ROOT = path.resolve(opt('root', __dirname + '/..')), OUT = opt('out', process.env.OUT || '/tmp/city_shots');
const UPDATE = args.includes('--update'), PROPS = args.includes('--props');
const BASE = __dirname + '/baseline_shots';
const TOL = 24, MAX_FRAC = 0.004;
// [name, target x, y, z, eye x, y, z] (metres, seed 1)
const VIEWS = [
  ['towers', -91, 30, -21, 40, 140, 140],            // the tower core from above
  ['block', -230, 12, 120, -205, 52, 150],            // downtown block corners and party walls, close up
  ['roofs', 150, 10, -90, 205, 80, -25],              // old-town rooftops: parapets, roof kit, flush neighbours
];
const W = 960, H = 640;

// ---- minimal PNG codec (8-bit RGB / RGBA, non-interlaced)
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12]) throw new Error('png format'); }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4), st = w * bpp;
  let prev = Buffer.alloc(st);
  for (let y = 0; y < h; ++y) {
    const f = raw[y * (st + 1)], line = Buffer.from(raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)));
    for (let x = 0; x < st; ++x) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; ++x) for (let k = 0; k < 4; ++k) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, rgba: out };
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; ++y) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t, 'ascii'), d])) >>> 0, 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return c ^ -1; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true }); if (UPDATE) fs.mkdirSync(BASE, { recursive: true });
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H } });
  await ctx.route('http://citylab.local/**', (route) => {
    const u = new URL(route.request().url()), f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    const ext = path.extname(f), type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
    route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(f) });
  });
  const p = await ctx.newPage();
  const logs = []; p.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  // frozen animation clock: every frame sees t = 1 s
  await p.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf(() => cb(1000)); });
  await p.goto('http://citylab.local/city_lab.html');
  await p.waitForFunction(() => document.getElementById('progress').hidden && document.querySelector('#stats dd'), null, { timeout: 600000 });
  await p.evaluate(() => document.getElementById('collapse').click());
  await p.evaluate((props) => { for (const id of props ? ['lyLabels'] : ['lyProps', 'lyLabels']) { const c = document.getElementById(id); if (c && c.checked) c.click(); } }, PROPS);
  let fails = 0;
  for (const [name, tx, ty, tz, px, py, pz] of VIEWS) {
    await p.evaluate((v) => window.cityLab.cam(...v), [tx, ty, tz, px, py, pz]);
    await p.waitForTimeout(3000);
    const png = await p.screenshot({ timeout: 180000 });
    fs.writeFileSync(`${OUT}/shot_${name}.png`, png);
    if (UPDATE) { fs.writeFileSync(`${BASE}/${name}.png`, png); console.log('baseline', name); continue; }
    if (!fs.existsSync(`${BASE}/${name}.png`)) { console.log(name, 'no baseline'); fails++; continue; }
    const A = decodePNG(fs.readFileSync(`${BASE}/${name}.png`)), B = decodePNG(png);
    if (A.w !== B.w || A.h !== B.h) { console.log(name, 'size differs'); fails++; continue; }
    const D = Buffer.alloc(A.w * A.h * 4); let n = 0;
    for (let i = 0; i < A.w * A.h; ++i) {
      const o = i * 4, bad = Math.max(Math.abs(A.rgba[o] - B.rgba[o]), Math.abs(A.rgba[o + 1] - B.rgba[o + 1]), Math.abs(A.rgba[o + 2] - B.rgba[o + 2])) > TOL;
      if (bad) { n++; D[o] = 255; D[o + 1] = 0; D[o + 2] = 0; } else for (let k = 0; k < 3; ++k) D[o + k] = B.rgba[o + k] * 0.35;
      D[o + 3] = 255;
    }
    fs.writeFileSync(`${OUT}/diff_${name}.png`, encodePNG(A.w, A.h, D));
    const frac = n / (A.w * A.h), ok = frac <= MAX_FRAC;
    if (!ok) fails++;
    console.log(`${name}: ${(frac * 100).toFixed(3)}% pixels differ (limit ${(MAX_FRAC * 100).toFixed(1)}%) ${ok ? 'ok' : 'FAIL'}`);
  }
  if (logs.length) console.log(logs.join('\n'));
  await b.close();
  if (!UPDATE) { console.log(fails ? `VISUAL DIFF: ${fails} view(s) failed, see ${OUT}` : 'PASS'); process.exitCode = fails ? 1 : 0; }
})();
