// RTS interface (WS-D): input -> Commands, HUD (funding / income / kills / time, build bar, selected squad), squad
// markers, selection rings, placement previews, notices. Styled compact for the miniature diorama (GAME_DESIGN 11/14b).
#include "game/GameUI.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Deploy.h"
#include "game/Economy.h"
#include "game/HordeInterface.h"
#include "game/Logistics.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"
#include "game/Walls.h"
#include "imgui.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;

// miniature palette: olive drab panels, sand text, muted signal colours
const ImU32 kPanel = IM_COL32(24, 27, 19, 214), kPanelEdge = IM_COL32(112, 118, 76, 200), kSand = IM_COL32(232, 224, 190, 255),
            kDim = IM_COL32(170, 166, 140, 255), kOk = IM_COL32(126, 196, 92, 255), kBad = IM_COL32(226, 86, 64, 255),
            kAmber = IM_COL32(232, 178, 64, 255), kBlue = IM_COL32(96, 160, 220, 255), kShadow = IM_COL32(0, 0, 0, 150);

void viewSize(const AppState& app, float& w, float& h) {
    if (app.window) {
        int iw, ih;
        SDL_GetWindowSize(app.window, &iw, &ih);
        w = (float)iw; h = (float)ih;
    } else { w = (float)app.opt.width; h = (float)app.opt.height; }
}

bool project(const AppState& app, V3 p, ImVec2& out) {
    float w, h;
    viewSize(app, w, h);
    const M4 vp = mul(app.camera.proj(w / std::max(1.f, h)), app.camera.view());
    float c[4];
    for (int i = 0; i < 4; ++i) c[i] = vp(i, 0) * p.x + vp(i, 1) * p.y + vp(i, 2) * p.z + vp(i, 3);
    if (c[3] <= 0.05f) return false;
    out = ImVec2((c[0] / c[3] * 0.5f + 0.5f) * w, (0.5f - c[1] / c[3] * 0.5f) * h);
    return out.x > -200 && out.y > -200 && out.x < w + 200 && out.y < h + 200;
}

void groundCircle(ImDrawList* dl, const AppState& app, V3 c, float r, ImU32 col, float thick, int seg = 24) {
    ImVec2 pts[48];
    int n = 0;
    seg = std::min(seg, 48);
    for (int k = 0; k < seg; ++k) {
        const float a = k * 2.f * kPi / (float)seg;
        if (!project(app, {c.x + std::cos(a) * r, c.y + 0.06f, c.z + std::sin(a) * r}, pts[n])) return;
        ++n;
    }
    dl->AddPolyline(pts, n, col, thick, ImDrawFlags_Closed);
}

ImU32 withAlpha(ImU32 c, float a) { return (c & 0x00FFFFFFu) | ((ImU32)(std::clamp(a, 0.f, 1.f) * ((c >> 24) & 0xFF)) << 24); }

// class glyph: rifle = disc, machine gun = square, sniper = diamond (readable at 100-150 m without text)
void classGlyph(ImDrawList* dl, ImVec2 c, float r, SquadType t, ImU32 fill, ImU32 edge) {
    if (t == SquadType::Rifle) { dl->AddCircleFilled(c, r, fill, 16); dl->AddCircle(c, r, edge, 16, 1.5f); }
    else if (t == SquadType::MachineGun) {
        dl->AddRectFilled(ImVec2(c.x - r, c.y - r), ImVec2(c.x + r, c.y + r), fill, 1.5f);
        dl->AddRect(ImVec2(c.x - r, c.y - r), ImVec2(c.x + r, c.y + r), edge, 1.5f, 0, 1.5f);
        dl->AddLine(ImVec2(c.x - r * 0.55f, c.y), ImVec2(c.x + r * 0.55f, c.y), edge, 1.5f);   // "MG" bar
    } else {
        const float q = r * 1.2f;
        dl->AddQuadFilled(ImVec2(c.x, c.y - q), ImVec2(c.x + q, c.y), ImVec2(c.x, c.y + q), ImVec2(c.x - q, c.y), fill);
        dl->AddQuad(ImVec2(c.x, c.y - q), ImVec2(c.x + q, c.y), ImVec2(c.x, c.y + q), ImVec2(c.x - q, c.y), edge, 1.5f);
    }
}

const char* squadName(SquadType t) { return t == SquadType::Rifle ? "Rifle squad" : t == SquadType::MachineGun ? "MG squad" : "Sniper"; }

V3 squadCentre(const Squad& s, const SoldierPool& P, int* alive = nullptr) {
    V3 c{};
    int n = 0;
    for (const SoldierId& m : s.members)
        if (P.valid(m) && P.alive(m.index)) { c = c + P.pos[m.index]; ++n; }
    if (alive) *alive = n;
    return n ? c * (1.f / (float)n) : c;
}

bool shiftHeld() { return (SDL_GetModState() & SDL_KMOD_SHIFT) != 0; }
} // namespace

bool GameUI::pickGround(const AppState& app, const GameContext& ctx, float sx, float sy, V3& out) {
    float w, h;
    viewSize(app, w, h);
    V3 bot;
    // March the view ray from the eye (towers can rise above any fixed start plane; a start inside one picked a
    // point behind its roof) down to y = -1, against the live height grid: the first surface hit is the roof or street.
    if (!app.camera.screenToGround(sx, sy, w, h, -1.f, bot)) return false;
    const V3 top = app.camera.eye();
    if (!ctx.nav || !ctx.nav->ready()) { if (!app.camera.screenToGround(sx, sy, w, h, 0.f, out)) return false; return true; }
    const NavGrid& nav = *ctx.nav;
    const V3 d = bot - top;
    const float len = std::sqrt(dot(d, d));
    const int steps = std::max(8, std::min(4000, (int)(len / 0.25f)));
    V3 prev = top;
    for (int k = 1; k <= steps; ++k) {
        V3 p = top + d * ((float)k / (float)steps);
        const float s = nav.surface(p.x, p.z);
        if (p.y <= s) {   // refine between prev and p
            V3 a = prev, b = p;
            for (int it = 0; it < 8; ++it) {
                V3 m = (a + b) * 0.5f;
                if (m.y <= nav.surface(m.x, m.z)) b = m; else a = m;
            }
            out = {b.x, nav.surface(b.x, b.z), b.z};
            return true;
        }
        prev = p;
    }
    out = {bot.x, nav.surface(bot.x, bot.z), bot.z};
    return true;
}

