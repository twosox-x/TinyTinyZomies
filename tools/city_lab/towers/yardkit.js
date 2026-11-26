// Yard kit: dresses a suburban house lot - lawn, beds, walks, driveway, boundaries, trees, bushes and backyard life.
//
// CityArch.lib.yardKit(E, C, lot, R, opts) -> { quads, trees, items }
//   E     emitter in the LOT frame: origin at the front-left corner on the property line (back of the sidewalk),
//         x along the street, z into the lot, y = 0 at yard level. Voxels of 0.25 m (L.BV).
//   lot   { w, d, house: { x0, z0, x1, z1 }, drive: { x0, x1 [, z1] } | null, garage: bool,
//           optional door: x (front door centre) or doors: [x, ...] (several entries, e.g. a townhouse row),
//           porch: { x0, x1, z0 } (a porch / steps zone outside the footprint, if any) }
//         The house model keeps its porch and steps inside the footprint (towers/houses.js); the drive and the walk
//         run up to 1 m under the front edge so recessed garage doors / entries meet their paving. Without door
//         info the walk aims at the middle of the non-garage front; a wide 'townhouse' building with no doors gets
//         no walks, front beds or front fence (its entries are unknown).
//   R     seeded random in [0,1) (everything is drawn from it: deterministic per lot)
//   opts  { style: 'suburban' | 'townhouse' | 'corner' | 'commercial', neighbours: { l, r, b }, seed }
//
// Layout (per lot):
//   1. ground: one height map at 12.5 cm cells meshed by the column mesher - a mown lawn 11 cm above the yard
//      ground (one tone per lot, two-tone mowing stripes on some lots, worn patches under play equipment), a sunk
//      soil edging on owned lot lines that have no fence, mulch beds along the house front (straight or curved
//      fronts), mulch rings round trees, the front walk (straight, branching off the driveway, or stepping
//      stones), the driveway (concrete, asphalt, pavers, gravel or two tyre strips; flared at the sidewalk), a
//      patio or deck behind the house, rarely an in-ground pool.
//   2. boundaries (ownership rule: back line and left line always, the right line only without a right
//      neighbour, the front line optionally; every run sits inside the lot): white picket (front, corner side
//      yards), wood privacy (back / sides, cedar, brown, grey or white vinyl), chain-link, clipped hedges and low
//      stone or brick walls. The back part of the side lines meets the house with wing fences and gates; gates
//      or piers where walks cross, plain openings at driveways, sometimes an arbor.
//   3. trees: oak and maple (round crowns), conifers, ornamental cherry / dogwood, birch clumps; 6-14 m, 1-3 per
//      lot with a backyard bias; crowns stay inside the lot, off the house and off each other.
//   4. bushes and flowers: round boxwood, clipped blocks, arborvitae columns, hydrangeas, spreading junipers,
//      flower clumps along the bed fronts.
//   5. backyard life, sparingly: patio set with umbrella, grill, swing set, trampoline, shed, above-ground pool,
//      raised garden beds, clothesline, toys, sandbox, playhouse, fire pit, AC unit, bins; mailbox at the curb
//      end of the drive, a parked car on some driveways.
//
// Geometry rules:
//   - every part is a cached VoxModel (fences: runs of shared panel / gate pieces), meshed once and
//     emitted through E.quad at its own scale (6.25 cm, 12.5 cm or 25 cm voxels); down faces resting on the
//     ground are not emitted;
//   - no coplanar faces: ground surfaces sit at multiples of 1/20 voxel, every model is offset by 1/32 voxel
//     in x, y and z, so model faces (k/16 + 1/32) never share a plane with the ground (0), the house (whole
//     voxels), the surfaces or the street mesh; items keep >= 1 voxel between each other, from the house and
//     from the lot lines; fence runs abut end to end (opposite faces only);
//   - nothing inside the house footprint or on the driveway (except the parked car).
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM;
  // shared palette ids (city_core MAT / PM, city_arch BM)
  const K = {
    GRASS: BM.GRASS, PARK: 14, MGRASS: 10, YARD: 16, PLOT: 11, PLAZA: 12, PATH: 18, ASPH: 2, ASPH_D: 3, ASPH_B: 1,
    LEAF: 133, LEAF_D: 134, TRUNK: 135, SOIL: 140, EVER: 137, CEDAR: 136, PALLET: 129, RED: 131, YEL: 132, BLUE: 139,
    WHITE: 64, PWHITE: 69, CONC: 70, STEEL: 130, POLE_D: 55, BLACK: 58, BIN_G: 126, BIN_B: 127, SRED: 63, SGREEN: 65, ORANGE: 68
  };
  const S4 = 0.25, S2 = 0.5, S1 = 1;              // model voxel sizes in building voxels (6.25 cm, 12.5 cm, 25 cm)
  const J = 1 / 32;                                // model offset (see header)
  const HU = 0.05;                                 // ground height unit (voxels)
  const LAWN = 9, EDGE = 6, DRIVE = 7, WALK = 8, BED = 11, PATIO = 13, DECK = 19, COPING = 15, WATER = 3, STONE = 10;
  const CACHE = new Map();
  const cached = (key, make) => { let M = CACHE.get(key); if (!M) { M = make(); CACHE.set(key, M); } return M; };
  const pick = (R, a) => a[Math.floor(R() * a.length) % a.length];
  const wpick = (R, pairs) => { let t = R() * pairs.reduce((s, p) => s + p[1], 0); for (const p of pairs) { t -= p[1]; if (t <= 0) return p[0]; } return pairs[0][0]; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const VM = (w, h, d, ox, oz) => new (L.VoxModel())(w, h, d, ox, oz);
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (C, s) => C.mulberry32(hash(s));

  // ------------------------------------------------------------------------------------------ emission
  const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  // orientation k: model (u, v) -> lot (a*u + b*v, c*u + d*v); mir flips u first
  const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
  function xf(k, mir) { const r = Array.isArray(k) ? k : ROT[k & 3]; return mir ? [-r[0], r[1], -r[2], r[3]] : r; }
  // place model M (origin at its (ox, oz) column) at lot point (x, y, z), voxel size sc, orientation k / matrix
  function put(S, M, x, y, z, sc, k, mir) {
    const C = S.C, m = M._yk || (M._yk = C.meshVoxels3D(M)), P = m.pos, f = sc / C.PV, r = xf(k || 0, mir);
    for (let q = 0; q < m.quads; ++q) {
      const n = m.nrm[q * 4], o = q * 12;
      if (n === 5 && P[o + 1] === 0 && P[o + 4] === 0 && P[o + 7] === 0 && P[o + 10] === 0) continue;   // rests on the ground
      const c = (i) => { const u = P[o + i * 3] * f, v = P[o + i * 3 + 2] * f; return [x + r[0] * u + r[1] * v, y + P[o + i * 3 + 1] * f, z + r[2] * u + r[3] * v]; };
      const N = NV[n];
      S.E.quad(c(0), c(1), c(2), c(3), m.mat[q * 4], [r[0] * N[0] + r[1] * N[2], N[1], r[2] * N[0] + r[3] * N[2]]);
      S.quads++; S.by[S.tag] = (S.by[S.tag] || 0) + 1;
    }
  }
  // lot-space rectangle a model covers when placed at (x, z)
  function foot(M, x, z, sc, k, mir) {
    const r = xf(k || 0, mir), us = [-M.ox * sc, (M.w - M.ox) * sc], vs = [-M.oz * sc, (M.d - M.oz) * sc];
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const u of us) for (const v of vs) { const X = x + r[0] * u + r[1] * v, Z = z + r[2] * u + r[3] * v; x0 = Math.min(x0, X); x1 = Math.max(x1, X); z0 = Math.min(z0, Z); z1 = Math.max(z1, Z); }
    return [x0, z0, x1, z1];
  }

  // ------------------------------------------------------------------------------------------ model helpers
  // octagonal slab: two crossed boxes centred on cell corner (cx, cz)
  function oct(M, cx, cz, r, y0, y1, m) {
    if (r < 1) { M.box(cx - 1, y0, cz - 1, cx + 1, y1, cz + 1, m); return; }
    const r2 = Math.max(1, Math.round(r * 0.62));
    M.box(cx - r, y0, cz - r2, cx + r, y1, cz + r2, m); M.box(cx - r2, y0, cz - r, cx + r2, y1, cz + r, m);
  }
  // rounded blob: three octagonal layers (narrow bottom, full middle, narrow top in the top tone)
  function blob(M, cx, cy, cz, r, hy, mLow, mTop) {
    const a = cy - hy, b = cy - Math.round(hy / 3), c = cy + Math.round(hy / 3), e = cy + hy;
    oct(M, cx, cz, Math.round(r * 0.74), a, b, mLow);
    oct(M, cx, cz, r, b, c, mLow);
    oct(M, cx, cz, Math.round(r * 0.66), c, e, mTop || mLow);
  }
  // cheaper two-layer blob (tree crowns): full octagon below, a narrower cap in the top tone
  function blob2(M, cx, cy, cz, r, hy, mLow, mTop) {
    const b = cy + Math.round(hy * 0.4);
    oct(M, cx, cz, r, cy - hy, b, mLow);
    oct(M, cx, cz, Math.max(1, Math.round(r * 0.66)), b, cy + hy, mTop || mLow);
  }
  // filled disc of columns (centre on a cell corner), one box per column
  function disc(M, cx, cz, r, y0, y1, m, rin) {
    for (let u = Math.floor(-r); u < Math.ceil(r); ++u) {
      const du = u + 0.5, h2 = r * r - du * du;
      if (h2 <= 0) continue;
      const hv = Math.sqrt(h2), v1 = Math.round(hv);
      if (v1 <= 0) continue;
      if (rin && rin * rin - du * du > 0) {
        const vi = Math.round(Math.sqrt(rin * rin - du * du));
        if (vi > 0 && vi < v1) { M.box(cx + u, y0, cz - v1, cx + u + 1, y1, cz - vi, m); M.box(cx + u, y0, cz + vi, cx + u + 1, y1, cz + v1, m); continue; }
        if (vi >= v1) continue;
      }
      M.box(cx + u, y0, cz - v1, cx + u + 1, y1, cz + v1, m);
    }
  }

  // ------------------------------------------------------------------------------------------ trees (25 cm voxels)
  // returns { M, rc (crown radius, voxels), base (crown underside height, voxels), low (crown reaches below 2.4 m) }
  function treeModel(C, sp, vr, small) {
    return cached('tree:' + sp + ':' + vr + (small ? ':s' : ''), () => {
      const Rm = rng(C, 'tree' + sp + vr);
      let rc, ht, M, base, low = false;
      if (sp === 'oak' || sp === 'maple' || sp === 'redmaple') {
        const oak = sp === 'oak';
        ht = oak ? 40 + Math.floor(Rm() * 14) : 32 + Math.floor(Rm() * 14);
        rc = oak ? 15 + Math.floor(Rm() * 4) : 11 + Math.floor(Rm() * 4); if (small) { ht = Math.round(ht * 0.78); rc = Math.round(rc * 0.66); }
        M = VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
        const lo = sp === 'redmaple' ? pick(Rm, [BM.BRICK_RED, BM.AWNING_RED]) : oak ? K.LEAF_D : K.LEAF;
        const hi = sp === 'redmaple' ? pick(Rm, [BM.PAINT_SALMON, K.ORANGE]) : oak ? K.LEAF : pick(Rm, [K.PARK, K.LEAF]);
        const cy = ht - Math.round(rc * 0.8), tt = Math.round(cy - rc * 0.3);
        base = Math.round(cy - rc * 0.55);
        const tw = oak ? 2 : 1;
        M.box(-tw, 0, -tw, tw, tt, tw, K.TRUNK);
        const lx = Rm() < 0.5 ? 1 : -1;                   // a limb leaning out into the crown
        M.box(lx * 2 - 1, tt - 5, -1, lx * 2 + 1, tt + 1, 1, K.TRUNK);
        // a broad lower mass, side lobes, a lighter top
        const n = oak ? 3 : 2, a0 = Rm() * 6.28;
        blob2(M, 0, cy - Math.round(rc * 0.15), 0, Math.round(rc * 0.82), Math.round(rc * (oak ? 0.42 : 0.5)), lo, lo);
        for (let i = 0; i < n; ++i) {
          const an = a0 + i * 6.283 / n + (Rm() - 0.5) * 0.5, rr = Math.round(rc * 0.45), dist = rc - rr - 1;
          blob2(M, Math.round(Math.cos(an) * dist), cy + Math.round((Rm() - 0.3) * rc * 0.3), Math.round(Math.sin(an) * dist), rr, Math.round(rr * 0.8), lo, hi);
        }
        blob2(M, 0, ht - Math.round(rc * 0.35), 0, Math.round(rc * 0.5), Math.round(rc * 0.35), hi, hi);
      } else if (sp === 'conifer') {
        ht = 34 + Math.floor(Rm() * 18); rc = 7 + Math.floor(Rm() * 3); if (small) { ht = Math.round(ht * 0.78); rc = Math.round(rc * 0.66); }
        M = VM(2 * rc + 4, ht + 3, 2 * rc + 4, rc + 2, rc + 2);
        const m1 = pick(Rm, [K.EVER, K.LEAF_D]), m2 = m1 === K.EVER ? K.LEAF_D : K.EVER;
        M.box(-1, 0, -1, 1, ht - 4, 1, K.TRUNK);
        base = 4 + Math.floor(Rm() * 3); low = true;
        const tiers = clamp(Math.round((ht - base) / 6), 5, 7), th = (ht - base) / tiers;
        for (let t = 0; t < tiers; ++t) {
          const f = 1 - t / tiers, r = Math.max(1, Math.round(rc * Math.pow(f, 0.9)));
          oct(M, 0, 0, r, Math.round(base + t * th), Math.round(base + (t + 1) * th), t & 1 ? m2 : m1);
        }
        M.box(-1, ht, -1, 1, ht + 2, 1, m1);
      } else if (sp === 'cherry' || sp === 'dogwood') {
        ht = 22 + Math.floor(Rm() * 7); rc = 10 + Math.floor(Rm() * 3); if (small) { ht = Math.round(ht * 0.78); rc = Math.round(rc * 0.72); }
        M = VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
        // blossom: cherry pinks; dogwood a warm cream (never paint white, which reads as a blown-out blob in the
        // sun), a second tone on alternate lobes, green below the lobes and dappled through the top
        const bl = sp === 'cherry' ? pick(Rm, [BM.PAINT_SALMON, BM.GRANITE_PINK, BM.PAINT_SALMON]) : pick(Rm, [BM.PAINT_CREAM, BM.LIMESTONE]);
        const bl2 = sp === 'cherry' ? (bl === BM.GRANITE_PINK ? BM.PAINT_SALMON : BM.GRANITE_PINK) : (bl === BM.PAINT_CREAM ? BM.LIMESTONE : BM.GRANITE_PINK);
        const tt = 7 + Math.floor(Rm() * 3);
        M.box(-1, 0, -1, 1, tt, 1, K.TRUNK);
        for (const [dx, dz] of [[1, 0], [-1, 1]]) M.box(dx * 2 - 1, tt, dz * 2 - 1, dx * 2 + 1, tt + 4, dz * 2 + 1, K.TRUNK);
        const cy = ht - 5; base = cy - 5; low = true;
        blob2(M, 0, cy - 1, 0, rc - 1, 3, K.LEAF, bl);
        const a0 = Rm() * 6.28;
        for (let i = 0; i < 3; ++i) {
          const an = a0 + i * 2.094, rr = 5, dist = rc - rr - 1;
          blob2(M, Math.round(Math.cos(an) * dist), cy + 1 + Math.round(Rm() * 2), Math.round(Math.sin(an) * dist), rr, 3, K.LEAF, i === 1 ? bl2 : bl);
        }
        L.dappleTop(M, rc + 1, K.LEAF, 5, 2);
      } else {                                           // birch clump: three leaning white stems
        ht = 30 + Math.floor(Rm() * 12); rc = 9 + Math.floor(Rm() * 2); if (small) { ht = Math.round(ht * 0.78); rc = Math.round(rc * 0.75); }
        M = VM(2 * rc + 4, ht + 2, 2 * rc + 4, rc + 2, rc + 2);
        base = 13;
        const a0 = Rm() * 6.28;
        const tops = [];
        for (let i = 0; i < 3; ++i) {
          const an = a0 + i * 2.094, sx = Math.cos(an), sz = Math.sin(an), h = ht - 6 - i * 3, hm = Math.round(h * 0.45);
          const p1 = [Math.round(sx), Math.round(sz)], p2 = [Math.round(sx * 3), Math.round(sz * 3)];
          M.box(p1[0], 0, p1[1], p1[0] + 1, hm, p1[1] + 1, K.WHITE);
          M.box(p2[0], hm, p2[1], p2[0] + 1, h, p2[1] + 1, K.WHITE);
          M.box(p1[0], Math.round(hm * 0.5), p1[1], p1[0] + 1, Math.round(hm * 0.5) + 1, p1[1] + 1, K.BLACK);
          M.box(p2[0], hm + 4, p2[1], p2[0] + 1, hm + 5, p2[1] + 1, K.BLACK);
          tops.push([Math.round(sx * (rc - 5)), h, Math.round(sz * (rc - 5))]);
        }
        for (const [x, y, z] of tops) blob2(M, x, y - 2, z, 5, 4, K.LEAF, K.PARK);
        blob2(M, 0, ht - 8, 0, 6, 4, K.LEAF, K.PARK);
      }
      return { M, rc: rc + 1, base, low, sp };
    });
  }

  // ------------------------------------------------------------------------------------------ bushes (12.5 cm)
  function bushModel(C, kind, vr) {
    return cached('bush:' + kind + ':' + vr, () => {
      const Rm = rng(C, 'bush' + kind + vr);
      let M;
      if (kind === 'round') {
        const r = 4 + Math.floor(Rm() * 3);
        M = VM(2 * r + 2, 2 * r + 2, 2 * r + 2, r + 1, r + 1);
        blob(M, 0, r, 0, r, r, pick(Rm, [K.LEAF_D, K.EVER]), K.LEAF);
      } else if (kind === 'block') {
        const w = 7 + Math.floor(Rm() * 4), d = 6 + Math.floor(Rm() * 2), h = 6 + Math.floor(Rm() * 3), m = pick(Rm, [K.LEAF_D, K.EVER]);
        M = VM(w + 2, h + 1, d + 2, (w >> 1) + 1, (d >> 1) + 1);
        const x0 = -(w >> 1), z0 = -(d >> 1);
        M.box(x0 + 1, 0, z0, x0 + w - 1, h - 1, z0 + d, m); M.box(x0, 0, z0 + 1, x0 + w, h - 1, z0 + d - 1, m);
        M.box(x0 + 1, h - 1, z0 + 1, x0 + w - 1, h, z0 + d - 1, K.LEAF);
      } else if (kind === 'arbor') {
        const h = 13 + Math.floor(Rm() * 7);
        M = VM(8, h + 1, 8, 4, 4);
        oct(M, 0, 0, 3, 0, Math.round(h * 0.55), K.EVER);
        oct(M, 0, 0, 2, Math.round(h * 0.55), Math.round(h * 0.88), K.EVER);
        M.box(-1, Math.round(h * 0.88), -1, 1, h, 1, K.LEAF_D);
      } else if (kind === 'hydrangea') {
        const r = 4 + Math.floor(Rm() * 2), fl = pick(Rm, [K.BLUE, K.PWHITE, BM.PAINT_SALMON, BM.GRANITE_PINK]);
        M = VM(2 * r + 4, 2 * r + 3, 2 * r + 4, r + 2, r + 2);
        blob(M, 0, r, 0, r, r - 1, K.LEAF, K.LEAF);
        const pts = [[-r + 1, r + 1, -1], [r - 2, r, 1], [-1, 2 * r - 2, -2], [1, 2 * r - 2, 1], [-2, r + 2, r - 2], [1, r - 1, -r + 1]];
        for (const [x, y, z] of pts) M.box(x - 1, y, z - 1, x + 1, y + 2, z + 1, fl);
      } else if (kind === 'juniper') {
        const r = 6 + Math.floor(Rm() * 3);
        M = VM(2 * r + 2, 6, 2 * r + 2, r + 1, r + 1);
        oct(M, 0, 0, r, 0, 2, K.EVER); oct(M, 1, 0, r - 2, 2, 4, K.EVER); oct(M, 0, 1, r - 4, 4, 5, K.LEAF_D);
      } else {                                           // flower clump (6.25 cm voxels, placed at S4)
        const cols = [[K.RED, K.YEL], [K.PWHITE, BM.GRANITE_PINK], [K.YEL, K.ORANGE], [K.BLUE, K.PWHITE], [BM.PAINT_SALMON, K.RED], [K.ORANGE, K.YEL]];
        const c = cols[vr % cols.length];
        M = VM(10, 7, 8, 5, 4);
        M.box(-4, 0, -3, 4, 3, 3, K.LEAF); M.box(-3, 3, -2, 3, 4, 2, K.LEAF);
        for (const [x, z, i] of [[-4, -2, 0], [-1, 0, 1], [2, -3, 0], [1, 2, 1], [-3, 1, 1], [3, 0, 0]]) M.box(x, 3 + (i ? 1 : 0), z, x + 1 + (i ^ 1), 5 + (i ? 1 : 0), z + 1 + i, c[i]);
      }
      return M;
    });
  }

  // ------------------------------------------------------------------------------------------ fence runs
  // A run is authored along u (cells), across v [0, T) with v = 0 on the owner's side. It is laid as a row of
  // cached pieces shared by every lot: sections (a post / pier / rounded end at u = 0, standard panels, a last piece
  // of any length with the closing post), gate pieces (post, leaf or opening, post) between sections. Pieces abut
  // end to end, so only opposite faces meet. Types: privacy, picket, chain, hedge, lowhedge, wall.
  const RUN_T = { privacy: 3, picket: 4, chain: 4, hedge: 6, lowhedge: 5, wall: 7 };
  const RUN_S = { privacy: S4, picket: S4, chain: S4, hedge: S2, lowhedge: S2, wall: S4 };   // voxel size per type
  const RUN_P = { privacy: 38, picket: 36, chain: 40, hedge: 20, lowhedge: 20, wall: 64 };    // panel length (cells)
  const RUN_W = { privacy: 3, picket: 3, chain: 2, hedge: 0, lowhedge: 0, wall: 8 };          // post / pier width
  const RUN_H = { privacy: 29, picket: 15, chain: 19, hedge: 11, lowhedge: 6, wall: 9 };
  // a section piece of length L: start post (sp), closing post (ep); hedges: rounded ends instead, variant vr
  function runSeg(C, type, L, sp, ep, mats, vr) {
    return cached('seg:' + type + ':' + L + ':' + +sp + +ep + ':' + mats.join(',') + ':' + vr, () => {
      const T = RUN_T[type], pw = RUN_W[type], h = RUN_H[type];
      let M;
      const posts = []; if (sp) posts.push(0); if (ep) posts.push(L - pw);
      if (type === 'privacy') {
        const [board, post] = mats;
        M = VM(L, h + 1, T, 0, 0);
        M.box(0, 0, 1, L, h - 1, 2, board);
        M.box(0, 4, 0, L, 6, 1, post); M.box(0, h - 7, 0, L, h - 5, 1, post);
        M.box(0, h - 1, 0, L, h, T, post);
        for (const u of posts) M.box(u, 0, 0, u + pw, h, T, post);
      } else if (type === 'picket') {
        // pickets (3 wide, 3 apart) on the street side, two rails on the owner's side just behind them
        const [pk, , scallop] = mats;
        M = VM(L, h + 4, T, 0, 0);
        M.box(0, 3, 0, L, 4, 1, pk); M.box(0, 11, 0, L, 12, 1, pk);
        const a = sp ? pw + 1 : 1, b = L - (ep ? pw + 1 : 1);
        for (let u = a; u + 3 <= b; u += 6) {
          const hh = scallop === 's' ? h - Math.round(3 * Math.sin(Math.PI * clamp((u + 1.5) / L, 0, 1))) : h;
          M.box(u, 0, 2, u + 3, hh, 3, pk);
        }
        for (const u of posts) { M.box(u, 0, 0, u + pw, h + 2, T, pk); M.box(u + 1, h + 2, 1, u + 2, h + 3, 3, pk); }
      } else if (type === 'chain') {
        const [wire, post] = mats;
        M = VM(L, h + 1, T, 0, 0);
        for (let y = 2; y < h - 1; y += 3) M.box(0, y, 3, L, y + 1, 4, wire);        // mesh hung just off the posts
        M.box(0, h - 1, 0, L, h, 2, post);
        for (const u of posts) M.box(u, 0, 0, u + pw, h + 1, 2, post);
        if (!sp && !ep && L >= 30) M.box((L >> 1) - 1, 0, 0, (L >> 1) + 1, h + 1, 2, post);
      } else if (type === 'hedge' || type === 'lowhedge') {
        // 12.5 cm voxels: clipped body, lighter sheared top, uneven height every 60 cm
        const [mLow, mTop] = mats, Rm = rng(C, 'hedge' + vr);
        M = VM(L, h + 2, T, 0, 0);
        for (let u = 0; u < L; u += 5) {
          const u1 = Math.min(L, u + 5), hc = h + (Rm() < 0.3 ? 1 : 0);
          M.box(u, 0, 0, u1, hc - 2, T, mLow);
          M.box(u, hc - 2, 0, u1, hc, T, mTop);
        }
        for (const u of [sp ? 0 : -1, ep ? L - 1 : -1]) if (u >= 0) { M.box(u, 0, 0, u + 1, h + 2, 1, -1); M.box(u, 0, T - 1, u + 1, h + 2, T, -1); M.box(u, h - 1, 0, u + 1, h + 2, T, -1); }
      } else {                                           // low wall with a cap, piers at the section ends
        const [stone, cap] = mats;
        M = VM(L, h + 6, T, 0, 0);
        M.box(0, 0, 1, L, h, T - 1, stone); M.box(0, h, 0, L, h + 1, T, cap);
        for (const u of posts) { M.box(u, 0, 0, u + pw, h + 4, T, stone); M.box(u, h + 4, 0, u + pw, h + 5, T, cap); M.box(u + 2, h + 5, 2, u + pw - 2, h + 6, T - 2, cap); }
      }
      return M;
    });
  }
  // a gate piece: post, leaf (kind 'gate') or nothing ('open'), post; gw = opening width (cells)
  function runGate(C, type, gw, kind, mats) {
    return cached('gate:' + type + ':' + gw + ':' + kind + ':' + mats.join(','), () => {
      const T = RUN_T[type], pw = RUN_W[type], h = RUN_H[type], L = gw + 2 * pw, b = pw + gw;
      const M = VM(L, h + 6, T, 0, 0);
      if (type === 'privacy') {
        const [board, post] = mats;
        for (const u of [0, b]) M.box(u, 0, 0, u + pw, h + 2, T, post);
        if (kind === 'gate') {
          M.box(pw + 1, 2, 1, b - 1, h - 1, 2, board);
          M.box(pw + 1, 4, 0, b - 1, 6, 1, post); M.box(pw + 1, h - 7, 0, b - 1, h - 5, 1, post);
          for (let k = 0; k < 4; ++k) { const u = pw + 2 + Math.round((gw - 5) * k / 3); M.box(u, 6 + k * 4, 0, u + 2, 10 + k * 4, 1, post); }
          M.box(b - 3, 15, 0, b - 2, 16, 1, BM.STEEL_DARK);
        }
      } else if (type === 'picket') {
        const [pk] = mats;
        for (const u of [0, b]) { M.box(u, 0, 0, u + pw, h + 2, T, pk); M.box(u + 1, h + 2, 1, u + 2, h + 4, 3, pk); }
        if (kind === 'gate') {
          M.box(pw + 1, 3, 0, b - 1, 4, 1, pk); M.box(pw + 1, 11, 0, b - 1, 12, 1, pk);
          for (let u = pw + 2; u + 3 <= b - 1; u += 5) M.box(u, 1, 2, u + 3, h - 1, 3, pk);
          M.box(pw + 1, 4, 1, b - 1, 5, 2, pk);
        }
      } else if (type === 'chain') {
        const [wire, post] = mats;
        for (const u of [0, b]) M.box(u, 0, 0, u + pw, h + 1, 2, post);
        if (kind === 'gate') {
          M.box(pw + 1, 2, 0, b - 1, 3, 1, post); M.box(pw + 1, h - 2, 0, b - 1, h - 1, 1, post);   // bottom rail clear of the lawn (its top at 12.5 cm fought it)
          M.box(pw + 1, 2, 0, pw + 2, h - 2, 1, post); M.box(b - 2, 2, 0, b - 1, h - 2, 1, post);
          for (let y = 4; y < h - 2; y += 3) M.box(pw + 2, y, 1, b - 2, y + 1, 2, wire);
        }
      } else if (type === 'wall') {
        const [stone, cap] = mats;
        for (const u of [0, b]) { M.box(u, 0, 0, u + pw, h + 4, T, stone); M.box(u, h + 4, 0, u + pw, h + 5, T, cap); M.box(u + 2, h + 5, 2, u + pw - 2, h + 6, T - 2, cap); }
      }
      return M;
    });
  }
  // lay out a run of n cells with gates [{a, b, kind}] (opening cells); returns [[model, u offset], ...]
  function runPieces(C, type, n, gates, mats, R) {
    const pw = RUN_W[type], P = RUN_P[type], hedge = !pw, out = [];
    let u = 0, sp = true;
    const section = (end, ep) => {
      let L = end - u;
      if (L <= 0) return;
      while (L > 0) {
        let len = L >= 2 * P ? P : L;                         // the last piece takes the remainder (P..2P-1 or less)
        if (len > P && len < 2 * P && L === len) len = L;
        const last = len === L;
        out.push([runSeg(C, type, len, sp, last && ep, mats, hedge ? Math.floor(R() * 3) : 0), u]);
        u += len; L -= len; sp = !hedge;                      // panels after the first start with their own post
      }
    };
    for (const g of gates.slice().sort((p, q) => p.a - q.a)) {
      const a = g.a - pw, b = g.b + pw;
      if (a - u < (hedge ? 4 : pw + 4)) continue;
      if (hedge) { section(g.a, true); u = g.b; sp = true; continue; }
      section(a, false);
      out.push([runGate(C, type, g.b - g.a, g.kind, mats), u]);
      u = b; sp = false;
    }
    section(n, true);
    return out;
  }

  // ------------------------------------------------------------------------------------------ props
  // a car on the driveway: CityCore.Vehicles model (5 cm voxels, +x = nose); place with scale carScale (0.2 building
  // voxels per model voxel, shrunk so it never exceeds the old 4.6 / 4.9 / 5.5 m footprints) and orientation nose ? 1 : 3
  const CAR_OLD_LEN = { sedan: 74, suv: 78, pickup: 88 };            // old model depth (6.25 cm voxels)
  function carModel(C, kind, seed) {
    let k = kind;
    if (kind === 'sedan') k = seed % 5 === 0 ? 'hatchback' : seed % 7 === 0 ? 'coupe' : seed % 4 === 0 ? 'minivan' : 'sedan';
    const r = C.Vehicles.model(k, { seed });
    const sc = 0.2 * Math.min(1, CAR_OLD_LEN[kind] * 0.0625 / r.len, 2.0 / r.wid);
    return { M: r.M, sc, half: (CAR_OLD_LEN[kind] * S4) / 2 };
  }
  function shedModel(C, wall, roof, door) {
    return cached('shed:' + wall + ':' + roof + ':' + door, () => {
      // 12.5 cm voxels: 2.5 x 3 m, gable ridge along v, door on the -v gable end
      const M = VM(22, 30, 26, 11, 13);
      M.box(-9, 0, -11, 9, 16, 11, wall);
      for (let s = 0; s < 9; ++s) {
        M.box(-9 + s, 16 + s, -11, 9 - s, 17 + s, 11, wall);
        M.box(-10 + s, 15 + s, -12, -8 + s, 16 + s, 12, roof); M.box(8 - s, 15 + s, -12, 10 - s, 16 + s, 12, roof);
      }
      M.box(-1, 24, -12, 1, 25, 12, roof);
      M.box(-4, 0, -12, 4, 13, -11, door); M.box(-5, 13, -12, 5, 14, -11, BM.TRIM);
      M.box(0, 1, -12, 1, 12, -11, BM.TRIM);
      M.box(9, 7, -3, 10, 11, 3, BM.GLASS); M.box(9, 6, -4, 10, 7, 4, BM.TRIM);
      M.box(-9, 0, -11, 9, 1, 11, K.CONC);
      return M;
    });
  }
  function swingModel(C, frame, seat) {
    return cached('swing:' + frame + ':' + seat, () => {
      const M = VM(56, 38, 34, 28, 17);
      M.box(-26, 34, -1, 26, 36, 1, frame);
      for (const u of [-25, 23]) for (const s of [-1, 1]) for (let k = 0; k < 4; ++k) {
        const vc = s * (13 - k * 4);
        M.box(u, k * 9, vc - 1, u + 2, Math.min(34, (k + 1) * 9), vc + 1, frame);
      }
      for (const u of [-16, -4, 8]) {
        M.box(u, 7, -1, u + 1, 34, 0, K.STEEL); M.box(u + 5, 7, -1, u + 6, 34, 0, K.STEEL);
        M.box(u - 1, 6, -2, u + 7, 7, 1, u === -4 ? K.RED : seat);
      }
      return M;
    });
  }
  function trampolineModel(C, pad) {
    return cached('tramp:' + pad, () => {
      const r = 14, M = VM(2 * r + 2, 9, 2 * r + 2, r + 1, r + 1);
      disc(M, 0, 0, r, 6, 7, pad); disc(M, 0, 0, r - 2.2, 6, 7, K.BLACK);
      for (const [x, z] of [[-10, -10], [9, -10], [-10, 9], [9, 9]]) M.box(x, 0, z, x + 1, 6, z + 1, K.STEEL);
      return M;
    });
  }
  function poolAboveModel(C, wall) {
    return cached('poolA:' + wall, () => {
      const r = 13, M = VM(2 * r + 4, 11, 2 * r + 6, r + 2, r + 3);
      disc(M, 0, 0, r, 0, 8, wall, r - 1);
      disc(M, 0, 0, r - 1, 0, 7, BM.WATER);
      disc(M, 0, 0, r + 0.6, 8, 9, BM.TRIM, r - 1.4);
      M.box(-2, 0, -r - 3, 2, 10, -r - 2, BM.METAL); M.box(-2, 10, -r - 3, 2, 11, -r + 1, BM.METAL);
      return M;
    });
  }
  function patioSetModel(C, frame, umb) {
    return cached('patio:' + frame + ':' + umb, () => {
      const M = VM(40, 46, 40, 20, 20);
      oct(M, 0, 0, 7, 11, 12, frame); M.box(-1, 0, -1, 1, 11, 1, frame); oct(M, 0, 0, 4, 0, 1, frame);
      for (const [x, z, o] of [[0, -15, 0], [0, 15, 2], [-15, 0, 1], [15, 0, 3]]) {
        const sx = o === 1 || o === 3, bx = o === 1 ? -1 : o === 3 ? 1 : 0, bz = o === 0 ? -1 : o === 2 ? 1 : 0;
        M.box(x - 3, 0, z - 3, x - 2, 7, z + 3, frame); M.box(x + 2, 0, z - 3, x + 3, 7, z + 3, frame);
        if (sx) { M.box(x - 3, 0, z - 3, x + 3, 7, z - 2, frame); M.box(x - 3, 0, z + 2, x + 3, 7, z + 3, frame); }
        M.box(x - 3, 7, z - 3, x + 3, 8, z + 3, frame);
        if (bz) M.box(x - 3, 8, z + bz * 3 - (bz > 0 ? 1 : 0), x + 3, 16, z + bz * 3 + (bz > 0 ? 0 : 1), frame);
        else M.box(x + bx * 3 - (bx > 0 ? 1 : 0), 8, z - 3, x + bx * 3 + (bx > 0 ? 0 : 1), 16, z + 3, frame);
      }
      if (umb) {
        M.box(0, 12, 0, 1, 38, 1, BM.TRIM);
        for (let k = 0; k < 4; ++k) oct(M, 0, 0, 16 - k * 4, 36 + k, 37 + k, k % 2 ? BM.TRIM : umb);
      }
      return M;
    });
  }
  function grillModel(C, gas) {
    return cached('grill:' + gas, () => {
      const M = VM(22, 20, 12, 11, 6);
      if (gas) {
        M.box(-6, 1, -4, 6, 13, 4, BM.STEEL_DARK); M.box(-6, 13, -4, 6, 17, 4, BM.METAL);
        M.box(-10, 12, -3, -6, 13, 3, BM.METAL); M.box(6, 12, -3, 10, 13, 3, BM.METAL);
        M.box(-6, 0, -4, -4, 2, -2, K.BLACK); M.box(4, 0, -4, 6, 2, -2, K.BLACK);
        M.box(-4, 15, -5, 4, 16, -4, BM.TRIM);
      } else {
        for (const [x, z] of [[-3, -3], [2, -3], [0, 2]]) M.box(x, 0, z, x + 1, 9, z + 1, BM.STEEL_DARK);
        oct(M, 0, 0, 4, 9, 13, K.BLACK); oct(M, 0, 0, 3, 13, 15, K.BLACK); M.box(-1, 15, -1, 1, 16, 1, BM.METAL);
      }
      return M;
    });
  }
  function gardenBedModel(C, frame, vr) {
    return cached('gbed:' + frame + ':' + vr, () => {
      const M = VM(12, 6, 22, 6, 11);
      M.box(-5, 0, -10, 5, 3, 10, frame); M.box(-4, 2, -9, 4, 3, 9, K.SOIL);
      const crop = [K.LEAF, K.LEAF_D, K.PARK][vr % 3];
      for (const x of [-3, 1]) for (let z = -8; z < 8; z += 4) { M.box(x, 3, z, x + 2, 4 + ((x + z + vr) & 1), z + 2, crop); if (vr === 1 && z === -4) M.box(x, 4, z, x + 1, 5, z + 1, K.RED); }
      return M;
    });
  }
  function clothesModel(C, vr) {
    return cached('clothes:' + vr, () => {
      const M = VM(80, 32, 16, 40, 8);
      for (const u of [-37, 35]) { M.box(u, 0, -1, u + 2, 30, 1, BM.METAL); M.box(u, 28, -7, u + 2, 30, 7, BM.METAL); }
      for (const v of [-6, -2, 2, 6]) M.box(-35, 29, v, 35, 30, v + 1, BM.TRIM);
      const cols = [K.BLUE, K.PWHITE, K.RED, K.YEL, BM.PAINT_SALMON, K.SGREEN];
      let u = -30 + vr * 3;
      for (let k = 0; k < 4 + (vr % 3); ++k) {
        const w = 5 + ((k * 7 + vr) % 6), h = 6 + ((k * 5 + vr) % 5), v = [-6, 2, -2, 6][k % 4];
        if (u + w > 32) break;
        M.box(u, 29 - h, v, u + w, 29, v + 1, cols[(k + vr) % cols.length]);
        u += w + 3 + ((k + vr) % 4);
      }
      return M;
    });
  }
  function toyModel(C, kind, vr) {
    return cached('toy:' + kind + ':' + vr, () => {
      let M;
      const c = [K.RED, K.BLUE, K.YEL, K.SGREEN][vr % 4];
      if (kind === 'slide') {
        M = VM(12, 18, 30, 6, 15);
        for (const [u, v] of [[-5, -14], [3, -14], [-5, -7], [3, -7]]) M.box(u, 0, v, u + 2, 14, v + 2, K.STEEL);
        M.box(-5, 14, -14, 5, 15, -5, c);
        for (let k = 0; k < 7; ++k) M.box(-3, 13 - k * 2, -5 + k * 2, 3, 15 - k * 2, -3 + k * 2, K.YEL);
        M.box(-3, 0, 9, 3, 2, 13, K.YEL);
        for (let y = 3; y < 14; y += 3) M.box(-5, y, -15, 5, y + 1, -14, K.STEEL);
      } else if (kind === 'sandbox') {
        M = VM(28, 3, 28, 14, 14);
        M.box(-13, 0, -13, 13, 3, 13, K.CEDAR); M.box(-11, 2, -11, 11, 3, 11, K.PALLET);
        M.box(4, 3, 3, 7, 5, 6, c); M.box(-6, 3, -4, -3, 4, -1, K.YEL);
      } else if (kind === 'playhouse') {      // 12.5 cm voxels
        M = VM(16, 20, 16, 8, 8);
        M.box(-6, 0, -6, 6, 10, 6, pick(rng(C, 'ph' + vr), [K.YEL, BM.TRIM, BM.PAINT_CREAM]));
        M.box(-2, 0, -7, 2, 7, -6, c); M.box(4, 4, -7, 6, 7, -6, BM.GLASS);
        for (let s = 0; s < 6; ++s) { M.box(-7 + s, 10 + s, -7, 7 - s, 11 + s, 7, c); }
      } else if (kind === 'wagon') {
        M = VM(12, 8, 24, 6, 12);
        M.box(-4, 2, -7, 4, 6, 7, K.RED); M.box(-3, 3, -6, 3, 6, 6, -1); M.box(-3, 3, -6, 3, 4, 6, K.BLACK);
        for (const v of [-6, 4]) { M.box(-5, 0, v, -4, 3, v + 3, K.BLACK); M.box(4, 0, v, 5, 3, v + 3, K.BLACK); }
        M.box(0, 4, 7, 1, 5, 11, K.BLACK);
      } else {                                // balls and a bike on its side
        M = VM(24, 4, 16, 12, 8);
        M.box(-10, 0, -6, -7, 3, -3, c); M.box(4, 0, 3, 6, 2, 5, K.YEL);
        M.box(-2, 0, -3, 8, 1, -2, K.BLUE); M.box(-3, 0, -5, 0, 1, -1, K.BLACK); M.box(7, 0, -5, 10, 1, -1, K.BLACK);
      }
      return M;
    });
  }
  function firePitModel(C, stone, chair) {
    return cached('fire:' + stone + ':' + chair, () => {
      const M = VM(54, 18, 54, 27, 27);
      disc(M, 0, 0, 7, 0, 4, stone, 4.6); disc(M, 0, 0, 4.6, 0, 1, K.BLACK);
      M.box(-2, 1, -1, 2, 2, 1, K.TRUNK); M.box(-1, 1, -2, 1, 3, 2, K.TRUNK);
      for (const [x, z, bx, bz] of [[0, -19, 0, -1], [17, 9, 1, 1], [-17, 9, -1, 1]]) {
        M.box(x - 4, 0, z - 4, x + 4, 6, z + 4, chair); M.box(x - 3, 3, z - 3, x + 3, 6, z + 3, -1); M.box(x - 3, 3, z - 3, x + 3, 4, z + 3, chair);
        if (bz < 0 && !bx) M.box(x - 4, 6, z - 5, x + 4, 15, z - 3, chair);
        else M.box(x + (bx > 0 ? 3 : -5), 6, z - 4, x + (bx > 0 ? 5 : -3), 15, z + 4, chair);
      }
      return M;
    });
  }
  function mailboxModel(C, kind, post, box) {
    return cached('mail:' + kind + ':' + post + ':' + box, () => {
      const M = VM(10, 22, 12, 5, 6);
      if (kind === 'brick') {
        M.box(-4, 0, -4, 4, 18, 4, post); M.box(-5, 18, -5, 5, 19, 5, BM.LIMESTONE);
        M.box(-2, 12, -5, 2, 16, -4, K.BLACK);
      } else {
        M.box(-1, 0, -1, 2, 14, 2, post); M.box(-2, 13, -1, 3, 14, 4, post);
        M.box(-2, 14, -6, 3, 18, 5, box); M.box(-1, 18, -6, 2, 19, 5, box);
        M.box(3, 16, 1, 4, 20, 2, K.RED);
      }
      return M;
    });
  }
  function binsModel(C, a, b) {
    return cached('bins:' + a + ':' + b, () => {
      const M = VM(24, 18, 14, 12, 7);
      for (const [u, m] of [[-11, a], [1, b]]) { M.box(u, 0, -5, u + 9, 16, 5, m); M.box(u - 0, 16, -6, u + 9, 17, 5, m); M.box(u + 1, 0, 5, u + 3, 3, 6, K.BLACK); M.box(u + 6, 0, 5, u + 8, 3, 6, K.BLACK); }
      return M;
    });
  }
  function acModel(C) {
    return cached('ac', () => {
      const M = VM(16, 15, 16, 8, 8);
      M.box(-7, 0, -7, 7, 1, 7, K.CONC);
      M.box(-6, 1, -6, 6, 12, 6, BM.LOUVER); M.box(-5, 2, -6, 5, 11, 6, BM.METAL); M.box(-6, 2, -5, 6, 11, 5, BM.METAL);
      M.box(-6, 12, -6, 6, 13, 6, BM.METAL); oct(M, 0, 0, 4, 13, 14, K.BLACK);
      return M;
    });
  }
  // dv: half depth (cells) of the fence it straddles; its posts stand clear in front of and behind it
  function arborModel(C, span, mat, dv) {
    return cached('arbor:' + span + ':' + mat + ':' + dv, () => {
      const hs = (span >> 1) + 7, e = dv + 4, M = VM(2 * hs + 8, 40, 2 * e + 4, hs + 4, e + 2);
      for (const u of [-hs - 2, hs]) for (const v of [-e, e - 2]) M.box(u, 0, v, u + 2, 35, v + 2, mat);
      for (const v of [-e, e - 2]) M.box(-hs - 3, 35, v, hs + 3, 37, v + 2, mat);
      for (let u = -hs - 1; u < hs + 1; u += 4) M.box(u, 37, -e - 2, u + 1, 38, e + 2, mat);
      M.box(-hs - 3, 6, -e, -hs - 2, 31, -e + 2, K.LEAF); M.box(-hs - 4, 22, -e, -hs - 3, 24, -e + 2, K.RED); M.box(-hs - 4, 14, -e, -hs - 3, 16, -e + 2, K.RED);
      return M;
    });
  }

  // ------------------------------------------------------------------------------------------ the kit
  function yardKit(E, C, lot, R, opts) {
    opts = opts || {};
    const style = opts.style || 'suburban', nb = opts.neighbours || {};
    const w = Math.floor(lot.w), d = Math.floor(lot.d);
    const S = { E, C, quads: 0, trees: 0, items: [], by: {}, tag: 'misc' };
    if (!(w >= 12 && d >= 12)) return S;
    const Hs = lot.house ? { x0: Math.max(0, lot.house.x0), z0: Math.max(0, lot.house.z0), x1: Math.min(w, lot.house.x1), z1: Math.min(d, lot.house.z1) } : null;
    const H = Hs || { x0: w >> 1, z0: d >> 1, x1: (w >> 1), z1: (d >> 1) };
    const hasHouse = !!Hs && H.x1 > H.x0 && H.z1 > H.z0;
    const commercial = style === 'commercial', town = style === 'townhouse', corner = style === 'corner';
    const dr = lot.drive && lot.drive.x1 - lot.drive.x0 >= 6 ? { x0: clamp(lot.drive.x0, 1, w - 1), x1: clamp(lot.drive.x1, 1, w - 1) } : null;

    // ---- occupancy (1 voxel cells): 0 lawn, 1 blocked, 2 low items only (under a raised tree crown)
    const occ = new Uint8Array(w * d);
    const oget = (x, z) => (x < 0 || z < 0 || x >= w || z >= d) ? 1 : occ[z * w + x];
    const omark = (x0, z0, x1, z1, v) => {
      for (let z = Math.max(0, Math.floor(z0)); z < Math.min(d, Math.ceil(z1)); ++z)
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); ++x) if (v !== 2 || occ[z * w + x] === 0) occ[z * w + x] = v;
    };
    const ofree = (x0, z0, x1, z1, allowLow) => {
      for (let z = Math.floor(z0); z < Math.ceil(z1); ++z) for (let x = Math.floor(x0); x < Math.ceil(x1); ++x) {
        const o = oget(x, z); if (o === 1 || (o === 2 && !allowLow)) return false;
      }
      return true;
    };
    omark(0, 0, w, 1, 1); omark(0, d - 1, w, d, 1); omark(0, 0, 1, d, 1); omark(w - 1, 0, w, d, 1);
    if (hasHouse) omark(H.x0 - 1, H.z0 - 1, H.x1 + 1, H.z1 + 1, 1);

    // ---- ground height map: 2 cells per voxel
    const gw = w * 2, gd = d * 2, W2 = gw + 2;
    const GH = new Int16Array(W2 * (gd + 2)).fill(-1), GM = new Uint8Array(W2 * (gd + 2));
    const gi = (cx, cz) => (cz + 1) * W2 + cx + 1;
    const paint = (x0, z0, x1, z1, h, m, only) => {
      for (let cz = Math.max(0, Math.round(z0 * 2)); cz < Math.min(gd, Math.round(z1 * 2)); ++cz)
        for (let cx = Math.max(0, Math.round(x0 * 2)); cx < Math.min(gw, Math.round(x1 * 2)); ++cx) {
          const i = gi(cx, cz);
          if (only && !only(GH[i], GM[i])) continue;
          GH[i] = h; GM[i] = m;
        }
    };
    const isLawn = (h) => h === LAWN;
    const paintDisc = (x, z, r, h, m, only) => {
      for (let cz = Math.max(0, Math.floor((z - r) * 2)); cz < Math.min(gd, Math.ceil((z + r) * 2)); ++cz)
        for (let cx = Math.max(0, Math.floor((x - r) * 2)); cx < Math.min(gw, Math.ceil((x + r) * 2)); ++cx) {
          const dx = (cx + 0.5) / 2 - x, dz = (cz + 0.5) / 2 - z;
          if (dx * dx + dz * dz > r * r) continue;
          const i = gi(cx, cz);
          if (only && !only(GH[i], GM[i])) continue;
          GH[i] = h; GM[i] = m;
        }
    };
    // lawn tone per lot, mown stripes on some
    const tones = [[K.GRASS, K.MGRASS], [K.PARK, K.MGRASS], [K.LEAF, K.GRASS], [K.MGRASS, K.PARK], [K.GRASS, K.PARK]];
    const tn = pick(R, tones), stripes = !commercial && R() < (town ? 0.2 : 0.4), sw = 3 + Math.floor(R() * 2);
    const backAlong = R() < 0.5;
    for (let cz = 0; cz < gd; ++cz) for (let cx = 0; cx < gw; ++cx) {
      const i = gi(cx, cz);
      GH[i] = LAWN;
      let m = tn[0];
      if (stripes) {
        const back = hasHouse && cz / 2 >= H.z1;
        const k = back && backAlong ? Math.floor(cz / (2 * sw)) : Math.floor(cx / (2 * sw));
        if (k & 1) m = tn[1];
      }
      GM[i] = m;
    }

    // ---- house front: garage part, door, porch zone
    let doorX = (H.x0 + H.x1) / 2, segs = [[H.x0, H.x1]];
    if (dr && hasHouse && dr.x0 < H.x1 && dr.x1 > H.x0) {
      segs = [];
      if (dr.x0 - 1 - H.x0 >= 8) segs.push([H.x0, dr.x0 - 1]);
      if (H.x1 - dr.x1 - 1 >= 8) segs.push([dr.x1 + 1, H.x1]);
      if (!segs.length) segs.push([H.x0, H.x1]);
    }
    const mainSeg = segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    // front doors: lot.doors (several entries, e.g. a townhouse row) or lot.door; else the middle of the main front
    const doors = lot.doors && lot.doors.length ? lot.doors.slice() : lot.door !== undefined ? [lot.door] : null;
    doorX = doors ? doors[0] : (mainSeg[0] + mainSeg[1]) / 2;
    const multi = town && hasHouse && !doors && H.x1 - H.x0 > 40;     // a row of unknown entries: no walks, beds or front fence
    // porch and steps stay inside the house footprint (towers/houses.js); keep the door zone clear anyway
    const ww = town ? 4 : pick(R, [4, 4, 5, 6]);
    const porch = lot.porch ? { x0: lot.porch.x0, x1: lot.porch.x1, z0: lot.porch.z0 } : { x0: doorX - ww / 2 - 2, x1: doorX + ww / 2 + 2, z0: H.z0 };
    if (hasHouse && !commercial) omark(porch.x0 - 1, porch.z0 - 2, porch.x1 + 1, H.z0, 1);
    const FB = hasHouse ? Math.min(4, (H.z1 - H.z0) >> 2) : 0;          // paving runs this far under the front (recessed doors)

    // ---- driveway
    let driveEnd = 0, garageDrive = false;
    if (dr) {
      garageDrive = hasHouse && dr.x0 < H.x1 && dr.x1 > H.x0;
      if (lot.drive.z1 !== undefined) driveEnd = clamp(lot.drive.z1, 2, d - 2);
      else if (garageDrive) driveEnd = H.z0 + FB;
      else driveEnd = hasHouse ? clamp(Math.round(H.z0 + (H.z1 - H.z0) * (lot.garage ? 0.9 : 0.55)), 12, d - 8) : Math.min(d - 8, 40);
      const dm = wpick(R, [[BM.CONCRETE, 40], [K.ASPH, 18], [K.ASPH_D, 14], [BM.WHITE_CONCRETE, 8], [BM.BRICK_BROWN, 6], [K.PLOT, 6], ['strips', 5]]);
      if (dm === 'strips') {
        const cw = dr.x1 - dr.x0, sw2 = Math.max(2, Math.round(cw * 0.28));
        paint(dr.x0, 0, dr.x0 + sw2, driveEnd, DRIVE, BM.CONCRETE); paint(dr.x1 - sw2, 0, dr.x1, driveEnd, DRIVE, BM.CONCRETE);
      } else paint(dr.x0, 0, dr.x1, driveEnd, DRIVE, dm);
      // flared apron at the sidewalk
      const fm = dm === 'strips' ? BM.CONCRETE : dm;
      paint(Math.max(1, dr.x0 - 1.5), 0, Math.min(w - 1, dr.x1 + 1.5), 1.5, DRIVE, fm, isLawn);
      paint(Math.max(1, dr.x0 - 0.5), 1.5, Math.min(w - 1, dr.x1 + 0.5), 2.5, DRIVE, fm, isLawn);
      omark(dr.x0 - 1, 0, dr.x1 + 1, driveEnd + 1, 1);
      omark(dr.x0 - 2, 0, dr.x1 + 2, 3, 1);
      // the drive meets the street at a curb cut (dropped curb, concrete apron across the sidewalk); none where a
      // corner curb return or a crosswalk is too close
      if (L.driveway) L.driveway(E, dr.x0, dr.x1, 'house');
    }

    // ---- front walk
    const walkMat = pick(R, [BM.CONCRETE, BM.CONCRETE, K.PLAZA, BM.BRICK_RED, BM.LIMESTONE_DARK, BM.BUFF]);
    let walkKind = null, walkX0 = doorX - ww / 2, walkX1 = doorX + ww / 2;
    const extraWalks = [];
    if (hasHouse && !commercial && H.z0 >= 4 && !multi) {
      if (doors) for (const x of doors.slice(1)) {
        paint(x - ww / 2, 0, x + ww / 2, H.z0 + FB, WALK, walkMat); omark(x - ww / 2 - 1, 0, x + ww / 2 + 1, H.z0, 1); extraWalks.push([x - ww / 2, x + ww / 2]);
      }
      walkKind = wpick(R, [['straight', 45], ['drive', dr && !town ? 38 : 0], ['stones', town ? 5 : 17]]);
      if (walkKind === 'drive') {
        const zj = Math.max(3, Math.round(porch.z0 - ww - 3 - R() * 4));
        const right = dr.x0 > doorX;
        if (zj + ww + 1 >= H.z0 || (right ? dr.x0 - walkX1 : walkX0 - dr.x1) < 2) walkKind = 'straight';
        else {
          const a = right ? walkX0 : dr.x1, b = right ? dr.x0 : walkX1;
          paint(a, zj, b, zj + ww, WALK, walkMat); paint(walkX0, zj, walkX1, H.z0 + FB, WALK, walkMat);
          omark(a - 1, zj - 1, b + 1, zj + ww + 1, 1); omark(walkX0 - 1, zj - 1, walkX1 + 1, H.z0, 1);
        }
      }
      if (walkKind === 'straight') { paint(walkX0, 0, walkX1, H.z0 + FB, WALK, walkMat); omark(walkX0 - 1, 0, walkX1 + 1, H.z0, 1); }
      if (walkKind === 'stones') {
        const sm = pick(R, [BM.LIMESTONE_DARK, BM.CONCRETE, BM.GRANITE_DARK]);
        const land = Math.max(1, porch.z0 - 3);
        paint(walkX0, land, walkX1, H.z0 + FB, WALK, walkMat);
        for (let z = 1.5, k = 0; z + 2 <= land - 0.5; z += 3, ++k) {
          const jx = ((k * 7) % 3 - 1) * 0.5;
          paint(doorX - 1.5 + jx, z, doorX + 1.5 + jx, z + 2, STONE, sm, isLawn);
        }
        omark(walkX0 - 1, 0, walkX1 + 1, H.z0, 1);
      }
    }

    // ---- boundaries
    S.tag = 'fences';
    const runs = [];
    const fenceMats = (type) => {
      if (type === 'privacy') return pick(R, [[K.CEDAR, BM.WOOD], [BM.WOOD, BM.WOOD], [BM.SIDING_GRAY, BM.SIDING_GRAY], [BM.TRIM, BM.TRIM], [K.CEDAR, K.CEDAR]]);
      if (type === 'picket') { const m = pick(R, [BM.TRIM, K.WHITE, K.WHITE]); return [m, m, R() < 0.35 ? 's' : '']; }
      if (type === 'chain') return [K.STEEL, BM.METAL];
      if (type === 'hedge' || type === 'lowhedge') return pick(R, [[K.LEAF_D, K.LEAF], [K.EVER, K.LEAF_D], [K.LEAF_D, K.GRASS]]);
      return pick(R, [[BM.GRANITE_DARK, BM.LIMESTONE], [BM.BRICK_RED, BM.LIMESTONE], [BM.LIMESTONE_DARK, BM.LIMESTONE], [BM.BUFF, BM.LIMESTONE_DARK], [BM.BRICK_BROWN, BM.CONCRETE]]);
    };
    const matsOf = {};
    const mats = (type) => matsOf[type] || (matsOf[type] = fenceMats(type));
    const tbv = (type) => RUN_T[type] * RUN_S[type];
    // a straight run: line 'x' (along x at z = c, owner's side towards +z if inPos) or 'z'; from s0 to s1 (lot voxels);
    // gates: [{ s0, s1, kind }] in lot coordinates along the run
    const addRun = (type, axis, c, s0, s1, ownerPos, gates) => {
      if (!type || type === 'none') return;
      const sc = RUN_S[type], pc = 1 / sc, T = tbv(type), n = Math.floor((s1 - s0) * pc + 1e-6);
      if (n * sc < 3) return;
      const g = [];
      for (const q of gates || []) {
        const a = Math.max(Math.round(pc), Math.round((q.s0 - s0) * pc)), b = Math.min(n - Math.round(pc), Math.round((q.s1 - s0) * pc));
        if ((b - a) * sc >= 2) g.push({ a, b, kind: q.kind });
      }
      const pieces = runPieces(C, type, n, g, mats(type), R), tag0 = S.tag;
      S.tag = 'fence_' + type;
      // place: the run spans [s0, s0 + n/4] along the axis, [c, c + T] across
      for (const [M, u] of pieces) {
        if (axis === 'x') put(S, M, s0 + u * sc, -J, ownerPos ? c + T : c, sc, ownerPos ? [1, 0, 0, -1] : [1, 0, 0, 1]);
        else put(S, M, ownerPos ? c + T : c, -J, s0 + u * sc, sc, ownerPos ? [0, -1, 1, 0] : [0, 1, 1, 0]);
      }
      const e = s0 + n * sc;
      if (axis === 'x') omark(s0 - 1, c - 1, e + 1, c + T + 1, 1); else omark(c - 1, s0 - 1, c + T + 1, e + 1, 1);
      runs.push({ type, axis, c, s0, s1: e }); S.tag = tag0;
      return e;
    };
    // choose types
    let frontT = 'none', backT, sideT, streetSide = null;
    if (commercial) { backT = wpick(R, [['hedge', 45], ['privacy', 35], ['chain', 20]]); sideT = backT; }
    else {
      backT = wpick(R, [['privacy', town ? 60 : 44], ['chain', town ? 5 : 14], ['hedge', 18], ['none', town ? 5 : 16], ['wall', town ? 15 : 3]]);
      sideT = R() < 0.72 ? backT : wpick(R, [['privacy', 50], ['chain', 20], ['hedge', 20], ['none', 10]]);
      frontT = multi ? 'none' : wpick(R, [['none', town ? 45 : 58], ['picket', 20], ['lowhedge', 11], ['wall', town ? 25 : 9], ['chain', town ? 0 : 2]]);
      if (corner) streetSide = !nb.r ? 'r' : !nb.l ? 'l' : 'r';
    }
    if (backT === 'wall' && !town) backT = 'privacy';
    const zbT = backT === 'none' ? 0 : tbv(backT);
    const zb = d - 1 - zbT - J;                                     // back run front face
    // back line (always): reaches the shared corners so neighbours' back runs meet end to end
    const xb0 = nb.l ? J : 1 + J, xb1 = nb.r ? w - 0.25 + J : w - 1 - J;
    if (backT !== 'none') addRun(backT, 'x', zb, xb0, xb1, false);
    // front line (optional), openings at the drive and the walk
    const zf = 1 + J, fT = frontT !== 'none' ? tbv(frontT) : 0;
    const frontGates = [];
    if (frontT !== 'none') {
      if (dr) frontGates.push({ s0: dr.x0 - 2, s1: dr.x1 + 2, kind: 'open' });
      const gk = frontT === 'picket' || frontT === 'chain' ? 'gate' : 'open';
      if (walkKind === 'straight' || walkKind === 'stones') frontGates.push({ s0: walkX0 - 0.5, s1: walkX1 + 0.5, kind: gk });
      for (const [a, b] of extraWalks) frontGates.push({ s0: a - 0.5, s1: b + 0.5, kind: gk });
      addRun(frontT, 'x', zf, 1 + J, w - 1 - J, true, frontGates);
      if ((frontT === 'lowhedge' || frontT === 'picket') && (walkKind === 'straight' || walkKind === 'stones') && R() < 0.3) {
        const span = Math.round((walkX1 - walkX0 + 1) * 4);
        const Ma = arborModel(C, span, BM.TRIM, Math.ceil(fT * 2) + 1);
        put(S, Ma, doorX + J + 1 / 64, -J, zf + fT / 2 + 1 / 64, S4, 0);
      }
    }
    // side lines: left always, right without a right neighbour
    const sideLine = (side) => {
      const left = side === 'l';
      const isStreet = streetSide === side;
      let tBack = isStreet ? wpick(R, [['hedge', 55], ['picket', 15], ['wall', 20], ['lowhedge', 10]]) : sideT;
      if (commercial) tBack = backT;
      const tFront = frontT === 'picket' ? 'none' : frontT !== 'none' ? frontT : (!commercial && R() < 0.14 ? 'lowhedge' : 'none');
      const T = tBack === 'none' ? (tFront === 'none' ? 0 : tbv(tFront)) : tbv(tBack);
      const c = left ? 1 + J : w - 1 - J - T;                       // run occupies [c, c + T] across
      const zEnd = backT === 'none' ? d - 1 - J : zb;
      // where the back part starts: part way along the house side (wing fence there)
      let zw = hasHouse ? Math.round(H.z0 + (H.z1 - H.z0) * (0.3 + R() * 0.35)) : Math.round(d * 0.4);
      const gap = hasHouse ? (left ? H.x0 - (c + T) : c - H.x1) : 0;      // side yard width at the run
      const driveSide = dr && (left ? dr.x1 <= H.x0 + 1 : dr.x0 >= H.x1 - 1) && !garageDrive;
      if (driveSide) zw = Math.max(zw, driveEnd + 3);
      // runs must not cross the drive or the house
      const crossDrive = dr && dr.x0 - 1 < c + T && dr.x1 + 1 > c;
      const crossHouse = hasHouse && H.x0 - 1 < c + T && H.x1 + 1 > c;
      let z0 = 1 + J + (frontT !== 'none' ? tbv(frontT) : 0);
      if (crossDrive) z0 = Math.max(z0, driveEnd + 1.5);
      let backStart = isStreet ? z0 : zw;
      if (crossHouse) backStart = Math.max(backStart, H.z1 + 1.5);
      if (crossDrive) backStart = Math.max(backStart, driveEnd + 1.5);
      backStart = Math.min(backStart, zEnd - 4);
      // front part
      if (!isStreet && tFront !== 'none' && !crossHouse && backStart - z0 >= 4) addRun(tFront, 'z', left ? 1 + J : w - 1 - J - tbv(tFront), z0, backStart, left);
      // back part (abuts the back run)
      let s = backStart;
      if (tBack !== 'none') { const pc = 1 / RUN_S[tBack], n = Math.floor((zEnd - s) * pc + 1e-6); s = zEnd - n / pc; addRun(tBack, 'z', c, s, zEnd, left); }
      else if (tFront === 'none') paint(left ? 0 : w - 0.5, 0, left ? 0.5 : w, d, EDGE, K.SOIL, isLawn);
      // wing fence from the side run to the house, with a gate
      if (!commercial && !isStreet && hasHouse && ['privacy', 'picket', 'chain'].includes(tBack) && !crossHouse && gap >= 3 &&
          s >= H.z0 + 2 && s <= H.z1 - 4) {
        // from the side run's inner face into the house wall (the end stays hidden inside the wall)
        const sc = RUN_S[tBack], n = Math.floor((gap + 0.3) / sc);
        const a = left ? c + T : c - n * sc, b = a + n * sc;
        const gh = driveSide && gap >= 14 ? 5 : gap >= 8 ? 2 : 1.6, gm = left ? (a + H.x0) / 2 : (H.x1 + b) / 2;
        const gates = gap >= 5.5 ? [{ s0: gm - gh, s1: gm + gh, kind: 'gate' }] : [];
        addRun(tBack, 'x', s, a, b + 1e-6, true, gates);
        if (gates.length && R() < 0.3) {                                // stepping stones through the gate
          const gx = gm, sm = pick(R, [BM.LIMESTONE_DARK, BM.CONCRETE]);
          for (const dz of [-4, 3.5, 7]) paint(gx - 1, s + dz, gx + 1, s + dz + 1.5, STONE, sm, isLawn);
        }
      }
    };
    sideLine('l'); if (!nb.r) sideLine('r');
    if (backT === 'none' && !commercial) paint(0, d - 0.5, w, d, EDGE, K.SOIL, isLawn);

    // ---- house-front beds and foundation planting
    const mulch = pick(R, [K.SOIL, K.SOIL, K.TRUNK, BM.BRICK_DARK, K.PALLET]);
    const isBed = (h) => h === BED;
    const plants = [], pRects = [], tall = [];                     // plants: [model, x, z, sc, mirror]; tall: rects of items > 2 m
    const addPlant = (M, x, z, sc) => {
      const mir = (Math.round(x * 7) & 1) === 1, f = foot(M, x, z, sc, 0, mir);
      if (pRects.some(q => q[0] < f[2] + 0.25 && q[2] > f[0] - 0.25 && q[1] < f[3] + 0.25 && q[3] > f[1] - 0.25)) return false;
      if (hasHouse && f[0] < H.x1 + 0.25 && f[2] > H.x0 - 0.25 && f[1] < H.z1 + 0.25 && f[3] > H.z0 - 0.25) return false;
      if (f[0] < 1 || f[1] < 1 || f[2] > w - 1 || f[3] > d - 1) return false;
      pRects.push(f); plants.push([M, x, z, sc, mir]); return true;
    };
    const shrubKinds = pick(R, [['round', 'block'], ['round', 'hydrangea'], ['block', 'block'], ['round', 'juniper'], ['hydrangea', 'round', 'block']]);
    const flowerV = Math.floor(R() * 6);
    const bedRow = (x0, x1, z0, z1, wavy) => {
      if (x1 - x0 < 4 || z1 - z0 < 3) return;
      if (!ofree(x0, z0, x1, z1 - 1, true)) return;
      const ph = R() * 6;
      for (let cx = Math.round(x0 * 2); cx < Math.round(x1 * 2); ++cx) {
        const zz0 = wavy ? z0 + Math.round((1 + Math.sin(cx * 0.21 + ph)) * 1.2 * 2) / 2 : z0;
        paint(cx / 2, zz0, cx / 2 + 0.5, z1, BED, mulch, isLawn);
      }
      omark(x0, z0, x1, z1, 1);
      // shrubs along the back of the bed, flowers in front
      const L0 = x1 - x0, nS = Math.max(1, Math.floor(L0 / 6));
      for (let k = 0; k < nS; ++k) {
        const x = x0 + (k + 0.5) * L0 / nS, kind = shrubKinds[k % shrubKinds.length];
        const M = bushModel(C, kind, (k + flowerV) % 3);
        const ext = Math.max(M.w, M.d) * S2 / 2;
        if (!(z1 - z0 >= 2 * ext + 0.5 && x - ext >= x0 && x + ext <= x1 && addPlant(M, x, z1 - ext - 0.5, S2)) && z1 - z0 >= 2.6)
          addPlant(bushModel(C, 'flowers', (flowerV + k) % 6), x, (z0 + z1) / 2, S4);
      }
      if (z1 - z0 >= 4) for (let x = x0 + 1.5; x + 1.2 < x1; x += 2.6) addPlant(bushModel(C, 'flowers', (flowerV + Math.round(x)) % 6), x, z0 + 1.4, S4);
    };
    if (hasHouse && !commercial && !multi) {
      const bd = (town ? 3.5 : 4.5) + Math.floor(R() * 3), wavy = !town && R() < 0.45;
      // the house front minus the door zone(s)
      let fronts = segs.map(([a, b]) => [a + 0.5, b - 0.5]);
      for (const [c0, c1] of [[porch.x0 - 1, porch.x1 + 1]].concat(extraWalks.map(([a, b]) => [a - 3, b + 3]))) {
        const nf = [];
        for (const [a, b] of fronts) { if (c1 <= a || c0 >= b) nf.push([a, b]); else { if (c0 - a >= 4) nf.push([a, c0]); if (b - c1 >= 4) nf.push([c1, b]); } }
        fronts = nf;
      }
      let nb0 = 0;
      for (const [a, b] of fronts) if (R() < 0.85 && b - a >= 4) { bedRow(a, b, H.z0 - bd, H.z0, wavy); ++nb0; }
      // beds along the porch front, either side of the walk
      if (porch.z0 > 6 && walkKind && R() < (nb0 ? 0.4 : 0.8)) {
        const pd = 3.5 + Math.floor(R() * 2);
        bedRow(porch.x0 + 0.5, walkX0 - 1, porch.z0 - 1 - pd, porch.z0 - 1, wavy);
        bedRow(walkX1 + 1, porch.x1 - 0.5, porch.z0 - 1 - pd, porch.z0 - 1, wavy);
      }
      // arborvitae at the house corners
      if (!town && R() < 0.35) for (const x of [H.x0 - 2.5, H.x1 + 2.5]) {
        const M = bushModel(C, 'arbor', 0);
        if (ofree(x - 2.5, H.z0 + 1, x + 2.5, H.z0 + 5) && addPlant(M, x, H.z0 + 3, S2)) { omark(x - 2.5, H.z0 + 1, x + 2.5, H.z0 + 5, 1); tall.push(foot(M, x, H.z0 + 3, S2, 0)); }
      }
    }

    S.tag = 'items';
    // ---- patio or deck behind the house, with furniture
    let patio = null;
    if (hasHouse && !commercial && d - H.z1 >= 14) {
      if (R() < (town ? 0.75 : 0.62)) {
        const deck = R() < 0.22, pm = deck ? BM.WOOD : pick(R, [BM.CONCRETE, K.PLAZA, BM.BRICK_RED, BM.LIMESTONE_DARK, BM.BUFF]);
        const pwid = Math.min(H.x1 - H.x0 - 2, 14 + Math.floor(R() * 14)), pdep = Math.min(d - H.z1 - 8, 9 + Math.floor(R() * 7));
        const px0 = Math.round(H.x0 + 1 + R() * (H.x1 - H.x0 - 2 - pwid));
        if (pwid >= 10 && pdep >= 8 && ofree(px0, H.z1 + 1, px0 + pwid, H.z1 + pdep, true)) {
          paint(px0, H.z1, px0 + pwid, H.z1 + pdep, deck ? DECK : PATIO, pm);
          omark(px0 - 1, H.z1, px0 + pwid + 1, H.z1 + pdep + 1, 1);
          patio = { x0: px0, z0: H.z1, x1: px0 + pwid, z1: H.z1 + pdep, y: (deck ? DECK : PATIO) * HU };
          // furniture on the patio
          const umb = R() < 0.55 ? pick(R, [K.RED, BM.AWNING_GREEN, K.BLUE, BM.AWNING_RED]) : 0;
          const Mp = patioSetModel(C, pick(R, [BM.STEEL_DARK, K.CEDAR, BM.TRIM, BM.METAL]), umb);
          const pf = foot(Mp, 0, 0, S4, 0);
          if (pwid >= pf[2] - pf[0] + 2 && pdep >= pf[3] - pf[1] + 3) {
            const cx = px0 + pwid * (R() < 0.5 ? 0.35 : 0.65), cz = H.z1 + pdep * 0.55;
            const px = clamp(cx, px0 + 1 - pf[0], px0 + pwid - 1 - pf[2]), pz = clamp(cz, H.z1 + 2 - pf[1], H.z1 + pdep - 1 - pf[3]);
            put(S, Mp, px + J, patio.y - J, pz + J, S4, 0); S.items.push('patio set'); if (umb) tall.push(foot(Mp, px, pz, S4, 0));
            if (R() < 0.6) {
              const Mg = grillModel(C, R() < 0.5), gx = px < px0 + pwid / 2 ? px0 + pwid - 2.5 : px0 + 2.5;
              const gf = foot(Mg, gx, pz, S4, 1);
              if (gf[0] > px0 + 0.5 && gf[2] < px0 + pwid - 0.5 && (gf[2] < px + pf[0] - 1 || gf[0] > px + pf[2] + 1)) { put(S, Mg, gx + J, patio.y - J, pz + J, S4, 1); S.items.push('grill'); }
            }
          }
        }
      }
    }
    S.tag = 'trees';
    // ---- trees: front (ornamental bias), back (shade trees); crowns inside the lot, off the house and each other
    const trees = [];
    const crownOK = (x, z, rc) => {
      if (x - rc < 1 || z - rc < 1 || x + rc > w - 1 || z + rc > d - 1) return false;
      if (hasHouse && x + rc > H.x0 - 1 && x - rc < H.x1 + 1 && z + rc > H.z0 - 1 && z - rc < H.z1 + 1) return false;
      for (const t of trees) if (Math.hypot(t.x - x, t.z - z) < t.rc + rc + 0.5) return false;
      return true;
    };
    // full-size first, then the young / small form of the species
    const plantTree = (sp, x0, z0, x1, z1, bias) =>
      tryTree(treeModel(C, sp, Math.floor(R() * 3), false), x0, z0, x1, z1, bias) || tryTree(treeModel(C, sp, Math.floor(R() * 3), true), x0, z0, x1, z1, bias);
    const tryTree = (T, x0, z0, x1, z1, bias) => {
      for (let t = 0; t < 40; ++t) {
        let u = R(), v = R();
        if (bias) v = 1 - v * v;
        const x = Math.round(x0 + u * (x1 - x0)) + 0.5, z = Math.round(z0 + v * (z1 - z0)) + 0.5;
        if (!crownOK(x, z, T.rc)) continue;
        if (!ofree(x - 1.5, z - 1.5, x + 1.5, z + 1.5, false)) continue;
        if (T.low && !ofree(x - T.rc, z - T.rc, x + T.rc, z + T.rc, true)) continue;
        if (tall.some(q => q[0] < x + T.rc && q[2] > x - T.rc && q[1] < z + T.rc && q[3] > z - T.rc)) continue;
        const k = Math.floor(R() * 4), mir = R() < 0.5;
        put(S, T.M, x + J, -0.5 + J, z + J, S1, k, mir);
        trees.push({ x, z, rc: T.rc });
        omark(x - 1.5, z - 1.5, x + 1.5, z + 1.5, 1);
        omark(x - T.rc, z - T.rc, x + T.rc, z + T.rc, T.low ? 1 : 2);
        if (R() < 0.55) paintDisc(x, z, T.sp === 'oak' ? 3 : 2.2, BED, mulch, isLawn);
        S.trees++;
        return true;
      }
      return false;
    };
    const backZ0 = hasHouse ? H.z1 + 1 : d * 0.5;
    if (commercial) {
      // screening along the back: a row of conifers if the strip allows
      for (let k = 0; k < 4; ++k) plantTree(R() < 0.7 ? 'conifer' : 'maple', 2, backZ0, w - 2, d - 2, true);
    } else {
      let nBack = town ? (R() < 0.55 ? 1 : 0) : 1 + (R() < 0.5 ? 1 : 0) + (R() < 0.12 ? 1 : 0);
      const pFront = town ? 0.25 : corner ? 0.75 : 0.55;
      let placed = 0;
      if (hasHouse && H.z0 >= 14 && R() < pFront) {
        const sp = wpick(R, [['maple', 32], ['cherry', 22], ['dogwood', 12], ['birch', 18], ['redmaple', 6], ['oak', H.z0 > 30 ? 10 : 0]]);
        if (plantTree(sp, 2, 2, w - 2, H.z0 + 6, false)) placed++;
      }
      if (corner && streetSide) {
        const xs = streetSide === 'r' ? [w * 0.6, w - 2] : [2, w * 0.4];
        if (plantTree(pick(R, ['maple', 'oak', 'maple']), xs[0], H.z0, xs[1], d - 2, false)) placed++;
      }
      nBack = Math.max(nBack, placed ? 0 : 1);
      for (let k = 0; k < nBack && placed < 3; ++k) {
        const sp = wpick(R, [['oak', 30], ['maple', 28], ['conifer', 20], ['birch', 12], ['redmaple', 4], ['cherry', 6]]);
        if (plantTree(sp, 2, backZ0, w - 2, d - 2, true) || plantTree(pick(R, ['birch', 'conifer', 'dogwood']), 2, backZ0, w - 2, d - 2, true)) placed++;
      }
      // shallow lots: at least one tree, in the front yard or beside the house
      if (!placed) for (const sp of ['dogwood', 'birch', 'cherry', 'conifer']) if (plantTree(sp, 2, 2, w - 2, d - 2, false)) { placed++; break; }
      if (placed < 2 && !town && hasHouse && R() < 0.5) plantTree(pick(R, ['maple', 'cherry', 'birch', 'conifer']), 2, 2, w - 2, d - 2, false);
    }

    // ---- backyard items, sparse
    S.tag = 'items';
    const item = (M, sc, x0, z0, x1, z1, isTall, opt) => {
      // find a spot in [x0, x1) x [z0, z1); returns the placement or null
      opt = opt || {};
      for (let t = 0; t < (opt.tries || 30); ++t) {
        const k = opt.k !== undefined ? opt.k : Math.floor(R() * 4);
        const f0 = foot(M, 0, 0, sc, k);
        const fw = f0[2] - f0[0], fd = f0[3] - f0[1];
        if (x1 - x0 < fw + 2 || z1 - z0 < fd + 2) return null;
        const fx = Math.floor(x0 + 1 + R() * (x1 - x0 - fw - 2)), fz = Math.floor(z0 + 1 + R() * (z1 - z0 - fd - 2));
        if (!ofree(fx - 1, fz - 1, fx + fw + 1, fz + fd + 1, !isTall)) continue;
        const x = fx - f0[0] + J, z = fz - f0[1] + J;
        // raised 1/8 voxel (3 cm, keeps the k / 16 + 1 / 32 lattice): at -J a face 12.5 cm up (toys, low boxes) sat
        // 4.7 mm over the lawn (11.25 cm) and fought it in the depth buffer (dev/groundfight.js --self)
        put(S, M, x, -J + 0.125, z, sc, k);
        omark(fx - 1, fz - 1, fx + fw + 1, fz + fd + 1, 1);
        S.items.push(opt.name || '?');
        return { fx, fz, fw, fd };
      }
      return null;
    };
    const bx0 = 1, bx1 = w - 1, bz0 = Math.ceil(backZ0) + 1, bz1 = d - 1;
    if (!commercial && hasHouse && d - H.z1 >= 18) {
      const big = (bx1 - bx0) * (bz1 - bz0);
      const budget = town ? 1 : big > 900 ? 3 : 2;
      const deck = [];
      if (!patio && R() < 0.4) deck.push('grill');
      if (R() < 0.33) deck.push('shed');
      if (!town && R() < 0.24) deck.push('swing');
      if (!town && R() < 0.14) deck.push('trampoline');
      if (!town && big > 700 && R() < 0.06) deck.push('poolA');
      if (!town && big > 1100 && R() < 0.05) deck.push('poolG');
      if (R() < 0.28) deck.push('garden');
      if (!town && R() < 0.15) deck.push('clothes');
      if (!town && R() < 0.25) deck.push('toys');
      if (!town && R() < 0.12) deck.push('fire');
      for (let i = deck.length - 1; i > 0; --i) { const j = Math.floor(R() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      let n = 0;
      for (const it of deck) {
        if (n >= budget) break;
        let r = null;
        if (it === 'grill') r = item(grillModel(C, R() < 0.5), S4, bx0, bz0, bx1, Math.min(bz1, bz0 + 12), false, { name: 'grill' });
        else if (it === 'shed') {
          const Ms = shedModel(C, pick(R, [BM.SIDING_SAGE, BM.WOOD, BM.SIDING_GRAY, BM.PAINT_CREAM, BM.BRICK_RED, BM.SIDING_WHITE]), pick(R, [BM.SHINGLE_GRAY, BM.SHINGLE_BROWN, BM.SHINGLE_SLATE]), pick(R, [BM.TRIM, BM.DOOR_RED, BM.WOOD, BM.SHUTTER_GREEN]));
          // back corners, door towards the house
          const left = R() < 0.5;
          r = item(Ms, S2, left ? bx0 : bx1 - 16, bz1 - 16, left ? bx0 + 16 : bx1, bz1, true, { k: 2, name: 'shed', tries: 12 }) ||
              item(Ms, S2, bx0, bz0 + 4, bx1, bz1, true, { k: 2, name: 'shed' });
        } else if (it === 'swing') {
          r = item(swingModel(C, pick(R, [K.CEDAR, BM.WOOD, K.SGREEN]), pick(R, [K.YEL, K.BLUE, K.SGREEN])), S4, bx0, bz0 + 2, bx1, bz1, true, { name: 'swing set', k: R() < 0.5 ? 0 : 1 });
          if (r) paint(r.fx + 1, r.fz + 1, r.fx + r.fw - 1, r.fz + r.fd - 1, LAWN, K.YARD, (h, m) => h === LAWN);
        } else if (it === 'trampoline') r = item(trampolineModel(C, pick(R, [K.BLUE, K.SGREEN, K.RED])), S2, bx0, bz0 + 2, bx1, bz1, false, { name: 'trampoline' });
        else if (it === 'poolA') r = item(poolAboveModel(C, pick(R, [K.BLUE, BM.TRIM, BM.METAL])), S2, bx0, bz0 + 2, bx1, bz1, false, { name: 'above-ground pool' });
        else if (it === 'poolG') {
          const pw2 = 14 + Math.floor(R() * 6), pl = 26 + Math.floor(R() * 8), cop = pick(R, [BM.LIMESTONE, BM.WHITE_CONCRETE, BM.CONCRETE]);
          for (let t = 0; t < 20 && !r; ++t) {
            const x = Math.floor(bx0 + 2 + R() * (bx1 - bx0 - pw2 - 4)), z = Math.floor(bz0 + 3 + R() * (bz1 - bz0 - pl - 5));
            if (!ofree(x - 2, z - 2, x + pw2 + 2, z + pl + 2, true)) continue;
            paint(x - 1.5, z - 1.5, x + pw2 + 1.5, z + pl + 1.5, PATIO, BM.CONCRETE);
            paint(x, z, x + pw2, z + pl, COPING, cop);
            paint(x + 1, z + 1, x + pw2 - 1, z + pl - 1, WATER, BM.WATER);
            omark(x - 2, z - 2, x + pw2 + 2, z + pl + 2, 1);
            r = { fx: x, fz: z, fw: pw2, fd: pl }; S.items.push('in-ground pool');
          }
        } else if (it === 'garden') {
          const fr = pick(R, [K.CEDAR, BM.WOOD, BM.SIDING_GRAY]);
          r = item(gardenBedModel(C, fr, Math.floor(R() * 3)), S2, bx0, bz0 + 3, bx1, bz1, false, { name: 'garden bed', k: R() < 0.5 ? 0 : 1 });
          if (r) item(gardenBedModel(C, fr, Math.floor(R() * 3)), S2, r.fx - 8, r.fz - 2, r.fx + r.fw + 8, r.fz + r.fd + 2, false, { name: 'garden bed', k: r.fw > r.fd ? 1 : 0, tries: 10 });
        } else if (it === 'clothes') r = item(clothesModel(C, Math.floor(R() * 5)), S4, bx0, bz0 + 2, bx1, bz1, true, { name: 'clothesline', k: R() < 0.6 ? 0 : 1 });
        else if (it === 'toys') {
          const kind = pick(R, ['slide', 'sandbox', 'playhouse', 'wagon', 'balls']);
          r = item(toyModel(C, kind, Math.floor(R() * 4)), kind === 'playhouse' ? S2 : S4, bx0, bz0, bx1, bz1, kind === 'playhouse' || kind === 'slide', { name: kind });
          if (r && R() < 0.5) item(toyModel(C, 'balls', Math.floor(R() * 4)), S4, bx0, bz0, bx1, bz1, false, { name: 'balls' });
        } else if (it === 'fire') r = item(firePitModel(C, pick(R, [BM.GRANITE_DARK, BM.LIMESTONE_DARK, BM.BRICK_RED]), pick(R, [BM.TRIM, K.CEDAR, BM.SHUTTER_GREEN, K.RED])), S4, bx0, bz0 + 3, bx1, bz1, false, { name: 'fire pit' });
        if (r) n++;
      }
      // rarely a worn patch by the back gate / under play
      if (R() < 0.12) { const x = 4 + R() * (w - 8), z = bz0 + R() * (bz1 - bz0); paintDisc(x, z, 1.5 + R() * 1.5, LAWN, K.YARD, (h, m) => h === LAWN); }
    }
    // ---- side yards and the curb end: AC unit, bins, mailbox, parked car
    if (hasHouse && !commercial) {
      if (R() < 0.5) {
        const left = R() < 0.5, x0 = left ? H.x0 - 7 : H.x1, Ma = acModel(C);
        item(Ma, S4, x0, H.z0 + 2, x0 + 7, H.z1 - 1, false, { name: 'AC unit', k: 0, tries: 8 });
      }
      if (dr && R() < 0.45) {
        const Mb = binsModel(C, pick(R, [K.BIN_G, K.BLACK, BM.STEEL_DARK]), pick(R, [K.BIN_B, K.BIN_B, K.BIN_G]));
        const right = dr.x0 > doorX, x0 = right ? dr.x1 + 1 : dr.x0 - 8;
        item(Mb, S4, x0, Math.max(2, driveEnd - 10), x0 + 7, driveEnd + 4, false, { name: 'bins', k: right ? 3 : 1, tries: 10 });
      }
      if (!town && R() < 0.55) {
        const brick = R() < 0.2, Mm = mailboxModel(C, brick ? 'brick' : 'post', brick ? BM.BRICK_RED : pick(R, [BM.WOOD, BM.TRIM, K.BLACK]), pick(R, [K.BLACK, BM.METAL, BM.TRIM, BM.SHUTTER_GREEN]));
        const xs = dr ? (dr.x0 > doorX ? [dr.x1 + 2.5, dr.x0 - 3.5] : [dr.x0 - 3.5, dr.x1 + 2.5]) : [walkX1 + 2.5, walkX0 - 3.5];
        for (const x of xs) {
          const z = (fT ? Math.ceil(2 + J + fT) + 0.5 : 1.5) + 1.5, f = foot(Mm, x, z, S4, 0);
          if (f[0] < 1.2 || f[2] > w - 1.2 || !ofree(f[0] - 0.5, f[1] - 0.5, f[2] + 0.5, f[3] + 0.5, false)) continue;
          put(S, Mm, x + J, -J, z + J, S4, 0); omark(f[0] - 1, f[1] - 1, f[2] + 1, f[3] + 1, 1); S.items.push('mailbox');
          break;
        }
      }
    }
    S.tag = 'items';
    if (dr && !commercial && driveEnd >= 24 && dr.x1 - dr.x0 >= 10 && R() < 0.45) {
      const Mc = carModel(C, wpick(R, [['sedan', 50], ['suv', 35], ['pickup', 15]]), Math.floor(R() * 99991)), half = Mc.half;
      const nose = R() < 0.75;
      const zmin = half + 2 + fT, cz = clamp(driveEnd - half - 1.5 - R() * 3, zmin, driveEnd - half - 1), cx = (dr.x0 + dr.x1) / 2;
      if (driveEnd - half - 1 >= zmin) { put(S, Mc.M, cx + J, DRIVE * HU - J, cz + J, Mc.sc, nose ? 1 : 3); S.items.push('car'); }
    }

    // ---- plants, then the ground (house footprint cut out)
    S.tag = 'plants';
    for (const [M, x, z, sc, mir] of plants) put(S, M, x + J, -J, z + J, sc, 0, mir);
    if (hasHouse) for (let cz = Math.round(H.z0 * 2); cz < Math.round(H.z1 * 2); ++cz) for (let cx = Math.round(H.x0 * 2); cx < Math.round(H.x1 * 2); ++cx) {
      const i = gi(cx, cz);
      if (cz < Math.round((H.z0 + FB) * 2) && (GH[i] === DRIVE || GH[i] === WALK) && !commercial) continue;
      GH[i] = -1;
    }
    const t = new C.MeshBuffer();
    const lawnSet = new Set([K.GRASS, K.PARK, K.MGRASS, K.LEAF, K.YARD]);
    C.meshColumns(GH, GM, gw, gd, 0, 0, (m) => (lawnSet.has(m) ? K.SOIL : m), t);
    for (let q = 0; q < t.quads; ++q) {
      const o = q * 12, P = t.pos, n = t.nrm[q * 4];
      const c = (i) => [P[o + i * 3] / 2, P[o + i * 3 + 1] * HU, P[o + i * 3 + 2] / 2];
      E.quad(c(0), c(1), c(2), c(3), t.mat[q * 4], NV[n]);
      S.quads++; S.by.ground = (S.by.ground || 0) + 1;
    }
    return S;
  }
  L.yardKit = yardKit;
  L.yardModels = { treeModel, bushModel, runPieces, carModel };
})();
