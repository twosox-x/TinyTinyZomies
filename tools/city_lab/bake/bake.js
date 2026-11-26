#!/usr/bin/env node
// Offline city bake (FORMAT.md): node bake.js --seed=1 --scale=5 --out=assets/city/seed1 [--jobs=3] [--tiles=i0,j0,i1,j1]
// Regional path (CityArch.planPage / pagesPlan / buildTile, like city_worker.js 'rpage' / 'rtile'): memory bounded by
// the pages around a tile, tiles baked in parallel with worker_threads. Run with --max-old-space-size=6000 or more
// (the script re-launches itself with it).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const B = require('./lib.js');

const TILE = 128, MARGIN = 48, V = 0.1, HC = 0.5, HN = TILE / HC;   // tile m, field margin m, voxel m, height cell m
const SXZ = 'auto', SY = 'auto';                     // per mesh: finest power of two that fits (FORMAT.md 2)

// ---- material classes (palette ids, see city_core MAT / GROUND, city_arch BM, props PM)
const S = (a) => new Set(a);
const ROADM = S([0, 1, 2, 3, 4, 5, 15, 23, 24, 29]), WALKM = S([6, 7, 8, 9, 12, 13, 18]);
const OPENM = S([10, 11, 14, 16, 17, 140, 207, 202, 203, 204, 133, 205, 155]), VEGG = S([202, 203, 204, 133, 205]), WATERM = S([152, 206]);
const FOLIAGE = S([133, 134, 155, 14, 10]);           // in the building / kit layer: leaves, crowns, hedges (never block)
const F = { ROAD: 1, WALK: 2, BUILDING: 4, WATER: 8, VEG: 16, BLOCKED: 32, VEHICLE: 64, OPEN: 128 };

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else workerMain();

function args() {
  const a = {}; for (const s of process.argv.slice(2)) { const m = s.match(/^--([^=]+)(?:=(.*))?$/); if (m) a[m[1]] = m[2] === undefined ? true : m[2]; }
  return a;
}

