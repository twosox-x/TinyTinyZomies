#include "lab/MilitaryLab.h"

#include "app/App.h"
#include "imgui.h"
#include "sim/Look.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz {

namespace {
constexpr uint32_t kMaxChars = 16, kMaxAtts = 224, kMaxInst = 2048;
constexpr float kPi = 3.14159265f;
struct MilCharU { float posYaw[4]; float anim[4]; uint32_t look[4]; };
struct MilAttU { uint32_t info[4]; float offset[4]; float quat[4]; };
struct MilPoseU {
    uint32_t cfg[4];
    float params[4];
    MilCharU chars[kMaxChars];
    MilAttU atts[kMaxAtts];
};
static_assert(sizeof(MilPoseU) == 32 + 48 * (kMaxChars + kMaxAtts));

void yawQuat(float yaw, float q[4]) { q[0] = 0; q[1] = std::sin(0.5f * yaw); q[2] = 0; q[3] = std::cos(0.5f * yaw); }
// the lineup's comparison zombies: the three approved Zombie Lab designs
LookSpec lineupLook(int i) { return i == 0 ? labOfficeDrone() : i == 1 ? labStreetWalker() : labRotter(); }
// layout (lab-local metres; +Z faces the default camera): turntable at the origin, lineup row behind it, props row
// behind the lineup, parachute drop to the right
constexpr float kLineupZ = -4.f, kPropsZ = -9.5f, kChuteX = 10.f;
constexpr float kClearX0 = -13.f, kClearX1 = 15.f, kClearZ0 = -16.f, kClearZ1 = 3.f, kPropsRow = 24.f, kPropsRowGap = 4.5f;
} // namespace

static std::string dataPathLab(const std::string& rel) {   // cwd, next to the executable, then the source tree
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

V3 MilitaryLab::world(float lx, float lz, float y) const {
    float c = std::cos(frameYaw_), s = std::sin(frameYaw_);
    return {ox_ + lx * c + lz * s, oy_ + y, oz_ - lx * s + lz * c};
}

// A street patch for the diorama: the clear (street / pavement) rectangle of the lab layout nearest to the
// simulation window centre, in any of the four orientations, from the window's static height raster.
void MilitaryLab::findSpot(AppState& s) {
    const Sandbox& sb = s.sandbox;
    const std::vector<float>& h = s.staticHeights;
    float cx = sb.originX + 0.5f * sb.gridW * sb.cellSize, cz = sb.originZ + 0.5f * sb.gridH * sb.cellSize;
    ox_ = cx; oz_ = cz; frameYaw_ = 0;
    auto heightAt = [&](float x, float z) {
        int i = (int)std::floor((x - sb.originX) / sb.cellSize), j = (int)std::floor((z - sb.originZ) / sb.cellSize);
        if (i < 0 || j < 0 || i >= sb.gridW || j >= sb.gridH) return 99.f;
        return h[(size_t)j * sb.gridW + i];
    };
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
                    for (float lx = kClearX0; lx <= kClearX1 && ok; lx += 0.7f) {
                        float x = cx + dx + lx * c + lz * sn, z = cz + dz - lx * sn + lz * c;
                        if (heightAt(x, z) > 0.3f) ok = false;
                    }
                if (ok) { best = d2; ox_ = cx + dx; oz_ = cz + dz; frameYaw_ = yaw; spotFound_ = true; break; }
            }
        }
    oy_ = 0.f;
    SDL_Log("military lab: diorama spot (%.1f, %.1f) heading %.0f deg%s", ox_, oz_, frameYaw_ * 180.f / kPi,
            spotFound_ ? "" : " (no clear street patch found: window centre)");
}

