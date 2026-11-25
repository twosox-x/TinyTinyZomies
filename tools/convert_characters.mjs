#!/usr/bin/env node
/*
 * Tiny Tiny Zombies — character asset converter.
 *
 *   node tools/convert_characters.mjs [path/to/zombie_lab.html]
 *
 * Source of truth: the approved Zombie Lab HTML (assets/characters/source/zombie_lab_v3.html).
 * The converter does NOT re-type the character design. It extracts the Zombie Lab script section
 * that defines the body template, palettes, module library and decoration code, runs it in a
 * sandbox, and bakes runtime geometry from it:
 *
 *   for every body slot (10), module variant, stump state (upper arms) and decoration variant
 *   (Low tier; Medium/High tier x 4 decomposition buckets x 4 seeds):
 *     - naive   : every cube face of every voxel (reference for "before optimisation")
 *     - culled  : faces between voxels of the same segment removed (exactly Zombie Lab's mesher)
 *     - greedy  : culled faces merged into larger rectangles where tag + ambient occlusion are
 *                 uniform; faces with non-uniform AO stay per-voxel with Zombie Lab's diagonal rule
 *     - voxel   : greedy merged by ambient occlusion only; the material of every fragment is looked up
 *                 per voxel in the fragment shader (exact), so colour boundaries no longer split faces
 *   and verifies that greedy == culled and voxel == culled face-for-face (lossless), aborting otherwise.
 *
 * Outputs (all reproducible, byte-identical for the same input):
 *   assets/characters/zombie_parts.ttzc     binary runtime asset (mesh table + packed vertices)
 *   assets/characters/zombie_parts.json     manifest: ids, names, decay levels, stats
 *   shaders/include/zombie_parts.glsl       generated GPU constants (template, palettes, tables)
 *
 * Packed vertex (one uint32, non-indexed triangle lists):
 *   bits  0..6  x  (half-voxels relative to the segment pivot, +64 bias)
 *   bits  7..13 y
 *   bits 14..20 z
 *   bits 21..23 normal index (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z)
 *   bits 24..25 ambient occlusion level (0..3 -> 0.5, 0.67, 0.84, 1.0)
 *   bits 26..30 material tag (see TAGS); 31 = look the material up in the mesh's voxel grid (level 3)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.argv[2] || path.join(ROOT, "assets/characters/source/zombie_lab_v3.html");
const ASSET_VERSION = 2;

// ------------------------------------------------------------------ extract Zombie Lab definitions
const html = fs.readFileSync(SRC, "utf8");
const startMark = "const SLOTS = [";
const endMark = "/* ---------------- greedy-free voxel mesher";
const a = html.indexOf(startMark), b = html.indexOf(endMark);
if (a < 0 || b < 0) throw new Error("Zombie Lab source layout not recognised (markers missing)");
const labCode = html.slice(a, b);
const sandbox = { THREE: null, console, Date, Math };
vm.createContext(sandbox);
const lab = vm.runInContext(labCode + `
;({ SLOTS, FAMILY, SIDE, PIVOT, PARENT, MODULES, MOD, DESIGNS, SKINS, TOPS, PANTS, SHIRTS, HAIRS, TIES, HATS, SHOES, FIXED,
    makeVox, decorate, mulberry32, hashStr, DECORABLE })`, sandbox, { filename: "zombie_lab_v3.html" });

// ------------------------------------------------------------------ conversion parameters
const TAGS = ["skin", "skinDark", "cloth", "clothDark", "top2", "top2Dark", "pants", "pantsDark", "pantsLight", "hair", "tie",
              "hat", "hatDark", "shoe", "sleeve", "sleeveDark", "blood", "bloodDark", "gore", "bone", "boneDark", "meat",
              "meatDark", "mouth", "belt", "eye"];
const TAG_ID = Object.fromEntries(TAGS.map((t, i) => [t, i]));
const FAMILIES = ["head", "torso", "upperArm", "forearm", "thigh", "shin"];
// Zombie Lab's decomposition is continuous; it is baked at 4 levels (Street Walker 0.55 and Rotter 0.9 are exact).
const DECAY_BUCKETS = [0.25, 0.55, 0.75, 0.9];
// Zombie Lab uses one random seed per character for decoration + colour noise; 4 baked seeds.
const SEEDS = [101, 202, 303, 404];
// decoration variants: 0 = Low tier (undecorated); then tier 1 and tier 2, each decay x seed
const DECO = [{ tier: 0, decay: 0, seed: SEEDS[0] }];
for (const tier of [1, 2]) for (let d = 0; d < 4; d++) for (let s = 0; s < 4; s++) DECO.push({ tier, decay: DECAY_BUCKETS[d], seed: SEEDS[s] });
const DECO_COUNT = DECO.length;   // 33
const decoIndex = (tier, decayBucket, seedVar) => tier === 0 ? 0 : 1 + (tier - 1) * 16 + decayBucket * 4 + seedVar;

// ------------------------------------------------------------------ voxel helpers (exact Zombie Lab conventions)
const DIRS = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
];
const CORN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function buildSegment(slot, mod, deco, forearmMissing) {
  const fam = lab.FAMILY[slot];
  const s = lab.SIDE[slot];
  const spec = { seed: deco.seed, detail: deco.tier, decay: deco.decay, modules: {} };
  for (const sl of lab.SLOTS) spec.modules[sl] = lab.MODULES[lab.FAMILY[sl]][0].id;
  spec.modules[slot] = mod.id;
  if (fam === "upperArm") spec.modules[s > 0 ? "forearmL" : "forearmR"] = forearmMissing ? "missing" : "sleeve";
  // identical to Zombie Lab Zombie.buildSlot()
  const rng = lab.mulberry32(lab.hashStr(spec.seed + ":" + slot + ":" + mod.id + ":" + spec.detail + ":" + Math.round(spec.decay * 20)));
  const v = lab.makeVox();
  mod.build(v, s, { rng, spec });
  lab.decorate(v, spec, rng, slot);
  return v;
}

// every exposed unit face with Zombie Lab's per-corner AO and diagonal choice
function exposedFaces(v, naive) {
  const faces = [];
  for (const c of v.map.values()) {
    for (let di = 0; di < 6; di++) {
      const d = DIRS[di];
      const nx = c.x + d.n[0], ny = c.y + d.n[1], nz = c.z + d.n[2];
      const hidden = v.has(nx, ny, nz);
      if (hidden && !naive) continue;
      const ao = [];
      for (const [su, sv] of CORN) {
        const s1 = v.has(nx + su * d.u[0], ny + su * d.u[1], nz + su * d.u[2]) ? 1 : 0;
        const s2 = v.has(nx + sv * d.v[0], ny + sv * d.v[1], nz + sv * d.v[2]) ? 1 : 0;
        const cr = v.has(nx + su * d.u[0] + sv * d.v[0], ny + su * d.u[1] + sv * d.v[1], nz + su * d.u[2] + sv * d.v[2]) ? 1 : 0;
        ao.push(s1 && s2 ? 0 : 3 - (s1 + s2 + cr));
      }
      faces.push({ c, di, tag: TAG_ID[c.tag], ao });
    }
  }
  return faces;
}

// quad corners in body space (voxel units) -> packed vertices, Zombie Lab triangulation
function packVertex(p, pivot, di, ao, tag) {
  const q = [0, 1, 2].map(k => Math.round((p[k] - pivot[k]) * 2) + 64);
  for (const k of q) if (k < 0 || k > 127) throw new Error("vertex out of packing range");
  return (q[0] | (q[1] << 7) | (q[2] << 14) | (di << 21) | (ao << 24) | (tag << 26)) >>> 0;
}
function emitQuad(out, corners, pivot, di, ao, tag) {
  // corners in CORN order (CCW seen from outside); diagonal flip exactly like Zombie Lab
  const order = (ao[0] + ao[2] < ao[1] + ao[3]) ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
  for (const i of order) out.push(packVertex(corners[i], pivot, di, ao[i], tag));
}
function unitCorners(f) {
  const d = DIRS[f.di];
  return CORN.map(([su, sv]) => [0, 1, 2].map(k => f.c[["x", "y", "z"][k]] + 0.5 * (d.n[k] + su * d.u[k] + sv * d.v[k])));
}

function meshPerFace(faces, pivot) {
  const out = [];
  for (const f of faces) emitQuad(out, unitCorners(f), pivot, f.di, f.ao, f.tag);
  return out;
}

// Greedy merge: within each face plane, merge rectangles of faces that share tag and a uniform AO value.
// Faces whose four corners have different AO keep their own quad (merging would change the shading).
function meshGreedy(faces, pivot, aoOnly = false) {
  const out = [];
  const groups = new Map();
  const loose = [];
  for (const f of faces) {
    const uni = f.ao[0] === f.ao[1] && f.ao[1] === f.ao[2] && f.ao[2] === f.ao[3];
    if (!uni) { loose.push(f); continue; }
    const d = DIRS[f.di];
    const c = [f.c.x, f.c.y, f.c.z];
    const plane = d.n[0] * c[0] + d.n[1] * c[1] + d.n[2] * c[2];
    const key = f.di + "|" + plane.toFixed(2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ f, u: d.u[0] * c[0] + d.u[1] * c[1] + d.u[2] * c[2], v: d.v[0] * c[0] + d.v[1] * c[1] + d.v[2] * c[2] });
  }
  for (const list of groups.values()) {
    const cell = new Map();
    for (const e of list) cell.set(e.u.toFixed(2) + "," + e.v.toFixed(2), e);
    const keyOf = e => (aoOnly ? 0 : e.f.tag * 8) + e.f.ao[0];
    const used = new Set();
    list.sort((p, q) => p.v - q.v || p.u - q.u);
    for (const e of list) {
      const id = e.u.toFixed(2) + "," + e.v.toFixed(2);
      if (used.has(id)) continue;
      const k = keyOf(e);
      const at = (u, v) => { const x = cell.get(u.toFixed(2) + "," + v.toFixed(2)); return x && !used.has(u.toFixed(2) + "," + v.toFixed(2)) && keyOf(x) === k ? x : null; };
      let w = 1;
      while (at(e.u + w, e.v)) w++;
      let h = 1;
      outer: for (;;) {
        for (let i = 0; i < w; i++) if (!at(e.u + i, e.v + h)) break outer;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used.add((e.u + i).toFixed(2) + "," + (e.v + j).toFixed(2));
      // rectangle corners from the first face's unit corners, stretched along u and v
      const d = DIRS[e.f.di];
      const base = [e.f.c.x, e.f.c.y, e.f.c.z];
      const corners = CORN.map(([su, sv]) => [0, 1, 2].map(k =>
        base[k] + 0.5 * d.n[k] + (su < 0 ? -0.5 : w - 0.5) * d.u[k] + (sv < 0 ? -0.5 : h - 0.5) * d.v[k]));
      emitQuad(out, corners, pivot, e.f.di, [e.f.ao[0], e.f.ao[0], e.f.ao[0], e.f.ao[0]], aoOnly ? 31 : e.f.tag);
      e.rect = { w, h };
    }
  }
  for (const f of loose) emitQuad(out, unitCorners(f), pivot, f.di, f.ao, aoOnly ? 31 : f.tag);
  return out;
}

// Per-mesh voxel material grid (bounding box of voxel centres, x fastest, one byte per cell: tag + 1, 0 = empty)
function voxelGrid(v) {
  const cs = [...v.map.values()];
  if (!cs.length) return { min: [0, 0, 0], dims: [0, 0, 0], bytes: [] };
  const min = [0, 1, 2].map(k => Math.min(...cs.map(c => [c.x, c.y, c.z][k])));
  const max = [0, 1, 2].map(k => Math.max(...cs.map(c => [c.x, c.y, c.z][k])));
  const dims = [0, 1, 2].map(k => Math.round(max[k] - min[k]) + 1);
  if (dims.some(d => d > 15)) throw new Error("segment voxel grid too large");
  const bytes = new Array(dims[0] * dims[1] * dims[2]).fill(0);
  for (const c of cs) {
    const i = [c.x, c.y, c.z].map((x, k) => Math.round(x - min[k]));
    bytes[i[0] + dims[0] * (i[1] + dims[1] * i[2])] = TAG_ID[c.tag] + 1;
  }
  return { min, dims, bytes };
}
function gridTag(grid, centre) {
  const i = [0, 1, 2].map(k => Math.round(centre[k] - grid.min[k]));
  if (i.some((x, k) => x < 0 || x >= grid.dims[k])) return -1;
  return grid.bytes[i[0] + grid.dims[0] * (i[1] + grid.dims[1] * i[2])] - 1;
}

// ---------------- lossless verification: rasterise both meshes back to unit faces and compare
function unpack(w, pivot) {
  return { p: [(w & 127) - 64, ((w >> 7) & 127) - 64, ((w >> 14) & 127) - 64].map((q, k) => q / 2 + pivot[k]), di: (w >> 21) & 7, ao: (w >> 24) & 3, tag: (w >> 26) & 31 };
}
function faceSignature(verts, pivot, grid) {
  // Each triangle pair forms a quad; decompose quads into unit faces, record (centre, dir, tag, ao at the unit's corners).
  const sig = new Map();
  for (let i = 0; i < verts.length; i += 6) {
    const q = verts.slice(i, i + 6).map(w => unpack(w, pivot));
    const di = q[0].di, tag = q[0].tag, d = DIRS[di];
    const pts = q.map(x => x.p);
    const dot = (p, a) => p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
    const us = pts.map(p => dot(p, d.u)), vs = pts.map(p => dot(p, d.v));
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    const plane = dot(pts[0], d.n);
    // corner AO lookup by (u,v)
    const aoAt = new Map(q.map(x => [dot(x.p, d.u).toFixed(2) + "," + dot(x.p, d.v).toFixed(2), x.ao]));
    const uniform = new Set(q.map(x => x.ao)).size === 1;
    for (let u = u0 + 0.5; u < u1; u += 1) for (let v = v0 + 0.5; v < v1; v += 1) {
      const corner = (su, sv) => uniform ? q[0].ao : aoAt.get((u + 0.5 * su).toFixed(2) + "," + (v + 0.5 * sv).toFixed(2));
      const key = di + "|" + plane.toFixed(2) + "|" + u.toFixed(2) + "|" + v.toFixed(2);
      if (sig.has(key)) throw new Error("overlapping faces in mesh");
      let t = tag;
      if (tag === 31) {   // voxel-material face: the fragment shader resolves the voxel behind this point
        const ctr = [0, 1, 2].map(k => d.n[k] * (plane - 0.5) + d.u[k] * u + d.v[k] * v);
        t = gridTag(grid, ctr);
      }
      sig.set(key, t + ":" + CORN.map(([su, sv]) => corner(su, sv)).join(""));
    }
  }
  return sig;
}
function verifyLossless(a, b, pivot, label, grid) {
  const sa = faceSignature(a, pivot, grid), sb = faceSignature(b, pivot, grid);
  if (sa.size !== sb.size) throw new Error(`${label}: face count differs ${sa.size} vs ${sb.size}`);
  for (const [k, val] of sa) if (sb.get(k) !== val) throw new Error(`${label}: face ${k} differs (${val} vs ${sb.get(k)})`);
}

// ------------------------------------------------------------------ bake everything
const meshes = [];     // { slot, module, stump, deco, levels: [naive, culled, greedy] (Uint32 arrays) }
const slotInfo = [];
for (let si = 0; si < lab.SLOTS.length; si++) {
  const slot = lab.SLOTS[si];
  const fam = lab.FAMILY[slot];
  const mods = lab.MODULES[fam];
  const stumpStates = fam === "upperArm" ? 2 : 1;
  const base = meshes.length;
  for (let mi = 0; mi < mods.length; mi++)
    for (let st = 0; st < stumpStates; st++)
      for (let di = 0; di < DECO_COUNT; di++) {
        const v = buildSegment(slot, mods[mi], DECO[di], st === 1);
        const pivot = lab.PIVOT[slot];
        const naive = meshPerFace(exposedFaces(v, true), pivot);
        const culledFaces = exposedFaces(v, false);
        const culled = meshPerFace(culledFaces, pivot);
        const greedy = meshGreedy(culledFaces, pivot);
        const voxel = meshGreedy(culledFaces, pivot, true);
        const grid = voxelGrid(v);
        verifyLossless(culled, greedy, pivot, `${slot}/${mods[mi].id}/stump${st}/deco${di}`, grid);
        verifyLossless(culled, voxel, pivot, `${slot}/${mods[mi].id}/stump${st}/deco${di} (voxel)`, grid);
        meshes.push({ slot, module: mods[mi].id, stump: st, deco: di, voxels: v.map.size, grid, levels: [naive, culled, greedy, voxel] });
      }
  slotInfo.push({ slot, family: fam, base, modules: mods.length, stumpStates, count: meshes.length - base });
}

// ------------------------------------------------------------------ statistics
const LEVELS = ["naive", "culled", "greedy", "voxel"];
const stats = { meshes: meshes.length, levels: {} };
for (let l = 0; l < 4; l++) {
  let verts = 0;
  const famMax = {}, famSum = {}, famCnt = {};
  for (const m of meshes) {
    const n = m.levels[l].length;
    verts += n;
    const fam = lab.FAMILY[m.slot];
    famMax[fam] = Math.max(famMax[fam] || 0, n);
    famSum[fam] = (famSum[fam] || 0) + n;
    famCnt[fam] = (famCnt[fam] || 0) + 1;
  }
  stats.levels[LEVELS[l]] = { vertices: verts, triangles: verts / 3, bytes: verts * 4,
    familyMaxVertices: famMax, familyAvgVertices: Object.fromEntries(Object.keys(famSum).map(f => [f, +(famSum[f] / famCnt[f]).toFixed(1)])) };
}
// typical character (Office Drone, Street Walker, Rotter) triangle counts per level
function designTris(name, tier, decayBucket) {
  const d = lab.DESIGNS[name];
  const out = [0, 0, 0, 0];
  for (const si of slotInfo) {
    const modId = d.modules[si.slot];
    const mi = lab.MODULES[si.family].findIndex(m => m.id === modId);
    let st = 0;
    if (si.family === "upperArm") st = d.modules[lab.SIDE[si.slot] > 0 ? "forearmL" : "forearmR"] === "missing" ? 1 : 0;
    const m = meshes[si.base + (mi * si.stumpStates + st) * DECO_COUNT + decoIndex(tier, decayBucket, 0)];
    for (let l = 0; l < 4; l++) out[l] += m.levels[l].length / 3;
  }
  return Object.fromEntries(LEVELS.map((n, l) => [n, out[l]]));
}
stats.designs = { drone: designTris("drone", 0, 0), walker: designTris("walker", 1, 1), rotter: designTris("rotter", 2, 3) };

// ------------------------------------------------------------------ write binary asset
// header (16 uint32): magic 'TTZC', version, meshCount, levelCount (4), decoCount, words of level 0..3 [5..8],
//                     slotCount [9], tag blob words [10], reserved
// slot table (10 x 4 uint32): baseMesh, moduleCount, stumpStates, familyIndex
// mesh table (meshCount x 4 levels x 2 uint32): vertexOffset, vertexCount   (offsets in uint32 words, per level blob)
// mesh voxel table (meshCount x 4 uint32): tag byte offset, grid min * 2 + 128 (3 x 8 bits), dims (3 x 4 bits), 0
// level blobs: packed vertices; tag blob: one byte per voxel cell (tag + 1, 0 = empty)
const words = [];
const header = new Uint32Array(16);
header[0] = 0x435a5454; header[1] = ASSET_VERSION; header[2] = meshes.length; header[3] = 4; header[4] = DECO_COUNT;
header[9] = lab.SLOTS.length;
const slotTable = new Uint32Array(lab.SLOTS.length * 4);
slotInfo.forEach((s, i) => { slotTable.set([s.base, s.modules, s.stumpStates, FAMILIES.indexOf(s.family)], i * 4); });
const meshTable = new Uint32Array(meshes.length * 4 * 2);
const blobs = [];
for (let l = 0; l < 4; l++) {
  let off = 0;
  const parts = [];
  meshes.forEach((m, i) => { meshTable[(i * 4 + l) * 2] = off; meshTable[(i * 4 + l) * 2 + 1] = m.levels[l].length; off += m.levels[l].length; parts.push(m.levels[l]); });
  header[5 + l] = off;
  const blob = new Uint32Array(off);
  let o = 0;
  for (const p of parts) { blob.set(p, o); o += p.length; }
  blobs.push(blob);
}
const voxTable = new Uint32Array(meshes.length * 4);
const tagBytes = [];
meshes.forEach((m, i) => {
  const g = m.grid;
  voxTable[i * 4] = tagBytes.length;
  voxTable[i * 4 + 1] = ((Math.round(g.min[0] * 2) + 128) | ((Math.round(g.min[1] * 2) + 128) << 8) | ((Math.round(g.min[2] * 2) + 128) << 16)) >>> 0;
  voxTable[i * 4 + 2] = g.dims[0] | (g.dims[1] << 4) | (g.dims[2] << 8);
  tagBytes.push(...g.bytes);
});
while (tagBytes.length % 4) tagBytes.push(0);
const tagBlob = new Uint8Array(tagBytes);
header[10] = tagBlob.length / 4;
const outDir = path.join(ROOT, "assets/characters");
fs.mkdirSync(outDir, { recursive: true });
const buf = Buffer.concat([header, slotTable, meshTable, voxTable, ...blobs, tagBlob].map(x => Buffer.from(x.buffer, x.byteOffset, x.byteLength)));
fs.writeFileSync(path.join(outDir, "zombie_parts.ttzc"), buf);

// ------------------------------------------------------------------ manifest
const manifest = {
  format: "TTZC", version: ASSET_VERSION, source: path.relative(ROOT, SRC),
  voxel: { heightVoxels: 18, note: "feet at y=0, facing +Z, character's left = +X; positions in voxel units" },
  slots: lab.SLOTS.map((s, i) => ({ id: i, name: s, family: lab.FAMILY[s], side: lab.SIDE[s], pivot: lab.PIVOT[s], parent: lab.PARENT[s] })),
  families: Object.fromEntries(FAMILIES.map(f => [f, lab.MODULES[f].map((m, i) => ({ index: i, id: m.id, name: m.name, decay: m.decay, sleeve: m.sleeve }))])),
  tags: TAGS, decayBuckets: DECAY_BUCKETS, seeds: SEEDS, decorationVariants: DECO_COUNT,
  stats,
};
fs.writeFileSync(path.join(outDir, "zombie_parts.json"), JSON.stringify(manifest, null, 1) + "\n");

// ------------------------------------------------------------------ generated GLSL constants
const hex = h => { const n = parseInt(h.slice(1), 16); return `vec3(${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => (c / 255).toFixed(6)).join(", ")})`; };
const arr = (type, name, items) => `const ${type} ${name}[${items.length}] = ${type}[${items.length}](${items.join(", ")});`;
let g = `// GENERATED by tools/convert_characters.mjs from ${path.relative(ROOT, SRC)} — do not edit.
// Asset version ${ASSET_VERSION}. Mirrors the approved Zombie Lab body template, module library and palettes.
#ifndef TTZ_ZOMBIE_PARTS_GLSL
#define TTZ_ZOMBIE_PARTS_GLSL
#define ZP_SLOTS 10
#define ZP_DECO_COUNT ${DECO_COUNT}
// slots: ${lab.SLOTS.join(", ")}
${arr("int", "ZP_SLOT_FAMILY", lab.SLOTS.map(s => FAMILIES.indexOf(lab.FAMILY[s])))}
${arr("int", "ZP_SLOT_PARENT", lab.SLOTS.map(s => lab.PARENT[s] ? lab.SLOTS.indexOf(lab.PARENT[s]) : -1))}
${arr("vec3", "ZP_PIVOT", lab.SLOTS.map(s => `vec3(${lab.PIVOT[s].map(x => x.toFixed(1)).join(", ")})`))}
${arr("uint", "ZP_SLOT_BASE", slotInfo.map(s => s.base + "u"))}
${arr("uint", "ZP_SLOT_STUMPS", slotInfo.map(s => s.stumpStates + "u"))}
// families: ${FAMILIES.join(", ")}
${arr("uint", "ZP_FAMILY_COUNT", FAMILIES.map(f => lab.MODULES[f].length + "u"))}
${arr("uint", "ZP_FAMILY_FIRST", FAMILIES.map((f, i) => FAMILIES.slice(0, i).reduce((n, x) => n + lab.MODULES[x].length, 0) + "u"))}
// module decay level (0 intact, 1 damaged, 2 decomposed), flattened by family
${arr("uint", "ZP_MODULE_DECAY", FAMILIES.flatMap(f => lab.MODULES[f].map(m => m.decay + "u")))}
#define ZP_FOREARM_MISSING ${lab.MODULES.forearm.findIndex(m => m.id === "missing")}u
#define ZP_THIGH_PANTS ${lab.MODULES.thigh.findIndex(m => m.id === "pants")}u
#define ZP_THIGH_SHORTS ${lab.MODULES.thigh.findIndex(m => m.id === "shorts")}u
#define ZP_SHIN_PANTS ${lab.MODULES.shin.findIndex(m => m.id === "pants")}u
#define ZP_SHIN_SKIN ${lab.MODULES.shin.findIndex(m => m.id === "skin")}u
#define ZP_ARM_SLEEVE 0u
#define ZP_UPPER_BARE ${lab.MODULES.upperArm.findIndex(m => m.id === "bare")}u
#define ZP_FORE_BARE ${lab.MODULES.forearm.findIndex(m => m.id === "bare")}u
// torso sleeve material: 0 cloth, 1 top2 (shirt), 2 skin
${arr("uint", "ZP_TORSO_SLEEVE", lab.MODULES.torso.map(m => ({ cloth: 0, top2: 1, skin: 2 })[m.sleeve] + "u"))}
// palettes (sRGB), exactly the Zombie Lab lists
${arr("vec3", "ZP_SKINS", lab.SKINS.map(hex))}
${arr("vec3", "ZP_TOPS", lab.TOPS.map(hex))}
${arr("vec3", "ZP_SHIRTS", lab.SHIRTS.map(hex))}
${arr("vec3", "ZP_PANTS", lab.PANTS.map(hex))}
${arr("vec3", "ZP_HAIRS", lab.HAIRS.map(hex))}
${arr("vec3", "ZP_TIES", lab.TIES.map(hex))}
${arr("vec3", "ZP_HATS", lab.HATS.map(hex))}
${arr("vec3", "ZP_SHOES", lab.SHOES.map(hex))}
// fixed materials: blood, bloodDark, gore, bone, boneDark, meat, meatDark, mouth, belt
${arr("vec3", "ZP_FIXED", ["blood", "bloodDark", "gore", "bone", "boneDark", "meat", "meatDark", "mouth", "belt"].map(k => hex(lab.FIXED[k])))}
// material tags
${TAGS.map((t, i) => `#define TAG_${t.replace(/[A-Z]/g, c => "_" + c).toUpperCase()} ${i}u`).join("\n")}
${arr("uint", "ZP_SEEDS", SEEDS.map(s => s + "u"))}
#endif
`;
fs.writeFileSync(path.join(ROOT, "shaders/include/zombie_parts.glsl"), g);

// ------------------------------------------------------------------ report
console.log(`source: ${path.relative(ROOT, SRC)}`);
console.log(`meshes: ${meshes.length} (${lab.SLOTS.length} slots, ${DECO_COUNT} decoration variants), all greedy and voxel-material meshes verified lossless`);
for (const l of LEVELS) {
  const s = stats.levels[l];
  console.log(`  ${l.padEnd(7)} ${String(s.triangles).padStart(7)} triangles, ${(s.bytes / 1024).toFixed(0)} KiB, family max vertices ${JSON.stringify(s.familyMaxVertices)}`);
}
console.log("  triangles per character (naive / culled / greedy / voxel):");
for (const [k, v] of Object.entries(stats.designs)) console.log(`    ${k.padEnd(7)} ${v.naive} / ${v.culled} / ${v.greedy} / ${v.voxel}`);
console.log(`wrote assets/characters/zombie_parts.ttzc (${buf.length} bytes), zombie_parts.json, shaders/include/zombie_parts.glsl`);
