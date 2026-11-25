/* City Lab core — Tiny Tiny Zombies, phase 5A.
 *
 * Pure data + geometry, no rendering library. Everything the native engine will need to reproduce:
 *   1. PROFILES     reusable street cross-sections (bands across the road, sidewalks, curb radius)
 *   2. Networks     road network generators (organic city district, road test area) -> roads as polylines
 *   3. FieldSampler distance fields over the network: one carriageway field for the whole network
 *                   (smooth union = curb returns), nearest road, lateral/longitudinal road coordinates,
 *                   distance to the other roads (intersection zones), sidewalk width
 *   4. Rasterizer   world-aligned voxel columns (height + material) from the fields: one coherent surface,
 *                   so there is no overlapping road geometry, no z-fighting and no holes by construction
 *   5. Plots        city blocks and building plots derived from the network; building blockouts
 *   6. Mesher       greedy surface meshing of voxel height fields (tops + walls), integer positions
 *
 * Units: metres, x east, z south (right-handed with y up), heights in voxels.
 */
(function (root) {
'use strict';

// ------------------------------------------------------------------------------------------------ utilities
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {               // integer hash -> [0,1)
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function smin(a, b, k) {                // polynomial smooth minimum: fillet of radius ~k between two fields
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ------------------------------------------------------------------------------------------------ 1. profiles
// A profile lists the bands across the carriageway from the LEFT curb to the RIGHT curb, looking along the
// direction the road is drawn (+t). Lane `dir` +1 travels along +t (drives on the right), -1 against it.
// sidewalk: width outside each curb (m), radius: curb-return radius at corners (m).
const PROFILES = {
  avenue: {
    label: 'Avenue (4 lanes, planted median, parking)', cls: 'arterial',
    bands: [['park', 0, 2.4], ['lane', -1, 3.3], ['lane', -1, 3.3], ['median', 0, 3.6], ['lane', 1, 3.3], ['lane', 1, 3.3], ['park', 0, 2.4]],
    sidewalk: 4.6, radius: 7.5, median: 'planted', crosswalk: true, arrows: true
  },
  boulevard: {
    label: 'Boulevard (4 lanes, wide planted median)', cls: 'arterial',
    bands: [['lane', -1, 3.4], ['lane', -1, 3.4], ['median', 0, 6.0], ['lane', 1, 3.4], ['lane', 1, 3.4]],
    sidewalk: 4.2, radius: 8, median: 'planted', crosswalk: true, arrows: true
  },
  street: {
    label: 'Street (2 lanes, parking)', cls: 'collector',
    bands: [['park', 0, 2.3], ['lane', -1, 3.4], ['lane', 1, 3.4], ['park', 0, 2.3]],
    sidewalk: 3.4, radius: 5.5, centre: 'double', crosswalk: true, arrows: false
  },
  oneway: {
    label: 'One-way street (3 lanes, parking)', cls: 'collector',
    bands: [['park', 0, 2.3], ['lane', 1, 3.2], ['lane', 1, 3.2], ['lane', 1, 3.2], ['park', 0, 2.3]],
    sidewalk: 3.6, radius: 5.5, crosswalk: true, arrows: true
  },
  residential: {
    label: 'Residential street (2 lanes, parking)', cls: 'local',
    bands: [['park', 0, 2.1], ['lane', -1, 3.0], ['lane', 1, 3.0], ['park', 0, 2.1]],
    sidewalk: 2.6, radius: 4.5, centre: 'none', crosswalk: false, arrows: false
  },
  lane: {
    label: 'Residential lane (2 lanes)', cls: 'local',
    bands: [['lane', -1, 3.0], ['lane', 1, 3.0]],
    sidewalk: 2.2, radius: 4.5, centre: 'dashed', crosswalk: false, arrows: false
  },
  alley: {
    label: 'Alley (service lane)', cls: 'alley',
    bands: [['alley', 0, 4.6]],
    sidewalk: 0, radius: 1.5, crosswalk: false, arrows: false
  }
};
for (const id in PROFILES) {
  const p = PROFILES[id];
  p.id = id;
  p.width = p.bands.reduce((a, b) => a + b[2], 0);
  p.half = p.width / 2;
  // band edges in lateral coordinate u (positive = left of +t)
  let u = p.half;
  p.edges = p.bands.map(b => { const e = { type: b[0], dir: b[1], w: b[2], left: u, right: u - b[2] }; u -= b[2]; return e; });
}

// ------------------------------------------------------------------------------------------------ 2. networks
// Road: { id, name, profile, pts: [[x,z],...], bulbEnd?: radius (cul-de-sac), district }
function bezier(p0, p1, p2, p3, step) {
  const pts = [];
  let len = 0, prev = p0;
  for (let i = 1; i <= 64; ++i) { const q = bz(p0, p1, p2, p3, i / 64); len += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
  const n = Math.max(2, Math.ceil(len / step));
  for (let i = 0; i <= n; ++i) pts.push(bz(p0, p1, p2, p3, i / n));
  return pts;
}
function bz(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
}
function arcPts(cx, cz, r, a0, a1, step) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / step));
  const pts = [];
  for (let i = 0; i <= n; ++i) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  return pts;
}
// clip the infinite line p + t*d to a convex polygon (list of half-planes n·x <= c); returns [t0,t1] or null
function clipLine(p, d, halfPlanes) {
  let t0 = -1e9, t1 = 1e9;
  for (const [nx, nz, c] of halfPlanes) {
    const den = nx * d[0] + nz * d[1], num = c - (nx * p[0] + nz * p[1]);
    if (Math.abs(den) < 1e-9) { if (num < 0) return null; continue; }
    const t = num / den;
    if (den > 0) t1 = Math.min(t1, t); else t0 = Math.max(t0, t);
  }
  return t0 < t1 ? [t0, t1] : null;
}
function hpFromLine(a, b, keepPoint) {    // half-plane containing keepPoint, boundary through a-b
  const nx = -(b[1] - a[1]), nz = b[0] - a[0];
  const c = nx * a[0] + nz * a[1];
  return (nx * keepPoint[0] + nz * keepPoint[1] <= c) ? [nx, nz, c] : [-nx, -nz, -c];
}

// Organic district (~ 640 x 540 m) grown from its arterials: a downtown grid, a rotated old town, a curved
// residential quarter, a diagonal avenue, a curved boulevard, a six-way star with a plaza, alleys and cul-de-sacs.
function generateCity(seed) {
  const R = mulberry32(seed * 7919 + 17);
  const J = (a) => (R() * 2 - 1) * a;
  const X0 = -330, X1 = 330, Z0 = -275, Z1 = 275;
  const roads = [];
  let nid = 0;
  const add = (profile, pts, name, district, extra) => { const r = Object.assign({ id: nid++, profile, pts, name, district }, extra || {}); roads.push(r); return r; };
  const line = (a, b) => [a, b];

  // arterials ------------------------------------------------------------------------------------------
  const star = [30 + J(6), J(5)];                          // Grand x Division
  const zG = star[1], xD = star[0];
  const bAng = (34 + J(4)) * Math.PI / 180;                // Broadway heading (SW -> NE)
  const bd = [Math.cos(bAng), Math.sin(bAng)];
  // Broadway crosses Grand 90 m east of Division: instead of one six-way star the three avenues form a
  // triangle of ordinary junctions around a small plaza (Six Corners), the way real cities resolve it
  const bs = [xD + 90, zG];
  add('avenue', line([X0 - 12, zG], [X1 + 12, zG]), 'Grand Avenue', 'arterial');
  add('oneway', line([xD, Z0 - 12], [xD, Z1 + 12]), 'Division Street', 'arterial');
  const bT0 = clipLine(bs, bd, [[1, 0, X1 + 12], [-1, 0, -(X0 - 12)], [0, 1, Z1 + 12], [0, -1, -(Z0 - 12)]]);
  const bwA = [bs[0] + bd[0] * bT0[0], bs[1] + bd[1] * bT0[0]], bwB = [bs[0] + bd[0] * bT0[1], bs[1] + bd[1] * bT0[1]];
  // Broadway bends gently north-east of the river quarter: straight to a point, then a long arc
  const bendT = 150 + J(20);
  const bendP = [bs[0] + bd[0] * bendT, bs[1] + bd[1] * bendT];
  const bd2a = bAng + (14 + J(4)) * Math.PI / 180;
  const broadway = add('avenue', [bwA, ...bezier(bs, [bs[0] + bd[0] * bendT * 0.6, bs[1] + bd[1] * bendT * 0.6], bendP,
    [bendP[0] + Math.cos(bd2a) * 220, bendP[1] + Math.sin(bd2a) * 220], 3).slice(0)], 'Broadway', 'arterial');
  broadway.pts = dedupe(broadway.pts);
  const broadwayEnd = broadway.pts[broadway.pts.length - 1];
  const onBroadway = (p) => distToPolyline(p, broadway.pts) < 0.5;

  // downtown grid: west of Division, both sides of Grand ----------------------------------------------------
  const xs = [], zsN = [], zsS = [];
  for (let x = xD - (88 + J(8)); x > X0 + 25; x -= 72 + R() * 26) xs.push(x);
  for (let z = zG + 64 + J(6); z < Z1 - 20; z += 62 + R() * 16) zsN.push(z);
  for (let z = zG - 66 + J(6); z > Z0 + 20; z -= 60 + R() * 18) zsS.push(z);
  const central = xs[Math.min(1, xs.length - 1)];          // Central Avenue: second N-S line west of Division
  // keep grid crossings away from Broadway (no sliver junctions): nudge a street a little, or drop it
  const bwDist = (x, z) => Math.abs(-(bd[1]) * (x - bs[0]) + bd[0] * (z - bs[1]));
  const conflicts = (z) => xs.concat([xD]).filter(x => bwDist(x, z) < (x === central || x === xD ? 18 : 12)).length;
  for (let i = 0; i < zsS.length; ++i) {
    if (!conflicts(zsS[i])) continue;
    const opts = [-6, 6, -12, 12, -18, 18, -24, 24, -30, 30].map(dz => zsS[i] + dz).filter(z => !conflicts(z));
    zsS[i] = opts.length ? opts[0] : NaN;
  }
  for (let i = zsS.length - 1; i >= 0; --i)
    if (isNaN(zsS[i]) || zsS[i] < Z0 + 15 || (i > 0 && Math.abs(zsS[i] - zsS[i - 1]) < 40) || Math.abs(zsS[i] - zG) < 40) zsS.splice(i, 1);
  xs.forEach((x, i) => {
    const prof = x === central ? 'avenue' : (i % 2 ? 'oneway' : 'street');
    add(prof, line([x, Z0 - 12], [x, Z1 + 12]), x === central ? 'Central Avenue' : `${ordinal(i + 1)} Street`, 'downtown');
  });
  const ewNames = ['Market', 'Pine', 'Union', 'Cedar', 'Spring', 'Lake', 'Court', 'Hill'];
  zsN.concat(zsS).forEach((z, i) => add(i % 3 === 2 ? 'oneway' : 'street', line([X0 - 12, z], [xD, z]), `${ewNames[i % ewNames.length]} Street`, 'downtown'));
  // alleys through some downtown blocks (mid-block, east-west), one ends blind
  const zAll = [zG].concat(zsN).sort((a, b) => a - b);
  for (let i = 0; i + 1 < zAll.length; ++i) {
    const zm = (zAll[i] + zAll[i + 1]) / 2;
    const xl = [X0 - 12].concat(xs.slice().reverse(), [xD]);
    for (let k = 0; k + 1 < xl.length; ++k) {
      if (R() < 0.45) continue;
      const blind = R() < 0.2;
      const xa = xl[k], xb = blind ? (xl[k] + xl[k + 1]) / 2 : xl[k + 1];
      add('alley', line([xa, zm], [xb, zm]), 'Alley', 'downtown');
    }
  }
  const zAllS = [zG].concat(zsS).sort((a, b) => b - a);
  for (let i = 0; i + 1 < zAllS.length; ++i) {
    if (R() < 0.5) continue;
    const zm = (zAllS[i] + zAllS[i + 1]) / 2, xl = [X0 - 12].concat(xs.slice().reverse());
    const k = Math.floor(R() * (xl.length - 1));
    add('alley', line([xl[k], zm], [xl[k + 1], zm]), 'Alley', 'downtown');
  }

  // old town: rotated grid, south-east quadrant (x > Division, z < Grand) ---------------------------------
  const th = (16 + J(5)) * Math.PI / 180;
  const ou = [Math.cos(th), Math.sin(th)], ov = [-Math.sin(th), Math.cos(th)];
  const oldHP = [[-1, 0, -(xD)], [0, 1, zG], [1, 0, X1 + 12], [0, -1, -(Z0 - 12)]];   // x >= xD, z <= zG
  const origin = [xD, zG];
  const oldNames = ['Water', 'Mill', 'Front', 'Church', 'Bridge', 'Ferry', 'Dock', 'Canal', 'Wharf'];
  let oi = 0;
  for (let a = 52 + J(6); a < 420; a += 48 + R() * 18) {             // lines along ov (roughly north-south)
    const p = [origin[0] + ou[0] * a, origin[1] + ou[1] * a];
    const t = clipLine(p, ov, oldHP);
    if (!t || t[1] - t[0] < 30) continue;
    add(oi % 3 === 1 ? 'residential' : 'street', line([p[0] + ov[0] * t[0], p[1] + ov[1] * t[0]], [p[0] + ov[0] * t[1], p[1] + ov[1] * t[1]]),
      `${oldNames[oi++ % oldNames.length]} Street`, 'oldtown');
  }
  for (let b = -(46 + J(6)); b > -420; b -= 44 + R() * 16) {          // lines along ou (roughly east-west)
    const p = [origin[0] + ov[0] * b, origin[1] + ov[1] * b];
    const t = clipLine(p, ou, oldHP);
    if (!t || t[1] - t[0] < 30) continue;
    add(oi % 2 ? 'residential' : 'street', line([p[0] + ou[0] * t[0], p[1] + ou[1] * t[0]], [p[0] + ou[0] * t[1], p[1] + ou[1] * t[1]]),
      `${oldNames[oi++ % oldNames.length]} Lane`, 'oldtown');
  }

  // east wedge between Grand Avenue and Broadway: curved residential quarter ---------------------------------
  // Riverside Boulevard leaves Grand Avenue and sweeps south-east to the edge; the river park lies between it
  // and Broadway. Maple Crescent loops from Grand down to Riverside; Oak Drive winds along the east edge.
  const rv0 = [xD + 150 + J(10), zG];
  const riverside = add('boulevard', bezier(rv0, [rv0[0] + 8, zG + 55], [X1 - 90, zG + 62 + J(10)], [X1 + 14, zG + 140 + J(12)], 3), 'Riverside Boulevard', 'residential');
  const ox2 = X1 - 38 + J(5);
  add('residential', bezier([ox2, zG], [ox2 + 14, zG + 30], [ox2 - 18, zG + 55], [ox2 - 6, zG + 96 + J(5)], 3), 'Oak Drive', 'residential');
  const cul = (p, ang, len, name, bend) => {
    const q = [p[0] + Math.cos(ang) * len, p[1] + Math.sin(ang) * len];
    const c = [p[0] + Math.cos(ang) * len * 0.5 + Math.cos(ang + 1.57) * len * bend, p[1] + Math.sin(ang) * len * 0.5 + Math.sin(ang + 1.57) * len * bend];
    add('lane', bezier(p, c, c, q, 3), name, 'residential', { bulbEnd: 10.5 });
  };
  // a short street from Grand that curves into Broadway (curved road meeting a diagonal avenue)
  const hx = xD + 92 + J(6);
  const hb = (hx + 20 - bs[0]) / bd[0];
  add('residential', bezier([hx, zG], [hx + 2, zG + 18], [hx + 12, zG + 30], [bs[0] + bd[0] * (hb + 12), bs[1] + bd[1] * (hb + 12)], 3), 'Hazel Street', 'residential');
  // the wedge between Division and Broadway: streets hitting Broadway at an acute angle, a short N-S street,
  // two cul-de-sacs and a curved lane along the edge
  const wedgeZ = [];
  for (let k = 0; k < 3; ++k) {
    const z = zG + 72 + k * (60 + J(6));
    const xe = crossZ(broadway.pts, z, xD);
    if (xe === null || xe - xD < 40) continue;
    wedgeZ.push([z, xe]);
    add(k === 1 ? 'residential' : 'street', line([xD, z], [xe, z]), ['Kent Street', 'Pearl Street', 'Ash Street'][k], 'residential');
  }
  if (wedgeZ.length >= 2) {
    const vx = xD + 95 + J(8);
    if (vx < wedgeZ[0][1] - 30) add('residential', line([vx, wedgeZ[0][0]], [vx, Z1 - 30]), 'Vine Street', 'residential');
    const pz = wedgeZ[1][0];
    cul([xD + 45, pz], Math.PI * 0.5, 40, 'Linden Court', 0.1);
    if (wedgeZ.length > 2) cul([vx + 50, wedgeZ[2][0]], Math.PI * 0.5 + 0.25, 38, 'Birch Court', -0.12);
  }
  const ridge0 = [xD, Z1 - 30 + J(5)];
  const tR = (Z1 - 2 - bs[1]) / bd[1];
  add('lane', bezier(ridge0, [xD + 40, ridge0[1] - 25], [xD + 80, Z1 - 5], [Math.min(bs[0] + bd[0] * tR, X1), Z1 + 12], 3), 'Ridge Lane', 'residential');

  // open spaces ----------------------------------------------------------------------------------------------
  const areas = [];
  const plazaC = [xD + 30, zG - 90 * Math.tan(bAng) / 3];
  areas.push({ kind: 'plaza', shape: 'circle', c: plazaC, r: 22, name: 'Six Corners Plaza' });
  // a downtown square: the block between Central Avenue, the next street west and the first two streets north of Grand
  const xw = xs[Math.min(2, xs.length - 1)];
  if (zsN.length > 0) areas.push({ kind: 'square', shape: 'rect', x0: Math.min(xw, central), x1: Math.max(xw, central), z0: zG, z1: zsN[0], name: 'Union Square' });
  // river park north of Riverside Boulevard
  areas.push({ kind: 'park', shape: 'side', road: riverside.id, side: -1, name: 'Riverside Park' });
  // an open lot in the old town: a whole block left empty (horde gathering space)
  areas.push({ kind: 'lot', shape: 'circle', c: [origin[0] + ou[0] * 150 + ov[0] * -95, origin[1] + ou[1] * 150 + ov[1] * -95], r: 30, name: 'Freight Yard' });

  return { kind: 'city', seed, bounds: { x0: X0, z0: Z0, x1: X1, z1: Z1 }, roads, areas, origins: { star: plazaC, core: [central + 40, zG - 25] } };
}
// first crossing of the horizontal line z = const with a polyline, east of xMin
function crossZ(pts, z, xMin) {
  for (let i = 0; i + 1 < pts.length; ++i) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    if ((az - z) * (bz - z) > 0 || az === bz) continue;
    const x = ax + (bx - ax) * (z - az) / (bz - az);
    if (x > xMin) return x;
  }
  return null;
}
// position and unit tangent at arc length s along a road polyline
function pointAt(r, s) {
  const pts = r.pts;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; ++i) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 1e-6) continue;
    if (acc + l >= s || i + 2 === pts.length) {
      const t = clamp((s - acc) / l, 0, 1);
      return [ax + (bx - ax) * t, az + (bz - az) * t, (bx - ax) / l, (bz - az) / l];
    }
    acc += l;
  }
  return [pts[0][0], pts[0][1], 1, 0];
}
function ordinal(n) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }
function dedupe(pts) {
  const out = [pts[0]];
  for (const p of pts) { const q = out[out.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5) out.push(p); }
  return out;
}
function distToPolyline(p, pts) {
  let d = 1e9;
  for (let i = 0; i + 1 < pts.length; ++i) d = Math.min(d, segDist(p[0], p[1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return d;
}
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

// Road test area: one configuration per cell, labelled.
function generateTestArea() {
  const roads = [], tests = [];
  let nid = 0;
  const add = (profile, pts, name, extra) => { const r = Object.assign({ id: nid++, profile, pts, name, district: 'test' }, extra || {}); roads.push(r); return r; };
  const L = 52;                                         // half extent of each test road
  const pol = (c, ang, a, b) => [[c[0] + Math.cos(ang) * a, c[1] + Math.sin(ang) * a], [c[0] + Math.cos(ang) * b, c[1] + Math.sin(ang) * b]];
  const deg = Math.PI / 180;
  const cells = [];
  const SP = 140;
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) cells.push([(c - 1.5) * SP, (r - 1) * SP]);
  const T = (i, title, note) => { tests.push({ c: cells[i], title, note }); return cells[i]; };
  let c;
  c = T(0, '4-way, 90°', 'Street × street: crosswalks, stop lines, curb returns');
  add('street', pol(c, 0, -L, L), 'Street E-W'); add('street', pol(c, 90 * deg, -L, L), 'Street N-S');
  c = T(1, 'Avenue × avenue', 'Medians cut back to painted turn bays, arrows');
  add('avenue', pol(c, 0, -L - 8, L + 8), 'Avenue E-W'); add('avenue', pol(c, 90 * deg, -L, L), 'Avenue N-S');
  c = T(2, 'Acute crossing, 35°', 'Diagonal street crossing a straight street');
  add('street', pol(c, 0, -L, L), 'Street'); add('street', pol(c, 35 * deg, -L, L), 'Diagonal street');
  c = T(3, 'Y-junction, 120°', 'Three streets at obtuse angles');
  add('street', pol(c, 90 * deg, 0, L), 'Stem'); add('street', pol(c, 210 * deg, 0, L), 'Branch A'); add('street', pol(c, 330 * deg, 0, L), 'Branch B');
  c = T(4, 'T-junction', 'Residential street ending at a street');
  add('street', pol(c, 0, -L, L), 'Through street'); add('residential', pol(c, 90 * deg, 0, L), 'Side street');
  c = T(5, 'Curve meets straight', 'Curved street joining an avenue');
  add('avenue', pol(c, 0, -L - 8, L + 8), 'Avenue');
  add('street', bezier([c[0] - 10, c[1]], [c[0] - 10, c[1] + 25], [c[0] + 25, c[1] + 20], [c[0] + 45, c[1] + 50], 2), 'Curved street');
  c = T(6, 'Five-way junction', 'Two crossing streets and a diagonal ending');
  add('street', pol(c, 0, -L, L), 'E-W'); add('street', pol(c, 90 * deg, -L, L), 'N-S'); add('residential', pol(c, 225 * deg, 0, L), 'Diagonal');
  c = T(7, 'Offset intersection', 'Side streets entering 20 m apart');
  add('street', pol(c, 90 * deg, -L, L), 'Main street');
  add('residential', [[c[0] - L, c[1] - 10], [c[0], c[1] - 10]], 'West side street');
  add('residential', [[c[0], c[1] + 10], [c[0] + L, c[1] + 10]], 'East side street');
  c = T(8, 'Width change', 'Lane meets an avenue; street narrows to a lane');
  add('avenue', pol(c, 0, -L - 8, L + 8), 'Avenue'); add('lane', pol(c, 90 * deg, 0, L), 'Lane');
  add('street', [[c[0] + 20, c[1] - L], [c[0] + 20, c[1] - 25]], 'Street'); add('lane', [[c[0] + 20, c[1] - 25], [c[0] + 20, c[1] - 12]], 'Lane end');
  c = T(9, 'Cul-de-sac', 'Dead end with a turning circle');
  add('street', pol(c, 0, -L, L), 'Street'); add('lane', bezier([c[0], c[1]], [c[0] + 5, c[1] + 18], [c[0] - 5, c[1] + 30], [c[0] + 6, c[1] + 44], 2), 'Court', { bulbEnd: 10.5 });
  c = T(10, 'Alleys', 'Alley into a street, alley crossing, alley dead end');
  add('street', pol(c, 90 * deg, -L, L), 'Street');
  add('alley', [[c[0], c[1] - 15], [c[0] + L, c[1] - 15]], 'Alley'); add('alley', [[c[0] + 30, c[1] - L], [c[0] + 30, c[1] + 20]], 'Alley');
  add('alley', [[c[0] - L, c[1] + 18], [c[0], c[1] + 18]], 'Alley');
  c = T(11, 'S-curve boulevard', 'Median and lane lines along a reversing curve');
  add('boulevard', bezier([c[0] - L - 8, c[1] - 25], [c[0] - 5, c[1] - 30], [c[0] + 5, c[1] + 30], [c[0] + L + 8, c[1] + 25], 2), 'Boulevard');
  add('street', pol([c[0], c[1]], 90 * deg, 20, L), 'Cross street');
  return { kind: 'test', bounds: { x0: -2 * SP - 10, z0: -1.5 * SP - 10, x1: 2 * SP + 10, z1: 1.5 * SP + 10 }, roads, areas: [], tests };
}

// ------------------------------------------------------------------------------------------------ 3. fields
// Coarse distance-field sampling of the whole network. Per sample:
//   car   carriageway SDF (negative on asphalt), smooth union over roads -> rounded curb returns
//   road  nearest road id, u (lateral, + left), s (arc length) on it
//   oth   carriageway SDF of the nearest OTHER road (intersection zones, crosswalks, marking termination)
//   ahead +1 if the other road lies ahead along the nearest road's +t direction, -1 behind
//   sw    sidewalk width (blended between roads at corners)
//   road2, s2  second-nearest road and its arc length (corner plots)
class FieldSampler {
  constructor(net, cell) {
    this.net = net;
    this.cell = cell;
    const b = net.bounds;
    this.x0 = b.x0 - 6; this.z0 = b.z0 - 6;
    this.nx = Math.ceil((b.x1 - b.x0 + 12) / cell) + 2;
    this.nz = Math.ceil((b.z1 - b.z0 + 12) / cell) + 2;
    const n = this.nx * this.nz;
    this.car = new Float32Array(n); this.oth = new Float32Array(n); this.sw = new Float32Array(n);
    this.u = new Float32Array(n); this.s = new Float32Array(n); this.s2 = new Float32Array(n);
    this.road = new Int16Array(n); this.road2 = new Int16Array(n); this.ahead = new Int8Array(n);
    this.prepare();
  }
  prepare() {
    const roads = this.net.roads;
    this.segs = [];
    let maxReach = 0;
    for (const r of roads) {
      const P = PROFILES[r.profile];
      r.P = P;
      r.len = 0;
      for (let i = 0; i + 1 < r.pts.length; ++i) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        this.segs.push({ road: r.id, ax, az, bx, bz, len, tx: (bx - ax) / len, tz: (bz - az) / len, s0: r.len, half: P.half });
        r.len += len;
      }
      if (r.bulbEnd) {
        const [ex, ez] = r.pts[r.pts.length - 1];
        this.segs.push({ road: r.id, ax: ex, az: ez, bx: ex, bz: ez, len: 0, tx: 1, tz: 0, s0: r.len, half: r.bulbEnd, bulb: true });
      }
      maxReach = Math.max(maxReach, (r.bulbEnd || P.half) + P.sidewalk + P.radius + 8);
    }
    // segment buckets
    const B = 16;
    this.B = B;
    this.bx = Math.ceil(this.nx * this.cell / B) + 1;
    this.bz = Math.ceil(this.nz * this.cell / B) + 1;
    this.buckets = Array.from({ length: this.bx * this.bz }, () => []);
    this.segs.forEach((sg, i) => {
      const reach = sg.half + PROFILES[roads[sg.road].profile].sidewalk + 12 + 34;   // + plot depth for road2/s2
      const x0 = Math.floor((Math.min(sg.ax, sg.bx) - reach - this.x0) / B), x1 = Math.floor((Math.max(sg.ax, sg.bx) + reach - this.x0) / B);
      const z0 = Math.floor((Math.min(sg.az, sg.bz) - reach - this.z0) / B), z1 = Math.floor((Math.max(sg.az, sg.bz) + reach - this.z0) / B);
      for (let z = Math.max(0, z0); z <= Math.min(this.bz - 1, z1); ++z)
        for (let x = Math.max(0, x0); x <= Math.min(this.bx - 1, x1); ++x) this.buckets[z * this.bx + x].push(i);
    });
    this.nRoads = roads.length;
  }
  // evaluate one point (full precision)
  evalPoint(px, pz, out, skipAlleys) {
    const roads = this.net.roads;
    const bi = clamp(Math.floor((px - this.x0) / this.B), 0, this.bx - 1) + clamp(Math.floor((pz - this.z0) / this.B), 0, this.bz - 1) * this.bx;
    const list = this.buckets[bi];
    const dR = this._d || (this._d = new Float64Array(this.nRoads).fill(1e9));
    const sR = this._s || (this._s = new Float64Array(this.nRoads));
    const uR = this._u || (this._u = new Float64Array(this.nRoads));
    const qx = this._qx || (this._qx = new Float64Array(this.nRoads));
    const qz = this._qz || (this._qz = new Float64Array(this.nRoads));
    const tx = this._tx || (this._tx = new Float64Array(this.nRoads));
    const tz = this._tz || (this._tz = new Float64Array(this.nRoads));
    const touched = this._t || (this._t = []);
    touched.length = 0;
    for (let k = 0; k < list.length; ++k) {
      const sg = this.segs[list[k]];
      if (skipAlleys && roads[sg.road].P.id === 'alley') continue;
      const t = sg.len > 0 ? ((px - sg.ax) * sg.tx + (pz - sg.az) * sg.tz) : 0;
      const tc = t < 0 ? 0 : t > sg.len ? sg.len : t;
      const cx = sg.ax + sg.tx * tc, cz = sg.az + sg.tz * tc;
      const ex = px - cx, ez = pz - cz;
      const d = Math.sqrt(ex * ex + ez * ez) - sg.half;
      const r = sg.road;
      if (dR[r] >= 1e8) touched.push(r);
      if (d < dR[r]) {
        dR[r] = d; sR[r] = sg.s0 + tc;
        uR[r] = sg.bulb ? 1e3 : (sg.tx * (pz - sg.az) - sg.tz * (px - sg.ax)) * -1;   // + left of +t
        qx[r] = cx; qz[r] = cz; tx[r] = sg.tx; tz[r] = sg.tz;
      }
    }
    let j = -1, j2 = -1, dj = 1e9, dj2 = 1e9, wsum = 0, swsum = 0;
    for (let i = 0; i < touched.length; ++i) {
      const r = touched[i], d = dR[r];
      if (d < dj) { dj2 = dj; j2 = j; dj = d; j = r; } else if (d < dj2) { dj2 = d; j2 = r; }
      const w = 1 / Math.pow(Math.max(d, 0.5), 3);
      wsum += w; swsum += w * roads[r].P.sidewalk;
    }
    // Curb returns: smooth union of the two nearest roads. The fillet grows as the corner gets sharper
    // (radius / sin(crossing angle), up to 2.6x) so acute corners end in a rounded nose, not a thin spike.
    let car = dj;
    if (j2 >= 0) {
      const sinA = Math.abs(tx[j] * tz[j2] - tz[j] * tx[j2]);
      const k = Math.min(roads[j].P.radius, roads[j2].P.radius) * clamp(1 / Math.max(sinA, 0.3), 1, 1.5);
      car = smin(dj, dj2, k);
      for (let i = 0; i < touched.length; ++i) {
        const r = touched[i];
        if (r !== j && r !== j2) car = smin(car, dR[r], Math.min(roads[j].P.radius, roads[r].P.radius));
      }
    }
    out.car = touched.length ? car : 1e3;
    out.road = j; out.road2 = j2;
    out.u = j >= 0 ? uR[j] : 0; out.s = j >= 0 ? sR[j] : 0; out.s2 = j2 >= 0 ? sR[j2] : 0;
    out.oth = j2 >= 0 ? dj2 : 1e3;
    out.dj = dj;
    out.ahead = (j >= 0 && j2 >= 0) ? (((qx[j2] - px) * tx[j] + (qz[j2] - pz) * tz[j]) >= 0 ? 1 : -1) : 0;
    out.sw = wsum > 0 ? swsum / wsum : 0;
    for (let i = 0; i < touched.length; ++i) dR[touched[i]] = 1e9;
  }
  // Junction intervals per road, along its arc length: where another road's carriageway reaches this road's
  // curb lines. Markings stop there; crosswalks and stop lines are placed square to the road just outside.
  // Intervals caused only by alleys are 'minor' (markings run through, no crosswalk).
  computeJunctions() {
    const o = {};
    for (const r of this.net.roads) {
      r.junctions = [];
      if (!r.len) continue;
      const half = r.P.half, step = 0.25;
      let cur = null;
      for (let s = 0; s <= r.len; s += step) {
        const [px, pz, tx, tz] = pointAt(r, s);
        let hit = false, major = false;
        const others = new Set();
        for (const side of [1, -1]) {
          const ex = px + tz * side * (half + 0.1), ez = pz - tx * side * (half + 0.1);
          this.evalPoint(ex, ez, o);
          const otherId = o.road === r.id ? o.road2 : o.road;
          const dOther = o.road === r.id ? o.oth : o.dj;
          if (otherId >= 0 && dOther < 0.2) {
            hit = true;
            if (this.net.roads[otherId].P.id !== 'alley' || r.P.id === 'alley') { major = true; others.add(otherId); }
          }
        }
        if (hit) {
          if (cur && s - cur.b <= step * 1.5) { cur.b = s; cur.major = cur.major || major; others.forEach(o => cur.others.add(o)); }
          else { cur = { a: s, b: s, major, others: new Set(others) }; r.junctions.push(cur); }
        }
      }
      // junctions closer than 22 m act as one: no crosswalks, stop lines or lane boxes squeezed in between
      const merged = [];
      for (const j of r.junctions) {
        const last = merged.length ? merged[merged.length - 1] : null;
        if (last && last.major && j.major && j.a - last.b < 22) { last.b = j.b; j.others.forEach(o => last.others.add(o)); }
        else merged.push(j);
      }
      r.junctions = merged;
    }
    // crosswalk placement per approach: both ends must land on a curb / sidewalk. If the far side opens onto
    // another road (skewed junctions), the crosswalk slides back up to 10 m; with no sidewalk it is dropped.
    const e = {};
    for (const r of this.net.roads) {
      for (const j of r.junctions) {
        if (!j.major) continue;
        const half = r.P.half;
        const test = (sCenter) => {
          if (sCenter < 0 || sCenter > r.len) return false;
          const [px, pz, tx, tz] = pointAt(r, sCenter);
          for (const side of [1, -1]) {
            this.evalPoint(px + tz * side * (half + 0.9), pz - tx * side * (half + 0.9), e);
            if (e.car < 0.25) return false;
          }
          return true;
        };
        const find = (dir, edge) => {
          for (let extra = 0; extra <= 10; extra += 1) if (test(edge + dir * (0.8 + extra + 1.6))) return extra;
          return -1;
        };
        j.cwA = r.P.crosswalk ? find(-1, j.a) : -1;
        j.cwB = r.P.crosswalk ? find(1, j.b) : -1;
      }
    }
  }
  // (call after computeJunctions) junction intervals as plain data
  junctionData() { return this.net.roads.map(r => (r.junctions || []).map(j => ({ a: j.a, b: j.b, major: j.major, others: [...j.others] }))); }
  // length of the raised-median stretch containing s (between the cut-backs of the junctions on either side)
  medianRun(r, s, cut) {
    let before = 0, after = r.len;
    for (const j of r.junctions) {
      if (!j.major) continue;
      if (j.b < s) before = Math.max(before, j.b + cut);
      if (j.a > s) after = Math.min(after, j.a - cut);
    }
    return after - before;
  }
  // distance along the road to the nearest major junction interval; 0 inside one; ahead = +1 if it lies at larger s
  junctionAt(r, s) {
    let best = 1e9, ahead = 0, bestJ = null;
    const J = r.junctions;
    for (let i = 0; i < J.length; ++i) {
      const j = J[i];
      if (!j.major) continue;
      if (s >= j.a && s <= j.b) return [0, 0, j];
      const d = s < j.a ? j.a - s : s - j.b;
      if (d < best) { best = d; ahead = s < j.a ? 1 : -1; bestJ = j; }
    }
    return [best, ahead, bestJ];
  }
  build(onProgress) {
    this.computeJunctions();
    const o = {};
    for (let z = 0; z < this.nz; ++z) {
      for (let x = 0; x < this.nx; ++x) {
        const i = z * this.nx + x;
        this.evalPoint(this.x0 + x * this.cell, this.z0 + z * this.cell, o);
        this.car[i] = o.car; this.oth[i] = o.oth; this.sw[i] = o.sw; this.u[i] = o.u; this.s[i] = o.s; this.s2[i] = o.s2;
        this.road[i] = o.road; this.road2[i] = o.road2; this.ahead[i] = o.ahead;
      }
      if (onProgress && (z & 31) === 0) onProgress(z / this.nz);
    }
    this.labelBlocks();
  }
  // City blocks = connected regions outside every carriageway (4-connected on the coarse grid).
  // Tiny regions enclosed by asphalt (left over where three or more roads blend) are filled with asphalt:
  // no stray curb islands inside junctions. The block labels also let open spaces take whole blocks.
  labelBlocks() {
    const nx = this.nx, nz = this.nz, n = nx * nz, car = this.car;
    const comp = new Int32Array(n).fill(-1), size = [], border = [];
    const stack = new Int32Array(n);
    let id = 0;
    for (let i = 0; i < n; ++i) {
      if (car[i] <= 0 || comp[i] >= 0) continue;
      let sp = 0, cnt = 0, touches = false;
      stack[sp++] = i; comp[i] = id;
      while (sp) {
        const k = stack[--sp]; ++cnt;
        const x = k % nx, z = (k / nx) | 0;
        if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1) touches = true;
        if (x > 0 && car[k - 1] > 0 && comp[k - 1] < 0) { comp[k - 1] = id; stack[sp++] = k - 1; }
        if (x < nx - 1 && car[k + 1] > 0 && comp[k + 1] < 0) { comp[k + 1] = id; stack[sp++] = k + 1; }
        if (z > 0 && car[k - nx] > 0 && comp[k - nx] < 0) { comp[k - nx] = id; stack[sp++] = k - nx; }
        if (z < nz - 1 && car[k + nx] > 0 && comp[k + nx] < 0) { comp[k + nx] = id; stack[sp++] = k + nx; }
        // diagonal neighbours too: thin sidewalk noses stay attached to their block
        for (const dk of [-nx - 1, -nx + 1, nx - 1, nx + 1]) {
          const q = k + dk, qx = q % nx;
          if (q >= 0 && q < n && Math.abs(qx - x) === 1 && car[q] > 0 && comp[q] < 0) { comp[q] = id; stack[sp++] = q; }
        }
      }
      size.push(cnt); border.push(touches); ++id;
    }
    const minArea = 60 / (this.cell * this.cell);                 // m2
    const maxCar = new Float32Array(id);
    for (let i = 0; i < n; ++i) if (comp[i] >= 0 && car[i] > maxCar[comp[i]]) maxCar[comp[i]] = car[i];
    const fill = (c) => c >= 0 && !border[c] && size[c] < minArea;   // small curb islands left inside junctions
    this.islandsFilled = 0;
    this.filled = new Uint8Array(n);
    for (let c = 0; c < id; ++c) if (fill(c)) this.islandsFilled++;
    for (let i = 0; i < n; ++i) if (fill(comp[i])) { car[i] = -1.0; comp[i] = -1; this.filled[i] = 1; }
    // and a 1 m margin around each filled island: no gutter ring left behind
    const r = Math.ceil(1.0 / this.cell), mark = [];
    for (let i = 0; i < n; ++i) if (this.filled[i] === 1) {
      const x = i % nx, z = (i / nx) | 0;
      for (let dz = -r; dz <= r; ++dz) for (let dx = -r; dx <= r; ++dx) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
        const k = zz * nx + xx;
        if (!this.filled[k] && car[k] <= 0) mark.push(k);
      }
    }
    for (const k of mark) { car[k] = Math.min(car[k], -1.0); this.filled[k] = 1; }
    this.comp = comp; this.compSize = size;
    // gradient magnitude of the carriageway field: the smooth union is not a true distance in the fillets,
    // so curb / gutter / sidewalk widths divide by it (constant widths everywhere)
    const g = this.grad = new Float32Array(n).fill(1);
    for (let z = 1; z < nz - 1; ++z) for (let x = 1; x < nx - 1; ++x) {
      const i = z * nx + x;
      const gx = (car[i + 1] - car[i - 1]) / (2 * this.cell), gz = (car[i + nx] - car[i - nx]) / (2 * this.cell);
      g[i] = clamp(Math.sqrt(gx * gx + gz * gz), 0.25, 1.5);
    }
  }
  isFilled(px, pz) {
    const ix = clamp(Math.round((px - this.x0) / this.cell), 0, this.nx - 1), iz = clamp(Math.round((pz - this.z0) / this.cell), 0, this.nz - 1);
    return this.filled[iz * this.nx + ix] === 1;
  }
  blockAt(px, pz) {
    const ix = clamp(Math.round((px - this.x0) / this.cell), 0, this.nx - 1), iz = clamp(Math.round((pz - this.z0) / this.cell), 0, this.nz - 1);
    return this.comp[iz * this.nx + ix];
  }
  // bilinear sample (u, s exact only when all four corners agree on the nearest road)
  sample(px, pz, o) {
    const gx = (px - this.x0) / this.cell, gz = (pz - this.z0) / this.cell;
    let ix = Math.floor(gx), iz = Math.floor(gz);
    ix = clamp(ix, 0, this.nx - 2); iz = clamp(iz, 0, this.nz - 2);
    const fx = gx - ix, fz = gz - iz;
    const i00 = iz * this.nx + ix, i10 = i00 + 1, i01 = i00 + this.nx, i11 = i01 + 1;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    const L = (a) => a[i00] * w00 + a[i10] * w10 + a[i01] * w01 + a[i11] * w11;
    o.car = L(this.car); o.oth = L(this.oth); o.sw = L(this.sw); o.g = this.grad ? L(this.grad) : 1;
    o.filled = this.filled ? (this.filled[i00] | this.filled[i10] | this.filled[i01] | this.filled[i11]) === 1 : false;
    const near = fx < 0.5 ? (fz < 0.5 ? i00 : i01) : (fz < 0.5 ? i10 : i11);
    const r = this.road[near];
    o.road = r; o.road2 = this.road2[near]; o.ahead = this.ahead[near];
    o.same = this.road[i00] === r && this.road[i10] === r && this.road[i01] === r && this.road[i11] === r;
    if (o.same) { o.u = L(this.u); o.s = L(this.s); }
    else { o.u = this.u[near]; o.s = this.s[near]; }
    o.s2 = this.s2[near];
  }
}

