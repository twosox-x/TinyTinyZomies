#include "lab/MilitaryLab.h"

#include "app/App.h"
#include "imgui.h"
#include "sim/Look.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr uint32_t kMaxChars = MilitaryRenderer::kMaxChars, kMaxFx = MilitaryRenderer::kMaxFx, kMaxFlashLights = MilitaryRenderer::kMaxFlashLights;
constexpr float kPi = 3.14159265f;
using Inst = CityRenderer::GpuInstance;

void qrotv(const float q[4], const float v[3], float out[3]) {
    float tx = 2.f * (q[1] * v[2] - q[2] * v[1]), ty = 2.f * (q[2] * v[0] - q[0] * v[2]), tz = 2.f * (q[0] * v[1] - q[1] * v[0]);
    float r[3] = {v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)};
    std::memcpy(out, r, sizeof(r));
}
void yawQuat(float yaw, float q[4]) { q[0] = 0; q[1] = std::sin(0.5f * yaw); q[2] = 0; q[3] = std::cos(0.5f * yaw); }
float length(V3 a) { return std::sqrt(dot(a, a)); }
float hashf(uint32_t x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return (x & 0xFFFFFF) / 16777216.f; }
LookSpec lineupLook(int i) { return i == 0 ? labOfficeDrone() : i == 1 ? labStreetWalker() : labRotter(); }
// layout (lab-local metres; +Z faces the default camera): turntable at the origin, lineup row behind it, props rows
// behind the lineup, parachute drops to the right
constexpr float kLineupZ = -4.f, kPropsZ = -9.5f, kChuteX = 10.f;
constexpr float kClearX0 = -13.f, kClearX1 = 15.f, kClearZ0 = -16.f, kClearZ1 = 3.f, kPropsRow = 24.f, kPropsRowGap = 4.5f;
double msNowLab() { return (double)SDL_GetPerformanceCounter() * 1000.0 / (double)SDL_GetPerformanceFrequency(); }
} // namespace

V3 MilitaryLab::world(float lx, float lz, float y) const {
    float c = std::cos(frameYaw_), s = std::sin(frameYaw_);
    return {ox_ + lx * c + lz * s, oy_ + y, oz_ - lx * s + lz * c};
}

static float rasterHeight(const AppState& s, float x, float z) {
    const Sandbox& sb = s.sandbox;
    int i = (int)std::floor((x - sb.originX) / sb.cellSize), j = (int)std::floor((z - sb.originZ) / sb.cellSize);
    if (i < 0 || j < 0 || i >= sb.gridW || j >= sb.gridH) return 99.f;
    return s.staticHeights[(size_t)j * sb.gridW + i];
}

// A street patch for the diorama: the clear rectangle of the lab layout nearest to the simulation window centre, in
// any of the four orientations, from the window's static height raster.
void MilitaryLab::findSpot(AppState& s) {
    const Sandbox& sb = s.sandbox;
    float cx = sb.originX + 0.5f * sb.gridW * sb.cellSize, cz = sb.originZ + 0.5f * sb.gridH * sb.cellSize;
    ox_ = cx; oz_ = cz; frameYaw_ = 0;
    float best = 1e30f;
    const float step = 1.5f, R = 140.f;
    for (float dz = -R; dz <= R; dz += step)
        for (float dx = -R; dx <= R; dx += step) {
            float d2 = dx * dx + dz * dz;
            if (d2 >= best || d2 > R * R) continue;
            for (int o = 0; o < 4; ++o) {
                float yaw = o * 0.5f * kPi, c = std::cos(yaw), sn = std::sin(yaw);
                bool ok = true;
                for (float lz = kClearZ0; lz <= kClearZ1 && ok; lz += 0.7f)
                    for (float lx = kClearX0; lx <= kClearX1 && ok; lx += 0.7f)
                        if (rasterHeight(s, cx + dx + lx * c + lz * sn, cz + dz - lx * sn + lz * c) > 0.3f) ok = false;
                if (ok) { best = d2; ox_ = cx + dx; oz_ = cz + dz; frameYaw_ = yaw; spotFound_ = true; break; }
            }
        }
    oy_ = 0.f;
    SDL_Log("military lab: diorama spot (%.1f, %.1f) heading %.0f deg%s", ox_, oz_, frameYaw_ * 180.f / kPi,
            spotFound_ ? "" : " (no clear street patch found: window centre)");
}

// A real flat city rooftop near the diorama (rooftop parachute landing): a cell whose 9 x 9 neighbourhood (6.75 m)
// (5.25 m) is flat within 0.35 m, 6..25 m high, nearest to the lab origin.
void MilitaryLab::findRoof(AppState& s) {
    const Sandbox& sb = s.sandbox;
    const std::vector<float>& h = s.staticHeights;
    float best = 1e30f;
    int ci = (int)((ox_ - sb.originX) / sb.cellSize), cj = (int)((oz_ - sb.originZ) / sb.cellSize);
    for (int j = 5; j < sb.gridH - 5; j += 2)
        for (int i = 5; i < sb.gridW - 5; i += 2) {
            float v = h[(size_t)j * sb.gridW + i];
            if (v < 6.f || v > 25.f) continue;
            float d2 = (float)((i - ci) * (i - ci) + (j - cj) * (j - cj));
            if (d2 >= best || d2 > 160.f * 160.f) continue;
            bool flat = true;
            for (int b = -3; b <= 3 && flat; ++b)
                for (int a = -3; a <= 3 && flat; ++a) flat = std::fabs(h[(size_t)(j + b) * sb.gridW + i + a] - v) < 0.35f;
            if (flat) { best = d2; roof_ = {sb.originX + (i + 0.5f) * sb.cellSize, v, sb.originZ + (j + 0.5f) * sb.cellSize}; roofFound_ = true; }
        }
    if (!roofFound_) {
        float mx = 0;
        for (float v : h) mx = std::max(mx, v);
        SDL_Log("military lab: static heights max %.1f m", mx);
    }
    SDL_Log("military lab: rooftop landing %s (%.1f, %.1f, %.1f)", roofFound_ ? "at" : "not found, none", roof_.x, roof_.y, roof_.z);
}

