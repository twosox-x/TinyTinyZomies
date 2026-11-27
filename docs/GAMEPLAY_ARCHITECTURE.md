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
  kinematics), up to 4 flash point lights. Game rounds (after B1 feedback): flash + tracer per `FxKind::Shot` along the
  real shot ray (`GameRender::shotFx` -> `MilitaryRenderer::fxShotRay`; tracer cadence `GameRender::tracerEvery` =
  rifle 3, MG 1, sniper 1 (faint)); the streak ends where the GPU resolved the round (`HordeBridge::hitResults`,
  per-shooter queue order). Flashes / tracers are emissive by day and night, scene-pass only, and keep a minimum
  angular size (~2-3 px) at RTS distance. LODs (city chunks, instances, foliage, soldiers) measure from the nearer of
  the eye and the camera focus (RTS pivot); props / foliage are never distance-culled (coarse LODs instead). Parachute sequences for soldier (street, rooftop with canopy clamp) and
  cargo crate, canopy voxel dissolve after `canopy_ground` (2.5 s hold + 2.5 s).
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
  the desired velocity blends from the last pursuit heading to the wander velocity at a rate that grows as alert
  falls (keeps streaming to the last known source for a few seconds, then drifts back to wandering — no snapping).
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

**Controls (`ttz --map city --game`).** Build bar (bottom right) or hotkeys: Z rifle squad, X MG squad, C sniper,
V ammo container (T rotates), B ammo airdrop. LMB places with a live preview (green = valid, red + reason = refused;
nothing is charged for a refused spot). LMB click / box drag selects squads (Shift adds), 1..9 select squad N, Tab
cycles, Esc cancels the tool / clears the selection. RMB click = move order (Shift+RMB runs), RMB drag still pans
(OWNER question 4 kept as proposed), H halts. F1 shows the debug panel (off by default in `--game`).

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

**Territory.** Rebuilt on events only (build, destroy, container landed): structures (pieces + 0.2 m, posts,
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

**Tests.** Self-test *walls / territory* (22 checks, CPU). Scripts: `tests/game/b2_territory.txt`,
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

**Ranges.** MG 55 m (dense close-mid), rifle 60 m (mid), sniper 220 m (accuracy 0.99, spread 0.12 deg, headshot 0.7,
noise radius 12 m). Test `tests/game/b1_sniper.txt`.
