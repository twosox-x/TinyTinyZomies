# City Lab plug-in standard

One page for everything you can add to the city. Rule of thumb: **new content is a new file in `towers/` plus one line in
`towers/manifest.js`; the engine files (`city_core.js`, `city_arch.js`, `city_worker.js`, `city_lab.html`) are not touched.**
This document supersedes `towers/AGENT_BRIEF.md` wherever they overlap (the brief stays as design history and has the
longest skin / Relief examples). Vehicles: `dev/VEHICLES_API.md`.

## 1. Registries and hooks

| What | Registered / installed by | Called by | Signature / contract | Reference file |
|---|---|---|---|---|
| High-rise | `CityArch.registerTower(name, fn, { unique })` | block placer, shuffled deck near the core | `fn(E, C, W, D, spec, R)`; spec `{ seed, floors, party:{l,r,b} }` | `templates/tower_template.js`, `towers/*.js` |
| Mid-rise / commercial / transition | `CityArch.registerMid(name, fn, { zones, minW, maxW, minFloors, maxFloors })` (m, storeys); zones `'core' 'mid' 'row' 'commercial' 'transition'` | `buildMidAny` | `fn(E, C, W, D, spec, R, L)`; spec `{ seed, floors, party:{l,r}, shops, zone, use }` | `templates/mid_template.js`, `mid_*.js`, `commercial.js` |
| House | `CityArch.registerHouse(name, fn, { minW, maxW, minD, maxD (m), weight })` | `buildHouseAny` | `fn(E, C, W, D, spec, R, L)`; spec `{ seed, floors, garage, setback, lot:{w,d}, side }` | `templates/house_template.js`, `houses.js` |
| Roof kit | `CityArch.lib.roofKit = fn` | every mid-rise, row house, tower roof | `roofKit(E, C, x0, z0, x1, z1, y, R, { style:'historic'\|'office'\|'residential'\|'industrial', floors, avoid:[[x0,z0,x1,z1]] })` | `roofkit.js` |
| Water tank | `CityArch.lib.waterTankImpl = fn` | `waterTank()` in city_arch.js | `fn(E, cx, cz, y, C [, o])` returns `{ w, d, h }`; design picked by hash of (cx, cz, y) | `roofkit.js` |
| Yard kit | `CityArch.lib.yardKit = fn` | per suburban lot | `yardKit(E, C, lot, R, opts)`, `E` in the **lot frame** (origin = front-left corner on the property line); `lot { w, d, house:{x0,z0,x1,z1}, drive, garage, door(s), porch }`; `opts { style, neighbours:{l,r,b}, seed }` | `yardkit.js` |
| Service kit | `CityArch.lib.serviceKit = fn` | end of `buildAll`, after all buildings | `serviceKit({ PL, R, C, occ, blocks, jobs, hs, voxel, mb })`: dumpsters, fences, alleys in downtown / old-town leftovers | `servicekit.js` |
| Park kit | `CityArch.lib.parkKit = fn` | `buildAll` right after the suburbs | `parkKit({ PL, C, R, blocks, sub, mb, hs, voxel })` returns `{ regions, stats }`: parks, groves, leftover land | `parkkit.js` |
| Traffic kit | `CityArch.lib.trafficKit = fn` | `buildAll`, last, before the cull pass | `trafficKit({ PL, C, R, jobs, mb, hs, voxel })`; output moved to `res.traffic` (GPU-instanced variants + 3x4 matrices) | `traffickit.js` |
| Street furniture | entry in `PROP_TYPES` + `model...()` + rule in `placeProps()` (city_core.js: engine file, ask the owner of that file) | `placeProps` | instanced, 5 cm voxels | `city_core.js` |
| Vehicles | `CityCore.Vehicles` (renderer-free library) | traffic kit, yard kit, parkings, props | `Vehicles.mesh(kind, opts)`, `Vehicles.emit(E, kind, opts, x, y, z, dir, scale, fit)` | `dev/VEHICLES_API.md` |

Load order is `towers/manifest.js` (`self.TOWER_FILES`), shared by the page and the worker. A file may use hooks that load
before it (`roofkit.js`, `yardkit.js` first); always guard optional hooks: `L.roofKit && L.roofKit(...)`.
A file registers itself in an IIFE using `self.CityArch`; it never edits another plug-in.

## 2. Coordinates and units

- **Building-local (towers, mids, houses):** 1 voxel = `L.BV` = **0.25 m**. `x` runs along the street (0..W), `z` into the
  lot (`z = 0` is the street front, the facade faces -z), `y` up (0 = ground / yard level). `W`, `D` are in voxels
  (typ. 32..180 = 8..45 m). Storey height `L.FH` = 14 voxels (3.5 m); a lobby storey is 18..20.
- **Lot frame (yard kit):** same axes, origin on the property line at the front-left corner, `y = 0` yard level.
- **Props and vehicles:** voxel `CityCore.PV` = **5 cm** (models in `VoxModel` at 5 cm, meshed to metres by `meshVoxels3D`;
  some prop parts use 10 cm cells). Vehicles: +x nose, z centred (+z right side), y = 0 on the ground, all in metres.
