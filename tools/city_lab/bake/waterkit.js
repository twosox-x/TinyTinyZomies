// Water, bridges, lake docks and field foliage for the bake (FORMAT.md 3: WATR, FOLI; 4b: foliage.bin).
// Terrain side (bank slopes, bed, bridge cuts) lives in city_core.js (WATER, waterSD, bankY, bridgePlan, waterColumn);
// this file builds the meshes / instance lists the bake writes per tile.
'use strict';

// extra palette entries (bake.js palette(): ids >= 208)
const XM = {
  WHEAT: 208, WHEAT_HEAD: 209, CORN: 210, CORN_TASSEL: 211, SOY: 212, GRASS: 213, REED: 214, REED_HEAD: 215,
  ROCK: 216, HAY: 217, STEEL: 218, STONE: 219, WOOD: 220, ROCK_DARK: 221
};
const XPAL = {
  208: [196, 160, 78], 209: [232, 198, 104], 210: [64, 116, 44], 211: [206, 184, 112], 212: [84, 132, 56], 213: [92, 130, 60],
  214: [112, 132, 66], 215: [96, 70, 46], 216: [132, 128, 120], 217: [200, 172, 98], 218: [58, 88, 82], 219: [156, 148, 134],
  220: [118, 88, 60], 221: [96, 94, 90]
};
const XNAMES = { 208: 'WHEAT_STALK', 209: 'WHEAT_HEAD', 210: 'CORN_LEAF', 211: 'CORN_TASSEL', 212: 'SOY_LEAF', 213: 'GRASS_TUFT', 214: 'REED',
  215: 'REED_HEAD', 216: 'ROCK', 217: 'HAY', 218: 'BRIDGE_STEEL', 219: 'BRIDGE_STONE', 220: 'WOOD', 221: 'ROCK_DARK' };
const XFOLIAGE = [208, 209, 210, 211, 212, 213, 214, 215];

// foliage instance types (FOLI type byte; foliage.bin F### / G###)
const FT = { WHEAT: 0, CORN: 1, SOY: 2, GRASS: 3, REED: 4, ROCK: 5, HAY: 6 };
const FT_NAMES = ['wheat', 'corn', 'soy', 'grass', 'reed', 'rock', 'hay'];
const FT_SWAY = [1, 0.6, 0.35, 0.8, 1, 0, 0];         // wind sway weight per type (engine)

// ---------------------------------------------------------------------------------------------- quad emitter
// part = { pos: [], mat: [], nvec: [], quads, unit: 1 }; quads are wound CCW seen from the normal side
function part() { return { pos: [], mat: [], nvec: [], quads: 0, unit: 1 }; }
function quad(P, a, b, c, d, n, m) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
  const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
  const vs = cx * n[0] + cy * n[1] + cz * n[2] >= 0 ? [a, b, c, d] : [a, d, c, b];
  for (const v of vs) { P.pos.push(v[0], v[1], v[2]); P.mat.push(m); P.nvec.push(n[0], n[1], n[2]); }
  P.quads++;
}
// box in a frame: world = o + t * U + y * Y + d * N (U, N horizontal unit vectors); faces in `skip` are omitted
function frameBox(P, F, t0, t1, y0, y1, d0, d1, m, skip, mtop) {
  if (t1 - t0 < 1e-4 || y1 - y0 < 1e-4 || d1 - d0 < 1e-4) return;
  const W = (t, y, d) => [F.o[0] + t * F.U[0] + d * F.N[0], y, F.o[1] + t * F.U[1] + d * F.N[1]];
  const U = [F.U[0], 0, F.U[1]], N = [F.N[0], 0, F.N[1]], neg = (v) => [-v[0], -v[1], -v[2]], s = skip || '';
  if (!s.includes('T')) quad(P, W(t0, y1, d0), W(t1, y1, d0), W(t1, y1, d1), W(t0, y1, d1), [0, 1, 0], mtop === undefined ? m : mtop);
  if (!s.includes('B')) quad(P, W(t0, y0, d0), W(t1, y0, d0), W(t1, y0, d1), W(t0, y0, d1), [0, -1, 0], m);
  if (!s.includes('u')) quad(P, W(t0, y0, d0), W(t0, y1, d0), W(t0, y1, d1), W(t0, y0, d1), neg(U), m);
  if (!s.includes('U')) quad(P, W(t1, y0, d0), W(t1, y1, d0), W(t1, y1, d1), W(t1, y0, d1), U, m);
  if (!s.includes('n')) quad(P, W(t0, y0, d0), W(t1, y0, d0), W(t1, y1, d0), W(t0, y1, d0), neg(N), m);
  if (!s.includes('N')) quad(P, W(t0, y0, d1), W(t1, y0, d1), W(t1, y1, d1), W(t0, y1, d1), N, m);
}
const AXIS = { o: [0, 0], U: [1, 0], N: [0, 1] };     // model space: t = x, d = z
const box = (P, x0, y0, z0, x1, y1, z1, m, skip) => frameBox(P, AXIS, x0, x1, y0, y1, z0, z1, m, skip);

