// Headless scenario scripts (WS-D): command verbs, metrics and `expect` checks (see GameScript.h).
#include "game/GameScript.h"

#include "app/App.h"
#include "game/GameWorld.h"
#include "game/NavGrid.h"

#include <SDL3/SDL.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <fstream>
#include <sstream>

namespace ttz::game {

namespace {
bool num(const std::string& s, double& out) {
    char* e = nullptr;
    out = std::strtod(s.c_str(), &e);
    return e && *e == 0 && !s.empty();
}
float f(const std::vector<std::string>& a, size_t k, float def = 0.f) { return k < a.size() ? (float)std::atof(a[k].c_str()) : def; }

const Squad* squadN(GameWorld& w, int n) {
    const SquadList& sl = *w.context().squads;
    return n >= 1 && (size_t)n <= sl.squads.size() ? &sl.squads[(size_t)n - 1] : nullptr;
}
const SupplyPoint* supplyN(GameWorld& w, int n) {
    int k = 0;   // creation order among the points ever created (slots are reused only after a crate dissolved)
    for (const SupplyPoint& p : w.logistics().points()) if (++k == n) return &p;
    return nullptr;
}
} // namespace

bool GameScript::load(const std::string& path, std::string* error) {
    std::ifstream fs(path);
    if (!fs) { if (error) *error = "cannot open " + path; return false; }
    std::string text;
    int n = 0;
    while (std::getline(fs, text)) {
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
    std::stable_sort(lines_.begin(), lines_.end(), [](const ScriptLine& a, const ScriptLine& b) { return a.at < b.at; });
    return true;
}

bool GameScript::metric(GameWorld& w, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) const {
    if (k >= a.size()) { err = "missing metric"; return false; }
    if (num(a[k], out)) { ++k; return true; }
    const std::string m = a[k++];
    const GameContext& ctx = w.context();
    const Economy& eco = w.economy();
    const SoldierPool& P = *ctx.soldiers;
    const BalanceConfig& cfg = w.config();
    if (m == "kills") { out = (double)eco.kills(); return true; }
    if (m == "kills_soldier") { out = (double)eco.killsByCause(KillCause::Soldier); return true; }
    if (m == "kills_explosion") { out = (double)eco.killsByCause(KillCause::Explosion); return true; }
    if (m == "kills_other") { out = (double)eco.killsByCause(KillCause::Other); return true; }
    if (m == "dupes") { out = (double)eco.duplicatesDropped(); return true; }
    if (m == "funding") { out = eco.funding(); return true; }
    if (m == "spent") { out = eco.spentTotal(); return true; }
    if (m == "passive_total") { out = eco.totalByKind(LedgerKind::PassiveIncome); return true; }
    if (m == "reward_total") { out = eco.totalByKind(LedgerKind::KillReward); return true; }
    if (m == "reward_expected") {
        out = 0;
        for (int c = 0; c < 3; ++c) out += (double)eco.killsByCause((KillCause)c) * cfg.economy.killReward[(size_t)c];
        return true;
    }
    if (m == "ledger_sum") { out = 0; for (const LedgerEntry& e : eco.ledger()) out += e.amount; return true; }
    if (m == "shots") { out = (double)w.combat().roundsFired(); return true; }
    if (m == "soldiers") { out = 0; for (uint32_t i = 0; i < P.capacity(); ++i) out += P.used[i] ? 1 : 0; return true; }
    if (m == "soldiers_alive") { out = (double)P.liveCount(); return true; }
    if (m == "squads") { out = (double)ctx.squads->squads.size(); return true; }
    if (m == "dropped") { out = (double)w.deploy().soldiersDropped(); return true; }
    if (m == "landed") { out = (double)w.deploy().soldiersLanded(); return true; }
    if (m == "refused") { out = (double)w.purchasesRefused(); return true; }
    if (m == "time") { out = ctx.time; return true; }
    if (m == "zombies_live") { out = w.app() ? (double)w.app()->sim.stats().live : 0.0; return true; }
    if (m == "delivered") { out = 0; for (int t = 0; t < 3; ++t) out += (double)w.logistics().roundsDelivered((AmmoType)t); return true; }
    if (m == "squad") {
        double nn;
        if (k + 1 >= a.size() || !num(a[k], nn)) { err = "squad N <field>"; return false; }
        ++k;
        const Squad* s = squadN(w, (int)nn);
        const std::string fld = a[k++];
        if (!s) { err = "no squad " + std::to_string((int)nn); return false; }
        out = 0;
        if (fld == "size") { out = (double)s->members.size(); return true; }
        if (fld == "deploying") { out = s->deploying ? 1 : 0; return true; }
        if (fld == "ammo_start") { out = s->id.index < w.squadStarts().size() ? w.squadStarts()[s->id.index].ammo : 0; return true; }
        if (fld == "dist" || fld == "maxdist") {
            if (k + 1 >= a.size()) { err = "dist X Z"; return false; }
            const float x = f(a, k), z = f(a, k + 1);
            k += 2;
            double sum = 0, mx = 0;
            int n = 0;
            for (const SoldierId& m2 : s->members)
                if (P.valid(m2) && P.alive(m2.index)) {
                    const double d = std::hypot(P.pos[m2.index].x - x, P.pos[m2.index].z - z);
                    sum += d; mx = std::max(mx, d); ++n;
                }
            out = fld == "dist" ? (n ? sum / n : 1e9) : (n ? mx : 1e9);
            return true;
        }
        for (const SoldierId& m2 : s->members) {
            if (!P.valid(m2)) continue;
            const uint32_t i = m2.index;
            const bool al = P.alive(i);
            if (fld == "alive") out += al ? 1 : 0;
            else if (fld == "ammo") out += al ? P.mag[i] + P.reserve[i] : 0;
            else if (fld == "mag") out += al ? P.mag[i] : 0;
            else if (fld == "reserve") out += al ? P.reserve[i] : 0;
            else if (fld == "health") out += al ? P.health[i] : 0;
            else if (fld == "parachuted") out += w.deploy().parachuted(m2) ? 1 : 0;
            else { err = "unknown squad field " + fld; return false; }
        }
        return true;
    }
    if (m == "supply") {
        double nn;
        if (k + 1 >= a.size() || !num(a[k], nn)) { err = "supply N <field>"; return false; }
        ++k;
        const SupplyPoint* p = supplyN(w, (int)nn);
        const std::string fld = a[k++];
        if (!p) { err = "no supply point " + std::to_string((int)nn); return false; }
        if (fld == "stock") out = p->total();
        else if (fld == "initial") out = p->initialTotal;
        else if (fld == "delivered") out = p->initialTotal - p->total();
        else if (fld == "landed") out = p->landed ? 1 : 0;
        else if (fld == "users") { out = 0; for (const SoldierId& u : p->slotUser) out += u.valid() ? 1 : 0; }
        else { err = "unknown supply field " + fld; return false; }
        return true;
    }
    err = "unknown metric " + m;
    return false;
}

void GameScript::expect(GameWorld& w, const ScriptLine& L) {
    const Economy& eco = w.economy();
    const BalanceConfig& cfg = w.config();
    auto report = [&](bool ok, const std::string& what) {
        if (ok) ++passes_; else ++failures_;
        std::printf("  [%s] t=%6.1f line %d: expect %s\n", ok ? "PASS" : "FAIL", w.context().time, L.line, what.c_str());
        std::fflush(stdout);
    };
    std::string text;
    for (const std::string& s : L.args) text += s + " ";
    if (!L.args.empty() && L.args[0] == "funding_reward_matches_kills") {
        double exp = 0;
        for (int c = 0; c < 3; ++c) exp += (double)eco.killsByCause((KillCause)c) * cfg.economy.killReward[(size_t)c];
        const double got = eco.totalByKind(LedgerKind::KillReward);
        char b[160];
        std::snprintf(b, sizeof(b), "%s(rewards %.1f == kills %llu x reward = %.1f)", text.c_str(), got, (unsigned long long)eco.kills(), exp);
        report(std::fabs(got - exp) < 1e-6, b);
        return;
    }
    if (!L.args.empty() && L.args[0] == "ledger_balanced") {
        double sum = eco.pendingPassive();
        for (const LedgerEntry& e : eco.ledger()) sum += e.amount;
        char b[160];
        std::snprintf(b, sizeof(b), "%s(funding %.3f == ledger %.3f)", text.c_str(), eco.funding(), sum);
        report(std::fabs(sum - eco.funding()) < 1e-6 * std::max(1.0, std::fabs(sum)) + 1e-6, b);
        return;
    }
    if (!L.args.empty() && L.args[0] == "no_duplicate_rewards") {
        size_t rewards = 0;
        for (const LedgerEntry& e : eco.ledger()) rewards += e.kind == LedgerKind::KillReward && e.what.rfind("kill", 0) == 0 && e.what.find("overflow") == std::string::npos ? 1 : 0;
        uint64_t paidKills = 0;
        for (int c = 0; c < 3; ++c) paidKills += cfg.economy.killReward[(size_t)c] != 0 ? eco.killsByCause((KillCause)c) : 0;
        char b[160];
        std::snprintf(b, sizeof(b), "%s(reward entries %zu, paid kills %llu, duplicates dropped %llu)", text.c_str(), rewards,
                      (unsigned long long)paidKills, (unsigned long long)eco.duplicatesDropped());
        report(rewards <= paidKills, b);
        return;
    }
    size_t k = 0;
    double lhs = 0, rhs = 0;
    std::string err;
    auto sum = [&](double& out) {   // metric (+|- metric)*
        if (!metric(w, L.args, k, out, err)) return false;
        while (k < L.args.size() && (L.args[k] == "+" || L.args[k] == "-")) {
            const bool plus = L.args[k++] == "+";
            double v = 0;
            if (!metric(w, L.args, k, v, err)) return false;
            out += plus ? v : -v;
        }
        return true;
    };
    if (!sum(lhs)) { report(false, text + "(" + err + ")"); return; }
    if (k >= L.args.size()) { report(false, text + "(missing operator)"); return; }
    const std::string op = L.args[k++];
    if (!sum(rhs)) { report(false, text + "(" + err + ")"); return; }
    bool ok;
    if (op == "==") ok = std::fabs(lhs - rhs) < 1e-6;
    else if (op == "!=") ok = std::fabs(lhs - rhs) >= 1e-6;
    else if (op == ">=") ok = lhs >= rhs - 1e-9;
    else if (op == "<=") ok = lhs <= rhs + 1e-9;
    else if (op == ">") ok = lhs > rhs;
    else if (op == "<") ok = lhs < rhs;
    else { report(false, text + "(bad operator " + op + ")"); return; }
    char b[96];
    std::snprintf(b, sizeof(b), "(%g %s %g)", lhs, op.c_str(), rhs);
    report(ok, text + b);
}

bool GameScript::tick(GameWorld& world, double time) {
    while (!ended_ && next_ < lines_.size() && lines_[next_].at <= time + 1e-9) {
        const ScriptLine& L = lines_[next_++];
        const std::vector<std::string>& a = L.args;
        CommandQueue& q = world.commands();
        AppState* app = world.app();
        auto bad = [&](const char* what) { std::printf("  [FAIL] line %d: %s\n", L.line, what); ++failures_; };
        if (L.verb == "end") {
            ended_ = true;
            std::printf("game script: %d passed, %d failed (t=%.1f s, %llu ticks)\n", passes_, failures_, time, (unsigned long long)world.ticks());
        } else if (L.verb == "spawn") {
            if (a.size() < 3) { bad("spawn COUNT X Z [RADIUS]"); continue; }
            Command c; c.type = CommandType::Spawn; c.count = std::atoi(a[0].c_str()); c.pos = {f(a, 1), 0, f(a, 2)}; c.facing = f(a, 3, 10.f);
            q.push(c);
        } else if (L.verb == "buy") {
            if (a.size() < 3) { bad("buy rifle|mg|sniper X Z"); continue; }
            Command c; c.type = CommandType::BuySquad;
            c.squadType = a[0] == "mg" ? SquadType::MachineGun : a[0] == "sniper" ? SquadType::Sniper : SquadType::Rifle;
            c.pos = {f(a, 1), 0, f(a, 2)};
            q.push(c);
        } else if (L.verb == "move" || L.verb == "stop") {
            const Squad* s = a.empty() ? nullptr : squadN(world, std::atoi(a[0].c_str()));
            if (!s || (L.verb == "move" && a.size() < 3)) { bad("move N X Z [run] / stop N (no such squad)"); continue; }
            Command c; c.type = L.verb == "move" ? CommandType::Move : CommandType::Stop; c.squads = {s->id};
            if (L.verb == "move") {
                c.pos = {f(a, 1), 0, f(a, 2)};
                if (world.context().nav && world.context().nav->ready()) c.pos.y = world.context().nav->surface(c.pos.x, c.pos.z);
                c.run = a.size() > 3 && a[3] == "run";
                const SoldierPool& P = *world.context().soldiers;
                V3 cen{}; int n = 0;
                for (const SoldierId& m : s->members) if (P.valid(m) && P.alive(m.index)) { cen = cen + P.pos[m.index]; ++n; }
                if (n) { cen = cen * (1.f / n); c.facing = std::atan2(c.pos.x - cen.x, c.pos.z - cen.z); }
            }
            q.push(c);
        } else if (L.verb == "airdrop") {
            if (a.size() < 2) { bad("airdrop X Z"); continue; }
            Command c; c.type = CommandType::BuyAirdrop; c.pos = {f(a, 0), 0, f(a, 1)}; q.push(c);
        } else if (L.verb == "container") {
            if (a.size() < 2) { bad("container X Z [YAW]"); continue; }
            Command c; c.type = CommandType::BuyContainer; c.pos = {f(a, 0), 0, f(a, 1)}; c.facing = f(a, 2); q.push(c);
        } else if (L.verb == "select") {
            Command c; c.type = CommandType::Select;
            for (const std::string& s : a) if (const Squad* sq = squadN(world, std::atoi(s.c_str()))) c.squads.push_back(sq->id);
            q.push(c);
            world.ui().selection().squads = c.squads;
        } else if (L.verb == "preview") {
            if (!a.empty() && a[0] == "off") { world.ui().clearForcedPreview(); continue; }
            if (a.size() < 3) { bad("preview rifle|mg|sniper|container|airdrop X Z | preview off"); continue; }
            const Tool t = a[0] == "mg" ? Tool::BuyMG : a[0] == "sniper" ? Tool::BuySniper : a[0] == "container" ? Tool::PlaceContainer
                         : a[0] == "airdrop" ? Tool::Airdrop : Tool::BuyRifle;
            V3 p{f(a, 1), 0, f(a, 2)};
            if (world.context().nav && world.context().nav->ready()) p.y = world.context().nav->surface(p.x, p.z);
            world.ui().forcePreview(t, p);
        } else if (L.verb == "camera") {
            if (!app || a.size() < 2) { bad("camera X Z [YAW PITCH DIST]"); continue; }
            app->camera.setImmediate({f(a, 0), 0.f, f(a, 1)}, f(a, 2, app->camera.yaw()), f(a, 3, app->camera.pitch()), f(a, 4, app->camera.distance()));
        } else if (L.verb == "shot") {
            if (a.empty()) { bad("shot FILE.png"); continue; }
            shot_ = a[0];
        } else if (L.verb == "log" || L.verb == "squadinfo") {
            const GameContext& ctx = world.context();
            const SoldierPool& P = *ctx.soldiers;
            std::printf("  t=%6.1f funding %.0f (+%.0f/min) kills %llu shots %llu soldiers %zu/%zu squads %zu zombies %u delivered %.0f\n", ctx.time,
                        world.economy().funding(), world.economy().incomePerMinute(), (unsigned long long)world.economy().kills(),
                        (unsigned long long)world.combat().roundsFired(), P.liveCount(), P.capacity(), ctx.squads->squads.size(),
                        app ? app->sim.stats().live : 0u, [&] { double d = 0; for (int t = 0; t < 3; ++t) d += (double)world.logistics().roundsDelivered((AmmoType)t); return d; }());
            for (size_t si = 0; si < ctx.squads->squads.size(); ++si) {
                const Squad& s = ctx.squads->squads[si];
                if (L.verb == "squadinfo" && !a.empty() && (int)si + 1 != std::atoi(a[0].c_str())) continue;
                std::printf("    squad %zu (%s %u) alive %d/%zu flags 0x%02x order %s (%.1f %.1f)\n", si + 1, s.type == SquadType::Rifle ? "rifle" : s.type == SquadType::MachineGun ? "mg" : "sniper",
                            s.number, ctx.squads->aliveMembers(s, P), s.members.size(), s.flags, s.order.active ? "move" : "hold", s.order.dest.x, s.order.dest.z);
                for (const SoldierId& m : s.members) {
                    if (!P.valid(m)) continue;
                    const uint32_t i = m.index;
                    std::printf("      #%u %-9s %-11s pos (%.1f %.1f %.1f) hp %.0f ammo %d|%d\n", i, className(P.cls[i]), stateName(P.state[i]), P.pos[i].x, P.pos[i].y,
                                P.pos[i].z, P.health[i], P.mag[i], P.reserve[i]);
                }
            }
            for (const SupplyPoint& p : world.logistics().points())
                if (p.alive) std::printf("    supply %s at (%.1f %.1f %.1f) %s stock %d/%d/%d\n", p.kind == SupplyKind::Container ? "container" : "crate", p.pos.x, p.pos.y, p.pos.z,
                                         p.landed ? "landed" : "descending", p.stock[0], p.stock[1], p.stock[2]);
            std::fflush(stdout);
        } else if (L.verb == "setammo") {   // TEST HOOK (scripts only): put a squad's soldiers at MAG | RESERVE rounds
            const Squad* s = a.size() < 3 ? nullptr : squadN(world, std::atoi(a[0].c_str()));
            if (!s) { bad("setammo N MAG RESERVE"); continue; }
            SoldierPool& P = *world.context().soldiers;
            for (const SoldierId& m : s->members)
                if (P.valid(m) && P.alive(m.index)) { P.mag[m.index] = std::atoi(a[1].c_str()); P.reserve[m.index] = std::atoi(a[2].c_str()); }
        } else if (L.verb == "where") {   // camera pivot, simulated window, a few valid drop points near the pivot
            const GameContext& ctx = world.context();
            if (!app || !ctx.nav || !ctx.nav->ready()) { bad("where: no app / navigation"); continue; }
            const V3 c = app->camera.target();
            std::printf("  where: pivot (%.1f %.1f) window (%.1f %.1f) .. (%.1f %.1f)\n", c.x, c.z, ctx.nav->originX(), ctx.nav->originZ(),
                        ctx.nav->originX() + ctx.nav->width() * ctx.nav->cell(), ctx.nav->originZ() + ctx.nav->height() * ctx.nav->cell());
            const bool roof = !a.empty() && a[0] == "roof";
            int shown = 0;
            for (int r = 0; r <= 90 && shown < 12; r += 6)
                for (int k = 0; k < 8 && shown < 12; ++k) {
                    const float ang = k * 0.785398f;
                    V3 p{c.x + std::cos(ang) * r, 0, c.z + std::sin(ang) * r};
                    if (!a.empty() && a[0] == "container") {
                        for (float yaw : {0.f, 1.5708f})
                            if (world.logistics().canPlaceContainer(ctx, p, yaw)) { std::printf("    container ok at %.1f %.1f yaw %.2f\n", p.x, p.z, yaw); ++shown; break; }
                        continue;
                    }
                    DropPlan pl = world.deploy().plan(ctx, roof ? SquadType::Sniper : SquadType::Rifle, p);
                    if (pl.valid && pl.rooftop == roof) { std::printf("    drop ok at %.1f %.1f (surface %.2f%s)\n", p.x, p.z, pl.landing[0].y, pl.rooftop ? ", rooftop" : ""); ++shown; }
                }
        } else if (L.verb == "probe") {
            const GameContext& ctx = world.context();
            V3 p{f(a, 0), 0, f(a, 1)};
            for (int t = 0; t < 3; ++t) {
                DropPlan pl = world.deploy().plan(ctx, (SquadType)t, p);
                std::printf("  probe %.1f %.1f %s: %s %s (surface %.2f, walkable %d, island %u)\n", p.x, p.z, t == 0 ? "rifle" : t == 1 ? "mg" : "sniper",
                            pl.valid ? "valid" : "refused", pl.valid ? (pl.rooftop ? "rooftop" : "street") : pl.reason, ctx.nav->surface(p.x, p.z),
                            (int)ctx.nav->walkable(p.x, p.z), ctx.nav->island(p.x, p.z));
            }
            const char* why = "";
            const bool cOk = world.logistics().canPlaceContainer(ctx, p, f(a, 2), &why);
            std::printf("  probe container: %s %s\n", cOk ? "valid" : "refused", why);
            const bool aOk = world.logistics().canAirdrop(ctx, p, &why);
            std::printf("  probe airdrop: %s %s\n", aOk ? "valid" : "refused", why);
        } else if (L.verb == "expect") {
            expect(world, L);
        } else bad(("unknown verb " + L.verb).c_str());
    }
    return !ended_;
}

} // namespace ttz::game