- **World:** metres; the road raster uses 0.5 m (`voxel`, passed to kits as `voxel` / `hs`). Emitter quads go through
  `E.quad(p, q, r, s, mat, normal)` in the emitter's own units, `E.vox(C, model, x, y, z)` places a `VoxModel`.
- Parts are `new (L.VoxModel())(w, h, d, ox, oz)`; `M.box(x0,y0,z0,x1,y1,z1,mat)` is inclusive-exclusive, relative to the origin
  column `(ox, oz)`. One model = one greedy-meshed solid.

## 3. Materials palette

- Building materials: `L.BM` (ids in `city_arch.js` `BM`, colours in `ARCH_PALETTE`; ids 71..112, 133..135, 141..159). Prop
  materials: `CityCore.PM` (ids 54..70, 126..140) in `PROP_PALETTE`. Vehicles: `CityCore.VM`, ids 160..201 (`VEH_PALETTE`).
  The viewer registers all three palettes; ids must stay unique across them (`LITTER` etc. alias on purpose).
- Plug-ins **use existing materials**; do not invent colours inline. Lit glass variants (`*_LIT`, set `LIT`) glow at night,
  `BEACON` blinks, `NEON` / `LED` are emissive.
- **To add a material** (needs the owner of city_arch.js / city_core.js, never from a plug-in): pick the next free id in the right
  range (grep for the highest `BM` / `PM` / `VM` id; vehicles continue at 202+), add it to the id table and the palette with a muted, slightly
  washed-out sRGB triple, add it to `LIT` only if it should glow, check the shader's material-id limit (the viewer palette texture), run
  `dev/check.js` and rebaseline only if the owner approves a changed look.
- Materials named for a role (`WOOD`, `TRIM`, `CONCRETE`) are shared by every plug-in; prefer them over near-duplicates
  (several plug-ins keep their own local colour tables `K.CONC`, `K.LIME`...: see TODO).

## 4. Determinism

The city must be bit-identical for a seed, in the worker and in Node, in any build order or chunking.

- Every random choice comes from a hash of **the city seed + stable ids** (block id, lot id, road id, component index, a
  per-feature salt): `C.mulberry32(hash(...))`, `L.H2(seed, a, b)` (cell hash), or the per-lot `R()` you are given.
- Never `Math.random()`, `Date.now()` in anything that affects geometry (timing stats are fine), global mutable counters, the
  iteration order of a `Map` / `Set` filled by other plug-ins, or the number of `R()` calls made by a neighbour. Draw from `R()` in a fixed
  order inside your function; if a sub-feature is optional, give it its own `mulberry32(hash(...))` so toggling it cannot shift
  the others.
- Variant models are cached by key (`kind + variant`) and never mutated after building.
- Adding a plug-in changes which design lands on which lot (deck shuffle). That is expected; rebaseline after approval (section 8).

## 5. Clipping and geometry rules

- **No coplanar faces:** two same-facing surfaces in one plane flicker. Build touching parts as one `VoxModel`, or separate them by at
  least 1 voxel. Overlays on the ground (paving, paths, lawns, pads, markings): **>= 2.5 cm above the surface below**, ideally
  3.5 cm; keep stacked overlays >= 2.5 cm apart (checked by `groundfight.js`, tolerance 2 cm).
- **No interpenetration:** vehicles, props and parts may not pass through each other or through walls (`vehicles_check`,
  `traffic_check`, gap 15 cm). Keep a 15 cm gap between vehicles; leave pedestrian clearance around props.
- **Props / footprints:** props respect `ctx.footprints` (stoops, entrances) and the sidewalk clearance band; a plug-in owns its
  whole lot rectangle (nothing outside `W x D`, no projection past x = 0 / W on a party side). Attached sides (`spec.party`) get
  a plain flush party wall. Yard fences: each lot draws its back and left line, the right line only if `!neighbours.r`, at least 1 voxel inside.
- **No holes:** nothing see-through; every visible side closed. Hidden faces (undersides, party walls) are kept on purpose
  (shadow pass renders back faces), do not optimise them away.
- **Vehicles on lots** must have a drive aisle to the street and a curb cut (`access.js`).
- **Budget:** 30..90 k triangles per tower, details through `Relief` skins (cheap). Preview titles show counts.

## 6. Recipe: add a new thing

**Building (tower / mid-rise)**
1. `cp templates/tower_template.js towers/<name>.js` (or `mid_template.js`); rename the function and the registered name.
2. Build with `L.buildTiers` + skins + `VoxModel` parts; take every variation from `R()` / `L.pick(R, [...])`. Dress the roof with
   `L.roofKit && L.roofKit(...)`.
3. Add `'<name>.js'` to `towers/manifest.js` (before the kits that follow it).
4. `cd tools/city_lab && python3 -m http.server 8765`; `node dev/preview.js <name> out.png "w=30&d=30&floors=10&seed=7"`; try 3 seeds,
   narrow / wide lot, night.
