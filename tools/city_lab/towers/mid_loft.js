// Loft-district mid-rises (downtown / old-town fringe), registered with CityArch.registerMid:
//  - castiron_loft        1870s-1890s SoHo cast-iron loft: painted iron front of stacked Corinthian columns between huge
//                         sash windows (round, segmental or flat heads), an entablature at every floor, a heavy bracketed
//                         cornice, shopfronts with a separate loft entrance, raised vault platforms at loading bays;
//                         brick side and party walls with loading docks under a steel canopy on a free side street.
//  - warehouse_conversion early-1900s brick warehouse converted to lofts: full-height brick piers, wide segmental-arched
//                         steel-sash windows over recessed spandrels, corbelled cornice, stepped parapet with a date stone,
//                         roll-up doors on a steel loading platform with a hung canopy, a faded ghost sign on a free side
//                         wall, and (often) a set-back glass-and-steel rooftop extension with a roof deck.
//  - prewar_apartment     1910s-1920s brick apartment house: limestone base, entrance portal with a canopy to the curb,
//                         a U-shaped light court on wide lots, iron fire escapes on the front, window AC units, belt
//                         courses and a bracketed cornice; roof dressed by the shared roof kit ('residential').
// Building-local voxels (0.25 m): x along the street, z into the lot (front at z = 0), y up.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, BASE = L.BASE;
  const VM = (w, h, d, ox, oz) => new (L.VoxModel())(w, h, d, ox, oz);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // preview-only overrides (?party=l|r|lr, ?shops=0|1); the city worker has no query string
  const DEVQ = (typeof location !== 'undefined' && location.search) ? new URLSearchParams(location.search) : null;

  function prep(spec, lo, hi) {
    const s = Object.assign({}, spec);
    s.party = Object.assign({}, spec.party || {});
    if (DEVQ && DEVQ.get('party') !== null) { const p = DEVQ.get('party'); s.party = { l: p.includes('l'), r: p.includes('r') }; }
    if (DEVQ && DEVQ.get('shops') !== null) s.shops = DEVQ.get('shops') === '1';
    if (s.shops === undefined) s.shops = true;
    s.floors = clamp(Math.round(s.floors || lo), lo, hi);
    return s;
  }

  // ------------------------------------------------------------------------------------------------ shared helpers
  // Facades along every straight run of a mask outline (like L.prism), but the skin learns which wall it is building:
  // info { dir: front|back|left|right, s, e, at, len, side, front (street face), court (recessed street face),
  //        party (attached neighbour), inner (court side wall), frontHi (side wall: u grows towards the street) }.
  // Corner returns are kept only at convex corners that are not party walls. Returns the run infos.
  function walls(E, C, mask, W, D, y0, h, skin, party) {
    party = party || {};
    const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1;
    const runs = [];
    for (let z = 0; z <= D; ++z) {
      let cur = null;
      for (let x = 0; x <= W; ++x) {
        const a = inn(x, z - 1), b = inn(x, z), t = x < W ? (b && !a ? 'nz' : a && !b ? 'pz' : null) : null;
        if (cur && cur.t !== t) { runs.push(cur); cur = null; }
        if (t && !cur) cur = { t, s: x, e: x + 1, L: z };
        else if (t) cur.e = x + 1;
      }
    }
    for (let x = 0; x <= W; ++x) {
      let cur = null;
      for (let z = 0; z <= D; ++z) {
        const a = inn(x - 1, z), b = inn(x, z), t = z < D ? (b && !a ? 'nx' : a && !b ? 'px' : null) : null;
        if (cur && cur.t !== t) { runs.push(cur); cur = null; }
        if (t && !cur) cur = { t, s: z, e: z + 1, L: x };
        else if (t) cur.e = z + 1;
      }
    }
    let minZ = D; for (const r of runs) if (r.t === 'nz') minZ = Math.min(minZ, r.L);
    const out = [];
    for (const r of runs) {
      const len = r.e - r.s;
      if (len < 1) continue;
      const side = r.t === 'nx' || r.t === 'px', outer = (r.t === 'nx' && r.L === 0) || (r.t === 'px' && r.L === W);
      const info = {
        dir: r.t === 'nz' ? 'front' : r.t === 'pz' ? 'back' : r.t === 'nx' ? 'left' : 'right', s: r.s, e: r.e, at: r.L, len, side,
        front: r.t === 'nz' && r.L <= minZ + 2, court: r.t === 'nz' && r.L > minZ + 2,
        party: !!(outer && party[r.t === 'nx' ? 'l' : 'r']), inner: side && !outer, frontHi: r.t === 'nx'
      };
      const F = skin(len, h, info);
      let keepLo = false, keepHi = false;
      if (!side) {
        const zA = r.t === 'nz' ? r.L : r.L - 1, zB = r.t === 'nz' ? r.L - 1 : r.L;
        const convex = (x) => !inn(x, zA) && !inn(x, zB);
        const okS = convex(r.s - 1) && !(r.s === 0 && party.l), okE = convex(r.e) && !(r.e === W && party.r);
        if (r.t === 'nz') { keepLo = okS; keepHi = okE; } else { keepLo = okE; keepHi = okS; }
      }
      for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) {
        if (!keepLo) F.set(-e, v, -1, 0);
        if (!keepHi) F.set(len - 1 + e, v, -1, 0);
      }
      const map = r.t === 'nz' ? (rx, ry, rz) => [r.s + rx - F.ext, y0 + rz, r.L + BASE - ry]
        : r.t === 'pz' ? (rx, ry, rz) => [r.e - (rx - F.ext), y0 + rz, r.L + (ry - BASE)]
        : r.t === 'nx' ? (rx, ry, rz) => [r.L + BASE - ry, y0 + rz, r.e - (rx - F.ext)]
        : (rx, ry, rz) => [r.L + (ry - BASE), y0 + rz, r.s + (rx - F.ext)];
      E.relief(F.H, F.M, F.w, F.h, map, (m) => m, C, BASE);
      out.push(info);
    }
    return out;
  }
  // relief u -> building (x, z) on a wall run (u measured along the relief, 0 at its low end)
  function wallPoint(info, u) {
    switch (info.dir) {
      case 'front': return [info.s + u, info.at];
      case 'back': return [info.e - u, info.at];
      case 'left': return [info.at, info.e - u];
      default: return [info.at, info.s + u];
    }
  }
  // an emitter whose model frame is "a part on this wall": model x along the wall (= relief u), model z outwards
  // negative (z = 0 on the wall plane), so one model built for the front fits any wall
  function wallEmitter(E, info, u) {
    const [x, z] = wallPoint(info, u);
    if (info.dir === 'front') return { E, x, z };
    const th = info.dir === 'right' ? Math.PI / 2 : info.dir === 'left' ? -Math.PI / 2 : Math.PI;
    return { E: L.rotated(E, x, z, th, 0, 0), x: 0, z: 0 };
  }
  function placeOnWall(E, C, info, u, y, M) { const w = wallEmitter(E, info, u); w.E.vox(C, M, w.x, y, w.z); }
  // roof as one height map at y over the lot: fn(x, z) -> [height, mat] | null
  function roofHM(E, C, W, D, y, fn) {
    const W2 = W + 2, H = new Int16Array(W2 * (D + 2)).fill(-1), M = new Uint8Array(W2 * (D + 2));
    for (let z = 0; z < D; ++z) for (let x = 0; x < W; ++x) {
      const c = fn(x, z);
      if (c) { const i = (z + 1) * W2 + x + 1; H[i] = c[0]; M[i] = c[1]; }
    }
    E.relief(H, M, W, D, (rx, ry, rz) => [rx, y + ry, rz], (m) => m, C);
  }
  function plain(len, h, m) { return new L.Relief(len, h, 0, m); }
  function clearExt(F) { for (let v = 0; v < F.h; ++v) for (let e = 1; e <= F.ext; ++e) { F.set(-e, v, -1, 0); F.set(F.w0 - 1 + e, v, -1, 0); } }
  // corner returns for rows v0..v1 only (the cornice): other projections stop flush at the corner
  function retRows(F, v0, v1) {
    for (let v = v0; v < v1; ++v) {
      const dl = F.get(0, v), dr = F.get(F.w0 - 1, v), ml = F.M[F.idx(0, v)], mr = F.M[F.idx(F.w0 - 1, v)];
      for (let e = 1; e <= F.ext; ++e) {
        if (dl > BASE + e - 1) F.set(-e, v, dl, ml);
        if (dr > BASE + e - 1) F.set(F.w0 - 1 + e, v, dr, mr);
      }
    }
  }
  // extra rows per column for an arched head of width ww and rise (segmental; rise = ww/2 is a round arch)
  function arcRows(ww, rise) {
    const a = [];
    if (rise <= 0) { for (let i = 0; i < ww; ++i) a.push(0); return a; }
    const c = ww / 2, Rr = (c * c + rise * rise) / (2 * rise);
    for (let i = 0; i < ww; ++i) { const x = i + 0.5 - c; a.push(Math.max(0, Math.round(rise - (Rr - Math.sqrt(Math.max(0, Rr * Rr - x * x)))))); }
    return a;
  }
  const glass = (S, a, b, lit, tint) => L.glassMat(S.seed, a, b, lit === undefined ? 0.32 : lit, tint);

  // 5x7 glyphs (ghost signs)
  const FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100']
  };
  // text painted flush into a relief, centred on u = cu, cap height 7*sc from vTop down. Walls are seen with u growing
  // to the viewer's left, so the text is laid out mirrored.
  function textWidth(t, sc) { return t.length * 6 * sc - sc; }
  function paintText(F, t, cu, vTop, sc, mat) {
    const w = textWidth(t, sc), uR = cu + (w >> 1);                      // reading starts at the high-u end
    for (let i = 0; i < t.length; ++i) {
      const g = FONT[t[i]];
      if (!g) continue;
      const ux = uR - i * 6 * sc;
      for (let r = 0; r < 7; ++r) for (let c = 0; c < 5; ++c) if (g[r][c] === '1') {
        const u = ux - (c + 1) * sc, v = vTop - (r + 1) * sc;
        F.rect(u, v, u + sc, v + sc, BASE, mat);
      }
    }
  }

  // iron fire escape (one VoxModel): platforms with railings at absolute heights Ys (platform top), stairs between them
  // through hatches, a drop ladder under the lowest one, brackets back to the wall.
  // Model frame: x 0..len along the wall, z < 0 outwards; the platform spans z in [-(off+dp), -off).
  // o.br: bracket x positions; o.touch: z of the wall surface the brackets meet; o.brace: diagonal braces.
  function fireEscapeModel(len, Ys, o) {
    const off = o.off, dp = o.dp, zo = -(off + dp), zi = -off, top = Ys[Ys.length - 1];
    const M = VM(len + 2, top + 8, off + dp + 3, 1, off + dp + 2), m = BM.STEEL_DARK;
    Ys.forEach((Y) => M.box(0, Y - 1, zo, len, Y, zi, m));
    // hatches + stairs (alternating direction), along the inner (wall) side of the platform
    for (let i = 0; i + 1 < Ys.length; ++i) {
      const y0 = Ys[i], rise = Ys[i + 1] - y0, run = Math.min(rise, len - 6), dir = i % 2 ? -1 : 1;
      const xs = dir > 0 ? 2 : len - 3;
      const xEnd = xs + dir * (run - 1);
      M.box(Math.min(xEnd, xEnd - dir * 5), Ys[i + 1] - 1, zi - 3, Math.max(xEnd, xEnd - dir * 5) + 1, Ys[i + 1], zi, -1);
      for (let t = 0; t < rise; ++t) {
        const x = xs + dir * Math.floor(t * run / rise);
        M.box(x, y0 + t, zi - 3, x + 1, y0 + t + 1, zi - 1, m);
      }
    }
    // railings: posts, mid and top rails on the outer edge and both ends
    Ys.forEach((Y) => {
      for (let x = 0; x < len; x += 4) M.box(x, Y, zo, x + 1, Y + 5, zo + 1, m);
      M.box(len - 1, Y, zo, len, Y + 5, zo + 1, m);
      for (const x of [0, len - 1]) { M.box(x, Y, zi - 1, x + 1, Y + 5, zi, m); M.box(x, Y + 4, zo, x + 1, Y + 5, zi, m); }
      M.box(0, Y + 4, zo, len, Y + 5, zo + 1, m);
      // brackets under the platform back to the wall (+ optional diagonal braces)
      (o.br || []).forEach((bx) => {
        M.box(bx, Y - 2, zo, bx + 1, Y - 1, o.touch, m);
        if (o.brace) for (let k = 0; k < 3; ++k) M.box(bx, Y - 3 - k, o.touch - 4 + k, bx + 1, Y - 2 - k, o.touch - 3 + k, m);
      });
    });
    // drop ladder (counterweighted, hanging under the lowest platform)
    const Y0 = Ys[0], lx = Ys.length % 2 ? len - 6 : 2;
    M.box(lx, Y0 - 1, zo + 1, lx + 4, Y0, zo + 3, -1);
    for (const x of [lx, lx + 3]) M.box(x, Y0 - 12, zo + 1, x + 1, Y0 + 4, zo + 2, m);
    for (let y = Y0 - 11; y < Y0 + 3; y += 2) M.box(lx + 1, y, zo + 1, lx + 3, y + 1, zo + 2, m);
    // gooseneck ladder over the parapet from the top platform
    if (o.gooseneck) for (const x of [len - 5, len - 2]) M.box(x, top, zo, x + 1, top + 7, zo + 1, m);
    return M;
  }

  // loading dock: concrete platform with a steel nosing, rubber bumpers and steps; optional steel canopy hung from tie rods.
  // Model frame as above (x along the wall 0..len, z < 0 outwards); penetrates the wall by one voxel.
  function dockModel(len, o) {
    const out = o.out || 9, ph = o.ph || 5, cy = o.canopyY || 0, cOut = o.canopyOut || 12;
    const M = VM(len + 10, Math.max(cy + 12, ph + 4), Math.max(out, cOut) + 5, 4, Math.max(out, cOut) + 3);
    M.box(0, 0, -out, len, ph, 1, BM.CONCRETE);
    M.box(0, ph - 1, -out - 1, len, ph, 1, o.deck || BM.STEEL_DARK);                       // steel deck / nosing
    for (let x = 2; x < len - 1; x += 6) M.box(x, 1, -out - 1, x + 2, ph - 2, -out, BM.TRIM_DARK);   // bumpers
    for (let s = 0; s < ph - 1; ++s) {                                                   // steps cut into one end
      const x0 = o.stepsLeft ? s * 2 : len - (s + 1) * 2;
      M.box(x0, s + 1, -out - 1, x0 + 2, ph, -out + 6, -1);
    }
    if (cy) {
      M.box(-2, cy, -cOut, len + 2, cy + 1, 1, BM.STEEL_DARK);                           // canopy deck
      M.box(-2, cy - 1, -cOut - 1, len + 2, cy + 2, -cOut, BM.STEEL_DARK);               // fascia channel
      M.box(0, cy - 1, -cOut + 2, len, cy, -cOut + 3, BM.LED);                           // light strip
      const wz = o.wallZ === undefined ? -1 : o.wallZ;
      for (const x of o.rods || [0, len - 1]) for (let k = 0; -cOut + k < wz; ++k) {   // tie rods up to the wall
        const y = cy + 1 + Math.floor(k * 0.6);
        M.box(x, y, -cOut + k, x + 1, y + 1, -cOut + k + 1, BM.STEEL_DARK);
      }
    }
    return M;
  }
  // street canopy (prewar entrance): fabric on a bronze frame, posts at the curb
  function canopyModel(w, d0, d1, mat) {
    const M = VM(w + 2, 18, d1 + 2, 1, d1 + 1);
    for (let z = -d1; z < -d0; ++z) { M.box(0, 12, z, w, 13, z + 1, mat); M.box(1, 13, z, w - 1, 14, z + 1, mat); M.box(3, 14, z, w - 3, 15, z + 1, mat); }
    M.box(0, 11, -d1 - 1, w, 13, -d1, mat); M.box(1, 13, -d1 - 1, w - 1, 15, -d1, mat);     // valance
    for (const x of [0, w - 1]) { M.box(x, 0, -d1, x + 1, 12, -d1 + 1, BM.BRONZE); M.box(x, 11, -d1 + 1, x + 1, 12, -d0, BM.BRONZE); }
    if (d1 - d0 > 20) for (const x of [0, w - 1]) M.box(x, 0, -d0 - 2, x + 1, 12, -d0 - 1, BM.BRONZE);
    M.box(2, 11, -d1 + 2, w - 2, 12, -d0 - 1, BM.LED);                                       // soffit lights
    return M;
  }

  // ================================================================================================ castiron_loft
  function castCols(len, S) {
    const nb = Math.max(2, Math.round((len - S.cw) / S.bayT)), cu = [];
    for (let k = 0; k <= nb; ++k) cu.push(Math.round(k * (len - S.cw) / nb));
    return cu;
  }
  // one storey of an engaged Corinthian column: plinth row, shaft with a raised fillet, leafy capital + abacus
  function castColumn(F, u, cw, v0, v1, S) {
    F.rect(u - 1, v0 - 1, u + cw + 1, v0, 5, S.paint);
    F.rect(u, v0, u + cw, v1, 4, S.paint);
    F.rect(u + 1, v0, u + cw - 1, v1, 5, S.paint);
    F.rect(u - 1, v1, u + cw + 1, v1 + 1, 5, S.paint);
    for (let x = u - 1; x < u + cw + 1; x += 2) F.rect(x, v1, x + 1, v1 + 1, 6, S.paint);  // acanthus leaves
    F.rect(u - 1, v1 + 1, u + cw + 1, v1 + 2, 6, S.paint);                                     // abacus
  }
  function castCornice(F, u0, u1, top, S, br, dent) {
    dent = dent || 2;
    F.rect(u0, top, u1, top + 1, 3, S.paint);                                                  // architrave
    F.rect(u0, top + 1, u1, top + 5, 3, S.paint);                                              // frieze
    F.rect(u0, top + 5, u1, top + 6, 4, S.paint);
    for (let u = u0; u < u1; ++u) F.rect(u, top + 6, u + 1, top + 7, u % dent ? 4 : 5, S.paint);   // dentils
    F.rect(u0, top + 7, u1, top + 8, 6, S.paint);
    F.rect(u0, top + 8, u1, top + 10, 7, S.paint);                                             // crown
    for (let i = 0; i < br.length; ++i) {
      const b = br[i];
      F.rect(b, top + 1, b + 2, top + 3, 4, S.paint); F.rect(b, top + 3, b + 2, top + 5, 5, S.paint); F.rect(b, top + 5, b + 2, top + 7, 6, S.paint);
      if (i + 1 < br.length && br[i + 1] - b > 7) F.rect(b + 3, top + 2, br[i + 1] - 1, top + 4, 2, S.paint);   // recessed frieze panel
    }
  }
  function spaced(u0, u1, step) { const a = [u0]; for (let u = u0 + step; u < u1 - step + 2; u += step) a.push(u); a.push(u1 - 2); return a; }
  function castRole(S, k, nb, info) {
    if (info.dir === 'front' && k === (S.entryLeft ? 0 : nb - 1)) return 'entry';
    if (S.shops) return (S.dockBay === k && info.dir === 'front') ? 'dock' : 'shop';
    return k % 2 === (S.entryLeft ? 1 : 0) ? 'dock' : 'show';
  }
  function castFront(S, len, h, info) {
    const F = new L.Relief(len, h, 5, S.paint), gH = S.gH, fh = S.fh, top = gH + S.n * fh, cw = S.cw;
    const cu = castCols(len, S), nb = cu.length - 1, salt = info.dir === 'front' ? 0 : 50;
    // ground storey: granite curb, cast-iron columns, shopfronts / loft entrance / loading bays, sign frieze
    F.rect(0, 0, len, 1, 3, BM.GRANITE_DARK);
    F.rect(0, gH - 3, len, gH - 1, 3, S.paint);
    F.rect(0, gH - 1, len, gH, 4, S.paint);
    for (let k = 0; k < nb; ++k) {
      const a = cu[k] + cw, b = cu[k + 1], c = (a + b) >> 1, role = castRole(S, k, nb, info);
      const g = glass(S, k + salt, 1, 0.6);
      if (role === 'entry') {                                                                  // the lofts' street door
        F.rect(a + 1, 1, b - 1, gH - 5, 1, S.sash);
        F.rect(a + 2, 1, b - 2, gH - 6, 0, g);                                               // glazed vestibule
        F.rect(c - 3, 0, c + 3, 14, 0, S.door); F.rect(c, 0, c + 1, 14, 1, S.sash);
        F.rect(c - 3, 14, c + 3, 16, 0, glass(S, k, 9, 0.8));
        F.rect(c - 4, 16, c + 4, 17, 3, S.paint);
        F.rect(a, gH - 3, b, gH - 1, 3, S.paint);
      } else if (role === 'shop') {
        F.rect(a + 1, 1, b - 1, 3, 1, S.sash);                                               // bulkhead
        F.rect(a + 1, 3, b - 1, gH - 8, 0, g);                                               // display window
        if (b - a >= 12) { F.rect(c - 2, 0, c + 2, gH - 8, 0, BM.STOREFRONT); F.rect(c - 3, 0, c - 2, gH - 8, 1, S.sash); F.rect(c + 2, 0, c + 3, gH - 8, 1, S.sash); }
        F.rect(a + 1, gH - 8, b - 1, gH - 7, 1, S.sash);                                     // transom bar
        F.rect(a + 1, gH - 7, b - 1, gH - 5, 0, g);
        for (let u = a + 4; u < b - 2; u += 4) F.rect(u, gH - 7, u + 1, gH - 5, 1, S.sash);
        F.rect(a, gH - 3, b, gH - 1, 3, S.signs[k % S.signs.length]);                        // shop sign in the frieze
      } else if (role === 'dock') {
        F.rect(a + 1, 1, b - 1, gH - 6, 1, BM.STEEL_DARK);                                   // roll-up door
        for (let v = 3; v < gH - 6; v += 2) F.rect(a + 1, v, b - 1, v + 1, 1, BM.METAL);
        F.rect(a + 1, gH - 6, b - 1, gH - 5, 3, BM.STEEL_DARK);
      } else {                                                                                 // showroom window
        F.rect(a + 1, 1, b - 1, 4, 1, S.sash);
        F.rect(a + 1, 4, b - 1, gH - 6, 1, g);
        F.rect(c, 4, c + 1, gH - 6, 2, S.paint);
        F.rect(a + 1, gH - 9, b - 1, gH - 8, 1, S.sash);
      }
    }
    cu.forEach((u) => castColumn(F, u, cw, 1, gH - 5, S));
    // upper storeys: arched sash windows filling the bays, a column order and an entablature at every floor
    for (let f = 0; f < S.n; ++f) {
      const v0 = gH + f * fh, vTop = v0 + fh - 5, head = f === S.n - 1 ? S.headTop : S.head;
      for (let k = 0; k < nb; ++k) {
        const a = cu[k] + cw, b = cu[k + 1], u0 = a + 1, ww = b - a - 2, c = (a + b) >> 1;
        F.rect(a, v0 + 1, b, v0 + 2, 3, S.paint);                                            // sill course
        const rise = head === 'round' ? Math.min(Math.ceil(ww / 2), 6) : head === 'seg' ? 2 : 0, vs = vTop - rise, arc = arcRows(ww, rise);
        const g = glass(S, k * 7 + salt, f + 3, 0.34);
        for (let i = 0; i < ww; ++i) {
          F.rect(u0 + i, v0 + 2, u0 + i + 1, vs + arc[i], 1, g);
          if (rise) F.rect(u0 + i, vs + arc[i], u0 + i + 1, Math.min(vTop + 1, vs + arc[i] + 1), 3, S.paint);   // archivolt
        }
        const mr = v0 + 2 + ((vs - v0 - 2) >> 1);
        F.rect(u0, mr, u0 + ww, mr + 1, 1, S.sash);                                          // meeting rails
        if (ww >= 8) { const mw = ww % 2 ? 1 : 2, mx = u0 + ((ww - mw) >> 1); F.rect(mx, v0 + 2, mx + mw, vs, 3, S.paint); }   // colonette
        if (rise) F.rect(c - 1, vTop, c + 1, vTop + 2, 4, S.paint);                          // keystone
        else { F.rect(u0, vTop, u0 + ww, vTop + 1, 3, S.paint); F.rect(u0 + 1, vTop + 1, u0 + ww - 1, vTop + 2, 2, S.sash); }
      }
      cu.forEach((u) => castColumn(F, u, cw, v0 + 1, vTop, S));
      if (f < S.n - 1) { F.rect(0, v0 + fh - 3, len, v0 + fh - 1, 3, S.paint); F.rect(0, v0 + fh - 1, len, v0 + fh, 4, S.paint); }
      else F.rect(0, v0 + fh - 3, len, v0 + fh, 3, S.paint);
    }
    const br = [0, len - 2]; cu.forEach((u, k) => { if (k > 0 && k < nb) br.push(u + (cw >> 1) - 1); if (k < nb) br.push(((u + cw + cu[k + 1]) >> 1) - 1); });
    br.sort((p, q) => p - q);
    castCornice(F, 0, len, top, S, br.filter((b, i) => i === 0 || i === br.length - 1 || (b - br[i - 1] >= 4 && br[br.length - 1] - b >= 4)));
    clearExt(F); retRows(F, top, h);
    return F;
  }
  function dockSpans(len, info, n) {
    const out = [], dw = 12;
    for (let i = 0; i < n; ++i) {
      const fromBack = 8 + i * (dw + 8);
      if (fromBack + dw > len - 22) break;
      out.push(info.frontHi ? [fromBack, fromBack + dw] : [len - fromBack - dw, len - fromBack]);
    }
    return out;
  }
  function castSide(S, len, h, info) {
    const F = new L.Relief(len, h, 5, S.brick), gH = S.gH, fh = S.fh, top = gH + S.n * fh, back = info.dir === 'back';
    const docks = !back && S.sideDocks ? dockSpans(len, info, len > 90 ? 2 : 1) : [];
    info.docks = docks;
    const cs = L.bays(len, S.sidePitch, 6);
    F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);
    docks.forEach(([a, b]) => {
      F.rect(a, 0, b, 14, 1, BM.STEEL_DARK);
      for (let v = 2; v < 14; v += 2) F.rect(a, v, b, v + 1, 1, BM.METAL);
      F.rect(a - 1, 14, b + 1, 15, 3, BM.STEEL_DARK);
    });
    const nearDock = (c) => docks.some(([a, b]) => c + 4 > a - 2 && c - 3 < b + 2);
    cs.forEach((c, k) => {
      if (!nearDock(c)) {                                                                     // high barred ground windows
        F.rect(c - 3, 6, c + 4, 7, 3, BM.GRANITE_DARK);
        F.rect(c - 2, 7, c + 3, gH - 5, 1, glass(S, k, 40, 0.25));
        for (let u = c - 1; u < c + 3; u += 2) F.rect(u, 7, u + 1, gH - 5, 1, BM.STEEL_DARK);
        F.rect(c - 3, gH - 5, c + 4, gH - 4, 3, BM.GRANITE_DARK);
      }
      for (let f = 0; f < S.n; ++f) {                                                        // segmental brick windows
        const v0 = gH + f * fh, g = glass(S, k * 5 + (back ? 90 : 60) + (info.frontHi ? 7 : 0), f, 0.3);
        F.rect(c - 3, v0 + 2, c + 4, v0 + 3, 3, S.sill);
        F.rect(c - 3, v0 + fh - 6, c + 4, v0 + fh - 4, BASE, S.brickDark);                  // rowlock arch
        F.rect(c - 2, v0 + 3, c + 3, v0 + fh - 6, 1, g);
        F.rect(c - 1, v0 + fh - 6, c + 2, v0 + fh - 5, 1, g);
        F.rect(c - 2, v0 + 3 + ((fh - 9) >> 1), c + 3, v0 + 4 + ((fh - 9) >> 1), 1, S.sash);
      }
    });
    if (!back) castCornice(F, 0, len, top, S, spaced(0, len, 12), 3);
    else { F.rect(0, top, len, top + 1, 3, S.brick); for (let u = 0; u < len; u += 2) F.rect(u, top + 1, u + 1, top + 2, 3, S.brick); }
    clearExt(F);
    return F;
  }
  function vaultPlatform(len) {
    // raised sidewalk vault in front of a loading bay: granite curb, diamond-plate steel, steps
    const M = VM(len + 8, 8, 12, 4, 10);
    M.box(0, 0, -8, len, 4, 1, BM.GRANITE_DARK);
    M.box(0, 3, -8, len, 4, 1, BM.STEEL_DARK);
    for (let s = 0; s < 3; ++s) M.box(len, 0, -8, len + 3, 3 - s, -8 + 3 + s * 2, BM.GRANITE_DARK);
    return M;
  }
  function castironLoft(E, C, W, D, spec0, R) {
    const spec = prep(spec0, 5, 7);
    const pal = L.pick(R, [
      { paint: BM.PAINT_CREAM, sash: BM.TRIM_DARK }, { paint: BM.SIDING_GRAY, sash: BM.SHUTTER_BLACK },
      { paint: BM.LIMESTONE_DARK, sash: BM.TRIM_DARK }, { paint: BM.PAINT_SAGE, sash: BM.SHUTTER_GREEN },
      { paint: BM.BUFF, sash: BM.DOOR_NAVY }, { paint: BM.TRIM, sash: BM.SHUTTER_BLACK }]);
    const brick = L.pick(R, [BM.BRICK_RED, BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN]);
    const S = {
      seed: spec.seed, paint: pal.paint, sash: pal.sash, brick, brickDark: brick === BM.BRICK_DARK ? BM.BRICK_BROWN : BM.BRICK_DARK,
      sill: L.pick(R, [BM.LIMESTONE, BM.GRANITE_DARK, BM.BUFF]), n: spec.floors - 1,
      gH: 20 + (R() < 0.5 ? 2 : 0), fh: 16 + (R() < 0.4 ? 1 : 0), cw: R() < 0.5 ? 3 : 4, bayT: 14 + Math.floor(R() * 5),
      head: L.pick(R, ['round', 'seg', 'flat', 'seg']), shops: spec.shops, entryLeft: R() < 0.5, sidePitch: 11 + Math.floor(R() * 3),
      door: L.pick(R, [BM.DOOR_NAVY, BM.DOOR_RED, BM.WOOD, BM.SHUTTER_BLACK]),
      signs: [L.pick(R, [BM.SHUTTER_BLACK, BM.DOOR_NAVY]), L.pick(R, [BM.SHUTTER_GREEN, BM.BRONZE, BM.DOOR_RED])],
      ironSide: D <= 100 && R() < 0.35, sideDocks: true, fe: R() < 0.55
    };
    S.headTop = R() < 0.5 ? 'round' : S.head;
    S.dockBay = R() < 0.4 ? 1 : -1;
    const h = S.gH + S.n * S.fh + 10;
    const mask = L.rectMask(W, D, 0, 0, W, D, 0);
    const infos = walls(E, C, mask, W, D, 0, h, (len, hh, info) => {
      if (info.party) return plain(len, hh, S.brick);
      if (info.dir === 'front' || (info.side && S.ironSide)) return castFront(S, len, hh, info);
      return castSide(S, len, hh, info);
    }, spec.party);
    // roof: paint parapet behind the cornice, a segmental pediment with the builder's name plate, brick elsewhere
    const ped = W >= 44 && R() < 0.7, pw = Math.min(28, Math.round(W * 0.4)) & ~1, px0 = (W - pw) >> 1, pa = arcRows(pw, ped ? 4 : 0);
    roofHM(E, C, W, D, h, (x, z) => {
      const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
      if (ped && z <= 1 && x >= px0 && x < px0 + pw) {
        const i = x - px0, hp = 6 + pa[i];
        return [z === 0 ? hp : hp - 1, S.paint];
      }
      if (!edge) return [0, BM.ROOF_TAR];
      return z === 0 ? [3, S.paint] : [2, S.brick];
    });
    const avoid = ped ? [[px0, 0, px0 + pw, 4]] : [];
    if (L.roofKit) L.roofKit(E, C, 2, 2, W - 2, D - 2, h, R, { style: 'historic', floors: spec.floors, avoid });
    // parts on the walls: loading docks on a free brick side, vault platforms at front loading bays, fire escape
    for (const info of infos) {
      if (info.docks && info.docks.length) {
        const [a, b] = info.docks[0], a2 = info.docks.length > 1 ? info.docks[1] : null;
        const u0 = Math.min(a, a2 ? a2[0] : a) - 3, u1 = Math.max(b, a2 ? a2[1] : b) + 3;
        placeOnWall(E, C, info, u0, 0, dockModel(u1 - u0, { canopyY: 17, canopyOut: 12, out: 8, stepsLeft: !info.frontHi, rods: [2, u1 - u0 - 3], wallZ: 0 }));
      }
      if (info.dir === 'front' && !info.party) {
        const cu = castCols(info.len, S), nb = cu.length - 1;
        for (let k = 0; k < nb; ++k) if (castRole(S, k, nb, info) === 'dock') {
          const a = cu[k] + S.cw, b = cu[k + 1];
          placeOnWall(E, C, info, a, 0, vaultPlatform(b - a));
        }
        if (S.fe && nb >= 2) {
          // fire escape across two bays (away from the loft entrance), platforms at sill level, brackets on the column plinths
          const k0 = S.entryLeft ? nb - 2 : 0, x0 = cu[k0] + 1, x1 = cu[k0 + 2] + S.cw - 1;
          const Ys = []; for (let f = 0; f < S.n; ++f) Ys.push(S.gH + f * S.fh + 2);
          const br = [cu[k0], cu[k0 + 1], cu[k0 + 2]].map((u) => u + (S.cw >> 1) - x0);
          placeOnWall(E, C, info, x0, 0, fireEscapeModel(x1 - x0, Ys, { off: 5, dp: 5, br, touch: -3, gooseneck: true }));
        }
      }
    }
  }

  // ================================================================================================ warehouse_conversion
  const GHOST = [['FURNITURE', 'WHOLESALE'], ['STORAGE', 'FIREPROOF'], ['COFFEE', 'ROASTERS'], ['PAPER BOX', 'COMPANY'],
    ['BISCUITS', 'BAKERY'], ['MOVING', 'STORAGE'], ['HARDWARE', 'SUPPLY'], ['PIANOS', 'ORGANS']];
  function whPiers(len, S) {
    const nb = Math.max(1, Math.round((len - S.pw) / S.bayT)), pu = [];
    for (let k = 0; k <= nb; ++k) pu.push(Math.round(k * (len - S.pw) / nb));
    return pu;
  }
  function whRole(S, k, nb, info) {
    if (info.dir !== 'front') return 'window';
    if (k === S.lobbyK(nb)) return 'lobby';
    if (S.dockK(nb) === k) return 'dock';
    return S.shops ? 'shop' : (k % 3 === 2 && S.dockK(nb) < 0 ? 'dock' : 'window');
  }
  function whCorbel(F, u0, u1, top, S) {
    F.rect(u0, top, u1, top + 1, 3, S.brick);
    for (let u = u0; u < u1; ++u) F.rect(u, top + 1, u + 1, top + 3, u % 3 === 0 ? 4 : 3, S.brick);   // corbel table
    F.rect(u0, top + 3, u1, top + 4, 4, S.brick);
    F.rect(u0, top + 4, u1, top + 5, 5, S.coping);
  }
  // steel-sash window: glass with a muntin grid (or the converted two-pane version), segmental head, rowlock arch, sill
  function whWindow(F, u0, ww, v0, v1, rise, S, g, k) {
    const arc = arcRows(ww, rise), vs = v1 - rise;
    F.rect(u0 - 1, v0 - 1, u0 + ww + 1, v0, 3, S.sill);
    for (let i = 0; i < ww; ++i) {
      F.rect(u0 + i, v0, u0 + i + 1, vs + arc[i], 1, g);
      F.rect(u0 + i, vs + arc[i], u0 + i + 1, vs + arc[i] + 2, BASE, S.arch);
    }
    F.rect(u0 - 1, vs - 1, u0, vs + 1, BASE, S.arch); F.rect(u0 + ww, vs - 1, u0 + ww + 1, vs + 1, BASE, S.arch);
    if (S.converted && L.H2(S.seed, k, v0) < 0.6) {                                           // replaced with modern glazing
      F.rect(u0 + (ww >> 1), v0, u0 + (ww >> 1) + 1, vs, 1, BM.STEEL_DARK);
      F.rect(u0, v0 + 3, u0 + ww, v0 + 4, 1, BM.STEEL_DARK);
    } else {
      for (let u = u0 + S.mp; u < u0 + ww - 1; u += S.mp) F.rect(u, v0, u + 1, vs, 1, BM.STEEL_DARK);
      for (let v = v0 + S.mp; v < vs - 1; v += S.mp) F.rect(u0, v, u0 + ww, v + 1, 1, BM.STEEL_DARK);
      F.rect(u0, v0 + ((vs - v0) >> 1), u0 + ww, v0 + ((vs - v0) >> 1) + 1, 1, BM.STEEL_DARK);   // pivot sash band
    }
  }
  function whFront(S, len, h, info) {
    const F = new L.Relief(len, h, 4, S.brick), gH = S.gH, fh = S.fh, top = gH + S.n * fh;
    const pu = whPiers(len, S), nb = pu.length - 1, salt = info.dir === 'front' ? 0 : 40;
    F.rect(0, 0, len, 3, 3, S.baseMat);                                                       // water table
    for (let k = 0; k < nb; ++k) {
      const a = pu[k] + S.pw, b = pu[k + 1], c = (a + b) >> 1, role = whRole(S, k, nb, info);
      if (role === 'dock') {
        F.rect(a + 1, 0, b - 1, gH - 6, 1, BM.STEEL_DARK);
        for (let v = 2; v < gH - 6; v += 2) F.rect(a + 1, v, b - 1, v + 1, 1, BM.METAL);
        F.rect(a, gH - 6, b, gH - 5, 3, BM.STEEL_DARK);                                      // steel lintel
        F.rect(a + 1, gH - 5, b - 1, gH - 3, 1, glass(S, k, 3, 0.4));                         // transom lights
      } else if (role === 'lobby') {
        const g = glass(S, k, 5, 0.85, 'dark');
        F.rect(a + 1, 0, b - 1, gH - 4, 0, g);                                                // glazed lobby in the old opening
        for (let u = a + 1; u < b - 1; u += 4) F.rect(u, 0, u + 1, gH - 4, 1, BM.STEEL_DARK);
        F.rect(a + 1, gH - 9, b - 1, gH - 8, 1, BM.STEEL_DARK);
        F.rect(c - 3, 0, c + 3, gH - 9, 0, BM.STOREFRONT);
        F.rect(a, gH - 4, b, gH - 3, 3, BM.STEEL_DARK);
      } else if (role === 'shop') {
        const ww = b - a - 2, arc = arcRows(ww, 2), g = glass(S, k + salt, 6, 0.6);
        for (let i = 0; i < ww; ++i) { F.rect(a + 1 + i, 2, a + 2 + i, gH - 6 + arc[i], 0, g); F.rect(a + 1 + i, gH - 6 + arc[i], a + 2 + i, gH - 4 + arc[i], BASE, S.arch); }
        F.rect(a + 1, 0, b - 1, 2, 1, BM.STEEL_DARK);
        for (let u = a + 1 + 4; u < b - 2; u += 5) F.rect(u, 2, u + 1, gH - 6, 1, BM.STEEL_DARK);
        F.rect(a + 1, gH - 10, b - 1, gH - 9, 1, BM.STEEL_DARK);
        F.rect(c - 2, 0, c + 2, gH - 10, 0, BM.STOREFRONT);
      } else {
        whWindow(F, a + 2, b - a - 4, 6, gH - 4, 2, S, glass(S, k + salt, 2, 0.35), k);
      }
    }
    for (let f = 0; f < S.n; ++f) {
      const v0 = gH + f * fh;
      for (let k = 0; k < nb; ++k) {
        const a = pu[k] + S.pw, b = pu[k + 1];
        F.rect(a + 1, v0, b - 1, v0 + 2, 1, S.brick);                                        // recessed spandrel panel
        if (S.paired && b - a >= 18) {
          const ww = (b - a - 6) >> 1;
          whWindow(F, a + 2, ww, v0 + 3, v0 + fh - 3, 1, S, glass(S, k * 9 + salt, f, 0.33), k + f);
          whWindow(F, b - 2 - ww, ww, v0 + 3, v0 + fh - 3, 1, S, glass(S, k * 9 + 4 + salt, f, 0.33), k + f + 5);
        } else whWindow(F, a + 2, b - a - 4, v0 + 3, v0 + fh - 3, 2, S, glass(S, k * 9 + salt, f, 0.33), k + f);
      }
    }
    pu.forEach((u) => {                                                                       // full-height piers, corbelled caps
      F.rect(u, 3, u + S.pw, top, 3, S.brick);
      F.rect(u, gH - 2, u + S.pw, gH, 4, S.baseMat);
      F.rect(u - 1, top - 2, u + S.pw + 1, top, 4, S.brick);
    });
    whCorbel(F, 0, len, top, S);
    clearExt(F); retRows(F, top, h);
    return F;
  }
  function whSide(S, len, h, info) {
    const F = new L.Relief(len, h, 4, S.brick), gH = S.gH, fh = S.fh, top = gH + S.n * fh, back = info.dir === 'back';
    F.rect(0, 0, len, 3, 3, S.baseMat);
    // a free side wall was built blank for a neighbour that never came: ghost sign near the street, a few windows behind
    const sign = !back && !info.inner && S.ghost && len >= 40 && S.n >= 3;
    let s0 = len, s1 = len;
    const docks = !back && S.sideDock ? dockSpans(len, info, 1) : [];
    info.docks = docks;
    if (sign) {
      const sw = Math.min(len - 12, 150), vT = top - 4, lines = S.words;
      let sc = 3; while (sc > 1 && textWidth(lines[0], sc) > sw - 8) --sc;
      const sc2 = Math.max(1, sc - 1), shH = 7 * sc + 7 * sc2 + 3 * sc + 6;
      const tw = Math.max(textWidth(lines[0], sc), textWidth(lines[1], sc2)) + 8;
      const cu = info.frontHi ? len - 6 - (tw >> 1) : 6 + (tw >> 1);
      s0 = cu - (tw >> 1); s1 = s0 + tw;
      F.rect(s0, vT - shH, s1, vT, BASE, S.ghostGround);
      F.rect(s0 + 1, vT - shH + 1, s1 - 1, vT - shH + 2, BASE, S.ghostInk); F.rect(s0 + 1, vT - 2, s1 - 1, vT - 1, BASE, S.ghostInk);
      paintText(F, lines[0], cu, vT - 3, sc, S.ghostInk);
      paintText(F, lines[1], cu, vT - 3 - 7 * sc - 2 * sc, sc2, S.ghostInk2);
      // the fading: patches of bare brick through the paint
      for (let i = 0; i < 14; ++i) {
        const u = s0 + Math.floor(L.H2(S.seed, i, 7) * tw), v = vT - shH + Math.floor(L.H2(S.seed, i, 8) * shH), w = 2 + Math.floor(L.H2(S.seed, i, 9) * 4);
        F.rect(u, v, Math.min(s1, u + w), Math.min(vT, v + 1 + (i % 2)), BASE, S.brick);
      }
      info.sign = [s0, s1];
    }
    const pitch = 14, cs = L.bays(len, pitch, 6);
    cs.forEach((c, k) => {
      if (sign && c + 6 > s0 - 4 && c - 6 < s1 + 4) return;
      if (!back && (k + (info.frontHi ? 0 : 1)) % 3 === 2) return;                         // lot-line walls: sparse windows
      for (let f = 0; f < S.n; ++f) whWindow(F, c - 4, 8, gH + f * fh + 3, gH + f * fh + fh - 3, 1, S, glass(S, k * 3 + (back ? 70 : 30), f, 0.3), k + f);
      if (!docks.some(([a, b]) => c + 6 > a - 3 && c - 6 < b + 3)) whWindow(F, c - 4, 8, 6, gH - 4, 1, S, glass(S, k, 41, 0.25), k);
    });
    docks.forEach(([a, b]) => {
      F.rect(a, 0, b, gH - 6, 1, BM.STEEL_DARK);
      for (let v = 2; v < gH - 6; v += 2) F.rect(a, v, b, v + 1, 1, BM.METAL);
      F.rect(a - 1, gH - 6, b + 1, gH - 5, 3, BM.STEEL_DARK);
    });
    if (!back) whCorbel(F, 0, len, top, S);
    else F.rect(0, top, len, top + 2, 3, S.brick);
    clearExt(F);
    return F;
  }
  function extSkin(S) {
    // rooftop extension: black steel frame and glass, slab edge, coping
    return (len, h, info) => {
      const F = new L.Relief(len, h, 0, BM.STEEL_DARK);
      const g = glass(S, info.s * 3 + info.at, 77, 0.55, S.extTint);
      F.rect(0, 1, len, h - 2, 1, g);
      for (let u = 0; u < len; u += 5) F.rect(u, 1, u + 1, h - 1, 3, BM.STEEL_DARK);
      F.rect(len - 1, 1, len, h - 1, 3, BM.STEEL_DARK);
      F.rect(0, h - 2, len, h, 3, BM.STEEL_DARK);
      F.rect(0, 7, len, 8, 1, BM.STEEL_DARK);
      if (info.dir === 'front') for (let u = 6; u + 6 < len; u += 15) F.rect(u, 1, u + 4, 9, 0, BM.STEEL_DARK);   // terrace doors
      return F;
    };
  }
  function warehouseConversion(E, C, W, D, spec0, R) {
    const spec = prep(spec0, 4, 9);
    const brick = L.pick(R, [BM.BRICK_RED, BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BUFF]);
    const ground = L.pick(R, [[BM.BRICK_DARK, BM.PAINT_CREAM, BM.PAINT_YELLOW], [BM.SHUTTER_BLACK, BM.PAINT_CREAM, BM.TRIM], [BM.PAINT_CREAM, BM.DOOR_RED, BM.SHUTTER_BLACK],
      [BM.SHUTTER_GREEN, BM.PAINT_CREAM, BM.PAINT_YELLOW], [BM.PAINT_SALMON, BM.SHUTTER_BLACK, BM.DOOR_NAVY]]);
    const S = {
      seed: spec.seed, brick, arch: brick === BM.BRICK_DARK ? BM.BRICK_BROWN : brick === BM.BUFF ? BM.BRICK_BROWN : BM.BRICK_DARK,
      sill: L.pick(R, [BM.LIMESTONE, BM.CONCRETE, BM.LIMESTONE_DARK]), baseMat: L.pick(R, [BM.CONCRETE, BM.GRANITE_DARK, BM.LIMESTONE_DARK]),
      coping: L.pick(R, [BM.LIMESTONE, BM.CONCRETE, BM.TERRACOTTA]), n: spec.floors - 1, gH: 19 + (R() < 0.5 ? 2 : 0), fh: 15,
      pw: R() < 0.5 ? 4 : 5, bayT: 20 + Math.floor(R() * 7), mp: R() < 0.5 ? 3 : 4, paired: R() < 0.35, converted: R() < 0.5,
      shops: spec.shops, ghost: R() < 0.85, words: L.pick(R, GHOST), ghostGround: ground[0], ghostInk: ground[1], ghostInk2: ground[2],
      sideDock: R() < 0.6, extTint: L.pick(R, ['dark', 'curtain', undefined])
    };
    if (S.ghostGround === S.brick || S.ghostGround === S.arch) S.ghostGround = BM.SHUTTER_BLACK;
    const lobbyLeft = R() < 0.5, dockAt = R();
    S.lobbyK = (nb) => (nb < 2 ? 0 : lobbyLeft ? 0 : nb - 1);
    S.dockK = (nb) => (nb < 2 ? -1 : nb === 2 ? (lobbyLeft ? 1 : 0) : (dockAt < 0.5 ? (lobbyLeft ? nb - 1 : 0) : 1 + Math.floor(dockAt * (nb - 2)) % (nb - 2)));
    const h = S.gH + S.n * S.fh + 5;
    const mask = L.rectMask(W, D, 0, 0, W, D, 0);
    const infos = walls(E, C, mask, W, D, 0, h, (len, hh, info) => {
      if (info.party) return plain(len, hh, S.brick);
      return info.dir === 'front' ? whFront(S, len, hh, info) : whSide(S, len, hh, info);
    }, spec.party);
    // rooftop extension, set back from the street and the sides
    const ex = { x0: spec.party.l ? 4 : 8, x1: W - (spec.party.r ? 4 : 8), z0: 14 + Math.floor(R() * 10), z1: D - 5 };
    const hasExt = S.n >= 3 && R() < 0.65 && ex.x1 - ex.x0 >= 28 && ex.z1 - ex.z0 >= 24;
    const inExt = (x, z) => hasExt && x >= ex.x0 && x < ex.x1 && z >= ex.z0 && z < ex.z1;
    const deck = hasExt ? { x0: ex.x0, x1: ex.x1, z0: 4, z1: ex.z0 } : null;
    // stepped parapet on the street front, with a stone date panel at the top step
    const nStep = W >= 80 ? 3 : W >= 48 ? 2 : 1, stepW = Math.round(W * (0.16 + R() * 0.06)), stepH = 2 + Math.floor(R() * 2);
    const ph = (x) => clamp(nStep - 1 - Math.floor((Math.abs(x + 0.5 - W / 2) - stepW / 2) / stepW), 0, nStep);
    roofHM(E, C, W, D, h, (x, z) => {
      if (inExt(x, z)) return null;
      const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
      if (z <= 1) {
        const k = ph(x), hh = 3 + k * stepH;                                                   // brick, with a stone coping behind the face
        return z === 0 ? [hh, S.brick] : [hh + 1, S.coping];
      }
      if (edge) return [3, S.brick];
      if (deck && x >= deck.x0 && x < deck.x1 && z >= deck.z0 && z < deck.z1) return [1, BM.WOOD];
      return [0, BM.ROOF_TAR];
    });
    const avoid = [[0, 0, W, 4]];
    if (hasExt) {
      const eh = S.fh + 1, em = L.rectMask(W, D, ex.x0, ex.z0, ex.x1, ex.z1, 0);
      walls(E, C, em, W, D, h, eh, extSkin(S), {});
      roofHM(E, C, W, D, h + eh, (x, z) => inExt(x, z) ? (x === ex.x0 || z === ex.z0 || x === ex.x1 - 1 || z === ex.z1 - 1 ? [1, BM.METAL] : [0, BM.ROOF_TAR]) : null);
      avoid.push([ex.x0 - 2, 0, ex.x1 + 2, ex.z1 + 2]);
      // planters along the deck's street edge
      if (deck.z1 - deck.z0 >= 8) E.vox(C, L.planterRowModel(deck.x1 - deck.x0 - 4), deck.x0 + 2, h + 1, deck.z0 + 1);
      if (L.roofKit) L.roofKit(E, C, ex.x0 + 2, ex.z0 + 2, ex.x1 - 2, ex.z1 - 2, h + eh, R, { style: 'office', floors: spec.floors, avoid: [] });
    }
    if (L.roofKit) L.roofKit(E, C, 2, 2, W - 2, D - 2, h, R, { style: 'industrial', floors: spec.floors, avoid });
    // loading platform with a hung canopy along the front loading bay(s), and on a free side
    for (const info of infos) {
      if (info.dir === 'front' && !info.party) {
        const pu = whPiers(info.len, S), nb = pu.length - 1, isDock = (k) => k >= 0 && k < nb && whRole(S, k, nb, info) === 'dock';
        for (let k = 0; k < nb; ++k) if (isDock(k) && !isDock(k - 1)) {                     // one platform per run of loading bays
          let k1 = k; while (isDock(k1 + 1)) ++k1;
          const a = pu[k], b = pu[k1 + 1] + S.pw, rods = [];
          for (let j = k; j <= k1 + 1; ++j) rods.push(pu[j] - a + (S.pw >> 1));
          placeOnWall(E, C, info, a, 0, dockModel(b - a, { canopyY: S.gH - 3, canopyOut: 12, out: 8, ph: 5, stepsLeft: k > 0, rods }));
        }
        const lk = S.lobbyK(nb);
        if (whRole(S, lk, nb, info) === 'lobby' && !isDock(lk - 1) && !isDock(lk + 1)) {   // steel entrance canopy
          // spans the bay and its piers; tie rods meet the pier faces
          const a = pu[S.lobbyK(nb)], b = pu[S.lobbyK(nb) + 1] + S.pw, w = b - a, M = VM(w + 2, 14, 11, 1, 10);
          M.box(0, 1, -8, w, 2, 1, BM.STEEL_DARK); M.box(0, 0, -9, w, 3, -8, BM.STEEL_DARK);
          M.box(S.pw + 1, 0, -6, w - S.pw - 1, 1, -5, BM.LED);
          for (const x of [S.pw >> 1, w - 1 - (S.pw >> 1)]) for (let k = 0; k < 7; ++k) M.box(x, 2 + k, -8 + k, x + 1, 3 + k, -7 + k, BM.STEEL_DARK);
          placeOnWall(E, C, info, a, S.gH - 5, M);
        }
      }
      if (info.docks && info.docks.length) {
        const [a, b] = info.docks[0];
        placeOnWall(E, C, info, a - 3, 0, dockModel(b - a + 6, { canopyY: S.gH - 3, canopyOut: 11, out: 8, stepsLeft: !info.frontHi, rods: [1, b - a + 4], wallZ: 0 }));
      }
    }
  }

  // ================================================================================================ prewar_apartment
  function aptCols(len, S) {
    if (S.paired) { const g = L.bays(len, 16, 5); const a = []; g.forEach((c) => a.push(c - 3, c + 3)); return a; }
    return L.bays(len, S.pitch, 5);
  }
  // fire escapes on a street front: pairs of windows away from the entrance; returns [{ u0, u1, br, wins }]
  function aptEscapes(len, info, S) {
    if (!info.front || info.party || len < 34) return [];
    const cs = aptCols(len, S), out = [];
    const mk = (i) => {
      const a = cs[i], b = cs[i + 1];
      if (b === undefined || b - a > 12) return null;
      return { u0: a - 5, u1: b + 5, br: [a - 4, b + 3], wins: [a, b] };
    };
    const n = cs.length, ent = info.entrance ? len >> 1 : -999;
    const cand = [];
    for (let i = 0; i + 1 < n; i += S.paired ? 2 : 1) { const e = mk(i); if (e && (e.u1 < ent - 8 || e.u0 > ent + 8)) cand.push(e); }
    if (!cand.length) return [];
    const pickI = S.feLeft ? cand.length - 1 : 0;
    out.push(cand[pickI]);
    if (len >= 110 && cand.length >= 3) out.push(cand[cand.length - 1 - pickI]);
    return out;
  }
  function aptCornice(F, u0, u1, top, S) {
    if (S.corn === 'bracket') {
      F.rect(u0, top, u1, top + 1, 3, S.trim);
      F.rect(u0, top + 1, u1, top + 4, 3, S.trim);
      for (let u = u0; u < u1; ++u) F.rect(u, top + 4, u + 1, top + 5, u % 2 ? 3 : 4, S.trim);
      for (let u = u0; u < u1 - 1; u += 6) F.rect(u, top + 1, u + 2, top + 5, 5, S.trim);
      F.rect(u1 - 2, top + 1, u1, top + 5, 5, S.trim);
      F.rect(u0, top + 5, u1, top + 6, 5, S.trim); F.rect(u0, top + 6, u1, top + 7, 6, S.trim);
    } else {                                                                                   // stone cornice + frieze of panels
      F.rect(u0, top, u1, top + 2, 3, S.stone);
      for (let u = u0 + 2; u < u1 - 4; u += 8) F.rect(u, top + 2, u + 5, top + 4, 2, S.frieze);
      F.rect(u0, top + 4, u1, top + 5, 4, S.stone); F.rect(u0, top + 5, u1, top + 6, 5, S.stone); F.rect(u0, top + 6, u1, top + 7, 5, S.stone);
    }
  }
  function aptWall(S, len, h, info) {
    const F = new L.Relief(len, h, 4, S.brick), gH = S.gH, fh = S.fh, top = gH + S.n * fh;
    const back = info.dir === 'back', street = info.front || info.court, salt = (info.dir.length * 31 + info.s * 7 + info.at) | 0;
    const cs = back ? L.bays(len, 14, 6) : info.side && !info.inner ? L.bays(len, len > 90 ? 13 : 11, 6) : aptCols(len, S);
    const esc = aptEscapes(len, info, S), escWin = new Set(); esc.forEach((e) => e.wins.forEach((w) => escWin.add(w)));
    info.esc = esc;
    const stoneTo = back ? 0 : gH + (S.base2 ? fh : 0);
    // limestone base: rusticated courses, belt course on top
    if (stoneTo) {
      F.rect(0, 0, len, stoneTo, BASE, S.stone);
      F.rect(0, 0, len, 2, 3, BM.GRANITE_DARK);
      if (street) for (let v = 4; v < gH - 3; v += 3) F.rect(0, v, len, v + 1, 1, S.stoneDark);   // rustication joints
      F.rect(0, gH - 2, len, gH - 1, 3, S.stone); F.rect(0, gH - 1, len, gH, 4, S.stone);
      if (S.base2) F.rect(0, stoneTo - 1, len, stoneTo, 3, S.stone);
    }
    // ground storey: entrance portal, shopfronts or windows
    const ent = info.entrance ? len >> 1 : -999;
    if (info.entrance) {
      const c = ent;
      F.rect(c - 8, 2, c + 8, gH - 2, 4, S.stone);                                            // portal surround
      F.rect(c - 6, 2, c + 6, gH - 5, 0, BM.BRONZE);
      F.rect(c - 5, 2, c - 1, 12, 0, glass(S, salt, 1, 0.9, 'dark')); F.rect(c + 1, 2, c + 5, 12, 0, glass(S, salt, 2, 0.9, 'dark'));
      F.rect(c - 5, 13, c + 5, gH - 6, 0, BM.GLASS_LIT);                                      // lit transom
      F.rect(c - 9, gH - 3, c + 9, gH - 1, 5, S.stone);                                       // entablature
      F.rect(c - 2, gH - 1, c + 2, gH + 1, 5, S.stone);                                       // cartouche
    }
    const shopFront = S.shops && info.front && !back;
    if (shopFront) {
      // storefronts between stone piers, awnings, the base belt above
      const segs = [];
      const cut = info.entrance ? [[2, ent - 10], [ent + 10, len - 2]] : [[2, len - 2]];
      cut.forEach(([a, b]) => { const n = Math.max(1, Math.round((b - a) / 26)); for (let i = 0; i < n; ++i) segs.push([Math.round(a + i * (b - a) / n), Math.round(a + (i + 1) * (b - a) / n)]); });
      segs.forEach(([a, b], i) => {
        if (b - a < 8) return;
        F.rect(a + 1, 2, b - 1, 4, 1, BM.TRIM_DARK);
        F.rect(a + 1, 4, b - 1, gH - 7, 0, glass(S, salt + i, 4, 0.6));
        F.rect(a + 1, gH - 7, b - 1, gH - 5, 1, S.signs[i % S.signs.length]);
        const dc = (i % 2) ? a + 4 : b - 4;
        F.rect(dc - 2, 2, dc + 2, gH - 7, 0, BM.STOREFRONT);
        if (S.awnings) F.rect(a + 1, gH - 5, b - 1, gH - 3, 6, S.awning[i % 2]);
        F.rect(a - 1, 2, a + 1, gH - 2, 3, S.stone); F.rect(b - 1, 2, b + 1, gH - 2, 3, S.stone);
      });
    } else {
      cs.forEach((c, k) => {
        if (Math.abs(c - ent) < 12) return;
        const g = glass(S, salt + k, 0, 0.3);
        F.rect(c - 2, 5, c + 2, gH - 5, 1, g);
        F.rect(c - 2, 5 + ((gH - 10) >> 1), c + 2, 6 + ((gH - 10) >> 1), 1, BM.TRIM);
        F.rect(c - 3, 4, c + 3, 5, 3, stoneTo ? S.stone : S.sill);
        if (stoneTo) { F.rect(c - 3, gH - 5, c + 3, gH - 4, 3, S.stone); F.rect(c - 1, gH - 4, c + 1, gH - 3, 3, S.stone); }
        else F.rect(c - 3, gH - 5, c + 3, gH - 4, 3, S.lintel);
      });
    }
    // upper storeys: double-hung windows with stone sills and keyed lintels, AC units, belt courses
    for (let f = 0; f < S.n; ++f) {
      const v0 = gH + f * fh, inStone = v0 < stoneTo, topF = f === S.n - 1;
      if (topF && !back) F.rect(0, v0 + 2, len, v0 + 3, 3, S.stone);                          // sill course under the top floor
      cs.forEach((c, k) => {
        const g = glass(S, salt + k * 5, f, 0.33);
        F.rect(c - 3, v0 + 2, c + 3, v0 + 3, 3, inStone ? S.stoneDark : S.sill);
        if (topF && S.topArch && !back) {
          F.rect(c - 2, v0 + 3, c + 2, v0 + 10, 1, g); F.rect(c - 1, v0 + 10, c + 1, v0 + 11, 1, g);
          F.rect(c - 3, v0 + 10, c - 1, v0 + 12, 3, S.stone); F.rect(c + 1, v0 + 10, c + 3, v0 + 12, 3, S.stone); F.rect(c - 1, v0 + 11, c + 1, v0 + 13, 4, S.stone);
        } else {
          F.rect(c - 2, v0 + 3, c + 2, v0 + 11, 1, g);
          F.rect(c - 3, v0 + 11, c + 3, v0 + 12, 3, inStone ? S.stoneDark : S.lintel);
          if (street && S.keys) F.rect(c - 1, v0 + 12, c + 1, v0 + 13, 3, S.lintel);
        }
        F.rect(c - 2, v0 + 7, c + 2, v0 + 8, 1, BM.TRIM);                                    // meeting rail
        if (!escWin.has(c) && !back && L.H2(S.seed + salt, k, f) < S.ac) {                    // window AC unit
          F.rect(c - 2, v0 + 3, c + 2, v0 + 5, 4, BM.METAL); F.rect(c - 2, v0 + 5, c + 2, v0 + 6, 3, BM.LOUVER);
        }
      });
      if (S.belts && f > 0 && f % 3 === 0 && !topF && !back) F.rect(0, v0 + 12, len, v0 + 13, 3, S.stone);
    }
    // quoins on street corners
    if (S.quoins && !back) for (let v = stoneTo; v < top; ++v) {
      const w = Math.floor(v / 3) % 2 ? 2 : 4;
      F.rect(0, v, w, v + 1, BASE, S.stone); F.rect(len - w, v, len, v + 1, BASE, S.stone);
    }
    if (street || (info.side && !info.inner)) aptCornice(F, 0, len, top, S);
    else if (info.inner) aptCornice(F, 0, len, top, S);
    else F.rect(0, top, len, top + 2, 3, S.brick);
    clearExt(F); retRows(F, top, h);
    return F;
  }
  function courtModel(w, d, R, S) {
    // light court: stone paving, iron fence with a gate at the street, planting beds along the wings
    const M = VM(w + 2, 30, d + 2, 1, 1);
    M.box(-1, 0, 0, w + 1, 1, d + 1, S.stoneDark);
    for (let z = 2; z < d; z += 6) M.box(1, 0, z, w - 1, 1, z + 1, BM.CONCRETE);
    for (let x = 1; x < w - 1; x += 2) M.box(x, 1, 0, x + 1, 7, 1, BM.SHUTTER_BLACK);         // pickets
    M.box(1, 6, 0, w - 1, 7, 1, BM.SHUTTER_BLACK);
    for (const x of [1, w - 2]) M.box(x - 1, 1, 0, x + 1, 9, 2, S.stone);                      // gate piers
    const gx = (w >> 1) - 4; M.box(gx, 1, 0, gx + 8, 7, 1, -1);
    for (let x = gx; x < gx + 8; x += 2) M.box(x, 1, 0, x + 1, 8, 1, BM.SHUTTER_BLACK);
    for (const x0 of [1, w - 7]) {
      M.box(x0, 1, 3, x0 + 6, 3, d - 3, S.stone); M.box(x0 + 1, 2, 4, x0 + 5, 3, d - 4, BM.GRASS);
      for (let z = 6; z < d - 6; z += 9) { M.box(x0 + 1, 3, z - 1, x0 + 5, 6, z + 2, R() < 0.5 ? BM.LEAF : BM.LEAF_DARK); }
    }
    return M;
  }
  function prewarApartment(E, C, W, D, spec0, R) {
    const spec = prep(spec0, 6, 12);
    const brick = L.pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BUFF, BM.BRICK_DARK, BM.BRICK_RED]);
    const stone = L.pick(R, [BM.LIMESTONE, BM.LIMESTONE, BM.BUFF, BM.LIMESTONE_DARK]);
    const S = {
      seed: spec.seed, brick, stone: brick === BM.BUFF && stone === BM.BUFF ? BM.LIMESTONE : stone, stoneDark: BM.LIMESTONE_DARK,
      sill: L.pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK]), lintel: L.pick(R, [BM.LIMESTONE, BM.LIMESTONE_DARK, BM.TERRACOTTA]),
      trim: L.pick(R, [BM.TRIM_DARK, BM.LIMESTONE_DARK, BM.TRIM, BM.COPPER]), frieze: L.pick(R, [BM.TERRACOTTA, BM.BUFF, BM.LIMESTONE_DARK]),
      n: spec.floors - 1, gH: 18, fh: 13, base2: R() < 0.45, paired: R() < 0.5, pitch: 8 + (R() < 0.5 ? 1 : 0), quoins: R() < 0.35,
      topArch: R() < 0.4, keys: R() < 0.6, belts: R() < 0.5, corn: R() < 0.6 ? 'bracket' : 'stone', ac: 0.1 + R() * 0.15,
      shops: spec.shops, awnings: R() < 0.7, awning: [L.pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE]), L.pick(R, [BM.AWNING_GREEN, BM.AWNING_BLUE, BM.AWNING_RED])],
      signs: [BM.SHUTTER_BLACK, BM.DOOR_NAVY, BM.SHUTTER_GREEN], feLeft: R() < 0.5,
      canopy: L.pick(R, [BM.AWNING_GREEN, BM.AWNING_BLUE, BM.AWNING_RED, BM.SHUTTER_BLACK])
    };
    if (S.stone === S.stoneDark) S.stoneDark = BM.CONCRETE;
    const h = S.gH + S.n * S.fh + 7;
    // light court on wide lots: a U open to the street
    const court = W >= 104 && D >= 70 && R() < 0.8;
    let mask, cr = null;
    if (court) {
      const cw = Math.round(W * (0.3 + R() * 0.1)) & ~1, cd = clamp(Math.round(D * (0.28 + R() * 0.12)), 18, D - 40);
      cr = { x0: (W - cw) >> 1, x1: ((W - cw) >> 1) + cw, z0: 0, z1: cd };
      mask = L.rectMask(W, D, 0, 0, W, D, 0);
      for (let z = cr.z0; z < cr.z1; ++z) for (let x = cr.x0; x < cr.x1; ++x) mask[z * W + x] = 0;
    } else mask = L.rectMask(W, D, 0, 0, W, D, 0);
    const infos = walls(E, C, mask, W, D, 0, h, (len, hh, info) => {
      if (info.party) return plain(len, hh, S.brick);
      info.entrance = court ? info.court : info.front;
      return aptWall(S, len, hh, info);
    }, spec.party);
    const inn = (x, z) => x >= 0 && z >= 0 && x < W && z < D && mask[z * W + x] === 1;
    const par = 3 + Math.floor(R() * 2);
    roofHM(E, C, W, D, h, (x, z) => {
      if (!inn(x, z)) return null;
      const edge = !inn(x - 1, z) || !inn(x + 1, z) || !inn(x, z - 1) || !inn(x, z + 1);
      if (!edge) return [0, BM.ROOF_TAR];
      const streetEdge = !inn(x, z - 1);
      return [streetEdge ? par : 2, streetEdge ? (S.corn === 'stone' ? S.stone : S.brick) : S.brick];
    });
    // roof kit on the block behind the court (or the whole roof); bulkheads and tanks go there
    const rz0 = court ? cr.z1 + 2 : 2;
    if (L.roofKit) L.roofKit(E, C, 2, rz0, W - 2, D - 2, h, R, { style: 'residential', floors: spec.floors, avoid: [] });
    // fire escapes, entrance canopy, light court
    const Ys = []; for (let f = S.base2 ? 1 : 0; f < S.n; ++f) Ys.push(S.gH + f * S.fh + 2);
    for (const info of infos) {
      (info.esc || []).forEach((e) => placeOnWall(E, C, info, e.u0, 0, fireEscapeModel(e.u1 - e.u0, Ys, { off: 2, dp: 5, br: e.br.map((b) => b - e.u0), touch: 0, brace: true, gooseneck: true })));
      if (info.entrance && !info.party) {
        const reach = 14 + (info.court ? info.at : 0);
        placeOnWall(E, C, info, (info.len >> 1) - 6, 0, canopyModel(12, 3, reach, S.canopy));
      }
    }
    if (court) E.vox(C, courtModel(cr.x1 - cr.x0, cr.z1, R, S), cr.x0, 0, 0);
  }

  A.registerMid('castiron_loft', castironLoft, { minW: 8, maxW: 30, minFloors: 5, maxFloors: 7, zones: ['mid', 'row'] });
  A.registerMid('warehouse_conversion', warehouseConversion, { minW: 14, maxW: 40, minFloors: 4, maxFloors: 9, zones: ['mid', 'row', 'core'] });
  A.registerMid('prewar_apartment', prewarApartment, { minW: 12, maxW: 40, minFloors: 6, maxFloors: 12, zones: ['mid', 'row', 'core'] });
})();