// ------------------------------------------------------------------------------------------------ 4. rasterizer
// Materials (index into the palette). Flat colours; variation only from geometry and a few deliberate tones.
const MAT = {
  ASPHALT: 0, ASPHALT_B: 1, ASPHALT_C: 2, GUTTER: 3, PAINT_WHITE: 4, PAINT_YELLOW: 5, CURB: 6, SIDEWALK: 7, SIDEWALK_JOINT: 8,
  MEDIAN_CURB: 9, MEDIAN_GRASS: 10, PLOT: 11, PLAZA: 12, PLAZA_JOINT: 13, PARK: 14, ALLEY: 15, YARD: 16, LOT: 17, PARK_PATH: 18,
  BUILDING_A: 19, BUILDING_B: 20, BUILDING_C: 21, BUILDING_ROOF: 22, PARKING: 23, CROSSWALK: 24,
  BUILDING_D: 25, BUILDING_E: 26, BUILDING_F: 27, ROOF_B: 28
};
// muted, slightly washed-out palette (sRGB 0..255); renderer converts to linear
const PALETTE = [
  [118, 116, 118], [111, 110, 114], [124, 121, 120], [98, 97, 101], [206, 202, 190], [204, 170, 92], [196, 192, 182], [184, 180, 170], [170, 166, 157],
  [190, 186, 176], [128, 150, 104], [194, 186, 168], [198, 188, 170], [178, 168, 151], [138, 160, 110], [142, 138, 136], [154, 168, 124], [176, 166, 146], [196, 184, 158],
  [216, 206, 190], [196, 194, 190], [226, 220, 206], [168, 164, 158], [128, 126, 128], [210, 206, 194],
  [206, 184, 168], [186, 196, 202], [214, 198, 168], [156, 160, 164]
];
const MAT_NAMES = Object.keys(MAT);
const BUILDING_TONES = [19, 20, 21, 25, 26, 27];

