# Owner feedback tracker (round 15, 2026-11-28)

Every item the owner raised in the latest play session. Each has an owner workstream (WS) and a status.
Nothing is "done" until it is built, tested, and shown in a screenshot. Earlier rounds: GAME_DESIGN.md §14b–14e.

| # | Owner item (condensed) | WS | Status |
|---|---|---|---|
| 1 | Clouds move too fast | orch | wind 3 → 0.8 m/s |
| 2 | UI must have a fixed size; content scrolls / moves, never resizes the panel | A | open |
| 3 | No "Unsupported – too tall" etc.: every building is supported and works | C (session B, branch sessionB/ws-c) | WS-C: all refusal paths removed, entrance added when none is usable (b6_garrison_all; ARCH §8 round 15). Zombie entry > 22 floors is still WS-B's limit |
| 4 | Units on roofs can go down: through a roof entrance if there is one, otherwise parachute (rappel) down | B | open |
| 5 | Zombies can fall off roofs and smash into gore | B | open |
| 6 | Roofs are like ground: place units, crates, towers, walls on roofs when there is space | B | open |
| 7 | Sniper killed by a zombie on a roof did not reanimate (soldiers must turn on roofs too) | B | open |
| 8 | Engineers and flamethrowers need autonomy: fix / clear what the situation needs, near their position, no wandering without orders | D (session C, branch sessionC/ws-d) | open |
| 9 | Tower / generator / floodlight / fuel models in game are not the reviewed ones | orch | reviewed models switched on (timber tower; owner to pick timber / steel) |
| 10 | Toxic gas = ugly particle blocks; must be voxel-volume gas clouds in the same style as the explosion / flame volumes | E (session B, branch sessionB/ws-e) | open |
| 11 | Keys 1 2 3 4 5 6 7 for units (not Z X C V B) – intuitive layout | A | open |
| 12 | Engineers (3): at least one keeps working the job, the others cover him when threatened | D (session C, branch sessionC/ws-d) | open |
| 13 | Select squad → tower → "Occupy tower" → nothing happens | A | open |
| 14 | DOF: whatever is at the dead centre of the screen must be sharp | E (session B, branch sessionB/ws-e) | open |
| 15 | Garrison fortification must fit every building type; "Door planks" looks like a black blob in the street | C (session B, branch sessionB/ws-c) | WS-C: door barricades scaled into the art door leaf, flush (doors without an art leaf, mostly tower lobbies, keep the footprint-edge position); screenshots docs/review/ws-c/ |
| 16 | Each defence upgrade should make the building look visibly safer | C (session B, branch sessionB/ws-c) | WS-C: defence levels L1-L3 (bfortify / panel button), screenshots per level for house, mid-rise, tower in docs/review/ws-c/ |
| 17 | Garrison windows on every facade that has usable windows not blocked by neighbours; "Window planks" covers the closed windows on the lower floors, never the firing windows | C (session B, branch sessionB/ws-c) | WS-C: round-robin posts over facades, 4 m neighbour ray; window covers on closed ground / first-floor glass only (b6 checks cover_on_firing == 0) |
| 18 | Improve everything, make it playable, don't forget earlier items | all | see below |

Carried-over open items from earlier rounds (must not be forgotten):
- b1_resupply 9 fails (prices / supply point 2), b1_rooftops 1 fail (MG lands on the lower roof level) — B / A
- engineers listed as "rifleman" in the squad panel; HUD clock reads 00:00 in headless runs — A
- possible soldier standing on a car roof (garrison shot) — D
- long-range squad hit rate 20 % (target was 45 %) — D
- flamethrower test near walls / between cars not verified — D
- car windshield glints not visible — E
- cloud drift and night not verified in screenshots — E
