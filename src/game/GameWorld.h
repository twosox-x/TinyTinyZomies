#pragma once
// Gameplay root (`ttz --map city --game`): owns every gameplay module and runs the fixed game tick.
// Integration file: GameWorld.{h,cpp} and the App hooks are owned by WS-D; other workstreams only fill in their
// module's functions, which GameWorld already calls in the order below (no edits here needed to start).
//
// App::frame order (render frame, variable dt):
//   1  input events      -> GameUI::handleEvent -> CommandQueue (App::handleEvent, before the sandbox tools)
//   2  camera, vehicles, sim window (unchanged App code)
//   3  GameWorld::preSim(cmd, dt)
//        game ticks (0..kMaxTicksPerFrame at 30 Hz from dt * simSpeed, paused with the sim):
//          a  apply Commands (selection, orders, purchases)          Commands / Economy / Deploy / Logistics
//          b  horde outputs: kills -> Economy, contacts, field        HordeInterface (data harvested last frames)
//          c  Deploy::tick (descent, landing, recovery)
//          d  SoldierAI::tick (perception, decisions, movement, anim requests)
//          e  SoldierAnimator::tick per soldier -> AnimEvents
//          f  Combat::tick (rounds from events, reload, contact damage, attractors, hit requests)
//          g  Logistics::tick (crate descents, grabs)
//          h  Economy::tick (passive income)
//          i  GameScript::tick (headless scenarios)
//          j  horde inputs: uploadSoldiers / queueHits / setAttractors
//        HordeBridge::preSim(cmd): uploads + hit resolve passes (before CrowdSim::step)
//   4  CrowdSim::step x N (60 Hz, unchanged)
//   5  GameWorld::postSim(cmd): field / contact passes + readback (after the last step)
//   6  render: GameRender::update (pose inputs, FX) before Renderer::render (ext hooks draw the soldiers)
//   7  UI: GameUI::draw inside the ImGui frame
//   8  submit; GameWorld::afterSubmit(): HordeBridge::harvest (non-blocking)
//
// Threading: everything above is main-thread. Candidates to move to a worker later (profile first): NavGrid A* (pure
// CPU, already budgeted), SoldierAI perception for > 500 soldiers. GPU work is bounded by kMaxGpuSoldiers /
// kMaxHitsPerTick and never waits on the CPU (no synchronous readbacks; --game-sync is a headless test switch).
// Determinism: game ticks are fixed-step with per-entity seeded RNG; the only nondeterminism is readback latency,
// removed in tests by --game-sync. Save / load of game state is out of scope.
#include "game/BuildingPlay.h"
#include "game/Combat.h"
#include "game/Commands.h"
#include "game/Config.h"
#include "game/CorpseGas.h"
#include "game/CorpseGasRender.h"
#include "game/FlameAI.h"
#include "game/Deploy.h"
#include "game/Reanimation.h"
#include "game/Economy.h"
#include "game/EngineerAI.h"
#include "game/Fortify.h"
#include "game/FuelLogistics.h"
#include "game/Structures.h"
#include "game/GameEvents.h"
#include "game/GameRender.h"
#include "game/GameScript.h"
#include "game/GameUI.h"
#include "game/HordeBridge.h"
#include "game/HordeVertical.h"
#include "game/Logistics.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <SDL3/SDL_gpu.h>
#include <string>

union SDL_Event;

namespace ttz {
struct AppState;
}

namespace ttz::game {

struct GameOptions {
    std::string balancePath = "config/balance.json";
    std::string script;              // --game-script FILE
    bool syncReadback = false;       // --game-sync: headless tests wait for each horde readback (determinism)
};

class GameWorld {
public:
    bool init(AppState& app, const GameOptions& opt);
    void shutdown(AppState& app);
    bool handleEvent(AppState& app, const SDL_Event& e);       // true: consumed (App skips its own handling)
    void preSim(AppState& app, SDL_GPUCommandBuffer* cmd, double frameDt);
    void postSim(AppState& app, SDL_GPUCommandBuffer* cmd);
    void render(AppState& app, float frameDt);                 // before Renderer::render
    void drawUI(AppState& app);                                // inside the ImGui frame
    void afterSubmit(AppState& app);
    bool finished() const { return finished_; }                // a script ended (App quits; exit code = failures)
    int exitCode() const { return script_.failures() ? 1 : 0; }

