# Development log

## 2026-11-25 — Phase 1, milestones A–E (first pass)

### Environment
- **Work container:** Linux x86-64, 4 vCPU (Xeon @ 2.1 GHz), 15 GB RAM, **no GPU, no macOS, no display**. GCC 13.3, Clang, CMake 3.28, Python 3.
- **Installed:** `mesa-vulkan-drivers` (lavapipe, Vulkan 1.4 on LLVM 20), `glslang-tools`, `spirv-cross`, X11 development headers.
- **Built from source as host tools:** SDL 3.4.20 and SDL_shadercross (SPIRV-Cross only, no DXC).
- **Consequence:** every GPU code path was executed for real through SDL3's Vulkan backend on a CPU-emulated device. Metal and the interactive window could not be exercised here.

### Milestone A — research and foundation
- Researched the ten candidate repositories in parallel and recorded licenses and capabilities in `docs/RESEARCH.md`.
  - Two have no license file (not reusable).
  - None implements vertical stacking.
  - No crowd code was copied.
- Chose GLSL → glslang → SPIR-V → shadercross → MSL/JSON, with committed outputs.
- Verified shadercross's Metal binding remap on generated MSL: uniforms `[[buffer(0)]]`, then read-only storage, then read-write storage.
- Built `GpuContext` (reflection-driven pipeline creation), `Camera`, `Model` (cgltf), and the instanced renderer.

### Milestone B/C/D — simulation (bugs found by the self-test, in order)
1. **Flow-field bias (8-neighbour Dijkstra).** Agents drifted toward −z and gathered at the intersection.
   - *Cause:* "steepest neighbour" chose the lowest absolute distance, which favours diagonals, and ties broke toward −z.
   - *Fix:* replaced with an isotropic upwind Eikonal update and upwind gradient directions.
2. **Checkerboard distance field.** The Jacobi Eikonal update (no self term) decouples odd and even cells. A dump of the field showed alternating rows.
   - *Fix:* red-black Gauss-Seidel in place, the pattern from jsoulier/fluid_simulation. It also converges about 2× faster.
3. **Half the agents never solved.** `sim_solve` used 128-thread groups while the shared indirect dispatch args assume 256. The unsolved half kept zero positions and "teleported" to the origin, which looked like a sink and like heavy interpenetration.
   - *Fix:* 256 everywhere. `GpuContext::loadCompute` now **asserts the expected workgroup width** from reflection, so this can't recur silently.
4. **Bit-packed desired velocity.** `packHalf2x16` stored through `uintBitsToFloat` can form denormal patterns that GPUs may flush to zero.
   - *Fix:* replaced with an angle + quantised-speed encoding that is always a normal float.
5. **Over-eager climbing and "popcorn" launches.**
   - Climbing now needs sustained pressure (0.6 s EMA, per-agent threshold) **and** at least 4 contacts.
   - Constraint-derived velocities are clamped for non-ballistic states. This removed 8 m towers.
6. **Mound at the goal.** The flow inside the goal pointed to its centre and crushed arrivals into a 7 m pile.
   - *Fix:* zero flow inside the goal (arrivals stop and mill).
7. **Corpse spikes.** Bodies settled where they died.
   - *Fix:* bodies now only settle on corpse slopes below the angle of repose and otherwise slide downhill. Peaks remain only against the wall, where they form a ramp, as intended.

Self-test after the fixes (6,000 agents, wall siege, 30 s): 2,000+ elevated, 99.9th-percentile feet at 5.2 m, < 0.1 % floating, 0 wall penetrations, ~2,500 agents over the wall. The explosion opens a hole (358 → 169 within 4 m); the local pile collapses (444 → 6 elevated) and refills (305). Eight blasts produce 2,500+ corpses and ramps that living zombies walk on.

### Rendering
- **Inverted back-face culling.** Close-up screenshots showed the insides of heads. The box triangles were wound clockwise from outside, but glTF requires CCW. Fixed in the generator and in the cube mesh; the buildings had been showing interior faces too.
- **Overpacked spawns.** Spawn rects were sized for about 17 agents/m², 4× physical packing, so agents popped into layers at once. Spawn areas were resized for realistic densities, and spawning retries positions instead of dropping agents that land in buildings.
- **Arena map added.** The city streets hold only about 20k agents at full packing, so large-count benchmarks would otherwise measure absurd stacking.
- **Camera.** It now tilts up rather than entering a building (buildings stay opaque, per the brief).
- **Crash with unbounded frames in flight.** Headless runs without a swapchain queued hundreds of frames; lavapipe/SDL then crashed in descriptor allocation. Headless mode now waits each frame. Windowed mode is paced by the swapchain. Watch for this on other drivers.

