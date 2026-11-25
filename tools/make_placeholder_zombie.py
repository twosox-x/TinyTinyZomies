#!/usr/bin/env python3
"""Generate the placeholder voxel zombie as a glTF binary (assets/models/zombie.glb).

Structure mirrors what a Blockbench glTF export produces, so the engine path is the same:
  - one node per body part, named head / body / arm_left / arm_right / leg_left / leg_right
  - each node's translation is the part pivot (joint); mesh vertices are relative to it
  - one material with an embedded nearest-filtered palette texture (per-face colours)
Appearance variants: the texture contains N vertically stacked copies of the skin
("variant rows"); authored UVs point into row 0 and the shader offsets by variant.
Pure Python (no dependencies).
"""
import json
import os
import struct
import zlib

ROWS = 8          # variants
COLS = 8          # materials: skin, shirt, pants, shoes, hair, dark, blood, accent
SKIN, SHIRT, PANTS, SHOES, HAIR, DARK, BLOOD, ACCENT = range(8)

# Palette: zombie skin pale green / blue-grey (see docs/reference), muted clothing.
SKIN_COLORS = [(150, 190, 160), (160, 205, 210), (135, 170, 140), (175, 195, 170), (145, 180, 190), (120, 160, 130),
         (170, 185, 160), (140, 175, 175)]
SHIRT_COLORS = [(70, 110, 85), (110, 60, 55), (60, 75, 110), (150, 140, 110), (90, 90, 95), (120, 100, 60),
          (60, 95, 100), (140, 120, 125)]
PANTS_COLORS = [(45, 50, 70), (60, 55, 50), (40, 60, 55), (75, 70, 90), (35, 38, 45), (80, 65, 50), (50, 50, 60),
         (65, 75, 60)]
HAIR_COLORS = [(40, 35, 30), (90, 70, 40), (25, 25, 28), (120, 110, 100), (60, 40, 30), (30, 30, 35), (150, 120, 70),
         (70, 60, 55)]


def palette():
    px = []
    for r in range(ROWS):
        row = [SKIN_COLORS[r], SHIRT_COLORS[r], PANTS_COLORS[r], (35, 32, 30), HAIR_COLORS[r], (25, 20, 25), (110, 20, 25),
               tuple(max(0, c - 25) for c in SHIRT_COLORS[r])]
        px.append(row)
    return px


def png(pixels):
    h, w = len(pixels), len(pixels[0])
    raw = b"".join(b"\x00" + bytes([c for p in row for c in (*p, 255)]) for row in pixels)

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


