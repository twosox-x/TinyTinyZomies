// Tile LODs from a baked MESH section (FORMAT.md 2/3), used by bake.js and relod.js:
//  - relodMesh(MESH): the same quads reordered for the stricter LOD1 (drops details whose longest edge < 1 m; upward
//    quads use v1's 0.35 m rule so ground and roofs stay closed; road raster / curb / sidewalk quads are always kept).
//  - lod2Mesh(MESH): far LOD, a 2.5D block model of the tile: tops rasterised at 0.5 m, reduced to 2 m cells (median
//    height, majority material), greedy-merged rectangles; walls between cells of different height with facade
//    materials sampled per 3 m storey band (majority of the facade quads behind the edge: brick / lit windows / glass),
//    merged along runs. No props / vehicles. ~1-8 k triangles per tile.
'use strict';
const B = require('./lib.js');

const L1_EDGE = 1.0;            // m: LOD1 keeps quads whose longest edge is >= this
const L1_GROUND = 0.35;         // m: same for upward quads (road raster / roof pieces: v1's LOD1 rule, no big holes)
// Road raster materials (palette ids: asphalt .. park path, parking, crosswalk, drive, plot overlays) are always kept in
// LOD1: dropping their small pieces / vertical curb faces opened dashed gaps along every kerb at distance.
const isRaster = (m) => m <= 18 || m === 23 || m === 24 || m === 29 || (m >= 30 && m <= 53);
const C = 2.0, S = 0.5, SUB = C / S, BAND = 3.0;   // LOD2 cell, top sample step, facade band height (m)
const MIN_WALL = 0.3;           // m: height steps below this get no wall (curbs)

function quadsOf(buf) {
  const m = B.readMesh(buf), Q = m.quads, P = new Float32Array(Q * 12), N = new Float32Array(Q * 3), M = new Uint8Array(Q);
  for (let q = 0; q < Q; ++q) {
    for (let c = 0; c < 4; ++c) {
      const o = m.vo + (q * 4 + c) * 12;
      P[q * 12 + c * 3] = m.origin[0] + buf.readInt16LE(o) * m.sxz;
      P[q * 12 + c * 3 + 1] = m.origin[1] + buf.readInt16LE(o + 2) * m.sy;
      P[q * 12 + c * 3 + 2] = m.origin[2] + buf.readInt16LE(o + 4) * m.sxz;
    }
    const o = m.vo + q * 48;
    N[q * 3] = buf.readInt8(o + 8) / 127; N[q * 3 + 1] = buf.readInt8(o + 9) / 127; N[q * 3 + 2] = buf.readInt8(o + 10) / 127; M[q] = buf[o + 11];
  }
  return { m, Q, P, N, M };
}

function relodMesh(buf) {
  const { m, Q, P, N, M } = quadsOf(buf);
  const keep = new Uint8Array(Q); let K = 0;
  const l2 = L1_EDGE * L1_EDGE, G2 = L1_GROUND * L1_GROUND;
  for (let q = 0; q < Q; ++q) {
    const o = q * 12, d = (a, b) => { const x = P[o + b * 3] - P[o + a * 3], y = P[o + b * 3 + 1] - P[o + a * 3 + 1], z = P[o + b * 3 + 2] - P[o + a * 3 + 2]; return x * x + y * y + z * z; };
    // upward quads (road raster, markings, decks, roofs) use the finer rule: no big holes in ground or roofs
    const ground = N[q * 3 + 1] > 0.9, e2 = Math.max(d(0, 1), d(1, 2));
    if (isRaster(M[q]) || e2 >= (ground ? G2 : l2)) { keep[q] = 1; ++K; }
  }
  const out = Buffer.from(buf); let w = m.vo;
  for (const pass of [1, 0]) for (let q = 0; q < Q; ++q) if (keep[q] === pass) { buf.copy(out, w, m.vo + q * 48, m.vo + q * 48 + 48); w += 48; }
  out.writeUInt32LE(K, 36);
  return out;
}

