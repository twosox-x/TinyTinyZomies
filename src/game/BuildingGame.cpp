// App side of the B3a buildings: window loading, UI hooks, props, script verbs / metrics. See BuildingGame.h.
#include "game/BuildingGame.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/GameScript.h"
#include "game/GameUI.h"
#include "game/GameWorld.h"
#include "lab/MilitaryRenderer.h"

#include <SDL3/SDL.h>
#include <imgui.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace ttz::game {

namespace {
float fa(const std::vector<std::string>& a, size_t k, float def = 0.f) { return k < a.size() ? (float)std::atof(a[k].c_str()) : def; }
const Squad* squadNo(const GameContext& ctx, int n) {
    if (!ctx.squads || n < 1 || n > (int)ctx.squads->squads.size()) return nullptr;
    return &ctx.squads->squads[(size_t)n - 1];
}
BarricadeType barricadeOf(const std::string& s) {
    return s == "planks" ? BarricadeType::Planks : s == "plate" ? BarricadeType::Plate : s == "sandbags" ? BarricadeType::Sandbags : BarricadeType::None;
}
void printBuilding(const BuildingRegistry& reg, BuildingId id) {
    const Building* B = reg.get(id);
    if (!B) { std::printf("  building: none\n"); return; }
    const V3 c = B->centre();
    std::printf("  building %u (bake %08x): %s, %d floors (%.1f m), %.1f x %.1f m at (%.1f %.1f), roof %.1f%s, top %.1f; %s%s%s; %s %.0f%%, role %s, cap %d\n",
                id.v, B->bakeId, kindName(B->kind), (int)B->floors, B->floorHeight, B->w, B->d, c.x, c.z, B->roofY, B->flatRoof ? " (flat)" : " (pitched)",
                B->topY, B->supported ? "supported" : "UNSUPPORTED", B->supported ? "" : ": ", B->unsupportedWhy, captureName(B->capture),
                B->captureProgress * 100.f, roleName(B->role), B->capacity);
    for (size_t k = 0; k < B->openings.size(); ++k) {
        const Opening& o = B->openings[k];
        std::printf("    opening %zu: %s floor %d at (%.1f %.1f %.1f) n (%.2f %.2f) barricade %s %.0f/%.0f\n", k,
                    o.type == OpeningType::Door ? "door" : o.type == OpeningType::Window ? "window" : "roof hatch", o.floor == kRoofFloor ? -1 : (int)o.floor,
                    o.pos.x, o.pos.y, o.pos.z, o.nx, o.nz, barricadeName(o.barricade), o.barricadeHealth, o.barricadeMax);
    }
    for (size_t k = 0; k < B->firing.size(); ++k) {
        const FiringPosition& f = B->firing[k];
        std::printf("    firing %zu: %s floor %d at (%.1f %.1f %.1f) yaw %.0f%s%s\n", k, f.kind == FiringKind::Window ? "window" : "roof edge",
                    f.floor == kRoofFloor ? -1 : (int)f.floor, f.pos.x, f.pos.y, f.pos.z, f.yaw * 57.2958f, f.occupant.valid() ? " occupied" : "", f.nest ? " nest" : "");
    }
}
bool project(const AppState& app, V3 p, ImVec2& out) {
    float x, y;
    if (!GameUI::worldToScreen(app, p, x, y)) return false;
    out = ImVec2(x, y);
    return true;
}
} // namespace

