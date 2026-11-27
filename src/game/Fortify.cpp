// B2 integration: walls, gates, containers as obstacles, territory, GPU counts, nav patches, drawing. See Fortify.h.
#include "game/Fortify.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/GameEvents.h"
#include "game/HordeInterface.h"
#include "game/Logistics.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"
#include "lab/MilitaryRenderer.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
constexpr float kContHalfX = 3.05f, kContHalfZ = 1.25f, kContTop = 2.6f;
}

Obb containerBox(const SupplyPoint& sp) {
    Obb o;
    o.cx = sp.pos.x; o.cz = sp.pos.z;
    o.hx = kContHalfX; o.hz = kContHalfZ;
    o.yaw = sp.yaw;
    o.top = kContTop;
    return o;
}

WallEnv makeWallEnv(const AppState& app, const GameContext& ctx) {
    WallEnv e;
    const CityVehicles* v = &app.vehicles;
    const HordeInterface* h = ctx.horde;
    e.ground = [v](float x, float z) { return v->groundAt(x, z); };
    e.solid = [v](float x, float z) { return v->solidAt(x, z); };
    e.simulated = [h](float x, float z) { return !h || h->simulated(x, z); };
    e.streetY = windowStreetLevel(app);
    if (ctx.logistics)
        for (const SupplyPoint& sp : ctx.logistics->points())
            if (sp.alive && sp.kind == SupplyKind::Container) e.containers.push_back(containerBox(sp));
    return e;
}

bool Fortifications::init(AppState& app, const BalanceConfig& cfg) {
    cfg_ = &cfg;
    walls_.configure(cfg.fort);
    territory_.configure(cfg.fort);
    gpuOk_ = gpu_.init(app.gpu, app.sim);
    if (!gpuOk_) SDL_Log("game: territory GPU counts unavailable (regions stay uncleared, walls take no pressure)");
    pressure_.assign(TerritoryGpu::kPieceSlots, 0u);
    computeStreetLevel(app);
    masksDirty_ = true;
    return true;
}

void Fortifications::shutdown() { if (gpuOk_) gpu_.shutdown(); gpuOk_ = false; }

float windowStreetLevel(const AppState& app) {
    static float cachedOx = 1e30f, cachedOz = 1e30f, cached = 0.f;   // per window position
    const Sandbox& sb = app.sandbox;
    if (sb.originX == cachedOx && sb.originZ == cachedOz) return cached;
    std::vector<float> h;
    for (int j = 0; j < 48; ++j)
        for (int i = 0; i < 48; ++i)
            h.push_back(app.vehicles.groundAt(sb.originX + (i + 0.5f) * sb.gridW * sb.cellSize / 48.f, sb.originZ + (j + 0.5f) * sb.gridH * sb.cellSize / 48.f));
    std::nth_element(h.begin(), h.begin() + h.size() / 5, h.end());
    cachedOx = sb.originX; cachedOz = sb.originZ;
    cached = h[h.size() / 5];   // 20th percentile of the window's ground: the street level
    return cached;
}

void Fortifications::computeStreetLevel(const AppState& app) { streetY_ = windowStreetLevel(app); }

bool Fortifications::containerAllowed(const GameContext& ctx, V3 pos, const char** why) const {
    if (!cfg_ || !cfg_->fort.containerNeedsTerritory) return true;
    const Region* r = territory_.regionAt(pos.x, pos.z);
    if (!r || r->state != RegionState::Controlled) { if (why) *why = "must be inside controlled territory"; return false; }
    return true;
}