bool MilitaryLab::init(AppState& s) {
    app_ = &s;
    gpu_ = &s.gpu;
    city_ = &s.cityRenderer;
    bodyVoxel_ = s.chars.metresPerVoxel();
    if (!mil_.init(s.gpu, s.cityRenderer, s.chars, s.sim, bodyVoxel_)) return false;
    mil_.groundHeight = [&s](float x, float z) { return rasterHeight(s, x, z); };
    findSpot(s);
    findRoof(s);
    // the lab's moon-shadow field: the window's field plus lab props and soldiers (rebuildShadows)
    shadowBuf_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(9u * s.params.gridW * s.params.gridH * 4u), "milShadow");
    mil_.installHooks(s.renderer, false);   // lights: App calls injectLights (before the vehicle fire lights are set)
    s.debugCam = true;   // free orbit camera (F2 toggles the RTS rig)
    s.camera.settings.minDistance = 1.0f;
    s.camera.settings.maxDistance = 600.f;
    s.camera.settings.minPitch = -0.2f;
    s.camera.settings.maxPitch = 89.f * kPi / 180.f;
    // lineup: every infantry variant, idle (or the zombie idle clip for placeholders)
    float x = -11.f + 3 * 1.3f + 0.4f;
    for (size_t i = 0; i < lib_.infantry.size(); ++i, x += 1.3f) {
        Soldier so;
        so.infantry = (int)i;
        so.pos = world(x, kLineupZ);
        so.yaw = worldYaw(0);
        so.clip = std::max(0, clipByAction(lib_.infantry[i], "idle"));
        so.t = 0.37f * i;
        lineup_.push_back(so);
    }
    if (!lib_.infantry.empty()) clip_ = std::max(0, clipByAction(lib_.infantry[0], "idle"));
    // parachute drops: soldier on the street, soldier on a real rooftop, cargo crate
    auto addDrop = [&](bool cargo, int inf, V3 at, float yaw) {
        Drop d;
        d.cargo = cargo; d.inf = inf; d.xz = at; d.yaw = yaw; d.startH = 35.f;
        drops_.push_back(d);
    };
    if (!lib_.infantry.empty()) {
        addDrop(false, 0, world(kChuteX, 0.f), worldYaw(0.4f));
        if (roofFound_) addDrop(false, std::min<int>(5, (int)lib_.infantry.size() - 1), roof_, worldYaw(-0.6f));
    }
    addDrop(true, 0, world(kChuteX + 2.f, -7.f), worldYaw(0.2f));
    if (!s.opt.labStress.empty() && !s.opt.headless) setupStress(s, s.opt.labStress[0]);
    setupScene(s);
    applyView(s, "closeup");
    lastCounter_ = SDL_GetPerformanceCounter();
    return true;
}

void MilitaryLab::shutdown() {
    if (!gpu_) return;
    if (app_) mil_.removeHooks(app_->renderer);
    mil_.shutdown();
    gpu_->releaseBuffer(shadowBuf_);
    gpu_ = nullptr;
}

void MilitaryLab::setupScene(AppState& s) {
    SDL_WaitForGPUIdle(s.gpu.device());
    s.sim.reset(s.sandbox);
    s.sim.setGoals({});
    if (showLineup_ && lineupZombies_)
        for (int i = 0; i < 3; ++i) {
            uint32_t x, y;
            encodeLook(lineupLook(i), x, y);
            V3 p = world(-11.f + i * 1.3f, kLineupZ);
            s.sim.requestSpawnLook({p.x - 0.001f, p.z - 0.001f, p.x + 0.001f, p.z + 0.001f}, 1, x, y);
        }
    if (stressN_ > 0 && s.opt.labZombies > 0) {   // the horde stands around the stress area (no goal)
        V3 c = world(0.f, -4.f);
        s.sim.requestSpawn({c.x - 70.f, c.z - 70.f, c.x + 70.f, c.z + 70.f}, (uint32_t)s.opt.labZombies);
    }
    s.simAccumulator = 0;
    shadowsDirty_ = true;
}

// Stress test: n scripted soldiers on the street cells around the diorama (1.6 m grid, nearest first), mixed classes.
void MilitaryLab::setupStress(AppState& s, int n) {
    stress_.clear();
    stressN_ = std::clamp(n, 0, (int)kMaxChars - 64);
    if (stressN_ > 0 && !lib_.infantry.empty()) {
        V3 c = world(0.f, -4.f);
        std::vector<std::pair<float, V3>> cand;
        const float sp = 1.6f;
        for (int j = -60; j <= 60; ++j)
            for (int i = -60; i <= 60; ++i) {
                V3 p{c.x + i * sp, 0.f, c.z + j * sp};
                if (rasterHeight(s, p.x, p.z) > 0.3f) continue;
                cand.push_back({(float)(i * i + j * j), p});
            }
        std::sort(cand.begin(), cand.end(), [](auto& a, auto& b) { return a.first < b.first; });
        for (int k = 0; k < stressN_ && k < (int)cand.size(); ++k) {
            Soldier so;
            so.infantry = k % (int)lib_.infantry.size();
            so.pos = cand[(size_t)k].second;
            so.yaw = hashf((uint32_t)k * 7u + 1u) * 2.f * kPi;
            so.script = (int)(hashf((uint32_t)k * 13u + 5u) * 6.f);
            so.stateLeft = hashf((uint32_t)k * 31u) * 4.f;
            so.t = hashf((uint32_t)k * 17u) * 3.f;
            so.clip = std::max(0, clipByAction(lib_.infantry[(size_t)so.infantry], "idle"));
            so.home = so.pos;
            so.mover = k % 3 == 0;   // a third walk / run along the street (turning back at obstacles / 14 m from home)
            stress_.push_back(so);
        }
    }
    SDL_Log("military lab: stress preset %d soldiers (%zu placed on street cells), %d zombies", n, stress_.size(), stressN_ > 0 ? s.opt.labZombies : 0);
    setupScene(s);
}

void MilitaryLab::select(AppState& s, int kind, int index) {
    selKind_ = kind;
    selIndex_ = index;
    animTime_ = 0.f;
    if (kind == 0 && index < (int)lib_.infantry.size()) clip_ = std::clamp(clip_, 0, (int)lib_.infantry[(size_t)index].clips.size() - 1);
    shadowsDirty_ = true;
    applyView(s, lastView_ == "lineup" || lastView_.rfind("rts", 0) == 0 || lastView_ == "props" ? "closeup" : lastView_);
}

