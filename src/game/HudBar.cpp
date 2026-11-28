// HUD 2 (part of GameUI; GAME_DESIGN 11 / 14e, docs/GAMEPLAY_ARCHITECTURE.md 13): thin top bar, notification feed,
// bottom command bar with category tabs and icon cards (registration API, UiActions.h), selection panel with context
// actions, placement banner, world hover menus, voxel-style icons. Everything scales with the UI scale (DPI /
// --ui-scale) and is laid out from the window size every frame, so nothing clips or overlaps.
#include "game/GameUI.h"

#include "app/App.h"
#include "game/Config.h"
#include "game/Economy.h"
#include "game/EngineerAI.h"
#include "game/HordeInterface.h"
#include "game/Logistics.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"
#include "game/Territory.h"
#include "game/Walls.h"
#include "imgui.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
// ---- miniature-military palette ---------------------------------------------------------------------------------
const ImU32 kBg = IM_COL32(20, 23, 16, 212), kBgHi = IM_COL32(34, 38, 26, 232), kEdge = IM_COL32(104, 110, 72, 150),
            kSand = IM_COL32(232, 224, 190, 255), kDim = IM_COL32(158, 154, 128, 255), kFaint = IM_COL32(110, 108, 90, 255),
            kKhaki = IM_COL32(204, 184, 112, 255), kOk = IM_COL32(126, 196, 92, 255), kBad = IM_COL32(226, 86, 64, 255),
            kAmber = IM_COL32(232, 178, 64, 255), kBlue = IM_COL32(96, 160, 220, 255), kShadow = IM_COL32(0, 0, 0, 140),
            kInk = IM_COL32(14, 16, 10, 255);
constexpr float kPi = 3.14159265f;
// HUD sizes in one place (unscaled px; multiplied by the UI scale S). Panels have FIXED sizes (owner round 15 #2):
// content scrolls / truncates inside, the panels never grow or shrink with what they show.
namespace hudsz {
constexpr float cardW = 84, cardH = 70, cardGap = 5;
constexpr int barCards = 7;                        // command bar width = 7 card slots (keys 1-7)
constexpr float selW = 372;                        // selection panel width
constexpr int selRows = 8;                         // member rows (single squad) in the fixed list area
constexpr int selSumRows = 6;                      // squad summary rows (multi selection), last one "+ N more"
constexpr int selActRows = 2;                      // action button rows (compact icon buttons when more are needed)
constexpr float noticeW = 330;                     // notification rows
}

float S = 1.f;          // UI scale of this frame
ImFont* F = nullptr;    // HUD font (vector default when the App added it, else the current font)
float dtUi = 0.016f;    // animation step (large in headless captures: animations at rest)

ImU32 withA(ImU32 c, float a) { return (c & 0x00FFFFFFu) | ((ImU32)(std::clamp(a, 0.f, 1.f) * (float)((c >> 24) & 0xFF)) << 24); }
ImU32 mix(ImU32 a, ImU32 b, float t) {
    const ImVec4 x = ImGui::ColorConvertU32ToFloat4(a), y = ImGui::ColorConvertU32ToFloat4(b);
    return ImGui::ColorConvertFloat4ToU32(ImVec4(x.x + (y.x - x.x) * t, x.y + (y.y - x.y) * t, x.z + (y.z - x.z) * t, x.w + (y.w - x.w) * t));
}
ImU32 shade(ImU32 c, float k) {
    ImVec4 v = ImGui::ColorConvertU32ToFloat4(c);
    v.x = std::min(1.f, v.x * k); v.y = std::min(1.f, v.y * k); v.z = std::min(1.f, v.z * k);
    return ImGui::ColorConvertFloat4ToU32(v);
}
float approach(float cur, float goal, float rate) { return cur + (goal - cur) * std::min(1.f, dtUi * rate); }

ImVec2 tsize(float px, const char* t) { return F->CalcTextSizeA(px * S, FLT_MAX, 0.f, t); }
void text(ImDrawList* dl, float x, float y, ImU32 col, float px, const char* t, bool shadow = false) {
    if (shadow) dl->AddText(F, px * S, ImVec2(x + 1, y + 1), withA(kShadow, ((col >> 24) & 0xFF) / 255.f), t);
    dl->AddText(F, px * S, ImVec2(x, y), col, t);
}
// text cut with an ellipsis to fit `w`
std::string fit(float px, const std::string& t, float w) {
    if (tsize(px, t.c_str()).x <= w) return t;
    std::string s = t;
    while (s.size() > 1 && tsize(px, (s + "..").c_str()).x > w) s.pop_back();
    return s + "..";
}
void panel(ImDrawList* dl, ImVec2 a, ImVec2 b, float alpha = 1.f, float round = 4.f) {
    dl->AddRectFilled(ImVec2(a.x + 2 * S, a.y + 2 * S), ImVec2(b.x + 2 * S, b.y + 2 * S), withA(kShadow, 0.5f * alpha), round * S);
    dl->AddRectFilled(a, b, withA(kBg, alpha), round * S);
    dl->AddRect(a, b, withA(kEdge, alpha), round * S, 0, 1.f);
}
void bar(ImDrawList* dl, float x, float y, float w, float h, float f, ImU32 col) {
    dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + h), IM_COL32(8, 9, 6, 220), h * 0.4f);
    if (f > 0.f) dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w * std::clamp(f, 0.f, 1.f), y + h), col, h * 0.4f);
}
std::string money(int v) {
    char b[32];
    if (v >= 1000) std::snprintf(b, sizeof(b), "$%d,%03d", v / 1000, v % 1000);
    else std::snprintf(b, sizeof(b), "$%d", v);
    return b;
}
std::string keyLabel(int key) {
    if (!key) return "";
    const char* n = SDL_GetKeyName((SDL_Keycode)key);
    return n && *n ? n : "?";
}
const ImGuiWindowFlags kWin = ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
                              ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav | ImGuiWindowFlags_NoBackground |
                              ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoScrollbar;
bool beginPane(const char* id, ImVec2 a, ImVec2 b) {
    ImGui::SetNextWindowPos(a, ImGuiCond_Always);
    ImGui::SetNextWindowSize(ImVec2(std::max(1.f, b.x - a.x), std::max(1.f, b.y - a.y)), ImGuiCond_Always);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowMinSize, ImVec2(1, 1));
    const bool open = ImGui::Begin(id, nullptr, kWin);
    ImGui::PopStyleVar(3);
    return open;
}
bool hit(const char* id, ImVec2 a, ImVec2 b, bool* hovered = nullptr) {   // invisible button at absolute coordinates
    ImGui::SetCursorScreenPos(a);
    const bool c = ImGui::InvisibleButton(id, ImVec2(std::max(1.f, b.x - a.x), std::max(1.f, b.y - a.y)));
    if (hovered) *hovered = ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled);
    return c;
}
void tipBegin() {
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(9 * S, 7 * S));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 4 * S);
    ImGui::PushStyleColor(ImGuiCol_PopupBg, ImVec4(0.07f, 0.08f, 0.05f, 0.96f));
    ImGui::BeginTooltip();
    ImGui::PushFont(F, 13.f);
}
void tipEnd() {
    ImGui::PopFont();
    ImGui::EndTooltip();
    ImGui::PopStyleColor();
    ImGui::PopStyleVar(2);
}
ImVec4 v4(ImU32 c) { return ImGui::ColorConvertU32ToFloat4(c); }

// ---- voxel icons: little isometric boxes, auto-fitted into the icon box -------------------------------------------
struct Box { float x, y, z, w, h, d; ImU32 c; };
struct Iso {
    ImDrawList* dl; float cx, cy, u, ox, oy; bool on;
    ImVec2 P(float x, float y, float z) const { return ImVec2(cx + ((x - z) * 0.866f - ox) * u, cy + ((x + z) * 0.5f - y - oy) * u); }
};
ImU32 grey(ImU32 c, bool on) { return on ? c : mix(shade(c, 0.7f), IM_COL32(96, 96, 88, 255), 0.7f); }
void drawBoxes(ImDrawList* dl, const std::vector<Box>& bs, float cx, float cy, float size, bool on) {
    if (bs.empty()) return;
    float x0 = FLT_MAX, y0 = FLT_MAX, x1 = -FLT_MAX, y1 = -FLT_MAX;
    for (const Box& b : bs)
        for (int k = 0; k < 8; ++k) {
            const float x = b.x + ((k & 1) ? b.w : 0), y = b.y + ((k & 2) ? b.h : 0), z = b.z + ((k & 4) ? b.d : 0);
            const float sx = (x - z) * 0.866f, sy = (x + z) * 0.5f - y;
            x0 = std::min(x0, sx); x1 = std::max(x1, sx); y0 = std::min(y0, sy); y1 = std::max(y1, sy);
        }
    const float u = size / std::max(x1 - x0, y1 - y0);
    Iso I{dl, cx, cy, u, 0.5f * (x0 + x1), 0.5f * (y0 + y1), on};
    for (const Box& b : bs) {
        const ImU32 c = grey(b.c, on);
        const ImU32 top = shade(c, 1.18f), left = shade(c, 0.86f), right = shade(c, 0.64f), edge = withA(kInk, 0.55f);
        const float X = b.x, Y = b.y, Z = b.z, W = b.x + b.w, H = b.y + b.h, D = b.z + b.d;
        const ImVec2 t0 = I.P(X, H, Z), t1 = I.P(W, H, Z), t2 = I.P(W, H, D), t3 = I.P(X, H, D);
        const ImVec2 b1 = I.P(W, Y, Z), b2 = I.P(W, Y, D), b3 = I.P(X, Y, D);
        dl->AddQuadFilled(t3, t2, b2, b3, left);    // +z face (front left)
        dl->AddQuadFilled(t1, t2, b2, b1, right);   // +x face (front right)
        dl->AddQuadFilled(t0, t1, t2, t3, top);
        if (u * std::min({b.w, b.h, b.d}) > 2.5f) {
            ImVec2 o[6] = {t0, t1, b1, b2, b3, t3};
            dl->AddPolyline(o, 6, edge, ImDrawFlags_Closed, 1.f);
        }
    }
}
// colours of the miniatures
const ImU32 cOlive = IM_COL32(112, 122, 72, 255), cOliveD = IM_COL32(78, 86, 50, 255), cSkin = IM_COL32(214, 172, 132, 255),
            cGun = IM_COL32(54, 54, 50, 255), cVest = IM_COL32(232, 196, 44, 255), cFlame = IM_COL32(244, 132, 40, 255),
            cFlame2 = IM_COL32(252, 214, 84, 255), cStone = IM_COL32(150, 144, 126, 255), cWood = IM_COL32(168, 124, 76, 255),
            cSteel = IM_COL32(118, 128, 126, 255), cCont = IM_COL32(90, 112, 76, 255), cRed = IM_COL32(176, 62, 46, 255),
            cWhite = IM_COL32(226, 226, 214, 255), cGlass = IM_COL32(120, 160, 180, 255), cGhillie = IM_COL32(104, 110, 62, 255);
void soldier(std::vector<Box>& v, float x, float z, ImU32 torso, ImU32 helmet) {
    v.push_back({x, 0, z, 1.4f, 2.2f, 1.0f, cOliveD});              // legs
    v.push_back({x, 2.2f, z, 1.4f, 2.0f, 1.0f, torso});              // torso
    v.push_back({x + 0.25f, 4.2f, z + 0.1f, 0.9f, 0.9f, 0.8f, cSkin});   // head
    v.push_back({x + 0.1f, 4.9f, z, 1.2f, 0.5f, 1.0f, helmet});      // helmet
}
} // namespace

const char* uiCategoryName(UiCategory c) {
    switch (c) {
    case UiCategory::Units: return "UNITS";
    case UiCategory::Structures: return "STRUCTURES";
    case UiCategory::Supplies: return "SUPPLIES";
    case UiCategory::Engineering: return "ENGINEERING";
    case UiCategory::Vehicles: return "VEHICLES";
    default: return "?";
    }
}

