// App side of the B3a buildings: window loading, UI hooks, props, script verbs / metrics. See BuildingGame.h.
#include "game/BuildingGame.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/GameScript.h"
#include "game/GameUI.h"
#include "game/GameWorld.h"
#include "lab/MilitaryRenderer.h"
#include "render/TimeOfDay.h"

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
    {   // glass materials of the palette: window posts are read from the facade art (Buildings.cpp readGlass)
        std::vector<uint8_t> glass(256, 0);
        for (size_t m = 0; m < C.materials.size() && m < 256; ++m) glass[m] = (C.materials[m].flags & MAT_GLASS) ? 1 : 0;
        reg.setGlassMaterials(glass);
    }
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
            ui.worldLabel(s.x, s.y - 20, B.capture == CaptureState::Contested ? "contested" : "capturing", c,
                          B.capture == CaptureState::Contested ? GameUI::kLabelAlert : GameUI::kLabelStatus, true);
        } else if (B.role != BuildingRole::None) {
            char t[64];
            std::snprintf(t, sizeof(t), "%s %d/%d%s", B.role == BuildingRole::Garrison ? "GARRISON" : "HOSPITAL",
                          B.role == BuildingRole::Garrison ? (int)B.garrison.size() : (int)B.patients.size(), B.capacity, B.zombiesInside > 0 ? " !" : "");
            const ImU32 c = B.role == BuildingRole::Garrison ? IM_COL32(170, 180, 110, 220) : IM_COL32(150, 220, 150, 220);
            ui.worldLabel(s.x, s.y - 8, t, c, bp.selected.v == b ? GameUI::kLabelSelected : GameUI::kLabelStatus, true);
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
    // HUD 2 layout: stacked above the selection panel (which sits above / beside the command bar), never over them
    const HudLayout& L = ui.layout();
    ImGui::SetNextWindowPos(ImVec2(L.panelX, L.panelBottom), ImGuiCond_Always, ImVec2(0.f, 1.f));
    ImGui::SetNextWindowSize(ImVec2(std::min(470.f * L.scale, io.DisplaySize.x - 2.f * L.panelX), 0.f), ImGuiCond_Always);
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
    // HUD 2: context action of the squad selection while a garrison building is selected (same as G)
    UiSelectionAction g;
    g.id = "sel.garrison"; g.label = "Garrison"; g.icon = UiIcon::Garrison; g.hotkeyLabel = "G"; g.order = 50;
    g.visible = [b](const UiCtx& c) {
        const Building* B = b->selected.valid() ? b->registry().get(b->selected) : nullptr;
        return B && B->role == BuildingRole::Garrison && !c.ui.selectionConst().squads.empty();
    };
    g.onSelect = [b](const UiCtx& c) { for (const SquadId& s : c.ui.selectionConst().squads) b->request({BuildingPlay::Act::Garrison, b->selected, s, 0}); };
    g.tooltip = [](const UiCtx&) { return std::string("The selected squads occupy the selected garrison building\n(windows and roof positions)."); };
    ui.registerSelectionAction(g);
}

