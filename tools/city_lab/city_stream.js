/* City Lab streaming mode (?stream=1): RTS camera rig + on-demand 128 m tiles.
   Default (regional): no whole-map plan; workers plan 256 m pages on demand (CityArch.planPage, see README
   "Streaming") and build tiles from the pages around them. ?wholeplan=1: the old path, where worker 0 plans the
   whole map once (geometry-free: placement, types, kit dressing), then the page asks for the tiles
   around the camera's ground footprint, nearest to the pivot first. Each tile = 1 road mesh + 1 building mesh (one
   shader material reading the per-vertex material id), frustum-culled by its bounding sphere. Built tiles live in an
   LRU; GPU geometry beyond it is disposed. The ring is sized from the max zoom distance, so tiles are built before
   they can enter the view. */
(function () {
  const Q = new URLSearchParams(location.search);
  if (!window.CITY_STREAM_MODE) return;
  const { S, U, C, world, geometryFrom, MAT_CITY, MAT_BLOCKS, persp, renderer, addProps, $ } = window.CL;
  const CLc = window.CL;
  const TILE = +(Q.get('tile') || 128), RTS = { minD: 30, maxD: 300, minPitch: 35, maxPitch: 70 }, LRU = +(Q.get('lru') || 80);
  // far LOD: tiles whose nearest point is beyond FAR from the camera are built with lod 'far' (sub-pixel quads dropped,
  // city_arch FAR_LOD_MIN 0.35 m ~ 1 px there at 1080p / 45 deg fov); at the 30 m min zoom nothing in the ring is far,
  // at the 300 m max zoom the pivot tiles (camera 300 m away) stay full. Upgraded to full when they come within NEAR.
  const FAR = +(Q.get('far') || 420), NEAR = FAR - 40;
  const ST = window.STREAM = { tiles: new Map(), pending: new Map(), queue: [], cuts: [], workers: [], ready: 0, t0: performance.now(), firstFrame: 0, built: 0, buildMs: [], fieldMs: [], workerMem: {}, rts: true, planMs: 0 };
  // ---- RTS rig: OrbitControls clamped (pivot on the ground, pitch 35-70 deg, distance 30-300 m); the dev camera
  // (key V or STREAM.setDev(true)) restores the free orbit / plan / street views for tooling
  function applyRig() {
    const c = CLc.controls;
    if (ST.rts) {
      c.minDistance = RTS.minD; c.maxDistance = RTS.maxD;
      c.minPolarAngle = (90 - RTS.maxPitch) * Math.PI / 180; c.maxPolarAngle = (90 - RTS.minPitch) * Math.PI / 180;
      c.screenSpacePanning = false; c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
    } else { c.minDistance = 1.5; c.maxDistance = 1800; c.minPolarAngle = 0; c.maxPolarAngle = Math.PI * 0.495; }
  }
  ST.setDev = (on) => { ST.rts = !on; applyRig(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'v' && e.target.tagName !== 'INPUT') ST.setDev(ST.rts); });
  ST.view = (x, z, dist, pitchDeg, yawDeg) => {
    const p = pitchDeg * Math.PI / 180, y = (yawDeg || 0) * Math.PI / 180;
    CLc.controls.target.set(x, 0, z);
    persp.position.set(x + Math.sin(y) * Math.cos(p) * dist, Math.sin(p) * dist, z + Math.cos(y) * Math.cos(p) * dist);
    CLc.controls.update();
  };
  // ---- tiles
  const key = (i, j) => i + ',' + j;
  function footprint() {                              // tiles under the view frustum's ground footprint (+1 ring)
    const cam = CLc.camera, pts = [];
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      ray.setFromCamera({ x: u, y: v }, cam);
      if (ray.ray.intersectPlane(plane, hit) && hit.distanceTo(cam.position) < 900) pts.push(hit.clone());
      else { const d = ray.ray.direction.clone(); d.y = 0; d.normalize().multiplyScalar(RTS.maxD * 2.2); pts.push(CLc.controls.target.clone().add(d)); }
    }
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z), b = ST.bounds;
    const i0 = Math.floor((Math.max(b.x0, Math.min(...xs)) - b.x0) / TILE) - 1, i1 = Math.floor((Math.min(b.x1, Math.max(...xs)) - b.x0) / TILE) + 1;
    const j0 = Math.floor((Math.max(b.z0, Math.min(...zs)) - b.z0) / TILE) - 1, j1 = Math.floor((Math.min(b.z1, Math.max(...zs)) - b.z0) / TILE) + 1;
    const out = [];
    for (let j = Math.max(0, j0); j <= Math.min(ST.nj - 1, j1); ++j) for (let i = Math.max(0, i0); i <= Math.min(ST.ni - 1, i1); ++i) out.push([i, j]);
    return out;
  }
  function mesh(m, mat) {
    if (!m.idx.length) return null;
    const o = new THREE.Mesh(geometryFrom(m), mat);
    o.castShadow = o.receiveShadow = true; o.matrixAutoUpdate = false; o.scale.setScalar(S.voxel); o.updateMatrix();
    return o;
  }
  // cars standing on a driveway curb cut that arrived after the traffic was placed (house tiles) are hidden
  function hideOnCuts(cuts) {
    const tr = CLc.traffic; if (!tr || !tr.hidden || !cuts.length) return;
    const O = tr.T.obb; let n = 0;
    for (const c of cuts) {
      const ux = c.bx - c.ax, uz = c.bz - c.az, len = Math.hypot(ux, uz) || 1, ex = ux / len, ez = uz / len, dep = (c.depth || 4) + 2.6;
      for (let i = 0; i < tr.T.count; ++i) {
        if (tr.hidden[i]) continue;
        const rx = O[i * 8] - c.ax, rz = O[i * 8 + 1] - c.az, r = Math.max(O[i * 8 + 2], O[i * 8 + 3]);
        const t = rx * ex + rz * ez, dn = rx * c.nx + rz * c.nz;
        if (t > -0.6 - r && t < len + 0.6 + r && dn > -0.5 - r && dn < dep + r) { tr.hidden[i] = 1; ++n; }
      }
    }
    ST.carsHidden = (ST.carsHidden || 0) + n;
  }
  function onTile(d) {
    const t = ST.pending.get(d.key); ST.pending.delete(d.key);
    const old = ST.tiles.get(d.key);
    if (old) { world.remove(old.g); old.g.traverse(c => c.geometry && c.geometry.dispose()); ST.upgraded = (ST.upgraded || 0) + 1; }
    else { ST.cuts = ST.cuts.concat(d.cuts); if (!ST.regional) hideOnCuts(d.cuts); }
    const g = new THREE.Group(), r = mesh(d.road, MAT_CITY), b = mesh(d.bld, d.bld.nvec ? MAT_BLOCKS : MAT_CITY);
    if (r) g.add(r); if (b) g.add(b);
    world.add(g);
    const tr = d.traffic !== undefined ? (d.traffic || (old && old.traffic) || null) : null;
    ST.tiles.set(d.key, { g, used: performance.now(), tris: (d.road.idx.length + d.bld.idx.length) / 3, ij: t, lod: d.lod, traffic: tr });
    if (ST.regional && d.traffic) { ST.trafficDirty = true; ST.trafficMsSum = (ST.trafficMsSum || 0) + d.trafficMs; }
    ST.built++; ST.buildMs.push(d.ms); ST.fieldMs.push(d.fieldMs); if (d.mem) ST.workerMem[d.w] = Math.max(ST.workerMem[d.w] || 0, d.mem);
    if (!ST.firstFrame && !ST.pending.size && !ST.missing()) ST.firstFrame = performance.now() - ST.t0;
    // LRU: dispose GPU geometry of the least recently needed tiles beyond the cache size
    if (ST.tiles.size > LRU) {
      const old = [...ST.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, ST.tiles.size - LRU);
      for (const [k, T] of old) { world.remove(T.g); T.g.traverse(c => c.geometry && c.geometry.dispose()); ST.tiles.delete(k); if (T.traffic) ST.trafficDirty = true; }
    }
    if (CLc.traffic) CLc.updateTrafficLOD(true);
  }
  // the planner's kit mesh (service yards, parks) stays on the page, binned on a 64 m grid; each tile request carries
  // the slice within KIT_PAD of the tile (buildTile takes kit quads within its halo of the tile's buildings)
  const KG = 64, KIT_PAD = 72;
  function binKit(cp) {
    const K = cp.kit, B = cp.kitB, v = S.voxel, bins = new Map();
    for (let q = 0; q < K.quads; ++q) {
      const gx0 = Math.floor(B[q * 4] * v / KG), gz0 = Math.floor(B[q * 4 + 1] * v / KG), gx1 = Math.floor(B[q * 4 + 2] * v / KG), gz1 = Math.floor(B[q * 4 + 3] * v / KG);
      for (let gz = gz0; gz <= gz1; ++gz) for (let gx = gx0; gx <= gx1; ++gx) { const k = gx + ',' + gz; let L = bins.get(k); if (!L) bins.set(k, L = []); L.push(q); }
    }
    ST.kit = { K, B, bins };
  }
  function kitFor(x0, z0, x1, z1) {
    const { K, B, bins } = ST.kit, v = S.voxel, set = new Set();
    for (let gz = Math.floor((z0 - KIT_PAD) / KG); gz <= Math.floor((z1 + KIT_PAD) / KG); ++gz)
      for (let gx = Math.floor((x0 - KIT_PAD) / KG); gx <= Math.floor((x1 + KIT_PAD) / KG); ++gx) {
        const L = bins.get(gx + ',' + gz); if (!L) continue;
        for (const q of L) if (B[q * 4 + 2] * v >= x0 - KIT_PAD && B[q * 4] * v <= x1 + KIT_PAD && B[q * 4 + 3] * v >= z0 - KIT_PAD && B[q * 4 + 1] * v <= z1 + KIT_PAD) set.add(q);
      }
    return window.CityArch.kitSlice(K, Int32Array.from(set).sort());
  }
  function lodOf(i, j) {                               // distance from the camera to the tile's nearest ground point
    const c = CLc.camera.position, x0 = ST.bounds.x0 + i * TILE, z0 = ST.bounds.z0 + j * TILE;
    const dx = Math.max(x0 - c.x, 0, c.x - x0 - TILE), dz = Math.max(z0 - c.z, 0, c.z - z0 - TILE);
    return Math.hypot(dx, dz, c.y);
  }
  function pump() {
    if (ST.regional) return rpump();
    if (ST.ready < ST.workers.length) return;
    const need = footprint(), now = performance.now(), p = CLc.controls.target;
    for (const [i, j] of need) { const T = ST.tiles.get(key(i, j)); if (T) T.used = now; }
    const miss = need.filter(([i, j]) => !ST.tiles.has(key(i, j)) && !ST.pending.has(key(i, j)));
    const cx = (i) => ST.bounds.x0 + (i + 0.5) * TILE, cz = (j) => ST.bounds.z0 + (j + 0.5) * TILE;
    miss.sort((a, b) => Math.hypot(cx(a[0]) - p.x, cz(a[1]) - p.z) - Math.hypot(cx(b[0]) - p.x, cz(b[1]) - p.z));
    for (const t of miss) t.lod = lodOf(t[0], t[1]) > FAR ? 'far' : 'full';
    // far tiles that came within NEAR: rebuilt full (after every missing tile)
    if (!ST.noLod) for (const [i, j] of need) { const T = ST.tiles.get(key(i, j)); if (T && T.lod === 'far' && !ST.pending.has(key(i, j)) && lodOf(i, j) < NEAR) { const u = [i, j]; u.lod = 'full'; miss.push(u); } }
    if (ST.noLod) for (const t of miss) t.lod = 'full';
    for (const w of ST.workers) {
      if (w.busy >= 2 || !miss.length) continue;
      const t = miss.shift(), [i, j] = t, k = key(i, j), x0 = ST.bounds.x0 + i * TILE, z0 = ST.bounds.z0 + j * TILE;
      ST.pending.set(k, [i, j]); w.busy++;
      const kit = kitFor(x0, z0, x0 + TILE, z0 + TILE);
      const tb = [kit.pos.buffer, kit.mat.buffer, kit.nrm.buffer].concat(kit.nvec ? [kit.nvec.buffer] : []);
      w.postMessage({ cmd: 'stile', key: k, rect: [x0, z0, x0 + TILE, z0 + TILE], cuts: ST.cuts, lod: t.lod, kit }, tb);
    }
  }
  ST.missing = () => footprint().filter(([i, j]) => !ST.tiles.has(key(i, j))).length;   // needed tiles not loaded yet
  ST.stats = () => {
    let calls = 0, tris = 0, vis = 0;
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(CLc.camera.projectionMatrix, CLc.camera.matrixWorldInverse));
    for (const T of ST.tiles.values()) T.g.children.forEach(m => { const s = m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld); if (fr.intersectsSphere(s)) { calls++; tris += m.geometry.index.count / 3; } });
    const ms = ST.buildMs.slice().sort((a, b) => a - b);
    return { tiles: ST.tiles.size, pending: ST.pending.size, built: ST.built, visibleCalls: calls, visibleTris: tris, planMs: Math.round(ST.planMs), firstFrameMs: Math.round(ST.firstFrame),
      scale: ST.scale, trafficMs: Math.round(ST.trafficMs || ST.trafficMsSum || 0), pages: ST.pages ? ST.pages.size : 0, pagesDropped: ST.pagesDropped || 0,
      pageMsMedian: ST.pageMs ? Math.round(ST.pageMs.slice().sort((a, b) => a - b)[ST.pageMs.length >> 1] || 0) : 0, cars: CLc.traffic ? { count: CLc.traffic.T.count, hidden: ST.carsHidden || 0, tris: CLc.traffic.tris } : null,
      far: [...ST.tiles.values()].filter(T => T.lod === 'far').length, upgraded: ST.upgraded || 0, initMs: Math.round(ST.initMs || 0), planHeapMB: ST.planMem, workerHeapMB: Object.assign({}, ST.workerMem),
      fieldMsMedian: Math.round(ST.fieldMs.slice().sort((a, b) => a - b)[ST.fieldMs.length >> 1] || 0),
      tileMsMedian: Math.round(ms[ms.length >> 1] || 0), tileMsMax: Math.round(ms[ms.length - 1] || 0), info: Object.assign({}, renderer.info.render), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
  };
  // ---- regional streaming (default; ?wholeplan=1 for the whole-map planner): 256 m pages planned on demand by the
  // workers (CityArch.planPage), a tile is requested once the pages within its field margin are in; only resident
  // pages / tiles are held (page LRU), traffic is per tile and merged into one instanced set (throttled)
  const PAGE_LRU = +(Q.get('plru') || 24), MARGIN = 48;
  const pageKey = (i, j) => i + ',' + j;
  function pagesFor(i, j) {
    const A = window.CityArch, b = ST.bounds, x0 = b.x0 + i * TILE, z0 = b.z0 + j * TILE, out = [];
    const [pa, pb] = A.pageOf(S.net, x0 - MARGIN, z0 - MARGIN), [pc, pd] = A.pageOf(S.net, x0 + TILE + MARGIN, z0 + TILE + MARGIN);
    for (let pj = Math.max(0, pb); pj <= Math.min(ST.npj - 1, pd); ++pj) for (let pi = Math.max(0, pa); pi <= Math.min(ST.npi - 1, pc); ++pi) out.push([pi, pj]);
    return out;
  }
  function idleWorker() { let best = null; for (const w of ST.workers) if (w.busy < 2 && (!best || w.busy < best.busy)) best = w; return best; }
  function rpump() {
    if (ST.ready < ST.workers.length) return;
    const need = footprint(), now = performance.now(), p = CLc.controls.target;
    for (const [i, j] of need) { const T = ST.tiles.get(key(i, j)); if (T) T.used = now; }
    const miss = need.filter(([i, j]) => !ST.tiles.has(key(i, j)) && !ST.pending.has(key(i, j)));
    const cx = (i) => ST.bounds.x0 + (i + 0.5) * TILE, cz = (j) => ST.bounds.z0 + (j + 0.5) * TILE;
    miss.sort((a, b) => Math.hypot(cx(a[0]) - p.x, cz(a[1]) - p.z) - Math.hypot(cx(b[0]) - p.x, cz(b[1]) - p.z));
    for (const t of miss) t.lod = ST.noLod || lodOf(t[0], t[1]) <= FAR ? 'full' : 'far';
    if (!ST.noLod) for (const [i, j] of need) { const T = ST.tiles.get(key(i, j)); if (T && T.lod === 'far' && !ST.pending.has(key(i, j)) && lodOf(i, j) < NEAR) { const u = [i, j]; u.lod = 'full'; miss.push(u); } }
    for (const t of miss) {
      const pk = pagesFor(t[0], t[1]);
      for (const [pi, pj] of pk) { const P = ST.pages.get(pageKey(pi, pj)); if (P) P.used = now; }
      const want = pk.filter(([pi, pj]) => !ST.pages.has(pageKey(pi, pj)));
      for (const [pi, pj] of want) {
        const w = idleWorker(); if (!w) return;
        ST.pages.set(pageKey(pi, pj), { state: 'pending', used: now }); w.busy++;
        w.postMessage({ cmd: 'rpage', pi, pj, props: true });
      }
      if (pk.some(([pi, pj]) => ST.pages.get(pageKey(pi, pj)).state !== 'ready')) continue;
      const w = idleWorker(); if (!w) return;
      const [i, j] = t, k = key(i, j), x0 = ST.bounds.x0 + i * TILE, z0 = ST.bounds.z0 + j * TILE;
      ST.pending.set(k, [i, j]); w.busy++;
      const pages = pk.map(([pi, pj]) => ST.pages.get(pageKey(pi, pj)).data);
      const cuts = ST.cuts.filter(c => Math.max(c.ax, c.bx) > x0 - 20 && Math.min(c.ax, c.bx) < x0 + TILE + 20 && Math.max(c.az, c.bz) > z0 - 20 && Math.min(c.az, c.bz) < z0 + TILE + 20);
      w.postMessage({ cmd: 'rtile', key: k, rect: [x0, z0, x0 + TILE, z0 + TILE], cuts, lod: t.lod, pages, traffic: !ST.noTraffic });
    }
    // page LRU: drop pages beyond PAGE_LRU that no pending tile needs (their data lives only in their tiles' meshes)
    if (ST.pages.size > PAGE_LRU) {
      const busy = new Set(); for (const [i, j] of ST.pending.values()) for (const [pi, pj] of pagesFor(i, j)) busy.add(pageKey(pi, pj));
      const old = [...ST.pages.entries()].filter(([k, P]) => P.state === 'ready' && !busy.has(k)).sort((a, b) => a[1].used - b[1].used);
      for (const [k] of old.slice(0, ST.pages.size - PAGE_LRU)) { ST.pages.delete(k); ST.pagesDropped = (ST.pagesDropped || 0) + 1; ST.propsDirty = true; }
    }
    if (ST.propsDirty && now - (ST.propsAt || 0) > 1000) { ST.propsDirty = false; ST.propsAt = now; const L = []; for (const P of ST.pages.values()) if (P.data && P.data.props) L.push(...P.data.props); if (typeof addProps === 'function') addProps(L); }
    if (ST.trafficDirty && now - (ST.trafficAt || 0) > 700) { ST.trafficDirty = false; ST.trafficAt = now; mergeTraffic(); }
  }
  // one instanced traffic set from the resident tiles' cars (variants deduplicated by key)
  function mergeTraffic() {
    const vk = new Map(), variants = [], parts = [];
    let n = 0, paintPH = 0;
    for (const T of ST.tiles.values()) if (T.traffic && T.traffic.count) { parts.push(T.traffic); n += T.traffic.count; paintPH = T.traffic.paintPH; }
    const M = new Float32Array(n * 12), vid = new Uint16Array(n), paint = new Uint8Array(n), obb = new Float32Array(n * 8);
    let o = 0;
    for (const t of parts) {
      const map = t.variants.map(v => { let k = vk.get(v.key); if (k === undefined) { k = variants.length; vk.set(v.key, k); variants.push(Object.assign({}, v, { n: 0 })); } return k; });
      M.set(t.M, o * 12); obb.set(t.obb, o * 8); paint.set(t.paint, o);
      for (let i = 0; i < t.count; ++i) { vid[o + i] = map[t.vid[i]]; variants[vid[o + i]].n++; }
      o += t.count;
    }
    if (!n && !CLc.traffic) return;
    CLc.addTraffic({ M, vid, paint, obb, count: n, variants, paintPH });
  }
  function startRegional(seed) {
    const A = window.CityArch;
    ST.regional = true; ST.pages = new Map(); ST.npi = Math.ceil((ST.bounds.x1 - ST.bounds.x0) / A.PAGE); ST.npj = Math.ceil((ST.bounds.z1 - ST.bounds.z0) / A.PAGE);
    ST.pageMs = []; ST.pageMem = {};
    ST.workers.forEach((w, wi) => {
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'rready') { ST.ready++; ST.initMs = Math.max(ST.initMs || 0, d.ms); }
        else if (d.type === 'rpage') {
          w.busy--; const P = d.page, rec = ST.pages.get(P.key) || { used: performance.now() };
          rec.state = 'ready'; rec.data = P; ST.pages.set(P.key, rec); ST.pageMs.push(P.wall);
          ST.cuts = ST.cuts.concat(P.kitCuts); ST.propsDirty = true;
          if (P.mem) ST.workerMem[wi] = Math.max(ST.workerMem[wi] || 0, P.mem);
          if (!ST.planMs) ST.planMs = performance.now() - ST.t0;
        } else if (d.type === 'rtile') { w.busy--; d.w = wi; onTile(d); }
      };
      w.postMessage({ cmd: 'rinit', seed: seed || 1, voxel: S.voxel, scale: ST.scale });
    });
  }
  ST.start = (seed) => {
    S.voxel = +$('voxel').value; U.voxel.value = S.voxel;
    ST.scale = +(Q.get('scale') || 5);
    S.net = C.generateCity(seed || 1, { scale: ST.scale });
    const b = S.net.bounds; ST.bounds = b; ST.ni = Math.ceil((b.x1 - b.x0) / TILE); ST.nj = Math.ceil((b.z1 - b.z0) / TILE);
    const NWs = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < NWs; ++i) {
      const w = new Worker('city_worker.js'); w.busy = 0; ST.workers.push(w);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'splanned') {
          ST.planMs = d.ms; ST.planMem = d.mem; S.hs = d.hs; ST.cuts = ST.cuts.concat(d.kitCuts); if (d.props && typeof addProps === 'function') addProps(d.props);
          binKit(d.cp);
          const cp = Object.assign({}, d.cp, { kit: null, kitB: null, kitC: null });
          for (const ww of ST.workers) ww.postMessage({ cmd: 'sinit', seed: seed || 1, voxel: S.voxel, scale: ST.scale, cp });
        }
        else if (d.type === 'sready') { ST.ready++; ST.initMs = Math.max(ST.initMs || 0, d.ms); }
        else if (d.type === 'stile') { w.busy--; d.w = i; onTile(d); }
        else if (d.type === 'traffic') {
          ST.trafficMs = d.ms; CLc.addTraffic(d.traffic);
          const tr = CLc.traffic; tr.hidden = new Uint8Array(d.traffic.count);
          tr.keep = (x, z) => ST.tiles.has(key(Math.floor((x - ST.bounds.x0) / TILE), Math.floor((z - ST.bounds.z0) / TILE)));
          hideOnCuts(ST.cuts);
        }
      };
      if (i === 0 && Q.get('wholeplan')) w.postMessage({ cmd: 'splan', seed: seed || 1, voxel: S.voxel, props: true, scale: ST.scale });
    }
    if (!Q.get('wholeplan')) startRegional(seed);
    ST.view(0, 0, 160, 50, 30); applyRig();
    (function loop() { requestAnimationFrame(loop); pump(); })();
  };
  window.addEventListener('load', () => setTimeout(() => ST.start(+(Q.get('seed') || 1)), 0));
})();