bool MilitaryLab::init(AppState& s) {
    app_ = &s;
    gpu_ = &s.gpu;
    city_ = &s.cityRenderer;
    chars_ = &s.chars;
    sim_ = &s.sim;
    bodyVoxel_ = s.chars.metresPerVoxel();
    if (!lib_.load(dataPathLab("assets/military"), bodyVoxel_)) lib_.buildPlaceholders(bodyVoxel_);
    pPose_ = gpu_->loadCompute("mil_pose", 16);
    if (!pPose_) return false;
    constexpr SDL_GPUBufferUsageFlags rw = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ | SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE |
                                           SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    segs_ = gpu_->createBuffer(rw, kMaxChars * 10 * 32, "milSegs");
    poseBuf_ = gpu_->createBuffer(SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ, (uint32_t)sizeof(MilPoseU), "milPoseInput");
    insts_ = gpu_->createBuffer(rw, kMaxInst * sizeof(CityRenderer::GpuInstance), "milInsts");
    SDL_GPUTransferBufferCreateInfo tci{SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD, kMaxInst * (uint32_t)sizeof(CityRenderer::GpuInstance) + (uint32_t)sizeof(MilPoseU), 0};
    instTB_ = SDL_CreateGPUTransferBuffer(gpu_->device(), &tci);
    mats_ = city_->createMaterialBuffer(lib_.palette);
    lib_.premeshed.resize(lib_.models.size());
    for (size_t i = 0; i < lib_.models.size(); ++i)
        meshes_.push_back(city_->uploadExternalMesh(lib_.premeshed[i].verts.empty() ? meshVoxelModel(lib_.models[i]) : lib_.premeshed[i], "milModel"));
    poseU_.assign(sizeof(MilPoseU), 0);
    findSpot(s);
    s.renderer.extPrepare = [this](SDL_GPUCommandBuffer* cmd) { prepare(cmd); };
    s.renderer.extDraw = [this](SDL_GPURenderPass* p, SDL_GPUCommandBuffer* c, SDL_GPUBuffer* d, SDL_GPUBuffer* sh, SDL_GPUBuffer* ch) {
        draw(p, c, d, sh, ch);
    };
    s.debugCam = true;   // free orbit camera (F2 toggles the RTS rig)
    s.camera.settings.minDistance = 1.0f;
    s.camera.settings.maxDistance = 600.f;
    s.camera.settings.minPitch = -0.2f;
    s.camera.settings.maxPitch = 89.f * kPi / 180.f;
    setupScene(s);
    applyView(s, "closeup");
    return true;
}

void MilitaryLab::shutdown() {
    if (!gpu_) return;
    for (auto& m : meshes_) city_->releaseMesh(m);
    meshes_.clear();
    gpu_->releaseBuffer(segs_);
    gpu_->releaseBuffer(poseBuf_);
    gpu_->releaseBuffer(insts_);
    gpu_->releaseBuffer(mats_);
    if (instTB_) SDL_ReleaseGPUTransferBuffer(gpu_->device(), instTB_);
    if (pPose_) SDL_ReleaseGPUComputePipeline(gpu_->device(), pPose_);
    instTB_ = nullptr; pPose_ = nullptr; gpu_ = nullptr;
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
    s.simAccumulator = 0;
}

void MilitaryLab::select(AppState& s, int kind, int index) {
    selKind_ = kind;
    selIndex_ = index;
    animTime_ = 0.f;
    if (kind == 0 && index < (int)lib_.infantry.size()) clip_ = std::min(clip_, (int)lib_.infantry[(size_t)index].clips.size() - 1);
    applyView(s, lastView_ == "lineup" || lastView_ == "rts110" || lastView_ == "rts300" || lastView_ == "props" ? "closeup" : lastView_);
}

