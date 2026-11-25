# Architecture — Tiny Tiny Zombies engine (phase 1)

A purpose-built engine, not a general one. Native C++20, SDL3 (window, input, GPU API: Metal / Vulkan / D3D12), CMake. Simulation state lives on the GPU; the CPU records commands and pushes small uniform blocks.

## Modules

| Module | Files | Responsibility |
|---|---|---|
| Application / platform | `src/main.cpp`, `src/app/App.*` | SDL init, window, event loop, fixed-timestep scheduling, tools (explode / goal / spawn), scripted runs, screenshots |
| GPU device & resources | `src/gpu/GpuContext.*` | Device creation (SPIR-V or MSL), shader and pipeline loading with shadercross JSON reflection, buffer creation with memory accounting, synchronous upload/download (init and tests only), the `dispatch()` helper (one compute pass per dependent dispatch) |
| Crowd simulation | `src/sim/CrowdSim.*`, `shaders/sim_*.comp`, `shaders/scan_*.comp` | Agent storage, spatial grid, constraint solver, vertical accumulation, corpses, explosions, async stats readback |
| Navigation fields | `shaders/nav_relax.comp`, `shaders/nav_dir.comp` | Shared Eikonal distance field and flow directions |
| Sandbox | `src/sim/Sandbox.*` | Test maps (city, arena) as data: boxes, lights, scenarios; rasterised into the static height grid |
| Parameters | `src/sim/SimParams.*`, `config/sim.cfg` | Every tunable value; edit at runtime in the UI or in the text file (no recompile) |
| Renderer | `src/render/Renderer.*`, `shaders/*.vert/frag` | Scene pass: ground with debug overlays, boxes, characters, MSAA, blit, screenshots; phase-1 placeholder zombies kept for comparison |
| Characters | `src/render/CharacterRenderer.*`, `shaders/char_*.comp`, `shaders/character.*`, `shaders/include/zombie_*.glsl` | Approved modular zombies: GPU culling, size-class compaction, pose evaluation, vertex-pulling draws (phase 3) |
| Character assets | `tools/convert_characters.mjs`, `assets/characters/*` | Zombie Lab → baked segment meshes (see ASSET_PIPELINE.md, CHARACTER_STANDARD.md) |
| Camera | `src/render/Camera.*`, `src/render/Math.h` | Perspective RTS camera |
| Assets | `src/assets/Model.*`, `tools/make_placeholder_zombie.py` | glTF/GLB voxel characters (Blockbench-compatible) |
| Debug / profiling | `src/debug/*` | ImGui panel, CPU timers, frame history, RSS |
| Validation | `src/app/SelfTest.*`, `src/app/Bench.*` | Headless GPU tests and benchmarks |

Dependencies point downward only: app → render/sim → gpu. The simulation knows nothing about meshes; the renderer reads simulation buffers but never writes them.

## GPU data layout

| Buffer | Layout | Notes |
|---|---|---|
| `agentsA` | `Agent[cap]`, 80 B (AoS) | Persistent state. Rewritten **in cell-sorted order** every step, so the neighbour loop and the renderer read coherent memory. |
| `agentsB` | `Agent[cap]` | Scatter target for the step |
| `posP` / `posQ` | `vec4[cap]` (xyz, body height) | Compact SoA ping-pong for the constraint solver. The hot loop reads only 16 B per neighbour. |
| `prevS` | `vec4[cap]` | Start-of-step position plus encoded desired velocity (friction / crawl) |
| `contactAux` | `vec4[cap]` | Last-iteration contact summary: front neighbour top, support top, wall ahead, contact count |
| `cellCount`, `cellStart` | `uint[cells+1]` | Histogram and prefix sum. The extra bucket is the *graveyard* for removed agents. |
| `density` | `vec4[cells]` | Smoothed agents/m², crowd top height, elevated count |
| `staticH` | `float[cells]` | Static obstacle top (0 = open ground) |
| `corpseH` | `int[cells]` | Corpse height in millimetres (fixed point, atomics) |
| `navDist`, `navDir` | `float[cells]`, `vec2[cells]` | Shared navigation field |
| `corpses` | `Corpse[corpseCap]`, 32 B | Settled bodies: position, yaw, **the zombie's full 56-bit look**, alive flag, corpse-pose index, height contribution |
| `counters` | `uint[16]` | Live count, append counter, corpse count, statistics |
| `indirect` | `uint[24]` | Indirect dispatch args (agents, corpses) and indexed-indirect draw args (zombies, corpses) |

