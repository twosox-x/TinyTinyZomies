// B2 script verbs and metrics (walls, gates, territory). See GameScript.h.
#include "app/App.h"
#include "game/GameScript.h"
#include "game/GameWorld.h"
#include "game/NavGrid.h"
#include "sim/GpuTypes.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace ttz::game {

namespace {
float fa(const std::vector<std::string>& a, size_t k, float def = 0.f) { return k < a.size() ? (float)std::atof(a[k].c_str()) : def; }
bool wallType(const std::string& s, uint8_t& type, bool& gate) {
    if (s == "cheap") { type = 0; gate = false; return true; }
    if (s == "reinforced") { type = 1; gate = false; return true; }
    if (s == "gate") { type = 0; gate = true; return true; }
    if (s == "rgate") { type = 1; gate = true; return true; }
    return false;
}
V3 ground(GameWorld& w, float x, float z) {
    const NavGrid* nav = w.context().nav;
    return {x, nav && nav->ready() ? nav->surface(x, z) : 0.f, z};
}
} // namespace

bool fortVerb(GameWorld& w, const ScriptLine& L, std::string& err) {
    const std::vector<std::string>& a = L.args;
    Walls& W = w.fort().walls();
    if (L.verb == "wall" || L.verb == "wallrect") {
        Command c;
        c.type = CommandType::BuildWall;
        if (a.empty() || !wallType(a[0], c.wallType, c.gate)) { err = "wall cheap|reinforced|gate|rgate X Z X Z ..."; return true; }
        if (L.verb == "wallrect") {
            if (a.size() < 5) { err = "wallrect TYPE X0 Z0 X1 Z1"; return true; }
            const float x0 = fa(a, 1), z0 = fa(a, 2), x1 = fa(a, 3), z1 = fa(a, 4);
            for (auto [x, z] : {std::pair{x0, z0}, {x1, z0}, {x1, z1}, {x0, z1}, {x0, z0}}) c.path.push_back(ground(w, x, z));
        } else {
            for (size_t k = 1; k + 1 < a.size(); k += 2) c.path.push_back(ground(w, fa(a, k), fa(a, k + 1)));
            if (c.path.size() < 2) { err = "wall TYPE X Z X Z ..."; return true; }
        }
        w.commands().push(c);
        return true;
    }
    if (L.verb == "wallpreview") {
        if (!a.empty() && a[0] == "off") { w.ui().clearForcedPreview(); return true; }
        uint8_t t; bool g;
        if (a.size() < 5 || !wallType(a[0], t, g)) { err = "wallpreview TYPE X Z X Z ..."; return true; }
        std::vector<V3> pts;
        for (size_t k = 1; k + 1 < a.size(); k += 2) pts.push_back(ground(w, fa(a, k), fa(a, k + 1)));
        w.ui().forceWallPreview(pts, t, g);
        return true;
    }
    if (L.verb == "damagewall" || L.verb == "destroywall") {   // TEST HOOKS
        const int p = W.nearestPiece(fa(a, 0), fa(a, 1), 3.f);
        if (p < 0) { err = "no wall piece within 3 m"; return true; }
        if (L.verb == "destroywall") W.destroy((uint32_t)p);
        else W.damage((uint32_t)p, fa(a, 2, 1e9f));
        return true;
    }
    if (L.verb == "groundmap") {   // debug: ASCII map of a rectangle ('#' building / water, 'v' vehicle, 'W' wall, '.' street)
        AppState* app = w.app();
        if (!app || a.size() < 4) { err = "groundmap X0 Z0 X1 Z1 [STEP]"; return true; }
        const float x0 = fa(a, 0), z0 = fa(a, 1), x1 = fa(a, 2), z1 = fa(a, 3), st = fa(a, 4, 2.f);
        const std::vector<float>& sim = app->vehicles.simHeights();
        const Sandbox& sb = app->sandbox;
        std::printf("  groundmap x %.0f..%.0f (columns, step %.1f), z %.0f..%.0f (rows)\n", x0, x1, st, z0, z1);
        for (float z = z0; z <= z1; z += st) {
            std::string row;
            for (float x = x0; x <= x1; x += st) {
                const float g = app->vehicles.groundAt(x, z), so = app->vehicles.solidAt(x, z);
                const int cx = (int)std::floor((x - sb.originX) / sb.cellSize), cz = (int)std::floor((z - sb.originZ) / sb.cellSize);
                const float sh = (cx >= 0 && cz >= 0 && cx < sb.gridW && cz < sb.gridH) ? sim[(size_t)cz * sb.gridW + cx] : 0.f;
                row += g > 0.9f ? '#' : so - g > 0.4f ? 'v' : sh - g > 0.9f ? 'W' : g > 0.1f ? ',' : '.';
            }
            std::printf("  %7.1f %s\n", z, row.c_str());
        }
        std::fflush(stdout);
        return true;
    }
    if (L.verb == "territory") {
        const Territory& T = w.fort().territory();
        std::printf("  territory: %zu region(s), controlled %.0f m2, enclosed %.0f m2, income +%.0f/min; walls %u pieces (%u gates), obstacles %u, "
                    "nav patches %llu (%llu rows), gpu passes %llu\n",
                    T.regions().size(), T.controlledArea(), T.enclosedArea(), T.incomePerMin(), W.alivePieces(), W.aliveGates(), w.fort().obstacles(),
                    (unsigned long long)w.fort().navPatches(), (unsigned long long)w.fort().navPatchedRows(), (unsigned long long)w.fort().gpuPasses());
        for (const Region& r : T.regions())
            std::printf("    region %u: %s, %.0f m2 at (%.1f %.1f), zombies %d, perimeter %zu pieces%s\n", r.id, regionStateName(r.state), r.area, r.cx, r.cz,
                        r.zombies, r.perimeter.size(), r.underAttack ? ", under attack" : "");
        std::fflush(stdout);
        return true;
    }
    return false;
}

