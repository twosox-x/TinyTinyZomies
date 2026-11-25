# Character rendering optimisation (phase 3)

The goal was maximum performance **without** changing the approved characters. Every optimisation below is lossless:

- geometry is verified face-for-face against Zombie Lab's own mesher output (`tools/convert_characters.mjs`);
- joints are verified in every animation state (self-test group 7);
- the visual comparison sheets (`docs/media/phase3/compare/`) contain zero invalid pixels.

**Important limitation.** All timings here come from Mesa **lavapipe**, a software Vulkan driver on 4 CPU cores. It rasterises on the CPU, so its draw times scale with pixels × MSAA samples × triangles in a way no Apple GPU does. Use the ratios between configurations as evidence of *direction and relative size*, not as Mac frame rates. The Mac numbers have to be measured with the commands in [BENCHMARKS.md](BENCHMARKS.md).

## What was measured, and how

`ttz --bench` measures each frame as three separately fenced submissions:
- **sim:** one simulation step;
- **char:** the character cull, compaction and pose compute passes;
- **draw:** the scene render pass.

Exact counters (visible characters, segments, useful triangles, vertex-shader invocations including padding) are read from the GPU after measuring. Conditions were identical across configurations: same binary, 1280×720, 4× MSAA, same camera per scenario, same spawn areas, 15 measured frames after warm-up, all simulation features on (vertical accumulation, corpses, explosions in the siege).

### Configuration ladder, 10,000 zombies (lavapipe, 1280×720, 4× MSAA)

| Configuration | Scenario | Visible | Draws | Triangles | Sim ms | Char ms | Draw ms | Frame ms (avg / p95) | vs naive |
|---|---|---|---|---|---|---|---|---|---|
| phase-1 placeholder | dispersed | 10000 | 4 | 2.40 M | 16.8 | 0.1 | 401 | 419 / 524 | 41.3× |
| phase-1 placeholder | siege | 10000 | 4 | 2.40 M | 19.0 | 0.2 | 485 | 505 / 551 | 36.0× |
| approved, before optimisation (naive cubes, pose per vertex, family batches) | dispersed | 10000 | 8 | 24.05 M | 17.7 | 3.8 | 17295 | 17318 / 19012 | 1.0× |
| approved, before optimisation (naive cubes, pose per vertex, family batches) | siege | 10000 | 8 | 24.06 M | 19.8 | 3.4 | 18164 | 18188 / 19309 | 1.0× |
| + hidden faces removed, pose once per character | dispersed | 10000 | 8 | 8.52 M | 18.6 | 4.7 | 1450 | 1474 / 1916 | 11.7× |
| + hidden faces removed, pose once per character | siege | 10000 | 8 | 8.51 M | 17.9 | 4.3 | 1277 | 1299 / 1499 | 14.0× |
| + greedy merge by material | dispersed | 10000 | 8 | 4.20 M | 18.3 | 4.7 | 968 | 991 / 1216 | 17.5× |
| + greedy merge by material | siege | 10000 | 8 | 4.18 M | 19.0 | 4.8 | 920 | 945 / 1054 | 19.3× |
| + size-class batching | dispersed | 10000 | 13 | 4.19 M | 16.6 | 4.4 | 744 | 766 / 968 | 22.6× |
| + size-class batching | siege | 10000 | 13 | 4.20 M | 19.0 | 4.6 | 760 | 784 / 872 | 23.2× |
| + GPU frustum culling | dispersed | 8822 | 13 | 3.69 M | 16.1 | 4.1 | 723 | 744 / 906 | 23.3× |
| + GPU frustum culling | siege | 6846 | 13 | 2.87 M | 15.5 | 3.2 | 811 | 830 / 1024 | 21.9× |
| **+ greedy by AO with voxel materials (final)** | dispersed | 8765 | 10 | 1.70 M | 15.3 | 4.0 | 455 | 474 / 571 | 36.5× |
| **+ greedy by AO with voxel materials (final)** | siege | 6836 | 10 | 1.32 M | 18.2 | 3.5 | 547 | 570 / 612 | 31.9× |
| final, but pose per vertex (comparison) | dispersed | 8774 | 10 | 1.70 M | 19.8 | 3.5 | 1440 | 1464 / 1785 | 11.8× |
| final, but pose per vertex (comparison) | siege | 6853 | 10 | 1.33 M | 19.7 | 3.4 | 1221 | 1245 / 1424 | 14.6× |

Raw data: [`benchmarks/phase3/ladder_10k.csv`](benchmarks/phase3/ladder_10k.csv). The *triangles* column counts useful triangles of visible characters only; the placeholder row counts 240 per zombie.


## The optimisations, in order of measured impact