5. `node dev/check.js --quick`, then `node dev/check.js` (all seeds).

**House:** the same with `templates/house_template.js`, `registerHouse` with the lot ranges and a `weight`; leave yard work to the yard kit.
**Kit (rural item, park item, service clutter):** `templates/kit_template.js`: model builder with a hash-keyed cache + a pass over stable
ids; or, for something that fits an existing kit, add a model and a placement rule inside that kit (park items: `parkkit.js`,
yard items: `yardkit.js`, back-of-house: `servicekit.js`). A rural kit (`towers/ruralkit.js`) follows the kit template.
**Vehicle:** add the kind to `CityCore.Vehicles` (city_core.js section 7b: `KINDS`, `INFO`, a model function, livery in `paints`), then
`node dev/vehicles_sheet.js sheet.png` to see all kinds / states, `node dev/vehicles_stats.js` for triangle cost, `dev/vehicles_check.js`.
**Street furniture:** `PROP_TYPES` entry + model + `placeProps` rule (engine file).

## 7. Dev tools

| Tool | Purpose |
|---|---|
| `dev/check.js [seeds] [--quick]` | the whole headless suite in one table, non-zero exit on failure (zfight --props, groundfight --self, traffic, vehicles, access, regress) |
| `dev/lib/pw.js`, `dev/lib/args.js` | shared Playwright-from-disk serving, frozen clock, build wait; argv helpers |
| `preview.js`, `spots.js`, `cam.js`, `shots.js`, `perf.js`, `vehicles_sheet.js` | screenshots / timing (Playwright) |
| `zfight.js`, `groundfight.js`, `meshcheck.js` (library), `overlap.js` | geometry checks |
| `traffic_check.js`, `vehicles_check.js`, `access.js` | vehicle clearance and access |
| `regress.js`, `build_stats.js`, `vehicles_stats.js` | locked-downtown baseline compare, build / triangle statistics |

## 8. Rebaselining

`dev/baseline_downtown.json` (written by `regress.js --update`) holds per-building signatures for seeds 1-3. It is **stale**:
it predates later plug-ins (parkkit, traffickit, yard, overlap fixes, the 5x city growth), so `regress` fails until it is
re-recorded. To rebaseline: (1) get owner approval of the new look; (2) `node --max-old-space-size=8000 tools/city_lab/dev/regress.js --update`
(all of seeds 1-3, props on); (3) `node dev/shots.js --update` for `dev/baseline_shots/`; (4) run `dev/check.js` (all PASS) and commit both together with the change.
Never rebaseline to silence a geometry failure.

## 9. Lint TODO (static pass over `towers/*.js`, nothing refactored yet)

Candidates to move into a shared `towers/lib` (or `CityArch.lib`) so a new plug-in does not copy them:
- **Hash / RNG:** `parkkit.js` defines its own FNV `hash(s)`; `mid_civic.js` (`reseed`) and `mid_modern.js` hand-roll
  `mulberry32((seed * K) ^ salt)` with different magic multipliers (2654435761, 131 / 7919, 104729, 31337, 0x9a7c). Provide one
  `L.hashStr(s)` and `L.rng(seed, ...ids)`.
- **Trees:** `tree()` / `treeModel()` re-implemented in `commercial`, `forest`, `mid_modern`, `roofkit`, `skygarden`, `twins`, `wave`,
  `parkkit` (`treeModel`), `yardkit` (`treeModel`): same trunk / canopy idea, different signatures. One shared `L.treeModel(sp, variant)` cache. Same for `bushModel` (parkkit, yardkit).
- **Cars:** `car()` / `carFits()` in `commercial.js` and `mid_modern.js`, `carModel()` in `yardkit.js`, while the vehicle library
  already exists (`CityCore.Vehicles`): replace all by `Vehicles.emit`.
- **Lamps / fences / benches:** `lamp()` (commercial, mid_civic), `fence()` (servicekit, yardkit), bench / planter / picnic in parkkit.
- **Local colour tables:** `K.CONC / K.LIME / K.GRAN_D / K.WOOD / K.CREAM` (parkkit), analogues in servicekit / traffickit; belong in `BM`.
- **Aliases at the top of every file:** `const A = self.CityArch, L = A.lib, BM = L.BM, H2 = L.H2, FH = ...` repeated in 15 files.
- **Magic numbers:** lot margins (`m = 4`), body depth caps (`36`), overlay lifts (`0.02`, `0.025`, `0.05`: use named `LIFT_*` constants
  >= 0.025 / 0.035), clearance bands, car sizes (7 x 15..19 voxels recognised by access.js), roof `parapet: 1/2`, per-file `Date.now()` timing blocks (`parkkit`, `traffickit`; wrap in one `L.timed`).
- **Dev-script duplication:** the `--list= / --tol= / seed` argv parsing is copy-pasted in 8 scripts (use `dev/lib/args.js`), and
  `meshcheck.build` is the single place that should construct headless cities.
