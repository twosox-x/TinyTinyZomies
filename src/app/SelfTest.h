#pragma once
#include "gpu/GpuContext.h"
#include "sim/SimParams.h"
namespace ttz {
// Headless GPU simulation tests. Returns process exit code (0 = all passed).
int runSelfTest(GpuContext& gpu, const SimParams& params, const char* dumpDir);
}
