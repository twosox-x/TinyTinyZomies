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
  county: {
    label: 'County road (2 lanes, gravel shoulders)', cls: 'local',
    bands: [['lane', -1, 3.2], ['lane', 1, 3.2]],
    sidewalk: 1.4, radius: 6, centre: 'double', crosswalk: false, arrows: false
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
// opts.scale: map area multiple (default 1 = the original district, unchanged). Above 1 the inner city (downtown grid,
// old town, east quarter) grows by KC per axis inside a Beltway, and growOutskirts() adds the suburban and rural rings
// out to sqrt(scale) x the original extent (see the comment there).
// Spatial index of the road segments (once per network, 64 m grid buckets): roadSpans(net, box, m) -> Map road id ->
// sorted, merged arc-length intervals [s0, s1] of the road's segments that come within m of box ({x0,z0,x1,z1} or
// [x0,z0,x1,z1]). Streaming pages / tiles iterate only these roads and stretches instead of the whole map.
function roadIndex(net) {
  if (net._rix && net._rix.n === net.roads.length) return net._rix;
  const G = 64, cells = new Map(), segs = [];
  for (const r of net.roads) {
    let acc = 0;
    for (let i = 0; i + 1 < r.pts.length; ++i) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const k = segs.length; segs.push([r.id, acc, acc + len, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)]);
      acc += len;
      for (let gz = Math.floor(Math.min(az, bz) / G); gz <= Math.floor(Math.max(az, bz) / G); ++gz)
        for (let gx = Math.floor(Math.min(ax, bx) / G); gx <= Math.floor(Math.max(ax, bx) / G); ++gx) {
          const key = gx * 65536 + gz; let L = cells.get(key); if (!L) cells.set(key, L = []); L.push(k);
        }
    }
    if (r.pts.length && acc === 0) { const [ax, az] = r.pts[0]; const k = segs.length; segs.push([r.id, 0, 0, ax, az, ax, az]); const key = Math.floor(ax / G) * 65536 + Math.floor(az / G); let L = cells.get(key); if (!L) cells.set(key, L = []); L.push(k); }
  }
  return (net._rix = { n: net.roads.length, G, cells, segs });
}
function roadSpans(net, box, m) {
  const I = roadIndex(net), G = I.G;
  const x0 = (box.x0 !== undefined ? box.x0 : box[0]) - m, z0 = (box.z0 !== undefined ? box.z0 : box[1]) - m;
  const x1 = (box.x1 !== undefined ? box.x1 : box[2]) + m, z1 = (box.z1 !== undefined ? box.z1 : box[3]) + m;
  const seen = new Set(), by = new Map();
  for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); ++gz) for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); ++gx) {
    const L = I.cells.get(gx * 65536 + gz); if (!L) continue;
    for (const k of L) {
      if (seen.has(k)) continue; seen.add(k);
      const g = I.segs[k];
      if (g[3] > x1 || g[5] < x0 || g[4] > z1 || g[6] < z0) continue;
      let a = by.get(g[0]); if (!a) by.set(g[0], a = []); a.push([g[1], g[2]]);
    }
  }
  const out = new Map();
  for (const id of [...by.keys()].sort((a, b) => a - b)) {
    const a = by.get(id).sort((p, q) => p[0] - q[0]), mg = [];
    for (const iv of a) { const t = mg[mg.length - 1]; if (t && iv[0] <= t[1] + 1e-6) t[1] = Math.max(t[1], iv[1]); else mg.push([iv[0], iv[1]]); }
    out.set(id, mg);
  }
  return out;
}
// s within pad of one of the intervals
function inSpans(L, s, pad) { if (!L) return false; for (const [a, b] of L) if (s >= a - pad && s <= b + pad) return true; return false; }
function generateCity(seed, opts) {
  opts = opts || {};
  // (dev hook: a page or worker without the option reads self.CITY_LAB_SCALE, e.g. injected by a test harness)
  const scale = Math.max(1, +(opts.scale || (typeof self !== 'undefined' && self.CITY_LAB_SCALE)) || 1), KS = Math.sqrt(scale), KC = scale > 1 ? 1 + (KS - 1) * 0.36 : 1;
  if (scale > 1 || opts.gen === 'tensor') return tensorCity(seed, opts, scale);
  const R = mulberry32(seed * 7919 + 17);
  const J = (a) => (R() * 2 - 1) * a;
  const X0 = -330 * KC, X1 = 330 * KC, Z0 = -275 * KC, Z1 = 275 * KC;
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
  for (let a = 52 + J(6); a < 420 * KC; a += 48 + R() * 18) {             // lines along ov (roughly north-south)
    const p = [origin[0] + ou[0] * a, origin[1] + ou[1] * a];
    const t = clipLine(p, ov, oldHP);
    if (!t || t[1] - t[0] < 30) continue;
    add(oi % 3 === 1 ? 'residential' : 'street', line([p[0] + ov[0] * t[0], p[1] + ov[1] * t[0]], [p[0] + ov[0] * t[1], p[1] + ov[1] * t[1]]),
      `${oldNames[oi++ % oldNames.length]} Street`, 'oldtown');
  }
  for (let b = -(46 + J(6)); b > -420 * KC; b -= 44 + R() * 16) {          // lines along ou (roughly east-west)
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
  let vine = null;
  const wedgeN = KC > 1 ? 12 : 3, wedgeNames = ['Kent', 'Pearl', 'Ash', 'Elm', 'Walnut', 'Hickory', 'Poplar', 'Willow', 'Laurel', 'Holly', 'Juniper', 'Sycamore'];
  for (let k = 0; k < wedgeN; ++k) {
    const z = zG + 72 + k * (60 + J(6));
    if (k >= 3 && z > Z1 - 70) break;
    const xe = crossZ(broadway.pts, z, xD);
    if (xe === null || xe - xD < 40) continue;
    wedgeZ.push([z, xe]);
    add(k === 1 || k > 3 && k % 2 ? 'residential' : 'street', line([xD, z], [xe, z]), wedgeNames[k] + ' Street', 'residential');
  }
  if (wedgeZ.length >= 2) {
    const vx = xD + 95 + J(8);
    if (vx < wedgeZ[0][1] - 30) vine = add('residential', line([vx, wedgeZ[0][0]], [vx, Z1 - 30]), 'Vine Street', 'residential');
    const pz = wedgeZ[1][0];
    cul([xD + 45, pz], Math.PI * 0.5, 40, 'Linden Court', 0.1);
    if (wedgeZ.length > 2) cul([vx + 50, wedgeZ[2][0]], Math.PI * 0.5 + 0.25, 38, 'Birch Court', -0.12);
  }
  const ridge0 = [xD, Z1 - 30 + J(5)];
  const tR = (Z1 - 2 - bs[1]) / bd[1];
  const ridge = add('lane', bezier(ridge0, [xD + 40, ridge0[1] - 25], [xD + 80, Z1 - 5], [Math.min(bs[0] + bd[0] * tR, X1), Z1 + 12], 3), 'Ridge Lane', 'residential');
  // Vine Street runs on to Ridge Lane (a T junction) instead of stopping a few metres short of it behind a
  // sidewalk cap
  if (vine) {
    const vx = vine.pts[0][0], P = ridge.pts;
    for (let i = 0; i + 1 < P.length; ++i) {
      const [a, b] = [P[i], P[i + 1]];
      if ((a[0] - vx) * (b[0] - vx) > 0 || a[0] === b[0]) continue;
      const zr = a[1] + (b[1] - a[1]) * (vx - a[0]) / (b[0] - a[0]);
      if (zr > vine.pts[1][1] && zr - vine.pts[1][1] < 30) vine.pts[1] = [vx, zr];
      break;
    }
  }

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

  const net = { kind: 'city', seed, bounds: { x0: X0, z0: Z0, x1: X1, z1: Z1 }, roads, areas, origins: { star: plazaC, core: [central + 40, zG - 25] }, axes: { xD, zG } };
  if (scale > 1) growOutskirts(net, { KS, KC, xD, zG, add });
  return net;
}
// ------------------------------------------------------------------------------------------------ tensor-field city
// generateCity(seed, { scale > 1 }) or { gen: 'tensor' }: the whole city (core included) grown on a street tensor field,
// after Chen et al. 2008, "Interactive procedural street modeling":
//  1. terrain (pure functions of net.plan, evaluable anywhere): a meandering river across the map, a railway along one
//     bank, one or two wooded ridges, a lake or two;
//  2. a cross field (directions mod 90 degrees, blended as (cos 4t, sin 4t)) from basis fields: the downtown grid, an
//     old-town grid on Broadway's diagonal, suburban grids at other angles, grids of absorbed villages, a radial field
//     around the centre, boundary fields along the river banks and the hill contours, rotated by low-frequency noise
//     (more of it outward: curvier suburbs);
//  3. streamlines traced in both directions from seeds on the roads already placed (so every street starts on
//     another one): arterials first (they run on as county roads to the map edges and may bridge the river), then
//     collectors, then local streets with the block spacing of their zone; a streamline stops at water, at a steep
//     slope, where the density field fades (ragged urban edge, fields and woods reaching in between the corridors), or
//     near a parallel street; free ends snap forward onto the next street;
//  4. planar clean-up: dangling ends are cut back to their last junction (suburban tails become cul-de-sacs), courts
//     are added into large suburban blocks, roads are split at the junction where their zone changes and get the
//     profile / district of their class and zone;
//  5. land use (landUseAt / isRural / ruralGround) from the density field, the corridors, the terrain and an urban
//     reach grid (distance to the urban streets, net.plan.mask): beyond it fields, pasture and woods.
// Global decisions (the street network) are made once per seed in generateCity; everything per point is a pure
// function of net.plan, so tiles can evaluate it in any order.
const TAU = Math.PI * 2;
const TC_FU = 0.55, TC_RING = 66;                // TC_RING: countryside ring width per unit of ruralScale (x ku), m                             // urban share of the plain (urbanScale = ruralScale = 1) tensor map
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function tcRiver(rv, x, z) {                    // [u along the valley, signed distance to the centre line, slope]
  const u = x * rv.cf + z * rv.sf, v = -x * rv.sf + z * rv.cf, k1 = TAU / rv.L1, k2 = TAU / rv.L2;
  const c = rv.v0 + rv.a1 * Math.sin(k1 * u + rv.p1) + rv.a2 * Math.sin(k2 * u + rv.p2);
  const d = rv.a1 * k1 * Math.cos(k1 * u + rv.p1) + rv.a2 * k2 * Math.cos(k2 * u + rv.p2);
  return [u, (v - c) / Math.sqrt(1 + d * d), d];
}
const tcRiverHW = (rv, u) => rv.w * 0.5 * (1 + 0.16 * Math.sin(u / 170 + rv.p1));
function tcRail(P, x, z) {                      // signed distance to the railway centre line (a smoothed river offset)
  const rv = P.river, u = x * rv.cf + z * rv.sf, v = -x * rv.sf + z * rv.cf, k1 = TAU / rv.L1;
  const c = rv.v0 + P.rail.off + rv.a1 * Math.sin(k1 * u + rv.p1), d = rv.a1 * k1 * Math.cos(k1 * u + rv.p1);
  return (v - c) / Math.sqrt(1 + d * d);
}
function tcElev(P, x, z) {
  let e = 0;
  for (const h of P.hills) {
    const dx = x - h.c[0], dz = z - h.c[1], a = dx * h.ca + dz * h.sa, b = -dx * h.sa + dz * h.ca;
    e = Math.max(e, Math.exp(-(a * a / (2 * h.sl * h.sl) + b * b / (2 * h.ss * h.ss))));
  }
  return e > 0.05 ? e * (0.82 + 0.36 * vnoise(P.seed + 711, x / 90, z / 90)) : e;
}
// 0 dry, 1 river, 2 lake (m: margin in metres)
function tcWater(P, x, z, m) {
  const f = tcRiver(P.river, x, z);
  if (Math.abs(f[1]) < tcRiverHW(P.river, f[0]) + m) return 1;
  for (const l of P.lakes) {
    const dx = x - l.c[0], dz = z - l.c[1], R0 = l.r * 1.2 + m;          // lakeR <= 1.19 r: cheap reject first
    if (R0 <= 0 || dx * dx + dz * dz > R0 * R0) continue;
    if (Math.hypot(dx, dz) < lakeR(l, x, z) + m) return 2;
  }
  return 0;
}
// ---- water bodies as terrain (tensor maps): signed distance to the shore (m, > 0 in the water), river / lake banks
// sloping from the ground (+0.15) down to a bed under a smooth water surface at WATER.level (the engine draws the
// surface from the baked WATR grid), and road bridges over the water (the bank raster is carved under them).
const WATER = { level: -1.9, bank: 3.5, top: 0.15, toe: -2.3, bed: -3.6, bedRun: 8, carve: -2.6 };
function waterSD(net, x, z) {
  const P = net.plan; if (!P || P.kind !== 'tensor') return -1e9;
  const f = tcRiver(P.river, x, z); let sd = tcRiverHW(P.river, f[0]) - Math.abs(f[1]);
  for (const l of P.lakes) {
    const dx = x - l.c[0], dz = z - l.c[1], R0 = l.r * 1.2 + 20;
    if (dx * dx + dz * dz > R0 * R0) { sd = Math.max(sd, l.r * 0.8 - Math.hypot(dx, dz)); continue; }
    sd = Math.max(sd, lakeR(l, x, z) - Math.hypot(dx, dz));
  }
  return sd;
}
// bank surface height (m) at signed shore distance sd
// Voxel terraces, not a ramp: BANK_STEPS treads of bank / BANK_STEPS m, each riser (top - toe) / BANK_STEPS m (~0.6 m)
// high, so the bank reads as stacked stone / earth blocks at RTS range; the last tread is a riprap ledge just above the
// waterline. The bed under the surface keeps its gentle slope (hidden by the water).
const BANK_STEPS = 4;
function bankY(sd) {
  const W = WATER;
  if (sd <= -W.bank) return W.top;
  if (sd <= 0) { const k = Math.min(BANK_STEPS - 1, Math.floor((sd + W.bank) / W.bank * BANK_STEPS)); return W.top + (W.toe - W.top) * (k + 1) / BANK_STEPS; }
  return W.toe + (W.bed - W.toe) * Math.min(1, sd / W.bedRun);
}
// bridges: every road stretch over (or within the bank of) the water, as a straight deck rectangle from 3 m of land
// before the bank to 3 m after it. { A, B, ux, uz, len, hw, cw, road, cls, profile }. Cached per network.
const BRIDGES = new WeakMap();
function bridgePlan(net) {
  let L = BRIDGES.get(net); if (L) return L;
  L = [];
  const P = net.plan;
  if (P && P.kind === 'tensor') for (const r of net.roads) {
    const pr = PROFILES[r.profile] || {}, cw = (pr.bands || []).reduce((s, b) => s + b[2], 0), hw = cw / 2 + (pr.sidewalk || 2) + 0.4;
    const pts = r.pts, S = [];
    for (let i = 0; i + 1 < pts.length; ++i) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], l = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(l));
      for (let k = (i ? 1 : 0); k <= n; ++k) S.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    let a = -1, wet = false;
    const flush = (b) => {
      if (a >= 0 && wet && a > 0 && b < S.length - 1) {
        const i0 = Math.max(0, a - 3), i1 = Math.min(S.length - 1, b + 3), A = S[i0], Bp = S[i1], len = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]);
        if (len > 4) L.push({ A, B: Bp, ux: (Bp[0] - A[0]) / len, uz: (Bp[1] - A[1]) / len, len, hw, cw, road: r.id, cls: r.cls || pr.cls || '', profile: r.profile, side: pr.sidewalk || 2 });
      }
      a = -1; wet = false;
    };
    for (let k = 0; k < S.length; ++k) {
      const sd = waterSD(net, S[k][0], S[k][1]);
      if (sd > -WATER.bank - Math.min(hw, 6)) { if (a < 0) a = k; if (sd > 0) wet = true; }
      else if (a >= 0) flush(k - 1);
    }
    if (a >= 0) flush(S.length - 1);
  }
  BRIDGES.set(net, L);
  return L;
}
function bridgeAt(net, x, z, pad) {
  for (const b of bridgePlan(net)) {
    const rx = x - b.A[0], rz = z - b.A[1], t = rx * b.ux + rz * b.uz, d = -rx * b.uz + rz * b.ux;
    if (t >= -(pad || 0) && t <= b.len + (pad || 0) && Math.abs(d) <= b.hw + (pad || 0)) return { b, t, d };
  }
  return null;
}
// raster column of a bank / bed / bridge cut at (x, z), or null away from water: [y (m), material]
function waterColumn(net, x, z, onRoad) {
  const P = net.plan; if (!P || P.kind !== 'tensor' || !tcWater(P, x, z, WATER.bank + 0.2)) return null;
  const sd = waterSD(net, x, z); if (sd <= -WATER.bank) return null;
  const br = bridgeAt(net, x, z, 0);
  let y = bankY(sd);
  if (br) return [Math.min(y, WATER.carve), y < WATER.level ? GROUND.WATER : GROUND.SOIL];
  if (onRoad && sd < -0.8) return null;                  // a road grazing the bank stays flat
  if (y < WATER.level - 0.05) return [y, GROUND.WATER];   // under the surface (bed)
  // treads: riprap (stone blocks, 0.5 m checker of two rock tones + gravel) on the two lower steps, earth / gravel /
  // grass on the next, grass with bare patches on the top one; the risers take the tread's material (WALL_MAT)
  const h = hash2(Math.floor(x * 2), Math.floor(z * 2), 77), h2 = hash2(Math.floor(x / 1.5), Math.floor(z / 1.5), 78);
  const m = y < WATER.level + 0.9 ? (h < 0.42 ? GROUND.ROCK : h < 0.8 ? GROUND.ROCK_DARK : GROUND.GRAVEL)
    : sd > -1.8 ? (h < 0.35 ? GROUND.ROCK : h < 0.55 ? GROUND.GRAVEL : h2 < 0.5 ? GROUND.SOIL : GROUND.VERGE)
    : (h < 0.12 ? GROUND.SOIL : GROUND.VERGE);
  return [y, m];
}
function gridAt(G, x, z) {                      // bilinear sample of a Float32Array grid { x0, z0, cell, nx, nz, a }
  const fx = (x - G.x0) / G.cell, fz = (z - G.z0) / G.cell;
  const ix = clamp(Math.floor(fx), 0, G.nx - 2), iz = clamp(Math.floor(fz), 0, G.nz - 2), tx = clamp(fx - ix, 0, 1), tz = clamp(fz - iz, 0, 1), a = G.a, k = iz * G.nx + ix;
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + G.nx] * (1 - tx) + a[k + G.nx + 1] * tx) * tz;
}
// urban density 0..1: falls off from the centre (ragged by noise), raised along the arterial corridors and around
// absorbed villages, lowered on the slopes
function tcDens(P, x, z) {
  const D = P.dn, c = P.core, rv = P.river, ex = x - c[0], ez = z - c[1], eu = ex * rv.cf + ez * rv.sf, ev = -ex * rv.sf + ez * rv.cf;
  const d = Math.hypot(eu / 1.3, ev);                    // stretched along the valley
  const n1 = vnoise(P.seed + 501, x / (280 * P.ku), z / (280 * P.ku)) * 2 - 1, n2 = vnoise(P.seed + 503, x / 95, z / 95) * 2 - 1;
  let v = 1 - sstep(D.Rin, D.Rout, d * (1 - 0.26 * n1));
  for (const s of D.sub) { const q = (x - s.c[0]) ** 2 + (z - s.c[1]) ** 2; v = Math.max(v, s.a * Math.exp(-q / (2 * s.r * s.r))); }
  if (P.cor) v = Math.max(v, D.ca * gridAt(P.cor, x, z) * (1 - sstep(D.Rout * 0.55, D.Rout * 1.1, d * (1 - 0.25 * n1))));
  v += 0.08 * n2 + 0.06 * n1;
  const fr = tcRiver(rv, x, z)[1] * D.far;               // the far bank grew later: thinner
  if (fr > 0) v -= 0.16 * sstep(0, 80, fr);
  return clamp(v - 0.5 * Math.max(0, tcElev(P, x, z) - 0.35), 0, 1);
}
// zone from the density: core (towers), downtown, inner (old town, rows), suburban, exurban, rural
function tcZone(P, x, z, dn) {
  const d = dn === undefined ? tcDens(P, x, z) : dn, c = P.core;
  if (d > 0.88 && Math.hypot(x - c[0], z - c[1]) < P.dn.Rcore) return 'core';
  return d > 0.86 ? 'downtown' : d > 0.7 ? 'inner' : d > 0.34 ? 'suburban' : d > 0.24 ? 'exurban' : 'rural';
}
const TC_ZRANK = { core: 5, downtown: 4, inner: 3, suburban: 2, exurban: 1, rural: 0 };
function inPoly(pts, x, z) {                    // point in polygon (even-odd)
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; }
  return c;
}
function tcIsRural(net, x, z) {
  const P = net.plan;
  if (tcWater(P, x, z, 0)) return true;
  if (P.rail && Math.abs(tcRail(P, x, z)) < 7) return true;
  if (tcElev(P, x, z) > 0.62) return true;
  return gridAt(P.mask, x, z) > 0;
}
function tcGround(net, x, z, verge) {
  const P = net.plan, rv = P.river, f = tcRiver(rv, x, z), hw = tcRiverHW(rv, f[0]);
  if (Math.abs(f[1]) < hw + 5) return { kind: Math.abs(f[1]) < hw ? 'water' : 'shore', mat: Math.abs(f[1]) < hw ? GROUND.WATER : GROUND.VERGE };
  for (const l of P.lakes) { const d = Math.hypot(x - l.c[0], z - l.c[1]), r = lakeR(l, x, z); if (d < r + 4) return { kind: d < r ? 'water' : 'shore', mat: d < r ? GROUND.WATER : GROUND.VERGE }; }
  if (P.rail) {
    const sr = Math.abs(tcRail(P, x, z));
    if (sr < 7) return { kind: 'rail', mat: (Math.abs(sr - 0.75) < 0.12 || Math.abs(sr - 2.2) < 0.12) ? MAT.CURB : sr < 4.2 ? GROUND.GRAVEL : GROUND.VERGE };
  }
  for (const fm of P.farms) if (inFarm(fm, x, z, 0)) return { kind: 'farmyard', mat: GROUND.GRAVEL };
  if (verge < 4) return { kind: 'verge', mat: GROUND.VERGE };
  if (Math.abs(f[1]) < hw + 22) return { kind: 'forest', mat: GROUND.FOREST };          // riparian woods
  const e = tcElev(P, x, z), dn = tcDens(P, x, z), fn = forestNoise(net.seed, x, z);
  if (e > 0.5 || fn > 0.68 - 0.25 * dn - 0.1 * e) return { kind: 'forest', mat: GROUND.FOREST };
  if (dn > 0.3) return { kind: 'pasture', mat: GROUND.PASTURE };                      // in-town meadow
  const p = ruralParcel(net, x, z);
  if (p.kind === 'woodlot') return { kind: 'forest', mat: GROUND.FOREST, p };
  if (p.edge < 1.6) return { kind: 'headland', mat: GROUND.VERGE, p };
  const w = p.alongX ? z - p.z0 : x - p.x0, ph = (per) => ((w % per) + per) % per;
  let mat;
  if (p.kind === 'corn') mat = ph(2.4) < 1.6 ? GROUND.CROP : GROUND.FURROW;
  else if (p.kind === 'soy') mat = ph(2.0) < 1.3 ? GROUND.SOY : GROUND.FURROW;
  else if (p.kind === 'wheat') mat = ph(12) < 0.4 ? GROUND.FURROW : GROUND.WHEAT;
  else if (p.kind === 'ploughed') mat = ph(1.2) < 0.6 ? GROUND.SOIL : GROUND.FURROW;
  else mat = GROUND.PASTURE;
  return { kind: p.kind === 'pasture' ? 'pasture' : 'field', mat, p };
}
function tcLandUse(net, x, z) {
  const P = net.plan;
  if (tcIsRural(net, x, z)) {
    const g = tcGround(net, x, z, 99);
    return g.kind === 'shore' ? 'water' : g.kind === 'headland' || g.kind === 'verge' ? 'field' : g.kind;
  }
  for (const h of P.hubs) if (Math.hypot(h[0] - x, h[1] - z) < 70) return 'commercial';
  if (P.rail && P.ind && Math.abs(tcRail(P, x, z)) < P.ind.w) { const u = x * P.river.cf + z * P.river.sf; if (u > P.ind.u0 && u < P.ind.u1) return 'industrial'; }
  const zn = tcZone(P, x, z);
  if (zn === 'inner') return 'oldtown';
  if (zn === 'suburban' && P.art && gridAt(P.art, x, z) < 45) return 'transition';
  return zn === 'rural' ? 'exurban' : zn;
}

// binary heap of seeds (min key)
function tcHeap() {
  const a = [];
  return {
    get size() { return a.length; },
    push(v) { a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() { const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].k < a[m].k) m = l; if (r < a.length && a[r].k < a[m].k) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  };
}
function cutPts(pts, s0, s1) {                  // the part of a polyline between arc lengths s0 < s1
  const out = []; let acc = 0;
  for (let i = 0; i + 1 < pts.length; ++i) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= s0 && acc <= s1) {
      if (!out.length) { const t = l ? clamp((s0 - acc) / l, 0, 1) : 0; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      if (acc + l <= s1) out.push(b); else { const t = l ? clamp((s1 - acc) / l, 0, 1) : 0; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); break; }
    }
    acc += l;
  }
  return dedupe(out);
}
function rdp(pts, eps) {                        // Douglas-Peucker
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [i0, i1] = st.pop(); let dm = 0, im = -1;
    for (let i = i0 + 1; i < i1; ++i) { const d = segDist(pts[i][0], pts[i][1], pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1]); if (d > dm) { dm = d; im = i; } }
    if (dm > eps) { keep[im] = 1; st.push([i0, im], [im, i1]); }
  }
  return pts.filter((p, i) => keep[i]);
}

