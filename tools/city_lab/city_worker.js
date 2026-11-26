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
