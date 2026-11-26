// Traffic kit: the abandoned city after the evacuation. Static vehicle scenes on the roads.
//
// CityArch.lib.trafficKit(K) -> stats      (called from buildAll after every other part, just before the cull pass)
//   K = { PL, C, R, jobs, mb, hs, voxel }
//
// 1. Evacuation jam. Through roads (arterials, collectors) running radially out of the city: the OUTBOUND lanes
//    (direction away from net.origins.core) are bumper to bumper (1-2.5 m gaps, lateral / yaw jitter, now and then
//    pushed onto the parking lane, doors open, a few left crossways), densest near the map edge and thinning towards
//    the core; the downtown grid gets no jam. Inbound lanes stay empty except for a few emergency vehicles driving
//    in against the flow. Junction boxes are kept clear, so every road stays passable.
// 2. Set pieces (2-4 per city): rolled-over fuel tanker across a carriageway with a fuel spill and a burnt-out car,
//    overturned garbage truck with spilled bags, crashed bus, police roadblock (cruisers angled, barriers, cones,
//    a gap left open) at the head of the jam. Dozens of small incidents: pile-ups at junction approaches, cars nosed
//    into lamps / hydrants, burnt-out wrecks with scorch marks, ambulances with open rear doors, cars abandoned on
//    wide sidewalks at odd angles, delivery vans left open with their parcels on the road, luggage, debris.
// 3. Vehicles: CityCore.Vehicles.model() when that library is loaded, else a local box-model fallback. Each
//    (kind, paint, state, doors) variant is meshed once (meshVoxels3D) and emitted as rigidly rotated copies
//    (yaw, plus a roll of 90 / 180 degrees for vehicles on their side / roof) straight into the building mesh.
// 4. Placement: an occupancy grid (0.25 m) holds the building footprints (+3 m for stoops / canopies), every piece
//    of street furniture (CityCore.placeProps is evaluated here with the final footprints and curb cuts, so the
//    result is exactly what the page places afterwards, incl. the curb-parked vans) and every vehicle / prop placed
//    so far. A vehicle is accepted only when its footprint (+0.25 m) is free and every sample of it (+0.15 m) is
//    road-level carriageway (asphalt, paint, parking, crosswalk; never curb, gutter, median, driveway, alley) - or,
//    for cars left on the sidewalk, sidewalk at curb height clear of the curb and the lot line.
// 5. Flat decals (fuel spill, scorch, oil) are single up-facing quads, each 15-40 mm above the road at its own
//    height within the scene (scenes never overlap), so nothing is coplanar with the road or with each other.
// Deterministic per seed. Triangle budget: the jam stops at QUAD_BUDGET quads.
(function () {
'use strict';
const A = self.CityArch, L = A.lib;
const NV = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const QUAD_BUDGET = 280000;                     // ~560 k triangles for the whole kit
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
function trafficKit(K) {
  const { PL, C, R, jobs, mb, hs, voxel } = K;
  if (!PL || !PL.net || !PL.net.roads || PL.net.kind === 'test') return null;
  const t0 = Date.now(), q0 = mb.quads;
  const net = PL.net, F = R.F, seed = (PL.seed || net.seed || 1) >>> 0;
  const MAT = C.MAT;
  const stats = { jam: 0, emergency: 0, sets: [], incidents: {}, props: 0, decals: 0, vehicles: 0, quads: 0, ms: 0, capped: false, propMs: 0 };
  const inc = (k) => { stats.incidents[k] = (stats.incidents[k] || 0) + 1; };
  const core = (net.origins && net.origins.core) || [0, 0];
  const b = net.bounds;

  // ---- library or fallback, cached meshes
  const VEH = C.Vehicles || (self.CityCore && self.CityCore.Vehicles) || null;
  const cache = new Map();
  const PAINT_PH = C.VM ? C.VM.BROWN : -1;
  const LIVERY = new Set(['taxi', 'police', 'ambulance', 'fire_engine', 'school_bus', 'city_bus', 'garbage_truck', 'fuel_tanker', 'tanker_cab', 'tanker_trailer']);
  // o: { ps (paint seed), seed (variant 0..3), state, doors, lights, lod (jam: 10 cm resample of the 5 cm model) }
  const vehicle = (kind, o) => {
    // the body paint is applied at emission: one mesh per (kind, state, doors, lights, variant, lod), painted in a
    // placeholder colour (VM.BROWN) that is swapped for the chosen paint per copy
    const info0 = VEH && VEH.INFO && VEH.INFO[kind];
    const want = !VEH || LIVERY.has(kind) || !info0 ? 0 : (info0.cls === 'car' ? VEH.paints.pick(o.ps | 0) : VEH.paints.pickFleet(o.ps | 0));
    const key = kind + '|' + o.state + '|' + (o.doors ? 1 : 0) + '|' + (o.lights ? 1 : 0) + '|' + (o.seed & 3) + '|' + (o.lod ? 1 : 0) + (VEH ? '' : '|' + (o.ps | 0));
    let v = cache.get(key);
    if (v) return want ? Object.assign({}, v, { paint: want }) : v;
    let mesh = null, sc = VS;
    const tm = Date.now();
    if (VEH && VEH.model) {
      try {
        const info = VEH.INFO && VEH.INFO[kind];
        const paint = LIVERY.has(kind) || !info ? undefined : PAINT_PH;
        const opts = { seed: o.seed & 3, state: o.state === 'rolled' ? 'crashed' : o.state, doors: !!o.doors, lights: !!o.lights };
        if (paint !== undefined) opts.paint = paint;
        if (o.lod) { mesh = C.meshVoxels3D(half(VEH.model(kind, opts).M)); sc = 2 * C.PV; }
        else { mesh = VEH.mesh(kind, opts).mesh; sc = C.PV; }
      } catch (e) { mesh = null; }
    }
    if (!mesh) { const mdl = fallbackModel(C, kind, { paint: PAINTS[(o.ps | 0) % PAINTS.length], seed: o.seed & 3, state: o.state === 'rolled' ? 'crashed' : o.state, doors: o.doors === true ? 'side' : o.doors, lights: o.lights }); mesh = C.meshVoxels3D(mdl.M); sc = mdl.sc; }
    v = { mesh, sc, bb: meshBox(mesh, sc / C.PV), kind };
    cache.set(key, v);
    stats.meshMs = (stats.meshMs || 0) + Date.now() - tm;
    return want ? Object.assign({}, v, { paint: want }) : v;
  };
  // 2x resample of a VoxModel (jam vehicles: about a quarter of the faces); a cell is solid when >= 4 of its 8
  // children are, with their most common material
  function half(S) {
    const w = Math.ceil(S.w / 2), h = Math.ceil(S.h / 2), d = Math.ceil(S.d / 2);
    const D = new C.VoxModel(w, h, d, S.ox / 2, S.oz / 2);
    const cnt = new Map();
    for (let y = 0; y < h; ++y) for (let z = 0; z < d; ++z) for (let x = 0; x < w; ++x) {
      cnt.clear(); let n = 0, best = 0, bm = 0;
      for (let k = 0; k < 8; ++k) {
        const m = S.at(2 * x + (k & 1), 2 * y + ((k >> 1) & 1), 2 * z + (k >> 2));
        if (!m) continue; ++n;
        const c = (cnt.get(m) || 0) + 1; cnt.set(m, c); if (c > best) { best = c; bm = m; }
      }
      if (n >= 4 || (y === 0 && n >= 2)) D.v[(y * d + z) * w + x] = bm;
    }
    return D;
  }
  const prop = (name, vr) => {
    const key = 'p|' + name + '|' + vr;
    let v = cache.get(key);
    if (v) return v;
    const p = propModel(C, name, 977 * vr + 13);
    const mesh = C.meshVoxels3D(p.M);
    v = { mesh, sc: p.sc, bb: meshBox(mesh, p.sc / C.PV) };
    cache.set(key, v);
    return v;
  };
  function meshBox(m, f) {
    let x0 = 1e9, x1 = -1e9, y1 = 0, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < m.quads * 4; ++i) { const x = m.pos[i * 3] * f, y = m.pos[i * 3 + 1] * f, z = m.pos[i * 3 + 2] * f; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return { x0, x1, y1, z0, z1 };
  }

  // ---- emission (world metres; y relative to the road surface y = 0)
  const quadW = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, m, Nx, Ny, Nz) => {
    const v = voxel;
    const Ax = ax / v, Ay = ay / v, Az = az / v, Bx = bx / v, By = by / v, Bz = bz / v;
    const Cx = cx / v, Cy = cy / v, Cz = cz / v, Dx = dx / v, Dy = dy / v, Dz = dz / v;
    const ux = Bx - Ax, uy = By - Ay, uz = Bz - Az, vx = Cx - Ax, vy = Cy - Ay, vz = Cz - Az;
    const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
    if (crx * Nx + cry * Ny + crz * Nz < 0) mb.quadN(Ax, Ay, Az, Dx, Dy, Dz, Cx, Cy, Cz, Bx, By, Bz, m, Nx, Ny, Nz);
    else mb.quadN(Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz, Dx, Dy, Dz, m, Nx, Ny, Nz);
  };
  // model point (u along +x, w up, v along +z) -> rolled about +x by roll (0, 1 = on its side, 2 = on its roof)
  const rollP = (u, w, v, roll, bb) => {
    if (roll === 1) return [u, v - bb.z0, bb.y1 / 2 - w];
    if (roll === 2) return [u, bb.y1 - w, -v];
    return [u, w, v];
  };
  const put = (V, x, y, z, yaw, roll) => {
    roll = roll || 0;
    const m = V.mesh, c = Math.cos(yaw), s = Math.sin(yaw), P = m.pos, f = V.sc / C.PV, bb = V.bb;
    const X = new Float64Array(4), Y = new Float64Array(4), Z = new Float64Array(4);
    for (let q = 0; q < m.quads; ++q) {
      const n = m.nrm[q * 4], o = q * 12;
      let N = NV[n];
      N = roll === 1 ? [N[0], N[2], -N[1]] : roll === 2 ? [N[0], -N[1], -N[2]] : N;
      let ground = true;
      for (let i = 0; i < 4; ++i) {
        const p = rollP(P[o + i * 3] * f, P[o + i * 3 + 1] * f, P[o + i * 3 + 2] * f, roll, bb);
        X[i] = x + p[0] * c - p[2] * s; Y[i] = y + p[1]; Z[i] = z + p[0] * s + p[2] * c;
        if (p[1] > 1e-6) ground = false;
      }
      if (ground && N[1] < -0.5) continue;                       // rests on the road
      let mt = m.mat[q * 4]; if (V.paint && mt === PAINT_PH) mt = V.paint;
      quadW(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], X[3], Y[3], Z[3], mt, N[0] * c - N[2] * s, N[1], N[0] * s + N[2] * c);
    }
  };
  // footprint of a placed model: [cx, cz, hx (half along), hz (half across), yaw] in world metres
  const fpOf = (V, x, z, yaw, roll) => {
    const bb = V.bb;
    let lx0 = bb.x0, lx1 = bb.x1, lz0 = bb.z0, lz1 = bb.z1;
    if (roll === 1) { lz0 = -bb.y1 / 2; lz1 = bb.y1 / 2; }
    if (roll === 2) { lz0 = -bb.z1; lz1 = -bb.z0; }
    const mx = (lx0 + lx1) / 2, mz = (lz0 + lz1) / 2, c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: x + mx * c - mz * s, z: z + mx * s + mz * c, hx: (lx1 - lx0) / 2, hz: (lz1 - lz0) / 2, c, s };
  };

  // ---- occupancy grid (0.25 m): 1 = taken, 2 = near a building (sidewalk cars keep off)
  const G = 0.25, gx0 = b.x0 - 4, gz0 = b.z0 - 4, gw = Math.ceil((b.x1 - b.x0 + 8) / G), gd = Math.ceil((b.z1 - b.z0 + 8) / G);
  const grid = new Uint8Array(gw * gd);
  const stampRect = (cx, cz, hx, hz, c, s, val, pad) => {
    const ex = hx + pad, ez = hz + pad, rx = Math.abs(c) * ex + Math.abs(s) * ez, rz = Math.abs(s) * ex + Math.abs(c) * ez;
    const i0 = Math.max(0, Math.floor((cx - rx - gx0) / G)), i1 = Math.min(gw - 1, Math.floor((cx + rx - gx0) / G));
    const j0 = Math.max(0, Math.floor((cz - rz - gz0) / G)), j1 = Math.min(gd - 1, Math.floor((cz + rz - gz0) / G));
    let hit = 0;
    for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) {
      const px = gx0 + (i + 0.5) * G - cx, pz = gz0 + (j + 0.5) * G - cz;
      const a = px * c + pz * s, d = -px * s + pz * c;
      if (Math.abs(a) > ex || Math.abs(d) > ez) continue;
      if (val) grid[j * gw + i] |= val; else hit |= grid[j * gw + i];
    }
    return hit;
  };
  // building footprints (+3 m: stoops, canopies, porches)
  for (const J of jobs) {
    const w = J.W * 0.25, d = J.D * 0.25, cx = J.O[0] + J.e1[0] * w / 2 + J.e2[0] * d / 2, cz = J.O[1] + J.e1[1] * w / 2 + J.e2[1] * d / 2;
    stampRect(cx, cz, w / 2, d / 2, J.e1[0], J.e1[1], 1, 0.3);
    const stoops = J.kind === 'row' || J.kind === 'house' || J.type === 'prewar_apartment';
    stampRect(cx, cz, w / 2, d / 2, J.e1[0], J.e1[1], 2, stoops ? 3.0 : 1.0);
  }
  // street furniture, exactly as the page will place it (final footprints, final curb cuts)
  const tp = Date.now();
  let props = [];
  try {
    const footprints = jobs.map(J => ({ O: J.O, e1: J.e1, e2: J.e2, w: J.W * 0.25, d: J.D * 0.25, kind: J.kind, type: J.type }));
    props = C.placeProps({ net, F, R, voxel, footprints });
  } catch (e) { props = []; }
  stats.propMs = Date.now() - tp;
  const PR = { lamp: 0.5, lamp2: 0.6, hydrant: 0.45, signal: 0.6, signalLong: 0.6, signalL: 0.6, signalLongL: 0.6, stop: 0.4, tree: 1.6, bench: 1.1,
    hotdog: 1.2, newsstand: 1.6, cafe: 1.5, busstop: 2.3, busSign: 0.35, bikerack: 1.3, bikerackBike: 1.3, news3: 1.0, news4: 1.2, cabinet: 0.8 };
  const lampsAndHydrants = [];
  for (const p of props) {
    if (/^(van|truck|rolloff)/.test(p.type)) {
      const half = p.type.startsWith('truck') ? 3.9 : p.type.startsWith('van') ? 2.95 : 3.1;
      stampRect(p.x, p.z, half + 0.2, 1.3, Math.cos(p.yaw), -Math.sin(p.yaw), 1, 0);
      continue;
    }
    const r = PR[p.type] || 0.6;
    stampRect(p.x, p.z, r, r, 1, 0, 1, 0);
    if (p.type === 'lamp' || p.type === 'hydrant') lampsAndHydrants.push(p);
  }

  // ---- surface tests
  const o = {}, cls = [0, 0];
  const ROADM = new Set([MAT.ASPHALT, MAT.ASPHALT_B, MAT.ASPHALT_C, MAT.PAINT_WHITE, MAT.PAINT_YELLOW, MAT.PARKING, MAT.CROSSWALK]);
  const WALKM = new Set([MAT.SIDEWALK, MAT.SIDEWALK_JOINT]);
  const surfOK = (fp, pad, walk) => { const ts = Date.now(); const r = surfOK0(fp, pad, walk); stats.surfMs = (stats.surfMs || 0) + Date.now() - ts; return r; };
  const surfOK0 = (fp, pad, walk) => {
    const ex = fp.hx + pad, ez = fp.hz + pad, nu = Math.max(2, Math.ceil(ex / 0.6)), nv = Math.max(2, Math.ceil(ez / 0.6));
    for (let a = -nu; a <= nu; ++a) for (let d = -nv; d <= nv; ++d) {
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
  // place a vehicle / prop if it fits; returns the footprint or null
  let budgetHit = false;
  const tryPlace = (V, x, z, yaw, roll, opt) => {
    opt = opt || {};
    const fp = fpOf(V, x, z, yaw, roll || 0);
    const gap = opt.gap === undefined ? 0.25 : opt.gap;
    if (stampRect(fp.x, fp.z, fp.hx, fp.hz, fp.c, fp.s, 0, gap) & (opt.walk ? 3 : 1)) return null;
    if (!surfOK(fp, opt.walk ? 0.2 : 0.15, !!opt.walk)) return null;
    if (opt.dry) return fp;
    stampRect(fp.x, fp.z, fp.hx, fp.hz, fp.c, fp.s, 1, 0.05);
    put(V, x, opt.walk ? hs : (opt.y || 0), z, yaw, roll || 0);
    return fp;
  };
  // decal: rotated rectangle at height y (m above road)
  const decal = (x, z, yaw, hu, hv, y, m) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const W = (u, v) => [x + u * c - v * s, z + u * s + v * c];
    // keep decals on road-level surface: every corner and the centre must be carriageway
    for (const [u, v] of [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv], [0, 0]]) { const [px, pz] = W(u, v); R.classify(px, pz, o, cls); if (cls[0] !== 0 || o.road < 0) return false; }
    const p = [W(-hu, -hv), W(hu, -hv), W(hu, hv), W(-hu, hv)];
    quadW(p[0][0], y, p[0][1], p[1][0], y, p[1][1], p[2][0], y, p[2][1], p[3][0], y, p[3][1], m, 0, 1, 0);
    ++stats.decals;
    return true;
  };
  const decalBlob = (Rr, x, z, rad, m, n) => {     // irregular stain: n rectangles at distinct heights 15..40 mm
    let k = 0;
    for (let i = 0; i < n; ++i) {
      const a = Rr() * 6.283, r = Rr() * rad * 0.6;
      if (decal(x + Math.cos(a) * r, z + Math.sin(a) * r, Rr() * 3.14, rad * (0.35 + Rr() * 0.5), rad * (0.25 + Rr() * 0.4), 0.015 + 0.003 * k, m)) ++k;
      if (k >= 8) break;
    }
    return k;
  };
  const propAt = (name, vr, x, z, yaw) => { const V = prop(name, vr); const f = tryPlace(V, x, z, yaw, 0, { gap: 0.1 }); if (f) ++stats.props; return f; };

  // ---- road frames
  const roads = net.roads.filter(r => r.len && r.P && r.P.id !== 'alley');
  const frame = (r, s, u) => { const [px, pz, tx, tz] = C.pointAt(r, s); return [px + tz * u, pz - tx * u, tx, tz]; };
  // heading along a lane over a vehicle length (chord of the curve)
  const laneHeading = (r, s, u, half, d) => {
    const [ax, az] = frame(r, clamp(s - half, 0, r.len), u), [bx, bz] = frame(r, clamp(s + half, 0, r.len), u);
    return Math.atan2(d * (bz - az), d * (bx - ax));
  };
  const majorJ = (r) => (r.junctions || []).filter(j => j.major);
  const inJ = (r, s, pad) => (r.junctions || []).some(j => s > j.a - pad && s < j.b + pad);
  const Rg = C.mulberry32(seed * 7919 + 17);
  const pickPaint = (Rr) => Math.floor(Rr() * 64);
  const CAR_MIX = { sedan: 26, suv: 18, hatchback: 10, pickup: 12, minivan: 10, coupe: 5, taxi: 3, panel_van: 5, box_truck: 2.5, delivery_van: 2.5, semi: 1.2, city_bus: 0.6, school_bus: 0.6 };
  const vehKind = (Rr) => pickW(Rr, CAR_MIX);
  const INC_MIX = { sedan: 30, suv: 22, pickup: 16, hatchback: 12, minivan: 10 };
  const incKind = (Rr) => pickW(Rr, INC_MIX);         // incident cars: few kinds, so few meshed variants
  const laneEdges = (r) => r.P.edges.filter(e => e.type === 'lane');

  // ================================================================== set pieces
  const through = roads.filter(r => r.P.cls === 'arterial' || r.P.cls === 'collector');
  const radial = (r, s) => { const [x, z, tx, tz] = frame(r, s, 0); const dx = x - core[0], dz = z - core[1], dl = Math.hypot(dx, dz) || 1; return { x, z, dist: dl, cos: (tx * dx + tz * dz) / dl }; };
  // candidate mid-block spots on through roads: [road, s]
  const midSpots = (filter, pad) => {
    const out = [];
    for (const r of through) for (let s = 15; s < r.len - 15; s += 9) { if (inJ(r, s, pad)) continue; if (filter && !filter(r, s)) continue; out.push([r, s]); }
    return out;
  };
  const shuffle = (a, Rr) => { for (let i = a.length - 1; i > 0; --i) { const j = Math.floor(Rr() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const usedSpots = [];
  const farFromUsed = (x, z, d) => usedSpots.every(([a, c]) => Math.hypot(a - x, c - z) > d);

  // tanker rollover: tanker on its side across one carriageway (diagonal), fuel spill, burnt car, debris
  const tanker = (r, s) => {
    const Rr = C.mulberry32(hashS('tank' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1;
    const u = (e.left + e.right) / 2;
    const [x, z] = frame(r, s, u);
    const base = laneHeading(r, s, u, 5, d);
    const lib = VEH && VEH.INFO && VEH.INFO.tanker_trailer;
    const V = vehicle(lib ? 'tanker_trailer' : 'fuel_tanker', { ps: 0, seed: 1, state: 'damaged' });
    const Vcab = lib ? vehicle('tanker_cab', { ps: 0, seed: 1, state: 'crashed', doors: true }) : null;
    for (const dy of [0.42, -0.42, 0.3, -0.3, 0.55, -0.55, 0.2, -0.2]) {
      for (const du of [0, 1.2, -1.2, 2.2, -2.2]) {
        const xx = x + Math.cos(base + Math.PI / 2) * du, zz = z + Math.sin(base + Math.PI / 2) * du;
        const f = tryPlace(V, xx, zz, base + dy, 1);
        if (!f) continue;
        if (Vcab) {     // the tractor, torn off the fifth wheel and jackknifed in front of the trailer
          const hx = Math.cos(base + dy), hz = Math.sin(base + dy), cl = (Vcab.bb.x1 - Vcab.bb.x0) / 2;
          for (const [dd, a] of [[1.0, -0.9], [1.0, 0.9], [1.5, -1.3], [1.5, 1.3], [2.5, -0.5], [2.5, 0.5]]) {
            const cy = base + dy + a, ex = f.x + hx * (f.hx + dd), ez = f.z + hz * (f.hx + dd);
            if (tryPlace(Vcab, ex + Math.cos(cy) * (cl + 0.2), ez + Math.sin(cy) * (cl + 0.2), cy, 0, { gap: 0.15 })) break;
          }
        }
        decalBlob(Rr, f.x - Math.sin(base + dy) * 3, f.z + Math.cos(base + dy) * 3, 5.5, M.SPILL, 7);
        const Vb = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 2, state: 'burnt' });
        for (let k = 0; k < 12; ++k) {
          const a = Rr() * 6.283, rr = 6 + Rr() * 5;
          const g = tryPlace(Vb, f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr, base + (Rr() - 0.5) * 1.6, 0);
          if (g) { decalBlob(Rr, g.x, g.z, 3.2, M.SCORCH, 3); break; }
        }
        for (let k = 0; k < 4; ++k) propAt('debris', k, f.x + (Rr() - 0.5) * 14, f.z + (Rr() - 0.5) * 14, Rr() * 6);
        usedSpots.push([f.x, f.z]); stats.sets.push({ type: 'tanker', x: Math.round(f.x), z: Math.round(f.z) });
        return true;
      }
    }
    return false;
  };
  const garbage = (r, s) => {
    const Rr = C.mulberry32(hashS('garb' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1, u = (e.left + e.right) / 2;
    const [x, z] = frame(r, s, u), base = laneHeading(r, s, u, 4, d);
    const V = vehicle('garbage_truck', { ps: 0, seed: 1, state: 'damaged' });
    for (const dy of [0.35, -0.35, 0.6, -0.6, 0.2, -0.2]) for (const roll of [1, 2]) {
      const f = tryPlace(V, x, z, base + dy, roll);
      if (!f) continue;
      let nb = 0;
      for (let k = 0; k < 18 && nb < 6; ++k) { const a = Rr() * 6.283, rr = 5 + Rr() * 4; if (propAt('bags', k % 4, f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr, Rr() * 6)) ++nb; }
      decalBlob(Rr, f.x - Math.cos(base + dy) * 5.5, f.z - Math.sin(base + dy) * 5.5, 3, M.SCORCH, 3);
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
    const V = vehicle(kind, { ps: Math.floor(Rr() * 3), seed: 1, state: 'crashed', doors: 'side' });
    for (const dy of [0.25, -0.25, 0.4, -0.4, 0.15, -0.15]) {
      const f = tryPlace(V, x, z, base + dy, 0);
      if (!f) continue;
      // the car it hit, crumpled, in front
      const Vc = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 3, state: 'crashed' });
      const fx = Math.cos(base + dy), fz = Math.sin(base + dy);
      for (const dd of [8.2, 9, 10]) if (tryPlace(Vc, f.x + fx * dd, f.z + fz * dd, base + dy + 1.2 + Rr() * 0.6, 0, { gap: 0.15 })) break;
      for (let k = 0; k < 3; ++k) propAt('luggage', k, f.x + (Rr() - 0.5) * 10, f.z + (Rr() - 0.5) * 10, Rr() * 6);
      propAt('debris', 7, f.x + fx * 6, f.z + fz * 6, Rr() * 6);
      usedSpots.push([f.x, f.z]); stats.sets.push({ type: kind, x: Math.round(f.x), z: Math.round(f.z) });
      return true;
    }
    return false;
  };
  // police roadblock across the outbound carriageway at the head of a jam, a 3 m gap left at the kerb side
  const roadblock = (r, s, d) => {
    const Rr = C.mulberry32(hashS('rb' + r.id + ':' + Math.round(s)) ^ seed);
    const lanes = laneEdges(r).filter(e => e.dir === d);
    if (!lanes.length) return false;
    const uA = Math.max(...lanes.map(e => e.left)), uB = Math.min(...lanes.map(e => e.right));
    const [x, z, tx, tz] = frame(r, s, 0);
    const placed = [];
    const Vp = vehicle('police', { ps: 0, seed: 0, state: 'ok', lights: true, doors: 'side' });
    if (r.P.cls !== 'arterial') return false;
    const n = Math.max(2, lanes.length);
    const spots = [];
    for (let k = 0; k < n; ++k) {
      const u = uB + (uA - uB) * (k + 0.5) / n;
      const [px, pz] = frame(r, s + (k % 2) * 2.2, u);
      const yaw = Math.atan2(tz, tx) + (k % 2 ? 0.75 : -0.75) + (Rr() - 0.5) * 0.2;
      spots.push([px, pz, yaw]);
    }
    // all cruisers must fit (tested before anything is emitted), else this spot is refused
    const tmp = [];
    for (const [px, pz, yaw] of spots) {
      const f = tryPlace(Vp, px, pz, yaw, 0, { gap: 0.15, dry: true });
      if (!f || tmp.some(g => Math.hypot(g.x - f.x, g.z - f.z) < g.hx + f.hx + 0.3 && Math.abs((g.x - f.x) * f.s - (g.z - f.z) * f.c) < 3.5)) return false;
      tmp.push(f);
    }
    for (const [px, pz, yaw] of spots) { const f = tryPlace(Vp, px, pz, yaw, 0, { gap: 0.15 }); if (f) placed.push(f); }
    if (placed.length < 2) return false;
    // barriers and cones a few metres further out
    const sb = s + d * 6;
    for (let k = 0; k <= n * 2; ++k) {
      const u = uB + 0.8 + (uA - uB - 1.6) * k / Math.max(1, n * 2);
      const [px, pz] = frame(r, sb + (Rr() - 0.5), u);
      if (k % 2 === 0) propAt('barrier', 0, px, pz, Math.atan2(tz, tx) + Math.PI / 2 + (Rr() - 0.5) * 0.3); else propAt('cone', 0, px, pz, Rr() * 6);
    }
    for (let k = 0; k < 5; ++k) { const [px, pz] = frame(r, s - d * (3 + k * 1.6), uB + 0.6 + Rr() * (uA - uB - 1.2)); propAt('cone', 0, px, pz, Rr() * 6); }
    usedSpots.push([x, z]); stats.sets.push({ type: 'roadblock', x: Math.round(x), z: Math.round(z) });
    return true;
  };

  // jam roads: per (road, direction) the stretch where the outbound flow is strong
  const jamInfo = [];
  const downtown = (r) => r.district === 'downtown';
  const DMAX = Math.max(...[[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]].map(([x, z]) => Math.hypot(x - core[0], z - core[1])));
  // +1 / -1: the road leaves the map at its end / start (only one end); 0 otherwise
  const exitDir = (r) => {
    if (r._exit !== undefined) return r._exit;
    const near = (p) => Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.z0, b.z1 - p[1]) < 20;
    const a = near(r.pts[0]), e = near(r.pts[r.pts.length - 1]);
    return (r._exit = a === e ? 0 : e ? 1 : -1);
  };
  const jamDensity = (r, s, d) => {
    const q = radial(r, s);
    const out = d * q.cos;                                         // > 0: this direction leaves the city
    if (out < 0.25 && exitDir(r) !== d) return 0;
    const edge = Math.min(q.x - b.x0, b.x1 - q.x, q.z - b.z0, b.z1 - q.z);
    let rho = (0.6 + 0.4 * sstep(40, 170, q.dist)) * sstep(0.25, 0.6, out);
    rho = Math.max(rho, sstep(200, 40, edge) * sstep(0.25, 0.6, out));
    // roads that run off the map: the whole outbound side is one queue towards that exit
    const ex = exitDir(r);
    if (ex) rho = ex === d ? Math.max(rho, 0.95) : 0;
    if (downtown(r)) rho *= sstep(110, 170, q.dist);              // the downtown grid stays passable
    if (r.P.cls === 'collector') rho *= 0.85;
    return rho;
  };

  // order of the set pieces (2-4): tanker, roadblock, garbage, bus
  {
    const spots = shuffle(midSpots((r, s) => r.P.cls === 'arterial' || r.P.id === 'street', 14), Rg);
    let done = 0;
    for (const [r, s] of spots) { const q = radial(r, s); if (q.dist < 80 || !farFromUsed(q.x, q.z, 120)) continue; if (tanker(r, s)) { ++done; break; } }
    // roadblock on the strongest outbound road, 40-80 m in from the map edge end
    const cands = [];
    for (const r of through) for (const d of [1, -1]) {
      if (!laneEdges(r).some(e => e.dir === d)) continue;
      for (let s = 20; s < r.len - 20; s += 10) {
        if (inJ(r, s, 12)) continue;
        const q = radial(r, s), edge = Math.min(q.x - b.x0, b.x1 - q.x, q.z - b.z0, b.z1 - q.z);
        if (r.P.cls !== 'arterial' || edge < 25 || edge > 110 || jamDensity(r, s, d) < 0.6) continue;
        cands.push([r, s, d, Rg()]);
      }
    }
    cands.sort((a, c) => a[3] - c[3]);
    for (const [r, s, d] of cands) { const q = radial(r, s); if (!farFromUsed(q.x, q.z, 100)) continue; if (roadblock(r, s, d)) { ++done; break; } }
    for (const [r, s] of shuffle(midSpots((r) => r.P.cls === 'collector' || r.district === 'downtown' || r.district === 'oldtown', 14), Rg)) { const q = radial(r, s); if (!farFromUsed(q.x, q.z, 110)) continue; if (garbage(r, s)) { ++done; break; } }
    if (Rg() < 0.75 || done < 3) for (const [r, s] of shuffle(midSpots(null, 16), Rg)) { const q = radial(r, s); if (!farFromUsed(q.x, q.z, 110)) continue; if (busCrash(r, s)) { ++done; break; } }
  }

  // ================================================================== small incidents
  const smallBudget = 40 + Math.floor(Rg() * 15);
  const incidentKinds = { pileup: 6, lamp: 5, burnt: 6, ambulance: 2, sidewalk: 6, delivery: 3, abandoned: 6, police: 2 };
  // pile-up at a junction approach: 2-4 crashed cars bunched up, the first nosing into the junction box edge
  const pileup = (r, j, d, Rr) => {
    const lanes = laneEdges(r).filter(e => e.dir === d); if (!lanes.length) return false;
    const sEdge = d > 0 ? j.a : j.b;
    const e = lanes[Math.floor(Rr() * lanes.length)], u = (e.left + e.right) / 2;
    let s = sEdge + d * 1.0, n = 0, prevHalf = 0;
    const N = 2 + Math.floor(Rr() * 3);
    for (let k = 0; k < N; ++k) {
      const V = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 0, state: 'crashed' });
      const half = (V.bb.x1 - V.bb.x0) / 2;
      s -= d * (prevHalf + half + 0.35 + Rr() * 0.4);
      prevHalf = half;
      if (s < 3 || s > r.len - 3) break;
      const uu = u + (Rr() - 0.5) * 1.4;
      const [x, z] = frame(r, s, uu), yaw = laneHeading(r, s, uu, half, d) + (Rr() - 0.5) * (k === 0 ? 1.2 : 0.7);
      if (tryPlace(V, x, z, yaw, 0, { gap: 0.15 })) ++n; else if (k === 0) return false;
    }
    if (n >= 2) { const [x, z] = frame(r, sEdge - d * 4, u); propAt('debris', n, x, z, Rr() * 6); usedSpots.push([x, z]); }
    return n >= 2;
  };
  const intoPost = (p, Rr) => {    // car nosed into a lamp / hydrant at the curb
    const r = net.roads[p.road]; if (!r || r.P.id === 'alley') return false;
    // nearest point of the road and side
    let bs = 0, bd = 1e9; for (let s = 0; s < r.len; s += 1) { const [x, z] = frame(r, s, 0); const dd = Math.hypot(x - p.x, z - p.z); if (dd < bd) { bd = dd; bs = s; } }
    if (inJ(r, bs, 1)) return false;
    const [cx, cz, tx, tz] = frame(r, bs, 0);
    const side = ((p.x - cx) * tz - (p.z - cz) * tx) > 0 ? 1 : -1;     // + = u > 0
    const V = vehicle(incKind(Rr), { ps: pickPaint(Rr), seed: 1, state: 'crashed' });
    const half = (V.bb.x1 - V.bb.x0) / 2;
    const ang = 0.3 + Rr() * 0.45, dirS = Rr() < 0.5 ? 1 : -1;
    // nose towards the post; centre back from the curb
    const hx = dirS * tx * Math.cos(ang) + side * tz * Math.sin(ang), hz = dirS * tz * Math.cos(ang) - side * tx * Math.sin(ang);
    for (const back of [0.9, 1.3, 1.7, 2.2, 2.8, 3.4]) {
      const x = p.x - hx * (half + back), z = p.z - hz * (half + back);
      if (tryPlace(V, x, z, Math.atan2(hz, hx), 0, { gap: 0.1 })) { decalBlob(Rr, x, z, 1.6, M.SPILL, 2); return true; }
    }
    return false;
  };
  const single = (type, r, s, Rr) => {
    const lanes = laneEdges(r); if (!lanes.length) return false;
    const e = lanes[Math.floor(Rr() * lanes.length)], d = e.dir || 1;
    let u = (e.left + e.right) / 2 + (Rr() - 0.5) * 1.0;
    let kind, st = 'ok', doors = null, jit = 0.25, after = null;
    if (type === 'burnt') { kind = incKind(Rr); st = 'burnt'; jit = 0.8; after = (f) => { decalBlob(Rr, f.x, f.z, 3.2, M.SCORCH, 4); }; }
    else if (type === 'ambulance') { kind = 'ambulance'; doors = 'rear'; jit = 0.35; after = (f) => { const bx = f.x - f.c * (f.hx + 1.6), bz = f.z - f.s * (f.hx + 1.6); propAt('stretcher', 0, bx, bz, Math.atan2(f.s, f.c) + 0.4); for (let k = 0; k < 3; ++k) propAt('cone', 0, f.x + f.c * (f.hx + 1.5 + k * 1.2) - f.s * 1.6, f.z + f.s * (f.hx + 1.5 + k * 1.2) + f.c * 1.6, 0); }; }
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
    const kinds = Object.keys(incidentKinds);
    let placed = 0, tries = 0;
    const lh = lampsAndHydrants.slice();
    while (placed < smallBudget && tries++ < smallBudget * 12) {
      const type = pickW(Rg, incidentKinds);
      const Rr = C.mulberry32((seed * 131 + tries * 7919) >>> 0);
      let ok = false;
      if (type === 'pileup') {
        const r = through[Math.floor(Rr() * through.length)], J = majorJ(r);
        if (!J.length) continue;
        const j = J[Math.floor(Rr() * J.length)], d = Rr() < 0.5 ? 1 : -1;
        const [x, z] = frame(r, d > 0 ? j.a : j.b, 0);
        if (!farFromUsed(x, z, 35)) continue;
        ok = pileup(r, j, d, Rr);
      } else if (type === 'lamp') {
        if (!lh.length) continue;
        const p = lh[Math.floor(Rr() * lh.length)];
        if (!farFromUsed(p.x, p.z, 35)) continue;
        ok = intoPost(p, Rr); if (ok) usedSpots.push([p.x, p.z]);
      } else {
        const pool = type === 'sidewalk' ? roads.filter(r => r.P.sidewalk >= 3.3) : roads.filter(r => r.P.cls !== 'alley');
        if (!pool.length) continue;
        const r = pool[Math.floor(Rr() * pool.length)], s = 8 + Rr() * Math.max(1, r.len - 16);
        if (inJ(r, s, 4)) continue;
        const [x, z] = frame(r, s, 0);
        if (!farFromUsed(x, z, 30)) continue;
        ok = type === 'sidewalk' ? sidewalkCar(r, s, Rr) : single(type, r, s, Rr);
        if (ok) usedSpots.push([x, z]);
      }
      if (ok) { ++placed; inc(type); }
    }
    void kinds;
  }

  // ================================================================== the evacuation jam
  // per lane: walk outward (in the travel direction), cars bumper to bumper where the density is high
  const lanesJ = [];
  for (const r of through) for (const e of laneEdges(r)) {
    const d = e.dir || 1;
    let peak = 0; for (let s = 5; s < r.len; s += 20) peak = Math.max(peak, jamDensity(r, s, d));
    if (peak < 0.2) continue;
    stats.jamLanes = (stats.jamLanes || 0) + 1; stats.jamLaneLen = (stats.jamLaneLen || 0) + Math.round(r.len);
    lanesJ.push({ r, e, d, peak, R: C.mulberry32(hashS('jam' + r.id + ':' + e.left) ^ seed) });
  }
  lanesJ.sort((a, c) => c.peak - a.peak || a.r.id - c.r.id || a.e.left - c.e.left);
  const jamCar = (L, s) => {
    const Rr = L.R, r = L.r, e = L.e, d = L.d;
    const kind = vehKind(Rr);
    const abandoned = Rr() < 0.03;
    const doors = Rr() < 0.12 ? (Rr() < 0.25 ? 'both' : 'side') : null;
    const st = 'ok';
    const V = vehicle(kind, { ps: Math.floor(Rr() * 64), seed: 0, state: st, doors: doors && INC_MIX[kind] ? doors : null });
    const half = (V.bb.x1 - V.bb.x0) / 2;
    let u = (e.left + e.right) / 2 + (Rr() - 0.5) * 0.7;
    if (Rr() < 0.08) u += (Rr() < 0.5 ? 1 : -1) * (1.2 + Rr() * 0.8);    // onto the shoulder / parking lane
    const yaw0 = laneHeading(r, s, u, half, d), jit = abandoned ? (Rr() < 0.5 ? 1 : -1) * (0.35 + Rr() * 0.5) : (Rr() - 0.5) * 0.14;
    return { V, half, u, yaw: yaw0 + jit };
  };
  let jamQuadsStart = mb.quads;
  for (const L of lanesJ) {
    if (mb.quads - q0 > QUAD_BUDGET) { stats.capped = true; break; }
    const r = L.r, d = L.d, Rr = L.R;
    // travel direction d: walk s from the entry end to the exit end
    let s = d > 0 ? 4 : r.len - 4;                 // s: the free edge (behind the next car's rear bumper)
    const end = (q) => d > 0 ? q > r.len - 4 : q < 4;
    while (!end(s)) {
      if (mb.quads - q0 > QUAD_BUDGET) { stats.capped = true; break; }
      const rho = jamDensity(r, s, d);
      if (rho < 0.08) { s += d * 12; continue; }
      if (inJ(r, s, 0.3)) { s += d * 1; continue; }
      if (Rr() > rho) { s += d * (3 + Rr() * 6); stats.jamThin = (stats.jamThin || 0) + 1; continue; }       // thinner towards the core: gaps
      const c = jamCar(L, s);
      const sc = s + d * c.half;
      if (end(sc + d * c.half) || inJ(r, sc, c.half + 0.3)) { s = sc + d * 1; continue; }
      const [x, z] = frame(r, sc, c.u);
      if (tryPlace(c.V, x, z, c.yaw, 0, { gap: 0.3 })) { ++stats.jam; s = sc + d * (c.half + 1 + Rr() * 1.5); }
      else { s = sc + d * 1.5; stats.jamMiss = (stats.jamMiss || 0) + 1; }
    }
  }
  stats.jamQuads = mb.quads - jamQuadsStart;

  // emergency vehicles driving in against the flow (inbound lanes of jammed roads)
  {
    const seen = new Set();
    for (const L of lanesJ) {
      const r = L.r; if (seen.has(r.id)) continue; seen.add(r.id);
      const inb = laneEdges(r).filter(e => e.dir === -L.d);
      if (!inb.length) continue;
      const Rr = C.mulberry32(hashS('em' + r.id) ^ seed);
      const n = Math.floor(Rr() * 2.4);
      for (let k = 0; k < n; ++k) {
        const e = inb[Math.floor(Rr() * inb.length)], d = e.dir;
        const kind = pickW(Rr, { police: 5, ambulance: 3, fire_engine: 1 });
        const V = vehicle(kind, { ps: 0, seed: 0, state: 'ok', lights: true, doors: Rr() < 0.4 ? 'side' : null });
        for (let t = 0; t < 6; ++t) {
          const s = 10 + Rr() * (r.len - 20); if (inJ(r, s, 6)) continue;
          if (jamDensity(r, s, -d) < 0.3) continue;
          const u = (e.left + e.right) / 2;
          const [x, z] = frame(r, s, u);
          if (tryPlace(V, x, z, laneHeading(r, s, u, 3, d) + (Rr() - 0.5) * 0.15, 0)) { ++stats.emergency; break; }
        }
      }
    }
  }

  stats.vehicles = stats.jam + stats.emergency;
  stats.variants = cache.size;
  stats.lib = VEH && VEH.model ? 'Vehicles' : 'fallback';
  stats.quads = mb.quads - q0; stats.ms = Date.now() - t0;
  return stats;
}

L.trafficKit = trafficKit;
})();