class Rasterizer {
  constructor(net, fields, voxel, opts) {
    this.net = net; this.F = fields; this.v = voxel;
    this.hs = Math.max(1, Math.round(0.15 / voxel + 1e-6)); // curb / sidewalk height in voxels (15 cm, rounded)
    this.opts = opts || {};
    this.areas = net.areas || [];
    this.roads = net.roads;
  }
  // Open spaces take whole city blocks: a block belongs to a circle / rectangle area when at least 35 % of it
  // lies inside the shape (no plaza edges cutting across a block). 'side' areas follow one road.
  blockAreas() {
    const F = this.F, cnt = new Map(), inside = new Map();
    for (let iz = 0; iz < F.nz; ++iz) for (let ix = 0; ix < F.nx; ++ix) {
      const c = F.comp[iz * F.nx + ix];
      if (c < 0) continue;
      cnt.set(c, (cnt.get(c) || 0) + 1);
      const x = F.x0 + ix * F.cell, z = F.z0 + iz * F.cell;
      this.areas.forEach((a, k) => {
        const hit = a.shape === 'circle' ? Math.hypot(x - a.c[0], z - a.c[1]) < a.r : a.shape === 'rect' ? (x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1) : false;
        if (hit) { const key = c * 8 + k; inside.set(key, (inside.get(key) || 0) + 1); }
      });
    }
    this.blockArea = new Map();
    for (const [key, v] of inside) {
      const c = Math.floor(key / 8), k = key % 8;
      if (v / cnt.get(c) >= 0.35 && v * F.cell * F.cell < 25000) this.blockArea.set(c, this.areas[k].kind);
    }
    // pocket plazas: in the city (downtown / along avenues), small blocks and wedge-shaped slivers left between
    // diagonal and grid streets are paved squares with kiosks, not building plots
    if (this.net.kind === 'city') {
      const st = new Map();
      for (let iz = 0; iz < F.nz; ++iz) for (let ix = 0; ix < F.nx; ++ix) {
        const i = iz * F.nx + ix, c = F.comp[i];
        if (c < 0) continue;
        let b = st.get(c);
        if (!b) st.set(c, b = { n: 0, x0: ix, x1: ix, z0: iz, z1: iz, art: 0, dt: 0, res: 0, maxd: 0 });
        b.n++; b.x0 = Math.min(b.x0, ix); b.x1 = Math.max(b.x1, ix); b.z0 = Math.min(b.z0, iz); b.z1 = Math.max(b.z1, iz);
        const r = this.roads[F.road[i]];
        if (r) { if (r.P.cls === 'arterial') b.art++; if (r.district === 'downtown') b.dt++; if (r.district === 'residential') b.res++; }
        b.maxd = Math.max(b.maxd, F.car[i] - F.sw[i]);
      }
      this.pocket = 0;
      for (const [c, b] of st) {
        if (this.blockArea.has(c)) continue;
        const area = b.n * F.cell * F.cell, fill = b.n / ((b.x1 - b.x0 + 1) * (b.z1 - b.z0 + 1));
        const urban = (b.art + b.dt) > b.n * 0.3 && b.res < b.n * 0.3;
        if (urban && (area < 900 || (fill < 0.62 && area < 3500) || (fill < 0.78 && b.maxd < 12.5) || b.maxd < 8)) { this.blockArea.set(c, 'pocket'); this.pocket++; }
      }
    }
  }
  areaAt(x, z, road, u) {
    if (!this.blockArea) this.blockAreas();
    const c = this.F.blockAt(x, z);
    if (c >= 0 && this.blockArea.has(c)) return this.blockArea.get(c);
    for (const a of this.areas) if (a.shape === 'side' && road === a.road && u * a.side > 0) return a.kind;
    return null;
  }
  // classify one column -> [height in voxels, material]
  classify(x, z, o, out) {
    const F = this.F, hs = this.hs, v = this.v;
    F.sample(x, z, o);
    if (o.road < 0 || o.car > 900) { out[0] = hs; out[1] = MAT.PLOT; return; }
    // near the curb line the carriageway field is evaluated exactly (no interpolation wobble), and divided
    // by its gradient so that curb, gutter and sidewalk widths are true metres in the curb returns too
    let carRaw = o.car;
    if (Math.abs(carRaw) < 1.0 && !o.filled) { const e = this._e || (this._e = {}); F.evalPoint(x, z, e); carRaw = e.car; }
    const car = carRaw / o.g;
    const road = this.roads[o.road], P = road.P;
    const minLine = Math.max(0.06, v * 0.75);               // >= 1.5 voxels wide: diagonal lines stay connected
    if (car < 0) {
      if (P.id === 'alley') {
        out[0] = 0;
        // an alley mouth inside a street's carriageway is street asphalt
        if (o.road2 >= 0 && o.oth < 0 && this.roads[o.road2].P.id !== 'alley') { out[1] = MAT.ASPHALT; return; }
        out[1] = car > -0.3 ? MAT.GUTTER : MAT.ALLEY; return;
      }
      out[0] = 0;
      if (car > -0.35) { out[1] = MAT.GUTTER; return; }
      const u = o.u, s = o.s;
      const [jd, ahead, jn] = this.F.junctionAt(road, s);
      // asphalt tone: resurfaced stretches along each road between junctions; junction boxes plain
      const tone = jd === 0 ? 0 : hash2(road.id, Math.floor(s / 47), 11);
      const m = tone < 0.62 ? MAT.ASPHALT : tone < 0.84 ? MAT.ASPHALT_B : MAT.ASPHALT_C;
      if (jd === 0) { out[1] = MAT.ASPHALT; return; }                 // inside the junction: clean asphalt
      // crosswalk + stop line, square to this road, measured from the junction interval
      const extra = jn ? (ahead > 0 ? jn.cwA : jn.cwB) : -1;            // crosswalk offset on this approach (-1: none)
      const cw0 = 0.8 + Math.max(0, extra), cwW = 3.2, stop0 = cw0 + cwW + 0.7, stopW = Math.max(0.3, v * 2.5);
      const crossing = P.crosswalk && extra >= 0;
      if (crossing && jd > cw0 && jd < cw0 + cwW) {                   // bars parallel to traffic, curb to curb
        out[1] = (((u + P.half) / 1.2) % 1 + 1) % 1 < 0.55 ? MAT.CROSSWALK : MAT.ASPHALT; return;
      }
      if (Math.abs(u) > P.half) { out[1] = jd < stop0 ? MAT.ASPHALT : m; return; }   // curb-return flare, bulbs
      let e = null;
      for (const b of P.edges) if (u <= b.left && u >= b.right) { e = b; break; }
      if (!e) { out[1] = m; return; }
      // a lane is inbound when its travel direction points at the junction
      const inbound = e.type === 'lane' && ahead !== 0 && e.dir === ahead;
      if (jd < stop0) { out[1] = MAT.ASPHALT; return; }
      if (inbound && jd < stop0 + stopW && jd < 1e8) { out[1] = MAT.PAINT_WHITE; return; }
      if (e.type === 'median') {
        const cut = stop0 + 14;                                        // median ends 14 m before the stop line
        const inside = Math.min(e.left - u, u - e.right);
        const run = this.F.medianRun(road, s, cut);
        if (jd > cut && run > 16) {
          out[0] = hs;
          out[1] = inside < Math.max(0.18, v * 1.6) ? MAT.MEDIAN_CURB : (P.median === 'planted' ? MAT.MEDIAN_GRASS : MAT.MEDIAN_CURB);
          return;
        }
        // painted turn bay: yellow edges, a left-turn arrow on the half next to the inbound lanes
        if (inside < minLine * 1.6) { out[1] = MAT.PAINT_YELLOW; return; }
        const mid = (e.left + e.right) / 2;
        const bayLeft = ahead > 0 ? u < mid : u > mid;                 // inbound (+t) traffic is on the u < 0 side
        if (bayLeft && P.arrows) {
          const lc = (mid + (ahead > 0 ? e.right : e.left)) / 2;
          // lateral axis towards the driver's left: +u for +t traffic
          if (arrowGlyph((u - lc) * ahead, jd - stop0 - 2.5, true, minLine)) { out[1] = MAT.PAINT_WHITE; return; }
        }
        out[1] = m; return;
      }
      if (e.type === 'park') {
        out[1] = MAT.PARKING;
        const toLane = e.left === P.half ? u - e.right : e.left - u;   // distance to the lane-side edge
        if (toLane < minLine) { out[1] = MAT.PAINT_WHITE; return; }
        if (((s % 6.4) + 6.4) % 6.4 < Math.max(0.12, v * 1.05) && toLane < e.w * 0.45) { out[1] = MAT.PAINT_WHITE; return; }
        return;
      }
      out[1] = m;
      const dash = ((s % 12.2) + 12.2) % 12.2 < 3.05;
      for (let k = 0; k + 1 < P.edges.length; ++k) {
        const b = P.edges[k], next = P.edges[k + 1];
        if (b.type !== 'lane' || next.type !== 'lane') continue;
        const bd = Math.abs(u - b.right);
        if (b.dir === next.dir) { if (bd < minLine && dash) { out[1] = MAT.PAINT_WHITE; return; } }
        else if (P.centre === 'double') { if (Math.abs(bd - 0.14) < minLine * 0.9) { out[1] = MAT.PAINT_YELLOW; return; } }
        else if (P.centre === 'dashed') { if (bd < minLine && dash) { out[1] = MAT.PAINT_YELLOW; return; } }
      }
      // lane arrows on the approaches of arterials and one-way streets
      if (inbound && P.arrows) {
        const lc = (e.left + e.right) / 2;
        if (arrowGlyph((u - lc) * ahead, jd - stop0 - 2.5, false, minLine)) out[1] = MAT.PAINT_WHITE;
      }
      return;
    }
    // outside the carriageway: curb, sidewalk, block
    if (P.id === 'alley' && car < 0.6 && o.road2 >= 0 && o.oth > 0.6) { out[0] = hs; out[1] = MAT.CURB; return; }
    if (car < Math.max(0.16, v * 1.6)) { out[0] = hs; out[1] = MAT.CURB; return; }
    const area = this.areaAt(x, z, o.road, o.u);
    if (car < o.sw) {
      out[0] = hs;
      // slab joints across the sidewalk every 1.6 m along the nearest street, one voxel wide
      const ss = ((o.s % 1.6) + 1.6) % 1.6;
      out[1] = (o.same && o.oth - o.car > 3 && ss < v * 0.999) ? MAT.SIDEWALK_JOINT : MAT.SIDEWALK;
      return;
    }
    out[0] = hs;
    if (area === 'plaza' || area === 'square' || area === 'pocket') { out[1] = plazaTile(x, z, v); return; }
    if (area === 'park') { out[1] = parkSurface(x, z, v); return; }
    if (area === 'lot') { out[1] = MAT.LOT; return; }
    out[1] = road.district === 'residential' ? MAT.YARD : MAT.PLOT;
  }
}
function plazaTile(x, z, v) {
  const t = 2.4, fx = ((x % t) + t) % t, fz = ((z % t) + t) % t;
  return (fx < v * 0.999 || fz < v * 0.999) ? MAT.PLAZA_JOINT : MAT.PLAZA;
}
function parkSurface(x, z, v) {
  // gravel paths on a loose diagonal lattice
  const a = (x * 0.7071 + z * 0.7071), b = (x * 0.7071 - z * 0.7071);
  const pa = ((a % 38) + 38) % 38, pb = ((b % 51) + 51) % 51;
  return (pa < 2.6 || pb < 2.6) ? MAT.PARK_PATH : MAT.PARK;
}
// arrow glyph in lane-local coordinates: a = lateral from lane centre (+ = towards the driver's left),
// b = metres before the glyph tip (0 at the tip, increasing away from the junction)
function arrowGlyph(a, b, left, w) {
  // US pavement arrows, 6 m long. b: metres back from the tip end (0 = towards the junction), a: lateral
  // (+ = driver's left). Straight: 1.8 m head, 0.3 m shaft. Left turn: shaft, a bend to the left, and a full
  // triangular head pointing left.
  const sw = Math.max(0.15, w * 0.5);
  if (b < 0 || b > 6.2) return false;
  if (!left) {
    if (b < 1.8) return Math.abs(a) <= 0.6 * (b / 1.8) + w * 0.3;
    return Math.abs(a) <= sw && b < 6.0;
  }
  if (Math.abs(a) <= sw && b >= 2.0 && b <= 6.0) return true;               // shaft
  if (b >= 2.0 - sw && b <= 2.0 + sw && a >= -sw && a <= 0.95) return true;  // bend towards the left
  if (a >= 0.95 && a <= 2.2) return Math.abs(b - 2.0) <= 0.85 * (2.2 - a) / 1.25 + w * 0.3;   // head
  return false;
}

