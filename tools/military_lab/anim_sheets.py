#!/usr/bin/env python3
"""Assemble anim_shots.mjs frames into review sheets (grid PNG per job) and GIFs.
   python3 tools/military_lab/anim_sheets.py <outDir> [cols]"""
import json, os, sys
from PIL import Image, ImageDraw
out = sys.argv[1]; fr = os.path.join(out, "frames")
idx = json.load(open(os.path.join(fr, "index.json")))
for job in idx:
    ims = [Image.open(os.path.join(fr, f)).convert("RGB") for f in job["files"]]
    if not ims: continue
    w, h = ims[0].size
    big = job["name"].startswith(("para_demo", "crate_demo", "rts_"))
    sc = 0.5 if big else 0.42
    tw, th = int(w * sc), int(h * sc)
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else (4 if big else 4)
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th + 22), (20, 23, 15))
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), job["name"], fill=(230, 230, 210))
    times = job["times"] if isinstance(job["times"], list) else [None] * len(ims)
    for i, im in enumerate(ims):
        x, y = (i % cols) * tw, (i // cols) * th + 22
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
        if times[i] is not None: d.text((x + 6, y + 4), f"t={times[i]}", fill=(255, 240, 150))
    sheet.save(os.path.join(out, job["name"] + "_sheet.png"))
    if job["name"].startswith(("para_demo", "crate_demo", "travel_", "cls_walk_side", "cls_run_side", "cls_fire_persp", "cls_reload")):
        g = [im.resize((int(w * 0.6), int(h * 0.6)), Image.LANCZOS) for im in ims]
        g[0].save(os.path.join(out, job["name"] + ".gif"), save_all=True, append_images=g[1:], duration=350 if big else 120, loop=0)
    print("sheet", job["name"])
