// Signature tower 'beacon': a 2000s corporate headquarters. Blue reflective glass between silver fins, notched
// corners all the way up, and three setbacks at the top, each edged with a glowing LED band so the crown reads as
// stacked lines of light at night. A helipad on steel legs and a lattice mast finish the roof. The tower stands on
// a black granite podium with a double-height glass lobby, behind a public plaza strip (paving, planters with
// trees, benches, flagpoles, a granite name monolith).
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  const VM = () => L.VoxModel();

  // ---- shaft skin: blue glass panels, spandrels, thin mullion fins with a deeper silver fin every third bay.
  // o.led: the tier top is a metal band with an LED line and a coping; o.mech: set of local floors that are louvred
  function skinShaft(S, o) {
    return (len, h) => {
      const top = o.led ? 8 : 3, n = Math.floor((h - top) / FH);
      const F = new L.Relief(len, h, 3, BM.MULLION);
      if (len <= S.nn) {                                                                     // notch: dark glass slot with slats
        for (let f = 0; f < n; ++f) {
          const v = f * FH;
          F.rect(0, v, len, v + FH, 1, L.glassMat(S.seed, len + o.k, o.f0 + f, S.lit * 0.6, 'dark'));
          for (let r = 4; r < FH; r += 5) F.rect(1, v + r, len - 1, v + r + 1, 3, BM.METAL);
          F.rect(0, v, len, v + 1, 2, BM.STEEL_DARK);
        }
        F.rect(0, 0, 1, n * FH, 4, S.fin); F.rect(len - 1, 0, len, n * FH, 4, S.fin);
        if (o.slotLed && len >= 4) F.rect(len >> 1, 0, (len >> 1) + 1, n * FH, 2, BM.LED);   // light line up the corner slot
      } else
      for (let f = 0; f < n; ++f) {
        const v = f * FH, Fa = o.f0 + f;
        if (o.mech && o.mech.has(f)) {
          for (let r = 0; r < FH; ++r) F.rect(0, v + r, len, v + r + 1, r % 2 ? 1 : 2, r % 2 ? BM.LOUVER : BM.METAL);
          continue;
        }
        F.rect(0, v, len, v + 3, 1, S.span);
        for (let u = 0; u < len; u += S.pitch) F.rect(u, v + 3, Math.min(len, u + S.pitch), v + FH, 1, L.glassMat(S.seed, u + len * 7, Fa * 5 + o.k, S.lit, 'blue'));
        F.rect(0, v + 2, len, v + 3, 1, BM.MULLION);                                        // sill transom line
      }
      const nf = len <= S.nn ? 0 : Math.max(1, Math.round((len - 2) / S.pitch)), step = (len - 1) / Math.max(1, nf);
      for (let k = 0; k <= nf && len > S.nn; ++k) {
        const u = Math.min(len - 1, Math.round(k * step)), major = k === 0 || k === nf || k % S.major === 0;
        F.rect(u, 0, u + 1, n * FH, major ? 4 : 2, major ? S.fin : BM.MULLION);
      }
      if (o.led) {                                                                           // LED-edged setback band
        const y = n * FH;
        F.rect(0, y, len, y + 2, 3, S.band);
        F.rect(0, y + 2, len, y + 5, 3, BM.LED);
        F.rect(0, y + 5, len, h - 1, 3, S.band);
        F.rect(0, h - 1, len, h, 4, BM.METAL);
      } else F.rect(0, n * FH, len, h, 3, S.band);
      F.rect(0, 0, len, 2, 3, S.band);                                                       // base course on the roof below
      return F;
    };
  }
  // black granite podium: double-height glass lobby on the front, slot windows elsewhere, ribbon storey above,
  // LED reveal under the coping
  function skinPodium(S, lay) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, BM.GRANITE_DARK), gL = 2 * FH + 4, front = info.front && len === lay.W;
      F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);
      if (front) {
        const a = lay.lob[0], b = lay.lob[1];
        F.rect(a, 0, b, gL, 0, BM.GLASS_BLUE);
        for (let u = a; u < b; u += 5) for (const [v0, v1] of [[1, 15], [16, gL - 2]]) F.rect(u, v0, Math.min(b, u + 5), v1, 0, L.glassMat(S.seed, u, v0, 0.75, 'blue'));
        for (let u = a; u < b; u += 5) F.rect(u, 0, u + 1, gL, 1, BM.STEEL_DARK);
        F.rect(a, 15, b, 16, 1, BM.STEEL_DARK); F.rect(a, gL - 2, b, gL, 1, BM.STEEL_DARK);
        // granite piers through the lobby
        for (const u of lay.piers) F.rect(u - 2, 0, u + 2, gL + 2, 5, BM.GRANITE_DARK);
        // revolving doors and a glass canopy on steel
        for (const c of lay.doors) {
          F.rect(c - 5, 0, c + 5, 12, 2, BM.METAL); F.rect(c - 4, 0, c + 4, 11, 1, BM.GLASS_DARK_LIT);
          F.rect(c - 1, 0, c + 1, 11, 2, BM.METAL);                                             // revolving door drum and post
          F.rect(c - 7, 12, c + 7, 13, 8, BM.GLASS_BLUE); F.rect(c - 7, 13, c + 7, 14, 8, BM.STEEL_DARK);
        }
        F.rect(a - 2, gL, b + 2, gL + 2, 4, BM.STEEL_DARK);                                     // lobby head
      } else {
        for (const c of L.bays(len, 8, 5)) F.rect(c - 1, 4, c + 1, gL - 4, 1, L.glassMat(S.seed, c, 3, 0.4, 'blue'));
        for (let v = 6; v < gL; v += 6) F.rect(0, v, len, v + 1, 1, BM.STEEL_DARK);            // reveal joints
      }
      // ribbon storeys + signage band
      for (let f = 0; f < lay.nr; ++f) {
        const v = gL + 2 + f * FH;
        for (let u = 4; u < len - 4; u += 5) F.rect(u, v + 3, Math.min(len - 4, u + 5), v + FH - 3, 1, L.glassMat(S.seed, u, 9 + f, 0.35, 'blue'));
        for (let u = 4; u <= len - 4; u += 5) F.rect(u, v + 3, u + 1, v + FH - 3, 2, BM.STEEL_DARK);
        if (f + 1 < lay.nr) F.rect(0, v + FH - 1, len, v + FH, 3, BM.GRANITE_DARK);
      }
      const v = gL + 2 + (lay.nr - 1) * FH;
      if (front) {                                                                            // name panel with LED lettering
        const a = (len >> 1) - 16, b = (len >> 1) + 16;
        F.rect(a, v + 3, b, v + FH - 3, 3, BM.STEEL_DARK);
        for (let u = a + 2, i = 0; u + 3 <= b - 2; u += 4, ++i) for (let x = 0; x < 3; ++x) for (let y = 0; y < 4; ++y) {
          const on = x === 0 ? L.H2(S.seed, i, 1) < 0.85 || y > 1 : x === 2 ? L.H2(S.seed, i, y + 3) < 0.6 : L.H2(S.seed, i, y + 9) < (y === 0 || y === 3 ? 0.7 : 0.3);
          if (on) F.rect(u + x, v + 5 + y, u + x + 1, v + 6 + y, 4, BM.LED);
        }
      }
      F.rect(0, h - 5, len, h - 3, 3, BM.LED);
      F.rect(0, h - 3, len, h, 4, BM.GRANITE_DARK);
      F.returns();
      return F;
    };
  }

  // ---- voxel parts
  // the corner pieces the notched prism leaves open at convex corners: a band column under a 2x2 coping
  function cornerModel(S, sx, sz) {
    const M = new (VM())(4, 8, 4, 2, 2);
    // the cell outside the corner in direction (sx, sz)
    const x0 = sx < 0 ? -1 : 0, z0 = sz < 0 ? -1 : 0, x2 = sx < 0 ? -2 : 0, z2 = sz < 0 ? -2 : 0;
    M.box(x0, 0, z0, x0 + 1, 2, z0 + 1, S.band); M.box(x0, 2, z0, x0 + 1, 5, z0 + 1, BM.LED); M.box(x0, 5, z0, x0 + 1, 7, z0 + 1, S.band);
    M.box(x2, 7, z2, x2 + 2, 8, z2 + 2, BM.METAL);
    return M;
  }
  function helipadModel(P, legs, S) {
    const hp = P >> 1, M = new (VM())(P + 6, 16, P + 6, hp + 3, hp + 3), y = 9, c = 3;
    const oct = (x, z, r, cut) => { const ax = Math.abs(x + 0.5), az = Math.abs(z + 0.5); return ax < r && az < r && ax + az < 2 * r - cut; };
    for (let z = -hp - 2; z < hp + 2; ++z) for (let x = -hp - 2; x < hp + 2; ++x) {
      if (oct(x, z, hp + 2, c + 2) && !oct(x, z, hp, c)) M.box(x, y - 1, z, x + 1, y, z + 1, BM.METAL);      // safety-net shelf
      if (!oct(x, z, hp, c)) continue;
      M.box(x, y - 2, z, x + 1, y, z + 1, BM.STEEL_DARK);                                                    // deck
      const r = Math.hypot(x + 0.5, z + 0.5), R0 = hp * 0.72;
      let m = BM.GRANITE_DARK;
      if (Math.abs(r - R0) < 1) m = BM.TRIM;
      if (!oct(x, z, hp - 1, c)) m = BM.TRIM_DARK;
      M.box(x, y, z, x + 1, y + 1, z + 1, m);
    }
    // the H
    const hh = Math.round(hp * 0.42), hw = Math.round(hp * 0.3);
    M.box(-hw, y, -hh, -hw + 3, y + 1, hh, BM.TRIM); M.box(hw - 3, y, -hh, hw, y + 1, hh, BM.TRIM); M.box(-hw, y, -1, hw, y + 1, 2, BM.TRIM);
    // LED edge lights
    for (let k = -hp + 2; k < hp - 2; k += 4) for (const [x, z] of [[k, -hp], [k, hp - 1], [-hp, k], [hp - 1, k]]) {
      if (!oct(x, z, hp, c)) continue;
      M.box(x, y + 1, z, x + 1, y + 2, z + 1, BM.LED);
    }
    for (const [x, z] of [[-hp + 2, -hp + 2], [hp - 3, -hp + 2], [-hp + 2, hp - 3], [hp - 3, hp - 3]]) M.box(x, y + 1, z, x + 1, y + 2, z + 1, BM.LED);
    // legs and bracing
    for (const [x, z] of legs) {
      M.box(x - 1, 0, z - 1, x + 1, y - 2, z + 1, BM.STEEL_DARK);
      M.box(x - 2, 0, z - 2, x + 2, 1, z + 2, BM.METAL);
    }
    return M;
  }
  function mastModel(Hm, S) {
    const M = new (VM())(14, Hm + 30, 14, 7, 7);
    M.box(-4, 0, -4, 4, 3, 4, BM.STEEL_DARK);
    for (const [x, z] of [[-3, -3], [2, -3], [-3, 2], [2, 2]]) M.box(x, 3, z, x + 1, Hm, z + 1, BM.METAL);
    for (let y = 6; y < Hm; y += 6) { M.box(-3, y, -3, 3, y + 1, -2, BM.METAL); M.box(-3, y, 2, 3, y + 1, 3, BM.METAL); M.box(-3, y, -2, -2, y + 1, 2, BM.METAL); M.box(2, y, -2, 3, y + 1, 2, BM.METAL); }
    M.box(-2, Hm, -2, 2, Hm + 2, 2, BM.STEEL_DARK);
    M.box(-1, Hm + 2, -1, 1, Hm + 26, 1, BM.METAL);
    M.box(-1, Hm + 26, -1, 1, Hm + 28, 1, BM.BEACON);
    M.box(-3, Math.round(Hm * 0.5), -3, 3, Math.round(Hm * 0.5) + 1, 3, BM.BEACON);
    M.box(3, Math.round(Hm * 0.7), -2, 5, Math.round(Hm * 0.7) + 4, 2, BM.TRIM);                     // dishes
    M.box(-5, Math.round(Hm * 0.4), -1, -3, Math.round(Hm * 0.4) + 3, 2, BM.TRIM);
    return M;
  }
  function plazaModel(W, d, S, R, lay) {
    const M = new (VM())(W, 40, d + 2, 0, 0);
    M.box(0, 0, 0, W, 1, d + 2, BM.LIMESTONE);
    for (let x = 4; x < W; x += 8) M.box(x, 0, 1, x + 1, 1, d + 2, BM.LIMESTONE_DARK);                      // paving joints
    for (let z = 5; z < d; z += 8) M.box(0, 0, z, W, 1, z + 1, BM.LIMESTONE_DARK);
    M.box(0, 0, 0, W, 1, 1, BM.GRANITE_DARK);                                                              // curb line
    const clear = (x0, x1) => lay.doors.every(c => x1 < c - 9 || x0 > c + 9);
    // planters with a tree each, benches on their building side; the door axes stay open
    const pd = Math.min(7, d - 8), pz = 3, pw = 12;
    if (pd >= 4) for (let x = 3; x + pw <= W - 3; x += pw + 6) {
      if (!clear(x, x + pw)) continue;
      M.box(x, 1, pz, x + pw, 4, pz + pd, BM.GRANITE_DARK); M.box(x + 1, 1, pz + 1, x + pw - 1, 4, pz + pd - 1, BM.GRASS);
      for (let u = x + 1; u < x + pw - 1; u += 2) M.box(u, 4, pz + 1, u + 1, 5 + ((u * 7) % 3 ? 0 : 1), pz + 2, BM.LEAF_DARK);
      const cx = x + (pw >> 1), cz = pz + (pd >> 1), lf = R() < 0.5 ? BM.LEAF : BM.LEAF_DARK, th = 9 + Math.floor(R() * 4);
      M.box(cx, 4, cz, cx + 1, th + 3, cz + 1, BM.TRUNK);
      M.box(cx - 4, th, cz - 3, cx + 5, th + 5, cz + 4, lf); M.box(cx - 3, th, cz - 4, cx + 4, th + 5, cz + 5, lf);
      M.box(cx - 3, th + 5, cz - 3, cx + 4, th + 7, cz + 4, lf); M.box(cx - 3, th - 1, cz - 3, cx + 4, th, cz + 4, BM.LEAF_DARK);
      if (pz + pd + 4 < d - 2) { M.box(x + 3, 1, pz + pd + 1, x + pw - 3, 3, pz + pd + 3, BM.WOOD); M.box(x + 3, 1, pz + pd + 1, x + 4, 2, pz + pd + 3, BM.STEEL_DARK); M.box(x + pw - 4, 1, pz + pd + 1, x + pw - 3, 2, pz + pd + 3, BM.STEEL_DARK); }
    }
    // bollards at the door approaches
    for (const c of lay.doors) for (const x of [c - 8, c - 4, c + 3, c + 7]) if (x > 1 && x < W - 2) M.box(x, 1, 2, x + 1, 4, 3, BM.STEEL_DARK);
    // granite name monolith (LED strip) and three flagpoles, in the free spans beside the entrance
    const c0 = lay.doors[0], c1 = lay.doors[lay.doors.length - 1];
    const mx = c0 - 24;
    if (mx > 2) { M.box(mx, 1, d - 6, mx + 11, 10, d - 3, BM.GRANITE_DARK); M.box(mx + 1, 6, d - 7, mx + 10, 7, d - 6, BM.LED); M.box(mx + 1, 3, d - 7, mx + 10, 5, d - 6, BM.METAL); }
    const fx = c1 + 14;
    if (fx + 12 < W - 2) for (let k = 0; k < 3; ++k) {
      const x = fx + k * 5;
      M.box(x - 1, 1, d - 6, x + 2, 2, d - 3, BM.CONCRETE); M.box(x, 2, d - 5, x + 1, 38, d - 4, BM.METAL);
      M.box(x + 1, 30, d - 5, x + 7, 35, d - 4, [BM.AWNING_BLUE, BM.TRIM, BM.AWNING_RED][(k + (S.seed & 1)) % 3]);
    }
    return M;
  }
  // convex corners of a mask outline: grid points with exactly one of the four cells around them inside;
  // returns the point and the outward diagonal
  function convexCorners(mask, W, D) {
    const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1, out = [];
    for (let z = 0; z <= D; ++z) for (let x = 0; x <= W; ++x) {
      const c = [inn(x - 1, z - 1), inn(x, z - 1), inn(x - 1, z), inn(x, z)];
      if (c.filter(Boolean).length !== 1) continue;
      const i = c.indexOf(true);
      out.push([x, z, i % 2 ? -1 : 1, i < 2 ? 1 : -1]);
    }
    return out;
  }

  function towerBeacon(E, C, W, D, spec, R) {
    const S = {
      seed: spec.seed, lit: 0.3, pitch: L.pick(R, [5, 6]), major: L.pick(R, [2, 3]),
      fin: L.pick(R, [BM.METAL, BM.TRIM, BM.METAL, BM.STEEL_DARK]), band: L.pick(R, [BM.MULLION, BM.STEEL_DARK]), span: L.pick(R, [BM.GLASS_BLUE, BM.GLASS_BLUE, BM.SPANDREL])
    };
    S.nn = 0;
    const pz = Math.max(14, Math.min(26, Math.round(D * (0.12 + R() * 0.06))));
    const nr = R() < 0.5 ? 1 : 2, podH = 2 * FH + 4 + 2 + nr * FH + 5;
    const n = Math.max(22, Math.min(50, Math.round(spec.floors * (1.0 + R() * 0.25))));
    const mx = Math.max(6, Math.round(W * (0.08 + R() * 0.06)));
    const tz0 = pz + Math.max(6, Math.round((D - pz) * 0.08)), tz1 = D - Math.max(6, Math.round((D - pz) * 0.08));
    const tw = W - 2 * mx, td = tz1 - tz0;
    const nn = Math.max(4, Math.min(10, Math.round(Math.min(tw, td) * (0.1 + R() * 0.05))));
    const s = Math.max(4, Math.round(Math.min(tw, td) * (0.05 + R() * 0.04)));
    S.nn = nn;
    const f1 = L.pick(R, [2, 3, 4]), f2 = L.pick(R, [2, 3]), f3 = L.pick(R, [2, 3]), fs = Math.max(12, n - f1 - f2 - f3);
    // optional full-height glass blade on the front and back faces (projects 4 voxels, steps back with the tiers)
    const blade = R() < 0.55 && tw >= 56, bw = Math.round(tw * (0.28 + R() * 0.14)), bx0 = (W - bw) >> 1, bd = 4;
    const slotLed = R() < 0.5;
    const lobA = Math.max(6, mx - 4), lobB = W - lobA;
    const nP = Math.max(2, Math.round((lobB - lobA) / 24)), piers = [];
    for (let k = 0; k <= nP; ++k) piers.push(Math.round(lobA + k * (lobB - lobA) / nP));
    const mid = (j) => (piers[j] + piers[j + 1]) >> 1;
    const doors = nP % 2 ? [mid((nP - 1) >> 1)] : [mid(nP / 2 - 1), mid(nP / 2)];
    const lay = { W, lob: [lobA, lobB], doors, piers, nr };

    const tiers = [Object.assign({ x0: 0, z0: pz, x1: W, z1: D }, { h: podH, skin: skinPodium(S, lay), party: spec.party, roof: { mat: BM.GRANITE_DARK, deck: BM.ROOF_TAR, parapet: 2, units: 3 } })];
    const mechF = new Set(R() < 0.5 ? [Math.round(fs * 0.5)] : [Math.round(fs * 0.36), Math.round(fs * 0.7)]);
    const rects = [];
    let k = 0;
    for (const [i, nf] of [[0, fs], [1, f1], [2, f2], [3, f3]]) {
      const r = { x0: mx + i * s, z0: tz0 + i * s, x1: W - mx - i * s, z1: tz1 - i * s, notch: nn };
      r.mask = L.rectMask(W, D, r.x0, r.z0, r.x1, r.z1, nn);
      if (blade) for (let x = bx0; x < bx0 + bw; ++x) for (let q = 0; q < bd; ++q) { r.mask[(r.z0 - 1 - q) * W + x] = 1; r.mask[(r.z1 + q) * W + x] = 1; }
      rects.push(r);
      tiers.push({ mask: r.mask, h: nf * FH + 8, skin: skinShaft(S, { led: true, f0: k, k: i, mech: i === 0 ? mechF : null, slotLed: slotLed || i > 0 }),
        roof: { mat: BM.METAL, deck: BM.ROOF_TAR, parapet: 2, units: i === 3 ? 0 : (i === 0 ? 0 : 1) } });
      k += nf;
    }
    const y = L.buildTiers(E, C, W, D, tiers, spec.seed);
    // close the band corners the notched prisms leave open
    tiers.slice(1).forEach((t, i) => {
      const yb = t.y + t.h - 8;
      for (const [cx, cz, sx, sz] of convexCorners(rects[i].mask, W, D)) E.vox(C, cornerModel(S, sx, sz), cx, yb, cz);
    });
    // roof: helipad on steel legs over the top tier (cantilevered forward when the roof is short), mast behind it
    const top = rects[3], ttw = top.x1 - top.x0, ttd = top.z1 - top.z0;
    let P = Math.max(28, Math.min(52, ttw + 6, ttd - 5)); P -= P & 1;
    const hp = P >> 1, pcx = (top.x0 + top.x1) >> 1;
    const pz0 = Math.max(top.z0 - 8, Math.min(top.z0 + 2, top.z1 - 13 - P)), pcz = pz0 + hp;
    const zA = Math.max(pz0 + 3, top.z0 + 3), zB = Math.min(pz0 + P - 4, top.z1 - 4), zm = (zA + zB) >> 1;
    const xA = Math.max(pcx - hp + 3, top.x0 + 3), xB = Math.min(pcx + hp - 4, top.x1 - 4);
    const legs = [[0, zA - pcz], [0, zB - pcz], [xA - pcx, zm - pcz], [xB - pcx, zm - pcz]];
    E.vox(C, helipadModel(P, legs, S), pcx, y, pcz);
    const Hm = 50 + Math.floor(R() * 40);
    const mz = Math.max(pz0 + P + 6, top.z1 - 7);
    E.vox(C, mastModel(Hm, S), pcx + (R() < 0.5 ? -1 : 1) * Math.round(ttw * 0.18), y, Math.min(top.z1 - 6, mz));
    // plaza strip in front of the podium
    E.vox(C, plazaModel(W, pz, S, R, lay), 0, 0, 0);
  }
  A.registerTower('beacon', towerBeacon);
})();