bool Fortifications::build(AppState& app, GameContext& ctx, const Command& c, Economy& eco, std::string& msg) {
    std::vector<V3> pts = c.path;
    const WallPlan plan = walls_.plan(pts, (WallType)std::min<uint8_t>(c.wallType, 1), c.gate, makeWallEnv(app, ctx));
    if (!plan.valid) { msg = plan.reason; return false; }
    const char* what = c.gate ? "gate" : c.wallType ? "reinforced wall" : "wall";
    if (!eco.spend(plan.price, what, ctx.time)) { msg = "not enough funding"; return false; }
    const std::vector<uint32_t> added = walls_.commit(plan);
    syncObstacles(app, ctx);
    char t[96];
    std::snprintf(t, sizeof(t), "%s built: %.0f m, %zu piece%s ($%d)", c.gate ? "Gate" : c.wallType ? "Reinforced wall" : "Wall", plan.length, added.size(),
                  added.size() == 1 ? "" : "s", plan.price);
    msg = t;
    return true;
}

void Fortifications::syncObstacles(AppState& app, GameContext& ctx) {
    CityVehicles& V = app.vehicles;
    bool changed = false;
    // destroyed pieces: unstamp (the rows go up with the next vehicles update: zombies pour through the gap)
    for (WallPiece& p : walls_.pieces())
        if (!p.alive && p.obstacle != ~0u) { V.removeObstacle(p.obstacle); p.obstacle = ~0u; --obstacleCount_; changed = true; }
    for (WallNode& n : walls_.nodes())
        if (!n.alive && n.obstacle != ~0u) { V.removeObstacle(n.obstacle); n.obstacle = ~0u; --obstacleCount_; changed = true; }
    // new pieces / posts
    for (uint32_t i = 0; i < walls_.pieces().size(); ++i) {
        WallPiece& p = walls_.pieces()[i];
        if (!p.alive || p.obstacle != ~0u) continue;
        const Obb b = walls_.pieceBox(i);
        const float y = std::min(walls_.nodes()[p.a].y, walls_.nodes()[p.b].y);
        p.obstacle = V.addObstacle(b.cx, b.cz, b.hx, b.hz, b.yaw, y + b.top);
        ++obstacleCount_;
        changed = true;
    }
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n) {
        WallNode& nd = walls_.nodes()[n];
        if (!nd.alive || !nd.degree || nd.obstacle != ~0u) continue;
        const Obb b = walls_.postBox(n);
        nd.obstacle = V.addObstacle(b.cx, b.cz, b.hx, b.hz, b.yaw, nd.y + b.top);
        ++obstacleCount_;
        changed = true;
    }
    // landed containers (never removed: they never disappear, GAME_DESIGN 14c)
    if (ctx.logistics)
        for (const SupplyPoint& sp : ctx.logistics->points()) {
            if (!sp.alive || sp.kind != SupplyKind::Container || !sp.landed) continue;
            if (containers_.size() <= sp.id.index) containers_.resize(sp.id.index + 1);
            ContainerObs& co = containers_[sp.id.index];
            if (co.obstacle != ~0u && co.gen == sp.id.gen) continue;
            const Obb b = containerBox(sp);
            co.gen = sp.id.gen;
            co.obstacle = V.addObstacle(b.cx, b.cz, b.hx, b.hz, b.yaw, sp.pos.y + b.top);
            ++obstacleCount_;
            changed = true;
        }
    if (changed) { territory_.markDirty(); masksDirty_ = true; }
}

