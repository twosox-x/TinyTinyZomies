# Baked city package — format v1 / v2

Produced by `tools/city_lab/bake/bake.js` (offline; Node), read by the engine. Same inputs (seed, scale, code) give
byte-identical files. Everything is **little endian**. World frame: metres, **x / z on the ground, y up**; the map is
flat (ground y = 0, sidewalks / curbs at +0.15 m). City Lab draws with the same axes (right-handed, three.js).

```
<out>/                       e.g. assets/city/seed1
  city.json                  map, grid, palette, vehicle / prop variant lists, roads, land use, spawns, stats
  tiles/<i>_<j>.bin          one per 128 m tile (i along +x, j along +z, from the map corner bounds.x0 / bounds.z0)
  vehicles.bin               vehicle / traffic-prop variant meshes (LOD0 + LOD1)
  props.bin                  street-furniture meshes (lamps, signals, benches, street trees, ...)
  landuse.bin                coarse land-use grid (u8 codes, legend in city.json)
  foliage.bin                instanced voxel foliage models (crops, grass, reeds, rocks, hay; optional, section 4b)
```

bake.js writes **file format v2** end to end: LOD1 order + `LOD2` + sub-tile chunks (`CHNK`) + zstd-compressed
sections (`--level=19` default, `--no-compress`, `--no-chunks`). An existing package (v1 or v2) is repacked in place,
without a re-bake, by `node relod.js <dir> [--force] [--level=N] [--no-compress] [--no-chunks]` (~40 s for seed 1 on
4 cores; bake.js and relod.js share `lod.js processTile`, so both give byte-identical tiles). Readers accept v1 and v2
files. `city.json.compression` is `"zstd"` when sections are compressed (`"none"` otherwise); seed 1: 755 MB of
sections store as ~94 MB (8x).

## 1. Common: binary file layout

Optional sections / files (`WATR`, `FOLI`, `BLDG`, `foliage.bin`) were added without a version bump: older readers skip them
(unknown tags) and simply draw no water surface / foliage. Every `.bin` starts with a 16-byte header and a section table; sections are 4-byte aligned, in table order.

| offset | type | field |
|---|---|---|
| 0 | char[4] | magic: `TTZT` tile, `TTZV` vehicles, `TTZP` props, `TTZL` land use, `TTZF` foliage |
| 4 | u32 | format version: 1 or 2 |
| 8 | u32 | section count `n` |
| 12 | u32 | reserved (tile: `i | j << 16`; else 0) |
| 16 | v1: n x {char[4] tag, u32 offset, u32 bytes}; v2: n x {char[4] tag, u32 offset, u32 stored bytes, u32 raw bytes, u32 encoding} | section table (offset from file start) |

Unknown tags must be skipped (forward compatible).

**v2 section encoding** (per section; everything below this section describes the decoded bytes):

| bits | meaning |
|---|---|
| 0-7 | codec: 0 = stored as is (stored = raw bytes), 1 = **zstd** frame (one frame, decompresses to `raw bytes`) |
| 8 | `SHUF12`: after decompression, the vertex region of a mesh section, bytes `[72, 72 + 12 V)` (`V` = the decoded u32 at 0), is stored as 12 byte planes (plane `c` holds byte `c` of every vertex); un-transpose it. Set on mesh sections (`MESH`, `LOD2`, `V###`, `W###`, `P###`) |

The bake compresses a section only when that makes it smaller (level 19, no checksum). Typical ratios: MESH ~11x
(shuffled), HGT0 12-35x, VEHI / PROP ~2x. The engine decodes on its loader thread (vendored zstd decoder).

## 2. Mesh section (`MESH` in tiles; `V###` / `W###` / `P###` in vehicles.bin / props.bin)

A mesh is an **implicit quad list**: 4 vertices per quad, no index data. Triangles of quad `q` are vertices
`4q + (0, 1, 2)` and `4q + (0, 2, 3)`; the engine draws every mesh with one shared static index buffer of that
pattern (u16 covers 16384 quads per draw, use `vertex_offset` / u32 beyond). Quads that belong to the far LOD come
**first**: LOD1 = draw the first `lod1Quads` quads, LOD0 = draw all `quads`.