// Camera presets. Character / prop front = lab +Z; the camera yaw is the direction from the target to the eye.
bool MilitaryLab::applyView(AppState& s, const std::string& v) {
    const float deg = kPi / 180.f;
    float baseYaw = frameYaw_ + (turntable_ ? turnAngle_ : 0.f);
    float size = 1.8f;
    if (selKind_ == 1 && selIndex_ < (int)lib_.props.size()) {
        const MilProp& p = lib_.props[(size_t)selIndex_];
        int m = p.parts.empty() ? p.model : p.parts[0].first;
        if (m >= 0) { const auto& b = mil_.meshBounds()[(size_t)m]; size = std::max({b[3] - b[0], b[4] - b[1], b[5] - b[2], 1.f}); }
    }
    V3 centre = world(0, 0, selKind_ == 0 ? 0.9f : 0.4f * size);
    float closeD = std::max(3.2f, size * 2.2f);
    V3 dropAt = drops_.empty() ? world(kChuteX, 0) : drops_[0].xz;
    float dropAlt = drops_.empty() || drops_[0].phase ? 0.f : drops_[0].alt;
    const Drop* roofDrop = nullptr;
    for (const Drop& d : drops_) if (!d.cargo && d.xz.y > 1.f) roofDrop = &d;
    float roofAlt = roofDrop && roofDrop->phase == 0 ? roofDrop->alt : 0.f;
    if (v == "closeup") s.camera.setImmediate(centre, baseYaw + 0.55f, 14.f * deg, closeD);
    else if (v == "front") s.camera.setImmediate(centre, baseYaw, 6.f * deg, closeD);
    else if (v == "rear") s.camera.setImmediate(centre, baseYaw + kPi, 6.f * deg, closeD);
    else if (v == "side") s.camera.setImmediate(centre, baseYaw - 0.5f * kPi, 6.f * deg, closeD);
    else if (v == "top") s.camera.setImmediate(centre, baseYaw, 88.f * deg, closeD * 1.2f);
    else if (v == "muzzle") s.camera.setImmediate(world(0, 0, 1.1f), baseYaw + 1.1f, 8.f * deg, 2.2f);
    else if (v == "lineup") s.camera.setImmediate(world(-2.f, kLineupZ, 0.9f), frameYaw_ + 0.25f, 12.f * deg, 15.f);
    else if (v == "rts110") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 110.f);
    else if (v == "rts300") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 300.f);
    else if (v == "rts45") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 45.f);
    else if (v == "props") s.camera.setImmediate(world(0.f, kPropsZ - 0.5f * kPropsRowGap, 0.8f), frameYaw_ + kPi - 0.25f, 24.f * deg, 24.f);
    else if (v == "parachute") s.camera.setImmediate({dropAt.x, dropAt.y + dropAlt + 4.f, dropAt.z}, frameYaw_ - 0.5f, 8.f * deg, 22.f);
    else if (v == "landing") s.camera.setImmediate({dropAt.x, dropAt.y + 1.2f, dropAt.z}, frameYaw_ + 2.3f, 18.f * deg, 9.f);
    else if (v == "cratedrop") {   // the cargo drop after landing (canopy hold / dissolve)
        for (const Drop& d : drops_) if (d.cargo) s.camera.setImmediate({d.xz.x, d.xz.y + 0.8f, d.xz.z}, frameYaw_ + 2.0f, 24.f * deg, 9.f);
    }
    else if (v == "roofland" && roofDrop) s.camera.setImmediate({roofDrop->xz.x, roofDrop->xz.y + 1.f, roofDrop->xz.z}, frameYaw_ + 0.8f, 30.f * deg, 12.f);
    else if (v == "roof" && roofFound_) s.camera.setImmediate({roof_.x, roof_.y + roofAlt + 1.5f, roof_.z}, frameYaw_ + 0.8f, 28.f * deg, 14.f);
    else if (v == "roofhigh" && roofFound_) s.camera.setImmediate({roof_.x, roof_.y + roofAlt + 4.f, roof_.z}, frameYaw_ + 0.8f, 16.f * deg, 30.f);
    else return false;
    lastView_ = v;
    return true;
}

// ---------------------------------------------------------------------------------------------------------------
// soldiers

void MilitaryLab::triggerFx(const std::string& type) {   // FX buttons: the selected (turntable) soldier
    if (selKind_ != 0 || selIndex_ >= (int)lib_.infantry.size()) return;
    MilPoseInput so;
    so.infantry = selIndex_; so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f); so.clip = clip_; so.t = animTime_;
    const std::string kind = lib_.infantry[(size_t)selIndex_].weaponKind;
    if (type == "shot") mil_.fxShot(so);
    else mil_.fxEvent(so, {0, type, kind});
}

// ---------------------------------------------------------------------------------------------------------------
// Landing spots: street drops on a clear patch (height raster) away from parked / wrecked vehicles (their footprints
// from CityVehicles) and the lab rows; the rooftop drop's clamp gets the roof footprint (flood fill of the flat roof),
// street height outside, so a canopy toppling over the edge drapes down the facade.
void MilitaryLab::placeDrops(AppState& s) {
    dropsPlaced_ = true;
    std::vector<std::array<float, 4>> cars;   // xz AABB of every vehicle near the lab
    float cr[8][3];
    for (const Vehicle& v : s.vehicles.vehicles()) {
        if (std::fabs(v.p[0] - ox_) > 80.f || std::fabs(v.p[2] - oz_) > 80.f) continue;
        s.vehicles.worldCorners(v, cr);
        std::array<float, 4> b{1e9f, 1e9f, -1e9f, -1e9f};
        for (auto& c : cr) { b[0] = std::min(b[0], c[0]); b[1] = std::min(b[1], c[2]); b[2] = std::max(b[2], c[0]); b[3] = std::max(b[3], c[2]); }
        cars.push_back(b);
    }
    auto clear = [&](V3 p, float r) {
        for (float dz = -r; dz <= r; dz += 0.7f)
            for (float dx = -r; dx <= r; dx += 0.7f)
                if (dx * dx + dz * dz <= r * r && rasterHeight(s, p.x + dx, p.z + dz) > 0.3f) return false;
        for (auto& b : cars) if (p.x + r > b[0] && p.x - r < b[2] && p.z + r > b[1] && p.z - r < b[3]) return false;
        // not on the lab rows (lineup, props) or the turntable
        float c = std::cos(frameYaw_), sn = std::sin(frameYaw_), lx = (p.x - ox_) * c - (p.z - oz_) * sn, lz = (p.x - ox_) * sn + (p.z - oz_) * c;
        if (lx < 9.f + r && lz < 3.f + r && lz > -18.f - r && lx > -14.f - r) return false;
        return true;
    };
    std::vector<V3> taken;
    auto find = [&](V3 near, float r0) {
        V3 best = near;
        float bd = 1e30f;
        for (float r : {r0, r0 * 0.75f, r0 * 0.5f}) {   // relax the clearance radius if nothing fits
        if (bd < 1e29f) break;
        for (float dz = -40.f; dz <= 40.f; dz += 1.f)
            for (float dx = -40.f; dx <= 40.f; dx += 1.f) {
                float d2 = dx * dx + dz * dz;
                if (d2 >= bd) continue;
                V3 p{near.x + dx, 0.f, near.z + dz};
                bool far = true;
                for (const V3& t : taken) if (length(p - t) < 9.f) far = false;
                if (far && clear(p, r)) { bd = d2; best = p; }
            }
        }
        SDL_Log("military lab: drop spot (%.1f, %.1f) %s", best.x, best.z, bd < 1e29f ? "clear of vehicles / props" : "NOT clear (fallback)");
        taken.push_back(best);
        return best;
    };
    for (Drop& d : drops_) {
        if (d.xz.y > 1.f) {   // rooftop: flood-fill the flat roof for the clamp footprint
            const Sandbox& sb = s.sandbox;
            int i0 = (int)((d.xz.x - sb.originX) / sb.cellSize), j0 = (int)((d.xz.z - sb.originZ) / sb.cellSize);
            int x0 = i0, x1 = i0, z0 = j0, z1 = j0;
            std::vector<uint8_t> seen((size_t)sb.gridW * sb.gridH, 0);
            std::vector<std::pair<int, int>> st{{i0, j0}};
            while (!st.empty()) {
                auto [i, j] = st.back();
                st.pop_back();
                if (i < 0 || j < 0 || i >= sb.gridW || j >= sb.gridH || std::abs(i - i0) > 80 || std::abs(j - j0) > 80) continue;
                size_t id = (size_t)j * sb.gridW + i;
                if (seen[id] || std::fabs(s.staticHeights[id] - d.xz.y) > 0.6f) continue;
                seen[id] = 1;
                x0 = std::min(x0, i); x1 = std::max(x1, i); z0 = std::min(z0, j); z1 = std::max(z1, j);
                st.push_back({i + 1, j}); st.push_back({i - 1, j}); st.push_back({i, j + 1}); st.push_back({i, j - 1});
            }
            float r[8] = {sb.originX + x0 * sb.cellSize, sb.originZ + z0 * sb.cellSize, sb.originX + (x1 + 1) * sb.cellSize,
                          sb.originZ + (z1 + 1) * sb.cellSize, d.xz.y, 0.f, 0.f, 1.f};
            std::memcpy(d.clamp, r, sizeof(r));
            SDL_Log("military lab: rooftop drop clamp footprint %.1f x %.1f m at %.1f m", r[2] - r[0], r[3] - r[1], d.xz.y);
            continue;
        }
        d.xz = find(d.xz, d.cargo ? 3.5f : 5.f);
    }
    SDL_Log("military lab: drop spots placed (%zu vehicles near the lab avoided)", cars.size());
}

