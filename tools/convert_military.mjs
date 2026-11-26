#!/usr/bin/env node
/*
 * Tiny Tiny Zombies — military asset converter (Phase 7 Stage A).
 *
 *   node tools/convert_military.mjs [path/to/military_lab.html]
 *
 * Source of truth: tools/military_lab/military_lab_v1.html. Like tools/convert_characters.mjs this does NOT
 * re-type the design: it cuts the renderer-free library out of the Lab (between the markers
 * "MILITARY LIBRARY BEGIN" / "MILITARY LIBRARY END"), runs it in a Node vm sandbox and meshes its models with the
 * Lab's own face / AO / greedy code. Format: docs/MILITARY_ASSETS.md.
 *
 * Checks (abort on failure):
 *   - greedy mesh == culled mesh, unit face by unit face (position, direction, material, AO)
 *   - every vertex lies on the part's half-cell lattice and inside the 10-bit range
 *   - no floating parts: rest-pose voxels form connected pieces that each touch the ground (or the model's anchor)
 *   - no coplanar overlaps: no two parts expose a face on the same plane, in the same direction, over the same area
 *
 * Outputs (deterministic, byte-identical for the same input):
 *   assets/military/infantry.ttzm + infantry.json
 *   assets/military/props.ttzm    + props.json
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2] || path.join(ROOT, "tools/military_lab/military_lab_v1.html");
const FORMAT_VERSION = 1;

const html = fs.readFileSync(SRC, "utf8");
const A = "/* === MILITARY LIBRARY BEGIN === */", Bm = "/* === MILITARY LIBRARY END === */";
const a = html.indexOf(A), b = html.indexOf(Bm);
if (a < 0 || b < 0) throw new Error("Military Lab source layout not recognised (library markers missing)");
const sandbox = { console, Math };
vm.createContext(sandbox);
const lib = vm.runInContext(html.slice(a, b) + `
;({ buildAll, PALETTE, PAL, partFaces, quadsCulled, quadsGreedy, rigidGroup, DIRS, CORN, V_M, PROP_M, SLOTS, PIVOT, HAND, MIL_VERSION })`, sandbox, { filename: "military_lab_v1.html" });

const t0 = Date.now();
const { infantry, props } = lib.buildAll();
const DIRS = lib.DIRS;
const r6 = x => Math.round(x * 1e6) / 1e6;
const vr = v => v.map(r6);

// ------------------------------------------------------------------ lossless check (greedy vs culled)
function unitFaces(quads, s) {
  const out = new Map();
  for (const q of quads) {
    const d = DIRS[q.di];
    const dot = (p, ax) => p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2];
    const us = q.corners.map(p => dot(p, d.u)), vs = q.corners.map(p => dot(p, d.v));
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs), pl = dot(q.corners[0], d.n);
    const uniform = q.ao.every(x => x === q.ao[0]);
    if (!uniform && (q.w !== 1 || q.h !== 1)) throw new Error("merged quad with non-uniform AO");
    for (let u = u0 + s / 2; u < u1; u += s) for (let v = v0 + s / 2; v < v1; v += s) {
      const k = q.di + "|" + Math.round(pl * 8) + "|" + Math.round(u * 8) + "|" + Math.round(v * 8);
      if (out.has(k)) throw new Error("overlapping faces in a mesh");
      out.set(k, q.m + ":" + (uniform ? [q.ao[0], q.ao[0], q.ao[0], q.ao[0]] : q.ao).join(""));
    }
  }
  return out;
}
function verify(culled, greedy, s, label) {
  const A1 = unitFaces(culled, s), A2 = unitFaces(greedy, s);
  if (A1.size !== A2.size) throw new Error(`${label}: greedy face count ${A2.size} != culled ${A1.size}`);
  for (const [k, v] of A1) if (A2.get(k) !== v) throw new Error(`${label}: face ${k} differs`);
}

// ------------------------------------------------------------------ packing
function emit(out, q, origin, s) {
  const order = (q.ao[0] + q.ao[2] < q.ao[1] + q.ao[3]) ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
  for (const i of order) {
    const c = q.corners[i];
    const h = [0, 1, 2].map(k => (c[k] - origin[k]) / (s / 2));
    for (const x of h) { if (Math.abs(x - Math.round(x)) > 1e-6) throw new Error("vertex off the half-cell lattice"); if (Math.abs(x) > 511) throw new Error("vertex out of 10-bit range"); }
    const [x, y, z] = h.map(v => Math.round(v) + 512);
    out.push((x | (y << 10) | (z << 20)) >>> 0, (q.di | (q.ao[i] << 3) | (q.m << 5)) >>> 0);
  }
}