// ------------------------------------------------------------------------------------------------ 5. plots
// Building plots from the network on a coarser building grid: every block column takes its frontage road
// (nearest street), a lot along that street (random widths per road) and a depth. Corners join the lower-id
// road's lot (L-shaped corner buildings). Interiors deeper than the lot depth stay open (courtyards).
class Plots {
  constructor(net, fields, raster, cell, seed) {
    this.net = net; this.F = fields; this.Ra = raster; this.cell = cell; this.seed = seed;
    const b = net.bounds;
    this.x0 = b.x0; this.z0 = b.z0;
    this.nx = Math.ceil((b.x1 - b.x0) / cell); this.nz = Math.ceil((b.z1 - b.z0) / cell);
    this.lots = net.roads.map(r => this.lotCuts(r));
  }
  district(r) { return r.district; }
  // true when the two roads meet at an angle near (x, z) (not parallel neighbours)
  cornerish(a, b, x, z) {
    const ta = this.tangentNear(this.net.roads[a], x, z), tb = this.tangentNear(this.net.roads[b], x, z);
    return Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) > 0.35;
  }
  tangentNear(r, x, z) {
    let best = 1e9, t = [1, 0];
    for (let i = 0; i + 1 < r.pts.length; ++i) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const d = segDist(x, z, ax, az, bx, bz);
      if (d < best) { best = d; const l = Math.hypot(bx - ax, bz - az) || 1; t = [(bx - ax) / l, (bz - az) / l]; }
    }
    return t;
  }
  lotCuts(r) {
    const R = mulberry32(this.seed * 131 + r.id * 977 + 5);
    const P = PROFILES[r.profile];
    const d = r.district;
    const range = d === 'downtown' || d === 'arterial' ? [12, 32] : d === 'oldtown' ? [8, 18] : d === 'test' ? [10, 22] : [13, 20];
    const cuts = [0];
    let s = 0;
    const len = r.len || 0;
    const core = this.net.origins && this.net.origins.core;
    while (s < len + 40) {
      let rg = range;
      if (core && (d === 'downtown' || d === 'arterial') && len) {           // wide lots near the core: room for towers
        const [px, pz] = pointAt(r, Math.min(s + 15, len));
        if (Math.hypot(px - core[0], pz - core[1]) < 170) rg = [24, 40];
      }
      s += rg[0] + R() * (rg[1] - rg[0]); cuts.push(s);
    }
    return { cuts, gaps: cuts.map(() => (R() < (d === 'residential' ? 0.55 : 0.04) ? 4 + R() * 2 : 0)) };   // dense districts: attached
  }
  // per-lot parameters
  lotInfo(roadId, lot) {
    const r = this.net.roads[roadId];
    const h = hash2(roadId * 7 + 3, lot, this.seed);
    const h2 = hash2(roadId * 13 + 1, lot, this.seed + 7);
    const d = r.district;
    let stories, depth, setback;
    const P = r.P;
    if (d === 'downtown' || d === 'arterial') { stories = 6 + Math.floor(h * h * 10); depth = 70; setback = 0; if (P.cls === 'arterial') stories += 2; }
    else if (d === 'oldtown') { stories = 4 + Math.floor(h * 5); depth = 50; setback = 0; }
    else if (d === 'test') { stories = 3 + Math.floor(h * 6); depth = 16 + h2 * 10; setback = 0; }
    else { stories = 2 + Math.floor(h * 3); depth = 14 + h2 * 6; setback = 4 + h2 * 3; }
    if (P.id === 'alley') { stories = Math.max(2, stories - 3); }
    return { stories, depth, setback, tone: Math.floor(hash2(roadId, lot, 99) * 6) };
  }
  findLot(roadId, s) {
    const c = this.lots[roadId].cuts;
    let lo = 0, hi = c.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    return lo;
  }
  // Plot assignment for one point (exact): frontage street, lot along it, setback/depth/gap rules.
  //  - the higher-ranked of the two nearest streets claims a point inside its lot depth (avenues get continuous
  //    frontage, corner buildings sit on the main street); equal ranks: lower id, so corner lots are rectangles
  //  - alleys are ignored for frontage (buildings back onto them) but nothing is built on or over them
  assignAt(x, z, o) {
    const F = this.F, roads = this.net.roads;
    const rank = (r) => ({ arterial: 3, collector: 2, local: 1, alley: 0 })[r.P.cls];
    // o.cls / o.near: what the point is (0 nothing, 1 buildable block land, 2 open area, 3 street, 4 alley) and the
    // street it belongs to; the block placer (city_arch) cuts its blocks from the buildable land
    o.cls = 0; o.near = -1;
    F.sample(x, z, o);
    if (o.road < 0 || o.car > 900 || this.net.kind === 'test') return -1;
    o.near = o.road;
    if (this.Ra.areaAt(x, z, o.road, o.u)) { o.cls = 2; return -1; }
    if (o.car < 0.3 || (roads[o.road].P.id === 'alley' && o.car < 0.6)) { o.cls = roads[o.road].P.id === 'alley' ? 4 : 3; return -1; }   // on a road or an alley
    F.evalPoint(x, z, o, true);
    if (o.road < 0) return -1;
    o.near = o.road;
    // distances to the individual streets (not the rounded curb returns): square building corners
    let rid = o.road, s = o.s, d = o.dj - o.sw;
    if (d < 0.3 || o.oth - o.sw < 0.3) {
      if (d >= 0.3 && o.road2 >= 0) o.near = o.road2;
      o.cls = roads[o.near].P.id === 'alley' ? 4 : 3; return -1;
    }
    o.cls = 1;
    if (o.road2 >= 0) {
      const r2 = roads[o.road2], d2 = o.oth - o.sw;
      const i2 = this.lotInfo(o.road2, this.findLot(o.road2, o.s2));
      const better = rank(r2) > rank(roads[rid]) || (rank(r2) === rank(roads[rid]) && r2.id < rid);
      if (better && d2 < i2.setback + i2.depth && this.cornerish(rid, o.road2, x, z)) { rid = o.road2; s = o.s2; d = d2; }
    }
    if (rank(roads[rid]) === 0) return -1;
    if (roads[rid].district === 'residential' && roads[rid].P.cls === 'local') return -1;   // planned subdivisions (city_arch)
    const lot = this.findLot(rid, s);
    const info = this.lotInfo(rid, lot);
    if (d < info.setback || d > info.setback + info.depth) return -1;
    const L = this.lots[rid];
    if (L.gaps[lot] > 0 && s - L.cuts[lot] < L.gaps[lot]) return -1;
    return rid * 4096 + lot;
  }
  // Coarse plot map (this.cell): assignment, then cleaned per plot
  //  - morphological opening by a 6 m square (separable): no part of a building thinner than 6 m
  //  - plots under 120 m2 are dropped
  //  - stories: tall only where the plot is wide enough (inscribed radius); towers need 4 m of tower depth
  build() {
    const n = this.nx * this.nz, nx = this.nx, nz = this.nz;
    const P = new Int32Array(n).fill(-1);
    const o = {};
    this.base = new Uint8Array(n); this.near = new Int32Array(n);
    for (let iz = 0; iz < nz; ++iz)
      for (let ix = 0; ix < nx; ++ix) {
        const i = iz * nx + ix;
        P[i] = this.assignAt(this.x0 + (ix + 0.5) * this.cell, this.z0 + (iz + 0.5) * this.cell, o);
        this.base[i] = o.cls; this.near[i] = o.near;
      }
    const r = Math.max(1, Math.round(1.5 / this.cell));
    // erosion: horizontal then vertical runs of the same id covering +-r
    const E1 = new Int32Array(n).fill(-1), E = new Int32Array(n).fill(-1);
    for (let iz = 0; iz < nz; ++iz) {
      let runStart = 0;
      for (let ix = 0; ix <= nx; ++ix) {
        const id = ix < nx ? P[iz * nx + ix] : -2;
        if (ix === nx || id !== P[iz * nx + runStart]) {
          const a = runStart, b = ix - 1, rid = P[iz * nx + a];
          if (rid >= 0) for (let k = a + r; k <= b - r; ++k) E1[iz * nx + k] = rid;
          runStart = ix;
        }
      }
    }
    for (let ix = 0; ix < nx; ++ix) {
      let runStart = 0;
      for (let iz = 0; iz <= nz; ++iz) {
        const id = iz < nz ? E1[iz * nx + ix] : -2;
        if (iz === nz || id !== E1[runStart * nx + ix]) {
          const a = runStart, b = iz - 1, rid = E1[a * nx + ix];
          if (rid >= 0) for (let k = a + r; k <= b - r; ++k) E[k * nx + ix] = rid;
          runStart = iz;
        }
      }
    }
    // dilation back, restricted to the original plot
    const D1 = new Int32Array(n).fill(-1), O = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; ++i) {
      const id = E[i]; if (id < 0) continue;
      const x = i % nx;
      for (let dx = -r; dx <= r; ++dx) { const xx = x + dx; if (xx >= 0 && xx < nx && P[i + dx] === id) D1[i + dx] = id; }
    }
    for (let i = 0; i < n; ++i) {
      const id = D1[i]; if (id < 0) continue;
      const z = (i / nx) | 0;
      for (let dz = -r; dz <= r; ++dz) { const zz = z + dz; if (zz >= 0 && zz < nz && P[i + dz * nx] === id) O[i + dz * nx] = id; }
    }
    // a lot index covers both sides of its street: split every plot into its connected pieces
    // (new id = old id * 8 + piece), so each piece is its own building lot
    {
      const seen = new Int32Array(n).fill(-1), stack = [];
      const pieces = new Map();
      for (let i = 0; i < n; ++i) {
        if (O[i] < 0 || seen[i] >= 0) continue;
        const id = O[i], k = pieces.get(id) || 0; pieces.set(id, k + 1);
        const nid = k < 8 ? id * 8 + k : -1;
        stack.push(i); seen[i] = 1;
        const members = [];
        while (stack.length) {
          const q = stack.pop(); members.push(q);
          const x = q % nx;
          for (const dq of [-1, 1, -nx, nx]) {
            const r2 = q + dq;
            if (r2 < 0 || r2 >= n || seen[r2] >= 0 || O[r2] !== id) continue;
            if ((dq === -1 && x === 0) || (dq === 1 && x === nx - 1)) continue;
            seen[r2] = 1; stack.push(r2);
          }
        }
        for (const q of members) O[q] = nid;
      }
    }
    // drop small plots, measure each plot's inscribed radius (chamfer distance to its edge)
    const area = new Map();
    for (let i = 0; i < n; ++i) if (O[i] >= 0) area.set(O[i], (area.get(O[i]) || 0) + 1);
    const minCells = 120 / (this.cell * this.cell);
    for (let i = 0; i < n; ++i) if (O[i] >= 0 && area.get(O[i]) < minCells) O[i] = -1;
    const Dm = chamfer(O, nx, nz);
    const inR = new Map();
    for (let i = 0; i < n; ++i) if (O[i] >= 0) inR.set(O[i], Math.max(inR.get(O[i]) || 0, Dm[i] * this.cell));
    this.plot = O;
    this.plotCount = inR.size;
    // per plot: stories (capped by how wide the plot is), tower flag, tone
    this.info = new Map();
    for (const [id, rad] of inR) {
      const rid = Math.floor(id / 32768), lot = Math.floor(id / 8) % 4096;
      const li = this.lotInfo(rid, lot);
      let stories = li.stories;
      if (rad < 5) stories = Math.min(stories, 4);
      else if (rad < 7) stories = Math.min(stories, 7);
      const tower = stories >= 9 && rad - 3 >= 4;
      const podium = 3 + (hash2(id, 4, 9) * 2 | 0);
      this.info.set(id, { stories: tower ? stories : Math.min(stories, 8), tower, podium, tone: li.tone });
    }
    this.height = new Float32Array(n);
    this.tone = new Uint8Array(n);
    for (let i = 0; i < n; ++i) if (O[i] >= 0) { const f = this.info.get(O[i]); this.height[i] = f.stories * 3.4; this.tone[i] = f.tone; }
  }
}
// two-pass chamfer distance (in cells) from each labelled cell to the nearest cell with a different label
function chamfer(L, nx, nz) {
  const n = nx * nz, D = new Float32Array(n);
  for (let i = 0; i < n; ++i) D[i] = L[i] >= 0 ? 1e6 : 0;
  for (let iz = 0; iz < nz; ++iz) for (let ix = 0; ix < nx; ++ix) {
    const i = iz * nx + ix; if (L[i] < 0) continue;
    let d = D[i];
    const t = (j, w) => { d = Math.min(d, L[j] === L[i] ? D[j] + w : w * 0.5); };
    if (ix > 0) t(i - 1, 1); else d = 0.5;
    if (iz > 0) { t(i - nx, 1); if (ix > 0) t(i - nx - 1, 1.414); if (ix < nx - 1) t(i - nx + 1, 1.414); } else d = 0.5;
    D[i] = d;
  }
  for (let iz = nz - 1; iz >= 0; --iz) for (let ix = nx - 1; ix >= 0; --ix) {
    const i = iz * nx + ix; if (L[i] < 0) continue;
    let d = D[i];
    const t = (j, w) => { d = Math.min(d, L[j] === L[i] ? D[j] + w : w * 0.5); };
    if (ix < nx - 1) t(i + 1, 1); else d = 0.5;
    if (iz < nz - 1) { t(i + nx, 1); if (ix < nx - 1) t(i + nx + 1, 1.414); if (ix > 0) t(i + nx - 1, 1.414); } else d = 0.5;
    D[i] = d;
  }
  return D;
}

