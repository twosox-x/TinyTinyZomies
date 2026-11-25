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


## Phase 3 — approved characters (lavapipe, CPU-emulated)

Same caveat as above: **lavapipe rasterises on the CPU.** These tables compare configurations on one machine; they are not Mac frame rates. Methodology changes from phase 1:
- The benchmark now times **sim**, **char** (cull, compaction and pose compute) and **draw** as three separately fenced submissions.
- It runs at 1280×720 with 4× MSAA and 15 measured frames, to keep the full matrix under an hour on 4 CPU cores.
- New scenarios: **city** (city map, camera along an avenue, buildings hide most of the horde), **offscreen** (camera turned away from the horde), **corpses** (siege after many explosions, mostly settled corpses).

The phase-1 placeholder was re-run on the same machine at the start of phase 3: [`benchmarks/phase3/baseline_phase1.csv`](benchmarks/phase3/baseline_phase1.csv) (log next to it). The configuration ladder (before → after each optimisation) is in [OPTIMIZATION.md](OPTIMIZATION.md).

### Final configuration vs. placeholder, all scenarios (lavapipe, 1280×720, 4× MSAA, 15 frames)

`nocclusion` = everything except occlusion culling. In the open arena (no buildings), that is the shipping path minus a test that has nothing to cull, apart from a few pillars. `final` = shipping configuration.

