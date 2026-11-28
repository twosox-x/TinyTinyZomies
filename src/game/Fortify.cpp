// B2 integration: walls, gates, containers as obstacles, territory, GPU counts, nav patches, drawing. See Fortify.h.
#include "game/Fortify.h"

#include "app/App.h"
#include "game/Buildings.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/EngineerAI.h"
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

namespace {
const BuildingRegistry* g_wallBuildings = nullptr;
}
void setWallEnvBuildings(const BuildingRegistry* reg) { g_wallBuildings = reg; }

WallEnv makeWallEnv(const AppState& app, const GameContext& ctx) {
    WallEnv e;
    if (const BuildingRegistry* R = g_wallBuildings)   // exact facade: ray entry into the record footprint holding (hx, hz)
        e.facadeRay = [R](float ox, float oz, float dx, float dz, float hx, float hz) {
            const BuildingId id = R->at(hx, hz, 0.6f);
            const Building* b = R->get(id);
            if (!b) return -1.f;
            float u0, v0;
            b->toLocal(ox, oz, u0, v0);
            const float du = dx * b->e1x + dz * b->e1z, dv = dx * b->e2x + dz * b->e2z;
            float t0 = 0.f, t1 = 1e9f;
            const float lo[2] = {0.f, 0.f}, hi[2] = {b->w, b->d}, p0[2] = {u0, v0}, dd[2] = {du, dv};
            for (int k = 0; k < 2; ++k) {
                if (std::fabs(dd[k]) < 1e-6f) { if (p0[k] < lo[k] || p0[k] > hi[k]) return -1.f; continue; }
                float a = (lo[k] - p0[k]) / dd[k], c = (hi[k] - p0[k]) / dd[k];
                if (a > c) std::swap(a, c);
                t0 = std::max(t0, a); t1 = std::min(t1, c);
                if (t0 > t1) return -1.f;
            }
            return t0;
        };
    const CityVehicles* v = &app.vehicles;
    const HordeInterface* h = ctx.horde;
    e.ground = [v](float x, float z) { return v->groundAt(x, z); };
    e.solid = [v](float x, float z) { return v->solidAt(x, z); };
    e.simulated = [h](float x, float z) { return !h || h->simulated(x, z); };
    e.streetY = windowStreetLevel(app);
    if (ctx.logistics)
        for (const SupplyPoint& sp : ctx.logistics->points())
            if (sp.alive && sp.kind == SupplyKind::Container) e.containers.push_back(containerBox(sp));
    if (ctx.engineers) {   // GAME_DESIGN 14d: construction only within an engineer squad's radius (debug cheat: anywhere)
        const EngineerAI* E = ctx.engineers;
        if (!E->instantBuild) {
            const GameContext* c = &ctx;
            e.buildable = [E, c](float x, float z) { return E->inRange(*c, x, z); };
        }
        e.clearing = E->clearingBoxes();
    }
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
    const WallEnv env = makeWallEnv(app, ctx);
    const WallPlan plan = c.type == CommandType::BuildGate ? walls_.planGate(c.pos, c.facing, (WallType)std::min<uint8_t>(c.wallType, 1), env)
                                                           : walls_.plan(pts, (WallType)std::min<uint8_t>(c.wallType, 1), c.gate, env);
    if (!plan.valid) { msg = plan.reason; return false; }
    const bool gate = plan.gate;
    const char* what = gate ? "gate" : c.wallType ? "reinforced wall" : "wall";
    if (!eco.spend(plan.price, what, ctx.time)) { msg = "not enough funding"; return false; }
    const bool instant = !ctx.engineers || ctx.engineers->instantBuild;
    const std::vector<uint32_t> added = walls_.commit(plan, instant);
    syncObstacles(app, ctx);
    char t[128];
    std::snprintf(t, sizeof(t), "%s %s: %.0f m, %zu piece%s ($%d)", gate ? "Gate" : c.wallType ? "Reinforced wall" : "Wall",
                  instant ? "built" : "ordered (engineers build it)", plan.length, added.size(), added.size() == 1 ? "" : "s", plan.price);
    msg = t;
    return true;
}

