// B2 interface (part of GameUI): wall tool input + preview, territory overlay (subtle perimeter outline, region
// labels, breach markers, damaged-wall bars), HUD territory readout, build-bar wall buttons. See GameUI.h.
#include "game/GameUI.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/EngineerAI.h"
#include "game/Fortify.h"
#include "game/NavGrid.h"
#include "game/Territory.h"
#include "game/Walls.h"
#include "imgui.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

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
bool shiftHeld() { return (SDL_GetModState() & SDL_KMOD_SHIFT) != 0; }
constexpr float kPi = 3.14159265f;
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

// Direction snapping of a leg from -> to: Shift forces 15 deg steps; otherwise 0 / 45 / 90 deg snap magnetically within
// 4 deg. Angles are relative to the previous leg, else to the wall piece the leg starts on, else to the world axes.
// The length is kept (0.5 m steps once snapped).
V3 GameUI::angleSnap(const GameContext& ctx, V3 from, V3 to, bool force) const {
    const float dx = to.x - from.x, dz = to.z - from.z, L = std::hypot(dx, dz);
    if (L < 0.5f) return to;
    float ref = 0.f;
    if (wallPts_.size() >= 2) {
        const V3& a = wallPts_[wallPts_.size() - 2];
        ref = std::atan2(from.z - a.z, from.x - a.x);
    } else if (ctx.walls) {
        const Walls& W = *ctx.walls;
        const int p = W.nearestPiece(from.x, from.z, 0.6f);
        if (p >= 0) { const WallNode &a = W.nodes()[W.pieces()[(size_t)p].a], &b = W.nodes()[W.pieces()[(size_t)p].b]; ref = std::atan2(b.z - a.z, b.x - a.x); }
    }
    const float ang = std::atan2(dz, dx) - ref;
    const float step = force ? kPi / 12.f : kPi / 4.f;
    const float snapped = std::round(ang / step) * step;
    if (!force && std::fabs(snapped - ang) > 4.f * kPi / 180.f) return to;
    const float a = ref + snapped, l = std::max(Walls::kGrid, std::round(L / Walls::kGrid) * Walls::kGrid);
    return {from.x + std::cos(a) * l, to.y, from.z + std::sin(a) * l};
}

