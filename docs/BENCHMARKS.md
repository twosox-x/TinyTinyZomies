# Benchmarks

## Method

`ttz --bench` runs headless. For each scenario and agent count it:

1. **Resets and spawns.**
   - **dispersed** is the arena map, agents spread over about 26,000 m² and walking toward a distant goal.
   - **siege** is the worst case: the arena map, about 3.5 agents/m² spawned against a full-width 3.5 m wall, so they compress, climb and pile up. Two explosions go off in the horde during measurement.
2. **Warms up.** dispersed: 60 steps. siege: `--bench-warmup` steps (default 600 = 10 s, so the pile has formed).
3. **Measures N frames,** each made of one simulation step plus one 1920×1080 frame with 4× MSAA:
   - **sim ms:** one step recorded and submitted, waited on with a fence. SDL3 GPU has **no timestamp queries**, so this is GPU execution plus submission/fence latency.
   - **render ms:** the same for the render command buffer (ground, boxes, corpses, zombies).
   - **frame ms:** wall time for both, including CPU recording.
4. **Reads exact counters** synchronously after measuring (benchmark only).

In the interactive app, the debug panel shows CPU recording time per section, frame-time average, p95 and max, engine GPU memory, and process RSS.

Run it yourself, and report hardware, OS, resolution and backend with the numbers:

```bash
./build/ttz --bench --bench-counts 1000,5000,10000,25000,50000 --bench-csv docs/benchmarks/<machine>.csv
```

Always-on features in these runs: 3 solver iterations, vertical accumulation, corpses, 8 red+black navigation sweeps per step, and a 256×256 grid of 0.75 m cells.

## Results

### Development Mac (Apple Silicon, Metal) — **not yet measured**

The target is 10,000 active zombies at about 60 FPS with basic rendering. **This has not been measured:** no Mac was available in the development environment. Run the command above on the Mac and add the table here.

### Reference run: Linux, Mesa lavapipe (software Vulkan on CPU) — NOT representative of GPU performance

These numbers only show that the full pipeline runs at every count, and how cost scales on a CPU-emulated device. Lavapipe executes shaders on 4 CPU cores and rasterizes in software, so render times measure CPU rasterization of 1080p with 4× MSAA.

Host: see [`benchmarks/lavapipe_host.txt`](benchmarks/lavapipe_host.txt). Raw CSV: [`benchmarks/lavapipe_1080p.csv`](benchmarks/lavapipe_1080p.csv). Settings: 30 measured frames, 300 siege warm-up steps.

| scenario | agents | live | sim ms avg / p95 / max | render ms avg / p95 | frame ms | climbing | elevated | max height (m) |
|---|---|---|---|---|---|---|---|---|
| dispersed | 1000 | 1000 | 15.3 / 20.1 / 44.1 | 134 / 159 | 151 | 0 | 0 | 0.00 |
| dispersed | 5000 | 5000 | 16.3 / 22.9 / 23.8 | 275 / 318 | 291 | 0 | 0 | 0.00 |
| dispersed | 10000 | 10000 | 17.1 / 25.3 / 42.1 | 480 / 530 | 498 | 0 | 0 | 0.00 |
| dispersed | 25000 | 25000 | 18.1 / 22.1 / 25.7 | 985 / 1056 | 1003 | 0 | 0 | 0.00 |
| dispersed | 50000 | 50000 | 22.5 / 31.7 / 36.8 | 1982 / 2181 | 2005 | 0 | 0 | 0.17 |
| siege | 1000 | 1000 | 14.0 / 17.0 / 17.1 | 158 / 190 | 172 | 3 | 54 | 3.38 |
| siege | 5000 | 5000 | 14.8 / 17.5 / 18.4 | 318 / 365 | 334 | 488 | 989 | 5.24 |
| siege | 10000 | 10000 | 17.3 / 22.8 / 23.0 | 615 / 683 | 632 | 566 | 1513 | 5.29 |
| siege | 25000 | 25000 | 21.0 / 28.1 / 29.8 | 1286 / 1456 | 1307 | 636 | 1585 | 4.42 |
| siege | 50000 | 50000 | 26.4 / 31.9 / 32.2 | 1961 / 2154 | 1988 | 642 | 1700 | 4.99 |

Engine GPU buffers: 25.5 MB, constant across counts at 65,536-agent / 262,144-corpse capacity. The ~1.1 GB process RSS is mostly lavapipe emulating GPU memory and JIT-compiled shaders in host RAM, so it says nothing about the Mac.


## Observations

- **The pipeline is functional at every count up to 50,000** in both the dispersed and the worst-case siege scenario (compression, climbing, 4–5 m piles, explosions during measurement). There were no failures and no NaNs.
- **On lavapipe, simulation cost is dominated by fixed per-pass overhead, not by agent count.** Simulation went from 14 ms (1k agents) to 26 ms (50k agents in a siege).
  - A controlled run (10k dispersed, 320×180) with `navIterationsPerStep` 8 → 1 cut simulation from 17.0 to 8.8 ms.
  - The 16 full-grid navigation dispatches (65,536 cells each) are therefore about half of it.
  - On a real GPU, each of those dispatches is microseconds; but if the Mac shows the same proportion, run navigation every 2–4 steps or use tile-local multi-iteration sweeps in shared memory.
- **Rendering on lavapipe is CPU rasterization,** about 720 indices per zombie at 1080p with 4× MSAA. It scales linearly with zombie count, as expected for software vertex processing. On Apple GPUs, 50k × 240 triangles ≈ 12 M triangles per frame. That is within budget but worth watching; a stage 6 LOD (merged-box low-poly far zombies) is the obvious lever.
- **Corpse count shows 0 in the siege rows** because dying bodies need more than the 30 measured frames (0.5 s) to settle. Corpse creation is covered by the self-test.
- **Not measured yet:** real GPU frame times, the 10k @ 60 FPS target, and frame-time spikes on Metal. Those need the development Mac.