// ---------------------------------------------------------------------------------------------- bridges
// Deck at road level (top +0.03, sidewalks +0.18, parapets 1.1 m), abutments on land, through-arch (even plan
// index) or girder bridge with piers (odd). Owned by the tile containing the bridge centre.
const DECK = 0.03, WALK = 0.18;
function bridgeGeom(C, net, b) {
  const W = C.WATER, wet = [];
  for (let t = 0; t <= b.len; t += 0.5) { const x = b.A[0] + b.ux * t, z = b.A[1] + b.uz * t; wet.push([t, C.waterSD(net, x, z)]); }
  const bank = wet.filter(q => q[1] > -1.0);
  const tb0 = bank.length ? bank[0][0] : b.len * 0.2, tb1 = bank.length ? bank[bank.length - 1][0] : b.len * 0.8;
  const water = wet.filter(q => q[1] > 0.5);
  return { tb0, tb1, tw0: water.length ? water[0][0] : tb0, tw1: water.length ? water[water.length - 1][0] : tb1, W };
}
function bridgeMesh(C, net, b, idx) {
  const M = C.MAT, P = part(), F = { o: b.A, U: [b.ux, b.uz], N: [-b.uz, b.ux] }, g = bridgeGeom(C, net, b), W = g.W;
  const L = b.len, cw = b.cw / 2, hw = b.hw, sw = hw - 0.45, arch = idx % 2 === 0;
  // deck slab + carriageway surface (asphalt with edge lines and a central barrier)
  frameBox(P, F, 0, L, -0.85, DECK, -hw, hw, M.CURB, 'T');
  quad(P, ...[[0, -cw], [L, -cw], [L, cw], [0, cw]].map(([t, d]) => [F.o[0] + t * F.U[0] + d * F.N[0], DECK, F.o[1] + t * F.U[1] + d * F.N[1]]), [0, 1, 0], M.ASPHALT);
  for (const s of [-1, 1]) {
    frameBox(P, F, 0, L, DECK, DECK + 0.02, s * (cw - 0.45) - 0.08, s * (cw - 0.45) + 0.08, M.PAINT_WHITE, 'B');
    for (let t = 2; t + 3 < L; t += 12) frameBox(P, F, t, t + 3, DECK, DECK + 0.02, s * cw / 2 - 0.07, s * cw / 2 + 0.07, M.PAINT_WHITE, 'B');
    // sidewalk with curb, parapet with coping
    frameBox(P, F, 0, L, DECK, WALK, s > 0 ? cw : -sw, s > 0 ? sw : -cw, M.SIDEWALK, 'B', M.SIDEWALK);
    frameBox(P, F, 0, L, DECK, 1.0, s > 0 ? sw : -hw, s > 0 ? hw : -sw, XM.STONE, 'B');
    frameBox(P, F, -0.1, L + 0.1, 1.0, 1.12, s > 0 ? sw - 0.06 : -hw - 0.06, s > 0 ? hw + 0.06 : -sw + 0.06, M.CURB);
    // fascia beam under the deck edge
    frameBox(P, F, 0, L, -1.35, -0.85, s > 0 ? hw - 0.7 : -hw, s > 0 ? hw : -hw + 0.7, arch ? XM.STEEL : M.CURB, 'T');
  }
  frameBox(P, F, 0, L, DECK, DECK + 0.55, -0.3, 0.3, M.MEDIAN_CURB, 'B');
  // abutments: stone blocks from the cut bank floor up to the slab, wing walls
  for (const [ta, tb] of [[0, g.tb0 + 1.2], [g.tb1 - 1.2, L]]) {
    if (tb - ta < 0.5) continue;
    frameBox(P, F, ta, tb, W.carve - 0.2, -0.85, -hw - 0.3, hw + 0.3, XM.STONE, 'T');
  }
  if (arch) {
    // tied through-arch: two steel ribs springing from the bank seats, hangers every 3 m, top bracing
    const t0 = g.tb0 + 0.5, t1 = g.tb1 - 0.5, span = t1 - t0, tm = (t0 + t1) / 2, H = Math.min(11, Math.max(6, span * 0.2)), dr = cw + 0.35;
    const yA = (t) => WALK + H * (1 - Math.pow((t - tm) / (span / 2), 2));
    for (const s of [-1, 1]) {
      for (let t = t0; t < t1 - 1e-3; t += 1.0) {
        const te = Math.min(t1, t + 1.0), y = yA((t + te) / 2);
        frameBox(P, F, t, te, Math.max(WALK, y - 0.4), y + 0.4, s * dr - 0.3, s * dr + 0.3, XM.STEEL);
      }
      for (let t = t0 + 3; t < t1 - 2; t += 3) frameBox(P, F, t - 0.07, t + 0.07, WALK, yA(t) - 0.35, s * dr - 0.07, s * dr + 0.07, XM.STEEL, 'TB');
      frameBox(P, F, t0 - 0.8, t0 + 0.8, WALK, WALK + 1.3, s * dr - 0.45, s * dr + 0.45, XM.STONE, 'B');
      frameBox(P, F, t1 - 0.8, t1 + 0.8, WALK, WALK + 1.3, s * dr - 0.45, s * dr + 0.45, XM.STONE, 'B');
    }
    for (let t = tm - span * 0.3; t <= tm + span * 0.3 + 1e-3; t += span * 0.15) {
      const y = yA(t); if (y < 6.5) continue;
      frameBox(P, F, t - 0.25, t + 0.25, y - 0.2, y + 0.2, -dr, dr, XM.STEEL, 'un'.includes('x') ? '' : '');
    }
  } else {
    // girder bridge: piers in the water every ~18 m, steel truss railings over the parapets
    const n = Math.max(1, Math.round((g.tw1 - g.tw0) / 18)), step = (g.tw1 - g.tw0) / (n + 1);
    for (let k = 1; k <= n; ++k) {
      const tp = g.tw0 + step * k;
      frameBox(P, F, tp - 0.8, tp + 0.8, W.bed - 0.3, -1.35, -hw + 1.6, hw - 1.6, XM.STONE, 'T');
      frameBox(P, F, tp - 1.0, tp + 1.0, -1.6, -1.35, -hw + 1.2, hw - 1.2, M.CURB);
      // cutwaters (pointed ends upstream / downstream)
      for (const s of [-1, 1]) frameBox(P, F, tp - 0.45, tp + 0.45, W.bed - 0.3, -1.5, s > 0 ? hw - 1.6 : -hw + 0.9, s > 0 ? hw - 0.9 : -hw + 1.6, XM.STONE);
    }
    for (const s of [-1, 1]) for (let t = 0.5; t < L - 0.5; t += 4) frameBox(P, F, t - 0.1, t + 0.1, 1.12, 1.6, s * (hw - 0.22) - 0.08, s * (hw - 0.22) + 0.08, XM.STEEL, 'B');
    for (const s of [-1, 1]) frameBox(P, F, 0.4, L - 0.4, 1.6, 1.72, s * (hw - 0.22) - 0.1, s * (hw - 0.22) + 0.1, XM.STEEL);
  }
  return P;
}
// street lamps along the bridge sidewalks (props), every 16 m both sides
function bridgeLamps(b) {
  const out = [], N = [-b.uz, b.ux], sw = b.hw - 0.9;
  for (let t = 4; t < b.len - 2; t += 16) for (const s of [-1, 1]) {
    const x = b.A[0] + b.ux * t + N[0] * s * sw, z = b.A[1] + b.uz * t + N[1] * s * sw;
    out.push({ type: 'lamp', x, y: WALK, z, yaw: Math.atan2(-N[0] * s, -N[1] * s), phase: 0 });
  }
  return out;
}
// HGT0 override over the bridge rectangles: deck = ROAD, sidewalks = WALK, parapets / arch ribs BLOCKED
function stampBridges(C, net, H, x0, z0, HC, HN, F) {
  const L = C.bridgePlan(net);
  L.forEach((b, idx) => {
    const cw = b.cw / 2, sw = b.hw - 0.45, arch = idx % 2 === 0, dr = cw + 0.35;
    for (let gj = 0; gj < HN; ++gj) for (let gi = 0; gi < HN; ++gi) {
      const x = x0 + (gi + 0.5) * HC, z = z0 + (gj + 0.5) * HC, rx = x - b.A[0], rz = z - b.A[1];
      const t = rx * b.ux + rz * b.uz; if (t < 0 || t > b.len) continue;
      const d = Math.abs(-rx * b.uz + rz * b.ux); if (d > b.hw) continue;
      const k = gj * HN + gi;
      let fl = H.flags[k] & F.VEHICLE, top;
      if (d < cw) { top = DECK; fl |= F.ROAD; } else if (d < sw) { top = WALK; fl |= F.WALK; } else { top = 1.12; fl |= F.BLOCKED | F.BUILDING; }
      if (d < 0.3) { top = DECK + 0.55; fl |= F.BLOCKED; }
      if (arch && Math.abs(d - dr) < 0.35) fl |= F.BLOCKED | F.BUILDING;
      H.top[k] = top; H.flags[k] = fl;
    }
  });
}