// =============================================================================================== worker
function workerMain() {
  const { C, A, L } = B.loadCity();
  const { seed, scale } = workerData;
  const net = C.generateCity(seed, { scale });
  new C.FieldSampler(net, 0.5, [0, 0, 1, 1]).computeJunctions();
  const b = net.bounds, grid = C.chunkGrid(net, V), kinds = A.classKinds(net), meshCache = new Map();
  const npi = Math.ceil((b.x1 - b.x0) / A.PAGE), npj = Math.ceil((b.z1 - b.z0) / A.PAGE);
  const pages = new Map(), sentVariants = new Set();
  let useT = 0;
  function page(pi, pj) {                              // city_worker.js 'rpage' (with street furniture), LRU
    const k = pi + ',' + pj;
    let E = pages.get(k);
    if (!E) {
      const po = { keep: true }, P = A.planPage(net, C, V, pi, pj, po);
      const r = P.rect, Fp = po.F, R = po.R; R.setCuts(P.kitCuts);
      const box = { x0: b.x0 + Math.floor((r[0] - 8 - b.x0) / 4) * 4, z0: b.z0 + Math.floor((r[1] - 8 - b.z0) / 4) * 4, x1: r[2] + 8, z1: r[3] + 8 };
      const ctx = { net, F: Fp, R, voxel: V, box, footprints: P.jobs.filter(J => J.kind !== 'shouse').map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind })) };
      P.props = C.placeProps(ctx).filter(p => p.x >= r[0] && p.x < r[2] && p.z >= r[1] && p.z < r[3]);
      E = { P }; pages.set(k, E);
      if (pages.size > 30) { const old = [...pages.entries()].sort((x, y) => x[1].used - y[1].used)[0]; pages.delete(old[0]); }
    }
    E.used = ++useT;
    return E.P;
  }
  parentPort.on('message', (msg) => {
    if (msg.cmd !== 'tile') return;
    const t0 = Date.now(), [i, j] = msg.ij, x0 = b.x0 + i * TILE, z0 = b.z0 + j * TILE, x1 = x0 + TILE, z1 = z0 + TILE;
    const [pa, pb] = A.pageOf(net, x0 - MARGIN, z0 - MARGIN), [pc, pd] = A.pageOf(net, x1 + MARGIN, z1 + MARGIN);
    const P = [];
    for (let pj = Math.max(0, pb); pj <= Math.min(npj - 1, pd); ++pj) for (let pi = Math.max(0, pa); pi <= Math.min(npi - 1, pc); ++pi) P.push(page(pi, pj));
    const Fw = new C.FieldSampler(net, 0.5, [x0 - MARGIN, z0 - MARGIN, x1 + MARGIN, z1 + MARGIN]); Fw.build(null, true);
    const R = new C.Rasterizer(net, Fw, V); R.useClassGrid(A.pagesClassGrid(P), kinds);
    const plan = A.pagesPlan(structuredClone(P.map(p => Object.assign({}, p, { props: null }))), net, C, V, P[0].hs); plan.R = R;
    const r = A.buildTile(plan, x0, z0, x1, z1, { allCuts: true });
    const Bm = r.mb.finish(0.002);
    // road raster with the pages' kit curb cuts near the tile + the tile's own and halo buildings' cuts
    let cuts = [];
    for (const p of P) for (const c of p.kitCuts) if (Math.max(c.ax, c.bx) > x0 - 20 && Math.min(c.ax, c.bx) < x1 + 20 && Math.max(c.az, c.bz) > z0 - 20 && Math.min(c.az, c.bz) < z1 + 20) cuts.push(c);
    cuts = cuts.concat(r.allCuts || r.cuts);
    R.setCuts(cuts);
    const ox = Math.round(x0 / V), oz = Math.round(z0 / V);
    const m = C.buildChunk(Object.assign({ net, voxel: V, F: Fw, R }, grid), { ox, oz, w: Math.round((x1 - x0) / V), d: Math.round((z1 - z0) / V) });
    // traffic of this tile (placed within tile + 12 m, own kept)
    let T = null;
    if (L.trafficKit && !msg.noTraffic) {
      const G = 12, near = plan.jobs.filter(J => J.bb[2] > x0 - 30 && J.bb[0] < x1 + 30 && J.bb[3] > z0 - 30 && J.bb[1] < z1 + 30 && J.kind !== 'shouse');
      const st = L.trafficKit({ PL: { net, seed: net.seed || 1 }, C, R, jobs: near, hs: R.hs * V, voxel: V, box: [x0 - G, z0 - G, x1 + G, z1 + G], own: [x0, z0, x1, z1], meshCache });
      T = st && st.out;
    }
    R.setCuts(null);
    // props owned by the tile
    const props = [];
    for (const p of P) for (const q of p.props) if (q.x >= x0 && q.x < x1 && q.z >= z0 && q.z < z1) props.push(q);
    // ---- meshes
    const roadPart = { pos: m.pos, mat: m.mat, nrm: m.nrm, quads: m.quads, unit: V };
    const bldPart = { pos: Bm.pos, mat: Bm.mat, nrm: Bm.nrm, nvec: Bm.nvec, quads: Bm.quads, unit: V };
    const lim2 = (0.35 / V) ** 2;
    const farKeep = (Pp) => (q) => {
      const o = q * 12, ax = Pp[o + 3] - Pp[o], ay = Pp[o + 4] - Pp[o + 1], az = Pp[o + 5] - Pp[o + 2], bx = Pp[o + 9] - Pp[o], by = Pp[o + 10] - Pp[o + 1], bz = Pp[o + 11] - Pp[o + 2];
      return ax * ax + ay * ay + az * az >= lim2 || bx * bx + by * by + bz * bz >= lim2;
    };
    const st0 = {};
    const mesh = B.meshSection([Object.assign({ lod1: farKeep(m.pos) }, roadPart), Object.assign({ lod1: farKeep(Bm.pos) }, bldPart)], SXZ, SY, [x0 + TILE / 2, 0, z0 + TILE / 2], st0);
    // ---- height grid
    const H = heightGrid(x0, z0, roadPart, bldPart, props);
    const spawns = spawnPoints(H, x0, z0, i, j);
    // traffic out: variant keys + meshes not sent yet by this worker
    let tr = null;
    if (T && T.count) {
      const vars = T.variants.map(v => {
        const o = { key: v.key, kind: v.kind, bb: v.bb };
        if (!sentVariants.has(v.key)) { sentVariants.add(v.key); o.hi = v.hi && { pos: v.hi.pos, mat: v.hi.mat, nrm: v.hi.nrm, nvec: v.hi.nvec || null, quads: v.hi.quads }; o.lo = v.lo && { pos: v.lo.pos, mat: v.lo.mat, nrm: v.lo.nrm, nvec: v.lo.nvec || null, quads: v.lo.quads }; }
        return o;
      });
      tr = { M: T.M, vid: T.vid, paint: T.paint, obb: T.obb, count: T.count, variants: vars, paintPH: T.paintPH };
    }
    const sections = [['MESH', mesh]];
    if (props.length) sections.push(['PROP', propSection(props, msg.propIndex)]);
    sections.push(['HGT0', hgtSection(H, x0, z0)]);
    parentPort.postMessage({ ij: msg.ij, sections, traffic: tr, spawns, ms: Date.now() - t0, tris0: st0.tris0, tris1: st0.tris1, clamped: st0.clamped, props: props.map(p => p.type), pages: pages.size,
      heap: Math.round(process.memoryUsage().heapUsed / 1048576) });
  });
  parentPort.postMessage({ ready: true });
}