Header (48 bytes):

| offset | type | field |
|---|---|---|
| 0 | u32 | vertex count `V` (= 4 * quads) |
| 4 | u32 | index count (0: implicit quads) |
| 8 | u32 | index size (0: implicit quads) |
| 12 | u32 | flags: bit 0 = implicit quad list (always set); bit 1 = chunk ordered (tile MESH with a `CHNK` section) |
| 16 | f32 | scale xz: metres per position unit for x and z |
| 20 | f32 | scale y: metres per position unit for y |
| 24 | f32 x 3 | origin (metres): world/model position of quantised (0,0,0) |
| 36 | u32 | `lod1Quads`: leading quads drawn at LOD1 |
| 40 | u32 | `quads` (= V / 4) |
| 44 | u32 | reserved (0) |

then `f32 aabbMin[3], aabbMax[3]` (24 bytes, metres, of all quads, after quantisation), then `V` vertices of
**12 bytes** (offset 72).

Vertex (stride 12):

| offset | type | meaning |
|---|---|---|
| 0 | i16 x, y, z | position = origin + (x * scaleXZ, y * scaleY, z * scaleXZ) |
| 6 | u16 | vertex flags: bit 0 = **body paint** (tint by the instance paint colour, vehicles only); others 0 |
| 8 | i8 nx, ny, nz | normal * 127 (unit, flat per quad) |
| 11 | u8 | material id (palette index, `city.json.palette`) |

SDL3 GPU: `SHORT4` at 0 (w = flags, ignore or bit-test), `BYTE4` at 8 (w comes in as a signed int: use
`uint(w) & 255u`, or read `UBYTE4` and sign-decode xyz). Triangles are counter-clockwise seen from the front
(outside), i.e. front face = CCW in a right-handed y-up frame.

Quantisation used by the bake: per mesh, `scale = 2^-k` with the largest `k <= 9` (finest 1/512 m) such that every
vertex fits in int16 (|coord - origin| / scale <= 32000); x / z share one scale, y has its own. Always read the scales
from the header. Typical values:

| mesh | origin | scale xz | scale y |
|---|---|---|---|
| tile | (tile centre x, 0, tile centre z) | 1/256 m (owned buildings reach up to ~60 m past the tile edge; 1/128 m past 125 m from the centre) | 1/512 m up to 62 m, 1/256 m up to 125 m, 1/128 m up to 250 m, 1/64 m up to 500 m |
| vehicle / prop | model origin (0, 0, 0) | 1/512 m | 1/512 m |

Vertices are not shared across quads (normals are flat). Quads are the City Lab greedy
quads after `finish(0.002)` (grown 0.2 mm in-plane against T-junction pinholes); the bake does not add geometry.

## 3. Tile file `tiles/<i>_<j>.bin` (magic `TTZT`)

Tile `(i, j)` covers world x in `[bounds.x0 + 128 i, + 128)`, z in `[bounds.z0 + 128 j, + 128)`. Its geometry is
everything the tile **owns** (road surface of its rectangle, buildings whose centre is in it, kit quads whose
centre is in it); owned buildings may extend beyond the rectangle (use the AABB for culling).

Sections, in this order (a section may be absent if empty):

- `MESH` — road / ground raster + buildings + kit dressing (yards, parks, rural trees, service yards) as one mesh,
  LOD0 + LOD1 (section 2). LOD1 (mid) = the leading `lod1Quads` quads: quads whose longest edge is >= 1 m, plus
  upward-facing quads (ground raster, decks, roofs) whose longest edge is >= 0.35 m, so ground and roofs stay closed
  (window reveals, sills, trim, small dressing are dropped). ~40-60 % of LOD0's quads (`lod.js relodMesh`).
