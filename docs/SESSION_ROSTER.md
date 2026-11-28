BROADCAST FROM SESSION A (COMMAND CENTER) TO ALL SESSIONS. This is the official roster. Read it and reply with a one-line ack.

== SESSIONS (address with send_message) ==
A  Command center  session_01N78bVvgvANUuwvQGr62ESp  Branch phase7b-gameplay (integration). Only A pushes to it. Nobody touches main.
B  Gameplay visuals and buildings  session_01N78bVtBvLipdR2wi72Ftab  Branches sessionB/ws-c, sessionB/ws-e, sessionB/ws-e2
C  Squad AI  session_01N78bVs9MY7cSjnYdRo3dHc  Branch sessionC/ws-d
D  Sound design  session_01N78bVvYf5jUq6QpVNbzaPi  Branch sessionD/sound
E  UI design  session_01N78bVvXrxRXPMzr3mUn8CK  Branch sessionE/ui

== WHO OWNS WHAT (do not do another session's work) ==
A / WS-A  UI function. Fixed-size panels, number keys 1-7, tower "occupy" bug, squad panel class names, HUD clock, b1_resupply / b1_rooftops failures.
          Files: HudBar.cpp, GameUI.*, UiActions.h, input/hotkeys, StructuresGame.cpp, TimeOfDay wiring.
A / WS-B  Rooftops. Roofs work like ground for placement, getting down (stairs, or parachute from roofs without access), zombies falling and gore, soldiers reanimating on roofs.
          Files: NavGrid.*, Deploy.*, Logistics.*, RoofScript.cpp, HordeVertical / sim_*.comp, reanimation, structure placement validation.
A         Merging, the final full test pass, shared files (GameWorld.cpp, GameScript.cpp, Config.*, CMakeLists.txt, App.cpp), docs/OWNER_FEEDBACK_TRACKER.md structure, release notes.
B / WS-C  Buildings. Every building garrisonable, windows on all unblocked facades, window/door planks placed correctly, visible upgrade levels.
          Files: Buildings.*, BuildingPlay.*, BuildingGame.*, FortUI.cpp.
B / WS-E  Voxel-volume toxic gas. Files: gas shaders, CorpseGasRender.*, fx_volume use for gas.
B / WS-E2 DOF centre focus, windshield glints, cloud shadow checks. Files: Renderer.* (DOF), DOF shaders, city.frag glassDay(), lighting.glsl cloudShadow.
C / WS-D  Engineer and flamethrower autonomy, 1 worker + 2 cover, long-range dead-lock firing, b5_flame_obstacles, soldiers on cars.
          Files: EngineerAI.*, FlameAI.*, SoldierAI.*, Combat.*.
D         Sound. Phase 1: HTML preview of real CC0 / CC-BY sounds, miniature treatment, owner approval. Phase 2, only after approval: src/audio/* plus ONE event API agreed with A.
          No game code until then.
E         UI visual design. Phase 1: HTML preview, owner approval. Phase 2, only after approval and after A says WS-A has merged: restyle the HUD through the existing UiActions API.
          Until then, NO src/game edits. Screenshots: branch review/screens.

== RULES FOR EVERYONE ==
1. Stay inside your files. To change a file you don't own, message A first and wait for a yes. Shared files only get minimal hooks, and you tell A about them.
2. Parallelism: each session runs its own sub-agents, one per workstream or file group, at most about 3 heavy agents per 4-core box. Keep your main thread free to coordinate and reply.
3. Integration: about every 30 minutes, or whenever a piece passes its tests:
   git fetch origin && git rebase origin/phase7b-gameplay
   then push your branch, and send A one line: branch, commit, what passed.
   A merges continuously. In a rebase conflict on a file you don't own, take the phase7b-gameplay version and tell A.
4. Done means: built with 0 new warnings, tests passing (with numbers), screenshots, and your tracker row updated. Untested is not done. Software-renderer (lavapipe) timings are never Mac performance.
5. Owner rules:
   - Voxel-miniature aesthetic.
   - Zero clipping or z-fighting.
   - Never redesign approved assets (zombies, downtown, military models and animations).
   - No recreations of existing games.
   - Balance values stay UNAPPROVED.
   - Previews (sound, UI, new models) need explicit owner approval before they go in game.
6. Efficiency: the owner is strict about time and credits.
   - No gold-plating, no idle waiting, no duplicate exploration.
   - Report blockers to A immediately.
   - If you finish early, tell A and you'll get the next item.

Reply to A with: "ack <session letter>, <N> agents: <one line on what each does>".
