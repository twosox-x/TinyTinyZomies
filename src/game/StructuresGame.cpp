// GAME_DESIGN 14e structures + fuel, App side: obstacles, EngineerAI hooks, commands, drawing (placeholder props until
// the owner approves assets/military/structures.*), floodlight point lights, HUD actions / hover menus, script verbs.
#include "app/App.h"
#include "game/GameScript.h"
#include "game/GameUI.h"
#include "game/GameWorld.h"
#include "game/NavGrid.h"
#include "lab/MilitaryAssets.h"
#include "lab/MilitaryRenderer.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace ttz::game {
float hudScale();   // HudBar.cpp

// ---- ONE switch for the asset swap: false = placeholder props ("ph_*", MilitaryLibrary::addStructurePlaceholders),
// true = the authored props of assets/military/structures.* (PENDING REVIEW in docs/ASSET_APPROVALS.md). Flip it when
// the owner approves; a missing authored prop falls back to its placeholder either way.
constexpr bool kStructureAssetsApproved = true;   // owner wants the reviewed models in game (2026-11-28)

namespace {
float fa(const std::vector<std::string>& a, size_t k, float def = 0.f) { return k < a.size() ? (float)std::atof(a[k].c_str()) : def; }
const Squad* squadNo(const GameContext& ctx, int n) {
    if (!ctx.squads || n < 1 || n > (int)ctx.squads->squads.size()) return nullptr;
    return &ctx.squads->squads[(size_t)n - 1];
}
V3 ground(GameWorld& w, float x, float z) {
    const NavGrid* nav = w.context().nav;
    return {x, nav && nav->ready() ? nav->surface(x, z) : 0.f, z};
}
bool hasType(const UiCtx& u, SquadType t) {
    for (const SquadId& id : u.ui.selectionConst().squads)
        if (const Squad* s = u.ctx.squads ? u.ctx.squads->get(id) : nullptr) if (s->type == t) return true;
    return false;
}
bool hasShooters(const UiCtx& u) { return hasType(u, SquadType::Sniper) || hasType(u, SquadType::Rifle) || hasType(u, SquadType::MachineGun); }

// ---- props (resolved once per renderer)
struct StructProps {
    bool init = false;
    int tower = -1, generator = -1, light = -1, lightLamp = -1, store = -1, can = -1;
    int lampPart = -1;                 // authored floodlight: index of part "lamps"
    std::vector<int> canParts;         // authored fuel store: indices of parts can0..can5
    bool authored = false;
};
StructProps g_props;
std::vector<uint32_t> g_marked;        // script `markcar`: vehicles remembered by index (tests)

std::string partName(const MilitaryLibrary& lib, const MilProp& P, size_t k) {
    const int m = P.parts[k].first;
    if (m < 0 || m >= (int)lib.models.size()) return {};
    const std::string& n = lib.models[(size_t)m].name;
    const size_t s = n.rfind('/');
    return s == std::string::npos ? n : n.substr(s + 1);
}

void resolveProps(MilitaryRenderer& mil) {
    if (g_props.init) return;
    g_props.init = true;
    auto pick = [&](const char* authored, const char* ph) {
        const int a = kStructureAssetsApproved ? mil.findProp(authored) : -1;
        return a >= 0 ? a : mil.findProp(ph);
    };
    g_props.tower = pick("tower_wood", "ph_tower");
    g_props.generator = pick("generator", "ph_generator");
    g_props.light = pick("floodlight", "ph_floodlight");
    g_props.lightLamp = kStructureAssetsApproved && mil.findProp("floodlight") >= 0 ? -1 : mil.findProp("ph_floodlight_lamp");
    g_props.store = pick("fuel_store", "ph_fuel_store");
    g_props.can = pick("jerrycan", "ph_jerrycan");
    g_props.authored = kStructureAssetsApproved && mil.findProp("tower_wood") >= 0;
    const MilitaryLibrary& lib = mil.library();
    if (g_props.light >= 0) {
        const MilProp& P = lib.props[(size_t)g_props.light];
        for (size_t k = 0; k < P.parts.size(); ++k) if (partName(lib, P, k) == "lamps") g_props.lampPart = (int)k;
    }
    if (g_props.store >= 0) {
        const MilProp& P = lib.props[(size_t)g_props.store];
        for (size_t k = 0; k < P.parts.size(); ++k) if (partName(lib, P, k).rfind("can", 0) == 0) g_props.canParts.push_back((int)k);
    }
}

// one prop instance (Fortifications::putProp conventions): yaw as Obb, uniform xz scale, y scale (blueprint rise),
// dissolve 0..1; partMask: bit k = draw part k (all when ~0)
void put(MilitaryRenderer& mil, int prop, V3 o, float yaw, float sy, float dissolve, uint64_t partMask = ~0ull) {
    const MilitaryLibrary& lib = mil.library();
    if (prop < 0 || prop >= (int)lib.props.size() || dissolve >= 1.f) return;
    const MilProp& P = lib.props[(size_t)prop];
    auto one = [&](int m, std::array<float, 3> pv) {
        const float c = std::cos(yaw), s = std::sin(yaw);
        const float px = pv[0], py = pv[1] * sy, pz = pv[2];
        MilitaryRenderer::Inst gi{};
        gi.pos[0] = o.x + px * c + pz * s; gi.pos[1] = o.y + py; gi.pos[2] = o.z - px * s + pz * c;
        gi.pos[3] = 2.f + 0.9f * std::clamp(dissolve, 0.f, 1.f);
        gi.quat[0] = 0; gi.quat[1] = std::sin(0.5f * yaw); gi.quat[2] = 0; gi.quat[3] = std::cos(0.5f * yaw);
        gi.paint[0] = 1.f; gi.paint[1] = std::max(0.02f, sy); gi.paint[2] = 0.f; gi.paint[3] = -1e4f;
        mil.addInstance(m, gi);
    };
    if (P.parts.empty()) { one(P.model, {0, 0, 0}); return; }
    for (size_t k = 0; k < P.parts.size(); ++k)
        if (k >= 64 || (partMask >> k & 1ull)) one(P.parts[k].first, P.parts[k].second);
}
} // namespace

