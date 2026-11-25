#!/usr/bin/env python3
"""Compile Tiny Tiny Zombies shaders.

GLSL (Vulkan dialect, SDL3 GPU binding convention)
  -> SPIR-V  (glslangValidator)                       -> shaders/compiled/spirv/<name>.spv
  -> MSL     (SDL_shadercross, SPIR-V -> MSL)          -> shaders/compiled/msl/<name>.msl
  -> JSON    (SDL_shadercross reflection: resource counts, threadcounts)
                                                       -> shaders/compiled/json/<name>.json

The compiled outputs are committed to the repository so that a normal build
(macOS / Windows) does not need any shader tooling. Re-run this script after
editing any file in shaders/.

Usage:
  python3 tools/compile_shaders.py [--glslang PATH] [--shadercross PATH] [--only NAME]

Tool discovery order: command-line flag, $GLSLANG / $SHADERCROSS env vars, PATH.
"""
import argparse
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "shaders")
INC = os.path.join(SRC, "include")
OUT = os.path.join(SRC, "compiled")
STAGES = {".vert": "vertex", ".frag": "fragment", ".comp": "compute"}


def find_tool(flag_value, env_name, names):
    if flag_value:
        return flag_value
    if os.environ.get(env_name):
        return os.environ[env_name]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("FAILED: " + " ".join(cmd) + "\n" + r.stdout + r.stderr)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glslang")
    ap.add_argument("--shadercross")
    ap.add_argument("--only")
    ap.add_argument("--no-msl", action="store_true", help="skip MSL generation (SPIR-V + JSON only)")
    args = ap.parse_args()

    glslang = find_tool(args.glslang, "GLSLANG", ["glslangValidator", "glslang"])
    shadercross = find_tool(args.shadercross, "SHADERCROSS", ["shadercross"])
    if not glslang:
        sys.exit("glslangValidator not found (brew install glslang / apt install glslang-tools / Vulkan SDK)")
    if not shadercross:
        sys.exit("shadercross not found; build it with tools/build_shadercross.sh or set $SHADERCROSS")

    for sub in ("spirv", "msl", "json"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)

    sources = sorted(f for f in os.listdir(SRC) if os.path.splitext(f)[1] in STAGES)
    if args.only:
        sources = [s for s in sources if args.only in s]
    ok = True
    for f in sources:
        stage = STAGES[os.path.splitext(f)[1]]
        spv = os.path.join(OUT, "spirv", f + ".spv")
        msl = os.path.join(OUT, "msl", f + ".msl")
        js = os.path.join(OUT, "json", f + ".json")
        src = os.path.join(SRC, f)
        if not run([glslang, "-V", "--target-env", "vulkan1.0", "-I" + INC, "-o", spv, src]):
            ok = False
            continue
        if not args.no_msl and not run([shadercross, spv, "-s", "SPIRV", "-d", "MSL", "-t", stage,
                                        "--msl-version", "2.1.0", "-o", msl]):
            ok = False
            continue
        if not run([shadercross, spv, "-s", "SPIRV", "-d", "JSON", "-t", stage, "-o", js]):
            ok = False
            continue
        print(f"  {f:32s} ok")
    if not ok:
        sys.exit(1)
    print(f"compiled {len(sources)} shaders -> {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
