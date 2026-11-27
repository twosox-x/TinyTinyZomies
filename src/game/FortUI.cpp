// B2 interface (part of GameUI): wall tool input + preview, territory overlay (subtle perimeter outline, region
// labels, breach markers, damaged-wall bars), HUD territory readout, build-bar wall buttons. See GameUI.h.
#include "game/GameUI.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/Fortify.h"
#include "game/NavGrid.h"
#include "game/Territory.h"
#include "game/Walls.h"
#include "imgui.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
const ImU32 kSand = IM_COL32(232, 224, 190, 255), kDim = IM_COL32(170, 166, 140, 255), kOk = IM_COL32(126, 196, 92, 255),
            kBad = IM_COL32(226, 86, 64, 255), kAmber = IM_COL32(232, 178, 64, 255), kShadow = IM_COL32(0, 0, 0, 150);

bool proj(const AppState& app, V3 p, ImVec2& out) {
    float x, y;
    if (!GameUI::worldToScreen(app, p, x, y)) return false;
    out = ImVec2(x, y);
    return true;
}
float groundY(const GameContext& ctx, float x, float z) { return ctx.nav && ctx.nav->ready() ? ctx.nav->surface(x, z) : 0.f; }
ImU32 alpha(ImU32 c, float a) { return (c & 0x00FFFFFFu) | ((ImU32)(std::clamp(a, 0.f, 1.f) * 255.f) << 24); }
ImU32 stateColor(RegionState s) {
    return s == RegionState::Controlled ? kOk : s == RegionState::Threatened ? kBad : s == RegionState::Uncleared ? kAmber : kDim;
}
const char* wallName(uint8_t type, bool gate) { return gate ? (type ? "Reinforced gate" : "Gate") : type ? "Wall 2.4 m" : "Wall 1.6 m"; }
bool ctrlHeld() { return (SDL_GetModState() & SDL_KMOD_CTRL) != 0; }
} // namespace

void GameUI::forceWallPreview(const std::vector<V3>& pts, uint8_t type, bool gate) {
    setWallMode(type, gate);
    if (pts.empty()) return;
    wallPts_.assign(pts.begin(), pts.end() - 1);
    forced_ = true;
    forcedPos_ = pts.back();
}

void GameUI::confirmWall(const AppState& app, const GameContext& ctx, CommandQueue& out) {
    if (wallPts_.size() < 2 || !ctx.walls) { wallPts_.clear(); return; }
    const WallPlan plan = ctx.walls->plan(wallPts_, (WallType)wallType_, wallGate_, makeWallEnv(app, ctx));
    if (!plan.valid) { notify(std::string("Refused: ") + plan.reason, true, now_); return; }   // keep the points: fix / undo
    if (!ctx.economy->canAfford(plan.price)) { notify("Not enough funding", true, now_); return; }
    Command c;
    c.type = CommandType::BuildWall;
    c.path = wallPts_;
    c.wallType = wallType_;
    c.gate = wallGate_;
    out.push(c);
    wallPts_.clear();
}