// ------------------------------------------------------------------------------------------------ 6. mesher
// Greedy surface mesher for a 2.5D voxel column field (height h, material m per column):
//  - top faces: maximal rectangles of equal (h, m)
//  - walls: where neighbouring columns differ in height, vertical faces merged along runs of equal span/material
// Output: vertex positions in voxel units (integer corners, see finish()), per-vertex material and normal ids, indices.
class MeshBuffer {
  constructor() { this.pos = []; this.mat = []; this.nrm = []; this.idx = []; this.quads = 0; this.nvec = null; }
  // quad with an explicit normal vector (rotated building blocks)
  quadN(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, nx, ny, nz) {
    if (!this.nvec) this.nvec = [];
    this.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, 0);
    for (let k = 0; k < 4; ++k) this.nvec.push(nx, ny, nz);
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, n) {
    const b = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    this.mat.push(m, m, m, m); this.nrm.push(n, n, n, n);
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.quads++;
  }
  // Float positions, every quad grown by EPS (voxels) within its own plane: greedy meshes have T-junctions,
  // and the overlap closes the pinhole cracks they would otherwise show (no z-fighting at this size).
  finish(eps) {
    eps = eps === undefined ? 0.03 : eps;
    const P = new Float32Array(this.pos.length);
    for (let q = 0; q < this.quads; ++q) {
      const o = q * 12;
      for (let a = 0; a < 3; ++a) {
        const c = (this.pos[o + a] + this.pos[o + 3 + a] + this.pos[o + 6 + a] + this.pos[o + 9 + a]) * 0.25;
        for (let k = 0; k < 4; ++k) { const v = this.pos[o + k * 3 + a]; P[o + k * 3 + a] = v + (v > c ? eps : v < c ? -eps : 0); }
      }
    }
    return { pos: P, mat: Uint8Array.from(this.mat), nrm: Uint8Array.from(this.nrm), nvec: this.nvec ? Float32Array.from(this.nvec) : null,
      idx: (this.pos.length / 3 > 65535 ? Uint32Array : Uint16Array).from(this.idx), quads: this.quads };
  }
}
// normal ids: 0 +y, 1 +x, 2 -x, 3 +z, 4 -z
// H, M: column arrays of size (w+2)*(d+2) with a one-cell apron; (ox, oz) = world voxel coords of interior cell (0,0)
// matTopFn: optional remap of the top material; wallMatFn(m) -> material for walls of a column
function meshColumns(H, M, w, d, ox, oz, wallMat, mb) {
  const W2 = w + 2;
  const at = (x, z) => (z + 1) * W2 + (x + 1);
  // tops
  const done = new Uint8Array(w * d);
  for (let z = 0; z < d; ++z)
    for (let x = 0; x < w; ++x) {
      if (done[z * w + x]) continue;
      const i = at(x, z), h = H[i], m = M[i];
      if (h < 0) { done[z * w + x] = 1; continue; }
      let x1 = x + 1;
      while (x1 < w && !done[z * w + x1] && H[at(x1, z)] === h && M[at(x1, z)] === m) ++x1;
      let z1 = z + 1;
      outer: while (z1 < d) {
        for (let k = x; k < x1; ++k) if (done[z1 * w + k] || H[at(k, z1)] !== h || M[at(k, z1)] !== m) break outer;
        ++z1;
      }
      for (let zz = z; zz < z1; ++zz) for (let k = x; k < x1; ++k) done[zz * w + k] = 1;
      const X0 = ox + x, X1 = ox + x1, Z0 = oz + z, Z1 = oz + z1;
      mb.quad(X0, h, Z0, X0, h, Z1, X1, h, Z1, X1, h, Z0, m, 0);
    }
  // walls facing +x / -x: between column (x,z) and (x+1,z); facing +z / -z similarly. Runs merged along the edge.
  for (let dir = 0; dir < 2; ++dir) {
    const nA = dir === 0 ? w + 1 : d + 1, nB = dir === 0 ? d : w;
    for (let a = 0; a < nA; ++a) {
      let b = 0;
      while (b < nB) {
        // columns on both sides of edge a at position b
        const iL = dir === 0 ? at(a - 1, b) : at(b, a - 1);
        const iR = dir === 0 ? at(a, b) : at(b, a);
        const hL = H[iL], hR = H[iR];
        // only emit edges owned by this chunk: interior cells on at least one side; aprons handled by neighbours
        const ownL = dir === 0 ? a - 1 >= 0 : a - 1 >= 0, ownR = dir === 0 ? a < w : a < d;
        let face = 0, lo = 0, hi = 0, m = 0;
        if (hL > hR && ownL) { face = 1; lo = Math.max(hR, 0); hi = hL; m = wallMat(M[iL]); }          // left column taller: face +axis
        else if (hR > hL && ownR) { face = -1; lo = Math.max(hL, 0); hi = hR; m = wallMat(M[iR]); }
        if (!face || hi <= lo) { ++b; continue; }
        let b1 = b + 1;
        while (b1 < nB) {
          const jL = dir === 0 ? at(a - 1, b1) : at(b1, a - 1), jR = dir === 0 ? at(a, b1) : at(b1, a);
          const gL = H[jL], gR = H[jR];
          let f2 = 0, lo2 = 0, hi2 = 0, m2 = 0;
          if (gL > gR && ownL) { f2 = 1; lo2 = Math.max(gR, 0); hi2 = gL; m2 = wallMat(M[jL]); }
          else if (gR > gL && ownR) { f2 = -1; lo2 = Math.max(gL, 0); hi2 = gR; m2 = wallMat(M[jR]); }
          if (f2 !== face || lo2 !== lo || hi2 !== hi || m2 !== m) break;
          ++b1;
        }
        if (dir === 0) {
          const X = ox + a, Z0 = oz + b, Z1 = oz + b1;
          if (face > 0) mb.quad(X, lo, Z0, X, hi, Z0, X, hi, Z1, X, lo, Z1, m, 1);
          else mb.quad(X, lo, Z1, X, hi, Z1, X, hi, Z0, X, lo, Z0, m, 2);
        } else {
          const Z = oz + a, X0 = ox + b, X1 = ox + b1;
          if (face > 0) mb.quad(X1, lo, Z, X1, hi, Z, X0, hi, Z, X0, lo, Z, m, 3);
          else mb.quad(X0, lo, Z, X0, hi, Z, X1, hi, Z, X1, lo, Z, m, 4);
        }
        b = b1;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ pipeline
// The build is split so it can run in parallel workers: fields -> chunks (any order, any worker) -> buildings.
const WALL_MAT = (m) => (m === MAT.MEDIAN_GRASS || m === MAT.MEDIAN_CURB) ? MAT.MEDIAN_CURB : MAT.CURB;
function prepareBuild(net, voxel, opts) {
  opts = opts || {};
  const F = new FieldSampler(net, opts.fieldCell || 0.5);
  F.build();
  const R = new Rasterizer(net, F, voxel, opts);
  const b = net.bounds;
  const VX0 = Math.floor(b.x0 / voxel), VZ0 = Math.floor(b.z0 / voxel), VX1 = Math.ceil(b.x1 / voxel), VZ1 = Math.ceil(b.z1 / voxel);
  const CH = opts.chunk || Math.max(128, Math.round(48 / voxel));   // ~48 m chunks
  const chunks = [];
  for (let oz = VZ0; oz < VZ1; oz += CH)
    for (let ox = VX0; ox < VX1; ox += CH) chunks.push({ ox, oz, w: Math.min(CH, VX1 - ox), d: Math.min(CH, VZ1 - oz) });
  return { net, voxel, F, R, chunks, VX0, VZ0, VX1, VZ1 };
}
// voxel columns + greedy surface mesh of one chunk
function buildChunk(ctx, c) {
  const { R, voxel, VX0, VZ0, VX1, VZ1 } = ctx;
  const { ox, oz, w, d } = c;
  const W2 = w + 2, D2 = d + 2;
  const H = new Int16Array(W2 * D2), M = new Uint8Array(W2 * D2);
  const o = {}, out = [0, 0];
  for (let z = -1; z <= d; ++z)
    for (let x = -1; x <= w; ++x) {
      const gx = ox + x, gz = oz + z, i = (z + 1) * W2 + (x + 1);
      if (gx < VX0 || gx >= VX1 || gz < VZ0 || gz >= VZ1) { H[i] = -1; M[i] = 0; continue; }
      R.classify((gx + 0.5) * voxel, (gz + 0.5) * voxel, o, out);
      H[i] = out[0]; M[i] = out[1];
    }
  const mb = new MeshBuffer();
  meshColumns(H, M, w, d, ox, oz, WALL_MAT, mb);
  return mb.finish();
}
// building blockouts + plot overlay on a coarser grid (an integer multiple of the road voxel)
function buildBlocks(ctx) {
  const { net, F, R, voxel } = ctx;
  const bk = Math.max(1, Math.round(0.5 / voxel));
  const bcell = bk * voxel;
  const PL = new Plots(net, F, R, bcell, net.seed || 1);
  PL.build();
  const plotCount = PL.plotCount;
  const w = PL.nx, d = PL.nz, W2 = w + 2, n2 = W2 * (d + 2);
  const H = new Int16Array(n2), M = new Uint8Array(n2), Hp = new Int16Array(n2).fill(-1), Mp = new Uint8Array(n2);
  const plinth = Math.ceil(R.hs / bk);
  H.fill(plinth);
  const plotIds = new Set();
  for (let z = 0; z < d; ++z)
    for (let x = 0; x < w; ++x) {
      const i = z * w + x, j = (z + 1) * W2 + (x + 1);
      if (PL.height[i] > 0) { H[j] = Math.round(PL.height[i] / bcell) + plinth; M[j] = BUILDING_TONES[PL.tone[i]]; }
      if (PL.plot[i] >= 0) { Hp[j] = 1; Mp[j] = 30 + (hash2(PL.plot[i], 0, 3) * 24 | 0); plotIds.add(PL.plot[i]); }
    }
  const ox = Math.round(PL.x0 / bcell), oz = Math.round(PL.z0 / bcell);
  const emit = (Hh, Mm, yOff, skipY, roofs) => {
    const m = new MeshBuffer();
    meshColumns(Hh, Mm, w, d, ox, oz, (mm) => mm, m);
    const out = new MeshBuffer();
    for (let q = 0; q < m.quads; ++q) {
      const p = m.pos.slice(q * 12, q * 12 + 12), nn = m.nrm[q * 4];
      if (skipY !== undefined && nn === 0 && p[1] === skipY) continue;      // bare plinth tops = ground
      for (let k = 0; k < 12; k += 3) { p[k] *= bk; p[k + 1] = p[k + 1] * bk + yOff; p[k + 2] *= bk; }
      // roofs: flat, slightly darker than the walls (two tones)
      const mm = (roofs && nn === 0) ? ((m.mat[q * 4] % 2) ? MAT.BUILDING_ROOF : MAT.ROOF_B) : m.mat[q * 4];
      out.quad(...p, mm, nn);
    }
    return out.finish();
  };
  // voxel-art buildings (city_arch.js): standalone models placed as rigidly rotated meshes
  const A = (typeof self !== 'undefined' && self.CityArch) || (typeof require !== 'undefined' ? require('./city_arch.js') : null);
  const buildings = A ? A.buildAll(PL, R, voxel, CityCore) : fineBuildings(PL, R, voxel, bk);
  const plots = emit(Hp, Mp, R.hs - bk + 1);
  let built = 0; for (let i = 0; i < PL.height.length; ++i) if (PL.height[i] > 0) built++;
  return { buildings, plots, plotCount, builtArea: built * bcell * bcell };
}
// Building blockouts at the road voxel resolution: the coarse plot map decides which plot owns which area;
// cells on a plot's outline are re-evaluated exactly at every road voxel, so walls along diagonal and curved
// streets step as finely as the curbs in front of them. Towers are set back 3 m from the podium edge.
function fineBuildings(PL, R, voxel, k) {
  // Voxel blockouts on a 0.5 m grid aligned with each building's frontage street: facades along the street
  // are flat voxel walls, other sides step in clean 0.5 m blocks. The coarse plot map decides ownership,
  // cells near the outline are evaluated exactly. Towers are square-ish blocks set back from the podium edge.
  const out = new MeshBuffer();
  const nx = PL.nx, nz = PL.nz, P = PL.plot, hs = R.hs, cell = PL.cell;
  const cells = new Map();
  for (let i = 0; i < P.length; ++i) { const id = P[i]; if (id < 0) continue; let a = cells.get(id); if (!a) cells.set(id, a = []); a.push(i); }
  const idAt = (x, z) => (x < 0 || z < 0 || x >= nx || z >= nz) ? -1 : P[z * nx + x];
  const o = {};
  const corners = new Map();
  const cornerId = (x, z) => {
    const key = z * (nx + 1) + x;
    let v = corners.get(key);
    if (v === undefined) { v = PL.assignAt(PL.x0 + x * cell, PL.z0 + z * cell, o); corners.set(key, v); }
    return v;
  };
  const coarseClass = (ccx, ccz, id) => {
    let same = 0;
    for (let dz = -1; dz <= 1; ++dz) for (let dx = -1; dx <= 1; ++dx) if (idAt(ccx + dx, ccz + dz) === id) ++same;
    if (same === 0) return 0;
    if (same === 9) return 1;
    const a = cornerId(ccx, ccz), b = cornerId(ccx + 1, ccz), c = cornerId(ccx, ccz + 1), d = cornerId(ccx + 1, ccz + 1);
    if (a === b && a === c && a === d) return a === id ? 1 : 0;
    return same >= 2 ? 2 : 0;
  };
  for (const [id, list] of cells) {
    const info = PL.info.get(id);
    const road = PL.net.roads[Math.floor(id / 32768)];
    let mx = 0, mz = 0;
    for (const i of list) { mx += i % nx; mz += (i / nx) | 0; }
    mx = PL.x0 + (mx / list.length + 0.5) * cell; mz = PL.z0 + (mz / list.length + 0.5) * cell;
    const [tx, tz] = PL.tangentNear(road, mx, mz);
    const e1 = [tx, tz], e2 = [-tz, tx];
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const i of list) {
      const cx = PL.x0 + (i % nx) * cell, cz = PL.z0 + ((i / nx) | 0) * cell;
      for (const [qx, qz] of [[cx - cell, cz - cell], [cx + 2 * cell, cz - cell], [cx - cell, cz + 2 * cell], [cx + 2 * cell, cz + 2 * cell]]) {
        const a = (qx - mx) * e1[0] + (qz - mz) * e1[1], b = (qx - mx) * e2[0] + (qz - mz) * e2[1];
        a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
      }
    }
    const w = Math.ceil((a1 - a0) / cell), d = Math.ceil((b1 - b0) / cell);
    const L = new Int32Array(w * d).fill(-1);
    let any = false;
    for (let j = 0; j < d; ++j)
      for (let i = 0; i < w; ++i) {
        const a = a0 + (i + 0.5) * cell, b = b0 + (j + 0.5) * cell;
        const x = mx + a * e1[0] + b * e2[0], z = mz + a * e1[1] + b * e2[1];
        const c = coarseClass(Math.floor((x - PL.x0) / cell), Math.floor((z - PL.z0) / cell), id);
        if (c === 0 || (c === 2 && PL.assignAt(x, z, o) !== id)) continue;
        L[j * w + i] = id; any = true;
      }
    if (!any) continue;
    // heights in grid cells; tower = a square around the widest point, 3 m in from the podium edge
    const full = Math.round(info.stories * 3.4 / cell), pod = Math.round(info.podium * 3.4 / cell);
    let T = null;
    if (info.tower) {
      const D = chamfer(L, w, d);
      let ci = 0, best = -1;
      for (let q = 0; q < w * d; ++q) if (D[q] > best) { best = D[q]; ci = q; }
      const half = Math.min(best - 3 / cell, 9 / cell);
      if (half * cell >= 4) {
        T = new Uint8Array(w * d);
        const cxI = ci % w, czI = (ci / w) | 0;
        for (let q = 0; q < w * d; ++q) if (L[q] >= 0 && D[q] * cell > 3 && Math.abs(q % w - cxI) <= half && Math.abs(((q / w) | 0) - czI) <= half) T[q] = 1;
      }
    }
    const W2 = w + 2, H = new Int16Array(W2 * (d + 2)), M = new Uint8Array(W2 * (d + 2));
    const mat = BUILDING_TONES[info.tone], roof = (mat % 2) ? MAT.BUILDING_ROOF : MAT.ROOF_B;
    for (let j = 0; j < d; ++j)
      for (let i = 0; i < w; ++i) {
        const q = j * w + i;
        if (L[q] < 0) continue;
        H[(j + 1) * W2 + i + 1] = T ? (T[q] ? full : pod) : (info.tower ? pod + 2 : full);
        M[(j + 1) * W2 + i + 1] = mat;
      }
    const mb = new MeshBuffer();
    meshColumns(H, M, w, d, 0, 0, (mm) => mm, mb);
    const NV = [[0, 1, 0], [e1[0], 0, e1[1]], [-e1[0], 0, -e1[1]], [e2[0], 0, e2[1]], [-e2[0], 0, -e2[1]]];
    for (let q = 0; q < mb.quads; ++q) {
      const pq = mb.pos.slice(q * 12, q * 12 + 12), nn = mb.nrm[q * 4];
      if (nn === 0 && pq[1] === 0) continue;                      // ground under the building grid
      for (let c = 0; c < 12; c += 3) {
        const a = a0 + pq[c] * cell, b = b0 + pq[c + 2] * cell;
        pq[c] = (mx + a * e1[0] + b * e2[0]) / voxel;
        pq[c + 1] = hs + pq[c + 1] * k;
        pq[c + 2] = (mz + a * e1[1] + b * e2[1]) / voxel;
      }
      out.quadN(...pq, nn === 0 ? roof : mb.mat[q * 4], ...NV[nn]);
    }
  }
  return out.finish();
}
function* buildCity(net, voxel, opts) {
  const t0 = Date.now();
  const ctx = prepareBuild(net, voxel, opts);
  const timing = { fields: Date.now() - t0 };
  const t1 = Date.now();
  let quads = 0, cells = 0;
  for (const c of ctx.chunks) { c.mesh = buildChunk(ctx, c); quads += c.mesh.quads; cells += c.w * c.d; yield { stage: 'roads' }; }
  timing.roads = Date.now() - t1;
  const t2 = Date.now();
  const blocks = buildBlocks(ctx);
  const props = placeProps(ctx);
  timing.buildings = Date.now() - t2;
  timing.total = Date.now() - t0;
  yield { stage: 'done', result: { props, chunks: ctx.chunks, buildings: blocks.buildings, plots: blocks.plots, plotCount: blocks.plotCount, voxel, hs: ctx.R.hs, cells, quads, timing } };
}
function runSync(gen) { let r; for (const step of gen) r = step; return r.result; }


// ------------------------------------------------------------------------------------------------ 7. street furniture
// Voxel models at a fixed 5 cm voxel (four times finer than the zombies' 9.4 cm, twice the default road voxel),
// built from boxes in code so the engine can rebuild them exactly. Local frame: origin at the base centre,
// +x along the road, +z towards the carriageway (arms reach +z), y up. Placement rules live in placeProps().
const PV = 0.05;
const PM = {                                     // prop materials (palette indices 54..)
  POLE: 54, POLE_DARK: 55, LAMP_HEAD: 56, LAMP_LENS: 57, HOUSING: 58, BACKPLATE: 59, LENS_R: 60, LENS_A: 61, LENS_G: 62,
  SIGN_RED: 63, SIGN_WHITE: 64, SIGN_GREEN: 65, HYDRANT: 66, HYDRANT_CAP: 67, PED_ORANGE: 68, PED_WHITE: 69, CONCRETE: 70,
  STEEL: 130, UMB_RED: 131, UMB_YELLOW: 132, LEAF: 133, LEAF_DARK: 134, TRUNK: 135, BENCH_WOOD: 136, KIOSK_GREEN: 137, PAPER: 138, UMB_BLUE: 139, SOIL: 140,
  DUMP_GREEN: 126, DUMP_BLUE: 127, USPS: 128, PALLET: 129,
  // shared with the building palette (city_arch.js ARCH_PALETTE; the viewer registers both)
  LITTER: 137, LITTER_DARK: 126, RECYCLE_BLUE: 127, CABINET: 80, CABINET_DARK: 107, GLASS_PALE: 79, AD_LIT: 154, RUST: 72, CARDBOARD: 100
};
const PROP_PALETTE = {
  54: [112, 118, 116], 55: [62, 68, 70], 56: [78, 84, 86], 57: [246, 236, 206], 58: [44, 48, 50], 59: [30, 32, 34],
  60: [150, 46, 40], 61: [176, 128, 40], 62: [52, 138, 96], 63: [176, 62, 54], 64: [236, 234, 226], 65: [58, 116, 84],
  66: [178, 70, 56], 67: [214, 178, 84], 68: [222, 132, 58], 69: [226, 226, 218], 70: [168, 164, 156],
  130: [176, 182, 186], 131: [190, 70, 60], 132: [226, 190, 80], 133: [118, 150, 92], 134: [92, 124, 74], 135: [104, 82, 64],
  136: [150, 112, 76], 137: [62, 104, 82], 138: [222, 214, 196], 139: [80, 120, 168], 140: [96, 80, 66],
  126: [54, 92, 66], 127: [50, 82, 128], 128: [38, 70, 132], 129: [194, 164, 116]
};
class VoxModel {
  constructor(w, h, d, ox, oz) { this.w = w; this.h = h; this.d = d; this.ox = ox; this.oz = oz; this.v = new Uint8Array(w * h * d); }
  // box in model coords (x relative to origin column, z relative to origin row), inclusive-exclusive
  box(x0, y0, z0, x1, y1, z1, m) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); ++y)
      for (let z = z0; z < z1; ++z) for (let x = x0; x < x1; ++x) {
        const X = x + this.ox, Z = z + this.oz;
        if (X >= 0 && X < this.w && Z >= 0 && Z < this.d) this.v[(y * this.d + Z) * this.w + X] = m + 1;
      }
    return this;
  }
  at(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.h || z >= this.d) return 0;
    return this.v[(y * this.d + z) * this.w + x];
  }
}
// 3D greedy mesher: per face direction and slice, maximal rectangles of equal material. Normal ids 0..5:
// +y, +x, -x, +z, -z, -y. Positions in metres, origin at the model origin.
function meshVoxels3D(M) {
  const mb = new MeshBuffer();
  const dims = [M.w, M.h, M.d], V = M.v, ST = [1, M.d * M.w, M.w];   // index strides of x, y, z in M.v
  const dirs = [[1, 1, 0], [0, 1, 1], [0, -1, 2], [2, 1, 3], [2, -1, 4], [1, -1, 5]];   // [axis, sign, normal id]
  for (const [ax, sg, nid] of dirs) {
    const u = (ax + 1) % 3, w = (ax + 2) % 3;
    const nu = dims[u], nw = dims[w], sa = ST[ax], su = ST[u], sw = ST[w];
    const mask = new Int16Array(nu * nw);
    for (let k = 0; k < dims[ax]; ++k) {
      const edge = k + sg < 0 || k + sg >= dims[ax], off = sg * sa;
      for (let j = 0; j < nw; ++j) {
        let idx = k * sa + j * sw;
        for (let i = 0; i < nu; ++i, idx += su) {
          const m = V[idx];
          mask[j * nu + i] = !m || (!edge && V[idx + off]) ? 0 : m;
        }
      }
      for (let j = 0; j < nw; ++j) for (let i = 0; i < nu;) {
        const m = mask[j * nu + i];
        if (!m) { ++i; continue; }
        let wi = 1; while (i + wi < nu && mask[j * nu + i + wi] === m) ++wi;
        let hj = 1;
        outer: while (j + hj < nw) { for (let t = 0; t < wi; ++t) if (mask[(j + hj) * nu + i + t] !== m) break outer; ++hj; }
        for (let jj = 0; jj < hj; ++jj) for (let t = 0; t < wi; ++t) mask[(j + jj) * nu + i + t] = 0;
        const plane = sg > 0 ? k + 1 : k;
        const P = (a, b) => { const q = [0, 0, 0]; q[ax] = plane; q[u] = a; q[w] = b; return [(q[0] - M.ox) * PV, q[1] * PV, (q[2] - M.oz) * PV]; };
        const c0 = P(i, j), c1 = P(i + wi, j), c2 = P(i + wi, j + hj), c3 = P(i, j + hj);
        // winding: counter-clockwise seen from outside
        if (sg > 0) mb.quad(...c0, ...c1, ...c2, ...c3, m - 1, nid);
        else mb.quad(...c0, ...c3, ...c2, ...c1, m - 1, nid);
        i += wi;
      }
    }
  }
  return mb.finish(0.0002);
}
// --- models (dimensions in 5 cm voxels)
function modelLamp(twin) {
  // cobra-head street light, 8.7 m: tapered pole on a cast base, curved arm, luminaire with a glowing lens
  const reach = 46;                                            // arm 2.3 m
  const M = new VoxModel(9, 178, twin ? reach * 2 + 9 : reach + 9, 4, twin ? reach + 4 : 4);
  M.box(-3, 0, -3, 4, 3, 4, PM.POLE_DARK).box(-2, 3, -2, 3, 14, 3, PM.POLE_DARK);       // footing + base
  M.box(-2, 14, -2, 3, 90, 3, PM.POLE).box(-1, 90, -1, 2, 170, 2, PM.POLE);               // tapered shaft
  for (const sgn of twin ? [1, -1] : [1]) {
    const Z = (a, b) => sgn > 0 ? [a, b] : [-b + 1, -a + 1];
    let [z0, z1] = Z(1, 10); M.box(-1, 166, z0, 2, 169, z1, PM.POLE);                   // arm rising from the pole
    [z0, z1] = Z(10, 30); M.box(-1, 168, z0, 2, 171, z1, PM.POLE);
    [z0, z1] = Z(30, reach - 10); M.box(-1, 170, z0, 2, 172, z1, PM.POLE);
    [z0, z1] = Z(reach - 14, reach + 2); M.box(-3, 168, z0, 4, 174, z1, PM.LAMP_HEAD);  // luminaire
    [z0, z1] = Z(reach - 12, reach); M.box(-2, 167, z0, 3, 168, z1, PM.LAMP_LENS);     // lens underneath
  }
  return M;
}
function signalHead(M, x, y, z, faceX) {
  // 3-section vehicle signal (0.35 x 1.0 m) with backplate; lenses on the +x face (faceX = +1) or -x face
  const f = faceX > 0 ? 1 : -1;
  const hx0 = f > 0 ? x : x - 5, hx1 = hx0 + 5;
  M.box(hx0, y, z - 4, hx1, y + 20, z + 4, PM.HOUSING);
  const bx = f > 0 ? hx0 : hx1 - 1;
  M.box(bx, y - 1, z - 6, bx + 1, y + 21, z + 6, PM.BACKPLATE);
  const lx = f > 0 ? hx1 : hx0 - 1;
  [[PM.LENS_R, 14], [PM.LENS_A, 8], [PM.LENS_G, 2]].forEach(([m, yy]) => {
    M.box(lx, y + yy, z - 2, lx + 1, y + yy + 4, z + 2, m);
    M.box(lx, y + yy + 4, z - 3, lx + 1, y + yy + 5, z + 3, PM.HOUSING);       // visor
  });
}
function modelSignal(reach, face) {
  face = face || 1;
  // signal mast: 7 m pole, mast arm over the approach lanes with two heads facing traffic (+x),
  // a pole-mounted head, a pedestrian signal facing across the road and a street-name blade on the arm
  const L = Math.round(reach / PV);
  const M = new VoxModel(32, 150, L + 14, 16, 5);
  M.box(-4, 0, -4, 5, 4, 5, PM.CONCRETE).box(-3, 4, -3, 4, 12, 4, PM.POLE_DARK).box(-2, 12, -2, 3, 140, 3, PM.POLE);
  M.box(-2, 140, -2, 3, 143, 3, PM.POLE_DARK);
  M.box(-1, 128, 2, 2, 132, L, PM.POLE);                                      // mast arm
  M.box(-1, 132, 2, 2, 134, Math.round(L * 0.4), PM.POLE);                    // upper chord near the pole
  M.box(-1, 132, 2, 2, 140, 3, PM.POLE);
  for (const t of [0.55, 0.9]) { const zz = Math.round(L * t); M.box(0, 124, zz - 1, 1, 128, zz + 1, PM.POLE); signalHead(M, face > 0 ? 1 : 0, 104, zz, face); }
  signalHead(M, face > 0 ? 3 : -2, 56, 0, face);                                                 // pole-mounted head
  M.box(-6, 120, 6, 7, 123, 7, PM.SIGN_GREEN);                                // street name blade on the arm
  M.box(-5, 121, 7, 6, 122, 8, PM.SIGN_WHITE);
  M.box(-3, 44, 3, 4, 52, 7, PM.HOUSING);                                     // pedestrian signal box facing +z
  M.box(-2, 48, 7, 3, 51, 8, PM.PED_ORANGE); M.box(-2, 45, 7, 3, 47, 8, PM.PED_WHITE);
  M.box(-3, 30, -6, -2, 36, -3, PM.HOUSING);                                  // push button
  return M;
}
function modelStop() {
  // R1-1 stop sign: 0.85 m octagon (17 voxels), red face, white border, "STOP" in a 3x5 voxel font,
  // plain metal back, on a 2.1 m square post
  const M = new VoxModel(18, 58, 18, 9, 9);
  M.box(-1, 0, -1, 1, 54, 1, PM.POLE);
  const font = { S: ['111', '100', '111', '001', '111'], T: ['111', '010', '010', '010', '010'],
                 O: ['111', '101', '101', '101', '111'], P: ['111', '101', '111', '100', '100'] };
  const lit = new Set();
  'STOP'.split('').forEach((ch, k) => font[ch].forEach((row, r) => row.split('').forEach((b, c) => { if (b === '1') lit.add((2 - r) + ',' + (k * 4 + c)); })));
  const cy = 45, R = 8;
  for (let y = -R; y <= R; ++y) for (let z = -R; z <= R; ++z) {
    const ay = Math.abs(y), az = Math.abs(z);
    if (ay + az > 11) continue;                                              // octagon
    const edge = ay === R || az === R || ay + az === 11;
    const col = 7 - z;                                                       // reader's left-to-right runs along -z
    const legend = ay <= 2 && col >= 0 && col < 15 && lit.has(y + ',' + col);
    M.box(1, cy + y, z, 2, cy + y + 1, z + 1, PM.POLE);                     // metal back
    M.box(2, cy + y, z, 3, cy + y + 1, z + 1, edge || legend ? PM.SIGN_WHITE : PM.SIGN_RED);
  }
  M.box(-1, 54, -1, 1, 55, 1, PM.POLE_DARK);
  return M;
}
function modelHydrant() {
  const M = new VoxModel(12, 18, 12, 6, 6);
  M.box(-3, 0, -3, 4, 2, 4, PM.HYDRANT).box(-2, 2, -2, 3, 12, 3, PM.HYDRANT).box(-3, 12, -3, 4, 13, 4, PM.HYDRANT_CAP);
  M.box(-2, 13, -2, 3, 15, 3, PM.HYDRANT_CAP).box(-1, 15, -1, 2, 16, 2, PM.HYDRANT_CAP);
  M.box(-5, 7, -1, 6, 9, 2, PM.HYDRANT).box(-1, 7, 3, 2, 10, 5, PM.HYDRANT_CAP);            // nozzles
  return M;
}

