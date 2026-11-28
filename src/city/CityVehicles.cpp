#include "city/CityVehicles.h"

#include "sim/CrowdSim.h"
#include "sim/Sandbox.h"

#include <SDL3/SDL_timer.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
struct F3 {
    float x = 0, y = 0, z = 0;
};
inline F3 operator+(F3 a, F3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline F3 operator-(F3 a, F3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline F3 operator*(F3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot3(F3 a, F3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline F3 cross3(F3 a, F3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float len3(F3 a) { return std::sqrt(dot3(a, a)); }
inline F3 ld(const float* p) { return {p[0], p[1], p[2]}; }
inline void st(float* p, F3 a) { p[0] = a.x; p[1] = a.y; p[2] = a.z; }

// rotation by unit quaternion (x, y, z, w)
inline F3 rot(const float* q, F3 v) {
    F3 u{q[0], q[1], q[2]};
    F3 t = cross3(u, v) * 2.f;
    return v + t * q[3] + cross3(u, t);
}
inline F3 rotInv(const float* q, F3 v) {
    float c[4] = {-q[0], -q[1], -q[2], q[3]};
    return rot(c, v);
}
inline void qnorm(float* q) {
    float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(l > 1e-6f)) { q[0] = q[1] = q[2] = 0; q[3] = 1; return; }
    for (int k = 0; k < 4; ++k) q[k] /= l;
}
inline bool finite3(const float* p) { return std::isfinite(p[0]) && std::isfinite(p[1]) && std::isfinite(p[2]); }

std::vector<std::string> splitKey(const std::string& s) {
    std::vector<std::string> out;
    size_t a = 0;
    for (;;) {
        size_t b = s.find('|', a);
        out.push_back(s.substr(a, b == std::string::npos ? std::string::npos : b - a));
        if (b == std::string::npos) break;
        a = b + 1;
    }
    return out;
}

float kindMass(const std::string& k) {
    if (k.rfind("tanker", 0) == 0 || k.rfind("semi", 0) == 0) return 4.5f;
    if (k == "city_bus" || k == "school_bus" || k == "fire_engine" || k == "garbage_truck") return 3.5f;
    if (k == "box_truck" || k == "ambulance") return 2.2f;
    if (k == "delivery_van" || k == "panel_van") return 1.7f;
    if (k == "pickup" || k == "suv" || k == "minivan") return 1.3f;
    return 1.f;
}
float kindBlast(const std::string& k) {
    if (k.rfind("tanker", 0) == 0) return 2.2f;   // fuel
    if (k.rfind("semi", 0) == 0 || k == "city_bus" || k == "school_bus" || k == "fire_engine" || k == "garbage_truck") return 1.5f;
    if (k == "box_truck" || k == "ambulance" || k == "delivery_van" || k == "panel_van") return 1.2f;
    return 1.f;
}

constexpr float kSub = 1.f / 120.f;          // physics substep
constexpr float kGravity = 9.81f;
constexpr float kBlastRadius = 9.5f;         // m at scale 1 (distance to the box surface)
constexpr float kBlastDamage = 160.f;        // health within kBlastCore (intact = 100, burning at 0)
constexpr float kBlastCore = 2.f;            // m (at scale 1) from the box surface
constexpr float kBlastSpeed = 9.f;           // m/s for a 1-mass car at the blast centre
constexpr float kDamagedAt = 60.f;
constexpr float kLowStamp = 1.6f;            // moving vehicles block zombies while their bottom is this close to the ground
} // namespace

void CityVehicles::init(const std::vector<ModelVariant>& variants) {
    std::vector<VehicleModel> m(variants.size());
    std::vector<std::vector<std::string>> keys(variants.size());
    for (size_t k = 0; k < variants.size(); ++k) {
        keys[k] = splitKey(variants[k].name);
        VehicleModel& M = m[k];
        M.kind = keys[k][0];
        const std::string st = keys[k].size() > 1 ? keys[k][1] : "ok";
        M.stateTag = st == "damaged" ? 1 : st == "crashed" ? 2 : st == "burnt" ? 3 : 0;
        M.dynamic = !(M.kind == "p" || M.kind.rfind("prop", 0) == 0);
        const CityMesh& mesh = variants[k].lod0;
        bool hasBounds = mesh.bmax[0] > mesh.bmin[0] && mesh.bmax[1] > mesh.bmin[1];
        for (int c = 0; c < 3; ++c) {
            M.bmin[c] = hasBounds ? mesh.bmin[c] : (c == 1 ? 0.f : -1.f);
            M.bmax[c] = hasBounds ? mesh.bmax[c] : (c == 1 ? 1.5f : 1.f);
        }
        M.mass = kindMass(M.kind);
        M.blastScale = kindBlast(M.kind);
    }
    // state variants of the same kind: same door / side token preferred, then the plainest one
    for (size_t k = 0; k < m.size(); ++k) {
        auto find = [&](int tag) {
            int best = -1, bestScore = -1;
            for (size_t o = 0; o < m.size(); ++o) {
                if (m[o].kind != m[k].kind || m[o].stateTag != tag) continue;
                int score = 1;
                if (keys[o].size() > 2 && keys[k].size() > 2 && keys[o][2] == keys[k][2]) score += 4;
                bool plain = true;
                for (size_t t = 3; t < keys[o].size(); ++t) plain &= keys[o][t] == "0";
                score += plain ? 2 : 0;
                if (score > bestScore) { bestScore = score; best = (int)o; }
            }
            return best;
        };
        int dmg = find(1), burnt = find(3), crashed = find(2);
        m[k].damaged = dmg >= 0 ? dmg : crashed >= 0 ? crashed : (int)k;
        m[k].burnt = burnt >= 0 ? burnt : crashed >= 0 ? crashed : m[k].damaged;
        m[k].darkenBurnt = burnt < 0;
    }
    initModels(std::move(m));
}

void CityVehicles::initModels(std::vector<VehicleModel> models) {
    models_ = std::move(models);
    for (size_t k = 0; k < models_.size(); ++k) {
        if (models_[k].damaged < 0) models_[k].damaged = (int)k;
        if (models_[k].burnt < 0) models_[k].burnt = models_[k].damaged;
    }
    clear();
}

void CityVehicles::clear() {
    all_.clear();
    tiles_.clear();
    custom_.clear();
    window_.clear();
    explodeQueue_.clear();
    stats_ = {};
}

float CityVehicles::rand01() {
    rng_ ^= rng_ << 13;
    rng_ ^= rng_ >> 17;
    rng_ ^= rng_ << 5;
    return (rng_ >> 8) * (1.f / 16777216.f);
}

void CityVehicles::com(const Vehicle& v, float out[3]) const {
    const VehicleModel& M = models_[v.variant];
    for (int c = 0; c < 3; ++c) out[c] = 0.5f * (M.bmin[c] + M.bmax[c]);
}

void CityVehicles::updateRenderOrigin(Vehicle& v) const {
    float c[3];
    com(v, c);
    st(v.ro, ld(v.p) - rot(v.q, ld(c)));
}

void CityVehicles::setVariant(Vehicle& v, uint16_t variant) {
    if (variant == v.variant || variant >= models_.size()) return;
    // keep the model origin where it is (the bounds and so the centre of mass differ between variants)
    updateRenderOrigin(v);
    v.variant = variant;
    float c[3];
    com(v, c);
    st(v.p, ld(v.ro) + rot(v.q, ld(c)));
}

void CityVehicles::worldCorners(const Vehicle& v, float out[8][3]) const {
    const VehicleModel& M = models_[v.variant];
    float c[3];
    com(v, c);
    for (int k = 0; k < 8; ++k) {
        F3 l{(k & 1 ? M.bmax[0] : M.bmin[0]) - c[0], (k & 2 ? M.bmax[1] : M.bmin[1]) - c[1], (k & 4 ? M.bmax[2] : M.bmin[2]) - c[2]};
        st(out[k], ld(v.p) + rot(v.q, l));
    }
}

uint32_t CityVehicles::vehicleIndex(int key, uint32_t i) const {
    auto it = tiles_.find(key);
    if (it == tiles_.end() || i >= it->second.second) return UINT32_MAX;
    return it->second.first + i;
}

const Vehicle* CityVehicles::tileVehicles(int key, uint32_t& count) const {
    auto it = tiles_.find(key);
    if (it == tiles_.end()) { count = 0; return nullptr; }
    count = it->second.second;
    return count ? &all_[it->second.first] : nullptr;
}

void CityVehicles::registerTile(int key, const std::vector<CityInstance>& instances) {
    if (models_.empty() || tiles_.count(key)) return;
    uint32_t first = (uint32_t)all_.size(), n = 0;
    for (const CityInstance& in : instances) {
        if (in.kind != 0) break;
        Vehicle v{};
        v.bp[0] = in.x; v.bp[1] = in.y; v.bp[2] = in.z;
        std::memcpy(v.bq, in.q, sizeof(v.bq));
        std::memcpy(v.q, in.q, sizeof(v.q));
        std::memcpy(v.paint, in.paint, sizeof(v.paint));
        v.variant = v.bakedVariant = in.variant < models_.size() ? in.variant : 0;
        float c[3];
        com(v, c);
        st(v.p, ld(v.bp) + rot(v.q, ld(c)));
        st(v.ro, ld(v.bp));
        if (!models_[v.variant].dynamic || in.variant >= models_.size()) v.health = -1e9f;   // never simulated
        all_.push_back(v);
        ++n;
    }
    tiles_[key] = {first, n};
    stats_.known = (uint32_t)all_.size();
    if (gw_ <= 0) return;
    // vehicles in the window: their baked footprints become ground, then they are stamped back at their pose
    int x0 = 1 << 30, z0 = 1 << 30, x1 = -1, z1 = -1;
    for (uint32_t i = first; i < first + n; ++i) {
        size_t before = window_.size();
        addToWindow(i);
        if (window_.size() == before) continue;
        clearBakedFootprint(all_[i]);
        x0 = std::min<int>(x0, all_[i].sx0); z0 = std::min<int>(z0, all_[i].sz0);
        x1 = std::max<int>(x1, all_[i].sx1); z1 = std::max<int>(z1, all_[i].sz1);
    }
    if (x1 >= x0) {
        restampSolid(x0, z0, x1, z1, UINT32_MAX);
        markDirty(z0, z1);
    }
}

void CityVehicles::addToWindow(uint32_t i) {
    Vehicle& v = all_[i];
    const float W = gw_ * cell_, H = gh_ * cell_;
    auto inside = [&](const float* p) { return p[0] >= ox_ && p[2] >= oz_ && p[0] < ox_ + W && p[2] < oz_ + H; };
    v.inWindow = gw_ > 0 && v.health > -1e8f && (inside(v.bp) || inside(v.p));
    if (!v.inWindow) return;
    window_.push_back(i);
    computeRect(v);
}

void CityVehicles::computeRect(Vehicle& v) const {
    const float W = gw_ * cell_, H = gh_ * cell_;
    // stamp rectangle: AABB of the corners
    float c[8][3];
    worldCorners(v, c);
    float mnx = 1e30f, mnz = 1e30f, mxx = -1e30f, mxz = -1e30f;
    for (auto& k : c) { mnx = std::min(mnx, k[0]); mxx = std::max(mxx, k[0]); mnz = std::min(mnz, k[2]); mxz = std::max(mxz, k[2]); }
    v.sx0 = (int16_t)std::clamp((int)std::floor((mnx - ox_) / cell_), 0, gw_ - 1);
    v.sx1 = (int16_t)std::clamp((int)std::floor((mxx - ox_) / cell_), 0, gw_ - 1);
    v.sz0 = (int16_t)std::clamp((int)std::floor((mnz - oz_) / cell_), 0, gh_ - 1);
    v.sz1 = (int16_t)std::clamp((int)std::floor((mxz - oz_) / cell_), 0, gh_ - 1);
    if (mxx < ox_ || mxz < oz_ || mnx >= ox_ + W || mnz >= oz_ + H) v.sx1 = -1;   // wholly outside: no cells
}

// Samples of the box volume (half a cell apart); fn(world point).
template <class Fn>
static void sampleBox(const VehicleModel& M, const float* origin, const float* q, float inset, float step, Fn&& fn) {
    float lo[3], hi[3];
    for (int c = 0; c < 3; ++c) {
        float in = c == 1 ? 0.f : inset;
        lo[c] = M.bmin[c] + in;
        hi[c] = std::max(lo[c], M.bmax[c] - in);
    }
    int n[3];
    for (int c = 0; c < 3; ++c) n[c] = std::max(1, (int)std::ceil((hi[c] - lo[c]) / step));
    F3 o = ld(origin);
    F3 ax = rot(q, {1, 0, 0}), ay = rot(q, {0, 1, 0}), az = rot(q, {0, 0, 1});
    for (int iy = 0; iy <= n[1]; ++iy) {
        float ly = lo[1] + (hi[1] - lo[1]) * iy / n[1];
        for (int iz = 0; iz <= n[2]; ++iz) {
            float lz = lo[2] + (hi[2] - lo[2]) * iz / n[2];
            for (int ix = 0; ix <= n[0]; ++ix) {
                float lx = lo[0] + (hi[0] - lo[0]) * ix / n[0];
                fn(o + ax * lx + ay * ly + az * lz);
            }
        }
    }
}

void CityVehicles::clearBakedFootprint(const Vehicle& v) {
    const VehicleModel& M = models_[v.bakedVariant];
    const float ground = std::max(0.f, v.bp[1]);
    const float top = v.bp[1] + M.bmax[1] + 0.35f;
    sampleBox(M, v.bp, v.bq, 0.f, 0.5f * cell_, [&](F3 p) {
        int cx = (int)std::floor((p.x - ox_) / cell_), cz = (int)std::floor((p.z - oz_) / cell_);
        if (cx < 0 || cz < 0 || cx >= gw_ || cz >= gh_) return;
        float& b = base_[(size_t)cz * gw_ + cx];
        if (b <= top) b = std::min(b, ground);   // a building edge in the same cell stays
    });
}

void CityVehicles::stamp(const Vehicle& v, std::vector<float>& grid, const int* rows, float inset) const {
    // physics grid (solid_): box inset 0.25 m so that neighbours parked bumper to bumper do not collide through the
    // 0.75 m quantisation; obstacle grids for zombies (obst_, simH_): the whole box. rows: only rows [0], [1].
    sampleBox(models_[v.variant], v.ro, v.q, inset, 0.5f * cell_, [&](F3 p) {
        int cx = (int)std::floor((p.x - ox_) / cell_), cz = (int)std::floor((p.z - oz_) / cell_);
        if (cx < 0 || cz < 0 || cx >= gw_ || cz >= gh_) return;
        if (rows && (cz < rows[0] || cz > rows[1])) return;
        float& g = grid[(size_t)cz * gw_ + cx];
        g = std::max(g, p.y);
    });
}

// Rebuilds solid_ and obst_ in a cell rectangle from base_ + the sleeping vehicles overlapping it (except one). A
// neighbour stamped whole also writes cells outside the rectangle: max() with its own earlier stamp, no change.
void CityVehicles::restampSolid(int x0, int z0, int x1, int z1, uint32_t except) {
    x0 = std::max(0, x0); z0 = std::max(0, z0); x1 = std::min(gw_ - 1, x1); z1 = std::min(gh_ - 1, z1);
    if (x1 < x0 || z1 < z0) return;
    for (int z = z0; z <= z1; ++z) {
        std::memcpy(&solid_[(size_t)z * gw_ + x0], &base_[(size_t)z * gw_ + x0], (size_t)(x1 - x0 + 1) * 4);
        std::memcpy(&obst_[(size_t)z * gw_ + x0], &base_[(size_t)z * gw_ + x0], (size_t)(x1 - x0 + 1) * 4);
    }
    for (uint32_t j : window_) {
        const Vehicle& o = all_[j];
        if (j == except || o.active || o.sx1 < o.sx0) continue;
        if (o.sx1 < x0 || o.sx0 > x1 || o.sz1 < z0 || o.sz0 > z1) continue;
        stamp(o, solid_, nullptr, 0.25f);
        stamp(o, obst_, nullptr, 0.f);
    }
    const float rx0 = ox_ + x0 * cell_, rz0 = oz_ + z0 * cell_, rx1 = ox_ + (x1 + 1) * cell_, rz1 = oz_ + (z1 + 1) * cell_;
    for (const GameObstacle& g : gobst_) {
        const float r = std::sqrt(g.hx * g.hx + g.hz * g.hz) + cell_;
        if (g.alive && g.cx + r >= rx0 && g.cx - r <= rx1 && g.cz + r >= rz0 && g.cz - r <= rz1) stampObstacle(g, obst_);
    }
}

void CityVehicles::stampObstacle(const GameObstacle& o, std::vector<float>& grid) const {
    // sampled every half cell (game::forEachObbCell uses the same rule for its masks)
    const float step = 0.5f * cell_, c = std::cos(o.yaw), s = std::sin(o.yaw);
    const int nu = std::max(1, (int)std::ceil(2.f * o.hx / step)), nv = std::max(1, (int)std::ceil(2.f * o.hz / step));
    for (int i = 0; i <= nu; ++i)
        for (int j = 0; j <= nv; ++j) {
            const float u = -o.hx + 2.f * o.hx * (float)i / (float)nu, v = -o.hz + 2.f * o.hz * (float)j / (float)nv;
            const float x = o.cx + u * c + v * s, z = o.cz - u * s + v * c;
            const int cx = (int)std::floor((x - ox_) / cell_), cz = (int)std::floor((z - oz_) / cell_);
            if (cx < 0 || cz < 0 || cx >= gw_ || cz >= gh_) continue;
            float& g = grid[(size_t)cz * gw_ + cx];
            g = std::max(g, o.top);
        }
}

uint32_t CityVehicles::addObstacle(float cx, float cz, float halfX, float halfZ, float yaw, float top) {
    uint32_t id = (uint32_t)gobst_.size();
    for (uint32_t i = 0; i < gobst_.size(); ++i) if (!gobst_[i].alive) { id = i; break; }
    const GameObstacle o{cx, cz, halfX, halfZ, yaw, top, true};
    if (id == gobst_.size()) gobst_.push_back(o); else gobst_[id] = o;
    if (gw_ > 0 && !obst_.empty()) {
        stampObstacle(o, obst_);
        const float r = std::sqrt(halfX * halfX + halfZ * halfZ) + cell_;
        markDirty((int)std::floor((cz - r - oz_) / cell_), (int)std::floor((cz + r - oz_) / cell_));
    }
    return id;
}

void CityVehicles::removeObstacle(uint32_t id) {
    if (id >= gobst_.size() || !gobst_[id].alive) return;
    GameObstacle& o = gobst_[id];
    o.alive = false;
    if (gw_ <= 0 || obst_.empty()) return;
    const float r = std::sqrt(o.hx * o.hx + o.hz * o.hz) + cell_;
    const int x0 = (int)std::floor((o.cx - r - ox_) / cell_), x1 = (int)std::floor((o.cx + r - ox_) / cell_);
    const int z0 = (int)std::floor((o.cz - r - oz_) / cell_), z1 = (int)std::floor((o.cz + r - oz_) / cell_);
    restampSolid(x0, z0, x1, z1, UINT32_MAX);   // base + parked vehicles + the remaining obstacles in the rectangle
    markDirty(z0, z1);
}

void CityVehicles::setWindow(float ox, float oz, float cell, int gw, int gh, const std::vector<float>& heights) {
    if ((size_t)gw * gh != heights.size()) return;
    // vehicles moving when the window leaves them stop where they are
    for (uint32_t i : window_) all_[i].inWindow = false;
    ox_ = ox; oz_ = oz; cell_ = cell; gw_ = gw; gh_ = gh;
    window_.clear();
    base_ = heights;
    uploaded_ = heights;   // what the simulation has now
    for (uint32_t i = 0; i < all_.size(); ++i) {
        Vehicle& v = all_[i];
        if (v.active) {
            float c[3] = {v.p[0], v.p[1], v.p[2]};
            const float W = gw * cell, H = gh * cell;
            if (c[0] < ox || c[2] < oz || c[0] >= ox + W || c[2] >= oz + H) sleep(i);
        }
        addToWindow(i);
    }
    for (uint32_t i : window_) clearBakedFootprint(all_[i]);
    for (uint32_t i = 0; i < all_.size(); ++i)   // vehicles cleared by engineers: their baked footprint is ground too
        if (all_[i].removed) { computeRect(all_[i]); if (all_[i].sx1 >= all_[i].sx0) clearBakedFootprint(all_[i]); }
    solid_ = base_;
    obst_ = base_;
    for (uint32_t i : window_)
        if (!all_[i].active) { stamp(all_[i], solid_, nullptr, 0.25f); stamp(all_[i], obst_, nullptr, 0.f); }
    for (const GameObstacle& g : gobst_) if (g.alive) stampObstacle(g, obst_);
    simH_ = base_;
    rowDirty_.assign((size_t)gh_, 1);
    explodeQueue_.erase(std::remove_if(explodeQueue_.begin(), explodeQueue_.end(), [&](uint32_t i) {
                            if (all_[i].inWindow) return false;
                            all_[i].queued = false;
                            return true;
                        }),
                        explodeQueue_.end());
}

void CityVehicles::groundBox(uint32_t i, float& cx, float& cz, float& hx, float& hz, float& yaw) const {
    const Vehicle& v = all_[i];
    const VehicleModel& M = models_[v.variant];
    const F3 ax = rot(v.q, {1, 0, 0});
    yaw = std::atan2(-ax.z, ax.x);
    const float mx = 0.5f * (M.bmin[0] + M.bmax[0]), mz = 0.5f * (M.bmin[2] + M.bmax[2]);
    const F3 c = ld(v.ro) + rot(v.q, {mx, 0.f, mz});
    cx = c.x; cz = c.z;
    hx = 0.5f * (M.bmax[0] - M.bmin[0]);
    hz = 0.5f * (M.bmax[2] - M.bmin[2]);
}

uint32_t CityVehicles::parkedAt(float x, float z, float maxR) const {
    uint32_t best = UINT32_MAX;
    float bd = maxR;
    for (uint32_t i : window_) {
        const Vehicle& v = all_[i];
        if (v.removed || v.active || v.health < -1e8f) continue;
        float cx, cz, hx, hz, yaw;
        groundBox(i, cx, cz, hx, hz, yaw);
        const float c = std::cos(yaw), s = std::sin(yaw), dx = x - cx, dz = z - cz;
        const float u = std::fabs(dx * c - dz * s) - hx, w = std::fabs(dx * s + dz * c) - hz;
        const float d = std::hypot(std::max(0.f, u), std::max(0.f, w));
        if (d < bd || (d == 0.f && bd == 0.f)) { bd = d; best = i; }
    }
    return best;
}

bool CityVehicles::removeVehicle(uint32_t i) {
    if (i >= all_.size() || all_[i].removed) return false;
    Vehicle& v = all_[i];
    if (!v.custom) { v.custom = true; custom_.push_back(i); }   // the baked instance is no longer drawn
    v.removed = true;
    v.active = false;
    v.queued = false;
    v.health = -1e9f;   // never simulated again (blasts, fuses)
    explodeQueue_.erase(std::remove(explodeQueue_.begin(), explodeQueue_.end(), i), explodeQueue_.end());
    if (v.inWindow) {
        clearBakedFootprint(v);
        window_.erase(std::remove(window_.begin(), window_.end(), i), window_.end());
        v.inWindow = false;
        if (v.sx1 >= v.sx0) { restampSolid(v.sx0, v.sz0, v.sx1, v.sz1, i); markDirty(v.sz0, v.sz1); }
    }
    return true;
}

float CityVehicles::groundAt(float x, float z) const {
    int cx = (int)std::floor((x - ox_) / cell_), cz = (int)std::floor((z - oz_) / cell_);
    if (cx < 0 || cz < 0 || cx >= gw_ || cz >= gh_) return 0.f;
    return base_[(size_t)cz * gw_ + cx];
}

float CityVehicles::solidAt(float x, float z) const {
    int cx = (int)std::floor((x - ox_) / cell_), cz = (int)std::floor((z - oz_) / cell_);
    if (cx < 0 || cz < 0 || cx >= gw_ || cz >= gh_) return 0.f;
    return solid_[(size_t)cz * gw_ + cx];
}

void CityVehicles::wake(uint32_t i) {
    Vehicle& v = all_[i];
    if (!v.custom) { v.custom = true; custom_.push_back(i); }
    v.still = 0;
    v.awake = 0;
    if (v.active) return;
    v.active = true;
    restampSolid(v.sx0, v.sz0, v.sx1, v.sz1, i);   // no longer part of the static world it collides with
    markDirty(v.sz0, v.sz1);
}

void CityVehicles::sleep(uint32_t i) {
    Vehicle& v = all_[i];
    if (!v.active) return;
    v.active = false;
    for (float& c : v.v) c = 0;
    for (float& c : v.w) c = 0;
    updateRenderOrigin(v);
    if (v.inWindow && v.sx1 >= v.sx0) { stamp(v, solid_, nullptr, 0.25f); stamp(v, obst_, nullptr, 0.f); }
    markDirty(v.sz0, v.sz1);
}

void CityVehicles::blast(uint32_t i, float cx, float cy, float cz, float scale) {
    Vehicle& v = all_[i];
    const VehicleModel& M = models_[v.variant];
    if (!M.dynamic) return;
    const float R = kBlastRadius * std::sqrt(scale);
    F3 c{cx, cy, cz}, p = ld(v.p);
    if (std::fabs(c.x - p.x) > R + 10.f || std::fabs(c.z - p.z) > R + 10.f) return;
    // nearest point of the box to the blast
    float cm[3];
    com(v, cm);
    F3 l = rotInv(v.q, c - p);
    F3 cl{std::clamp(l.x, M.bmin[0] - cm[0], M.bmax[0] - cm[0]), std::clamp(l.y, M.bmin[1] - cm[1], M.bmax[1] - cm[1]),
          std::clamp(l.z, M.bmin[2] - cm[2], M.bmax[2] - cm[2])};
    F3 r = rot(v.q, cl), closest = p + r;
    F3 d = closest - c;
    float dist = len3(d);
    if (dist >= R) return;
    float f = 1.f - dist / R;
    ++stats_.blastsTaken;
    // damage (wrecks take impulses only)
    if (v.state != VehState::Wrecked) {
        // full damage (a sure ignition) within kBlastCore of the box, steep falloff beyond: a bumper-to-bumper
        // neighbour goes up, the car across the lane usually only gets damaged
        const float core = kBlastCore * std::sqrt(scale);
        const float g = std::clamp(1.f - (dist - core) / std::max(R - core, 0.1f), 0.f, 1.f);
        v.health -= kBlastDamage * std::pow(g, 2.5f) * std::min(scale, 2.f) * (0.9f + 0.2f * rand01());
        if (v.health <= kDamagedAt && v.state == VehState::Intact) {
            v.state = VehState::Damaged;
            setVariant(v, (uint16_t)M.damaged);
        }
        if (v.drained) v.health = std::max(v.health, 1.f);   // GAME_DESIGN 14e: no fuel, no fire (dented, stays put)
        if (v.health <= 0.f && v.state != VehState::Burning) {
            v.state = VehState::Burning;
            v.fuse = 0.5f + 2.5f * rand01();
        }
    }
    // impulse at the nearest point (lever shortened: whole-body push, moderate tumble) + random spin
    F3 dir = dist > 1e-3f ? d * (1.f / dist) : F3{0, 1, 0};
    dir.y = std::fabs(dir.y) + 0.8f;
    dir = dir * (1.f / len3(dir));
    const VehicleModel& Mn = models_[v.variant];
    const float mass = Mn.mass;
    F3 P = dir * (kBlastSpeed * f * std::min(scale, 1.8f) * mass / std::pow(mass, 0.8f));
    F3 lin = ld(v.v) + P * (1.f / mass);
    float ll = len3(lin);
    if (ll > 14.f) lin = lin * (14.f / ll);   // several blasts at once do not launch it into orbit
    // inverse inertia (box, about the centre of mass) in the body frame
    float L = Mn.bmax[0] - Mn.bmin[0], H = Mn.bmax[1] - Mn.bmin[1], Wd = Mn.bmax[2] - Mn.bmin[2];
    F3 invI{12.f / (mass * (H * H + Wd * Wd)), 12.f / (mass * (L * L + Wd * Wd)), 12.f / (mass * (L * L + H * H))};
    F3 tq = rotInv(v.q, cross3(r * 0.35f, P));
    F3 dw = rot(v.q, {tq.x * invI.x, tq.y * invI.y, tq.z * invI.z});
    F3 rnd{rand01() - 0.5f, rand01() - 0.5f, rand01() - 0.5f};
    F3 ang = ld(v.w) + dw + rnd * (3.f * f / std::sqrt(mass));
    float wl = len3(ang);
    if (wl > 8.f) ang = ang * (8.f / wl);
    st(v.v, lin);
    st(v.w, ang);
    wake(i);
}

void CityVehicles::explode(uint32_t i, CrowdSim& sim, const std::function<void(float, float, float, float)>& onBlast) {
    Vehicle& v = all_[i];
    v.queued = false;
    const VehicleModel& M = models_[v.variant];
    const float scale = M.blastScale;
    v.state = VehState::Wrecked;
    v.health = -1000.f;
    v.burn = (scale > 2.f ? 40.f : 22.f) + 14.f * rand01();
    setVariant(v, (uint16_t)M.burnt);
    // charcoal paint (burnt meshes have their own colours; tinted vertices of other variants go dark)
    v.paint[0] = 0.025f; v.paint[1] = 0.022f; v.paint[2] = 0.02f; v.paint[3] = 1.f;
    if (!v.custom) { v.custom = true; custom_.push_back(i); }
    const float y = std::max(v.p[1], 0.4f);
    sim.requestExplosion(v.p[0], y, v.p[2], scale);   // logged: next frame it throws this wreck and its neighbours
    ++stats_.explosions;
    if (onBlast) onBlast(v.p[0], y, v.p[2], scale);
}

void CityVehicles::integrate(uint32_t i, float h) {
    Vehicle& v = all_[i];
    const VehicleModel& M = models_[v.variant];
    const float mass = M.mass, invM = 1.f / mass;
    float L = M.bmax[0] - M.bmin[0], H = M.bmax[1] - M.bmin[1], Wd = M.bmax[2] - M.bmin[2];
    F3 invI{12.f / (mass * (H * H + Wd * Wd)), 12.f / (mass * (L * L + Wd * Wd)), 12.f / (mass * (L * L + H * H))};
    auto Iinv = [&](F3 a) {
        F3 b = rotInv(v.q, a);
        return rot(v.q, {b.x * invI.x, b.y * invI.y, b.z * invI.z});
    };
    F3 p = ld(v.p), lv = ld(v.v), w = ld(v.w);
    lv.y -= kGravity * h;
    p = p + lv * h;
    {   // q += 0.5 (w, 0) q h
        const float* q = v.q;
        float dq[4] = {0.5f * h * (w.x * q[3] + w.y * q[2] - w.z * q[1]), 0.5f * h * (w.y * q[3] + w.z * q[0] - w.x * q[2]),
                       0.5f * h * (w.z * q[3] + w.x * q[1] - w.y * q[0]), 0.5f * h * (-w.x * q[0] - w.y * q[1] - w.z * q[2])};
        for (int k = 0; k < 4; ++k) v.q[k] += dq[k];
        qnorm(v.q);
    }
    // contacts of points on the box surface lattice (corners plus edge points every <= 1.5 m, inset 0.1 m sideways, so
    // that an edge cannot slide into a building corner between two box corners) against ground / roofs / sleeping
    // vehicles from above, walls sideways
    struct Contact { F3 r, n; float pen; bool ground; float jn; };
    Contact cs[64];
    int nc = 0;
    float cm[3];
    com(v, cm);
    float lift = 0.f;
    F3 push{0, 0, 0};
    const int nx = std::clamp((int)std::ceil(L / 1.5f) + 1, 2, 10), nz = std::clamp((int)std::ceil(Wd / 1.5f) + 1, 2, 3);
    for (int iy = 0; iy < 2; ++iy)
        for (int iz = 0; iz < nz; ++iz)
            for (int ix = 0; ix < nx; ++ix) {
                if (nc == 64) break;
                F3 l{M.bmin[0] + 0.1f + (L - 0.2f) * ix / (nx - 1) - cm[0], (iy ? M.bmax[1] : M.bmin[1]) - cm[1],
                     M.bmin[2] + 0.1f + (Wd - 0.2f) * iz / (nz - 1) - cm[2]};
                F3 r = rot(v.q, l), wp = p + r;
                float g = solidAt(wp.x, wp.z);
                if (wp.y >= g) continue;
                F3 vc = lv + cross3(w, r);
                float prevY = wp.y - vc.y * h;
                Contact c{r, {0, 1, 0}, g - wp.y, true, 0.f};
                if (!(prevY >= g - 0.3f || g - wp.y < 0.3f)) {   // came from the side: a wall
                    float e = cell_;
                    float gx = solidAt(wp.x + e, wp.z) - solidAt(wp.x - e, wp.z), gz = solidAt(wp.x, wp.z + e) - solidAt(wp.x, wp.z - e);
                    F3 n{-gx, 0, -gz};
                    if (len3(n) < 1e-3f) n = {-vc.x, 0, -vc.z};
                    float nl = len3(n);
                    n = nl > 1e-4f ? n * (1.f / nl) : F3{0, 1, 0};
                    c.n = n;
                    c.ground = false;
                    c.pen = 0.02f;
                    push = push + n * 0.02f;
                } else lift = std::max(lift, g - wp.y);
                cs[nc++] = c;
            }
    float pl = len3(push);
    if (pl > 0.05f) push = push * (0.05f / pl);
    v.contact = nc > 0;
    for (int it = 0; it < 4 && nc; ++it)
        for (int k = 0; k < nc; ++k) {
            Contact& c = cs[k];
            F3 vc = lv + cross3(w, c.r);
            float vn = dot3(vc, c.n);
            // normal: accumulated impulse clamped >= 0 (restitution only for hard hits, first iteration)
            float kN = invM + dot3(c.n, cross3(Iinv(cross3(c.r, c.n)), c.r));
            float e = (it == 0 && vn < -2.5f) ? 0.25f : 0.f;
            float dj = -(1.f + e) * vn / kN;
            float jn = std::max(0.f, c.jn + dj);
            dj = jn - c.jn;
            c.jn = jn;
            lv = lv + c.n * (dj * invM);
            w = w + Iinv(cross3(c.r, c.n * dj));
            // friction (Coulomb)
            vc = lv + cross3(w, c.r);
            F3 vt = vc - c.n * dot3(vc, c.n);
            float vtl = len3(vt);
            if (vtl > 1e-4f) {
                F3 t = vt * (1.f / vtl);
                float kT = invM + dot3(t, cross3(Iinv(cross3(c.r, t)), c.r));
                float jt = std::min(vtl / kT, 0.7f * c.jn);
                lv = lv - t * (jt * invM);
                w = w - Iinv(cross3(c.r, t * jt));
            }
        }
    p.y += lift;
    p = p + push;
    // air drag; rolling resistance while touching
    lv = lv * (1.f - 0.05f * h);
    w = w * std::exp(-(v.contact ? 1.5f : 0.3f) * h);
    st(v.p, p);
    st(v.v, lv);
    st(v.w, w);
    // NaN guard: back to where it was baked, asleep
    if (!finite3(v.p) || !finite3(v.v) || !finite3(v.w) || !std::isfinite(v.q[3])) {
        std::memcpy(v.q, v.bq, sizeof(v.q));
        float c[3];
        com(v, c);
        st(v.p, ld(v.bp) + rot(v.q, ld(c)));
        for (float& x : v.v) x = 0;
        for (float& x : v.w) x = 0;
    }
}

void CityVehicles::update(SDL_GPUCommandBuffer* cmd, float dt, CrowdSim& sim, const std::function<void(float, float, float, float)>& onBlast) {
    stats_.uploadedRows = 0;
    ++updateSerial_;
    stats_.uploadBytes = 0;
    stats_.substeps = 0;
    const double tick = 1000.0 / (double)SDL_GetPerformanceFrequency();
    uint64_t tA = SDL_GetPerformanceCounter();
    auto lap = [&](float& out) { uint64_t t = SDL_GetPerformanceCounter(); out = (float)((t - tA) * tick); tA = t; };
    if (!enabled || gw_ <= 0) { sim.takeExplosionLog(); runs_.clear(); return; }
    // 1. blasts accepted by the simulation since the last frame
    for (const CrowdSim::ExplosionEvent& e : sim.takeExplosionLog())
        for (uint32_t i : window_) blast(i, e.x, e.y, e.z, e.scale);
    lap(stats_.msBlast);
    // 2. fuses and fires
    for (uint32_t i : window_) {
        Vehicle& v = all_[i];
        if (v.state == VehState::Burning && !v.queued) {
            v.fuse -= dt;
            if (v.fuse <= 0.f) { v.queued = true; explodeQueue_.push_back(i); }
        } else if (v.state == VehState::Wrecked && v.burn > 0.f) v.burn = std::max(0.f, v.burn - dt);
    }
    int blasts = 0;
    while (!explodeQueue_.empty() && blasts < kMaxBlastsPerFrame && dt > 0.f) {
        uint32_t i = explodeQueue_.front();
        explodeQueue_.erase(explodeQueue_.begin());
        explode(i, sim, onBlast);
        ++blasts;
    }
    lap(stats_.msFuse);
    // 3. rigid bodies
    std::vector<uint32_t>& act = act_;
    act.clear();
    for (uint32_t i : window_)
        if (all_[i].active) act.push_back(i);
    for (uint32_t i : act) markDirty(all_[i].sz0, all_[i].sz1);   // where they were
    acc_ = std::min(acc_ + dt, 8 * kSub);
    while (acc_ >= kSub) {
        acc_ -= kSub;
        ++stats_.substeps;
        for (uint32_t i : act) {
            Vehicle& v = all_[i];
            if (!v.active) continue;
            integrate(i, kSub);
            v.awake += kSub;
            bool slow = dot3(ld(v.v), ld(v.v)) < 0.25f * 0.25f && dot3(ld(v.w), ld(v.w)) < 0.35f * 0.35f;
            v.still = (slow && v.contact) ? v.still + kSub : 0.f;
            if (v.still > 0.5f || v.awake > 20.f) {
                updateRenderOrigin(v);
                markDirty(v.sz0, v.sz1);
                computeRect(v);   // the resting pose's cells, then join the static world
                sleep(i);
            }
        }
    }
    for (uint32_t i : act) {
        Vehicle& v = all_[i];
        updateRenderOrigin(v);
        computeRect(v);
        markDirty(v.sz0, v.sz1);
    }
    lap(stats_.msIntegrate);
    // 4. flames / smoke of burning vehicles in the window (a few emitters per frame, round robin)
    if (dt > 0.f) {
        std::vector<uint32_t> burning;
        uint32_t wrecked = 0, active = 0;
        for (uint32_t i : window_) {
            const Vehicle& v = all_[i];
            if (v.state == VehState::Burning || (v.state == VehState::Wrecked && v.burn > 0.f)) burning.push_back(i);
            wrecked += v.state == VehState::Wrecked;
            active += v.active;
        }
        stats_.burning = (uint32_t)burning.size();
        stats_.wrecked = wrecked;
        stats_.active = active;
        for (int k = 0; k < std::min<int>(3, (int)burning.size()); ++k) {
            const Vehicle& v = all_[burning[(fireCursor_++) % burning.size()]];
            const VehicleModel& M = models_[v.variant];
            F3 top = ld(v.p) + F3{0, 0.5f * (M.bmax[1] - M.bmin[1]), 0};
            sim.requestFire(top.x, top.y, top.z, 0.6f * (M.bmax[0] - M.bmin[0]) * (v.state == VehState::Burning ? 0.6f : 1.f));
        }
    }
    stats_.inWindow = (uint32_t)window_.size();
    stats_.custom = (uint32_t)custom_.size();
    // 5. obstacle grid, dirty rows only: obst_ (base + sleeping vehicles) + every active vehicle near the ground (whole
    // box); the rows that differ from what the simulation has go up in one copy pass
    runs_.clear();
    for (int z0 = 0; z0 < gh_;) {
        if (!rowDirty_[(size_t)z0]) { ++z0; continue; }
        int z1 = z0;
        while (z1 + 1 < gh_ && rowDirty_[(size_t)z1 + 1]) ++z1;
        std::memcpy(&simH_[(size_t)z0 * gw_], &obst_[(size_t)z0 * gw_], (size_t)(z1 - z0 + 1) * gw_ * 4);
        const int rows[2] = {z0, z1};
        for (uint32_t i : act) {
            const Vehicle& v = all_[i];
            if (!v.active || v.sx1 < v.sx0 || v.sz1 < z0 || v.sz0 > z1) continue;
            float c[8][3], lo = 1e30f;   // flying high: zombies walk under it
            worldCorners(v, c);
            for (auto& k : c) lo = std::min(lo, k[1] - groundAt(k[0], k[2]));
            if (lo > kLowStamp) continue;
            stamp(v, simH_, rows, 0.f);
        }
        for (int z = z0; z <= z1; ++z) {   // changed rows -> runs
            rowDirty_[(size_t)z] = 0;
            float* a = &simH_[(size_t)z * gw_];
            float* u = &uploaded_[(size_t)z * gw_];
            if (std::memcmp(a, u, (size_t)gw_ * 4) == 0) continue;
            std::memcpy(u, a, (size_t)gw_ * 4);
            if (!runs_.empty() && runs_.back().first + runs_.back().second == (uint32_t)z) ++runs_.back().second;
            else runs_.push_back({(uint32_t)z, 1u});
        }
        z0 = z1 + 1;
    }
    for (auto& r : runs_) stats_.uploadedRows += r.second;
    if (!runs_.empty() && cmd) stats_.uploadBytes = sim.uploadStaticRowRuns(cmd, runs_, simH_.data());
    lap(stats_.msGrid);
}

void CityVehicles::fireLights(float x, float z, double time, int maxCount, std::vector<PointLight>& out) const {
    std::vector<std::pair<float, uint32_t>> c;
    for (uint32_t i : window_) {
        const Vehicle& v = all_[i];
        if (!(v.state == VehState::Burning || (v.state == VehState::Wrecked && v.burn > 0.f))) continue;
        float dx = v.p[0] - x, dz = v.p[2] - z;
        c.push_back({dx * dx + dz * dz, i});
    }
    size_t n = std::min<size_t>(c.size(), (size_t)std::max(0, maxCount));
    std::partial_sort(c.begin(), c.begin() + n, c.end());
    for (size_t k = 0; k < n; ++k) {
        const Vehicle& v = all_[c[k].second];
        float t = (float)time, ph = (float)(c[k].second % 97);
        float flicker = 0.75f + 0.15f * std::sin(t * 17.f + ph) + 0.1f * std::sin(t * 31.f + 2.f * ph);
        float fade = v.state == VehState::Burning ? 0.8f : std::min(1.f, v.burn / 6.f);
        out.push_back(PointLight{v.p[0], v.p[1] + 1.5f, v.p[2], 14.f, 1.0f, 0.45f, 0.12f, 3.0f * flicker * fade});
    }
}

void CityVehicles::fireVolumes(float x, float z, int maxCount, std::vector<FireVolume>& out) const {
    std::vector<std::pair<float, uint32_t>> c;
    for (uint32_t i : window_) {
        const Vehicle& v = all_[i];
        if (!(v.state == VehState::Burning || (v.state == VehState::Wrecked && v.burn > 0.f))) continue;
        float dx = v.p[0] - x, dz = v.p[2] - z;
        c.push_back({dx * dx + dz * dz, i});
    }
    size_t n = std::min<size_t>(c.size(), (size_t)std::max(0, maxCount));
    std::partial_sort(c.begin(), c.begin() + n, c.end());
    for (size_t k = 0; k < n; ++k) {
        const Vehicle& v = all_[c[k].second];
        const VehicleModel& M = models_[v.variant];
        float strength = v.state == VehState::Burning ? 0.7f : std::min(1.f, v.burn / 8.f);
        out.push_back(FireVolume{v.p[0], v.p[1] + 0.25f * (M.bmax[1] - M.bmin[1]), v.p[2], M.bmax[0] - M.bmin[0], strength, c[k].second});
    }
}

} // namespace ttz