// parachute drops (docs/MILITARY_ANIMS.md 2.3): descent (descentSpeed) -> touchdown -> land -> recover -> settled
void MilitaryLab::updateDrops(AppState& s, float dt) {
    for (Drop& d : drops_) mil_.advanceDrop(d, dt);
    (void)s;
}

// Lab props and soldiers in the moon-shadow height field: each as a box occluder (exact for boxes, as the city's),
// added to the simulation window's field and uploaded to the lab's own buffer.
void MilitaryLab::rebuildShadows(AppState& s) {
    shadowsDirty_ = false;
    const std::vector<float>* base = s.simWindow.shadowCpu();
    const int W = 3 * s.params.gridW, H = 3 * s.params.gridH;
    if (!base || (int)base->size() != W * H) return;
    std::vector<float> f = *base;
    if (labShadows_) {
        const float cs = s.sandbox.cellSize / 3.f, x0 = s.sandbox.originX, z0 = s.sandbox.originZ;
        V3 d = normalize(V3{-0.35f, 0.8f, 0.45f});   // towards the moon (Renderer)
        auto box = [&](float bx0, float bz0, float bx1, float bz1, float y0, float top) {
            float len = (top - y0) / d.y;
            float ex0 = std::min(bx0, bx0 - d.x * len), ex1 = std::max(bx1, bx1 - d.x * len), ez0 = std::min(bz0, bz0 - d.z * len), ez1 = std::max(bz1, bz1 - d.z * len);
            int i0 = std::max(0, (int)((ex0 - x0) / cs) - 1), i1 = std::min(W - 1, (int)((ex1 - x0) / cs) + 1);
            int j0 = std::max(0, (int)((ez0 - z0) / cs) - 1), j1 = std::min(H - 1, (int)((ez1 - z0) / cs) + 1);
            for (int j = j0; j <= j1; ++j)
                for (int i = i0; i <= i1; ++i) {
                    float px = x0 + (i + 0.5f) * cs, pz = z0 + (j + 0.5f) * cs;
                    float sIn = 0.f, sOut = 1e9f;   // slab entry / exit of the horizontal ray towards the moon
                    auto slab = [&](float p, float dd, float a, float b) {
                        if (std::fabs(dd) < 1e-6f) { if (p < a || p > b) sOut = -1.f; return; }
                        float t0 = (a - p) / dd, t1 = (b - p) / dd;
                        if (t0 > t1) std::swap(t0, t1);
                        sIn = std::max(sIn, t0); sOut = std::min(sOut, t1);
                    };
                    slab(px, d.x, bx0, bx1);
                    slab(pz, d.z, bz0, bz1);
                    if (sOut < sIn) continue;
                    float h = top - d.y * sIn;
                    float& v = f[(size_t)j * W + i];
                    if (h > y0 && h > v) v = h;
                }
        };
        const auto& buckets = mil_.cpuBuckets();
        for (size_t m = 0; m < buckets.size(); ++m) {
            if (buckets[m].empty()) continue;
            const auto& b = mil_.meshBounds()[m];
            if (b[4] - b[1] < 0.15f || b[3] - b[0] > 30.f) continue;   // flat helpers (grid), huge
            for (const Inst& gi : buckets[m]) {
                if (gi.pos[3] > 1.5f) continue;   // canopies move
                float cx[4] = {b[0], b[3], b[3], b[0]}, cz[4] = {b[2], b[2], b[5], b[5]};
                float mnx = 1e9f, mxx = -1e9f, mnz = 1e9f, mxz = -1e9f;
                for (int k = 0; k < 4; ++k) {
                    float v[3] = {cx[k], 0.f, cz[k]}, r[3];
                    qrotv(gi.quat, v, r);
                    mnx = std::min(mnx, r[0]); mxx = std::max(mxx, r[0]); mnz = std::min(mnz, r[2]); mxz = std::max(mxz, r[2]);
                }
                box(gi.pos[0] + mnx, gi.pos[2] + mnz, gi.pos[0] + mxx, gi.pos[2] + mxz, gi.pos[1] + b[1], gi.pos[1] + b[4]);
            }
        }
        auto soldierBox = [&](const Soldier& so) { box(so.pos.x - 0.22f, so.pos.z - 0.18f, so.pos.x + 0.22f, so.pos.z + 0.18f, so.pos.y, so.pos.y + 1.72f); };
        if (showLineup_) for (const Soldier& so : lineup_) soldierBox(so);
        for (const Soldier& so : stress_) if (!so.mover) soldierBox(so);
        if (selKind_ == 0) { Soldier so; so.pos = world(0, 0); soldierBox(so); }
    }
    gpu_->uploadNow(shadowBuf_, f.data(), (uint32_t)(f.size() * 4));
    s.renderer.setSimWindow(s.sandbox.originX, s.sandbox.originZ, shadowBuf_);
}