bool GameUI::worldToScreen(const AppState& app, V3 p, float& sx, float& sy) {
    ImVec2 v;
    if (!project(app, p, v)) return false;
    sx = v.x; sy = v.y;
    return true;
}

void GameUI::notify(const std::string& text, bool bad, double time) {
    if (bad) SDL_Log("game: %s", text.c_str());
    notices_.push_back({text, time, bad});
    if (notices_.size() > 4) notices_.erase(notices_.begin());
}

void GameUI::selectAt(AppState& app, const GameContext& ctx, float x, float y, bool additive, CommandQueue& out) {
    Command c;
    c.type = CommandType::Select;
    c.additive = additive;
    if (additive) c.squads = sel_.squads;
    float best = 22.f * 22.f;
    SquadId hit;
    const SoldierPool& P = *ctx.soldiers;
    for (const Squad& s : ctx.squads->squads) {
        for (const SoldierId& m : s.members) {
            if (!P.valid(m) || !P.alive(m.index)) continue;
            for (float hgt : {0.3f, 1.0f, 1.6f}) {
                ImVec2 sp;
                if (!project(app, P.pos[m.index] + V3{0, hgt, 0}, sp)) continue;
                const float d = (sp.x - x) * (sp.x - x) + (sp.y - y) * (sp.y - y);
                if (d < best) { best = d; hit = s.id; }
            }
        }
        int alive = 0;
        V3 cc = squadCentre(s, P, &alive);
        ImVec2 mk;
        if (alive && project(app, cc + V3{0, 2.6f, 0}, mk)) {   // the marker is clickable too
            const float d = (mk.x - x) * (mk.x - x) + (mk.y - (y + 12.f)) * (mk.y - (y + 12.f));
            if (d < best) { best = d; hit = s.id; }
        }
    }
    if (!hit.valid() && buildingClick && buildingClick(app, ctx, x, y)) return;   // B3a: building selected, squads kept
    if (hit.valid()) {
        if (additive && sel_.contains(hit)) c.squads.erase(std::remove(c.squads.begin(), c.squads.end(), hit), c.squads.end());
        else c.squads.push_back(hit);
    } else if (additive) return;
    out.push(c);
    sel_.squads = c.squads;   // immediate feedback (the command re-applies the same selection next tick)
}

void GameUI::selectBox(AppState& app, const GameContext& ctx, float x0, float y0, float x1, float y1, bool additive, CommandQueue& out) {
    if (x0 > x1) std::swap(x0, x1);
    if (y0 > y1) std::swap(y0, y1);
    Command c;
    c.type = CommandType::Select;
    c.additive = additive;
    if (additive) c.squads = sel_.squads;
    const SoldierPool& P = *ctx.soldiers;
    for (const Squad& s : ctx.squads->squads) {
        bool in = false;
        for (const SoldierId& m : s.members) {
            if (!P.valid(m) || !P.alive(m.index)) continue;
            ImVec2 sp;
            if (project(app, P.pos[m.index] + V3{0, 0.9f, 0}, sp) && sp.x >= x0 && sp.x <= x1 && sp.y >= y0 && sp.y <= y1) { in = true; break; }
        }
        if (in && std::find(c.squads.begin(), c.squads.end(), s.id) == c.squads.end()) c.squads.push_back(s.id);
    }
    out.push(c);
    sel_.squads = c.squads;
}

void GameUI::placeAt(AppState& app, const GameContext& ctx, V3 p, CommandQueue& out) {
    const BalanceConfig& cfg = *ctx.cfg;
    Command c;
    c.pos = p;
    const char* why = "";
    int price = 0;
    bool ok = false;
    switch (tool_) {
    case Tool::BuyRifle: case Tool::BuyMG: case Tool::BuySniper: {
        c.type = CommandType::BuySquad;
        c.squadType = tool_ == Tool::BuyRifle ? SquadType::Rifle : tool_ == Tool::BuyMG ? SquadType::MachineGun : SquadType::Sniper;
        DropPlan plan = ctx.deploy->plan(ctx, c.squadType, p);
        ok = plan.valid; why = plan.reason; price = plan.price;
        break;
    }
    case Tool::PlaceContainer:
        c.type = CommandType::BuyContainer; c.facing = containerYaw_;
        ok = ctx.logistics->canPlaceContainer(ctx, p, containerYaw_, &why); price = cfg.economy.containerPrice;
        break;
    case Tool::Airdrop:
        c.type = CommandType::BuyAirdrop;
        ok = ctx.logistics->canAirdrop(ctx, p, &why); price = cfg.economy.airdropPrice;
        break;
    default: return;
    }
    if (!ok) { notify(std::string("Refused: ") + why, true, now_); return; }
    if (!ctx.economy->canAfford(price)) { notify("Not enough funding", true, now_); return; }
    out.push(c);
    if (!shiftHeld()) tool_ = Tool::Select;
}

