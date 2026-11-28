#!/usr/bin/env python3
"""Download every raw source pack listed in assets/audio/sources.json into <raw_dir>/<pack slug>/ and unpack it.
usage: python3 tools/audio/fetch_sources.py <raw_dir>   (then: TTZ_AUDIO_RAW=<raw_dir> python3 tools/audio/build.py <out> --repo .)
Needs: python3, numpy, scipy, py7zr (for .7z packs), ffmpeg with librubberband, libmp3lame, libvorbis."""
import json, os, sys, zipfile, urllib.request, concurrent.futures as cf
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
raw = sys.argv[1]
src = json.load(open(f"{root}/assets/audio/sources.json"))["sources"]
jobs = [(slug, u) for slug, s in src.items() for u in s["download"]]

def get(job):
    slug, u = job
    d = f"{raw}/{slug}"; os.makedirs(d, exist_ok=True)
    out = f"{d}/{u.split('/')[-1]}"
    if not os.path.exists(out):
        data = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=600).read()
        open(out, "wb").write(data)
    if out.lower().endswith(".zip"): zipfile.ZipFile(out).extractall(f"{d}/x")
    elif out.lower().endswith(".7z"):
        import py7zr; py7zr.SevenZipFile(out).extractall(f"{d}/x")
    return out

for p in cf.ThreadPoolExecutor(8).map(get, jobs): print(p)