FACES = [  # normal, 4 corners as (x,y,z) selectors in {0,1}
    ((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
    ((-1, 0, 0), [(0, 0, 1), (0, 1, 1), (0, 1, 0), (0, 0, 0)]),
    ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
    ((0, -1, 0), [(0, 0, 1), (0, 0, 0), (1, 0, 0), (1, 0, 1)]),
    ((0, 0, 1), [(1, 0, 1), (1, 1, 1), (0, 1, 1), (0, 0, 1)]),
    ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
]


class Mesh:
    def __init__(self):
        self.pos, self.nrm, self.uv, self.idx = [], [], [], []

    def box(self, mn, mx, mat, face_mats=None):
        """Axis-aligned voxel box. face_mats: optional {face_index: material} overrides."""
        for fi, (n, corners) in enumerate(FACES):
            m = face_mats.get(fi, mat) if face_mats else mat
            base = len(self.pos)
            for c in corners:
                self.pos.append(tuple(mn[k] if c[k] == 0 else mx[k] for k in range(3)))
                self.nrm.append(n)
                self.uv.append(((m + 0.5) / COLS, 0.5 / ROWS))
            # counter-clockwise when seen from outside
            self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]


def build_parts():
    parts = {}
    # all coordinates in metres, model faces +Z; vertices relative to the part pivot
    # legs (pivot at hip)
    for name, sx in (("leg_left", 1), ("leg_right", -1)):
        m = Mesh()
        x0 = sx * 0.11 - 0.09
        m.box((x0, -0.72, -0.10), (x0 + 0.18, -0.12, 0.10), PANTS)
        m.box((x0, -0.72, -0.10), (x0 + 0.18, -0.62, 0.13), SHOES)
        if sx < 0:
            m.box((x0 + 0.02, -0.40, 0.10), (x0 + 0.14, -0.30, 0.102), BLOOD)   # torn trousers
        parts[name] = ((0.0, 0.72, 0.0), m)
    # torso (pivot at waist)
    m = Mesh()
    m.box((-0.23, 0.0, -0.13), (0.23, 0.58, 0.13), SHIRT)
    m.box((-0.23, 0.0, -0.13), (0.23, 0.08, 0.13), ACCENT)                  # belt
    m.box((0.02, 0.22, 0.13), (0.14, 0.36, 0.135), BLOOD)                   # wound
    m.box((-0.18, 0.40, 0.13), (-0.08, 0.48, 0.135), BLOOD)
    parts["body"] = ((0.0, 0.72, 0.0), m)
    # head (pivot at neck)
    m = Mesh()
    m.box((-0.18, 0.02, -0.18), (0.18, 0.38, 0.18), SKIN)
    m.box((-0.19, 0.30, -0.19), (0.19, 0.40, 0.19), HAIR)                   # hair cap
    m.box((-0.19, 0.16, -0.19), (0.19, 0.30, -0.10), HAIR)                  # back hair
    m.box((-0.12, 0.20, 0.18), (-0.04, 0.27, 0.19), DARK)                   # eyes
    m.box((0.05, 0.19, 0.18), (0.13, 0.26, 0.19), DARK)
    m.box((-0.09, 0.07, 0.18), (0.10, 0.11, 0.19), DARK)                    # mouth
    m.box((0.06, 0.02, 0.18), (0.12, 0.07, 0.19), BLOOD)
    parts["head"] = ((0.0, 1.30, 0.0), m)
    # arms (pivot at shoulder), hanging down; the shader raises them forward
    for name, sx in (("arm_left", 1), ("arm_right", -1)):
        m = Mesh()
        x0 = sx * 0.30 - 0.07
        m.box((x0, -0.58, -0.07), (x0 + 0.14, 0.04, 0.07), SHIRT)
        m.box((x0, -0.58, -0.07), (x0 + 0.14, -0.44, 0.07), SKIN)          # hand
        parts[name] = ((0.0, 1.26, 0.0), m)
    return parts


def write_glb(path):
    parts = build_parts()
    bin_data = bytearray()
    buffer_views, accessors, meshes, nodes = [], [], [], []

    def add_view(data, target=None):
        while len(bin_data) % 4:
            bin_data.append(0)
        off = len(bin_data)
        bin_data.extend(data)
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            bv["target"] = target
        buffer_views.append(bv)
        return len(buffer_views) - 1

    def add_accessor(values, comps, ctype, typ, target, minmax=False):
        fmt = {5126: "f", 5125: "I"}[ctype]
        flat = [c for v in values for c in (v if isinstance(v, tuple) else (v,))]
        bv = add_view(struct.pack("<%d%s" % (len(flat), fmt), *flat), target)
        acc = {"bufferView": bv, "componentType": ctype, "count": len(values), "type": typ}
        if minmax:
            acc["min"] = [min(v[k] for v in values) for k in range(comps)]
            acc["max"] = [max(v[k] for v in values) for k in range(comps)]
        accessors.append(acc)
        return len(accessors) - 1

    child_ids = []
    for name, (pivot, m) in parts.items():
        a_pos = add_accessor(m.pos, 3, 5126, "VEC3", 34962, True)
        a_nrm = add_accessor(m.nrm, 3, 5126, "VEC3", 34962)
        a_uv = add_accessor(m.uv, 2, 5126, "VEC2", 34962)
        a_idx = add_accessor(m.idx, 1, 5125, "SCALAR", 34963)
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm,
                                                                    "TEXCOORD_0": a_uv},
                                                     "indices": a_idx, "material": 0}]})
        nodes.append({"name": name, "mesh": len(meshes) - 1, "translation": list(pivot)})
        child_ids.append(len(nodes) - 1)
    nodes.append({"name": "zombie", "children": child_ids})
    img_view = add_view(png(palette()))
    gltf = {
        "asset": {"version": "2.0", "generator": "TinyTinyZombies make_placeholder_zombie.py"},
        "scene": 0,
        "scenes": [{"nodes": [len(nodes) - 1]}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [{"name": "palette", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0},
                                                                   "metallicFactor": 0.0}}],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728}],
        "images": [{"bufferView": img_view, "mimeType": "image/png"}],
        "buffers": [{"byteLength": 0}],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "extras": {"ttz_variant_rows": ROWS},
    }
    while len(bin_data) % 4:
        bin_data.append(0)
    gltf["buffers"][0]["byteLength"] = len(bin_data)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    total = 12 + 8 + len(js) + 8 + len(bin_data)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(bin_data), 0x004E4942) + bin_data)
    print("wrote", path, total, "bytes")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    write_glb(os.path.join(root, "assets", "models", "zombie.glb"))