bool GameUI::handleEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) {
    if (!ctx.soldiers || !ctx.squads) return false;
    if (tool_ == Tool::BuildWall && wallEvent(app, ctx, e, out)) return true;   // B2 wall tool (FortUI.cpp)
    if (tool_ == Tool::PlaceContainer && e.type == SDL_EVENT_MOUSE_WHEEL && e.wheel.y != 0.f) {   // B2: rotate 15 deg
        containerYaw_ = std::fmod(containerYaw_ + (e.wheel.y > 0 ? 1.f : -1.f) * kPi / 12.f + 2.f * kPi, 2.f * kPi);
        return true;
    }
    if (buildingKey && e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat && buildingKey(app, ctx, e)) return true;   // B3a
    switch (e.type) {
    case SDL_EVENT_KEY_DOWN: {
        if (e.key.repeat) return false;
        const SDL_Keycode k = e.key.key;
        auto toggle = [&](Tool t) { tool_ = tool_ == t ? Tool::Select : t; forced_ = false; return true; };
        if (k == SDLK_N || k == SDLK_M || k == SDLK_J) {   // B2: cheap wall / reinforced wall / gate (PROPOSED)
            const uint8_t t = k == SDLK_M ? 1 : 0;
            const bool g = k == SDLK_J;
            if (tool_ == Tool::BuildWall && wallType_ == t && wallGate_ == g) { tool_ = Tool::Select; wallPts_.clear(); }
            else setWallMode(t, g);
            return true;
        }
        if ((k == SDLK_Q || k == SDLK_E) && tool_ == Tool::PlaceContainer) {   // B2: 15 deg steps (T: 90)
            containerYaw_ = std::fmod(containerYaw_ + (k == SDLK_E ? 1.f : -1.f) * kPi / 12.f + 2.f * kPi, 2.f * kPi);
            return true;
        }
        if (k == SDLK_Z) return toggle(Tool::BuyRifle);
        if (k == SDLK_X) return toggle(Tool::BuyMG);
        if (k == SDLK_C) return toggle(Tool::BuySniper);
        if (k == SDLK_V) return toggle(Tool::PlaceContainer);
        if (k == SDLK_B) return toggle(Tool::Airdrop);
        if (k == SDLK_T && tool_ == Tool::PlaceContainer) { containerYaw_ = std::fmod(containerYaw_ + kPi / 2.f, 2.f * kPi); return true; }
        if (k == SDLK_H && !sel_.squads.empty()) {
            Command c; c.type = CommandType::Stop; c.squads = sel_.squads; out.push(c);
            return true;
        }
        if (k == SDLK_TAB && !ctx.squads->squads.empty()) {
            size_t next = 0;
            if (!sel_.squads.empty()) next = (sel_.squads.back().index + 1) % ctx.squads->squads.size();
            Command c; c.type = CommandType::Select; c.squads = {ctx.squads->squads[next].id}; out.push(c);
            sel_.squads = c.squads;
            return true;
        }
        if (k >= SDLK_1 && k <= SDLK_9) {
            const size_t n = (size_t)(k - SDLK_1);
            if (n < ctx.squads->squads.size()) {
                Command c; c.type = CommandType::Select; c.additive = shiftHeld();
                if (c.additive) c.squads = sel_.squads;
                c.squads.push_back(ctx.squads->squads[n].id);
                out.push(c);
                sel_.squads = c.squads;
            }
            return true;   // the sandbox tools (1-3) are off in --game
        }
        if (k == SDLK_ESCAPE) {
            if (tool_ != Tool::Select) { tool_ = Tool::Select; forced_ = false; return true; }
            if (!sel_.squads.empty()) { Command c; c.type = CommandType::Select; out.push(c); sel_.squads.clear(); return true; }
            return false;
        }
        if (k == SDLK_F6) { aiDebug = !aiDebug; return true; }   // AI debug overlay
        if (k == SDLK_R || k == SDLK_G || k == SDLK_F) return true;   // sandbox reset / debug toggles are off in --game
        return false;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        if (e.button.button == SDL_BUTTON_LEFT) {
            if (SDL_GetModState() & SDL_KMOD_ALT) return false;   // alt-drag rotates the camera (App)
            if (tool_ != Tool::Select) {
                V3 p;
                if (pickGround(app, ctx, e.button.x, e.button.y, p)) placeAt(app, ctx, p, out);
                return true;
            }
            lmbDown_ = true; boxing_ = false;
            boxX0_ = boxX1_ = e.button.x; boxY0_ = boxY1_ = e.button.y;
            return true;
        }
        if (e.button.button == SDL_BUTTON_RIGHT) { rmbDown_ = true; rmbX_ = e.button.x; rmbY_ = e.button.y; rmbTravel_ = 0; }
        return false;   // RMB drag pans (App)
    case SDL_EVENT_MOUSE_MOTION:
        if (lmbDown_) {
            boxX1_ = e.motion.x; boxY1_ = e.motion.y;
            if (std::fabs(boxX1_ - boxX0_) + std::fabs(boxY1_ - boxY0_) > 6.f) boxing_ = true;
        }
        if (rmbDown_) rmbTravel_ += std::fabs(e.motion.xrel) + std::fabs(e.motion.yrel);
        return false;
    case SDL_EVENT_MOUSE_BUTTON_UP:
        if (e.button.button == SDL_BUTTON_LEFT && lmbDown_) {
            lmbDown_ = false;
            if (boxing_) selectBox(app, ctx, boxX0_, boxY0_, e.button.x, e.button.y, shiftHeld(), out);
            else selectAt(app, ctx, e.button.x, e.button.y, shiftHeld(), out);
            boxing_ = false;
            return true;
        }
        if (e.button.button == SDL_BUTTON_RIGHT && rmbDown_) {
            rmbDown_ = false;
            if (rmbTravel_ < 6.f) {   // a click, not a pan
                if (tool_ != Tool::Select) { tool_ = Tool::Select; forced_ = false; }
                else if (!sel_.squads.empty()) {
                    V3 p;
                    if (pickGround(app, ctx, e.button.x, e.button.y, p)) {
                        // several squads: side by side across the move direction, 9 m apart
                        V3 cen{};
                        int n = 0;
                        for (const SquadId& id : sel_.squads)
                            if (const Squad* s = ctx.squads->get(id)) { int a = 0; V3 c = squadCentre(*s, *ctx.soldiers, &a); if (a) { cen = cen + c; ++n; } }
                        if (n) cen = cen * (1.f / (float)n); else cen = p;
                        V3 dir = normalize(V3{p.x - cen.x, 0, p.z - cen.z});
                        if (dot(dir, dir) < 0.5f) dir = {0, 0, 1};
                        const V3 side{dir.z, 0, -dir.x};
                        const float facing = std::atan2(dir.x, dir.z);
                        const int m = (int)sel_.squads.size();
                        for (int k = 0; k < m; ++k) {
                            Command c;
                            c.type = CommandType::Move;
                            c.squads = {sel_.squads[(size_t)k]};
                            const float off = ((float)k - 0.5f * (float)(m - 1)) * 9.f;
                            c.pos = p + side * off;
                            if (ctx.nav && ctx.nav->ready()) c.pos.y = ctx.nav->surface(c.pos.x, c.pos.z);
                            c.facing = facing;
                            c.run = shiftHeld();
                            c.walk = (SDL_GetModState() & (SDL_KMOD_CTRL | SDL_KMOD_ALT)) != 0;
                            out.push(c);
                        }
                        orderMarker_ = p;
                        orderMarkerT_ = now_;
                    }
                }
            }
        }
        return false;
    default: return false;
    }
}

// ---------------------------------------------------------------------------------------------------------------
void GameUI::draw(AppState& app, const GameContext& ctx, CommandQueue& out) {
    if (!ctx.cfg || !ctx.economy) return;
    now_ = ctx.time;
    // forget selected squads that no longer have anyone alive
    if (ctx.squads && ctx.soldiers)
        sel_.squads.erase(std::remove_if(sel_.squads.begin(), sel_.squads.end(), [&](const SquadId& id) {
            const Squad* s = ctx.squads->get(id);
            return !s || ctx.squads->aliveMembers(*s, *ctx.soldiers) == 0;
        }), sel_.squads.end());
    ImGuiStyle& st = ImGui::GetStyle();
    const ImGuiStyle saved = st;
    st.WindowRounding = 3.f; st.FrameRounding = 2.f; st.WindowBorderSize = 1.f; st.FrameBorderSize = 1.f;
    st.WindowPadding = ImVec2(10, 6); st.ItemSpacing = ImVec2(8, 4);
    st.Colors[ImGuiCol_WindowBg] = ImGui::ColorConvertU32ToFloat4(kPanel);
    st.Colors[ImGuiCol_Border] = ImGui::ColorConvertU32ToFloat4(kPanelEdge);
    st.Colors[ImGuiCol_Text] = ImGui::ColorConvertU32ToFloat4(kSand);
    st.Colors[ImGuiCol_TextDisabled] = ImVec4(0.55f, 0.54f, 0.46f, 1.f);
    st.Colors[ImGuiCol_Button] = ImVec4(0.22f, 0.24f, 0.15f, 0.95f);
    st.Colors[ImGuiCol_ButtonHovered] = ImVec4(0.34f, 0.37f, 0.22f, 1.f);
    st.Colors[ImGuiCol_ButtonActive] = ImVec4(0.46f, 0.48f, 0.28f, 1.f);
    st.Colors[ImGuiCol_PlotHistogram] = ImVec4(0.49f, 0.77f, 0.36f, 1.f);
    st.Colors[ImGuiCol_FrameBg] = ImVec4(0.08f, 0.09f, 0.06f, 0.9f);
    drawMarkers(app, ctx);
    drawPreview(app, ctx);
    drawTopBar(app, ctx);
    drawBuildBar(app, ctx, out);
    drawSelection(app, ctx, out);
    drawNotices(app, ctx);
    if (buildingDraw) buildingDraw(app, ctx);   // B3a: building markers / panel (BuildingGame.cpp)
    if (aiDebug) drawAiDebug(app, ctx);
    if (boxing_) {
        ImDrawList* dl = ImGui::GetForegroundDrawList();
        dl->AddRectFilled(ImVec2(std::min(boxX0_, boxX1_), std::min(boxY0_, boxY1_)), ImVec2(std::max(boxX0_, boxX1_), std::max(boxY0_, boxY1_)),
                          IM_COL32(232, 224, 190, 28));
        dl->AddRect(ImVec2(std::min(boxX0_, boxX1_), std::min(boxY0_, boxY1_)), ImVec2(std::max(boxX0_, boxX1_), std::max(boxY0_, boxY1_)),
                    IM_COL32(232, 224, 190, 180), 0.f, 0, 1.f);
    }
    st = saved;
}

void GameUI::drawTopBar(AppState& app, const GameContext& ctx) {
    const Economy& eco = *ctx.economy;
    const ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x * 0.5f, 6.f), ImGuiCond_Always, ImVec2(0.5f, 0.f));
    ImGui::Begin("##gamebar", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoMove |
                                         ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    const int t = (int)ctx.time;
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kDim), "FUNDING");
    ImGui::SameLine();
    ImGui::Text("$%.0f", std::floor(eco.funding()));
    ImGui::SameLine(0, 4);
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kOk), "+%.0f/min", eco.incomePerMinute());
    ImGui::SameLine(0, 18);
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kDim), "KILLS");
    ImGui::SameLine();
    ImGui::Text("%llu", (unsigned long long)eco.kills());
    ImGui::SameLine(0, 18);
    int alive = 0, total = 0;
    if (ctx.soldiers) for (uint32_t i = 0; i < (uint32_t)ctx.soldiers->capacity(); ++i) if (ctx.soldiers->used[i]) { ++total; alive += ctx.soldiers->alive(i) ? 1 : 0; }
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kDim), "TROOPS");
    ImGui::SameLine();
    ImGui::Text("%d", alive);
    if (total > alive) { ImGui::SameLine(0, 3); ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kBad), "(-%d)", total - alive); }
    ImGui::SameLine(0, 18);
    ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kDim), "TERRITORY");
    ImGui::SameLine();
    drawTerritoryHud(ctx);   // B2 (FortUI.cpp)
    ImGui::SameLine(0, 18);
    ImGui::Text("%02d:%02d", t / 60, t % 60);
    if (!ctx.cfg->approved()) {
        ImGui::SameLine(0, 18);
        ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kAmber), "UNAPPROVED BALANCE");
        if (ImGui::IsItemHovered()) ImGui::SetTooltip("All prices, rates and weapon stats are provisional playtest values\n(config/balance.json status: %s)", ctx.cfg->status.c_str());
    }
    ImGui::End();
}

