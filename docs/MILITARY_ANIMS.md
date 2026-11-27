# Military animations — clip format (Phase 7 Stage A, step 2)

**Status:** format frozen (v1). Clips for owner review. Source of truth: the animation section of
`tools/military_lab/military_lab_v1.html` (inside the `MILITARY LIBRARY BEGIN/END` markers, renderer-free:
`buildAnims()`), exported by `node tools/convert_military.mjs` to:

```
assets/military/anims.json   manifest: clips, tracks, events, transitions, FX spec, speeds
assets/military/anims.bin    float data (little endian), all tracks of all clips
```

The models (`infantry.*`, `props.*`, docs/MILITARY_ASSETS.md) are unchanged by this step. Units: metres, radians,
seconds. Axes: the model convention (Y up, front +Z, model's left +X, feet at y = 0).

## 1. Clips, classes, sampling

- Clips are **per class**: `rifleman`, `mg`, `sniper` (weapon geometry differs, so the support-hand IK and weapon
  placement differ). Every variant of a class (`rifleman_a..e`, ...) plays its class's clips (same skeleton).
  Clip names are `<class>/<action>`, e.g. `rifleman/walk`. Prop sequences use class `crate`.
- **Sampling: 30 Hz, dense** (every frame is a key). `frames = round(duration * 30) + 1` for one-shot clips
  (first and last sample included); looping clips store `round(duration * 30)` frames and wrap (frame `frames`
  == frame 0). Evaluate with **linear interpolation** between the two neighbouring frames (Euler channels are
  continuous, never wrapped by 2π inside a clip, so lerp is safe within a clip). For cross-clip blending, see §4.
- Rotations are already IK-solved at bake time (right hand on the grip, left hand on the support point, feet
  planted). The engine does **not** need to run IK to play a single clip; IK targets are stored for re-solving
  after blends (§4).

## 2. Tracks (in `anims.bin`, f32)

Each clip has one or more tracks: `{ "type": "body" | "canopy" | "crate" | "weapon", "offset": <float index into the bin>,
"stride": <floats per frame>, "frames": n }`. Frame `f` of a track starts at float `offset + f * stride`.

### 2.1 `body` track, stride 44

| Floats | Channel | Meaning |
|---|---|---|
| 0..29 | `rot[10][3]` | Euler XYZ (three.js order, R = Rx·Ry·Rz) per body slot, zombie slot order `head, torso, upperArmL, forearmL, upperArmR, forearmR, thighL, shinL, thighR, shinR`; about the joints, relative to the parent (exactly docs/MILITARY_ASSETS.md "part transform") |
| 30..32 | `rootPos` | metres, clip space. Translation of the whole body |
| 33..35 | `rootRot` | Euler XYZ, whole-body rotation about the **feet origin** (0,0,0) of the model, applied before `rootPos` |
| 36..38 | `weaponMount` | Euler XYZ of the weapon in `forearmR` space (the pose value `R_mount` of MILITARY_ASSETS.md) |
| 39 | `supportW` | 0..1 weight of the left-hand constraint (1 = left hand on `supportTarget`) |
| 40..42 | `supportTarget` | weapon space, metres: where the left hand is (usually the weapon's `support` point; the bolt handle during a sniper bolt cycle; MG feed cover during a belt swap) |
| 43 | `flags` | integer stored as float: bits 0..3 `handItem` (0 none, 1 rifle magazine, 2 MG ammo box, 3 sniper magazine, 4 ammo can, 5 belt end), bit 4 left foot planted, bit 5 right foot planted, bit 6 weapon slung (drawn at the `sling` mount, §2.1.1), bit 7 weapon dropped (drawn from the clip's `weapon` track, §2.5) |

Model-space transform of a part (body slot or attachment), with `M_root = T(rootPos) · R(rootRot)`:
```
world = agent · M_root · T(pivot_part - pivot_parent) · R_part · local        (MILITARY_ASSETS.md, unchanged)
weapon: parent forearmR, T(hand - elbow) · R(weaponMount)
```
`handItem` is drawn at the left hand centre `(3, 6.5, 0) V` in `forearmL` space, oriented with the forearm
(box sizes in §6).

### 2.1.1 Slung weapon (flag bit 6)

During `para_descent`, `para_land` and the first part of `para_recover` the weapon is strapped across the chest
(jump carry) so both hands can hold the risers. Then it is drawn in **`torso` space** instead of the forearm:
`weapon = torso · T(slungMount.gripFromTorsoPivot) · R(slungMount.rot)` (anims.json `slungMount[class]`, metres /
Euler XYZ; the grip point is the weapon origin). The `weapon_draw` event in `para_recover` is where the weapon goes
back to the right hand (bit 6 clears on that frame).

### 2.1.2 Postures (why the clips do not use the manifest `carry` pose)

The approved reference pose `carry` in infantry.json leaves the support hand 15–27 cm off the handguard (the
miniature's 7 V arms cannot reach the support point with the weapon that far forward). The clips use postures fitted
in the library (`initPostures`, deterministic coordinate descent) so both hands are exactly on the weapon:
low-ready across the body for idle / walk, a **bladed shouldered aim** (whole body turned −0.45 rad, torso a further
~−0.5 rad, weapon along the agent heading) for rifle / sniper, and **hip fire leaning into the gun** for the MG.
Measured residual support error in every clip ≤ 2 cm (walk) and 0 in aim / fire / reload (`check.supportError`).

### 2.2 Clip space and root motion

Clip space = the agent frame at the clip start (origin on the ground under the agent, heading +Z).
- **In-place locomotion** (`idle`, `walk`, `run`, `aim`, `fire`, ...): `rootPos.xz` stays near 0 (bob and sway
  only). The clip field `speed` (m/s) is the speed the agent must move along its heading while it plays; the
  planted foot moves backwards in clip space at exactly `speed`, so `agent velocity == speed` gives zero foot
  sliding. At other speeds, scale playback rate: `rate = v / speed` (walk valid 0.6..1.9 m/s, run 2.6..4.6).
- **Root-motion clips** (`rootMotion: true`: turns, enter/exit building, stairs, deaths, landing, recovery):
  `rootPos`/`rootRot.y` carry the displacement. The clip field `delta = [dx, dy, dz, dyaw]` is the total
  displacement first→last frame. Engine: draw with the sampled root; when the clip ends (or loops), add `delta`
  to the agent transform and continue from zero. Looping root-motion clips (`stairs_up`, `stairs_down`) add
  `delta` per cycle.

### 2.3 `canopy` track, stride 12 (parachute sequences)

Applies to the `para_infantry` (soldier) or `para_cargo` (crate) prop of `props.json`, whose pivot is the harness
/ load point and whose canopy and lines parts are in that pivot's space.

| Floats | Channel |
|---|---|
| 0..2 | `pos`: canopy pivot (harness end of the risers), clip space, metres |
| 3..5 | `rot`: Euler XYZ of the canopy (pendulum sway, topple during the collapse) |
| 6 | `radial`: xz scale about the pivot axis (breathing, deflation) |
| 7 | `height`: y scale about the pivot (1 = lines taut; < 1 the canopy sinks onto the lines' slack) |
| 8 | `clamp`: 1 = soft ground clamp on (§2.3.1), 0 = off (in the air) |
| 9 | `visible`: 0/1 |
| 10, 11 | `shear` x, z: the canopy is carried sideways in proportion to its height above the pivot (collapse drift downwind); 0 in the air |

Vertex deformation (same for the canopy part and the lines part, so the lines always meet the canopy hem and the
riser point: every step is affine about the pivot until the clamp):
```
p  = vertex in prop space (pivot at origin)
p1 = (p.x * radial + shear.x * p.y,  p.y * height,  p.z * radial + shear.z * p.y)
p2 = pos + R(rot) * p1                                   // clip space
if clamp: p2.y = g + s * ln(1 + exp((p2.y - g) / s)),  s = 0.08 m
          g = surface height under (p2.x, p2.z)  (ground, or a roof top; clip space)
```
Collapse = `height` → ~0.1 (the dome settles onto the slack lines) + `shear` (it is carried 5–7 m downwind, lines
stretched from the harness), then the clamp lays it flat on the surface. The soft clamp is monotonic, so stacked canopy layers never swap order or z-fight; vertices far above the surface
are unchanged. On a rooftop, `g` is the roof height inside the roof footprint and the street height outside, so a
canopy that topples over an edge drapes down the facade.

### 2.3.1 Parachute sequence (soldier)

| Clip | Loop | What the engine does |
|---|---|---|
| `<cls>/para_descent` | yes, 4.8 s | soldier hangs in the harness (legs together, hands on the risers, weapon hanging along the right side), pendulum sway ±6°, canopy breathing. Clip space origin = the feet at rest. The agent descends at `descentSpeed` **5.0 m/s** (field on the clip). |
| `<cls>/para_land` | no | starts at touchdown (feet at y = 0 of clip space = the landing surface): PLF (feet together, knees flex, roll onto the side / back). Canopy keeps sinking, deflates and is carried downwind (clip space −Z / +X: behind-left of the soldier), clamped flat onto the surface. |
| `<cls>/para_recover` | no | sit up, kneel, release the harness (event `harness_release`: from here the canopy track no longer follows the soldier, it stays where it lies), stand up, ready the weapon; ends in the class `idle` pose (blend 0.2 s into idle / walk). |

Switching: play `para_descent` until `feetHeight <= surface`, then cut to `para_land` frame 0 with a 0.1 s blend
(the descent pose and the land frame 0 are designed to match). After landing the canopy (and its lines) stays where
it lies, then dissolves and is removed (§2.3.3).

### 2.3.2 Crate sequence (`crate/descent`, `crate/land`)

`crate` track (stride 6): `pos` (base centre of `crate_ammo_drop`, clip space) + `rot` (Euler XYZ). Canopy track
as above, pivot at the crate's `parachute` socket while attached. `crate/descent` loops (3.2 s), `descentSpeed`
**6.0 m/s**; `crate/land` (3.5 s): impact, small bounce (0.12 m), settle with a slight tilt, canopy collapses and
drapes beside / over the crate. The crate stays (it is the supply); the canopy and lines dissolve (§2.3.3).

### 2.3.3 Canopy removal after landing (voxel dissolve)

Not part of the clip data; timing is driven by the `canopy_ground` event (soldier: `para_land` t = 1.4 s; crate:
`crate/land` t = 2.2 s). Applies to the whole parachute prop (`para_infantry` / `para_cargo`: canopy **and** lines);
the soldier and the crate are never dissolved.

| Phase | Time after `canopy_ground` | What happens |
|---|---|---|
| hold | 0 – 2.5 s | canopy lies as the clip left it (soldier: frozen at `harness_release`) |
| dissolve | 2.5 – 5.0 s | `d = (t − 2.5) / 2.5` grows 0 → 1: every voxel has a random threshold in [0, 1) (hash of its integer voxel coordinate in the undeformed prop), it is discarded once `d` passes it; the prop also sinks `0.06 · d` m |
| removed | ≥ 5.0 s | prop no longer drawn (and no longer casts a shadow) |

Engine (src/lab/MilitaryLab, `kCanopyHold` / `kCanopyDissolve`): the canopy instance is kind 2 with
`pos.w = 2 + 0.9 · d`; `shaders/city.vert` derives the voxel id from the quantised vertex position (half-cell units,
stepped half a cell inwards along the face normal, so a greedy quad covers the right voxels), `shaders/city.frag` and
the lab's shadow pipeline `shaders/city_shadow.frag` share `include/dissolve.glsl`, so the shadow dissolves with the
surface. The HTML lab mirrors it (`dissolveMat`: same hash, the `customDepthMaterial` discards too).

### 2.5 `weapon` track, stride 7 (death clips: dropped weapon)

| Floats | Channel |
|---|---|
| 0..2 | `pos`: weapon grip origin, clip space, metres |
| 3..5 | `rot`: Euler XYZ of the weapon in clip space (continuous, lerp-safe) |
| 6 | `attached`: 1 while still in the hand (the values then equal the hand placement), 0 after the drop |

From the `weapon_drop` frame on, body flag **bit 7** is set and the weapon is drawn from this track
(`world = agent · T(pos) · R(rot)`) instead of the right hand; before it, as usual (`weaponMount`). Authoring
(`bakeWeaponDrop` in the Lab library): release with the hand's velocity, ballistic fall (g = 9.8) while turning to
lie flat **on its side** (weapon X axis vertical, barrel along its release heading), one 5 cm bounce with a small rock
about the barrel, then rest. The rest spot is the nearest spot to the natural landing point that is clear (in the ground
plane) of every body voxel of the final pose; every frame the weapon is lifted so no voxel goes below the ground. The left hand lets go
(`supportW` → 0) at the drop; ground contact of the body ignores the released weapon.

Converter checks (`checkDeath`, abort on failure), reported in `check`: `weaponMinY` (lowest weapon voxel after the
drop, ≥ 0), `weaponGap` (rest clearance weapon ↔ body voxels measured in the ground plane, so the weapon is beside the body and
never under the raised back or a limb, ≥ 2 cm; measured 4–6 cm), `restMinY` (lowest body
voxel of the last frame, full voxel set, ≥ −1 cm; measured 0). Engines that ignore bit 7 still get a valid (old-style)
in-hand weapon from `weaponMount`.

## 3. Events

`clip.events = [ { "t": seconds, "type": "...", ... } ]`, sorted by `t`. Fire when the playhead crosses `t`
(including on loop wrap). Positions are given in the space named; the engine converts with the current pose.

| Type | Fields | Meaning |
|---|---|---|
| `footstep` | `foot`: `L`/`R` | heel strike (sound, dust puff) |
| `muzzle_flash` | `fx`: `rifle`/`mg`/`sniper` | at weapon `muzzle`, direction weapon +Z (FX §6) |
| `tracer` | `fx` | spawn a tracer at the muzzle (MG: every 4th round, rifle: none by default, sniper: none) |
| `shell_eject` | `fx` | spawn casings at the ejection port (weapon space `ejectPort` in §6), to the weapon's right |
| `suppressed` | | sniper: gas puff at the suppressor (instead of a flash) |
| `recoil` | `kick` | informative (the kick is in the pose); camera shake hook |
| `mag_out`, `mag_in`, `bolt`, `belt_open`, `belt_close` | | reload sounds / small FX |
| `grab`, `stow` | | ammo collection: take from crate, put in pouch (the game grants ammo at `stow`) |
| `hit` | | damage reaction peak |
| `body_fall` | | death: body hits the ground (dust) |
| `door` | | enter/exit: crossing the door plane (clip space z of the threshold in field `z`) |
| `touchdown`, `harness_release`, `canopy_ground` | | parachute (`canopy_ground` also starts the canopy hold / dissolve clock, §2.3.3) |
| `weapon_drop`, `weapon_land` | | death clips: the weapon leaves the right hand / hits the ground (sound, small dust) (§2.5) |
| `crate_touch`, `crate_bounce` | | crate |

## 4. Blending and transitions

- Blend two poses per slot by converting each Euler XYZ to a quaternion and **nlerp** (shortest arc);
  `rootPos`, `supportTarget` lerp; `rootRot`, `weaponMount` quaternion nlerp; `flags` and `handItem` take the
  dominant clip (weight ≥ 0.5).
- **Re-solve the left arm after any blend with `supportW > 0`**: target = weapon support point transformed by
  the blended right forearm and weapon mount; analytic 2-bone IK (equal bones 3.5 V, elbow pole = down/out,
  `solveArm2` in the Lab library). Weight it with the blended `supportW`. This keeps the support hand on the
  handguard every frame, also mid-blend.
- Locomotion clips share a **normalised phase** (0 = left heel strike, 0.5 = right heel strike): `idle`, `walk`,
  `run` blend phase-synchronised (sample the target at the source's phase), so transitions never swap feet.
- Default cross-fade durations (`anims.json` `transitions`, `from -> to : seconds`, `*` = any):

| From → to | s | Note |
|---|---|---|
| idle ↔ walk, walk ↔ run | 0.25 | phase-synced |
| idle/walk/run → aim | 0.20 | upper body leads |
| aim → fire, fire → aim | 0.06 | fire clips start from the aim pose (no pop) |
| aim ↔ crouch_aim | 0.30 | |
| crouch_aim → crouch_fire | 0.06 | |
| * → reload | 0.15 | from aim / idle |
| * → hit | 0.08 | additive-looking, returns to the previous clip with 0.2 |
| * → death_* | 0.10 | |
| * → turn_l/turn_r | 0.15 | |
| para_descent → para_land | 0.10 | at touchdown |
| para_recover → idle | 0.20 | |
| * → * (default) | 0.20 | |

- The first frame of `fire`, `reload` and `crouch_fire` equals the last frame (loops) and equals `aim` /
  `crouch_aim`, so aim ↔ fire also chains without a blend.

## 5. Speeds (no foot sliding)

| Clip | Speed m/s | Cycle s | Step m |
|---|---|---|---|
| walk | 1.30 | 0.92 | 0.60 (stride 1.20) |
| run | 3.80 | 0.72 | 1.37 (stride 2.74, flight phase, lean 0.48 rad) |
| stairs_up / stairs_down | 0.56 m along + 0.35 m rise per cycle (`delta`) | 1.00 | 1 stair per step: 0.175 m rise × 0.28 m tread |
| enter_building / exit_building | root motion 1.68 m (4 steps of 0.42 m), door plane at the `door` event's `z` | 2.40 | — |
| para_descent | 5.0 down | 4.8 | — |
| crate/descent | 6.0 down | 3.2 | — |

Exact values are in each clip's `speed`, `delta` and `stairs` fields. Every clip carries `check`: `footSlide`
(max horizontal drift of a sole while its planted flag is set, world = clip + agent travel), `supportError`, `minY`
(lowest voxel, < 0 = below ground; the rigid foot has no ankle, so up to ~2–4 cm of toe/heel dips in stance).

## 5.1 Clip list (per class `rifleman`, `mg`, `sniper`; class `crate`)

| Action | s | Loop | Notes |
|---|---|---|---|
| idle | 3.0 | yes | breathing, weight shift, head scan; low-ready carry |
| walk / run | 0.92 / 0.72 | yes | in place, `speed` 1.3 / 3.8 m/s; walk upright, run = port arms, strong lean, big strides |
| turn_l / turn_r | 0.8 | no | ±90° in place (`delta[3]`), two steps |
| aim | 2.0 | yes | rifle/sniper bladed shoulder; MG hip, wide stance |
| fire | rifle 0.9 / MG 1.0 / sniper 1.9 | yes | rifle 3 aimed shots (short kick); MG 12 rounds/s rattle + body shake, tracer every 4th; sniper 1 heavy suppressed shot + bolt cycle (left hand on the bolt) |
| crouch_aim / crouch_fire | 2.0 / as fire | yes | kneeling on the right knee; MG shouldered when kneeling |
| reload | rifle 2.4 / MG 4.2 / sniper 2.9 | no | rifle: mag out → pouch → mag in → charging handle; MG: cover open → box off → new box from the pack → belt → cover closed; sniper: bolt back → mag swap → bolt forward |
| hit | 0.6 | no | jolt back, weapon knocked off line |
| death_a / _b / _c | 1.2 / 1.4 / 1.2 | no | flat on the ground by 0.6–0.8 s; backwards onto the back / crumple forward face down / spun onto the side; the weapon is released (`weapon_drop` 0.3 / 0.4 / 0.3 s) and falls to lie flat beside the body (§2.5); hold the last frame (corpse) |
| collect_ammo | 3.2 | no | kneel at a crate 0.85 m ahead, grab (`grab`), stow on the vest (`stow`), stand |
| enter_building / exit_building | 2.4 | no | weapon up / scanning; root motion 1.68 m |
| stairs_up / stairs_down | 1.0 | yes | root motion per cycle |
| para_descent / para_land / para_recover | 4.8 / 1.5 / 3.2 | yes / no / no | §2.3.1 |
| crate/descent, crate/land | 3.2 / 3.5 | yes / no | §2.3.2 |

Missing data / approximations: the magazine / MG ammo box are part of the approved weapon mesh, so they cannot be
removed during a reload; the reload shows a separate `handItem` box in the left hand (new mag / box / belt end).

## 6. FX spec (voxel style, small and brief — they must not hide the battlefield)

All FX are **axis-aligned voxel cubes** (like the engine's 0.25 m explosion voxels, but small), unlit/emissive,
no smoke columns. Sizes in metres; colours sRGB; lifetimes in seconds; "frame" = 1/30 s.

| FX | Spec |
|---|---|
| `muzzle_flash.rifle` | 1 frame (+1 frame at 50 % size): star of 5 voxels of 0.05 m: 1 core at the muzzle + 1 ahead (+Z, 0.06 m) + 4 side voxels ±X/±Y at 0.05 m; core `#fff2b0`, tips `#ffb347`; point light 2 m, 1 frame |
| `muzzle_flash.mg` | 2 frames per round, bigger: core 0.07 m + 3-voxel +Z spike (0.06 m steps) + 4 side voxels at 0.07 m, flicker: alternate rounds rotate the star 45° about Z and scale 0.8/1.0; light 3 m |
| `muzzle_flash.sniper` | suppressed: no star. `suppressed` puff: 4 grey voxels 0.04 m (`#c9c6bd`, alpha 0.6) drifting +Z 0.5 m/s and up 0.2 m/s, growing to 0.07 m, 0.35 s |
| `tracer` | streak of 5 voxels of 0.04 m along the bullet direction, total 0.6 m, `#ffd27a` core / `#ff8a3a` tail, speed 600 m/s (visual), max 0.5 s life; MG every 4th round only |
| `shell_eject` | one voxel 0.03 × 0.03 × 0.05 m brass `#c8a14a`, from `ejectPort` (weapon space: rifle `(-0.05, 0.08, 0.10)`, MG `(-0.07, 0.10, 0.12)`, sniper `(-0.05, 0.10, 0.03)`), velocity weapon-space `(-2.0, 1.2, -0.3)` m/s ± 20 %, gravity, bounces once, removed after 0.6 s |
| `footstep` dust | optional, 2 voxels 0.05 m ground colour, 0.25 s |
| `body_fall` dust | 6 voxels 0.06 m, 0.4 s |
| `canopy_ground` dust | 8 voxels 0.08 m around the hem, 0.5 s |

The Lab previews all of them (MILITARY LAB, Anim mode).
