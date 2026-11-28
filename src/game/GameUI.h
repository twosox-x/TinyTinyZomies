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
#include "game/UiActions.h"

#include <functional>
#include <string>
#include <vector>

union SDL_Event;

namespace ttz {
struct AppState;
}

namespace ttz::game {

enum class Tool : uint8_t { Select, BuyRifle, BuyMG, BuySniper, PlaceContainer, Airdrop, BuildWall /* B2 */, BuyFlame /* 14d */,
                           BuyEngineer /* 14d */, ClearCar /* 14d: engineers remove a parked vehicle */,
                           Target /* UI: a selection / hover action waits for a ground click (beginTargeting) */ };

struct UiNotice { std::string text; double time = 0; bool bad = false; bool hasPos = false; V3 pos; uint32_t repeat = 1; };

// Screen rectangles of the HUD (pixels), refreshed every draw: features place their own panels with these so nothing
// overlaps the command bar (BuildingGame's panel sits above the selection panel).
struct HudLayout {
    float scale = 1.f;                 // UI scale (DPI / --ui-scale)
    float topBarBottom = 0.f;          // y below the top bar
    float barX0 = 0, barY0 = 0, barX1 = 0, barY1 = 0;   // command bar (tabs + cards)
    float panelX = 0;                  // left edge of the selection panel column
    float panelBottom = 0;             // y the next panel above the selection panel must end at
    float panelMaxW = 420.f;           // max width of a left-column panel
};

class GameUI {
public:
    // Input first (App::handleEvent forwards here before its own handling). True = consumed.
    bool handleEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);
    void draw(AppState& app, const GameContext& ctx, CommandQueue& out);
    Selection& selection() { return sel_; }
    Tool tool() const { return tool_; }
    void setTool(Tool t) { tool_ = t; }
    void notify(const std::string& text, bool bad, double time);
    void notifyAt(const std::string& text, bool bad, double time, V3 pos);   // clickable: jumps the camera to pos
    // ---- HUD registration API (UiActions.h; docs/GAMEPLAY_ARCHITECTURE.md "UI") ----
    void registerAction(UiAction a);
    void registerAction(UiCategory cat, const std::string& id, UiIcon icon, const std::string& label, std::function<int(const UiCtx&)> cost,
                        int hotkey, std::function<void(const UiCtx&)> onSelect, std::function<bool(const UiCtx&, std::string*)> enabled = {},
                        std::function<std::string(const UiCtx&)> tooltip = {});
    void unregisterAction(const std::string& id);
    void registerSelectionAction(UiSelectionAction a);
    void registerHoverProvider(const std::string& id, UiHoverProvider p);
    const std::vector<UiAction>& actions() const { return actions_; }
    void ensureBuiltinActions() { registerBuiltinActions(); }   // normally lazy (first draw / event); scripts / tests
    // Scripts / tests: run a registered action as if its card (or selection button) was clicked. False: unknown id.
    bool invokeAction(AppState& app, const GameContext& ctx, CommandQueue& out, const std::string& id);
    // Scripts / tests: click entry `k` of the world hover menu at a world point (the same providers / onClick as the
    // mouse path). Returns the entry label ("" = no menu / no such entry); `why` = the refusal when it is disabled.
    std::string clickHoverEntry(AppState& app, const GameContext& ctx, CommandQueue& out, V3 at, size_t k, std::string* why = nullptr);
    void setCategory(UiCategory c) { tab_ = c; }
    UiCategory category() const { return tab_; }
    // A context action that needs a ground point: the next LMB on the ground calls fn (RMB / Esc cancel).
    void beginTargeting(const std::string& label, const std::string& hint, std::function<void(const UiCtx&, V3)> fn);
    const HudLayout& layout() const { return layout_; }
    // ---- World labels (decluttered): text over the 3D view is collected per frame and placed by priority; a label
    // that would overlap a higher-priority one tries a nudge, else is dropped; identical text close by is merged; labels
    // fade with zoom (minor ones first) and never cover the HUD panels. Priorities: kLabelCursor 100 (placement /
    // cursor), kLabelAlert 80 (breach, contested), kLabelSelected 60, kLabelStatus 40 (jobs, roles), kLabelInfo 20
    // (regions, radius hints), kLabelMinor 10 (squad numbers, stock counts).
    enum : int { kLabelMinor = 10, kLabelInfo = 20, kLabelStatus = 40, kLabelSelected = 60, kLabelAlert = 80, kLabelCursor = 100 };
    void worldLabel(float sx, float sy, const std::string& text, uint32_t col, int priority, bool centred = false, bool plate = true);
    // Sticky move pace for RMB orders chosen in the selection panel (0 auto, 1 run, 2 walk); Shift / Ctrl still override.
    int movePace = 0;
    // Scripted previews / captures: show the placement preview of `t` at a world point (no mouse needed).
    void forcePreview(Tool t, V3 pos) { tool_ = t; forced_ = true; forcedPos_ = pos; }
    void clearForcedPreview() { forced_ = false; tool_ = Tool::Select; }
    void clearForcedFlag() { forced_ = false; }
    // Height-grid pick (street, roof) under a screen point; false when the ray leaves the grid.
    static bool pickGround(const AppState& app, const GameContext& ctx, float sx, float sy, V3& out);
    static bool worldToScreen(const AppState& app, V3 p, float& sx, float& sy);   // scripts: synthetic mouse input
    // ---- B2 wall tool (FortUI.cpp): N cheap wall, M reinforced wall, J gate (PROPOSED). Click adds points (snapped to
    // the 1 m grid / existing joints), drag = straight run in whole 4 m pieces (Ctrl: 1 m steps), Enter / double-click /
    // closing the loop confirms, Backspace undoes a point, Esc cancels. Container: Q / E / wheel rotate 15 deg, T 90.
    // 14d engineers (FortUI.cpp): U buys engineers, K clears a car (click it), J places a single gate (click; Q / E / wheel
    // rotate 15 deg, T 90; over a wall it replaces that part, next to a wall end it continues it), Ctrl+Z undoes the
    // newest unfinished placement. Wall tool: Shift snaps the direction to 15 deg steps (and 0 / 45 / 90 deg relative to
    // the previous leg / the wall it starts on snap magnetically within 4 deg); guide lines and a 1 m grid near the cursor.
    bool rotatesWithQE() const { return tool_ == Tool::PlaceContainer || (tool_ == Tool::BuildWall && wallGate_ && wallPts_.empty()); }
    float gateYaw() const { return gateYaw_; }
    void setWallMode(uint8_t type, bool gate) { tool_ = Tool::BuildWall; wallType_ = type; wallGate_ = gate; wallPts_.clear(); forced_ = false; }
    void forceWallPreview(const std::vector<V3>& pts, uint8_t type, bool gate);   // scripts / captures
    float containerYaw() const { return containerYaw_; }
    // ---- B3a buildings (BuildingGame.cpp installs these): a left click that hits no squad goes to buildingClick
    // (true: a building was selected, the squad selection is kept so "Garrison" can use it); extra keys / panel.
    std::function<bool(AppState&, const GameContext&, float, float)> buildingClick;
    std::function<bool(AppState&, const GameContext&, const SDL_Event&)> buildingKey;
    std::function<void(AppState&, const GameContext&)> buildingDraw;
    const Selection& selectionConst() const { return sel_; }
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
    // HUD 2 (HudBar.cpp): command bar, selection panel, top bar, feed, hover menus, placement banner
    void registerBuiltinActions();
    bool actionHotkey(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);
    void drawPlacementBanner(AppState& app, const GameContext& ctx, CommandQueue& out);
    void drawHoverMenu(AppState& app, const GameContext& ctx, CommandQueue& out);
    void watchEvents(const GameContext& ctx);
    void registerFortActions();   // FortUI.cpp: walls / gate / engineers / clear car cards
    struct WorldLabel { float x, y; std::string text; uint32_t col; int prio; bool centred, plate; };
    std::vector<WorldLabel> labels_;
    std::vector<float> hudRects_;   // x0 y0 x1 y1 of this frame's HUD panels (labels never cover them)
    void flushWorldLabels(AppState& app);
    std::vector<UiAction> actions_;
    std::vector<UiSelectionAction> selActions_;
    std::vector<std::pair<std::string, UiHoverProvider>> hover_;
    bool builtins_ = false;
    UiCategory tab_ = UiCategory::Units;
    float tabAnim_ = 0.f, barScroll_ = 0.f, barScrollGoal_ = 0.f, panelAnim_ = 0.f;
    HudLayout layout_;
    std::string targetLabel_, targetHint_;
    std::function<void(const UiCtx&, V3)> targetFn_;
    UiHoverMenu hoverMenu_;
    bool hoverOpen_ = false;
    double hoverSeen_ = -100, hoverOverMenu_ = -100;
    std::vector<uint32_t> prevFlags_;
    std::vector<size_t> seenRubble_;
    size_t rubbleCount_ = 0;
    std::vector<int> prevAlive_;
    std::vector<double> lastAttackNote_;
    double fundShown_ = -1, fundFlashT_ = -100;
    int fundFlashDir_ = 0;
    float tabIndX_ = -1, tabIndW_ = 0;
    std::string revealId_;
public:
    std::string forceTip;            // scripts / captures: show this card's tooltip (headless shots have no mouse)
    bool forceHover = false;         // scripts / captures: the hover menu at the forced preview position
private:
    // B2 (FortUI.cpp)
    bool wallEvent(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);
    void confirmWall(const AppState& app, const GameContext& ctx, CommandQueue& out);
    void drawWallPreview(AppState& app, const GameContext& ctx);
    void drawTerritory(AppState& app, const GameContext& ctx);
    bool constructionKey(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out);   // 14d (FortUI.cpp)
    bool clearCarCheck(const AppState& app, const GameContext& ctx, V3 p, const char** why) const;
    void drawClearPreview(AppState& app, const GameContext& ctx);
    void drawEngineerZones(AppState& app, const GameContext& ctx);
    void drawConstruction(AppState& app, const GameContext& ctx);
    V3 angleSnap(const GameContext& ctx, V3 from, V3 to, bool force) const;
    float gateYaw_ = 0.f;
    uint8_t wallType_ = 0;
    bool wallGate_ = false;
    std::vector<V3> wallPts_;
    bool wallDown_ = false, wallDragging_ = false;
    float wallDownX_ = 0, wallDownY_ = 0;
    void drawAiDebug(AppState& app, const GameContext& ctx);   // F6: what each soldier thinks (target line, state, stamina)

    Selection sel_;
    Tool tool_ = Tool::Select;
    bool rmbDown_ = false;
    float rmbX_ = 0, rmbY_ = 0, rmbTravel_ = 0;
    bool lmbDown_ = false, boxing_ = false;
    float boxX0_ = 0, boxY0_ = 0, boxX1_ = 0, boxY1_ = 0;
    float containerYaw_ = 0.f;
    bool forced_ = false;
public:
    bool aiDebug = false;            // F6 overlay (scripts: "key f6"); public so tests / screenshots can turn it on
private:
    V3 forcedPos_;
    V3 orderMarker_;
    double orderMarkerT_ = -100;
    std::vector<UiNotice> notices_;
    double now_ = 0;
};

} // namespace ttz::game