// ---------------------------------------------------------------------------------------------------------------------
void syncBuildings(AppState& app, BuildingPlay& bp, const std::vector<float>& h, const BalanceConfig& cfg) {
    const Sandbox& sb = app.sandbox;
    if (!app.city.loaded() || h.size() != (size_t)sb.gridW * (size_t)sb.gridH) return;
    const float x0 = sb.originX, z0 = sb.originZ, x1 = x0 + sb.gridW * sb.cellSize, z1 = z0 + sb.gridH * sb.cellSize;
    const CityAsset& C = app.city;
    const int i0 = std::max(0, (int)std::floor((x0 - 64.f - C.x0) / C.tileSize)), i1 = std::min(C.ni - 1, (int)std::floor((x1 + 64.f - C.x0) / C.tileSize));
    const int j0 = std::max(0, (int)std::floor((z0 - 64.f - C.z0) / C.tileSize)), j1 = std::min(C.nj - 1, (int)std::floor((z1 + 64.f - C.z0) / C.tileSize));
    BuildingRegistry& reg = bp.registry();
    const size_t before = reg.size();
    for (int j = j0; j <= j1; ++j)
        for (int i = i0; i <= i1; ++i)
            if (!reg.hasTile(i, j)) {   // decoded once per tile (the sim window's cache belongs to its worker thread)
                TileCPU t;
                app.city.decodeTileNow(i, j, t);
                t.i = i; t.j = j;
                reg.addTile(t);
            }
    auto heightAt = [&](float x, float z) -> float {
        const int ci = (int)std::floor((x - x0) / sb.cellSize), cj = (int)std::floor((z - z0) / sb.cellSize);
        if (ci < 0 || cj < 0 || ci >= sb.gridW || cj >= sb.gridH) return std::nanf("");
        return h[(size_t)cj * sb.gridW + ci];
    };
    reg.prepare(heightAt, cfg.buildings);
    if (reg.size() != before)
        SDL_Log("game: buildings: %zu loaded (%d supported) from the tiles under the window", reg.size(), reg.supportedCount());
}

