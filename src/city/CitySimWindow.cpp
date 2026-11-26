#include "city/CitySimWindow.h"

#include "city/CityWorld.h"
#include "render/Renderer.h"
#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
double msNow() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
} // namespace

bool CitySimWindow::init(GpuContext& gpu, const CityAsset& city, const Sandbox& sb, Renderer& renderer) {
    gpu_ = &gpu;
    city_ = &city;
    cell_ = sb.cellSize;
    gw_ = sb.gridW;
    gh_ = sb.gridH;
    const uint32_t bytes = (uint32_t)(9u * gw_ * gh_ * 4u);
    for (auto& b : shadowBuf_) b = gpu.createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, bytes, "moonShadowWindow");
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, uploadBudget, 0};
    staging_ = SDL_CreateGPUTransferBuffer(gpu.device(), &tci);
    if (!shadowBuf_[0] || !shadowBuf_[1] || !staging_) return false;
    resetTo(sb, renderer);
    thread_ = std::thread(&CitySimWindow::workerLoop, this);
    return true;
}

void CitySimWindow::shutdown() {
    if (thread_.joinable()) {
        {
            std::lock_guard<std::mutex> l(m_);
            quit_ = true;
        }
        cv_.notify_all();
        thread_.join();
    }
    if (gpu_) {
        for (auto& b : shadowBuf_) gpu_->releaseBuffer(b);
        if (staging_) SDL_ReleaseGPUTransferBuffer(gpu_->device(), staging_);
        staging_ = nullptr;
        gpu_ = nullptr;
    }
    tiles_.clear();
}

const TileCPU* CitySimWindow::tile(int i, int j) {
    auto key = std::make_pair(i, j);
    auto it = tiles_.find(key);
    if (it == tiles_.end()) {
        auto t = std::make_unique<TileCPU>();
        if (!city_->decodeTileNow(i, j, *t)) t->heightCm.clear();
        for (auto& m : t->lod) m = CityMesh{};   // keep the collision grid only
        t->instances.clear();
        t->instances.shrink_to_fit();
        it = tiles_.emplace(key, std::move(t)).first;
    }
    return it->second->heightCm.empty() ? nullptr : it->second.get();
}

void CitySimWindow::compute(Job& job) {
    double t0 = msNow();
    const ShadowMargins m = cityShadowMargins(cell_);
    const int ew = gw_ + m.x0 + m.x1, eh = gh_ + m.z0 + m.z1;
    const float ex0 = job.ox - m.x0 * cell_, ez0 = job.oz - m.z0 * cell_;
    std::vector<float> ext;
    rasterCityHeights(*city_, [&](int i, int j) { return tile(i, j); }, ex0, ez0, cell_, ew, eh, ext);
    job.heights.resize((size_t)gw_ * gh_);
    for (int z = 0; z < gh_; ++z)
        std::memcpy(&job.heights[(size_t)z * gw_], &ext[(size_t)(z + m.z0) * ew + m.x0], (size_t)gw_ * 4);
    // shadow samples: the overlap with the previous window is copied (with the shadow margin a sample's value does
    // not depend on the window), only the newly exposed strips are marched
    job.shadow = std::make_shared<std::vector<float>>((size_t)9 * gw_ * gh_, -1.f);
    std::function<bool(int, int)> keep;
    const int W3 = 3 * gw_, H3 = 3 * gh_;
    const int sx = 3 * (int)std::lround((job.ox - job.prevX) / cell_), sz = 3 * (int)std::lround((job.oz - job.prevZ) / cell_);
    if (job.prevShadow) {
        const std::vector<float>& prev = *job.prevShadow;
        std::vector<float>& out = *job.shadow;
        keep = [&, sx, sz](int x, int z) {
            int px = x + sx, pz = z + sz;
            if (px < 0 || pz < 0 || px >= W3 || pz >= H3) return false;
            out[(size_t)z * W3 + x] = prev[(size_t)pz * W3 + px];
            return true;
        };
    }
    // background jobs leave most cores to the game; the first build uses all of them
    int threads = job.prevShadow ? (int)std::clamp(std::thread::hardware_concurrency() / 2, 1u, 4u) : 0;
    double t1 = msNow();
    cityShadowField(ext, ew, eh, ex0, ez0, cell_, job.ox, job.oz, gw_, gh_, *job.shadow, keep, threads);
    job.rasterMs = t1 - t0;
    // forget tiles far from the window (kept: the window plus two tiles around it)
    const float pad = 2.f * city_->tileSize;
    for (auto it = tiles_.begin(); it != tiles_.end();) {
        float tx = city_->x0 + it->first.first * city_->tileSize, tz = city_->z0 + it->first.second * city_->tileSize;
        bool far = tx + city_->tileSize < ex0 - pad || tz + city_->tileSize < ez0 - pad || tx > ex0 + ew * cell_ + pad ||
                   tz > ez0 + eh * cell_ + pad;
        it = far ? tiles_.erase(it) : std::next(it);
    }
    job.tilesCached = (int)tiles_.size();
    job.ms = msNow() - t0;
}

void CitySimWindow::workerLoop() {
    for (;;) {
        {
            std::unique_lock<std::mutex> l(m_);
            cv_.wait(l, [&] { return quit_ || hasJob_; });
            if (quit_) return;
        }
        compute(*job_);
        std::lock_guard<std::mutex> l(m_);
        hasJob_ = false;
        jobDone_ = true;
        cv_.notify_all();
    }
}

void CitySimWindow::uploadShadowNow(SDL_GPUBuffer* dst, const std::vector<float>& field) {
    gpu_->uploadNow(dst, field.data(), (uint32_t)(field.size() * 4));
}

