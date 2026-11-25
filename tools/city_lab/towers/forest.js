// Tower 'forest': a vertical-forest residential slab. Every storey carries staggered cantilevered balconies with
// planters and real trees; glazing sits back behind white slab edges. It rises from its own stone podium with
// shopfronts and an entrance canopy, and ends in a roof garden around a slim mechanical crown.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  const HALF_PI = Math.PI / 2;

  // a voxel tree: trunk + three or four offset canopy layers (dark underside, light crown).
  // (x, z) trunk cell, y base; s = canopy half-width; top = max y (exclusive) the canopy may reach
  function tree(M, x, y, z, s, top, R, dark, zin) {
    const hs = [2, s >= 5 ? 4 : 3, 2, s >= 4 ? 2 : 1], rs = [s - 1, s, s - 1, Math.max(1, s - 2)];
    let ch = hs.reduce((a, b) => a + b, 0);
    const room = top - y - 2;
    let nl = 4; while (nl > 2 && ch > room) ch -= hs[--nl];
    const c0 = Math.max(y + 2, top - ch);
    M.box(x, y, z, x + 1, c0 + 1, z + 1, BM.TRUNK);
    let yy = c0, jx = 0, jz = 0;
    for (let i = 0; i < nl && yy < top; ++i) {
      const r = rs[i], hh = Math.min(hs[i], top - yy), ra = r + (R() < 0.5 ? 1 : 0);
      const m = i === 0 ? BM.LEAF_DARK : (i === 1 && dark ? BM.LEAF_DARK : BM.LEAF);
      M.box(x - ra + jx, yy, z - Math.min(r, zin === undefined ? 99 : zin) + (zin === undefined ? jz : 0), x + ra + 1 + jx, yy + hh, z + r + 1 + jz, m);
      yy += hh; jx = R() < 0.35 ? (R() < 0.5 ? -1 : 1) : 0; jz = R() < 0.35 ? (R() < 0.5 ? -1 : 1) : 0;
    }
  }

  // balcony layout per face (0 front, 1 back, 2 left, 3 right) and floor: [{u, len, bd, trees, seed}]
  function makeLayout(R, lens, n, opts) {
    const out = [];
    for (let k = 0; k < 4; ++k) {
      const len = lens[k], P = opts.P + (k >= 2 ? opts.dPs : 0), m0 = 7, ns = Math.max(1, Math.floor((len - 2 * m0) / P));
      const used = ns * P, off = m0 + Math.floor((len - 2 * m0 - used) / 2);
      const faceShift = (k === 1 || k === 2) ? 1 : 0;
      const floors = [];
      for (let f = 0; f < n; ++f) {
        const list = [];
        if (f === 0 || f === n - 1) { floors.push(list); continue; }           // ground + top storey: none
        const ph = ((f + faceShift) % 2) * 0.5;
        for (let i = -1; i <= ns; ++i) {
          const c = off + (i + 0.5 + ph) * P + Math.round((R() - 0.5) * P * 0.3);
          const bl = Math.min(P - 6, opts.Lb + Math.floor(R() * 5) - 2);
          const u = Math.round(c - bl / 2);
          if (u < m0 || u + bl > len - m0) continue;
          if (R() < opts.skip) continue;
          list.push({ u, len: bl, bd: opts.bd + (R() < 0.25 ? 1 : 0), trees: bl >= 19 ? 2 : 1, seed: (R() * 1e9) | 0 });
        }
        floors.push(list);
      }
      out.push(floors);
    }
    return out;
  }

  // tower facade: white slab edges, glass at depth 1, frames; tall balcony doors behind each balcony
  function skinForest(S, layout) {
    let face = 0;
    return (len, h) => {
      if (self.__mark && face === 0) __mark('podium');
      const k = face++ % 4, F = new L.Relief(len, h, 1, S.panel), n = Math.floor(h / FH);
      for (let f = 0; f < n; ++f) {
        const v = f * FH;
        // floor-to-ceiling glazing in 2 m bays, some opaque panels, shifting floor to floor
        for (let u = 0; u < len; u += 8) {
          if (L.H2(S.seed + k, (u / 8) | 0, f >> 1) < 0.2) { F.rect(u, v + 2, Math.min(len, u + 8), v + FH, 2, S.panel); continue; }
          F.rect(u, v + 2, Math.min(len, u + 8), v + FH, 1, L.glassMat(S.seed, u + k * 997, f, 0.34, S.tint));
          F.rect(u, v + 2, u + 1, v + FH, 2, BM.STEEL_DARK);
        }
        const bal = layout[k][f] || [];
        for (const b of bal) {                                                             // balcony doors
          F.rect(b.u + 1, v + 2, b.u + b.len - 1, v + FH, 1, L.glassMat(S.seed, b.u + k * 37, f + 500, 0.45, S.tint));
          F.rect(b.u, v + 2, b.u + 1, v + FH, 2, S.slab); F.rect(b.u + b.len - 1, v + 2, b.u + b.len, v + FH, 2, S.slab);
        }
        F.rect(0, v, len, v + 2, 3, S.slab);                                                 // slab edge
      }
      F.rect(0, 0, 2, n * FH, 3, S.slab); F.rect(len - 2, 0, len, n * FH, 3, S.slab);       // corner piers
      if (h > n * FH) { F.rect(0, n * FH, len, h, 3, S.slab); F.rect(0, h - 1, len, h, 4, S.slab); }
      F.returns();
      return F;
    };
  }

  // one VoxModel per facade: every balcony with planter, shrubs, hanging green and trees
  function balconyModel(layout, k, len, n, S, bdMax) {
    const YO = 6, oz = bdMax + 6;
    const M = new (L.VoxModel())(len, n * FH + YO + 4, oz + 1, 0, oz);
    const box = (u0, y0, d0, u1, y1, d1, m) => M.box(u0, y0 + YO, -d1, u1, y1 + YO, -d0, m);
    for (let f = 0; f < n; ++f) for (const b of layout[k][f]) {
      const R = mul(b.seed), y = f * FH, u0 = b.u, u1 = b.u + b.len, bd = b.bd;
      box(u0, y, -1, u1, y + 2, bd, S.slab);                                // slab, 1 voxel into the facade
      box(u0, y - 1, bd - 1, u1, y + 4, bd, S.slab);                        // edge beam + planter wall
      box(u0, y + 2, bd - 3, u1, y + 3, bd - 1, S.slab);                    // planter
      box(u0, y + 3, bd - 3, u1, y + 4, bd - 1, BM.GRASS);                  // groundcover
      // shrubs on the planter, green spilling over the edge
      const ns = R() < 0.6 ? 1 : 0;
      for (let i = 0; i < ns; ++i) {
        const w = 3 + Math.floor(R() * 4), u = u0 + 1 + Math.floor(R() * Math.max(1, b.len - w - 2));
        box(u, y + 4, bd - 3, u + w, y + 5 + Math.floor(R() * 2), bd - (R() < 0.5 ? 0 : 1), R() < 0.5 ? BM.LEAF : BM.LEAF_DARK);
      }
      if (R() < 0.7) {
        const w = 3 + Math.floor(R() * 5), u = u0 + 1 + Math.floor(R() * Math.max(1, b.len - w - 2));
        box(u, y - 1 - Math.floor(R() * 3), bd, u + w, y + 4, bd + 1, R() < 0.6 ? BM.LEAF_DARK : BM.LEAF);
      }
      // trees: trunk in the planter, canopy under the next slab
      const nt = b.trees, top = y + FH - 1;
      for (let t = 0; t < nt; ++t) {
        const tu = Math.round(u0 + b.len * (nt === 1 ? 0.3 + R() * 0.4 : (t + 0.5) / nt)), s = nt === 1 ? 4 + (R() < 0.4 ? 1 : 0) : 3 + (R() < 0.5 ? 1 : 0);
        tree({ box }, tu, y + 4, bd - 2, s, top - (R() < 0.3 ? 1 : 0), R, R() < 0.5, bd - 3);
      }
    }
    return { M, YO };
  }
  function mul(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // podium: stone, glass shopfronts between piers, entrance in the middle of the front, planted sills above
  function skinPodium(S, nUp) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 3, S.stone), gH = 20;
      F.rect(0, 0, len, 2, 3, S.stoneDark);                                                 // plinth
      const bw = S.bayW, cs = L.bays(len, bw, 3), mid = cs.length >> 1;
      cs.forEach((c, i) => {
        const a = c - (bw >> 1) + 2, b = c + (bw >> 1) - 1;
        if (info.front && i === mid && len > 40) {                                           // entrance
          F.rect(a - 2, 0, b + 2, gH - 2, 0, L.glassMat(S.seed, 3, 3, 0.7, 'dark'));
          for (let u = a - 2; u < b + 2; u += 4) F.rect(u, 0, u + 1, gH - 2, 1, BM.BRONZE);
          F.rect(c - 3, 0, c + 3, 10, 1, BM.BRONZE); F.rect(c - 2, 0, c + 2, 9, 0, BM.GLASS_DARK_LIT);
          return;
        }
        F.rect(a, 2, b, gH - 6, 1, L.glassMat(S.seed, i, info.front ? 1 : 2, 0.5, 'dark'));   // shop window
        F.rect(a, 7, b, 8, 1, BM.MULLION);
        F.rect(a, gH - 6, b, gH - 5, 1, BM.MULLION);
        F.rect(a, gH - 5, b, gH - 2, 1, L.glassMat(S.seed, i, 9, 0.5, 'dark'));               // clerestory
        F.rect(a + 1, gH - 9, b - 1, gH - 7, 3, BM.TRIM_DARK);                               // sign band
        if (L.H2(S.seed, i, 4) < 0.5) F.rect(a - 1, gH - 7, b + 1, gH - 6, 5, S.awning);       // awning
      });
      for (let u = 0; u < len; u += bw) F.rect(Math.max(0, u - 1), 0, Math.min(len, u + 2), gH, 3, S.stone);
      F.rect(0, gH - 2, len, gH, 3, S.stoneDark);
      // upper podium storeys: tall windows, stone frames, planted window boxes
      for (let f = 0; f < nUp; ++f) {
        const v = gH + f * FH;
        cs.forEach((c, i) => {
          for (const dx of [-(bw >> 2), bw >> 2]) {
            const w2 = Math.max(3, (bw >> 1) - 3);
            F.rect(c + dx - (w2 >> 1), v + 3, c + dx - (w2 >> 1) + w2, v + FH - 1, 1, L.glassMat(S.seed, i * 5 + dx, f + 20, 0.36));
            F.rect(c + dx - (w2 >> 1) - 1, v + 2, c + dx - (w2 >> 1) + w2 + 1, v + 3, 3, S.stoneDark);
            if (L.H2(S.seed, i + dx, f) < 0.45) F.rect(c + dx - (w2 >> 1), v + 3, c + dx - (w2 >> 1) + w2, v + 4, 4, BM.LEAF_DARK);
          }
          F.rect(c - 1, v + 2, c + 1, v + FH, 3, S.stone);                                   // mullion pier
        });
      }
      const t = gH + nUp * FH;
      F.rect(0, t, len, t + 1, 3, S.stoneDark); F.rect(0, t + 1, len, h - 1, 4, S.stone); F.rect(0, h - 1, len, h, 5, S.stoneDark);
      F.returns();
      return F;
    };
  }

  function towerForest(E, C, W, D, spec, R) {
    const S = {
      seed: spec.seed, stone: L.pick(R, [BM.LIMESTONE, BM.BUFF, BM.LIMESTONE_DARK]), stoneDark: L.pick(R, [BM.GRANITE_DARK, BM.LIMESTONE_DARK]),
      awning: L.pick(R, [BM.AWNING_GREEN, BM.AWNING_BLUE, BM.AWNING_RED]), bayW: L.pick(R, [14, 16, 18]),
      slab: L.pick(R, [BM.WHITE_CONCRETE, BM.WHITE_CONCRETE, BM.TRIM]), tint: L.pick(R, [undefined, 'dark', 'curtain'])
    };
    S.panel = L.pick(R, [BM.CONCRETE, BM.PRECAST, BM.LIMESTONE_DARK, BM.STEEL_DARK]);
    S.planter = L.pick(R, [S.slab, BM.CONCRETE, BM.STEEL_DARK]);
    const nUp = 2 + (R() < 0.5 ? 1 : 0), pH = 20 + nUp * FH + 4;
    const n = Math.max(14, Math.min(34, Math.round(spec.floors * (0.85 + R() * 0.25))));
    const bdMax = 9, sideM = Math.max(bdMax + 3, Math.round(W * 0.1), (W - 128) >> 1);
    const front = Math.max(bdMax + 12, Math.round(D * 0.18)), back = Math.max(bdMax + 3, Math.round(D * 0.08), D - front - 112);
    const x0 = sideM, x1 = W - sideM, z0 = front, z1 = D - back;
    const tw = x1 - x0, td = z1 - z0, perim = 2 * (tw + td);
    // balcony density from the triangle budget: facade ~2.4 tris per voxel of perimeter per storey, ~110 per balcony
    const nb = Math.max(120, (96000 - 2.4 * n * perim - 12000) / 125);
    const Pm = Math.max(26, Math.min(48, Math.round(n * perim / nb))) + Math.floor(R() * 4);
    const layout = makeLayout(R, [tw, tw, td, td], n, { P: Pm, dPs: Math.floor(R() * 5) - 2, Lb: Math.max(15, Math.min(24, Math.round(Pm * 0.55))), bd: 6 + (R() < 0.5 ? 1 : 0), skip: 0.06 + R() * 0.08 });
    const crownW = Math.max(16, Math.round(tw * (0.3 + R() * 0.15))), crownD = Math.max(14, Math.round(td * (0.35 + R() * 0.2)));
    const cx0 = x0 + Math.round((tw - crownW) * (0.3 + R() * 0.4)), cz0 = z0 + Math.round((td - crownD) * 0.6);
    const tiers = [
      { x0: 0, z0: 0, x1: W, z1: D, h: pH, skin: skinPodium(S, nUp), party: spec.party, roof: { mat: S.stoneDark, deck: BM.CONCRETE, parapet: 3 } },
      { x0, z0, x1, z1, h: n * FH + 3, skin: skinForest(S, layout), roof: { mat: S.slab, deck: BM.GRASS, parapet: 4 } },
      { x0: cx0, z0: cz0, x1: cx0 + crownW, z1: cz0 + crownD, h: 2 * FH + 2, skin: L.skinLouver({ frame: S.slab }), roof: { mat: S.slab, units: 2 } }
    ];
    const yTop = L.buildTiers(E, C, W, D, tiers, spec.seed);
    self.__mark && __mark('tiers');
    if (self.__mark) console.log('balconies', layout.flat(2).length);
    const yT = pH, yR = pH + n * FH + 3;

    // balconies: one model per facade, rotated onto its face; half a voxel off the relief grid (no coplanar faces)
    const faces = [[x0, z0, 0, tw], [x1, z1, Math.PI, tw], [x0, z1, -HALF_PI, td], [x1, z0, HALF_PI, td]];
    faces.forEach(([cx, cz, th, len], k) => {
      const { M, YO } = balconyModel(layout, k, len, n, S, bdMax);
      L.rotated(E, cx, cz, th, 0, 0).vox(C, M, 0, yT + 0.5 - YO, -0.5);
    });

    self.__mark && __mark('balc');
    // roof garden: big trees in raised planters, timber deck paths, around the crown
    const Rg = mul(spec.seed * 7 + 3), gw = tw - 8, gd = td - 8;
    const G = new (L.VoxModel())(gw, 34, gd, 0, 0);
    const free = (x, z, r) => x - r > 1 && z - r > 1 && x + r < gw - 2 && z + r < gd - 2 &&
      (x + r < cx0 - x0 - 4 - 1 || x - r > cx0 - x0 - 4 + crownW + 1 || z + r < cz0 - z0 - 4 - 1 || z - r > cz0 - z0 - 4 + crownD + 1);
    let placed = 0;
    for (let t = 0; t < 40 && placed < 6 + ((tw * td) / 900 | 0); ++t) {
      const r = 3 + Math.floor(Rg() * 3), x = Math.floor(Rg() * gw), z = Math.floor(Rg() * gd);
      if (!free(x, z, r + 1)) continue;
      let clash = false;
      for (let yy = 4; yy < 6 && !clash; ++yy) if (G.at(x + G.ox, yy, z + G.oz)) clash = true;
      if (clash) continue;
      G.box(x - 2, 0, z - 2, x + 3, 3, z + 3, S.planter); G.box(x - 1, 2, z - 1, x + 2, 3, z + 2, BM.GRASS);
      tree(G, x, 3, z, r, 3 + 3 + Math.floor(Rg() * 3) + 7 + Math.min(4, r), Rg, Rg() < 0.5);
      ++placed;
    }
    // perimeter hedge planters (inside the parapet)
    for (let x = 2; x < gw - 2; x += 9) if (free(x + 3, 2, 2)) { G.box(x, 0, 0, x + 7, 3, 2, S.planter); G.box(x, 3, 0, x + 7, 5, 2, BM.LEAF_DARK); }
    for (let x = 2; x < gw - 2; x += 9) if (free(x + 3, gd - 3, 2)) { G.box(x, 0, gd - 2, x + 7, 3, gd, S.planter); G.box(x, 3, gd - 2, x + 7, 5, gd, BM.LEAF); }
    E.vox(C, G, x0 + 4, yR, z0 + 4);
    // slim mechanical crown: white frame continuing above the louvres, with a mast
    const cw = crownW, cd = crownD, K = new (L.VoxModel())(cw + 3, 30, cd + 3, 1, 1);
    for (const [px, pz] of [[-1, -1], [cw - 2, -1], [-1, cd - 2], [cw - 2, cd - 2]]) K.box(px, 0, pz, px + 3, 14, pz + 3, S.slab);
    K.box(-1, 12, -1, cw + 1, 14, 1, S.slab); K.box(-1, 12, cd - 1, cw + 1, 14, cd + 1, S.slab);
    K.box(-1, 12, 1, 1, 14, cd - 1, S.slab); K.box(cw - 1, 12, 1, cw + 1, 14, cd - 1, S.slab);
    K.box((cw >> 1) - 1, 0, (cd >> 1) - 1, (cw >> 1) + 1, 26, (cd >> 1) + 1, BM.METAL); K.box((cw >> 1) - 1, 26, (cd >> 1) - 1, (cw >> 1) + 1, 27, (cd >> 1) + 1, BM.BEACON);
    E.vox(C, K, cx0 + 0.5, yTop, cz0 + 0.5);

    self.__mark && __mark('roof');
    // podium roof terrace: planters with small trees along the front and sides; entrance canopy
    const P = new (L.VoxModel())(W, 30, D, 0, 0), Rp = mul(spec.seed * 13 + 1);
    for (let x = 4; x < W - 10; x += 14 + Math.floor(Rp() * 6)) {
      P.box(x, 0, 4, x + 8, 3, 10, S.planter); P.box(x + 1, 2, 5, x + 7, 3, 9, BM.GRASS);
      tree(P, x + 4, 3, 7, 2 + Math.floor(Rp() * 2), 15 + Math.floor(Rp() * 4), Rp, Rp() < 0.5);
    }
    for (const xs of [4, W - 8]) for (let z = front + 4; z < D - 12; z += 16) {
      if ((xs < 10 ? x0 : W - x1) < 14) break;
      P.box(xs, 0, z, xs + 4, 3, z + 9, S.planter); P.box(xs, 3, z, xs + 4, 5, z + 9, BM.LEAF_DARK);
    }
    E.vox(C, P, 0, pH, 0);
    if (W > 44) {                                                                          // entrance canopy
      const cs = L.bays(W, S.bayW, 3), c = cs[cs.length >> 1], cw2 = S.bayW + 8, Q = new (L.VoxModel())(cw2, 4, 18, 0, 16);
      Q.box(0, 1, -16, cw2, 3, 2, S.slab); Q.box(0, 0, -16, cw2, 1, -15, S.slab); Q.box(2, 0, -14, cw2 - 2, 1, 0, BM.LED);
      Q.box(0, 3, -16, cw2, 4, -14, BM.LEAF);
      E.vox(C, Q, c - (cw2 >> 1), 15.5, -0.5);
    }
  }

  A.registerTower('forest', towerForest);
})();
