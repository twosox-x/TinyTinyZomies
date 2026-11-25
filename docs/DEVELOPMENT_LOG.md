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