// ------------------------------------------------------------------ rest-pose checks (floating parts, coplanar overlaps)
// parts are rasterised into a common sub-grid of `sub` metres
function partModelCells(model, p) {
  // cell centres (metres, model space, rest pose) and cell edge (metres)
  const off = p.weaponSpace ? lib.HAND.R : [0, 0, 0];
  return [...p.set.map.values()].map(c => [(c.x + off[0]) * p.unitM, (c.y + off[1]) * p.unitM, (c.z + off[2]) * p.unitM]);
}
function checkModel(model, sub, anchor) {
  // --- connectivity
  const cells = new Map();
  const key = (i, j, k) => i + "," + j + "," + k;
  let minJ = Infinity;
  for (const p of model.parts) {
    const e = p.set.size * p.unitM, n = Math.round(e / sub);
    for (const c of partModelCells(model, p)) {
      const i0 = Math.round((c[0] - e / 2) / sub), j0 = Math.round((c[1] - e / 2) / sub), k0 = Math.round((c[2] - e / 2) / sub);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) { cells.set(key(i0 + i, j0 + j, k0 + k), [i0 + i, j0 + j, k0 + k]); minJ = Math.min(minJ, j0 + j); }
    }
  }
  const seen = new Set(), comps = [];
  for (const [k0, c0] of cells) {
    if (seen.has(k0)) continue;
    const stack = [c0]; seen.add(k0); let lowest = Infinity, n = 0, at = null;
    while (stack.length) {
      const [i, j, k] = stack.pop(); n++; if (j < lowest) { lowest = j; at = [i, j, k]; }
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
        const kk = key(i + di, j + dj, k + dk);
        if (!seen.has(kk) && cells.has(kk)) { seen.add(kk); stack.push([i + di, j + dj, k + dk]); }
      }
    }
    comps.push({ n, lowest, at });
  }
  const problems = [];
  if (anchor === "ground") { for (const c of comps) if (c.lowest !== 0) problems.push(`floating piece of ${c.n} sub-cells (lowest ${c.lowest}, at ${c.at.map(v => (v * sub).toFixed(3))} m)`); }
  else if (comps.length !== 1) problems.push(`${comps.length} separate pieces (sizes ${comps.map(c => c.n).join(", ")})`);
  // --- coplanar same-direction faces from different parts
  const faceOwner = new Map();
  let coplanar = 0;
  for (const p of model.parts) {
    const s = p.set.size, e = s * p.unitM, n = Math.round(e / sub), off = p.weaponSpace ? lib.HAND.R : [0, 0, 0];
    const faces = lib.partFaces(p.set, lib.rigidGroup(model, p));
    for (const f of faces) {
      const d = DIRS[f.di];
      const c = [f.c.x + off[0], f.c.y + off[1], f.c.z + off[2]].map(v => v * p.unitM);
      const fc = [0, 1, 2].map(k => c[k] + d.n[k] * e / 2);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const pt = [0, 1, 2].map(k => fc[k] + d.u[k] * (-e / 2 + (i + 0.5) * sub) + d.v[k] * (-e / 2 + (j + 0.5) * sub));
        const kk = f.di + "|" + pt.map(v => Math.round(v / sub * 2)).join(",");
        const o = faceOwner.get(kk);
        if (o !== undefined && o !== p.name) coplanar++;
        else faceOwner.set(kk, p.name);
      }
    }
  }
  if (coplanar) problems.push(`${coplanar} coplanar overlapping sub-faces`);
  return problems;
}