// ---------------------------------------------------------------------------------------------------------------------
// Garrison window posts (GAME_DESIGN 14e): every window a posted soldier fires from is opened. The facade art keeps its
// mesh; CityRenderer discards the tile fragments inside the opening (city.frag cutouts) and a small room is drawn behind
// it: a reveal (wall thickness) lining the opening, floor boards, plaster walls with a dado and skirting, a ceiling with
// a lamp, a sandbag sill (unless a window nest is built there) and an ammo crate. Interior materials glow warm at night
// (CityRenderer interior palette) and the nearest rooms add a warm point light, so the soldier is lit from inside. The
// room mesh is rebuilt only when the set of opened windows changes; leaving soldiers close their window again.
namespace {
struct OpenWin { uint32_t b; uint16_t k; };
struct RoomState {
    AppState* app = nullptr;
    CityRenderer::GpuMesh mesh;
    uint64_t sig = 0;
    int ext = -1;
    std::vector<PointLight> lights;       // interior lights of the opened rooms (centre of each room, under the lamp)
};
RoomState g_rooms;

struct RoomBuilder {
    CityMesh m;
    V3 o;
    void quad(V3 a, V3 b, V3 c, V3 d, V3 n, int mat) {   // a b c d around the face; wound so n is the front side
        const V3 cr = cross(b - a, c - a);
        const bool flip = dot(cr, n) < 0.f;
        const uint32_t base = (uint32_t)m.verts.size();
        const V3 pts[4] = {a, b, c, d};
        for (const V3& p : pts) {
            CityVertex v{};
            const V3 q = p - o;
            v.x = (int16_t)std::lround(q.x / m.scaleXZ); v.y = (int16_t)std::lround(q.y / m.scaleY); v.z = (int16_t)std::lround(q.z / m.scaleXZ);
            v.nx = (int8_t)std::lround(n.x * 127.f); v.ny = (int8_t)std::lround(n.y * 127.f); v.nz = (int8_t)std::lround(n.z * 127.f);
            v.mat = (uint8_t)(CityRenderer::kInteriorMat + mat);
            m.verts.push_back(v);
            for (int k = 0; k < 3; ++k) { m.bmin[k] = std::min(m.bmin[k], (&p.x)[k]); m.bmax[k] = std::max(m.bmax[k], (&p.x)[k]); }
        }
        const uint32_t i0[6] = {0, 1, 2, 0, 2, 3}, i1[6] = {0, 2, 1, 0, 3, 2};
        for (int k = 0; k < 6; ++k) m.idx.push_back(base + (flip ? i1[k] : i0[k]));
    }
};

// Room of one window post. Frame: n out of the facade, t along it, y up; s / o / y offsets from the opening's bottom centre.
void buildRoom(RoomBuilder& R, const FiringPosition& f, uint32_t seed) {
    const V3 n{std::sin(f.yaw), 0, std::cos(f.yaw)}, t{n.z, 0, -n.x}, up{0, 1, 0};
    const V3 w0 = f.win;
    auto P = [&](float s, float o, float y) { return V3{w0.x + t.x * s + n.x * o, y, w0.z + t.z * s + n.z * o}; };
    const float hw = f.winHalfW + 0.02f, A = w0.y - 0.02f, Bt = w0.y + f.winH + 0.02f;
    const float T = 0.25f, o0 = f.realWindow ? 0.01f : 0.14f;   // reveal depth; derived windows reach the wall plane
    const float RW = f.roomHalfW, D = f.roomDepth, F = f.roomFloor, C = f.roomCeil, ob = -T - D;
    // reveal
    R.quad(P(-hw, o0, A), P(hw, o0, A), P(hw, -T, A), P(-hw, -T, A), up, 8);
    R.quad(P(-hw, o0, Bt), P(hw, o0, Bt), P(hw, -T, Bt), P(-hw, -T, Bt), up * -1.f, 8);
    R.quad(P(-hw, o0, A), P(-hw, -T, A), P(-hw, -T, Bt), P(-hw, o0, Bt), t, 8);
    R.quad(P(hw, o0, A), P(hw, -T, A), P(hw, -T, Bt), P(hw, o0, Bt), t * -1.f, 8);
    // floor (lighter near the window), ceiling + lamp
    const float om = -T - std::min(1.0f, 0.5f * D);
    R.quad(P(-RW, -T, F), P(RW, -T, F), P(RW, om, F), P(-RW, om, F), up, 0);
    R.quad(P(-RW, om, F), P(RW, om, F), P(RW, ob, F), P(-RW, ob, F), up, 1);
    R.quad(P(-RW, -T, C), P(RW, -T, C), P(RW, ob, C), P(-RW, ob, C), up * -1.f, 4);
    const float lo = -T - 0.5f * D;
    R.quad(P(-0.22f, lo + 0.22f, C - 0.01f), P(0.22f, lo + 0.22f, C - 0.01f), P(0.22f, lo - 0.22f, C - 0.01f), P(-0.22f, lo - 0.22f, C - 0.01f), up * -1.f, 5);
    // walls: skirting, dado, plaster (back wall darker; side walls darker towards the back)
    const float y1 = F + 0.1f, y2 = F + 0.95f;
    R.quad(P(-RW, ob, F), P(RW, ob, F), P(RW, ob, y1), P(-RW, ob, y1), n, 9);
    R.quad(P(-RW, ob, y1), P(RW, ob, y1), P(RW, ob, y2), P(-RW, ob, y2), n, 10);
    R.quad(P(-RW, ob, y2), P(RW, ob, y2), P(RW, ob, C), P(-RW, ob, C), n, 3);
    for (int sd = -1; sd <= 1; sd += 2) {
        const float s = RW * (float)sd;
        const V3 nn = t * (float)-sd;
        R.quad(P(s, -T, F), P(s, ob, F), P(s, ob, y1), P(s, -T, y1), nn, 9);
        R.quad(P(s, -T, y1), P(s, ob, y1), P(s, ob, y2), P(s, -T, y2), nn, 10);
        R.quad(P(s, -T, y2), P(s, om, y2), P(s, om, C), P(s, -T, C), nn, 2);
        R.quad(P(s, om, y2), P(s, ob, y2), P(s, ob, C), P(s, om, C), nn, 3);
    }
    // front wall (room side): closes the room around the reveal (seen from the room's back only, cheap)
    R.quad(P(-RW, -T, F), P(RW, -T, F), P(RW, -T, A), P(-RW, -T, A), n * -1.f, 2);
    R.quad(P(-RW, -T, Bt), P(RW, -T, Bt), P(RW, -T, C), P(-RW, -T, C), n * -1.f, 2);
    // a small olive ammo crate in a back corner
    {
        const float cs = (seed & 1) ? -RW + 0.42f : RW - 0.42f, co = ob + 0.32f, h = 0.34f;
        const float a = 0.3f, b = 0.2f;
        R.quad(P(cs - a, co - b, F + h), P(cs + a, co - b, F + h), P(cs + a, co + b, F + h), P(cs - a, co + b, F + h), up, 11);
        R.quad(P(cs - a, co + b, F), P(cs + a, co + b, F), P(cs + a, co + b, F + h), P(cs - a, co + b, F + h), n, 11);
        R.quad(P(cs - a, co - b, F), P(cs - a, co + b, F), P(cs - a, co + b, F + h), P(cs - a, co - b, F + h), t * -1.f, 7);
        R.quad(P(cs + a, co - b, F), P(cs + a, co + b, F), P(cs + a, co + b, F + h), P(cs + a, co - b, F + h), t, 7);
    }
    // sandbag sill: courses of bags on the reveal floor up to a little under the soldier's shoulder (a window nest
    // replaces it); taller openings (shop / curtain glazing) get a low sandbag wall
    if (f.nest) return;
    const float top = std::clamp(F + 1.08f - A, 0.12f, 1.0f);
    const int courses = std::max(1, (int)std::lround(top / 0.13f));
    const float ch = top / (float)courses;
    const float bo0 = -T + 0.03f, bo1 = f.realWindow ? -0.05f : 0.06f;
    for (int c = 0; c < courses; ++c) {
        const float yb = A + c * ch, yt = yb + ch;
        const float off = (c & 1) ? 0.25f : 0.f;
        for (float s0 = -hw + 0.01f - off; s0 < hw - 0.02f; s0 += 0.5f) {
            const float sa = std::max(s0, -hw + 0.01f), sb = std::min(s0 + 0.49f, hw - 0.01f);
            if (sb - sa < 0.08f) continue;
            const int mat = ((int)std::lround((s0 + 3.f) * 2.f) + c + (int)seed) & 1 ? 6 : 7;
            const float bulge = 0.015f;   // rounded look: the top inset a little from the faces
            R.quad(P(sa + bulge, bo1 - bulge, yt), P(sb - bulge, bo1 - bulge, yt), P(sb - bulge, bo0 + bulge, yt), P(sa + bulge, bo0 + bulge, yt), up, mat);
            R.quad(P(sa, bo1, yb), P(sb, bo1, yb), P(sb - bulge, bo1 - bulge, yt), P(sa + bulge, bo1 - bulge, yt), n, mat);
            R.quad(P(sa, bo0, yb), P(sb, bo0, yb), P(sb - bulge, bo0 + bulge, yt), P(sa + bulge, bo0 + bulge, yt), n * -1.f, mat);
            R.quad(P(sa, bo0, yb), P(sa, bo1, yb), P(sa + bulge, bo1 - bulge, yt), P(sa + bulge, bo0 + bulge, yt), t * -1.f, 7);
            R.quad(P(sb, bo0, yb), P(sb, bo1, yb), P(sb - bulge, bo1 - bulge, yt), P(sb - bulge, bo0 + bulge, yt), t, 7);
        }
    }
}

void updateRooms(AppState& app, const GameContext& ctx, const BuildingPlay& bp, MilitaryRenderer& mil) {
    RoomState& S = g_rooms;
    S.app = &app;
    const BuildingRegistry& reg = bp.registry();
    std::vector<OpenWin> open;
    if (const SoldierPool* P = ctx.soldiers)
        for (uint32_t i = 0; i < (uint32_t)P->capacity(); ++i) {
            if (!P->used[i] || P->post[i] != POST_FIRING) continue;
            const Building* B = reg.get(BuildingId{P->building[i]});
            if (!B) continue;
            for (size_t k = 0; k < B->firing.size(); ++k) {
                const FiringPosition& f = B->firing[k];
                if (f.kind != FiringKind::Window || f.winHalfW <= 0.f) continue;
                const float dx = P->pos[i].x - f.pos.x, dz = P->pos[i].z - f.pos.z;
                if (dx * dx + dz * dz < 0.09f && std::fabs(P->pos[i].y - f.pos.y) < 0.5f) { open.push_back({P->building[i], (uint16_t)k}); break; }
            }
        }
    std::sort(open.begin(), open.end(), [](const OpenWin& a, const OpenWin& b) { return a.b != b.b ? a.b < b.b : a.k < b.k; });
    open.erase(std::unique(open.begin(), open.end(), [](const OpenWin& a, const OpenWin& b) { return a.b == b.b && a.k == b.k; }), open.end());
    // facade cutouts (every frame: cheap) and the warm interior lights
    std::vector<float> cut;
    uint64_t sig = 1469598103934665603ull;
    S.lights.clear();
    for (const OpenWin& w : open) {
        const FiringPosition& f = reg.get(BuildingId{w.b})->firing[w.k];
        const float nx = std::sin(f.yaw), nz = std::cos(f.yaw);
        const float hh = 0.5f * f.winH;
        const float box[8] = {f.win.x, f.win.y + hh, f.win.z, f.winHalfW - 0.01f, nx, nz, hh - 0.01f, 0.25f + f.roomDepth + 0.05f};
        if (cut.size() / 8 < (size_t)CityRenderer::kMaxCutouts) cut.insert(cut.end(), box, box + 8);
        sig = (sig ^ ((uint64_t)w.b << 17 ^ w.k ^ (f.nest ? 1ull << 40 : 0ull))) * 1099511628211ull;
        const float lo = 0.25f + 0.5f * f.roomDepth;
        S.lights.push_back({f.win.x - nx * lo, f.roomCeil - 0.45f, f.win.z - nz * lo, 3.4f, 1.f, 0.72f, 0.42f, 1.5f});
    }
    app.cityRenderer.setCutouts(cut.data(), (uint32_t)(cut.size() / 8));
    if (sig != S.sig) {
        S.sig = sig;
        app.cityRenderer.releaseMesh(S.mesh);
        if (!open.empty()) {
            RoomBuilder R;
            const FiringPosition& f0 = reg.get(BuildingId{open[0].b})->firing[open[0].k];
            R.o = {std::floor(f0.win.x), std::floor(f0.win.y), std::floor(f0.win.z)};
            R.m.scaleXZ = 1.f / 64.f; R.m.scaleY = 1.f / 64.f;
            R.m.origin[0] = R.o.x; R.m.origin[1] = R.o.y; R.m.origin[2] = R.o.z;
            for (int k = 0; k < 3; ++k) { R.m.bmin[k] = 1e9f; R.m.bmax[k] = -1e9f; }
            for (const OpenWin& w : open) buildRoom(R, reg.get(BuildingId{w.b})->firing[w.k], w.b * 7u + w.k);
            for (int k = 0; k < 3; ++k) { R.m.bmin[k] -= (&R.o.x)[k]; R.m.bmax[k] -= (&R.o.x)[k]; }   // model space bounds
            S.mesh = app.cityRenderer.uploadExternalMesh(R.m, "garrisonRooms");
        }
    }
    if (S.mesh.vb) { const float q[4] = {0, 0, 0, 1}; mil.addCityMesh(&S.mesh, {0, 0, 0}, q); }
    if (S.ext < 0) {   // interior lights at night, nearest to the camera first (a few: the frame's light budget is shared)
        Renderer::Extension e;
        e.lights = [](std::vector<PointLight>& out) {
            RoomState& St = g_rooms;
            if (!St.app || St.lights.empty()) return;
            const float night = evalTimeOfDay(St.app->renderSettings.tod).night;
            if (night < 0.05f) return;
            const V3 eye = St.app->camera.eye();
            std::vector<PointLight> l = St.lights;
            std::sort(l.begin(), l.end(), [&](const PointLight& a, const PointLight& b) {
                return (a.x - eye.x) * (a.x - eye.x) + (a.z - eye.z) * (a.z - eye.z) < (b.x - eye.x) * (b.x - eye.x) + (b.z - eye.z) * (b.z - eye.z);
            });
            for (size_t k = 0; k < l.size() && k < 4; ++k) { l[k].intensity *= night; out.push_back(l[k]); }
        };
        S.ext = app.renderer.addExtension(e);
    }
}
} // namespace

