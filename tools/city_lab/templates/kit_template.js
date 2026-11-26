// TEMPLATE: a "kit" is a whole-city dressing pass that runs inside CityArch.buildAll through a hook on CityArch.lib
// (roofKit, yardKit, serviceKit, parkKit, trafficKit, waterTankImpl: see docs/PLUGINS.md for who calls what and with which
// arguments). Copy to towers/<name>.js, add to towers/manifest.js (kits load AFTER the building plug-ins), preview.
// Rules a kit must keep: deterministic (hash of seed + stable ids, never Math.random / Date.now / iteration order of
// a shared Map), every model built once per variant and cached by key, overlays >= 2.5 cm off the ground, no
// coplanar faces with existing geometry, and nothing placed on an occupied cell (use the occupancy grids passed in K).
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM;
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const cache = new Map();                                   // variant models: key -> VoxModel (never mutate after build)
  function bench(C, variant) {
    const key = 'tpl_bench' + variant;
    if (cache.has(key)) return cache.get(key);
    const R = C.mulberry32(hash(key)), M = new (L.VoxModel())(16, 8, 7, 8, 3);
    M.box(0, 0, 0, 16, 1, 7, L.pick(R, [BM.CONCRETE, BM.WOOD]));     // model units = building voxels (0.25 m) here
    M.box(1, 1, 1, 15, 3, 6, BM.WOOD);
    cache.set(key, M); return M;
  }
  // Example hook: called once from buildAll with a kit-specific argument object K (see the real kits for its fields).
  function templateKit(K) {
    const { PL, C, mb } = K, q0 = mb.quads;
    // iterate stable ids (block id, lot id, road id), derive every random choice from hash(seed + id): order independent
    for (const g of (K.blocks || [])) {
      const R = C.mulberry32(hash('tplkit' + K.seed + ':' + g.id));
      if (R() < 0.5) continue;
      // place with an emitter: E.vox(C, bench(C, (R() * 3) | 0), x, y, z)
    }
    return { quads: mb.quads - q0 };
  }
  L.templateKit = templateKit;                               // a new hook name must also be called from buildAll
})();
