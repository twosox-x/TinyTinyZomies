// TEMPLATE: copy to towers/<file>.js, rename, add the file to towers/manifest.js, preview, done.
// Mid-rises (3-14 storeys) fill downtown / old-town lots. spec = { seed, floors, party:{l,r,b}, shops, corner, zone }.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM;
  function midTemplate(E, C, W, D, spec, R) {
    const S = { seed: spec.seed, wall: L.pick(R, [BM.BRICK_RED, BM.BRICK_BROWN]), base: BM.LIMESTONE_DARK,
      awning: BM.AWNING_GREEN, shops: spec.shops, bayW: 10, lintels: true, trim: BM.TRIM };
    const fh = 14, floors = spec.floors;
    // facades: party sides (spec.party.l / .r) get plain flush walls automatically
    L.facades(E, 0, 0, W, D, 0, (len, side) => L.facadeMid(len, floors, fh, S, side), C, true, spec.party);
    const yTop = floors * fh + 5;
    L.flatRoof(E, 0, 0, W, D, yTop, S, C, { parapet: 2, parapetMat: BM.LIMESTONE_DARK, units: 0 });
    L.roofKit && L.roofKit(E, C, 1, 1, W - 1, D - 1, yTop, R, { style: 'historic', floors, avoid: [] });   // rooftop equipment
  }
  // where it may appear: zones 'core' | 'mid' | 'row', frontage range in metres, storey range
  A.registerMid('template_mid', midTemplate, { zones: ['mid'], minW: 10, maxW: 30, minFloors: 4, maxFloors: 8 });
})();
