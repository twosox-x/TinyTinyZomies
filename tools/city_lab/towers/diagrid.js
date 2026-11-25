// Tower 'diagrid': a contemporary glass tower wrapped in an expressed steel diagrid, rising out of a preserved
// 5-6 storey masonry building (facade retention, Hearst-style). The old building keeps its shopfronts, cornice and
// roof; the tower is set back behind a planted roof terrace and floats on a recessed glass reveal storey, carried
// by the diagrid's own node columns. Diagonals span 4-6 storey modules and meet at ring beams; corners are notched
// and closed by corner posts; the diagrid runs half a module past the roof as an open crown that screens the plant.
// The curtain wall is a flush relief (frame at the wall plane, glass recessed); the steel is voxel geometry that
// starts exactly at the wall plane and projects outwards, so steel and glass never share a visible plane.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;

  // straight runs of a mask outline (same convention as CityArch prism): t = side facing out, L = plane, [s, e)
  function outlineRuns(mask, W, D) {
    const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1;
    const runs = [];
    for (let z = 0; z <= D; ++z) {
      let cur = null;
      for (let x = 0; x <= W; ++x) {
        const a = inn(x, z - 1), b = inn(x, z), t = x < W ? (b && !a ? 'nz' : a && !b ? 'pz' : null) : null;
        if (cur && cur.t !== t) { runs.push(cur); cur = null; }
        if (t && !cur) cur = { t, s: x, e: x + 1, L: z }; else if (t) cur.e = x + 1;
      }
    }
    for (let x = 0; x <= W; ++x) {
      let cur = null;
      for (let z = 0; z <= D; ++z) {
        const a = inn(x - 1, z), b = inn(x, z), t = z < D ? (b && !a ? 'nx' : a && !b ? 'px' : null) : null;
        if (cur && cur.t !== t) { runs.push(cur); cur = null; }
        if (t && !cur) cur = { t, s: z, e: z + 1, L: x }; else if (t) cur.e = z + 1;
      }
    }
    return runs;
  }
  // building cell of along-run coordinate u and outward offset o (o = 0 is the first cell outside the wall)
  function cellOf(r, u, o) {
    if (r.t === 'nz') return [r.s + u, r.L - 1 - o];
    if (r.t === 'pz') return [r.s + u, r.L + o];
    if (r.t === 'nx') return [r.L - 1 - o, r.s + u];
    return [r.L + o, r.s + u];
  }
  function erode(mask, W, D, k) {
    const m = new Uint8Array(W * D);
    for (let z = k; z < D - k; ++z) for (let x = k; x < W - k; ++x) {
      let ok = 1;
      for (let dz = -k; dz <= k && ok; ++dz) for (let dx = -k; dx <= k; ++dx) if (!mask[(z + dz) * W + x + dx]) { ok = 0; break; }
      m[z * W + x] = ok;
    }
    return m;
  }

  function towerDiagrid(E, C, W, D, spec, R) {
    const VM = L.VoxModel(), seed = spec.seed;

    // ---- the preserved building
    const brick = R() < 0.5;
    const SH = { seed: seed + 11, wall: brick ? L.pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK]) : L.pick(R, [BM.LIMESTONE, BM.BUFF]),
      base: L.pick(R, [BM.LIMESTONE_DARK, BM.GRANITE_DARK]), awning: L.pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]),
      shops: true, bayW: L.pick(R, [9, 10, 11]), lintels: true, trim: BM.TRIM, corniceMat: brick ? BM.LIMESTONE_DARK : BM.LIMESTONE_DARK };
    const bf = 5 + Math.floor(R() * 2), bh = bf * 14 + 5;

    // ---- the tower: set back behind a roof terrace, notched corners
    const steel = L.pick(R, [BM.METAL, BM.WHITE_CONCRETE, BM.STEEL_DARK, BM.METAL]);
    const tint = L.pick(R, ['blue', 'curtain', 'green', 'dark']);
    const frame = steel === BM.STEEL_DARK ? BM.MULLION : L.pick(R, [BM.MULLION, BM.STEEL_DARK]);
    const k = 4 + Math.floor(R() * 3), Hm = k * FH;                  // module: k storeys
    const sf = Math.max(18, Math.round(D * (0.14 + R() * 0.14)));
    const sx = Math.max(7, Math.round(W * (0.05 + R() * 0.08))), sb = 7 + Math.floor(R() * 4);
    const tx0 = sx, tx1 = W - sx, tz0 = sf, tz1 = D - sb;
    const notch = Math.max(6, Math.min(14, 2 * Math.round(Math.min(tx1 - tx0, tz1 - tz0) * (0.06 + R() * 0.05))));
    const tMask = L.rectMask(W, D, tx0, tz0, tx1, tz1, notch);
    const RV = 14;                                                   // reveal storey
    const n = Math.max(24, Math.round(spec.floors * (1.0 + R() * 0.35)));
    const nt = Math.max(3, Math.round((n - bf - 1) / k)) * k;        // whole modules
    const yT = bh + RV, Hb = nt * FH, hc = (Hm >> 1) & ~1, Htot = Hb + hc;

    // ---- skins
    const P = L.pick(R, [5, 6]);
    // flush unitised curtain wall: frame + spandrel at the wall plane, a recessed glass ribbon per floor split by
    // mullion lines (material only, so the diagrid can sit on the wall plane without sharing faces)
    const skinTower = (len, h) => {
      const F = new L.Relief(len, h, 0, frame), nf = Math.floor(h / FH);
      for (let f = 0; f < nf; ++f) {
        const v = f * FH, on = (u) => L.H2(seed + 3, (u / 18) | 0, f) < 0.32;
        F.rect(1, v + 1, len - 1, v + 3, 2, BM.SPANDREL);
        for (let u = 1; u < len - 1; u += P) {
          const u1 = Math.min(len - 1, u + P - 1);
          F.rect(u, v + 3, u1, v + FH - 1, 1, on(u) ? L.glassMat(seed, u, f, 0.85, tint) : L.glassMat(seed, u, f, 0, tint));
          if (u1 < len - 1) F.rect(u1, v + 3, u1 + 1, v + FH - 1, 1, frame);
        }
      }
      return F;
    };
    const skinReveal = (len, h) => {
      const F = new L.Relief(len, h, 0, BM.STEEL_DARK);
      for (let u = 1; u < len - 1; u += 4) F.rect(u, 1, Math.min(len - 1, u + 3), h - 2, 1, L.glassMat(seed, u, 91, 0.7, 'dark'));
      return F;
    };
    const tiers = [
      { x0: 0, z0: 0, x1: W, z1: D, h: bh, skin: (len, h, info) => L.facadeMid(len, bf, 14, SH, !info.front), party: spec.party,
        roof: { mat: SH.wall === BM.LIMESTONE ? BM.LIMESTONE_DARK : BM.LIMESTONE, deck: BM.CONCRETE, units: 0 } },
      { mask: erode(tMask, W, D, 4), h: RV, skin: skinReveal, noRoof: true },
      { x0: tx0, z0: tz0, x1: tx1, z1: tz1, notch, h: Hb, skin: skinTower, floating: true, soffit: frame,
        roof: { parapet: 2, mat: frame, deck: BM.ROOF_TAR, units: 0 } }
    ];
    L.buildTiers(E, C, W, D, tiers, seed);

    // ---- the diagrid: one thin voxel model per outline run; each cell is claimed by exactly one run
    const runs = outlineRuns(tMask, W, D), own = new Int16Array(W * D).fill(-1);
    const ext = 3, inside = (x, z) => x < 0 || z < 0 || x >= W || z >= D || tMask[z * W + x] === 1;
    runs.forEach((r, ri) => {
      const len = r.e - r.s;
      r.len = len;
      const m = 2 * Math.max(1, Math.round(len / (2 * Hm * 0.55)));
      r.a = len / m; r.m = m; r.diag = len >= 20;
      r.cells = [];
      for (let u = -ext; u < len + ext; ++u) for (let o = 0; o < 3; ++o) {
        const [x, z] = cellOf(r, u, o);
        if (inside(x, z) || own[z * W + x] >= 0) continue;
        own[z * W + x] = ri; r.cells.push([u, o, x, z]);
      }
    });
    const y0 = -RV;                                                  // columns drop through the reveal to the old roof
    const steelAt = (r, u, o, v) => {
      const corner = u < 0 || u >= r.len;
      if (v >= Htot - 3) return o < 3;                               // crown ring
      if (v < 0) {                                                   // node columns through the reveal
        if (o > 1) return false;
        if (corner) return true;
        if (!r.diag) return false;
        for (let j = 0; j <= r.m; j += 2) if (Math.abs(u + 0.5 - j * r.a) < 1.6) return true;
        return false;
      }
      const ring = v % Hm;
      if ((ring < 2 || ring >= Hm - 1) && v < Hb + 2) return o < 3;  // ring beams at every module line
      if (o > 1) return false;
      if (corner) return true;                                       // corner posts
      if (!r.diag) return v >= Hb && false;
      const kk = Math.floor(v / Hm), vq = v - ((v - kk * Hm) & 1), t = (vq - kk * Hm) / Hm;
      for (let j = (kk & 1); j <= r.m; j += 2) {
        const c0 = j * r.a;
        if (Math.abs(u + 0.5 - (c0 + t * r.a)) < 1.5 || Math.abs(u + 0.5 - (c0 - t * r.a)) < 1.5) return true;
      }
      return false;
    };
    // inward faces on the wall plane (behind the steel, against the glass) are never visible: leave them out
    const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
    const inwardN = { nz: 3, pz: 4, nx: 1, px: 2 };
    const emit = (M, r, y, cull) => {
      const m = C.meshVoxels3D(M), Pp = m.pos, sc = 1 / C.PV, ax = r.t === 'nz' || r.t === 'pz' ? 2 : 0;
      for (let q = 0; q < m.quads; ++q) {
        const kq = q * 12, c = (i) => [Pp[kq + i] * sc, Pp[kq + i + 1] * sc + y, Pp[kq + i + 2] * sc];
        const pts = [c(0), c(3), c(6), c(9)], nid = m.nrm[q * 4];
        if (cull && nid === inwardN[r.t] && pts.every((p) => Math.abs(p[ax] - r.L) < 1e-3)) continue;
        E.quad(pts[0], pts[1], pts[2], pts[3], m.mat[q * 4], NV[nid]);
      }
    };
    for (const r of runs) {
      if (!r.cells.length) continue;
      let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9;
      for (const c of r.cells) { bx0 = Math.min(bx0, c[2]); bx1 = Math.max(bx1, c[2] + 1); bz0 = Math.min(bz0, c[3]); bz1 = Math.max(bz1, c[3] + 1); }
      // main: the run's own face below the roof (culled); rest: corners, columns under the tower, crown
      const Mm = new VM(bx1 - bx0, Hb, bz1 - bz0, -bx0, -bz0), Mr = new VM(bx1 - bx0, Htot - y0, bz1 - bz0, -bx0, -bz0);
      for (const [u, o, x, z] of r.cells) {
        const main = u >= 0 && u < r.len;
        let v = y0;
        while (v < Htot) {                                           // fill vertical spans
          if (!steelAt(r, u, o, v)) { ++v; continue; }
          let v1 = v + 1; while (v1 < Htot && steelAt(r, u, o, v1)) ++v1;
          if (main) {
            if (v < 0) Mr.box(x, v - y0, z, x + 1, Math.min(v1, 0) - y0, z + 1, steel);
            if (v1 > 0 && v < Hb) Mm.box(x, Math.max(v, 0), z, x + 1, Math.min(v1, Hb), z + 1, steel);
            if (v1 > Hb) Mr.box(x, Math.max(v, Hb) - y0, z, x + 1, v1 - y0, z + 1, steel);
          } else Mr.box(x, v - y0, z, x + 1, v1 - y0, z + 1, steel);
          v = v1;
        }
      }
      emit(Mm, r, yT, true);
      emit(Mr, r, yT + y0, false);
    }

    // ---- crown plant: a louvered penthouse inside the diagrid screen, and a gantry
    const yR = yT + Hb, iw = tx1 - tx0 - 2 * notch - 8, id = tz1 - tz0 - 2 * notch - 8;
    if (iw > 16 && id > 16) {
      const pw = Math.round(iw * (0.5 + R() * 0.2)), pd = Math.round(id * (0.45 + R() * 0.2)), ph = Math.min(hc - 6, 22);
      const px = tx0 + notch + 6 + Math.floor((iw - pw - 4) * R()), pz = tz0 + notch + 6 + Math.floor((id - pd - 4) * (0.5 + R() * 0.5));
      const M = new VM(iw, ph + 8, id, px - (tx0 + notch + 4), pz - (tz0 + notch + 4));
      for (let y = 0; y < ph - 2; ++y) M.box(0, y, 0, pw, y + 1, pd, y % 2 ? BM.LOUVER : BM.METAL);
      M.box(-1, ph - 2, -1, pw + 1, ph, pd + 1, frame);                            // penthouse cap
      M.box(2, ph, 2, pw - 2, ph + 1, pd - 2, BM.ROOF_TAR);
      for (let x = 4; x + 6 < pw; x += 10) M.box(x, ph + 1, 4, x + 6, ph + 5, Math.min(pd - 4, 10), BM.METAL);   // fans
      // cooling units beside the penthouse
      const ox = px - (tx0 + notch + 4), oz = pz - (tz0 + notch + 4);
      for (let k = 0; k < 3; ++k) {
        const ux = -ox + 2 + k * 12;
        if (ux + 9 > -ox + iw) break;
        if (ux + 9 > -2 && ux < pw + 2 && -oz + 2 + 7 > -2 && -oz + 2 < pd + 2) continue;
        M.box(ux, 0, -oz + 2, ux + 9, 6, -oz + 9, BM.LOUVER); M.box(ux + 1, 6, -oz + 3, ux + 8, 7, -oz + 8, BM.STEEL_DARK);
      }
      E.vox(C, M, px, yR, pz);
      if (R() < 0.7 && pd >= 24 && pw >= 14) E.vox(C, L.mastsModel(R), px + (pw >> 1), yR + ph + 1, pz + pd - 7);
    }

    // ---- roof terrace on the old building, in front of the tower
    const zt = 4, room = tz0 - 4 - zt;
    if (room >= 4) {
      const M = new VM(W, 26, room, 0, 0);
      for (let x = 5; x + 5 < W - 4; x += 7) {
        M.box(x, 0, 0, x + 5, 3, 4, BM.CONCRETE);
        M.box(x, 3, 0, x + 5, 5, 4, (x / 7) % 2 ? BM.LEAF : BM.LEAF_DARK);
      }
      if (room >= 12) {
        for (let x = 10; x < W - 12; x += 26) {                      // small trees in big planters
          const z = Math.min(room - 5, 8);
          const hv = L.H2(seed, x, 5);
          M.box(x - 3, 0, z - 3, x + 4, 3, z + 4, BM.CONCRETE); M.box(x, 3, z, x + 1, 11, z + 1, BM.TRUNK);
          M.box(x - 4, 9, z - 3, x + 5, 13, z + 4, BM.LEAF); M.box(x - 3, 8, z - 4, x + 4, 14, z + 5, BM.LEAF);
          M.box(x - 2 + (hv < 0.5 ? 1 : 0), 14, z - 2, x + 3, 17, z + 2, BM.LEAF_DARK);
          M.box(x + (hv < 0.5 ? -5 : 4), 10, z - 1, x + (hv < 0.5 ? -3 : 6), 13, z + 2, BM.LEAF_DARK);
        }
        for (let x = 24; x < W - 20; x += 26) M.box(x, 0, Math.min(room - 3, 9), x + 8, 2, Math.min(room - 1, 11), BM.WOOD);   // benches
      }
      E.vox(C, M, 0, bh, zt);
    }
  }
  A.registerTower('diagrid', towerDiagrid);
})();