// Camera presets. Character / prop front = lab +Z; the camera yaw is the direction from the target to the eye.
bool MilitaryLab::applyView(AppState& s, const std::string& v) {
    const float deg = kPi / 180.f;
    float baseYaw = frameYaw_ + (turntable_ ? turnAngle_ : 0.f);
    float size = 1.8f;
    if (selKind_ == 1 && selIndex_ < (int)lib_.props.size()) {
        const MilVoxelModel& m = lib_.models[(size_t)lib_.props[(size_t)selIndex_].model];
        size = std::max({m.nx * m.voxel, m.ny * m.voxel, m.nz * m.voxel, 1.f});
    }
    V3 centre = world(0, 0, selKind_ == 0 ? 0.9f : 0.4f * size);
    float closeD = std::max(3.2f, size * 2.2f);
    if (v == "closeup") s.camera.setImmediate(centre, baseYaw + 0.55f, 14.f * deg, closeD);
    else if (v == "front") s.camera.setImmediate(centre, baseYaw, 6.f * deg, closeD);
    else if (v == "rear") s.camera.setImmediate(centre, baseYaw + kPi, 6.f * deg, closeD);
    else if (v == "side") s.camera.setImmediate(centre, baseYaw - 0.5f * kPi, 6.f * deg, closeD);
    else if (v == "top") s.camera.setImmediate(centre, baseYaw, 88.f * deg, closeD * 1.2f);
    else if (v == "lineup") s.camera.setImmediate(world(-2.f, kLineupZ, 0.9f), frameYaw_ + 0.25f, 12.f * deg, 15.f);
    else if (v == "rts110") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 110.f);
    else if (v == "rts300") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 300.f);
    else if (v == "rts45") s.camera.setImmediate(world(-1.f, kLineupZ), frameYaw_ + 0.6f, 52.f * deg, 45.f);
    else if (v == "props") s.camera.setImmediate(world(0.f, kPropsZ - 0.5f * kPropsRowGap, 0.8f), frameYaw_ + kPi - 0.25f, 24.f * deg, 24.f);
    else if (v == "parachute") s.camera.setImmediate(world(kChuteX, 0, 9.f), frameYaw_ - 0.5f, 6.f * deg, 34.f);
    else return false;
    lastView_ = v;
    return true;
}

