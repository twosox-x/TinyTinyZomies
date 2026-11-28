#!/usr/bin/env python3
"""Build all Tiny Tiny Zombies sounds from the raw CC0 downloads.

usage: TTZ_AUDIO_RAW=<raw dir> python3 tools/audio/build.py <preview_out_dir> [--only id,id] [--repo <repo root>]

Writes
  <preview_out>/a/<id>.mp3        miniaturised variations, concatenated (sprite) for the HTML preview
  <preview_out>/a/<id>_o.mp3      "original" (same edit, no miniature treatment) variation 0
  <preview_out>/sounds.json       ids, titles, descriptions, sprite offsets, sources
  <repo>/assets/audio/sfx/<cat>/<id>_<n>.ogg   game-ready variations (only with --repo)
  <repo>/assets/audio/used_files.json         which raw files each sound used (input for sources.json)
"""
import json, os, sys, multiprocessing as mp
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp as D
import recipes as RC

GAP = 0.35


def build_one(args):
    ri, out, repo = args
    r = RC.R[ri]
    RC.CUR_ID = r["id"]
    RC.USED.clear()
    res = {k: r[k] for k in ("id", "cat", "title", "desc", "nvar", "target", "mode")}
    try:
        variants = {}
        for mini in (True, False):
            RC.MINI = mini
            vs = []
            for v in range(r["nvar"] if mini else 1):
                D.seed(sum(map(ord, r["id"])) * 31 + v)
                x = r["fn"](v).astype(np.float32)
                x = D.normalize(x, r["target"], r["mode"])
                vs.append(x)
            variants[mini] = vs
        os.makedirs(f"{out}/a", exist_ok=True)
        offs, t = [], 0.0
        for x in variants[True]:
            offs.append([round(t, 4), round(len(x) / D.SR, 4)]); t += len(x) / D.SR + GAP
        D.save(D.concat(variants[True], GAP), f"{out}/a/{r['id']}.mp3")
        o = variants[False][0]
        D.save(o, f"{out}/a/{r['id']}_o.mp3")
        res["offsets"] = offs; res["orig"] = [0.0, round(len(o) / D.SR, 4)]
        res["loop"] = "(loop)" in r["title"]
        if repo:
            for i, x in enumerate(variants[True]):
                D.save(x, f"{repo}/assets/audio/sfx/{r['cat'].lower()}/{r['id']}_{i}.ogg")
        res["used"] = {k: sorted(v.keys()) for k, v in RC.USED.items()}
        res["lufs"] = round(D.loudness_max(variants[True][0]), 1)
    except Exception as e:
        import traceback; traceback.print_exc()
        res["error"] = repr(e)
    print(("ERR " if "error" in res else "ok  ") + r["id"], flush=True)
    return res


def main():
    out = sys.argv[1]
    only = None; repo = None
    if "--only" in sys.argv: only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    if "--repo" in sys.argv: repo = sys.argv[sys.argv.index("--repo") + 1]
    rs = [r for r in RC.R if not only or r["id"] in only]
    with mp.Pool(max(1, os.cpu_count() - 0)) as pool:
        res = pool.map(build_one, [(RC.R.index(r), out, repo) for r in rs], chunksize=1)
    path = f"{out}/sounds.json"
    old = {s["id"]: s for s in json.load(open(path))} if only and os.path.exists(path) else {}
    for s in res: old[s["id"]] = s
    order = [r["id"] for r in RC.R]
    allres = [old[i] for i in order if i in old]
    json.dump(allres, open(path, "w"), indent=1)
    errs = [s["id"] for s in res if "error" in s]
    print(f"{len(res) - len(errs)} built, errors: {errs}")


if __name__ == "__main__":
    main()
