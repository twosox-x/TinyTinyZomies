#!/usr/bin/env node
/*
 * Review screenshots of the Military Lab (headless Chromium, page served from disk by route interception).
 *   NODE_PATH=$(npm root -g) node tools/military_lab/shots.mjs <outDir> [only-substring]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch (e) { pw = require("/opt/node-tools/node_modules/playwright"); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || "mil_shots");
const ONLY = process.argv[3] || "";
fs.mkdirSync(OUT, { recursive: true });

const SHOTS = [
  // [file, state, w, h]
  ["lineup_persp", { mode: "lineup", view: "persp", pose: "carry" }, 1800, 700],
  ["lineup_front", { mode: "lineup", view: "front", pose: "carry" }, 1800, 600],
  ["lineup_side", { mode: "lineup", view: "side", pose: "carry" }, 1800, 600],
  ["lineup_rear", { mode: "lineup", view: "rear", pose: "carry" }, 1800, 600],
  ["lineup_rest_front", { mode: "lineup", view: "front", pose: "rest" }, 1800, 600],
  ...["rifleman_a", "mg_a", "sniper_a"].flatMap(a => ["persp", "front", "side", "rear", "top"].map(v => [`${a}_${v}`, { mode: "single", asset: a, view: v, pose: "carry", zombie: true }, 900, 900])),
  ["rifleman_a_points", { mode: "single", asset: "rifleman_a", view: "side", pose: "carry", zombie: false, points: true }, 900, 900],
  ["rts_60m_p35", { mode: "rts", rtsDist: 60, rtsPitch: 35 }, 1280, 720],
  ["rts_100m_p50", { mode: "rts", rtsDist: 100, rtsPitch: 50 }, 1280, 720],
  ["rts_150m_p70", { mode: "rts", rtsDist: 150, rtsPitch: 70 }, 1280, 720],
  ["rts_100m_p50_night", { mode: "rts", rtsDist: 100, rtsPitch: 50, light: "night" }, 1280, 720],
  ["props_sheet", { mode: "props", view: "persp", light: "neutral" }, 2000, 1300],
  ["props_sheet_top", { mode: "props", view: "top", light: "neutral" }, 2000, 1300],
  ...["para_infantry", "para_cargo", "crate_ammo_drop", "container_supply", "wall_cheap_straight", "wall_reinforced_straight", "wall_reinforced_gate", "wall_cheap_t",
      "fort_window_nest", "fort_roof_ring", "barricade_window_planks", "barricade_door_sandbags", "garrison_flag", "garrison_antenna", "hospital_awning", "hospital_cot"].map(a => [`prop_${a}`, { mode: "single", asset: a, view: "persp", zombie: true, open: a === "container_supply" }, 900, 700]),
  ["night_rifleman", { mode: "single", asset: "rifleman_b", view: "persp", light: "night" }, 900, 900],
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
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto("http://milab.local/military_lab_v1.html");
await page.waitForFunction(() => window.__mil && window.__mil.ready, null, { timeout: 180000 });
await page.addStyleTag({ content: ".panel,.hint{display:none!important}" });
for (const [name, st, w, h] of SHOTS) {
  if (ONLY && !name.includes(ONLY)) continue;
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(s => { const d = { mode: "single", view: "persp", pose: "carry", light: "neutral", zombie: true, points: false, open: false, rtsDist: 100, rtsPitch: 50 }; window.__mil.set(Object.assign(d, s)); window.dispatchEvent(new Event("resize")); window.__mil.set({}); }, st);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("wrote", name);
}
await browser.close();
