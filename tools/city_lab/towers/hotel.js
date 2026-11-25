// Grand hotel (1920s): a brick high-rise rising in wedding-cake setbacks from a two-storey limestone base.
// Limestone quoins, belt courses and arched top floors on every tier, a copper mansard (or limestone tempietto)
// crown, wooden water tanks on the setback roofs, a fire escape on the side, a vertical neon blade sign on the
// front corner, a bulb-lit marquee over the main door and a canvas doorman canopy out to the curb.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;

  // 5x7 glyphs for the blade sign
  const FONT = {
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111']
  };

  // ---- limestone base: rusticated ground storey, tall arched windows through both storeys, grand portal
  function skinBase(S) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, S.stone), gH = 20;
      F.rect(0, 0, len, 3, 3, BM.GRANITE_DARK);                                              // granite plinth
      for (let v = 3; v < gH; ++v) F.rect(0, v, len, v + 1, v % 3 === 2 ? 2 : 3, S.stone);  // rusticated courses
      F.rect(0, gH, len, gH + 2, 4, S.trim);                                                 // band over the ground storey
      const cs = L.bays(len, 12, 6), mid = cs.length >> 1;
      const door2 = info.front && cs.length >= 5 ? (S.doorLeft ? 1 : cs.length - 2) : -1;
      cs.forEach((c, k) => {
        if (info.front && k === mid && len > 40) {
          // grand portal: pilasters, entablature, revolving door between glazed doors, arched window above
          F.rect(c - 8, 0, c + 9, gH + 3, 4, S.trim);
          F.rect(c - 6, 0, c + 7, gH - 2, 0, BM.GLASS_DARK);
          F.rect(c - 6, gH - 2, c + 7, gH, 0, BM.BRONZE);
          for (const u of [c - 6, c - 3, c + 3, c + 6]) F.rect(u, 0, u + 1, gH - 2, 1, BM.BRONZE);
          F.rect(c - 1, 0, c + 2, 11, 1, BM.BRONZE);                                         // revolving door drum
          F.rect(c - 6, 11, c + 7, 12, 1, BM.BRONZE);
          F.rect(c - 9, gH + 1, c + 10, gH + 3, 5, S.trim);                                  // entablature
          F.rect(c - 4, gH + 3, c + 5, 33, 3, S.trim);                                       // arched window over the door
          F.rect(c - 3, gH + 4, c + 4, 30, 1, L.glassMat(S.seed, k, 77, 0.7));
          F.rect(c - 2, 30, c + 3, 32, 1, L.glassMat(S.seed, k, 77, 0.7));
          F.rect(c, gH + 4, c + 1, 32, 1, BM.BRONZE);
          F.rect(c, 32, c + 1, 35, 4, S.stone);                                              // keystone
          return;
        }
        F.rect(c - 4, 4, c + 5, 35, 3, S.trim);                                              // archivolt / surround
        const lit = L.H2(S.seed, k, info.front ? 3 : 5) < 0.45;
        const gl = lit ? BM.GLASS_LIT : BM.GLASS;
        F.rect(c - 3, 4, c + 4, 31, 1, gl);                                                  // tall arched window
        F.rect(c - 2, 31, c + 3, 33, 1, gl); F.rect(c - 1, 33, c + 2, 34, 1, gl);
        F.rect(c, 4, c + 1, 34, 1, BM.BRONZE);                                               // mullion
        F.rect(c - 3, 18, c + 4, 21, 1, BM.BRONZE);                                          // bronze spandrel between storeys
        F.rect(c - 3, 11, c + 4, 12, 1, BM.BRONZE);                                          // transom bar
        F.rect(c, 33, c + 1, 36, 4, S.stone);                                                // keystone
        if (k === door2) {                                                                   // side door (ballroom / grill)
          F.rect(c - 3, 0, c + 4, 4, 3, S.trim);
          F.rect(c - 2, 0, c + 3, 11, 1, BM.BRONZE);
          F.rect(c - 1, 1, c + 2, 10, 1, BM.GLASS_DARK);
        } else F.rect(c - 4, 3, c + 5, 4, 4, S.trim);                                        // sill on the plinth
      });
      // pilasters on the upper storey between the arches
      for (let k = 0; k + 1 < cs.length; ++k) {
        const u = (cs[k] + cs[k + 1]) >> 1;
        if (info.front && (k === mid || k + 1 === mid) && len > 40) continue;
        F.rect(u - 1, gH + 2, u + 2, h - 5, 3, S.stone); F.rect(u - 2, h - 6, u + 3, h - 5, 4, S.trim);
      }
      // cornice with dentils
      F.rect(0, h - 5, len, h - 4, 3, S.trim);
      F.rect(0, h - 4, len, h - 3, 4, S.trim);
      for (let u = 0; u < len; ++u) F.rect(u, h - 3, u + 1, h - 2, u % 3 === 0 ? 5 : 4, S.trim);
      F.rect(0, h - 2, len, h - 1, 5, S.trim); F.rect(0, h - 1, len, h, 6, S.trim);
      // quoins at the corners
      quoins(F, len, 3, h - 6, S.stone, 3);
      F.returns();
      return F;
    };
  }

  function quoins(F, len, v0, v1, mat, d) {
    for (let v = v0; v < v1; ++v) {                                                          // long / short blocks
      const w = Math.floor(v / 4) % 2 ? 2 : 4;
      F.rect(0, v, w, v + 1, d, mat); F.rect(len - w, v, len, v + 1, d, mat);
    }
  }

  // ---- brick shaft: double-hung windows with stone sills and keyed lintels, belt courses, quoins,
  // a projecting central pavilion on the street front, arched windows on the tier's top floor, cornice
  function skinBrick(S, n, o) {
    return (len, h, info) => {
      const F = new L.Relief(len, h, 4, S.brick);
      const cs = L.bays(len, 10, 6), top = n * FH;
      let p0 = -1, p1 = -1;
      if (info.front && cs.length >= 7) {                                                     // central pavilion
        const q = Math.max(3, Math.round(cs.length * 0.34)) | 1, ka = (cs.length - q) >> 1, kb = ka + q - 1;
        p0 = cs[ka] - 6; p1 = cs[kb] + 6;
        F.rect(p0, 0, p1, top, 3, S.brick);
      }
      for (let f = 0; f < n; ++f) {
        const v = f * FH, arched = o.arched && f === n - 1;
        cs.forEach((c, k) => {
          const g = L.glassMat(S.seed, k * 31 + (info.front ? 0 : 7) + (info.side ? 13 : 0), f + o.f0, 0.33);
          if (arched) {
            F.rect(c - 3, v + 2, c + 3, v + 13, 3, S.trim);
            F.rect(c - 2, v + 3, c + 2, v + 11, 1, g); F.rect(c - 1, v + 11, c + 1, v + 12, 1, g);
            F.rect(c - 1, v + 12, c + 1, v + 14, 4, S.trim);                                   // keystone
            F.rect(c - 2, v + 7, c + 2, v + 8, 1, BM.TRIM);
            return;
          }
          F.rect(c - 2, v + 3, c + 2, v + 11, 1, g);
          F.rect(c - 3, v + 2, c + 3, v + 3, 3, S.trim);                                       // sill
          F.rect(c - 3, v + 11, c + 3, v + 12, 2, S.lintel);                                   // soldier-course lintel
        });
        if (f > 0 && f % 4 === 0) F.rect(0, v, len, v + 1, 3, S.trim);                         // belt course
      }
      F.rect(0, 0, len, 1, 3, S.trim);                                                         // base course
      if (p0 >= 0) { quoinsAt(F, p0, 1, top - 1, S.stone); quoinsAt(F, p1 - 3, 1, top - 1, S.stone, true); }
      quoins(F, len, 1, top - 1, S.stone, 3);
      // cornice
      F.rect(0, top, len, top + 1, 3, S.trim);
      F.rect(0, top + 1, len, top + 2, 4, S.trim);
      for (let u = 0; u < len; ++u) F.rect(u, top + 2, u + 1, top + 3, u % 4 === 0 ? 6 : 4, S.trim);   // brackets
      F.rect(0, top + 3, len, top + 4, 5, S.trim); F.rect(0, top + 4, len, h, 6, S.trim);
      F.returns();
      return F;
    };
  }
  function quoinsAt(F, u0, v0, v1, mat, right) {
    for (let v = v0; v < v1; ++v) {
      const w = Math.floor(v / 4) % 2 ? 2 : 3;
      if (right) F.rect(u0 + 3 - w, v, u0 + 3, v + 1, 4, mat); else F.rect(u0, v, u0 + w, v + 1, 4, mat);
    }
  }

  // ---- tiers: facades with side info (front, back, left, right), roofs that skip the next tier
  function tier(E, C, W, D, t, y, party) {
    let k = 0;
    L.facades(E, t.x0, t.z0, t.x1, t.z1, y, (len, side, front) => t.skin(len, t.h, { side, front, which: k++ }), C, false, party);
  }

  // ---- parts
  function bladeSign(S, word, R) {
    const gl = word.split(''), sc = 2, lh = 7 * sc, gap = 3;
    const ph = gl.length * lh + (gl.length - 1) * gap + 8, pw = 5 * sc + 6, H = ph + 22;
    const M = new (L.VoxModel())(7, H + 2, pw + 8, 3, pw + 6);
    // model z: 0 at the wall, negative towards the street; x: -1..3 (panel 0..2)
    const zf = -pw - 2;
    M.box(0, 6, zf, 3, 6 + ph, -2, BM.NEON);                                                  // the glowing panel
    M.box(-1, 6, zf - 1, 4, 7, -1, BM.METAL); M.box(-1, 5 + ph, zf - 1, 4, 6 + ph, -1, BM.METAL);   // frame
    M.box(-1, 6, zf - 1, 4, 6 + ph, zf, BM.METAL); M.box(-1, 6, -2, 4, 6 + ph, -1, BM.METAL);
    for (const y of [8, 4 + ph]) M.box(-1, y, zf + 1, 4, y + 1, -2, BM.STEEL_DARK);           // stripes
    // letters on both faces (mirrored so each reads correctly), top to bottom
    gl.forEach((ch, i) => {
      const g = FONT[ch] || FONT.O, yTop = 5 + ph - 4 - i * (lh + gap);
      for (let r = 0; r < 7; ++r) for (let c = 0; c < 5; ++c) if (g[r][c] === '1') {
        const y = yTop - (r + 1) * sc;
        const zA = zf + 3 + c * sc, zB = zf + 3 + (4 - c) * sc;
        M.box(-1, y, zA, 0, y + sc, zA + sc, BM.LED);                                           // -x face
        M.box(3, y, zB, 4, y + sc, zB + sc, BM.LED);                                            // +x face
      }
    });
    // chevron tip below, crest with bulbs above, wall brackets
    for (let k = 0; k < 5; ++k) M.box(0, 5 - k, zf + 2 + k * 2, 3, 6 - k, -3 - k, BM.METAL);
    for (let k = 0; k < 6; ++k) M.box(0, 6 + ph + k * 2, zf + 2 + k * 2, 3, 8 + ph + k * 2, -2, k % 2 ? BM.NEON : BM.METAL);
    for (let z = zf + 2; z < -2; z += 3) M.box(-1, 7 + ph, z, 4, 8 + ph, z + 1, BM.LED);
    for (const y of [10, ph - 2]) M.box(0, y, -2, 3, y + 2, 1, BM.STEEL_DARK);
    void R;
    return { M, H };
  }

  function marqueeModel(w, d) {
    const M = new (L.VoxModel())(w + 2, 24, d + 2, 1, d + 1);
    // z: 0 at the wall, -d at the front edge; body y 1..5, soffit lights at y 0
    M.box(0, 1, -d, w, 5, 0, BM.BRONZE);                                                       // body
    M.box(1, 5, -d + 1, w - 1, 6, -1, BM.STEEL_DARK);                                          // roof
    for (let x = 0; x < w; ++x) M.box(x, 2, -d - 1, x + 1, 4, -d, x % 2 ? BM.LED : BM.METAL);  // bulb-lit fascia
    for (let z = -d; z < 0; ++z) { M.box(-1, 2, z, 0, 4, z + 1, z % 2 ? BM.LED : BM.METAL); M.box(w, 2, z, w + 1, 4, z + 1, z % 2 ? BM.LED : BM.METAL); }
    M.box(-1, 4, -d - 1, w + 1, 5, 0, BM.LED);                                                 // LED edge
    M.box(2, 0, -d + 2, w - 2, 1, -2, BM.LED);                                                 // soffit lights
    // tie rods to the wall
    for (const x of [3, w - 4]) for (let k = 0; k < d - 2; ++k) M.box(x, 6 + k, -d + 2 + k, x + 1, 7 + k, -d + 3 + k, BM.METAL);
    return M;
  }

  function doormanCanopy(w, d, mat) {
    const M = new (L.VoxModel())(w + 2, 18, d + 4, 1, d + 2);
    for (let z = -d; z < 0; ++z) {
      M.box(0, 12, z, w, 13, z + 1, mat);
      M.box(1, 13, z, w - 1, 14, z + 1, mat); M.box(2, 14, z, w - 2, 15, z + 1, mat);
    }
    M.box(0, 11, -d - 1, w, 13, -d, mat); M.box(1, 13, -d - 1, w - 1, 15, -d, mat);            // valance
    for (const x of [0, w - 1]) M.box(x, 0, -d, x + 1, 12, -d + 1, BM.BRONZE);                 // posts at the curb
    for (const x of [0, w - 1]) M.box(x, 11, -d + 1, x + 1, 12, 0, BM.BRONZE);
    return M;
  }

  function fireEscape(len, n) {
    // landings with railings on every floor, stairs between them, folded drop ladder at the bottom.
    // model x: 0 at the wall, negative outwards; z: 0..len along the wall
    const M = new (L.VoxModel())(8, n * FH + 8, len + 2, 7, 1);
    for (let f = 0; f < n; ++f) {
      const y = f * FH + 1;
      M.box(-5, y, 0, 0, y + 1, len, BM.STEEL_DARK);                                           // landing
      M.box(-5, y + 5, 0, -4, y + 6, len, BM.STEEL_DARK);                                      // top rail
      for (let z = 0; z < len; z += 3) M.box(-5, y + 1, z, -4, y + 5, z + 1, BM.STEEL_DARK);
      M.box(-5, y + 1, len - 1, -4, y + 5, len, BM.STEEL_DARK);
      M.box(-5, y + 5, 0, 0, y + 6, 1, BM.STEEL_DARK); M.box(-5, y + 5, len - 1, 0, y + 6, len, BM.STEEL_DARK);
      if (f < n - 1) for (let t = 0; t < FH; ++t) {                                             // stair flight
        const z = f % 2 ? 2 + Math.floor(t * (len - 6) / FH) : len - 3 - Math.floor(t * (len - 6) / FH);
        M.box(-3, y + 1 + t, z, -1, y + 2 + t, z + 2, BM.STEEL_DARK);
      }
    }
    return M;
  }

  function mansardModel(w, d, S, R) {
    const M = new (L.VoxModel())(w + 2, 90, d + 2, 1, 1);
    const hL = 18;
    for (let y = 0; y < hL; ++y) {
      const a = 1 + Math.floor(y / 4);
      M.box(a, y, a, w - a, y + 1, d - a, y % 4 === 3 ? S.crownDark : S.crown);
    }
    let a = 1 + Math.floor((hL - 1) / 4), y = hL;
    M.box(a - 1, y, a - 1, w - a + 1, y + 1, d - a + 1, S.trim);                                 // curb moulding
    for (let k = 1; k <= 3; ++k) { a += 2; M.box(a, y + k, a, w - a, y + k + 1, d - a, S.crown); }
    const yt = y + 4;
    M.box(a + 2, yt, a + 2, w - a - 2, yt + 1, d - a - 2, BM.ROOF_TAR);
    for (let x = a; x < w - a; x += 2) { M.box(x, yt, a, x + 1, yt + 2, a + 1, BM.METAL); M.box(x, yt, d - a - 1, x + 1, yt + 2, d - a, BM.METAL); }   // cresting
    // dormers on the lower slope, each face
    const dorm = (along, len, place) => {
      const cs = L.bays(len - 4, 11, 4);
      cs.forEach((c, k) => place(c + 2, k));
    };
    const lit = (k, s) => (L.H2(S.seed, k, s) < 0.4 ? BM.GLASS_LIT : BM.GLASS);
    dorm('x', w, (c, k) => {
      for (const [z0, dir] of [[1, 1], [d - 1, -1]]) {
        const zs = dir > 0 ? z0 : z0 - 4, ze = dir > 0 ? z0 + 4 : z0;
        M.box(c - 3, 2, zs, c + 3, 11, ze, S.trim);
        for (let s = 0; s < 3; ++s) M.box(c - 3 + s, 11 + s, zs, c + 3 - s, 12 + s, ze, S.crown);
        M.box(c - 2, 3, dir > 0 ? z0 : z0 - 1, c + 2, 10, dir > 0 ? z0 + 1 : z0, -1);
        M.box(c - 2, 3, dir > 0 ? z0 + 1 : z0 - 2, c + 2, 10, dir > 0 ? z0 + 2 : z0 - 1, lit(k, dir));
      }
    });
    dorm('z', d, (c, k) => {
      for (const [x0, dir] of [[1, 1], [w - 1, -1]]) {
        const xs = dir > 0 ? x0 : x0 - 4, xe = dir > 0 ? x0 + 4 : x0;
        M.box(xs, 2, c - 3, xe, 11, c + 3, S.trim);
        for (let s = 0; s < 3; ++s) M.box(xs, 11 + s, c - 3 + s, xe, 12 + s, c + 3 - s, S.crown);
        M.box(dir > 0 ? x0 : x0 - 1, 3, c - 2, dir > 0 ? x0 + 1 : x0, 10, c + 2, -1);
        M.box(dir > 0 ? x0 + 1 : x0 - 2, 3, c - 2, dir > 0 ? x0 + 2 : x0 - 1, 10, c + 2, lit(k + 50, dir));
      }
    });
    // flagpole + flag
    const cx = w >> 1, cz = d >> 1;
    M.box(cx - 1, yt, cz - 1, cx + 1, yt + 2, cz + 1, BM.METAL);
    M.box(cx, yt + 2, cz, cx + 1, yt + 40, cz + 1, BM.METAL);
    M.box(cx + 1, yt + 30, cz, cx + 12, yt + 38, cz + 1, pickFlag(R));
    M.box(cx, yt + 40, cz, cx + 1, yt + 41, cz + 1, BM.BRONZE);
    return M;
  }
  function pickFlag(R) { return L.pick(R, [BM.AWNING_RED, BM.AWNING_BLUE, BM.AWNING_GREEN]); }

  function tempiettoModel(w, d, S) {
    // limestone crown: stepped attic with urns, then an arcaded drum with a copper dome and lantern
    const M = new (L.VoxModel())(w + 2, 110, d + 2, 1, 1);
    let y = 0, a = 1;
    for (let s = 0; s < 2; ++s) {
      const x0 = a, x1 = w - a, z0 = a, z1 = d - a;
      M.box(x0, y, z0, x1, y + 9, z1, S.stone);
      M.box(x0 - 1, y + 8, z0 - 1, x1 + 1, y + 10, z1 + 1, S.trim);                              // cornice
      // attic windows between pilasters on every face
      for (let x = x0 + 3; x + 2 < x1 - 2; x += 5) for (const [zo, zi] of [[z0, z0 + 1], [z1 - 1, z1 - 2]]) {
        M.box(x, y + 2, zo, x + 2, y + 7, zo + 1, -1); M.box(x, y + 2, zi, x + 2, y + 7, zi + 1, L.H2(S.seed, x, zo + s) < 0.4 ? BM.GLASS_LIT : BM.GLASS);
      }
      for (let z = z0 + 3; z + 2 < z1 - 2; z += 5) for (const [xo, xi] of [[x0, x0 + 1], [x1 - 1, x1 - 2]]) {
        M.box(xo, y + 2, z, xo + 1, y + 7, z + 2, -1); M.box(xi, y + 2, z, xi + 1, y + 7, z + 2, L.H2(S.seed, z, xo + s) < 0.4 ? BM.GLASS_LIT : BM.GLASS);
      }
      // balustrade: balusters, top rail, urns on the corners
      for (let x = x0; x < x1; x += 3) { M.box(x, y + 10, z0 - 1, x + 1, y + 12, z0, S.trim); M.box(x, y + 10, z1, x + 1, y + 12, z1 + 1, S.trim); }
      for (let z = z0; z < z1; z += 3) { M.box(x0 - 1, y + 10, z, x0, y + 12, z + 1, S.trim); M.box(x1, y + 10, z, x1 + 1, y + 12, z + 1, S.trim); }
      M.box(x0 - 1, y + 12, z0 - 1, x1 + 1, y + 13, z0, S.trim); M.box(x0 - 1, y + 12, z1, x1 + 1, y + 13, z1 + 1, S.trim);
      M.box(x0 - 1, y + 12, z0, x0, y + 13, z1, S.trim); M.box(x1, y + 12, z0, x1 + 1, y + 13, z1, S.trim);
      for (const [ux, uz] of [[x0 - 1, z0 - 1], [x1 - 1, z0 - 1], [x0 - 1, z1 - 1], [x1 - 1, z1 - 1]]) {
        M.box(ux, y + 10, uz, ux + 2, y + 14, uz + 2, S.stone); M.box(ux, y + 14, uz, ux + 2, y + 16, uz + 2, BM.COPPER);
      }
      y += 10; a += 5;
    }
    const cx = w >> 1, cz = d >> 1, r = Math.max(5, Math.min(w, d) / 2 - a - 1);
    const drum = 16;
    for (let z = -r; z < r; ++z) for (let x = -r; x < r; ++x) {
      const q = Math.hypot(x + 0.5, z + 0.5);
      if (q > r) continue;
      M.box(cx + x, y, cz + z, cx + x + 1, y + 2, cz + z + 1, S.trim);
      if (q > r - 1.5) {                                                                        // arcade ring: piers + arches
        const ang = Math.atan2(z + 0.5, x + 0.5), open = Math.cos(ang * 8) > 0.2;
        M.box(cx + x, y + 2, cz + z, cx + x + 1, y + drum, cz + z + 1, open ? BM.GLASS_LIT : S.stone);
      } else M.box(cx + x, y + 2, cz + z, cx + x + 1, y + drum, cz + z + 1, S.stone);
      M.box(cx + x, y + drum, cz + z, cx + x + 1, y + drum + 2, cz + z + 1, S.trim);
      const dome = Math.round(Math.sqrt(Math.max(0, r * r - q * q)) * 0.9);
      M.box(cx + x, y + drum + 2, cz + z, cx + x + 1, y + drum + 2 + dome, cz + z + 1, BM.COPPER);
    }
    const yt = y + drum + 2 + Math.round(r * 0.9);
    M.box(cx - 2, yt, cz - 2, cx + 2, yt + 6, cz + 2, S.stone);
    M.box(cx - 1, yt + 6, cz - 1, cx + 1, yt + 9, cz + 1, BM.COPPER);
    M.box(cx, yt + 9, cz, cx + 1, yt + 22, cz + 1, BM.BRONZE);
    return M;
  }

  function stairBulkhead(S) {
    const M = new (L.VoxModel())(12, 16, 10, 0, 0);
    M.box(0, 0, 0, 10, 12, 8, S.brick);
    M.box(-0, 12, 0, 10, 13, 8, S.trim);
    M.box(3, 0, -1 + 1, 7, 9, 1, BM.STEEL_DARK);
    M.box(4, 1, 0, 6, 8, 1, BM.STEEL_DARK);
    return M;
  }

  function towerHotel(E, C, W, D, spec, R) {
    const brick = L.pick(R, [BM.BRICK_RED, BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BUFF]);
    const crownKind = L.pick(R, ['copper', 'copper', 'slate', 'tempietto', 'tempietto']);
    const S = {
      seed: spec.seed, brick, stone: L.pick(R, [BM.LIMESTONE, BM.LIMESTONE, BM.BUFF]),
      trim: brick === BM.BUFF ? BM.LIMESTONE : L.pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK]),
      lintel: brick === BM.BRICK_DARK ? BM.BRICK_BROWN : BM.BRICK_DARK, doorLeft: R() < 0.5,
      crown: crownKind === 'slate' ? BM.SHINGLE_SLATE : BM.COPPER, crownDark: crownKind === 'slate' ? BM.SHINGLE_SLATE : BM.COPPER
    };
    if (S.stone === S.trim) S.trim = BM.LIMESTONE_DARK;
    const n = Math.max(20, Math.min(38, Math.floor(9500 / (W + D)), Math.round(spec.floors * (0.9 + R() * 0.25))));   // ~90k tris cap
    const baseH = 41;
    // wedding cake: a street-wall shaft, then two or three setbacks; the slab variant keeps the front nearly flush
    const sideA = 4 + Math.floor(R() * 4);
    const ups = W >= 130 && R() < 0.5 ? 3 : 2, slab = R() < 0.3;
    const fr = [0.45 + R() * 0.12];
    for (let k = 0; k < ups; ++k) fr.push((1 - fr[0]) * (ups === 3 ? [0.45, 0.35, 0.2][k] : [0.62, 0.38][k]));
    const fl = fr.map(f => Math.max(3, Math.round(n * f)));
    const T = [{ x0: 0, z0: 0, x1: W, z1: D, h: baseH, skin: skinBase(S) }];
    let r = { x0: sideA, z0: 3, x1: W - sideA, z1: D - 4 }, f0 = 0;
    fl.forEach((nf, k) => {
      if (k > 0) {
        const wPrev = r.x1 - r.x0, sb = k === 1 ? 12 + Math.floor(R() * 5) : Math.max(8, Math.round(wPrev * (0.12 + R() * 0.06)));
        const fb = k === 1 && slab ? 4 : 10 + Math.floor(R() * 8);
        const nr = { x0: r.x0 + sb, z0: r.z0 + fb, x1: r.x1 - sb, z1: r.z1 - 5 };
        if (nr.x1 - nr.x0 < 26 || nr.z1 - nr.z0 < 26) { T[T.length - 1].h += nf * FH; return; }
        r = nr;
      }
      T.push(Object.assign({}, r, { nf, h: nf * FH + 6, skin: skinBrick(S, nf, { arched: true, f0 }), roof: { mat: S.trim, parapet: 3, units: 0 } }));
      f0 += nf;
    });
    // a tier that absorbed a skipped setback needs its skin rebuilt for its real floor count
    T.forEach((t, i) => { if (i > 0) { const nf = Math.round((t.h - 6) / FH); if (nf !== t.nf) { t.nf = nf; t.skin = skinBrick(S, nf, { arched: true, f0: 0 }); } } });
    T[T.length - 1].roof = { mat: S.trim, parapet: 0, units: 0 };
    let y = 0;
    const masks = T.map(t => L.rectMask(W, D, t.x0, t.z0, t.x1, t.z1, 0));
    T.forEach((t, i) => {
      tier(E, C, W, D, t, y, i === 0 ? spec.party : null);
      t.y = y; y += t.h;
      L.roofMask(E, C, masks[i], masks[i + 1] || null, W, D, y, t.roof || { mat: S.trim, parapet: 2, deck: BM.ROOF_TAR }, spec.seed + i * 17);
    });

    // crown
    const tC = T[T.length - 1], wc = tC.x1 - tC.x0, dc = tC.z1 - tC.z0;
    if (crownKind === 'tempietto') E.vox(C, tempiettoModel(wc - 2, dc - 2, S), tC.x0 + 1, y, tC.z0 + 1);
    else E.vox(C, mansardModel(wc - 2, dc - 2, S, R), tC.x0 + 1, y, tC.z0 + 1);

    // wooden water tanks and a stair bulkhead on the setback roofs
    const tankL = R() < 0.5;
    let tanks = 0;
    for (let i = 2; i < T.length && tanks < 3; ++i) {
      const lo = T[i - 1], up = T[i], yr = lo.y + lo.h, strip = up.x0 - lo.x0, front = up.z0 - lo.z0;
      const left = (tankL ? 0 : 1) ^ (i % 2);
      if (strip >= 12) { L.waterTank(E, left ? lo.x0 + (strip >> 1) : lo.x1 - (strip >> 1), up.z0 + Math.round((up.z1 - up.z0) * (0.5 + R() * 0.25)), yr, C); ++tanks; }
      if (front >= 14 && tanks < 3) { L.waterTank(E, left ? up.x1 - 8 : up.x0 + 8, lo.z0 + (front >> 1) + 1, yr, C); ++tanks; }
      if (i === 2 && strip >= 12) E.vox(C, stairBulkhead(S), left ? lo.x1 - (strip >> 1) - 5 : lo.x0 + (strip >> 1) - 5, yr, up.z1 - 14);
    }

    // blade sign on a front corner of the shaft
    const tA = T[1];
    const word = L.pick(R, ['HOTEL', 'HOTEL', 'ROYAL', 'ASTOR', 'PARK']);
    const sg = bladeSign(S, word, R);
    const signLeft = R() < 0.5;
    E.vox(C, sg.M, signLeft ? tA.x0 + 7 : tA.x1 - 10, baseH + 10, tA.z0);

    // marquee over the portal, doorman canopy at the side door
    const cs = L.bays(W, 12, 6), mid = cs.length >> 1;
    if (W > 40) E.vox(C, marqueeModel(27, 11), cs[mid] - 13, 14, 0);
    if (cs.length >= 5) {
      const c = S.doorLeft ? cs[1] : cs[cs.length - 2];
      E.vox(C, doormanCanopy(10, 15, L.pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE])), c - 5, 0, 0);
    }

    // fire escape on the side away from the sign
    const nFE = tA.nf - 1, len = 19;
    const zc = Math.round(tA.z0 + (tA.z1 - tA.z0) * 0.62);
    const fe = fireEscape(len, nFE);
    if (signLeft) L.rotated(E, tA.x1, zc, Math.PI, 0, 0).vox(C, fe, 0, baseH + FH, -(len >> 1));
    else E.vox(C, fe, tA.x0, baseH + FH, zc - (len >> 1));
  }

  A.registerTower('hotel', towerHotel);
})();
