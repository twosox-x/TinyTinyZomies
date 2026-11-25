// 'gothic': a 1910s neo-Gothic "cathedral of commerce". A deep pointed-arch arcade shelters the lobby; a limestone /
// buff terracotta office block rises in continuous vertical ribs with recessed spandrels and pointed-arch top
// windows; a tower flush with the street front steps back in stages ringed by corner pinnacles, and ends in a
// steep copper pyramid with dormers, pinnacles and a lantern spire.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH, H2 = L.H2;

  // bays of 9: rib (2) | lancet (3) | colonette (1) | lancet (3)
  function ribBays(len) { return L.bays(len, 9, 3); }
  function paintRibs(F, len, v0, n, S, salt, top) {
    const cs = ribBays(len);
    for (let f = 0; f < n; ++f) {
      const v = v0 + f * FH, lastF = top && f === n - 1;
      cs.forEach((c, k) => {
        F.rect(c - 2, v, c + 5, v + 3, 1, S.spand);                               // recessed spandrel
        if (f % 2 === 1) { F.set(c - 1, v + 1, 1, S.trim); F.set(c + 3, v + 1, 1, S.trim); }   // tracery boss
        const vt = lastF ? v + FH + 2 : v + FH;
        F.rect(c - 2, v + 3, c + 1, vt, 1, L.glassMat(S.seed, k * 2 + salt, v, 0.3));
        F.rect(c + 2, v + 3, c + 5, vt, 1, L.glassMat(S.seed, k * 2 + 1 + salt, v, 0.3));
        if (lastF) {                                                              // pointed (stepped) tops
          F.rect(c - 1, vt, c, vt + 2, 1, L.glassMat(S.seed, k, v + 1, 0.3));
          F.rect(c + 3, vt, c + 4, vt + 2, 1, L.glassMat(S.seed, k, v + 2, 0.3));
        }
      });
    }
    const vTop = v0 + n * FH;
    cs.forEach((c) => {
      F.rect(c - 4, v0, c - 2, vTop, 4, S.stone);                                // continuous ribs
      F.rect(c + 1, v0, c + 2, vTop, 3, S.stone);                                // colonettes
    });
    const e = cs[cs.length - 1] + 5;
    F.rect(e, v0, e + 2, vTop, 4, S.stone);
    const off = cs[0] - 4;
    if (off > 0) {                                                                // corner piers with a shaft
      F.rect(0, v0, off, vTop, 4, S.stone); F.rect(len - off, v0, len, vTop, 4, S.stone);
      if (off > 2) { F.rect(1, v0, 2, vTop, 5, S.trim); F.rect(len - 2, v0, len - 1, vTop, 5, S.trim); }
    }
    return cs;
  }
  // tier top: string course over the pointed windows, corbel table, parapet; ribs run up as buttress heads
  function paintCap(F, len, r0, h, S, cs) {
    F.rect(0, r0 + 4, len, r0 + 5, 3, S.trim);
    for (const c of cs) {                                                          // hood moulds over each pair
      F.rect(c - 2, r0 + 4, c + 5, r0 + 5, 3, S.trim);
      F.set(c + 1, r0 + 5, 3, S.trim);
    }
    for (let u = 0; u < len; ++u) F.rect(u, r0 + 6, u + 1, r0 + 7, u % 2 ? 3 : 4, S.stone);   // corbels
    F.rect(0, r0 + 7, len, h - 1, 4, S.stone);
    for (let u = 0; u < len; u += 3) F.set(u, h - 3, 3, S.spand);                  // pierced-parapet pattern
    F.rect(0, h - 1, len, h, 5, S.trim);
    const e = cs[cs.length - 1] + 5;
    cs.forEach((c) => F.rect(c - 4, r0, c - 2, h - 1, 5, S.stone));
    F.rect(e, r0, e + 2, h - 1, 5, S.stone);
  }
  const CAP = 10;
  function skinBody(S, salt) {
    return (len, h) => {
      const F = new L.Relief(len, h, 4, S.stone), n = Math.floor((h - CAP) / FH);
      const cs = paintRibs(F, len, 0, n, S, salt, true);
      paintCap(F, len, n * FH, h, S, cs);
      F.returns();
      return F;
    };
  }
  // belfry stage: double-height lancets with transoms and a quatrefoil, then the cap
  function skinBelfry(S) {
    return (len, h) => {
      const F = new L.Relief(len, h, 4, S.stone), cs = ribBays(len), r0 = h - CAP, vt = r0 - 1;
      cs.forEach((c, k) => {
        F.rect(c - 2, 2, c + 5, vt - 3, 1, BM.COPPER);
        for (const [a, b] of [[c - 2, c + 1], [c + 2, c + 5]]) {
          F.rect(a, 2, b, vt - 2, 1, L.glassMat(S.seed, k, a, 0.55));
          F.rect(a + 1, vt - 2, a + 2, vt, 1, L.glassMat(S.seed, k, a + 1, 0.55));
          for (let v = 10; v < vt - 4; v += 9) F.rect(a, v, b, v + 1, 2, S.trim);
        }
        F.rect(c + 1, 2, c + 2, vt, 3, S.stone);
      });
      F.rect(0, 0, len, 2, 4, S.trim);
      const e = cs[cs.length - 1] + 5;
      cs.forEach((c) => F.rect(c - 4, 0, c - 2, r0, 4, S.stone));
      F.rect(e, 0, e + 2, r0, 4, S.stone);
      const off = cs[0] - 4;
      if (off > 0) { F.rect(0, 0, off, r0, 4, S.stone); F.rect(len - off, 0, len, r0, 4, S.stone); }
      paintCap(F, len, r0 - 4, h, S, cs);
      F.returns();
      return F;
    };
  }
  // lobby wall behind the arcade: tall bronze-framed glazing with pointed heads, doors
  function skinLobby(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 0, S.stone);
      if (!info.front) {
        for (let v = 4; v < h - 6; v += 6) F.rect(0, v, len, v + 1, 3, S.trim);
        F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);
        return F;
      }
      const cs = L.bays(len, 12, 6);
      cs.forEach((c, k) => {
        const top = h - 9;
        F.rect(c - 4, 0, c + 4, top, 0, BM.BRONZE);
        F.rect(c - 3, 11, c + 3, top - 1, 0, L.glassMat(S.seed, k, 3, 0.7, 'dark'));
        F.rect(c - 2, top, c + 2, top + 2, 0, BM.BRONZE);
        F.rect(c - 1, top + 2, c + 1, top + 4, 0, BM.BRONZE);
        F.rect(c - 3, 1, c + 3, 10, 0, k % 2 ? BM.BRONZE : L.glassMat(S.seed, k, 9, 0.8, 'dark'));
        F.rect(c - 1, 1, c, 10, 1, BM.BRONZE);
      });
      F.rect(0, 0, len, 1, 2, BM.GRANITE_DARK);
      return F;
    };
  }
  // deep arcade in front of the lobby: pointed arches with archivolts, clustered shafts, transverse ribs
  function arcadeModel(W, zA, aH, S, R) {
    const M = new (L.VoxModel())(W + 2, aH, zA + 4, 0, 3), endW = 5;
    let nA = Math.max(3, Math.round((W - 2 * endW) / 26)); if (nA % 2 === 0) nA += W > 120 ? 1 : -1;
    const p = (W - 2 * endW) / nA, pw = 5, a = Math.floor((p - pw) / 2), top = aH - 4;
    const spring = Math.max(6, Math.floor(top - Math.sqrt(3) * a));
    const inArch = (dx, y, aa, sp) => y < sp ? Math.abs(dx) < aa : (Math.abs(dx) < aa && (y - sp) < Math.sqrt(Math.max(0, 4 * aa * aa - (Math.abs(dx) + aa) * (Math.abs(dx) + aa))));
    const cs = []; for (let i = 0; i < nA; ++i) cs.push(endW + p * (i + 0.5));
    for (let x = 0; x < W; ++x) for (let y = 0; y < aH; ++y) {
      let open = false, ring = false, hood = false;
      for (let i = 0; i < nA; ++i) {
        const dx = x + 0.5 - cs[i], ctr = i === (nA >> 1);
        const aa = a, sp = ctr ? spring : spring;
        if (inArch(dx, y, aa, sp)) open = true;
        else if (inArch(dx, y, aa + 2, sp) && y >= 0) ring = true;
        else if (inArch(dx, y, aa + 3, sp) && y >= sp) hood = true;
      }
      if (open) continue;
      M.box(x, y, 0, x + 1, y + 1, 3, S.stone);
      if (ring) M.box(x, y, -1, x + 1, y + 1, 0, S.trim);
      if (hood) M.box(x, y, -2, x + 1, y + 1, 0, S.trim);
    }
    M.box(0, aH - 2, -2, W, aH, 0, S.trim);                                         // cornice over the arcade
    for (let x = 0; x < W; x += 2) M.box(x, aH - 3, -1, x + 1, aH - 2, 0, S.trim);  // dentils
    // clustered shafts on the piers, transverse ribs to the lobby wall, solid end bays
    for (let i = 0; i <= nA; ++i) {
      const px = Math.round(endW + p * i);
      M.box(px - 1, 0, -2, px + 1, spring, 0, S.stone);
      M.box(px - 2, spring, -3, px + 2, spring + 2, 0, S.trim);                   // capital
      M.box(px - 2, 0, -3, px + 2, 2, 0, BM.GRANITE_DARK);                        // plinth
      M.box(px - 2, top - 2, 3, px + 2, aH, zA + 1, S.trim);                       // rib under the ceiling
    }
    M.box(0, 0, 0, endW, aH, zA + 1, S.stone); M.box(W - endW, 0, 0, W, aH, zA + 1, S.stone);
    M.box(0, aH - 1, 3, W, aH, zA + 1, S.trim);                                      // wall rib along the back
    M.a = a; M.spring = spring; M.cx = cs[nA >> 1];
    return M;
  }
  // thin stone spire: square shaft, gablets, tapering needle with crockets, copper finial (slim: on a rib)
  function pinnacleModel(hgt, S, slim) {
    const M = new (L.VoxModel())(7, hgt + 6, 7, 3, 3), s0 = Math.round(hgt * (slim ? 0.35 : 0.4));
    if (slim) M.box(-1, 0, -1, 2, s0, 2, S.stone);
    else {
      M.box(-2, 0, -2, 3, s0, 3, S.stone);
      for (const [x, z] of [[0, -3], [0, 3], [-3, 0], [3, 0]]) M.box(x, s0 - 6, z, x + 1, s0 - 1, z + 1, S.trim);
    }
    M.box(slim ? -1 : -2, s0, slim ? -1 : -2, slim ? 2 : 3, s0 + 1, slim ? 2 : 3, S.trim);
    if (!slim) M.box(-1, s0 + 1, -1, 2, hgt - 4, 2, S.stone);
    else M.box(0, s0 + 1, 0, 1, hgt - 4, 1, S.stone);
    const r = slim ? 1 : 2;
    for (let y = s0 + 3; y < hgt - 5; y += 4) {                                    // crockets
      M.box(-r, y, 0, -r + 1, y + 1, 1, S.trim); M.box(r, y, 0, r + 1, y + 1, 1, S.trim);
      M.box(0, y + 2, -r, 1, y + 3, -r + 1, S.trim); M.box(0, y + 2, r, 1, y + 3, r + 1, S.trim);
    }
    M.box(-1, hgt - 4, -1, 2, hgt - 2, 2, BM.COPPER);                               // knob and spike
    M.box(0, hgt - 2, 0, 1, hgt + (slim ? 1 : 4), 1, BM.COPPER);
    return M;
  }
  // crocketed gable (wimperg) over the central arch, the arch cut out of it
  function gableModel(a, S) {
    const hw = a + 5, hg = Math.round(hw * 2.8), M = new (L.VoxModel())(2 * hw + 3, hg + 12, 7, hw + 1, 6);
    for (let x = -hw; x <= hw; ++x) {
      const ch = Math.round(hg * (1 - Math.abs(x) / (hw + 0.5)));
      for (let y = 0; y < ch; ++y) {
        const dx = Math.abs(x), cut = y < 0 ? dx <= a + 1 : (dx <= a + 1 && y < Math.sqrt(Math.max(0, 4 * (a + 1.5) * (a + 1.5) - (dx + a + 1.5) * (dx + a + 1.5))));
        if (cut) continue;
        const edge = y >= ch - 2;
        M.box(x, y, -5, x + 1, y + 1, 1, edge ? S.stone : S.trim);
        if (!edge && dx > a + 2 && dx < hw - 3 && y > 2 && y < ch - 4 && (dx + y) % 4 === 0) M.box(x, y, -5, x + 1, y + 1, -4, S.spand);   // blind tracery
        if (edge && (y % 4 === 0) && dx > 1) M.box(x, y + 1, -4, x + 1, y + 2, -1, S.trim);   // crockets
      }
    }
    const rc = Math.round(hg * 0.55), rr = Math.max(2, Math.round(hw * 0.22));
    for (let x = -rr; x <= rr; ++x) for (let y = -rr; y <= rr; ++y) {              // rose window
      if (x * x + y * y > rr * rr + 1) continue;
      const ring = x * x + y * y > (rr - 1) * (rr - 1) || x === 0 || y === 0;
      M.box(x, rc + y, -5, x + 1, rc + y + 1, -4, ring ? S.trim : -1);
      if (!ring) M.box(x, rc + y, -4, x + 1, rc + y + 1, -3, BM.GLASS_LIT);
    }
    M.box(-1, hg - 1, -4, 2, hg + 6, 0, S.trim);                                   // finial
    M.box(0, hg + 6, -3, 1, hg + 10, -2, BM.COPPER);
    return M;
  }
  // copper mansard round the office block's roof, with gabled dormers; it stops inside the tower's walls
  function mansardModel(W, D, inside, S) {
    const M = new (L.VoxModel())(W, 24, D, 0, 0), Hm = 12, rw = 9, pitch = 18;
    for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
      if (inside(x, z)) continue;
      const ex = Math.min(x, W - 1 - x), ez = Math.min(z, D - 1 - z), e = Math.min(ex, ez);
      if (e < 2 || e >= 2 + rw) continue;
      let h = Math.min(Hm, 2 + (e - 2) * 2), m = BM.COPPER;
      const t = ez <= ex ? x : z, len = ez <= ex ? W : D, tt = t % pitch;
      let dormer = false;
      if (e < 6 && t > 12 && t < len - 12 && tt >= 6 && tt < 13) {
        dormer = true;
        h = Math.max(h, 9 + Math.round(3.5 - Math.abs(tt - 9)));
      }
      M.box(x, 0, z, x + 1, h, z + 1, m);
      if (dormer) {
        M.box(x, 0, z, x + 1, h - 1, z + 1, S.stone);
        M.box(x, h - 1, z, x + 1, h, z + 1, BM.COPPER);
        if (e === 2 && tt >= 8 && tt < 11) M.box(x, 2, z, x + 1, 7, z + 1, H2(S.seed, x, z) < 0.5 ? BM.GLASS_LIT : BM.GLASS);
      } else if (h === Hm) M.box(x, Hm - 1, z, x + 1, Hm, z + 1, S.trim);           // ridge cresting
    }
    return M;
  }
  // steep copper pyramid with hip ribs, stone dormers, corner pinnacles and a lantern spire
  function roofModel(w, S, R) {
    const hw = w >> 1, slope = S.slope, M = new (L.VoxModel())(w + 8, 260, w + 8, hw + 4, hw + 4);
    let y = 0, r = hw;
    while (r > 5) {
      M.box(-r, y, -r, r, y + slope, r, BM.COPPER);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {              // hip ribs
        const x = sx < 0 ? -r : r - 1, z = sz < 0 ? -r : r - 1;
        M.box(x, y, z, x + 1, y + slope, z + 1, S.trim);
      }
      y += slope; r -= 1;
    }
    // dormers on each face, low on the slope
    const dw = Math.max(3, Math.min(5, hw >> 2)), dy = 3 * slope, dz = hw - 3;
    const dormer = (fx) => {
      for (let i = 0; i < 2 * dw + 2; ++i) {
        const hgt = 10 + (dw + 1 - Math.abs(i - dw - 0.5) + 0.5 | 0);
        fx(-dw - 1 + i, dy, hgt);
      }
    };
    for (const [ax, sg] of [['z', -1], ['z', 1], ['x', -1], ['x', 1]]) dormer((t, y0, hgt) => {
      for (let yy = y0; yy < y0 + hgt; ++yy) for (let d = 0; d < 5; ++d) {
        const out = sg < 0 ? -dz + d : dz - 1 - d;
        const win = Math.abs(t + 0.5) < dw - 1 && yy > y0 + 1 && yy < y0 + 8 && d === 0;
        const m = win ? (H2(S.seed, t, yy) < 0.6 ? BM.GLASS_LIT : BM.GLASS) : (yy >= y0 + hgt - 2 ? BM.COPPER : S.stone);
        if (ax === 'z') M.box(t, yy, out, t + 1, yy + 1, out + 1, m); else M.box(out, yy, t, out + 1, yy + 1, t + 1, m);
      }
    });
    // lantern: stone cage with lit lancets, small copper spire and finial
    const ly = y;
    M.box(-5, ly, -5, 5, ly + 2, 5, S.trim);
    M.box(-4, ly + 2, -4, 4, ly + 14, 4, S.stone);
    for (let t = -3; t < 3; t += 2) for (let yy = ly + 4; yy < ly + 12; ++yy) {
      const m = BM.GLASS_LIT, ww = yy >= ly + 11 ? 0 : 1;
      if (yy >= ly + 11 && t !== -1 && t !== 1) continue;
      M.box(t, yy, -4, t + ww + 1, yy + 1, -3, m); M.box(t, yy, 3, t + ww + 1, yy + 1, 4, m);
      M.box(-4, yy, t, -3, yy + 1, t + ww + 1, m); M.box(3, yy, t, 4, yy + 1, t + ww + 1, m);
    }
    for (const [x, z] of [[-5, -5], [4, -5], [-5, 4], [4, 4]]) M.box(x, ly + 2, z, x + 1, ly + 17, z + 1, S.trim);
    M.box(-5, ly + 14, -5, 5, ly + 15, 5, S.trim);
    let yy = ly + 15;
    for (let rr = 4; rr > 0; --rr) { M.box(-rr, yy, -rr, rr, yy + 4, rr, BM.COPPER); yy += 4; }
    M.box(0, yy, 0, 1, yy + S.finial, 1, BM.COPPER);
    M.box(-1, yy + S.finial - 5, 0, 2, yy + S.finial - 4, 1, BM.COPPER);
    M.box(0, yy + S.finial, 0, 1, yy + S.finial + 1, 1, BM.BEACON);
    M.top = ly;
    return M;
  }

  function towerGothic(E, C, W, D, spec, R) {
    const stone = L.pick(R, [BM.LIMESTONE, BM.BUFF, BM.BUFF, BM.TERRACOTTA]);
    const S = {
      seed: spec.seed, stone, trim: stone === BM.LIMESTONE ? BM.LIMESTONE_DARK : L.pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK]),
      spand: L.pick(R, [BM.LIMESTONE_DARK, BM.COPPER, BM.TRIM_DARK, BM.TERRACOTTA]), slope: L.pick(R, [2, 3, 3]),
      finial: 14 + Math.floor(R() * 14), mansard: R() < 0.7
    };
    if (S.spand === stone) S.spand = BM.LIMESTONE_DARK;
    const n = Math.max(24, Math.min(54, Math.round(spec.floors * (1.0 + R() * 0.3))));
    const zA = 10 + Math.floor(R() * 4), aH = 2 * FH + 8;
    const n1 = Math.round(n * (0.32 + R() * 0.1)), roof = { mat: S.trim, deck: BM.ROOF_TAR, parapet: 2 };
    const tw = Math.min(84, Math.round(Math.min(W * (0.5 + R() * 0.14), D * 0.62))) & ~1;
    const cx = W >> 1, tz = R() < 0.6 ? 0 : Math.round(D * 0.08);
    const t2 = { x0: cx - (tw >> 1), z0: tz, x1: cx + (tw >> 1), z1: tz + tw };
    const n2 = Math.round((n - n1) * 0.55), n3 = Math.max(3, n - n1 - n2 - 2);
    const i3 = Math.max(8, Math.round(tw * 0.1)), i4 = Math.max(6, Math.round(tw * 0.08));
    const t3 = { x0: t2.x0 + i3, z0: t2.z0 + i3, x1: t2.x1 - i3, z1: t2.z1 - i3 };
    const t4 = { x0: t3.x0 + i4, z0: t3.z0 + i4, x1: t3.x1 - i4, z1: t3.z1 - i4 };
    const tiers = [
      { x0: 0, z0: zA, x1: W, z1: D, h: aH, skin: skinLobby(S), party: spec.party },
      { x0: 0, z0: 0, x1: W, z1: D, floating: true, soffit: S.trim, h: n1 * FH + CAP, skin: skinBody(S, 3), party: spec.party, roof: Object.assign({ units: 3 }, roof) },
      Object.assign(t2, { h: n2 * FH + CAP, skin: skinBody(S, 17), roof }),
      Object.assign(t3, { h: n3 * FH + CAP, skin: skinBody(S, 29), roof }),
      Object.assign(t4, { h: 2 * FH + 8 + CAP, skin: skinBelfry(S), roof: { mat: S.trim, deck: BM.COPPER, parapet: 1 } })
    ];
    const y = L.buildTiers(E, C, W, D, tiers, spec.seed);
    const w4 = (t4.x1 - t4.x0 - 4) & ~1, c4x = (t4.x0 + t4.x1) >> 1, c4z = (t4.z0 + t4.z1) >> 1;
    E.vox(C, roofModel(w4, S, R), c4x, y, c4z);
    // pinnacles ringing every setback; slim ones on the ribs of the office block's parapet
    const ring = (t, hgt) => {
      const top = t.y + t.h, pm = pinnacleModel(hgt, S, false);
      for (const [x, z] of [[t.x0 + 1, t.z0 + 1], [t.x1 - 2, t.z0 + 1], [t.x0 + 1, t.z1 - 2], [t.x1 - 2, t.z1 - 2]]) E.vox(C, pm, x, top, z);
    };
    const t1 = tiers[1], top1 = t1.y + t1.h, sm = pinnacleModel(18, S, true);
    const clear = (x, z) => x < t2.x0 - 6 || x > t2.x1 + 6 || z < t2.z0 - 6 || z > t2.z1 + 6;
    ribBays(W).forEach((c, k) => { const x = c - 3; if (k % 2 === 1 && clear(x, 0)) E.vox(C, sm, x, top1, 0); });
    for (const side of [0, 1]) ribBays(D).forEach((c, k) => {
      if (k % 2 === 0 || (side === 0 && spec.party.l) || (side === 1 && spec.party.r)) return;
      const z = side === 0 ? D - (c - 3) - 1 : c - 3, x = side === 0 ? 0 : W - 1;
      if (clear(x, z) && z > 6 && z < D - 6) E.vox(C, sm, x, top1, z);
    });
    if (S.mansard) E.vox(C, mansardModel(W, D, (x, z) => x >= t2.x0 + 2 && x < t2.x1 - 2 && z >= t2.z0 + 2 && z < t2.z1 - 2, S), 0, top1, 0);
    ring(t1, 26);
    ring(t2, 30);
    ring(t3, 34);
    ring(t4, 40);
    // gable over the central arch of the arcade
    const ac = arcadeModel(W, zA, aH, S, R);
    E.vox(C, ac, 0, 0, 0);
    E.vox(C, gableModel(ac.a, S), ac.cx - 0.5, ac.spring, -0.5);
  }
  A.registerTower('gothic', towerGothic);
})();
