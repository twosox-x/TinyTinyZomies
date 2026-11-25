#!/usr/bin/env node
/*
 * Renders reference images from the approved Zombie Lab HTML (headless Chromium via Playwright) with
 * camera parameters that tools/compare_views.sh also passes to the native engine, so both renderers
 * can be compared side by side. A copy of the page is instrumented in memory (the approved source
 * file is not modified): deterministic animation phase, fixed per-character seeds matching the
 * engine's baked decoration seed for the same appearance, and a hook exposing the camera.
 *
 *   NODE_PATH=$(npm root -g) node tools/capture_lab.mjs <outDir>
 * Each view: { design | "lineup", yaw, pitch, distVoxels, targetY, anim }.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs/media/phase3/lab"));
fs.mkdirSync(OUT, { recursive: true });
export const VIEWS = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/compare_views.json"), "utf8"));

// ---- engine-equivalent decoration seed per design (see char_common.glsl lookSeedVar)
const pcg = v => { const st = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0; const w = Math.imul(((st >>> ((st >>> 28) + 4)) ^ st) >>> 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
const encode = l => {
  const x = ((l.head << 8) | (l.torso << 11) | (l.uaL << 14) | (l.uaR << 17) | (l.faL << 20) | (l.faR << 23) | (l.thL << 26) | (l.thR << 29)) >>> 0;
  const y = (l.shL | (l.shR << 3) | (l.tier << 6) | (l.decay << 8) | (l.skin << 10) | (l.top << 13) | (l.shirt << 17) | (l.pants << 19) |
             (l.hair << 22) | (l.tie << 25) | (l.hat << 27) | (l.shoe << 30)) >>> 0;
  return [x, y];
};
const LOOKS = {   // mirrors src/sim/Look.h
  drone: { head: 1, torso: 1, uaL: 0, uaR: 0, faL: 0, faR: 0, thL: 0, thR: 0, shL: 0, shR: 0, tier: 0, decay: 0, skin: 4, top: 3, shirt: 0, pants: 1, hair: 0, tie: 0, hat: 1, shoe: 2 },
  walker: { head: 3, torso: 2, uaL: 2, uaR: 0, faL: 2, faR: 3, thL: 0, thR: 2, shL: 0, shR: 3, tier: 1, decay: 1, skin: 1, top: 0, shirt: 1, pants: 0, hair: 1, tie: 1, hat: 0, shoe: 0 },
  rotter: { head: 6, torso: 5, uaL: 3, uaR: 4, faL: 4, faR: 5, thL: 3, thR: 4, shL: 4, shR: 5, tier: 2, decay: 3, skin: 3, top: 2, shirt: 3, pants: 3, hair: 5, tie: 2, hat: 3, shoe: 1 },
};
const SEEDS = [101, 202, 303, 404];
const seedFor = {};
for (const [k, l] of Object.entries(LOOKS)) { const [x, y] = encode(l); seedFor[k] = SEEDS[pcg(((x >>> 8) ^ Math.imul(y, 2246822519)) >>> 0) & 3]; }

// ---- instrument an in-memory copy of the approved page
let html = fs.readFileSync(path.join(ROOT, "assets/characters/source/zombie_lab_v3.html"), "utf8");
const inject = (a, b) => { if (!html.includes(a)) throw new Error("hook point missing: " + a); html = html.replace(a, b); };
inject("seed: newSeed(), detail: d.detail", "seed: (window.__seedFor && window.__seedFor[id]) || newSeed(), detail: d.detail");
inject("this.phase = Math.random() * 20;", "this.phase = 0;");
inject("frame();\n})();", `window.__lab = { camera, controls, setView: v => setView(v, true), state, designSpec, Zombie, setHero(id) { const z = new Zombie(designSpec(id)); scene.remove(hero.root); hero = z; setView("inspect", true); }, clock };
frame();
})();`);
const tmp = path.join(OUT, "_lab_instrumented.html");
fs.writeFileSync(tmp, `<script>window.__seedFor = ${JSON.stringify(seedFor)};</script>` + html);

const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
                                        args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: VIEWS.width, height: VIEWS.height }, ignoreHTTPSErrors: true });
await page.goto("file://" + tmp);
await page.waitForFunction(() => window.__lab, null, { timeout: 30000 });
await page.addStyleTag({ content: ".panel, .hint, #tags { display: none !important; }" });
for (const v of VIEWS.views) {
  await page.evaluate(v => {
    const L = window.__lab;
    if (v.design === "lineup") L.setView("lineup"); else L.setHero(v.design);
    L.state.anim = v.anim; L.state.explode = 0;
    const tY = v.targetY, d = v.distVoxels;
    L.controls.target.set(0, tY, 0);
    L.camera.position.set(Math.sin(v.yaw) * Math.cos(v.pitch) * d, tY + Math.sin(v.pitch) * d, Math.cos(v.yaw) * Math.cos(v.pitch) * d);
    L.camera.fov = 32; L.camera.updateProjectionMatrix(); L.controls.update();
  }, v);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, v.name + ".png") });
  console.log("lab", v.name);
}
await browser.close();
fs.unlinkSync(tmp);