void drawUiIcon(ImDrawList* dl, UiIcon icon, float cx, float cy, float size, bool on, uint32_t accent) {
    std::vector<Box> v;
    switch (icon) {
    case UiIcon::Rifle:
        soldier(v, 0, 0, cOlive, cOliveD);
        v.push_back({-0.6f, 3.0f, 1.0f, 3.2f, 0.35f, 0.35f, cGun});
        break;
    case UiIcon::MachineGun:
        soldier(v, 0, 0, cOlive, cOliveD);
        v.push_back({-0.2f, 2.0f, 1.0f, 1.0f, 0.8f, 0.6f, IM_COL32(92, 100, 60, 255)});   // ammo box
        v.push_back({-0.8f, 2.9f, 1.0f, 4.0f, 0.6f, 0.6f, cGun});
        v.push_back({2.8f, 2.4f, 1.1f, 0.25f, 0.5f, 0.4f, cGun});
        break;
    case UiIcon::Sniper:
        soldier(v, 0, 0, cGhillie, cGhillie);
        v.push_back({-0.8f, 3.1f, 1.0f, 4.6f, 0.28f, 0.28f, cGun});
        v.push_back({0.8f, 3.4f, 1.0f, 1.0f, 0.3f, 0.3f, IM_COL32(30, 30, 30, 255)});
        break;
    case UiIcon::Flamethrower:
        v.push_back({-0.7f, 2.0f, 0.1f, 0.7f, 2.2f, 0.8f, IM_COL32(150, 70, 46, 255)});   // tank on the back
        soldier(v, 0, 0, cOlive, cOliveD);
        v.push_back({0.4f, 2.8f, 1.0f, 2.4f, 0.35f, 0.35f, cGun});
        v.push_back({2.8f, 2.6f, 1.0f, 0.8f, 0.8f, 0.6f, cFlame});
        v.push_back({3.6f, 2.8f, 1.0f, 0.6f, 0.6f, 0.5f, cFlame2});
        break;
    case UiIcon::Engineer:
        soldier(v, 0, 0, cVest, IM_COL32(236, 214, 70, 255));
        v.push_back({1.5f, 2.6f, 0.9f, 0.3f, 1.8f, 0.3f, cSteel});   // shovel / wrench
        v.push_back({1.3f, 4.3f, 0.8f, 0.7f, 0.4f, 0.5f, cSteel});
        break;
    case UiIcon::Container:
        v.push_back({0, 0, 0, 6.0f, 2.6f, 2.6f, accent ? accent : cCont});
        for (int k = 1; k < 6; ++k) v.push_back({(float)k - 0.05f, 0.2f, 2.6f, 0.1f, 2.2f, 0.05f, shade(cCont, 0.7f)});
        break;
    case UiIcon::Airdrop:
    case UiIcon::Crate:
        v.push_back({0, 0, 0, 2.2f, 1.8f, 2.2f, cWood});
        v.push_back({0, 0.8f, 2.2f, 2.2f, 0.25f, 0.05f, shade(cWood, 0.7f)});
        if (icon == UiIcon::Airdrop) {
            v.push_back({0.9f, 1.8f, 0.9f, 0.1f, 1.6f, 0.1f, cWhite});
            v.push_back({-0.8f, 3.4f, -0.8f, 3.8f, 0.7f, 3.8f, cWhite});   // canopy
            v.push_back({-0.2f, 4.1f, -0.2f, 2.6f, 0.4f, 2.6f, shade(cWhite, 1.05f)});
        }
        break;
    case UiIcon::Wall:
    case UiIcon::WallTall: {
        const float h = icon == UiIcon::WallTall ? 2.4f : 1.6f;
        for (int k = 0; k < 3; ++k) v.push_back({k * 1.6f, 0, 0, 1.5f, h, 1.2f, k & 1 ? shade(cStone, 0.92f) : cStone});
        break;
    }
    case UiIcon::Gate:
        v.push_back({0, 0, 0, 0.7f, 2.6f, 0.7f, cStone});
        v.push_back({0.9f, 0.2f, 0.2f, 2.6f, 0.25f, 0.25f, cSteel});
        v.push_back({0.9f, 1.2f, 0.2f, 2.6f, 0.25f, 0.25f, cSteel});
        v.push_back({0.9f, 2.0f, 0.2f, 2.6f, 0.25f, 0.25f, cSteel});
        v.push_back({3.6f, 0, 0, 0.7f, 2.6f, 0.7f, cStone});
        break;
    case UiIcon::ClearCar:
    case UiIcon::Vehicle:
    case UiIcon::Siphon:
    case UiIcon::Disassemble:
        v.push_back({0, 0.3f, 0, 4.4f, 1.0f, 2.0f, icon == UiIcon::Vehicle ? cOlive : cRed});
        v.push_back({1.0f, 1.3f, 0.1f, 2.2f, 0.8f, 1.8f, cGlass});
        v.push_back({0.5f, 0, 2.0f, 0.8f, 0.6f, 0.1f, cGun});
        v.push_back({3.0f, 0, 2.0f, 0.8f, 0.6f, 0.1f, cGun});
        if (icon == UiIcon::Siphon) v.push_back({4.6f, 0, 1.2f, 1.0f, 1.4f, 0.6f, cRed}), v.push_back({4.6f, 1.4f, 1.3f, 0.4f, 0.3f, 0.3f, cGun});
        if (icon == UiIcon::Disassemble) v.push_back({3.8f, 1.8f, 1.6f, 0.3f, 2.0f, 0.3f, cSteel}), v.push_back({3.5f, 3.6f, 1.5f, 0.9f, 0.4f, 0.5f, cSteel});
        break;
    case UiIcon::Tower:
        for (int k = 0; k < 4; ++k) v.push_back({(k & 1) * 2.2f, 0, (k >> 1) * 2.2f, 0.35f, 4.2f, 0.35f, cWood});
        v.push_back({-0.3f, 4.2f, -0.3f, 3.2f, 0.4f, 3.2f, shade(cWood, 1.1f)});
        v.push_back({-0.3f, 4.6f, 2.6f, 3.2f, 0.9f, 0.3f, IM_COL32(170, 156, 110, 255)});   // sandbag rim
        v.push_back({2.6f, 4.6f, -0.3f, 0.3f, 0.9f, 2.9f, IM_COL32(170, 156, 110, 255)});
        break;
    case UiIcon::Light:
        v.push_back({0, 0, 0, 1.4f, 0.3f, 1.4f, cSteel});
        v.push_back({0.5f, 0.3f, 0.5f, 0.35f, 4.4f, 0.35f, cSteel});
        v.push_back({0.1f, 4.7f, 0.1f, 1.2f, 0.7f, 1.2f, IM_COL32(252, 236, 150, 255)});
        break;
    case UiIcon::Generator:
        v.push_back({0, 0, 0, 3.0f, 1.8f, 2.0f, IM_COL32(196, 164, 60, 255)});
        v.push_back({0.4f, 1.8f, 0.4f, 1.4f, 0.4f, 1.2f, cGun});
        v.push_back({2.2f, 1.8f, 0.5f, 0.3f, 0.9f, 0.3f, cGun});
        break;
    case UiIcon::Fuel:
        v.push_back({0, 0, 0, 1.8f, 2.6f, 0.9f, cRed});
        v.push_back({0.3f, 2.6f, 0.2f, 1.2f, 0.3f, 0.5f, shade(cRed, 0.8f)});
        v.push_back({1.3f, 2.6f, 0.3f, 0.3f, 0.6f, 0.3f, cGun});
        break;
    case UiIcon::Barricade:
        v.push_back({0, 0, 0, 3.6f, 0.8f, 1.2f, IM_COL32(170, 156, 110, 255)});
        v.push_back({0.4f, 0.8f, 0, 2.8f, 0.8f, 1.2f, IM_COL32(158, 146, 100, 255)});
        break;
    case UiIcon::Garrison:
    case UiIcon::Hospital:
        v.push_back({0, 0, 0, 3.0f, 3.4f, 2.6f, IM_COL32(150, 140, 120, 255)});
        v.push_back({0.4f, 3.4f, 0.4f, 0.2f, 2.2f, 0.2f, cSteel});
        v.push_back({0.6f, 4.6f, 0.4f, 1.6f, 1.0f, 0.1f, icon == UiIcon::Garrison ? cOlive : cWhite});
        if (icon == UiIcon::Hospital) v.push_back({1.1f, 4.9f, 0.5f, 0.6f, 0.4f, 0.05f, IM_COL32(60, 170, 70, 255)});
        break;
    case UiIcon::Build:
        v.push_back({0, 0, 0, 2.4f, 0.8f, 1.0f, cStone});
        v.push_back({1.6f, 0.8f, 0.3f, 0.3f, 2.6f, 0.3f, cWood});
        v.push_back({1.0f, 3.2f, 0.1f, 1.4f, 0.6f, 0.7f, cSteel});
        break;
    default: break;
    }
    if (!v.empty()) { drawBoxes(dl, v, cx, cy, size, on); return; }
    // flat glyphs (orders)
    const ImU32 c = on ? (accent ? (ImU32)accent : kSand) : kFaint;
    const float r = size * 0.38f;
    switch (icon) {
    case UiIcon::Halt: dl->AddRectFilled(ImVec2(cx - r * 0.8f, cy - r * 0.8f), ImVec2(cx + r * 0.8f, cy + r * 0.8f), c, 1.5f * S); break;
    case UiIcon::Run:
        dl->AddTriangleFilled(ImVec2(cx - r, cy - r), ImVec2(cx, cy), ImVec2(cx - r, cy + r), c);
        dl->AddTriangleFilled(ImVec2(cx, cy - r), ImVec2(cx + r, cy), ImVec2(cx, cy + r), c);
        break;
    case UiIcon::Walk: dl->AddTriangleFilled(ImVec2(cx - r * 0.6f, cy - r), ImVec2(cx + r * 0.7f, cy), ImVec2(cx - r * 0.6f, cy + r), c); break;
    case UiIcon::Burn:
        dl->AddTriangleFilled(ImVec2(cx, cy - r * 1.2f), ImVec2(cx + r * 0.8f, cy + r), ImVec2(cx - r * 0.8f, cy + r), on ? cFlame : c);
        dl->AddTriangleFilled(ImVec2(cx, cy - r * 0.2f), ImVec2(cx + r * 0.4f, cy + r), ImVec2(cx - r * 0.4f, cy + r), on ? cFlame2 : c);
        break;
    case UiIcon::Undo:
        dl->PathArcTo(ImVec2(cx, cy), r * 0.8f, -kPi * 0.9f, kPi * 0.6f, 16);
        dl->PathStroke(c, 0, 2.f * S);
        dl->AddTriangleFilled(ImVec2(cx - r * 1.2f, cy - r * 0.1f), ImVec2(cx - r * 0.4f, cy - r * 0.1f), ImVec2(cx - r * 0.8f, cy - r * 0.8f), c);
        break;
    default: dl->AddCircle(ImVec2(cx, cy), r, c, 12, 1.5f * S); break;
    }
}

// ---- registration -------------------------------------------------------------------------------------------------
void GameUI::registerAction(UiAction a) {
    if (a.hotkeyLabel.empty() && a.hotkey) a.hotkeyLabel = keyLabel(a.hotkey);
    for (UiAction& b : actions_) if (b.id == a.id) { b = std::move(a); return; }
    actions_.push_back(std::move(a));
    std::stable_sort(actions_.begin(), actions_.end(), [](const UiAction& x, const UiAction& y) {
        return x.category != y.category ? x.category < y.category : x.order < y.order;
    });
}
void GameUI::registerAction(UiCategory cat, const std::string& id, UiIcon icon, const std::string& label, std::function<int(const UiCtx&)> cost,
                            int hotkey, std::function<void(const UiCtx&)> onSelect, std::function<bool(const UiCtx&, std::string*)> enabled,
                            std::function<std::string(const UiCtx&)> tooltip) {
    UiAction a;
    a.category = cat; a.id = id; a.icon = icon; a.label = label; a.cost = std::move(cost); a.hotkey = hotkey;
    a.onSelect = std::move(onSelect); a.enabled = std::move(enabled); a.tooltip = std::move(tooltip);
    registerAction(std::move(a));
}
void GameUI::unregisterAction(const std::string& id) {
    actions_.erase(std::remove_if(actions_.begin(), actions_.end(), [&](const UiAction& a) { return a.id == id; }), actions_.end());
    selActions_.erase(std::remove_if(selActions_.begin(), selActions_.end(), [&](const UiSelectionAction& a) { return a.id == id; }), selActions_.end());
}
void GameUI::registerSelectionAction(UiSelectionAction a) {
    if (a.hotkeyLabel.empty() && a.hotkey) a.hotkeyLabel = keyLabel(a.hotkey);
    for (UiSelectionAction& b : selActions_) if (b.id == a.id) { b = std::move(a); return; }
    selActions_.push_back(std::move(a));
    std::stable_sort(selActions_.begin(), selActions_.end(), [](const UiSelectionAction& x, const UiSelectionAction& y) { return x.order < y.order; });
}
void GameUI::registerHoverProvider(const std::string& id, UiHoverProvider p) {
    for (auto& h : hover_) if (h.first == id) { h.second = std::move(p); return; }
    hover_.emplace_back(id, std::move(p));
}
bool GameUI::invokeAction(AppState& app, const GameContext& ctx, CommandQueue& out, const std::string& id) {
    registerBuiltinActions();
    const UiCtx u{app, ctx, *this, out};
    for (const UiAction& a : actions_)
        if (a.id == id) {
            if (a.comingLater || !a.onSelect) return true;
            if (tab_ != a.category) { tab_ = a.category; tabAnim_ = 0.f; barScroll_ = barScrollGoal_ = 0.f; }
            revealId_ = a.id;
            a.onSelect(u);
            return true;
        }
    for (const UiSelectionAction& a : selActions_)
        if (a.id == id) { if (a.onSelect) a.onSelect(u); return true; }
    return false;
}
void GameUI::beginTargeting(const std::string& label, const std::string& hint, std::function<void(const UiCtx&, V3)> fn) {
    tool_ = Tool::Target;
    forced_ = false;
    targetLabel_ = label; targetHint_ = hint; targetFn_ = std::move(fn);
}
void GameUI::notifyAt(const std::string& text, bool bad, double time, V3 pos) {
    notify(text, bad, time);
    notices_.back().hasPos = true;
    notices_.back().pos = pos;
}

