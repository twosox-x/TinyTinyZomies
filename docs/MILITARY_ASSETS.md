# Military assets — models (Phase 7 Stage A)

**Status:** models for owner review (see [ASSET_APPROVALS.md](ASSET_APPROVALS.md)). No animation set yet; the rig is
designed so it can be animated (same 10 joints as the zombies, weapon grip / support points, two reference poses).

**Source of truth:** `tools/military_lab/military_lab_v1.html` (Military Lab). As with the Zombie Lab, the converter
does not re-type the design: it cuts the renderer-free library out of the HTML (between the markers
`/* === MILITARY LIBRARY BEGIN === */` and `/* === MILITARY LIBRARY END === */`), runs it in a Node `vm` sandbox,
meshes it and writes the engine assets.

```
tools/military_lab/military_lab_v1.html          design + preview lab (Three.js r128, never shipped)
        │  node tools/convert_military.mjs          deterministic, byte-identical output
        ├─ assets/military/infantry.ttzm           binary: palette + packed vertices (soldiers)
        ├─ assets/military/infantry.json           manifest: models, parts, pivots, grip points, poses, offsets
        ├─ assets/military/props.ttzm              binary: palette + packed vertices (props)
        └─ assets/military/props.json              manifest: models, parts, pivots, footprints, sockets, offsets
```

## Why a new file (`.ttzm`) and not `zombie_parts.ttzc`

`CharacterRenderer` cannot draw soldiers as-is: its 10 slot tables, module counts and 26 material tags are
compiled into the shaders (`shaders/include/zombie_parts.glsl`), materials are zombie palettes selected by the
56-bit look, and the per-mesh material grid is limited to 15 cells per axis at body-voxel resolution. Weapons and
gear are authored on a finer grid (half a body voxel), and an attachment is not a body slot. So the military
assets use one small, generic format for both soldiers and props. The **vertex packing keeps the TTZC idea**
(exact integer half-cell positions, axis normal, Lab AO level, material) but widens the fields.

## Units and axes (all models)

- **Y up, front = +Z, model's left = +X** (exactly the zombie convention). Feet / prop base at y = 0.
- **Body voxel** `V = 1.7 / 18 = 0.094444 m`. Soldiers are **18 V tall** with the zombie body standard
  (docs/CHARACTER_STANDARD.md): same 10 segments, joints, parents, proportions, Euler XYZ rotations about joints,
  left/right limbs built separately.
- **Fine voxel** `V/2 = 0.047222 m`: helmets, vests, pouches, packs, weapons, kneepads. The fine grid is aligned to
  the body-voxel faces, so gear sits flush on the body without coplanar faces (faces between a segment and its own
  rigid gear are culled by the converter).
- **Prop voxel** `0.05 m` (city prop scale, `PV` in city_core.js). Exception: the infantry parachute canopy uses
  `0.10 m` (it is 7 m wide; 5 cm would cost ~4x the triangles for no visible gain at RTS distance).
- In the manifests every position (pivot, socket, grip, footprint) is in **metres**, model space.

## Binary file `.ttzm` (little endian)

| Offset | Content |
|---|---|
| 0 | header, 8 × u32: magic `0x4D5A5454` ('TTZM'), version `1`, paletteCount, vertexCount, reserved × 4 (0) |
| 32 | palette: paletteCount × 2 u32: `rgba8` sRGB colour (r in bits 0..7), `flags` (bit0 emissive, bit1 metal, bit2 glass, bit3 cloth/no-noise-off; bits 8..15 noise amplitude in 1/255) |
| 32 + 8·paletteCount | vertices: vertexCount × 2 u32 (non-indexed triangle list, 6 vertices per quad, CCW seen from outside) |

**Vertex** (2 × u32):

```
word0  bits  0..9   x  in HALF grid cells of the part, relative to the part pivot, +512 bias
       bits 10..19  y
       bits 20..29  z
word1  bits  0..2   face direction (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z)
       bits  3..4   ambient occlusion level (0..3 -> 0.5, 0.67, 0.84, 1.0, the Zombie Lab values)
       bits  5..12  palette index
       bits 13..31  0
position_metres_in_part_space = (q - 512) * 0.5 * part.unit
```

