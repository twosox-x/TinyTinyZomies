// B3b script verbs / metrics (vertical horde, HordeVertical). Called from GameScript after the B2 / B3a hooks.
//   vbarricade OPENING planks|plate|sandbags [HEALTH]   TEST HOOK: barricade an opening of the selected building directly
//                                                       (BuildingRegistry::setBarricade; B3a's paid flow is bbarricade)
//   vinfo                                               print the active buildings (occupants per floor, target level)
// metrics: vstat captured|emitted|inside|killed|left|active|entrances|dropped
//          vbuilding inside|target|draining|floor F   (selected building; -1 when not active)
//          vopening K   barricade health of opening K of the selected building
//          squad_damage N   health lost by squad N (max - current, living members)
#include "game/GameScript.h"
#include "game/GameWorld.h"

#include <cstdio>
#include <cstdlib>

namespace ttz::game {

bool verticalVerb(GameWorld& w, const ScriptLine& L, std::string& err) {
    const std::vector<std::string>& a = L.args;
    BuildingPlay& bp = w.buildings();
    if (L.verb == "vbarricade") {
        if (a.size() < 2) { err = "vbarricade OPENING planks|plate|sandbags [HEALTH]"; return true; }
        const BarricadeType t = a[1] == "planks" ? BarricadeType::Planks : a[1] == "plate" ? BarricadeType::Plate : BarricadeType::Sandbags;
        const int k = std::atoi(a[0].c_str());
        const float hp = a.size() > 2 ? (float)std::atof(a[2].c_str()) : w.config().buildings.barricadeHealth[(size_t)t - 1];
        if (!bp.registry().setBarricade(bp.selected, (uint16_t)k, t, hp)) err = "vbarricade: refused (no building selected / bad opening)";
        return true;
    }
    if (L.verb == "vinfo") {
        const HordeVertical::Stats& s = w.vertical().stats();
        std::printf("  vertical: active %d, entrances %d, occupants %d, captured %llu, out on roofs %llu, killed inside %llu, left %llu, cpu %.3f ms\n",
                    s.activeBuildings, s.entrances, s.occupants, (unsigned long long)s.captured, (unsigned long long)s.emitted,
                    (unsigned long long)s.killedInside, (unsigned long long)s.leftByDoor, s.cpuMs);
        for (const HordeVertical::BuildingState& v : w.vertical().active()) {
            std::printf("    building %u%s target %s%d: %d inside, per floor", v.id.v, v.draining ? " (draining)" : "", v.target == kRoofFloor ? "roof " : "floor ",
                        v.target == kRoofFloor ? -1 : (int)v.target, v.occupants);
            for (int16_t n : v.perFloor) std::printf(" %d", (int)n);
            std::printf("\n");
        }
        return true;
    }
    return false;
}

bool verticalMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) {
    const HordeVertical& V = w.vertical();
    BuildingPlay& bp = w.buildings();
    if (m == "vstat") {
        if (k >= a.size()) { err = "vstat FIELD"; return false; }
        const std::string f = a[k++];
        const HordeVertical::Stats& s = V.stats();
        if (f == "captured") out = (double)s.captured; else if (f == "emitted") out = (double)s.emitted;
        else if (f == "inside") out = s.occupants; else if (f == "killed") out = (double)s.killedInside;
        else if (f == "left") out = (double)s.leftByDoor; else if (f == "active") out = s.activeBuildings;
        else if (f == "entrances") out = s.entrances; else if (f == "dropped") out = (double)s.dropped;
        else { err = "unknown vstat " + f; return false; }
        return true;
    }
    if (m == "vbuilding") {
        if (k >= a.size()) { err = "vbuilding FIELD"; return false; }
        const std::string f = a[k++];
        out = -1;
        for (const HordeVertical::BuildingState& v : V.active()) {
            if (v.id != bp.selected) continue;
            if (f == "inside") out = v.occupants;
            else if (f == "target") out = v.target == kRoofFloor ? 255 : v.target;
            else if (f == "draining") out = v.draining ? 1 : 0;
            else if (f == "floor") { const int fl = k < a.size() ? std::atoi(a[k++].c_str()) : 0; out = fl >= 0 && fl < (int)v.perFloor.size() ? v.perFloor[(size_t)fl] : 0; }
            else { err = "unknown vbuilding " + f; return false; }
        }
        if (f == "floor" && out < 0) ++k;
        return true;
    }
    if (m == "vopening") {
        if (k >= a.size()) { err = "vopening K"; return false; }
        const int o = std::atoi(a[k++].c_str());
        const Building* B = bp.registry().get(bp.selected);
        if (!B || o < 0 || o >= (int)B->openings.size()) { err = "vopening: no such opening"; return false; }
        out = B->openings[(size_t)o].barricadeHealth;
        return true;
    }
    if (m == "squad_damage") {
        if (k >= a.size()) { err = "squad_damage N"; return false; }
        const int n = std::atoi(a[k++].c_str());
        const GameContext& ctx = w.context();
        if (!ctx.squads || n < 1 || n > (int)ctx.squads->squads.size()) { err = "no squad"; return false; }
        const SoldierPool& P = *ctx.soldiers;
        out = 0;
        for (const SoldierId& id : ctx.squads->squads[(size_t)n - 1].members)
            if (P.valid(id)) out += P.maxHealth[id.index] - (P.alive(id.index) ? P.health[id.index] : 0.f);
        return true;
    }
    return false;
}

} // namespace ttz::game