bool GameUI::wallEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) {
    if (!ctx.walls) return false;
    const Walls& W = *ctx.walls;
    auto snapAt = [&](float sx, float sy, V3& p) {
        V3 g;
        if (!pickGround(app, ctx, sx, sy, g)) return false;
        int node, piece;
        p = W.snap(g, nullptr, true, node, &piece);   // a click: existing joint, a point on a wall (T), or the 0.5 m grid
        if (node < 0 && piece < 0 && !wallPts_.empty()) p = angleSnap(ctx, wallPts_.back(), p, shiftHeld());
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
                int node, piece;
                V3 p = W.snap(g, &wallPts_.back(), ctrlHeld(), node, &piece);
                if (node < 0 && piece < 0) p = angleSnap(ctx, wallPts_.back(), p, shiftHeld());
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

// ---- 14d: engineers, single gates, car clearing, Ctrl+Z ------------------------------------------------------------
bool GameUI::constructionKey(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) {
    const bool gateMode = tool_ == Tool::BuildWall && wallGate_ && wallPts_.empty();
    if (e.type == SDL_EVENT_KEY_DOWN && !e.key.repeat) {
        const SDL_Keycode k = e.key.key;
        if (k == SDLK_Z && ctrlHeld()) { Command c; c.type = CommandType::UndoBuild; out.push(c); return true; }
        // U / K / J (and N / M) are registered command-bar actions (registerFortActions, GameUI::actionHotkey)
        if (gateMode && (k == SDLK_Q || k == SDLK_E)) { gateYaw_ = std::fmod(gateYaw_ + (k == SDLK_E ? 1.f : -1.f) * kPi / 12.f + 2.f * kPi, 2.f * kPi); return true; }
        if (gateMode && k == SDLK_T) { gateYaw_ = std::fmod(gateYaw_ + kPi / 2.f, 2.f * kPi); return true; }
        return false;
    }
    if (gateMode && e.type == SDL_EVENT_MOUSE_WHEEL && e.wheel.y != 0.f) {
        gateYaw_ = std::fmod(gateYaw_ + (e.wheel.y > 0 ? 1.f : -1.f) * kPi / 12.f + 2.f * kPi, 2.f * kPi);
        return true;
    }
    if (gateMode && e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && e.button.button == SDL_BUTTON_LEFT && !(SDL_GetModState() & SDL_KMOD_ALT) && ctx.walls) {
        forced_ = false;
        V3 p;
        if (!pickGround(app, ctx, e.button.x, e.button.y, p)) return true;
        const WallPlan plan = ctx.walls->planGate(p, gateYaw_, (WallType)wallType_, makeWallEnv(app, ctx));
        if (!plan.valid) { notify(std::string("Refused: ") + plan.reason, true, now_); return true; }
        if (!ctx.economy->canAfford(plan.price)) { notify("Not enough funding", true, now_); return true; }
        Command c;
        c.type = CommandType::BuildGate;
        c.pos = p;
        c.facing = gateYaw_;
        c.wallType = wallType_;
        out.push(c);
        return true;
    }
    return false;
}

bool GameUI::clearCarCheck(const AppState& app, const GameContext& ctx, V3 p, const char** why) const {
    const uint32_t v = app.vehicles.parkedAt(p.x, p.z, ctx.cfg->engineer.carSearch);
    if (v == UINT32_MAX) { *why = "click a parked vehicle"; return false; }
    if (ctx.engineers && ctx.engineers->carOrdered(v)) { *why = "already being cleared"; return false; }
    float cx, cz, hx, hz, yaw;
    app.vehicles.groundBox(v, cx, cz, hx, hz, yaw);
    if (ctx.engineers && !ctx.engineers->inRange(ctx, cx, cz)) { *why = ctx.engineers->anyEngineers(ctx) ? "outside engineer range" : "no engineers: buy engineers first [U]"; return false; }
    return true;
}

namespace {
void obbOutline(ImDrawList* dl, const AppState& app, const Obb& b, float y, ImU32 col, float fillA, float thick) {
    ImVec2 c[4];
    const float u[4] = {-b.hx, b.hx, b.hx, -b.hx}, v[4] = {-b.hz, -b.hz, b.hz, b.hz};
    for (int k = 0; k < 4; ++k) { float x, z; b.at(u[k], v[k], x, z); if (!proj(app, {x, y, z}, c[k])) return; }
    if (fillA > 0.f) dl->AddQuadFilled(c[0], c[1], c[2], c[3], alpha(col, fillA));
    dl->AddQuad(c[0], c[1], c[2], c[3], alpha(col, 0.9f), thick);
}
// cursor label (decluttered world labels): the name / price line, and the status line unless it is a control hint
// (hints live in the placement banner, HudBar.cpp)
void label2(GameUI& ui, ImVec2 sp, const char* top, ImU32 topCol, const char* bottom, ImU32 botCol) {
    ui.worldLabel(sp.x + 14, sp.y - 24, top, topCol, GameUI::kLabelCursor);
    if (bottom && *bottom && !std::strchr(bottom, '|')) ui.worldLabel(sp.x + 14, sp.y - 6, bottom, botCol, GameUI::kLabelCursor);
}
} // namespace

void GameUI::drawEngineerZones(AppState& app, const GameContext& ctx) {
    if (!ctx.engineers || ctx.engineers->instantBuild) return;
    std::vector<EngineerAI::Zone> zs;
    ctx.engineers->zones(ctx, zs);
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    // GAME_DESIGN 14e ("the engineer radius ring is all messed up"): the old ring was 72 dashes at the walk surface, so
    // it jumped onto car roofs, walls and building tops. Now: a smooth anti-aliased circle (192 segments, fixed pixel
    // width at every zoom) draped over the street (base ground, kerbs smoothed, never vehicles / walls); where it passes
    // through a building it is drawn faint at street level (hidden-line style) instead of climbing the facade.
    // Several engineer squads: the union outline (arcs inside another squad's zone are left out) and ONE label.
    const float street = windowStreetLevel(app);
    bool labelled = false;
    for (const EngineerAI::Zone& z : zs) {
        constexpr int n = 192;
        float hy[n];
        bool inside[n], covered[n];
        for (int k = 0; k < n; ++k) {
            const float a = (float)k * 2.f * kPi / (float)n;
            const float x = z.c.x + std::cos(a) * z.r, zz = z.c.z + std::sin(a) * z.r;
            const float g = app.vehicles.groundAt(x, zz);
            inside[k] = g > street + 0.9f;
            covered[k] = false;
            for (const EngineerAI::Zone& o : zs)
                if (&o != &z && std::hypot(x - o.c.x, zz - o.c.z) < o.r - 0.05f) covered[k] = true;
            hy[k] = inside[k] ? street : std::clamp(g, street - 3.f, street + 0.9f);
        }
        float sm[n];
        for (int k = 0; k < n; ++k) {   // smooth kerbs / grid steps (5 taps)
            float acc = 0.f;
            for (int d = -2; d <= 2; ++d) acc += hy[(k + d + n) % n];
            sm[k] = acc / 5.f + 0.12f;
        }
        for (int pass = 0; pass < 3; ++pass) {   // 0: dark underlay, 1: visible ring, 2: faint through buildings
            const float th = pass == 0 ? 4.f : pass == 1 ? 2.f : 1.2f;
            const ImU32 col = pass == 0 ? IM_COL32(0, 0, 0, 90) : pass == 1 ? alpha(kAmber, 0.85f) : alpha(kAmber, 0.3f);
            std::vector<ImVec2> run;
            auto flush = [&]() { if (run.size() >= 2) dl->AddPolyline(run.data(), (int)run.size(), col, 0, th); run.clear(); };
            for (int k = 0; k <= n; ++k) {
                const int kk = k % n;
                const float a = (float)kk * 2.f * kPi / (float)n;
                ImVec2 sp;
                const bool want = pass == 2 ? (inside[kk] || inside[(kk + 1) % n] || inside[(kk + n - 1) % n]) : !inside[kk];
                if (want && !covered[kk] && proj(app, {z.c.x + std::cos(a) * z.r, sm[kk], z.c.z + std::sin(a) * z.r}, sp)) run.push_back(sp);
                else flush();
            }
            flush();
        }
        ImVec2 s;
        if (proj(app, {z.c.x, z.c.y + 0.2f, z.c.z}, s)) {
            dl->AddCircle(s, 4.f, alpha(kAmber, 0.7f), 16, 1.5f);   // each squad's post
            if (!labelled) {
                labelled = true;
                worldLabel(s.x + 7, s.y + 1, "build radius", alpha(kAmber, 0.8f), kLabelInfo);
            }
        }
    }
}

void GameUI::drawConstruction(AppState& app, const GameContext& ctx) {
    if (!ctx.engineers || !ctx.walls) return;
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    const bool close = app.camera.distance() < 200.f;
    for (const EngineerAI::Job& j : ctx.engineers->jobs()) {
        float y = groundY(ctx, j.box.cx, j.box.cz);
        if (j.kind == EngineerAI::JobKind::Car) obbOutline(dl, app, j.box, y + 0.08f, kAmber, 0.10f, 1.5f);
        else if (j.kind == EngineerAI::JobKind::Piece) obbOutline(dl, app, j.box, y + 0.06f, j.inRange ? kSand : kBad, 0.0f, 1.f);
        ImVec2 s;
        if (!proj(app, {j.box.cx, y + (j.kind == EngineerAI::JobKind::Car ? 2.4f : 2.6f), j.box.cz}, s)) continue;
        const float bw = 26.f, f = std::clamp(j.progress, 0.f, 1.f);
        const ImU32 col = !j.inRange ? kBad : j.blocked ? kDim : j.workers > 0 ? kOk : kAmber;
        dl->AddRectFilled(ImVec2(s.x - bw * 0.5f - 1, s.y - 3), ImVec2(s.x + bw * 0.5f + 1, s.y + 3), kShadow);
        dl->AddRectFilled(ImVec2(s.x - bw * 0.5f, s.y - 2), ImVec2(s.x - bw * 0.5f + bw * f, s.y + 2), col);
        if (!close) continue;
        const char* t = !j.inRange ? "no engineers in range" : j.blocked ? "waits for the car" : j.workers > 0 ? nullptr
                      : j.kind == EngineerAI::JobKind::Car ? "car: waiting" : "queued";
        if (j.kind == EngineerAI::JobKind::Car && j.workers > 0) t = "clearing car";
        if (j.kind == EngineerAI::JobKind::GateConvert && j.workers > 0) t = "fitting gate";
        if (t) worldLabel(s.x + bw * 0.5f + 4, s.y - 8, t, alpha(col, 0.9f), kLabelStatus);
    }
}

void GameUI::drawClearPreview(AppState& app, const GameContext& ctx) {
    drawEngineerZones(app, ctx);
    V3 p;
    if (forced_) p = forcedPos_;
    else {
        const ImVec2 mp = ImGui::GetIO().MousePos;
        if (ImGui::GetIO().WantCaptureMouse || !pickGround(app, ctx, mp.x, mp.y, p)) return;
    }
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    const char* why = "";
    const bool ok = clearCarCheck(app, ctx, p, &why);
    const uint32_t v = app.vehicles.parkedAt(p.x, p.z, ctx.cfg->engineer.carSearch);
    if (v != UINT32_MAX) {
        Obb b;
        app.vehicles.groundBox(v, b.cx, b.cz, b.hx, b.hz, b.yaw);
        obbOutline(dl, app, b, groundY(ctx, b.cx, b.cz) + 0.1f, ok ? kOk : kBad, 0.2f, 2.f);
    }
    const int price = ctx.cfg->engineer.carPrice;
    const bool afford = ctx.economy->canAfford(price);
    ImVec2 sp;
    if (!proj(app, p, sp)) return;
    char top[96];
    std::snprintf(top, sizeof(top), "Clear vehicle  $%d  (engineers tow it away)", price);
    label2(*this, sp, top, kSand, !ok ? why : !afford ? "not enough funding" : "click: order  |  Shift: keep the tool", ok && afford ? kOk : kBad);
}

void GameUI::drawWallPreview(AppState& app, const GameContext& ctx) {
    if (!ctx.walls || !ctx.economy) return;
    Walls& W = *ctx.walls;
    drawEngineerZones(app, ctx);
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    const WallEnv env = makeWallEnv(app, ctx);
    V3 cur;
    bool haveCursor = false;
    int node = -1, onPiece = -1;
    if (forced_) { cur = forcedPos_; haveCursor = true; }
    else {
        const ImVec2 mp = ImGui::GetIO().MousePos;
        V3 g;
        if (!ImGui::GetIO().WantCaptureMouse && pickGround(app, ctx, mp.x, mp.y, g)) {
            const bool drag = wallDown_ && wallDragging_;
            if (wallGate_ && wallPts_.empty()) cur = g;   // single gate: free position (planGate aligns / snaps)
            else {
                cur = W.snap(g, wallPts_.empty() || !drag ? nullptr : &wallPts_.back(), !drag || ctrlHeld(), node, &onPiece);
                if (node < 0 && onPiece < 0 && !wallPts_.empty()) cur = angleSnap(ctx, wallPts_.back(), cur, shiftHeld());
            }
            cur.y = groundY(ctx, cur.x, cur.z);
            haveCursor = true;
        }
    }
    // ---- single gate placement (J): aligned into a wall / continuing a wall end / on its own
    if (wallGate_ && wallPts_.empty()) {
        if (!haveCursor) return;
        const WallPlan plan = W.planGate(cur, gateYaw_, (WallType)wallType_, env);
        W.preview = plan;
        W.previewOn = !plan.pieces.empty();
        for (const WallPlanPiece& q : plan.pieces) {
            const Obb b{0.5f * (q.ax + q.bx), 0.5f * (q.az + q.bz), 0.5f * std::hypot(q.bx - q.ax, q.bz - q.az), 0.5f * Walls::width(plan.type), std::atan2(-(q.bz - q.az), q.bx - q.ax), 0.f};
            obbOutline(dl, app, b, q.y + 0.06f, q.ok ? kOk : kBad, q.ok ? 0.16f : 0.3f, 2.f);
        }
        ImVec2 sp;
        if (!proj(app, cur, sp)) return;
        char top[128];
        std::snprintf(top, sizeof(top), "%s  $%d%s", plan.type == WallType::Reinforced ? "Reinforced gate" : "Gate", plan.price,
                      plan.replacePiece >= 0 ? "  (replaces this wall part)" : "");
        const bool afford = ctx.economy->canAfford(plan.price);
        label2(*this, sp, top, kSand, !plan.valid ? plan.reason : !afford ? "not enough funding" : "click: place  |  Q / E / wheel: rotate 15 deg, T: 90  |  Ctrl+Z: undo",
               plan.valid && afford ? kOk : kBad);
        return;
    }
    std::vector<V3> pts = wallPts_;
    if (haveCursor && (pts.empty() || std::hypot(cur.x - pts.back().x, cur.z - pts.back().z) > 0.3f)) pts.push_back(cur);
    // ---- guides: 0.5 m grid around the cursor, the leg's direction extended, the previous leg's axis
    if (haveCursor) {
        // 0.5 m grid (GAME_DESIGN 14e: finer); whole metres a little brighter
        const float gx = std::round(cur.x), gz = std::round(cur.z), y = cur.y + 0.04f;
        for (int k = -8; k <= 8; ++k) {
            ImVec2 a, b;
            const float o = 0.5f * (float)k;
            const float fa = (k % 2 == 0 ? 0.2f : 0.1f) * (1.f - std::fabs(o) / 4.6f);
            if (proj(app, {gx + o, y, gz - 4.f}, a) && proj(app, {gx + o, y, gz + 4.f}, b)) dl->AddLine(a, b, alpha(kSand, fa), 1.f);
            if (proj(app, {gx - 4.f, y, gz + o}, a) && proj(app, {gx + 4.f, y, gz + o}, b)) dl->AddLine(a, b, alpha(kSand, fa), 1.f);
        }
        if (!wallPts_.empty()) {
            const V3 a = wallPts_.back();
            const float dx = cur.x - a.x, dz = cur.z - a.z, L = std::hypot(dx, dz);
            if (L > 0.5f) {
                ImVec2 s0, s1;
                for (int k = 0; k < 12; ++k) {   // dashed extension past the cursor
                    const float t0 = L + 1.f + 2.f * k, t1 = t0 + 1.f;
                    if (proj(app, {a.x + dx * t0 / L, y, a.z + dz * t0 / L}, s0) && proj(app, {a.x + dx * t1 / L, y, a.z + dz * t1 / L}, s1))
                        dl->AddLine(s0, s1, alpha(kSand, 0.35f * (1.f - k / 12.f)), 1.f);
                }
                const float ang = std::atan2(dz, dx) * 180.f / kPi;
                ImVec2 m;
                if (proj(app, {a.x + dx * 0.5f, y, a.z + dz * 0.5f}, m)) {
                    char t[48];
                    std::snprintf(t, sizeof(t), "%.1f m  %.0f deg", L, ang < 0 ? ang + 360.f : ang);
                    worldLabel(m.x, m.y + 8, t, alpha(kSand, 0.95f), kLabelCursor - 5, true);
                }
            }
        }
    }
    WallPlan plan;
    if (pts.size() >= 2) plan = W.plan(pts, (WallType)wallType_, wallGate_, env);
    W.preview = plan;
    W.previewOn = pts.size() >= 2;
    const float w = Walls::width((WallType)wallType_);
    bool loopShown = false;
    for (const WallPlanPiece& q : plan.pieces) {   // every piece: green ok / red conflict (its own reason) / amber after a car
        const float len = std::hypot(q.bx - q.ax, q.bz - q.az);
        if (len < 1e-3f) continue;
        const float ux = (q.bx - q.ax) / len, uz = (q.bz - q.az) / len, hw = 0.5f * w * std::clamp(len / 4.f, 1.f, 1.4f);
        const float y = q.y + 0.06f;
        ImVec2 c[4];
        const bool vis = proj(app, {q.ax - uz * hw, y, q.az + ux * hw}, c[0]) && proj(app, {q.bx - uz * hw, y, q.bz + ux * hw}, c[1]) &&
                         proj(app, {q.bx + uz * hw, y, q.bz - ux * hw}, c[2]) && proj(app, {q.ax + uz * hw, y, q.az - ux * hw}, c[3]);
        if (!vis) continue;
        const ImU32 col = !q.ok ? kBad : q.clearing ? kAmber : kOk;
        dl->AddQuadFilled(c[0], c[1], c[2], c[3], alpha(col, q.ok ? 0.16f : 0.30f));
        dl->AddQuad(c[0], c[1], c[2], c[3], alpha(col, 0.9f), 1.5f);
        if (q.closesLoop && q.ok) dl->AddQuad(c[0], c[1], c[2], c[3], alpha(IM_COL32(110, 200, 230, 255), 0.95f), 2.5f);
        ImVec2 m;
        if (!proj(app, {0.5f * (q.ax + q.bx), y + 0.3f, 0.5f * (q.az + q.bz)}, m)) continue;
        const char* t = !q.ok ? q.why : q.clearing ? "after the car is cleared" : q.closesLoop && !loopShown ? "closes the loop" : q.fill ? "fill piece" : nullptr;
        if (q.closesLoop && q.ok) loopShown = true;
        if (t) {
            const ImVec2 ts = ImGui::CalcTextSize(t);
            (void)ts;
            worldLabel(m.x, m.y, t, !q.ok ? kBad : q.closesLoop ? IM_COL32(150, 215, 240, 255) : alpha(kSand, 0.9f), q.ok ? kLabelStatus + 5 : kLabelCursor - 10, true);
        }
    }
    for (size_t k = 0; k < pts.size(); ++k) {   // points; snapped joints ringed, T junctions on a wall marked
        ImVec2 s;
        if (!proj(app, {pts[k].x, pts[k].y + 0.08f, pts[k].z}, s)) continue;
        const bool onNode = W.nearestNode(pts[k].x, pts[k].z, 0.3f) >= 0;
        const bool onWall = !onNode && W.pieceAt(pts[k].x, pts[k].z, 0.3f) >= 0;
        dl->AddCircleFilled(s, 3.5f, k + 1 == pts.size() && haveCursor ? kSand : kOk, 10);
        if (onNode) dl->AddCircle(s, 8.f, kSand, 16, 1.5f);
        if (onWall) dl->AddQuad(ImVec2(s.x, s.y - 9), ImVec2(s.x + 9, s.y), ImVec2(s.x, s.y + 9), ImVec2(s.x - 9, s.y), kSand, 1.5f);
    }
    if (!haveCursor) return;
    ImVec2 sp;
    if (!proj(app, cur, sp)) return;
    char label[160];
    const int pieces = (int)plan.pieces.size();
    int fills = 0;
    for (const WallPlanPiece& q : plan.pieces) fills += q.fill ? 1 : 0;
    if (pieces) std::snprintf(label, sizeof(label), "%s  %.0f m, %d piece%s%s  $%d%s%s", wallName(wallType_, wallGate_), plan.length, pieces, pieces == 1 ? "" : "s",
                              fills ? " (incl. fill)" : "", plan.price, plan.closesLoop ? "  - closes a loop" : "", plan.trimmed ? "  - butts on the facade" : "");
    else std::snprintf(label, sizeof(label), "%s  $%d per 4 m%s", wallName(wallType_, wallGate_), W.piecePrice((WallType)wallType_, wallGate_),
                       onPiece >= 0 ? "  - T junction on this wall" : node >= 0 ? "  - joins this joint" : "");
    const bool afford = ctx.economy->canAfford(plan.price);
    const char* reason = pts.size() < 2 ? "click: start  |  drag: straight run (Ctrl: 1 m)  |  Shift: 15 deg" : !plan.valid ? plan.reason : !afford ? "not enough funding"
                       : "click: add point  |  Enter / double-click: build  |  Backspace: point  |  Ctrl+Z: undo placement";
    label2(*this, sp, label, kSand, reason, pts.size() < 2 ? kSand : plan.valid && afford ? kOk : kBad);
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
            (void)ts;
            worldLabel(s.x, s.y, t, alpha(col, 0.85f), r.state == RegionState::Threatened ? kLabelAlert - 5 : kLabelInfo, true);
        }
    drawConstruction(app, ctx);   // 14d: blueprints / car orders: progress bars, waiting reasons
    // breaches: pulsing marker over fresh rubble
    for (const WallRubble& rb : W.rubble()) {
        if (rb.t > 10.f) continue;
        ImVec2 s;
        if (!proj(app, {rb.box.cx, rb.y + 2.2f, rb.box.cz}, s)) continue;
        const float a = std::clamp(1.f - (rb.t - 7.f) / 3.f, 0.f, 1.f);
        dl->AddCircle(s, 7.f + 3.f * pulse, alpha(kBad, a * (0.5f + 0.5f * pulse)), 16, 2.f);
        worldLabel(s.x + 11, s.y - 7, "BREACH", alpha(kBad, a), kLabelAlert);
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

void GameUI::registerFortActions() {
    auto has = [&](const char* id) { for (const UiAction& a : actions_) if (a.id == id) return true; return false; };
    // ---- Structures: walls and gate (wall tool, FortUI wallEvent / constructionKey)
    struct Wd { const char* id; const char* label; uint8_t type; bool gate; int key; UiIcon icon; int order; const char* tip; };
    const Wd walls[3] = {
        {"struct.wall", "Wall 1.6 m", 0, false, SDLK_N, UiIcon::Wall, 10,
         "Cheap gabion wall (1.6 m). Zombies can climb over corpse piles against it.\nClick points (snap to joints / onto walls / 1 m grid) or drag a straight run;\n"
         "Engineers build it within their radius. Price per 4 m piece."},
        {"struct.wall2", "Wall 2.4 m", 1, false, SDLK_M, UiIcon::WallTall, 20,
         "Reinforced gabion wall (2.4 m, more health). Stops most climbing.\nSame controls as the 1.6 m wall. Price per 4 m piece."},
        {"struct.gate", "Gate", 0, true, SDLK_J, UiIcon::Gate, 30,
         "Gate (PROPOSED): soldiers pass, zombies do not; counts as closed for territory.\nOne 4 m gate per click. Over a wall it replaces that part;\n"
         "next to a wall end it continues the wall. Engineers fit it."},
    };
    for (const Wd& w : walls) {
        if (has(w.id)) continue;
        UiAction a;
        a.id = w.id; a.category = UiCategory::Structures; a.label = w.label; a.icon = w.icon; a.hotkey = w.key; a.order = w.order;
        a.costSuffix = "/4m";
        const uint8_t type = w.type;
        const bool gate = w.gate;
        a.cost = [type, gate](const UiCtx& u) { return u.ctx.walls ? u.ctx.walls->piecePrice((WallType)type, gate) : -1; };
        a.onSelect = [type, gate](const UiCtx& u) {
            GameUI& ui = u.ui;
            if (ui.tool() == Tool::BuildWall && ui.wallType_ == type && ui.wallGate_ == gate) { ui.tool_ = Tool::Select; ui.wallPts_.clear(); }
            else ui.setWallMode(type, gate);
        };
        a.active = [type, gate](const UiCtx& u) { return u.ui.tool() == Tool::BuildWall && u.ui.wallType_ == type && u.ui.wallGate_ == gate; };
        const std::string tip = w.tip;
        a.tooltip = [tip](const UiCtx&) { return tip; };
        a.placementHint = [gate](const UiCtx& u) {
            if (gate && u.ui.wallPts_.empty()) return std::string("LMB: place  |  Q / E / wheel: rotate 15 deg, T: 90  |  Ctrl+Z: undo  |  Esc: cancel");
            return std::string("LMB: add point  |  drag: straight run (Ctrl: 1 m)  |  Shift: 15 deg  |  Enter: build  |  Backspace: point  |  Esc: cancel");
        };
        a.enabled = [](const UiCtx& u, std::string* why) {
            if (u.ctx.engineers && !u.ctx.engineers->instantBuild && !u.ctx.engineers->anyEngineers(u.ctx)) { if (why) *why = "Needs engineers: buy engineers first [U]"; }
            return true;   // the tool still opens (the preview shows the engineer radius / refusal)
        };
        registerAction(std::move(a));
    }
    // ---- Engineering: clear car, undo
    if (!has("eng.clearcar")) {
        UiAction a;
        a.id = "eng.clearcar"; a.category = UiCategory::Engineering; a.label = "Clear car"; a.icon = UiIcon::ClearCar; a.hotkey = SDLK_K; a.order = 10;
        a.cost = [](const UiCtx& u) { return u.ctx.cfg->engineer.carPrice; };
        a.onSelect = [](const UiCtx& u) { u.ui.setTool(u.ui.tool() == Tool::ClearCar ? Tool::Select : Tool::ClearCar); u.ui.clearForcedFlag(); };
        a.active = [](const UiCtx& u) { return u.ui.tool() == Tool::ClearCar; };
        a.tooltip = [](const UiCtx&) { return std::string("Engineers tow / dismantle a parked vehicle (click it). Within their radius; takes time.\n"
                                                          "Walls may be planned through a car being cleared: they are built once it is gone.\n"
                                                          "Tip: with engineers selected, hover a car for its menu."); };
        a.placementHint = [](const UiCtx&) { return std::string("LMB: a parked vehicle  |  Shift: keep the tool  |  RMB / Esc: cancel"); };
        registerAction(std::move(a));
    }
    if (!has("eng.undo")) {
        UiAction a;
        a.id = "eng.undo"; a.category = UiCategory::Engineering; a.label = "Undo build"; a.icon = UiIcon::Undo; a.hotkeyLabel = "Ctrl+Z"; a.order = 90;
        a.onSelect = [](const UiCtx& u) { Command c; c.type = CommandType::UndoBuild; u.out.push(c); };
        a.tooltip = [](const UiCtx&) { return std::string("Removes the unfinished pieces of the newest placement (refunded)."); };
        registerAction(std::move(a));
    }
}

} // namespace ttz::game
