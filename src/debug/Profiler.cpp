#include "debug/Profiler.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cstdio>

#if defined(__APPLE__)
#include <mach/mach.h>
#elif defined(_WIN32)
#include <windows.h>
#include <psapi.h>
#else
#include <unistd.h>
#endif

namespace ttz {

double nowMs() { return (double)SDL_GetPerformanceCounter() * 1000.0 / (double)SDL_GetPerformanceFrequency(); }

uint64_t processResidentBytes() {
#if defined(__APPLE__)
    mach_task_basic_info info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) == KERN_SUCCESS) return info.resident_size;
    return 0;
#elif defined(_WIN32)
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) return pmc.WorkingSetSize;
    return 0;
#else
    long pages = 0, rss = 0;
    FILE* f = std::fopen("/proc/self/statm", "r");
    if (!f) return 0;
    if (std::fscanf(f, "%ld %ld", &pages, &rss) != 2) rss = 0;
    std::fclose(f);
    return (uint64_t)rss * (uint64_t)sysconf(_SC_PAGESIZE);
#endif
}

float FrameHistory::percentile(float p) const {
    std::vector<float> v = ms;
    std::sort(v.begin(), v.end());
    return v[std::min(v.size() - 1, (size_t)(p * (float)v.size()))];
}

} // namespace ttz
