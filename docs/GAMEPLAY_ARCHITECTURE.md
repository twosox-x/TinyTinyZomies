# Gameplay architecture — Phase 7 Stage B, Milestone B1 (and hooks for B2–B4)

Status: **PROPOSED** (interface step, 2026-11-27). Nothing here changes an approved rule. Balance values are
UNAPPROVED (`config/balance.json`). Items that need the owner are marked **OWNER**.

This step adds no gameplay. It records what exists (checked in the code, not taken from docs), baseline numbers, the
B1 architecture with explicit ownership, and compilable interface headers under `src/game/` plus an empty
`--map city --game` mode.

---

## 1. Inventory: what exists and what does not

### 1.1 GPU horde (`src/sim/CrowdSim.*`, `shaders/sim_*.comp`, `nav_*.comp`)

| Feature | State | Where / notes |
|---|---|---|
| Agent storage | Exists | `Agent` 80 B AoS (`common.glsl`), capacity 65,536 (`SimParams::agentCapacity`). **Re-sorted by cell every step** (`sim_scatter`): an agent's index changes every step. There is **no stable agent id** and no free 80 B bits for one (`info.w` holds the climb target, the look takes `info.x` 8–31 and `info.y`). |
| Spatial grid | Exists | Counting sort: `cellCount` / `cellStart` (+1 graveyard bucket), 0.75 m cells. After a step, `agentsA` is in cell order and `cellStart` points into it: GPU neighbour queries by cell are already possible. **Not exposed** by `CrowdSim` (no accessors for `cellStart_` / `cellCount_`). |
| Zombie health | Exists, explosions only | Half-float in `info.z` bits 0–15, 1.0 at spawn (`sim_spawn.comp`). The **only** writer is the explosion loop in `sim_predict.comp` (damage ∝ falloff² × lethality). **No per-hit damage API, no damage buffer.** |
| Death / dismember / blood | Exists | `sim_predict`: blood spray, bloodiness, limb severing with probabilities, head loss kills, torn apart near lethal blasts, gibs (`blowOff`). `sim_finalize`: DYING → settle → corpse + height splat; drip, blood pools; **legless survivors crawl for good** (prone). These are the paths bullet hits must reuse. |
| Corpses, corpse piles, climbing | Exists, tested | Corpse height field (mm, atomics), ramps, PBD stacks, CLIMB state with pressure trigger; corpses reactivated by blasts re-enter as DYING (so they cannot "die twice" as walkers). |
| Kill events to the CPU | **Missing** | Only aggregate counters (`C_DEATHS_TOTAL`) via the async stats ring. No per-kill records, no attribution. |
| Navigation | Exists | One shared Eikonal field: `nav_relax` seeds distance 0 within `goalRadius` of **≤ 4 goals** (uniform `goals[4]`), goals outside the window seed the border; `nav_dir` gradient. Congestion and climb cost. Set from the CPU with `setGoals()`. **No attraction to soldiers or noise; no awareness radius** (with any goal, every zombie in the window converges on it; with none, flow is zero and they mill about). |
| Zombies attacking | **Missing** | No attack state, no contact query against anything but other agents / static cells. |
| Soldier collision | **Missing** | Zombies collide with agents, static boxes / height grid and vehicles (stamped into the static grid by `CityVehicles`). Nothing would stop them walking through a soldier. |
| Explosions | Exists | `requestExplosion(x, y, z, scale)` (≤ 8 per step) + `requestFire`; explosion log consumed by `CityVehicles` (chain reactions). |
| GPU → CPU readback | Exists (async) | `CrowdSim` ring of 3 transfer buffers harvested with `SDL_QueryGPUFence`; one optional extra buffer (`setExtraReadback`, already used for character counters). `CrowdSim` **owns the frame fence** (`onFrameSubmitted`); a second consumer needs a "last completed frame" query. `GpuContext::downloadNow` is synchronous (tests only). |
| Explosion / spawn APIs | Exist | `requestSpawn(rect, n)` (one request per step), `requestSpawnLook`, `requestSpawnCorpses`. |

### 1.2 Simulation window (`src/city/CitySimWindow.*`, `CityWorld.*`)

- The horde lives in a window of 512 × 512 cells (384 m) that follows the camera pivot in 64-cell (48 m) steps
  (worker thread computes heights + moon shadow; commit = GPU shift of fields).
- Zombies left outside are **parked** (frozen, not drawn) in a GPU list of `max(1024, capacity / 4)` = 16,384;
  overflow is **despawned** (`parkDropped`). Corpses outside the window keep only their instance; heights re-splat.
- Static heights per window = max of the baked 0.5 m HGT0 samples per 0.75 m cell (FORMAT.md: `i16 top` cm +
  `u8 flags` ROAD / WALK / BUILDING / WATER / VEG / BLOCKED / VEHICLE / OPEN). Flags are **not** carried into the
  window (only heights; water becomes a 1 m wall).
- `CityVehicles::simHeights()` is the live window grid (static + every vehicle at its pose), updated by row runs.
  **Gap:** `AppState::staticHeights` is only rebuilt on scenario load, so it is stale after a window move (the
  camera uses `CityRenderer::heightAt`, so nothing breaks today; game code must use `vehicles.simHeights()`).
- No interiors / floors (GAME_DESIGN 7: B3).

### 1.3 Military rendering (`src/lab/MilitaryLab.*`, `MilitaryAssets.*`, `shaders/mil_pose.comp`, `mil_attach.comp`)

- `MilitaryLibrary` loads `assets/military/` (10 infantry variants, 38 props, 68 clips: per class `idle walk run
  turn_l turn_r aim fire crouch_aim crouch_fire reload hit death_a/b/c collect_ammo enter_building exit_building
  stairs_up stairs_down para_descent para_land para_recover`, plus `crate/descent`, `crate/land`) and transitions.
- Clip playback (CPU): 30 Hz dense frames, cross-fade per the transition table with phase-matched locomotion, the left
  arm re-solved to the support point, root motion committed at clip end, slung weapon (bit 6), dropped weapon track
  (bit 7), hand items. Clip **events** are fired when the playhead crosses them (also across loop wraps): fire clips
  carry `muzzle_flash` / `shell_eject` / `tracer` / `suppressed`, reload `mag_out / mag_in / bolt`,
  collect `grab / stow`, recover `harness_release / weapon_draw`, land `touchdown / canopy_ground`.
- GPU: `CharU` (240 B) per soldier → `mil_pose` (one thread per soldier, zombie hierarchy) → `mil_attach` (one thread
  per part) → per-mesh instance buckets → one instanced draw per mesh through the city material / lighting / shadow
  path (`CityRenderer::drawExternal`). Distance LOD (pose rate, small gear), frustum cull per soldier. Caps:
  1,280 soldiers, 28,672 parts, 8,192 CPU instances.
- FX: CPU pool (≤ 4,000) of voxel flashes / tracers / casings / puffs / dust at the **posed** muzzle (CPU forward
  kinematics), up to 4 flash point lights. Muzzle flashes (round-3 feedback) are 3-frame voxel sequences per weapon (rifle / MG: hot core, tapering forward cone, side prongs, random roll; 1/60 s per frame) and their light is a small *sharp* point light (negative radius in `PointLight`: inverse-square with a 0.35 m core, windowed to 4-5 m, plain Lambert, never merged with fire lights; `lighting.glsl pointLights`), not a soft glow. Game rounds (after B1 feedback): flash + tracer per `FxKind::Shot` along the
  real shot ray (`GameRender::shotFx` -> `MilitaryRenderer::fxShotRay`; tracer cadence `GameRender::tracerEvery` =
  rifle 3, MG 1, sniper 1 (faint)); the streak ends where the GPU resolved the round (`HordeBridge::hitResults`,
  per-shooter queue order). Flashes / tracers are emissive by day and night, scene-pass only, and keep a minimum
  angular size (~2-3 px) at RTS distance. LODs (city chunks, instances, foliage, soldiers) measure from the nearer of
  the eye and the camera focus (RTS pivot); props / foliage are never distance-culled (coarse LODs instead). Parachute sequences for soldier (street, rooftop with canopy clamp) and
  cargo crate, canopy voxel dissolve after `canopy_ground` (2.5 s hold + 2.5 s).
- Renderer look (round-3 owner feedback, `src/render/Renderer.*`, `shaders/include/{lighting,shadow}.glsl`):
  - DOF auto focus: the focus distance is the median of 5 view rays (screen centre +- 4 %) marched through the city's
    coarse height grid, smoothed in log distance over 0.25 s (`RenderSettings::dofAutoFocus`), so a rooftop squad at the
    screen centre is sharp. Zoom-adaptive curve (`dofAt`): base values up to 70 m; towards 300 m the aperture stays,
    max blur x0.85, a 0.04 in-focus band, and a screen-space tilt-shift CoC floor (0.8 at the top / bottom edge, sharp
    centre 28 % of the half height) keeps the miniature look at max zoom.
  - Smooth sun shadows: the shadow map is a 2-layer array; each layer holds the sun at a fixed clock key (1/150 h),
    the layers re-render on alternate frames (texel-snapped fit), receivers cross-fade the two keys around the clock
    (`shadowP2`). No stepping, no rotating texel grid, one shadow pass per frame.
  - Foliage: full detail out to clamp(1.1 x camera distance, 100, 160) m from the nearer of eye / pivot, dithered
    density fade over 120 m to the far set (every 8th instance, 2.8x wider, lower, height-varied: a crop surface).
  - Windows: per-room (3.2 m x 3 m) brightness (off / dim / lit / bright) and colour (warm, neutral, fluorescent, rare
    flickering TV blue); by day glass gets a per-room tilted sun glint + Fresnel sky reflection.
  - Day / night: 20 real minutes of day (06-18 h) + 7 of night (`TimeOfDaySettings::dayMinutes / nightMinutes`).
- **All of this is private to `MilitaryLab`** (one 1,445-line class: scene, UI and renderer mixed). The renderer hooks
  are single `std::function`s on `Renderer` (`extPrepare / extDraw / extShadowDraw`), so lab and game are exclusive.
  The stress mode moves soldiers with a scripted "walk along the street, turn back at obstacles" (no navigation).

### 1.4 App, input, UI, tooling

| Piece | State |
|---|---|
| `App` | SDL loop, fixed 60 Hz sim accumulator (≤ 2 steps / frame, time dropped beyond), headless deterministic pacing (`--frames` ⇒ dt = 1/60), scripted blasts / spam / pans, screenshots. |
| RTS camera | City Lab rig: pivot on the ground, pitch 35–70°, 30–300 m, WASD / edge pan, **right-drag pan**, Q/E / MMB rotate. `Camera::screenToGround(sx, sy, w, h, planeY)` exists (plane pick only; no height-grid ray pick). **Conflict:** RMB is the RTS move-order button; proposal in `Commands.h` (RMB click = order, RMB drag = pan). |
| Tools | LMB: explosion / goal / spawn 500 (debug tools; disabled in the lab and in `--game`). |
| DebugUI / ImGui | Debug panel (F1), perf HUD (F3), lab panel. ImGui v1.93 with SDL3 GPU backend. No game HUD. |
| Profiler | `nowMs`, `RunningStat`, `FrameHistory`, RSS; perf report table (`--perf-report --perf-split`: GPU sim and render measured apart, headless). No GPU timestamps (SDL3 GPU has none). |
| Self-test | `ttz_selftest`: headless GPU tests grouped by section with `check()`; env vars select sections (`TTZ_SELFTEST_VEHICLES`, `TTZ_SELFTEST_MOVE`). Baseline: **PASSED, 0 failures, 155 s** (lavapipe, 4 cores). It links sim + city + vehicles, not the renderer / lab. |
| Bench | `ttz --bench` (zombie matrix), `--bench-scenarios citymap`, lab `--lab-stress`. |
| Determinism | Sim is deterministic for a given step sequence (seeded hashes); async readback latency is not (fence timing). |

---

## 2. Baseline measurements (lavapipe, 4 CPU cores — relative only, never Mac numbers)

All headless, 1280 × 720, no vsync, release build of `f69d736`. Each `--map city` run: 120 frames, the first 30
dropped (row "before" of the perf report), 1 sim step per frame (`--frames` pacing).

```bash
./build/ttz --map city --headless --width 1280 --height 720 --frames 120 --perf-report --perf-split --no-vsync --count N
./build/ttz --lab military --headless --width 1280 --height 720 --lab-stress 10,100,250,500,1000 --bench-frames 60 --lab-zombies 2000
```

### 2.1 City mode, default view (window 384 m, camera over the default spawn; 6 visible tiles, 95 draws, 0.73 M tris)

| Zombies requested (live at end) | Frame ms avg / p95 | GPU sim (1 step + readback) avg / p95 | GPU render avg / p95 | CPU sim record | CPU render record |
|---|---|---|---|---|---|
| 2,000 (1,951) | 700 / 789 | 46.0 / 61.9 | 652 / 732 | 0.18 | 0.77 |
| 10,000 (9,732) | 769 / 879 | 52.1 / 70.6 | 716 / 813 | 0.19 | 0.74 |
| 30,000 (29,248) | 1031 / 1199 | 72.4 / 91.7 | 957 / 1121 | 0.20 | 0.84 |

Reading (relative): on lavapipe the frame is dominated by rasterisation (city + characters); the sim step grows
~1.6× from 2 k to 30 k zombies with a large fixed part (the 512² nav relaxation and grid passes do not depend on the
count). CPU recording cost is negligible. Gameplay must therefore keep its GPU additions **proportional to soldiers /
hits, not to cells**: the passes in 3.3 are per soldier, per hit, or one indirect pass over live agents.

### 2.2 Military lab stress (RTS 110 m view, 2,000 zombies)

| Soldiers | Frame ms avg / p95 | Lab CPU ms (sample + pack) | Posed (visible) | Instances | Draws | Lab tris (M) | FX voxels | Upload KB / frame |
|---|---|---|---|---|---|---|---|---|
| 10 | 1027 / 1215 | 0.10 | 23 | 372 | 197 | 0.29 | 2 | 23 |
| 100 | 1079 / 1239 | 0.25 | 113 | 1,602 | 203 | 0.49 | 56 | 102 |
| 250 | 1291 / 1455 | 0.50 | 263 | 3,680 | 208 | 0.83 | 176 | 234 |
| 500 | 1599 / 1847 | 0.97 | 513 | 7,099 | 212 | 1.39 | 330 | 453 |
| 1000 | 1948 / 2209 | 1.70 | 1,013 | 14,000 | 208 | 2.51 | 693 | 894 |

Reading (relative): the lab's CPU side (clip sampling + packing) scales linearly at ~1.7 µs per soldier and stays
small; draws stay flat (one per mesh); the lavapipe frame grows with triangles (1.9× from 10 to 1,000 soldiers).
Upload is ~0.9 KB per soldier per frame (CharU 240 B + parts). The game adds AI / combat CPU per soldier on top; the
budget target for B4 stress is to keep game CPU per tick in the same order as this sampling cost (profile, do not
extrapolate). The lab view is a different camera from 2.1 (frame times are not comparable across the two tables).

---

## 3. Architecture for B1

### 3.1 Module layout (`src/game/`) and ownership