function lod2Mesh(buf) {
  const { m, Q, P, N, M } = quadsOf(buf);
  if (!Q) return null;
  // cell grid aligned to the tile corner (origin = tile centre), so neighbouring tiles' cells meet without gaps
  const tx0 = m.origin[0] - 64, tz0 = m.origin[2] - 64;
  const bx0 = tx0 - Math.max(0, Math.ceil((tx0 - m.aabb[0]) / C)) * C, bz0 = tz0 - Math.max(0, Math.ceil((tz0 - m.aabb[2]) / C)) * C;
  const nx = Math.ceil((m.aabb[3] - bx0) / C) + 1, nz = Math.ceil((m.aabb[5] - bz0) / C) + 1;
  const sx = nx * SUB, sz = nz * SUB;
  const top = new Float32Array(sx * sz).fill(-1e9), tmat = new Uint8Array(sx * sz);
  const facade = new Map();       // (cell * 64 + band) -> Map(material -> area)
  const addF = (cx, cz, band, mat, a) => {
    if (cx < 0 || cz < 0 || cx >= nx || cz >= nz || band < 0 || band > 63) return;
    const k = (cz * nx + cx) * 64 + band; let e = facade.get(k); if (!e) facade.set(k, e = new Map());
    e.set(mat, (e.get(mat) || 0) + a);
  };
  for (let q = 0; q < Q; ++q) {
    const o = q * 12, ny = N[q * 3 + 1];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let c = 0; c < 4; ++c) { const x = P[o + c * 3], y = P[o + c * 3 + 1], z = P[o + c * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (ny > 0.3) {
      // upward: samples at cell centres inside the quad's xz box (quads are rectangles; sloped ones: plane height)
      const i0 = Math.ceil((x0 - bx0) / S - 0.5), i1 = Math.floor((x1 - bx0) / S - 0.5), k0 = Math.ceil((z0 - bz0) / S - 0.5), k1 = Math.floor((z1 - bz0) / S - 0.5);
      const nxq = N[q * 3], nzq = N[q * 3 + 2], px = P[o], py = P[o + 1], pz = P[o + 2];
      for (let k = Math.max(0, k0); k <= Math.min(sz - 1, k1); ++k) for (let i = Math.max(0, i0); i <= Math.min(sx - 1, i1); ++i) {
        const X = bx0 + (i + 0.5) * S, Z = bz0 + (k + 0.5) * S, y = py - (nxq * (X - px) + nzq * (Z - pz)) / ny;
        const s = k * sx + i;
        if (y > top[s]) { top[s] = y; tmat[s] = M[q]; }
      }
    } else if (Math.abs(ny) < 0.3) {
      // facade: credit the cell behind the face, per band, by area
      const nxq = N[q * 3], nzq = N[q * 3 + 2], cxm = (x0 + x1) / 2 - nxq * 0.3, czm = (z0 + z1) / 2 - nzq * 0.3;
      const along = Math.abs(nxq) > Math.abs(nzq) ? [z0, z1] : [x0, x1], len = along[1] - along[0];
      const steps = Math.max(1, Math.ceil(len / C));
      for (let s = 0; s < steps; ++s) {
        const t = along[0] + (s + 0.5) * len / steps;
        const cx = Math.floor(((Math.abs(nxq) > Math.abs(nzq) ? cxm : t) - bx0) / C), cz = Math.floor(((Math.abs(nxq) > Math.abs(nzq) ? t : czm) - bz0) / C);
        for (let b = Math.max(0, Math.floor(y0 / BAND)); b <= Math.floor((y1 - 1e-3) / BAND); ++b) {
          const ov = Math.min(y1, (b + 1) * BAND) - Math.max(y0, b * BAND);
          if (ov > 0) addF(cx, cz, b, M[q], ov * len / steps);
        }
      }
    }
  }
  // cells: median height of the samples (empty if more than half missing), majority material near it
  const H = new Float32Array(nx * nz).fill(NaN), T = new Uint8Array(nx * nz);
  const hs = [], cnt = new Map();
  for (let cz = 0; cz < nz; ++cz) for (let cx = 0; cx < nx; ++cx) {
    hs.length = 0;
    for (let k = 0; k < SUB; ++k) for (let i = 0; i < SUB; ++i) { const s = (cz * SUB + k) * sx + cx * SUB + i; if (top[s] > -1e8) hs.push(s); }
    if (hs.length * 2 <= SUB * SUB) continue;
    hs.sort((a, b) => top[a] - top[b]);
    let h = top[hs[Math.floor(hs.length / 2)]];
    cnt.clear(); let best = -1, bm = 0;
    for (const s of hs) if (Math.abs(top[s] - h) < 0.75) { const c = (cnt.get(tmat[s]) || 0) + 1; cnt.set(tmat[s], c); if (c > best) { best = c; bm = tmat[s]; } }
    h = h < 1 ? Math.round(h * 20) / 20 : Math.round(h * 2) / 2;
    H[cz * nx + cx] = h; T[cz * nx + cx] = bm;
  }
  const pos = [], mat = [], nvec = [];
  const quad = (pts, n, mm) => {   // pts: 4 corners [x,y,z]; reorder to CCW about n
    const a = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]], b = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
    const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) pts = [pts[0], pts[3], pts[2], pts[1]];
    for (const p of pts) { pos.push(p[0], p[1], p[2]); mat.push(mm); nvec.push(n[0], n[1], n[2]); }
  };
  // tops: greedy rectangles of equal (height, material)
  const used = new Uint8Array(nx * nz);
  for (let cz = 0; cz < nz; ++cz) for (let cx = 0; cx < nx; ++cx) {
    const c0 = cz * nx + cx; if (used[c0] || isNaN(H[c0])) continue;
    const h = H[c0], t = T[c0], same = (c) => !used[c] && H[c] === h && T[c] === t;
    let w = 1; while (cx + w < nx && same(c0 + w)) ++w;
    let d = 1; outer: while (cz + d < nz) { for (let k = 0; k < w; ++k) if (!same(c0 + d * nx + k)) break outer; ++d; }
    for (let k = 0; k < d; ++k) for (let i = 0; i < w; ++i) used[c0 + k * nx + i] = 1;
    const X0 = bx0 + cx * C, X1 = X0 + w * C, Z0 = bz0 + cz * C, Z1 = Z0 + d * C;
    quad([[X0, h, Z0], [X0, h, Z1], [X1, h, Z1], [X1, h, Z0]], [0, 1, 0], t);
  }
  // facade material of cell c, band b (falls back to nearby bands / neighbour cells / the cell's top)
  const fmat = (cx, cz, b) => {
    for (const r of [0, 1]) for (const db of [0, -1, 1, -2, 2]) for (let dz = -r; dz <= r; ++dz) for (let dx = -r; dx <= r; ++dx) {
      if (r && !dx && !dz) continue;
      const X = cx + dx, Z = cz + dz; if (X < 0 || Z < 0 || X >= nx || Z >= nz || b + db < 0) continue;
      const e = facade.get((Z * nx + X) * 64 + b + db); if (!e) continue;
      let best = -1, bm = 0; for (const [k, v] of e) if (v > best || (v === best && k < bm)) { best = v; bm = k; }
      return bm;
    }
    return T[cz * nx + cx];
  };
  // walls: for each cell edge, from the lower neighbour (empty = 0) up to the higher cell, banded; merged along runs
  const hAt = (cx, cz) => (cx < 0 || cz < 0 || cx >= nx || cz >= nz || isNaN(H[cz * nx + cx])) ? 0 : H[cz * nx + cx];
  for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const alongX = dir[0] === 0;       // edge runs along x when the normal is along z
    const nLines = alongX ? nz : nx, nAlong = alongX ? nx : nz;
    for (let line = 0; line < nLines; ++line) {
      let run = null;
      const flush = () => {
        if (!run) return;
        const { a0, a1, lo, hi, mats } = run;
        // the wall plane: on the far side of the cell in the direction of the normal
        const plane = alongX ? bz0 + (line + (dir[1] > 0 ? 1 : 0)) * C : bx0 + (line + (dir[0] > 0 ? 1 : 0)) * C;
        const A0 = (alongX ? bx0 : bz0) + a0 * C, A1 = (alongX ? bx0 : bz0) + a1 * C;
        let y = lo, k = 0;
        while (k < mats.length) {
          let k2 = k; while (k2 + 1 < mats.length && mats[k2 + 1] === mats[k]) ++k2;
          const yTop = Math.min(hi, (Math.floor(lo / BAND) + k2 + 1) * BAND);
          if (yTop > y) {
            const pt = (a, yy) => alongX ? [a, yy, plane] : [plane, yy, a];
            quad([pt(A0, y), pt(A1, y), pt(A1, yTop), pt(A0, yTop)], [dir[0], 0, dir[1]], mats[k]);
          }
          y = yTop; k = k2 + 1;
        }
        run = null;
      };
      for (let a = 0; a < nAlong; ++a) {
        const cx = alongX ? a : line, cz = alongX ? line : a;
        const h = hAt(cx, cz), hn = hAt(cx + dir[0], cz + dir[1]);
        if (isNaN(H[cz * nx + cx]) || h - hn < MIN_WALL) { flush(); continue; }
        const mats = [];
        for (let b = Math.floor(hn / BAND); b * BAND < h; ++b) mats.push(fmat(cx, cz, b));
        if (run && run.a1 === a && run.lo === hn && run.hi === h && run.mats.length === mats.length && run.mats.every((v, i) => v === mats[i])) { run.a1 = a + 1; continue; }
        flush();
        run = { a0: a, a1: a + 1, lo: hn, hi: h, mats };
      }
      flush();
    }
  }
  const quads = pos.length / 12;
  if (!quads) return null;
  return B.meshSection([{ pos: Float32Array.from(pos), mat: Uint8Array.from(mat), nvec: Float32Array.from(nvec), quads, unit: 1 }], 'auto', 'auto', m.origin.slice());
}

