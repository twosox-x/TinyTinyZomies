#pragma once
namespace ttz {
struct AppState;
// Minimal Dear ImGui debug panel: stats, simulation controls, parameters (no recompile needed).
void drawDebugUI(AppState& s);
void drawPerfHud(AppState& s);   // F3 / --perf-hud: frame time, per-pass CPU timings, fx load
}
