# Tiny Tiny Zombies — Game Design

Status legend: **APPROVED** = decided by the owner. **PROPOSED** = implementation idea awaiting owner review. **OPEN** = needs an owner decision. Balance values are never approved unless marked so.

## 0. Development gate (APPROVED)
Phase 7 runs in two stages. **Stage A** (military assets and animations) must be explicitly approved by the owner before any **Stage B** (gameplay) work starts. Silence, a successful build or the team's own judgement is not approval. Approval is recorded in `docs/ASSET_APPROVALS.md`.

## 1. Pillars (APPROVED)
- Endless military RTS / zombie apocalypse sandbox. No missions, campaign, timed rounds, forced wave breaks, victory screens, evacuation objective or formal ending.
- The player is a commander and controls no individual character.
- The player can lose soldiers, buildings and territory without the game ending.
- Both quiet, controlled operations and huge chaotic battles must be viable.
- Look: a living miniature voxel military diorama, matching the approved city, zombies, explosions and gore.
- References only, never to be recreated: Zombies Aren't Real (gameplay), Night of the Mini Dead (visuals), World War Z (hordes).

## 2. Economy (APPROVED rules; values OPEN)
- There is a single currency: military funding.
- Income comes from three sources:
  - base passive income over time;
  - passive income that grows with controlled territory;
  - bonuses for killing zombies.
- Everything is available from the start. There are no research trees, experience unlocks, tech progression or level gates. Progression is purely economic.
- Squads are bought with a one-time payment. There are no salaries or upkeep.
- Ammunition, reinforcements and construction cost money.
- All prices, rates, bonuses and stats are configurable. No final values are approved.

## 3. Infantry (APPROVED)

| Squad | Composition | Role |
|---|---|---|
| Rifle squad | 5 riflemen | General purpose: clearing and defence |
| Machine gun squad | 3 machine gunners | Sustained fire against dense hordes. High ammo use, loud |
| Sniper | 1 suppressed sniper | Quiet removal of isolated zombies. Can use rooftops. Much less noise |

- Squads are bought whole and are the unit of control.
- Every soldier has their own position, health, ammunition, animation state and behaviour. Soldiers die individually; the squad survives while members remain.
- Squads arrive by visible parachute drop at the chosen destination. They never spawn instantly on the ground.
- AI is autonomous. Soldiers detect, select targets, aim, fire, reload, manage ammo, navigate, collect ammo, return to supply points and respond to threats.
- The player orders squad movement. Orders stay responsive.
- AI must not get stuck, flip between targets or abandon orders. It uses a lightweight state machine.

## 4. Logistics (APPROVED)
- Ammunition is finite and physical. There is no global or magical refill, and no teleporting ammo into soldiers.
- **Central ammunition supply container:** bought and placed inside controlled territory. It is a separate physical asset, not a building role. Soldiers walk to it to refill.
- **Local ammunition airdrops:** bought and dropped near units. Crates descend by parachute and nearby soldiers collect from them.
- Supply inventories are tracked consistently.

## 5. Territory and walls (APPROVED)
- Walls are a free-form construction system: click or drag a path, preview it with its cost, then confirm.
  - Walls connect logically: no gaps, no overlaps, no invalid placement.
  - Walls physically block zombies. Navigation reacts to new and destroyed sections.
  - Hordes can overwhelm walls; walls are not invulnerable.
- A territory is **controlled** when its perimeter is fully enclosed **and** no living zombies remain inside it.
  - Shapes can be irregular, and there can be several separate controlled areas.
  - Territory is recalculated on build, destroy and breach.
  - Controlled territory raises passive income.
- **OPEN:** how income is temporarily lost and recovered after a breach. This must be proposed to the owner.

## 6. Buildings (APPROVED)
- Existing city buildings can be captured and given a role.
- Only two roles are approved:
  - **Garrison:** soldiers occupy the building and fire from suitable positions.
  - **Hospital:** treats wounded soldiers. **OPEN:** healing rate, capacity and behaviour need owner approval.
- No other roles are allowed: no factories, labs, workshops or resource buildings.
- Buildings can be fortified independently of perimeter walls, with barricades and reinforcements.

## 7. Vertical play (APPROVED)
- Soldiers can occupy rooftops and suitable interior positions.
- Zombies can approach and enter accessible buildings, breach barricades, move through interiors and between floors, reach rooftops and attack soldiers there. No position is invulnerable.
- Fortifications change access and defensive value.
- **PROPOSED (to be designed in Stage B):** building-local navigation with floor connectivity and explicit vertical transitions on top of the existing 2D height-grid sim. The current grid does not represent interiors.

## 8. Noise and threat (APPROVED)
- Zombie pressure is driven mainly by controlled-territory size and by the noise of player operations.
- Noise is spatial: gunfire and explosions attract zombies. Suppressed fire is much quieter, so quiet play stays viable.
- There are no numbered waves, and arbitrary time-based escalation must not be the main driver.

## 9. Horde (APPROVED)
- Keep the approved GPU horde simulation:
  - crowd flow and pressure;
  - accumulation at barriers;
  - reactions to explosions;
  - dismemberment;
  - persistent corpses and corpse-pile climbing.
- There is no per-zombie CPU pathfinding.
- Any gap between intended and actual behaviour must be verified and reported, not assumed.

## 10. World persistence (APPROVED goal; architecture PROPOSED)
- Moving the camera must not freeze operations or work as an exploit.
- Simulation level of detail: full detail near the action, reduced frequency for distant squads, aggregated distant zombies, persistent military/territory/ammo state.
- The architecture must be presented to the owner before invasive simulation changes.

