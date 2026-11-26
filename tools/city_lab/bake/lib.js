// Shared by bake.js / verify.js: loads City Lab headless (core + arch + plug-ins) and the binary writer / reader
// helpers of FORMAT.md.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

function loadCity() {
  const C = require(ROOT + '/city_core.js');
  const A = require(ROOT + '/city_arch.js');
  global.self = global; self.CityArch = A; self.CityCore = C;
  self.TOWER_FILES = null; (0, eval)(fs.readFileSync(ROOT + '/towers/manifest.js', 'utf8'));
  for (const f of self.TOWER_FILES) (0, eval)(fs.readFileSync(ROOT + '/towers/' + f, 'utf8'));
  return { C, A, L: A.lib };
}

// ---- binary writer (little endian, growable)
class W {
  constructor(n) { this.b = Buffer.alloc(n || 1 << 16); this.o = 0; }
  need(n) { if (this.o + n <= this.b.length) return; let s = this.b.length * 2; while (s < this.o + n) s *= 2; const nb = Buffer.alloc(s); this.b.copy(nb, 0, 0, this.o); this.b = nb; }
  u8(v) { this.need(1); this.b.writeUInt8(v, this.o); this.o += 1; }
  i8(v) { this.need(1); this.b.writeInt8(v, this.o); this.o += 1; }
  u16(v) { this.need(2); this.b.writeUInt16LE(v, this.o); this.o += 2; }
  i16(v) { this.need(2); this.b.writeInt16LE(v, this.o); this.o += 2; }
  u32(v) { this.need(4); this.b.writeUInt32LE(v >>> 0, this.o); this.o += 4; }
  i32(v) { this.need(4); this.b.writeInt32LE(v, this.o); this.o += 4; }
  f32(v) { this.need(4); this.b.writeFloatLE(v, this.o); this.o += 4; }
  tag(s) { this.need(4); this.b.write(s, this.o, 4, 'latin1'); this.o += 4; }
  bytes(buf) { this.need(buf.length); Buffer.from(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength).copy(this.b, this.o); this.o += buf.byteLength; }
  align() { while (this.o & 3) this.u8(0); }
  done() { return this.b.subarray(0, this.o); }
}

// file = header + section table + sections (each 4-aligned). sections: [[tag, Buffer]]
function writeFile(magic, reserved, sections) {
  const head = 16 + sections.length * 12;
  const w = new W(head + sections.reduce((s, x) => s + x[1].length + 4, 0));
  w.tag(magic); w.u32(1); w.u32(sections.length); w.u32(reserved >>> 0);
  let off = head; const offs = [];
  for (const [, b] of sections) { offs.push(off); off += (b.length + 3) & ~3; }
  sections.forEach(([t, b], k) => { w.tag(t); w.u32(offs[k]); w.u32(b.length); });
  for (const [, b] of sections) { w.bytes(b); w.align(); }
  return w.done();
}
function readFile(buf) {
  const magic = buf.toString('latin1', 0, 4), ver = buf.readUInt32LE(4), n = buf.readUInt32LE(8), reserved = buf.readUInt32LE(12);
  const sections = new Map(), order = [];
  for (let k = 0; k < n; ++k) {
    const o = 16 + k * 12, tag = buf.toString('latin1', o, o + 4), off = buf.readUInt32LE(o + 4), len = buf.readUInt32LE(o + 8);
    sections.set(tag, buf.subarray(off, off + len)); order.push(tag);
  }
  return { magic, ver, reserved, sections, order };
}

