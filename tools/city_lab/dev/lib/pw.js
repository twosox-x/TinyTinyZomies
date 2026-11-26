// Shared Playwright helpers for the page-driven dev tools (shots, perf, vehicles_sheet, ...).
// The page and its workers are served from disk by route interception (no http server needed).
//   const { chromium, launch, serve, freezeClock, waitBuilt } = require('./lib/pw.js');
const fs = require('fs'), path = require('path');
const ROOT_DEFAULT = path.resolve(__dirname, '..', '..');           // tools/city_lab
const HOST = 'http://citylab.local';

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  for (const p of [process.env.PLAYWRIGHT_PATH, '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
    try { return require(p); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found: set NODE_PATH or PLAYWRIGHT_PATH');
}
const { chromium } = loadPlaywright();
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const launch = () => chromium.launch({ args: GL_ARGS });
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

// Serve ROOT (default tools/city_lab) at http://citylab.local/ for every page of the context.
async function serve(ctx, root) {
  root = path.resolve(root || ROOT_DEFAULT);
  await ctx.route(HOST + '/**', (route) => {
    const u = new URL(route.request().url()), f = path.join(root, decodeURIComponent(u.pathname));
    if (!f.startsWith(root) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  return root;
}
// Every frame sees t = 1 s: animations (beacons, water, traffic) are frozen so screenshots are reproducible.
const freezeClock = (page) => page.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf(() => cb(1000)); });
// Wait until the page has finished building the city (progress bar hidden, stats filled).
const waitBuilt = (page, timeout) => page.waitForFunction(() => document.getElementById('progress').hidden && document.querySelector('#stats dd'), null, { timeout: timeout || 600000 });

module.exports = { chromium, launch, serve, freezeClock, waitBuilt, HOST, GL_ARGS, ROOT: ROOT_DEFAULT };