void Fortifications::rebuildMasks(const AppState& app) {
    masksDirty_ = false;
    const Sandbox& sb = app.sandbox;
    const int gw = sb.gridW, gh = sb.gridH;
    const float ox = sb.originX, oz = sb.originZ, cs = sb.cellSize;
    gateMask_.assign((size_t)gw * gh, 0);
    const auto& P = walls_.pieces();
    for (uint32_t i = 0; i < P.size(); ++i)
        if (P[i].alive && P[i].gate) forEachObbCell(walls_.pieceBox(i), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 1; });
    for (uint32_t i = 0; i < P.size(); ++i)
        if (P[i].alive && !P[i].gate) forEachObbCell(walls_.pieceBox(i), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 0; });
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n)
        if (walls_.nodes()[n].alive && walls_.nodes()[n].degree) forEachObbCell(walls_.postBox(n), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 0; });
    if (!gpuOk_) return;
    // GPU id grid: region slot + 1 (bits 0..11) | wall piece + 1 within one cell of its footprint (bits 12..31)
    std::vector<uint32_t> ids((size_t)gw * gh, 0u);
    if (!territory_.regions().empty())
        for (int z = 0; z < gh; ++z)
            for (int x = 0; x < gw; ++x) {
                const int s = territory_.slotAt(ox + (x + 0.5f) * cs, oz + (z + 0.5f) * cs);
                if (s >= 0 && (uint32_t)s + 1 < TerritoryGpu::kRegionSlots) ids[(size_t)z * gw + x] = (uint32_t)s + 1;
            }
    for (uint32_t i = 0; i < P.size() && i + 1 < TerritoryGpu::kPieceSlots; ++i) {
        if (!P[i].alive) continue;
        Obb b = walls_.pieceBox(i);
        b.hx += cs; b.hz += cs;
        forEachObbCell(b, ox, oz, cs, gw, gh, [&](int x, int z) { uint32_t& v = ids[(size_t)z * gw + x]; v = (v & 0xFFFu) | ((i + 1) << 12); });
    }
    ++idsSerial_;
    idsTerritory_ = territory_.version();
    idsX0_ = ox; idsZ0_ = oz; idsX1_ = ox + gw * cs; idsZ1_ = oz + gh * cs;
    gpu_.setIds(std::move(ids), idsSerial_);
}

void Fortifications::windowMoved(AppState& app) {
    computeStreetLevel(app);
    masksDirty_ = true;
    rebuildMasks(app);
}

const std::vector<float>& Fortifications::navHeights(const AppState& app) {
    const std::vector<float>& h = app.vehicles.simHeights();
    navH_ = h;
    const Sandbox& sb = app.sandbox;
    if (gateMask_.size() == navH_.size())
        for (size_t c = 0; c < navH_.size(); ++c)
            if (gateMask_[c]) navH_[c] = app.vehicles.groundAt(sb.originX + ((int)(c % sb.gridW) + 0.5f) * sb.cellSize, sb.originZ + ((int)(c / sb.gridW) + 0.5f) * sb.cellSize);
    navSerial_ = app.vehicles.updateSerial();
    return navH_;
}

void Fortifications::patchNav(AppState& app, NavGrid& nav) {
    const CityVehicles& V = app.vehicles;
    if (V.updateSerial() == navSerial_) return;
    navSerial_ = V.updateSerial();
    const auto& runs = V.uploadedRuns();
    if (runs.empty() || !nav.ready()) return;
    const std::vector<float>& h = V.simHeights();
    const Sandbox& sb = app.sandbox;
    if (navH_.size() != h.size()) { navHeights(app); nav.build(navH_, sb.gridW, sb.gridH, sb.originX, sb.originZ, sb.cellSize); return; }
    uint32_t z0 = ~0u, z1 = 0;
    for (const auto& r : runs) {
        z0 = std::min(z0, r.first); z1 = std::max(z1, r.first + r.second);
        for (uint32_t z = r.first; z < r.first + r.second && z < (uint32_t)sb.gridH; ++z)
            for (int x = 0; x < sb.gridW; ++x) {
                const size_t c = (size_t)z * sb.gridW + x;
                navH_[c] = (gateMask_.size() == h.size() && gateMask_[c]) ? V.groundAt(sb.originX + (x + 0.5f) * sb.cellSize, sb.originZ + (z + 0.5f) * sb.cellSize) : h[c];
            }
        navRows_ += r.second;
    }
    nav.updateRows(navH_, (int)z0, (int)(z1 - z0));   // one local patch (walkability of these rows, islands)
    ++navPatches_;
}