// Owner round 15 #11 key scheme: 1-7 (up to 9) = the cards of the active tab in order (the number is drawn on each card),
// Tab / Shift+Tab = next / previous tab. Letter hotkeys of cards are gone (UiAction::hotkey is not bound any more).
const UiAction* GameUI::cardForDigit(int n) const {
    int k = 0;
    for (const UiAction& a : actions_) {
        if (a.category != tab_ || a.comingLater) continue;
        if (k++ == n) return &a;
    }
    return nullptr;
}
int GameUI::digitOf(const UiAction& x) const {
    int k = 0;
    for (const UiAction& a : actions_) {
        if (a.category != tab_ || a.comingLater) continue;
        if (&a == &x) return k < 9 ? k + 1 : 0;
        ++k;
    }
    return 0;
}
bool GameUI::actionHotkey(AppState& app, const GameContext& ctx, const SDL_Event& e, CommandQueue& out) {
    if (e.type != SDL_EVENT_KEY_DOWN || e.key.repeat) return false;
    if (e.key.mod & (SDL_KMOD_CTRL | SDL_KMOD_ALT | SDL_KMOD_GUI)) return false;
    if (SDL_GetModState() & (SDL_KMOD_CTRL | SDL_KMOD_ALT | SDL_KMOD_GUI)) return false;
    const SDL_Keycode key = e.key.key;
    if (key == SDLK_TAB) {
        const int nCat = (int)UiCategory::Count;
        const bool back = ((e.key.mod | SDL_GetModState()) & SDL_KMOD_SHIFT) != 0;
        tab_ = (UiCategory)(((int)tab_ + (back ? nCat - 1 : 1)) % nCat);
        tabAnim_ = 0.f; barScroll_ = barScrollGoal_ = 0.f;
        return true;
    }
    if (key < SDLK_1 || key > SDLK_9) return false;
    const UiCtx u{app, ctx, *this, out};
    if (const UiAction* p = cardForDigit((int)(key - SDLK_1))) {
        const UiAction& a = *p;
        if (!a.onSelect) return true;
        std::string why;
        if (a.enabled && !a.enabled(u, &why)) { notify(a.label + ": " + (why.empty() ? std::string("unavailable") : why), true, now_); return true; }
        if (tab_ != a.category) { tab_ = a.category; tabAnim_ = 0.f; barScroll_ = barScrollGoal_ = 0.f; }
        revealId_ = a.id;
        a.onSelect(u);
    }
    return true;   // an empty slot does nothing (never the sandbox tools)
}

// ---- pause menu (Esc with nothing to cancel; Esc never quits directly) --------------------------------------------
void GameUI::drawPauseMenu(AppState& app) {
    if (!pauseMenu_) return;
    if (!app.paused) { pauseMenu_ = false; return; }   // unpaused elsewhere (Space)
    const ImGuiIO& io = ImGui::GetIO();
    const float w = 220 * S, h = 118 * S;
    const ImVec2 a((io.DisplaySize.x - w) * 0.5f, (io.DisplaySize.y - h) * 0.5f), c(a.x + w, a.y + h);
    ImGui::GetBackgroundDrawList()->AddRectFilled(ImVec2(0, 0), io.DisplaySize, IM_COL32(0, 0, 0, 90));
    if (beginPane("##hud_pause", a, c)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        panel(dl, a, c);
        const ImVec2 ts = tsize(14.f, "PAUSED");
        text(dl, a.x + (w - ts.x) * 0.5f, a.y + 10 * S, kSand, 14.f, "PAUSED");
        const char* labels[2] = {"Resume  (Esc)", "Quit game"};
        for (int k = 0; k < 2; ++k) {
            const ImVec2 ba(a.x + 16 * S, a.y + 36 * S + k * 38 * S), bb(c.x - 16 * S, ba.y + 30 * S);
            bool hov = false;
            if (hit(k ? "##quit" : "##resume", ba, bb, &hov)) {
                if (k) app.quit = true;
                else { pauseMenu_ = false; app.paused = false; }
            }
            dl->AddRectFilled(ba, bb, hov ? kBgHi : kBg, 3 * S);
            dl->AddRect(ba, bb, withA(kEdge, hov ? 1.f : 0.6f), 3 * S);
            const ImVec2 ls = tsize(12.5f, labels[k]);
            text(dl, ba.x + (bb.x - ba.x - ls.x) * 0.5f, ba.y + (30 * S - ls.y) * 0.5f, k ? kBad : kSand, 12.5f, labels[k]);
        }
    }
    ImGui::End();
}

// ---- built-in actions (the B1 purchase cards; FortUI registers walls / gate / engineering) ------------------------
void GameUI::registerBuiltinActions() {
    if (builtins_) return;
    builtins_ = true;
    auto has = [&](const char* id) { for (const UiAction& a : actions_) if (a.id == id) return true; return false; };
    auto toolCard = [&](const char* id, UiCategory cat, UiIcon icon, const char* label, Tool t, int key, int order,
                        std::function<int(const UiCtx&)> cost, const char* tip, const char* hint) {
        if (has(id)) return;
        UiAction a;
        a.id = id; a.category = cat; a.icon = icon; a.label = label; a.hotkey = key; a.order = order; a.cost = std::move(cost);
        a.onSelect = [t](const UiCtx& u) { u.ui.setTool(u.ui.tool() == t ? Tool::Select : t); u.ui.clearForcedFlag(); };
        a.active = [t](const UiCtx& u) { return u.ui.tool() == t; };
        const std::string ts = tip, hs = hint;
        a.tooltip = [ts](const UiCtx&) { return ts; };
        a.placementHint = [hs](const UiCtx&) { return hs; };
        registerAction(std::move(a));
    };
    const char* dropHint = "LMB: drop on a street or flat roof  |  Shift: keep the tool  |  RMB / Esc: cancel";
    auto squadCost = [](SquadType t) { return [t](const UiCtx& u) { return u.ctx.cfg->squad[(size_t)t].price; }; };
    toolCard("unit.rifle", UiCategory::Units, UiIcon::Rifle, "Rifle squad", Tool::BuyRifle, SDLK_Z, 10, squadCost(SquadType::Rifle),
             "Riflemen. General purpose: clearing and defence.", dropHint);
    toolCard("unit.mg", UiCategory::Units, UiIcon::MachineGun, "MG squad", Tool::BuyMG, SDLK_X, 20, squadCost(SquadType::MachineGun),
             "Machine gunners. Sustained fire against dense hordes.\nLoud, high ammo use.", dropHint);
    toolCard("unit.sniper", UiCategory::Units, UiIcon::Sniper, "Sniper", Tool::BuySniper, SDLK_C, 30, squadCost(SquadType::Sniper),
             "Suppressed sniper. Quiet removal of isolated zombies; rooftops.", dropHint);
    toolCard("unit.flame", UiCategory::Units, UiIcon::Flamethrower, "Flamethrowers", Tool::BuyFlame, SDLK_Y, 40, squadCost(SquadType::Flamethrower),
             "Flamethrowers (size PROPOSED). Burn corpse piles: burnt bodies are gone and stop\ngiving off poison gas. Short-range flame cone also burns zombies.\nFuel from containers / crates. Very loud.", dropHint);
    toolCard("unit.engineer", UiCategory::Units, UiIcon::Engineer, "Engineers", Tool::BuyEngineer, SDLK_U, 50, squadCost(SquadType::Engineer),
             "Engineers. They build walls, gates and fortifications and clear cars.\nConstruction is only possible within their radius.", dropHint);
    for (const char* id : {"unit.rifle", "unit.mg", "unit.sniper", "unit.flame", "unit.engineer"})
        for (UiAction& a : actions_)
            if (a.id == id) {
                const SquadType t = a.icon == UiIcon::Rifle ? SquadType::Rifle : a.icon == UiIcon::MachineGun ? SquadType::MachineGun
                                  : a.icon == UiIcon::Sniper ? SquadType::Sniper : a.icon == UiIcon::Flamethrower ? SquadType::Flamethrower : SquadType::Engineer;
                a.badge = [t](const UiCtx& u) { char b[8]; std::snprintf(b, sizeof(b), "x%d", u.ctx.cfg->squad[(size_t)t].size); return std::string(b); };
                const auto base = a.tooltip;
                a.tooltip = [t, base](const UiCtx& u) {
                    const BalanceConfig& c = *u.ctx.cfg;
                    const SquadDef& d = c.squad[(size_t)t];
                    const size_t k = (size_t)d.cls;
                    const WeaponStats& w = c.weapon[k];
                    char b[200];
                    std::snprintf(b, sizeof(b), "\n\n%d soldiers  |  %.0f hp each\nRange %.0f m  |  %.0f rounds/min  |  mag %d + %d",
                                  d.size, c.soldier[k].health, w.range, 60.f / std::max(0.01f, w.fireInterval), w.magazine, w.reserve);
                    return base(u) + b;
                };
            }
    toolCard("sup.container", UiCategory::Supplies, UiIcon::Container, "Ammo container", Tool::PlaceContainer, SDLK_V, 10,
             [](const UiCtx& u) { return u.ctx.cfg->economy.containerPrice; },
             "Central ammunition container (finite stock). Soldiers walk to it to refill.\nArrives by parachute, never disappears and blocks zombies like a wall piece.",
             "LMB: place  |  Q / E / wheel: rotate 15 deg, T: 90  |  RMB / Esc: cancel");
    toolCard("sup.airdrop", UiCategory::Supplies, UiIcon::Airdrop, "Ammo drop", Tool::Airdrop, SDLK_B, 20,
             [](const UiCtx& u) { return u.ctx.cfg->economy.airdropPrice; },
             "Airdrop crate by parachute near your units (finite stock).\nEmpty crates disappear.", "LMB: drop  |  Shift: keep the tool  |  RMB / Esc: cancel");
    if (!has("veh.coming")) {
        UiAction a;
        a.id = "veh.coming"; a.category = UiCategory::Vehicles; a.icon = UiIcon::Vehicle; a.label = "Vehicles"; a.comingLater = true;
        a.tooltip = [](const UiCtx&) { return std::string("Military vehicles are out of scope this phase (GAME_DESIGN 13).\nComing later."); };
        registerAction(std::move(a));
    }
    registerFortActions();   // FortUI.cpp
    // ---- selection context actions
    UiSelectionAction halt;
    halt.id = "sel.halt"; halt.label = "Halt"; halt.icon = UiIcon::Halt; halt.hotkeyLabel = "H"; halt.order = 0;
    halt.visible = [](const UiCtx& u) { return !u.ui.selectionConst().squads.empty(); };
    halt.onSelect = [](const UiCtx& u) { Command c; c.type = CommandType::Stop; c.squads = u.ui.selectionConst().squads; u.out.push(c); };
    halt.tooltip = [](const UiCtx&) { return std::string("Stop and hold here (H)"); };
    registerSelectionAction(halt);
    const char* paceName[3] = {"Auto", "Run", "Walk"};
    const UiIcon paceIcon[3] = {UiIcon::None, UiIcon::Run, UiIcon::Walk};
    const char* paceTip[3] = {"Move orders pick the pace: run when it matters and stamina allows.",
                              "Move orders run (as Shift + RMB). Tires the squad.", "Move orders walk: quiet, careful (as Ctrl + RMB)."};
    for (int k = 0; k < 3; ++k) {
        UiSelectionAction p;
        p.id = std::string("sel.pace.") + paceName[k]; p.label = paceName[k]; p.icon = paceIcon[k]; p.order = 1 + k;
        if (k == 0) p.icon = UiIcon::None;
        p.visible = [](const UiCtx& u) { return !u.ui.selectionConst().squads.empty(); };
        p.active = [k](const UiCtx& u) { return u.ui.movePace == k; };
        p.onSelect = [k](const UiCtx& u) { u.ui.movePace = k; };
        const std::string t = paceTip[k];
        p.tooltip = [t](const UiCtx&) { return t; };
        registerSelectionAction(p);
    }
    auto hasType = [](const UiCtx& u, SquadType t) {
        for (const SquadId& id : u.ui.selectionConst().squads)
            if (const Squad* s = u.ctx.squads->get(id)) if (s->type == t) return true;
        return false;
    };
    UiSelectionAction burn;
    burn.id = "sel.burn"; burn.label = "Burn area"; burn.icon = UiIcon::Burn; burn.order = 20;
    burn.visible = [hasType](const UiCtx& u) { return hasType(u, SquadType::Flamethrower); };
    burn.onSelect = [](const UiCtx& u) {
        u.ui.beginTargeting("Burn area", "LMB: send the flamethrowers onto the corpse pile (they burn it)  |  RMB / Esc: cancel",
                            [](const UiCtx& v, V3 p) {
                                for (const SquadId& id : v.ui.selectionConst().squads) {
                                    const Squad* s = v.ctx.squads->get(id);
                                    if (!s || s->type != SquadType::Flamethrower) continue;
                                    Command c; c.type = CommandType::Move; c.squads = {id}; c.pos = p; v.out.push(c);
                                }
                            });
    };
    burn.tooltip = [](const UiCtx&) { return std::string("Flamethrowers move onto a point and burn the rotting piles there\n(they also seek piles near their post on their own)."); };
    registerSelectionAction(burn);
    struct Eng { const char* id; const char* action; const char* label; UiIcon icon; const char* key; int order; };
    const Eng eng[4] = {{"sel.eng.wall", "struct.wall", "Wall", UiIcon::Wall, "", 30}, {"sel.eng.gate", "struct.gate", "Gate", UiIcon::Gate, "", 31},
                        {"sel.eng.car", "eng.clearcar", "Clear car", UiIcon::ClearCar, "", 32}, {"sel.eng.undo", "eng.undo", "Undo", UiIcon::Undo, "Ctrl+Z", 33}};
    for (const Eng& e : eng) {
        UiSelectionAction s;
        s.id = e.id; s.label = e.label; s.icon = e.icon; s.hotkeyLabel = e.key; s.order = e.order;
        s.visible = [hasType](const UiCtx& u) { return hasType(u, SquadType::Engineer); };
        const std::string act = e.action;
        s.onSelect = [act](const UiCtx& u) { u.ui.invokeAction(u.app, u.ctx, u.out, act); };
        s.active = [act](const UiCtx& u) { for (const UiAction& a : u.ui.actions()) if (a.id == act && a.active) return a.active(u); return false; };
        registerSelectionAction(s);
    }
    // ---- hover: a parked vehicle with engineers selected (clearing; the structures work adds siphon / disassemble)
    registerHoverProvider("car.clear", [hasType](const UiCtx& u, V3 g, float, float, UiHoverMenu& m) {
        if (!hasType(u, SquadType::Engineer) || !u.ctx.cfg) return false;
        const uint32_t v = u.app.vehicles.parkedAt(g.x, g.z, u.ctx.cfg->engineer.carSearch);
        if (v == UINT32_MAX) return false;
        if (!m.key) {
            float cx, cz, hx, hz, yaw;
            u.app.vehicles.groundBox(v, cx, cz, hx, hz, yaw);
            m.title = "Parked vehicle";
            m.anchor = {cx, g.y + 1.6f, cz};
            m.key = 0x100000000ull | v;
        }
        UiHoverEntry e;
        e.label = "Clear (tow away)"; e.icon = UiIcon::ClearCar; e.cost = u.ctx.cfg->engineer.carPrice;
        e.enabled = !(u.ctx.engineers && u.ctx.engineers->carOrdered(v));
        if (!e.enabled) e.why = "already being cleared";
        else if (u.ctx.engineers && !u.ctx.engineers->inRange(u.ctx, m.anchor.x, m.anchor.z)) { e.enabled = false; e.why = "outside engineer range"; }
        const V3 at{m.anchor.x, g.y, m.anchor.z};
        e.onClick = [at](const UiCtx& w) { Command c; c.type = CommandType::ClearCar; c.pos = at; w.out.push(c); };
        m.entries.push_back(e);
        return true;
    });
}