1. **Compute the pose once per character, not per vertex, and remove hidden faces.** Draw time went from 17,295 to 1,450 ms (11.9×; siege 14.2×). Both changes ship together in the ladder. Their individual share shows in the last row: re-enabling per-vertex pose on the final geometry costs 3.2× draw time (dispersed) and 2.2× (siege). Naive cubes alone carry 2.8× the triangles of the culled level.
2. **Greedy merging, then voxel materials.** Lossless, and verified. Greedy by material: 1,450 → 968 ms (−33 %). Merging by AO only, with the material looked up per voxel in the fragment shader: 723 → 455 ms (−37 % dispersed, −33 % siege). It roughly halves the triangles of decorated zombies (Street Walker 496 → 222, Rotter 572 → 238).
3. **Size-class batching.** Vertex-shader work went from 2.08× to 1.08× the useful vertices; draw time 968 → 744 ms (−23 %). That is 11 draw calls instead of 6.
4. **GPU frustum culling.** Depends on the view. In the overview camera only 12 % (dispersed) and 31 % (siege) of zombies were outside the frustum: dispersed 744 → 723 ms; the siege difference (760 → 811 ms) is within frame-to-frame noise. The off-screen scenario in the sweep shows the large case. The culling compute cost is included in the *char* column (3–5 ms at 10k on lavapipe, whichever configuration).
5. **Conservative occlusion culling behind buildings.** In the city view at 10,000 zombies, draw time fell from 415 to 228 ms and the frame from 433 to 246 ms (−43 %). Details below.
6. **Unchanged simulation.** The *sim* column stays at 15–20 ms in every configuration, as in phase 1. Character work never touches the simulation passes.

**Net result at 10,000 zombies, overview camera.** Approved characters before optimisation: 17,318 ms per frame. After: 474 ms (37× faster). Phase-1 placeholder: 419 ms. The approved characters now cost 13 % (dispersed) / 13 % (siege) more draw time than the placeholder, while drawing 1.70 M instead of 2.40 M triangles. The extra cost is per-fragment work: the material lookup, the Lab noise, and more distinct faces in the frame.

## Exact geometry and work counts

These numbers do not depend on the driver.

