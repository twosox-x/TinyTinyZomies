#pragma once
#include <string>
#include <vector>
namespace ttz {
struct BenchOptions {
    std::vector<int> counts = {1000, 5000, 10000, 25000, 50000};
    std::vector<std::string> scenarios = {"dispersed", "siege"};
    int warmupDispersed = 60, warmupSiege = 600, measureFrames = 60;
    int width = 1920, height = 1080;
    std::string csv = "benchmark_results.csv";
    std::string config = "config/sim.cfg";
    bool gpuDebug = false;
};
int runBenchmarks(const BenchOptions& o);
}
