#include "city/CityAsset.h"

#include <SDL3/SDL.h>
#include <chrono>
#include <cstdio>

namespace ttz {

bool readFileBytes(const std::string& path, std::vector<uint8_t>& out) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fseek(f, 0, SEEK_END);
    long n = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    out.resize(n > 0 ? (size_t)n : 0);
    bool ok = n <= 0 || std::fread(out.data(), 1, out.size(), f) == out.size();
    std::fclose(f);
    return ok;
}

std::string CityAsset::tilePath(int i, int j) const {
    char name[64];
    std::snprintf(name, sizeof(name), "/tiles/%d_%d.bin", i, j);
    return dir_ + name;
}

bool CityAsset::decodeTileNow(int i, int j, TileCPU& out) const {
    out = TileCPU{};
    out.i = i;
    out.j = j;
    if (i < 0 || j < 0 || i >= ni || j >= nj || !tilePresent[(size_t)j * ni + i]) return false;
    auto t0 = std::chrono::steady_clock::now();
    std::vector<uint8_t> bytes;
    if (!readFileBytes(tilePath(i, j), bytes)) return false;
    out.fileBytes = bytes.size();
    out.ok = decodeTileBytes(bytes, out);
    out.decodeMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (!out.ok) SDL_Log("city: failed to decode tile %d_%d", i, j);
    return out.ok;
}

void CityAsset::start() {
    if (running_) return;
    quit_ = false;
    running_ = true;
    thread_ = std::thread([this] {
        for (;;) {
            std::pair<int, int> job;
            {
                std::unique_lock<std::mutex> lk(m_);
                cv_.wait(lk, [&] { return quit_ || !queue_.empty(); });
                if (quit_) return;
                job = queue_.front();
                queue_.pop_front();
            }
            TileCPU t;
            decodeTileNow(job.first, job.second, t);   // failures are delivered too (ok = false), so the caller stops waiting
            std::lock_guard<std::mutex> lk(m_);
            done_.push_back(std::move(t));
        }
    });
}

void CityAsset::stop() {
    if (!running_) return;
    {
        std::lock_guard<std::mutex> lk(m_);
        quit_ = true;
        queue_.clear();
    }
    cv_.notify_all();
    thread_.join();
    running_ = false;
    done_.clear();
}

void CityAsset::request(int i, int j) {
    {
        std::lock_guard<std::mutex> lk(m_);
        queue_.emplace_back(i, j);
    }
    cv_.notify_one();
}

std::vector<std::pair<int, int>> CityAsset::cancelQueued() {
    std::lock_guard<std::mutex> lk(m_);
    std::vector<std::pair<int, int>> out(queue_.begin(), queue_.end());
    queue_.clear();
    return out;
}

size_t CityAsset::queued() {
    std::lock_guard<std::mutex> lk(m_);
    return queue_.size();
}

bool CityAsset::pop(TileCPU& out) {
    std::lock_guard<std::mutex> lk(m_);
    if (done_.empty()) return false;
    out = std::move(done_.front());
    done_.pop_front();
    return true;
}

} // namespace ttz
