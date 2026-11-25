#!/usr/bin/env python3
"""Render the views in tools/compare_views.json with the native engine and compose side-by-side sheets
against the Zombie Lab captures (tools/capture_lab.mjs).

  python3 tools/compare_views.py <ttz executable> <lab capture dir> <output dir>

Engine settings for comparison: neutral studio lighting, no ground/city, 32 degree vertical FOV (Zombie Lab's),
camera orbit identical to the Lab capture. Lighting models differ (Zombie Lab: three.js PBR with shadow
maps and bloom; engine: hemispheric + key light, no shadows yet), so compare geometry, silhouettes,
joints, materials and colour assignments rather than shading.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
exe, lab_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
cfg = json.load(open(os.path.join(ROOT, "tools/compare_views.json")))
M_PER_VOXEL = 1.7 / 18.0
SHOWCASE = {"drone": 10, "walker": 11, "rotter": 12, "lineup": 0}
CX = -60.0
pairs = []
for v in cfg["views"]:
    png = os.path.join(out, "engine_" + v["name"] + ".png")
    cmd = [exe, "--headless", "--showcase", str(SHOWCASE[v["design"]]), "--studio", "--no-ground", "--free-cam", "--fov", "32",
           "--anim", v["anim"], "--frames", "40", "--width", str(cfg["width"]), "--height", str(cfg["height"]),
           "--cam", str(CX), "0", str(v["yaw"]), str(v["pitch"]), str(v["distVoxels"] * M_PER_VOXEL),
           "--cam-y", str(v["targetY"] * M_PER_VOXEL), "--screenshot", png]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(png):
        print("engine render failed:", v["name"], r.stderr[-400:]); continue
    print("engine", v["name"])
    lab = os.path.join(lab_dir, v["name"] + ".png")
    if os.path.exists(lab): pairs.append((v["name"], lab, png))

def label(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 8 * len(text) + 16, 22], fill=(20, 22, 16))
    d.text((8, 5), text, fill=(230, 235, 215))

for name, lab, eng in pairs:
    a, b = Image.open(lab).convert("RGB"), Image.open(eng).convert("RGB")
    sheet = Image.new("RGB", (a.width + b.width + 8, max(a.height, b.height)), (20, 22, 16))
    sheet.paste(a, (0, 0)); sheet.paste(b, (a.width + 8, 0))
    label(sheet, f"{name}: Zombie Lab (left) | native engine (right)")
    sheet.save(os.path.join(out, "compare_" + name + ".png"))
print(f"{len(pairs)} comparison sheets in {out}")