- `CHNK` — sub-tile chunks (v2; present when `MESH` flags bit 1 is set). `MESH` quads are then **sorted by chunk**: a
  `nx x nz` grid (4 x 4) of `size` m cells (32 m) from the tile corner (`x0, z0` = MESH origin - 64 m); a quad goes to
  the chunk of its centre (clamped to the grid; owned buildings past the tile edge go to the border chunks), and
  inside each chunk the LOD1 quads come first. MESH header `lod1Quads` is then only the total; LOD1 is per chunk.
  Layout: `u32 n (= nx * nz), u32 nx, u32 nz, f32 size, f32 x0, f32 z0`, then `n` records of 40 bytes (row = z):

  | offset | type | field |
  |---|---|---|
  | 0 | u32 | first quad of the chunk in MESH (chunks are contiguous, in order) |
  | 4 | u32 | LOD1 quads of the chunk (its leading quads) |
  | 8 | u32 | quads of the chunk (LOD0) |
  | 12 | u32 | reserved (0) |
  | 16 | f32 x 3, f32 x 3 | AABB min / max (metres) of the chunk's quads (zeros when empty) |

  Chunk LOD0 = quads `[first, first + quads)`, chunk LOD1 = `[first, first + lod1)`; an engine culls and picks the LOD
  per chunk and merges contiguous ranges into one draw.
- `LOD2` — far LOD (`lod.js lod2Mesh`), a mesh (section 2, `lod1Quads = quads`) derived from `MESH`: a 2.5D block
  model on a 2 m grid aligned to the tile corner. Upward surfaces are sampled every 0.5 m (highest one wins); a cell
  takes the median height of its 16 samples (empty when more than half are missing) and the majority material near
  it; equal (height, material) cells are greedy-merged into rectangles. Walls stand where a cell is >= 0.3 m higher
  than its neighbour (or an empty cell), split into 3 m storey bands whose material is the majority of the facade
  quads behind that edge (brick / lit windows / glass, so night skylines keep window rows), merged along runs. No
  props or vehicles (instanced separately). ~1-8 k triangles per tile (4 % of LOD0 overall). Optional: an engine
  falls back to LOD1 when absent. Same winding / normals as section 2.
- `VEHI` — vehicle / traffic-prop instances owned by the tile (seams resolved: an instance overlapping one kept in an
  earlier tile, tile order j-major then i, is dropped). `u32 count`, then `count` records of **28 bytes**:

  | offset | type | field |
  |---|---|---|
  | 0 | u16 | variant index (into `city.json.vehicles.variants` / vehicles.bin) |
  | 2 | u16 | flags (0) |
  | 4 | u8 x 4 | paint: r, g, b (sRGB 0..255), paint material id (0 = untinted: use the mesh colours) |
  | 8 | f32 x 3 | position: world metres of the model origin |
  | 20 | i16 x 4 | rotation quaternion x, y, z, w * 32767 (normalise after decoding) |

- `PROP` — street furniture instances (lamps, signals, stop signs, hydrants, benches, street trees, kiosks, bins...).
  `u32 count`, then records of **24 bytes**: `u16 type` (index into `city.json.props.types` / props.bin), `u16` reserved,
  `f32 x, y, z` (world metres), `f32 yaw` (radians about +y; model +z turns to (sin yaw, 0, cos yaw)), `f32 phase`
  (signal phase: 0 or 1, crossing roads alternate in the 30 s cycle).
- `HGT0` — collision / height grid for simulation and pathing. Header `u32 nx = 256, u32 nz = 256, f32 cell = 0.5,
  f32 originX, f32 originZ` (world metres = tile corner), then `i16 top[nz][nx]` then `u8 flags[nz][nx]` (row = z).
  `top` = height of the highest **solid, upward-facing** surface over the cell in centimetres (ground 0, sidewalk 15,
  roofs, walls' tops, car roofs, prop tops ...). Foliage (leaf / hedge / grass materials 133, 134, 155, 14, 10 more than
  1 m above the ground) never sets `top`; it sets `VEG`. Crowns of red / autumn trees use brick / salmon / orange
  materials and do count as solid (v1 limitation: such a tree reads as a BLOCKED disc).
  Flags:

  | bit | name | meaning |
  |---|---|---|
  | 0 | ROAD | carriageway / alley / parking / driveway / crosswalk at ground level |
  | 1 | WALK | sidewalk / plaza / park path at ground level |
  | 2 | BUILDING | a building or structure (not a vehicle) rises over the cell |
  | 3 | WATER | water surface |
  | 4 | VEG | foliage over the cell, or forest / crop ground |
  | 5 | BLOCKED | top is > 0.5 m above the local ground (not walkable for a zombie at ground level) |
  | 6 | VEHICLE | a vehicle footprint covers the cell |
  | 7 | OPEN | grass / yard / lot / farmland at ground level (walkable, not paved) |

  Cells with only vertical geometry thinner than the sampling (0.25 m) can be missed; poles (lamps / signals) are
  stamped from the `PROP` list as BLOCKED 0.5 m cells.

