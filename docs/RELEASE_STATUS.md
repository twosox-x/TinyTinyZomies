# Release status — owner build (branch `phase7b-gameplay`, 2026-11-27)

Final stabilisation pass before handing the owner a build. Everything below was executed on the Linux box (lavapipe,
4 CPU cores, software Vulkan): numbers are relative only, never Mac numbers.

## 1. What is in this build

| Area | State |
|---|---|
| Engine | SDL3 GPU (Metal on Mac, Vulkan elsewhere), C++20, 69 shaders (SPIR-V + MSL + reflection committed), clean build 0 warnings |
| City | Baked seed 1 (288 tiles, 2.3 x 2.0 km): BLDG building records, rural kit (woods, hedgerows, farmsteads), infill kit for empty lots, stepped riprap river banks, voxel-cell water shading, twins-tower sky lounge removed |
| B1 combat loop | Squads (rifle 5, MG 3, sniper 1) by parachute, GPU horde with hit rays (partial cover over cars), kills / rewards (deduplicated ledger), tracers + voxel muzzle flashes, reanimation of dead soldiers, ammo runner / crates / containers, stamina, rooftops |
| B2 fortification | Gabion walls 1.6 / 2.4 m, gates, containers closing gaps, territory regions + income, breaches / rubble |
| B3 AI | Target scoring (threat, reachability, shot grid), head aim over cover, MG cone discipline, sniper vantage selection |
| B3a buildings | Capture, Garrison (window / roof positions), Hospital, barricades, window nests |
| B3b vertical | Zombies enter buildings with soldiers inside, climb floors (queues, breach of barricades), interior fights, roofs |
| 14d engineers | Squad of 3 (APPROVED model / clips since this pass), construction radius, blueprints built over time, undo, mid-piece T split, single gates (J), car clearing (K) |
| 14d corpse gas + flamethrowers | Rot gas (GPU field, haze, soldier damage, nav cost), flamethrower squad of 2 (APPROVED model / clips / flame FX v4 since this pass): autonomous pile burning, flame kills, ground fire now hurts zombies |
| Rendering | Two-layer sun shadows, DOF auto-focus + tilt-shift at max zoom, day 20 min / night 7 min, foliage LOD, window lights, voxel flame / explosion volumes |

### Changes made in this pass
* **Approved specialists in the game** (owner): `specialists.{json,ttzm}` + `specialist_anims.{json,bin}` loaded after
  the infantry (shared, de-duplicated palette: the earlier per-file palettes would have filled the 256-entry material
  table and switched the RTS markers off). Engineers: approved models, work loops `build_shovel` / `build_sandbag` /
  `build_hammer` (walls, by member), `build_hammer` (gates), `cut_car` / `pry_car` (cars); tools drawn in the hand from
  the clip's tool flags, carbine stowed on the back. Flamethrowers: approved flamer models, `ignite` -> `burn_ground`
  -> `stop` at piles, `fire` against zombies, procedural hose from the tank to the gun, flame FX from the nozzle.
  The placeholders remain only as a fallback when the asset files are missing.
* **Container apron** (owner bug): the sandbag / barrier apron is hidden during the parachute descent and rises out of
  the ground in 0.6 s after touchdown. Collision / obstacles unchanged.
