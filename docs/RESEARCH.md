# Research — Phase 1 (engine foundation and GPU horde simulation)

Date: 2026-11-25. All repositories were shallow-cloned, and their LICENSE files and sources were read directly. Nothing below is taken from their READMEs alone. **No third-party crowd-simulation source code was copied into Tiny Tiny Zombies.** The simulation is an independent implementation of published algorithms, so none of the crowd repositories below create license obligations for us. Libraries we actually ship are listed in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## 1. Candidate repositories

| Repository | License (verified file) | What it is | Commercial reuse | Decision |
|---|---|---|---|---|
| [iodiot/webgpu-crowd](https://github.com/iodiot/webgpu-crowd) | MIT (`LICENSE`, `package.json`) | TypeScript/WebGPU boids steering, 10k default agents; grid counting sort (atomic count, single-workgroup scan, scatter) | Yes, keep notice | **Pattern only.** The counting-sort pipeline is the textbook approach (Green 2008), which we re-implemented. We changed three things: a multi-level scan for 65k+ cells, no per-cell cap (theirs silently drops neighbours beyond `MAX_PER_CELL=32`, fatal for piles), and agents are physically reordered. |
| [jsoulier/fluid_simulation](https://github.com/jsoulier/fluid_simulation) | Unlicense (`LICENSE.txt`) | C++23, **SDL3 GPU** 3D Eulerian stable-fluids (Stam), 128³ textures, red-black Gauss-Seidel; shadercross + JSON reflection loader | Yes (public domain) | **Pattern only.** It confirmed the SDL3 GPU structure we use: one compute pass per dependent dispatch, shadercross JSON reflection, committed precompiled shaders, red-black GS. The red-black idea fixed our Eikonal checkerboard (see the development log). |
| [daviskgit/continuum-crowd-simulation](https://github.com/daviskgit/continuum-crowd-simulation) | **No license file**, so all rights reserved | C++20 / OpenGL; Continuum Crowds (Treuille 2006) **entirely on the CPU** with FMM + heap, 128² grid | **No** | **Algorithm only, from the paper.** We use the density-dependent speed and cost ideas; none of its code was read for reuse. |
| [wayne-wu/webgpu-crowd-simulation](https://github.com/wayne-wu/webgpu-crowd-simulation) | BSD-3-Clause (`LICENSE.txt`, inherited from webgpu-samples) | WebGPU Position-Based Crowds (Weiss et al. 2017): short-range contacts with friction, long-range time-to-collision avoidance, XSPH; bitonic sort of whole 96-byte structs | Yes, with attribution | **Algorithm reference only.** It is the closest prior art for PBD crowds. Its bitonic sort (power-of-two padding, O(n log² n) dispatches) and grid without clearing are not suitable. |
| [gianmarcopicarella/crowd-simulation](https://github.com/gianmarcopicarella/crowd-simulation) | **No license file** (UE template + vendored nanoflann BSD) | Unreal Engine 5 Mass, CPU, KD-tree avoidance, "zombie horde shooter" | **No** | **Ignore.** Wrong engine, CPU-bound. |
| [TheSpydog/SDL_gpu_examples](https://github.com/TheSpydog/SDL_gpu_examples) | zlib | Official-style SDL3 GPU samples incl. `BasicCompute`, `DrawIndirect`, `PullSpriteBatch`, `CopyAndReadback` | Yes | **API reference.** It confirmed the `main0` MSL entry point convention and storage-buffer vertex pulling. |
| [vercidium-patreon/meshing](https://github.com/vercidium-patreon/meshing) | MIT | C# / OpenGL run-extension greedy mesher (not bitmask "binary greedy"), 32³ chunks, no AO | Yes, keep notice | **Deferred to stage 3/4** (voxel buildings). We would port or re-implement the idea in C++, and its vertex format needs repacking. |
| [spnda/fastgltf](https://github.com/spnda/fastgltf) | MIT (+ simdjson MIT, simdutf MIT) | Fast C++20 glTF parser; downloads simdjson/simdutf at configure time | Yes, three notices | **Not used yet.** cgltf is enough for small voxel assets with zero dependencies. Reconsider if load times matter (large city GLBs in stage 4). |
| [jkuhlmann/cgltf](https://github.com/jkuhlmann/cgltf) | MIT (embeds jsmn, MIT) | Single-header C99 glTF 2.0 / GLB parser | Yes | **Used** (`src/assets/Model.cpp`). |
| [libsdl-org/SDL](https://github.com/libsdl-org/SDL) | zlib | SDL 3.4.20 (newest stable tag); GPU API with Metal / Vulkan / D3D12 | Yes, no attribution required | **Used.** The SDL3 GPU API has no timestamp queries (confirmed in `SDL_gpu.h`), so GPU timings use fences. |
| [libsdl-org/SDL_shadercross](https://github.com/libsdl-org/SDL_shadercross) | zlib (tool) | SPIR-V → MSL/HLSL/DXBC/DXIL + JSON reflection; remaps descriptor sets to Metal `[[buffer(n)]]` exactly as SDL expects | Yes | **Used offline as a build tool** (`tools/compile_shaders.py`). Built with `SDLSHADERCROSS_DXC=OFF`; see §4. |
| [ocornut/imgui](https://github.com/ocornut/imgui) | MIT | v1.93.0 with `imgui_impl_sdlgpu3` (precompiled SPIR-V / MSL / metallib / DXBC shaders) | Yes, keep notice | **Used** for the debug UI. |

Answers to the brief's questions, for every promising implementation:

1. **Already implemented elsewhere:** 2D crowd steering (boids, PBD, continuum) and grid neighbour search. Nobody implements vertical stacking or agent piles; we confirmed in each repository that agents live on a plane.
2. **Commercial reuse:** MIT, BSD-3, zlib and Unlicense code would be allowed with notices. The two unlicensed repositories are not reusable. We reused **no code** from the crowd repositories.
3. **License obligations:** none from the research repositories, because no code was taken. For shipped libraries, see `THIRD_PARTY_NOTICES.md`.
4. **Portable to SDL3 GPU:** all algorithms are, as long as every dependent dispatch goes in its own compute pass (WebGPU orders dispatches implicitly; SDL3 GPU explicitly does not).
5. **Performance limitations seen:**
   - Per-cell neighbour caps (iodiot)
   - Bitonic sort with power-of-two padding (wayne-wu)
   - CPU FMM (daviskgit)
   - Single-workgroup scans limited to small grids
   - Advertised agent counts are for 2D steering only, with trivial rendering. They do not transfer to our 3D-contact workload.
6. **3D crowd accumulation:** none of them. This is our own design (§3).
7. **Reuse / adapt / implement:** we implemented everything independently, adapting published algorithms (§2).

## 2. Algorithms surveyed and how they are used

| Topic | Source | Use in Tiny Tiny Zombies |
|---|---|---|
| Continuum Crowds | Treuille, Cooper, Popović, SIGGRAPH 2006 | Density-dependent speed (`crowdP`) and congestion cost in the shared navigation field. We do **not** solve one potential per group per frame on the CPU. |
| Eikonal / fast marching / fast iterative method | Sethian 1996; Jeong & Whitaker 2008 (FIM) | GPU **red-black Gauss-Seidel upwind (Godunov) Eikonal** solve, incremental across frames (`nav_relax.comp`). |
| Position-Based Dynamics | Müller et al. 2007 | Jacobi PBD contact projection (`sim_solve.comp`). |
| Unified particle physics (mass scaling, friction, averaging) | Macklin et al. 2014 | Height-based mass scaling makes stacks converge in 3 Jacobi iterations; constraint averaging with SOR; support friction. |
| Position-Based Fluids | Macklin & Müller 2013 | Considered for the density constraint. Rejected for now: hard capsule contacts plus the density-speed law already give bounded compression (tests: < 0.1 % deep overlaps), and PBF adds a second neighbour pass. |
| Position-Based Crowds | Weiss et al. 2017 | Short-range contact model and friction; long-range avoidance is not needed for a zombie horde (pushing is the desired behaviour). |
| GPU spatial hashing / uniform grid | Green 2008 (CUDA particles); Hoetzlein 2014 (fast fixed-radius NN) | Counting sort: atomic histogram, 3-pass prefix sum, scatter that physically reorders agents. |
| Parallel prefix sum | Blelloch 1990; Harris et al. (GPU Gems 3) | 3-pass block scan (`scan_local`, `scan_blocks`, `scan_add`); handles any grid size. |
| GPU sorting | Merrill & Grimshaw (radix), bitonic | Not needed. Counting sort into cells is O(n) and is exactly the cell-range structure we need. |
| Flow-field navigation | Emerson ("Crowd Pathfinding and Steering Using Flow Field Tiles", Game AI Pro) | One shared field for all agents; bilinear sampling; no per-agent A*. |
| Granular piles, angle of repose | DEM literature; Macklin 2014 granular examples | Rounded capsule caps plus a friction cone (`supportCos`) produce angle-of-repose piles that slide off instead of forming towers. |
| Height-field crowd accumulation | (proposed in the brief) | Used **only for corpses**. Living agents get support from real neighbour contacts, so piles stay made of individually distributed bodies (no "lift the whole cell" artefact). |
| GPU-driven rendering, indirect draw | Wihlidal 2016 (GPU-driven pipelines) | Live/corpse counts never leave the GPU. Compute writes `SDL_GPUIndexedIndirectDrawCommand`s and `SDL_GPUIndirectDispatchCommand`s. |
| Hybrid agent + continuum | Narain et al. 2009 (Aggregate dynamics for dense crowds) | Inspiration for coupling: agent contacts locally, density/flow fields globally. |

## 3. Selected architecture (decision record)

**Decision:** a hybrid of individual agents and fields, fully GPU-resident:

- Per-step counting sort on a uniform 2D grid.
- Density field from the sort histogram.
- Shared Eikonal navigation field with congestion and climb cost.
- **Jacobi PBD on vertical capsules** (closest points between vertical segments). The same rule gives horizontal separation and 3D support, so stacking is physical, not scripted.
- Height-based mass scaling and support friction.
- A climbing state triggered by sustained pressure plus dense contacts, which climbs only onto actual neighbours.
- Persistent corpses: instances for rendering plus a fixed-point corpse height field for traversal.

**Alternatives considered:**

- *Pure continuum (fluid) crowd.* Rejected: the brief requires individual agents.
- *Height-field-only stacking*, where each cell's agents are lifted to a support height. Rejected: it produces synchronised vertical motion and smooth ramps, both of which the brief explicitly forbids.
- *Full rigid bodies.* Rejected: too costly, and not needed for the look.
- *Bitonic sort.* Rejected: O(n log² n) dispatches with power-of-two padding.
- *Plain Jacobi Eikonal.* Rejected after testing: it produced a checkerboard field and biased flow.

**Consequences:** cost per step is about 25–40 compute passes. That is fine on Metal and Vulkan, but pass overhead matters at small agent counts. Vertical stacking needs no extra neighbour pass (contact info comes from the last solver iteration). Corpses cost almost nothing while static.

## 4. Shader toolchain evaluation

- **Source language:** GLSL 4.50 (Vulkan dialect) following SDL3's binding convention:
  - Compute: set 0 for read-only, set 1 for read-write, set 2 for uniforms.
  - Graphics: sets 0/1 for vertex and sets 2/3 for fragment.
- **GLSL → SPIR-V:** `glslangValidator` (Khronos; build tool only).
- **SPIR-V → MSL + JSON reflection:** `SDL_shadercross` CLI.
  - It remaps descriptor sets to Metal indices: uniforms first, then read-only storage, then read-write storage. We verified this in the generated MSL.
  - Entry point becomes `main0`.
  - The JSON gives resource counts and thread counts, which the engine reads at load time, so there is no hand-maintained table.
- **Compiled outputs are committed** (`shaders/compiled/{spirv,msl,json}`). Building on macOS or Windows needs no shader tools; regenerating does (`tools/build_shadercross.sh`).
- **Windows:** SDL selects Vulkan with the same SPIR-V. **D3D12/DXIL** needs shadercross built with DXC (NCSA license; attribution needed only if `dxcompiler` ships with the game). This is deferred: Vulkan covers Windows for the vertical slice.
- **Upstream quirk:** the vendored shadercross build checks for the DXC submodule even with `SDLSHADERCROSS_DXC=OFF`. Our build script works around it with an empty stub `CMakeLists.txt`.
- **Not verified:** MSL generation was checked only syntactically, by inspecting the binding indices. It has **not been compiled by a Metal driver** in this environment (no macOS). See the README's validation status.

## 5. Dear ImGui evaluation

Used. `imgui_impl_sdlgpu3` renders with SDL3 GPU directly (precompiled shaders for SPIR-V/MSL/metallib/DXBC), so it fits the architecture with no extra graphics API. The cost is two small source files and one MIT notice.