// ---- events -> feed (squad under attack / out of ammo / casualties, breaches) -------------------------------------
void GameUI::watchEvents(const GameContext& ctx) {
    if (!ctx.squads || !ctx.soldiers) return;
    const SoldierPool& P = *ctx.soldiers;
    const size_t n = ctx.squads->squads.size();
    prevFlags_.resize(n, 0); prevAlive_.resize(n, -1); lastAttackNote_.resize(n, -100.0);
    auto centre = [&](const Squad& s) {
        V3 c{}; int k = 0;
        for (const SoldierId& m : s.members) if (P.valid(m) && P.alive(m.index)) { c = c + P.pos[m.index]; ++k; }
        return k ? c * (1.f / (float)k) : c;
    };
    auto name = [](const Squad& s) {
        const char* t = s.type == SquadType::Rifle ? "Rifle squad" : s.type == SquadType::MachineGun ? "MG squad" : s.type == SquadType::Sniper ? "Sniper"
                      : s.type == SquadType::Flamethrower ? "Flamethrowers" : "Engineers";
        char b[48]; std::snprintf(b, sizeof(b), "%s %u", t, s.number); return std::string(b);
    };
    for (size_t k = 0; k < n; ++k) {
        const Squad& s = ctx.squads->squads[k];
        const uint32_t f = s.flags, was = prevFlags_[k];
        const int alive = ctx.squads->aliveMembers(s, P);
        if (!s.deploying && alive > 0) {
            if ((f & SQ_UNDER_ATTACK) && !(was & SQ_UNDER_ATTACK) && now_ - lastAttackNote_[k] > 20.0) {
                notifyAt(name(s) + " under attack", true, now_, centre(s));
                lastAttackNote_[k] = now_;
            }
            if ((f & SQ_OUT_OF_AMMO) && !(was & SQ_OUT_OF_AMMO)) notifyAt(name(s) + " out of ammo", true, now_, centre(s));
            if (prevAlive_[k] > alive) notifyAt(name(s) + (alive ? " lost a soldier" : " wiped out"), true, now_, centre(s));
        }
        prevFlags_[k] = f;
        prevAlive_[k] = alive;
    }
    if (ctx.walls) {
        const auto& R = ctx.walls->rubble();
        if (R.size() > rubbleCount_)
            for (size_t k = rubbleCount_; k < R.size(); ++k)
                if (R[k].t < 2.f) notifyAt("Wall breached", true, now_, {R[k].box.cx, R[k].y, R[k].box.cz});
        rubbleCount_ = R.size();
    }
}

// ---- top bar ------------------------------------------------------------------------------------------------------
void GameUI::drawTopBar(AppState& app, const GameContext& ctx) {
    const Economy& eco = *ctx.economy;
    const ImGuiIO& io = ImGui::GetIO();
    const float W = io.DisplaySize.x;
    const double funds = std::floor(eco.funding());
    if (fundShown_ < 0) fundShown_ = funds;
    if (funds != fundShown_) {
        if (std::fabs(funds - fundShown_) >= 1.0 && fundFlashT_ < ImGui::GetTime() - 0.5) { fundFlashDir_ = funds > fundShown_ ? 1 : -1; fundFlashT_ = ImGui::GetTime(); }
        fundShown_ = std::fabs(funds - fundShown_) < 2.0 || !app.window ? funds : fundShown_ + (funds - fundShown_) * std::min(1.0, (double)dtUi * 10.0);
    }
    struct Seg { std::string label, value, extra; ImU32 vcol, xcol; std::string tip; int icon; };
    std::vector<Seg> segs;
    char b[96], x[64];
    std::snprintf(b, sizeof(b), "%s", money((int)fundShown_).c_str());
    std::snprintf(x, sizeof(x), "+%.0f/min", eco.incomePerMinute());
    const float flash = std::clamp(1.f - (float)(ImGui::GetTime() - fundFlashT_) / 0.8f, 0.f, 1.f);
    segs.push_back({"FUNDING", b, x, mix(kSand, fundFlashDir_ > 0 ? kOk : kBad, flash), kOk,
                    "Funding. Income: passive + kills (UNAPPROVED values).", 0});
    std::snprintf(b, sizeof(b), "%llu", (unsigned long long)eco.kills());
    segs.push_back({"KILLS", b, "", kSand, kSand, "Zombies killed (rewarded once each).", 0});
    int alive = 0, total = 0;
    if (ctx.soldiers) for (uint32_t i = 0; i < (uint32_t)ctx.soldiers->capacity(); ++i) if (ctx.soldiers->used[i]) { ++total; alive += ctx.soldiers->alive(i) ? 1 : 0; }
    std::snprintf(b, sizeof(b), "%d", alive);
    x[0] = 0;
    if (total > alive) std::snprintf(x, sizeof(x), "-%d", total - alive);
    segs.push_back({"TROOPS", b, x, kSand, kBad, "Soldiers alive (losses).", 0});
    if (ctx.territory) {
        const float a = ctx.territory->controlledArea();
        if (a >= 10000.f) std::snprintf(b, sizeof(b), "%.2f ha", a / 10000.f); else std::snprintf(b, sizeof(b), "%.0f m2", a);
        int threatened = 0, uncleared = 0;
        for (const Region& r : ctx.territory->regions()) { threatened += r.state == RegionState::Threatened; uncleared += r.state == RegionState::Uncleared; }
        x[0] = 0;
        ImU32 xc = kOk;
        if (threatened) { std::snprintf(x, sizeof(x), "%d threatened", threatened); xc = kBad; }
        else if (uncleared) { std::snprintf(x, sizeof(x), "%d to clear", uncleared); xc = kAmber; }
        else if (ctx.economy->territoryPerMinute() > 0) std::snprintf(x, sizeof(x), "+%.0f/min", ctx.economy->territoryPerMinute());
        char tip[256];
        std::snprintf(tip, sizeof(tip), "Controlled territory: fully enclosed by walls / containers / buildings and cleared of zombies.\n"
                      "Income per controlled area (UNAPPROVED). Zombies inside pause it; after %.0f s the area is lost (PROPOSED).", ctx.cfg->fort.lossTime);
        segs.push_back({"TERRITORY", b, x, kSand, xc, tip, 0});
    }
    const float hours = std::isfinite(app.renderSettings.tod.hours) ? app.renderSettings.tod.hours : 12.f;
    const bool night = hours < 6.f || hours >= 18.f;
    std::snprintf(b, sizeof(b), "%02d:%02d", (int)hours % 24, (int)((hours - std::floor(hours)) * 60.f));
    const int t = (int)ctx.time;
    std::snprintf(x, sizeof(x), "T+%02d:%02d", t / 60, t % 60);
    segs.push_back({night ? "NIGHT" : "DAY", b, x, kSand, kDim, night ? "Night: 18:00 - 06:00 (7 real minutes).\nT+ is the operation time." : "Day: 06:00 - 18:00 (20 real minutes).\nT+ is the operation time.", night ? 2 : 1});
    if (!ctx.cfg->approved()) segs.push_back({"", "UNAPPROVED", "", kAmber, kAmber, "All prices, rates and weapon stats are provisional playtest values\n(config/balance.json status: " + ctx.cfg->status + ")", 0});
    // measure; narrow windows drop the labels, then the extras
    const float padX = 10 * S, gap = 16 * S, h = 26 * S;
    auto measure = [&](bool labels, bool extras) {
        float w = 2 * padX;
        for (size_t k = 0; k < segs.size(); ++k) {
            const Seg& s = segs[k];
            if (k) w += gap;
            if (labels && !s.label.empty()) w += tsize(10.5f, s.label.c_str()).x + 5 * S;
            if (s.icon) w += 14 * S;
            w += tsize(14.f, s.value.c_str()).x;
            if (extras && !s.extra.empty()) w += 4 * S + tsize(12.f, s.extra.c_str()).x;
        }
        return w;
    };
    bool labels = true, extras = true;
    float w = measure(true, true);
    if (w > W - 16 * S) { labels = false; w = measure(false, true); }
    if (w > W - 16 * S) { extras = false; w = measure(false, false); }
    const ImVec2 a((W - w) * 0.5f, 6 * S), c(a.x + w, a.y + h);
    layout_.topBarBottom = c.y;
    hudRects_.insert(hudRects_.end(), {a.x, a.y, c.x, c.y});
    if (beginPane("##hud_top", a, c)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        panel(dl, a, c);
        float px = a.x + padX;
        for (size_t k = 0; k < segs.size(); ++k) {
            const Seg& s = segs[k];
            const float x0 = px;
            if (k) { dl->AddCircleFilled(ImVec2(px + gap * 0.5f - gap, a.y + h * 0.5f), 1.5f * S, kFaint); }
            if (labels && !s.label.empty()) {
                text(dl, px, a.y + (h - 10.5f * S) * 0.5f + S, kDim, 10.5f, s.label.c_str());
                px += tsize(10.5f, s.label.c_str()).x + 5 * S;
            }
            if (s.icon) {   // sun / moon
                const ImVec2 ic(px + 5 * S, a.y + h * 0.5f);
                if (s.icon == 1) {
                    dl->AddCircleFilled(ic, 3.5f * S, kAmber, 12);
                    for (int r = 0; r < 8; ++r) { const float an = r * kPi / 4; dl->AddLine(ImVec2(ic.x + std::cos(an) * 5 * S, ic.y + std::sin(an) * 5 * S), ImVec2(ic.x + std::cos(an) * 6.5f * S, ic.y + std::sin(an) * 6.5f * S), kAmber, 1.f); }
                } else {
                    dl->AddCircleFilled(ic, 5 * S, IM_COL32(200, 210, 230, 255), 16);
                    dl->AddCircleFilled(ImVec2(ic.x + 2.5f * S, ic.y - 1.5f * S), 4.4f * S, kBg, 16);
                }
                px += 14 * S;
            }
            text(dl, px, a.y + (h - 14 * S) * 0.5f, s.vcol, 14.f, s.value.c_str());
            px += tsize(14.f, s.value.c_str()).x;
            if (extras && !s.extra.empty()) {
                px += 4 * S;
                text(dl, px, a.y + (h - 12 * S) * 0.5f + S, s.xcol, 12.f, s.extra.c_str());
                px += tsize(12.f, s.extra.c_str()).x;
            }
            if (!s.tip.empty() && ImGui::IsMouseHoveringRect(ImVec2(x0, a.y), ImVec2(px, c.y))) { tipBegin(); ImGui::TextUnformatted(s.tip.c_str()); tipEnd(); }
            px += gap;
        }
    }
    ImGui::End();
}

