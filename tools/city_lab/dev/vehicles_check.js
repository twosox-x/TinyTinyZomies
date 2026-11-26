// Parked-vehicle clearance check: lists vehicles that overlap each other or other geometry.
//   node --max-old-space-size=8000 tools/city_lab/dev/vehicles_check.js [seed] [--list=N] [--tol=0.05]
// Vehicles in the building mesh (parking lots, driveways, service yards: everything made of the vehicle palette
// 160..201, see CityCore.Vehicles) are clustered into connected parts; curb vehicles (street furniture van* / truck* /
// rolloff*) come from placeProps. Each vehicle gets an oriented box (from its faces' normals); reported:
//   - vehicle-vehicle: two boxes overlap by more than tol, or one cluster is too long to be a single vehicle (touching)
//   - vehicle-geometry: a non-vehicle face (wall, fence, planter, pump, sign...) passes through a vehicle's box
//     shrunk by tol, above the ground it stands on
const MC = require('./meshcheck.js');
const C = require(__dirname + '/../city_core.js');
const args = process.argv.slice(2);
const seed = +(args.find(a => /^\d+$/.test(a)) || 1);
const LIST = +((args.find(a => a.startsWith('--list=')) || '--list=40').slice(7));
const TOL = +((args.find(a => a.startsWith('--tol=')) || '--tol=0.05').slice(6));
const B = MC.build(seed, { props: true });
const mb = B.raw, P = mb.pos, N = mb.nvec, U = 0.1;                       // positions in 0.1 m units
const isVeh = (m) => m >= 160 && m <= 201;
const nq = mb.quads;
// ---- cluster vehicle quads (union-find on AABBs closer than 8 cm: wheels sit 5 cm inside their arches)
const vq = [];
for (let q = 0; q < nq; ++q) if (isVeh(mb.mat[q * 4])) vq.push(q);
const box = (q) => { const o = q * 12; let a = [1e9, 1e9, 1e9], b = [-1e9, -1e9, -1e9]; for (let k = 0; k < 4; ++k) for (let c = 0; c < 3; ++c) { const v = P[o + k * 3 + c] * U; if (v < a[c]) a[c] = v; if (v > b[c]) b[c] = v; } return [a, b]; };
// each quad's frame angle (mod 90 deg): vehicles are axis-aligned in their own frame, so clustering is done per frame
// angle with boxes in that frame (world AABBs of rotated quads overlap between neighbours)
const frameOf = (q) => { const o = q * 12; let ang; if (Math.abs(N[o + 1]) < 0.5) ang = Math.atan2(N[o + 2], N[o]); else { const dx = P[o + 3] - P[o], dz = P[o + 5] - P[o + 2], ex = P[o + 9] - P[o], ez = P[o + 11] - P[o + 2]; ang = Math.hypot(dx, dz) > Math.hypot(ex, ez) ? Math.atan2(dz, dx) : Math.atan2(ez, ex); } let d = ang * 180 / Math.PI % 90; if (d < 0) d += 90; if (d > 89.875) d -= 90; return Math.round(d * 4) / 4; };
const boxF = (q, th) => { const o = q * 12, cs = Math.cos(th * Math.PI / 180), sn = Math.sin(th * Math.PI / 180); let a = [1e9, 1e9, 1e9], b = [-1e9, -1e9, -1e9]; for (let k = 0; k < 4; ++k) { const X = P[o + k * 3] * U, Y = P[o + k * 3 + 1] * U, Z = P[o + k * 3 + 2] * U, v = [X * cs + Z * sn, Y, -X * sn + Z * cs]; for (let c = 0; c < 3; ++c) { if (v[c] < a[c]) a[c] = v[c]; if (v[c] > b[c]) b[c] = v[c]; } } return [a, b]; };
const par = new Int32Array(vq.length).map((_, i) => i);
const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
const G = new Map(), CS = 1.0, key = (x, z) => x * 100003 + z;
const th = vq.map(frameOf), bx = vq.map((q, i) => boxF(q, th[i]));
vq.forEach((q, i) => { const [a, b] = bx[i]; for (let x = Math.floor(a[0] / CS); x <= Math.floor(b[0] / CS); ++x) for (let z = Math.floor(a[2] / CS); z <= Math.floor(b[2] / CS); ++z) { const k = key(x, z) + th[i] * 1e12; let l = G.get(k); if (!l) G.set(k, l = []); for (const j of l) { const [c, d] = bx[j]; if (a[0] <= d[0] + 0.08 && c[0] <= b[0] + 0.08 && a[1] <= d[1] + 0.08 && c[1] <= b[1] + 0.08 && a[2] <= d[2] + 0.08 && c[2] <= b[2] + 0.08) par[find(i)] = find(j); } l.push(i); } });
const cl = new Map();
vq.forEach((q, i) => { const r = find(i); let c = cl.get(r); if (!c) cl.set(r, c = []); c.push(i); });
// ---- oriented boxes
const vehicles = [];
const SEG = MC.segments(B.res);
for (const idx of cl.values()) {
  // axis from the largest horizontal-normal faces
  let best = 0, ang = 0;
  for (const i of idx) { const q = vq[i], nx = N[q * 12], nz = N[q * 12 + 2]; if (Math.abs(N[q * 12 + 1]) > 0.5) continue; const [a, b] = bx[i]; const ar = Math.hypot(b[0] - a[0], b[2] - a[2]) * (b[1] - a[1]); if (ar > best) { best = ar; ang = Math.atan2(nz, nx); } }
  const ex = [Math.cos(ang), Math.sin(ang)], ez = [-ex[1], ex[0]];
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const i of idx) { const o = vq[i] * 12; for (let k = 0; k < 4; ++k) { const x = P[o + k * 3] * U, y = P[o + k * 3 + 1] * U, z = P[o + k * 3 + 2] * U, u = x * ex[0] + z * ex[1], v = x * ez[0] + z * ez[1]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (u1 - u0 < v1 - v0) { [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; const t = ex.slice(); ex[0] = ez[0]; ex[1] = ez[1]; ez[0] = -t[0]; ez[1] = -t[1]; }
  const c = [((u0 + u1) / 2) * ex[0] + ((v0 + v1) / 2) * ez[0], ((u0 + u1) / 2) * ex[1] + ((v0 + v1) / 2) * ez[1]];
  const q0 = Math.min(...idx.map(i => vq[i]));
  const sg = SEG.list.find(s => q0 >= s.q0 && q0 < s.q1);
  const src = sg ? (sg.info.kind === 'houses' ? 'yard' : (sg.info.type || sg.info.kind || sg.id)) : 'extra';
  vehicles.push({ src, c, ex, ez, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2, y0, y1, n: idx.length, tiny: (u1 - u0) < 0.5 && (v1 - v0) < 0.5 });
}
// curb vehicles (instanced street furniture)
const VK = { van: 1, vanBlue: 1, vanGrey: 1, truck: 1, truckBlue: 1, truckGreen: 1, rolloff: 1, rolloffBlue: 1 };
const PM = C.buildPropMeshes();
for (const p of B.props || []) {
  if (!VK[p.type]) continue;
  const m = PM[p.type], Q = m.pos; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, h = 0;
  for (let i = 0; i < Q.length; i += 3) { x0 = Math.min(x0, Q[i]); x1 = Math.max(x1, Q[i]); z0 = Math.min(z0, Q[i + 2]); z1 = Math.max(z1, Q[i + 2]); h = Math.max(h, Q[i + 1]); }
  // prop yaw: model +x -> world (cos yaw, -sin yaw) (three.js rotation about y)
  const ex = [Math.cos(p.yaw), -Math.sin(p.yaw)], ez = [Math.sin(p.yaw), Math.cos(p.yaw)];
  const cu = (x0 + x1) / 2, cv = (z0 + z1) / 2;
  vehicles.push({ src: 'curb:' + p.type, c: [p.x + cu * ex[0] + cv * ez[0], p.z + cu * ex[1] + cv * ez[1]], ex, ez, hl: (x1 - x0) / 2, hw: (z1 - z0) / 2, y0: B.groundY ? 0 : 0, y1: h, n: 0, curb: true });
}
// ---- vehicle-vehicle (2D SAT on footprints, shrunk by TOL)
const overlapOBB = (a, b) => {
  if (a.y1 <= b.y0 + 0.05 || b.y1 <= a.y0 + 0.05) return false;
  for (const ax of [a.ex, a.ez, b.ex, b.ez]) {
    const pr = (o) => Math.abs(o.ex[0] * ax[0] + o.ex[1] * ax[1]) * (o.hl - TOL) + Math.abs(o.ez[0] * ax[0] + o.ez[1] * ax[1]) * (o.hw - TOL);
    const d = Math.abs((a.c[0] - b.c[0]) * ax[0] + (a.c[1] - b.c[1]) * ax[1]);
    if (d > pr(a) + pr(b)) return false;
  }
  return true;
};
const issues = [];
const VG = new Map();
vehicles.forEach((v, i) => { const r = Math.hypot(v.hl, v.hw); for (let x = Math.floor((v.c[0] - r) / 4); x <= Math.floor((v.c[0] + r) / 4); ++x) for (let z = Math.floor((v.c[1] - r) / 4); z <= Math.floor((v.c[1] + r) / 4); ++z) { const k = key(x, z); let l = VG.get(k); if (!l) VG.set(k, l = []); l.push(i); } });
const seen = new Set();
for (const l of VG.values()) for (let a = 0; a < l.length; ++a) for (let b = a + 1; b < l.length; ++b) {
  const i = l[a], j = l[b], k = i * 1e6 + j; if (seen.has(k)) continue; seen.add(k);
  if (vehicles[i].tiny || vehicles[j].tiny) continue;
  if (overlapOBB(vehicles[i], vehicles[j])) issues.push(['vehicle-vehicle', vehicles[i], vehicles[j]]);
}
for (const v of vehicles) if (!v.curb && (v.hl > 9.2 || v.hw > 1.6)) issues.push(['merged (touching vehicles?)', v]);
// ---- vehicle-geometry: non-vehicle quads crossing a vehicle box (above its ground)
const SHARED = new Set([57, 130, 64, 70, 100, 136, 58]);           // lens, hub, plate, debris: shared with props, may sit inside a vehicle
let geo = 0;
const hitV = new Map();
for (let q = 0; q < nq; ++q) {
  const m = mb.mat[q * 4]; if (isVeh(m)) continue;
  const [a, b] = box(q);
  const cand = new Set();
  for (let x = Math.floor(a[0] / 4); x <= Math.floor(b[0] / 4); ++x) for (let z = Math.floor(a[2] / 4); z <= Math.floor(b[2] / 4); ++z) { const l = VG.get(key(x, z)); if (l) for (const i of l) cand.add(i); }
  if (!cand.size) continue;
  for (const i of cand) {
    const v = vehicles[i]; if (v.curb || v.tiny) continue;
    if (b[1] < v.y0 + 0.12 || a[1] > v.y1 - 0.02) continue;
    // sample the quad
    const o = q * 12, p0 = [P[o], P[o + 1], P[o + 2]].map(t => t * U), p1 = [P[o + 3], P[o + 4], P[o + 5]].map(t => t * U), p3 = [P[o + 9], P[o + 10], P[o + 11]].map(t => t * U);
    const nu = Math.min(40, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / 0.1)), nv = Math.min(40, Math.ceil(Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]) / 0.1));
    let hit = false;
    for (let s = 0; s <= nu && !hit; ++s) for (let t = 0; t <= nv && !hit; ++t) {
      const fx = s / nu, fy = t / nv, X = p0[0] + (p1[0] - p0[0]) * fx + (p3[0] - p0[0]) * fy, Y = p0[1] + (p1[1] - p0[1]) * fx + (p3[1] - p0[1]) * fy, Z = p0[2] + (p1[2] - p0[2]) * fx + (p3[2] - p0[2]) * fy;
      if (Y < v.y0 + 0.12 || Y > v.y1 - 0.02) continue;
      const du = (X - v.c[0]) * v.ex[0] + (Z - v.c[1]) * v.ex[1], dv = (X - v.c[0]) * v.ez[0] + (Z - v.c[1]) * v.ez[1];
      if (Math.abs(du) < v.hl - TOL && Math.abs(dv) < v.hw - TOL) hit = true;
    }
    if (hit && !SHARED.has(m)) { const l = hitV.get(i) || []; l.push(m); hitV.set(i, l); }
  }
}
for (const [i, l] of hitV) { issues.push(['vehicle-geometry', vehicles[i], null, l]); geo++; }
const f = (v) => `${v.src} at (${v.c[0].toFixed(1)}, ${v.c[1].toFixed(1)}) ${(2 * v.hl).toFixed(2)} x ${(2 * v.hw).toFixed(2)} m`;
const bySrc = {}; for (const v of vehicles) if (!v.tiny) bySrc[v.src] = (bySrc[v.src] || 0) + 1;
console.log(JSON.stringify(bySrc));
console.log(`seed ${seed}: ${vehicles.filter(v => !v.curb && !v.tiny).length} mesh vehicles, ${vehicles.filter(v => v.curb).length} curb vehicles, ${issues.length} issues`);
for (const it of issues.slice(0, LIST)) console.log(' ', it[0] + ':', f(it[1]), it[2] ? ' <-> ' + f(it[2]) : '', it[3] ? ' materials ' + [...new Set(it[3])].join(',') : '');
process.exitCode = issues.length ? 1 : 0;
