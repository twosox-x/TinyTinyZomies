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
#include "game/Commands.h"
#include "game/GameContext.h"

union SDL_Event;

namespace ttz {
struct AppState;
}

namespace ttz::game {

enum class Tool : uint8_t { Select, BuyRifle, BuyMG, BuySniper, PlaceContainer, Airdrop };

class GameUI {
public:
    // Input first (App::handleEvent forwards here before its own handling). True = consumed.
    bool handleEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);
    void draw(AppState& app, const GameContext& ctx, CommandQueue& out);
    Selection& selection() { return sel_; }
    Tool tool() const { return tool_; }
private:
    Selection sel_;
    Tool tool_ = Tool::Select;
    bool rmbDown_ = false;
    float rmbX_ = 0, rmbY_ = 0, rmbTravel_ = 0;
    bool boxing_ = false;
    float boxX0_ = 0, boxY0_ = 0;
};

} // namespace ttz::game
