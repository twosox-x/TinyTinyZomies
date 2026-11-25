# Asset pipeline — modular characters

```
assets/characters/source/zombie_lab_v3.html      approved Zombie Lab (design tool, never shipped)
        │  node tools/convert_characters.mjs      (≈4 s, deterministic, byte-identical output)
        ├─ assets/characters/zombie_parts.ttzc    runtime asset (binary)
        ├─ assets/characters/zombie_parts.json    manifest: ids, names, decay levels, statistics
        └─ shaders/include/zombie_parts.glsl      generated GPU constants (template, tables, palettes, tags)
        │  python3 tools/compile_shaders.py       GLSL → SPIR-V → MSL + reflection (committed)
        ▼
engine: CharacterRenderer loads .ttzc once; nothing is generated at run time
```

## Why convert from the HTML instead of from screenshots or a re-implementation

The converter **runs the Lab's own code**.

- It cuts the script section that defines the body template, palettes, module library and `decorate()` out of the approved HTML. It locates it by stable markers: from `const SLOTS = [` up to the mesher comment.
- It evaluates that section in a Node `vm` sandbox, so there is no browser and no three.js.
- It calls the Lab's `module.build()` and `decorate()` with the Lab's seed formula.

Nothing about the geometry is re-typed. If the design changes in a new Zombie Lab version, point the converter at the new HTML. If the markers moved, it fails loudly rather than guessing.

## What is baked

For every slot, module, stump state (upper arms) and decoration variant there are 2,277 segment meshes, each at three geometry levels:

| Level | What it is | Triangles (all meshes) | Triangles: Drone / Walker / Rotter |
|---|---|---|---|
| naive | every cube face of every voxel | 523,020 | 2,424 / 2,616 / 2,076 |
| culled | faces between voxels of the same segment removed (identical to Zombie Lab's own mesher) | 186,332 | 856 / 904 / 780 |
| greedy | culled faces merged into rectangles where material and ambient occlusion are uniform | **110,608** | **280 / 496 / 572** |

**Lossless guarantee.** For every mesh, the converter rasterises both the greedy and the culled triangles back into unit faces. It compares position, direction, material tag and the AO value at each corner, and aborts the conversion on any difference. Faces with non-uniform AO keep their own quad and the Lab's diagonal rule, so the shading is unchanged.

**What is never merged across segments.** Faces between *different* segments are kept. Joints rotate, modules are interchangeable and forearms can be missing, so a face hidden by a neighbouring segment can become visible.

## Runtime format (`.ttzc`, version 1)

| Section | Content |
|---|---|
| header (16 × u32) | magic `TTZC`, version, mesh count, level count (3), decoration variants (33), words per level, slot count |
| slot table (10 × 4 u32) | first mesh, module count, stump states, family |
| mesh table (meshes × 3 levels × 2 u32) | vertex offset, vertex count |
| vertex blobs | one per level, packed vertices |

**Vertex format.** One `uint32`; non-indexed triangle lists, pulled from a storage buffer.

```
bits  0..20  x, y, z  in half-voxels relative to the segment joint (7 bits each, +64 bias, exact)
bits 21..23  face direction (normal is one of 6 axes)
bits 24..25  ambient-occlusion level (Lab values 0.5 / 0.67 / 0.84 / 1.0)
bits 26..30  material tag
```

Compared with a typical float vertex (position + normal + colour = 36 bytes), that is 9× less memory. Positions are exact, because voxel corners lie on the half-voxel grid.

The whole asset is 9.9 MB, of which the greedy level is 1.3 MB. The naive and culled levels are kept only so the benchmarks can show the before/after; a shipping build could keep just the greedy level.

**Why non-indexed.** Vertices are pulled by `gl_VertexIndex` and instances share a batch of a fixed size, so there is no hardware post-transform cache to reuse. An index buffer would add a fetch without saving vertex-shader work. Indexed, per-mesh draws were rejected; see [OPTIMIZATION.md](OPTIMIZATION.md).

## Editing workflow

- **Change the design:** edit Zombie Lab (keep the module definitions in its `MODULES` table), save the approved version under `assets/characters/source/`, then re-run:

  ```bash
  node tools/convert_characters.mjs
  ```

  ```bash
  python3 tools/compile_shaders.py
  ```

  The generated GLSL include carries module counts and palettes, so the shaders must be recompiled too.
- **Verify the change:** run the side-by-side comparison. This needs Node with Playwright and Python with Pillow.

  ```bash
  NODE_PATH=$(npm root -g) node tools/capture_lab.mjs docs/media/phase3/lab
  ```

  ```bash
  python3 tools/compare_views.py ./build/ttz docs/media/phase3/lab docs/media/phase3/compare
  ```

  These render the Lab (instrumented in memory; the approved file is never modified) and the engine from identical camera parameters (`tools/compare_views.json`), and compose comparison sheets.
- **Blockbench:** not part of this pipeline. The modules are procedural voxel definitions, and converting them directly is exact. A Blockbench round trip would add a lossy manual step. If artists later need Blockbench, the converter can export each baked segment to `.gltf` with named groups, and an importer for edited segments could be added. That is not implemented.
- **Placeholder model:** `assets/models/zombie.glb` (the phase-1 placeholder) is still loaded so the old renderer can be selected for comparisons (`--chars placeholder`).