bool GameUI::wallEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) {
    if (!ctx.walls) return false;
    const Walls& W = *ctx.walls;
    auto snapAt = [&](float sx, float sy, V3& p) {
        V3 g;
        if (!pickGround(app, ctx, sx, sy, g)) return false;
        int node;
        p = W.snap(g, nullptr, true, node);   // a click: existing joint or the 1 m grid
        p.y = groundY(ctx, p.x, p.z);
        return true;
    };
    switch (e.type) {
    case SDL_EVENT_KEY_DOWN: {
        const SDL_Keycode k = e.key.key;
        if (k == SDLK_RETURN || k == SDLK_KP_ENTER) { confirmWall(app, ctx, out); return true; }
        if (k == SDLK_BACKSPACE) { if (!wallPts_.empty()) wallPts_.pop_back(); return true; }
        if (k == SDLK_ESCAPE) {
            if (!wallPts_.empty()) wallPts_.clear();
            else { tool_ = Tool::Select; forced_ = false; }
            return true;
        }
        return false;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN: {
        if (e.button.button != SDL_BUTTON_LEFT || (SDL_GetModState() & SDL_KMOD_ALT)) return false;
        forced_ = false;
        wallDragging_ = false;
        V3 p;
        if (!snapAt(e.button.x, e.button.y, p)) return true;
        wallDown_ = true;
        wallDownX_ = e.button.x; wallDownY_ = e.button.y;
        if (!wallPts_.empty()) {
            const V3& last = wallPts_.back();
            if (std::hypot(p.x - last.x, p.z - last.z) < 0.5f) { confirmWall(app, ctx, out); wallDown_ = false; return true; }   // double click
            const V3& first = wallPts_.front();
            if (wallPts_.size() >= 3 && std::hypot(p.x - first.x, p.z - first.z) < 0.5f) {   // closing the loop
                wallPts_.push_back(first);
                confirmWall(app, ctx, out);
                wallDown_ = false;
                return true;
            }
        }
        wallPts_.push_back(p);
        return true;
    }
    case SDL_EVENT_MOUSE_MOTION:
        if (wallDown_ && std::fabs(e.motion.x - wallDownX_) + std::fabs(e.motion.y - wallDownY_) > 6.f) wallDragging_ = true;
        return false;
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        if (e.button.button != SDL_BUTTON_LEFT || !wallDown_) return false;
        wallDown_ = false;
        if (wallDragging_ && !wallPts_.empty()) {   // drag: a straight run in whole pieces from the press point, built on release
            V3 g;
            if (pickGround(app, ctx, e.button.x, e.button.y, g)) {
                int node;
                V3 p = W.snap(g, &wallPts_.back(), ctrlHeld(), node);
                p.y = groundY(ctx, p.x, p.z);
                if (std::hypot(p.x - wallPts_.back().x, p.z - wallPts_.back().z) > 0.5f) {
                    wallPts_.push_back(p);
                    confirmWall(app, ctx, out);
                }
            }
        }
        wallDragging_ = false;
        return true;
    }
    default: return false;
    }
}

void GameUI::drawWallPreview(AppState& app, const GameContext& ctx) {
    if (!ctx.walls || !ctx.economy) return;
    Walls& W = *ctx.walls;
    V3 cur;
    bool haveCursor = false;
    int node = -1;
    if (forced_) { cur = forcedPos_; haveCursor = true; }
    else {
        const ImVec2 mp = ImGui::GetIO().MousePos;
        V3 g;
        if (!ImGui::GetIO().WantCaptureMouse && pickGround(app, ctx, mp.x, mp.y, g)) {
            const bool drag = wallDown_ && wallDragging_;
            cur = W.snap(g, wallPts_.empty() || !drag ? nullptr : &wallPts_.back(), !drag || ctrlHeld(), node);
            cur.y = groundY(ctx, cur.x, cur.z);
            haveCursor = true;
        }
    }
    std::vector<V3> pts = wallPts_;
    if (haveCursor && (pts.empty() || std::hypot(cur.x - pts.back().x, cur.z - pts.back().z) > 0.3f)) pts.push_back(cur);
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    WallPlan plan;
    if (pts.size() >= 2) plan = W.plan(pts, (WallType)wallType_, wallGate_, makeWallEnv(app, ctx));
    W.preview = plan;
    W.previewOn = pts.size() >= 2;
    const float w = Walls::width((WallType)wallType_);
    for (const WallPlanPiece& q : plan.pieces) {
        const float len = std::hypot(q.bx - q.ax, q.bz - q.az);
        if (len < 1e-3f) continue;
        const float ux = (q.bx - q.ax) / len, uz = (q.bz - q.az) / len, hw = 0.5f * w * std::clamp(len / 4.f, 0.6f, 1.4f);
        const float y = q.y + 0.06f;
        ImVec2 c[4];
        const bool vis = proj(app, {q.ax - uz * hw, y, q.az + ux * hw}, c[0]) && proj(app, {q.bx - uz * hw, y, q.bz + ux * hw}, c[1]) &&
                         proj(app, {q.bx + uz * hw, y, q.bz - ux * hw}, c[2]) && proj(app, {q.ax + uz * hw, y, q.az - ux * hw}, c[3]);
        if (!vis) continue;
        const ImU32 col = q.ok ? kOk : kBad;
        dl->AddQuadFilled(c[0], c[1], c[2], c[3], alpha(col, q.ok ? 0.16f : 0.30f));
        dl->AddQuad(c[0], c[1], c[2], c[3], alpha(col, 0.9f), 1.5f);
    }
    for (size_t k = 0; k < pts.size(); ++k) {   // points; snapped joints ringed
        ImVec2 s;
        if (!proj(app, {pts[k].x, pts[k].y + 0.08f, pts[k].z}, s)) continue;
        const bool onNode = W.nearestNode(pts[k].x, pts[k].z, 0.3f) >= 0;
        dl->AddCircleFilled(s, 3.5f, k + 1 == pts.size() && haveCursor ? kSand : kOk, 10);
        if (onNode) dl->AddCircle(s, 8.f, kSand, 16, 1.5f);
    }
    if (!haveCursor) return;
    ImVec2 sp;
    if (!proj(app, cur, sp)) return;
    char label[128];
    const int pieces = (int)plan.pieces.size();
    if (pieces) std::snprintf(label, sizeof(label), "%s  %.0f m, %d piece%s  $%d", wallName(wallType_, wallGate_), plan.length, pieces, pieces == 1 ? "" : "s", plan.price);
    else std::snprintf(label, sizeof(label), "%s  $%d per 4 m", wallName(wallType_, wallGate_), W.piecePrice((WallType)wallType_, wallGate_));
    const bool afford = ctx.economy->canAfford(plan.price);
    const char* reason = pts.size() < 2 ? "click: start  |  drag: straight run" : !plan.valid ? plan.reason : !afford ? "not enough funding"
                       : "click: add point  |  Enter / double-click: build  |  Backspace: undo";
    const ImU32 col = pts.size() < 2 ? kSand : plan.valid && afford ? kOk : kBad;
    dl->AddText(ImVec2(sp.x + 15, sp.y - 21), kShadow, label);
    dl->AddText(ImVec2(sp.x + 14, sp.y - 22), kSand, label);
    dl->AddText(ImVec2(sp.x + 15, sp.y - 5), kShadow, reason);
    dl->AddText(ImVec2(sp.x + 14, sp.y - 6), col, reason);
}

