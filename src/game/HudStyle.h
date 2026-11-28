#pragma once
// HUD v2 "Counters" style (docs/UI_APPROVALS.md, preview docs/ui_preview/): Archivo font, game-icons.net silhouettes
// (assets/ui/icons.png, CC BY 3.0) packed into the ImGui font atlas, bevelled tokens with state rings, and small
// tweens keyed by ImGuiID for the "juice" (hover lift, press squash, pop when switched on, deny shake).
#include <cstdint>

struct ImDrawList;
struct ImFont;
struct ImFontAtlas;
struct ImVec2;
typedef unsigned int ImU32;
typedef unsigned int ImGuiID;

namespace ttz::game {

enum class UiIcon : uint8_t;

// App setup: right after the default fonts are added. Loads assets/ui/Archivo-*.ttf and the icon atlas.
// Safe to call when the files are missing (the HUD then keeps the default font and draws no icons).
void hudStyleLoad(ImFontAtlas* atlas);
ImFont* hudFont();       // Archivo medium (null when missing)
ImFont* hudFontBold();   // Archivo bold (null when missing)

namespace hs {
// palette (preview core.css tokens)
extern const ImU32 kTok, kTokHi, kBone, kDim, kMute, kGold, kOk, kWarn, kBad, kToxic, kInfo, kInk, kShadow;

// icons by atlas name ("rifle", "halt", ...) or by UiIcon; centred at c, size in pixels, tinted.
bool icon(ImDrawList* dl, const char* name, ImVec2 c, float size, ImU32 col, bool shadow = false);
const char* iconName(UiIcon i);

// a token (counter): square (round = false) or round; returns nothing, draws only. `lift` 0..1 (hover), `press` 0..1.
struct Tok {
    float size = 36; bool round = false; bool on = false; bool off = false;
    float lift = 0, press = 0, pop = 0, shake = 0;   // tween values (from tween())
    float ring = -1; ImU32 ringCol = 0;               // ring 0..1 (< 0: none)
    const char* key = nullptr; const char* num = nullptr;
};
void token(ImDrawList* dl, ImVec2 centre, const Tok& t, const char* iconName, float scale);
void ring(ImDrawList* dl, ImVec2 c, float r, float thick, float frac, ImU32 col);
void textShadow(ImDrawList* dl, ImFont* f, float px, ImVec2 p, ImU32 col, const char* t);

// tweens: value approaches target at `rate`/s; kick() starts a decaying 0..1 pulse (pop / shake / press flash)
void frame(float dt);
float tween(ImGuiID id, float target, float rate = 18.f);
void kick(ImGuiID id);
float pulse(ImGuiID id, float seconds = 0.3f);   // 1 right after kick(), 0 after `seconds`
float springPop(float p);                        // pulse -> scale overshoot (1 + ...)
float shakeX(float p);                           // pulse -> horizontal offset in units of 1 px
}

} // namespace ttz::game
