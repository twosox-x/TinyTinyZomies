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
  const star = [30 + J(6), J(5)];                          // six-way junction: Grand x Division x Broadway
  const zG = star[1], xD = star[0];
  const bAng = (34 + J(4)) * Math.PI / 180;                // Broadway heading (SW -> NE)
  const bd = [Math.cos(bAng), Math.sin(bAng)];
  add('avenue', line([X0 - 12, zG], [X1 + 12, zG]), 'Grand Avenue', 'arterial');
  add('oneway', line([xD, Z0 - 12], [xD, Z1 + 12]), 'Division Street', 'arterial');
  const bT0 = clipLine(star, bd, [[1, 0, X1 + 12], [-1, 0, -(X0 - 12)], [0, 1, Z1 + 12], [0, -1, -(Z0 - 12)]]);
  const bwA = [star[0] + bd[0] * bT0[0], star[1] + bd[1] * bT0[0]], bwB = [star[0] + bd[0] * bT0[1], star[1] + bd[1] * bT0[1]];
  // Broadway bends gently north-east of the river quarter: straight to a point, then a long arc
  const bendT = 150 + J(20);
  const bendP = [star[0] + bd[0] * bendT, star[1] + bd[1] * bendT];
  const bd2a = bAng + (14 + J(4)) * Math.PI / 180;
  const broadway = add('avenue', [bwA, ...bezier(star, [star[0] + bd[0] * bendT * 0.6, star[1] + bd[1] * bendT * 0.6], bendP,
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
  const bwDist = (x, z) => Math.abs(-(bd[1]) * (x - star[0]) + bd[0] * (z - star[1]));
  const conflicts = (z) => xs.concat([xD]).filter(x => bwDist(x, z) < 11).length;
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
  const hb = (hx + 20 - star[0]) / bd[0];
  add('residential', bezier([hx, zG], [hx + 2, zG + 18], [hx + 12, zG + 30], [star[0] + bd[0] * (hb + 12), star[1] + bd[1] * (hb + 12)], 3), 'Hazel Street', 'residential');
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
  const tR = (Z1 - 2 - star[1]) / bd[1];
  add('lane', bezier(ridge0, [xD + 40, ridge0[1] - 25], [xD + 80, Z1 - 5], [Math.min(star[0] + bd[0] * tR, X1), Z1 + 12], 3), 'Ridge Lane', 'residential');

  // open spaces ----------------------------------------------------------------------------------------------
  const areas = [];
  areas.push({ kind: 'plaza', shape: 'circle', c: star, r: 46, name: 'Six Corners Plaza' });
  // a downtown square: the block between Central Avenue, the next street west and the first two streets north of Grand
  const xw = xs[Math.min(2, xs.length - 1)];
  if (zsN.length > 0) areas.push({ kind: 'square', shape: 'rect', x0: Math.min(xw, central), x1: Math.max(xw, central), z0: zG, z1: zsN[0], name: 'Union Square' });
  // river park north of Riverside Boulevard
  areas.push({ kind: 'park', shape: 'side', road: riverside.id, side: -1, name: 'Riverside Park' });
  // an open lot in the old town: a whole block left empty (horde gathering space)
  areas.push({ kind: 'lot', shape: 'circle', c: [origin[0] + ou[0] * 150 + ov[0] * -95, origin[1] + ou[1] * 150 + ov[1] * -95], r: 30, name: 'Freight Yard' });

  return { kind: 'city', seed, bounds: { x0: X0, z0: Z0, x1: X1, z1: Z1 }, roads, areas, origins: { star } };
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
  evalPoint(px, pz, out) {
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
    let car = 1e9, k = 0, j = -1, j2 = -1, dj = 1e9, dj2 = 1e9, wsum = 0, swsum = 0;
    for (let i = 0; i < touched.length; ++i) {
      const r = touched[i], d = dR[r], P = roads[r].P;
      if (i === 0) { car = d; k = P.radius; }
      else { const kk = Math.min(k, P.radius); car = smin(car, d, kk); k = Math.max(k, P.radius); }
      if (d < dj) { dj2 = dj; j2 = j; dj = d; j = r; } else if (d < dj2) { dj2 = d; j2 = r; }
      const w = 1 / Math.pow(Math.max(d, 0.5), 3);
      wsum += w; swsum += w * P.sidewalk;
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
        for (const side of [1, -1]) {
          const ex = px + tz * side * (half + 0.1), ez = pz - tx * side * (half + 0.1);
          this.evalPoint(ex, ez, o);
          const otherId = o.road === r.id ? o.road2 : o.road;
          const dOther = o.road === r.id ? o.oth : o.dj;
          if (otherId >= 0 && dOther < 0.2) { hit = true; if (this.net.roads[otherId].P.id !== 'alley' || r.P.id === 'alley') major = true; }
        }
        if (hit) {
          if (cur && s - cur.b <= step * 1.5) { cur.b = s; cur.major = cur.major || major; }
          else { cur = { a: s, b: s, major }; r.junctions.push(cur); }
        }
      }
    }
  }
  // distance along the road to the nearest major junction interval; 0 inside one; ahead = +1 if it lies at larger s
  junctionAt(r, s) {
    let best = 1e9, ahead = 0;
    const J = r.junctions;
    for (let i = 0; i < J.length; ++i) {
      const j = J[i];
      if (!j.major) continue;
      if (s >= j.a && s <= j.b) return [0, 0];
      const d = s < j.a ? j.a - s : s - j.b;
      if (d < best) { best = d; ahead = s < j.a ? 1 : -1; }
    }
    return [best, ahead];
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
    o.car = L(this.car); o.oth = L(this.oth); o.sw = L(this.sw);
    const near = fx < 0.5 ? (fz < 0.5 ? i00 : i01) : (fz < 0.5 ? i10 : i11);
    const r = this.road[near];
    o.road = r; o.road2 = this.road2[near]; o.ahead = this.ahead[near];
    if (this.road[i00] === r && this.road[i10] === r && this.road[i01] === r && this.road[i11] === r) { o.u = L(this.u); o.s = L(this.s); }
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
  [190, 186, 176], [128, 150, 104], [194, 186, 168], [198, 188, 170], [178, 168, 151], [138, 160, 110], [142, 138, 136], [154, 168, 124], [138, 134, 130], [196, 184, 158],
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
  areaAt(x, z, road, u) {
    for (const a of this.areas) {
      if (a.shape === 'circle') { if (Math.hypot(x - a.c[0], z - a.c[1]) < a.r) return a.kind; }
      else if (a.shape === 'rect') { if (x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1) return a.kind; }
      else if (a.shape === 'side') { if (road === a.road && u * a.side > 0) return a.kind; }
    }
    return null;
  }
  // classify one column -> [height in voxels, material]
  classify(x, z, o, out) {
    const F = this.F, hs = this.hs, v = this.v;
    F.sample(x, z, o);
    const car = o.car;
    if (o.road < 0 || car > 900) { out[0] = hs; out[1] = MAT.PLOT; return; }
    const road = this.roads[o.road], P = road.P;
    const minLine = Math.max(0.06, v * 0.55);               // markings never thinner than one voxel
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
      const [jd, ahead] = this.F.junctionAt(road, s);
      // asphalt tone: resurfaced stretches along each road between junctions; junction boxes plain
      const tone = jd === 0 ? 0 : hash2(road.id, Math.floor(s / 47), 11);
      const m = tone < 0.62 ? MAT.ASPHALT : tone < 0.84 ? MAT.ASPHALT_B : MAT.ASPHALT_C;
      if (jd === 0) { out[1] = MAT.ASPHALT; return; }                 // inside the junction: clean asphalt
      // crosswalk + stop line, square to this road, measured from the junction interval
      const cw0 = 0.8, cwW = 3.2, stop0 = cw0 + cwW + 0.7, stopW = Math.max(0.3, v * 2.5);
      const crossing = P.crosswalk;
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
        if (jd > cut) {
          out[0] = hs;
          out[1] = inside < 0.18 ? MAT.MEDIAN_CURB : (P.median === 'planted' ? MAT.MEDIAN_GRASS : MAT.MEDIAN_CURB);
          return;
        }
        // painted turn bay: yellow edges, a left-turn arrow on the half next to the inbound lanes
        if (inside < minLine * 1.6) { out[1] = MAT.PAINT_YELLOW; return; }
        const mid = (e.left + e.right) / 2;
        const bayLeft = ahead > 0 ? u < mid : u > mid;                 // inbound (+t) traffic is on the u < 0 side
        if (bayLeft && P.arrows) {
          const lc = (mid + (ahead > 0 ? e.right : e.left)) / 2;
          // lateral axis towards the driver's left: +u for +t traffic
          if (arrowGlyph((u - lc) * ahead, jd - stop0 - 3, true, minLine)) { out[1] = MAT.PAINT_WHITE; return; }
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
        if (arrowGlyph((u - lc) * ahead, jd - stop0 - 4, false, minLine)) out[1] = MAT.PAINT_WHITE;
      }
      return;
    }
    // outside the carriageway: curb, sidewalk, block
    if (P.id === 'alley' && car < 0.6 && o.road2 >= 0 && o.oth > 0.6) { out[0] = hs; out[1] = MAT.CURB; return; }
    if (car < 0.16) { out[0] = hs; out[1] = MAT.CURB; return; }
    const area = this.areaAt(x, z, o.road, o.u);
    if (car < o.sw) {
      out[0] = hs;
      if (area === 'plaza') { out[1] = plazaTile(x, z, v); return; }
      // slab joints across the sidewalk every 1.6 m along the nearest street, one voxel wide
      const ss = ((o.s % 1.6) + 1.6) % 1.6;
      out[1] = ss < v * 0.999 ? MAT.SIDEWALK_JOINT : MAT.SIDEWALK;
      return;
    }
    out[0] = hs;
    if (area === 'plaza' || area === 'square') { out[1] = plazaTile(x, z, v); return; }
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
  if (b < 0 || b > 6.0) return false;
  if (!left) {
    if (b < 1.6) return Math.abs(a) < 0.55 * (b / 1.6) + w * 0.5;      // head
    return Math.abs(a) < Math.max(0.12, w * 0.5) && b < 5.6;           // shaft
  }
  // left-turn arrow: shaft, bend to the left, head pointing left
  if (b > 2.4 && b < 5.6 && Math.abs(a) < Math.max(0.12, w * 0.5)) return true;
  if (b >= 1.9 && b <= 2.4 + 0.12 && a > -0.12 && a < 1.1) return true;
  const hb = Math.abs(b - 2.15);
  return a >= 1.1 && a < 2.4 && hb < 0.7 * (2.4 - a) / 1.3 + w * 0.5;
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
    while (s < len + 40) { s += range[0] + R() * (range[1] - range[0]); cuts.push(s); }
    return { cuts, gaps: cuts.map(() => (R() < (d === 'residential' ? 0.55 : 0.18) ? 1.6 + R() * 1.8 : 0)) };
  }
  // per-lot parameters
  lotInfo(roadId, lot) {
    const r = this.net.roads[roadId];
    const h = hash2(roadId * 7 + 3, lot, this.seed);
    const h2 = hash2(roadId * 13 + 1, lot, this.seed + 7);
    const d = r.district;
    let stories, depth, setback;
    const P = r.P;
    if (d === 'downtown' || d === 'arterial') { stories = 6 + Math.floor(h * h * 10); depth = 26 + h2 * 18; setback = 0; if (P.cls === 'arterial') stories += 2; }
    else if (d === 'oldtown') { stories = 4 + Math.floor(h * 5); depth = 18 + h2 * 10; setback = 0; }
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
  // building height map (in metres, 0 = no building) and plot ids per building cell
  build() {
    const n = this.nx * this.nz;
    this.height = new Float32Array(n);
    this.plot = new Int32Array(n).fill(-1);
    this.tone = new Uint8Array(n);
    const o = {}, F = this.F;
    for (let iz = 0; iz < this.nz; ++iz)
      for (let ix = 0; ix < this.nx; ++ix) {
        const x = this.x0 + (ix + 0.5) * this.cell, z = this.z0 + (iz + 0.5) * this.cell;
        F.sample(x, z, o);
        if (o.road < 0 || o.car > 900) continue;
        const area = this.Ra.areaAt(x, z, o.road, o.u);
        if (area || this.net.kind === 'test') continue;
        const depth0 = o.car - o.sw;                         // distance behind the sidewalk
        if (depth0 < 0.3) continue;
        // frontage road: nearest non-alley road (buildings face streets, back onto alleys)
        let rid = o.road, s = o.s;
        if (this.net.roads[rid].P.id === 'alley' && o.road2 >= 0 && this.net.roads[o.road2].P.id !== 'alley') { rid = o.road2; s = o.s2; }
        // corner: the two nearest streets both close -> one L-shaped corner lot on the lower road id
        if (o.road2 >= 0 && o.road2 < rid && this.net.roads[o.road2].P.id !== 'alley') {
          const i2 = this.lotInfo(o.road2, this.findLot(o.road2, o.s2));
          const behind = o.oth - o.sw;
          // within the frontage depth of the other street too -> part of its corner lot, unless the two streets
          // are parallel (back-to-back lots split at the middle of the block)
          if (behind < i2.setback + i2.depth && Math.abs(o.car - o.oth) > 2 && this.cornerish(rid, o.road2, x, z)) { rid = o.road2; s = o.s2; }
        }
        const lot = this.findLot(rid, s);
        const info = this.lotInfo(rid, lot);
        const depth = (rid === o.road ? o.car : o.oth) - o.sw;
        if (depth < info.setback || depth > info.setback + info.depth) continue;
        const L = this.lots[rid];
        if (L.gaps[lot] > 0 && s - L.cuts[lot] < L.gaps[lot]) continue;  // side gap between buildings
        const i = iz * this.nx + ix;
        this.height[i] = info.stories * 3.4;
        this.plot[i] = rid * 4096 + lot;
        this.tone[i] = info.tone;
      }
  }
}

// ------------------------------------------------------------------------------------------------ 6. mesher
// Greedy surface mesher for a 2.5D voxel column field (height h, material m per column):
//  - top faces: maximal rectangles of equal (h, m)
//  - walls: where neighbouring columns differ in height, vertical faces merged along runs of equal span/material
// Output: vertex positions in voxel units (integer corners, see finish()), per-vertex material and normal ids, indices.
class MeshBuffer {
  constructor() { this.pos = []; this.mat = []; this.nrm = []; this.idx = []; this.quads = 0; }
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
    eps = eps === undefined ? 0.01 : eps;
    const P = new Float32Array(this.pos.length);
    for (let q = 0; q < this.quads; ++q) {
      const o = q * 12;
      for (let a = 0; a < 3; ++a) {
        const c = (this.pos[o + a] + this.pos[o + 3 + a] + this.pos[o + 6 + a] + this.pos[o + 9 + a]) * 0.25;
        for (let k = 0; k < 4; ++k) { const v = this.pos[o + k * 3 + a]; P[o + k * 3 + a] = v + (v > c ? eps : v < c ? -eps : 0); }
      }
    }
    return { pos: P, mat: Uint8Array.from(this.mat), nrm: Uint8Array.from(this.nrm),
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
  const F = new FieldSampler(net, opts.fieldCell || 0.4);
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
  const buildings = emit(H, M, 0, plinth, true);
  const plots = emit(Hp, Mp, R.hs - bk + 1);
  let built = 0; for (let i = 0; i < PL.height.length; ++i) if (PL.height[i] > 0) built++;
  return { buildings, plots, plotCount: plotIds.size, builtArea: built * bcell * bcell };
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
  timing.buildings = Date.now() - t2;
  timing.total = Date.now() - t0;
  yield { stage: 'done', result: { chunks: ctx.chunks, buildings: blocks.buildings, plots: blocks.plots, plotCount: blocks.plotCount, voxel, hs: ctx.R.hs, cells, quads, timing } };
}
function runSync(gen) { let r; for (const step of gen) r = step; return r.result; }

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

const CityCore = { PROFILES, MAT, MAT_NAMES, PALETTE, generateCity, generateTestArea, FieldSampler, Rasterizer, Plots, meshColumns, MeshBuffer, prepareBuild, buildChunk, buildBlocks, buildCity, runSync, findJunctions, exportNetwork, hash2, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = CityCore; else root.CityCore = CityCore;
})(typeof self !== 'undefined' ? self : this);