// ---- notification feed (top right) --------------------------------------------------------------------------------
void GameUI::drawNotices(AppState& app, const GameContext& ctx) {
    const ImGuiIO& io = ImGui::GetIO();
    const float W = io.DisplaySize.x;
    const float life = 7.f, rowH = 20 * S, w = std::min(hudsz::noticeW * S, W * 0.42f);
    std::vector<const UiNotice*> live;
    for (auto it = notices_.rbegin(); it != notices_.rend() && live.size() < 6; ++it) {
        const float age = (float)(now_ - it->time);
        if (age <= life && age >= -1.f) live.push_back(&*it);
    }
    float y = layout_.topBarBottom + 8 * S + (tool_ != Tool::Select ? 44 * S : 0.f);   // below the placement banner while placing
    const float x1 = W - 10 * S, x0 = x1 - w;
    if (!live.empty()) {
        hudRects_.insert(hudRects_.end(), {x0, y, x1, y + (rowH + 3 * S) * (float)live.size()});
        if (beginPane("##hud_feed", ImVec2(x0, y), ImVec2(x1, y + (rowH + 3 * S) * (float)live.size()))) {
            ImDrawList* dl = ImGui::GetWindowDrawList();
            int k = 0;
            for (const UiNotice* n : live) {
                const float age = (float)(now_ - n->time);
                const float a = std::clamp(life - age, 0.f, 1.f) * (k == 0 ? 1.f : 0.92f);
                const float slide = app.window ? std::clamp(1.f - age / 0.25f, 0.f, 1.f) : 0.f;
                std::string t = n->text;
                if (n->repeat > 1) t += "  x" + std::to_string(n->repeat);
                const float tw = w - 26 * S;   // fixed row width: long text is cut, short text leaves the row as is
                const float rx1 = x1 + slide * 40 * S, rx0 = rx1 - w;
                const ImVec2 ra(rx0, y), rb(rx1, y + rowH);
                char id[16]; std::snprintf(id, sizeof(id), "##n%d", k);
                bool hov = false;
                const bool clicked = hit(id, ra, rb, &hov);
                dl->AddRectFilled(ra, rb, withA(hov && n->hasPos ? kBgHi : kBg, a), 3 * S);
                dl->AddRectFilled(ra, ImVec2(ra.x + 3 * S, rb.y), withA(n->bad ? kBad : kKhaki, a), 3 * S, ImDrawFlags_RoundCornersLeft);
                text(dl, ra.x + 10 * S, y + (rowH - 12.5f * S) * 0.5f, withA(n->bad ? IM_COL32(240, 150, 130, 255) : kSand, a), 12.5f, fit(12.5f, t, tw + 1).c_str());
                if (n->hasPos) {   // "jump" chevron
                    const float cx = rb.x - 8 * S, cy = y + rowH * 0.5f;
                    dl->AddTriangleFilled(ImVec2(cx - 3 * S, cy - 4 * S), ImVec2(cx + 2 * S, cy), ImVec2(cx - 3 * S, cy + 4 * S), withA(hov ? kSand : kFaint, a));
                    if (clicked) app.camera.setGoalTarget(n->pos);
                    if (hov) { tipBegin(); ImGui::TextUnformatted("Click: move the camera there"); tipEnd(); }
                }
                y += rowH + 3 * S;
                ++k;
            }
        }
        ImGui::End();
    }
    // squads outside the simulated window (B1 limitation, GAMEPLAY_ARCHITECTURE 3.6): a persistent amber line
    if (ctx.horde && ctx.squads && ctx.soldiers) {
        int out = 0;
        for (const Squad& s : ctx.squads->squads) {
            V3 c{}; int a = 0;
            for (const SoldierId& m : s.members) if (ctx.soldiers->valid(m) && ctx.soldiers->alive(m.index)) { c = c + ctx.soldiers->pos[m.index]; ++a; }
            if (a && !ctx.horde->simulated(c.x / a, c.z / a)) ++out;
        }
        if (out) {
            char t[96];
            std::snprintf(t, sizeof(t), "%d squad%s outside the simulated area (holding)", out, out > 1 ? "s" : "");
            ImDrawList* dl = ImGui::GetForegroundDrawList();
            const ImVec2 ts = tsize(12.5f, t);
            const float x = x1 - ts.x - 12 * S;
            dl->AddRectFilled(ImVec2(x - 6 * S, y), ImVec2(x1, y + rowH), kBg, 3 * S);
            text(dl, x, y + (rowH - ts.y) * 0.5f, kAmber, 12.5f, t);
        }
    }
}

