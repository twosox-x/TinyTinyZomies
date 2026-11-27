// MilitaryRenderer (WS-B): the military asset GPU path, extracted from MilitaryLab without behaviour changes (the
// lab's review captures are pixel-identical before / after). See MilitaryRenderer.h.
#include "lab/MilitaryRenderer.h"

#include "gpu/GpuContext.h"
#include "render/Camera.h"
#include "render/CharacterRenderer.h"
#include "render/Renderer.h"
#include "sim/CrowdSim.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr uint32_t kMaxPlaceholderChars = 64;
constexpr float kPi = 3.14159265f;
constexpr float kCanopyHold = 2.5f, kCanopyDissolve = 2.5f;   // parachute canopies after canopy_ground (MILITARY_ANIMS.md 2.3.3)
static_assert(sizeof(MilitaryRenderer::CharU) == 240 && sizeof(MilitaryRenderer::AttU) == 48);
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
std::string dataPathMil(const std::string& rel) {   // cwd, next to the executable, then the source tree
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
float srgbToLinear(float s) { return s <= 0.04045f ? s / 12.92f : std::pow((s + 0.055f) / 1.055f, 2.4f); }
} // namespace

bool MilitaryRenderer::init(GpuContext& gpu, CityRenderer& city, CharacterRenderer& chars, const CrowdSim& sim, float bodyVoxel) {
    gpu_ = &gpu;
    city_ = &city;
    chars_ = &chars;
    sim_ = &sim;
    bodyVoxel_ = bodyVoxel;
    if (!lib_.load(dataPathMil("assets/military"), bodyVoxel_)) lib_.buildPlaceholders(bodyVoxel_);
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
    buildMarkers();   // appends marker materials + models after the library's (library ids unchanged)
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
    markerBuckets_.resize(meshes_.size());
    return true;
}

// RTS markers: voxel rings / class icons / move target, one model per (shape, colour) with its own emissive material.
// Built after the library so every library model and material keeps its index (the lab is unaffected).
void MilitaryRenderer::buildMarkers() {
    for (auto& row : markerMesh_) for (int& m : row) m = -1;
    if (lib_.palette.size() + MK_COUNT > 255) { SDL_Log("military renderer: palette full, no RTS markers"); return; }
    static const float kCol[MK_COUNT][3] = {{0.92f, 0.92f, 0.88f}, {0.45f, 0.85f, 0.40f}, {1.0f, 0.68f, 0.18f},
                                            {0.35f, 0.85f, 0.95f}, {0.95f, 0.25f, 0.20f}, {0.40f, 0.60f, 1.0f}};
    const int palBase = (int)lib_.palette.size();
    for (int c = 0; c < MK_COUNT; ++c) {
        CityMaterial m;
        m.r = srgbToLinear(kCol[c][0]); m.g = srgbToLinear(kCol[c][1]); m.b = srgbToLinear(kCol[c][2]);
        m.flags = MAT_EMISSIVE; m.emissiveMode = EM_STEADY; m.emissiveNight = 0.6f; m.emissiveDay = 0.3f; m.roughness = 0.9f;
        m.name = "rts_marker";
        lib_.palette.push_back(m);
    }
    auto model = [&](const char* name, int nx, int ny, int nz, float vox, float px, float py, float pz, auto fill, int c) {
        MilVoxelModel m;
        m.name = name; m.nx = nx; m.ny = ny; m.nz = nz; m.voxel = vox;
        m.pivot[0] = px; m.pivot[1] = py; m.pivot[2] = pz;
        m.vox.assign((size_t)nx * ny * nz, 0);
        for (int y = 0; y < ny; ++y)
            for (int z = 0; z < nz; ++z)
                for (int x = 0; x < nx; ++x)
                    if (fill(x, y, z)) m.at(x, y, z) = (uint8_t)(palBase + c + 1);
        lib_.models.push_back(m);
        return (int)lib_.models.size() - 1;
    };
    for (int c = 0; c < MK_COUNT; ++c) {
        // ground rings (XZ plane, 1 voxel thick): soldier ring r 0.50 m, selected ring r 0.58 m, 2 voxels wide
        auto ring = [](float r0, float r1, float cx) {
            return [=](int x, int, int z) { float dx = x + 0.5f - cx, dz = z + 0.5f - cx, d = std::sqrt(dx * dx + dz * dz); return d >= r0 && d < r1; };
        };
        markerMesh_[(int)MilMarker::Ring][c] = model("rts_ring", 20, 1, 20, 0.055f, 10, 0, 10, ring(8.1f, 9.4f, 10.f), c);
        markerMesh_[(int)MilMarker::RingSelected][c] = model("rts_ring_sel", 24, 1, 24, 0.055f, 12, 0, 12, ring(9.0f, 11.0f, 12.f), c);
        // move target: a flat cross with a ring
        markerMesh_[(int)MilMarker::MoveTarget][c] = model("rts_move", 21, 1, 21, 0.06f, 10.5f, 0, 10.5f, [](int x, int, int z) {
            float dx = x - 10.f, dz = z - 10.f, d = std::sqrt(dx * dx + dz * dz);
            return (d >= 8.f && d < 10.2f) || ((x == 10 || z == 10) && d < 5.5f && d > 1.5f);
        }, c);
        // class icons (XY plane, +Z faces the camera), 9 x 9 voxels of 0.12 m: rifle one chevron, MG two chevrons,
        // sniper a crosshair (shape tells the class at distance, colour helps)
        auto chevron = [](int x, int y, int y0) { int dx = std::abs(x - 4); return y == y0 + (4 - dx) || y == y0 + (4 - dx) - 1; };
        markerMesh_[(int)MilMarker::IconRifle][c] = model("rts_icon_rifle", 9, 9, 1, 0.1f, 4.5f, 0, 0.5f, [&](int x, int y, int) {
            return chevron(x, y, 2) && y >= 1;
        }, c);
        markerMesh_[(int)MilMarker::IconMG][c] = model("rts_icon_mg", 9, 9, 1, 0.1f, 4.5f, 0, 0.5f, [&](int x, int y, int) {
            return (chevron(x, y, 0) && y >= 0) || (chevron(x, y, 4) && y >= 4);
        }, c);
        markerMesh_[(int)MilMarker::IconSniper][c] = model("rts_icon_sniper", 9, 9, 1, 0.1f, 4.5f, 0, 0.5f, [](int x, int y, int) {
            float dx = x - 4.f, dy = y - 4.f, d = std::sqrt(dx * dx + dy * dy);
            return (d >= 3.f && d < 4.2f) || (x == 4 && (y <= 1 || y >= 7)) || (y == 4 && (x <= 1 || x >= 7)) || (x == 4 && y == 4);
        }, c);
    }
}

