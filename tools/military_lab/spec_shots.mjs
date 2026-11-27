#!/usr/bin/env node
/*
 * Phase 7b review shots (engineers, flamethrowers): model lineups / class sheets / RTS crops and animation frame strips.
 *   NODE_PATH=$(npm root -g) node tools/military_lab/spec_shots.mjs <outDir> [only-substring]
 * Model shots -> <outDir>/*.png; animation frames -> <outDir>/frames/ (+ index.json) for anim_sheets.py.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch (e) { pw = require("/opt/node-tools/node_modules/playwright"); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || "spec_shots");
const ONLY = process.argv[3] || "";
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

const MODEL = [   // [file, state, w, h]
  ["lineup7b_persp", { mode: "speclineup", view: "persp" }, 1900, 760], ["lineup7b_front", { mode: "speclineup", view: "front" }, 1900, 640],
  ["lineup7b_side", { mode: "speclineup", view: "side" }, 1900, 640], ["lineup7b_rear", { mode: "speclineup", view: "rear" }, 1900, 640],
  ["lineup7b_top", { mode: "speclineup", view: "top", tools: true }, 1900, 900],
  ...["engineer_a", "engineer_b", "engineer_c", "flamer_a", "flamer_b"].flatMap(a => ["persp", "front", "side", "rear"].map(v => [`${a}_${v}`, { mode: "single", asset: a, view: v }, 900, 900])),
  ["flamer_a_points", { mode: "single", asset: "flamer_a", view: "side", zombie: false, points: true }, 900, 900],
  ["engineer_a_points", { mode: "single", asset: "engineer_a", view: "side", zombie: false, points: true }, 900, 900],
  ...["tool_sledgehammer", "tool_shovel", "tool_torch", "tool_crowbar", "tool_sandbag", "tool_panel", "sandbag_pile"].map(a => [`${a}`, { mode: "single", asset: a, view: "persp", zombie: false }, 700, 560]),
  ["rts_models_45m", { mode: "rts", rtsDist: 45, rtsPitch: 50, spec: true }, 1280, 720], ["rts_models_110m", { mode: "rts", rtsDist: 110, rtsPitch: 50, spec: true }, 1280, 720],
  ["rts_models_110m_night", { mode: "rts", rtsDist: 110, rtsPitch: 50, spec: true, light: "night" }, 1280, 720],
];
const JOBS = [];   // [name, labState, animState, times, w, h]
const strip = (name, cls, act, n, view, dur, loop, light, w, h) => JOBS.push([name, { mode: "anim", view, light: light || "neutral" }, { scene: "classes", cls, action: act, travel: false, fx: true },
  Array.from({ length: n }, (_, i) => +(loop ? i * dur / n : i * dur / (n - 1)).toFixed(3)), w || 1100, h || 560]);
// standard set (engineer + flamer side by side)
for (const [act, n, view, d, loop] of [["idle", 4, "persp", 3, 1], ["walk", 8, "side", 0.92, 1], ["run", 8, "side", 0.72, 1], ["aim", 2, "front", 2, 1], ["fire", 8, "persp", 2.4, 1], ["reload", 10, "persp", 2.6, 0],
  ["crouch_fire", 6, "persp", 2.4, 1], ["hit", 6, "persp", 0.6, 0], ["death_a", 8, "persp", 1.2, 0], ["death_b", 8, "persp", 1.4, 0], ["death_c", 6, "persp", 1.2, 0], ["collect_ammo", 8, "side", 3.2, 0],
  ["turn_l", 6, "persp", 0.8, 0], ["stairs_up", 6, "side", 1, 1], ["para_descent", 4, "front", 4.8, 1], ["para_land", 8, "persp", 1.5, 0], ["para_recover", 10, "persp", 3.2, 0], ["enter_building", 6, "side", 2.4, 0]])
  strip(`new_${act}_${view}`, "new", act, n, view, d, loop);
// engineer work (three variants side by side, each with its context)
for (const [act, n, view, d] of [["build_hammer", 8, "side", 1.5], ["build_hammer", 6, "persp", 1.5], ["build_shovel", 10, "side", 2.2], ["build_shovel", 6, "persp", 2.2], ["build_sandbag", 10, "persp", 2.8], ["build_sandbag", 8, "side", 2.8],
  ["carry_sandbag", 6, "side", 0.96], ["carry_panel", 6, "persp", 0.96], ["carry_panel", 6, "front", 0.96], ["cut_car", 6, "persp", 2.4], ["cut_car", 6, "side", 2.4], ["pry_car", 8, "side", 2.0], ["pry_car", 6, "persp", 2.0]])
  strip(`eng_${act}_${view}`, "engineer", act, n, view, d, true);
for (const [act, n, view, d] of [["stow_weapon", 8, "persp", 1.1], ["draw_weapon", 8, "persp", 1.0], ["death_tool_sledgehammer", 8, "persp", 1.2], ["death_tool_shovel", 6, "persp", 1.2], ["death_tool_torch", 6, "persp", 1.2],
  ["death_tool_crowbar", 6, "persp", 1.2], ["death_tool_sandbag", 6, "persp", 1.2], ["death_tool_panel", 6, "persp", 1.2]])
  strip(`eng_${act}_${view}`, "engineer", act, n, view, d, false);
// flamethrower
for (const [act, n, view, d, loop, light] of [["ignite", 6, "side", 0.5, 0], ["fire", 8, "side", 2.4, 1], ["fire", 8, "persp", 2.4, 1], ["fire", 6, "persp", 2.4, 1, "night"], ["stop", 5, "side", 0.45, 0],
  ["burn_ground", 8, "persp", 3.2, 1], ["burn_ground", 6, "side", 3.2, 1, "night"], ["reload", 10, "persp", 2.6, 0], ["crouch_fire", 6, "persp", 2.4, 1]])
  strip(`flame_${act}_${view}${light ? "_" + light : ""}`, "flamer", act, n, view, d, loop, light, 1300, 620);
for (const d of [45, 110]) for (const L of ["neutral", "night"]) JOBS.push([`rts7b_${d}m_${L}`, { mode: "anim", light: L }, { scene: "specrts", rtsDist: d, rtsPitch: 50, fx: true }, [0.0, 0.5, 1.0, 1.6], 1600, 900]);

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
await page.waitForFunction(() => window.__mil && window.__mil.ready, null, { timeout: 300000 });
await page.addStyleTag({ content: ".panel,.hint{display:none!important}" });
for (const [name, st, w, h] of MODEL) {
  if (ONLY && !name.includes(ONLY)) continue;
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(s => { const d = { mode: "single", view: "persp", pose: "carry", light: "neutral", zombie: true, points: false, open: false, rtsDist: 100, rtsPitch: 50, spec: false, tools: true }; window.__mil.set(Object.assign(d, s)); window.dispatchEvent(new Event("resize")); window.__mil.set({}); }, st);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("wrote", name);
}
const index = [];
for (const [name, st, an, times, w, h] of JOBS) {
  if (ONLY && !name.includes(ONLY)) continue;
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(([s, a]) => { window.__mil.anim.t = 0; Object.assign(window.__mil.anim, a); window.__mil.set(Object.assign({ mode: "anim", view: "persp", light: "neutral" }, s)); window.dispatchEvent(new Event("resize")); window.__mil.set({}); }, [st, an]);
  const files = [];
  for (const [i, t] of times.entries()) {
    await page.evaluate(t => window.__mil.animAt(t), t);
    await page.waitForTimeout(30);
    const f = `${name}_${String(i).padStart(2, "0")}.png`; await page.screenshot({ path: path.join(OUT, "frames", f) }); files.push(f);
  }
  index.push({ name, times, files });
  console.log("wrote", name, files.length);
}
fs.writeFileSync(path.join(OUT, "frames", "index.json"), JSON.stringify(index, null, 1));
await browser.close();
