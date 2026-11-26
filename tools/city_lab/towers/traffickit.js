// Traffic kit: the abandoned city after the evacuation. Static vehicle scenes on the roads, GPU-instanced.
//
// CityArch.lib.trafficKit(K) -> stats      (called from buildAll after every other part, just before the cull pass)
//   K = { PL, C, R, jobs, hs, voxel }. Nothing is emitted into the building mesh: stats.out holds
//   { variants: [{ key, kind, n, bb, hi: {pos (m), mat, nrm, quads}, lo: {...} | null }], M (Float32Array, 12 per
//   instance: 3x4 row-major model -> world transform, metres), vid (Uint16Array variant), paint (Uint8Array body
//   paint palette id, 0 = keep), obb (Float32Array, 8 per instance: x, z, hx, hz, cos, sin, y0, y1), count, paintPH }.
//   buildAll moves it to res.traffic; the worker posts it; city_lab.html draws one InstancedMesh per variant (hi near the
//   camera, lo = 20 cm resample far away). Body-paint faces carry the placeholder material paintPH (VM.BROWN), which
//   the shader swaps for the instance paint.
//
// 1. Roads leaving the map: every lane is an outbound queue facing the exit (a roadblock thins it past its line).
// 2. Arterials / collectors: congested both ways (heavier outbound, the core lighter); downtown keeps one lane empty
//    and a gap every 4 cars. Junction boxes are always clear.
// 3. Parking lanes: bumper to bumper on every street. 4. Local streets: stalled / abandoned / some wrecked cars.
// 5. Set pieces (6-10): tanker rollovers, overturned garbage trucks, bus crashes, police roadblocks, ambulance
//    clusters, a jackknifed semi. ~120-165 small incidents (pile-ups, cars into lamps / hydrants, burnt wrecks,
//    ambulances, delivery vans, police stops, sidewalk cars, abandoned cars with luggage). No ground decals.
// 6. Placement: exact oriented-box tests (separating axes) against every placed vehicle / prop (>= 0.15 m), building
//    footprints (+0.3 m; sidewalk cars keep off the stoop zone), street furniture footprints from the prop meshes
//    (parts below 2 m for cars, below 4.4 m for tall vehicles; placeProps evaluated with the final footprints and
//    cuts), plus road-surface sampling (carriageway at road height, never curb / gutter / median / driveway / alley)
//    and the world bounds minus 3 m. dev/traffic_check.js re-checks the output independently.
// Deterministic per seed.
(function () {
'use strict';
const A = self.CityArch, L = A.lib;
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const M = {
  TIRE: 59, RIM: 130, GLASS: 147, HEAD: 57, TAIL: 60, AMBER: 61, BUMPER: 55, CHROME: 99, BLACK: 58, BURNT: 156, RUST: 72,
  WHITE: 64, SILVER: 108, GREY: 99, RED: 95, BRED: 63, NAVY: 105, LBLUE: 82, BLUE: 139, GREEN: 103, BEIGE: 81, YELLOW: 132,
  MAROON: 72, DGREEN: 126, ORANGE: 68, CREAM: 157, CONC: 109, CARD: 100, BAG: 58, BAG_G: 137, SPILL: 201, SCORCH: 59,
  LUG1: 105, LUG2: 95, LUG3: 143, DEBRIS: 156, STEEL: 130
};
const PAINTS = [M.WHITE, M.WHITE, M.SILVER, M.SILVER, M.GREY, M.BLACK, M.RED, M.NAVY, M.LBLUE, M.GREEN, M.BEIGE, M.MAROON, M.BLUE, M.CREAM];
const hashS = (s) => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const pickW = (R, tab) => { let t = 0; for (const k in tab) t += tab[k]; let x = R() * t; for (const k in tab) { x -= tab[k]; if (x <= 0) return k; } return Object.keys(tab)[0]; };

// ------------------------------------------------------------------------------------------ fallback vehicle models
// 12.5 cm voxels, origin at the centre of the footprint, +x = front, y = 0 = ground.
const VS = 0.125;
const DIMS = {   // len, wid, h (m)
  sedan: [4.75, 1.85, 1.45], hatchback: [4.1, 1.78, 1.5], coupe: [4.5, 1.82, 1.32], suv: [4.9, 1.97, 1.8], pickup: [5.6, 2.0, 1.85],
  minivan: [5.1, 1.97, 1.78], taxi: [4.75, 1.85, 1.6], police: [4.9, 1.9, 1.62], ambulance: [6.6, 2.3, 2.8], fire_engine: [10.0, 2.5, 3.2],
  city_bus: [12.0, 2.55, 3.1], school_bus: [11.0, 2.45, 3.0], panel_van: [5.6, 2.0, 2.35], box_truck: [7.8, 2.45, 3.3],
  garbage_truck: [9.0, 2.5, 3.4], fuel_tanker: [12.5, 2.5, 3.3], semi: [16.0, 2.55, 3.9], delivery_van: [6.2, 2.2, 2.75]
};
function fallbackModel(C, kind, o) {
  const [lm, wm, hm] = DIMS[kind] || DIMS.sedan;
  const Lv = Math.round(lm / VS), Wv = Math.round(wm / VS), Hv = Math.round(hm / VS);
  const lh = Lv >> 1, wh = Wv >> 1, door = o.doors ? 8 : 0;
  const Vm = new C.VoxModel(Lv + 2 + (o.doors === 'rear' ? 8 : 0), Hv + 2, Wv + 2 * door + 2, lh + 1, wh + door + 1);
  const R = C.mulberry32(o.seed >>> 0);
  const paint = o.paint, x0 = -lh, x1 = Lv - lh, z0 = -wh, z1 = Wv - wh;
  const B = (a, b, c, d, e, f, m) => Vm.box(a, b, c, d, e, f, m);
  const wheels = (xs, r) => { for (const x of xs) { B(x - r, 0, z0, x + r, 2 * r - 1, z0 + 2, M.TIRE); B(x - r, 0, z1 - 2, x + r, 2 * r - 1, z1, M.TIRE); B(x - 1, 1, z0 - 0, x + 1, 2 * r - 2, z0 + 1, M.RIM); B(x - 1, 1, z1 - 1, x + 1, 2 * r - 2, z1, M.RIM); } };
  const lightsF = (y0, y1) => { B(x1 - 1, y0, z0 + 1, x1, y1, z0 + 3, M.HEAD); B(x1 - 1, y0, z1 - 3, x1, y1, z1 - 1, M.HEAD); };
  const lightsR = (y0, y1) => { B(x0, y0, z0 + 1, x0 + 1, y1, z0 + 3, M.TAIL); B(x0, y0, z1 - 3, x0 + 1, y1, z1 - 1, M.TAIL); };
  const car = ['sedan', 'hatchback', 'coupe', 'suv', 'pickup', 'minivan', 'taxi', 'police'].includes(kind);
  let doorXs = [];
  if (car) {
    const tall = kind === 'suv' || kind === 'minivan' || kind === 'pickup';
    const beltY = tall ? 8 : 6, roofY = Hv;
    // cabin span
    let c0 = x0 + 9, c1 = x1 - 12;
    if (kind === 'hatchback' || kind === 'suv' || kind === 'minivan') c0 = x0 + 2;
    if (kind === 'minivan') c1 = x1 - 8;
    if (kind === 'pickup') { c0 = -3; c1 = x1 - 13; }
    if (kind === 'coupe') { c0 = x0 + 10; c1 = x1 - 13; }
    B(x0, 2, z0, x1, beltY, z1, paint);                                 // body
    B(x0 + 1, beltY, z0, x0 + 4, beltY + 1, z1, paint);                  // trunk lip
    B(x0, 2, z0, x0 + 1, 3, z1, M.BUMPER); B(x1 - 1, 2, z0, x1, 3, z1, M.BUMPER);
    B(c0, beltY, z0 + 1, c1, roofY - 1, z1 - 1, M.GLASS);                // greenhouse
    B(c0 + 1, roofY - 1, z0 + 1, c1 - 1, roofY, z1 - 1, paint);          // roof
    for (const px of [c0, c1 - 1, (c0 + c1) >> 1]) B(px, beltY, z0 + 1, px + 1, roofY, z1 - 1, paint);   // pillars
    B(c1, beltY, z0 + 1, c1 + 2, beltY + 1, z1 - 1, M.GLASS);            // windscreen rake
    if (kind === 'pickup') { B(x0, beltY, z0, c0 - 1, beltY + 2, z0 + 1, paint); B(x0, beltY, z1 - 1, c0 - 1, beltY + 2, z1, paint); B(x0, beltY, z0, x0 + 1, beltY + 2, z1, paint); B(x0 + 1, beltY - 1, z0 + 1, c0 - 1, beltY, z1 - 1, M.BUMPER); }
    wheels([x0 + 7, x1 - 7], 3);
    lightsF(4, 5); lightsR(4, 6);
    if (kind === 'taxi') { B(-2, roofY, -2, 2, roofY + 1, 2, M.CREAM); }
    if (kind === 'police') {
      B(-6, 2, z0, 7, beltY, z0 + 1, M.WHITE); B(-6, 2, z1 - 1, 7, beltY, z1, M.WHITE);
      B(-1, roofY, z0 + 2, 2, roofY + 1, 0, M.BRED); B(-1, roofY, 0, 2, roofY + 1, z1 - 2, M.BLUE);
    }
    doorXs = [[c1 - 1 - 8, c1 - 1], [((c0 + c1) >> 1) - 7, (c0 + c1) >> 1]];
  } else if (kind === 'city_bus' || kind === 'school_bus') {
    const school = kind === 'school_bus';
    const body = school ? M.YELLOW : paint;
    const nose = school ? 10 : 0;
    B(x0, 2, z0, x1 - nose, Hv, z1, body);
    if (nose) { B(x1 - nose, 2, z0 + 1, x1, 10, z1 - 1, body); B(x1 - 1, 3, z0 + 1, x1, 5, z1 - 1, M.BUMPER); }
    B(x0 + 3, 12, z0, x1 - nose - 6, 19, z0 + 1, M.GLASS); B(x0 + 3, 12, z1 - 1, x1 - nose - 6, 19, z1, M.GLASS);
    for (let x = x0 + 9; x < x1 - nose - 6; x += 9) { B(x, 12, z0, x + 1, 19, z0 + 1, body); B(x, 12, z1 - 1, x + 1, 19, z1, body); }
    B(x1 - nose - 1, 10, z0 + 1, x1 - nose, Hv - 3, z1 - 1, M.GLASS);
    B(x0, 9, z0, x1 - nose, 10, z0 + 1, school ? M.BLACK : M.WHITE); B(x0, 9, z1 - 1, x1 - nose, 10, z1, school ? M.BLACK : M.WHITE);
    B(x0 + 4, Hv, z0 + 3, x0 + 16, Hv + 1, z1 - 3, M.GREY);
    wheels([x0 + 12, x1 - nose - 10], 4);
    lightsF(4, 6); lightsR(5, 8);
    doorXs = [];
  } else {
    // cab-forward / van family: cab + body
    let cabL = 14, bodyH = Hv, cabH = Math.min(Hv, 22), bodyM = paint, cabM = paint;
    if (kind === 'panel_van' || kind === 'delivery_van' || kind === 'ambulance') { cabL = 10; cabH = Hv; }
    if (kind === 'semi') { cabL = 22; cabH = 27; bodyM = M.WHITE; }
    if (kind === 'garbage_truck') { bodyM = M.DGREEN; cabM = M.WHITE; }
    if (kind === 'fuel_tanker') { bodyM = M.CREAM; cabM = paint; }
    if (kind === 'fire_engine') { bodyM = M.BRED; cabM = M.BRED; cabL = 18; }
    if (kind === 'ambulance') { bodyM = M.WHITE; cabM = M.WHITE; }
    const cx = x1 - cabL;
    // cab
    B(cx, 2, z0, x1, cabH - 2, z1, cabM);
    B(cx + 1, cabH - 2, z0, x1 - 3, cabH, z1, cabM);
    B(x1 - 1, Math.round(cabH * 0.5), z0 + 1, x1, cabH - 3, z1 - 1, M.GLASS);
    B(x1 - 6, Math.round(cabH * 0.5), z0, x1 - 2, cabH - 3, z0 + 1, M.GLASS); B(x1 - 6, Math.round(cabH * 0.5), z1 - 1, x1 - 2, cabH - 3, z1, M.GLASS);
    B(x1 - 1, 2, z0, x1, 4, z1, M.BUMPER);
    lightsF(4, 6);
    const bx1 = cx - (kind === 'panel_van' || kind === 'delivery_van' || kind === 'ambulance' ? 0 : 1);
    if (kind === 'fuel_tanker') {
      B(x0, 3, -2, bx1, 6, 2, M.BUMPER);
      const r = Math.min(wh, 9), cy = 6 + r;
      for (let k = -r; k < r; ++k) { const hz = Math.round(Math.sqrt(Math.max(0, r * r - (k + 0.5) * (k + 0.5)))); B(x0 + 1, cy + k, -hz, bx1 - 1, cy + k + 1, hz, bodyM); }
      B(x0 + 4, cy + r, -1, bx1 - 4, cy + r + 1, 1, M.CHROME);
      B(x0 + 1, cy - 1, z0 - 0, bx1 - 1, cy, z0 + 1, M.BRED); B(x0 + 1, cy - 1, z1 - 1, bx1 - 1, cy, z1, M.BRED);
      wheels([x0 + 5, x0 + 11, cx - 4, x1 - 6], 4);
    } else if (kind === 'semi') {
      B(x0, 4, z0, bx1 - 3, bodyH, z1, bodyM); B(x0, 4, z0, bx1 - 3, 5, z1, M.GREY);
      B(x0, 2, z0 + 3, cx, 4, z1 - 3, M.BUMPER);
      wheels([x0 + 5, x0 + 11, cx - 4, x1 - 6], 4);
    } else if (kind === 'garbage_truck') {
      B(x0 + 2, 3, z0, bx1, bodyH - 2, z1, bodyM); B(x0 + 4, bodyH - 2, z0 + 1, bx1 - 1, bodyH, z1 - 1, bodyM);
      B(x0, 3, z0 + 1, x0 + 2, bodyH - 5, z1 - 1, M.GREY); B(x0, 3, z0 + 3, x0 + 1, 8, z1 - 3, M.BLACK);
      wheels([x0 + 8, cx - 5, x1 - 6], 4);
    } else if (kind === 'fire_engine') {
      B(x0, 3, z0, bx1, 18, z1, bodyM); B(x0, 18, z0 + 2, bx1 + 6, 20, z0 + 5, M.CHROME); B(x0, 18, z1 - 5, bx1 + 6, 20, z1 - 2, M.CHROME);
      for (let x = x0 + 2; x < bx1; x += 8) { B(x, 7, z0, x + 6, 15, z0 + 1, M.CHROME); B(x, 7, z1 - 1, x + 6, 15, z1, M.CHROME); }
      B(x1 - 6, cabH, z0 + 2, x1 - 4, cabH + 1, z1 - 2, M.BRED);
      wheels([x0 + 8, x1 - 7], 4);
    } else {
      B(x0, 2, z0, bx1, bodyH, z1, bodyM);
      if (kind === 'ambulance') { B(x0, 9, z0, bx1, 11, z0 + 1, M.BRED); B(x0, 9, z1 - 1, bx1, 11, z1, M.BRED); B(-2, 14, z0, 2, 18, z0 + 1, M.BRED); B(-2, 14, z1 - 1, 2, 18, z1, M.BRED); B(x1 - 9, bodyH, z0 + 2, x1 - 6, bodyH + 1, z1 - 2, M.BRED); B(x0 + 1, bodyH, z0 + 1, x0 + 3, bodyH + 1, z1 - 1, M.AMBER); }
      if (kind === 'box_truck') { B(x0, bodyH - 1, z0, bx1, bodyH, z1, M.GREY); }
      if (kind === 'delivery_van') { B(x0 + 2, 10, z0, bx1 - 2, 13, z0 + 1, M.ORANGE); B(x0 + 2, 10, z1 - 1, bx1 - 2, 13, z1, M.ORANGE); }
      B(x0, 2, z0, x0 + 1, 3, z1, M.BUMPER);
      wheels(kind === 'box_truck' ? [x0 + 8, x1 - 6] : [x0 + 7, x1 - 6], kind === 'box_truck' ? 4 : 3);
    }
    lightsR(4, 7);
    doorXs = [[x1 - 8, x1 - 1]];
  }
  // open doors: slabs swung ~80 degrees out from the hinge (front edge), on one or both sides; rear doors of vans
  if (o.doors === 'side' || o.doors === 'both') {
    const sides = o.doors === 'both' ? [-1, 1] : [R() < 0.5 ? -1 : 1];
    const dm = car ? paint : M.WHITE;
    for (const sd of sides) for (const [a, b] of doorXs.slice(0, R() < 0.5 ? 1 : 2)) {
      const len = Math.min(8, b - a), y1 = car ? Hv - 2 : 16;
      if (sd < 0) { B(b - 1, 2, z0 - len, b, y1, z0, dm); B(b - 1, 7, z0 - len + 1, b, y1, z0 - 1, M.GLASS); }
      else { B(b - 1, 2, z1, b, y1, z1 + len, dm); B(b - 1, 7, z1 + 1, b, y1, z1 + len - 1, M.GLASS); }
    }
  }
  if (o.doors === 'rear') {
    const bm = kind === 'ambulance' ? M.WHITE : paint;
    const half = wh;
    B(x0 - 1, 3, z0 - 0, x0, Hv - 2, z0 + 1, bm);     // hinge stubs
    B(x0 - half, 3, z0 - 1, x0, Hv - 2, z0, bm); B(x0 - half, 3, z1, x0, Hv - 2, z1 + 1, bm);
    B(x0, 3, z0 + 1, x0 + 1, Hv - 2, z1 - 1, M.BLACK);                 // dark open interior
  }
  // damage
  const st = o.state;
  if (st === 'crashed' || st === 'damaged') {
    const depth = st === 'crashed' ? 3 + Math.floor(R() * 3) : 1;
    const side = R() < 0.5 ? z0 : z1 - 3;
    for (let y = 3; y < Hv; ++y) for (let z = z0; z < z1; ++z) for (let x = x1 - depth; x < x1; ++x) {
      const h = C.hash2(x * 7 + y, z * 13, o.seed & 1023);
      if (h < (st === 'crashed' ? 0.55 : 0.25) || (z >= side && z < side + 3 && x >= x1 - depth - 1)) Vm.v[(y * Vm.d + z + Vm.oz) * Vm.w + x + Vm.ox] = 0;
    }
    if (st === 'crashed') B(x1 - depth - 3, Math.round(Hv * 0.55), z0 + 2, x1 - depth - 1, Math.round(Hv * 0.55) + 1, z1 - 2, M.CHROME);   // buckled hood edge
  }
  if (st === 'burnt') {
    for (let i = 0; i < Vm.v.length; ++i) {
      const m = Vm.v[i] - 1; if (m < 0) continue;
      const h = C.hash2(i, 7, o.seed & 1023);
      let nm;
      if (m === M.GLASS || m === M.HEAD || m === M.TAIL) nm = M.BLACK;
      else if (m === M.TIRE) nm = h < 0.6 ? 0 : M.BURNT;
      else nm = h < 0.45 ? M.BURNT : h < 0.75 ? M.RUST : h < 0.9 ? M.BLACK : M.GREY;
      Vm.v[i] = nm ? nm + 1 : 0;
    }
    // glass gone: hollow the greenhouse a bit (dark interior reads as burnt-out)
  }
  return { M: Vm, sc: VS, len: lm, wid: wm, h: hm };
}

// ------------------------------------------------------------------------------------------ scene props (6.25 cm)
const PS = 0.0625;
function propModel(C, name, seed) {
  const R = C.mulberry32(seed >>> 0);
  const V = (w, h, d) => new C.VoxModel(w, h, d, w >> 1, d >> 1);
  let Vm;
  switch (name) {
    case 'cone': Vm = V(8, 12, 8); Vm.box(-4, 0, -4, 4, 1, 4, M.BLACK); Vm.box(-2, 1, -2, 2, 5, 2, M.ORANGE); Vm.box(-2, 5, -2, 2, 7, 2, M.WHITE); Vm.box(-1, 7, -1, 1, 11, 1, M.ORANGE); break;
    case 'barrier': {   // type III barricade, 2 m
      Vm = V(32, 22, 10);
      for (const x of [-14, 12]) { Vm.box(x, 0, -4, x + 2, 1, 4, M.BLACK); Vm.box(x, 1, -1, x + 2, 20, 1, M.WHITE); }
      for (const y of [8, 14, 19]) for (let x = -16; x < 16; x += 4) Vm.box(x, y, 1, x + 4, y + 2, 2, ((x >> 2) & 1) ? M.ORANGE : M.WHITE);
      break;
    }
    case 'jersey': Vm = V(48, 13, 10); Vm.box(-24, 0, -5, 24, 3, 5, M.CONC); Vm.box(-24, 3, -3, 24, 7, 3, M.CONC); Vm.box(-24, 7, -2, 24, 13, 2, M.CONC); break;
    case 'bags': {
      Vm = V(26, 10, 26);
      const n = 4 + Math.floor(R() * 5);
      for (let i = 0; i < n; ++i) { const x = Math.floor(R() * 16) - 10, z = Math.floor(R() * 16) - 10, s = 4 + Math.floor(R() * 3), m = R() < 0.6 ? M.BAG : M.BAG_G; Vm.box(x, 0, z, x + s, s - 1, z + s, m); Vm.box(x + 1, s - 1, z + 1, x + s - 1, s + 1, z + s - 1, m); }
      break;
    }
    case 'luggage': {
      Vm = V(24, 8, 24);
      const n = 2 + Math.floor(R() * 3);
      for (let i = 0; i < n; ++i) { const x = Math.floor(R() * 14) - 9, z = Math.floor(R() * 14) - 9, m = [M.LUG1, M.LUG2, M.LUG3, M.BLACK][Math.floor(R() * 4)]; const a = R() < 0.5; Vm.box(x, 0, z, x + (a ? 10 : 4), 3, z + (a ? 4 : 10), m); if (R() < 0.5) Vm.box(x + 1, 3, z + 1, x + 4, 4, z + 3, M.BLACK); }
      break;
    }
    case 'boxes': {
      Vm = V(28, 12, 28);
      const n = 3 + Math.floor(R() * 5);
      for (let i = 0; i < n; ++i) { const x = Math.floor(R() * 18) - 11, z = Math.floor(R() * 18) - 11, s = 4 + Math.floor(R() * 4), hh = 3 + Math.floor(R() * 4); Vm.box(x, 0, z, x + s, hh, z + s, M.CARD); Vm.box(x + 1, hh - 1, z + (s >> 1), x + s - 1, hh, z + (s >> 1) + 1, M.BEIGE); }
      break;
    }
    case 'debris': {
      Vm = V(40, 3, 40);
      const n = 8 + Math.floor(R() * 8);
      for (let i = 0; i < n; ++i) { const x = Math.floor(R() * 36) - 18, z = Math.floor(R() * 36) - 18, a = 1 + Math.floor(R() * 4), b = 1 + Math.floor(R() * 2); Vm.box(x, 0, z, x + a, 1 + (R() < 0.3 ? 1 : 0), z + b, [M.DEBRIS, M.GLASS, M.CHROME, M.BLACK, M.RUST][Math.floor(R() * 5)]); }
      break;
    }
    case 'stretcher': Vm = V(32, 14, 10); Vm.box(-15, 9, -4, 15, 11, 4, M.WHITE); Vm.box(-13, 11, -3, -5, 12, 3, M.WHITE); for (const x of [-13, 11]) Vm.box(x, 0, -3, x + 2, 9, 3, M.STEEL); break;
    default: return null;
  }
  return { M: Vm, sc: PS };
}

// ------------------------------------------------------------------------------------------ the kit
// ------------------------------------------------------------------------------------------ the kit
let PROP_FP = null;      // street-furniture footprints from the prop meshes: type -> { lo: [x0,x1,z0,z1] below 2 m, hi: below 4.4 m }
function propFootprints(C) {
  if (PROP_FP) return PROP_FP;
  PROP_FP = {};
  const PM = C.buildPropMeshes();
  for (const t in PM) {
    const m = PM[t], P = m.pos, nq = P.length / 12;
    const lo = [1e9, -1e9, 1e9, -1e9], hi = [1e9, -1e9, 1e9, -1e9];
    for (let q = 0; q < nq; ++q) {
      let y0 = 1e9; for (let k = 0; k < 4; ++k) y0 = Math.min(y0, P[q * 12 + k * 3 + 1]);
      for (const [B, lim] of [[lo, 2.0], [hi, 4.4]]) {
        if (y0 >= lim) continue;
        for (let k = 0; k < 4; ++k) { const x = P[q * 12 + k * 3], z = P[q * 12 + k * 3 + 2]; B[0] = Math.min(B[0], x); B[1] = Math.max(B[1], x); B[2] = Math.min(B[2], z); B[3] = Math.max(B[3], z); }
      }
    }
    PROP_FP[t] = { lo: lo[0] < 1e8 ? lo : null, hi: hi[0] < 1e8 ? hi : null };
  }
  return PROP_FP;
}
// 2D oriented boxes { x, z, hx, hz, c, s }: separated by more than gap (separating axis test)
function obbGap(a, b, gap) {
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ux, uz] of [[a.c, a.s], [-a.s, a.c], [b.c, b.s], [-b.s, b.c]]) {
    const ra = a.hx * Math.abs(a.c * ux + a.s * uz) + a.hz * Math.abs(-a.s * ux + a.c * uz);
    const rb = b.hx * Math.abs(b.c * ux + b.s * uz) + b.hz * Math.abs(-b.s * ux + b.c * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb + gap) return true;
  }
  return false;
}