void MilitaryLab::update(AppState& s, float dt) {
    // headless captures: --lab-views v1,v2,.. applied a few frames before the matching --shots frame
    if (!s.opt.labViews.empty() && !s.opt.shotFrames.empty()) {
        for (size_t k = 0; k < s.opt.shotFrames.size() && k < s.opt.labViews.size(); ++k)
            if ((int)s.frameIndex == std::max(0, s.opt.shotFrames[k] - 8)) {
                const std::string& v = s.opt.labViews[k];
                // view[:option]: "+studio", "+notilt", "+flash", "+walk", "+select=<i>" / "+prop=<i>"
                std::string name = v.substr(0, v.find('+'));
                s.renderSettings.studioLighting = v.find("+studio") != std::string::npos;
                s.renderSettings.tiltShift = v.find("+notilt") == std::string::npos;
                holdFlash_ = v.find("+flash") != std::string::npos;
                holdTracer_ = holdFlash_;
                if (holdFlash_) { tracers_.clear(); tracers_.push_back({muzzleWorld_, {std::sin(worldYaw(0)), 0, std::cos(worldYaw(0))}, 0.f}); }
                size_t p = v.find("+prop=");
                if (p != std::string::npos) { selKind_ = 1; selIndex_ = std::atoi(v.c_str() + p + 6); }
                p = v.find("+inf=");
                if (p != std::string::npos) { selKind_ = 0; selIndex_ = std::atoi(v.c_str() + p + 5); }
                p = v.find("+chute=");
                if (p != std::string::npos) { chuteTime_ = (float)std::atof(v.c_str() + p + 7); chutePlaying_ = false; }
                p = v.find("+clip=");
                if (p != std::string::npos) { clip_ = std::atoi(v.c_str() + p + 6); animTime_ = 0.6f; }
                applyView(s, name);
                SDL_Log("military lab: shot %zu at frame %d: view %s", k, s.opt.shotFrames[k], v.c_str());
                s.cityRenderer.flush(s.camera, (float)s.opt.width / (float)std::max(1, s.opt.height));
            }
    }
    if (turntable_) turnAngle_ = std::fmod(turnAngle_ + dt * 0.6f, 2.f * kPi);
    const MilInfantry* sel = selKind_ == 0 && selIndex_ < (int)lib_.infantry.size() ? &lib_.infantry[(size_t)selIndex_] : nullptr;
    MilClip clip = sel && clip_ < (int)sel->clips.size() ? sel->clips[(size_t)clip_] : MilClip{};
    if (playing_ && clip.available) {
        animTime_ += dt * animSpeed_;
        if (animTime_ > clip.length) {
            if (loop_) animTime_ = std::fmod(animTime_, std::max(0.01f, clip.length));
            else { animTime_ = clip.length; playing_ = false; }
        }
    }
    if (chutePlaying_) {
        chuteTime_ += dt;
        if (chuteTime_ > kChuteDrop + kChuteLand + kChuteCollapse + kChuteHold) chuteTime_ = 0.f;
    }
    flashTimer_ = std::max(0.f, flashTimer_ - dt);
    for (Tracer& t : tracers_) if (!holdTracer_) t.age += dt;
    tracers_.erase(std::remove_if(tracers_.begin(), tracers_.end(), [](const Tracer& t) { return t.age > 0.5f; }), tracers_.end());

    // ---- characters + attachments (pose on the GPU)
    MilPoseU& U = *(MilPoseU*)poseU_.data();
    std::memset(&U, 0, sizeof(U));
    charCount_ = attCount_ = 0;
    attDraws_.clear();
    auto addChar = [&](const MilInfantry& inf, float lx, float lz, float localYaw, const MilClip& c, float t, bool fxOn) {
        if (charCount_ >= kMaxChars) return;
        uint32_t ci = charCount_++;
        V3 p = world(lx, lz);
        MilCharU& C = U.chars[ci];
        C.posYaw[0] = p.x; C.posYaw[1] = p.y; C.posYaw[2] = p.z; C.posYaw[3] = worldYaw(localYaw);
        C.anim[0] = (float)(c.available ? c.anim : 8u); C.anim[1] = t;
        C.anim[2] = c.length > 0 ? t / c.length * 2.f * kPi : 0.f; C.anim[3] = c.speed;
        C.look[0] = inf.lookX; C.look[1] = inf.lookY; C.look[2] = inf.ownBody ? 1u : 0u; C.look[3] = (uint32_t)(ci * 389u);
        for (size_t a = 0; a < inf.atts.size() && attCount_ < kMaxAtts; ++a) {
            const MilAttachment& A = inf.atts[a];
            if (A.model < 0) continue;
            MilAttU& O = U.atts[attCount_];
            O.info[0] = ci; O.info[1] = (uint32_t)A.slot; O.info[2] = (A.fx && !fxOn) ? 1u : 0u;
            std::memcpy(O.offset, A.offset, sizeof(A.offset));
            std::memcpy(O.quat, A.quat, sizeof(A.quat));
            attDraws_.push_back({&meshes_[(size_t)A.model], attCount_, 1});
            ++attCount_;
        }
        if (fxOn || ci == 0) {   // muzzle (rest-pose approximation: lights / tracer origin)
            float yaw = C.posYaw[3], cy = std::cos(yaw), sy = std::sin(yaw);
            float mx = (-3.f + inf.muzzle[0]) * bodyVoxel_, my = (10.f + inf.muzzle[1]) * bodyVoxel_, mz = inf.muzzle[2] * bodyVoxel_;
            muzzleWorld_ = {p.x + mx * cy + mz * sy, p.y + my, p.z - mx * sy + mz * cy};
        }
    };
    const bool flashOn = holdFlash_ || flashTimer_ > 0.f;
    if (sel) addChar(*sel, 0, 0, turntable_ ? turnAngle_ : 0.f, clip, animTime_, flashOn);
    if (showLineup_) {
        float x = -11.f + 3 * 1.3f + 0.4f;
        for (size_t i = 0; i < lib_.infantry.size(); ++i, x += 1.3f) {
            const MilInfantry& inf = lib_.infantry[i];
            MilClip c = lineupAnimated_ && clip_ < (int)inf.clips.size() ? inf.clips[(size_t)clip_] : inf.clips[1];
            addChar(inf, x, kLineupZ, 0.f, c, lineupAnimated_ ? animTime_ : s.renderTime + i * 0.7, false);
        }
    }
    U.cfg[0] = charCount_; U.cfg[1] = attCount_;
    U.params[0] = bodyVoxel_;

    // ---- CPU instances: props, helpers, parachute demo, tracers (after the attachment block), lineup vehicles
    cpuInst_.assign(kMaxAtts, CityRenderer::GpuInstance{});
    milDraws_.clear();
    vehDraws_.clear();
    auto put = [&](int model, V3 p, float yaw, std::vector<CityRenderer::ExtDraw>& list, const CityRenderer::GpuMesh* mesh = nullptr,
                   const float* qOverride = nullptr) {
        if (cpuInst_.size() >= kMaxInst) return;
        CityRenderer::GpuInstance gi{};
        gi.pos[0] = p.x; gi.pos[1] = p.y; gi.pos[2] = p.z; gi.pos[3] = mesh ? 0.f : 1.f;
        if (qOverride) std::memcpy(gi.quat, qOverride, sizeof(gi.quat));
        else yawQuat(yaw, gi.quat);
        list.push_back({mesh ? mesh : &meshes_[(size_t)model], (uint32_t)cpuInst_.size(), 1});
        cpuInst_.push_back(gi);
    };
    auto putProp = [&](const MilProp& p, float lx, float lz, float localYaw) {
        if (p.parts.empty()) { put(p.model, world(lx, lz), worldYaw(localYaw), milDraws_); return; }
        float yaw = worldYaw(localYaw), c = std::cos(yaw), sn = std::sin(yaw);
        V3 o = world(lx, lz);
        for (const auto& [m, pv] : p.parts) put(m, {o.x + pv[0] * c + pv[2] * sn, o.y + pv[1], o.z - pv[0] * sn + pv[2] * c}, yaw, milDraws_);
    };
    if (selKind_ == 1 && selIndex_ < (int)lib_.props.size()) putProp(lib_.props[(size_t)selIndex_], 0, 0, turntable_ ? turnAngle_ : 0.f);
    if (showProps_) {
        // rows of at most kPropsRow metres, behind the lineup (best seen from behind: "props row" view)
        float x = 0, z = kPropsZ;
        std::vector<std::pair<const MilProp*, float>> row;
        auto flushRow = [&]() {
            for (auto& [pp, px] : row) putProp(*pp, px - 0.5f * x, z, kPi);
            row.clear(); x = 0; z -= kPropsRowGap;
        };
        for (const MilProp& p : lib_.props) {
            if (x + p.footprint[0] > kPropsRow && !row.empty()) flushRow();
            row.push_back({&p, x + 0.5f * p.footprint[0]});
            x += p.footprint[0] + 0.8f;
        }
        flushRow();
    }
    if (showGrid_ && lib_.gridModel >= 0) put(lib_.gridModel, world(0, 0), worldYaw(0), milDraws_);
    if (showRuler_ && lib_.rulerModel >= 0) {
        put(lib_.rulerModel, world(1.4f, 0.3f), worldYaw(0), milDraws_);
        put(lib_.rulerModel, world(-12.f, kLineupZ + 0.6f), worldYaw(0), milDraws_);
    }
    {   // parachute supply drop: descent (sway) -> landing (canopy keeps sinking) -> collapse (tilts over, drapes)
        float t = chuteTime_, h0 = 30.f;
        V3 base = world(kChuteX, 0);
        float crateY, sway = 0.f, tilt = 0.f;
        bool collapsed = false;
        float canopyDrop = 0.f;
        if (t < kChuteDrop) { crateY = h0 * (1.f - t / kChuteDrop); sway = 0.12f * std::sin(t * 1.7f); }
        else {
            crateY = 0.f;
            float u = t - kChuteDrop;
            if (u < kChuteLand) canopyDrop = 1.5f * u / kChuteLand;
            else if (u < kChuteLand + kChuteCollapse) { float c = (u - kChuteLand) / kChuteCollapse; canopyDrop = 1.5f + 3.f * c; tilt = c * 1.35f; }
            else collapsed = true;
        }
        put(lib_.dropCrateModel, {base.x, base.y + crateY, base.z}, worldYaw(0.3f), milDraws_);
        if (collapsed) put(lib_.chuteCollapsedModel, world(kChuteX + 2.6f, 0.f), worldYaw(0.f), milDraws_);
        else {
            float q[4], qy[4], qt[4];
            yawQuat(worldYaw(0.3f), qy);
            float a = sway + tilt;   // about the local Z axis through the harness point
            qt[0] = 0; qt[1] = 0; qt[2] = std::sin(-0.5f * a); qt[3] = std::cos(-0.5f * a);
            q[0] = qy[3] * qt[0] + qy[0] * qt[3] + qy[1] * qt[2] - qy[2] * qt[1];
            q[1] = qy[3] * qt[1] - qy[0] * qt[2] + qy[1] * qt[3] + qy[2] * qt[0];
            q[2] = qy[3] * qt[2] + qy[0] * qt[1] - qy[1] * qt[0] + qy[2] * qt[3];
            q[3] = qy[3] * qt[3] - qy[0] * qt[0] - qy[1] * qt[1] - qy[2] * qt[2];
            put(lib_.chuteOpenModel, {base.x, base.y + crateY + 0.9f - canopyDrop, base.z}, 0.f, milDraws_, nullptr, q);
        }
    }
    for (const Tracer& tr : tracers_) {
        float dist = holdTracer_ ? 3.f : tr.age * 160.f;
        V3 p = tr.p + tr.d * dist;
        put(lib_.tracerModel, p, std::atan2(tr.d.x, tr.d.z), milDraws_);
    }
    vehFirst_ = (uint32_t)cpuInst_.size();
    if (showLineup_ && showVehicles_) {   // existing civilian vehicle models at the same scale, side by side
        float x = -11.f + 3 * 1.3f + 0.4f + lib_.infantry.size() * 1.3f + 1.6f;
        for (const char* want : {"sedan|ok", "pickup|ok", "police|ok"}) {
            size_t v = 0;
            while (v < s.city.variants.size() && s.city.variants[v].name.rfind(want, 0) != 0) ++v;
            const CityRenderer::GpuMesh* m = city_->vehicleModel(v);
            if (!m) continue;
            float len = std::min(6.f, 1.8f * m->radius);
            put(-1, world(x + 0.5f * len, kLineupZ - 0.3f), worldYaw(0.5f * kPi), vehDraws_, m);
            x += len + 0.6f;
        }
    }
}

