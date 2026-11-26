/* City Lab build worker. Rebuilds the network from (kind, seed) and its distance fields, then meshes the
   chunks the page hands out one at a time (dynamic load balancing). The 'blocks' worker first builds the
   building blockouts, plot overlay and street furniture. */
importScripts('city_core.js', 'city_arch.js', 'towers/manifest.js');
for (const f of self.TOWER_FILES) importScripts('towers/' + f);
let ctx = null, job = 0;
self.onmessage = (e) => {
  const d = e.data, C = self.CityCore;
  if (d.cmd === 'start') {
    job = d.job;
    if (d.scale) self.CITY_LAB_SCALE = d.scale;
    const net = d.kind === 'test' ? C.generateTestArea() : C.generateCity(d.seed);
    const t0 = performance.now();
    ctx = C.prepareBuild(net, d.voxel);
    const fieldsMs = performance.now() - t0;
    self.postMessage({ job, type: 'begin', chunks: ctx.chunks.length, fieldsMs, hs: ctx.R.hs });
    if (d.blocks) {
      const t1 = performance.now();
      // driveway curb cuts are known midway through the building placement: the page re-meshes the road chunks
      // they touch on the other workers while this one finishes the buildings
      const jobId = job;
      self.CityArch.lib.onCuts = (cuts) => self.postMessage({ job: jobId, type: 'cuts', cuts: cuts.map(c => ({ ax: c.ax, az: c.az, bx: c.bx, bz: c.bz, nx: c.nx, nz: c.nz, depth: c.depth, road: c.road, kind: c.kind })) });
      const blocks = C.buildBlocks(ctx);
      const props = C.placeProps(ctx);
      self.postMessage({ job, type: 'props', props });
      const B = blocks.buildings, P = blocks.plots;
      // road traffic (towers/traffickit.js): variant meshes once + instance arrays, drawn as InstancedMeshes
      const T = B.traffic; B.traffic = null;
      if (T) {
        const tb = [T.M.buffer, T.vid.buffer, T.paint.buffer, T.obb.buffer];
        for (const v of T.variants) for (const g of [v.hi, v.lo]) if (g) tb.push(g.pos.buffer, g.mat.buffer, g.nrm.buffer);
        self.postMessage({ job, type: 'traffic', traffic: T }, tb);
      }
      self.postMessage({ job, type: 'blocks', buildings: B, plots: P, plotCount: blocks.plotCount, builtArea: blocks.builtArea,
        blocksMs: performance.now() - t1, junctions: ctx.F.junctionData() },
        [B.pos.buffer, B.mat.buffer, B.nrm.buffer, B.idx.buffer].concat(B.nvec ? [B.nvec.buffer] : [], [P.pos.buffer, P.mat.buffer, P.nrm.buffer, P.idx.buffer]));
    }
    self.postMessage({ job, type: 'ready' });
  } else if (d.cmd === 'cuts' && d.job === job && ctx) {
    if (!ctx.R.cuts) ctx.R.setCuts(d.cuts);
  } else if (d.cmd === 'chunk' && d.job === job && ctx) {
    const c = ctx.chunks[d.index];
    const t = performance.now();
    const m = C.buildChunk(ctx, c);
    self.postMessage({ job, type: 'chunk', index: d.index, ox: c.ox, oz: c.oz, w: c.w, d: c.d, pos: m.pos, mat: m.mat, nrm: m.nrm, idx: m.idx,
      quads: m.quads, ms: performance.now() - t, cut: !!ctx.R.cuts }, [m.pos.buffer, m.mat.buffer, m.nrm.buffer, m.idx.buffer]);
  }
};
// ---- streaming (city_stream.js). Worker 0 plans the whole map once (global fields, plots, planAll, props,
// traffic) and exports a compact plan (CityArch.exportPlan: jobs, kit mesh, block classes); the page hands it to every
// worker ('sinit', the planner too, which then drops its whole-map data). A tile = road raster + buildTile() on
// fields sampled for the tile window only (FieldSampler win, bit-identical to the whole-map fields), so a tile
// worker's memory does not grow with the map. lod 'far': buildTile drops sub-pixel quads (see city_stream.js).
let SP = null;
const TILE_MARGIN = 48;                                // field window beyond the tile: halo buildings + their curb probes
self.addEventListener('message', (e) => {
  const d = e.data, C = self.CityCore, A = self.CityArch;
  if (d.cmd === 'splan') {
    const t0 = performance.now();
    const net = C.generateCity(d.seed, { scale: d.scale || 1 });
    const sctx = C.prepareBuild(net, d.voxel);
    const PL = new C.Plots(net, sctx.F, sctx.R, 0.5, net.seed || 1); PL.build();
    const plan = A.planAll(PL, sctx.R, d.voxel, C);
    const cp = A.exportPlan(plan), tr = cp.transfer; delete cp.transfer;
    const msg = { type: 'splanned', ms: performance.now() - t0, hs: sctx.R.hs, bounds: net.bounds, kitCuts: plan.kitCuts.map(c => Object.assign({}, c)), cp };
    if (d.props) { sctx.footprints = plan.blockJobs.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind })); sctx.R.setCuts(plan.kitCuts); msg.props = C.placeProps(sctx); sctx.R.setCuts(null); }
    msg.mem = self.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    self.postMessage(msg, tr);
    // traffic (towers/traffickit.js) once on the global plan, after the plan is announced (tiles are not held up)
    if (d.props && A.lib.trafficKit) {
      const tt = performance.now();
      sctx.R.setCuts(plan.kitCuts);
      const st = A.lib.trafficKit({ PL, C, R: sctx.R, jobs: plan.blockJobs, hs: plan.hs, voxel: d.voxel });
      sctx.R.setCuts(null);
      const T = st && st.out;
      if (T) {
        const tb = [T.M.buffer, T.vid.buffer, T.paint.buffer, T.obb.buffer];
        for (const v of T.variants) for (const g of [v.hi, v.lo]) if (g) tb.push(g.pos.buffer, g.mat.buffer, g.nrm.buffer);
        self.postMessage({ type: 'traffic', traffic: T, ms: performance.now() - tt }, tb);
      }
    }
  } else if (d.cmd === 'sinit') {                       // tile worker: road network + the compact plan
    const t0 = performance.now();
    const net = C.generateCity(d.seed, { scale: d.scale || 1 });
    new C.FieldSampler(net, 0.5, [0, 0, 1, 1]).computeJunctions();
    SP = { net, voxel: d.voxel, plan: A.importPlan(d.cp, net, C), grid: C.chunkGrid(net, d.voxel) };
    self.postMessage({ type: 'sready', ms: performance.now() - t0 });
  } else if (d.cmd === 'stile' && SP) {
    const t0 = performance.now(), v = SP.voxel, [x0, z0, x1, z1] = d.rect, M = TILE_MARGIN;
    const F = new C.FieldSampler(SP.net, 0.5, [x0 - M, z0 - M, x1 + M, z1 + M]); F.build(null, true);
    const R = new C.Rasterizer(SP.net, F, v); R.useBlockClasses(SP.plan.bc);
    const fieldMs = performance.now() - t0;
    SP.plan.R = R; A.setKit(SP.plan, d.kit);
    const r = A.buildTile(SP.plan, x0, z0, x1, z1, { lod: d.lod });
    SP.plan.R = null; SP.plan.kit = SP.plan.kitC = SP.plan.kitB = null;
    const B = r.mb.finish(0.002);
    const t1 = performance.now();
    R.setCuts(d.cuts.concat(r.cuts));
    const ox = Math.round(x0 / v), oz = Math.round(z0 / v);
    const m = C.buildChunk(Object.assign({ net: SP.net, voxel: v, F, R }, SP.grid), { ox, oz, w: Math.round((x1 - x0) / v), d: Math.round((z1 - z0) / v) });
    const mem = self.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    self.postMessage({ type: 'stile', key: d.key, lod: d.lod || 'full', bld: B, road: m, cuts: r.cuts.map(c => Object.assign({}, c)), ms: performance.now() - t0, roadMs: performance.now() - t1, fieldMs, halo: r.halo, mem },
      [B.pos.buffer, B.mat.buffer, B.nrm.buffer, B.idx.buffer, m.pos.buffer, m.mat.buffer, m.nrm.buffer, m.idx.buffer].concat(B.nvec ? [B.nvec.buffer] : []));
  }
});
