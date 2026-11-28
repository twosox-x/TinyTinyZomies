// Rooftop script verbs / metrics (GAME_DESIGN 14e: effortless roof placement, roof navigation, roof logistics). Called
// from GameScript after the B2 / B3a / B3b hooks.
//   roofinfo X Z                                  print the roof island at a point (cells, inset cells, roof objects)
//   roofclicks X0 Z0 X1 Z1 STEP [sniper|rifle|mg|crate]
//                                                 click every STEP m over a rectangle (Deploy::plan / airdropSpot, the
//                                                 code behind the UI preview); clicks on or at a roof are counted
//   roofpath X0 Z0 X1 Z1                          solve a path now (NavGrid A*), measure its clearances
//   roofwatch                                     from now on, every tick: soldiers idle on a roof vs the roof edge
// metrics: roofclick n|valid|refused|minedge|maxsnap     roofpath ok|minobs|minedge|len|direct
//          roofedge N (min edge clearance of squad N's living members; 3 = off roofs)   roofobs N
//          roofwatch ticks|violations|minedge (idle = Idle state at the home spot, or Idle for > edgeLinger + 1 s)
//          roofsteps roofreturns (AI edge steps / returns to the inset spot)
#include "game/Deploy.h"
#include "game/GameScript.h"
#include "game/GameWorld.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace ttz::game {

namespace {
struct RoofStats {
    double clickN = 0, clickValid = 0, clickRefused = 0, clickMinEdge = 99, clickMaxSnap = 0;
    double pathOk = 0, pathMinObs = 99, pathMinEdge = 99, pathLen = 0, pathDirect = 0;
    bool watch = false;
    double watchTicks = 0, watchViol = 0, watchMinEdge = 99;
} g;
float fa(const std::vector<std::string>& a, size_t k, float d = 0.f) { return k < a.size() ? (float)std::atof(a[k].c_str()) : d; }
} // namespace

void roofWatchTick(GameWorld& w) {
    if (!g.watch) return;
    const GameContext& ctx = w.context();
    if (!ctx.nav || !ctx.nav->ready() || !ctx.soldiers) return;
    const SoldierPool& P = *ctx.soldiers;
    const float linger = w.ai().tuning.edgeLinger;
    g.watchTicks += 1;
    for (uint32_t i = 0; i < P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i) || P.post[i] != POST_NONE || P.state[i] != SoldierState::Idle) continue;
        const V3 q = P.pos[i];
        if (!SoldierAI::roofOf(ctx, q)) continue;
        const float dh = std::hypot(q.x - P.home[i].x, q.z - P.home[i].z);
        if (dh > 0.7f && P.stateTime[i] <= linger + 1.f) continue;   // lingering after a shot from the edge
        const float e = ctx.nav->edgeClearance(q.x, q.z);
        g.watchMinEdge = std::min(g.watchMinEdge, (double)e);
        if (e < 1.0f) {
            if (g.watchViol < 5) std::printf("  roofwatch: soldier %u idle %.1f m from the edge at (%.1f %.2f %.1f), home %.1f m away\n", i, e, q.x, q.y, q.z, dh);
            g.watchViol += 1;
        }
    }
}