| File | Responsibility | Owner |
|---|---|---|
| `GameTypes.h` | handles (index + generation), class / squad / ammo enums, soldier states, anim actions, squad flags, kill causes, deterministic RNG | shared (change by agreement) |
| `GameEvents.h` | per-tick event queues: `ShotEvent`, `KillEvent` (with `seq`), `NoiseEvent`, `FxEvent` | shared |
| `GameContext.h` | pointer bundle handed to every module tick (no module keeps pointers to another) | shared |
| `Config.{h,cpp}` + `config/balance.json` | all balance values, `status: UNAPPROVED`; weapons (damage, range, accuracy, fire rate, magazine, reserve, reload, noise, acquisition), soldiers, squads (5 / 3 / 1, APPROVED compositions), economy, logistics, threat | WS-D (each WS adds its own fields) |
| `HordeInterface.h` | what gameplay needs from the horde: soldier upload, hit requests, attractors; zombie field, contacts, kills (deduped); `simulated(x, z)` | WS-A (interface frozen; changes by agreement) |
| `HordeBridge.{h,cpp}` | GPU implementation (passes, buffers, readback ring) | **WS-A** |
| `Soldiers.{h,cpp}` | `SoldierPool` (SoA) + `SquadList`; per-field writer rules in the header | WS-C |
| `NavGrid.{h,cpp}` | walkability from the live window grid, islands (street vs each roof), budgeted A*, string pulling, LOS | WS-C |
| `SoldierAI.{h,cpp}` | state machine, perception, formations, anti-oscillation rules | WS-C |
| `Combat.{h,cpp}` | rounds from clip events, spread, reload transfer, contact damage, attractors, hit requests | WS-C |
| `SoldierAnim.{h,cpp}` | CPU clip playback in the game tick, cross-fades, events → gameplay, rate matching to weapon stats | **WS-B** |
| `GameRender.{h,cpp}` + `src/lab/MilitaryRenderer.{h,cpp}` | MilitaryRenderer extracted from the lab; game adapter; in-world markers / ghosts | **WS-B** |
| `Economy.{h,cpp}` | funding, ledger, passive income, kill rewards with seq dedupe | WS-D |
| `Logistics.{h,cpp}` | container and airdrop crates, finite stock per ammo type, slot reservations, grab transfer | WS-D |
| `Deploy.{h,cpp}` | purchase → validated drop plan → parachute → landing → recovery → formation | WS-D |
| `Commands.h`, `GameUI.{h,cpp}` | input → `Command`s, selection, RTS HUD, markers, previews | WS-D |
| `GameScript.{h,cpp}` | `--game-script` headless scenarios with `expect` checks | WS-D |
| `GameWorld.{h,cpp}` + App hooks | tick order, command application, wiring | WS-D (integration) |

### 3.2 Game tick vs render frame

- **Game tick: fixed 30 Hz** (`kTickDt`), from `dt × simSpeed`, paused with the sim, at most 4 ticks per frame (time
  dropped beyond, like the sim). The **GPU horde keeps its own 60 Hz step** (unchanged).
- Order inside `App::frame` (implemented as empty hooks now, see `GameWorld.h`):
  1. input → `GameUI::handleEvent` → `CommandQueue` (before the sandbox tools; tools are off in `--game`)
  2. camera, vehicles, sim window (unchanged)
  3. `GameWorld::preSim`: ticks — a commands, b horde outputs (kills → economy, contacts, field), c Deploy, d AI,
     e animator (events), f Combat (rounds, reload, damage, attractors, hit requests), g Logistics, h Economy,
     i Script, j horde inputs — then `HordeBridge::preSim(cmd)` (uploads + hit resolve)
  4. `CrowdSim::step × N`
  5. `GameWorld::postSim`: field / contact passes, readback copy (after the last step, before `writeDrawArgs`)
  6. `GameWorld::render` → `GameRender::update` (pose inputs, FX) before `Renderer::render`
  7. `GameWorld::drawUI` inside the ImGui frame
  8. submit → `GameWorld::afterSubmit` → `HordeBridge::harvest` (non-blocking)
- Clip time advances in the **tick** (events must be deterministic and drive gameplay); the renderer samples the pose
  at render time from the same playback state plus the fraction of the tick elapsed.
- **Threading:** all main thread in B1. NavGrid A* is budgeted per tick (node budget, round-robin). Move A* / AI
  perception to a worker only if profiling shows it (B4 stress: 1,000 soldiers).

### 3.3 Combat ↔ GPU horde (WS-A)

Principle: **the CPU never names a zombie.** Agents are re-sorted every step, so a CPU index is meaningless one step
later and there are no free bits for a stable id in the 80 B record. The CPU aims at a point; the GPU decides who a
round actually hits. That is also physically right in a horde (a round hits the zombie in front).

**Targeting (perception).** `game_field` (one indirect pass over live agents, after the last step of a frame):
the window in 6 m tiles (8 × 8 cells; 64 × 64 tiles for the 384 m window); per tile an atomic walker count and the
first 4 walker positions. Copied into the readback ring (~330 KB per slot; restrict to tiles near soldiers if needed
in B4). The AI associates its lock to the nearest sample each refresh, with hysteresis (keep within 2.5 m, lost
after 0.6 s, switch only for a close threat). LOS on the CPU against the `NavGrid` height grid. Latency 2–3 frames
(~50 ms ≈ 7 cm of zombie motion) is harmless because the hit is resolved on the GPU.

**Shooting.** A round = `HitRequest {origin, dir, maxDist, damage, shooter, flags}` produced on the animator's
`muzzle_flash` / `suppressed` event (fire sync). `game_hits` (one thread per hit, before the next step): DDA along
the ray through sim cells; for each cell, test the capsules of that cell's agents (`cellStart` / `agentsA` of the
previous step: consistent until the next scatter); stop at static height above the ray (buildings, vehicles). On a
hit: `atomicAdd(damage[agent], fixed point)` and `atomicMax(lastHitter[agent], shooter)` into two cap-sized uint
buffers (indexed by the current sorted index, valid until the next scatter, consumed by the very next predict).

**Applying damage.** `sim_predict` (modified) reads `damage[i]` before the explosion loop and runs the **existing**
health / blood / sever / DYING path with small "bullet" parameters (spray, bloodiness, low sever chance, headshot
flag severs the head = existing "no head: dead" rule), then clears it. On the alive → DYING transition (any cause:
hit or explosion) it appends `KillRecord {seq = atomicAdd(killSeq), cause, shooter, pos}` to a kill ring.

**Kill dedupe.** One thread owns an agent per step and sees its transition exactly once; reactivated corpses re-enter
as DYING and never re-trigger. The CPU additionally drops any record with `seq ≤ lastSeq` (a slot harvested twice)
in `HordeBridge` and again in `Economy::creditKill` (defence in depth, unit-tested). Ring overflow is counted on the
GPU and paid anonymously, so rewards never silently drop. (A stable agent id + generation is **not required** for
B1; if B4 needs it, add a cap-sized `agentId` SoA buffer permuted by `sim_scatter`: +4 B / agent / step bandwidth.)

