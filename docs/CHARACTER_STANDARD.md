# Character standard — modular zombies

**Source of truth:** the approved Zombie Lab design, version 3 (`assets/characters/source/zombie_lab_v3.html`). It is byte-identical to the published Zombie Lab artifact, version `1795598197-2ad0`. Everything in the engine is generated from that file (see [ASSET_PIPELINE.md](ASSET_PIPELINE.md)), so this document describes the standard rather than redefining it.

## Body template

- **Units:** voxels. The character is **18 voxels tall** (a beanie adds a 19th).
- **Orientation:** feet at y = 0, facing +Z. The character's left is +X.
- **Scale in the engine:** `standHeight / 18` metres per voxel, 0.0944 m at the default 1.7 m.
- **Proportions:**
  - legs 8, torso 6, neck 1, head 3 (3×3×3 on a 5-wide, 3-deep torso);
  - arms 1×1 and 8 voxels long, with a one-block hand;
  - legs 2×2, with a one-block foot and a toe.

## Ten segments, joints and hierarchy

| # | Slot | Family | Joint (pivot, voxels) | Parent | Rows |
|---|---|---|---|---|---|
| 0 | head | head | neck (0, 14, 0) | torso | neck y 14..15, head 15..18 |
| 1 | torso | torso | waist (0, 8, 0) | root | y 8..14 |
| 2 | upperArmL | upperArm | shoulder (3, 13.5, 0) | torso | y 10..14 |
| 3 | forearmL | forearm | elbow (3, 10, 0) | upperArmL | y 7..10 + hand 6..7 |
| 4 | upperArmR | upperArm | shoulder (−3, 13.5, 0) | torso | y 10..14 |
| 5 | forearmR | forearm | elbow (−3, 10, 0) | upperArmR | y 7..10 + hand 6..7 |
| 6 | thighL | thigh | hip (1.5, 8, 0) | root | y 4..8 |
| 7 | shinL | shin | knee (1.5, 4, 0) | thighL | y 1..4 + foot 0..1 (toe at z 1..2) |
| 8 | thighR | thigh | hip (−1.5, 8, 0) | root | y 4..8 |
| 9 | shinR | shin | knee (−1.5, 4, 0) | thighR | y 1..4 + foot 0..1 |

Every module of a family is built to these joints, so any module fits any character.

- **Mesh vertices** are stored relative to their segment's joint.
- **Rotations** are Euler XYZ (three.js order) about the joint.
- **Left and right limbs** are separate meshes: the Lab builds them with a side sign. They are never mirrored at run time.

## Module library (37 modules)

The decay level is the decomposition level: 0 = intact, 1 = damaged, 2 = decomposed.

| Family | Modules, as `id` (decay level) |
|---|---|
| head (8) | bald (0), short_hair (0), long_hair (0), beanie (0), scalp_wound (1), one_eye (1), jawless (2), skull (2) |
| torso (7) | tshirt (0), shirt_tie (0), hoodie (0), jacket (0), tank (1), ribcage (2), gutted (2) |
| upperArm (5) | sleeve (0), bare (0), torn_sleeve (1), meat (1), bone (2) |
| forearm (6) | sleeve (0), bare (0), bloody (1), meat (1), bone (2), **missing** (2, no geometry) |
| thigh (5) | pants (0), shorts (0), torn (1), meat (1), bone (2) |
| shin (6) | pants (0), skin (0), barefoot (1), torn (1), meat (1), bone (2) |

Rules that come from the Lab:

- **Stump:** when a forearm is missing, the upper arm's lowest voxel becomes a `gore` stump. This is baked as a second upper-arm variant.
- **Sleeves:** `sleeve` / `sleeveDark` resolve to the torso's garment. A t-shirt, hoodie, jacket or gutted torso gives cloth sleeves, shirt-and-tie gives shirt sleeves, and a tank top or ribcage gives bare skin.

## Materials (26 tags)