- `WATR` — optional (tiles that water or a bank reaches): smooth water surface. Header (32 bytes): `u32 nx, u32 nz`
  (129 x 129), `f32 cell` (1 m), `f32 x0, z0` (tile corner), `f32 level` (water surface y, m: -1.9), `f32 bank` (bank
  width, m: 3.5), `u32` reserved; then `i16 sd[nz][nx]` = signed distance to the shore (cm, > 0 over the water) at the
  grid points (x0 + i * cell, z0 + j * cell). Grid points on a tile edge are computed from the same world position in
  both tiles, so surfaces meet without seams. The engine draws a flat surface at `level` over the cells whose corners
  reach sd > -1.6 m (the bank hides the part under it) and shades it from the interpolated sd (depth tint, foam line
  near the shore). The terrain under it (in `MESH`) is the bank: ground (+0.15 m at sd <= -3.5 m) sloping in 0.1 m
  voxel steps to -2.3 m at the shore line and a bed to -3.6 m (`city_core.js WATER / bankY / waterColumn`); bed
  material 206 marks HGT0 WATER. Road bridges cut the bank under their deck (carve to -2.6 m) and are part of `MESH`
  (owned by the tile containing the bridge centre; HGT0 of every tile they cross is overridden: deck ROAD at +0.03 m,
  sidewalks WALK at +0.18 m, parapets / central barrier / arch ribs BLOCKED).
- `FOLI` — optional: instanced foliage owned by the tile (instance position inside the tile). Header: `u32 count, u32
  nc (16 chunks, the CHNK grid), u32 nt (8 type slots), u32` reserved, `u32 start[nc * nt + 1]` = first instance of
  each (chunk, type) range (chunk major, row = z; `start[nc * nt] = count`), then `count` records of **8 bytes**:

  | offset | type | field |
  |---|---|---|
  | 0 | u16 | x: 1/512 m from the tile corner |
  | 2 | u16 | z: 1/512 m from the tile corner |
  | 4 | i16 | y: ground height, mm |
  | 6 | u8 | yaw: 2 pi / 256 (model +z turns to (sin yaw, 0, cos yaw)) |
  | 7 | u8 | scale: 1/100 |

  Types (`city.json.foliage.types`, index = foliage.bin model): 0 wheat clump, 1 corn plant, 2 soy bush, 3 grass tuft,
  4 reeds, 5 rock, 6 hay bale. Placement (`waterkit.js foliage`): jittered 0.8 m grid aligned to the (axis aligned)
  field parcels: corn one plant per 0.8 m on the 2.4 m crop rows, soy on its 2.0 m rows, wheat clumps over the wheat
  ground, grass tufts on pasture / verges / headlands, reeds at the waterline in 5 m clusters, rocks on the banks, rare
  hay bales. Foliage never sets HGT0 `top` (ground cells keep VEG / OPEN from the raster).

