// Signature tower 'twins': two slender sister towers on a purpose-built podium, joined by enclosed glass sky
// bridges. The podium is one project with the towers: a lobby portal under each tower, a glazed winter-garden
// atrium in the gap between them, and a planted roof deck with a ridge skylight over the atrium. The towers share
// one facade system (stone piers or metal-finned curtain wall) and crown, but differ in height; the floors the
// bridges reach are glazed full height on every side (sky lobbies). A lot too narrow for two towers with an 8 m
// gap gets a single tower with a cantilevered sky lounge instead.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  const VM = () => L.VoxModel();

  // ---- stacking: tiers at explicit heights (two towers rise side by side with different breaks). Rectangles use
  // facades() (corner returns), masks use prism(). A roof skips the cells covered by any tier starting at its top.
  function stack(E, C, W, D, list, seed) {
    for (const t of list) t._m = t.mask || L.rectMask(W, D, t.x0, t.z0, t.x1, t.z1, 0);
    list.forEach((t, i) => {
      if (t.mask) L.prism(E, C, t._m, W, D, t.y, t.h, t.skin);
      else L.facades(E, t.x0, t.z0, t.x1, t.z1, t.y, (len, side, front) => t.skin(len, t.h, { side, front }), C, true, t.party);
      const yt = t.y + t.h;
      let cover = null;
      for (const u of list) {
        if (u === t || u.y !== yt) continue;
        cover = cover || new Uint8Array(W * D);
        for (let k = 0; k < W * D; ++k) if (u._m[k] && t._m[k]) cover[k] = 1;
      }
      L.roofMask(E, C, t._m, cover, W, D, yt, t.roof || {}, seed + i * 31);
    });
  }

  // pier layout along a facade run of length len: [u0, u1, depth]
  function piers(len, S) {
    const out = [[0, 3, 5]], inner = len - 6, nb = Math.max(1, Math.round(inner / S.pitch));
    for (let k = 1; k < nb; ++k) {
      const u = 3 + Math.round(k * inner / nb) - (S.pw >> 1);
      out.push([u, u + S.pw, S.pierD]);
    }
    out.push([len - 3, len, 5]);
    return out;
  }

  // tower shaft skin. o.f0: absolute floor of the tier's first storey; o.lobby: set of sky-lobby floors;
  // o.cap: crown cornice on top of the tier
  function skinTwin(S, o) {
    return (len, h) => {
      const F = new L.Relief(len, h, 3, S.stone), n = Math.floor(h / FH), P = piers(len, S);
      const near = (Fa) => o.lobby.has(Fa) || o.lobby.has(Fa - 1) || o.lobby.has(Fa + 1);
      for (let f = 0; f < n; ++f) {
        const Fa = o.f0 + f, v = f * FH, lob = o.lobby.has(Fa);
        for (let i = 0; i + 1 < P.length; ++i) {
          const a = P[i][1], b = P[i + 1][0];
          if (b <= a) continue;
          if (lob) {                                                     // sky lobby: storey-high glass, no spandrel
            F.rect(a, v, b, v + FH, 1, L.glassMat(S.seed, i * 7 + 3, Fa, 0.8, S.tint));
            continue;
          }
          F.rect(a, v, b, v + 3, 1, S.span);
          F.rect(a, v + 3, b, v + FH, 1, L.glassMat(S.seed, i * 7 + len, Fa * 3 + (S.side || 0), S.lit, S.tint));
          if (S.mid && b - a >= 5) { const m = (a + b) >> 1; F.rect(m, v + 3, m + 1, v + FH, 2, S.mull); }
        }
        if (lob && !o.lobby.has(Fa - 1)) F.rect(0, v - 2, len, v, S.lobD, S.band);
        if (lob && !o.lobby.has(Fa + 1)) F.rect(0, v + FH, len, v + FH + 2, S.lobD, S.band);
        if (!lob && !near(Fa) && Fa > 0 && Fa % S.bandEvery === 0) F.rect(0, v, len, v + 1, S.bandD, S.band);
      }
      F.rect(0, 0, len, 2, S.bandD, S.band);                                // base course (no open recess at the tier foot)
      for (const [u0, u1, d] of P) F.rect(u0, 0, u1, n * FH, d, u0 === 0 || u1 === len ? S.corner : S.pier);
      if (h > n * FH) {                                                  // tier cap: cornice (setback) or crown band
        F.rect(0, n * FH, len, h, 3, S.band);
        if (o.cap) { F.rect(0, h - 1, len, h, 4, S.trim); }
        for (const [u0, u1, d] of P) F.rect(u0, n * FH, u1, h - (o.cap ? 1 : 0), Math.max(d, 4), u0 === 0 || u1 === len ? S.corner : S.pier);
      }
      F.returns();
      return F;
    };
  }

  // purpose-built podium: granite ground storey, a lobby portal under each tower, a glazed atrium in the gap,
  // two storeys of ribbon windows, stone cornice
  function skinPodium(S, lay) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 3, S.pstone), gH = 20, top = h - 4;
      F.rect(0, 0, len, gH, 2, S.base);
      const front = info.front && len === lay.W;
      const zones = [];
      if (front) {
        for (const c of lay.portals) zones.push([c - 11, c + 11, 'portal', c]);
        if (lay.atrium) zones.push([lay.atrium[0], lay.atrium[1], 'atrium']);
      }
      const inZone = (u0, u1) => zones.some(z => u1 > z[0] - 2 && u0 < z[1] + 2);
      // ground storey shops
      const cs = L.bays(len, 12, 4);
      cs.forEach((c, k) => {
        if (inZone(c - 6, c + 6)) return;
        F.rect(c - 5, 2, c + 5, gH - 6, 1, L.glassMat(S.seed, k, 2, 0.5, 'dark'));
        F.rect(c - 5, gH - 6, c + 5, gH - 4, 1, BM.TRIM_DARK);
        F.rect(c - 1, 2, c + 1, 10, 1, BM.BRONZE);                         // shop door
        F.rect(c - 6, gH - 3, c + 6, gH - 2, 4, S.canopy);                  // shallow fascia ledge
      });
      for (let u = 0; u < len; u += 12) if (!inZone(u, u + 2)) F.rect(u, 0, Math.min(len, u + 2), gH, 3, S.base);
      F.rect(0, 0, len, 2, 3, S.base);                                     // plinth
      F.rect(0, gH, len, gH + 2, 3, S.base);                               // ground-storey cornice
      // upper storeys: ribbon windows with mullions
      for (let f = 0; f < 2; ++f) {
        const v = gH + 2 + f * FH;
        for (let u = 4; u < len - 4; u += 4) {
          if (inZone(u, u + 4) && zones.some(z => z[2] === 'atrium' && u + 4 > z[0] - 2 && u < z[1] + 2)) continue;
          F.rect(u, v + 4, Math.min(len - 4, u + 4), v + FH - 1, 1, L.glassMat(S.seed, u, f + 5, 0.4, S.tint));
          F.rect(u, v + 4, u + 1, v + FH - 1, 2, S.mull);
        }
        F.rect(4, v + 3, len - 4, v + 4, 3, S.pstone);                     // sill line
      }
      for (const z of zones) {
        if (z[2] === 'portal') {
          const c = z[3];
          F.rect(c - 9, 0, c + 9, gH - 1, 0, L.glassMat(S.seed, c, 1, 0.7, 'dark'));
          for (let u = c - 9; u <= c + 8; u += 3) F.rect(u, 0, u + 1, gH - 1, 1, BM.BRONZE);
          F.rect(c - 9, 12, c + 9, 13, 1, BM.BRONZE);
          F.rect(c - 3, 0, c + 3, 11, 1, BM.BRONZE);                        // revolving door drum
          F.rect(c - 2, 1, c + 2, 10, 0, BM.GLASS_DARK_LIT);
          F.rect(c - 11, 0, c - 9, gH + 2, 4, S.base); F.rect(c + 9, 0, c + 11, gH + 2, 4, S.base);
          F.rect(c - 12, gH - 4, c + 12, gH - 2, 7, S.canopy);              // canopy
          F.rect(c - 6, gH + 4, c + 6, gH + 7, 3, S.trim);                   // name plate
        } else {                                                            // atrium: full-height glass, mullion grid
          const [a, b] = [z[0], z[1]];
          F.rect(a, 0, b, top - 1, 0, BM.CURTAIN);
          for (let v = 2; v < top - 1; v += 8) for (let u = a; u < b; u += 4) F.rect(u, v, Math.min(b, u + 4), Math.min(top - 1, v + 8), 0, L.glassMat(S.seed, u, v, 0.45, S.tint));
          for (let u = a; u < b; u += 4) F.rect(u, 0, u + 1, top - 1, 1, S.mull);
          for (let v = 9; v < top - 2; v += 8) F.rect(a, v, b, v + 1, 1, S.mull);
          const m = (a + b) >> 1;
          F.rect(m - 5, 0, m + 5, 11, 1, BM.BRONZE); F.rect(m - 4, 0, m + 4, 10, 0, BM.GLASS_DARK_LIT);
          F.rect(a - 3, 0, a, top, 4, S.pstone); F.rect(b, 0, b + 3, top, 4, S.pstone);
        }
      }
      F.rect(0, top, len, top + 2, 3, S.pstone); F.rect(0, top + 2, len, h - 1, 4, S.pstone); F.rect(0, h - 1, len, h, 4, S.trim);
      F.returns();
      return F;
    };
  }

  // ---- voxel parts
  // enclosed glass sky bridge spanning along x (len) with collars that tuck 1 voxel into each tower wall.
  // Model origin = collar bottom, front-left corner. Footprint z 0..dd, height hh.
  function bridgeModel(len, hh, dd, S, both) {
    const M = new (VM())(len, hh, dd, 0, 0), cL = 5;
    const ends = both ? [[0, cL], [len - cL, len]] : [[0, cL]];
    for (const [a, b] of ends) M.box(a, 0, 0, b, hh, dd, S.collar);                         // collars
    const x0 = both ? cL : cL, x1 = both ? len - cL : len - 1;
    M.box(x0, 1, 1, x1, 4, dd - 1, BM.STEEL_DARK);                                          // deck girder
    M.box(x0, 4, 2, x1, hh - 3, dd - 2, BM.CURTAIN);                                       // glass box
    for (let x = x0; x < x1; x += 4) for (let y = 4, k = 0; y < hh - 3; y += FH - 1, ++k) {
      const m = L.glassMat(S.seed, x * 3 + k, hh, 0.55, S.tint);
      M.box(x, y, 2, Math.min(x1, x + 4), Math.min(hh - 3, y + FH - 1), dd - 2, m);
    }
    for (let x = x0 + 4; x < x1 - 1; x += 4) { M.box(x, 4, 1, x + 1, hh - 3, 2, S.mull); M.box(x, 4, dd - 2, x + 1, hh - 3, dd - 1, S.mull); }
    for (let y = 4 + FH - 1; y < hh - 4; y += FH - 1) M.box(x0, y, 1, x1, y + 1, dd - 1, S.mull);   // floor line
    M.box(x0, hh - 3, 1, x1, hh - 1, dd - 1, S.mull);                                       // roof
    M.box(x0 + 1, hh - 1, 3, x1 - 1, hh, dd - 3, BM.METAL);
    // underside: Warren truss panels on both faces
    for (let x = x0; x + 6 <= x1; x += 6) for (let k = 0; k < 3; ++k) {
      M.box(x + k, 1, 0, x + k + 1, 4, 1, BM.STEEL_DARK); M.box(x + k, 1, dd - 1, x + k + 1, 4, dd, BM.STEEL_DARK);
    }
    return M;
  }
  // sky lounge cantilevering out of the front face (along -z). Model origin at collar bottom; z 0 = outer end.
  function loungeModel(ww, hh, out, S) {
    const M = new (VM())(ww, hh + FH + 4, out + 6, 0, 0), y0 = FH + 2, zw = out + 6;        // struts hang below
    M.box(0, y0, zw - 6, ww, y0 + hh, zw, S.collar);                                       // collar tucked into wall
    M.box(1, y0 + 1, 0, ww - 1, y0 + 4, zw - 6, BM.STEEL_DARK);                             // floor girder
    M.box(2, y0 + 4, 1, ww - 2, y0 + hh - 3, zw - 6, BM.CURTAIN);
    for (let x = 2; x < ww - 2; x += 4) M.box(x, y0 + 4, 1, Math.min(ww - 2, x + 4), y0 + hh - 3, zw - 6, L.glassMat(S.seed, x, 77, 0.7, S.tint));
    for (let z = 1; z < zw - 6; z += 4) for (let x = 2; x < ww - 2; x += 4) {
      if (z === 1) M.box(x, y0 + 4, 0, x + 1, y0 + hh - 3, 1, S.mull);
    }
    for (let z = 4; z < zw - 6; z += 4) { M.box(1, y0 + 4, z, 2, y0 + hh - 3, z + 1, S.mull); M.box(ww - 2, y0 + 4, z, ww - 1, y0 + hh - 3, z + 1, S.mull); }
    M.box(1, y0 + hh - 3, 0, ww - 1, y0 + hh - 1, zw - 6, S.mull);
    M.box(3, y0 + hh - 1, 2, ww - 3, y0 + hh, zw - 7, BM.METAL);
    // raking struts from the wall below up to the outer edge of the floor girder
    for (const sx of [0, ww - 2]) {
      for (let k = 0; k <= y0; ++k) {
        const z = Math.round(zw - 2 - (k / y0) * (zw - 4));
        M.box(sx, k, z - 1, sx + 2, k + 2, z + 1, BM.STEEL_DARK);
      }
      M.box(sx, 0, zw - 3, sx + 2, 4, zw, S.collar);                                   // wall shoe
    }
    return M;
  }
  // crowns: 'stepped' lantern with stone rings and a spire, or 'blades' screen of metal fins rising to the centre
  function crownModel(w, d, S, style, spire) {
    const hw = w >> 1, hd = d >> 1, M = new (VM())(w + 2, 140, d + 2, hw + 1, hd + 1);
    if (style === 'stepped') {
      M.box(-hw + 2, 0, -hd + 2, hw - 2, 18, hd - 2, BM.GLASS_DARK);
      for (let x = -hw + 2; x < hw - 2; x += 4) for (let y = 2; y < 16; y += 7) M.box(x, y, -hd + 2, Math.min(hw - 2, x + 4), y + 6, hd - 2, L.glassMat(S.seed, x, y, 0.6, 'dark'));
      for (let x = -hw + 1; x < hw; x += 4) { M.box(x, 0, -hd + 1, x + 1, 18, -hd + 2, S.stone); M.box(x, 0, hd - 2, x + 1, 18, hd - 1, S.stone); }
      for (let z = -hd + 1; z < hd; z += 4) { M.box(-hw + 1, 0, z, -hw + 2, 18, z + 1, S.stone); M.box(hw - 2, 0, z, hw - 1, 18, z + 1, S.stone); }
      M.box(-hw + 1, 0, -hd + 1, -hw + 4, 18, -hd + 4, S.stone); M.box(hw - 4, 0, -hd + 1, hw - 1, 18, -hd + 4, S.stone);
      M.box(-hw + 1, 0, hd - 4, -hw + 4, 18, hd - 1, S.stone); M.box(hw - 4, 0, hd - 4, hw - 1, 18, hd - 1, S.stone);
      M.box(-hw + 1, 18, -hd + 1, hw - 1, 20, hd - 1, S.stone); M.box(-hw, 20, -hd, hw, 21, hd, S.trim);
      let rx = hw - 4, rz = hd - 4, y = 21, k = 0;
      while (rx > 4 && rz > 4 && k < 4) {
        M.box(-rx, y, -rz, rx, y + 6, rz, k % 2 ? S.band : S.stone);
        for (let x = -rx + 2; x < rx - 2; x += 3) { M.box(x, y + 1, -rz - 1, x + 1, y + 5, -rz, S.trim); M.box(x, y + 1, rz, x + 1, y + 5, rz + 1, S.trim); }
        for (let z = -rz + 2; z < rz - 2; z += 3) { M.box(-rx - 1, y + 1, z, -rx, y + 5, z + 1, S.trim); M.box(rx, y + 1, z, rx + 1, y + 5, z + 1, S.trim); }
        y += 6; rx -= 3; rz -= 3; ++k;
      }
      M.box(-3, y, -3, 3, y + 4, 3, S.trim); M.box(-2, y + 4, -2, 2, y + 10, 2, BM.METAL);
      M.box(-1, y + 10, -1, 1, y + 10 + spire, 1, BM.METAL);
      for (let yy = y + 16; yy < y + 6 + spire; yy += 10) M.box(-2, yy, -2, 2, yy + 1, 2, BM.METAL);
      M.box(-1, y + 10 + spire, -1, 1, y + 11 + spire, 1, BM.BEACON);
    } else {
      // blade crown: a glazed plant room behind a screen of fins that rise towards each face's centre
      M.box(-hw + 4, 0, -hd + 4, hw - 4, 14, hd - 4, BM.LOUVER);
      for (let x = -hw + 4; x < hw - 4; x += 3) M.box(x, 3, -hd + 4, x + 2, 12, hd - 4, L.glassMat(S.seed, x, 31, 0.7, 'dark'));
      for (let y = 1; y < 14; y += 2) M.box(-hw + 3, y, -hd + 3, hw - 3, y + 1, hd - 3, BM.METAL);
      const blade = (x, z) => {
        const t = Math.max(Math.abs(x) / hw, Math.abs(z) / hd);
        const along = Math.abs(x) / hw > Math.abs(z) / hd ? Math.abs(z) / hd : Math.abs(x) / hw;
        return Math.round(22 + (1 - along) * (16 + spire * 0.3)) * (t > 0 ? 1 : 1);
      };
      for (let x = -hw + 1; x < hw - 1; x += 3) { M.box(x, 0, -hd + 1, x + 1, blade(x, -hd), -hd + 3, S.fin); M.box(x, 0, hd - 3, x + 1, blade(x, hd), hd - 1, S.fin); }
      for (let z = -hd + 4; z < hd - 3; z += 3) { M.box(-hw + 1, 0, z, -hw + 3, blade(-hw, z), z + 1, S.fin); M.box(hw - 3, 0, z, hw - 1, blade(hw, z), z + 1, S.fin); }
      M.box(-hw + 1, 0, -hd + 1, hw - 1, 2, hd - 1, S.band);
      M.box(-2, 14, -2, 2, 18, 2, BM.METAL); M.box(-1, 18, -1, 1, 26 + spire, 1, BM.METAL);
      for (let yy = 24; yy < 22 + spire; yy += 10) M.box(-2, yy, -1, 2, yy + 1, 1, BM.METAL);
      M.box(-1, 26 + spire, -1, 1, 27 + spire, 1, BM.BEACON);
    }
    return M;
  }
  function treeModel(R, big) {
    const s = big ? 4 : 3, M = new (VM())(2 * s + 6, 24, 2 * s + 6, s + 3, s + 3), th = big ? 8 : 6;
    M.box(-s - 1, 0, -s - 1, s + 2, 3, s + 2, BM.CONCRETE);                     // planter
    M.box(-s, 3, -s, s + 1, 4, s + 1, BM.GRASS);
    M.box(0, 3, 0, 1, th + 3, 1, BM.TRUNK);
    const lf = R() < 0.5 ? BM.LEAF : BM.LEAF_DARK, y0 = th + 1;
    M.box(-s, y0, -s + 1, s + 1, y0 + 4, s, lf); M.box(-s + 1, y0, -s, s, y0 + 4, s + 1, lf);
    M.box(-s + 1, y0 + 4, -s + 1, s, y0 + 7, s, lf); M.box(-s + 2, y0 + 7, -s + 2, s - 1, y0 + 8, s - 1, lf);
    M.box(-s + 1, y0 - 1, -s + 1, s, y0, s, BM.LEAF_DARK);
    return M;
  }
  // ridge skylight over the atrium, stepped glass with ribs
  function skylightModel(w, d, S) {
    const M = new (VM())(w, 20, d, 0, 0);
    M.box(0, 0, 0, w, 2, d, S.pstone);
    let a = 1, y = 2;
    while (w - 2 * a >= 4) { M.box(a, y, 1, w - a, y + 2, d - 1, BM.CURTAIN); y += 2; a += 2; }
    M.box((w >> 1) - 1, y, 1, (w >> 1) + 1, y + 1, d - 1, S.mull);
    for (let z = 1; z < d - 1; z += 6) { let aa = 0, yy = 2; while (w - 2 * aa >= 4) { M.box(aa, yy, z, aa + 1, yy + 2, z + 1, S.mull); M.box(w - aa - 1, yy, z, w - aa, yy + 2, z + 1, S.mull); yy += 2; aa += 2; } }
    return M;
  }

  // planes a facade run puts at u (relief cell boundaries of its piers)
  function planes(len, S) { const s = new Set(); for (const [a, b] of piers(len, S)) { s.add(a); s.add(b); } return s; }
  // move v until none of v + offsets hits a forbidden value
  function avoid(v, offs, bad) {
    for (let k = 0; k < 12; ++k) for (const s of [1, -1]) {
      const c = v + s * k;
      if (offs.every(o => !bad.has(c + o))) return c;
    }
    return v;
  }

  function towerTwins(E, C, W, D, spec, R) {
    const stone = L.pick(R, [BM.LIMESTONE, BM.BUFF, BM.WHITE_CONCRETE, BM.GRANITE_PINK, BM.LIMESTONE]);
    const mode = R() < 0.55 ? 'stone' : 'curtain';
    const S = {
      seed: spec.seed, mode, tint: L.pick(R, mode === 'stone' ? ['green', 'dark', 'curtain'] : ['curtain', 'blue', 'green', 'dark']),
      lit: 0.32, bandEvery: L.pick(R, [5, 6, 8])
    };
    if (mode === 'stone') Object.assign(S, { stone, pier: stone, corner: stone, band: stone === BM.LIMESTONE ? BM.LIMESTONE_DARK : stone, trim: L.pick(R, [BM.BRONZE, BM.LIMESTONE_DARK]),
      span: L.pick(R, [BM.BRONZE, BM.SPANDREL]), mull: BM.BRONZE, pitch: L.pick(R, [6, 7]), pw: 2, pierD: 4, bandD: 3, lobD: 3, mid: true, fin: stone });
    else Object.assign(S, { stone: BM.MULLION, pier: L.pick(R, [BM.METAL, BM.MULLION, BM.METAL]), corner: BM.MULLION, band: BM.STEEL_DARK, trim: BM.METAL,
      span: BM.SPANDREL, mull: BM.MULLION, pitch: 5, pw: 1, pierD: 3, bandD: 2, lobD: 4, mid: false, fin: BM.METAL });
    S.pstone = mode === 'stone' && R() < 0.65 ? (stone === BM.GRANITE_PINK ? BM.GRANITE_PINK : stone) : L.pick(R, [BM.LIMESTONE, BM.GRANITE_DARK, BM.LIMESTONE_DARK]);
    S.base = S.pstone === BM.GRANITE_DARK ? BM.STEEL_DARK : BM.GRANITE_DARK;
    S.canopy = L.pick(R, [BM.BRONZE, BM.STEEL_DARK]); S.collar = S.mode === 'stone' ? S.band : BM.STEEL_DARK;
    S.trim = S.trim || BM.BRONZE;
    const podH = 20 + 2 + 2 * FH + 6, crownStyle = R() < 0.5 ? 'stepped' : 'blades';
    const n = Math.max(26, Math.min(52, Math.round(spec.floors * (1.05 + R() * 0.3)))), dn = 2 + Math.floor(R() * 4);

    // plan: two towers along the street with a >= 8 m (32 voxel) gap, or one tower
    const m = 5, td0 = Math.max(36, Math.min(72, Math.round(D * (0.5 + R() * 0.12))));
    const td = Math.min(td0, D - 16), tz0 = Math.max(8, Math.min(D - td - 8, Math.round((D - td) * (0.3 + R() * 0.2))));
    let tw = Math.min(52, Math.floor((W - 2 * m - 32) / 2));
    const twin = tw >= 36 && td >= 36;
    const list = [], lobby = new Set(), towers = [];
    const pod = Object.assign(L.inset(W, D, 0, 0, 0, 0), { y: 0, h: podH, skin: null, party: spec.party, roof: { mat: S.pstone, deck: BM.CONCRETE, parapet: 3 } });
    list.push(pod);
    const tierSet = (x0, x1, nf, s1) => {
      // shaft, setback upper shaft, crown tier
      const t = [];
      const y1 = podH + s1 * FH + 2, y2 = y1 + (nf - 3 - s1) * FH;
      t.push({ x0, z0: tz0, x1, z1: tz0 + td, y: podH, h: s1 * FH + 2, f0: 0, nf: s1, roof: { mat: S.band, parapet: 2 } });
      t.push({ x0: x0 + 4, z0: tz0 + 4, x1: x1 - 4, z1: tz0 + td - 4, y: y1, h: (nf - 3 - s1) * FH, f0: s1, nf: nf - 3 - s1, roof: { mat: S.band, parapet: 2 } });
      t.push({ x0: x0 + 8, z0: tz0 + 8, x1: x1 - 8, z1: tz0 + td - 8, y: y2, h: 3 * FH + 3, f0: nf - 3, nf: 3, cap: true, roof: { mat: S.trim, parapet: 2 } });
      return t;
    };
    const yOf = (tiers, Fa) => { for (const t of tiers) if (Fa >= t.f0 && Fa < t.f0 + t.nf) return { y: t.y + (Fa - t.f0) * FH, t }; return null; };
    let lay;
    if (twin) {
      const gap = Math.min(56, W - 2 * m - 2 * tw), mm = (W - 2 * tw - gap) >> 1;
      const ax0 = mm, ax1 = mm + tw, bx0 = ax1 + gap, bx1 = bx0 + tw;
      const tallLeft = R() < 0.5, nA = tallLeft ? n : n - dn, nB = tallLeft ? n - dn : n, nLo = Math.min(nA, nB);
      const s1 = Math.round(nLo * (0.6 + R() * 0.1));
      const fL = Math.round(nLo * (0.36 + R() * 0.12)), two = R() < 0.6 && nLo - 7 > s1 + 1;
      const fU = nLo - 6;
      const bridges = [{ f: fL, k: 2 }];
      if (two) bridges.push({ f: fU, k: 1 });
      for (const b of bridges) for (let i = 0; i < b.k; ++i) lobby.add(b.f + i);
      towers.push({ tiers: tierSet(ax0, ax1, nA, s1), nf: nA }, { tiers: tierSet(bx0, bx1, nB, s1), nf: nB });
      lay = { W, portals: [(ax0 + ax1) >> 1, (bx0 + bx1) >> 1], atrium: [ax1 + 4, bx0 - 4], gap: [ax1, bx0] };
      lay.bridges = bridges;
    } else {
      tw = Math.min(56, W - 2 * Math.max(8, Math.round(W * 0.12)));
      S.pitch = Math.max(4, S.pitch - 1); S.mid = true; S.bandEvery = 4;                // one tower carries the finer grain
      const nS = Math.min(54, Math.round(n * 1.2)), x0 = (W - tw) >> 1, fL = Math.round(nS * (0.66 + R() * 0.1));
      lobby.add(fL); lobby.add(fL + 1);
      towers.push({ tiers: tierSet(x0, x0 + tw, nS, Math.round(nS * 0.55)), nf: nS });
      lay = { W, portals: [W >> 1], atrium: null, lounge: { f: fL } };
    }
    pod.skin = skinPodium(S, lay);
    for (const T of towers) for (const t of T.tiers) {
      t.skin = skinTwin(S, { f0: t.f0, lobby, cap: !!t.cap });
      list.push(t);
    }
    stack(E, C, W, D, list, spec.seed);

    // crowns
    towers.forEach((T, i) => {
      const t = T.tiers[2], w = t.x1 - t.x0 - 4, d = t.z1 - t.z0 - 4;
      const tall = T.nf === Math.max(...towers.map(q => q.nf));
      E.vox(C, crownModel(w - (w & 1), d - (d & 1), S, crownStyle, tall ? 34 + Math.floor(R() * 14) : 18), (t.x0 + t.x1) >> 1, t.y + t.h, (t.z0 + t.z1) >> 1);
    });

    if (twin) {
      // sky bridges between the inner faces
      for (const b of lay.bridges) {
        const pa = yOf(towers[0].tiers, b.f), pb = yOf(towers[1].tiers, b.f);
        const ta = pa.t, tb = pb.t;
        const x0 = ta.x1 - 1, x1 = tb.x0 + 1;
        const dd = Math.max(14, Math.min(22, Math.round((ta.z1 - ta.z0) * 0.38)));
        // keep the collar's side faces off the pier planes of both inner faces
        const bad = new Set();
        for (const u of planes(ta.z1 - ta.z0, S)) bad.add(ta.z0 + u);
        for (const u of planes(tb.z1 - tb.z0, S)) bad.add(tb.z1 - u);
        const z0 = avoid(((ta.z0 + ta.z1) >> 1) - (dd >> 1), [0, dd], bad);
        const hh = b.k * FH - 2;
        E.vox(C, bridgeModel(x1 - x0, hh, dd, S, true), x0, pa.y + 1, z0);
      }
      // podium roof: ridge skylight over the atrium, gardens around it
      const g0 = lay.gap[0] + 7, g1 = lay.gap[1] - 7, yd = podH;
      if (g1 - g0 >= 12) {
        const sw = g1 - g0 - 8;
        E.vox(C, skylightModel(sw - (sw & 1), Math.max(12, td - 16), S), g0 + 4, yd, tz0 + 8);
        const Rt = R;
        for (let z = 8; z < tz0 - 4; z += 12) for (let x = g0; x <= g1 - 8; x += Math.max(10, (g1 - g0 - 8) >> 1)) E.vox(C, treeModel(Rt, false), x + 3, yd, z);
        for (const x of [g0 + 2, g1 - 6]) for (let z = tz0 + td + 6; z < D - 8; z += 12) E.vox(C, treeModel(Rt, true), x, yd, z);
      }
      // front podium terrace planters along the front of each tower
      if (tz0 >= 16) for (const T of towers) {
        const t = T.tiers[0];
        for (let x = t.x0 + 4; x + 8 <= t.x1 - 2; x += 12) E.vox(C, treeModel(R, false), x + 3, yd, Math.max(6, tz0 - 9));
      }
    } else {
      // cantilevered sky lounge on the front face
      const t = yOf(towers[0].tiers, lay.lounge.f), T = t.t;
      const fw = T.x1 - T.x0, ww = Math.max(20, Math.round(fw * (0.55 + R() * 0.1)));
      const bad = new Set();
      for (const u of planes(fw, S)) bad.add(T.x0 + u);
      const x0 = avoid(((T.x0 + T.x1) >> 1) - (ww >> 1), [0, 2, ww - 2, ww], bad);
      const out = 18 + Math.floor(R() * 8);
      E.vox(C, loungeModel(ww, 2 * FH - 2, out, S), x0, t.y + 1 - (FH + 2), T.z0 + 1 - (out + 6));
      // garden on the podium deck around the tower
      const T0 = towers[0].tiers[0];
      for (const x of [6, W - 14]) for (let z = 8; z < D - 10; z += 14) if (x + 10 < T0.x0 - 3 || x > T0.x1 + 3) E.vox(C, treeModel(R, z % 28 === 8), x + 4, podH, z + 4);
      if (tz0 >= 16) for (let x = T0.x0 + 4; x + 8 <= T0.x1 - 2; x += 12) E.vox(C, treeModel(R, false), x + 3, podH, Math.max(6, tz0 - 9));
      if (D - (tz0 + td) >= 16) for (let x = T0.x0 + 4; x + 8 <= T0.x1 - 2; x += 12) E.vox(C, treeModel(R, true), x + 3, podH, tz0 + td + 8);
    }
  }
  A.registerTower('twins', towerTwins);
})();