    // Read access for UI, render, scripts and tests.
    const GameContext& context() const { return ctx_; }
    GameContext& context() { return ctx_; }
    CommandQueue& commands() { return commands_; }
    const BalanceConfig& config() const { return cfg_; }
    uint64_t ticks() const { return ctx_.tick; }
    // WS-D additions (additive): script / UI access
    AppState* app() { return app_; }
    GameUI& ui() { return ui_; }
    const Combat& combat() const { return combat_; }
    Combat& combat() { return combat_; }
    const SoldierAI& ai() const { return ai_; }
    const HordeBridge& horde() const { return horde_; }
    const Deploy& deploy() const { return deploy_; }
    const Logistics& logistics() const { return logistics_; }
    const Economy& economy() const { return economy_; }
    EngineerAI& engineers() { return engineers_; }              // 14d engineers (construction jobs, car clearing)
    Fortifications& fort() { return fort_; }                    // B2
    const Fortifications& fort() const { return fort_; }
    const Reanimation& reanimation() const { return reanim_; }
    const HordeVertical& vertical() const { return vertical_; }   // B3b
    HordeVertical& vertical() { return vertical_; }
    Structures& structures() { return structures_; }            // 14e towers, generators, floodlights, fuel stores
    const Structures& structures() const { return structures_; }
    FuelLogistics& fuel() { return fuel_; }                      // 14e fuel from cars (siphon / disassemble)
    const FuelLogistics& fuel() const { return fuel_; }
    void structureLights(const AppState& app, std::vector<PointLight>& out) const;   // 14e lit floodlights (App)
    BuildingPlay& buildings() { return buildings_; }            // B3a
    const BuildingPlay& buildings() const { return buildings_; }
    struct SquadStart { int ammo = 0; };          // per squad (purchase order): total rounds when the squad was bought
    const std::vector<SquadStart>& squadStarts() const { return squadStarts_; }
    uint64_t purchasesRefused() const { return refused_; }
    double tickCpuMs() const { return tickMs_; }
    std::string takeScriptShot() { return script_.takeShot(); }
    bool shotPending() const { return script_.shotPending(); }
    const GameScript& script() const { return script_; }
    // GAME_DESIGN 14d: corpse rot gas + flamethrowers (CorpseGas / FlameAI); burning piles as voxel fire volumes (App)
    const CorpseGas& gas() const { return gas_; }
    CorpseGas& gas() { return gas_; }
    const FlameAI& flameAI() const { return flame_; }
    void flameVolumes(float camX, float camZ, double time, std::vector<FlameVolume>& out) const { gasRender_.flameVolumes(camX, camZ, time, out); }
    void flameLights(double time, std::vector<PointLight>& out) const { gasRender_.flameLights(time, out); }

private:
    void tick(AppState& app);
    void applyCommands(AppState& app);
    void rebuildNav(AppState& app);

    GameOptions opt_;
    BalanceConfig cfg_;
    SoldierPool soldiers_;
    SquadList squads_;
    NavGrid nav_;
    HordeBridge horde_;
    SoldierAnimator animator_;
    SoldierAI ai_;
    Combat combat_;
    Economy economy_;
    Logistics logistics_;
    Deploy deploy_;
    Fortifications fort_;
    EngineerAI engineers_;           // 14d: engineers build walls / gates and clear cars (jobs, radius)
    Reanimation reanim_;
    HordeVertical vertical_;         // B3b: zombies in buildings (entrances, stairs, roofs, barricades)
    BuildingPlay buildings_;         // B3a: capture, garrison, hospital, barricades
    CorpseGas gas_;                  // 14d: corpse rot gas, ground fire, flame damage (GPU)
    CorpseGasRender gasRender_;      // 14d: haze / flies / ground fire draw (Renderer extension)
    FlameAI flame_;                  // 14d: flamethrower squads (corpse burning, flame rounds)
    Structures structures_;          // 14e: towers, generators, floodlights, fuel stores (StructuresGame.cpp: App side)
    FuelLogistics fuel_;             // 14e: siphon / disassemble -> jerrycans carried to the fuel store
    bool structUi_ = false;          // 14e hover menus installed after GameUI's built-ins
    uint64_t gasWarned_ = 0;         // squads (bit per squad index < 64) already warned about gas
    CommandQueue commands_;
    std::vector<Command> applying_;
    GameUI ui_;
    GameRender render_;
    GameScript script_;
    TickEvents events_;
    std::vector<AnimEvent> animEvents_;
    GameContext ctx_;
    double accumulator_ = 0.0;
    bool finished_ = false;
    AppState* app_ = nullptr;
    std::vector<SquadStart> squadStarts_;
    uint64_t refused_ = 0, overflowSeen_ = 0;
    float navOx_ = 1e9f, navOz_ = 1e9f;
    bool navDirty_ = false;
    double navBuiltAt_ = -1e9, tickMs_ = 0;
};

} // namespace ttz::game