`Agent` is AoS because predict, scatter and finalize touch nearly every field. Since phase 3, `Agent.info.x` (bits 8–31) and `info.y` also hold the zombie's 56-bit modular appearance. That keeps the 80-byte record size and needs no extra sort bandwidth. The solver, the only pass that reads neighbours, uses the compact SoA `posP`/`posQ`.

Defaults:
- Grid: 256 × 256 cells of 0.75 m (192 m × 192 m).
- Capacity: 65,536 agents and 262,144 corpses.
- Memory: ≈ 25 MB of engine GPU buffers.

## One simulation step (fixed 1/60 s)

Each line is its own compute pass. SDL3 GPU does not synchronise dispatches inside a pass.

```
spawn            append requested agents          (only when requested)
corpse_blast     reactivate corpses in blast radii (only when an explosion happened)
commit_append    live += appended; indirect dispatch args; clear per-step stats      [1 thread]
clear            cellCount = 0
predict          explosions -> flow-field desired velocity * f(density ahead) -> gravity/climb
                 -> predicted position; atomic histogram (dead -> graveyard)          [indirect]
scan_local/blocks/add   exclusive prefix sum over cells+1
scatter          physically reorder agents by cell into agentsB, posP, prevS        [indirect]
commit_sort      live = cellStart[graveyard]; indirect args                          [1 thread]
solve x N        Jacobi PBD: capsule contacts (mass scaled), support friction,
                 static boxes, ground (static + corpse field), bounds                [indirect]
finalize         velocity from positions, pressure EMA, WALK/CLIMB/FALL/DYING state machine,
                 corpse conversion and height splat, written back to agentsA (sorted) [indirect]
density          per cell: smoothed density, crowd top height
nav_relax x 2M   red-black Gauss-Seidel Eikonal sweeps with congestion and climb cost
nav_dir          upwind gradient -> flow directions
```

Per frame, after the last step: `draw_args` writes indirect draw commands, then a 64-byte counters download is recorded into a ring of 3 transfer buffers and harvested later with `SDL_QueryGPUFence`. **No synchronous readback during gameplay.**

Rendering runs every frame. Simulation steps accumulate real time × speed, at most `maxStepsPerFrame` (2) per frame. If the simulation can't keep up, time is dropped instead of spiralling.

### Movement model

- **Desired velocity:** bilinear flow direction, a slow per-agent wander, and speed = base × (0.7–1.3 per agent) × `f(ρ ahead)`. Here `f` falls linearly from comfort to max density but never below `minSpeedFactor`, so blocked agents keep **pushing**; that is where pressure comes from. Crawling (prone) agents use the crawl speed.
- **Contacts:** each body is a vertical capsule of radius `R`, with height interpolated between standing (1.7 m) and prone (0.62 m). Two vertical capsules collide along the line between the closest points of their axes:
  - side by side, the push is horizontal (crowd separation);
  - one above the other, the push is vertical (support);
  - in between, rounded caps let bodies roll off.
- **Mass scaling** `w = exp(-k · height above ground)` makes lower bodies heavier, so stacks hold up with only 3 Jacobi iterations. Corrections are averaged and over-relaxed (SOR).
- **Support friction:** when a contact normal is inside the friction cone (`ny > supportCos`), the body on top follows its support's displacement plus its own crawl intent. That gives riding on the crowd and crawling forward. Outside the cone it slides, giving an angle of repose: no towers, no overhangs.
- **Climbing:**
  - *Trigger:* a walker whose pressure EMA (`1 − progress / desired`) exceeds a per-agent threshold, with at least 4 contacts, and a neighbour *ahead* whose top is 0.3–2.1 m above its feet.
  - *Motion:* it enters CLIMB and rises toward that neighbour's top.
  - *Exit:* when it gets there, times out, or loses contact.
  - It can never climb a wall by itself: the target is always a real body.