Quads use the Zombie Lab diagonal rule for AO (already applied: just draw the triangles). Faces are greedy-merged
where palette index and AO are uniform; the converter verifies the merge is lossless against the culled faces.
Optional tonal noise (as in the Lab): `colour *= 1 + (hash3(voxelCentre) - 0.5) * 2 * noise` with the palette's
noise amplitude; flat colour is also correct.

## Manifest (`.json`)

```jsonc
{
  "format": "TTZM", "version": 1, "source": "tools/military_lab/military_lab_v1.html",
  "palette": [ { "name": "olive", "rgb": "#5b5f3a", "flags": 0, "noise": 0.06 }, ... ],   // same order as the binary
  "models": [ {
      "name": "rifleman_a", "class": "rifleman", "label": "Rifleman A",
      "bounds": { "min": [x,y,z], "max": [x,y,z] },              // metres, rest pose
      "parts": [ {
          "name": "torso", "parent": -1,                         // index into this model's parts, -1 = model root
          "slot": "torso",                                       // body slot (soldiers) or null
          "pivot": [0, 0.7556, 0],                               // joint position, metres, model space (rest pose)
          "unit": 0.094444,                                      // metres per grid cell of this mesh
          "first": 1234, "count": 456,                           // vertex range in the binary
          "rigid": true                                          // false = may be re-mounted (weapon)
      }, ... ],
      "sockets": [ { "name": "...", "part": 1, "pos": [x,y,z], "dir": [x,y,z] } ],   // metres, model space
      ...class-specific fields (below)
  } ]
}
```

**Part transform at run time:** `world = model * T(pivot_part - pivot_parent) * R_part(euler XYZ) * local`,
with `pivot_parent = 0` for root parts; `local` is the vertex position from the formula above. Rest pose = all
rotations zero (zombie Lab convention). Root parts are `torso`, `thighL`, `thighR` (zombie hierarchy) and every
prop part without a parent.

## Infantry (`infantry.json`)

### Models (11)

| Model | Class | Variant notes |
|---|---|---|
| `rifleman_a` … `rifleman_e` | rifleman | skin tone, helmet cover (multicam / ranger green / coyote / netted), goggles on helmet, scarf, rolled sleeves, gloves, pouch layout, kneepads, assault pack |
| `mg_a` … `mg_c` | machine_gunner | belt-fed MG (long, bipod, box), bulky armour with ammo belts across the chest, big pack with ammo can |
| `sniper_a`, `sniper_b` | sniper | suppressed scoped rifle, boonie hat or helmet with ghillie strips, light kit, rangefinder / binoculars |

### Parts

Ten body parts in the zombie slot order and hierarchy (`head, torso, upperArmL, forearmL, upperArmR, forearmR,
thighL, shinL, thighR, shinR`, unit `V`, pivots = zombie joints × V), then attachments (unit `V/2`):

| Part | Parent | Rigid with parent | Content |
|---|---|---|---|
| `gear_head` | head | yes | helmet / boonie, cover, NVG mount, goggles, ghillie strips, scarf |
| `gear_torso` | torso | yes | plate carrier, pouches, radio, chest belts (MG), backpack / assault pack / ammo can |
| `gear_thighL`, `gear_thighR` | thigh | yes | dump pouch, holster, leg pocket |
| `gear_shinL`, `gear_shinR` | shin | yes | kneepads |
| `gear_forearmL` | forearmL | yes | watch / rangefinder pouch |
| `weapon` | forearmR | **no** (`rigid: false`) | rifle / MG / sniper rifle |

A gear part's pivot equals its parent's joint. Parts that a variant does not use are omitted (not empty).

### Weapon rig

The `weapon` mesh is authored in **weapon space**: origin = **grip point** (centre of the pistol-grip cell), barrel
along **+Z**, up **+Y**. Its `pivot` in the manifest is the grip point in rest pose = the centre of the right hand
(`(-3, 6.5, 0) V`). The model entry carries:

```jsonc
"weapon": {
  "kind": "rifle" | "mg" | "sniper",
  "grip": [0,0,0],                       // weapon space (always the origin)
  "support": [x,y,z],                    // weapon space, metres: where the LEFT hand goes (handguard / MG handle)
  "muzzle": [x,y,z],                     // weapon space, metres: muzzle-flash / tracer origin, +Z direction
  "sling":  [x,y,z],                     // weapon space, metres: sling point (for a slung / back carry pose later)
  "length": 0.85                         // metres
}
```

