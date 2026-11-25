// Wave: a contemporary residential tower wrapped in white concrete balcony slabs whose edges undulate floor by
// floor. Each slab's depth follows a sine along the facade perimeter (corners rounded and wrapped), with a phase
// that drifts from floor to floor, so the white bands and glass railings ripple across the whole tower. It stands
// on its own podium (shops, a residents' lobby, an amenity floor) whose roof is a landscaped terrace; the top is
// a glass amenity pavilion under a floating white roof, with planters and a plunge pool.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  const TAU = Math.PI * 2;

  // ---- podium: shopfronts + lobby on the street, amenity floor with ribbon windows, white concrete frame
  function skinPodium(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, BM.WHITE_CONCRETE), gH = 20;
      const front = info.which === 0;
      if (front) {
        const mid = len >> 1;
        // shop bays between white piers
        const step = 26, n = Math.max(1, Math.round(len / step)), bw = len / n;
        for (let k = 0; k < n; ++k) {
          const u0 = Math.round(k * bw), u1 = Math.round((k + 1) * bw);
          if (u1 > mid - 12 && u0 < mid + 12) continue;
          F.rect(u0 + 2, 1, u1 - 2, gH - 5, 1, L.glassMat(S.seed, k, 1, 0.55, 'dark'));
          for (let u = u0 + 2; u < u1 - 2; u += 6) F.rect(u, 1, u + 1, gH - 5, 2, BM.MULLION);
          F.rect(u0 + 2, gH - 5, u1 - 2, gH - 2, 1, BM.STEEL_DARK);                                // sign band
          const dc = u0 + 2 + ((u1 - u0 - 4) >> 1);
          F.rect(dc - 2, 1, dc + 2, 11, 0, BM.STEEL_DARK);                                          // shop door
          F.rect(u0 + 3, gH - 4, u0 + 3 + Math.min(10, u1 - u0 - 8), gH - 3, 2, L.H2(S.seed, k, 9) < 0.5 ? BM.LED : BM.NEON);   // shop sign
        }
        // residents' lobby: deep double-height glass recess with a wood-lined portal and a slim canopy
        F.rect(mid - 12, 0, mid + 12, gH + 4, 4, BM.WHITE_CONCRETE);
        F.rect(mid - 10, 0, mid + 10, gH + 2, 0, L.glassMat(S.seed, 3, 3, 0.8, 'dark'));
        for (let u = mid - 10; u < mid + 10; u += 5) F.rect(u, 0, u + 1, gH + 2, 1, BM.MULLION);
        F.rect(mid - 3, 0, mid + 3, 11, 1, BM.STEEL_DARK);
        F.rect(mid - 11, gH + 2, mid + 11, gH + 4, 2, BM.WOOD);
        F.rect(mid - 14, 13, mid + 14, 14, 8, BM.WHITE_CONCRETE);                                    // canopy
        // continuous shop canopy over the rest of the street front
        for (let u = 0; u < len; ++u) if (u < mid - 14 || u >= mid + 14) F.rect(u, gH - 2, u + 1, gH - 1, 6, BM.WHITE_CONCRETE);
      } else {
        // sides and back: louvred service bays + glazed corners at street level
        F.rect(0, 1, len, gH - 2, 2, BM.WHITE_CONCRETE);
        for (let u = 4; u + 10 < len - 4; u += 14) {
          const nearFront = info.which === 3 ? u < 24 : info.which === 2 ? u > len - 28 : false;
          if (nearFront) { F.rect(u, 1, u + 10, gH - 4, 1, L.glassMat(S.seed, u, 5, 0.5, 'dark')); continue; }
          for (let v = 3; v < gH - 4; v += 2) F.rect(u, v, u + 10, v + 1, 1, BM.LOUVER);
        }
      }
      F.rect(0, 0, len, 1, 3, BM.GRANITE_DARK);                                                      // plinth
      F.rect(0, gH, len, gH + 2, 3, BM.WHITE_CONCRETE);
      // amenity floor: ribbon window with mullions
      F.rect(0, gH + 4, len, h - 5, 1, BM.CURTAIN);
      for (let u = 0; u < len; u += 4) F.rect(u, gH + 4, u + 1, h - 5, 2, BM.MULLION);
      for (let u = 2; u < len; u += 8) if (L.H2(S.seed, u, 21) < 0.45) F.rect(u - 1, gH + 4, u + 2, h - 5, 1, BM.CURTAIN_LIT);
      F.rect(0, h - 5, len, h, 3, BM.WHITE_CONCRETE);                                                // fascia
      if (front) F.rect((len >> 1) - 12, gH, (len >> 1) + 12, gH + 4, 4, BM.WHITE_CONCRETE);
      F.returns();
      return F;
    };
  }

  // ---- tower body behind the balconies: floor-to-ceiling glass, slim mullions, spandrel around each slab
  function skinBody(S, n) {
    return (len, h) => {
      const F = new L.Relief(len, h, 1, BM.SPANDREL);
      for (let f = 0; f < n; ++f) {
        const v = f * FH;
        for (let u = 0; u < len; u += 8) F.rect(u, v + 3, Math.min(len, u + 8), v + FH - 1, 1, L.glassMat(S.seed, u * 7 + 1, f, 0.3, S.tint));
        for (let u = 0; u < len; u += 8) F.rect(u, v + 3, u + 1, v + FH - 1, 1, BM.MULLION);
      }
      return F;
    };
  }

  function tier(E, C, t, y, party) {
    let k = 0;
    L.facades(E, t.x0, t.z0, t.x1, t.z1, y, (len, side, front) => t.skin(len, t.h, { side, front, which: k++ }), C, false, party);
  }

  // ---- one balcony ring: white slab whose edge depth follows depth(s) around the perimeter, glass railing
  function slabRing(tw, td, m, depth, S, f, top) {
    const M = new (L.VoxModel())(tw + 2 * m, 8, td + 2 * m, m, m);
    const P = 2 * (tw + td);
    const sOf = (x, z) => {
      const cx = Math.min(tw, Math.max(0, x + 0.5)), cz = Math.min(td, Math.max(0, z + 0.5));
      if (z < 0) return cx;
      if (x >= tw) return tw + cz;
      if (z >= td) return tw + td + (tw - cx);
      return 2 * tw + td + (td - cz);
    };
    const inT = (x, z) => x >= 0 && z >= 0 && x < tw && z < td;
    const on = new Uint8Array((tw + 2 * m) * (td + 2 * m));
    const id = (x, z) => (z + m) * (tw + 2 * m) + (x + m);
    for (let z = -m; z < td + m; ++z) for (let x = -m; x < tw + m; ++x) {
      if (inT(x, z)) continue;
      const dx = x < 0 ? -x - 0.5 : x >= tw ? x - tw + 0.5 : 0, dz = z < 0 ? -z - 0.5 : z >= td ? z - td + 0.5 : 0;
      const dist = dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz);
      if (dist <= depth(sOf(x, z) / P)) on[id(x, z)] = 1;
    }
    const slab = top ? 4 : 3, rail = 4;
    const isOn = (x, z) => x >= -m && z >= -m && x < tw + m && z < td + m && (inT(x, z) || on[id(x, z)] === 1);
    for (let z = -m; z < td + m; ++z) {
      let x = -m;
      while (x < tw + m) {                                                                         // slab runs
        if (!on[id(x, z)] || inT(x, z)) { ++x; continue; }
        let x1 = x; while (x1 < tw + m && on[id(x1, z)] && !inT(x1, z)) ++x1;
        M.box(x, 0, z, x1, slab, z + 1, BM.WHITE_CONCRETE);
        x = x1;
      }
      for (x = -m; x < tw + m; ++x) {
        if (!on[id(x, z)] || inT(x, z)) continue;
        if (isOn(x - 1, z) && isOn(x + 1, z) && isOn(x, z - 1) && isOn(x, z + 1)) continue;
        M.box(x, slab, z, x + 1, slab + rail, z + 1, S.rail);
      }
    }
    // a few potted plants on the balconies
    if (!top) for (let k = 0; k < 4; ++k) {
      const s = L.H2(S.seed, f, k), side = Math.floor(s * 4), t = (s * 4) % 1;
      let x, z;
      if (side === 0) { x = Math.floor(t * (tw - 8)) + 4; z = -2; }
      else if (side === 1) { x = tw + 1; z = Math.floor(t * (td - 8)) + 4; }
      else if (side === 2) { x = Math.floor(t * (tw - 8)) + 4; z = td + 1; }
      else { x = -3; z = Math.floor(t * (td - 8)) + 4; }
      if (!isOn(x, z) || !isOn(x + 1, z + 1) || !isOn(x, z + 1) || !isOn(x + 1, z)) continue;
      M.box(x, slab, z, x + 2, slab + 2, z + 1 + 1, BM.TERRACOTTA);
      M.box(x, slab + 2, z, x + 2, slab + 4, z + 2, L.H2(S.seed, f, k + 9) < 0.5 ? BM.LEAF : BM.LEAF_DARK);
    }
    return M;
  }

  // ---- trees and planters
  function tree(M, x, y, z, R, big) {
    const th = big ? 9 + Math.floor(R() * 4) : 6 + Math.floor(R() * 3), r = big ? 4 + R() * 1.5 : 2.6 + R();
    M.box(x, y, z, x + 1, y + th, z + 1, BM.TRUNK);
    const cy = y + th + r * 0.5;
    const R0 = Math.ceil(r);
    for (let dy = -R0; dy <= R0; ++dy) for (let dz = -R0; dz <= R0; ++dz) for (let dx = -R0; dx <= R0; ++dx) {
      const q = Math.hypot(dx, dy * 1.25, dz);
      if (q > r) continue;
      const hsh = L.H2(x * 31 + dx, z * 17 + dz, dy + 99);
      if (q > r - 1 && hsh < 0.35) continue;                                                      // ragged edge
      M.box(x + dx, Math.round(cy + dy), z + dz, x + dx + 1, Math.round(cy + dy) + 1, z + dz + 1, hsh < 0.5 ? BM.LEAF : BM.LEAF_DARK);
    }
  }
  function planter(M, x0, y, z0, x1, z1, mat) {
    M.box(x0, y, z0, x1, y + 3, z1, mat);
    M.box(x0 + 1, y + 3, z0 + 1, x1 - 1, y + 4, z1 - 1, BM.GRASS);
  }

  function terraceModel(W, D, t, m, S, R) {
    // podium roof garden around the tower: lawn, timber deck, planters with trees, pergola with benches
    const M = new (L.VoxModel())(W, 34, D, 0, 0);
    const free = (x, z) => x >= 2 && z >= 2 && x < W - 2 && z < D - 2 && !(x >= t.x0 - m - 2 && x < t.x1 + m + 2 && z >= t.z0 - m - 2 && z < t.z1 + m + 2);
    const freeR = (x0, z0, x1, z1) => { for (let z = z0; z < z1; ++z) for (let x = x0; x < x1; ++x) if (!free(x, z)) return false; return true; };
    // front strip: lawn in the middle, timber decks either side, a row of trees along the street edge
    const fz1 = t.z0 - m - 3;
    if (fz1 > 8) {
      const mid = W >> 1, lw = Math.min(W - 30, 56);
      M.box(mid - (lw >> 1), 0, 4, mid + (lw >> 1), 1, fz1 - 1, BM.GRASS);
      M.box(4, 0, 4, mid - (lw >> 1) - 2, 1, fz1 - 1, BM.WOOD);
      M.box(mid + (lw >> 1) + 2, 0, 4, W - 4, 1, fz1 - 1, BM.WOOD);
      for (let x = 6; x + 5 < W - 4; x += 16) {
        if (x > mid - (lw >> 1) - 4 && x < mid + (lw >> 1)) { planter(M, x, 1, 4, x + 5, 9, BM.WHITE_CONCRETE); tree(M, x + 2, 5, 6, R, true); }
        else { planter(M, x, 1, 4, x + 5, 9, BM.WHITE_CONCRETE); tree(M, x + 2, 5, 6, R, false); }
      }
      // pergola with benches on one side
      const px = R() < 0.5 ? 6 : W - 30;
      if (fz1 > 18 && px + 24 < W - 2) {
        for (const x of [px, px + 11, px + 22]) for (const z of [11, fz1 - 3]) M.box(x, 1, z, x + 1, 13, z + 1, BM.WOOD);
        for (let x = px - 1; x < px + 24; x += 2) M.box(x, 13, 10, x + 1, 14, fz1 - 1, BM.WOOD);
        M.box(px - 1, 12, 11, px + 24, 13, 12, BM.WOOD); M.box(px - 1, 12, fz1 - 3, px + 24, 13, fz1 - 2, BM.WOOD);
        M.box(px + 3, 1, 14, px + 9, 3, 16, BM.WOOD); M.box(px + 14, 1, 14, px + 20, 3, 16, BM.WOOD);
      }
    }
    // side strips: planters with small trees, alternating with shrub beds
    for (const sx of [3, W - 9]) {
      for (let z = Math.max(fz1 + 2, 12); z + 6 < D - 4; z += 14) {
        if (!freeR(sx, z, sx + 6, z + 6)) continue;
        planter(M, sx, 1, z, sx + 6, z + 6, BM.WHITE_CONCRETE);
        if (L.H2(S.seed, sx, z) < 0.6) tree(M, sx + 3, 5, z + 3, R, false);
        else M.box(sx + 1, 4, z + 1, sx + 5, 6, z + 5, BM.LEAF_DARK);
      }
    }
    // planter boxes along the street parapet
    for (let x = 4; x + 10 < W - 4; x += 16) if (freeR(x + 6, 1, x + 16, 3)) M.box(x + 6, 0, 1, x + 15, 3, 3, BM.LEAF_DARK);
    return M;
  }

  function pavilionModel(rw, rd, S, R) {
    // roof amenity: glass pavilion under a thin overhanging white roof, lift core, planters, plunge pool, loungers
    const M = new (L.VoxModel())(rw, 30, rd, 0, 0);
    const pw = Math.max(20, Math.round(rw * (0.4 + R() * 0.15))), pd = Math.max(16, Math.round(rd * 0.42));
    const px = R() < 0.5 ? 6 : rw - 6 - pw, pz = rd - 6 - pd;
    M.box(px, 0, pz, px + pw, 13, pz + pd, L.H2(S.seed, 1, 2) < 0.6 ? BM.GLASS_LIT : BM.GLASS);
    for (let x = px; x < px + pw; x += 4) { M.box(x, 0, pz, x + 1, 13, pz + 1, BM.MULLION); M.box(x, 0, pz + pd - 1, x + 1, 13, pz + pd, BM.MULLION); }
    for (let z = pz; z < pz + pd; z += 4) { M.box(px, 0, z, px + 1, 13, z + 1, BM.MULLION); M.box(px + pw - 1, 0, z, px + pw, 13, z + 1, BM.MULLION); }
    M.box(px - 4, 13, pz - 5, px + pw + 4, 15, pz + pd + 3, BM.WHITE_CONCRETE);                     // floating roof
    // lift / stair core behind, in white concrete with a louvred top
    const cx = px + (pw >> 1) - 6;
    M.box(cx, 15, pz + 2, cx + 12, 22, pz + pd - 4, BM.WHITE_CONCRETE);
    for (let y = 16; y < 21; y += 2) M.box(cx - 1 + 1, y, pz + 1, cx + 12 - 1, y + 1, pz + 2, BM.LOUVER);
    // plunge pool + loungers in front of the pavilion
    const qw = Math.min(28, rw - 20), qx = (rw - qw) >> 1, qz = 6;
    if (pz - 5 > qz + 16) {
      M.box(qx, 0, qz, qx + qw, 2, qz + 8, BM.WHITE_CONCRETE);
      M.box(qx + 1, 0, qz + 1, qx + qw - 1, 1, qz + 7, BM.WATER);
      M.box(qx + 1, 1, qz + 1, qx + qw - 1, 2, qz + 7, -1);
      for (let x = qx + 2; x + 3 < qx + qw; x += 6) M.box(x, 0, qz + 10, x + 3, 1, qz + 15, BM.TRIM);
    }
    // planters around the edge
    for (let x = 3; x + 6 < rw - 3; x += 12) { planter(M, x, 0, 1, x + 6, 4, BM.WHITE_CONCRETE); M.box(x + 1, 4, 2, x + 5, 6, 3, BM.LEAF_DARK); }
    for (const z of [rd >> 2, rd >> 1]) for (const x of [1, rw - 5]) {
      if (z + 6 < pz - 5 || x + 4 < px - 4 || x > px + pw + 4) { planter(M, x, 0, z, x + 4, z + 6, BM.WHITE_CONCRETE); tree(M, x + 2, 4, z + 3, R, false); }
    }
    return M;
  }

  function towerWave(E, C, W, D, spec, R) {
    const S = {
      seed: spec.seed, tint: L.pick(R, ['blue', 'curtain', 'green', 'dark']),
      rail: L.pick(R, [BM.GLASS_BLUE, BM.CURTAIN, BM.GLASS_GREEN])
    };
    const amp = 3 + R() * 5, dmin = 3, m = Math.ceil(dmin + amp) + 2;
    const pH = 20 + FH + 3;
    const sx = Math.max(m + 4, Math.round(W * (0.08 + R() * 0.05)));
    const fz = Math.max(m + 16, Math.round(D * (0.2 + R() * 0.08))), bz = m + 3;
    const t = { x0: sx, z0: fz, x1: W - sx, z1: D - bz };
    const tw = t.x1 - t.x0, td = t.z1 - t.z0;
    const n = Math.max(16, Math.min(40, Math.floor(7600 / (tw + td)), Math.floor(spec.floors * (0.9 + R() * 0.3))));   // ~90k tris cap
    // podium
    const pod = { x0: 0, z0: 0, x1: W, z1: D, h: pH, skin: skinPodium(S) };
    tier(E, C, pod, 0, spec.party);
    const pm = L.rectMask(W, D, 0, 0, W, D, 0), tm = L.rectMask(W, D, t.x0, t.z0, t.x1, t.z1, 0);
    L.roofMask(E, C, pm, tm, W, D, pH, { parapet: 4, mat: S.rail, deck: BM.PRECAST }, spec.seed);
    E.vox(C, terraceModel(W, D, t, m, S, R), 0, pH, 0);
    // tower body
    const body = Object.assign({}, t, { h: n * FH, skin: skinBody(S, n) });
    tier(E, C, body, pH, null);
    const yTop = pH + n * FH;
    L.roofMask(E, C, tm, null, W, D, yTop, { parapet: 0, deck: BM.WOOD }, spec.seed + 5);
    // undulating balconies: the wave count fits the perimeter so the ripple closes around the corners
    const P = 2 * (tw + td), waves = Math.max(3, Math.round(P / (38 + R() * 40)));
    const mode = R() < 0.55 ? 'drift' : 'sway', dphi = (0.22 + R() * 0.3) * (R() < 0.5 ? 1 : -1), sway = 1.2 + R() * 1.4;
    for (let f = 1; f <= n; ++f) {
      const ph = mode === 'drift' ? f * dphi : sway * Math.sin(f * 0.33);
      const depth = (u) => dmin + amp * (0.5 + 0.5 * Math.sin(TAU * waves * u + ph));
      const top = f === n;
      E.vox(C, slabRing(tw, td, m, depth, S, f, top), t.x0, pH + f * FH - (top ? 4 : 1), t.z0);
    }
    // rooftop amenity pavilion
    E.vox(C, pavilionModel(tw, td, S, R), t.x0, yTop, t.z0);
  }

  A.registerTower('wave', towerWave);
})();
