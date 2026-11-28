// GameWorld: integration of the gameplay modules (WS-D owns this file). Tick order: see GameWorld.h.
#include "game/GameWorld.h"
#include "audio/GameAudioBridge.h"   // [SOUND HOOK]

#include "app/App.h"
#include "game/BuildingGame.h"
#include "debug/Profiler.h"
#include "lab/MilitaryAssets.h"

#include <SDL3/SDL.h>
#include <algorithm>

namespace ttz::game {
// 14e structures + fuel (StructuresGame.cpp: App side of Structures / FuelLogistics)
void installStructures(GameWorld& w, AppState& app);
void installStructureHover(GameWorld& w);
bool structureCommand(GameWorld& w, AppState& app, const Command& c);
void drawStructures(MilitaryRenderer& mil, GameWorld& w, float frameDt);

namespace {
// Clip timings for the deploy / crate timelines from the approved clips (Deploy / Logistics stay library-free so the
// headless self-test can link them without the renderer).
void timingFromLibrary(const MilitaryLibrary& lib, DeployTiming& t, Logistics& lg) {
    static const char* cls[4] = {"rifleman", "mg", "sniper", "flamer"};   // flamer: approved specialist assets (14d)
    for (int c = 0; c < 4; ++c) {
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
    setWallEnvBuildings(&buildings_.registry());              // 14e: exact facades for wall sealing
    if (gas_.init(app.gpu, app.sim)) {                         // 14d: corpse rot gas + flame fire
        gas_.configure(cfg_.rot, cfg_.flame);
        gas_.setSync(opt.syncReadback);
        ctx_.gas = &gas_;
    } else SDL_Log("game: corpse gas unavailable (game_gas pipelines)");
    ctx_.flame = &flame_;
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
    ctx_.registry = &buildings_.registry();
    ctx_.walls = &fort_.walls();
    ctx_.territory = &fort_.territory();
    ctx_.engineers = &engineers_;                              // 14d: construction radius, jobs, car clearing
    engineers_.ai = &ai_;
    engineers_.removeVehicle = [&app](uint32_t v) { app.vehicles.removeVehicle(v); };
    buildings_.addObstacle = [&app](float cx, float cz, float hx, float hz, float yaw, float top) { return app.vehicles.addObstacle(cx, cz, hx, hz, yaw, top); };
    buildings_.carNear = [&app](float x, float z, float r) { return app.vehicles.parkedAt(x, z, r) != UINT32_MAX; };
    ai_.workHook = [this](GameContext& c, uint32_t i) { return engineers_.work(c, i); };
    ai_.workFirstHook = [this](const GameContext& c, uint32_t i, V3 t, float d) { return engineers_.keepWorking(c, i, t, d); };
    installStructures(*this, app);                             // 14e: tower / generator / light / fuel jobs, car fuel, UI
    ctx_.events = &events_;
    ctx_.animEvents = &animEvents_;
    if (!opt.script.empty()) {
        if (!script_.load(opt.script, &err)) { SDL_Log("game: script: %s", err.c_str()); return false; }
        SDL_Log("game: script %s", opt.script.c_str());
    }
    if (!render_.init(app)) SDL_Log("game: soldier renderer unavailable");
    if (ctx_.gas && !gasRender_.init(app, gas_)) SDL_Log("game: gas renderer unavailable");
    render_.extraDraw = [this](MilitaryRenderer& mil, float fdt) { fort_.draw(mil, ctx_, fdt); drawBuildingProps(mil, ctx_, buildings_, app_); drawStructures(mil, *this, fdt); };
    // B3a buildings: BLDG records of the tiles under the window, UI hooks, hospital seeking (SoldierAI hook)
    syncBuildings(app, buildings_, fort_.navHeights(app), cfg_);
    installBuildingUI(ui_, buildings_);
    ai_.medicalSeek = [this](GameContext& c, uint32_t i) { return buildings_.medicalSeek(c, i); };
    render_.droppedWeapons = &reanim_.weapons();
    if (const MilitaryLibrary* lib = render_.library()) {
        animator_.init(*lib);
        animator_.configure(cfg_);   // fire / reload clip rates matched to the weapon stats
        timingFromLibrary(*lib, deploy_.timing, logistics_);
        {   // 14d engineers: approved "engineer" infantry when it exists, else the placeholder rifleman variant (never a rifleman)
            DeployTiming& t = deploy_.timing;
            std::vector<int> approved, placeholder;
            for (size_t i = 0; i < lib->infantry.size(); ++i) {
                if (lib->infantry[i].cls == "engineer") approved.push_back((int)i);
                else if (lib->infantry[i].variant.find("Engineer") != std::string::npos) placeholder.push_back((int)i);
            }
            t.engineerVariants = approved.empty() ? placeholder : approved;
            std::vector<int>& rv = t.variants[(size_t)SoldierClass::Rifleman];
            rv.erase(std::remove_if(rv.begin(), rv.end(), [&](int i) { return lib->infantry[(size_t)i].variant.find("Engineer") != std::string::npos; }), rv.end());
        }
        // 14d flamethrowers: the approved "flamer" infantry (specialists.json); the rifleman placeholder only if absent
        if (deploy_.timing.variants[(size_t)SoldierClass::Flamethrower].empty()) FlameAI::usePlaceholderAssets(deploy_.timing);
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
    shutdownBuildingRender(app);   // B3a / 14e garrison window rooms
    gasRender_.shutdown(app);
    gas_.shutdown();
    render_.shutdown(app);
    fort_.shutdown();
    vertical_.shutdown();
    horde_.shutdown();
}

void GameWorld::rebuildNav(AppState& app) {
    const Sandbox& sb = app.sandbox;
    const std::vector<float>& h = fort_.navHeights(app);   // sim heights, gate passages lowered (B2)
    if (h.size() != (size_t)sb.gridW * (size_t)sb.gridH) return;
    nav_.setMask(fort_.navMask());                     // 14e: car roofs / wall tops never walkable, blueprints reserved
    nav_.build(h, sb.gridW, sb.gridH, sb.originX, sb.originZ, sb.cellSize);
    nav_.setShotHeights(app.vehicles.simHeights());   // rounds stop at the zombies' grid (gates included)
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
            const char* what = c.squadType == SquadType::Rifle ? "rifle squad" : c.squadType == SquadType::MachineGun ? "mg squad"
                             : c.squadType == SquadType::Flamethrower ? "flamethrower squad" : c.squadType == SquadType::Engineer ? "engineer squad" : "sniper";
            if (!plan.valid) { ++refused_; ui_.notify(std::string("Drop refused: ") + plan.reason, true, ctx_.time); break; }
            if (!economy_.spend(plan.price, what, ctx_.time)) { ++refused_; ui_.notify("Not enough funding", true, ctx_.time); break; }
            SquadId id = deploy_.execute(ctx_, c.squadType, plan);
            if (id.index >= squadStarts_.size()) squadStarts_.resize(id.index + 1);
            if (const Squad* s = squads_.get(id)) {
                int ammo = 0;
                for (const SoldierId& m : s->members) ammo += soldiers_.mag[m.index] + soldiers_.reserve[m.index];
                squadStarts_[id.index].ammo = ammo;
                char t[96];
                std::snprintf(t, sizeof(t), "%s %u inbound%s", c.squadType == SquadType::Rifle ? "Rifle squad" : c.squadType == SquadType::MachineGun ? "MG squad"
                              : c.squadType == SquadType::Flamethrower ? "Flamethrower squad" : c.squadType == SquadType::Engineer ? "Engineers" : "Sniper",
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
        case CommandType::ClearCar: {   // 14d: engineers tow / dismantle a parked vehicle (charged once, then a job)
            const uint32_t v = app.vehicles.parkedAt(c.pos.x, c.pos.z, cfg_.engineer.carSearch);
            Obb b;
            if (v != UINT32_MAX) { app.vehicles.groundBox(v, b.cx, b.cz, b.hx, b.hz, b.yaw); b.top = 2.f; }
            const char* why = v == UINT32_MAX ? "no parked vehicle there" : engineers_.carOrdered(v) ? "already being cleared"
                            : !engineers_.inRange(ctx_, b.cx, b.cz) ? "outside engineer range" : nullptr;
            if (why) { ++refused_; ui_.notify(std::string("Clearing refused: ") + why, true, ctx_.time); break; }
            if (!economy_.spend(cfg_.engineer.carPrice, "clear car", ctx_.time)) { ++refused_; ui_.notify("Not enough funding", true, ctx_.time); break; }
            engineers_.orderCar(ctx_, v, b, &why);
            ui_.notify("Engineers: clearing the vehicle", false, ctx_.time);
            break;
        }
        case CommandType::UndoBuild: {
            std::string msg;
            ui_.notify(msg, !fort_.undo(ctx_, economy_, msg), ctx_.time);
            break;
        }
        case CommandType::BuildGate:
        case CommandType::BuildWall: {   // B2: plan (validated) -> charge once -> build; refused plans cost nothing
            std::string msg;
            if (!fort_.build(app, ctx_, c, economy_, msg)) { ++refused_; ui_.notify("Wall refused: " + msg, true, ctx_.time); break; }
            ui_.notify(msg, false, ctx_.time);
            break;
        }
        case CommandType::BuildStructure:
        case CommandType::OccupyTower:
        case CommandType::SiphonCar:
            if (!structureCommand(*this, app, c)) ++refused_;   // 14e (StructuresGame.cpp)
            break;
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
    structures_.preAi(ctx_);                                   // c'' 14e: a new order brings tower posts down the ladder
    engineers_.tick(ctx_);                                     // c3 14d: construction jobs -> engineer work spots
    ai_.tick(ctx_);                                            // d
    engineers_.postAi(ctx_);                                   // d2 14d: work clip for engineers at work
    flame_.tick(ctx_);                                         // d3 14d: flamethrowers seek / spray corpse piles
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
    {   // 14e: towers (climb, posts, base pressure), generators / lights / noise, fuel carriers
        const float h = app.renderSettings.tod.hours;
        structures_.night = h >= 18.f || h < 6.f;
        structures_.tick(ctx_);
        fuel_.tick(ctx_, structures_);
        for (const NoiseEvent& n : structures_.noise()) combat_.addNoise(n);
        structures_.noise().clear();
        std::vector<StructureNotice> sn;
        structures_.takeNotices(sn);
        for (const StructureNotice& n : sn) ui_.notifyAt(n.text, n.bad, ctx_.time, n.pos);
        for (const auto& n : fuel_.notices()) ui_.notify(n.first, n.second, ctx_.time);
        fuel_.notices().clear();
        structures_.preCombat(ctx_, combat_.extraCapsules);
    }
    buildings_.preCombat(ctx_);
    combat_.tick(ctx_);                                        // f (also j: uploads soldiers / hits / attractors)
    vertical_.tick(horde_.uploadedSoldiers(), ctx_.time);     // f'' B3b: active buildings, door attractors, interior fights
    buildings_.postCombat(ctx_);                               // f' nests: contact damage scaled (defence value)
    for (const NoiseEvent& n : flame_.noise()) combat_.addNoise(n);   // f3 14d: flamethrower noise, gas damage / warnings
    flame_.noise().clear();
    if (ctx_.gas) {
        gas_.tick(ctx_);
        nav_.setCostLayer(&gas_.navCost(), gas_.width(), gas_.height(), gas_.originX(), gas_.originZ(), gas_.cellSize(), cfg_.rot.navCost);
        for (size_t k = 0; k < squads_.squads.size() && k < 64; ++k) {
            const Squad& s = squads_.squads[k];
            const bool g = (s.flags & SQ_GAS) != 0;
            if (g && !(gasWarned_ >> k & 1u)) {
                char t[96];
                std::snprintf(t, sizeof(t), "Squad %u is standing in corpse gas", s.number);
                ui_.notify(t, true, ctx_.time);
            }
            gasWarned_ = g ? gasWarned_ | (1ull << k) : gasWarned_ & ~(1ull << k);
        }
    }
    logistics_.tick(ctx_);                                     // g
    fort_.tick(app, ctx_);                                     // g' B2: walls, breaches, obstacles, territory, income rate
    {
        std::vector<TerritoryNotice> tn;
        fort_.takeNotices(tn);
        for (const TerritoryNotice& n : tn) ui_.notify(n.text, n.bad, ctx_.time);
        for (const TerritoryNotice& n : tn) if (n.bad) events_.cues.push_back({AudioCueKind::AlertBreach, {n.x, 0.f, n.z}, 1.f});   // [SOUND HOOK] breach / territory lost
    }
    economy_.tick(ctx_);                                       // h
    if (script_.loaded() && !script_.tick(*this, ctx_.time)) finished_ = true;   // i
    audio::bridgeTick(app, events_, soldiers_, horde_.contacts());                           // [SOUND HOOK] TickEvents -> audio (consumes cues)
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

void GameWorld::postSim(AppState& app, SDL_GPUCommandBuffer* cmd) {
    horde_.postSim(cmd, app.frameIndex); vertical_.postSim(cmd); fort_.postSim(cmd);
    if (ctx_.gas) gas_.postSim(cmd);   // 14d: after the horde's field passes (damage queue of the last step's sort)
}

void GameWorld::render(AppState& app, float frameDt) {
    render_.setSelection(ui_.selection().squads);   // in-world selection rings (WS-B); GameUI draws the screen-space status
    render_.update(app, ctx_, frameDt, (float)(accumulator_ / kTickDt), events_.fx);
    gasRender_.noteFlames(events_.fx, app.sim.simTime(), cfg_.weapon[(size_t)SoldierClass::Flamethrower].range);   // 14d voxel flame volumes
}

void GameWorld::drawUI(AppState& app) {
    ui_.draw(app, ctx_, commands_);
    if (!structUi_) { installStructureHover(*this); structUi_ = true; }   // 14e: after GameUI's built-in hover menus
}

void GameWorld::afterSubmit(AppState& app) {
    horde_.harvest(); vertical_.harvest(); fort_.afterSubmit(opt_.syncReadback);
    if (ctx_.gas) gas_.harvest();
}

} // namespace ttz::game
