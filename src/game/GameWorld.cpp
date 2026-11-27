// GameWorld: integration of the gameplay modules (WS-D owns this file). Interface step: the order of calls is final,
// the modules behind them are stubs.
#include "game/GameWorld.h"

#include "app/App.h"

#include <SDL3/SDL.h>

namespace ttz::game {

bool GameWorld::init(AppState& app, const GameOptions& opt) {
    opt_ = opt;
    std::string err;
    if (!cfg_.load(opt.balancePath, &err)) SDL_Log("game: %s (using built-in UNAPPROVED defaults)", err.c_str());
    SDL_Log("game: balance %s (%s)", opt.balancePath.c_str(), cfg_.status.c_str());
    if (!horde_.init(app.gpu, app.sim)) return false;
    // Soldier navigation from the window's live height grid (static + vehicles); rebuilt when the window moves.
    const Sandbox& sb = app.sandbox;
    if (!app.vehicles.simHeights().empty())
        nav_.build(app.vehicles.simHeights(), sb.gridW, sb.gridH, sb.originX, sb.originZ, sb.cellSize);
    economy_.reset(cfg_);
    ctx_.cfg = &cfg_;
    ctx_.soldiers = &soldiers_;
    ctx_.squads = &squads_;
    ctx_.nav = &nav_;
    ctx_.horde = &horde_;
    ctx_.animator = &animator_;
    ctx_.economy = &economy_;
    ctx_.logistics = &logistics_;
    ctx_.deploy = &deploy_;
    ctx_.events = &events_;
    ctx_.animEvents = &animEvents_;
    if (!opt.script.empty()) {
        if (!script_.load(opt.script, &err)) { SDL_Log("game: script: %s", err.c_str()); return false; }
        SDL_Log("game: script %s", opt.script.c_str());
    }
    if (!render_.init(app)) SDL_Log("game: soldier renderer unavailable (stub)");
    if (const MilitaryLibrary* lib = render_.library()) animator_.init(*lib);
    SDL_Log("game: --game mode ready (Milestone B1 interfaces; no behaviour yet)");
    return true;
}

void GameWorld::shutdown(AppState& app) {
    render_.shutdown(app);
    horde_.shutdown();
}

bool GameWorld::handleEvent(AppState& app, const SDL_Event& e) { return ui_.handleEvent(app, ctx_, e, commands_); }

void GameWorld::applyCommands(AppState& app) {
    commands_.take(applying_);
    for (const Command& c : applying_) {
        switch (c.type) {
        case CommandType::Select: ui_.selection().squads = c.squads; break;
        case CommandType::Move:
        case CommandType::Stop:
            for (const SquadId& id : c.squads)
                if (Squad* s = squads_.get(id)) {
                    s->order.active = c.type == CommandType::Move;
                    s->order.dest = c.pos; s->order.facing = c.facing; s->order.run = c.run; ++s->order.serial;
                }
            break;
        case CommandType::BuySquad: {
            DropPlan plan = deploy_.plan(ctx_, c.squadType, c.pos);
            if (plan.valid && economy_.spend(plan.price, "squad", ctx_.time)) deploy_.execute(ctx_, c.squadType, plan);
            break;
        }
        case CommandType::BuyContainer:
            if (logistics_.canPlaceContainer(ctx_, c.pos, c.facing) && economy_.spend(cfg_.economy.containerPrice, "container", ctx_.time))
                logistics_.placeContainer(ctx_, c.pos, c.facing);
            break;
        case CommandType::BuyAirdrop:
            if (logistics_.canAirdrop(ctx_, c.pos) && economy_.spend(cfg_.economy.airdropPrice, "airdrop", ctx_.time))
                logistics_.airdrop(ctx_, c.pos);
            break;
        case CommandType::Spawn:
            app.sim.requestSpawn({c.pos.x - c.facing, c.pos.z - c.facing, c.pos.x + c.facing, c.pos.z + c.facing}, (uint32_t)c.count);
            break;
        }
    }
    applying_.clear();
}

void GameWorld::tick(AppState& app) {
    events_.shots.clear(); events_.kills.clear(); events_.noise.clear();   // per tick (fx: per frame, see preSim)
    animEvents_.clear();
    applyCommands(app);                                        // a
    horde_.takeKills(events_.kills);                           // b
    for (const KillEvent& k : events_.kills) economy_.creditKill(k, ctx_.time);
    deploy_.tick(ctx_);                                        // c
    ai_.tick(ctx_);                                            // d
    for (uint32_t i = 0; i < (uint32_t)soldiers_.capacity(); ++i) {   // e
        if (!soldiers_.used[i]) continue;
        float root[3] = {0, 0, 0};
        animator_.tick(i, soldiers_.infantry[i], soldiers_.anim[i], ctx_.dt, animEvents_, root);
    }
    combat_.tick(ctx_);                                        // f (also j: uploads soldiers / hits / attractors)
    logistics_.tick(ctx_);                                     // g
    economy_.tick(ctx_);                                       // h
    if (script_.loaded() && !script_.tick(*this, ctx_.time)) finished_ = true;   // i
    ctx_.time += kTickDt;
    ++ctx_.tick;
}

void GameWorld::preSim(AppState& app, SDL_GPUCommandBuffer* cmd, double frameDt) {
    events_.fx.clear();                                        // FX of every tick of this frame reach the renderer
    if (!app.paused) {
        accumulator_ += frameDt * app.simSpeed;
        int n = 0;
        while (accumulator_ >= kTickDt && n < kMaxTicksPerFrame) { tick(app); accumulator_ -= kTickDt; ++n; }
        if (accumulator_ > kTickDt) accumulator_ = 0.0;     // cannot keep up: drop game time like the sim does
    }
    horde_.preSim(cmd);
}

void GameWorld::postSim(AppState& app, SDL_GPUCommandBuffer* cmd) { horde_.postSim(cmd, app.frameIndex); }

void GameWorld::render(AppState& app, float frameDt) {
    render_.update(app, ctx_, frameDt, (float)(accumulator_ / kTickDt), events_.fx);
}

void GameWorld::drawUI(AppState& app) { ui_.draw(app, ctx_, commands_); }

void GameWorld::afterSubmit(AppState& app) { horde_.harvest(); }

} // namespace ttz::game
