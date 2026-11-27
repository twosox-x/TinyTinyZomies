// Game -> MilitaryRenderer adapter (WS-B): STUB. No soldiers drawn until MilitaryRenderer is extracted from the lab.
#include "game/GameRender.h"

namespace ttz::game {

bool GameRender::init(AppState& app) { return false; }
void GameRender::shutdown(AppState& app) { mil_ = nullptr; }
void GameRender::update(AppState& app, const GameContext& ctx, float frameDt, float alpha, const std::vector<FxEvent>& fx) {}

} // namespace ttz::game