function modelHotdog() {
  // street food cart (1.6 x 0.8 m) with wheels and a striped umbrella, 2.3 m
  const M = new VoxModel(40, 48, 40, 20, 20);
  M.box(-16, 4, -8, 16, 18, 8, PM.STEEL).box(-16, 18, -8, 16, 19, 8, PM.POLE_DARK);
  M.box(-14, 10, -9, 14, 16, -8, PM.UMB_RED).box(-14, 12, -9, 14, 13, -8, PM.SIGN_WHITE);
  for (const x of [-12, 9]) M.box(x, 0, -9, x + 3, 5, -7, PM.POLE_DARK).box(x, 0, 7, x + 3, 5, 9, PM.POLE_DARK);
  M.box(-1, 19, -1, 1, 42, 1, PM.POLE);
  for (let r = 0; r < 4; ++r) for (let k = -18 + r * 2; k < 18 - r * 2; k += 4)
    M.box(k, 42 + r, -18 + r * 2, k + 2, 43 + r, 18 - r * 2, PM.UMB_YELLOW).box(k + 2, 42 + r, -18 + r * 2, k + 4, 43 + r, 18 - r * 2, PM.UMB_RED);
  return M;
}
function modelNewsstand() {
  // newsstand booth 2.4 x 1.6 m, green with a service window, awning and magazine racks
  const M = new VoxModel(52, 56, 40, 26, 20);
  M.box(-24, 0, -14, 24, 50, 16, PM.KIOSK_GREEN).box(-26, 50, -16, 26, 53, 18, PM.POLE_DARK);
  M.box(-18, 20, -15, 18, 38, -14, PM.HOUSING).box(-20, 18, -18, 20, 20, -14, PM.STEEL);
  M.box(-22, 40, -20, 22, 42, -14, PM.UMB_RED);
  for (let k = -20; k < 20; k += 5) M.box(k, 4, -16, k + 4, 16, -14, (k / 5) % 2 ? PM.PAPER : PM.SIGN_RED);
  return M;
}
function modelBench() {
  const M = new VoxModel(36, 18, 14, 18, 7);
  for (const x of [-16, 13]) M.box(x, 0, -5, x + 3, 9, 5, PM.POLE_DARK);
  M.box(-18, 8, -5, 18, 9, 4, PM.BENCH_WOOD).box(-18, 10, 4, 18, 17, 5, PM.BENCH_WOOD);
  return M;
}
function modelTree() {
  // street tree in a square planter: 1.2 m planter, trunk, layered voxel canopy (~6 m)
  const M = new VoxModel(80, 124, 80, 40, 40);
  M.box(-12, 0, -12, 12, 6, 12, PM.CONCRETE).box(-11, 6, -11, 11, 7, 11, PM.SOIL);
  M.box(-2, 7, -2, 2, 60, 2, PM.TRUNK);
  const R = mulberry32(17);
  for (let k = 0; k < 18; ++k) {
    const cx = Math.round((R() - 0.5) * 36), cz = Math.round((R() - 0.5) * 36), cy = 64 + Math.round(R() * 40);
    const r = 8 + Math.round(R() * 8);
    M.box(cx - r, cy - r * 0.7 | 0, cz - r, cx + r, cy + r * 0.7 | 0, cz + r, k % 3 ? PM.LEAF : PM.LEAF_DARK);
  }
  return M;
}
function modelCafe() {
  // cafe table with two chairs and a market umbrella
  const M = new VoxModel(60, 50, 60, 30, 30);
  M.box(-1, 0, -1, 1, 14, 1, PM.POLE_DARK).box(-8, 14, -8, 8, 15, 8, PM.STEEL);
  for (const z of [-14, 12]) M.box(-4, 0, z, 4, 9, z + 2, PM.POLE_DARK).box(-4, 9, z - 2, 4, 10, z + 4, PM.STEEL);
  M.box(-1, 15, -1, 1, 42, 1, PM.POLE);
  for (let r = 0; r < 4; ++r) M.box(-26 + r * 4, 42 + r, -26 + r * 4, 26 - r * 4, 43 + r, 26 - r * 4, r % 2 ? PM.SIGN_WHITE : PM.UMB_BLUE);
  return M;
}
// --- sidewalk furniture, downtown / old town (local frame as above: +z towards the carriageway, -z towards the
// buildings; models whose base would sit flush on the sidewalk are placed 1 voxel (PV) sunk into the slab)
function disc(M, cx, cz, r, y0, y1, m) {          // filled disc of voxel columns centred on (cx, cz) (voxel corners)
  const R = Math.ceil(r);
  for (let z = -R - 1; z <= R; ++z) for (let x = -R - 1; x <= R; ++x)
    if ((x + 0.5 - cx) * (x + 0.5 - cx) + (z + 0.5 - cz) * (z + 0.5 - cz) <= r * r) M.box(x, y0, z, x + 1, y1, z + 1, m);
  return M;
}
function modelTrashWire() {
  // wire-mesh litter basket (0.65 m, 0.9 m): black bag inside, open slats, rim bands
  const M = new VoxModel(16, 20, 16, 8, 8);
  disc(M, 0, 0, 5.2, 1, 15, PM.HOUSING);
  for (let z = -7; z <= 6; ++z) for (let x = -7; x <= 6; ++x) {
    const d = Math.hypot(x + 0.5, z + 0.5);
    if (d > 6.6 || d < 5.2) continue;
    M.box(x, 0, z, x + 1, 2, z + 1, PM.POLE_DARK).box(x, 8, z, x + 1, 9, z + 1, PM.POLE_DARK).box(x, 16, z, x + 1, 18, z + 1, PM.POLE_DARK);
    if ((x + z) & 1) M.box(x, 2, z, x + 1, 16, z + 1, PM.POLE_DARK);
  }
  M.box(-2, 15, -1, 1, 16, 2, PM.PAPER).box(1, 15, -3, 3, 16, -1, PM.HOUSING);
  return M;
}
function modelTrashNYC() {
  // green NYC litter basket: chamfered perforated steel body, dark bands, trash showing below the rim
  const M = new VoxModel(14, 20, 14, 7, 7);
  for (let y = 1; y < 18; ++y) {
    const m = y === 6 || y === 12 ? PM.LITTER_DARK : PM.LITTER;
    M.box(-6, y, -5, 6, y + 1, 5, m).box(-5, y, -6, 5, y + 1, 6, m);
  }
  M.box(-5, 0, -4, 5, 1, 4, PM.POLE_DARK).box(-4, 0, -5, 4, 1, 5, PM.POLE_DARK);
  M.box(-4, 15, -4, 4, 18, 4, -1);                                   // open top
  M.box(-4, 14, -4, 4, 15, 4, PM.HOUSING).box(-3, 15, -2, 0, 16, 1, PM.PAPER).box(1, 15, 0, 3, 16, 3, PM.HOUSING);
  M.box(-2, 9, -7, 2, 11, -6, PM.SIGN_WHITE);                        // decal on the sidewalk face
  return M;
}
function modelTrashSteel() {
  // stainless round bin with a domed lid and a front slot
  const M = new VoxModel(16, 22, 16, 8, 8);
  disc(M, 0, 0, 6, 1, 16, PM.STEEL);
  disc(M, 0, 0, 6.4, 0, 1, PM.POLE_DARK);
  disc(M, 0, 0, 6.4, 16, 17, PM.POLE_DARK); disc(M, 0, 0, 5, 17, 18, PM.POLE_DARK); disc(M, 0, 0, 3, 18, 19, PM.POLE_DARK);
  M.box(-3, 12, -7, 3, 15, -4, -1).box(-3, 12, -4, 3, 15, -3, PM.HOUSING);    // slot facing the sidewalk
  M.box(-1, 19, -1, 1, 20, 1, PM.POLE_DARK);
  return M;
}
function modelRecycle() {
  // recycling pair on a shared plinth: blue (bottles / cans) and green (paper), round openings in the lids
  const M = new VoxModel(26, 21, 14, 13, 7);
  M.box(-12, 0, -6, 12, 1, 6, PM.CONCRETE);
  for (const [x0, m] of [[-11, PM.RECYCLE_BLUE], [1, PM.LITTER]]) {
    M.box(x0, 1, -5, x0 + 10, 17, 5, m).box(x0 - 1, 17, -6, x0 + 11, 19, 6, m);
    M.box(x0 + 3, 18, -3, x0 + 7, 19, 1, PM.HOUSING);
    M.box(x0 + 2, 9, -6, x0 + 8, 13, -5, PM.SIGN_WHITE);
  }
  return M;
}
function modelNewsboxes(cols) {
  // a cluster of coin-op newspaper boxes on pedestals, windows towards the sidewalk (-z), varied heights
  const n = cols.length, M = new VoxModel(n * 10 + 2, 26, 12, (n * 10) >> 1, 6);
  cols.forEach(([m, h], k) => {
    const x = -((n * 10) >> 1) + k * 10 + 1;
    M.box(x + 2, 0, -2, x + 7, 6, 2, PM.POLE_DARK).box(x + 1, 0, -3, x + 8, 1, 3, PM.POLE_DARK);
    M.box(x, 6, -4, x + 9, h, 4, m).box(x, h, -4, x + 9, h + 1, 3, PM.HOUSING);
    M.box(x + 1, h - 9, -5, x + 8, h - 3, -4, PM.PAPER).box(x + 1, h - 2, -5, x + 3, h - 1, -4, PM.STEEL);
    M.box(x + 2, 8, -5, x + 7, 9, -4, PM.HOUSING);
  });
  return M;
}
function modelMailbox() {
  // USPS collection box: blue, domed top, pull-down chute, four short legs
  const M = new VoxModel(14, 25, 14, 7, 7);
  for (const [x, z] of [[-5, -5], [4, -5], [-5, 4], [4, 4]]) M.box(x, 0, z, x + 1, 3, z + 1, PM.USPS);
  M.box(-5, 3, -5, 5, 20, 5, PM.USPS).box(-5, 20, -4, 5, 21, 4, PM.USPS).box(-5, 21, -3, 5, 22, 3, PM.USPS);
  M.box(-4, 15, -6, 4, 18, -5, PM.POLE_DARK).box(-3, 10, -6, 3, 13, -5, PM.SIGN_WHITE);
  return M;
}
function modelBikeRack(bike) {
  // three inverted-U hoops square to the curb (0.8 m apart), optionally a bike locked to one of them
  const M = new VoxModel(48, 20, 22, 24, 11);
  for (const x of [-17, -1, 15]) {
    M.box(x, 0, -8, x + 1, 17, -7, PM.STEEL).box(x, 0, 7, x + 1, 17, 8, PM.STEEL).box(x, 16, -8, x + 1, 17, 8, PM.STEEL);
  }
  if (bike) {
    const x = 1, c = bike;
    for (const zc of [-5.5, 6.5]) for (let z = -12; z <= 13; ++z) for (let y = 0; y <= 14; ++y) {
      const d = Math.hypot(z + 0.5 - zc, y + 0.5 - 7);
      if (d >= 5.2 && d <= 6.6) M.box(x, y, z, x + 1, y + 1, z + 1, PM.HOUSING);
    }
    const line = (z0, y0, z1, y1, m) => { const n = Math.max(Math.abs(z1 - z0), Math.abs(y1 - y0)); for (let k = 0; k <= n; ++k) { const z = Math.round(z0 + (z1 - z0) * k / n), y = Math.round(y0 + (y1 - y0) * k / n); M.box(x, y, z, x + 1, y + 1, z + 1, m); } };
    line(-5, 7, 0, 7, c); line(0, 7, 3, 12, c); line(-3, 12, 4, 12, c); line(-5, 7, -3, 12, c); line(4, 12, 6, 7, c);
    line(-3, 12, -4, 14, c); M.box(x - 1, 14, -6, x + 2, 15, -2, PM.HOUSING);          // seat
    line(4, 12, 5, 15, c); M.box(x - 3, 15, 4, x + 4, 16, 6, PM.HOUSING);             // bars
  }
  return M;
}
function modelBollard() {
  const M = new VoxModel(8, 20, 8, 4, 4);
  disc(M, 0, 0, 2.6, 0, 17, PM.POLE_DARK); disc(M, 0, 0, 2.6, 14, 15, PM.UMB_YELLOW); disc(M, 0, 0, 1.6, 17, 18, PM.POLE_DARK);
  return M;
}
function modelCabinet(big) {
  // traffic-signal controller / electrical cabinet on a concrete pad: overhanging roof, door seam, vents, sticker
  const w = big ? 9 : 6, h = big ? 30 : 22, M = new VoxModel(2 * w + 4, h + 3, 18, w + 2, 9);
  M.box(-w - 1, 0, -7, w + 1, 2, 7, PM.CONCRETE);
  M.box(-w, 2, -6, w, h, 6, big ? PM.CABINET : PM.STEEL);
  M.box(-w - 1, h, -7, w + 1, h + 1, 7, big ? PM.CABINET_DARK : PM.POLE);
  M.box(0, 4, -7, 1, h - 2, -6, big ? PM.CABINET_DARK : PM.POLE).box(2, h - 12, -7, 3, h - 9, -6, PM.HOUSING);
  for (let y = 6; y < h - 6; y += 3) M.box(w, y, -4, w + 1, y + 1, 4, big ? PM.CABINET_DARK : PM.POLE);
  M.box(-w + 2, h - 8, -7, -w + 6, h - 5, -6, PM.SIGN_WHITE);
  return M;
}
function modelMeter() {
  // single-space parking meter: post, grey head with a dome window and a coin slot, display towards the sidewalk
  const M = new VoxModel(8, 30, 8, 4, 4);
  M.box(-1, 0, -1, 1, 21, 1, PM.POLE_DARK).box(-2, 0, -2, 2, 1, 2, PM.POLE_DARK);
  M.box(-2, 21, -2, 2, 27, 2, PM.STEEL).box(-1, 27, -2, 1, 28, 2, PM.STEEL);
  M.box(-1, 23, -3, 1, 26, -2, PM.PAPER).box(-1, 23, 2, 1, 26, 3, PM.HOUSING);
  return M;
}
function modelMeterKiosk() {
  // multi-space pay station: grey pedestal and cabinet, blue 'P' sign on top, screen towards the sidewalk
  const M = new VoxModel(12, 42, 10, 6, 5);
  M.box(-4, 0, -3, 4, 4, 3, PM.POLE_DARK).box(-5, 4, -4, 5, 30, 3, PM.STEEL).box(-5, 30, -4, 5, 31, 4, PM.POLE_DARK);
  M.box(-3, 20, -5, 3, 25, -4, PM.HOUSING).box(-2, 14, -5, 2, 16, -4, PM.POLE_DARK);
  M.box(-1, 31, -1, 1, 33, 1, PM.POLE).box(-4, 33, -1, 4, 41, 1, PM.UMB_BLUE).box(-2, 34, -2, 0, 40, 2, PM.SIGN_WHITE).box(0, 37, -2, 2, 40, 2, PM.SIGN_WHITE);
  return M;
}
function modelBusShelter() {
  // bus shelter 3.8 x 1.4 m: posts, roof with a white fascia, glass back wall (building side), back-lit advertising
  // panel at one end, half glass end panel, bench inside; open towards the curb
  const M = new VoxModel(84, 56, 36, 42, 18);
  for (const x of [-38, 36]) for (const z of [-14, 12]) M.box(x, 0, z, x + 2, 50, z + 2, PM.POLE_DARK);
  M.box(-40, 50, -16, 40, 52, 16, PM.POLE_DARK).box(-40, 52, -16, 40, 53, 16, PM.STEEL).box(-40, 50, 15, 40, 52, 16, PM.SIGN_WHITE);
  M.box(-36, 3, -14, 36, 4, -12, PM.POLE_DARK).box(-36, 46, -14, 36, 48, -12, PM.POLE_DARK);
  M.box(-36, 4, -13, 36, 46, -12, PM.GLASS_PALE);
  for (const x of [-12, 12]) M.box(x, 4, -14, x + 1, 46, -12, PM.POLE_DARK);
  M.box(-38, 4, -12, -36, 46, 10, PM.POLE_DARK).box(-38, 6, -11, -36, 44, 9, PM.AD_LIT);    // ad panel (glows)
  M.box(36, 4, -12, 37, 46, 0, PM.GLASS_PALE).box(36, 3, -12, 38, 4, 0, PM.POLE_DARK);
  M.box(-20, 9, -11, 20, 10, -5, PM.STEEL);
  for (const x of [-18, 16]) M.box(x, 0, -10, x + 2, 9, -8, PM.POLE_DARK);
  return M;
}
function modelBusSign() {
  // bus stop flag on its own pole at the curb: white plate, red band, blue route strip, timetable box
  const M = new VoxModel(6, 60, 16, 3, 3);
  M.box(-1, 0, -1, 1, 58, 1, PM.POLE);
  M.box(-1, 42, 1, 1, 56, 11, PM.SIGN_WHITE).box(-1, 53, 1, 1, 56, 11, PM.SIGN_RED).box(-1, 44, 1, 1, 46, 11, PM.UMB_BLUE);
  M.box(-2, 26, -2, 2, 36, 2, PM.HOUSING);
  return M;
}
// --- vehicles parked at the curb / in loading bays (also used by the service kit): +x is the front, z centred
function modelVan(col, band) {
  // panel van 5.6 x 2.0 x 2.3 m: sloped windscreen, cab side windows, bumpers, lights, rear door seam
  const M = new VoxModel(116, 48, 44, 58, 22);
  M.box(-56, 5, -20, 40, 44, 20, col).box(40, 5, -20, 56, 22, 20, col);
  for (let y = 22; y < 42; ++y) { const x1 = 40 + Math.round((42 - y) * 0.6); M.box(36, y, -19, x1, y + 1, 19, PM.HOUSING); }
  M.box(28, 26, -21, 38, 38, 21, PM.HOUSING);
  M.box(-54, 44, -18, 34, 46, 18, col);
  M.box(56, 5, -20, 57, 11, 20, PM.POLE_DARK).box(-57, 5, -20, -56, 11, 20, PM.POLE_DARK);
  M.box(56, 14, -18, 57, 18, -12, PM.PAPER).box(56, 14, 12, 57, 18, 18, PM.PAPER);
  M.box(-57, 22, -19, -56, 28, -16, PM.SIGN_RED).box(-57, 22, 16, -56, 28, 19, PM.SIGN_RED);
  M.box(-57, 12, -1, -56, 40, 1, PM.POLE_DARK);
  for (const x of [-44, 30]) for (const z of [-21, 16]) M.box(x, 0, z, x + 14, 13, z + 5, PM.HOUSING);
  for (const x of [-40, 34]) for (const z of [-22, 21]) M.box(x, 4, z, x + 6, 9, z + 1, PM.STEEL);
  if (band) M.box(-40, 26, -21, 20, 33, 21, band);                                    // livery band
  return M;
}
function modelBoxTruck(col, band) {
  // box truck 7.5 x 2.4 x 3.4 m: cab, white box with a livery stripe, ribbed roll door at the back, dual rear wheels
  const M = new VoxModel(152, 70, 54, 76, 27);
  M.box(-74, 10, -24, 36, 68, 24, PM.SIGN_WHITE);
  M.box(-75, 12, -22, -74, 66, 22, PM.STEEL);
  for (let y = 14; y < 66; y += 4) M.box(-75, y, -22, -74, y + 1, 22, PM.POLE);
  M.box(-72, 6, -22, 70, 10, 22, PM.POLE_DARK);
  M.box(38, 10, -22, 74, 30, 22, col).box(38, 30, -22, 62, 52, 22, col);
  for (let y = 30; y < 50; ++y) M.box(62, y, -21, 62 + Math.round((50 - y) * 0.5), y + 1, 21, PM.HOUSING);
  M.box(44, 34, -23, 58, 46, 23, PM.HOUSING);
  M.box(74, 10, -22, 75, 16, 22, PM.POLE_DARK).box(74, 18, -21, 75, 22, -15, PM.PAPER).box(74, 18, 15, 75, 22, 21, PM.PAPER);
  M.box(-60, 54, -25, 30, 60, 25, band);
  for (const [x, w] of [[50, 16], [-58, 26]]) for (const z of [-25, 19]) M.box(x, 0, z, x + w, 16, z + 6, PM.HOUSING);
  return M;
}
function modelRolloff(col) {
  // roll-off container in a parking lane (6 x 2.3 x 1.4 m): ribbed steel sides, rails, construction debris
  const M = new VoxModel(124, 34, 50, 62, 25);
  M.box(-58, 0, -20, 58, 2, -16, PM.POLE_DARK).box(-58, 0, 16, 58, 2, 20, PM.POLE_DARK);
  M.box(-60, 2, -23, 60, 28, 23, col);
  for (let x = -52; x < 56; x += 9) M.box(x, 4, -24, x + 2, 28, 24, col === PM.RUST ? PM.POLE_DARK : PM.RUST);
  M.box(-57, 24, -20, 57, 28, 20, -1);                                                // open top
  M.box(-57, 23, -20, 57, 24, 20, PM.CONCRETE);
  for (const [x, z, w, h, m] of [[-50, -14, 20, 4, PM.CARDBOARD], [-20, 2, 16, 3, PM.BENCH_WOOD], [5, -12, 14, 5, PM.CONCRETE], [30, 4, 18, 4, PM.CARDBOARD], [-34, 6, 10, 2, PM.HOUSING]])
    M.box(x, 24, z, x + w, 24 + h, z + 10, m);
  M.box(60, 6, -6, 61, 22, 6, PM.UMB_YELLOW).box(-61, 6, -6, -60, 22, 6, PM.UMB_YELLOW);
  return M;
}
function modelBagPile(seed) {
  // trash bags out at the curb for collection (pickup day): black, white and the odd green or blue recycling bag
  const R = mulberry32(seed), M = new VoxModel(64, 22, 28, 32, 14);
  const n = 5 + (seed % 5);
  for (let k = 0; k < n; ++k) {
    const x = -28 + Math.round(R() * 46), z = -11 + Math.round(R() * 12), s = 7 + Math.round(R() * 4), y0 = k >= n - 2 ? 6 : 0;
    const t = R(), m = t < 0.55 ? PM.HOUSING : t < 0.78 ? PM.PAPER : t < 0.9 ? PM.DUMP_BLUE : PM.DUMP_GREEN;
    M.box(x, y0, z, x + s, y0 + s - 1, z + s, m).box(x + 1, y0 + s - 1, z + 1, x + s - 1, y0 + s, z + s - 1, m);
    M.box(x + (s >> 1) - 1, y0 + s, z + (s >> 1) - 1, x + (s >> 1) + 1, y0 + s + 2, z + (s >> 1) + 1, m);
  }
  if (seed % 3 === 0) M.box(10, 0, -12, 24, 10, -2, PM.CARDBOARD).box(10, 10, -12, 24, 11, -2, PM.BENCH_WOOD);
  return M;
}
const PROP_TYPES = {
  hotdog: modelHotdog, newsstand: modelNewsstand, bench: modelBench, tree: modelTree, cafe: modelCafe,
  lamp: () => modelLamp(false), lamp2: () => modelLamp(true), signal: () => modelSignal(5.2, 1), signalLong: () => modelSignal(9.2, 1),
  stop: modelStop, hydrant: modelHydrant,
  trashWire: modelTrashWire, trashNYC: modelTrashNYC, trashSteel: modelTrashSteel, recycle: modelRecycle,
  news3: () => modelNewsboxes([[PM.SIGN_RED, 20], [PM.UMB_BLUE, 23], [PM.UMB_YELLOW, 19]]),
  news4: () => modelNewsboxes([[PM.SIGN_WHITE, 22], [PM.SIGN_GREEN, 19], [PM.SIGN_RED, 24], [PM.DUMP_BLUE, 20]]),
  mailbox: modelMailbox, bikerack: () => modelBikeRack(0), bikerackBike: () => modelBikeRack(PM.UMB_RED), bollard: modelBollard,
  cabinet: () => modelCabinet(true), utilbox: () => modelCabinet(false), meter: modelMeter, meterKiosk: modelMeterKiosk,
  busstop: modelBusShelter, busSign: modelBusSign,
  van: () => modelVan(PM.SIGN_WHITE, 0), vanBlue: () => modelVan(PM.UMB_BLUE, PM.SIGN_WHITE), vanGrey: () => modelVan(PM.STEEL, PM.DUMP_BLUE),
  truck: () => modelBoxTruck(PM.SIGN_WHITE, PM.UMB_RED), truckBlue: () => modelBoxTruck(PM.UMB_BLUE, PM.UMB_BLUE), truckGreen: () => modelBoxTruck(PM.DUMP_GREEN, PM.DUMP_GREEN),
  rolloff: () => modelRolloff(PM.HYDRANT), rolloffBlue: () => modelRolloff(PM.DUMP_BLUE),
  bags1: () => modelBagPile(5), bags2: () => modelBagPile(9), bags3: () => modelBagPile(12)
};
function buildPropMeshes() {
  const out = {};
  for (const k in PROP_TYPES) out[k] = meshVoxels3D(PROP_TYPES[k]());
  return out;
}
// Placement from the network: lamps along sidewalks (staggered, twin lamps in medians), a signal mast on the
// right-hand corner of every approach to a junction between two through streets, stop signs on the approaches
// of local streets (all-way when both are local), hydrants every ~85 m. Every spot is checked on the voxel
// classification (must be sidewalk / median of that road, clear of crosswalks and junction boxes).
function placeProps(ctx) {
  const { net, F, R } = ctx;
  const out = [];
  const o = {}, cls = [0, 0];
  const hsM = R.hs * ctx.voxel;
  const okAt = (x, z, road, want) => {
    R.classify(x, z, o, cls);
    if (o.road !== road) return false;
    if (want === 'median') return cls[1] === MAT.MEDIAN_GRASS;
    return cls[1] === MAT.SIDEWALK || cls[1] === MAT.SIDEWALK_JOINT || (want === 'any' && cls[1] === MAT.PLAZA);
  };
  const through = (r) => r.P.cls === 'arterial' || r.P.cls === 'collector';
  // plazas, squares and pocket plazas. Per block: a ring of street trees and benches along the paving edge
  // (every plaza reads as a designed space), and - only where there is room - a small cluster in the middle:
  // a kiosk or food cart with cafe tables around it. Small plazas get the ring only.
  if (R.blockArea === undefined) R.blockAreas();
  {
    const b = net.bounds, step = 4;
    const byBlock = new Map();
    for (let gz = b.z0; gz < b.z1; gz += step) for (let gx = b.x0; gx < b.x1; gx += step) {
      const c = F.blockAt(gx, gz), kind = c >= 0 ? R.blockArea.get(c) : undefined;
      if (kind !== 'pocket' && kind !== 'plaza') continue;       // Union Square keeps its own layout below
      R.classify(gx, gz, o, cls);
      if (!(cls[1] === MAT.PLAZA || cls[1] === MAT.PLAZA_JOINT)) continue;
      const depth = o.car - o.sw;
      if (depth < 1.5) continue;
      let L = byBlock.get(c); if (!L) byBlock.set(c, L = []);
      L.push({ x: gx, z: gz, depth, road: o.road, s: o.s });
    }
    for (const [c, L] of byBlock) {
      const ring = L.filter(p => p.depth < 3.6), inner = L.filter(p => p.depth > 7);
      ring.forEach((p, k) => {
        const r = net.roads[p.road], [px, pz] = pointAt(r, Math.max(0, Math.min(r.len, p.s)));
        const yaw = yawTowards(p.x, p.z, [px, pz]);
        if (k % 2 === 0) out.push({ type: 'tree', x: p.x, y: hsM, z: p.z, yaw, road: p.road });
        else if (k % 4 === 1) out.push({ type: 'bench', x: p.x, y: hsM, z: p.z, yaw: yaw + Math.PI, road: p.road });
      });
      if (inner.length >= 6) {
        let cx = 0, cz = 0; for (const p of inner) { cx += p.x; cz += p.z; } cx /= inner.length; cz /= inner.length;
        inner.sort((a, b2) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b2.x - cx, b2.z - cz));
        const hub = inner[0], h = hash2(c, 3, 9);
        out.push({ type: h < 0.5 ? 'newsstand' : 'hotdog', x: hub.x, y: hsM, z: hub.z, yaw: h * 6.28, road: hub.road });
        for (let k = 1; k < Math.min(inner.length, 5); ++k) out.push({ type: 'cafe', x: inner[k].x, y: hsM, z: inner[k].z, yaw: k, road: hub.road });
      }
    }
    // Union Square (and any 'square'): the original jittered layout, which reads well at that size
    for (let gz = b.z0; gz < b.z1; gz += 6.5) for (let gx = b.x0; gx < b.x1; gx += 6.5) {
      const h = hash2(Math.round(gx * 3), Math.round(gz * 3), 71), h2 = hash2(Math.round(gx * 5), Math.round(gz * 7), 29);
      const x = gx + (h - 0.5) * 3, z = gz + (h2 - 0.5) * 3;
      const c = F.blockAt(x, z);
      if (c < 0 || R.blockArea.get(c) !== 'square') continue;
      R.classify(x, z, o, cls);
      if (!(cls[1] === MAT.PLAZA || cls[1] === MAT.PLAZA_JOINT) || o.car < o.sw + 1.6) continue;
      const r = net.roads[o.road], [px, pz] = pointAt(r, Math.max(0, Math.min(r.len, o.s)));
      const yaw = yawTowards(x, z, [px, pz]), t = hash2(Math.round(gx), Math.round(gz), 5);
      const type = o.car < o.sw + 6 ? (t < 0.3 ? 'tree' : t < 0.5 ? 'bench' : t < 0.68 ? 'hotdog' : t < 0.8 ? 'newsstand' : 'cafe')
        : (t < 0.35 ? 'tree' : t < 0.55 ? 'cafe' : t < 0.75 ? 'bench' : t < 0.88 ? 'hotdog' : null);
      if (type) out.push({ type, x, y: hsM, z, yaw, road: o.road });
    }
  }
  for (const r of net.roads) {
    const P = r.P;
    if (P.id === 'alley' || !r.len) continue;
    const J = (r.junctions || []).filter(j => j.major);
    const nearJunction = (s, pad) => J.some(j => s > j.a - pad && s < j.b + pad);
    const frame = (s, u) => { const [px, pz, tx, tz] = pointAt(r, s); return [px + tz * u, pz - tx * u, tx, tz]; };
    // yaw such that local +z points from (x,z) towards the road centre and local +x along +t
    const yawFor = (tx, tz, side) => Math.atan2(side > 0 ? tx : -tx, side > 0 ? tz : -tz);
    // street lights
    const spacing = P.cls === 'arterial' ? 30 : P.cls === 'collector' ? 34 : 42;
    for (const side of [1, -1]) {
      for (let s = 10 + (side < 0 ? spacing / 2 : 0); s < r.len - 6; s += spacing) {
        if (nearJunction(s, 9)) continue;
        const u = side * (P.half + 0.55);
        const [x, z, tx, tz] = frame(s, u);
        if (!okAt(x, z, r.id)) continue;
        // local +z must point back towards the road: the road centre is at -side * normal
        out.push({ type: 'lamp', x, y: hsM, z, yaw: yawTowards(x, z, frame(s, 0)), road: r.id });
      }
      if (P.median === 'planted') {
        const med = P.edges.find(e => e.type === 'median');
        for (let s = 18; s < r.len - 10; s += 36) {
          if (nearJunction(s, 30)) continue;
          const [x, z, tx, tz] = frame(s, (med.left + med.right) / 2);
          if (side > 0 && okAt(x, z, r.id, 'median')) out.push({ type: 'lamp2', x, y: hsM, z, yaw: Math.atan2(tz, -tx), road: r.id });
        }
      }
      // hydrants
      for (let s = 20 + (side < 0 ? 40 : 0); s < r.len - 6; s += 85) {
        if (nearJunction(s, 7)) continue;
        const [x, z] = frame(s, side * (P.half + 0.45));
        if (okAt(x, z, r.id)) out.push({ type: 'hydrant', x, y: hsM, z, yaw: 0, road: r.id });
      }
    }
    // junction approaches: traffic moving +t arrives before interval a (right side u < 0),
    // traffic moving -t arrives after interval b (right side u > 0)
    const hasDir = (d) => P.edges.some(e => e.type === 'lane' && e.dir === d);
    for (const j of J) {
      const others = [...(j.others || [])].map(id => net.roads[id]).filter(Boolean);
      if (!others.length) continue;
      const signalised = through(r) && others.some(through);
      const mustStop = !through(r) && P.cls !== 'alley';
      for (const [d, sEdge, side] of [[1, j.a, -1], [-1, j.b, 1]]) {
        if (!hasDir(d)) continue;
        const s = sEdge - d * (0.8 + 3.2 + 1.2);
        if (s < 2 || s > r.len - 2) continue;
        const [x, z, tx, tz] = frame(s, side * (P.half + 0.7));
        if (!okAt(x, z, r.id, 'any')) continue;
        const yaw = yawTowards(x, z, frame(s, 0));
        // local +x must face the approaching traffic (which moves along d * t): heads face -d * t
        const wx = -d * tx, wz = -d * tz;                                        // towards the approaching traffic
        if (signalised) {
          const lanesIn = P.edges.filter(e => e.type === 'lane' && e.dir === d).length;
          const flip = facingFix(yaw, wx, wz);                                     // heads on the -x side variant
          out.push({ type: (lanesIn >= 2 || P.half > 6 ? 'signalLong' : 'signal') + (flip ? 'L' : ''), x, y: hsM, z, yaw, road: r.id,
                     phase: (r.id < Math.min(...others.map(q => q.id))) ? 0 : 1 });
        } else if (mustStop) out.push({ type: 'stop', x, y: hsM, z, yaw: Math.atan2(-wz, wx), road: r.id });
      }
    }
  }
  placeStreetFurniture(ctx, out);
  return out;
}
// Sidewalk furniture on downtown and old-town streets. Spots are on the curb side of the sidewalk (furniture zone,
// clear of the walking path and of building entrances), every footprint corner is checked on the voxel
// classification (sidewalk of that street, so never on crosswalks, curb returns or plazas), and everything keeps
// clear of the props already placed (lamps, hydrants, signal masts, stop signs, plaza furniture) and of each other.
// Density follows the street: corners get most of it (litter baskets, newspaper boxes, mailboxes, signal
// cabinets), avenues and collectors get mid-block baskets, bike racks and bus stops, parking lanes get meters.
const FURN_R = { lamp: 0.45, hydrant: 0.5, signal: 0.6, signalLong: 0.6, signalL: 0.6, signalLongL: 0.6, stop: 0.35, tree: 0.75, bench: 1.0,
  hotdog: 1.1, newsstand: 1.5, cafe: 1.4 };
