// GameWorld: integration of the gameplay modules (WS-D owns this file). Tick order: see GameWorld.h.
#include "game/GameWorld.h"

#include "app/App.h"
#include "game/BuildingGame.h"
#include "debug/Profiler.h"
#include "lab/MilitaryAssets.h"

#include <SDL3/SDL.h>
#include <algorithm>

namespace ttz::game {

namespace {
// Clip timings for the deploy / crate timelines from the approved clips (Deploy / Logistics stay library-free so the
// headless self-test can link them without the renderer).
void timingFromLibrary(const MilitaryLibrary& lib, DeployTiming& t, Logistics& lg) {
    static const char* cls[3] = {"rifleman", "mg", "sniper"};
    for (int c = 0; c < 3; ++c) {
        t.variants[(size_t)c].clear();
        for (size_t i = 0; i < lib.infantry.size(); ++i) if (lib.infantry[i].cls == cls[c]) t.variants[(size_t)c].push_back((int)i);
        for (const MilKeyClip& k : lib.keyClips) {
            if (k.cls != cls[c]) continue;
            if (k.action == "para_descent" && k.descentSpeed > 0.5f) t.descentSpeed[(size_t)c] = k.descentSpeed;
            if (k.action == "para_land") t.landDuration[(size_t)c] = k.duration;
            if (k.action == "para_recover") t.recoverDuration[(size_t)c] = k.duration;
        }
    }
    for (const MilKeyClip& k : lib.keyClips) {
        if (k.cls != "crate") continue;
        if (k.action == "descent" && k.descentSpeed > 0.5f) t.crateDescentSpeed = k.descentSpeed;
        if (k.action == "land") t.crateLandDuration = k.duration;
    }
    lg.crateDescentSpeed = t.crateDescentSpeed;
    lg.crateLandDuration = t.crateLandDuration;
}
} // namespace

bool GameWorld::init(AppState& app, const GameOptions& opt) {
    opt_ = opt;
    app_ = &app;
    std::string err;
    if (!cfg_.load(opt.balancePath, &err)) SDL_Log("game: %s (using built-in UNAPPROVED defaults)", err.c_str());
    SDL_Log("game: balance %s (%s)", opt.balancePath.c_str(), cfg_.status.c_str());
    if (!horde_.init(app.gpu, app.sim)) return false;
    horde_.setAwarenessRadius(cfg_.threat.awarenessRadius);
    horde_.setAttackReach(cfg_.threat.attackReach);
    horde_.setThreatRadius(ai_.tuning.scanRadius);   // exact nearest-zombie lists for targeting
    horde_.setSync(opt.syncReadback);
    if (vertical_.init(app.gpu, app.sim, horde_)) {   // B3b: building-local zombie navigation (GAME_DESIGN 7)
        horde_.setVertical(true);
        vertical_.setSync(opt.syncReadback);
        vertical_.cfg = cfg_.vertical;
        vertical_.awareness = cfg_.threat.awarenessRadius;
        BuildingRegistry& reg = buildings_.registry();
        vertical_.buildings = &reg.all();
        vertical_.lookup = [&reg](float x, float z) { return reg.at(x, z); };
        vertical_.damageBarricade = [&reg](BuildingId b, uint16_t op, float dmg) { reg.damageBarricade(b, op, dmg); };
        vertical_.setZombieCounts = [&reg](BuildingId b, int in, int roof, const int16_t* pf, int n) { reg.setZombieCounts(b, in, roof, pf, n); };
    } else SDL_Log("game: vertical horde unavailable (game_vertical pipeline)");
    fort_.init(app, cfg_);                                     // B2: walls, territory, containers as obstacles
    rebuildNav(app);
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
    ctx_.walls = &fort_.walls();
    ctx_.territory = &fort_.territory();
    ctx_.events = &events_;
    ctx_.animEvents = &animEvents_;
    if (!opt.script.empty()) {
        if (!script_.load(opt.script, &err)) { SDL_Log("game: script: %s", err.c_str()); return false; }
        SDL_Log("game: script %s", opt.script.c_str());
    }
    if (!render_.init(app)) SDL_Log("game: soldier renderer unavailable");
    render_.extraDraw = [this](MilitaryRenderer& mil, float fdt) { fort_.draw(mil, ctx_, fdt); drawBuildingProps(mil, ctx_, buildings_); };
    // B3a buildings: BLDG records of the tiles under the window, UI hooks, hospital seeking (SoldierAI hook)
    syncBuildings(app, buildings_, fort_.navHeights(app), cfg_);
    installBuildingUI(ui_, buildings_);
    ai_.medicalSeek = [this](GameContext& c, uint32_t i) { return buildings_.medicalSeek(c, i); };
    render_.droppedWeapons = &reanim_.weapons();
    if (const MilitaryLibrary* lib = render_.library()) {
        animator_.init(*lib);
        animator_.configure(cfg_);   // fire / reload clip rates matched to the weapon stats
        timingFromLibrary(*lib, deploy_.timing, logistics_);
        SDL_Log("game: deploy timeline from clips: descent %.1f m/s, land %.2f s, recover %.2f s; crate %.1f m/s",
                deploy_.timing.descentSpeed[0], deploy_.timing.landDuration[0], deploy_.timing.recoverDuration[0], deploy_.timing.crateDescentSpeed);
    }
    // the sandbox has no gameplay tools in --game, and no scenario goal: zombies mill about until noise / soldiers draw them
    app.sim.setGoals({});
    ui_.notify("Deploy a squad: choose it in the bar below, then click a street or a flat roof", false, 0.0);
    SDL_Log("game: --game mode ready (Milestone B1)");
    return true;
}

void GameWorld::shutdown(AppState& app) {
    render_.shutdown(app);
    fort_.shutdown();
    vertical_.shutdown();
    horde_.shutdown();
}

void GameWorld::rebuildNav(AppState& app) {
    const Sandbox& sb = app.sandbox;
    const std::vector<float>& h = fort_.navHeights(app);   // sim heights, gate passages lowered (B2)
    if (h.size() != (size_t)sb.gridW * (size_t)sb.gridH) return;
    nav_.build(h, sb.gridW, sb.gridH, sb.originX, sb.originZ, sb.cellSize);
    navOx_ = sb.originX; navOz_ = sb.originZ;
    navDirty_ = false;
    navBuiltAt_ = ctx_.time;
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
                    s->order.dest = c.type == CommandType::Move ? c.pos : s->order.dest;
                    if (c.type == CommandType::Move) { s->order.facing = c.facing; s->order.run = c.run; s->order.walk = c.walk && !c.run; }
                    ++s->order.serial;
                }
            break;
        case CommandType::BuySquad: {   // 2: confirm -> charge once -> drop (an invalid spot is refused without charge)
            DropPlan plan = deploy_.plan(ctx_, c.squadType, c.pos);
            const char* what = c.squadType == SquadType::Rifle ? "rifle squad" : c.squadType == SquadType::MachineGun ? "mg squad" : "sniper";
            if (!plan.valid) { ++refused_; ui_.notify(std::string("Drop refused: ") + plan.reason, true, ctx_.time); break; }
            if (!economy_.spend(plan.price, what, ctx_.time)) { ++refused_; ui_.notify("Not enough funding", true, ctx_.time); break; }
            SquadId id = deploy_.execute(ctx_, c.squadType, plan);
            if (id.index >= squadStarts_.size()) squadStarts_.resize(id.index + 1);
            if (const Squad* s = squads_.get(id)) {
                int ammo = 0;
                for (const SoldierId& m : s->members) ammo += soldiers_.mag[m.index] + soldiers_.reserve[m.index];
                squadStarts_[id.index].ammo = ammo;
                char t[96];
                std::snprintf(t, sizeof(t), "%s %u inbound%s", c.squadType == SquadType::Rifle ? "Rifle squad" : c.squadType == SquadType::MachineGun ? "MG squad" : "Sniper",
                              s->number, plan.rooftop ? " (rooftop drop)" : "");
                ui_.notify(t, false, ctx_.time);
            }
            break;
        }
        case CommandType::BuyContainer: {
            const char* why = "";
            if (!logistics_.canPlaceContainer(ctx_, c.pos, c.facing, &why) || !fort_.containerAllowed(ctx_, c.pos, &why)) { ++refused_; ui_.notify(std::string("Container refused: ") + why, true, ctx_.time); break; }
            if (!economy_.spend(cfg_.economy.containerPrice, "container", ctx_.time)) { ++refused_; ui_.notify("Not enough funding", true, ctx_.time); break; }
            logistics_.placeContainer(ctx_, c.pos, c.facing);
            ui_.notify("Ammo container placed", false, ctx_.time);
            break;
        }
        case CommandType::BuyAirdrop: {
            const char* why = "";
            if (!logistics_.canAirdrop(ctx_, c.pos, &why)) { ++refused_; ui_.notify(std::string("Airdrop refused: ") + why, true, ctx_.time); break; }
            if (!economy_.spend(cfg_.economy.airdropPrice, "airdrop", ctx_.time)) { ++refused_; ui_.notify("Not enough funding", true, ctx_.time); break; }
            logistics_.airdrop(ctx_, c.pos);
            ui_.notify("Ammo drop inbound", false, ctx_.time);
            break;
        }
        case CommandType::BuildWall: {   // B2: plan (validated) -> charge once -> build; refused plans cost nothing
            std::string msg;
            if (!fort_.build(app, ctx_, c, economy_, msg)) { ++refused_; ui_.notify("Wall refused: " + msg, true, ctx_.time); break; }
            ui_.notify(msg, false, ctx_.time);
            break;
        }
        case CommandType::Spawn:
            app.sim.requestSpawn({c.pos.x - c.facing, c.pos.z - c.facing, c.pos.x + c.facing, c.pos.z + c.facing}, (uint32_t)c.count);
            break;
        }
    }
    applying_.clear();
}