void GameUI::drawBuildBar(AppState& app, const GameContext& ctx, CommandQueue& out) {
    const BalanceConfig& cfg = *ctx.cfg;
    const ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x - 10.f, io.DisplaySize.y - 8.f), ImGuiCond_Always, ImVec2(1.f, 1.f));   // bottom right (selection: bottom left)
    ImGui::Begin("##build", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoMove |
                                       ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    struct B { Tool t; const char* name; const char* key; int price; const char* tip; };
    const B items[5] = {
        {Tool::BuyRifle, "Rifle squad", "Z", cfg.squad[0].price, "5 riflemen. General purpose: clearing and defence."},
        {Tool::BuyMG, "MG squad", "X", cfg.squad[1].price, "3 machine gunners. Sustained fire against dense hordes. Loud, high ammo use."},
        {Tool::BuySniper, "Sniper", "C", cfg.squad[2].price, "1 suppressed sniper. Quiet removal of isolated zombies; rooftops."},
        {Tool::PlaceContainer, "Ammo container", "V", cfg.economy.containerPrice, "Central ammunition container (finite stock). Soldiers walk to it to refill.\nArrives by parachute, never disappears and blocks zombies like a wall piece.\nQ / E / mouse wheel rotate 15 deg, T 90 deg."},
        {Tool::Airdrop, "Ammo drop", "B", cfg.economy.airdropPrice, "Airdrop crate by parachute near your units (finite stock)."},
    };
    ImDrawList* dl = ImGui::GetWindowDrawList();
    for (int k = 0; k < 5; ++k) {
        const B& b = items[k];
        if (k) ImGui::SameLine();
        const bool afford = ctx.economy->canAfford(b.price), active = tool_ == b.t;
        ImGui::PushID(k);
        if (active) ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.50f, 0.46f, 0.24f, 1.f));
        if (!afford) ImGui::BeginDisabled();
        char label[64];
        std::snprintf(label, sizeof(label), "     %s\n     $%d  [%s]", b.name, b.price, b.key);
        ImVec2 p0 = ImGui::GetCursorScreenPos();
        if (ImGui::Button(label, ImVec2(0, 0))) { tool_ = active ? Tool::Select : b.t; forced_ = false; }
        if (!afford) ImGui::EndDisabled();
        if (active) ImGui::PopStyleColor();
        if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) ImGui::SetTooltip("%s%s", b.tip, afford ? "" : "\nNot enough funding.");
        const ImVec2 sz = ImGui::GetItemRectSize();
        const ImVec2 ic(p0.x + 14.f, p0.y + sz.y * 0.5f);
        const ImU32 fc = afford ? IM_COL32(150, 156, 98, 255) : IM_COL32(90, 90, 80, 255);
        if (k < 3) classGlyph(dl, ic, 6.f, (SquadType)k, fc, IM_COL32(20, 22, 14, 255));
        else if (k == 3) { dl->AddRectFilled(ImVec2(ic.x - 8, ic.y - 5), ImVec2(ic.x + 8, ic.y + 5), fc, 1.f); dl->AddLine(ImVec2(ic.x - 3, ic.y - 5), ImVec2(ic.x - 3, ic.y + 5), IM_COL32(20, 22, 14, 255), 1.f); }
        else { dl->AddRectFilled(ImVec2(ic.x - 5, ic.y - 1), ImVec2(ic.x + 5, ic.y + 7), fc, 1.f); dl->AddCircle(ImVec2(ic.x, ic.y - 4), 6.f, fc, 12, 1.5f); }
        ImGui::PopID();
    }
    drawWallButtons(ctx);   // B2 (FortUI.cpp)
    ImGui::End();
}