void GameUI::drawTerritory(AppState& app, const GameContext& ctx) {
    if (!ctx.territory || !ctx.walls) return;
    const Territory& T = *ctx.territory;
    const Walls& W = *ctx.walls;
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    const float dist = app.camera.distance();
    const float pulse = 0.5f + 0.5f * std::sin((float)now_ * 5.f);
    // perimeter: thin outline + a faint band just inside it (never a full-area fill)
    for (const Territory::Edge& e : T.edges()) {
        if (e.slot >= T.regions().size()) continue;
        const Region& r = T.regions()[e.slot];
        const bool hot = r.state == RegionState::Threatened || r.underAttack;
        const ImU32 col = r.underAttack && r.state == RegionState::Controlled ? kAmber : stateColor(r.state);
        const float lineA = hot ? 0.45f + 0.4f * pulse : 0.55f, bandA = hot ? 0.10f + 0.06f * pulse : 0.07f;
        const float len = std::hypot(e.x1 - e.x0, e.z1 - e.z0);
        const int n = std::max(1, (int)std::ceil(len / 6.f));
        for (int k = 0; k < n; ++k) {
            const float t0 = (float)k / n, t1 = (float)(k + 1) / n;
            const float x0 = e.x0 + (e.x1 - e.x0) * t0, z0 = e.z0 + (e.z1 - e.z0) * t0, x1 = e.x0 + (e.x1 - e.x0) * t1, z1 = e.z0 + (e.z1 - e.z0) * t1;
            const float y0 = groundY(ctx, x0 + e.nx * 0.5f, z0 + e.nz * 0.5f) + 0.06f, y1 = groundY(ctx, x1 + e.nx * 0.5f, z1 + e.nz * 0.5f) + 0.06f;
            ImVec2 a, b, c, d;
            if (!proj(app, {x0, y0, z0}, a) || !proj(app, {x1, y1, z1}, b)) continue;
            if (proj(app, {x1 + e.nx * 1.6f, y1, z1 + e.nz * 1.6f}, c) && proj(app, {x0 + e.nx * 1.6f, y0, z0 + e.nz * 1.6f}, d))
                dl->AddQuadFilled(a, b, c, d, alpha(col, bandA));
            dl->AddLine(a, b, alpha(col, lineA), 1.5f);
        }
    }
    // region labels (only when reasonably close: no clutter at strategic zoom)
    if (dist < 260.f)
        for (const Region& r : T.regions()) {
            ImVec2 s;
            if (!proj(app, {r.cx, groundY(ctx, r.cx, r.cz) + 0.3f, r.cz}, s)) continue;
            char t[96];
            if (r.state == RegionState::Controlled) std::snprintf(t, sizeof(t), "%.0f m2  %s", r.area, r.underAttack ? "walls under attack" : "controlled");
            else if (r.state == RegionState::Threatened) std::snprintf(t, sizeof(t), "%d zombie%s inside: income paused", r.zombies, r.zombies == 1 ? "" : "s");
            else if (r.zombies > 0) std::snprintf(t, sizeof(t), "enclosed, %d zombie%s to clear", r.zombies, r.zombies == 1 ? "" : "s");
            else std::snprintf(t, sizeof(t), "enclosed, securing...");
            const ImVec2 ts = ImGui::CalcTextSize(t);
            const ImU32 col = stateColor(r.state);
            dl->AddText(ImVec2(s.x - ts.x * 0.5f + 1, s.y + 1), alpha(kShadow, 0.5f), t);
            dl->AddText(ImVec2(s.x - ts.x * 0.5f, s.y), alpha(col, 0.75f), t);
        }
    // breaches: pulsing marker over fresh rubble
    for (const WallRubble& rb : W.rubble()) {
        if (rb.t > 10.f) continue;
        ImVec2 s;
        if (!proj(app, {rb.box.cx, rb.y + 2.2f, rb.box.cz}, s)) continue;
        const float a = std::clamp(1.f - (rb.t - 7.f) / 3.f, 0.f, 1.f);
        dl->AddCircle(s, 7.f + 3.f * pulse, alpha(kBad, a * (0.5f + 0.5f * pulse)), 16, 2.f);
        dl->AddText(ImVec2(s.x + 11, s.y - 7), alpha(kBad, a), "BREACH");
    }
    // damaged walls: small health bars (close range only)
    if (dist < 180.f)
        for (uint32_t i = 0; i < W.pieces().size(); ++i) {
            const WallPiece& p = W.pieces()[i];
            if (!p.alive || p.hp >= p.maxHp - 0.5f) continue;
            const Obb b = W.pieceBox(i);
            ImVec2 s;
            if (!proj(app, {b.cx, W.nodes()[p.a].y + b.top + 0.5f, b.cz}, s)) continue;
            const float f = std::clamp(p.hp / p.maxHp, 0.f, 1.f), bw = 22.f;
            dl->AddRectFilled(ImVec2(s.x - bw * 0.5f - 1, s.y - 3), ImVec2(s.x + bw * 0.5f + 1, s.y + 3), kShadow);
            dl->AddRectFilled(ImVec2(s.x - bw * 0.5f, s.y - 2), ImVec2(s.x - bw * 0.5f + bw * f, s.y + 2),
                              p.damageRate > 0.5f ? alpha(kBad, 0.6f + 0.4f * pulse) : f > 0.5f ? kOk : kAmber);
        }
}