void shutdownBuildingRender(AppState& app) {
    RoomState& S = g_rooms;
    if (S.ext >= 0) app.renderer.removeExtension(S.ext);
    app.cityRenderer.setCutouts(nullptr, 0);
    app.cityRenderer.releaseMesh(S.mesh);
    S = RoomState{};
}

// ---------------------------------------------------------------------------------------------------------------------
void drawBuildingProps(MilitaryRenderer& mil, const GameContext& ctx, const BuildingPlay& bp, AppState* app) {
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
    if (app) updateRooms(*app, ctx, bp, mil);
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
            else mil.addProp(P.barricade[1][t], {o.pos.x + o.nx * 0.05f, o.pos.y - 0.1f, o.pos.z + o.nz * 0.05f}, yaw);   // sill - frame
        }
        // nests / roof rings at firing positions; occupied roof edges get the approved sandbag roof position. Window
        // nests stand on the room floor behind the reveal (front course against the wall, the soldier inside the U);
        // roof posts are set back from the edge (Buildings.cpp): the ring around him / the U position in front of him
        for (const FiringPosition& f : B.firing) {
            const float c = std::sin(f.yaw), s = std::cos(f.yaw);
            if (f.kind == FiringKind::Window) {
                if (f.nest) mil.addProp(P.nest, {f.win.x - c * 0.6f, f.roomFloor, f.win.z - s * 0.6f}, f.yaw);
            } else if (f.nest && f.ringFits) mil.addProp(P.ring, {f.pos.x - c * 0.9f, f.pos.y, f.pos.z - s * 0.9f}, f.yaw);
            else if (f.nest || f.occupant.valid()) mil.addProp(P.roofPos, {f.pos.x - c * 0.3f, f.pos.y, f.pos.z - s * 0.3f}, f.yaw);
        }
        if (B.role == BuildingRole::None) continue;
        const int r = B.role == BuildingRole::Garrison ? 0 : 1;
        const float yawFront = std::atan2(-B.e2x, -B.e2z);
        // flag: on the roof's front corner (flat roofs) or beside the front door (houses)
        if (B.flatRoof) mil.addProp(P.flag[r], B.toWorld(1.0f, 1.0f, B.roofY), yawFront);
        else mil.addProp(P.flag[r], B.toWorld(-0.8f, -1.2f, B.y0), yawFront);
        // banner on the front facade, hanging from under the roof line (or from the first floor of a house)
        const float by = B.flatRoof ? std::min(B.roofY - 0.4f, B.y0 + 2.f * B.floorHeight + 2.4f) : B.y0 + B.floorHeight * B.floors - 0.2f;
        float bs = B.w * 0.5f + (B.w > 8.f ? 2.5f : 0.f), bestGap = -1.f;   // never over a front window post
        for (float cand = 0.8f; cand <= B.w - 0.8f; cand += 0.25f) {
            float gap = 1e9f;
            for (const FiringPosition& f : B.firing) {
                if (f.kind != FiringKind::Window || f.winHalfW <= 0.f) continue;
                float u, v;
                B.toLocal(f.win.x, f.win.z, u, v);
                if (v > 1.5f) continue;   // front facade only
                gap = std::min(gap, std::fabs(u - cand) - f.winHalfW);
            }
            gap = std::min(gap, 1.2f) - 0.01f * std::fabs(cand - bs);   // prefer the usual spot when it is clear
            if (gap > bestGap) { bestGap = gap; bs = cand; }
        }
        mil.addProp(P.banner[r], B.toWorld(bs, -0.06f, by), yawFront);
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