- **Velocity clamp:** constraint-derived velocity is clamped for non-ballistic states. This prevents "popcorn" launches in crushes.
- **Static geometry:** each solid cell is an axis-aligned box. Bodies whose feet are below `top − stepUp` are pushed out horizontally (circle vs box). Bodies on top stand on it. Walls are crossed only once the pile (or corpse ramp) reaches the top.

### Navigation

- **Distance field:** solves `|∇D| = cost` with the upwind Godunov update.
- **Cost:** `1 + w_ρ·max(0, ρ − ρ_comfort)` plus, for static cells, `w_climb · (top − local support)`. Local support is the crowd top or corpse height in neighbouring open cells. Cells above `navClimbLimit` are impassable.
- **What that gives:**
  - Buildings are walls.
  - The defensive wall is passable at high cost, and gets cheaper as the pile and corpse ramp grow.
  - Congestion makes streams split onto alternative routes.
- **Updates:** fields update incrementally every step (8 red+black sweeps by default), so goal changes propagate within about a second.

### Death, corpses, explosions

- **Explosions** are uniform-block events (≤ 8 per step), applied in `predict` only to agents inside the radius:
  - a radial impulse with an upward bias;
  - damage ∝ falloff² × lethality, so close agents die and outer agents are stunned (FALL).
  - Corpses inside 0.7 × radius are **reactivated**: their height contribution is subtracted, they re-enter the agent pool as DYING bodies and get thrown.
- **DYING bodies** are full physics agents: they collide, pile and slide. A body settles when grounded, slow, and on a corpse slope below the angle of repose; or when it has lain still on other bodies / against a wall for 1.5 s; or after a 4 s timeout (phase 4; previously only the first rule plus an 8 s timeout, which left jammed bodies tumbling).
- **Tumble (phase 4).** While FALLING or DYING, `dirs.xy` holds a roll angle and roll rate instead of the desired velocity. Blasts set the rate; it is braked hard (`tumbleDamping`, 8/s) as soon as the body touches the ground, another body or a wall, and the angle relaxes to lying on the front or back. The corpse then gets a library pose lying the same way up, with the same heading, so there is no pop. Limbs flail in proportion to speed and go limp at rest.
- **On settling,** the body becomes a corpse instance at ground height and adds `2 × splatHeight` of fixed-point height, bilinearly splatted at its head and feet.
- **Living agents** use `ground = static top + bilinear corpse height`, so corpse piles become ramps. Corpses are never deleted.
- **If the instance buffer is full,** height still accumulates (gameplay effect preserved) and an overflow counter is shown in the UI.
- **The graveyard bucket** of the counting sort removes dead agents from the live array for free.

### Gore (phase 4)

All on the GPU, no per-object CPU work. Buffers live in `CrowdSim` (layouts in `shaders/include/gore.glsl`):

| Buffer | Size (defaults) | Content |
|---|---|---|
| particles | 65,536 × 32 B = 2 MB | ring buffer: blood, fire, smoke, debris, sparks |
| particle list | 256 KB | live particle indices for the indirect draw |
| gibs | 16,384 × 64 B = 1 MB | ring buffer of severed body parts (rigid bodies) |
| decals | 3 × (sim grid × 3)² × 4 B = 7 MB | ground blood, wall blood height, scorch, at 25 cm |

