/* City Lab build worker: rebuilds the network from (kind, seed), computes the distance fields and meshes every
   chunk whose index % parts === part. Part 0 also builds the building blockouts and plot overlay. */
importScripts('city_core.js');
self.onmessage = (e) => {
  const { kind, seed, voxel, part, parts, job } = e.data;
  const C = self.CityCore;
  const net = kind === 'test' ? C.generateTestArea() : C.generateCity(seed);
  const t0 = performance.now();
  const ctx = C.prepareBuild(net, voxel);
  const fieldsMs = performance.now() - t0;
  const mine = ctx.chunks.filter((c, i) => i % parts === part);
  self.postMessage({ job, type: 'begin', part, chunks: ctx.chunks.length, mine: mine.length, fieldsMs, hs: ctx.R.hs });
  const t1 = performance.now();
  let cells = 0;
  for (const c of mine) {
    const m = C.buildChunk(ctx, c);
    cells += c.w * c.d;
    self.postMessage({ job, type: 'chunk', ox: c.ox, oz: c.oz, w: c.w, d: c.d, pos: m.pos, mat: m.mat, nrm: m.nrm, idx: m.idx, quads: m.quads },
      [m.pos.buffer, m.mat.buffer, m.nrm.buffer, m.idx.buffer]);
  }
  const roadsMs = performance.now() - t1;
  let blocks = null, blocksMs = 0;
  if (part === 0) {
    const t2 = performance.now();
    blocks = C.buildBlocks(ctx);
    blocksMs = performance.now() - t2;
    const B = blocks.buildings, P = blocks.plots;
    self.postMessage({ job, type: 'blocks', buildings: B, plots: P, plotCount: blocks.plotCount, builtArea: blocks.builtArea },
      [B.pos.buffer, B.mat.buffer, B.nrm.buffer, B.idx.buffer, P.pos.buffer, P.mat.buffer, P.nrm.buffer, P.idx.buffer]);
  }
  self.postMessage({ job, type: 'end', part, cells, fieldsMs, roadsMs, blocksMs,
    junctions: part === 0 ? net.roads.map(r => r.junctions || []) : null });
};
