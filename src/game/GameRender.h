#pragma once
// Game -> MilitaryRenderer adapter (WS-B). Once per render frame: gathers the visible soldiers (pose inputs from the
// SoldierPool / AnimPlayback), deploy canopies, supply points and airdrop crates, turns this tick's FxEvents into
// renderer FX, and hooks the MilitaryRenderer into Renderer::extPrepare / extDraw / extShadowDraw (exclusive with the
// lab: --game and --lab are separate modes).
// Also draws the in-world RTS feedback that needs depth (selection rings, move-order marker, placement ghosts)
// through the same instanced path; screen-space markers / HUD are GameUI.
#include "game/GameContext.h"
#include "lab/MilitaryRenderer.h"

#include <vector>

namespace ttz {
struct AppState;
}

namespace ttz::game {

struct FxEvent;

class GameRender {
public:
    bool init(AppState& app);          // creates the MilitaryRenderer, installs the Renderer hooks
    void shutdown(AppState& app);
    // Render frame: `alpha` = fraction of the current game tick elapsed (pose interpolation).
    void update(AppState& app, const GameContext& ctx, float frameDt, float alpha, const std::vector<FxEvent>& fx);
    MilitaryRenderer* renderer() { return mil_; }
    const MilitaryLibrary* library() const { return mil_ ? &mil_->library() : nullptr; }
private:
    MilitaryRenderer* mil_ = nullptr;
};

} // namespace ttz::game
