#include "gpu/GpuContext.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <regex>

namespace ttz {

static std::string findShaderDir() {
    std::vector<std::string> candidates;
    if (const char* base = SDL_GetBasePath()) candidates.push_back(std::string(base) + "shaders/");
#ifdef TTZ_SOURCE_DIR
    candidates.push_back(std::string(TTZ_SOURCE_DIR) + "/shaders/compiled/");
#endif
    candidates.push_back("shaders/compiled/");
    for (auto& c : candidates) {
        SDL_PathInfo info;
        if (SDL_GetPathInfo((c + "json").c_str(), &info) && info.type == SDL_PATHTYPE_DIRECTORY) return c;
    }
    return candidates.front();
}

bool GpuContext::init(SDL_Window* window, bool debug) {
    window_ = window;
    // SPIR-V (Vulkan) and MSL (Metal) are produced by tools/compile_shaders.py.
    // DXIL is not produced yet (needs DXC), so on Windows SDL selects Vulkan.
    dev_ = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_SPIRV | SDL_GPU_SHADERFORMAT_MSL, debug, nullptr);
    if (!dev_) {
        SDL_Log("SDL_CreateGPUDevice failed: %s", SDL_GetError());
        return false;
    }
    SDL_GPUShaderFormat f = SDL_GetGPUShaderFormats(dev_);
    if (f & SDL_GPU_SHADERFORMAT_SPIRV) format_ = SDL_GPU_SHADERFORMAT_SPIRV;
    else if (f & SDL_GPU_SHADERFORMAT_MSL) format_ = SDL_GPU_SHADERFORMAT_MSL;
    else {
        SDL_Log("No supported shader format");
        return false;
    }
    if (window_ && !SDL_ClaimWindowForGPUDevice(dev_, window_)) {
        SDL_Log("SDL_ClaimWindowForGPUDevice failed: %s", SDL_GetError());
        return false;
    }
    shaderDir_ = findShaderDir();
    SDL_Log("GPU driver: %s, shader dir: %s", driverName(), shaderDir_.c_str());
    return true;
}

void GpuContext::shutdown() {
    if (!dev_) return;
    if (window_) SDL_ReleaseWindowFromGPUDevice(dev_, window_);
    SDL_DestroyGPUDevice(dev_);
    dev_ = nullptr;
}

const char* GpuContext::driverName() const { return dev_ ? SDL_GetGPUDeviceDriver(dev_) : "none"; }

bool GpuContext::readFile(const std::string& path, std::vector<uint8_t>& out) {
    size_t size = 0;
    void* data = SDL_LoadFile(path.c_str(), &size);
    if (!data) return false;
    out.assign((uint8_t*)data, (uint8_t*)data + size);
    SDL_free(data);
    return true;
}

bool GpuContext::loadReflection(const std::string& name, ShaderReflection& r) {
    std::vector<uint8_t> js;
    if (!readFile(shaderDir_ + "json/" + name + ".json", js)) {
        SDL_Log("missing reflection for %s", name.c_str());
        return false;
    }
    std::string s(js.begin(), js.end());
    auto get = [&](const char* key) -> uint32_t {
        std::regex re(std::string("\"") + key + "\"\\s*:\\s*(\\d+)");
        std::smatch m;
        return std::regex_search(s, m, re) ? (uint32_t)std::stoul(m[1]) : 0u;
    };
    r.samplers = get("samplers");
    r.storageTextures = get("storage_textures");
    r.storageBuffers = get("storage_buffers");
    r.uniformBuffers = get("uniform_buffers");
    r.roStorageTextures = get("readonly_storage_textures");
    r.roStorageBuffers = get("readonly_storage_buffers");
    r.rwStorageTextures = get("readwrite_storage_textures");
    r.rwStorageBuffers = get("readwrite_storage_buffers");
    r.threadsX = std::max(1u, get("threadcount_x"));
    r.threadsY = std::max(1u, get("threadcount_y"));
    r.threadsZ = std::max(1u, get("threadcount_z"));
    return true;
}