function propSection(props, index) {
  const w = new B.W(4 + props.length * 24); w.u32(props.length);
  for (const p of props) { w.u16(index[p.type]); w.u16(0); w.f32(p.x); w.f32(p.y || 0); w.f32(p.z); w.f32(p.yaw || 0); w.f32(p.phase || 0); }
  return w.done();
}
function hgtSection(H, x0, z0) {
  const w = new B.W(20 + HN * HN * 3 + 4); w.u32(HN); w.u32(HN); w.f32(HC); w.f32(x0); w.f32(z0);
  for (let k = 0; k < HN * HN; ++k) w.i16(Math.max(-32768, Math.min(32767, Math.round(H.top[k] * 100))));
  w.bytes(H.flags); w.align();
  return w.done();
}

// top surfaces: every upward-facing quad is sampled every 0.25 m (edges included) into the 0.5 m cells it covers
function stampQuads(part, x0, z0, fn) {
  const Pp = part.pos, u = part.unit, n = HN;
  for (let q = 0; q < part.quads; ++q) {
    const vi = q * 4;
    const ny = part.nvec ? part.nvec[vi * 3 + 1] / (Math.hypot(part.nvec[vi * 3], part.nvec[vi * 3 + 1], part.nvec[vi * 3 + 2]) || 1) : (part.nrm[vi] === 0 ? 1 : 0);
    if (ny < 0.7) continue;
    const o = q * 12, ax = Pp[o] * u, ay = Pp[o + 1] * u, az = Pp[o + 2] * u;
    const ex = Pp[o + 3] * u - ax, ez = Pp[o + 5] * u - az, fx = Pp[o + 9] * u - ax, fz = Pp[o + 11] * u - az;
    const ey = Pp[o + 4] * u - ay, fy = Pp[o + 10] * u - ay;
    // quick reject: quad bbox vs tile
    const minx = ax + Math.min(0, ex, fx, ex + fx), maxx = ax + Math.max(0, ex, fx, ex + fx), minz = az + Math.min(0, ez, fz, ez + fz), maxz = az + Math.max(0, ez, fz, ez + fz);
    if (maxx < x0 || minx >= x0 + TILE || maxz < z0 || minz >= z0 + TILE) continue;
    const nu = Math.max(1, Math.ceil(Math.hypot(ex, ez) / 0.25)), nv = Math.max(1, Math.ceil(Math.hypot(fx, fz) / 0.25));
    const m = part.mat[vi];
    for (let a = 0; a <= nu; ++a) for (let c = 0; c <= nv; ++c) {
      const s = a / nu, t = c / nv, x = ax + ex * s + fx * t, z = az + ez * s + fz * t;
      const gi = Math.floor((x - x0) / HC), gj = Math.floor((z - z0) / HC);
      if (gi < 0 || gj < 0 || gi >= n || gj >= n) continue;
      fn(gj * n + gi, ay + ey * s + fy * t, m);
    }
  }
}
function heightGrid(x0, z0, road, bld, props) {
  const N = HN * HN, top = new Float32Array(N), ground = new Float32Array(N).fill(-1e9), gmat = new Int16Array(N).fill(-1), flags = new Uint8Array(N);
  const solid = new Float32Array(N).fill(-1e9);
  stampQuads(road, x0, z0, (k, y, m) => { if (y > ground[k]) { ground[k] = y; gmat[k] = m; } });
  for (let k = 0; k < N; ++k) {
    if (ground[k] < -1e8) ground[k] = 0;
    const m = gmat[k];
    if (ROADM.has(m)) flags[k] |= F.ROAD; else if (WALKM.has(m)) flags[k] |= F.WALK;
    if (OPENM.has(m)) flags[k] |= F.OPEN; if (VEGG.has(m)) flags[k] |= F.VEG; if (WATERM.has(m)) flags[k] |= F.WATER;
    top[k] = ground[k];
  }
  stampQuads(bld, x0, z0, (k, y, m) => {
    if (FOLIAGE.has(m) && y > ground[k] + 1.0) { flags[k] |= F.VEG; return; }
    if (WATERM.has(m)) flags[k] |= F.WATER;
    if (y > solid[k]) solid[k] = y;
  });
  for (let k = 0; k < N; ++k) if (solid[k] > -1e8) {
    if (solid[k] > top[k]) top[k] = solid[k];
    if (solid[k] > ground[k] + 0.5) flags[k] |= F.BUILDING | F.BLOCKED;
  }
  // poles / props: a 0.5 m cell at the prop base
  for (const p of props) {
    const gi = Math.floor((p.x - x0) / HC), gj = Math.floor((p.z - z0) / HC);
    if (gi < 0 || gj < 0 || gi >= HN || gj >= HN) continue;
    const k = gj * HN + gi; flags[k] |= F.BLOCKED; if (p.type !== 'tree') top[k] = Math.max(top[k], ground[k] + 1.0);
  }
  return { top, flags, ground };
}
// street points >= 6 m from any building / blocked cell: up to 4 per tile, deterministic (cell order of a coarse 32 m grid)
function spawnPoints(H, x0, z0) {
  const out = [], R = 12;                              // 6 m in cells
  for (let cj = 0; cj < 4 && out.length < 4; ++cj) for (let ci = 0; ci < 4 && out.length < 4; ++ci) {
    // centre-most road cell in the 32 m block that is clear
    let best = null, bd = 1e9;
    for (let gj = cj * 64 + R; gj < cj * 64 + 64 - R; gj += 4) for (let gi = ci * 64 + R; gi < ci * 64 + 64 - R; gi += 4) {
      const k = gj * HN + gi; if (!(H.flags[k] & F.ROAD) || (H.flags[k] & F.BLOCKED)) continue;
      let ok = true;
      for (let dj = -R; dj <= R && ok; dj += 2) for (let di = -R; di <= R && ok; di += 2) if (H.flags[(gj + dj) * HN + gi + di] & (F.BUILDING | F.WATER)) ok = false;
      if (!ok) continue;
      const d = Math.abs(gi - ci * 64 - 32) + Math.abs(gj - cj * 64 - 32); if (d < bd) { bd = d; best = [gi, gj]; }
    }
    if (best && (ci + cj) % 2 === 0) out.push([+(x0 + (best[0] + 0.5) * HC).toFixed(2), +(z0 + (best[1] + 0.5) * HC).toFixed(2)]);
  }
  return out;
}