bool fortMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) {
    const Walls& W = w.fort().walls();
    const Territory& T = w.fort().territory();
    const NavGrid* nav = w.context().nav;
    if (m == "walls") { out = W.alivePieces(); return true; }
    if (m == "gates") { out = W.aliveGates(); return true; }
    if (m == "walls_destroyed") { out = (double)w.fort().wallsDestroyed(); return true; }
    if (m == "regions") { out = (double)T.regions().size(); return true; }
    if (m == "territory_area") { out = T.controlledArea(); return true; }
    if (m == "enclosed_area") { out = T.enclosedArea(); return true; }
    if (m == "territory_income") { out = T.incomePerMin(); return true; }
    if (m == "territory_total") { out = w.economy().totalByKind(LedgerKind::TerritoryIncome); return true; }
    if (m == "obstacles") { out = w.fort().obstacles(); return true; }
    if (m == "nav_patches") { out = (double)w.fort().navPatches(); return true; }
    if (m == "region" || m == "wall") {
        if (k + 2 >= a.size()) { err = m + " X Z FIELD"; return true; }
        const float x = fa(a, k), z = fa(a, k + 1);
        const std::string fld = a[k + 2];
        k += 3;
        if (m == "region") {
            const Region* r = T.regionAt(x, z);
            if (fld == "state") out = r ? (double)(int)r->state : 0.0;
            else if (fld == "zombies") out = r ? r->zombies : -1.0;
            else if (fld == "area") out = r ? r->area : 0.0;
            else err = "region field state|zombies|area";
            return true;
        }
        const int p = W.nearestPiece(x, z, 3.f);
        if (fld == "alive") out = p >= 0 ? 1.0 : 0.0;
        else if (fld == "hp") out = p >= 0 ? W.pieces()[(size_t)p].hp : 0.0;
        else if (fld == "pressure") out = p >= 0 ? w.fort().piecePressure((uint32_t)p) : 0.0;
        else err = "wall field hp|alive|pressure";
        return true;
    }
    if (m == "walkable") {
        if (k + 1 >= a.size()) { err = "walkable X Z"; return true; }
        out = nav && nav->walkable(fa(a, k), fa(a, k + 1)) ? 1.0 : 0.0;
        k += 2;
        return true;
    }
    if (m == "same_island") {
        if (k + 3 >= a.size()) { err = "same_island X0 Z0 X1 Z1"; return true; }
        const uint32_t i0 = nav ? nav->island(fa(a, k), fa(a, k + 1)) : 0, i1 = nav ? nav->island(fa(a, k + 2), fa(a, k + 3)) : 0;
        out = i0 && i0 == i1 ? 1.0 : 0.0;
        k += 4;
        return true;
    }
    if (m == "zombies_rect") {   // tests only: synchronous GPU read of the live agents
        if (k + 3 >= a.size()) { err = "zombies_rect X0 Z0 X1 Z1"; return true; }
        const float x0 = fa(a, k), z0 = fa(a, k + 1), x1 = fa(a, k + 2), z1 = fa(a, k + 3);
        k += 4;
        out = 0;
        AppState* app = w.app();
        if (!app) return true;
        const uint32_t live = app->sim.stats().live;
        if (!live) return true;
        std::vector<GpuAgent> ag(live);
        SDL_WaitForGPUIdle(app->gpu.device());
        if (!app->gpu.downloadNow(app->sim.agents(), ag.data(), live * (uint32_t)sizeof(GpuAgent))) return true;
        for (const GpuAgent& g : ag) {
            if ((g.info.x & 0xFFu) >= 3u) continue;   // dying / dead
            if (g.pos.x >= std::min(x0, x1) && g.pos.x <= std::max(x0, x1) && g.pos.z >= std::min(z0, z1) && g.pos.z <= std::max(z0, z1)) out += 1;
        }
        return true;
    }
    return false;
}

} // namespace ttz::game
