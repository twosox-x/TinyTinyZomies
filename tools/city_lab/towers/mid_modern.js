// Downtown mid-rise plug-ins, post-war and contemporary:
//  - 'parking_garage'    a precast parking structure: open decks behind concrete spandrels, a sloped ramp bay seen
//                        through the openings, parked cars, an entry / exit portal with barrier arms, a lit blade
//                        "P" sign, shops on the street, a glazed stair / lift tower and a rooftop deck with lights;
//  - 'modern_infill'     a 2010s infill: metal or terracotta panel skin with staggered windows (some in box frames),
//                        a perforated-metal screen bay, a recessed glass ground floor with a cafe, a double-height
//                        entrance, and a set-back glass top floor on a planted terrace;
//  - 'midcentury_office' a 1960s office slab on pilotis: ribbon / curtain wall with aluminium mullions and blue or
//                        green enamel spandrels, a travertine plaza strip with planters under the overhang, a louvred
//                        mechanical penthouse and the company's name in letters on the parapet.
// Building-local voxels (0.25 m): x along the street, z into the lot (front at z = 0), y up. Reliefs read with u
// increasing to the viewer's LEFT, so lettering is mirrored when written.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH, H2 = L.H2, BASE = L.BASE;
  const VM = (w, h, d, ox, oz) => new (L.VoxModel())(w, h, d, ox, oz);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = L.pick;

  // ---- 5x7 pixel font for signage
  const GLYPH = {
    A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
    C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
    E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
    G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
    I: '01110 00100 00100 00100 00100 00100 01110', K: '10001 10010 10100 11000 10100 10010 10001',
    L: '10000 10000 10000 10000 10000 10000 11111', M: '10001 11011 10101 10101 10001 10001 10001',
    N: '10001 10001 11001 10101 10011 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
    P: '11110 10001 10001 11110 10000 10000 10000', R: '11110 10001 10001 11110 10100 10010 10001',
    S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
    U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
    W: '10001 10001 10001 10101 10101 10101 01010', Y: '10001 10001 01010 00100 00100 00100 00100',
    X: '10001 10001 01010 00100 01010 10001 10001'
  };
  const textW = (str, s) => (str.length * 6 - 1) * s;
  // put(i, j) for every lit pixel: i = column from the reader's left, j = row from the bottom
  function text(str, s, put) {
    let i0 = 0;
    for (const ch of str) {
      const g = GLYPH[ch] && GLYPH[ch].split(' ');
      if (g) for (let r = 0; r < 7; ++r) for (let c = 0; c < 5; ++c) if (g[r][c] === '1')
        for (let a = 0; a < s; ++a) for (let b = 0; b < s; ++b) put(i0 + c * s + a, (6 - r) * s + b);
      i0 += 6 * s;
    }
  }

  // ---- shared voxel parts
  const CAR_COL = [BM.TRIM, BM.METAL, BM.STEEL_DARK, BM.SHUTTER_BLACK, BM.DOOR_RED, BM.DOOR_NAVY, BM.AWNING_BLUE, BM.METAL,
    BM.TRIM, BM.PAINT_YELLOW, BM.SHUTTER_GREEN, BM.AWNING_RED, BM.PAINT_CREAM, BM.SIDING_GRAY, BM.SHUTTER_BLACK, BM.METAL];
  // a parked car, 7 voxels wide; dir 0/1: length along z, nose to -z / +z; dir 2/3: along x, nose to -x / +x
  function car(M, x, y, z, dir, h) {
    const col = CAR_COL[Math.floor(h * 9973) % CAR_COL.length], kind = Math.floor(h * 7919) % 5;   // 0,3 sedan 1 suv 2 hatch 4 wagon
    const len = kind === 2 ? 15 : kind === 1 ? 17 : 18;
    const put = (a0, y0, b0, a1, y1, b1, m) => {
      if (dir === 0) M.box(x + b0, y + y0, z + a0, x + b1, y + y1, z + a1, m);
      else if (dir === 1) M.box(x + b0, y + y0, z + len - a1, x + b1, y + y1, z + len - a0, m);
      else if (dir === 2) M.box(x + a0, y + y0, z + b0, x + a1, y + y1, z + b1, m);
      else M.box(x + len - a1, y + y0, z + b0, x + len - a0, y + y1, z + b1, m);
    };
    const bh = kind === 1 ? 5 : 4;
    put(0, 1, 0, len, bh, 7, col);
    put(2, 0, 0, 5, 2, 7, BM.SHUTTER_BLACK); put(len - 5, 0, 0, len - 2, 2, 7, BM.SHUTTER_BLACK);
    put(0, 2, 0, 1, 3, 2, BM.TRIM); put(0, 2, 5, 1, 3, 7, BM.TRIM);                              // headlamps
    put(len - 1, 2, 0, len, 3, 2, BM.DOOR_RED); put(len - 1, 2, 5, len, 3, 7, BM.DOOR_RED);      // tail lamps
    const c0 = kind === 2 ? 4 : 5, c1 = kind === 0 || kind === 3 ? len - 5 : len - 2;
    put(c0, bh, 1, c1, bh + 2, 6, BM.GLASS_DARK);
    put(c0 + 1, bh + 2, 1, c1 - (kind === 0 || kind === 3 ? 1 : 0), bh + 3, 6, col);
  }
  function tree(M, x, y, z, R, big) {
    const th = big ? 8 + Math.floor(R() * 3) : 5 + Math.floor(R() * 3), r = big ? 3.6 + R() : 2.4 + R() * 0.8;
    M.box(x, y, z, x + 1, y + th, z + 1, BM.TRUNK);
    const cy = y + th + r * 0.5, R0 = Math.ceil(r);
    for (let dy = -R0; dy <= R0; ++dy) for (let dz = -R0; dz <= R0; ++dz) for (let dx = -R0; dx <= R0; ++dx) {
      const q = Math.hypot(dx, dy * 1.25, dz);
      if (q > r) continue;
      const hs = H2(x * 31 + dx, z * 17 + dz, dy + 99);
      if (q > r - 1 && hs < 0.35) continue;
      M.box(x + dx, Math.round(cy + dy), z + dz, x + dx + 1, Math.round(cy + dy) + 1, z + dz + 1, hs < 0.5 ? BM.LEAF : BM.LEAF_DARK);
    }
  }
  function planter(M, x0, y, z0, x1, z1, mat, shrub) {
    M.box(x0, y, z0, x1, y + 3, z1, mat);
    M.box(x0 + 1, y + 3, z0 + 1, x1 - 1, y + 4, z1 - 1, BM.GRASS);
    if (shrub) for (let x = x0 + 1; x < x1 - 1; x += 2) M.box(x, y + 4, z0 + 1, Math.min(x1 - 1, x + 2), y + 5 + (H2(x, z0, y) < 0.4 ? 1 : 0), z1 - 1, BM.LEAF_DARK);
  }
  // facades of one rectangular block; skin(len, h, which): which 0 front, 1 back, 2 left (x0), 3 right (x1).
  // Left reliefs run back to front (u = 0 at the back), right reliefs front to back.
  function block(E, C, x0, z0, x1, z1, y, h, skin, party) {
    let k = 0;
    L.facades(E, x0, z0, x1, z1, y, (len) => { const F = skin(len, h, k++); return F; }, C, false, party || {});
  }
  // material the party-wall replacement copies (facades() reads cell (0, 0))
  const partyMat = (F, m) => { F.M[F.idx(0, 0)] = m; return F; };

  // ================================================================================================ parking garage
  function garage(E, C, W, D, spec, R) {
    const party = spec.party || {};
    const nL = clamp(spec.floors, 4, 8);                       // street level + decks; the roof deck on top
    const gH = 22, lh = 12, gT = gH - 2;
    const fy = (i) => (i === 0 ? 0 : gH + (i - 1) * lh);
    const roofY = fy(nL);
    const seed = spec.seed;
    const conc = pick(R, [BM.PRECAST, BM.CONCRETE, BM.WHITE_CONCRETE, BM.PRECAST]);
    const colM = R() < 0.5 ? conc : pick(R, [BM.CONCRETE, BM.PRECAST, BM.LIMESTONE_DARK, BM.GRANITE_DARK]);
    const deck = BM.CONCRETE, baseM = pick(R, [BM.GRANITE_DARK, conc, BM.BRICK_DARK, BM.STEEL_DARK]);
    const stripes = R() < 0.65;
    const lvCols = [BM.AWNING_RED, BM.PAINT_YELLOW, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.PAINT_SALMON, BM.DOOR_NAVY, BM.SHUTTER_GREEN, BM.AWNING_RED];
    const lvOff = Math.floor(R() * lvCols.length);
    const screen = pick(R, ['open', 'fins', 'mesh', 'open', 'fins']);
    const signC = pick(R, [BM.DOOR_NAVY, BM.AWNING_BLUE, BM.DOOR_NAVY]);
    const portalLeft = R() < 0.5;
    // stair / lift tower at the front corner away from the portal
    const st = 20, sd = Math.min(22, D - 12);
    const tx0 = portalLeft ? W - st : 0, tx1 = tx0 + st;
    const xa = portalLeft ? 0 : st, xb = portalLeft ? W - st : W, span = xb - xa;
    // structural bays along the front
    const nb = Math.max(2, Math.round(span / (30 + R() * 8))), bw = span / nb;
    const colsX = []; for (let k = 0; k <= nb; ++k) colsX.push(Math.round(xa + k * bw));
    const colR = (c) => (c <= 0 ? [0, 4] : c >= W ? [W - 4, W] : [c - 2, c + 2]);
    const colSkip = (k) => (portalLeft ? k === nb : k === 0);                      // the tower edge
    // ramp bay along the front, seen through the openings
    const zr0 = 3, zr1 = 23;
    const rL = clamp(Math.round(span * 0.62), 40, 84), up = R() < 0.5;
    const rx0 = xa + 6 + Math.floor(R() * Math.max(1, span - 12 - rL)), rx1 = rx0 + rL;
    // parking rows
    const backZ = D - 4, rows = [], aisles = [];
    { let z = zr0; rows.push({ z0: z, dir: 0 }); z += 19;
      while (z + 24 + 19 <= backZ) {
        aisles.push(z); z += 24;
        if (z + 38 <= backZ) { rows.push({ z0: z, dir: 1 }); rows.push({ z0: z + 19, dir: 0 }); z += 38; }
        else { rows.push({ z0: z, dir: 1 }); z += 19; }
      }
      if (!aisles.length) aisles.push(z); }
    const inTower = (x0, z0, x1, z1) => x1 > tx0 - 2 && x0 < tx1 + 2 && z0 < sd + 2;
    const inRamp = (x0, z0, x1, z1) => x1 > rx0 - 2 && x0 < rx1 + 2 && z1 > zr0 && z0 < zr1 + 1;

    // ---- street level: solid base, shops, portal, louvred sides
    const G = VM(W, gT + 1, D + 6, 0, 6);
    G.box(0, 0, 0, W, gT, D, conc);
    G.box(0, 0, 0, W, 2, 1, baseM);
    const pw = 30, pd = Math.min(24, D - 10);
    const p0 = portalLeft ? 4 : W - 4 - pw, p1 = p0 + pw;
    const entryLeft = portalLeft;                                                  // entry on the outer lane
    const isl0 = p0 + 13, isl1 = isl0 + 4;
    // columns
    colsX.forEach((c, k) => {
      if (colSkip(k)) return;
      const [c0, c1] = colR(c);
      if (c1 > p0 - 1 && c0 < p1 + 1) return;
      G.box(c0, 0, -1, c1, gT, 0, colM);
    });
    // bays between the columns: shops (or louvred screens)
    let shopK = 0;
    for (let k = 0; k < nb; ++k) {
      let s0 = colR(colsX[k])[1], s1 = colR(colsX[k + 1])[0];
      if (colSkip(k)) s0 = xa; if (colSkip(k + 1)) s1 = xb;
      const segs = [];
      if (s1 <= p0 - 2 || s0 >= p1 + 2) segs.push([s0, s1]);
      else { if (p0 - 2 - s0 >= 8) segs.push([s0, p0 - 2]); if (s1 - p1 - 2 >= 8) segs.push([p1 + 2, s1]); }
      for (const [a, b] of segs) {
        if (b - a < 8) continue;
        if (spec.shops) {
          const kk = shopK++;
          G.box(a, 1, 0, b, 14, 3, -1);
          for (let u = a; u < b; u += 6) G.box(u, 3, 3, Math.min(b, u + 6), 14, 4, L.glassMat(seed, u, 3, 0.6, 'dark'));
          G.box(a, 1, 2, b, 3, 3, BM.STEEL_DARK);                                   // kick plate
          for (let u = a + 6; u < b - 1; u += 6) G.box(u, 3, 2, u + 1, 14, 3, BM.STEEL_DARK);
          const dc = H2(seed, kk, 5) < 0.5 ? a + 2 : b - 7;
          G.box(dc, 1, 2, dc + 5, 12, 3, BM.STEEL_DARK); G.box(dc + 1, 1, 3, dc + 4, 11, 4, BM.GLASS_DARK_LIT);
          G.box(dc + 1, 1, 2, dc + 4, 11, 3, -1);
          G.box(a, 14, -1, b, 18, 0, BM.STEEL_DARK);                                 // sign band
          const sw = Math.min(16, b - a - 6), sx = a + ((b - a - sw) >> 1);
          G.box(sx, 15, -2, sx + sw, 17, -1, H2(seed, kk, 7) < 0.5 ? BM.LED : BM.NEON);
          if (H2(seed, kk, 9) < 0.55) {                                              // awning
            const aw = pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]);
            G.box(a + 1, 13, -3, b - 1, 14, 0, aw); G.box(a + 1, 12, -5, b - 1, 13, -3, aw);
          }
        } else {
          G.box(a, 3, 0, b, gT - 3, 2, -1);
          for (let y = 3; y < gT - 3; ++y) G.box(a, y, 2, b, y + 1, 3, y % 2 ? BM.LOUVER : BM.METAL);
        }
      }
    }
    // the portal: two lanes, island with ticket machine, barrier arms, clearance bar, IN / OUT
    G.box(p0, 1, 0, p1, 12, pd, -1);
    G.box(p0, 1, pd - 1, p1, 12, pd, BM.STEEL_DARK);
    const eL0 = entryLeft ? p0 : isl1, eL1 = entryLeft ? isl0 : p1, xL0 = entryLeft ? isl1 : p0, xL1 = entryLeft ? p1 : isl0;
    for (let z = pd - 12; z < pd - 1; ++z) G.box(eL0, 1, z, eL1, 1 + ((z - (pd - 12)) >> 1), z + 1, deck);   // ramp going up
    for (const [a, b] of [[eL0, eL1], [xL0, xL1]]) G.box(((a + b) >> 1) - 1, 12, 3, ((a + b) >> 1) + 1, 13, pd - 2, BM.LED);
    G.box(isl0, 1, 2, isl1, 2, pd - 4, conc); G.box(isl0, 1, 2, isl1, 2, 3, BM.PAINT_YELLOW);
    const stripe = (a, b, y, z) => { for (let x = a; x < b; x += 2) G.box(x, y, z, Math.min(b, x + 2), y + 1, z + 1, ((x - a) >> 1) % 2 ? BM.DOOR_RED : BM.TRIM); };
    const eIn = entryLeft ? isl0 : isl1 - 2, eX = entryLeft ? isl1 - 2 : isl0;
    G.box(eIn, 2, 5, eIn + 2, 7, 7, BM.PAINT_YELLOW);                               // entry barrier post + arm
    if (entryLeft) stripe(eL0 + 1, isl0, 5, 6); else stripe(isl1, eL1 - 1, 5, 6);
    G.box(eIn, 2, 9, eIn + 2, 7, 11, BM.METAL); G.box(eIn, 5, entryLeft ? 9 : 9, eIn + 2, 6, 11, BM.LED);   // ticket machine
    G.box(eX, 2, 12, eX + 2, 7, 14, BM.PAINT_YELLOW);                               // exit barrier
    if (entryLeft) stripe(isl1, xL1 - 1, 5, 13); else stripe(xL0 + 1, isl0, 5, 13);
    G.box(p0 - 1, 12, -1, p1 + 1, gT, 0, BM.STEEL_DARK);                            // header
    const sayAt = (str, a, b) => { const tw = textW(str, 1), xr = ((a + b + tw) >> 1) - 1; text(str, 1, (i, j) => G.box(xr - i, 13 + j, -2, xr - i + 1, 14 + j, -1, BM.LED)); };
    sayAt('IN', eL0, eL1); sayAt('OUT', xL0, xL1);
    for (let x = p0 + 2; x < p1 - 2; x += 2) G.box(x, 10, -3, x + 2, 11, -2, ((x - p0) >> 1) % 2 ? BM.SHUTTER_BLACK : BM.PAINT_YELLOW);
    for (const x of [p0 + 3, p1 - 4]) { G.box(x, 11, -3, x + 1, 13, -2, BM.STEEL_DARK); G.box(x, 12, -2, x + 1, 13, -1, BM.STEEL_DARK); }
    // sides and back at street level
    for (const s of ['l', 'r']) {
      if (party[s]) continue;
      const xo = s === 'l' ? 0 : W - 1, xi = s === 'l' ? 1 : W - 2;
      const zs = (s === 'l') === !portalLeft ? sd + 4 : 6;
      for (let z = zs; z + 14 < D - 4; z += 20) {
        G.box(xo, 4, z, xo + 1, gT - 4, z + 14, -1);
        for (let y = 4; y < gT - 4; ++y) G.box(xi, y, z, xi + 1, y + 1, z + 14, y % 2 ? BM.LOUVER : BM.METAL);
      }
    }
    { const bx = Math.round(W * (0.3 + R() * 0.3));                                   // service roll-up door at the back
      G.box(bx, 0, D - 1, bx + 14, 13, D, BM.METAL);
      for (let y = 1; y < 13; y += 2) G.box(bx, y, D - 1, bx + 14, y + 1, D, BM.STEEL_DARK); }
    G.box(tx0, 0, 0, tx1, gT + 1, sd, -1);
    E.vox(C, G, 0, 0, 0);

    // ---- one parking level (or the roof deck)
    const level = (i, roof) => {
      const hh = roof ? 32 : lh + 4, top = roof ? 6 : lh;
      const M = VM(W, hh, D + 2, 0, 2);
      const Rl = C.mulberry32((seed * 131 + i * 7919) >>> 0);
      M.box(0, 0, 0, W, 2, D, deck);
      M.box(rx0, 0, zr0, rx1, 2, zr1, -1);
      if (!roof) for (let x = rx0; x < rx1; ++x) {                                     // sloped ramp floor
        const t = up ? (x - rx0 + 1) / rL : (rx1 - x) / rL, yt = 2 + Math.round(lh * t);
        M.box(x, yt - 2, zr0, x + 1, yt, zr1, deck);
        if ((x >> 2) % 2) M.box(x, yt - 1, zr0 + 9, x + 1, yt, zr0 + 10, BM.PAINT_YELLOW);
        M.box(x, yt, zr1 - 1, x + 1, yt + 3, zr1, conc);                              // curb wall on the inner edge
      } else {                                                                         // guard walls round the ramp well
        M.box(rx0, 2, zr1, rx1, 6, zr1 + 1, conc);
        const lo = up ? rx0 - 1 : rx1;
        M.box(lo, 2, zr0, lo + 1, 6, zr1 + 1, conc);
      }
      // front: spandrel with coping lip and level-colour stripe, columns, screens
      M.box(0, 0, 0, W, 6, 2, conc);
      M.box(0, 5, -1, W, 6, 0, conc);
      if (stripes && !roof) M.box(xa, 2, 0, xb, 3, 1, lvCols[(i + lvOff) % lvCols.length]);
      colsX.forEach((c, k) => { if (!colSkip(k)) { const [c0, c1] = colR(c); M.box(c0, 0, -1, c1, top + (roof ? 1 : 0), 3, colM); } });
      if (!roof && screen !== 'open') for (let k = 0; k < nb; ++k) {
        const a = colR(colsX[k])[1], b = colR(colsX[k + 1])[0];
        if (screen === 'fins') { for (let x = a + 1; x < b - 1; x += 3) M.box(x, 6, 0, x + 1, lh, 1, BM.METAL); }
        else if ((k + i) % 3 === 0) for (let y = 6; y < lh; ++y) M.box(a, y, 1, b, y + 1, 2, y % 2 ? BM.LOUVER : BM.METAL);
      }
      // sides: party walls solid, free sides screened between columns
      for (const s of ['l', 'r']) {
        const towerSide = (s === 'l') === !portalLeft, z0 = towerSide ? sd : 0;
        if (party[s]) { const x = s === 'l' ? 0 : W - 2; M.box(x, 0, z0, x + 2, top, D, conc); continue; }
        const xs = s === 'l' ? 1 : W - 3, xsc = s === 'l' ? 2 : W - 3, xc = s === 'l' ? 0 : W - 4;
        M.box(xs, 0, z0, xs + 2, 6, D, conc);
        M.box(s === 'l' ? 0 : W - 1, 5, z0, s === 'l' ? 1 : W, 6, D, conc);
        if (!roof) for (let y = 6; y < lh; ++y) M.box(xsc, y, z0, xsc + 1, y + 1, D, y % 2 ? BM.LOUVER : BM.METAL);
        for (let z = z0 + (towerSide ? 0 : 3); z < D; z += 28) M.box(xc, 0, z, xc + 4, top + (roof ? 1 : 0), Math.min(D, z + 4), colM);
        M.box(xc, 0, D - 4, xc + 4, top + (roof ? 1 : 0), D, colM);
      }
      // back
      M.box(0, 0, D - 3, W, 6, D - 1, conc);
      if (!roof) for (let y = 6; y < lh; ++y) M.box(0, y, D - 3, W, y + 1, D - 2, y % 2 ? BM.LOUVER : BM.METAL);
      colsX.forEach((c) => { const [c0, c1] = colR(c); M.box(c0, 0, D - 4, c1, top + (roof ? 1 : 0), D, colM); });
      // interior columns at the aisle edges
      if (!roof) for (let k = 1; k < nb; ++k) for (const za of aisles) {
        const c = colsX[k];
        if (inRamp(c - 1, za, c + 2, za + 3) || inTower(c - 1, za, c + 2, za + 3) || za + 3 > backZ) continue;
        M.box(c - 1, 2, za, c + 2, lh, za + 3, colM);
      }
      // ceiling lights (the underside of this slab lights the level below)
      if (i >= 2) for (let x = xa + 5; x + 6 < xb - 4; x += 12) {
        if (!inRamp(x, 5, x + 6, 7) && !inTower(x, 5, x + 6, 7)) M.box(x, 0, 5, x + 6, 1, 7, BM.LED);
      }
      if (i >= 2) for (const za of aisles) for (let x = xa + 8; x + 6 < xb - 4; x += 18) {
        if (inRamp(x, za + 10, x + 6, za + 12) || inTower(x, za + 10, x + 6, za + 12)) continue;
        M.box(x, 0, za + 10, x + 6, 1, za + 12, BM.LED);
      }
      // stall lines and cars
      const occ = roof ? 0.22 : clamp(0.9 - 0.13 * (i - 1), 0.25, 0.9);
      for (const rw of rows) {
        for (let x = 4; x + 10 <= W - 4; x += 10) {
          const z0 = rw.z0, z1 = rw.z0 + 19;
          if (inTower(x, z0, x + 10, z1) || inRamp(x, z0, x + 10, z1)) continue;
          if (rw.z0 === zr0 && (x < 4 || x + 10 > W - 4)) continue;
          M.box(x, 1, rw.dir === 0 ? z0 + 2 : z0, x + 1, 2, rw.dir === 0 ? z1 : z1 - 2, BM.TRIM);
          if (x + 20 > W - 4) M.box(x + 10, 1, rw.dir === 0 ? z0 + 2 : z0, x + 11, 2, rw.dir === 0 ? z1 : z1 - 2, BM.TRIM);
          if (Rl() < occ) car(M, x + 2 + (Rl() < 0.5 ? 0 : 1), 2, z0 + (rw.dir === 0 ? 1 : 0), rw.dir === 0 ? (Rl() < 0.8 ? 0 : 1) : (Rl() < 0.8 ? 1 : 0), Rl());
        }
      }
      if (roof) {                                                                       // light poles
        for (const za of aisles) for (let x = xa + 14; x < xb - 8; x += 36) {
          const z = za + 12;
          if (inRamp(x - 4, z - 2, x + 5, z + 2) || inTower(x - 4, z - 2, x + 5, z + 2)) continue;
          M.box(x - 1, 2, z - 1, x + 2, 4, z + 2, conc);
          M.box(x, 4, z, x + 1, 27, z + 1, BM.METAL);
          M.box(x - 4, 26, z, x + 5, 27, z + 1, BM.METAL);
          M.box(x - 4, 25, z, x - 2, 26, z + 1, BM.LED); M.box(x + 3, 25, z, x + 5, 26, z + 1, BM.LED);
        }
      }
      M.box(tx0, 0, -2, tx1, hh, sd, -1);
      return M;
    };
    for (let i = 1; i < nL; ++i) E.vox(C, level(i, false), 0, fy(i) - 2, 0);
    E.vox(C, level(nL, true), 0, roofY - 2, 0);

    // ---- glazed stair / lift tower with a "P" on its crown
    const tTop = roofY + 22, T = VM(st, tTop + 2, sd + 2, 0, 2);
    T.box(0, 0, 0, st, tTop, sd, conc);
    T.box(0, tTop, 0, st, tTop + 1, sd, BM.TRIM_DARK);
    const freeSide = portalLeft ? !party.r : !party.l;
    const glazeFace = (put, n) => {                                                    // n = face width; put(u, y, depth, m)
      for (let u = 2; u < n - 2; ++u) for (let y = gH; y < roofY + 4; ++y) put(u, y, 0, BM.GLASS_LIT);
      for (let i = 1; i <= nL; ++i) {                                                   // landings and stair flights
        const y0 = fy(i) - 1;
        if (y0 >= gH && y0 < roofY + 4) for (let u = 2; u < n - 2; ++u) put(u, y0, 0, conc);
        for (let half = 0; half < 2; ++half) {
          const yb = fy(i) + half * 6, len = n - 8;
          if (yb + 6 >= roofY + 4 || yb < gH) continue;
          for (let k = 0; k < len; ++k) {
            const u = half ? n - 5 - k : 4 + k, y = yb + Math.floor(k * 6 / len);
            put(u, y, 0, BM.TRIM_DARK); put(u, y - 1, 0, BM.TRIM_DARK);
          }
        }
      }
      for (let u = 2; u < n - 1; u += 5) for (let y = gH; y < roofY + 4; ++y) put(u, y, -1, BM.METAL);
    };
    glazeFace((u, y, d, m) => T.box(u, y, d, u + 1, y + 1, d + 1, m), st);
    if (freeSide) {
      if (portalLeft) glazeFace((u, y, d, m) => T.box(st - 1 - d, y, u, st - d, y + 1, u + 1, m), sd);
      else glazeFace((u, y, d, m) => T.box(d, y, sd - 1 - u, d + 1, y + 1, sd - u, m), sd);
    }
    T.box(5, 1, 0, 14, 12, 2, -1); T.box(5, 1, 1, 14, 12, 2, BM.STEEL_DARK); T.box(6, 1, 1, 13, 11, 2, BM.GLASS_DARK_LIT);
    T.box(3, 12, -4, 16, 13, 0, BM.METAL);                                             // door canopy
    T.box(3, roofY + 5, -1, st - 3, roofY + 21, 0, signC);
    text('P', 2, (i, j) => T.box(14 - i, roofY + 6 + j, -2, 15 - i, roofY + 7 + j, -1, BM.LED));
    for (let y = roofY + 1; y < roofY + 4; y += 2) T.box(2, y, -1, st - 2, y + 1, 0, BM.LOUVER);
    E.vox(C, T, tx0, 0, 0);

    // ---- blade sign with a lit P (and PARK) on the portal corner
    { const k = portalLeft ? 0 : nb, c = colsX[k], [c0, c1] = colR(c), bx = ((c0 + c1) >> 1) - 1;
      const y0 = gH + 2, tall = y0 + 58 < roofY, bh = tall ? 56 : 22;
      const B = VM(4, bh + 2, 18, 1, 17);
      B.box(0, 0, -16, 2, bh, -1, signC);
      B.box(0, 0, -16, 2, 1, -1, BM.METAL); B.box(0, bh - 1, -16, 2, bh, -1, BM.METAL); B.box(0, 0, -16, 2, bh, -15, BM.METAL);
      const pY = bh - 17;
      text('P', 2, (i, j) => { B.box(-1, pY + j, -13 + i, 0, pY + j + 1, -12 + i, BM.LED); B.box(2, pY + j, -4 - i, 3, pY + j + 1, -3 - i, BM.LED); });
      if (tall) ['P', 'A', 'R', 'K'].forEach((ch, n) => text(ch, 1, (i, j) => {
        const y = pY - 10 - n * 9 + j; B.box(-1, y, -11 + i, 0, y + 1, -10 + i, BM.NEON); B.box(2, y, -6 - i, 3, y + 1, -5 - i, BM.NEON);
      }));
      E.vox(C, B, bx, y0, 0); }
  }
  A.registerMid('parking_garage', (E, C, W, D, spec, R) => garage(E, C, W, D, spec, R), { zones: ['mid', 'core'], minW: 20, maxW: 40, minFloors: 4, maxFloors: 8 });

  // ================================================================================================ modern infill
  const INFILL_PAL = [
    { panel: BM.TERRACOTTA, alt: BM.BUFF, joint: BM.GRANITE_PINK, frame: BM.BRONZE, mull: BM.BRONZE, coping: BM.BRONZE, screenM: BM.BRONZE, tint: 'dark', ground: BM.STEEL_DARK },
    { panel: BM.STEEL_DARK, alt: BM.GRANITE_DARK, joint: BM.SHUTTER_BLACK, frame: BM.METAL, mull: BM.METAL, coping: BM.METAL, screenM: BM.METAL, tint: 'blue', ground: BM.STEEL_DARK },
    { panel: BM.WHITE_CONCRETE, alt: BM.PRECAST, joint: BM.LIMESTONE_DARK, frame: BM.STEEL_DARK, mull: BM.STEEL_DARK, coping: BM.STEEL_DARK, screenM: BM.STEEL_DARK, tint: 'dark', ground: BM.STEEL_DARK },
    { panel: BM.METAL, alt: BM.LOUVER, joint: BM.STEEL_DARK, frame: BM.STEEL_DARK, mull: BM.STEEL_DARK, coping: BM.STEEL_DARK, screenM: BM.COPPER, tint: 'green', ground: BM.STEEL_DARK },
    { panel: BM.BRICK_DARK, alt: BM.BRICK_BROWN, joint: BM.GRANITE_DARK, frame: BM.COPPER, mull: BM.STEEL_DARK, coping: BM.COPPER, screenM: BM.COPPER, tint: 'dark', ground: BM.GRANITE_DARK },
    { panel: BM.BUFF, alt: BM.TERRACOTTA, joint: BM.LIMESTONE_DARK, frame: BM.STEEL_DARK, mull: BM.STEEL_DARK, coping: BM.STEEL_DARK, screenM: BM.BRONZE, tint: 'curtain', ground: BM.STEEL_DARK }
  ];
  function infill(E, C, W, D, spec, R) {
    const party = spec.party || {};
    const n = clamp(spec.floors, 6, 14), seed = spec.seed;
    const S = Object.assign({ seed }, pick(R, INFILL_PAL));
    S.pm = pick(R, [6, 8, 6]); S.toneP = 0.18 + R() * 0.2; S.joints = R() < 0.6;
    S.widths = pick(R, [[4, 6, 8], [6, 10], [4, 8, 12], [6, 6, 10], [4, 4, 10]]);
    S.gaps = pick(R, [[3, 5], [4, 6, 8], [3, 4, 7], [5, 9]]);
    S.tallP = R() * 0.5; S.frameP = R() < 0.6 ? 0.2 + R() * 0.3 : 0; S.stagger = pick(R, ['alt', 'tri', 'shift', 'alt']);
    S.lit = 0.3;
    const gH = 20, rec = 6 + Math.floor(R() * 3), nb = n - 2, hb = nb * FH + 2;
    const yB = gH + hb;
    // entrance (double height) and cafe along the front
    const ew = W >= 64 ? 14 : 10, entL = R() < 0.5;
    const ex0 = entL ? 4 : W - 4 - ew, ex1 = ex0 + ew;
    const cafe0 = entL ? ex1 + 5 : 2, cafe1 = entL ? W - 2 : ex0 - 5;
    S.screen = W >= 48 && R() < 0.7;
    const scw = Math.round(W * (0.3 + R() * 0.12));
    const sc0 = entL ? W - 3 - scw : 3, sc1 = sc0 + scw;
    { const fit = ['CAFE', 'COFFEE', 'DELI', 'BAKERY', 'ESPRESSO', 'BISTRO', 'BAR'].filter((t) => textW(t, 1) <= cafe1 - cafe0 - 6);
      S.cafeName = fit.length ? pick(R, fit) : ''; }
    const cafeSign = R() < 0.5 ? BM.NEON : BM.LED;

    const seqs = (len, which) => [0, 1, 2].map((k) => {
      const out = [];
      let u = 3 + Math.floor(H2(seed, which, k * 7) * 3);
      for (;;) {
        const w = S.widths[Math.floor(H2(seed, u, k + which * 11) * S.widths.length)];
        if (u + w > len - 3) break;
        out.push([u, w, H2(seed, u, k + 50) < S.tallP, H2(seed, u + 9, k + which) < S.frameP]);
        u += w + S.gaps[Math.floor(H2(seed, u + 3, k) * S.gaps.length)];
      }
      const last = out.length ? out[out.length - 1][0] + out[out.length - 1][1] : 0, sh = (len - 3 - last - (out.length ? out[0][0] - 3 : 0)) >> 1;
      for (const o of out) o[0] += Math.max(0, sh);
      return out;
    });
    function bodySkin(len, h, which) {
      const F = new L.Relief(len, h, 2, S.panel), front = which === 0;
      const xOf = (u) => (which === 0 ? u : which === 1 ? W - 1 - u : u);                // building x for front / back
      for (let f = 0; f < nb; ++f) for (let k = 0; k * S.pm < len; ++k)
        if (H2(seed + which * 7, k, f) < S.toneP) F.rect(k * S.pm, f * FH, Math.min(len, (k + 1) * S.pm), (f + 1) * FH, BASE, S.alt);
      if (S.joints) for (let f = 1; f < nb; ++f) F.rect(0, f * FH - 1, len, f * FH, BASE, S.joint);
      const ss = seqs(len, which);
      const inEnt = (u0, u1, f) => front && f <= 1 && u1 > ex0 - 4 && u0 < ex1 + 4;
      const inScr = (u0, u1, f) => front && S.screen && f >= 1 && u1 > sc0 - 2 && u0 < sc1 + 2;
      for (let f = 0; f < nb; ++f) {
        let seq = S.stagger === 'alt' ? ss[f % 2] : S.stagger === 'tri' ? ss[f % 3] : ss[0];
        const shift = S.stagger === 'shift' ? [0, 3, -2][f % 3] : 0;
        if (which >= 2) seq = ss[(f + which) % 2];
        for (const [u0r, w, tall, fr] of seq) {
          const u0 = u0r + shift;
          if (u0 < 2 || u0 + w > len - 2) continue;
          if (inEnt(u0 - 1, u0 + w + 1, f) || inScr(u0 - 1, u0 + w + 1, f)) continue;
          const v0 = f * FH + (tall ? 1 : 3), v1 = f * FH + FH - (tall ? 2 : 3);
          if (fr) F.rect(u0 - 1, v0 - 1, u0 + w + 1, v1 + 1, 4, S.frame);
          else F.rect(u0, v0 - 1, u0 + w, v0, 3, S.mull);
          F.rect(u0, v0, u0 + w, v1, 1, L.glassMat(seed, u0 + which * 131, f, S.lit, S.tint));
          if (w >= 8) F.rect(u0 + (w >> 1), v0, u0 + (w >> 1) + 1, v1, 2, S.mull);
          if (tall && w <= 6 && !fr) F.rect(u0, v0 + 5, u0 + w, v0 + 6, 2, S.mull);           // juliet-balcony rail
        }
      }
      if (front) {
        // double-height entrance: glass on the first floor between projecting piers and a head
        F.rect(ex0, 0, ex1, FH, 0, BM.GLASS_DARK_LIT);
        for (let u = ex0 + 4; u < ex1 - 1; u += 4) F.rect(u, 0, u + 1, FH, 1, S.mull);
        F.rect(ex0 - 3, 0, ex0, FH + 2, 5, S.frame); F.rect(ex1, 0, ex1 + 3, FH + 2, 5, S.frame);
        F.rect(ex0 - 3, FH, ex1 + 3, FH + 2, 5, S.frame);
        if (S.screen) {                                                                   // perforated metal screen
          const vs0 = FH - 1, vs1 = nb * FH;
          F.rect(sc0 - 1, vs0, sc1 + 1, vs1, 5, S.screenM); F.rect(sc0, vs0 + 1, sc1, vs1 - 1, 4, S.screenM);
          for (let v = vs0 + 1; v < vs1 - 1; ++v) {
            if (v % 2) continue;
            const win = (v % FH) >= 3 && (v % FH) < FH - 3, off = (v >> 1) % 2 ? 2 : 0;
            for (let u = sc0 + 1 + off; u + 3 <= sc1 - 1; u += 4)
              F.rect(u, v, u + (win ? 3 : 1) , v + 1, 2, win ? L.glassMat(seed, (u / 6) | 0, (v / FH) | 0, 0.45, 'dark') : BM.STEEL_DARK);
          }
        }
      }
      F.rect(0, nb * FH, len, h, 3, S.coping);
      F.returns();
      return partyMat(F, S.panel);
    }
    function groundSkin(len, h, which) {
      const F = new L.Relief(len, h, 2, S.ground);
      if (which === 0) {
        F.rect(0, 1, len, h - 1, 1, L.glassMat(seed, 1, 1, 0.6, 'dark'));
        for (let u = 0; u < len; u += 6) F.rect(u, 1, u + 1, h - 1, 2, S.ground);
        F.rect(0, 12, len, 13, 2, S.ground);
        if (cafe1 - cafe0 >= 12) {                                                         // cafe: warm glazing, door, sign
          for (let u = cafe0; u < cafe1; u += 6) F.rect(u + 1, 1, Math.min(cafe1, u + 6), 11, 1, L.glassMat(seed, u, 2, 0.85));
          const dc = entL ? cafe0 + 2 : cafe1 - 7;
          F.rect(dc, 1, dc + 5, 11, 0, BM.GLASS_DARK_LIT); F.rect(dc - 1, 11, dc + 6, 12, 2, S.ground);
          F.rect(cafe0, 11, cafe1, h - 1, 2, BM.STEEL_DARK);
          const name = S.cafeName;
          const tw = textW(name, 1), ul = ((cafe0 + cafe1 + tw) >> 1) - 1;
          text(name, 1, (i, j) => F.set(ul - i, 12 + j, 3, cafeSign));
        }
      } else if (which === 1) {
        for (let u = 6; u + 10 < len - 4; u += 22) { F.rect(u, 0, u + 8, 11, 1, BM.METAL); F.rect(u + 12, 4, u + 18, 11, 1, L.glassMat(seed, u, 4, 0.4, 'dark')); }
      } else {
        const fr = which === 2 ? len - 14 : 2, fr1 = which === 2 ? len - 2 : 14;
        F.rect(fr, 1, fr1, h - 2, 1, L.glassMat(seed, which, 3, 0.7, 'dark'));
        for (let u = 8; u + 6 < len - 16; u += 16) F.rect(u + (which === 2 ? 0 : 14), 3, u + 6 + (which === 2 ? 0 : 14), h - 4, 1, BM.LOUVER);
      }
      F.rect(0, h - 1, len, h, 2, S.ground);
      return partyMat(F, S.ground);
    }
    // ground storey (set back under the overhang), body, soffit
    block(E, C, 0, rec, W, D, 0, gH, groundSkin, party);
    block(E, C, 0, 0, W, D, gH, hb, bodySkin, party);
    const bodyMask = L.rectMask(W, D, 0, 0, W, D, 0);
    L.soffit(E, bodyMask, W, D, gH, pick(R, [BM.WOOD, S.panel, BM.TRIM]));
    // entrance piers under the overhang, lobby glass flush with the first-floor glazing, cafe terrace
    const P = VM(W, gH + 2, rec + 6, 0, 4);
    P.box(ex0 - 3, 0, -3, ex0, gH, rec, S.frame); P.box(ex1, 0, -3, ex1 + 3, gH, rec, S.frame);
    P.box(ex0, 0, 2, ex1, gH, rec, BM.GLASS_DARK_LIT);
    for (let x = ex0 + 4; x < ex1 - 1; x += 4) P.box(x, 0, 1, x + 1, gH, 2, S.mull);
    P.box(ex0 + 2, 0, 1, ex1 - 2, 11, 2, BM.STEEL_DARK); P.box(ex0 + 3, 0, 1, ex1 - 3, 10, 2, -1);
    P.box(ex0 + 3, 0, 1, ex1 - 3, 10, 2, BM.GLASS_DARK); P.box(ex0 + (ew >> 1), 0, 0, ex0 + (ew >> 1) + 1, 10, 1, BM.METAL);
    // street number plate on the pier
    P.box(entL ? ex1 + 1 : ex0 - 2, 12, -4, entL ? ex1 + 2 : ex0 - 1, 14, -3, BM.LED);
    if (cafe1 - cafe0 >= 12) {
      for (let x = cafe0 + 4, k = 0; x + 6 < cafe1 - 1; x += 11 + (k++ % 2) * 3) {
        P.box(x + 1, 0, 3, x + 2, 3, 4, BM.STEEL_DARK); P.box(x, 3, 2, x + 3, 4, 5, BM.TRIM);                 // bistro table
        P.box(x, 0, 0, x + 3, 4, 1, BM.STEEL_DARK); P.box(x, 0, 1, x + 3, 2, 2, BM.STEEL_DARK);              // chair facing the glass
        if (rec >= 8) { P.box(x, 0, 6, x + 3, 4, 7, BM.STEEL_DARK); P.box(x, 0, 5, x + 3, 2, 6, BM.STEEL_DARK); }
        const z = 2;
        if (k % 2 === 0) P.box(x - 3, 0, z, x - 2, 4, z + 2, BM.WOOD);                                 // A-board
      }
      const bx = entL ? cafe1 - 6 : cafe0 + 1;
      planter(P, bx, 0, 1, bx + 5, 4, S.ground, true);
    }
    // columns at free front corners (the overhang's support)
    if (!party.l && ex0 - 3 > 4) P.box(0, 0, 0, 3, gH, 3, S.frame);
    if (!party.r && ex1 + 3 < W - 4) P.box(W - 3, 0, 0, W, gH, 3, S.frame);
    E.vox(C, P, 0, 0, 0);

    // ---- set-back glass top floor on a terrace
    const tl = party.l ? 0 : 4, tr = party.r ? 0 : 4, tf = clamp(14 + Math.floor(R() * 10), 10, Math.floor(D * 0.4)), tb = D > 60 ? 4 : 0;
    const tH = FH + 2, yT = yB + tH;
    const topSkin = (len, h, which) => {
      const F = new L.Relief(len, h, 1, S.mull);
      for (let u = 0; u < len; u += 5) F.rect(u, 1, Math.min(len, u + 5), h - 2, BASE, L.glassMat(seed, u + which * 77, 99, 0.5, which === 0 ? 'dark' : S.tint));
      for (let u = 0; u < len; u += 5) F.rect(u, 1, u + 1, h - 3, 3, S.mull);
      F.rect(0, 0, len, 1, BASE, S.mull); F.rect(0, h - 2, len, h, BASE, S.coping);
      F.returns();
      return partyMat(F, S.panel);
    };
    block(E, C, tl, tf, W - tr, D - tb, yB, tH, topSkin, { l: party.l && tl === 0, r: party.r && tr === 0 });
    const topMask = L.rectMask(W, D, tl, tf, W - tr, D - tb, 0);
    L.roofMask(E, C, bodyMask, topMask, W, D, yB, { parapet: 4, mat: pick(R, [BM.CURTAIN, BM.GLASS_GREEN, S.coping]), deck: BM.WOOD }, seed);
    L.roofMask(E, C, topMask, null, W, D, yT, { parapet: 1, mat: S.coping, deck: BM.ROOF_TAR }, seed + 3);
    // canopy over the terrace, planters, tables, loungers
    const T = VM(W, tH + 4, tf + 2, 0, 0);
    const cx0 = tl + 2, cx1 = W - tr - 2, cz0 = Math.max(2, tf - 6);
    T.box(cx0, tH - 2, cz0, cx1, tH, tf, S.coping);
    for (const x of [cx0 + 1, cx1 - 2, (cx0 + cx1) >> 1]) T.box(x, 0, cz0 + 1, x + 1, tH - 2, cz0 + 2, BM.STEEL_DARK);
    for (let x = 3; x + 7 < W - 3; x += 12) {
      if (cz0 - 4 < 2) break;
      planter(T, x, 0, 1, x + 7, 4, S.coping === BM.BRONZE ? BM.BRONZE : BM.STEEL_DARK, false);
      if (H2(seed, x, 4) < 0.5 && W > 40) tree(T, x + 3, 4, 2, R, false);
      else T.box(x + 1, 4, 2, x + 6, 6, 3, BM.LEAF_DARK);
    }
    if (cz0 - 5 > 6) for (let x = cx0 + 4; x + 6 < cx1 - 3; x += 14) {
      const z = cz0 - 4 + ((x >> 2) % 2);
      T.box(x + 1, 0, z + 1, x + 2, 3, z + 2, BM.STEEL_DARK); T.box(x, 3, z, x + 3, 4, z + 3, BM.TRIM);
      T.box(x + 4, 0, z, x + 6, 2, z + 3, BM.WOOD);
    }
    E.vox(C, T, 0, yB, 0);
    L.roofKit && L.roofKit(E, C, tl + 1, tf + 1, W - tr - 1, D - tb - 1, yT, R, { style: 'office', floors: n, avoid: [] });
  }
  A.registerMid('modern_infill', (E, C, W, D, spec, R) => infill(E, C, W, D, spec, R), { zones: ['mid', 'core'], minW: 8, maxW: 30, minFloors: 6, maxFloors: 14 });

  // ================================================================================================ mid-century office
  const NAMES = ['ATLAS', 'UNION', 'MERIDIAN', 'PACIFIC', 'FIDELITY', 'SECURITY', 'MUTUAL', 'GENERAL', 'STANDARD', 'CONTINENTAL',
    'EQUITABLE', 'HARBOR', 'LINCOLN', 'NATIONAL', 'CENTURY', 'SUMMIT', 'PIONEER', 'TRANSAMERICA', 'BANK', 'INSURANCE'];
  function midcentury(E, C, W, D, spec, R) {
    const party = spec.party || {};
    const n = clamp(spec.floors, 6, 12), seed = spec.seed;
    const style = pick(R, ['curtain', 'ribbon', 'fins', 'ribbon', 'curtain']);
    const S = {
      seed, span: pick(R, [BM.GLASS_BLUE, BM.GLASS_GREEN, BM.AWNING_BLUE, BM.SHUTTER_GREEN, BM.PAINT_BLUE, BM.AWNING_GREEN]),
      frame: R() < 0.8 ? BM.METAL : BM.BRONZE, band: pick(R, [BM.WHITE_CONCRETE, BM.LIMESTONE, BM.PRECAST, BM.TRIM]),
      end: pick(R, [BM.LIMESTONE, BM.BRICK_BROWN, BM.GRANITE_DARK, BM.BUFF, BM.WHITE_CONCRETE, BM.GRANITE_PINK]),
      col: pick(R, [BM.WHITE_CONCRETE, BM.TRIM, BM.GRANITE_DARK, BM.STEEL_DARK, BM.LIMESTONE]),
      pave: pick(R, [BM.BUFF, BM.LIMESTONE, BM.BUFF]), tint: pick(R, [undefined, 'dark', 'green', 'blue', undefined]),
      pitch: pick(R, [4, 5, 5, 6]), solidEnds: R() < 0.55, lit: 0.3
    };
    const gH = 22, rec = 10 + Math.floor(R() * 6), nb = n - 1, hb = nb * FH + 4, yR = gH + hb;
    const gl = party.l ? 0 : 8, gr = party.r ? 0 : 8;
    const spanH = style === 'ribbon' ? 6 : 5;
    function bodySkin(len, h, which) {
      const side = which >= 2;
      const F = new L.Relief(len, h, 3, side && S.solidEnds ? S.end : S.frame);
      if (side && S.solidEnds) {
        // stone end wall: big panels with joints, and the ribbon wrapping 2 bays round each corner
        for (let f = 0; f < nb; ++f) F.rect(0, f * FH + FH - 1, len, f * FH + FH, BASE, H2(seed, 5, 5) < 0.5 ? S.end : BM.LIMESTONE_DARK);
        for (let u = 12; u < len - 12; u += 12) F.rect(u, 0, u + 1, nb * FH, 1, S.end);
        const wrap = 2 * S.pitch + 2;
        for (const [a, b] of [[0, wrap], [len - wrap, len]]) for (let f = 0; f < nb; ++f) {
          const v = f * FH;
          F.rect(a, v, b, v + spanH, BASE, S.span);
          F.rect(a, v + spanH, b, v + FH, 1, L.glassMat(seed, a + which, f, S.lit, S.tint));
          for (let u = a; u < b; u += S.pitch) F.rect(u, v + spanH, u + 1, v + FH, 2, S.frame);
        }
        F.rect(wrap, 0, wrap + 2, nb * FH, 3, S.end); F.rect(len - wrap - 2, 0, len - wrap, nb * FH, 3, S.end);
      } else {
        for (let f = 0; f < nb; ++f) {
          const v = f * FH;
          if (style === 'ribbon') {
            F.rect(0, v, len, v + spanH, 3, S.band);                                          // projecting band
            F.rect(1, v + 1, len - 1, v + spanH - 1, 2, S.span);                              // enamel panel inset in it
            for (let u = 0; u < len; u += 16) F.rect(u, v + 1, u + 1, v + spanH - 1, 3, S.band);
            F.rect(0, v + spanH, len, v + FH, 1, S.frame);
            for (let u = 0; u < len; u += S.pitch) F.rect(u + 1, v + spanH, Math.min(len, u + S.pitch), v + FH, 1, L.glassMat(seed, u + which * 53, f, S.lit, S.tint));
            for (let u = 0; u < len; u += S.pitch) F.rect(u, v + spanH, u + 1, v + FH, 2, S.frame);
            F.rect(0, v + FH - 1, len, v + FH, 2, S.frame);
          } else {
            F.rect(0, v, len, v + spanH, BASE, S.span);
            F.rect(0, v + spanH, len, v + spanH + 1, BASE, S.frame);
            for (let u = 0; u < len; u += S.pitch) F.rect(u, v + spanH + 1, Math.min(len, u + S.pitch), v + FH, 1, L.glassMat(seed, u + which * 53, f, S.lit, S.tint));
          }
        }
        if (style === 'curtain') for (let u = 0; u < len; u += S.pitch) F.rect(u, 0, u + 1, nb * FH, 3, S.frame);
        if (style === 'fins') {
          for (let f = 0; f < nb; ++f) for (let u = 0; u < len; u += S.pitch) F.rect(u, f * FH + spanH, u + 1, f * FH + FH, 2, S.frame);
          for (let u = 0; u < len; u += 3 * S.pitch) F.rect(u, 0, u + 1, nb * FH, 5, S.band);
        }
        F.rect(0, 0, 2, nb * FH, 3, S.frame); F.rect(len - 2, 0, len, nb * FH, 3, S.frame);
      }
      // fascia band at the top
      F.rect(0, nb * FH, len, h, 3, side && S.solidEnds ? S.end : S.band);
      F.rect(0, nb * FH, len, nb * FH + 1, 4, S.frame);
      F.rect(0, h - 1, len, h, 4, S.frame);
      F.returns();
      return partyMat(F, S.end);
    }
    const doorsC = [];
    function lobbySkin(len, h, which) {
      const F = new L.Relief(len, h, 2, S.col === BM.TRIM ? BM.STEEL_DARK : S.col);
      if (which === 0 || (which >= 2)) {
        F.rect(0, 1, len, h - 2, 1, L.glassMat(seed, which, 1, 0.65, 'dark'));
        for (let u = 0; u < len; u += 5) F.rect(u, 1, u + 1, h - 2, 2, S.frame);
        F.rect(0, 13, len, 14, 2, S.frame);
        if (which === 0) {
          const mid = len >> 1, fw = 12 + Math.floor(R() * 8), fs = R() < 0.5 ? 4 : len - 4 - fw;      // stone feature wall
          if (len > 40) { F.rect(fs, 1, fs + fw, h - 2, 2, pick(R, [BM.LIMESTONE, BM.GRANITE_PINK, BM.GRANITE_DARK, BM.BUFF])); for (let v = 4; v < h - 2; v += 5) F.rect(fs, v, fs + fw, v + 1, 1, BM.LIMESTONE_DARK); }
          const dc = clamp(mid + (fs < mid ? 6 : -6), 8, len - 8);
          doorsC.push(dc);
          for (const d of [dc - 5, dc + 1]) { F.rect(d, 1, d + 4, 11, 0, BM.GLASS_DARK_LIT); F.rect(d + 3, 4, d + 4, 7, 1, S.frame); }
          F.rect(dc - 6, 11, dc + 6, 13, 2, S.frame);
          if (spec.shops && len > 56) {                                                      // a shop at the far end
            const a = fs < mid ? len - 22 : 4, b = a + 18;
            F.rect(a, 1, b, 13, 1, L.glassMat(seed, a, 9, 0.75));
            F.rect(a, 14, b, 18, 2, BM.STEEL_DARK); F.rect(a + 3, 15, b - 3, 17, 3, H2(seed, 2, 2) < 0.5 ? BM.NEON : BM.LED);
          }
        }
      } else {
        for (let u = 6; u + 8 < len - 6; u += 20) { F.rect(u, 0, u + 8, 12, 1, BM.METAL); F.rect(u + 12, 6, u + 16, h - 4, 1, BM.LOUVER); }
      }
      F.rect(0, h - 2, len, h, 2, S.frame);
      return partyMat(F, S.end);
    }
    block(E, C, gl, rec, W - gr, D, 0, gH, lobbySkin, party);
    block(E, C, 0, 0, W, D, gH, hb, bodySkin, party);
    const bodyMask = L.rectMask(W, D, 0, 0, W, D, 0);
    L.soffit(E, bodyMask, W, D, gH, pick(R, [BM.TRIM, BM.WHITE_CONCRETE, BM.WOOD]));
    // plaza strip under the overhang: travertine paving, pilotis, planters, benches, downlights
    const P = VM(W, gH + 1, D + 1, 0, 0);
    for (let z = 0; z < rec; ++z) P.box(0, 0, z, W, 1, z + 1, (z >> 2) % 2 ? S.pave : BM.LIMESTONE_DARK === S.pave ? BM.LIMESTONE : (S.pave === BM.BUFF ? BM.LIMESTONE : BM.BUFF));
    if (gl) P.box(0, 0, rec, gl, 1, D, S.pave);
    if (gr) P.box(W - gr, 0, rec, W, 1, D, S.pave);
    const nc = Math.max(2, Math.round(W / (20 + R() * 8))), cols = [];
    for (let k = 0; k <= nc; ++k) cols.push(clamp(Math.round(k * W / nc), party.l ? 2 : 4, W - (party.r ? 2 : 4)));
    const colAt = (x, z) => { P.box(x - 2, 1, z - 1, x + 2, gH, z + 1, S.col); P.box(x - 1, 1, z - 2, x + 1, gH, z + 2, S.col); };
    for (const x of cols) colAt(x, 3);
    if (gl) for (let z = 3 + 24; z < D - 6; z += 24) colAt(3, z);
    if (gr) for (let z = 3 + 24; z < D - 6; z += 24) colAt(W - 4, z);
    for (let k = 0; k < nc; ++k) {
      const a = cols[k] + 4, b = cols[k + 1] - 4, mid = (a + b) >> 1;
      if (b - a < 10) continue;
      const nearDoor = doorsC.some((d) => Math.abs(d + gl - mid) < (b - a) / 2 + 4);
      if (!nearDoor && rec >= 10) {
        planter(P, a + 1, 1, rec - 7, b - 1, rec - 3, S.band === BM.TRIM ? BM.PRECAST : S.band, true);
        if (b - a > 16 && H2(seed, k, 3) < 0.6) tree(P, mid, 5, rec - 5, R, false);
      } else if (!nearDoor) P.box(a + 2, 1, rec - 4, b - 2, 3, rec - 2, BM.WOOD);
      for (let x = a + 2; x < b - 2; x += 8) P.box(x, gH - 1, (rec >> 1) - 1, x + 2, gH, (rec >> 1) + 1, BM.LED);
    }
    E.vox(C, P, 0, 0, 0);
    // mechanical penthouse with a louvred screen
    const pw = Math.round(W * (0.38 + R() * 0.18)), pdp = Math.round(D * (0.34 + R() * 0.16));
    const px0 = Math.round((W - pw) * (0.3 + R() * 0.4)), pz0 = Math.round(D * 0.42), px1 = px0 + pw, pz1 = Math.min(D - 6, pz0 + pdp);
    const pH = 18;
    const louver = (len, h) => {
      const F = new L.Relief(len, h, 1, BM.METAL);
      for (let v = 0; v < h - 2; ++v) F.rect(0, v, len, v + 1, v % 2 ? 3 : 2, v % 2 ? BM.LOUVER : BM.METAL);
      for (let u = 0; u < len; u += 8) F.rect(u, 0, u + 1, h - 2, 4, BM.STEEL_DARK);
      F.rect(len - 1, 0, len, h - 2, 4, BM.STEEL_DARK);
      F.rect(0, h - 2, len, h, 4, S.frame);
      F.returns();
      return F;
    };
    block(E, C, px0, pz0, px1, pz1, yR, pH, louver, {});
    const pm = L.rectMask(W, D, px0, pz0, px1, pz1, 0);
    L.roofMask(E, C, bodyMask, pm, W, D, yR, { parapet: 2, mat: S.frame, deck: BM.ROOF_TAR }, seed);
    L.roofMask(E, C, pm, null, W, D, yR + pH, { parapet: 1, mat: S.frame, deck: BM.ROOF_TAR, units: 2 }, seed + 9);
    // company name in letters standing on the front parapet
    let name = pick(R, NAMES);
    let s = textW(name, 2) <= W - 24 ? 2 : 1;
    for (let tries = 0; textW(name, s) > W - 12 && tries < 20; ++tries) name = NAMES[(NAMES.indexOf(name) + 1) % NAMES.length];
    if (textW(name, s) > W - 12) name = 'ATLAS';
    const tw = textW(name, s), lm = pick(R, [BM.LED, BM.LED, BM.DOOR_RED, BM.BRONZE, BM.TRIM, BM.NEON]);
    const sx = (W + tw) >> 1, Sg = VM(W, 7 * s + 6, 6, 0, 0);
    text(name, s, (i, j) => Sg.box(sx - 1 - i, 3 + j, 2, sx - i, 4 + j, 3, lm));
    Sg.box(sx - tw, 3, 3, sx, 4, 4, BM.STEEL_DARK);
    for (let x = sx - tw + 2; x < sx - 1; x += 10) Sg.box(x, 0, 3, x + 1, 3 + 4 * s, 4, BM.STEEL_DARK);
    E.vox(C, Sg, 0, yR, 0);
    L.roofKit && L.roofKit(E, C, 2, 2, W - 2, D - 2, yR, R, { style: 'office', floors: n, avoid: [[px0 - 2, pz0 - 2, px1 + 2, pz1 + 2], [0, 0, W, 16]] });
  }
  A.registerMid('midcentury_office', (E, C, W, D, spec, R) => midcentury(E, C, W, D, spec, R), { zones: ['mid', 'core'], minW: 16, maxW: 40, minFloors: 6, maxFloors: 12 });
})();