| Level | Triangles, whole library | Office Drone / Street Walker / Rotter | Random crowd of 5,000 |
|---|---|---|---|
| naive cubes | 523,020 | 2,424 / 2,616 / 2,076 | 12.0 M |
| hidden faces removed (= Zombie Lab's mesher) | 186,332 | 856 / 904 / 780 | 4.26 M |
| greedy by material | 110,608 | 280 / 496 / 572 | 2.10 M |
| **greedy + voxel materials (shipped)** | **46,284** | **172 / 222 / 238** | **0.97 M** |
| *phase-1 placeholder, for reference* | | *240 per zombie* | *1.2 M* |

| Batching (5,000 zombies, final geometry) | Draws | Vertex-shader invocations | Useful vertices | Overhead |
|---|---|---|---|---|
| one batch per body-part family | 6 | 6.03 M | 2.90 M | 2.08× |
| **vertex-count size classes (×1.35)** | **11** | **3.13 M** | 2.90 M | **1.08×** |

| Memory | Size |
|---|---|
| packed vertex | 4 B (vs. 36 B for a float position, normal and colour vertex: 9×) |
| level-3 vertices for the whole library | 0.54 MB, plus 0.3 MB of voxel material grids |
| segment instance | 32 B (half-float quaternion, translation, mesh id + slot, appearance word) |
| per-character appearance | 0 extra bytes (56 bits in spare bits of the existing 80-byte agent record) |
| corpse record | 32 B (unchanged size, now carries the full appearance) |
| character render buffers at 131,072 visible capacity | 47 MB (dominated by 42 MB of segment-instance space) |

**CPU → GPU transfer per frame** is independent of zombie count:

| Item | Size |
|---|---|
| simulation uniform pushes | 31 × 592 B = 18.4 KB per step |
| character uniform pushes | 4 × 144 B + 11 × 32 B = 0.9 KB |
| frame uniforms | 2 × 1,168 B = 2.3 KB |
| counter reset | 192 B, a GPU-side copy from a static zero buffer |
| asynchronous statistics readback | 256 B |

There are no per-zombie or per-segment uploads, and no synchronous readbacks during gameplay.

## Occlusion culling and the off-screen case

**Test.** `char_cull.comp` hides a zombie only when all 8 corners of its bounding box are behind the *same* building box, seen from the camera. A box is convex, so if every corner's sight line hits it, the whole zombie is hidden. The test can therefore never hide a visible zombie (self-test: every culled zombie is checked at 64 sample points). Occluders are the sandbox's static boxes at least 3 m tall, uploaded when the map changes.

**How much it could cull.** A separate, exact per-zombie study in the benchmark (`city` scenario) found that 63–67 % of the zombies inside the frustum are completely hidden by buildings. The conservative test culls 63 % of them (10k: 5,843 → 2,155 drawn), so it captures almost all of the available savings.

| City, lavapipe 1280×720 4× MSAA | Drawn | Triangles | Char ms | Draw ms | Frame ms (avg / p95) |
|---|---|---|---|---|---|
| 1,000, frustum only | 607 | 0.12 M | 1.0 | 135 | 152 / 234 |
| 1,000, + occlusion | 208 | 0.04 M | 0.6 | 109 | 124 / 139 |
| 5,000, frustum only | 2,995 | 0.58 M | 1.6 | 267 | 283 / 349 |
| 5,000, + occlusion | 1,075 | 0.21 M | 1.2 | 186 | 204 / 246 |
| 10,000, frustum only | 5,843 | 1.13 M | 2.8 | 415 | 433 / 487 |
| 10,000, + occlusion | 2,155 | 0.42 M | 1.5 | 228 | 246 / 297 |

In the open arena (dispersed and siege), there is almost nothing to occlude. There the occlusion test cost stays inside the char column's noise: 50k dispersed 19.7 → 17.9 ms, 50k siege 12.8 → 13.0 ms.

**Off-screen horde.** With the camera turned away from 50,000 zombies, the final path draws 0 characters. The frame costs 60 ms, of which draw is 35 ms (ground and buildings only) and char 0.7 ms. The placeholder, which has no culling, draws all 50,000 and costs 786 ms.

Raw data: `occlusion_city.csv`, `offscreen.csv`, `final_arena.csv`, `final_sweep.csv`, `placeholder_sweep.csv` in [`benchmarks/phase3/`](benchmarks/phase3/). Full tables are in [BENCHMARKS.md](BENCHMARKS.md).

## Rejected or deferred approaches

| Approach | Why not (measured or reasoned) |
|---|---|
| Evaluating the joint hierarchy per vertex | Measured 3–4× slower draw (`final-posevs` vs `final`); the compute pose pass costs a few ms at 10k on lavapipe. Kept as a toggle. |
| One indexed draw per segment mesh | Up to 2,277 indirect commands, or `first_instance`, which SDL documents as non-portable (D3D12). Size classes get within 8 % of ideal vertex work with 11 draws. |
| Index buffers / vertex-cache optimisation (meshoptimizer) | With vertex pulling and fixed-size batches there is no post-transform reuse; indices would add a fetch per vertex without saving shader work. |
| Merging faces across segments | Unsafe: joints rotate, modules swap, forearms go missing. Faces between segments are always kept. |
| Distance-based simplified characters | Forbidden by the brief. At gameplay distance a zombie is ~20–60 px tall, so silhouettes would visibly change. |
| Hi-Z (depth pyramid) occlusion culling | Not needed: the occluders are the sandbox's static boxes, so a simpler exact test was implemented instead (below). A Hi-Z pass would add a depth pre-pass and a pyramid build every frame, and would only add value once there are dynamic or non-box occluders. |
| Caching per-corpse segment transforms | 320 B per corpse (84 MB at capacity) to save 10 quaternion multiplications per *visible* corpse. The 64-entry pose library gives the same static pose for 20 KB. |
| Updating the flow field less often | Not changed in this phase. The brief puts the simulation out of scope unless a bottleneck is measured, and the character work did not change simulation cost (see the sim column). Still the main fixed simulation cost (phase-1 measurement). |

## Remaining bottlenecks

Measured on lavapipe unless stated; none of this has been measured on a Mac.

- **Fragment cost.** With frustum and occlusion culling on, the remaining draw time is dominated by per-fragment work at 4× MSAA: the voxel material lookup, the Lab noise hash, and lighting. The approved characters cost about 13 % more draw time than the phase-1 placeholder at 10k in the open arena, despite drawing fewer triangles. On a real GPU this has to be profiled with Xcode's Metal tools before changing anything. Candidates: material lookup only for tag-31 faces (already the case), cheaper noise, or MSAA 2×.
- **Simulation fixed cost.** The sim column (15–30 ms on lavapipe) is unchanged from phase 1 and is mostly the 16 full-grid navigation dispatches per step. That is a simulation change, so it is out of scope for this phase.
- **Corpse culling scales with corpse count.** `char_cull` runs one thread per corpse slot that is in use, visible or not. It is cheap per corpse but grows with a long battle; a coarse grid of corpse cells could cull whole cells first.
- **Render memory.** 47 MB of character buffers at 131,072 visible-character capacity, 42 MB of it segment instances. Lowering `visibleCharacterCapacity` reduces this linearly; overflow is counted and shown in the debug UI, never written out of bounds.
- **Joint precision.** Half-float quaternions leave joint gaps of up to 0.43 mm (0.005 voxel), invisible at any zoom level in the game. Full floats would double instance bandwidth.
- **Not measured at all:** Metal timings, the 10k @ 60 FPS target, the D3D12 backend (not built), and GPU timestamps (SDL3 GPU has no timestamp queries, so pass timings come from fences).
