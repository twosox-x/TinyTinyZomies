// Self-test section "walls / territory" (B2): placement validation and snapping, piece / joint selection, pressure
// damage and breaches, territory enclosure (irregular, open, several regions, merge on breach), containers and
// buildings closing gaps, gates (closed for zombies and territory, walkable for soldiers' NavGrid), region states and
// income rules. CPU only. Called from SelfTest.cpp (testGameCore); returns the failure count.
#include "game/Config.h"
#include "game/NavGrid.h"
#include "game/Territory.h"
#include "game/Walls.h"

#include <cmath>
#include <cstdio>
#include <string>

namespace ttz::game {

namespace {
int g_fail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_fail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0, double d = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c, d);
    return buf;
}
// a flat street with one 12 m building block at x, z in [40, 52] and a parked vehicle at (20, 60)
WallEnv testEnv() {
    WallEnv e;
    e.ground = [](float x, float z) { return (x >= 40 && x <= 52 && z >= 40 && z <= 52) ? 12.f : 0.f; };
    e.solid = [](float x, float z) { return (std::fabs(x - 20) < 2.2f && std::fabs(z - 60) < 1.f) ? 1.5f : ((x >= 40 && x <= 52 && z >= 40 && z <= 52) ? 12.f : 0.f); };
    e.simulated = [](float x, float z) { return x > -100 && z > -100 && x < 200 && z < 200; };
    return e;
}
std::vector<V3> path(std::initializer_list<std::pair<float, float>> pts) {
    std::vector<V3> v;
    for (auto [x, z] : pts) v.push_back({x, 0, z});
    return v;
}
bool build(Walls& W, const std::vector<V3>& pts, WallType t = WallType::Cheap, bool gate = false, const WallEnv& env = testEnv()) {
    WallPlan p = W.plan(pts, t, gate, env);
    if (!p.valid) return false;
    return !W.commit(p).empty();
}
TerritoryInput input(const Walls& W, std::vector<Obb> containers = {}) {
    TerritoryInput in;
    in.walls = &W;
    in.containers = std::move(containers);
    const WallEnv e = testEnv();
    in.env = [e](float x, float z) { return e.ground(x, z) > 0.9f ? 2 : 1; };
    return in;
}
} // namespace