// ---------------------------------------------------------------------------------------------------------------------
namespace {
void footprintOutline(const AppState& app, const Building& B, float y, ImU32 col, float thick) {
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    ImVec2 p[5];
    for (int c = 0; c < 5; ++c) {
        const int k = c % 4;
        const float u = (k == 1 || k == 2) ? B.w : 0.f, v = (k >= 2) ? B.d : 0.f;
        if (!project(app, B.toWorld(u, v, y), p[c])) return;
    }
    dl->AddPolyline(p, 5, col, 0, thick);
}

void drawPanel(AppState& app, const GameContext& ctx, BuildingPlay& bp, GameUI& ui) {
    BuildingRegistry& reg = bp.registry();
    // capture progress / role tags over buildings near squads (subtle)
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    for (uint32_t b = 0; b < (uint32_t)reg.size(); ++b) {
        const Building& B = *reg.get(BuildingId{b});
        const bool show = B.capture == CaptureState::Capturing || B.capture == CaptureState::Contested || B.role != BuildingRole::None || bp.selected.v == b;
        if (!show) continue;
        ImVec2 s;
        if (!project(app, B.toWorld(B.w * 0.5f, B.d * 0.5f, B.roofY + 2.5f), s)) continue;
        if (B.capture == CaptureState::Capturing || B.capture == CaptureState::Contested) {
            const ImU32 c = B.capture == CaptureState::Contested ? IM_COL32(220, 90, 60, 230) : IM_COL32(200, 210, 120, 230);
            dl->AddRectFilled(ImVec2(s.x - 22, s.y - 3), ImVec2(s.x + 22, s.y + 3), IM_COL32(20, 20, 14, 180));
            dl->AddRectFilled(ImVec2(s.x - 22, s.y - 3), ImVec2(s.x - 22 + 44 * B.captureProgress, s.y + 3), c);
            dl->AddText(ImVec2(s.x - 26, s.y - 18), c, B.capture == CaptureState::Contested ? "contested" : "capturing");
        } else if (B.role != BuildingRole::None) {
            char t[64];
            std::snprintf(t, sizeof(t), "%s %d/%d%s", B.role == BuildingRole::Garrison ? "GARRISON" : "HOSPITAL",
                          B.role == BuildingRole::Garrison ? (int)B.garrison.size() : (int)B.patients.size(), B.capacity, B.zombiesInside > 0 ? " !" : "");
            const ImU32 c = B.role == BuildingRole::Garrison ? IM_COL32(170, 180, 110, 220) : IM_COL32(150, 220, 150, 220);
            dl->AddText(ImVec2(s.x - 30, s.y - 8), c, t);
        }
    }
    if (!bp.selected.valid()) return;
    const Building* Bp = reg.get(bp.selected);
    if (!Bp) { bp.selected = {}; return; }
    const Building& B = *Bp;
    footprintOutline(app, B, B.roofY + 0.1f, B.supported ? IM_COL32(232, 224, 190, 200) : IM_COL32(220, 90, 60, 200), 2.f);
    footprintOutline(app, B, B.y0 + 0.1f, IM_COL32(232, 224, 190, 90), 1.f);
    for (const Opening& o : B.openings) {
        ImVec2 s;
        if (o.type != OpeningType::Door || !project(app, o.pos + V3{0, 1.2f, 0}, s)) continue;
        dl->AddCircle(s, 6.f, o.open() ? IM_COL32(232, 224, 190, 200) : IM_COL32(200, 150, 80, 230), 12, 2.f);
    }
    for (const FiringPosition& f : B.firing) {
        ImVec2 s;
        if (!project(app, f.pos + V3{0, 1.0f, 0}, s)) continue;
        dl->AddRect(ImVec2(s.x - 3, s.y - 3), ImVec2(s.x + 3, s.y + 3), f.occupant.valid() ? IM_COL32(120, 200, 90, 230) : IM_COL32(232, 224, 190, 140));
    }
    const ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(12.f, io.DisplaySize.y - 262.f), ImGuiCond_Always);
    ImGui::SetNextWindowSize(ImVec2(470.f, 0.f), ImGuiCond_Always);
    ImGui::Begin("##building", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings);
    ImGui::Text("%s, %d floor%s%s", kindName(B.kind), (int)B.floors, B.floors > 1 ? "s" : "", B.flatRoof ? ", flat roof" : "");
    if (!B.supported) { ImGui::TextColored(ImVec4(0.9f, 0.4f, 0.3f, 1), "Unsupported: %s", B.unsupportedWhy); ImGui::End(); return; }
    ImGui::Text("%s%s", captureName(B.capture), B.capture == CaptureState::Captured ? "" : " (PROPOSED: a squad at the entrance, no zombies)");
    if (B.zombiesInside > 0) ImGui::TextColored(ImVec4(0.9f, 0.4f, 0.3f, 1), "Zombies inside: %d", B.zombiesInside);
    const BuildingConfig& bc = ctx.cfg->buildings;
    if (B.capture == CaptureState::Captured) {
        ImGui::Text("Role: %s   (costs UNAPPROVED)", roleName(B.role));
        char t[64];
        std::snprintf(t, sizeof(t), "Garrison  $%d", bc.garrisonPrice);
        if (B.role != BuildingRole::Garrison && ImGui::Button(t)) bp.request({BuildingPlay::Act::Role, bp.selected, {}, (int)BuildingRole::Garrison});
        ImGui::SameLine();
        std::snprintf(t, sizeof(t), "Hospital  $%d", bc.hospitalPrice);
        if (B.role != BuildingRole::Hospital && ImGui::Button(t)) bp.request({BuildingPlay::Act::Role, bp.selected, {}, (int)BuildingRole::Hospital});
        if (B.role == BuildingRole::Garrison) {
            ImGui::Text("Positions %d / %d, ammo stack %d", (int)B.garrison.size(), (int)B.firing.size(), bp.ammoStock(bp.selected));
            const Selection& sel = ui.selectionConst();
            ImGui::BeginDisabled(sel.squads.empty());
            if (ImGui::Button("Garrison selected squads (G)"))
                for (const SquadId& s : sel.squads) bp.request({BuildingPlay::Act::Garrison, bp.selected, s, 0});
            ImGui::EndDisabled();
            ImGui::SameLine();
            if (ImGui::Button("Leave")) bp.request({BuildingPlay::Act::Release, bp.selected, {}, 0});
        } else if (B.role == BuildingRole::Hospital)
            ImGui::Text("Beds %d / %d (heal %.0f hp/s, PROPOSED)", (int)B.patients.size(), B.capacity, bc.healRate);
        ImGui::Separator();
        ImGui::TextUnformatted("Fortify (UNAPPROVED prices)");
        static const char* names[3] = {"planks", "plate", "sandbags"};
        for (int k = 0; k < 3; ++k) {
            std::snprintf(t, sizeof(t), "Doors: %s $%d##d%d", names[k], bc.barricadePrice[(size_t)k], k);
            if (ImGui::Button(t)) bp.request({BuildingPlay::Act::BarricadeDoors, bp.selected, {}, k + 1});
            if (k < 2) ImGui::SameLine();
        }
        for (int k = 0; k < 3; ++k) {
            std::snprintf(t, sizeof(t), "Windows: %s $%d##w%d", names[k], bc.barricadePrice[(size_t)k], k);
            if (ImGui::Button(t)) bp.request({BuildingPlay::Act::BarricadeWindows, bp.selected, {}, k + 1});
            if (k < 2) ImGui::SameLine();
        }
        std::snprintf(t, sizeof(t), "Window nests / roof rings  $%d each", bc.nestPrice);
        if (ImGui::Button(t)) bp.request({BuildingPlay::Act::Nest, bp.selected, {}, 0});
    } else {
        ImGui::ProgressBar(B.captureProgress, ImVec2(-1, 6), "");
        ImGui::TextDisabled("Send a squad to an entrance to capture it");
    }
    ImGui::End();
}
} // namespace