bool Fortifications::undo(GameContext& ctx, Economy& eco, std::string& msg) {
    // the newest placement with unfinished parts: its blueprints are removed, a pending gate conversion dropped; refunded
    uint32_t batch = 0;
    for (const WallPiece& p : walls_.pieces())
        if (p.alive && (!p.solid() || p.toGate)) batch = std::max(batch, p.batch);
    if (!batch) { msg = "nothing to undo (finished walls stay)"; return false; }
    int refund = 0, n = 0;
    for (uint32_t i = 0; i < walls_.pieces().size(); ++i) {
        const WallPiece p = walls_.pieces()[i];
        if (!p.alive || p.batch != batch) continue;
        if (p.toGate) { if (walls_.cancel(i)) { refund += walls_.piecePrice(p.type, true); ++n; } }
        else if (!p.solid() && walls_.cancel(i)) { refund += p.price; ++n; }
    }
    if (refund > 0) eco.refund(refund, "construction undone", ctx.time);
    char t[96];
    std::snprintf(t, sizeof(t), "Undone: %d unfinished piece%s, $%d refunded", n, n == 1 ? "" : "s", refund);
    msg = t;
    return n > 0;
}

void Fortifications::syncObstacles(AppState& app, GameContext& ctx) {
    CityVehicles& V = app.vehicles;
    bool changed = false;
    // destroyed pieces: unstamp (the rows go up with the next vehicles update: zombies pour through the gap)
    // (also pieces split by a T junction / gate: re-stamped below with their new extent)
    for (WallPiece& p : walls_.pieces())
        if ((!p.alive || p.restamp) && p.obstacle != ~0u) { V.removeObstacle(p.obstacle); p.obstacle = ~0u; --obstacleCount_; changed = true; }
    for (WallPiece& p : walls_.pieces()) p.restamp = false;
    for (WallNode& n : walls_.nodes())
        if ((!n.alive || !n.solidDeg) && n.obstacle != ~0u) { V.removeObstacle(n.obstacle); n.obstacle = ~0u; --obstacleCount_; changed = true; }
    // finished pieces / posts (blueprints are no obstacle until engineers complete them)
    for (uint32_t i = 0; i < walls_.pieces().size(); ++i) {
        WallPiece& p = walls_.pieces()[i];
        if (!p.solid() || p.obstacle != ~0u) continue;
        const Obb b = walls_.pieceBox(i);
        const float y = std::min(walls_.nodes()[p.a].y, walls_.nodes()[p.b].y);
        p.obstacle = V.addObstacle(b.cx, b.cz, b.hx, b.hz, b.yaw, y + b.top);
        ++obstacleCount_;
        changed = true;
    }
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n) {
        WallNode& nd = walls_.nodes()[n];
        if (!nd.alive || !nd.solidDeg || nd.obstacle != ~0u) continue;
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
        if (P[i].solid() && P[i].gate) forEachObbCell(walls_.pieceBox(i), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 1; });
    for (uint32_t i = 0; i < P.size(); ++i)
        if (P[i].solid() && !P[i].gate) forEachObbCell(walls_.pieceBox(i), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 0; });
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n)
        if (walls_.nodes()[n].alive && walls_.nodes()[n].solidDeg) forEachObbCell(walls_.postBox(n), ox, oz, cs, gw, gh, [&](int x, int z) { gateMask_[(size_t)z * gw + x] = 0; });
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
        if (!P[i].solid()) continue;
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