// =============================================================================================== main
async function main() {
  const a = args();
  if (!process.execArgv.some(s => s.startsWith('--max-old-space-size'))) {
    const r = require('child_process').spawnSync(process.execPath, ['--max-old-space-size=6000', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(r.status);
  }
  const seed = +(a.seed || 1), scale = +(a.scale || 5), out = path.resolve(a.out || 'assets/city/seed' + seed);
  const jobs = +(a.jobs || Math.max(1, Math.min(4, os.cpus().length - 1)));
  const t0 = Date.now();
  const { C, A, L } = B.loadCity();
  const net = C.generateCity(seed, { scale }), b = net.bounds;
  const ni = Math.ceil((b.x1 - b.x0) / TILE), nj = Math.ceil((b.z1 - b.z0) / TILE);
  let [ti0, tj0, ti1, tj1] = a.tiles ? a.tiles.split(',').map(Number) : [0, 0, ni - 1, nj - 1];
  fs.mkdirSync(path.join(out, 'tiles'), { recursive: true });
  const propTypes = Object.keys(C.PROP_TYPES).sort(), propIndex = Object.fromEntries(propTypes.map((t, k) => [t, k]));
  const todo = [];
  for (let j = tj0; j <= tj1; ++j) for (let i = ti0; i <= ti1; ++i) todo.push([i, j]);
  console.log(`bake seed ${seed} scale ${scale}: map ${(b.x1 - b.x0).toFixed(0)} x ${(b.z1 - b.z0).toFixed(0)} m, ${ni} x ${nj} tiles, baking ${todo.length} with ${jobs} workers -> ${out}`);
  // ---- tiles in parallel (results kept per tile: traffic is small; sections written to disk right away)
  const res = new Map(), variantMesh = new Map();
  let next = 0, done = 0, maxHeap = 0;
  await new Promise((resolve, reject) => {
    let alive = 0;
    for (let w = 0; w < Math.min(jobs, todo.length); ++w) {
      const wk = new Worker(__filename, { workerData: { seed, scale }, resourceLimits: { maxOldGenerationSizeMb: 5000 } }); alive++;
      const give = () => { if (next >= todo.length) { wk.terminate(); return; } wk.postMessage({ cmd: 'tile', ij: todo[next++], propIndex }); };
      wk.on('message', (d) => {
        if (d.ready) return give();
        const [i, j] = d.ij;
        fs.writeFileSync(path.join(out, 'tiles', `${i}_${j}.part`), B.writeFile('TTZT', i | j << 16, d.sections.map(([t, x]) => [t, Buffer.from(x.buffer, x.byteOffset, x.byteLength)])));
        if (d.traffic) for (const v of d.traffic.variants) if (v.hi && !variantMesh.has(v.key)) variantMesh.set(v.key, v);
        res.set(d.ij.join(','), { traffic: d.traffic, spawns: d.spawns, ms: d.ms, tris0: d.tris0, tris1: d.tris1, clamped: d.clamped, props: d.props });
        maxHeap = Math.max(maxHeap, d.heap);
        if (++done % 10 === 0 || done === todo.length) console.log(`  ${done}/${todo.length} tiles  ${((Date.now() - t0) / 1000).toFixed(0)} s  (last ${d.ms} ms, worker heap ${d.heap} MB, pages ${d.pages})`);
        give();
      });
      wk.on('error', reject);
      wk.on('exit', () => { if (--alive === 0) resolve(); });
    }
  });
  // ---- traffic: seams across tiles (tile order j-major), variants by key
  const order = todo.filter(ij => res.get(ij.join(',')).traffic);
  const parts = order.map(ij => res.get(ij.join(',')).traffic);
  const keep = L.trafficSeams ? L.trafficSeams(parts) : parts.map(t => new Uint8Array(t.count).fill(1));
  const keys = [...variantMesh.keys()].sort(), vIndex = new Map(keys.map((k, n) => [k, n])), vCount = new Uint32Array(keys.length);
  const pal = C.PROP_PALETTE, paintPH = parts.length ? parts[0].paintPH : 169;
  const kept = [];                                     // [tileKey, instance record]
  parts.forEach((t, pi) => {
    for (let n = 0; n < t.count; ++n) {
      if (!keep[pi][n]) continue;
      const v = vIndex.get(t.variants[t.vid[n]].key); vCount[v]++;
      kept.push({ tile: order[pi], v, paint: t.paint[n], M: t.M.subarray(n * 12, n * 12 + 12), obb: t.obb.subarray(n * 8, n * 8 + 8) });
    }
  });
  // ---- final tile files: + VEHI, vehicles stamped into HGT0
  let bytes = 0, maxOrtho = 0, nVeh = 0;
  const byTile = new Map(); for (const k of kept) { const s = k.tile.join(','); if (!byTile.has(s)) byTile.set(s, []); byTile.get(s).push(k); }
  for (const ij of todo) {
    const [i, j] = ij, fp = path.join(out, 'tiles', `${i}_${j}.part`), f = B.readFile(fs.readFileSync(fp));
    const own = byTile.get(ij.join(',')) || [];
    const secs = [];
    for (const t of f.order) {
      let buf = Buffer.from(f.sections.get(t));
      if (t === 'HGT0') buf = stampVehicles(buf, kept, b.x0 + i * TILE, b.z0 + j * TILE);
      secs.push([t, buf]);
      if (t === 'MESH' && own.length) {
        const w = new B.W(4 + own.length * 28); w.u32(own.length);
        for (const I of own) {
          const M = I.M, q = quatOf(M); maxOrtho = Math.max(maxOrtho, q.err);
          const c = I.paint && pal[I.paint] ? pal[I.paint] : [0, 0, 0];
          w.u16(I.v); w.u16(0); w.u8(c[0]); w.u8(c[1]); w.u8(c[2]); w.u8(I.paint || 0);
          w.f32(M[3]); w.f32(M[7]); w.f32(M[11]);
          for (const x of q.q) w.i16(Math.round(x * 32767));
        }
        secs.push(['VEHI', w.done()]); nVeh += own.length;
      }
    }
    const file = B.writeFile('TTZT', i | j << 16, secs);
    fs.writeFileSync(path.join(out, 'tiles', `${i}_${j}.bin`), file); fs.unlinkSync(fp); bytes += file.length;
    res.get(ij.join(',')).bytes = file.length;
  }
  // ---- vehicles.bin, props.bin
  const vsecs = [];
  keys.forEach((k, n) => {
    const v = variantMesh.get(k), id = String(n).padStart(3, '0');
    vsecs.push(['V' + id, B.meshSection([Object.assign({ unit: 1, paint: paintPH }, v.hi)], 'auto', 'auto', [0, 0, 0])]);
    if (v.lo && v.lo.quads) vsecs.push(['W' + id, B.meshSection([Object.assign({ unit: 1, paint: paintPH }, v.lo)], 'auto', 'auto', [0, 0, 0])]);
  });
  const vfile = B.writeFile('TTZV', 0, vsecs); fs.writeFileSync(path.join(out, 'vehicles.bin'), vfile); bytes += vfile.length;
  const pm = C.buildPropMeshes(), psecs = propTypes.map((t, n) => ['P' + String(n).padStart(3, '0'), B.meshSection([Object.assign({ unit: 1, quads: pm[t].pos.length / 12 }, pm[t])], 'auto', 'auto', [0, 0, 0])]);
  const pfile = B.writeFile('TTZP', 0, psecs); fs.writeFileSync(path.join(out, 'props.bin'), pfile); bytes += pfile.length;
  // ---- land use (8 m)
  const LC = 8, lnx = Math.ceil((b.x1 - b.x0) / LC), lnz = Math.ceil((b.z1 - b.z0) / LC), legend = ['unknown'], lcode = new Map();
  const lw = new B.W(20 + lnx * lnz + 4); lw.u32(lnx); lw.u32(lnz); lw.f32(LC); lw.f32(b.x0); lw.f32(b.z0);
  const codes = new Uint8Array(lnx * lnz);
  for (let z = 0; z < lnz; ++z) for (let x = 0; x < lnx; ++x) {
    let s = C.landUseAt(net, b.x0 + (x + 0.5) * LC, b.z0 + (z + 0.5) * LC); s = typeof s === 'string' ? s : (s && s.kind) || 'unknown';
    if (!lcode.has(s)) { lcode.set(s, legend.length); legend.push(s); }
    codes[z * lnx + x] = lcode.get(s);
  }
  lw.bytes(codes); lw.align();
  const lfile = B.writeFile('TTZL', 0, [['LUSE', lw.done()]]); fs.writeFileSync(path.join(out, 'landuse.bin'), lfile); bytes += lfile.length;
  // ---- city.json
  const propCount = {}; for (const r of res.values()) for (const t of r.props) propCount[t] = (propCount[t] || 0) + 1;
  const sum = (f) => [...res.values()].reduce((s, r) => s + (f(r) || 0), 0);
  const tileMs = [...res.values()].map(r => r.ms).sort((x, y) => x - y);
  const city = {
    format: 'ttz-city', version: 1, compression: 'none', seed, scale, generator: { urbanScale: 2, ruralScale: 3, voxel: V },
    bounds: { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 },
    tile: { size: TILE, ni, nj, files: 'tiles/{i}_{j}.bin', present: todo.map(([i, j]) => [i, j, res.get(i + ',' + j).bytes]) },
    quantisation: 'per mesh: scale = finest power of two <= 1/512 m whose int16 range fits (mesh header)',
    palette: palette(C, A),
    vehicles: { paintPlaceholder: paintPH, variants: keys.map((k, n) => { const v = variantMesh.get(k); return { key: k, kind: v.kind, bb: v.bb, count: vCount[n], lod1: !!(v.lo && v.lo.quads) }; }) },
    props: { types: propTypes.map(t => ({ name: t, count: propCount[t] || 0 })) },
    roads: net.roads.map(r => {
      const P = C.PROFILES[r.profile] || {}, cw = (P.bands || []).reduce((s, x) => s + x[2], 0);
      return { id: r.id, name: r.name || '', profile: r.profile, class: r.cls || P.cls || '', width: +(cw + 2 * (P.sidewalk || 0)).toFixed(2), carriageway: +cw.toFixed(2),
        pts: r.pts.map(p => [+p[0].toFixed(1), +p[1].toFixed(1)]) };
    }),
    landUse: { file: 'landuse.bin', cell: LC, nx: lnx, nz: lnz, legend },
    spawns: todo.flatMap(ij => res.get(ij.join(',')).spawns),
    stats: { bakeSeconds: 0, bytes: 0, tiles: todo.length, tris0: sum(r => r.tris0), tris1: sum(r => r.tris1), vehicles: nVeh, vehicleVariants: keys.length,
      props: sum(r => r.props.length), tileMsMedian: tileMs[tileMs.length >> 1], tileMsMax: tileMs[tileMs.length - 1], clampedVerts: sum(r => r.clamped), quatMaxOrthoErr: +maxOrtho.toFixed(6), workers: jobs, workerHeapMaxMB: maxHeap }
  };
  const det = JSON.stringify(city);                    // timing-free copy for the digest
  const js0 = JSON.stringify(city, null, 1); bytes += js0.length;
  city.stats.bytes = bytes; city.stats.bakeSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(out, 'city.json'), JSON.stringify(city, null, 1));
  console.log(`done: ${todo.length} tiles, ${(bytes / 1048576).toFixed(1)} MB, ${city.stats.bakeSeconds} s, tris LOD0 ${city.stats.tris0} LOD1 ${city.stats.tris1}, vehicles ${nVeh} (${keys.length} variants), props ${city.stats.props}, clamped verts ${city.stats.clampedVerts}`);
}

function stampVehicles(buf, kept, x0, z0) {
  const nx = buf.readUInt32LE(0), nz = buf.readUInt32LE(4), to = 20, fo = to + nx * nz * 2;
  for (const I of kept) {
    const O = I.obb, cx = O[0], cz = O[1], hx = O[2], hz = O[3], c = O[4], s = O[5], y1 = O[7], r = Math.hypot(hx, hz);
    if (cx + r < x0 || cx - r > x0 + TILE || cz + r < z0 || cz - r > z0 + TILE) continue;
    const g0 = Math.max(0, Math.floor((cx - r - x0) / HC)), g1 = Math.min(nx - 1, Math.floor((cx + r - x0) / HC));
    const h0 = Math.max(0, Math.floor((cz - r - z0) / HC)), h1 = Math.min(nz - 1, Math.floor((cz + r - z0) / HC));
    for (let h = h0; h <= h1; ++h) for (let g = g0; g <= g1; ++g) {
      const px = x0 + (g + 0.5) * HC - cx, pz = z0 + (h + 0.5) * HC - cz, u = px * c + pz * s, v = -px * s + pz * c;
      if (Math.abs(u) > hx + 0.1 || Math.abs(v) > hz + 0.1) continue;
      const k = h * nx + g, cm = Math.round(y1 * 100);
      if (cm > buf.readInt16LE(to + k * 2)) buf.writeInt16LE(Math.min(32767, cm), to + k * 2);
      buf[fo + k] |= F.VEHICLE | (y1 > 0.5 ? F.BLOCKED : 0);
    }
  }
  return buf;
}
// rotation part of City Lab's 3x4 instance matrix (rows: M[0..2] | M[3] tx, ...) -> quaternion; err = |M^T M - I|
function quatOf(M) {
  const m00 = M[0], m01 = M[1], m02 = M[2], m10 = M[4], m11 = M[5], m12 = M[6], m20 = M[8], m21 = M[9], m22 = M[10];
  let err = 0; const cols = [[m00, m10, m20], [m01, m11, m21], [m02, m12, m22]];
  for (let a = 0; a < 3; ++a) for (let c = 0; c < 3; ++c) { const d = cols[a][0] * cols[c][0] + cols[a][1] * cols[c][1] + cols[a][2] * cols[c][2] - (a === c ? 1 : 0); err = Math.max(err, Math.abs(d)); }
  const tr = m00 + m11 + m22; let x, y, z, w;
  if (tr > 0) { const S2 = Math.sqrt(tr + 1) * 2; w = 0.25 * S2; x = (m21 - m12) / S2; y = (m02 - m20) / S2; z = (m10 - m01) / S2; }
  else if (m00 > m11 && m00 > m22) { const S2 = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / S2; x = 0.25 * S2; y = (m01 + m10) / S2; z = (m02 + m20) / S2; }
  else if (m11 > m22) { const S2 = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / S2; x = (m01 + m10) / S2; y = 0.25 * S2; z = (m12 + m21) / S2; }
  else { const S2 = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / S2; x = (m02 + m20) / S2; y = (m12 + m21) / S2; z = 0.25 * S2; }
  const l = Math.hypot(x, y, z, w) || 1; if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  return { q: [x / l, y / l, z / l, w / l], err };
}

// palette: 208 entries, colours as the viewer registers them (core 0..29, plot overlay 30..53 unused in meshes,
// arch, props, vehicles), names from MAT / BM / PM / VM / GROUND, flags + emissive modes from city_lab.html's shader
function palette(C, A) {
  const srgb = []; for (let k = 0; k < 208; ++k) srgb.push([128, 128, 128]);
  C.PALETTE.forEach((c, k) => { srgb[k] = c; });
  for (const k in A.ARCH_PALETTE) srgb[+k] = A.ARCH_PALETTE[k];
  for (const k in C.PROP_PALETTE) srgb[+k] = C.PROP_PALETTE[k];
  const names = {};
  for (const [src, pre] of [[C.MAT, ''], [C.GROUND || {}, 'GROUND_'], [A.BM, ''], [C.PM, ''], [C.VM, 'VEH_']]) for (const n in src) if (names[src[n]] === undefined) names[src[n]] = pre + n;
  const lin = (v) => { v /= 255; return +(v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).toFixed(5); };
  const gloss = (m) => ((m >= 86 && m <= 89) || (m >= 146 && m <= 149) || m === 152 || m === 158 || m === 159) ? 1 : (m === 191 || m === 178) ? 0.45 : (m === 200 || m === 201) ? 0.4 : 0;
  const EM = {
    57: { mode: 'steady', day: 0.15, night: 2.75 }, 153: { mode: 'steady', day: 0.25, night: 2.05 }, 154: { mode: 'steady', day: 0.25, night: 2.05 },
    181: { mode: 'steady', day: 0.5, night: 2.1 }, 150: { mode: 'blink', day: 0.4, night: 2.6 },
    189: { mode: 'flash', day: 0.3, night: 2.7 }, 190: { mode: 'flash', day: 0.3, night: 2.7, phase: 0.5 }, 199: { mode: 'flash', day: 0.3, night: 2.7 },
    87: { mode: 'windows', day: 0, night: 1.3, dayMaterial: 86 }, 89: { mode: 'windows', day: 0, night: 1.3, dayMaterial: 88 }, 148: { mode: 'windows', day: 0, night: 1.3, dayMaterial: 146 },
    149: { mode: 'windows', day: 0, night: 1.3, dayMaterial: 147 }, 159: { mode: 'windows', day: 0, night: 1.3, dayMaterial: 158 },
    60: { mode: 'signal', day: 1.4, night: 3.2, light: 'red' }, 61: { mode: 'signal', day: 1.4, night: 3.2, light: 'amber' }, 62: { mode: 'signal', day: 1.4, night: 3.2, light: 'green' },
    68: { mode: 'signal', day: 1.4, night: 3.2, light: 'dontwalk' }, 69: { mode: 'signal', day: 1.4, night: 3.2, light: 'walk' }
  };
  const out = [];
  for (let k = 0; k < 208; ++k) {
    const g = gloss(k), fl = [];
    if (g >= 0.4 && k !== 152 && k !== 191 && k !== 178) fl.push('glass');
    if (EM[k]) fl.push('emissive'); if (EM[k] && EM[k].mode === 'signal') fl.push('signal');
    if (k === 152 || k === 206) fl.push('water');
    if (k === 133 || k === 134) fl.push('foliage');
    if (k === 169) fl.push('paint');
    if (k >= 30 && k <= 53) fl.push('overlay');
    const e = { id: k, name: names[k] || (k >= 30 && k <= 53 ? 'PLOT_' + (k - 30) : (k >= 113 && k <= 125 ? 'SHADE_' + (k - 113) : '')), srgb: srgb[k].slice(), linear: srgb[k].map(lin),
      roughness: +(1 - 0.85 * g).toFixed(2), gloss: g, flags: fl };
    if (EM[k]) e.emissive = EM[k];
    out.push(e);
  }
  return out;
}
