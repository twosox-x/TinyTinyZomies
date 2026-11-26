/* City Lab streaming mode (?stream=1): RTS camera rig + on-demand 128 m tiles.
   Every worker plans the map once (geometry-free: placement, types, kit dressing), then the page asks for the tiles
   around the camera's ground footprint, nearest to the pivot first. Each tile = 1 road mesh + 1 building mesh (one
   shader material reading the per-vertex material id), frustum-culled by its bounding sphere. Built tiles live in an
   LRU; GPU geometry beyond it is disposed. The ring is sized from the max zoom distance, so tiles are built before
   they can enter the view. */
(function () {
  const Q = new URLSearchParams(location.search);
  if (!Q.get('stream')) return;
  const TILE = +(Q.get('tile') || 128), RTS = { minD: 30, maxD: 300, minPitch: 35, maxPitch: 70 }, LRU = +(Q.get('lru') || 80);
  const ST = window.STREAM = { tiles: new Map(), pending: new Map(), queue: [], cuts: [], workers: [], ready: 0, t0: performance.now(), firstFrame: 0, built: 0, buildMs: [], rts: true, planMs: 0 };
  // ---- RTS rig: OrbitControls clamped (pivot on the ground, pitch 35-70 deg, distance 30-300 m); the dev camera
  // (key V or STREAM.setDev(true)) restores the free orbit / plan / street views for tooling
  function applyRig() {
    const c = controls;
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
    controls.target.set(x, 0, z);
    persp.position.set(x + Math.sin(y) * Math.cos(p) * dist, Math.sin(p) * dist, z + Math.cos(y) * Math.cos(p) * dist);
    controls.update();
  };
  // ---- tiles
  const key = (i, j) => i + ',' + j;
  function footprint() {                              // tiles under the view frustum's ground footprint (+1 ring)
    const cam = camera, pts = [];
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      ray.setFromCamera({ x: u, y: v }, cam);
      if (ray.ray.intersectPlane(plane, hit) && hit.distanceTo(cam.position) < 900) pts.push(hit.clone());
      else { const d = ray.ray.direction.clone(); d.y = 0; d.normalize().multiplyScalar(RTS.maxD * 2.2); pts.push(controls.target.clone().add(d)); }
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
  function onTile(d) {
    const t = ST.pending.get(d.key); ST.pending.delete(d.key);
    ST.cuts = ST.cuts.concat(d.cuts);
    const g = new THREE.Group(), r = mesh(d.road, MAT_CITY), b = mesh(d.bld, d.bld.nvec ? MAT_BLOCKS : MAT_CITY);
    if (r) g.add(r); if (b) g.add(b);
    world.add(g);
    ST.tiles.set(d.key, { g, used: performance.now(), tris: (d.road.idx.length + d.bld.idx.length) / 3, ij: t });
    ST.built++; ST.buildMs.push(d.ms);
    if (!ST.firstFrame && !ST.pending.size) ST.firstFrame = performance.now() - ST.t0;
    // LRU: dispose GPU geometry of the least recently needed tiles beyond the cache size
    if (ST.tiles.size > LRU) {
      const old = [...ST.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, ST.tiles.size - LRU);
      for (const [k, T] of old) { world.remove(T.g); T.g.traverse(c => c.geometry && c.geometry.dispose()); ST.tiles.delete(k); }
    }
  }
  function pump() {
    if (ST.ready < ST.workers.length) return;
    const need = footprint(), now = performance.now(), p = controls.target;
    for (const [i, j] of need) { const T = ST.tiles.get(key(i, j)); if (T) T.used = now; }
    const miss = need.filter(([i, j]) => !ST.tiles.has(key(i, j)) && !ST.pending.has(key(i, j)));
    const cx = (i) => ST.bounds.x0 + (i + 0.5) * TILE, cz = (j) => ST.bounds.z0 + (j + 0.5) * TILE;
    miss.sort((a, b) => Math.hypot(cx(a[0]) - p.x, cz(a[1]) - p.z) - Math.hypot(cx(b[0]) - p.x, cz(b[1]) - p.z));
    for (const w of ST.workers) {
      if (w.busy >= 2 || !miss.length) continue;
      const [i, j] = miss.shift(), k = key(i, j), x0 = ST.bounds.x0 + i * TILE, z0 = ST.bounds.z0 + j * TILE;
      ST.pending.set(k, [i, j]); w.busy++;
      w.postMessage({ cmd: 'stile', key: k, rect: [x0, z0, x0 + TILE, z0 + TILE], cuts: ST.cuts });
    }
  }
  ST.stats = () => {
    let calls = 0, tris = 0, vis = 0;
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const T of ST.tiles.values()) T.g.children.forEach(m => { const s = m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld); if (fr.intersectsSphere(s)) { calls++; tris += m.geometry.index.count / 3; } });
    const ms = ST.buildMs.slice().sort((a, b) => a - b);
    return { tiles: ST.tiles.size, pending: ST.pending.size, built: ST.built, visibleCalls: calls, visibleTris: tris, planMs: Math.round(ST.planMs), firstFrameMs: Math.round(ST.firstFrame),
      tileMsMedian: Math.round(ms[ms.length >> 1] || 0), tileMsMax: Math.round(ms[ms.length - 1] || 0), info: Object.assign({}, renderer.info.render), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
  };
  ST.start = (seed) => {
    S.voxel = +$('voxel').value; U.voxel.value = S.voxel;
    S.net = C.generateCity(seed || 1);
    const b = S.net.bounds; ST.bounds = b; ST.ni = Math.ceil((b.x1 - b.x0) / TILE); ST.nj = Math.ceil((b.z1 - b.z0) / TILE);
    const NWs = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < NWs; ++i) {
      const w = new Worker('city_worker.js'); w.busy = 0; ST.workers.push(w);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'splanned') { ST.ready++; ST.planMs = Math.max(ST.planMs, d.ms); S.hs = d.hs; if (d.kitCuts) ST.cuts = ST.cuts.concat(i === 0 ? d.kitCuts : []); if (d.props && typeof addProps === 'function') addProps(d.props); }
        else if (d.type === 'stile') { w.busy--; onTile(d); }
      };
      w.postMessage({ cmd: 'splan', seed: seed || 1, voxel: S.voxel, props: i === 0 });
    }
    ST.view(0, 0, 160, 50, 30); applyRig();
    (function loop() { requestAnimationFrame(loop); pump(); })();
  };
  window.addEventListener('load', () => setTimeout(() => ST.start(+(Q.get('seed') || 1)), 0));
})();