function placeStreetFurniture(ctx, out) {
  const { net, F, R } = ctx;
  const hsM = R.hs * ctx.voxel, y = hsM - PV;                       // sunk one voxel into the sidewalk slab
  const o = {}, cls = [0, 0];
  const taken = new Map(), cell = 4;
  const key = (i, j) => i * 100003 + j;
  const addTaken = (x, z, r) => { const k = key(Math.floor(x / cell), Math.floor(z / cell)); let a = taken.get(k); if (!a) taken.set(k, a = []); a.push([x, z, r]); };
  const clear = (x, z, r) => {
    const i0 = Math.floor((x - r - 2) / cell), i1 = Math.floor((x + r + 2) / cell), j0 = Math.floor((z - r - 2) / cell), j1 = Math.floor((z + r + 2) / cell);
    for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) for (const [a, b, rr] of taken.get(key(i, j)) || []) if (Math.hypot(a - x, b - z) < r + rr) return false;
    return true;
  };
  for (const p of out) addTaken(p.x, p.z, FURN_R[p.type] || 0.5);
  const urbanRoads = net.roads.filter(r => (r.district === 'downtown' || r.district === 'oldtown') && r.P.id !== 'alley' && r.len);
  const urban = (x, z) => { for (const u of urbanRoads) if (distToPolyline([x, z], u.pts) < 60) return true; return false; };
  const alleys = net.roads.filter(r => r.P.id === 'alley' && r.len);
  const offAlley = (x, z, r) => { for (const a of alleys) if (distToPolyline([x, z], a.pts) < a.P.half + 1.2 + r) return false; return true; };   // keep alley mouths clear
  const isWalk = (x, z, road) => { R.classify(x, z, o, cls); return o.road === road && (cls[1] === MAT.SIDEWALK || cls[1] === MAT.SIDEWALK_JOINT); };
  let n = 0;
  for (const r of net.roads) {
    const P = r.P;
    if (P.id === 'alley' || !r.len || !P.sidewalk) continue;
    if (r.district === 'residential') continue;
    const through = P.cls === 'arterial' || P.cls === 'collector';
    const J = (r.junctions || []).filter(j => j.major);
    const nearJ = (s, pad) => J.some(j => s > j.a - pad && s < j.b + pad);
    const frame = (s, u) => { const [px, pz, tx, tz] = pointAt(r, s); return [px + tz * u, pz - tx * u, tx, tz]; };
    const parkSide = { 1: P.edges[0].type === 'park', [-1]: P.edges[P.edges.length - 1].type === 'park' };
    const sw = P.sidewalk;
    // one item at arc length s, curb offset c (m from the curb line into the sidewalk), half extents hx (along the
    // street) and hz (across); rad: clearance radius. Faces the street (+z) unless face = -1.
    const put = (type, s, side, c, hx, hz, rad, face) => {
      if (s < 2 || s > r.len - 2) return false;
      const u = side * (P.half + c);
      const [x, z] = frame(s, u);
      if (!urban(x, z) || !clear(x, z, rad) || !offAlley(x, z, rad)) return false;
      for (const [ds, du] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz], [0, 0]]) {
        const [qx, qz] = frame(s + ds, side * (P.half + c + du));
        if (!isWalk(qx, qz, r.id)) return false;
      }
      const [cx, cz] = frame(s, 0);
      let yaw = yawTowards(x, z, [cx, cz]);
      if (face === -1) yaw += Math.PI;
      out.push({ type, x, y, z, yaw, road: r.id });
      addTaken(x, z, rad);
      ++n;
      return true;
    };
    const H = (k, s) => hash2(r.id * 131 + k, Math.round(s * 7), 77);
    const trash = (s) => { const h = H(5, s); return h < 0.4 ? 'trashNYC' : h < 0.65 ? 'trashWire' : h < 0.85 ? 'trashSteel' : 'recycle'; };
    // corners: the sidewalk just behind each crosswalk / curb return, on both sides of the street
    for (const j of J) for (const [sEdge, d] of [[j.a, -1], [j.b, 1]]) for (const side of [1, -1]) {
      const s0 = sEdge + d * (P.crosswalk ? 6.2 : 3.6);
      if (s0 < 3 || s0 > r.len - 3) continue;
      const hh = H(side + 2 + (d > 0 ? 4 : 0), sEdge);
      // litter basket at most corners
      if (hh < (through ? 0.72 : 0.4)) {
        const t = trash(s0 + side);
        for (const ds of [0, 1.2, 2.4, 3.6]) if (put(t, s0 + d * ds, side, 0.65, t === 'recycle' ? 0.65 : 0.4, 0.4, t === 'recycle' ? 0.75 : 0.45)) break;
      }
      // signal controller cabinet at signalised corners (one corner of the junction), back of the sidewalk
      if (through && side === 1 && d === -1 && hh > 0.35 && hh < 0.85)
        for (const ds of [3, 5, 7]) if (put('cabinet', s0 + d * ds, side, sw - 0.75, 0.6, 0.45, 0.8, -1)) break;
      // newspaper boxes, in colourful clusters, facing the sidewalk
      if (through && H(side + 9, sEdge + d) < 0.45) {
        const t = H(side, sEdge * 3) < 0.5 ? 'news3' : 'news4';
        for (const ds of [3.2, 4.6, 6]) if (put(t, s0 + d * ds, side, 0.6, t === 'news3' ? 0.85 : 1.05, 0.35, 1.1)) break;
      }
      // mailbox now and then
      if (H(side + 13, sEdge - d) < (through ? 0.22 : 0.12))
        for (const ds of [6.5, 8, 9.5]) if (put('mailbox', s0 + d * ds, side, 0.6, 0.35, 0.35, 0.5)) break;
    }
    // mid-block: bus stops on avenues, litter baskets and bike racks on commercial streets, meters on parking lanes
    for (const side of [1, -1]) {
      if (P.cls === 'arterial' && sw >= 4) {
        for (const j of J) {
          if (H(side * 3 + 40, j.a) > 0.5) continue;
          // near side of the junction for traffic on this side (driving on the right: u < 0 travels +t)
          const s0 = side < 0 ? j.a - 22 : j.b + 22;
          if (nearJ(s0, 12)) continue;
          for (const ds of [0, -3, 3, -6, 6]) {
            if (put('busstop', s0 + ds, side, 1.4, 2.0, 0.75, 2.2)) {
              for (const k of [3.2, 4.2, 5.4, -3.2, 6.6]) if (put('busSign', s0 + ds + (side < 0 ? k : -k), side, 0.45, 0.15, 0.15, 0.3, -1)) break;
              break;
            }
          }
        }
      }
      const step = P.cls === 'arterial' ? 38 : P.cls === 'collector' ? 46 : 70;
      for (let s = 14 + H(side, 0) * 12; s < r.len - 10; s += step * (0.8 + 0.4 * H(side, s))) {
        if (nearJ(s, 10)) continue;
        const h = H(side + 20, s);
        if (h < 0.5) put(trash(s), s, side, 0.65, 0.45, 0.4, 0.5);
        else if (h < 0.72 && through) put(H(3, s) < 0.5 ? 'bikerack' : 'bikerackBike', s, side, 1.0, 1.2, 0.55, 1.3);
        else if (h < 0.8) put('utilbox', s, side, sw - 0.7, 0.4, 0.4, 0.6, -1);
      }
      // pickup day on some blocks: trash bags out at the curb in front of the buildings
      if (H(side + 60, 1) < 0.45)
        for (let s = 8 + H(side, 3) * 10; s < r.len - 8; s += 9 + 14 * H(side + 61, s)) {
          if (nearJ(s, 9)) continue;
          put('bags' + (1 + Math.floor(H(side + 62, s) * 3)), s, side, 0.9, 1.5, 0.6, 1.5);
        }
      // loading: a delivery van or box truck in the parking lane, now and then a roll-off container
      if (parkSide[side] && through) {
        const e = side > 0 ? P.edges[0] : P.edges[P.edges.length - 1], uc = (e.left + e.right) / 2;
        const isPark = (qx, qz) => { R.classify(qx, qz, o, cls); return o.road === r.id && (cls[1] === MAT.PARKING || cls[1] === MAT.PAINT_WHITE); };
        for (let s = 25 + H(side, 9) * 40; s < r.len - 12; s += 70 + 90 * H(side + 70, s)) {
          if (nearJ(s, 14)) continue;
          const h = H(side + 71, s);
          const type = h < 0.3 ? 'van' : h < 0.42 ? 'vanBlue' : h < 0.5 ? 'vanGrey' : h < 0.68 ? 'truck' : h < 0.78 ? 'truckBlue' : h < 0.86 ? 'truckGreen' : h < 0.94 ? 'rolloff' : 'rolloffBlue';
          const half = type.startsWith('truck') ? 3.9 : type.startsWith('van') ? 2.95 : 3.1;
          const pts = [-half, 0, half].map(ds => { const [px, pz, tx, tz] = pointAt(r, s + ds); return [px + tz * uc, pz - tx * uc]; });
          if (!pts.every(([qx, qz]) => isPark(qx, qz))) continue;
          const [x, z] = pts[1];
          if (!urban(x, z) || !clear(x, z, half) || !offAlley(x, z, half)) continue;
          // traffic on this side drives along -side * t; vehicles face the traffic direction
          const [, , tx, tz] = pointAt(r, s), d = side < 0 ? 1 : -1, wx = d * tx, wz = d * tz;
          out.push({ type, x, y: -PV, z, yaw: Math.atan2(-wz, wx), road: r.id });
          addTaken(x, z, half); ++n;
        }
      }
      if (parkSide[side]) {
        const kiosk = P.cls === 'arterial';
        const pitch = kiosk ? 38.4 : 12.8;
        for (let s = Math.ceil(12 / pitch) * pitch; s < r.len - 8; s += pitch) {
          if (nearJ(s, 8)) continue;
          if (kiosk) put('meterKiosk', s + 3.2, side, 0.5, 0.3, 0.25, 0.4);
          else put('meter', s, side, 0.38, 0.12, 0.12, 0.25);
        }
      }
    }
  }
  // bollards: short rows where plazas and pocket plazas meet the sidewalk
  if (R.blockArea) {
    for (const r of net.roads) {
      const P = r.P;
      if (P.id === 'alley' || !r.len || !P.sidewalk || r.district === 'residential') continue;
      const J = (r.junctions || []).filter(j => j.major);
      for (const side of [1, -1]) {
        const cand = [];
        for (let s = 3; s < r.len - 3; s += 1.5) {
          if (J.some(j => s > j.a - 4 && s < j.b + 4)) continue;
          const u = side * (P.half + P.sidewalk + 0.45);
          const [px, pz, tx, tz] = pointAt(r, s), x = px + tz * u, z = pz - tx * u;
          const c = F.blockAt(x, z), kind = c >= 0 ? R.blockArea.get(c) : undefined;
          if (kind !== 'pocket' && kind !== 'plaza' && kind !== 'square') continue;
          R.classify(x, z, o, cls);
          if (o.road !== r.id || !(cls[1] === MAT.PLAZA || cls[1] === MAT.PLAZA_JOINT)) continue;
          cand.push({ s, x, z });
        }
        // runs of plaza frontage: bollards only at the run ends (the corners), 4-5 each
        let k0 = 0;
        for (let k = 1; k <= cand.length; ++k) {
          if (k < cand.length && cand[k].s - cand[k - 1].s < 2) continue;
          const a = cand[k0].s, b = cand[k - 1].s;
          for (let q = k0; q < k; ++q) {
            const c = cand[q];
            if (c.s - a > 6.1 && b - c.s > 6.1) continue;
            if (!clear(c.x, c.z, 0.35)) continue;
            out.push({ type: 'bollard', x: c.x, y, z: c.z, yaw: 0, road: r.id }); addTaken(c.x, c.z, 0.35); ++n;
          }
          k0 = k;
        }
      }
    }
  }
  return n;
}
// yaw (rotation about +y) that turns local +z towards point c from (x, z)
function yawTowards(x, z, c) { return Math.atan2(c[0] - x, c[1] - z); }
// after rotating by yaw, local +x maps to (cos yaw, -sin yaw); return true if that points away from the wanted direction
function facingFix(yaw, wx, wz) { return (Math.cos(yaw) * wx - Math.sin(yaw) * wz) < 0; }