// ---------------------------------------------------------------------------------------------- lake docks
function lakeDocks(C, net) {
  const out = [], P = net.plan; if (!P || P.kind !== 'tensor') return out;
  P.lakes.forEach((l, li) => {
    if (C.hash2(li, 3, 991) < 0.15) return;
    const th = C.hash2(li, 5, 993) * Math.PI * 2, ux = Math.cos(th), uz = Math.sin(th);
    // walk in from outside until the shore distance is -1.2 (bank at about the dock height)
    let s0 = null, s1 = null;
    for (let s = l.r * 1.6; s > 0; s -= 0.25) {
      const x = l.c[0] + ux * s, z = l.c[1] + uz * s, sd = C.waterSD(net, x, z);
      if (s0 === null && sd > -1.3) s0 = s;
      if (s0 !== null && sd > 8) { s1 = s; break; }
    }
    if (s0 === null || s1 === null) return;
    out.push({ c: l.c, ux: -ux, uz: -uz, a: [l.c[0] + ux * s0, l.c[1] + uz * s0], len: s0 - s1 });
  });
  return out;
}
function dockMesh(C, d) {
  const P = part(), F = { o: d.a, U: [d.ux, d.uz], N: [-d.uz, d.ux] }, y = C.WATER.level + 0.55, w = 0.9;
  for (let t = 0; t < d.len; t += 0.3) frameBox(P, F, t, Math.min(d.len, t + 0.26), y - 0.08, y, -w, w, XM.WOOD);
  frameBox(P, F, 0, d.len, y - 0.3, y - 0.08, -w + 0.1, -w + 0.3, XM.WOOD, 'T');
  frameBox(P, F, 0, d.len, y - 0.3, y - 0.08, w - 0.3, w - 0.1, XM.WOOD, 'T');
  for (let t = 1.2; t < d.len; t += 2.4) for (const s of [-1, 1]) frameBox(P, F, t - 0.1, t + 0.1, C.WATER.bed, y + (t > d.len - 2 ? 0.6 : 0.1), s * w - 0.1, s * w + 0.1, XM.WOOD);
  frameBox(P, F, d.len - 2.4, d.len, y, y + 0.05, -w - 1.0, w + 1.0, XM.WOOD);        // T head
  return P;
}