// ---- sub-tile chunks (FORMAT.md 3, CHNK): MESH quads sorted by a CH_N x CH_N grid of CH_SIZE m cells from the tile
// corner (a quad goes to the chunk of its centre, clamped to the grid), LOD1 quads first inside each chunk; per chunk
// {firstQuad, lod1Quads, quads, aabb}.
const CH_N = 4, CH_SIZE = 32, CH_REC = 40, CH_HEAD = 24;
function readChunks(chnk) {
  const n = chnk.readUInt32LE(0), out = [];
  for (let c = 0; c < n; ++c) { const o = CH_HEAD + c * CH_REC; out.push({ first: chnk.readUInt32LE(o), n1: chnk.readUInt32LE(o + 4), n0: chnk.readUInt32LE(o + 8),
    bmin: [0, 1, 2].map(k => chnk.readFloatLE(o + 16 + 4 * k)), bmax: [0, 1, 2].map(k => chnk.readFloatLE(o + 28 + 4 * k)) }); }
  return { n, nx: chnk.readUInt32LE(4), nz: chnk.readUInt32LE(8), size: chnk.readFloatLE(12), x0: chnk.readFloatLE(16), z0: chnk.readFloatLE(20), chunks: out };
}
// chunk-ordered MESH -> v1 order (all LOD1 quads first), so relodMesh / lod2Mesh / chunkMesh can run again
function unchunkMesh(mesh, chnk) {
  const m = B.readMesh(mesh), out = Buffer.from(mesh), { chunks } = readChunks(chnk);
  let w = m.vo;
  for (const pass of [1, 0]) for (const c of chunks) {
    const a = pass ? c.first : c.first + c.n1, b = pass ? c.first + c.n1 : c.first + c.n0;
    mesh.copy(out, w, m.vo + a * 48, m.vo + b * 48); w += (b - a) * 48;
  }
  out.writeUInt32LE(m.flags & ~2, 12);
  return out;
}
function chunkMesh(mesh) {
  const m = B.readMesh(mesh), Q = m.quads, x0 = m.origin[0] - 64, z0 = m.origin[2] - 64, NC = CH_N * CH_N;
  const lists = [...Array(NC)].map(() => [[], []]);
  const box = [...Array(NC)].map(() => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let q = 0; q < Q; ++q) {
    let sx = 0, sz = 0; const P = [];
    for (let c = 0; c < 4; ++c) {
      const o = m.vo + (q * 4 + c) * 12, x = m.origin[0] + mesh.readInt16LE(o) * m.sxz, y = m.origin[1] + mesh.readInt16LE(o + 2) * m.sy, z = m.origin[2] + mesh.readInt16LE(o + 4) * m.sxz;
      sx += x; sz += z; P.push(x, y, z);
    }
    const cx = Math.min(CH_N - 1, Math.max(0, Math.floor((sx / 4 - x0) / CH_SIZE))), cz = Math.min(CH_N - 1, Math.max(0, Math.floor((sz / 4 - z0) / CH_SIZE)));
    const c = cz * CH_N + cx, b = box[c];
    lists[c][q < m.lod1Quads ? 0 : 1].push(q);
    for (let k = 0; k < 12; k += 3) { b[0] = Math.min(b[0], P[k]); b[1] = Math.min(b[1], P[k + 1]); b[2] = Math.min(b[2], P[k + 2]); b[3] = Math.max(b[3], P[k]); b[4] = Math.max(b[4], P[k + 1]); b[5] = Math.max(b[5], P[k + 2]); }
  }
  const out = Buffer.from(mesh), ch = Buffer.alloc(CH_HEAD + NC * CH_REC);
  ch.writeUInt32LE(NC, 0); ch.writeUInt32LE(CH_N, 4); ch.writeUInt32LE(CH_N, 8); ch.writeFloatLE(CH_SIZE, 12); ch.writeFloatLE(x0, 16); ch.writeFloatLE(z0, 20);
  let w = 0;
  for (let c = 0; c < NC; ++c) {
    const o = CH_HEAD + c * CH_REC, [l1, l0] = lists[c];
    ch.writeUInt32LE(w, o); ch.writeUInt32LE(l1.length, o + 4); ch.writeUInt32LE(l1.length + l0.length, o + 8);
    const b = l1.length + l0.length ? box[c] : [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; ++k) ch.writeFloatLE(b[k], o + 16 + 4 * k);
    for (const q of l1.concat(l0)) { mesh.copy(out, m.vo + w * 48, m.vo + q * 48, m.vo + q * 48 + 48); ++w; }
  }
  out.writeUInt32LE(m.flags | 2, 12);
  return { mesh: out, chnk: ch };
}