void Fortifications::tick(AppState& app, GameContext& ctx) {
    const float dt = ctx.dt;
    const SoldierPool* S = ctx.soldiers;
    walls_.tick(dt, [S](float x, float z, float r) {
        if (!S) return false;
        for (uint32_t i = 0; i < (uint32_t)S->capacity(); ++i)
            if (S->used[i] && S->alive(i) && (S->pos[i].x - x) * (S->pos[i].x - x) + (S->pos[i].z - z) * (S->pos[i].z - z) < r * r) return true;
        return false;
    });
    // pressure damage from the latest GPU counts (made against the current id grid)
    for (uint32_t i = 0; i < walls_.pieces().size() && i + 1 < pressure_.size(); ++i)
        if (walls_.pieces()[i].alive) walls_.addPressure(i, (float)pressure_[i + 1], dt);
    // breaches
    destroyedScratch_.clear();
    walls_.takeDestroyed(destroyedScratch_);
    for (const Walls::Destroyed& d : destroyedScratch_) {
        ++destroyedTotal_;
        if (d.piece + 1 < pressure_.size()) pressure_[d.piece + 1] = 0;
        const Obb& b = d.box;
        if (ctx.events)
            for (int k = -1; k <= 1; ++k) {
                float x, z;
                b.at(k * b.hx * 0.6f, 0.f, x, z);
                ctx.events->fx.push_back({FxKind::Landing, SoldierId{}, {x, d.y, z}, {0, 1, 0}});
                ctx.events->fx.push_back({FxKind::Impact, SoldierId{}, {x, d.y + 1.f, z}, {0, 1, 0}});
            }
        if (ctx.events) ctx.events->noise.push_back({{d.x, d.y, d.z}, 0.8f, 40.f, 3.f});
        notices_.push_back({"Wall breached!", true, d.x, d.z});
        SDL_Log("game: wall piece %u destroyed at (%.1f %.1f)", d.piece, d.x, d.z);
    }
    syncObstacles(app, ctx);
    if (walls_.takeChanged()) { territory_.markDirty(); masksDirty_ = true; }
    if (territory_.dirty()) {
        TerritoryInput in;
        in.walls = &walls_;
        if (ctx.logistics)
            for (const SupplyPoint& sp : ctx.logistics->points())
                if (sp.alive && sp.kind == SupplyKind::Container && sp.landed) in.containers.push_back(containerBox(sp));
        const CityVehicles* V = &app.vehicles;
        const HordeInterface* H = ctx.horde;
        const float street = streetY_;
        in.env = [V, H, street](float x, float z) {
            if (H && !H->simulated(x, z)) return 0;
            return V->groundAt(x, z) > street + 0.9f ? 2 : 1;
        };
        territory_.rebuild(in);
        masksDirty_ = true;
        SDL_Log("game: territory rebuilt: %zu region(s), %.0f m2 enclosed (%.2f ms)", territory_.regions().size(), territory_.enclosedArea(), territory_.lastRebuildMs());
    }
    if (masksDirty_) rebuildMasks(app);
    territory_.tick(dt, &walls_);
    territory_.takeNotices(notices_);
    if (ctx.economy) ctx.economy->setTerritoryRate(territory_.incomePerMin());
}

void Fortifications::afterSubmit(bool sync) {
    if (!gpuOk_) return;
    gpu_.harvest(sync);
    if (!gpu_.fresh()) return;
    gpu_.consume();
    if (gpu_.countsVersion() != idsSerial_) return;   // counted against an older id grid
    pressure_ = gpu_.pieceCounts();
    const auto& rc = gpu_.regionCounts();
    std::vector<int> perSlot(territory_.regions().size(), -1);
    for (size_t s = 0; s < perSlot.size(); ++s) {
        const Region& r = territory_.regions()[s];
        const bool covered = r.x0 >= idsX0_ && r.z0 >= idsZ0_ && r.x1 <= idsX1_ && r.z1 <= idsZ1_;   // else: keep its state
        if (covered && s + 1 < rc.size()) perSlot[s] = (int)rc[s + 1];
    }
    territory_.setZombieCounts(idsTerritory_, perSlot);
}