// ---------------------------------------------------------------------------------------------------------------------
void installStructures(GameWorld& w, AppState& app) {
    Structures& st = w.structures();
    FuelLogistics& fuel = w.fuel();
    EngineerAI& eng = w.engineers();
    const BalanceConfig* cfg = &w.config();
    st.addObstacle = [&app, cfg](const Structure& s) {
        const Obb b = Structures::footprint(s.kind, s.pos, s.yaw, cfg->structures);
        return app.vehicles.addObstacle(b.cx, b.cz, b.hx, b.hz, b.yaw, s.pos.y + b.top);
    };
    st.removeObstacle = [&app](uint32_t id) { app.vehicles.removeObstacle(id); };
    st.blockedAt = [&app](float x, float z, float r) { return app.vehicles.parkedAt(x, z, r) != UINT32_MAX; };
    fuel.carCondition = [&app](uint32_t v) {
        if (v >= app.vehicles.count()) return 1;
        const Vehicle& c = app.vehicles.vehicle(v);
        return (c.removed || c.drained || c.state == VehState::Burning || c.state == VehState::Wrecked) ? 1 : 0;
    };
    fuel.drain = [&app](uint32_t v) { app.vehicles.setDrained(v); };
    eng.externalJobs = [&w](const GameContext& ctx, std::vector<EngineerAI::ExternalJob>& out) {
        w.structures().jobs(ctx, out);
        w.fuel().jobs(ctx, out);
    };
    eng.externalWork = [&w](GameContext& ctx, const EngineerAI::ExternalJob& j, float add, uint32_t i) {
        return j.owner == 2 ? w.fuel().work(ctx, w.structures(), j, add, i) : w.structures().work(ctx, j, add);
    };
    eng.busy = [&w](uint32_t i) { return w.fuel().busy(i) || w.structures().towerOf(i) >= 0; };
    // disassembling a car (the existing clearing job) also yields its fuel (carried to the base)
    eng.removeVehicle = [&app, &w](uint32_t v) {
        float cx = 0, cz = 0, hx, hz, yaw;
        if (v < app.vehicles.count()) app.vehicles.groundBox(v, cx, cz, hx, hz, yaw);
        w.fuel().carDisassembled(w.context(), w.structures(), v, ground(w, cx, cz));
        app.vehicles.removeVehicle(v);
    };

    // ---- HUD: command-bar cards (Structures), selection action "Occupy tower"
    GameUI& ui = w.ui();
    struct Card { StructureKind k; const char* id; const char* label; UiIcon icon; int order; const char* tip; };
    const Card cards[4] = {
        {StructureKind::Tower, "struct.tower", "Defense tower", UiIcon::Tower, 40, "Timber watchtower (5 m deck, 2 posts). Engineers build it.\nSnipers / riflemen occupy it and fire over the parapet;\nzombies attack the base and heap up around it."},
        {StructureKind::Generator, "struct.generator", "Generator", UiIcon::Generator, 41, "Diesel generator: powers floodlights within cable range.\nBurns fuel from the base fuel store; its noise attracts zombies\n(several generators in one area add up)."},
        {StructureKind::Light, "struct.light", "Floodlight", UiIcon::Light, 42, "Floodlight mast: lights the area at night while a running\ngenerator within cable range powers it."},
        {StructureKind::FuelStore, "struct.fuel", "Fuel store", UiIcon::Fuel, 43, "Base fuel stock (drums + jerrycans). Engineers deliver fuel\nfrom cars here; generators draw from it."},
    };
    for (const Card& c : cards) {
        UiAction a;
        a.id = c.id; a.category = UiCategory::Structures; a.label = c.label; a.icon = c.icon; a.order = c.order;
        const StructureKind k = c.k;
        a.cost = [&w, k](const UiCtx&) { return w.structures().price(w.config(), k); };
        const std::string label = c.label, tip = c.tip;
        a.enabled = [](const UiCtx& u, std::string* why) {
            if (u.ctx.engineers && (u.ctx.engineers->instantBuild || u.ctx.engineers->anyEngineers(u.ctx))) return true;
            if (why) *why = "Needs engineers";
            return false;
        };
        a.tooltip = [tip](const UiCtx&) { return tip; };
        a.onSelect = [k, label](const UiCtx& u) {
            u.ui.beginTargeting(label, "LMB: place (engineers build it)  |  RMB / Esc: cancel", [k](const UiCtx& v, V3 p) {
                Command cmd; cmd.type = CommandType::BuildStructure; cmd.structure = (uint8_t)k; cmd.pos = p; cmd.facing = 0.f; v.out.push(cmd);
            });
        };
        ui.registerAction(std::move(a));
    }
    UiSelectionAction occ;
    occ.id = "sel.tower.occupy"; occ.label = "Occupy tower"; occ.icon = UiIcon::Tower; occ.order = 40;
    occ.visible = [](const UiCtx& u) { return hasShooters(u); };
    occ.enabled = [&w](const UiCtx&, std::string* why) {
        for (const Structure& s : w.structures().all()) if (s.kind == StructureKind::Tower && s.solid()) return true;
        if (why) *why = "no defense tower built";
        return false;
    };
    occ.onSelect = [](const UiCtx& u) {
        u.ui.beginTargeting("Occupy tower", "LMB: a defense tower (the squad climbs it)  |  RMB / Esc: cancel", [](const UiCtx& v, V3 p) {
            Command cmd; cmd.type = CommandType::OccupyTower; cmd.pos = p; cmd.squads = v.ui.selectionConst().squads; v.out.push(cmd);
        });
    };
    occ.tooltip = [](const UiCtx&) { return std::string("Snipers / riflemen climb a defense tower and hold its posts\n(a new move order brings them down)."); };
    ui.registerSelectionAction(occ);
    // hover over a tower with shooters selected: "Occupy"
    ui.registerHoverProvider("struct.tower", [&w](const UiCtx& u, V3 g, float sx, float sy, UiHoverMenu& m) {
        if (!hasShooters(u) || !u.ctx.cfg) return false;
        int t = w.structures().nearest(StructureKind::Tower, g.x, g.z, u.ctx.cfg->structures.towerHalf + 0.8f);
        if (t < 0) {   // the cursor on the tower body / deck: the ground pick lands behind it, so test the screen column too
            float best = 26.f * hudScale();
            const auto& all = w.structures().all();
            for (size_t k = 0; k < all.size(); ++k) {
                if (all[k].kind != StructureKind::Tower || !all[k].alive) continue;
                float bx, by, tx, ty;
                if (!GameUI::worldToScreen(u.app, all[k].pos, bx, by) ||
                    !GameUI::worldToScreen(u.app, all[k].pos + V3{0, u.ctx.cfg->structures.deckHeight + 1.2f, 0}, tx, ty)) continue;
                const float dx = tx - bx, dy = ty - by, l2 = std::max(1.f, dx * dx + dy * dy);
                const float s = std::clamp(((sx - bx) * dx + (sy - by) * dy) / l2, 0.f, 1.f);
                const float ex = bx + dx * s - sx, ey = by + dy * s - sy, d = std::sqrt(ex * ex + ey * ey);
                if (d < best) { best = d; t = (int)k; }
            }
        }
        if (t < 0) return false;
        const Structure& T = w.structures().all()[(size_t)t];
        if (!m.key) { m.title = "Defense tower"; m.anchor = {T.pos.x, T.pos.y + u.ctx.cfg->structures.deckHeight + 1.5f, T.pos.z}; m.key = 0x200000000ull | (uint64_t)t; }
        UiHoverEntry e;
        e.label = "Occupy tower"; e.icon = UiIcon::Tower;
        e.enabled = T.solid() && w.structures().occupants(t) < u.ctx.cfg->structures.towerCapacity;
        if (!e.enabled) e.why = T.solid() ? "full" : "not built yet";
        const V3 at = T.pos;
        e.onClick = [at](const UiCtx& v) { Command c; c.type = CommandType::OccupyTower; c.pos = at; c.squads = v.ui.selectionConst().squads; v.out.push(c); };
        if (m.primary < 0) m.primary = (int)m.entries.size();   // LMB / RMB on the tower itself = occupy
        m.entries.push_back(e);
        return true;
    });
}