void GameWorld::tick(AppState& app) {
    const double t0 = nowMs();
    events_.shots.clear(); events_.kills.clear(); events_.noise.clear();   // per tick (fx: per frame, see preSim)
    animEvents_.clear();
    applyCommands(app);                                        // a
    horde_.takeKills(events_.kills);                           // b
    for (const KillEvent& k : events_.kills) economy_.creditKill(k, ctx_.time);
    if (horde_.killsOverflowed() > overflowSeen_) {            // ring overflow: paid anonymously, never lost
        economy_.creditAnonymousKills(horde_.killsOverflowed() - overflowSeen_, ctx_.time);
        overflowSeen_ = horde_.killsOverflowed();
    }
    deploy_.tick(ctx_);                                        // c
    buildings_.preAi(ctx_);                                    // c'' B3a: a new order releases garrisoned soldiers
    ai_.tick(ctx_);                                            // d
    reanim_.tick(ctx_, &animator_);                            // d': dead soldiers rise as zombies (GAME_DESIGN 14c)
    for (uint32_t i = 0; i < (uint32_t)soldiers_.capacity(); ++i) {   // e
        if (!soldiers_.used[i]) continue;
        float root[3] = {0, 0, 0};
        animator_.tick(i, soldiers_.infantry[i], soldiers_.anim[i], ctx_.dt, animEvents_, root);
        const V3 before = soldiers_.pos[i];
        SoldierAnimator::applyRootMotion(soldiers_.pos[i], soldiers_.yaw[i], root);   // turns, para_land offset
        if ((root[0] != 0.f || root[1] != 0.f) && nav_.ready() && soldiers_.state[i] != SoldierState::Descending) {
            // committed root motion never carries a body off a roof edge or into a wall: keep it on the walkable surface
            V3& p = soldiers_.pos[i];
            if (!nav_.walkLine(before, p) && nav_.walkable(before.x, before.z)) { p.x = before.x; p.z = before.z; }
            p.y = nav_.surface(p.x, p.z);
        }
    }
    deploy_.onAnimEvents(ctx_);                                // c': touchdown / canopy_ground / weapon_draw of this tick
    buildings_.tick(ctx_);                                     // e' B3a: capture, entering, posts pinned, hospital, barricades
    {
        std::vector<BuildingNotice> bn;
        buildings_.takeNotices(bn);
        for (const BuildingNotice& n : bn) ui_.notify(n.text, n.bad, ctx_.time);
    }
    buildings_.preCombat(ctx_);
    combat_.tick(ctx_);                                        // f (also j: uploads soldiers / hits / attractors)
    vertical_.tick(horde_.uploadedSoldiers(), ctx_.time);     // f'' B3b: active buildings, door attractors, interior fights
    buildings_.postCombat(ctx_);                               // f' nests: contact damage scaled (defence value)
    logistics_.tick(ctx_);                                     // g
    fort_.tick(app, ctx_);                                     // g' B2: walls, breaches, obstacles, territory, income rate
    {
        std::vector<TerritoryNotice> tn;
        fort_.takeNotices(tn);
        for (const TerritoryNotice& n : tn) ui_.notify(n.text, n.bad, ctx_.time);
    }
    economy_.tick(ctx_);                                       // h
    if (script_.loaded() && !script_.tick(*this, ctx_.time)) finished_ = true;   // i
    ctx_.time += kTickDt;
    ++ctx_.tick;
    tickMs_ = nowMs() - t0;
}