// ------------------------------------------------------------------ bake one file
function bake(models, file, isInf) {
  const verts = [];
  const outModels = [];
  const stats = [];
  const allProblems = [];
  for (const m of models) {
    const parts = [];
    let tri = 0, culledTri = 0;
    for (const p of m.parts) {
      const faces = lib.partFaces(p.set, lib.rigidGroup(m, p));
      const culled = lib.quadsCulled(p.set, faces), greedy = lib.quadsGreedy(p.set, faces);
      verify(culled, greedy, p.set.size, `${m.name}/${p.name}`);
      const origin = p.weaponSpace ? [0, 0, 0] : p.pivot;
      const first = verts.length / 2;
      for (const q of greedy) emit(verts, q, origin, p.set.size);
      const count = verts.length / 2 - first;
      tri += count / 3; culledTri += culled.length * 2;
      parts.push({ name: p.name, parent: p.parent ? m.parts.findIndex(q => q.name === p.parent) : -1, slot: p.slot || null,
                   pivot: vr(p.pivot.map(v => v * p.unitM)), unit: r6(p.set.size * p.unitM), first, count, rigid: p.rigid !== false,
                   voxels: p.set.map.size, ...(p.note ? { note: p.note } : {}) });
    }
    // bounds in rest pose (metres)
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of m.parts) { const e = p.set.size * p.unitM / 2; for (const c of partModelCells(m, p)) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k] - e); mx[k] = Math.max(mx[k], c[k] + e); } }
    const anchor = isInf ? "ground" : (m.anchor || "ground");
    const sub = isInf ? lib.V_M / 4 : lib.PROP_M;
    const problems = checkModel(m, sub, anchor);
    if (problems.length) allProblems.push(`${m.name}: ${problems.join("; ")}`);
    const entry = { name: m.name, label: m.label, class: m.cls || m.cat, bounds: { min: vr(mn), max: vr(mx) }, parts,
                    sockets: (m.sockets || []).map(s => {
                      const pi = s.part ? m.parts.findIndex(q => q.name === s.part) : 0;
                      const pos = isInf ? s.pos.map(v => v * lib.V_M) : s.pos;
                      return { name: s.name, part: pi, pos: vr(pos), dir: s.dir };
                    }), triangles: tri };
    if (!isInf) { entry.footprint = vr([mx[0] - mn[0], mx[2] - mn[2]]); entry.height = r6(mx[1] - mn[1]); entry.anchor = anchor; }
    if (isInf) {
      const w = m.weapon;
      entry.weapon = { kind: w.kind, grip: [0, 0, 0], support: vr(w.support.map(v => v * lib.V_M)), muzzle: vr(w.muzzle.map(v => v * lib.V_M)),
                       sling: vr(w.sling.map(v => v * lib.V_M)), length: r6((Math.max(...[...m.parts.find(p => p.name === "weapon").set.map.values()].map(c => c.z)) -
                       Math.min(...[...m.parts.find(p => p.name === "weapon").set.map.values()].map(c => c.z)) + 0.5) * lib.V_M),
                       handOffsetFromElbow: vr([0, -3.5 * lib.V_M, 0]) };
      const pose = P => ({ rot: Object.fromEntries(Object.entries(P.rot).map(([k, v]) => [k, vr(v)])), weaponMount: vr(P.weaponMount), supportError: P.supportError === null ? null : r6(P.supportError) });
      entry.poses = { rest: pose(m.poses.rest), carry: pose(m.poses.carry) };
      entry.look = m.look;
    }
    outModels.push(entry);
    stats.push(`${m.name.padEnd(28)} ${String(m.parts.length).padStart(2)} parts ${String(tri).padStart(6)} tris (culled ${culledTri})`);
  }
  if (allProblems.length) { console.error(allProblems.join("\n")); throw new Error(`${file}: ${allProblems.length} model(s) failed the rest-pose checks`); }
  // palette: only real entries (the Lab registers its reference-zombie colours outside the library)
  const palette = lib.PALETTE;
  const head = new Uint32Array(8); head[0] = 0x4D5A5454; head[1] = FORMAT_VERSION; head[2] = palette.length; head[3] = verts.length / 2;
  const pal = new Uint32Array(palette.length * 2);
  palette.forEach((p, i) => {
    const n = parseInt(p.rgb.slice(1), 16);
    pal[i * 2] = (((n >> 16) & 255) | (((n >> 8) & 255) << 8) | ((n & 255) << 16) | (255 << 24)) >>> 0;
    pal[i * 2 + 1] = (p.flags | (Math.round(p.noise * 255) << 8)) >>> 0;
  });
  const vb = Uint32Array.from(verts);
  const outDir = path.join(ROOT, "assets/military");
  fs.mkdirSync(outDir, { recursive: true });
  const buf = Buffer.concat([head, pal, vb].map(x => Buffer.from(x.buffer, x.byteOffset, x.byteLength)));
  fs.writeFileSync(path.join(outDir, file + ".ttzm"), buf);
  const manifest = { format: "TTZM", version: FORMAT_VERSION, source: path.relative(ROOT, SRC), labVersion: lib.MIL_VERSION,
    note: "positions in metres, model space, rest pose; Y up, front +Z, left +X. See docs/MILITARY_ASSETS.md",
    palette: palette.map(p => ({ name: p.name, rgb: p.rgb, flags: p.flags, noise: p.noise })), vertexCount: verts.length / 2, models: outModels };
  fs.writeFileSync(path.join(outDir, file + ".json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`\n${file}: ${outModels.length} models, ${verts.length / 6} triangles, ${buf.length} bytes`);
  for (const s of stats) console.log("  " + s);
}

bake(infantry, "infantry", true);
bake(props, "props", false);
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s; all greedy meshes verified lossless; rest-pose float / coplanar checks passed`);
