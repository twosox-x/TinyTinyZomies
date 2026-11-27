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
 *   assets/military/anims.bin     + anims.json    (clips, docs/MILITARY_ANIMS.md)
 *   assets/military/specialists.ttzm      + specialists.json       (Phase 7b: engineers, flamethrowers, tools, site props)
 *   assets/military/specialist_anims.bin  + specialist_anims.json  (Phase 7b clips; same TTZA format + tool / stow flags)
 * The v1 files (infantry, props, anims) are written exactly as before (v1 palette only: PAL_V1_COUNT entries), so they
 * stay byte-identical to the approved assets; the specialists live in their own files.
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
;({ buildAll, buildAnims, PALETTE, PAL, partFaces, quadsCulled, quadsGreedy, rigidGroup, DIRS, CORN, V_M, PROP_M, SLOTS, PIVOT, HAND, MIL_VERSION,
     ANIM_VERSION, ANIM_HZ, BODY_STRIDE, CANOPY_STRIDE, CRATE_STRIDE, HAND_ITEM, ANIM_CLASSES,
     WEAPON_STRIDE, FLAG_DROPPED, posedBodyCells, posedMinY, weaponCells, fk, eulerMat, mvec, vadd, mmul,
     PAL_V1_COUNT, buildSpecialists, buildSpecialistAnims, FLAG_STOWED, TOOL_SHIFT, TOOL_ID, SPEC_CLASSES, stowPlacement, toolCells, limbIntrusion, LIMB_TOL })`, sandbox, { filename: "military_lab_v1.html" });

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
function bake(models, file, isInfAll, palette) {
  const verts = [];
  const outModels = [];
  const stats = [];
  const allProblems = [];
  for (const m of models) {
    const isInf = isInfAll === "auto" ? m.kind === "infantry" : isInfAll;
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
    const sub = isInf ? lib.V_M / 4 : (m.checkSub || lib.PROP_M);
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
    if (m.extra) Object.assign(entry, m.extra);
    outModels.push(entry);
    stats.push(`${m.name.padEnd(28)} ${String(m.parts.length).padStart(2)} parts ${String(tri).padStart(6)} tris (culled ${culledTri})`);
  }
  if (allProblems.length) { console.error(allProblems.join("\n")); throw new Error(`${file}: ${allProblems.length} model(s) failed the rest-pose checks`); }
  // palette: only real entries (the Lab registers its reference-zombie colours outside the library); the v1 files
  // carry the v1 palette (PAL_V1_COUNT entries), the specialists file the full library palette
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

const PAL_V1 = lib.PALETTE.slice(0, lib.PAL_V1_COUNT);
bake(infantry, "infantry", true, PAL_V1);
bake(props, "props", false, PAL_V1);
bakeAnims(infantry);
const SPEC = lib.buildSpecialists();
bake([...SPEC.soldiers, ...SPEC.tools, ...SPEC.props], "specialists", "auto", lib.PALETTE);
bakeSpecialistAnims(SPEC);

// ------------------------------------------------------------------ animations (docs/MILITARY_ANIMS.md)
function bakeAnims(infantry) {
  const A = lib.buildAnims(infantry);
  const floats = [];
  const f6 = x => Math.round(x * 1e6) / 1e6;
  const clips = A.clips.map(c => {
    const tracks = [];
    const push = (type, stride, frames) => { if (!frames) return; tracks.push({ type, offset: floats.length, stride, frames: frames.length }); for (const fr of frames) { if (fr.length !== stride) throw new Error(`${c.name}: ${type} stride`); for (const v of fr) { if (!Number.isFinite(v)) throw new Error(`${c.name}: non-finite value`); floats.push(v); } } };
    push("body", lib.BODY_STRIDE, c.gen ? c.body : null);
    push("canopy", lib.CANOPY_STRIDE, c.canopy);
    push("crate", lib.CRATE_STRIDE, c.crate);
    push("weapon", lib.WEAPON_STRIDE, c.weapon);
    if (c.weapon) checkDeath(c);
    const out = { name: c.name, class: c.cls, action: c.action, duration: c.duration, frames: c.frames, loop: !!c.loop, rootMotion: !!c.rootMotion };
    for (const k of ["speed", "stride", "descentSpeed", "rate", "stairs", "phase0"]) if (c[k] !== undefined) out[k] = c[k];
    if (c.delta) out.delta = c.delta;
    out.events = (c.events || []).map(e => Object.assign({}, e, { t: f6(e.t) })).sort((a, b) => a.t - b.t);
    out.tracks = tracks;
    out.check = c.stats;
    return out;
  });
  const head = new Uint32Array(8); head[0] = 0x415A5454; head[1] = lib.ANIM_VERSION; head[2] = floats.length; head[3] = clips.length; head[4] = lib.ANIM_HZ;
  const buf = Buffer.concat([Buffer.from(head.buffer), Buffer.from(Float32Array.from(floats).buffer)]);
  fs.writeFileSync(path.join(ROOT, "assets/military/anims.bin"), buf);
  const vrr = v => v.map(r6);
  const manifest = { format: "TTZA", version: lib.ANIM_VERSION, source: path.relative(ROOT, SRC), doc: "docs/MILITARY_ANIMS.md", sampleRate: lib.ANIM_HZ,
    strides: { body: lib.BODY_STRIDE, canopy: lib.CANOPY_STRIDE, crate: lib.CRATE_STRIDE, weapon: lib.WEAPON_STRIDE }, dataOffsetBytes: 32, floatCount: floats.length,
    slots: lib.SLOTS, handItems: lib.HAND_ITEM, classes: lib.ANIM_CLASSES,
    classModels: { rifleman: infantry.filter(m => m.cls === "rifleman").map(m => m.name), mg: infantry.filter(m => m.cls === "mg").map(m => m.name), sniper: infantry.filter(m => m.cls === "sniper").map(m => m.name), crate: ["crate_ammo_drop", "para_cargo"] },
    slungMount: Object.fromEntries(Object.entries(A.slung).map(([k, p]) => [k, { part: "torso", gripFromTorsoPivot: vrr(p.gripT.map(v => v * lib.V_M)), rot: vrr(matEulerJS(p.W)) }])),
    weaponPoints: Object.fromEntries(Object.entries(A.rigs).map(([k, r]) => [k, Object.fromEntries(Object.entries(r).filter(([n, v]) => Array.isArray(v)).map(([n, v]) => [n, vrr(v.map(x => x * lib.V_M))]))])),
    transitions: A.transitions, fx: A.fx, clips };
  fs.writeFileSync(path.join(ROOT, "assets/military/anims.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`\nanims: ${clips.length} clips, ${floats.length} floats, ${buf.length} bytes`);
  for (const c of clips) console.log(`  ${c.name.padEnd(28)} ${c.duration.toFixed(2).padStart(5)} s ${c.loop ? "loop" : "once"} ${String(c.frames).padStart(4)} fr  sup ${c.check.supportError} m  minY ${c.check.minY}${c.check.weaponGap !== undefined ? `  weapon gap ${c.check.weaponGap} m, weapon minY ${c.check.weaponMinY}, rest body minY ${c.check.restMinY}` : ""}`);
}
// Death clips with a dropped weapon (docs/MILITARY_ANIMS.md 2.5), checked on the exported frames:
//   - the body never below the ground at rest (full voxel set of the last frame, tolerance 1 cm)
//   - after weapon_drop no weapon voxel below the ground on any frame
//   - at rest the weapon lies flat (side down) BESIDE the body: >= 2 cm from every body voxel in the ground plane (so
//     never under the raised back / a limb, never through the body)
function checkDeath(c, models) {
  const model = (models || infantry).find(m => m.cls === c.cls), V = lib.V_M, n = c.body.length;
  const ev = (c.events || []).find(e => e.type === "weapon_drop");
  if (!ev) throw new Error(`${c.name}: weapon track without a weapon_drop event`);
  const WC = c.dropTool ? lib.toolCells(c.dropTool) : lib.weaponCells(model), bad = [];
  const pose = fr => { const rot = {}; lib.SLOTS.forEach((s, i) => rot[s] = [fr[i * 3], fr[i * 3 + 1], fr[i * 3 + 2]]); return { rot, rootPos: [fr[30] / V, fr[31] / V, fr[32] / V], rootRot: [fr[33], fr[34], fr[35]] }; };
  const wPlace = w => ({ pos: [w[0] / V, w[1] / V, w[2] / V], R: lib.eulerMat([w[3], w[4], w[5]]) });
  const cellsAt = P => WC.cells.map(q => lib.vadd(P.pos, lib.mvec(P.R, q)));
  let weaponMinY = Infinity;
  for (let f = Math.round(ev.t * lib.ANIM_HZ); f < n; f++) {
    if (!(c.body[f][43] & lib.FLAG_DROPPED)) bad.push(`frame ${f}: dropped flag missing`);
    const P = wPlace(c.weapon[f]), ext = WC.h * (Math.abs(P.R[3]) + Math.abs(P.R[4]) + Math.abs(P.R[5]));
    for (const q of cellsAt(P)) weaponMinY = Math.min(weaponMinY, (q[1] - ext) * V);
  }
  if (weaponMinY < -0.002) bad.push(`weapon below ground after the drop (${weaponMinY.toFixed(3)} m)`);
  const L = pose(c.body[n - 1]);
  const bodyMin = lib.posedMinY(model, L.rot, L.rootRot, L.rootPos, null, "dropped", true) * V;
  if (bodyMin < -0.01) bad.push(`body below ground at rest (${bodyMin.toFixed(3)} m)`);
  const body = lib.posedBodyCells(model, L.rot, L.rootRot, L.rootPos), P = wPlace(c.weapon[n - 1]);
  let gap = Infinity;
  for (const q of cellsAt(P)) for (const b of body) gap = Math.min(gap, (Math.hypot(q[0] - b.p[0], q[2] - b.p[2]) - WC.h * 1.2 - b.h * 1.2) * V);   // ground plane
  if (gap < 0.02) bad.push(`weapon at rest under / touching the body (ground-plane gap ${gap.toFixed(3)} m)`);
  if (c.dropUpright ? Math.abs(P.R[4] - 1) > 0.05 : Math.abs(Math.abs(P.R[3]) - 1) > 0.05) bad.push(`weapon at rest not flat (side axis y ${P.R[3].toFixed(2)})`);
  if (bad.length) throw new Error(`${c.name}: ${bad.join("; ")}`);
  c.stats.weaponMinY = +weaponMinY.toFixed(3); c.stats.weaponGap = +gap.toFixed(3); c.stats.restMinY = +bodyMin.toFixed(3);
}
// ------------------------------------------------------------------ specialist clips (docs/MILITARY_ANIMS.md §7)
function bakeSpecialistAnims(SPEC) {
  const soldiers = SPEC.soldiers;
  const A = lib.buildSpecialistAnims(soldiers);
  const floats = [];
  const f6 = x => Math.round(x * 1e6) / 1e6;
  const clips = A.clips.map(c => {
    const tracks = [];
    const push = (type, stride, frames) => { if (!frames) return; tracks.push({ type, offset: floats.length, stride, frames: frames.length }); for (const fr of frames) { if (fr.length !== stride) throw new Error(`${c.name}: ${type} stride`); for (const v of fr) { if (!Number.isFinite(v)) throw new Error(`${c.name}: non-finite value`); floats.push(v); } } };
    push("body", lib.BODY_STRIDE, c.body);
    push("canopy", lib.CANOPY_STRIDE, c.canopy);
    push("weapon", lib.WEAPON_STRIDE, c.weapon);
    if (c.weapon) checkDeath(c, soldiers);
    checkTools(c);
    if (c.avoid) checkLimbs(c, soldiers);
    const out = { name: c.name, class: c.cls, action: c.action, duration: c.duration, frames: c.frames, loop: !!c.loop, rootMotion: !!c.rootMotion };
    for (const k of ["speed", "stride", "descentSpeed", "rate", "stairs", "phase0", "stream", "work", "carry", "dropTool", "toolGround", "avoid"]) if (c[k] !== undefined) out[k] = c[k];
    if (c.delta) out.delta = c.delta;
    out.events = (c.events || []).map(e => Object.assign({}, e, { t: f6(e.t) })).sort((a, b) => a.t - b.t);
    out.tracks = tracks;
    out.check = c.stats;
    return out;
  });
  const head = new Uint32Array(8); head[0] = 0x415A5454; head[1] = lib.ANIM_VERSION; head[2] = floats.length; head[3] = clips.length; head[4] = lib.ANIM_HZ;
  const buf = Buffer.concat([Buffer.from(head.buffer), Buffer.from(Float32Array.from(floats).buffer)]);
  fs.writeFileSync(path.join(ROOT, "assets/military/specialist_anims.bin"), buf);
  const vrr = v => v.map(r6);
  const place = p => ({ part: "torso", gripFromTorsoPivot: vrr(p.gripT.map(v => v * lib.V_M)), rot: vrr(matEulerJS(p.W)) });
  const manifest = { format: "TTZA", version: lib.ANIM_VERSION, source: path.relative(ROOT, SRC), doc: "docs/MILITARY_ANIMS.md (section 7: specialists)", models: "assets/military/specialists.json", sampleRate: lib.ANIM_HZ,
    strides: { body: lib.BODY_STRIDE, canopy: lib.CANOPY_STRIDE, weapon: lib.WEAPON_STRIDE }, dataOffsetBytes: 32, floatCount: floats.length,
    slots: lib.SLOTS, handItems: lib.HAND_ITEM, flags: { stowed: lib.FLAG_STOWED, toolShift: lib.TOOL_SHIFT, toolMask: 15 }, tools: Object.fromEntries(Object.entries(lib.TOOL_ID).map(([k, v]) => [v, "tool_" + k])),
    classes: lib.SPEC_CLASSES, classModels: Object.fromEntries(lib.SPEC_CLASSES.map(k => [k, soldiers.filter(m => m.cls === k).map(m => m.name)])),
    slungMount: Object.fromEntries(Object.entries(A.slung).map(([k, p]) => [k, place(p)])),
    stowMount: Object.fromEntries(Object.entries(A.stow).map(([k, p]) => [k, place(p)])),
    weaponPoints: Object.fromEntries(Object.entries(A.rigs).map(([k, r]) => [k, Object.fromEntries(Object.entries(r).filter(([n, v]) => Array.isArray(v)).map(([n, v]) => [n, vrr(v.map(x => x * lib.V_M))]))])),
    transitions: A.transitions, fx: A.fx, clips };
  fs.writeFileSync(path.join(ROOT, "assets/military/specialist_anims.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`\nspecialist anims: ${clips.length} clips, ${floats.length} floats, ${buf.length} bytes`);
  for (const c of clips) console.log(`  ${c.name.padEnd(30)} ${c.duration.toFixed(2).padStart(5)} s ${c.loop ? "loop" : "once"} ${String(c.frames).padStart(4)} fr  sup ${c.check.supportError} m  minY ${c.check.minY}  slide ${c.check.footSlide}${c.check.toolMinY !== undefined ? `  toolMinY ${c.check.toolMinY}` : ""}${c.check.limbPen !== undefined ? `  limb ${c.check.limbPen} m` : ""}${c.check.weaponGap !== undefined ? `  drop gap ${c.check.weaponGap} m, drop minY ${c.check.weaponMinY}, rest body minY ${c.check.restMinY}` : ""}`);
}
// work / carry clips (field avoid): hands, forearms and the held tool never penetrate the head, helmet, torso or torso
// gear, on every frame. Voxel-pair inscribed-sphere test (limbIntrusion in the Lab library); tolerance: faces touching
// (1 cm) for head / helmet / torso, 3 cm grazing for soft torso gear (pouches, pack; Stage A clips graze up to 3.7 cm).
function checkLimbs(c, soldiers) {
  const byId = Object.fromEntries(Object.entries(lib.TOOL_ID).map(([k, v]) => [v, k])), V = lib.V_M;
  let raw = 0;
  for (const m of soldiers.filter(x => x.cls === c.cls)) c.body.forEach((fr, f) => {
    const id = (fr[43] >> lib.TOOL_SHIFT) & 15, r = lib.limbIntrusion(m, fr, id ? byId[id] : null);
    raw = Math.max(raw, r.raw);
    if (r.pen > 1e-3) throw new Error(`${c.name} (${m.name}) frame ${f}: ${r.at} interpenetration ${(r.pen * V).toFixed(3)} m beyond tolerance`);
  });
  c.stats.limbPen = +(raw * V).toFixed(3);
}
// tool clips: the tool id in the flags must be a known tool, the weapon must be stowed while a tool is held, and the held
// tool's lowest voxel is reported (toolMinY; only the shovel / sledgehammer touch the ground: digging / striking, >= -5 cm)
function checkTools(c) {
  const V = lib.V_M, ids = new Set(Object.values(lib.TOOL_ID)), byId = Object.fromEntries(Object.entries(lib.TOOL_ID).map(([k, v]) => [v, k]));
  let toolMin = Infinity, any = false;
  for (let f = 0; f < c.body.length; f++) {
    const fr = c.body[f], id = (fr[43] >> lib.TOOL_SHIFT) & 15;
    if (!id) continue; any = true;
    if (!ids.has(id)) throw new Error(`${c.name}: unknown tool id ${id}`);
    if (!(fr[43] & lib.FLAG_STOWED)) throw new Error(`${c.name}: tool held but the weapon is not stowed (frame ${f})`);
    if (fr[43] & lib.FLAG_DROPPED) continue;
    const rot = {}; lib.SLOTS.forEach((s, i) => rot[s] = [fr[i * 3], fr[i * 3 + 1], fr[i * 3 + 2]]);
    const F = lib.fk(rot), R0 = lib.eulerMat([fr[33], fr[34], fr[35]]), rp = [fr[30] / V, fr[31] / V, fr[32] / V];
    const hand = lib.vadd(F.forearmR.pos, lib.mvec(F.forearmR.R, [0, -3.5, 0])), Wt = lib.mmul(R0, lib.mmul(F.forearmR.R, lib.eulerMat([fr[36], fr[37], fr[38]])));
    const o = lib.vadd(rp, lib.mvec(R0, hand)), TC = lib.toolCells(byId[id]);
    for (const q of TC.cells) { const y = (o[1] + lib.mvec(Wt, q)[1] - TC.h) * V; if (y < toolMin) toolMin = y; }
  }
  if (any && toolMin !== Infinity) {
    c.stats.toolMinY = +toolMin.toFixed(3);
    if (toolMin < -(c.toolGround || 0.05)) throw new Error(`${c.name}: held tool ${toolMin.toFixed(3)} m below the ground`);
  }
}
function matEulerJS(m) { const b = Math.asin(Math.max(-1, Math.min(1, m[2]))); let a, c; if (Math.abs(m[2]) < 0.9999999) { a = Math.atan2(-m[5], m[8]); c = Math.atan2(-m[1], m[0]); } else { a = Math.atan2(m[7], m[4]); c = 0; } return [a, b, c]; }
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s; all greedy meshes verified lossless; rest-pose float / coplanar checks passed`);