void GameUI::drawSelection(AppState& app, const GameContext& ctx, CommandQueue& out) {
    if (sel_.squads.empty() || !ctx.squads || !ctx.soldiers) return;
    const SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(10.f, io.DisplaySize.y - 8.f), ImGuiCond_Always, ImVec2(0.f, 1.f));
    ImGui::SetNextWindowSizeConstraints(ImVec2(380, 0), ImVec2(420, io.DisplaySize.y * 0.6f));
    ImGui::Begin("##selection", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoMove |
                                           ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    ImDrawList* dl = ImGui::GetWindowDrawList();
    int shown = 0;
    for (const SquadId& id : sel_.squads) {
        const Squad* s = ctx.squads->get(id);
        if (!s) continue;
        if (shown++ >= 3) { ImGui::TextDisabled("+ %d more squads", (int)sel_.squads.size() - 3); break; }
        const int alive = ctx.squads->aliveMembers(*s, P);
        const char* status = s->deploying ? "deploying" : (s->flags & SQ_UNDER_ATTACK) ? "under attack" : (s->flags & SQ_ENGAGED) ? "engaging"
                           : (s->flags & SQ_RESUPPLYING) ? "resupplying" : (s->flags & SQ_MOVING) ? "moving" : "holding";
        ImVec2 p0 = ImGui::GetCursorScreenPos();
        ImGui::Dummy(ImVec2(16, 14));
        classGlyph(dl, ImVec2(p0.x + 7, p0.y + 7), 5.f, s->type, IM_COL32(150, 156, 98, 255), IM_COL32(20, 22, 14, 255));
        ImGui::SameLine();
        ImGui::Text("%s %u", squadName(s->type), s->number);
        ImGui::SameLine();
        ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(alive < (int)s->members.size() ? kBad : kDim), "%d/%d", alive, (int)s->members.size());
        ImGui::SameLine();
        ImGui::TextColored(ImGui::ColorConvertU32ToFloat4((s->flags & SQ_UNDER_ATTACK) ? kBad : (s->flags & SQ_OUT_OF_AMMO) ? kBad
                                                          : (s->flags & SQ_LOW_AMMO) ? kAmber : kDim), "%s%s", status,
                           (s->flags & SQ_OUT_OF_AMMO) ? ", no ammo" : (s->flags & SQ_LOW_AMMO) ? ", low ammo" : "");
        for (const SoldierId& m : s->members) {
            if (!P.valid(m)) continue;
            const uint32_t i = m.index;
            const size_t c = (size_t)P.cls[i];
            const bool dead = !P.alive(i);
            const float hp = dead ? 0.f : std::clamp(P.health[i] / std::max(1.f, cfg.soldier[c].health), 0.f, 1.f);
            const int full = cfg.weapon[c].magazine + cfg.weapon[c].reserve;
            const float am = std::clamp((float)(P.mag[i] + P.reserve[i]) / (float)std::max(1, full), 0.f, 1.f);
            ImVec2 q = ImGui::GetCursorScreenPos();
            const float bw = 70.f, bh = 5.f, y = q.y + 5.f;
            ImGui::Dummy(ImVec2(360, 14));
            ImGui::SameLine(0, 0);
            dl->AddText(ImVec2(q.x + 2, q.y), dead ? kBad : kDim, className(P.cls[i]));
            const float x0 = q.x + 64.f;
            dl->AddRectFilled(ImVec2(x0, y), ImVec2(x0 + bw, y + bh), IM_COL32(10, 10, 8, 220));
            dl->AddRectFilled(ImVec2(x0, y), ImVec2(x0 + bw * hp, y + bh), hp > 0.5f ? kOk : hp > 0.25f ? kAmber : kBad);
            const float x1 = x0 + bw + 8.f;
            dl->AddRectFilled(ImVec2(x1, y), ImVec2(x1 + bw, y + bh), IM_COL32(10, 10, 8, 220));
            dl->AddRectFilled(ImVec2(x1, y), ImVec2(x1 + bw * am, y + bh), am > cfg.soldier[c].lowAmmoFraction ? kBlue : am > 0 ? kAmber : kBad);
            if (!dead) {   // stamina: a thin line under the health bar (subtle; amber while exhausted)
                const float stf = std::clamp(P.stamina[i] / std::max(1.f, cfg.stamina.max), 0.f, 1.f);
                dl->AddRectFilled(ImVec2(x0, y + bh + 1.f), ImVec2(x0 + bw * stf, y + bh + 2.5f), P.tired[i] ? kAmber : IM_COL32(200, 200, 170, 150));
            }
            char txt[80];
            if (dead) std::snprintf(txt, sizeof(txt), "KIA");
            else std::snprintf(txt, sizeof(txt), "%d|%d %s%s%s", P.mag[i], P.reserve[i], stateName(P.state[i]), P.runner[i] ? " (ammo runner)" : "",
                               P.wounded[i] ? " (wounded)" : "");
            dl->AddText(ImVec2(x1 + bw + 6.f, q.y), dead ? kBad : kDim, txt);
            ImGui::NewLine();
        }
        ImGui::Spacing();
    }
    ImGui::TextDisabled("RMB: move  Shift+RMB: run  H: halt");
    ImGui::End();
}