int runFortSelfTest(const BalanceConfig& cfg) {
    g_fail = 0;
    std::printf("walls / territory (B2)\n");
    const FortConfig& F = cfg.fort;
    // ---- placement, snapping, pieces, joints
    {
        Walls W;
        W.configure(F);
        WallPlan p = W.plan(path({{0, 0}, {12, 0}}), WallType::Cheap, false, testEnv());
        check(p.valid && p.pieces.size() == 3 && p.price == 3 * F.wallPrice[0], "a 12 m straight run = 3 approved 4 m pieces, price per piece",
              fmt("valid %.0f, pieces %.0f, price %.0f", p.valid, (double)p.pieces.size(), p.price));
        WallPlan b = W.plan(path({{30, 46}, {60, 46}}), WallType::Cheap, false, testEnv());
        WallPlan v = W.plan(path({{14, 60}, {26, 60}}), WallType::Cheap, false, testEnv());
        WallPlan o = W.plan(path({{-100, 0}, {-120, 0}}), WallType::Cheap, false, testEnv());
        check(!b.valid && std::string(b.reason).find("building") != std::string::npos && !v.valid && std::string(v.reason).find("vehicle") != std::string::npos && !o.valid,
              "placement refused through a building, on a vehicle, outside the window (with the reason)", std::string(b.reason) + " / " + v.reason + " / " + o.reason);
        check(build(W, path({{0, 0}, {12, 0}})), "valid run builds", "");
        WallPlan ov = W.plan(path({{2, 0.3f}, {10, 0.3f}}), WallType::Cheap, false, testEnv());
        WallPlan sharp = W.plan(path({{12, 0}, {0, 2}}), WallType::Cheap, false, testEnv());
        check(!ov.valid && !sharp.valid, "overlapping walls and too-sharp joints refused", std::string(ov.reason) + " / " + sharp.reason);
        int node = -1;
        V3 s = W.snap({11.2f, 0, 0.9f}, nullptr, false, node);
        V3 g = W.snap({5.3f, 0, 7.6f}, nullptr, false, node);
        V3 from{0, 0, 20};
        V3 l = W.snap({9.3f, 0, 20.4f}, &from, false, node);
        check(std::fabs(s.x - 12) < 1e-4f && std::fabs(s.z) < 1e-4f && g.x == 5.5f && g.z == 7.5f && std::fabs(std::hypot(l.x, l.z - 20) - 8.f) < 0.01f,
              "snapping: existing joint, 0.5 m grid, drag length in whole 4 m pieces", fmt("joint (%.1f %.1f), drag length %.2f", s.x, s.z, std::hypot(l.x, l.z - 20)));
        // GAME_DESIGN 14e: 0.5 m granularity (filler pieces) and ends sealed onto facades / containers / walls
        {
            Walls Wf;
            Wf.configure(F);
            const WallPlan f1 = Wf.plan(path({{0, -30}, {8.5f, -30}}), WallType::Cheap, false, testEnv());
            const bool fillOk = f1.valid && f1.pieces.size() == 3 && std::fabs(std::hypot(f1.pieces[2].bx - f1.pieces[2].ax, f1.pieces[2].bz - f1.pieces[2].az) - 0.5f) < 0.01f;
            check(fillOk, "0.5 m granularity: 8.5 m = two 4 m pieces + a 0.5 m filler", fmt("valid %.0f pieces %.0f", f1.valid, (double)f1.pieces.size()));
            const WallPlan s1 = Wf.plan(path({{30, 44}, {38.9f, 44}}), WallType::Cheap, false, testEnv());   // 1.1 m short of the facade x = 40
            const float endX = s1.pieces.empty() ? 0.f : s1.pieces.back().bx;
            check(s1.valid && s1.sealBack == 1 && endX > 40.f && endX < 41.5f, "an end 1.1 m in front of a facade is sealed into it (no gap)", fmt("end x %.2f, seal %.0f", endX, s1.sealBack));
            Obb cont{20.f, -50.f, 3.05f, 1.25f, 0.f, 2.6f};
            WallEnv ce = testEnv();
            ce.containers.push_back(cont);
            const WallPlan s2 = Wf.plan(path({{20, -40}, {20, -47.5f}}), WallType::Cheap, false, ce);   // 1.25 m short of the container
            const float endZ = s2.pieces.empty() ? 0.f : s2.pieces.back().bz;
            check(s2.valid && s2.sealBack == 2 && endZ < -48.8f && endZ > -49.3f, "an end in front of a container is sealed onto it", fmt("end z %.2f", endZ) + " " + s2.reason);
            build(Wf, path({{50, -60}, {50, -40}}));
            const WallPlan s3 = Wf.plan(path({{40, -50}, {48.8f, -50}}), WallType::Cheap, false, testEnv());   // 1.2 m short of a wall
            check(s3.valid && s3.sealBack == 3 && std::fabs(s3.pieces.back().bx - 50.f) < 0.01f && s3.pieces.back().splitB >= 0, "an end in front of a wall becomes a T junction on it",
                  fmt("end x %.2f", s3.pieces.empty() ? 0.0 : s3.pieces.back().bx) + " " + s3.reason);
        }
        const WallPlan c1 = W.plan(path({{12, 0}, {12, 12}}), WallType::Cheap, false, testEnv());
        const bool b1 = c1.valid && !W.commit(c1).empty();
        const WallPlan c2 = W.plan(path({{4, 0}, {4, -8}}), WallType::Cheap, false, testEnv());
        const bool b2 = c2.valid && !W.commit(c2).empty();
        check(b1 && b2, "walls connect to existing joints (corner, T)", std::string(c1.reason) + " / " + c2.reason);
        float yaw; WallType t;
        const int nc = W.nearestNode(12, 0, 0.1f), nt = W.nearestNode(4, 0, 0.1f), ne = W.nearestNode(0, 0, 0.1f), ns = W.nearestNode(8, 0, 0.1f);
        const bool shapes = nc >= 0 && nt >= 0 && ne >= 0 && W.joint((uint32_t)nc, yaw, t) == JointShape::Corner && W.joint((uint32_t)nt, yaw, t) == JointShape::T &&
                            W.joint((uint32_t)ne, yaw, t) == JointShape::End && (ns < 0 || W.joint((uint32_t)ns, yaw, t) == JointShape::None);
        check(shapes, "automatic joint pieces: end cap, corner, T, straight butt joint", "");
        WallPlan x = W.plan(path({{4, 0}, {4, 8}}), WallType::Cheap, false, testEnv());
        check(x.valid, "a fourth connection at a T is allowed (becomes an X post)", x.reason);
    }
    // ---- territory: irregular closed perimeter, open perimeter, states, income
    {
        Walls W;
        W.configure(F);
        Territory T;
        T.configure(F);
        // irregular hexagon-ish perimeter, left open on the last leg
        const auto ring = path({{0, 0}, {24, 0}, {32, 12}, {24, 28}, {4, 28}, {-6, 14}});
        build(W, ring);
        T.rebuild(input(W));
        check(T.regions().empty() && T.incomePerMin() == 0.0, "open perimeter: no region, no income", fmt("regions %.0f", (double)T.regions().size()));
        build(W, path({{-6, 14}, {0, 0}}));
        T.rebuild(input(W));
        const float area = T.regions().empty() ? 0.f : T.regions()[0].area;
        check(T.regions().size() == 1 && area > 500.f && area < 900.f, "irregular closed perimeter encloses one region (area ~ polygon minus wall)", fmt("area %.0f m2", area));
        check(T.regions().size() == 1 && T.regions()[0].state == RegionState::Uncleared && T.incomePerMin() == 0.0, "new region starts uncleared (zombie count unknown): no income", "");
        T.setZombieCounts(T.version(), {4});
        for (int k = 0; k < 150; ++k) T.tick(1.f / 30.f, &W);
        check(T.regions()[0].state == RegionState::Uncleared && T.incomePerMin() == 0.0, "enclosed with live zombies: no income until cleared", fmt("zombies %.0f", T.regions()[0].zombies));
        T.setZombieCounts(T.version(), {0});
        for (int k = 0; k < (int)(F.clearDelay * 30) + 3; ++k) T.tick(1.f / 30.f, &W);
        const double inc = T.incomePerMin();
        check(T.regions()[0].state == RegionState::Controlled && std::fabs(inc - area / 10000.0 * F.incomePerHectarePerMin) < 1e-6,
              "cleared for clearDelay: controlled, income = area x rate", fmt("income %.1f/min", inc));
        T.setZombieCounts(T.version(), {2});
        T.tick(1.f / 30.f, &W);
        const bool paused = T.regions()[0].state == RegionState::Threatened && T.incomePerMin() == 0.0;
        for (int k = 0; k < (int)(F.lossTime * 30) + 3; ++k) T.tick(1.f / 30.f, &W);
        check(paused && T.regions()[0].state == RegionState::Uncleared, "zombies inside a controlled region: threatened (income paused), lost after lossTime", "");
        T.setZombieCounts(T.version(), {0});
        for (int k = 0; k < (int)(F.clearDelay * 30) + 3; ++k) T.tick(1.f / 30.f, &W);
        const uint32_t id = T.regions()[0].id;
        // a rebuild with the same walls keeps the region and its state
        T.rebuild(input(W));
        check(T.regions().size() == 1 && T.regions()[0].id == id && T.regions()[0].state == RegionState::Controlled, "rebuild keeps the region id and state", "");
        // pressure damage and a breach
        const int p = W.nearestPiece(12, 0, 1.f);
        const float hp0 = W.pieces()[(size_t)p].hp;
        W.addPressure((uint32_t)p, (float)F.pressureThreshold, 1.f);
        const float hp1 = W.pieces()[(size_t)p].hp;
        W.addPressure((uint32_t)p, (float)F.pressureThreshold + 10.f, 1.f);
        const float hp2 = W.pieces()[(size_t)p].hp;
        check(hp1 == hp0 && std::fabs((hp1 - hp2) - 10.f * F.damagePerZombie) < 1e-3f, "pressure: a few zombies do nothing, a crowd damages (rate per zombie beyond the threshold)",
              fmt("%.1f -> %.1f -> %.1f", hp0, hp1, hp2));
        for (int k = 0; k < 10000 && W.pieces()[(size_t)p].alive; ++k) W.addPressure((uint32_t)p, 60.f, 1.f / 30.f);
        std::vector<Walls::Destroyed> d;
        W.takeDestroyed(d);
        T.rebuild(input(W));
        std::vector<TerritoryNotice> notes;
        T.takeNotices(notes);
        bool breachNote = false;
        for (const TerritoryNotice& n : notes) breachNote |= n.bad && n.text.find("Breach") != std::string::npos;
        check(!W.pieces()[(size_t)p].alive && d.size() == 1 && W.rubble().size() == 1 && T.regions().empty() && breachNote,
              "destroyed piece -> breach: rubble, region gone, breach notice", fmt("regions %.0f", (double)T.regions().size()));
        // a container closes the gap
        const Obb gap = W.rubble()[0].box;
        Obb c{gap.cx, gap.cz, 3.05f, 1.25f, gap.yaw, 2.6f};
        T.rebuild(input(W, {c}));
        check(T.regions().size() == 1, "a supply container closes the gap (acts as a wall piece)", fmt("regions %.0f", (double)T.regions().size()));
        // a gate closes it too (PROPOSED gate: closed for territory)
        WallPlan gp = W.plan(path({{gap.cx - 2.f * std::cos(gap.yaw), gap.cz + 2.f * std::sin(gap.yaw)}, {gap.cx + 2.f * std::cos(gap.yaw), gap.cz - 2.f * std::sin(gap.yaw)}}),
                             WallType::Cheap, true, testEnv());
        // snap the gate onto the existing joints of the gap
        if (gp.pieces.size() == 1) { gp.pieces[0].nodeA = W.nearestNode(gp.pieces[0].ax, gp.pieces[0].az, 0.5f); gp.pieces[0].nodeB = W.nearestNode(gp.pieces[0].bx, gp.pieces[0].bz, 0.5f); }
        const bool gateOk = gp.valid && !W.commit(gp).empty();
        T.rebuild(input(W));
        check(gateOk && W.aliveGates() == 1 && T.regions().size() == 1, "a gate counts as closed for territory", gp.reason);
    }
    // ---- several regions, building as part of the perimeter, merge on breach
    {
        Walls W;
        W.configure(F);
        Territory T;
        T.configure(F);
        build(W, path({{0, 80}, {16, 80}, {16, 96}, {0, 96}, {0, 80}}));
        const WallPlan second = W.plan(path({{16, 80}, {32, 80}, {32, 96}, {16, 96}}), WallType::Cheap, false, testEnv());
        if (!second.valid) std::printf("    second compound refused: %s\n", second.reason);
        W.commit(second);
        T.rebuild(input(W));
        const size_t two = T.regions().size();
        const int shared = W.nearestPiece(16, 86, 1.f);
        W.destroy((uint32_t)shared);
        T.rebuild(input(W));
        check(two == 2 && T.regions().size() == 1 && T.regions()[0].area > 350.f, "two adjacent regions; breaking the shared wall merges them", fmt("%.0f -> %.0f regions, %.0f m2", (double)two, (double)T.regions().size(), T.regions().empty() ? 0.0 : T.regions()[0].area));
        Walls W2;
        W2.configure(F);
        const WallPlan u = W2.plan(path({{40.3f, 42}, {28, 42}, {28, 50}, {40.3f, 50}}), WallType::Cheap, false, testEnv());   // U against the building's west face
        if (!u.valid) std::printf("    U refused: %s\n", u.reason);
        W2.commit(u);
        T.reset();
        T.rebuild(input(W2));
        check(T.regions().size() == 1, "walls closing against a building enclose territory (building = blocked)", fmt("regions %.0f", (double)T.regions().size()));
    }
    {   // reinforced U closed by a cheap gate (b2_gate.txt geometry)
        Walls W;
        W.configure(F);
        Territory T;
        T.configure(F);
        const WallPlan u = W.plan(path({{-13.5f, 103}, {-16, 103}, {-16, 114}, {-7, 114}, {-7, 103}, {-9.5f, 103}}), WallType::Reinforced, false, testEnv());
        W.commit(u);
        const WallPlan g = W.plan(path({{-13.5f, 103}, {-9.5f, 103}}), WallType::Cheap, true, testEnv());
        W.commit(g);
        T.rebuild(input(W));
        check(u.valid && g.valid && T.regions().size() == 1, "reinforced walls closed by a gate enclose a region", fmt("%.0f regions, %.0f pieces", (double)T.regions().size(), (double)W.alivePieces()));
    }
    // ---- gate: zombies blocked (obstacle), soldiers' NavGrid passes (gate cells lowered)
    {
        const int gw = 64, gh = 64;
        const float cs = 0.75f;
        Walls W;
        W.configure(F);
        WallEnv env = testEnv();
        build(W, path({{4, 24}, {20, 24}}), WallType::Cheap, false, env);
        build(W, path({{20, 24}, {24, 24}}), WallType::Cheap, true, env);
        build(W, path({{24, 24}, {44, 24}}), WallType::Cheap, false, env);
        std::vector<float> h((size_t)gw * gh, 0.f), hNav;
        std::vector<uint8_t> gate((size_t)gw * gh, 0);
        for (uint32_t i = 0; i < W.pieces().size(); ++i) {
            const Obb b = W.pieceBox(i);
            forEachObbCell(b, 0.f, 0.f, cs, gw, gh, [&](int x, int z) { h[(size_t)z * gw + x] = std::max(h[(size_t)z * gw + x], b.top); if (W.pieces()[i].gate) gate[(size_t)z * gw + x] = 1; });
        }
        for (uint32_t i = 0; i < W.pieces().size(); ++i)
            if (!W.pieces()[i].gate) forEachObbCell(W.pieceBox(i), 0.f, 0.f, cs, gw, gh, [&](int x, int z) { gate[(size_t)z * gw + x] = 0; });
        for (uint32_t n = 0; n < W.nodes().size(); ++n)
            if (W.nodes()[n].alive) {
                const Obb b = W.postBox(n);
                forEachObbCell(b, 0.f, 0.f, cs, gw, gh, [&](int x, int z) { h[(size_t)z * gw + x] = std::max(h[(size_t)z * gw + x], b.top); gate[(size_t)z * gw + x] = 0; });
            }
        // the wall spans the whole grid width except the margins: extend it to the edges so the only way through is the gate
        for (int x = 0; x < gw; ++x) if (x * cs < 4.5f || x * cs > 43.5f) h[(size_t)32 * gw + x] = 1.6f;
        hNav = h;
        int gateCells = 0;
        for (size_t c = 0; c < h.size(); ++c) if (gate[c]) { hNav[c] = 0.f; ++gateCells; }
        NavGrid zombieView, soldierView;
        zombieView.build(h, gw, gh, 0.f, 0.f, cs);
        soldierView.build(hNav, gw, gh, 0.f, 0.f, cs);
        const bool zBlocked = zombieView.island(22, 18) != zombieView.island(22, 30);
        const bool sPass = soldierView.island(22, 18) != 0 && soldierView.island(22, 18) == soldierView.island(22, 30);
        check(gateCells > 0 && zBlocked && sPass, "gate (PROPOSED): blocks the obstacle grid, walkable in the soldiers' NavGrid", fmt("gate cells %.0f", gateCells));
    }
    return g_fail;
}

} // namespace ttz::game
