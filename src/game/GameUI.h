#pragma once
// RTS interface (WS-D), Dear ImGui styled for the miniature look (GAME_DESIGN 11 / 14b), drawn after the 3D scene.
// B1 essentials:
//   top bar     : funding, income / min, kills, (territory: B2), "UNAPPROVED balance" tag while cfg.status says so
//   purchase    : rifle / MG / sniper squad, ammo container, airdrop (price, disabled when unaffordable)
//   selection   : selected squad(s): composition, per-soldier health and ammo bars, state
//   markers     : screen-space squad markers over each squad (class glyph so MG squads read at 100-150 m, status
//                 icons: low / out of ammo, casualties, moving, resupplying, under attack), drawn on the ImGui
//                 background draw list, culled and size-clamped
//   previews    : drop / container / airdrop placement ring projected on the ground, green / red with the refusal
//                 reason (Deploy::plan, Logistics::can*)
//   input       : produces Commands only (CommandQueue); never mutates game state directly
// Minimal clutter: no panels besides these; the debug panel (F1) stays available.
//
// Hotkeys (--game): Z rifle squad, X MG squad, C sniper, V ammo container, B ammo airdrop, T rotate the container,
// H halt (stop) the selection, Tab next squad, 1..9 select squad N, Esc cancel tool / clear selection.
#include "game/Commands.h"
#include "game/GameContext.h"

#include <string>
#include <vector>

union SDL_Event;

namespace ttz {
struct AppState;
}

namespace ttz::game {

enum class Tool : uint8_t { Select, BuyRifle, BuyMG, BuySniper, PlaceContainer, Airdrop };

struct UiNotice { std::string text; double time = 0; bool bad = false; };

class GameUI {
public:
    // Input first (App::handleEvent forwards here before its own handling). True = consumed.
    bool handleEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);
    void draw(AppState& app, const GameContext& ctx, CommandQueue& out);
    Selection& selection() { return sel_; }
    Tool tool() const { return tool_; }
    void setTool(Tool t) { tool_ = t; }
    void notify(const std::string& text, bool bad, double time);
    // Scripted previews / captures: show the placement preview of `t` at a world point (no mouse needed).
    void forcePreview(Tool t, V3 pos) { tool_ = t; forced_ = true; forcedPos_ = pos; }
    void clearForcedPreview() { forced_ = false; tool_ = Tool::Select; }
    // Height-grid pick (street, roof) under a screen point; false when the ray leaves the grid.
    static bool pickGround(const AppState& app, const GameContext& ctx, float sx, float sy, V3& out);
    static bool worldToScreen(const AppState& app, V3 p, float& sx, float& sy);   // scripts: synthetic mouse input
private:
    void selectAt(AppState& app, const GameContext& ctx, float x, float y, bool additive, CommandQueue& out);
    void selectBox(AppState& app, const GameContext& ctx, float x0, float y0, float x1, float y1, bool additive, CommandQueue& out);
    void placeAt(AppState& app, const GameContext& ctx, V3 p, CommandQueue& out);
    void drawTopBar(AppState& app, const GameContext& ctx);
    void drawBuildBar(AppState& app, const GameContext& ctx, CommandQueue& out);
    void drawSelection(AppState& app, const GameContext& ctx, CommandQueue& out);
    void drawMarkers(AppState& app, const GameContext& ctx);
    void drawPreview(AppState& app, const GameContext& ctx);
    void drawNotices(AppState& app, const GameContext& ctx);

    Selection sel_;
    Tool tool_ = Tool::Select;
    bool rmbDown_ = false;
    float rmbX_ = 0, rmbY_ = 0, rmbTravel_ = 0;
    bool lmbDown_ = false, boxing_ = false;
    float boxX0_ = 0, boxY0_ = 0, boxX1_ = 0, boxY1_ = 0;
    float containerYaw_ = 0.f;
    bool forced_ = false;
    V3 forcedPos_;
    V3 orderMarker_;
    double orderMarkerT_ = -100;
    std::vector<UiNotice> notices_;
    double now_ = 0;
};

} // namespace ttz::game