### Open issues / next steps
- Run `ttz_selftest`, the interactive app and `ttz --bench` on the development Mac (Metal). Fill in `docs/BENCHMARKS.md`.
- **Windowed path smoke-tested under Xvfb + lavapipe:** window, swapchain, ImGui panel, flow overlay, async stats (`docs/media/debug_ui_xvfb.png`). Real mouse/keyboard input is not yet exercised.
- Fixed `--config` with absolute paths, which silently fell back to defaults. Missing parameter files are now logged.
- Profiling on lavapipe: the navigation sweeps are about 50 % of the fixed simulation cost (see `docs/BENCHMARKS.md`). If that holds on Metal, update navigation every few steps.
- D3D12 backend: needs DXIL via shadercross + DXC.
- Corpse instance buffer: 262k capacity. On overflow, height still accumulates but bodies are not drawn. Aggregation (merged corpse meshes) is a later optimisation.
- No shadows yet. Riders on very dense but slowly moving crowds can be more numerous than desired; tune `climbBlockThreshold` and `supportCos` on real footage.

## 2026-11-25 — Phase 3: approved character integration and GPU optimisation

Branch `phase3-character-integration`, based on `phase1-engine-foundation`. Same environment as phase 1: Linux, Mesa lavapipe, no GPU and no Mac. Every timing in this phase is CPU-emulated; see BENCHMARKS.md.

### Milestone A — baseline and source inspection
- **Source:** the approved Zombie Lab (published artifact version `1795598197-2ad0`) was fetched and its script compared byte-for-byte with the local copy (identical). It is stored as `assets/characters/source/zombie_lab_v3.html`.
- **Baseline:** the phase-1 self-test passes (111 s). The phase-1 placeholder benchmark was re-run on the same CPU type (`docs/benchmarks/phase3/baseline_phase1.*`).
- **Engine inspection:** the parts that matter for this phase were:
  - Agents are an 80-byte AoS record sorted every step.
  - Corpses are 32 bytes.
  - The placeholder renderer draws one indexed indirect call for zombies and one for corpses, with appearance from an 8-bit palette row.

### Milestone B — conversion
- `tools/convert_characters.mjs` cuts the Lab's definition section out of the approved HTML and runs it in a Node sandbox, so there is no reconstruction from screenshots.
- It bakes 2,277 segment meshes (10 slots × modules × stump state × 33 decoration variants) at three levels and **verifies every greedy mesh against the per-voxel faces**. Output is deterministic (identical md5 across runs).
- One fix: generated palette constants were first *truncated* to 4 decimals; they are now rounded to 6.

### Milestone C — integration
- **Appearance:** 56 bits of look are packed into the agent's spare bits, so the record stays 80 bytes with no extra sort bandwidth. Corpses carry the same bits, and reactivated corpses keep them.
- **Generation:** at spawn, on the GPU, with six weighted categories and the Lab's symmetry and garment rules.
- **Rendering:** GPU cull → size-class compaction → per-character pose → vertex-pulling draws. The placeholder path stays selectable.
- **Animation:** the Lab's walk, reach and idle curves are blended by speed and crowd pressure, plus climb, flail, dying and 64 baked corpse poses.
- **Validation tools:** the Zombie Lab capture tool and comparison sheets (`docs/media/phase3/compare`). Geometry, joints, materials and decoration match; lighting differs by design.
- **New regression tests (self-test groups 6–8):** appearance ranges and distribution, culling and compaction exactness, joint continuity in all 8 animation states, and corpse appearance retention. The phase-1 tests (groups 1–5) still pass unchanged.

### Problems found while integrating
- **Weak test setup:** the corpse-retention test first used four blasts in a sparse crowd and produced only 3 corpses. The blasts are now aimed at actual zombies (426 corpses).
- **Frames in flight:** carried over from phase 1. Headless runs must pace frames on lavapipe.
- **Fourth geometry level.** Greedy merging by material was limited by decorated zombies (noise and speckles split faces). Level 3 merges by AO only and looks up the material per voxel in the fragment shader; the converter verifies it lossless. Triangles for the whole library: 110,608 → 46,284.
- **Magenta edge pixels at level 3.** MSAA edge samples extrapolated the rest position outside the face, so the lookup hit an empty cell. Fixed with `centroid` interpolation plus a fallback step back into the face's voxel. The comparison sheets now contain zero invalid pixels.
- **Stale shaders at run time.** Shaders were copied next to the binary only on relink, so a shader-only change ran old code. Replaced by an always-run `ttz_runtime_data` copy target.
- **Occlusion culling.** Conservative box test, verified by a new self-test (every culled zombie is checked at 64 sample points). City 10k frame 433 → 246 ms.
- **Benchmark bug:** the city scenario never received occluders, because the benchmark started on the city map and uploads happened only on map change. Fixed (occluders are set after init) and the city rows re-measured.
- **Benchmark bug:** the first off-screen camera still saw part of the horde. Re-framed and re-measured; the old rows were removed.

