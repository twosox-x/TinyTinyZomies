#pragma once
// CPU timing (SDL performance counter), smoothed stats, frame-time history and process memory.
#include <cstdint>
#include <vector>

namespace ttz {

double nowMs();
uint64_t processResidentBytes();   // RSS (macOS: mach task_info, Linux: /proc, Windows: PSAPI)

struct RunningStat {
    double last = 0, avg = 0, max = 0;
    void add(double v) { last = v; avg = avg == 0 ? v : avg * 0.95 + v * 0.05; if (v > max) max = v; }
    void resetMax() { max = 0; }
};

struct FrameHistory {
    std::vector<float> ms = std::vector<float>(240, 0.f);
    int head = 0;
    void push(float v) { ms[head] = v; head = (head + 1) % (int)ms.size(); }
    float percentile(float p) const;
};

} // namespace ttz
