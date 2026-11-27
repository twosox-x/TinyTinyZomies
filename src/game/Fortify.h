#pragma once
// B2 integration: walls, gates (PROPOSED), supply containers as obstacles, territory, GPU counts, navigation patches
// and drawing (Milestone B2, GAME_DESIGN 5 / 14b / 14c). GameWorld owns one and calls it at fixed points:
//
//   applyCommands : BuildWall -> plan (validated) -> Economy charged once -> Walls::commit
//   tick (after Logistics, before Economy):
//       walls age / gates open for nearby soldiers; pressure damage from the latest GPU wall counts; destroyed pieces
//       -> obstacles removed (CityVehicles rows re-uploaded: zombies pour through, NavGrid rows patched), rubble, dust,
//       notices; new pieces / posts / landed containers -> obstacles stamped (event driven, rows only);
//       territory rebuilt when anything changed; region zombie counts from the GPU; states; territory income rate
//   preSim (frame) : NavGrid rows patched from the rows CityVehicles uploaded (local, never a global rebuild); the
//                    rebuild on window moves uses navHeights() (gate cells lowered: soldiers pass, zombies do not)
//   postSim (frame): game_territory pass (every few frames) + readback; afterSubmit: harvest (non-blocking)
//   render         : GameRender::extraDraw -> draw(): wall pieces (approved gabion assets, uniform xz scale per piece),
//                    joint posts, gates (leaves open near soldiers), rubble, containers with two cargo canopies,
//                    preview ghosts
#include "game/Commands.h"
#include "game/GameContext.h"
#include "game/Territory.h"
#include "game/TerritoryGpu.h"
#include "game/Walls.h"

#include <SDL3/SDL_gpu.h>
#include <string>
#include <vector>

namespace ttz {
struct AppState;
class MilitaryRenderer;
}

namespace ttz::game {

struct BalanceConfig;
struct SupplyPoint;
class NavGrid;
class Economy;

// Container body footprint (container_supply 20 ft ISO body, model space centred; doors on +X).
Obb containerBox(const SupplyPoint& sp);
// Placement environment from the live window (CityVehicles heights, horde window, supply containers).
WallEnv makeWallEnv(const AppState& app, const GameContext& ctx);
float windowStreetLevel(const AppState& app);   // 20th percentile of the window's ground

class Fortifications {
public:
    bool init(AppState& app, const BalanceConfig& cfg);
    void shutdown();
    Walls& walls() { return walls_; }
    const Walls& walls() const { return walls_; }
    Territory& territory() { return territory_; }
    const Territory& territory() const { return territory_; }

    // BuildWall / BuildGate command: plan + charge + commit (blueprints for the engineers; ctx.engineers->instantBuild:
    // built at once, debug / tests). false (msg = reason) when refused; nothing is charged then.
    bool build(AppState& app, GameContext& ctx, const Command& c, Economy& eco, std::string& msg);
    // Ctrl+Z: removes the unfinished pieces of the newest placement (finished pieces stay) and refunds them.
    bool undo(GameContext& ctx, Economy& eco, std::string& msg);
    // Container placement rule (FortConfig::containerNeedsTerritory, PROPOSED off).
    bool containerAllowed(const GameContext& ctx, V3 pos, const char** why) const;

    void tick(AppState& app, GameContext& ctx);
    const std::vector<float>& navHeights(const AppState& app);   // sim heights with gate cells lowered
    void patchNav(AppState& app, NavGrid& nav);                   // rows uploaded this frame -> NavGrid::updateRows
    void windowMoved(AppState& app);
    void postSim(SDL_GPUCommandBuffer* cmd) { if (gpuOk_) gpu_.postSim(cmd); }
    void afterSubmit(bool sync);
    void draw(MilitaryRenderer& mil, const GameContext& ctx, float frameDt);
    void takeNotices(std::vector<TerritoryNotice>& out) { out.insert(out.end(), notices_.begin(), notices_.end()); notices_.clear(); }

    // tests / scripts / HUD
    uint64_t navPatches() const { return navPatches_; }
    uint64_t navPatchedRows() const { return navRows_; }
    uint32_t obstacles() const { return obstacleCount_; }
    uint64_t wallsDestroyed() const { return destroyedTotal_; }
    bool gpuReady() const { return gpuOk_; }
    uint64_t gpuPasses() const { return gpu_.passes(); }
    int piecePressure(uint32_t piece) const { return piece + 1 < pressure_.size() ? (int)pressure_[piece + 1] : 0; }

private:
    void syncObstacles(AppState& app, GameContext& ctx);
    void rebuildMasks(const AppState& app);      // gate mask + GPU id grid (window cells)
    void computeStreetLevel(const AppState& app);

    const BalanceConfig* cfg_ = nullptr;
    Walls walls_;
    Territory territory_;
    TerritoryGpu gpu_;
    bool gpuOk_ = false;
    std::vector<uint8_t> gateMask_;               // window cells: 1 = gate passage (walkable for soldiers)
    std::vector<float> navH_;
    uint64_t navSerial_ = 0, navPatches_ = 0, navRows_ = 0;
    bool masksDirty_ = true;
    uint64_t idsSerial_ = 0, idsTerritory_ = 0;
    float idsX0_ = 0, idsZ0_ = 0, idsX1_ = 0, idsZ1_ = 0;   // window the id grid covers (regions outside keep their state)
    std::vector<uint32_t> pressure_;              // latest wall counts (index piece + 1)
    struct ContainerObs { uint32_t gen = 0; uint32_t obstacle = ~0u; };
    std::vector<ContainerObs> containers_;        // per supply slot
    float streetY_ = 0.f;
    uint32_t obstacleCount_ = 0;
    uint64_t destroyedTotal_ = 0;
    std::vector<TerritoryNotice> notices_;
    std::vector<Walls::Destroyed> destroyedScratch_;
    // render
    struct Props { int straight[2] = {-1, -1}, corner[2] = {-1, -1}, t[2] = {-1, -1}, x[2] = {-1, -1}, end[2] = {-1, -1}, gate[2] = {-1, -1}, container = -1, containerApron = -1, chute = -1; bool init = false; } props_;
};

} // namespace ttz::game
