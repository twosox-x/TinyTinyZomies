// Headless scenario scripts (WS-D). Implemented: parsing and `end`; command / expect verbs are WS-D work.
#include "game/GameScript.h"

#include "game/GameWorld.h"

#include <SDL3/SDL.h>
#include <fstream>
#include <sstream>

namespace ttz::game {

bool GameScript::load(const std::string& path, std::string* error) {
    std::ifstream f(path);
    if (!f) { if (error) *error = "cannot open " + path; return false; }
    std::string text;
    int n = 0;
    while (std::getline(f, text)) {
        ++n;
        if (size_t c = text.find('#'); c != std::string::npos) text.resize(c);
        std::istringstream ss(text);
        std::string at;
        ScriptLine L;
        if (!(ss >> at)) continue;
        if (at != "at" || !(ss >> L.at >> L.verb)) { if (error) *error = path + ":" + std::to_string(n) + ": expected 'at <seconds> <verb> ...'"; return false; }
        for (std::string a; ss >> a;) L.args.push_back(a);
        L.line = n;
        lines_.push_back(L);
    }
    if (lines_.empty()) { if (error) *error = path + ": no commands"; return false; }
    return true;
}

bool GameScript::tick(GameWorld& world, double time) {
    while (!ended_ && next_ < lines_.size() && lines_[next_].at <= time + 1e-9) {
        const ScriptLine& L = lines_[next_++];
        if (L.verb == "end") ended_ = true;
        else { SDL_Log("game script line %d: '%s' not implemented yet", L.line, L.verb.c_str()); ++failures_; }
    }
    return !ended_;
}

} // namespace ttz::game