void GameWorld::preSim(AppState& app, SDL_GPUCommandBuffer* cmd, double frameDt) {
    events_.fx.clear();                                        // FX of every tick of this frame reach the renderer
    // navigation follows the window (moved) and vehicle changes (rows uploaded), at most once per second
    const Sandbox& sb = app.sandbox;
    if (sb.originX != navOx_ || sb.originZ != navOz_) { fort_.windowMoved(app); rebuildNav(app); syncBuildings(app, buildings_, fort_.navHeights(app), cfg_); }
    else fort_.patchNav(app, nav_);   // rows the vehicles / walls changed: local NavGrid patches (B2: no global rebuilds)
    if (!app.paused) {
        accumulator_ += frameDt * app.simSpeed;
        int n = 0;
        while (accumulator_ >= kTickDt && n < kMaxTicksPerFrame) { tick(app); accumulator_ -= kTickDt; ++n; }
        if (accumulator_ > kTickDt) accumulator_ = 0.0;     // cannot keep up: drop game time like the sim does
    }
    horde_.preSim(cmd);
}

void GameWorld::postSim(AppState& app, SDL_GPUCommandBuffer* cmd) { horde_.postSim(cmd, app.frameIndex); vertical_.postSim(cmd); fort_.postSim(cmd); }

void GameWorld::render(AppState& app, float frameDt) {
    render_.setSelection(ui_.selection().squads);   // in-world selection rings (WS-B); GameUI draws the screen-space status
    render_.update(app, ctx_, frameDt, (float)(accumulator_ / kTickDt), events_.fx);
}

void GameWorld::drawUI(AppState& app) { ui_.draw(app, ctx_, commands_); }

void GameWorld::afterSubmit(AppState& app) { horde_.harvest(); vertical_.harvest(); fort_.afterSubmit(opt_.syncReadback); }

} // namespace ttz::game
