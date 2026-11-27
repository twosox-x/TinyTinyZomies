#include "lab/MilitaryLab.h"

#include "app/App.h"
#include "imgui.h"
#include "sim/Look.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr uint32_t kMaxChars = 1280, kMaxAtts = 28672, kMaxCpuInst = 8192, kMaxPlaceholderChars = 64;
constexpr uint32_t kMaxFx = 4000, kMaxFlashLights = 4;
constexpr float kPi = 3.14159265f;
constexpr float kCanopyHold = 2.5f, kCanopyDissolve = 2.5f;   // parachute canopies after canopy_ground (MILITARY_ANIMS.md 2.3.3)
static_assert(sizeof(MilitaryLab::CharU) == 240 && sizeof(MilitaryLab::AttU) == 48);
using Inst = CityRenderer::GpuInstance;

// quaternions (x, y, z, w), same conventions as zombie_pose.glsl
void qmul(const float a[4], const float b[4], float o[4]) {
    float r[4] = {a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
                  a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]};
    std::memcpy(o, r, sizeof(r));
}
void qrotv(const float q[4], const float v[3], float out[3]) {
    float tx = 2.f * (q[1] * v[2] - q[2] * v[1]), ty = 2.f * (q[2] * v[0] - q[0] * v[2]), tz = 2.f * (q[0] * v[1] - q[1] * v[0]);
    float r[3] = {v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)};
    std::memcpy(out, r, sizeof(r));
}
void qconj(const float q[4], float o[4]) { o[0] = -q[0]; o[1] = -q[1]; o[2] = -q[2]; o[3] = q[3]; }
void qnorm(float q[4]) { float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]); for (int k = 0; k < 4; ++k) q[k] /= l > 0 ? l : 1.f; }
void qnlerp(const float a[4], const float b[4], float w, float o[4]) {   // shortest arc
    float d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], sg = d < 0 ? -1.f : 1.f;
    for (int k = 0; k < 4; ++k) o[k] = a[k] * (1.f - w) + sg * b[k] * w;
    qnorm(o);
}
void qarc(const float u[3], const float v[3], float o[4]) {   // shortest rotation taking unit u to unit v
    float c[3] = {u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]}, d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    if (d < -0.9999f) { o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0; return; }
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = 1.f + d;
    qnorm(o);
}
void quatToEulerXYZ(const float q[4], float e[3]) {   // R = Rx * Ry * Rz (three.js 'XYZ')
    float x = q[0], y = q[1], z = q[2], w = q[3];
    float m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y);
    float m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
    e[1] = std::asin(std::clamp(m13, -1.f, 1.f));
    if (std::fabs(m13) < 0.9999f) { e[0] = std::atan2(-m23, m33); e[2] = std::atan2(-m12, m11); }
    else { e[0] = std::atan2(m32, m22); e[2] = 0.f; }
}
void yawQuat(float yaw, float q[4]) { q[0] = 0; q[1] = std::sin(0.5f * yaw); q[2] = 0; q[3] = std::cos(0.5f * yaw); }
uint16_t packHalf(float f) {   // float -> IEEE half (round toward zero; small values flush to 0)
    uint32_t x;
    std::memcpy(&x, &f, 4);
    uint32_t sign = (x >> 16) & 0x8000u, e = (x >> 23) & 0xFFu, m = x & 0x7FFFFFu;
    int he = (int)e - 127 + 15;
    if (e == 0 || he <= 0) return (uint16_t)sign;
    if (he >= 31) return (uint16_t)(sign | 0x7C00u);
    return (uint16_t)(sign | ((uint32_t)he << 10) | (m >> 13));
}
float length(V3 a) { return std::sqrt(dot(a, a)); }
float hashf(uint32_t x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return (x & 0xFFFFFF) / 16777216.f; }
// zombie body standard joints (zombie_parts.glsl ZP_PIVOT / ZP_SLOT_PARENT)
const float kPivot[10][3] = {{0, 14, 0}, {0, 8, 0}, {3, 13.5f, 0}, {3, 10, 0}, {-3, 13.5f, 0}, {-3, 10, 0}, {1.5f, 8, 0}, {1.5f, 4, 0}, {-1.5f, 8, 0}, {-1.5f, 4, 0}};
const int kParent[10] = {1, -1, 1, 2, 1, 4, -1, 6, -1, 8};
LookSpec lineupLook(int i) { return i == 0 ? labOfficeDrone() : i == 1 ? labStreetWalker() : labRotter(); }
// layout (lab-local metres; +Z faces the default camera): turntable at the origin, lineup row behind it, props rows
// behind the lineup, parachute drops to the right
constexpr float kLineupZ = -4.f, kPropsZ = -9.5f, kChuteX = 10.f;
constexpr float kClearX0 = -13.f, kClearX1 = 15.f, kClearZ0 = -16.f, kClearZ1 = 3.f, kPropsRow = 24.f, kPropsRowGap = 4.5f;
// gear dropped beyond LOD0 (a few pixels at RTS distance)
bool smallGear(const std::string& n) {
    return n == "gear_shinL" || n == "gear_shinR" || n == "gear_thighL" || n == "gear_thighR" || n == "gear_forearmL";
}
// ejection ports, weapon space (docs/MILITARY_ANIMS.md 6)
void ejectPort(const std::string& kind, float p[3]) {
    if (kind == "mg") { p[0] = -0.07f; p[1] = 0.10f; p[2] = 0.12f; }
    else if (kind == "sniper") { p[0] = -0.05f; p[1] = 0.10f; p[2] = 0.03f; }
    else { p[0] = -0.05f; p[1] = 0.08f; p[2] = 0.10f; }
}
std::string dataPathLab(const std::string& rel) {   // cwd, next to the executable, then the source tree
    SDL_PathInfo info;
    if (SDL_GetPathInfo(rel.c_str(), &info)) return rel;
    const char* base = SDL_GetBasePath();
    std::string p = std::string(base ? base : "") + rel;
    if (SDL_GetPathInfo(p.c_str(), &info)) return p;
#ifdef TTZ_SOURCE_DIR
    std::string q = std::string(TTZ_SOURCE_DIR) + "/" + rel;
    if (SDL_GetPathInfo(q.c_str(), &info)) return q;
#endif
    return rel;
}
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
    chars_ = &s.chars;
    sim_ = &s.sim;
    bodyVoxel_ = s.chars.metresPerVoxel();
    if (!lib_.load(dataPathLab("assets/military"), bodyVoxel_)) lib_.buildPlaceholders(bodyVoxel_);
    pPose_ = gpu_->loadCompute("mil_pose", 64);
    pAttach_ = gpu_->loadCompute("mil_attach", 64);
    if (!pPose_ || !pAttach_) return false;
    constexpr SDL_GPUBufferUsageFlags rw = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE |
                                           SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    charBuf_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ, kMaxChars * (uint32_t)sizeof(CharU), "milChars");
    attBuf_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ, kMaxAtts * (uint32_t)sizeof(AttU), "milAtts");
    joints_ = gpu_->createBuffer(rw, kMaxChars * 20 * 16, "milJoints");
    segs_ = gpu_->createBuffer(rw, kMaxPlaceholderChars * 10 * 32, "milSegs");
    insts_ = gpu_->createBuffer(rw, (kMaxAtts + kMaxCpuInst) * (uint32_t)sizeof(Inst), "milInsts");
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD,
                                        kMaxChars * (uint32_t)sizeof(CharU) + kMaxAtts * (uint32_t)sizeof(AttU) + kMaxCpuInst * (uint32_t)sizeof(Inst), 0};
    tb_ = SDL_CreateGPUTransferBuffer(gpu_->device(), &tci);
    mats_ = city_->createMaterialBuffer(lib_.palette);
    lib_.premeshed.resize(lib_.models.size());
    for (size_t i = 0; i < lib_.models.size(); ++i) {
        CityMesh m = lib_.premeshed[i].verts.empty() ? meshVoxelModel(lib_.models[i]) : lib_.premeshed[i];
        std::array<float, 6> b{1e9f, 1e9f, 1e9f, -1e9f, -1e9f, -1e9f};
        for (const CityVertex& v : m.verts) {
            float p[3] = {m.origin[0] + v.x * m.scaleXZ, m.origin[1] + v.y * m.scaleY, m.origin[2] + v.z * m.scaleXZ};
            for (int k = 0; k < 3; ++k) { b[k] = std::min(b[k], p[k]); b[3 + k] = std::max(b[3 + k], p[k]); }
        }
        meshBounds_.push_back(b);
        meshTris_.push_back((uint32_t)(m.idx.size() / 3));
        meshes_.push_back(city_->uploadExternalMesh(m, "milModel"));
    }
    attBuckets_.resize(meshes_.size());
    instBuckets_.resize(meshes_.size());
    findSpot(s);
    findRoof(s);
    // the lab's moon-shadow field: the window's field plus lab props and soldiers (rebuildShadows)
    shadowBuf_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, (uint32_t)(9u * s.params.gridW * s.params.gridH * 4u), "milShadow");
    s.renderer.extPrepare = [this](SDL_GPUCommandBuffer* cmd) { prepare(cmd); };
    s.renderer.extDraw = [this](SDL_GPURenderPass* p, SDL_GPUCommandBuffer* c, SDL_GPUBuffer* d, SDL_GPUBuffer* sh, SDL_GPUBuffer* ch) {
        draw(p, c, d, sh, ch);
    };
    s.renderer.extShadowDraw = [this](SDL_GPURenderPass* p, SDL_GPUCommandBuffer* c) { drawShadow(p, c); };
    s.debugCam = true;   // free orbit camera (F2 toggles the RTS rig)
    s.camera.settings.minDistance = 1.0f;
    s.camera.settings.maxDistance = 600.f;
    s.camera.settings.minPitch = -0.2f;
    s.camera.settings.maxPitch = 89.f * kPi / 180.f;
    // lineup: every infantry variant, idle (or the zombie idle clip for placeholders)
    float x = -11.f + 3 * 1.3f + 0.4f;
    for (size_t i = 0; i < lib_.infantry.size(); ++i, x += 1.3f) {
        Soldier so;
        so.inf = (int)i;
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
    for (auto& m : meshes_) city_->releaseMesh(m);
    meshes_.clear();
    for (SDL_GPUBuffer** b : {&charBuf_, &attBuf_, &joints_, &segs_, &insts_, &mats_, &shadowBuf_}) gpu_->releaseBuffer(*b);
    if (tb_) SDL_ReleaseGPUTransferBuffer(gpu_->device(), tb_);
    if (pPose_) SDL_ReleaseGPUComputePipeline(gpu_->device(), pPose_);
    if (pAttach_) SDL_ReleaseGPUComputePipeline(gpu_->device(), pAttach_);
    tb_ = nullptr; pPose_ = pAttach_ = nullptr; gpu_ = nullptr;
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

int MilitaryLab::clipByAction(const MilInfantry& inf, const char* action) const {
    for (size_t i = 0; i < inf.clips.size(); ++i) if (inf.clips[i].available && inf.clips[i].name == action) return (int)i;
    for (size_t i = 0; i < inf.clips.size(); ++i)
        if (inf.clips[i].available && inf.clips[i].name.find(action) != std::string::npos) return (int)i;
    return -1;
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
            so.inf = k % (int)lib_.infantry.size();
            so.pos = cand[(size_t)k].second;
            so.yaw = hashf((uint32_t)k * 7u + 1u) * 2.f * kPi;
            so.script = (int)(hashf((uint32_t)k * 13u + 5u) * 6.f);
            so.stateLeft = hashf((uint32_t)k * 31u) * 4.f;
            so.t = hashf((uint32_t)k * 17u) * 3.f;
            so.clip = std::max(0, clipByAction(lib_.infantry[(size_t)so.inf], "idle"));
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
        if (m >= 0) { const auto& b = meshBounds_[(size_t)m]; size = std::max({b[3] - b[0], b[4] - b[1], b[5] - b[2], 1.f}); }
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

// CPU sample of a soldier's clip into the GPU record; mountQ = weapon mount (forearmR space).
void MilitaryLab::sampleSoldier(const Soldier& so, CharU& C, float mountQ[4], int lod) const {
    const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
    const MilClip* c = so.clip >= 0 && so.clip < (int)inf.clips.size() ? &inf.clips[(size_t)so.clip] : nullptr;
    std::memset(&C, 0, sizeof(C));
    C.posYaw[0] = so.pos.x; C.posYaw[1] = so.pos.y; C.posYaw[2] = so.pos.z; C.posYaw[3] = so.yaw;
    C.rootQ[3] = 1.f;
    mountQ[0] = mountQ[1] = mountQ[2] = 0; mountQ[3] = 1;
    C.look[0] = inf.lookX; C.look[1] = inf.lookY; C.look[2] = inf.ownBody ? 1u : 0u; C.look[3] = (uint32_t)(so.inf * 389 + (int)(so.pos.x * 7.f));
    float t = so.t;
    if (lod == 1) t = std::floor(t * 15.f) / 15.f;        // distance LOD: 15 Hz pose
    else if (lod >= 2) t = std::floor(t * 5.f) / 5.f;     // 5 Hz pose
    if (!c || !c->available) { C.anim[0] = 8.f; return; }
    if (c->keyClip >= 0 && c->keyClip < (int)lib_.keyClips.size()) {
        float B[MB_STRIDE];
        if (sampleBody(so, lod, B)) {
            C.anim[0] = 9.f; C.anim[1] = t;
            for (int s = 0; s < 10; ++s) for (int k = 0; k < 3; ++k) C.rot[s][k] = B[MB_ROT + s * 3 + k];
            eulerXYZToQuat(&B[MB_ROOTROT], C.rootQ);
            for (int k = 0; k < 3; ++k) C.rootPos[k] = B[MB_ROOTPOS + k];
            eulerXYZToQuat(&B[MB_MOUNT], mountQ);
            C.anim[3] = B[MB_FLAGS];   // explicit poses: flags (bit 6 weapon slung)
            return;
        }
    }
    C.anim[0] = (float)c->anim; C.anim[1] = t;
    C.anim[2] = c->length > 0 ? t / c->length * 2.f * kPi : 0.f; C.anim[3] = c->speed;
    if (inf.weaponAtt >= 0) std::memcpy(mountQ, inf.atts[(size_t)inf.weaponAtt].quat, sizeof(float) * 4);
}

// Clip pose of a soldier: the current clip, cross-faded with the previous one while a transition runs
// (docs/MILITARY_ANIMS.md 4: per-slot quaternion nlerp, rootPos / supportTarget lerp, rootRot / weaponMount nlerp,
// flags from the dominant clip), then the left arm re-solved to the weapon support point (2-bone IK, 3.5 V bones,
// elbow pole down / out) weighted by the blended supportW. Single clips are already IK-solved at bake time.
bool MilitaryLab::sampleBody(const Soldier& so, int lod, float* B) const {
    const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
    auto keyOf = [&](int clip) -> const MilKeyClip* {
        if (clip < 0 || clip >= (int)inf.clips.size()) return nullptr;
        int k = inf.clips[(size_t)clip].keyClip;
        return k >= 0 && k < (int)lib_.keyClips.size() && !lib_.keyClips[(size_t)k].body.empty() ? &lib_.keyClips[(size_t)k] : nullptr;
    };
    auto q = [&](float t) { return lod == 1 ? std::floor(t * 15.f) / 15.f : lod >= 2 ? std::floor(t * 5.f) / 5.f : t; };
    const MilKeyClip* k = keyOf(so.clip);
    if (!k || !k->sampleBody(q(so.t), B)) return false;
    const MilKeyClip* kp = so.blendDur > 0.f && so.blend < so.blendDur ? keyOf(so.prevClip) : nullptr;
    if (!kp || lod >= 2) return true;
    float P[MB_STRIDE];
    kp->sampleBody(q(so.prevT), P);
    if (so.prevDelta[0] != 0.f || so.prevDelta[2] != 0.f || so.prevDelta[3] != 0.f) {   // root motion committed: into the new agent frame
        float dx = P[MB_ROOTPOS] - so.prevDelta[0], dz = P[MB_ROOTPOS + 2] - so.prevDelta[2], c = std::cos(-so.prevDelta[3]), s = std::sin(-so.prevDelta[3]);
        P[MB_ROOTPOS] = dx * c + dz * s; P[MB_ROOTPOS + 2] = -dx * s + dz * c;
        P[MB_ROOTPOS + 1] -= so.prevDelta[1];
        P[MB_ROOTROT + 1] -= so.prevDelta[3];
    }
    float u = std::clamp(so.blend / so.blendDur, 0.f, 1.f), w = u * u * (3.f - 2.f * u);
    float qa[4], qb[4], qo[4];
    auto blendEuler = [&](int off) {
        eulerXYZToQuat(&P[off], qa); eulerXYZToQuat(&B[off], qb); qnlerp(qa, qb, w, qo); quatToEulerXYZ(qo, &B[off]);
    };
    for (int sl = 0; sl < 10; ++sl) blendEuler(MB_ROT + sl * 3);
    blendEuler(MB_ROOTROT);
    blendEuler(MB_MOUNT);
    for (int k3 = 0; k3 < 3; ++k3) {
        B[MB_ROOTPOS + k3] = P[MB_ROOTPOS + k3] + (B[MB_ROOTPOS + k3] - P[MB_ROOTPOS + k3]) * w;
        B[MB_SUPPORT + k3] = P[MB_SUPPORT + k3] + (B[MB_SUPPORT + k3] - P[MB_SUPPORT + k3]) * w;
    }
    B[MB_SUPPORTW] = P[MB_SUPPORTW] + (B[MB_SUPPORTW] - P[MB_SUPPORTW]) * w;
    if (w < 0.5f) B[MB_FLAGS] = P[MB_FLAGS];
    // left arm re-solve (pose space, before the clip root)
    const float sw = std::clamp(B[MB_SUPPORTW], 0.f, 1.f);
    if (sw < 0.01f || ((int)B[MB_FLAGS] & 64)) return true;
    const float sc = bodyVoxel_;
    auto E = [&](int sl, float o[4]) { eulerXYZToQuat(&B[MB_ROT + sl * 3], o); };
    auto rel = [&](int s, int par, float o[3]) { for (int k3 = 0; k3 < 3; ++k3) o[k3] = (kPivot[s][k3] - kPivot[par][k3]) * sc; };
    float q1[4], q4[4], q5[4], ql[4], t1[3], t4[3], t5[3], r[3], v[3];
    E(1, q1);
    for (int k3 = 0; k3 < 3; ++k3) t1[k3] = kPivot[1][k3] * sc;
    E(4, ql); qmul(q1, ql, q4); rel(4, 1, v); qrotv(q1, v, r); for (int k3 = 0; k3 < 3; ++k3) t4[k3] = t1[k3] + r[k3];
    E(5, ql); qmul(q4, ql, q5); rel(5, 4, v); qrotv(q4, v, r); for (int k3 = 0; k3 < 3; ++k3) t5[k3] = t4[k3] + r[k3];
    float mq[4], qw[4], hand[3] = {0.f, -3.5f * sc, 0.f}, T[3];
    eulerXYZToQuat(&B[MB_MOUNT], mq);
    qmul(q5, mq, qw);
    qrotv(q5, hand, r);
    float st[3] = {B[MB_SUPPORT], B[MB_SUPPORT + 1], B[MB_SUPPORT + 2]};
    if (st[0] == 0.f && st[1] == 0.f && st[2] == 0.f) std::memcpy(st, inf.support, sizeof(st));
    qrotv(qw, st, v);
    for (int k3 = 0; k3 < 3; ++k3) T[k3] = t5[k3] + r[k3] + v[k3];
    float S[3];
    rel(2, 1, v); qrotv(q1, v, r); for (int k3 = 0; k3 < 3; ++k3) S[k3] = t1[k3] + r[k3];
    const float a = 3.5f * sc;
    float D[3] = {T[0] - S[0], T[1] - S[1], T[2] - S[2]}, dl = std::sqrt(D[0] * D[0] + D[1] * D[1] + D[2] * D[2]);
    if (dl < 1e-4f) return true;
    float dir[3] = {D[0] / dl, D[1] / dl, D[2] / dl};
    float d = std::clamp(dl, 1e-3f, 2.f * a * 0.999f);
    float alpha = std::acos(std::clamp(d / (2.f * a), -1.f, 1.f));
    float poleL[3] = {0.6f, -1.f, 0.f}, pole[3];
    qrotv(q1, poleL, pole);
    float n[3] = {dir[1] * pole[2] - dir[2] * pole[1], dir[2] * pole[0] - dir[0] * pole[2], dir[0] * pole[1] - dir[1] * pole[0]};
    float nl = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (nl < 1e-5f) return true;
    float qa2[4] = {n[0] / nl * std::sin(0.5f * alpha), n[1] / nl * std::sin(0.5f * alpha), n[2] / nl * std::sin(0.5f * alpha), std::cos(0.5f * alpha)};
    float U[3], Eb[3], F[3];
    qrotv(qa2, dir, U);
    for (int k3 = 0; k3 < 3; ++k3) Eb[k3] = S[k3] + U[k3] * a;
    float fl = std::sqrt((T[0] - Eb[0]) * (T[0] - Eb[0]) + (T[1] - Eb[1]) * (T[1] - Eb[1]) + (T[2] - Eb[2]) * (T[2] - Eb[2]));
    for (int k3 = 0; k3 < 3; ++k3) F[k3] = (T[k3] - Eb[k3]) / std::max(fl, 1e-5f);
    float down[3] = {0, -1, 0}, q2[4], q3[4], cur[3], arc[4], q2n[4], q3p[4], q3n[4], ql2[4], ql3[4], inv[4];
    E(2, ql); qmul(q1, ql, q2);
    qrotv(q2, down, cur); qarc(cur, U, arc); qmul(arc, q2, q2n);
    E(3, ql); qmul(q2n, ql, q3p);
    qrotv(q3p, down, cur); qarc(cur, F, arc); qmul(arc, q3p, q3n);
    qconj(q1, inv); qmul(inv, q2n, ql2);
    qconj(q2n, inv); qmul(inv, q3n, ql3);
    float o2[4], o3[4];
    E(2, qa); qnlerp(qa, ql2, sw, o2); quatToEulerXYZ(o2, &B[MB_ROT + 2 * 3]);
    E(3, qa); qnlerp(qa, ql3, sw, o3); quatToEulerXYZ(o3, &B[MB_ROT + 3 * 3]);
    (void)q3;
    return true;
}

void MilitaryLab::commitRootMotion(Soldier& so, const MilKeyClip& k) {   // root-motion clip finished: move the agent
    float c = std::cos(so.yaw), s = std::sin(so.yaw);
    so.pos = so.pos + V3{k.delta[0] * c + k.delta[2] * s, k.delta[1], -k.delta[0] * s + k.delta[2] * c};
    so.yaw += k.delta[3];
}

void MilitaryLab::switchClip(Soldier& so, int clip) {
    const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
    if (clip == so.clip || clip < 0 || clip >= (int)inf.clips.size()) return;
    const MilClip* old = so.clip >= 0 && so.clip < (int)inf.clips.size() ? &inf.clips[(size_t)so.clip] : nullptr;
    const MilClip& nw = inf.clips[(size_t)clip];
    bool sync = false;
    float dur = old ? lib_.transitionTime(old->name, nw.name, sync) : 0.f;
    for (float& v : so.prevDelta) v = 0.f;
    if (old && old->keyClip >= 0) {   // a finished one-shot root-motion clip: commit its displacement first
        const MilKeyClip& k = lib_.keyClips[(size_t)old->keyClip];
        if (k.rootMotion && !k.loop && so.t >= k.duration - 1e-3f) { commitRootMotion(so, k); std::memcpy(so.prevDelta, k.delta, sizeof(k.delta)); }
    }
    float phase = old && old->length > 0 ? so.t / old->length : 0.f;
    so.prevClip = so.clip; so.prevT = so.t; so.blend = 0.f; so.blendDur = old ? dur : 0.f;
    so.clip = clip;
    so.t = sync ? std::fmod(phase, 1.f) * nw.length : 0.f;   // locomotion: phase-matched (same foot)
}

// Weapon frame of a sampled soldier on the CPU (forward kinematics torso -> upperArmR -> forearmR, clip root, heading),
// then a weapon-space point: the authored muzzle / ejection port of the POSED weapon. Zombie-clip placeholders: rest.
void MilitaryLab::muzzleFrame(const Soldier& so, const CharU& C, const float mountQ[4], const float wp[3], V3& outP, float outQ[4]) const {
    const float sc = bodyVoxel_;
    const bool explicitPose = C.anim[0] > 8.5f;
    float q[10][4], t[10][3];
    for (int s : {1, 4, 5}) {
        float e[3] = {explicitPose ? C.rot[s][0] : 0.f, explicitPose ? C.rot[s][1] : 0.f, explicitPose ? C.rot[s][2] : 0.f}, ql[4];
        eulerXYZToQuat(e, ql);
        int par = kParent[s];
        if (par < 0) { std::memcpy(q[s], ql, sizeof(ql)); for (int k = 0; k < 3; ++k) t[s][k] = kPivot[s][k] * sc; }
        else {
            qmul(q[par], ql, q[s]);
            float local[3] = {(kPivot[s][0] - kPivot[par][0]) * sc, (kPivot[s][1] - kPivot[par][1]) * sc, (kPivot[s][2] - kPivot[par][2]) * sc}, r[3];
            qrotv(q[par], local, r);
            for (int k = 0; k < 3; ++k) t[s][k] = t[par][k] + r[k];
        }
    }
    float qm[4], tm[3], qy[4], qw[4], tw[3];
    qmul(C.rootQ, q[5], qm);
    qrotv(C.rootQ, t[5], tm);
    for (int k = 0; k < 3; ++k) tm[k] += C.rootPos[k];
    yawQuat(so.yaw, qy);
    qmul(qy, qm, qw);
    qrotv(qy, tm, tw);
    // hand = elbow + (0, -3.5, 0) V in forearm space, weapon = hand * R(mount)
    float hand[3] = {0.f, -3.5f * sc, 0.f}, hr[3], qwep[4], pr[3];
    qrotv(qw, hand, hr);
    qmul(qw, mountQ, qwep);
    qrotv(qwep, wp, pr);
    outP = {so.pos.x + tw[0] + hr[0] + pr[0], so.pos.y + tw[1] + hr[1] + pr[1], so.pos.z + tw[2] + hr[2] + pr[2]};
    std::memcpy(outQ, qwep, sizeof(qwep));
}

void MilitaryLab::spawnFx(int model, V3 p, V3 v, const float q[4], float life, int kind) {
    if (fx_.size() >= kMaxFx || model < 0) return;   // FX budget
    Fx f{model, p, v, {0, 0, 0, 1}, 0.f, life, kind};
    if (q) std::memcpy(f.q, q, sizeof(f.q));
    fx_.push_back(f);
}

// Clip events -> voxel FX (docs/MILITARY_ANIMS.md 6) at the posed weapon.
void MilitaryLab::soldierEvent(const Soldier& so, const CharU& C, const MilFxEvent& e) {
    if (!fxOn_) return;
    const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
    const int* M = lib_.fxModels;
    float mountQ[4] = {0, 0, 0, 1};
    if (C.anim[0] > 8.5f) {
        float B[MB_STRIDE];
        if (sampleBody(so, 0, B)) eulerXYZToQuat(&B[MB_MOUNT], mountQ);
    } else if (inf.weaponAtt >= 0) std::memcpy(mountQ, inf.atts[(size_t)inf.weaponAtt].quat, sizeof(mountQ));
    const std::string kind = !e.fx.empty() ? e.fx : inf.weaponKind.empty() ? std::string("rifle") : inf.weaponKind;
    V3 mp;
    float wq[4];
    muzzleFrame(so, C, mountQ, inf.muzzleW, mp, wq);
    float fwdL[3] = {0, 0, 1}, fwd[3];
    qrotv(wq, fwdL, fwd);
    V3 dir{fwd[0], fwd[1], fwd[2]};
    if (e.type == "muzzle_flash") {
        if (kind == "sniper") return;   // suppressed: the `suppressed` event makes the puff
        if (kind == "mg") {
            float qz[4] = {0, 0, std::sin(kPi / 8.f), std::cos(kPi / 8.f)}, q2[4];   // alternate rounds: star rotated 45 deg, 0.8 scale
            qmul(wq, qz, q2);
            bool alt = (mgRound_++ & 1) != 0;
            spawnFx(M[alt ? MilitaryLibrary::FX_FLASH_MG_SMALL : MilitaryLibrary::FX_FLASH_MG], mp, {}, alt ? q2 : wq, 2.f / 30.f, 0);
            if (flashes_.size() < 64) flashes_.push_back({mp, 2.f / 30.f, 3.f});
        } else {
            spawnFx(M[MilitaryLibrary::FX_FLASH_RIFLE], mp, {}, wq, 1.f / 30.f, 0);
            spawnFx(M[MilitaryLibrary::FX_FLASH_RIFLE_HALF], mp, {}, wq, 2.f / 30.f, 0);
            if (flashes_.size() < 64) flashes_.push_back({mp, 1.f / 30.f, 2.f});
        }
    } else if (e.type == "tracer") {
        spawnFx(M[MilitaryLibrary::FX_TRACER], mp + dir * 0.6f, dir * 600.f, wq, 0.07f, 3);   // a streak that persists ~4 frames
    } else if (e.type == "shell_eject") {
        float port[3], pv[3];
        ejectPort(kind, port);
        V3 pp;
        float q2[4];
        muzzleFrame(so, C, mountQ, port, pp, q2);
        uint32_t h = (uint32_t)fx_.size() * 2654435761u + (uint32_t)(so.pos.x * 100.f);
        float v[3] = {-2.0f * (0.8f + 0.4f * hashf(h)), 1.2f * (0.8f + 0.4f * hashf(h + 1)), -0.3f * (0.8f + 0.4f * hashf(h + 2))};
        qrotv(q2, v, pv);
        spawnFx(M[MilitaryLibrary::FX_CASING], pp, {pv[0], pv[1], pv[2]}, q2, 0.6f, 1);
    } else if (e.type == "suppressed") {
        for (int k = 0; k < 4; ++k) {
            V3 off{(hashf(k * 3u + 1u) - 0.5f) * 0.04f, (hashf(k * 3u + 2u) - 0.5f) * 0.04f, (hashf(k * 3u + 3u) - 0.5f) * 0.04f};
            spawnFx(M[MilitaryLibrary::FX_PUFF_S], mp + off + dir * 0.03f, dir * 0.5f + V3{0, 0.2f, 0}, nullptr, 0.35f, 2);
        }
    } else if (e.type == "footstep" || e.type == "body_fall") {
        int n = e.type == "footstep" ? 2 : 6;
        for (int k = 0; k < n; ++k) {
            float a = hashf((uint32_t)fx_.size() + k * 11u) * 2.f * kPi, r = e.type == "footstep" ? 0.12f : 0.5f;
            spawnFx(M[MilitaryLibrary::FX_DUST], {so.pos.x + std::cos(a) * r, so.pos.y, so.pos.z + std::sin(a) * r}, {std::cos(a) * 0.4f, 0.5f, std::sin(a) * 0.4f},
                    nullptr, e.type == "footstep" ? 0.25f : 0.4f, 2);
        }
    }
}

void MilitaryLab::triggerFx(const std::string& type) {   // FX buttons: the selected (turntable) soldier
    if (selKind_ != 0 || selIndex_ >= (int)lib_.infantry.size()) return;
    Soldier so;
    so.inf = selIndex_; so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f); so.clip = clip_; so.t = animTime_;
    CharU C;
    float mq[4];
    sampleSoldier(so, C, mq, 0);
    const std::string kind = lib_.infantry[(size_t)selIndex_].weaponKind;
    if (type == "shot") {
        for (const char* ev : {"muzzle_flash", "tracer", "shell_eject"}) soldierEvent(so, C, {0, ev, kind});
        if (kind == "sniper") soldierEvent(so, C, {0, "suppressed", kind});
    } else soldierEvent(so, C, {0, type, kind});
}

// One soldier -> GPU record + its parts into the per-mesh buckets. LOD: small gear dropped beyond LOD0.
void MilitaryLab::pushSoldier(const Soldier& so, int lod, CharU* out) {
    if (charsU_.size() >= kMaxChars) return;
    const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
    CharU C;
    float mountQ[4];
    sampleSoldier(so, C, mountQ, lod);
    if (out) *out = C;
    const uint32_t ci = (uint32_t)charsU_.size();
    charsU_.push_back(C);
    for (size_t a = 0; a < inf.atts.size(); ++a) {
        const MilAttachment& A = inf.atts[a];
        if (A.model < 0 || A.fx) continue;
        if (lod >= 1 && smallGear(A.name)) continue;
        AttU O{};
        O.info[0] = ci; O.info[1] = (uint32_t)A.slot;
        std::memcpy(O.offset, A.offset, sizeof(A.offset));
        std::memcpy(O.quat, (int)a == inf.weaponAtt ? mountQ : A.quat, sizeof(float) * 4);
        if ((int)a == inf.weaponAtt && C.anim[0] > 8.5f && (((int)C.anim[3]) & MB_FLAG_DROPPED)) {   // released (death clips): own track
            const MilClip& mc = inf.clips[(size_t)so.clip];
            float W[MW_STRIDE];
            if (mc.keyClip >= 0 && mc.keyClip < (int)lib_.keyClips.size() && lib_.keyClips[(size_t)mc.keyClip].sampleWeapon(so.t, W)) {
                float qy[4], qr[4], q[4], pr[3];
                yawQuat(so.yaw, qy);
                eulerXYZToQuat(&W[MW_ROT], qr);
                qmul(qy, qr, q);
                qrotv(qy, &W[MW_POS], pr);
                putInst(A.model, {so.pos.x + pr[0], so.pos.y + pr[1], so.pos.z + pr[2]}, q);
                continue;
            }
        }
        if ((int)a == inf.weaponAtt && C.anim[0] > 8.5f && (((int)C.anim[3]) & MB_FLAG_SLUNG)) {   // slung: torso * T(grip) * R(rot)
            for (const MilitaryLibrary::Slung& sm : lib_.slungMounts)
                if (sm.cls == inf.cls) {
                    O.info[1] = 1;
                    for (int k = 0; k < 3; ++k) O.offset[k] = sm.grip[k] / bodyVoxel_;
                    eulerXYZToQuat(sm.rot, O.quat);
                }
        }
        attBuckets_[(size_t)A.model].push_back(O);
    }
    const int item = C.anim[0] > 8.5f ? ((int)C.anim[3] & 15) : 0;   // hand item at the left hand: (0, -3.5, 0) V in forearmL space
    if (item > 0 && item < 6 && lib_.handItemModels[item] >= 0) {
        AttU O{};
        O.info[0] = ci; O.info[1] = 3;
        O.offset[1] = -3.5f; O.quat[3] = 1.f;
        attBuckets_[(size_t)lib_.handItemModels[item]].push_back(O);
    }
    ++st_.lod[std::min(lod, 2)];
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
    for (Drop& d : drops_) {
        const MilInfantry* inf = d.inf < (int)lib_.infantry.size() ? &lib_.infantry[(size_t)d.inf] : nullptr;
        const std::string cls = d.cargo ? "crate" : (inf ? inf->cls : "");
        int cDesc = lib_.findClip(cls, d.cargo ? "descent" : "para_descent"), cLand = lib_.findClip(cls, d.cargo ? "land" : "para_land");
        int cRec = d.cargo ? -1 : lib_.findClip(cls, "para_recover");
        float speed = cDesc >= 0 ? std::max(1.f, lib_.keyClips[(size_t)cDesc].descentSpeed) : 5.f;
        float prev = d.t;
        d.t += dt;
        if (d.groundT >= 0.f) d.groundT += dt;
        const MilKeyClip* cur = d.phase == 0 ? (cDesc >= 0 ? &lib_.keyClips[(size_t)cDesc] : nullptr)
                              : d.phase == 1 ? (cLand >= 0 ? &lib_.keyClips[(size_t)cLand] : nullptr)
                              : d.phase == 2 ? (cRec >= 0 ? &lib_.keyClips[(size_t)cRec] : nullptr) : nullptr;
        if (cur && d.phase > 0)
            for (const MilFxEvent& e : cur->events)
                if (e.t > prev && e.t <= d.t) {
                    if (e.type == "harness_release" && !d.released) {   // the canopy stays where it lies
                        d.released = true;
                        const MilKeyClip* land = cLand >= 0 ? &lib_.keyClips[(size_t)cLand] : nullptr;
                        if (!(cur->sampleCanopy(d.t, d.relCanopy)) && land) land->sampleCanopy(land->duration, d.relCanopy);
                        d.relPos = d.xz;
                    }
                    if (e.type == "canopy_ground" && d.groundT < 0.f) d.groundT = d.t - e.t;   // canopy settled: dissolve clock
                    if ((e.type == "canopy_ground" || e.type == "crate_touch" || e.type == "touchdown") && fxOn_)
                        for (int k = 0; k < 8; ++k) {
                            float a = k * kPi / 4.f;
                            spawnFx(lib_.fxModels[MilitaryLibrary::FX_DUST_L], {d.xz.x + std::cos(a) * 1.2f, d.xz.y, d.xz.z + std::sin(a) * 1.2f},
                                    {std::cos(a) * 0.6f, 0.4f, std::sin(a) * 0.6f}, nullptr, 0.5f, 2);
                        }
                }
        if (d.phase == 0) {
            d.alt = d.startH - speed * d.t;
            if (d.alt <= 0.f) { d.alt = 0.f; d.phase = 1; d.t = 0.f; }
        } else if (d.phase == 1) {
            if (!cur || d.t >= cur->duration) {
                if (!d.cargo && cur) { cur->sampleCanopy(cur->duration, d.relCanopy); }
                d.phase = d.cargo ? 3 : 2; d.t = 0.f;
            }
        } else if (d.phase == 2) {
            if (!cur || d.t >= cur->duration) { d.phase = 3; d.t = 0.f; }
        } else if (d.t > 6.f) { d.phase = 0; d.t = 0.f; d.released = false; d.groundT = -1.f; }   // demo loop: drop again
        (void)s;
    }
}

void MilitaryLab::drawDrop(const Drop& d) {
    const MilInfantry* inf = d.inf < (int)lib_.infantry.size() ? &lib_.infantry[(size_t)d.inf] : nullptr;
    const std::string cls = d.cargo ? "crate" : (inf ? inf->cls : "");
    int cDesc = lib_.findClip(cls, d.cargo ? "descent" : "para_descent"), cLand = lib_.findClip(cls, d.cargo ? "land" : "para_land");
    int cRec = d.cargo ? -1 : lib_.findClip(cls, "para_recover");
    int clipIdx = d.phase == 0 ? cDesc : d.phase == 1 ? cLand : d.phase == 2 ? cRec : (d.cargo ? cLand : cRec);
    const MilKeyClip* kc = clipIdx >= 0 ? &lib_.keyClips[(size_t)clipIdx] : nullptr;
    float t = d.phase == 3 ? (kc ? kc->duration : 0.f) : d.t;
    V3 agent{d.xz.x, d.xz.y + (d.phase == 0 ? d.alt : 0.f), d.xz.z};
    float qy[4];
    yawQuat(d.yaw, qy);
    auto findProp = [&](const char* name) -> const MilProp* {
        for (const MilProp& p : lib_.props) if (p.name == name) return &p;
        return nullptr;
    };
    // body / crate
    if (!d.cargo && inf) {
        Soldier so;
        so.inf = d.inf; so.pos = agent; so.yaw = d.yaw; so.t = t;
        so.clip = -1;
        for (size_t i = 0; i < inf->clips.size(); ++i) if (clipIdx >= 0 && inf->clips[i].keyClip == clipIdx) so.clip = (int)i;
        if (so.clip < 0 || d.phase == 3) { so.clip = std::max(0, clipByAction(*inf, "idle")); so.t = d.t; }
        pushSoldier(so, 0);
    } else if (d.cargo) {
        const MilProp* crate = findProp("crate_ammo_drop");
        float C6[6] = {0, 0, 0, 0, 0, 0};
        if (kc) kc->sampleCrate(t, C6);
        float qr[4], q[4], pr[3];
        eulerXYZToQuat(&C6[3], qr);
        qmul(qy, qr, q);
        qrotv(qy, C6, pr);
        V3 base{agent.x + pr[0], agent.y + pr[1], agent.z + pr[2]};
        if (crate) for (const auto& [m, pv] : crate->parts) { float o[3]; qrotv(q, pv.data(), o); putInst(m, {base.x + o[0], base.y + o[1], base.z + o[2]}, q); }
        else putInst(lib_.dropCrateModel, base, q);
    }
    // canopy (deformed: radial / height scale about the pivot, soft ground clamp)
    float Cn[MC_STRIDE] = {0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0};
    V3 origin = agent;
    if (d.released || (!d.cargo && d.phase >= 2)) { std::memcpy(Cn, d.relCanopy, sizeof(Cn)); origin = d.xz; if (Cn[MC_RADIAL] == 0.f) return; }
    else if (!kc || !kc->sampleCanopy(t, Cn)) {   // no canopy track: hang above the load / harness point while airborne
        Cn[MC_POS + 1] = d.cargo ? 0.9f : (inf ? inf->paraSocket[1] : 1.37f);
        Cn[MC_VISIBLE] = d.phase == 0 ? 1.f : 0.f;
    }
    if (Cn[MC_VISIBLE] < 0.5f) return;
    // after canopy_ground: hold kCanopyHold s, then dissolve voxel by voxel over kCanopyDissolve s (canopy + lines), removed
    const float dis = d.groundT < 0.f ? 0.f : std::clamp((d.groundT - kCanopyHold) / kCanopyDissolve, 0.f, 1.f);
    if (dis >= 1.f) return;
    const MilProp* para = findProp(d.cargo ? "para_cargo" : "para_infantry");
    float qr[4], q[4], pr[3];
    eulerXYZToQuat(&Cn[MC_ROT], qr);
    qmul(qy, qr, q);
    qrotv(qy, &Cn[MC_POS], pr);
    V3 pivot{origin.x + pr[0], origin.y + pr[1], origin.z + pr[2]};
    uint32_t sh = (uint32_t)packHalf(Cn[10]) | ((uint32_t)packHalf(Cn[11]) << 16);   // shear x, z (half2)
    float shf;
    std::memcpy(&shf, &sh, 4);
    float paint[4] = {Cn[MC_RADIAL], Cn[MC_HEIGHT], shf, Cn[MC_CLAMP] > 0.5f ? d.xz.y : -1e4f};
    if (para)
        for (const auto& [m, pv] : para->parts) {   // own draws: per-drop clamp (roof footprint, street outside)
            Inst gi{};
            gi.pos[0] = pivot.x; gi.pos[1] = pivot.y; gi.pos[2] = pivot.z; gi.pos[3] = 2.f + 0.9f * dis;   // kind 2 + dissolve (city.vert)
            std::memcpy(gi.quat, q, sizeof(gi.quat));
            std::memcpy(gi.paint, paint, sizeof(gi.paint));
            CityRenderer::ExtDraw ed{&meshes_[(size_t)m], (uint32_t)canopyInst_.size(), 1};
            std::memcpy(ed.clamp, d.clamp, sizeof(ed.clamp));
            canopyDraws_.push_back(ed);
            canopyInst_.push_back(gi);
        }
    else putInst(lib_.chuteOpenModel, pivot, q);
}

// ---------------------------------------------------------------------------------------------------------------
void MilitaryLab::putInst(int model, V3 p, const float q[4], const CityRenderer::GpuMesh* mesh, int kind, const float* paint) {
    Inst gi{};
    gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = (float)kind;
    std::memcpy(gi.quat, q, sizeof(gi.quat));
    if (paint) std::memcpy(gi.paint, paint, sizeof(gi.paint));
    if (mesh) {   // civilian vehicle models: city palette, drawn separately
        vehDraws_.push_back({mesh, (uint32_t)vehInst_.size(), 1});
        vehInst_.push_back(gi);
        return;
    }
    if (model < 0 || model >= (int)instBuckets_.size()) return;
    instBuckets_[(size_t)model].push_back(gi);
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
        for (size_t m = 0; m < instBuckets_.size(); ++m) {
            if (instBuckets_[m].empty()) continue;
            const auto& b = meshBounds_[m];
            if (b[4] - b[1] < 0.15f || b[3] - b[0] > 30.f) continue;   // flat helpers (grid), huge
            for (const Inst& gi : instBuckets_[m]) {
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
            bench_.push_back({presets[(size_t)benchPreset_], avg, pct(benchFrames_, 0.95), cpu, st_.visible, st_.instances, st_.draws, st_.fx, st_.tris, st_.upload,
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
        if (benchPreset_ >= 0 && benchFrame_ > 45) { benchFrames_.push_back(frameMs); benchCpu_.push_back(st_.cpuMs); }
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
                    sel_ = Soldier{}; sel_.inf = selIndex_; sel_.clip = clip_; sel_.t = animTime_;
                    if (v.find("+freeze") != std::string::npos) playing_ = false;   // hold exactly this clip time
                }
                if (const char* p = opt("+drop=")) {   // every drop to a sequence time (30 Hz steps, events included)
                    float T = (float)std::atof(p);
                    for (Drop& d : drops_) { d.phase = 0; d.t = 0.f; d.alt = 0.f; d.released = false; d.groundT = -1.f; };
                    for (float tt = 0.f; tt < T; tt += 1.f / 30.f) updateDrops(s, std::min(1.f / 30.f, T - tt));
                    fx_.clear();
                }
                holdFx_ = v.find("+hold") != std::string::npos;
                if (v.find("+seq") != std::string::npos) { seq_ = true; seqT_ = 0.f; seqIdx_ = 0; playing_ = true; loop_ = true; }
                if (v.find("+fire") != std::string::npos) { fx_.clear(); flashes_.clear(); triggerFx("shot"); }
                applyView(s, name);
                SDL_Log("military lab: shot %zu at frame %d: view %s", k, s.opt.shotFrames[k], v.c_str());
                s.cityRenderer.flush(s.camera, (float)s.opt.width / (float)std::max(1, s.opt.height));
            }
    }
    if (turntable_) turnAngle_ = std::fmod(turnAngle_ + dt * 0.6f, 2.f * kPi);
    const float fdt = holdFx_ ? 0.f : dt;

    // camera frustum (per-soldier culling) and eye (LOD)
    {
        float aspect = (float)s.opt.width / (float)std::max(1, s.opt.height);
        if (s.window) { int w, h; SDL_GetWindowSize(s.window, &w, &h); aspect = (float)w / (float)std::max(1, h); }
        M4 vp = mul(s.camera.proj(aspect), s.camera.view());
        const float* m = vp.m;   // column-major: row r = m[r], m[4 + r], m[8 + r], m[12 + r]
        auto row = [&](int r, int k) { return m[k * 4 + r]; };
        for (int i = 0; i < 6; ++i) {
            float p[4];
            for (int k = 0; k < 4; ++k) {
                float r3 = row(3, k);
                p[k] = i == 0 ? r3 + row(0, k) : i == 1 ? r3 - row(0, k) : i == 2 ? r3 + row(1, k) : i == 3 ? r3 - row(1, k) : i == 4 ? row(2, k) : r3 - row(2, k);
            }
            float l = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
            for (int k = 0; k < 4; ++k) frustum_[i][k] = p[k] / l;
        }
        eye_ = s.camera.eye();
    }
    auto visibleAt = [&](V3 p, float r) {
        for (auto& pl : frustum_) if (pl[0] * p.x + pl[1] * (p.y + 0.9f) + pl[2] * p.z + pl[3] < -r) return false;
        return true;
    };
    auto lodAt = [&](V3 p) { float d = length(p - eye_); return d < 70.f ? 0 : d < 180.f ? 1 : 2; };

    charsU_.clear();
    for (auto& b : attBuckets_) b.clear();
    for (auto& b : instBuckets_) b.clear();
    vehDraws_.clear(); vehInst_.clear(); canopyDraws_.clear(); canopyInst_.clear();
    st_ = Stats{};
    if (!dropsPlaced_ && (int)s.frameIndex >= (s.opt.headless ? 1 : 30)) placeDrops(s);

    // clip playback with events (fired when the playhead crosses t, also on loop wrap)
    auto advance = [&](Soldier& so, float step, bool events, int lod) {
        const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
        if (so.clip < 0 || so.clip >= (int)inf.clips.size()) return;
        const MilClip& c = inf.clips[(size_t)so.clip];
        float prev = so.t, len = std::max(1.f / 30.f, c.length);
        so.t += step * so.rate;
        bool wrapped = false;
        if (so.t > len) { if (c.loop) { so.t = std::fmod(so.t, len); wrapped = true; } else so.t = len; }
        if (so.prevClip >= 0) {   // cross-fade: the previous clip keeps playing underneath
            so.blend += step * so.rate;
            const MilClip& pc = inf.clips[(size_t)so.prevClip];
            so.prevT += step * so.rate;
            if (so.prevT > pc.length) so.prevT = pc.loop ? std::fmod(so.prevT, std::max(1.f / 30.f, pc.length)) : pc.length;
            if (so.blend >= so.blendDur) { so.prevClip = -1; so.blendDur = 0.f; }
        }
        if (c.keyClip < 0) return;
        const MilKeyClip& k = lib_.keyClips[(size_t)c.keyClip];
        if (k.rootMotion && wrapped) commitRootMotion(so, k);   // looping root motion: displacement per cycle
        if (so.mover && !k.rootMotion && k.speed > 0.f && step > 0.f) {   // in-place locomotion: the agent moves at the clip speed
            V3 f{std::sin(so.yaw), 0.f, std::cos(so.yaw)};
            V3 np = so.pos + f * (k.speed * step * so.rate);
            V3 look = np + f * 0.9f;
            if (rasterHeight(s, look.x, look.z) > 0.3f || length(np - so.home) > 14.f)
                so.yaw = std::atan2(so.home.x - so.pos.x, so.home.z - so.pos.z) + 0.4f * (hashf((uint32_t)(so.pos.x * 31.f)) - 0.5f);   // turn back
            else so.pos = np;
        }
        if (!events || step <= 0.f || lod >= 2) return;   // no FX beyond LOD1 (a few pixels)
        auto crossed = [&](float et) { return wrapped ? (et > prev || et <= so.t) : (et > prev && et <= so.t); };
        bool any = false;
        for (const MilFxEvent& e : k.events) if (crossed(e.t)) { any = true; break; }
        if (!any) return;
        CharU C;
        float mq[4];
        sampleSoldier(so, C, mq, 0);
        for (const MilFxEvent& e : k.events) if (crossed(e.t)) soldierEvent(so, C, e);
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
        if (so.inf != selIndex_) { so = Soldier{}; so.inf = selIndex_; so.clip = clip_; so.t = animTime_; }
        so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f);
        if (std::fabs(animTime_ - so.t) > 1e-4f) so.t = animTime_;   // scrubbed in the UI
        switchClip(so, clip_);                                       // cross-fade on clip changes
        const MilClip& c = inf.clips[(size_t)clip_];
        if (playing_ && c.available) {
            advance(so, fdt * animSpeed_, true, 0);
            if (!c.loop && so.t >= c.length) { if (loop_) so.t = 0.f; else if (!seq_) playing_ = false; }
        }
        so.pos = world(0, 0); so.yaw = worldYaw(turntable_ ? turnAngle_ : 0.f);   // the turntable spot stays put
        animTime_ = so.t;
        pushSoldier(so, 0);
    }
    if (showLineup_)
        for (Soldier& so : lineup_) {
            if (lineupAnimated_ && clip_ < (int)lib_.infantry[(size_t)so.inf].clips.size()) so.clip = clip_;
            advance(so, fdt, false, 0);
            if (visibleAt(so.pos, 1.2f)) pushSoldier(so, lodAt(so.pos));
        }
    // stress soldiers: scripted cycle idle -> walk -> run -> aim -> fire -> reload (-> death)
    static const char* kScript[] = {"idle", "walk", "run", "aim", "fire", "reload", "death"};
    static const float kDur[] = {3.f, 5.f, 3.f, 1.f, 4.f, 0.f, 0.f};
    for (size_t i = 0; i < stress_.size(); ++i) {
        Soldier& so = stress_[i];
        const MilInfantry& inf = lib_.infantry[(size_t)so.inf];
        so.stateLeft -= fdt;
        if (so.stateLeft <= 0.f) {
            so.script = (so.script + 1) % 7;
            if (so.script == 6 && hashf((uint32_t)i * 97u + (uint32_t)(s.renderTime * 3.0)) > 0.25f) so.script = 0;   // 25 % die
            int c = clipByAction(inf, kScript[so.script]);
            if (c < 0) c = std::max(0, clipByAction(inf, "idle"));
            switchClip(so, c);
            float len = inf.clips[(size_t)c].length;
            so.stateLeft = kDur[so.script] > 0.f ? kDur[so.script] : len + (so.script == 6 ? 3.f : 0.f);
        }
        int lod = lodAt(so.pos);
        advance(so, fdt, true, lod);
        ++st_.soldiers;
        if (visibleAt(so.pos, 1.2f)) pushSoldier(so, lod);
    }

    // parachute drops
    if (showDrops_) {
        updateDrops(s, fdt);
        for (const Drop& d : drops_) drawDrop(d);
    }

    // FX particles
    for (Fx& f : fx_) {
        f.age += fdt;
        if (f.kind == 1) {   // casing: gravity, one bounce on the surface below
            f.v.y -= 9.81f * fdt;
            f.p = f.p + f.v * fdt;
            float g = rasterHeight(s, f.p.x, f.p.z);
            g = g < 90.f ? g : 0.f;
            if (f.p.y < g + 0.015f && f.v.y < 0) { f.p.y = g + 0.015f; f.v = {f.v.x * 0.4f, -f.v.y * 0.3f, f.v.z * 0.4f}; }
        } else if (f.kind == 2 || f.kind == 3) f.p = f.p + f.v * fdt;
    }
    fx_.erase(std::remove_if(fx_.begin(), fx_.end(), [](const Fx& f) { return f.age >= f.life; }), fx_.end());
    for (Flash& fl : flashes_) fl.life -= fdt;
    flashes_.erase(std::remove_if(flashes_.begin(), flashes_.end(), [](const Flash& f) { return f.life <= 0.f; }), flashes_.end());
    for (const Fx& f : fx_) {
        int model = f.model;
        if (f.kind == 2 && model == lib_.fxModels[MilitaryLibrary::FX_PUFF_S]) {   // puffs grow in voxel steps 0.04 -> 0.07 m
            float a = f.age / f.life;
            model = lib_.fxModels[a < 0.33f ? MilitaryLibrary::FX_PUFF_S : a < 0.66f ? MilitaryLibrary::FX_PUFF_M : MilitaryLibrary::FX_PUFF_L];
        }
        putInst(model, f.p, f.q);
    }
    st_.fx = (uint32_t)fx_.size();

    // props, helpers, comparison vehicles
    auto putProp = [&](const MilProp& p, float lx, float lz, float localYaw) {
        float q[4];
        yawQuat(worldYaw(localYaw), q);
        V3 o = world(lx, lz);
        if (p.parts.empty()) { putInst(p.model, o, q); return; }
        for (const auto& [m, pv] : p.parts) { float r[3]; qrotv(q, pv.data(), r); putInst(m, {o.x + r[0], o.y + r[1], o.z + r[2]}, q); }
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
    if (showGrid_ && lib_.gridModel >= 0) putYaw(lib_.gridModel, world(0, 0), worldYaw(0));
    if (showRuler_ && lib_.rulerModel >= 0) {
        putYaw(lib_.rulerModel, world(1.4f, 0.3f), worldYaw(0));
        putYaw(lib_.rulerModel, world(-12.f, kLineupZ + 0.6f), worldYaw(0));
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
            putInst(-1, world(x + 0.5f * len, kLineupZ - 0.3f), q, m, 0);
            x += len + 0.6f;
        }
    }
    if (shadowsDirty_) rebuildShadows(s);

    // finalize: parts sorted by mesh (one instanced draw per mesh), then CPU instances by mesh, then vehicles
    atts_.clear();
    draws_.clear();
    for (size_t m = 0; m < attBuckets_.size(); ++m) {
        auto& b = attBuckets_[m];
        if (b.empty()) continue;
        size_t n = std::min(b.size(), (size_t)kMaxAtts - atts_.size());
        if (!n) break;
        draws_.push_back({&meshes_[m], (uint32_t)atts_.size(), (uint32_t)n});
        st_.tris += (uint64_t)meshTris_[m] * n;
        atts_.insert(atts_.end(), b.begin(), b.begin() + (long)n);
    }
    cpuInst_.clear();
    const uint32_t base = (uint32_t)atts_.size();
    for (size_t m = 0; m < instBuckets_.size(); ++m) {
        auto& b = instBuckets_[m];
        if (b.empty()) continue;
        size_t n = std::min(b.size(), (size_t)kMaxCpuInst - vehInst_.size() - cpuInst_.size());
        if (!n) break;
        draws_.push_back({&meshes_[m], base + (uint32_t)cpuInst_.size(), (uint32_t)n});
        st_.tris += (uint64_t)meshTris_[m] * n;
        cpuInst_.insert(cpuInst_.end(), b.begin(), b.begin() + (long)n);
    }
    for (auto d : canopyDraws_) { d.first += base + (uint32_t)cpuInst_.size(); draws_.push_back(d); }
    cpuInst_.insert(cpuInst_.end(), canopyInst_.begin(), canopyInst_.end());
    for (auto& d : vehDraws_) d.first += base + (uint32_t)cpuInst_.size();
    cpuInst_.insert(cpuInst_.end(), vehInst_.begin(), vehInst_.end());
    placeholderChars_ = lib_.placeholder ? std::min<uint32_t>((uint32_t)charsU_.size(), kMaxPlaceholderChars) : 0u;
    st_.visible = (uint32_t)charsU_.size();
    st_.instances = (uint32_t)(atts_.size() + cpuInst_.size());
    st_.draws = (uint32_t)(draws_.size() + vehDraws_.size()) + (placeholderChars_ ? 1u : 0u);
    st_.upload = charsU_.size() * sizeof(CharU) + atts_.size() * sizeof(AttU) + cpuInst_.size() * sizeof(Inst);
    st_.cpuMs = msNowLab() - t0;
}

void MilitaryLab::injectLights(std::vector<PointLight>& lights) const {
    // muzzle flash lights (1-2 frames), nearest to the camera first, at most kMaxFlashLights
    std::vector<const Flash*> fl;
    for (const Flash& f : flashes_) fl.push_back(&f);
    std::sort(fl.begin(), fl.end(), [&](const Flash* a, const Flash* b) { return length(a->p - eye_) < length(b->p - eye_); });
    for (size_t k = 0; k < fl.size() && k < kMaxFlashLights; ++k) {
        if (lights.size() >= (size_t)kMaxLights) lights.pop_back();
        lights.insert(lights.begin(), PointLight{fl[k]->p.x, fl[k]->p.y, fl[k]->p.z, fl[k]->radius, 1.f, 0.85f, 0.5f, 1.4f});
    }
}

void MilitaryLab::prepare(SDL_GPUCommandBuffer* cmd) {
    if (!gpu_) return;
    const uint32_t cb = (uint32_t)(charsU_.size() * sizeof(CharU)), ab = (uint32_t)(atts_.size() * sizeof(AttU)),
                   ib = (uint32_t)(cpuInst_.size() * sizeof(Inst));
    if (cb + ab + ib == 0) return;
    uint8_t* dst = (uint8_t*)SDL_MapGPUTransferBuffer(gpu_->device(), tb_, true);
    if (cb) std::memcpy(dst, charsU_.data(), cb);
    if (ab) std::memcpy(dst + cb, atts_.data(), ab);
    if (ib) std::memcpy(dst + cb + ab, cpuInst_.data(), ib);
    SDL_UnmapGPUTransferBuffer(gpu_->device(), tb_);
    SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
    if (cb) { SDL_GPUTransferBufferLocation s{tb_, 0}; SDL_GPUBufferRegion r{charBuf_, 0, cb}; SDL_UploadToGPUBuffer(cp, &s, &r, true); }
    if (ab) { SDL_GPUTransferBufferLocation s{tb_, cb}; SDL_GPUBufferRegion r{attBuf_, 0, ab}; SDL_UploadToGPUBuffer(cp, &s, &r, true); }
    if (ib) {
        SDL_GPUTransferBufferLocation s{tb_, cb + ab};
        SDL_GPUBufferRegion r{insts_, (uint32_t)(atts_.size() * sizeof(Inst)), ib};
        SDL_UploadToGPUBuffer(cp, &s, &r, true);
    }
    SDL_EndGPUCopyPass(cp);
    if (!charsU_.empty()) {
        struct { uint32_t cfg[4]; float params[4]; } u{{(uint32_t)charsU_.size(), placeholderChars_, 0, 0}, {bodyVoxel_, 0, 0, 0}};
        dispatch(Dispatch{cmd, pPose_, {charBuf_}, {joints_, segs_}, &u, sizeof(u)}, ((uint32_t)charsU_.size() + 63) / 64);
        if (!atts_.empty()) {
            u.cfg[0] = (uint32_t)atts_.size();
            dispatch(Dispatch{cmd, pAttach_, {attBuf_, joints_}, {insts_}, &u, sizeof(u)}, ((uint32_t)atts_.size() + 63) / 64);
        }
    }
}

void MilitaryLab::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH) {
    if (!gpu_) return;
    if (placeholderChars_) {
        chars_->setShadowField(shadow);
        chars_->drawExternal(cmd, pass, *sim_, segs_, placeholderChars_ * 10);
    }
    city_->drawExternal(pass, cmd, mats_, insts_, decals, shadow, corpseH, draws_);
    city_->drawExternal(pass, cmd, city_->materials(), insts_, decals, shadow, corpseH, vehDraws_);
}