// ---------------------------------------------------------------------------------------------------------------
namespace {
void putProp(MilitaryRenderer& mil, int prop, V3 o, float yaw, float sxz, float sy, float dissolve, float leafOpen = 0.f) {
    const MilitaryLibrary& lib = mil.library();
    if (prop < 0 || prop >= (int)lib.props.size() || dissolve >= 1.f) return;
    const MilProp& P = lib.props[(size_t)prop];
    auto put = [&](int m, std::array<float, 3> pv, float extraYaw) {
        const float c = std::cos(yaw), s = std::sin(yaw);
        const float px = pv[0] * sxz, py = pv[1] * sy, pz = pv[2] * sxz;
        MilitaryRenderer::Inst gi{};
        gi.pos[0] = o.x + px * c + pz * s; gi.pos[1] = o.y + py; gi.pos[2] = o.z - px * s + pz * c;
        gi.pos[3] = 2.f + 0.9f * std::clamp(dissolve, 0.f, 1.f);
        const float y2 = 0.5f * (yaw + extraYaw);
        gi.quat[0] = 0; gi.quat[1] = std::sin(y2); gi.quat[2] = 0; gi.quat[3] = std::cos(y2);
        gi.paint[0] = sxz; gi.paint[1] = std::max(0.02f, sy); gi.paint[2] = 0.f; gi.paint[3] = -1e4f;
        mil.addInstance(m, gi);
    };
    if (P.parts.empty()) { put(P.model, {0, 0, 0}, 0.f); return; }
    for (size_t k = 0; k < P.parts.size(); ++k) {
        float extra = 0.f;
        if (leafOpen > 0.f && P.parts.size() == 3 && k > 0) extra = (k == 1 ? 1.f : -1.f) * leafOpen * 1.4f;   // gate leaves (hinges)
        put(P.parts[k].first, P.parts[k].second, extra);
    }
}
} // namespace