void GameUI::drawTerritoryHud(const GameContext& ctx) {
    if (!ctx.territory) { ImGui::TextDisabled("-"); return; }
    const Territory& T = *ctx.territory;
    const float ctrl = T.controlledArea();
    int threatened = 0, uncleared = 0;
    for (const Region& r : T.regions()) { threatened += r.state == RegionState::Threatened ? 1 : 0; uncleared += r.state == RegionState::Uncleared ? 1 : 0; }
    if (ctrl >= 10000.f) ImGui::Text("%.2f ha", ctrl / 10000.f);
    else ImGui::Text("%.0f m2", ctrl);
    if (ctx.economy && ctx.economy->territoryPerMinute() > 0) {
        ImGui::SameLine(0, 4);
        ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kOk), "+%.0f/min", ctx.economy->territoryPerMinute());
    }
    if (threatened) { ImGui::SameLine(0, 6); ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kBad), "%d threatened", threatened); }
    if (uncleared) { ImGui::SameLine(0, 6); ImGui::TextColored(ImGui::ColorConvertU32ToFloat4(kAmber), "%d to clear", uncleared); }
    if (ImGui::IsItemHovered() || (!threatened && !uncleared && ImGui::IsItemHovered()))
        ImGui::SetTooltip("Controlled territory: fully enclosed by walls / containers / buildings and cleared of zombies.\n"
                          "Income per controlled area (UNAPPROVED). Zombies inside pause it; after %.0f s the area is lost (PROPOSED).",
                          ctx.cfg ? ctx.cfg->fort.lossTime : 20.f);
}