bool roofVerb(GameWorld& w, const ScriptLine& L, std::string& err) {
    const std::vector<std::string>& a = L.args;
    const GameContext& ctx = w.context();
    if (L.verb != "roofinfo" && L.verb != "roofclicks" && L.verb != "roofpath" && L.verb != "roofwatch") return false;
    if (!ctx.nav || !ctx.nav->ready()) { err = L.verb + ": no navigation grid"; return true; }
    NavGrid& nav = *ctx.nav;
    if (L.verb == "roofwatch") { g.watch = true; return true; }
    if (L.verb == "roofinfo") {
        if (a.size() < 2) { err = "roofinfo X Z"; return true; }
        const V3 p{fa(a, 0), 0, fa(a, 1)};
        std::vector<V3> starts;
        roofLevels(ctx, p, starts);
        std::printf("  roofinfo (%.1f %.1f): surface %.2f walkable %d island %u roof %d, %zu roof level(s)\n", p.x, p.z, nav.surface(p.x, p.z),
                    (int)nav.walkable(p.x, p.z), nav.island(p.x, p.z), (int)nav.onRoof(p.x, p.z), starts.size());
        for (const V3& s : starts) {
            std::vector<V3> cells;
            nav.islandCells(s, 80.f, 40000, cells);
            int inset = 0, rim = 0, nearObj = 0;
            float minX = 1e9f, maxX = -1e9f, minZ = 1e9f, maxZ = -1e9f;
            for (const V3& c : cells) {
                const float e = nav.cellEdge(c.x, c.z), o = nav.cellObstacle(c.x, c.z);
                inset += e >= nav.roofEdgeInset && o >= 0.6f ? 1 : 0;
                rim += e < 0.5f ? 1 : 0;
                nearObj += o < 0.5f ? 1 : 0;
                minX = std::min(minX, c.x); maxX = std::max(maxX, c.x); minZ = std::min(minZ, c.z); maxZ = std::max(maxZ, c.z);
            }
            std::printf("    level %.2f at (%.1f %.1f): island %u, %zu cells (%.0f m2), bounds x %.1f..%.1f z %.1f..%.1f, inset %d, rim %d, beside roof objects %d\n",
                        s.y, s.x, s.z, nav.island(s.x, s.z), cells.size(), cells.size() * nav.cell() * nav.cell(), minX, maxX, minZ, maxZ, inset, rim, nearObj);
        }
        return true;
    }
    if (L.verb == "roofclicks") {
        if (a.size() < 5) { err = "roofclicks X0 Z0 X1 Z1 STEP [sniper|rifle|mg|crate]"; return true; }
        const float x0 = std::min(fa(a, 0), fa(a, 2)), x1 = std::max(fa(a, 0), fa(a, 2)), z0 = std::min(fa(a, 1), fa(a, 3)), z1 = std::max(fa(a, 1), fa(a, 3));
        const float step = std::max(0.25f, fa(a, 4));
        const std::string kind = a.size() > 5 ? a[5] : "sniper";
        const SquadType t = kind == "rifle" ? SquadType::Rifle : kind == "mg" ? SquadType::MachineGun : SquadType::Sniper;
        g.clickN = g.clickValid = g.clickRefused = 0; g.clickMinEdge = 99; g.clickMaxSnap = 0;
        int shown = 0;
        for (float z = z0; z <= z1 + 1e-3f; z += step)
            for (float x = x0; x <= x1 + 1e-3f; x += step) {
                const V3 p{x, 0, z};
                std::vector<V3> roofs;
                roofLevels(ctx, p, roofs);
                if (roofs.empty()) continue;   // a street click: not what this verb measures
                g.clickN += 1;
                std::vector<V3> spots;
                const char* why = "";
                if (kind == "crate") {
                    V3 s;
                    if (w.logistics().airdropSpot(ctx, p, s, &why)) spots.push_back(s);
                } else {
                    const DropPlan pl = w.deploy().plan(ctx, t, p);
                    if (pl.valid && pl.rooftop) spots = pl.landing;
                    else why = pl.valid ? "landed on the street" : pl.reason;
                }
                if (spots.empty()) {
                    g.clickRefused += 1;
                    if (shown++ < 6) std::printf("  roofclicks: refused at (%.1f %.1f) surface %.2f: %s\n", x, z, nav.surface(x, z), why);
                    continue;
                }
                g.clickValid += 1;
                for (const V3& s : spots) g.clickMinEdge = std::min(g.clickMinEdge, (double)nav.edgeClearance(s.x, s.z));
                g.clickMaxSnap = std::max(g.clickMaxSnap, (double)std::hypot(spots[0].x - x, spots[0].z - z));
            }
        std::printf("  roofclicks %s: %.0f roof clicks, %.0f valid, %.0f refused, min edge clearance %.2f m, max snap %.1f m\n", kind.c_str(), g.clickN,
                    g.clickValid, g.clickRefused, g.clickMinEdge, g.clickMaxSnap);
        return true;
    }
    // roofpath
    if (a.size() < 4) { err = "roofpath X0 Z0 X1 Z1"; return true; }
    V3 p0{fa(a, 0), 0, fa(a, 1)}, p1{fa(a, 2), 0, fa(a, 3)};
    p0.y = nav.surface(p0.x, p0.z); p1.y = nav.surface(p1.x, p1.z);
    const uint32_t id = nav.requestPath(p0, p1);
    std::vector<V3> out;
    bool failed = true;
    for (int k = 0; k < 400 && !nav.poll(id, out, failed); ++k) nav.tick(200000);
    g.pathOk = failed || out.empty() ? 0 : 1;
    g.pathMinObs = g.pathMinEdge = 99; g.pathLen = 0;
    g.pathDirect = std::hypot(p1.x - p0.x, p1.z - p0.z);
    if (g.pathOk) {
        V3 prev = p0;
        const uint32_t isl = nav.island(p0.x, p0.z);
        for (const V3& q : out) {
            const float l = std::hypot(q.x - prev.x, q.z - prev.z);
            const int n = std::max(1, (int)std::ceil(l / 0.1f));
            for (int s = 0; s <= n; ++s) {
                const float t = (float)s / n, x = prev.x + (q.x - prev.x) * t, z = prev.z + (q.z - prev.z) * t;
                if (std::hypot(x - p0.x, z - p0.z) < 0.8f || std::hypot(x - p1.x, z - p1.z) < 0.8f) continue;   // the given ends
                g.pathMinObs = std::min(g.pathMinObs, (double)nav.obstacleClearance(x, z));
                g.pathMinEdge = std::min(g.pathMinEdge, (double)nav.edgeClearance(x, z));
                if (nav.island(x, z) != isl) g.pathOk = 0;
            }
            g.pathLen += l;
            prev = q;
        }
    }
    std::printf("  roofpath (%.1f %.1f) -> (%.1f %.1f): %s, %zu waypoints, length %.1f m (direct %.1f), min clearance: obstacles %.2f m, edge %.2f m\n", p0.x, p0.z,
                p1.x, p1.z, g.pathOk ? "ok" : "FAILED", out.size(), g.pathLen, g.pathDirect, g.pathMinObs, g.pathMinEdge);
    return true;
}

