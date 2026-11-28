#!/usr/bin/env node
/*
 * Phase 7b structure review shots (defense towers, generator, floodlight, fuel), GAME_DESIGN 14e. PENDING REVIEW.
 *   NODE_PATH=$(npm root -g) node tools/military_lab/struct_shots.mjs <outDir> [only-substring]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch (e) { pw = require("/opt/node-tools/node_modules/playwright"); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || "struct_shots");
const ONLY = process.argv[3] || "";
fs.mkdirSync(OUT, { recursive: true });
const NAMES = ["tower_wood", "tower_steel", "generator", "floodlight", "fuel_store", "fuel_drum", "jerrycan"];
const SHOTS = [   // [file, state, w, h]
  ["sheet_persp", { mode: "structures", view: "persp" }, 1900, 820], ["sheet_front", { mode: "structures", view: "front" }, 1900, 700],
  ["sheet_side", { mode: "structures", view: "side" }, 1900, 700], ["sheet_rear", { mode: "structures", view: "rear" }, 1900, 700],
  ["sheet_night_lit", { mode: "structures", view: "persp", light: "night", lit: true }, 1900, 820],
  ["sheet_night_unlit", { mode: "structures", view: "persp", light: "night", lit: false }, 1900, 820],
  ["rts_45m", { mode: "structures", view: "rts", rtsDist: 45 }, 1280, 720], ["rts_110m", { mode: "structures", view: "rts", rtsDist: 110 }, 1280, 720],
  ["rts_45m_night", { mode: "structures", view: "rts", rtsDist: 45, light: "night", lit: true }, 1280, 720],
  ...NAMES.flatMap(a => ["persp", "front", "side", "top"].map(v => [`${a}_${v}`, { mode: "single", asset: a, view: v, zombie: a.startsWith("tower") }, 900, 900])),
  ["floodlight_points", { mode: "single", asset: "floodlight", view: "side", zombie: false, points: true }, 900, 900],
  ["tower_wood_points", { mode: "single", asset: "tower_wood", view: "side", zombie: false, points: true }, 900, 900],
];
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
for (const [name, st, w, h] of SHOTS) {
  if (ONLY && !name.includes(ONLY)) continue;
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(s => { const d = { mode: "single", view: "persp", pose: "carry", light: "neutral", zombie: false, points: false, open: false, rtsDist: 60, lit: true }; window.__mil.set(Object.assign(d, s)); window.dispatchEvent(new Event("resize")); window.__mil.set({}); }, st);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("wrote", name);
}
await browser.close();