void MilitaryLab::benchStep(AppState& s) {
    const std::vector<int>& presets = s.opt.labStress;
    const int warm = 45, frames = std::max(10, s.opt.labBenchFrames);
    if (benchPreset_ < 0 || benchFrame_ >= warm + frames) {
        if (benchPreset_ >= 0) {   // finish the preset
            auto pct = [](std::vector<double> v, double p) { std::sort(v.begin(), v.end()); return v.empty() ? 0.0 : v[std::min(v.size() - 1, (size_t)(p * v.size()))]; };
            double avg = 0, cpu = 0;
            for (double v : benchFrames_) avg += v;
            for (double v : benchCpu_) cpu += v;
            avg /= (double)std::max<size_t>(1, benchFrames_.size()); cpu /= (double)std::max<size_t>(1, benchCpu_.size());
            bench_.push_back({presets[(size_t)benchPreset_], avg, pct(benchFrames_, 0.95), cpu, mil_.stats().visible, mil_.stats().instances, mil_.stats().draws, mil_.stats().fx, mil_.stats().tris, mil_.stats().upload,
                              s.gpu.gpuBytesAllocated() / 1048576.0});
        }
        if (++benchPreset_ >= (int)presets.size()) {
            std::printf("\nmilitary lab stress bench (%s, %dx%d, %d measured frames per preset after %d warm-up, zombies %d, camera RTS 110 m;\n"
                        "headless: frame ms = CPU + waiting for the GPU every frame; lavapipe numbers are relative only)\n",
                        s.gpu.driverName(), s.opt.width, s.opt.height, frames, warm, s.opt.labZombies);
            std::printf("| soldiers | frame ms avg | frame ms p95 | lab CPU ms (sample + pack) | posed (visible) | lab instances | lab draws | lab tris (M) | FX voxels | upload KB/frame | GPU MB |\n");
            std::printf("|---|---|---|---|---|---|---|---|---|---|---|\n");
            for (const BenchRow& r : bench_)
                std::printf("| %d | %.2f | %.2f | %.3f | %u | %u | %u | %.2f | %u | %.0f | %.0f |\n", r.n, r.frameAvg, r.frameP95, r.cpuAvg, r.visible, r.instances, r.draws,
                            r.tris / 1e6, r.fx, r.upload / 1024.0, r.gpuMB);
            std::fflush(stdout);
            s.quit = true;
            return;
        }
        setupStress(s, presets[(size_t)benchPreset_]);
        applyView(s, "rts110");
        s.cityRenderer.flush(s.camera, (float)s.opt.width / (float)std::max(1, s.opt.height));
        benchFrame_ = 0;
        benchFrames_.clear(); benchCpu_.clear();
    }
    ++benchFrame_;
}

