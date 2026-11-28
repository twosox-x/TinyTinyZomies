# Owner feedback tracker (round 15, 2026-11-28)

Every item the owner raised in the latest play session. Each has an owner workstream (WS) and a status.
Nothing is "done" until it is built, tested, and shown in a screenshot. Earlier rounds: GAME_DESIGN.md §14b–14e.

| # | Owner item (condensed) | WS | Status |
|---|---|---|---|
| 1 | Clouds move too fast | orch | wind 3 → 0.8 m/s |
| 2 | UI must have a fixed size; content scrolls / moves, never resizes the panel | A | done (A): bar = 7 fixed card slots (scrolls), selection panel fixed height (list scrolls, icon buttons when crowded), fixed-width notices; sizes in `hudsz` (HudBar.cpp); shots wsA/ |
| 3 | No "Unsupported – too tall" etc.: every building is supported and works | C (session B, branch sessionB/ws-c) | WS-C: all refusal paths removed, entrance added when none is usable (b6_garrison_all; ARCH §8 round 15). Zombie entry > 22 floors is still WS-B's limit |
| 4 | Units on roofs can go down: through a roof entrance if there is one, otherwise parachute (rappel) down | B | open |
| 5 | Zombies can fall off roofs and smash into gore | B | open |
| 6 | Roofs are like ground: place units, crates, towers, walls on roofs when there is space | B | open |
| 7 | Sniper killed by a zombie on a roof did not reanimate (soldiers must turn on roofs too) | B | open |
| 8 | Engineers and flamethrowers need autonomy: fix / clear what the situation needs, near their position, no wandering without orders | D (session C, branch sessionC/ws-d) | done (tested): idle engineers repair walls / gates / structures and re-seal breaches within 20 m of their post; flamethrowers burn the pile gassing soldiers first and defend pressed walls within 25 m; any order cancels (b6_engineer_auto 13/0, b6_flamer_auto 10/0). Not done: generator refuel, car siphoning (optional), status string in the HUD (WS-A: EngineerAI::status / FlameAI::status) |
| 9 | Tower / generator / floodlight / fuel models in game are not the reviewed ones | orch | reviewed models switched on (timber tower; owner to pick timber / steel) |
| 10 | Toxic gas = ugly particle blocks; must be voxel-volume gas clouds in the same style as the explosion / flame volumes | E (session B, branch sessionB/ws-e) | open |
| 11 | Keys 1 2 3 4 5 6 7 for units (not Z X C V B) – intuitive layout | A | done (A): 1-7 = cards of the active tab (number on each card), Tab/Shift+Tab tabs, Ctrl+1-9 squads, . next squad, Esc tool > selection > pause menu (never quits), Q/E rotate only while placing; tests + docs updated |
| 12 | Engineers (3): at least one keeps working the job, the others cover him when threatened | D (session C, branch sessionC/ws-d) | done (tested): zombies within 25 m of the job -> 1 works (fights only a zombie within 6 m not behind a wall), 2 cover between threat and worker (b6_engineer_auto 13/0) |
| 13 | Select squad → tower → "Occupy tower" → nothing happens | A | done (A): LMB/RMB on the tower = occupy, hover entry / panel button work, refused clicks now say why; tests/game/ui_tower.txt (11/11) |
| 14 | DOF: whatever is at the dead centre of the screen must be sharp | E (session B, branch sessionB/ws-e) | open |
| 15 | Garrison fortification must fit every building type; "Door planks" looks like a black blob in the street | C (session B, branch sessionB/ws-c) | WS-C: door barricades scaled into the art door leaf, flush (doors without an art leaf, mostly tower lobbies, keep the footprint-edge position); screenshots docs/review/ws-c/ |
| 16 | Each defence upgrade should make the building look visibly safer | C (session B, branch sessionB/ws-c) | WS-C: defence levels L1-L3 (bfortify / panel button), screenshots per level for house, mid-rise, tower in docs/review/ws-c/ |
| 17 | Garrison windows on every facade that has usable windows not blocked by neighbours; "Window planks" covers the closed windows on the lower floors, never the firing windows | C (session B, branch sessionB/ws-c) | WS-C: round-robin posts over facades, 4 m neighbour ray; window covers on closed ground / first-floor glass only (b6 checks cover_on_firing == 0) |
| 18 | Improve everything, make it playable, don't forget earlier items | all | see below |

Carried-over open items from earlier rounds (must not be forgotten):
- b1_resupply 9 fails (prices / supply point 2), b1_rooftops 1 fail (MG lands on the lower roof level) — B / A
- engineers listed as "rifleman" in the squad panel (fixed, A: shown as "engineer"); HUD clock reads 00:00 in headless runs — A: not reproducible now (headless shots show DAY 16:44, TimeOfDay advances per frame)
- possible soldier standing on a car roof (garrison shot) — D
- long-range squad hit rate 20 % (target was 45 %) — D: cause measured (12 of 39 rounds at already-killed locks); fixed: 0 at dead locks, 22 shots, 31.8 % (b5_long_range 6/0). 45 % not reached (spread / rounds in flight at 44-54 m)
- flamethrower test near walls / between cars not verified — D: b5_flame_obstacles runs to the end, 9/0
- car windshield glints not visible — E
- cloud drift and night not verified in screenshots — E