void CitySimWindow::resetTo(const Sandbox& sb, Renderer& renderer) {
    {   // let a running job finish, then drop it
        std::unique_lock<std::mutex> l(m_);
        cv_.wait(l, [&] { return !hasJob_; });
        jobDone_ = false;
    }
    job_.reset();
    state_ = State::Idle;
    if (!shadow_ || sb.originX != ox_ || sb.originZ != oz_) {
        Job j;
        j.ox = sb.originX;
        j.oz = sb.originZ;
        compute(j);
        shadow_ = j.shadow;
        ox_ = sb.originX;
        oz_ = sb.originZ;
        SDL_WaitForGPUIdle(gpu_->device());
        uploadShadowNow(shadowBuf_[shadowCur_], *shadow_);
        SDL_Log("city sim window: (%.1f, %.1f), heights %.0f ms + moon shadow field %.0f ms", ox_, oz_, j.rasterMs, j.ms - j.rasterMs);
    }
    renderer.setSimWindow(ox_, oz_, shadowBuf_[shadowCur_]);
}

bool CitySimWindow::update(SDL_GPUCommandBuffer* cmd, float px, float pz, CrowdSim& sim, Renderer& renderer, Sandbox& sb) {
    if (!enabled || !gpu_) return false;
    const float W = gw_ * cell_, H = gh_ * cell_, S = stepCells * cell_;
    const float cx = ox_ + 0.5f * W, cz = oz_ + 0.5f * H;
    stats_.busy = state_ != State::Idle;
    if (state_ == State::Idle) {
        float ex = px - cx, ez = pz - cz;
        if (std::fabs(ex) <= triggerFraction * W && std::fabs(ez) <= triggerFraction * H) return false;
        int kx = (int)std::lround(ex / S), kz = (int)std::lround(ez / S);
        // stay inside the city (when it is larger than the window)
        while (kx < 0 && ox_ + kx * S < city_->x0) ++kx;
        while (kx > 0 && ox_ + kx * S + W > city_->x1) --kx;
        while (kz < 0 && oz_ + kz * S < city_->z0) ++kz;
        while (kz > 0 && oz_ + kz * S + H > city_->z1) --kz;
        if (kx == 0 && kz == 0) return false;
        job_ = std::make_unique<Job>();
        job_->ox = ox_ + kx * S;
        job_->oz = oz_ + kz * S;
        job_->prevX = ox_;
        job_->prevZ = oz_;
        job_->prevShadow = shadow_;
        {
            std::lock_guard<std::mutex> l(m_);
            hasJob_ = true;
            jobDone_ = false;
        }
        cv_.notify_all();
        state_ = State::Computing;
        stats_.busy = true;
        return false;
    }
    if (state_ == State::Computing) {
        std::lock_guard<std::mutex> l(m_);
        if (!jobDone_) return false;
        jobDone_ = false;
        state_ = State::Uploading;
        uploaded_ = 0;
        stats_.lastJobMs = job_->ms;
        lastRasterMs_ = job_->rasterMs;
        stats_.tilesCached = job_->tilesCached;
        stats_.maxJobMs = std::max(stats_.maxJobMs, job_->ms);
    }
    // Uploading: one chunk per frame into the standby buffer (not read by any frame in flight)
    double t0 = msNow();
    const std::vector<float>& field = *job_->shadow;
    const uint32_t total = (uint32_t)(field.size() * 4);
    SDL_GPUBuffer* standby = shadowBuf_[1 - shadowCur_];
    if (uploaded_ < total) {
        uint32_t n = std::min(uploadBudget, total - uploaded_);
        void* p = SDL_MapGPUTransferBuffer(gpu_->device(), staging_, true);
        std::memcpy(p, (const uint8_t*)field.data() + uploaded_, n);
        SDL_UnmapGPUTransferBuffer(gpu_->device(), staging_);
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTransferBufferLocation src{staging_, 0};
        SDL_GPUBufferRegion dst{standby, uploaded_, n};
        SDL_UploadToGPUBuffer(cp, &src, &dst, false);
        SDL_EndGPUCopyPass(cp);
        uploaded_ += n;
        if (uploaded_ < total) return false;
    }
    // commit, unless the pivot went back (the new window would be no better than the current one)
    const float nx = job_->ox + 0.5f * W, nz = job_->oz + 0.5f * H;
    if (std::max(std::fabs(px - nx), std::fabs(pz - nz)) >= std::max(std::fabs(px - cx), std::fabs(pz - cz))) {
        ++stats_.discarded;
        job_.reset();
        state_ = State::Idle;
        return false;
    }
    const int dx = (int)std::lround((job_->ox - ox_) / cell_), dz = (int)std::lround((job_->oz - oz_) / cell_);
    sim.relocate(cmd, dx, dz, job_->heights);
    shadowCur_ = 1 - shadowCur_;
    renderer.setSimWindow(job_->ox, job_->oz, shadowBuf_[shadowCur_]);
    ox_ = job_->ox;
    oz_ = job_->oz;
    sb.originX = ox_;
    sb.originZ = oz_;
    sb.heightOverride = std::move(job_->heights);
    shadow_ = job_->shadow;
    job_.reset();
    state_ = State::Idle;
    ++stats_.relocations;
    stats_.lastCommitCpuMs = msNow() - t0;
    stats_.maxCommitCpuMs = std::max(stats_.maxCommitCpuMs, stats_.lastCommitCpuMs);
    SDL_Log("city sim window -> (%.1f, %.1f) [%+d, %+d cells], worker %.0f ms (heights %.0f), commit %.2f ms CPU", ox_, oz_, dx, dz,
            stats_.lastJobMs, lastRasterMs_, stats_.lastCommitCpuMs);
    return true;
}

} // namespace ttz