void GameUI::drawWallButtons(const GameContext& ctx) {
    if (!ctx.walls || !ctx.economy) return;
    const Walls& W = *ctx.walls;
    struct B { uint8_t type; bool gate; const char* name; const char* key; const char* tip; };
    const B items[3] = {
        {0, false, "Wall 1.6 m", "N", "Cheap gabion wall (1.6 m). Zombies can climb over corpse piles against it.\nClick points or drag a straight run; Enter builds. Price per 4 m piece."},
        {1, false, "Wall 2.4 m", "M", "Reinforced gabion wall (2.4 m, more health). Stops most climbing.\nClick points or drag a straight run; Enter builds. Price per 4 m piece."},
        {0, true, "Gate", "J", "PROPOSED (owner approval pending): soldiers pass, zombies do not;\ncounts as closed for territory. Price per 4 m gate."},
    };
    ImDrawList* dl = ImGui::GetWindowDrawList();
    for (int k = 0; k < 3; ++k) {
        const B& b = items[k];
        const int price = W.piecePrice((WallType)b.type, b.gate);
        ImGui::SameLine();
        const bool afford = ctx.economy->canAfford(price), active = tool_ == Tool::BuildWall && wallType_ == b.type && wallGate_ == b.gate;
        ImGui::PushID(100 + k);
        if (active) ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.50f, 0.46f, 0.24f, 1.f));
        if (!afford) ImGui::BeginDisabled();
        char label[64];
        std::snprintf(label, sizeof(label), "     %s\n     $%d/4m [%s]", b.name, price, b.key);
        const ImVec2 p0 = ImGui::GetCursorScreenPos();
        if (ImGui::Button(label, ImVec2(0, 0))) { if (active) { tool_ = Tool::Select; wallPts_.clear(); } else setWallMode(b.type, b.gate); }
        if (!afford) ImGui::EndDisabled();
        if (active) ImGui::PopStyleColor();
        if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) ImGui::SetTooltip("%s%s", b.tip, afford ? "" : "\nNot enough funding.");
        const ImVec2 sz = ImGui::GetItemRectSize();
        const ImVec2 ic(p0.x + 14.f, p0.y + sz.y * 0.5f);
        const ImU32 fc = afford ? IM_COL32(150, 156, 98, 255) : IM_COL32(90, 90, 80, 255);
        const float h = b.type ? 6.f : 4.f;
        if (!b.gate) { dl->AddRectFilled(ImVec2(ic.x - 8, ic.y + 4 - 2 * h), ImVec2(ic.x + 8, ic.y + 4), fc, 1.f); dl->AddLine(ImVec2(ic.x, ic.y + 4 - 2 * h), ImVec2(ic.x, ic.y + 4), IM_COL32(20, 22, 14, 255), 1.f); }
        else { dl->AddRectFilled(ImVec2(ic.x - 8, ic.y - 6), ImVec2(ic.x - 5, ic.y + 4), fc); dl->AddRectFilled(ImVec2(ic.x + 5, ic.y - 6), ImVec2(ic.x + 8, ic.y + 4), fc); dl->AddLine(ImVec2(ic.x - 5, ic.y - 3), ImVec2(ic.x + 5, ic.y - 3), fc, 1.5f); }
        ImGui::PopID();
    }
}

} // namespace ttz::game