void GameUI::drawMarkers(AppState& app, const GameContext& ctx) {
    if (!ctx.squads || !ctx.soldiers) return;
    drawTerritory(app, ctx);   // B2: subtle perimeter outline, region labels, breaches, damaged walls (FortUI.cpp)
    const SoldierPool& P = *ctx.soldiers;
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    const float dist = app.camera.distance();
    const float r = std::clamp(9.f - dist * 0.02f, 5.5f, 8.f);   // size-clamped: readable at 100-150 m, small up close
    // supply points
    if (ctx.logistics)
        for (const SupplyPoint& p : ctx.logistics->points()) {
            if (!p.alive) continue;
            ImVec2 sp;
            const V3 at{p.pos.x, p.pos.y + (p.landed ? (p.kind == SupplyKind::Container ? 3.4f : 1.6f) : p.altitude + 1.f), p.pos.z};
            if (!project(app, at, sp)) continue;
            const float fill = p.initialTotal > 0 ? (float)p.total() / (float)p.initialTotal : 0.f;
            const ImU32 col = p.total() > 0 ? kBlue : IM_COL32(120, 120, 110, 200);
            const float w = p.kind == SupplyKind::Container ? 9.f : 6.f;
            dl->AddRectFilled(ImVec2(sp.x - w - 1, sp.y - 5), ImVec2(sp.x + w + 1, sp.y + 5), kShadow, 1.f);
            dl->AddRectFilled(ImVec2(sp.x - w, sp.y - 4), ImVec2(sp.x - w + 2.f * w * fill, sp.y + 4), col, 1.f);
            dl->AddRect(ImVec2(sp.x - w, sp.y - 4), ImVec2(sp.x + w, sp.y + 4), kSand, 1.f, 0, 1.f);
            if (p.kind == SupplyKind::Container && dist < 160.f) {
                char t[32];
                std::snprintf(t, sizeof(t), "%d", p.total());
                dl->AddText(ImVec2(sp.x + w + 4, sp.y - 7), kSand, t);
            }
        }
    // selection rings and the class icon are drawn in the world by GameRender (WS-B); here: number + status pips
    // move-order marker
    if (now_ - orderMarkerT_ < 1.0) {
        const float a = (float)(now_ - orderMarkerT_);
        groundCircle(dl, app, orderMarker_, 1.5f - a, withAlpha(kOk, 1.f - a), 2.f);
    }
    for (const Squad& s : ctx.squads->squads) {
        int alive = 0;
        const V3 c = squadCentre(s, P, &alive);
        if (!alive) continue;
        float top = 0;
        for (const SoldierId& m : s.members) if (P.valid(m) && P.alive(m.index)) top = std::max(top, P.pos[m.index].y);
        ImVec2 sp;
        if (!project(app, V3{c.x, std::max(c.y, top) + 2.7f, c.z}, sp)) continue;   // GameRender's class icon height
        const bool sel = sel_.contains(s.id);
        // squad number beside the world class icon (rifle / MG / sniper read from the icon shape and colour)
        char num[8];
        std::snprintf(num, sizeof(num), "%u", s.number);
        const ImVec2 ts = ImGui::CalcTextSize(num);
        const float nx = sp.x - r - 6.f - ts.x;
        dl->AddText(ImVec2(nx + 1, sp.y - ts.y * 0.5f + 1), kShadow, num);
        dl->AddText(ImVec2(nx, sp.y - ts.y * 0.5f), sel ? IM_COL32(255, 255, 255, 255) : kSand, num);
        // status pips to the right: deploying / under attack / out / low ammo / casualties / resupplying / moving
        float x = sp.x + r + 5.f;
        auto pip = [&](ImU32 col) { dl->AddCircleFilled(ImVec2(x, sp.y), 3.f, col, 8); dl->AddCircle(ImVec2(x, sp.y), 3.f, kShadow, 8, 1.f); x += 8.f; };
        const uint32_t f = s.flags;
        if (f & SQ_DEPLOYING) pip(IM_COL32(220, 220, 220, 255));
        if (f & SQ_UNDER_ATTACK) pip(((int)(now_ * 4.0) & 1) ? kBad : IM_COL32(150, 40, 30, 255));
        if (f & SQ_OUT_OF_AMMO) pip(kBad);
        else if (f & SQ_LOW_AMMO) pip(kAmber);
        if (f & SQ_CASUALTIES) {
            dl->AddLine(ImVec2(x - 3, sp.y - 3), ImVec2(x + 3, sp.y + 3), kBad, 2.f);
            dl->AddLine(ImVec2(x - 3, sp.y + 3), ImVec2(x + 3, sp.y - 3), kBad, 2.f);
            x += 8.f;
        }
        if (f & SQ_RESUPPLYING) pip(kBlue);
        if ((f & SQ_MOVING) && !(f & SQ_DEPLOYING)) {
            dl->AddTriangleFilled(ImVec2(x - 3, sp.y - 3), ImVec2(x + 3, sp.y), ImVec2(x - 3, sp.y + 3), kOk);
            x += 8.f;
        }
        if (sel && dist < 120.f) {
            char lab[40];
            std::snprintf(lab, sizeof(lab), "%s %u", squadName(s.type), s.number);
            const ImVec2 ls = ImGui::CalcTextSize(lab);
            dl->AddText(ImVec2(sp.x - ls.x * 0.5f + 1, sp.y - r - ls.y - 1), kShadow, lab);
            dl->AddText(ImVec2(sp.x - ls.x * 0.5f, sp.y - r - ls.y - 2), kSand, lab);
        }
    }
}

