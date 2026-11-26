#!/usr/bin/env node
/*
 * Animation review sheets of the Military Lab (headless Chromium): key-frame strips per class / action, parachute and
 * crate sequences, RTS-distance crowd frames. Frames are posed deterministically with __mil.animAt(t).
 *   NODE_PATH=$(npm root -g) node tools/military_lab/anim_shots.mjs <outDir> [only-substring]
 * Writes <outDir>/frames/*.png; tools/military_lab/anim_sheets.py assembles them into sheets / GIFs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch (e) { pw = require("/opt/node-tools/node_modules/playwright"); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || "anim_shots");
const ONLY = process.argv[3] || "";
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

const JOBS = [];   // [name, labState, animState, view, times[], w, h]
const strip = (act, times, view) => JOBS.push([`cls_${act}_${view}`, { mode: "anim", view, light: "neutral" }, { scene: "classes", cls: "all", action: act, travel: false, fx: true }, times, 1100, 560]);
for (const [act, n, view] of [["walk", 8, "side"], ["run", 8, "side"], ["fire", 8, "persp"], ["reload", 10, "persp"], ["death_a", 8, "persp"], ["death_b", 8, "persp"], ["death_c", 6, "persp"],
  ["idle", 4, "persp"], ["aim", 2, "front"], ["crouch_fire", 6, "persp"], ["hit", 6, "persp"], ["turn_l", 6, "persp"], ["collect_ammo", 10, "side"], ["enter_building", 8, "side"], ["exit_building", 8, "side"],
  ["stairs_up", 6, "side"], ["stairs_down", 6, "side"], ["para_descent", 4, "front"], ["para_land", 8, "persp"], ["para_recover", 10, "persp"], ["walk", 6, "front"], ["fire", 6, "side"]]) {
  const durs = { walk: 0.92, run: 0.64, fire: 1.9, reload: 4.2, death_a: 1.6, death_b: 1.8, death_c: 1.5, idle: 3, aim: 2, crouch_fire: 1.9, hit: 0.6, turn_l: 0.8, collect_ammo: 3.2, enter_building: 2.4, exit_building: 2.4, stairs_up: 1, stairs_down: 1, para_descent: 4.8, para_land: 1.5, para_recover: 3.2 };
  const D = durs[act], loop = ["walk", "run", "idle", "aim", "stairs_up", "stairs_down", "para_descent"].includes(act);
  strip(act, Array.from({ length: n }, (_, i) => +(loop ? i * D / n : i * D / (n - 1)).toFixed(3)), view);
}
// fire close-ups catch the shot frame (FX) per class: sample right after the shots
JOBS.push(["fire_fx", { mode: "anim", view: "side", light: "night" }, { scene: "classes", cls: "all", action: "fire", travel: false, fx: true }, [0.0, 0.034, 0.1, 0.2, 0.5, 0.9, 1.0], 1100, 560]);
// foot-slide check: travelling walk / run with stride markers
JOBS.push(["travel_walk", { mode: "anim", view: "side", light: "neutral" }, { scene: "classes", cls: "rifleman", action: "walk", travel: true, fx: false, playing: true }, "play:3.0:8", 1100, 560]);
JOBS.push(["travel_run", { mode: "anim", view: "side", light: "neutral" }, { scene: "classes", cls: "rifleman", action: "run", travel: true, fx: false, playing: true }, "play:2.0:8", 1100, 560]);
// parachute + crate demos (timeline seconds)
JOBS.push(["para_demo", { mode: "anim", view: "persp", light: "neutral" }, { scene: "para", travel: false }, [0.5, 3, 5.5, 6.05, 6.4, 7.0, 7.6, 8.05, 8.5, 9.0, 9.6, 10.5, 11.5, 12.5, 13.5, 15.5], 1280, 720]);
JOBS.push(["crate_demo", { mode: "anim", view: "persp", light: "neutral" }, { scene: "crate", travel: false }, [5.0, 6.4, 6.72, 6.85, 7.1, 7.6, 8.2, 8.8, 9.5, 10.5], 1000, 640]);
// RTS distances (night + neutral)
for (const d of [45, 110, 300]) for (const L of ["night", "neutral"]) JOBS.push([`rts_${d}m_${L}`, { mode: "anim", light: L }, { scene: "rts", rtsDist: d, rtsPitch: 50, fx: true }, [0.0, 0.45, 1.2], 1600, 900]);

const browser = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
await ctx.route("http://milab.local/**", route => {
  const f = path.join(HERE, decodeURIComponent(new URL(route.request().url()).pathname));
  if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: "" });
  route.fulfill({ status: 200, contentType: "text/html", body: fs.readFileSync(f) });
});
const page = await ctx.newPage();
page.on("pageerror", e => console.error("pageerror:", e.message));
page.on("console", m => { if (m.type() === "error") console.error("console:", m.text()); });
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto("http://milab.local/military_lab_v1.html");
await page.waitForFunction(() => window.__mil && window.__mil.ready, null, { timeout: 240000 });
await page.addStyleTag({ content: ".panel,.hint{display:none!important}" });
const index = [];
for (const [name, st, an, times, w, h] of JOBS) {
  if (ONLY && !name.includes(ONLY)) continue;
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(([s, a]) => { window.__mil.anim.t = 0; Object.assign(window.__mil.anim, a); window.__mil.set(Object.assign({ mode: "anim", view: "persp", light: "neutral" }, s)); window.dispatchEvent(new Event("resize")); window.__mil.set({}); }, [st, an]);
  const files = [];
  if (typeof times === "string") {   // "play:<seconds>:<frames>": real-time-like stepping at fixed dt (blends, travel, markers)
    const [, secs, nf] = times.split(":"); const steps = Math.round(+secs * 30);
    for (let i = 0; i <= steps; i++) {
      await page.evaluate(() => { const m = window.__mil; m.anim.playing = true; m.step(1 / 30); });
      if (i % Math.floor(steps / (+nf - 1)) === 0) { const f = `${name}_${String(files.length).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(OUT, "frames", f) }); files.push(f); }
    }
  } else {
    for (const [i, t] of times.entries()) {
      await page.evaluate(t => window.__mil.animAt(t), t);
      await page.waitForTimeout(30);
      const f = `${name}_${String(i).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(OUT, "frames", f) }); files.push(f);
    }
  }
  index.push({ name, times, files });
  console.log("wrote", name, files.length);
}
fs.writeFileSync(path.join(OUT, "frames", "index.json"), JSON.stringify(index, null, 1));
await browser.close();
