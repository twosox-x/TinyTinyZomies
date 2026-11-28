// HUD v2 menus (part of GameUI; preview docs/ui_preview/screens_c.js "pause", "keys", "menu"): Esc pause menu as four
// plain words on a shade from the left, a settings column (music, UI scale, depth of field, clouds), a static key
// bindings page read from the real handlers, and a minimal main menu shown once at start in windowed runs only
// (never headless: scripted captures and tests start straight into play).
#include "game/GameUI.h"
#include "game/HudStyle.h"
#include "audio/Audio.h"   // [SOUND HOOK]

#include "app/App.h"
#include "imgui.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <vector>

namespace ttz::game {

namespace {
float mS = 1.f;
ImFont* mF = nullptr;    // Archivo medium
ImFont* mFB = nullptr;   // Archivo bold

ImU32 alphaOf(ImU32 c, float a) { return (c & 0x00FFFFFFu) | ((ImU32)(std::clamp(a, 0.f, 1.f) * (float)((c >> 24) & 0xFF)) << 24); }
ImVec2 msize(ImFont* f, float px, const char* t) { return f->CalcTextSizeA(px * mS, FLT_MAX, 0.f, t); }
void mtext(ImDrawList* dl, ImFont* f, float x, float y, ImU32 col, float px, const char* t) { hs::textShadow(dl, f, px * mS, ImVec2(x, y), col, t); }
bool mhit(const char* id, ImVec2 a, ImVec2 b, bool* hov) {
    ImGui::SetCursorScreenPos(a);
    const bool c = ImGui::InvisibleButton(id, ImVec2(std::max(1.f, b.x - a.x), std::max(1.f, b.y - a.y)));
    *hov = ImGui::IsItemHovered();
    return c;
}
void hoverTick(ImGuiID id, bool hov) {
    static ImGuiID last = 0;
    if (!hov) { if (last == id) last = 0; return; }
    if (last != id) { last = id; audio::ui("ui_hover"); }   // [UI SOUND via D's audio::ui]
}
// shade from the left: the world goes dark behind the words, fading out towards the right
void shade(ImDrawList* dl, float wide, float base) {
    const ImVec2 D = ImGui::GetIO().DisplaySize;
    dl->AddRectFilled(ImVec2(0, 0), D, IM_COL32(0, 0, 0, (int)(255 * base)));
    const float w = D.x * wide;
    dl->AddRectFilledMultiColor(ImVec2(0, 0), ImVec2(w, D.y), IM_COL32(6, 7, 4, 215), IM_COL32(6, 7, 4, 0), IM_COL32(6, 7, 4, 0), IM_COL32(6, 7, 4, 215));
}
// a big plain word: hover lifts it (slides right a touch, brighter), `on` = gold with a pop when it switches on
bool word(ImDrawList* dl, const char* id, const char* label, float x, float y, float px, bool on, bool dim) {
    const ImVec2 ts = msize(mFB, px, label);
    bool hov = false;
    const bool clicked = mhit(id, ImVec2(x - 6 * mS, y), ImVec2(x + ts.x + 14 * mS, y + ts.y), &hov);
    const ImGuiID gid = ImGui::GetID(id);
    hoverTick(gid, hov);
    if (clicked) hs::kick(gid);
    const float lift = hs::tween(gid, hov ? 1.f : 0.f, 16.f);
    const float pop = hs::springPop(hs::pulse(gid, 0.3f));
    const ImU32 col = on ? hs::kGold : hov ? hs::kBone : dim ? alphaOf(hs::kDim, 0.55f) : alphaOf(hs::kBone, 0.82f);
    mtext(dl, mFB, x + lift * 8 * mS, y - lift * 2 * mS - (pop - 1.f) * ts.y * 0.5f, col, px * pop, label);
    return clicked;
}
// small text link ("Cancel", "Back")
bool link(ImDrawList* dl, const char* id, const char* label, float x, float y, ImU32 col) {
    const ImVec2 ts = msize(mF, 14.f, label);
    bool hov = false;
    const bool c = mhit(id, ImVec2(x, y), ImVec2(x + ts.x, y + ts.y + 3 * mS), &hov);
    hoverTick(ImGui::GetID(id), hov);
    mtext(dl, mF, x, y, hov ? hs::kBone : col, 14.f, label);
    dl->AddLine(ImVec2(x, y + ts.y + 1 * mS), ImVec2(x + ts.x, y + ts.y + 1 * mS), alphaOf(hov ? hs::kBone : col, 0.6f), 1.f * mS);
    return c;
}
// slider with a gliding fill; returns true while it changed this frame. `v` 0..1; `released` set when the drag ends.
bool slider(ImDrawList* dl, const char* id, float x, float y, float w, float& v, bool muted, bool* released = nullptr) {
    const float h = 18 * mS;
    bool hov = false;
    mhit(id, ImVec2(x, y), ImVec2(x + w, y + h), &hov);
    const ImGuiID gid = ImGui::GetID(id);
    hoverTick(gid, hov);
    bool changed = false;
    if (ImGui::IsItemActive()) {
        const float nv = std::clamp((ImGui::GetIO().MousePos.x - x) / w, 0.f, 1.f);
        changed = std::fabs(nv - v) > 1e-4f;
        v = nv;
    }
    if (released) *released = ImGui::IsItemDeactivated();
    const float shown = hs::tween(gid, v, 20.f);
    const float lift = hs::tween(gid + 1, hov || ImGui::IsItemActive() ? 1.f : 0.f, 16.f);
    const float cy = y + h * 0.5f, th = (3.f + lift) * mS;
    dl->AddRectFilled(ImVec2(x, cy - th * 0.5f), ImVec2(x + w, cy + th * 0.5f), IM_COL32(255, 255, 255, 40), th);
    const ImU32 fill = muted ? alphaOf(hs::kDim, 0.6f) : hs::kBone;
    dl->AddRectFilled(ImVec2(x, cy - th * 0.5f), ImVec2(x + w * shown, cy + th * 0.5f), fill, th);
    dl->AddCircleFilled(ImVec2(x + w * shown, cy + 1 * mS), (6.f + 2.f * lift) * mS, IM_COL32(0, 0, 0, 110));
    dl->AddCircleFilled(ImVec2(x + w * shown, cy), (6.f + 2.f * lift) * mS, muted ? hs::kDim : hs::kBone);
    return changed;
}
// on / off switch: a pill with a gliding knob, gold when on, pop when switched
bool toggle(ImDrawList* dl, const char* id, float x, float y, bool on) {
    const float w = 34 * mS, h = 18 * mS;
    bool hov = false;
    const bool c = mhit(id, ImVec2(x, y), ImVec2(x + w, y + h), &hov);
    const ImGuiID gid = ImGui::GetID(id);
    hoverTick(gid, hov);
    if (c) hs::kick(gid);
    const float k = hs::tween(gid, on ? 1.f : 0.f, 18.f);
    const float pop = hs::springPop(hs::pulse(gid, 0.3f));
    dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + h), on ? alphaOf(hs::kGold, 0.9f) : IM_COL32(255, 255, 255, hov ? 70 : 45), h * 0.5f);
    const float r = (h * 0.5f - 3 * mS) * pop;
    dl->AddCircleFilled(ImVec2(x + h * 0.5f + (w - h) * k, y + h * 0.5f), r, on ? hs::kInk : hs::kBone);
    return c;
}
bool speakerBtn(ImDrawList* dl, const char* id, float x, float y, bool muted) {
    const float s = 20 * mS;
    bool hov = false;
    const bool c = mhit(id, ImVec2(x, y - 1 * mS), ImVec2(x + s, y + s), &hov);
    const ImGuiID gid = ImGui::GetID(id);
    hoverTick(gid, hov);
    if (c) hs::kick(gid);
    const float pop = hs::springPop(hs::pulse(gid, 0.3f));
    hs::icon(dl, muted ? "speakerOff" : "speaker", ImVec2(x + s * 0.5f, y + s * 0.5f), s * pop, muted ? hs::kBad : hov ? hs::kBone : hs::kDim, true);
    return c;
}
void keycap(ImDrawList* dl, float& x, float y, const char* k) {
    const ImVec2 ts = msize(mFB, 12.f, k);
    const float w = std::max(20 * mS, ts.x + 12 * mS), h = 20 * mS;
    dl->AddRectFilled(ImVec2(x, y + 2 * mS), ImVec2(x + w, y + h + 2 * mS), IM_COL32(120, 114, 96, 255), 3 * mS);
    dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + h), hs::kBone, 3 * mS);
    dl->AddText(mFB, 12.f * mS, ImVec2(x + (w - ts.x) * 0.5f, y + (h - ts.y) * 0.5f), hs::kInk, k);
    x += w + 4 * mS;
}
void sep(ImDrawList* dl, float& x, float y, const char* s) {
    mtext(dl, mF, x, y + 2 * mS, hs::kMute, 13.f, s);
    x += msize(mF, 13.f, s).x + 4 * mS;
}
// a key row: keys as "Ctrl&1" (caps joined with a drawn +), "/" between alternatives, "-" for ranges
void keyRow(ImDrawList* dl, float x, float y, float descX, const char* keys, const char* desc) {
    char buf[96]; std::snprintf(buf, sizeof(buf), "%s", keys);
    float cx = x;
    char* p = buf;
    while (*p) {
        char* q = p;
        while (*q && *q != '&' && *q != '/' && *q != '~') ++q;
        const char d = *q; *q = 0;
        if (*p) keycap(dl, cx, y, p);
        if (d == '&') sep(dl, cx, y, "+");
        else if (d == '/') sep(dl, cx, y, "/");
        else if (d == '~') sep(dl, cx, y, "-");
        p = d ? q + 1 : q;
    }
    mtext(dl, mF, descX, y + 2 * mS, alphaOf(hs::kBone, 0.9f), 14.f, desc);
}
struct KRow { const char* keys; const char* desc; };
struct KGroup { const char* title; const char* icon; std::vector<KRow> rows; };
// the real bindings (GameUI.cpp handleEvent, HudBar.cpp actionHotkey, FortUI.cpp, BuildingGame.cpp, App.cpp)
const std::vector<KGroup>& keyGroups() {
    static const std::vector<KGroup> g = {
        {"Dock", "crate", {{"1~7", "Pick a card in the open tab"}, {"Tab/Shift&Tab", "Next / previous tab"}}},
        {"Squads", "troops", {{"Ctrl&1~9", "Select squad n"}, {"Ctrl&Shift&1~9", "Add squad n"}, {".", "Next squad"}, {"H", "Halt"},
                              {"G", "Garrison (building selected)"}}},
        {"Placing", "build", {{"Q/E", "Rotate 15\xC2\xB0"}, {"T", "Rotate 90\xC2\xB0"}, {"Enter", "Finish wall"}, {"Backspace", "Remove last point"},
                              {"Shift", "Snap wall to 15\xC2\xB0"}, {"Ctrl&Z", "Undo build"}, {"Esc", "Cancel"}}},
        {"Camera", "eye", {{"W/A/S/D", "Pan (or arrow keys)"}, {"Shift", "Pan faster"}, {"Q/E", "Turn, when not placing"}, {"Wheel", "Zoom"},
                           {"Alt&Drag", "Rotate"}}},
        {"System", "cog", {{"Esc", "Cancel, deselect, then pause"}, {"Space", "Pause"}, {"+/-", "Game speed"}, {"F12", "Screenshot"},
                           {"F1", "Hide the interface"}}},
    };
    return g;
}
} // namespace

