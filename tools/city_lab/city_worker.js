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
// ---- streaming (city_stream.js): every worker plans the whole map once (geometry-free), then builds 128 m tiles
// on demand: road raster of the tile (with the curb cuts known so far) + buildTile() (buildings, yards, kit quads).
let SP = null;
self.addEventListener('message', (e) => {
  const d = e.data, C = self.CityCore, A = self.CityArch;
  if (d.cmd === 'splan') {
    const t0 = performance.now();
    const net = C.generateCity(d.seed);
    const sctx = C.prepareBuild(net, d.voxel);
    const PL = new C.Plots(net, sctx.F, sctx.R, 0.5, net.seed || 1); PL.build();
    const plan = A.planAll(PL, sctx.R, d.voxel, C);
    SP = { ctx: sctx, plan, voxel: d.voxel };
    const msg = { type: 'splanned', ms: performance.now() - t0, hs: sctx.R.hs, bounds: net.bounds, kitCuts: plan.kitCuts.map(c => Object.assign({}, c)) };
    if (d.props) { sctx.footprints = plan.blockJobs.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind })); sctx.R.setCuts(plan.kitCuts); msg.props = C.placeProps(sctx); sctx.R.setCuts(null); }
    self.postMessage(msg);
  } else if (d.cmd === 'stile' && SP) {
    const t0 = performance.now(), v = SP.voxel, [x0, z0, x1, z1] = d.rect;
    const r = A.buildTile(SP.plan, x0, z0, x1, z1);
    const B = r.mb.finish(0.002);
    const t1 = performance.now();
    SP.ctx.R.setCuts(d.cuts.concat(r.cuts));
    const ox = Math.round(x0 / v), oz = Math.round(z0 / v);
    const m = C.buildChunk(SP.ctx, { ox, oz, w: Math.round((x1 - x0) / v), d: Math.round((z1 - z0) / v) });
    SP.ctx.R.setCuts(null);
    self.postMessage({ type: 'stile', key: d.key, bld: B, road: m, cuts: r.cuts.map(c => Object.assign({}, c)), ms: performance.now() - t0, roadMs: performance.now() - t1, halo: r.halo },
      [B.pos.buffer, B.mat.buffer, B.nrm.buffer, B.idx.buffer, m.pos.buffer, m.mat.buffer, m.nrm.buffer, m.idx.buffer].concat(B.nvec ? [B.nvec.buffer] : []));
  }
});