function trafficKit(K) {
  const { PL, C, R, jobs, hs, voxel } = K;
  if (!PL || !PL.net || !PL.net.roads || PL.net.kind === 'test') return null;
  const t0 = Date.now();
  const net = PL.net, F = R.F, seed = (PL.seed || net.seed || 1) >>> 0;
  const MAT = C.MAT;
  const stats = { jam: 0, exit: 0, arterial: 0, parked: 0, stalled: 0, emergency: 0, sets: [], incidents: {}, props: 0, vehicles: 0, ms: 0, propMs: 0, meshMs: 0, fail: {}, hitK: {}, lane: {} };
  const inc = (k) => { stats.incidents[k] = (stats.incidents[k] || 0) + 1; };
  const core = (net.origins && net.origins.core) || [0, 0];
  const b = net.bounds;

  // ---- variants: one mesh per (kind, state, doors, lights, variant, rolled); body paint per instance
  const VEH = C.Vehicles || (self.CityCore && self.CityCore.Vehicles) || null;
  const cache = new Map(), variants = [];
  const PAINT_PH = C.VM ? C.VM.BROWN : -1;
  const LIVERY = new Set(['taxi', 'police', 'ambulance', 'fire_engine', 'school_bus', 'city_bus', 'garbage_truck', 'fuel_tanker', 'tanker_cab', 'tanker_trailer']);
  // quad mesh (pos in model units, scaled by f to metres) -> compact typed arrays; bottom faces on y = 0 dropped
  // unless the variant is used rolled over
  const pack = (m, f, keepBottom) => {
    const nq = m.quads, keep = [];
    for (let q = 0; q < nq; ++q) {
      if (!keepBottom && m.nrm[q * 4] === 5) { let g = true; for (let k = 0; k < 4; ++k) if (m.pos[q * 12 + k * 3 + 1] * f > 1e-4) g = false; if (g) continue; }
      keep.push(q);
    }
    const pos = new Float32Array(keep.length * 12), mat = new Uint8Array(keep.length * 4), nrm = new Uint8Array(keep.length * 4);
    keep.forEach((q, i) => { for (let k = 0; k < 12; ++k) pos[i * 12 + k] = m.pos[q * 12 + k] * f; for (let k = 0; k < 4; ++k) { mat[i * 4 + k] = m.mat[q * 4 + k]; nrm[i * 4 + k] = m.nrm[q * 4 + k]; } });
    return { pos, mat, nrm, quads: keep.length };
  };
  const bboxOf = (g) => {
    let x0 = 1e9, x1 = -1e9, y1 = 0, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < g.pos.length; i += 3) { const x = g.pos[i], y = g.pos[i + 1], z = g.pos[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    return { x0, x1, y1, z0, z1 };
  };
  // o: { ps (paint seed), seed (variant), state, doors, lights, roll (used rolled over) }
  const vehicle = (kind, o) => {
    const info0 = VEH && VEH.INFO && VEH.INFO[kind];
    const want = !VEH || LIVERY.has(kind) || !info0 ? 0 : (info0.cls === 'car' ? VEH.paints.pick(o.ps | 0) : VEH.paints.pickFleet(o.ps | 0));
    const key = kind + '|' + o.state + '|' + (o.doors || 0) + '|' + (o.lights ? 1 : 0) + '|' + ((o.seed | 0) & 3) + '|' + (o.roll ? 1 : 0) + (VEH ? '' : '|' + (o.ps | 0));
    let v = cache.get(key);
    if (!v) {
      const tm = Date.now();
      let Mv = null, f = 1;
      if (VEH && VEH.model) {
        try {
          const info = VEH.INFO && VEH.INFO[kind];
          const opts = { seed: (o.seed | 0) & 3, state: o.state === 'rolled' ? 'crashed' : o.state, doors: !!o.doors, lights: !!o.lights };
          if (!(LIVERY.has(kind) || !info)) opts.paint = PAINT_PH;
          Mv = VEH.model(kind, opts).M;
        } catch (e) { Mv = null; }
      }
      if (!Mv) { const mdl = fallbackModel(C, kind, { paint: PAINTS[(o.ps | 0) % PAINTS.length], seed: (o.seed | 0) & 3, state: o.state === 'rolled' ? 'crashed' : o.state, doors: o.doors === true ? 'side' : o.doors, lights: o.lights }); Mv = mdl.M; f = mdl.sc / C.PV; }
      // hi: 10 cm resample of the 5 cm library model (near the camera), lo: 20 cm (far)
      const H = half(Mv);
      const hi = pack(C.meshVoxels3D(H), 2 * f, !!o.roll);
      const lo = o.roll ? pack(C.meshVoxels3D(half(H)), 4 * f, true) : proxy(bboxOf(hi), kind, o.state);
      v = { id: variants.length, key, kind, hi, lo, bb: bboxOf(hi), n: 0 };
      variants.push(v); cache.set(key, v);
      stats.meshMs += Date.now() - tm;
    }
    return { v, bb: v.bb, paint: want, kind };
  };
  // far LOD: a handful of boxes (25 cm voxels) - body in the paint placeholder (livery kinds: white / their colour),
  // dark cabin glass, dark wheels; burnt wrecks charred
  const PROXY_BODY = { taxi: 171, police: 160, ambulance: 160, fire_engine: 173, school_bus: 172, city_bus: 160, garbage_truck: 193, fuel_tanker: 191, tanker_cab: 160, tanker_trailer: 191 };
  const proxy = (bb, kind, state) => {
    const Q = 0.25, x0 = Math.round(bb.x0 / Q), x1 = Math.round(bb.x1 / Q), z0 = Math.round(bb.z0 / Q), z1 = Math.round(bb.z1 / Q), h = Math.max(2, Math.round(bb.y1 / Q));
    const Vm = new C.VoxModel(x1 - x0 + 2, h + 1, z1 - z0 + 2, -x0 + 1, -z0 + 1);
    const burnt = state === 'burnt', dark = C.VM ? C.VM.TYRE : 58;
    let body = burnt ? (C.VM ? C.VM.CHAR : 156) : (PROXY_BODY[kind] !== undefined && C.VM ? PROXY_BODY[kind] : PAINT_PH);
    if (body < 0) body = 160;
    const glass = burnt ? dark : (C.VM && C.VM.GLASS !== undefined ? C.VM.GLASS : 200);
    const info = VEH && VEH.INFO && VEH.INFO[kind], car = info && info.cls === 'car';
    const B = (a, b2, c, d, e, f2, m) => Vm.box(a, b2, c, d, e, f2, m);
    const wy = 2;
    B(x0, 1, z0, x1, car ? Math.max(wy + 1, Math.round(h * 0.55)) : h - 1, z1, body);
    if (car) { const c0 = x0 + Math.round((x1 - x0) * 0.25), c1 = x1 - Math.round((x1 - x0) * 0.3); B(c0, Math.round(h * 0.55), z0 + 0, c1, h, z1, glass); B(c0 + 1, h - 1, z0, c1 - 1, h, z1, body); }
    else { B(x1 - 2, Math.round(h * 0.45), z0, x1, h - 2, z1, glass); B(x0, h - 1, z0, x1 - (h > 8 ? 0 : 2), h, z1, body); }
    for (const wx of [x0 + 2, x1 - 3]) { B(wx - 1, 0, z0, wx + 1, wy, z0 + 1, dark); B(wx - 1, 0, z1 - 1, wx + 1, wy, z1, dark); }
    return pack(C.meshVoxels3D(Vm), Q / C.PV, false);
  };
  // 2x resample of a VoxModel (low LOD): a cell is solid when >= 4 of its 8 children are, most common material
  function half(S) {
    const w = Math.ceil(S.w / 2), h = Math.ceil(S.h / 2), d = Math.ceil(S.d / 2);
    const D = new C.VoxModel(w, h, d, Math.floor(S.ox / 2), Math.floor(S.oz / 2));
    const mv = new Int32Array(8), Sv = S.v, Sw = S.w, Sh = S.h, Sd = S.d;
    for (let y = 0; y < h; ++y) for (let z = 0; z < d; ++z) for (let x = 0; x < w; ++x) {
      let n = 0;
      for (let k = 0; k < 8; ++k) {
        const X = 2 * x + (k & 1), Y = 2 * y + ((k >> 1) & 1), Z = 2 * z + (k >> 2);
        if (X >= Sw || Y >= Sh || Z >= Sd) continue;
        const m = Sv[(Y * Sd + Z) * Sw + X];
        if (m) mv[n++] = m;
      }
      if (!(n >= 4 || (y === 0 && n >= 2))) continue;
      let bm = 0, best = 0;
      for (let i = 0; i < n; ++i) { let c = 0; for (let j = 0; j < n; ++j) if (mv[j] === mv[i]) ++c; if (c > best) { best = c; bm = mv[i]; } }
      D.v[(y * d + z) * w + x] = bm;
    }
    return D;
  }
  const prop = (name, vr) => {
    const key = 'p|' + name + '|' + vr;
    let v = cache.get(key);
    if (v) return { v, bb: v.bb, paint: 0 };
    const p = propModel(C, name, 977 * vr + 13);
    const hi = pack(C.meshVoxels3D(p.M), p.sc / C.PV, false);
    v = { id: variants.length, key, kind: 'prop:' + name, hi, lo: null, bb: bboxOf(hi), n: 0 };
    variants.push(v); cache.set(key, v);
    return { v, bb: v.bb, paint: 0 };
  };

  // ---- instances: 3x4 row-major transform (model metres -> world metres), variant, paint, footprint
  const inst = [];
  const rollM = (roll, bb) => roll === 1 ? [1, 0, 0, 0, 0, 0, 1, -bb.z0, 0, -1, 0, bb.y1 / 2] : roll === 2 ? [1, 0, 0, 0, 0, -1, 0, bb.y1, 0, 0, -1, 0] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const put = (V, x, y, z, yaw, roll, fp) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), Rm = rollM(roll || 0, V.bb);
    const Y = [c, 0, -s, x, 0, 1, 0, y, s, 0, c, z], M = new Array(12);
    for (let i = 0; i < 3; ++i) for (let j = 0; j < 4; ++j) M[i * 4 + j] = Y[i * 4] * Rm[j] + Y[i * 4 + 1] * Rm[4 + j] + Y[i * 4 + 2] * Rm[8 + j] + (j === 3 ? Y[i * 4 + 3] : 0);
    const h = roll === 1 ? V.bb.z1 - V.bb.z0 : V.bb.y1;
    inst.push({ v: V.v.id, M, paint: V.paint || 0, fp, y, h });
    V.v.n++;
  };
  // footprint of a placed model: { x, z, hx, hz, c, s } in world metres
  const fpOf = (V, x, z, yaw, roll) => {
    const bb = V.bb;
    let lx0 = bb.x0, lx1 = bb.x1, lz0 = bb.z0, lz1 = bb.z1;
    if (roll === 1) { lz0 = -bb.y1 / 2; lz1 = bb.y1 / 2; }
    if (roll === 2) { lz0 = -bb.z1; lz1 = -bb.z0; }
    const mx = (lx0 + lx1) / 2, mz = (lz0 + lz1) / 2, c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: x + mx * c - mz * s, z: z + mx * s + mz * c, hx: (lx1 - lx0) / 2, hz: (lz1 - lz0) / 2, c, s };
  };

  // ---- obstacle index: oriented boxes in an 8 m hash. kind bits: 1 building, 2 building stoop zone,
  // 4 street furniture (low parts), 8 street furniture (up to 4.4 m), 16 placed vehicle / prop
  const HC = 8, hash = new Map();
  const hk = (i, j) => i * 65536 + j;
  const addObb = (o, k) => {
    o.k = k;
    const r = Math.abs(o.c) * o.hx + Math.abs(o.s) * o.hz + 0.01, q = Math.abs(o.s) * o.hx + Math.abs(o.c) * o.hz + 0.01;
    for (let i = Math.floor((o.x - r) / HC); i <= Math.floor((o.x + r) / HC); ++i) for (let j = Math.floor((o.z - q) / HC); j <= Math.floor((o.z + q) / HC); ++j) {
      const key = hk(i, j); let l = hash.get(key); if (!l) hash.set(key, l = []); l.push(o);
    }
  };
  const hitObb = (fp, gap, mask) => {
    const r = Math.abs(fp.c) * fp.hx + Math.abs(fp.s) * fp.hz + gap + 0.01, q = Math.abs(fp.s) * fp.hx + Math.abs(fp.c) * fp.hz + gap + 0.01;
    for (let i = Math.floor((fp.x - r) / HC); i <= Math.floor((fp.x + r) / HC); ++i) for (let j = Math.floor((fp.z - q) / HC); j <= Math.floor((fp.z + q) / HC); ++j) {
      const l = hash.get(hk(i, j)); if (!l) continue;
      for (const o of l) if ((o.k & mask) && !obbGap(fp, o, gap)) { stats.hitK[o.k + (o.t ? ':' + o.t : '')] = (stats.hitK[o.k + (o.t ? ':' + o.t : '')] || 0) + 1; return true; }
    }
    return false;
  };
  // building footprints (+0.3 m) and their stoop / canopy zone (+3 m rows and houses, +1 m others)
  for (const J of jobs) {
    const w = J.W * 0.25, d = J.D * 0.25, cx = J.O[0] + J.e1[0] * w / 2 + J.e2[0] * d / 2, cz = J.O[1] + J.e1[1] * w / 2 + J.e2[1] * d / 2;
    const n = Math.hypot(J.e1[0], J.e1[1]) || 1, c = J.e1[0] / n, s = J.e1[1] / n;
    addObb({ x: cx, z: cz, hx: w / 2 + 0.3, hz: d / 2 + 0.3, c, s }, 1);
    const st = J.kind === 'row' || J.kind === 'house' || J.type === 'prewar_apartment' ? 3.0 : 1.0;
    addObb({ x: cx, z: cz, hx: w / 2 + st, hz: d / 2 + st, c, s }, 2);
  }
  // driveway curb cuts: the parking lane in front of each stays clear (box from the lot line across the sidewalk
  // and the parking lane, both normal signs: the building side is blocked anyway)
  for (const ct of (R.cuts || [])) {
    const mx = (ct.ax + ct.bx) / 2, mz = (ct.az + ct.bz) / 2, w = Math.hypot(ct.bx - ct.ax, ct.bz - ct.az) / 2 + 0.6;
    const nl = Math.hypot(ct.nx, ct.nz) || 1, nx = ct.nx / nl, nz = ct.nz / nl, ext = (ct.depth || 4) + 2.0;
    for (const sg of [1, -1]) addObb({ x: mx + sg * nx * ext / 2, z: mz + sg * nz * ext / 2, hx: ext / 2, hz: w, c: sg * nx, s: sg * nz }, 1);
    stats.cuts = (stats.cuts || 0) + 1;
  }
  // street furniture, exactly as the page will place it (final footprints, final curb cuts), from the prop meshes
  const tp = Date.now();
  let props = [];
  try {
    const footprints = jobs.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind, type: J.type }));
    props = C.placeProps({ net, F, R, voxel, footprints });
  } catch (e) { props = []; }
  const PFP = propFootprints(C);
  const lampsAndHydrants = [];
  for (const p of props) {
    const fpp = PFP[p.type]; if (!fpp) continue;
    const c = Math.cos(p.yaw), s = -Math.sin(p.yaw);     // prop model +x -> world (cos yaw, -sin yaw)
    const box = (B) => { const cu = (B[0] + B[1]) / 2, cv = (B[2] + B[3]) / 2; return { x: p.x + cu * c - cv * s, z: p.z + cu * s + cv * c, hx: (B[1] - B[0]) / 2, hz: (B[3] - B[2]) / 2, c, s }; };
    if (fpp.lo) addObb(Object.assign(box(fpp.lo), { t: p.type }), 4);
    if (fpp.hi) addObb(Object.assign(box(fpp.hi), { t: p.type }), 8);
    if (p.type === 'lamp' || p.type === 'hydrant') lampsAndHydrants.push(p);
  }
  stats.propMs = Date.now() - tp;

  // ---- surface tests
  const o = {}, cls = [0, 0];
  const ROADM = new Set([MAT.ASPHALT, MAT.ASPHALT_B, MAT.ASPHALT_C, MAT.PAINT_WHITE, MAT.PAINT_YELLOW, MAT.PARKING, MAT.CROSSWALK, MAT.GUTTER]);
  const WALKM = new Set([MAT.SIDEWALK, MAT.SIDEWALK_JOINT]);
  const surfOK = (fp, pad, walk) => {
    const ex = fp.hx + pad, ez = fp.hz + pad, nu = Math.max(2, Math.ceil(ex / 0.8)), nv = Math.max(2, Math.ceil(ez / 0.7));
    for (let a = -nu; a <= nu; ++a) for (let d = -nv; d <= nv; ++d) {
      if (a > -nu && a < nu && d > -nv && d < nv && ((a + d) & 1)) continue;      // interior: checkerboard
      const u = a / nu * ex, v = d / nv * ez;
      const x = fp.x + u * fp.c - v * fp.s, z = fp.z + u * fp.s + v * fp.c;
      R.classify(x, z, o, cls);
      if (o.road < 0) return false;
      const rd = net.roads[o.road];
      if (!rd || rd.P.id === 'alley') return false;
      if (walk) { if (cls[0] !== R.hs || !WALKM.has(cls[1])) return false; }
      else if (cls[0] !== 0 || !ROADM.has(cls[1])) return false;
    }
    return true;
  };
  // every corner of a footprint inside the world bounds minus m metres
  const inside = (fp, m) => {
    for (const [a, d] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = fp.x + a * fp.hx * fp.c - d * fp.hz * fp.s, z = fp.z + a * fp.hx * fp.s + d * fp.hz * fp.c;
      if (x < b.x0 + m || x > b.x1 - m || z < b.z0 + m || z > b.z1 - m) return false;
    }
    return true;
  };
  // place a vehicle / prop if it fits; returns the footprint or null. Every vehicle keeps >= 0.15 m (gap) from
  // every other vehicle / prop, from the street furniture and from building footprints (+0.3 m)
  const tryPlace = (V, x, z, yaw, roll, opt) => {
    opt = opt || {};
    const fp = fpOf(V, x, z, yaw, roll || 0);
    const gap = Math.max(0.15, opt.gap === undefined ? 0.2 : opt.gap);
    if (!inside(fp, Math.max(3, opt.edge || 3))) { stats.fail.out = (stats.fail.out || 0) + 1; return null; }
    const h = roll === 1 ? V.bb.z1 - V.bb.z0 : V.bb.y1;
    if (hitObb(fp, gap, 16 | 1 | (h > 1.95 ? 8 : 4) | (opt.walk ? 2 : 0))) { stats.fail.obb = (stats.fail.obb || 0) + 1; return null; }
    if (!surfOK(fp, opt.walk ? 0.2 : 0.15, !!opt.walk)) { stats.fail.surf = (stats.fail.surf || 0) + 1; return null; }
    if (opt.dry) return fp;
    addObb(Object.assign({}, fp), 16);
    put(V, x, opt.walk ? hs : 0, z, yaw, roll || 0, fp);
    return fp;
  };
  const propAt = (name, vr, x, z, yaw) => { const V = prop(name, vr); const f = tryPlace(V, x, z, yaw, 0, { gap: 0.15 }); if (f) ++stats.props; return f; };

  // ---- road frames
  const roads = net.roads.filter(r => r.len && r.P && r.P.id !== 'alley');
  const frame = (r, s, u) => { const [px, pz, tx, tz] = C.pointAt(r, s); return [px + tz * u, pz - tx * u, tx, tz]; };
  const laneHeading = (r, s, u, half, d) => {
    const [ax, az] = frame(r, clamp(s - half, 0, r.len), u), [bx, bz] = frame(r, clamp(s + half, 0, r.len), u);
    return Math.atan2(d * (bz - az), d * (bx - ax));
  };
  const majorJ = (r) => (r.junctions || []).filter(j => j.major);
  const inJ = (r, s, pad) => (r.junctions || []).some(j => s > j.a - pad && s < j.b + pad);
  const Rg = C.mulberry32(seed * 7919 + 17);
  const pickPaint = (Rr) => Math.floor(Rr() * 64);
  const CAR_MIX = { sedan: 26, suv: 18, hatchback: 10, pickup: 12, minivan: 10, coupe: 5, taxi: 3, panel_van: 5, box_truck: 2.5, delivery_van: 2.5, semi: 1.2, city_bus: 0.5, school_bus: 0.5 };
  const PARK_MIX = { sedan: 28, suv: 18, hatchback: 14, pickup: 10, minivan: 10, coupe: 6, taxi: 2, panel_van: 4 };
  const vehKind = (Rr, mix) => pickW(Rr, mix || CAR_MIX);
  const INC_MIX = { sedan: 30, suv: 22, pickup: 16, hatchback: 12, minivan: 10 };
  const incKind = (Rr) => pickW(Rr, INC_MIX);
  const laneEdges = (r) => r.P.edges.filter(e => e.type === 'lane');
  const through = roads.filter(r => r.P.cls === 'arterial' || r.P.cls === 'collector');
  const radial = (r, s) => { const [x, z, tx, tz] = frame(r, s, 0); const dx = x - core[0], dz = z - core[1], dl = Math.hypot(dx, dz) || 1; return { x, z, dist: dl, cos: (tx * dx + tz * dz) / dl }; };
  const midSpots = (filter, pad, pool) => {
    const out = [];
    for (const r of pool || through) for (let s = 15; s < r.len - 15; s += 9) { if (inJ(r, s, pad)) continue; if (filter && !filter(r, s)) continue; out.push([r, s]); }
    return out;
  };
  const shuffle = (a, Rr) => { for (let i = a.length - 1; i > 0; --i) { const j = Math.floor(Rr() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const usedSpots = [];
  const farFromUsed = (x, z, d) => usedSpots.every(([a, c]) => Math.hypot(a - x, c - z) > d);
  const downtown = (r) => r.district === 'downtown';
  // +1 / -1: the road leaves the map at its end / start (only one end); 0 otherwise
  const exitDir = (r) => {
    if (r._exit !== undefined) return r._exit;
    const near = (p) => Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.z0, b.z1 - p[1]) < 20;
    const a = near(r.pts[0]), e = near(r.pts[r.pts.length - 1]);
    return (r._exit = a === e ? 0 : e ? 1 : -1);
  };
  const outDensity = (r, s, d) => {           // outbound pressure of travel direction d (0..1)
    const q = radial(r, s), out = d * q.cos;
    const ex = exitDir(r);
    if (ex) return ex === d ? 1 : 0.3;
    return sstep(-0.2, 0.6, out);
  };

  // ================================================================== set pieces (6-10)
  const tanker = (r, s) => {
    const Rr = C.mulberry32(hashS('tank' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1, u = (e.left + e.right) / 2;
    const [x, z] = frame(r, s, u), base = laneHeading(r, s, u, 5, d);
    const lib = VEH && VEH.INFO && VEH.INFO.tanker_trailer;
    const V = vehicle(lib ? 'tanker_trailer' : 'fuel_tanker', { ps: 0, seed: 1, state: 'damaged', roll: 1 });
    const Vcab = lib ? vehicle('tanker_cab', { ps: 0, seed: 1, state: 'crashed', doors: true }) : null;
    for (const dy of [0.42, -0.42, 0.3, -0.3, 0.55, -0.55, 0.2, -0.2]) for (const du of [0, 1.2, -1.2, 2.2, -2.2]) {
      const xx = x + Math.cos(base + Math.PI / 2) * du, zz = z + Math.sin(base + Math.PI / 2) * du;
      const f = tryPlace(V, xx, zz, base + dy, 1, { gap: 0.15 });
      if (!f) continue;
      if (Vcab) {
        const hx = Math.cos(base + dy), hz = Math.sin(base + dy), cl = (Vcab.bb.x1 - Vcab.bb.x0) / 2;
        for (const [dd, a] of [[1.0, -0.9], [1.0, 0.9], [1.5, -1.3], [1.5, 1.3], [2.5, -0.5], [2.5, 0.5]]) {
          const cy = base + dy + a, ex = f.x + hx * (f.hx + dd), ez = f.z + hz * (f.hx + dd);
          if (tryPlace(Vcab, ex + Math.cos(cy) * (cl + 0.2), ez + Math.sin(cy) * (cl + 0.2), cy, 0, { gap: 0.15 })) break;
        }
      }
      for (let n = 0, k = 0; k < 16 && n < 2; ++k) {
        const Vb = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 2, state: 'burnt' });
        const a = Rr() * 6.283, rr = 6 + Rr() * 5;
        if (tryPlace(Vb, f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr, base + (Rr() - 0.5) * 1.6, 0, { gap: 0.15 })) ++n;
      }
      for (let k = 0; k < 4; ++k) propAt('debris', k, f.x + (Rr() - 0.5) * 14, f.z + (Rr() - 0.5) * 14, Rr() * 6);
      usedSpots.push([f.x, f.z]); stats.sets.push({ type: 'tanker', x: Math.round(f.x), z: Math.round(f.z) });
      return true;
    }
    return false;
  };
  // jackknifed semi: cab straight in its lane, the trailer swung across the neighbouring lanes
  const jackknife = (r, s) => {
    const Rr = C.mulberry32(hashS('jk' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (lanes.length < 2 || !(VEH && VEH.INFO && VEH.INFO.semi_cab)) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1, u = (e.left + e.right) / 2;
    const Vc = vehicle('semi_cab', { ps: Math.floor(Rr() * 8), seed: 1, state: 'crashed', doors: true });
    const Vt = vehicle('semi_trailer', { ps: Math.floor(Rr() * 8), seed: 1, state: 'damaged' });
    const cl = Vc.bb.x1 - Vc.bb.x0, tl = Vt.bb.x1 - Vt.bb.x0;
    for (const sg of [1, -1]) for (const ang of [0.7, 0.9, 0.55, 1.1]) {
      const [x, z] = frame(r, s, u), yaw = laneHeading(r, s, u, 3, d) + sg * 0.15;
      const hx = Math.cos(yaw), hz = Math.sin(yaw);
      // the trailer's kingpin end sits just behind the cab's rear, rotated about it
      const kx = x - hx * (cl / 2 + 0.3), kz = z - hz * (cl / 2 + 0.3), ty = yaw - sg * ang;
      const tx = kx - Math.cos(ty) * (tl / 2), tz = kz - Math.sin(ty) * (tl / 2);
      const fc = tryPlace(Vc, x, z, yaw, 0, { gap: 0.15, dry: true }), ft = tryPlace(Vt, tx, tz, ty, 0, { gap: 0.15, dry: true });
      if (!fc || !ft || !obbGap(fc, ft, 0.15)) continue;
      tryPlace(Vc, x, z, yaw, 0, { gap: 0.15 }); tryPlace(Vt, tx, tz, ty, 0, { gap: 0.15 });
      for (let k = 0; k < 3; ++k) propAt('boxes', k, tx + (Rr() - 0.5) * 12, tz + (Rr() - 0.5) * 12, Rr() * 6);
      propAt('debris', 3, x + hx * 6, z + hz * 6, Rr() * 6);
      usedSpots.push([x, z]); stats.sets.push({ type: 'jackknife', x: Math.round(x), z: Math.round(z) });
      return true;
    }
    return false;
  };
  const garbage = (r, s) => {
    const Rr = C.mulberry32(hashS('garb' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1, u = (e.left + e.right) / 2;
    const [x, z] = frame(r, s, u), base = laneHeading(r, s, u, 4, d);
    for (const dy of [0.35, -0.35, 0.6, -0.6, 0.2, -0.2]) for (const roll of [1, 2]) {
      const V = vehicle('garbage_truck', { ps: 0, seed: 1, state: 'damaged', roll: 1 });
      const f = tryPlace(V, x, z, base + dy, roll, { gap: 0.15 });
      if (!f) continue;
      let nb = 0;
      for (let k = 0; k < 18 && nb < 6; ++k) { const a = Rr() * 6.283, rr = 5 + Rr() * 4; if (propAt('bags', k % 4, f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr, Rr() * 6)) ++nb; }
      usedSpots.push([f.x, f.z]); stats.sets.push({ type: 'garbage', x: Math.round(f.x), z: Math.round(f.z) });
      return true;
    }
    return false;
  };
  const busCrash = (r, s) => {
    const Rr = C.mulberry32(hashS('bus' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Rr() < 0.5 ? 0 : lanes.length - 1], d = e.dir || 1, u = (e.left + e.right) / 2;
    const [x, z] = frame(r, s, u), base = laneHeading(r, s, u, 6, d);
    const kind = Rr() < 0.5 ? 'school_bus' : 'city_bus';
    const V = vehicle(kind, { ps: 0, seed: 1, state: 'crashed', doors: 'side' });
    for (const dy of [0.25, -0.25, 0.4, -0.4, 0.15, -0.15]) {
      const f = tryPlace(V, x, z, base + dy, 0, { gap: 0.15 });
      if (!f) continue;
      const Vc = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 3, state: 'crashed' });
      const fx = Math.cos(base + dy), fz = Math.sin(base + dy);
      for (const dd of [8.2, 9, 10, 11]) if (tryPlace(Vc, f.x + fx * dd, f.z + fz * dd, base + dy + 1.2 + Rr() * 0.6, 0, { gap: 0.15 })) break;
      for (let k = 0; k < 3; ++k) propAt('luggage', k, f.x + (Rr() - 0.5) * 10, f.z + (Rr() - 0.5) * 10, Rr() * 6);
      propAt('debris', 7, f.x + fx * 6, f.z + fz * 6, Rr() * 6);
      usedSpots.push([f.x, f.z]); stats.sets.push({ type: kind, x: Math.round(f.x), z: Math.round(f.z) });
      return true;
    }
    return false;
  };
  // ambulance cluster: 2-3 ambulances and a cruiser around a crash, stretchers, cones
  const ambCluster = (r, s) => {
    const Rr = C.mulberry32(hashS('amb' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const [x, z, tx, tz] = frame(r, s, 0), base = Math.atan2(tz, tx);
    const Vw = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 1, state: 'crashed' });
    const e0 = lanes[Math.floor(Rr() * lanes.length)], u0 = (e0.left + e0.right) / 2;
    const [wx, wz] = frame(r, s, u0);
    if (!tryPlace(Vw, wx, wz, base + 0.9 + Rr() * 0.6, 0, { gap: 0.15 })) return false;
    let n = 0;
    for (let k = 0; k < 10 && n < 3; ++k) {
      const e = lanes[k % lanes.length], u = (e.left + e.right) / 2 + (Rr() - 0.5) * 0.6, ss = s + (k % 2 ? 1 : -1) * (7 + Rr() * 6);
      const kind = n < 2 ? 'ambulance' : 'police';
      const V = vehicle(kind, { ps: 0, seed: 0, state: 'ok', lights: true, doors: kind === 'ambulance' ? 'rear' : 'side' });
      const [px, pz] = frame(r, ss, u), yaw = laneHeading(r, ss, u, 3, e.dir || 1) + (Rr() - 0.5) * 0.4;
      const f = tryPlace(V, px, pz, yaw, 0, { gap: 0.15 });
      if (!f) continue;
      ++n;
      if (kind === 'ambulance') propAt('stretcher', 0, f.x - f.c * (f.hx + 1.6), f.z - f.s * (f.hx + 1.6), Math.atan2(f.s, f.c) + 0.4);
    }
    for (let k = 0; k < 6; ++k) propAt('cone', 0, x + (Rr() - 0.5) * 16, z + (Rr() - 0.5) * 16, 0);
    usedSpots.push([x, z]); stats.sets.push({ type: 'ambulances', x: Math.round(x), z: Math.round(z), n });
    return n >= 1;
  };
  // police roadblock across the outbound carriageway, a gap left at the kerb side
  const roadblock = (r, s, d) => {
    const Rr = C.mulberry32(hashS('rb' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r).filter(e => e.dir === d);
    if (!lanes.length || r.P.cls !== 'arterial') return false;
    const uA = Math.max(...lanes.map(e => e.left)), uB = Math.min(...lanes.map(e => e.right));
    const [x, z, tx, tz] = frame(r, s, 0);
    const Vp = vehicle('police', { ps: 0, seed: 0, state: 'ok', lights: true, doors: 'side' });
    const n = Math.max(2, lanes.length), spots = [];
    for (let k = 0; k < n; ++k) {
      const u = uB + (uA - uB) * (k + 0.5) / n;
      const [px, pz] = frame(r, s + (k % 2) * 2.2, u);
      spots.push([px, pz, Math.atan2(tz, tx) + (k % 2 ? 0.75 : -0.75) + (Rr() - 0.5) * 0.2]);
    }
    const tmp = [];
    for (const [px, pz, yaw] of spots) {
      const f = tryPlace(Vp, px, pz, yaw, 0, { gap: 0.15, dry: true });
      if (!f || tmp.some(g => !obbGap(g, f, 0.3))) return false;
      tmp.push(f);
    }
    let placed = 0;
    for (const [px, pz, yaw] of spots) if (tryPlace(Vp, px, pz, yaw, 0, { gap: 0.15 })) ++placed;
    const sb = s + d * 6;
    for (let k = 0; k <= n * 2; ++k) {
      const u = uB + 0.8 + (uA - uB - 1.6) * k / Math.max(1, n * 2);
      const [px, pz] = frame(r, sb + (Rr() - 0.5), u);
      if (k % 2 === 0) propAt('barrier', 0, px, pz, Math.atan2(tz, tx) + Math.PI / 2 + (Rr() - 0.5) * 0.3); else propAt('cone', 0, px, pz, Rr() * 6);
    }
    usedSpots.push([x, z]); stats.sets.push({ type: 'roadblock', x: Math.round(x), z: Math.round(z) });
    r._roadblock = { s, d };
    return placed >= 2;
  };
  {
    const want = 6 + Math.floor(Rg() * 5);
    const plan = shuffle(['tanker', 'tanker', 'garbage', 'garbage', 'bus', 'bus', 'roadblock', 'roadblock', 'ambulances', 'ambulances', 'jackknife'], Rg);
    // the first of each type is guaranteed a try first
    plan.sort((a, c) => plan.indexOf(a) - plan.indexOf(c));
    const order = []; for (const t of plan) if (!order.includes(t)) order.push(t); for (const t of plan) if (order.filter(x => x === t).length < plan.filter(x => x === t).length) order.push(t);
    const spotsArt = shuffle(midSpots((r, s) => !downtown(r) || radial(r, s).dist > 120, 14), Rg);
    let done = 0;
    for (const type of order) {
      if (done >= want) break;
      if (type === 'roadblock') {
        const cands = [];
        for (const r of through) for (const d of [1, -1]) {
          if (r.P.cls !== 'arterial' || !laneEdges(r).some(e => e.dir === d)) continue;
          for (let s = 20; s < r.len - 20; s += 10) {
            if (inJ(r, s, 12)) continue;
            const q = radial(r, s), edge = Math.min(q.x - b.x0, b.x1 - q.x, q.z - b.z0, b.z1 - q.z);
            if (edge < 25 || edge > 160 || outDensity(r, s, d) < 0.6) continue;
            cands.push([r, s, d, Rg()]);
          }
        }
        cands.sort((a, c) => a[3] - c[3]);
        for (const [r, s, d] of cands) { const q = radial(r, s); if (!farFromUsed(q.x, q.z, 90)) continue; if (roadblock(r, s, d)) { ++done; break; } }
        continue;
      }
      const fn = { tanker, garbage, bus: busCrash, ambulances: ambCluster, jackknife }[type];
      for (const [r, s] of spotsArt) {
        const q = radial(r, s); if (q.dist < 60 || !farFromUsed(q.x, q.z, 90)) continue;
        if (type === 'garbage' && r.P.cls === 'arterial' && Rg() < 0.5) continue;
        if (fn(r, s)) { ++done; break; }
      }
    }
  }

  // ================================================================== small incidents (x3)
  const smallBudget = 120 + Math.floor(Rg() * 45);
  const incidentKinds = { pileup: 7, lamp: 5, burnt: 6, ambulance: 2, sidewalk: 5, delivery: 3, abandoned: 6, police: 2 };
  const pileup = (r, j, d, Rr) => {
    const lanes = laneEdges(r).filter(e => e.dir === d); if (!lanes.length) return false;
    const sEdge = d > 0 ? j.a : j.b;
    const e = lanes[Math.floor(Rr() * lanes.length)], u = (e.left + e.right) / 2;
    let s = sEdge - d * 0.5, n = 0, prevHalf = 0;
    const N = 2 + Math.floor(Rr() * 4);
    for (let k = 0; k < N; ++k) {
      const V = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 0, state: 'crashed' });
      const half = (V.bb.x1 - V.bb.x0) / 2;
      s -= d * (prevHalf + half + 0.35 + Rr() * 0.4);
      prevHalf = half;
      if (s < 3 || s > r.len - 3) break;
      const uu = u + (Rr() - 0.5) * 1.2;
      const [x, z] = frame(r, s, uu), yaw = laneHeading(r, s, uu, half, d) + (Rr() - 0.5) * (k === 0 ? 1.0 : 0.6);
      if (tryPlace(V, x, z, yaw, 0, { gap: 0.15 })) ++n; else if (k === 0) return false;
    }
    if (n >= 2) { const [x, z] = frame(r, sEdge - d * 4, u); propAt('debris', n, x, z, Rr() * 6); usedSpots.push([x, z]); }
    return n >= 2;
  };
  const intoPost = (p, Rr) => {
    const r = net.roads[p.road]; if (!r || r.P.id === 'alley') return false;
    let bs = 0, bd = 1e9; for (let s = 0; s < r.len; s += 1) { const [x, z] = frame(r, s, 0); const dd = Math.hypot(x - p.x, z - p.z); if (dd < bd) { bd = dd; bs = s; } }
    if (inJ(r, bs, 1)) return false;
    const [cx, cz, tx, tz] = frame(r, bs, 0);
    const side = ((p.x - cx) * tz - (p.z - cz) * tx) > 0 ? 1 : -1;
    const V = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 1, state: 'crashed' });
    const half = (V.bb.x1 - V.bb.x0) / 2;
    const ang = 0.3 + Rr() * 0.45, dirS = Rr() < 0.5 ? 1 : -1;
    const hx = dirS * tx * Math.cos(ang) + side * tz * Math.sin(ang), hz = dirS * tz * Math.cos(ang) - side * tx * Math.sin(ang);
    for (const back of [0.9, 1.3, 1.7, 2.2, 2.8, 3.4]) {
      const x = p.x - hx * (half + back), z = p.z - hz * (half + back);
      if (tryPlace(V, x, z, Math.atan2(hz, hx), 0, { gap: 0.15 })) return true;
    }
    return false;
  };
  const single = (type, r, s, Rr) => {
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1;
    let u = (e.left + e.right) / 2 + (Rr() - 0.5) * 1.0;
    let kind, st = 'ok', doors = null, jit = 0.25, after = null;
    if (type === 'burnt') { kind = incKind(Rr); st = 'burnt'; jit = 0.8; }
    else if (type === 'ambulance') { kind = 'ambulance'; doors = 'rear'; jit = 0.35; after = (f) => { propAt('stretcher', 0, f.x - f.c * (f.hx + 1.6), f.z - f.s * (f.hx + 1.6), Math.atan2(f.s, f.c) + 0.4); for (let k = 0; k < 3; ++k) propAt('cone', 0, f.x + f.c * (f.hx + 1.5 + k * 1.2) - f.s * 1.6, f.z + f.s * (f.hx + 1.5 + k * 1.2) + f.c * 1.6, 0); }; }
    else if (type === 'delivery') { kind = Rr() < 0.5 ? 'delivery_van' : 'panel_van'; doors = 'rear'; jit = 0.2; after = (f) => { for (let k = 0; k < 2; ++k) propAt('boxes', k, f.x - f.c * (f.hx + 1.2 + k * 1.6), f.z - f.s * (f.hx + 1.2 + k * 1.6), Rr() * 6); }; }
    else if (type === 'police') { kind = 'police'; doors = 'both'; jit = 0.9; after = (f) => { for (let k = 0; k < 3; ++k) propAt('cone', 0, f.x + (Rr() - 0.5) * 8, f.z + (Rr() - 0.5) * 8, 0); }; }
    else { kind = incKind(Rr); doors = Rr() < 0.7 ? (Rr() < 0.3 ? 'both' : 'side') : null; jit = 0.6; after = (f) => { if (Rr() < 0.7) propAt('luggage', Math.floor(Rr() * 4), f.x + f.s * (f.hz + 1.2) * (Rr() < 0.5 ? 1 : -1), f.z - f.c * (f.hz + 1.2), Rr() * 6); }; }
    const V = vehicle(kind, { ps: pickPaint(Rr), seed: 0, state: st, doors, lights: kind === 'police' || kind === 'ambulance' });
    for (let t = 0; t < 4; ++t) {
      const [x, z] = frame(r, s, u), yaw = laneHeading(r, s, u, 2.5, d) + (Rr() - 0.5) * jit;
      const f = tryPlace(V, x, z, yaw, 0);
      if (f) { if (after) after(f); return true; }
      u = (e.left + e.right) / 2 + (Rr() - 0.5) * 0.6; s += (Rr() - 0.5) * 6;
    }
    return false;
  };
  const sidewalkCar = (r, s, Rr) => {
    if (!r.P.sidewalk || r.P.sidewalk < 3.3) return false;
    const side = Rr() < 0.5 ? 1 : -1, u = side * (r.P.half + r.P.sidewalk / 2);
    const V = vehicle(Rr() < 0.7 ? incKind(Rr) : 'hatchback', { ps: pickPaint(Rr), seed: 0, state: 'ok', doors: Rr() < 0.5 ? 'side' : null });
    if (V.bb.x1 - V.bb.x0 > 5.3) return false;
    const [x, z, tx, tz] = frame(r, s, u);
    for (const dy of [0.12, -0.12, 0.2, -0.2, 0.05]) {
      const yaw = Math.atan2(tz, tx) + dy + (Rr() < 0.5 ? Math.PI : 0);
      if (tryPlace(V, x, z, yaw, 0, { walk: true, gap: 0.2 })) return true;
    }
    return false;
  };
  {
    let placed = 0, tries = 0;
    const lh = lampsAndHydrants.slice();
    const poolWalk = roads.filter(r => r.P.sidewalk >= 3.3);
    while (placed < smallBudget && tries++ < smallBudget * 12) {
      const type = pickW(Rg, incidentKinds);
      const Rr = C.mulberry32((seed * 131 + tries * 7919) >>> 0);
      let ok = false;
      if (type === 'pileup') {
        const r = through[Math.floor(Rr() * through.length)], J = majorJ(r);
        if (!J.length) continue;
        const j = J[Math.floor(Rr() * J.length)], d = Rr() < 0.5 ? 1 : -1;
        const [x, z] = frame(r, d > 0 ? j.a : j.b, 0);
        if (!farFromUsed(x, z, 22)) continue;
        ok = pileup(r, j, d, Rr);
      } else if (type === 'lamp') {
        if (!lh.length) continue;
        const p = lh[Math.floor(Rr() * lh.length)];
        if (!farFromUsed(p.x, p.z, 22)) continue;
        ok = intoPost(p, Rr); if (ok) usedSpots.push([p.x, p.z]);
      } else {
        const pool = type === 'sidewalk' ? poolWalk : roads;
        if (!pool.length) continue;
        const r = pool[Math.floor(Rr() * pool.length)], s = 8 + Rr() * Math.max(1, r.len - 16);
        if (inJ(r, s, 4)) continue;
        const [x, z] = frame(r, s, 0);
        if (!farFromUsed(x, z, 18)) continue;
        ok = type === 'sidewalk' ? sidewalkCar(r, s, Rr) : single(type, r, s, Rr);
        if (ok) usedSpots.push([x, z]);
      }
      if (ok) { ++placed; inc(type); }
    }
  }

  // ================================================================== the evacuation: lanes, parking lanes, stalls
  // a lane walker: cars bumper to bumper in travel direction d (facing d), density rho(s) in 0..1
  const fillLane = (r, uC, d, rho, opt) => {
    const Rr = opt.R;
    let s = d > 0 ? 3 : r.len - 3, count = 0, run = 0;
    if (opt.tag) { const T = stats.lane[opt.tag] = stats.lane[opt.tag] || { len: 0, ok: 0, obb: 0, surf: 0 }; T.len += Math.round(r.len); }
    const end = (q) => d > 0 ? q > r.len - 3 : q < 3;
    while (!end(s)) {
      const p = rho(s);
      if (p < 0.05) { s += d * 8; continue; }
      if (inJ(r, s, 0.4)) { s += d * 1; if (opt.tag) stats.lane[opt.tag].jlen = (stats.lane[opt.tag].jlen || 0) + 1; continue; }
      if (Rr() > p) { s += d * (2 + Rr() * 6); continue; }
      if (opt.gapEvery && run >= opt.gapEvery) { run = 0; s += d * (6 + Rr() * 4); continue; }       // passable gap
      const kind = vehKind(Rr, opt.mix);
      const abandoned = Rr() < (opt.abandon || 0);
      const doorsP = opt.doors || 0;
      const doors = INC_MIX[kind] && Rr() < doorsP ? (Rr() < 0.25 ? 'both' : 'side') : null;
      const st = opt.state ? opt.state(Rr) : 'ok';
      const vs = 0;
      const V = vehicle(kind, { ps: Math.floor(Rr() * 64), seed: vs, state: st, doors });
      const half = (V.bb.x1 - V.bb.x0) / 2;
      const sc = s + d * half;
      if (end(sc + d * half) || inJ(r, sc, half + 0.4)) { s = sc + d * 1; continue; }
      let u = uC + (Rr() - 0.5) * (opt.jitU || 0);
      if (opt.curb) u = opt.curb.u - opt.curb.sg * ((V.bb.z1 - V.bb.z0) / 2 + 0.22 + Rr() * 0.12);
      const yaw = laneHeading(r, sc, u, half, d) + (abandoned ? (Rr() < 0.5 ? 1 : -1) * (0.3 + Rr() * 0.4) : (Rr() - 0.5) * (opt.jitYaw || 0));
      const [x, z] = frame(r, sc, u);
      const f0 = Object.assign({}, stats.fail);
      const okP = tryPlace(V, x, z, yaw, 0, { gap: opt.gap || 0.2 });
      if (opt.tag) { const T = stats.lane[opt.tag] = stats.lane[opt.tag] || { len: 0, ok: 0, obb: 0, surf: 0 }; if (okP) T.ok++; else if ((stats.fail.obb || 0) > (f0.obb || 0)) T.obb++; else T.surf++; }
      if (okP) { ++count; ++run; s = sc + d * (half + (opt.g0 || 0.9) + Rr() * (opt.g1 || 1.2)); }
      else s = sc + d * 0.6;
    }
    return count;
  };
  // 1. roads that leave the map: every lane is an outbound queue, facing the exit
  const filled = new Set();
  for (const r of roads) {
    const ex = exitDir(r); if (!ex) continue;
    filled.add(r.id);
    for (const e of laneEdges(r)) {
      const Rr = C.mulberry32(hashS('exit' + r.id + ':' + e.left) ^ seed);
      const rb = r._roadblock;
      stats.exit += fillLane(r, (e.left + e.right) / 2, ex, (s) => rb && (ex > 0 ? s > rb.s - 4 : s < rb.s + 4) ? 0.15 : 0.97,
        { tag: 'exit', R: Rr, jitU: 0.4, jitYaw: 0.08, doors: 0.12, abandon: 0.03, gap: 0.2, g0: 0.45, g1: 0.7 });
    }
  }
  // 2. arterials and collectors: congested both ways, heavier outbound; the downtown core lighter with a lane and
  //    gaps kept free
  for (const r of through) {
    if (filled.has(r.id)) continue;
    const lanes = laneEdges(r);
    const dt = downtown(r);
    // downtown: the lane nearest the centre line of direction +1 stays empty (a passable lane)
    const plus = lanes.filter(e => (e.dir || 1) > 0).sort((a, c) => Math.abs((a.left + a.right) / 2) - Math.abs((c.left + c.right) / 2));
    const keep = dt && lanes.length >= 2 ? (plus[0] || lanes[0]) : null;
    for (const e of lanes) {
      if (e === keep) continue;
      const d = e.dir || 1, Rr = C.mulberry32(hashS('art' + r.id + ':' + e.left) ^ seed);
      const rho = (s) => {
        const q = radial(r, s), out = outDensity(r, s, d);
        let p = 0.72 + 0.28 * out;
        p *= 0.72 + 0.28 * sstep(60, 220, q.dist);          // outer and middle city heavy, the core lighter
        if (dt) p *= 0.8;
        return p;
      };
      stats.arterial += fillLane(r, (e.left + e.right) / 2, d, rho, { tag: 'art', R: Rr, jitU: 0.4, jitYaw: 0.1, doors: 0.08, abandon: 0.02, gap: 0.2, g0: 0.5, g1: 0.9, gapEvery: dt ? 4 : 0 });
    }
  }
  // 4. local residential streets: stalled and abandoned cars in the lanes
  for (const r of roads) {
    if (filled.has(r.id) || r.P.cls !== 'local') continue;
    for (const e of laneEdges(r)) {
      const d = e.dir || 1, Rr = C.mulberry32(hashS('loc' + r.id + ':' + e.left) ^ seed);
      stats.stalled += fillLane(r, (e.left + e.right) / 2, d, () => 0.35, { tag: 'loc', R: Rr, mix: PARK_MIX, jitU: 0.5, jitYaw: 0.12, doors: 0.35, abandon: 0.2, gap: 0.25, g0: 2, g1: 8,
        state: (R2) => { const t = R2(); return t < 0.08 ? 'damaged' : t < 0.12 ? 'crashed' : t < 0.15 ? 'burnt' : 'ok'; } });
    }
  }
  // 3. parking lanes: bumper to bumper on every street
  for (const r of roads) {
    const E = r.P.edges;
    for (let k = 0; k < E.length; ++k) {
      const e = E[k]; if (e.type !== 'park') continue;
      const nb = E[k === 0 ? 1 : k - 1], d = (nb && nb.dir) || ((e.left + e.right) / 2 > 0 ? -1 : 1);
      const Rr = C.mulberry32(hashS('park' + r.id + ':' + e.left) ^ seed);
      const curb = k === 0 ? { u: e.left, sg: 1 } : { u: e.right, sg: -1 };
      stats.parked += fillLane(r, (e.left + e.right) / 2, d, () => downtown(r) ? 0.85 : 0.93,
        { tag: 'park', R: Rr, curb, mix: PARK_MIX, jitU: 0.12, jitYaw: 0.03, doors: 0.03, gap: 0.2, g0: 0.45, g1: 0.7, state: (R2) => R2() < 0.04 ? 'damaged' : 'ok' });
    }
  }
  // 5. emergency vehicles driving in against the flow on the through roads
  {
    for (const r of through) {
      const Rr = C.mulberry32(hashS('em' + r.id) ^ seed);
      const n = Math.floor(Rr() * 2.2);
      const lanes = laneEdges(r);
      for (let k = 0; k < n && lanes.length; ++k) {
        const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1;
        const kind = pickW(Rr, { police: 5, ambulance: 3, fire_engine: 1 });
        const V = vehicle(kind, { ps: 0, seed: 0, state: 'ok', lights: true, doors: Rr() < 0.4 ? (kind === 'ambulance' ? 'rear' : 'side') : null });
        for (let t = 0; t < 8; ++t) {
          const s = 10 + Rr() * (r.len - 20); if (inJ(r, s, 6)) continue;
          const u = (e.left + e.right) / 2;
          const [x, z] = frame(r, s, u);
          if (tryPlace(V, x, z, laneHeading(r, s, u, 3, d) + (Rr() - 0.5) * 0.15, 0)) { ++stats.emergency; break; }
        }
      }
    }
  }

  // ---- output: variants (hi / lo meshes in metres) and instance arrays
  const n = inst.length;
  const M = new Float32Array(n * 12), vid = new Uint16Array(n), paint = new Uint8Array(n), obb = new Float32Array(n * 8);
  inst.forEach((I, i) => {
    M.set(I.M, i * 12); vid[i] = I.v; paint[i] = I.paint;
    const f = I.fp; obb.set([f.x, f.z, f.hx, f.hz, f.c, f.s, I.y, I.y + I.h], i * 8);
  });
  stats.vehicles = inst.length - stats.props;
  stats.jam = stats.exit + stats.arterial;
  stats.variants = variants.length;
  stats.lib = VEH && VEH.model ? 'Vehicles' : 'fallback';
  stats.trisHi = 0; stats.trisLo = 0;
  for (let i = 0; i < n; ++i) { const v = variants[vid[i]]; stats.trisHi += v.hi.quads * 2; stats.trisLo += (v.lo ? v.lo.quads : 0) * 2; }
  stats.ms = Date.now() - t0;
  stats.out = {
    paintPH: PAINT_PH,
    variants: variants.map(v => ({ key: v.key, kind: v.kind, n: v.n, bb: v.bb, hi: v.hi, lo: v.lo })),
    M, vid, paint, obb, count: n
  };
  return stats;
}

L.trafficKit = trafficKit;
})();
