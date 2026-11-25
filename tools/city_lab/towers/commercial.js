// Suburban commercial and transition plug-ins (phase 3), registered with CityArch.registerMid.
// zone 'commercial' - each building brings its own paved lot (asphalt with striped stalls, curbs, light poles,
// landscaped islands, parked cars):
//  - 'gas_station'      canopy on columns with a lit fascia and LED soffit, 2-4 pump islands, a convenience store with a
//                       glass front, ice chest, propane cage, air pump, a tall price pylon with LED digits, sometimes a
//                       car-wash bay;
//  - 'strip_mall'       a single-storey row of 3-8 shops (sometimes an anchor store) behind a covered walk (mansard or
//                       flat fascia) or with awnings, varied sign boards, a parking field and a tenant pylon;
//  - 'corner_store'     a pharmacy with a corner entrance tower and drive-thru, or a brick corner market with awnings,
//                       ATM, newspaper boxes, ice chest;
//  - 'diner_fastfood'   a 1950s stainless diner with a rooftop neon sign, or a fast-food restaurant with a wrap-around
//                       drive-thru lane, menu board, pickup window, pole sign and sometimes a playground;
//  - 'auto_bank'        an auto-repair shop with roll-up bay doors and tyre stacks, or a bank branch with a portico and
//                       drive-up ATM lanes under a canopy.
// zone 'transition' (between downtown and the houses):
//  - 'townhouses'       a row of 3-8 two / three-storey townhouses with stoops, front gardens, back yards, varied colours;
//  - 'garden_apartments' 2-3 storey walk-ups with balconies, stair entries, lawns, trees and a parking court;
//  - 'main_street_mixed' 2-3 storey shops-below / flats-above buildings with awnings, sign bands, cornices.
// Every building is one (or a few) VoxModels on the 25 cm grid, so all its parts are meshed as one solid: no coplanar
// faces. Ground surfaces (asphalt, lawn, paving) are a 1-voxel slab above the sidewalk; curbs and walks one more.
// Building-local voxels: x along the street, z into the lot (front at z = 0), y up. Seen from the street (looking +z)
// +x is to the viewer's LEFT, so front lettering is written from high x to low x (see face()).
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, H2 = L.H2;
  const VM = (w, h, d, ox, oz) => new (L.VoxModel())(w, h, d, ox, oz);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = L.pick;
  const ri = (R, a, b) => a + Math.floor(R() * (b - a + 1));
  // preview-only overrides (?party=l|r|b..., ?variant=0|1); the city worker has no query string
  const DEVQ = (typeof location !== 'undefined' && location.search) ? new URLSearchParams(location.search) : null;
  function prep(spec, lo, hi) {
    const s = Object.assign({}, spec);
    s.party = Object.assign({}, spec.party || {});
    if (DEVQ && DEVQ.get('party') !== null) { const p = DEVQ.get('party'); s.party = { l: p.includes('l'), r: p.includes('r'), b: p.includes('b') }; }
    s.floors = clamp(Math.round(s.floors || lo), lo, hi);
    s.variant = DEVQ && DEVQ.get('variant') !== null ? +DEVQ.get('variant') : -1;
    return s;
  }
  const variant = (spec, R, p) => (spec.variant >= 0 ? spec.variant === 0 : R() < p);
  // The suburb placer tags each lot with a use (spec.use: gas | strip | diner | store | mixed | apartments | townhouse)
  // while buildMidAny deals plug-ins by zone and width only: every type registered here first routes the lot to the
  // design that matches its use (stores and diner pads sometimes become an auto shop or a bank branch).
  const FN = {};
  function route(name, spec, R) {
    const u = spec && spec.use;
    if (!u) return FN[name];
    const h = H2(spec.seed | 0, 5, 77);
    const t = u === 'gas' ? 'gas_station' : u === 'strip' ? 'strip_mall' : u === 'diner' ? (h < 0.3 ? 'auto_bank' : 'diner_fastfood')
      : u === 'store' ? (h < 0.35 ? 'auto_bank' : 'corner_store') : u === 'mixed' ? 'main_street_mixed'
      : u === 'apartments' ? 'garden_apartments' : u === 'townhouse' ? 'townhouses' : name;
    return FN[t] || FN[name];
  }
  function reg(name, fn, opts) {
    FN[name] = fn;
    A.registerMid(name, (E, C, W, D, spec, R) => route(name, spec, R)(E, C, W, D, spec, R), opts);
  }

  // ------------------------------------------------------------------------------------------------ lettering
  const F5 = {
    A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
    C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
    E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
    G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
    I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
    K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
    M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001',
    O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
    Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
    S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
    U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
    W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
    Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
    0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
    2: '01110 10001 00001 00010 00100 01000 11111', 3: '11111 00010 00100 00010 00001 10001 01110',
    4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
    6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
    8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
    '&': '01100 10010 10100 01000 10101 10010 01101', '-': '00000 00000 00000 11111 00000 00000 00000'
  };
  const F3 = {
    A: '010 101 111 101 101', B: '110 101 110 101 110', C: '011 100 100 100 011', D: '110 101 101 101 110',
    E: '111 100 110 100 111', F: '111 100 110 100 100', G: '011 100 101 101 011', H: '101 101 111 101 101',
    I: '111 010 010 010 111', J: '001 001 001 101 010', K: '101 101 110 101 101', L: '100 100 100 100 111',
    M: '101 111 101 101 101', N: '110 101 101 101 101', O: '010 101 101 101 010', P: '110 101 110 100 100',
    Q: '010 101 101 110 011', R: '110 101 110 101 101', S: '011 100 010 001 110', T: '111 010 010 010 010',
    U: '101 101 101 101 111', V: '101 101 101 101 010', W: '101 101 111 111 101', X: '101 101 010 101 101',
    Y: '101 101 010 010 010', Z: '111 001 010 100 111',
    0: '111 101 101 101 111', 1: '010 110 010 010 111', 2: '110 001 010 100 111', 3: '110 001 010 001 110',
    4: '101 101 111 001 001', 5: '111 100 110 001 110', 6: '011 100 111 101 111', 7: '111 001 010 010 010',
    8: '111 101 111 101 111', 9: '111 101 111 001 110', '.': '0 0 0 0 1', '-': '000 000 111 000 000',
    '&': '010 101 010 101 011', '$': '011 110 010 011 110', "'": '1 1 0 0 0'
  };
  const glyphs = {};
  const glyph = (font, ch) => { const k = (font === F3 ? '3' : '5') + ch; if (!(k in glyphs)) glyphs[k] = font[ch] ? font[ch].split(' ') : null; return glyphs[k]; };
  function textW(str, small, s) {
    s = s || 1; const font = small ? F3 : F5; let w = 0;
    for (const ch of str) { const g = glyph(font, ch); w += ((g ? g[0].length : small ? 2 : 3) + 1) * s; }
    return Math.max(0, w - s);
  }
  // put(i, j) for every lit pixel: i = column from the reader's left, j = row from the bottom
  function text(str, small, s, put) {
    s = s || 1; const font = small ? F3 : F5, rows = small ? 5 : 7; let i0 = 0;
    for (const ch of str) {
      const g = glyph(font, ch);
      if (g) for (let r = 0; r < rows; ++r) for (let c = 0; c < g[r].length; ++c) if (g[r][c] === '1')
        for (let a = 0; a < s; ++a) for (let b = 0; b < s; ++b) put(i0 + c * s + a, (rows - 1 - r) * s + b);
      i0 += ((g ? g[0].length : small ? 2 : 3) + 1) * s;
    }
  }
  // the longest name from the list that fits in w voxels (or '')
  function fitName(R, list, w, small) { const f = list.filter((t) => textW(t, small) <= w); return f.length ? pick(R, f) : ''; }

  // ------------------------------------------------------------------------------------------------ faces
  // A wall face of the box [x0,x1) x [z0,z1) on side 'f' (faces -z, the street), 'b' (+z), 'l' (-x) or 'r' (+x).
  // u runs along the face from the viewer's left (front: from x1 down, back: from x0 up, left: from z0, right: from z1); d is the depth from the outer voxel layer (0 = the wall's own
  // outer layer, negative = projecting out of it). box(u0, y0, u1, y1, d0, d1, m).
  function face(M, x0, z0, x1, z1, side) {
    const F = { side, len: side === 'f' || side === 'b' ? x1 - x0 : z1 - z0 };
    F.box = (u0, y0, u1, y1, d0, d1, m) => {
      if (u1 <= u0 || y1 <= y0) return;
      if (side === 'f') M.box(x1 - u1, y0, z0 + d0, x1 - u0, y1, z0 + d1, m);
      else if (side === 'b') M.box(x0 + u0, y0, z1 - d1, x0 + u1, y1, z1 - d0, m);
      else if (side === 'l') M.box(x0 + d0, y0, z0 + u0, x0 + d1, y1, z0 + u1, m);
      else M.box(x1 - d1, y0, z1 - u1, x1 - d0, y1, z1 - u0, m);
    };
    // building x (or z on side faces) -> u
    F.u = (c) => (side === 'f' ? x1 - c : side === 'b' ? c - x0 : side === 'l' ? c - z0 : z1 - c);
    return F;
  }
  // lettering on a face, centred on u = uc, bottom row at y0, in the voxel layer d
  function say(F, str, uc, y0, d, m, small, s) {
    const tw = textW(str, small, s), u0 = Math.round(uc - tw / 2);
    text(str, small, s, (i, j) => F.box(u0 + i, y0 + j, u0 + i + 1, y0 + j + 1, d, d + 1, m));
    return tw;
  }
  // a window: the outer layer carved, glass one voxel in; o { sill, lintel, mull (vertical bar), frame }
  function win(F, u0, y0, u1, y1, g, o) {
    o = o || {};
    if (o.frame) F.box(u0 - 1, y0 - 1, u1 + 1, y1 + 1, -1, 0, o.frame);
    F.box(u0, y0, u1, y1, -1, 1, -1);
    F.box(u0, y0, u1, y1, 1, 2, g);
    if (o.mull) for (let u = u0 + o.mull; u < u1 - 1; u += o.mull) F.box(u, y0, u + 1, y1, 1, 2, o.mullM || BM.TRIM);
    if (o.bar) F.box(u0, o.bar, u1, o.bar + 1, 1, 2, o.mullM || BM.TRIM);
    if (o.sill) F.box(u0 - 1, y0 - 1, u1 + 1, y0, -1, 1, o.sill);
    if (o.lintel) F.box(u0 - 1, y1, u1 + 1, y1 + 1, o.lintelD || 0, 1, o.lintel);
  }
  function ring(M, x0, y0, z0, x1, y1, z1, m, t) {
    t = t || 1;
    M.box(x0, y0, z0, x1, y1, z0 + t, m); M.box(x0, y0, z1 - t, x1, y1, z1, m);
    M.box(x0, y0, z0, x0 + t, y1, z1, m); M.box(x1 - t, y0, z0, x1, y1, z1, m);
  }
  // flat roof inside a solid box whose top is yTop: parapet par voxels high, a coping course; returns the deck y
  function flatRoof(M, x0, z0, x1, z1, yTop, par, coping, deck) {
    M.box(x0 + 1, yTop - par, z0 + 1, x1 - 1, yTop, z1 - 1, -1);
    M.box(x0 + 1, yTop - par - 1, z0 + 1, x1 - 1, yTop - par, z1 - 1, deck || BM.ROOF_TAR);
    if (coping) ring(M, x0, yTop - 1, z0, x1, yTop, z1, coping);
    return yTop - par;
  }
  // stepped hip roof over [x0,x1) x [z0,z1) from y, eaves overhang ov; rises 1 per 2 voxels inward
  function hipRoof(M, x0, z0, x1, z1, y, ov, mat, fascia) {
    M.box(x0 - ov, y, z0 - ov, x1 + ov, y + 1, z1 + ov, fascia || BM.TRIM);
    for (let k = 0; ; ++k) {
      const a0 = x0 - ov + 1 + 2 * k, a1 = x1 + ov - 1 - 2 * k, b0 = z0 - ov + 1 + 2 * k, b1 = z1 + ov - 1 - 2 * k;
      if (a1 - a0 < 2 || b1 - b0 < 2) break;
      M.box(a0, y + 1 + k, b0, a1, y + 2 + k, b1, mat);
    }
  }

  // ------------------------------------------------------------------------------------------------ lot parts
  const ASPH = [BM.GRANITE_DARK, BM.ROOF_TAR, BM.GRANITE_DARK];
  const CAR_COL = [BM.TRIM, BM.METAL, BM.STEEL_DARK, BM.SHUTTER_BLACK, BM.DOOR_RED, BM.DOOR_NAVY, BM.AWNING_BLUE, BM.METAL,
    BM.TRIM, BM.PAINT_YELLOW, BM.SHUTTER_GREEN, BM.AWNING_RED, BM.PAINT_CREAM, BM.SIDING_GRAY, BM.SHUTTER_BLACK, BM.METAL,
    BM.PAINT_BLUE, BM.WHITE_CONCRETE, BM.COPPER, BM.TRIM_DARK];
  const carLen = (h) => { const k = Math.floor(h * 7919) % 6; return k === 2 ? 15 : k === 1 ? 17 : k === 5 ? 19 : 18; };
  // a parked car (7 wide); dir 0/1: length along z, nose to -z / +z; dir 2/3: along x, nose to -x / +x. h in [0,1)
  function car(M, x, y, z, dir, h) {
    const col = CAR_COL[Math.floor(h * 9973) % CAR_COL.length], kind = Math.floor(h * 7919) % 6;   // 0,3 sedan 1 suv 2 hatch 4 wagon 5 pickup
    const len = carLen(h);
    const put = (a0, y0, b0, a1, y1, b1, m) => {
      if (dir === 0) M.box(x + b0, y + y0, z + a0, x + b1, y + y1, z + a1, m);
      else if (dir === 1) M.box(x + b0, y + y0, z + len - a1, x + b1, y + y1, z + len - a0, m);
      else if (dir === 2) M.box(x + a0, y + y0, z + b0, x + a1, y + y1, z + b1, m);
      else M.box(x + len - a1, y + y0, z + b0, x + len - a0, y + y1, z + b1, m);
    };
    const bh = kind === 1 || kind === 5 ? 5 : 4;
    put(0, 1, 0, len, bh, 7, col);
    put(2, 0, 0, 5, 2, 7, BM.SHUTTER_BLACK); put(len - 5, 0, 0, len - 2, 2, 7, BM.SHUTTER_BLACK);
    put(0, 2, 0, 1, 3, 2, BM.TRIM); put(0, 2, 5, 1, 3, 7, BM.TRIM);                              // headlamps
    put(len - 1, 2, 0, len, 3, 2, BM.DOOR_RED); put(len - 1, 2, 5, len, 3, 7, BM.DOOR_RED);      // tail lamps
    if (kind === 5) {                                                                           // pickup: cab + bed
      put(5, bh, 1, 10, bh + 2, 6, BM.GLASS_DARK); put(6, bh + 2, 1, 10, bh + 3, 6, col);
      put(11, bh, 0, len, bh + 1, 1, col); put(11, bh, 6, len, bh + 1, 7, col); put(len - 1, bh, 0, len, bh + 1, 7, col);
      return;
    }
    const c0 = kind === 2 ? 4 : 5, c1 = kind === 0 || kind === 3 ? len - 5 : len - 2;
    put(c0, bh, 1, c1, bh + 2, 6, BM.GLASS_DARK);
    put(c0 + 1, bh + 2, 1, c1 - (kind === 0 || kind === 3 ? 1 : 0), bh + 3, 6, col);
  }
  function tree(M, x, y, z, R, s) {
    s = s || 1;
    const th = Math.round((7 + R() * 4) * s), r = Math.max(2, Math.round((2.6 + R() * 1.4) * s));
    const a = R() < 0.55 ? BM.LEAF : BM.LEAF_DARK, b = a === BM.LEAF ? BM.LEAF_DARK : BM.LEAF;
    M.box(x, y, z, x + 1, y + th, z + 1, BM.TRUNK);
    const cy = y + th - 1;
    M.box(x - r, cy, z - r + 1, x + r + 1, cy + 2 * r - 1, z + r, a);
    M.box(x - r + 1, cy - 1, z - r, x + r, cy + 2 * r, z + r + 1, a);
    M.box(x - r + 2, cy + 2 * r, z - r + 2, x + r - 1, cy + 2 * r + 1, z + r - 1, a);
    for (let k = 0; k < 5; ++k) {                                                                // tufts of the second green
      const sd = Math.floor(R() * 4), t = Math.floor(R() * (2 * r - 1)) - r + 1, yy = cy + Math.floor(R() * (2 * r - 2));
      const [dx, dz] = sd === 0 ? [-r - 1, t] : sd === 1 ? [r + 1, t] : sd === 2 ? [t, -r - 1] : [t, r + 1];
      M.box(x + dx, yy, z + dz, x + dx + 1, yy + 2, z + dz + 1, b);
    }
    return th + 2 * r;
  }
  function shrub(M, x, y, z, w, d, R) {
    const h = 1 + (R() < 0.5 ? 1 : 0), m = R() < 0.6 ? BM.LEAF_DARK : BM.LEAF;
    M.box(x, y, z, x + w, y + h, z + d, m);
    if (w > 2 && d > 2) M.box(x + 1, y + h, z + 1, x + w - 1, y + h + 1, z + d - 1, m);
  }
  // a raised planting bed (curb ring + grass / mulch) with shrubs and trees; o { fill, curb, shrubs (0..1), tree (spacing), big }
  function bed(M, x0, z0, x1, z1, R, o) {
    o = o || {};
    if (x1 - x0 < 2 || z1 - z0 < 2) return;
    M.box(x0, 0, z0, x1, 2, z1, o.curb || BM.CONCRETE);
    if (x1 - x0 < 3 || z1 - z0 < 3) return;
    M.box(x0 + 1, 1, z0 + 1, x1 - 1, 2, z1 - 1, o.fill || BM.GRASS);
    const sh = o.shrubs === undefined ? 0.5 : o.shrubs, iw = x1 - x0 - 2, id = z1 - z0 - 2;
    const along = iw >= id, Ln = along ? iw : id;
    if (sh > 0 && Math.min(iw, id) >= 2) for (let t = 1; t + 3 < Ln; t += 4) {
      if (R() > sh) continue;
      const w = Math.min(3, Math.min(iw, id)), off = Math.floor(R() * Math.max(1, (along ? id : iw) - w + 1));
      if (along) shrub(M, x0 + 1 + t, 2, z0 + 1 + off, 3, w, R); else shrub(M, x0 + 1 + off, 2, z0 + 1 + t, w, 3, R);
    }
    if (o.tree && Math.min(iw, id) >= 2) for (let t = Math.floor(o.tree / 2); t < Ln - 2; t += o.tree) {
      const tx = along ? x0 + 1 + t : (x0 + x1) >> 1, tz = along ? (z0 + z1) >> 1 : z0 + 1 + t;
      if (o.clear && o.clear.some((c) => tx > c[0] - 6 && tx < c[2] + 6 && tz > c[1] - 6 && tz < c[3] + 6)) continue;
      tree(M, tx, 2, tz, R, (o.big || 1) * (0.8 + R() * 0.4));
    }
  }
  // parking-lot light: concrete base, pole, shoebox heads (arms: list of 'x+', 'x-', 'z+', 'z-')
  function lamp(M, x, z, h, arms, y) {
    y = y || 1;
    M.box(x - 1, y, z - 1, x + 2, y + 2, z + 2, BM.CONCRETE);
    M.box(x, y + 2, z, x + 1, y + h, z + 1, BM.METAL);
    for (const a of arms) {
      const sx = a === 'x+' ? 1 : a === 'x-' ? -1 : 0, sz = a === 'z+' ? 1 : a === 'z-' ? -1 : 0;
      const hx = x + sx * 3, hz = z + sz * 3;
      M.box(Math.min(x, x + sx * 2), y + h - 1, Math.min(z, z + sz * 2), Math.max(x, x + sx * 2) + 1, y + h, Math.max(z, z + sz * 2) + 1, BM.METAL);
      M.box(hx - 1, y + h - 1, hz - 1, hx + 2, y + h, hz + 2, BM.STEEL_DARK);
      M.box(hx - 1, y + h - 2, hz - 1, hx + 2, y + h - 1, hz + 2, BM.LED);
    }
  }
  // paint (white inlay in the slab's top layer)
  function arrow(M, x, z, dir, m) {
    m = m || BM.TRIM;
    const P = (a, b, a1, b1) => {                                  // a along the arrow, b across, arrow points to +a
      if (dir === 'z+') M.box(x + b, 0, z + a, x + b1, 1, z + a1, m);
      else if (dir === 'z-') M.box(x + b, 0, z - a1 + 1, x + b1, 1, z - a + 1, m);
      else if (dir === 'x+') M.box(x + a, 0, z + b, x + a1, 1, z + b1, m);
      else M.box(x - a1 + 1, 0, z + b, x - a + 1, 1, z + b1, m);
    };
    P(0, 0, 6, 1); P(6, -2, 7, 3); P(7, -1, 8, 2); P(8, 0, 9, 1);
  }
  // a row of 10-voxel stalls over [x0,x1) x [z0,z0+19); nose +1: cars head to +z (head line at z0+19)
  function stallRow(M, x0, x1, z0, nose, R, occ, o) {
    o = o || {};
    const n = Math.floor((x1 - x0) / 10);
    if (n < 1) return 0;
    const xs = x0 + ((x1 - x0 - n * 10) >> 1), head = nose > 0 ? z0 + 19 : z0;
    for (let k = 0; k <= n; ++k) if (!(o.skip && o.skip(xs + k * 10 - 10, xs + k * 10) && o.skip(xs + k * 10 + 1, xs + k * 10 + 11))) M.box(xs + k * 10, 0, z0 + (nose > 0 ? 2 : 0), xs + k * 10 + 1, 1, z0 + 19 - (nose > 0 ? 0 : 2), BM.TRIM);
    for (let k = 0; k < n; ++k) {
      const sx = xs + k * 10, ada = o.ada && k === (o.adaRight ? n - 1 : 0);
      if (o.skip && o.skip(sx, sx + 10)) continue;
      if (ada) {                                                                                 // accessible stall
        M.box(sx + 1, 0, z0 + (nose > 0 ? 2 : 0), sx + 10, 1, z0 + 19 - (nose > 0 ? 0 : 2), BM.AWNING_BLUE);
        M.box(sx + 3, 0, z0 + 7, sx + 8, 1, z0 + 12, BM.TRIM); M.box(sx + 4, 0, z0 + 8, sx + 7, 1, z0 + 11, BM.AWNING_BLUE);
      }
      if (R() < occ) {
        const h = R(), len = carLen(h), off = 1 + Math.floor(R() * 2);
        const cz = nose > 0 ? head - 1 - len : head + 1;
        car(M, sx + off + 1, 1, cz, nose > 0 ? 1 : 0, h);
      } else if (!o.noStops) M.box(sx + 3, 1, nose > 0 ? head - 2 : head + 1, sx + 8, 2, nose > 0 ? head - 1 : head + 2, BM.CONCRETE);
    }
    return n;
  }
  // a parking field over [lx0,lx1) x [zA,zB): first row against zB (cars nose +z), then aisles and double rows toward
  // zA; landscaped islands with trees and light poles at the row ends and between bays of stalls
  function parkField(M, lx0, lx1, zA, zB, R, o) {
    o = o || {};
    const occ = o.occ === undefined ? 0.55 : o.occ, rows = [];
    let z = zB;
    if (z - zA >= 19) { rows.push({ z0: z - 19, nose: 1, dbl: false }); z -= 19; }
    while (z - zA >= 22 + 19) {
      z -= 22;
      if (z - zA >= 38 + 10) { rows.push({ z0: z - 38, nose: 0, dbl: true }); z -= 38; }
      else { rows.push({ z0: z - 19, nose: -1, dbl: false }); z -= 19; break; }
    }
    const isl = 10, bay = o.bay || 12;
    let lampK = 0, adaDone = !o.ada;
    for (const rw of rows) {
      const d = rw.dbl ? 38 : 19;
      const a0 = lx0 + (o.endIslands === false ? 0 : isl), a1 = lx1 - (o.endIslands === false ? 0 : isl);
      if (o.endIslands !== false && a1 - a0 >= 10) {
        bed(M, lx0, rw.z0, lx0 + isl, rw.z0 + d, R, { tree: 30, shrubs: 0.4 });
        bed(M, lx1 - isl, rw.z0, lx1, rw.z0 + d, R, { tree: 30, shrubs: 0.4 });
      }
      // bays of stalls separated by islands
      const n = Math.floor((a1 - a0) / 10), segs = [];
      let k = 0;
      while (k < n) {
        const m = Math.min(bay, n - k);
        segs.push([k, k + m]); k += m;
        if (k < n - 2 && rw.dbl) k += 1; else if (k < n - 2 && !rw.dbl && o.singleIslands) k += 1;
      }
      const xs = a0 + ((a1 - a0 - n * 10) >> 1);
      segs.forEach(([s0, s1], si) => {
        const x0 = xs + s0 * 10, x1 = xs + s1 * 10;
        if (rw.dbl) {
          stallRow(M, x0, x1, rw.z0 + 19, 0 - 1, R, occ, {});
          stallRow(M, x0, x1, rw.z0, 1, R, occ, {});
          if (si < segs.length - 1) {                                                         // island between bays
            const ix0 = x1, ix1 = xs + segs[si + 1][0] * 10;
            bed(M, ix0 + 1, rw.z0 + 1, ix1 - 1, rw.z0 + 37, R, { tree: 18, shrubs: 0.6 });
            if (lampK++ % 2 === 0) lamp(M, (ix0 + ix1) >> 1, rw.z0 + 19, 30, ['z+', 'z-'], 2);
          }
        } else {
          stallRow(M, x0, x1, rw.z0, rw.nose, R, occ, { ada: !adaDone, adaRight: o.adaRight, skip: rw.z0 <= zA + 1 ? o.skip : null });
          adaDone = true;
          if (si < segs.length - 1) bed(M, x1 + 1, rw.z0 + 1, xs + segs[si + 1][0] * 10 - 1, rw.z0 + 18, R, { tree: 18, shrubs: 0.5 });
        }
      });
      if (o.endIslands !== false && a1 - a0 >= 10 && rw.dbl) {
        lamp(M, lx0 + 5, rw.z0 + 19, 30, ['x+'], 2); lamp(M, lx1 - 6, rw.z0 + 19, 30, ['x-'], 2);
      }
    }
    // aisle arrows
    let za = zB - 19;
    for (const rw of rows.slice(1)) { const ac = rw.z0 + (rw.dbl ? 38 : 19); if (za - ac >= 20) { arrow(M, lx0 + 24, ac + 6, 'x-'); arrow(M, lx1 - 24, za - 8, 'x+'); } za = rw.z0; }
    return { rows, zFront: z };
  }
  // the front planting strip with driveway openings (list of [x0,x1]); returns the strip segments
  function frontStrip(M, x0, x1, depth, opens, R, o) {
    o = o || {};
    opens = opens.slice().sort((a, b) => a[0] - b[0]);
    const segs = []; let x = x0;
    for (const [a, b] of opens) { if (a - x >= 3) segs.push([x, a]); M.box(a, 0, 0, b, 1, depth, BM.CONCRETE); x = Math.max(x, b); }
    if (x1 - x >= 3) segs.push([x, x1]);
    for (const [a, b] of segs) bed(M, a, 0, b, depth, R, { tree: o.tree || 0, shrubs: o.shrubs === undefined ? 0.6 : o.shrubs, clear: o.clear });
    return segs;
  }
  function dumpsterPen(M, x, z, w, d, wallM, gateM) {          // 3 masonry walls + steel gates facing -z
    M.box(x, 0, z, x + w, 8, z + d, wallM);
    M.box(x + 1, 1, z + 1, x + w - 1, 8, z + d - 1, -1);
    M.box(x + 1, 1, z + 1, x + w - 1, 2, z + d - 1, BM.CONCRETE);
    M.box(x + 2, 2, z + 2, x + w - 2, 7, z + d - 2, BM.SHUTTER_GREEN);
    M.box(x + 1, 1, z, x + w - 1, 7, z + 1, gateM || BM.STEEL_DARK);
    M.box((x + x + w) >> 1, 1, z - 1, ((x + x + w) >> 1) + 1, 7, z, BM.METAL);
    M.box(x, 8, z, x + w, 9, z + d, BM.CONCRETE);
    M.box(x + 1, 8, z + 1, x + w - 1, 9, z + d - 1, -1);
  }
  function newsBoxes(M, x, y, z, n, dirZ) {                     // a row of newspaper boxes along x, facing -z (dirZ<0)
    const cols = [BM.AWNING_BLUE, BM.PAINT_YELLOW, BM.AWNING_RED, BM.TRIM, BM.AWNING_GREEN, BM.DOOR_NAVY];
    for (let k = 0; k < n; ++k) {
      const bx = x + k * 3, c = cols[(x + k * 7) % cols.length];
      M.box(bx, y, z, bx + 2, y + 4, z + 2, c);
      M.box(bx, y + 2, dirZ < 0 ? z - 1 : z + 2, bx + 2, y + 3, dirZ < 0 ? z : z + 3, BM.GLASS_DARK);
    }
  }
  function iceChest(M, x, y, z, w) {                             // ice merchandiser against a wall, front at z
    M.box(x, y, z, x + w, y + 5, z + 3, BM.TRIM);
    M.box(x, y + 3, z, x + w, y + 5, z + 1, BM.AWNING_BLUE);
    M.box(x + 1, y + 1, z - 1, x + w - 1, y + 3, z, BM.TRIM);
  }
  function bench(M, x, y, z, len, alongX) {
    if (alongX) { M.box(x, y, z, x + 1, y + 2, z + 2, BM.STEEL_DARK); M.box(x + len - 1, y, z, x + len, y + 2, z + 2, BM.STEEL_DARK); M.box(x, y + 2, z, x + len, y + 3, z + 2, BM.WOOD); M.box(x, y + 3, z + 1, x + len, y + 4, z + 2, BM.WOOD); }
    else { M.box(x, y, z, x + 2, y + 2, z + 1, BM.STEEL_DARK); M.box(x, y, z + len - 1, x + 2, y + 2, z + len, BM.STEEL_DARK); M.box(x, y + 2, z, x + 2, y + 3, z + len, BM.WOOD); }
  }
  function bin(M, x, y, z) { M.box(x, y, z, x + 2, y + 4, z + 2, BM.STEEL_DARK); M.box(x, y + 4, z, x + 2, y + 5, z + 2, BM.TRIM_DARK); }
  // a pylon sign standing in a planter: two legs and stacked panels, built by fill(F, y) on its front / back faces
  function pylon(M, x0, z0, w, dep, yBase, legM, baseM) {
    M.box(x0 - 1, 0, z0 - 1, x0 + w + 1, 4, z0 + dep + 1, baseM);
    M.box(x0, 4, z0 + 1, x0 + 3, yBase, z0 + dep - 1, legM); M.box(x0 + w - 3, 4, z0 + 1, x0 + w, yBase, z0 + dep - 1, legM);
  }

  const SIGN_BOARDS = [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.DOOR_NAVY, BM.SHUTTER_BLACK, BM.DOOR_RED, BM.SHUTTER_GREEN, BM.STEEL_DARK, BM.COPPER, BM.BRONZE];
  const LIGHT_BOARDS = [BM.TRIM, BM.PAINT_YELLOW, BM.PAINT_CREAM, BM.WHITE_CONCRETE];
  // a sign board's colour and the letter material that reads on it (lit letters on dark boards, neon on light)
  function signPair(R) {
    if (R() < 0.75) { const b = pick(R, SIGN_BOARDS); return { board: b, letter: R() < 0.8 ? BM.LED : BM.NEON }; }
    return { board: pick(R, LIGHT_BOARDS), letter: R() < 0.5 ? BM.NEON : BM.DOOR_RED };
  }

  // ================================================================================================ gas station
  const BRANDS = [
    { name: 'FUEL', c1: BM.AWNING_RED, c2: BM.TRIM, lm: BM.LED, edge: BM.LED, col: BM.TRIM },
    { name: 'GO GAS', c1: BM.AWNING_GREEN, c2: BM.PAINT_YELLOW, lm: BM.LED, edge: BM.PAINT_YELLOW, col: BM.AWNING_GREEN },
    { name: 'QUIK', c1: BM.DOOR_NAVY, c2: BM.DOOR_RED, lm: BM.LED, edge: BM.DOOR_RED, col: BM.TRIM },
    { name: 'STAR', c1: BM.AWNING_BLUE, c2: BM.PAINT_YELLOW, lm: BM.LED, edge: BM.LED, col: BM.AWNING_BLUE },
    { name: 'PETRO', c1: BM.TRIM, c2: BM.AWNING_RED, lm: BM.NEON, edge: BM.AWNING_RED, col: BM.METAL },
    { name: 'ZIP', c1: BM.PAINT_YELLOW, c2: BM.AWNING_RED, lm: BM.NEON, edge: BM.AWNING_RED, col: BM.TRIM },
    { name: 'MILES', c1: BM.SHUTTER_BLACK, c2: BM.PAINT_YELLOW, lm: BM.LED, edge: BM.PAINT_YELLOW, col: BM.STEEL_DARK },
    { name: 'METRO', c1: BM.SHUTTER_GREEN, c2: BM.TRIM, lm: BM.LED, edge: BM.LED, col: BM.TRIM }
  ];
  const MART = ['FOOD MART', 'MARKET', 'MART', 'SHOP', 'FOOD', 'SNACKS', 'COFFEE'];
  function gasStation(E, C, W, D, spec, R) {
    spec = prep(spec, 1, 1);
    const party = spec.party, seed = spec.seed, B = pick(R, BRANDS);
    const asph = pick(R, ASPH);
    const M = VM(W, 64, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, asph);
    const sl = party.l ? 0 : 6, sr = party.r ? 0 : 6, sb = party.b ? 0 : 6, fz = 7;
    const storeLeft = party.l !== party.r ? !!party.l : R() < 0.5;
    const sd = clamp(Math.round(D * 0.3), 28, 44), sz1 = D - sb, sz0 = sz1 - sd;
    const wash = W >= 136 && R() < 0.65, ww = 26;
    const sw = clamp(Math.round(W * 0.36), 40, 76);
    const sx0 = storeLeft ? sl : W - sr - sw, sx1 = sx0 + sw;
    const wx0 = storeLeft ? sx1 : sx0 - ww, wx1 = wx0 + ww;
    // canopy over the pump islands
    const rows = sz0 - 6 - fz - 6 >= 96 ? 2 : 1;
    const pitch = 32, il = 22;
    const nIs = rows === 2 ? 2 : clamp(Math.floor((W - sl - sr - 28) / pitch), 2, 4);
    const cw = nIs * pitch + 4, cdp = rows * 30 + 4;
    const cx0 = clamp(Math.round((W - cw) / 2 + (R() - 0.5) * 10), sl + 2, Math.max(sl + 2, W - sr - 2 - cw)), cx1 = cx0 + cw;
    const cz0 = fz + 6, cz1 = cz0 + cdp;
    // concrete pad under the canopy, apron to the store
    M.box(cx0 - 4, 0, cz0 - 3, cx1 + 4, 1, cz1 + 3, BM.CONCRETE);
    for (let x = cx0 - 4; x < cx1 + 4; x += 12) M.box(x, 0, cz0 - 3, x + 1, 1, cz1 + 3, BM.PRECAST);   // pad joints
    // ---- store
    const wallM = pick(R, [BM.BRICK_RED, BM.BUFF, BM.PRECAST, BM.TRIM, BM.BRICK_BROWN, BM.PAINT_CREAM]);
    const baseM = pick(R, [BM.GRANITE_DARK, BM.BRICK_DARK, BM.CONCRETE]), sh = 23;
    M.box(sx0, 0, sz0, sx1, sh, sz1, wallM);
    M.box(sx0, 0, sz0, sx1, 3, sz1, baseM);
    const deckY = flatRoof(M, sx0, sz0, sx1, sz1, sh, 2, BM.TRIM_DARK);
    M.box(sx0 - (party.l && storeLeft ? 0 : 0), 0, sz0 - 7, sx1, 2, sz0, BM.CONCRETE);                    // store walk (curb height)
    const Fs = face(M, sx0, sz0, sx1, sz1, 'f');
    const doorU = storeLeft ? sw - 18 : 10;
    for (let u = 3; u < sw - 3; u += 6) {
      const u1 = Math.min(sw - 3, u + 6);
      if (u1 > doorU - 1 && u < doorU + 9) continue;
      win(Fs, u, 3, u1 - 1, 13, L.glassMat(seed, u, 1, 0.85), {});
      Fs.box(u1 - 1, 3, u1, 13, 0, 1, BM.METAL);
    }
    win(Fs, doorU, 2, doorU + 8, 13, BM.GLASS_DARK_LIT, { frame: BM.METAL, mull: 4, mullM: BM.METAL, bar: 11 });
    // posters in the glass
    for (let k = 0; k < 3; ++k) { const u = 4 + Math.floor(R() * (sw - 12)); if (u > doorU - 5 && u < doorU + 10) continue; Fs.box(u, 6, u + 3, 10, 1, 2, pick(R, [BM.PAINT_YELLOW, BM.AWNING_RED, BM.TRIM])); }
    // flat canopy over the walk with downlights, sign band above
    M.box(sx0, 13, sz0 - 6, sx1, 14, sz0, BM.METAL);
    for (let x = sx0 + 4; x < sx1 - 4; x += 10) M.box(x, 13, sz0 - 4, x + 2, 14, sz0 - 2, BM.LED);
    Fs.box(1, 14, sw - 1, 22, 0, 1, B.c1);
    Fs.box(1, 14, sw - 1, 15, -1, 0, B.c2);
    { const nm = fitName(R, MART, sw - 10, false); if (nm) say(Fs, nm, sw / 2, 15, -1, B.lm, false); }
    // walk furniture: ice chest, propane cage, bin, news boxes, bollards
    const iceX = storeLeft ? sx0 + 3 : sx1 - 11;
    iceChest(M, iceX, 2, sz0 - 4, 8);
    { const px = storeLeft ? sx1 - 9 : sx0 + 3;
      M.box(px, 2, sz0 - 4, px + 6, 9, sz0 - 1, BM.METAL);
      for (let x = px; x < px + 6; x += 2) M.box(x, 2, sz0 - 5, x + 1, 9, sz0 - 4, BM.STEEL_DARK);
      M.box(px, 9, sz0 - 5, px + 6, 10, sz0 - 1, BM.STEEL_DARK);
      for (let x = px + 1; x < px + 5; x += 2) M.box(x, 3, sz0 - 4, x + 1, 7, sz0 - 3, BM.TRIM); }
    bin(M, doorU > sw / 2 ? sx1 - doorU + 2 : sx1 - doorU - 11, 2, sz0 - 3);
    for (let x = sx0 + 2; x < sx1 - 1; x += 8) M.box(x, 2, sz0 - 7, x + 1, 7, sz0 - 6, BM.PAINT_YELLOW);
    // side windows on a free side, back door
    for (const s of ['l', 'r']) {
      if ((s === 'l' && sx0 === 0) || (s === 'r' && sx1 === W)) continue;
      if (wash && ((s === 'r') === storeLeft)) continue;
      const F = face(M, sx0, sz0, sx1, sz1, s);
      for (let u = sd - 12; u > 6; u -= 14) win(F, u - 6, 5, u, 12, L.glassMat(seed, u, 7, 0.5), { sill: BM.TRIM_DARK });
    }
    { const F = face(M, sx0, sz0, sx1, sz1, 'b'); F.box(6, 1, 11, 10, -0, 1, BM.METAL); F.box(14, 1, 22, 9, 0, 1, BM.STEEL_DARK); F.box(7, 11, 10, 12, -1, 0, BM.LED); }
    // ---- car-wash bay
    if (wash) {
      const wm2 = pick(R, [wallM, BM.PRECAST, BM.CONCRETE]);
      M.box(wx0, 0, sz0, wx1, sh - 2, sz1, wm2);
      flatRoof(M, wx0, sz0, wx1, sz1, sh - 2, 1, BM.TRIM_DARK);
      const Fw = face(M, wx0, sz0, wx1, sz1, 'f');
      Fw.box(3, 1, ww - 3, 15, -1, 2, -1);
      for (let y = 1; y < 15; ++y) Fw.box(3, y, ww - 3, y + 1, 2, 3, y % 2 ? BM.METAL : BM.LOUVER);
      Fw.box(2, 15, ww - 2, 20, -1, 0, B.c2 === BM.TRIM ? B.c1 : B.c2);
      say(Fw, 'WASH', ww / 2, 15, -2, BM.LED, true);
      for (let z = sz0 - 30; z < sz0 - 7; z += 12) if (z > cz1 + 2) arrow(M, wx0 + 12, z, 'z+');
      M.box(wx0, 0, sz0 - 7, wx1, 1, sz0, BM.CONCRETE);
      // pay station
      M.box(wx0 + (storeLeft ? ww - 3 : 1), 1, sz0 - 14, wx0 + (storeLeft ? ww - 1 : 3), 9, sz0 - 12, BM.STEEL_DARK);
      M.box(wx0 + (storeLeft ? ww - 3 : 1), 6, sz0 - 15, wx0 + (storeLeft ? ww - 1 : 3), 8, sz0 - 14, BM.LED);
    }
    // ---- canopy
    const yU = 19, yT = 27;
    M.box(cx0 + 2, 22, cz0 + 2, cx1 - 2, yT, cz1 - 2, BM.TRIM);
    ring(M, cx0, yU, cz0, cx1, yT, cz1, B.c1, 2);
    M.box(cx0 + 2, yT - 1, cz0 + 2, cx1 - 2, yT, cz1 - 2, -1);
    M.box(cx0 + 2, yT - 2, cz0 + 2, cx1 - 2, yT - 1, cz1 - 2, BM.ROOF_TAR);
    for (const s of ['f', 'b', 'l', 'r']) {
      const F = face(M, cx0, cz0, cx1, cz1, s);
      F.box(0, yU, F.len, yU + 1, 0, 1, B.edge);
      F.box(0, yT - 1, F.len, yT, 0, 1, B.c2);
      if (s === 'f' || s === 'b') {
        const reps = F.len > 100 ? 2 : 1;
        for (let k = 0; k < reps; ++k) say(F, B.name, F.len * (k + 0.5) / reps, yU + 2, 0, B.lm, true);
      } else if (textW(B.name, true) < F.len - 6) say(F, B.name, F.len / 2, yU + 2, 0, B.lm, true);
    }
    for (let x = cx0 + 6; x < cx1 - 6; x += 9) for (let z = cz0 + 5; z < cz1 - 5; z += 8) M.box(x, 22, z, x + 3, 23, z + 3, BM.LED);
    // islands, columns, dispensers, cars at the pumps
    for (let r = 0; r < rows; ++r) for (let k = 0; k < nIs; ++k) {
      const ix0 = cx0 + 2 + k * pitch + ((pitch - il) >> 1), iz0 = cz0 + 2 + r * 30 + 12, cxm = ix0 + (il >> 1);
      M.box(ix0, 0, iz0, ix0 + il, 3, iz0 + 5, BM.CONCRETE);
      M.box(ix0, 0, iz0, ix0 + 2, 3, iz0 + 5, BM.PAINT_YELLOW); M.box(ix0 + il - 2, 0, iz0, ix0 + il, 3, iz0 + 5, BM.PAINT_YELLOW);
      M.box(ix0, 3, iz0 + 2, ix0 + 1, 8, iz0 + 3, BM.PAINT_YELLOW); M.box(ix0 + il - 1, 3, iz0 + 2, ix0 + il, 8, iz0 + 3, BM.PAINT_YELLOW);
      M.box(cxm - 1, 3, iz0 + 1, cxm + 1, 22, iz0 + 4, B.col);
      M.box(cxm - 2, 3, iz0 + 1, cxm + 2, 9, iz0 + 4, B.c1);
      for (const px of [ix0 + 3, ix0 + il - 7]) {
        M.box(px - 1, 3, iz0 + 1, px + 5, 4, iz0 + 4, BM.STEEL_DARK);
        M.box(px, 4, iz0 + 1, px + 4, 12, iz0 + 4, BM.TRIM);
        M.box(px, 10, iz0 + 1, px + 4, 12, iz0 + 4, B.c1);
        M.box(px + 1, 7, iz0 + 1, px + 3, 9, iz0 + 4, BM.GLASS_DARK);
        M.box(px + 1, 9, iz0 + 1, px + 3, 10, iz0 + 4, BM.LED);
        M.box(px - 1, 5, iz0 + 2, px, 9, iz0 + 3, BM.SHUTTER_BLACK); M.box(px + 4, 5, iz0 + 2, px + 5, 9, iz0 + 3, BM.SHUTTER_BLACK);
      }
      bin(M, cxm + 3, 3, iz0 + 2);
      for (const [cz, side] of [[iz0 - 9, 0], [iz0 + 7, 1]]) if (R() < 0.5) {
        const h = R(), len = carLen(h);
        car(M, ix0 + 1 + Math.floor(R() * Math.max(1, il - len - 1)), 1, cz, R() < 0.5 ? 2 : 3, h);
      }
    }
    // ---- front strip, driveways, side and back planting
    const pyS = storeLeft ? 'r' : 'l', pw = 17;
    const pyx0 = pyS === 'l' ? sl + 3 : W - sr - 3 - pw;
    let opens = [[cx0 + 2, cx0 + 28], [cx1 - 28, cx1 - 2]];
    opens = opens.map(([a, b]) => {
      if (b > pyx0 - 3 && a < pyx0 + pw + 3) { if (pyS === 'l') { const s = pyx0 + pw + 3 - a; a += s; b += s; } else { const s = b - (pyx0 - 3); a -= s; b -= s; } }
      return [Math.max(sl, a), Math.min(W - sr, b)];
    });
    if (opens[1][0] < opens[0][1] + 8) opens = [[opens[0][0], Math.max(opens[0][1], opens[1][1])]];
    frontStrip(M, sl, W - sr, fz, opens, R, { shrubs: 0.7, tree: 30, clear: [[pyx0, 0, pyx0 + pw, 6]] });
    if (!party.l) bed(M, 0, 0, sl, D, R, { tree: 34, shrubs: 0.4 });
    if (!party.r) bed(M, W - sr, 0, W, D, R, { tree: 34, shrubs: 0.4 });
    if (!party.b) bed(M, 0, D - sb, W, D, R, { tree: 40, shrubs: 0.5 });
    for (const [a, b] of opens) { arrow(M, a + 6, 2, 'z+'); arrow(M, b - 7, 10, 'z-'); }
    // stalls in front of the store if the lane allows
    const lane = sz0 - 7 - cz1;
    if (lane >= 19 + 14) stallRow(M, sx0 + 2, sx1 - 2, sz0 - 7 - 19, 1, R, 0.5, { ada: true, adaRight: !storeLeft, noStops: false });
    if (lane >= 14) { arrow(M, cx0 + 10, cz1 + 5, 'x-'); arrow(M, cx1 - 10, cz1 + 8, 'x+'); }
    // a row of stalls along the back on the canopy side
    { const bx0 = storeLeft ? (wash ? wx1 : sx1) + 4 : sl + 2, bx1 = storeLeft ? W - sr - 2 : (wash ? wx0 : sx0) - 4;
      if (bx1 - bx0 >= 30 && D - sb - 19 > cz1 + 16) stallRow(M, storeLeft ? bx0 : bx0 + 20, storeLeft ? bx1 - 20 : bx1, D - sb - 19, 1, R, 0.4, {}); }
    // dumpster pen and air pump on the canopy side at the back
    { const dx = storeLeft ? W - sr - 18 : sl + 2, dz = D - sb - 13;
      if (dx > wx1 + 2 || dx + 16 < wx0 - 2 || !wash) { if (lane >= 6 && dz > cz1 + 4 && (storeLeft ? dx > sx1 + (wash ? ww : 0) + 2 : dx + 16 < sx0 - (wash ? ww : 0) - 2)) dumpsterPen(M, dx, dz, 16, 12, wallM); }
      const ax = storeLeft ? W - sr - 4 : sl + 2, az = cz0 + 4;
      M.box(ax, 1, az, ax + 2, 9, az + 2, BM.DOOR_RED); M.box(ax, 6, az - 1, ax + 2, 8, az, BM.LED); M.box(ax - 1, 1, az - 1, ax + 3, 2, az + 3, BM.CONCRETE); }
    // light poles in the strips
    lamp(M, pyS === 'l' ? W - sr - 8 : sl + 8, 3, 28, ['z+'], 2);
    if (!party.l) lamp(M, 3, (cz1 + sz0) >> 1, 28, ['x+'], 2);
    if (!party.r) lamp(M, W - 4, (cz1 + sz0) >> 1, 28, ['x-'], 2);
    // ---- price pylon
    { const yB = 8, rowsP = R() < 0.5 ? 3 : 4, ph = 6, yb = yB + rowsP * ph;
      const bwid = Math.max(pw + 2, textW(B.name, true) + 6), bx0 = pyx0 + ((pw - bwid) >> 1);
      pylon(M, pyx0, 1, pw, 4, yB, B.col === BM.TRIM ? BM.STEEL_DARK : B.col, BM.BRICK_DARK);
      M.box(pyx0, yB, 2, pyx0 + pw, yb, 4, BM.SHUTTER_BLACK);
      M.box(bx0, yb, 1, bx0 + bwid, yb + 9, 5, B.c1);
      M.box(bx0, yb, 1, bx0 + bwid, yb + 1, 5, B.c2); M.box(bx0, yb + 8, 1, bx0 + bwid, yb + 9, 5, B.c2);
      const dig = R() < 0.5 ? BM.LED : BM.NEON, base = 2.89 + R() * 1.2;
      const chips = [BM.AWNING_GREEN, BM.AWNING_BLUE, BM.DOOR_RED, BM.PAINT_YELLOW];
      for (const s of ['f', 'b']) {
        const F = face(M, pyx0, 2, pyx0 + pw, 4, s), Fb = face(M, bx0, 1, bx0 + bwid, 5, s);
        say(Fb, B.name, bwid / 2, yb + 2, 0, B.lm, true);
        for (let k = 0; k < rowsP; ++k) {
          const y = yB + (rowsP - 1 - k) * ph;
          F.box(0, y, pw, y + 1, 0, 1, BM.METAL);
          F.box(1, y + 2, 2, y + 5, 0, 1, chips[k]);
          const p = (base + k * 0.3 + (k === 3 ? 0.4 : 0)).toFixed(2);
          say(F, p.slice(0, 4), 9.5, y + 1, 0, dig, true);
          F.box(pw - 1, y + 4, pw, y + 6, 0, 1, dig);                                     // the 9/10
        }
      }
    }
    E.vox(C, M, 0, 0, 0);
    L.roofKit && L.roofKit(E, C, sx0 + 1, sz0 + 1, sx1 - 1, sz1 - 1, deckY, R, { style: 'industrial', floors: 1, avoid: [] });
  }
  reg('gas_station', gasStation, { zones: ['commercial'], minW: 24, maxW: 52, minFloors: 1, maxFloors: 3 });

  // ================================================================================================ strip mall
  const SHOPS = ['PIZZA', 'NAILS', 'DONUTS', 'LIQUOR', 'CLEANERS', 'TAX', 'PHO', 'TACOS', 'SUBS', 'BARBER', 'VIDEO', 'CELL',
    'DENTAL', 'YOGA', 'PETS', 'LAUNDRY', 'BAGELS', 'THAI', 'SUSHI', 'BOOKS', 'GYM', 'DOLLAR', 'MATTRESS', 'TANNING', 'KARATE',
    'BAKERY', 'DELI', 'FLORIST', 'SHOES', 'BEAUTY', 'TOYS', 'HOBBY', 'GAMES', 'PAWN', 'LOANS', 'CAFE', 'WINGS', 'CHINA',
    'OPTICAL', 'VET', 'SALON', 'PRINT', 'MUSIC', 'TAILOR', 'CANDY', 'NOODLES', 'GRILL', 'TATTOO', 'COMICS', 'BIKES'];
  const ANCHORS = ['GROCERY', 'MARKET', 'HARDWARE', 'DISCOUNT', 'FOODS', 'SAVE MORE', 'DRUGS', 'FURNITURE', 'SUPERMARKET'];
  const PLAZAS = ['OAK PLAZA', 'MILL CENTER', 'PARK SQUARE', 'ELM COMMONS', 'WEST PLAZA', 'CROSSROADS', 'LAKE PLAZA', 'PINE CENTER', 'NORTHGATE', 'VILLAGE SQ'];
  function stripMall(E, C, W, D, spec, R) {
    spec = prep(spec, 1, 1);
    const party = spec.party, seed = spec.seed;
    const asph = pick(R, ASPH);
    const M = VM(W, 64, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, asph);
    const sl = party.l ? 0 : 6, sr = party.r ? 0 : 6, sb = party.b ? 0 : (D >= 150 ? 18 : 6), fz = 7;
    const bd = clamp(Math.round(D * 0.38), 40, 64), bz1 = D - sb, bz0 = bz1 - bd, wd = 9, zW = bz0 - wd;
    const bx0 = sl, bx1 = W - sr, bw = bx1 - bx0;
    const style = pick(R, ['mansard', 'flat', 'awning', 'flat', 'mansard', 'awning']);
    const wallM = pick(R, [BM.BUFF, BM.BRICK_RED, BM.PAINT_CREAM, BM.TRIM, BM.BRICK_BROWN, BM.PRECAST, BM.PAINT_SALMON, BM.PAINT_SAGE]);
    const trimM = pick(R, [BM.TRIM, BM.TRIM_DARK, BM.BRONZE, BM.STEEL_DARK]);
    const colM = pick(R, [BM.BRICK_RED, BM.TRIM, BM.BRICK_DARK, wallM, BM.PRECAST]);
    const shingle = pick(R, [BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.COPPER]);
    const bh = 22;
    // shop layout (in x), with an anchor on wide rows
    const shops = [];
    let a0 = bx0, a1 = bx1, anchor = null;
    if (bw >= 200 && R() < 0.65) {
      const aw = clamp(Math.round(bw * 0.3), 64, 100), left = R() < 0.5;
      anchor = left ? { x0: bx1 - aw, x1: bx1 } : { x0: bx0, x1: bx0 + aw };          // "left" as seen from the street = high x
      if (left) a1 = bx1 - aw; else a0 = bx0 + aw;
    }
    { const rem = a1 - a0; let n = clamp(Math.round(rem / (26 + R() * 14)), 3, 8);
      while (n > 3 && rem / n < 22) --n;
      const wts = []; for (let k = 0; k < n; ++k) wts.push(0.7 + R() * 0.6);
      const tot = wts.reduce((s, v) => s + v, 0); let x = a0, acc = 0;
      const used = new Set();
      for (let k = 0; k < n; ++k) {
        acc += wts[k]; const xe = k === n - 1 ? a1 : a0 + Math.round(rem * acc / tot);
        const sp = signPair(R);
        let nm = ''; for (let t = 0; t < 6 && (!nm || used.has(nm)); ++t) nm = fitName(R, SHOPS, xe - x - 8, true);
        used.add(nm);
        shops.push({ x0: x, x1: xe, name: nm, board: sp.board, letter: sp.letter, aw: pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.DOOR_NAVY, BM.PAINT_YELLOW]), stripe: R() < 0.4, vacant: R() < 0.08 });
        x = xe;
      }
    }
    // shell, roof
    M.box(bx0, 0, bz0, bx1, bh, bz1, wallM);
    M.box(bx0, 0, bz0, bx1, 2, bz1, pick(R, [BM.GRANITE_DARK, BM.BRICK_DARK, BM.CONCRETE]));
    const deckY = flatRoof(M, bx0, bz0, bx1, bz1, bh, 2, trimM);
    // walk
    M.box(bx0, 0, zW, bx1, 2, bz0, BM.CONCRETE);
    for (let x = bx0 + 8; x < bx1; x += 8) M.box(x, 1, zW, x + 1, 2, bz0, BM.PRECAST);
    const Ff = face(M, bx0, bz0, bx1, bz1, 'f');
    const U = (x) => Ff.u(x);
    // storefronts
    for (const s of shops) {
      const u0 = U(s.x1), u1 = U(s.x0), w = u1 - u0;
      const doorAtL = H2(seed, s.x0, 3) < 0.5, du = doorAtL ? u0 + 3 : u1 - 9;
      for (let u = u0 + 2; u < u1 - 2; u += 6) {
        const ue = Math.min(u1 - 2, u + 6);
        if (ue > du - 1 && u < du + 7) continue;
        win(Ff, u, 3, ue - 1, 14, s.vacant ? BM.GLASS_DARK : L.glassMat(seed, u, 2, 0.85), {});
        Ff.box(ue - 1, 3, ue, 14, 0, 1, trimM);
      }
      win(Ff, du, 2, du + 6, 14, s.vacant ? BM.GLASS_DARK : BM.GLASS_DARK_LIT, { frame: trimM, bar: 11, mullM: trimM });
      Ff.box(u0, 2, u0 + 2, bh - 3, -1, 0, colM);                                               // pier between shops
      if (!s.vacant) for (let k = 0; k < 2; ++k) { const u = u0 + 3 + Math.floor(H2(seed, s.x0, k) * Math.max(1, w - 8)); if (u > du - 4 && u < du + 8) continue; Ff.box(u, 5 + k * 3, u + 3, 8 + k * 3, 1, 2, pick(R, [BM.PAINT_YELLOW, BM.AWNING_RED, BM.TRIM, BM.NEON])); }
      if (!s.vacant && H2(seed, s.x0, 9) < 0.4) Ff.box(doorAtL ? u1 - 7 : u0 + 3, 10, doorAtL ? u1 - 3 : u0 + 7, 12, 1, 2, BM.NEON);   // OPEN sign
    }
    if (!party.l) Ff.box(bw - 2, 2, bw, bh - 3, -1, 0, colM);
    // the walk cover and signs
    const signY = style === 'awning' ? 15 : 19;
    if (style === 'mansard') {
      M.box(bx0, 16, zW, bx1, 18, bz0, BM.TRIM);
      M.box(bx0, 17, zW - 1, bx1, 18, bz0, trimM);
      for (let k = 0; k < 8; ++k) M.box(bx0, 18 + k, zW - 1 + k, bx1, 19 + k, bz0 + 1, shingle);
      M.box(bx0, 18, zW + 7, bx1, 25, bz0 + 1, shingle);
    } else if (style === 'flat') {
      M.box(bx0, 16, zW, bx1, 18, bz0, BM.TRIM);
      M.box(bx0, 16, zW - 1, bx1, 27, zW + 2, wallM);
      M.box(bx0, 26, zW - 2, bx1, 27, zW + 2, trimM);
      M.box(bx0, 16, zW - 2, bx1, 17, zW + 2, trimM);
      M.box(bx0, 18, zW + 2, bx1, 27, bz0 + 1, wallM);
      M.box(bx0 + 1, 26, zW + 2, bx1 - 1, 27, bz0 + 1, -1);
    }
    if (style !== 'awning') {
      for (const s of shops.concat([{ x0: bx0 }, { x0: bx1 - 2 }])) {
        const cx = s.x0 === bx0 ? bx0 : s.x0 - 1;
        if (cx + 2 > bx1) continue;
        M.box(Math.max(bx0, cx), 2, zW, Math.min(bx1, cx + 2), 16, zW + 2, colM);
        M.box(Math.max(bx0, cx), 2, zW, Math.min(bx1, cx + 2), 4, zW + 2, BM.CONCRETE);
      }
      for (const s of shops) for (let x = s.x0 + 6; x < s.x1 - 4; x += 12) M.box(x, 16, zW + 3, x + 2, 17, zW + 5, BM.LED);
    }
    for (const s of shops) {
      if (s.vacant) continue;
      const sw = s.x1 - s.x0;
      if (style === 'awning') {
        const ax0 = s.x0 + 2, ax1 = s.x1 - 2;
        const am = (x) => (s.stripe && ((x - ax0) >> 1) % 2 ? BM.TRIM : s.aw);
        for (let x = ax0; x < ax1; ++x) {
          M.box(x, 14, bz0 - 1, x + 1, 15, bz0, am(x)); M.box(x, 13, bz0 - 3, x + 1, 14, bz0 - 1, am(x));
          M.box(x, 12, bz0 - 5, x + 1, 13, bz0 - 3, am(x)); M.box(x, 10, bz0 - 6, x + 1, 12, bz0 - 5, am(x));
        }
        const bx = Math.round(sw * 0.15), F = face(M, s.x0 + bx, bz0 - 1, s.x1 - bx, bz0, 'f');
        if (F.len >= 10) { F.box(0, signY, F.len, signY + 6, 0, 1, s.board); if (s.name) say(F, s.name, F.len / 2, signY, 0 - 1, s.letter, true); }
      } else if (style === 'mansard') {
        const bx = Math.max(2, Math.round(sw * 0.12)), F = face(M, s.x0 + bx, zW - 2, s.x1 - bx, zW + 5, 'f');
        M.box(s.x0 + bx, 19, zW - 2, s.x1 - bx, 26, zW + 5, s.board);
        if (s.name) say(F, s.name, F.len / 2, 20, 0, s.letter, true);
      } else {
        const bx = Math.max(2, Math.round(sw * 0.15)), F = face(M, s.x0 + bx, zW - 3, s.x1 - bx, zW - 1, 'f');
        if (H2(seed, s.x0, 11) < 0.5) { M.box(s.x0 + bx, 19, zW - 3, s.x1 - bx, 25, zW - 1, s.board); if (s.name) say(F, s.name, F.len / 2, 19, 0, s.letter, true); }
        else if (s.name) { const F2 = face(M, s.x0, zW - 2, s.x1, zW - 1, 'f'); say(F2, s.name, F2.len / 2, 19, 0, s.letter === BM.DOOR_RED ? BM.NEON : s.letter, true); }
      }
    }
    // anchor store: taller block, its own glass entrance and big lettering
    if (anchor) {
      const ah = 32, aw = anchor.x1 - anchor.x0, am = pick(R, [BM.PRECAST, BM.BUFF, BM.BRICK_BROWN, BM.WHITE_CONCRETE]);
      M.box(anchor.x0, 0, bz0 - 2, anchor.x1, ah, bz1, am);
      M.box(anchor.x0, 0, bz0 - 2, anchor.x1, 2, bz1, BM.GRANITE_DARK);
      flatRoof(M, anchor.x0, bz0 - 2, anchor.x1, bz1, ah, 2, trimM);
      const Fa = face(M, anchor.x0, bz0 - 2, anchor.x1, bz1, 'f'), ec = aw >> 1;
      Fa.box(ec - 16, 2, ec + 16, 20, -1, 2, -1);
      Fa.box(ec - 16, 2, ec + 16, 20, 2, 3, BM.GLASS_DARK_LIT);
      for (let u = ec - 16; u <= ec + 16; u += 4) Fa.box(u, 2, u + 1, 20, 1, 2, BM.METAL);
      Fa.box(ec - 18, 20, ec + 18, 22, -2, 0, trimM);
      Fa.box(ec - 18, 2, ec - 16, 20, -1, 0, trimM); Fa.box(ec + 16, 2, ec + 18, 20, -1, 0, trimM);
      const nm = fitName(R, ANCHORS, aw - 10, false), lm = R() < 0.6 ? BM.LED : BM.NEON;
      if (nm) { Fa.box(4, 23, aw - 4, 31, -1, 0, pick(R, [BM.AWNING_RED, BM.DOOR_NAVY, BM.AWNING_GREEN, BM.SHUTTER_BLACK])); say(Fa, nm, aw / 2, 23, -2, lm, false); }
      // cart corrals
      L.roofKit && L.roofKit(E, C, anchor.x0 + 1, bz0 - 1, anchor.x1 - 1, bz1 - 1, ah - 2, R, { style: 'industrial', floors: 2, avoid: [] });
    }
    // free sides: wrap-around glass at the end shops; back: service doors
    for (const s of ['l', 'r']) {
      if (party[s]) continue;
      const F = face(M, bx0, bz0, bx1, bz1, s), fr = s === 'l' ? bd - 14 : 2;
      if (anchor && ((s === 'r' && anchor.x1 === bx1) || (s === 'l' && anchor.x0 === bx0))) continue;
      win(F, fr, 3, fr + 12, 14, L.glassMat(seed, 5, 2, 0.8), { mull: 6, mullM: trimM });
    }
    if (!party.b) {
      const F = face(M, bx0, bz0, bx1, bz1, 'b');
      for (const s of shops) {
        const u = F.u(s.x0) + 4;
        F.box(u, 1, u + 4, 10, 0, 1, BM.METAL); F.box(u + 1, 11, u + 3, 12, -1, 0, BM.LED);
      }
      if (sb >= 16) for (let x = bx0 + 20; x < bx1 - 20; x += 70) dumpsterPen(M, x, bz1 + 3, 16, 12, wallM);
    }
    // ---- parking field, front strip, pylon
    const lx0 = party.l ? 0 : 6, lx1 = W - (party.r ? 0 : 6);
    if (!party.l) bed(M, 0, 0, 6, D, R, { tree: 30, shrubs: 0.4 });
    if (!party.r) bed(M, W - 6, 0, W, D, R, { tree: 30, shrubs: 0.4 });
    if (!party.b) bed(M, 0, D - Math.min(sb, 6), W, D, R, { tree: 36, shrubs: 0.4 });
    const ow = 28, nOp = W > 200 ? 2 : 1;
    const opens = nOp === 2 ? [[Math.round(W * 0.25) - 14, Math.round(W * 0.25) + 14], [Math.round(W * 0.72) - 14, Math.round(W * 0.72) + 14]] : [[(W >> 1) - 14 + Math.round((R() - 0.5) * W * 0.3), 0]];
    if (nOp === 1) opens[0][1] = opens[0][0] + ow;
    parkField(M, lx0, lx1, fz, zW - 1, R, { occ: 0.5 + R() * 0.25, ada: true, skip: (a, b) => opens.some(([p, q]) => b > p - 1 && a < q + 1) });
    // tenant pylon at a front corner
    const pl = R() < 0.5, ten = shops.filter((s) => s.name && !s.vacant).slice(0, W > 160 ? 4 : 3), pname = fitName(R, PLAZAS, 40, true);
    const pw = clamp(Math.max(textW(pname, true) + 6, ...ten.map((s) => textW(s.name, true) + 4)), 24, 40), px0 = pl ? W - (party.r ? 2 : 4) - pw : (party.l ? 2 : 4);
    frontStrip(M, lx0, lx1, fz, opens, R, { tree: 26, shrubs: 0.5, clear: [[px0, 0, px0 + pw, 6]] });
    for (const [a, b] of opens) { arrow(M, a + 6, 1, 'z+'); arrow(M, b - 7, 12, 'z-'); }
    { const blocked = opens.some(([a, b]) => b > px0 - 2 && a < px0 + pw + 2);
      if (!blocked) {
        const ph = 6, yB = 8, yT = yB + ten.length * ph, name = pname;
        pylon(M, px0, 1, pw, 4, yB, trimM, colM);
        M.box(px0, yB, 2, px0 + pw, yT, 4, BM.SHUTTER_BLACK);
        M.box(px0 - 1, yT, 1, px0 + pw + 1, yT + 11, 5, colM);
        M.box(px0 - 2, yT + 11, 0, px0 + pw + 2, yT + 13, 6, trimM);
        if (anchor) M.box(px0 - 1, yT, 1, px0 + pw + 1, yT + 1, 5, trimM);
        for (const s2 of ['f', 'b']) {
          const F = face(M, px0, 2, px0 + pw, 4, s2), Ft = face(M, px0 - 1, 1, px0 + pw + 1, 5, s2);
          Ft.box(2, yT + 2, pw, yT + 9, 0, 1, BM.TRIM);
          if (name) say(Ft, name, (pw + 2) / 2, yT + 3, 0, BM.SHUTTER_BLACK, true);
          ten.forEach((s, k) => {
            const y = yT - (k + 1) * ph;
            F.box(1, y + 1, pw - 1, y + ph, 0, 1, s.board);
            say(F, s.name, pw / 2, y + 1, 0, s.letter, true);
          });
        }
      }
    }
    E.vox(C, M, 0, 0, 0);
    const avoid = anchor ? [[anchor.x0, bz0 - 2, anchor.x1, bz1]] : [];
    if (anchor) {
      const ra = anchor.x0 === bx0 ? [anchor.x1 + 1, bz0 + 1, bx1 - 1, bz1 - 1] : [bx0 + 1, bz0 + 1, anchor.x0 - 1, bz1 - 1];
      L.roofKit && L.roofKit(E, C, ra[0], ra[1], ra[2], ra[3], deckY, R, { style: 'industrial', floors: 1, avoid: [] });
    } else L.roofKit && L.roofKit(E, C, bx0 + 1, bz0 + 1 + (style === 'flat' ? 2 : 2), bx1 - 1, bz1 - 1, deckY, R, { style: 'industrial', floors: 1, avoid });
  }
  reg('strip_mall', stripMall, { zones: ['commercial'], minW: 30, maxW: 100, minFloors: 1, maxFloors: 3 });

  // a column of stalls along z over [x0,x0+19) x [z0,z1); noseX +1: cars head to +x
  function stallCol(M, x0, z0, z1, noseX, R, occ) {
    const n = Math.floor((z1 - z0) / 10);
    if (n < 1) return;
    const zs = z0 + ((z1 - z0 - n * 10) >> 1), head = noseX > 0 ? x0 + 19 : x0;
    for (let k = 0; k <= n; ++k) M.box(x0 + (noseX > 0 ? 2 : 0), 0, zs + k * 10, x0 + 19 - (noseX > 0 ? 0 : 2), 1, zs + k * 10 + 1, BM.TRIM);
    for (let k = 0; k < n; ++k) {
      const sz = zs + k * 10;
      if (R() < occ) { const h = R(), len = carLen(h); car(M, noseX > 0 ? head - 1 - len : head + 1, 1, sz + 2 + Math.floor(R() * 2), noseX > 0 ? 3 : 2, h); }
      else M.box(noseX > 0 ? head - 2 : head + 1, 1, sz + 3, noseX > 0 ? head - 1 : head + 2, 2, sz + 8, BM.CONCRETE);
    }
  }
  // a box building with a parapet roof: returns { F: faces, deck }
  function shed(M, x0, z0, x1, z1, h, wall, o) {
    o = o || {};
    M.box(x0, 0, z0, x1, h, z1, wall);
    if (o.base) M.box(x0, 0, z0, x1, o.baseH || 3, z1, o.base);
    const deck = flatRoof(M, x0, z0, x1, z1, h, o.par || 2, o.coping || BM.TRIM_DARK);
    const F = {}; for (const s of ['f', 'b', 'l', 'r']) F[s] = face(M, x0, z0, x1, z1, s);
    return { F, deck };
  }
  // a pole sign: one or two square poles and a lit box with the name on both faces
  function poleSign(M, x, z, yb, name, c1, c2, lm, R) {
    const tw = textW(name, true), bw = Math.max(16, tw + 6), bh = 11, x0 = x - (bw >> 1);
    M.box(x - 2, 0, z - 2, x + 2, 3, z + 2, BM.CONCRETE);
    M.box(x - 1, 3, z - 1, x + 1, yb, z + 1, BM.METAL);
    M.box(x0, yb, z - 2, x0 + bw, yb + bh, z + 2, c1);
    M.box(x0, yb, z - 2, x0 + bw, yb + 1, z + 2, c2); M.box(x0, yb + bh - 1, z - 2, x0 + bw, yb + bh, z + 2, c2);
    for (const s of ['f', 'b']) say(face(M, x0, z - 2, x0 + bw, z + 2, s), name, bw / 2, yb + 3, 0, lm, true);
  }

  // ================================================================================================ corner store / pharmacy
  const MARKETS = ['MARKET', 'DELI', 'GROCERY', 'LIQUOR', 'FOOD MART', 'MINI MART', 'BODEGA', 'CORNER STORE', 'GROCERIES', 'SUPER'];
  function cornerStore(E, C, W, D, spec, R) {
    spec = prep(spec, 1, 2);
    const party = spec.party, seed = spec.seed;
    const pharm = D >= 100 && W >= 80 && variant(spec, R, W >= 112 ? 0.6 : 0.3);
    const M = VM(W, 64, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, pick(R, ASPH));
    const sl = party.l ? 0 : 6, sr = party.r ? 0 : 6, sb = party.b ? 0 : 6, fz = 7;
    const hugL = party.l !== party.r ? !!party.l : R() < 0.5;            // the building stands against this side
    let roofArgs = null;
    const opA = [Math.round(hugL ? W * 0.62 : W * 0.38 - 26), 0]; opA[1] = opA[0] + 26;
    if (pharm) {
      const dt = W >= 96, lane = 14;
      const bw = clamp(W - sl - sr - (dt ? lane + 4 + 22 : 24), 52, 110), bd = clamp(Math.round(D * 0.5), 44, 72);
      const bz1 = D - sb, bz0 = bz1 - bd, bx0 = hugL ? sl : W - sr - bw, bx1 = bx0 + bw, h = 26;
      const wall = pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BUFF, BM.BRICK_DARK]);
      const bandC = pick(R, [BM.AWNING_RED, BM.AWNING_RED, BM.DOOR_NAVY, BM.TRIM, BM.SHUTTER_BLACK]), lm = bandC === BM.TRIM ? BM.NEON : BM.LED;
      const S = shed(M, bx0, bz0, bx1, bz1, h, wall, { base: BM.GRANITE_DARK, coping: BM.TRIM });
      // pilasters and clerestory windows on the front and the open side
      const openS = hugL ? 'r' : 'l';
      for (const s of ['f', openS]) {
        const F = S.F[s];
        for (let u = 4; u < F.len - 4; u += 12) F.box(u, 3, u + 2, h - 1, -1, 0, wall === BM.BUFF ? BM.BRICK_BROWN : BM.BUFF);
        for (let u = 7; u + 7 < F.len - 4; u += 12) win(F, u, 13, u + 6, 17, L.glassMat(seed, u, 3, 0.7, 'dark'), { sill: BM.TRIM });
      }
      // sign band on the front
      const Ff = S.F.f, word = pick(R, ['PHARMACY', 'DRUGS', 'PHARMACY', 'DRUG STORE', 'APOTHECARY']);
      Ff.box(2, 18, bw - 2, 25, -1, 0, bandC);
      { const tw0 = 26, span = bw - tw0, uc = hugL ? tw0 + span / 2 : span / 2;
        if (textW(word, false) < span - 8) say(Ff, word, uc, 18, -2, lm, false); else if (textW(word, true) < span - 6) say(Ff, word, uc, 19, -2, lm, true); }
      // corner entrance tower on the open front corner
      const tw = 26, tx0 = hugL ? bx1 - tw : bx0, tz0 = bz0 - 3, tz1 = bz0 + 22;
      M.box(tx0, 0, tz0, tx0 + tw, h + 10, tz1, wall);
      M.box(tx0, 0, tz0, tx0 + tw, 3, tz1, BM.GRANITE_DARK);
      flatRoof(M, tx0, tz0, tx0 + tw, tz1, h + 10, 2, BM.TRIM);
      const Tf = face(M, tx0, tz0, tx0 + tw, tz1, 'f'), Ts = face(M, tx0, tz0, tx0 + tw, tz1, openS);
      for (const F of [Tf, Ts]) {
        win(F, 3, 1, F.len - 3, 22, BM.GLASS_DARK_LIT, { mull: 5, mullM: BM.METAL, bar: 14 });
        F.box(2, 22, F.len - 2, 24, -3, 0, BM.METAL);
        F.box(3, 25, F.len - 3, 33, -1, 0, bandC);
        say(F, 'RX', F.len / 2, 26, -2, lm, false);
      }
      M.box(tx0 - (hugL ? 0 : 0), 0, tz0 - 6, tx0 + tw, 2, tz0, BM.CONCRETE);
      // walk along the front, bollards, news boxes, ATM kiosk
      M.box(bx0, 0, bz0 - 7, bx1, 2, bz0, BM.CONCRETE);
      for (let x = bx0 + 3; x < bx1 - 2; x += 8) M.box(x, 2, bz0 - 7, x + 1, 6, bz0 - 6, BM.STEEL_DARK);
      newsBoxes(M, hugL ? tx0 - 14 : tx0 + tw + 3, 2, bz0 - 4, 3, -1);
      { const ax = hugL ? bx0 + 6 : bx1 - 10; M.box(ax, 2, bz0 - 5, ax + 4, 11, bz0 - 2, BM.STEEL_DARK); M.box(ax, 9, bz0 - 6, ax + 4, 11, bz0 - 2, BM.AWNING_BLUE); M.box(ax + 1, 6, bz0 - 6, ax + 3, 8, bz0 - 5, BM.LED); }
      bench(M, hugL ? bx0 + 14 : bx1 - 26, 2, bz0 - 4, 10, true);
      // drive-thru: lane along the open side wall, window with a canopy, an island to the parking
      let px0 = hugL ? bx1 + 2 : sl, px1 = hugL ? W - sr : bx0 - 2;
      if (dt) {
        const lx0 = hugL ? bx1 : bx0 - lane, ix = hugL ? bx1 + lane : bx0 - lane - 4;
        bed(M, ix, bz0 + 4, ix + 4, D - sb, R, { shrubs: 0.5 });
        const wz = bz0 + Math.round(bd * 0.55);
        const Fs = S.F[openS]; const wu = Fs.u(wz);
        win(Fs, wu - 4, 5, wu + 4, 12, BM.GLASS_DARK_LIT, { frame: BM.METAL });
        Fs.box(wu - 2, 13, wu + 2, 16, -1, 0, bandC);
        M.box(hugL ? bx1 : bx0 - lane - 2, 15, wz - 10, hugL ? bx1 + lane + 2 : bx0, 17, wz + 10, BM.METAL);
        M.box(hugL ? bx1 : bx0 - lane - 2, 15, wz - 10, hugL ? bx1 + lane + 2 : bx0, 16, wz + 10, BM.TRIM);
        for (let z = wz - 7; z < wz + 8; z += 6) M.box(hugL ? bx1 + 3 : bx0 - 6, 15, z, hugL ? bx1 + 6 : bx0 - 3, 16, z + 2, BM.LED);
        M.box(hugL ? bx1 + lane + 1 : bx0 - lane - 2, 2, wz - 9, hugL ? bx1 + lane + 2 : bx0 - lane - 1, 15, wz - 8, BM.METAL);
        M.box(hugL ? bx1 + lane + 1 : bx0 - lane - 2, 2, wz + 8, hugL ? bx1 + lane + 2 : bx0 - lane - 1, 15, wz + 9, BM.METAL);
        M.box(lx0 + 3, 0, bz0 + 2, lx0 + lane - 3, 1, bz0 + 3, BM.TRIM);
        arrow(M, lx0 + 7, D - sb - 6, 'z-'); arrow(M, lx0 + 7, bz0 + 12, 'z-');
        if (R() < 0.6) car(M, lx0 + 4, 1, wz - 6, 0, R());
        px0 = hugL ? ix + 4 : sl; px1 = hugL ? W - sr : ix;
      }
      // parking: the side field and a row in front of the store
      if (px1 - px0 >= 22) {
        const nose = hugL ? -1 : 1;
        if (px1 - px0 >= 60) parkField(M, px0, px1, bz0 - 7, D - sb, R, { occ: 0.5, endIslands: false });
        else stallCol(M, hugL ? px1 - 19 : px0, bz0 + 2, D - sb - 2, hugL ? 1 : -1, R, 0.5);
      }
      parkField(M, sl, W - sr, fz, bz0 - 7, R, { occ: 0.55, ada: true, adaRight: !hugL, skip: (a, b) => b > opA[0] - 1 && a < opA[1] + 1 });
      roofArgs = [bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, S.deck, { style: 'industrial', floors: 1, avoid: [[tx0, tz0, tx0 + tw, tz1]] }];
    } else {
      // brick corner market at the sidewalk, flat above on two-storey ones, parking on the side
      const two = spec.floors >= 2 || R() < 0.45, h = two ? 34 : 20;
      const bw = clamp(Math.round((W - sl - sr) * (0.5 + R() * 0.15)), 44, 84), bd = clamp(Math.round(D * 0.45), 36, 60);
      const bx0 = hugL ? sl : W - sr - bw, bx1 = bx0 + bw, bz0 = 4, bz1 = bz0 + bd;
      const wall = pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.PAINT_CREAM, BM.BUFF]);
      const trim = pick(R, [BM.TRIM, BM.LIMESTONE, BM.TRIM_DARK]);
      const S = shed(M, bx0, bz0, bx1, bz1, h, wall, { base: BM.GRANITE_DARK, baseH: 2, coping: trim, par: 2 });
      M.box(sl, 0, 0, W - sr, 2, bz0, BM.CONCRETE);                                       // apron at the sidewalk
      // chamfered entrance on the open front corner
      const ox = hugL ? bx1 - 1 : bx0;
      for (let k = 0; k < 6; ++k) M.box(hugL ? bx1 - 6 + k : bx0, 1, bz0 + k, hugL ? bx1 : bx0 + 6 - k, 15, bz0 + k + 1, -1);
      for (let k = 0; k < 6; ++k) M.box(hugL ? bx1 - 6 + k - 1 : bx0 + 6 - k, 1, bz0 + k, hugL ? bx1 - 6 + k : bx0 + 6 - k + 1, 13, bz0 + k + 1, BM.GLASS_DARK_LIT);
      M.box(hugL ? bx1 - 7 : bx0, 13, bz0, hugL ? bx1 : bx0 + 7, 15, bz0 + 7, trim);
      M.box(hugL ? bx1 - 2 : bx0, 1, bz0, hugL ? bx1 : bx0 + 2, 15, bz0 + 2, wall);
      // shop windows with awnings, sign board
      const Ff = S.F.f, sp = signPair(R), nm = fitName(R, MARKETS, bw - 18, false) || fitName(R, MARKETS, bw - 12, true);
      const aw = pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.DOOR_NAVY]), striped = R() < 0.5;
      const u0 = hugL ? 9 : 3, u1 = hugL ? bw - 3 : bw - 9;
      for (let u = u0; u < u1; u += 8) {
        win(Ff, u, 3, Math.min(u1, u + 7), 12, L.glassMat(seed, u, 4, 0.85), { bar: 10, mullM: trim });
        if (H2(seed, u, 5) < 0.45) Ff.box(u + 1, 5, u + 4, 9, 1, 2, pick(R, [BM.PAINT_YELLOW, BM.AWNING_RED, BM.TRIM, BM.AWNING_GREEN]));
      }
      for (let u = u0; u < u1; ++u) { const m = striped && ((u >> 1) & 1) ? BM.TRIM : aw; Ff.box(u, 13, u + 1, 14, -1, 0, m); Ff.box(u, 12, u + 1, 13, -3, -1, m); Ff.box(u, 10, u + 1, 12, -4, -3, m); }
      Ff.box(u0, 15, u1, 21, -1, 0, sp.board);
      if (nm) say(Ff, nm, (u0 + u1) / 2, textW(nm, false) <= u1 - u0 - 6 ? 14 + 1 : 16, -2, sp.letter, textW(nm, false) > u1 - u0 - 6);
      if (two) {                                                                              // the flat upstairs
        for (const s of ['f', hugL ? 'r' : 'l']) {
          const F = S.F[s];
          if (s !== 'f' && party[hugL ? 'r' : 'l']) continue;
          for (let u = 5; u + 5 < F.len - 3; u += 10) win(F, u, 24, u + 5, 31, L.glassMat(seed, u, 9, 0.35), { sill: trim, lintel: trim, bar: 27 });
        }
        Ff.box(0, 22, bw, 23, -1, 0, trim);
      }
      // ATM in the wall, news boxes, ice chest, bin, bench
      const atU = hugL ? 4 : bw - 8; win(Ff, atU, 5, atU + 3, 10, BM.LED, { frame: BM.STEEL_DARK });
      Ff.box(atU - 1, 10, atU + 4, 12, -2, 0, BM.AWNING_BLUE);
      newsBoxes(M, hugL ? bx1 - 20 : bx0 + 11, 2, 1, 3, -1);
      iceChest(M, hugL ? bx0 + 3 : bx1 - 10, 2, 1, 7);
      bin(M, hugL ? bx1 - 9 : bx0 + 7, 2, 1);
      // side wall: mural / ghost sign or windows; side parking
      const sideS = hugL ? 'r' : 'l';
      if (!party[sideS]) {
        const F = S.F[sideS];
        F.box(8, 4, bd - 8, 16, -1, 0, pick(R, [BM.PAINT_YELLOW, BM.AWNING_GREEN, BM.PAINT_BLUE, BM.PAINT_SALMON, BM.TRIM]));
        say(F, pick(R, ['COLD BEER', 'ICE', 'LOTTO', 'SNACKS', 'OPEN 24']), bd / 2, 7, -2, BM.SHUTTER_BLACK, true);
        F.box(F.len - 6, 1, F.len - 2, 11, 0, 1, BM.STEEL_DARK);
      }
      const px0 = hugL ? bx1 + 2 : sl, px1 = hugL ? W - sr : bx0 - 2;
      if (px1 - px0 >= 8) {                                                                 // driveway to the side lot
        const a = px0 + Math.max(0, ((px1 - px0 - 26) >> 1)), b = Math.min(px1, a + 26);
        frontStrip(M, px0, px1, fz, b - a >= 20 ? [[a, b]] : [], R, { shrubs: 0.5 });
        if (b - a >= 20) { arrow(M, a + 5, 2, 'z+'); arrow(M, b - 6, 10, 'z-'); }
      }
      if (px1 - px0 >= 19) {
        const cols = px1 - px0 >= 60 ? 2 : 1;
        stallCol(M, hugL ? bx1 + 2 : px1 - 19, fz + 16, D - sb - 2, hugL ? -1 : 1, R, 0.55);
        if (cols === 2) stallCol(M, hugL ? px1 - 19 : px0, fz + 16, D - sb - 2, hugL ? 1 : -1, R, 0.45);
        lamp(M, (px0 + px1) >> 1, D - sb - 3, 26, ['z-'], 1);
      }
      // behind the store: parking or yard
      if (D - sb - bz1 >= 24) stallRow(M, bx0 + 2, bx1 - 2, D - sb - 19, 1, R, 0.4, {});
      if (D - sb - bz1 >= 12) dumpsterPen(M, hugL ? bx0 + 2 : bx1 - 18, bz1 + 2, 16, 10, wall);
      roofArgs = [bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, S.deck, { style: 'residential', floors: two ? 2 : 1, avoid: [] }];
    }
    // front strip, side and back beds
    if (pharm) frontStrip(M, sl, W - sr, fz, [opA], R, { tree: 30 });
    if (!party.l) bed(M, 0, pharm ? 0 : 12, sl, D, R, { tree: 30 });
    if (!party.r) bed(M, W - sr, pharm ? 0 : 12, W, D, R, { tree: 30 });
    if (!party.b) bed(M, 0, D - sb, W, D, R, { tree: 34 });
    E.vox(C, M, 0, 0, 0);
    if (roofArgs && L.roofKit) L.roofKit(E, C, roofArgs[0], roofArgs[1], roofArgs[2], roofArgs[3], roofArgs[4], R, roofArgs[5]);
  }
  reg('corner_store', cornerStore, { zones: ['commercial'], minW: 18, maxW: 44, minFloors: 1, maxFloors: 3 });

  // ================================================================================================ diner / fast food
  const FAST = [
    { name: 'BURGERS', c1: BM.AWNING_RED, c2: BM.PAINT_YELLOW, lm: BM.LED },
    { name: 'CHICKEN', c1: BM.DOOR_RED, c2: BM.TRIM, lm: BM.LED },
    { name: 'TACOS', c1: BM.DOOR_NAVY, c2: BM.NEON, lm: BM.LED },
    { name: 'PIZZA', c1: BM.AWNING_GREEN, c2: BM.AWNING_RED, lm: BM.LED },
    { name: 'SUBS', c1: BM.SHUTTER_GREEN, c2: BM.PAINT_YELLOW, lm: BM.LED },
    { name: 'DRIVE IN', c1: BM.AWNING_BLUE, c2: BM.AWNING_RED, lm: BM.LED },
    { name: 'FRIES', c1: BM.PAINT_YELLOW, c2: BM.AWNING_RED, lm: BM.NEON }
  ];
  function eatery(E, C, W, D, spec, R) {
    spec = prep(spec, 1, 1);
    const party = spec.party, seed = spec.seed;
    const M = VM(W, 64, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, pick(R, ASPH));
    const sl = party.l ? 0 : 6, sr = party.r ? 0 : 6, sb = party.b ? 0 : 6, fz = 7;
    const diner = variant(spec, R, 0.45) || W < 104;
    const roofs = [];
    if (diner) {
      const c = pick(R, [BM.AWNING_RED, BM.AWNING_BLUE, BM.SHUTTER_GREEN, BM.DOOR_RED, BM.DOOR_NAVY]);
      const dl = clamp(Math.round(W * 0.55), 52, 92), dd = 26;
      const dx0 = clamp(Math.round((W - dl) / 2 + (R() - 0.5) * 16), sl + 12, Math.max(sl + 12, W - sr - 12 - dl)), dx1 = dx0 + dl;
      const dz0 = Math.min(fz + 14 + 19 + 9, D - sb - dd - 16), dz1 = dz0 + dd;
      // body: ribbed stainless, enamel bands, ribbon windows, stepped crown, rounded corners
      M.box(dx0, 0, dz0, dx1, 15, dz1, BM.METAL);
      for (let y = 1; y < 4; ++y) ring(M, dx0, y, dz0, dx1, y + 1, dz1, y % 2 ? BM.TRIM : BM.METAL);
      ring(M, dx0, 4, dz0, dx1, 6, dz1, c);
      ring(M, dx0, 12, dz0, dx1, 13, dz1, c);
      for (const s of ['f', 'b', 'l', 'r']) {
        const F = face(M, dx0, dz0, dx1, dz1, s);
        if (s === 'b') { for (let u = 6; u < F.len - 6; u += 10) win(F, u, 6, u + 5, 11, L.glassMat(seed, u, 6, 0.8)); continue; }
        win(F, 3, 6, F.len - 3, 12, BM.GLASS_LIT, { mull: 4, mullM: BM.METAL });
      }
      M.box(dx0 + 1, 15, dz0 + 1, dx1 - 1, 16, dz1 - 1, c);
      M.box(dx0 + 2, 16, dz0 + 2, dx1 - 2, 17, dz1 - 2, BM.METAL);
      M.box(dx0 + 4, 17, dz0 + 6, dx1 - 4, 18, dz1 - 6, BM.TRIM);
      for (const [x, z, sx, sz] of [[dx0, dz0, 1, 1], [dx1 - 1, dz0, -1, 1], [dx0, dz1 - 1, 1, -1], [dx1 - 1, dz1 - 1, -1, -1]]) {
        M.box(x, 1, z, x + 1, 15, z + 1, -1); M.box(x + sx, 1, z, x + sx + 1, 15, z + 1, -1); M.box(x, 1, z + sz, x + 1, 15, z + sz + 1, -1);
      }
      // vestibule, steps, rooftop sign
      const ex0 = dx0 + ((dl - 14) >> 1) + (R() < 0.5 ? -10 : 10), ex1 = ex0 + 14;
      M.box(ex0, 0, dz0 - 5, ex1, 16, dz0, BM.METAL);
      M.box(ex0, 13, dz0 - 6, ex1, 16, dz0, c);
      M.box(ex0 + 1, 16, dz0 - 5, ex1 - 1, 17, dz0, BM.METAL);
      const Fv = face(M, ex0, dz0 - 5, ex1, dz0, 'f');
      win(Fv, 3, 1, 11, 12, BM.GLASS_DARK_LIT, { mull: 4, mullM: BM.METAL, frame: BM.TRIM });
      M.box(ex0 - 2, 0, dz0 - 9, ex1 + 2, 2, dz0 - 5, BM.CONCRETE);
      const word = pick(R, ['DINER', 'EATS', 'DINER', 'CAFE', 'GRILL']), sw = textW(word, false) + 8;
      const sx0 = Math.round((dx0 + dx1 - sw) / 2), sm = pick(R, [BM.TRIM, c, BM.SHUTTER_BLACK]);
      for (const px of [sx0 + 3, sx0 + sw - 5]) M.box(px, 16, dz0 + 3, px + 2, 22, dz0 + 5, BM.STEEL_DARK);
      M.box(sx0, 21, dz0 + 3, sx0 + sw, 32, dz0 + 5, sm);
      ring(M, sx0, 21, dz0 + 3, sx0 + sw, 32, dz0 + 5, BM.LED);
      for (const s of ['f', 'b']) say(face(M, sx0, dz0 + 3, sx0 + sw, dz0 + 5, s), word, sw / 2, 23, 0, sm === BM.TRIM ? BM.NEON : BM.NEON, false);
      // OPEN sign and a neon arrow on the front windows
      { const F = face(M, dx0, dz0, dx1, dz1, 'f'); F.box(5, 9, 12, 11, 1, 2, BM.NEON); }
      // kitchen annex
      const kx0 = dx0 + 6, kx1 = Math.min(dx1 - 6, kx0 + 40), kd = Math.min(16, D - sb - dz1 - 4);
      if (kd >= 8) {
        const K = shed(M, kx0, dz1, kx1, dz1 + kd, 14, BM.BRICK_BROWN, { coping: BM.TRIM_DARK, par: 1 });
        K.F.b.box(4, 1, 9, 10, 0, 1, BM.METAL);
        M.box(kx0 + 4, K.deck, dz1 + 3, kx0 + 10, K.deck + 5, dz1 + 9, BM.METAL);
        M.box(kx0 + 6, K.deck + 5, dz1 + 5, kx0 + 8, K.deck + 8, dz1 + 7, BM.STEEL_DARK);
      }
      // parking: a row facing the diner, columns on the sides
      stallRow(M, dx0 - 4, ex0 - 2, dz0 - 28, 1, R, 0.55, {}); stallRow(M, ex1 + 2, dx1 + 4, dz0 - 28, 1, R, 0.55, { ada: true });
      if (dx0 - sl >= 24) stallCol(M, sl + 1, dz0 - 4, D - sb - 2, -1, R, 0.5);
      if (W - sr - dx1 >= 24) stallCol(M, W - sr - 20, dz0 - 4, D - sb - 2, 1, R, 0.5);
      if (kd >= 8 && D - sb - dz1 - kd >= 0) dumpsterPen(M, kx1 + 4, D - sb - 12, 14, 10, BM.BRICK_BROWN);
      lamp(M, dx0 - 8, dz0 + 4, 26, ['x+'], 1); lamp(M, dx1 + 7, dz0 + 4, 26, ['x-'], 1);
      bench(M, ex1 + 3, 2, dz0 - 8, 8, true);
      const op = [[sl + 4, sl + 30], [W - sr - 30, W - sr - 4]];
      frontStrip(M, sl, W - sr, fz, op, R, { tree: 26 });
      arrow(M, sl + 10, 2, 'z+'); arrow(M, W - sr - 11, 10, 'z-');
    } else {
      // fast food with a wrap-around drive-thru lane
      const B = pick(R, FAST), lane = 14;
      const lr = party.l !== party.r ? !party.r : R() < 0.5;          // lane on the +x side (true) or -x
      const fb = clamp(Math.round(W * 0.42), 48, 72), fd = clamp(Math.round(D * 0.34), 36, 52);
      const bz1 = D - sb - lane - 4, bz0 = bz1 - fd;
      const bx0 = clamp(Math.round((W - fb) / 2 + (lr ? -12 : 12)), sl + lane + 4, W - sr - lane - 4 - fb), bx1 = bx0 + fb;
      const style = pick(R, ['mansard', 'modern', 'mansard']);
      const wall = pick(R, [BM.BRICK_RED, BM.BUFF, BM.PAINT_CREAM, BM.BRICK_BROWN, BM.STEEL_DARK, BM.WHITE_CONCRETE]);
      const S = shed(M, bx0, bz0, bx1, bz1, style === 'modern' ? 24 : 16, wall, { base: BM.GRANITE_DARK, coping: style === 'modern' ? B.c1 : wall, par: style === 'modern' ? 3 : 1 });
      let deck = S.deck;
      if (style === 'mansard') {
        for (let k = 0; k < 8; ++k) ring(M, bx0 - 2 + k, 15 + k, bz0 - 2 + k, bx1 + 2 - k, 16 + k, bz1 + 2 - k, B.c1, 2);
        ring(M, bx0 - 2, 14, bz0 - 2, bx1 + 2, 15, bz1 + 2, B.c2);
        M.box(bx0 + 7, 15, bz0 + 7, bx1 - 7, 22, bz1 - 7, BM.ROOF_TAR);
        deck = 22;
      } else {
        ring(M, bx0, 18, bz0, bx1, 22, bz1, B.c1);
        const tx = lr ? bx0 : bx1 - 14;                                                     // the accent tower
        M.box(tx, 0, bz0 - 2, tx + 14, 34, bz0 + 12, B.c1);
        say(face(M, tx, bz0 - 2, tx + 14, bz0 + 12, 'f'), B.name[0], 7, 24, 0, B.lm, false);
        M.box(tx + 1, 33, bz0 - 1, tx + 13, 34, bz0 + 11, -1);
      }
      // front: dining-room glass, doors, lettering
      const Ff = S.F.f;
      win(Ff, 4, 2, fb - 4, 12, L.glassMat(seed, 3, 3, 0.95), { mull: 6, mullM: BM.METAL });
      Ff.box(((fb - 8) >> 1), 2, ((fb + 8) >> 1), 12, 1, 2, BM.GLASS_DARK_LIT);
      if (style === 'modern') say(Ff, B.name, fb / 2, 14, -1, B.lm, textW(B.name, false) > fb - 10);
      else { const F2 = face(M, bx0 - 2, bz0 - 2, bx1 + 2, bz1 + 2, 'f'); say(F2, B.name, (fb + 4) / 2, 15, -1, B.lm === BM.LED ? BM.TRIM : B.lm, true); }
      M.box(bx0, 0, bz0 - 6, bx1, 2, bz0, BM.CONCRETE);
      // side windows on the parking side, the pickup window on the lane side
      const laneS = lr ? 'r' : 'l', otherS = lr ? 'l' : 'r';
      win(S.F[otherS], 4, 3, fd - 4, 12, L.glassMat(seed, 4, 3, 0.95), { mull: 6, mullM: BM.METAL });
      const Fl = S.F[laneS], pu = Fl.u(bz0 + 10);
      win(Fl, pu - 4, 4, pu + 4, 11, BM.GLASS_DARK_LIT, { frame: BM.METAL });
      Fl.box(pu - 6, 12, pu + 6, 13, -4, 0, B.c2);
      Fl.box(pu - 6, 13, pu + 6, 14, -4, 0, B.c1);
      const pu2 = Fl.u(bz0 + 26); win(Fl, pu2 - 3, 4, pu2 + 3, 11, BM.GLASS_DARK_LIT, { frame: BM.METAL });
      // the lane: back and lane-side, curbed islands, menu board, speaker, clearance bar
      const lx0 = lr ? bx1 : bx0 - lane;
      bed(M, sl, bz1 + lane, W - sr, bz1 + lane + 4, R, { shrubs: 0.5 });
      bed(M, lr ? bx1 + lane : bx0 - lane - 4, bz0 - 8, lr ? bx1 + lane + 4 : bx0 - lane, bz1 + lane, R, { shrubs: 0.6 });
      M.box(lr ? bx0 - 4 : bx0, 0, bz1 + 3, lr ? bx1 + 2 : bx1 + 4, 1, bz1 + 4, BM.PAINT_YELLOW);
      arrow(M, lr ? bx0 + 6 : bx1 - 7, bz1 + 5, lr ? 'x+' : 'x-'); arrow(M, lx0 + 7, bz0 + 30, 'z-'); arrow(M, lx0 + 7, bz0 + 2, 'z-');
      { const mx = lr ? bx0 + 20 : bx1 - 34, mz = bz1 + lane + 1;
        M.box(mx, 1, mz, mx + 14, 3, mz + 3, BM.BRICK_DARK);
        M.box(mx + 1, 3, mz + 1, mx + 13, 13, mz + 2, BM.STEEL_DARK);
        for (let x = mx + 2; x < mx + 12; x += 5) M.box(x, 4, mz, x + 4, 12, mz + 1, BM.LED);
        M.box(mx, 13, mz, mx + 14, 15, mz + 3, B.c1);
        M.box(lr ? mx - 8 : mx + 20, 1, mz, lr ? mx - 6 : mx + 22, 8, mz + 2, BM.STEEL_DARK);
        M.box(lr ? mx - 8 : mx + 20, 5, mz - 1, lr ? mx - 6 : mx + 22, 7, mz, BM.LED); }
      { const cx = lr ? bx0 - 10 : bx1 + 2;
        M.box(cx, 1, bz1 + 1, cx + 1, 17, bz1 + 2, BM.STEEL_DARK); M.box(cx + 8, 1, bz1 + 1, cx + 9, 17, bz1 + 2, BM.STEEL_DARK);
        for (let x = cx; x < cx + 9; ++x) M.box(x, 15, bz1, x + 1, 17, bz1 + 2, (x >> 1) & 1 ? BM.SHUTTER_BLACK : BM.PAINT_YELLOW); }
      if (R() < 0.7) car(M, lx0 + 4, 1, bz0 + 4, 0, R());
      if (R() < 0.6) car(M, lr ? bx0 + 12 : bx1 - 30, 1, bz1 + 4, lr ? 3 : 2, R());
      // playground (fenced, mulch, a tower with a slide) on the side away from the lane, if there is room
      const gx0 = lr ? sl + 2 : bx1 + 4, gx1 = lr ? bx0 - 4 : W - sr - 2;
      const pgz0 = bz0 - 2, pgz1 = Math.min(bz1, pgz0 + 34);
      if (gx1 - gx0 >= 28 && R() < 0.75) {
        M.box(gx0, 0, pgz0, gx1, 2, pgz1, BM.WOOD);
        ring(M, gx0, 2, pgz0, gx1, 6, pgz1, BM.TRIM);
        M.box(gx0 + 1, 2, pgz0 + 1, gx1 - 1, 6, pgz1 - 1, -1);
        for (let x = gx0 + 2; x < gx1 - 1; x += 2) { M.box(x, 3, pgz0, x + 1, 5, pgz0 + 1, -1); M.box(x, 3, pgz1 - 1, x + 1, 5, pgz1, -1); }
        const tx = gx0 + 4 + Math.floor(R() * Math.max(1, gx1 - gx0 - 22)), tz = pgz0 + 6;
        for (const [px, pz] of [[0, 0], [7, 0], [0, 7], [7, 7]]) M.box(tx + px, 2, tz + pz, tx + px + 1, 14, tz + pz + 1, BM.AWNING_RED);
        M.box(tx, 8, tz, tx + 8, 9, tz + 8, BM.PAINT_YELLOW);
        for (let k = 0; k < 5; ++k) M.box(tx - 1 + k, 14 + k, tz - 1 + k, tx + 9 - k, 15 + k, tz + 9 - k, BM.AWNING_BLUE);
        for (let k = 0; k < 8; ++k) M.box(tx + 2, 8 - k, tz + 8 + k * 1 + k, tx + 6, 9 - k, tz + 10 + 2 * k, BM.PAINT_YELLOW);
        M.box(tx + 2, 2, tz + 24, tx + 6, 3, tz + 26, BM.PAINT_YELLOW);
        for (let k = 0; k < 6; ++k) M.box(tx + 8, 2 + k, tz + 3, tx + 10 + (k >> 2), 3 + k, tz + 5, BM.AWNING_GREEN);
        const sx = tx + 14; if (sx + 10 < gx1) { M.box(sx, 2, tz + 2, sx + 1, 10, tz + 3, BM.STEEL_DARK); M.box(sx + 9, 2, tz + 2, sx + 10, 10, tz + 3, BM.STEEL_DARK); M.box(sx, 10, tz + 2, sx + 10, 11, tz + 3, BM.STEEL_DARK); M.box(sx + 2, 4, tz + 2, sx + 4, 5, tz + 3, BM.AWNING_RED); M.box(sx + 6, 4, tz + 2, sx + 8, 5, tz + 3, BM.AWNING_BLUE); }
        bench(M, gx1 - 12, 2, pgz1 - 4, 8, true);
      } else if (gx1 - gx0 >= 19) stallCol(M, lr ? gx1 - 19 : gx0, bz0 - 2, bz1 + lane - 2, lr ? 1 : -1, R, 0.5);
      { const rx0 = lr ? bx1 + lane + 4 : sl, rx1 = lr ? W - sr : bx0 - lane - 4;                 // beyond the lane island
        if (rx1 - rx0 >= 19) stallCol(M, lr ? rx1 - 19 : rx0, bz0 - 2, bz1 + lane - 2, lr ? 1 : -1, R, 0.5);
        if (rx1 - rx0 >= 44) stallCol(M, lr ? rx0 + 1 : rx1 - 20, bz0 - 2, bz1 + lane - 2, lr ? -1 : 1, R, 0.4); }
      // front parking, strip and pole sign
      const opA = lr ? [sl + 2, sl + 30] : [W - sr - 30, W - sr - 2], opB = [lx0 - 2, lx0 + lane + 6];
      parkField(M, sl, W - sr, fz, bz0 - 7, R, { occ: 0.5, ada: true, adaRight: lr, skip: (a, b) => (b > opA[0] - 1 && a < opA[1] + 1) || (b > opB[0] - 1 && a < opB[1] + 1) });
      const px = lr ? W - sr - 8 : sl + 8;
      frontStrip(M, sl, W - sr, fz, [opA, opB], R, { tree: 26, clear: [[px - 10, 0, px + 10, 6]] });
      poleSign(M, px, 3, 34, B.name, B.c1, B.c2, B.lm, R);
      roofs.push([bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, deck, style === 'mansard' ? [bx0 + 7, bz0 + 7, bx1 - 7, bz1 - 7] : null]);
    }
    if (!party.l) bed(M, 0, 0, sl, D, R, { tree: 32 });
    if (!party.r) bed(M, W - sr, 0, W, D, R, { tree: 32 });
    if (!party.b) bed(M, 0, D - sb, W, D, R, { tree: 34 });
    E.vox(C, M, 0, 0, 0);
    for (const r of roofs) if (L.roofKit) { if (r[5]) L.roofKit(E, C, r[5][0] + 1, r[5][1] + 1, r[5][2] - 1, r[5][3] - 1, r[4], R, { style: 'industrial', floors: 1, avoid: [] }); else L.roofKit(E, C, r[0], r[1], r[2], r[3], r[4], R, { style: 'industrial', floors: 1, avoid: [] }); }
  }
  reg('diner_fastfood', eatery, { zones: ['commercial'], minW: 22, maxW: 48, minFloors: 1, maxFloors: 3 });

  // ================================================================================================ auto shop / bank
  const AUTO = ['AUTO REPAIR', 'AUTO CARE', 'TIRES', 'BRAKES', 'LUBE', 'AUTO BODY', 'MUFFLERS', 'SERVICE', 'TIRE & AUTO', 'GARAGE'];
  const BANKS = ['BANK', 'SAVINGS', 'TRUST', 'CREDIT UNION', 'FIRST BANK', 'NATIONAL'];
  function autoBank(E, C, W, D, spec, R) {
    spec = prep(spec, 1, 2);
    const party = spec.party, seed = spec.seed;
    const M = VM(W, 64, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, pick(R, ASPH));
    const sl = party.l ? 0 : 6, sr = party.r ? 0 : 6, sb = party.b ? 0 : 6, fz = 7;
    const auto = W < 116 || D < 100 || variant(spec, R, 0.5);
    let roof = null;
    if (auto) {
      const bw = clamp(W - sl - sr - (W > 120 ? 24 : 0), 56, 150), bd = clamp(Math.round(D * 0.42), 40, 60);
      const hugL = party.l !== party.r ? !!party.l : R() < 0.5;
      const bx0 = hugL ? sl : W - sr - bw, bx1 = bx0 + bw, bz1 = D - sb, bz0 = bz1 - bd, h = 24;
      const wall = pick(R, [BM.PRECAST, BM.CONCRETE, BM.BRICK_RED, BM.WHITE_CONCRETE, BM.BUFF, BM.PAINT_BLUE]);
      const accent = pick(R, [BM.AWNING_RED, BM.AWNING_BLUE, BM.PAINT_YELLOW, BM.DOOR_NAVY, BM.AWNING_GREEN]);
      const S = shed(M, bx0, bz0, bx1, bz1, h, wall, { base: BM.CONCRETE, coping: accent, par: 2 });
      const Ff = S.F.f, ow = 24, nb = clamp(Math.floor((bw - ow - 4) / 20), 2, 5);
      const offU = hugL ? bw - ow : 0;                                                    // office (u range) toward the open side
      // office: glass, door, awning
      win(Ff, offU + 3, 2, offU + ow - 3, 13, L.glassMat(seed, 1, 8, 0.9), { mull: 5, mullM: BM.METAL });
      Ff.box(offU + (hugL ? 4 : ow - 10), 1, offU + (hugL ? 10 : ow - 4), 13, 1, 2, BM.GLASS_DARK_LIT);
      Ff.box(offU + 2, 14, offU + ow - 2, 15, -3, 0, accent);
      // bays: roll-up doors, some open with a car on a lift
      const bu0 = hugL ? 2 : ow + 2;
      for (let k = 0; k < nb; ++k) {
        const u = bu0 + k * 20, open = H2(seed, k, 21) < 0.45;
        Ff.box(u, 1, u + 2, h - 6, -1, 0, accent === BM.PAINT_YELLOW ? BM.STEEL_DARK : wall);
        if (open) {
          Ff.box(u + 3, 1, u + 19, 16, -1, 24, -1);
          Ff.box(u + 3, 0, u + 19, 1, 0, 24, BM.CONCRETE);
          Ff.box(u + 3, 1, u + 19, 16, 24, 25, BM.STEEL_DARK);
          Ff.box(u + 3, 15, u + 19, 16, 0, 1, BM.METAL);
          for (let t = 4; t < 22; t += 5) Ff.box(u + 4, 1, u + 7, 6, t, t + 2, pick(R, [BM.AWNING_RED, BM.DOOR_RED, BM.AWNING_BLUE]));
          Ff.box(u + 8, 15, u + 14, 16, 4, 20, BM.LED);
          // lift posts and a raised car
          Ff.box(u + 4, 1, u + 5, 12, 3, 4, BM.PAINT_YELLOW); Ff.box(u + 17, 1, u + 18, 12, 3, 4, BM.PAINT_YELLOW);
          const xr = S.F.f.side === 'f' ? bx1 - (u + 15) : 0;
          car(M, xr, 7, bz0 + 2, 0, H2(seed, k, 23));
        } else {
          Ff.box(u + 3, 1, u + 19, 16, -1, 1, -1);
          for (let y = 1; y < 16; ++y) Ff.box(u + 3, y, u + 19, y + 1, 1, 2, y % 2 ? BM.METAL : BM.LOUVER);
          Ff.box(u + 5, 8, u + 17, 9, 1, 2, BM.GLASS_DARK);
          Ff.box(u + 3, 16, u + 19, 17, -1, 0, BM.STEEL_DARK);
        }
      }
      // sign band
      const nm = fitName(R, AUTO, bw - 12, false), small = !nm;
      const nm2 = nm || fitName(R, AUTO, bw - 8, true);
      Ff.box(2, 17, bw - 2, h - 1, -1, 0, accent);
      if (nm2) say(Ff, nm2, bw / 2, 18, -2, accent === BM.PAINT_YELLOW ? BM.SHUTTER_BLACK : BM.LED, small);
      // apron in front of the bays, waiting cars, tyre stacks, oil drums
      M.box(bx0, 0, bz0 - 26, bx1, 1, bz0, BM.CONCRETE);
      for (let k = 0; k < nb; ++k) if (R() < 0.5) { const xr = bx1 - (bu0 + k * 20 + 15); car(M, xr, 1, bz0 - 22, R() < 0.5 ? 0 : 1, R()); }
      const tyre = (x, z, n) => { for (let i = 0; i < n; ++i) { M.box(x, 1 + i * 2, z, x + 4, 2 + i * 2, z + 4, BM.SHUTTER_BLACK); M.box(x + 1, 2 + i * 2, z + 1, x + 3, 3 + i * 2, z + 3, BM.TRIM_DARK); M.box(x, 2 + i * 2, z, x + 4, 3 + i * 2, z + 4, BM.SHUTTER_BLACK); M.box(x + 1, 2 + i * 2, z + 1, x + 3, 3 + i * 2, z + 3, BM.TRIM_DARK); } };
      const tx = hugL ? bx0 + 2 : bx1 - 12;
      tyre(tx, bz0 - 6, 3); tyre(tx + 5, bz0 - 6, 4); tyre(tx, bz0 - 11, 2);
      for (let k = 0; k < 3; ++k) M.box(hugL ? bx1 - 30 + k * 4 : bx0 + 22 + k * 4, 1, bz0 - 4, (hugL ? bx1 - 30 + k * 4 : bx0 + 22 + k * 4) + 3, 6, bz0 - 1, k === 1 ? BM.AWNING_BLUE : BM.AWNING_RED);
      // customer parking and the open side
      const px0 = hugL ? bx1 + 2 : sl, px1 = hugL ? W - sr : bx0 - 2;
      if (px1 - px0 >= 19) stallCol(M, hugL ? px1 - 19 : px0, bz0 - 4, D - sb - 2, hugL ? 1 : -1, R, 0.6);
      const opA = [(W >> 1) - 14, (W >> 1) + 14];
      parkField(M, sl, W - sr, fz, bz0 - 27, R, { occ: 0.5, endIslands: false, skip: (a, b) => b > opA[0] - 1 && a < opA[1] + 1 });
      frontStrip(M, sl, W - sr, fz, [[(W >> 1) - 14, (W >> 1) + 14]], R, { tree: 0 });
      const psx = hugL ? W - sr - 8 : sl + 8;
      if (psx > (W >> 1) + 22 || psx < (W >> 1) - 22) poleSign(M, psx, 3, 22, fitName(R, ['TIRES', 'BRAKES', 'LUBE', 'OIL', 'SMOG', 'ALIGN'], 20, true) || 'AUTO', accent, BM.TRIM, accent === BM.PAINT_YELLOW ? BM.NEON : BM.LED, R);
      roof = [bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, S.deck];
    } else {
      // bank branch: classical portico, drive-up lanes under a canopy
      const lanes = W >= 120 ? 3 : 2, lw = 16, dtw = lanes * lw + 2;
      const hugL = party.l !== party.r ? !!party.l : R() < 0.5;
      const bw = clamp(W - sl - sr - dtw - 26, 44, 84), bd = clamp(Math.round(D * 0.4), 40, 60);
      const bx0 = hugL ? sl + 2 : W - sr - 2 - bw, bx1 = bx0 + bw, bz1 = D - sb - 4, bz0 = bz1 - bd, h = 28;
      const stone = pick(R, [BM.LIMESTONE, BM.BRICK_RED, BM.BUFF, BM.BRICK_BROWN, BM.PRECAST]);
      const trim = stone === BM.LIMESTONE || stone === BM.BUFF || stone === BM.PRECAST ? BM.LIMESTONE_DARK : BM.LIMESTONE;
      const S = shed(M, bx0, bz0, bx1, bz1, h, stone, { base: BM.GRANITE_DARK, coping: trim, par: 2 });
      ring(M, bx0 - 1, h - 4, bz0 - 1, bx1 + 1, h - 2, bz1 + 1, trim);
      for (const s of ['f', 'l', 'r', 'b']) {
        const F = S.F[s];
        if ((s === 'l' && bx0 === 0) || (s === 'r' && bx1 === W)) continue;
        for (let u = 6; u + 6 < F.len - 4; u += 12) {
          if (s === 'f' && Math.abs(u + 3 - F.len / 2) < 16) continue;
          win(F, u, 4, u + 6, 18, L.glassMat(seed, u, 11, 0.4, 'dark'), { sill: trim, lintel: trim, bar: 14 });
        }
      }
      // portico: steps, columns, entablature with the name, pediment
      const pw = 30, pc = (bx0 + bx1) >> 1, p0 = pc - (pw >> 1), p1 = p0 + pw;
      M.box(p0 - 2, 0, bz0 - 12, p1 + 2, 2, bz0, trim);
      M.box(p0 - 4, 0, bz0 - 14, p1 + 4, 1, bz0 - 12, trim);
      for (let k = 0; k < 4; ++k) { const cx = p0 + 1 + Math.round(k * (pw - 4) / 3); M.box(cx, 2, bz0 - 10, cx + 2, 20, bz0 - 8, BM.TRIM); M.box(cx - 1, 2, bz0 - 11, cx + 3, 3, bz0 - 7, trim); M.box(cx - 1, 19, bz0 - 11, cx + 3, 20, bz0 - 7, trim); }
      M.box(p0 - 1, 20, bz0 - 12, p1 + 1, 26, bz0, trim);
      for (let k = 0; k < 7; ++k) M.box(p0 - 1 + 2 * k, 26 + k, bz0 - 12, p1 + 1 - 2 * k, 27 + k, bz0, trim);
      const Fp = face(M, p0 - 1, bz0 - 12, p1 + 1, bz0, 'f');
      const bn = fitName(R, BANKS, pw - 2, true) || 'BANK';
      say(Fp, bn, (pw + 2) / 2, 21, -1, BM.BRONZE, true);
      const Ff = S.F.f, cu = Ff.u(pc);
      win(Ff, cu - 6, 2, cu + 6, 16, BM.GLASS_DARK_LIT, { mull: 4, mullM: BM.BRONZE, bar: 12, frame: BM.BRONZE });
      for (const x of [p0 - 3, p1 + 2]) { M.box(x, 2, bz0 - 12, x + 1, 5, bz0 - 11, BM.LED); }
      // drive-up canopy on the open side
      const cx0 = hugL ? bx1 : bx0 - dtw, cx1 = cx0 + dtw, cz0 = bz0 + 4, cz1 = bz0 + 30;
      const accent = pick(R, [BM.DOOR_NAVY, BM.AWNING_GREEN, BM.AWNING_RED, BM.BRONZE]);
      M.box(cx0, 17, cz0, cx1 + (hugL ? 0 : 0), 21, cz1, accent);
      M.box(cx0 + 1, 17, cz0 + 1, cx1 - 1, 18, cz1 - 1, BM.TRIM);
      ring(M, cx0, 17, cz0, cx1, 18, cz1, BM.LED);
      M.box(cx0, 21, cz0, cx1, 23, cz1, accent);
      for (const s2 of ['f', 'b']) say(face(M, cx0, cz0, cx1, cz1, s2), 'ATM', dtw / 2, 18, 0, BM.LED, true);
      for (let k = 0; k < lanes; ++k) {
        const lx = hugL ? cx0 + 2 + k * lw : cx1 - 2 - (k + 1) * lw;
        const ix0 = hugL ? lx + lw - 4 : lx;
        M.box(ix0, 0, cz0 + 2, ix0 + 4, 3, cz1 - 2, BM.CONCRETE);
        M.box(ix0, 0, cz0 + 2, ix0 + 4, 3, cz0 + 4, BM.PAINT_YELLOW);
        M.box(ix0 + 1, 3, cz0 + 12, ix0 + 3, 11, cz0 + 15, BM.STEEL_DARK);
        M.box(hugL ? ix0 : ix0 + 3, 7, cz0 + 12, hugL ? ix0 + 1 : ix0 + 4, 9, cz0 + 15, BM.LED);
        M.box(ix0 + 1, 3, cz0 + 4, ix0 + 3, 17, cz0 + 6, accent);
        M.box(ix0 + 1, 3, cz1 - 6, ix0 + 3, 17, cz1 - 4, accent);
        const lc = hugL ? lx + 1 : lx + 5;
        arrow(M, lc + 3, cz1 + 10, 'z-');
        if (R() < 0.5) car(M, lc, 1, cz0 + 8, 0, R());
      }
      bed(M, hugL ? cx1 : cx0 - 6, cz0 - 2, hugL ? cx1 + 6 : cx0, D - sb, R, { shrubs: 0.5 });
      // parking in front, foundation planting
      bed(M, bx0, bz0 - 4, p0 - 4, bz0, R, { shrubs: 0.9 }); bed(M, p1 + 4, bz0 - 4, bx1, bz0, R, { shrubs: 0.9 });
      const opA = hugL ? [W - sr - 32, W - sr - 4] : [sl + 4, sl + 32];
      parkField(M, sl, W - sr, fz, bz0 - 15, R, { occ: 0.45, ada: true, adaRight: !hugL, skip: (a, b) => b > opA[0] - 1 && a < opA[1] + 1 });
      frontStrip(M, sl, W - sr, fz, [opA], R, { tree: 24 });
      // flag pole
      { const fx = hugL ? p0 - 10 : p1 + 9; M.box(fx - 1, 0, bz0 - 9, fx + 2, 2, bz0 - 6, trim); M.box(fx, 2, bz0 - 8, fx + 1, 40, bz0 - 7, BM.METAL); M.box(fx + 1, 32, bz0 - 8, fx + 8, 37, bz0 - 7, BM.AWNING_RED); M.box(fx + 1, 35, bz0 - 8, fx + 4, 37, bz0 - 7, BM.DOOR_NAVY); M.box(fx + 1, 33, bz0 - 8, fx + 8, 34, bz0 - 7, BM.TRIM); }
      roof = [bx0 + 1, bz0 + 1, bx1 - 1, bz1 - 1, S.deck];
    }
    if (!party.l) bed(M, 0, 0, sl, D, R, { tree: 30 });
    if (!party.r) bed(M, W - sr, 0, W, D, R, { tree: 30 });
    if (!party.b) bed(M, 0, D - sb, W, D, R, { tree: 34 });
    E.vox(C, M, 0, 0, 0);
    if (roof && L.roofKit) L.roofKit(E, C, roof[0], roof[1], roof[2], roof[3], roof[4], R, { style: auto ? 'industrial' : 'office', floors: 1, avoid: [] });
  }
  reg('auto_bank', autoBank, { zones: ['commercial'], minW: 22, maxW: 48, minFloors: 1, maxFloors: 3 });

  // ================================================================================================ townhouses
  const TH = 12;                                                    // residential storey (3 m)
  const BRICKS = [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BRICK_RED, BM.BUFF];
  const PAINTS = [BM.SIDING_BLUE, BM.SIDING_YELLOW, BM.SIDING_SAGE, BM.PAINT_CREAM, BM.PAINT_SALMON, BM.SIDING_WHITE, BM.PAINT_BLUE, BM.PAINT_SAGE, BM.SIDING_GRAY];
  const MODERNS = [BM.WHITE_CONCRETE, BM.STEEL_DARK, BM.WOOD, BM.SIDING_GRAY, BM.BRICK_DARK, BM.PRECAST];
  const DOORS = [BM.DOOR_RED, BM.DOOR_NAVY, BM.SHUTTER_GREEN, BM.SHUTTER_BLACK, BM.WOOD, BM.PAINT_YELLOW];
  // a list of n materials from pal, no two neighbours alike
  function colours(R, pal, n) { const out = []; for (let k = 0; k < n; ++k) { let m; do m = pick(R, pal); while (k && m === out[k - 1] && pal.length > 1); out.push(m); } return out; }
  function townhouses(E, C, W, D, spec, R) {
    spec = prep(spec, 2, 3);
    const party = spec.party, seed = spec.seed, fl = spec.floors;
    const fam = pick(R, ['brick', 'painted', 'modern', 'brick', 'painted']);
    const M = VM(W, 72, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, BM.GRASS);
    const gd = ri(R, 15, 21), ud = clamp(D - gd - 26, 34, 52), zb = gd + ud;
    let n = clamp(Math.round(W / (22 + R() * 8)), 3, 8); while (n > 3 && W / n < 19) --n;
    const xs = []; for (let k = 0; k <= n; ++k) xs.push(Math.round(k * W / n));
    const g0 = fam === 'modern' ? 2 : 4;
    const mats = colours(R, fam === 'brick' ? BRICKS : fam === 'painted' ? PAINTS : MODERNS, n);
    const trim = fam === 'modern' ? pick(R, [BM.STEEL_DARK, BM.TRIM_DARK, BM.METAL]) : pick(R, [BM.TRIM, BM.TRIM, BM.LIMESTONE, BM.PAINT_CREAM]);
    const stoopM = fam === 'brick' ? pick(R, [BM.LIMESTONE_DARK, BM.GRANITE_DARK, BM.LIMESTONE]) : pick(R, [BM.CONCRETE, BM.BRICK_RED, BM.LIMESTONE]);
    const baseM = fam === 'brick' ? stoopM : pick(R, [BM.CONCRETE, BM.BRICK_DARK, BM.GRANITE_DARK]);
    const bays = fam !== 'modern' && R() < 0.55, mansard = fam === 'painted' && fl >= 2 && R() < 0.5;
    const shingle = pick(R, [BM.SHINGLE_SLATE, BM.SHINGLE_GRAY, BM.SHINGLE_BROWN]);
    const fenceM = pick(R, [BM.STEEL_DARK, BM.SHUTTER_BLACK, BM.TRIM]);
    const back = D - zb;
    const roofs = [];
    for (let k = 0; k < n; ++k) {
      const x0 = xs[k], x1 = xs[k + 1], w = x1 - x0, wall = mats[k];
      const jog = fam === 'modern' ? (k % 2 ? 3 : 0) : 0, zf = gd + jog;
      const ufl = fam === 'modern' ? clamp(fl + (k % 3 === 1 ? (fl === 3 ? -1 : 1) : 0), 2, 3) : fl;
      const top = g0 + ufl * TH + 2;
      M.box(x0, 0, zf, x1, top, zb, wall);
      M.box(x0, 0, zf, x1, g0, zb, baseM);
      const F = face(M, x0, zf, x1, zb, 'f');
      const doorL = (k % 2 === 0) !== (H2(seed, 1, 1) < 0.5);
      const du = doorL ? 2 : w - 7, doorC = pick(R, DOORS);
      const glass = (u, f) => L.glassMat(seed, x0 + u, f, 0.32);
      // door with a transom and a surround
      F.box(du, g0, du + 5, g0 + 11, -1, 2, -1);
      F.box(du, g0, du + 5, g0 + 9, 2, 3, doorC);
      F.box(du, g0 + 9, du + 5, g0 + 11, 2, 3, glass(du, 0));
      F.box(du + 2, g0 + 4, du + 3, g0 + 5, 1, 2, BM.BRONZE);
      if (fam !== 'modern') { F.box(du - 1, g0, du, g0 + 12, -1, 0, trim); F.box(du + 5, g0, du + 6, g0 + 12, -1, 0, trim); F.box(du - 1, g0 + 11, du + 6, g0 + 13, -1, 0, trim); F.box(du - 2, g0 + 12, du + 7, g0 + 13, -2, 0, trim); }
      else { F.box(du - 1, g0 + 11, du + 6, g0 + 12, -4, 0, trim); }
      // windows (or a bay) on the rest of the front
      const wu0 = doorL ? 9 : 2, wu1 = doorL ? w - 2 : w - 9;
      const bay = bays && wu1 - wu0 >= 10;
      for (let f = 0; f < ufl; ++f) {
        const y = g0 + f * TH;
        if (mansard && f === ufl - 1) continue;
        if (bay && f < Math.min(2, ufl)) continue;
        const wsp = f === 0 ? [wu0, wu1] : [2, w - 2];
        const nw = Math.max(1, Math.round((wsp[1] - wsp[0]) / (fam === 'modern' ? 10 : 8)));
        for (let i = 0; i < nw; ++i) {
          const c = Math.round(wsp[0] + (wsp[1] - wsp[0]) * (i + 0.5) / nw), hw = fam === 'modern' ? 3 : 2;
          if (fam === 'modern') {
            const tall = f > 0 && H2(seed, k, f) < 0.5;
            win(F, c - hw, y + (tall ? 1 : 3), c + hw, y + 10, glass(c, f), { frame: trim, mull: 3, mullM: trim });
            if (tall) F.box(c - hw, y + 4, c + hw, y + 5, -1, 0, BM.METAL);
          } else {
            win(F, c - hw, y + 3, c + hw, y + 10, glass(c, f), { sill: trim, lintel: fam === 'brick' ? stoopM : trim, bar: y + 6, mullM: BM.TRIM });
            if (fam === 'painted') { F.box(c - hw - 1, y + 3, c - hw, y + 10, -1, 0, doorC === BM.WOOD ? BM.SHUTTER_BLACK : doorC); F.box(c + hw, y + 3, c + hw + 1, y + 10, -1, 0, doorC === BM.WOOD ? BM.SHUTTER_BLACK : doorC); }
          }
        }
      }
      if (bay) {                                                                              // three-sided bay, 1-2 storeys
        const nb = Math.min(2, ufl - (mansard ? 1 : 0)), yb1 = g0 + nb * TH;
        F.box(wu0, g0 - 1, wu1, yb1, -3, 0, wall);
        F.box(wu0, g0 - 1, wu1, g0, -3, 0, trim);
        for (let f = 0; f < nb; ++f) {
          const y = g0 + f * TH;
          F.box(wu0 + 1, y + 3, wu1 - 1, y + 10, -3, -2, -1); F.box(wu0 + 1, y + 3, wu1 - 1, y + 10, -2, -1, glass(wu0, f));
          for (let u = wu0 + 4; u < wu1 - 2; u += 3) F.box(u, y + 3, u + 1, y + 10, -2, -1, trim);
          F.box(wu0, y + 3, wu0 + 1, y + 10, -2, -1, glass(wu0 + 1, f)); F.box(wu1 - 1, y + 3, wu1, y + 10, -2, -1, glass(wu1, f));
          F.box(wu0, y + 2, wu1, y + 3, -4, 0, trim);
        }
        F.box(wu0 - 1, yb1, wu1 + 1, yb1 + 1, -4, 0, trim);
      }
      // top: cornice, mansard with dormers, or a modern coping and balcony
      if (mansard) {
        const yt = g0 + (ufl - 1) * TH;
        M.box(x0, yt, zf, x1, top, zf + 4, -1);
        for (let j = 0; j < top - yt; ++j) M.box(x0, yt + j, zf + Math.min(3, j >> 2), x1, yt + j + 1, zf + 4, shingle);
        F.box(0, yt - 2, w, yt, -2, 0, trim);
        const c = w >> 1;
        F.box(c - 4, yt, c + 4, yt + 9, 0, 3, trim);
        F.box(c - 3, yt + 2, c + 3, yt + 8, 0, 1, -1); F.box(c - 3, yt + 2, c + 3, yt + 8, 1, 2, glass(c, 5));
        F.box(c - 5, yt + 9, c + 5, yt + 10, -1, 3, shingle);
      } else if (fam === 'modern') {
        F.box(0, top - 1, w, top, -1, 0, trim);
        if (ufl >= 2 && H2(seed, k, 31) < 0.6) {
          const y = g0 + TH * (ufl - 1);
          F.box(3, y - 1, w - 3, y, -4, 0, BM.CONCRETE);
          F.box(3, y, w - 3, y + 4, -4, -3, BM.GLASS_DARK); F.box(3, y + 4, w - 3, y + 5, -4, -3, BM.METAL);
        }
      } else {
        F.box(0, top - 4, w, top - 2, -1, 0, trim);
        F.box(0, top - 2, w, top, -2, 0, trim);
        for (let u = 1; u < w - 1; u += 4) F.box(u, top - 5, u + 1, top - 4, -1, 0, trim);
      }
      const deck = flatRoof(M, x0, zf, x1, zb, top, 1, fam === 'modern' ? trim : wall);
      roofs.push([x0 + 1, zf + 1 + (mansard ? 4 : 0), x1 - 1, zb - 1, deck, ufl]);
      // back: windows, back door, a small deck or patio
      const Fb = face(M, x0, zf, x1, zb, 'b');
      for (let f = 0; f < ufl; ++f) for (const c of [Math.round(w * 0.3), Math.round(w * 0.72)]) {
        if (f === 0 && c === Math.round(w * 0.3)) { Fb.box(c - 2, g0, c + 3, g0 + 9, -1, 1, -1); Fb.box(c - 2, g0, c + 3, g0 + 9, 1, 2, BM.GLASS_DARK); continue; }
        win(Fb, c - 2, g0 + f * TH + 3, c + 2, g0 + f * TH + 10, glass(c + 50, f), { sill: trim });
      }
      // free ends: side windows
      for (const s of ['l', 'r']) {
        if ((s === 'l' && (x0 !== 0 || party.l)) || (s === 'r' && (x1 !== W || party.r))) continue;
        const Fs = face(M, x0, zf, x1, zb, s);
        for (let f = 0; f < ufl; ++f) for (let u = 8; u + 4 < ud - 6; u += 14) win(Fs, u, g0 + f * TH + 3, u + 4, g0 + f * TH + 10, glass(u + 90, f), { sill: trim });
      }
      // stoop with stepped cheek walls
      const dx0 = x1 - du - 5, dx1 = x1 - du;
      let zfoot = zf;
      if (g0 >= 3) {
        const zl = zf - 5;
        M.box(dx0 - 1, 0, zl, dx1 + 1, g0, zf, stoopM);
        for (let s = 1; s < g0; ++s) M.box(dx0, 0, zl - 2 * s, dx1, g0 - s, zl - 2 * s + 2, stoopM);
        for (let s = 0; s < g0; ++s) { const z0 = s === 0 ? zl : zl - 2 * s, z1 = s === 0 ? zf : zl - 2 * s + 2; M.box(dx0 - 1, 0, z0, dx0, g0 - s + 2, z1, fenceM === BM.TRIM ? stoopM : stoopM); M.box(dx1, 0, z0, dx1 + 1, g0 - s + 2, z1, stoopM); }
        M.box(dx0 - 1, g0 + 2, zl, dx0, g0 + 5, zl + 1, fenceM); M.box(dx1, g0 + 2, zl, dx1 + 1, g0 + 5, zl + 1, fenceM);
        zfoot = zl - 2 * (g0 - 1);
      } else M.box(dx0 - 1, 0, zf - 3, dx1 + 1, g0, zf, stoopM);
      // front garden: walk, fence with a gate, hedge to the neighbour, planting, bins
      const walkM = fam === 'brick' ? BM.BRICK_RED : BM.CONCRETE;
      M.box(dx0, 0, 0, dx1, 1, zfoot, walkM);
      for (let x = x0; x < x1; ++x) {
        if (x >= dx0 - 1 && x < dx1 + 1) continue;
        M.box(x, 1, 1, x + 1, 2, 2, stoopM);
        if (x % 2 === 0) M.box(x, 2, 1, x + 1, 5, 2, fenceM);
        M.box(x, 4, 1, x + 1, 5, 2, fenceM);
      }
      if (k > 0 || !party.l) M.box(x0 + (k === 0 ? 1 : 0), 1, 2, x0 + (k === 0 ? 2 : 1), 4, Math.max(3, zfoot - 1), BM.LEAF_DARK);
      const gx0 = doorL ? x0 + 2 : dx1 + 2, gx1 = doorL ? dx0 - 2 : x1 - 2;
      if (gx1 - gx0 >= 4) {
        M.box(gx0, 1, zf - 4, gx1, 2, zf, BM.WOOD);
        for (let x = gx0; x < gx1 - 1; x += 3) shrub(M, x, 2, zf - 3, 2, 2, R);
        if (H2(seed, k, 41) < 0.45 && zf >= 14) tree(M, (gx0 + gx1) >> 1, 1, 6 + (k % 2), R, 0.7);
        else if (H2(seed, k, 42) < 0.6) { M.box(gx0 + 1, 1, 3, gx0 + 3, 5, 5, BM.SHUTTER_GREEN); M.box(gx0 + 4, 1, 3, gx0 + 6, 5, 5, BM.AWNING_BLUE); }
      }
      // back yard: patio, fences, AC unit, a tree or shed
      if (back >= 8) {
        const patio = fam === 'modern' ? BM.WOOD : pick(R, [BM.CONCRETE, BM.BRICK_RED, BM.WOOD]);
        M.box(x0 + 1, 0, zb, x1 - 1, patio === BM.WOOD ? 2 : 1, zb + Math.min(8, back - 2), patio);
        if (k > 0 || !party.l) M.box(x0, 1, zb, x0 + 1, 7, D - (party.b ? 0 : 1), BM.WOOD);
        if (k === n - 1 && !party.r) M.box(W - 1, 1, zb, W, 7, D - (party.b ? 0 : 1), BM.WOOD);
        if (!party.b) M.box(x0, 1, D - 2, x1, 7, D - 1, BM.WOOD);
        M.box(x1 - 6, 1, zb + 1, x1 - 2, 4, zb + 4, BM.METAL);
        if (back >= 20) { if (H2(seed, k, 51) < 0.5) tree(M, x0 + (w >> 1), 1, D - 8, R, 0.8); else { M.box(x0 + 2, 1, D - 10, x0 + 10, 8, D - 3, pick(R, [BM.WOOD, BM.SIDING_GRAY, BM.SHUTTER_GREEN])); M.box(x0 + 1, 8, D - 11, x0 + 11, 9, D - 2, BM.SHINGLE_GRAY); } }
      }
    }
    E.vox(C, M, 0, 0, 0);
    // every other house gets the shared roof kit; the others a hatch, a skylight and a vent stack
    const odd = H2(seed, 7, 7) < 0.5 ? 1 : 0;
    roofs.forEach((r, k) => {
      if (fam === 'brick' && k % 2 === odd && L.roofKit && r[2] - r[0] >= 12) { L.roofKit(E, C, r[0], r[1], r[2], r[3], r[4], R, { style: 'residential', floors: r[5], avoid: [] }); return; }
      const P = VM(r[2] - r[0], 6, r[3] - r[1], 0, 0), pw = r[2] - r[0], pd = r[3] - r[1];
      P.box(2, 0, pd - 9, 6, 2, pd - 5, BM.METAL); P.box(2, 2, pd - 9, 6, 3, pd - 5, BM.STEEL_DARK);
      if (pw >= 12) { P.box(pw - 9, 0, (pd >> 1) - 3, pw - 3, 1, (pd >> 1) + 3, BM.TRIM); P.box(pw - 8, 1, (pd >> 1) - 2, pw - 4, 2, (pd >> 1) + 2, BM.GLASS_DARK); }
      P.box(pw - 4, 0, 3, pw - 3, 4, 4, BM.STEEL_DARK);
      E.vox(C, P, r[0], r[4], r[1]);
    });
  }
  reg('townhouses', townhouses, { zones: ['transition'], minW: 15, maxW: 60, minFloors: 2, maxFloors: 3 });

  // ================================================================================================ garden apartments
  const APT_SKINS = [
    { low: BM.BRICK_BROWN, up: BM.SIDING_WHITE, trim: BM.TRIM, rail: BM.STEEL_DARK },
    { low: BM.BRICK_RED, up: BM.SIDING_YELLOW, trim: BM.TRIM, rail: BM.WOOD },
    { low: BM.BRICK_DARK, up: BM.SIDING_GRAY, trim: BM.TRIM, rail: BM.STEEL_DARK },
    { low: BM.PAINT_CREAM, up: BM.PAINT_CREAM, trim: BM.WOOD, rail: BM.WOOD },
    { low: BM.BUFF, up: BM.BUFF, trim: BM.TRIM_DARK, rail: BM.STEEL_DARK },
    { low: BM.BRICK_RED, up: BM.BRICK_RED, trim: BM.TRIM, rail: BM.TRIM },
    { low: BM.SIDING_SAGE, up: BM.SIDING_SAGE, trim: BM.TRIM, rail: BM.TRIM },
    { low: BM.WHITE_CONCRETE, up: BM.PAINT_SALMON, trim: BM.TRIM, rail: BM.STEEL_DARK }
  ];
  const APT_NAMES = ['THE ELMS', 'OAKS', 'WILLOWS', 'PINES', 'MAPLES', 'BIRCH CT', 'CEDARS', 'ASPEN', 'GARDENS', 'PARKSIDE'];
  function gardenApts(E, C, W, D, spec, R) {
    spec = prep(spec, 2, 3);
    const party = spec.party, seed = spec.seed, fl = spec.floors;
    const M = VM(W, 72, D + 8, 0, 8);
    M.box(0, 0, 0, W, 1, D, BM.GRASS);
    const S = pick(R, APT_SKINS), g0 = 1, top = g0 + fl * TH + 1, hip = R() < 0.55;
    const shingle = pick(R, [BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE]);
    const sl = party.l ? 0 : ri(R, 6, 10), sr = party.r ? 0 : ri(R, 6, 10), sb = party.b ? 0 : 6;
    const bd = ri(R, 40, 46), gs = ri(R, 16, 24);
    const freeS = [!party.l ? 'l' : null, !party.r ? 'r' : null].filter(Boolean);
    const driveS = freeS.length ? pick(R, freeS) : null;
    const rearPark = D - gs - bd - sb >= 48 && driveS && W >= 100;
    const frontPark = !rearPark && D - bd - sb - 10 - 7 >= 41;
    const bz0 = frontPark ? D - sb - bd - 2 : gs, bz1 = bz0 + bd;
    const dw = 22;
    let bx0 = sl, bx1 = W - sr;
    if (rearPark) { if (driveS === 'l') bx0 = Math.max(bx0, dw + 4); else bx1 = Math.min(bx1, W - dw - 4); }
    const blocks = bx1 - bx0 > 220 ? [[bx0, ((bx0 + bx1) >> 1) - 9], [((bx0 + bx1) >> 1) + 9, bx1]] : [[bx0, bx1]];
    const roofs = [], entries = [];
    for (const [x0, x1] of blocks) {
      const w = x1 - x0;
      M.box(x0, 0, bz0, x1, top, bz1, S.up);
      M.box(x0, 0, bz0, x1, g0 + TH, bz1, S.low);
      if (S.low !== S.up) ring(M, x0, g0 + TH - 1, bz0, x1, g0 + TH, bz1, S.trim);
      let deck = 0;
      if (hip) { hipRoof(M, x0, bz0, x1, bz1, top, 2, shingle, S.trim); }
      else { ring(M, x0, top, bz0, x1, top + 2, bz1, S.trim); M.box(x0 + 1, top, bz0 + 1, x1 - 1, top + 1, bz1 - 1, BM.ROOF_TAR); roofs.push([x0 + 1, bz0 + 1, x1 - 1, bz1 - 1, top + 1]); }
      for (const side of ['f', 'b']) {
        const F = face(M, x0, bz0, x1, bz1, side), ne = Math.max(1, Math.round(w / 84));
        const ec = []; for (let i = 0; i < ne; ++i) ec.push(Math.round(w * (i + 0.5) / ne));
        // stair entries: recessed bays with a door, landing windows and a canopy
        for (const c of ec) {
          if (side === 'f') entries.push(F.side === 'f' ? x1 - c : c);
          F.box(c - 6, 1, c + 6, top - 1, -1, 3, -1);
          F.box(c - 6, 0, c + 6, 1, 0, 3, BM.CONCRETE);
          F.box(c - 3, 1, c + 3, 10, 3, 4, side === 'f' ? BM.DOOR_NAVY : BM.METAL);
          F.box(c - 2, 4, c + 2, 9, 3, 4, BM.GLASS_DARK_LIT);
          for (let f = 1; f < fl; ++f) { const y = g0 + f * TH - 6; F.box(c - 4, y, c + 4, y + 5, 3, 4, BM.GLASS_LIT); F.box(c - 6, y - 1, c + 6, y, 0, 3, S.trim); }
          F.box(c - 7, 11, c + 7, 12, -4, 0, S.trim);
          F.box(c - 7, 10, c - 6, 11, -4, -3, S.trim); F.box(c + 6, 10, c + 7, 11, -4, -3, S.trim);
          if (side === 'f') F.box(c - 1, 12, c + 1, 13, -1, 0, BM.LED);
        }
        // apartments: window, slider with balcony (patio on the ground), window
        for (let f = 0; f < fl; ++f) {
          const y = g0 + f * TH;
          const segs = []; { let a = 2; for (const c of ec.concat([w + 8])) { const bnd = Math.min(w - 2, c - 8); if (bnd - a >= 7) segs.push([a, bnd]); a = c + 8; } }
          const mods = [], singles = [];
          for (const [a, bnd] of segs) {
            const nm = Math.floor((bnd - a + 2) / 22), off = a + ((bnd - a + 2 - nm * 22) >> 1);
            for (let i = 0; i < nm; ++i) mods.push(off + i * 22);
            for (const [p, q] of [[a, off - 2], [off + nm * 22, bnd]]) if (q - p >= 7) singles.push(((p + q) >> 1) - 2);
          }
          for (const u of singles) win(F, u, y + 3, u + 4, y + 10, L.glassMat(seed, u + 77, f, 0.3), { sill: S.trim, bar: y + 6, mullM: BM.TRIM });
          for (const u of mods) {
            win(F, u, y + 3, u + 4, y + 10, L.glassMat(seed, u + side.length * 7, f, 0.3), { sill: S.trim, bar: y + 6, mullM: BM.TRIM });
            F.box(u + 6, y, u + 14, y + 10, -1, 1, -1); F.box(u + 6, y, u + 14, y + 10, 1, 2, L.glassMat(seed, u + 3, f + 9, 0.35, 'dark'));
            F.box(u + 10, y, u + 11, y + 10, 1, 2, S.trim);
            win(F, u + 16, y + 3, u + 20, y + 10, L.glassMat(seed, u + 17, f, 0.3), { sill: S.trim, mullM: BM.TRIM });
            if (H2(seed, u, f * 3 + 1) < 0.25) F.box(u + 16, y + 4, u + 20, y + 6, -1, 1, BM.METAL);   // window AC unit
            if (f === 0) { F.box(u + 5, 0, u + 15, 1, -5, 0, BM.CONCRETE); F.box(u + 5, 1, u + 6, 5, -5, 0, BM.WOOD); F.box(u + 14, 1, u + 15, 5, -5, 0, BM.WOOD); }
            else {
              F.box(u + 5, y - 1, u + 15, y, -5, 0, BM.CONCRETE);
              F.box(u + 5, y, u + 15, y + 4, -5, -4, S.rail); F.box(u + 5, y, u + 6, y + 4, -5, 0, S.rail); F.box(u + 14, y, u + 15, y + 4, -5, 0, S.rail);
              if (H2(seed, u, f) < 0.4) F.box(u + 7, y, u + 9, y + 3, -3, -1, pick(R, [BM.LEAF, BM.AWNING_RED, BM.TRIM]));
            }
          }
        }
      }
      for (const s of ['l', 'r']) {
        if ((s === 'l' && x0 === 0) || (s === 'r' && x1 === W)) continue;
        const F = face(M, x0, bz0, x1, bz1, s);
        for (let f = 0; f < fl; ++f) for (let u = 8; u + 4 < bd - 6; u += 12) win(F, u, g0 + f * TH + 3, u + 4, g0 + f * TH + 10, L.glassMat(seed, u + 300, f, 0.3), { sill: S.trim });
      }
      // foundation shrubs
      bed(M, x0, bz0 - 5, x1, bz0, R, { fill: BM.WOOD, shrubs: 0.95 });
      if (D - bz1 > 6) bed(M, x0, bz1, x1, bz1 + 4, R, { fill: BM.WOOD, shrubs: 0.7 });
    }
    // ---- parking and drives
    let walkTo = 0;
    if (rearPark) {
      const dx0 = driveS === 'l' ? sl : W - sr - dw, pz0 = bz1 + 8;
      M.box(dx0, 0, 0, dx0 + dw, 1, D - sb, BM.GRANITE_DARK);
      M.box(dx0, 0, 0, dx0 + dw, 1, 3, BM.CONCRETE);
      const px0 = party.l ? 0 : 4, px1 = W - (party.r ? 0 : 4);
      M.box(px0, 0, pz0, px1, 1, D - sb, BM.GRANITE_DARK);
      parkField(M, px0, px1, pz0, D - sb - 1, R, { occ: 0.6, endIslands: false });
      const carport = R() < 0.6;
      if (carport) { const z0 = D - sb - 20, roofM = pick(R, [BM.METAL, BM.SHINGLE_GRAY, BM.DOOR_NAVY]); M.box(px0 + 2, 10, z0, px1 - 2, 11, D - sb - 1, roofM); for (let x = px0 + 2; x < px1 - 2; x += 30) M.box(x, 1, D - sb - 3, x + 1, 10, D - sb - 2, BM.STEEL_DARK); M.box(px1 - 3, 1, D - sb - 3, px1 - 2, 10, D - sb - 2, BM.STEEL_DARK); }
      arrow(M, dx0 + 5, 4, 'z+'); arrow(M, dx0 + dw - 6, 14, 'z-');
      dumpsterPen(M, driveS === 'l' ? px1 - 18 : px0 + 2, bz1 + 1, 16, 7 > 0 ? 7 : 7, S.low);
      lamp(M, driveS === 'l' ? dx0 + dw + 2 : dx0 - 3, bz1 + 4, 24, [driveS === 'l' ? 'x-' : 'x+'], 1);
    } else if (frontPark) {
      const lx0 = party.l ? 0 : 4, lx1 = W - (party.r ? 0 : 4);
      M.box(lx0, 0, 7, lx1, 1, bz0 - 10, BM.GRANITE_DARK);
      const op = [(W >> 1) - 13 + Math.round((R() - 0.5) * W * 0.3), 0]; op[1] = op[0] + 26;
      parkField(M, lx0, lx1, 7, bz0 - 10, R, { occ: 0.55, ada: true, skip: (a, b) => b > op[0] - 1 && a < op[1] + 1 });
      frontStrip(M, 0, W, 7, [op], R, { tree: 26 });
      M.box(sl, 0, bz0 - 10, W - sr, 2, bz0 - 8, BM.CONCRETE);
      walkTo = bz0 - 10;
    }
    // walks from the street to every entry, lawn trees, a monument sign
    for (const ex of entries) { M.box(ex - 2, 0, frontPark ? bz0 - 8 : 0, ex + 2, 1, bz0, BM.CONCRETE); M.box(ex - 3, 1, bz0 - 5, ex + 3, 4, bz0, -1); M.box(ex - 3, 0, bz0 - 5, ex + 3, 1, bz0, BM.CONCRETE); }
    if (!frontPark && bz0 >= 14) {
      const nt = Math.max(3, Math.round(W / 34));
      for (let i = 0; i < nt; ++i) {
        const tx = Math.round(bx0 + (bx1 - bx0) * (i + 0.5) / nt + (R() - 0.5) * 12), tz = 6 + Math.floor(R() * Math.max(1, bz0 - 14));
        if (entries.some((e) => Math.abs(e - tx) < 8)) continue;
        tree(M, tx, 1, tz, R, 1.1);
      }
      const nm = fitName(R, APT_NAMES, 30, true), sx = party.l ? W - 40 : 6;
      if (nm && W > 80) {
        const sw = textW(nm, true) + 6;
        M.box(sx, 0, 2, sx + sw + 4, 3, 7, S.low === BM.PAINT_CREAM ? BM.BRICK_RED : S.low);
        M.box(sx + 2, 3, 4, sx + sw + 2, 10, 5, BM.TRIM);
        say(face(M, sx + 2, 4, sx + sw + 2, 5, 'f'), nm, sw / 2, 4, 0, BM.SHUTTER_GREEN, true);
        for (let x = sx; x < sx + sw + 4; x += 3) shrub(M, x, 1, 7, 3, 2, R);
      }
    }
    if (!party.b && !rearPark) for (let x = 6; x < W - 6; x += 26) if (D - bz1 > 12) tree(M, x + Math.floor(R() * 8), 1, D - 6, R, 0.9);
    E.vox(C, M, 0, 0, 0);
    if (L.roofKit) for (const r of roofs) L.roofKit(E, C, r[0], r[1], r[2], r[3], r[4], R, { style: 'residential', floors: fl, avoid: [] });
  }
  reg('garden_apartments', gardenApts, { zones: ['transition'], minW: 22, maxW: 70, minFloors: 2, maxFloors: 3 });

  // ================================================================================================ main street mixed use
  const MAIN_SHOPS = SHOPS.concat(['HARDWARE', 'BAKERY', 'BOOKS', 'CAFE', 'DINER', 'TAVERN', 'ANTIQUES', 'GIFTS', 'FLOWERS', 'DRUGS', 'BARBER', 'REALTY', 'BANK', 'SHOES', 'TOYS', 'MUSIC', 'PIZZA', 'GROCER']);
  function mainStreet(E, C, W, D, spec, R) {
    spec = prep(spec, 2, 3);
    const party = spec.party, seed = spec.seed, fl = spec.floors;
    const M = VM(W, 80, D + 8, 0, 8);
    const gH = 17, UH = 13;
    const bdp = D <= 104 ? D : clamp(ri(R, 60, 84), 40, D - 24), rear = D - bdp;
    M.box(0, 0, 0, W, 1, D, rear >= 22 ? pick(R, ASPH) : BM.CONCRETE);
    // split the frontage into 1-3 buildings
    const nP = W < 72 ? 1 : W < 130 ? (R() < 0.55 ? 2 : 1) : ri(R, 2, 3);
    const cuts = [0]; { const wts = []; for (let i = 0; i < nP; ++i) wts.push(0.75 + R() * 0.5); const t = wts.reduce((a, b) => a + b, 0); let acc = 0; for (let i = 0; i < nP - 1; ++i) { acc += wts[i]; cuts.push(Math.round(W * acc / t)); } cuts.push(W); }
    const mats = colours(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BUFF, BM.PAINT_CREAM, BM.PAINT_SALMON, BM.PAINT_SAGE, BM.LIMESTONE, BM.BRICK_RED], nP);
    const roofs = [];
    for (let p = 0; p < nP; ++p) {
      const x0 = cuts[p], x1 = cuts[p + 1], w = x1 - x0, wall = mats[p];
      const pf = clamp(fl + (R() < 0.25 ? (fl === 3 ? -1 : 1) : 0), 2, 3);
      const par = ri(R, 3, 6), top = gH + (pf - 1) * UH + par;
      const trim = wall === BM.LIMESTONE || wall === BM.BUFF || wall === BM.PAINT_CREAM ? pick(R, [BM.TRIM_DARK, BM.BRICK_DARK, BM.LIMESTONE_DARK]) : pick(R, [BM.LIMESTONE, BM.TRIM, BM.BUFF]);
      const cstyle = pick(R, ['bracket', 'stepped', 'simple', 'bracket']);
      M.box(x0, 0, 0, x1, top, bdp, wall);
      const F = face(M, x0, 0, x1, bdp, 'f');
      // ---- shopfronts
      const upDoor = w >= 30, udL = H2(seed, p, 3) < 0.5;
      const s0 = upDoor && udL ? 9 : 1, s1 = upDoor && !udL ? w - 9 : w - 1;
      const nS = s1 - s0 >= 70 ? 2 : 1, shopB = [];
      for (let i = 0; i < nS; ++i) shopB.push([Math.round(s0 + (s1 - s0) * i / nS), Math.round(s0 + (s1 - s0) * (i + 1) / nS)]);
      F.box(0, 0, w, gH, -1, 0, trim);                                                      // shopfront frame (pilasters)
      for (const [a, b] of shopB) {
        const sp = signPair(R), nm = fitName(R, MAIN_SHOPS, b - a - 8, true), shopFront = pick(R, [BM.STOREFRONT, BM.WOOD, BM.SHUTTER_GREEN, BM.DOOR_NAVY, BM.SHUTTER_BLACK, BM.DOOR_RED]);
        F.box(a + 2, 1, b - 2, gH - 2, -1, 0, -1);
        F.box(a + 2, 1, b - 2, 3, 0, 1, shopFront);                                             // bulkhead
        const ec = (a + b) >> 1, recess = 3;
        for (let u = a + 2; u < b - 2; u += 5) {
          const ue = Math.min(b - 2, u + 5);
          if (ue > ec - 4 && u < ec + 4) continue;
          F.box(u, 3, ue, 12, 0, 1, L.glassMat(seed, x0 + u, 3, 0.85)); F.box(ue - 1, 3, ue, 12, 0, 1, shopFront);
        }
        F.box(a + 2, 12, b - 2, 14, 0, 1, L.glassMat(seed, x0 + a, 4, 0.7, 'dark'));            // transom
        F.box(a + 2, 14, b - 2, gH - 2, 0, 1, sp.board);                                         // sign band
        if (nm) say(F, nm, (a + b) / 2, 14 + ((gH - 2 - 14 - 5) >> 1) + (gH - 16 > 5 ? 0 : 0), -1, sp.letter, true);
        F.box(ec - 4, 1, ec + 4, 12, 0, recess, -1);                                             // recessed entry
        F.box(ec - 4, 0, ec + 4, 1, 0, recess, BM.TRIM_DARK);
        F.box(ec - 3, 1, ec + 3, 11, recess, recess + 1, BM.GLASS_DARK_LIT);
        F.box(ec - 4, 1, ec - 3, 12, recess, recess + 1, shopFront); F.box(ec + 3, 1, ec + 4, 12, recess, recess + 1, shopFront);
        F.box(ec - 4, 11, ec + 4, 12, recess, recess + 1, shopFront);
        F.box(ec - 4, 3, ec - 3, 12, 1, recess, L.glassMat(seed, x0 + ec, 5, 0.85)); F.box(ec + 3, 3, ec + 4, 12, 1, recess, L.glassMat(seed, x0 + ec, 5, 0.85));
        if (R() < 0.7) {                                                                         // awning
          const aw = pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.DOOR_NAVY, BM.PAINT_YELLOW, BM.SHUTTER_GREEN]), st = R() < 0.5;
          for (let u = a + 2; u < b - 2; ++u) {
            const m = st && ((u - a) >> 1) % 2 ? BM.TRIM : aw;
            F.box(u, 13, u + 1, 14, -1, 0, m); F.box(u, 12, u + 1, 13, -3, -1, m); F.box(u, 11, u + 1, 12, -5, -3, m); F.box(u, 9, u + 1, 11, -6, -5, m);
          }
        } else if (R() < 0.6) {                                                                  // blade sign
          const bu = a + 3, bs = pick(R, SIGN_BOARDS);
          F.box(bu, gH, bu + 1, gH + 10, -7, 0, bs); F.box(bu, gH, bu + 1, gH + 1, -7, 0, BM.METAL);
          F.box(bu, gH + 2, bu + 1, gH + 8, -6, -1, BM.NEON);
        }
        // sandwich board, planter or bench on the sidewalk side of the lot
        if (H2(seed, x0 + a, 61) < 0.5) M.box(x1 - ec - 6 + 0, 1, -2, x1 - ec - 4, 5, -1, BM.WOOD);
      }
      if (upDoor) {                                                                              // door to the flats upstairs
        const du = udL ? 2 : w - 7;
        F.box(du, 1, du + 5, 11, -1, 1, -1); F.box(du, 1, du + 5, 11, 1, 2, pick(R, DOORS)); F.box(du, 11, du + 5, 13, -1, 2, -1); F.box(du, 11, du + 5, 13, 2, 3, BM.GLASS_LIT);
        F.box(du + 1, 14, du + 4, 15, -1, 0, BM.LED);
      }
      F.box(0, gH - 1, w, gH + 1, -1, 0, trim);                                                 // belt course
      // ---- upper floors
      const nw = Math.max(2, Math.floor((w - 4) / 9)), oriel = w >= 44 && pf >= 3 && R() < 0.35;
      for (let f = 1; f < pf; ++f) {
        const y = gH + (f - 1) * UH;
        for (let i = 0; i < nw; ++i) {
          const c = Math.round(2 + (w - 4) * (i + 0.5) / nw);
          if (oriel && Math.abs(c - w / 2) < 10) continue;
          win(F, c - 2, y + 3, c + 2, y + 11, L.glassMat(seed, x0 + c, f, 0.32), { sill: trim, lintel: trim, bar: y + 7, mullM: BM.TRIM });
          if (wall !== BM.LIMESTONE && wall !== BM.PAINT_CREAM) F.box(c - 2, y + 12, c + 2, y + 13, 0, 1, trim);
        }
        if (oriel) {
          const a = Math.round(w / 2 - 9), b = a + 18;
          F.box(a, y, b, y + UH, -3, 0, wall);
          F.box(a, y, b, y + 1, -4, 0, trim);
          F.box(a + 2, y + 3, b - 2, y + 11, -3, -2, -1); F.box(a + 2, y + 3, b - 2, y + 11, -2, -1, L.glassMat(seed, x0 + a, f + 20, 0.35));
          for (let u = a + 6; u < b - 2; u += 5) F.box(u, y + 3, u + 1, y + 11, -2, -1, BM.TRIM);
          if (f === pf - 1) F.box(a - 1, y + UH, b + 1, y + UH + 1, -4, 0, trim);
        }
      }
      // ---- cornice / parapet
      if (cstyle === 'bracket') {
        F.box(0, top - 4, w, top - 2, -1, 0, trim); F.box(0, top - 2, w, top - 1, -2, 0, trim); F.box(0, top - 1, w, top, -3, 0, trim);
        for (let u = 1; u < w - 1; u += 5) F.box(u, top - 6, u + 1, top - 4, -1, 0, trim);
      } else if (cstyle === 'stepped') {
        const c = w >> 1, pw = Math.min(w - 8, 24);
        M.box(x1 - c - (pw >> 1), top, 0, x1 - c + (pw >> 1), top + 4, 2, wall);
        M.box(x1 - c - (pw >> 1) + 4, top + 4, 0, x1 - c + (pw >> 1) - 4, top + 6, 2, wall);
        F.box(c - (pw >> 1), top + 4, c + (pw >> 1), top + 5, -1, 0, trim); F.box(c - (pw >> 1) + 4, top + 6, c + (pw >> 1) - 4, top + 7, -1, 0, trim);
        F.box(c - 8, top - 3, c + 8, top + 3, -1, 0, trim);
        say(F, String(1890 + Math.floor(R() * 45)), c, top - 2, -1, BM.TRIM_DARK, true);
        F.box(0, top - 1, w, top, -1, 0, trim);
      } else { F.box(0, top - 3, w, top - 1, -1, 0, trim); F.box(0, top - 1, w, top, -1, 0, trim); }
      const deck = flatRoof(M, x0, 0, x1, bdp, top, Math.min(par - 1, 3), trim);
      roofs.push([x0 + 1, 1, x1 - 1, bdp - 1, deck, pf]);
      // ---- free side walls and the back
      for (const s of ['l', 'r']) {
        if ((s === 'l' && (x0 !== 0 || party.l)) || (s === 'r' && (x1 !== W || party.r))) continue;
        const Fs = face(M, x0, 0, x1, bdp, s), ghost = R() < 0.5, gu1 = Math.min(bdp - 6, 60);
        for (let f = 1; f < pf; ++f) for (let u = 6; u + 4 < bdp - 4; u += 11) if (!(ghost && u + 5 > 19 && u < gu1 + 1)) win(Fs, u, gH + (f - 1) * UH + 3, u + 4, gH + (f - 1) * UH + 11, L.glassMat(seed, x0 + u + 400, f, 0.3), { sill: trim, lintel: trim });
        win(Fs, 3, 3, 14, 12, L.glassMat(seed, x0, 3, 0.85), { mull: 5, mullM: trim });
        if (ghost && gu1 - 20 >= 16) { Fs.box(20, gH + 2, gu1, top - 6, 0, 1, pick(R, [BM.PAINT_CREAM, BM.TRIM, BM.PAINT_YELLOW])); say(Fs, fitName(R, ['HOTEL', 'SODA', 'FEED', 'TOBACCO', 'COFFEE', 'FURNITURE'], Math.min(bdp - 6, 60) - 24, true) || 'EST', (20 + Math.min(bdp - 6, 60)) / 2, gH + 4, 0, BM.BRICK_DARK, true); }
      }
      if (rear > 0 || !party.b) {
        const Fb = face(M, x0, 0, x1, bdp, 'b');
        for (let f = 1; f < pf; ++f) for (let i = 0; i < nw - 1; ++i) { const c = Math.round(4 + (w - 8) * (i + 0.5) / Math.max(1, nw - 1)); win(Fb, c - 2, gH + (f - 1) * UH + 3, c + 2, gH + (f - 1) * UH + 10, L.glassMat(seed, x0 + c + 600, f, 0.3), { sill: trim }); }
        Fb.box(3, 1, 9, 11, 0, 1, BM.METAL); Fb.box(4, 12, 8, 13, -1, 0, BM.LED);
        if (pf >= 2 && w >= 26) {                                                               // fire escape
          const c = Math.round(w * 0.62);
          for (let f = 1; f < pf; ++f) { const y = gH + (f - 1) * UH; Fb.box(c - 7, y - 1, c + 7, y, -4, 0, BM.STEEL_DARK); Fb.box(c - 7, y, c + 7, y + 3, -4, -3, BM.STEEL_DARK); Fb.box(c - 7, y, c - 6, y + 3, -4, 0, BM.STEEL_DARK); Fb.box(c + 6, y, c + 7, y + 3, -4, 0, BM.STEEL_DARK); }
          for (let f = 1; f < pf - 1; ++f) for (let k = 0; k < UH; ++k) { const y = gH + (f - 1) * UH + k; Fb.box(c - 6 + Math.floor(k * 11 / UH), y, c - 5 + Math.floor(k * 11 / UH), y + 1, -3, -1, BM.STEEL_DARK); }
        }
      }
    }
    // ---- the rear: parking (with a dumpster) or a fenced yard
    if (rear >= 22) {
      stallRow(M, party.l ? 2 : 4, W - (party.r ? 2 : 4), D - (party.b ? 0 : 3) - 19, 1, R, 0.5, {});
      dumpsterPen(M, W - 20, bdp + 1, 16, 7, mats[0]);
      if (!party.b) M.box(0, 1, D - 2, W, 6, D - 1, BM.WOOD);
      lamp(M, (W >> 1), bdp + 2, 22, ['z+'], 1);
    } else if (rear > 0) {
      if (!party.b) M.box(0, 1, D - 2, W, 7, D - 1, BM.WOOD);
      if (!party.l) M.box(0, 1, bdp, 1, 7, D - 1, BM.WOOD);
      if (!party.r) M.box(W - 1, 1, bdp, W, 7, D - 1, BM.WOOD);
      if (rear > 8) M.box(4, 1, bdp + 2, 12, 5, bdp + 6, BM.SHUTTER_GREEN);
    }
    E.vox(C, M, 0, 0, 0);
    if (L.roofKit) for (const r of roofs) L.roofKit(E, C, r[0], r[1], r[2], r[3], r[4], R, { style: 'residential', floors: r[5], avoid: [] });
  }
  reg('main_street_mixed', mainStreet, { zones: ['transition'], minW: 8, maxW: 40, minFloors: 2, maxFloors: 3 });
})();