## 11. UI (APPROVED)
- A clean RTS interface in the miniature style. It shows:
  - funding and income rate;
  - controlled territory and kills;
  - purchase, construction and supply options;
  - the selected squad's composition, health and ammo;
  - building roles.
- Readable previews for walls, drops and deployment, and clear feedback when something is invalid.
- Minimal clutter: the city and the action come first.

## 12. Performance (APPROVED)
- 60 FPS on the owner's Mac.
- Use instancing, shared meshes, spatial partitioning, local navigation updates, event-driven territory updates, simulation LOD and culling.
- Avoid global per-frame rebuilds, per-zombie CPU pathfinding, unbounded allocations and synchronous readbacks.
- Profile before optimising. Never extrapolate Linux software-renderer timings.

## 13. Out of scope this phase (APPROVED)
Military vehicles, tanks, helicopters, artillery, multiplayer, campaigns, story missions, tech trees, player-controlled characters, any extra infantry classes, any extra building roles.

## 14. Stage B order (APPROVED recommendation)
1. Infantry entities and squads
2. Parachute deployment
3. Selection and move orders
4. Autonomous combat and animation integration
5. Health, ammo and casualties
6. Supply container and airdrops
7. Walls and dynamic navigation
8. Territory and funding
9. Building capture and fortification
10. Vertical navigation and rooftops
11. Garrison and hospital
12. Noise and escalation
13. UI
14. Off-screen persistence
15. Integration, optimisation and polish

## 14b. Phase 7B additions (APPROVED 2026-11-27)
- Core loop: deploy soldiers → eliminate zombies → secure territory → increase funding → expand the army → secure more territory. Bigger operations make more noise and draw more zombies.
- Spending: squads, walls, building fortifications, ammo containers, ammo airdrops, replacement forces.
- Provisional balance values may be used for playtesting, but must be labelled UNAPPROVED. Duplicate kill rewards and obvious exploits must be prevented.
- Deployment sequence:
  1. placement preview;
  2. purchase confirmation and funding deduction;
  3. parachute descent;
  4. landing;
  5. canopy collapse and dissolve;
  6. recovery;
  7. squad formation;
  8. autonomous behaviour.
  Street and rooftop drops are allowed; invalid spots (inside solid geometry) are refused.
- Soldiers seek medical treatment when appropriate. AI must avoid endless target switching, getting stuck, oscillation, constantly interrupted animations, leaving positions without reason, and chasing distant zombies.
- Configurable weapon stats: damage, range, accuracy, fire rate, magazine capacity, reserve ammo, reload duration, noise intensity, target acquisition.
- Fire and reload events are synced to the approved animations. Hits use the existing zombie damage, blood, dismemberment and death systems.
- Container and crate inventories are finite. Several soldiers can share one supply point without getting stuck.
- Walls use the approved 1.6 m and 2.4 m gabion assets. Construction:
  - click and drag, with placement and cost previews;
  - segments and corners connect automatically, and placement is validated;
  - walls have health, collision, destruction and breaches;
  - navigation updates are local and event-driven.
  - **OPEN:** gate mechanics must be proposed to the owner before they become final design.
- Territory feedback states: unsecured / enclosed but uncleared / controlled / breached or threatened. Overlays must be subtle.
- Garrison flag: olive chevron. Hospital: green cross on white.
- Vertical play: start with one representative test building, then roll out to compatible buildings. Unsupported buildings must be documented.
- Noise events have configurable intensity, radius and duration. Spawn rates, noise propagation and territory-pressure curves are configurable.
- Horde: corpse piles, climbing and crawlers where supported. Walls must not be infinitely effective under mass pressure. Infantry combat integrates with vehicle chain explosions.
- Off-screen persistence: rendering and simulation are separate. **PROPOSED:** the architecture must be presented to the owner before invasive changes.
- UI shows:
  - funding, income rate, territory and kills;
  - purchase, wall and supply options;
  - the selected squad's composition, health and ammo;
  - building roles and warnings;
  - subtle squad status markers (low or out of ammo, casualties, moving, resupplying, under attack);
  - squad identification markers so machine-gun squads can be told from rifle squads at distance.
- No game-over screen: losses never end the game.
- Stress tests: 10 / 50 / 100 / 250 / 500 / 1,000 soldiers with growing hordes. These are not gameplay limits.
- Milestones:
  - **B1:** combat loop (squads, deploy, selection, orders, combat, health, ammo, resupply, funding, kills, essential UI).
  - **B2:** walls and territory.
  - **B3:** buildings and vertical play.
  - **B4:** noise, pressure, persistence, full UI, stress tests and polish.

## 14c. Owner decisions 2026-11-27 (APPROVED)
- Right mouse: a click is a move order, a drag pans the camera.
- Explosion kills pay a kill reward. The value is provisional.
- Dead soldiers rise again as tougher zombies (harder to kill). This is not instant: they lie dead first, then get up.
- Empty supply crates disappear.
- Ammo containers never disappear and can be used to wall things off: they are physical obstacles. They rotate during placement and arrive by parachute.

## 15. Progress and known limitations
- 2026-11-27: Milestone B1 playable (combat loop). Owner feedback: weapon tracers and brighter muzzle flashes; trees and props must not vanish when zoomed out; LOD near the focus area is too aggressive; sniper roof drops fail and a sniper landed inside a building; zombies should roam realistically instead of standing in tight clumps.
- 2026-11-27: Stage A approved by the owner. Stage B started on branch phase7b-gameplay.
- 2026-11-26: Stage A started. Building the Military Asset Lab and the model set. No gameplay implemented.
