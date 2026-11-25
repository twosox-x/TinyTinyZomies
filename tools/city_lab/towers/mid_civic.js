// Downtown civic / commercial mid-rises (3-14 storeys), registered with CityArch.registerMid:
//  'classical_bank'   - a Beaux-Arts bank: granite stylobate and wide steps, a giant Ionic / Corinthian / Doric order
//                       (free-standing temple portico with coffered ceiling and pediment, or engaged columns over a
//                       rusticated banking-hall storey), inscribed frieze or attic, bronze doors and grilled windows;
//                       sometimes an office block rising behind it, set back (bank-tower hybrid).
//  'department_store' - a 1900s-1920s department store: display windows under striped awnings, a marquee over the
//                       main doors, a store-name sign band, Chicago windows in a terracotta grid, an arcaded top
//                       floor and a heavy bracketed cornice; a corner clock turret or a bracket clock.
//  'deco_office'      - a 1930s Art Deco office mid-rise: continuous piers, dark spandrels with zig-zag ornament,
//                       wedding-cake setbacks, a stepped bronze lobby portal and an ornamental parapet.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH, H2 = L.H2, BASE = L.BASE;
  const gm = L.glassMat;
  const VM = () => L.VoxModel();

  // ------------------------------------------------------------------------------------------ lettering (3x5 font)
  const FONT = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'],
    D: ['##.', '#.#', '#.#', '#.#', '##.'], E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
    G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'],
    J: ['..#', '..#', '..#', '#.#', '.#.'], K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'], O: ['###', '#.#', '#.#', '#.#', '###'],
    P: ['##.', '#.#', '##.', '#..', '#..'], Q: ['###', '#.#', '#.#', '###', '..#'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'], U: ['#.#', '#.#', '#.#', '#.#', '###'],
    V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'], '.': ['.', '.', '.', '.', '#'],
    '1': ['.#', '##', '.#', '.#', '.#'], '9': ['###', '#.#', '###', '..#', '###'], '2': ['##.', '..#', '.#.', '#..', '###'],
    '0': ['###', '#.#', '#.#', '#.#', '###'], '3': ['##.', '..#', '.#.', '..#', '##.'], '7': ['###', '..#', '.#.', '.#.', '.#.']
  };
  // cells of a text line, x mirrored so it reads left-to-right seen from the street (facade u runs right-to-left)
  function textCells(t) {
    const cells = []; let x = 0;
    for (const ch of t) {
      const g = FONT[ch];
      if (!g) { x += 2; continue; }
      for (let r = 0; r < 5; ++r) for (let c = 0; c < g[r].length; ++c) if (g[r][c] === '#') cells.push([x + c, 4 - r]);
      x += g[0].length + 1;
    }
    const w = Math.max(0, x - 1);
    return { w, cells: cells.map(([cx, cy]) => [w - 1 - cx, cy]) };
  }
  const textW = (t) => textCells(t).w;
  function paintText(F, t, uc, v0, d, m) {
    const T = textCells(t), u0 = uc - (T.w >> 1);
    for (const [x, y] of T.cells) F.set(u0 + x, v0 + y, d, m);
  }
  const fit = (R, opts, maxW) => { const ok = opts.filter(s => textW(s) <= maxW); return ok.length ? L.pick(R, ok) : null; };
  // side skins: the plain party wall facades() substitutes takes its material from cell (0,0)
  const partyMat = (F, m) => { F.M[F.idx(0, 0)] = m; return F; };
  // stacked blocks with real side facades: skins get info { front, side } (side = an end wall, back = neither).
  // blocks: [{ x0, z0, x1, z1, h, skin, roof }], each inside the one below; party: { l, r }. Returns the top y.
  function blocks(E, C, W, D, list, party, seed) {
    let y = 0;
    list.forEach((b, i) => {
      const pty = { l: party.l && b.x0 === 0, r: party.r && b.x1 === W };
      L.facades(E, b.x0, b.z0, b.x1, b.z1, y, (len, side, front) => b.skin(len, b.h, { side, front }), C, false, pty);
      const nx = list[i + 1];
      const mask = L.rectMask(W, D, b.x0, b.z0, b.x1, b.z1), cover = nx ? L.rectMask(W, D, nx.x0, nx.z0, nx.x1, nx.z1) : null;
      L.roofMask(E, C, mask, cover, W, D, y + b.h, b.roof || {}, seed + i * 31);
      b.y = y; y += b.h;
    });
    return y;
  }

  // ------------------------------------------------------------------------------------------ voxel parts
  function disc(M, cx, cz, r, y0, y1, m) {
    const n = Math.ceil(r) + 1, r2 = r * r;
    for (let z = -n; z < n; ++z) for (let x = -n; x < n; ++x) if ((x + 0.5) * (x + 0.5) + (z + 0.5) * (z + 0.5) <= r2) M.box(cx + x, y0, cz + z, cx + x + 1, y1, cz + z + 1, m);
  }
  // giant-order column centred on grid point (cx, cz), standing at y0, total height H (base + fluted shaft + capital)
  function column(M, cx, cz, y0, H, r, order, S) {
    const capH = order === 'corinthian' ? 7 : order === 'ionic' ? 4 : 3, mat = S.colMat, cap = S.capMat;
    M.box(cx - r - 1, y0, cz - r - 1, cx + r + 1, y0 + 2, cz + r + 1, S.plinthMat);          // square plinth
    disc(M, cx, cz, r + 0.9, y0 + 2, y0 + 3, cap);                                           // torus
    const s0 = y0 + 3, s1 = y0 + H - capH - 1;
    disc(M, cx, cz, r + 0.15, s0, s1, mat);                                                  // shaft
    if (r >= 3) for (let k = 0; k < 8; ++k) {                                                // flutes
      const a = (k + 0.5) * Math.PI / 4, fx = Math.floor(Math.cos(a) * (r - 0.4)), fz = Math.floor(Math.sin(a) * (r - 0.4));
      M.box(cx + fx, s0 + 2, cz + fz, cx + fx + 1, s1 - 1, cz + fz + 1, -1);
    }
    disc(M, cx, cz, r + 0.6, s1, s1 + 1, cap);                                               // astragal
    const y = s1 + 1;
    if (order === 'ionic') {
      disc(M, cx, cz, r + 0.7, y, y + 1, cap);                                               // echinus
      M.box(cx - r - 2, y + 1, cz - r, cx + r + 2, y + 3, cz + r, cap);                       // volute roll
      for (const sx of [-r - 2, r + 1]) M.box(cx + sx, y + 1, cz - r - 1, cx + sx + 1, y + 2, cz + r + 1, S.dark);   // volute eyes
      M.box(cx - r - 1, y + 3, cz - r - 1, cx + r + 1, y + 4, cz + r + 1, cap);               // abacus
    } else if (order === 'corinthian') {
      disc(M, cx, cz, r + 0.2, y, y + 5, cap);                                               // bell
      for (let k = 0; k < 8; ++k) {                                                          // two rows of acanthus
        const a1 = k * Math.PI / 4, a2 = a1 + Math.PI / 8;
        M.box(cx + Math.round(Math.cos(a1) * (r + 0.3)) - (Math.cos(a1) < -0.3 ? 1 : 0), y, cz + Math.round(Math.sin(a1) * (r + 0.3)) - (Math.sin(a1) < -0.3 ? 1 : 0),
          cx + Math.round(Math.cos(a1) * (r + 0.3)) + (Math.cos(a1) < -0.3 ? 0 : 1), y + 2, cz + Math.round(Math.sin(a1) * (r + 0.3)) + (Math.sin(a1) < -0.3 ? 0 : 1), S.leaf);
        const lx = Math.round(Math.cos(a2) * (r + 0.6)), lz = Math.round(Math.sin(a2) * (r + 0.6));
        M.box(cx + lx - (lx < 0 ? 1 : 0), y + 2, cz + lz - (lz < 0 ? 1 : 0), cx + lx + (lx < 0 ? 0 : 1), y + 4, cz + lz + (lz < 0 ? 0 : 1), S.leaf);
      }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])                             // corner volutes
        M.box(cx + (sx < 0 ? -r - 1 : r - 1), y + 4, cz + (sz < 0 ? -r - 1 : r - 1), cx + (sx < 0 ? -r + 1 : r + 1), y + 5, cz + (sz < 0 ? -r + 1 : r + 1), cap);
      M.box(cx - r - 1, y + 5, cz - r - 1, cx + r + 1, y + 7, cz + r + 1, cap);               // abacus
    } else {
      disc(M, cx, cz, r + 0.9, y, y + 1, cap);                                               // echinus
      M.box(cx - r - 1, y + 1, cz - r - 1, cx + r + 1, y + 3, cz + r + 1, cap);               // abacus
    }
  }
  // bronze lamp standard on a pedestal (globe lit at night)
  function lamp(M, cx, cz, y0, hgt) {
    M.box(cx - 1, y0, cz - 1, cx + 1, y0 + 2, cz + 1, BM.BRONZE);
    M.box(cx, y0 + 2, cz, cx + 1, y0 + hgt, cz + 1, BM.BRONZE);
    M.box(cx - 1, y0 + hgt, cz - 1, cx + 2, y0 + hgt + 3, cz + 2, BM.LED);
    M.box(cx, y0 + hgt + 3, cz, cx + 1, y0 + hgt + 4, cz + 1, BM.BRONZE);
  }
  // round clock face in the plane z = zf (one voxel thick), facing -z (or +x/-x when axis 'x'), on model M
  function clockFace(M, cx, cy, zf, rad, axis, sgn) {
    const put = (u, v, m) => {
      if (axis === 'z') M.box(cx + u, cy + v, zf, cx + u + 1, cy + v + 1, zf + 1, m);
      else M.box(zf, cy + v, cx + u, zf + 1, cy + v + 1, cx + u + 1, m);
    };
    for (let v = -rad; v < rad; ++v) for (let u = -rad; u < rad; ++u) {
      const d = Math.hypot(u + 0.5, v + 0.5);
      if (d > rad) continue;
      let m = d > rad - 1 ? BM.BRONZE : BM.LED;
      if (d <= rad - 1 && d > rad - 2 && ((Math.round(Math.atan2(v + 0.5, u + 0.5) / (Math.PI / 6)) % 3) === 0)) m = BM.TRIM_DARK;   // quarter marks
      put(u, v, m);
    }
    for (let k = 0; k < rad - 2; ++k) put(0, k, BM.TRIM_DARK);                              // minute hand (12)
    for (let k = 0; k < Math.max(1, rad - 4); ++k) put(sgn * (k + 1) - (sgn < 0 ? 0 : 0), -1, BM.TRIM_DARK);   // hour hand
  }

  // ============================================================================================ classical_bank
  const BANK_NAMES = ['FIRST NATIONAL BANK', 'NATIONAL BANK', 'SAVINGS BANK', 'TRUST COMPANY', 'MERCHANTS BANK', 'CITIZENS BANK',
    'EXCHANGE BANK', 'FEDERAL RESERVE', 'BANK OF COMMERCE', 'DIME SAVINGS', 'CORN EXCHANGE', 'BANK', 'TRUST'];
  const DATES = ['MCMXII', 'MCMXXI', 'MCMVIII', 'MCMXXIV', 'MDCCCXCIX'];

  // banking hall walls: plinth, (rusticated storey), giant order zone with windows, entablature, attic
  function hallSkin(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 6, S.stone), back = !info.front && !info.side;
      const yE = S.yE, Ent = S.Ent;
      if (info.front && S.mode === 'portico') F.rect(0, 0, len, yE, BASE, S.shade);     // wall in the portico's shade
      // plinth with base moulding
      F.rect(0, 0, len, S.P, 3, S.gran);
      F.rect(0, S.P, len, S.P + 1, 3, S.dark);
      let vO = S.P + 1;
      // bays: the front follows the colonnade; sides / back a regular rhythm
      let wc, piers;                                  // window centres, pier (column / pilaster) positions
      if (info.front && S.frontCols) { piers = S.frontCols; wc = []; for (let i = 0; i + 1 < piers.length; ++i) wc.push((piers[i] + piers[i + 1]) >> 1); }
      else {
        const sp = S.sp, pav = Math.max(8, Math.floor((len - Math.floor((len - 16) / sp) * sp) / 2));
        let nb = Math.max(1, Math.floor((len - 2 * pav) / sp)); if (info.front && nb % 2 === 0 && nb > 1) nb -= 1;
        const p0 = (len - nb * sp) >> 1;
        piers = []; wc = [];
        for (let i = 0; i <= nb; ++i) piers.push(p0 + i * sp);
        for (let i = 0; i < nb; ++i) wc.push(p0 + i * sp + (sp >> 1));
      }
      const mid = wc.length >> 1;
      if (S.mode === 'palazzo' && !back) {
        // rusticated banking-hall storey: deep horizontal joints, arched windows with keystones and grilles
        F.rect(0, vO, len, S.gH, 3, S.rust);
        for (let v = vO + 2; v < S.gH; v += 3) F.rect(0, v, len, v + 1, 2, S.rust);
        wc.forEach((c, k) => {
          if (info.front && k === mid) return;
          const v0 = vO + 3, v1 = S.gH - 4;
          F.rect(c - 3, v0, c + 3, v1, 1, gm(S.seed, k, 3, 0.45));
          F.rect(c - 2, v1, c + 2, v1 + 1, 1, gm(S.seed, k, 3, 0.45));
          for (let u = c - 2; u < c + 3; u += 2) F.rect(u, v0, u + 1, v1, 1, BM.BRONZE);    // grille bars
          F.rect(c - 3, v0 + 5, c + 3, v0 + 6, 1, BM.BRONZE);
          F.rect(c - 4, v0 - 1, c + 4, v0, 4, S.dark);                                    // sill
          F.rect(c - 1, v1 + 1, c + 1, S.gH, 4, S.stone);                                 // keystone
          F.rect(c - 3, v1, c - 2, v1 + 1, 3, S.rust); F.rect(c + 2, v1, c + 3, v1 + 1, 3, S.rust);
        });
        F.rect(0, S.gH, len, S.gH + 2, 4, S.dark);                                        // string course
        vO = S.gH + 2;
      } else if (back) {
        // plain service elevation: punched windows per storey, stone bands
        const n = Math.floor((yE - vO) / FH);
        for (let f = 0; f < n; ++f) wc.forEach((c, k) => {
          const v = vO + f * FH + 3;
          F.rect(c - 2, v, c + 3, v + 8, 1, gm(S.seed, k * 5 + f, 9, 0.3));
          F.rect(c - 3, v - 1, c + 4, v, 3, S.dark);
        });
      }
      // giant order zone
      if (!back) wc.forEach((c, k) => {
        if (info.front && k === mid && S.mode === 'portico') return;
        if (S.mode === 'palazzo' || !info.front) {
          // lower tall window with balconette and pediment hood, upper square window
          const v0 = vO + 4, v1 = Math.min(vO + 4 + 15, yE - 14);
          F.rect(c - 3, v0, c + 3, v1, 1, gm(S.seed, k, v0, 0.35));
          F.rect(c - 3, v0 + 9, c + 3, v0 + 10, 1, BM.TRIM_DARK);
          F.rect(c - 4, v0 - 1, c + 4, v0, 3, S.stone);                                    // frame
          F.rect(c - 4, v0, c - 3, v1, 3, S.stone); F.rect(c + 3, v0, c + 4, v1, 3, S.stone);
          F.rect(c - 5, v0 - 3, c + 5, v0 - 1, 4, S.stone);                                // balconette
          for (let u = c - 4; u < c + 5; u += 2) F.set(u, v0 - 2, 3, S.dark);
          F.rect(c - 5, v1, c + 5, v1 + 1, 4, S.dark);                                     // hood
          F.rect(c - 4, v1 + 1, c + 4, v1 + 2, 4, S.stone); F.rect(c - 2, v1 + 2, c + 2, v1 + 3, 4, S.stone);
          const u0 = v1 + 6, u1 = yE - 3;
          if (u1 - u0 >= 4) {
            F.rect(c - 3, u0, c + 3, u1, 1, gm(S.seed, k, u0, 0.3));
            F.rect(c - 4, u0 - 1, c + 4, u0, 3, S.stone);
          }
        } else {
          // behind the portico: tall grilled window in a moulded frame
          const v0 = vO + 6, v1 = yE - 6, ww = Math.min(4, ((piers[1] - piers[0]) >> 1) - 4);
          if (ww < 2) return;
          F.rect(c - ww - 1, v0 - 1, c + ww + 1, v1 + 1, 3, S.dark);
          F.rect(c - ww, v0, c + ww, v1, 1, gm(S.seed, k, 4, 0.4));
          for (let u = c - ww + 1; u < c + ww; u += 2) F.rect(u, v0, u + 1, v1, 1, BM.BRONZE);
          for (let v = v0 + 6; v < v1; v += 7) F.rect(c - ww, v, c + ww, v + 1, 1, BM.BRONZE);
          F.rect(c - ww - 2, v1 + 1, c + ww + 2, v1 + 2, 4, S.stone);
        }
      });
      // central doorway: bronze doors in a stone architrave under a cornice hood, grilled transom
      if (info.front) {
        const c = wc[mid] !== undefined ? wc[mid] : len >> 1;
        const pm = piers.findIndex((p) => p > c), bayHalf = pm > 0 ? ((piers[pm] - piers[pm - 1]) >> 1) : 8;
        const dw = Math.max(3, Math.min(6, bayHalf - 4)), dB = S.mode === 'portico' ? S.P : 2;
        const dH = S.mode === 'palazzo' ? S.gH - 2 - dB : Math.min(28, yE - dB - 12);
        F.rect(c - dw - 2, dB, c + dw + 2, dB + dH + 2, 3, S.stone);                      // architrave
        F.rect(c - dw, dB, c + dw, dB + dH, 0, BM.BRONZE);
        const dT = dB + Math.floor(dH * 0.62);
        for (let u = c - dw + 1; u < c + dw - 1; u += 3) for (let v = dB + 2; v < dT - 1; v += 4) F.rect(u, v, u + 2, v + 3, 1, BM.BRONZE);   // door panels
        F.rect(c, dB, c + 1, dT, 1, BM.TRIM_DARK);
        F.rect(c - dw, dT, c + dw, dB + dH, 0, gm(S.seed, 7, 7, 0.8));                   // transom
        for (let u = c - dw; u < c + dw; u += 2) F.rect(u, dT, u + 1, dB + dH, 0, BM.BRONZE);
        F.rect(c - dw, dT, c + dw, dT + 1, 0, BM.BRONZE);
        F.rect(c - dw - 3, dB + dH + 2, c + dw + 3, dB + dH + 3, 4, S.dark);              // hood
        F.rect(c - dw - 2, dB + dH + 3, c + dw + 2, dB + dH + 4, 5, S.stone);
      }
      // pilasters where no voxel columns stand
      if (!(info.front && S.mode === 'portico')) piers.forEach((p) => {
        const voxCol = S.mode === 'palazzo' && !back && S.engaged;
        if (voxCol) { F.rect(p - 3, vO, p + 3, yE, 2, S.stone); return; }
        F.rect(p - 2, vO, p + 3, yE, 3, S.stone);
        F.rect(p - 3, vO, p + 4, vO + 2, 4, S.dark);                                     // base
        F.rect(p - 3, yE - 3, p + 4, yE, 4, back ? S.stone : S.dark);                    // capital
      });
      // corner quoins on palazzo pavilions
      if (S.mode === 'palazzo' && !back) for (let v = vO; v + 3 <= yE; v += 4) {
        const wq = (v / 4) % 2 ? 5 : 7;
        F.rect(0, v, wq, v + 3, 3, S.stone); F.rect(len - wq, v, len, v + 3, 3, S.stone);
      }
      // entablature
      const yD = yE + 3 + S.fr;
      F.rect(0, yE, len, yE + 3, 3, S.stone);
      F.rect(0, yE + 1, len, yE + 2, 3, S.dark);
      F.rect(0, yE + 3, len, yD, 2, S.stone);
      if (info.front && S.frieze) paintText(F, S.frieze, len >> 1, yE + 3 + ((S.fr - 5) >> 1), 3, BM.BRONZE);
      else if (!back) for (let u = 2; u < len - 2; u += 8) F.rect(u, yE + 4, u + 2, yD - 1, 3, S.stone);   // triglyph-ish blocks
      for (let u = 0; u < len; ++u) F.set(u, yD, u % 2 ? 3 : 4, S.dark);                // dentils
      F.rect(0, yD + 1, len, yD + 2, 4, S.dark);
      F.rect(0, yD + 2, len, yE + Ent, 5, S.stone);
      F.rect(0, yE + Ent - 1, len, yE + Ent, 6, S.stone);
      // attic
      const a0 = yE + Ent;
      if (h > a0) {
        if (info.front && S.attic && !S.pediment) paintText(F, S.attic, len >> 1, a0 + ((h - a0 - 5) >> 1), 3, BM.BRONZE);
        else if (h - a0 >= 8 && !back) wc.forEach((c, k) => { F.rect(c - 3, a0 + 2, c + 3, h - 3, 1, gm(S.seed, k, a0, 0.25)); });
        if (S.balustrade && h - a0 >= 6 && !back) {
          F.rect(0, h - 5, len, h - 4, 3, S.stone);
          for (let u = 0; u < len; ++u) F.rect(u, h - 4, u + 1, h - 1, u % 3 === 1 ? 1 : 3, u % 3 === 1 ? S.dark : S.stone);
        }
        F.rect(0, h - 1, len, h, 4, S.stone);
      }
      F.returns();
      return partyMat(F, S.stone);
    };
  }
  // office block over a bank: limestone with paired windows, pilaster strips, a cornice
  function officeSkin(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, S.ostone), n = Math.floor((h - 6) / FH), cs = L.bays(len, 10, 4);
      for (let f = 0; f < n; ++f) cs.forEach((c, k) => {
        const v = f * FH + 3, last = f === n - 1;
        F.rect(c - 4, v, c - 1, v + 9, 1, gm(S.seed, k * 2 + f * 13, v, 0.32));
        F.rect(c + 1, v, c + 4, v + 9, 1, gm(S.seed, k * 2 + 1 + f * 13, v, 0.32));
        if (last) { F.rect(c - 3, v + 9, c - 2, v + 10, 1, BM.GLASS); F.rect(c + 2, v + 9, c + 3, v + 10, 1, BM.GLASS); F.rect(c - 5, v + 10, c + 5, v + 11, 3, S.dark); }
        F.rect(c - 4, v - 2, c + 4, v - 1, 3, S.dark);
        F.rect(c - 1, v, c + 1, v + 9, 2, S.ostone);
      });
      for (let f = 3; f < n - 1; f += 3) F.rect(0, f * FH, len, f * FH + 1, 3, S.ostone);   // belt courses
      if (!(!info.front && !info.side)) cs.forEach((c, k) => { if (k % 2 === 0) F.rect(c + 4, 0, c + 6, n * FH, 3, S.ostone); });
      F.rect(0, 0, len, 1, 3, S.dark);
      const t = n * FH;
      F.rect(0, t, len, t + 1, 3, S.dark);
      for (let u = 0; u < len; ++u) F.set(u, t + 2, u % 3 ? 3 : 4, S.dark);
      F.rect(0, t + 3, len, t + 5, 4, S.ostone); F.rect(0, h - 1, len, h, 3, S.dark);
      F.returns();
      return partyMat(F, S.ostone);
    };
  }

  const reseed = (C, spec, salt) => { const R = C.mulberry32(((spec.seed * 2654435761) ^ salt) >>> 0); for (let i = 0; i < 4; ++i) R(); return R; };
  function classicalBank(E, C, W, D, spec) {
    const R = reseed(C, spec, 0x6a09e667);
    const party = spec.party || {}, pl = !!party.l, pr = !!party.r, seed = spec.seed;
    const stone = L.pick(R, [BM.LIMESTONE, BM.LIMESTONE, BM.WHITE_CONCRETE, BM.BUFF, BM.GRANITE_PINK]);
    const order = L.pick(R, ['ionic', 'corinthian', 'corinthian', 'doric']);
    const S = {
      seed, stone, dark: stone === BM.LIMESTONE_DARK ? BM.LIMESTONE : (stone === BM.GRANITE_PINK ? BM.GRANITE_DARK : BM.LIMESTONE_DARK),
      gran: L.pick(R, [BM.GRANITE_DARK, BM.GRANITE_PINK, BM.GRANITE_DARK]), P: 5, fr: 6, Ent: 13
    };
    S.rust = R() < 0.5 ? S.gran : stone;
    S.shade = stone === BM.LIMESTONE || stone === BM.WHITE_CONCRETE ? BM.LIMESTONE_DARK : stone === BM.BUFF ? BM.TERRACOTTA : BM.GRANITE_DARK;
    S.colMat = R() < 0.22 ? (stone === BM.GRANITE_PINK ? BM.GRANITE_DARK : BM.GRANITE_PINK) : stone;
    S.capMat = stone; S.plinthMat = S.gran; S.leaf = R() < 0.5 ? S.dark : stone;
    S.ostone = L.pick(R, [BM.LIMESTONE, BM.BUFF, BM.LIMESTONE_DARK, BM.BRICK_BROWN]);
    const floors = spec.floors;
    const hybrid = floors >= 7 && D >= 100 && W >= 72 && R() < 0.8;
    const portico = D >= 72 && W >= 60 && R() < (hybrid ? 0.45 : 0.6);
    S.mode = portico ? 'portico' : 'palazzo';
    S.sp = 18 + Math.floor(R() * 5);
    S.balustrade = R() < 0.55;
    const r = W >= 100 && R() < 0.6 ? 4 : 3;
    let Hc, zF = 0, zc = 0;
    if (portico) {
      Hc = hybrid ? 40 : Math.max(34, Math.min(52, 28 + Math.min(floors, 5) * 4 + Math.floor(R() * 6)));
      zc = 10 + r + 1; zF = zc + r + 7;
      S.yE = S.P + Hc;
    } else {
      S.gH = S.P + 1 + 16 + Math.floor(R() * 4);
      Hc = Math.max(30, Math.min(44, 22 + Math.min(floors, 5) * 4 + Math.floor(R() * 6)));
      S.yE = S.gH + 2 + Hc;
      S.engaged = R() < 0.7;
    }
    const pedW = W - 2;
    S.pediment = portico && pedW <= 124 && R() < 0.8;
    const Ha = S.pediment ? 6 : 10 + Math.floor(R() * 3);
    const hallH = S.yE + S.Ent + Ha;
    // inscription: frieze on the palazzo; attic (or frieze under a pediment) on the portico
    const room = W - 16;
    const name = fit(R, BANK_NAMES, room);
    if (portico && !S.pediment) S.attic = name; else S.frieze = name;
    if (!portico && name && R() < 0.4) S.attic = fit(R, DATES, room);

    // portico columns
    let xs = null, ant = 0;
    if (portico) {
      ant = W > 100 ? 8 : 6;
      const Wi = W - 2 * ant, spT = 14 + 2 * r + Math.floor(R() * 4);
      const n = Math.max(2, 2 * Math.round(Wi / (2 * spT)));
      xs = []; for (let i = 0; i < n; ++i) xs.push(ant + Math.round((i + 0.5) * Wi / n));
      S.frontCols = [ant].concat(xs, [W - ant]);
    }
    const tiers = [{ x0: 0, z0: zF, x1: W, z1: D, h: hallH, skin: hallSkin(S), party, roof: { parapet: 1, mat: S.dark } }];
    let yTop = hallH, oRect = null;
    if (hybrid) {
      const sx = 8, z0 = zF + (portico ? 10 : 18);
      const x0 = pl ? 0 : sx, x1 = pr ? W : W - sx;
      const nO = Math.max(3, floors - 4);
      tiers.push({ x0, z0, x1, z1: D, h: nO * FH + 6, skin: officeSkin(S), party, roof: { parapet: 2, mat: S.dark } });
      yTop = hallH + nO * FH + 6; oRect = [x0, z0, x1, D];
    }
    blocks(E, C, W, D, tiers, party, seed);

    // ---- portico: steps, stylobate, antae, columns, entablature with coffered ceiling, pediment or attic
    if (portico) {
      const P = S.P, yE = S.yE, Ent = S.Ent, y0p = yE + Ent;
      const hp = S.pediment ? Math.max(8, Math.round(W * 0.15)) : 0;
      const M = new (VM())(W, y0p + Math.max(hp, Ha) + 8, zF + 8, 0, 2);
      const cw = W > 90 ? 8 : 5, stepMat = R() < 0.5 ? S.gran : stone;
      for (let s = 0; s < P; ++s) M.box(cw, 0, 2 * s, W - cw, s + 1, 11, stepMat);           // wide steps
      M.box(0, 0, 10, W, P, zF + 1, S.gran);                                               // stylobate
      M.box(0, P - 1, 9, W, P, 10, S.gran);                                                // nosing
      for (const [a, b] of [[0, cw], [W - cw, W]]) {                                        // cheek blocks + lamps
        M.box(a, 0, 0, b, P + 2, 11, S.gran);
        M.box(a, P + 2, 0, b, P + 3, 11, S.dark);
        lamp(M, (a + b) >> 1, 3, P + 3, 12);
      }
      for (const [a, b] of [[0, ant], [W - ant, W]]) {                                     // antae
        M.box(a, P, 11, b, yE, zF + 1, stone);
        M.box(a, P, 10, b, P + 3, zF + 1, S.dark);
        M.box(a, yE - 3, 10, b, yE, zF + 1, S.dark);
      }
      xs.forEach((x) => column(M, x, zc, P, Hc, r, order, S));
      const zA = zc - r - 1;
      M.box(0, yE, zA, W, yE + 3, zF + 1, stone);                                          // architrave
      M.box(0, yE + 1, zA - 1, W, yE + 2, zA, S.dark);
      const yD = yE + 3 + S.fr;
      M.box(0, yE + 3, zA + 1, W, yD + 1, zF + 1, stone);                                  // frieze
      for (let x = 0; x < W; x += 2) M.box(x, yD, zA, x + 1, yD + 1, zA + 1, S.dark);       // dentils
      M.box(0, yD + 1, zA - 1, W, yD + 2, zF + 1, S.dark);
      M.box(0, yD + 2, zA - 2, W, y0p, zF + 1, stone);                                     // corona
      if (S.frieze) {
        const T = textCells(S.frieze), u0 = (W >> 1) - (T.w >> 1), v0 = yE + 3 + ((S.fr - 5) >> 1);
        for (const [x, y] of T.cells) M.box(u0 + x, v0 + y, zA, u0 + x + 1, v0 + y + 1, zA + 1, BM.BRONZE);
      } else for (let x = 4; x < W - 4; x += 8) M.box(x, yE + 4, zA, x + 2, yD - 1, zA + 1, stone);
      // coffered ceiling between the colonnade and the wall
      const cz0 = zc + r + 2, cz1 = zF - 1;
      for (let x = ant + 2; x + 3 <= W - ant - 1; x += 4) for (let z = cz0; z + 3 <= cz1; z += 4) {
        M.box(x, yE, z, x + 3, yE + 1, z + 3, -1);
        M.box(x + 1, yE, z + 1, x + 2, yE + 1, z + 2, S.dark);
      }
      if (S.pediment) {
        const half = W / 2;
        for (let x = 0; x < W; ++x) {
          const hh = Math.floor((half - Math.abs(x + 0.5 - half)) * hp / half) + 1;
          M.box(x, y0p, zA + 2, x + 1, y0p + hh, zF + 3, stone);                           // tympanum
          M.box(x, y0p + Math.max(0, hh - 3), zA, x + 1, y0p + hh - 1, zF + 3, S.dark);     // raking cornice
          M.box(x, y0p + Math.max(0, hh - 1), zA - 1, x + 1, y0p + hh, zF + 3, stone);
        }
        // sculpture in the tympanum: a clock, or a cartouche with garlands
        const cy = y0p + Math.round(hp * 0.42), rc = Math.max(3, Math.round(hp * 0.32));
        if (R() < 0.45) clockFace(M, W >> 1, cy, zA + 1, rc, 'z', 1);
        else {
          disc2(M, W >> 1, cy, zA + 1, rc, S.dark);
          for (let k = 1; k < 4; ++k) M.box((W >> 1) - rc - 3 * k, cy - k, zA + 1, (W >> 1) - rc - 3 * k + 3, cy - k + 1, zA + 2, S.dark);
          for (let k = 1; k < 4; ++k) M.box((W >> 1) + rc + 3 * k - 3, cy - k, zA + 1, (W >> 1) + rc + 3 * k, cy - k + 1, zA + 2, S.dark);
        }
        M.box((W >> 1) - 2, y0p + hp, zA, (W >> 1) + 2, y0p + hp + 4, zA + 4, S.dark);    // acroteria
        M.box(0, y0p, zA, 3, y0p + 4, zA + 4, S.dark); M.box(W - 3, y0p, zA, W, y0p + 4, zA + 4, S.dark);
      } else {
        M.box(0, y0p, zA + 1, W, y0p + Ha, zF + 1, stone);                                 // attic
        M.box(0, y0p, zA, W, y0p + 1, zA + 1, S.dark);
        M.box(0, y0p + Ha - 1, zA, W, y0p + Ha, zF + 1, S.dark);
        if (S.attic) {
          const T = textCells(S.attic), u0 = (W >> 1) - (T.w >> 1), v0 = y0p + ((Ha - 5) >> 1);
          for (const [x, y] of T.cells) M.box(u0 + x, v0 + y, zA, u0 + x + 1, v0 + y + 1, zA + 1, BM.BRONZE);
        }
        for (const x of [0, W - 6]) M.box(x, y0p, zA, x + 6, y0p + Ha, zA + 1, stone);      // end blocks over the antae
      }
      E.vox(C, M, 0, 0, 0);
    } else {
      // palazzo: engaged columns over the rusticated storey, entrance stoop with lamps
      const pav = Math.max(8, Math.floor((W - Math.floor((W - 16) / S.sp) * S.sp) / 2));
      let nb = Math.max(1, Math.floor((W - 2 * pav) / S.sp)); if (nb % 2 === 0 && nb > 1) nb -= 1;
      const p0 = (W - nb * S.sp) >> 1;
      const M = new (VM())(W + 2, S.yE + 2, 16, 1, 8);
      if (S.engaged) for (let i = 0; i <= nb; ++i) column(M, p0 + i * S.sp, 0, S.gH, S.yE - S.gH, 3, order, S);
      const c = p0 + (nb >> 1) * S.sp + (S.sp >> 1);
      M.box(c - 8, 0, -5, c + 8, 1, -1, S.gran);
      M.box(c - 7, 1, -3, c + 7, 2, -1, S.gran);
      for (const x of [c - 10, c + 9]) { M.box(x - 1, 0, -5, x + 2, 3, -1, S.gran); lamp(M, x, -3, 3, 10); }
      E.vox(C, M, 0, 0, 0);
      // free sides: engaged columns too
      if (S.engaged) for (const sd of ['l', 'r']) {
        if (party[sd]) continue;
        const len = D, pv = Math.max(8, Math.floor((len - Math.floor((len - 16) / S.sp) * S.sp) / 2));
        const nbs = Math.max(1, Math.floor((len - 2 * pv) / S.sp)), q0 = (len - nbs * S.sp) >> 1;
        const Ms = new (VM())(10, S.yE + 2, D + 2, 5, 1);
        for (let i = 0; i <= nbs; ++i) {
          const u = q0 + i * S.sp, z = sd === 'l' ? D - u : u;
          if (z < 10 || z > D - 6) continue;
          column(Ms, 0, z, S.gH, S.yE - S.gH, 3, order, S);
        }
        E.vox(C, Ms, sd === 'l' ? 0 : W, 0, 0);
      }
    }
    // roof: optional saucer dome over the banking hall, then utility gear
    const avoid = [];
    if (!hybrid && D - zF >= 56 && W >= 64 && R() < 0.4) {
      const cx = W >> 1, cz = zF + ((D - zF) >> 1), rd = Math.min(W, D - zF) * 0.26 | 0, dh = Math.round(rd * 0.55);
      const M = new (VM())(2 * rd + 6, dh + 20, 2 * rd + 6, rd + 3, rd + 3);
      disc(M, 0, 0, rd + 1, 0, 2, S.dark);
      disc(M, 0, 0, rd, 2, 8, stone);
      for (let k = 0; k < 16; ++k) {                                                         // drum windows
        const a = k * Math.PI / 8, wx = Math.floor(Math.cos(a) * (rd - 0.5)), wz = Math.floor(Math.sin(a) * (rd - 0.5));
        M.box(wx, 3, wz, wx + 1, 7, wz + 1, gm(seed, k, 1, 0.5));
      }
      const domeMat = R() < 0.5 ? BM.COPPER : S.dark;
      for (let y = 0; y < dh; ++y) disc(M, 0, 0, Math.sqrt(Math.max(0, 1 - (y / dh) * (y / dh))) * rd, 8 + y, 9 + y, domeMat);
      disc(M, 0, 0, 2.5, 8 + dh - 1, 8 + dh + 4, stone); disc(M, 0, 0, 3.2, 8 + dh + 4, 8 + dh + 5, S.dark);
      M.box(0, 8 + dh + 5, 0, 1, 8 + dh + 8, 1, BM.BRONZE);
      E.vox(C, M, cx, hallH - 1, cz);
      avoid.push([cx - rd - 3, cz - rd - 3, cx + rd + 3, cz + rd + 3]);
    }
    if (oRect) {
      if (L.roofKit) L.roofKit(E, C, oRect[0] + 1, oRect[1] + 1, oRect[2] - 1, oRect[3] - 1, yTop, R, { style: 'office', floors });
    } else if (L.roofKit) L.roofKit(E, C, 2, zF + 2, W - 2, D - 2, hallH, R, { style: 'historic', floors: 3, avoid });
  }
  function disc2(M, cx, cy, zf, rad, m) {
    for (let v = -rad; v < rad; ++v) for (let u = -rad; u < rad; ++u) {
      const d = Math.hypot((u + 0.5) * 0.8, v + 0.5);
      if (d <= rad) M.box(cx + u, cy + v, zf, cx + u + 1, cy + v + 1, zf + 1, m);
    }
  }

  A.registerMid('classical_bank', classicalBank, { minW: 16, maxW: 45, minFloors: 2, maxFloors: 14, zones: ['mid', 'core'] });

  // ============================================================================================ department_store
  const STORE_NAMES = ['THE EMPORIUM', 'HARGROVE AND SONS', 'MERRIMAN BROS', 'THE FAIR', 'ASHBY DRY GOODS', 'KESSLER AND CO',
    'BRANDT BROTHERS', 'THE GRAND BAZAAR', 'HALLORAN', 'WHITCOMB AND CO', 'DRY GOODS', 'LINDQVIST', 'OSTERMANN'];
  function storeSkin(S) {
    return (len, h, info) => {
      const back = !info.front && !info.side;
      const F = new L.Relief(len, h, 7, back ? S.backWall : S.wall);
      const gH = S.gH, sb = S.sb, y0 = gH + sb, ya = y0 + S.nF * FH, yc = ya + S.aH;
      if (back) {
        // service elevation: plain brick, punched windows, a loading door
        const cs = L.bays(len, 10, 4), n = Math.floor((yc - 4) / FH);
        F.rect(0, 0, len, 2, 3, S.gran);
        for (let f = 1; f < n; ++f) cs.forEach((c, k) => {
          const v = f * FH + 3;
          F.rect(c - 2, v, c + 3, v + 8, 1, gm(S.seed, k * 3 + f, 31, 0.25));
          F.rect(c - 3, v - 1, c + 4, v, 3, S.trim);
        });
        const c = len >> 1;
        F.rect(c - 8, 0, c + 8, 14, 1, BM.METAL);
        for (let v = 2; v < 14; v += 2) F.rect(c - 8, v, c + 8, v + 1, 1, BM.LOUVER);
        F.rect(c - 10, 14, c + 10, 16, 5, BM.STEEL_DARK);
        F.rect(0, yc, len, yc + 2, 3, S.trim); F.rect(0, h - 1, len, h, 3, S.trim);
        return partyMat(F, S.backWall);
      }
      const bw = S.bw, half = bw >> 1, cs = L.bays(len, bw, 3);
      const b0 = cs[0] - half, b1 = cs[cs.length - 1] + half;
      const mid = cs.length >> 1, entr = info.front || len > 96 ? mid : -1;
      // ---- ground: granite base, display windows under striped awnings, the main doors under a marquee
      F.rect(0, 0, len, gH, BASE, S.gran);
      cs.forEach((c, k) => {
        const u0 = c - half + 2, u1 = c + half - 1;
        if (k === entr) {
          F.rect(u0, 0, u1, gH - 5, 0, BM.BRONZE);                                         // vestibule
          for (let u = u0 + 1; u + 3 <= u1 - 1; u += 4) if (Math.abs(u + 1 - c) > 3) F.rect(u, 0, u + 3, 11, 0, gm(S.seed, u, 5, 0.75, 'dark'));
          F.rect(c - 2, 0, c + 2, 11, 1, gm(S.seed, 1, 6, 0.8, 'dark'));                   // revolving door
          F.rect(c - 2, 11, c + 2, 12, 1, BM.BRONZE);
          F.rect(u0, 12, u1, gH - 5, 0, gm(S.seed, k, 13, 0.85));                          // transom
          for (let u = u0; u < u1; u += 3) F.rect(u, 12, u + 1, gH - 5, 0, BM.BRONZE);
          F.rect(u0 - 1, gH - 5, u1 + 1, gH - 4, 6, BM.LED);                                // marquee
          F.rect(u0 - 1, gH - 4, u1 + 1, gH - 1, 7, BM.BRONZE);
          F.rect(u0 - 1, gH - 3, u1 + 1, gH - 2, 7, S.signFg === BM.LED ? BM.TRIM_DARK : BM.TRIM);
          return;
        }
        F.rect(u0, 0, u1, 2, 3, BM.GRANITE_DARK);                                           // bulkhead
        F.rect(u0, 2, u1, 12, 1, gm(S.seed, k * 7 + len, 2, 0.6));                         // display glass
        F.rect(c, 2, c + 1, 12, 1, BM.BRONZE);
        F.rect(u0, 12, u1, 13, 1, BM.BRONZE);
        F.rect(u0, 13, u1, 15, 1, gm(S.seed, k, 13, 0.5));                                 // prism transom
        if (S.awnings) {
          const dd = [7, 7, 6, 5, 4];
          for (let i = 0; i < 5; ++i) for (let u = u0; u < u1; ++u) F.set(u, 15 + i, dd[i], (u - u0) % 2 && i > 0 ? BM.TRIM : S.awn);
        } else F.rect(u0, 15, u1, 19, 2, S.wall);
      });
      for (let i = 0; i <= cs.length; ++i) {                                               // granite piers
        const p = b0 + i * bw;
        F.rect(p - 1, 0, p + 2, gH, 3, S.gran);
        F.rect(p - 2, 0, p + 3, 2, 4, BM.GRANITE_DARK);
      }
      if (b0 > 1) F.rect(0, 0, b0 + 2, gH, 3, S.gran);
      if (len - b1 > 1) F.rect(b1 - 1, 0, len, gH, 3, S.gran);
      // ---- store-name sign band
      F.rect(0, gH, len, y0, 3, S.signBg);
      F.rect(0, gH, len, gH + 1, 4, S.trim); F.rect(0, y0 - 1, len, y0, 4, S.trim);
      const nm = textW(S.name) <= len - 10 ? S.name : (textW(S.short) <= len - 10 ? S.short : null);
      if (nm) paintText(F, nm, len >> 1, gH + 1, 4, S.signFg);
      // ---- Chicago windows in a terracotta grid
      for (let f = 0; f < S.nF; ++f) {
        const v = y0 + f * FH;
        cs.forEach((c, k) => {
          const u0 = c - half + 2, u1 = c + half - 1, sw = 3;
          F.rect(u0, v, u1, v + 4, 3, S.spand);                                            // spandrel panel
          F.rect(u0 + 1, v + 1, u1 - 1, v + 3, 2, S.spandIn);
          if (f % 2 === 0) F.rect(c - 1, v + 1, c + 2, v + 3, 3, S.trim);                   // medallion
          F.rect(u0, v + 4, u1, v + FH, 1, BM.TRIM_DARK);                                   // frame and mullions
          const g = (a, b, s) => gm(S.seed, k * 11 + s + len, v, 0.3);
          F.rect(u0, v + 4, u0 + sw, v + FH, 1, g(0, 0, 1));                                // sashes
          F.rect(u1 - sw, v + 4, u1, v + FH, 1, g(0, 0, 1));
          F.rect(u0, v + 9, u0 + sw, v + 10, 1, BM.TRIM_DARK); F.rect(u1 - sw, v + 9, u1, v + 10, 1, BM.TRIM_DARK);
          F.rect(u0 + sw + 1, v + 4, u1 - sw - 1, v + FH - 3, 1, g(0, 0, 1));             // wide fixed pane
          F.rect(u0 + sw + 1, v + FH - 2, u1 - sw - 1, v + FH, 1, g(0, 0, 2));             // transom light
        });
      }
      // ---- top-floor arcade
      F.rect(0, ya, len, ya + 2, 3, S.trim);
      cs.forEach((c, k) => {
        const u0 = c - half + 2, u1 = c + half - 1;
        for (const [a0, a1] of [[u0, c], [c + 1, u1]]) {
          const t = ya + S.aH - 5;
          F.rect(a0, ya + 3, a1, t, 1, gm(S.seed, k * 2 + a0, ya, 0.3));
          F.rect(a0 + 1, t, a1 - 1, t + 1, 1, gm(S.seed, k * 2 + a0, ya, 0.3));
          F.rect(a0 + 2, t + 1, a1 - 2, t + 2, 1, gm(S.seed, k * 2 + a0, ya, 0.3));
          F.rect(a0 - 1, ya + 2, a1 + 1, ya + 3, 3, S.trim);                                // sill
          F.rect(a0 + 2, t + 2, a1 - 2, t + 3, 3, S.trim);                                  // archivolt
          F.set(a0 + 1, t + 1, 3, S.trim); F.set(a1 - 2, t + 1, 3, S.trim); F.set(a0, t, 3, S.trim); F.set(a1 - 1, t, 3, S.trim);
        }
        F.rect(c, ya + 3, c + 1, ya + S.aH - 3, 3, S.trim);                                   // colonette
      });
      // ---- piers (continuous over the shaft and the arcade), wider corner piers
      for (let i = 0; i <= cs.length; ++i) {
        const p = b0 + i * bw;
        F.rect(p - 1, y0, p + 2, yc, 4, S.pier);
        F.rect(p - 2, ya - 2, p + 3, ya, 5, S.trim);                                       // pier capitals
        F.rect(p - 2, yc - 2, p + 3, yc, 5, S.trim);
      }
      if (b0 > 1) F.rect(0, y0, b0 + 2, yc, 4, S.pier);
      if (len - b1 > 1) F.rect(b1 - 1, y0, len, yc, 4, S.pier);
      // ---- heavy bracketed cornice and parapet
      F.rect(0, yc, len, yc + 1, 4, S.trim);
      F.rect(0, yc + 1, len, yc + 3, 3, S.wall);
      for (let u = 3; u < len; u += 6) F.rect(u, yc + 1, u + 1, yc + 3, 4, S.trim);       // rosettes
      for (let u = 0; u < len; ++u) F.set(u, yc + 3, u % 2 ? 4 : 5, S.trim);              // dentils
      for (let u = 0; u < len; ++u) F.rect(u, yc + 4, u + 1, yc + 6, u % 4 === 0 ? 7 : 5, S.trim);   // modillions
      F.rect(0, yc + 6, len, yc + 7, 7, S.trim);
      F.rect(0, yc + 7, len, yc + 8, 8, S.cornice);
      F.rect(0, yc + 8, len, yc + 9, 7, S.cornice);
      for (let i = 0; i <= cs.length; ++i) { const p = b0 + i * bw; F.rect(p - 1, yc + 9, p + 2, h - 1, 3, S.wall); }
      F.rect(0, h - 1, len, h, 3, S.trim);
      F.returns();
      return partyMat(F, S.wall);
    };
  }
  // double-faced bracket clock hung from the facade (faces along the street), origin on the wall plane
  function bracketClock() {
    const M = new (VM())(10, 26, 18, 5, 15);
    M.box(-2, 6, -1, 2, 24, 1, BM.BRONZE);                                                 // wall plate
    M.box(-1, 21, -12, 1, 23, 1, BM.BRONZE);                                               // arm
    for (let k = 0; k < 9; ++k) M.box(0, 20 - k, -k - 2, 1, 21 - k, -k - 1, BM.BRONZE);    // scroll brace
    M.box(-1, 19, -11, 1, 21, -9, BM.BRONZE);                                              // hanger
    M.box(-2, 8, -14, 2, 19, -6, BM.BRONZE);                                               // case
    clockFace(M, -10, 13, -3, 4, 'x', 1); clockFace(M, -10, 13, 2, 4, 'x', -1);
    M.box(-1, 6, -11, 1, 8, -9, BM.BRONZE);                                                // pendant
    return M;
  }
  // corner turret with a clock stage and a copper dome, centred near a front corner
  function turretModel(rt, y0, hBody, cornH, S, seed, ring) {
    const top = hBody, ck = 16, dh = Math.round(rt * 1.3), Hm = top + ck + dh + 14;
    const M = new (VM())(2 * rt + 8, Hm, 2 * rt + 8, rt + 4, rt + 4);
    for (let k = 0; k < 4; ++k) disc(M, 0, 0, rt - 3 + k, k, k + 1, S.trim);               // corbel
    disc(M, 0, 0, rt, 4, top, S.wall);
    for (let y = 8; y + 10 < cornH; y += FH) {                                            // windows each floor
      for (let a = 0; a < 16; ++a) {
        const th = a * Math.PI / 8, wx = Math.floor(Math.cos(th) * (rt - 0.5)), wz = Math.floor(Math.sin(th) * (rt - 0.5));
        if (!ring(Math.cos(th), Math.sin(th))) continue;
        M.box(wx, y, wz, wx + 1, y + 8, wz + 1, gm(seed, a, y, 0.35));
      }
      disc(M, 0, 0, rt + 0.6, y - 2, y - 1, S.trim);                                       // floor band
    }
    disc(M, 0, 0, rt + 2, cornH, cornH + 2, S.trim);                                       // cornice ring
    disc(M, 0, 0, rt + 3, cornH + 2, cornH + 3, S.cornice);
    // clock stage: square with chamfers, a face on each side
    const q = rt - 1;
    M.box(-q, top, -q, q, top + ck, q, S.wall);
    M.box(-q - 1, top, -q - 1, q + 1, top + 2, q + 1, S.trim);
    M.box(-q - 1, top + ck - 2, -q - 1, q + 1, top + ck, q + 1, S.trim);
    const cr = Math.min(5, q - 1), cy = top + (ck >> 1);
    clockFace(M, 0, cy, -q - 1, cr, 'z', 1); clockFace(M, 0, cy, q, cr, 'z', -1);
    clockFace(M, 0, cy, -q - 1, cr, 'x', 1); clockFace(M, 0, cy, q, cr, 'x', -1);
    for (let y = 0; y < dh; ++y) disc(M, 0, 0, Math.max(1, rt * Math.cos((y / dh) * Math.PI / 2) + 0.3), top + ck + y, top + ck + y + 1, BM.COPPER);
    M.box(-1, top + ck + dh, -1, 1, top + ck + dh + 3, 1, BM.BRONZE);
    M.box(0, top + ck + dh + 3, 0, 1, Hm, 1, BM.METAL);                                    // flagpole
    return M;
  }
  function departmentStore(E, C, W, D, spec) {
    const R = reseed(C, spec, 0x3c6ef372);
    const party = spec.party || {}, seed = spec.seed;
    const pal = L.pick(R, [
      { wall: BM.TERRACOTTA, pier: BM.TERRACOTTA, trim: BM.BUFF, spand: BM.BUFF, spandIn: BM.TERRACOTTA, cornice: BM.BUFF },
      { wall: BM.WHITE_CONCRETE, pier: BM.WHITE_CONCRETE, trim: BM.LIMESTONE, spand: BM.LIMESTONE, spandIn: BM.COPPER, cornice: BM.COPPER },
      { wall: BM.BRICK_RED, pier: BM.BUFF, trim: BM.LIMESTONE, spand: BM.BRICK_DARK, spandIn: BM.BUFF, cornice: BM.TRIM_DARK },
      { wall: BM.BUFF, pier: BM.BUFF, trim: BM.LIMESTONE, spand: BM.TERRACOTTA, spandIn: BM.BUFF, cornice: BM.LIMESTONE_DARK },
      { wall: BM.LIMESTONE, pier: BM.LIMESTONE, trim: BM.LIMESTONE_DARK, spand: BM.BRONZE, spandIn: BM.LIMESTONE_DARK, cornice: BM.COPPER }
    ]);
    const S = Object.assign({ seed }, pal);
    S.gran = L.pick(R, [BM.GRANITE_DARK, BM.GRANITE_PINK, BM.LIMESTONE_DARK]);
    S.backWall = L.pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK]);
    S.awn = L.pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]);
    S.awnings = R() < 0.85;
    S.signBg = L.pick(R, [BM.TRIM_DARK, BM.BRONZE, BM.STEEL_DARK, BM.AWNING_GREEN]);
    S.signFg = R() < 0.5 ? BM.LED : (S.signBg === BM.BRONZE ? BM.TRIM : BM.BRONZE);
    if (S.signFg === BM.BRONZE && S.signBg !== BM.TRIM_DARK) S.signFg = BM.TRIM;
    S.bw = 17 + Math.floor(R() * 4);
    S.gH = 20; S.sb = 7; S.aH = 16;
    const floors = spec.floors;
    S.nF = Math.max(3, floors - 2);
    S.name = fit(R, STORE_NAMES, W - 10) || 'STORE'; S.short = 'STORE';
    const yc = S.gH + S.sb + S.nF * FH + S.aH, h = yc + 9 + 4;
    blocks(E, C, W, D, [{ x0: 0, z0: 0, x1: W, z1: D, h, skin: storeSkin(S), roof: { parapet: 1, mat: S.trim } }], party, seed);
    // the clock: a corner turret or a bracket clock on a free corner, else a bracket clock over the doors
    const avoid = [];
    const free = !party.r ? 'r' : !party.l ? 'l' : null;
    if (free && floors >= 7 && W >= 96 && R() < 0.65) {
      const rt = 8, cx = free === 'l' ? 3 : W - 3, cz = 3;
      const ring = (dx, dz) => (free === 'l' ? dx < 0.35 : dx > -0.35) || dz < 0.35;
      const M = turretModel(rt, 0, h - S.gH + 1, yc - S.gH, S, seed, ring);
      E.vox(C, M, cx, S.gH - 1, cz);
      avoid.push([cx - rt - 2, cz - rt - 2, cx + rt + 2, cz + rt + 2]);
    } else {
      const cs = L.bays(W, S.bw, 3), half = S.bw >> 1;
      const px = free === 'l' ? Math.max(2, (cs[0] - half) >> 1) : free === 'r' ? W - Math.max(2, (W - cs[cs.length - 1] - half) >> 1) - 1
        : cs[cs.length >> 1] - half;
      E.vox(C, bracketClock(), free ? px : px + 0, S.gH + S.sb + 2, 0);
    }
    if (L.roofKit) L.roofKit(E, C, 2, 2, W - 2, D - 2, h, R, { style: 'historic', floors, avoid });
  }
  A.registerMid('department_store', departmentStore, { minW: 24, maxW: 45, minFloors: 6, maxFloors: 10, zones: ['mid', 'core'] });

  // ============================================================================================ deco_office
  const DECO_NAMES = ['MERIDIAN', 'GUARDIAN', 'CONTINENTAL', 'PIONEER', 'ZENITH', 'ATLAS', 'HELIOS', 'NORTHERN', 'COMMERCE', 'UNION', 'ORION'];
  function decoSkin(S, o) {
    return (len, h, info) => {
      const back = !info.front && !info.side, F = new L.Relief(len, h, 4, S.wall);
      const v0 = o.lobby ? S.gH : 0, cap = o.cap, n = Math.floor((h - v0 - cap) / FH), top = v0 + n * FH;
      const bw = S.bw, half = bw >> 1, cs = L.bays(len, bw, 4), b0 = cs[0] - half, b1 = cs[cs.length - 1] + half;
      const c0 = len >> 1, portal = o.lobby && info.front, pwH = Math.max(11, Math.min(15, Math.round(len * 0.12))), pH = S.gH + FH - 2;
      const inPortal = (c, v) => portal && Math.abs(c - c0) < pwH + half - 1 && v < pH;
      // ---- lobby storey: polished granite, bronze shopfronts, a stepped portal
      if (o.lobby) {
        F.rect(0, 0, len, S.gH, BASE, S.gran);
        F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);
        F.rect(0, S.gH - 2, len, S.gH, 3, S.acc);
        cs.forEach((c, k) => {
          if (inPortal(c, 0)) return;
          const u0 = c - half + 1, u1 = c + half;
          if (back) { F.rect(u0 + 1, 4, u1 - 1, S.gH - 6, 1, gm(S.seed, k, 3, 0.2)); return; }
          if (S.shops) {
            F.rect(u0, 2, u1, S.gH - 6, 1, gm(S.seed, k * 5 + len, 4, 0.55, 'dark'));
            F.rect(u0, S.gH - 6, u1, S.gH - 3, 1, BM.BRONZE);
            if (k % 3 === 1) F.rect(c - 1, 2, c + 2, 12, 0, BM.BRONZE);
          } else {
            F.rect(u0 + 1, 3, u1 - 1, S.gH - 4, 1, gm(S.seed, k, 6, 0.4, 'dark'));
            for (let u = u0 + 2; u < u1 - 1; u += 2) F.rect(u, 3, u + 1, S.gH - 4, 1, BM.BRONZE);
          }
        });
        for (let i = 0; i <= cs.length; ++i) { const p = b0 + i * bw; if (!inPortal(p, 0)) F.rect(p - 1, 0, p + 1, S.gH - 2, 3, S.gran); }
      }
      // ---- office floors: piers, recessed windows, dark spandrels with zig-zags
      for (let f = 0; f < n; ++f) {
        const v = v0 + f * FH;
        cs.forEach((c, k) => {
          if (inPortal(c, v)) { F.rect(c - half, v, c + half + 1, v + FH, 2, S.pier); return; }
          const u0 = c - half + 1, u1 = c + half;
          F.rect(u0, v, u1, v + 4, 1, S.spand);
          if (!back && (S.zigAll || f % 2 === 0)) for (let u = u0; u < u1; ++u) F.set(u, v + 1 + Math.abs(((u - u0) % 4) - 2), 1, S.zig);
          F.rect(u0, v + 4, u1, v + FH, 1, gm(S.seed, k * 13 + len, v, 0.32));
          if (back) return;
          if (u1 - u0 >= 6) F.rect(c, v + 4, c + 1, v + FH, 1, S.mull);
          F.rect(u0, v + 8, u1, v + 9, 1, S.mull);
        });
      }
      for (let i = 0; i <= cs.length; ++i) {
        const p = b0 + i * bw, major = !S.alt || i % 2 === 0;
        const pv0 = inPortal(p, 0) ? pH : v0;
        F.rect(p - 1, pv0, p + 1, top + cap - 1, major ? 4 : 3, S.pier);
      }
      if (b0 > 0) F.rect(0, v0, b0 + 1, h, 4, S.pier);
      if (len - b1 > 0) F.rect(b1 - 1, v0, len, h, 4, S.pier);
      if (portal) {
          const c = c0, tops = [pH, pH - 7, pH - 9, pH - 11], mats = [S.pier, S.acc, S.pier, S.acc];
          for (let k = 0; k < 4; ++k) F.rect(c - pwH + 2 * k, 0, c + pwH - 2 * k, tops[k], 6 - k, mats[k]);
          F.rect(c - 6, pH, c + 6, pH + 2, 6, S.pier); F.rect(c - 4, pH + 2, c + 4, pH + 4, 6, S.pier);   // ziggurat crest
          F.rect(c - 2, pH + 4, c + 2, pH + 6, 6, S.acc);
          const hw = pwH - 8, ot = pH - 13;
          F.rect(c - hw, 0, c + hw, ot, 0, BM.BRONZE);
          for (let u = c - hw + 1; u < c + hw - 1; u += 3) F.rect(u, 0, u + 2, 11, 0, gm(S.seed, u, 2, 0.8, 'dark'));
          for (let v = 12; v < ot; ++v) for (let u = c - hw; u < c + hw; ++u) {
            const a = Math.abs(u + 0.5 - c);
            F.set(u, v, 0, (u % 2 === 0 || Math.round(a + v) % 5 === 0) ? BM.BRONZE : BM.GLASS_DARK_LIT);
          }
          if (S.name) paintText(F, S.name, c, pH - 6, 7, BM.BRONZE);
          for (const sx of [-1, 1]) {                                                         // lanterns
            const u = c + sx * (pwH + 2);
            F.rect(u - 1, 8, u + 1, 15, 4, BM.BRONZE); F.rect(u - 1, 10, u + 1, 14, 5, BM.LED);
          }
        }
      // ---- ornamental parapet: chevron frieze, stepped panels, pier heads
      F.rect(0, top, len, top + 1, 3, S.pier);
      for (let u = 0; u < len; ++u) { const t = Math.abs((u % 8) - 4); F.rect(u, top + 1, u + 1, top + 1 + Math.max(1, 4 - t), 3, S.acc); }
      if (o.crown) cs.forEach((c) => {
        F.rect(c - 3, top + 5, c + 3, top + 7, 3, S.pier); F.rect(c - 2, top + 7, c + 2, h - 2, 3, S.pier); F.rect(c - 1, top + 7, c + 1, h - 3, 3, S.acc);
      });
      for (let i = 0; i <= cs.length; ++i) {
        const p = b0 + i * bw;
        if (S.alt && i % 2) continue;
        F.rect(p - 1, top, p + 1, h, 5, S.pier);
        F.rect(p - 2, h - 4, p + 2, h - 2, 5, S.pier);
      }
      F.rect(0, h - 1, len, h, 3, S.pier);
      F.returns();
      return partyMat(F, S.wall);
    };
  }
  function finial(S, hgt) {
    const M = new (VM())(6, hgt + 2, 6, 3, 3);
    M.box(-2, 0, -2, 2, 3, 2, S.pier); M.box(-1, 3, -1, 1, hgt - 3, 1, S.pier);
    M.box(-2, 5, -2, 2, 6, 2, S.acc); M.box(-1, hgt - 3, -1, 1, hgt - 1, 1, S.acc); M.box(0, hgt - 1, 0, 1, hgt + 1, 1, S.acc);
    return M;
  }
  function decoOffice(E, C, W, D, spec) {
    const R = reseed(C, spec, 0xa54ff53a);
    const party = spec.party || {}, pl = !!party.l, pr = !!party.r, seed = spec.seed;
    const pal = L.pick(R, [
      { wall: BM.BUFF, pier: BM.LIMESTONE, spand: BM.SPANDREL, zig: BM.BRONZE, acc: BM.BRONZE, mull: BM.BRONZE },
      { wall: BM.BRICK_BROWN, pier: BM.BUFF, spand: BM.STEEL_DARK, zig: BM.TERRACOTTA, acc: BM.TERRACOTTA, mull: BM.TRIM_DARK },
      { wall: BM.WHITE_CONCRETE, pier: BM.WHITE_CONCRETE, spand: BM.COPPER, zig: BM.TRIM, acc: BM.COPPER, mull: BM.TRIM_DARK },
      { wall: BM.LIMESTONE, pier: BM.LIMESTONE, spand: BM.TRIM_DARK, zig: BM.COPPER, acc: BM.LIMESTONE_DARK, mull: BM.TRIM_DARK },
      { wall: BM.BRICK_DARK, pier: BM.LIMESTONE, spand: BM.BRONZE, zig: BM.LIMESTONE, acc: BM.BRONZE, mull: BM.BRONZE }
    ]);
    const S = Object.assign({ seed, gH: 22, shops: spec.shops !== false }, pal);
    S.gran = L.pick(R, [BM.GRANITE_DARK, BM.GRANITE_PINK, BM.GRANITE_DARK, BM.LIMESTONE_DARK]);
    S.bw = W >= 130 ? 10 : L.pick(R, [8, 8, 10]); S.alt = R() < 0.4; S.zigAll = W < 120 && spec.floors < 13 && R() < 0.5;
    S.name = fit(R, DECO_NAMES, 2 * Math.max(11, Math.min(15, Math.round(W * 0.12))) - 4);
    const floors = spec.floors;
    let n2 = floors >= 11 && W >= 72 && D >= 64 ? 2 + (R() < 0.4 ? 1 : 0) : 0;
    let n1 = floors >= 9 ? 2 + Math.floor(R() * 2) : 2;
    const nb = Math.max(5, floors - n1 - n2);
    const sx1 = 6 + Math.floor(R() * 4), sz1 = 8 + Math.floor(R() * 6);
    const list = [{ x0: 0, z0: 0, x1: W, z1: D, h: S.gH + (nb - 1) * FH + 7, skin: decoSkin(S, { lobby: true, cap: 7 }), roof: { parapet: 1, mat: S.pier } }];
    let t1 = { x0: pl ? 0 : sx1, z0: sz1, x1: pr ? W : W - sx1, z1: D };
    if (D - sz1 < 30) t1.z0 = Math.max(4, D - 30);
    let t2 = null;
    if (n2) {
      const sx2 = sx1 + 6 + Math.floor(R() * 4), sz2 = t1.z0 + 8 + Math.floor(R() * 4);
      t2 = { x0: pl ? 0 : sx2, z0: sz2, x1: pr ? W : W - sx2, z1: D };
      if (t2.x1 - t2.x0 < 36 || t2.z1 - t2.z0 < 30) { t2 = null; n1 += n2; n2 = 0; }
    }
    list.push(Object.assign(t1, { h: n1 * FH + (t2 ? 7 : 10), skin: decoSkin(S, { cap: t2 ? 7 : 10, crown: !t2 }), roof: { parapet: 1, mat: S.pier } }));
    if (t2) list.push(Object.assign(t2, { h: n2 * FH + 10, skin: decoSkin(S, { cap: 10, crown: true }), roof: { parapet: 1, mat: S.pier } }));
    const yTop = blocks(E, C, W, D, list, party, seed);
    // finials on the free front corners of each setback
    list.forEach((b, i) => {
      if (i === 0 && R() < 0.5) return;
      const y = b.y + b.h - 1, hg = 10 + 2 * i;
      if (!(pl && b.x0 === 0)) E.vox(C, finial(S, hg), b.x0 + 2, y, b.z0 + 2);
      if (!(pr && b.x1 === W)) E.vox(C, finial(S, hg), b.x1 - 3, y, b.z0 + 2);
    });
    // a stepped lantern block on top (machine room in deco dress), then rooftop gear
    const tb = list[list.length - 1], avoid = [];
    const tw = Math.min(16, (tb.x1 - tb.x0) - 16), td = Math.min(14, (tb.z1 - tb.z0) - 16);
    if (tw >= 8 && td >= 8 && R() < 0.75) {
      const cx = (tb.x0 + tb.x1) >> 1, cz = tb.z0 + ((tb.z1 - tb.z0) >> 1), hw = tw >> 1, hd = td >> 1;
      const M = new (VM())(tw + 2, 30, td + 2, hw + 1, hd + 1);
      M.box(-hw, 0, -hd, hw, 10, hd, S.wall);
      for (let x = -hw + 1; x < hw - 1; x += 3) M.box(x, 2, -hd - 1, x + 1, 10, -hd, S.pier);
      M.box(-hw + 2, 10, -hd + 2, hw - 2, 15, hd - 2, S.pier);
      for (let x = -hw + 3; x < hw - 3; x += 2) M.box(x, 11, -hd + 1, x + 1, 14, -hd + 2, BM.LED);
      M.box(-hw + 4, 15, -hd + 4, hw - 4, 18, hd - 4, S.acc);
      M.box(-1, 18, -1, 1, 28, 1, BM.METAL);
      E.vox(C, M, cx, yTop - 1, cz);
      avoid.push([cx - hw - 2, cz - hd - 2, cx + hw + 2, cz + hd + 2]);
    }
    if (L.roofKit) L.roofKit(E, C, tb.x0 + 2, tb.z0 + 2, tb.x1 - 2, tb.z1 - 2, yTop, R, { style: 'office', floors, avoid });
  }
  A.registerMid('deco_office', decoOffice, { minW: 14, maxW: 45, minFloors: 8, maxFloors: 14, zones: ['mid', 'core'] });
})();