- `BLDG` — optional (added 2026-11-27 for Milestone B3; older readers skip it, older packages have none): one record
  per building the tile **owns** (City Lab building jobs: suburban houses, row houses, mid-rises, towers, commercial).
  Header `u32 count, u32 recordBytes` (140), then `count` records:

  | offset | type | field |
  |---|---|---|
  | 0 | u32 | id: `((j << 8 | i) << 12) | k` (k = own job index in the tile), unique per package |
  | 4 | u8 | kind: 1 house (suburban), 2 row house, 3 mid-rise (incl. `tower` jobs <= 12 floors), 4 tower, 5 commercial, 6 other |
  | 5 | u8 | floors (job storeys; houses: 1 or 2 from the height) |
  | 6 | u8 | flags: bit 0 = flat (walkable) roof |
  | 7 | u8 | door count (0..4) |
  | 8 | f32 x 2 | footprint corner O (x, z): front-left corner of the oriented footprint rectangle |
  | 16 | f32 x 2 | e1 (x, z): unit axis along the street frontage; e2 (into the lot) = the perpendicular opposite to the door normals |
  | 24 | f32 x 2 | w (along e1), d (along e2), metres: the job frame tightened to the building's own quads above 2.2 m |
  | 32 | f32 | y0: ground floor level |
  | 36 | f32 | roofY: walkable roof level (flat: the upward surface level with the largest area above 2.5 m, it covers >= 35 % of the footprint); pitched: eave = y0 + 3 m x floors |
  | 40 | f32 | topY: highest point of the building (antennas, tanks) |
  | 44 | 4 x {f32 x, y, z, nx, nz, width} | doors (unused entries zero): on the front facade (one per ~9 m for row houses, two above 24 m frontage), outward normal; towers add a rear door |

  Doors are placed on the front facade (City Lab's facades put the entrance on the street side); their exact position
  along the facade is approximate. Windows, firing positions, the stair core and the roof hatch are derived by the
  engine (`src/game/Buildings.cpp BuildingRegistry::prepare`) against the live height grid.

## 4. `vehicles.bin` (magic `TTZV`) and `props.bin` (magic `TTZP`)

For variant / type `k` (3-digit decimal): LOD0 mesh tag `V###` (vehicles) / `P###` (props); vehicle LOD1 tag `W###`
(City Lab's `lo` box proxy; absent when the variant has none: use LOD0). Each section is one mesh (section 2) in model
space; `lod1Quads = quads` there. Props have no LOD1 in v1.

Vehicle model frame: metres, y up, as City Lab builds the variant; world = R(q) * model + position, where q / position
are the instance's rotation and translation (City Lab's 3x4 instance matrix; yaw about +y, plus a roll for
overturned wrecks; the bake checks R is orthonormal and reports `stats.quatMaxOrthoErr`). Variants include traffic
props (cones, barriers, debris: `kind` starts with `prop:`). Body paint: vertices with flag bit 0 (City Lab material =
the paint placeholder `city.json.vehicles.paintPlaceholder`, 169) take the instance paint colour when the instance
paint material id is non-zero, else keep the palette colour of 169.

## 4b. `foliage.bin` (magic `TTZF`, optional)

For type `k`: LOD0 mesh `F###`, LOD1 mesh `G###` (section 2, model space, metres, origin on the ground, voxel boxes;
LOD1 = 1-3 boxes). `city.json.foliage = { file, types: [{ name, sway (wind weight 0..1), quads: [lod0, lod1] }],
instances }`. Engine (src/city/CityWater.cpp `CityFoliage`): per visible tile chunk within 150 m one instanced draw per
type, LOD0 below 45 m from the chunk, density thinned per instance from 70 m to 150 m (shrunk, no popping), wind sway
growing with height. Materials 208-221 (wheat, corn, soy, grass, reed, rock, hay, bridge steel / stone, wood) extend
the palette (`city.json.palette` has 222 entries).

## 5. `landuse.bin` (magic `TTZL`)

Section `LUSE`: `u32 nx, u32 nz, f32 cell (8 m), f32 originX, f32 originZ`, then `u8 code[nz][nx]` sampled at cell
centres with `CityCore.landUseAt`. `city.json.landUse.legend` maps code -> name (0 = unknown).

## 6. `city.json`

```jsonc
{
  "format": "ttz-city", "version": 1, "compression": "zstd",       // "none" when sections are stored as is
  "seed": 1, "scale": 5, "generator": { "urbanScale": 2, "ruralScale": 3, "voxel": 0.1 },
  "bounds": { "x0": .., "z0": .., "x1": .., "z1": .. },          // world metres
  "tile": { "size": 128, "ni": 18, "nj": 16, "lod2": true, "chunks": { "n": 4, "size": 32 }, "files": "tiles/{i}_{j}.bin", "present": [[i, j, bytes], ...] },
  "palette": [ {                                                  // index = material id (0..207)
      "id": 87, "name": "GLASS_LIT", "srgb": [r, g, b], "linear": [r, g, b],
      "roughness": 0.1, "gloss": 1.0,                             // gloss: City Lab's reflection weight (0..1)
      "flags": ["glass", "emissive", "water", "foliage", "paint", "signal"],   // any subset
      "emissive": { "mode": "steady|night|windows|blink|flash|signal", "day": 0.15, "night": 2.75,
                    "dayMaterial": 86 }                            // present only for emissive materials
  } ],
  "vehicles": { "paintPlaceholder": 169, "variants": [ { "key": "...", "kind": "sedan", "bb": [...], "count": n,
                "lod1": true } ] },
  "props": { "types": [ { "name": "lamp", "count": n } ] },
  "foliage": { "file": "foliage.bin", "types": [ { "name": "wheat", "sway": 1, "quads": [n0, n1] } ], "instances": n },   // optional (4b)
  "water": { "level": -1.9, "bank": 3.5, "tiles": n, "bridges": [ { "road": id, "kind": "arch|girder", "a": [x, z], "b": [x, z], "width": m } ] },
  "roads": [ { "id": 0, "name": "...", "profile": "avenue", "class": "arterial", "width": 26.2,   // kerb to kerb + sidewalks
               "carriageway": 17.1, "pts": [[x, z], ...] } ],                                    // centreline, 0.1 m
  "landUse": { "file": "landuse.bin", "cell": 8, "legend": ["unknown", "core", ...] },
  "spawns": [ [x, z], ... ],          // street points >= 6 m from any building cell, a few per tile
  "stats": { "bakeSeconds": .., "bytes": .. /* on disk */, "rawBytes": .. /* tile sections decoded */, "tiles": .., "tris0": .., "tris1": .., "tris2": .., "vehicles": .., "props": .. }
}
```

Emissive modes (mirror of City Lab's shader, `uNight` 0 day .. 1 night):

- `steady`: emission = colour * (day + (night - day) * uNight) (street-lamp lens 57, neon 153, LED 154, lit tail 181).
  Vehicles use only steady / flash ids: headlights 57, lit tail lights 181, light bars 189 / 190 / 199; their amber
  indicators (182) and unlit tails (180) are plain colours.
- `windows`: lit windows (87, 89, 148, 149, 159): by day draw `dayMaterial` (unlit glass), at night colour * 1.3.
- `blink`: aircraft beacon (150): steady curve * (0.6 + 0.4 * square wave 0.5 Hz).
- `flash`: vehicle light bars (189, 190, 199): steady curve * (0.25 + 0.75 * square wave 1.6 Hz), 190 half a cycle late.
- `signal`: traffic / pedestrian signal heads (60 red, 61 amber, 62 green, 68 don't-walk, 69 walk): 30 s cycle per
  instance phase; lit = colour * (1.4 + 1.8 uNight), unlit = colour * 0.3. **Only street props use 60-62 / 68 / 69.**

## 7. Engine notes

- Draws (single material reading the palette by vertex material id): per visible tile, the visible chunks' ranges
  (merged when contiguous) through one shared index buffer of the quad pattern + base vertex; LOD2 one draw per tile.
  Vehicles / props instanced, culled per instance (bounding sphere), full / mid (derived at load: quads >= 0.25 m +
  emissive) / box LODs.
- LOD switch (src/city/CityRenderer.h): tile LOD2 when the tile AABB is beyond 420 m; otherwise per chunk, by the
  distance from the eye to the chunk AABB: LOD0 < 210 m, else LOD1; 20 m hysteresis back to the finer LOD. City Lab's RTS rig (pitch 35-70 deg, distance 30-300 m) never sees
  ground closer than ~190 m at LOD1.
- Memory: load tiles in a ring around the camera; a tile is self-contained (no neighbour needed to draw it).
- Determinism: the bake iterates tiles j-major, variants by key, props by type name; floats are written from the
  same doubles, so two bakes of the same inputs are byte-identical (`verify.js --hash` prints a digest).
