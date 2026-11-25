#pragma once
#include <string>
#include <vector>
namespace ttz {
// Character/render configuration ladder used for before/after comparisons (see docs/OPTIMIZATION.md).
//   placeholder : phase-1 placeholder mesh (one draw for zombies, one for corpses)
//   naive       : approved characters, every voxel cube face, joint hierarchy evaluated per vertex,
//                 one batch per body-part family, no culling   ("approved, before optimisation")
//   culled      : + hidden faces removed (Zombie Lab's own mesher), pose computed once per character
//   greedy      : + lossless greedy merging
//   classes     : + vertex-count size classes (less vertex padding)
//   culling     : + GPU frustum culling
//   nocclusion  : + greedy by AO with per-voxel material lookup
//   phase3      : + conservative occlusion culling behind buildings (phase-3 result; no gore, no shadows)
//   final-posevs: phase3, but pose evaluated per vertex (comparison)
//   final       : phase 4 game: + indexed quads, moon shadows, gore simulation and particles
//   final-tris  : final without indexed quads;  final-noshadow: final without moon shadows
struct BenchOptions {
    std::vector<int> counts = {1000, 5000, 10000, 25000, 50000};
    std::vector<std::string> scenarios = {"dispersed", "siege"};
    std::vector<std::string> configs = {"final"};
    int warmupDispersed = 30, warmupSiege = 300, measureFrames = 20;
    int width = 1920, height = 1080;
    std::string csv = "benchmark_results.csv";
    std::string config = "config/sim.cfg";
    bool gpuDebug = false;
};
int runBenchmarks(const BenchOptions& o);
}