Mounting: the weapon is a child of `forearmR`. Its transform relative to the forearm joint is
`T(hand - elbow) * R_mount`, with `hand - elbow = (0, -3.5, 0) V`. **R_mount is a pose value**, not a constant:
each pose gives `weaponMount` (Euler XYZ). The left hand reaches the support point by pose values for `upperArmL`
and `forearmL` (solved by a small 2-bone IK in the Lab; the residual error is stored as `supportError` metres).

### Reference poses (`"poses"` per model)

```jsonc
"poses": {
  "rest":  { "rot": { "<slot>": [rx,ry,rz], ... }, "weaponMount": [rx,ry,rz], "supportError": 0.0 },
  "carry": { ... }      // class carry posture: rifle low-ready, MG hip/sling carry with support hand on the handle,
}                        // sniper low-ready; left hand on the support point
```

Rotations are radians, Euler XYZ about the joints, missing slots = 0. These are the starting poses for the animation
step (idle / walk / aim / fire / reload come after model approval).

### Infantry sockets

`parachute` (torso, top of the plate carrier between the shoulders: where the parachute harness pivot attaches),
`muzzle` (weapon), `eyes` (head, for aim/LOS), `back` (torso, slung weapon / pack).

## Props (`props.json`)

All props: pivot = base centre at ground (y = 0) unless noted, `footprint` = `[sizeX, sizeZ]` metres axis-aligned in
model space, plus `height`. Nothing floats (every part touches the ground or its parent), no coplanar overlaps
between parts (checked by the converter).