void installBuildingUI(GameUI& ui, BuildingPlay& bp) {
    GameUI* u = &ui;
    BuildingPlay* b = &bp;
    ui.buildingClick = [b](AppState& app, const GameContext& ctx, float x, float y) {
        V3 p;
        if (!GameUI::pickGround(app, ctx, x, y, p)) { b->selected = {}; return false; }
        const BuildingId id = b->registry().at(p.x, p.z, 0.8f);
        b->selected = id;
        return id.valid();
    };
    ui.buildingKey = [b, u](AppState&, const GameContext&, const SDL_Event& e) {
        if (!b->selected.valid()) return false;
        if (e.key.key == SDLK_ESCAPE && u->tool() == Tool::Select) { b->selected = {}; return true; }
        if (e.key.key == SDLK_G) {
            for (const SquadId& s : u->selectionConst().squads) b->request({BuildingPlay::Act::Garrison, b->selected, s, 0});
            return true;
        }
        return false;
    };
    ui.buildingDraw = [b, u](AppState& app, const GameContext& ctx) { drawPanel(app, ctx, *b, *u); };
}

// ---------------------------------------------------------------------------------------------------------------------
void drawBuildingProps(MilitaryRenderer& mil, const GameContext& ctx, const BuildingPlay& bp) {
    struct Ids {
        bool init = false;
        int flag[2], banner[2], barricade[2][3], nest, ring, roofPos, ammo, antenna, awning, stretcher, crate, cot;
    };
    static Ids P;
    if (!P.init) {
        P.init = true;
        P.flag[0] = mil.findProp("garrison_flag"); P.flag[1] = mil.findProp("hospital_flag");
        P.banner[0] = mil.findProp("garrison_banner"); P.banner[1] = mil.findProp("hospital_banner");
        const char* kinds[3] = {"planks", "plate", "sandbags"};
        for (int k = 0; k < 3; ++k) {
            char n[64];
            std::snprintf(n, sizeof(n), "barricade_door_%s", kinds[k]); P.barricade[0][k] = mil.findProp(n);
            std::snprintf(n, sizeof(n), "barricade_window_%s", kinds[k]); P.barricade[1][k] = mil.findProp(n);
        }
        P.nest = mil.findProp("fort_window_nest"); P.ring = mil.findProp("fort_roof_ring"); P.roofPos = mil.findProp("garrison_roof_position");
        P.ammo = mil.findProp("garrison_ammo_stack"); P.antenna = mil.findProp("garrison_antenna");
        P.awning = mil.findProp("hospital_awning"); P.stretcher = mil.findProp("hospital_stretcher"); P.crate = mil.findProp("hospital_crate");
        P.cot = mil.findProp("hospital_cot");
    }
    (void)ctx;
    const BuildingRegistry& reg = bp.registry();
    for (uint32_t b = 0; b < (uint32_t)reg.size(); ++b) {
        const Building& B = *reg.get(BuildingId{b});
        if (!B.prepared) continue;
        // barricades (any captured building): doors at the threshold, windows on the sill line, facing out
        for (const Opening& o : B.openings) {
            if (o.open() || o.type == OpeningType::RoofHatch) continue;
            const int t = (int)o.barricade - 1;
            const float yaw = std::atan2(o.nx, o.nz);
            if (o.type == OpeningType::Door) mil.addProp(P.barricade[0][t], {o.pos.x + o.nx * 0.05f, o.pos.y, o.pos.z + o.nz * 0.05f}, yaw);
            else mil.addProp(P.barricade[1][t], {o.pos.x + o.nx * 0.05f, o.pos.y - 0.95f, o.pos.z + o.nz * 0.05f}, yaw);
        }
        // nests / roof rings at firing positions; occupied roof edges get the approved sandbag roof position
        for (const FiringPosition& f : B.firing) {
            const float c = std::sin(f.yaw), s = std::cos(f.yaw);
            if (f.kind == FiringKind::Window) {
                if (f.nest) mil.addProp(P.nest, {f.pos.x + c * 0.35f, f.pos.y + 0.9f, f.pos.z + s * 0.35f}, f.yaw);
            } else if (f.nest) mil.addProp(P.ring, {f.pos.x + c * 0.3f, f.pos.y, f.pos.z + s * 0.3f}, f.yaw);
            else if (f.occupant.valid()) mil.addProp(P.roofPos, {f.pos.x + c * 0.7f, f.pos.y, f.pos.z + s * 0.7f}, f.yaw);
        }
        if (B.role == BuildingRole::None) continue;
        const int r = B.role == BuildingRole::Garrison ? 0 : 1;
        const float yawFront = std::atan2(-B.e2x, -B.e2z);
        // flag: on the roof's front corner (flat roofs) or beside the front door (houses)
        if (B.flatRoof) mil.addProp(P.flag[r], B.toWorld(1.0f, 1.0f, B.roofY), yawFront);
        else mil.addProp(P.flag[r], B.toWorld(-0.8f, -1.2f, B.y0), yawFront);
        // banner on the front facade, hanging from under the roof line (or from the first floor of a house)
        const float by = B.flatRoof ? std::min(B.roofY - 0.4f, B.y0 + 2.f * B.floorHeight + 2.4f) : B.y0 + B.floorHeight * B.floors - 0.2f;
        mil.addProp(P.banner[r], B.toWorld(B.w * 0.5f + (B.w > 8.f ? 2.5f : 0.f), -0.06f, by), yawFront);
        int door = -1;
        for (size_t k = 0; k < B.openings.size(); ++k) if (B.openings[k].type == OpeningType::Door) { door = (int)k; break; }
        if (r == 0) {
            if (B.flatRoof) {
                const V3 hatch = B.toWorld(B.stairU, B.stairV, B.roofY);
                mil.addProp(P.ammo, hatch + V3{B.e1x * 1.2f, 0, B.e1z * 1.2f}, yawFront);
                mil.addProp(P.antenna, B.toWorld(B.w - 1.2f, B.d - 1.2f, B.roofY), yawFront);
            } else if (door >= 0) {
                const Opening& o = B.openings[(size_t)door];
                mil.addProp(P.ammo, {o.pos.x + o.nx * 0.8f + B.e1x * 1.6f, o.pos.y, o.pos.z + o.nz * 0.8f + B.e1z * 1.6f}, yawFront);
            }
        } else if (door >= 0) {
            const Opening& o = B.openings[(size_t)door];
            const float yaw = std::atan2(o.nx, o.nz);
            mil.addProp(P.awning, {o.pos.x + o.nx * 2.0f, o.pos.y, o.pos.z + o.nz * 2.0f}, yaw);
            mil.addProp(P.stretcher, {o.pos.x + o.nx * 1.6f + B.e1x * 2.6f, o.pos.y, o.pos.z + o.nz * 1.6f + B.e1z * 2.6f}, yaw + 1.5708f);
            mil.addProp(P.crate, {o.pos.x + o.nx * 1.0f - B.e1x * 2.4f, o.pos.y, o.pos.z + o.nz * 1.0f - B.e1z * 2.4f}, yaw);
            mil.addProp(P.cot, {o.pos.x + o.nx * 3.2f - B.e1x * 1.8f, o.pos.y, o.pos.z + o.nz * 3.2f - B.e1z * 1.8f}, yaw + 1.5708f);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
bool buildingVerb(GameWorld& w, const ScriptLine& L, std::string& err) {
    const std::vector<std::string>& a = L.args;
    BuildingPlay& bp = w.buildings();
    BuildingRegistry& reg = bp.registry();
    GameContext& ctx = w.context();
    const std::string& v = L.verb;
    if (v == "bselect") {
        if (a.size() < 2) { err = "bselect X Z"; return true; }
        bp.selected = reg.at(fa(a, 0), fa(a, 1), 1.0f);
        printBuilding(reg, bp.selected);
        return true;
    }
    if (v == "binfo") { printBuilding(reg, bp.selected); return true; }
    if (v == "blist") {
        const float R = fa(a, 0, 150.f);
        float cx = 0, cz = 0;
        if (AppState* app = w.app()) { cx = app->camera.target().x; cz = app->camera.target().z; }
        std::vector<BuildingId> ids;
        reg.inRect(cx - R, cz - R, cx + R, cz + R, ids);
        int sup = 0, uns = 0;
        for (BuildingId id : ids) {
            const Building& B = *reg.get(id);
            if (!B.prepared) continue;
            const V3 c = B.centre();
            std::printf("  %4u %-11s %2d fl %5.1f x %5.1f at (%7.1f %7.1f) %s%s pos %zu\n", id.v, kindName(B.kind), (int)B.floors, B.w, B.d, c.x, c.z,
                        B.supported ? "supported" : "UNSUPPORTED: ", B.supported ? "" : B.unsupportedWhy, B.firing.size());
            (B.supported ? sup : uns)++;
        }
        std::printf("  buildings near (%.0f %.0f) R %.0f: %d supported, %d unsupported\n", cx, cz, R, sup, uns);
        return true;
    }
    if (v == "bdoor") {
        const Squad* s = squadNo(ctx, (int)fa(a, 0));
        const Building* B = reg.get(bp.selected);
        if (!s || !B) { err = "bdoor N (select a building first)"; return true; }
        const int d = reg.nearestEntrance(bp.selected, B->centre().x, B->centre().z);
        Command c;
        c.type = CommandType::Move;
        c.squads = {s->id};
        c.pos = BuildingPlay::doorExit(*B, d);
        const Opening& o = B->openings[(size_t)std::max(0, d)];
        c.pos.x += o.nx * 2.f; c.pos.z += o.nz * 2.f;   // formation slots in front of the door
        c.facing = std::atan2(-o.nx, -o.nz);
        w.commands().push(c);
        return true;
    }
    if (v == "brole") {
        if (a.empty()) { err = "brole garrison|hospital"; return true; }
        bp.request({BuildingPlay::Act::Role, bp.selected, {}, a[0] == "hospital" ? (int)BuildingRole::Hospital : (int)BuildingRole::Garrison});
        return true;
    }
    if (v == "bgarrison") {
        const Squad* s = squadNo(ctx, (int)fa(a, 0));
        if (!s) { err = "bgarrison N"; return true; }
        bp.request({BuildingPlay::Act::Garrison, bp.selected, s->id, 0});
        return true;
    }
    if (v == "brelease") { bp.request({BuildingPlay::Act::Release, bp.selected, {}, 0}); return true; }
    if (v == "bbarricade") {
        if (a.size() < 2 || barricadeOf(a[1]) == BarricadeType::None) { err = "bbarricade doors|windows planks|plate|sandbags"; return true; }
        bp.request({a[0] == "windows" ? BuildingPlay::Act::BarricadeWindows : BuildingPlay::Act::BarricadeDoors, bp.selected, {}, (int)barricadeOf(a[1])});
        return true;
    }
    if (v == "bnest") { bp.request({BuildingPlay::Act::Nest, bp.selected, {}, 0}); return true; }
    if (v == "bdamage") {   // TEST HOOK
        const Building* B = reg.get(bp.selected);
        if (!B) { err = "no building selected"; return true; }
        for (size_t k = 0; k < B->openings.size(); ++k)
            if (B->openings[k].type == OpeningType::Door && !B->openings[k].open()) { reg.damageBarricade(bp.selected, (uint16_t)k, fa(a, 0, 1e9f)); return true; }
        err = "no barricaded door";
        return true;
    }
    if (v == "bzombies") {   // TEST HOOK: what B3b would report
        const int n = (int)fa(a, 0);
        bp.forceZombiesInside(bp.selected, n);
        return true;
    }
    return false;
}

bool buildingMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) {
    BuildingPlay& bp = w.buildings();
    const BuildingRegistry& reg = bp.registry();
    const GameContext& ctx = w.context();
    const SoldierPool& P = *ctx.soldiers;
    if (m == "buildings") { out = (double)reg.size(); return true; }
    if (m == "buildings_supported") { out = reg.supportedCount(); return true; }
    if (m == "buildings_prepared") { out = 0; for (const Building& B : reg.all()) out += B.prepared ? 1 : 0; return true; }
    if (m == "posted_rounds" || m == "posted_min_y" || m == "posted_roof" || m == "posted_window") {
        out = m == "posted_min_y" ? 1e9 : 0;
        for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
            if (!P.used[i] || P.post[i] != POST_FIRING) continue;
            const Building* B = reg.get(BuildingId{P.building[i]});
            const float fy = B ? P.pos[i].y - B->y0 : 0.f;
            if (m == "posted_rounds") out += P.rounds[i];
            else if (m == "posted_min_y") out = std::min(out, (double)fy);
            else if (B) {
                const bool roof = B->flatRoof && P.pos[i].y >= B->roofY - 0.6f;
                out += (m == "posted_roof") == roof ? 1 : 0;
            }
        }
        if (m == "posted_min_y" && out > 1e8) out = -1;
        return true;
    }
    if (m == "squad_posted" || m == "squad_inside" || m == "squad_maxhp" || m == "squad_hp") {
        if (k >= a.size()) { err = m + " N"; return false; }
        const Squad* s = squadNo(ctx, std::atoi(a[k++].c_str()));
        if (!s) { err = "no squad"; return false; }
        out = 0;
        for (const SoldierId& id : s->members) {
            if (!P.valid(id) || !P.alive(id.index)) continue;
            const uint32_t i = id.index;
            if (m == "squad_posted") out += P.post[i] == POST_FIRING ? 1 : 0;
            else if (m == "squad_inside") out += P.post[i] == POST_INSIDE ? 1 : 0;
            else if (m == "squad_maxhp") out += P.maxHealth[i];
            else out += P.health[i];
        }
        return true;
    }
    if (m == "bstat") {
        if (k >= a.size()) { err = "bstat FIELD"; return false; }
        const std::string f = a[k++];
        const BuildingPlay::Stats& s = bp.stats();
        if (f == "captured") out = s.captured; else if (f == "entered") out = s.entered; else if (f == "posted") out = s.posted;
        else if (f == "admitted") out = s.admitted; else if (f == "discharged") out = s.discharged; else if (f == "healed") out = s.healed;
        else if (f == "barricades") out = s.barricades; else if (f == "breached") out = s.breached; else if (f == "nests") out = s.nests;
        else if (f == "released") out = s.released; else if (f == "ammo") out = s.ammoIssued;
        else { err = "unknown bstat " + f; return false; }
        return true;
    }
    if (m == "building") {
        if (k >= a.size()) { err = "building FIELD"; return false; }
        const std::string f = a[k++];
        const Building* B = reg.get(bp.selected);
        if (!B) { err = "no building selected"; return false; }
        out = 0;
        if (f == "capture") out = (double)B->capture;
        else if (f == "progress") out = B->captureProgress;
        else if (f == "role") out = (double)B->role;
        else if (f == "garrison") out = (double)B->garrison.size();
        else if (f == "patients") out = (double)B->patients.size();
        else if (f == "capacity") out = B->capacity;
        else if (f == "positions") out = (double)B->firing.size();
        else if (f == "supported") out = B->supported ? 1 : 0;
        else if (f == "floors") out = B->floors;
        else if (f == "inside") out = B->zombiesInside;
        else if (f == "ammo") out = bp.ammoStock(bp.selected);
        else if (f == "posted") { for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) out += P.used[i] && P.post[i] == POST_FIRING && P.building[i] == bp.selected.v ? 1 : 0; }
        else if (f == "barricades") { for (const Opening& o : B->openings) out += o.open() ? 0 : 1; }
        else if (f == "nests") { for (const FiringPosition& p : B->firing) out += p.nest ? 1 : 0; }
        else if (f == "doors" || f == "windows") { for (const Opening& o : B->openings) out += o.type == (f == "doors" ? OpeningType::Door : OpeningType::Window) ? 1 : 0; }
        else if (f == "roofpos") { for (const FiringPosition& p : B->firing) out += p.kind == FiringKind::RoofEdge ? 1 : 0; }
        else { err = "unknown building field " + f; return false; }
        return true;
    }
    return false;
}

} // namespace ttz::game
