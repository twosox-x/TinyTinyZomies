// Tower 'skygarden': an office glass tower split by an open sky garden at about 60% height. Two or three storeys
// are left open between the lower and upper glass bodies: structural columns, the lift core, a planted deck with
// trees, benches and glass railings, under a lit soffit. A stone and glass lobby with a deep cantilevered canopy at
// the foot; a stepped louver crown on top.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  function mul(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function tree(M, x, y, z, s, top, R) {
    const hs = [2, s >= 5 ? 4 : 3, 3, 2, 1], rs = [s - 1, s, s, s - 1, Math.max(1, s - 3)];
    let ch = 0, nl = 0; while (nl < hs.length && ch + hs[nl] <= top - y - 3) ch += hs[nl++];
    const c0 = top - ch;
    M.box(x, y, z, x + 1, c0 + 1, z + 1, BM.TRUNK);
    if (s >= 4) M.box(x, y, z, x + 2, c0 - 2, z + 2, BM.TRUNK);
    let yy = c0, jx = 0, jz = 0;
    for (let i = 0; i < nl; ++i) {
      const r = rs[i], ra = r + (R() < 0.5 ? 1 : 0), m = i === 0 ? BM.LEAF_DARK : (i % 2 ? BM.LEAF : (R() < 0.5 ? BM.LEAF_DARK : BM.LEAF));
      M.box(x - ra + jx, yy, z - r + jz, x + ra + 1 + jx, yy + hs[i], z + r + 1 + jz, m);
      yy += hs[i]; jx = R() < 0.4 ? (R() < 0.5 ? -1 : 1) : 0; jz = R() < 0.4 ? (R() < 0.5 ? -1 : 1) : 0;
    }
  }

  // lobby: one tall storey of glass between deep stone fins, granite plinth, stone attic with a reveal
  function skinLobby(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 3, S.stone), gH = h - 7;
      const bw = 12, cs = L.bays(len, bw, 4), mid = cs.length >> 1;
      F.rect(0, 0, len, gH, 1, L.glassMat(S.seed, 1, 1, 0.65, 'dark'));
      cs.forEach((c, i) => {
        const a = c - (bw >> 1), b = c + (bw >> 1);
        F.rect(a + 1, 0, b, gH, 1, L.glassMat(S.seed, i, 3, 0.6, 'dark'));
        F.rect(a + 1, 17, b, 18, 2, BM.MULLION);                                              // transom
        F.rect(c, 0, c + 1, gH, 2, BM.MULLION);
        if (info.front && Math.abs(i - mid) <= (len > 90 ? 1 : 0)) {                           // revolving doors
          F.rect(c - 3, 0, c + 4, 10, 0, BM.GLASS_DARK_LIT); F.rect(c - 4, 10, c + 5, 11, 2, BM.BRONZE);
          F.rect(c - 4, 0, c - 3, 10, 2, BM.BRONZE); F.rect(c + 4, 0, c + 5, 10, 2, BM.BRONZE);
        }
      });
      for (let u = 0; u <= len; u += bw) { const a = cs[0] - (bw >> 1) + u; if (a >= 0 && a < len) F.rect(a, 0, a + 2, gH, 5, S.stone); }
      F.rect(0, 0, 4, gH, 5, S.stone); F.rect(len - 4, 0, len, gH, 5, S.stone);               // corner piers
      F.rect(0, 0, len, 2, 3, S.stoneDark);                                                    // plinth
      F.rect(0, gH, len, gH + 1, 3, S.stoneDark);
      F.rect(0, gH + 1, len, h - 1, 4, S.stone);                                               // attic
      F.rect(0, gH + 3, len, gH + 4, 3, S.stoneDark);
      F.rect(0, h - 1, len, h, 5, S.stoneDark);
      F.returns();
      return F;
    };
  }
  // upper body: horizontal bands (projecting slab every storey, tinted glass, close mullions), lit band at the top
  function skinUpper(S, o) {
    return (len, h) => {
      const F = new L.Relief(len, h, 2, BM.MULLION), n = Math.floor((h - 4) / FH);
      for (let f = 0; f < n; ++f) {
        const v = f * FH;
        for (let u = 0; u < len; u += o.pitch) F.rect(u, v + 3, Math.min(len, u + o.pitch), v + FH, 1, L.glassMat(S.seed + 9, u, f, 0.3, o.tint));
        F.rect(0, v, len, v + 2, 4, o.band);
        F.rect(0, v + 2, len, v + 3, 1, BM.SPANDREL);
        for (let u = 0; u < len; u += o.pitch) F.rect(u, v + 2, u + 1, v + FH, 2, BM.MULLION);
      }
      F.rect(0, n * FH, len, n * FH + 2, 4, o.band);
      F.rect(0, n * FH + 2, len, n * FH + 3, 3, o.led ? BM.LED : o.band);                      // lit band
      F.rect(0, n * FH + 3, len, h, 4, o.band);
      F.returns();
      return F;
    };
  }

  // lower body: curtain wall with dark mullions and a deeper light fin every few bays (vertical emphasis), a louvred
  // plant floor, and a band at the top that the sky garden deck sits on
  function skinLower(S, o) {
    return (len, h) => {
      const F = new L.Relief(len, h, 2, BM.CURTAIN), p = o.pitch, n = Math.floor(h / FH);
      for (let f = 0; f < n; ++f) {
        const v = f * FH;
        if (o.mech.includes(f)) { for (let r = 0; r < FH; ++r) F.rect(0, v + r, len, v + r + 1, r % 2 ? 2 : 1, r % 2 ? BM.LOUVER : BM.METAL); continue; }
        for (let u = 0; u < len; u += p) F.rect(u, v + 2, Math.min(len, u + p), v + FH, 2, L.glassMat(S.seed, u + f * 101, f, 0.3, o.tint));
        F.rect(0, v, len, v + 2, 2, BM.SPANDREL);
      }
      const fins = L.bays(len, p * o.every, 0);
      for (let u = 0; u < len; u += p) F.rect(u, 0, u + 1, n * FH, 3, BM.MULLION);
      for (const c of fins) { const u = c - ((p * o.every) >> 1); if (u > 2 && u < len - 3) F.rect(u, 0, u + 1, n * FH, 5, o.band); }
      F.rect(0, 0, 3, n * FH, 4, o.band); F.rect(len - 3, 0, len, n * FH, 4, o.band);
      if (h > n * FH) F.rect(0, n * FH, len, h, 4, o.band);
      F.returns();
      return F;
    };
  }

  function towerSkygarden(E, C, W, D, spec, R) {
    const S = { seed: spec.seed, stone: L.pick(R, [BM.LIMESTONE, BM.GRANITE_DARK, BM.BUFF, BM.LIMESTONE_DARK]), stoneDark: BM.GRANITE_DARK };
    if (S.stone === BM.GRANITE_DARK) S.stoneDark = BM.STEEL_DARK;
    const tints = ['curtain', 'green', 'dark', 'blue'], tA = L.pick(R, tints);
    let tB = L.pick(R, tints); if (tB === tA) tB = tA === 'dark' ? 'blue' : 'dark';
    const band = L.pick(R, [BM.WHITE_CONCRETE, BM.METAL, BM.TRIM]);
    const n = Math.max(24, Math.min(40, Math.round(spec.floors * (1 + R() * 0.2)))), g = R() < 0.35 ? 2 : 3;
    const n1 = Math.round(n * (0.55 + R() * 0.07)), n2 = Math.max(8, n - n1 - g);
    const lobbyH = 26 + 7;
    // footprints: lower body set back from the street behind the lobby roof; upper body narrower
    const sx = Math.max(6, Math.round(W * 0.08)), fz = Math.max(14, Math.round(D * 0.16)), bz = Math.max(6, Math.round(D * 0.06));
    const lo = { x0: sx, z0: fz, x1: W - sx, z1: D - bz };
    const lw = lo.x1 - lo.x0, ld = lo.z1 - lo.z0;
    const ix = Math.max(6, Math.round(lw * (0.1 + R() * 0.08))), iz = Math.max(4, Math.round(ld * (0.04 + R() * 0.08)));
    const up = { x0: lo.x0 + ix, z0: lo.z0 + iz, x1: lo.x1 - ix, z1: lo.z1 - Math.max(4, iz >> 1) };
    const pitchA = L.pick(R, [5, 6]), pitchB = L.pick(R, [3, 4]);
    const mech = [Math.round(n1 * 0.45)];
    const tiers = [
      { x0: 0, z0: 0, x1: W, z1: D, h: lobbyH, skin: skinLobby(S), party: spec.party, roof: { mat: S.stoneDark, deck: BM.CONCRETE, parapet: 3 } },
      Object.assign({}, lo, { h: n1 * FH + 2, skin: skinLower(S, { mech, tint: tA, pitch: pitchA, band, every: L.pick(R, [3, 4, 5]) }), roof: { mat: band, deck: BM.LIMESTONE, parapet: 0 } }),
      { gap: g * FH },
      Object.assign({}, up, { h: n2 * FH + 5, skin: skinUpper(S, { tint: tB, pitch: pitchB, band, led: R() < 0.7 }), soffit: BM.WHITE_CONCRETE, roof: { mat: band, parapet: 2, units: 0 } })
    ];
    const yTop = L.buildTiers(E, C, W, D, tiers, spec.seed);
    const yDeck = tiers[2].y, yUp = tiers[3].y, gh = yUp - yDeck;

    // ---- the sky garden: columns, core, planted beds, trees, benches, glass railing, soffit lights
    const Rg = mul(spec.seed * 31 + 7);
    const G = new (L.VoxModel())(lw, gh, ld, 0, 0);
    const ux0 = up.x0 - lo.x0, uz0 = up.z0 - lo.z0, ux1 = up.x1 - lo.x0, uz1 = up.z1 - lo.z0;
    // core: lift lobby with bronze doors, under the middle of the upper body
    const cw = Math.max(14, Math.round((ux1 - ux0) * 0.3)), cd = Math.max(12, Math.round((uz1 - uz0) * 0.3));
    const cx0 = ((ux0 + ux1) >> 1) - (cw >> 1), cz0 = ((uz0 + uz1) >> 1) - (cd >> 1) + 2;
    G.box(cx0, 0, cz0, cx0 + cw, gh, cz0 + cd, S.stone);
    for (let x = cx0 + 3; x + 4 <= cx0 + cw - 2; x += 7) G.box(x, 0, cz0 - 1, x + 4, 10, cz0, BM.BRONZE);
    G.box(cx0 + 2, 12, cz0 - 1, cx0 + cw - 2, 14, cz0, BM.LED);
    // columns under the upper body's edge
    const cols = [];
    const colRun = (a0, a1, fn) => { const k = Math.max(1, Math.round((a1 - a0 - 3) / 22)); for (let i = 0; i <= k; ++i) fn(Math.round(a0 + (a1 - a0 - 3) * i / k)); };
    colRun(ux0, ux1, (x) => { cols.push([x, uz0]); cols.push([x, uz1 - 3]); });
    colRun(uz0, uz1, (z) => { cols.push([ux0, z]); cols.push([ux1 - 3, z]); });
    for (const [x, z] of cols) { G.box(x, 0, z, x + 3, gh, z + 3, BM.WHITE_CONCRETE); G.box(x, 0, z, x + 3, 1, z + 3, S.stoneDark); }
    // glass railing round the deck edge (1 voxel thick, metal cap and posts)
    const rail = (x0, z0, x1, z1) => { G.box(x0, 0, z0, x1, 4, z1, BM.GLASS_BLUE); G.box(x0, 4, z0, x1, 5, z1, BM.METAL); };
    rail(0, 0, lw, 1); rail(0, ld - 1, lw, ld); rail(0, 1, 1, ld - 1); rail(lw - 1, 1, lw, ld - 1);
    for (let x = 0; x < lw; x += 12) { G.box(x, 0, 0, x + 1, 5, 1, BM.METAL); G.box(x, 0, ld - 1, x + 1, 5, ld, BM.METAL); }
    for (let z = 0; z < ld; z += 12) { G.box(0, 0, z, 1, 5, z + 1, BM.METAL); G.box(lw - 1, 0, z, lw, 5, z + 1, BM.METAL); }
    // planted beds with trees; open sky where the deck runs past the upper body, so trees there grow taller
    const used = (x0, z0, x1, z1) => { for (let z = z0; z < z1; ++z) for (let x = x0; x < x1; ++x) for (const y of [0, 1, 6]) if (G.at(x, y, z)) return true; return false; };
    const nBeds = 5 + Math.floor(lw * ld / 900);
    let beds = 0;
    for (let t = 0; t < 80 && beds < nBeds; ++t) {
      const bw = 8 + Math.floor(Rg() * 10), bd = 7 + Math.floor(Rg() * 6);
      const x = 3 + Math.floor(Rg() * (lw - bw - 6)), z = 3 + Math.floor(Rg() * (ld - bd - 6));
      if (used(x - 2, z - 2, x + bw + 2, z + bd + 2)) continue;
      const open = x + bw <= ux0 || x >= ux1 || z + bd <= uz0 || z >= uz1;
      G.box(x, 0, z, x + bw, 2, z + bd, S.stoneDark); G.box(x + 1, 1, z + 1, x + bw - 1, 2, z + bd - 1, BM.GRASS);
      const s = 4 + Math.floor(Rg() * 2.6);
      tree(G, x + (bw >> 1), 2, z + (bd >> 1), s, open ? gh - 2 + Math.floor(Rg() * 6) : gh - 3, Rg);
      if (bw >= 14 && Rg() < 0.6) G.box(x + 1, 2, z + 1, x + 4, 4, z + 3, BM.LEAF_DARK);
      // benches along the bed
      if (Rg() < 0.8 && !used(x, z + bd + 1, x + 6, z + bd + 3)) { G.box(x + 1, 0, z + bd + 1, x + 6, 2, z + bd + 3, BM.WOOD); G.box(x + 1, 0, z + bd + 1, x + 2, 1, z + bd + 3, BM.METAL); G.box(x + 5, 0, z + bd + 1, x + 6, 1, z + bd + 3, BM.METAL); }
      ++beds;
    }
    // lawn panels in the remaining open strips
    for (let t = 0; t < 30; ++t) {
      const bw = 10 + Math.floor(Rg() * 14), bd = 6 + Math.floor(Rg() * 8), x = 2 + Math.floor(Rg() * (lw - bw - 4)), z = 2 + Math.floor(Rg() * (ld - bd - 4));
      if (used(x - 1, z - 1, x + bw + 1, z + bd + 1)) continue;
      G.box(x, 0, z, x + bw, 1, z + bd, BM.GRASS);
    }
    E.vox(C, G, lo.x0, yDeck, lo.z0);
    // downlights hanging from the soffit (a strip per bay)
    const Lm = new (L.VoxModel())(ux1 - ux0, 1, uz1 - uz0, 0, 0);
    const inCore = (x, z) => x + ux0 > cx0 - 2 && x + ux0 < cx0 + cw + 2 && z + uz0 > cz0 - 2 && z + uz0 < cz0 + cd + 2;
    for (let z = 7; z < uz1 - uz0 - 6; z += 9) for (let x = 6; x < ux1 - ux0 - 6; x += 2) if (!inCore(x, z) && !inCore(x + 1, z)) Lm.box(x, 0, z, x + 2, 1, z + 1, BM.LED);
    E.vox(C, Lm, up.x0, yUp - 1, up.z0);

    // ---- crown: a sloped screen of stepped louver rows over a dark mechanical wedge, with an LED edge
    const kx0 = up.x0 + 2, kx1 = up.x1 - 2, kz0 = up.z0 + 2, kz1 = up.z1 - 2, kw = kx1 - kx0, kd = kz1 - kz0;
    // rows alternate louver blades (full extent) and recessed metal backing; every second row steps back
    const run = R() < 0.6 ? 1 : 2, rows = 2 * Math.max(14, Math.min(26, Math.floor((kd * 0.5) / run), 18 + Math.floor(R() * 8)));
    const toFront = R() < 0.65;
    const K = new (L.VoxModel())(kw, rows + 24, kd, 0, 0);
    for (let y = 0; y < rows; ++y) {
      const a = Math.floor(y / 2) * run, blade = y % 2 === 1;
      const z0 = toFront ? a : 0, z1 = toFront ? kd : kd - a, e = blade ? 0 : 1;
      K.box(e, y, z0 + (toFront ? e : 0), kw - e, y + 1, z1 - (toFront ? 0 : e), blade ? BM.LOUVER : BM.STEEL_DARK);
      K.box(1, y, toFront ? z0 + 1 : 1, kw - 1, y + 1, toFront ? kd - 1 : z1 - 1, BM.STEEL_DARK);
    }
    // vertical mullions on the sloped face every 8 voxels, LED line at the foot
    for (let x = 0; x < kw; x += 8) for (let y = 0; y < rows; y += 2) {
      const a = Math.floor(y / 2) * run, zz = toFront ? a : kd - a - 1;
      K.box(x, y, zz, x + 1, y + 2, zz + 1, BM.MULLION);
    }
    K.box(0, 0, toFront ? 0 : kd - 1, kw, 1, toFront ? 1 : kd, BM.LED);
    // ridge: LED line along the top of the screen, plant on the flat behind it
    const rz = toFront ? (rows / 2 - 1) * run : kd - (rows / 2 - 1) * run - 1;
    K.box(0, rows, rz, kw, rows + 1, rz + 1, BM.LED);
    const Ru = mul(spec.seed + 5);
    for (let k = 0; k < 3; ++k) {
      const bw = 6 + Math.floor(Ru() * 6), bd = 4 + Math.floor(Ru() * 4), x = 3 + Math.floor(Ru() * (kw - bw - 6));
      const fz0 = toFront ? rz + 3 : 3, fz1 = toFront ? kd - 3 : rz - 3;
      if (fz1 - fz0 < bd + 2) break;
      const z = fz0 + Math.floor(Ru() * (fz1 - fz0 - bd));
      for (let y = 0; y < 5; ++y) K.box(x, rows + y, z, x + bw, rows + y + 1, z + bd, y % 2 ? BM.LOUVER : BM.METAL);
    }
    const mx = (kw >> 1), mz = toFront ? kd - 6 : 5;
    K.box(mx - 1, rows, mz - 1, mx + 1, rows + 20, mz + 1, BM.METAL); K.box(mx - 1, rows + 20, mz - 1, mx + 1, rows + 21, mz + 1, BM.BEACON);
    E.vox(C, K, kx0, yTop, kz0);

    // ---- lobby: deep cantilevered entrance canopy on two slim columns; planters on the lobby roof
    const cs = L.bays(W, 12, 4), ec = cs[cs.length >> 1] + 0, ew = Math.min(W - 16, 40), dd = 22;
    const Q = new (L.VoxModel())(ew, 22, dd + 3, 0, dd + 1);
    Q.box(0, 18, -dd, ew, 21, 2, BM.STEEL_DARK);                       // canopy slab, into the facade
    Q.box(1, 17, -dd + 1, ew - 1, 18, 0, BM.WHITE_CONCRETE);           // soffit panel
    for (let x = 4; x < ew - 4; x += 6) Q.box(x, 16, -dd + 3, x + 2, 17, -2, BM.LED);
    Q.box(0, 21, -dd, ew, 22, -dd + 1, BM.LED);                        // lit edge
    for (const x of [3, ew - 5]) Q.box(x, 0, -dd + 2, x + 2, 17, -dd + 4, BM.STEEL_DARK);
    E.vox(C, Q, ec - (ew >> 1), 0, -0.5);
    const P = new (L.VoxModel())(W, 24, fz, 0, 0), Rp = mul(spec.seed + 99);
    for (let x = 5; x < W - 12; x += 13 + Math.floor(Rp() * 6)) {
      P.box(x, 0, 4, x + 8, 3, 10, S.stoneDark); P.box(x + 1, 2, 5, x + 7, 3, 9, BM.GRASS);
      tree(P, x + 4, 3, 7, 3, 16 + Math.floor(Rp() * 4), Rp);
    }
    E.vox(C, P, 0, lobbyH, 0);
  }

  A.registerTower('skygarden', towerSkygarden);
})();