// ---- command bar (bottom centre) ----------------------------------------------------------------------------------
void GameUI::drawBuildBar(AppState& app, const GameContext& ctx, CommandQueue& out) {
    const ImGuiIO& io = ImGui::GetIO();
    const float W = io.DisplaySize.x, H = io.DisplaySize.y;
    const UiCtx u{app, ctx, *this, out};
    const int nCat = (int)UiCategory::Count;
    const float cardW = hudsz::cardW * S, cardH = hudsz::cardH * S, gap = hudsz::cardGap * S, pad = 6 * S, tabH = 22 * S, arrowW = 16 * S, margin = 8 * S;
    // tabs
    float tabW[8] = {}, tabsW = 0;
    int counts[8] = {};
    for (const UiAction& a : actions_) counts[(int)a.category]++;
    for (int c = 0; c < nCat; ++c) { tabW[c] = tsize(11.5f, uiCategoryName((UiCategory)c)).x + 20 * S; tabsW += tabW[c]; }
    std::vector<const UiAction*> cards;
    for (const UiAction& a : actions_) if (a.category == tab_) cards.push_back(&a);
    const int n = (int)cards.size();
    const float cardsW = n * cardW + std::max(0, n - 1) * gap;
    const float maxW = W - 2 * margin;
    // fixed width (owner round 15 #2): room for hudsz::barCards cards whatever the tab holds, bounded by the window;
    // more cards scroll inside (arrows / wheel), fewer leave the slots empty. Never resizes with the content.
    const float barW = std::min(maxW, std::max(tabsW + 2 * pad, hudsz::barCards * cardW + (hudsz::barCards - 1) * gap + 2 * pad));
    const bool tabsFit = tabsW + 2 * pad <= barW;
    const float barH = tabH + cardH + 2 * pad;
    const ImVec2 a((W - barW) * 0.5f, H - margin - barH), c(a.x + barW, H - margin);
    layout_.barX0 = a.x; layout_.barY0 = a.y; layout_.barX1 = c.x; layout_.barY1 = c.y;
    hudRects_.insert(hudRects_.end(), {a.x, a.y, c.x, c.y});
    const bool scroll = cardsW > barW - 2 * pad;
    const float viewX0 = a.x + pad + (scroll ? arrowW + 2 * S : 0), viewX1 = c.x - pad - (scroll ? arrowW + 2 * S : 0);
    const float maxScroll = std::max(0.f, cardsW - (viewX1 - viewX0));
    // reveal a card chosen by hotkey
    if (!revealId_.empty()) {
        for (int k = 0; k < n; ++k)
            if (cards[(size_t)k]->id == revealId_) {
                const float l = k * (cardW + gap), r = l + cardW;
                if (l < barScrollGoal_) barScrollGoal_ = l;
                if (r > barScrollGoal_ + (viewX1 - viewX0)) barScrollGoal_ = r - (viewX1 - viewX0);
            }
        revealId_.clear();
    }
    barScrollGoal_ = std::clamp(barScrollGoal_, 0.f, maxScroll);
    barScroll_ = app.window ? approach(barScroll_, barScrollGoal_, 14.f) : barScrollGoal_;
    tabAnim_ = app.window ? approach(tabAnim_, 1.f, 10.f) : 1.f;
    if (beginPane("##hud_bar", a, c)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        panel(dl, ImVec2(a.x, a.y + tabH), c);
        // ---- tabs: folder tabs over the panel; narrow windows shrink them to equal widths (labels cut)
        float tx = a.x + pad;
        const float tscale = tabsFit ? 1.f : (barW - 2 * pad) / tabsW;
        for (int k = 0; k < nCat; ++k) {
            const UiCategory cat = (UiCategory)k;
            const float w = tabW[k] * tscale;
            const ImVec2 ta(tx, a.y), tb(tx + w - 2 * S, a.y + tabH);
            char id[16]; std::snprintf(id, sizeof(id), "##tab%d", k);
            bool hov = false;
            if (hit(id, ta, tb, &hov) && tab_ != cat) { tab_ = cat; tabAnim_ = 0.f; barScrollGoal_ = barScroll_ = 0.f; }
            const bool sel = tab_ == cat;
            const bool later = counts[k] > 0 && std::all_of(actions_.begin(), actions_.end(), [&](const UiAction& x) { return x.category != cat || x.comingLater; });
            if (sel || hov) dl->AddRectFilled(ta, ImVec2(tb.x, tb.y + 1), sel ? kBg : withA(kBg, 0.6f), 4 * S, ImDrawFlags_RoundCornersTop);
            else dl->AddRectFilled(ImVec2(ta.x, ta.y + 3 * S), ImVec2(tb.x, tb.y), withA(kBg, 0.45f), 4 * S, ImDrawFlags_RoundCornersTop);
            const std::string lab = fit(11.5f, uiCategoryName(cat), w - 10 * S);
            const ImVec2 ls = tsize(11.5f, lab.c_str());
            text(dl, ta.x + (tb.x - ta.x - ls.x) * 0.5f, ta.y + (tabH - ls.y) * 0.5f + S, sel ? kSand : later ? kFaint : hov ? kSand : kDim, 11.5f, lab.c_str());
            if (sel) {   // animated underline
                if (tabIndX_ < 0) { tabIndX_ = ta.x; tabIndW_ = tb.x - ta.x; }
                tabIndX_ = app.window ? approach(tabIndX_, ta.x, 16.f) : ta.x;
                tabIndW_ = app.window ? approach(tabIndW_, tb.x - ta.x, 16.f) : tb.x - ta.x;
            }
            if (hov && later) { tipBegin(); ImGui::TextUnformatted("Coming later"); tipEnd(); }
            tx += w;
        }
        dl->AddRectFilled(ImVec2(tabIndX_ + 6 * S, a.y + tabH - 2 * S), ImVec2(tabIndX_ + tabIndW_ - 6 * S, a.y + tabH), kKhaki, S);
        // ---- cards
        const float cy0 = a.y + tabH + pad;
        if (ImGui::IsWindowHovered(ImGuiHoveredFlags_AllowWhenBlockedByActiveItem) && io.MouseWheel != 0.f && scroll)
            barScrollGoal_ = std::clamp(barScrollGoal_ - io.MouseWheel * (cardW + gap), 0.f, maxScroll);
        if (scroll) {
            for (int side = 0; side < 2; ++side) {
                const ImVec2 aa(side ? c.x - pad - arrowW : a.x + pad, cy0), bb(aa.x + arrowW, cy0 + cardH);
                const bool can = side ? barScrollGoal_ < maxScroll - 0.5f : barScrollGoal_ > 0.5f;
                bool hov = false;
                if (hit(side ? "##right" : "##left", aa, bb, &hov) && can)
                    barScrollGoal_ = std::clamp(barScrollGoal_ + (side ? 1.f : -1.f) * (cardW + gap) * 2.f, 0.f, maxScroll);
                dl->AddRectFilled(aa, bb, hov && can ? kBgHi : withA(kBgHi, 0.5f), 3 * S);
                const float mx = (aa.x + bb.x) * 0.5f, my = (aa.y + bb.y) * 0.5f, r = 4 * S;
                const ImU32 col = can ? kSand : kFaint;
                if (side) dl->AddTriangleFilled(ImVec2(mx - r * 0.6f, my - r), ImVec2(mx + r * 0.6f, my), ImVec2(mx - r * 0.6f, my + r), col);
                else dl->AddTriangleFilled(ImVec2(mx + r * 0.6f, my - r), ImVec2(mx - r * 0.6f, my), ImVec2(mx + r * 0.6f, my + r), col);
            }
        }
        dl->PushClipRect(ImVec2(viewX0, cy0 - 3 * S), ImVec2(viewX1, cy0 + cardH + 2 * S), true);
        const float fade = tabAnim_, lift = (1.f - tabAnim_) * 8 * S;
        // left-aligned (slot k = number key k+1), scrolled when they do not fit
        const float startX = viewX0 - (scroll ? barScroll_ : 0.f);
        for (int k = 0; k < n; ++k) {
            const UiAction& A = *cards[(size_t)k];
            const float x = startX + k * (cardW + gap);
            if (x + cardW < viewX0 - 1 || x > viewX1 + 1) continue;
            std::string why;
            const int cost = A.cost ? A.cost(u) : -1;
            bool en = !A.comingLater && (!A.enabled || A.enabled(u, &why));
            const bool afford = cost < 0 || ctx.economy->canAfford(cost);
            if (en && !afford) { en = false; why = "Not enough funding"; }
            const bool act = A.active && A.active(u);
            const ImVec2 ka(std::max(x, viewX0), cy0 + lift), kb(std::min(x + cardW, viewX1), cy0 + cardH + lift);
            char id[64]; std::snprintf(id, sizeof(id), "##card_%s", A.id.c_str());
            bool hov = false;
            if (hit(id, ka, kb, &hov) && en && A.onSelect) A.onSelect(u);
            const bool tipForced = !forceTip.empty() && forceTip == A.id;
            const float up = (hov && en) ? 2 * S : 0.f;
            const ImVec2 p0(x, cy0 + lift - up), p1(x + cardW, cy0 + cardH + lift - up);
            const ImU32 bg = act ? IM_COL32(86, 80, 44, 240) : hov ? IM_COL32(44, 48, 32, 240) : IM_COL32(30, 33, 23, 235);
            dl->AddRectFilled(p0, p1, withA(bg, fade), 4 * S);
            dl->AddRect(p0, p1, withA(act ? kKhaki : hov ? kEdge : withA(kEdge, 0.6f), fade), 4 * S, 0, act ? 2.f : 1.f);
            // icon
            const float iconBox = 34 * S;
            const ImVec2 ic(x + cardW * 0.5f, p0.y + 4 * S + iconBox * 0.5f);
            dl->AddRectFilled(ImVec2(x + 4 * S, p0.y + 4 * S), ImVec2(x + cardW - 4 * S, p0.y + 4 * S + iconBox), withA(IM_COL32(12, 14, 9, 150), fade), 3 * S);
            if (A.painter) A.painter(dl, ic.x, ic.y, iconBox * 0.82f, en || (!afford && !A.comingLater));
            else drawUiIcon(dl, A.icon, ic.x, ic.y, iconBox * 0.82f, en || (!afford && !A.comingLater), A.accent);
            if (A.badge) {
                const std::string bdg = A.badge(u);
                text(dl, x + 7 * S, p0.y + 6 * S, withA(kDim, fade), 10.5f, bdg.c_str(), true);
            }
            // name
            const float npx = tsize(11.5f, A.label.c_str()).x <= cardW - 8 * S ? 11.5f : 10.f;   // long names: smaller, then cut
            const std::string nm = fit(npx, A.label, cardW - 6 * S);
            const ImVec2 ns = tsize(npx, nm.c_str());
            text(dl, x + (cardW - ns.x) * 0.5f, p0.y + 6 * S + iconBox + (11.5f - npx) * S, withA(A.comingLater ? kFaint : en || !afford ? kSand : kDim, fade), npx, nm.c_str());
            // cost (left) / number key badge (right)
            const float by = p1.y - 15 * S;
            const int dg = digitOf(A);
            const std::string keyLab = dg ? std::to_string(dg) : std::string();
            if (A.comingLater) text(dl, x + 6 * S, by, withA(kFaint, fade), 10.5f, "coming later");
            else if (cost >= 0) {
                const std::string cs = money(cost) + A.costSuffix;
                text(dl, x + 6 * S, by, withA(afford ? kKhaki : kBad, fade), 11.f, fit(11.f, cs, cardW - 28 * S).c_str());
            }
            if (!keyLab.empty() && !A.comingLater) {
                const ImVec2 hs = tsize(10.5f, keyLab.c_str());
                const ImVec2 ha(x + cardW - 6 * S - hs.x - 6 * S, by - S), hb(x + cardW - 5 * S, by + hs.y + S);
                dl->AddRectFilled(ha, hb, withA(IM_COL32(60, 64, 44, 255), fade), 2 * S);
                text(dl, ha.x + 3 * S, by, withA(kSand, fade), 10.5f, keyLab.c_str());
            }
            if (!en && !A.comingLater && afford) dl->AddRectFilled(p0, p1, withA(IM_COL32(10, 10, 8, 90), fade), 4 * S);   // unavailable veil
            if ((hov || tipForced) && (fade > 0.5f)) {
                if (tipForced) ImGui::SetNextWindowPos(ImVec2(x, p0.y - 8 * S), ImGuiCond_Always, ImVec2(0.f, 1.f));
                tipBegin();
                ImGui::PushFont(F, 14.f);
                ImGui::TextColored(v4(kSand), "%s", A.label.c_str());
                ImGui::PopFont();
                if (cost >= 0 || !keyLab.empty()) {
                    // custom combos a feature handles itself ("Ctrl+Z") are listed next to the number key
                    std::string keys = keyLab;
                    if (A.hotkeyLabel.find('+') != std::string::npos) keys += (keys.empty() ? "" : " / ") + A.hotkeyLabel;
                    ImGui::SameLine();
                    ImGui::TextColored(v4(kKhaki), "%s%s%s%s", cost >= 0 ? money(cost).c_str() : "", A.costSuffix.c_str(), keys.empty() ? "" : "   [",
                                       keys.empty() ? "" : (keys + "]").c_str());
                }
                if (A.tooltip) { const std::string t = A.tooltip(u); ImGui::PushStyleColor(ImGuiCol_Text, v4(kDim)); ImGui::TextUnformatted(t.c_str()); ImGui::PopStyleColor(); }
                if (!why.empty() && !A.comingLater) ImGui::TextColored(v4(kBad), "%s", why.c_str());
                tipEnd();
            }
        }
        dl->PopClipRect();
    }
    ImGui::End();
}