// Soldier walk heights + mask of rows [z0, z1) (GAME_DESIGN 14e / owner 2026-11-28 car gaps):
//   gate passage cells     -> ground (soldiers pass, zombies do not)
//   gameplay obstacles     -> their stamped height, mask bit 0 (walls, posts, containers, moving vehicles: never walked on)
//   parked vehicle cells   -> the vehicle's height + bit 0 only when the cell centre lies inside the vehicle's real
//                             oriented box (+ kCarMargin); cells the zombies' grid covers only because the footprint was
//                             rounded out to whole cells are ground: soldiers use the real gaps between parked cars
//   blueprint footprints   -> bit 1 (reserved: A* cost, corridors stay open)
void Fortifications::navRows(const AppState& app, int z0, int z1) {
    constexpr float kCarMargin = 0.12f;   // m around a parked car's real box (soldier radius ~0.3 m with the cell slack)
    const CityVehicles& V = app.vehicles;
    const std::vector<float>& h = V.simHeights();
    const Sandbox& sb = app.sandbox;
    const int gw = sb.gridW;
    if (navH_.size() != h.size()) { navH_ = h; navMask_.assign(h.size(), 0); }
    if (navMask_.size() != h.size()) navMask_.assign(h.size(), 0);
    struct Car { Obb b; int x0, z0, x1, z1; };
    std::vector<Car> cars;
    for (uint32_t i = 0; i < V.count(); ++i) {
        const Vehicle& v = V.vehicle(i);
        if (!v.inWindow || v.removed || v.active || v.sx1 < v.sx0 || v.sz1 < z0 || v.sz0 >= z1) continue;
        Car c;
        V.groundBox(i, c.b.cx, c.b.cz, c.b.hx, c.b.hz, c.b.yaw);
        c.x0 = v.sx0; c.z0 = v.sz0; c.x1 = v.sx1; c.z1 = v.sz1;
        cars.push_back(c);
    }
    for (int z = std::max(0, z0); z < std::min(sb.gridH, z1); ++z)
        for (int x = 0; x < gw; ++x) {
            const size_t c = (size_t)z * gw + x;
            const float wx = sb.originX + (x + 0.5f) * sb.cellSize, wz = sb.originZ + (z + 0.5f) * sb.cellSize;
            const float base = V.groundAt(wx, wz), solid = V.solidAt(wx, wz), sim = h[c];
            uint8_t m = navMask_[c] & 2u;
            float y = sim;
            if (gateMask_.size() == h.size() && gateMask_[c]) y = base;
            else if (sim - solid > 0.3f) m |= 1u;                       // wall / post / container / moving vehicle
            else if (solid - base > 0.3f) {                             // parked vehicle (rounded-out footprint)
                bool inside = false;
                for (const Car& k : cars)
                    if (x >= k.x0 && x <= k.x1 && z >= k.z0 && z <= k.z1 && k.b.contains(wx, wz, -kCarMargin)) { inside = true; break; }
                if (inside) m |= 1u;
                else y = base + (sim - solid);                          // the real gap between cars: ground
            }
            navH_[c] = y;
            navMask_[c] = m;
        }
}

void Fortifications::reserveBlueprints(const AppState& app) {
    reserveDirty_ = false;
    const Sandbox& sb = app.sandbox;
    if (navMask_.size() != (size_t)sb.gridW * sb.gridH) return;
    for (uint8_t& m : navMask_) m &= 1u;
    const auto& P = walls_.pieces();
    for (uint32_t i = 0; i < P.size(); ++i) {
        if (!P[i].alive || P[i].solid()) continue;
        Obb b = walls_.pieceBox(i);
        b.hx += 0.3f; b.hz += 0.3f;
        forEachObbCell(b, sb.originX, sb.originZ, sb.cellSize, sb.gridW, sb.gridH, [&](int x, int z) { navMask_[(size_t)z * sb.gridW + x] |= 2u; });
    }
}

const std::vector<float>& Fortifications::navHeights(const AppState& app) {
    const std::vector<float>& h = app.vehicles.simHeights();
    navH_ = h;
    navMask_.assign(h.size(), 0);
    reserveBlueprints(app);
    navRows(app, 0, app.sandbox.gridH);
    navSerial_ = app.vehicles.updateSerial();
    return navH_;
}