// car hover menu (engineers selected): Disassemble (= the clearing job, fuel to the base) + Siphon fuel. Installed
// after GameUI's built-ins so it replaces the plain "car.clear" provider (same id).
void installStructureHover(GameWorld& w) {
    // v2 HUD: info card at a hovered structure (tower / generator / floodlight / fuel store), shown when no action menu
    // owns the object. Read-only: the title carries the key numbers, nothing is clickable.
    w.ui().registerHoverProvider("struct.info", [&w](const UiCtx& u, V3 g, float, float, UiHoverMenu& m) {
        if (m.key || !u.ctx.cfg || !u.ui.selectionConst().squads.empty()) return false;   // only with nothing selected
        const auto& all = w.structures().all();
        int best = -1; float bd = 3.0f * 3.0f;
        for (size_t k = 0; k < all.size(); ++k) {
            if (!all[k].alive) continue;
            const float dx = all[k].pos.x - g.x, dz = all[k].pos.z - g.z, d = dx * dx + dz * dz;
            if (d < bd) { bd = d; best = (int)k; }
        }
        if (best < 0) return false;
        const Structure& T = all[(size_t)best];
        const auto& sc = u.ctx.cfg->structures;
        char t[128];
        if (T.build < 1.f) std::snprintf(t, sizeof(t), "%s  building %d%%", structureName(T.kind), (int)(T.build * 100.f));
        else switch (T.kind) {
        case StructureKind::Tower:
            std::snprintf(t, sizeof(t), "Defense tower  %d/%d  %d%%", w.structures().occupants(best), sc.towerCapacity, (int)(T.health * 100.f)); break;
        case StructureKind::Generator: {
            const float burn = sc.generatorBurn + sc.burnPerLight * (float)T.powered;
            std::snprintf(t, sizeof(t), "Generator  %.0f l  %.0f min  %d lights%s", T.tank, burn > 0.f ? T.tank / burn / 60.f : 0.f, T.powered, T.running ? "" : "  off");
            break;
        }
        case StructureKind::Light:
            std::snprintf(t, sizeof(t), "%s", T.lit ? "Floodlight  powered" : "Floodlight  no power: no generator in range"); break;
        default:
            std::snprintf(t, sizeof(t), "Fuel store  %.0f l", T.fuel); break;
        }
        m.title = t;
        m.anchor = {T.pos.x, T.pos.y + (T.kind == StructureKind::Tower ? sc.deckHeight + 1.5f : 2.2f), T.pos.z};
        m.key = 0x300000000ull | (uint64_t)best;
        return true;
    });
    w.ui().registerHoverProvider("car.clear", [&w](const UiCtx& u, V3 g, float, float, UiHoverMenu& m) {
        if (!hasType(u, SquadType::Engineer) || !u.ctx.cfg) return false;
        const uint32_t v = u.app.vehicles.parkedAt(g.x, g.z, u.ctx.cfg->engineer.carSearch);
        if (v == UINT32_MAX) return false;
        float cx, cz, hx, hz, yaw;
        u.app.vehicles.groundBox(v, cx, cz, hx, hz, yaw);
        if (!m.key) { m.title = "Parked vehicle"; m.anchor = {cx, g.y + 1.6f, cz}; m.key = 0x100000000ull | v; }
        const float litres = w.fuel().litresLeft(u.ctx, v);
        const bool inRange = !u.ctx.engineers || u.ctx.engineers->inRange(u.ctx, cx, cz);
        const V3 at{cx, g.y, cz};
        UiHoverEntry s;
        char lb[64];
        std::snprintf(lb, sizeof(lb), "Siphon fuel (%.0f l to base)", litres);
        s.label = lb; s.icon = UiIcon::Siphon; s.cost = u.ctx.cfg->structures.siphonPrice > 0 ? u.ctx.cfg->structures.siphonPrice : -1;
        s.enabled = litres > 0.f && inRange && !w.fuel().siphonOrdered(v) && w.structures().storeFor(at) >= 0;
        s.why = litres <= 0.f ? "no fuel in it" : !inRange ? "outside engineer range" : w.fuel().siphonOrdered(v) ? "already being siphoned" : "no fuel store (build one)";
        s.onClick = [at](const UiCtx& x) { Command c; c.type = CommandType::SiphonCar; c.pos = at; x.out.push(c); };
        m.entries.push_back(s);
        UiHoverEntry d;
        d.label = litres > 0.f ? "Disassemble (+ fuel)" : "Disassemble"; d.icon = UiIcon::Disassemble; d.cost = u.ctx.cfg->engineer.carPrice;
        d.enabled = !(u.ctx.engineers && u.ctx.engineers->carOrdered(v)) && inRange;
        d.why = !inRange ? "outside engineer range" : "already being cleared";
        d.onClick = [at](const UiCtx& x) { Command c; c.type = CommandType::ClearCar; c.pos = at; x.out.push(c); };
        m.entries.push_back(d);
        return true;
    });
}