// ---- selection panel (left column, above the command bar unless it fits beside it) --------------------------------
void GameUI::drawSelection(AppState& app, const GameContext& ctx, CommandQueue& out) {
    const ImGuiIO& io = ImGui::GetIO();
    const float W = io.DisplaySize.x, H = io.DisplaySize.y;
    const float pw = std::min(hudsz::selW * S, W - 20 * S), px = 10 * S;
    // beside the bar when the left column is clear of it, else stacked above it
    const bool beside = px + pw + 8 * S < layout_.barX0;
    const float bottom = beside ? H - 8 * S : layout_.barY0 - 8 * S;
    layout_.panelX = px;
    layout_.panelMaxW = pw;
    layout_.panelBottom = bottom;
    if (sel_.squads.empty() || !ctx.squads || !ctx.soldiers) { panelAnim_ = 0.f; return; }
    panelAnim_ = app.window ? approach(panelAnim_, 1.f, 12.f) : 1.f;
    const SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = *ctx.cfg;
    const UiCtx u{app, ctx, *this, out};
    std::vector<const Squad*> sq;
    for (const SquadId& id : sel_.squads) if (const Squad* s = ctx.squads->get(id)) sq.push_back(s);
    if (sq.empty()) return;
    const bool detail = sq.size() == 1;
    const float headH = 26 * S, rowH = 15 * S, sumH = 20 * S, pad = 8 * S, actH = 24 * S;
    std::vector<const UiSelectionAction*> acts;
    for (const UiSelectionAction& a : selActions_) if (!a.visible || a.visible(u)) acts.push_back(&a);
    // action buttons flow into rows
    const float abH = actH, abGap = 4 * S;
    std::vector<float> abW;
    auto layoutRows = [&](bool compact) {
        abW.clear();
        for (const UiSelectionAction* a : acts)
            abW.push_back(compact ? (a->icon != UiIcon::None ? 26 * S : tsize(11.5f, a->label.c_str()).x + 14 * S)
                                  : (a->icon != UiIcon::None ? 18 * S : 0) + tsize(11.5f, a->label.c_str()).x + 14 * S +
                                        (a->hotkeyLabel.empty() ? 0 : tsize(10.f, a->hotkeyLabel.c_str()).x + 8 * S));
        int rows = acts.empty() ? 0 : 1;
        float x = 0;
        for (float w : abW) { if (x > 0 && x + w > pw - 2 * pad) { ++rows; x = 0; } x += w + abGap; }
        return rows;
    };
    // fixed size (owner round 15 #2): header + a list area of hudsz::selRows member rows (multi: selSumRows summary rows)
    // + hudsz::selActRows rows of buttons; more buttons than fit -> compact icon buttons (label in the tooltip)
    const bool compactActs = layoutRows(false) > hudsz::selActRows;
    if (compactActs) layoutRows(true);
    const float listH = std::max(rowH * hudsz::selRows, sumH * hudsz::selSumRows) + 4 * S;
    const size_t maxSum = (size_t)hudsz::selSumRows;
    const size_t shown = detail ? 1 : sq.size() > maxSum ? maxSum - 1 : sq.size();
    const float h = pad + headH + listH + hudsz::selActRows * (abH + abGap) + pad;
    const float slide = (1.f - panelAnim_) * -30 * S;
    const ImVec2 a(px + slide, bottom - h), c(px + pw + slide, bottom);
    layout_.panelBottom = a.y - 6 * S;
    hudRects_.insert(hudRects_.end(), {a.x, a.y, c.x, c.y});
    auto stateOf = [](const Squad& s, ImU32& col) {
        const uint32_t f = s.flags;
        col = s.deploying ? kSand : (f & SQ_UNDER_ATTACK) ? kBad : (f & SQ_ENGAGED) ? kAmber : (f & SQ_RESUPPLYING) ? kBlue : (f & SQ_MOVING) ? kOk : kDim;
        return s.deploying ? "DEPLOYING" : (f & SQ_UNDER_ATTACK) ? "UNDER ATTACK" : (f & SQ_ENGAGED) ? "ENGAGING" : (f & SQ_RESUPPLYING) ? "RESUPPLYING"
             : (f & SQ_MOVING) ? "MOVING" : "HOLDING";
    };
    auto icon = [](SquadType t) {
        return t == SquadType::Rifle ? UiIcon::Rifle : t == SquadType::MachineGun ? UiIcon::MachineGun : t == SquadType::Sniper ? UiIcon::Sniper
             : t == SquadType::Flamethrower ? UiIcon::Flamethrower : UiIcon::Engineer;
    };
    auto nameOf = [](SquadType t) {
        return t == SquadType::Rifle ? "RIFLE SQUAD" : t == SquadType::MachineGun ? "MG SQUAD" : t == SquadType::Sniper ? "SNIPER"
             : t == SquadType::Flamethrower ? "FLAMETHROWERS" : "ENGINEERS";
    };
    auto pill = [&](ImDrawList* dl, float x, float y, const char* t, ImU32 col) {   // right-aligned at x
        const ImVec2 ts = tsize(10.f, t);
        const ImVec2 pa(x - ts.x - 10 * S, y), pb(x, y + ts.y + 4 * S);
        dl->AddRectFilled(pa, pb, withA(col, 0.18f), 7 * S);
        dl->AddRect(pa, pb, withA(col, 0.7f), 7 * S, 0, 1.f);
        text(dl, pa.x + 5 * S, y + 2 * S, col, 10.f, t);
        return pa.x;
    };
    if (beginPane("##hud_sel", a, c)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        panel(dl, a, c, panelAnim_);
        float y = a.y + pad;
        if (detail) {
            const Squad& s = *sq[0];
            const int alive = ctx.squads->aliveMembers(s, P);
            dl->AddRectFilled(ImVec2(a.x + pad, y), ImVec2(a.x + pad + headH, y + headH), IM_COL32(12, 14, 9, 170), 3 * S);
            drawUiIcon(dl, icon(s.type), a.x + pad + headH * 0.5f, y + headH * 0.5f, headH * 0.8f, true);
            char t[64];
            std::snprintf(t, sizeof(t), "%s %u", nameOf(s.type), s.number);
            text(dl, a.x + pad + headH + 7 * S, y + S, kSand, 13.5f, t);
            std::snprintf(t, sizeof(t), "%d / %d alive", alive, (int)s.members.size());
            text(dl, a.x + pad + headH + 7 * S, y + 15 * S, alive < (int)s.members.size() ? kBad : kDim, 10.5f, t);
            ImU32 sc;
            const char* st = stateOf(s, sc);
            float rx = pill(dl, c.x - pad, y + 2 * S, st, sc) - 4 * S;
            if (s.flags & SQ_OUT_OF_AMMO) rx = pill(dl, rx, y + 2 * S, "NO AMMO", kBad) - 4 * S;
            else if (s.flags & SQ_LOW_AMMO) rx = pill(dl, rx, y + 2 * S, "LOW AMMO", kAmber) - 4 * S;
            if (s.flags & SQ_GAS) rx = pill(dl, rx, y + 2 * S, "GAS", IM_COL32(160, 200, 50, 255)) - 4 * S;
            y += headH + 4 * S;
            // column headers are implicit: name | health (stamina under it) | ammo | rounds + state
            const float nameW = 62 * S, bw = std::max(40 * S, (pw - 2 * pad - nameW - 120 * S) * 0.5f);
            const float listY0 = y, listY1 = y + listH - 4 * S;
            const float maxScroll = std::max(0.f, rowH * (float)s.members.size() - (listY1 - listY0));
            if (maxScroll > 0.f && ImGui::IsMouseHoveringRect(ImVec2(a.x, listY0), ImVec2(c.x, listY1)) && io.MouseWheel != 0.f)
                selScroll_ -= io.MouseWheel * rowH;
            selScroll_ = std::clamp(selScroll_, 0.f, maxScroll);
            y -= selScroll_;
            dl->PushClipRect(ImVec2(a.x, listY0), ImVec2(c.x, listY1), true);
            for (const SoldierId& m : s.members) {
                if (!P.valid(m)) { y += rowH; continue; }
                const uint32_t i = m.index;
                const size_t k = (size_t)P.cls[i];
                const bool dead = !P.alive(i);
                const float hp = dead ? 0.f : std::clamp(P.health[i] / std::max(1.f, cfg.soldier[k].health), 0.f, 1.f);
                const int full = cfg.weapon[k].magazine + cfg.weapon[k].reserve;
                const float am = std::clamp((float)(P.mag[i] + P.reserve[i]) / (float)std::max(1, full), 0.f, 1.f);
                const float x0 = a.x + pad;
                text(dl, x0, y, dead ? kBad : kDim, 11.f, fit(11.f, s.type == SquadType::Engineer ? "engineer" : className(P.cls[i]), nameW - 4 * S).c_str());
                const float bx = x0 + nameW, byy = y + 4 * S;
                bar(dl, bx, byy, bw, 5 * S, hp, hp > 0.5f ? kOk : hp > 0.25f ? kAmber : kBad);
                if (!dead) {
                    const float stf = std::clamp(P.stamina[i] / std::max(1.f, cfg.stamina.max), 0.f, 1.f);
                    dl->AddRectFilled(ImVec2(bx, byy + 6 * S), ImVec2(bx + bw * stf, byy + 7.5f * S), P.tired[i] ? kAmber : IM_COL32(200, 200, 170, 140));
                }
                const float ax = bx + bw + 6 * S;
                bar(dl, ax, byy, bw, 5 * S, am, am > cfg.soldier[k].lowAmmoFraction ? kBlue : am > 0 ? kAmber : kBad);
                char tx[80];
                if (dead) std::snprintf(tx, sizeof(tx), "KIA");
                else std::snprintf(tx, sizeof(tx), "%d|%d %s%s%s", P.mag[i], P.reserve[i], stateName(P.state[i]), P.runner[i] ? " (runner)" : "", P.wounded[i] ? " (wounded)" : "");
                const float tx0 = ax + bw + 6 * S;
                text(dl, tx0, y, dead ? kBad : kDim, 10.5f, fit(10.5f, tx, c.x - pad - tx0).c_str());
                y += rowH;
            }
            dl->PopClipRect();
            if (maxScroll > 0.f) {   // scroll indicator
                const float th = (listY1 - listY0) * (listY1 - listY0) / (listY1 - listY0 + maxScroll);
                const float ty = listY0 + (listY1 - listY0 - th) * (selScroll_ / maxScroll);
                dl->AddRectFilled(ImVec2(c.x - 4 * S, ty), ImVec2(c.x - 2 * S, ty + th), kFaint, S);
            }
            y = listY0 + listH;
        } else {
            char t[64];
            int alive = 0, total = 0;
            for (const Squad* s : sq) { alive += ctx.squads->aliveMembers(*s, P); total += (int)s->members.size(); }
            std::snprintf(t, sizeof(t), "%d SQUADS", (int)sq.size());
            text(dl, a.x + pad, y + 2 * S, kSand, 13.5f, t);
            std::snprintf(t, sizeof(t), "%d / %d soldiers", alive, total);
            text(dl, a.x + pad, y + 15 * S, alive < total ? kBad : kDim, 10.5f, t);
            y += headH;
            for (size_t k = 0; k < shown; ++k) {
                const Squad& s = *sq[k];
                const ImVec2 ra(a.x + pad, y), rb(c.x - pad, y + sumH - 2 * S);
                char id[32]; std::snprintf(id, sizeof(id), "##sq%zu", k);
                bool hov = false;
                if (hit(id, ra, rb, &hov)) { Command cmd; cmd.type = CommandType::Select; cmd.squads = {s.id}; out.push(cmd); sel_.squads = cmd.squads; }
                if (hov) { dl->AddRectFilled(ra, rb, kBgHi, 3 * S); tipBegin(); ImGui::TextUnformatted("Click: select only this squad"); tipEnd(); }
                drawUiIcon(dl, icon(s.type), ra.x + 9 * S, y + sumH * 0.45f, 16 * S, true);
                std::snprintf(t, sizeof(t), "%s %u", nameOf(s.type), s.number);
                text(dl, ra.x + 22 * S, y + 2 * S, kSand, 11.5f, t);
                float hp = 0, am = 0; int n = 0;
                for (const SoldierId& m : s.members) {
                    if (!P.valid(m) || !P.alive(m.index)) continue;
                    const size_t c2 = (size_t)P.cls[m.index];
                    hp += std::clamp(P.health[m.index] / std::max(1.f, cfg.soldier[c2].health), 0.f, 1.f);
                    am += std::clamp((float)(P.mag[m.index] + P.reserve[m.index]) / (float)std::max(1, cfg.weapon[c2].magazine + cfg.weapon[c2].reserve), 0.f, 1.f);
                    ++n;
                }
                if (n) { hp /= n; am /= n; }
                const float bx = ra.x + 130 * S, bw = std::max(24 * S, (rb.x - bx - 96 * S) * 0.5f);
                bar(dl, bx, y + 5 * S, bw, 5 * S, hp, hp > 0.5f ? kOk : hp > 0.25f ? kAmber : kBad);
                bar(dl, bx + bw + 4 * S, y + 5 * S, bw, 5 * S, am, (s.flags & SQ_OUT_OF_AMMO) ? kBad : (s.flags & SQ_LOW_AMMO) ? kAmber : kBlue);
                ImU32 sc;
                const char* st = stateOf(s, sc);
                pill(dl, rb.x, y + S, st, sc);
                y += sumH;
            }
            if (sq.size() > shown) { std::snprintf(t, sizeof(t), "+ %d more (click a squad to select it alone)", (int)(sq.size() - shown)); text(dl, a.x + pad, y + 3 * S, kFaint, 10.5f, t); }
            y = a.y + pad + headH + listH;
        }
        // ---- orders / context actions
        float x = a.x + pad;
        for (size_t k = 0; k < acts.size(); ++k) {
            const UiSelectionAction& A = *acts[k];
            const float w = abW[k];
            if (x > a.x + pad && x + w > c.x - pad) { x = a.x + pad; y += abH + abGap; }
            std::string why;
            const bool en = !A.enabled || A.enabled(u, &why);
            const bool act = A.active && A.active(u);
            const ImVec2 ba(x, y), bb(x + w, y + abH);
            char id[64]; std::snprintf(id, sizeof(id), "##sa_%s", A.id.c_str());
            bool hov = false;
            if (hit(id, ba, bb, &hov)) {
                if (en && A.onSelect) A.onSelect(u);
                else if (!en) notify(A.label + ": " + (why.empty() ? std::string("unavailable") : why), true, now_);
            }
            dl->AddRectFilled(ba, bb, act ? IM_COL32(86, 80, 44, 240) : hov ? IM_COL32(48, 52, 34, 240) : IM_COL32(32, 35, 24, 235), 3 * S);
            dl->AddRect(ba, bb, act ? kKhaki : withA(kEdge, hov ? 1.f : 0.6f), 3 * S, 0, 1.f);
            float tx = x + 7 * S;
            const bool iconOnly = compactActs && A.icon != UiIcon::None;
            if (A.icon != UiIcon::None) { drawUiIcon(dl, A.icon, iconOnly ? x + w * 0.5f : tx + 7 * S, y + abH * 0.5f, 15 * S, en); tx += 18 * S; }
            if (!iconOnly) {
                text(dl, tx, y + (abH - 11.5f * S) * 0.5f, en ? kSand : kFaint, 11.5f, A.label.c_str());
                tx += tsize(11.5f, A.label.c_str()).x + 5 * S;
                if (!compactActs && !A.hotkeyLabel.empty()) text(dl, tx, y + (abH - 10 * S) * 0.5f + S, kFaint, 10.f, A.hotkeyLabel.c_str());
            }
            if (hov && (A.tooltip || !why.empty() || iconOnly)) {
                tipBegin();
                if (iconOnly) ImGui::TextColored(v4(kSand), "%s%s%s", A.label.c_str(), A.hotkeyLabel.empty() ? "" : "  ", A.hotkeyLabel.c_str());
                if (A.tooltip) ImGui::TextUnformatted(A.tooltip(u).c_str());
                if (!why.empty()) ImGui::TextColored(v4(kBad), "%s", why.c_str());
                tipEnd();
            }
            x += w + abGap;
        }
    }
    ImGui::End();
}

