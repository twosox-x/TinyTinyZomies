// TEMPLATE: copy to towers/<name>.js (or add to towers/houses.js), rename, add '<name>.js' to towers/manifest.js
// (before the file that uses it; houses.js loads after yardkit.js), preview, done. See docs/PLUGINS.md.
// A house is one function on a lot footprint W x D voxels (1 voxel = 0.25 m): x along the street, z into the lot
// (z = 0 = street side, the front faces -z), y up from yard level (y = 0). Leave the lawn, walk, fences and trees to
// towers/yardkit.js (it dresses the lot around spec.lot / the footprint); the house owns porch, steps, chimney, garage.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, H2 = L.H2;
  // spec = { seed, floors, garage (bool), setback, lot: { w, d } (m), side: 'l' | 'r' (driveway side) }
  function houseTemplate(E, C, W, D, spec, R) {
    // 1. per-instance choices from R() (a seeded stream per lot) or H2(spec.seed, a, b): never Math.random / Date.now
    const wall = L.pick(R, [BM.SIDING_WHITE, BM.SIDING_SAGE, BM.PAINT_CREAM, BM.BRICK_RED]);
    const roof = L.pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_BROWN, BM.SHINGLE_SLATE]);
    const m = 4, x0 = m, x1 = W - m, z0 = 5, z1 = Math.min(D - 4, 5 + 36);        // body rectangle, inside the footprint
    const fl = 1, h = fl + 11;                                                    // floor slab 1 voxel, wall height
    // 2. build parts as VoxModels (one greedy-meshed solid each) and place them: no stacked boxes face to face
    const M = new (L.VoxModel())(x1 - x0, h + 10, z1 - z0, 0, 0);
    M.box(0, 0, 0, x1 - x0, fl, z1 - z0, BM.CONCRETE);                            // slab
    M.box(0, fl, 0, x1 - x0, h, z1 - z0, wall);                                   // walls
    for (let k = 0; k < 10; ++k) M.box(k, h + k, 0, x1 - x0 - k, h + k + 1, z1 - z0, roof);   // simple stepped roof
    E.vox(C, M, x0, 0, z0);
    // 3. windows / doors: set materials with L.glassMat(seed, a, b, litFraction) so some glow at night
    // 4. register: footprint range in metres (minW..maxW along the street, minD..maxD deep), weight = relative frequency
  }
  A.registerHouse('template_house', houseTemplate, { minW: 9, maxW: 30, minD: 8, maxD: 30, weight: 1 });
})();
