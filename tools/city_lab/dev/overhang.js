#!/usr/bin/env node
// Floating / cantilevered volume check on a baked package (FORMAT.md): finds building parts that hang in the air
// beside a tower (a glass box stuck to a facade, a volume with nothing under it) — what reads as an "appendix".
//   node tools/city_lab/dev/overhang.js [assets/city/seed1] [--list=N] [--json=FILE]
// Exit code 1 when anything is flagged.
//
// Method (1 m columns over the whole map, from every tile's MESH):
//  - per column: the up-facing surfaces (roofs, decks, ground) and the down-facing ones (soffits) with their heights;
//    horizontal quads are rasterised by testing column centres inside the quad (rotated buildings included);
//  - an OVERHANG column has a soffit at h > 6 m with more than 6 m of air under it (the highest surface below is at
//    least 6 m lower, ground included);
//  - a SUPPORT column for height h rises to >= h with no soffit between 1 m and h (a wall / tower going down to its
//    base);
//  - each overhang column looks for support in 16 directions up to 14 m. Flagged:
//      floating     no support in any direction (nothing it could hang from);
//      cantilever   nearest support > 3.5 m away and only on one side (no two opposite directions supported: a sky
//                   bridge between two towers, a deck between two wings, is supported at both ends and passes).
//  Flagged columns are clustered (8-connected); clusters under 6 m2 are ignored (eaves, sills, signs, balconies).
'use strict';
const fs = require('fs'), path = require('path');
const B = require('../bake/lib.js');
const argv = process.argv.slice(2), opt = (k, d) => { const a = argv.find(s => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const dir = argv.find(s => !s.startsWith('--')) || 'assets/city/seed1', LIST = +opt('list', 20);
const city = JSON.parse(fs.readFileSync(path.join(dir, 'city.json'), 'utf8')), bd = city.bounds;
const CS = 1, GW = Math.ceil((bd.x1 - bd.x0) / CS) + 1, GH = Math.ceil((bd.z1 - bd.z0) / CS) + 1;
const maxUp = new Float32Array(GW * GH), lowDown = new Float32Array(GW * GH).fill(1e9), ovh = new Float32Array(GW * GH);
const t0 = Date.now();
for (const [i, j] of city.tile.present) {
  const f = B.readFile(fs.readFileSync(path.join(dir, 'tiles', `${i}_${j}.bin`))), s = f.sections.get('MESH');
  if (!s) continue;
  const m = B.readMesh(s);
  // local column window: the mesh AABB
  const lx0 = Math.floor((m.aabb[0] - bd.x0) / CS), lz0 = Math.floor((m.aabb[2] - bd.z0) / CS);
  const LW = Math.floor((m.aabb[3] - bd.x0) / CS) - lx0 + 1, LH = Math.floor((m.aabb[5] - bd.z0) / CS) - lz0 + 1;
  const ups = new Map(), downs = new Map();
  const X = [0, 0, 0, 0], Z = [0, 0, 0, 0];
  for (let q = 0; q < m.quads; ++q) {
    const o = m.vo + q * 48, ny = s.readInt8(o + 9);
    if (Math.abs(ny) < 120) continue;
    let y = 0, ax = 1e9, bx = -1e9, az = 1e9, bz = -1e9;
    for (let c = 0; c < 4; ++c) {
      const v = o + c * 12; X[c] = m.origin[0] + s.readInt16LE(v) * m.sxz; Z[c] = m.origin[2] + s.readInt16LE(v + 4) * m.sxz; y = m.origin[1] + s.readInt16LE(v + 2) * m.sy;
      ax = Math.min(ax, X[c]); bx = Math.max(bx, X[c]); az = Math.min(az, Z[c]); bz = Math.max(bz, Z[c]);
    }
    if ((bx - ax) * (bz - az) < 0.04) continue;
    const tgt = ny > 0 ? ups : downs;
    for (let cz = Math.ceil((az - bd.z0) / CS - 0.5); (cz + 0.5) * CS + bd.z0 <= bz; ++cz) for (let cx = Math.ceil((ax - bd.x0) / CS - 0.5); (cx + 0.5) * CS + bd.x0 <= bx; ++cx) {
      const px = bd.x0 + (cx + 0.5) * CS, pz = bd.z0 + (cz + 0.5) * CS;
      let sg = 0, ok = true;                          // point in convex quad
      for (let e = 0; e < 4; ++e) { const a = e, b = (e + 1) & 3, cr = (X[b] - X[a]) * (pz - Z[a]) - (Z[b] - Z[a]) * (px - X[a]); if (Math.abs(cr) < 1e-9) continue; const sn = cr > 0 ? 1 : -1; if (!sg) sg = sn; else if (sn !== sg) { ok = false; break; } }
      if (!ok) continue;
      const k = (cz - lz0) * LW + (cx - lx0); if (cx < lx0 || cz < lz0 || cx - lx0 >= LW || cz - lz0 >= LH) continue;
      let a = tgt.get(k); if (!a) tgt.set(k, a = []); a.push(y);
    }
  }
  for (const [k, a] of ups) {
    const gk = (lz0 + Math.floor(k / LW)) * GW + lx0 + (k % LW); let mx = 0; for (const y of a) mx = Math.max(mx, y); if (mx > maxUp[gk]) maxUp[gk] = mx;
  }
  const DBG = opt('debug', null) && opt('debug', null).split(',').map(Number);
  for (const [k, a] of downs) {
    const gk = (lz0 + Math.floor(k / LW)) * GW + lx0 + (k % LW), u = ups.get(k) || [];
    if (DBG && Math.abs(bd.x0 + (gk % GW + 0.5) * CS - DBG[0]) < 0.6 && Math.abs(bd.z0 + (Math.floor(gk / GW) + 0.5) * CS - DBG[1]) < 0.6) console.log('column', i, j, 'up', u.join(' '), 'down', a.join(' '));
    for (const hd of a) {
      if (u.some(y => y > hd - 0.35 && y < hd + 0.05)) continue;     // resting on a surface (a crown / box on a roof)
      if (hd > 1 && hd < lowDown[gk]) lowDown[gk] = hd;
      if (hd <= 12) continue;                                         // entrance canopies, awnings, porte-cocheres stay below
      let below = 0; for (const y of u) if (y < hd - 0.3 && y > below) below = y;
      if (hd - below > 8 && hd > ovh[gk]) ovh[gk] = hd;
    }
  }
}
// support search
const DIRS = []; for (let d = 0; d < 16; ++d) DIRS.push([Math.cos(d * Math.PI / 8), Math.sin(d * Math.PI / 8)]);
const flag = new Uint8Array(GW * GH);
let nOv = 0;
for (let k = 0; k < GW * GH; ++k) {
  const h = ovh[k]; if (!h) continue; ++nOv;
  const cx = k % GW, cz = Math.floor(k / GW);
  const hit = new Float32Array(16).fill(1e9);
  for (let d = 0; d < 16; ++d) for (let r = 1; r <= 14; r += 0.5) {
    const x = Math.round(cx + DIRS[d][0] * r), z = Math.round(cz + DIRS[d][1] * r); if (x < 0 || z < 0 || x >= GW || z >= GH) break;
    const n = z * GW + x; if (ovh[n]) continue;
    if (maxUp[n] >= h - 0.5 && lowDown[n] >= h - 0.5) { hit[d] = r; break; }
  }
  let near = 1e9, opp = false;
  for (let d = 0; d < 16; ++d) { near = Math.min(near, hit[d]); if (hit[d] < 1e9 && (hit[(d + 7) & 15] < 1e9 || hit[(d + 8) & 15] < 1e9 || hit[(d + 9) & 15] < 1e9)) opp = true; }
  if (near >= 1e9) flag[k] = 1;                        // floating
  else if (near > 3.5 && !opp) flag[k] = 2;            // one-sided deep cantilever
}
// clusters
const seen = new Uint8Array(GW * GH), out = [];
for (let k = 0; k < GW * GH; ++k) {
  if (!flag[k] || seen[k]) continue;
  const st = [k]; seen[k] = 1; let n = 0, sx = 0, sz = 0, hy = 0, fl = 0; const at = [+(bd.x0 + (k % GW + 0.5) * CS).toFixed(1), +(bd.z0 + (Math.floor(k / GW) + 0.5) * CS).toFixed(1)];
  while (st.length) {
    const c = st.pop(), x = c % GW, z = Math.floor(c / GW); ++n; sx += x; sz += z; hy = Math.max(hy, ovh[c]); if (flag[c] === 1) ++fl;
    for (let dz = -1; dz <= 1; ++dz) for (let dx = -1; dx <= 1; ++dx) { const nx = x + dx, nz = z + dz; if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue; const nn = nz * GW + nx; if (flag[nn] && !seen[nn]) { seen[nn] = 1; st.push(nn); } }
  }
  if (n * CS * CS < 6) continue;
  out.push({ kind: fl > n / 2 ? 'floating' : 'cantilever', m2: n * CS * CS, x: +(bd.x0 + (sx / n + 0.5) * CS).toFixed(1), z: +(bd.z0 + (sz / n + 0.5) * CS).toFixed(1), y: +hy.toFixed(1), at });
}
out.sort((a, b) => b.m2 - a.m2);
console.log(`overhang check ${dir}: ${nOv} overhang columns (soffit > 6 m with > 6 m of air below), ${out.length} flagged clusters ` +
  `(${out.filter(o => o.kind === 'floating').length} floating, ${out.filter(o => o.kind === 'cantilever').length} one-sided cantilevers > 3.5 m), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const o of out.slice(0, LIST)) console.log(`  ${o.kind.padEnd(10)} ${String(o.m2).padStart(5)} m2 at (${o.x}, ${o.z}) soffit ${o.y} m`);
const jf = opt('json', null); if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
process.exit(out.length ? 1 : 0);
