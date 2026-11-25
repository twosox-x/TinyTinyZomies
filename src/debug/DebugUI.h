#pragma once
namespace ttz {
struct AppState;
// Minimal Dear ImGui debug panel: stats, simulation controls, parameters (no recompile needed).
void drawDebugUI(AppState& s);
}