function generateTensorCity(seed, opts, scale) {
  // opts.urbanScale / opts.ruralScale (defaults 2 / 3): area multiples of the city and of the countryside around it,
  // relative to the plain scale-`scale` map (whose urban share is about TC_FU). Every city length (river meanders,
  // density radii, basis fields, hills, villages, low-frequency noise) grows by ku = sqrt(urbanScale), block sizes
  // stay; the map grows so that the rural ring gets ruralScale x its area.
  const US = Math.max(0.25, +(opts.urbanScale || 2)), RS = Math.max(0, +(opts.ruralScale === undefined ? 3 : opts.ruralScale));
  const KS = Math.sqrt(scale), ku = 0.94 * Math.sqrt(US), km = Math.max(ku, Math.sqrt(US * TC_FU + RS * (1 - TC_FU)));
  const OX0 = 330 * KS, OZ0 = 275 * KS, M = Math.min(OX0, OZ0) * ku, EDGE = 12;
  const R = mulberry32(seed * 48271 + 1013), J = (a) => (R() * 2 - 1) * a;
  const core = [J(0.07 * OX0 * ku), J(0.07 * OZ0 * ku)];
  let OX = OX0 * km, OZ = OZ0 * km, cx = 0, cz = 0;
  const P = { kind: 'tensor', seed, scale, OX, OZ, cx: 0, cz: 0, M, ku, km, US, RS, core, hills: [], lakes: [], farms: [], hubs: [], bridges: [], radials: [] };
  // ---- terrain
  const phi = R() * Math.PI, rv = P.river = { cf: Math.cos(phi), sf: Math.sin(phi), phi, a1: (50 + 40 * R()) * ku, L1: (1100 + 600 * R()) * ku, p1: R() * TAU,
    a2: (14 + 14 * R()) * ku, L2: (380 + 220 * R()) * ku, p2: R() * TAU, w: 34 + 12 * R(), v0: 0 };
  const rside = R() < 0.5 ? 1 : -1;
  {
    const uc = core[0] * rv.cf + core[1] * rv.sf, vc = -core[0] * rv.sf + core[1] * rv.cf, k1 = TAU / rv.L1, k2 = TAU / rv.L2;
    rv.v0 = vc + rside * (0.27 * M + 30 * R() * ku) - (rv.a1 * Math.sin(k1 * uc + rv.p1) + rv.a2 * Math.sin(k2 * uc + rv.p2));
  }
  // the railway follows the valley on the city side of the river (industry between it and the water)
  P.rail = { off: -rside * (rv.w * 0.6 + 40 + rv.a2) };
  const nH = 1 + (R() < 0.6 ? 1 : 0);
  for (let t = 0; t < 80 && P.hills.length < nH; ++t) {
    const a = R() * TAU, d = (0.72 + 0.4 * R()) * M, c = [core[0] + Math.cos(a) * d, core[1] + Math.sin(a) * d * OZ / OX];
    const rvf = tcRiver(rv, c[0], c[1]);
    if (Math.abs(rvf[1]) < 210 * ku || Math.abs(tcRail(P, c[0], c[1])) < 170 * ku) continue;
    if (P.hills.some(h => Math.hypot(h.c[0] - c[0], h.c[1] - c[1]) < 500 * ku)) continue;
    const b = R() * Math.PI;
    P.hills.push({ c, ca: Math.cos(b), sa: Math.sin(b), sl: (0.2 + 0.1 * R()) * M, ss: (0.085 + 0.035 * R()) * M });
  }
  const nL = 1 + (R() < 0.5 ? 1 : 0);
  for (let t = 0; t < 120 && P.lakes.length < nL; ++t) {
    const c = [J((OX0 - 80) * ku), J((OZ0 - 80) * ku)], r = (30 + 26 * R()) * ku;
    if (Math.hypot(c[0] - core[0], c[1] - core[1]) < 0.55 * M || Math.abs(tcRiver(rv, c[0], c[1])[1]) < r + 120 * ku || Math.abs(tcRail(P, c[0], c[1])) < r + 60 * ku) continue;
    if (P.lakes.some(l => Math.hypot(l.c[0] - c[0], l.c[1] - c[1]) < 400 * ku) || tcElev(P, c[0], c[1]) > 0.4) continue;
    P.lakes.push({ c, r, ph: R() * TAU });
  }
  P.dn = { Rin: 0.15 * M, Rout: 1.25 * M, Rcore: 0.4 * M, ca: 0.7, sub: [], far: rside };
  // absorbed villages: secondary centres out along the valley or on the far side
  const nV = 1 + (R() < 0.6 ? 1 : 0);
  for (let t = 0; t < 60 && P.dn.sub.length < nV; ++t) {
    const a = R() * TAU, d = (0.7 + 0.25 * R()) * M, c = [core[0] + Math.cos(a) * d, core[1] + Math.sin(a) * d];
    if (Math.abs(c[0]) > (OX0 - 120) * ku || Math.abs(c[1]) > (OZ0 - 120) * ku || tcWater(P, c[0], c[1], 60) || tcElev(P, c[0], c[1]) > 0.25) continue;
    if (P.dn.sub.some(s => Math.hypot(s.c[0] - c[0], s.c[1] - c[1]) < 0.8 * M)) continue;
    P.dn.sub.push({ c, r: 0.17 * M, a: 0.72, th: R() * Math.PI / 2 });
  }
  // a district on the far bank, opposite the centre (drawn without R: the rest of the seed's plan is unchanged)
  {
    const uc = core[0] * rv.cf + core[1] * rv.sf;
    for (let k = 0; k < 9; ++k) {
      const u = uc + [0, 1, -1, 2, -2, 3, -3, 4, -4][k] * 0.12 * M, rc = tcRiver(rv, rv.cf * u - rv.sf * 0, rv.sf * u + rv.cf * 0);
      const k1 = TAU / rv.L1, k2 = TAU / rv.L2, vr = rv.v0 + rv.a1 * Math.sin(k1 * u + rv.p1) + rv.a2 * Math.sin(k2 * u + rv.p2), v = vr + rside * 0.36 * M;
      const c = [rv.cf * u - rv.sf * v, rv.sf * u + rv.cf * v]; void rc;
      if (Math.abs(c[0]) > OX - 150 || Math.abs(c[1]) > OZ - 150 || tcWater(P, c[0], c[1], 80) || tcElev(P, c[0], c[1]) > 0.2) continue;
      P.dn.sub.push({ c, r: 0.2 * M, a: 0.8, th: phi, far: true }); break;
    }
  }
  // the map: centred on the town (density > 0.3 before the corridors), at least TC_RING m of countryside beyond it
  {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let z = -1.6 * OZ0 * ku; z <= 1.6 * OZ0 * ku; z += 24) for (let x = -1.6 * OX0 * ku; x <= 1.6 * OX0 * ku; x += 24) {
      if (tcDens(P, x, z) < 0.3 || tcWater(P, x, z, 0)) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    if (x1 > x0) {
      cx = Math.round((x0 + x1) / 2); cz = Math.round((z0 + z1) / 2);
      OX = Math.max(OX0 * ku, (x1 - x0) / 2 + TC_RING * RS * ku); OZ = Math.max(OZ0 * ku, (z1 - z0) / 2 + TC_RING * RS * ku);
    }
    Object.assign(P, { OX, OZ, cx, cz });
  }
  // ponds and lakes out in the countryside ring (own stream: the town's plan above is unchanged)
  {
    const R2 = mulberry32(seed * 9973 + 7), nE = Math.round(RS * 0.7);
    for (let t = 0, n = 0; t < 80 && n < nE; ++t) {
      const c = [cx + (R2() * 2 - 1) * (OX - 90), cz + (R2() * 2 - 1) * (OZ - 90)], r = 28 + 34 * R2();
      if (tcDens(P, c[0], c[1]) > 0.12 || Math.abs(tcRiver(rv, c[0], c[1])[1]) < r + 140 || Math.abs(tcRail(P, c[0], c[1])) < r + 60 || tcElev(P, c[0], c[1]) > 0.3) continue;
      if (P.lakes.some(l => Math.hypot(l.c[0] - c[0], l.c[1] - c[1]) < l.r + r + 300)) continue;
      P.lakes.push({ c, r, ph: R2() * TAU }); ++n;
    }
  }
  // ---- cross field
  const thD = J(0.22), thB = thD + (R() < 0.5 ? 1 : -1) * (0.62 + 0.18 * R());     // downtown grid, Broadway diagonal
  const bdir = [Math.cos(thB), Math.sin(thB)];
  const oc = [core[0] + bdir[0] * 0.42 * M * (R() < 0.5 ? 1 : -1), core[1] + bdir[1] * 0.42 * M];
  const basis = [{ c: core, th: thD, w: 3.2, s: 0.4 * M }, { c: oc, th: thB, w: 2.2, s: 0.26 * M }];
  for (const s of P.dn.sub) basis.push({ c: s.c, th: s.th, w: 2.0, s: 0.2 * M });
  const nS = 4 + Math.floor(R() * 2), a0 = R() * TAU;
  for (let k = 0; k < nS; ++k) {
    const a = a0 + TAU * (k + 0.3 * R()) / nS, d = (0.62 + 0.3 * R()) * M;
    basis.push({ c: [core[0] + Math.cos(a) * d, core[1] + Math.sin(a) * d], th: R() * Math.PI / 2, w: 1.3, s: 0.3 * M });
  }
  const FC = 8, fx0 = cx - OX - 40, fz0 = cz - OZ - 40, fnx = Math.ceil((2 * OX + 80) / FC) + 1, fnz = Math.ceil((2 * OZ + 80) / FC) + 1;
  const C4 = new Float32Array(fnx * fnz), S4 = new Float32Array(fnx * fnz);
  for (let j = 0; j < fnz; ++j) for (let i = 0; i < fnx; ++i) {
    const x = fx0 + i * FC, z = fz0 + j * FC;
    let cs = 0.15 * Math.cos(4 * thD), sn = 0.15 * Math.sin(4 * thD);
    const acc = (th, w) => { cs += w * Math.cos(4 * th); sn += w * Math.sin(4 * th); };
    for (const b of basis) { const q = (x - b.c[0]) ** 2 + (z - b.c[1]) ** 2; acc(b.th, b.w * Math.exp(-q / (2 * b.s * b.s))); }
    const dc = Math.hypot(x - core[0], z - core[1]);
    acc(Math.atan2(z - core[1], x - core[0]), 1.4 * sstep(0.4 * M, 1.1 * M, dc));
    const f = tcRiver(rv, x, z);
    acc(phi + Math.atan(f[2]), 2.6 * Math.exp(-f[1] * f[1] / (2 * (0.16 * M) ** 2)));
    const e = tcElev(P, x, z);
    if (e > 0.04) { const gx = tcElev(P, x + 3, z) - tcElev(P, x - 3, z), gz = tcElev(P, x, z + 3) - tcElev(P, x, z - 3); acc(Math.atan2(gz, gx), 3.5 * sstep(0.12, 0.5, e)); }
    const dn0 = 1 - sstep(P.dn.Rin, P.dn.Rout, dc);
    const rot = (vnoise(seed + 601, x / (260 * ku), z / (260 * ku)) * 2 - 1) * (0.1 + 0.32 * (1 - dn0)) + (vnoise(seed + 607, x / 120, z / 120) * 2 - 1) * 0.28 * (1 - dn0);
    const th = Math.atan2(sn, cs) / 4 + rot;
    C4[j * fnx + i] = Math.cos(4 * th); S4[j * fnx + i] = Math.sin(4 * th);
  }
  const dirAt = (x, z, d) => {
    const fx = (x - fx0) / FC, fz = (z - fz0) / FC, ix = clamp(Math.floor(fx), 0, fnx - 2), iz = clamp(Math.floor(fz), 0, fnz - 2), tx = clamp(fx - ix, 0, 1), tz = clamp(fz - iz, 0, 1), k = iz * fnx + ix;
    const c = (C4[k] * (1 - tx) + C4[k + 1] * tx) * (1 - tz) + (C4[k + fnx] * (1 - tx) + C4[k + fnx + 1] * tx) * tz;
    const s = (S4[k] * (1 - tx) + S4[k + 1] * tx) * (1 - tz) + (S4[k + fnx] * (1 - tx) + S4[k + fnx + 1] * tx) * tz;
    const th = Math.atan2(s, c) / 4;
    let bx = 0, bz = 0, bd = -2;
    for (let q = 0; q < 4; ++q) { const a = th + q * Math.PI / 2, ux = Math.cos(a), uz = Math.sin(a), dd = ux * d[0] + uz * d[1]; if (dd > bd) { bd = dd; bx = ux; bz = uz; } }
    return [bx, bz];
  };

  // ---- spatial indices: separation samples (point + tangent) and road segments
  const SC = 25, sep = new Map(), SG = 30, segs = new Map();
  const sepAdd = (x, z, tx, tz, id) => { const k = Math.floor(x / SC) * 65536 + Math.floor(z / SC); let a = sep.get(k); if (!a) sep.set(k, a = []); a.push(x, z, tx, tz, id); };
  // nearest sample within r of (x, z) that runs parallel to d (|cos| > cmin) and is not road `skip`
  const sepNear = (x, z, d, r, cmin, skip) => {
    const i0 = Math.floor((x - r) / SC), i1 = Math.floor((x + r) / SC), j0 = Math.floor((z - r) / SC), j1 = Math.floor((z + r) / SC), r2 = r * r;
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
      const a = sep.get(i * 65536 + j); if (!a) continue;
      for (let q = 0; q < a.length; q += 5) {
        if (a[q + 4] === skip) continue;
        const dx = a[q] - x, dz = a[q + 1] - z;
        if (dx * dx + dz * dz < r2 && Math.abs(a[q + 2] * d[0] + a[q + 3] * d[1]) > cmin) return a[q + 4];
      }
    }
    return -1;
  };
  const segAdd = (ri, a, b) => {
    const i0 = Math.floor(Math.min(a[0], b[0]) / SG), i1 = Math.floor(Math.max(a[0], b[0]) / SG), j0 = Math.floor(Math.min(a[1], b[1]) / SG), j1 = Math.floor(Math.max(a[1], b[1]) / SG);
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) { const k = i * 65536 + j; let L = segs.get(k); if (!L) segs.set(k, L = []); L.push([ri, a, b]); }
  };
  // first road hit by the ray p + d * t, 0 < t <= L: [t, road, segment direction]
  const rayHit = (p, d, L, skip) => {
    const q = [p[0] + d[0] * L, p[1] + d[1] * L];
    const i0 = Math.floor(Math.min(p[0], q[0]) / SG), i1 = Math.floor(Math.max(p[0], q[0]) / SG), j0 = Math.floor(Math.min(p[1], q[1]) / SG), j1 = Math.floor(Math.max(p[1], q[1]) / SG);
    let best = null;
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) for (const [ri, a, b] of segs.get(i * 65536 + j) || []) {
      if (ri === skip) continue;
      const h = segIntersect(p, q, a, b);
      if (!h) continue;
      const t = Math.hypot(h[0] - p[0], h[1] - p[1]);
      if (t > 0.5 && (!best || t < best[0])) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; best = [t, ri, [(b[0] - a[0]) / l, (b[1] - a[1]) / l], h]; }
    }
    return best;
  };
  const roads = [];                           // { lv, pts, ends: [kindStart, kindEnd], route? }
  const accept = (pts, lv, ends, extra) => {
    const ri = roads.length, r = Object.assign({ lv, pts, ends }, extra || {});
    roads.push(r);
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; ++i) {
      const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!l) continue;
      segAdd(ri, a, b);
      for (let t = (4 - acc % 4) % 4; t < l; t += 4) sepAdd(a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l, (b[0] - a[0]) / l, (b[1] - a[1]) / l, ri);
      acc += l;
    }
    return ri;
  };
  const dcore = (p) => Math.hypot(p[0] - core[0], p[1] - core[1]);
  const inMap = (p, m) => Math.abs(p[0] - cx) < OX + m && Math.abs(p[1] - cz) < OZ + m;
  const clipEdge = (p, q) => {                // point on p-q where it leaves the map + EDGE
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; ++i) { const m = (lo + hi) / 2; if (inMap([p[0] + (q[0] - p[0]) * m, p[1] + (q[1] - p[1]) * m], EDGE)) lo = m; else hi = m; }
    return [p[0] + (q[0] - p[0]) * lo, p[1] + (q[1] - p[1]) * lo];
  };
  // ---- levels
  const baseD = (p) => 1 - sstep(P.dn.Rin, P.dn.Rout, dcore(p));
  // field family of a direction (0 / 1: which of the two streamline families of the cross field it belongs to)
  const famOf = (p, d) => {
    const fx = (p[0] - fx0) / FC, fz = (p[1] - fz0) / FC, k = clamp(Math.round(fz), 0, fnz - 1) * fnx + clamp(Math.round(fx), 0, fnx - 1);
    const th = Math.atan2(S4[k], C4[k]) / 4, a = Math.atan2(d[1], d[0]) - th;
    return ((Math.round(a / (Math.PI / 2)) % 2) + 2) % 2;
  };
  // block spacing: downtown ~84 x 72 m, inner ~96 x 112 m, suburbs long blocks ~90 x 190 m (two lot rows deep)
  // pods: patches of the suburbs with deeper blocks (more of them get crescent loops in the infill below)
  const podAt = (p) => sstep(0.56, 0.68, vnoise(seed + 831, p[0] / (330 * ku), p[1] / (330 * ku)));
  const localSep = (p, d) => {
    const dn = tcDens(P, p[0], p[1]), f = d ? famOf(p, d) : 0, a = sstep(0.86, 0.72, dn), b = sstep(0.72, 0.5, dn);
    const s0 = 84 + 12 * a - 6 * b + 30 * b * podAt(p), s1 = 72 + 40 * a + 78 * b;
    return f === (P.fam || 0) ? s0 : s1;
  };
  const LV = [
    { name: 'major', h: 6, maxLen: 9000, minLen: 160, dens: -1, hill: 2, rail: true, bridge: true, ccos: 0.8, rej: 0.75,
      dsep: (p) => 300 + 60 * sstep(0.3 * M, 0.9 * M, dcore(p)) + 80 * sstep(0.35, 0.1, baseD(p)) },
    { name: 'collector', h: 5, maxLen: 2200, minLen: 90, dens: 0.42, hill: 0.55, rail: true, bridge: false, ccos: 0.8, rej: 0.9,
      dsep: (p, d) => { const l = localSep(p, d); return l > 150 ? 1.02 * l * 2 : l * (2.05 + sstep(0.84, 0.6, tcDens(P, p[0], p[1]))); } },
    { name: 'local', h: 4, maxLen: 1200, minLen: 34, dens: 0.34, hill: 0.48, rail: false, bridge: false, ccos: 0.82, rej: 0.72,
      dsep: localSep }
  ];
  // one half streamline from p0 along d0 (p0 excluded); returns { pts, end }
  const half = (p0, d0, lv, li, skip, ml) => {
    const pts = [], h = lv.h; let p = p0, d = d0, len = 0, end = 'len';
    for (let it = 0; it < (ml || lv.maxLen) / h; ++it) {
      const d1 = dirAt(p[0], p[1], d), pm = [p[0] + d1[0] * h / 2, p[1] + d1[1] * h / 2], d2 = dirAt(pm[0], pm[1], d1);
      let q = [p[0] + d2[0] * h, p[1] + d2[1] * h];
      if (!inMap(q, EDGE)) { pts.push(clipEdge(p, q)); end = 'edge'; break; }
      const wk = tcWater(P, q[0], q[1], 5);
      if (wk) {
        if (lv.bridge && wk === 1) {
          const f = tcRiver(rv, p[0], p[1]), ta = phi + Math.atan(f[2]), cr = Math.abs(Math.sin(Math.atan2(d2[1], d2[0]) - ta));
          let far = null;
          for (let t = 2; t < 150; t += 2) { const b = [p[0] + d2[0] * t, p[1] + d2[1] * t]; if (!tcWater(P, b[0], b[1], 5)) { far = [p[0] + d2[0] * (t + 4), p[1] + d2[1] * (t + 4)]; break; } }
          if (far && cr > 0.75 && inMap(far, 0) && P.bridges.length < 6 && P.bridges.every(b => Math.hypot(b.c[0] - p[0], b.c[1] - p[1]) > 260)) {
            P.bridges.push({ a: p, b: far, c: [(p[0] + far[0]) / 2, (p[1] + far[1]) / 2] });
            pts.push(far); p = far; d = d2; len += Math.hypot(far[0] - p0[0], far[1] - p0[1]); continue;
          }
        }
        end = 'water'; break;
      }
      if (P.rail && !lv.rail && Math.abs(tcRail(P, q[0], q[1])) < 12) { end = 'rail'; break; }
      if (tcElev(P, q[0], q[1]) > lv.hill) { end = 'hill'; break; }
      if (lv.dens > 0 && tcDens(P, q[0], q[1]) < lv.dens) { end = 'fade'; break; }
      const dt = 0.42 * lv.dsep(q, d2);
      const sk = len < 30 ? skip : -1;           // the seed road is ignored only near the seed
      if (sepNear(q[0], q[1], d2, dt, lv.ccos, sk) >= 0 && len > 6) { end = 'near'; break; }
      if (sepNear(q[0], q[1], d2, Math.min(dt, 14), 0.5, sk) >= 0 && len > 6) { end = 'near'; break; }   // shallow crossing
      // self loop
      if (it % 4 === 3 && pts.length > 30) { const back = Math.ceil(2 * dt / h); for (let k = 0; k < pts.length - back; k += 2) if (Math.hypot(pts[k][0] - q[0], pts[k][1] - q[1]) < dt) { end = 'loop'; it = 1e9; break; } if (end === 'loop') break; }
      // no knots: the heading may not turn by more than ~70 degrees within 40 m (circling a field singularity)
      const back = Math.ceil(40 / h);
      if (pts.length > back) { const a = pts[pts.length - back], b = pts[pts.length - back + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; if (((b[0] - a[0]) * d2[0] + (b[1] - a[1]) * d2[1]) / l < 0.34) { end = 'loop'; pts.length -= Math.ceil(back / 2); break; } }
      pts.push(q); p = q; d = d2; len += h;
    }
    return { pts, end, d };
  };
  // snap a free end forward onto the next road (a T junction), if it is close and not too oblique
  const snap = (pts, d, lv, L) => {
    const p = pts[pts.length - 1], hit = rayHit(p, d, L, -1);
    if (!hit || Math.abs(hit[2][0] * d[0] + hit[2][1] * d[1]) > 0.72) return false;
    for (let t = 4; t < hit[0]; t += 4) { const q = [p[0] + d[0] * t, p[1] + d[1] * t]; if (tcWater(P, q[0], q[1], 4) || (!lv.rail && P.rail && Math.abs(tcRail(P, q[0], q[1])) < 9)) return false; }
    pts.push(hit[3]);
    return true;
  };
  const traceFrom = (p, n, lv, li, skip, mlA, mlB) => {
    const A = half(p, n, lv, li, skip, mlA), B = half(p, [-n[0], -n[1]], lv, li, skip, mlB);
    const lenOf = (H) => H.pts.length ? Math.hypot(H.pts[0][0] - p[0], H.pts[0][1] - p[1]) + plen(H.pts) : 0;
    const snapL = li === 0 ? 220 : li === 1 ? 120 : Math.min(110, 0.75 * lv.dsep(p, n));
    for (const H of [A, B]) if (H.pts.length && H.end !== 'edge' && H.end !== 'loop') { if (snap(H.pts, H.d, lv, snapL)) H.end = 'snap'; }
    const la = lenOf(A), lb = lenOf(B);
    if (la + lb < lv.minLen) return -1;
    let okA = la >= Math.min(lv.minLen, 30) || A.end === 'snap', okB = lb >= Math.min(lv.minLen, 30) || B.end === 'snap';
    if (okA && okB) {                           // both halves curling round to the same side (a U): keep the longer
      const ea = A.pts[A.pts.length - 1], eb = B.pts[B.pts.length - 1], va = [ea[0] - p[0], ea[1] - p[1]], vb = [eb[0] - p[0], eb[1] - p[1]];
      if (va[0] * vb[0] + va[1] * vb[1] > -0.3 * Math.hypot(va[0], va[1]) * Math.hypot(vb[0], vb[1])) { if (la >= lb) okB = false; else okA = false; }
    }
    if (!okA && !okB) return -1;
    let pts, ends;
    if (okA && okB) { pts = B.pts.slice().reverse().concat([p], A.pts); ends = [B.end, A.end]; }
    else if (okA) { pts = [p].concat(A.pts); ends = [skip >= 0 ? 'snap' : 'free', A.end]; }
    else { pts = [p].concat(B.pts); ends = [skip >= 0 ? 'snap' : 'free', B.end]; }
    pts = dedupe(pts);
    if (pts.length < 2) return -1;
    return accept(pts, li, ends);
  };
  const seedRoad = (heap, ri, lv, li) => {
    const pts = roads[ri].pts, L = plen(pts);
    for (let s = 8 * hash2(ri, li, seed + 71); s < L - 6; s += 8) {
      const [x, z, tx, tz] = pointAtPts(pts, s), p = [x, z];
      heap.push({ k: dcore(p) + 12 * hash2(Math.round(x), Math.round(z), seed + 73), p, n: [-tz, tx], ri });
    }
  };
  // arterials: Main Street and Broadway through the centre, then the arterial net from seeds on them
  {
    const lv = LV[0];
    const d0 = dirAt(core[0], core[1], [1, 0]);
    traceFrom(core, d0, lv, 0, -1);
    roads[roads.length - 1].named = 'Main Street';
    const d1 = [-d0[1], d0[0]];
    traceFrom(core, d1, lv, 0, 0);
    if (roads.length > 1) roads[roads.length - 1].named = 'Division Street';
    // Broadway: a straight diagonal through the centre (ignores the field inside the core), then on the field
    const bl = 0.5 * M, a = [core[0] - bdir[0] * bl, core[1] - bdir[1] * bl], b = [core[0] + bdir[0] * bl, core[1] + bdir[1] * bl];
    const fw = [], bw = [];
    for (let t = 0; t <= bl; t += 6) { const q = [core[0] + bdir[0] * t, core[1] + bdir[1] * t]; if (tcWater(P, q[0], q[1], 5) || !inMap(q, 0)) break; fw.push(q); }
    for (let t = 6; t <= bl; t += 6) { const q = [core[0] - bdir[0] * t, core[1] - bdir[1] * t]; if (tcWater(P, q[0], q[1], 5) || !inMap(q, 0)) break; bw.push(q); }
    const pts = bw.reverse().concat(fw);
    if (pts.length > 10) {
      const A = half(pts[pts.length - 1], bdir, lv, 0, -1), B = half(pts[0], [-bdir[0], -bdir[1]], lv, 0, -1);
      const all = dedupe(B.pts.slice().reverse().concat(pts, A.pts));
      const ri = accept(all, 0, [B.end, A.end], { named: 'Broadway' });
      void a; void b; void ri;
    }
    // the bypass: a partial ring on the urban fringe, on the side away from the river (its free ends are cut back
    // to the last arterial it meets in the clean-up)
    const rb = 0.97 * M, w0 = Math.atan2(-rside * rv.cf, rside * rv.sf);       // away from the river, in (x, z)
    let run = [];
    const flush = () => { if (run.length > 30) accept(dedupe(run), 0, ['free', 'free'], { named: 'Route 30 Bypass', bypass: true }); run = []; };
    for (let t = -1.45; t <= 1.45; t += 0.004) {
      const a = w0 + t, cu = Math.cos(a - phi), sv = Math.sin(a - phi), rr = rb * (1 + 0.05 * Math.sin(3 * t + seed));
      const eu = cu * 1.3 * rr, ev = sv * rr, q = [core[0] + rv.cf * eu - rv.sf * ev, core[1] + rv.sf * eu + rv.cf * ev];
      if (!inMap(q, -30) || tcWater(P, q[0], q[1], 6) || tcElev(P, q[0], q[1]) > 0.6) { flush(); continue; }
      if (!run.length || Math.hypot(q[0] - run[run.length - 1][0], q[1] - run[run.length - 1][1]) > 6) run.push(q);
    }
    flush();
  }
  for (let li = 0; li < 3; ++li) {
    const lv = LV[li], heap = tcHeap(), n0 = roads.length;
    for (let ri = 0; ri < roads.length; ++ri) seedRoad(heap, ri, lv, li);
    let guard = 0;
    while (heap.size && guard++ < 20000) {
      const S = heap.pop(), p = S.p;
      if (tcWater(P, p[0], p[1], 8) || (lv.dens > 0 && tcDens(P, p[0], p[1]) < lv.dens)) continue;
      if (li > 0 && tcElev(P, p[0], p[1]) > lv.hill) continue;
      if (!lv.rail && P.rail && Math.abs(tcRail(P, p[0], p[1])) < 14) continue;
      const n = dirAt(p[0], p[1], S.n);
      if (Math.abs(n[0] * S.n[0] + n[1] * S.n[1]) < 0.75) continue;          // field not across the road here
      if (sepNear(p[0], p[1], n, lv.rej * lv.dsep(p, n), lv.ccos, S.ri) >= 0) continue;   // a parallel street within the spacing
      const ri = traceFrom(p, n, lv, li, S.ri);
      if (ri >= 0) seedRoad(heap, ri, lv, li);
    }
    if (li === 0) {
      // corridors: density is raised within ~120 m of the arterials (the city spreads out along them)
      const cell = 16, nx = Math.ceil((2 * OX + 64) / cell) + 1, nz = Math.ceil((2 * OZ + 64) / cell) + 1, a = new Float32Array(nx * nz).fill(1e9);
      const G = { x0: cx - OX - 32, z0: cz - OZ - 32, cell, nx, nz, a };
      for (let ri = n0 > 0 ? 0 : 0; ri < roads.length; ++ri) stampDist(G, roads[ri].pts, 260 * ku);
      for (let k = 0; k < a.length; ++k) a[k] = Math.exp(-a[k] * a[k] / (2 * 115 * 115 * ku * ku));
      P.cor = G;
    }
  }
  // ---- infill: blocks that came out too deep (> ~120 m, lots back to back) or too long (> ~260 m) get a street
  // down the middle; in the suburbs some deep blocks get a crescent loop instead of a through street
  {
    const lvF = Object.assign({}, LV[2], { name: 'infill', minLen: 30, dsep: (p, d) => 0.62 * localSep(p, d) });
    const FG = 16, cand = [];
    for (let z = cz - OZ + 40; z < cz + OZ - 40; z += FG) for (let x = cx - OX + 40; x < cx + OX - 40; x += FG) {
      const ix = Math.round(x / FG), iz = Math.round(z / FG), p = [x + (hash2(ix, iz, seed + 811) - 0.5) * 10, z + (hash2(iz, ix, seed + 813) - 0.5) * 10];
      const dn = tcDens(P, p[0], p[1]); if (dn < 0.3 || dn > 0.86) continue;
      cand.push({ p, dn, k: hash2(ix, iz, seed + 817) });
    }
    cand.sort((a, b) => a.k - b.k);
    const rayStep = (p, d, L) => {             // rayHit in 60 m steps (the first hit is near: cheap)
      for (let t0 = 0; t0 < L; t0 += 59) { const h = rayHit([p[0] + d[0] * t0, p[1] + d[1] * t0], d, Math.min(60, L - t0), -1); if (h) { h[0] += t0; return h; } }
      return null;
    };
    const ext = (p, d) => { const f = rayStep(p, d, 420); if (!f) return null; const b = rayStep(p, [-d[0], -d[1]], 420); return b ? [f[0], b[0]] : null; };
    const round = (a, b, c, r) => {             // corner b rounded (quadratic, r metres back along each leg)
      const la = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, lc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1, ra = Math.min(r, la / 2), rc = Math.min(r, lc / 2);
      const p0 = [b[0] + (a[0] - b[0]) * ra / la, b[1] + (a[1] - b[1]) * ra / la], p2 = [b[0] + (c[0] - b[0]) * rc / lc, b[1] + (c[1] - b[1]) * rc / lc], out = [];
      for (let t = 0; t <= 1.001; t += 0.2) out.push([(1 - t) * (1 - t) * p0[0] + 2 * t * (1 - t) * b[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * t * (1 - t) * b[1] + t * t * p2[1]]);
      return out;
    };
    for (let pass = 0; pass < 2; ++pass) for (const C of cand) {
      const p = C.p;
      if (sepNear(p[0], p[1], [1, 0], 30, -1, -1) >= 0) continue;
      if (tcWater(P, p[0], p[1], 20) || tcElev(P, p[0], p[1]) > 0.45 || (P.rail && Math.abs(tcRail(P, p[0], p[1])) < 30)) continue;
      const d = dirAt(p[0], p[1], [1, 0]), e = [-d[1], d[0]], A = ext(p, d); if (!A) continue;
      const B = ext(p, e); if (!B) continue;
      const a = A[0] + A[1], b = B[0] + B[1], ld = a >= b ? d : e, sd = a >= b ? e : d, L = a >= b ? A : B, S = a >= b ? B : A;
      const depth = S[0] + S[1], len = L[0] + L[1], sub = C.dn < 0.7, maxD = sub ? 118 : 126, maxL = sub ? 265 : 205;
      if (pass === 0 && depth > maxD && Math.abs(S[0] - S[1]) < 0.3 * depth && depth < 400) {
        const loop = () => {
          // crescent: in from the street on one long side, along the block, back out to the same street
          const sg = S[0] < S[1] ? 1 : -1, toS = [sd[0] * sg, sd[1] * sg];
          const H1 = half(p, ld, lvF, 2, -1, L[0] - 34), H2 = half(p, [-ld[0], -ld[1]], lvF, 2, -1, L[1] - 34);
          if (H1.pts.length < 4 || H2.pts.length < 4 || H1.end !== 'len' || H2.end !== 'len') return false;
          const mid = H2.pts.slice().reverse().concat([p], H1.pts), e1 = mid[0], e2 = mid[mid.length - 1];
          const h1 = rayStep(e1, toS, 90), h2 = rayStep(e2, toS, 90);
          if (!h1 || !h2 || h1[0] < 25 || h2[0] < 25 || h1[0] > 75 || h2[0] > 75) return false;
          const q1 = mid[Math.min(4, mid.length - 1)], q2 = mid[Math.max(0, mid.length - 5)];
          const pts = dedupe([h1[3]].concat(round(h1[3], e1, q1, 14), mid.slice(5, mid.length - 5), round(q2, e2, h2[3], 14), [h2[3]]));
          accept(pts, 2, ['snap', 'snap'], { loop: true }); return true;
        };
        if (!(sub && len > 150 && len < 420 && hash2(Math.round(p[0]), Math.round(p[1]), seed + 821) < 0.3 + 0.65 * podAt(p) && loop())) traceFrom(p, ld, lvF, 2, -1, L[0] - 2, L[1] - 2);
      } else if (pass === 1 && len > maxL && depth > 40 && depth < maxD + 20 && Math.abs(L[0] - L[1]) < 0.22 * len && len < 900) {
        traceFrom(p, sd, lvF, 2, -1, S[0] - 2, S[1] - 2);
      }
    }
  }
  // ---- clean-up: junctions per road, dangling ends cut back to the last junction (suburban tails: cul-de-sacs)
  let alive = roads.map(() => true);
  const junctions = () => {
    const js = roads.map(() => []), grid = new Map();
    roads.forEach((r, ri) => { if (!alive[ri]) return; let acc = 0; for (let i = 0; i + 1 < r.pts.length; ++i) { const a = r.pts[i], b = r.pts[i + 1]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const i0 = Math.floor(Math.min(a[0], b[0]) / SG), i1 = Math.floor(Math.max(a[0], b[0]) / SG), j0 = Math.floor(Math.min(a[1], b[1]) / SG), j1 = Math.floor(Math.max(a[1], b[1]) / SG);
      for (let x = i0; x <= i1; ++x) for (let z = j0; z <= j1; ++z) { const k = x * 65536 + z; let L = grid.get(k); if (!L) grid.set(k, L = []); L.push([ri, a, b, acc, l]); }
      acc += l; } });
    for (const L of grid.values()) for (let p = 0; p < L.length; ++p) for (let q = p + 1; q < L.length; ++q) {
      const A = L[p], B = L[q]; if (A[0] === B[0]) continue;
      // extend each segment by 0.3 m so ends lying on a centre line count
      const ea = [A[2][0] - A[1][0], A[2][1] - A[1][1]], eb = [B[2][0] - B[1][0], B[2][1] - B[1][1]], la = A[4] || 1, lb = B[4] || 1, k = 0.3;
      const a0 = [A[1][0] - ea[0] / la * k, A[1][1] - ea[1] / la * k], a1 = [A[2][0] + ea[0] / la * k, A[2][1] + ea[1] / la * k];
      const b0 = [B[1][0] - eb[0] / lb * k, B[1][1] - eb[1] / lb * k], b1 = [B[2][0] + eb[0] / lb * k, B[2][1] + eb[1] / lb * k];
      const h = segIntersect(a0, a1, b0, b1); if (!h) continue;
      js[A[0]].push([A[3] + clamp(Math.hypot(h[0] - A[1][0], h[1] - A[1][1]), 0, A[4]), B[0]]);
      js[B[0]].push([B[3] + clamp(Math.hypot(h[0] - B[1][0], h[1] - B[1][1]), 0, B[4]), A[0]]);
    }
    for (const j of js) { j.sort((a, b) => a[0] - b[0]); for (let i = j.length - 1; i > 0; --i) if (j[i][1] === j[i - 1][1] && j[i][0] - j[i - 1][0] < 1) j.splice(i, 1); }
    return js;
  };
  for (let pass = 0; pass < 5; ++pass) {
    const js = junctions(); let changed = false;
    roads.forEach((r, ri) => {
      if (!alive[ri]) return;
      const j = js[ri], L = plen(r.pts);
      const freeA = r.ends[0] !== 'edge' && !(j.length && j[0][0] < 1.5), freeB = r.ends[1] !== 'edge' && !(j.length && j[j.length - 1][0] > L - 1.5);
      if (!freeA && !freeB) return;
      if (!j.length || (j.length < 2 && freeA && freeB)) { alive[ri] = false; changed = true; return; }
      let s0 = freeA ? j[0][0] : 0, s1 = freeB ? j[j.length - 1][0] : L;
      // a suburban local tail of 35..110 m stays as a cul-de-sac (at most one per road)
      if (r.lv === 2 && !r.bulbEnd) {
        const tailB = L - s1, tailA = s0;
        const zB = tcZone(P, r.pts[r.pts.length - 1][0], r.pts[r.pts.length - 1][1]), zA = tcZone(P, r.pts[0][0], r.pts[0][1]);
        if (freeB && tailB > 35 && tailB < 110 && (zB === 'suburban' || zB === 'exurban')) { s1 = L; r.bulbEnd = 10.5; }
        else if (freeA && tailA > 35 && tailA < 110 && (zA === 'suburban' || zA === 'exurban')) { s0 = 0; r.bulbEnd = 10.5; r.flip = true; }
      }
      if (s1 - s0 < 20) { alive[ri] = false; changed = true; return; }
      if (s0 > 0.01 || s1 < L - 0.01) {
        r.pts = cutPts(r.pts, s0, s1); changed = true;
        if (freeA && s0 > 0.01) r.ends[0] = 'cut'; if (freeB && s1 < L - 0.01) r.ends[1] = 'cut';
      }
      if (r.flip) { r.pts.reverse(); r.ends.reverse(); r.flip = false; }
    });
    if (!changed) break;
  }
  // courts: dead-end lanes from suburban streets into the back land of large blocks
  const nR = roads.length;
  for (let ri = 0; ri < nR; ++ri) {
    const r = roads[ri]; if (!alive[ri] || r.lv === 0 || r.bulbEnd) continue;
    const L = plen(r.pts);
    for (let s = 30 + 20 * hash2(ri, 1, seed + 301); s < L - 30; s += 46) {
      const [x, z, tx, tz] = pointAtPts(r.pts, s), side = hash2(ri, Math.round(s), seed + 303) < 0.5 ? 1 : -1;
      const p = [x, z], z0 = tcZone(P, x, z);
      if (z0 !== 'suburban' && z0 !== 'exurban') continue;
      const want = 58 + 30 * hash2(ri, Math.round(s), seed + 307);
      let d = [-tz * side, tx * side], q = p; const pts = [p]; let ok = true;
      for (let t = 0; t < want; t += 4) {
        d = dirAt(q[0], q[1], d); q = [q[0] + d[0] * 4, q[1] + d[1] * 4];
        if (!inMap(q, -40) || tcWater(P, q[0], q[1], 14) || tcElev(P, q[0], q[1]) > 0.5 || tcDens(P, q[0], q[1]) < 0.28 || (P.rail && Math.abs(tcRail(P, q[0], q[1])) < 20)) { ok = false; break; }
        if (t > 8 && sepNear(q[0], q[1], d, t > want - 8 ? 40 : 30, -1, ri) >= 0) { ok = false; break; }
        pts.push(q);
      }
      if (!ok) continue;
      const k = accept(pts, 2, ['snap', 'bulb'], { bulbEnd: 10.5, court: true });
      alive[k] = true; s += 60;
    }
  }
  return { P, roads, alive, LV, dirAt, sepNear, accept, junctions, rayHit, bdir, thD };
}
// min distance from each grid node to a polyline (within reach r), in place
function stampDist(G, pts, r, off) {
  off = off || 0;
  for (let i = 0; i + 1 < pts.length; ++i) {
    const a = pts[i], b = pts[i + 1];
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r - G.x0) / G.cell)), i1 = Math.min(G.nx - 1, Math.ceil((Math.max(a[0], b[0]) + r - G.x0) / G.cell));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r - G.z0) / G.cell)), j1 = Math.min(G.nz - 1, Math.ceil((Math.max(a[1], b[1]) + r - G.z0) / G.cell));
    for (let j = j0; j <= j1; ++j) for (let k = i0; k <= i1; ++k) {
      const d = segDist(G.x0 + k * G.cell, G.z0 + j * G.cell, a[0], a[1], b[0], b[1]), q = j * G.nx + k;
      if (d - off < G.a[q]) G.a[q] = d - off;
    }
  }
}
// emit the traced network into ordinary roads (profiles / districts / zones), open spaces and the land-use plan
function tensorCity(seed, opts, scale) {
  const T = generateTensorCity(seed, opts, scale), { P, alive } = T, core = P.core, M = P.M;
  const src = T.roads.filter((r, i) => alive[i]);
  // final junctions on the kept roads
  T.roads.length = 0; T.alive.length = 0;
  src.forEach(r => { T.roads.push(r); T.alive.push(true); });
  const js = T.junctions();
  const ZC = { core: 'U', downtown: 'U', inner: 'U', suburban: 'S', exurban: 'X', rural: 'R' };
  // routes: the two or three longest arterials that run edge to edge
  const routes = src.map((r, i) => ({ i, L: plen(r.pts), e: r.lv === 0 && r.ends[0] === 'edge' && r.ends[1] === 'edge' })).filter(o => o.e).sort((a, b) => b.L - a.L).slice(0, 2 + (seed % 2));
  routes.forEach(o => { src[o.i].route = true; });
  src.forEach(r => { if (r.bypass) r.route = true; });
  const pieces = [];
  src.forEach((r, ri) => {
    const L = plen(r.pts), cuts = [0].concat(js[ri].map(j => j[0]).filter(s => s > 0.5 && s < L - 0.5), [L]);
    const cls = [];
    for (let k = 0; k + 1 < cuts.length; ++k) {
      const [x, z] = pointAtPts(r.pts, (cuts[k] + cuts[k + 1]) / 2);
      let c = ZC[tcZone(P, x, z)];
      if (c === 'X') c = r.lv === 0 ? 'R' : 'S';
      if (tcWater(P, x, z, 2)) c = cls.length ? cls[cls.length - 1] : null;      // bridges keep their approach's class
      cls.push(c);
    }
    for (let k = 0; k < cls.length; ++k) if (cls[k] === null) cls[k] = cls.slice(k).find(c => c) || 'R';
    // runs, short runs folded into the previous one
    const runs = [];
    for (let k = 0; k < cls.length; ++k) {
      const last = runs[runs.length - 1];
      if (last && last.c === cls[k]) last.s1 = cuts[k + 1]; else runs.push({ c: cls[k], s0: cuts[k], s1: cuts[k + 1] });
    }
    for (let k = runs.length - 1; k > 0; --k) if (runs[k].s1 - runs[k].s0 < 70 && runs.length > 1) { runs[k - 1].s1 = runs[k].s1; runs.splice(k, 1); }
    for (let k = runs.length - 1; k > 0; --k) if (runs[k].c === runs[k - 1].c) { runs[k - 1].s1 = runs[k].s1; runs.splice(k, 1); }
    runs.forEach((u, k) => {
      const pts = runs.length === 1 ? r.pts : cutPts(r.pts, u.s0, u.s1);
      const [mx, mz] = pointAtPts(pts, plen(pts) / 2);
      pieces.push({ src: r, ri, c: u.c, pts, zone: tcZone(P, mx, mz), bulb: k === runs.length - 1 ? r.bulbEnd : 0, mid: [mx, mz] });
    });
  });
  // profiles, districts, names
  const NM = {
    major: ['Washington', 'Lincoln', 'Jefferson', 'Franklin', 'Madison', 'Grand', 'Central', 'Park', 'Market', 'State', 'Union', 'Liberty', 'Prospect', 'Monroe', 'Jackson', 'Hamilton', 'Commerce', 'Western', 'Lakeview', 'Chestnut'],
    old: ['Water', 'Mill', 'Front', 'Church', 'Bridge', 'Ferry', 'Dock', 'Canal', 'Wharf', 'Court', 'Spring', 'High', 'Pearl', 'Locust', 'Walnut', 'Cherry', 'Vine', 'Elm', 'Pine', 'Cedar'],
    sub: ['Meadow', 'Fox Run', 'Briar', 'Cedar Hill', 'Orchard', 'Brookside', 'Heather', 'Quail', 'Aspen', 'Stonegate', 'Sunset', 'Clover', 'Deer Path', 'Hollow', 'Ivy', 'Kingsley', 'Willow Bend', 'Maple Glen', 'Prairie', 'Sutton', 'Ashford', 'Linden', 'Wexford', 'Bramble', 'Hawthorn', 'Juniper', 'Laurel', 'Magnolia', 'Partridge', 'Ridgeview']
  };
  const roads = [];
  let nSt = 0, cr = 0;
  const hname = (k, list) => list[Math.floor(hash2(k, 7, seed + 91) * list.length)];
  for (const pc of pieces) {
    const r = pc.src, lv = r.lv, h = hash2(Math.round(pc.mid[0]), Math.round(pc.mid[1]), seed + 93);
    const zl = pc.zone === 'inner' ? 'oldtown' : pc.zone;
    let profile, district;
    if (pc.c === 'R') { profile = r.route ? 'boulevard' : 'county'; district = 'residential'; }
    else if (lv === 0) { profile = r.route && pc.c === 'S' ? 'boulevard' : 'avenue'; district = pc.c === 'U' ? 'arterial' : 'residential'; }
    else if (pc.c === 'S') { profile = lv === 1 ? 'street' : pc.bulb ? 'lane' : 'residential'; district = 'residential'; }
    else if (pc.zone === 'inner') { profile = lv === 1 ? 'street' : 'residential'; district = 'oldtown'; }
    else { profile = lv === 1 ? (h < 0.5 ? 'oneway' : 'street') : h < 0.3 ? 'oneway' : 'street'; district = 'downtown'; }
    let name;
    if (r.named) name = r.named;
    else if (r.bypass) name = 'Bypass ' + (9 + 3 * (routes.length + 1));
    else if (pc.c === 'R') name = r.route ? `Route ${9 + 3 * (routes.findIndex(o => src[o.i] === r) + 1)}` : `County Road ${10 + 2 * (r.cr || (r.cr = ++cr))}`;
    else if (lv === 0) name = (r.nm || (r.nm = hname(pc.ri, NM.major))) + (r.route ? ' Highway' : ' Avenue');
    else if (district === 'downtown') name = `${ordinal(++nSt)} Street`;
    else if (district === 'oldtown') name = hname(pc.ri, NM.old) + (lv === 1 ? ' Street' : ' Lane');
    else name = hname(pc.ri, NM.sub) + (r.loop ? ' Circle' : pc.bulb ? ' Court' : lv === 1 ? ' Road' : [' Drive', ' Street', ' Way', ' Lane'][Math.floor(h * 4)]);
    const pts = rdp(pc.pts, 0.12);
    const rd = { id: roads.length, profile, pts, name, district, zone: pc.c === 'R' ? 'rural' : zl, cls: ['major', 'collector', 'local'][lv] };
    if (pc.bulb) rd.bulbEnd = pc.bulb;
    roads.push(rd);
  }
  // open spaces: the downtown square (the block nearest the centre), parks in a few residential blocks
  const areas = [];
  areas.push({ kind: 'square', shape: 'circle', c: [core[0] + 35, core[1] + 35], r: 30, name: 'Court Square' });
  // land-use grids: urban reach (distance to urban streets minus the lot depth of their zone), arterial distance
  const mk = (cell) => { const nx = Math.ceil((2 * P.OX + 64) / cell) + 1, nz = Math.ceil((2 * P.OZ + 64) / cell) + 1; return { x0: P.cx - P.OX - 32, z0: P.cz - P.OZ - 32, cell, nx, nz, a: new Float32Array(nx * nz).fill(1e4) }; };
  const mask = mk(4), art = mk(16);
  const REACH = { core: 80, downtown: 80, oldtown: 70, suburban: 50, exurban: 55 };
  for (const r of roads) {
    if (r.zone === 'rural') continue;
    const reach = REACH[r.zone] || 50;
    stampDist(mask, r.pts, reach + 8, reach);
    if (r.cls === 'major') stampDist(art, r.pts, 80, 0);
  }
  P.mask = mask; P.art = art;
  // neighbourhood parks and school grounds: about one block in every 420 m cell of the suburbs / old town is left open
  {
    const SGc = 40, ix = new Map();
    for (const r of roads) for (let i = 0; i + 1 < r.pts.length; ++i) {
      const a = r.pts[i], b = r.pts[i + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / SGc); x <= Math.floor(Math.max(a[0], b[0]) / SGc); ++x) for (let z = Math.floor(Math.min(a[1], b[1]) / SGc); z <= Math.floor(Math.max(a[1], b[1]) / SGc); ++z) {
        const k = x * 65536 + z; let L = ix.get(k); if (!L) ix.set(k, L = []); L.push([a, b]);
      }
    }
    const near = (p, rr) => { for (let x = Math.floor((p[0] - rr) / SGc); x <= Math.floor((p[0] + rr) / SGc); ++x) for (let z = Math.floor((p[1] - rr) / SGc); z <= Math.floor((p[1] + rr) / SGc); ++z) for (const [a, b] of ix.get(x * 65536 + z) || []) if (segDist(p[0], p[1], a[0], a[1], b[0], b[1]) < rr) return true; return false; };
    const ray = (p, d) => { for (let t = 4; t < 260; t += 3) if (near([p[0] + d[0] * t, p[1] + d[1] * t], 3)) return t; return 0; };
    const PC = 380, PN = ['Lincoln', 'Roosevelt', 'Garfield', 'Kennedy', 'Wilson', 'Jefferson', 'Hoover', 'Grant', 'Adams', 'Truman', 'Cleveland', 'Taft'];
    let np = 0;
    for (let gz = Math.floor((P.cz - P.OZ) / PC); gz * PC < P.cz + P.OZ; ++gz) for (let gx = Math.floor((P.cx - P.OX) / PC); gx * PC < P.cx + P.OX; ++gx) {
      for (let t = 0; t < 14; ++t) {
        const p = [(gx + hash2(gx, gz * 31 + t, seed + 851)) * PC, (gz + hash2(gz, gx * 31 + t, seed + 853)) * PC];
        const zn = tcZone(P, p[0], p[1]);
        if ((zn !== 'suburban' && zn !== 'inner') || tcIsRural({ plan: P }, p[0], p[1]) || near(p, 24)) continue;
        if (P.rail && Math.abs(tcRail(P, p[0], p[1])) < 80) continue;
        const d = T.dirAt(p[0], p[1], [1, 0]), e = [-d[1], d[0]], f1 = ray(p, d), f2 = ray(p, [-d[0], -d[1]]), g1 = ray(p, e), g2 = ray(p, [-e[0], -e[1]]);
        if (!f1 || !f2 || !g1 || !g2 || (f1 + f2) * (g1 + g2) > 24000 || (f1 + f2) * (g1 + g2) < 5000) continue;
        const q = (s, u) => [p[0] + d[0] * s + e[0] * u, p[1] + d[1] * s + e[1] * u];
        // inset to the lot line; the block must be near-rectangular (no street crossing the rectangle's edges)
        const poly = [q(f1 - 12, g1 - 12), q(-f2 + 12, g1 - 12), q(-f2 + 12, -g2 + 12), q(f1 - 12, -g2 + 12)];
        let cross = false;
        for (let k = 0; k < 4 && !cross; ++k) { const A = poly[k], B = poly[(k + 1) % 4], l = Math.hypot(B[0] - A[0], B[1] - A[1]); for (let s = 0; s <= l; s += 4) if (near([A[0] + (B[0] - A[0]) * s / l, A[1] + (B[1] - A[1]) * s / l], 3.5)) { cross = true; break; } }
        if (cross) continue;
        const school = np % 3 === 1, nm = PN[Math.floor(hash2(gx, gz, seed + 857) * PN.length)];
        areas.push({ kind: 'park', shape: 'poly', pts: poly, name: school ? nm + ' Elementary School' : nm + ' Park', school });
        ++np; break;
      }
    }
  }
  P.ind = { u0: core[0] * P.river.cf + core[1] * P.river.sf - 0.7 * M, u1: core[0] * P.river.cf + core[1] * P.river.sf + 0.5 * M, w: 70 };
  // commercial nodes: arterial x arterial junctions outside the core
  const majors = roads.filter(r => r.cls === 'major' && r.zone !== 'rural');
  for (let a = 0; a < majors.length; ++a) for (let b = a + 1; b < majors.length; ++b) {
    const A = majors[a].pts, B = majors[b].pts;
    for (let i = 0; i + 1 < A.length; ++i) for (let k = 0; k + 1 < B.length; ++k) {
      const h = segIntersect(A[i], A[i + 1], B[k], B[k + 1]);
      if (h && Math.hypot(h[0] - core[0], h[1] - core[1]) > P.dn.Rcore * 1.1 && !P.hubs.some(q => Math.hypot(q[0] - h[0], q[1] - h[1]) < 150)) P.hubs.push(h);
    }
  }
  // farmsteads along the county roads
  const net = { kind: 'city', seed, bounds: { x0: P.cx - P.OX, z0: P.cz - P.OZ, x1: P.cx + P.OX, z1: P.cz + P.OZ }, roads, areas, origins: { star: core, core }, axes: { xD: core[0], zG: core[1] }, plan: P, zoneScale: P.dn.Rcore / 172 };
  for (const r of roads) {
    if (r.zone !== 'rural') continue;
    const P0 = PROFILES[r.profile], L = plen(r.pts);
    for (let s = 50, k = 0; s < L - 40; s += 115, ++k) {
      if (hash2(r.id, k, seed + 51) > 0.55) continue;
      const [x, z, tx, tz] = pointAtPts(r.pts, s), side = hash2(r.id, k, seed + 53) < 0.5 ? 1 : -1;
      const nx = -tz * side, nz = tx * side, off = P0.half + P0.sidewalk + 26, c = [x + nx * off, z + nz * off];
      if (!tcIsRural(net, c[0], c[1]) || tcWater(P, c[0], c[1], 40) || tcDens(P, c[0], c[1]) > 0.3 || tcElev(P, c[0], c[1]) > 0.4) continue;
      if (P.farms.some(f => Math.hypot(f.c[0] - c[0], f.c[1] - c[1]) < 130)) continue;
      let ok = true; for (const o of roads) if (o !== r && distToPolyline(c, o.pts) < 40) { ok = false; break; }
      if (!ok || forestNoise(seed, c[0], c[1]) > 0.5) continue;
      P.farms.push({ c, n: [-nx, -nz], hw: 22, hd: 18, road: r.id, seed: (hash2(r.id, k, seed + 57) * 4294967296) >>> 0 });
    }
  }
  return net;
}
// ------------------------------------------------------------------------------------------------ outskirts (scale > 1)
// The city grows in rings around the inner city, measured by the ring distance D: the signed distance to the Beltway,
// a rounded rectangle on the inner map edge where the grid streets end (wobbled per angle for the outer rings):
//   D < 0         inner city: downtown grid, old town, east quarter (the original generators on a larger box)
//   0 .. d1(th)   suburbs: a crescent per sector dipping from the collector ring, connector streets from the Beltway
//                 (continuing grid streets where one ends nearby); commercial corners where radials cross the rings
//   d1 .. d2(th)  exurbs: cul-de-sacs off the collector, houses on the county line road, leftover land as groves
//   > d2(th)      rural: county roads, fields (crop rows), pasture, woods (noise), farmsteads, a lake
// Radials: Grand / Division / Broadway run on out (a highway profile past the county line); new radials fill the
// gaps between them. Every ring is split into arcs between consecutive radials (no closed loops, clean junctions).
// Everything rural is a pure function of (seed, x, z) or of small lists in net.plan: tile builds can evaluate it
// anywhere in any order (landUseAt / ruralGround / ruralParcel).
const GEOM = new WeakMap();
// The Beltway is a rounded rectangle pulled inward by a smooth angular noise (0 .. wA m), so the inner grid is clipped
// along an irregular line; the suburb / exurb boundaries wobble independently (terrain-like sums of harmonics).
function ringGeom(plan) {
  let G = GEOM.get(plan);
  if (G) return G;
  const { HX, HZ, RC } = plan, wA = plan.wA || 0, ph1 = plan.ph1, ph2 = plan.ph2, ph3 = plan.ph3 || 0;
  const wv = (th) => wA * (0.5 + 0.5 * (0.45 * Math.sin(2 * th + ph1) + 0.33 * Math.sin(3 * th + ph2) + 0.22 * Math.sin(5 * th + ph3)));
  const D = (x, z) => { const qx = Math.abs(x) - (HX - RC), qz = Math.abs(z) - (HZ - RC); return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - RC + (wA ? wv(Math.atan2(z, x)) : 0); };
  const P = (th, d) => { const c = Math.cos(th), s = Math.sin(th); let lo = 0, hi = 8000; for (let i = 0; i < 44; ++i) { const m = (lo + hi) / 2; if (D(c * m, s * m) < d) lo = m; else hi = m; } return [c * lo, s * lo]; };
  // room(th): ring distance of the map edge on the ray at th; the suburbs take at most 50 % of it, the exurbs end by
  // 78 % (the rest stays rural even on the narrow sides)
  const room = (th) => { const c = Math.cos(th), s = Math.sin(th), t = Math.min(plan.OX / Math.max(1e-6, Math.abs(c)), plan.OZ / Math.max(1e-6, Math.abs(s))); return D(c * t, s * t); };
  const d1 = wA ? (th) => Math.min(plan.d1 + 20 * Math.sin(2 * th + ph2) + 11 * Math.sin(5 * th + ph1) + 5 * Math.sin(9 * th + ph3), 0.5 * room(th))
    : (th) => plan.d1 + 9 * Math.sin(3 * th + plan.ph1) + 5 * Math.sin(7 * th + plan.ph2);
  const d2 = wA ? (th) => Math.max(d1(th) + 50, Math.min(d1(th) + plan.dx + 16 * Math.sin(3 * th + ph3) + 9 * Math.sin(7 * th + ph2), 0.78 * room(th)))
    : (th) => plan.d2 + 12 * Math.sin(2 * th + plan.ph2) + 6 * Math.sin(5 * th + plan.ph1);
  G = { D, P, d1, d2, lvl: [() => 0, d1, d2, (th) => d2(th) + plan.d3] };
  GEOM.set(plan, G);
  return G;
}
const plen = (pts) => { let l = 0; for (let i = 0; i + 1 < pts.length; ++i) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return l; };
function growOutskirts(net, g) {
  const { KS, KC, add } = g, seed = net.seed, roads = net.roads;
  const R = mulberry32(seed * 104729 + 4243);
  const b = net.bounds;
  const OX = 330 * KS, OZ = 275 * KS;
  const plan = net.plan = { kind: 'rings', scale: KS * KS, KC, HX: b.x1 + 12, HZ: b.z1 + 12, RC: 140, wA: 200, d1: 105, dx: 80, d3: 95,
    ph1: R() * 6.283, ph2: R() * 6.283, ph3: R() * 6.283, OX, OZ, seed, radials: [], hubs: [], lakes: [], farms: [], pods: [] };
  net.zoneScale = KC;
  const G = ringGeom(plan), { D, P } = G;
  net.inner = { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 };
  net.bounds = { x0: -OX, z0: -OZ, x1: OX, z1: OZ };
  const ang = (p) => Math.atan2(p[1], p[0]);
  const lvlF = (k) => (p) => D(p[0], p[1]) - G.lvl[k](ang(p));
  const cross = (a, q, f) => {                       // point on segment a-q where f changes sign
    const fa = f(a) > 0; let lo = 0, hi = 1;
    for (let i = 0; i < 40; ++i) { const m = (lo + hi) / 2; if ((f([a[0] + (q[0] - a[0]) * m, a[1] + (q[1] - a[1]) * m]) > 0) === fa) lo = m; else hi = m; }
    return [a[0] + (q[0] - a[0]) * lo, a[1] + (q[1] - a[1]) * lo];
  };
  const along = (S, dir, f, max) => { let lo = 0, hi = max || 4000; for (let i = 0; i < 44; ++i) { const m = (lo + hi) / 2; if (f([S[0] + dir[0] * m, S[1] + dir[1] * m]) < 0) lo = m; else hi = m; } return [S[0] + dir[0] * lo, S[1] + dir[1] * lo]; };
  const nrm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const outN = (p) => nrm([D(p[0] + 0.5, p[1]) - D(p[0] - 0.5, p[1]), D(p[0], p[1] + 0.5) - D(p[0], p[1] - 0.5)]);

  // 1. inner roads end on the Beltway (D <= 0); the three arterials reaching it become exits
  const f0 = lvlF(0), drop = new Set(), exits = [];
  for (const r of roads) {
    const runs = []; let cur = null, pts = r.pts;
    if (plan.wA) {                                     // the Beltway cuts inside the inner box: sample segments that cross it
      const dp = [pts[0]];
      for (let i = 0; i + 1 < pts.length; ++i) {
        const a = pts[i], q = pts[i + 1], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
        if (f0(a) > 0.3 || f0(q) > 0.3) for (let k = 1, n = Math.floor(l / 6); k < n; ++k) dp.push([a[0] + (q[0] - a[0]) * k / n, a[1] + (q[1] - a[1]) * k / n]);
        dp.push(q);
      }
      pts = dp;
    }
    for (let i = 0; i < pts.length; ++i) {
      const inside = f0(pts[i]) <= 0.3;
      if (inside) { if (!cur) { cur = []; if (i > 0) cur.push(cross(pts[i - 1], pts[i], f0)); } cur.push(pts[i]); }
      else if (cur) { cur.push(cross(pts[i - 1], pts[i], f0)); runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    let best = null, bl = 0;
    for (const q of runs) { const l = plen(q); if (l > bl) { bl = l; best = q; } }
    if (!best || bl < 20) { drop.add(r.id); continue; }
    if (best.length !== pts.length || best[best.length - 1] !== pts[pts.length - 1]) { if (best[best.length - 1] !== pts[pts.length - 1]) delete r.bulbEnd; }
    r.pts = plan.wA ? collinear(dedupe(best)) : dedupe(best);
  }
  const ends = [];                                    // inner street ends on the Beltway: [point, outward tangent]
  for (const r of roads) {
    if (drop.has(r.id) || r.profile === 'alley' || r.bulbEnd) continue;
    const n = r.pts.length;
    for (const [p, q] of [[r.pts[0], r.pts[1]], [r.pts[n - 1], r.pts[n - 2]]]) {
      if (D(p[0], p[1]) < -1.5) continue;
      if (r.district === 'arterial') exits.push({ S: p, dir: nrm([p[0] - q[0], p[1] - q[1]]), name: r.name, main: true });
      else ends.push({ p, dir: nrm([p[0] - q[0], p[1] - q[1]]) });
    }
  }
  // Broadway may end inside the larger box: run it straight on to the Beltway
  for (const r of roads) {
    if (r.district !== 'arterial' || drop.has(r.id)) continue;
    const n = r.pts.length;
    for (const atEnd of [true, false]) {
      const p = atEnd ? r.pts[n - 1] : r.pts[0], q = atEnd ? r.pts[n - 2] : r.pts[1];
      if (D(p[0], p[1]) >= -1.5) continue;
      const dir = nrm([p[0] - q[0], p[1] - q[1]]), S = along(p, dir, f0);
      if (atEnd) r.pts.push(S); else r.pts.unshift(S);
      exits.push({ S, dir, name: r.name, main: true });
    }
  }
  // 2. new radials in the angular gaps, continuing a grid street when one ends near the spot
  exits.forEach(e => { e.th = ang(e.S); });
  exits.sort((a, b) => a.th - b.th);
  const RAD_NAMES = ['Lincoln', 'Jefferson', 'Washington', 'Franklin', 'Madison', 'Monroe', 'Jackson', 'Hamilton', 'Adams', 'Clay', 'Harrison', 'Polk', 'Tyler', 'Grant'];
  const added = [];
  for (let i = 0; i < exits.length; ++i) {
    const a = exits[i].th, bq = i + 1 < exits.length ? exits[i + 1].th : exits[0].th + 2 * Math.PI, gap = bq - a;
    const n = Math.max(0, Math.round(gap / 0.5) - 1);
    for (let k = 1; k <= n; ++k) {
      const th = a + gap * k / (n + 1) + (R() - 0.5) * 0.06, p = P(th, 0);
      let best = null, bd = 38;
      for (const e of ends) { const d = Math.hypot(e.p[0] - p[0], e.p[1] - p[1]); if (d < bd) { bd = d; best = e; } }
      const nn = outN(best ? best.p : p);
      const S = best ? best.p : p, dir = best && best.dir[0] * nn[0] + best.dir[1] * nn[1] > 0.6 ? best.dir : nn;
      if (best) ends.splice(ends.indexOf(best), 1);
      added.push({ S, dir, name: RAD_NAMES[added.length % RAD_NAMES.length] + ' Avenue', main: false, th: ang(S) });
    }
  }
  const rads = exits.concat(added).sort((a, b) => a.th - b.th);
  const OB = [[1, 0, OX + 12], [-1, 0, OX + 12], [0, 1, OZ + 12], [0, -1, OZ + 12]];
  const levelF = (fn) => (p) => D(p[0], p[1]) - fn(ang(p));
  const crossPoly = (pts, f) => { for (let i = 0; i + 1 < pts.length; ++i) if (f(pts[i]) <= 0 && f(pts[i + 1]) > 0) return { p: cross(pts[i], pts[i + 1], f), i }; return null; };
  // radials bend between the Beltway and the county line (a smooth bow, tangent to the straight line at both ends),
  // then run straight on to the map edge: the Routes leave the map as long straight divided highways
  for (const rd of rads) {
    const t = clipLine(rd.S, rd.dir, OB), L = t[1];
    rd.E = [rd.S[0] + rd.dir[0] * L, rd.S[1] + rd.dir[1] * L];
    const T = Math.min(L - 30, L * 0.7);
    const hx = Math.round(rd.S[0] * 4), hz = Math.round(rd.S[1] * 4);
    const bow = (hash2(hx, hz, seed + 61) - 0.5) * 2 * 48, bow2 = (hash2(hx, hz, seed + 63) - 0.5) * 2 * 20;
    const pr = [-rd.dir[1], rd.dir[0]], pts = [], n = Math.max(2, Math.ceil(T / 6));
    for (let k = 0; k <= n; ++k) {
      const s = T * k / n, u = s / T, sn = Math.sin(Math.PI * u), o = sn * sn * (bow + bow2 * Math.cos(Math.PI * u));
      pts.push([rd.S[0] + rd.dir[0] * s + pr[0] * o, rd.S[1] + rd.dir[1] * s + pr[1] * o]);
    }
    pts.push(rd.E);
    rd.pts = dedupe(pts);
    rd.L = plen(rd.pts);
    plan.radials.push({ name: rd.name, S: rd.S, E: rd.E, dir: rd.dir });
  }
  // 3. corridors: the city grows out along the radials as fingers of neighbourhoods; fields and woods reach in
  //    between them. Each radial gets an urban length (noise), each side a depth profile limited by the room to
  //    the neighbouring radials; the neighbourhood type follows the era (distance out): pre-war comb grids, post-war
  //    loops, newer cul-de-sac pods, then exurban courts on large lots. A partial bypass bends round one side.
  const NB = ['Meadow', 'Fox Run', 'Briar', 'Cedar Hill', 'Orchard', 'Brookside', 'Heather', 'Quail', 'Aspen', 'Stonegate', 'Sunset', 'Clover', 'Deer Path', 'Hollow', 'Ivy', 'Kingsley', 'Willow Bend', 'Maple Glen', 'Prairie', 'Sutton', 'Ashford', 'Linden', 'Wexford', 'Bramble'];
  let nk = 0; const nm = () => NB[nk++ % NB.length];
  const others = (rd) => rads.filter(o => o !== rd);
  const pod = (q, zone) => plan.pods.push({ q, zone });
  const OUT = (p, m) => Math.abs(p[0]) > OX - m || Math.abs(p[1]) > OZ - m;
  // room for a street from spine point p along normal n: stop near the inner city, the map edge or halfway to
  // another radial
  const reach = (rd, p, n, want) => {
    const os = others(rd);
    let u = 0;
    for (; u < want; u += 5) {
      const q = [p[0] + n[0] * u, p[1] + n[1] * u];
      if (u > 8 && (D(q[0], q[1]) < 14 || OUT(q, 30))) break;
      let dmin = 1e9; for (const o of os) dmin = Math.min(dmin, distToPolyline(q, o.pts));
      if (dmin < u + 28) break;
    }
    return u - 12;
  };
  let cr = 1;
  rads.forEach((rd, ri) => {
    const h = (k, s) => hash2(ri * 131 + k, s, seed + 83);
    const Lurb = Math.min(rd.L - 90, 360 + 480 * h(1, 0)), era = (s) => s + 160 * (h(2, Math.floor(s / 150)) - 0.5) + (h(3, 0) - 0.5) * 200;
    let lastS = 40;
    for (const side of [1, -1]) {
      let s = 45 + 30 * h(4, side), prevEnd = null, prevMid = null, kind = null;
      const mid = [], back = [];
      const flush = () => {
        if (back.length > 1) add('residential', dedupe(back.slice()), nm() + ' Street', 'residential', { zone: 'suburban' });
        if (mid.length > 1) add('residential', dedupe(mid.slice()), nm() + ' Avenue', 'residential', { zone: 'suburban' });
        back.length = 0; mid.length = 0;
      };
      while (s < Lurb) {
        const e = era(s), [x, z, tx, tz] = pointAtPts(rd.pts, s), n = [-tz * side, tx * side], p = [x, z];
        const wob = 0.65 + 0.7 * h(5 + side, Math.floor(s / 90));        // ragged depth
        const k = e < 260 ? 'grid' : e < 500 ? 'loop' : 'cul';
        if (k !== kind) { flush(); kind = k; }
        if (k === 'grid') {
          const d = reach(rd, p, n, 175 * wob);
          if (d < 50) { flush(); s += 60; continue; }
          const sp = 72 + 22 * h(6, Math.floor(s));
          const spk = []; for (let j = 0; j <= 4; ++j) spk.push([p[0] + n[0] * d * j / 4, p[1] + n[1] * d * j / 4]);
          add('residential', spk, nm() + ' Street', 'residential', { zone: 'suburban' });
          back.push(spk[4]);
          if (d > 92) mid.push(spk[2]); else if (mid.length) { const m = mid.slice(); mid.length = 0; if (m.length > 1) add('residential', dedupe(m), nm() + ' Avenue', 'residential', { zone: 'suburban' }); }
          const [x2, z2, tx2, tz2] = pointAtPts(rd.pts, Math.min(rd.L, s + sp));
          pod([p, [x2, z2], [x2 - tz2 * side * (d + 18), z2 + tx2 * side * (d + 18)], [p[0] + n[0] * (d + 18), p[1] + n[1] * (d + 18)]], 'suburban');
          lastS = Math.max(lastS, s + sp); s += sp;
        } else if (k === 'loop') {
          const Ll = 100 + 40 * h(7, Math.floor(s)), dd = reach(rd, p, n, 120 * wob);
          const [x2, z2, tx2, tz2] = pointAtPts(rd.pts, s + Ll), n2 = [-tz2 * side, tx2 * side];
          const d = Math.min(dd, reach(rd, [x2, z2], n2, 120 * wob));
          if (d < 55 || s + Ll > Lurb) { s += 50; continue; }
          const pts = [], m = Math.ceil(Ll / 3) + 16;
          for (let j = 0; j <= m; ++j) {
            const u = j / m, [xa, za, ta, tb] = pointAtPts(rd.pts, s + Ll * u), dep = d * Math.pow(Math.sin(Math.PI * u), 0.5);
            pts.push([xa - tb * side * dep, za + ta * side * dep]);
          }
          add('residential', dedupe(pts), nm() + (h(8, Math.floor(s)) < 0.5 ? ' Loop' : ' Circle'), 'residential', { zone: 'suburban' });
          pod([p, [x2, z2], [x2 + n2[0] * (d + 18), z2 + n2[1] * (d + 18)], [p[0] + n[0] * (d + 18), p[1] + n[1] * (d + 18)]], 'suburban');
          // a court into the loop's back land when there is room
          if (d > 95) {
            const [xc, zc, tcx, tcz] = pointAtPts(rd.pts, s + Ll / 2), nc = [-tcz * side, tcx * side], c0 = [xc + nc[0] * d, zc + nc[1] * d];
            const L2 = Math.min(45, reach(rd, c0, nc, 60));
            if (L2 > 26) { add('lane', [c0, [c0[0] + nc[0] * L2, c0[1] + nc[1] * L2]], nm() + ' Court', 'residential', { zone: 'suburban', bulbEnd: 10.5 });
              pod([[c0[0] - tcx * 30, c0[1] - tcz * 30], [c0[0] + tcx * 30, c0[1] + tcz * 30], [c0[0] + tcx * 30 + nc[0] * (L2 + 25), c0[1] + tcz * 30 + nc[1] * (L2 + 25)], [c0[0] - tcx * 30 + nc[0] * (L2 + 25), c0[1] - tcz * 30 + nc[1] * (L2 + 25)]], 'suburban'); }
          }
          lastS = Math.max(lastS, s + Ll); s += Ll + 42;
        } else {
          const d = Math.min(85, reach(rd, p, n, 95 * wob));
          if (d < 34) { s += 45; continue; }
          const bend = (h(9, Math.floor(s)) - 0.5) * 24, q1 = [p[0] + n[0] * d * 0.5, p[1] + n[1] * d * 0.5], q2 = [p[0] + n[0] * d + tx * bend, p[1] + n[1] * d + tz * bend];
          add('lane', bezier(p, q1, q1, q2, 3), nm() + ' Court', 'residential', { zone: 'suburban', bulbEnd: 10.5 });
          pod([[p[0] - tx * 38, p[1] - tz * 38], [p[0] + tx * 38, p[1] + tz * 38], [p[0] + tx * 38 + n[0] * (d + 28), p[1] + tz * 38 + n[1] * (d + 28)], [p[0] - tx * 38 + n[0] * (d + 28), p[1] - tz * 38 + n[1] * (d + 28)]], 'suburban');
          lastS = Math.max(lastS, s + 38); s += 76 + 14 * h(10, Math.floor(s));
        }
      }
      flush();
      // exurbs: a few courts with large lots beyond the urban end, alternating sides
      for (let s2 = Lurb + 60 + 40 * h(11, side), k2 = 0; s2 < Math.min(rd.L - 80, Lurb + 340); s2 += 120 + 60 * h(12, k2++)) {
        if (h(13, k2 * 2 + side) < 0.35) continue;
        const [x, z, tx, tz] = pointAtPts(rd.pts, s2), n = [-tz * side, tx * side], p = [x, z], d = Math.min(70, reach(rd, p, n, 80));
        if (d < 40) continue;
        const q1 = [p[0] + n[0] * d * 0.5, p[1] + n[1] * d * 0.5], q2 = [p[0] + n[0] * d + tx * 14 * side, p[1] + n[1] * d + tz * 14 * side];
        add('lane', bezier(p, q1, q1, q2, 3), nm() + ' Court', 'residential', { zone: 'exurban', bulbEnd: 10.5 });
        pod([[p[0] - tx * 55, p[1] - tz * 55], [p[0] + tx * 55, p[1] + tz * 55], [p[0] + tx * 55 + n[0] * (d + 40), p[1] + tz * 55 + n[1] * (d + 40)], [p[0] - tx * 55 + n[0] * (d + 40), p[1] - tz * 55 + n[1] * (d + 40)]], 'exurban');
        lastS = Math.max(lastS, s2 + 55);
      }
    }
    // the radial: an avenue through its urban length, then a Route (divided boulevard) or county road to the edge
    const cut = Math.min(rd.L - 30, Math.max(lastS + 10, 80)), [cx, cz] = pointAtPts(rd.pts, cut), C = [cx, cz];
    const innerP = [], outerP = [C]; let acc = 0;
    for (let i = 0; i < rd.pts.length; ++i) {
      if (i > 0) acc += Math.hypot(rd.pts[i][0] - rd.pts[i - 1][0], rd.pts[i][1] - rd.pts[i - 1][1]);
      if (acc < cut) innerP.push(rd.pts[i]); else outerP.push(rd.pts[i]);
    }
    innerP.push(C);
    add('avenue', dedupe(innerP), rd.name, 'residential', { zone: 'suburban' });
    add(rd.main ? 'boulevard' : 'county', dedupe(outerP), rd.main ? `${rd.name} (Route ${9 + cr++ * 3})` : `County Road ${cr++ * 2 + 10}`, 'residential', { zone: 'rural' });
    plan.hubs.push(rd.S);
    const sh = 120 + 200 * h(14, 0); if (sh < cut - 40) { const q = pointAtPts(rd.pts, sh); plan.hubs.push([q[0], q[1]]); }
  });
  // partial bypass: the Beltway on one side only (three or four sectors), bending with the inner edge
  {
    const i0 = Math.floor(hash2(rads.length, 1, seed + 87) * rads.length), nS = 3 + (hash2(rads.length, 2, seed + 87) < 0.5 ? 1 : 0);
    for (let k = 0; k < nS; ++k) {
      const A = rads[(i0 + k) % rads.length], B = rads[(i0 + k + 1) % rads.length];
      let ta = ang(A.S), tb = ang(B.S); while (tb <= ta) tb += 2 * Math.PI;
      const n = Math.max(2, Math.ceil((tb - ta) * Math.hypot(A.S[0], A.S[1]) / 3)), pts = [A.S];
      for (let j = 1; j < n; ++j) pts.push(P(ta + (tb - ta) * j / n, 0));
      pts.push(B.S);
      add('boulevard', dedupe(pts), 'Beltway', 'arterial', { zone: 'transition' });
    }
  }
  // 5. remove dropped inner roads, renumber (areas keep their road)
  if (drop.size) {
    const map = new Map(); const keep = roads.filter(r => !drop.has(r.id));
    keep.forEach((r, i) => { map.set(r.id, i); r.id = i; });
    roads.length = 0; roads.push(...keep);
    net.areas = net.areas.filter(a => a.shape !== 'side' || map.has(a.road));
    for (const a of net.areas) if (a.shape === 'side') a.road = map.get(a.road);
  }
  // 6. rural plan: a lake, farmsteads along the rural roads (small lists, evaluated anywhere)
  const distRoads = (p, skip) => { let d = 1e9; for (const r of roads) if (r.id !== skip) d = Math.min(d, distToPolyline(p, r.pts) - PROFILES[r.profile].half); return d; };
  const rural = (p, m) => D(p[0], p[1]) > m && Math.abs(p[0]) < OX - m && Math.abs(p[1]) < OZ - m && [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([a, c]) => !podAt(plan, p[0] + a, p[1] + c));
  for (let t = 0; t < 60 && plan.lakes.length < Math.max(1, Math.round(KS * KS / 4)); ++t) {
    const r = 34 + R() * 26, c = [(R() * 2 - 1) * (OX - 60), (R() * 2 - 1) * (OZ - 60)];
    if (!rural(c, r + 14) || distRoads(c) < r + 16 || plan.lakes.some(l => Math.hypot(l.c[0] - c[0], l.c[1] - c[1]) < l.r + r + 150)) continue;
    plan.lakes.push({ c, r, ph: R() * 6.283 });
  }
  for (const r of roads) {
    if (r.zone !== 'rural' && r.zone !== 'exurban' || r.bulbEnd) continue;
    const P0 = PROFILES[r.profile], L = plen(r.pts);
    for (let s = 50, k = 0; s < L - 40; s += 115, ++k) {
      if (hash2(r.id, k, seed + 51) > 0.6) continue;
      const [x, z, tx, tz] = pointAtPts(r.pts, s), side = r.zone === 'exurban' ? (rural([x - tz * 40, z + tx * 40], 0) ? 1 : -1) : hash2(r.id, k, seed + 53) < 0.5 ? 1 : -1;
      const nx = -tz * side, nz = tx * side, off = P0.half + P0.sidewalk + 26;
      const c = [x + nx * off, z + nz * off];
      if (!rural(c, 24) || distRoads(c, r.id) < 36 || plan.lakes.some(l => Math.hypot(l.c[0] - c[0], l.c[1] - c[1]) < l.r + 40)) continue;
      if (plan.farms.some(f => Math.hypot(f.c[0] - c[0], f.c[1] - c[1]) < 110)) continue;
      if (forestNoise(seed, c[0], c[1]) > 0.5) continue;
      plan.farms.push({ c, n: [-nx, -nz], hw: 22, hd: 18, road: r.id, seed: (hash2(r.id, k, seed + 57) * 4294967296) >>> 0 });
    }
  }
}
function collinear(pts) {                           // drop interior points on a straight run
  const out = [pts[0]];
  for (let i = 1; i + 1 < pts.length; ++i) {
    const a = out[out.length - 1], p = pts[i], q = pts[i + 1];
    if (Math.abs((p[0] - a[0]) * (q[1] - a[1]) - (p[1] - a[1]) * (q[0] - a[0])) > 0.02 * Math.hypot(q[0] - a[0], q[1] - a[1])) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function pointAtPts(pts, s) {
  for (let i = 0; i + 1 < pts.length; ++i) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (s <= l || i + 2 === pts.length) { const t = l ? Math.min(1, s / l) : 0, tx = (pts[i + 1][0] - pts[i][0]) / (l || 1), tz = (pts[i + 1][1] - pts[i][1]) / (l || 1); return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, tx, tz]; }
    s -= l;
  }
  return [pts[0][0], pts[0][1], 1, 0];
}
// value noise in [0,1): forests are where it is high (more of them farther out)
function vnoise(seed, x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function forestNoise(seed, x, z) { return 0.62 * vnoise(seed + 301, x / 230, z / 230) + 0.38 * vnoise(seed + 307, x / 70, z / 70); }
// rural parcels: columns of jittered width, each cut into fields of jittered length (axis-aligned, like section lines)
function ruralParcel(net, x, z) {
  const sd = net.seed, W = 130;
  const xb = (i) => i * W + (hash2(i, 0, sd + 11) - 0.5) * 56;
  let i = Math.floor(x / W); if (x < xb(i)) --i; else if (x >= xb(i + 1)) ++i;
  const H = 85 + 70 * hash2(i, 999, sd + 17), zb = (j) => j * H + (hash2(i, j, sd + 13) - 0.5) * 40;
  let j = Math.floor(z / H); if (z < zb(j)) --j; else if (z >= zb(j + 1)) ++j;
  const x0 = xb(i), x1 = xb(i + 1), z0 = zb(j), z1 = zb(j + 1);
  const h = hash2(i * 7 + 3, j, sd + 19);
  const kind = h < 0.08 ? 'woodlot' : h < 0.34 ? 'corn' : h < 0.52 ? 'wheat' : h < 0.64 ? 'ploughed' : h < 0.74 ? 'soy' : 'pasture';
  return { i, j, x0, x1, z0, z1, kind, alongX: x1 - x0 > z1 - z0, edge: Math.min(x - x0, x1 - x, z - z0, z1 - z), hedge: hash2(i, j, sd + 29) };
}
const GROUND = { CROP: 202, FURROW: 203, WHEAT: 204, FOREST: 205, WATER: 206, GRAVEL: 207, SOIL: 140, SOY: 133, PASTURE: 14, VERGE: 16, ROCK: 216, ROCK_DARK: 221 };
// neighbourhood pods (net.plan.pods: convex quads + zone), indexed on a 64 m grid (lazily, per plan)
const PODIX = new WeakMap();
function podAt(pl, x, z) {
  let ix = PODIX.get(pl);
  if (!ix) {
    ix = new Map();
    for (const p of pl.pods) {
      const xs = p.q.map(q => q[0]), zs = p.q.map(q => q[1]);
      for (let i = Math.floor(Math.min(...xs) / 64); i <= Math.floor(Math.max(...xs) / 64); ++i)
        for (let j = Math.floor(Math.min(...zs) / 64); j <= Math.floor(Math.max(...zs) / 64); ++j) { const k = i * 4096 + j; let a = ix.get(k); if (!a) ix.set(k, a = []); a.push(p); }
    }
    PODIX.set(pl, ix);
  }
  const a = ix.get(Math.floor(x / 64) * 4096 + Math.floor(z / 64));
  if (!a) return null;
  let best = null;
  for (const p of a) {
    const q = p.q; let sg = 0, ok = true;
    for (let i = 0; i < 4 && ok; ++i) { const A = q[i], B = q[(i + 1) % 4], c = (B[0] - A[0]) * (z - A[1]) - (B[1] - A[1]) * (x - A[0]); if (c !== 0) { if (!sg) sg = Math.sign(c); else if (Math.sign(c) !== sg) ok = false; } }
    if (ok) { if (p.zone === 'suburban') return p; best = p; }
  }
  return best;
}
function isRural(net, x, z) {
  const pl = net.plan; if (!pl) return false;
  if (pl.kind === 'tensor') return tcIsRural(net, x, z);
  if (!pl.pods) { const G = ringGeom(pl); return G.D(x, z) > G.d2(Math.atan2(z, x)); }
  return ringGeom(pl).D(x, z) > 4 && !podAt(pl, x, z);
}
function inFarm(f, x, z, m) { const dx = x - f.c[0], dz = z - f.c[1], a = dx * f.n[1] - dz * f.n[0], b = dx * f.n[0] + dz * f.n[1]; return Math.abs(a) < f.hw + m && Math.abs(b) < f.hd + m; }
function lakeR(l, x, z) { const th = Math.atan2(z - l.c[1], x - l.c[0]); return l.r * (1 + 0.12 * Math.sin(3 * th + l.ph) + 0.07 * Math.sin(5 * th + 2 * l.ph)); }
// rural ground at (x, z): { kind, mat } or null when (x, z) is not rural; verge = distance from the sidewalk edge (m)
function ruralGround(net, x, z, verge) {
  if (!isRural(net, x, z)) return null;
  if (net.plan.kind === 'tensor') return tcGround(net, x, z, verge);
  const pl = net.plan;
  for (const l of pl.lakes) { const d = Math.hypot(x - l.c[0], z - l.c[1]), r = lakeR(l, x, z); if (d < r + 4) return { kind: d < r ? 'water' : 'shore', mat: d < r ? GROUND.WATER : GROUND.VERGE }; }
  for (const f of pl.farms) if (inFarm(f, x, z, 0)) return { kind: 'farmyard', mat: GROUND.GRAVEL };
  if (verge < 5) return { kind: 'verge', mat: GROUND.VERGE };
  const fn = forestNoise(net.seed, x, z), G = ringGeom(pl), t = clamp(pl.pods ? G.D(x, z) / 500 : (G.D(x, z) - G.d2(Math.atan2(z, x))) / 160, 0, 1);
  const p = ruralParcel(net, x, z);
  if (fn > 0.66 - 0.12 * t || p.kind === 'woodlot') return { kind: 'forest', mat: GROUND.FOREST, p };
  if (p.edge < 1.6) return { kind: 'headland', mat: GROUND.VERGE, p };
  const w = p.alongX ? z - p.z0 : x - p.x0;            // across the rows
  const ph = (per) => ((w % per) + per) % per;
  let mat;
  if (p.kind === 'corn') mat = ph(2.4) < 1.6 ? GROUND.CROP : GROUND.FURROW;
  else if (p.kind === 'soy') mat = ph(2.0) < 1.3 ? GROUND.SOY : GROUND.FURROW;
  else if (p.kind === 'wheat') mat = ph(12) < 0.4 ? GROUND.FURROW : GROUND.WHEAT;
  else if (p.kind === 'ploughed') mat = ph(1.2) < 0.6 ? GROUND.SOIL : GROUND.FURROW;
  else mat = GROUND.PASTURE;
  return { kind: p.kind === 'pasture' ? 'pasture' : 'field', mat, p };
}
// land use at a point (tile-safe): core, downtown, oldtown, transition, suburban, exurban, rural kinds
// (field, pasture, forest, water, farmyard), plus 'park' / 'plaza' / 'lot' from the open-space areas
function landUseAt(net, x, z) {
  const core = net.origins.core, ks = net.zoneScale || 1, dc = Math.hypot(x - core[0], z - core[1]) / ks;
  for (const a of net.areas) {
    if (a.shape === 'circle' && Math.hypot(x - a.c[0], z - a.c[1]) < a.r) return a.kind === 'lot' ? 'lot' : a.kind === 'park' ? 'park' : 'plaza';
    if (a.shape === 'rect' && x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1) return 'park';
    if (a.shape === 'poly' && inPoly(a.pts, x, z)) return a.kind === 'park' ? 'park' : 'plaza';
  }
  const pl = net.plan;
  if (pl && pl.kind === 'tensor') return tcLandUse(net, x, z);
  if (pl) {
    const G = ringGeom(pl), Dv = G.D(x, z), th = Math.atan2(z, x);
    if (pl.pods && Dv > 4) {
      const pd = podAt(pl, x, z);
      if (!pd) { const g = ruralGround(net, x, z, 99); return g.kind === 'field' || g.kind === 'headland' || g.kind === 'verge' ? 'field' : g.kind === 'shore' ? 'water' : g.kind; }
      if (pl.hubs.some(h => Math.hypot(h[0] - x, h[1] - z) < 60)) return 'commercial';
      return Dv < 45 && pd.zone === 'suburban' ? 'transition' : pd.zone;
    }
    if (Dv > G.d2(th)) { const g = ruralGround(net, x, z, 99); return g.kind === 'field' || g.kind === 'headland' || g.kind === 'verge' ? 'field' : g.kind === 'shore' ? 'water' : g.kind; }
    if (Dv > 0) {
      if (pl.hubs.some(h => Math.hypot(h[0] - x, h[1] - z) < 60)) return 'commercial';
      return Dv < 45 ? 'transition' : Dv < G.d1(th) ? 'suburban' : 'exurban';
    }
  }
  if (dc < 172) return 'core';
  const ax = net.axes || { xD: 0, zG: 0 };
  if (x < ax.xD) return 'downtown';
  if (z < ax.zG) return 'oldtown';
  return 'suburban';
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
  const A = r._arc;
  if (A && A.pts === pts && A.n === pts.length) {      // cached arc lengths (FieldSampler.prepare): binary search, same doubles
    const E = A.end, K = A.seg.length;
    let lo = 0, hi = K;
    while (lo < hi) { const m = (lo + hi) >> 1; if (E[m] >= s) hi = m; else lo = m + 1; }
    let k = lo;
    if (k === K) { if (!K || A.seg[K - 1] + 2 !== pts.length) return [pts[0][0], pts[0][1], 1, 0]; k = K - 1; }
    const i = A.seg[k], [ax, az] = pts[i], [bx, bz] = pts[i + 1], l = A.len[k];
    const t = clamp((s - A.acc[k]) / l, 0, 1);
    return [ax + (bx - ax) * t, az + (bz - az) * t, (bx - ax) / l, (bz - az) / l];
  }
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
  // win = [x0, z0, x1, z1] (m, optional): sample only that window of the global grid (same cell origin, same segment
  // buckets, so every sample equals the global one); streaming tile workers keep a few MB instead of whole-map fields
  constructor(net, cell, win) {
    this.net = net;
    this.cell = cell;
    const b = net.bounds;
    this.x0 = this.bX0 = b.x0 - 6; this.z0 = this.bZ0 = b.z0 - 6;
    this.nx = this.gnx = Math.ceil((b.x1 - b.x0 + 12) / cell) + 2;
    this.nz = this.gnz = Math.ceil((b.z1 - b.z0 + 12) / cell) + 2;
    this.oix = 0; this.oiz = 0;                                    // window offset in cells (grid coords from the global origin: bit-identical samples)
    if (win) {
      const ix0 = clamp(Math.floor((win[0] - this.bX0) / cell), 0, this.gnx - 1), ix1 = clamp(Math.ceil((win[2] - this.bX0) / cell), 0, this.gnx - 1);
      const iz0 = clamp(Math.floor((win[1] - this.bZ0) / cell), 0, this.gnz - 1), iz1 = clamp(Math.ceil((win[3] - this.bZ0) / cell), 0, this.gnz - 1);
      this.x0 = this.bX0 + ix0 * cell; this.z0 = this.bZ0 + iz0 * cell; this.nx = ix1 - ix0 + 1; this.nz = iz1 - iz0 + 1; this.win = win;
      this.oix = ix0; this.oiz = iz0;
    }
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
        if (len < 1e-6) { r.zeroSeg = true; continue; }
        this.segs.push({ road: r.id, ax, az, bx, bz, len, tx: (bx - ax) / len, tz: (bz - az) / len, s0: r.len, half: P.half, i });
        r.len += len;
      }
      if (r.bulbEnd) {
        const [ex, ez] = r.pts[r.pts.length - 1];
        this.segs.push({ road: r.id, ax: ex, az: ez, bx: ex, bz: ez, len: 0, tx: 1, tz: 0, s0: r.len, half: r.bulbEnd, bulb: true });
      }
      maxReach = Math.max(maxReach, (r.bulbEnd || P.half) + P.sidewalk + P.radius + 8);
      { // arc-length cache for pointAt (same sums as its loop)
        const seg = [], acc = [], len = [], end = []; let ac = 0;
        for (let i = 0; i + 1 < r.pts.length; ++i) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], l = Math.hypot(bx - ax, bz - az); if (l < 1e-6) continue; seg.push(i); acc.push(ac); len.push(l); end.push(ac + l); ac += l; }
        r._arc = { pts: r.pts, n: r.pts.length, seg, acc, len, end };
      }
    }
    // segment buckets
    const B = 16;
    this.B = B;
    this.bx = Math.ceil(this.gnx * this.cell / B) + 1;
    this.bz = Math.ceil(this.gnz * this.cell / B) + 1;
    this.buckets = Array.from({ length: this.bx * this.bz }, () => []);
    this.segs.forEach((sg, i) => {
      const reach = sg.half + PROFILES[roads[sg.road].profile].sidewalk + 12 + 34;   // + plot depth for road2/s2
      const x0 = Math.floor((Math.min(sg.ax, sg.bx) - reach - this.bX0) / B), x1 = Math.floor((Math.max(sg.ax, sg.bx) + reach - this.bX0) / B);
      const z0 = Math.floor((Math.min(sg.az, sg.bz) - reach - this.bZ0) / B), z1 = Math.floor((Math.max(sg.az, sg.bz) + reach - this.bZ0) / B);
      for (let z = Math.max(0, z0); z <= Math.min(this.bz - 1, z1); ++z)
        for (let x = Math.max(0, x0); x <= Math.min(this.bx - 1, x1); ++x) this.buckets[z * this.bx + x].push(i);
    });
    this.nRoads = roads.length;
    // struct-of-arrays copy of the segments for the hot loop in evalPoint (same doubles, same order)
    const ns = this.segs.length, SG = this.SG = { ax: new Float64Array(ns), az: new Float64Array(ns), tx: new Float64Array(ns), tz: new Float64Array(ns),
      len: new Float64Array(ns), half: new Float64Array(ns), s0: new Float64Array(ns), road: new Int32Array(ns), bulb: new Uint8Array(ns), alley: new Uint8Array(ns) };
    this.segs.forEach((g, i) => { SG.ax[i] = g.ax; SG.az[i] = g.az; SG.tx[i] = g.tx; SG.tz[i] = g.tz; SG.len[i] = g.len; SG.half[i] = g.half; SG.s0[i] = g.s0; SG.road[i] = g.road; SG.bulb[i] = g.bulb ? 1 : 0; SG.alley[i] = roads[g.road].P.id === 'alley' ? 1 : 0; });
    this.bucketsI = this.buckets.map(L => Int32Array.from(L));
  }
  // evaluate one point (full precision)
  evalPoint(px, pz, out, skipAlleys) {
    const roads = this.net.roads;
    const bi = clamp(Math.floor((px - this.bX0) / this.B), 0, this.bx - 1) + clamp(Math.floor((pz - this.bZ0) / this.B), 0, this.bz - 1) * this.bx;
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
    const SG = this.SG, Sax = SG.ax, Saz = SG.az, Stx = SG.tx, Stz = SG.tz, Slen = SG.len, Shalf = SG.half, Sroad = SG.road;
    const listI = this.bucketsI[bi];
    for (let k = 0; k < listI.length; ++k) {
      const g = listI[k];
      if (skipAlleys && SG.alley[g]) continue;
      const ax = Sax[g], az = Saz[g], gtx = Stx[g], gtz = Stz[g], len = Slen[g];
      const t = len > 0 ? ((px - ax) * gtx + (pz - az) * gtz) : 0;
      const tc = t < 0 ? 0 : t > len ? len : t;
      const cx = ax + gtx * tc, cz = az + gtz * tc;
      const ex = px - cx, ez = pz - cz;
      const d = Math.sqrt(ex * ex + ez * ez) - Shalf[g];
      const r = Sroad[g];
      if (dR[r] >= 1e8) touched.push(r);
      if (d < dR[r]) {
        dR[r] = d; sR[r] = SG.s0[g] + tc;
        uR[r] = SG.bulb[g] ? 1e3 : (gtx * (pz - az) - gtz * (px - ax)) * -1;   // + left of +t
        qx[r] = cx; qz[r] = cz; tx[r] = gtx; tz[r] = gtz;
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
  build(onProgress, skipJunctions) {
    if (!skipJunctions) this.computeJunctions();             // windowed tile fields: junctions once per worker
    const o = {};
    for (let z = 0; z < this.nz; ++z) {
      for (let x = 0; x < this.nx; ++x) {
        const i = z * this.nx + x;
        this.evalPoint(this.bX0 + (this.oix + x) * this.cell, this.bZ0 + (this.oiz + z) * this.cell, o);
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
    const ix = clamp(Math.round((px - this.bX0) / this.cell) - this.oix, 0, this.nx - 1), iz = clamp(Math.round((pz - this.bZ0) / this.cell) - this.oiz, 0, this.nz - 1);
    return this.filled[iz * this.nx + ix] === 1;
  }
  blockAt(px, pz) {
    const ix = clamp(Math.round((px - this.bX0) / this.cell) - this.oix, 0, this.nx - 1), iz = clamp(Math.round((pz - this.bZ0) / this.cell) - this.oiz, 0, this.nz - 1);
    return this.comp[iz * this.nx + ix];
  }
  // bilinear sample (u, s exact only when all four corners agree on the nearest road)
  sample(px, pz, o) {
    const gx = (px - this.bX0) / this.cell - this.oix, gz = (pz - this.bZ0) / this.cell - this.oiz;
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
  BUILDING_D: 25, BUILDING_E: 26, BUILDING_F: 27, ROOF_B: 28, DRIVE: 29
};
// muted, slightly washed-out palette (sRGB 0..255); renderer converts to linear
const PALETTE = [
  [118, 116, 118], [111, 110, 114], [124, 121, 120], [98, 97, 101], [206, 202, 190], [204, 170, 92], [196, 192, 182], [184, 180, 170], [170, 166, 157],
  [190, 186, 176], [128, 150, 104], [194, 186, 168], [198, 188, 170], [178, 168, 151], [138, 160, 110], [142, 138, 136], [154, 168, 124], [176, 166, 146], [196, 184, 158],
  [216, 206, 190], [196, 194, 190], [226, 220, 206], [168, 164, 158], [128, 126, 128], [210, 206, 194],
  [206, 184, 168], [186, 196, 202], [214, 198, 168], [156, 160, 164],
  [160, 156, 149]                                      // DRIVE: driveway apron concrete at a curb cut
];
const MAT_NAMES = Object.keys(MAT);
const CUT_FLARE = 0.6;                                 // driveway apron wings beyond each end of a curb cut (m)
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
        const hit = a.shape === 'circle' ? Math.hypot(x - a.c[0], z - a.c[1]) < a.r : a.shape === 'rect' ? (x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1) : a.shape === 'poly' ? inPoly(a.pts, x, z) : false;
        if (hit) { const key = c * 4096 + k; inside.set(key, (inside.get(key) || 0) + 1); }
      });
    }
    this.blockArea = new Map();
    for (const [key, v] of inside) {
      const c = Math.floor(key / 4096), k = key % 4096;
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
        if (!b) st.set(c, b = { n: 0, x0: ix, x1: ix, z0: iz, z1: iz, art: 0, dt: 0, res: 0, ot: 0, maxd: 0 });
        b.n++; b.x0 = Math.min(b.x0, ix); b.x1 = Math.max(b.x1, ix); b.z0 = Math.min(b.z0, iz); b.z1 = Math.max(b.z1, iz);
        const r = this.roads[F.road[i]];
        if (r) { if (r.P.cls === 'arterial') b.art++; if (r.district === 'downtown') b.dt++; if (r.district === 'residential') b.res++; if (r.district === 'oldtown') b.ot++; }
        b.maxd = Math.max(b.maxd, F.car[i] - F.sw[i]);
      }
      this.pocket = 0;
      // suburban blocks (the residential quarter, incl. its edges on the arterials): lawn ground throughout
      this.suburb = new Set();
      for (const [c, b] of st) if (!b.dt && !b.ot && b.res >= b.n * 0.25) this.suburb.add(c);
      for (const [c, b] of st) {
        if (this.blockArea.has(c)) continue;
        const area = b.n * F.cell * F.cell, fill = b.n / ((b.x1 - b.x0 + 1) * (b.z1 - b.z0 + 1));
        const urban = (b.art + b.dt) > b.n * 0.3 && b.res < b.n * 0.3;
        if (urban && (area < 900 || (fill < 0.62 && area < 3500) || (fill < 0.78 && b.maxd < 12.5) || b.maxd < 8)) { this.blockArea.set(c, 'pocket'); this.pocket++; }
      }
    }
  }
  // Streaming: per-cell block classes (blockArea kind, suburb) of the whole map as row runs over the field grid, a
  // few MB at scale 5. A tile worker's windowed fields take them (useBlockClasses) instead of the global block labels.
  blockClasses() {
    if (!this.blockArea) this.blockAreas();
    const F = this.F, table = [], idx = new Map(), comps = new Map();
    const codeOf = (c) => {
      let k = comps.get(c); if (k !== undefined) return k;
      const kind = this.blockArea.get(c) || null, sub = !!(this.suburb && this.suburb.has(c)), key = kind + '|' + sub;
      k = idx.get(key); if (k === undefined) { k = table.length; idx.set(key, k); table.push({ kind, sub }); }
      comps.set(c, k); return k;
    };
    const runs = [], rowAt = new Uint32Array(F.nz + 1);
    for (let iz = 0; iz < F.nz; ++iz) {
      rowAt[iz] = runs.length >> 1; let cur = -2, len = 0;
      for (let ix = 0; ix < F.nx; ++ix) { const c = F.comp[iz * F.nx + ix], k = c < 0 ? 65535 : codeOf(c); if (k === cur) ++len; else { if (len) runs.push(cur, len); cur = k; len = 1; } }
      runs.push(cur, len);
    }
    rowAt[F.nz] = runs.length >> 1;
    return { table, runs: Uint32Array.from(runs), rowAt, pocket: this.pocket || 0 };
  }
  useBlockClasses(BC) {
    const F = this.F, ox = Math.round((F.x0 - F.bX0) / F.cell), oz = Math.round((F.z0 - F.bZ0) / F.cell), RU = BC.runs;
    for (let z = 0; z < F.nz; ++z) {
      let r = BC.rowAt[oz + z], pos = 0;
      const r1 = BC.rowAt[oz + z + 1];
      for (let x = 0; x < F.nx; ++x) {
        const gx = ox + x;
        while (r < r1 - 1 && pos + RU[2 * r + 1] <= gx) { pos += RU[2 * r + 1]; ++r; }
        const i = z * F.nx + x, k = RU[2 * r];
        if (F.comp[i] >= 0) F.comp[i] = k === 65535 ? -1 : k;
      }
    }
    this.blockArea = new Map(); this.suburb = new Set(); this.pocket = BC.pocket;
    BC.table.forEach((t, k) => { if (t.kind) this.blockArea.set(k, t.kind); if (t.sub) this.suburb.add(k); });
  }
  // Streaming pages: block classes per global field cell from the planned pages (get(gix, giz) -> code: 2 * (kind
  // index + 1, 0 none) + suburb; 255 no block; 254 no page there), kinds = CityArch.classKinds(net)
  useClassGrid(get, kinds) {
    const F = this.F;
    for (let z = 0; z < F.nz; ++z) for (let x = 0; x < F.nx; ++x) {
      const i = z * F.nx + x; if (F.comp[i] < 0) continue;
      const k = get(F.oix + x, F.oiz + z);
      F.comp[i] = k === 255 ? -1 : k === 254 ? 0 : k;
    }
    this.blockArea = new Map(); this.suburb = new Set(); this.pocket = 0;
    for (let k = 0; k < 2 * (kinds.length + 1); ++k) { if (k >= 2) this.blockArea.set(k, kinds[(k >> 1) - 1]); if (k & 1) this.suburb.add(k); }
  }
  areaAt(x, z, road, u) {
    if (!this.blockArea) this.blockAreas();
    if (this.net.plan && isRural(this.net, x, z)) return 'rural';
    const c = this.F.blockAt(x, z);
    if (c >= 0 && this.blockArea.has(c)) return this.blockArea.get(c);
    for (const a of this.areas) if (a.shape === 'side' && road === a.road && u * a.side > 0) return a.kind;
    return null;
  }
  // Driveway curb cuts (registered by the building placement, CityArch.buildAll -> res.cuts): each is a segment on
  // the lot line (a -> b, metres), the unit normal n towards the street, the depth from the lot line to the
  // carriageway edge and the road it crosses. Inside a cut the sidewalk becomes driveway concrete: the curb is
  // dropped to the gutter, a half-height step behind it, then the apron at sidewalk height up to the lot line;
  // short flared wings (lowered curb, a concrete triangle) on both sides. Outside the cuts nothing changes.
  setCuts(cuts) {
    this.cuts = cuts && cuts.length ? cuts : null;
    this.cutGrid = new Map();
    if (!this.cuts) return;
    const G = 8;
    this.cuts.forEach((c) => {
      const dx = c.bx - c.ax, dz = c.bz - c.az;
      c.len = Math.hypot(dx, dz); c.ux = dx / c.len; c.uz = dz / c.len;
      const pts = [[c.ax, c.az], [c.bx, c.bz], [c.ax + c.nx * c.depth, c.az + c.nz * c.depth], [c.bx + c.nx * c.depth, c.bz + c.nz * c.depth]];
      const pad = CUT_FLARE + 0.5;
      const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
      for (let gz = Math.floor((Math.min(...zs) - pad) / G); gz <= Math.floor((Math.max(...zs) + pad) / G); ++gz)
        for (let gx = Math.floor((Math.min(...xs) - pad) / G); gx <= Math.floor((Math.max(...xs) + pad) / G); ++gx) {
          const k = gx + ',' + gz; let L = this.cutGrid.get(k); if (!L) this.cutGrid.set(k, L = []); L.push(c);
        }
    });
  }
  // the cut covering (x, z) beside road `road` (outside the carriageway), or null; t / d / over in metres
  cutAt(x, z, road) {
    const L = this.cutGrid.get(Math.floor(x / 8) + ',' + Math.floor(z / 8));
    if (!L) return null;
    for (const c of L) {
      if (c.road !== road) continue;
      const rx = x - c.ax, rz = z - c.az, t = rx * c.ux + rz * c.uz, d = rx * c.nx + rz * c.nz;
      if (d < -0.02 || d > c.depth + 0.4 || t < -CUT_FLARE || t > c.len + CUT_FLARE) continue;
      return { c, t, d, over: t < 0 ? -t : t > c.len ? t - c.len : 0 };
    }
    return null;
  }
  // classify one column -> [height in voxels, material]
  classify(x, z, o, out) {
    const F = this.F, hs = this.hs, v = this.v;
    F.sample(x, z, o);
    if (this.net.plan && this.net.plan.kind === 'tensor') {
      const wc = waterColumn(this.net, x, z, o.road >= 0 && o.car <= 900 && o.car / (o.g || 1) < (o.sw || 0));
      if (wc) { out[0] = Math.round(wc[0] / v); out[1] = wc[1]; return; }
    }
    if (o.road < 0 || o.car > 900) { const rg = this.net.plan && ruralGround(this.net, x, z, 99); out[0] = hs; out[1] = rg ? rg.mat : MAT.PLOT; return; }
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
    if (this.cuts) {
      const k = this.cutAt(x, z, o.road);
      if (k) {
        const curbW = Math.max(0.16, v * 1.6), lo = Math.floor(hs / 2);
        if (k.over === 0) {                                        // the cut: dropped curb, step, apron
          out[1] = MAT.DRIVE;
          out[0] = car < curbW ? 0 : car < curbW + 0.45 ? lo : hs;
          return;
        }
        const f = k.over / CUT_FLARE;                              // wings: lowered curb, concrete triangle
        if (car < curbW) { out[0] = f < 0.55 ? lo : hs; out[1] = f < 0.55 ? MAT.DRIVE : MAT.CURB; return; }
        if (car < curbW + 0.9 * (1 - f) && car < o.sw) { out[0] = hs; out[1] = MAT.DRIVE; return; }
      }
    }
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
    if (area === 'rural') { const rg = ruralGround(this.net, x, z, car - o.sw); out[1] = rg ? rg.mat : MAT.YARD; return; }
    if (area === 'plaza' || area === 'square' || area === 'pocket') { out[1] = plazaTile(x, z, v); return; }
    if (area === 'park') {
      const L = parkAt(this.net, x, z);
      if (L) { const g = parkGround(L, x, z, v); out[1] = g[0]; out[0] = hs + g[1]; } else out[1] = parkSurface(x, z, v);
      return;
    }
    if (area === 'lot') { out[1] = MAT.LOT; return; }
    out[1] = road.district === 'residential' || (this.suburb && this.suburb.has(this.F.blockAt(x, z))) ? MAT.YARD : MAT.PLOT;
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
// ---- city parks: the open blocks of generateCity's 'park' areas (rectangles; schools are parks with school: true)
// get a designed layout per park, deterministic from the area polygon, its index and the city seed (no window state):
// ground (paths, plazas, pond, courts, pitch, mounds) is drawn by the raster below (parkGround: flat, walkable, no
// coplanar overlays), the furniture / trees by towers/cityparkkit.js from the same layout. Themes rotate so that
// neighbouring parks differ: school grounds are 'sports' (pitch, court, playground, bleachers), the other parks
// alternate 'woodland' (pond, meandering paths, groves on low mounds, gazebo, picnic lawn) and 'formal' (round plaza
// with a fountain, cross axes and a ring walk, hedges, parterres, allees, a low wall).
const PG = { LAWN: 14, LAWN_D: 10, LAWN_L: 155, PATH: 18, PLAZA: 12, PLAZA_J: 13, GRAVEL: 207, SOIL: 140, WATER: 206, ROCK: 216,
  COURT: 65, COURT_B: 127, LINE: 64, MEDAL: 141 };
const PARK_GROUND = new Set([14, 10, 155, 18, 12, 13, 207, 140, 206, 216, 65, 127, 64, 141]);
function parkLayouts(net) {
  if (net._parkL) return net._parkL;
  const out = [], seed = net.seed || 1;
  let nPark = 0;
  (net.areas || []).forEach((a, idx) => {
    if (a.kind !== 'park' || a.shape !== 'poly' || !a.pts || a.pts.length !== 4) return;
    const p = a.pts;
    let e1 = [p[0][0] - p[1][0], p[0][1] - p[1][1]], e2 = [p[0][0] - p[3][0], p[0][1] - p[3][1]];
    if (Math.hypot(e1[0], e1[1]) < Math.hypot(e2[0], e2[1])) { const t = e1; e1 = e2; e2 = t; }
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    const c = [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4];
    const L = { idx, name: a.name, c, u: [e1[0] / l1, e1[1] / l1], v: [e2[0] / l2, e2[1] / l2], hu: l1 / 2, hv: l2 / 2,
      theme: a.school ? 'sports' : (nPark++ % 2 === 0 ? 'woodland' : 'formal'), seed: (hash2(idx, 77, seed + 911) * 4294967296) >>> 0,
      segs: [], rings: [], discs: [], rects: [], mounds: [], feats: [] };
    const bb = 30 + Math.hypot(L.hu, L.hv);
    L.bb = [c[0] - bb, c[1] - bb, c[0] + bb, c[1] + bb];
    parkDesign(L);
    out.push(L);
  });
  net._parkL = out;
  return out;
}
function parkDesign(L) {
  const R = mulberry32(L.seed), hu = L.hu, hv = L.hv, m = Math.min(hu, hv), X = 22;
  const seg = (a, b, hw, mat) => L.segs.push({ a, b, hw, mat });
  const curve = (a, k, b, hw, mat, n) => {                         // quadratic Bezier a -> b (control k) as segments
    n = n || 10; let prev = a;
    for (let i = 1; i <= n; ++i) { const t = i / n, w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      const q = [w0 * a[0] + w1 * k[0] + w2 * b[0], w0 * a[1] + w1 * k[1] + w2 * b[1]]; seg(prev, q, hw, mat); prev = q; }
  };
  const fl = R() < 0.5 ? 1 : -1, ft = R() < 0.5 ? 1 : -1;            // mirror the design per park
  if (L.theme === 'formal') {
    const rp = clamp(m * 0.27, 6.5, 11), ring = Math.max(rp + 8, m * 0.72);
    L.discs.push({ c: [0, 0], rx: rp, ry: rp, mat: 'plaza' });
    L.rings.push({ c: [0, 0], rx: ring, ry: ring, hw: 1.1, mat: PG.GRAVEL });
    seg([-hu - X, 0], [hu + X, 0], 1.6, PG.PLAZA); seg([0, -hv - X], [0, hv + X], 1.6, PG.PLAZA);
    for (const sx of [-1, 1]) for (const st of [-1, 1]) {           // diagonals from the corners to the ring
      const d = Math.hypot(hu, hv), dx = hu / d, dz = hv / d;
      seg([sx * dx * ring, st * dz * ring], [sx * (hu + X * dx), st * (hv + X * dz)], 1.0, PG.PATH);
    }
    if (hu > hv * 1.35 && hu - ring > 12) for (const sx of [-1, 1]) L.discs.push({ c: [sx * (ring + (hu - ring) / 2), 0], rx: 4.2, ry: 4.2, mat: 'plaza', rondel: true });
    L.feats.push({ t: 'fountain', c: [0, 0], r: rp });
  } else if (L.theme === 'woodland') {
    const rx = clamp(hu * 0.3, 7.5, 18), ry = clamp(hv * 0.32, 6, 12), pc = [fl * hu * 0.26, -ft * hv * 0.1];
    L.discs.push({ c: pc, rx, ry, mat: 'water', wob: R() * 6.28 });
    const lr = 4.4;
    L.rings.push({ c: pc, rx: rx + lr, ry: ry + lr, hw: 0.9, mat: PG.GRAVEL });
    const w = [pc[0] - fl * (rx + lr), pc[1]], e = [pc[0] + fl * (rx + lr), pc[1]];
    // the long meander: west entrance -> pond loop -> east entrance
    curve([-fl * (hu + X), ft * hv * 0.35], [-fl * hu * 0.35, ft * hv * 0.75], w, 1.0, PG.GRAVEL, 14);
    curve(e, [pc[0] + fl * (rx + lr + 6), -ft * hv * 0.55], [fl * (hu + X), -ft * hv * 0.45], 1.0, PG.GRAVEL, 8);
    // a branch from the far long side down to the meander
    const A0 = [-fl * (hu + X), ft * hv * 0.35], K0 = [-fl * hu * 0.35, ft * hv * 0.75], tj = 0.55;
    const j = [(1 - tj) * (1 - tj) * A0[0] + 2 * tj * (1 - tj) * K0[0] + tj * tj * w[0], (1 - tj) * (1 - tj) * A0[1] + 2 * tj * (1 - tj) * K0[1] + tj * tj * w[1]];
    curve([j[0] + fl * hu * 0.3, ft * (hv + X)], [j[0] + fl * hu * 0.25, j[1] + ft * hv * 0.2], j, 0.9, PG.GRAVEL, 8);
    // gazebo pad on the pond loop, on the open side
    const ga = -ft * Math.PI / 2 + fl * 0.5, gr = 3.4, gc = [pc[0] + Math.cos(ga) * (rx + lr + gr - 0.4), pc[1] + Math.sin(ga) * (ry + lr + gr - 0.4)];
    if (Math.abs(gc[0]) < hu - gr - 1 && Math.abs(gc[1]) < hv - gr - 1) { L.discs.push({ c: gc, rx: gr, ry: gr, mat: 'plaza' }); L.feats.push({ t: 'gazebo', c: gc, r: gr }); }
    L.feats.push({ t: 'pond', c: pc, rx, ry, lr });
    // low mounds under the groves (clear of every path)
    for (const [ms, mt] of [[-fl * hu * 0.62, -ft * hv * 0.5], [fl * hu * 0.7, ft * hv * 0.55], [-fl * hu * 0.1, -ft * hv * 0.62]]) {
      const mr = clamp(m * 0.28, 6, 11), mz = clamp(m * 0.2, 4.5, 8);
      if (Math.abs(ms) + mr > hu - 1 || Math.abs(mt) + mz > hv - 1) continue;
      if (parkPathDist(L, ms, mt) < mr + 2.5) continue;
      const pd = Math.hypot((ms - pc[0]) / (rx + lr + mr + 3), (mt - pc[1]) / (ry + lr + mz + 3)); if (pd < 1) continue;
      L.mounds.push({ c: [ms, mt], rx: mr, ry: mz });
    }
    L.feats.push({ t: 'picnic', c: [-fl * hu * 0.55, ft * hv * 0.05] });
  } else {
    // sports: pitch at one end, a cross walk, the court and the playground beyond it, a walk along the long side
    const a = clamp(hu * 0.42, 13, 32), b = clamp(Math.min(hv - 6, a * 0.64), 8, 21), ps = -fl * (hu - a - 3);
    L.rects.push({ c: [ps, 0], hu: a, hv: b, mat: 'pitch' });
    L.feats.push({ t: 'pitch', c: [ps, 0], hu: a, hv: b });
    const xs = ps + fl * (a + 2.6);
    seg([xs, -hv - X], [xs, hv + X], 1.1, PG.PATH);
    const wt = ft * (hv - 2.2);
    if (hv - b > 4.5) seg([-hu - X, wt], [hu + X, wt], 1.1, PG.PATH);
    // court: full (28 x 15) across or along, else half (15 x 14)
    const room = hu - fl * xs - 2;                                    // metres from the cross walk to the far end
    const cs = [[7.5 + 1.2, 14 + 1.2, 'full', true], [14 + 1.2, 7.5 + 1.2, 'full', false], [7.5 + 1, 7 + 1, 'half', false]];
    for (const [chu, chv, kind, across] of cs) {
      if (2 * chu + 1.5 > room || chv > hv - (hv - b > 4.5 ? 4.6 : 1.5)) continue;
      const cc = [xs + fl * (1.1 + 0.8 + chu), -ft * (hv - (hv - b > 4.5 ? 4.6 : 1.5) - chv) * 0.0];
      L.rects.push({ c: cc, hu: chu, hv: chv, mat: 'court', kind, across, flip: fl });
      L.feats.push({ t: 'court', c: cc, hu: chu, hv: chv, kind, across });
      const left = room - 2 * chu - 1.9;
      if (left >= 10) {
        const pr = Math.min(6.5, left / 2 - 0.6), pcx = cc[0] + fl * (chu + 1.0 + pr);
        L.discs.push({ c: [pcx, -ft * Math.min(hv * 0.3, hv - pr - 2)], rx: pr, ry: pr * 0.85, mat: 'soil' });
        L.feats.push({ t: 'playground', c: [pcx, -ft * Math.min(hv * 0.3, hv - pr - 2)], r: pr });
        seg([pcx, wt], [pcx, -ft * Math.min(hv * 0.3, hv - pr - 2)], 0.9, PG.PATH);
      }
      break;
    }
  }
}
function parkPathDist(L, s, t) {
  let d = 1e9;
  for (const g of L.segs) d = Math.min(d, segDist(s, t, g.a[0], g.a[1], g.b[0], g.b[1]) - g.hw);
  for (const r of L.rings) d = Math.min(d, Math.abs(Math.hypot((s - r.c[0]) / r.rx, (t - r.c[1]) / r.ry) - 1) * Math.sqrt(r.rx * r.ry) - r.hw);
  return d;
}
function parkAt(net, x, z) {
  for (const L of parkLayouts(net)) if (x > L.bb[0] && x < L.bb[2] && z > L.bb[1] && z < L.bb[3]) return L;
  return null;
}
// ground of a city park at (x, z): [material, height offset in voxels]
function parkGround(L, x, z, v) {
  const dx = x - L.c[0], dz = z - L.c[1], s = dx * L.u[0] + dz * L.u[1], t = dx * L.v[0] + dz * L.v[1];
  let hit = null;
  for (const d of L.discs) {
    const q = Math.hypot((s - d.c[0]) / d.rx, (t - d.c[1]) / d.ry);
    if (d.mat === 'water') {
      const an = Math.atan2(t - d.c[1], s - d.c[0]), wob = 1 + 0.07 * Math.sin(an * 3 + d.wob) + 0.04 * Math.sin(an * 5 + d.wob * 2);
      const qq = q / wob, rm = Math.min(d.rx, d.ry);
      if (qq < 1) return [PG.WATER, -1];
      if ((qq - 1) * rm < 0.55) return [PG.ROCK, 0];
      if ((qq - 1) * rm < 1.1) return [PG.GRAVEL, 0];
      continue;
    }
    if (q >= 1) continue;
    const r = Math.hypot(s - d.c[0], t - d.c[1]);
    if (d.mat === 'soil') return [(q > 1 - 0.3 / d.ry) ? 70 : PG.SOIL, 0];
    // plaza: concentric paving rings with joints, a granite medallion in the middle, a granite border
    const rr = d.rx;
    if (rr - r < 0.4) return [PG.MEDAL, 0];
    if (!d.rondel && r < 1.2) return [PG.MEDAL, 0];
    const f = ((r % 1.8) + 1.8) % 1.8;
    if (f < v * 0.999) return [PG.PLAZA_J, 0];
    const an = Math.atan2(t - d.c[1], s - d.c[0]), nseg = Math.max(8, Math.round(r * 2.2)), fa = ((an / (2 * Math.PI) + 1) * nseg) % 1;
    if (fa * 2 * Math.PI * r / nseg < v * 0.999) return [PG.PLAZA_J, 0];
    return [PG.PLAZA, 0];
  }
  for (const g of L.rects) {
    const a = s - g.c[0], b = t - g.c[1];
    if (Math.abs(a) > g.hu || Math.abs(b) > g.hv) continue;
    if (g.mat === 'pitch') hit = parkPitch(g, a, b, v);
    else hit = parkCourt(g, a, b, v);
    if (hit) return hit;
  }
  if (parkPathDist(L, s, t) < 0) {
    for (const g of L.segs) if (segDist(s, t, g.a[0], g.a[1], g.b[0], g.b[1]) < g.hw) return [g.mat, 0];
    for (const r of L.rings) if (Math.abs(Math.hypot((s - r.c[0]) / r.rx, (t - r.c[1]) / r.ry) - 1) * Math.sqrt(r.rx * r.ry) < r.hw) return [r.mat, 0];
  }
  let dh = 0;
  for (const mo of L.mounds) {
    const q = Math.hypot((s - mo.c[0]) / mo.rx, (t - mo.c[1]) / mo.ry);
    if (q < 1) dh = Math.max(dh, q < 0.45 ? 2 : 1);
  }
  // lawn: patches of darker / lighter grass on a 1.6 m voxel grid (low-frequency noise + a cell hash)
  const n = 0.68 * vnoise(L.seed & 0xffff, x / 11, z / 11) + 0.32 * hash2(Math.floor(x / 1.6), Math.floor(z / 1.6), L.seed & 0xffff);
  return [n > 0.66 ? PG.LAWN_D : n < 0.3 ? PG.LAWN_L : PG.LAWN, dh];
}
function parkPitch(g, a, b, v) {
  const w = Math.max(0.12, v * 1.2), A = g.hu - 1.5, B = g.hv - 1.5, on = (d) => Math.abs(d) < w / 2;
  if (Math.abs(a) <= A + w / 2 && Math.abs(b) <= B + w / 2) {
    if (on(Math.abs(a) - A) || on(Math.abs(b) - B) || on(a)) return [PG.LINE, 0];
    const cr = Math.min(9.15, B * 0.42);
    if (on(Math.hypot(a, b) - cr)) return [PG.LINE, 0];
    const pa = Math.min(16.5, A * 0.3), pb = Math.min(20.15, B * 0.6), ga = Math.min(5.5, A * 0.1), gb = Math.min(9.16, B * 0.3);
    for (const [xa, xb] of [[pa, pb], [ga, gb]]) if ((on(Math.abs(a) - (A - xa)) && Math.abs(b) <= xb) || (on(Math.abs(b) - xb) && Math.abs(a) >= A - xa)) return [PG.LINE, 0];
  }
  // mowing stripes
  return [Math.floor((a + g.hu) / 4.6) % 2 ? PG.LAWN : PG.LAWN_L, 0];
}
function parkCourt(g, a, b, v) {
  // court in its own frame: x along its length, y across
  let x = g.across ? b : a, y = g.across ? a : b;
  const hx = (g.across ? g.hv : g.hu) - 1.1, hy = (g.across ? g.hu : g.hv) - 1.1, w = Math.max(0.1, v * 1.1), on = (d) => Math.abs(d) < w / 2;
  const surf = PG.COURT;
  if (Math.abs(x) > hx + w / 2 || Math.abs(y) > hy + w / 2) return [PG.COURT_B, 0];   // apron
  if (on(Math.abs(x) - hx) || on(Math.abs(y) - hy)) return [PG.LINE, 0];
  if (g.kind !== 'half') { if (on(x)) return [PG.LINE, 0]; if (on(Math.hypot(x, y) - 1.8)) return [PG.LINE, 0]; }
  for (const e of (g.kind === 'half' ? [-hx] : [-hx, hx])) {
    const ax = (x - e) * (e < 0 ? 1 : -1);                         // metres in from that baseline
    if (ax < 0 || ax > 9) continue;
    if (ax <= 5.8 && on(Math.abs(y) - 2.45)) return [PG.LINE, 0];
    if (on(ax - 5.8) && Math.abs(y) <= 2.45) return [PG.LINE, 0];
    if (ax > 5.8 && on(Math.hypot(ax - 5.8, y) - 1.8)) return [PG.LINE, 0];
    if (ax <= 5.8 && Math.abs(y) < 2.45) return [PG.COURT_B, 0];   // painted key
    const r3 = Math.hypot(ax - 1.6, y);
    if (ax > 1.6 && on(r3 - 6.75) && Math.abs(y) < 6.6) return [PG.LINE, 0];
    if (ax <= 1.6 + Math.sqrt(Math.max(0, 6.75 * 6.75 - 6.6 * 6.6)) && on(Math.abs(y) - 6.6)) return [PG.LINE, 0];
  }
  return [surf, 0];
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
  // win = [x0, z0, x1, z1] (m, optional): only that window of the global plot grid (same cell origin: streaming pages)
  constructor(net, fields, raster, cell, seed, win) {
    this.net = net; this.F = fields; this.Ra = raster; this.cell = cell; this.seed = seed;
    const b = net.bounds;
    this.x0 = b.x0; this.z0 = b.z0;
    this.nx = Math.ceil((b.x1 - b.x0) / cell); this.nz = Math.ceil((b.z1 - b.z0) / cell);
    this.gix = 0; this.giz = 0;                          // window offset in global plot cells (block seeds: global cell)
    if (win) {
      const i0 = Math.max(0, Math.floor((win[0] - b.x0) / cell)), j0 = Math.max(0, Math.floor((win[1] - b.z0) / cell));
      const i1 = Math.min(this.nx, Math.ceil((win[2] - b.x0) / cell)), j1 = Math.min(this.nz, Math.ceil((win[3] - b.z0) / cell));
      this.gix = i0; this.giz = j0; this.x0 = b.x0 + i0 * cell; this.z0 = b.z0 + j0 * cell; this.nx = Math.max(1, i1 - i0); this.nz = Math.max(1, j1 - j0);
    }
    this.lots = net.roads.map(r => this.lotCuts(r));
  }
  district(r) { return r.district; }
  // true when the two roads meet at an angle near (x, z) (not parallel neighbours)
  cornerish(a, b, x, z) {
    const ta = this.tangentNear(this.net.roads[a], x, z), tb = this.tangentNear(this.net.roads[b], x, z);
    return Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) > 0.35;
  }
  tangentNear(r, x, z) {
    // fast path (exact): every segment within the bucket reach of (x, z) is in the field's segment bucket there, in
    // the same order as r.pts, so the nearest one found there is the global nearest when it lies within that reach
    const F = this.F;
    if (F && F.buckets && !r.zeroSeg && r.P) {
      const bi = clamp(Math.floor((x - F.bX0) / F.B), 0, F.bx - 1) + clamp(Math.floor((z - F.bZ0) / F.B), 0, F.bz - 1) * F.bx;
      const list = F.buckets[bi];
      let bd = 1e9, bs = null;
      for (let k = 0; k < list.length; ++k) {
        const sg = F.segs[list[k]];
        if (sg.road !== r.id || sg.bulb) continue;
        const d = segDist(x, z, sg.ax, sg.az, sg.bx, sg.bz);
        if (d < bd) { bd = d; bs = sg; }
      }
      if (bs && bd <= r.P.half + r.P.sidewalk + 46 - 1e-6) {
        const [ax, az] = r.pts[bs.i], [bx, bz] = r.pts[bs.i + 1], l = Math.hypot(bx - ax, bz - az) || 1;
        return [(bx - ax) / l, (bz - az) / l];
      }
    }
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
        if (Math.hypot(px - core[0], pz - core[1]) < 170 * (this.net.zoneScale || 1)) rg = [24, 40];
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
function meshColumns(H, M, w, d, ox, oz, wallMat, mb, none) {
  const NEG = none !== undefined;   // heights may be negative; `none` marks absent columns
  const absent = (h) => NEG ? h === none : h < 0, base = (h) => NEG ? (h === none ? 0 : h) : Math.max(h, 0);
  const W2 = w + 2;
  const at = (x, z) => (z + 1) * W2 + (x + 1);
  // tops
  const done = new Uint8Array(w * d);
  for (let z = 0; z < d; ++z)
    for (let x = 0; x < w; ++x) {
      if (done[z * w + x]) continue;
      const i = at(x, z), h = H[i], m = M[i];
      if (absent(h)) { done[z * w + x] = 1; continue; }
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
        if (hL > hR && ownL) { face = 1; lo = base(hR); hi = hL; m = wallMat(M[iL]); }          // left column taller: face +axis
        else if (hR > hL && ownR) { face = -1; lo = base(hL); hi = hR; m = wallMat(M[iR]); }
        if (!face || hi <= lo) { ++b; continue; }
        let b1 = b + 1;
        while (b1 < nB) {
          const jL = dir === 0 ? at(a - 1, b1) : at(b1, a - 1), jR = dir === 0 ? at(a, b1) : at(b1, a);
          const gL = H[jL], gR = H[jR];
          let f2 = 0, lo2 = 0, hi2 = 0, m2 = 0;
          if (gL > gR && ownL) { f2 = 1; lo2 = base(gR); hi2 = gL; m2 = wallMat(M[jL]); }
          else if (gR > gL && ownR) { f2 = -1; lo2 = base(gL); hi2 = gR; m2 = wallMat(M[jR]); }
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
const WALL_MAT = (m) => (m === MAT.MEDIAN_GRASS || m === MAT.MEDIAN_CURB) ? MAT.MEDIAN_CURB : (m === 206 || m === 140 || m === 207 || m === 16 || m === 216 || m === 221) ? m : MAT.CURB;   // banks: earth / stone risers
function prepareBuild(net, voxel, opts) {
  opts = opts || {};
  const F = new FieldSampler(net, opts.fieldCell || 0.5);
  F.build();
  const R = new Rasterizer(net, F, voxel, opts);
  const { chunks, VX0, VZ0, VX1, VZ1 } = chunkGrid(net, voxel, opts);
  return { net, voxel, F, R, chunks, VX0, VZ0, VX1, VZ1 };
}
function chunkGrid(net, voxel, opts) {
  const b = net.bounds;
  const VX0 = Math.floor(b.x0 / voxel), VZ0 = Math.floor(b.z0 / voxel), VX1 = Math.ceil(b.x1 / voxel), VZ1 = Math.ceil(b.z1 / voxel);
  const CH = (opts && opts.chunk) || Math.max(128, Math.round(48 / voxel));   // ~48 m chunks
  const chunks = [];
  for (let oz = VZ0; oz < VZ1; oz += CH)
    for (let ox = VX0; ox < VX1; ox += CH) chunks.push({ ox, oz, w: Math.min(CH, VX1 - ox), d: Math.min(CH, VZ1 - oz) });
  return { chunks, VX0, VZ0, VX1, VZ1 };
}
// indices of the chunks (incl. their 1-column apron) that a list of curb cuts touches: they are meshed again
// once the cuts are known (the cuts come from the building placement, after the first road pass)
function chunksForCuts(chunks, cuts, voxel) {
  const out = [];
  if (!cuts || !cuts.length) return out;
  const boxes = cuts.map((c) => {
    const pts = [[c.ax, c.az], [c.bx, c.bz], [c.ax + c.nx * c.depth, c.az + c.nz * c.depth], [c.bx + c.nx * c.depth, c.bz + c.nz * c.depth]];
    const pad = CUT_FLARE + 1;
    return [Math.min(...pts.map(p => p[0])) - pad, Math.min(...pts.map(p => p[1])) - pad, Math.max(...pts.map(p => p[0])) + pad, Math.max(...pts.map(p => p[1])) + pad].map(v => v / voxel);
  });
  chunks.forEach((c, i) => { if (boxes.some(b => b[2] > c.ox - 1 && b[0] < c.ox + c.w + 1 && b[3] > c.oz - 1 && b[1] < c.oz + c.d + 1)) out.push(i); });
  return out;
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
      if (gx < VX0 || gx >= VX1 || gz < VZ0 || gz >= VZ1) { H[i] = -32768; M[i] = 0; continue; }
      R.classify((gx + 0.5) * voxel, (gz + 0.5) * voxel, o, out);
      H[i] = out[0]; M[i] = out[1];
    }
  const mb = new MeshBuffer();
  meshColumns(H, M, w, d, ox, oz, WALL_MAT, mb, -32768);
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
  ctx.footprints = buildings.footprints || null;     // placeProps keeps street furniture clear of stoops / entrances
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
  // the building placement registered driveway curb cuts: mesh the chunks they touch again
  for (const i of chunksForCuts(ctx.chunks, ctx.R.cuts, voxel)) { const c = ctx.chunks[i]; quads -= c.mesh.quads; c.mesh = buildChunk(ctx, c); quads += c.mesh.quads; }
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
  // (no plinth voxel layer: props stand one voxel into the sidewalk slab, so a 1-voxel plinth's top lay exactly in
  // the sidewalk surface and fought it - dev/groundfight.js; the bins reach down into the slab instead)
  for (const [x0, m] of [[-11, PM.RECYCLE_BLUE], [1, PM.LITTER]]) {
    M.box(x0, 0, -5, x0 + 10, 1, 5, m);
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
    M.box(x + 2, 0, -2, x + 7, 6, 2, PM.POLE_DARK);          // pedestal (its foot plate lay in the sidewalk surface)
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
  M.box(-1, 0, -1, 1, 21, 1, PM.POLE_DARK);                 // (no foot plate: it lay in the sidewalk surface)
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
// --- vehicles parked at the curb / in loading bays: see the vehicle library (Vehicles, section 7b) and PROP_TYPES
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
// ------------------------------------------------------------------------------------------------ 7b. vehicles
// ONE vehicle library for the whole city (curb vans / trucks, service yards, parking lots, driveways, traffic).
// Renderer-free voxel models at the street-furniture scale (5 cm, PV). API (stable, see dev/VEHICLES_API.md):
//   Vehicles.KINDS                      list of kind names (sedan, hatchback, coupe, suv, pickup, minivan, taxi, police,
//                                       ambulance, fire_engine, city_bus, school_bus, panel_van, delivery_van, box_truck,
//                                       garbage_truck, fuel_tanker, tanker_cab, tanker_trailer, semi, semi_cab,
//                                       semi_trailer, rolloff_truck, rolloff)
//   Vehicles.INFO[kind]                 { len, wid, h (m, nominal), cls: 'car'|'van'|'truck'|'bus'|'trailer'|'prop' }
//   Vehicles.model(kind, opts)          -> { M: VoxModel, len, wid, h (m, actual bounds), x0, x1, z0, z1 (m) }
//                                       +x is the front, z centred (+z = right side), y = 0 on the ground.
//                                       opts: { paint (material id, default from seed), seed (int: trim / detail
//                                       variant), state: 'ok'|'damaged'|'crashed'|'burnt'|'rolled', doors (bool: front
//                                       doors / rear doors open), lights (bool: head / tail lights and light bars on) }
//                                       Cached by key: identical variants share one model (do not mutate M).
//   Vehicles.mesh(kind, opts)           -> same plus `mesh` (meshVoxels3D, metres), cached.
//   Vehicles.paints                     { car: [[mat, weight], ...] (US colour mix), pick(seed) -> mat, liveries }
//   Vehicles.emit(E, kind, opts, x, y, z, dir, scale) place a vehicle into an emitter with quad(p, q, r, s, m, n)
//                                       (city_arch Emitter, yardkit): dir 0..3 = nose to -z, +z, -x, +x; (x, z) the
//                                       centre of the footprint, y the ground, all in the emitter's units; scale =
//                                       emitter units per metre (4 for building voxels). Faces resting on y = 0 skipped.
const VM = {                                    // vehicle materials (palette 160..199)
  WHITE: 160, SILVER: 161, GREY: 162, BLACK: 163, RED: 164, BLUE: 165, NAVY: 166, GREEN: 167, BEIGE: 168, BROWN: 169,
  ORANGE: 170, TAXI: 171, BUS_YELLOW: 172, FIRE_RED: 173, MAROON: 174, SKY: 175,
  TYRE: 176, PLASTIC: 177, CHROME: 178, HEAD: 179, TAIL: 180, TAIL_LIT: 181, AMBER: 182, SEAM: 183, INTERIOR: 184,
  CHAR: 185, ASH: 186, RUST: 187, RUST_DARK: 188, BAR_RED: 189, BAR_BLUE: 190, TANK: 191, CRACK: 192, GARB_GREEN: 193,
  METRO_BLUE: 194, TEAL: 195, GOLD: 196, DARK_GREY: 197, CREAM: 198, BAR_AMBER: 199, GLASS: 200, GLASS_TINT: 201
};
const VEH_PALETTE = {
  160: [226, 226, 222], 161: [170, 174, 178], 162: [112, 116, 120], 163: [36, 38, 42], 164: [158, 34, 32], 165: [44, 74, 128],
  166: [32, 42, 70], 167: [46, 80, 60], 168: [188, 174, 146], 169: [98, 72, 54], 170: [206, 108, 40], 171: [236, 186, 40],
  172: [242, 172, 22], 173: [184, 30, 28], 174: [104, 32, 38], 175: [126, 156, 186],
  176: [30, 30, 32], 177: [44, 45, 48], 178: [208, 210, 212], 179: [236, 236, 226], 180: [150, 26, 26], 181: [235, 40, 30],
  182: [226, 140, 34], 183: [70, 72, 76], 184: [52, 50, 48], 185: [34, 31, 30], 186: [92, 88, 84], 187: [128, 72, 44],
  188: [82, 52, 38], 200: [44, 54, 66], 201: [30, 34, 40], 189: [230, 40, 36], 190: [40, 90, 240], 191: [200, 204, 208], 192: [168, 176, 182], 193: [50, 104, 66],
  194: [38, 92, 156], 195: [40, 112, 120], 196: [176, 150, 92], 197: [74, 78, 82], 198: [226, 214, 182], 199: [240, 160, 30]
};
const Vehicles = (function () {
  const GLASS = VM.GLASS, LENS = 57, HUB = VM.SILVER, PLATE = 64;   // shared ids: GLASS_DARK (glossy), street-lamp lens (lit), steel, sign white
  const KINDS = ['sedan', 'hatchback', 'coupe', 'suv', 'pickup', 'minivan', 'taxi', 'police', 'ambulance', 'fire_engine',
    'city_bus', 'school_bus', 'panel_van', 'delivery_van', 'box_truck', 'garbage_truck', 'fuel_tanker', 'tanker_cab', 'tanker_trailer',
    'semi', 'semi_cab', 'semi_trailer', 'rolloff_truck', 'rolloff'];
  const CAR_MIX = [[VM.WHITE, 24], [VM.BLACK, 19], [VM.GREY, 17], [VM.SILVER, 13], [VM.BLUE, 7], [VM.NAVY, 3], [VM.RED, 8],
    [VM.MAROON, 2], [VM.BEIGE, 2], [VM.BROWN, 1], [VM.GREEN, 1], [VM.SKY, 1], [VM.ORANGE, 1], [VM.GOLD, 1]];
  const FLEET_MIX = [[VM.WHITE, 60], [VM.SILVER, 10], [VM.GREY, 6], [VM.BLUE, 6], [VM.RED, 5], [VM.GREEN, 4], [VM.BLACK, 4], [VM.METRO_BLUE, 3], [VM.ORANGE, 2]];
  const wpick = (mix, h) => { let t = h * mix.reduce((s, p) => s + p[1], 0); for (const p of mix) { t -= p[1]; if (t < 0) return p[0]; } return mix[0][0]; };
  const hs = (seed, k) => hash2(seed | 0, k | 0, 9137);
  const paints = {
    car: CAR_MIX, fleet: FLEET_MIX,
    pick: (seed) => wpick(CAR_MIX, hs(seed, 1)),
    pickFleet: (seed) => wpick(FLEET_MIX, hs(seed, 2)),
    // liveries (fictional operators): body / accent / stripe materials
    liveries: {
      taxi: { body: VM.TAXI, accent: VM.BLACK, name: 'Sunbelt Cab Co.' },
      police: { body: VM.BLACK, accent: VM.WHITE, name: 'City PD (black-and-white)' },
      ambulance: { body: VM.WHITE, accent: VM.RED, stripe: VM.ORANGE, name: 'County EMS' },
      fire_engine: { body: VM.FIRE_RED, accent: VM.WHITE, name: 'Fire Dept. Engine Co.' },
      school_bus: { body: VM.BUS_YELLOW, accent: VM.BLACK, name: 'Unified School District' },
      city_bus: { body: VM.WHITE, accent: VM.METRO_BLUE, stripe: VM.TEAL, name: 'Metro Transit' },
      garbage_truck: { body: VM.WHITE, accent: VM.GARB_GREEN, name: 'Green Valley Sanitation' },
      fuel_tanker: { body: VM.TANK, accent: VM.RED, stripe: VM.NAVY, name: 'Prairie Star Fuels' }
    }
  };
  const INFO = {
    sedan: { len: 4.8, wid: 1.84, h: 1.45, cls: 'car' }, hatchback: { len: 4.2, wid: 1.8, h: 1.5, cls: 'car' },
    coupe: { len: 4.8, wid: 1.9, h: 1.32, cls: 'car' }, suv: { len: 4.9, wid: 1.95, h: 1.8, cls: 'car' },
    pickup: { len: 5.8, wid: 2.0, h: 1.9, cls: 'car' }, minivan: { len: 5.1, wid: 1.95, h: 1.75, cls: 'car' },
    taxi: { len: 4.8, wid: 1.84, h: 1.75, cls: 'car' }, police: { len: 4.9, wid: 1.84, h: 1.62, cls: 'car' },
    ambulance: { len: 6.6, wid: 2.3, h: 2.85, cls: 'van' }, fire_engine: { len: 10.2, wid: 2.5, h: 3.3, cls: 'truck' },
    city_bus: { len: 12.0, wid: 2.55, h: 3.2, cls: 'bus' }, school_bus: { len: 11.0, wid: 2.45, h: 3.2, cls: 'bus' },
    panel_van: { len: 5.6, wid: 2.1, h: 2.35, cls: 'van' }, delivery_van: { len: 5.8, wid: 2.2, h: 2.8, cls: 'van' },
    box_truck: { len: 7.5, wid: 2.5, h: 3.4, cls: 'truck' }, garbage_truck: { len: 9.4, wid: 2.5, h: 3.5, cls: 'truck' },
    fuel_tanker: { len: 17.0, wid: 2.5, h: 3.4, cls: 'truck' }, tanker_cab: { len: 6.2, wid: 2.5, h: 3.4, cls: 'truck' },
    tanker_trailer: { len: 12.0, wid: 2.5, h: 3.2, cls: 'trailer' }, semi: { len: 17.4, wid: 2.6, h: 4.0, cls: 'truck' },
    semi_cab: { len: 6.2, wid: 2.5, h: 3.4, cls: 'truck' }, semi_trailer: { len: 13.0, wid: 2.6, h: 4.0, cls: 'trailer' },
    rolloff_truck: { len: 8.8, wid: 2.5, h: 3.1, cls: 'truck' }, rolloff: { len: 6.0, wid: 2.35, h: 1.4, cls: 'prop' }
  };

  // ---------------------------------------------------------------------------------------------- parts
  // symmetric box: z range given for the +z side, mirrored to -z ([-z1, -z0))
  const sym = (M, x0, y0, z0, x1, y1, z1, m) => { M.box(x0, y0, z0, x1, y1, z1, m); M.box(x0, y0, -z1, x1, y1, -z0, m); };
  // wheel at axle x, radius r, outer face at |z| = zo, tread tw; dual: a second tyre inside; arch: cut first
  function wheel(M, ax, r, zo, tw, hub, dual) {
    const c = Math.max(1, Math.round(r * 0.35)), zi = zo - tw * (dual ? 2 : 1) - (dual ? 1 : 0);
    (M._wheels || (M._wheels = [])).push({ ax, r, zo, zi });
    sym(M, ax - r, c, zi, ax + r, 2 * r - c, zo, VM.TYRE); sym(M, ax - r + c, 0, zi, ax + r - c, 2 * r, zo, VM.TYRE);
    const h = Math.max(2, Math.round(r * 0.4));
    sym(M, ax - h, r - h, zo - 1, ax + h, r + h, zo, hub || HUB);
    if (r >= 9) sym(M, ax - 1, r - 1, zo - 1, ax + 1, r + 1, zo, VM.DARK_GREY);          // hub nut cap on big wheels
  }
  function arch(M, ax, r, zo, depth, top) {        // wheel opening in the body sides (outer band only)
    const t = top || 2 * r + 2;
    sym(M, ax - r - 1, 0, zo - depth, ax + r + 1, t - 1, zo + 2, -1);
    sym(M, ax - r + 1, t - 1, zo - depth, ax + r - 1, t, zo + 2, -1);
  }
  // paint the outer layer of a side rectangle (both sides): x0..x1, y0..y1 on |z| = zs-1
  const sideMark = (M, x0, y0, x1, y1, zs, m) => sym(M, x0, y0, zs - 1, x1, y1, zs, m);
  // recessed window on both sides: erase outer layer, glass one voxel in
  function sideWin(M, x0, y0, x1, y1, zs, g) { sym(M, x0, y0, zs - 1, x1, y1, zs, -1); sym(M, x0, y0, zs - 2, x1, y1, zs - 1, g || GLASS); }

  // ---------------------------------------------------------------------------------------------- cars
  // body spec in voxels: L, W, H, r (wheel), axF, axR, sill, belt, ws0 / ws1 (windscreen base / top x),
  // rr0 / rr1 (rear glass base / top x), bp (B pillar x), doors (2 | 4), rear: 'notch' | 'hatch' | 'fast'
  const CAR = {
    sedan: { L: 96, W: 36, H: 29, r: 7, axF: 30, axR: -29, sill: 6, belt: 17, ws0: 20, ws1: 6, rr1: -17, rr0: -29, bp: -3, doors: 4, rear: 'notch' },
    hatchback: { L: 84, W: 35, H: 30, r: 7, axF: 27, axR: -27, sill: 6, belt: 17, ws0: 18, ws1: 5, rr1: -32, rr0: -39, bp: -6, doors: 4, rear: 'hatch' },
    coupe: { L: 96, W: 37, H: 26, r: 8, axF: 30, axR: -29, sill: 6, belt: 16, ws0: 10, ws1: -2, rr1: -14, rr0: -36, bp: -14, doors: 2, rear: 'fast' },
    suv: { L: 98, W: 38, H: 35, r: 8, axF: 32, axR: -30, sill: 8, belt: 21, ws0: 22, ws1: 10, rr1: -44, rr0: -46, bp: -4, doors: 4, rear: 'hatch' },
    minivan: { L: 102, W: 38, H: 34, r: 7, axF: 35, axR: -30, sill: 7, belt: 19, ws0: 30, ws1: 12, rr1: -47, rr0: -49, bp: 4, doors: 4, rear: 'hatch', slider: true },
    pickup: { L: 116, W: 39, H: 37, r: 8, axF: 38, axR: -36, sill: 9, belt: 23, ws0: 24, ws1: 13, rr1: -11, rr0: -11, bp: 2, doors: 4, rear: 'bed' }
  };
  CAR.taxi = CAR.sedan; CAR.police = Object.assign({}, CAR.sedan, { L: 98, axF: 31, ws0: 21 });

  function car(kind, o) {
    const S = CAR[kind], hl = S.L >> 1, hw = S.W >> 1, H = S.H, seed = o.seed | 0;
    const M = new VoxModel(S.L + 4, H + 8, S.W + 8, hl + 2, hw + 4);
    const lv = paints.liveries[kind];
    const P = o.paint !== undefined && o.paint !== null ? o.paint : lv ? lv.body : paints.pick(seed);
    const glass = GLASS, cw = hw - 2;                                  // cabin half width (tumblehome)
    const crushed = o.state === 'rolled';
    // lower body
    M.box(-hl, S.sill, -hw, hl, S.belt, hw, P);
    M.box(-hl + 6, 2, -hw + 7, hl - 6, S.sill, hw - 7, VM.PLASTIC);                           // underbody
    sym(M, -hl, 0, hw - 1, -hl + 1, H, hw, -1); sym(M, hl - 1, 0, hw - 1, hl, H, hw, -1);        // corner chamfers
    M.box(hl - 2, S.belt - 1, -hw, hl, S.belt, hw, -1); M.box(-hl, S.belt - 1, -hw, -hl + 1, S.belt, hw, -1);   // rounded nose / tail
    // greenhouse
    const H1 = crushed ? H - 4 : H;
    if (S.rear === 'bed') {
      const top = H1;
      for (let y = S.belt; y < top; ++y) {
        const t = (y - S.belt) / Math.max(1, top - S.belt - 1), xf = Math.round(S.ws0 + (S.ws1 - S.ws0) * Math.min(1, Math.floor(t * 4) / 4 + 0.12));
        M.box(S.rr0, y, -cw, xf, y + 1, cw, glass);
      }
      M.box(S.rr0, H1 - 2, -cw, S.ws1 - 1, H1, cw, P);
      M.box(S.rr0, S.belt, -cw, S.rr0 + 2, H1, cw, P);                                     // cab back wall
      // bed: walls with an open tub, tailgate
      M.box(-hl, S.belt - 1, -hw + 2, S.rr0 - 2, S.belt + 2, hw - 2, -1);
      M.box(-hl + 1, S.sill + 4, -hw + 2, S.rr0 - 2, S.sill + 5, hw - 2, VM.PLASTIC);         // bed liner floor
      M.box(-hl, S.sill + 5, -hw + 2, S.rr0 - 2, S.belt + 2, hw - 2, -1);
      sym(M, -hl, S.sill, hw - 2, S.rr0 - 1, S.belt + 2, hw, P);
      M.box(-hl, S.sill, -hw, -hl + 2, S.belt + 2, hw, P);
      M.box(S.rr0 - 2, S.sill, -hw, S.rr0, S.belt + 2, hw, P);
      sym(M, -hl + 1, S.belt + 1, hw - 1, S.rr0 - 2, S.belt + 2, hw, VM.PLASTIC);              // bed rail caps
      if (hs(seed, 5) < 0.4) sym(M, S.rr0 - 2, S.belt + 2, hw - 3, S.rr0 - 1, H1 - 4, hw - 1, VM.PLASTIC);   // headache rack posts
    } else {
      for (let y = S.belt; y < H1; y += 2) {
        const t = Math.min(1, (y - S.belt + 1) / Math.max(1, H1 - S.belt - 2));
        const xf = Math.round(S.ws0 + (S.ws1 - S.ws0) * t), xr = Math.round(S.rr0 + (S.rr1 - S.rr0) * t);
        M.box(xr, y, -cw, xf, Math.min(H1, y + 2), cw, glass);
        sym(M, xf - 2, y, cw - 1, xf, Math.min(H1, y + 2), cw, P);                            // A pillars
        if (S.rear !== 'hatch') sym(M, xr, y, cw - 1, xr + (S.rear === 'fast' ? 5 : 3), Math.min(H1, y + 2), cw, P);   // C pillars
        else sym(M, xr, y, cw - 1, xr + 2, Math.min(H1, y + 2), cw, P);
      }
      const t1 = 1, xf1 = Math.round(S.ws1), xr1 = Math.round(S.rr1);
      M.box(xr1 - (S.rear === 'hatch' ? 1 : 0), H1 - 2, -cw, xf1, H1, cw, P);                 // roof
      sym(M, S.bp - 1, S.belt, cw - 1, S.bp + 2, H1, cw, P);                                  // B pillar
      if (kind === 'suv' || kind === 'minivan') sym(M, Math.round(S.rr1) + 9, S.belt, cw - 1, Math.round(S.rr1) + 11, H1, cw, P);   // D pillar
      if (S.rear === 'notch') M.box(-hl + 1, S.belt, -hw + 2, S.rr0, S.belt + 1, hw - 2, P);   // trunk lid lip
      if (S.rear === 'fast' && kind === 'coupe') M.box(-hl + 1, S.belt, -hw + 3, -hl + 4, S.belt + 2, hw - 3, hs(seed, 6) < 0.5 ? VM.PLASTIC : P);   // ducktail
      void t1;
    }
    // bumpers, grille, lights, plate
    M.box(hl - 1, S.sill - 1, -hw + 1, hl, S.sill + 3, hw - 1, VM.PLASTIC);
    M.box(-hl, S.sill - 1, -hw + 1, -hl + 1, S.sill + 3, hw - 1, VM.PLASTIC);
    const big = kind === 'pickup' || kind === 'suv';
    M.box(hl - 1, S.sill + 3, -hw + 8, hl, S.belt - (big ? 2 : 3), hw - 8, VM.PLASTIC);                       // grille
    if (big) { M.box(hl - 1, S.belt - 3, -hw + 8, hl, S.belt - 2, hw - 8, VM.CHROME); M.box(hl - 1, S.sill + 3, -1, hl, S.belt - 2, 1, VM.CHROME); }
    sym(M, hl - 1, S.belt - 4, hw - 7, hl, S.belt - 2, hw - 2, o.lights ? LENS : VM.HEAD);
    sym(M, -hl, S.belt - 5, hw - 7, -hl + 1, S.belt - 2, hw - 2, o.lights ? VM.TAIL_LIT : VM.TAIL);
    sym(M, -hl, S.belt - 6, hw - 4, -hl + 1, S.belt - 5, hw - 2, VM.AMBER);
    M.box(-hl, S.sill + 3, -3, -hl + 1, S.sill + 6, 3, PLATE);
    sym(M, hl - 2, S.sill + 1, hw - 1, hl - 1, S.sill + 3, hw, VM.AMBER);                    // side markers
    // mirrors
    if (!crushed) { sym(M, S.ws0 - 3, S.belt, cw, S.ws0 - 1, S.belt + 2, hw + 1, P); sym(M, S.ws0 - 4, S.belt + 2, hw - 1, S.ws0 - 1, S.belt + 4, hw + 2, P); }
    // door seams + handles
    const seams = S.doors === 4 ? [S.ws0 - 1, S.bp, S.rr0 + (S.rear === 'bed' ? 1 : 3)] : [S.ws0 - 1, S.bp - 4];
    if (S.rear === 'bed') seams[2] = S.rr0 + 1;
    for (const x of seams) sideMark(M, x, S.sill + 1, x + 1, S.belt, hw, VM.SEAM);
    sideMark(M, S.bp - 6, S.belt - 3, S.bp - 4, S.belt - 2, hw, VM.SEAM);
    if (S.doors === 4) sideMark(M, seams[2] - 6, S.belt - 3, seams[2] - 4, S.belt - 2, hw, VM.SEAM);
    sideMark(M, -hl + 2, S.sill, hl - 2, S.sill + 1, hw, VM.PLASTIC);                       // rocker trim
    // wheels
    for (const ax of [S.axF, S.axR]) { arch(M, ax, S.r, hw, 7); wheel(M, ax, S.r, hw - 1, 5, kind === 'coupe' ? VM.CHROME : HUB); }
    // kind extras
    if (kind === 'suv' && hs(seed, 3) < 0.7) { sym(M, S.rr1 + 2, H1, cw - 2, S.ws1 - 3, H1 + 1, cw - 1, VM.PLASTIC); sym(M, S.rr1 + 4, H1 + 1, cw - 2, S.ws1 - 5, H1 + 2, cw - 1, VM.PLASTIC); }
    if (kind === 'coupe') {                                                                   // racing stripes on hood / roof
      if (hs(seed, 4) < 0.6) { const sc = P === VM.WHITE || P === VM.SILVER ? VM.BLACK : VM.WHITE; M.box(S.ws0 - 2, S.belt - 1, -3, hl - 1, S.belt, -1, sc); M.box(S.ws0 - 2, S.belt - 1, 1, hl - 1, S.belt, 3, sc); M.box(S.ws0, S.belt - 2, -3, hl - 2, S.belt - 1, 3, -1); M.box(S.ws0 - 2, S.belt - 1, -1, hl - 2, S.belt, 1, P); }
      M.box(S.ws0 - 10, S.belt, -4, S.ws0 - 2, S.belt + 1, 4, VM.PLASTIC);                    // hood scoop
    }
    if (kind === 'taxi') {
      sideMark(M, -hl + 3, S.belt - 4, hl - 3, S.belt - 3, hw, VM.BLACK);                       // checker band
      for (let x = -hl + 6; x < hl - 6; x += 6) sideMark(M, x, S.belt - 3, x + 3, S.belt - 2, hw, VM.BLACK);
      if (!crushed) { M.box(-8, H1, -5, 4, H1 + 5, 5, VM.WHITE); M.box(-7, H1 + 1, -6, 3, H1 + 4, 6, o.lights ? LENS : VM.CREAM); M.box(-9, H1 + 4, -5, 5, H1 + 5, 5, VM.TAXI); }
    }
    if (kind === 'police') {
      // black-and-white: white doors and roof
      sym(M, S.rr0 + 3, S.sill + 1, hw - 3, S.ws0 - 1, S.belt, hw, VM.WHITE);
      M.box(Math.round(S.rr1), H1 - 2, -cw, S.ws1, H1, cw, VM.WHITE);
      sideMark(M, S.bp - 6, S.belt - 3, S.bp - 4, S.belt - 2, hw, VM.SEAM);
      sideMark(M, S.bp - 12, S.sill + 3, S.bp + 8, S.sill + 6, hw, VM.GOLD);                      // door star
      M.box(hl - 1, S.sill + 1, -hw + 6, hl + 2, S.sill + 9, hw - 6, VM.PLASTIC);              // push bar
      M.box(hl + 1, S.sill + 9, -hw + 7, hl + 2, S.belt + 1, -hw + 9, VM.PLASTIC); M.box(hl + 1, S.sill + 9, hw - 9, hl + 2, S.belt + 1, hw - 7, VM.PLASTIC);
      if (!crushed) {
        M.box(-6, H1, -cw + 1, 2, H1 + 1, cw - 1, VM.PLASTIC);
        M.box(-6, H1 + 1, -cw + 1, 2, H1 + 3, 0, o.lights ? VM.BAR_RED : VM.RED);
        M.box(-6, H1 + 1, 0, 2, H1 + 3, cw - 1, o.lights ? VM.BAR_BLUE : VM.BLUE);
        M.box(-6, H1 + 1, -1, 2, H1 + 3, 1, VM.CHROME);
      }
      M.box(S.ws0 - 4, S.belt + 2, -cw - 1, S.ws0 - 3, S.belt + 4, -cw, VM.CHROME);              // spotlight
    }
    if (kind === 'minivan') sideMark(M, S.bp + 2, S.belt + 1, -18, S.belt + 2, hw - 1, VM.PLASTIC);   // slider rail
    return { M, hl, hw, H: H1, spec: S, doorsAt: { front: [S.bp + 2, S.ws0 - 1], y0: S.sill + 1, y1: H1 - 3, side: hw } };
  }

  // ---------------------------------------------------------------------------------------------- trucks, vans, buses
  // a cab with a sloped windscreen: x0..x1 (front at x1), floor y0, roof y1, half width hw; slope run, windscreen bottom yw
  function cab(M, x0, x1, y0, y1, hw, P, yw, run, o) {
    M.box(x0, y0, -hw, x1, y1, hw, P);
    for (let y = yw; y < y1; ++y) { const k = Math.round((y - yw) * run / Math.max(1, y1 - yw)); M.box(x1 - k, y, -hw, x1, y + 1, hw, -1); }
    for (let y = yw; y < y1 - 1; y += 1) { const k = Math.round((y - yw) * run / Math.max(1, y1 - yw)); M.box(x1 - k - 1, y, -hw + 2, x1 - k, y + 1, hw - 2, GLASS); }
    sideWin(M, x1 - run - 14, yw + 1, x1 - Math.round(run * 0.4) - 2, y1 - 2, hw);
    sym(M, x1 - 2, y0 + 2, hw - 6, x1, y0 + 5, hw - 1, o.lights ? LENS : VM.HEAD);
    M.box(x1 - 1, y0 - 2, -hw, x1 + 1, y0 + 1, hw, VM.PLASTIC);                                 // bumper
    sym(M, x1 - run - 12, yw, hw, x1 - run - 10, yw + 6, hw + 2, VM.PLASTIC);                   // mirrors
  }
  // conventional US truck tractor / bus front: long hood, chrome grille, sleeper or day cab
  function tractor(M, xf, hw, P, o, sleeper) {
    const r = 10, axF = xf - 22;
    const hoodL = 34, cabL = 30 + (sleeper ? 28 : 0);
    const cab0 = xf - hoodL - cabL;
    M.box(xf - hoodL, 12, -hw + 6, xf - 1, 40, hw - 6, P);                                     // hood
    M.box(xf - hoodL, 40, -hw + 7, xf - 6, 42, hw - 7, P);
    M.box(xf - 2, 12, -hw + 9, xf, 40, hw - 9, VM.CHROME); for (let y = 15; y < 39; y += 3) M.box(xf - 1, y, -hw + 10, xf, y + 1, hw - 10, VM.DARK_GREY);
    M.box(xf - 1, 8, -hw + 2, xf + 2, 14, hw - 2, VM.CHROME);                                   // bumper
    sym(M, xf - 4, 26, hw - 9, xf - 1, 32, hw - 6, o.lights ? LENS : VM.HEAD);
    sym(M, xf - 30, 20, hw - 6, xf - 8, 34, hw - 2, P);                                        // fenders
    M.box(cab0, 12, -hw + 1, xf - hoodL, 64, hw - 1, P);                                       // cab
    for (let y = 42; y < 62; ++y) { const x = xf - hoodL - Math.round((y - 42) * 0.3); M.box(x, y, -hw + 1, xf - hoodL, y + 1, hw - 1, -1); if (y < 61) M.box(x - 1, y, -hw + 3, x, y + 1, hw - 3, GLASS); }
    sideWin(M, xf - hoodL - 20, 42, xf - hoodL - 3, 61, hw - 1);
    if (sleeper) { M.box(cab0, 64, -hw + 2, cab0 + 34, 76, hw - 2, P); sideWin(M, cab0 + 8, 46, cab0 + 14, 52, hw - 1); }
    sym(M, xf - hoodL - 2, 44, hw - 1, xf - hoodL, 54, hw + 3, VM.CHROME);                     // west coast mirrors
    sym(M, cab0 + 2, 12, hw - 4, xf - hoodL - 2, 18, hw - 1, VM.CHROME);                       // fuel tanks / steps
    sym(M, cab0 + 2, 40, hw - 2, cab0 + 4, (sleeper ? 92 : 80), hw - 1, VM.CHROME);              // exhaust stacks
    arch(M, axF, r, hw, 8, 2 * r + 3); wheel(M, axF, r, hw - 1, 6, VM.CHROME);
    const axR = cab0 - 4; arch(M, axR, r, hw, 15, 2 * r + 3); wheel(M, axR, r, hw - 1, 6, HUB, true); wheel(M, axR - 22, r, hw - 1, 6, HUB, true);
    M.box(axR - 34, 12, -hw + 6, cab0, 24, hw - 6, VM.DARK_GREY);                              // frame rails + fifth wheel
    M.box(axR - 16, 24, -hw + 8, axR + 4, 26, hw - 8, VM.PLASTIC);
    return { cab0, axR, rear: axR - 34 };
  }

  function build(kind, o) {
    const seed = o.seed | 0, lv = paints.liveries[kind] || {};
    let M, doors = null;
    const lit = (on, off) => o.lights ? on : off;
    switch (kind) {
      case 'sedan': case 'hatchback': case 'coupe': case 'suv': case 'pickup': case 'minivan': case 'taxi': case 'police': {
        const c = car(kind, o); M = c.M; doors = { kind: 'car', d: c.doorsAt }; break;
      }
      case 'panel_van': case 'ambulance': case 'delivery_van': {
        // full-size van (ambulance: van cab + modular box)
        const P = o.paint != null ? o.paint : lv.body || paints.pickFleet(seed);
        const L = kind === 'panel_van' ? 112 : kind === 'ambulance' ? 132 : 116, W = kind === 'panel_van' ? 40 : 44, hl = L >> 1, hw = W >> 1;
        M = new VoxModel(L + 6, 64, W + 8, hl + 3, hw + 4);
        const r = 8;
        if (kind === 'delivery_van') {
          // step van: flat tall body, short nose, big windscreen
          M.box(-hl, 8, -hw, hl - 10, 56, hw, P); M.box(hl - 10, 8, -hw + 2, hl, 24, hw - 2, P);
          M.box(hl - 10, 24, -hw + 1, hl - 7, 52, hw - 1, GLASS); M.box(hl - 7, 22, -hw + 3, hl - 1, 24, hw - 3, P);
          sideWin(M, hl - 26, 18, hl - 12, 50, hw);                                              // open step door
          sym(M, hl - 25, 18, hw - 3, hl - 13, 50, hw - 2, VM.INTERIOR);
          M.box(-hl, 10, -hw + 2, -hl + 1, 52, hw - 2, VM.SEAM); M.box(-hl, 10, -1, -hl + 1, 52, 1, VM.PLASTIC);
          sideMark(M, -hl + 4, 30, hl - 30, 36, hw, lv.accent || (P === VM.WHITE ? VM.BROWN : VM.WHITE));
          sym(M, hl - 1, 14, hw - 6, hl, 18, hw - 2, lit(LENS, VM.HEAD)); sym(M, -hl, 14, hw - 5, -hl + 1, 20, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
          M.box(hl - 1, 6, -hw + 2, hl + 1, 10, hw - 2, VM.PLASTIC); M.box(-hl - 1, 6, -hw + 1, -hl + 1, 10, hw - 1, VM.PLASTIC);
          sym(M, hl - 10, 40, hw, hl - 8, 48, hw + 2, VM.PLASTIC);
          for (const ax of [hl - 20, -hl + 22]) { arch(M, ax, r, hw, 8); wheel(M, ax, r, hw - 1, 6, HUB, ax < 0); }
          M.box(-hl + 4, 3, -hw + 8, hl - 14, 8, hw - 8, VM.PLASTIC);
          doors = { kind: 'rear', x: -hl, y0: 10, y1: 52, hw };
          break;
        }
        const roof = kind === 'panel_van' ? 46 : 46;
        // body
        M.box(-hl, 8, -hw, hl - 22, kind === 'ambulance' ? 56 : roof, hw, P);
        if (kind === 'ambulance') { M.box(-hl, 8, -hw + 3, hl - 22, 9, hw - 3, VM.PLASTIC); M.box(hl - 40, 8, -hw + 2, hl - 22, 46, hw - 2, P); }
        // nose and cab
        M.box(hl - 22, 8, -hw + 1, hl - 1, 22, hw - 1, P);
        M.box(hl - 3, 22, -hw + 2, hl - 1, 23, hw - 2, -1);
        for (let y = 22; y < 44; y += 2) { const k = Math.round((y - 22) * 0.55); M.box(hl - 22, y, -hw + 1, hl - 20 + 12 - k, y + 2, hw - 1, y < 24 ? P : GLASS); sym(M, hl - 22 + 12 - k - 2, y, hw - 3, hl - 20 + 12 - k, y + 2, hw - 1, P); }
        M.box(hl - 26, 44, -hw + 1, hl - 14, 46, hw - 1, P);
        sideWin(M, hl - 32, 26, hl - 23, 42, hw - 1);
        sideMark(M, hl - 33, 10, hl - 32, 44, hw, VM.SEAM);
        M.box(hl - 1, 11, -hw + 9, hl, 18, hw - 9, VM.PLASTIC);
        sym(M, hl - 1, 15, hw - 8, hl, 19, hw - 2, lit(LENS, VM.HEAD));
        M.box(hl - 1, 6, -hw + 2, hl + 1, 11, hw - 2, VM.PLASTIC); M.box(-hl - 1, 6, -hw + 2, -hl + 1, 11, hw - 2, VM.PLASTIC);
        sym(M, hl - 30, 30, hw, hl - 27, 36, hw + 2, VM.PLASTIC);
        // back
        M.box(-hl, 12, -1, -hl + 1, kind === 'ambulance' ? 52 : 44, 1, VM.SEAM);
        sym(M, -hl, 14, hw - 5, -hl + 1, 26, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
        if (kind === 'panel_van') {
          sideMark(M, -2, 10, -1, 44, hw, VM.SEAM); sideMark(M, -18, 10, -17, 44, hw, VM.SEAM);
          if (hs(seed, 7) < 0.5) M.box(-hl, 30, -hw + 3, -hl + 1, 40, hw - 3, GLASS);
          const band = o.band != null ? o.band : (hs(seed, 8) < 0.45 ? 0 : P === VM.WHITE ? wpick([[VM.RED, 1], [VM.BLUE, 1], [VM.GREEN, 1], [VM.ORANGE, 1]], hs(seed, 9)) : VM.WHITE);
          if (band) sideMark(M, -hl + 6, 24, hl - 36, 31, hw, band);
          if (hs(seed, 10) < 0.35) { M.box(-hl + 8, roof, -hw + 4, hl - 30, roof + 1, -hw + 5, VM.PLASTIC); M.box(-hl + 8, roof, hw - 5, hl - 30, roof + 1, hw - 4, VM.PLASTIC); for (let x = -hl + 10; x < hl - 32; x += 18) M.box(x, roof + 1, -hw + 4, x + 2, roof + 2, hw - 4, VM.PLASTIC); M.box(-hl + 12, roof + 2, -hw + 6, -hl + 60, roof + 3, -hw + 9, VM.CHROME); }
        } else {
          // ambulance box: red stripe, orange band, windows, light bars, scene lights, Star-of-Life-ish cross
          sideMark(M, -hl + 1, 22, hl - 40, 26, hw, VM.RED); sideMark(M, -hl + 1, 26, hl - 40, 27, hw, VM.ORANGE);
          M.box(hl - 22, 22, -hw + 1, hl - 20, 24, hw - 1, VM.RED);
          sideMark(M, -16, 32, -6, 34, hw, VM.RED); sideMark(M, -12, 28, -10, 38, hw, VM.RED);
          sideWin(M, hl - 52, 34, hl - 44, 46, hw); sideMark(M, hl - 54, 10, hl - 53, 50, hw, VM.SEAM);
          M.box(-hl, 28, -hw + 4, -hl + 1, 44, -2, GLASS); M.box(-hl, 28, 2, -hl + 1, 44, hw - 4, GLASS);
          for (const [x0, x1] of [[-hl, -hl + 3], [hl - 43, hl - 40]]) { sym(M, x0, 52, hw - 4, x1, 56, hw, lit(VM.BAR_RED, VM.RED)); M.box(x0, 52, -2, x1, 56, 2, lit(VM.BAR_RED, VM.RED)); }
          M.box(hl - 40, 56, -hw + 4, hl - 36, 58, hw - 4, VM.WHITE); M.box(hl - 40, 56, -hw + 5, hl - 37, 58, -1, lit(VM.BAR_RED, VM.RED)); M.box(hl - 40, 56, 1, hl - 37, 58, hw - 5, lit(VM.BAR_BLUE, VM.WHITE));
          M.box(-hl + 6, 56, -6, -hl + 30, 58, 6, VM.SEAM);
          sym(M, -hl - 1, 6, -6, -hl + 1, 9, 6, VM.CHROME);
        }
        const axR = -hl + 20;
        for (const [ax, d] of [[hl - 15, false], [axR, kind === 'ambulance']]) { arch(M, ax, r, hw, 8); wheel(M, ax, r, hw - 1, 6, HUB, d); }
        M.box(-hl + 4, 3, -hw + 8, hl - 14, 8, hw - 8, VM.PLASTIC);
        doors = { kind: 'rear', x: -hl, y0: 10, y1: kind === 'ambulance' ? 52 : 44, hw };
        break;
      }
      case 'box_truck': case 'garbage_truck': case 'fire_engine': case 'rolloff_truck': {
        const L = { box_truck: 150, garbage_truck: 188, fire_engine: 204, rolloff_truck: 176 }[kind], W = 48, hl = L >> 1, hw = W >> 1;
        const P = o.paint != null ? o.paint : kind === 'fire_engine' ? VM.FIRE_RED : kind === 'garbage_truck' ? (hs(seed, 11) < 0.5 ? VM.WHITE : VM.GARB_GREEN) : kind === 'rolloff_truck' ? wpick([[VM.WHITE, 3], [VM.RED, 2], [VM.BLUE, 2], [VM.ORANGE, 1], [VM.GREEN, 1]], hs(seed, 12)) : VM.WHITE;
        M = new VoxModel(L + 8, 84, W + 10, hl + 4, hw + 5);
        const r = 10;
        // cab-over cab at the front: 2.0 m long
        const cx0 = hl - 40, cy1 = kind === 'fire_engine' ? 66 : 62;
        if (kind === 'fire_engine') {
          // custom crew cab: flat front, big windscreen, 4 doors, light bar
          M.box(hl - 60, 12, -hw, hl, cy1, hw, P);
          M.box(hl - 2, 36, -hw + 2, hl, 60, hw - 2, GLASS); M.box(hl - 2, 36, -1, hl, 60, 1, P);
          sideWin(M, hl - 18, 38, hl - 4, 58, hw); sideWin(M, hl - 52, 38, hl - 36, 58, hw);
          sideMark(M, hl - 34, 14, hl - 33, 60, hw, VM.SEAM); sideMark(M, hl - 20, 14, hl - 19, 60, hw, VM.SEAM);
          M.box(hl - 60, 12, -hw, hl, 16, hw, VM.CHROME);
          sideMark(M, -hl, 30, hl, 33, hw, VM.WHITE);
          M.box(hl - 1, 18, -hw + 8, hl, 32, hw - 8, VM.CHROME); sym(M, hl - 1, 22, hw - 7, hl, 28, hw - 2, lit(LENS, VM.HEAD));
          M.box(hl - 1, 8, -hw + 1, hl + 3, 14, hw - 1, VM.CHROME);
          M.box(hl - 14, cy1, -hw + 3, hl - 8, cy1 + 3, hw - 3, VM.PLASTIC); M.box(hl - 14, cy1 + 1, -hw + 3, hl - 8, cy1 + 3, 0, lit(VM.BAR_RED, VM.RED)); M.box(hl - 14, cy1 + 1, 0, hl - 8, cy1 + 3, hw - 3, lit(VM.BAR_RED, VM.WHITE));
          sym(M, hl - 22, 44, hw, hl - 20, 54, hw + 3, VM.CHROME);
          // body: compartments with roll-up doors, hose bed, ladder on the roof
          M.box(-hl, 12, -hw, hl - 60, 56, hw, P);
          for (let x = -hl + 4; x < hl - 64; x += 22) { sideMark(M, x, 18, x + 18, 52, hw, VM.CHROME); for (let y = 20; y < 52; y += 4) sideMark(M, x, y, x + 18, y + 1, hw, VM.SILVER); }
          M.box(-hl, 56, -hw + 1, -hl + 40, 60, hw - 1, P); M.box(-hl + 2, 57, -hw + 3, -hl + 38, 60, hw - 3, -1); M.box(-hl + 2, 57, -hw + 3, -hl + 38, 58, hw - 3, VM.BEIGE);
          for (const z of [-hw + 6, hw - 8]) { M.box(-hl + 6, 60, z, hl - 16, 62, z + 2, VM.SILVER); }
          for (let x = -hl + 8; x < hl - 16; x += 8) M.box(x, 60, -hw + 6, x + 1, 61, hw - 6, VM.SILVER);
          sym(M, -hl - 1, 10, hw - 6, -hl + 1, 40, hw - 2, VM.CHROME);
          sym(M, -hl, 46, hw - 6, -hl + 1, 54, hw - 2, lit(VM.BAR_RED, VM.RED)); sym(M, -hl, 30, hw - 5, -hl + 1, 36, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
          const axF = hl - 26, axR = -hl + 42;
          arch(M, axF, r, hw, 8, 2 * r + 3); wheel(M, axF, r, hw - 1, 6, VM.CHROME);
          arch(M, axR, r, hw, 15, 2 * r + 3); wheel(M, axR, r, hw - 1, 6, VM.CHROME, true);
          M.box(-hl + 4, 4, -hw + 10, hl - 8, 12, hw - 10, VM.DARK_GREY);
          doors = null;
          break;
        }
        cab(M, cx0, hl - 1, 12, cy1, hw - 1, kind === 'rolloff_truck' || kind === 'garbage_truck' ? P : (o.paint != null ? o.paint : wpick([[VM.WHITE, 5], [VM.RED, 1], [VM.BLUE, 1], [VM.SILVER, 1]], hs(seed, 13))), 34, 6, o);
        M.box(hl - 2, 18, -hw + 10, hl - 1, 28, hw - 10, VM.PLASTIC);
        const axF = hl - 18;
        arch(M, axF, r, hw - 1, 8, 2 * r + 3); wheel(M, axF, r, hw - 2, 6, HUB);
        M.box(-hl + 4, 12, -hw + 8, cx0, 22, hw - 8, VM.DARK_GREY);                            // frame
        if (kind === 'box_truck') {
          const bx1 = cx0 - 2, top = 68;
          M.box(-hl, 20, -hw, bx1, top, hw, VM.WHITE);
          M.box(bx1 - 1, 56, -hw + 2, cx0 + 6, top - 2, hw - 2, VM.WHITE);                    // over-cab nose
          sideMark(M, -hl + 1, 21, bx1 - 1, 22, hw, VM.SEAM); sideMark(M, -hl + 1, top - 2, bx1 - 1, top - 1, hw, VM.SEAM);
          const band = wpick([[VM.RED, 2], [VM.BLUE, 2], [VM.GREEN, 1], [VM.ORANGE, 1], [VM.METRO_BLUE, 1], [0, 2]], hs(seed, 14));
          if (band) { sideMark(M, -hl + 4, 40, bx1 - 4, 50, hw, band); sideMark(M, -hl + 4, 37, bx1 - 4, 38, hw, band); }
          M.box(-hl, 22, -hw + 2, -hl + 1, top - 2, hw - 2, VM.SILVER);
          for (let y = 26; y < top - 2; y += 5) M.box(-hl, y, -hw + 2, -hl + 1, y + 1, hw - 2, VM.SEAM);
          M.box(-hl - 1, 14, -hw + 2, -hl + 1, 18, hw - 2, VM.PLASTIC);
          sym(M, -hl, 22, hw - 2, -hl + 1, 30, hw, lit(VM.TAIL_LIT, VM.TAIL));
          const axR = -hl + 32; arch(M, axR, r, hw, 15, 2 * r + 3); wheel(M, axR, r, hw - 1, 6, HUB, true);
          sideMark(M, -hl + 10, 18, -hl + 18, 20, hw, VM.AMBER);
          doors = null;
        } else if (kind === 'garbage_truck') {
          // rear loader: tall body tapering to a hopper with a packer blade, tailgate hinge at the top
          const A = lv.accent, bx1 = cx0 - 2, top = 70;
          M.box(-hl + 34, 22, -hw, bx1, top, hw, P);
          for (let x = -hl + 40; x < bx1 - 4; x += 14) sideMark(M, x, 24, x + 2, top - 2, hw, A === P ? VM.WHITE : A);
          sideMark(M, -hl + 34, 22, bx1, 26, hw, A);
          M.box(-hl + 6, 16, -hw + 1, -hl + 34, top - 4, hw - 1, A === P ? VM.SILVER : P);       // tailgate / hopper
          M.box(-hl, 16, -hw + 1, -hl + 6, 34, hw - 1, VM.SILVER);
          M.box(-hl, 24, -hw + 4, -hl + 4, 34, hw - 4, -1); M.box(-hl + 4, 24, -hw + 4, -hl + 5, 34, hw - 4, VM.PLASTIC);   // hopper mouth
          for (let y = 34; y < top - 4; y += 2) { const k = Math.round((y - 34) * 0.4); M.box(-hl, y, -hw + 1, -hl + 6 + k, y + 2, hw - 1, -1); M.box(-hl + 6 + k, y, -hw + 1, -hl + 7 + k, y + 2, hw - 1, A === P ? VM.SILVER : P); }
          sym(M, -hl + 30, 62, hw - 1, -hl + 36, 68, hw + 1, VM.DARK_GREY);                       // hinge
          sym(M, -hl - 2, 12, hw - 6, -hl + 1, 14, hw - 1, VM.DARK_GREY);                          // riding steps
          sym(M, -hl, 36, hw - 2, -hl + 1, 42, hw - 1, VM.DARK_GREY);                             // grab handles
          sym(M, -hl + 1, 18, hw - 1, -hl + 6, 22, hw, lit(VM.TAIL_LIT, VM.TAIL));
          M.box(bx1 - 4, top, -4, bx1 - 1, top + 2, 4, lit(VM.BAR_AMBER, VM.AMBER));
          for (const ax of [-hl + 40, -hl + 62]) { arch(M, ax, r, hw, 15, 2 * r + 3); wheel(M, ax, r, hw - 1, 6, HUB, true); }
          doors = null;
        } else {
          // roll-off hoist with a 20-yard container
          const bx1 = cx0 - 2;
          M.box(-hl + 2, 22, -hw + 6, bx1, 26, hw - 6, VM.DARK_GREY);
          sym(M, -hl + 6, 26, hw - 10, bx1 - 4, 28, hw - 8, VM.DARK_GREY);
          M.box(bx1 - 6, 26, -hw + 4, bx1 - 2, 50, hw - 4, VM.DARK_GREY);                         // headboard / hook arm
          const cc = o.container != null ? o.container : wpick([[VM.RED, 2], [VM.BLUE, 2], [VM.GREEN, 1], [VM.RUST, 1]], hs(seed, 15));
          rolloffBox(M, -hl + 2, bx1 - 8, 28, hw - 1, cc, seed);
          sym(M, -hl, 18, hw - 4, -hl + 1, 24, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
          for (const ax of [-hl + 30, -hl + 52]) { arch(M, ax, r, hw, 15, 2 * r + 3); wheel(M, ax, r, hw - 1, 6, HUB, true); }
          doors = null;
        }
        break;
      }
      case 'city_bus': case 'school_bus': {
        const school = kind === 'school_bus', L = school ? 220 : 240, W = school ? 48 : 50, hl = L >> 1, hw = W >> 1;
        const P = o.paint != null ? o.paint : lv.body, A = lv.accent;
        M = new VoxModel(L + 8, 72, W + 10, hl + 4, hw + 5);
        const r = 10, top = 62;
        const nose = school ? 26 : 0;
        M.box(-hl, 8, -hw, hl - nose, top, hw, P);
        M.box(-hl + 2, top, -hw + 2, hl - nose - 2, top + 2, hw - 2, school ? P : VM.WHITE);
        if (school) {
          // conventional nose, black rub rails, red / amber warning lamps, stop arm
          M.box(hl - nose, 10, -hw + 6, hl - 1, 34, hw - 6, P); M.box(hl - 2, 12, -hw + 9, hl, 32, hw - 9, VM.PLASTIC);
          M.box(hl - 1, 6, -hw + 2, hl + 2, 12, hw - 2, VM.BLACK);
          sym(M, hl - 2, 24, hw - 9, hl, 30, hw - 6, lit(LENS, VM.HEAD));
          sym(M, hl - nose - 22, 20, hw - 6, hl - 4, 32, hw - 2, P);
          M.box(hl - nose - 1, 34, -hw + 1, hl - nose + 1, top - 4, hw - 1, GLASS); M.box(hl - nose - 1, 34, -1, hl - nose + 1, top - 4, 1, P);
          for (const y of [16, 26, 33]) sideMark(M, -hl + 1, y, hl - nose, y + 1, hw, VM.BLACK);
          for (let x = -hl + 14; x < hl - nose - 22; x += 15) sideWin(M, x, 38, x + 12, 54, hw);
          sideWin(M, hl - nose - 18, 14, hl - nose - 4, 56, hw);                                 // entry door (right)
          M.box(hl - nose - 18, 14, hw - 1, hl - nose - 11, 56, hw, GLASS);
          sym(M, -hl, 56, hw - 8, -hl + 1, 60, hw - 4, lit(VM.BAR_RED, VM.RED)); sym(M, hl - nose - 1, 58, hw - 8, hl - nose + 1, 61, hw - 4, lit(VM.BAR_RED, VM.RED));
          M.box(hl - nose - 30, 40, -hw - 3, hl - nose - 22, 48, -hw, VM.RED);                    // stop arm (left side, folded)
          M.box(-hl, 20, -hw + 2, -hl + 1, 52, hw - 2, P); M.box(-hl, 38, -8, -hl + 1, 54, 8, GLASS); M.box(-hl, 20, -1, -hl + 1, 54, 1, VM.SEAM);
          sym(M, -hl, 22, hw - 5, -hl + 1, 30, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
          M.box(-hl - 1, 6, -hw + 2, -hl + 1, 12, hw - 2, VM.BLACK);
          sym(M, hl - nose - 4, 40, hw, hl - nose - 2, 52, hw + 3, VM.BLACK);
          const axF = hl - 18, axR = -hl + 64;
          arch(M, axF, r, hw, 8, 2 * r + 3); wheel(M, axF, r, hw - 1, 6, HUB);
          arch(M, axR, r, hw, 15, 2 * r + 3); wheel(M, axR, r, hw - 1, 6, HUB, true);
        } else {
          // low-floor transit bus: big windscreen, window band, front + middle doors, livery swoosh, destination sign
          M.box(hl - 2, 18, -hw + 2, hl, 56, hw - 2, GLASS); M.box(hl - 2, 52, -hw + 3, hl, 56, hw - 3, lit(VM.BAR_AMBER, VM.DARK_GREY));
          M.box(hl - 1, 6, -hw + 1, hl + 1, 14, hw - 1, VM.PLASTIC); sym(M, hl - 1, 12, hw - 7, hl, 16, hw - 2, lit(LENS, VM.HEAD));
          sideMark(M, -hl + 2, 30, hl - 2, 56, hw, GLASS);
          for (let x = -hl + 26; x < hl - 30; x += 24) sideMark(M, x, 30, x + 2, 56, hw, VM.PLASTIC);
          sideMark(M, -hl + 1, 22, hl - 1, 29, hw, A); sideMark(M, -hl + 1, 29, hl - 1, 30, hw, lv.stripe);
          sideWin(M, hl - 22, 10, hl - 6, 56, hw); sym(M, hl - 22, 10, hw - 1, hl - 15, 56, hw, GLASS);    // front door
          sideWin(M, 4, 10, 20, 56, hw); sym(M, 4, 10, hw - 1, 12, 56, hw, GLASS);
          M.box(-hl, 28, -hw + 3, -hl + 1, 50, hw - 3, GLASS); M.box(-hl, 14, -hw + 2, -hl + 1, 26, hw - 2, A);
          sym(M, -hl, 16, hw - 5, -hl + 1, 24, hw - 1, lit(VM.TAIL_LIT, VM.TAIL));
          M.box(-hl + 20, top + 2, -hw + 6, -hl + 60, top + 6, hw - 6, VM.SILVER);                 // A/C pod
          sym(M, hl - 4, 44, hw, hl - 2, 54, hw + 3, VM.PLASTIC);
          if (hs(seed, 16) < 0.6) { M.box(hl, 8, -8, hl + 3, 18, 8, VM.DARK_GREY); M.box(hl + 1, 10, -6, hl + 3, 12, 6, VM.SILVER); }   // bike rack
          const axF = hl - 34, axR = -hl + 56;
          arch(M, axF, r, hw, 8, 2 * r + 3); wheel(M, axF, r, hw - 1, 6, HUB);
          arch(M, axR, r, hw, 15, 2 * r + 3); wheel(M, axR, r, hw - 1, 6, HUB, true);
        }
        M.box(-hl + 6, 3, -hw + 10, hl - nose - 8, 8, hw - 10, VM.PLASTIC);
        break;
      }
      case 'semi': case 'semi_cab': case 'fuel_tanker': case 'tanker_cab': case 'semi_trailer': case 'tanker_trailer': {
        const tanker = kind.startsWith('fuel') || kind.startsWith('tanker');
        const hasCab = kind !== 'semi_trailer' && kind !== 'tanker_trailer', hasTr = kind !== 'semi_cab' && kind !== 'tanker_cab';
        const trL = tanker ? 240 : 260, cabL = 124, hw = tanker ? 25 : 26;
        const L = (hasCab ? cabL : 0) + (hasTr ? trL - (hasCab ? 24 : 0) : 0), hl = L >> 1;
        M = new VoxModel(L + 10, 88, 2 * hw + 12, hl + 5, hw + 6);
        const cabP = o.paint != null ? o.paint : wpick([[VM.WHITE, 3], [VM.RED, 2], [VM.BLUE, 2], [VM.BLACK, 2], [VM.SILVER, 1], [VM.GREEN, 1], [VM.MAROON, 1]], hs(seed, 17));
        let trFront = hl;
        if (hasCab) { const t = tractor(M, hl, hw, cabP, o, hs(seed, 18) < 0.6); trFront = hl - cabL + 24; void t; }
        if (hasTr) {
          const x0 = trFront - trL, x1 = trFront, r = 10;
          if (tanker) {
            // stainless tank: octagonal section, ribs, catwalk, placards, company stripe
            const cy = 46, R2 = 22;
            for (let k = 0; k < 4; ++k) { const a = [R2, R2 - 3, R2 - 7, R2 - 13][k], b = [R2 - 13, R2 - 7, R2 - 3, R2][k]; M.box(x0 + 2, cy - b, -a, x1 - 4, cy + b, a, VM.TANK); }
            for (let x = x0 + 30; x < x1 - 10; x += 44) for (let k = 0; k < 4; ++k) { const a = [R2, R2 - 3, R2 - 7, R2 - 13][k] + 1, b = [R2 - 13, R2 - 7, R2 - 3, R2][k] + 1; M.box(x, cy - b, -a, x + 2, cy + b, a, VM.SILVER); }
            M.box(x0 + 20, cy + R2, -3, x1 - 20, cy + R2 + 2, 3, VM.DARK_GREY);
            for (let x = x0 + 40; x < x1 - 30; x += 60) M.box(x, cy + R2 + 2, -3, x + 6, cy + R2 + 3, 3, VM.SILVER);
            const st = paints.liveries.fuel_tanker;
            sideMark(M, x0 + 30, cy - 2, x1 - 30, cy + 2, hw - 3, st.stripe); sideMark(M, x0 + 30, cy + 2, x1 - 30, cy + 3, hw - 3, st.accent);
            // hazmat diamond (stepped), rear + both sides
            for (const xc of [x0 + 18]) for (let k = 0; k < 4; ++k) sideMark(M, xc - 4 + k, cy - 10 + k, xc + 4 - k, cy - 9 + k, hw - 3, VM.RED), sideMark(M, xc - 4 + k, cy - 14 - k + 4, xc + 4 - k, cy - 13 - k + 4, hw - 3, VM.RED);
            M.box(x0 + 2, cy - 10, -4, x0 + 3, cy - 2, 4, VM.RED); M.box(x0 + 2, cy - 8, -2, x0 + 3, cy - 4, 2, VM.WHITE);
            M.box(x0 + 2, 12, -hw + 4, x1 - 10, cy - R2 + 4, hw - 4, VM.DARK_GREY);
            sym(M, x0 + 60, 14, hw - 6, x0 + 120, 22, hw - 2, VM.SILVER);                        // valve cabinets
          } else {
            M.box(x0, 22, -hw, x1, 80, hw, VM.WHITE);
            sideMark(M, x0 + 1, 22, x1 - 1, 24, hw, VM.SILVER); sideMark(M, x0 + 1, 78, x1 - 1, 80, hw, VM.SILVER);
            for (let x = x0 + 8; x < x1 - 4; x += 12) sideMark(M, x, 24, x + 1, 78, hw, VM.SEAM);
            const band = wpick([[0, 3], [VM.RED, 1], [VM.BLUE, 1], [VM.GREEN, 1], [VM.ORANGE, 1]], hs(seed, 19));
            if (band) sideMark(M, x0 + 20, 40, x1 - 20, 60, hw, band);
            M.box(x0, 24, -hw + 1, x0 + 1, 78, hw - 1, VM.SILVER); M.box(x0, 24, -1, x0 + 1, 78, 1, VM.SEAM);
            for (const y of [36, 52, 68]) M.box(x0, y, -hw + 2, x0 + 1, y + 1, hw - 2, VM.SEAM);
            sym(M, x0 + 40, 14, hw - 1, x0 + 120, 20, hw, VM.SEAM);                               // side skirts
            M.box(x0 + 40, 14, -hw, x0 + 120, 22, hw, VM.DARK_GREY);
            M.box(x0, 10, -hw + 4, x0 + 2, 22, hw - 4, VM.RED);                                    // ICC bumper
            sym(M, x1 - 60, 6, hw - 6, x1 - 58, 22, hw - 4, VM.DARK_GREY);                       // landing gear
          }
          sym(M, x0, 26, hw - 5, x0 + 1, 32, hw - 1, o.lights ? VM.TAIL_LIT : VM.TAIL);
          for (const ax of [x0 + 26, x0 + 48]) { arch(M, ax, r, hw, 15, 2 * r + 4); wheel(M, ax, r, hw - 1, 6, HUB, true); }
          if (!hasCab) M.box(x1 - 30, 20, -6, x1 - 2, 22, 6, VM.DARK_GREY);
        }
        break;
      }
      case 'rolloff': {
        M = new VoxModel(124, 34, 50, 62, 25);
        M.box(-58, 0, -20, 58, 2, -16, VM.DARK_GREY).box(-58, 0, 16, 58, 2, 20, VM.DARK_GREY);
        rolloffBox(M, -60, 60, 2, 23, o.paint != null ? o.paint : VM.RED, seed);
        break;
      }
      default: throw new Error('Vehicles: unknown kind ' + kind);
    }
    return { M, doors };
  }
  // roll-off container x0..x1 on y0, half width hw: ribbed sides, open top with debris, rear door
  function rolloffBox(M, x0, x1, y0, hw, col, seed) {
    const h = 26;
    M.box(x0, y0, -hw, x1, y0 + h, hw, col);
    for (let x = x0 + 8; x < x1 - 4; x += 9) M.box(x, y0 + 2, -hw - 1, x + 2, y0 + h, hw + 1, col === VM.RUST ? VM.RUST_DARK : VM.RUST);
    M.box(x0 + 3, y0 + h - 4, -hw + 3, x1 - 3, y0 + h, hw - 3, -1);
    M.box(x0 + 3, y0 + h - 5, -hw + 3, x1 - 3, y0 + h - 4, hw - 3, 70);
    const R = mulberry32(seed * 31 + 7), C = [100, 136, 70, 100, 58];
    for (let k = 0; k < 6; ++k) { const x = x0 + 6 + Math.floor(R() * (x1 - x0 - 26)), z = -hw + 4 + Math.floor(R() * (2 * hw - 16)); M.box(x, y0 + h - 4, z, x + 8 + Math.floor(R() * 10), y0 + h - 4 + 2 + Math.floor(R() * 4), z + 8, C[k % 5]); }
    M.box(x1, y0 + 4, -6, x1 + 1, y0 + h - 4, 6, VM.BUS_YELLOW); M.box(x0 - 1, y0 + 4, -6, x0, y0 + h - 4, 6, VM.BUS_YELLOW);
  }

  // ---------------------------------------------------------------------------------------------- states
  const isPaintish = (m) => m >= 160 && m <= 175 || m === VM.GARB_GREEN || m === VM.METRO_BLUE || m === VM.TEAL || m === VM.GOLD || m === VM.CREAM || m === 64;
  function forEach(M, f) { const { w, h, d, v } = M; for (let y = 0; y < h; ++y) for (let z = 0; z < d; ++z) for (let x = 0; x < w; ++x) { const i = (y * d + z) * w + x; if (v[i]) f(x, y, z, i, v[i] - 1); } }
  const exposed = (M, x, y, z) => !M.at(x + 1, y, z) || !M.at(x - 1, y, z) || !M.at(x, y + 1, z) || !M.at(x, y - 1, z) || !M.at(x, y, z + 1) || !M.at(x, y, z - 1);
  function bounds(M) {
    let x0 = 1e9, x1 = -1, y1 = -1, z0 = 1e9, z1 = -1, y0 = 1e9;
    forEach(M, (x, y, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; });
    return { x0, x1: x1 + 1, y0, y1: y1 + 1, z0, z1: z1 + 1 };
  }
  // smooth 3D value noise in [0,1), lattice cell s voxels (low frequency: coherent patches, no per-voxel speckle)
  function vnoise(x, y, z, s, seed) {
    const fx = x / s, fy = y / s, fz = z / s, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const sm = (t) => t * t * (3 - 2 * t), tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz);
    const h = (a, b2, c2) => hash2(ix + a, (iy + b2) * 7919 + iz + c2, seed);
    const l = (a, b2, t) => a + (b2 - a) * t;
    return l(l(l(h(0, 0, 0), h(1, 0, 0), tx), l(h(0, 1, 0), h(1, 1, 0), tx), ty), l(l(h(0, 0, 1), h(1, 0, 1), tx), l(h(0, 1, 1), h(1, 1, 1), tx), ty), tz);
  }
  function damage(M, o, seed) {
    const R = mulberry32(seed * 977 + 13), b = bounds(M), mid = M.d >> 1;
    const paintAt = (i) => M.v[i] && isPaintish(M.v[i] - 1);
    if (o.state === 'damaged') {
      // a few coherent dents (pushed-in panels) and long scrapes, one broken side window, a smashed headlight
      for (let k = 0; k < 3; ++k) {
        const w = 8 + Math.floor(R() * 8), hh = 4 + Math.floor(R() * 3), x = b.x0 + 8 + Math.floor(R() * (b.x1 - b.x0 - 16 - w)), y = b.y0 + 5 + Math.floor(R() * Math.max(1, (b.y1 - b.y0) * 0.35)), side = k % 2 === 0;
        for (let dx = 0; dx < w; ++dx) for (let dy = 0; dy < hh; ++dy) {
          if ((dx === 0 || dx === w - 1) && (dy === 0 || dy === hh - 1)) continue;           // rounded corners
          for (let zz = side ? b.z1 - 1 : b.z0, n = 0; n < 4; ++n, zz += side ? -1 : 1) { const i = ((y + dy) * M.d + zz) * M.w + x + dx; if (M.v[i]) { if (paintAt(i)) M.v[i] = 0; break; } }
        }
      }
      { const w = 18 + Math.floor(R() * 14), x = b.x0 + 6 + Math.floor(R() * (b.x1 - b.x0 - 12 - w)), y = b.y0 + 7 + Math.floor(R() * 4);
        for (let dx = 0; dx < w; ++dx) { const yy = y + Math.round(dx * 0.08); for (let zz = b.z1 - 1, n = 0; n < 4; ++n, --zz) { const i = (yy * M.d + zz) * M.w + x + dx; if (M.v[i]) { if (paintAt(i)) M.v[i] = VM.ASH + 1; break; } } } }
      const xg = b.x0 + Math.floor((b.x1 - b.x0) * (0.3 + R() * 0.3));
      forEach(M, (x, y, z, i, m) => { if (m === GLASS && Math.abs(x - xg) < 10 && z > mid) M.v[i] = VM.INTERIOR + 1; if ((m === VM.HEAD || m === LENS) && z < mid) M.v[i] = VM.PLASTIC + 1; });
      return;
    }
    if (o.state !== 'burnt') {
      // crashed / rolled: crumpled front (smooth, irregular depth), buckled hood, dark engine bay, glass
      // windscreen crazed white, side windows broken out in coherent areas
      const crush = Math.round((b.x1 - b.x0) * (o.state === 'rolled' ? 0.04 : 0.09));
      for (let y = 0; y < M.h; ++y) for (let z = 0; z < M.d; ++z) {
        const dz = Math.abs(z - mid) / mid, cut = crush + Math.round(vnoise(0, y, z, 7, seed) * 5) + Math.round(dz * dz * 4) - (y < 10 ? 2 : 0);
        for (let x = b.x1 - cut; x < b.x1; ++x) { const i = (y * M.d + z) * M.w + x; if (M.v[i]) { const m = M.v[i] - 1; if (m === VM.TYRE || m === HUB) continue; M.v[i] = 0; } }
      }
      let yTop = 0; const xr = b.x1 - crush - 10;
      for (let y = M.h - 1; y > 0 && !yTop; --y) if (M.at(xr, y, mid)) yTop = y;
      if (yTop && yTop < b.y1 - 6) for (let z = b.z0 + 4; z < b.z1 - 4; ++z) { const i = ((yTop + 1) * M.d + z) * M.w + xr; M.v[i] = M.v[(yTop * M.d + z) * M.w + xr]; M.v[i + 1] = M.v[i]; }
      forEach(M, (x, y, z, i, m) => { if (x >= b.x1 - crush - 8 && m !== VM.TYRE && m !== HUB && m !== GLASS && M.at(x + 1, y, z) === 0) M.v[i] = VM.INTERIOR + 1; });
      forEach(M, (x, y, z, i, m) => {
        if (m === GLASS) {
          const front = M.at(x + 1, y, z) === 0 && x > (b.x0 + b.x1) / 2;
          if (front) M.v[i] = VM.CRACK + 1; else if (vnoise(x, y, z, 12, seed + 7) > 0.5) M.v[i] = VM.INTERIOR + 1;
        }
        if (m === LENS || m === VM.TAIL_LIT || m === VM.BAR_RED || m === VM.BAR_BLUE || m === VM.BAR_AMBER) M.v[i] = VM.PLASTIC + 1;
      });
      return;
    }
    // burnt: tyres burnt away (the car sits on its rims), charcoal body, soft grey ash on the upper surfaces, a few
    // large rust-brown patches where the paint burnt off, no glass (black, recessed window openings)
    let drop = 0;
    if (M._wheels) {
      drop = 99;
      for (const w of M._wheels) {
        const rim = Math.max(2, Math.round(w.r * 0.4)) + 1;
        for (const s of [1, -1]) {
          const z0 = s > 0 ? w.zi : -w.zo, z1 = s > 0 ? w.zo : -w.zi;
          M.box(w.ax - w.r, 0, z0, w.ax + w.r, 2 * w.r, z1, -1);
          M.box(w.ax - rim, w.r - rim, z0, w.ax + rim, w.r + rim, z1, VM.RUST_DARK);
          M.box(w.ax - rim + 1, w.r - rim - 1, z0, w.ax + rim - 1, w.r + rim + 1, z1, VM.RUST_DARK);
        }
        drop = Math.min(drop, w.r - rim - 1);
      }
    }
    const g = [];
    forEach(M, (x, y, z, i, m) => { if (m === GLASS || m === VM.CRACK || m === VM.INTERIOR || m === VM.GLASS_TINT) g.push(i); });
    const yAsh = b.y0 + (b.y1 - b.y0) * 0.35;
    forEach(M, (x, y, z, i, m) => {
      if (m === GLASS || m === VM.CRACK || m === VM.INTERIOR || m === VM.GLASS_TINT) return;
      if (m === VM.RUST_DARK || m === VM.TYRE) { M.v[i] = (m === VM.TYRE ? VM.CHAR : VM.RUST_DARK) + 1; return; }
      const r = vnoise(x, y, z, 16, seed + 5);
      let c = VM.CHAR;
      if (y > yAsh && !M.at(x, y + 1, z) && vnoise(x, y, z, 10, seed + 9) > 0.3) c = VM.ASH;
      if (r > 0.8) c = VM.RUST; else if (r > 0.72) c = VM.RUST_DARK;
      M.v[i] = c + 1;
    });
    const kill = g.filter(i => { const x = i % M.w, z = Math.floor(i / M.w) % M.d, y = Math.floor(i / (M.w * M.d)); return exposed(M, x, y, z); });
    for (const i of g) M.v[i] = VM.TYRE + 1;
    for (const i of kill) M.v[i] = 0;
    if (drop > 0) { const s = drop * M.d * M.w; M.v.copyWithin(0, s); M.v.fill(0, M.v.length - s); }
  }
  // open doors: cars swing the front doors out (stepped at ~50 degrees); vans / ambulances open the rear doors flat
  function openDoors(M, dr, P) {
    if (!dr) return;
    if (dr.kind === 'car') {
      const d = dr.d, x0 = d.front[0], x1 = d.front[1], len = x1 - x0;
      for (const s of [1, -1]) {
        const zs = d.side, mats = [];
        for (let y = d.y0; y < d.y1; ++y) { const i = (y * M.d + (s > 0 ? zs - 1 : -zs) + M.oz) * M.w + x0 + 2 + M.ox; mats.push(M.v[i] ? M.v[i] - 1 : P); }
        M.box(x0, d.y0, s > 0 ? zs - 2 : -zs, x1, d.y1, s > 0 ? zs : -zs + 2, -1);
        M.box(x0, d.y0, s > 0 ? zs - 3 : -zs + 2, x1, d.y1, s > 0 ? zs - 2 : -zs + 3, VM.INTERIOR);
        // door leaf from the hinge (x1, zs) outwards and back: step 2 along, 2 out
        for (let k = 0; k < len; k += 2) {
          const x = x1 - Math.round(k * 0.64) - 2, z = zs + Math.round(k * 0.77);
          for (let y = d.y0; y < d.y1; ++y) { const m = mats[y - d.y0]; if (s > 0) M.box(x, y, z - 1, x + 2, y + 1, z + 1, m); else M.box(x, y, -z - 1, x + 2, y + 1, -z + 1, m); }
        }
      }
    } else if (dr.kind === 'rear') {
      const { x, y0, y1, hw } = dr;
      M.box(x, y0, -hw + 2, x + 2, y1, hw - 2, -1); M.box(x + 2, y0, -hw + 2, x + 3, y1, hw - 2, VM.INTERIOR);
      for (const s of [1, -1]) { const z0 = s > 0 ? hw : -hw - 2; M.box(x - hw + 2, y0, z0, x, y1, z0 + 2, P); M.box(x - hw + 4, y0 + 18, s > 0 ? hw + 2 : -hw - 3, x - 4, y1 - 4, s > 0 ? hw + 3 : -hw - 2, GLASS); }
    }
  }
  // rigid rotations about the x axis: 'side' (lying on its right side, wheels towards -z... i.e. sideways) or 'roof'
  function rollModel(M, mode) {
    const b = bounds(M), H = b.y1, D = M.d;
    const N = mode === 'side' ? new VoxModel(M.w, D, H + 2, M.ox, (H + 2) >> 1) : new VoxModel(M.w, H, D, M.ox, M.oz);
    forEach(M, (x, y, z, i, m) => {
      if (mode === 'side') { const Y = (D - 1 - z), Z = y + 1; N.v[(Y * N.d + Z) * N.w + x] = m + 1; }
      else { const Y = H - 1 - y, Z = D - 1 - z; N.v[(Y * N.d + Z) * N.w + x] = m + 1; }
    });
    // drop to the ground
    const nb = bounds(N);
    if (nb.y0 > 0) { const s = nb.y0 * N.d * N.w; N.v.copyWithin(0, s); N.v.fill(0, N.v.length - s); }
    return N;
  }

  const cache = new Map();
  function key(kind, o) { return [kind, o.paint == null ? '' : o.paint, o.seed | 0, o.state || 'ok', o.doors ? 1 : 0, o.lights ? 1 : 0, o.band == null ? '' : o.band, o.container == null ? '' : o.container].join('|'); }
  function model(kind, opts) {
    const o = opts || {}, k = key(kind, o);
    let r = cache.get(k);
    if (r) return r;
    const seed = o.seed | 0;
    const b0 = build(kind, o);
    let M = b0.M;
    if (o.doors && (o.state || 'ok') !== 'rolled') {
      const P = o.paint != null ? o.paint : (paints.liveries[kind] || {}).body || (INFO[kind].cls === 'car' ? paints.pick(seed) : VM.WHITE);
      openDoors(M, b0.doors, P);
    }
    if (o.state && o.state !== 'ok') damage(M, o, seed);
    if (o.state === 'rolled') {
      M = rollModel(M, INFO[kind].cls === 'car' && hs(seed, 20) < 0.5 ? 'roof' : 'side');
      if (hs(seed, 21) < 0.4) damage(M, { state: 'burnt' }, seed);
    }
    const b = bounds(M);
    r = { M, len: (b.x1 - b.x0) * PV, wid: (b.z1 - b.z0) * PV, h: b.y1 * PV,
      x0: (b.x0 - M.ox) * PV, x1: (b.x1 - M.ox) * PV, z0: (b.z0 - M.oz) * PV, z1: (b.z1 - M.oz) * PV, kind, key: k };
    cache.set(k, r);
    return r;
  }
  function mesh(kind, opts) {
    const r = model(kind, opts);
    if (!r.mesh) {
      // drop the faces lying on the ground (never seen)
      const m = meshVoxels3D(r.M), P = m.pos, keep = [];
      for (let q = 0; q < m.quads; ++q) { const k = q * 12; if (!(m.nrm[q * 4] === 5 && P[k + 1] < 1e-3 && P[k + 4] < 1e-3 && P[k + 7] < 1e-3 && P[k + 10] < 1e-3)) keep.push(q); }
      if (keep.length < m.quads) {
        const n = keep.length, pos = new Float32Array(n * 12), mat = new Uint8Array(n * 4), nrm = new Uint8Array(n * 4), idx = new Uint16Array(n * 6);
        keep.forEach((q, j) => { pos.set(P.subarray(q * 12, q * 12 + 12), j * 12); mat.set(m.mat.subarray(q * 4, q * 4 + 4), j * 4); nrm.set(m.nrm.subarray(q * 4, q * 4 + 4), j * 4); idx.set([j * 4, j * 4 + 1, j * 4 + 2, j * 4, j * 4 + 2, j * 4 + 3], j * 6); });
        r.mesh = { pos, mat, nrm, nvec: null, idx, quads: n };
      } else r.mesh = m;
    }
    return r;
  }
  // place into an emitter E.quad(p, q, r, s, mat, normal): nose direction dir 0..3 = -z, +z, -x, +x;
  // (x, z) = footprint centre, y = ground, scale = emitter units per metre; `fit` = [maxLen, maxWid] (m) scales it down
  const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  function emit(E, kind, opts, x, y, z, dir, scale, fit) {
    const r = mesh(kind, opts), m = r.mesh, P = m.pos;
    let s = scale;
    if (fit) s *= Math.min(1, fit[0] / r.len, fit[1] / r.wid);
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    // model +x -> world direction
    const F = [[0, -1], [0, 1], [-1, 0], [1, 0]][dir & 3], Rt = [-F[1], F[0]];   // model +z -> right of the nose
    const T = (k) => { const u = P[k] - cx, v = P[k + 2] - cz; return [x + (u * F[0] + v * Rt[0]) * s, y + P[k + 1] * s, z + (u * F[1] + v * Rt[1]) * s]; };
    let n = 0;
    for (let q = 0; q < m.quads; ++q) {
      const k = q * 12, nid = m.nrm[q * 4];
      if (nid === 5 && P[k + 1] < 1e-3 && P[k + 4] < 1e-3 && P[k + 7] < 1e-3 && P[k + 10] < 1e-3) continue;   // rests on the ground
      const N = NV[nid], Nw = [N[0] * F[0] + N[2] * Rt[0], N[1], N[0] * F[1] + N[2] * Rt[1]];
      E.quad(T(k), T(k + 3), T(k + 6), T(k + 9), m.mat[q * 4], Nw); ++n;
    }
    return n;
  }
  return { KINDS, INFO, paints, model, mesh, emit, VM, PALETTE: VEH_PALETTE, _cache: cache };
})();

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
  // curb loading / service-yard vehicles from the vehicle library (+x front, z centred, footprints <= 5.8 / 7.6 / 6.2 m)
  van: () => Vehicles.model('panel_van', { paint: VM.WHITE, seed: 3 }).M, vanBlue: () => Vehicles.model('panel_van', { paint: VM.BLUE, band: VM.WHITE, seed: 4 }).M,
  vanGrey: () => Vehicles.model('panel_van', { paint: VM.SILVER, band: VM.NAVY, seed: 6 }).M,
  truck: () => Vehicles.model('box_truck', { paint: VM.WHITE, seed: 2 }).M, truckBlue: () => Vehicles.model('box_truck', { paint: VM.BLUE, seed: 5 }).M,
  truckGreen: () => Vehicles.model('box_truck', { paint: VM.GREEN, seed: 8 }).M,
  rolloff: () => Vehicles.model('rolloff', { paint: VM.RED, seed: 1 }).M, rolloffBlue: () => Vehicles.model('rolloff', { paint: VM.BLUE, seed: 2 }).M,
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
    const b = ctx.box || net.bounds, step = 4;      // ctx.box: a streaming page's window (aligned to the bounds grid)
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
      ring.forEach((p) => {
        const k = Math.round((p.x - net.bounds.x0) / step) + Math.round((p.z - net.bounds.z0) / step);   // position-based: same from any box
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
  // ctx.box (streaming): only the roads / stretches within 12 m of the box (segment index), same order and spacing
  const SP = ctx.box ? roadSpans(net, ctx.box, 12) : null;
  ctx._spans = SP;
  const roadList = SP ? [...SP.keys()].map(id => net.roads[id]) : net.roads;
  for (const r of roadList) {
    const P = r.P;
    if (P.id === 'alley' || !r.len) continue;
    const SL = SP ? SP.get(r.id) : null, skipS = (s) => SL && !inSpans(SL, s, 1);
    const J = (r.junctions || []).filter(j => j.major);
    const nearJunction = (s, pad) => J.some(j => s > j.a - pad && s < j.b + pad);
    const frame = (s, u) => { const [px, pz, tx, tz] = pointAt(r, s); return [px + tz * u, pz - tx * u, tx, tz]; };
    // yaw such that local +z points from (x,z) towards the road centre and local +x along +t
    const yawFor = (tx, tz, side) => Math.atan2(side > 0 ? tx : -tx, side > 0 ? tz : -tz);
    // street lights
    const spacing = P.cls === 'arterial' ? 30 : P.cls === 'collector' ? 34 : 42;
    for (const side of [1, -1]) {
      for (let s = 10 + (side < 0 ? spacing / 2 : 0); s < r.len - 6; s += spacing) {
        if (skipS(s) || nearJunction(s, 9)) continue;
        const u = side * (P.half + 0.55);
        const [x, z, tx, tz] = frame(s, u);
        if (!okAt(x, z, r.id)) continue;
        // local +z must point back towards the road: the road centre is at -side * normal
        out.push({ type: 'lamp', x, y: hsM, z, yaw: yawTowards(x, z, frame(s, 0)), road: r.id });
      }
      if (P.median === 'planted') {
        const med = P.edges.find(e => e.type === 'median');
        for (let s = 18; s < r.len - 10; s += 36) {
          if (skipS(s) || nearJunction(s, 30)) continue;
          const [x, z, tx, tz] = frame(s, (med.left + med.right) / 2);
          if (side > 0 && okAt(x, z, r.id, 'median')) out.push({ type: 'lamp2', x, y: hsM, z, yaw: Math.atan2(tz, -tx), road: r.id });
        }
      }
      // hydrants
      for (let s = 20 + (side < 0 ? 40 : 0); s < r.len - 6; s += 85) {
        if (skipS(s) || nearJunction(s, 7)) continue;
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
        if (s < 2 || s > r.len - 2 || skipS(s)) continue;
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
  // nothing on a driveway curb cut or its wings: furniture keeps 0.8 m clear of them. A lamp or hydrant in the way
  // moves along the curb to just past the cut (if that spot is plain sidewalk of its street), the rest is dropped;
  // signal masts and stop signs belong to the junction and stay unless they stand on the cut itself
  if (R.cuts) {
    const hit = (x, z, pad) => R.cuts.find((c) => {
      const rx = x - c.ax, rz = z - c.az, t = rx * c.ux + rz * c.uz, d = rx * c.nx + rz * c.nz;
      return t > -CUT_FLARE - pad && t < c.len + CUT_FLARE + pad && d > -0.5 && d < c.depth + 0.8;
    });
    const keep = [];
    for (const p of out) {
      const junction = p.type.startsWith('signal') || p.type === 'stop';
      const c = hit(p.x, p.z, junction ? -CUT_FLARE : 0.8);
      if (!c) { keep.push(p); continue; }
      if (p.type !== 'lamp' && p.type !== 'hydrant') continue;
      const t = (p.x - c.ax) * c.ux + (p.z - c.az) * c.uz;
      for (const nt of (t < c.len / 2 ? [-CUT_FLARE - 1, c.len + CUT_FLARE + 1] : [c.len + CUT_FLARE + 1, -CUT_FLARE - 1])) {
        const x = p.x + (nt - t) * c.ux, z = p.z + (nt - t) * c.uz;
        if (Math.abs(nt - t) > 6.5 || hit(x, z, 0.8) || !okAt(x, z, p.road)) continue;
        keep.push(Object.assign({}, p, { x, z })); break;
      }
    }
    out.length = 0; out.push(...keep);
  }
  const BOXP = { bags1: [1.5, 0.65], bags2: [1.5, 0.65], bags3: [1.5, 0.65] };      // half extents (m) of wide piles, model frame
  if (ctx.footprints) {
    // drop furniture that would stand on a building, its stoop or entrance steps: within 2.4 m in front of
    // (or anywhere inside) a building footprint (footprints: origin O, axes e1 along / e2 into the lot, w x d metres)
    const keep = [];
    for (const p of out) {
      // stoops reach ~2.6 m, loading canopies / marquees ~2.5 m at 3-5 m height; lamp and signal arms swing
      // towards the road, so their posts only need to clear the canopy depth
      const infra = p.type === 'lamp' || p.type === 'lamp2' || p.type.startsWith('signal') || p.type === 'stop' || p.type === 'hydrant';
      const reach = infra ? 3.7 : 3.0;            // canopies / marquees reach up to ~3.6 m over the sidewalk
      let hit = false;
      for (const f of ctx.footprints) {
        const dx = p.x - f.O[0], dz = p.z - f.O[1];
        const a = dx * f.e1[0] + dz * f.e1[1], b = dx * f.e2[0] + dz * f.e2[1];
        const fr = (!infra && f.type === 'prewar_apartment') ? 8 : reach;      // entrance canopy on posts out to the curb
        if (a > -(infra ? reach : 0.6) && a < f.w + (infra ? reach : 0.6) && b > -fr && b < f.d + (infra ? reach : 0.3)) { hit = true; break; }
        // wide piles (bag piles, 2.9 x 1.2 m): their whole box clear of the building (a lot on a curved street can
        // bow out over a narrow stretch of sidewalk, past the centre-point test above; 0.6 m for bulkheads / sills in front)
        if (BOXP[p.type] && Math.abs(a - f.w / 2) < f.w / 2 + 3 && Math.abs(b - f.d / 2) < f.d / 2 + 3) {
          const [ex, ez] = BOXP[p.type], c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
          for (let i = -2; i <= 2 && !hit; ++i) for (let k = -2; k <= 2; ++k) {
            const lx = ex * i / 2, lz = ez * k / 2, qx = p.x + c * lx + sn * lz - f.O[0], qz = p.z - sn * lx + c * lz - f.O[1];
            const qa = qx * f.e1[0] + qz * f.e1[1], qb = qx * f.e2[0] + qz * f.e2[1];
            if (qa > -0.05 && qa < f.w + 0.05 && qb > -0.6 && qb < f.d + 0.05) { hit = true; break; }
          }
          if (hit) break;
        }
      }
      if (!hit) keep.push(p);
    }
    out.length = 0; out.push(...keep);
  }
  // nothing stands in the void past the edge of the ground (roads run on beyond the map bounds)
  {
    const b = net.bounds, big = /^(van|truck|rolloff|busstop)/;
    const keep = out.filter(p => { const m = big.test(p.type) ? 3 : 0.6; return p.x >= b.x0 + m && p.x <= b.x1 - m && p.z >= b.z0 + m && p.z <= b.z1 - m; });
    out.length = 0; out.push(...keep);
  }
  // nothing stands inside anything else: drop the later of two props whose posts are closer than 0.9 m
  {
    const keep2 = [], prio = (t) => (t === 'lamp' || t === 'lamp2' || t.startsWith('signal')) ? 0 : 1;
    const sorted = out.map((p, i) => [p, i]).sort((a, b) => prio(a[0].type) - prio(b[0].type) || a[1] - b[1]);
    const grid = new Map(), key = (x, z) => Math.floor(x / 2) + ',' + Math.floor(z / 2);
    for (const [p] of sorted) {
      let clash = false;
      for (let gx = -1; gx <= 1 && !clash; ++gx) for (let gz = -1; gz <= 1 && !clash; ++gz) {
        const L = grid.get(key(p.x + gx * 2, p.z + gz * 2));
        if (L) for (const q of L) if (Math.hypot(p.x - q.x, p.z - q.z) < 0.9) { clash = true; break; }
      }
      if (clash) continue;
      keep2.push(p);
      const k = key(p.x, p.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p);
    }
    out.length = 0; out.push(...keep2);
  }
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
  const SP = ctx._spans || null, SPF = SP && ctx.box ? roadSpans(net, ctx.box, 100) : null;     // streaming: roads near the box only
  const near = SPF ? net.roads.filter(r => SPF.has(r.id)) : net.roads;
  const urbanRoads = near.filter(r => (r.district === 'downtown' || r.district === 'oldtown') && r.P.id !== 'alley' && r.len);
  const urban = (x, z) => { for (const u of urbanRoads) if (distToPolyline([x, z], u.pts) < 60) return true; return false; };
  const alleys = near.filter(r => r.P.id === 'alley' && r.len);
  const offAlley = (x, z, r) => { for (const a of alleys) if (distToPolyline([x, z], a.pts) < a.P.half + 1.2 + r) return false; return true; };   // keep alley mouths clear
  const isWalk = (x, z, road) => { R.classify(x, z, o, cls); return o.road === road && (cls[1] === MAT.SIDEWALK || cls[1] === MAT.SIDEWALK_JOINT); };
  let n = 0;
  for (const r of SP ? [...SP.keys()].map(id => net.roads[id]) : net.roads) {
    const P = r.P;
    if (P.id === 'alley' || !r.len || !P.sidewalk) continue;
    if (r.district === 'residential') continue;
    const SL = SP ? SP.get(r.id) : null;
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
      if (SL && !inSpans(SL, s, 1)) return false;
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
          if ((SL && !inSpans(SL, s, 1)) || nearJ(s, 14)) continue;
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
    for (const r of SP ? [...SP.keys()].map(id => net.roads[id]) : net.roads) {
      const P = r.P;
      if (P.id === 'alley' || !r.len || !P.sidewalk || r.district === 'residential') continue;
      const J = (r.junctions || []).filter(j => j.major), SL = SP ? SP.get(r.id) : null;
      for (const side of [1, -1]) {
        const cand = [];
        for (let s = 3; s < r.len - 3; s += 1.5) {
          if (SL && !inSpans(SL, s, 40)) continue;
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

Object.assign(PROP_PALETTE, VEH_PALETTE);
// rural ground (city_core GROUND): crop green, furrow, wheat, forest floor, water, farmyard gravel
Object.assign(PROP_PALETTE, { 202: [112, 146, 74], 203: [128, 104, 78], 204: [204, 182, 116], 205: [86, 100, 66], 206: [76, 114, 138], 207: [166, 156, 138] });
const CityCore = { parkLayouts, parkAt, parkGround, parkPathDist, PARK_GROUND, PG, WATER, waterSD, bankY, bridgePlan, bridgeAt, waterColumn, roadIndex, roadSpans, inSpans, Vehicles, VM, chunkGrid, chunksForCuts, CUT_FLARE, pointAt, chamfer, PV, PM, PROP_PALETTE, PROP_TYPES, buildPropMeshes, placeProps, meshVoxels3D, VoxModel, PROFILES, MAT, MAT_NAMES, PALETTE, generateCity, growOutskirts, ringGeom, landUseAt, ruralGround, ruralParcel, isRural, forestNoise, inFarm, lakeR, GROUND, generateTestArea, FieldSampler, Rasterizer, Plots, meshColumns, MeshBuffer, prepareBuild, buildChunk, buildBlocks, buildCity, runSync, findJunctions, exportNetwork, hash2, mulberry32 };
if (typeof module !== 'undefined' && module.exports) module.exports = CityCore; else root.CityCore = CityCore;
})(typeof self !== 'undefined' ? self : this);