void GameUI::drawPreview(AppState& app, const GameContext& ctx) {
    if (ctx.walls) ctx.walls->previewOn = false;
    if (tool_ == Tool::BuildWall) { drawWallPreview(app, ctx); return; }   // B2 (FortUI.cpp)
    if (tool_ == Tool::Select || !ctx.deploy || !ctx.logistics) return;
    V3 p;
    if (forced_) p = forcedPos_;
    else {
        const ImVec2 mp = ImGui::GetIO().MousePos;
        if (ImGui::GetIO().WantCaptureMouse || !pickGround(app, ctx, mp.x, mp.y, p)) return;
    }
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    bool ok = false;
    const char* why = "";
    char label[96];
    int price = 0;
    if (tool_ == Tool::BuyRifle || tool_ == Tool::BuyMG || tool_ == Tool::BuySniper) {
        const SquadType t = tool_ == Tool::BuyRifle ? SquadType::Rifle : tool_ == Tool::BuyMG ? SquadType::MachineGun : SquadType::Sniper;
        DropPlan plan = ctx.deploy->plan(ctx, t, p);
        ok = plan.valid; why = plan.reason; price = plan.price;
        const ImU32 col = ok ? kOk : kBad;
        if (ok)
            for (const V3& l : plan.landing) { groundCircle(dl, app, l, 0.7f, col, 2.f, 16); groundCircle(dl, app, l, 3.0f, withAlpha(col, 0.35f), 1.f, 24); }
        else groundCircle(dl, app, p, 2.0f, col, 2.f);
        std::snprintf(label, sizeof(label), "%s  $%d%s", squadName(t), price, ok && plan.rooftop ? "  (rooftop)" : "");
    } else if (tool_ == Tool::PlaceContainer) {
        ok = ctx.logistics->canPlaceContainer(ctx, p, containerYaw_, &why);
        price = ctx.cfg->economy.containerPrice;
        const float cs = std::cos(containerYaw_), sn = std::sin(containerYaw_);
        const float u[4] = {-4.f, 3.15f, 3.15f, -4.f}, v[4] = {-2.2f, -2.2f, 2.25f, 2.25f};
        ImVec2 q[4];
        bool vis = true;
        for (int k = 0; k < 4; ++k) vis &= project(app, {p.x + u[k] * cs + v[k] * sn, p.y + 0.08f, p.z - u[k] * sn + v[k] * cs}, q[k]);
        if (vis) { dl->AddQuadFilled(q[0], q[1], q[2], q[3], withAlpha(ok ? kOk : kBad, 0.18f)); dl->AddQuad(q[0], q[1], q[2], q[3], ok ? kOk : kBad, 2.f); }
        ImVec2 door;
        if (project(app, {p.x + 4.3f * cs, p.y + 0.08f, p.z - 4.3f * sn}, door)) dl->AddCircleFilled(door, 3.f, ok ? kOk : kBad, 8);
        std::snprintf(label, sizeof(label), "Ammo container  $%d  [Q/E/wheel rotate]", price);
    } else {
        ok = ctx.logistics->canAirdrop(ctx, p, &why);
        price = ctx.cfg->economy.airdropPrice;
        groundCircle(dl, app, p, std::max(1.f, ctx.cfg->logistics.airdropScatter), ok ? kOk : kBad, 2.f);
        groundCircle(dl, app, p, 0.6f, ok ? kOk : kBad, 2.f, 12);
        std::snprintf(label, sizeof(label), "Ammo drop  $%d", price);
    }
    const bool afford = ctx.economy->canAfford(price);
    ImVec2 sp;
    if (!project(app, p, sp)) return;
    const ImU32 col = ok && afford ? kOk : kBad;
    const char* reason = !ok ? why : !afford ? "not enough funding" : "click to confirm";
    dl->AddText(ImVec2(sp.x + 15, sp.y - 21), kShadow, label);
    dl->AddText(ImVec2(sp.x + 14, sp.y - 22), kSand, label);
    dl->AddText(ImVec2(sp.x + 15, sp.y - 5), kShadow, reason);
    dl->AddText(ImVec2(sp.x + 14, sp.y - 6), col, reason);
}

