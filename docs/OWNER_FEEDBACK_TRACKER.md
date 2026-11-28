# Owner feedback tracker (round 15, 2026-11-28)

Every item the owner raised in the latest play session. Each has an owner workstream (WS) and a status.
Nothing is "done" until it is built, tested, and shown in a screenshot. Earlier rounds: GAME_DESIGN.md §14b–14e.

| # | Owner item (condensed) | WS | Status |
|---|---|---|---|
| 1 | Clouds move too fast | orch | wind 3 → 0.8 m/s |
| 2 | UI must have a fixed size; content scrolls / moves, never resizes the panel | A | done (A): bar = 7 fixed card slots (scrolls), selection panel fixed height (list scrolls, icon buttons when crowded), fixed-width notices; sizes in `hudsz` (HudBar.cpp); shots wsA/ |
| 3 | No "Unsupported – too tall" etc.: every building is supported and works | C (session B, branch sessionB/ws-c) | WS-C: all refusal paths removed, entrance added when none is usable (b6_garrison_all; ARCH §8 round 15). Zombie entry > 22 floors is still WS-B's limit |
| 4 | Units on roofs can go down: through a roof entrance if there is one, otherwise parachute (rappel) down | B | done: stairs via roof hatch + door (both ways), else edge jump with the approved parachute (b6_roof_descend 6/6); stair transit not drawn as interior |
| 5 | Zombies can fall off roofs and smash into gore | B | done: edge falls are free falls, impact > 10.5 m/s = death, limbs off, blood + dust, blood pool, corpse (b6_roof_fall); only crowd pushes send them over (no deliberate chase jumps) |
| 6 | Roofs are like ground: place units, crates, towers, walls on roofs when there is space | B | partly: structures, crates, walls accepted on one roof level, refused over the edge (b6_roof_place, cheat build); engineer access to roof jobs NOT DONE |
| 7 | Sniper killed by a zombie on a roof did not reanimate (soldiers must turn on roofs too) | B | done: elevated bodies rise on their own level (b6_roof_reanim 8/8) |
| 8 | Engineers and flamethrowers need autonomy: fix / clear what the situation needs, near their position, no wandering without orders | D (session C, branch sessionC/ws-d) | open |
| 9 | Tower / generator / floodlight / fuel models in game are not the reviewed ones | orch | reviewed models switched on (timber tower; owner to pick timber / steel) |
| 10 | Toxic gas = ugly particle blocks; must be voxel-volume gas clouds in the same style as the explosion / flame volumes | E (session B, branch sessionB/ws-e) | built + tested (tests/game/e1_gas_volume.txt 3/3, day and night): translucent DDA voxel fog (shaders/gas_volume.*), legacy puffs behind CorpseGasRender::voxelFog; shots docs/review/ws-e/gas_*; owner to review |
| 11 | Keys 1 2 3 4 5 6 7 for units (not Z X C V B) – intuitive layout | A | done (A): 1-7 = cards of the active tab (number on each card), Tab/Shift+Tab tabs, Ctrl+1-9 squads, . next squad, Esc tool > selection > pause menu (never quits), Q/E rotate only while placing; tests + docs updated |
| 12 | Engineers (3): at least one keeps working the job, the others cover him when threatened | D (session C, branch sessionC/ws-d) | open |
| 13 | Select squad → tower → "Occupy tower" → nothing happens | A | done (A): LMB/RMB on the tower = occupy, hover entry / panel button work, refused clicks now say why; tests/game/ui_tower.txt (11/11) |
| 14 | DOF: whatever is at the dead centre of the screen must be sharp | E (session B, branch sessionB/ws-e) | open |
| 15 | Garrison fortification must fit every building type; "Door planks" looks like a black blob in the street | C (session B, branch sessionB/ws-c) | WS-C: door barricades scaled into the art door leaf, flush (doors without an art leaf, mostly tower lobbies, keep the footprint-edge position); screenshots docs/review/ws-c/ |
| 16 | Each defence upgrade should make the building look visibly safer | C (session B, branch sessionB/ws-c) | WS-C: defence levels L1-L3 (bfortify / panel button), screenshots per level for house, mid-rise, tower in docs/review/ws-c/ |
| 17 | Garrison windows on every facade that has usable windows not blocked by neighbours; "Window planks" covers the closed windows on the lower floors, never the firing windows | C (session B, branch sessionB/ws-c) | WS-C: round-robin posts over facades, 4 m neighbour ray; window covers on closed ground / first-floor glass only (b6 checks cover_on_firing == 0) |
| 18 | Improve everything, make it playable, don't forget earlier items | all | see below |

Carried-over open items from earlier rounds (must not be forgotten):
- b1_resupply 9 fails, b1_rooftops 1 fail — A: resolved. resupply: a click on a parked car is no longer refused (14e surface snap lands beside it, intended) so the test bought an extra squad and ran out of money; the refused case is now a drop outside the simulated area (23/23). rooftops: the sniper is not an MG on a lower level; the 147 m level is gone from the map (every drop on that top lands at 143.95), expectation updated in b1_rooftops and b3_roof_levels
- engineers listed as "rifleman" in the squad panel (fixed, A: shown as "engineer"); HUD clock reads 00:00 in headless runs — A: not reproducible now (headless shots show DAY 16:44, TimeOfDay advances per frame)
- possible soldier standing on a car roof (garrison shot) — D
- long-range squad hit rate 20 % (target was 45 %) — D
- flamethrower test near walls / between cars not verified — D
- car windshield glints not visible — E: vehicle glass lighter + sun sparkle (ws-e2), docs/review/ws-e/glass_*
- cloud drift and night not verified in screenshots — E: verified (ws-e2): 0 / 2.5 / 5 s sequence docs/review/ws-e/clouds_*; at 23:00 clouds on vs off render pixel-identical