bool GpuContext::loadCode(const std::string& name, std::vector<uint8_t>& code, const char*& entry) {
    if (format_ == SDL_GPU_SHADERFORMAT_SPIRV) {
        entry = "main";
        return readFile(shaderDir_ + "spirv/" + name + ".spv", code);
    }
    entry = "main0";  // SPIRV-Cross renames main -> main0 for Metal
    if (!readFile(shaderDir_ + "msl/" + name + ".msl", code)) return false;
    code.push_back(0);
    return true;
}

SDL_GPUShader* GpuContext::loadShader(const std::string& name, SDL_GPUShaderStage stage) {
    ShaderReflection r;
    std::vector<uint8_t> code;
    const char* entry = nullptr;
    if (!loadReflection(name, r) || !loadCode(name, code, entry)) {
        SDL_Log("failed to load shader %s", name.c_str());
        return nullptr;
    }
    SDL_GPUShaderCreateInfo ci{};
    ci.code = code.data();
    ci.code_size = code.size();
    ci.entrypoint = entry;
    ci.format = format_;
    ci.stage = stage;
    ci.num_samplers = r.samplers;
    ci.num_storage_textures = r.storageTextures;
    ci.num_storage_buffers = r.storageBuffers;
    ci.num_uniform_buffers = r.uniformBuffers;
    SDL_GPUShader* s = SDL_CreateGPUShader(dev_, &ci);
    if (!s) SDL_Log("SDL_CreateGPUShader(%s) failed: %s", name.c_str(), SDL_GetError());
    return s;
}

SDL_GPUComputePipeline* GpuContext::loadCompute(const std::string& name, uint32_t requiredThreadsX) {
    ShaderReflection r;
    std::vector<uint8_t> code;
    const char* entry = nullptr;
    std::string file = name + ".comp";
    if (!loadReflection(file, r) || !loadCode(file, code, entry)) {
        SDL_Log("failed to load compute shader %s", name.c_str());
        return nullptr;
    }
    if (requiredThreadsX && r.threadsX != requiredThreadsX) {
        SDL_Log("compute shader %s has local_size_x=%u, expected %u (shared indirect args)", name.c_str(), r.threadsX,
                requiredThreadsX);
        return nullptr;
    }
    SDL_GPUComputePipelineCreateInfo ci{};
    ci.code = code.data();
    ci.code_size = code.size();
    ci.entrypoint = entry;
    ci.format = format_;
    ci.num_samplers = r.samplers;
    ci.num_readonly_storage_textures = r.roStorageTextures;
    ci.num_readonly_storage_buffers = r.roStorageBuffers;
    ci.num_readwrite_storage_textures = r.rwStorageTextures;
    ci.num_readwrite_storage_buffers = r.rwStorageBuffers;
    ci.num_uniform_buffers = r.uniformBuffers;
    ci.threadcount_x = r.threadsX;
    ci.threadcount_y = r.threadsY;
    ci.threadcount_z = r.threadsZ;
    SDL_GPUComputePipeline* p = SDL_CreateGPUComputePipeline(dev_, &ci);
    if (!p) SDL_Log("SDL_CreateGPUComputePipeline(%s) failed: %s", name.c_str(), SDL_GetError());
    return p;
}

SDL_GPUBuffer* GpuContext::createBuffer(SDL_GPUBufferUsageFlags usage, uint32_t size, const char* debugName) {
    SDL_GPUBufferCreateInfo ci{};
    ci.usage = usage;
    ci.size = size;
    SDL_GPUBuffer* b = SDL_CreateGPUBuffer(dev_, &ci);
    if (!b) {
        SDL_Log("SDL_CreateGPUBuffer(%s, %u) failed: %s", debugName, size, SDL_GetError());
        return nullptr;
    }
    SDL_SetGPUBufferName(dev_, b, debugName);
    gpuBytes_ += size;
    return b;
}