// ---------------------------------------------------------------------------------------------- WATR grid
// 1 m grid of shore distances over the tile (cm, clamped), or null when no water / bank reaches the tile
function waterGrid(C, net, x0, z0, size) {
  const n = size + 1, sd = new Int16Array(n * n); let any = false;
  for (let j = 0; j < n; ++j) for (let i = 0; i < n; ++i) {
    const x = x0 + i, z = z0 + j;
    const v = C.waterSD(net, x, z);
    sd[j * n + i] = Math.max(-32000, Math.min(32000, Math.round(v * 100)));
    if (v > -2) any = true;
  }
  return any ? { n, cell: 1, sd } : null;
}
function waterSection(B, C, G, x0, z0) {
  const w = new B.W(32 + G.sd.length * 2);
  w.u32(G.n); w.u32(G.n); w.f32(G.cell); w.f32(x0); w.f32(z0); w.f32(C.WATER.level); w.f32(C.WATER.bank); w.u32(0);
  for (const v of G.sd) w.i16(v);
  w.align();
  return w.done();
}

// ---------------------------------------------------------------------------------------------- foliage
// Instances on a jittered grid aligned to the field rows (rural parcels are axis aligned): wheat clumps, corn plants
// on the crop rows, soy bushes, grass tufts on pasture / verges, reeds and rocks along the water, hay bales.
function foliage(C, net, R, x0, z0, size) {
  const out = [], o = {}, cls = [0, 0], V = R.v, h2 = C.hash2, M = C.MAT, G = C.GROUND, T = 0x7fffffff;
  const add = (type, x, z, y, yaw, sc) => {
    if (x < x0 || z < z0 || x >= x0 + size || z >= z0 + size) return;
    out.push({ type, x, z, y, yaw, sc });
  };
  const ground = (x, z) => { R.classify(x, z, o, cls); return [cls[0] * V, cls[1]]; };
  const rural = net.plan && net.plan.kind === 'tensor';
  if (!rural) return out;
  const st = 0.8;
  for (let gz = Math.floor(z0 / st); gz * st < z0 + size; ++gz) for (let gx = Math.floor(x0 / st); gx * st < x0 + size; ++gx) {
    const r1 = h2(gx, gz, 4101), r2 = h2(gx, gz, 4103), r3 = h2(gx, gz, 4107);
    let x = (gx + 0.5) * st, z = (gz + 0.5) * st;
    const sd = C.waterSD(net, x, z);
    if (sd > -2.2 && sd < 0.6) {                                // reeds at the waterline, rocks on the bank
      const cl = h2(Math.floor(x / 5), Math.floor(z / 5), 4111);
      const jx = x + (r1 - 0.5) * st, jz = z + (r2 - 0.5) * st, g = ground(jx, jz);
      if (C.bridgeAt(net, jx, jz, 1.5)) continue;
      if (sd > -1.1 && cl > 0.35 && r3 < 0.75) add(FT.REED, jx, jz, Math.max(g[0], C.WATER.level - 0.1), r1 * 6.283, 0.8 + 0.5 * r2);
      else if (sd < -0.6 && r3 < 0.2) add(FT.ROCK, jx, jz, g[0] - 0.05, r2 * 6.283, 0.6 + 0.9 * r1);
      else if (sd < -1.2 && r3 < 0.45) add(FT.GRASS, jx, jz, g[0], r1 * 6.283, 0.8 + 0.5 * r2);
      continue;
    }
    if (sd > -3.6 && sd <= -2.2) {                              // the grassy top tread: tufts, the odd reed clump / rock
      const jx = x + (r1 - 0.5) * st, jz = z + (r2 - 0.5) * st;
      if (C.bridgeAt(net, jx, jz, 1.5)) continue;
      const g = ground(jx, jz);
      if (g[1] !== 16 && g[1] !== 140) continue;                 // verge / earth only (not roads, sidewalks, lots)
      if (r3 < 0.4) add(FT.GRASS, jx, jz, g[0], r1 * 6.283, 0.8 + 0.6 * r2);
      else if (r3 < 0.47) add(FT.ROCK, jx, jz, g[0] - 0.05, r2 * 6.283, 0.5 + 0.6 * r1);
      continue;
    }
    if (sd > -2.2) continue;
    if ((gx & 1) && (gz & 1) && r3 < 0.9) { /* coarse pre-pass: grass tufts / verges handled below */ }
    const g = C.ruralGround(net, x, z, 99);
    if (!g) continue;
    if (g.kind === 'field' && g.p) {
      const p = g.p, along = p.alongX, w = along ? z - p.z0 : x - p.x0;
      if (p.edge < 2.2) continue;
      if (p.kind === 'corn') {
        const row = Math.floor(w / 2.4), wc = row * 2.4 + 0.8;
        if (Math.abs(w - wc) > st / 2) continue;                // one plant per 0.8 m along each 2.4 m row
        const ax = along ? x + (r1 - 0.5) * 0.25 : p.x0 + wc, az = along ? p.z0 + wc : z + (r1 - 0.5) * 0.25;
        const gg = ground(ax, az); if (gg[1] !== G.CROP && gg[1] !== G.FURROW) continue;
        add(FT.CORN, ax, az, gg[0], r2 * 6.283, 0.85 + 0.3 * r3);
      } else if (p.kind === 'soy') {
        const row = Math.floor(w / 2.0), wc = row * 2.0 + 0.65;
        if (Math.abs(w - wc) > st / 2 || r3 > 0.85) continue;
        const ax = along ? x + (r1 - 0.5) * 0.3 : p.x0 + wc, az = along ? p.z0 + wc : z + (r1 - 0.5) * 0.3;
        const gg = ground(ax, az); if (gg[1] !== G.SOY && gg[1] !== G.FURROW) continue;
        add(FT.SOY, ax, az, gg[0], r2 * 6.283, 0.8 + 0.4 * r3);
      } else if (p.kind === 'wheat') {
        if (((gx + gz) & 1) && r3 < 0.5) continue;              // ~ 1 clump per 0.85 m2
        const ax = x + (r1 - 0.5) * st * 0.8, az = z + (r2 - 0.5) * st * 0.8, gg = ground(ax, az);
        if (gg[1] !== G.WHEAT) continue;
        if (r3 > 0.9993) add(FT.HAY, ax, az, gg[0], r1 * 6.283, 1);
        else add(FT.WHEAT, ax, az, gg[0], r2 * 6.283, 0.85 + 0.3 * r3);
      }
    } else if (g.kind === 'pasture' || g.kind === 'verge' || g.kind === 'headland' || (g.kind === 'field' && g.p && g.p.edge < 2.2)) {
      const dens = g.kind === 'pasture' ? 0.22 : 0.3;
      if (r3 > dens) continue;
      const ax = x + (r1 - 0.5) * st, az = z + (r2 - 0.5) * st, gg = ground(ax, az);
      if (gg[1] !== G.PASTURE && gg[1] !== G.VERGE) continue;
      if (g.kind === 'pasture' && r3 < 0.0015) add(FT.HAY, ax, az, gg[0], r1 * 6.283, 1);
      else add(FT.GRASS, ax, az, gg[0], r1 * 6.283, 0.7 + 0.6 * r2);
    }
  }
  return out;
}
// FOLI section: instances sorted by chunk (4 x 4 of 32 m, row = z) then type; header u32 count, u32 chunks (16),
// u32 types (8), u32 reserved, u32 start[16 * 8 + 1] (first instance of each (chunk, type) range), then records of
// 8 bytes: u16 x, u16 z (1/512 m from the tile corner), i16 y (mm), u8 yaw (2 pi / 256), u8 scale (1/100)
function foliageSection(B, list, x0, z0) {
  const NC = 16, NT = 8, key = (f) => (Math.min(3, Math.floor((f.z - z0) / 32)) * 4 + Math.min(3, Math.floor((f.x - x0) / 32))) * NT + f.type;
  const L = list.map(f => [key(f), f]).sort((a, b) => a[0] - b[0] || a[1].z - b[1].z || a[1].x - b[1].x);
  const start = new Uint32Array(NC * NT + 1);
  for (const [k] of L) start[k + 1]++;
  for (let k = 0; k < NC * NT; ++k) start[k + 1] += start[k];
  const w = new B.W(16 + start.length * 4 + L.length * 8);
  w.u32(L.length); w.u32(NC); w.u32(NT); w.u32(0);
  for (const s of start) w.u32(s);
  for (const [, f] of L) {
    w.u16(Math.max(0, Math.min(65535, Math.round((f.x - x0) * 512)))); w.u16(Math.max(0, Math.min(65535, Math.round((f.z - z0) * 512))));
    w.i16(Math.max(-32768, Math.min(32767, Math.round(f.y * 1000))));
    w.u8(Math.round(((f.yaw % 6.2831853) + 6.2831853) % 6.2831853 / 6.2831853 * 256) & 255); w.u8(Math.max(1, Math.min(255, Math.round(f.sc * 100))));
  }
  return w.done();
}