void GameUI::drawNotices(AppState& app, const GameContext& ctx) {
    const ImGuiIO& io = ImGui::GetIO();
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    float y = 44.f;
    for (const UiNotice& n : notices_) {
        const float age = (float)(now_ - n.time);
        if (age > 4.f || age < -1.f) continue;
        const float a = std::clamp(4.f - age, 0.f, 1.f);
        const ImVec2 ts = ImGui::CalcTextSize(n.text.c_str());
        const float x = io.DisplaySize.x * 0.5f - ts.x * 0.5f;
        dl->AddRectFilled(ImVec2(x - 8, y - 3), ImVec2(x + ts.x + 8, y + ts.y + 3), withAlpha(kPanel, a), 3.f);
        dl->AddText(ImVec2(x, y), withAlpha(n.bad ? kBad : kSand, a), n.text.c_str());
        y += ts.y + 10.f;
    }
    // squads outside the simulated window (B1 limitation, GAMEPLAY_ARCHITECTURE 3.6): they hold and do not fire
    if (ctx.horde && ctx.squads && ctx.soldiers) {
        int out = 0;
        for (const Squad& s : ctx.squads->squads) {
            int a = 0;
            V3 c = squadCentre(s, *ctx.soldiers, &a);
            if (a && !ctx.horde->simulated(c.x, c.z)) ++out;
        }
        if (out) {
            char t[96];
            std::snprintf(t, sizeof(t), "%d squad%s outside the simulated area (holding)", out, out > 1 ? "s" : "");
            const ImVec2 ts = ImGui::CalcTextSize(t);
            const float x = io.DisplaySize.x * 0.5f - ts.x * 0.5f;
            dl->AddRectFilled(ImVec2(x - 8, y - 3), ImVec2(x + ts.x + 8, y + ts.y + 3), kPanel, 3.f);
            dl->AddText(ImVec2(x, y), kAmber, t);
        }
    }
}

void GameUI::drawAiDebug(AppState& app, const GameContext& ctx) {
    if (!ctx.soldiers) return;
    const SoldierPool& P = *ctx.soldiers;
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i)) continue;
        ImVec2 s;
        if (!project(app, P.pos[i] + V3{0, 1.9f, 0}, s)) continue;
        const TargetLock& L = P.target[i];
        if (L.active) {   // red: exact lock on a real zombie (GPU nearest list); amber: coarse field sample
            ImVec2 t;
            const bool firing = (P.phase[i] & PH_ACQUIRED) != 0;
            if (project(app, L.pos + V3{0, 1.1f, 0}, t)) {
                const ImU32 c = L.exact ? IM_COL32(255, 70, 50, firing ? 230 : 120) : IM_COL32(255, 190, 60, firing ? 230 : 120);
                dl->AddLine(s, t, c, firing ? 2.f : 1.f);
                dl->AddCircle(t, 5.f, c, 10, 1.5f);
            }
        }
        char txt[64];
        std::snprintf(txt, sizeof(txt), "%s %d/%d st%.0f%s", stateName(P.state[i]), P.mag[i], P.reserve[i], P.stamina[i], P.wounded[i] ? " W" : "");
        dl->AddText(ImVec2(s.x + 6, s.y - 6), IM_COL32(0, 0, 0, 200), txt);
        dl->AddText(ImVec2(s.x + 5, s.y - 7), IM_COL32(230, 235, 200, 255), txt);
    }
}

} // namespace ttz::game