void MilitaryLab::injectLights(std::vector<PointLight>& lights) const {
    if (!(holdFlash_ || flashTimer_ > 0.f) || suppressed_) return;
    if (lights.size() >= (size_t)kMaxLights) lights.pop_back();
    lights.insert(lights.begin(), PointLight{muzzleWorld_.x, muzzleWorld_.y, muzzleWorld_.z, 5.f, 1.f, 0.75f, 0.4f, 1.2f});
}

void MilitaryLab::prepare(SDL_GPUCommandBuffer* cmd) {
    if (!gpu_) return;
    {   // pose inputs (characters + attachments) and the CPU instances, one copy pass
        uint32_t bytes = cpuInst_.size() > kMaxAtts ? (uint32_t)((cpuInst_.size() - kMaxAtts) * sizeof(CityRenderer::GpuInstance)) : 0u;
        const uint32_t poseBytes = (uint32_t)poseU_.size();
        uint8_t* dst = (uint8_t*)SDL_MapGPUTransferBuffer(gpu_->device(), instTB_, true);
        std::memcpy(dst, poseU_.data(), poseBytes);
        if (bytes) std::memcpy(dst + poseBytes, cpuInst_.data() + kMaxAtts, bytes);
        SDL_UnmapGPUTransferBuffer(gpu_->device(), instTB_);
        SDL_GPUCopyPass* cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTransferBufferLocation src{instTB_, 0};
        SDL_GPUBufferRegion r0{poseBuf_, 0, poseBytes};
        SDL_UploadToGPUBuffer(cp, &src, &r0, true);
        if (bytes) {
            SDL_GPUTransferBufferLocation src1{instTB_, poseBytes};
            SDL_GPUBufferRegion r{insts_, kMaxAtts * (uint32_t)sizeof(CityRenderer::GpuInstance), bytes};
            SDL_UploadToGPUBuffer(cp, &src1, &r, true);
        }
        SDL_EndGPUCopyPass(cp);
    }
    if (charCount_) dispatch(Dispatch{cmd, pPose_, {poseBuf_}, {segs_, insts_}, nullptr, 0}, 1);
}