// ---- mesh section (FORMAT.md 2): an implicit quad list (4 vertices per quad, no index data). parts: [{ pos
// (Float32, 4 verts per quad), mat, nrm (normal ids) | nvec, quads, unit (m per pos unit), lod1?: (q) => bool,
// paint?: material id flagged as body paint }]. Quads kept by lod1 (all when absent) are written first.
const NID = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
function meshSection(parts, sxz, sy, origin, stat) {
  let Q = 0, Q1 = 0;
  const l1 = parts.map(p => { const k = new Uint8Array(p.quads); for (let q = 0; q < p.quads; ++q) { k[q] = !p.lod1 || p.lod1(q) ? 1 : 0; Q1 += k[q]; } Q += p.quads; return k; });
  const Vn = Q * 4;
  // scale 'auto': the finest power of two (<= 1/512 m) whose int16 range holds every vertex of the mesh
  if (sxz === 'auto' || sy === 'auto') {
    let ex = 0, ey = 0;
    for (const p of parts) { const P = p.pos, u = p.unit; for (let k = 0; k < p.quads * 12; k += 3) {
      ex = Math.max(ex, Math.abs(P[k] * u - origin[0]), Math.abs(P[k + 2] * u - origin[2])); ey = Math.max(ey, Math.abs(P[k + 1] * u - origin[1])); } }
    const pick = (e) => { let k = 9; while (k > -4 && e / Math.pow(2, -k) > 32000) --k; return Math.pow(2, -k); };
    if (sxz === 'auto') sxz = pick(ex); if (sy === 'auto') sy = pick(ey);
  }
  const w = new W(72 + Vn * 12);
  w.u32(Vn); w.u32(0); w.u32(0); w.u32(1); w.f32(sxz); w.f32(sy); w.f32(origin[0]); w.f32(origin[1]); w.f32(origin[2]); w.u32(Q1); w.u32(Q); w.u32(0);
  const bbo = w.o; for (let k = 0; k < 6; ++k) w.f32(0);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let clamped = 0;
  const q16 = (v) => { const r = Math.round(v); if (r > 32767) { ++clamped; return 32767; } if (r < -32768) { ++clamped; return -32768; } return r; };
  for (const pass of [1, 0]) parts.forEach((p, pi) => {
    const P = p.pos, u = p.unit, K = l1[pi];
    for (let q = 0; q < p.quads; ++q) {
      if (K[q] !== pass) continue;
      for (let c = 0; c < 4; ++c) {
        const vi = q * 4 + c, x = P[vi * 3] * u, y = P[vi * 3 + 1] * u, z = P[vi * 3 + 2] * u;
        const qx = q16((x - origin[0]) / sxz), qy = q16((y - origin[1]) / sy), qz = q16((z - origin[2]) / sxz);
        w.i16(qx); w.i16(qy); w.i16(qz);
        const m = p.mat[vi];
        w.u16(p.paint !== undefined && m === p.paint ? 1 : 0);
        let nx, ny, nz;
        if (p.nvec) { nx = p.nvec[vi * 3]; ny = p.nvec[vi * 3 + 1]; nz = p.nvec[vi * 3 + 2]; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; }
        else [nx, ny, nz] = NID[p.nrm[vi]] || NID[0];
        w.i8(Math.round(nx * 127)); w.i8(Math.round(ny * 127)); w.i8(Math.round(nz * 127)); w.u8(m);
        const X = origin[0] + qx * sxz, Y = origin[1] + qy * sy, Z = origin[2] + qz * sxz;
        if (X < mn[0]) mn[0] = X; if (Y < mn[1]) mn[1] = Y; if (Z < mn[2]) mn[2] = Z;
        if (X > mx[0]) mx[0] = X; if (Y > mx[1]) mx[1] = Y; if (Z > mx[2]) mx[2] = Z;
      }
    }
  });
  const buf = w.done();
  if (Vn) for (let k = 0; k < 3; ++k) { buf.writeFloatLE(mn[k], bbo + k * 4); buf.writeFloatLE(mx[k], bbo + 12 + k * 4); }
  if (stat) { stat.clamped = (stat.clamped || 0) + clamped; stat.tris0 = (stat.tris0 || 0) + Q * 2; stat.tris1 = (stat.tris1 || 0) + Q1 * 2; }
  return buf;
}
function readMesh(b) {
  const V = b.readUInt32LE(0), I = b.readUInt32LE(4), isz = b.readUInt32LE(8), flags = b.readUInt32LE(12), lod1Quads = b.readUInt32LE(36), quads = b.readUInt32LE(40);
  const sxz = b.readFloatLE(16), sy = b.readFloatLE(20), origin = [b.readFloatLE(24), b.readFloatLE(28), b.readFloatLE(32)];
  const aabb = []; for (let k = 0; k < 6; ++k) aabb.push(b.readFloatLE(48 + k * 4));
  const vo = 72, io = vo + V * 12;
  return { V, I, isz, flags, lod1Quads, quads, sxz, sy, origin, aabb, vo, io, buf: b };
}

module.exports = { loadCity, W, writeFile, readFile, meshSection, readMesh, NID };
