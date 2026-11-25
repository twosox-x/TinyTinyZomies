// Tower 'bundled': a 1970s bundled-tube supertall. A grid of square steel tubes (2x2, 3x2 or 3x3 to suit the lot),
// each stopping at its own height, so the top steps down in an asymmetric, Sears-like silhouette. Black / dark-bronze
// glass behind dark steel mullions, louvered mechanical belts at every setback and at regular heights, heavier
// column lines where tubes meet. It sits on a granite plinth (steps, planters, a red plaza stabile) above a
// recessed double-height glass lobby under the tower's soffit. Height bands are mask tiers (the union of the tubes
// still rising), so the bundle is one closed shell: no interior walls, no coplanar faces.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;

  function towerBundled(E, C, W, D, spec, R) {
    const VM = L.VoxModel(), seed = spec.seed;
    const pal = L.pick(R, [
      { span: BM.STEEL_DARK, mull: BM.STEEL_DARK, fascia: BM.STEEL_DARK },
      { span: BM.BRONZE, mull: BM.STEEL_DARK, fascia: BM.BRONZE },
      { span: BM.STEEL_DARK, mull: BM.STEEL_DARK, fascia: BM.BRONZE }
    ]);
    const stone = L.pick(R, [BM.GRANITE_DARK, BM.GRANITE_PINK, BM.GRANITE_DARK]);
    const paving = stone === BM.GRANITE_PINK ? BM.GRANITE_DARK : L.pick(R, [BM.LIMESTONE, BM.GRANITE_PINK]);
    const P = 4;                                                     // mullion pitch (1 m); tube sizes are multiples

    // ---- footprint: a grid of square tubes behind a front plaza
    const stepD = 6, plH = 4, lobH = 26;
    const front = Math.max(stepD + 16, Math.round(D * (0.18 + R() * 0.1)));
    const sideM = 6 + Math.floor(R() * 4), backM = 6;
    const aw = W - 2 * sideM, ad = D - front - backM;
    const cands = [];
    for (const [nx, nz] of [[3, 3], [3, 2], [2, 3], [2, 2]]) {
      const s = Math.min(48, Math.floor(Math.min(aw / nx, ad / nz) / P) * P);
      if (s >= 24) cands.push({ nx, nz, s, w: nx * nz + R() * 3 });
    }
    let g = cands.sort((a, b) => b.w - a.w)[0];
    if (!g) g = { nx: 2, nz: 2, s: Math.max(16, Math.floor(Math.min(aw / 2, ad / 2) / P) * P) };
    const { nx, nz, s } = g, T = nx * nz;
    const gx0 = Math.floor((W - nx * s) / 2), gz0 = front + Math.floor((ad - nz * s) * 0.6);
    const gx1 = gx0 + nx * s, gz1 = gz0 + nz * s;

    // ---- tube heights: grow a connected cluster from the tallest tube outwards, one height group at a time
    const n = Math.max(32, Math.round(spec.floors * (1.15 + R() * 0.3)));
    const nb = n - 2;                                                // body storeys above the lobby
    const groups = T === 9 ? L.pick(R, [[2, 2, 3, 2], [1, 2, 3, 3], [2, 3, 2, 2], [2, 1, 3, 3], [1, 3, 2, 3]])
      : T === 6 ? L.pick(R, [[1, 2, 3], [2, 2, 2], [1, 3, 2], [2, 1, 3]])
      : L.pick(R, [[1, 1, 2], [1, 2, 1], [2, 1, 1], [1, 3]]);
    const fr = [1];
    for (let k = 1; k < groups.length; ++k) fr.push(fr[k - 1] - (groups.length === 4 ? 0.15 : 0.2) - R() * 0.08);
    const ht = new Array(T).fill(0), inSet = new Array(T).fill(false);
    const nbr = (i) => { const x = i % nx, z = (i / nx) | 0; return [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < nx && b < nz).map(([a, b]) => b * nx + a); };
    let order = [Math.floor(R() * T)];
    inSet[order[0]] = true;
    let gi = 0, left = groups[0] - 1;
    const assign = [0];
    while (order.length < T) {
      if (left === 0) { gi++; left = groups[gi]; }
      const fro = [];
      for (const i of order) for (const j of nbr(i)) if (!inSet[j] && !fro.includes(j)) fro.push(j);
      const j = fro.length ? fro[Math.floor(R() * fro.length)] : inSet.indexOf(false);
      inSet[j] = true; order.push(j); assign.push(gi); left--;
    }
    let prevF = 1e9;
    const gFloors = fr.map((f) => { let v = Math.round(nb * f); v = Math.min(v, prevF - 4); prevF = v; return Math.max(6, v); });
    order.forEach((i, k) => { ht[i] = gFloors[assign[k]]; });
    const tubeRect = (i) => { const x = i % nx, z = (i / nx) | 0; return [gx0 + x * s, gz0 + z * s, gx0 + (x + 1) * s, gz0 + (z + 1) * s]; };
    const maskOf = (minF) => {
      const m = new Uint8Array(W * D);
      for (let i = 0; i < T; ++i) if (ht[i] >= minF) {
        const [x0, z0, x1, z1] = tubeRect(i);
        for (let z = z0; z < z1; ++z) for (let x = x0; x < x1; ++x) m[z * W + x] = 1;
      }
      return m;
    };
    const levels = [...new Set(ht)].sort((a, b) => a - b);

    // mechanical belts: the top storey of every band (setbacks happen at plant floors) and every ~12-16 storeys
    const beltEvery = 12 + Math.floor(R() * 5), mech = new Set();
    for (const lv of levels) mech.add(lv - 1);
    for (let f = beltEvery - 1; f < nb - 3; f += beltEvery) if (![...mech].some((m) => Math.abs(m - f) < 4)) { mech.add(f); mech.add(f + 1); }

    // ---- skins
    // offices light up in runs of panes, not single random windows
    const glassAt = (u, f, k) => L.H2(seed + 5, (u >> 4) + k * 31, f) < 0.3 ? L.glassMat(seed, u * 7 + k, f, 0.8, 'dark') : BM.GLASS_DARK;
    const skinBody = (f0) => (len, h) => {
      const F = new L.Relief(len, h, 0, pal.span), nf = Math.round(h / FH);
      for (let f = 0; f < nf; ++f) {
        const v = f * FH, af = f0 + f;
        if (mech.has(af)) {                                                        // plant floor: continuous louver belt
          F.rect(0, v, len, v + 1, 3, pal.fascia);
          for (let r = 1; r < FH - 1; r += 2) F.rect(0, v + r, len, v + r + 1, 3, BM.LOUVER);
          F.rect(0, v + FH - 1, len, v + FH, 3, pal.fascia);
          continue;
        }
        for (let u = 0; u < len; u += P) {
          F.rect(u + 1, v + 3, Math.min(len, u + P), v + FH, 2, glassAt(u, af, len));
          F.rect(u, v, u + 1, v + FH, 3, pal.mull);                                // mullions
        }
      }
      for (let u = 0; u <= len; u += s) F.rect(Math.max(0, u - 1), 0, Math.min(len, u + 1), h, 4, pal.mull);   // tube column lines
      if (f0 === 0) { F.rect(0, 0, len, 4, 4, pal.fascia); F.rect(0, 4, len, 5, 3, pal.fascia); }               // transfer fascia over the lobby
      return F;
    };
    const skinLobby = (len, h, info) => {
      const F = new L.Relief(len, h, 0, pal.mull);
      for (let u = 0; u < len; u += 5) F.rect(u + 1, 0, Math.min(len, u + 5), h - 3, 1, L.glassMat(seed, u, 77, 0.75, 'dark'));
      F.rect(0, 15, len, 16, 2, pal.mull);                                         // transom
      if (info.front || len > 60) {
        const cs = info.front ? L.bays(len, 28, 6) : [len >> 1];
        for (const c of cs) {                                                      // revolving-door pairs in steel frames
          F.rect(c - 8, 0, c + 8, 15, 3, pal.mull);
          F.rect(c - 7, 0, c - 1, 12, 0, BM.GLASS_DARK); F.rect(c + 1, 0, c + 7, 12, 0, BM.GLASS_DARK);
          F.rect(c - 5, 0, c - 3, 12, 1, BM.METAL); F.rect(c + 3, 0, c + 5, 12, 1, BM.METAL);
          F.rect(c - 7, 12, c + 7, 14, 1, BM.BRONZE);
        }
      }
      F.rect(0, h - 3, len, h, 2, pal.mull);
      return F;
    };
    const skinPlinth = (len, h) => {
      const F = new L.Relief(len, h, 1, stone);
      F.rect(0, h - 1, len, h, 3, stone);
      for (let u = 6; u < len - 4; u += 12) F.rect(u, 0, u + 1, h - 1, 1, BM.GRANITE_DARK);
      F.returns();
      return F;
    };

    // ---- tiers: plinth, recessed lobby, then one band per distinct tube height
    const tiers = [
      { x0: 0, z0: stepD, x1: W, z1: D, h: plH, skin: skinPlinth, party: spec.party, roof: { parapet: 0, deck: paving } },
      { x0: gx0 + 6, z0: gz0 + 6, x1: gx1 - 6, z1: gz1 - 6, h: lobH, skin: skinLobby, noRoof: true }
    ];
    let lo = 0;
    levels.forEach((lv, k) => {
      const t = { mask: maskOf(lv), h: (lv - lo) * FH, skin: skinBody(lo),
        roof: { parapet: 3, mat: pal.mull, deck: BM.ROOF_TAR, units: k === levels.length - 1 ? 0 : 2 + Math.floor(R() * 2) } };
      if (k === 0) { t.floating = true; t.soffit = BM.METAL; }
      tiers.push(t);
      lo = lv;
    });
    const yTop = L.buildTiers(E, C, W, D, tiers, seed);
    const yBody = plH + lobH;

    // ---- lobby columns (set 1 voxel inside the tower face; they run into the plinth and the body)
    const col = new VM(W, lobH + 4, D, 0, 0);
    const cstep = s / 2;
    for (let x = gx0; x <= gx1; x += cstep) {
      const cx = Math.min(gx1 - 4, Math.max(gx0 + 1, x - 1));
      col.box(cx, 0, gz0 + 1, cx + 3, lobH + 3, gz0 + 4, pal.mull); col.box(cx, 0, gz1 - 4, cx + 3, lobH + 3, gz1 - 1, pal.mull);
    }
    for (let z = gz0; z <= gz1; z += cstep) {
      const cz = Math.min(gz1 - 4, Math.max(gz0 + 1, z - 1));
      col.box(gx0 + 1, 0, cz, gx0 + 4, lobH + 3, cz + 3, pal.mull); col.box(gx1 - 4, 0, cz, gx1 - 1, lobH + 3, cz + 3, pal.mull);
    }
    E.vox(C, col, 0, plH - 1, 0);

    // ---- plaza: steps across the front, planters with honey locusts, a red steel stabile, a flagpole row
    const st = new VM(W, 4, stepD, 0, 0);
    st.box(0, 0, 0, W, 1, stepD, stone); st.box(0, 1, 2, W, 2, stepD, stone); st.box(0, 2, 4, W, 3, stepD, stone);
    E.vox(C, st, 0, 0, 0);
    const pz = new VM(W, 40, gz0, 0, 0);
    const tree = (x, z) => {
      const hv = L.H2(seed, x, z), th = 11 + Math.floor(hv * 4);
      pz.box(x - 3, 0, z - 3, x + 4, 3, z + 4, stone); pz.box(x - 2, 3, z - 2, x + 3, 4, z + 3, BM.GRASS);
      pz.box(x, 3, z, x + 1, th + 2, z + 1, BM.TRUNK);
      pz.box(x - 4, th, z - 3, x + 5, th + 4, z + 4, BM.LEAF); pz.box(x - 3, th - 1, z - 4, x + 4, th + 5, z + 5, BM.LEAF);
      pz.box(x - 2 + (hv < 0.5 ? 1 : 0), th + 4, z - 2, x + 3, th + 7, z + 2 + (hv < 0.5 ? 0 : 1), BM.LEAF_DARK);
      pz.box(x + (hv < 0.5 ? -5 : 4), th + 1, z - 1, x + (hv < 0.5 ? -3 : 6), th + 4, z + 2, BM.LEAF_DARK);
    };
    const zt = Math.round(stepD + (gz0 - stepD) * 0.45);
    if (gz0 - stepD >= 14) {
      for (let x = 10; x < W - 10; x += 22) if (x < gx0 + 8 || x > gx1 - 8 || gz0 - zt > 10) tree(x, zt);
      // benches along the planter line
      for (let x = 20; x < W - 20; x += 44) pz.box(x, 0, zt + 7, x + 8, 2, zt + 9, BM.GRANITE_DARK);
    }
    if (gz0 - stepD >= 20 && W >= 90) {
      // a red steel stabile, off-centre: two splayed legs and a sweeping arm
      const sx = R() < 0.5 ? Math.round(W * 0.28) : Math.round(W * 0.68), sz = Math.round(stepD + (gz0 - stepD) * 0.55);
      for (let y = 0; y < 22; ++y) {
        const a = Math.round(y * 0.35);
        pz.box(sx - 6 + a, y, sz - 1, sx - 4 + a, y + 1, sz + 1, BM.AWNING_RED);
        pz.box(sx + 5 - a, y, sz - 2 + (y >> 3), sx + 7 - a, y + 1, sz + (y >> 3), BM.AWNING_RED);
      }
      for (let k = 0; k < 14; ++k) pz.box(sx - 2 + k, 22 + Math.round(Math.sin(k / 4) * 3), sz - 1, sx + k, 24 + Math.round(Math.sin(k / 4) * 3), sz + 1, BM.AWNING_RED);
    }
    for (let k = 0; k < 3; ++k) {                                                    // flagpoles
      const fx = (gx0 + gx1 >> 1) - 8 + k * 8, fz = stepD + 3;
      pz.box(fx, 0, fz, fx + 1, 34, fz + 1, BM.METAL);
      pz.box(fx + 1, 28, fz, fx + 6, 32, fz + 1, [BM.AWNING_BLUE, BM.AWNING_RED, BM.TRIM][k]);
    }
    E.vox(C, pz, 0, plH, 0);

    // ---- antennas on the tallest tubes, a window-washing gantry on the top roof
    const top = levels[levels.length - 1], tall = [];
    for (let i = 0; i < T; ++i) if (ht[i] === top) tall.push(i);
    tall.slice(0, 2).forEach((i, k) => {
      const [x0, z0, x1, z1] = tubeRect(i);
      const H = 90 + Math.floor(R() * 70) - k * 15;
      const M = new VM(20, H + 4, 20, 10, 10);
      M.box(-5, 0, -5, 5, 6, 5, BM.STEEL_DARK); M.box(-3, 6, -3, 3, 10, 3, BM.METAL);
      M.box(-1, 10, -1, 2, Math.round(H * 0.45), 2, BM.TRIM);
      M.box(-1, Math.round(H * 0.45), -1, 1, Math.round(H * 0.8), 1, BM.TRIM);
      M.box(0, Math.round(H * 0.8), 0, 1, H, 1, BM.METAL);
      for (let y = 22; y < H * 0.8; y += 18) M.box(-2, y, -2, 3, y + 1, 3, BM.METAL);
      M.box(0, H, 0, 1, H + 1, 1, BM.BEACON);
      M.box(-2, Math.round(H * 0.45), -2, -1, Math.round(H * 0.45) + 1, -1, BM.BEACON);
      E.vox(C, M, (x0 + x1) >> 1, yBody + top * FH, (z0 + z1) >> 1);
    });
    if (tall.length === 1 || R() < 0.5) {
      const [x0, z0, x1] = tubeRect(tall[tall.length - 1]);
      if (x1 - x0 >= 24) E.vox(C, L.craneModel(x1 - x0 - 10), x0 + 5, yTop, z0 + 4);
    }
  }
  A.registerTower('bundled', towerBundled);
})();