void MilitaryLab::update(AppState& s, float dt) {
    // frame time (headless: includes the wait for the GPU)
    uint64_t now = SDL_GetPerformanceCounter();
    double frameMs = (double)(now - lastCounter_) * 1000.0 / (double)SDL_GetPerformanceFrequency();
    lastCounter_ = now;
    if (s.opt.headless && !s.opt.labStress.empty()) {
        if (benchPreset_ >= 0 && benchFrame_ > 45) { benchFrames_.push_back(frameMs); benchCpu_.push_back(mil_.stats().cpuMs); }
        benchStep(s);
        if (s.quit) return;
    }
    double t0 = msNowLab();
    // headless captures: --lab-views v1,v2,.. applied a few frames before the matching --shots frame
    if (!s.opt.labViews.empty() && !s.opt.shotFrames.empty()) {
        for (size_t k = 0; k < s.opt.shotFrames.size() && k < s.opt.labViews.size(); ++k)
            if ((int)s.frameIndex == std::max(0, s.opt.shotFrames[k] - 8)) {
                const std::string& v = s.opt.labViews[k];
                // view+options: +studio +notilt +inf=N +prop=N +clip=NAME|N +t=SECONDS +once +freeze +stress=N +drop=SECONDS +fire +hold
                std::string name = v.substr(0, v.find('+'));
                s.renderSettings.studioLighting = v.find("+studio") != std::string::npos;
                s.renderSettings.tiltShift = v.find("+notilt") == std::string::npos;
                auto opt = [&](const char* key) -> const char* { size_t p = v.find(key); return p == std::string::npos ? nullptr : v.c_str() + p + std::strlen(key); };
                if (const char* p = opt("+stress=")) setupStress(s, std::atoi(p));
                if (const char* p = opt("+prop=")) { selKind_ = 1; selIndex_ = std::atoi(p); }
                if (const char* p = opt("+inf=")) { selKind_ = 0; selIndex_ = std::atoi(p); shadowsDirty_ = true; }
                if (const char* p = opt("+clip=")) {
                    std::string c(p);
                    c = c.substr(0, c.find('+'));
                    int idx = selKind_ == 0 && selIndex_ < (int)lib_.infantry.size() ? clipByAction(lib_.infantry[(size_t)selIndex_], c.c_str()) : -1;
                    clip_ = idx >= 0 ? idx : std::atoi(c.c_str());
                    animTime_ = 0.f; playing_ = true;
                }
                if (const char* p = opt("+t=")) animTime_ = (float)std::atof(p);
                if (v.find("+once") != std::string::npos) loop_ = false;   // one-shot clips hold their last frame
                if (opt("+clip=") && opt("+t=")) {   // exact pose: no cross-fade from the previous clip
                    sel_ = Soldier{}; sel_.infantry = selIndex_; sel_.clip = clip_; sel_.t = animTime_;
                    if (v.find("+freeze") != std::string::npos) playing_ = false;   // hold exactly this clip time
                }
                if (const char* p = opt("+drop=")) {   // every drop to a sequence time (30 Hz steps, events included)
                    float T = (float)std::atof(p);
                    for (Drop& d : drops_) { d.phase = 0; d.t = 0.f; d.alt = 0.f; d.released = false; d.groundT = -1.f; };
                    for (float tt = 0.f; tt < T; tt += 1.f / 30.f) updateDrops(s, std::min(1.f / 30.f, T - tt));
                    mil_.clearFx();
                }
                holdFx_ = v.find("+hold") != std::string::npos;
                if (v.find("+seq") != std::string::npos) { seq_ = true; seqT_ = 0.f; seqIdx_ = 0; playing_ = true; loop_ = true; }
                if (v.find("+fire") != std::string::npos) { mil_.clearFx(); triggerFx("shot"); }
                applyView(s, name);
                SDL_Log("military lab: shot %zu at frame %d: view %s", k, s.opt.shotFrames[k], v.c_str());
                s.cityRenderer.flush(s.camera, (float)s.opt.width / (float)std::max(1, s.opt.height));
            }
    }
    if (turntable_) turnAngle_ = std::fmod(turnAngle_ + dt * 0.6f, 2.f * kPi);
    const float fdt = holdFx_ ? 0.f : dt;

    // camera frustum (per-soldier culling) and eye (LOD); clears the renderer's frame lists
    {
        float aspect = (float)s.opt.width / (float)std::max(1, s.opt.height);
        if (s.window) { int w, h; SDL_GetWindowSize(s.window, &w, &h); aspect = (float)w / (float)std::max(1, h); }
        mil_.beginFrame(s.camera, aspect);
    }
    if (!dropsPlaced_ && (int)s.frameIndex >= (s.opt.headless ? 1 : 30)) placeDrops(s);

    // clip playback with events (fired when the playhead crosses t, also on loop wrap)
    auto advance = [&](Soldier& so, float step, bool events, int lod) {
        const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
        MilAdvance r = milAdvance(lib_, inf, so, so.pos, so.yaw, step);
        if (!r.key) return;
        const MilKeyClip& k = *r.key;
        if (so.mover && !k.rootMotion && k.speed > 0.f && step > 0.f) {   // in-place locomotion: the agent moves at the clip speed
            V3 f{std::sin(so.yaw), 0.f, std::cos(so.yaw)};
            V3 np = so.pos + f * (k.speed * step * so.rate);
            V3 look = np + f * 0.9f;
            if (rasterHeight(s, look.x, look.z) > 0.3f || length(np - so.home) > 14.f)
                so.yaw = std::atan2(so.home.x - so.pos.x, so.home.z - so.pos.z) + 0.4f * (hashf((uint32_t)(so.pos.x * 31.f)) - 0.5f);   // turn back
            else so.pos = np;
        }
        if (!events || step <= 0.f || lod >= 2) return;   // no FX beyond LOD1 (a few pixels)
        for (const MilFxEvent& e : k.events) if (r.crossed(e.t, so.t)) mil_.fxEvent(so, e);
    };

    // selected soldier (turntable)
    if (selKind_ == 0 && selIndex_ < (int)lib_.infantry.size()) {
        const MilInfantry& inf = lib_.infantry[(size_t)selIndex_];
        if (clip_ >= (int)inf.clips.size()) clip_ = 0;
        if (seq_) {   // transition demo: idle -> walk -> run -> aim -> fire -> reload -> walk
            static const char* kSeq[] = {"idle", "walk", "run", "aim", "fire", "reload", "walk"};
            static const float kSeqDur[] = {1.0f, 1.6f, 1.6f, 0.8f, 1.2f, 0.f, 2.f};
            seqT_ += fdt;
            int c = clipByAction(inf, kSeq[seqIdx_]);
            float dur = kSeqDur[seqIdx_] > 0.f ? kSeqDur[seqIdx_] : (c >= 0 ? inf.clips[(size_t)c].length : 1.f);
            if (seqT_ >= dur && seqIdx_ < 6) { seqT_ -= dur; ++seqIdx_; c = clipByAction(inf, kSeq[seqIdx_]); }
            if (c >= 0) clip_ = c;
        }
        Soldier& so = sel_;
        if (so.infantry != selIndex_) { so = Soldier{}; so.infantry = selIndex_; so.clip = clip_; so.t = animTime_; }
        so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f);
        if (std::fabs(animTime_ - so.t) > 1e-4f) so.t = animTime_;   // scrubbed in the UI
        milSwitchClip(lib_, inf, so, so.pos, so.yaw, clip_);         // cross-fade on clip changes
        const MilClip& c = inf.clips[(size_t)clip_];
        if (playing_ && c.available) {
            advance(so, fdt * animSpeed_, true, 0);
            if (!c.loop && so.t >= c.length) { if (loop_) so.t = 0.f; else if (!seq_) playing_ = false; }
        }
        so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f);   // the turntable spot stays put
        animTime_ = so.t;
        so.lod = 0;
        mil_.addSoldier(so);
    }
    if (showLineup_)
        for (Soldier& so : lineup_) {
            if (lineupAnimated_ && clip_ < (int)lib_.infantry[(size_t)so.infantry].clips.size()) so.clip = clip_;
            advance(so, fdt, false, 0);
            so.lod = -1;
            mil_.addSoldier(so);
        }
    // stress soldiers: scripted cycle idle -> walk -> run -> aim -> fire -> reload (-> death)
    static const char* kScript[] = {"idle", "walk", "run", "aim", "fire", "reload", "death"};
    static const float kDur[] = {3.f, 5.f, 3.f, 1.f, 4.f, 0.f, 0.f};
    for (size_t i = 0; i < stress_.size(); ++i) {
        Soldier& so = stress_[i];
        const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
        so.stateLeft -= fdt;
        if (so.stateLeft <= 0.f) {
            so.script = (so.script + 1) % 7;
            if (so.script == 6 && hashf((uint32_t)i * 97u + (uint32_t)(s.renderTime * 3.0)) > 0.25f) so.script = 0;   // 25 % die
            int c = clipByAction(inf, kScript[so.script]);
            if (c < 0) c = std::max(0, clipByAction(inf, "idle"));
            milSwitchClip(lib_, inf, so, so.pos, so.yaw, c);
            float len = inf.clips[(size_t)c].length;
            so.stateLeft = kDur[so.script] > 0.f ? kDur[so.script] : len + (so.script == 6 ? 3.f : 0.f);
        }
        int lod = mil_.lodAt(so.pos);
        advance(so, fdt, true, lod);
        ++mil_.stats().soldiers;
        if (mil_.visible(so.pos, 1.2f)) { so.lod = lod; mil_.addSoldier(so); }
    }

    // parachute drops
    if (showDrops_) {
        updateDrops(s, fdt);
        for (const Drop& d : drops_) mil_.addDrop(d);
    }

    // FX particles
    mil_.updateFx(fdt);

    // props, helpers, comparison vehicles
    auto putProp = [&](const MilProp& p, float lx, float lz, float localYaw) {
        mil_.addProp((int)(&p - lib_.props.data()), world(lx, lz), worldYaw(localYaw));
    };
    if (selKind_ == 1 && selIndex_ < (int)lib_.props.size()) putProp(lib_.props[(size_t)selIndex_], 0, 0, turntable_ ? turnAngle_ : 0.f);
    if (showProps_) {   // rows of at most kPropsRow metres behind the lineup ("props row" view), parachutes excluded
        float x = 0, z = kPropsZ;
        std::vector<std::pair<const MilProp*, float>> row;
        auto flushRow = [&]() {
            for (auto& [pp, px] : row) putProp(*pp, px - 0.5f * x, z, kPi);
            row.clear(); x = 0; z -= kPropsRowGap;
        };
        for (const MilProp& p : lib_.props) {
            if (p.name.rfind("para_", 0) == 0) continue;
            if (x + p.footprint[0] > kPropsRow && !row.empty()) flushRow();
            row.push_back({&p, x + 0.5f * p.footprint[0]});
            x += p.footprint[0] + 0.8f;
        }
        flushRow();
    }
    if (showGrid_ && lib_.gridModel >= 0) mil_.addModelYaw(lib_.gridModel, world(0, 0), worldYaw(0));
    if (showRuler_ && lib_.rulerModel >= 0) {
        mil_.addModelYaw(lib_.rulerModel, world(1.4f, 0.3f), worldYaw(0));
        mil_.addModelYaw(lib_.rulerModel, world(-12.f, kLineupZ + 0.6f), worldYaw(0));
    }
    if (showLineup_ && showVehicles_) {
        float x = -11.f + 3 * 1.3f + 0.4f + lib_.infantry.size() * 1.3f + 1.6f;
        for (const char* want : {"sedan|ok", "pickup|ok", "police|ok"}) {
            size_t v = 0;
            while (v < s.city.variants.size() && s.city.variants[v].name.rfind(want, 0) != 0) ++v;
            const CityRenderer::GpuMesh* m = city_->vehicleModel(v);
            if (!m) continue;
            float len = std::min(6.f, 1.8f * m->radius), q[4];
            yawQuat(worldYaw(0.5f * kPi), q);
            mil_.addCityMesh(m, world(x + 0.5f * len, kLineupZ - 0.3f), q);
            x += len + 0.6f;
        }
    }
    if (shadowsDirty_) rebuildShadows(s);

    mil_.endFrame();   // parts sorted by mesh (one instanced draw per mesh), then CPU instances, canopies, vehicles
    mil_.stats().cpuMs = msNowLab() - t0;
}