| Model | Parts | Size (m, X × Y × Z) | Sockets / notes |
|---|---|---|---|
| `para_infantry` | `canopy` (0.10 m), `lines` | ~7.0 dia × 8.8 h | pivot = **harness point** (connects to the soldier's `parachute` socket); `harness` socket at the origin |
| `para_cargo` | `canopy`, `lines` | ~3.0 dia × 4.2 h | pivot = load point; attaches to `crate_ammo_drop`'s `parachute` socket |
| `crate_ammo` | `body` | 1.0 × 0.55 × 0.6 | small ammo supply crate, wood + olive, stencils, rope handles |
| `crate_ammo_drop` | `body` | 1.1 × 0.75 × 0.7 | the crate on an airdrop skid with straps; `parachute` socket on top |
| `container_supply` | `body`, `doorL`, `doorR`, `apron` | 6.06 × 2.59 × 2.44 (+ apron 1 m) | 20 ft ISO container, doors on +Z with hinge pivots (open by rotating Y), ammo racks inside, markings, sandbag apron; socket `door` |
| `wall_<v>_straight` | `body` | 4.0 long (X) | `endA` (-2,0,0) dir -X, `endB` (+2,0,0) dir +X |
| `wall_<v>_corner` | `body` | post, wall width square | `a` (-X), `b` (+Z) |
| `wall_<v>_t` | `body` | post | `a` (-X), `b` (+X), `c` (+Z) |
| `wall_<v>_x` | `body` | post | `a`, `b`, `c`, `d` (all four sides) |
| `wall_<v>_end` | `body` | end cap | `a` (-X) |
| `wall_<v>_gate` | `frame`, `leafL`, `leafR` | 4.0 long | swing gate, leaves rotate about Y at their hinge pivots; `endA`, `endB` like the straight |
| `fort_window_nest` | `body` | 1.8 × 0.9 × 0.7 | sandbag nest for inside a window; back = -Z (room side), window = +Z |
| `fort_steel_plate` | `body` | 1.3 × 2.0 × 0.12 | steel plate with firing slit, bolted on a facade |
| `fort_roof_ring` | `body` | 3.6 dia × 0.9 | rooftop sandbag ring |
| `fort_slit_wall` | `body` | 2.0 × 1.3 × 0.5 | sandbag wall with a firing slit (plates) |
| `barricade_window_planks` / `_plate` / `_sandbags` | `body` | fits 1.0 × 1.5–2.0 m city windows | origin = bottom centre of the window opening on the facade plane, +Z = outward |
| `barricade_door_planks` / `_plate` / `_sandbags` | `body` | fits 1.0–1.5 × 2.25–2.5 m city doors | origin = bottom centre of the door opening on the facade plane, +Z = outward |
| `garrison_flag` | `pole`, `flag` | 6 m pole | generic olive flag with a white chevron (fictional unit flag); `flag` pivot = top of hoist (for waving) |
| `garrison_banner` | `body` | 1.0 × 2.2 | hangs from a roof edge; origin = top centre on the facade plane |
| `garrison_roof_position` | `body` | 2.6 × 0.9 × 1.8 | U-shaped rooftop sandbag position with ammo cans |
| `garrison_ammo_stack` | `body` | 1.2 × 0.7 × 0.8 | stacked ammo cans and boxes |
| `garrison_antenna` | `body` | 0.6 × 5.0 × 0.6 | radio box + whip antenna with guy lines |
| `hospital_flag` | `pole`, `flag` | 6 m pole | white flag with a **green cross** (generic medical symbol, not the protected Red Cross emblem) |
| `hospital_banner` | `body` | 1.0 × 2.2 | white banner, green cross |
| `hospital_stretcher` | `body` | 2.1 × 0.2 × 0.55 | |
| `hospital_cot` | `body` | 1.9 × 0.45 × 0.7 | |
| `hospital_crate` | `body` | 0.8 × 0.5 × 0.5 | olive medical crate, white panel with a green cross |
| `hospital_awning` | `body` | 4.0 × 2.6 × 3.0 | tarp awning on poles with guy lines |

`<v>` is `cheap` (single HESCO-style gabion row, 1.0 m wide × 1.6 m tall, sand fill and wire mesh) or `reinforced`
(1.2 m wide × 2.4 m tall, gabion with a sandbag top course and bolted steel plates on the outer face). Wall
pieces meet butt-to-butt at the sockets; joint pieces are slightly taller posts so arbitrary-angle joints hide the seam.

City reference sizes used: building voxel 0.25 m, storey 14 voxels (3.5 m), punched windows 4 × 6–8 voxels
(1.0 × 1.5–2.0 m), doors 4 × 9–10 voxels (1.0 × 2.25–2.5 m) — `tools/city_lab/city_arch.js`.

## Palette

One palette per file (indices < 256). Military materials: `olive`, `oliveDark`, `coyote`, `coyoteDark`,
`rangerGreen`, `rangerDark`, `mcTan`, `mcGreen`, `mcBrown` (multicam-ish blocks), `black`, `blackSoft`, `gunBlack`,
`gunMetal`, `metal`, `brass`, `webbing`, `tan`, skin tones `skin0..skin5`, `skinDark0..skinDark5`, `eyeDark`,
`lens` (glass), sand, wood, rope, canvas, concrete/steel, flag/medical colours. Exact values are in the manifest.

## Regenerating

```bash
node tools/convert_military.mjs
```

Prints model / part / triangle counts; fails loudly if the Lab's markers are missing, a vertex is out of range,
a merged mesh differs from the culled one, or a part floats.

Review screenshots (Playwright, page served from disk):

```bash
NODE_PATH=$(npm root -g) node tools/military_lab/shots.mjs <outDir> [name-filter]
```

## Budgets (v1, greedy)

Soldiers 1.9–2.9 k triangles each (zombie: ~0.2–0.5 k). Props: most 0.2–3 k; heavy ones are the
infantry parachute (~60 k, the stepped dome keeps per-voxel AO), cargo parachute (~31 k), supply container
(~62 k, corrugation + interior racks), rooftop ring (~13 k). These need an LOD / flat-AO canopy before
dozens are on screen.

## Specialists (Phase 7b): engineers, flamethrower, tools — pending review

**Status:** models for owner review (see [ASSET_APPROVALS.md](ASSET_APPROVALS.md)). Same source of truth (the Military Lab
library, block `SPECIALISTS`), same converter, same `.ttzm` format, but **separate files**, so the approved v1 files are
untouched (the converter writes `infantry.*` / `props.*` / `anims.*` with the v1 palette only, `PAL_V1_COUNT` entries;
their md5 is unchanged):

```
assets/military/specialists.ttzm / .json        engineers, flamethrowers, hand tools, site props (full palette: v1 + 7b entries)
assets/military/specialist_anims.bin / .json    their clips (docs/MILITARY_ANIMS.md §7)
```

The file mixes soldiers and props: an entry with `weapon` / `poses` is a soldier (infantry layout above), the others
are props / tools (`footprint`, `height`, `anchor`). Converter checks are the same (lossless greedy, lattice, no
floating parts, no coplanar overlaps); tools are checked as one connected piece (`anchor: "self"`, sub-grid V/4).

### Models (12)

| Model | Class | Notes |
|---|---|---|
| `engineer_a` | engineer | multicam / coyote; sledgehammer strapped to the ruck (head at the left hip, handle up behind the shoulder); ear defenders |
| `engineer_b` | engineer | ranger green, rolled sleeves; folding shovel on the ruck (handle above the right shoulder); welding goggles on the helmet |
| `engineer_c` | engineer | olive, beard; oxy (black) / acetylene (red) bottles on the ruck sides for the cutting torch; welding goggles |
| `flamer_a` | flamer | aluminised fire-proximity hood with gold visor and shoulder cape (reads silver-white at any distance) |
| `flamer_b` | flamer | coyote helmet over a nomex hood, black respirator mask with filter |
| `tool_sledgehammer`, `tool_shovel`, `tool_torch`, `tool_crowbar`, `tool_sandbag`, `tool_panel` | tool | engineer hand-held items (below) |
| `sandbag_pile` | site | 0.9 × 0.45 × 0.35 m construction-site pile (5 cm props voxels), `grab` socket |

**Engineer identity (RTS distance):** reflective hi-vis orange band round the helmet + orange stripe over the helmet
top, orange shoulder panels on the vest, hi-vis + reflective band across the back of a big frame ruck, empty-sandbag
roll on top of the ruck, tool belt (leather hammer loop, pouches). Weapon: compact carbine (`kind: "carbine"`, 0.85 m,
collapsed stock, red-dot; muzzle `(0, 1.0, 6.25) V`, support `(0, -0.1, 3.5) V`).

**Flamethrower identity:** two olive fuel cylinders (round section, red hazard band, yellow stencil, valves) on a
frame + a metal pressure bottle between / behind them, rising to head height; hood / mask instead of a plain
helmet. Weapon: flame gun (`kind: "flamer"`, ~1 m): rear trigger grip + valve wheel, forward vertical grip (support),
shrouded fuel tube, nozzle, igniter housing with an **emissive pilot-light voxel** (palette `pilotFlame`, flag 1).

Extra manifest fields:

- flamer: `hose` = `{ from: {part: "torso", pos}, to: {part: "weapon", pos}, length: 1.25, voxel: 0.045, color, sag }`
  (metres; `from` is in body space of the rest pose like sockets, `to` is weapon space). The hose is **procedural**:
  the engine draws a sagging chain of 4.5 cm voxels between the two points (it cannot be a rigid part). Also
  `weaponPoints` `{ pilot, nozzle }` (weapon space) and sockets `hose_tank` (torso), `pilot` (weapon).
- engineer: `tools` = the tool model names.
- tool: `toolId` (1 sledgehammer, 2 shovel, 3 torch, 4 crowbar, 5 sandbag, 6 panel), sockets `grip` (origin),
  `support` (default left-hand point), `tip` (FX point: hammer face, blade, torch flame, claw).

### Hand tools (tool space)

Tools use **weapon space** (0.5 V cells, origin = the right-hand grip, long axis +Z, up +Y, vertices relative to the
grip, `pivot` 0). They mount exactly like the weapon: child of `forearmR`, `T(hand - elbow) · R(mount)`, with the
clip's mount channels (MILITARY_ANIMS.md §7). Sizes: sledgehammer 0.95 m (head 0.28 m), shovel 1.0 m (D-handle at the
grip), cutting torch 0.45 m, pry bar 0.7 m (red), sandbag 0.47 × 0.14 × 0.33 m (grip at its right end, the bag extends
to +X; support 5 V along +X), gabion panel (folded HESCO section) 1.0 × 0.85 × 0.09 m (grip at the bottom edge,
panel up +Y; carried vertically at the right side like a sheet of plywood).

Budgets: engineers 2.5–2.7 k triangles, flamethrowers 3.1–3.4 k, tools 46–460, pile 0.4 k.

Review shots: `NODE_PATH=$(npm root -g) node tools/military_lab/spec_shots.mjs <outDir>` (Lab mode `7b` lineup, RTS
mode with the specialists, `Eng+Flame` / `Eng` / `Flame` in Anim mode, scene `RTS 7b`).