// ------------------------------------------------------------------------------------------------ network analysis
// Junction nodes for visualisation / export: crossings between different roads, and road ends on other roads.
function findJunctions(net) {
  const nodes = [];
  const roads = net.roads;
  const segsOf = (r) => { const s = []; for (let i = 0; i + 1 < r.pts.length; ++i) s.push([r.pts[i], r.pts[i + 1]]); return s; };
  const S = roads.map(segsOf);
  const addNode = (p, a, b) => {
    for (const n of nodes) if (Math.hypot(n.p[0] - p[0], n.p[1] - p[1]) < 8) { n.roads.add(a); n.roads.add(b); return; }
    nodes.push({ p, roads: new Set([a, b]) });
  };
  for (let i = 0; i < roads.length; ++i)
    for (let j = i + 1; j < roads.length; ++j)
      for (const [a, b] of S[i]) for (const [c, d] of S[j]) {
        const hit = segIntersect(a, b, c, d);
        if (hit) addNode(hit, i, j);
      }
  // ends touching another road (T-junctions where the end stops at the other centreline)
  for (let i = 0; i < roads.length; ++i)
    for (const e of [roads[i].pts[0], roads[i].pts[roads[i].pts.length - 1]])
      for (let j = 0; j < roads.length; ++j) if (j !== i && distToPolyline(e, roads[j].pts) < 0.6) addNode(e, i, j);
  return nodes.map(n => ({ x: n.p[0], z: n.p[1], roads: [...n.roads] }));
}
function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
function exportNetwork(net) {
  return {
    format: 'ttz-city-network/1', units: 'metres, x east, z south', seed: net.seed, kind: net.kind, bounds: net.bounds,
    profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, { label: p.label, bands: p.bands, sidewalk: p.sidewalk, cornerRadius: p.radius, median: p.median || null, centre: p.centre || null, crosswalk: p.crosswalk }])),
    roads: net.roads.map(r => ({ id: r.id, name: r.name, profile: r.profile, district: r.district, bulbEnd: r.bulbEnd || 0, points: r.pts.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]) })),
    areas: net.areas.map(a => Object.assign({}, a, { roadObj: undefined })),
    junctions: findJunctions(net)
  };
}

const CityCore = { pointAt, chamfer, PV, PM, PROP_PALETTE, PROP_TYPES, buildPropMeshes, placeProps, meshVoxels3D, VoxModel, PROFILES, MAT, MAT_NAMES, PALETTE, generateCity, generateTestArea, FieldSampler, Rasterizer, Plots, meshColumns, MeshBuffer, prepareBuild, buildChunk, buildBlocks, buildCity, runSync, findJunctions, exportNetwork, hash2, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = CityCore; else root.CityCore = CityCore;
})(typeof self !== 'undefined' ? self : this);
