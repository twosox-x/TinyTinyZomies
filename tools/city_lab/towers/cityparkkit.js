// City park kit: furniture, trees and planting of the open city blocks of generateCity's 'park' areas (the
// neighbourhood parks and school grounds), on the layout of city_core parkLayouts (themes 'formal', 'woodland',
// 'sports'; the ground itself - lawn patches, paths, plazas, pond, pitch, court, mounds - is the road raster's,
// parkGround). Called from CityArch planAll after parkKit, into the same kit mesh:
//   CityArch.lib.cityParkKit({ PL, C, mb, hs, voxel, rect }) -> { parks: [...], stats }
// Determinism: everything is derived from the net alone (layout, a private raster of the park's own window cached on
// the layout, a per-park random stream and per-park sink slots), so every streaming page that sees a park emits it
// identically and keeps the quads it owns. Placement only on park ground of the private raster: lawn for trees,
// bushes and most furniture (sampled over the footprint at 0.5 m), plaza / court / pitch for the pieces that belong
// there; nothing on a path, the sidewalk or the street. Models are the park kit's (parkkit.js L.parkParts), sunk a
// few millimetres per copy like there (no shared planes with the ground or each other).
(function () {
'use strict';
const A = self.CityArch, L = A.lib;
const LAWN = new Set([14, 10, 155]), PLAZA = new Set([12, 13, 141]), COURT = new Set([65, 127, 64]), SIDEWALK = new Set([6, 7, 8]);
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const GC = 0.5;                                          // private raster cell (m)

function cityParkKit(K0) {
  const { PL, C, mb, hs, voxel } = K0, rect = K0.rect || null, P = L.parkParts;
  if (!P || !C.parkLayouts || !PL || !PL.net || PL.net.kind !== 'city') return null;
  const net = PL.net, t0 = Date.now(), q0 = mb.quads;
  const stats = { parks: 0, trees: 0, bushes: 0, items: 0, quads: 0, ms: 0 }, parks = [];
  for (const Lp of C.parkLayouts(net)) {
    if (rect && (Lp.bb[2] < rect[0] - 4 || Lp.bb[0] > rect[2] + 4 || Lp.bb[3] < rect[1] - 4 || Lp.bb[1] > rect[3] + 4)) continue;
    const info = buildPark(Lp);
    parks.push(info); stats.parks++; stats.trees += info.trees; stats.bushes += info.bushes; stats.items += info.items;
  }
  stats.quads = mb.quads - q0; stats.ms = Date.now() - t0;
  return { parks, stats };

  // ------------------------------------------------------------------------------------------------ one park
  function buildPark(Lp) {
    const G = grid(Lp), R = C.mulberry32((Lp.seed ^ 0x5eed) >>> 0), info = { idx: Lp.idx, name: Lp.name, theme: Lp.theme, trees: 0, bushes: 0, items: 0 };
    const occ = [], slots = new Map(); slots.maxR = 0;
    const W = (s, t) => [Lp.c[0] + s * Lp.u[0] + t * Lp.v[0], Lp.c[1] + s * Lp.u[1] + t * Lp.v[1]];
    const D = (ds, dt) => [ds * Lp.u[0] + dt * Lp.v[0], ds * Lp.u[1] + dt * Lp.v[1]];
    const yawOf = (ds, dt) => { const d = D(ds, dt); return P.faceYaw(d[0], d[1]); };      // model +z towards local (ds, dt)
    const alongYaw = (ds, dt) => { const d = D(ds, dt); return Math.atan2(d[1], d[0]); };  // model +x along local (ds, dt)
    const local = (x, z) => { const dx = x - Lp.c[0], dz = z - Lp.c[1]; return [dx * Lp.u[0] + dz * Lp.u[1], dx * Lp.v[0] + dz * Lp.v[1]]; };
    const inRect = (x, z, m) => { const [s, t] = local(x, z); return Lp.rects.some(g => Math.abs(s - g.c[0]) < g.hu + m && Math.abs(t - g.c[1]) < g.hv + m); };

    // ---- emission (as parkKit: mesh in PV units, rigid yaw, faces resting on the ground skipped)
    const quadW = (X, Y, Z, m, Nx, Ny, Nz) => {
      const v = voxel, p = [0, 1, 2, 3].map(i => [X[i] / v, (hs + Y[i]) / v, Z[i] / v]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2], vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * Nx + cy * Ny + cz * Nz < 0) mb.quadN(...p[0], ...p[3], ...p[2], ...p[1], m, Nx, Ny, Nz);
      else mb.quadN(...p[0], ...p[1], ...p[2], ...p[3], m, Nx, Ny, Nz);
    };
    const put = (m, x, y, z, yaw, sh, sv) => {
      const c = Math.cos(yaw), s = Math.sin(yaw), Pp = m.pos, fh = sh / C.PV, fv = (sv || sh) / C.PV;
      if (L.debugPlace) L.debugPlace({ kit: 'citypark', mesh: m, map: (u, yy, v) => [x + (u * c - v * s) * fh, hs + y + yy * fv, z + (u * s + v * c) * fh] });
      const X = new Float64Array(4), Y = new Float64Array(4), Z = new Float64Array(4);
      for (let q = 0; q < m.quads; ++q) {
        const n = m.nrm[q * 4], o = q * 12;
        if (n === 5 && Pp[o + 1] === 0 && Pp[o + 4] === 0 && Pp[o + 7] === 0 && Pp[o + 10] === 0) continue;
        for (let i = 0; i < 4; ++i) { const u = Pp[o + i * 3] * fh, v = Pp[o + i * 3 + 2] * fh; X[i] = x + u * c - v * s; Y[i] = y + Pp[o + i * 3 + 1] * fv; Z[i] = z + u * s + v * c; }
        const N = NV[n];
        quadW(X, Y, Z, m.mat[q * 4], N[0] * c - N[2] * s, N[1], N[0] * s + N[2] * c);
      }
    };
    // vertical offset of a copy (<= 0, sunk): a slot no overlapping copy of this park uses (parkKit sink, per park)
    const sink = (x, z, r) => {
      const taken = new Set(), gx = Math.floor(x / 16), gz = Math.floor(z / 16), e = Math.ceil((r + slots.maxR + 0.3) / 16);
      for (let dz = -e; dz <= e; ++dz) for (let dx = -e; dx <= e; ++dx) for (const o of slots.get((gx + dx) + ',' + (gz + dz)) || [])
        if (Math.abs(o[0] - x) < r + o[2] + 0.3 && Math.abs(o[1] - z) < r + o[2] + 0.3) taken.add(o[3]);
      const si = L.sinkPick(P.SLOTS, taken, Math.floor(R() * P.SLOTS.length)), key = gx + ',' + gz;
      let a = slots.get(key); if (!a) slots.set(key, a = []);
      a.push([x, z, r, si]); slots.maxR = Math.max(slots.maxR, r);
      return -P.SLOTS[si];
    };

    // ---- ground queries on the private raster
    const at = (x, z) => G.at(x, z);                    // [mat, height m] or null
    const okAll = (x, z, r, ok) => {
      const c = at(x, z); if (!c || !ok(c[0])) return null;
      for (let k = 0; k < 8; ++k) for (const f of [0.5, 1]) {
        const a = k * Math.PI / 4, g = at(x + Math.cos(a) * r * f, z + Math.sin(a) * r * f);
        if (!g || !ok(g[0]) || Math.abs(g[1] - c[1]) > 0.01) return null;
      }
      return c;
    };
    const free = (x, z, r, tallOnly) => occ.every(o => Math.hypot(o[0] - x, o[1] - z) >= o[2] + r && (!tallOnly || true));
    const rectOK = (x, z, yaw, f, mg, ok) => {
      const c = Math.cos(yaw), s = Math.sin(yaw), c0 = at(x, z); if (!c0) return null;
      for (let u = f[0] - mg; u <= f[2] + mg + 1e-6; u += Math.min(0.4, (f[2] - f[0] + 2 * mg) / 2)) for (let v = f[1] - mg; v <= f[3] + mg + 1e-6; v += Math.min(0.4, (f[3] - f[1] + 2 * mg) / 2)) {
        const g = at(x + u * c - v * s, z + u * s + v * c);
        if (!g || !ok(g[0]) || Math.abs(g[1] - c0[1]) > 0.01) return null;
      }
      return c0;
    };
    const item = (name, vr, x, z, yaw, o) => {
      o = o || {};
      const it = P.itemModel(C, name, vr), f = it.fp, r = Math.max(-f[0], f[2], -f[1], f[3]);
      const g = rectOK(x, z, yaw, f, o.mg === undefined ? 0.25 : o.mg, o.ok || ((m) => LAWN.has(m)));
      if (!g || !free(x, z, r + (o.gap || 0.2))) return false;
      occ.push([x, z, r, o.tall ? 1 : 0]);
      put(it.mesh, x, g[1] + (o.dy || 0) + sink(x, z, r), z, yaw, it.sc, it.sc);
      info.items++;
      return true;
    };
    const trees = [];
    const tree = (x, z, spList, dens, o) => {
      o = o || {};
      const g = okAll(x, z, 0.9, (m) => LAWN.has(m));
      if (!g || (!o.inRects && inRect(x, z, 2.5))) return false;
      for (const sp of spList) for (let k = 0; k < 2; ++k) {
        const T = P.treeModel(C, sp, Math.floor(R() * 4)), rc = T.rc;
        if (trees.some(t => Math.hypot(t[0] - x, t[1] - z) < Math.max(1.6, dens * (t[2] + rc)))) continue;
        if (!occ.every(q => Math.hypot(q[0] - x, q[1] - z) >= q[2] + (T.base < 2.6 || q[3] ? rc : 0.9))) continue;
        // the crown stays over the park (a high crown may reach over the sidewalk)
        let ok = true;
        for (let a = 0; a < 8 && ok; ++a) {
          const px = x + Math.cos(a * Math.PI / 4) * rc * 0.92, pz = z + Math.sin(a * Math.PI / 4) * rc * 0.92, c = at(px, pz);
          if (!c) { ok = false; break; }
          if (C.PARK_GROUND.has(c[0])) { if (c[0] === 206 && T.base < 2.6) ok = false; continue; }
          if (!(T.base >= 3.5 && SIDEWALK.has(c[0]))) ok = false;
        }
        if (!ok) continue;
        trees.push([x, z, rc]);
        put(T.mesh, x, g[1] + sink(x, z, rc), z, R() * 6.283, P.BV, P.BV);
        info.trees++;
        return true;
      }
      return false;
    };
    const bushes = [];
    const bush = (x, z, kinds, o) => {
      o = o || {};
      const kind = P.pick(R, kinds), Bm = P.bushModel(C, kind, Math.floor(R() * 5)), r = Bm.r;
      const g = okAll(x, z, r + 0.15, (m) => LAWN.has(m));
      if (!g || (!o.inRects && inRect(x, z, 1.5))) return false;
      if (bushes.some(b => Math.hypot(b[0] - x, b[1] - z) < (o.dens || 0.85) * (b[2] + r))) return false;
      if (trees.some(t => Math.hypot(t[0] - x, t[1] - z) < r + 0.5)) return false;
      if (!free(x, z, r + 0.15)) return false;
      bushes.push([x, z, r]);
      put(Bm.mesh, x, g[1] + sink(x, z, r), z, R() * 6.283, 0.125, 0.125);
      info.bushes++;
      return true;
    };
    // jittered candidate points over the park land, shuffled
    const cands = (step, filter) => {
      const out = [];
      for (let z = G.z0; z < G.z1; z += step) for (let x = G.x0; x < G.x1; x += step) {
        const px = x + (R() - 0.5) * step * 0.9, pz = z + (R() - 0.5) * step * 0.9, c = at(px, pz);
        if (!c || !LAWN.has(c[0])) continue;
        if (filter && !filter(px, pz)) continue;
        out.push([px, pz, R()]);
      }
      return out.sort((a, b) => a[2] - b[2]);
    };
    // furniture along the paths: benches facing the path, lamps, bins
    const pathFurniture = (step, lampEvery, rings) => {
      let k = 0;
      const along = (p, dir, hw) => {                    // p, dir: local; one stop
        const side = (k & 1) ? 1 : -1, n = [-dir[1] * side, dir[0] * side];
        const lamp = lampEvery && k % lampEvery === lampEvery - 1;
        const off = hw + (lamp ? 0.55 : 0.95), q = W(p[0] + n[0] * off, p[1] + n[1] * off);
        if (lamp) item('lamp', 0, q[0], q[1], 0, { mg: 0.15, gap: 0.3, tall: 1 });
        else if (item('bench', Math.floor(R() * 3), q[0], q[1], yawOf(-n[0], -n[1]), { mg: 0.1, gap: 0.3 }) && R() < 0.35) {
          const b = W(p[0] + n[0] * off + dir[0] * 1.5, p[1] + n[1] * off + dir[1] * 1.5); item('bin', 0, b[0], b[1], 0, { mg: 0.1 });
        }
        ++k;
      };
      for (const g of Lp.segs) {
        const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1], l = Math.hypot(dx, dz);
        if (l < 2) continue;
        for (let t = (k % 3) * 1.3 + 2; t < l - 1; t += step) along([g.a[0] + dx * t / l, g.a[1] + dz * t / l], [dx / l, dz / l], g.hw);
      }
      if (rings) for (const r of Lp.rings) {
        const per = 2 * Math.PI * Math.sqrt((r.rx * r.rx + r.ry * r.ry) / 2), n = Math.max(4, Math.round(per / step));
        for (let i = 0; i < n; ++i) {
          const a = (i + 0.5) * 2 * Math.PI / n, p = [r.c[0] + Math.cos(a) * r.rx, r.c[1] + Math.sin(a) * r.ry];
          const tng = [-Math.sin(a) * r.rx, Math.cos(a) * r.ry], tl = Math.hypot(tng[0], tng[1]);
          along(p, [tng[0] / tl, tng[1] / tl], r.hw);
        }
      }
    };
    // trees along the park edge (the band between the walks and the sidewalk)
    const edgeTrees = (species, step) => {
      for (const [x, z] of cands(step, (x, z) => { const d = G.dEdge(x, z); return d >= 1.8 && d <= 5.5; })) tree(x, z, [P.pick(R, species), 'street'], 1.0);
    };

    const m = Math.min(Lp.hu, Lp.hv);
    if (Lp.theme === 'formal') {
      const F = Lp.feats.find(f => f.t === 'fountain'), rp = F.r, ring = Lp.rings[0].rx;
      const onPlaza = (mm) => PLAZA.has(mm);
      { const c = W(0, 0); item('bigfountain', Math.floor(R() * 3), c[0], c[1], alongYaw(1, 0), { ok: onPlaza, mg: 0.2, tall: 1 }); }
      for (let i = 0; i < 8; ++i) {                      // benches round the basin, facing it
        const a = (i + 0.5) * Math.PI / 4, rr = rp - 1.35, p = W(Math.cos(a) * rr, Math.sin(a) * rr);
        item('bench', 1, p[0], p[1], yawOf(-Math.cos(a), -Math.sin(a)), { ok: onPlaza, mg: 0.05, gap: 0.1 });
      }
      for (let i = 0; i < 4; ++i) { const a = i * Math.PI / 2 + Math.PI / 4, rr = rp - 0.6, p = W(Math.cos(a) * rr, Math.sin(a) * rr); item('lamp', 0, p[0], p[1], 0, { ok: onPlaza, mg: 0.05, gap: 0.05, tall: 1 }); }
      // clipped hedges lining the four axes between the plaza and the ring walk
      for (const [ds, dt] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const sd of [-1, 1]) {
        for (let r = rp + 2.2; r < ring - 2.4; r += 2.65) {
          const off = 1.6 + 0.75, p = W(ds * r - dt * sd * off, dt * r + ds * sd * off);
          item('hedge', (Lp.idx + sd + 1) % 3, p[0], p[1], alongYaw(ds, dt), { mg: 0.05, gap: -0.05 });
        }
        // allee outside the ring
        const lim = (ds ? Lp.hu : Lp.hv) + 4;
        for (let r = ring + 4; r < lim; r += 7.5) { const p = W(ds * r - dt * sd * 4.2, dt * r + ds * sd * 4.2); tree(p[0], p[1], ['tulip', 'street'], 0.7); }
        for (let r = ring + 7; r < lim; r += 15) { const p = W(ds * r - dt * sd * 2.25, dt * r + ds * sd * 2.25); item('lamp', 0, p[0], p[1], 0, { mg: 0.1, tall: 1 }); }
      }
      // parterres: a flower bed edged with box in each quadrant inside the ring
      for (let i = 0; i < 4; ++i) {
        const a = i * Math.PI / 2 + Math.PI / 4, rr = (rp + ring) / 2, c = [Math.cos(a) * rr, Math.sin(a) * rr], wc = W(c[0], c[1]);
        bush(wc[0], wc[1], ['flowers'], { dens: 0.5 });
        for (let k = 0; k < 6; ++k) { const b = k * Math.PI / 3, p = W(c[0] + Math.cos(b) * 2.0, c[1] + Math.sin(b) * 2.0); bush(p[0], p[1], ['flowers', 'bed'], { dens: 0.5 }); }
        for (let k = 0; k < 10; ++k) { const b = k * Math.PI / 5, p = W(c[0] + Math.cos(b) * 3.4, c[1] + Math.sin(b) * 3.4); bush(p[0], p[1], ['box'], { dens: 0.55 }); }
      }
      pathFurniture(9, 3, true);
      // statues on the side rondels
      for (const d of Lp.discs) if (d.rondel) { const p = W(d.c[0], d.c[1]); item('obelisk', Lp.idx % 3, p[0], p[1], alongYaw(1, 0), { ok: onPlaza, mg: 0.1, tall: 1 }); }
      // a low wall along the park rectangle, open where the walks cross it
      for (const [s0, t0, s1, t1] of [[-Lp.hu, -Lp.hv, Lp.hu, -Lp.hv], [Lp.hu, -Lp.hv, Lp.hu, Lp.hv], [Lp.hu, Lp.hv, -Lp.hu, Lp.hv], [-Lp.hu, Lp.hv, -Lp.hu, -Lp.hv]]) {
        const l = Math.hypot(s1 - s0, t1 - t0), ds = (s1 - s0) / l, dt = (t1 - t0) / l;
        for (let t = 1.5; t < l - 1.5; t += 2.65) { const p = W(s0 + ds * t, t0 + dt * t); if (G.dEdge(p[0], p[1]) > 7) continue; item('lowwall', Lp.idx % 3, p[0], p[1], alongYaw(ds, dt), { mg: 0.05, gap: -0.1 }); }
      }
      edgeTrees(['maple', 'oak', 'red'], 6);
      // corner groves and shade trees
      for (const [x, z] of cands(4.2, (x, z) => { const [s, t] = local(x, z); return Math.hypot(s, t) > ring + 3 && Math.min(Math.abs(s), Math.abs(t)) > 6.5; })) tree(x, z, [P.pick(R, ['oak', 'maple', 'red', 'spruce'])], 0.72);
      for (const [x, z] of cands(2.4, (x, z) => { const [s, t] = local(x, z); return Math.hypot(s, t) > ring + 2.5 && G.dEdge(x, z) > 2.5; }).slice(0, 40)) bush(x, z, ['shrub', 'mound', 'flowers'], { dens: 1.1 });
    } else if (Lp.theme === 'woodland') {
      const Pd = Lp.feats.find(f => f.t === 'pond'), gz = Lp.feats.find(f => f.t === 'gazebo'), pic = Lp.feats.find(f => f.t === 'picnic');
      const any = (mm) => C.PARK_GROUND.has(mm) && mm !== 206;
      if (gz) { const p = W(gz.c[0], gz.c[1]); const it = P.itemModel(C, 'gazebo', Lp.idx % 3); const g = at(p[0], p[1]);
        if (g) { occ.push([p[0], p[1], 3.0, 1]); put(it.mesh, p[0], g[1] + sink(p[0], p[1], 3), p[1], alongYaw(1, 0), 0.25, 0.25); info.items++; } }
      // shore: reeds and boulders round the water, benches outside the loop facing the pond, lamps on the loop
      const er = (k, add) => { const a = k; return [Pd.c[0] + Math.cos(a) * (Pd.rx + add), Pd.c[1] + Math.sin(a) * (Pd.ry + add)]; };
      for (let i = 0; i < 14; ++i) { const a = i * 2 * Math.PI / 14 + R() * 0.3, q = er(a, 0.55 + R() * 0.4), p = W(q[0], q[1]); item(i % 4 === 1 ? 'rocks' : 'reeds', i, p[0], p[1], R() * 6.28, { ok: any, mg: -0.3, gap: 0 }); }
      for (let i = 0; i < 7; ++i) { const a = (i + 0.3) * 2 * Math.PI / 7, q = er(a, Pd.lr + 1.75), p = W(q[0], q[1]); item('bench', 0, p[0], p[1], yawOf(-Math.cos(a) * Pd.ry, -Math.sin(a) * Pd.rx), { mg: 0.05 }); }
      for (let i = 0; i < 4; ++i) { const a = (i + 0.8) * Math.PI / 2, q = er(a, Pd.lr - 1.4), p = W(q[0], q[1]); item('lamp', 0, p[0], p[1], 0, { mg: 0.1, tall: 1 }); }
      // shore planting inside the loop
      for (let i = 0; i < 12; ++i) { const a = R() * 6.283, q = er(a, 1.6 + R() * 1.4), p = W(q[0], q[1]); bush(p[0], p[1], ['mound', 'shrub', 'flowers'], { dens: 0.8 }); }
      // picnic lawn
      const pc = W(pic.c[0], pic.c[1]);
      for (let i = 0; i < 4; ++i) { const a = i * 1.7 + R(), p = [pc[0] + Math.cos(a) * (2.6 + i * 1.3), pc[1] + Math.sin(a) * (2.6 + i * 1.3)]; item('picnic', i % 3, p[0], p[1], R() * 3.14, { gap: 0.6 }); }
      item('bin', 0, pc[0] + 1.2, pc[1] - 0.8, 0);
      pathFurniture(11, 3, false);
      // groves: big trees on the mounds and round the edges, a meadow round the picnic tables and the pond loop
      const meadow = (x, z) => { const [s, t] = local(x, z); return Math.hypot(s - pic.c[0], t - pic.c[1]) < Math.max(7.5, m * 0.28) || Math.hypot((s - Pd.c[0]) / (Pd.rx + Pd.lr + 2.5), (t - Pd.c[1]) / (Pd.ry + Pd.lr + 2.5)) < 1; };
      edgeTrees(['oak', 'maple', 'tulip'], 5.5);
      for (const [x, z] of cands(3.0, (x, z) => !meadow(x, z))) tree(x, z, [P.pick(R, ['oak', 'maple', 'spruce', 'pine', 'tulip', 'red', 'oak'])], 0.62);
      for (const [x, z] of cands(3.4, (x, z) => !meadow(x, z))) tree(x, z, ['young', 'spruce'], 0.6);
      for (const [x, z] of cands(2.4, (x, z) => !meadow(x, z))) bush(x, z, ['shrub', 'mound', 'shrub', 'flowers'], { dens: 0.9 });
      for (const [x, z] of cands(4, (x, z) => meadow(x, z) && G.dEdge(x, z) > 3).slice(0, 4)) tree(x, z, ['young', 'red'], 1.0);
    } else {
      const pitch = Lp.feats.find(f => f.t === 'pitch'), court = Lp.feats.find(f => f.t === 'court'), play = Lp.feats.find(f => f.t === 'playground');
      const anyG = (mm) => C.PARK_GROUND.has(mm) && mm !== 206;
      if (pitch) {
        for (const sd of [-1, 1]) {                       // goals on the goal lines, mouths towards the centre
          const p = W(pitch.c[0] + sd * (pitch.hu - 1.5 + 0.08), pitch.c[1]);
          item('goal', 0, p[0], p[1], yawOf(-sd, 0), { ok: anyG, mg: 0.0, gap: 0, tall: 1 });
        }
        for (const sd of [-1, 1]) {                       // bleachers along a touchline, if there is lawn
          const p = W(pitch.c[0] + 4 * sd, pitch.c[1] - (pitch.hv + 1.7));
          item('bleacher', Lp.idx % 3, p[0], p[1], yawOf(0, 1), { mg: 0.1, gap: 0.2, tall: 1 });
        }
      }
      if (court) {
        const along = court.across ? [0, 1] : [1, 0], hx = (court.across ? court.hv : court.hu) - 1.1;
        for (const sd of (court.kind === 'half' ? [-1] : [-1, 1])) {
          const p = W(court.c[0] + along[0] * sd * (hx - 0.05), court.c[1] + along[1] * sd * (hx - 0.05));
          item('hoop', 0, p[0], p[1], yawOf(-along[0] * sd, -along[1] * sd), { ok: (mm) => COURT.has(mm), mg: 0.0, gap: 0, tall: 1 });
        }
        for (const sd of [-1, 1]) { const ac = [-along[1], along[0]], hy = (court.across ? court.hu : court.hv) + 0.9, p = W(court.c[0] + ac[0] * sd * hy, court.c[1] + ac[1] * sd * hy);
          item('bench', 2, p[0], p[1], yawOf(-ac[0] * sd, -ac[1] * sd), { mg: 0.05 }); }
      }
      if (play) {
        const p = W(play.c[0], play.c[1]);
        item('playground', Lp.idx % 3, p[0], p[1], alongYaw(1, 0), { ok: (mm) => mm === 140 || mm === 70, mg: -0.4, gap: 0, tall: 1 });
        for (const sd of [-1, 1]) { const q = W(play.c[0] + sd * (play.r + 1.2), play.c[1]); item('bench', 0, q[0], q[1], yawOf(-sd, 0), { mg: 0.05 }); }
      }
      pathFurniture(10, 3, false);
      edgeTrees(['maple', 'oak', 'street', 'tulip'], 6.5);
      for (const [x, z] of cands(6, (x, z) => G.dEdge(x, z) > 3 && !inRect(x, z, 4))) tree(x, z, [P.pick(R, ['oak', 'maple', 'red'])], 1.0);
      for (const [x, z] of cands(2.6, (x, z) => { const d = G.dEdge(x, z); return d > 1.2 && d < 3.2; }).slice(0, 30)) bush(x, z, ['shrub', 'box', 'mound'], { dens: 1.0 });
    }
    info.ms = 0;
    return info;
  }

  // ---- the park's private raster (cached on the layout: the same for every page)
  function grid(Lp) {
    if (Lp._grid) return Lp._grid;
    const [x0, z0, x1, z1] = Lp.bb;
    const F = new C.FieldSampler(net, 0.5, [x0 - 12, z0 - 12, x1 + 12, z1 + 12]); F.build(null, true);
    const Rr = new C.Rasterizer(net, F, voxel); Rr.blockAreas();
    const nx = Math.ceil((x1 - x0) / GC), nz = Math.ceil((z1 - z0) / GC), mat = new Int16Array(nx * nz), h = new Float32Array(nx * nz);
    const o = {}, cls = [0, 0];
    let gx0 = 1e9, gz0 = 1e9, gx1 = -1e9, gz1 = -1e9;
    for (let j = 0; j < nz; ++j) for (let i = 0; i < nx; ++i) {
      const x = x0 + (i + 0.5) * GC, z = z0 + (j + 0.5) * GC;
      Rr.classify(x, z, o, cls);
      mat[j * nx + i] = C.PARK_GROUND.has(cls[1]) && !C.parkUnitHas(Lp, x, z) ? 0 : cls[1]; h[j * nx + i] = (cls[0] - Rr.hs) * voxel;   // another park unit: not ours
      if (C.PARK_GROUND.has(mat[j * nx + i])) { gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gz0 = Math.min(gz0, z); gz1 = Math.max(gz1, z); }
    }
    // distance (m) to the nearest cell that is not park ground
    const D = new Float32Array(nx * nz);
    for (let k = 0; k < nx * nz; ++k) D[k] = C.PARK_GROUND.has(mat[k]) ? 1e9 : 0;
    const rel = (k, r, w) => { if (D[r] + w < D[k]) D[k] = D[r] + w; }, a = GC, b = GC * Math.SQRT2;
    for (let j = 0; j < nz; ++j) for (let i = 0; i < nx; ++i) { const k = j * nx + i; if (i) rel(k, k - 1, a); if (j) { rel(k, k - nx, a); if (i) rel(k, k - nx - 1, b); if (i < nx - 1) rel(k, k - nx + 1, b); } }
    for (let j = nz - 1; j >= 0; --j) for (let i = nx - 1; i >= 0; --i) { const k = j * nx + i; if (i < nx - 1) rel(k, k + 1, a); if (j < nz - 1) { rel(k, k + nx, a); if (i < nx - 1) rel(k, k + nx + 1, b); if (i) rel(k, k + nx - 1, b); } }
    const idx = (x, z) => { const i = Math.floor((x - x0) / GC), j = Math.floor((z - z0) / GC); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
    Lp._grid = {
      x0: gx0, z0: gz0, x1: gx1, z1: gz1,
      at: (x, z) => { const k = idx(x, z); return k < 0 ? null : [mat[k], h[k]]; },
      dEdge: (x, z) => { const k = idx(x, z); return k < 0 ? 0 : D[k]; }
    };
    return Lp._grid;
  }
}

L.cityParkKit = cityParkKit;
})();