void GameUI::drawMenus(AppState& app) {
    // the main menu: once at the start of a windowed game (app.window null = headless: never)
    if (!mainMenuDone_) { mainMenuDone_ = true; if (app.window) { mainMenu_ = true; menuConfirm_ = 0; } }
    if (!mainMenu_) {
        if (pauseMenu_ && !app.paused) pauseMenu_ = false;   // unpaused elsewhere (Space)
        if (pauseMenu_ != pauseWasOpen_) {
            audio::ui(pauseMenu_ ? "ui_pause_open" : "ui_pause_close");   // [UI SOUND via D's audio::ui]
            pauseWasOpen_ = pauseMenu_;
            pausePage_ = 0; menuConfirm_ = 0;
        }
        if (!pauseMenu_) return;
    }
    const ImGuiStyle& st = ImGui::GetStyle();
    const ImGuiIO& io = ImGui::GetIO();
    mS = std::max(0.5f, st.FontScaleMain * st.FontScaleDpi * io.FontGlobalScale);
    ImFontAtlas* at = io.Fonts;
    mF = hudFont() ? hudFont() : at && at->Fonts.Size > 1 ? at->Fonts[1] : ImGui::GetFont();
    mFB = hudFontBold() ? hudFontBold() : mF;
    const ImVec2 D = io.DisplaySize;

    // one full-screen pane on top: the world and the HUD behind it can't be clicked while a menu is open
    ImGui::SetNextWindowPos(ImVec2(0, 0), ImGuiCond_Always);
    ImGui::SetNextWindowSize(D, ImGuiCond_Always);
    ImGui::SetNextWindowFocus();
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.f);
    const bool open = ImGui::Begin(mainMenu_ ? "##hud_mainmenu" : "##hud_pause", nullptr,
                                   ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoNav |
                                       ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoScrollWithMouse | ImGuiWindowFlags_NoScrollbar);
    ImGui::PopStyleVar(2);
    if (!open) { ImGui::End(); return; }
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float left = std::round(D.x * 0.06f);

    if (mainMenu_) {   // ---- main menu ---------------------------------------------------------------------------
        app.paused = true;   // nothing moves behind it
        shade(dl, 0.7f, 0.35f);
        const float top = std::round(D.y * 0.5f - 190 * mS);
        mtext(dl, mFB, left, top, hs::kBone, 54.f, "Tiny Tiny Zombies");
        mtext(dl, mF, left + 3 * mS, top + 66 * mS, hs::kDim, 18.f, "Night of the Mini Dead");
        const char* items[3] = {"Continue", "New game", "Quit"};
        float y = top + 130 * mS;
        for (int i = 0; i < 3; ++i) {
            char id[32]; std::snprintf(id, sizeof(id), "##mm_%d", i);
            const bool on = i == 2 && menuConfirm_;
            if (word(dl, id, items[i], left, y, 34.f, on, menuConfirm_ && !on)) {
                audio::ui("ui_select");   // [UI SOUND via D's audio::ui]
                if (i < 2) { mainMenu_ = false; menuConfirm_ = 0; pauseMenu_ = false; pauseWasOpen_ = false; app.paused = false; }
                else menuConfirm_ = !menuConfirm_;
            }
            y += 52 * mS;
            if (on) {
                mtext(dl, mF, left + 2 * mS, y - 6 * mS, hs::kDim, 14.f, "Quit the game?");
                if (link(dl, "##mm_yes", "Quit", left + 2 * mS, y + 16 * mS, hs::kBad)) { audio::ui("ui_select"); app.quit = true; }
                mtext(dl, mF, left + 42 * mS, y + 16 * mS, hs::kMute, 14.f, "\xC2\xB7");
                if (link(dl, "##mm_no", "Cancel", left + 56 * mS, y + 16 * mS, hs::kDim)) { audio::ui("ui_select"); menuConfirm_ = 0; }
                y += 44 * mS;
            }
        }
        ImGui::End();
        return;
    }

    // ---- pause: words on the left, settings column / key bindings page beside them ------------------------------
    shade(dl, pausePage_ ? 0.85f : 0.5f, 0.28f);
    const float top = std::round(D.y * 0.5f - 210 * mS);
    hs::icon(dl, "pause", ImVec2(left + 7 * mS, top + 9 * mS), 14 * mS, hs::kBone, true);
    mtext(dl, mF, left + 20 * mS, top, hs::kBone, 15.f, "Paused");
    const bool windowed = app.window != nullptr;
    const char* items[4] = {"Resume", "Settings", "Key bindings", windowed ? "Quit to menu" : "Quit"};
    float y = top + 34 * mS;
    for (int i = 0; i < 4; ++i) {
        char id[32]; std::snprintf(id, sizeof(id), "##pm_%d", i);
        const bool on = (i == 1 && pausePage_ == 1) || (i == 2 && pausePage_ == 2) || (i == 3 && menuConfirm_);
        const bool dim = (pausePage_ || menuConfirm_) && !on;
        if (word(dl, id, items[i], left, y, 38.f, on, dim)) {
            if (i == 0) { pauseMenu_ = false; app.paused = false; }   // the close sound plays on the transition
            else {
                audio::ui("ui_select");   // [UI SOUND via D's audio::ui]
                if (i == 3) { menuConfirm_ = !menuConfirm_; pausePage_ = 0; }
                else { pausePage_ = pausePage_ == i ? 0 : i; menuConfirm_ = 0; }
            }
        }
        y += 58 * mS;
        if (i == 3 && menuConfirm_) {
            mtext(dl, mF, left + 2 * mS, y - 8 * mS, hs::kDim, 14.f, windowed ? "Quit to menu? Unsaved progress is lost." : "Quit the game?");
            if (link(dl, "##pm_yes", "Quit", left + 2 * mS, y + 14 * mS, hs::kBad)) {
                audio::ui("ui_select");
                if (windowed) { mainMenu_ = true; pauseMenu_ = false; pauseWasOpen_ = false; menuConfirm_ = 0; }
                else app.quit = true;
            }
            mtext(dl, mF, left + 42 * mS, y + 14 * mS, hs::kMute, 14.f, "\xC2\xB7");
            if (link(dl, "##pm_no", "Cancel", left + 56 * mS, y + 14 * mS, hs::kDim)) { audio::ui("ui_select"); menuConfirm_ = 0; }
        }
    }

    const float cx = left + 300 * mS;
    if (pausePage_ == 1) {   // ---- settings column (fixed size) ------------------------------------------------
        float sy = top + 4 * mS;
        const float labelW = 130 * mS, sw = 200 * mS;
        auto head = [&](const char* t) { mtext(dl, mFB, cx, sy, hs::kBone, 19.f, t); sy += 34 * mS; };
        auto label = [&](const char* t) { mtext(dl, mF, cx, sy, alphaOf(hs::kBone, 0.85f), 15.f, t); };
        head("Audio");
        label("Music");   // the only bus Audio.h exposes a volume for (setMusicVolume)
        if (slider(dl, "##set_music", cx + labelW, sy, sw, musicVol_, musicMute_) && !musicMute_) audio::setMusicVolume(musicVol_);
        if (speakerBtn(dl, "##set_music_mute", cx + labelW + sw + 14 * mS, sy, musicMute_)) {
            musicMute_ = !musicMute_;
            audio::setMusicVolume(musicMute_ ? 0.f : musicVol_);
            audio::ui("ui_select");
        }
        char pct[16]; std::snprintf(pct, sizeof(pct), "%d%%", (int)std::lround(musicVol_ * 100.f));
        mtext(dl, mF, cx + labelW + sw + 42 * mS, sy, hs::kDim, 14.f, musicMute_ ? "muted" : pct);
        sy += 44 * mS;

        head("Display");
        label("UI scale");
        // applied when the drag ends: the whole HUD rescales with FontScaleMain (S), so not under the cursor mid-drag
        const float lo = 0.75f, hi = 2.0f;
        const float cur = uiScaleDrag_ > 0.f ? uiScaleDrag_ : ImGui::GetStyle().FontScaleMain;
        float t = std::clamp((cur - lo) / (hi - lo), 0.f, 1.f);
        bool rel = false;
        if (slider(dl, "##set_uiscale", cx + labelW, sy, sw, t, false, &rel)) uiScaleDrag_ = std::round((lo + t * (hi - lo)) * 20.f) / 20.f;
        if (rel && uiScaleDrag_ > 0.f) { ImGui::GetStyle().FontScaleMain = uiScaleDrag_; uiScaleDrag_ = -1.f; audio::ui("ui_select"); }
        char sc[16]; std::snprintf(sc, sizeof(sc), "%.2fx", uiScaleDrag_ > 0.f ? uiScaleDrag_ : ImGui::GetStyle().FontScaleMain);
        mtext(dl, mF, cx + labelW + sw + 14 * mS, sy, hs::kDim, 14.f, sc);
        sy += 44 * mS;

        head("Graphics");
        label("Depth of field");
        if (toggle(dl, "##set_dof", cx + labelW, sy, app.renderSettings.tiltShift)) { app.renderSettings.tiltShift = !app.renderSettings.tiltShift; audio::ui("ui_select"); }
        sy += 32 * mS;
        label("Cloud shadows");
        if (toggle(dl, "##set_clouds", cx + labelW, sy, app.renderSettings.clouds)) { app.renderSettings.clouds = !app.renderSettings.clouds; audio::ui("ui_select"); }
        sy += 44 * mS;
        if (link(dl, "##set_keys", "All key bindings", cx, sy, hs::kDim)) { audio::ui("ui_select"); pausePage_ = 2; }
    } else if (pausePage_ == 2) {   // ---- key bindings (static reference) -----------------------------------------
        const auto& G = keyGroups();
        const float colW = std::min(300 * mS, (D.x - cx - 16 * mS) / 3.f), keyW = 120 * mS;
        float colY[3] = {top + 4 * mS, top + 4 * mS, top + 4 * mS};
        const int colOf[5] = {0, 0, 1, 2, 2};
        for (size_t gi = 0; gi < G.size(); ++gi) {
            const int c = colOf[gi];
            const float gx = cx + c * colW;
            float& gy = colY[c];
            hs::icon(dl, G[gi].icon, ImVec2(gx + 9 * mS, gy + 11 * mS), 18 * mS, hs::kDim, true);
            mtext(dl, mFB, gx + 24 * mS, gy, hs::kBone, 17.f, G[gi].title);
            gy += 32 * mS;
            for (const KRow& r : G[gi].rows) { keyRow(dl, gx, gy, gx + keyW, r.keys, r.desc); gy += 28 * mS; }
            gy += 16 * mS;
        }
        const float by = std::max(colY[0], std::max(colY[1], colY[2]));
        if (link(dl, "##keys_back", "Back", cx, by, hs::kDim)) { audio::ui("ui_select"); pausePage_ = 0; }
    }
    ImGui::End();
}

} // namespace ttz::game
