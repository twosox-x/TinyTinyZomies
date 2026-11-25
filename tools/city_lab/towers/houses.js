// Suburban houses (phase 3), registered with CityArch.registerHouse(name, fn, { minW, maxW, minD, maxD (m), weight }).
//  - colonial     centre-hall two-storey colonial: symmetric bays, shutters, centre door under a pediment / flat
//                 balustraded portico / door hood / full porch, side gable, exterior brick end chimney, side garage wing.
//  - cape_cod     one-and-a-half storey cape: steep side gable, gable dormers lined up over the bays, cedar shakes or
//                 clapboard, pilastered door surround, central or end chimney, set-back garage wing.
//  - ranch        long one-storey ranch: low hip or side gable with wide eaves, picture window, brick wainscot or
//                 all-brick, recessed entry porch on posts, garage under the same roof or a front-gable "snout" garage.
//  - craftsman    craftsman bungalow: low front gable with deep eaves, exposed rafter tails and knee braces, deep
//                 porch on tapered columns over stone piers with a knee wall, grouped windows, shingle gable, side chimney.
//  - split_level  side-split: two-level wing (brick lower level, cantilevered siding upper level, tuck-under garage)
//                 beside a one-level wing half a storey up, entry stoop with iron rail, picture window, low gables.
//  - victorian    Queen Anne: steep hip with a front gable wing (fish-scale shingles, bay window, gable ornament),
//                 round corner turret with a conical roof, wraparound porch with turned posts and spindle frieze.
//  - tudor        Tudor revival: brick ground floor, half-timbered stucco upper storey and gables, steep cross gable,
//                 steep entry vestibule with a round-arched door, massive front chimney, casement window groups.
//  - farmhouse    modern farmhouse: board-and-batten, black window frames, steep gable with a front gable wing,
//                 standing-seam metal porch roof on cedar posts, carriage garage doors with gooseneck lights.
//  - dutch_colonial gambrel roof with flared eaves and a long shed dormer, shutters, hooded door, end chimney.
//
// Each house is one voxel model (25 cm, L.BV) greedy-meshed as a single solid, so nothing inside a house is ever
// coplanar or see-through. Everything (eaves, gutters, porch, steps, chimney, attached garage) stays inside the
// W x D footprint; the yard kit owns lawns, walks and the driveway (including the apron in front of the garage door,
// which is the footprint's front edge or a few voxels behind it). Layouts are drawn with the garage / driveway on
// the right (+x) and mirrored whole when spec.side === 'l'.
// Roofs are voxel height fields: the top t layers are the roof material (risers included), cells below the roof
// skin over the walls are the gable / attic material, overhangs are slabs; walls are never painted roof-coloured.
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, H2 = L.H2;
  const DEVQ = (typeof location !== 'undefined' && location.search) ? new URLSearchParams(location.search) : null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (R, a) => a[Math.floor(R() * a.length) % a.length];
  const even = (v) => v - (v & 1);
  const HMAX = 64;

  // ------------------------------------------------------------------------------------------------ colours
  // a slightly darker companion colour (siding courses, battens, shingles); the registered shades or a close material
  const PAL = A.ARCH_PALETTE, SHC = {};
  const ALT = { [BM.WOOD]: BM.BRICK_BROWN, [BM.LIMESTONE]: BM.LIMESTONE_DARK, [BM.WHITE_CONCRETE]: BM.LIMESTONE, [BM.GRANITE_DARK]: BM.STEEL_DARK,
                [BM.STEEL_DARK]: BM.GRANITE_DARK, [BM.BUFF]: BM.LIMESTONE_DARK, [BM.TRIM]: BM.SIDING_WHITE, [BM.LIMESTONE_DARK]: BM.CONCRETE };
  function alt(m) {
    if (SHC[m] !== undefined) return SHC[m];
    let r = ALT[m] !== undefined ? ALT[m] : m;
    const c = PAL[m];
    if (ALT[m] === undefined && c) {
      const t = c.map(v => Math.round(v * 0.9));
      for (let i = 113; i < 141; ++i) { const p = PAL[i]; if (p && p[0] === t[0] && p[1] === t[1] && p[2] === t[2]) { r = i; break; } }
    }
    return (SHC[m] = r);
  }

  // ------------------------------------------------------------------------------------------------ voxel grid
  // y-major like VoxModel; o[] marks roof cells (part id) so roofs never repaint walls
  class Grid {
    constructor(W, D) { this.W = W; this.D = D; this.H = HMAX; this.v = new Uint8Array(W * D * HMAX); this.o = new Uint8Array(W * D * HMAX); }
    in(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
    set(x, y, z, m, own) { if (!this.in(x, y, z)) return; const i = (y * this.D + z) * this.W + x; this.v[i] = m < 0 ? 0 : m + 1; this.o[i] = own || 0; }
    get(x, y, z) { return this.in(x, y, z) ? this.v[(y * this.D + z) * this.W + x] - 1 : -1; }
    own(x, y, z) { return this.in(x, y, z) ? this.o[(y * this.D + z) * this.W + x] : 0; }
    paint1(x, y, z, m) { if (!this.in(x, y, z)) return; const i = (y * this.D + z) * this.W + x; if (this.v[i]) this.v[i] = m + 1; }
    box(x0, y0, z0, x1, y1, z1, m) {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0); x1 = Math.min(this.W, x1); y1 = Math.min(this.H, y1); z1 = Math.min(this.D, z1);
      const v = m < 0 ? 0 : m + 1;
      for (let y = y0; y < y1; ++y) for (let z = z0; z < z1; ++z) { const r = (y * this.D + z) * this.W; for (let x = x0; x < x1; ++x) { this.v[r + x] = v; this.o[r + x] = 0; } }
    }
  }
  function ctx(C, W, D, spec, R) {
    const side = (DEVQ && DEVQ.get('side')) || spec.side || 'r';
    const garage = DEVQ && DEVQ.get('garage') !== null ? DEVQ.get('garage') === '1' : !!spec.garage;
    return { C, W, D, R, spec, seed: spec.seed | 0, g: new Grid(W, D), parts: [], k: 0, mirror: side === 'l', garage, floors: spec.floors || 2 };
  }
  function emit(E, c) {
    const VM = L.VoxModel(), M = new VM(c.W, HMAX, c.D, 0, 0), src = c.g.v, W = c.W;
    if (!c.mirror) M.v.set(src);
    else for (let r = 0; r < src.length; r += W) for (let x = 0; x < W; ++x) M.v[r + W - 1 - x] = src[r + x];
    E.vox(c.C, M, 0, 0, 0);
  }

  // ------------------------------------------------------------------------------------------------ faces
  // a wall face of rect r: u along the face (front / back from x0, sides from the front), d = 0 the outer wall layer,
  // d < 0 outside (sills, shutters), d > 0 inside (glass, door leaves)
  function F(r, s) {
    if (s === 'f') return { len: r.x1 - r.x0, p: (u, d) => [r.x0 + u, r.z0 + d] };
    if (s === 'b') return { len: r.x1 - r.x0, p: (u, d) => [r.x1 - 1 - u, r.z1 - 1 - d] };
    if (s === 'l') return { len: r.z1 - r.z0, p: (u, d) => [r.x0 + d, r.z0 + u] };
    return { len: r.z1 - r.z0, p: (u, d) => [r.x1 - 1 - d, r.z0 + u] };
  }
  function fs(g, f, u0, u1, y0, y1, d0, d1, m, paint) {
    for (let d = d0; d < d1; ++d) for (let u = u0; u < u1; ++u) {
      const p = f.p(u, d);
      for (let y = y0; y < y1; ++y) paint ? g.paint1(p[0], y, p[1], m) : g.set(p[0], y, p[1], m);
    }
  }
  // symmetric positions (left edges) of n openings of width w on a face of length len, margin m
  function spread(len, n, w, m) {
    if (n <= 1) return [(len - w) >> 1];
    const st = (len - 2 * m - w) / (n - 1), out = [];
    for (let i = 0; i < n; ++i) out.push(i < n / 2 ? Math.round(m + i * st) : 0);
    for (let i = 0; i < n; ++i) if (i >= n / 2) out[i] = len - w - out[n - 1 - i];
    return out;
  }

  // ------------------------------------------------------------------------------------------------ walls
  const PAT = {
    lap: (S, yb) => (u, y) => ((y - yb) % 2 === 1 ? S.wall2 : S.wall),
    plain: (S) => () => S.wall,
    bnb: (S) => (u) => (u % 3 === 1 ? S.wall2 : S.wall),
    shake: (S, seed) => (u, y) => (y % 2 === 0 ? S.wall2 : (H2(seed, u >> 1, y) < 0.2 ? S.wall2 : S.wall))
  };
  function skin(c, r, y0, y1, pat, o) {
    o = o || {};
    for (const s of (o.faces || 'fblr')) {
      const f = F(r, s);
      for (let u = 0; u < f.len; ++u) { const [x, z] = f.p(u, 0); for (let y = y0; y < y1; ++y) c.g.paint1(x, y, z, pat(u, y, s)); }
    }
    if (o.corner) for (const [x, z] of [[r.x0, r.z0], [r.x1 - 1, r.z0], [r.x0, r.z1 - 1], [r.x1 - 1, r.z1 - 1]]) for (let y = y0; y < y1; ++y) c.g.paint1(x, y, z, o.corner);
  }
  // solid body with siding above the foundation
  function walls(c, r, yT, fl, pat, corner, o) {
    o = o || {};
    c.g.box(r.x0, o.y0 || 0, r.z0, r.x1, yT, r.z1, c.S.wall);
    skin(c, r, fl, yT, pat, { corner, faces: o.faces });
    if (fl > (o.y0 || 0)) skin(c, r, o.y0 || 0, fl, () => o.found || c.S.found, { faces: o.faces });
  }
  // a projecting band (belt course, water table) around a rect
  function band(c, r, y, m, h) { c.g.box(r.x0 - 1, y, r.z0 - 1, r.x1 + 1, y + (h || 1), r.z1 + 1, m); }

  // ------------------------------------------------------------------------------------------------ openings
  // window: opening u..u+w, y..y+h, glazing one voxel in, flush casing ring, sill, optional head cap / lintel / shutters
  function win(c, f, u, y, w, h, o) {
    o = o || {};
    const g = c.g, S = c.S, tr = o.trim !== undefined ? o.trim : S.trim;
    if (tr !== null) fs(g, f, u - 1, u + w + 1, y - 1, y + h + 1, 0, 1, tr, true);
    fs(g, f, u, u + w, y, y + h, 0, 1, -1);
    const gl = L.glassMat(c.seed, ++c.k, y, o.lit !== undefined ? o.lit : 0.33);
    fs(g, f, u, u + w, y, y + h, 1, 2, gl);
    const sash = o.sash !== undefined ? o.sash : (tr !== null ? tr : S.trim);
    if (o.rail !== false && h >= 5) { const ry = o.railY !== undefined ? y + o.railY : y + (h >> 1); fs(g, f, u, u + w, ry, ry + 1, 1, 2, sash); }
    if (o.mull) for (const m of o.mull) fs(g, f, u + m, u + m + 1, y + (o.mullLo || 0), y + h, 1, 2, sash);
    if (o.sill !== false) fs(g, f, u - 1 - (o.sillX || 0), u + w + 1 + (o.sillX || 0), y - 1, y, -1, 0, o.sillM || (tr !== null ? tr : S.trim));
    if (o.cap) fs(g, f, u - 2, u + w + 2, y + h, y + h + 1, -1, 0, o.cap);
    if (o.lintel) fs(g, f, u - 1, u + w + 1, y + h, y + h + 1, 0, 1, o.lintel);
    if (o.shut) { const sw = o.sw || 2; fs(g, f, u - 1 - sw, u - 1, y, y + h, -1, 0, o.shut); fs(g, f, u + w + 1, u + w + 1 + sw, y, y + h, -1, 0, o.shut); }
  }
  // entrance door: leaf one voxel in, casing, optional glass lite, sidelights, transom, pilasters + entablature, lamp
  function door(c, f, u, y, w, h, o) {
    o = o || {};
    const g = c.g, S = c.S, tr = o.trim || S.trim, sl = o.side ? 2 : 0, tt = o.transom ? 2 : 0;
    const gl = L.glassMat(c.seed, ++c.k, 3, 0.55);
    fs(g, f, u - 1 - sl, u + w + 1 + sl, y, y + h + 1 + tt, 0, 1, tr, true);
    fs(g, f, u, u + w, y, y + h, 0, 1, -1);
    fs(g, f, u, u + w, y, y + h, 1, 2, o.m || S.door);
    if (o.lite) fs(g, f, u + 1, u + w - 1, y + h - 3, y + h - 1, 1, 2, gl);
    if (o.side) for (const su of [u - 2, u + w + 1]) { fs(g, f, su, su + 1, y, y + h, 0, 1, -1); fs(g, f, su, su + 1, y, y + h, 1, 2, gl); }
    if (o.transom) { fs(g, f, u - sl, u + w + sl, y + h + 1, y + h + 2, 0, 1, -1); fs(g, f, u - sl, u + w + sl, y + h + 1, y + h + 2, 1, 2, gl); }
    const top = y + h + 1 + tt;
    if (o.pil) {
      fs(g, f, u - 2 - sl, u - 1 - sl, y, top, -1, 0, tr); fs(g, f, u + w + 1 + sl, u + w + 2 + sl, y, top, -1, 0, tr);
      fs(g, f, u - 3 - sl, u + w + 3 + sl, top, top + 1, -1, 0, tr);
    }
    if (o.lamp) { const lu = o.pil ? u - 4 - sl : u - 3 - sl; fs(g, f, lu, lu + 1, y + 5, y + 7, -1, 0, BM.GLASS_LIT); fs(g, f, lu, lu + 1, y + 7, y + 8, -1, 0, BM.STEEL_DARK); }
  }
  // sectional / carriage garage door, recessed one voxel, with casing
  function gdoor(c, f, u, w, h, st) {
    const g = c.g, S = c.S;
    fs(g, f, u - 1, u + w + 1, 0, h + 1, 0, 1, st.casing || S.trim, true);
    fs(g, f, u, u + w, 0, h, 0, 1, -1);
    const gl = st.glass || BM.GLASS_DARK;
    for (let y = 0; y < h; ++y) for (let i = 0; i < w; ++i) {
      let m = st.m;
      if (st.kind === 'panel') m = (y % 2 === 1 || i % 4 === 3) ? st.m2 : st.m;
      else if (st.kind === 'carriage') m = (y === (h >> 1) || i === (w >> 1) || i % 2 === 1) ? st.m2 : st.m;
      else if (st.kind === 'modern') m = y % 2 === 1 ? st.m2 : st.m;
      if (st.win && y === h - 2 && (st.kind === 'carriage' ? i !== (w >> 1) && i % 3 !== 0 : i % 4 !== 3)) m = gl;
      if (st.band && y >= h - 3 && y < h - 1) m = gl;
      fs(g, f, u + i, u + i + 1, y, y + 1, 1, 2, m);
    }
  }
  function steps(c, x0, x1, z, top, m) { for (let i = 1; i < top; ++i) c.g.box(x0, 0, z - i, x1, top - i, z - i + 1, m); }
  // balustrade along a line (x0..x1 or z0..z1 one voxel thick): balusters every other voxel, hand rail on top
  function rail(c, x0, z0, x1, z1, y, m, h, every) {
    h = h || 3; every = every || 2;
    c.g.box(x0, y + h, z0, x1, y + h + 1, z1, m);
    for (let z = z0; z < z1; ++z) for (let x = x0; x < x1; ++x) if (((x + z) % every) === 0) c.g.box(x, y, z, x + 1, y + h, z + 1, m);
  }
  function vent(c, f, uc, ytop, w, h) {
    const u = uc - (w >> 1);
    fs(c.g, f, u - 1, u + w + 1, ytop - h - 1, ytop + 1, 0, 1, c.S.trim, true);
    fs(c.g, f, u, u + w, ytop - h, ytop, 0, 1, BM.LOUVER, true);
  }

  // ------------------------------------------------------------------------------------------------ roofs
  // part: body rect x0..x1, z0..z1, wall top y; kind gx (ridge along x), gz (ridge along z), hip, gam (gambrel along x),
  // shf (shed rising from the front edge), shl / shr (rising from the left / right edge), flat; s slope (rise per voxel),
  // gambrel: k break distance, s2 upper slope; flare: slope over the eave overhang; ov per side; t roof skin thickness;
  // lift: attic rows under a flat / porch roof (the fascia band); attic material (or fn(u, y)); gut / ds gutters, downspouts
  function part(c, o) {
    const P = Object.assign({ t: 1, s: 0.6, mat: c.S.roof, attic: c.S.wall, lift: 0 }, o);
    P.ov = typeof P.ov === 'number' ? { f: P.ov, b: P.ov, l: P.ov, r: P.ov } : Object.assign({ f: 0, b: 0, l: 0, r: 0 }, P.ov || {});
    // the skin is at least as thick as the tallest step, so risers are roof-coloured and slabs stay closed
    P.t = Math.max(P.t, Math.ceil(P.s - 1e-6), P.s2 ? Math.ceil(P.s2 - 1e-6) : 0, P.flare ? Math.ceil(P.flare - 1e-6) : 0);
    c.parts.push(P);
    return P;
  }
  function hAt(P, x, z) {
    const dl = x - P.x0, dr = P.x1 - 1 - x, df = z - P.z0, db = P.z1 - 1 - z;
    let d;
    switch (P.kind) {
      case 'gz': d = Math.min(dl, dr); break;
      case 'hip': d = Math.min(dl, dr, df, db); break;
      case 'shf': d = df; break;
      case 'shl': d = dl; break;
      case 'shr': d = dr; break;
      case 'flat': d = Math.min(0, dl, dr, df, db); break;
      default: d = Math.min(df, db);
    }
    let f;
    if (P.kind === 'flat') f = 0;
    else if (d < 0 && P.flare !== undefined) f = d * P.flare;
    else if (P.kind === 'gam') f = d < P.k ? d * P.s : P.k * P.s + (d - P.k) * P.s2;
    else f = d * P.s;
    return P.y + P.lift + P.t + Math.floor(f + 1e-6);
  }
  function ridgeOf(P) { return hAt(P, (P.x0 + P.x1) >> 1, (P.z0 + P.z1) >> 1); }
  function eachCol(P, fn) {
    for (let z = P.z0 - P.ov.f; z < P.z1 + P.ov.b; ++z) for (let x = P.x0 - P.ov.l; x < P.x1 + P.ov.r; ++x)
      fn(x, z, hAt(P, x, z), x >= P.x0 && x < P.x1 && z >= P.z0 && z < P.z1);
  }
  function roofs(c) {
    const g = c.g, parts = c.parts;
    // 1: volumes (attic under the skin inside the walls, slabs over the overhangs); walls and masses are never overwritten
    parts.forEach((P, i) => eachCol(P, (x, z, hs, inn) => {
      const lo = inn ? P.y : hs - P.t, at = hs - P.t, u = P.kind === 'gz' ? x - P.x0 : z - P.z0;
      for (let y = Math.max(0, lo); y < hs; ++y) {
        if (g.get(x, y, z) >= 0 && g.own(x, y, z) === 0) continue;
        g.set(x, y, z, y < at ? (typeof P.attic === 'function' ? P.attic(u, y) : P.attic) : P.mat, i + 1);
      }
    }));
    // 2: every part's skin back on top (crossing parts may have filled it with attic)
    parts.forEach((P) => eachCol(P, (x, z, hs) => {
      for (let y = Math.max(0, hs - P.t); y < hs; ++y) {
        const o = g.own(x, y, z);
        if (o && g.get(x, y, z) >= 0) g.set(x, y, z, P.seam && y === hs - 1 && x % 3 === 0 ? P.seam : P.mat, o);
      }
    }));
    parts.forEach((P) => gutter(c, P));
    c.parts = [];
  }
  function gutter(c, P) {
    if (!P.gut) return;
    const g = c.g, m = P.gutM || c.S.gut;
    const xa = P.x0 - P.ov.l, xb = P.x1 + P.ov.r, za = P.z0 - P.ov.f, zb = P.z1 + P.ov.b;
    const gy = (x, z) => hAt(P, x, z) - P.t - 1;
    for (const e of P.gut) {
      if (e === 'f' && P.ov.f > 0) for (let x = xa; x < xb; ++x) g.set(x, gy(x, za), za, m);
      if (e === 'b' && P.ov.b > 0) for (let x = xa; x < xb; ++x) g.set(x, gy(x, zb - 1), zb - 1, m);
      if (e === 'l' && P.ov.l > 0) for (let z = za; z < zb; ++z) g.set(xa, gy(xa, z), z, m);
      if (e === 'r' && P.ov.r > 0) for (let z = za; z < zb; ++z) g.set(xb - 1, gy(xb - 1, z), z, m);
    }
    for (const d of P.ds || []) {
      const e = d[0], k = d[1];
      if (e === 'f' || e === 'b') {
        const x = k === 'l' ? P.x0 : P.x1 - 1, zg = e === 'f' ? za : zb - 1, zc = e === 'f' ? P.z0 - 1 : P.z1;
        const y = gy(x, zg);
        g.box(x, y, Math.min(zg, zc), x + 1, y + 1, Math.max(zg, zc) + 1, m);
        g.box(x, 0, zc, x + 1, y, zc + 1, m);
      } else {
        const z = k === 'f' ? P.z0 : P.z1 - 1, xg = e === 'l' ? xa : xb - 1, xc = e === 'l' ? P.x0 - 1 : P.x1;
        const y = gy(xg, z);
        g.box(Math.min(xg, xc), y, z, Math.max(xg, xc) + 1, y + 1, z + 1, m);
        g.box(xc, 0, z, xc + 1, y, z + 1, m);
      }
    }
  }
  // chimney: stack xa..xb, za..zb up to top, optional wider base below yS, cap course and a dark flue
  function chimney(c, xa, za, xb, zb, top, m, o) {
    o = o || {};
    const g = c.g;
    if (o.base) { const b = o.base; g.box(b[0], 0, b[1], b[2], o.yS, b[3], m); g.box(xa, o.yS === undefined ? 0 : o.yS, za, xb, top, zb, m); }
    else g.box(xa, o.y0 || 0, za, xb, top, zb, m);
    const cm = o.cap || BM.LIMESTONE_DARK;
    g.box(xa - 1, top - 1, za - 1, xb + 1, top, zb + 1, cm);
    if (o.corbel) g.box(xa - 1, top - 3, za - 1, xb + 1, top - 2, zb + 1, m);
    if (o.pots) for (const [px, pz] of o.pots) g.box(px, top, pz, px + 1, top + 2, pz + 1, BM.TERRACOTTA);
    else { g.box(xa + 1, top - 1, za + 1, xb - 1, top, zb - 1, -1); g.box(xa + 1, top - 2, za + 1, xb - 1, top - 1, zb - 1, BM.STEEL_DARK); }
  }

  // ------------------------------------------------------------------------------------------------ porches, garages
  // deck (skirt + floor boards), columns along the front edge, optional rails on front / sides, steps
  function porch(c, o) {
    const g = c.g;
    g.box(o.x0, 0, o.z0, o.x1, o.fl, o.z1, o.skirt);
    g.box(o.x0, o.fl - 1, o.z0, o.x1, o.fl, o.z1, o.deck);
    if (o.rail) {
      const [ga, gb] = o.gap || [0, 0];
      for (let x = o.x0; x < o.x1; ) {
        if (x >= ga && x < gb) { x = gb; continue; }
        let x1 = x; while (x1 < o.x1 && !(x1 >= ga && x1 < gb)) ++x1;
        rail(c, x, o.z0, x1, o.z0 + 1, o.fl, o.railM);
        x = x1;
      }
      if (o.sideRail !== false) { rail(c, o.x0, o.z0, o.x0 + 1, o.z1 - 1, o.fl, o.railM); rail(c, o.x1 - 1, o.z0, o.x1, o.z1 - 1, o.fl, o.railM); }
    }
    for (const x of o.cols) g.box(x, o.fl, o.z0, x + o.cw, o.beam, o.z0 + o.cw, o.colM);
    if (o.steps) steps(c, o.steps[0], o.steps[1], o.z0, o.fl, o.stepM || o.deck);
  }
  function garageStyle(R, S, kind) {
    const k = kind || pick(R, ['panel', 'panel', 'panel', 'carriage']);
    if (k === 'carriage') return pick(R, [{ kind: k, m: BM.WOOD, m2: BM.BRICK_BROWN, win: true }, { kind: k, m: BM.TRIM, m2: BM.SIDING_WHITE, win: true }, { kind: k, m: BM.SHUTTER_BLACK, m2: BM.STEEL_DARK, win: true }]);
    if (k === 'modern') return { kind: k, m: BM.STEEL_DARK, m2: BM.SHUTTER_BLACK, band: true };
    const m = R() < 0.75 ? BM.TRIM : (S.wall === BM.SIDING_WHITE || S.wall === BM.PAINT_CREAM ? BM.PAINT_CREAM : BM.TRIM);
    return { kind: 'panel', m, m2: alt(m === BM.TRIM ? BM.SIDING_WHITE : m), win: R() < 0.35 };
  }
  // garage doors on the front face of gr (one wide, or two singles with a pier), coach lights
  function garageDoors(c, gr, h, st, twin, lights) {
    const f = F(gr, 'f'), gw = gr.x1 - gr.x0;
    if (gw >= 24 && twin) { const w = (gw - 9) >> 1; gdoor(c, f, 3, w, h, st); gdoor(c, f, gw - 3 - w, w, h, st); if (lights) fs(c.g, f, (gw >> 1), (gw >> 1) + 1, 5, 7, -1, 0, BM.GLASS_LIT); }
    else if (gw >= 24) { gdoor(c, f, 3, gw - 6, h, st); if (lights) { fs(c.g, f, 1, 2, 5, 7, -1, 0, BM.GLASS_LIT); fs(c.g, f, gw - 2, gw - 1, 5, 7, -1, 0, BM.GLASS_LIT); } }
    else { gdoor(c, f, 2, gw - 4, h, st); if (lights) fs(c.g, f, gw - 2, gw - 1, 5, 7, -1, 0, BM.GLASS_LIT); }
  }
  // garage width that leaves the body at least bodyMin of avail (0 if none fits / none wanted)
  function garageW(c, avail, bodyMin) {
    if (!c.garage) return 0;
    if (avail - 25 >= bodyMin) return H2(c.seed, 5, 9) < 0.2 ? 14 : 25;
    if (avail - 14 >= bodyMin) return 14;
    return 0;
  }
  // left edge of the body: centred on the footprint, or pushed to the driveway side when there is a garage (the lot
  // layout puts the driveway along that edge of the footprint)
  function bodyX(W, mL, mR, gw, bw) { return gw ? Math.max(mL, W - mR - gw - bw) : mL + Math.max(0, (W - mL - mR - bw) >> 1); }
  // an attached one-storey garage wing: walls, doors, side window, man door at the back, own roof part
  function garageWing(c, gr, o) {
    const g = c.g, S = c.S;
    g.box(gr.x0, 0, gr.z0, gr.x1, o.yT, gr.z1, S.wall);
    skin(c, gr, 1, o.yT, o.pat, { corner: o.corner, faces: 'fbr' });
    skin(c, gr, 0, 1, () => S.found, { faces: 'fbr' });
    garageDoors(c, gr, o.dh || 8, o.st, o.twin, o.lights !== false);
    const fr = F(gr, 'r'), gd = gr.z1 - gr.z0;
    if (gd >= 18) win(c, fr, (gd >> 1) - 2, 4, 4, 4, { rail: false, trim: o.trim, sash: o.sash });
    const fb = F(gr, 'b');
    if (gr.x1 - gr.x0 >= 12) door(c, fb, 2, 0, 4, 8, { lite: true, m: o.backDoor || S.door, trim: o.trim });
    return part(c, Object.assign({ x0: gr.x0, z0: gr.z0, x1: gr.x1, z1: gr.z1, y: o.yT, gut: 'fb', ds: ['fr', 'br'] }, o.roof));
  }
  function pal(c, o) {
    const S = Object.assign({ trim: BM.TRIM, found: BM.CONCRETE, deck: BM.WOOD, gut: BM.TRIM, door: BM.DOOR_RED, shutter: BM.SHUTTER_BLACK, roof: BM.SHINGLE_GRAY }, o);
    if (!S.wall2) S.wall2 = alt(S.wall);
    c.S = S;
    return S;
  }
  const SIDING = [BM.SIDING_WHITE, BM.SIDING_WHITE, BM.SIDING_YELLOW, BM.SIDING_BLUE, BM.SIDING_GRAY, BM.SIDING_SAGE, BM.PAINT_CREAM];
  const SHINGLE = [BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE];

  // ================================================================================================ colonial
  function colonial(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const brick = R() < 0.28;
    const S = pal(c, {
      wall: brick ? pick(R, [BM.BRICK_RED, BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK]) : pick(R, SIDING),
      shutter: pick(R, [BM.SHUTTER_BLACK, BM.SHUTTER_GREEN, BM.DOOR_NAVY, BM.SHUTTER_BLACK]),
      door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.SHUTTER_BLACK, BM.SHUTTER_GREEN, BM.WOOD]),
      roof: pick(R, SHINGLE), deck: brick ? BM.BRICK_RED : pick(R, [BM.CONCRETE, BM.BRICK_RED, BM.LIMESTONE_DARK])
    });
    if (brick) S.found = S.wall;
    const fl = 2, fh = 11, yT = fl + 2 * fh, slope = 0.58 + R() * 0.17;
    const mL = 5, gw = garageW(c, W - mL - 2, 30), mR = gw ? 2 : 3;
    const bw = even(clamp(W - mL - mR - gw, 24, 50 + Math.floor(R() * 6)));
    // entry by the depth left in front of a body at least 22 deep: full porch, portico, or a door hood over a stoop
    const room = D - 3 - 22;
    const entry = pick(R, bw >= 34 && room >= 10 ? ['pediment', 'flat', 'porch', 'hood', 'pediment'] : room >= 7 ? ['hood', 'pediment', 'flat'] : ['hood']);
    const zf = entry === 'porch' ? 10 : entry === 'hood' ? clamp(room, 4, 5) : 7;
    const bd = Math.min(38, D - zf - 3);
    const x0 = bodyX(W, mL, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    walls(c, r, yT, fl, brick ? PAT.plain(S) : PAT.lap(S, fl), brick ? 0 : S.trim);
    if (brick) { band(c, r, fl + fh, S.wall2); band(c, r, fl - 1, BM.LIMESTONE_DARK); }
    // front: symmetric bays, centre door
    const ff = F(r, 'f'), n = bw >= 44 ? 5 : 3, ww = 4;
    const us = spread(bw, n, ww, 5), st = n > 1 ? us[1] - us[0] : 99;
    const shut = (!brick || R() < 0.5) && st >= ww + 7 ? S.shutter : 0;
    const wo = { shut, lintel: brick ? BM.LIMESTONE : 0, sillM: brick ? BM.LIMESTONE : undefined, cap: !brick && R() < 0.4 ? S.trim : 0 };
    const mid = n >> 1;
    us.forEach((u, i) => {
      if (i !== mid) win(c, ff, u, fl + 3, ww, 7, wo);
      win(c, ff, u, fl + fh + 3, ww, 6, wo);
    });
    const du = (bw >> 1) - 2;
    door(c, ff, du, fl, 4, 8, { side: entry === 'flat' || entry === 'porch', lite: R() < 0.4, pil: entry === 'hood', lamp: entry !== 'hood' });
    // sides and back
    const yG = fl + 3, yU = fl + fh + 3;
    for (const s of ['l', 'r']) {
      const f = F(r, s), ns = bd >= 28 ? 2 : 1, ps = spread(bd, ns, 4, 6);
      for (const u of ps) {
        if (s === 'l' && Math.abs(u + 2 - (bd >> 1)) < 5) continue;                  // chimney
        if (!(s === 'r' && gw)) win(c, f, u, yG, 4, 7, { lintel: wo.lintel, sillM: wo.sillM });
        win(c, f, u, yU, 4, 6, { lintel: wo.lintel, sillM: wo.sillM });
      }
    }
    const fb = F(r, 'b');
    spread(bw, n, ww, 5).forEach((u, i) => {
      if (i === 1) door(c, fb, u, fl, 4, 8, { lite: true });
      else win(c, fb, u, yG, ww, 7, { lintel: wo.lintel, sillM: wo.sillM });
      win(c, fb, u, yU, ww, 6, { lintel: wo.lintel, sillM: wo.sillM });
    });
    // roofs
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'gx', s: slope, ov: { f: 2, b: 2, l: 1, r: 1 },
      attic: brick ? S.wall : PAT.lap(S, fl), gut: 'fb', ds: entry === 'porch' ? ['bl', 'br'] : ['fl', 'fr', 'bl', 'br'] });
    let gr = null;
    if (gw) {
      const gz0 = r.z0 + 2 + Math.floor(R() * 5);
      gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, Math.max(gz0 + 22, Math.min(r.z1, gz0 + 26))) };
      garageWing(c, gr, { yT: 11, pat: brick ? PAT.plain(S) : PAT.lap(S, 1), corner: brick ? 0 : S.trim, st: garageStyle(R, S), twin: R() < 0.3,
        roof: { kind: 'gx', s: slope, ov: { f: 2, b: 2, l: 0, r: 1 }, attic: brick ? S.wall : PAT.lap(S, 1) } });
    }
    const cx = r.x0 + (bw >> 1);
    let por = null;
    if (entry === 'pediment' || entry === 'flat') {
      por = { x0: cx - 6, x1: cx + 6, z0: r.z0 - 5, z1: r.z0 };
      if (entry === 'pediment') part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1, y: 11, kind: 'gz', s: 0.5, ov: { f: 1, l: 1, r: 1 }, attic: S.trim });
      else part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1, y: 11, kind: 'flat', t: 1, lift: 1, ov: { f: 1, l: 1, r: 1 }, attic: S.trim, mat: S.trim });
    } else if (entry === 'porch') {
      por = { x0: r.x0, x1: r.x1, z0: r.z0 - 8, z1: r.z0 };
      part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1, y: 11, kind: 'shf', s: 0.3, lift: 1, ov: { f: 1, l: 1, r: 1 }, attic: S.trim, gut: 'f' });
    } else {
      part(c, { x0: cx - 5, z0: r.z0 - 3, x1: cx + 5, z1: r.z0, y: 12, kind: 'gz', s: 0.5, ov: { f: 1 }, attic: S.trim });
    }
    roofs(c);
    // portico / porch / stoop
    if (por && entry !== 'porch') {
      porch(c, { x0: por.x0, x1: por.x1, z0: por.z0, z1: por.z1, fl, beam: 11, cols: [por.x0, por.x1 - 2], cw: 2, colM: S.trim, skirt: S.deck, deck: S.deck, steps: [cx - 4, cx + 4] });
      g.box(por.x0, fl, por.z1 - 1, por.x0 + 2, 11, por.z1, S.trim); g.box(por.x1 - 2, fl, por.z1 - 1, por.x1, 11, por.z1, S.trim);   // pilasters
      if (entry === 'flat') { rail(c, por.x0 - 1, por.z0 - 1, por.x1 + 1, por.z0, 13, S.trim, 2); rail(c, por.x0 - 1, por.z0, por.x0, por.z1 - 2, 13, S.trim, 2); rail(c, por.x1, por.z0, por.x1 + 1, por.z1 - 2, 13, S.trim, 2); }
    } else if (entry === 'porch') {
      const cols = [], nc = Math.max(3, Math.round(bw / 10) + 1);
      for (let i = 0; i < nc; ++i) cols.push(Math.round(por.x0 + i * (bw - 2) / (nc - 1)));
      porch(c, { x0: por.x0, x1: por.x1, z0: por.z0, z1: por.z1, fl, beam: 11, cols, cw: 2, colM: S.trim, skirt: S.trim, deck: BM.WOOD, rail: true, railM: S.trim, gap: [cx - 3, cx + 3], steps: [cx - 3, cx + 3] });
    } else {
      g.box(cx - 5, 0, r.z0 - 3, cx + 5, fl, r.z0, S.deck); steps(c, cx - 4, cx + 4, r.z0 - 3, fl, S.deck);
      for (const bx of [cx - 5, cx + 4]) g.box(bx, 10, r.z0 - 1, bx + 1, 12, r.z0, S.trim);                    // hood brackets
    }
    // brick end chimney on the far gable
    const zc = r.z0 + (bd >> 1);
    chimney(c, r.x0 - 3, zc - 2, r.x0, zc + 2, ridgeOf(main) + 3, brick ? S.wall2 : BM.BRICK_RED, { base: [r.x0 - 3, zc - 3, r.x0, zc + 3], yS: yT - 3 });
    vent(c, F(r, 'r'), bd >> 1, ridgeOf(main) - main.t - 3, 3, 3);
    emit(E, c);
  }

  // ================================================================================================ cape cod
  function cape(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const shake = R() < 0.45;
    const S = pal(c, {
      wall: shake ? pick(R, [BM.SIDING_GRAY, BM.WOOD, BM.SIDING_GRAY, BM.SIDING_WHITE]) : pick(R, SIDING),
      shutter: pick(R, [BM.SHUTTER_BLACK, BM.SHUTTER_GREEN, BM.DOOR_NAVY, BM.SHUTTER_GREEN]),
      door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.SHUTTER_GREEN, BM.WOOD, BM.SHUTTER_BLACK]),
      roof: pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_GRAY, BM.SHINGLE_BROWN]), deck: pick(R, [BM.BRICK_RED, BM.CONCRETE, BM.LIMESTONE_DARK])
    });
    const fl = 2, yT = fl + 12, s = 0.95 + R() * 0.2, endChim = R() < 0.45;
    const mL = endChim ? 5 : 3, gw = garageW(c, W - mL - 2, 26), mR = gw ? 2 : 3;
    const bw = even(clamp(W - mL - mR - gw, 22, 44 + Math.floor(R() * 4)));
    const zf = D >= 30 ? 5 : 4, bd = Math.min(34, D - zf - 3);
    const x0 = bodyX(W, mL, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const pat = shake ? PAT.shake(S, c.seed) : PAT.lap(S, fl);
    walls(c, r, yT, fl, pat, S.trim);
    const ff = F(r, 'f'), nw = bw >= 38 ? 4 : 2, us = spread(bw, nw, 4, 4), shut = R() < 0.75 ? S.shutter : 0;
    const dc = bw >> 1;
    us.forEach((u) => { if (Math.abs(u + 2 - dc) > 6) win(c, ff, u, fl + 3, 4, 7, { shut, sw: 2 }); });
    door(c, ff, dc - 2, fl, 4, 8, { pil: true, lite: R() < 0.5, lamp: true });
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'gx', s, ov: { f: 1, b: 1, l: 1, r: 1 }, attic: pat, gut: 'fb', ds: ['fl', 'fr', 'bl', 'br'] });
    // gable dormers over the bays
    const ridge = ridgeOf(main), rz = r.z0 + ((bd - 1) >> 1);
    const nd = bw >= 38 ? (R() < 0.3 ? 3 : 2) : (bw >= 28 ? 2 : 1);
    const dps = nd === 3 ? spread(bw, 3, 7, 5) : nd === 2 ? spread(bw, 2, 7, Math.max(5, (bw >> 2) - 3)) : [(bw - 7) >> 1];
    const dz0 = r.z0 + 2, wy = hAt(main, r.x0, dz0 - 1) + 1, dTop = wy + 5, ds = 0.8;
    const dormers = [];
    if (dTop + 1 + Math.floor(3 * ds) <= ridge - 1) for (const u of dps) {
      const dr = { x0: r.x0 + u, x1: r.x0 + u + 7, z0: dz0, z1: rz };
      g.box(dr.x0, yT, dr.z0, dr.x1, dTop, dr.z1, S.wall);
      skin(c, dr, yT, dTop, pat, { faces: 'flr', corner: S.trim });
      part(c, { x0: dr.x0, z0: dr.z0, x1: dr.x1, z1: dr.z1, y: dTop, kind: 'gz', s: ds, ov: { f: 1, l: 1, r: 1 }, attic: S.trim });
      dormers.push(dr);
    }
    // back: windows, door, a shed dormer on wide capes
    const fb = F(r, 'b');
    spread(bw, nw, 4, 4).forEach((u, i) => (i === 1 ? door(c, fb, u, fl, 4, 8, { lite: true }) : win(c, fb, u, fl + 3, 4, 7)));
    for (const s2 of ['l', 'r']) {
      const f = F(r, s2), ps = spread(bd, 2, 4, 6);
      if (!(s2 === 'r' && gw)) ps.forEach(u => win(c, f, u, fl + 3, 4, 7));
      if (!(s2 === 'l' && endChim)) ps.forEach(u => win(c, f, u, yT + 3, 3, 5));
      else { win(c, f, ps[0], yT + 3, 3, 5); win(c, f, ps[1], yT + 3, 3, 5); }
    }
    let gr = null;
    if (gw) {
      const gz0 = r.z0 + 3 + Math.floor(R() * 4);
      gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      garageWing(c, gr, { yT: 10, pat, corner: S.trim, st: garageStyle(R, S), roof: { kind: 'gx', s, ov: { f: 1, b: 1, l: 0, r: 1 }, attic: pat } });
    }
    roofs(c);
    for (const dr of dormers) win(c, F(dr, 'f'), 2, wy, 3, 4, { rail: false });
    // stoop
    g.box(r.x0 + dc - 4, 0, r.z0 - 3, r.x0 + dc + 4, fl, r.z0, S.deck); steps(c, r.x0 + dc - 3, r.x0 + dc + 3, r.z0 - 3, fl, S.deck);
    // chimney
    if (endChim) { const zc = r.z0 + (bd >> 1); chimney(c, r.x0 - 3, zc - 2, r.x0, zc + 2, ridge + 2, BM.BRICK_RED, { base: [r.x0 - 3, zc - 3, r.x0, zc + 3], yS: yT - 2 }); }
    else chimney(c, r.x0 + dc - 2, rz - 1, r.x0 + dc + 2, rz + 2, ridge + 3, pick(R, [BM.BRICK_RED, BM.BRICK_DARK, BM.LIMESTONE_DARK]), { y0: yT });
    emit(E, c);
  }

  // ================================================================================================ ranch
  function ranch(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const allBrick = R() < 0.35, wains = !allBrick && R() < 0.6;
    const brickM = pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BUFF, BM.LIMESTONE_DARK]);
    const S = pal(c, {
      wall: allBrick ? brickM : pick(R, [BM.SIDING_WHITE, BM.SIDING_GRAY, BM.SIDING_BLUE, BM.SIDING_YELLOW, BM.SIDING_SAGE, BM.PAINT_CREAM]),
      door: pick(R, [BM.DOOR_RED, BM.WOOD, BM.DOOR_NAVY, BM.SHUTTER_GREEN]), shutter: pick(R, [BM.SHUTTER_BLACK, BM.SHUTTER_GREEN, BM.WOOD, BM.DOOR_NAVY]),
      roof: pick(R, [BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_BROWN]), gut: pick(R, [BM.TRIM, BM.TRIM, BM.METAL])
    });
    const fl = 1, yT = fl + 11, hip = R() < 0.6, s = hip ? 0.4 + R() * 0.1 : 0.42 + R() * 0.08, ov = 3;
    const m = 4, gw = garageW(c, W - 2 * m, 30);
    const snout = gw && R() < 0.35 && D >= 40;
    const bw = even(clamp(W - 2 * m - gw, 26, 60 + Math.floor(R() * 8)));
    const zf = snout ? 11 : 5, bd = Math.min(36, D - zf - 4);
    const x0 = bodyX(W, m, m, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const all = { x0, z0: zf, x1: x0 + bw + (snout ? 0 : gw), z1: zf + bd };
    const wpat = allBrick ? PAT.plain(S) : wains ? (u, y) => (y < fl + 4 ? brickM : ((y - fl) % 2 ? S.wall2 : S.wall)) : PAT.lap(S, fl);
    walls(c, all, yT, fl, wpat, allBrick || wains ? 0 : S.trim);
    if (wains) for (const sd of 'fblr') { const f = F(all, sd); fs(g, f, 0, f.len, fl + 4, fl + 5, -1, 0, BM.LIMESTONE_DARK); }
    // recessed entry porch
    const pw = Math.min(16, bw >> 2) + 6, px0 = r.x0 + Math.round(bw * (0.18 + R() * 0.12)), pd = 5;
    g.box(px0, fl, r.z0, px0 + pw, yT, r.z0 + pd, -1);
    g.box(px0, 0, r.z0, px0 + pw, fl, r.z0 + pd, BM.CONCRETE);
    const rec = { x0: px0, x1: px0 + pw, z0: r.z0 + pd, z1: r.z1 };
    skin(c, rec, fl, yT, wpat, { faces: 'f' });
    skin(c, { x0: r.x0, x1: px0, z0: r.z0, z1: r.z0 + pd }, fl, yT, wpat, { faces: 'r' });
    skin(c, { x0: px0 + pw, x1: r.x1, z0: r.z0, z1: r.z0 + pd }, fl, yT, wpat, { faces: 'l' });
    const fr = F(rec, 'f');
    door(c, fr, 3, fl, 4, 8, { side: R() < 0.5, lite: R() < 0.5, lamp: true });
    win(c, fr, pw - 8, fl + 3, 5, 5, { mull: [2] });
    const postM = pick(R, [S.trim, BM.STEEL_DARK, BM.WOOD]);
    for (const x of [px0, px0 + pw - 1]) g.box(x, fl, r.z0, x + 1, yT, r.z0 + 1, postM);
    if (pw >= 18) g.box(px0 + (pw >> 1), fl, r.z0, px0 + (pw >> 1) + 1, yT, r.z0 + 1, postM);
    g.box(px0 + 2, 0, r.z0 - 2, px0 + 9, fl, r.z0, BM.CONCRETE);
    // front windows: picture window left of the entry or right, bedroom windows elsewhere
    const ff = F(r, 'f'), shut = R() < 0.45 ? S.shutter : 0;
    const rightLen = r.x1 - (px0 + pw), leftLen = px0 - r.x0;
    const picL = leftLen >= rightLen;
    const segs = [[0, leftLen], [px0 + pw - r.x0, bw]];
    segs.forEach(([a, b], i) => {
      const len = b - a;
      if (len < 9) return;
      if ((i === 0) === picL && len >= 18) {
        const pw2 = Math.min(16, len - 6), u = a + ((len - pw2) >> 1);
        win(c, ff, u, fl + 3, pw2, 5, { mull: [Math.floor(pw2 / 4), pw2 - 1 - Math.floor(pw2 / 4)], rail: false, sillM: allBrick ? BM.LIMESTONE : undefined, sillX: 1 });
      } else {
        const n = Math.max(1, Math.floor(len / 13)), ps = spread(len, n, 5, 4);
        ps.forEach(u => win(c, ff, a + u, fl + 4, 5, 4, { mull: [2], rail: false, shut, sw: 2 }));
      }
    });
    // back and sides
    const fb = F(all, 'b'), nb = Math.max(2, Math.floor((all.x1 - all.x0) / 12));
    spread(all.x1 - all.x0, nb, 5, 5).forEach((u, i) => (i === 1 ? door(c, fb, u, fl, 5, 8, { m: BM.GLASS, trim: S.trim }) : win(c, fb, u, fl + 4, 5, 5, { mull: [2], rail: false })));
    { const f = F(all, 'l'); spread(bd, 2, 4, 6).forEach(u => win(c, f, u, fl + 4, 4, 5)); }
    if (!gw) { const f = F(all, 'r'); spread(bd, 2, 4, 6).forEach(u => win(c, f, u, fl + 4, 4, 5)); }
    // garage
    let gr = null;
    const st = garageStyle(R, S, R() < 0.8 ? 'panel' : 'carriage');
    if (gw && !snout) {
      gr = { x0: r.x1, x1: r.x1 + gw, z0: r.z0, z1: r.z1 };
      garageDoors(c, gr, 8, st, R() < 0.3, true);
      fs(g, F(all, 'r'), (bd >> 1) - 2, (bd >> 1) + 2, fl + 4, fl + 8, 0, 1, -1); fs(g, F(all, 'r'), (bd >> 1) - 2, (bd >> 1) + 2, fl + 4, fl + 8, 1, 2, BM.GLASS);
    } else if (gw) {
      gr = { x0: r.x1 - gw, x1: r.x1, z0: zf - 7, z1: r.z0 + 6 };
      g.box(gr.x0, 0, gr.z0, gr.x1, yT, gr.z1, S.wall);
      skin(c, gr, 0, yT, wpat, { faces: 'flr', corner: allBrick || wains ? 0 : S.trim });
      garageDoors(c, gr, 8, st, false, true);
      part(c, { x0: gr.x0, z0: gr.z0, x1: gr.x1, z1: gr.z1, y: yT, kind: 'gz', s: s + 0.05, ov: { f: 2, l: 2, r: 2 }, attic: allBrick ? S.wall : PAT.lap(S, fl), gut: 'lr', ds: ['rf'] });
    }
    part(c, { x0: all.x0, z0: all.z0, x1: all.x1, z1: all.z1, y: yT, kind: hip ? 'hip' : 'gx', s, ov, attic: allBrick ? S.wall : PAT.lap(S, fl), gut: hip ? 'fblr' : 'fb', ds: ['bl', 'br', 'fl'] });
    roofs(c);
    // wide interior brick chimney through the roof
    const P = { x0: all.x0, z0: all.z0, x1: all.x1, z1: all.z1, y: yT, kind: hip ? 'hip' : 'gx', s, t: 2, lift: 0, ov: { f: ov, b: ov, l: ov, r: ov } };
    const chx = picL ? r.x0 + Math.max(4, (leftLen >> 1) - 3) : px0 + pw + (rightLen >> 1) - 3, chz = r.z0 + (bd >> 1) - 1;
    if (R() < 0.75) chimney(c, chx, chz, chx + 6, chz + 3, hAt(P, chx + 3, chz) + 5, allBrick ? brickM : pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, brickM]), { y0: yT });
    emit(E, c);
  }

  // ================================================================================================ craftsman
  function craftsman(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const wall = pick(R, [BM.PAINT_SAGE, BM.SIDING_SAGE, BM.WOOD, BM.PAINT_CREAM, BM.SIDING_GRAY, BM.WOOD, BM.PAINT_SALMON]);
    const S = pal(c, {
      wall, trim: wall === BM.PAINT_CREAM ? pick(R, [BM.WOOD, BM.TRIM]) : pick(R, [BM.PAINT_CREAM, BM.TRIM, BM.PAINT_CREAM]),
      found: pick(R, [BM.LIMESTONE_DARK, BM.GRANITE_DARK, BM.BRICK_BROWN, BM.BRICK_RED, BM.BUFF]), door: pick(R, [BM.WOOD, BM.WOOD, BM.DOOR_RED, BM.SHUTTER_GREEN]),
      roof: pick(R, [BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_BROWN])
    });
    S.gut = S.trim;
    const half = c.floors >= 2 && R() < 0.8, fl = 3, yT = fl + 11, s = half ? 0.78 + R() * 0.1 : 0.45 + R() * 0.1;
    const m = 4, gw = garageW(c, W - m - 2, 22), mR = gw ? 2 : m;
    const bw = even(clamp(W - m - mR - gw, 16, 44));
    const pd = clamp(D - 3 - 2 - 22, 5, 10), zf = pd + 2, bd = Math.min(40, D - zf - 3);
    const x0 = bodyX(W, m, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const shingle = wall === BM.WOOD || R() < 0.3;
    const pat = shingle ? PAT.shake(S, c.seed) : PAT.lap(S, fl);
    // porch: 'integral' (under the main front gable), 'shed' (full width) or 'gable' (its own lower gable, part width)
    const mode = bw < 26 ? pick(R, ['integral', 'shed']) : pick(R, ['integral', 'gable', 'gable', 'shed']);
    const pw = mode === 'gable' ? even(Math.round(bw * 0.62)) : bw, pleft = R() < 0.5;
    const por = { x0: mode !== 'gable' || pleft ? r.x0 : r.x1 - pw, z0: r.z0 - pd, z1: r.z0 };
    por.x1 = por.x0 + pw;
    const beam = mode === 'integral' ? yT - 1 : fl + 9;
    walls(c, r, yT, fl, pat, S.trim);
    band(c, r, fl, S.trim);                                                                   // water table
    // front: door in the porch, grouped windows
    const ff = F(r, 'f'), dc = mode !== 'gable' ? (bw >> 1) + (bw >= 30 ? (R() < 0.5 ? -6 : 6) : 0) : (por.x0 - r.x0) + (pw >> 1) - 5;
    door(c, ff, dc - 2, fl, 4, 8, { lite: true, side: bw >= 34 && R() < 0.4 });
    const grp = (f, u, y, n, h) => {
      for (let i = 0; i < n; ++i) win(c, f, u + i * 4, y, 3, h, { mull: [1], mullLo: h >> 1, sill: false });
      fs(g, f, u - 2, u + n * 4, y + h, y + h + 1, -1, 0, S.trim); fs(g, f, u - 1, u + n * 4 - 1, y - 1, y, -1, 0, S.trim);
    };
    const leftU = dc - 4, rightU = dc + 4;
    if (leftU >= 13) { const n = leftU >= 19 ? 3 : 2; grp(ff, Math.max(3, (leftU >> 1) - n * 2 + 1), fl + 3, n, 6); }
    if (bw - rightU >= 13) { const len = bw - rightU, n = len >= 19 ? 3 : 2; grp(ff, rightU + (len >> 1) - n * 2 + 1, fl + 3, n, 6); }
    for (const sd of ['l', 'r']) {
      if (sd === 'r' && gw) continue;
      const f = F(r, sd), n = Math.max(1, Math.floor(bd / 13));
      spread(bd, n, 7, 4).forEach(u => grp(f, u + 2, fl + 3, 2, 6));
    }
    const fb = F(r, 'b');
    door(c, fb, 4, fl, 4, 8, { lite: true });
    if (bw >= 20) grp(fb, bw - 13, fl + 4, 2, 5);
    steps(c, r.x0 + 4, r.x0 + 8, r.z1 + 3, fl, BM.CONCRETE);
    // main roof: low front gable, deep eaves (over the porch too when it is integral)
    const ovs = 3, mr = { x0: r.x0, z0: mode === 'integral' ? por.z0 : r.z0, x1: r.x1, z1: r.z1 };
    const gpat = shingle ? pat : (u, y) => (H2(c.seed, u >> 1, y) < 0.2 || y % 2 === 0 ? S.wall2 : S.wall);
    const main = part(c, { x0: mr.x0, z0: mr.z0, x1: mr.x1, z1: mr.z1, y: yT, kind: 'gz', s, ov: ovs, attic: gpat });
    let pp = null;
    if (mode === 'gable') pp = part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1 + 4, y: beam, kind: 'gz', s: Math.min(s, 0.55), lift: 1, ov: { f: 2, l: 2, r: 2 }, attic: S.trim });
    else if (mode === 'shed') pp = part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1, y: beam, kind: 'shf', s: 0.3, lift: 1, ov: { f: 1, l: 1, r: 1 }, attic: S.trim });
    if (gw) {
      const gz0 = r.z0 + 4 + Math.floor(R() * 6);
      const gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      garageWing(c, gr, { yT: 11, pat, corner: S.trim, st: garageStyle(R, S, 'carriage'), roof: { kind: 'gz', s: 0.5, ov: { f: 2, b: 0, l: 0, r: 2 }, attic: gpat, gut: '', ds: [] } });
    }
    roofs(c);
    // exposed rafter tails along both eaves, knee braces under the gable rakes
    for (const xe of [mr.x0 - ovs, mr.x1 + ovs - 1]) for (let z = mr.z0 - ovs + 1; z < mr.z1 + ovs; z += 2) {
      const y = hAt(main, xe, z) - main.t - 1; g.set(xe, y, z, S.trim); g.set(xe + (xe < mr.x0 ? 1 : -1), y, z, S.trim);
    }
    for (const zg of [mr.z0 - 1, mr.z1]) for (const x of [mr.x0, mr.x1 - 1]) {
      const y = hAt(main, x, zg) - main.t;
      g.box(x, y - 3, zg, x + 1, y, zg + 1, S.trim);
      if (zg < mr.z0) g.box(x, y - 1, zg - 1, x + 1, y, zg, S.trim); else g.box(x, y - 1, zg + 1, x + 1, y, zg + 2, S.trim);
    }
    const ridge = ridgeOf(main), fg = F(mr, 'f');
    // the front gable: attic windows (one-and-a-half storey) clear of a porch roof, or a louvred vent
    const cu = bw >> 1, pTop = pp ? hAt(pp, mr.x0 + cu, por.z1 - 1) : yT;
    const ay = Math.max(yT + 4, pTop + 2), atop = hAt(main, mr.x0 + cu - 5, mr.z0) - main.t - 1;
    if (half && ay + 5 <= atop) { grp(fg, cu - 5, ay, 3, 5); vent(c, fg, cu, ridge - main.t - 2, 3, 2); }
    else vent(c, fg, cu, ridge - main.t - 3, 5, 3);
    vent(c, fb, cu, ridge - main.t - 3, 5, 3);
    // porch: stone piers, tapered columns, knee wall, steps between cheek blocks
    const cols = pw >= 28 ? [por.x0, por.x0 + (pw >> 1) - 2, por.x1 - 4] : [por.x0, por.x1 - 4];
    g.box(por.x0, 0, por.z0, por.x1, fl, por.z1, S.found);
    g.box(por.x0, fl - 1, por.z0, por.x1, fl, por.z1, BM.WOOD);
    const sx = r.x0 + dc - 4, kw = shingle ? S.wall2 : S.found;
    for (const x of cols) {
      g.box(x, 0, por.z0, x + 4, fl + 4, por.z0 + 4, S.found);
      g.box(x, fl + 4, por.z0, x + 4, fl + 5, por.z0 + 4, BM.CONCRETE);
      g.box(x + 1, fl + 5, por.z0 + 1, x + 4, fl + 8, por.z0 + 4, S.trim);
      g.box(x + 1, fl + 8, por.z0 + 1, x + 3, beam, por.z0 + 3, S.trim);
    }
    if (mode === 'integral') g.box(por.x0, beam, por.z0, por.x1, beam + 1, por.z0 + 1, S.trim);
    for (let x = por.x0; x < por.x1; ++x) if ((x < sx - 1 || x >= sx + 9) && !cols.some(cx => x >= cx && x < cx + 4)) g.box(x, fl, por.z0 + 1, x + 1, fl + 3, por.z0 + 2, kw);
    for (const xx of [por.x0, por.x1 - 1]) g.box(xx, fl, por.z0 + 4, xx + 1, fl + 3, por.z1 - 1, kw);
    steps(c, sx, sx + 8, por.z0, fl, BM.CONCRETE);
    g.box(sx - 1, 0, por.z0 - 2, sx, fl + 1, por.z0, S.found); g.box(sx + 8, 0, por.z0 - 2, sx + 9, fl + 1, por.z0, S.found);
    // side chimney through the eave (left)
    const zc = r.z0 + (bd >> 1) + 2;
    chimney(c, r.x0 - 3, zc - 2, r.x0, zc + 2, hAt(main, r.x0 + 4, zc) + 4, S.found === BM.BUFF || S.found === BM.LIMESTONE_DARK ? BM.BRICK_BROWN : S.found,
      { base: [r.x0 - 3, zc - 3, r.x0, zc + 3], yS: yT - 4, cap: BM.CONCRETE });
    emit(E, c);
  }

  // ================================================================================================ split level
  function splitLevel(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const brickM = pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BUFF, BM.LIMESTONE_DARK]);
    const S = pal(c, { wall: pick(R, [BM.SIDING_BLUE, BM.SIDING_GRAY, BM.SIDING_YELLOW, BM.SIDING_WHITE, BM.SIDING_SAGE, BM.PAINT_CREAM]),
      door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.WOOD, BM.SHUTTER_BLACK]), shutter: pick(R, [BM.SHUTTER_BLACK, BM.DOOR_NAVY, BM.SHUTTER_GREEN]),
      roof: pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_BROWN, BM.SHINGLE_SLATE]), found: brickM });
    const total = W - 6, aw = even(clamp(Math.round(total * (0.42 + R() * 0.08)), 18, 32)), bw = even(clamp(total - aw, 18, 46));
    const x0 = 3 + Math.max(0, (total - aw - bw) >> 1);
    const zf = 6, bd = Math.min(36, D - zf - 3), s = 0.36 + R() * 0.1;
    const rB = { x0, x1: x0 + bw, z0: zf + 3, z1: zf + bd };
    const rA = { x0: x0 + bw, x1: x0 + bw + aw, z0: zf, z1: zf + bd };
    const lap = PAT.lap(S, 0);
    // B: one level, half a storey up; brick to the sills, siding above
    const flB = 4, yB = flB + 10;
    walls(c, rB, yB, flB + 3, lap, S.trim, { found: brickM, faces: 'fbl' });
    // A: lower level (brick) + upper level cantilevered 1 voxel at the front (siding)
    const yA1 = 10, yA = yA1 + 11;
    walls(c, rA, yA1, yA1, lap, 0, { found: brickM, faces: 'fbr' });
    const rAu = { x0: rA.x0, x1: rA.x1, z0: rA.z0 - 1, z1: rA.z1 };
    g.box(rAu.x0, yA1, rAu.z0, rAu.x1, yA, rAu.z1, S.wall);
    skin(c, rAu, yA1, yA, lap, { corner: S.trim, faces: 'fbr' });
    skin(c, { x0: rAu.x0, x1: rAu.x1, z0: rAu.z0, z1: rB.z0 }, yA1, yA, lap, { faces: 'l' });
    skin(c, { x0: rA.x0, x1: rA.x1, z0: rA.z0, z1: rB.z0 }, 0, yA1, () => brickM, { faces: 'l' });
    skin(c, { x0: rAu.x0, x1: rAu.x1, z0: rB.z0, z1: rB.z1 }, yB, yA, lap, { faces: 'l' });
    // fronts
    const fB = F(rB, 'f'), fA = F(rA, 'f'), fAu = F(rAu, 'f'), shut = R() < 0.6 ? S.shutter : 0;
    const pwW = Math.min(14, bw - 14);
    if (pwW >= 8) win(c, fB, 4, flB + 3, pwW, 6, { mull: [3, pwW - 4], rail: false, sillM: BM.LIMESTONE });
    door(c, fB, bw - 7, flB, 4, 8, { lite: true, lamp: true });
    spread(aw, aw >= 26 ? 2 : 1, 5, 5).forEach(u => win(c, fAu, u, yA1 + 3, 5, 6, { shut, sw: 2 }));
    const gw = c.garage ? (aw >= 28 ? 20 : 11) : 0;
    if (gw) { const st = garageStyle(R, S, 'panel'); gdoor(c, fA, (aw - gw) >> 1, gw, 8, st); }
    else spread(aw, 2, 5, 5).forEach(u => win(c, fA, u, 4, 5, 4, { rail: false, mull: [2] }));
    // sides, back
    { const f = F(rB, 'l'); spread(bd - 3, 2, 4, 5).forEach(u => win(c, f, u, flB + 3, 4, 6)); }
    { const f = F(rAu, 'r'); spread(bd, 2, 4, 5).forEach(u => win(c, f, u, yA1 + 3, 4, 6)); }
    { const f = F(rA, 'r'); win(c, f, bd - 10, 3, 4, 4, { rail: false }); }
    { const f = F(rB, 'b'); spread(bw, 2, 5, 4).forEach((u, i) => (i ? win(c, f, u, flB + 3, 5, 6) : door(c, f, u, flB, 5, 8, { m: BM.GLASS }))); }
    { const f = F(rAu, 'b'); spread(aw, 2, 4, 4).forEach(u => win(c, f, u, yA1 + 3, 4, 6)); }
    { const f = F(rA, 'b'); win(c, f, (aw >> 1) - 2, 3, 4, 4, { rail: false }); }
    if (rB.z0 + 4 <= rB.z1) steps(c, rB.x0 + 4, rB.x0 + 8, rB.z1 + 4, flB, BM.CONCRETE);
    // roofs: low side gable over B, front gable (or side gable) over A
    const aFront = R() < 0.55;
    const pB = part(c, { x0: rB.x0, z0: rB.z0, x1: rB.x1, z1: rB.z1, y: yB, kind: 'gx', s, ov: { f: 2, b: 2, l: 1 }, attic: lap, gut: 'fb', ds: ['fl', 'bl'] });
    const pA = part(c, { x0: rAu.x0, z0: rAu.z0, x1: rAu.x1, z1: rAu.z1, y: yA, kind: aFront ? 'gz' : 'gx', s, ov: aFront ? { f: 2, b: 2, l: 2, r: 2 } : { f: 2, b: 2, l: 1, r: 1 },
      attic: lap, gut: aFront ? 'lr' : 'fb', ds: aFront ? ['rf', 'rb'] : ['fr', 'br'] });
    roofs(c);
    if (aFront) vent(c, F(rAu, 'f'), aw >> 1, ridgeOf(pA) - pA.t - 2, 3, 3);
    // entry stoop with iron rail
    const sx0 = rB.x0 + bw - 10;
    g.box(sx0, 0, rB.z0 - 4, sx0 + 9, flB, rB.z0, BM.CONCRETE);
    steps(c, sx0 + 1, sx0 + 6, rB.z0 - 4, flB, BM.CONCRETE);
    for (const rx of [sx0, sx0 + 6]) { g.box(rx, flB + 3, rB.z0 - 4, rx + 1, flB + 4, rB.z0, BM.STEEL_DARK); for (const rz of [rB.z0 - 4, rB.z0 - 2]) g.box(rx, flB, rz, rx + 1, flB + 3, rz + 1, BM.STEEL_DARK); }
    // chimney on B's gable end
    const zc = rB.z0 + ((rB.z1 - rB.z0) >> 1);
    if (rB.x0 >= 4 && R() < 0.7) chimney(c, rB.x0 - 3, zc - 2, rB.x0, zc + 2, ridgeOf(pB) + 3, brickM === BM.LIMESTONE_DARK ? BM.BRICK_RED : brickM, { base: [rB.x0 - 3, zc - 3, rB.x0, zc + 3], yS: yB - 3 });
    emit(E, c);
  }

  // ================================================================================================ victorian
  function turret(c, cx, cz, rad, y1, o) {
    const g = c.g, S = c.S, inD = (x, z, rr) => Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= rr;
    const X0 = Math.floor(cx - rad - 2), X1 = Math.ceil(cx + rad + 2), Z0 = Math.floor(cz - rad - 2), Z1 = Math.ceil(cz + rad + 2);
    for (let z = Z0; z < Z1; ++z) for (let x = X0; x < X1; ++x) {
      if (inD(x, z, rad)) for (let y = 0; y < y1; ++y) g.set(x, y, z, y < o.fl ? S.found : ((y - o.fl) % 2 ? S.wall2 : S.wall));
      else if (inD(x, z, rad + 1)) for (const by of o.bands) g.set(x, by, z, S.trim);
    }
    // windows: flush glass strips on the curved wall, facing the given angles
    for (const [y, h] of o.wins) for (const th of o.angles) for (let z = Z0; z < Z1; ++z) for (let x = X0; x < X1; ++x) {
      if (!inD(x, z, rad) || (inD(x - 1, z, rad) && inD(x + 1, z, rad) && inD(x, z - 1, rad) && inD(x, z + 1, rad))) continue;
      let a = Math.atan2(z + 0.5 - cz, x + 0.5 - cx) - th; a = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(a) < 0.22) { for (let yy = y; yy < y + h; ++yy) g.set(x, yy, z, L.glassMat(c.seed, 900 + Math.round(th * 10), y, 0.4)); g.set(x, y - 1, z, S.trim); g.set(x, y + h, z, S.trim); }
    }
    // conical roof with a finial
    let top = y1;
    for (let y = y1; ; ++y) {
      const rr = rad + 1 - (y - y1) * o.k;
      if (rr < 0.7) { top = y; break; }
      for (let z = Z0; z < Z1; ++z) for (let x = X0; x < X1; ++x) if (inD(x, z, rr)) g.set(x, y, z, o.roof);
    }
    const fx = Math.floor(cx), fz = Math.floor(cz);
    g.box(fx, top, fz, fx + 1, top + 3, fz + 1, o.fin); g.set(fx, top + 3, fz, BM.METAL);
  }
  function victorian(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const body = pick(R, [BM.PAINT_BLUE, BM.PAINT_SAGE, BM.PAINT_YELLOW, BM.PAINT_SALMON, BM.SIDING_SAGE, BM.SIDING_YELLOW, BM.PAINT_CREAM]);
    const S = pal(c, { wall: body, trim: pick(R, [BM.TRIM, BM.PAINT_CREAM, BM.TRIM]), roof: pick(R, [BM.SHINGLE_SLATE, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_BROWN]),
      door: pick(R, [BM.WOOD, BM.DOOR_RED, BM.SHUTTER_GREEN]), found: pick(R, [BM.BRICK_RED, BM.LIMESTONE_DARK, BM.BRICK_DARK]) });
    const acc = pick(R, [BM.DOOR_RED, BM.PAINT_SALMON, BM.SHUTTER_GREEN, BM.DOOR_NAVY, BM.PAINT_YELLOW, BM.WOOD].filter(m => m !== body));
    const fl = 3, fh = 12, yT = fl + 2 * fh;
    const pd = clamp(D - 3 - 26, 5, 7), mL = 9, zf = pd + 2;
    const gw = garageW(c, W - mL - 2, 30), mR = gw ? 2 : 3;
    const bw = even(clamp(W - mL - mR - gw, 26, 46));
    const bd = Math.min(40, D - zf - 3);
    const x0 = bodyX(W, mL, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const lap = PAT.lap(S, fl);
    walls(c, r, yT, fl, lap, S.trim);
    band(c, r, fl + fh, S.trim);
    // front gable wing with a bay window
    const ww = even(clamp(Math.round(bw * 0.44), 14, 20)), wp = 4;
    const wr = { x0: r.x1 - ww, x1: r.x1, z0: r.z0 - wp, z1: r.z0 + 2 };
    walls(c, wr, yT, fl, lap, S.trim, { faces: 'flr' });
    band(c, { x0: wr.x0, x1: wr.x1, z0: wr.z0, z1: r.z0 }, fl + fh, S.trim);
    const fish = (u, y) => ((y % 3) === 0 ? alt(acc) : ((u + (Math.floor(y / 3) & 1)) % 2 ? acc : alt(acc)));
    const bayW = Math.min(ww - 4, 12), bx0 = wr.x0 + ((ww - bayW) >> 1), byT = fl + 10;
    const bay = { x0: bx0, x1: bx0 + bayW, z0: wr.z0 - 2, z1: wr.z0 };
    g.box(bay.x0, 0, bay.z0, bay.x1, byT, bay.z1, S.wall);
    skin(c, bay, fl, byT, lap, { faces: 'flr' }); skin(c, bay, 0, fl, () => S.found, { faces: 'flr' });
    g.box(bay.x0, 0, bay.z0, bay.x0 + 1, byT, bay.z0 + 1, -1); g.box(bay.x1 - 1, 0, bay.z0, bay.x1, byT, bay.z0 + 1, -1);   // chamfered corners
    const fbay = F(bay, 'f');
    spread(bayW - 2, bayW >= 12 ? 2 : 1, 3, 1).forEach(u => win(c, fbay, u + 1, fl + 2, 3, 7, { sash: acc }));
    // main body windows: tall and narrow, painted sashes
    const wo = { sash: acc, cap: S.trim };
    const ff = F(r, 'f'), leftLen = bw - ww;
    const fw = F(wr, 'f');
    win(c, fw, (ww >> 1) - 2, fl + fh + 2, 4, 7, wo);
    spread(leftLen, leftLen >= 20 ? 2 : 1, 3, 6).forEach(u => win(c, ff, u, fl + fh + 2, 3, 7, wo));
    door(c, ff, leftLen - 7, fl, 4, 9, { lite: true, transom: true, m: S.door });
    if (leftLen >= 18) win(c, ff, 7, fl + 2, 3, 8, wo);
    for (const sd of ['l', 'r']) {
      if (sd === 'r' && gw) continue;
      const f = F(r, sd);
      spread(bd, bd >= 32 ? 3 : 2, 3, 6).forEach(u => { win(c, f, u, fl + 2, 3, 8, wo); win(c, f, u, fl + fh + 2, 3, 7, wo); });
    }
    { const f = F(r, 'b'); spread(bw, 3, 3, 5).forEach((u, i) => { if (i === 1) door(c, f, u, fl, 4, 8, { lite: true }); else win(c, f, u, fl + 2, 3, 8, wo); win(c, f, u, fl + fh + 2, 3, 7, wo); }); steps(c, r.x1 - 5 - ((bw - 3) >> 1) - 4, r.x1 - ((bw - 3) >> 1) + 1 - 4, r.z1 + 3, fl, S.found); }
    // roofs: steep hip with the front gable wing, flat porch roof
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'hip', s: 1.0, ov: 1, attic: S.wall, gut: 'b', ds: ['bl', 'br'] });
    const wing = part(c, { x0: wr.x0, z0: wr.z0, x1: wr.x1, z1: r.z0 + (bd >> 1), y: yT, kind: 'gz', s: 1.1, ov: { f: 1, l: 1, r: 1 }, attic: fish });
    part(c, { x0: bay.x0, z0: bay.z0, x1: bay.x1, z1: bay.z1, y: byT, kind: 'shf', s: 0.6, ov: { f: 1, l: 1, r: 1 }, attic: S.trim });
    const sideL = Math.min(bd - 6, 22);
    const pf = { x0: r.x0 - pd, x1: wr.x0, z0: r.z0 - pd, z1: r.z0 }, ps = { x0: r.x0 - pd, x1: r.x0, z0: r.z0, z1: r.z0 + sideL };
    const beam = fl + 10;
    part(c, { x0: pf.x0, z0: pf.z0, x1: pf.x1, z1: pf.z1, y: beam, kind: 'flat', t: 1, lift: 1, ov: { f: 1, l: 1 }, attic: S.trim });
    part(c, { x0: ps.x0, z0: ps.z0, x1: ps.x1, z1: ps.z1, y: beam, kind: 'flat', t: 1, lift: 1, ov: { l: 1, b: 1 }, attic: S.trim });
    let gr = null;
    if (gw) {
      const gz0 = r.z0 + Math.max(4, bd >> 1);
      gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      if (gr.z1 - gr.z0 >= 18) garageWing(c, gr, { yT: 12, pat: lap, corner: S.trim, st: garageStyle(R, S, 'carriage'), roof: { kind: 'gx', s: 0.9, ov: { f: 1, b: 1, l: 0, r: 1 }, attic: fish } });
    }
    // turret at the front-left corner (built before the roofs, so their overhangs wrap around it)
    const rad = 5.2, tcx = r.x0 + 1.5, tcz = r.z0 + 1.5;
    roofs(c);
    turret(c, tcx, tcz, rad, yT + 6, { fl, bands: [fl + fh, yT + 5], roof: S.roof, k: 0.42, fin: BM.COPPER, angles: [-Math.PI / 2, -3 * Math.PI / 4, Math.PI],
      wins: [[fl + 2, 7], [fl + fh + 2, 6]] });
    // wraparound porch: deck, turned posts, spindle frieze, brackets, balusters, steps
    const sk = S.found, deckM = BM.WOOD;
    g.box(pf.x0, 0, pf.z0, pf.x1, fl, pf.z1, sk); g.box(ps.x0, 0, ps.z0, ps.x1, fl, ps.z1, sk);
    g.box(pf.x0, fl - 1, pf.z0, pf.x1, fl, pf.z1, deckM); g.box(ps.x0, fl - 1, ps.z0, ps.x1, fl, ps.z1, deckM);
    const posts = [];
    for (let x = pf.x0; x < pf.x1 - 1; x += 6) posts.push([x, pf.z0]);
    posts.push([pf.x1 - 1, pf.z0]);
    for (let z = ps.z0 + 5; z < ps.z1; z += 6) posts.push([ps.x0, z]);
    posts.push([ps.x0, ps.z1 - 1]);
    const sx = r.x0 + leftLen - 8;
    for (const [x, z] of posts) { g.box(x, fl, z, x + 1, beam, z + 1, S.trim); g.set(x, fl, z, S.trim); }
    for (let x = pf.x0; x < pf.x1; ++x) { if (x % 2 === 0) g.set(x, beam - 1, pf.z0, S.trim); if (x < sx || x >= sx + 6) rail(c, x, pf.z0, x + 1, pf.z0 + 1, fl, S.trim); }
    for (let z = ps.z0; z < ps.z1; ++z) { if (z % 2 === 0) g.set(ps.x0, beam - 1, z, S.trim); rail(c, ps.x0, z, ps.x0 + 1, z + 1, fl, S.trim); }
    for (const [x, z] of posts) { g.set(x - 1, beam - 1, z, S.trim); g.set(x + 1, beam - 1, z, S.trim); g.set(x, beam - 1, z + 1, S.trim); g.set(x, beam - 1, z - 1, S.trim); }
    rail(c, ps.x0, ps.z1 - 1, ps.x1, ps.z1, fl, S.trim);
    steps(c, sx, sx + 6, pf.z0, fl, deckM);
    // gable ornament (king post, collar) under the wing's rake, and a tall corbelled chimney
    const wcx = (wr.x0 + wr.x1) >> 1, ay = hAt(wing, wcx, wr.z0 - 1) - wing.t;
    g.box(wcx - 1, ay - 3, wr.z0 - 1, wcx + 1, ay, wr.z0, S.trim);                          // king post
    for (let i = 1; i <= 3; ++i) { g.set(wcx - 1 - i, ay - 3 - ((i + 1) >> 1), wr.z0 - 1, S.trim); g.set(wcx + i, ay - 3 - ((i + 1) >> 1), wr.z0 - 1, S.trim); }   // sunburst struts
    win(c, fw, (ww >> 1) - 1, yT + 3, 2, 4, { sash: acc, rail: false });
    const chx = r.x0 + Math.round(bw * 0.55), chz = r.z0 + (bd >> 1) + 2;
    chimney(c, chx, chz, chx + 3, chz + 4, ridgeOf(main) + 2, BM.BRICK_RED, { y0: yT, corbel: true });
    emit(E, c);
  }

  // ================================================================================================ tudor
  function tudor(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const brick = pick(R, [BM.BRICK_RED, BM.BRICK_BROWN, BM.BRICK_DARK, BM.BRICK_RED]);
    const stucco = pick(R, [BM.PAINT_CREAM, BM.LIMESTONE, BM.WHITE_CONCRETE, BM.BUFF]);
    const timber = pick(R, [BM.TRIM_DARK, BM.TRIM_DARK, BM.WOOD, BM.BRICK_DARK]);
    const S = pal(c, { wall: brick, trim: BM.LIMESTONE, roof: pick(R, [BM.SHINGLE_SLATE, BM.SHINGLE_BROWN, BM.SHINGLE_GRAY, BM.SHINGLE_SLATE]), door: BM.WOOD, found: brick, gut: BM.TRIM_DARK });
    const two = c.floors >= 2 && R() < 0.7, fl = 2, fh = 11, yT = two ? fl + 2 * fh : fl + fh + 1, s = two ? 1.15 + R() * 0.15 : 1.3 + R() * 0.2;
    const mL = 4, gw = garageW(c, W - mL - 2, 30), mR = gw ? 2 : 3;
    const bw = even(clamp(W - mL - mR - gw, 26, 50));
    const zf = 8, bd = Math.min(36, D - zf - 3);
    const x0 = bodyX(W, mL, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    // half-timbering over stucco: posts every 4, sill / plate rails, braces in alternate panels
    const ht = (yb, yt) => (u, y) => {
      const v = y - yb;
      if (v === 0 || y === yt - 1 || u % 4 === 0) return timber;
      if ((u >> 2) % 3 === 1 && (u % 4) === (v % 4)) return timber;
      return stucco;
    };
    const htA = (u, y) => (u % 3 === 0 || y % 6 === 0 ? timber : stucco);           // gables: close studding
    const upper = two ? ht(fl + fh, yT) : null;
    const wpat = (u, y) => (two && y >= fl + fh ? upper(u, y) : brick);
    walls(c, r, yT, fl, wpat, 0);
    if (two) band(c, r, fl + fh, timber);
    // front gable wing, offset left
    const ww = even(clamp(Math.round(bw * 0.38), 14, 20)), wx0 = r.x0 + Math.max(2, Math.round((bw - ww) * (0.1 + R() * 0.15)));
    const wr = { x0: wx0, x1: wx0 + ww, z0: r.z0 - 5, z1: r.z0 + 2 };
    walls(c, wr, yT, fl, wpat, 0, { faces: 'flr' });
    if (two) band(c, { x0: wr.x0, x1: wr.x1, z0: wr.z0, z1: r.z0 }, fl + fh, timber);
    // casement groups: dark frames, stone sills on brick
    const grp = (f, u, y, n, h) => win(c, f, u, y, n * 3 - 1, h, { trim: timber, sash: timber, mull: Array.from({ length: n - 1 }, (_, i) => i * 3 + 2), railY: h - 2, sillM: BM.LIMESTONE, lintel: y < fl + fh ? BM.LIMESTONE : 0 });
    const fw = F(wr, 'f');
    grp(fw, (ww >> 1) - 4, fl + 3, 3, 6);
    if (two) grp(fw, (ww >> 1) - 3, fl + fh + 3, 2, 6);
    // entry vestibule with a round-arched door, beside the wing
    const vx0 = wr.x1 + 1, vw = 9;
    const vr = { x0: vx0, x1: vx0 + vw, z0: r.z0 - 3, z1: r.z0 + 1 };
    walls(c, vr, fl + 10, fl, () => brick, 0, { faces: 'flr' });
    const fv = F(vr, 'f');
    fs(g, fv, 1, vw - 1, fl, fl + 12, 0, 1, BM.LIMESTONE, true);                                // stone surround
    fs(g, fv, 2, vw - 2, fl, fl + 9, 0, 1, -1); fs(g, fv, 3, vw - 3, fl + 9, fl + 10, 0, 1, -1);
    fs(g, fv, 2, vw - 2, fl, fl + 9, 1, 2, BM.WOOD); fs(g, fv, 3, vw - 3, fl + 9, fl + 10, 1, 2, BM.WOOD);
    fs(g, fv, 3, 4, fl + 4, fl + 5, 1, 2, BM.METAL);
    fs(g, fv, 0, 1, fl + 6, fl + 7, -1, 0, BM.GLASS_LIT);
    g.box(vr.x0, 0, vr.z0 - 3, vr.x1, fl, vr.z0, BM.LIMESTONE_DARK); steps(c, vr.x0 + 1, vr.x1 - 1, vr.z0 - 3, fl, BM.LIMESTONE_DARK);
    // the big front chimney right of the entry (if there is room), otherwise on the left gable end
    const cx0 = vr.x1 + 2, frontChim = r.x1 - cx0 >= 12;
    const ff = F(r, 'f');
    const restU0 = (frontChim ? cx0 + 8 : vr.x1 + 2) - r.x0;
    if (bw - restU0 >= 10) { grp(ff, restU0 + 1, fl + 3, (bw - restU0 >= 14) ? 3 : 2, 6); if (two) grp(ff, restU0 + 1, fl + fh + 3, 2, 6); }
    if (two && wr.x0 - r.x0 >= 9) grp(ff, 2, fl + fh + 3, 2, 6);
    if (wr.x0 - r.x0 >= 9) grp(ff, 2, fl + 3, 2, 6);
    for (const sd of ['l', 'r']) {
      if (sd === 'r' && gw) { if (two) grp(F(r, 'r'), (bd >> 1) - 3, fl + fh + 3, 2, 6); continue; }
      const f = F(r, sd);
      grp(f, (bd >> 1) - 4, fl + 3, 3, 6);
      if (two) grp(f, (bd >> 1) - 3, fl + fh + 3, 2, 6); else grp(f, (bd >> 1) - 2, yT + 3, 2, 5);
    }
    { const f = F(r, 'b'); door(c, f, 4, fl, 4, 8, { trim: timber, lite: true }); grp(f, bw - 14, fl + 3, 3, 6); if (two) { grp(f, 4, fl + fh + 3, 2, 6); grp(f, bw - 12, fl + fh + 3, 2, 6); } steps(c, r.x1 - 8, r.x1 - 4, r.z1 + 3, fl, BM.LIMESTONE_DARK); }
    // roofs
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'gx', s, ov: 1, attic: htA, gut: 'fb', ds: ['bl', 'br', 'fr'] });
    const wing = part(c, { x0: wr.x0, z0: wr.z0, x1: wr.x1, z1: r.z0 + (bd >> 1), y: yT, kind: 'gz', s: s + 0.2, ov: { f: 1, l: 1, r: 1 }, attic: htA });
    part(c, { x0: vr.x0, z0: vr.z0, x1: vr.x1, z1: vr.z1, y: fl + 10, kind: 'gz', s: 1.3, ov: { f: 1, l: 1, r: 1 }, attic: brick });
    if (gw) {
      const gz0 = r.z0 + 3 + Math.floor(R() * 4);
      const gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      garageWing(c, gr, { yT: 11, pat: () => brick, st: garageStyle(R, S, 'carriage'), trim: timber, sash: timber, roof: { kind: 'gx', s, ov: { f: 1, b: 1, l: 0, r: 1 }, attic: htA } });
    }
    roofs(c);
    if (!two) grp(fw, (ww >> 1) - 3, Math.max(yT + 3, fl + fh + 3), 2, 6);
    const ridge = ridgeOf(main);
    if (frontChim) {
      // stepped shoulders, tall stack with two flue pots, rising in front of the eave
      const zc = r.z0 - 3;
      chimney(c, cx0 + 1, zc, cx0 + 5, zc + 3, ridge + 3, brick, { base: [cx0, zc - 1, cx0 + 6, zc + 3], yS: fl + 9, cap: BM.LIMESTONE, pots: [[cx0 + 2, zc + 1], [cx0 + 3, zc + 1]] });
      g.box(cx0 + 1, fl + 9, zc - 1, cx0 + 5, fl + 10, zc, brick);
      for (let y = 4; y < ridge; y += 7) g.set(cx0 + 3, y, zc - 1, brick === BM.BRICK_DARK ? BM.LIMESTONE : BM.BRICK_DARK);
    } else { const zc = r.z0 + (bd >> 1); chimney(c, r.x0 - 3, zc - 2, r.x0, zc + 2, ridge + 3, brick, { base: [r.x0 - 3, zc - 3, r.x0, zc + 3], yS: yT - 3, cap: BM.LIMESTONE, pots: [[r.x0 - 2, zc - 1], [r.x0 - 2, zc]] }); }
    emit(E, c);
  }

  // ================================================================================================ modern farmhouse
  function farmhouse(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const dark = R() < 0.15;
    const S = pal(c, { wall: dark ? pick(R, [BM.GRANITE_DARK, BM.STEEL_DARK]) : pick(R, [BM.SIDING_WHITE, BM.SIDING_WHITE, BM.WHITE_CONCRETE, BM.PAINT_CREAM, BM.SIDING_GRAY]),
      trim: BM.SHUTTER_BLACK, roof: pick(R, [BM.SHINGLE_SLATE, BM.STEEL_DARK, BM.SHINGLE_SLATE, BM.SHINGLE_GRAY]), door: pick(R, [BM.WOOD, BM.SHUTTER_BLACK, BM.WOOD]),
      found: BM.CONCRETE, gut: BM.SHUTTER_BLACK });
    const metal = S.roof === BM.STEEL_DARK, seam = BM.SHUTTER_BLACK;
    const two = c.floors >= 2, fl = 2, fh = 11, yT = two ? fl + 2 * fh : fl + fh + 1, s = 0.92 + R() * 0.16;
    const m = 3, gw = garageW(c, W - m - 2, 30), mR = gw ? 2 : 3;
    const bw = even(clamp(W - m - mR - gw, 26, 52));
    const pd = clamp(D - 3 - 2 - 22, 4, 7), zf = pd + 2, bd = Math.min(36, D - zf - 3);
    const x0 = bodyX(W, m, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const bnb = PAT.bnb(S);
    walls(c, r, yT, fl, bnb, 0);
    // front gable wing on the left, flush with the porch front
    const ww = even(clamp(Math.round(bw * 0.4), 14, 20)), wp = Math.min(6, zf - 2);
    const wr = { x0: r.x0, x1: r.x0 + ww, z0: r.z0 - wp, z1: r.z0 + 2 };
    const wyT = two ? yT : yT;
    walls(c, wr, wyT, fl, bnb, 0, { faces: 'flr' });
    const wo = { trim: BM.SHUTTER_BLACK, sash: BM.SHUTTER_BLACK, mull: [2], lit: 0.38 };
    const fw = F(wr, 'f');
    win(c, fw, (ww >> 1) - 5, fl + 3, 4, 8, wo); win(c, fw, (ww >> 1) + 1, fl + 3, 4, 8, wo);
    if (two) win(c, fw, (ww >> 1) - 2, fl + fh + 3, 5, 6, wo);
    const ff = F(r, 'f'), rest = bw - ww;
    const du = ww + Math.max(3, Math.min(8, (rest >> 1) - 6));
    door(c, ff, du, fl, 4, 8, { m: S.door, trim: BM.SHUTTER_BLACK, side: true });
    if (rest - (du - ww) - 8 >= 12) win(c, ff, du + 9, fl + 3, Math.min(10, rest - (du - ww) - 14), 7, Object.assign({}, wo, { mull: [2, 5] }));
    if (two) spread(rest, rest >= 24 ? 2 : 1, 5, 4).forEach(u => win(c, ff, ww + u, fl + fh + 3, 5, 6, wo));
    for (const sd of ['l', 'r']) {
      if (sd === 'r' && gw) { if (two) win(c, F(r, 'r'), (bd >> 1) - 2, fl + fh + 3, 4, 6, wo); continue; }
      const f = F(r, sd);
      spread(bd, 2, 4, 6).forEach(u => { win(c, f, u, fl + 3, 4, 7, wo); if (two) win(c, f, u, fl + fh + 3, 4, 6, wo); });
    }
    { const f = F(r, 'b'); door(c, f, 5, fl, 8, 8, { m: L.glassMat(c.seed, 3, 3, 0.5), trim: BM.SHUTTER_BLACK }); win(c, f, bw - 12, fl + 3, 6, 6, wo); if (two) spread(bw, 3, 4, 5).forEach(u => win(c, f, u, fl + fh + 3, 4, 6, wo)); g.box(r.x0 + 3, 0, r.z1, r.x0 + 15, fl, r.z1 + 3, BM.WOOD); }
    // roofs: steep main gable, front gable wing, standing-seam porch roof
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'gx', s, ov: { f: 1, b: 1, l: 1, r: 1 }, attic: bnb, gut: 'fb', ds: ['bl', 'br'], seam: metal ? seam : 0 });
    const wing = part(c, { x0: wr.x0, z0: wr.z0, x1: wr.x1, z1: r.z0 + (bd >> 1), y: wyT, kind: 'gz', s: s + 0.05, ov: { f: 1, l: 1, r: 1 }, attic: bnb, seam: metal ? seam : 0 });
    const por = { x0: wr.x1, x1: r.x1, z0: r.z0 - pd, z1: r.z0 };
    part(c, { x0: por.x0, z0: por.z0, x1: por.x1, z1: por.z1, y: fl + 9, kind: 'shf', s: 0.3, lift: 1, ov: { f: 1, r: 1 }, attic: BM.WOOD, mat: BM.STEEL_DARK, seam, gut: 'f' });
    if (gw) {
      const gz0 = r.z0 + 2 + Math.floor(R() * 4);
      const gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      const gp = garageWing(c, gr, { yT: 12, pat: bnb, st: garageStyle(R, S, 'carriage'), trim: BM.SHUTTER_BLACK, sash: BM.SHUTTER_BLACK, lights: false,
        roof: { kind: 'gx', s, ov: { f: 1, b: 1, l: 0, r: 1 }, attic: bnb, seam: metal ? seam : 0 } });
      const f = F(gr, 'f');
      for (const u of (gw >= 24 ? [6, gw - 7] : [gw >> 1])) { fs(g, f, u, u + 1, 10, 11, -1, 0, BM.STEEL_DARK); fs(g, f, u, u + 1, 9, 10, -2, -1, BM.STEEL_DARK); fs(g, f, u, u + 1, 8, 9, -2, -1, BM.GLASS_LIT); }
      void gp;
    }
    roofs(c);
    win(c, fw, (ww >> 1) - 1, ridgeOf(wing) - wing.t - 7, 3, 4, Object.assign({}, wo, { mull: [] }));
    // porch: deck, cedar posts with knee braces, steps
    porch(c, { x0: por.x0, x1: por.x1, z0: por.z0, z1: por.z1, fl, beam: fl + 9, cols: spread(por.x1 - por.x0, Math.max(2, Math.round((por.x1 - por.x0) / 10) + 1), 2, 0).map(u => por.x0 + u), cw: 2, colM: BM.WOOD,
      skirt: BM.CONCRETE, deck: BM.WOOD, steps: [r.x0 + du - 2, r.x0 + du + 6], stepM: BM.CONCRETE });
    for (const u of spread(por.x1 - por.x0, Math.max(2, Math.round((por.x1 - por.x0) / 10) + 1), 2, 0)) for (const dx of [-1, 2]) g.set(por.x0 + u + dx, fl + 8, por.z0, BM.WOOD);
    // metal flue
    if (R() < 0.6) { const fx = r.x0 + bw - 8, fz = r.z0 + (bd >> 1) + 3; g.box(fx, yT, fz, fx + 1, hAt(main, fx, fz) + 3, fz + 1, BM.STEEL_DARK); g.box(fx - 1, hAt(main, fx, fz) + 3, fz - 1, fx + 2, hAt(main, fx, fz) + 4, fz + 2, BM.STEEL_DARK); }
    emit(E, c);
  }

  // ================================================================================================ dutch colonial
  function dutch(E, C, W, D, spec, R) {
    const c = ctx(C, W, D, spec, R), g = c.g;
    const S = pal(c, { wall: pick(R, [BM.SIDING_WHITE, BM.SIDING_YELLOW, BM.SIDING_GRAY, BM.SIDING_BLUE, BM.PAINT_CREAM, BM.SIDING_SAGE]),
      shutter: pick(R, [BM.SHUTTER_BLACK, BM.SHUTTER_GREEN, BM.DOOR_NAVY]), door: pick(R, [BM.DOOR_RED, BM.DOOR_NAVY, BM.SHUTTER_BLACK, BM.WOOD]),
      roof: pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_SLATE, BM.SHINGLE_BROWN, BM.SHINGLE_SLATE]), deck: pick(R, [BM.BRICK_RED, BM.CONCRETE]) });
    const fl = 2, yT = fl + 12, k = 4 + (R() < 0.5 ? 1 : 0);
    const mL = 5, gw = garageW(c, W - mL - 2, 28), mR = gw ? 2 : 3;
    const bw = even(clamp(W - mL - mR - gw, 24, 48));
    const zf = 6, bd = Math.min(36, D - zf - 3);
    const x0 = bodyX(W, mL, mR, gw, bw);
    const r = { x0, z0: zf, x1: x0 + bw, z1: zf + bd };
    const lap = PAT.lap(S, fl);
    walls(c, r, yT, fl, lap, S.trim);
    const ff = F(r, 'f'), shut = S.shutter, n = bw >= 40 ? 4 : 2, us = spread(bw, n, 4, 4);
    const doorLeft = R() < 0.4;
    const du = doorLeft ? 6 : (bw >> 1) - 2;
    us.forEach(u => { if (Math.abs(u - du) > 7) win(c, ff, u, fl + 3, 4, 7, { shut, sw: 2 }); });
    door(c, ff, du, fl, 4, 8, { lite: true, transom: R() < 0.5, lamp: true });
    const main = part(c, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: yT, kind: 'gam', s: 2, k, s2: 0.5, flare: 0.5, t: 2, ov: { f: 2, b: 2, l: 1, r: 1 }, attic: lap, gut: 'fb', ds: ['fl', 'fr', 'bl', 'br'] });
    // long shed dormer on the front lower slope
    const rz = r.z0 + ((bd - 1) >> 1), dz0 = r.z0 + 1, wy = hAt(main, r.x0, r.z0) + 1, dTop = Math.min(wy + 6, hAt(main, r.x0, r.z0 + k) - 1);
    const dr = { x0: r.x0 + 3, x1: r.x1 - 3, z0: dz0, z1: rz };
    g.box(dr.x0, yT, dr.z0, dr.x1, dTop, dr.z1, S.wall);
    skin(c, dr, yT, dTop, lap, { faces: 'flr', corner: S.trim });
    const ridge = ridgeOf(main);
    const ds = Math.max(0.15, Math.min(0.35, (ridge - 2 - dTop - 2) / Math.max(1, rz - dz0)));
    part(c, { x0: dr.x0, z0: dr.z0, x1: dr.x1, z1: dr.z1, y: dTop, kind: 'shf', s: ds, ov: { f: 1, l: 1, r: 1 }, attic: lap });
    for (const sd of ['l', 'r']) {
      if (sd === 'r' && gw) continue;
      const f = F(r, sd);
      spread(bd, 2, 4, 6).forEach(u => win(c, f, u, fl + 3, 4, 7, { shut, sw: 2 }));
    }
    { const f = F(r, 'b'); spread(bw, n, 4, 4).forEach((u, i) => (i === 1 ? door(c, f, u, fl, 4, 8, { lite: true }) : win(c, f, u, fl + 3, 4, 7))); }
    if (gw) {
      const gz0 = r.z0 + 3 + Math.floor(R() * 4);
      const gr = { x0: r.x1, x1: r.x1 + gw, z0: gz0, z1: Math.min(r.z1, gz0 + 24) };
      garageWing(c, gr, { yT: 10, pat: lap, corner: S.trim, st: garageStyle(R, S), roof: { kind: 'gam', s: 1.6, k: 3, s2: 0.5, flare: 0.5, ov: { f: 1, b: 1, l: 0, r: 1 }, attic: lap } });
    }
    roofs(c);
    const fd = F(dr, 'f'), dlen = dr.x1 - dr.x0;
    spread(dlen, Math.max(2, Math.floor(dlen / 9)), 4, 3).forEach(u => win(c, fd, u, wy, 4, Math.max(3, dTop - wy - 1), { rail: dTop - wy - 1 >= 5 }));
    // gambrel ends: attic windows, end chimney, back shed dormer windows
    for (const sd of ['l', 'r']) { const f = F(r, sd); win(c, f, (bd >> 1) - 5, yT + 5, 3, 5); if (!(sd === 'l')) win(c, f, (bd >> 1) + 2, yT + 5, 3, 5); }
    vent(c, F(r, 'r'), bd >> 1, ridge - 3, 3, 2);
    // entry hood on brackets, or a small portico with columns
    const dcx = r.x0 + du + 2;
    if (R() < 0.5) {
      g.box(dcx - 5, 0, r.z0 - 4, dcx + 5, fl, r.z0, S.deck); steps(c, dcx - 4, dcx + 4, r.z0 - 4, fl, S.deck);
      for (const x of [dcx - 5, dcx + 3]) g.box(x, fl, r.z0 - 4, x + 2, 12, r.z0 - 2, S.trim);
      g.box(dcx - 6, 12, r.z0 - 5, dcx + 6, 13, r.z0, S.trim); g.box(dcx - 6, 13, r.z0 - 5, dcx + 6, 14, r.z0, S.roof);
    } else {
      g.box(dcx - 4, 0, r.z0 - 3, dcx + 4, fl, r.z0, S.deck); steps(c, dcx - 3, dcx + 3, r.z0 - 3, fl, S.deck);
      g.box(dcx - 4, 12, r.z0 - 2, dcx + 4, 13, r.z0, S.trim); g.box(dcx - 5, 13, r.z0 - 3, dcx + 5, 14, r.z0, S.roof);
      for (const x of [dcx - 4, dcx + 3]) g.box(x, 10, r.z0 - 1, x + 1, 12, r.z0, S.trim);
    }
    const zc = r.z0 + (bd >> 1);
    chimney(c, r.x0 - 3, zc - 2, r.x0, zc + 2, ridge + 2, pick(R, [BM.BRICK_RED, BM.LIMESTONE_DARK, BM.BRICK_RED]), { base: [r.x0 - 3, zc - 3, r.x0, zc + 3], yS: yT - 2 });
    emit(E, c);
  }

  A.registerHouse('colonial', colonial, { minW: 9, maxW: 30, minD: 7, maxD: 30, weight: 1.2 });
  A.registerHouse('cape_cod', cape, { minW: 7, maxW: 30, minD: 6.5, maxD: 30, weight: 1 });
  A.registerHouse('ranch', ranch, { minW: 10.5, maxW: 30, minD: 7, maxD: 30, weight: 1 });
  A.registerHouse('craftsman', craftsman, { minW: 6, maxW: 30, minD: 7, maxD: 30, weight: 1.1 });
  A.registerHouse('split_level', splitLevel, { minW: 10, maxW: 30, minD: 7, maxD: 30, weight: 0.7 });
  A.registerHouse('victorian', victorian, { minW: 10, maxW: 30, minD: 8.5, maxD: 30, weight: 0.6 });
  A.registerHouse('tudor', tudor, { minW: 9.5, maxW: 30, minD: 8, maxD: 30, weight: 0.8 });
  A.registerHouse('farmhouse', farmhouse, { minW: 9, maxW: 30, minD: 7.5, maxD: 30, weight: 1 });
  A.registerHouse('dutch_colonial', dutch, { minW: 8.5, maxW: 30, minD: 7.5, maxD: 30, weight: 0.7 });
})();
