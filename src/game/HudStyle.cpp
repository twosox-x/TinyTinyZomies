// HUD v2 "Counters" style. See HudStyle.h.
#include "game/HudStyle.h"

#include "game/UiActions.h"

#include "imgui.h"
#include "stb_image.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>

namespace ttz::game {
constexpr float kPi = 3.14159265f;

namespace {
ImFont* gFont = nullptr;
ImFont* gBold = nullptr;
ImFontAtlas* gAtlas = nullptr;
std::unordered_map<std::string, ImFontAtlasRectId> gIcons;
float gDt = 0.016f, gTime = 0.f;
struct Tw { float v = 0; float kickT = -100.f; };
std::unordered_map<ImGuiID, Tw> gTw;
} // namespace

void hudStyleLoad(ImFontAtlas* atlas) {
    gAtlas = atlas;
    ImFontConfig fc; fc.OversampleH = 2;
    if (std::ifstream("assets/ui/Archivo-SemiCondensed-Medium.ttf").good())
        gFont = atlas->AddFontFromFileTTF("assets/ui/Archivo-SemiCondensed-Medium.ttf", 15.f, &fc);
    if (std::ifstream("assets/ui/Archivo-SemiCondensed-Bold.ttf").good())
        gBold = atlas->AddFontFromFileTTF("assets/ui/Archivo-SemiCondensed-Bold.ttf", 15.f, &fc);
    // icon atlas: white silhouettes, CELL px cells, names in icons.txt
    std::ifstream idx("assets/ui/icons.txt");
    int w = 0, h = 0, n = 0;
    unsigned char* px = idx.good() ? stbi_load("assets/ui/icons.png", &w, &h, &n, 4) : nullptr;
    if (!px) { std::fprintf(stderr, "hud: no icon atlas (assets/ui/icons.png)\n"); return; }
    int cell = 96, cols = 16;
    std::string line;
    while (std::getline(idx, line)) {
        if (line.rfind("# cell", 0) == 0) { std::sscanf(line.c_str(), "# cell %d cols %d", &cell, &cols); continue; }
        if (line.empty() || line[0] == '#') continue;
        std::istringstream ls(line); int i; std::string name; ls >> i >> name;
        if (name.empty()) continue;
        ImFontAtlasRect r;
        const ImFontAtlasRectId id = atlas->AddCustomRect(cell, cell, &r);
        if (id == ImFontAtlasRectId_Invalid) continue;
        ImTextureData* tex = atlas->TexData;
        const int sx = (i % cols) * cell, sy = (i / cols) * cell;
        for (int y = 0; y < cell; ++y)
            for (int x = 0; x < cell; ++x) {
                const unsigned char* s = px + ((sy + y) * w + (sx + x)) * 4;
                unsigned char* d = (unsigned char*)tex->GetPixelsAt(r.x + x, r.y + y);
                if (tex->BytesPerPixel == 4) { d[0] = 255; d[1] = 255; d[2] = 255; d[3] = s[3]; }
                else d[0] = s[3];
            }
        gIcons[name] = id;
    }
    stbi_image_free(px);
}
ImFont* hudFont() { return gFont; }
ImFont* hudFontBold() { return gBold; }

namespace hs {
const ImU32 kTok = IM_COL32(26, 29, 23, 235), kTokHi = IM_COL32(37, 42, 32, 240), kBone = IM_COL32(241, 234, 216, 255),
            kDim = IM_COL32(168, 162, 141, 255), kMute = IM_COL32(109, 106, 93, 255), kGold = IM_COL32(244, 183, 64, 255),
            kOk = IM_COL32(143, 212, 106, 255), kWarn = IM_COL32(246, 166, 35, 255), kBad = IM_COL32(255, 91, 71, 255),
            kToxic = IM_COL32(200, 232, 62, 255), kInfo = IM_COL32(124, 198, 226, 255), kInk = IM_COL32(21, 23, 15, 255),
            kShadow = IM_COL32(0, 0, 0, 190);

bool icon(ImDrawList* dl, const char* name, ImVec2 c, float size, ImU32 col, bool shadow) {
    if (!gAtlas || !name) return false;
    auto it = gIcons.find(name);
    if (it == gIcons.end()) return false;
    ImFontAtlasRect r;
    if (!gAtlas->GetCustomRect(it->second, &r)) return false;
    const float h = size * 0.5f;
    dl->PushTexture(gAtlas->TexRef);
    if (shadow) {
        const ImU32 sc = IM_COL32(0, 0, 0, (int)(((col >> 24) & 0xFF) * 0.75f));
        dl->AddImage(gAtlas->TexRef, ImVec2(c.x - h + 1, c.y - h + 1), ImVec2(c.x + h + 1, c.y + h + 1), r.uv0, r.uv1, sc);
    }
    dl->AddImage(gAtlas->TexRef, ImVec2(c.x - h, c.y - h), ImVec2(c.x + h, c.y + h), r.uv0, r.uv1, col);
    dl->PopTexture();
    return true;
}

const char* iconName(UiIcon i) {
    switch (i) {
    case UiIcon::Rifle: return "rifle";            case UiIcon::MachineGun: return "mg";
    case UiIcon::Sniper: return "sniper";          case UiIcon::Flamethrower: return "flame";
    case UiIcon::Engineer: return "engineer";      case UiIcon::Container: return "container";
    case UiIcon::Airdrop: return "airdrop";        case UiIcon::Wall: return "wall";
    case UiIcon::WallTall: return "wallTall";      case UiIcon::Gate: return "gate";
    case UiIcon::ClearCar: return "disassemble";   case UiIcon::Tower: return "tower";
    case UiIcon::Light: return "light";            case UiIcon::Generator: return "generator";
    case UiIcon::Fuel: return "fuel";              case UiIcon::Crate: return "crate";
    case UiIcon::Barricade: return "barricade";    case UiIcon::Garrison: return "garrison";
    case UiIcon::Hospital: return "hospital";      case UiIcon::Vehicle: return "vehicle";
    case UiIcon::Siphon: return "siphon";          case UiIcon::Disassemble: return "disassemble";
    case UiIcon::Halt: return "halt";              case UiIcon::Run: return "run";
    case UiIcon::Walk: return "walk";              case UiIcon::Burn: return "burn";
    case UiIcon::Build: return "build";            case UiIcon::Undo: return "undo";
    default: return nullptr;
    }
}

void ring(ImDrawList* dl, ImVec2 c, float r, float thick, float frac, ImU32 col) {
    dl->AddCircle(c, r, IM_COL32(0, 0, 0, 150), 40, thick);
    frac = std::clamp(frac, 0.f, 1.f);
    if (frac <= 0.f) return;
    const float a0 = -kPi * 0.5f;
    dl->PathArcTo(c, r, a0, a0 + frac * 2.f * kPi, 40);
    dl->PathStroke(col, 0, thick);
}

void textShadow(ImDrawList* dl, ImFont* f, float px, ImVec2 p, ImU32 col, const char* t) {
    const ImU32 sc = IM_COL32(0, 0, 0, (int)(((col >> 24) & 0xFF) * 0.85f));
    dl->AddText(f, px, ImVec2(p.x, p.y + 1), sc, t);
    dl->AddText(f, px, ImVec2(p.x + 1, p.y + 1), IM_COL32(0, 0, 0, (int)(((col >> 24) & 0xFF) * 0.45f)), t);
    dl->AddText(f, px, p, col, t);
}

void token(ImDrawList* dl, ImVec2 c, const Tok& t, const char* iconN, float S) {
    const float pop = springPop(t.pop);
    const float sz = t.size * S * (1.f - 0.12f * t.press) * pop;
    c.y += (-2.f * t.lift + 1.f * t.press) * S;
    c.x += shakeX(t.shake) * S;
    const float h = sz * 0.5f, rnd = t.round ? h : 4.f * S;
    const ImVec2 a(c.x - h, c.y - h), b(c.x + h, c.y + h);
    ImU32 face = t.on ? kGold : (t.lift > 0.5f && !t.off ? kTokHi : kTok);
    // drop shadow, face, top highlight, bottom bevel
    dl->AddRectFilled(ImVec2(a.x, a.y + 2 * S + 2 * S * t.lift), ImVec2(b.x, b.y + 2 * S + 2 * S * t.lift), IM_COL32(0, 0, 0, 110), rnd);
    dl->AddRectFilled(a, b, face, rnd);
    if (!t.round) {
        dl->AddLine(ImVec2(a.x + rnd, a.y + 1), ImVec2(b.x - rnd, a.y + 1), IM_COL32(255, 255, 255, 24), 1.f);
        dl->AddLine(ImVec2(a.x + rnd, b.y - 1), ImVec2(b.x - rnd, b.y - 1), IM_COL32(0, 0, 0, 110), 2.f);
    }
    if (t.on) dl->AddRect(ImVec2(a.x - 1, a.y - 1), ImVec2(b.x + 1, b.y + 1), IM_COL32(244, 183, 64, (int)(70 + 50 * std::sin(gTime * 2.6f))), rnd, 0, 3.f * S);
    if (t.ring >= 0.f) ring(dl, c, h + 2.f * S, (t.size < 36 ? 2.f : 3.f) * S, t.ring, t.ringCol ? t.ringCol : (t.ring > 0.6f ? kOk : t.ring > 0.3f ? kWarn : kBad));
    const ImU32 ic = t.on ? kInk : t.off ? kMute : kBone;
    icon(dl, iconN, c, sz * 0.62f, ic);
    if (t.off) dl->AddLine(ImVec2(c.x - h * 0.55f, c.y + h * 0.45f), ImVec2(c.x + h * 0.55f, c.y - h * 0.45f), kBad, 2.f * S);
    ImFont* f = gBold ? gBold : ImGui::GetFont();
    if (t.key && *t.key) {
        const float px = 10.f * S; const ImVec2 ts = f->CalcTextSizeA(px, FLT_MAX, 0, t.key);
        const ImVec2 ka(a.x - 3 * S, a.y - 3 * S), kb(ka.x + std::max(13 * S, ts.x + 6 * S), ka.y + 13 * S);
        dl->AddRectFilled(ka, kb, t.off ? kMute : kBone, 2 * S);
        dl->AddText(f, px, ImVec2((ka.x + kb.x - ts.x) * 0.5f, (ka.y + kb.y - ts.y) * 0.5f), kInk, t.key);
    }
    if (t.num && *t.num) {
        const float px = 10.f * S; const ImVec2 ts = f->CalcTextSizeA(px, FLT_MAX, 0, t.num);
        const ImVec2 nb(b.x + 3 * S, b.y + 3 * S), na(nb.x - ts.x - 6 * S, nb.y - 13 * S);
        dl->AddRectFilled(na, nb, IM_COL32(12, 13, 10, 255), 2 * S);
        dl->AddText(f, px, ImVec2(na.x + 3 * S, (na.y + nb.y - ts.y) * 0.5f), kBone, t.num);
    }
}

void frame(float dt) { gDt = std::clamp(dt, 0.f, 0.1f); gTime += gDt; }
float tween(ImGuiID id, float target, float rate) {
    Tw& t = gTw[id];
    t.v += (target - t.v) * std::min(1.f, gDt * rate);
    return t.v;
}
void kick(ImGuiID id) { gTw[id ^ 0x9E3779B9u].kickT = gTime; }
float pulse(ImGuiID id, float seconds) {
    auto it = gTw.find(id ^ 0x9E3779B9u);
    if (it == gTw.end()) return 0.f;
    const float e = (gTime - it->second.kickT) / seconds;
    return e < 0.f || e > 1.f ? 0.f : 1.f - e;
}
float springPop(float p) {   // p: 1 -> 0 over the pulse; overshoot then settle
    if (p <= 0.f) return 1.f;
    const float t = 1.f - p;
    return 1.f + 0.22f * std::sin(t * kPi) * (1.f - t) * 1.6f;
}
float shakeX(float p) { return p <= 0.f ? 0.f : std::sin((1.f - p) * 30.f) * 4.f * p; }
} // namespace hs

} // namespace ttz::game