void GpuContext::releaseBuffer(SDL_GPUBuffer*& buf) {
    if (buf) SDL_ReleaseGPUBuffer(dev_, buf);
    buf = nullptr;
}

void GpuContext::uploadNow(SDL_GPUBuffer* dst, const void* data, uint32_t size, uint32_t dstOffset) {
    if (size == 0) return;
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, size, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(dev_, &tci);
    void* p = SDL_MapGPUTransferBuffer(dev_, tb, false);
    std::memcpy(p, data, size);
    SDL_UnmapGPUTransferBuffer(dev_, tb);
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(dev_);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTransferBufferLocation src{tb, 0};
    SDL_GPUBufferRegion reg{dst, dstOffset, size};
    SDL_UploadToGPUBuffer(cp, &src, &reg, false);
    SDL_EndGPUCopyPass(cp);
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(dev_, true, &f, 1);
    SDL_ReleaseGPUFence(dev_, f);
    SDL_ReleaseGPUTransferBuffer(dev_, tb);
}

bool GpuContext::downloadNow(SDL_GPUBuffer* src, void* out, uint32_t size, uint32_t srcOffset) {
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD, size, 0};
    SDL_GPUTransferBuffer* tb = SDL_CreateGPUTransferBuffer(dev_, &tci);
    SDL_GPUCommandBuffer* cmd = SDL_AcquireGPUCommandBuffer(dev_);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUBufferRegion reg{src, srcOffset, size};
    SDL_GPUTransferBufferLocation dst{tb, 0};
    SDL_DownloadFromGPUBuffer(cp, &reg, &dst);
    SDL_EndGPUCopyPass(cp);
    SDL_GPUFence* f = SDL_SubmitGPUCommandBufferAndAcquireFence(cmd);
    SDL_WaitForGPUFences(dev_, true, &f, 1);
    SDL_ReleaseGPUFence(dev_, f);
    void* p = SDL_MapGPUTransferBuffer(dev_, tb, false);
    std::memcpy(out, p, size);
    SDL_UnmapGPUTransferBuffer(dev_, tb);
    SDL_ReleaseGPUTransferBuffer(dev_, tb);
    return true;
}

static SDL_GPUComputePass* beginPass(const Dispatch& d) {
    SDL_GPUStorageBufferReadWriteBinding rw[8]{};
    uint32_t n = 0;
    for (SDL_GPUBuffer* b : d.rw) rw[n++] = SDL_GPUStorageBufferReadWriteBinding{b, false};
    SDL_GPUComputePass* pass = SDL_BeginGPUComputePass(d.cmd, nullptr, 0, rw, n);
    SDL_BindGPUComputePipeline(pass, d.pipeline);
    if (d.ro.size()) {
        SDL_GPUBuffer* ro[12];
        uint32_t m = 0;
        for (SDL_GPUBuffer* b : d.ro) ro[m++] = b;
        SDL_BindGPUComputeStorageBuffers(pass, 0, ro, m);
    }
    if (d.uniforms) SDL_PushGPUComputeUniformData(d.cmd, 0, d.uniforms, d.uniformSize);
    return pass;
}

void dispatch(const Dispatch& d, uint32_t gx, uint32_t gy, uint32_t gz) {
    SDL_GPUComputePass* pass = beginPass(d);
    SDL_DispatchGPUCompute(pass, gx, gy, gz);
    SDL_EndGPUComputePass(pass);
}

void dispatchIndirect(const Dispatch& d, SDL_GPUBuffer* args, uint32_t byteOffset) {
    SDL_GPUComputePass* pass = beginPass(d);
    SDL_DispatchGPUComputeIndirect(pass, args, byteOffset);
    SDL_EndGPUComputePass(pass);
}

} // namespace ttz