void MilitaryLab::injectLights(std::vector<PointLight>& lights) const { mil_.injectLights(lights); }
void MilitaryLab::prepare(SDL_GPUCommandBuffer* cmd) { mil_.prepare(cmd); }
void MilitaryLab::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH) {
    mil_.draw(pass, cmd, decals, shadow, corpseH);
}
void MilitaryLab::drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd) { mil_.drawShadow(pass, cmd); }

// ---------------------------------------------------------------------------------------------------------------
void MilitaryLab::drawUI(AppState& s) {
    const float fs = ImGui::GetIO().FontGlobalScale;
    {   // stats overlay
        ImGui::SetNextWindowPos(ImVec2(12.f, 12.f), ImGuiCond_FirstUseEver);
        ImGui::SetNextWindowBgAlpha(0.6f);
        ImGui::Begin("Lab stats", nullptr, ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoFocusOnAppearing);
        ImGui::Text("frame %.2f ms (CPU, app)  lab CPU %.3f ms", s.cpuFrame.avg, mil_.stats().cpuMs);
        ImGui::Text("stress soldiers %u, posed %u  LOD %u / %u / %u", mil_.stats().soldiers, mil_.stats().visible, mil_.stats().lod[0], mil_.stats().lod[1], mil_.stats().lod[2]);
        ImGui::Text("lab instances %u  draws %u  tris %.2f M  FX %u", mil_.stats().instances, mil_.stats().draws, mil_.stats().tris / 1e6, mil_.stats().fx);
        ImGui::Text("upload %.0f KB/frame  GPU %.0f MB  zombies %u", mil_.stats().upload / 1024.0, s.gpu.gpuBytesAllocated() / 1048576.0, s.sim.stats().live);
        ImGui::End();
    }
    ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + vp->WorkSize.x - 12.f, vp->WorkPos.y + 12.f), ImGuiCond_FirstUseEver, ImVec2(1.f, 0.f));
    ImGui::SetNextWindowSize(ImVec2(420.f * fs, vp->WorkSize.y * 0.9f), ImGuiCond_FirstUseEver);
    ImGui::Begin("Military Asset Lab", nullptr, ImGuiWindowFlags_NoFocusOnAppearing);
    ImGui::TextDisabled("%s; %s", lib_.source.c_str(), lib_.animSource.c_str());
    ImGui::TextDisabled("F1 hides the UI  MMB / Alt+LMB orbit  RMB pan  wheel zoom  F2 RTS rig");

    if (ImGui::CollapsingHeader("Asset browser", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::BeginChild("assets", ImVec2(0, 200.f * fs), ImGuiChildFlags_Borders);
        if (ImGui::TreeNodeEx("Infantry", ImGuiTreeNodeFlags_DefaultOpen)) {
            for (size_t i = 0; i < lib_.infantry.size(); ++i) {
                const MilInfantry& inf = lib_.infantry[i];
                std::string label = inf.cls + " - " + inf.variant + "##inf" + std::to_string(i);
                if (ImGui::Selectable(label.c_str(), selKind_ == 0 && selIndex_ == (int)i)) select(s, 0, (int)i);
            }
            ImGui::TreePop();
        }
        if (ImGui::TreeNodeEx("Props", ImGuiTreeNodeFlags_DefaultOpen)) {
            std::string cat;
            for (size_t i = 0; i < lib_.props.size(); ++i) {
                const MilProp& p = lib_.props[i];
                if (p.category != cat) { cat = p.category; ImGui::SeparatorText(cat.c_str()); }
                std::string label = p.name + "##prop" + std::to_string(i);
                if (ImGui::Selectable(label.c_str(), selKind_ == 1 && selIndex_ == (int)i)) select(s, 1, (int)i);
            }
            ImGui::TreePop();
        }
        ImGui::EndChild();
        ImGui::Checkbox("turntable", &turntable_);
    }
    if (ImGui::CollapsingHeader("Camera", ImGuiTreeNodeFlags_DefaultOpen)) {
        const char* views[] = {"closeup", "front", "rear", "side", "top", "muzzle"};
        for (int i = 0; i < 6; ++i) { if (i) ImGui::SameLine(); if (ImGui::Button(views[i])) applyView(s, views[i]); }
        if (ImGui::Button("RTS 45 m")) applyView(s, "rts45");
        ImGui::SameLine(); if (ImGui::Button("RTS 110 m")) applyView(s, "rts110");
        ImGui::SameLine(); if (ImGui::Button("RTS 300 m")) applyView(s, "rts300");
        if (ImGui::Button("lineup")) applyView(s, "lineup");
        ImGui::SameLine(); if (ImGui::Button("props row")) applyView(s, "props");
        ImGui::SameLine(); if (ImGui::Button("drop (street)")) applyView(s, "parachute");
        ImGui::SameLine(); if (ImGui::Button("drop (roof)")) applyView(s, "roofhigh");
        ImGui::Text("distance %.1f m  pitch %.0f deg", s.camera.distance(), s.camera.pitch() * 180.f / kPi);
    }
    if (ImGui::CollapsingHeader("Lighting & display", ImGuiTreeNodeFlags_DefaultOpen)) {
        int light = s.renderSettings.studioLighting ? 1 : 0;
        ImGui::RadioButton("in-game (time of day)", &light, 0);
        ImGui::SameLine(); ImGui::RadioButton("neutral studio", &light, 1);
        s.renderSettings.studioLighting = light == 1;
        ImGui::Checkbox("tilt-shift", &s.renderSettings.tiltShift);
        ImGui::SameLine(); ImGui::Checkbox("shadows", &s.renderSettings.shadows);
        ImGui::SameLine(); if (ImGui::Checkbox("lab objects cast", &labShadows_)) shadowsDirty_ = true;
        ImGui::SliderFloat("fog density", &s.renderSettings.fogDensity, 0.f, 0.004f, "%.4f");
        if (ImGui::Checkbox("comparison lineup", &showLineup_)) setupScene(s);
        ImGui::SameLine(); ImGui::Checkbox("vehicles", &showVehicles_);
        ImGui::SameLine(); if (ImGui::Checkbox("zombies", &lineupZombies_)) setupScene(s);
        if (ImGui::Checkbox("props rows", &showProps_)) shadowsDirty_ = true;
        ImGui::SameLine(); ImGui::Checkbox("grid", &showGrid_);
        ImGui::SameLine(); ImGui::Checkbox("2 m ruler", &showRuler_);
        if (ImGui::Button("rebuild shadows")) shadowsDirty_ = true;
    }
    if (ImGui::CollapsingHeader("Animation", ImGuiTreeNodeFlags_DefaultOpen)) {
        if (selKind_ == 0 && selIndex_ < (int)lib_.infantry.size()) {
            const MilInfantry& inf = lib_.infantry[(size_t)selIndex_];
            ImGui::BeginChild("clips", ImVec2(0, 160.f * fs), ImGuiChildFlags_Borders);
            for (size_t i = 0; i < inf.clips.size(); ++i) {
                const MilClip& c = inf.clips[i];
                ImGui::BeginDisabled(!c.available);
                char label[160];
                std::snprintf(label, sizeof(label), "%s  (%.2f s%s%s)##clip%zu", c.name.c_str(), c.length, c.loop ? ", loop" : "",
                              c.keyClip >= 0 && lib_.keyClips[(size_t)c.keyClip].rootMotion ? ", root motion" : "", i);
                if (ImGui::Selectable(label, clip_ == (int)i)) { clip_ = (int)i; playing_ = true; loop_ = c.loop; seq_ = false; }   // cross-fades
                ImGui::EndDisabled();
            }
            ImGui::EndChild();
            const MilClip& c = inf.clips[(size_t)std::clamp(clip_, 0, (int)inf.clips.size() - 1)];
            if (ImGui::Button(playing_ ? "pause" : "play")) playing_ = !playing_;
            ImGui::SameLine(); ImGui::Checkbox("loop", &loop_);
            ImGui::SameLine(); ImGui::Checkbox("lineup plays it", &lineupAnimated_);
            ImGui::SliderFloat("speed", &animSpeed_, 0.05f, 2.f, "%.2fx");
            if (ImGui::SliderFloat("time", &animTime_, 0.f, c.length, "%.2f s")) { playing_ = false; seq_ = false; }
            if (ImGui::Button(seq_ ? "stop transition demo" : "transition demo (idle-walk-run-aim-fire-reload-walk)")) { seq_ = !seq_; seqT_ = 0.f; seqIdx_ = 0; playing_ = true; }
            if (c.keyClip >= 0) {
                const MilKeyClip& k = lib_.keyClips[(size_t)c.keyClip];
                ImGui::TextDisabled("%d frames @30 Hz, speed %.2f m/s, %zu events", k.frames, k.speed, k.events.size());
            }
        } else ImGui::TextDisabled("select an infantry asset");
        ImGui::SeparatorText("parachute drops (street, rooftop, cargo)");
        ImGui::Checkbox("show drops", &showDrops_);
        ImGui::SameLine();
        if (ImGui::Button("restart drops")) for (Drop& d : drops_) { d.phase = 0; d.t = 0.f; d.alt = 0.f; d.released = false; };
        for (const Drop& d : drops_)
            ImGui::TextDisabled("%s: %s %.1f s%s", d.cargo ? "cargo" : (d.xz.y > 1.f ? "soldier (roof)" : "soldier (street)"),
                                d.phase == 0 ? "descent" : d.phase == 1 ? "land" : d.phase == 2 ? "recover" : "settled", d.t, d.released ? ", harness released" : "");
    }
    if (ImGui::CollapsingHeader("Weapon FX", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::Checkbox("FX from clip events", &mil_.fxEnabled);
        ImGui::SameLine(); ImGui::Checkbox("freeze", &holdFx_);
        if (ImGui::Button("shot (flash + tracer + casing)")) triggerFx("shot");
        ImGui::SameLine(); if (ImGui::Button("suppressed puff")) triggerFx("suppressed");
        if (ImGui::Button("muzzle flash")) triggerFx("muzzle_flash");
        ImGui::SameLine(); if (ImGui::Button("tracer")) triggerFx("tracer");
        ImGui::SameLine(); if (ImGui::Button("casing")) triggerFx("shell_eject");
        ImGui::TextDisabled("budget: %u / %u FX voxels, %u flash lights max", mil_.stats().fx, kMaxFx, kMaxFlashLights);
    }
    if (ImGui::CollapsingHeader("Stress test", ImGuiTreeNodeFlags_DefaultOpen)) {
        const int presets[] = {0, 10, 50, 100, 250, 500, 1000};
        for (int i = 0; i < 7; ++i) {
            if (i) ImGui::SameLine();
            char b[16];
            std::snprintf(b, sizeof(b), "%d", presets[i]);
            if (ImGui::Button(b)) setupStress(s, presets[i]);
        }
        ImGui::SliderInt("zombies (next preset)", &s.opt.labZombies, 0, 8000);
        ImGui::TextDisabled("scripted: idle / walk / run / aim / fire / reload / death; LOD 70 / 180 m");
    }
    ImGui::End();
}

} // namespace ttz