// ---------------------------------------------------------------------------------------------------------------------
bool structureCommand(GameWorld& w, AppState& app, const Command& c) {
    GameContext& ctx = w.context();
    Structures& st = w.structures();
    GameUI& ui = w.ui();
    const BalanceConfig& cfg = w.config();
    switch (c.type) {
    case CommandType::BuildStructure: {
        const StructureKind k = (StructureKind)std::min<uint8_t>(c.structure, 3);
        V3 p = c.pos;
        if (ctx.nav && ctx.nav->ready()) p.y = ctx.nav->surface(p.x, p.z);
        const char* why = nullptr;
        if (!st.canPlace(ctx, k, p, c.facing, &why)) { ui.notify(std::string(structureName(k)) + " refused: " + (why ? why : "?"), true, ctx.time); return false; }
        if (!w.economyMut().spend(st.price(cfg, k), structureName(k), ctx.time)) { ui.notify("Not enough funding", true, ctx.time); return false; }
        st.place(ctx, k, p, c.facing);
        ui.notify(std::string(structureName(k)) + ": engineers on the way", false, ctx.time);
        return true;
    }
    case CommandType::OccupyTower: {
        const int t = st.nearest(StructureKind::Tower, c.pos.x, c.pos.z, cfg.structures.towerHalf + 3.f);
        bool any = false;
        std::string msg = "no defense tower there";
        for (const SquadId& id : c.squads) if (t >= 0) any |= st.occupy(ctx, id, t, msg);
        ui.notify(any ? msg : "Tower: " + msg, !any, ctx.time);
        return any;
    }
    case CommandType::SiphonCar: {
        const uint32_t v = app.vehicles.parkedAt(c.pos.x, c.pos.z, cfg.engineer.carSearch);
        Obb b;
        if (v != UINT32_MAX) { app.vehicles.groundBox(v, b.cx, b.cz, b.hx, b.hz, b.yaw); b.top = 2.f; }
        const char* why = v == UINT32_MAX ? "no parked vehicle there" : nullptr;
        if (!why && !w.fuel().orderSiphon(ctx, st, v, b, &why)) {}
        else if (!why && cfg.structures.siphonPrice > 0 && !w.economyMut().spend(cfg.structures.siphonPrice, "siphon", ctx.time)) why = "not enough funding";
        if (why) { ui.notify(std::string("Siphoning refused: ") + why, true, ctx.time); return false; }
        ui.notify("Engineers: siphoning the fuel", false, ctx.time);
        return true;
    }
    default: return false;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
void drawStructures(MilitaryRenderer& mil, GameWorld& w, float) {
    resolveProps(mil);
    const StructureConfig& S = w.config().structures;
    for (const Structure& s : w.structures().all()) {
        if (!s.alive) continue;
        const float rise = s.build >= 1.f ? 1.f : 0.08f + 0.92f * s.build;   // blueprint: grows with progress, translucent
        const float dis = s.build >= 1.f ? 0.f : 0.45f;
        switch (s.kind) {
        case StructureKind::Tower: put(mil, g_props.tower, s.pos, s.yaw, rise, dis); break;
        case StructureKind::Generator: put(mil, g_props.generator, s.pos, s.yaw, rise, dis); break;
        case StructureKind::Light:
            if (g_props.lampPart >= 0) put(mil, g_props.light, s.pos, s.yaw, rise, dis, s.lit ? ~0ull : ~(1ull << g_props.lampPart));
            else {
                put(mil, g_props.light, s.pos, s.yaw, rise, dis);
                if (s.lit) put(mil, g_props.lightLamp, s.pos, s.yaw, 1.f, 0.f);
            }
            break;
        case StructureKind::FuelStore: {
            uint64_t mask = ~0ull;
            const float fill = s.fuel / std::max(1.f, S.fuelStoreCapacity);
            for (size_t k = 0; k < g_props.canParts.size(); ++k)   // one jerrycan per sixth of the stock
                if (fill < (float)(k + 1) / (float)g_props.canParts.size() - 1e-3f) mask &= ~(1ull << g_props.canParts[k]);
            put(mil, g_props.store, s.pos, s.yaw, rise, dis, mask);
            break;
        }
        default: break;
        }
    }
    // engineers carrying jerrycans: the can at the right hand (walking)
    const GameContext& ctx = w.context();
    if (ctx.soldiers && g_props.can >= 0) {
        const SoldierPool& P = *ctx.soldiers;
        for (uint32_t i = 0; i < P.capacity(); ++i) {
            if (!P.used[i] || !P.alive(i) || w.fuel().carrying(i) <= 0.f) continue;
            const float y = P.yaw[i], c = std::cos(y), sn = std::sin(y);
            const V3 at{P.pos[i].x - c * 0.32f, P.pos[i].y + 0.12f, P.pos[i].z + sn * 0.32f};   // model right = -X local
            put(mil, g_props.can, at, y, 1.f, 0.f);
        }
    }
}

void GameWorld::structureLights(const AppState& app, std::vector<PointLight>& out) const {
    const StructureConfig& S = cfg_.structures;
    struct L { float d; PointLight p; };
    std::vector<L> lit;
    const V3 cam = app.camera.target();
    for (const Structure& s : structures_.all()) {
        if (s.kind != StructureKind::Light || !s.lit) continue;
        Obb b = Structures::footprint(s.kind, s.pos, s.yaw, S);
        float x, z;
        b.at(0.f, S.lightReach * 0.5f, x, z);   // the beam: a point light out in front of the heads, below them
        PointLight p{x, s.pos.y + S.lightHeight * 0.75f, z, S.lightRadius, 1.0f, 0.93f, 0.78f, S.lightIntensity};
        lit.push_back({std::hypot(x - cam.x, z - cam.z), p});
    }
    std::sort(lit.begin(), lit.end(), [](const L& a, const L& b) { return a.d < b.d; });
    for (size_t k = 0; k < lit.size() && k < 8; ++k) out.push_back(lit[k].p);
}

// ---------------------------------------------------------------------------------------------------------------------
// script verbs / metrics (GameScript.h "14e")
bool structureVerb(GameWorld& w, const ScriptLine& L, std::string& err) {
    const std::vector<std::string>& a = L.args;
    GameContext& ctx = w.context();
    Structures& st = w.structures();
    if (L.verb == "structure") {   // structure tower|generator|light|fuel X Z [YAW_DEG]
        StructureKind k;
        if (a.size() < 3 || !structureKindFrom(a[0], k)) { err = "structure tower|generator|light|fuel X Z [YAW]"; return true; }
        Command c; c.type = CommandType::BuildStructure; c.structure = (uint8_t)k; c.pos = ground(w, fa(a, 1), fa(a, 2)); c.facing = fa(a, 3) * 3.14159265f / 180.f;
        w.commands().push(c);
        return true;
    }
    if (L.verb == "occupy") {   // occupy N X Z
        const Squad* s = squadNo(ctx, (int)fa(a, 0));
        if (!s || a.size() < 3) { err = "occupy SQUAD X Z"; return true; }
        Command c; c.type = CommandType::OccupyTower; c.squads = {s->id}; c.pos = ground(w, fa(a, 1), fa(a, 2));
        w.commands().push(c);
        return true;
    }
    if (L.verb == "siphon") {   // siphon X Z
        if (a.size() < 2) { err = "siphon X Z"; return true; }
        Command c; c.type = CommandType::SiphonCar; c.pos = ground(w, fa(a, 0), fa(a, 1));
        w.commands().push(c);
        return true;
    }
    if (L.verb == "lights") {   // lights on|auto (forced on by day / time of day)
        st.forceLights = !a.empty() && a[0] == "on";
        return true;
    }
    if (L.verb == "towerattackers") {   // TEST HOOK: towerattackers X Z N (-1: horde counts again)
        st.forceAttackers(st.nearest(StructureKind::Tower, fa(a, 0), fa(a, 1), 5.f), (int)fa(a, 2, -1.f));
        return true;
    }
    if (L.verb == "damagestructure") {   // TEST HOOK: damagestructure X Z HP
        int best = -1; float bd = 5.f;
        for (size_t i = 0; i < st.all().size(); ++i) { const float d = std::hypot(st.all()[i].pos.x - fa(a, 0), st.all()[i].pos.z - fa(a, 1)); if (st.all()[i].alive && d < bd) { bd = d; best = (int)i; } }
        if (best < 0) { err = "no structure within 5 m"; return true; }
        st.damage(best, fa(a, 2, 1e9f));
        return true;
    }
    if (L.verb == "setfuel") {   // TEST HOOK: setfuel X Z L (nearest generator tank / fuel store stock)
        int best = -1; float bd = 5.f;
        for (size_t i = 0; i < st.all().size(); ++i) {
            const Structure& s = st.all()[i];
            const float d = std::hypot(s.pos.x - fa(a, 0), s.pos.z - fa(a, 1));
            if (s.alive && (s.kind == StructureKind::Generator || s.kind == StructureKind::FuelStore) && d < bd) { bd = d; best = (int)i; }
        }
        if (best < 0) { err = "no generator / fuel store within 5 m"; return true; }
        st.setFuel(best, fa(a, 2));
        return true;
    }
    if (L.verb == "markcar") {   // markcar X Z: remember the parked vehicle there (metric car K ...)
        AppState* app = w.app();
        const uint32_t v = app ? app->vehicles.parkedAt(fa(a, 0), fa(a, 1), 3.f) : UINT32_MAX;
        if (v == UINT32_MAX) { err = "no parked vehicle there"; return true; }
        g_marked.push_back(v);
        std::printf("  markcar %zu = vehicle %u\n", g_marked.size(), v);
        return true;
    }
    if (L.verb == "blast") {   // blast X Z SCALE: an explosion (CrowdSim path: zombies, vehicles)
        if (!ctx.horde || a.size() < 2) { err = "blast X Z [SCALE]"; return true; }
        V3 p = ground(w, fa(a, 0), fa(a, 1));
        p.y += 0.5f;
        ctx.horde->requestExplosion(p, fa(a, 2, 1.f));
        return true;
    }
    if (L.verb == "structures") {   // print every structure
        for (size_t i = 0; i < st.all().size(); ++i) {
            const Structure& s = st.all()[i];
            std::printf("  structure %zu %s (%.1f %.1f) build %.2f hp %.0f alive %d occ %d att %d tank %.1f run %d powered %d lit %d fuel %.1f\n", i, structureName(s.kind),
                        s.pos.x, s.pos.z, s.build, s.health, (int)s.alive, st.occupants((int)i), s.attackers, s.tank, (int)s.running, s.powered, (int)s.lit, s.fuel);
        }
        for (const Structures::Area& ar : st.noiseAreas()) std::printf("  noise area (%.1f %.1f) generators %d strength %.2f radius %.1f\n", ar.pos.x, ar.pos.z, ar.generators, ar.strength, ar.radius);
        return true;
    }
    return false;
}

bool structureMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) {
    const Structures& st = w.structures();
    const FuelLogistics& fl = w.fuel();
    const GameContext& ctx = w.context();
    auto kindArg = [&](StructureKind& kind) {
        if (k >= a.size() || !structureKindFrom(a[k], kind)) { err = m + " tower|generator|light|fuel"; return false; }
        ++k;
        return true;
    };
    if (m == "structures_built" || m == "structures_placed" || m == "structures_alive") {
        StructureKind kind;
        if (!kindArg(kind)) return true;
        if (m == "structures_built") out = st.stats().built[(size_t)kind];
        else if (m == "structures_placed") out = st.stats().placed[(size_t)kind];
        else { out = 0; for (const Structure& s : st.all()) out += s.kind == kind && s.solid() ? 1 : 0; }
        return true;
    }
    if (m == "tower" || m == "generator" || m == "light" || m == "store") {   // KIND X Z FIELD
        if (k + 2 >= a.size()) { err = m + " X Z FIELD"; return true; }
        const float x = (float)std::atof(a[k].c_str()), z = (float)std::atof(a[k + 1].c_str());
        const std::string f = a[k + 2];
        k += 3;
        const StructureKind kind = m == "tower" ? StructureKind::Tower : m == "generator" ? StructureKind::Generator : m == "light" ? StructureKind::Light : StructureKind::FuelStore;
        int best = -1; float bd = 6.f;
        for (size_t i = 0; i < st.all().size(); ++i) { const Structure& s = st.all()[i]; const float d = std::hypot(s.pos.x - x, s.pos.z - z); if (s.kind == kind && d < bd) { bd = d; best = (int)i; } }
        if (best < 0) { out = -1; return true; }
        const Structure& s = st.all()[(size_t)best];
        if (f == "hp") out = s.health;
        else if (f == "alive") out = s.alive ? 1 : 0;
        else if (f == "built") out = s.solid() ? 1 : 0;
        else if (f == "build") out = s.build;
        else if (f == "occupants") out = st.occupants(best);
        else if (f == "attackers") out = s.attackers;
        else if (f == "tank") out = s.tank;
        else if (f == "running") out = s.running ? 1 : 0;
        else if (f == "powered") out = s.powered;
        else if (f == "lit") out = s.lit ? 1 : 0;
        else if (f == "fuel") out = s.fuel;
        else if (f == "obstacle") out = s.obstacle != ~0u ? 1 : 0;   // stamped in the zombies' obstacle grid (CityVehicles)
        else err = "field hp|alive|built|build|occupants|attackers|tank|running|powered|lit|fuel|obstacle";
        return true;
    }
    if (m == "lights_lit") { out = 0; for (const Structure& s : st.all()) out += s.kind == StructureKind::Light && s.lit ? 1 : 0; return true; }
    if (m == "fuel_stock") { out = st.fuelStock(); return true; }
    if (m == "fuel_burned") { out = st.stats().fuelBurned; return true; }
    if (m == "fuel_delivered") { out = fl.stats().delivered; return true; }
    if (m == "fuel_trips") { out = fl.stats().trips; return true; }
    if (m == "fuel_lost") { out = fl.stats().lost; return true; }
    if (m == "fuel_in_transit") { out = fl.inTransit(); return true; }
    if (m == "fuel_carriers") { out = 0; if (ctx.soldiers) for (uint32_t i = 0; i < ctx.soldiers->capacity(); ++i) out += fl.carrying(i) > 0.f ? 1 : 0; return true; }
    if (m == "cars_siphoned") { out = fl.stats().siphoned; return true; }
    if (m == "cars_disassembled") { out = fl.stats().disassembled; return true; }
    if (m == "towers_destroyed") { out = st.stats().towersDestroyed; return true; }
    if (m == "tower_falls") { out = st.stats().fell; return true; }   // occupants who fell with a collapsing tower
    if (m == "tower_climbs") { out = st.stats().climbed; return true; }
    if (m == "noise_areas") { out = (double)st.noiseAreas().size(); return true; }
    if (m == "noise_strength" || m == "noise_radius" || m == "noise_generators") {   // ... X Z: the area nearest the point (0: none within 40 m)
        if (k + 1 >= a.size()) { err = m + " X Z"; return true; }
        const float x = (float)std::atof(a[k].c_str()), z = (float)std::atof(a[k + 1].c_str());
        k += 2;
        out = 0;
        float bd = 40.f;
        for (const Structures::Area& ar : st.noiseAreas()) {
            const float d = std::hypot(ar.pos.x - x, ar.pos.z - z);
            if (d < bd) { bd = d; out = m == "noise_strength" ? ar.strength : m == "noise_radius" ? ar.radius : ar.generators; }
        }
        return true;
    }
    if (m == "tower_rounds" || m == "on_tower" || m == "tower_min_y") {   // soldiers posted on tower decks
        out = m == "tower_min_y" ? 1e9 : 0;
        if (ctx.soldiers)
            for (uint32_t i = 0; i < ctx.soldiers->capacity(); ++i) {
                if (!ctx.soldiers->used[i] || !st.onTower(i)) continue;
                if (m == "tower_rounds") out += ctx.soldiers->rounds[i];
                else if (m == "on_tower") out += 1;
                else out = std::min(out, (double)ctx.soldiers->pos[i].y);
            }
        if (m == "tower_min_y" && out > 1e8) out = -1;
        return true;
    }
    if (m == "car") {   // car K state|drained|health|exists (K: markcar order, 1-based); state 0 intact 1 damaged 2 burning 3 wrecked
        AppState* app = w.app();
        if (k + 1 >= a.size() || !app) { err = "car K state|drained|health|removed"; return true; }
        const int n = std::atoi(a[k].c_str());
        const std::string f = a[k + 1];
        k += 2;
        if (n < 1 || n > (int)g_marked.size()) { err = "car K: markcar first"; return true; }
        const Vehicle& v = app->vehicles.vehicle(g_marked[(size_t)n - 1]);
        if (f == "state") out = (double)(int)v.state;
        else if (f == "drained") out = v.drained ? 1 : 0;
        else if (f == "health") out = v.health;
        else if (f == "removed") out = v.removed ? 1 : 0;
        else if (f == "fuel") out = fl.litresLeft(ctx, g_marked[(size_t)n - 1]);
        else err = "field state|drained|health|removed|fuel";
        return true;
    }
    if (m == "game_obstacles") { AppState* app = w.app(); out = app ? app->vehicles.obstacleCount() : 0; return true; }   // all gameplay obstacles (walls, posts, containers, structures)
    if (m == "vehicle_explosions") { AppState* app = w.app(); out = app ? app->vehicles.stats().explosions : 0; return true; }
    return false;
}

} // namespace ttz::game