### Media
- `docs/media/phase3/compare/`: Zombie Lab vs engine sheets for 12 views.
- `docs/media/phase3/states/`: climb, flail, dying, corpse and settled corpse poses, and a random appearance grid.
- `docs/media/phase3/gameplay_avenue.png`, `gameplay_siege.png`, `gameplay_corpses.png`: gameplay distance, final renderer.

### Not done / open
- No Metal measurement; Mac commands are in BENCHMARKS.md.
- D3D12 backend not built or tested.
- Lighting differs from the Lab (engine sun and ambient vs three.js lights); geometry, materials and noise are exact.

## 2026-11-25 — Phase 4: gore, game feel, fixes from the first Mac session

Branch `phase4-gore-and-feel`, based on `phase3-character-integration`. The owner's first Mac session: phase 3 ran on Metal on the first try, with 10,000 zombies at 105–126 FPS (see BENCHMARKS.md). Feedback: "I hate the spinning when they are touching the walls", plus a request for blood, detachable limbs, and more satisfying, optimised and better-looking effects.

### The spinning (root cause, measured)
- A dying body's roll angle was `timer × (2..5 rad/s)`: unbounded, and its limbs flailed on a clock. A body settled only when grounded and slow, otherwise after an 8 s timeout.
- **Measured** with the new `--trace` (city wall siege, one blast, 90 killed): about 60 bodies never met the settle rule. They lay on the crowd or jammed against the wall and kept rolling and flailing until the 8 s timeout.
- **Fix:**
  - The tumble is now simulated (`dirs.xy` while FALLING/DYING): blasts set the spin, contact brakes it, and the body rolls onto its front or back.
  - Flailing scales with speed and goes limp at rest.
  - Bodies that lie still on other bodies or against a wall settle after 1.5 s (timeout 4 s).
  - The corpse keeps the heading and front/back side it came to rest with.
- **Result:** the same scene settles everything within 4 s, 90 % within ~1.8 s. A regression test checks that ≤ 15 % are still tumbling 2.5 s after a blast (measured 6–11 of ~105).

### Gore
- **Data:** severed-segment mask, bloodiness and tumble state are packed into existing agent and corpse fields, so the agent is still 80 bytes. Particles, gibs and decals are GPU ring buffers and grids (ARCHITECTURE.md).
- **Body parts:** severed parts use the exact approved segment meshes. They render through the character pipeline as one-segment characters, with raw flesh painted at the cut joints.
- **Bug found by the new test:** parts torn off by a blast also received that blast's impulse in the gib pass of the same step. They were launched twice (up to ~36 m high) and were still in the air 4.5 s later. Fixed: parts created this step are skipped, speed is capped at 16 m/s, and a little air drag is added. 792 of 796 parts now rest after 4.5 s.
- **Tuning from screenshots:**
  - The first version sprayed up to 12 bright, stretched droplets per zombie hit, which looked like red rain. Now it sprays 0.3–5 dark droplets, with less stretch.
  - Smoke puffs over 1 m looked like floating boulders, so they were made smaller and shorter-lived.

### Looks and feel
- **Moon shadows** of all static boxes come from a precomputed shadow height field: exact for boxes, one lookup per fragment.
- **Screen shake** on explosions (interactive only; headless captures and benchmarks are unaffected).
- **Explosions:** voxel fireball, smoke, debris, sparks, and a persistent scorch decal (replaces the 20 s fake scorch).

### Optimisation
- **Indexed quads.** Every face's two triangles are re-joined into a 4-vertex quad with an order that reproduces the same two triangles (same winding and diagonal). Each face is drawn with a static index pattern. All four geometry levels pair up completely. Vertex-shader invocations drop by 33 % (self-test: 3.13 M → 2.09 M for 5,000 zombies) with identical triangles.

### Tests
- **New checks:** bodies stop tumbling quickly; limbs come off as body parts; parts stay finite and above ground, and come to rest; blood lands as decals; blasts leave scorch; legless zombies crawl; indexed quads draw the same triangles with fewer invocations.
- All 57 checks pass (lavapipe).