| config | scenario | zombies | visible | draws | triangles | sim ms | char ms | draw ms | frame ms avg / median / p95 / p99 | FPS avg / 1 % low | corpses settled / bodies active |
|---|---|---|---|---|---|---|---|---|---|---|---|
| placeholder | dispersed | 1000 | 1000 | 4 | 0.24 M | 18.3 | 0.1 | 114 | 133 / 122 / 185 / 185 | 7.51 / 5.40 | 0 / 0 |
| placeholder | dispersed | 10000 | 10000 | 4 | 2.40 M | 17.4 | 0.1 | 417 | 435 / 429 / 505 / 505 | 2.30 / 1.98 | 0 / 0 |
| placeholder | dispersed | 50000 | 50000 | 4 | 12.00 M | 28.0 | 0.1 | 1888 | 1917 / 1909 / 2163 / 2163 | 0.52 / 0.46 | 0 / 0 |
| nocclusion | dispersed | 1000 | 879 | 10 | 0.17 M | 17.9 | 1.1 | 118 | 138 / 131 / 195 / 195 | 7.25 / 5.12 | 0 / 0 |
| nocclusion | dispersed | 5000 | 4379 | 10 | 0.85 M | 19.0 | 2.9 | 296 | 318 / 307 / 421 / 421 | 3.14 / 2.38 | 0 / 0 |
| nocclusion | dispersed | 10000 | 8768 | 10 | 1.70 M | 18.1 | 4.6 | 479 | 503 / 489 / 595 / 595 | 1.99 / 1.68 | 0 / 0 |
| nocclusion | dispersed | 25000 | 21914 | 10 | 4.24 M | 19.5 | 10.0 | 1122 | 1152 / 1155 / 1279 / 1279 | 0.87 / 0.78 | 0 / 0 |
| nocclusion | dispersed | 50000 | 43893 | 10 | 8.48 M | 28.3 | 19.7 | 2076 | 2125 / 2134 / 2416 / 2416 | 0.47 / 0.41 | 0 / 0 |
| final | dispersed | 10000 | 8335 | 10 | 1.61 M | 16.5 | 7.1 | 436 | 460 / 449 / 582 / 582 | 2.17 / 1.72 | 0 / 0 |
| final | dispersed | 50000 | 41679 | 10 | 8.05 M | 21.4 | 17.9 | 1826 | 1865 / 1875 / 2007 / 2007 | 0.54 / 0.50 | 0 / 0 |
| placeholder | siege | 1000 | 1000 | 4 | 0.24 M | 18.0 | 0.2 | 112 | 131 / 130 / 145 / 145 | 7.66 / 6.88 | 0 / 103 |
| placeholder | siege | 10000 | 10000 | 4 | 2.40 M | 20.9 | 0.2 | 501 | 523 / 515 / 569 / 569 | 1.91 / 1.76 | 0 / 568 |
| placeholder | siege | 50000 | 50000 | 4 | 12.00 M | 31.4 | 0.1 | 1975 | 2008 / 1982 / 2293 / 2293 | 0.50 / 0.44 | 0 / 576 |
| nocclusion | siege | 1000 | 643 | 10 | 0.13 M | 18.4 | 0.8 | 105 | 125 / 124 / 137 / 137 | 8.02 / 7.32 | 0 / 78 |
| nocclusion | siege | 5000 | 3303 | 10 | 0.64 M | 18.1 | 2.1 | 294 | 315 / 310 / 357 / 357 | 3.18 / 2.80 | 0 / 347 |
| nocclusion | siege | 10000 | 6795 | 10 | 1.31 M | 15.4 | 3.1 | 505 | 524 / 528 / 558 / 558 | 1.91 / 1.79 | 0 / 571 |
| nocclusion | siege | 25000 | 17940 | 10 | 3.47 M | 25.7 | 8.7 | 1236 | 1271 / 1256 / 1413 / 1413 | 0.79 / 0.71 | 0 / 572 |
| nocclusion | siege | 50000 | 32345 | 10 | 6.25 M | 26.3 | 12.8 | 1959 | 1998 / 2024 / 2115 / 2115 | 0.50 / 0.47 | 0 / 575 |
| final | siege | 10000 | 6810 | 10 | 1.32 M | 20.2 | 3.5 | 490 | 514 / 506 / 606 / 606 | 1.95 / 1.65 | 0 / 574 |
| final | siege | 50000 | 30196 | 10 | 5.83 M | 25.9 | 13.0 | 1822 | 1861 / 1871 / 1982 / 1982 | 0.54 / 0.51 | 0 / 586 |
| placeholder | corpses | 1000 | 3000 | 4 | 0.72 M | 16.5 | 0.1 | 171 | 188 / 179 / 311 / 311 | 5.32 / 3.21 | 1000 / 0 |
| placeholder | corpses | 10000 | 12000 | 4 | 2.88 M | 15.8 | 0.1 | 439 | 456 / 451 / 493 / 493 | 2.19 / 2.03 | 10000 / 0 |
| placeholder | corpses | 50000 | 52000 | 4 | 12.48 M | 17.1 | 0.1 | 1659 | 1677 / 1678 / 1777 / 1777 | 0.60 / 0.56 | 50000 / 0 |
| nocclusion | corpses | 1000 | 2649 | 10 | 0.51 M | 14.9 | 1.6 | 206 | 223 / 215 / 265 / 265 | 4.49 / 3.78 | 1000 / 0 |
| nocclusion | corpses | 5000 | 6130 | 10 | 1.19 M | 15.1 | 2.9 | 367 | 385 / 391 / 439 / 439 | 2.60 / 2.28 | 5000 / 0 |
| nocclusion | corpses | 10000 | 10547 | 10 | 2.04 M | 16.3 | 4.2 | 548 | 569 / 571 / 646 / 646 | 1.76 / 1.55 | 10000 / 0 |
| nocclusion | corpses | 25000 | 23712 | 10 | 4.59 M | 13.3 | 8.8 | 1103 | 1126 / 1127 / 1242 / 1242 | 0.89 / 0.81 | 25000 / 0 |
| nocclusion | corpses | 50000 | 45571 | 10 | 8.80 M | 15.6 | 15.9 | 2124 | 2156 / 2125 / 2520 / 2520 | 0.46 / 0.40 | 50000 / 0 |
| final | corpses | 10000 | 10062 | 10 | 1.94 M | 14.6 | 4.6 | 539 | 559 / 559 / 615 / 615 | 1.79 / 1.63 | 10000 / 0 |
| final | corpses | 50000 | 43512 | 10 | 8.40 M | 15.4 | 17.2 | 1948 | 1981 / 1957 / 2166 / 2166 | 0.51 / 0.46 | 50000 / 0 |
| placeholder | city | 1000 | 1000 | 4 | 0.24 M | 17.2 | 0.1 | 146 | 163 / 163 / 179 / 179 | 6.13 / 5.59 | 0 / 0 |
| placeholder | city | 10000 | 9999 | 4 | 2.40 M | 18.4 | 0.1 | 403 | 422 / 417 / 463 / 463 | 2.37 / 2.16 | 0 / 0 |
| nocclusion | city | 1000 | 607 | 10 | 0.12 M | 16.7 | 0.9 | 138 | 156 / 150 / 223 / 223 | 6.40 / 4.49 | 0 / 0 |
| nocclusion | city | 5000 | 2995 | 10 | 0.58 M | 14.1 | 1.6 | 267 | 283 / 274 / 349 / 349 | 3.54 / 2.87 | 0 / 0 |
| nocclusion | city | 10000 | 5843 | 10 | 1.13 M | 14.8 | 2.8 | 415 | 433 / 436 / 487 / 487 | 2.31 / 2.05 | 0 / 0 |
| final | city | 1000 | 208 | 10 | 0.04 M | 13.7 | 0.6 | 109 | 124 / 125 / 139 / 139 | 8.08 / 7.20 | 0 / 0 |
| final | city | 5000 | 1075 | 10 | 0.21 M | 16.4 | 1.2 | 186 | 204 / 197 / 246 / 246 | 4.89 / 4.07 | 0 / 0 |
| final | city | 10000 | 2155 | 10 | 0.42 M | 16.3 | 1.5 | 228 | 246 / 236 / 297 / 297 | 4.06 / 3.37 | 0 / 0 |
| placeholder | offscreen | 1000 | 1000 | 4 | 0.24 M | 17.3 | 0.1 | 52 | 71 / 66 / 123 / 123 | 14.10 / 8.15 | 0 / 0 |
| placeholder | offscreen | 10000 | 10000 | 4 | 2.40 M | 19.1 | 0.1 | 184 | 204 / 194 / 244 / 244 | 4.91 / 4.10 | 0 / 0 |
| placeholder | offscreen | 50000 | 50000 | 4 | 12.00 M | 30.1 | 0.1 | 755 | 786 / 789 / 814 / 814 | 1.27 / 1.23 | 0 / 0 |
| final | offscreen | 1000 | 0 | 10 | 0.00 M | 15.9 | 0.7 | 38 | 55 / 53 / 72 / 72 | 18.17 / 13.89 | 0 / 0 |
| final | offscreen | 10000 | 0 | 10 | 0.00 M | 18.5 | 0.5 | 36 | 56 / 55 / 61 / 61 | 18.00 / 16.34 | 0 / 0 |
| final | offscreen | 50000 | 0 | 10 | 0.00 M | 23.7 | 0.7 | 35 | 60 / 57 / 91 / 91 | 16.67 / 10.97 | 0 / 0 |

Raw CSV: [`benchmarks/phase3/`](benchmarks/phase3/) (`ladder_10k.csv`, `final_sweep.csv`, `final_arena.csv`, `occlusion_city.csv`, `offscreen.csv`, `placeholder_sweep.csv`). Earlier off-screen rows with a mis-framed camera were discarded and re-measured.

### Running the phase 3 benchmark on the Mac

Build in Release, then run each block and add the CSVs to `docs/benchmarks/` with the Mac model, macOS version and resolution.

```bash
./build/ttz --bench --bench-configs placeholder,final --bench-scenarios dispersed,siege,city,offscreen,corpses --bench-counts 1000,5000,10000,25000,50000 --bench-csv docs/benchmarks/mac_phase3_sweep.csv
```

```bash
./build/ttz --bench --bench-configs placeholder,naive,culled,greedy,classes,culling,nocclusion,final,final-posevs --bench-scenarios dispersed,siege --bench-counts 10000 --bench-csv docs/benchmarks/mac_phase3_ladder.csv
```

The second command includes the unoptimised `naive` configuration, which is very slow on lavapipe (17 s per frame at 10k) but should finish on a real GPU.
