// TEMPLATE: copy to towers/<name>.js, rename, add '<name>.js' to towers/manifest.js, preview, done.
// A tower is one function on a lot of W x D voxels (1 voxel = 0.25 m): x along the street, z into the lot (z=0 = street), y up.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;           // FH = storey height (14 voxels = 3.5 m)
  function towerTemplate(E, C, W, D, spec, R) {
    // 1. per-instance choices from R() (materials, proportions, top) so two copies differ
    const S = { seed: spec.seed, stone: L.pick(R, [BM.LIMESTONE, BM.BUFF]), stoneDark: BM.GRANITE_DARK, canopy: BM.BRONZE };
    const n = Math.max(18, spec.floors);
    // 2. tiers bottom-up: base built for the tower, body, top. Each tier: rect (or mask/notch), height, facade skin, roof options.
    const tiers = [
      Object.assign(L.inset(W, D, 0, 0, 0, 0), { h: 18 + 3 * FH + 3, skin: L.skinPodium(S), party: spec.party, roof: { mat: S.stone } }),
      Object.assign(L.inset(W, D, 8, 10, 8, 6), { h: n * FH, skin: L.skinCurtain(S, { fin: true, tint: 'blue' }), roof: { mat: BM.MULLION, units: 2 } })
    ];
    const top = L.buildTiers(E, C, W, D, tiers, spec.seed);
    // 3. voxel parts (crowns, masts, planters): build a VoxModel and place it
    E.vox(C, L.mastsModel(R), W >> 1, top, D >> 1);
  }
  A.registerTower('template', towerTemplate);                         // opts: { unique: true } = max one per city
})();