void Fortifications::patchNav(AppState& app, NavGrid& nav) {
    const CityVehicles& V = app.vehicles;
    if (reserveDirty_ && nav.ready() && navMask_.size() == nav.mask().size()) { reserveBlueprints(app); nav.setMask(navMask_); }
    if (V.updateSerial() == navSerial_) return;
    navSerial_ = V.updateSerial();
    const auto& runs = V.uploadedRuns();
    if (runs.empty() || !nav.ready()) return;
    const std::vector<float>& h = V.simHeights();
    const Sandbox& sb = app.sandbox;
    if (navH_.size() != h.size()) { navHeights(app); nav.setMask(navMask_); nav.build(navH_, sb.gridW, sb.gridH, sb.originX, sb.originZ, sb.cellSize); nav.setShotHeights(h); return; }
    uint32_t z0 = ~0u, z1 = 0;
    for (const auto& r : runs) {
        z0 = std::min(z0, r.first); z1 = std::max(z1, r.first + r.second);
        navRows(app, (int)r.first, (int)(r.first + r.second));
        navRows_ += r.second;
    }
    nav.setMask(navMask_);
    nav.updateRows(navH_, (int)z0, (int)(z1 - z0));   // one local patch (walkability of these rows, islands)
    nav.updateShotRows(h, (int)z0, (int)(z1 - z0));   // rounds: the zombies' grid (gates block them)
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
        if (walls_.pieces()[i].solid()) {
            walls_.addPressure(i, (float)pressure_[i + 1], dt);
            if (ctx.events && pressure_[i + 1] > 0 && ((ctx.tick + i) % 15u) == 0) {   // [SOUND HOOK] zombies hitting the wall (material)
                const WallPiece& wp = walls_.pieces()[i]; const Obb ob = walls_.pieceBox(i);
                ctx.events->cues.push_back({wp.gate ? AudioCueKind::ZombieAttackMetal : wp.type == WallType::Reinforced ? AudioCueKind::ZombieAttackSandbag : AudioCueKind::ZombieAttackWood, {ob.cx, 0.f, ob.cz}, 1.f});
            }
        }
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
    if (walls_.takeChanged()) { territory_.markDirty(); masksDirty_ = true; reserveDirty_ = true; }   // + nav blueprint reservation
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
// only: -1 all parts; >= 0 only that part; skip: a part left out (container apron during the descent)
void putProp(MilitaryRenderer& mil, int prop, V3 o, float yaw, float sxz, float sy, float dissolve, float leafOpen = 0.f, int skip = -1, int only = -1) {
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
        if ((int)k == skip || (only >= 0 && (int)k != only)) continue;
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
        props_.containerApron = -1;
        if (props_.container >= 0) {   // the apron part (model "container_supply/apron")
            const MilProp& cp = mil.library().props[(size_t)props_.container];
            for (size_t k = 0; k < cp.parts.size(); ++k) {
                const int m = cp.parts[k].first;
                if (m >= 0 && m < (int)mil.library().models.size() && mil.library().models[(size_t)m].name.size() >= 6 &&
                    mil.library().models[(size_t)m].name.compare(mil.library().models[(size_t)m].name.size() - 6, 6, "/apron") == 0)
                    props_.containerApron = (int)k;
            }
        }
        props_.chute = mil.findProp("para_cargo");
    }
    const float buildT = std::max(0.05f, cfg_ ? cfg_->fort.buildTime : 0.6f);
    // a piece: the approved 4 m straight / gate asset scaled to its length; pieces shorter than 3.5 m (auto-fill end
    // pieces, split T junctions) as a row of 1 m gabion baskets (the approved joint post asset), never a squashed piece
    auto piece = [&](int t, bool gate, float cx, float cz, float y, float yaw, float len, float rise, float dissolve, float open) {
        if (!gate && len < 3.5f) {
            // baskets stay (nearly) full size (0.5 m granularity, GAME_DESIGN 14e): a filler shorter than one basket
            // overlaps its neighbours instead of being squashed; alternate baskets are inset a little (no z-fighting)
            const int n = std::max(1, (int)std::floor(len + 0.25f));
            const float sp = len / (float)n, c = std::cos(yaw), sn = std::sin(yaw);
            const float s = std::clamp(sp, 0.86f, 1.12f);
            for (int k = 0; k < n; ++k) {
                const float u = -0.5f * len + ((float)k + 0.5f) * sp;
                const float sk = s * ((k & 1) ? 0.985f : 1.f);
                putProp(mil, props_.corner[t], {cx + u * c, y, cz - u * sn}, yaw, sk, rise * 0.9f * ((k & 1) ? 0.99f : 1.f), dissolve);
            }
            return;
        }
        putProp(mil, gate ? props_.gate[t] : props_.straight[t], {cx, y, cz}, yaw, len / 4.f, rise, dissolve, open);
    };
    // pieces: finished ones rise once complete; blueprints (engineers at work) are translucent and grow with progress
    for (uint32_t i = 0; i < walls_.pieces().size(); ++i) {
        const WallPiece& p = walls_.pieces()[i];
        if (!p.alive) continue;
        const Obb b = walls_.pieceBox(i);
        const float y = 0.5f * (walls_.nodes()[p.a].y + walls_.nodes()[p.b].y);
        const int t = (int)p.type;
        const float len = 2.f * b.hx;
        if (!p.solid()) { piece(t, p.gate, b.cx, b.cz, y, b.yaw, len, 0.12f + 0.88f * p.build, 0.5f - 0.25f * p.build, 0.f); continue; }
        float rise = std::clamp(p.age / buildT, 0.f, 1.f);
        rise = rise * rise * (3.f - 2.f * rise);
        piece(t, p.gate, b.cx, b.cz, y, b.yaw, len, rise, 0.f, p.gate ? p.gateOpen : 0.f);
        if (p.toGate) piece(t, true, b.cx, b.cz, y + 0.02f, b.yaw, len, 1.f, 0.6f, 0.f);   // the gate being fitted
    }
    // joints
    for (uint32_t n = 0; n < walls_.nodes().size(); ++n) {
        const WallNode& nd = walls_.nodes()[n];
        if (!nd.alive || !nd.solidDeg) continue;
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
            const float since = sp.phase == 0 ? -1.f : sp.phase == 1 ? sp.phaseT : land + std::max(0.f, sp.groundT);
            // the sandbag / barrier apron is not part of the air-dropped load: only the container body (and doors) hang
            // under the canopies; once it has touched down the apron rises out of the ground (0.6 s build-in)
            const int apron = props_.containerApron;
            putProp(mil, props_.container, o, sp.yaw, 1.f, 1.f, 0.f, 0.f, apron);
            if (apron >= 0 && since >= 0.f) {
                const float k = std::clamp(since / 0.6f, 0.f, 1.f);
                putProp(mil, props_.container, {sp.pos.x, sp.pos.y, sp.pos.z}, sp.yaw, 1.f, 0.05f + 0.95f * k * (2.f - k), 0.f, 0.f, -1, apron);
            }
            if (props_.chute < 0 || since > 3.6f) continue;
            const float c = std::cos(sp.yaw), s = std::sin(sp.yaw);
            // collapsing canopies drift to the side of the container away from walls; with walls on both sides they
            // fold straight down onto its roof (never draped over / through a wall next to it)
            float side = 1.f, room = 0.f;
            for (float sd : {1.f, -1.f}) {
                bool clear = true;
                for (float d : {1.5f, 3.f, 4.5f}) clear &= walls_.nearestPiece(o.x + sd * d * s, o.z + sd * d * c, 1.2f) < 0 && walls_.nearestNode(o.x + sd * d * s, o.z + sd * d * c, 1.2f) < 0;
                if (clear) { side = sd; room = 1.f; break; }
            }
            for (int k = -1; k <= 1; k += 2) {
                float sy = 1.6f, d = 0.f, drift = 0.f, lean = 0.f;
                if (since >= 0.f) {   // collapse: height shrinks, drifts downwind, dissolves
                    const float u = std::clamp(since / 1.6f, 0.f, 1.f);
                    sy = 1.6f - 1.35f * u;
                    drift = 2.5f * u * room * side;
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
            piece(t, pl.gate, 0.5f * (q.ax + q.bx), 0.5f * (q.az + q.bz), q.y, yaw, len, 1.f, 0.42f, 0.f);
        }
    }
    (void)frameDt;
}

} // namespace ttz::game
