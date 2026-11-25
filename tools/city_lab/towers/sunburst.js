// 'sunburst': a late-1920s machine-age Art Deco skyscraper. A granite and bronze lobby storey with a tall
// sunburst portal and a lit marquee; a dark brick body striped by continuous white piers that rises in three
// setbacks; steel eagles at the last setback; a gleaming steel crown of stacked, diminishing arches with
// triangular lit windows between sunburst rays, finished with a slender needle.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH, H2 = L.H2;

  // office floors: recessed windows over chevron spandrels between continuous white piers
  function paintShaft(F, len, v0, n, S, salt) {
    const bw = S.bay, cs = L.bays(len, bw, 5), half = bw >> 1;
    for (let f = 0; f < n; ++f) {
      const v = v0 + f * FH;
      cs.forEach((c, k) => {
        F.rect(c - 2, v, c + 2, v + 4, 1, S.spandrel);
        if (f % 2 === 0) F.rect(c - 1, v + 1, c + 1, v + 3, 1, S.accent);           // stamped metal boss
        F.rect(c - 2, v + 4, c + 2, v + FH, 1, L.glassMat(S.seed, k * 7 + salt, v, 0.3));
        F.rect(c - 2, v + 9, c + 2, v + 10, 1, BM.TRIM_DARK);                     // meeting rail
      });
    }
    const top = v0 + n * FH;
    cs.forEach((c, k) => {
      const major = S.alt ? k % 2 === 0 : true;
      F.rect(c - half - 1, v0, c - half + 1, top, major ? 4 : 3, major ? S.white : S.brick);
    });
    const last = cs[cs.length - 1] + half;
    F.rect(last - 1, v0, last + 1, top, 4, S.white);
    // brick corner piers with a white quoin stripe
    const off = cs[0] - half - 1;
    if (off > 0) { F.rect(0, v0, off, top, 3, S.brick); F.rect(len - off, v0, len, top, 3, S.brick); }
    if (off > 3) { F.rect(1, v0, 2, top, 4, S.white); F.rect(len - 2, v0, len - 1, top, 4, S.white); }
    return cs;
  }
  // parapet frieze: white zig-zag teeth between pier heads, metal coping
  function paintCap(F, len, v0, h, S, cs) {
    const half = S.bay >> 1;
    F.rect(0, v0, len, v0 + 1, 3, S.white);
    for (let u = 0; u < len; ++u) {
      const t = 3 - Math.abs((u % 6) - 3);
      F.rect(u, v0 + 1, u + 1, v0 + 2 + t, 3, S.white);
    }
    F.rect(0, h - 2, len, h - 1, 3, S.brick);
    F.rect(0, h - 1, len, h, 4, S.coping);
    cs.forEach((c) => { F.rect(c - half - 1, v0, c - half + 1, h - 1, 5, S.white); });
    const last = cs[cs.length - 1] + half;
    F.rect(last - 1, v0, last + 1, h - 1, 5, S.white);
  }
  function skinBody(S, salt) {
    return (len, h) => {
      const F = new L.Relief(len, h, 3, S.brick), n = Math.floor((h - 8) / FH);
      const cs = paintShaft(F, len, 0, n, S, salt);
      paintCap(F, len, n * FH, h, S, cs);
      F.returns();
      return F;
    };
  }
  // granite and bronze lobby storey: shopfronts, a sunburst portal with a lit marquee; brick office floors above
  function skinBase(S, nb) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, S.brick), gH = 22;
      F.rect(0, 0, len, gH, 2, S.gran);
      F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);                                    // polished plinth
      F.rect(0, gH, len, gH + 2, 4, BM.BRONZE);                                    // bronze lobby fascia
      const cs = paintShaft(F, len, gH + 2, nb, S, 3);
      paintCap(F, len, gH + 2 + nb * FH, h, S, cs);
      const ss = L.bays(len, 16, 5), cm = len >> 1, portal = info.front && len > 60;
      ss.forEach((c, k) => {
        if (portal && Math.abs(c - cm) < 24) return;
        F.rect(c - 8, 0, c - 6, gH, 3, S.gran);                                    // granite pilasters
        if (k === ss.length - 1 || (portal && Math.abs(c + 16 - cm) < 24)) F.rect(c + 8, 0, c + 10, gH, 3, S.gran);
        F.rect(c - 5, 2, c + 5, gH - 2, 1, BM.BRONZE);                             // bronze shopfront
        F.rect(c - 4, 3, c + 4, 13, 0, L.glassMat(S.seed, k, 40, 0.55, 'dark'));
        for (let u = c - 4; u < c + 4; u += 2) F.rect(u, 15, u + 1, gH - 4, 0, L.glassMat(S.seed, k, u, 0.5, 'dark'));
        if (k % 3 === 1) F.rect(c + 1, 2, c + 4, 13, 0, BM.STOREFRONT);              // shop door
        F.rect(c - 6, gH - 3, c + 6, gH - 1, 3, BM.BRONZE);                        // sign band
      });
      if (portal) {
        // a two-storey portal: bronze doors, sunburst transom, stepped white reveals, a lit marquee
        const c = cm, hw = 10, pH = gH + 2 + FH + 4, cy = 19;
        F.rect(c - hw, 0, c + hw, pH, 0, BM.BRONZE);
        for (let i = 0; i < 4; ++i) F.rect(c - 9 + i * 5, 1, c - 9 + i * 5 + 3, 10, 0, L.glassMat(S.seed, i, 77, 0.7, 'dark'));
        for (let v = cy; v < pH; ++v) for (let u = c - hw; u < c + hw; ++u) {        // sunburst transom grille
          const dx = u + 0.5 - c, dy = v + 0.5 - cy, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
          const ray = (a / (Math.PI / 11)) % 1;
          if (r < 3.5 || u === c - hw || u === c + hw - 1 || v === pH - 1) F.set(u, v, 1, BM.BRONZE);
          else if (ray < 0.3) F.set(u, v, 1, BM.BRONZE);
          else F.set(u, v, 0, H2(S.seed, u, v) < 0.8 ? BM.GLASS_LIT : BM.GLASS);
        }
        for (let s2 = 0; s2 < 3; ++s2) {                                           // stepped white reveals
          F.rect(c - hw - 3 + s2, 0, c - hw - 2 + s2, pH + 3 - s2, 5 - s2, S.white);
          F.rect(c + hw + 2 - s2, 0, c + hw + 3 - s2, pH + 3 - s2, 5 - s2, S.white);
          F.rect(c - hw - 3 + s2, pH + 2 - s2, c + hw + 3 - s2, pH + 3 - s2, 5 - s2, S.white);
        }
        F.rect(c - 3, pH + 3, c + 3, pH + 6, 4, BM.BRONZE);                        // keystone clock plaque
        F.rect(c - 2, pH + 4, c + 2, pH + 5, 4, BM.TRIM);
        for (const sx of [-1, 1]) {                                                // bronze lanterns either side
          const u = c + sx * (hw + 7);
          F.rect(u - 1, 9, u + 1, 16, 5, BM.BRONZE); F.rect(u - 1, 11, u + 1, 14, 5, BM.GLASS_LIT);
          F.rect(u - 2, 2, u + 2, 6, 3, BM.BRONZE);                                // name plaque
        }
        // marquee: bulb rows round a white letter board, bronze cap
        const m0 = 11, mu0 = c - hw - 6, mu1 = c + hw + 6;
        F.rect(mu0, m0, mu1, m0 + 1, 9, BM.LED);
        F.rect(mu0, m0 + 1, mu1, m0 + 6, 9, BM.WHITE_CONCRETE);
        for (const vr of [m0 + 2, m0 + 4]) for (let u = mu0 + 2; u < mu1 - 2; ++u) if (H2(S.seed, u, vr) < 0.62 && u % 5 !== 1) F.set(u, vr, 9, BM.TRIM_DARK);
        F.rect(mu0, m0 + 6, mu1, m0 + 7, 9, BM.LED);
        F.rect(mu0 - 1, m0 + 7, mu1 + 1, m0 + 8, 9, BM.BRONZE);
      }
      F.returns();
      return F;
    };
  }

  // steel eagle head projecting along +x from a corner (origin), for a rotated emitter
  function eagleModel(S) {
    const M = new (L.VoxModel())(22, 16, 10, 6, 5), m = BM.METAL, d = BM.STEEL_DARK;
    M.box(-5, 0, -2, 4, 3, 2, d);                     // bracket
    M.box(-5, 3, -2, 7, 6, 2, m);                     // neck
    M.box(-3, 6, -4, 5, 8, 4, m);                     // swept wing ruff
    M.box(-3, 8, -2, 3, 10, 2, S.coping);
    M.box(6, 4, -2, 11, 9, 2, m);                     // head
    M.box(11, 4, -1, 14, 7, 1, S.coping);             // beak
    M.box(13, 3, -1, 14, 4, 1, S.coping);
    M.box(9, 7, -2, 10, 8, -1, d); M.box(9, 7, 1, 10, 8, 2, d);   // eyes
    return M;
  }
  // winged radiator-cap ornament for the lower setback corners
  function wingModel(S) {
    const M = new (L.VoxModel())(16, 16, 16, 6, 8), m = BM.METAL;
    M.box(-4, 0, -2, 3, 4, 2, BM.STEEL_DARK);
    M.box(-3, 4, -2, 5, 8, 2, m);                     // cap body
    M.box(-1, 8, -2, 4, 10, 2, S.coping);             // crest
    for (let i = 0; i < 4; ++i) M.box(-2 + i, 5 + i, -7 + i, 0 + i, 6 + i, 7 - i, m);   // swept wings
    M.box(5, 5, -1, 8, 7, 1, S.coping);               // snout
    return M;
  }
  // stacked diminishing arches on all four faces, sunburst rays with triangular lit windows, needle spire
  function crownModel(s, S) {
    const A0 = (s >> 1) - 2, P = S.plinth, st = S.st, rays = S.rays;
    const lv = [];
    for (let k = 0, a = A0; a >= 6; ++k, a -= S.step) lv.push({ a, y: P + k * S.rise });
    const prof = (a, u) => S.para ? st * a * (1 - (u * u) / (a * a)) : st * Math.sqrt(Math.max(0, a * a - u * u));
    const Hc = (x, z) => {
      const u = x + 0.5, w = z + 0.5;
      let h = 0;
      for (const L0 of lv) if (Math.abs(u) < L0.a && Math.abs(w) < L0.a) h = Math.max(h, L0.y + Math.max(prof(L0.a, u), prof(L0.a, w)));
      return Math.floor(h);
    };
    let top = 0; for (const L0 of lv) top = Math.max(top, Math.ceil(L0.y + st * L0.a));
    const needle = S.needle, M = new (L.VoxModel())(2 * A0 + 4, top + needle + 30, 2 * A0 + 4, A0 + 2, A0 + 2);
    const HC = {};
    for (let z = -A0; z < A0; ++z) for (let x = -A0; x < A0; ++x) {
      const h = Hc(x, z); HC[x + ',' + z] = h;
      if (h > 0) M.box(x, 0, z, x + 1, h, z + 1, BM.METAL);
    }
    const hAt = (x, z) => HC[x + ',' + z] || 0;
    // drum: alternating steel ribs and dark recesses with small lit openings
    for (let t = -A0; t < A0; ++t) for (let y = 0; y < P; ++y) {
      const rib = ((t + A0) % 3) === 0 || y === 0 || y === P - 1;
      const m = rib ? BM.METAL : (y > 1 && y < P - 2 && ((t + A0) % 6) === 2 ? (H2(S.seed, t, y) < 0.6 ? BM.GLASS_LIT : BM.GLASS) : BM.STEEL_DARK);
      for (const [x, z] of [[t, -A0], [t, A0 - 1], [-A0, t], [A0 - 1, t]]) M.box(x, y, z, x + 1, y + 1, z + 1, m);
    }
    // the four faces of each arch: rim, rays, triangular windows (recessed one voxel)
    lv.forEach((L0, k) => {
      const a = L0.a;
      const faces = [
        (t, y) => [t, y, -a, t, -a - 1, t, -a + 1], (t, y) => [t, y, a - 1, t, a, t, a - 2],
        (t, y) => [-a, y, t, -a - 1, t, -a + 1, t], (t, y) => [a - 1, y, t, a, t, a - 2, t]
      ];
      for (const fc of faces) for (let t = -a; t < a; ++t) for (let y = L0.y; y < L0.y + st * a + 1; ++y) {
        const [x, yy, z, ox, oz, ix, iz] = fc(t, y);
        if (y >= hAt(x, z) || y < hAt(ox, oz)) continue;                     // not an exposed face voxel
        const du = t + 0.5, dv = (y + 0.5 - L0.y) / st, r = Math.hypot(du, dv) / a, ang = Math.atan2(dv, du);
        if (r > 1.02) continue;
        if (r > 0.86) { M.box(x, yy, z, x + 1, yy + 1, z + 1, k % 2 ? S.coping : BM.METAL); continue; }
        const seg = (ang / (Math.PI / rays)) % 1 - 0.5, r0 = 0.2, r1 = 0.8;
        const hw = 0.46 * (r - r0) / (r1 - r0);
        if (r > r0 && r < r1 && Math.abs(seg) < hw && y < hAt(ix, iz)) {
          M.box(x, yy, z, x + 1, yy + 1, z + 1, -1);                          // carve (material -1 -> empty)
          M.box(ix, yy, iz, ix + 1, yy + 1, iz + 1, H2(S.seed, t * 7 + k, y) < 0.85 ? BM.GLASS_LIT : BM.GLASS);
        } else if (r <= 0.12 || Math.abs(seg) > 0.44) M.box(x, yy, z, x + 1, yy + 1, z + 1, S.coping);   // ray ribs and hub
      }
    });
    // needle
    let yt = 0; for (let z = -2; z < 2; ++z) for (let x = -2; x < 2; ++x) yt = Math.max(yt, hAt(x, z));
    M.box(-2, yt - 2, -2, 2, yt + 6, 2, BM.METAL);
    M.box(-3, yt + 2, -3, 3, yt + 3, 3, S.coping);
    M.box(-1, yt + 6, -1, 1, yt + 6 + needle, 1, BM.METAL);
    for (let y = yt + 14; y < yt + needle - 6; y += 12) M.box(-2, y, -2, 2, y + 1, 2, S.coping);
    M.box(0, yt + 6 + needle, -1, 1, yt + 6 + needle + 8, 0, BM.METAL);
    M.box(0, yt + 6 + needle + 8, -1, 1, yt + 6 + needle + 9, 0, BM.BEACON);
    return M;
  }

  function towerSunburst(E, C, W, D, spec, R) {
    const brick = L.pick(R, [BM.BRICK_DARK, BM.BRICK_DARK, BM.BRICK_BROWN, BM.BRICK_RED, BM.LIMESTONE_DARK]);
    const S = {
      seed: spec.seed, brick, white: brick === BM.LIMESTONE_DARK ? BM.WHITE_CONCRETE : L.pick(R, [BM.WHITE_CONCRETE, BM.LIMESTONE]),
      spandrel: L.pick(R, [BM.STEEL_DARK, BM.BRONZE, BM.SPANDREL]), accent: BM.METAL, coping: BM.TRIM,
      gran: L.pick(R, [BM.GRANITE_DARK, BM.GRANITE_PINK]), bay: L.pick(R, [8, 8, 10]), alt: R() < 0.4,
      plinth: 6 + Math.floor(R() * 5), st: 1.25 + R() * 0.55, step: 4 + Math.floor(R() * 3), rays: 5 + Math.floor(R() * 4),
      para: R() < 0.35, needle: 40 + Math.floor(R() * 40), notch: L.pick(R, [0, 6, 8, 8, 10])
    };
    S.rise = Math.ceil(S.st * S.step) + 5 + Math.floor(R() * 5);
    const n = Math.max(22, Math.min(50, Math.round(spec.floors * (0.95 + R() * 0.3))));
    const nb = 4 + Math.floor(R() * 3), m = n - nb - 1;
    const n1 = Math.round(m * (0.25 + R() * 0.1)), n2 = 3 + Math.floor(R() * 3), n3 = Math.max(8, m - n1 - n2);
    const even = (v) => v & ~1;
    const sx1 = Math.round(W * (0.06 + R() * 0.04)), fz1 = Math.round(D * (0.08 + R() * 0.05));
    const t1 = { x0: sx1, z0: fz1, x1: W - sx1, z1: D - 4 };
    const sx2 = sx1 + Math.max(6, Math.round(W * (0.07 + R() * 0.04)));
    const t2 = { x0: sx2, z0: fz1 + Math.max(6, Math.round(D * 0.07)), x1: W - sx2, z1: D - 4 - Math.max(6, Math.round(D * 0.08)) };
    const t2w = Math.min(t2.x1 - t2.x0, t2.z1 - t2.z0), sMax = even(58 + Math.floor(R() * 12));
    const s = even(Math.min(sMax, t2w - 2 * Math.max(6, Math.round(W * 0.06))));
    const cx = W >> 1, cz = even((t2.z0 + t2.z1) >> 1);
    const t3 = { x0: cx - (s >> 1), z0: cz - (s >> 1), x1: cx + (s >> 1), z1: cz + (s >> 1) };
    const roof = { mat: S.coping, deck: BM.ROOF_TAR, parapet: 2 };
    let n3b = n3;
    const tiers = [
      { x0: 0, z0: 0, x1: W, z1: D, h: 22 + 2 + nb * FH + 8, skin: skinBase(S, nb), party: spec.party, roof: Object.assign({ units: 2 }, roof) },
      Object.assign(t1, { h: n1 * FH + 8, skin: skinBody(S, 11), roof: Object.assign({ units: 2 }, roof) }),
      Object.assign(t2, { notch: S.notch, h: n2 * FH + 8, skin: skinBody(S, 23), roof })
    ];
    if (t2w - s > 36) {                                   // wide lots: one more setback so the shaft stays slender
      const gx = Math.round((t2.x1 - t2.x0 - s) / 4), gz = Math.round((t2.z1 - t2.z0 - s) / 4), k = 2 + Math.floor(R() * 2);
      n3b = n3 - k;
      tiers.push({ x0: t2.x0 + gx, z0: t2.z0 + gz, x1: t2.x1 - gx, z1: t2.z1 - gz, notch: S.notch ? 6 : 0, h: k * FH + 8, skin: skinBody(S, 29), roof });
    }
    tiers.push(Object.assign(t3, { h: n3b * FH + 8, skin: skinBody(S, 37), roof: { mat: S.coping, deck: BM.METAL, parapet: 1 } }));
    const y = L.buildTiers(E, C, W, D, tiers, spec.seed);
    E.vox(C, crownModel(s, S), cx, y, cz);
    // eagles at the corners of the last setback, looking out over the city
    const eg = eagleModel(S), ey = y - 12;
    for (const [x, z, th] of [[t3.x1, t3.z0, -Math.PI / 4], [t3.x0, t3.z0, -3 * Math.PI / 4], [t3.x1, t3.z1, Math.PI / 4], [t3.x0, t3.z1, 3 * Math.PI / 4]]) {
      L.rotated(E, x, z, th, 0, 0).vox(C, eg, 0, ey, 0);
    }
    const wg = wingModel(S), t1t = tiers[1].y + tiers[1].h - 6;
    for (const [x, z, th] of [[t1.x1, t1.z0, -Math.PI / 4], [t1.x0, t1.z0, -3 * Math.PI / 4], [t1.x1, t1.z1, Math.PI / 4], [t1.x0, t1.z1, 3 * Math.PI / 4]]) {
      L.rotated(E, x, z, th, 0, 0).vox(C, wg, 0, t1t, 0);
    }
  }
  A.registerTower('sunburst', towerSunburst);
})();