void Fortifications::draw(MilitaryRenderer& mil, const GameContext& ctx, float frameDt) {
    if (!props_.init) {
        props_.init = true;
        const char* v[2] = {"cheap", "reinforced"};
        char n[64];
        for (int t = 0; t < 2; ++t) {
            std::snprintf(n, sizeof(n), "wall_%s_straight", v[t]); props_.straight[t] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "wall_%s_corner", v[t]); props_.corner[t] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "wall_%s_t", v[t]); props_.t[t] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "wall_%s_x", v[t]); props_.x[t] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "wall_%s_end", v[t]); props_.end[t] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "wall_%s_gate", v[t]); props_.gate[t] = mil.findProp(n);
        }
        props_.container = mil.findProp("container_supply");
        props_.chute = mil.findProp("para_cargo");
    }
    const float buildT = std::max(0.05f, cfg_ ? cfg_->fort.buildTime : 0.6f);
    // pieces
    for (uint32_t i = 0; i < walls_.pieces().size(); ++i) {
        const WallPiece& p = walls_.pieces()[i];
        if (!p.alive) continue;
        const Obb b = walls_.pieceBox(i);
        const float y = 0.5f * (walls_.nodes()[p.a].y + walls_.nodes()[p.b].y);
        float rise = std::clamp(p.age / buildT, 0.f, 1.f);
        rise = rise * rise * (3.f - 2.f * rise);
        const int t = (int)p.type;
        putProp(mil, p.gate ? props_.gate[t] : props_.straight[t], {b.cx, y, b.cz}, b.yaw, walls_.pieceScale(i), rise, 0.f, p.gate ? p.gateOpen : 0.f);
    }
    // joints
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n) {
        const WallNode& nd = walls_.nodes()[n];
        if (!nd.alive || !nd.degree) continue;
        float yaw;
        WallType t;
        const JointShape js = walls_.joint(n, yaw, t);
        const int ti = (int)t;
        const int prop = js == JointShape::End ? props_.end[ti] : js == JointShape::Corner ? props_.corner[ti] : js == JointShape::T ? props_.t[ti]
                       : js == JointShape::X ? props_.x[ti] : -1;
        if (prop >= 0) putProp(mil, prop, {nd.x, nd.y, nd.z}, yaw, 1.f, 1.f, 0.f);
    }
    // rubble: the piece crumbles (dissolve), a flattened heap stays
    for (const WallRubble& r : walls_.rubble()) {
        const int t = (int)r.type;
        const int prop = r.gate ? props_.gate[t] : props_.straight[t];
        const float s = 2.f * r.box.hx / 4.f;
        if (r.t < 1.4f) putProp(mil, prop, {r.box.cx, r.y, r.box.cz}, r.box.yaw, s, 1.f - 0.5f * r.t / 1.4f, r.t / 1.4f);
        if (r.t > 0.25f) putProp(mil, props_.straight[t], {r.box.cx, r.y - 0.05f, r.box.cz}, r.box.yaw + 0.04f, s * 1.08f, std::min(0.16f, 0.16f * (r.t - 0.25f) / 0.6f), 0.f);
    }
    // containers: descent under two cargo canopies, touchdown, canopies collapse and dissolve
    if (ctx.logistics && props_.container >= 0) {
        const float land = cfg_ ? cfg_->fort.containerLandDuration : 1.f;
        for (const SupplyPoint& sp : ctx.logistics->points()) {
            if (!sp.alive || sp.kind != SupplyKind::Container) continue;
            const float alt = sp.phase == 0 ? sp.altitude : 0.f;
            const V3 o{sp.pos.x, sp.pos.y + alt, sp.pos.z};
            putProp(mil, props_.container, o, sp.yaw, 1.f, 1.f, 0.f);
            const float since = sp.phase == 0 ? -1.f : sp.phase == 1 ? sp.phaseT : land + std::max(0.f, sp.groundT);
            if (props_.chute < 0 || since > 3.6f) continue;
            const float c = std::cos(sp.yaw), s = std::sin(sp.yaw);
            for (int k = -1; k <= 1; k += 2) {
                float sy = 1.6f, d = 0.f, drift = 0.f, lean = 0.f;
                if (since >= 0.f) {   // collapse: height shrinks, drifts downwind, dissolves
                    const float u = std::clamp(since / 1.6f, 0.f, 1.f);
                    sy = 1.6f - 1.35f * u;
                    drift = 2.5f * u;
                    lean = 0.f;
                    d = std::clamp((since - 1.4f) / 2.2f, 0.f, 1.f);
                }
                const float off = 1.7f * (float)k;
                const V3 at{o.x + off * c + (drift + lean) * s, o.y + kContTop, o.z - off * s + drift * c};
                putProp(mil, props_.chute, at, sp.yaw + 0.6f * k, 1.7f, sy, d);
            }
        }
    }
    // placement preview ghosts (valid pieces only; the screen overlay colours and explains)
    if (walls_.previewOn) {
        const WallPlan& pl = walls_.preview;
        const int t = (int)pl.type;
        for (const WallPlanPiece& q : pl.pieces) {
            if (!q.ok) continue;
            const float len = std::hypot(q.bx - q.ax, q.bz - q.az);
            const float yaw = std::atan2(-(q.bz - q.az), q.bx - q.ax);
            putProp(mil, pl.gate ? props_.gate[t] : props_.straight[t], {0.5f * (q.ax + q.bx), q.y, 0.5f * (q.az + q.bz)}, yaw, len / 4.f, 1.f, 0.42f);
        }
    }
    (void)frameDt;
}

} // namespace ttz::game