void MilitaryLab::drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd) {
    if (!gpu_) return;
    if (placeholderChars_) chars_->drawExternal(cmd, pass, *sim_, segs_, placeholderChars_ * 10, true);
    city_->drawExternalShadow(pass, cmd, insts_, draws_);
    city_->drawExternalShadow(pass, cmd, insts_, vehDraws_);
}

// ---------------------------------------------------------------------------------------------------------------
void MilitaryLab::drawUI(AppState& s) {
    const float fs = ImGui::GetIO().FontGlobalScale;
    {   // stats overlay
        ImGui::SetNextWindowPos(ImVec2(12.f, 12.f), ImGuiCond_FirstUseEver);
        ImGui::SetNextWindowBgAlpha(0.6f);
        ImGui::Begin("Lab stats", nullptr, ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoFocusOnAppearing);
        ImGui::Text("frame %.2f ms (CPU, app)  lab CPU %.3f ms", s.cpuFrame.avg, st_.cpuMs);
        ImGui::Text("stress soldiers %u, posed %u  LOD %u / %u / %u", st_.soldiers, st_.visible, st_.lod[0], st_.lod[1], st_.lod[2]);
        ImGui::Text("lab instances %u  draws %u  tris %.2f M  FX %u", st_.instances, st_.draws, st_.tris / 1e6, st_.fx);
        ImGui::Text("upload %.0f KB/frame  GPU %.0f MB  zombies %u", st_.upload / 1024.0, s.gpu.gpuBytesAllocated() / 1048576.0, s.sim.stats().live);
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
        ImGui::Checkbox("FX from clip events", &fxOn_);
        ImGui::SameLine(); ImGui::Checkbox("freeze", &holdFx_);
        if (ImGui::Button("shot (flash + tracer + casing)")) triggerFx("shot");
        ImGui::SameLine(); if (ImGui::Button("suppressed puff")) triggerFx("suppressed");
        if (ImGui::Button("muzzle flash")) triggerFx("muzzle_flash");
        ImGui::SameLine(); if (ImGui::Button("tracer")) triggerFx("tracer");
        ImGui::SameLine(); if (ImGui::Button("casing")) triggerFx("shell_eject");
        ImGui::TextDisabled("budget: %u / %u FX voxels, %u flash lights max", st_.fx, kMaxFx, kMaxFlashLights);
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
