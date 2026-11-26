// City growth check (generateCity opts.scale): network stats per zone and a plan-view PNG of the ground raster.
//   node --max-old-space-size=8000 tools/city_lab/dev/grow_stats.js [seed] [--scale=5] [--png=out.png] [--px=1]
// Prints km of road per zone, junction count, blocks per land-use zone (landUseAt at the block centroid), rural
// plan (lakes, farmsteads). --png: the classified ground (Rasterizer.classify, 1 sample per px metres).
const C = require(__dirname + '/../city_core.js');
const zlib = require('zlib'), fs = require('fs');
const args = process.argv.slice(2);
const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
const arg = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const scale = +arg('scale', 5), png = arg('png', null), px = +arg('px', 1);
const t0 = Date.now();
const net = C.generateCity(seed, { scale });
const len = (p) => { let l = 0; for (let i = 0; i + 1 < p.length; ++i) l += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]); return l; };
const km = {};
for (const r of net.roads) { const z = r.zone || r.district; km[z] = (km[z] || 0) + len(r.pts) / 1000; }
const ctx = C.prepareBuild(net, 0.1), F = ctx.F;
const J = C.findJunctions ? C.findJunctions(net) : [];
const cnt = new Map(), sx = new Map(), sz = new Map();
for (let iz = 0; iz < F.nz; iz += 2) for (let ix = 0; ix < F.nx; ix += 2) {
  const c = F.comp[iz * F.nx + ix]; if (c < 0) continue;
  cnt.set(c, (cnt.get(c) || 0) + 1); sx.set(c, (sx.get(c) || 0) + ix); sz.set(c, (sz.get(c) || 0) + iz);
}
const blocks = {};
for (const [c, n] of cnt) {
  if (n * 4 * F.cell * F.cell < 200) continue;
  const x = F.x0 + sx.get(c) / n * F.cell, z = F.z0 + sz.get(c) / n * F.cell;
  const u = C.landUseAt(net, x, z); blocks[u] = (blocks[u] || 0) + 1;
}
const b = net.bounds;
console.log(JSON.stringify({ seed, scale, bounds: b, roads: net.roads.length, kmTotal: +Object.values(km).reduce((a, v) => a + v, 0).toFixed(2),
  km: Object.fromEntries(Object.entries(km).map(([k, v]) => [k, +v.toFixed(2)])), junctions: J.length, blocks,
  lakes: net.plan ? net.plan.lakes.length : 0, farms: net.plan ? net.plan.farms.length : 0, radials: net.plan ? net.plan.radials.length : 0, ms: Date.now() - t0 }));
if (png) {
  const W = Math.ceil((b.x1 - b.x0) / px), H = Math.ceil((b.z1 - b.z0) / px), img = Buffer.alloc((W * 3 + 1) * H);
  let A = {}; try { global.self = global; A = require(__dirname + '/../city_arch.js').ARCH_PALETTE; } catch (e) { }
  const pal = (m) => C.PALETTE[m] || C.PROP_PALETTE[m] || A[m] || [255, 0, 255];
  const o = {}, out = [0, 0];
  for (let j = 0; j < H; ++j) {
    img[j * (W * 3 + 1)] = 0;
    for (let i = 0; i < W; ++i) {
      ctx.R.classify(b.x0 + (i + 0.5) * px, b.z0 + (j + 0.5) * px, o, out);
      const c = pal(out[1]), k = j * (W * 3 + 1) + 1 + i * 3;
      img[k] = c[0]; img[k + 1] = c[1]; img[k + 2] = c[2];
    }
  }
  const crcT = []; for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0))]));
  console.log('png', png, W, H);
}