void MilitaryRenderer::shutdown() {
    if (!gpu_) return;
    for (auto& m : meshes_) city_->releaseMesh(m);
    meshes_.clear();
    for (SDL_GPUBuffer** b : {&charBuf_, &attBuf_, &joints_, &segs_, &insts_, &mats_}) gpu_->releaseBuffer(*b);
    if (tb_) SDL_ReleaseGPUTransferBuffer(gpu_->device(), tb_);
    if (pPose_) SDL_ReleaseGPUComputePipeline(gpu_->device(), pPose_);
    if (pAttach_) SDL_ReleaseGPUComputePipeline(gpu_->device(), pAttach_);
    tb_ = nullptr; pPose_ = pAttach_ = nullptr; gpu_ = nullptr;
}

void MilitaryRenderer::installHooks(Renderer& r, bool lights) {
    Renderer::Extension e;
    e.prepare = [this](SDL_GPUCommandBuffer* cmd) { prepare(cmd); };
    e.draw = [this](SDL_GPURenderPass* p, SDL_GPUCommandBuffer* c, SDL_GPUBuffer* d, SDL_GPUBuffer* sh, SDL_GPUBuffer* ch) { draw(p, c, d, sh, ch); };
    e.shadowDraw = [this](SDL_GPURenderPass* p, SDL_GPUCommandBuffer* c) { drawShadow(p, c); };
    if (lights) e.lights = [this](std::vector<PointLight>& l) { injectLights(l); };
    removeHooks(r);
    hookId_ = r.addExtension(std::move(e));
}

void MilitaryRenderer::removeHooks(Renderer& r) {
    if (hookId_ >= 0) r.removeExtension(hookId_);
    hookId_ = -1;
}

int MilitaryRenderer::findClip(int infantry, const char* action) const {
    if (infantry < 0 || infantry >= (int)lib_.infantry.size()) return -1;
    return milClipByAction(lib_.infantry[(size_t)infantry], action);
}

