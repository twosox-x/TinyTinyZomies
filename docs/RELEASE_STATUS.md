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

TESTS_AND_CRASH_PLACEHOLDER

## 3. Tests (all executed on the final binary unless marked)

TEST_TABLE_PLACEHOLDER

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

PERF_PLACEHOLDER

## 6. Known issues

* The intermittent lavapipe segfault was **not reproduced** in this pass (section 2); its cause is not proven.
* Corpse slots are never reused: burnt corpses clear their alive bit but keep their slot (capacity 262,144). Long
  sessions make the corpse passes (gas, culling) walk more dead slots; past the capacity new bodies are not stored
  (height still accumulates). PROPOSED fix: a free-slot stack filled by the gas pass, popped by `sim_finalize`.
* Engineers dying with a tool play `death_a` (the `death_tool_<tool>` clips and `carry_sandbag` / `carry_panel` are
  not used yet); the hose is a straight sagging chain (no collision with the body).
* Ground-fire damage per zombie depends on how many of the 4 rays per burning cell cross it (~1.6 on average); a
  crowded cell burns its zombies one per ray per readback. Ground fire credits the newest flame cone's shooter.
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