// tile file -> tile file (format v2): MESH in chunk order + CHNK, LOD1 order / LOD2 recomputed from MESH when LOD2 is
// missing or opts.force, sections zstd-compressed when opts.zstd (level). Idempotent; reads v1 and v2 tiles.
function processTile(fileBuf, opts) {
  opts = opts || {};
  const f = B.readFile(fileBuf), secs = [];
  let mesh = f.sections.get('MESH'), l2 = f.sections.get('LOD2'), chnk = null;
  if (mesh) {
    if (f.sections.has('CHNK')) mesh = unchunkMesh(mesh, f.sections.get('CHNK'));
    if (opts.force || !l2) { mesh = relodMesh(mesh); l2 = lod2Mesh(mesh); }
    if (opts.chunks !== false) ({ mesh, chnk } = chunkMesh(mesh));
    secs.push(['MESH', mesh]);
    if (chnk) secs.push(['CHNK', chnk]);
    if (l2) secs.push(['LOD2', l2]);
  }
  for (const t of f.order) if (!['MESH', 'CHNK', 'LOD2'].includes(t)) secs.push([t, f.sections.get(t)]);
  return B.writeFile('TTZT', f.reserved, secs, { v2: true, zstd: opts.zstd });
}

// legacy entry point (v1 output, no chunks / compression)
function relodTile(fileBuf, force) {
  const f = B.readFile(fileBuf);
  if ((f.sections.has('LOD2') && !force) || !f.sections.has('MESH')) return null;
  const secs = [];
  for (const t of f.order) {
    if (t === 'LOD2') continue;
    const b = Buffer.from(f.sections.get(t));
    if (t !== 'MESH') { secs.push([t, b]); continue; }
    secs.push(['MESH', relodMesh(b)]);
    const l2 = lod2Mesh(b); if (l2) secs.push(['LOD2', l2]);
  }
  return B.writeFile('TTZT', f.reserved, secs);
}

module.exports = { relodMesh, lod2Mesh, relodTile, processTile, chunkMesh, unchunkMesh, readChunks, CH_N, CH_SIZE };
