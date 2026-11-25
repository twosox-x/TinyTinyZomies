// Roof kit: dresses a flat roof with believable utility equipment, arranged the way a building engineer would.
//
// CityArch.lib.roofKit(E, C, x0, z0, x1, z1, y, R, opts)
//   roof area [x0,x1) x [z0,z1) in building-local voxels (0.25 m) at height y (the deck surface);
//   opts { style: 'historic' | 'office' | 'residential' | 'industrial', floors, avoid: [[x0,z0,x1,z1], ...] }
// CityArch.lib.waterTankImpl(E, cx, cz, y, C [, o]) - NYC water tanks in several designs, picked by a hash of
//   (cx, cz, y) unless o.design is given (o.maxS caps the footprint, 13 by default); centred on (cx, cz);
//   returns the footprint {w, d, h}.
//
// Layout logic (z = 0 is the street front, z1 the back of the lot):
//   1. the core: a stair bulkhead / elevator machine room at the back (or mid-depth on deep roofs), or a
//      roof hatch on small residential roofs;
//   2. the water tank on the bulkhead roof or on steel dunnage beside it (mainly historic / residential);
//   3. a mechanical yard: packaged units on rails in a row, ducts running from them into the core or down
//      through the deck, cooling towers on big office / industrial roofs, condenser rows on apartments;
//   4. the street side: billboards facing the street, solar rows, roof gardens, skylights, greenhouses;
//   5. antennas, dishes, chimneys on the side walls, and small vents / exhaust fans spread over what's left.
// Every part is one cached VoxModel per variant (meshed once), items keep a gap of >= 2 voxels between them
// and 1 m from the roof edge (chimneys and billboards may sit closer to the parapet).
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, H2 = L.H2;
  const CACHE = new Map();
  const cached = (key, make) => { let M = CACHE.get(key); if (!M) { M = make(); CACHE.set(key, M); } return M; };
  const pick = (R, a) => a[Math.floor(R() * a.length) % a.length];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------------------------------ oriented models
  // A model authored in a local frame: u along its length [0,lw), v across [0,ld), front side at v = 0.
  // rot: 0 front faces -z (the street), 1 faces +x, 2 faces +z, 3 faces -x. Model origin = footprint corner.
  function OM(lw, h, ld, rot) {
    rot = rot & 3;
    const sw = rot & 1, M = new (L.VoxModel())(sw ? ld : lw, h, sw ? lw : ld, 0, 0);
    M.b = function (u0, y0, v0, u1, y1, v1, m) {
      if (rot === 0) this.box(u0, y0, v0, u1, y1, v1, m);
      else if (rot === 2) this.box(lw - u1, y0, ld - v1, lw - u0, y1, ld - v0, m);
      else if (rot === 1) this.box(ld - v1, y0, u0, ld - v0, y1, u1, m);
      else this.box(v0, y0, lw - u1, v1, y1, lw - u0, m);
      return this;
    };
    return M;
  }
  // filled disc / cylinder, centre (cu, cv) in cell units (integers = cell corners), one box per row
  function disc(M, cu, cv, r, y0, y1, m) {
    for (let u = Math.floor(cu - r); u < Math.ceil(cu + r); ++u) {
      const du = u + 0.5 - cu, h2 = r * r - du * du;
      if (h2 <= 0) continue;
      const hv = Math.sqrt(h2), v0 = Math.round(cv - hv), v1 = Math.round(cv + hv);
      if (v1 > v0) M.b(u, y0, v0, u + 1, y1, v1, m);
    }
  }
  // small tree into model M (trunk at cell (u, v), standing on y)
  function tree(M, u, v, y, s, leaf) {
    const th = Math.round(5 * s), cr = Math.max(2, Math.round(2.6 * s));
    M.b(u, y, v, u + 1, y + th, v + 1, BM.TRUNK);
    M.b(u - cr, y + th - 1, v - cr + 1, u + cr + 1, y + th + cr, v + cr, leaf);
    M.b(u - cr + 1, y + th - 2, v - cr, u + cr, y + th + cr + 1, v + cr + 1, leaf);
    M.b(u - cr + 2, y + th + cr + 1, v - cr + 2, u + cr - 1, y + th + cr + 2, v + cr - 1, leaf === BM.LEAF ? BM.LEAF_DARK : BM.LEAF);
  }

  // ------------------------------------------------------------------------------------------ water tanks
  // p: { kind: 'wood'|'twin'|'steel'|'sphere', r, bh, lid: 'cone'|'flat', base: 'legs'|'brick'|'low', legH, wood, hoop, lidMat, brick, rot }
  function tankModel(p) {
    const key = 'tank:' + JSON.stringify(p);
    return cached(key, () => {
      const r = p.r, S = 2 * r + 2, c = r + 1, twin = p.kind === 'twin';
      const W = (twin ? 2 * S : S) + 2;                     // +1 gap +1 ladder column
      const legH = p.legH, top = legH + p.bh + r + 6;
      const M = OM(W, top, S, p.rot || 0);
      const cs = twin ? [c, S + c] : [c];
      const steel = BM.STEEL_DARK;
      // ---- support
      for (const cu of cs) {
        if (p.base === 'legs' || p.base === 'low') {
          const pu = [cu - r + 1, cu + r - 2], pv = [c - r + 1, c + r - 2];
          for (const u of pu) for (const v of pv) M.b(u, 0, v, u + 1, legH, v + 1, steel);
          if (legH >= 6) {                                   // girts between the legs
            const gy = legH >> 1;
            M.b(pu[0], gy, pv[0], pu[1] + 1, gy + 1, pv[0] + 1, steel); M.b(pu[0], gy, pv[1], pu[1] + 1, gy + 1, pv[1] + 1, steel);
            M.b(pu[0], gy, pv[0], pu[0] + 1, gy + 1, pv[1] + 1, steel); M.b(pu[1], gy, pv[0], pu[1] + 1, gy + 1, pv[1] + 1, steel);
          }
          // dunnage beams under the tank
          M.b(cu - r, legH - 1, c - 2, cu + r, legH, c - 1, steel); M.b(cu - r, legH - 1, c + 1, cu + r, legH, c + 2, steel);
          M.b(pu[0], legH - 1, c - r + 1, pu[0] + 1, legH, c + r - 1, steel); M.b(pu[1], legH - 1, c - r + 1, pu[1] + 1, legH, c + r - 1, steel);
        } else {                                             // two brick piers carrying steel beams
          M.b(cu - r + 1, 0, c - r + 2, cu + r - 1, legH - 1, c - r + 4, p.brick);
          M.b(cu - r + 1, 0, c + r - 4, cu + r - 1, legH - 1, c + r - 2, p.brick);
          M.b(cu - r + 1, legH - 2, c - r + 2, cu + r - 1, legH - 1, c - r + 4, BM.LIMESTONE_DARK);
          M.b(cu - r + 1, legH - 2, c + r - 4, cu + r - 1, legH - 1, c + r - 2, BM.LIMESTONE_DARK);
          for (const u of [cu - 3, cu + 2]) M.b(u, legH - 1, c - r + 1, u + 1, legH, c + r - 1, steel);
        }
        // ---- vessel
        const y0 = legH, y1 = legH + p.bh;
        if (p.kind === 'sphere') {
          const yc = y0 + r;
          for (let yy = y0; yy < y0 + 2 * r; ++yy) { const dy = yy + 0.5 - yc, rr = Math.sqrt(Math.max(0, r * r - dy * dy)); if (rr > 0.8) disc(M, cu, c, rr, yy, yy + 1, p.wood); }
          M.b(cu - 1, y0 + 2 * r, c - 1, cu + 1, y0 + 2 * r + 1, c + 1, steel);
          continue;
        }
        if (p.kind === 'steel') {
          disc(M, cu, c, r, y0, y1, p.wood);
          disc(M, cu, c, r + 0.45, y0 + (p.bh >> 1), y0 + (p.bh >> 1) + 1, p.hoop);   // one stiffener ring
          disc(M, cu, c, r - 1, y1, y1 + 1, p.wood); disc(M, cu, c, r - 3, y1 + 1, y1 + 2, p.wood);
          M.b(cu - 1, y1 + 2, c - 1, cu + 1, y1 + 3, c + 1, steel);
          continue;
        }
        // wooden barrel with steel hoops (proud of the staves), denser near the bottom like the real ones
        let yy = y0, k = 0;
        const hoops = [];
        for (let h = y0 + 1; h < y1 - 1; h += (h - y0 < p.bh * 0.4 ? 3 : 5)) hoops.push(h);
        for (const h of hoops) { if (h > yy) disc(M, cu, c, r, yy, h, p.wood); disc(M, cu, c, r + 0.45, h, h + 1, p.hoop); yy = h + 1; ++k; }
        disc(M, cu, c, r, yy, y1, p.wood);
        if (p.lid === 'cone') {
          disc(M, cu, c, r + 0.45, y1, y1 + 1, p.lidMat);
          let ly = y1 + 1, rr = r - 0.6;
          while (rr > 1.4) { disc(M, cu, c, rr, ly, ly + 1, p.lidMat); rr -= p.r >= 7 ? 1.25 : 1.5; ++ly; }
          M.b(cu - 1, ly, c - 1, cu + 1, ly + 1, c + 1, p.lidMat); M.b(cu - 1, ly + 1, c - 1, cu, ly + 3, c, steel);   // finial
        } else {
          disc(M, cu, c, r + 0.45, y1, y1 + 1, p.lidMat);
          M.b(cu - 2, y1 + 1, c + 1, cu + 1, y1 + 2, c + 4, p.wood);     // hatch
          M.b(cu + 2, y1 + 1, c - 3, cu + 3, y1 + 3, c - 2, steel);      // vent
        }
      }
      // ---- ladder on the +u side, from the deck to the lid
      const lu = W - 1, ltop = legH + p.bh + (p.kind === 'sphere' ? r : 1);
      M.b(lu, 0, c - 2, lu + 1, ltop + 2, c - 1, steel); M.b(lu, 0, c + 1, lu + 1, ltop + 2, c + 2, steel);
      for (let yy = 2; yy < ltop; yy += 3) M.b(lu, yy, c - 1, lu + 1, yy + 1, c + 1, steel);
      const near = cs[cs.length - 1] + r;                   // stand-offs to the vessel
      for (const yy of [legH + 2, ltop - 1]) M.b(near - 1, yy, c - 2, lu, yy + 1, c - 1, steel);
      return M;
    });
  }
  // a design from a hash function h(k) in [0,1); o.maxS limits the footprint, o.kind forces a kind
  function tankDesign(h, o) {
    o = o || {};
    const maxS = o.maxS || 40;
    const t = h(1);
    let kind = o.kind || (t < 0.52 ? 'wood' : t < 0.72 ? 'woodBrick' : t < 0.82 ? 'twin' : t < 0.94 ? 'steel' : 'sphere');
    let rMax = Math.floor((maxS - 4) / 2);
    if (kind === 'twin') { rMax = Math.floor(((maxS - 2) / 2 - 2) / 2); if (rMax < 4) kind = 'wood'; }
    if (kind !== 'twin') rMax = Math.floor((maxS - 4) / 2);
    if (rMax < 4) return null;
    const pk = (k, a) => a[Math.floor(h(k) * a.length) % a.length];
    const p = { kind: kind === 'woodBrick' ? 'wood' : kind, rot: Math.floor(h(2) * 4) };
    if (p.kind === 'sphere') {
      p.r = Math.min(rMax, pk(3, [5, 6])); p.bh = 2 * p.r; p.base = 'legs'; p.legH = pk(4, [5, 7]);
      p.wood = pk(5, [BM.METAL, BM.TRIM, BM.PRECAST]);
    } else if (p.kind === 'steel') {
      p.r = Math.min(rMax, pk(3, [4, 5, 6])); p.bh = Math.round(p.r * pk(6, [1.6, 2.1, 2.6])); p.base = pk(4, ['low', 'legs']);
      p.legH = p.base === 'low' ? 3 : pk(7, [6, 8]); p.wood = pk(5, [BM.METAL, BM.TRIM, BM.STEEL_DARK, BM.PRECAST]); p.hoop = BM.STEEL_DARK;
    } else {
      p.r = Math.min(rMax, pk(3, p.kind === 'twin' ? [4, 5, 5] : [5, 6, 6, 7, 8]));
      p.bh = Math.round(p.r * pk(6, [1.3, 1.6, 1.9, 2.2]));
      p.base = kind === 'woodBrick' ? 'brick' : 'legs';
      p.legH = p.base === 'brick' ? pk(7, [5, 7, 9]) : pk(7, [6, 9, 12, 14]);
      p.wood = pk(5, [BM.WOOD, BM.WOOD, BM.SHINGLE_BROWN, BM.TRUNK]); p.hoop = pk(8, [BM.STEEL_DARK, BM.STEEL_DARK, BM.METAL]);
      p.lid = h(9) < 0.72 ? 'cone' : 'flat';
      p.lidMat = p.lid === 'cone' ? pk(10, [BM.SHINGLE_GRAY, BM.SHINGLE_BROWN, BM.WOOD, BM.TRIM_DARK]) : pk(10, [BM.TRIM_DARK, BM.STEEL_DARK]);
      p.brick = pk(11, [BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN]);
    }
    return p;
  }
  function waterTankImpl(E, cx, cz, y, C, o) {
    o = o || {};
    const h = (k) => H2(cx * 7 + k * 131, cz * 13 - k * 71, y * 3 + k * 17);
    // without a design, stay close to the classic 10-voxel tank footprint so existing callers' layouts still fit
    const p = o.design || tankDesign(h, Object.assign({ maxS: 13 }, o));
    if (!p) return null;
    const M = tankModel(p);
    E.vox(C, M, cx - (M.w >> 1), y, cz - (M.d >> 1));
    return { w: M.w, d: M.d, h: M.h };
  }

  // ------------------------------------------------------------------------------------------ the parts
  // stair bulkhead / elevator machine room. kind 'stair' | 'emr'; door on the front (v = 0)
  function bulkheadModel(w, d, h, mat, cop, door, kind, rot, ant) {
    return cached(`bh:${w},${d},${h},${mat},${cop},${door},${kind},${rot},${ant}`, () => {
      const top = kind === 'emr' ? h + 5 : h, M = OM(w, top + 12, d, rot);
      M.b(1, 0, 1, w - 1, h, d - 1, mat);
      M.b(0, h - 1, 0, w, h + 1, d, cop); M.b(1, h - 1, 1, w - 1, h + 1, d - 1, mat); M.b(2, h, 2, w - 2, h + 1, d - 2, -1);
      M.b(2, h - 1, 2, w - 2, h, d - 2, BM.ROOF_TAR);
      if (kind === 'emr') {                                  // machine room raised over the back half
        const v0 = Math.floor(d * 0.45);
        M.b(2, h, v0, w - 2, top, d - 2, mat); M.b(1, top - 1, v0 - 1, w - 1, top, d - 1, cop);
        M.b(3, top, v0 + 2, 6, top + 2, v0 + 5, BM.METAL);                       // vent hood
        M.b(w - 5, h - 1 + 3, v0 - 1, w - 3, top - 3, v0, BM.LOUVER);           // louvre in the step face
      }
      // door in a 1-voxel reveal, a step, a hood over it
      const du = w >= 12 ? 2 + ((w - 8) >> 1) : 2;
      M.b(du, 0, 1, du + 4, 9, 3, door); M.b(du, 0, 1, du + 4, 9, 2, -1);
      M.b(du - 1, 0, 0, du + 5, 1, 1, BM.CONCRETE);
      M.b(du - 1, 10, 0, du + 5, 11, 1, BM.METAL);
      // louvred vent on a side, small window on the other
      const vm = d >> 1;
      M.b(w - 3, 4, vm - 2, w - 1, 8, vm + 2, BM.LOUVER); M.b(w - 2, 4, vm - 2, w - 1, 8, vm + 2, -1);
      if (d >= 12) { M.b(1, 5, vm - 1, 3, 8, vm + 1, BM.GLASS); M.b(1, 5, vm - 1, 2, 8, vm + 1, -1); }
      if (ant) {                                             // cell panels on pipe mounts at the bulkhead corners
        for (const [u, v] of [[2, 2], [w - 3, 2], [w - 3, d - 3]]) {
          M.b(u, h, v, u + 1, h + 10, v + 1, BM.METAL); M.b(u, h + 3, v, u + 1, h + 9, v + 1, BM.TRIM);
        }
        M.b(3, h, d - 5, 6, h + 4, d - 3, BM.STEEL_DARK);  // radio unit
      }
      return M;
    });
  }
  // door surround + steel hood + step, set against an existing wall (front at v = 0, back flush with the wall)
  function doorFrontModel(frame, door) {
    return cached(`df:${frame},${door}`, () => {
      const M = OM(8, 12, 3, 0);
      M.b(0, 0, 1, 8, 11, 3, frame); M.b(2, 0, 1, 6, 9, 2, -1); M.b(2, 0, 2, 6, 9, 3, door);
      M.b(1, 0, 0, 7, 1, 1, BM.CONCRETE); M.b(1, 10, 0, 7, 11, 1, BM.METAL);
      return M;
    });
  }
  const wallMat0 = (R) => pick(R, [BM.LIMESTONE_DARK, BM.CONCRETE, BM.TRIM_DARK]);
  function hatchModel(mat) {
    return cached('hatch:' + mat, () => { const M = OM(5, 4, 5, 0); M.b(0, 0, 0, 5, 2, 5, BM.CONCRETE); M.b(0, 2, 0, 5, 3, 5, mat); M.b(2, 3, 0, 3, 4, 1, BM.STEEL_DARK); return M; });
  }
  // packaged rooftop unit on rails: economiser hood at u = 0, condenser coil louvres + fans at the far end
  function rtuModel(len, dep, hh, mat, fans, rot) {
    return cached(`rtu:${len},${dep},${hh},${mat},${fans},${rot}`, () => {
      const M = OM(len, hh + 3, dep, rot);
      M.b(2, 0, 1, len - 1, 1, 2, BM.STEEL_DARK); M.b(2, 0, dep - 2, len - 1, 1, dep - 1, BM.STEEL_DARK);
      M.b(2, 1, 0, len, hh, dep, mat);
      M.b(1, 2, 1, 2, hh - 1, dep - 1, mat); M.b(0, 2, 1, 1, hh - 3, dep - 1, BM.METAL);              // hood
      const cu0 = len - Math.max(5, Math.round(len * 0.4));
      M.b(cu0, 2, 0, len - 1, hh - 1, dep, BM.LOUVER); M.b(cu0, 2, 0, len - 1, hh - 1, 1, -1); M.b(cu0, 2, dep - 1, len - 1, hh - 1, dep, -1);
      M.b(cu0 - 2, 1, 0, cu0 - 1, hh, 1, BM.TRIM_DARK);                                             // panel seam
      for (let f = 0; f < fans; ++f) { const fu = len - 3 - f * 5; disc(M, fu, dep / 2, 2.1, hh, hh + 1, BM.STEEL_DARK); M.b(fu - 1, hh + 1, (dep >> 1) - 1, fu + 1, hh + 2, (dep >> 1) + 1, BM.STEEL_DARK); }
      return M;
    });
  }
  // a row of split-system condensers on shared rails
  function condRowModel(n, mat, rot) {
    return cached(`cond:${n},${mat},${rot}`, () => {
      const len = n * 6 + 1, M = OM(len, 8, 7, rot);
      M.b(0, 0, 1, len, 1, 2, BM.STEEL_DARK); M.b(0, 0, 5, len, 1, 6, BM.STEEL_DARK);
      for (let k = 0; k < n; ++k) {
        const u = 1 + k * 6;
        M.b(u, 1, 1, u + 5, 5, 6, BM.LOUVER); M.b(u, 5, 1, u + 5, 6, 6, mat);
        for (const [a, b] of [[u, 1], [u + 4, 1], [u, 5], [u + 4, 5]]) M.b(a, 1, b, a + 1, 5, b + 1, mat);
        M.b(u + 1, 6, 2, u + 4, 7, 5, BM.STEEL_DARK);
      }
      return M;
    });
  }
  function coolingTowerModel(sz, cells, mat) {
    return cached(`ct:${sz},${cells},${mat}`, () => {
      const len = sz * cells, M = OM(len, 22, sz, 0), lh = 7;
      for (const u of [0, len - 1]) for (const v of [0, sz - 1]) M.b(u, 0, v, u + 1, 3, v + 1, BM.STEEL_DARK);
      M.b(0, 3, 0, len, 5, sz, BM.METAL);                                       // cold-water basin
      for (let yy = 5; yy < 5 + lh; ++yy) M.b(0, yy, 0, len, yy + 1, sz, yy % 2 ? BM.LOUVER : BM.STEEL_DARK);
      M.b(1, 5, 1, len - 1, 5 + lh, sz - 1, BM.METAL);
      const t = 5 + lh; M.b(0, t, 0, len, t + 4, sz, mat);
      for (let k = 0; k < cells; ++k) {
        const cu = k * sz + sz / 2, cv = sz / 2, rr = sz / 2 - 1.5;
        disc(M, cu, cv, rr, t + 4, t + 7, mat); disc(M, cu, cv, rr - 1, t + 5, t + 7, -1);
        M.b(Math.floor(cu) - 1, t + 4, Math.floor(cv) - 1, Math.floor(cu) + 1, t + 6, Math.floor(cv) + 1, BM.STEEL_DARK);
      }
      // ladder up one end
      M.b(len - 1, 0, 2, len, t + 4, 3, BM.STEEL_DARK);
      return M;
    });
  }
  // air handler: long casing with panel seams and a supply duct rising off the top
  function ahuModel(len, dep, hh, mat, rot) {
    return cached(`ahu:${len},${dep},${hh},${mat},${rot}`, () => {
      const M = OM(len, hh + 6, dep, rot);
      M.b(1, 0, 1, len - 1, 1, dep - 1, BM.CONCRETE);
      M.b(0, 1, 0, len, hh, dep, mat);
      for (let u = 5; u < len - 2; u += 6) M.b(u, 1, 0, u + 1, hh, dep, BM.TRIM_DARK);
      M.b(len - 6, 2, 0, len - 1, hh - 2, dep, BM.LOUVER); M.b(len - 6, 2, 0, len - 1, hh - 2, 1, -1);
      M.b(3, hh, 2, 7, hh + 4, dep - 2, BM.METAL); M.b(2, hh + 4, 1, 8, hh + 5, dep - 1, BM.METAL);
      return M;
    });
  }
  // straight duct along u (3 x 3), on stands; 'down' turns into the deck at the far end
  function ductModel(len, down, rot, mat) {
    return cached(`duct:${len},${down},${rot},${mat}`, () => {
      const M = OM(len, 6, 3, rot);
      M.b(0, 2, 0, len, 5, 3, mat);
      for (let u = 3; u < len - 2; u += 7) M.b(u, 0, 1, u + 1, 2, 2, BM.STEEL_DARK);
      if (down) { M.b(len - 3, 0, 0, len, 5, 3, mat); M.b(len - 4, 0, -0, len, 1, 3, BM.CONCRETE); }
      return M;
    });
  }
  // pipe rack on concrete sleepers along u
  function pipeRackModel(len, rot) {
    return cached(`pipes:${len},${rot}`, () => {
      const M = OM(len, 6, 6, rot);
      for (let u = 1; u < len - 1; u += 8) M.b(u, 0, 0, u + 2, 1, 6, BM.CONCRETE);
      M.b(0, 1, 1, len, 3, 3, BM.METAL); M.b(0, 1, 4, len, 2, 5, BM.PAINT_YELLOW); M.b(0, 2, 4, len, 3, 5, BM.STEEL_DARK);
      for (const u of [0, len - 2]) { M.b(u, 0, 1, u + 2, 3, 3, BM.METAL); M.b(u, 0, 4, u + 1, 3, 5, BM.PAINT_YELLOW); }
      return M;
    });
  }
  // small roof penetrations
  function smallModel(kind, mat) {
    return cached(`small:${kind},${mat}`, () => {
      let M;
      if (kind === 'upblast') { M = OM(5, 6, 5, 0); M.b(0, 0, 0, 5, 1, 5, BM.METAL); disc(M, 2.5, 2.5, 2.2, 1, 4, mat); M.b(1, 4, 1, 4, 5, 4, BM.STEEL_DARK); }
      else if (kind === 'mushroom') { M = OM(5, 6, 5, 0); M.b(1, 0, 1, 4, 3, 4, mat); M.b(0, 3, 0, 5, 4, 5, mat); M.b(1, 4, 1, 4, 5, 4, mat); }
      else if (kind === 'goose') { M = OM(3, 6, 4, 0); M.b(1, 0, 1, 2, 5, 2, mat); M.b(1, 4, 1, 2, 5, 3, mat); M.b(1, 3, 2, 2, 4, 4, mat); M.b(0, 0, 0, 3, 1, 3, BM.CONCRETE); }
      else if (kind === 'stacks') { M = OM(4, 8, 4, 0); M.b(0, 0, 0, 1, 6, 1, mat); M.b(2, 0, 1, 3, 4, 2, mat); M.b(1, 0, 3, 2, 7, 4, BM.STEEL_DARK); }
      else if (kind === 'turbine') { M = OM(4, 6, 4, 0); M.b(1, 0, 1, 3, 2, 3, mat); M.b(0, 2, 0, 4, 4, 4, mat); M.b(1, 4, 1, 3, 5, 3, mat); }
      else if (kind === 'cabinet') { M = OM(4, 7, 3, 0); M.b(0, 0, 0, 4, 6, 3, mat); M.b(2, 1, 0, 3, 5, 1, BM.TRIM_DARK); M.b(0, 6, 0, 4, 7, 3, BM.METAL); }
      else if (kind === 'riser') { M = OM(6, 18, 6, 0); M.b(1, 0, 1, 5, 12, 5, mat); M.b(0, 12, 0, 6, 14, 6, BM.STEEL_DARK); M.b(1, 14, 1, 5, 15, 5, mat); M.b(2, 15, 2, 4, 16, 4, BM.STEEL_DARK); }
      return M;
    });
  }
  function skylightModel(w, d, lit, rot) {
    return cached(`sky:${w},${d},${lit},${rot}`, () => {
      const M = OM(w, 8, d, rot), g = lit ? BM.GLASS_LIT : BM.GLASS;
      M.b(0, 0, 0, w, 1, d, BM.TRIM_DARK);
      let k = 0;
      while (d - 2 * k > 2) { M.b(1, 1 + k, k, w - 1, 2 + k, d - k, g); ++k; }
      M.b(0, 1, 0, 1, 1 + k, d, BM.METAL); M.b(w - 1, 1, 0, w, 1 + k, d, BM.METAL);
      for (let u = 4; u < w - 2; u += 4) for (let j = 0; j < k; ++j) { M.b(u, 1 + j, j, u + 1, 2 + j, j + 1, BM.METAL); M.b(u, 1 + j, d - 1 - j, u + 1, 2 + j, d - j, BM.METAL); }
      M.b(0, 1 + k, k - 1, w, 2 + k, d - k + 1, BM.METAL);                       // ridge
      return M;
    });
  }
  function sawtoothModel(len, n, lit) {
    return cached(`saw:${len},${n},${lit}`, () => {
      const t = 7, M = OM(len, 9, n * t, 0), g = lit ? BM.GLASS_LIT : BM.GLASS;
      for (let k = 0; k < n; ++k) {
        const v0 = k * t;
        for (let j = 0; j < t - 1; ++j) M.b(0, 0, v0 + j, len, 2 + j, v0 + j + 1, BM.METAL);
        M.b(0, 0, v0 + t - 1, len, t + 1, v0 + t, g);
        for (let u = 0; u < len; u += 6) M.b(u, 2, v0 + t - 1, u + 1, t + 1, v0 + t, BM.STEEL_DARK);
      }
      return M;
    });
  }
  function dishModel(r, mat, rot) {
    return cached(`dish:${r},${mat},${rot}`, () => {
      const S = 2 * r + 3, M = OM(S, 2 * r + 8, S, rot), c = S >> 1, yc = r + 4;
      M.b(0, 0, 1, S, 1, 2, BM.STEEL_DARK); M.b(0, 0, S - 2, S, 1, S - 1, BM.STEEL_DARK); M.b(c, 0, 1, c + 1, 1, S - 1, BM.STEEL_DARK);
      M.b(c, 1, c, c + 1, yc, c + 1, BM.METAL);
      const ca = 0.77, sa = 0.64;                         // dish faces the front and up
      for (let a = -r; a <= r; a += 0.5) for (let t = -r; t <= r; t += 0.5) {
        if (a * a + t * t > r * r) continue;
        const sag = (a * a + t * t) / (3 * r);
        const u = Math.round(c + a), yy = Math.round(yc + t * ca + sag * 0.64), v = Math.round(c + t * sa - sag * 0.77);
        M.b(u, yy, v, u + 1, yy + 1, v + 1, mat);
      }
      for (let s = 1; s <= r; ++s) { const yy = Math.round(yc + s * 0.64), v = Math.round(c - s * 0.77); M.b(c, yy, v, c + 1, yy + 1, v + 1, BM.STEEL_DARK); }
      return M;
    });
  }
  function cellSiteModel(h) {
    return cached(`cell:${h}`, () => {
      const M = OM(9, h + 2, 9, 0);
      M.b(0, 0, 0, 9, 1, 2, BM.CONCRETE); M.b(0, 0, 7, 9, 1, 9, BM.CONCRETE); M.b(0, 1, 0, 9, 2, 9, BM.STEEL_DARK); M.b(1, 1, 1, 8, 2, 8, -1);
      M.b(4, 1, 4, 5, h, 5, BM.METAL);
      M.b(1, h - 8, 4, 8, h - 7, 5, BM.METAL); M.b(4, h - 8, 1, 5, h - 7, 8, BM.METAL);
      M.b(0, h - 10, 4, 1, h - 2, 6, BM.TRIM); M.b(8, h - 10, 3, 9, h - 2, 5, BM.TRIM); M.b(3, h - 10, 8, 5, h - 2, 9, BM.TRIM); M.b(4, h - 10, 0, 6, h - 2, 1, BM.TRIM);
      M.b(5, h - 5, 4, 6, h - 3, 6, BM.STEEL_DARK);
      return M;
    });
  }
  function mastModel(h) {
    return cached(`mast:${h}`, () => {
      const M = OM(6, h + 10, 6, 0);
      M.b(0, 0, 0, 6, 1, 6, BM.CONCRETE);
      for (const [u, v] of [[1, 1], [3, 1], [1, 3], [3, 3]]) M.b(u, 1, v, u + 1, h, v + 1, BM.METAL);   // lattice legs
      for (let yy = 4; yy < h; yy += 4) { M.b(1, yy, 1, 4, yy + 1, 4, BM.METAL); M.b(2, yy, 2, 3, yy + 1, 3, -1); }
      M.b(1, h, 1, 4, h + 1, 4, BM.METAL); M.b(2, h + 1, 2, 3, h + 8, 3, BM.METAL); M.b(2, h + 8, 2, 3, h + 9, 3, BM.BEACON);
      M.b(3, h - 6, 0, 4, h - 2, 1, BM.TRIM); M.b(0, h - 10, 3, 1, h - 6, 4, BM.TRIM);
      return M;
    });
  }
  function solarModel(len, rows, glass) {
    return cached(`solar:${len},${rows},${glass}`, () => {
      const M = OM(len, 7, rows * 8 - 3, 0);
      for (let k = 0; k < rows; ++k) {
        const v = k * 8;
        for (let j = 0; j < 5; ++j) M.b(0, 1 + j, v + j, len, 2 + j, v + j + 1, glass);
        M.b(0, 5, v + 4, len, 6, v + 5, BM.METAL);
        for (let u = 1; u < len; u += 8) { M.b(u, 0, v, u + 1, 1, v + 1, BM.METAL); M.b(u, 0, v + 4, u + 1, 5, v + 5, BM.METAL); }
        M.b(len - 1, 0, v, len, 1, v + 1, BM.METAL); M.b(len - 1, 0, v + 4, len, 5, v + 5, BM.METAL);
      }
      return M;
    });
  }
  // roof garden: deck, railing, planters with shrubs and trees, optional pergola and table
  function gardenModel(w, d, seed, rot) {
    return cached(`garden:${w},${d},${seed},${rot}`, () => {
      let s = seed; const R = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; };
      const M = OM(w, 24, d, rot), rail = BM.STEEL_DARK, deck = R() < 0.6 ? BM.WOOD : BM.CONCRETE;
      const pl = pick(R, [BM.WOOD, BM.BRICK_BROWN, BM.CONCRETE, BM.TRIM_DARK]);
      M.b(0, 0, 0, w, 1, d, deck);
      // railing on the perimeter: posts every 4 and a top rail; gap at the front for the entry
      for (let u = 0; u < w; u += 4) { M.b(u, 1, 0, u + 1, 5, 1, rail); M.b(u, 1, d - 1, u + 1, 5, d, rail); }
      for (let v = 0; v < d; v += 4) { M.b(0, 1, v, 1, 5, v + 1, rail); M.b(w - 1, 1, v, w, 5, v + 1, rail); }
      M.b(w - 1, 1, d - 1, w, 5, d, rail);
      const gap0 = (w >> 1) - 2;
      M.b(0, 4, 0, gap0, 5, 1, rail); M.b(gap0 + 4, 4, 0, w, 5, 1, rail);
      M.b(0, 4, d - 1, w, 5, d, rail); M.b(0, 4, 0, 1, 5, d, rail); M.b(w - 1, 4, 0, w, 5, d, rail);
      // planter run along the back with shrubs
      M.b(2, 1, d - 5, w - 2, 4, d - 2, pl);
      for (let u = 3; u < w - 4; u += 3 + Math.floor(R() * 2)) M.b(u, 4, d - 5 + (R() < 0.5 ? 0 : 1), u + 2 + Math.floor(R() * 2), 5 + Math.floor(R() * 2), d - 3, R() < 0.5 ? BM.LEAF : BM.LEAF_DARK);
      // trees in big tubs at the back corners
      const nt = w >= 20 ? 2 : 1;
      for (let k = 0; k < nt; ++k) {
        const u = k === 0 ? 5 : w - 6, v = d - 10;
        if (v < 6) break;
        M.b(u - 2, 1, v - 2, u + 3, 4, v + 3, pl); tree(M, u, v, 4, 0.9 + R() * 0.5, R() < 0.5 ? BM.LEAF : BM.LEAF_DARK);
      }
      // side planter
      if (d >= 16) M.b(2, 1, 3, 4, 3, d - 12, pl), M.b(2, 3, 4, 4, 4, d - 13, BM.LEAF_DARK);
      // pergola or table with umbrella in the open middle
      const mu = w >> 1, mv = Math.max(6, (d >> 1) - 2);
      if (w >= 16 && d >= 16 && R() < 0.4) {
        const u0 = mu - 6, u1 = mu + 6, v0 = mv - 4, v1 = mv + 4;
        for (const [a, b] of [[u0, v0], [u1 - 1, v0], [u0, v1 - 1], [u1 - 1, v1 - 1]]) M.b(a, 1, b, a + 1, 11, b + 1, BM.WOOD);
        M.b(u0, 11, v0, u1, 12, v0 + 1, BM.WOOD); M.b(u0, 11, v1 - 1, u1, 12, v1, BM.WOOD);
        for (let u = u0 + 1; u < u1 - 1; u += 2) M.b(u, 12, v0 - 1, u + 1, 13, v1 + 1, BM.WOOD);
        M.b(mu - 2, 1, mv - 1, mu + 2, 4, mv + 1, BM.WOOD);
      } else {
        M.b(mu - 1, 1, mv - 1, mu + 1, 4, mv + 1, BM.WOOD); M.b(mu, 4, mv, mu + 1, 9, mv + 1, BM.STEEL_DARK);
        M.b(mu - 3, 9, mv - 3, mu + 4, 10, mv + 4, pick(R, [BM.AWNING_RED, BM.AWNING_GREEN, BM.AWNING_BLUE, BM.TRIM]));
      }
      return M;
    });
  }
  function greenhouseModel(w, d, frame, rot) {
    return cached(`gh:${w},${d},${frame},${rot}`, () => {
      const M = OM(w, 16, d, rot), hw = 8;
      M.b(0, 0, 0, w, 2, d, BM.BRICK_RED);
      M.b(0, 2, 0, w, hw, d, BM.GLASS);
      let k = 0; while (d - 2 * k > 2) { M.b(0, hw + k, k, w, hw + k + 1, d - k, BM.GLASS); ++k; }
      M.b(0, hw + k, k - 1, w, hw + k + 1, d - k + 1, frame);
      for (let u = 0; u < w; u += 5) { M.b(u, 2, 0, u + 1, hw, 1, frame); M.b(u, 2, d - 1, u + 1, hw, d, frame); for (let j = 0; j < k; ++j) { M.b(u, hw + j, j, u + 1, hw + j + 1, j + 1, frame); M.b(u, hw + j, d - 1 - j, u + 1, hw + j + 1, d - j, frame); } }
      M.b(w - 1, 2, 0, w, hw + k, d, frame); M.b(0, hw - 1, 0, w, hw, d, frame);
      M.b(2, 2, 0, 5, hw - 1, 1, BM.DOOR_NAVY);
      return M;
    });
  }
  function chimneyModel(w, d, h, mat, cap, pots) {
    return cached(`chim:${w},${d},${h},${mat},${cap},${pots}`, () => {
      const M = OM(w + 2, h + 4, d + 2, 0);
      M.b(1, 0, 1, w + 1, h, d + 1, mat); M.b(0, h, 0, w + 2, h + 1, d + 2, cap); M.b(1, h + 1, 1, w + 1, h + 2, d + 1, mat);
      for (let k = 0; k < pots; ++k) { const v = 2 + k * 2; if (v > d) break; M.b(2 + (k % 2), h + 2, v, 3 + (k % 2), h + 4, v + 1, BM.TERRACOTTA); }
      return M;
    });
  }
  // billboard facing the street (front at v = 0): footings, columns, girts, a framed face, catwalk and lamps
  function billboardModel(len, ph, yb, design) {
    return cached(`bb:${len},${ph},${yb},${design}`, () => {
      const M = OM(len, yb + ph + 2, 7, 0), top = yb + ph;
      for (let u = 2; u < len - 1; u += Math.max(6, Math.floor((len - 4) / 3))) {
        M.b(u - 1, 0, 3, u + 2, 1, 7, BM.CONCRETE);
        M.b(u, 1, 4, u + 1, top - 1, 5, BM.STEEL_DARK);
        for (let j = 0; j < 4; ++j) M.b(u, 1 + j, 5 + (j < 2 ? 1 : 0), u + 1, 2 + j, 6 + (j < 2 ? 1 : 0), BM.STEEL_DARK);   // kicker
      }
      for (const yy of [yb + 1, top - 2]) M.b(0, yy, 3, len, yy + 1, 4, BM.METAL);
      M.b(0, yb - 1, 0, len, yb, 3, BM.METAL);                                         // catwalk
      // face and frame
      const P = [BM.AWNING_RED, BM.AWNING_BLUE, BM.AWNING_GREEN, BM.PAINT_YELLOW, BM.PAINT_CREAM, BM.TRIM, BM.PAINT_SALMON, BM.PAINT_BLUE, BM.DOOR_NAVY, BM.SHUTTER_BLACK];
      const h = (k) => H2(design, k, len);
      const pc = (k) => P[Math.floor(h(k) * P.length)];
      const kind = design % 5;                     // 0..2 painted, 3 neon, 4 LED screen
      const bg = kind === 3 ? BM.SHUTTER_BLACK : kind === 4 ? BM.LED : pc(1);
      M.b(0, yb, 1, len, top, 3, kind >= 3 ? BM.STEEL_DARK : BM.TRIM_DARK);
      M.b(1, yb + 1, 2, len - 1, top - 1, 3, bg); M.b(1, yb + 1, 1, len - 1, top - 1, 2, -1);
      const fu0 = 1, fu1 = len - 1, fy0 = yb + 1, fy1 = top - 1, fw = fu1 - fu0, fh = fy1 - fy0;
      const face = (a, b, c2, d2, m) => M.b(fu0 + a, fy0 + b, 2, fu0 + c2, fy0 + d2, 3, m);
      if (kind === 0) {                            // product block + headline + tagline
        let c1 = pc(2); if (c1 === bg) c1 = BM.TRIM;
        const iw = Math.max(4, Math.round(fw * 0.35));
        face(0, 0, iw, fh, c1); face(1, 2, iw - 1, fh - 2, pc(3) === c1 ? BM.TRIM : pc(3));
        face(iw + 2, fh - 4, fw - 2, fh - 2, BM.SHUTTER_BLACK); face(iw + 2, fh - 7, fw - 5, fh - 6, BM.SHUTTER_BLACK);
        if (fh > 9) face(fw - 5, 1, fw - 1, 4, pc(4) === bg ? BM.TRIM : pc(4));
      } else if (kind === 1) {                     // big band with lettering
        let c1 = pc(2); if (c1 === bg) c1 = BM.SHUTTER_BLACK;
        const b0 = Math.floor(fh * 0.3), b1 = Math.floor(fh * 0.75);
        face(0, b0, fw, b1, c1);
        for (let u = 2; u < fw - 2; u += 3) face(u, b0 + 1, u + 2, b1 - 1, bg);
      } else if (kind === 2) {                     // diagonal swoosh (stepped) and a logo
        let c1 = pc(2); if (c1 === bg) c1 = BM.TRIM;
        for (let u = 0; u < fw; u += 2) { const v = Math.floor(u * fh / fw * 0.8); face(u, v, u + 2, Math.min(fh, v + 3), c1); }
        face(fw - 6, fh - 5, fw - 2, fh - 1, BM.SHUTTER_BLACK);
      } else if (kind === 3) {                     // neon script on black with an LED border
        M.b(0, yb, 1, len, yb + 1, 2, BM.LED); M.b(0, top - 1, 1, len, top, 2, BM.LED);
        for (let u = 2; u < fw - 2; u += 4) { const tall = h(10 + u) < 0.5; face(u, 2, u + 1, tall ? fh - 2 : fh - 4, BM.NEON); face(u, fh - 4, u + 3, fh - 3, BM.NEON); }
        face(1, 1, fw - 1, 2, BM.NEON);
      } else {                                     // LED screen showing an image
        face(0, 0, Math.round(fw * 0.6), Math.round(fh * 0.5), pc(2)); face(Math.round(fw * 0.4), Math.round(fh * 0.4), fw, fh, pc(3));
        face(2, fh - 4, Math.round(fw * 0.35), fh - 2, BM.SHUTTER_BLACK);
      }
      for (let u = 3; u < len - 2; u += 8) { M.b(u, yb, 0, u + 1, yb + 2, 1, BM.STEEL_DARK); M.b(u, yb + 2, 0, u + 1, yb + 3, 1, BM.LED); }
      return M;
    });
  }

  // ------------------------------------------------------------------------------------------ planner
  class Plan {
    constructor(W, D) { this.W = W; this.D = D; this.o = new Uint8Array(W * D); this.S = null; }
    mark(a, b, c, d) {
      a = clamp(a, 0, this.W); c = clamp(c, 0, this.W); b = clamp(b, 0, this.D); d = clamp(d, 0, this.D);
      for (let z = b; z < d; ++z) this.o.fill(1, z * this.W + a, z * this.W + c);
      this.S = null;
    }
    sat() {
      const W = this.W, D = this.D, S = new Int32Array((W + 1) * (D + 1));
      for (let z = 0; z < D; ++z) { let row = 0; for (let x = 0; x < W; ++x) { row += this.o[z * W + x]; S[(z + 1) * (W + 1) + x + 1] = S[z * (W + 1) + x + 1] + row; } }
      this.S = S;
    }
    sum(a, b, c, d) {
      if (!this.S) this.sat();
      a = clamp(a, 0, this.W); c = clamp(c, 0, this.W); b = clamp(b, 0, this.D); d = clamp(d, 0, this.D);
      if (c <= a || d <= b) return 0;
      const S = this.S, W1 = this.W + 1;
      return S[d * W1 + c] - S[b * W1 + c] - S[d * W1 + a] + S[b * W1 + a];
    }
  }

  function roofKit(E, C, x0, z0, x1, z1, y, R, opts) {
    opts = opts || {};
    const style = opts.style || 'office', floors = opts.floors || 6;
    const W = x1 - x0, D = z1 - z0;
    if (W < 10 || D < 10) return;
    const P = new Plan(W, D);
    let mg = 4;
    if (W - 2 * mg < 8 || D - 2 * mg < 8) mg = 2;
    const bx0 = mg, bz0 = mg, bx1 = W - mg, bz1 = D - mg, iw = bx1 - bx0, id = bz1 - bz0;
    if (iw < 5 || id < 5) return;
    const ia = iw * id;                                     // usable area in voxels (16 per m2)
    const salt = (Math.floor(R() * 1e9)) | 0;
    let core = null;
    for (const a of opts.avoid || []) P.mark(a[0] - x0, a[1] - z0, a[2] - x0, a[3] - z0);
    // classic_mid's flatRoof already raises a 12-voxel penthouse in the middle of tall roofs: use it as the core
    if (!opts.avoid && x0 === 1 && z0 === 1 && floors >= 7 && (style === 'historic' || style === 'office') && W + 2 > 24 && D + 2 > 24) {
      const FW = W + 2, FD = D + 2;
      const px0 = Math.max(3, Math.floor(FW * 0.3)), pz0 = Math.max(3, Math.floor(FD * 0.35));
      const px1 = Math.min(FW - 3, Math.floor(FW * 0.3) + Math.floor(FW * 0.4)), pz1 = Math.min(FD - 3, Math.floor(FD * 0.35) + Math.floor(FD * 0.3));
      core = { x0: px0 - x0, z0: pz0 - z0, x1: px1 - x0, z1: pz1 - z0, h: 12, flat: true };
      P.mark(core.x0, core.z0, core.x1, core.z1);
      // give the plain penthouse a door and a louvre so it reads as the stair / machine room
      const M = doorFrontModel(wallMat0(R), pick(R, [BM.SHUTTER_BLACK, BM.DOOR_NAVY, BM.METAL]));
      const dx = core.x0 + ((core.x1 - core.x0 - M.w) >> 1);
      E.vox(C, M, x0 + dx, y, z0 + core.z0 - M.d); P.mark(dx, core.z0 - M.d - 10, dx + M.w, core.z0);   // + clear walkway
    }
    // ---- placement helpers (coordinates relative to (x0, z0))
    const free = (a, b, w, d, gap) => P.sum(a - gap, b - gap, a + w + gap, b + d + gap) === 0;
    const find = (w, d, score, o) => {
      o = o || {};
      const gap = o.gap === undefined ? 2 : o.gap, e = o.edge === undefined ? mg : o.edge;
      const ax0 = e, az0 = e, ax1 = W - e - w, az1 = D - e - d;
      if (ax1 < ax0 || az1 < az0) return null;
      const st = w * d > 300 || ia > 3000 ? 2 : 1;
      let best = null, bs = 1e18;
      for (let b = az0; b <= az1; b += st) for (let a = ax0; a <= ax1; a += st) {
        if (!free(a, b, w, d, gap)) continue;
        const s = score(a, b) + H2(a, b, salt) * (o.jitter || 2);
        if (s < bs) { bs = s; best = [a, b]; }
      }
      return best;
    };
    const items = [];
    const put = (M, a, b, info, yy) => {
      P.mark(a, b, a + M.w, b + M.d);
      E.vox(C, M, x0 + a, yy === undefined ? y : yy, z0 + b);
      const it = Object.assign({ x0: a, z0: b, x1: a + M.w, z1: b + M.d, h: M.h }, info || {});
      items.push(it); return it;
    };
    const placeAt = (M, score, info, o) => { const p = find(M.w, M.d, score, o); return p ? put(M, p[0], p[1], info) : null; };
    const cx = W / 2, back = D - mg;
    const deep = id > 70;
    // ---- 1. core: stair bulkhead / elevator machine room, or a hatch
    const brickish = style === 'historic' || (style === 'residential' && R() < 0.7) || (style === 'industrial' && R() < 0.6);
    const wallMat = brickish ? pick(R, [BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN]) : pick(R, [BM.CONCRETE, BM.PRECAST, BM.WHITE_CONCRETE, BM.LIMESTONE_DARK]);
    const copMat = brickish ? pick(R, [BM.LIMESTONE_DARK, BM.CONCRETE, BM.TRIM_DARK]) : pick(R, [BM.METAL, BM.TRIM_DARK, BM.LIMESTONE_DARK]);
    const doorMat = pick(R, [BM.SHUTTER_BLACK, BM.DOOR_NAVY, BM.METAL, BM.DOOR_RED, BM.SHUTTER_GREEN]);
    const coreSide = R();
    const coreX = coreSide < 0.5 ? cx : coreSide < 0.75 ? bx0 + iw * 0.25 : bx0 + iw * 0.75;
    const coreZ = deep && R() < 0.5 ? D * 0.62 : back;
    if (!core) {
      const wantBH = style !== 'residential' || floors >= 5 || ia > 900;
      if (wantBH && iw >= 14 && id >= 16) {
        const emr = floors >= 6 && iw >= 22 && id >= 22 && style !== 'residential' ? true : (floors >= 6 && iw >= 22 && id >= 22 && R() < 0.5);
        const bw = emr ? 16 + 2 * Math.floor(R() * 3) : 11 + Math.floor(R() * 2), bd = emr ? 16 + 2 * Math.floor(R() * 2) : 12 + Math.floor(R() * 3);
        const bh = emr ? 13 : 11;
        const ant = style === 'office' && floors >= 8 && R() < 0.3;
        const M = bulkheadModel(Math.min(bw, iw), Math.min(bd, id - 2), bh, wallMat, copMat, doorMat, emr ? 'emr' : 'stair', 0, ant);
        const it = placeAt(M, (a, b) => Math.abs(a + M.w / 2 - coreX) * 1.5 + Math.abs(b + M.d - coreZ) * 2, { kind: 'core', h: bh, emr, ant }, { gap: 3 });
        if (it) {
          core = it;
          const du = M.w >= 12 ? 2 + ((M.w - 8) >> 1) : 2;                            // keep the door approach clear
          P.mark(it.x0 + du - 1, it.z0 - 8, it.x0 + du + 5, it.z0);
        }
      }
      if (!core) {
        const M = hatchModel(pick(R, [BM.METAL, BM.TRIM_DARK, BM.STEEL_DARK]));
        const it = placeAt(M, (a, b) => Math.abs(a + 2 - cx) + Math.abs(b + 5 - back) * 1.5, { kind: 'hatch' });
        if (it) core = Object.assign(it, { small: true });
      }
    }
    // big floor plates have a second fire stair: a smaller bulkhead towards the front, away from the core
    if (core && !core.small && ia > 2800 && R() < 0.75) {
      const M = bulkheadModel(11, 12, 11, wallMat, copMat, doorMat, 'stair', 2, false);   // door faces into the roof
      const ccx = (core.x0 + core.x1) / 2;
      const it2 = placeAt(M, (a, b) => b * 1.0 - Math.abs(a + 5 - ccx) * 0.6, { kind: 'stair2' }, { gap: 3 });
      if (it2) P.mark(it2.x0 + 4, it2.z1, it2.x0 + 10, it2.z1 + 7);
    }
    const nearCore = (w, d) => (a, b) => {
      if (!core) return Math.abs(a + w / 2 - cx) + Math.abs(b + d - back);
      const dx = Math.max(core.x0 - (a + w), a - core.x1, 0), dz = Math.max(core.z0 - (b + d), b - core.z1, 0);
      return dx + dz;
    };
    // ---- 2. water tank (mainly historic / residential), on the bulkhead roof or on dunnage beside it
    const tankP = { historic: 0.45, residential: ia > 1200 ? 0.3 : 0.14, office: 0.1, industrial: 0.3 }[style] || 0.1;
    if (R() < tankP && ia >= 180) {
      const hs = R() * 1e6 | 0, h = (k) => H2(hs, k, 911);
      const onTop = core && !core.small && !core.emr && !core.ant && R() < 0.45;
      if (onTop) {
        const cw = core.x1 - core.x0, cd = core.z1 - core.z0;
        const p = tankDesign(h, { maxS: Math.min(cw, cd) - (core.flat ? 0 : 2), kind: style === 'industrial' && h(20) < 0.5 ? 'steel' : undefined });
        if (p) {
          if (p.base === 'brick') p.base = 'legs';
          const Mt = tankModel(p);
          if (Mt.w <= cw - (core.flat ? 0 : 2) && Mt.d <= cd - (core.flat ? 0 : 2)) {
            const ccx = x0 + ((core.x0 + core.x1) >> 1), ccz = z0 + ((core.z0 + core.z1) >> 1);
            L.waterTankImpl(E, ccx, ccz, y + core.h, C, { design: p });
            core.tank = true;
          }
        }
      }
      if (!core || !core.tank) {
        const twinOK = ia > 2500;
        const p = tankDesign(h, { maxS: Math.min(iw, id, 34), kind: style === 'industrial' && h(20) < 0.5 ? 'steel' : (!twinOK && h(1) >= 0.72 && h(1) < 0.82 ? 'wood' : undefined) });
        if (p) {
          const Mt = tankModel(p);
          const pos = find(Mt.w, Mt.d, nearCore(Mt.w, Mt.d), { gap: 2 });
          if (pos) {
            L.waterTankImpl(E, x0 + pos[0] + (Mt.w >> 1), z0 + pos[1] + (Mt.d >> 1), y, C, { design: p });
            P.mark(pos[0], pos[1], pos[0] + Mt.w, pos[1] + Mt.d);
          }
        }
      }
    }
    // ---- 3. mechanical yard
    const unitMat = pick(R, [BM.METAL, BM.TRIM, BM.PRECAST, BM.BUFF, BM.METAL]);
    const ductMat = R() < 0.75 ? BM.METAL : BM.TRIM;
    const duct = (u) => {
      // run a duct from unit u into the core if they line up and the way is clear, else a short stub into the deck
      if (core && !core.small && core.kind !== 'hatch') {
        const oz0 = Math.max(u.z0 + 1, core.z0 + 1), oz1 = Math.min(u.z1 - 1, core.z1 - 1);
        const ox0 = Math.max(u.x0 + 1, core.x0 + 1), ox1 = Math.min(u.x1 - 1, core.x1 - 1);
        if (oz1 - oz0 >= 3) {
          const zz = (oz0 + oz1 - 3) >> 1, left = u.x1 <= core.x0;
          const a = left ? u.x1 - 1 : core.x1 - 1, b = left ? core.x0 + 1 : u.x0 + 1, len = b - a;
          if (len >= 5 && len <= 60 && P.sum(a + 1, zz - 1, b - 1, zz + 4) === 0) { put(ductModel(len, false, 0, ductMat), a, zz); return; }
        }
        if (ox1 - ox0 >= 3) {
          const xx = (ox0 + ox1 - 3) >> 1, front = u.z1 <= core.z0;
          if (front && !core.flat) return stub(u);                // never across the bulkhead door
          const a = front ? u.z1 - 1 : core.z1 - 1, b = front ? core.z0 + 1 : u.z0 + 1, len = b - a;
          if (len >= 5 && len <= 60 && P.sum(xx - 1, a + 1, xx + 4, b - 1) === 0) { put(ductModel(len, false, 1, ductMat), xx, a); return; }
        }
      }
      stub(u);
    };
    const stub = (u) => {
      const len = 6 + Math.floor(R() * 5);
      const opts4 = [[u.x1 - 1, ((u.z0 + u.z1) >> 1) - 1, 0, len, 3], [((u.x0 + u.x1) >> 1) - 1, u.z1 - 1, 1, 3, len], [((u.x0 + u.x1) >> 1) - 1, u.z0 - len + 1, 3, 3, len]];
      for (const [a, b, rot, w, d] of opts4) {
        if (a < mg || b < mg || a + w > W - mg || b + d > D - mg) continue;
        const ok = rot === 0 ? P.sum(a + 1, b - 1, a + w + 1, b + d + 1) === 0 : rot === 1 ? P.sum(a - 1, b + 1, a + w + 1, b + d + 1) === 0 : P.sum(a - 1, b - 1, a + w + 1, b + d - 1) === 0;
        if (!ok) continue;
        put(ductModel(len, true, rot, ductMat), a, b); return;
      }
    };
    const yardZ = core ? (core.z0 > D / 2 ? core.z0 - 12 : core.z1 + 10) : D * 0.55;
    const units = (n, make, zLine, x0n) => {
      const zl = zLine === undefined ? yardZ : zLine;
      let nextX = x0n !== undefined ? x0n : core ? (core.x0 > W / 2 ? core.x0 - 4 : core.x1 + 4) : bx0;
      const dir = x0n !== undefined ? 1 : core && core.x0 > W / 2 ? -1 : 1;
      for (let k = 0; k < n; ++k) {
        const M = make(k);
        const it = placeAt(M, (a, b) => Math.abs(b + M.d / 2 - zl) * 1.2 + Math.abs((dir > 0 ? a : a + M.w) - nextX) * 0.8, { kind: 'unit' }, { gap: 3 });
        if (!it) break;
        nextX = dir > 0 ? it.x1 + 3 : it.x0 - 3;
        if (R() < 0.8) duct(it);
      }
    };
    const yardRot = R() < 0.7 ? 0 : 1;
    const rtu = (k) => {
      const len = pick(R, [12, 14, 16, 18]), dep = pick(R, [7, 8, 9]), hh = pick(R, [6, 7, 8]);
      return rtuModel(len, dep, hh, unitMat, len >= 16 ? 2 : 1, yardRot);
    };
    if (style === 'office') {
      if (ia > 4500 && R() < 0.6) placeAt(coolingTowerModel(pick(R, [14, 16]), ia > 9000 ? 2 : 1, pick(R, [BM.METAL, BM.TRIM, BM.PRECAST])), (a, b) => -(Math.abs(a - cx)) * 0.5 + Math.abs(b - back) * 0.6, { kind: 'ct' }, { gap: 3 });
      if (ia > 2600 && R() < 0.5) { const it = placeAt(ahuModel(pick(R, [20, 24]), pick(R, [10, 12]), 9, unitMat, 0), nearCore(24, 12), { kind: 'unit' }, { gap: 3 }); if (it) duct(it); }
      const n = clamp(Math.round(ia / 1500 + R()), 1, 8);
      if (ia > 4000) { units(Math.ceil(n * 0.6), rtu); units(Math.floor(n * 0.4), rtu, D * (0.3 + R() * 0.15), bx0 + R() * iw * 0.3); }
      else units(n, rtu);
    } else if (style === 'industrial') {
      if (ia > 3000 && R() < 0.4) placeAt(coolingTowerModel(14, 1, BM.METAL), nearCore(14, 14), { kind: 'ct' }, { gap: 3 });
      units(clamp(Math.round(ia / 2500 + R()), 1, 3), rtu);
    } else if (style === 'historic') {
      if (ia > 700 && R() < (ia > 1800 ? 0.85 : 0.5)) units(clamp(Math.round(ia / 1700 + R() * 0.6), 1, 5), rtu);
      if (ia > 2500 && R() < 0.5) units(clamp(Math.round(ia / 2500), 1, 3), () => condRowModel(2 + Math.floor(R() * 2), unitMat, yardRot), D * (0.3 + R() * 0.2), bx0 + R() * iw * 0.4);
    } else {
      if (R() < 0.7) {
        const n = clamp(Math.round(ia / 750 + R()), 1, Math.floor((iw - 1) / 6) * 3);
        if (n >= 1) units(Math.max(1, Math.ceil(n / 3)), () => condRowModel(clamp(n, 1, Math.min(3, Math.floor((iw - 1) / 6))), unitMat, yardRot));
      }
    }
    // ---- 4. the street side: billboard, garden, solar, skylights, greenhouse
    const front = (w) => (a, b) => b * 1.5 + Math.abs(a + w / 2 - cx) * 0.3;
    if ((style === 'office' || style === 'historic') && iw >= 26 && floors <= 12 && R() < 0.2) {
      const len = clamp(2 * Math.floor((iw - 4) * (0.6 + R() * 0.3) / 2), 18, 40), ph = pick(R, [10, 12, 14]), yb = pick(R, [6, 8, 10]);
      const design = (R() * 1e6) | 0;
      placeAt(billboardModel(len, ph, yb, design), (a, b) => b * 3 + Math.abs(a + len / 2 - cx), { kind: 'billboard' }, { edge: 2, gap: 2 });
    }
    const gardenP = { residential: 0.32, office: 0.12, historic: 0.08, industrial: 0.05 }[style];
    if (R() < gardenP) {
      for (let tries = 0; tries < 4; ++tries) {
        const w = 2 * Math.floor(clamp(iw - 2 * tries * 3, 14, 40) / 2), d = clamp(Math.floor(id * 0.45) - tries * 3, 14, 32);
        if (w > iw || d > id) continue;
        const M = gardenModel(w, d, (R() * 50) | 0, 0);
        if (placeAt(M, style === 'residential' ? front(w) : nearCore(w, d), { kind: 'garden' }, { gap: 3 })) break;
      }
    }
    if (style === 'residential' && ia > 1200 && R() < 0.12) placeAt(greenhouseModel(pick(R, [12, 16]), pick(R, [10, 12]), pick(R, [BM.TRIM, BM.STEEL_DARK]), R() < 0.5 ? 0 : 1), front(14), { kind: 'gh' }, { gap: 3 });
    const solarP = { office: 0.25, residential: 0.18, industrial: 0.3, historic: 0.05 }[style];
    if (R() < solarP && iw >= 18 && id >= 14) {
      const glass = R() < 0.6 ? BM.GLASS_DARK : BM.GLASS_BLUE;
      for (let tries = 0; tries < 4; ++tries) {
        const len = clamp(Math.floor(iw * (0.8 - tries * 0.15)), 12, 48), rows = clamp(Math.floor(id / 24) + 2 - tries, 1, 5);
        if (placeAt(solarModel(len, rows, glass), front(len), { kind: 'solar' }, { gap: 3 })) break;
      }
    }
    const skyP = { industrial: 0.85, historic: 0.5, residential: 0.15, office: 0.12 }[style];
    if (R() < skyP) {
      const lit = R() < 0.35;
      if (style === 'industrial' && ia > 1800 && R() < 0.6) {
        for (let tries = 0; tries < 3; ++tries) {
          const len = clamp(Math.floor(iw * (0.7 - tries * 0.15)), 12, 60), n = clamp(Math.floor(id / 20) - tries, 1, 6);
          if (placeAt(sawtoothModel(len, n, lit), (a, b) => b * 0.5 + Math.abs(a + len / 2 - cx), { kind: 'saw' }, { gap: 3 })) break;
        }
      } else {
        const n = clamp(Math.round(ia / 1500 + R()), 1, 4), rot = R() < 0.5 ? 0 : 1;
        const sw = pick(R, [10, 12, 14, 16]), sd = pick(R, [6, 8]);
        for (let k = 0; k < n; ++k) placeAt(skylightModel(sw, sd, lit, rot), (a, b) => Math.abs(b - D * 0.4) + Math.abs(a + 6 - cx) * 0.5, { kind: 'sky' }, { gap: 3 });
      }
    }
    if (style === 'industrial' && R() < 0.6 && iw >= 24) {
      const len = clamp(Math.floor(iw * 0.7), 16, 60);
      placeAt(pipeRackModel(len, 0), (a, b) => Math.abs(b - D * 0.7), { kind: 'pipes' }, { gap: 2 });
    }
    // ---- 5. chimneys (historic / brick rows) on the side walls
    const chimP = { historic: 0.75, residential: brickish ? 0.55 : 0.2, industrial: 0.25, office: 0 }[style];
    if (R() < chimP) {
      const n = clamp(Math.round(id / 30 + R()), 1, 3), mat = style === 'industrial' ? BM.BRICK_DARK : pick(R, [BM.BRICK_RED, BM.BRICK_DARK, BM.BRICK_BROWN, wallMat]);
      for (let k = 0; k < n; ++k) {
        const cw = pick(R, [3, 4]), cd = pick(R, [4, 5, 6]), chh = (style === 'industrial' ? 16 : 7) + Math.floor(R() * 6);
        const M = chimneyModel(cw, cd, chh, mat, pick(R, [BM.LIMESTONE_DARK, BM.CONCRETE]), style === 'industrial' ? 0 : 1 + Math.floor(R() * 3));
        const side = R() < 0.5, tz = D * (0.25 + 0.6 * (k + R() * 0.6) / n);
        placeAt(M, (a, b) => (side ? a : W - a - M.w) * 4 + Math.abs(b - tz), { kind: 'chim' }, { edge: 1, gap: 2 });
      }
    }
    // ---- 6. antennas and dishes
    if (style === 'office' && floors >= 8 && ia > 1500 && R() < 0.3) placeAt(cellSiteModel(16 + 2 * Math.floor(R() * 4)), (a, b) => Math.abs(b - back) + Math.abs(a - (core && core.x0 > cx ? bx0 : bx1)), { kind: 'cell' });
    if ((style === 'office' || style === 'industrial') && ia > 1200 && R() < 0.12) placeAt(mastModel(26 + 4 * Math.floor(R() * 4)), (a, b) => Math.abs(b - back) * 0.5 + Math.abs(a - bx0), { kind: 'mast' });
    const dishP = { residential: 0.5, office: 0.35, historic: 0.3, industrial: 0.2 }[style];
    if (R() < dishP) {
      const n = 1 + (ia > 1500 && R() < 0.4 ? 1 : 0), dm = R() < 0.6 ? BM.TRIM : BM.METAL;
      for (let k = 0; k < n; ++k) { const r = R() < 0.7 ? 2 : 3; placeAt(dishModel(r, dm, R() < 0.5 ? 0 : (R() < 0.5 ? 1 : 3)), nearCore(2 * r + 3, 2 * r + 3), { kind: 'dish' }, { gap: 2, jitter: 12 }); }
    }
    if (style !== 'residential' && ia > 1600 && R() < 0.35) placeAt(smallModel('riser', BM.METAL), (a, b) => Math.abs(b + 6 - back) + Math.abs(a - bx1) * 0.3, { kind: 'riser' });
    // ---- 7. small penetrations spread over what's left: vents, exhaust fans, cabinets
    const smalls = style === 'industrial' ? ['upblast', 'turbine', 'mushroom', 'upblast', 'stacks']
      : style === 'residential' ? ['stacks', 'goose', 'mushroom', 'turbine'] : style === 'historic' ? ['mushroom', 'stacks', 'goose', 'turbine', 'upblast'] : ['upblast', 'mushroom', 'goose', 'upblast', 'stacks'];
    // vents and exhaust fans sit over the plumbing / toilet shafts: a line or two across the roof at even spacing
    const nSmall = clamp(Math.round(ia / (style === 'industrial' ? 550 : 750) + R() * 1.5), 1, 14);
    const lines = clamp(Math.round(nSmall / 3), 1, 3);
    let left = nSmall;
    for (let l = 0; l < lines && left > 0; ++l) {
      const per = Math.min(left, 2 + Math.floor(R() * 3)); left -= per;
      const tz = bz0 + id * (l + 0.2 + R() * 0.6) / lines, kind = pick(R, smalls), sp = 8 + Math.floor(R() * 8);
      const mat = pick(R, [BM.METAL, BM.METAL, BM.STEEL_DARK, BM.TRIM_DARK]);
      const M = smallModel(kind, mat), sx = bx0 + R() * Math.max(1, iw - per * sp);
      for (let k = 0; k < per; ++k) {
        const tx = sx + k * sp;
        placeAt(M, (a, b) => Math.abs(a + M.w / 2 - tx) + Math.abs(b + M.d / 2 - tz) * 2, { kind: 'small' }, { gap: 2, jitter: 0.5 });
      }
    }
    // an electrical cabinet or two by the core
    if (core && style !== 'residential' && R() < 0.6) placeAt(smallModel('cabinet', pick(R, [BM.METAL, BM.TRIM, BM.STEEL_DARK])), nearCore(4, 3), { kind: 'small' }, { gap: 2 });
  }

  L.roofKit = roofKit;
  L.waterTankImpl = waterTankImpl;
  L.roofKitModels = { tankModel, tankDesign, bulkheadModel, hatchModel, doorFrontModel, rtuModel, condRowModel, coolingTowerModel, ahuModel, ductModel, pipeRackModel,
    smallModel, skylightModel, sawtoothModel, dishModel, cellSiteModel, mastModel, solarModel, gardenModel, greenhouseModel, chimneyModel, billboardModel };
})();
