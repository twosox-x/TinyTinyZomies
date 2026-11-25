#pragma once
// Thin ownership layer over SDL3 GPU: device, shader/pipeline loading with
// SDL_shadercross reflection, buffer creation with memory accounting, and
// compute-dispatch helpers that follow SDL's "one pass per dependent dispatch" rule.

#include <SDL3/SDL.h>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <vector>

namespace ttz {

struct ShaderReflection {
    uint32_t samplers = 0, storageTextures = 0, storageBuffers = 0, uniformBuffers = 0;
    uint32_t roStorageTextures = 0, roStorageBuffers = 0, rwStorageTextures = 0, rwStorageBuffers = 0;
    uint32_t threadsX = 1, threadsY = 1, threadsZ = 1;
};

class GpuContext {
public:
    bool init(SDL_Window* window, bool debug);   // window may be null (headless)
    void shutdown();

    SDL_GPUDevice* device() const { return dev_; }
    SDL_Window* window() const { return window_; }
    const char* driverName() const;
    SDL_GPUShaderFormat format() const { return format_; }

    SDL_GPUShader* loadShader(const std::string& name, SDL_GPUShaderStage stage);
    // requiredThreadsX != 0 asserts the shader's workgroup width (for shared indirect dispatch args).
    SDL_GPUComputePipeline* loadCompute(const std::string& name, uint32_t requiredThreadsX = 0);

    SDL_GPUBuffer* createBuffer(SDL_GPUBufferUsageFlags usage, uint32_t size, const char* debugName);
    void releaseBuffer(SDL_GPUBuffer*& buf);
    // Synchronous upload (initialisation / reset only, never per frame).
    void uploadNow(SDL_GPUBuffer* dst, const void* data, uint32_t size, uint32_t dstOffset = 0);
    // Synchronous readback (tests / benchmarks only).
    bool downloadNow(SDL_GPUBuffer* src, void* out, uint32_t size, uint32_t srcOffset = 0);

    uint64_t gpuBytesAllocated() const { return gpuBytes_; }
    const std::string& shaderDir() const { return shaderDir_; }

private:
    bool readFile(const std::string& path, std::vector<uint8_t>& out);
    bool loadReflection(const std::string& name, ShaderReflection& r);
    bool loadCode(const std::string& name, std::vector<uint8_t>& code, const char*& entry);

    SDL_GPUDevice* dev_ = nullptr;
    SDL_Window* window_ = nullptr;
    SDL_GPUShaderFormat format_ = SDL_GPU_SHADERFORMAT_INVALID;
    std::string shaderDir_;
    uint64_t gpuBytes_ = 0;
};

// One compute dispatch in its own compute pass (SDL3 GPU does not synchronise
// dispatches inside a single pass). Read-only buffers are bound in order to
// slots 0..n-1, read-write buffers are bound when the pass begins.
struct Dispatch {
    SDL_GPUCommandBuffer* cmd;
    SDL_GPUComputePipeline* pipeline;
    std::initializer_list<SDL_GPUBuffer*> ro;
    std::initializer_list<SDL_GPUBuffer*> rw;
    const void* uniforms;
    uint32_t uniformSize;
};
void dispatch(const Dispatch& d, uint32_t gx, uint32_t gy = 1, uint32_t gz = 1);
void dispatchIndirect(const Dispatch& d, SDL_GPUBuffer* args, uint32_t byteOffset);

} // namespace ttz
