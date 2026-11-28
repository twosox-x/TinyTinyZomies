// Corpse gas / ground fire rendering (GAME_DESIGN 14d). See CorpseGasRender.h.
#include "game/CorpseGasRender.h"

#include "app/App.h"
#include "game/CorpseGas.h"
#include "render/Renderer.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <array>
#include <cmath>

namespace ttz::game {

namespace {
struct GasDraw {   // std140, == GasDraw in shaders/gas.vert
    float origin[4];
    uint32_t dim[4];
    float style[4];
};
struct GasVolumeUniforms {   // std140, == GasVolumes in shaders/include/gas_volume.glsl
    float lo[CorpseGasRender::kMaxGasBoxes][4];
    float hi[CorpseGasRender::kMaxGasBoxes][4];
    float origin[4];
    uint32_t dim[4];
    float style[4];
};
} // namespace

bool CorpseGasRender::init(AppState& app, CorpseGas& gas) {
    app_ = &app;
    gas_ = &gas;
    GpuContext& gpu = app.gpu;
    SDL_GPUShader* v = gpu.loadShader("gas.vert", SDL_GPU_SHADERSTAGE_VERTEX);
    SDL_GPUShader* f = gpu.loadShader("gas.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
    if (!v || !f) return false;
    SDL_GPUGraphicsPipelineCreateInfo ci{};
    ci.vertex_shader = v;
    ci.fragment_shader = f;
    ci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    ci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    ci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
    ci.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    ci.multisample_state.sample_count = app.renderer.msaaSamples() == 4 ? SDL_GPU_SAMPLECOUNT_4 : SDL_GPU_SAMPLECOUNT_1;
    ci.depth_stencil_state.enable_depth_test = true;
    ci.depth_stencil_state.enable_depth_write = false;   // translucent haze: never hides what is behind / inside it
    ci.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
    SDL_GPUColorTargetDescription ctd{};
    ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;   // == Renderer kColorFormat
    ctd.blend_state.enable_blend = true;
    ctd.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_SRC_ALPHA;
    ctd.blend_state.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    ctd.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    ctd.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ZERO;   // keep the scene alpha (depth-of-field CoC)
    ctd.blend_state.dst_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    ctd.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    ci.target_info.color_target_descriptions = &ctd;
    ci.target_info.num_color_targets = 1;
    ci.target_info.depth_stencil_format = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;   // == Renderer kDepthFormat
    ci.target_info.has_depth_stencil_target = true;
    pipe_ = SDL_CreateGPUGraphicsPipeline(gpu.device(), &ci);
    SDL_ReleaseGPUShader(gpu.device(), v);
    SDL_ReleaseGPUShader(gpu.device(), f);
    if (!pipe_) { SDL_Log("corpse gas: pipeline: %s", SDL_GetError()); return false; }
    {   // gas voxel fog: the boxes' near faces (back-face culling), depth tested, no depth write, blended like the haze
        SDL_GPUShader* gv = gpu.loadShader("gas_volume.vert", SDL_GPU_SHADERSTAGE_VERTEX);
        SDL_GPUShader* gf = gpu.loadShader("gas_volume.frag", SDL_GPU_SHADERSTAGE_FRAGMENT);
        if (gv && gf) {
            ci.vertex_shader = gv;
            ci.fragment_shader = gf;
            pipeVol_ = SDL_CreateGPUGraphicsPipeline(gpu.device(), &ci);
        }
        if (gv) SDL_ReleaseGPUShader(gpu.device(), gv);
        if (gf) SDL_ReleaseGPUShader(gpu.device(), gf);
        if (!pipeVol_) SDL_Log("corpse gas: volume pipeline: %s (legacy puffs)", SDL_GetError());   // not fatal
    }
    Renderer::Extension e;
    e.draw = [this](SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer*, SDL_GPUBuffer*, SDL_GPUBuffer* corpseH) {
        if (!gas_ || !gas_->listBuffer() || !app_) return;
        drawGasVolume(pass, cmd, corpseH);
        const CrowdSim& sim = app_->sim;
        const SimUniforms su = sim.uniforms();
        GasDraw u{};
        u.origin[0] = su.world.x; u.origin[1] = su.world.y; u.origin[2] = gas_->cellSize(); u.origin[3] = su.world.z;
        u.dim[0] = (uint32_t)gas_->width(); u.dim[1] = (uint32_t)gas_->height(); u.dim[2] = su.grid.x; u.dim[3] = su.grid.y;
        u.style[0] = hazeAlpha; u.style[1] = (float)app_->renderTime; u.style[2] = voxelFog && pipeVol_ ? 0.f : 1.f; u.style[3] = 1.0f;
        SDL_BindGPUGraphicsPipeline(pass, pipe_);
        SDL_GPUBuffer* vb[4] = {gas_->listBuffer(), gas_->fieldBuffer(), sim.staticHeight(), corpseH ? corpseH : sim.corpseHeight()};
        SDL_BindGPUVertexStorageBuffers(pass, 0, vb, 4);
        SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
        SDL_DrawGPUPrimitivesIndirect(pass, gas_->listBuffer(), 0, 1);
    };
    ext_ = app.renderer.addExtension(e);
    return true;
}

void CorpseGasRender::shutdown(AppState& app) {
    if (ext_) app.renderer.removeExtension(ext_);
    ext_ = 0;
    if (pipe_) SDL_ReleaseGPUGraphicsPipeline(app.gpu.device(), pipe_);
    if (pipeVol_) SDL_ReleaseGPUGraphicsPipeline(app.gpu.device(), pipeVol_);
    pipe_ = pipeVol_ = nullptr;
    gas_ = nullptr;
}

// Gas voxel fog boxes (shaders/gas_volume.*): every gas cell of the latest readback above a trace marks its square,
// inflated by 3 m (bilinear spread + the shader's domain warp), in each fixed 16 m world tile it overlaps; one box per
// tile, clamped to the tile and snapped to the 1 m world grid (adjacent boxes share faces, never overlap, and their
// voxel grids line up: no seams), from the lowest ground under the gas to the highest + the tallest fog top. The
// nearest kMaxGasBoxes to the camera are drawn, far to near (translucent "over" compositing).
void CorpseGasRender::drawGasVolume(SDL_GPURenderPass* pass, SDL_GPUCommandBuffer* cmd, SDL_GPUBuffer* corpseH) {
    gasBoxes_ = 0;
    if (!voxelFog || !pipeVol_ || !gas_->ready() || gas_->stats().maxGas < 0.01f) return;
    constexpr float kTile = 16.f, kPad = 3.f, kMin = 0.01f;
    struct Box { int tx, tz; float x0, z0, x1, z1, y0, y1, g, d; };   // g: lowest ground under the gas
    std::vector<Box> boxes;
    const float cs = gas_->cellSize(), ox = gas_->originX(), oz = gas_->originZ();
    for (int j = 0; j < gas_->height(); ++j)
        for (int i = 0; i < gas_->width(); ++i) {
            const float cx = ox + ((float)i + 0.5f) * cs, cz = oz + ((float)j + 0.5f) * cs;
            const GasCell c = gas_->at(cx, cz);
            if (c.gas < kMin) continue;
            const float gy = groundY(cx, cz);
            const float top = gy + (0.5f + 0.85f * std::sqrt(std::min(c.gas * 4.f, 3.f))) * 1.3f + 1.2f;   // == gas_volume.frag + corpse pile
            const float ax0 = cx - 0.5f * cs - kPad, ax1 = cx + 0.5f * cs + kPad, az0 = cz - 0.5f * cs - kPad, az1 = cz + 0.5f * cs + kPad;
            for (int tz = (int)std::floor(az0 / kTile); tz <= (int)std::floor(az1 / kTile); ++tz)
                for (int tx = (int)std::floor(ax0 / kTile); tx <= (int)std::floor(ax1 / kTile); ++tx) {
                    auto it = std::find_if(boxes.begin(), boxes.end(), [&](const Box& b) { return b.tx == tx && b.tz == tz; });
                    if (it == boxes.end()) { boxes.push_back({tx, tz, 1e9f, 1e9f, -1e9f, -1e9f, 1e9f, -1e9f, 1e9f, 0.f}); it = boxes.end() - 1; }
                    it->x0 = std::min(it->x0, std::max(ax0, tx * kTile)); it->x1 = std::max(it->x1, std::min(ax1, (tx + 1) * kTile));
                    it->z0 = std::min(it->z0, std::max(az0, tz * kTile)); it->z1 = std::max(it->z1, std::min(az1, (tz + 1) * kTile));
                    it->y0 = std::min(it->y0, gy - 0.5f); it->y1 = std::max(it->y1, top);
                    it->g = std::min(it->g, gy);
                }
        }
    if (boxes.empty()) return;
    const V3 eye = app_->camera.eye();
    for (Box& b : boxes) {
        b.x0 = std::floor(b.x0); b.z0 = std::floor(b.z0); b.x1 = std::ceil(b.x1); b.z1 = std::ceil(b.z1);
        b.y0 = std::floor(b.y0); b.y1 = std::ceil(b.y1);
        const float dx = 0.5f * (b.x0 + b.x1) - eye.x, dz = 0.5f * (b.z0 + b.z1) - eye.z;
        b.d = dx * dx + dz * dz;
    }
    std::sort(boxes.begin(), boxes.end(), [](const Box& a, const Box& b) { return a.d < b.d; });
    if ((int)boxes.size() > kMaxGasBoxes) boxes.resize(kMaxGasBoxes);
    std::reverse(boxes.begin(), boxes.end());   // far to near
    GasVolumeUniforms u{};
    for (size_t k = 0; k < boxes.size(); ++k) {
        const Box& b = boxes[k];
        u.lo[k][0] = b.x0; u.lo[k][1] = b.y0; u.lo[k][2] = b.z0; u.lo[k][3] = b.g;
        u.hi[k][0] = b.x1; u.hi[k][1] = b.y1; u.hi[k][2] = b.z1;
    }
    const CrowdSim& sim = app_->sim;
    const SimUniforms su = sim.uniforms();
    u.origin[0] = su.world.x; u.origin[1] = su.world.y; u.origin[2] = gas_->cellSize(); u.origin[3] = su.world.z;
    u.dim[0] = (uint32_t)gas_->width(); u.dim[1] = (uint32_t)gas_->height(); u.dim[2] = su.grid.x; u.dim[3] = su.grid.y;
    // voxel LOD: ~4 px per voxel at a 720-line reference (0.25 m to ~57 m, 0.5 m to ~115 m, 1 m beyond)
    const float voxPerM = 2.f * std::tan(app_->camera.settings.fovY * 0.5f) / 720.f * 4.f;
    u.style[0] = hazeAlpha; u.style[1] = (float)app_->renderTime; u.style[2] = voxPerM; u.style[3] = gasMaxAlpha;
    SDL_BindGPUGraphicsPipeline(pass, pipeVol_);
    SDL_GPUBuffer* fb[3] = {gas_->fieldBuffer(), sim.staticHeight(), corpseH ? corpseH : sim.corpseHeight()};
    SDL_BindGPUFragmentStorageBuffers(pass, 0, fb, 3);
    SDL_PushGPUVertexUniformData(cmd, 1, &u, sizeof(u));
    SDL_PushGPUFragmentUniformData(cmd, 1, &u, sizeof(u));
    SDL_DrawGPUPrimitives(pass, 36, (uint32_t)boxes.size(), 0, 0);
    gasBoxes_ = (int)boxes.size();
}

void CorpseGasRender::noteFlames(const std::vector<FxEvent>& fx, double time, float range) {
    for (const FxEvent& e : fx) {
        if (e.kind != FxKind::Flame) continue;
        const uint32_t id = e.soldier.packed();
        auto it = std::find_if(streams_.begin(), streams_.end(), [&](const Stream& s) { return s.id == id; });
        if (it == streams_.end()) { streams_.push_back({}); it = streams_.end() - 1; it->id = id; it->start = time; }
        if (time - it->last > 0.6) it->start = time;   // a new burst
        it->o = e.pos; it->d = e.dir; it->last = time; it->range = range;
    }
    streams_.erase(std::remove_if(streams_.begin(), streams_.end(), [&](const Stream& s) { return time - s.last > 1.0; }), streams_.end());
}

float CorpseGasRender::visualReach(const Stream& s, double time) { return 0.85f * s.range * (float)std::clamp((time - s.start) / 0.2, 0.25, 1.0); }

// Ground height without vehicles (owner 14e: "fire puddles render on top of cars": the pools used the city's coarse
// 4 m max height, which includes parked cars) and the obstacle test (a parked car / wall above that ground).
float CorpseGasRender::groundY(float x, float z) const {
    if (!app_) return 0.f;
    const float g = app_->vehicles.groundAt(x, z);
    return g > -50.f && g < 60.f ? g : 0.f;
}
bool CorpseGasRender::onObstacle(float x, float z, float ground) const {
    if (!app_) return false;
    const float top = app_->vehicles.solidAt(x, z);
    return top > ground + 0.35f && top < 60.f;
}

// where the jet's centreline (fx_volume.glsl flameCentre: droop 0.0128 s^2) reaches the ground (~1.25 m below the nozzle)
bool CorpseGasRender::impact(const Stream& s, float reach, V3& out) const {
    float ground = s.o.y - 1.25f;
    if (app_) { const float h = groundY(s.o.x + s.d.x * reach, s.o.z + s.d.z * reach); if (h > ground - 3.f && h < ground + 1.f) ground = h; }
    for (float d = 0.5f; d <= reach + 0.01f; d += 0.25f) {
        const float y = s.o.y + s.d.y * d - 0.0128f * d * d;
        if (y <= ground + 0.15f || d + 0.25f > reach) {
            out = {s.o.x + s.d.x * d, ground, s.o.z + s.d.z * d};
            if (onObstacle(out.x, out.z, ground)) return false;   // owner 14e: never a puddle on a car roof
            return y <= ground + 0.6f;   // a jet ending in the air makes no pool
        }
    }
    return false;
}

void CorpseGasRender::flameLights(double time, std::vector<PointLight>& out) const {
    for (const Stream& s : streams_) {
        if (time - s.last > 0.45) continue;
        const float reach = visualReach(s, time);
        const float fl = 0.8f + 0.12f * std::sin((float)time * 37.f + (float)(s.id & 63u)) + 0.08f * std::sin((float)time * 23.f);
        const V3 m = s.o + s.d * (reach * 0.55f);
        out.push_back({m.x, m.y + 0.2f, m.z, 7.5f, 1.0f, 0.62f, 0.24f, 2.4f * fl});
        V3 hit;
        if (impact(s, reach, hit)) out.push_back({hit.x, hit.y + 0.4f, hit.z, 5.f, 1.0f, 0.55f, 0.18f, 1.6f * fl});
    }
    // ground-fire puddles keep lighting (and flickering) for as long as they burn (owner 14e: at night the light used
    // to stop with the jet while the puddle still burned): one warm light per pool drawn (flameVolumes' pool cache)
    for (const Pool& p : pools_) {
        const float ph = (float)(p.seed % 997u);
        const float fl = 0.72f + 0.16f * std::sin((float)time * 17.f + ph) + 0.12f * std::sin((float)time * 29.f + ph * 0.37f);
        out.push_back({p.x, p.y + 0.5f, p.z, 4.f + 2.f * p.r, 1.0f, 0.55f, 0.18f, (0.9f + 0.9f * p.k) * fl});
    }
}

void CorpseGasRender::flameVolumes(float camX, float camZ, double time, std::vector<FlameVolume>& out, int maxStreams, int maxPools) const {
    std::vector<const Stream*> live;
    for (const Stream& s : streams_) if (time - s.last < 0.45) live.push_back(&s);
    std::sort(live.begin(), live.end(), [&](const Stream* a, const Stream* b) {
        return (a->o.x - camX) * (a->o.x - camX) + (a->o.z - camZ) * (a->o.z - camZ) < (b->o.x - camX) * (b->o.x - camX) + (b->o.z - camZ) * (b->o.z - camZ);
    });
    for (size_t k = 0; k < live.size() && (int)k < maxStreams; ++k) {
        const Stream& s = *live[k];
        const float in = (float)std::clamp((time - s.start) / 0.12, 0.0, 1.0), outF = (float)std::clamp(1.0 - (time - s.last - 0.15) / 0.3, 0.0, 1.0);
        const float yaw = std::atan2(s.d.x, s.d.z), pitch = std::asin(std::clamp(s.d.y, -1.f, 1.f));
        // the jet grows to its reach over the first 0.2 s of a burst (visual reach ~0.85 x the weapon range: v4 ~7.5 m)
        const float reach = visualReach(s, time);
        const float str = std::min(in, outF);
        out.push_back({s.o.x, s.o.y, s.o.z, reach, yaw, pitch, str, s.id * 2654435761u, 2});
        V3 hit;
        if (impact(s, reach, hit)) out.push_back({hit.x, hit.y, hit.z, 0.5f, 0.f, 0.f, str, s.id * 747796405u, 3});   // pool where it lands
    }
    pools_.clear();
    if (!gas_) return;
    std::vector<std::array<float, 4>> spots;
    gas_->fireSpots(camX, camZ, maxPools, spots);
    for (const auto& p : spots) {
        // on the ground / road, never on a car: the centre moves off a parked car / wall to the nearest free spot
        // (rings of 0.375 m), the radius stops short of the nearest obstacle (8 directions)
        float x = p[0], z = p[2];
        float y = groundY(x, z);
        if (onObstacle(x, z, y)) {
            bool found = false;
            for (float r = 0.375f; r <= 1.5f && !found; r += 0.375f)
                for (int a = 0; a < 8 && !found; ++a) {
                    const float qx = p[0] + std::cos(a * 0.785398f) * r, qz = p[2] + std::sin(a * 0.785398f) * r;
                    const float qy = groundY(qx, qz);
                    if (!onObstacle(qx, qz, qy)) { x = qx; z = qz; y = qy; found = true; }
                }
            if (!found) continue;
        }
        float R = p[1];
        for (int a = 0; a < 8; ++a)
            for (float r = 0.375f; r < R; r += 0.25f)
                if (onObstacle(x + std::cos(a * 0.785398f) * r, z + std::sin(a * 0.785398f) * r, y)) { R = std::max(0.45f, std::min(R, r + 0.05f)); break; }
        // burning down: the remaining fire (strength) shrinks the puddle; a slow breathing of the outline on top
        const uint32_t seed = (uint32_t)(p[0] * 31.f + p[2] * 17.f);
        R *= (0.6f + 0.4f * std::min(p[3], 1.f)) * (1.f + 0.06f * std::sin((float)time * 0.9f + (float)(seed % 97u)));
        out.push_back({x, y + 0.05f, z, R, 0.f, 0.f, p[3], seed, 3});
        pools_.push_back({x, y, z, R, p[3], seed});
    }
}

} // namespace ttz::game