// ---- placement banner ---------------------------------------------------------------------------------------------
void GameUI::drawPlacementBanner(AppState& app, const GameContext& ctx, CommandQueue& out) {
    if (tool_ == Tool::Select) return;
    const UiCtx u{app, ctx, *this, out};
    std::string title, hint;
    int cost = -1;
    std::string suffix;
    if (tool_ == Tool::Target) { title = targetLabel_; hint = targetHint_; }
    else
        for (const UiAction& a : actions_)
            if (a.active && a.active(u)) {
                title = a.label;
                if (a.cost) cost = a.cost(u);
                suffix = a.costSuffix;
                if (a.placementHint) hint = a.placementHint(u);
                break;
            }
    if (title.empty()) return;
    if (hint.empty()) hint = "LMB: place  |  RMB / Esc: cancel";
    const ImGuiIO& io = ImGui::GetIO();
    const float W = io.DisplaySize.x;
    std::string head = "PLACING  " + title;
    if (tool_ == Tool::Target) head = title;
    std::string cs = cost >= 0 ? money(cost) + suffix : "";
    const float hw = tsize(13.f, head.c_str()).x + (cs.empty() ? 0 : tsize(13.f, cs.c_str()).x + 12 * S);
    const float maxW = W - 24 * S;
    std::string h2 = fit(11.f, hint, maxW - 20 * S);
    const float w = std::min(maxW, std::max(hw, tsize(11.f, h2.c_str()).x) + 24 * S);
    const float y = layout_.topBarBottom + 8 * S;
    const ImVec2 a((W - w) * 0.5f, y), c(a.x + w, y + 38 * S);
    hudRects_.insert(hudRects_.end(), {a.x, a.y, c.x, c.y});
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    panel(dl, a, c);
    dl->AddRectFilled(ImVec2(a.x, a.y), ImVec2(c.x, a.y + 2 * S), kKhaki, 4 * S, ImDrawFlags_RoundCornersTop);
    float x = a.x + (w - hw) * 0.5f;
    text(dl, x, a.y + 5 * S, kSand, 13.f, head.c_str());
    if (!cs.empty()) {
        x += tsize(13.f, head.c_str()).x + 12 * S;
        text(dl, x, a.y + 5 * S, ctx.economy->canAfford(cost) ? kKhaki : kBad, 13.f, cs.c_str());
    }
    const ImVec2 hs = tsize(11.f, h2.c_str());
    text(dl, a.x + (w - hs.x) * 0.5f, a.y + 21 * S, kDim, 11.f, h2.c_str());
}

// ---- world hover menu ---------------------------------------------------------------------------------------------
bool GameUI::hoverPrimary(AppState& app, const GameContext& ctx, CommandQueue& out, V3 g, float sx, float sy) {
    const UiCtx u{app, ctx, *this, out};
    UiHoverMenu m;
    for (auto& h : hover_) h.second(u, g, sx, sy, m);
    if (m.primary < 0 || (size_t)m.primary >= m.entries.size()) return false;
    const UiHoverEntry& e = m.entries[(size_t)m.primary];
    const bool afford = e.cost < 0 || ctx.economy->canAfford(e.cost);
    if (!e.enabled || !afford) notify(e.label + ": " + (!e.enabled ? e.why : std::string("not enough funding")), true, now_);
    else if (e.onClick) e.onClick(u);
    hoverOpen_ = false;
    return true;
}
std::string GameUI::clickHoverEntry(AppState& app, const GameContext& ctx, CommandQueue& out, V3 at, size_t k, std::string* why) {
    const UiCtx u{app, ctx, *this, out};
    float sx = 0, sy = 0;
    worldToScreen(app, at, sx, sy);
    UiHoverMenu m;
    for (auto& h : hover_) h.second(u, at, sx, sy, m);
    if (k >= m.entries.size()) return {};
    const UiHoverEntry& e = m.entries[k];
    const bool afford = e.cost < 0 || ctx.economy->canAfford(e.cost);
    if (!e.enabled || !afford) { if (why) *why = !e.enabled ? e.why : "Not enough funding"; return e.label; }
    if (e.onClick) e.onClick(u);
    hoverOpen_ = false;
    return e.label;
}
void GameUI::drawHoverMenu(AppState& app, const GameContext& ctx, CommandQueue& out) {
    const UiCtx u{app, ctx, *this, out};
    const double t = ImGui::GetTime();
    const ImGuiIO& io = ImGui::GetIO();
    if (tool_ != Tool::Select || hover_.empty()) { hoverOpen_ = false; return; }
    // probe under the cursor (skipped while the cursor is over HUD panels other than this menu)
    V3 g;
    bool probe = false;
    float sx = io.MousePos.x, sy = io.MousePos.y;
    if (forceHover && forced_) { g = forcedPos_; probe = worldToScreen(app, g, sx, sy); }
    else if (!io.WantCaptureMouse && io.MousePos.x > -1e30f) probe = pickGround(app, ctx, sx, sy, g);
    if (probe) {
        UiHoverMenu m;
        bool any = false;
        for (auto& h : hover_) any |= h.second(u, g, sx, sy, m);
        if (any && !m.entries.empty()) { hoverMenu_ = m; hoverOpen_ = true; hoverSeen_ = t; }
    }
    if (!hoverOpen_) return;
    if (t - hoverSeen_ > 0.45 && t - hoverOverMenu_ > 0.3) { hoverOpen_ = false; return; }
    ImVec2 sp;
    float ax, ay;
    if (!worldToScreen(app, hoverMenu_.anchor, ax, ay)) { hoverOpen_ = false; return; }
    sp = ImVec2(ax + 14 * S, ay - 10 * S);
    const float rowH = 22 * S, pad = 6 * S;
    float w = tsize(12.f, hoverMenu_.title.c_str()).x + 2 * pad;
    for (const UiHoverEntry& e : hoverMenu_.entries) {
        float ew = 24 * S + tsize(12.f, e.label.c_str()).x + 2 * pad;
        if (e.cost >= 0) ew += tsize(11.f, money(e.cost).c_str()).x + 10 * S;
        if (!e.hotkeyLabel.empty()) ew += tsize(10.f, e.hotkeyLabel.c_str()).x + 10 * S;
        w = std::max(w, ew);
    }
    const float h = 20 * S + rowH * (float)hoverMenu_.entries.size() + pad;
    sp.x = std::min(sp.x, io.DisplaySize.x - w - 6 * S);
    sp.y = std::clamp(sp.y, layout_.topBarBottom + 4 * S, std::max(layout_.topBarBottom + 4 * S, layout_.barY0 - h - 6 * S));
    const ImVec2 a = sp, c(sp.x + w, sp.y + h);
    if (beginPane("##hud_hover", a, c)) {
        ImDrawList* dl = ImGui::GetWindowDrawList();
        if (ImGui::IsWindowHovered()) hoverOverMenu_ = t;
        dl->AddLine(ImVec2(ax, ay), ImVec2(a.x, a.y + 10 * S), withA(kSand, 0.6f), 1.f);
        dl->AddCircleFilled(ImVec2(ax, ay), 2.5f * S, kSand, 8);
        panel(dl, a, c);
        text(dl, a.x + pad, a.y + 4 * S, kDim, 11.f, hoverMenu_.title.c_str());
        float y = a.y + 20 * S;
        for (size_t k = 0; k < hoverMenu_.entries.size(); ++k) {
            const UiHoverEntry& e = hoverMenu_.entries[k];
            const bool afford = e.cost < 0 || ctx.economy->canAfford(e.cost);
            const bool en = e.enabled && afford;
            const ImVec2 ra(a.x + 3 * S, y), rb(c.x - 3 * S, y + rowH - 2 * S);
            char id[32]; std::snprintf(id, sizeof(id), "##hv%zu", k);
            bool hov = false;
            if (hit(id, ra, rb, &hov)) {   // a refused entry says why (owner round 15 #13: "nothing happens")
                if (en && e.onClick) e.onClick(u);
                else if (!en) notify(e.label + ": " + (!e.enabled ? e.why : std::string("not enough funding")), true, now_);
                hoverOpen_ = false;
            }
            if (hov) dl->AddRectFilled(ra, rb, en ? IM_COL32(60, 62, 40, 240) : kBgHi, 3 * S);
            drawUiIcon(dl, e.icon, ra.x + 11 * S, y + rowH * 0.45f, 17 * S, en);
            text(dl, ra.x + 24 * S, y + 3 * S, en ? kSand : kFaint, 12.f, e.label.c_str());
            float rx = rb.x - 5 * S;
            if (!e.hotkeyLabel.empty()) { rx -= tsize(10.f, e.hotkeyLabel.c_str()).x; text(dl, rx, y + 4 * S, kFaint, 10.f, e.hotkeyLabel.c_str()); rx -= 8 * S; }
            if (e.cost >= 0) { const std::string cs = money(e.cost); rx -= tsize(11.f, cs.c_str()).x; text(dl, rx, y + 4 * S, afford ? kKhaki : kBad, 11.f, cs.c_str()); }
            if (hov && (!e.enabled || !afford)) { tipBegin(); ImGui::TextColored(v4(kBad), "%s", !e.enabled ? e.why.c_str() : "Not enough funding"); tipEnd(); }
            y += rowH;
        }
    }
    ImGui::End();
}

// ---- world labels ---------------------------------------------------------------------------------------------------
void GameUI::worldLabel(float sx, float sy, const std::string& t, uint32_t col, int priority, bool centred, bool plate) {
    if (t.empty() || !std::isfinite(sx) || !std::isfinite(sy)) return;
    labels_.push_back({sx, sy, t, col, priority, centred, plate});
}

void GameUI::flushWorldLabels(AppState& app) {
    const float d = app.camera.distance();
    // zoom fade: minor labels go first when zooming out, then info, then status (cursor / alert / selected stay)
    auto zoomAlpha = [&](int p) {
        const float far = p >= kLabelSelected ? 1e9f : p >= kLabelStatus ? 420.f : p >= kLabelInfo ? 260.f : 170.f;
        return std::clamp((far - d) / (far * 0.25f), 0.f, 1.f);
    };
    std::stable_sort(labels_.begin(), labels_.end(), [](const WorldLabel& a, const WorldLabel& b) { return a.prio > b.prio; });
    struct R { float x0, y0, x1, y1; };
    std::vector<R> placed;
    std::vector<std::pair<const WorldLabel*, R>> keep;
    for (size_t k = 0; k + 3 < hudRects_.size(); k += 4) placed.push_back({hudRects_[k], hudRects_[k + 1], hudRects_[k + 2], hudRects_[k + 3]});
    const size_t hudN = placed.size();
    auto overlaps = [&](const R& r, size_t from) {
        for (size_t k = from; k < placed.size(); ++k) {
            const R& q = placed[k];
            if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true;
        }
        return false;
    };
    for (const WorldLabel& L : labels_) {
        if (zoomAlpha(L.prio) <= 0.01f) continue;
        const float px = L.prio <= kLabelMinor ? 12.f : 12.5f;
        const ImVec2 ts = tsize(px, L.text.c_str());
        const float padX = L.plate ? 4 * S : 1 * S, padY = L.plate ? 1.5f * S : 0.f;
        R r{L.x - padX, L.y - padY, L.x + ts.x + padX, L.y + ts.y + padY};
        if (L.centred) { r.x0 -= ts.x * 0.5f; r.x1 -= ts.x * 0.5f; }
        bool dup = false;   // the same text close by (two engineer rings, repeated "queued"): one label
        for (const auto& kp : keep)
            if (kp.first->text == L.text && std::fabs(kp.second.x0 - r.x0) < 160 * S && std::fabs(kp.second.y0 - r.y0) < 90 * S) { dup = true; break; }
        if (dup) continue;
        if (overlaps(r, 0)) {
            bool ok = false;
            const float h = r.y1 - r.y0 + 2 * S;
            for (float dy : {h, -h, 2 * h}) {
                R q{r.x0, r.y0 + dy, r.x1, r.y1 + dy};
                if (!overlaps(q, 0)) { r = q; ok = true; break; }
            }
            if (!ok && (L.prio < kLabelCursor || overlaps(r, hudN))) {
                if (L.prio < kLabelCursor) continue;
            }
        }
        placed.push_back(r);
        keep.push_back({&L, r});
    }
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    for (const auto& kp : keep) {
        const WorldLabel& L = *kp.first;
        const R& r = kp.second;
        const float a = zoomAlpha(L.prio);
        const float px = L.prio <= kLabelMinor ? 12.f : 12.5f;
        if (L.plate) dl->AddRectFilled(ImVec2(r.x0, r.y0), ImVec2(r.x1, r.y1), withA(IM_COL32(10, 12, 8, 165), a), 3 * S);
        const float tx = r.x0 + (L.plate ? 4 * S : S), ty = r.y0 + (L.plate ? 1.5f * S : 0.f);
        if (!L.plate) dl->AddText(F, px * S, ImVec2(tx + 1, ty + 1), withA(kShadow, a), L.text.c_str());
        dl->AddText(F, px * S, ImVec2(tx, ty), withA(L.col, a), L.text.c_str());
    }
    labels_.clear();
    hudRects_.clear();
}

// per-frame HUD setup (scale, font, animation step); called by GameUI::draw
void hudFrameBegin(const AppState& app) {
    const ImGuiStyle& st = ImGui::GetStyle();
    S = std::max(0.5f, st.FontScaleMain * st.FontScaleDpi * ImGui::GetIO().FontGlobalScale);
    ImFontAtlas* at = ImGui::GetIO().Fonts;
    F = at && at->Fonts.Size > 1 ? at->Fonts[1] : ImGui::GetFont();
    dtUi = app.window ? std::clamp(ImGui::GetIO().DeltaTime, 0.f, 0.1f) : 10.f;
}
float hudScale() { return S; }

} // namespace ttz::game