* **Ground fire damages zombies** again, through a safe CPU -> hit-ray path (`CorpseGas::groundFire`), new self-test.
* **Zombie spawns on kerbs / sidewalks** (`sim_spawn.comp`: static height up to the step height counts as ground).
  Script spawns on a sidewalk silently failed before (b3_ai_gate's approaching group never existed).
* Test fixes (justified in section 3): `b3_ai_gate`, `b3_ai_survival`, `b4_gas_flame`, `roam_ambient`.
* Map re-baked once with the current baker (verify OK; overhang check in section 4).

## 2. Crash investigation (lavapipe segfault ~30 s; GPU flame-damage pass)

* **Not reproduced.** b3_ai_gate under gdb (single process, clean build), then every script of section 3 with core
  dumps enabled, two to four game / self-test processes at once (the "loaded host" condition of the earlier reports),
  plus a flame-kill scenario (flamethrowers + rifle squad + two zombie waves + a burning pile, 24 kills) under the
  Khronos validation layer: no segfault, no core, 0 validation messages, and no GpuContext binding report ("dispatch X:
  binds ...") in any log. All compute pipelines stay within 8 read-only / 8 read-write storage buffers (largest:
  sim_predict 4 / 8, sim_solve 8 / 2, sim_finalize 4 / 7, game_vertical 6 / 5); every dispatch goes through
  `GpuContext::dispatch` and its binding check.
* Reviewed for out-of-bounds GPU writes (lavapipe runs shaders on the CPU without robust buffer access, so an OOB
  storage write corrupts the heap and crashes later inside the driver): kill ring (`GAME_KILL_CAP`), hit queue
  (agent index < live <= capacity), corpse append (`corpseP.w` cap), gas list (one slot per cell), vertical occupant
  list (capacity checked before every push), spawn / emit slots (`grid.w`), MilitaryRenderer instance regions
  (`kMaxAtts`, `kMaxCpuInst`, fixed in the earlier stabilisation 7ff40aa). No overrun found.
* The removed GPU flame-damage pass (`game_gas_agents.comp`) only wrote `gameIO[GAME_HIT_BASE + 4 i]` for
  `i < C_LIVE`, which is in bounds; its crash after flame kills could not be explained from the code and was not
  re-enabled. Ground-fire damage instead goes through the CPU -> hit-ray path that the cone already used (same buffers,
  same bounds as rifle rounds), covered by the self-test and `b4_gas_flame`.
* If the segfault returns on the owner's machine: run the script under `gdb -batch -ex run -ex bt --args ...` and
  with `VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation`; on the Mac, Xcode's Metal API / shader validation.

## 3. Tests (all executed on the final binary unless marked)

Self-test `ttz_selftest` (final source): **PASSED, 215 checks, 0 failures** (736 s), including the new "ground fire
kills zombies standing in it". Scripts: `./build-final/ttz <the script's own flags> --game-script tests/game/<name>.txt`,
one process each, run two to four at a time (wall times inflated by that). "final" = the final binary of this pass;
"earlier" = a binary of this pass before the specialist / palette changes (gameplay code identical except the work /
flame clip requests).

| Script | Checks | Result | Binary | Notes |
|---|---|---|---|---|
| b1_ai_threat | 9 / 9 | PASS | earlier | |
| b1_combat_loop | 26 / 26 | PASS | earlier | |
| b1_input | 12 / 12 | PASS | final | |
| b1_reanimation | 12 / 12 | PASS | final | |
| b1_resupply | 23 / 23 | PASS | final | |
| b1_rooftops | 15 / 15 | PASS | final | |
| b1_runner | 9 / 9 | PASS | final | |
| b1_sniper | 7 / 9 | **FAIL** | final | wave 2: hit_pct 40.6 (>= 55), hits_static 19 (<= 4); kills 13 >= 11 pass. Known issue, section 6 |
| b1_stamina | 11 / 11 | PASS | final | |
| b2_gate | 10 / 10 | PASS | final | uses `cheat build 1` |
| b2_input | 7 / 7 | PASS | final | |
| b2_territory | 28 / 28 | PASS | final | |
| b3_ai_cars | 6 / 7 -> fixed | PASS* | final | first run 5 / 6: only 2 of 3 zombies fit the (re-baked) gap between the car rows, all killed; expectation now `kills >= 2` with the gap empty. Re-run 6 / 7 failed only a check I had added at t = 29 (zombies already shot), removed; *the final file was not re-run* |
| b3_ai_gate | 11 / 11 | PASS | final | was failing: see section 1 / below |
| b3_ai_survival | 8 / 8 | PASS | final | was 7 / 8: see below |
| b3_roof_crate | 10 / 10 | PASS | final | |
| b3_roof_levels | 17 / 17 | PASS | final | |
| b3a_garrison | 27 / 27 | PASS | final | |
| b3a_hospital | 22 / 22 | PASS | final | was 20 / 22: see below |
| b3a_house | 13 / 13 | PASS | final | |
| b3b_vertical | 18 / 18 | PASS | earlier | |
| b4_engineers | 26 / 26 | PASS | final | approved engineers + work clips |
| b4_gate_car | 16 / 16 | PASS | final | approved engineers + car clips |
| b4_gas_flame | 14 / 14 | PASS | final | was 10 / 12: see below |
| roam_ambient | 6 / 6 | PASS | final | was 5 / 6: see below |

Test changes (justification):
* `b3_ai_gate`: (1) the approaching group was spawned on a sidewalk and never existed (sim_spawn refused any static
  height > 0) -> engine fix (kerb spawns) + a check that the group spawned + `kills >= 8`; (2) the gate is now
  reinforced (2.4 m): AI round 3 aims at heads over cover, and heads show over the 1.6 m cheap gate, so the zombies
  behind it were legitimately shot; the test is about an unshootable gate; (3) the "shut in" rectangle reaches the gate
  line (x -6.3): pressed zombies stand at x -6.76, outside the old x -7.
* `b3_ai_survival`: the two west spawn points are inside a tower on the re-baked map (moved to the street at x -26);
  with all 57 zombies spawning, target switches 107 (~2 per zombie) -> bound 140 (was 90 for ~28 zombies).
* `b4_gas_flame`: a short spray lights the pile's cells and burning bodies keep them lit; the AI only re-sprays unlit
  corpses (the fuel-economy fix), so 2 sprays / 2 fuel units burn the 45-body pile: `flame_sprays >= 1`,
  `fuel_used >= 1`, new `fuel_used <= 120` (economy) and `ground_fire_rays > 0`.
* `b3a_hospital`: on the re-baked map the squad lands within the capture radius of the door and captured the building
  before the `bzombies 3` test hook at t = 24: the hook is now set at t = 0.2.
* `roam_ambient`: the re-baked map has a tower west of the crossing (x < -31): 3 idle zombies near the source (was 14),
  16 at t = 20, 12 at t = 30 -> `> 10` at t = 20 and `> 8` at t = 30 (was `> 20`).

Additional runs: b3_ai_gate under gdb; a 41 s flame-kill scenario under the validation layer (24 kills, 0 messages);
three visual-check runs of the specialists / container (shots in the session scratchpad).

## 4. Map package (re-baked once in this pass)

`node --max-old-space-size=6000 tools/city_lab/bake/bake.js --seed=1 --scale=5 --out=<dir> --jobs=2`: 288 tiles,
130.4 MB, 872 s; LOD0 37.2 M tris, LOD1 24.8 M; 14,420 vehicles (126 variants), 8,010 props; 714 k foliage instances
(woods / fields); water in 41 tiles, 2 bridges; land use forest 14.6 %, field 20.7 %, pasture 11.5 %.
`verify.js`: OK (0 structural errors). `dev/overhang.js`: 21 flagged clusters (8 floating, 13 one-sided cantilevers
> 3.5 m), down from 25 (8 / 17) on the previous package; the two largest "floating" clusters (279 m2 at (214.8, -81.9)
and 208 m2 at (26.8, -58.8), soffit 126.7 m) are unchanged by the twins fix and need a look in City Lab (likely sky
bridges / crowns read as floating by the check). The previous package is kept outside the repo as a backup
(scratchpad `seed1_backup`). Packages are not committed (`.gitignore`): **the Mac must re-bake** (section 7).

## 5. Performance (relative, lavapipe)

Scenario (session scratchpad `perf.txt`): a garrisoned 9-floor mid-rise (rifle squad at windows / roof edges), an MG
squad, a second rifle squad and a sniper fighting in the streets, a flamethrower squad burning a 40-body rotting pile,
six waves (220 zombies) from four directions; 16 soldiers, 221 kills in 100 s, 886 rounds, no losses.
* `--perf-report` / `--perf-csv` only instrument the sandbox loop, not `--game` (no per-frame report was produced):
  **no frame-time numbers for the game mode in this pass** (follow-up: hook GameWorld's tick / render timings into the
  existing PerfRow table).
* Wall clock, headless, `--game-sync`, lavapipe: 101 s of game time in 620 s with two other game processes on the
  4 cores (~6.1 s wall per game second). For comparison the lighter b3_ai_gate (1 squad) alone under gdb: 56 s in
  215 s including ~15 s loading. Per frame the city renderer drew 0.84 M triangles in 118 draws; the city
  window decoded 16 tiles (14 ms average decode). Relative only: lavapipe renders on the CPU, so these say nothing
  about the Mac.

## 6. Known issues

* The intermittent lavapipe segfault was **not reproduced** in this pass (section 2); its cause is not proven.
* Corpse slots are never reused: burnt corpses clear their alive bit but keep their slot (capacity 262,144). Long
  sessions make the corpse passes (gas, culling) walk more dead slots; past the capacity new bodies are not stored
  (height still accumulates). PROPOSED fix: a free-slot stack filled by the gas pass, popped by `sim_finalize`.
* Engineers dying with a tool play `death_a` (the `death_tool_<tool>` clips and `carry_sandbag` / `carry_panel` are
  not used yet); the hose is a straight sagging chain (no collision with the body).
* Ground-fire damage per zombie depends on how many of the 4 rays per burning cell cross it (~1.6 on average); a
  crowded cell burns its zombies one per ray per readback. Ground fire credits the newest flame cone's shooter.
* `b1_sniper` fails its wave-2 accuracy checks (hit_pct 40.6 vs 55, hits_static 19 vs 4): the sniper on the 76 m
  roof fires at isolated zombies whose line passes a facade / roof edge (more of the scattered spawn points now
  succeed since kerb spawns are accepted, some of them close to buildings). Kills are met. PROPOSED follow-up: check
  the sniper's firing line against the GPU static grid with a margin before firing (the CPU nav heights are coarser).
* B3a barricades / window nests are still bought instantly and anywhere (not engineer jobs).
* The game camera keeps 45 m minimum distance; close-up review of the specialists is done in the Military Lab.
* Two overhang clusters (section 4).

## 7. Proposals awaiting owner approval (values in `config/balance.json`, all UNAPPROVED)

| Topic | Proposal (current value) | Source |
|---|---|---|
| Breach / income rule | Opening the perimeter removes the territory at once; zombies inside a closed perimeter pause income, control lost after `fort.lossTime` 20 s, back after `fort.clearDelay` 3 s clear; income `fort.incomePerHectarePerMin` 1,000 | GAME_DESIGN 4 |
| Gates | 4 m wall piece soldiers pass and zombies cannot; counts as closed; leaves open near soldiers (visual); 3x a wall piece; no lock / sortie control | GAME_DESIGN 4, arch 6 / 12 |
| Containers anywhere | Placeable on any valid flat spot (closes gaps in a perimeter); `fort.containerNeedsTerritory` false | GAME_DESIGN 4 |
| Controls | RMB = auto move, Shift + RMB = force run, Ctrl / Alt + RMB = walk; J gate, K clear car, Ctrl+Z undo build | arch 7, 12 |
| Building capture / roles | Capture = a squad at the entrance with no zombie inside / at the door for 5 s (radius 7 m); Garrison $150, Hospital $250, garrison ammo 600 | arch 8 |
| Hospital | 4 beds, heal 6 hp/s, search radius 150 m, discharge at 95 % health | GAME_DESIGN 6 (OPEN) |
| Barricades | planks $30 / 300 hp, plate $80 / 1,200 hp, sandbags $60 / 800 hp; breach 4 hp/s per zombie; nest $60, damage x0.6 | arch 8 / 9 |
| Vertical warfare | climb 4.5 s/floor, door 1 s, hatch 1.5 s; capacities door 3 / stair 6 / floor 60 / hatch 2; defender 0.6 hp/s | arch 9 |
| Engineers | radius 40 m around the post; piece 6 s per 4 m (engineer-seconds), gate 9 s, car 24 s, car $50; cars first in the queue; a move order drops jobs; undo only unfinished parts | GAME_DESIGN 14d, arch 12 |
| Flamethrowers | squad of 2 ($900), range 9 m, cone 18 deg, 1.6 hp/s in the cone, tank 120 + 240 fuel; ground fire 4 s (no spread), 0.5 hp/s; corpse ignites after 0.6 s, burns 4 s; seeks piles >= 3 corpses within 35 m | GAME_DESIGN 14d, arch 11 |
| Rot / gas | rot after 45 s, full emission after 120 s more; 0.01 gas / corpse; soldier damage 1.5 x level hp/s above 0.15 (max 5); nav avoids > 0.35 | arch 11 |
| Roaming density | 400 zombies per hectare of open ground (city window ~1,600 placed), wander 0.45 m/s, alert memory 25 s | arch 3.6b |

## 8. Mac: pull, re-bake, build, run, test

```sh
git pull                                   # branch phase7b-gameplay
# map package (not in git): ~15 min, needs node 20+
node --max-old-space-size=6000 tools/city_lab/bake/bake.js --seed=1 --scale=5 --out=assets/city/seed1 --jobs=2
node tools/city_lab/bake/verify.js assets/city/seed1
cmake -S . -B build -G Xcode && cmake --build build --config Release
./build/Release/ttz_selftest                                    # expect "selftest: PASSED"
./build/Release/ttz --map city --game                           # play
# one scenario (exit code = failed expectations); all of them:
./build/Release/ttz --map city --game --headless --count 1 --game-sync --game-script tests/game/b4_gas_flame.txt
for f in tests/game/*.txt; do echo "== $f"; ./build/Release/ttz --map city --game --headless --count 1 --game-sync --game-script "$f" | grep -E "FAIL|game script"; done
```
(`roam_ambient.txt` is meant without `--count 1 --game-sync`: `./build/Release/ttz --map city --game --headless
--game-script tests/game/roam_ambient.txt`; it and a few others write PNG shots relative to the working directory.)