- **AGENT Z.** `info.z` now packs health (half float), a 10-bit severed-segment mask and bloodiness (0–3); the agent stays 80 bytes. Corpses carry the mask and bloodiness in their existing `info.z`.
- **predict** (per hit): blood spray, bloodiness, tumble spin, and severing. Each limb comes off with probability ∝ dismemberChance × closeness² (decomposed limbs more easily). An arm takes its forearm, a leg its shin. Losing the head kills. A killed zombie closer than `gibThreshold` to the blast is torn apart (all 10 segments). Every severed segment spawns a gib at its joint in the rest pose, with the body's new velocity plus a kick, and a blood burst.
- **finalize:** wounded zombies drip blood; zombies without a leg crawl (prone) for good; settling bodies leave a blood pool; torn-apart bodies leave only a pool.
- **gore_update** (5 modes in one pipeline): explosion fireball, smoke, debris, sparks and a ragged scorch disc; particle integration (blood that hits the ground adds ground blood, blood that hits a wall raises that wall cell's splat height); gib rigid-body integration (gravity, drag, bounces with blood splashes, wall bounces with splats, blood trails in flight, settling onto their side, re-thrown by later blasts); particle draw arguments.
- **Rendering.** Gibs go through the character pipeline as one-segment characters (cull mode 2, `REF_GIB`), so they get the exact Zombie Lab meshes and materials. The segment instance carries the severed mask; the fragment shader paints raw flesh, blood and bone within ~1.4 voxels of every joint whose neighbour is gone (stumps and the cut ends of flying parts). Bloodiness paints blood voxels. Particles are spinning voxel cubes in one indirect draw. The ground shader reads blood and scorch (bilinear, noise-thresholded); building and wall faces read the wall splat height and draw a ragged band with drips.

### Moon shadows (phase 4)

The static city casts shadows from the moon through a precomputed **shadow height field**: for every 25 cm cell, the height below which a box occluder hides the moon. For a ray from (x, y, z) towards the moon L, a box is hit iff the horizontal projection enters its footprint at some t ≥ 0 (entry `ta`) while still under the roof: shadowed for `y ≤ height − ta·L.y`. This is exact for boxes. It is computed once per map on the CPU, touching only each box's shadow footprint, and costs one bilinear lookup per fragment for the ground, buildings, zombies, corpses and body parts.

## Character rendering (phase 3)

Every zombie and corpse is drawn from shared segment meshes; nothing is per-character on the CPU.

```
per frame, after the simulation step (compute passes, one per dependent dispatch):
  copy      reset 48 character counters from a static zero transfer buffer (no CPU writes)
  char_cull (zombies)  indirect over live agents   : frustum test (2 m sphere), conservative occlusion test
  char_cull (corpses)  indirect over corpse slots  :   against building boxes -> visible list,
                                                     per segment: mesh id from look, size class, atomic slot
  char_prefix          1 thread                    : class offsets, 16 indirect draw commands, pose dispatch size
  char_pose            indirect over visible chars : 10 joint transforms ONCE per character (corpses: static
                                                     library pose + yaw), scatter 32-byte segment instances
render pass:
  per size class (≤ 16): DrawPrimitivesIndirect, vertexCount = class size, instanceCount = segments in class
```

| Buffer | Size | Content |
|---|---|---|
| `charVerts` | 9.9 MB (all 3 levels) | packed 4-byte vertices of all 2,277 segment meshes |
| `charMeshInfo` ×6 | 36 KB each | per mesh: vertex offset, count, size class, class size (per geometry level × batching mode) |
| `charCounters` | 192 B | visible, overflow, triangles, segments, class counts, class bases |
| `charArgs` | 272 B | 16 non-indexed indirect draw commands + pose dispatch |
| `charVisList` | 4 B × capacity | visible character references (bit 31 = corpse) |
| `charSegLocal` | 40 B × capacity | per visible character and slot: class and index within the class |
| `charSegInsts` | 320 B × capacity | `SegInst` (32 B): rotation as half4, world translation, mesh id + slot, appearance word |
| `corpsePoseLib` | 20 KB | 64 corpse poses × 10 segment transforms (baked at start-up) |

With a default capacity of 131,072 visible characters, these buffers take 47 MB.

**Vertex shader.** It fetches its instance (32 B, cached across the instance's vertices) and its packed vertex. It unpacks, rotates by the quaternion and translates. Vertices past the mesh's own count (padding up to the class size) produce a clipped degenerate triangle.

**Fragment shader.** It resolves the palette tag (sleeves follow the torso), applies the Lab's per-voxel noise (same hash, recomputed from the rest-pose position, so merged faces keep it) and the AO level, then the engine lighting. Eyes are emissive.

**Occlusion.** A character is culled only if every corner of its conservative bounding box (2.2 × 2.6 × 2.2 m, covering every pose) is hidden from the camera by the **same** static building box. The region a convex box hides from a point is convex, so the whole bounding box is hidden and nothing can pop. Occluders are the map's solid boxes at least 3 m tall (90 in the city), uploaded once per map. Culled zombies still exist and simulate; visibility never feeds back into the simulation.

**Corpses.** A corpse is 32 bytes: position, yaw, look, pose index and height. Settled corpses are never animated: their pose comes from the baked library, and per frame they cost only a frustum test plus 10 quaternion multiplications if visible. The physics (height field, angle of repose, reactivation by explosions) is unchanged from phase 1. Reactivated corpses re-enter the simulation with the same look.

## Rendering

- **Targets:** offscreen RGBA8 color with 4× MSAA where supported, plus D32F depth. The color is resolved, then blitted to the swapchain. ImGui draws on the swapchain afterwards.
- **Zombies (phase-1 placeholder path, still selectable):**
  - One `DrawIndexedPrimitivesIndirect` for all living zombies and one for all corpses. Instance count comes from the GPU.
  - The vertex shader reads the agent buffer by `gl_InstanceIndex` and animates voxel parts procedurally around their pivots (walk, zombie arm reach, climbing reach, flail, prone/crawl, tumbling, splayed corpses).
  - Variants come from a palette texture with N stacked rows.
- **Boxes** (buildings, wall, barricades, cars, lamps): one instanced draw with procedural facades. These are placeholders for stage 4's voxel architecture.
- **Ground:** one full-screen-area quad. The fragment shader reads simulation fields for:
  - sidewalks, blood under corpses, crowd contact shading;
  - debug overlays: density, flow, grid, nav distance, corpse height;
  - goal rings and explosion scorch/shock rings.
- **Lighting:** night palette from `docs/reference` (purple sky, cool moon, warm street lamps, explosion flashes as transient point lights), fake wet-asphalt specular, and fog. No shadows yet (stage 6).

## Asset pipeline (Blockbench-compatible)

- **Format:** `.glb`/`.gltf` loaded with cgltf.
- **Parts by node name:**
  - `head`, `body`/`torso`;
  - `arm`/`leg` with `left`/`right` (or `_l`/`_r`, `l_`/`r_`) give the 6 animated parts.
  - An unrecognised node inherits its nearest named ancestor's part, else torso.
- **Pivots:** a node's world translation is its pivot, which is how Blockbench exports group origins.
- **Normalisation:** models are rescaled to the configured standing height, with feet at y = 0.
- **Textures and variants:** the base color texture is sampled with nearest filtering. Variants come from vertically stacked texture copies (`extras.ttz_variant_rows`; 1 if absent).
- **Placeholder:** the current zombie is generated by `tools/make_placeholder_zombie.py` into exactly that structure. Replacing it with a Blockbench export needs no code change.
- **Separation:** simulation shapes (capsule radius and heights) are parameters, independent of the mesh.

## Extension points for later stages

- **Combat (stage 5):** soldiers can write damage events the same way explosions do (a uniform or a small event buffer consumed in `predict`). Projectile hits can query the grid with the same cell ranges.
- **Destruction:** `staticH` is a GPU buffer. Updating cells (and re-uploading or patching) makes the navigation and collision react automatically.
- **Squads as goals:** `goals[]` (up to 4) feed the navigation field. For per-faction fields, add more distance buffers.
- **City (stage 4):** replace `Sandbox` boxes with voxel meshes. Collision still comes from a rasterised height grid, so geometry stays out of the simulation.
