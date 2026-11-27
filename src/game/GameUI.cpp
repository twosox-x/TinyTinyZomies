// RTS interface (WS-D): STUB. Shows that --game mode is active; consumes nothing yet.
#include "game/GameUI.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "imgui.h"

namespace ttz::game {

bool GameUI::handleEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) { return false; }

void GameUI::draw(AppState& app, const GameContext& ctx, CommandQueue& out) {
    ImGui::SetNextWindowPos(ImVec2(ImGui::GetIO().DisplaySize.x * 0.5f, 8.f), ImGuiCond_Always, ImVec2(0.5f, 0.f));
    ImGui::Begin("##gamebar", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoMove);
    ImGui::Text("Funding %.0f   Kills %llu   Balance: %s", ctx.economy ? ctx.economy->funding() : 0.0,
                (unsigned long long)(ctx.economy ? ctx.economy->kills() : 0), ctx.cfg ? ctx.cfg->status.c_str() : "?");
    ImGui::End();
}

} // namespace ttz::game