void MilitaryLab::draw(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* decals, SDL_GPUBuffer* shadow, SDL_GPUBuffer* corpseH) {
    if (!gpu_) return;
    if (charCount_) {
        chars_->setShadowField(shadow);
        chars_->drawExternal(cmd, pass, *sim_, segs_, charCount_ * 10);
    }
    std::vector<CityRenderer::ExtDraw> mil = attDraws_;
    mil.insert(mil.end(), milDraws_.begin(), milDraws_.end());
    city_->drawExternal(pass, cmd, mats_, insts_, decals, shadow, corpseH, mil);
    city_->drawExternal(pass, cmd, city_->materials(), insts_, decals, shadow, corpseH, vehDraws_);
}

// ---------------------------------------------------------------------------------------------------------------
void MilitaryLab::drawUI(AppState& s) {
    ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + vp->WorkSize.x - 12.f, vp->WorkPos.y + 12.f), ImGuiCond_FirstUseEver, ImVec2(1.f, 0.f));
    ImGui::SetNextWindowSize(ImVec2(400.f * ImGui::GetIO().FontGlobalScale, vp->WorkSize.y * 0.9f), ImGuiCond_FirstUseEver);
    ImGui::Begin("Military Asset Lab", nullptr, ImGuiWindowFlags_NoFocusOnAppearing);
    ImGui::TextDisabled("source: %s", lib_.source.c_str());
    ImGui::TextDisabled("spot (%.0f, %.0f)  F1 hides the UI  MMB / Alt+LMB orbit  RMB pan  wheel zoom", ox_, oz_);

    if (ImGui::CollapsingHeader("Asset browser", ImGuiTreeNodeFlags_DefaultOpen)) {
        ImGui::BeginChild("assets", ImVec2(0, 220.f * ImGui::GetIO().FontGlobalScale), ImGuiChildFlags_Borders);
        if (ImGui::TreeNodeEx("Infantry", ImGuiTreeNodeFlags_DefaultOpen)) {
            std::string cls;
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
        if (selKind_ == 0 && selIndex_ < (int)lib_.infantry.size()) {
            const MilInfantry& inf = lib_.infantry[(size_t)selIndex_];
            ImGui::Text("attachments:");
            for (const MilAttachment& a : inf.atts) {
                static const char* slots[10] = {"head", "torso", "upperArmL", "forearmL", "upperArmR", "forearmR", "thighL", "shinL", "thighR", "shinR"};
                ImGui::BulletText("%s -> %s (%.1f, %.1f, %.1f)%s", a.name.c_str(), slots[std::clamp(a.slot, 0, 9)], a.offset[0], a.offset[1],
                                  a.offset[2], a.fx ? " [fx]" : "");
            }
        } else if (selKind_ == 1 && selIndex_ < (int)lib_.props.size()) {
            const MilVoxelModel& m = lib_.models[(size_t)lib_.props[(size_t)selIndex_].model];
            ImGui::Text("%d x %d x %d voxels of %.2f m  (%.2f x %.2f x %.2f m)", m.nx, m.ny, m.nz, m.voxel, m.nx * m.voxel, m.ny * m.voxel, m.nz * m.voxel);
        }
        ImGui::Checkbox("turntable", &turntable_);
    }
    if (ImGui::CollapsingHeader("Camera", ImGuiTreeNodeFlags_DefaultOpen)) {
        const char* views[] = {"closeup", "front", "rear", "side", "top"};
        for (int i = 0; i < 5; ++i) { if (i) ImGui::SameLine(); if (ImGui::Button(views[i])) applyView(s, views[i]); }
        if (ImGui::Button("RTS 45 m")) applyView(s, "rts45");
        ImGui::SameLine(); if (ImGui::Button("RTS 110 m")) applyView(s, "rts110");
        ImGui::SameLine(); if (ImGui::Button("RTS 300 m")) applyView(s, "rts300");
        if (ImGui::Button("lineup")) applyView(s, "lineup");
        ImGui::SameLine(); if (ImGui::Button("props row")) applyView(s, "props");
        ImGui::SameLine(); if (ImGui::Button("parachute")) applyView(s, "parachute");
        ImGui::Text("distance %.1f m  pitch %.0f deg", s.camera.distance(), s.camera.pitch() * 180.f / kPi);
        if (ImGui::Checkbox("RTS rig (F2 off = free orbit)", &s.debugCam)) {}
    }
    if (ImGui::CollapsingHeader("Lighting & display", ImGuiTreeNodeFlags_DefaultOpen)) {
        int light = s.renderSettings.studioLighting ? 1 : 0;
        ImGui::RadioButton("in-game night", &light, 0);
        ImGui::SameLine(); ImGui::RadioButton("neutral studio", &light, 1);
        s.renderSettings.studioLighting = light == 1;
        ImGui::Checkbox("tilt-shift", &s.renderSettings.tiltShift);
        ImGui::SameLine(); ImGui::Checkbox("shadows", &s.renderSettings.shadows);
        ImGui::SliderFloat("fog density", &s.renderSettings.fogDensity, 0.f, 0.004f, "%.4f");
        if (ImGui::Checkbox("comparison lineup", &showLineup_)) setupScene(s);
        ImGui::SameLine(); ImGui::Checkbox("vehicles", &showVehicles_);
        ImGui::SameLine(); if (ImGui::Checkbox("zombies", &lineupZombies_)) setupScene(s);
        ImGui::Checkbox("props row", &showProps_);
        ImGui::SameLine(); ImGui::Checkbox("grid", &showGrid_);
        ImGui::SameLine(); ImGui::Checkbox("scale ruler (2 m)", &showRuler_);
        ImGui::SliderFloat("exposure", &s.renderSettings.exposure, 0.5f, 3.f);
    }
    if (ImGui::CollapsingHeader("Animation", ImGuiTreeNodeFlags_DefaultOpen)) {
        if (selKind_ == 0 && selIndex_ < (int)lib_.infantry.size()) {
            const MilInfantry& inf = lib_.infantry[(size_t)selIndex_];
            ImGui::BeginChild("clips", ImVec2(0, 130.f * ImGui::GetIO().FontGlobalScale), ImGuiChildFlags_Borders);
            for (size_t i = 0; i < inf.clips.size(); ++i) {
                const MilClip& c = inf.clips[i];
                ImGui::BeginDisabled(!c.available);
                std::string label = c.name + (c.available ? "" : "  (slot: infantry animation step)") + "##clip" + std::to_string(i);
                if (ImGui::Selectable(label.c_str(), clip_ == (int)i)) { clip_ = (int)i; animTime_ = 0; playing_ = true; loop_ = c.loop; }
                ImGui::EndDisabled();
            }
            ImGui::EndChild();
            const MilClip& c = inf.clips[(size_t)std::clamp(clip_, 0, (int)inf.clips.size() - 1)];
            if (ImGui::Button(playing_ ? "pause" : "play")) playing_ = !playing_;
            ImGui::SameLine(); ImGui::Checkbox("loop", &loop_);
            ImGui::SameLine(); ImGui::Checkbox("lineup plays it", &lineupAnimated_);
            ImGui::SliderFloat("speed", &animSpeed_, 0.05f, 2.f, "%.2fx");
            if (ImGui::SliderFloat("time", &animTime_, 0.f, c.length, "%.2f s")) playing_ = false;
        } else ImGui::TextDisabled("select an infantry asset");
        ImGui::SeparatorText("supply drop (descent -> landing -> collapse)");
        const float total = kChuteDrop + kChuteLand + kChuteCollapse + kChuteHold;
        ImGui::Checkbox("play##chute", &chutePlaying_);
        ImGui::SameLine();
        if (ImGui::Button("restart##chute")) chuteTime_ = 0;
        if (ImGui::SliderFloat("timeline", &chuteTime_, 0.f, total, "%.2f s")) chutePlaying_ = false;
        ImGui::TextDisabled("phase: %s", chuteTime_ < kChuteDrop ? "descent" : chuteTime_ < kChuteDrop + kChuteLand ? "landing"
                                         : chuteTime_ < kChuteDrop + kChuteLand + kChuteCollapse ? "collapse" : "settled");
    }
    if (ImGui::CollapsingHeader("FX preview (stubs)", ImGuiTreeNodeFlags_DefaultOpen)) {
        auto fire = [&](bool supp) {
            suppressed_ = supp;
            flashTimer_ = supp ? 0.f : 0.07f;
            float yaw = worldYaw(turntable_ ? turnAngle_ : 0.f);
            tracers_.push_back({muzzleWorld_, {std::sin(yaw), 0.f, std::cos(yaw)}, 0.f});
        };
        if (ImGui::Button("muzzle flash + tracer")) fire(false);
        ImGui::SameLine(); if (ImGui::Button("suppressed shot")) fire(true);
        ImGui::Checkbox("hold flash", &holdFlash_);
        ImGui::SameLine(); ImGui::Checkbox("freeze tracer", &holdTracer_);
        ImGui::TextDisabled("voxel flash attachment + point light + emissive tracer; full FX with the animation step");
    }
    ImGui::End();
}

} // namespace ttz