int MilitaryRenderer::findProp(const char* name) const {
    for (size_t i = 0; i < lib_.props.size(); ++i) if (lib_.props[i].name == name) return (int)i;
    return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// frame

void MilitaryRenderer::beginFrame(const Camera& camera, float aspect) {
    M4 vp = mul(camera.proj(aspect), camera.view());
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
    eye_ = camera.eye();
    focus_ = camera.target();
    charsU_.clear();
    for (auto& b : attBuckets_) b.clear();
    for (auto& b : instBuckets_) b.clear();
    for (auto& b : markerBuckets_) b.clear();
    vehDraws_.clear(); vehInst_.clear(); canopyDraws_.clear(); canopyInst_.clear();
    st_ = MilRenderStats{};
}

bool MilitaryRenderer::visible(V3 p, float r) const {
    for (auto& pl : frustum_) if (pl[0] * p.x + pl[1] * (p.y + 0.9f) + pl[2] * p.z + pl[3] < -r) return false;
    return true;
}

// distance from the nearer of the eye and the camera focus (RTS pivot): zoomed out, the soldiers the player is looking
// at keep their full pose rate and gear (the eye is 200-300 m away from them)
int MilitaryRenderer::lodAt(V3 p) const { float d = std::min(length(p - eye_), length(p - focus_)); return d < 70.f ? 0 : d < 180.f ? 1 : 2; }

bool MilitaryRenderer::addSoldier(const MilPoseInput& s) {
    if (s.infantry < 0 || s.infantry >= (int)lib_.infantry.size() || charsU_.size() >= kMaxChars) return false;
    int lod = s.lod;
    if (lod < 0) {
        if (!visible(s.pos, 1.2f)) return false;
        lod = lodAt(s.pos);
    }
    pushSoldier(s, lod);
    return true;
}

// CPU sample of a soldier's clip into the GPU record; mountQ = weapon mount (forearmR space).
void MilitaryRenderer::sampleSoldier(const MilPoseInput& so, CharU& C, float mountQ[4], int lod) const {
    const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
    const MilClip* c = so.clip >= 0 && so.clip < (int)inf.clips.size() ? &inf.clips[(size_t)so.clip] : nullptr;
    std::memset(&C, 0, sizeof(C));
    C.posYaw[0] = so.pos.x; C.posYaw[1] = so.pos.y; C.posYaw[2] = so.pos.z; C.posYaw[3] = so.yaw;
    C.rootQ[3] = 1.f;
    mountQ[0] = mountQ[1] = mountQ[2] = 0; mountQ[3] = 1;
    C.look[0] = inf.lookX; C.look[1] = inf.lookY; C.look[2] = inf.ownBody ? 1u : 0u; C.look[3] = (uint32_t)(so.infantry * 389 + (int)(so.pos.x * 7.f));
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
bool MilitaryRenderer::sampleBody(const MilPoseInput& so, int lod, float* B) const {
    const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
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
    float down[3] = {0, -1, 0}, q2[4], cur[3], arc[4], q2n[4], q3p[4], q3n[4], ql2[4], ql3[4], inv[4];
    E(2, ql); qmul(q1, ql, q2);
    qrotv(q2, down, cur); qarc(cur, U, arc); qmul(arc, q2, q2n);
    E(3, ql); qmul(q2n, ql, q3p);
    qrotv(q3p, down, cur); qarc(cur, F, arc); qmul(arc, q3p, q3n);
    qconj(q1, inv); qmul(inv, q2n, ql2);
    qconj(q2n, inv); qmul(inv, q3n, ql3);
    float o2[4], o3[4];
    E(2, qa); qnlerp(qa, ql2, sw, o2); quatToEulerXYZ(o2, &B[MB_ROT + 2 * 3]);
    E(3, qa); qnlerp(qa, ql3, sw, o3); quatToEulerXYZ(o3, &B[MB_ROT + 3 * 3]);
    return true;
}

// Weapon frame of a sampled soldier on the CPU (forward kinematics torso -> upperArmR -> forearmR, clip root, heading),
// then a weapon-space point: the authored muzzle / ejection port of the POSED weapon. Zombie-clip placeholders: rest.
void MilitaryRenderer::muzzleFrame(const MilPoseInput& so, const CharU& C, const float mountQ[4], const float wp[3], V3& outP, float outQ[4]) const {
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

void MilitaryRenderer::spawnFx(int model, V3 p, V3 v, const float q[4], float life, int kind, float glow) {
    if (fx_.size() >= kMaxFx || model < 0) return;   // FX budget
    Fx f{model, p, v, {0, 0, 0, 1}, 0.f, life, kind};
    if (q) std::memcpy(f.q, q, sizeof(f.q));
    f.glow = glow;
    fx_.push_back(f);
}

// Emissive FX instance in the scene pass only (no shadow), uniformly or axially scaled through the deformed-instance
// path of city.vert (pos.w = 2: xz scale paint.x, y scale paint.y, no dissolve, no ground clamp).
void MilitaryRenderer::addGlow(int model, V3 p, const float q[4], float sxz, float sy) {
    if (model < 0 || model >= (int)markerBuckets_.size()) return;
    Inst gi{};
    gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = 2.f;
    std::memcpy(gi.quat, q, sizeof(gi.quat));
    gi.paint[0] = sxz; gi.paint[1] = sy; gi.paint[2] = 0.f; gi.paint[3] = -2000.f;
    markerBuckets_[(size_t)model].push_back(gi);
}

uint32_t MilitaryRenderer::fxTracer(V3 from, V3 to, int style) {
    if (!fxEnabled || fx_.size() >= kMaxFx) return 0;
    V3 d = to - from;
    const float len = length(d);
    if (len < 1.f) return 0;
    const float speed = style == 2 ? 900.f : 750.f;
    Fx f{lib_.fxModels[MilitaryLibrary::FX_STREAK], from, d * (1.f / len), {0, 0, 0, 1}, 0.f, 0.f, 4};
    f.a = len;
    f.b = (float)style;
    f.id = ++fxIds_ ? fxIds_ : ++fxIds_;
    f.life = (len + tracerLength) / speed + 0.02f;
    f.speed = speed;
    fx_.push_back(f);
    return f.id;
}

void MilitaryRenderer::fxTracerEnd(uint32_t id, float dist) {
    if (!id) return;
    for (Fx& f : fx_)
        if (f.id == id && f.kind == 4) {
            f.a = std::max(1.f, dist);
            f.life = std::min(f.life, (f.a + tracerLength) / f.speed + 0.02f);
            return;
        }
}

void MilitaryRenderer::fxFlame(const MilPoseInput& so, V3 dir, float range) {
    if (!fxEnabled || so.infantry < 0 || so.infantry >= (int)lib_.infantry.size() || lib_.flameModels[1] < 0) return;
    const std::string kind = lib_.infantry[(size_t)so.infantry].weaponKind;
    CharU C;
    float mq[4];
    sampleSoldier(so, C, mq, 0);
    soldierEvent(so, C, {0, "muzzle_flash", kind == "sniper" ? "rifle" : kind});   // nozzle glow + light, sets lastMuzzle_
    const float l = length(dir);
    const V3 d = l > 1e-3f ? dir * (1.f / l) : V3{0, 0, 1};
    ++flameSeq_;
    // the flame itself is an fx volume (game: Renderer::setFlameVolumes); here only the nozzle glow + a rare ember
    for (int k = 0; k < ((flameSeq_ % 3u) == 0u ? 1 : 0) && fx_.size() < kMaxFx; ++k) {
        const uint32_t h = (uint32_t)fx_.size() * 2654435761u + (uint32_t)k * 40503u + flameSeq_ * 977u;
        const float j0 = hashf(h) - 0.5f, j1 = hashf(h ^ 0x9E37u) - 0.5f, j2 = hashf(h * 3u + 1u);
        const float life = 0.42f + 0.22f * j2;
        const float speed = range * 2.9f * (0.75f + 0.45f * hashf(h + 7u));
        V3 v = d * speed + V3{j0 * 3.2f, j1 * 2.2f + 0.6f, (hashf(h + 11u) - 0.5f) * 3.2f};
        Fx f{lib_.flameModels[0], lastMuzzle_ + d * (0.15f * (float)k), v * 0.6f, {0, 0, 0, 1}, 0.f, life, 9};
        f.b = 0.35f + 0.2f * j2;   // small ember
        fx_.push_back(f);
    }
}

uint32_t MilitaryRenderer::fxShotRay(const MilPoseInput& so, V3 hit, bool tracer, bool casing) {
    if (!fxEnabled || so.infantry < 0 || so.infantry >= (int)lib_.infantry.size()) return 0;
    const std::string kind = lib_.infantry[(size_t)so.infantry].weaponKind;
    CharU C;
    float mq[4];
    sampleSoldier(so, C, mq, 0);
    soldierEvent(so, C, {0, kind == "sniper" ? "suppressed" : "muzzle_flash", kind});
    if (kind == "sniper") soldierEvent(so, C, {0, "muzzle_flash", "sniper_glint"});
    if (casing) soldierEvent(so, C, {0, "shell_eject", kind});
    if (!tracer) return 0;
    return fxTracer(lastMuzzle_, hit, kind == "mg" ? 1 : kind == "sniper" ? 2 : 0);
}

void MilitaryRenderer::fxEvent(const MilPoseInput& so, const MilFxEvent& e) {
    if (!fxEnabled || so.infantry < 0 || so.infantry >= (int)lib_.infantry.size()) return;
    CharU C;
    float mq[4];
    sampleSoldier(so, C, mq, 0);
    soldierEvent(so, C, e);
}

void MilitaryRenderer::fxShot(const MilPoseInput& so) {
    if (so.infantry < 0 || so.infantry >= (int)lib_.infantry.size()) return;
    const std::string kind = lib_.infantry[(size_t)so.infantry].weaponKind;
    for (const char* ev : {"muzzle_flash", "tracer", "shell_eject"}) fxEvent(so, {0, ev, kind});
    if (kind == "sniper") fxEvent(so, {0, "suppressed", kind});
}

void MilitaryRenderer::fxBurst(V3 p, int kind) {
    if (!fxEnabled) return;
    if (kind == 0) {
        for (int k = 0; k < 2; ++k) {
            float a = hashf((uint32_t)fx_.size() + k * 11u) * 2.f * kPi;
            spawnFx(lib_.fxModels[MilitaryLibrary::FX_DUST], {p.x + std::cos(a) * 0.12f, p.y, p.z + std::sin(a) * 0.12f}, {std::cos(a) * 0.4f, 0.5f, std::sin(a) * 0.4f}, nullptr, 0.25f, 2);
        }
        return;
    }
    for (int k = 0; k < 8; ++k) {
        float a = k * kPi / 4.f;
        spawnFx(lib_.fxModels[MilitaryLibrary::FX_DUST_L], {p.x + std::cos(a) * 1.2f, p.y, p.z + std::sin(a) * 1.2f}, {std::cos(a) * 0.6f, 0.4f, std::sin(a) * 0.6f}, nullptr, 0.5f, 2);
    }
}

// Clip events -> voxel FX (docs/MILITARY_ANIMS.md 6) at the posed weapon.
void MilitaryRenderer::soldierEvent(const MilPoseInput& so, const CharU& C, const MilFxEvent& e) {
    if (!fxEnabled) return;
    const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
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
    lastMuzzle_ = mp;
    if (e.type == "muzzle_flash") {
        // Flashes are emissive glow instances (scene pass, no shadow) that keep a minimum on-screen size at RTS
        // distance (FX::glow = model extent, see updateFx), plus a short point-light burst.
        if (e.fx == "sniper_glint") {   // suppressed rifle: a faint, tiny glint only (no light)
            spawnFx(M[MilitaryLibrary::FX_FLASH_RIFLE_HALF], mp, {}, wq, 1.f / 30.f, 0, 0.075f);
            return;
        }
        if (kind == "sniper") return;   // suppressed: the `suppressed` event makes the puff
        // 3-frame voxel flash (one model per 1/60 s: full star + cone, smaller star, last wisp), random roll per round,
        // and a small, sharp-falloff point light at the muzzle (lights the shooter, the ground and walls around it)
        const bool mg = kind == "mg";
        const uint32_t hr = (uint32_t)(mgRound_++) * 2654435761u ^ (uint32_t)(mp.x * 131.f + mp.z * 71.f);
        const float roll = (float)(hr % 4u) * (kPi / 8.f);   // 0 / 22.5 / 45 / 67.5 deg about the barrel
        float qz[4] = {0, 0, std::sin(roll), std::cos(roll)}, q2[4];
        qmul(wq, qz, q2);
        Fx f{M[mg ? MilitaryLibrary::FX_FLASH_M0 : MilitaryLibrary::FX_FLASH_R0], mp, {}, {0, 0, 0, 1}, 0.f, 3.5f / 60.f, 5};
        std::memcpy(f.q, q2, sizeof(f.q));
        f.glow = mg ? 0.26f : 0.18f;
        f.b = mg ? 1.f : 0.f;
        if (fx_.size() < kMaxFx) fx_.push_back(f);
        const float jit = 0.8f + 0.4f * (float)((hr >> 8) % 1000u) / 1000.f;
        if (flashes_.size() < 64) flashes_.push_back({mp + dir * 0.15f, 2.5f / 60.f, mg ? 5.f : 4.f, (mg ? 9.f : 7.f) * jit});
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

// One soldier -> GPU record + its parts into the per-mesh buckets. LOD: small gear dropped beyond LOD0.
void MilitaryRenderer::pushSoldier(const MilPoseInput& so, int lod) {
    if (charsU_.size() >= kMaxChars) return;
    const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
    CharU C;
    float mountQ[4];
    sampleSoldier(so, C, mountQ, lod);
    const uint32_t ci = (uint32_t)charsU_.size();
    charsU_.push_back(C);
    for (size_t a = 0; a < inf.atts.size(); ++a) {
        const MilAttachment& A = inf.atts[a];
        if (A.model < 0 || A.fx) continue;
        if (lod >= 1 && smallGear(A.name)) continue;
        if (so.noWeapon && (int)a == inf.weaponAtt) continue;
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
                addModel(A.model, {so.pos.x + pr[0], so.pos.y + pr[1], so.pos.z + pr[2]}, q);
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

void MilitaryRenderer::addModel(int model, V3 p, const float q[4], int kind, const float* paint) {
    if (model < 0 || model >= (int)instBuckets_.size()) return;
    Inst gi{};
    gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = (float)kind;
    std::memcpy(gi.quat, q, sizeof(gi.quat));
    if (paint) std::memcpy(gi.paint, paint, sizeof(gi.paint));
    instBuckets_[(size_t)model].push_back(gi);
}

bool MilitaryRenderer::addDroppedWeapon(const MilPoseInput& so) {
    if (so.infantry < 0 || so.infantry >= (int)lib_.infantry.size()) return false;
    const MilInfantry& inf = lib_.infantry[(size_t)so.infantry];
    if (inf.weaponAtt < 0 || so.clip < 0 || so.clip >= (int)inf.clips.size()) return false;
    const MilAttachment& A = inf.atts[(size_t)inf.weaponAtt];
    const MilClip& mc = inf.clips[(size_t)so.clip];
    float W[MW_STRIDE];
    if (A.model < 0 || mc.keyClip < 0 || mc.keyClip >= (int)lib_.keyClips.size() || !lib_.keyClips[(size_t)mc.keyClip].sampleWeapon(so.t, W)) return false;
    float qy[4], qr[4], q[4], pr[3];
    yawQuat(so.yaw, qy);
    eulerXYZToQuat(&W[MW_ROT], qr);
    qmul(qy, qr, q);
    qrotv(qy, &W[MW_POS], pr);
    addModel(A.model, {so.pos.x + pr[0], so.pos.y + pr[1], so.pos.z + pr[2]}, q);
    return true;
}

void MilitaryRenderer::addModelYaw(int model, V3 p, float yaw) { float q[4] = {0, std::sin(0.5f * yaw), 0, std::cos(0.5f * yaw)}; addModel(model, p, q); }

void MilitaryRenderer::addCityMesh(const CityRenderer::GpuMesh* mesh, V3 p, const float q[4]) {
    Inst gi{};
    gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = 0.f;
    std::memcpy(gi.quat, q, sizeof(gi.quat));
    vehDraws_.push_back({mesh, (uint32_t)vehInst_.size(), 1});
    vehInst_.push_back(gi);
}

void MilitaryRenderer::addProp(int prop, V3 o, float yaw, float dissolve) {
    if (prop < 0 || prop >= (int)lib_.props.size()) return;
    const MilProp& p = lib_.props[(size_t)prop];
    float q[4];
    yawQuat(yaw, q);
    // dissolve: the identity "deformed prop" path of city.vert (kind 2 + 0.9 d, radial / height 1, no shear, no clamp)
    const float paint[4] = {1.f, 1.f, 0.f, -1e4f};
    const int kind = dissolve > 0.f ? 2 : 1;
    const float* pt = dissolve > 0.f ? paint : nullptr;
    if (dissolve >= 1.f) return;
    auto put = [&](int m, V3 at) {
        if (kind == 2) {
            if (m < 0 || m >= (int)instBuckets_.size()) return;
            Inst gi{};
            gi.pos[0] = at.x; gi.pos[1] = at.y; gi.pos[2] = at.z; gi.pos[3] = 2.f + 0.9f * dissolve;
            std::memcpy(gi.quat, q, sizeof(gi.quat));
            std::memcpy(gi.paint, pt, sizeof(gi.paint));
            instBuckets_[(size_t)m].push_back(gi);
        } else addModel(m, at, q);
    };
    if (p.parts.empty()) { put(p.model, o); return; }
    for (const auto& [m, pv] : p.parts) { float r[3]; qrotv(q, pv.data(), r); put(m, {o.x + r[0], o.y + r[1], o.z + r[2]}); }
}

void MilitaryRenderer::addMarker(MilMarker shape, int color, V3 p, float yaw) {
    if ((int)shape >= (int)MilMarker::Count || color < 0 || color >= MK_COUNT) return;
    const int m = markerMesh_[(int)shape][color];
    if (m < 0) return;
    float q[4];
    if (shape == MilMarker::IconRifle || shape == MilMarker::IconMG || shape == MilMarker::IconSniper) {   // face the camera
        V3 d = eye_ - p;
        float h = std::sqrt(d.x * d.x + d.z * d.z), ya = std::atan2(d.x, d.z), el = std::atan2(d.y, std::max(h, 1e-4f));
        float qy[4], qx[4] = {std::sin(-0.5f * el), 0, 0, std::cos(-0.5f * el)};
        yawQuat(ya, qy);
        qmul(qy, qx, q);
    } else yawQuat(yaw, q);
    Inst gi{};
    gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = 1.f;
    std::memcpy(gi.quat, q, sizeof(gi.quat));
    markerBuckets_[(size_t)m].push_back(gi);
}

// ---------------------------------------------------------------------------------------------------------------
// parachute drops (docs/MILITARY_ANIMS.md 2.3): descent (descentSpeed) -> touchdown -> land -> recover -> settled
void MilitaryRenderer::advanceDrop(MilDrop& d, float dt) {
    const MilInfantry* inf = d.inf < (int)lib_.infantry.size() ? &lib_.infantry[(size_t)d.inf] : nullptr;
    const std::string cls = d.cargo ? "crate" : (inf ? inf->cls : "");
    int cDesc = lib_.findClip(cls, d.cargo ? "descent" : "para_descent"), cLand = lib_.findClip(cls, d.cargo ? "land" : "para_land");
    int cRec = d.cargo ? -1 : lib_.findClip(cls, "para_recover");
    float speed = cDesc >= 0 ? std::max(1.f, lib_.keyClips[(size_t)cDesc].descentSpeed) : 5.f;
    float prev = d.t;
    if (!(d.externalDescent && d.phase == 0)) d.t += dt;
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
                if ((e.type == "canopy_ground" || e.type == "crate_touch" || e.type == "touchdown") && fxEnabled)
                    for (int k = 0; k < 8; ++k) {
                        float a = k * kPi / 4.f;
                        spawnFx(lib_.fxModels[MilitaryLibrary::FX_DUST_L], {d.xz.x + std::cos(a) * 1.2f, d.xz.y, d.xz.z + std::sin(a) * 1.2f},
                                {std::cos(a) * 0.6f, 0.4f, std::sin(a) * 0.6f}, nullptr, 0.5f, 2);
                    }
            }
    if (d.phase == 0) {
        if (d.externalDescent) return;
        d.alt = d.startH - speed * d.t;
        if (d.alt <= 0.f) { d.alt = 0.f; d.phase = 1; d.t = 0.f; }
    } else if (d.phase == 1) {
        if (!cur || d.t >= cur->duration) {
            if (!d.cargo && cur) { cur->sampleCanopy(cur->duration, d.relCanopy); }
            d.phase = d.cargo ? 3 : 2; d.t = 0.f;
        }
    } else if (d.phase == 2) {
        if (!cur || d.t >= cur->duration) { d.phase = 3; d.t = 0.f; }
    } else if (d.demoLoop && d.t > 6.f) { d.phase = 0; d.t = 0.f; d.released = false; d.groundT = -1.f; }   // demo loop: drop again
}

void MilitaryRenderer::addDrop(const MilDrop& d) {
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
    // body / crate
    if (!d.cargo && inf && d.drawBody) {
        MilPoseInput so;
        so.infantry = d.inf; so.pos = agent; so.yaw = d.yaw; so.t = t;
        so.clip = -1;
        for (size_t i = 0; i < inf->clips.size(); ++i) if (clipIdx >= 0 && inf->clips[i].keyClip == clipIdx) so.clip = (int)i;
        if (so.clip < 0 || d.phase == 3) { so.clip = std::max(0, milClipByAction(*inf, "idle")); so.t = d.t; }
        if (charsU_.size() < kMaxChars) pushSoldier(so, 0);
    } else if (d.cargo && d.crateDissolve < 1.f) {
        int crate = findProp("crate_ammo_drop");
        float C6[6] = {0, 0, 0, 0, 0, 0};
        if (kc) kc->sampleCrate(t, C6);
        float qr[4], q[4], pr[3];
        eulerXYZToQuat(&C6[3], qr);
        qmul(qy, qr, q);
        qrotv(qy, C6, pr);
        V3 base{agent.x + pr[0], agent.y + pr[1], agent.z + pr[2]};
        const float dpaint[4] = {1.f, 1.f, 0.f, -1e4f};
        const int kind = d.crateDissolve > 0.f ? 2 : 1;
        auto put = [&](int m, V3 at) {
            if (kind == 1) { addModel(m, at, q); return; }
            if (m < 0 || m >= (int)instBuckets_.size()) return;
            Inst gi{};
            gi.pos[0] = at.x; gi.pos[1] = at.y; gi.pos[2] = at.z; gi.pos[3] = 2.f + 0.9f * d.crateDissolve;
            std::memcpy(gi.quat, q, sizeof(gi.quat));
            std::memcpy(gi.paint, dpaint, sizeof(gi.paint));
            instBuckets_[(size_t)m].push_back(gi);
        };
        if (crate >= 0) for (const auto& [m, pv] : lib_.props[(size_t)crate].parts) { float o[3]; qrotv(q, pv.data(), o); put(m, {base.x + o[0], base.y + o[1], base.z + o[2]}); }
        else put(lib_.dropCrateModel, base);
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
    int paraIdx = findProp(d.cargo ? "para_cargo" : "para_infantry");
    const MilProp* para = paraIdx >= 0 ? &lib_.props[(size_t)paraIdx] : nullptr;
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
    else addModel(lib_.chuteOpenModel, pivot, q);
}

// ---------------------------------------------------------------------------------------------------------------
void MilitaryRenderer::updateFx(float fdt) {
    for (Fx& f : fx_) {
        f.age += fdt;
        if (f.kind == 1) {   // casing: gravity, one bounce on the surface below
            f.v.y -= 9.81f * fdt;
            f.p = f.p + f.v * fdt;
            float g = groundHeight ? groundHeight(f.p.x, f.p.z) : 0.f;
            g = g < 90.f ? g : 0.f;
            if (f.p.y < g + 0.015f && f.v.y < 0) { f.p.y = g + 0.015f; f.v = {f.v.x * 0.4f, -f.v.y * 0.3f, f.v.z * 0.4f}; }
        } else if (f.kind == 2 || f.kind == 3) f.p = f.p + f.v * fdt;
        else if (f.kind == 9) {   // flame voxel (fxFlame): drag, lift, spreads on the ground
            f.p = f.p + f.v * fdt;
            f.v = f.v * std::max(0.f, 1.f - 2.6f * fdt);
            f.v.y += 2.2f * fdt;
            float g = groundHeight ? groundHeight(f.p.x, f.p.z) : 0.f;
            g = g < 90.f ? g : 0.f;
            if (f.p.y < g + 0.08f) { f.p.y = g + 0.08f; if (f.v.y < 0) f.v.y = 0.f; }
        }
    }
    const int streak = lib_.fxModels[MilitaryLibrary::FX_STREAK];
    fx_.erase(std::remove_if(fx_.begin(), fx_.end(), [](const Fx& f) { return f.age >= f.life; }), fx_.end());
    for (Flash& fl : flashes_) fl.life -= fdt;
    flashes_.erase(std::remove_if(flashes_.begin(), flashes_.end(), [](const Flash& f) { return f.life <= 0.f; }), flashes_.end());
    for (const Fx& f : fx_) {
        int model = f.model;
        if (f.kind == 2 && model == lib_.fxModels[MilitaryLibrary::FX_PUFF_S]) {   // puffs grow in voxel steps 0.04 -> 0.07 m
            float a = f.age / f.life;
            model = lib_.fxModels[a < 0.33f ? MilitaryLibrary::FX_PUFF_S : a < 0.66f ? MilitaryLibrary::FX_PUFF_M : MilitaryLibrary::FX_PUFF_L];
        }
        if (f.kind == 4) {   // ray tracer: head travels from the muzzle to the hit point, the streak follows it
            const float head = std::min(f.age * f.speed, f.a), tail = std::clamp(f.age * f.speed - tracerLength, 0.f, f.a);
            if (head - tail < 0.05f) continue;
            const V3 hp = f.p + f.v * head;
            // thickness: a minimum angular size (~2 px at 1080p; sniper ~1 px) so it reads at any RTS distance
            const float dEye = length(hp - eye_), px = f.b > 1.5f ? 0.0008f : 0.0017f;
            const float thick = std::max(f.b > 1.5f ? 0.025f : 0.05f, dEye * px * tracerWidth);
            float q[4];
            const V3 d = f.v;   // unit direction; model +Y -> d
            if (d.y < -0.9999f) { q[0] = 1; q[1] = q[2] = 0; q[3] = 0; }
            else {
                q[0] = d.z; q[1] = 0.f; q[2] = -d.x; q[3] = 1.f + d.y;   // cross(Y, d), 1 + dot(Y, d)
                const float l = std::sqrt(q[0] * q[0] + q[2] * q[2] + q[3] * q[3]);
                for (float& c : q) c /= l;
            }
            addGlow(streak, hp, q, thick / kStreakVoxel, (head - tail) / kStreakLength);
            continue;
        }
        if (f.kind == 9) {   // flame voxel: hot core -> flame (emissive, growing) -> small soot speck
            const float a = f.age / f.life;
            const int* FM = lib_.flameModels;
            if (a > 0.82f) { if (FM[2] >= 0) addModel(FM[2], f.p, f.q); continue; }
            const float sc = (1.4f + 4.2f * a) * f.b;
            if (FM[a < 0.22f ? 0 : 1] >= 0) addGlow(FM[a < 0.22f ? 0 : 1], f.p, f.q, sc, sc);
            continue;
        }
        if (f.kind == 5) {   // muzzle flash sequence: frame by age (1/60 s each)
            const int fr = std::clamp((int)(f.age * 60.f - 0.01f), 0, 2);
            model = lib_.fxModels[(f.b > 0.5f ? MilitaryLibrary::FX_FLASH_M0 : MilitaryLibrary::FX_FLASH_R0) + fr];
        }
        if (f.glow > 0.f) {   // emissive flash: at least ~3 px across, at most 4x its modelled size
            const float sc = std::clamp(length(f.p - eye_) * 0.0026f * flashScale / f.glow, 1.f, 4.f);
            addGlow(model, f.p, f.q, sc, sc);
            continue;
        }
        addModel(model, f.p, f.q);
    }
    st_.fx = (uint32_t)fx_.size();
}

// finalize: parts sorted by mesh (one instanced draw per mesh), then CPU instances by mesh, canopies, vehicles, markers
void MilitaryRenderer::endFrame() {
    atts_.clear();
    draws_.clear();
    markerDraws_.clear();
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
    // CPU instances share one kMaxCpuInst region (GPU buffer and transfer buffer): canopies and vehicles are reserved
    // first (whole draws), the buckets get the rest. Never exceed it (an overflow writes past the mapped transfer
    // buffer and uploads past the instance buffer).
    if (vehInst_.size() + canopyInst_.size() > (size_t)kMaxCpuInst) { vehDraws_.clear(); vehInst_.clear(); }
    if (canopyInst_.size() > (size_t)kMaxCpuInst) { canopyDraws_.clear(); canopyInst_.clear(); }
    const size_t reserved = vehInst_.size() + canopyInst_.size();
    for (size_t m = 0; m < instBuckets_.size(); ++m) {
        auto& b = instBuckets_[m];
        if (b.empty()) continue;
        size_t n = std::min(b.size(), (size_t)kMaxCpuInst - reserved - cpuInst_.size());
        if (!n) break;
        draws_.push_back({&meshes_[m], base + (uint32_t)cpuInst_.size(), (uint32_t)n});
        st_.tris += (uint64_t)meshTris_[m] * n;
        cpuInst_.insert(cpuInst_.end(), b.begin(), b.begin() + (long)n);
    }
    for (auto d : canopyDraws_) { d.first += base + (uint32_t)cpuInst_.size(); draws_.push_back(d); }
    cpuInst_.insert(cpuInst_.end(), canopyInst_.begin(), canopyInst_.end());
    for (auto& d : vehDraws_) d.first += base + (uint32_t)cpuInst_.size();
    cpuInst_.insert(cpuInst_.end(), vehInst_.begin(), vehInst_.end());
    for (size_t m = 0; m < markerBuckets_.size(); ++m) {   // markers: scene pass only (no shadow)
        auto& b = markerBuckets_[m];
        if (b.empty()) continue;
        size_t n = std::min(b.size(), (size_t)kMaxCpuInst - cpuInst_.size());
        if (!n) break;
        markerDraws_.push_back({&meshes_[m], base + (uint32_t)cpuInst_.size(), (uint32_t)n});
        cpuInst_.insert(cpuInst_.end(), b.begin(), b.begin() + (long)n);
    }
    placeholderChars_ = lib_.placeholder ? std::min<uint32_t>((uint32_t)charsU_.size(), kMaxPlaceholderChars) : 0u;
    st_.visible = (uint32_t)charsU_.size();
    st_.instances = (uint32_t)(atts_.size() + cpuInst_.size());
    st_.draws = (uint32_t)(draws_.size() + vehDraws_.size() + markerDraws_.size()) + (placeholderChars_ ? 1u : 0u);
    st_.upload = charsU_.size() * sizeof(CharU) + atts_.size() * sizeof(AttU) + cpuInst_.size() * sizeof(Inst);
}

void MilitaryRenderer::injectLights(std::vector<PointLight>& lights) const {
    // muzzle flash lights (1-2 frames), nearest to the camera first, at most kMaxFlashLights
    std::vector<const Flash*> fl;
    for (const Flash& f : flashes_) fl.push_back(&f);
    std::sort(fl.begin(), fl.end(), [&](const Flash* a, const Flash* b) { return length(a->p - eye_) < length(b->p - eye_); });
    for (size_t k = 0; k < fl.size() && k < kMaxFlashLights; ++k) {
        if (lights.size() >= (size_t)kMaxLights) lights.pop_back();
        // negative radius = sharp muzzle light (inverse-square core, Lambert, never merged; lighting.glsl pointLights)
        const float fade = std::clamp(fl[k]->life * 60.f / 1.5f, 0.3f, 1.f);
        lights.insert(lights.begin(), PointLight{fl[k]->p.x, fl[k]->p.y, fl[k]->p.z, -fl[k]->radius, 1.f, 0.74f, 0.42f, fl[k]->intensity * fade});
    }
}

void MilitaryRenderer::prepare(SDL_GPUCommandBuffer* cmd) {
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

void MilitaryRenderer::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH) {
    if (!gpu_) return;
    if (placeholderChars_) {
        chars_->setShadowField(shadow);
        chars_->drawExternal(cmd, pass, *sim_, segs_, placeholderChars_ * 10);
    }
    city_->drawExternal(pass, cmd, mats_, insts_, decals, shadow, corpseH, draws_);
    city_->drawExternal(pass, cmd, city_->materials(), insts_, decals, shadow, corpseH, vehDraws_);
    if (!markerDraws_.empty()) city_->drawExternal(pass, cmd, mats_, insts_, decals, shadow, corpseH, markerDraws_);
}

void MilitaryRenderer::drawShadow(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd) {
    if (!gpu_) return;
    if (placeholderChars_) chars_->drawExternal(cmd, pass, *sim_, segs_, placeholderChars_ * 10, true);
    city_->drawExternalShadow(pass, cmd, insts_, draws_);
    city_->drawExternalShadow(pass, cmd, insts_, vehDraws_);
}

} // namespace ttz
