# Writing a signature tower for City Lab

City Lab: `tools/city_lab/`. Buildings live in `city_arch.js`. Towers are plug-ins in `towers/<name>.js`, one file per tower type. Each file registers itself:

```js
(function () {
  const A = self.CityArch, L = A.lib, BM = L.BM, FH = L.FH;
  function towerXxx(E, C, W, D, spec, R) { /* build it */ }
  A.registerTower('xxx', towerXxx);
})();
```

**Owner's direction**
- Each high-rise is its own project, with its own design philosophy, constraints and ideas.
- Modern high-rises don't start from the ground: they rise from an older building, or from a base built for them (podium, plaza, arcade, lobby on columns).
- More detail, realistic and intentional, so it doesn't feel AI-generated or like a Lego city. Voxel art, not photoreal. A diorama.
- They liked the terraced glass tower with trees on its setbacks (`towerTerraced` in city_arch.js) and called it original and realistic. Aim for that level.
- They disliked: copy-paste repetition, plain extruded boxes, stacked boxes, and blank walls.

## Coordinates and parameters

- **Building-local voxels:** 1 voxel = 0.25 m (`L.BV`). x runs along the street (0..W), z goes into the lot (0..D, so z=0 is the street front), y is up.
- **Lot size:** W and D are typically 72–180 voxels (18–45 m). Fill the lot: no gaps to neighbours at the front.
- **Inputs:** `spec.floors` is the suggested height (18–44; you may scale it ±50% to suit the concept). `spec.party = {l, r, b}` marks attached neighbours (b: a building flush against the back). `R()` is a seeded random in [0,1). Use it for per-instance variation (proportions, tints, tops) so two copies of your tower differ clearly.
- **Storey height:** `FH = 14` voxels (3.5 m). A lobby storey is typically 18–20.

## Toolkit (`L = CityArch.lib`)

**Tiers.** `L.buildTiers(E, C, W, D, tiers, spec.seed)` stacks tiers and returns the top y. A tier is one of:
- `{x0,z0,x1,z1, h, skin, roof, party}`: a rectangle with facade corner returns;
- `{x0,z0,x1,z1, notch:n, ...}`: a rectangle with notched corners;
- `{mask: Uint8Array(W*D), ...}`: any shape;
- `{gap: h}`: open storeys. The tier after a gap gets a soffit automatically. `floating:true` also gives a soffit, for overhangs.

Each tier's roof skips the area covered by the next tier, so there are no hidden coplanar faces. Roof options: `{parapet, mat, deck, units}`. `noRoof: true` leaves the roof off. Upper tiers must lie inside the tier below, unless `floating`.

**Skins.** A skin is `skin(len, h, info) -> L.Relief`, a facade relief map:
- `new L.Relief(len, h, ext, wallMat)` fills the wall at depth `L.BASE` (2).
- `F.rect(u0, v0, u1, v1, depth, mat)` paints depth and material over cells. Depth 0–1 is recessed (glass, doors, lobbies); 3–7 projects (sills, fins, cornices, canopies).
- `F.returns()` carries projections around corners (use `ext` 1–6).
- The returned relief must be exactly `h` tall.
- Existing skins you can reuse or study: `skinPodium, skinDeco, skinDecoBase, skinCurtain(S,{fin,mech,tint,pitch,slabs,slabMat,mullion,cap}), skinBronze, skinPilotis, skinFins, skinPomo, skinArcade, skinPrecast, skinLouver`. Most take `S = {seed, stone, stoneDark, trim, ...}`; read their code in city_arch.js.
- Windows: `L.glassMat(seed, a, b, litFraction, tint)` with tint 'curtain' | 'green' | 'dark' | 'blue' | undefined. Some windows are lit at night.
- `L.bays(len, bayW, margin)` gives symmetric bay centres; `L.H2(a,b,c)` is a hash; `L.pick(R, array)`.

**Voxel parts.** `const M = new (L.VoxModel())(w, h, d, ox, oz); M.box(x0,y0,z0,x1,y1,z1, mat)` builds a part, with coordinates relative to the origin column (ox, oz). `E.vox(C, M, x, y, z)` places it at building-local (x, y, z). It is greedy-meshed as one solid, so overlapping boxes inside one model are fine. Use these for crowns, spires, balconies, bridges, planters, trees, signs and canopies. Ready-made: `L.decoCrownModel, lanternModel, mastsModel(R), craneModel(len), pyramidModel, pedimentModel, plazaModel(w,d,R), planterRowModel(len)`, plus `L.waterTank(E, cx, cz, y, C)`.

**Other helpers.**
- `E.box(...)` draws a raw box. Avoid it next to other geometry: it z-fights where faces coincide.
- `L.rotated(E, cx, cz, theta, ox, oz)` returns an emitter rotated rigidly about (cx, cz), for twisted or angled parts.
- `L.facades(...)` and `L.flatRoof(...)` exist too.

