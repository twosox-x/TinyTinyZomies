#include "city/CityAmbient.h"

#include "city/Json.h"
#include "sim/SimParams.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <random>
#include <sstream>
#include <unordered_map>

namespace ttz {

bool AmbientConfig::load(const std::string& path, std::string* error) {
    std::ifstream in(path);
    if (!in) { if (error) *error = "cannot open " + path; return false; }
    std::stringstream ss;
    ss << in.rdbuf();
    std::string text = ss.str();
    json::Value root;
    if (!json::Parser(text).parse(root) || root.type != json::Value::Object) { if (error) *error = "parse error in " + path; return false; }
    const json::Value& a = root["ambient"];
    if (a.type != json::Value::Object) return true;   // no section: defaults
    auto num = [&](const char* k, float& v) { if (a.has(k)) v = a[k].f(v); };
    num("densityPerHa", densityPerHa); num("singleChance", singleChance); num("clusterChance", clusterChance);
    num("edgeWeight", edgeWeight); num("openWeight", openWeight); num("builtUpWeight", builtUpWeight);
    num("wanderSpeed", wanderSpeed); num("pauseFraction", pauseFraction); num("alertMemory", alertMemory);
    num("separation", separation); num("lurkerFraction", lurkerFraction); num("crawlerFraction", crawlerFraction);
    num("fieldWavelength", fieldWavelength);
    return true;
}

void AmbientConfig::apply(SimParams& p) const {
    p.roamEnabled = true;
    p.roamSpeed = wanderSpeed;
    p.roamPause = pauseFraction;
    p.roamMemory = alertMemory;
    p.roamSeparation = separation;
    p.roamLurkers = lurkerFraction;
    p.roamCrawlers = crawlerFraction;
    p.roamWavelength = fieldWavelength;
}

std::vector<Vec4> ambientSpawnPoints(const std::vector<float>& h, int gw, int gh, float ox, float oz, float cell,
                                     const AmbientConfig& cfg, uint32_t seed, int count, const std::function<bool(float, float)>& include) {
    std::vector<Vec4> out;
    const size_t N = (size_t)gw * gh;
    if (h.size() < N || gw <= 2 || gh <= 2 || count == 0) return out;
    auto open = [&](int x, int z) { return x >= 1 && z >= 1 && x < gw - 1 && z < gh - 1 && h[(size_t)z * gw + x] <= 0.f; };
    // distance to the nearest wall (anything above step height), chamfer 3-4 in cells
    std::vector<int> d(N, 1 << 20);
    for (size_t i = 0; i < N; ++i)
        if (h[i] > 0.45f) d[i] = 0;
    for (int z = 0; z < gh; ++z)
        for (int x = 0; x < gw; ++x) {
            int& v = d[(size_t)z * gw + x];
            if (x > 0) v = std::min(v, d[(size_t)z * gw + x - 1] + 3);
            if (z > 0) {
                v = std::min(v, d[(size_t)(z - 1) * gw + x] + 3);
                if (x > 0) v = std::min(v, d[(size_t)(z - 1) * gw + x - 1] + 4);
                if (x < gw - 1) v = std::min(v, d[(size_t)(z - 1) * gw + x + 1] + 4);
            }
        }
    for (int z = gh - 1; z >= 0; --z)
        for (int x = gw - 1; x >= 0; --x) {
            int& v = d[(size_t)z * gw + x];
            if (x < gw - 1) v = std::min(v, d[(size_t)z * gw + x + 1] + 3);
            if (z < gh - 1) {
                v = std::min(v, d[(size_t)(z + 1) * gw + x] + 3);
                if (x < gw - 1) v = std::min(v, d[(size_t)(z + 1) * gw + x + 1] + 4);
                if (x > 0) v = std::min(v, d[(size_t)(z + 1) * gw + x - 1] + 4);
            }
        }
    // building coverage in a ~40 m box (integral image of cells taller than 2.5 m)
    std::vector<uint32_t> ii((size_t)(gw + 1) * (gh + 1), 0);
    for (int z = 0; z < gh; ++z)
        for (int x = 0; x < gw; ++x)
            ii[(size_t)(z + 1) * (gw + 1) + x + 1] = (h[(size_t)z * gw + x] > 2.5f ? 1u : 0u) + ii[(size_t)z * (gw + 1) + x + 1] +
                                                     ii[(size_t)(z + 1) * (gw + 1) + x] - ii[(size_t)z * (gw + 1) + x];
    const int R = std::max(1, (int)std::lround(20.f / cell));
    auto coverage = [&](int x, int z) {
        int x0 = std::max(0, x - R), z0 = std::max(0, z - R), x1 = std::min(gw, x + R + 1), z1 = std::min(gh, z + R + 1);
        uint32_t s = ii[(size_t)z1 * (gw + 1) + x1] - ii[(size_t)z0 * (gw + 1) + x1] - ii[(size_t)z1 * (gw + 1) + x0] + ii[(size_t)z0 * (gw + 1) + x0];
        return (float)s / (float)std::max(1, (x1 - x0) * (z1 - z0));
    };
    // cell weights
    std::vector<double> cdf;
    std::vector<uint32_t> cellOf;
    cdf.reserve(N / 2);
    cellOf.reserve(N / 2);
    double acc = 0;
    size_t openCells = 0;
    for (int z = 1; z < gh - 1; ++z)
        for (int x = 1; x < gw - 1; ++x) {
            if (!open(x, z)) continue;
            float wx = ox + (x + 0.5f) * cell, wz = oz + (z + 0.5f) * cell;
            if (include && !include(wx, wz)) continue;
            ++openCells;
            float dm = d[(size_t)z * gw + x] / 3.f * cell;
            float f;
            if (dm < 1.f) f = 0.7f;
            else if (dm < 4.f) f = cfg.edgeWeight;
            else if (dm < 12.f) f = 1.f;
            else if (dm < 25.f) f = 1.f + (cfg.openWeight - 1.f) * (dm - 12.f) / 13.f;
            else f = cfg.openWeight;
            float w = f * (0.4f + cfg.builtUpWeight * coverage(x, z));
            if (w <= 0.f) continue;
            acc += w;
            cdf.push_back(acc);
            cellOf.push_back((uint32_t)(z * gw + x));
        }
    if (cdf.empty()) return out;
    int target = count >= 0 ? count : (int)std::lround(cfg.densityPerHa * openCells * cell * cell / 1.0e4);
    if (target <= 0) return out;
    std::mt19937 rng(seed * 2654435761u + 12345u);
    std::uniform_real_distribution<float> U(0.f, 1.f);
    auto pickCell = [&]() {
        double r = U(rng) * acc;
        size_t k = (size_t)(std::lower_bound(cdf.begin(), cdf.end(), r) - cdf.begin());
        return cellOf[std::min(k, cellOf.size() - 1)];
    };
    out.reserve((size_t)target);
    std::vector<Vec4> grp;
    int guard = 0;
    while ((int)out.size() < target && guard++ < target * 4 + 100) {
        float r = U(rng);
        int n;
        uint32_t c = pickCell();
        if (r < cfg.singleChance) n = 1;
        else if (r < cfg.singleChance + cfg.clusterChance) {   // cluster: the most built-up of a few candidates
            n = 10 + (int)(U(rng) * 15.f);
            float best = -1;
            for (int t = 0; t < 6; ++t) {
                uint32_t k = pickCell();
                float cv = coverage((int)(k % gw), (int)(k / gw));
                if (cv > best) { best = cv; c = k; }
            }
        } else n = 2 + (int)(U(rng) * 7.f);
        n = std::min(n, target - (int)out.size());
        float cx = ox + ((float)(c % gw) + U(rng)) * cell, cz = oz + ((float)(c / gw) + U(rng)) * cell;
        float rad = 0.9f + 1.05f * std::sqrt((float)n);
        grp.clear();
        for (int m = 0; m < n; ++m) {
            for (int t = 0; t < 16; ++t) {
                float a = U(rng) * 6.2831853f, rr = m == 0 && t == 0 ? 0.f : rad * std::sqrt(U(rng));
                float px = cx + std::cos(a) * rr, pz = cz + std::sin(a) * rr;
                int gx = (int)std::floor((px - ox) / cell), gz = (int)std::floor((pz - oz) / cell);
                if (!open(gx, gz) || (include && !include(px, pz))) continue;
                bool ok = true;
                for (const Vec4& q : grp)
                    if ((q.x - px) * (q.x - px) + (q.y - pz) * (q.y - pz) < 0.95f * 0.95f) { ok = false; break; }
                if (!ok) continue;
                grp.push_back({px, pz, 0.6f, 0.f});
                break;
            }
        }
        out.insert(out.end(), grp.begin(), grp.end());
    }
    return out;
}

SpreadStats spreadStats(const std::vector<float>& xz, float link) {
    SpreadStats s;
    const size_t n = xz.size() / 2;
    s.n = n;
    if (n < 2) return s;
    const float L = std::max(link, 0.1f);
    auto key = [&](float x, float z) { return ((int64_t)std::floor(x / L) << 32) ^ (int64_t)(uint32_t)(int32_t)std::floor(z / L); };
    std::unordered_map<int64_t, std::vector<uint32_t>> g;
    for (size_t i = 0; i < n; ++i) g[key(xz[2 * i], xz[2 * i + 1])].push_back((uint32_t)i);
    std::vector<uint32_t> par(n);
    for (size_t i = 0; i < n; ++i) par[i] = (uint32_t)i;
    auto find = [&](uint32_t a) { while (par[a] != a) a = par[a] = par[par[a]]; return a; };
    std::vector<float> nn(n, 1e9f);
    for (size_t i = 0; i < n; ++i) {
        float x = xz[2 * i], z = xz[2 * i + 1];
        int cx = (int)std::floor(x / L), cz = (int)std::floor(z / L);
        // nearest neighbour: grow the ring until a neighbour is found within it (cap 30 m); ring 1 (all cells within
        // +-1) holds every pair closer than the link distance
        for (int ring = 1; ring <= (int)std::ceil(30.f / L); ++ring) {
            for (int dz = -ring; dz <= ring; ++dz)
                for (int dx = -ring; dx <= ring; ++dx) {
                    if (std::max(std::abs(dx), std::abs(dz)) != ring && ring > 1) continue;
                    auto it = g.find(((int64_t)(cx + dx) << 32) ^ (int64_t)(uint32_t)(cz + dz));
                    if (it == g.end()) continue;
                    for (uint32_t j : it->second) {
                        if (j == i) continue;
                        float d = std::hypot(xz[2 * j] - x, xz[2 * j + 1] - z);
                        nn[i] = std::min(nn[i], d);
                        if (d <= L) { uint32_t a = find((uint32_t)i), b = find(j); if (a != b) par[a] = b; }
                    }
                }
            if (nn[i] <= ring * L) break;
        }
    }
    std::vector<float> sorted = nn;
    std::sort(sorted.begin(), sorted.end());
    s.nnMedian = sorted[n / 2];
    s.nnP10 = sorted[n / 10];
    double sum = 0;
    size_t below = 0;
    for (float v : nn) { sum += std::min(v, 30.f); below += v < 1.f ? 1 : 0; }
    s.nnMean = (float)(sum / n);
    s.fracNnBelow1m = (float)below / n;
    std::unordered_map<uint32_t, size_t> sizes;
    for (size_t i = 0; i < n; ++i) ++sizes[find((uint32_t)i)];
    s.clusters = sizes.size();
    size_t big = 0;
    for (auto& kv : sizes) {
        s.largestCluster = std::max(s.largestCluster, kv.second);
        if (kv.second == 1) ++s.singles;
        if (kv.second > 20) big += kv.second;
    }
    s.meanClusterSize = (float)n / (float)s.clusters;
    s.fracInClustersOver20 = (float)big / n;
    return s;
}

} // namespace ttz
