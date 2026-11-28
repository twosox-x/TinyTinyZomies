#pragma once
// HUD registration API (GAME_DESIGN 11 / 14e "UI categories"; docs/GAMEPLAY_ARCHITECTURE.md section "UI").
// Features plug into the HUD by registering actions instead of editing the layout:
//   * command-bar cards  (GameUI::registerAction)          : one card in a category tab of the bottom command bar
//   * selection actions  (GameUI::registerSelectionAction) : buttons in the selection panel, shown when visible() says so
//   * world hover menus  (GameUI::registerHoverProvider)   : a small floating menu over a world object under the cursor
// All callbacks run on the main thread inside GameUI::draw / handleEvent (between game ticks). They must only push
// Commands, change GameUI tools (setTool / setWallMode / beginTargeting) or call their module's request queue: never
// mutate game state directly (same rule as the rest of GameUI).
#include "game/GameTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct ImDrawList;

namespace ttz {
struct AppState;
}

namespace ttz::game {

class GameUI;
struct GameContext;
struct Selection;
class CommandQueue;

enum class UiCategory : uint8_t { Units, Structures, Supplies, Engineering, Vehicles, Count };
const char* uiCategoryName(UiCategory c);

// Built-in voxel-style icons (drawn with the ImGui draw list: small isometric blocks in the miniature palette).
enum class UiIcon : uint8_t {
    None, Rifle, MachineGun, Sniper, Flamethrower, Engineer, Container, Airdrop, Wall, WallTall, Gate, ClearCar,
    Tower, Light, Generator, Fuel, Crate, Barricade, Garrison, Hospital, Vehicle, Siphon, Disassemble, Halt, Run, Walk,
    Burn, Build, Undo, Count
};
// Custom painter: centre (cx, cy), box size in pixels, `enabled` false = greyed. Optional (overrides `icon`).
using UiIconPainter = std::function<void(ImDrawList* dl, float cx, float cy, float size, bool enabled)>;
// Draws a built-in icon (used by the bar, the selection panel, hover menus; available to features for their own panels).
void drawUiIcon(ImDrawList* dl, UiIcon icon, float cx, float cy, float size, bool enabled, uint32_t accent = 0);

// Shared callback arguments.
struct UiCtx {
    AppState& app;
    const GameContext& ctx;
    GameUI& ui;
    CommandQueue& out;
};

struct UiAction {
    std::string id;                               // unique ("unit.rifle", "struct.wall", "eng.tower", ...); re-registering replaces
    UiCategory category = UiCategory::Units;
    std::string label;                            // short card name ("Rifle squad")
    UiIcon icon = UiIcon::None;
    UiIconPainter painter;                        // optional custom icon
    uint32_t accent = 0;                          // optional icon accent colour (IM_COL32), 0 = default
    std::function<int(const UiCtx&)> cost;        // price shown on the card (null / < 0: none)
    std::string costSuffix;                       // e.g. "/4m"
    int hotkey = 0;                               // SDL_Keycode (0 = none); fires onSelect without modifiers (Shift allowed)
    std::string hotkeyLabel;                      // shown on the card ("Z"); derived from hotkey when empty
    std::function<void(const UiCtx&)> onSelect;   // card click / hotkey
    // Greyed out when false; `why` (optional) is shown in the tooltip ("Not enough funding", "Needs engineers").
    // Cost affordability is checked automatically when `cost` is set. Hotkeys still fire when disabled by funding only
    // (the placement preview then explains the refusal), but not when enabled() is false.
    std::function<bool(const UiCtx&, std::string* why)> enabled;
    std::function<bool(const UiCtx&)> active;     // highlighted (its tool is on)
    std::function<std::string(const UiCtx&)> tooltip;   // description / stats (multi-line ok)
    std::function<std::string(const UiCtx&)> placementHint;   // banner text while active ("LMB place | Q/E rotate")
    std::function<std::string(const UiCtx&)> badge;           // small corner badge on the card ("x5")
    int order = 100;                              // sort key inside the category
    bool comingLater = false;                     // greyed "coming later" card (Vehicles)
};

// Buttons in the selection panel (context actions for the selected squads).
struct UiSelectionAction {
    std::string id;
    std::string label;
    UiIcon icon = UiIcon::None;
    int hotkey = 0;                               // informational only (the feature handles its own key), shown as a badge
    std::string hotkeyLabel;
    std::function<bool(const UiCtx&)> visible;    // e.g. "an engineer squad is selected"
    std::function<bool(const UiCtx&, std::string* why)> enabled;
    std::function<bool(const UiCtx&)> active;
    std::function<void(const UiCtx&)> onSelect;
    std::function<std::string(const UiCtx&)> tooltip;
    int order = 100;
};

// World hover menus: the provider looks at the ground point / screen point under the cursor and fills a menu when it
// owns the object there (a parked car with engineers selected: siphon / disassemble / clear). Every provider may append
// entries; the first one that returns true sets title / anchor / key (later providers see out.key != 0 and should only
// add entries for the same object). The menu stays open while the cursor moves onto it.
struct UiHoverEntry {
    std::string label;
    UiIcon icon = UiIcon::None;
    std::string hotkeyLabel;
    int cost = -1;
    bool enabled = true;
    std::string why;                              // shown when disabled
    std::function<void(const UiCtx&)> onClick;
};
struct UiHoverMenu {
    std::string title;
    V3 anchor;                                    // world point the menu is attached to
    std::vector<UiHoverEntry> entries;
    uint64_t key = 0;                             // identity of the hovered object (keeps the menu stable)
    int primary = -1;                             // entry run by a left / right click on the object itself (RTS default
                                                  // action, e.g. "Occupy tower"); -1 = none (plain select / move)
};
using UiHoverProvider = std::function<bool(const UiCtx&, V3 ground, float sx, float sy, UiHoverMenu& out)>;

} // namespace ttz::game