**Materials (`L.BM`).**
- Stone: LIMESTONE, LIMESTONE_DARK, BUFF, GRANITE_PINK, GRANITE_DARK, TERRACOTTA, PRECAST, WHITE_CONCRETE, CONCRETE.
- Brick: BRICK_RED, BRICK_DARK, BRICK_BROWN.
- Metal: BRONZE, METAL, STEEL_DARK, MULLION, LOUVER, COPPER, SPANDREL.
- Glass: GLASS, CURTAIN, GLASS_GREEN, GLASS_DARK, GLASS_BLUE (each with a `_LIT` variant: GLASS_LIT, CURTAIN_LIT, ...).
- Emissive: NEON (pink), LED (white), BEACON (red, blinks).
- Nature: GRASS, LEAF, LEAF_DARK, TRUNK, WATER.
- Other: TRIM, TRIM_DARK, ROOF_TAR, AWNING_RED/GREEN/BLUE, STOREFRONT, DOOR_*.
- Do not add materials.

## Rules

- **No coplanar faces.** Two different surfaces in the same plane flicker. Don't stack separate boxes face to face; build parts as one VoxModel, or offset them by at least 1 voxel. Check with `node --max-old-space-size=8000 tools/city_lab/dev/zfight.js 1 --raw` (what your geometry produces) and without `--raw` (after the build's z-fight pass, must be 0). The pass resolves leftovers in painter's order (later geometry wins), so emit walls before the parts mounted on them.
- **No holes.** Nothing may be see-through. Every visible side of every volume must be closed.
- **Budget:** about 30–90 k triangles per tower (the preview title shows the count). Facade detail comes from reliefs, which are cheap.
- **Files:** only edit your own `towers/<name>.js` file(s). Do not edit city_arch.js, city_core.js, city_lab.html or other agents' files.

## Preview and verify (required)

A local server runs on port 8765. If it isn't up: `cd tools/city_lab && nohup python3 -m http.server 8765 >/dev/null 2>&1 &`

Render one tower on an empty lot:

```bash
node /tmp/claude-0/city/preview.js <name> /tmp/claude-0/city/<name>_a.png "w=40&d=44&floors=30&seed=7&yaw=0.6&pitch=0.25"
```

- Options: `dist=` camera distance (m), `ty=` target height (m), `night=1`. The output prints the triangle count and any page errors.
- Look at the PNG with the Read tool. Check several seeds (`seed=3`, `seed=11`), a narrow lot (`w=22&d=30`), a wide lot (`w=44&d=46`), a close-up at the base (`dist=40&ty=8&pitch=0.1`), the top, and night.
- Iterate until it looks intentional, detailed and clean. Report the final screenshot paths.

---
# Phase 2: downtown mid-rises, roofs and block placement

The owner was happy with the towers. Next: make **downtown** feel real.
- More logical placement and design.
- Denser blocks with fewer gaps between buildings.
- More utility equipment on roofs.
- Water towers are too repetitive.

## Mid-rise plug-ins (3–14 storeys)

Register one with:

```js
CityArch.registerMid(name, fn, { minW, maxW, minFloors, maxFloors, zones })
```

**Signature:** `fn(E, C, W, D, spec, R, L)`, the same as for towers.
- `spec = { seed, floors, party: {l, r}, shops, zone }`.
- `zone` is `'core'` (near the towers), `'mid'` (downtown) or `'row'` (old-town and downtown-fringe rows).
- `minW` and `maxW` are frontage widths in metres. The placer picks your type only for lots in that range and in your zones.

**Lots:**
- 8–40 m frontage (W), 9–34 m deep (D), front at z = 0.
- Buildings in a block are attached. `spec.party.l` / `.r` = true means a neighbour is attached on that side, so give those side walls a plain, flush party wall: no windows and no projections past x = 0 or x = W.
- Corner and free sides get real facades.
- Fill the lot completely: the full W, and the full D unless your concept has a rear light court.

**Each building should:**
- have a clear identity and period;
- have a believable ground floor (shops, lobby, loading, garage entrance) when `spec.shops` is true;
- vary clearly with `R()` (proportions, materials, details).

**Roof:** call `L.roofKit && L.roofKit(E, C, x0, z0, x1, z1, yTop, R, { style, floors, avoid })` to dress it with utility equipment. `style` is `'historic'`, `'office'`, `'residential'` or `'industrial'`; `avoid` lists rectangles you used for your own rooftop features. Do not add your own generic boxes or water tanks unless they are part of your concept.

**Preview** a mid-rise the same way as a tower (mid names work in `?tower=`), e.g.:

```bash
node /tmp/claude-0/city/preview.js <name> out.png "w=20&d=28&floors=8&seed=7&dist=70&ty=12"
```

## Full-city check

`node /tmp/claude-0/city/spots.js '[["name",x,z,"rts"],...]'` writes `/tmp/claude-0/city/spot_<name>.png`. Views are `"rts"` (about 95 m), `"overview"` or `"street"`.

Useful spots on seed 1:
- downtown grid: `[-200,60]`, `[-230,120]`, `[-91,-21]`, `[-160,-150]`
- old town: `[150,-90]`, `[220,-160]`
- Union Square: `[-175,35]`

`node /tmp/claude-0/city/tow.js '[["name",tx,ty,tz,px,py,pz]]'` takes a free camera (target, then eye position).