// voxel foliage models (model space, metres, origin at the ground); [LOD0 part, LOD1 part]
function foliageModels(C) {
  const out = [];
  const R = C.mulberry32 ? C.mulberry32(77) : Math.random;
  const stalks = (P, n, rad, h0, h1, wS, mS, mH, head, lean) => {
    for (let k = 0; k < n; ++k) {
      const a = R() * 6.283, r = Math.sqrt(R()) * rad, x = Math.cos(a) * r, z = Math.sin(a) * r, h = h0 + (h1 - h0) * R();
      box(P, x - wS, 0, z - wS, x + wS, h, z + wS, mS, 'B');
      if (head) box(P, x - head, h - 0.16, z - head, x + head + (lean || 0), h + 0.05, z + head, mH, 'B');
    }
  };
  // wheat: a clump of 9 stalks with grain heads / LOD1: one block of straw with a head band
  { const a = part(), b = part(); stalks(a, 9, 0.42, 0.75, 1.0, 0.025, XM.WHEAT, XM.WHEAT_HEAD, 0.045, 0.02);
    box(b, -0.38, 0, -0.38, 0.38, 0.72, 0.38, XM.WHEAT, 'B'); box(b, -0.4, 0.72, -0.4, 0.4, 0.92, 0.4, XM.WHEAT_HEAD, 'B'); out.push([a, b]); }
  // corn: stalk, alternating leaves, tassel / LOD1: stalk + two crossed leaf slabs
  { const a = part(), b = part(), h = 2.2;
    box(a, -0.04, 0, -0.04, 0.04, h, 0.04, XM.CORN, 'B');
    for (let k = 0; k < 6; ++k) { const y = 0.35 + k * 0.3, L = 0.5 - k * 0.04, s = k % 2 ? 1 : -1;
      if (k % 2) box(a, -0.05, y, s > 0 ? 0.04 : -0.04 - L, 0.05, y + 0.05, s > 0 ? 0.04 + L : -0.04, XM.CORN);
      else box(a, s > 0 ? 0.04 : -0.04 - L, y, -0.05, s > 0 ? 0.04 + L : -0.04, y + 0.05, 0.05, XM.CORN); }
    box(a, -0.06, h, -0.06, 0.06, h + 0.25, 0.06, XM.CORN_TASSEL, 'B'); box(a, 0.04, 1.1, -0.05, 0.13, 1.35, 0.05, XM.CORN_TASSEL);
    box(b, -0.05, 0, -0.05, 0.05, h + 0.2, 0.05, XM.CORN, 'B'); box(b, -0.45, 0.6, -0.04, 0.45, 1.6, 0.04, XM.CORN); box(b, -0.04, 0.9, -0.45, 0.04, 1.9, 0.45, XM.CORN);
    out.push([a, b]); }
  // soy: a low bush of leaf blocks / LOD1: one block
  { const a = part(), b = part();
    for (let k = 0; k < 7; ++k) { const x = (R() - 0.5) * 0.5, z = (R() - 0.5) * 0.4, s = 0.1 + 0.07 * R(), y = 0.15 + 0.35 * R(); box(a, x - s, y - s, z - s, x + s, y + s, z + s, XM.SOY); }
    box(a, -0.03, 0, -0.03, 0.03, 0.25, 0.03, XM.SOY, 'B');
    box(b, -0.3, 0.05, -0.25, 0.3, 0.55, 0.25, XM.SOY, 'B'); out.push([a, b]); }
  // grass tuft / LOD1: 3 blades
  { const a = part(), b = part(); stalks(a, 8, 0.2, 0.18, 0.42, 0.02, XM.GRASS, 0, 0);
    box(b, -0.18, 0, -0.02, 0.18, 0.3, 0.02, XM.GRASS, 'B'); box(b, -0.02, 0, -0.18, 0.02, 0.36, 0.18, XM.GRASS, 'B'); out.push([a, b]); }
  // reeds: tall blades with brown cattail heads / LOD1: crossed slabs
  { const a = part(), b = part(); stalks(a, 10, 0.32, 1.0, 1.8, 0.022, XM.REED, XM.REED_HEAD, 0.04);
    box(b, -0.3, 0, -0.03, 0.3, 1.5, 0.03, XM.REED, 'B'); box(b, -0.03, 0, -0.3, 0.03, 1.4, 0.3, XM.REED, 'B'); out.push([a, b]); }
  // rock: a few stacked blocks / LOD1: one block
  { const a = part(), b = part();
    box(a, -0.45, -0.1, -0.35, 0.4, 0.3, 0.38, XM.ROCK); box(a, -0.25, 0.3, -0.2, 0.22, 0.48, 0.25, XM.ROCK_DARK, 'B'); box(a, 0.2, -0.1, 0.1, 0.6, 0.18, 0.45, XM.ROCK_DARK, 'B');
    box(b, -0.45, -0.1, -0.35, 0.45, 0.4, 0.4, XM.ROCK, 'B'); out.push([a, b]); }
  // round hay bale lying on its side / LOD1: box
  { const a = part(), b = part(), r = 0.75, w = 0.6;
    for (let k = 0; k < 6; ++k) { const t = (k + 0.5) / 6 * 2 - 1, hh = Math.sqrt(1 - t * t) * r; box(a, -w, r + t * r - r / 6, -hh, w, r + t * r + r / 6, hh, XM.HAY); }
    box(a, -w - 0.01, 0.3, -0.45, -w, 1.2, 0.45, XM.WHEAT, 'B'); box(a, w, 0.3, -0.45, w + 0.01, 1.2, 0.45, XM.WHEAT, 'B');
    box(b, -w, 0, -0.65, w, 1.4, 0.65, XM.HAY, 'B'); out.push([a, b]); }
  return out;
}

module.exports = { XM, XPAL, XNAMES, XFOLIAGE, FT, FT_NAMES, FT_SWAY, bridgeMesh, bridgeLamps, stampBridges, lakeDocks, dockMesh, waterGrid, waterSection,
  foliage, foliageSection, foliageModels, part, frameBox };