bool roofMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) {
    if (m == "roofclick" || m == "roofpath" || m == "roofwatch") {
        if (k >= a.size()) { err = m + " <field>"; return true; }
        const std::string f = a[k++];
        if (m == "roofclick") out = f == "n" ? g.clickN : f == "valid" ? g.clickValid : f == "refused" ? g.clickRefused : f == "minedge" ? g.clickMinEdge : g.clickMaxSnap;
        else if (m == "roofpath") out = f == "ok" ? g.pathOk : f == "minobs" ? g.pathMinObs : f == "minedge" ? g.pathMinEdge : f == "len" ? g.pathLen : g.pathDirect;
        else out = f == "ticks" ? g.watchTicks : f == "violations" ? g.watchViol : g.watchMinEdge;
        return true;
    }
    if (m == "roofsteps") { out = (double)w.ai().edgeSteps(); return true; }
    if (m == "roofreturns") { out = (double)w.ai().edgeReturns(); return true; }
    if (m == "roofedge" || m == "roofobs") {
        if (k >= a.size()) { err = m + " N"; return true; }
        const int n = std::atoi(a[k++].c_str());
        const GameContext& ctx = w.context();
        if (n < 1 || n > (int)ctx.squads->squads.size() || !ctx.nav) { err = "no squad " + std::to_string(n); return true; }
        const Squad& s = ctx.squads->squads[(size_t)n - 1];
        const SoldierPool& P = *ctx.soldiers;
        out = NavGrid::kRoofScan;
        for (const SoldierId& id : s.members)
            if (P.valid(id) && P.alive(id.index))
                out = std::min(out, (double)(m == "roofedge" ? ctx.nav->edgeClearance(P.pos[id.index].x, P.pos[id.index].z)
                                                             : ctx.nav->obstacleClearance(P.pos[id.index].x, P.pos[id.index].z)));
        return true;
    }
    return false;
}

} // namespace ttz::game