**Zombies vs soldiers.**
- *Collision:* `game_stamp` writes soldier indices into a per-cell `soldierCell` buffer (clear last tick's cells, stamp
  this tick's); `sim_solve` checks the 3 × 3 cells and pushes zombies out of soldier capsules (infinite mass). Without
  this zombies walk through soldiers — required for B1.
- *Damage:* `game_contacts` (one thread per soldier): walkers / climbers within `attackReach` of the capsule
  (`attackers`), count within 8 m (`nearby`, threat response). Read back with the field; `Combat` applies
  `attackers × damagePerSecond × dt` and the hit reaction. Bounded: ≤ 2,048 soldiers × 9 cells.
- *Attraction / noise:* attractors (alive landed soldiers, aged noise events; bounded list, e.g. ≤ 256) uploaded per
  tick; `nav_relax` seeds them as sources (distance offset −strength); `nav_dir` zeroes the flow farther than
  `awarenessRadius` from every source (zombies far from the action wander instead of crossing the city). Scenario
  goals keep working through the same path. Noise intensity / radius / duration per weapon (config; GAME_DESIGN 8).
- *Explosions:* unchanged path; kills from them are `cause = Explosion` (whether they pay is **OWNER**).
- *Vehicles:* rounds stopped by a vehicle cell report an impact (bounded impact list in the readback) → B4 can feed
  `CityVehicles` damage so infantry fire joins the chain reactions (GAME_DESIGN 14b).

**CrowdSim changes (WS-A only):** `cellStart() / cellCount()` accessors; `lastCompletedFrame()` (the bridge's ring
slots are released by frame number because `CrowdSim` owns the fence); extra bindings in `sim_predict`
(damage, lastHitter, killRing), `sim_solve` (soldierCell, soldiers), `nav_relax / nav_dir` (attractors); `reset()`
clears them; `relocate()` clears damage (indices change). Agent stays 80 B.

### 3.4 Soldier rendering (WS-B)

Extract `MilitaryRenderer` (`src/lab/MilitaryRenderer.h`, API already written) from `MilitaryLab`: library load +
meshing, pose / attach pipelines, buckets, cross-fade sampling with left-arm re-solve, slung / dropped weapon, hand
items, LOD + culling, FX pool + flash lights, canopy / crate tracks with roof clamp and dissolve, prepare / draw /
drawShadow. `MilitaryLab` becomes a client (its review captures must stay pixel-identical: compare `--lab-views`
shots before / after). Game soldiers are `MilPoseInput`s built from `SoldierPool` + `AnimPlayback`
(`GameRender::update`). Caps (1,280 soldiers, 28,672 parts) cover the 1,000-soldier stress; raise them with the
measured cost if needed. Dead soldiers keep their final death pose (bounded body list; removal / dissolve **OWNER**).

### 3.5 Soldier navigation (WS-C)

- Grid A* over the window's live height grid (`vehicles.simHeights()`, 0.75 m), 8-connected, octile heuristic,
  clearance pre-dilated, node budget per tick, string pulling; local steering (path following, squad separation,
  arrival). Rebuilt on window moves, rows patched on vehicle changes (event driven).
- Walkable step ≤ 0.5 m; each flat roof is its own island: **B1 rooftops only via drop placement** (sniper on a
  roof stays on that roof). Interiors / stairs are B3.
- No pathing toward zombies (no chasing). Stuck detection → one re-plan, then hold + squad flag.

### 3.6 Simulation window vs persistent world

**B1 constraint (proposed for B1 only):** gameplay happens inside the simulated window. Deploy, container and
airdrop placement are refused outside it (`HordeInterface::simulated`). The window keeps following the camera.
**Risk:** if the player pans away, soldiers outside the window keep their CPU state but meet only parked (frozen)
zombies, and zombies beyond the 16,384 parked-list capacity are despawned. B1 mitigation: soldiers outside the window
hold position and do not consume ammo; a UI warning marks such squads. This is a known exploit/freeze, acceptable
only until B4.

**B4 proposal (OWNER must approve before invasive changes, GAME_DESIGN 10 / 14b):** separate "where the player looks"
from "where the war is": (1) persistent CPU world state for military, supply, territory (already independent of the
window); (2) one full-detail window that follows the *action* (weighted soldier clusters) rather than the camera,
with the camera free; (3) distant squads at reduced tick rate against an **aggregated zombie layer** (per 48 m
block: count, mean flow, pressure; integrated on the CPU or a coarse GPU grid), converted to / from real agents when
the full window arrives (spawn from the aggregate, park into it); (4) optionally two GPU windows (camera + action).
Costs and risks to be measured before the proposal goes to the owner.

### 3.6b Ambient population and roaming (owner feedback after B1: "no condensed tiny hordes")

Status: implemented, values **UNAPPROVED** (`config/balance.json` `"ambient"`, mirrored in `SimParams::roam*`).

- **Placement** (`src/city/CityAmbient.*`, CPU, once per window and per newly visited 48 m block): open cells of the
  window's static heights weighted by distance to the nearest wall (chamfer: sidewalks / entrances 1–4 m most, streets
  and plazas normal, open ground > 25 m little) × local building coverage (40 m box: built-up blocks hold more);
  groups: singles (55 %), 2–8 (42 %), clusters of 10–24 in the most built-up spots (3 %). Count = `densityPerHa` ×
  open hectares, or `--count` exactly. Uploaded once as points (`CrowdSim::requestSpawnPoints`, `sim_spawn` point
  mode, `spawnPts` buffer = capacity × 16 B). `--game` always uses it; plain `--map city` has it as the last scenario.
  Newly visited blocks are populated on window moves only for a density-driven population (`--count N` stays exact,
  so the B1 scripts' "no zombies" runs are unchanged).
- **State** (no extra buffer): alert memory 0..15 in `info.z` bits 28..31 (free; health / sever / blood unchanged).
  Archetype (wanderer / lurker / crawler) is a hash of the look bits (no storage). Parked agents keep both.
- **Awareness** (`sim_predict`): an agent is *aware* when the nav distance of its cell is below the awareness gate
  (or any finite distance when no gate is set, i.e. scenario goals) — the same test `nav_dir` uses to zero the flow,
  so awareness and flow agree. Aware → alert = 15 and the unchanged pursuit path (flow field, crowd density speed:
  pressure, accumulation, climbing untouched). Not aware → alert decays stochastically to 0 over `alertMemory` s;
  the desired velocity holds the last pursuit heading (steered around walls) while the memory is fresh (~9 s at 25 s
  memory: they keep streaming to where the noise was), then eases into the wander velocity — no snapping.
  `predict` binds `navDist` (read-only, binding 3; `corpseH` moved to 4 so used bindings stay contiguous).
- **Wandering**: own heading from smooth per-agent value noise + a slowly drifting divergence-free field (curl of
  plane waves, ~70 m: neighbours drift together loosely, and having no sinks it never gathers people into clumps);
  pauses / shuffling in place (value noise gate, `pauseFraction`), staggered speeds; wall probes at 0.9 / 2.1 m with a
  per-agent turning side (walls deflect wanderers along streets and sidewalks; the window border turns them back);
  mild separation down the multi-scale density gradient (0.75–5 m). Lurkers (12 %) walk to the nearest wall within
  4.5 m and stand facing it; crawlers (3 %) lie prone while calm (`sim_finalize`) and get up when alerted.
- Cost: a few extra reads per idle agent per step (no new pass, no new buffer in the step except `navDist` binding).
- Self-test section *[R] ambient roaming* (`TTZ_SELFTEST_ROAM=1` alone, `TTZ_SELFTEST_NO_ROAM=1` skips): placement
  density and group mix; after 60 s idle nearest-neighbour median > 1.2 m, no cluster > 45 (1.5 m linkage), most
  move > 3 m, nobody in buildings / alerted, lurkers at walls, crawlers prone; a noise source (30 m gate) pulls the
  zombies within reach only; alert persists after it fades, then the crowd disperses (core count halves, no clump)
  and alert returns to 0. Headless shots: `tests/game/roam_ambient.txt` (script verb `noise X Z RADIUS DURATION`).

### 3.7 Determinism and tests

- Fixed ticks, seeded per-entity RNG (`pcg`), commands applied at tick boundaries in order. The only nondeterminism is
  readback latency; `--game-sync` (headless tests only) waits for each readback slot.
- **Self-test** (`ttz_selftest`, links the CPU game core `TTZ_GAME_CORE`): section *game core* (added now): balance
  file loads UNAPPROVED, squad sizes 5 / 3 / 1, kill dedupe by seq, soldier handle generations. To add per WS:
  - WS-A *combat GPU*: a ray through a line of zombies hits the first one only; N hits on one zombie emit exactly one
    kill; kills counted == `C_DEATHS_TOTAL` delta; blood / sever counters rise on hits; soldier capsule keeps zombies
    out; attractor pulls zombies within the awareness radius only; readback never blocks.
  - WS-B *anim*: fire clip at a given rate yields exactly `t / fireInterval` muzzle events; reload `mag_in` once;
    death always interrupts; lab captures unchanged.
  - WS-C *ai / nav*: path around a block; roof island unreachable from the street; target hysteresis (no switch
    while the lock is valid); ammo decreases by exactly the rounds fired; no state flapping over 60 s (transition
    count bound); no stuck soldier after a move order in the test map.
  - WS-D *economy / logistics / deploy*: purchase deducts once, invalid drop refused without charge; resupply moves
    rounds container → soldier and stock decreases by the same amount; two soldiers share one crate without deadlock;
    rewards == kills × reward (no duplicates).
- **Headless scenarios** (`--game-script`, exit code = failed expectations) for the B1 acceptance runs: deploy each
  squad type, move, fight a spawned horde, run out of ammo, resupply from a container and an airdrop, funding matches
  the ledger. Stress (B4): 10–1,000 soldiers with growing hordes.

---

## 4. B1 work breakdown (parallel workstreams)

The headers below are real and compile (`cmake --build`), the stubs link, and `ttz --map city --game` runs (empty
HUD bar, no behaviour). Each workstream codes against the headers and replaces only the bodies in its own files.
Shared headers (`GameTypes.h`, `GameEvents.h`, `GameContext.h`, `HordeInterface.h`) change only by agreement.

| WS | Scope | Owns (writes) | Codes against | First testable result |
|---|---|---|---|---|
| **WS-A Horde bridge (GPU)** | hit resolve, damage via the existing gore path, kill ring with seq, zombie field, contacts, soldier colliders, attractors + awareness, readback ring | `src/game/HordeBridge.*`, `src/sim/CrowdSim.*`, `src/sim/GpuTypes.h`, `shaders/sim_predict.comp`, `sim_solve.comp`, `nav_relax.comp`, `nav_dir.comp`, new `shaders/game_*.comp` (+ `shaders/compiled/`), self-test section *combat GPU* | `HordeInterface.h`, `GameEvents.h` | self-test: rays kill zombies, one kill record each |
| **WS-B Soldier rendering + animation** | `MilitaryRenderer` extraction (lab unchanged visually), `SoldierAnimator` (tick-time clips, events, rate matching), `GameRender` (pose inputs, FX from events, canopies / crates / supply props, selection rings, placement ghosts) | `src/lab/*`, `src/game/SoldierAnim.*`, `src/game/GameRender.*`, `shaders/mil_*`, `shaders/city.*` (if needed) | `MilitaryRenderer.h`, `SoldierAnim.h`, `GameContext.h` | lab captures identical; game draws a test squad in idle / fire |
| **WS-C Soldiers, AI, combat logic, navigation** | SoA pool use, NavGrid A*, state machine, formations, targeting from the field, firing / reload / damage, attractors | `src/game/Soldiers.*`, `NavGrid.*`, `SoldierAI.*`, `Combat.*`, self-test section *ai / nav* (with a CPU `FakeHorde`) | `HordeInterface.h` (FakeHorde until WS-A lands), `SoldierAnim.h` | FakeHorde test: squad kills point zombies, ammo drops, reloads |
| **WS-D Economy, logistics, deploy, commands, UI, scripts** | funding / ledger / passive income, container + airdrop (finite stock, slots), purchase → drop sequence, selection / orders input, RTS HUD + markers + previews, `--game-script` verbs + `expect`, App integration | `src/game/Economy.*`, `Logistics.*`, `Deploy.*`, `Commands.h`, `GameUI.*`, `GameScript.*`, `GameWorld.*`, `Config.*`, `config/balance.json`, `src/app/App.*`, `src/main.cpp`, `CMakeLists.txt` | all headers | script: buy, drop, move; HUD shows funding / selection |

Merge order: WS-A and WS-B in parallel from day 1; WS-C on FakeHorde, switching to `HordeBridge` once WS-A's
self-test passes; WS-D integrates last-mile in `GameWorld`. Conflicts are limited to `CMakeLists.txt` (WS-D adds
everyone's new files; others send the line) and `shaders/compiled/` (WS-A and WS-B regenerate only their shaders).

### OWNER decisions needed for B1 (none block the start)

1. Do explosion kills (vehicle chains, later grenades) pay a kill reward, or only soldier kills?
2. Fate of soldier bodies: stay (bounded), or dissolve like canopies after a while?
3. B1 limit: deployment only inside the simulated window (3.6). Persistence architecture comes in B4.
4. RMB: click = move order, drag = pan (keeps the City Lab rig). Alternative: LMB-select / RMB-order with pan on MMB.
5. Provisional balance values in `config/balance.json` are UNAPPROVED and labelled so in the HUD.

---

## 5. B1 integration notes (WS-D, 2026-11-27)

**Controls (`ttz --map city --game`; owner round 15 #11, 2026-11-28).** Command bar (bottom): **1-7** pick the cards of
the active tab in order (the number is drawn on each card; no letter hotkeys for cards any more), **Tab / Shift+Tab** next /
previous tab (Units, Structures, Supplies, Engineering, Vehicles). LMB places with a live preview (green = valid, red +
reason = refused; nothing is charged for a refused spot); Shift keeps the tool. **Q / E**: while a placement tool is
active they only rotate the placement (container, gate; T = 90 deg), never the camera; otherwise they turn the camera.
LMB click / box drag selects squads (Shift adds), **Ctrl+1-9** selects squad N (Ctrl+Shift adds), **.** (period) next
squad. RMB click = move order (Shift+RMB runs), RMB drag pans, H halts. LMB / RMB on an object with a default action
(a defense tower with shooters selected: occupy) runs it. **Esc** cancels the tool, else clears the selection, else
opens the pause menu (Resume / Quit); Esc never quits directly. G garrisons (building selected), Ctrl+Z undoes the
newest unfinished build. F1 shows the debug panel (off by default in `--game`).

**Economy.** Base income credited per tick, ledgered once per second; kill rewards per `KillCause` with seq dedupe;
ring-overflow kills paid anonymously; one-time purchases; no upkeep, no refunds. Explosion kills pay
`killReward.explosion` (provisional YES to OWNER question 1, UNAPPROVED, set it to 0 to disable).

**Deploy.** `Deploy::plan` validates on the live height grid: flat footprint (inside geometry / building edge refused),
not on a vehicle / wall / water (0.5–2.5 m above the local ground), rooftop when > 2.5 m (roof must be flat >= 3.6 m
and hold every member), inside the simulated window. Members land >= 3 m apart on the same island, staggered
altitudes, descent at the clip's `descentSpeed`; Deploy drives Descending -> Landing -> Recovering (`weapon_draw` or
the clip duration) -> Forming; SoldierAI forms up and takes over. `Deploy::drops()` feeds the canopy tracks.

**Logistics.** Container (7 x 4.5 m flat footprint, 4 door / side slots) and airdrop crates (descent, land clip,
collectable only once landed, scatter radius, empty crates dissolve). Finite stock; Combat transfers on `grab` via
`Logistics::collect` (Logistics never transfers by itself); stale reservations freed after 1 s. **B1: the container
can be placed anywhere valid** (B2 restricts it to controlled territory).

**Squad flags** have one owner: SoldierAI (GameWorld no longer recomputes them).

**Acceptance scripts** (`tests/game/*.txt`, headless, exit code = failed expectations; see `GameScript.h` for verbs):
`b1_combat_loop.txt` (5 / 3 / 1 by parachute incl. a rooftop sniper, autonomous fight, ammo use, rewards == kills x
reward, no duplicates, ledger balanced), `b1_resupply.txt` (container + crate resupply, stock conserved, invalid
placements refused without charge, move orders), `b1_input.txt` (hotkeys, placement click, click / box selection,
right-click move, tool cancel). Headless script runs render only the frames that take a `shot` (with the HUD).

---

## 6. Milestone B2: walls, containers, territory (2026-11-27)

**Modules.** `Walls` (CPU: network of nodes + 4 m pieces, snapping, placement validation, joints, health, pressure,
breaches, rubble), `Territory` (CPU: raster, flood fill, regions, states, income), `TerritoryGpu` +
`shaders/game_territory.comp` (GPU counts), `Fortifications` (`Fortify.*`: integration, obstacles, nav patches,
drawing), `FortUI.cpp` (wall tool, overlay, HUD; part of GameUI), `FortScript.cpp` (script verbs / metrics),
`FortSelfTest.cpp` (self-test section *walls / territory*). Shared files got small additive hooks only:
`CityVehicles` (obstacle API), `GameRender::extraDraw`, `MilitaryRenderer::addInstance`, `GameContext::{walls,
territory}`, `Command::{path, wallType, gate}`, `Economy::setTerritoryRate`, `FortConfig` in `Config`, App (Q / E do
not turn the camera while a container is being placed).

**Walls.** A drawn leg of length L becomes n = round(L / 4) pieces of the approved 4 m straight (or gate) asset,
uniformly scaled by L / 4n (xz scale, deformed-prop path of `city.vert`; the collision footprint uses the same scale).
Nodes snap to existing joints (1.5 m) or the 1 m grid; a drag snaps its length to whole 4 m pieces (Ctrl: 1 m).
Joint asset per node: 1 piece end cap, 2 bent (> 8 deg) corner, 2 straight nothing, 3 T, 4+ X (tallest type wins);
every connected node also gets a square collision post. Validation samples each footprint every 0.5 m: inside the
window, no building / water / step > 0.6 m (base heights), no parked vehicle, no supply container, no overlap with
pieces / posts, joints >= 35 deg; the last 0.6 m of a piece may overlap a facade (walls butt against buildings).
Health per piece (`fort.wallHealth`). Pressure: `game_territory` counts live zombies in each piece's footprint plus
a one-cell ring; damage = (count - `pressureThreshold`) x `damagePerZombie` per s. A destroyed piece becomes rubble (the
piece dissolves, a flattened heap stays), dust FX, a noise event, a notice, and its obstacle is removed.

**Collision (zombies) and navigation (soldiers).** `CityVehicles::addObstacle / removeObstacle`: oriented boxes raised
to their absolute top height in the zombies' obstacle grid (`obst_` -> `simH_`) on top of the baked heights, kept
across window moves; add / remove mark only the rows they cover, uploaded with the next `update()` (event driven).
Zombies collide, flow around, pile up and climb corpse piles exactly as against any static height (sim_solve /
climb rules unchanged): 1.6 m lets piles get over, 2.4 m mostly stops them. Soldiers: `NavGrid::updateRows` over the
span of the rows `CityVehicles` uploaded that frame (`uploadedRuns()`), replacing the former global rebuild at most
once a second on vehicle changes; the only full rebuild left is on window moves. Containers are stamped when they
land and never removed.

**Gates (PROPOSED, GAME_DESIGN 5).** A gate piece is stamped like a wall (zombies blocked), counts as closed for
territory, and its passage cells (gate footprint minus wall / post cells) are lowered to the ground in the NavGrid
copy of the heights (`Fortifications::navHeights`), so soldiers path through it. The leaves open (visual) while a
soldier is within 5 m.

**Territory.** Rebuilt on events only (build, destroy, container landed): structures (pieces, posts,
landed containers) and environment-blocked cells (base height > street level + 0.9 m: buildings, water; cached per
world cell while the window covers them, so regions persist when it moves away) are rasterised into a world 1 m grid
over the structures' bounding box + 4 m; 4-connected flood from the border = outside; each remaining component that
touches a player structure and is >= `minRegionArea` is a region. Regions inherit id / state by majority overlap
(merge = worst state, split = parent's). Counts: the id grid (window cells: region slot + 1 | (piece + 1) << 12) is
uploaded through the frame's command buffer when the raster, the walls or the window change; every 3rd frame one
atomic per live agent; 3-slot readback, versioned (stale counts dropped). Regions the window does not cover keep
their last state. States: uncleared (count unknown or > 0), controlled (0 for `clearDelay` s), threatened (zombies in
a controlled region: income paused; after `lossTime` s back to uncleared), breached (the region opens: removed, notice).
Income: controlled m2 x `incomePerHectarePerMin` / 10,000, ledgered once a second as `TerritoryIncome`.

**Containers.** Bought as before; they now descend under two scaled cargo canopies (`fort.containerAltitude`,
`containerDescentSpeed`; touchdown dust + noise), usable and stamped as an obstacle on landing, never removed. The
placement check covers the body (6.1 x 2.5 m), so a container can sit flush against a wall line and plug a gap. Q / E /
mouse wheel rotate by 15 deg while placing, T by 90 deg.

**Tests.** Self-test *walls / territory* (23 checks, CPU). Scripts: `tests/game/b2_territory.txt`,
`tests/game/b2_gate.txt` (see their headers).

## 7. B1 owner feedback fixes (2026-11-27, PROPOSED; values UNAPPROVED in `config/balance.json`)

**Rooftop drops (`Deploy::plan`, `GameUI::pickGround`).** What was wrong: the pick ray started on a fixed y = 90 m plane
(towers rise to 147 m: a start inside a tower picked a point behind its roof); the roof rule demanded a 3.6 m square
flat within 0.3 m (parapets / roof fixtures refused most roofs: 4 of 290 probes near the default view were valid
rooftops); the canopy drift (3-7 m) was never checked against buildings (a soldier dropping next to a tower descended
through its facade), and narrow slots between towers counted as street. Now: the ray marches from the eye; a landing
spot is a walkable island cell with a 1.2 m footprint flat within 0.3 m and no wall / parapet > 1.5 m within 1.5 m;
a click near an edge / on a parapet snaps to the nearest landing spot on the SAME surface within 2.5 m (never below
it); squad members land on the same island only; landing height = surface at the final spot; enclosed spots (> 80 %
of 16 directions walled within 14 m: courtyards, gaps between towers) are refused; the descent drift is chosen so the
canopy path is clear of the height grid (else a vertical descent); committed root motion never moves a body off its
walkable surface. Test `tests/game/b1_rooftops.txt` (6 snipers on roofs 17-147 m, two through the UI pick).

**Reanimation (`Reanimation.{h,cpp}`, GAME_DESIGN 14c).** Dead -> random delay (8-20 s) -> rise (cross-fade from the
held death pose to standing, 1.6 s, weapon left on the ground as a `DroppedWeapon`, drawn by
`MilitaryRenderer::addDroppedWeapon`) -> soldier slot released -> one GPU walker via `HordeInterface::spawnZombie`
(`CrowdSim::requestSpawnZombie`: the existing spawn pass, one request per step; `forcedLook.w` = start health,
`forcedLook.z = 2` keeps a random facing) with the zombie-soldier look (`zombieSoldierLook`: beanie in olive as the
cap, open jacket in olive, olive trousers, black boots, torn sleeve, greener skin; zombie eyes and gait) and
health x 3. Kills pay through the normal kill ring. Limitation: the spawn pass only places agents on open ground, so a
soldier who died on a roof stays dead (roof agents: B3). Test `tests/game/b1_reanimation.txt`.

**Threat-driven soldier AI (`SoldierAI`, `game_contacts.comp`).** What was wrong: targets came from the coarse 6 m
field (the first 4 walkers that happened to be written per tile, 2-3 frames old), so soldiers aimed at a tile sample
and kept "locking an area" (a lock re-associated to any sample within 2.5 m, so it outlived the zombie); a moving
soldier only reacted to zombies within 5 m, at most 3 s, then ignored threats for 4 s ("reach the destination
first"); LOS was cast from 1.5 m so a parked car hid a zombie; squad mates spread over far candidates by slot index.
Now `game_contacts` also writes each soldier's 4 nearest live zombies within 24 m (exact positions + velocities of
the step, any height; tile rings over the field counts, empty tiles skipped, bounded scan) into a readback region;
`SoldierContact::nearPos/nearVel`. Every tick each soldier scores the visible ones (distance, closing speed, zombies on
a squad mate = mutual support), locks the ZOMBIE (exact lock follows the list entry nearest its predicted position;
gone from the list = dead -> dropped in 0.2 s), aims led by its velocity, switches when a threat is < 0.6 x the lock
distance. A visible zombie within 12 m (360 deg, 2 m eye) interrupts moves / formation / resupply; within 8 m it is
always fought, farther ones for at most moveStopMax s per stop, then the order resumes. Beyond 24 m the field is used
(snipers: isolated tiles and zombies near other soldiers first). F6 = AI debug overlay (target lines red = exact,
amber = field; state, ammo, stamina). Test `tests/game/b1_ai_threat.txt`.

**Stamina / pace.** Auto pace runs (sprint x1.15 when threatened, under attack or out of ammo), stamina drains while
running and recovers walking / standing; below 15 the soldier walks until 40; wounded soldiers walk (they fall
behind; the squad does not wait: B3 medics). Controls (PROPOSED, owner approval): RMB = auto, Shift + RMB = force run,
Ctrl / Alt + RMB = walk. Stamina shown as a thin line under each health bar. Test `tests/game/b1_stamina.txt`.

**Ammo runner.** Multi-soldier squads below `logistics.runnerTrigger` of their full load send ONE member (fewest
visible threats) to the nearest supply point; he collects his own need plus what his mates miss (at most
`runnerCarryMagazines` magazines, debited from the stock), returns and hands rounds to each mate (collect_ammo clip,
grab event = transfer). Others hold; a member goes himself only when completely dry and no runner is alive; a dead
runner is replaced. Rounds are conserved (supply decrease = soldiers' increase incl. the runner's load). Test
`tests/game/b1_runner.txt`.

**Misses explained and fixed.** In `b1_ai_threat` 50 of 76 rounds hit static geometry (parked cars between the
muzzle at 1.4 m and the target): soldiers now fire only along a clear firing line (they keep aiming otherwise), which
brought static hits to 8 of 38. Legless crawlers (prone) were shot at chest height and never hit (the zombie left in
the `b2_territory` compound): the nearest list carries the prone factor and the aim drops to 0.25 m. Spread: rifle
0.8 deg, MG 1.8 deg (was 1.5 / 3.0).

**Walls (B2).** A wall / container / low obstacle (<= 2.8 m) within 1.5 m in front of the shooter is fired over: the
round starts just past it, 0.3 m above its top (Combat::fire; the AI's firing-line check uses the same rule).
Squads inside an enclosed, uncleared region with nothing in sight walk toward the nearest zombie the field knows in
that region (bounded to it), then the leash returns them. Not done: choosing defensive positions behind walls.

**Ranges.** MG 55 m (dense close-mid), rifle 60 m (mid), sniper 220 m (accuracy 0.99, spread 0.12 deg, headshot 0.7,
noise radius 12 m).

**Rooftop sniper (stabilisation pass).** What was wrong: targets were accepted on line of sight from the 2 m eye, but
the round leaves the 1.4 m muzzle, so from a roof the roof edge / parapet blocked the shot; the clear-firing-line check
then held fire, and the lock never dropped (its age is reset by every field re-association), so the sniper aimed at an
unshootable zombie for the rest of the run (b1_sniper: 1 shot in 45 s). Now: `SoldierAI::shotClear` (muzzle 1.4 m,
0.5 m forward, low cover within 1.5 m fired over: the same rule as `Combat::fire`) is used for the sniper's target
choice and for every soldier's firing-line check; a lock without a clear line for `blockedDrop` (1 s) is dropped
(`TargetLock::blocked`). Vantage cells: per roof (NavGrid island + height + window origin, cached) the roof-edge cells
within 50 m (2 m spacing) are scored by 24 sampled rays out to the weapon range (one march per ray against the height
grid, counting street samples whose aim point clears every earlier occluder = what `lineOfSight` would accept). On
landing / when idle with nothing shootable (every 3 s) the sniper walks to the vantage that can shoot the most zombies
the coarse field knows within range (isolated ones first; exact firing-line count for the 64 vantages best covering
their bearings), or with none known to the vantage overlooking the most street, and settles exactly on its cell (a
steep shot clears the edge only from right there). Perception keeps scanning the field (every 3 ticks) with the
firing-line test. Result: b1_sniper wave 2 (32 singles on rings of 70-190 m, some hidden behind other blocks): ~7 kills
per minute, no crowd drawn (noise radius 12 m). Test `tests/game/b1_sniper.txt`.

**Owner feedback round 3 (targeting, cars, gates, rooftop ammo, stepped roofs).**
What was wrong: (1) the soldiers' firing-line check marched the soldiers' walk grid, where gate cells are LOWERED
(soldiers pass gates), but the GPU stops rounds at the zombies' grid where a gate is a 2.4 m wall: an MG squad next to a
gate saw a "clear" line to the zombies pressing on it and poured rounds into the gate, and because those zombies were
the nearest (score = distance - closing speed) it never switched to a group approaching along the street. Only the 4
nearest zombies were scored at all (the field was only read when no exact threat existed), so a group behind the 4
nearest was invisible to the choice. (2) A zombie wedged between parked cars: torso line blocked by the car next to it
(1.1 m aim), the lock was dropped after 1 s of no clear line, re-acquired from the 2 m eye (visible), dropped again:
never a shot. The CPU check also skipped 0.6 m at the target end while the GPU does not (a car cell right at the zombie
stopped rounds the CPU thought clear). (3) Crates: `canAirdrop` demanded a 1.6 m footprint flat within 0.35 m exactly
at the clicked point (roof gravel / parapet steps of 0.75 m refused almost every roof, even curbs), and the 4 m landing
scatter accepted the street below a roof. (4) Stepped roofs: off-grid recovery in `steer` let a soldier standing on a
non-walkable rim cell step onto ANY walkable neighbour, including the street 16 m below or another roof level.
Now:
* `NavGrid` keeps a shot layer = the zombies' static grid (`setShotHeights` / `updateShotRows`, fed by GameWorld /
  `Fortifications::patchNav`): gates and walls block rounds for the CPU exactly as on the GPU. `NavGrid::shotLine`
  marches it like `game_hits.comp` (to 0.35 m short of the aim point), and both treat a static cell less than 0.3 m
  above the ray within 2.5 m in front of the target as PARTIAL COVER (car roofs are stamped as full boxes): the round
  goes on and counts only if it hits a zombie within those 2.5 m (`GRAZE`, `COVER_REACH`).
* `SoldierAI::aimFor`: torso (1.1 m) first, else the head (1.55 m) over the car roof, crawlers low; the chosen height
  travels in `TargetLock::aimY` to `Combat::fire`. Combat's fire-over-cover rule reads the shot layer too.
* Target utility (`SoldierAI::scoreTarget`, documented in the code): proximity 10 x (1 - d / acquireRange) (snipers 4 x),
  approach + 5 x min(closing / 2, 1.5) + 4 x (1 - eta / 8 s), on a soldier (any squad, buddyRadius) + 8, within
  mustFight + 3, CANNOT REACH (an obstacle > 0.6 m right ahead of it toward us, 2.4 m wide: gate, wall, car wedge)
  x 0.3, density (zombies in its 6 m tile) MG + 1.2 each (max 5), rifle + 0.3; sniper beyond 12 m + 3 alone / - 1 per
  neighbour; overkill - 3 per squad mate already locked on it. Candidates = the exact nearest list every tick + on
  perception ticks (and whenever there is no lock) the 8 nearest coarse-field samples out to 60 m that are not in the
  exact list (snipers: their isolated-target search over the weapon range). Only HITTABLE candidates (clear firing
  line now, in weapon range) are locked. Re-evaluated every tick: the lock is kept unless a hittable candidate beats
  its score by switchMargin 2; an unhittable lock gives way at once. Threat stops of moving / resupplying soldiers
  only fire for hittable zombies that can reach them.
* Sidestep: a soldier with zombies in sight within 20 m but none shootable steps up to 2.6 m aside (walkable, same
  island, within the leash of his slot, a clear line to the most urgent one), at most every 2.5 s.
* Crates (`Logistics::airdropSpot`): the clicked surface (street or any roof level), snapped within 2.5 m to a flat 1.2 m
  spot on that level with a walkable access cell; the scatter stays on that level and island; small roofs get the
  nearest walkable cell as the access slot. Rooftop soldiers find it through `findNearest` (same island) as before:
  snipers resupply themselves, multi-soldier squads send their runner.
* Stepped roofs: placement already tests the clicked level (spot snapping and member landing within 0.4 m of the
  clicked surface, same island); recovery steps in `steer` now stay on the same level (< 0.6 m).
Tests: `b3_ai_gate.txt`, `b3_ai_cars.txt`, `b3_roof_crate.txt`, `b3_roof_levels.txt`, `b3_ai_survival.txt`
(script metrics `static_pct`, `switches`, `sidesteps`, squad fields `switches` / `rounds`).
Results (lavapipe, heavily loaded host): `b3_roof_levels` 17 / 17 (snipers on the 16.7 / 17.45 m podium, the 137.45 m
ring and the 147.45 m top of one tower, plus a UI-pick drop on the podium; all still on their level after 75 s);
`b3_roof_crate` 10 / 10 (crates land on the 17.4 m and 147.4 m roofs, each dry sniper collects 45 rounds);
`b3_ai_cars` the 3 zombies in the gap between the car rows were dead 12 s after appearing (3 kills, 20 rounds, no
losses; the run was cut by the host before the final expects). `b3_ai_gate` / `b3_ai_survival` thresholds are first
guesses: both runs crashed in the Vulkan driver (segfault at the same address as concurrent `build/ttz` runs of
other scripts) before their checks.

### 7.x Owner round 15, WS D: engineer / flamethrower autonomy, dead locks (PROPOSED; values UNAPPROVED)

- **Engineers** (`EngineerAI`): player jobs (queue order, construction radius) always come first. With none in range an
  idle squad takes autonomous jobs within `EngineerAI::autoLeash` (20 m) of its post only: repair a damaged wall / gate
  piece (hp < 90 %, then kept until full; pressed / losing hp first) or structure (Structures repair jobs), most urgent
  first with hysteresis (+0.5) so it does not flip between similar jobs; with nothing else, re-seal a remembered breach
  (blueprint, piece price charged). Any player order drops the jobs (squad serial). Status: `EngineerAI::status(squad)`
  ("auto: repairing wall (covered)", "building wall", ...); the HUD (WS-A) has to show it.
- **Cover (owner #12)**: zombies (horde field) within 25 m of the job -> one engineer keeps working (kept across ticks),
  the others get cover spots between the threat and him (his side, walkable, inside the leash) and fight.
  `SoldierAI::workFirstHook` -> `EngineerAI::keepWorking`: the worker only fights a zombie within 6 m that is not behind
  a solid wall piece. A lone engineer works the same way.
- **Flamethrowers** (`FlameAI`): seek leash min(flame.seekRadius, `FlameAI::autoLeash` 25 m); the pile gassing friendly
  soldiers most (summed gas exposure) is picked first, then the best pile near the post; with no pile, a wall piece
  zombies are pressing within the leash -> the squad stands 3.5 m inside it and the normal engagement burns them.
  Friendly-fire guard unchanged (`FlameAI::spray`). Low fuel: the generic SoldierAI resupply. Status: `FlameAI::status`.
- **Dead locks (carry-over 3a)**: a kill report at a non-sniper's long-range (non-exact) lock (0.7 m) ends that lock at once (coarse /
  long-range locks followed the dead zombie's sample for a while); the next lock is no target switch. b5_long_range:
  rounds at dead locks 12 -> 0, shots 39 -> 22, hit rate 20.5 % -> 31.8 % (4 kills). Metric `rounds_at_dead` (Combat).

## 8. Milestone B3a: buildings (capture, garrison, hospital, fortification; GAME_DESIGN 6 / 7 / 14b; PROPOSED, values UNAPPROVED)

**Data (bake).** The baked tiles had no per-building data (buildings are merged into the tile mesh; HGT0 only flags
BUILDING cells). `bake.js` now writes an optional `BLDG` section per tile (FORMAT.md 3): one 140 B record per building
the tile owns (City Lab jobs: id, kind, floors, flat-roof flag, oriented footprint O / e1 / w / d tightened to the
building's quads above 2.2 m, ground / roof / top heights, up to 4 doors on the street facade). Backward compatible
(older readers skip the tag; older packages load no buildings). seed 1: 2,045 buildings (1,048 houses, 314 row houses,
425 mid-rises, 56 towers, 170 commercial, 32 other). Re-bake: `node tools/city_lab/bake/bake.js --seed=1 --scale=5
--out=assets/city/seed1` (13 min on 3 workers here); every other section is byte-identical to the previous bake.

**Registry (`Buildings.{h,cpp}`, shared with B3b).** `BuildingRegistry` parses BLDG when the simulation window covers
a tile (`syncBuildings`, on init and window moves: the tile is decoded once) and `prepare`s each building whose
footprint the window's height grid covers: doors (y from the street), windows on floors 1..`windowFloors` (single-storey
houses: ground floor) of every facade where the air 2.3 m outside is at least 1 m below the sill (party walls and
neighbours rejected), roof-edge positions (flat roofs, 0.8 m in, over a drop of 2 m or more), a stair core and a roof
hatch. Firing positions are capped at `maxPositions` in priority order (front windows floor 1, 2, a few roof edges, upper
floors, side windows). Support (GAME_DESIGN 14b): towers (> 12 floors, 56 in seed 1) and mid-rises over `maxFloors`
(9), buildings whose door does not open onto walkable ground, footprints under 4 m and buildings without any open
facade are unsupported, with the reason in the panel and in `blist` (default window: 46 of 327 supported, most
refusals are towers / blocked entrances; suburbs near (-245, 452): 29 of 31). Queries: 16 m buckets (`at`, `nearest`,
`inRect`, `nearestEntrance`), barricade state + `damageBarricade` (B3b breach), zombie counts (`setZombieCounts`, B3b),
`packOpenings` (GPU export).

**Gameplay (`BuildingPlay.{h,cpp}`, CPU, in the game core).**
- *Capture (PROPOSED):* a live soldier within `captureRadius` (7 m) of a door, or inside the footprint, and no zombie
  within `doorClearRadius` (6 m) of a door in his exact nearest list, and no zombie inside (B3b counts; -1 = unknown is
  not blocking): progress for `captureTime` (5 s) -> Captured. Zombies at the door / inside: Contested (progress
  paused); nobody there: progress decays at half rate. A captured building stays captured; zombies inside show a "!"
  warning on its tag.
- *Roles:* Garrison ($150) or Hospital ($250), UNAPPROVED; only on captured, supported buildings; nothing charged on a
  refusal. Changing the role releases the occupants.
- *Garrison:* the selected squads (G or the panel button) are assigned free firing positions; each soldier walks to a
  point beside the nearest door (normal NavGrid path, threats still interrupt), plays `enter_building` (new
  `AnimAction::EnterBuilding`, the approved clip) while moving into the doorway, then appears at his position
  (`SoldierPool::post` = POST_FIRING): windows 0.3 m inside the facade on his floor, roof edges on the roof, facing out
  within the firing arc (+-60 deg windows, +-80 deg roof). He is drawn there (interiors are never drawn), fights with
  the normal AI (targets, reloads) but never moves; sight lines and rounds start from `SoldierPool::firePos` (0.9 m
  outside the facade / past the roof edge), so his own building is not an occluder and the building still blocks
  shots behind him. An ammo stack (`garrisonAmmo` 600 rounds) refills idle soldiers one magazine per second. Not
  invulnerable: contact damage applies as anywhere (the contacts pass compares heights, so street zombies cannot hit a
  window soldier; B3b brings zombies to his floor / roof). A new player order to the squad releases its garrison
  through the door. Capacity = firing positions (<= 12).
- *Hospital (PROPOSED):* `SoldierAI::medicalSeek` (wounded, idle) -> the nearest captured hospital within 150 m with
  a free bed (4 beds incl. soldiers on the way); he walks (wounded pace) to the door, enters (clip), is hidden inside
  (not uploaded to the horde: patients are not zombie targets), heals `healRate` 6 hp/s, leaves at 95 % health and
  walks back to his squad's anchor. A squad order does not pull a patient out.
- *Fortification:* approved barricades (`barricade_door_*` / `barricade_window_*`: planks $30 / 300 hp, plate $80 /
  1,200 hp, sandbags $60 / 800 hp) on all doors or all open windows; window nests / roof rings (`fort_window_nest`,
  `fort_roof_ring`, $60 each) at firing positions scale the contact damage taken there by 0.6. Access: B3b's zombies
  batter barricaded doors on the GPU (`buildings.breachDps`); for buildings B3b does not simulate, a CPU fallback
  damages a barricaded door from the coarse zombie field. Broken barricades open the door and are not drawn.
- *Props / flags:* garrison: `garrison_flag` (olive chevron) on the roof's front corner (houses: beside the front door),
  `garrison_banner` on the front facade, `garrison_ammo_stack` by the roof hatch, `garrison_antenna`,
  `garrison_roof_position` at occupied roof edges; hospital: `hospital_flag` (green cross on white), banner,
  `hospital_awning` over the door, stretcher, cot and crate outside.
- *UI:* left click on a building (no squad under the cursor) selects it, keeping the squad selection; outline, doors,
  firing positions (green = occupied), panel (kind, floors, support reason, capture state, role buttons with prices,
  positions / beds, ammo stack, fortify buttons), capture bars and role tags over buildings; Esc deselects.

**Tick order.** `preAi` (releases on new orders) before SoldierAI; `tick` (pending UI / script actions, capture,
approach -> entering -> posted, pinning, ammo stack, hospital, breach fallback) after the animator; `pre/postCombat`
around Combat (nests). Shared-file changes (additive): `SoldierPool::{post, building, postOut, firePos}`,
`AnimAction::EnterBuilding`, `SoldierAI` (posted soldiers do not steer, skip leash / resupply / hunts / medical; LOS
and firing lines from `firePos`; entering / inside soldiers skipped), `Combat::fire` (origin at `firePos`),
`GameRender` (patients hidden), `GameUI` (building hooks), `BalanceConfig::buildings`, `TileCPU::bldg`.

**Tests.** `tests/game/b3a_garrison.txt` (mid-rise: capture, refused role before capture, garrison price, 5 soldiers
enter and take 2 window + 3 roof positions above the ground floor, nests + barricade, ~220 rounds and ~50 kills from
the posts in 36 s, ledger / dedupe, release on a move order), `tests/game/b3a_house.txt` (2-storey house: 4 first-floor
window positions, capacity 4, firing from the windows), `tests/game/b3a_hospital.txt` (contested capture while zombies
are inside, hospital, two wounded soldiers admitted, healed and discharged back to the squad, door / window barricades,
breach). Screenshots: see the B3a report.

**Known limits.** Door positions along the facade are approximate (front facade, evenly spaced); windows are derived,
not read from the facade art (a position can sit on a pier); roof-edge positions ignore parapet height (shots clear it
from `firePos`); interiors are not navigable for soldiers (they teleport from the door to the position after the clip);
hospital patients are invisible and untouchable; one stair core per building; towers are unsupported.

**Window posts and roof posts (GAME_DESIGN 14e, 2026-11-28).**
- *Real windows:* `BuildingRegistry::addTile` now also reads the facade art: every vertical glass quad (palette
  `MAT_GLASS`, `setGlassMaterials`) of the tile's LOD0 mesh is mapped to the facade of the building whose footprint edge
  it lies on, and panes of one window (mullions, transoms) are merged into `Building::glass` rects (facade side, span,
  height, glass-plane inset). `prepare` builds window posts from these rects (floors 1..`windowFloors`; shop / curtain
  glazing split into 1.6 m panels; at most one post per 0.75 x `windowSpacing`; a facade without glass gets no window
  post). Packages without glass fall back to the derived spacing. Each window post stores the opening (`win`,
  `winHalfW`, `winH`), the room behind it (`roomHalfW` up to half the distance to the next post, `roomDepth` 1.2-2.4 m,
  `roomFloor` = the soldier's feet with the sill at most 1.15 m above them, `roomCeil` under the next storey) and
  `outReach` (the soldier stands 0.55 m behind the glass; `postOut` is scaled so `firePos` stays 0.6 m outside the
  footprint: his building never blocks his sight lines).
- *Opened windows (render, `BuildingGame.cpp`):* a window is open while a posted soldier stands at it (more soldiers,
  more open windows; leaving soldiers close it). The facade mesh is unchanged: `CityRenderer::setCutouts` (<= 64
  oriented boxes, fragment uniform slot 1 of `city.frag`, tiles only) discards the tile fragments inside the opening,
  and one rebuilt-on-change mesh draws the rooms behind them (reveal lining the opening, floor boards, plaster walls
  with dado / skirting, ceiling and lamp, ammo crate, a sandbag sill or low sandbag wall unless a window nest stands
  there) with interior palette ids 240-251 (`CityRenderer::kInteriorMat`: dark, fake-AO shades by day, warm steady glow
  at night). At night the 4 rooms nearest the camera add a warm point light (Renderer extension). Window nests stand on
  the room floor behind the reveal.
- *Garrison order:* `BuildingPlay::pickSlot` takes the free position with the best score: list priority, a bonus for
  facades facing zombies (coarse field, 60 m) and for distance from posts already taken (spread over the facades).
- *Roof posts:* set back from the real roof edge (found along the line: the footprint can include awnings), the soldier
  1.6-3 m in, slid up to 2.25 m along the edge until the U position (2.6 x 1.9 m) stands on a flat patch of roof
  (heights within -0.35 / +0.3 m: no HVAC, hatch, parapet), away from the flag / antenna / ammo stack and other posts;
  roof levels up to 3.5 m above `roofY` accepted. `garrison_roof_position` in front of him (front sandbags ~1.3 m from
  the edge); with a nest, `fort_roof_ring` around him when the 3.6 m ring fits on flat roof too (`ringFits`), else the
  U position.
- *Limits:* the facade is not cut in the key-light shadow map (rooms are lit by ambient / interior light only); the
  cut uses the glass rect, so frames in front of the glass stay; LOD2 tiles (> 420 m) show the room behind a blocky
  facade; at most 64 opened windows are cut per frame.

**Owner round 15 (WS-C, 2026-11-28): every building, door leaves, window covers, defence levels.** Supersedes the
support rules above.
- *Support:* no refusal path is left (towers, > `maxFloors`, no / blocked door, small footprints, no open facade):
  `prepare` sets `supported` for every prepared building (`maxFloors` is no longer read). Tall buildings get window
  posts on floors 1..`windowFloors` plus roof posts (flat roofs). Downtown window (camera (24, 93), R 120): 40 of 40
  supported; suburbs near (-245, 452): 42 of 42.
- *Doors:* `readGlass` also collects door leaves of the facade art (`setDoorMaterials`: palette names DOOR_*, WOOD,
  SHUTTER_*, BRONZE, not BENCH_*; vertical rects 1.6-3.8 m tall, 0.6-4 m wide, from the ground / stoop) into
  `Building::doorArt`. Each bake door is snapped onto the nearest leaf of its facade (plane, centre, width, height;
  `Opening::art`); doors with no walkable street 1.5 / 3 m past the footprint edge are dropped; with none left an
  entrance is added (`doorAdded`): an art door with a street in front, else the first facade point (front, right, back,
  left) with open street, else the front middle.
- *Posts on every facade:* window posts are ordered round-robin over the facades (prio = rank on the facade x 8 + floor
  x 2 + side) so the `maxPositions` cap keeps posts on every facade with usable glass. A window is skipped when the view
  out is blocked: the old 2.3 m height test plus a ray 1-4 m out that hits another building's footprint higher than the
  sill. With no post from the art, derived windows are used (fallback: front facade regardless).
- *Window covers:* `Building::covers` = the glass rects of the ground and first floor split into <= 1.8 m panels, minus
  every panel overlapping a firing window of the same floor / facade and every door leaf. "Window planks / plates" and
  the defence levels set `coverType`; the renderer scales the approved `barricade_window_*` (L3 ground floor:
  `fort_steel_plate`) to the panel, back face 1 cm in front of the glass. Covers are visual + cost only (zombies never use
  windows); firing windows are never covered.
- *Door barricades:* the approved `barricade_door_*` prop is scaled to the door leaf (width + 4 cm, height + 3 cm) and
  placed 1 cm in front of it (the old prop stood at the bake position on the footprint edge, often under a canopy out on
  the pavement: the "black blob").
- *Defence levels (`BuildingPlay::fortify`, `bfortify`, panel button; prices UNAPPROVED = sum of the existing
  barricade / nest prices; window covers at `windowCoverPrice` per building, not per panel):* L1 light-tan planks on
  the doors and the ground-floor covers; L2 grey plates there, two `garrison_roof_position` sandbag walls beside each
  entrance (doorway clear), sandbag positions at every roof post; L3 sandbags in the doors (health plate + sandbags),
  heavy steel plate on the ground-floor covers, light-tan planks on the first-floor covers (firing windows stay open), a
  perimeter of `fort_slit_wall` pieces 3 m out along every facade with an entrance (2.6 m gap on each door axis; no
  approved wire prop exists, so sandbags only), roof nests (`fort_roof_ring` where it fits, else the U position) at the
  roof posts. Tint (round 15 follow-up): the approved props are tinted at draw time only (kind-2 instance `pos.w = 4 +
  palette index`, shaders/city.vert; city.frag mixes 80 % toward it): 1 light tan (planks), 2 steel grey (plates); the
  asset files are unchanged. Planks sit 4 cm proud of the glass / leaf, plates 1.5 cm. Without a defence level, the
  "Window planks / plates" upgrade alone still covers both lower floors.
- *Test:* `tests/game/b6_garrison_all.txt` (mid-rise, 39-floor tower, 34-floor tower, house: support, posts on several
  facades, art doors, covers never on firing windows / above floor 1, a squad garrisons the 39-floor tower, L0-L3 on the
  mid-rise, the tower and the house with screenshots in `docs/review/ws-c/`).
- *Limits:* (the old 22-floor zombie-entry limit is lifted: 64-node slots, see section 9 / `b6_tall_vertical`); doors
  without an art leaf (most lobbies / towers: their doors are BRONZE / STEEL frames or glass) keep the bake position on
  the footprint edge; scaled props stretch the voxel grid a little (scale 0.5-1.5); the entrance sandbags / perimeter
  are not collision for soldiers or zombies and can overlap street furniture.

## 9. Milestone B3b: zombies in buildings (vertical warfare, GAME_DESIGN 7; PROPOSED, values UNAPPROVED)

Goal: no invulnerable position. Zombies enter accessible buildings, breach barricades, climb between floors through the
stair core, reach rooftops and attack soldiers there, without pretending the 2D height grid has interiors, without a
global navigation rebuild and without per-zombie CPU paths. Code: `src/game/HordeVertical.{h,cpp}`,
`shaders/game_vertical.comp`, small GAME_VERTICAL rules in `nav_relax` / `game_attract` / `sim_predict`, hooks in
`HordeBridge` (entrance attractors, interior attackers, flag), `GameWorld` wiring, `VerticalConfig` (`Config.h`,
`config/balance.json` `"vertical"`), script verbs `src/game/VerticalScript.cpp`, self-test `src/game/HordeVerticalTest.cpp`.
Building data comes from B3a's `BuildingRegistry` (`Buildings.h`: doors, roof hatch, stair core, floors, barricades).

**Model.** Zombies stay 2D agents on the street grid. A building is *active* while uploaded soldiers stand inside its
footprint or on its roof (B3a garrison posts included; hospital patients are not uploaded). Up to 32 active buildings
own a slot of 64 nodes in a GPU node table: doors 0-7, one node per floor 8-61 (stair core; node f = crossing to the
stairs on the ground floor, one flight above; buildings over 54 floors: one node per ceil(floors / 54) floors), roof
hatch 62 (was 32 nodes / 22 floors until the tall-tower fix). Per node: traverse time (door 1 s, ground floor =
door-to-stair distance / 1.1 m/s, 4.5 s per flight, hatch 1.5 s), capacity (door 3, flight 6, the soldiers' floor 60,
hatch 2), next node, barricade flag, defender damage, credited shooter. The target level is the lowest level holding
soldiers (floors before the roof); a slot is rebuilt (CPU, one 1.5 KB record) only when that building's soldier levels
or barricades change, and uploaded with its entrances (dirty flag; ~1 upload per state change, not per frame).

**Navigation (shared flow field, local rules only).** The street-side point (0.9 m out) of every door of an active
building is an extra attractor (`HordeBridge::setEntranceAttractors`): its reach is the awareness radius minus 0.5 x
the interior route (door -> stairs + 2 x floor height per storey), at least 80 % of it, so the horde streams to the
doors. With GAME_VERTICAL: the flow never runs up a wall taller than 4.5 m (`VERT_PILE_REACH`: low roofs keep the
existing corpse-pile climbing), a cell enclosed by solid cells is a plateau walkable at its lowest neighbour's level
(roofs are navigable for agents already up there; roof edges stay impassable from the street), attractors on roofs /
at windows seed only their own level (no crowd under a sniper's wall), and wanderers do not step off drops > 3 m.

**GPU passes** (`game_vertical.comp`, after `HordeBridge::postSim`, only on frames with sim steps):
1. *advance* (one thread per occupant, ping-pong lists of <= 4,096 x 32 B): timer += frame dt; defenders on the node's
   floor deal `defenderDps x soldiers` shared by the occupants there (kill -> the existing kill ring, cause Soldier,
   credited to a defender: rewards / seq dedupe unchanged); when the node's time is up, move to the next node if it
   has capacity (atomics on per-node occupancy: queues form on the stairs), batter a barricaded hatch (breach
   damage accumulates per node), stay on the target floor, or re-enter the agent list (`C_APPEND`, committed by the
   next step) on a free roof cell near the hatch (alert 15, same look / health / wounds).
2. *capture* (one 64-thread group per entrance, 5 x 5 cells): aware walkers / climbers within 1.2 m of the door point
   become occupants (atomic compare-swap to ST_DEAD without a corpse: the next sort drops them, they are not drawn)
   while the door node has capacity, otherwise they queue outside (visible crowd at the door). At a barricaded door
   they batter it instead: `buildings.breachDps` (4 hp/s per zombie, shared with B3a's fallback; at most 2 x the door
   capacity = 6 zombies at once, so sandbags 800 hp hold ~33 s) accumulates on the GPU; the CPU applies the deltas through `BuildingRegistry::damageBarricade` (B3a gets the BarricadeBroken report)
   and the door opens with the next upload.
3. *readback*: node state + totals (16.4 KB / frame, 3-slot ring, newest slot wins) -> per-building occupants per
   floor (`BuildingRegistry::setZombieCounts`: B3a's contested capture / warnings; B3a's CPU breach fallback stops for
   simulated buildings), barricade damage, interior attackers: occupants on a soldier's floor are added to his
   `SoldierContact::attackers` (<= 3 each, shared over the soldiers on that floor) -> the existing Combat contact
   damage. Roof fights need nothing new: roof zombies are ordinary agents (flow, collision with soldier capsules,
   `game_contacts` attackers / nearest lists, bullets, gore, corpses on the roof).
Buildings whose soldiers are gone for 2 s *drain*: every node leads down and out of door 0 (occupants reappear in the
street), then the slot is freed and `zombiesInside` returns to -1.

**Costs.** CPU per tick: soldiers x one registry lookup + active buildings (0.02-0.03 ms measured). GPU per frame: <= 256
entrance groups x 25 cells and one thread per occupant (no per-cell or per-agent pass; nav changes are per-cell
constant work inside the existing relaxation). Memory: nodes 48 KB, entrances 8 KB, state 16 KB, occupants 2 x 128 KB.

**Unsupported / limitations (documented, GAME_DESIGN 14b).**
- Buildings without a door in the registry (no BLDG record, entrance blocked): zombies cannot enter; low roofs
  (<= 4.5 m) are still reached by corpse piles, taller ones are safe from the horde: listed by `blist`
  (`HordeVertical::unsupportedWhy`). Tall buildings ARE entered (the old 22-floor graph limit is gone): a slot has
  64 nodes (doors 0-7, graph levels 8-61, hatch 62, 63 = rebuild signature), one level per floor up to 54 floors
  (every downtown tower, <= 39 floors); above that one level stands for ceil(floors / 54) floors of the stairwell
  (flight time scaled, counts reported on the level's lowest floor). Cost: 32 slots x 64 x (48 B node + 16 B state),
  128 KB on the GPU, 32 KB state readback per frame; no extra storage buffers (`tests/game/b6_tall_vertical.txt`).
- Flat roofs without a roof hatch: occupants stop on the top floor (they never reach the roof).
- Interiors are not drawn: occupants are invisible while inside (counts in the building panel / `vinfo`); window
  soldiers fighting occupants show only the damage. Zombies do not climb in through windows.
- At most 32 active buildings and 4,096 occupants (overflow: no capture, zombies wait outside; `vstat dropped`).
- One stair core per building (B3a data); every door leads to it. Window soldiers are not targeted from the street
  (their seed is inside the solid facade cell) except through the door route.
- Occupants keep their health / wounds but not limb-loss animation state inside; corpses of zombies killed inside are
  not placed (kill + reward only).
- A window move does not drop occupants (building-local); a hatch outside the window holds its occupants until the
  window covers it again.

**Tests.** Self-test section *vertical horde* (`TTZ_SELFTEST_VERTICAL=1` alone, `TTZ_SELFTEST_NO_VERTICAL=1` skips; 12 m,
4-floor test building in a 96 m arena): roof soldiers -> capture < 30 s, first on the roof 15-50 s after the capture
(graph minimum ~22 s), contact attackers on the roof soldiers, nobody climbs the facade; a 240 hp barricaded door
holds them until breached (no capture before), entry later than with an open door; no soldiers -> nobody enters;
soldiers on floor 2 -> occupants stop there, interior attackers, defenders kill (each kill exactly one kill event);
drain through the door once the soldiers leave. Script `tests/game/b3b_vertical.txt` (city, B3a's test building).

## 11. Corpse rot gas and flamethrowers (GAME_DESIGN 14d; mechanics APPROVED, values UNAPPROVED, squad size PROPOSED 2)

Files: `src/game/CorpseGas.{h,cpp}` (GPU module + CPU view), `CorpseGasRender.{h,cpp}` (draw, game binary only),
`FlameAI.{h,cpp}` (flamethrower behaviour), `CorpseGasTest.cpp` (self-test), shaders `game_gas_corpse.comp`,
`game_gas_field.comp`, `gas.vert` / `gas.frag`, `include/gas.glsl`; config `rot` / `flame` plus
`weapons|soldiers|squads.flamethrower` and `logistics.*Stock.fuel` in `config/balance.json`.

- **Data.** Per corpse slot an own `uvec4` (key = position hash, age, ignition, burn time): the 32 B corpse record stays
  unchanged; a reset / reused slot is detected by the key. The rot level (0..63) is mirrored into the corpse's free
  `info.z` bits 26..31 for renderers. Gas grid = 2 x 2 sim cells (1.5 m, 256 x 256 over the 384 m window), `uvec4`
  per cell (gas, ground-fire seconds, igniting soldier, corpse / rotting counts), ping-pong, shifted with the window.
- **Passes** (GameWorld::postSim, after the horde's field passes, sim time since the last update, <= ~30 Hz):
  corpse pass (indirect over `C_CORPSES`: age, rot emission ramping over `rot.ramp`, counts, ignition by flame cones /
  ground fire, burning, removal = alive bit cleared + negative height splat like `sim_corpse_blast`) -> field pass
  (diffusion with buildings as reflecting walls, emission, decay, fire burns gas off, ground fire ages, flame cones
  light the cells they cover; contained: fire never spreads). Zombie damage: `FlameAI::coneRays` queues 15 hit rays
  per spray over the cone (pattern rotating per spray, `flame.zombieDps` x spray time each, quiet flag) through
  HordeBridge's bullet path (credited: deaths, kill records, rewards, gore unchanged). A GPU pass writing the
  damage queue directly from the cones / ground fire crashed lavapipe in the city game right after flame kills (not
  in the arena self-test) and was removed. Ground fire (final stabilisation pass): `CorpseGas::groundFire` queues, once
  per readback, 4 knee-high hit rays across every burning cell (two along x, two along z, entering from alternating
  sides so the rounds' push cancels), `0.6 x flame.groundFireDps x dt` each, quiet, credited to the newest cone's
  shooter, through the same HordeBridge bullet path (self-test "ground fire kills zombies standing in it"; script
  metric `ground_fire_rays`). Packed readback (gas, fire, corpses, rotting per cell + stats), async ring of 3,
  every 0.25 s.
- **Gameplay.** `CorpseGas::tick` (after Combat): soldiers standing in gas above `rot.damageThreshold` lose
  `damagePerSecond x level` hp/s (capped), the squad gets `SQ_GAS` (green status pip, "in gas" in the selection
  panel, one notification). `NavGrid::setCostLayer`: cells above `rot.navAvoidLevel` cost extra in A* (avoided when a
  way around exists, never blocked; string pulling may still cut a corner through thin gas).
- **Flamethrower squad.** `SoldierClass::Flamethrower` / `SquadType::Flamethrower` / `AmmoType::Fuel` (tank =
  magazine, spare tanks = reserve; reload = tank swap; resupply = the generic path, fuel stock in containers / crates).
  Generic SoldierAI engages zombies at the 9 m weapon range; `Combat::fire` hands flamethrower rounds to
  `FlameAI::spray` (cone, fuel by spray time, FX, one loud noise per second). `FlameAI::tick` (after SoldierAI): an idle
  squad seeks the best pile / rotting gas source within `flame.seekRadius` of its post (the player's last order point),
  walks to a stand-off point (its own move order), sprays the pile with a sweep until no corpse is left (readback) or a
  timeout, then returns; a player order onto a pile burns that pile. Never sprays with a soldier inside the cone.
- **Approved assets** (owner, final pass): `assets/military/specialists.{json,ttzm}` (engineer_a..c, flamer_a..b, six
  tools, sandbag pile) + `specialist_anims.{json,bin}` are loaded by `MilitaryLibrary::load` after the infantry
  (`loadAnims(dir, "specialist_anims")` appends; tools / site models become props, `toolModels[toolId]`). Flamethrower
  squads use the "flamer" variants (`timingFromLibrary`; the rifleman placeholder `FlameAI::usePlaceholderAssets` only
  when they are missing). Pile burning plays `ignite` -> `burn_ground` -> `stop` (FlameAI, per-soldier edge), zombie
  engagement the generic `fire`. The hose is procedural (`MilitaryRenderer::addHose`: a sagging chain of 4.5 cm voxels
  from the manifest's torso point to the gun's hose point, LOD0/1). The flame FX starts at the flamer's nozzle
  (weapon muzzle point).
- **Flame look** (owner feedback x3: "like the explosions, voxel-based, not particles", then "one continuous tongue",
  then the Lab v4 spec, docs/MILITARY_ANIMS.md 7.5 / `fx.flame_tongue`): the jet and the ground fire are fx volumes in
  the explosions' path (`shaders/include/fx_volume*.glsl`: DDA through the world voxel grid, half-res + exact-edge
  composite, shared 24-volume list and screen budget). Kind 2 = jet: nozzle, yaw / pitch in `fxC.zw`, visual reach
  0.85 x weapon range; 5 cm voxels up close (0.1 / 0.25 m with distance), walk limited to a thin cylinder around the
  path (+ the smoke box above the tip) so the cost stays bounded; v4 rope radius `0.035 + 0.205 k^1.4 + 0.06 tip`
  (<= 0.3 m), ballistic droop, kept >= 0.6 r above the ground; core (sr <= 0.6) always filled, edge noise only
  (calm at the nozzle, licking at the tip); v4 colour ramp white -> yellow -> yellow-orange -> orange (HDR gain, face
  shading top 1 / sides 0.78-0.86 / bottom 0.62), red-orange only on a flickering 30 % of the tip fringe; light grey
  smoke only 0.3 m above the tip, thin, rising with the wind. Kind 3 = pool: at the jet's impact point (r 0.5 m) and
  over burning gas cells (clustered within 2.6 m): disc, flame height 0.55 m x (1 - d) x flicker, yellow base ->
  orange tips (ramp capped 0.78), bed always filled, no smoke column. Warm flickering point lights along each jet and
  at its impact (`CorpseGasRender::flameLights`, App light list). `Renderer::setFlameVolumes` (`FlameVolume` in
  `sim/Sandbox.h`), fed per frame from the FxKind::Flame events (sim time: fade in 0.12 s / out 0.3 s, reach grows over
  0.2 s; at most 6 jets + 6 pools nearest the camera). Not yet: the sweep does not bend the jet (one direction per
  volume; a direction history would need two more uniforms), corpse char tint / ash decal.
- **Rendering.** One indirect instanced draw of the listed gas cells, 9 voxel boxes each: translucent low haze slab
  (0.25 m height steps, alpha <= 0.42, destination alpha kept for the DOF), sparse rising puffs, flies over rotting
  bodies, a sparse ember over ground fire (the fire itself: fx volumes above). Corpse colour itself is unchanged (rendering agent: rot level is in info.z).
- **Tests.** Self-test section *corpse gas / flamethrowers* (`TTZ_SELFTEST_GAS=1` stops after it, `TTZ_SELFTEST_NO_GAS`
  skips): squad / class / fuel type, fuel per spray time, friendly-fire block, fuel resupply conserved, no gas before
  the rot delay and gas after it, spread grows, soldier in gas loses health + SQ_GAS (outside: none), a sprayed pile
  burns away (list and height field), gas decays after, flame kills zombies with credit. Script
  `tests/game/b4_gas_flame.txt` (verbs `corpses N X Z [R]`, test hook `rot DELAY [RAMP]`; metrics `gas_max`,
  `gas_cells`, `rotting`, `burned`, `corpses_window`, `gas_damage`, `flame_sprays`, `flame_trips`, `fuel_used`).

### 11.1 Owner feedback 2026-11-28 (GAME_DESIGN 14e): tracers, long-range aim, gas look, flamethrowers

- **Tracers** (`src/lab/TracerMotion.h`, `MilitaryRenderer::fxTracer / updateFx`): 600 m/s (sniper 720; was 750 / 900),
  4.5 m tail (was 9), ~1.2 px minimum width at 1080p (sniper 1 px; was ~3.7 px), 2 / 1.5 cm up close. A tracer is drawn
  on the frame its shot event spawns it at age 0 (head 1.2 m past the muzzle, tail at the muzzle) and its per-frame
  age step is capped so the head takes >= 6 frames from muzzle to target at any frame rate (a 60 m shot at 30 fps was
  2 frames: seen only near its end). Self-test "tracer: head at the muzzle at t = 0 ...".
- **Long-range aim** ("far zombies take 10 shots / the kill does not register"). Causes: beyond the 24 m exact list
  the lock is a coarse field sample (4 arbitrary walkers per 6 m tile, re-associated every refresh, velocity 0: rounds
  spread over a group, no lead); rounds were uniform over the spread cap (most near the rim: 33 % body hits at 50 m
  with perfect aim); the hit ray ended at the 2D weapon range (roof / window shots at a target near range stopped
  short in 3D). Fixes: *lock query* - `HordeSoldier::lockPos` (16-bit offsets in GameSolid word 7) -> `game_contacts`
  returns the exact live zombie within 2 m of it (`SoldierContact::lock*`, near stride 10 vec4) -> SoldierAI follows it
  with its velocity (metric `lock_tracked`); `Combat::spreadDir` angle ~ |N(0, cone / 2)| clamped to the cone (~66 % at
  50 m, ~59 % at 60 m); ray length max(range, aim distance + 2 m). Tests: self-test "long range: ..." (GPU: lock
  answered exactly; 200 rifle rounds at 50 / 60 m hit 68 / 66 %), script `tests/game/b5_long_range.txt`.
- **Gas look**: the per-cell haze slab (the "grid") is gone. `gas.vert` boxes 0..4 are drifting voxel puffs (0.375-1.25 m
  in 0.125 m steps, more and bigger with the gas level, slow swirl + rise + fade, spread over +-0.9 cell so cells overlap,
  yellow-green with a glow, alpha <= 0.24 each), 5..7 flies, 8 ember.
- **Flamethrowers** (`FlameAI`): sustained bursts of 2.2-3.6 s (kept while bodies at the pile are unlit, max 3.6 s),
  sweeping across (+-1.3 m) and along (+-0.7 m) the pile, 1.2 s pause, then again while bodies are left and the pile
  is not burning; a burst at zombies continues 2 s after the target fell. Stand-off spot (`pickStand`): 16 directions x
  3 distances, walkable on the squad's island, street level with the pile, spray line may cross cars / low walls
  (<= 1.9 m above the ground) but not buildings. Ground under a pile = lowest walkable surface within 1.5 m (the nav
  heights carry cars / walls: piles next to a wall were skipped as "roof"). Over a car the drawn jet arcs (FX direction
  lifted, cone unchanged). **Puddles** (`CorpseGasRender`): on the ground without vehicles (`CityVehicles::groundAt`,
  was the coarse 4 m max height incl. cars), centre moved off cars / walls, radius stops short of them, shrinks as the
  cell's fire burns down; `poolDensity` v5: separate flickering licking tongues, wobbling outline, embers on a dying bed,
  thin smoke wisps. **Light**: one flickering light per drawn puddle for its whole life (it used to come only from the
  jet's impact and stopped with the spray), flame lights first in the 8-light fire budget (burning cars crowded them
  out). Script `tests/game/b5_flame_obstacles.txt` (verb `corpsespot wall|cars N X Z`; metrics `fire_pools`,
  `fire_lights`, `fire_pools_on_cars`).

## 12. Engineers, construction jobs, wall placement 2.0, single gates, car clearing (GAME_DESIGN 14d; squad APPROVED, rules PROPOSED, values UNAPPROVED)

**Modules.** `EngineerAI.*` (new: construction radius, job queue, assignment, work, car orders), `Walls` (blueprints,
split pieces, auto-fill pieces, single-gate planning, loop closure, facade trimming), `Fortify` (charges, obstacles of
finished pieces only, undo, drawing of blueprints / basket rows), `FortUI.cpp` (tools, guides, rings, progress),
`FortScript.cpp` (verbs / metrics), `CityVehicles` (parked-vehicle pick + removal). Shared files got additive hooks only:
`SquadType::Engineer` (= 4; riflemen by class: `Config` pairs squad types with classes through `kSquadCls`),
`EngineerConfig` (`balance.json` "engineers"), `GameContext::engineers`, `Command::{BuildGate, ClearCar, UndoBuild}`,
`SoldierAI::workHook` (one call in the Idle branch), `DeployTiming::engineerVariants`,
`MilitaryLibrary::addEngineerPlaceholder`, `Vehicle::removed` (+ one skip in `CityRenderer`), `Tool::{BuyEngineer, ClearCar}`.

**Construction radius.** Orders (walls, gates, gates into walls, car clearing) are accepted only within
`engineers.radius` (40 m, UNAPPROVED) of an engineer squad: its post (anchor = last order destination) or, before the
first order, its members' centroid. `WallEnv::buildable` carries the rule into planning (per piece: "outside engineer
range"). `EngineerAI::instantBuild` (script `cheat build 1`) is the debug / test cheat: anywhere, built at once. B2 / B3
scripts that are not about engineers use it.

**Jobs.** Derived from the world every tick (never out of sync): every blueprint (`WallPiece::build < 1`), every wall
piece being converted into a gate (`toGate`), every car order. Order: cars first, then placements in placement order. A
blueprint overlapping a car being cleared waits ("waits for the car"). Each engineer squad takes the first free job
within its radius (several squads share the queue; with nothing free they help). Members get work spots beside the job
(the squad's side, spread along it, snapped walkable); EngineerAI sets them as their home, so SoldierAI's leash walks
them there and threats still come first (engineers are riflemen). At the spot (`workRange`), `work()` adds
`dt / time` per engineer (`pieceTime` per 4 m piece pro rata 30..120 %, `gateTime`, `carTime`; engineer-seconds:
3 engineers are 3x as fast) and `postAi()` requests the work loop (collect_ammo, PLACEHOLDER). A player move order drops
the squad's jobs; it picks jobs up again within the radius of its new post.

**Blueprints.** Committed pieces start at build 0: no collision, no territory, no joint post, no pressure; they already
count for placement (no overlaps) and snapping. When finished (`Walls::advance`) the piece becomes solid: obstacle
stamped, posts (nodes count `solidDeg`), territory, rise animation. Drawn translucent, growing with progress; progress
bars and waiting reasons above them. **Undo** (Ctrl+Z, `CommandType::UndoBuild`): the newest placement with unfinished
parts loses those parts (finished pieces stay) and they are refunded at the price charged.

**Placement 2.0.** Snapping: joint (1.5 m) > a point ON an existing piece (1.2 m, 0.5 m steps, >= 1 m from its ends; the
piece is split there on commit, T post) > drag length (4 m pieces; Ctrl 1 m) > 1 m grid. Direction: Shift = 15 deg
steps, otherwise 0 / 45 / 90 deg snap magnetically within 4 deg, relative to the previous leg / the wall the leg starts
on / the world axes. Legs: whole 4 m pieces plus an auto-fill end piece (remainder >= 2.5 m: its own piece; 1..2.5 m:
the last 4 m shares it, two pieces of 2.5..3 m; < 1 m: the 4 m pieces stretch); price pro rata (min 25 %). Pieces under
3.5 m are drawn as a row of 1 m gabion baskets (approved joint asset), never as a squashed 4 m piece. Walls butt
against facades: an end clicked inside a building is pulled back to 0.4 m into the facade. Per-piece conflicts with
their own reason (building / water, kerb or step, vehicle, container, wall, joint, angle, range, too short); pieces
through a car being cleared are amber ("after the car is cleared"); pieces that connect two already connected joints
are outlined cyan ("closes the loop"). Guides: 1 m grid around the cursor, dashed extension of the leg, length / angle
readout, engineer radius rings.

**Single gates (J).** One 4 m gate at the cursor, rotated with Q / E / wheel (15 deg) / T (90 deg). Over a wall piece
(1.5 m) it aligns to it and replaces that part (the piece is split around it; pieces up to 5.5 m are replaced whole;
no slivers under 1 m next to a joint); the engineers convert it (gateTime) while the wall keeps standing. An end within
1.2 m of a joint snaps there (both ends: between the two joints). Next to a wall end (2.5 m) it continues that wall.
Otherwise it stands on its own with end posts.

**Car clearing (K).** Click a parked vehicle within the radius (charged `carPrice`); engineers work beside it
(`carTime`); then `CityVehicles::removeVehicle`: not drawn (custom list skip), never simulated, its baked footprint
becomes ground, its cells re-uploaded (zombies, NavGrid patch), kept across window moves (`removed` per vehicle).

**Containers (owner issue 3).** The shots in the feedback set show a floating building block (city bake overhang, not
a container). Changes made on the container side: the descent is straight down onto the placed spot (unchanged), the
collapsing canopies now fall to the side away from walls (or fold straight down onto the roof when walls are on both
sides) instead of draping over / through an adjacent wall; containers may still be placed flush inside a compound.
Final pass (owner bug): the `container_supply` apron part (sandbags / barriers) is no longer drawn during the descent;
it rises out of the ground in 0.6 s after touchdown (`Fortifications::draw`, `putProp` skip / only part). Collision and
obstacle stamping are unchanged.

**Engineer look.** APPROVED assets (class "engineer", `specialists.json`): `engineerVariants` uses them; the placeholder
(`addEngineerPlaceholder`) is only built when they are missing. Work loops (`EngineerAI::postAi`): wall pieces ->
`build_shovel` / `build_sandbag` / `build_hammer` by member, gates -> `build_hammer`, cars -> `cut_car` / `pry_car`
by member. Held tools: body flags bits 8..11 select the tool model, drawn at the right hand with the clip's mount
channels (dropped tools follow the death clip's weapon track); the carbine goes to `stowMount` while a tool is held
(bit 12). Not yet: `death_tool_<tool>` clips when an engineer dies holding a tool (death_a plays), `carry_*` clips.

**Tests.** `tests/game/b4_engineers.txt` (no engineers -> refused, radius, blueprints, queue, undo + refund, build loop,
mid-piece T split), `tests/game/b4_gate_car.txt` (gate into a wall, gates onto joints, territory closed by gates, soldiers
pass, car clearing, a wall planned through the car built after it). B2 scripts run with `cheat build 1`.

**12b. Owner feedback 2026-11-28 (GAME_DESIGN 14e): sealed walls, finer grid, engineer awareness, car gaps, ring.**
- *Sealing* (`Walls::plan`): a free end of a run inside a building, or within `kSealReach` 1.6 m in front of a facade
  / supply container / wall piece along the run, is moved onto it: `kSealDepth` 0.35 m into the facade (the exact BLDG
  record footprint via `WallEnv::facadeRay` when one is within 1.2 m of the height grid's facade, else 0.3 m behind the
  grid edge, which over-covers buildings) or container; onto the wall's axis (T split, or its joint within 1 m); a wall
  joint within 1 m of a free end is snapped to. The sealed end may overlap what it was sealed onto (`allowFront /
  allowBack`), the filler piece goes to the free end. No zombie-passable / territory cell stays between them.
- *Finer grid*: 0.5 m snapping (`Walls::kGrid`; Ctrl drag 0.5 m steps, angle snap lengths 0.5 m); a leg is whole 4 m
  pieces + one filler of the remainder (>= 0.5 m; less stretches the 4 m pieces). Fillers render as full-size gabion
  baskets (0.86 .. 1.12 scale, overlapping neighbours, alternate baskets inset 1.5 % against z-fighting).
- *Soldier walk grid* (`Fortifications::navRows`, `NavGrid::setMask`): bit 0 = gameplay obstacle (walls, posts,
  containers, moving vehicles, parked-vehicle cells whose centre is inside the car's real oriented box + 0.12 m):
  never walkable, so cars + walls never form a walkable roof network. Parked-vehicle cells outside the real box (the
  zombies' footprint rounded out to whole 0.75 m cells) are ground for soldiers: they use the real gaps between cars
  (a gap of ~0.9 m and more is reliably passable; 0.7 .. 0.9 m depends on how the cell centres fall: 0.75 m nav cells).
  Bit 1 = blueprint footprint + 0.3 m (A* +`kReserveCost` per cell: paths and work spots keep off future pieces,
  corridors stay open). Zombies keep the conservative grid.
- *Get down* (`SoldierAI::getDown`, every tick after the state machine): a soldier standing on an obstacle cell walks
  (walk speed, small steps, never a teleport) to the nearest walkable cell within 5 m he can reach without climbing
  (home island first).
- *Engineers* (`EngineerAI`): a 1 m "future" raster (all alive pieces incl. blueprints, gates open, unwalkable cells)
  flooded from outside; a piece whose one side is enclosed by the final plan is worked from the outside, otherwise from
  the side the squad stands on. Work spots: walkable, on the engineer's island, >= 0.55 m off every piece / blueprint,
  >= 1.1 m from joints, unreserved first, the other side as fallback. Before a piece turns solid, `wouldTrap` floods the
  walk cells around every soldier within 8 m with the piece solid: someone in the footprint or sealed into a pocket
  (cannot get 14 m away) holds it at 98 % ("trap"); an engineer of that job caught on the wrong side flips the work side.
- *Radius ring* (`GameUI::drawEngineerZones`): 192-segment anti-aliased polyline at fixed pixel width, draped over the
  base ground (kerbs smoothed, never car roofs / walls), dark underlay; inside buildings it stays at street level, faint.
- Tests: `tests/game/b5_wall_seal.txt`, `b5_engineer_cars.txt`, `b5_car_gaps.txt`; self-test *walls / territory*
  (fillers, facade / container / wall seals).

## 13. UI: HUD 2 and the registration API (GAME_DESIGN 11 / 14e; layout PROPOSED)

Owner feedback (14e): thin and unobtrusive but more dynamic, visual and tactical; categories; no clipped buttons; the unit
info panel never overlaps the menu. HUD 2 (`src/game/HudBar.cpp`, part of `GameUI`) replaces the single build bar:

- **Top bar** (centred, one thin strip): funding + income, kills, troops, territory, clock (time of day, sun / moon) and
  game time, UNAPPROVED tag. Drops secondary labels on narrow windows.
- **Notification feed** (top right, under the top bar): compact, fading, deduplicated (`x3`); entries with a position
  (breach, squad under attack, out of ammo, gas, building events) are clickable and move the camera there.
- **Command bar** (bottom centre): category tabs **Units / Structures / Supplies / Engineering / Vehicles** (Vehicles greyed,
  "coming later"); each tab shows icon cards (voxel-style icon, name, cost, number-key badge 1-7; tooltip with description / stats;
  greyed when unaffordable or unavailable, with the reason). Cards never clip: when they do not fit, the row scrolls
  (arrows or mouse wheel over the bar). Sizes scale with the DPI / `--ui-scale F`.
- **Selection panel** (left, always above the command bar): squad class icon, members with health / ammo / stamina bars,
  state, pace (auto / run / walk) and halt, context actions of the selection (registered), multi-squad summary rows.
  The building panel (BuildingGame) stacks above it (`GameUI::layout()`).
- **Placement banner** (top centre, under the top bar) while a tool is active: what is being placed, its price, and the
  hints (LMB place, Shift keep, Q / E rotate, RMB / Esc cancel).
- **World labels (decluttered)**: text over the 3D view goes through `GameUI::worldLabel(x, y, text, col, priority)`;
  labels are placed by priority (cursor > alert > selected > status > info > minor), nudged or dropped on overlap,
  identical text close by is merged (one "build radius" per area), minor ones fade out when zooming out, and none cover
  the HUD panels. Control hints moved from the cursor into the placement banner.
- **Mac scale fix**: the UI scale is the display content scale without the Retina pixel density (the old code doubled
  every size on a Mac, which pushed the build bar off screen); `--ui-scale F` overrides.
- **World hover menus**: providers fill a small menu for the object under the cursor (e.g. a parked car with engineers
  selected); the menu stays open while the cursor moves onto it.
  Fixed sizes (owner round 15 #2): the command bar is always 7 card slots wide (more cards scroll, fewer leave empty
  slots), the selection panel has a fixed height (8 member rows / 6 squad rows, 2 button rows; more buttons become icon
  buttons, a long member list scrolls), notification rows have a fixed width. Sizes live in `hudsz` (HudBar.cpp).

### Registration API (`src/game/UiActions.h`, `GameUI`)

Features never edit the layout; they register at init (where `GameWorld` installs its modules, e.g. next to
`installBuildingUI(ui_, buildings_)`; `GameWorld::ui()` returns the `GameUI`):

```cpp
#include "game/GameUI.h"
// 1) a command-bar card
UiAction a;
a.id = "struct.tower"; a.category = UiCategory::Structures; a.label = "Defense tower"; a.icon = UiIcon::Tower;
a.cost = [](const UiCtx& u) { return u.ctx.cfg->towers.price; };
// no letter hotkey: the card's position in its tab gives its number key (1-7, drawn on the card)
a.onSelect = [](const UiCtx& u) { u.ui.beginTargeting("Defense tower", "LMB place | Q/E rotate", [](const UiCtx& u, V3 p) {
    Command c; /* ... */ u.out.push(c); }); };
a.enabled = [](const UiCtx& u, std::string* why) { if (!hasEngineers(u.ctx)) { *why = "Needs engineers"; return false; } return true; };
a.tooltip = [](const UiCtx&) { return std::string("Snipers occupy it: +range, protected.\nBuilt by engineers."); };
a.order = 40;                                       // position inside the tab
ui.registerAction(a);                               // or the positional overload:
ui.registerAction(UiCategory::Supplies, "sup.fuel", UiIcon::Fuel, "Fuel drop", costFn, SDLK_L, onSelect, enabledFn, tooltipFn);

// 2) a selection-panel context button
UiSelectionAction s;
s.id = "sel.garrison"; s.label = "Garrison"; s.icon = UiIcon::Garrison; s.hotkeyLabel = "G";
s.visible = [](const UiCtx& u) { return !u.ui.selectionConst().squads.empty(); };
s.onSelect = [](const UiCtx& u) { /* request */ };
ui.registerSelectionAction(s);

// 3) a world hover menu (structures agent: siphon / disassemble)
ui.registerHoverProvider("car.fuel", [](const UiCtx& u, V3 ground, float sx, float sy, UiHoverMenu& m) {
    const uint32_t v = u.app.vehicles.parkedAt(ground.x, ground.z, 2.f);
    if (v == UINT32_MAX || !engineersSelected(u)) return false;
    m.title = "Parked car"; m.anchor = ground; m.key = v;
    m.entries.push_back({"Siphon fuel", UiIcon::Siphon, "", -1, true, "", [v](const UiCtx& u) { /* push command */ }});
    return true;
});
```

- Built-in icons: `UiIcon` (rifle, MG, sniper, flamethrower, engineer, container, airdrop, walls, gate, clear car, tower,
  light, generator, fuel, crate, barricade, garrison, hospital, vehicle, siphon, disassemble, halt, run, walk, burn, build,
  undo). `UiAction::painter` draws a custom one; `drawUiIcon` is public for feature panels.
- Callbacks only push Commands / switch GameUI tools / use the module's request queue (never mutate state directly).
- `beginTargeting(label, hint, fn)`: generic "click a ground point" mode (`Tool::Target`), shown in the placement banner.
- `notifyAt(text, bad, time, pos)`: a clickable feed entry. `GameUI::watchEvents` adds squad under attack / out of ammo /
  breach entries by itself.
- Script verbs (`GameScript`): `ui action ID` (runs a card / selection action as if clicked), `ui tab units|structures|supplies|
  engineering|vehicles`; metrics `ui_tab`, `ui_actions` (registered cards). Scripts click world coordinates only, never UI
  pixels, so the layout can change freely.

## 14. Structures and fuel: defense towers, generators, floodlights, fuel from cars (GAME_DESIGN 14e; mechanics APPROVED, rules PROPOSED, values UNAPPROVED)

**Modules.** `Structures.*` (CPU: towers, generators, floodlights, fuel stores, tower occupancy, tower pressure, power,
generator noise), `FuelLogistics.*` (CPU: siphon orders, jerrycan carriers, disassembly fuel), `StructuresGame.cpp` (App
side: obstacles, EngineerAI hooks, commands, drawing, lights, HUD actions / hover menus, script verbs / metrics). Shared
files got additive hooks only: `EngineerAI::{ExternalJob, externalJobs, externalWork, busy}` + `JobKind::External`
(three small edits in EngineerAI.cpp: append the external jobs after the walls, a work case, skip busy members),
`Combat::extraCapsules` (uploaded after the soldiers), `kStructurePost` (Soldiers.h; BuildingPlay skips such posts),
`CityVehicles::{Vehicle::drained, setDrained}` (+ one line in `blast`), `CommandType::{BuildStructure, OccupyTower,
SiphonCar}` + `Command::structure`, `StructureConfig` (`balance.json` "structures"),
`MilitaryLibrary::addStructurePlaceholders` (+ `structures.*` loaded), `GameWorld::{structures, fuel, structureLights,
economyMut}`, App: `structureLights` joins the point lights (one line).

**Construction.** Tower, generator, floodlight and fuel store are placed like walls: inside the engineer radius (or
`cheat build 1`), on open level ground (no wall, vehicle, structure overlap; kerbs / steps / roof edges refused); a
floodlight needs a generator (built or planned) within `cableRange` (25 m). Charged once; the blueprint is an
EngineerAI external job (owner 1: `towerTime` 60, `generatorTime` 24, `lightTime` 9, `fuelStoreTime` 15
engineer-seconds; tower: sledgehammer loop, others: the build loops). Finished: obstacle stamped (tower base up to
`towerObstacleTop` 5.1 m, generator / fuel store 1.1 m; the floodlight tripod is no obstacle).

**Tower occupancy.** "Occupy tower" (selection action, hover menu over a tower, script `occupy N X Z`): snipers first,
then riflemen / MG gunners of the selected squad fill the free posts (`towerCapacity` 2; engineers and flamethrowers
refused, PROPOSED). Each walks to the ladder foot (rear, -Z), climbs (`climbTime` 3 s, `POST_ENTERING`: SoldierAI leaves
him alone), then holds a deck post: `POST_FIRING`, `building = kStructurePost | tower`, `postOut = 0`, pinned at deck +
5.1 m. SoldierAI's garrison path does the rest: eye height above the deck (6.6 m), clear lines over the parapet to the
street, normal acquisition / fire / reload (rounds start above the base obstacle). A new player order for the squad
brings him down at the ladder foot (instant, PROPOSED: a climb-down clip later); out of ammo he climbs down to
resupply (PROPOSED). Posted soldiers are attractors like any squad (the horde comes to the tower).

**Zombies vs the tower (owner decision 2026-11-28: they attack the base, never climb; a large horde heaps up around
it).** The base is a 3.5 x 3.5 m obstacle 5.1 m high in the zombies' obstacle grid: the crowd presses against it and
the existing corpse-pile / climbing rules make the bodies heap up around the base (piles never reach 5 m, so nobody gets
onto the deck). Four base proxies (capsules r 0.6 m just inside each face, `Combat::extraCapsules`, packed id
0xFFFF | proxy << 16, never a soldier) give the horde's exact attacker count at the base through the normal
SoldierContact path. Damage `(attackers - towerPressureThreshold) x towerDamagePerZombie` hp / s (4, 2.0; tower 2,500
hp). At 0: collapse (obstacle removed, dust, loud noise), occupants fall beside it (`fallDamage` 40 hp) and are released.

**Power.** A generator runs while it powers at least one built floodlight, has fuel in its tank and (PROPOSED
`lightsOnlyAtNight`) it is night (18:00..06:00, App time of day) or the lights are forced on (`lights on` / later a HUD
toggle). Floodlights take the nearest generator with fuel within `cableRange` (up to `generatorMaxLights` 4 each). Burn
`generatorBurn + burnPerLight x powered` (0.02 + 0.006 l/s: ~10 l per 7-minute night with 4 lights). The tank
(`generatorTank` 20 l) refills from the nearest fuel store within `fuelLinkRange` (30 m) when it is below half. No
fuel: the generator stops, its lights go dark (notice). Lit floodlights are point lights (warm white, radius 24 m,
placed 4.5 m out in front of the heads at 3.4 m: the beam's pool of light), the 8 nearest the camera, appended to the
renderer's light list after the burning vehicles / flames (24 max in total). Not done: the lamp grid / shadows (the
street-lamp grid is baked per city tile; a dynamic structure grid layer is PROPOSED if 8 is too few).

**Generator noise (owner decision 2026-11-28: noise stacks per area).** Every `noiseInterval` (1 s) the running
generators are grouped greedily into areas (`noiseStackRadius` 30 m from the first ungrouped one); each area emits one
noise pulse at its centroid with strength `min(noiseCap, n x noiseIntensity)` (0.5 each, cap 1.5) and reach
`min(noiseRadiusCap, noiseRadius x sqrt(strength / noiseIntensity))` (40 m for one, 56.6 m for two, 69.3 m at the cap,
cap 80) through `Combat::addNoise` -> horde attractors (strength x awareness = reach, as for gunfire noise).

**Fuel.** Fuel stores (`fuelStoreCapacity` 200 l, `fuelStoreStart` 40 l) are the base stock; the HUD / scripts read the
sum. Fuel comes from parked cars (`carFuel` 30 l; burning / wrecked / drained / removed cars: none):
- *Siphon fuel* (hover menu over a car with engineers selected, script `siphon X Z`): refused without a fuel store or
  outside the engineer radius. EngineerAI external job (owner 2, `siphonTime` 18 engineer-seconds, car work loops).
  Done: `CityVehicles::setDrained` (a blast still damages / pushes the car, but it never ignites or explodes: the health
  is held above 0 in `blast`), and the fuel waits in jerrycans at the car. Each engineer who worked on it carries one
  jerrycan (`jerrycanLitres` 20 l) on foot (a placeholder jerrycan at his hand) to the nearest fuel store's delivery
  point (`deliverRange` 2.5 m), pours it in, and walks back for the next one until the car is empty. Carriers are
  `EngineerAI::busy` (not given other jobs) and still fight when threatened (SoldierAI; the walk resumes after).
  A carrier killed on the way loses his jerrycan; a full store spills the excess (counted as lost).
- *Disassemble* (the existing car clearing, hover entry renamed "Disassemble (+ fuel)", K): when the clearing job
  finishes, `EngineerAI::removeVehicle` (wrapped) hands the car's fuel to the engineers of the nearest engineer squad,
  who carry it to the base the same way; then the car is removed as before. No fuel store: the fuel is lost (notice).

**HUD.** Structures tab: Defense tower / Generator / Floodlight / Fuel store cards (price, "Needs engineers",
tooltip; click -> `beginTargeting` -> `BuildStructure`). Selection action "Occupy tower" for rifle / MG / sniper
squads. Hover menus: a tower with shooters selected ("Occupy tower"); a parked car with engineers selected ("Siphon
fuel (N l to base)", "Disassemble (+ fuel)"; installed after GameUI's built-ins under the same id `car.clear`, so it
replaces the plain "Clear" entry). Not yet: rotation while placing structures (yaw 0 = ladder south), a fuel gauge in the
top bar, a lights on / off toggle (PROPOSED).

**Assets.** Authored props `tower_wood` (alt `tower_steel`), `generator`, `floodlight` (+ `lamps` part), `fuel_store`
(+ `can0..5` fill level), `jerrycan`, `fuel_drum` in `assets/military/structures.*` — PENDING REVIEW
(docs/ASSET_APPROVALS.md). Until approved the game draws coarse placeholders (`ph_tower`, `ph_generator`,
`ph_floodlight` + `ph_floodlight_lamp`, `ph_fuel_store`, `ph_jerrycan`); `kStructureAssetsApproved` in
`StructuresGame.cpp` switches every structure to the authored props (lamps part when lit, cans by stock level).
Blueprints are drawn translucent, rising with progress.

**Tests.** `tests/game/b5_tower.txt` (no engineers -> refused, tower blueprint + engineers build it, obstacle, sniper
occupies the deck, fires at a horde, the horde at the base, collapse drops him), `tests/game/b5_power.txt` (light needs
a generator, fuel stock -> tank, day: off, forced on: lit, fuel burned, noise 1 area, dry -> dark and silent, refuel ->
lit, 2 and 4 generators in one area: noise adds up and is capped), `tests/game/b5_fuel.txt` (siphon refused without a
fuel store, siphon job, drained car, two jerrycan trips on foot, stock +30, disassembly +30, a blast leaves the emptied
car un-burnt while a full car explodes).

**PROPOSED (owner):** generators only run at night; towers manned by snipers / riflemen / MG (not engineers or
flamethrowers); instant climb-down on a new order; tower occupants climb down when out of ammo (later: an ammo box on
the deck, refilled by the runner); fuel stores spill when full; lights do not cast shadows yet (point lights only).

## 15. Rooftops 2.0: placement, roof navigation, roof logistics (GAME_DESIGN 14e; PROPOSED, values UNAPPROVED)

Owner: "placing items and deploying units on roofs must be effortless; units on the roof respect its collisions, path
properly and do not sit on the edge; they must understand the supply crate on their roof".

* **Roof clearances (`NavGrid`).** A roof island = an island with a drop of more than 2.5 m within 2 cells of its rim
  (never the largest island, the street network). Per roof cell (from the window's 0.75 m grid = max of the baked
  0.5 m heights) two clearances, centre to the nearest cell not on the island, capped at 3 m: *edge* (a drop > 1.5 m,
  or a raised rim cell with such a drop within 2 cells = parapet / ledge) and *obstacle* (stair housings, HVAC, tanks,
  skylights, the other level of a stepped roof). `edgeClearance` / `obstacleClearance` give the exact value of a point.
  A* adds 3 x (1.2 - edge) + 3 x (0.6 - obstacle) per step (positive parts), so paths keep off the rim and go round roof
  objects with a margin; string pulling never cuts a leg through cells nearer the rim than the A* cells between its
  ends. Path starts on a rim cell snap onto the same level (`nearestWalkableLevel`), never onto the street below.
* **Roof-surface picker (`Deploy.h roofLevels`, `Deploy::planRoof`, `Logistics::airdropSpot`).** The click resolves to
  the roof level it means (the roof island under it; a click on a parapet / cornice / roof object / rim -> the roof
  beside it; a small raised top (< 60 cells) -> the larger level it stands on first). The whole island is searched for
  the spot nearest the click scored against inset tiers (edge >= 1.5 / 1.2 / 1.0 / 0.7 / 0.36 m with a penalty of
  0 / 2 / 4 / 8 / 14 m per tier: a narrow ring around a tower core still takes its most inset cells). Squad members land
  on the same island, spaced 4.5 m, else 3 / 2.2 / 1.6 m. Crates: edge >= 1.8 m (tiers to 0.36), an access cell
  beside them; roof crates land exactly at the previewed spot (no scatter) and their slots are on the island, inset
  >= 0.8 m. Only when no roof level has any spot does the old surface snap run. The preview (GameUI, small edit) shows
  every landing spot and a line from the cursor to the snapped spot (squads and crates).
* **AI (`SoldierAI`).** Homes of roof soldiers are inset spots (`roofInset`: >= 1.2 m from the edge, 0.5 m from roof
  objects, else the most inset cells); a squad that landed on a roof keeps its landing spots; idle separation never
  pushes toward the edge. Firing posture: with known targets that no line from the home can hit, `roofEdgeStep` (every
  1.5 s) picks a rim cell within 3.5 m of home with a clear firing line, walks there, fires; after 1.5 s at the edge
  with nothing shootable he walks back home (`edgeSteps` / `edgeReturns`). Snipers: each vantage has `pos` (inset home)
  and `fire` (the rim cell); targets are counted from `fire`, the sniper waits at `pos` and steps to `fire` to shoot.
  Garrison posts (BuildingPlay) are untouched.
* **Logistics.** `findNearest` uses the soldier's level when he stands on a rim cell and accepts a supply point only
  when one of its slots is on his island.
* **Tests:** `b5_roof_drops` (roofclicks over a flat parapet roof, a cluttered roof and a stepped roof: 0 refused,
  spots >= 1.2 / 1.0 m from the edge (stepped: narrow lower strips 0.44 m); drops on a cornice notch, a rim, a stair
  housing, a stepped edge and a UI click; idle roof soldiers watched every tick), `b5_roof_paths` (paths round the
  stair housing, off the rim; moves across roofs), `b5_roof_supply` (crates clicked at roof rims, sniper and rifle squad
  runner collect on their roofs). Script verbs / metrics: `RoofScript.cpp`.
* **Known limits:** narrow roofs (tower rings / tops of seed 1) have no 1 m inset cells at all: soldiers there stand on
  the most inset cells they have; a housing between two roof levels may resolve to the lower neighbour; crates are not
  nav obstacles.

## 16. Roofs round 15 (owner items 4-7, WS-B; PROPOSED, values UNAPPROVED)

* **Reanimation on roofs (`Reanimation.cpp`, `HordeBridge::spawnZombie`, `CrowdSim::requestSpawnZombie(levelY)`,
  `sim_spawn.comp`).** The old check (lowest surface within 6 m must be < 1 m below the body) refused every roof body.
  A body above 0.6 m on a walkable / roof cell of its own level is accepted; the spawn request carries the level
  (`lookB.w = levelY + 1`) and `sim_spawn` only uses cells within the step height of it, so the zombie rises on the roof.
  `CrowdSim::requestSpawnLevel` uses the same path (script `roofzombies N X Z R`).
* **Roof <-> street moves (`SoldierAI::levelMove / levelTransit`, `Deploy::jumpFromRoof`).** Runs when a Moving /
  Forming path fails between islands. Rule: (1) the building under the roof (B3a registry, `GameContext::registry`) has a
  roof hatch and a door: walk to the point of the soldier's roof level nearest the hatch, 2.5 s + 2.2 s per storey in
  the stair core (the soldier waits at the hatch; interiors are not drawn), out at the street point 1.2 m in front of
  the nearest door, then the original order; street -> roof is the reverse. (2) no access: the best rim cell (distance
  + landing-to-goal) whose outward ray reaches a walkable street cell of the goal's island within 12 m, with a clear
  canopy column; the soldier walks there and parachutes down as a `DropTrack` with `jump = true` (approved
  para_descent / land / recover + canopy and dissolve; drift eased as alt^6 so he moves away from the facade first).
  Street -> roof without an access is not possible (unchanged: deploy by parachute). Metrics `roof_jumps`, `stair_trips`.
* **Zombies falling off roofs (`sim_finalize`, `sim_predict`).** A walker / climber that is unsupported more than 1.5 m
  above the ground and moving down becomes ST_FALL with the timer mark `FALL_EDGE_TIMER` (free fall: the walk-speed
  clamp no longer applies). `sim_predict` kills an edge faller whose next step lands faster than `FALL_LETHAL_V`
  (10.5 m/s, ~5.6 m): ST_DYING (kill record, cause Other), random limbs off (gibs), blood spray + dust, blood pool on
  the impact frame (`sim_finalize`), the body becomes a corpse in the corpse field. Gore counter 6 = `SimStats::fallSplats`
  (`fall_splats`). Only crowd pushes (solver) send zombies over an edge; the flow field / wander rules still keep
  them off the rim, so they do not jump deliberately.
* **Placement on roofs (`Walls.cpp`).** A wall run whose footprint is on one roof level (all samples within 0.6 m, above
  the street by kBuildingRise) uses the roof as its reference; a run hanging over the edge is refused "over the roof
  edge". Structures already validated against the local surface; crates use the roof picker (section 15).
  **Not done:** engineers do not route to roof jobs through the stair core (EngineerAI paths directly), so roof
  structures / walls need `cheat build` or engineers already on that roof; wall pieces on roofs were not verified as
  nav obstacles for roof zombies / soldiers.
* **Tests:** `b6_roof_reanim`, `b6_roof_descend`, `b6_roof_fall`, `b6_roof_place`.