| Group | Tags | Source |
|---|---|---|
| Palette | `skin`, `cloth` (top), `top2` (shirt), `pants`, `hair`, `tie`, `hat`, `shoe` | The character's palette, drawn from the Lab lists: 8 skins, 9 tops, 4 shirts, 6 trousers, 6 hairs, 3 ties, 5 hats, 3 shoes |
| Derived | `skinDark` ×0.74, `clothDark` ×0.7, `top2Dark` ×0.75, `pantsDark` ×0.72, `pantsLight` ×1.22, `hatDark` ×0.72 | Multiplied from the palette in sRGB, exactly as in the Lab |
| Fixed | `blood`, `bloodDark`, `gore`, `bone`, `boneDark`, `meat`, `meatDark`, `mouth`, `belt` | Constant colours |
| Emissive | `eye` | Glowing eyes (Lab: linear (0.55, 2.2, 0.45), unlit) |

## Decoration (Lab "detail tier" and "decomposition")

Detail tier changes both colour and geometry:

- **Low:** flat colours.
- **Medium:** per-voxel tonal noise (±7 %), blood speckles and drips.
- **High:** noise ±13 %, mottled skin, longer drips, ragged clothing edges. Ragged edges *remove* voxels.

The decoration code is the Lab's `decorate()` itself. It runs per segment, with the Lab's seed formula.

- **Baked variants:** 33 per segment module: Low, plus Medium and High × 4 decomposition levels {0.25, 0.55, 0.75, 0.9} × 4 seeds {101, 202, 303, 404}.
- **Continuous decomposition:** the Lab's 0–1 value is quantised to those 4 levels. The Street Walker (0.55) and Rotter (0.9) values are exact.
- **Seeds:** the Lab draws one random seed per character; the engine picks one of the 4 baked seeds from a hash of the character's look. That one seed drives both the decoration geometry and the per-voxel noise, as in the Lab.
- **Colour noise and materials:** neither is baked into the merged geometry. The fragment shader finds the voxel behind each fragment, reads its material from the mesh's voxel grid, and recomputes the Lab's `hash3` noise for it (same integer hash, same seed). Merged faces therefore keep exact per-voxel colour.

## Appearance encoding (56 bits per zombie)

The appearance is stored in the agent record itself, so it is sorted with the agent and copied into its corpse. Generated once at spawn; never changes.

```
info.x bits  8..10 head    11..13 torso    14..16 upperArmL  17..19 upperArmR  20..22 forearmL  23..25 forearmR
             26..28 thighL 29..31 thighR                                 (bits 0..7: simulation state)
info.y bits  0..2 shinL   3..5 shinR   6..7 detail tier   8..9 decomposition level
             10..12 skin  13..16 top  17..18 shirt  19..21 trousers  22..24 hair  25..26 tie  27..29 hat  30..31 shoe
```

## Appearance generation (configurable, visual only)

`SimParams` (UI sliders and `config/sim.cfg`) sets relative weights for six categories:

| Category | Default | Modules | Detail / decomposition |
|---|---|---|---|
| recently infected | 0.20 | intact only | mostly Low |
| fully clothed | 0.30 | sleeves + trousers, no tank top | Low/Medium, light |
| lightly damaged | 0.25 | 65 % intact / 35 % damaged per slot | Medium/High, medium |
| heavily damaged | 0.13 | 25 / 45 / 30 % intact / damaged / decomposed | mostly High, heavy |
| skeletal | 0.05 | limbs 8 / 17 / 75 % | High, 0.9 |
| missing limb | 0.07 | as heavily damaged + one forearm missing (20 %: both) | as heavily damaged |

On top of the category, the Lab's own rules apply: 55 % of limb pairs copy the left side, garments stay consistent, and sleeveless torsos give bare arms.

The self-test (5,000 zombies) found:

- 30 % fully clothed;
- 6.5 % with a missing forearm;
- 24 % with at least one decomposed part;
- 4,998 of 4,998 distinct.

## Animation states

| State | Source |
|---|---|
| idle, walk, reach | Zombie Lab curves (exact formulas). Walk uses the simulation's gait phase; the three are blended by speed and crowd pressure. |
| climb / crawl | Engine extension: body prone, alternating overhead reach, kicking legs. |
| flail | Thrown or falling bodies; limbs swing wildly. |
| dying | Flail plus a tumbling roll. |
| corpse | 64 static poses baked at start-up by the same code: face down or face up, splayed limbs. |

Missing segments have no geometry, so they stay missing in every state. Joint continuity is regression-tested in every state: maximum gap 0.43 mm, which comes from storing rotations in 16-bit floats.
