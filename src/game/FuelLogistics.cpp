// GAME_DESIGN 14e fuel from cars (siphon / disassemble), carried to the base fuel store. See FuelLogistics.h.
#include "game/FuelLogistics.h"

#include "game/Config.h"
#include "game/NavGrid.h"
#include "game/Soldiers.h"
#include "game/Structures.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
float d2D(V3 a, V3 b) { return std::hypot(a.x - b.x, a.z - b.z); }
} // namespace

bool FuelLogistics::siphonOrdered(uint32_t v) const {
    for (const Order& o : orders_) if (o.vehicle == v && !o.done) return true;
    return false;
}

float FuelLogistics::litresLeft(const GameContext& ctx, uint32_t v) const {
    if (!ctx.cfg) return 0.f;
    if (carCondition && carCondition(v) != 0) return 0.f;
    auto it = taken_.find(v);
    return std::max(0.f, ctx.cfg->structures.carFuel - (it == taken_.end() ? 0.f : it->second));
}

bool FuelLogistics::orderSiphon(const GameContext& ctx, const Structures& st, uint32_t v, const Obb& box, const char** why) {
    auto no = [&](const char* w) { if (why) *why = w; return false; };
    if (siphonOrdered(v)) return no("already being siphoned");
    if (ctx.engineers && ctx.engineers->carOrdered(v)) return no("being cleared");
    if (litresLeft(ctx, v) <= 0.f) return no("no fuel in it");
    if (st.storeFor({box.cx, 0.f, box.cz}) < 0) return no("no fuel store (build one first)");
    const bool instant = ctx.engineers && ctx.engineers->instantBuild;
    if (!instant && (!ctx.engineers || !ctx.engineers->inRange(ctx, box.cx, box.cz))) return no("outside engineer range");
    Order o;
    o.vehicle = v; o.box = box;
    orders_.push_back(o);
    ++stats_.ordered;
    return true;
}

void FuelLogistics::jobs(const GameContext& ctx, std::vector<EngineerAI::ExternalJob>& out) const {
    if (!ctx.cfg) return;
    for (uint32_t k = 0; k < orders_.size(); ++k) {
        const Order& o = orders_[k];
        if (o.done) continue;
        EngineerAI::ExternalJob j;
        j.owner = 2; j.id = k; j.box = o.box; j.progress = o.progress; j.time = ctx.cfg->structures.siphonTime; j.anim = 4;
        out.push_back(j);
    }
}

float FuelLogistics::work(GameContext& ctx, Structures& st, const EngineerAI::ExternalJob& j, float add, uint32_t engineer) {
    if (j.id >= orders_.size()) return 1.f;
    Order& o = orders_[j.id];
    if (o.done) return 1.f;
    if (engineer != UINT32_MAX && std::find(o.workers.begin(), o.workers.end(), engineer) == o.workers.end()) o.workers.push_back(engineer);
    o.progress = std::min(1.f, o.progress + add);
    if (o.progress < 1.f) return o.progress;
    // siphoned: the car is empty (no more fire / explosion), the fuel waits in jerrycans at the car
    o.done = true;
    const float l = litresLeft(ctx, o.vehicle);
    taken_[o.vehicle] = ctx.cfg ? ctx.cfg->structures.carFuel : 0.f;
    if (drain) drain(o.vehicle);
    ++stats_.siphoned;
    sources_.push_back({{o.box.cx, 0.f, o.box.cz}, l});
    std::vector<uint32_t> carriers = o.workers;
    if (carriers.empty() && ctx.squads && ctx.soldiers) {   // instant build (cheat): the nearest engineers carry it
        for (const Squad& s : ctx.squads->squads)
            if (s.type == SquadType::Engineer)
                for (const SoldierId& m : s.members) if (ctx.soldiers->valid(m) && ctx.soldiers->alive(m.index)) carriers.push_back(m.index);
    }
    startTrips(ctx, st, (int)sources_.size() - 1, carriers);
    char t[96];
    std::snprintf(t, sizeof(t), "Engineers siphoned %.0f l of fuel: carrying it to the base", l);
    notices_.push_back({t, false});
    return 1.f;
}

void FuelLogistics::carDisassembled(GameContext& ctx, Structures& st, uint32_t v, V3 at) {
    const float l = litresLeft(ctx, v);
    taken_[v] = ctx.cfg ? ctx.cfg->structures.carFuel : 0.f;
    ++stats_.disassembled;
    if (l <= 0.f) return;
    if (st.storeFor(at) < 0) { stats_.lost += l; notices_.push_back({"Car disassembled: no fuel store, its fuel is lost", true}); return; }
    sources_.push_back({at, l});
    std::vector<uint32_t> carriers;   // the engineers of the squad nearest the car
    if (ctx.squads && ctx.soldiers) {
        const Squad* best = nullptr;
        float bd = 1e9f;
        for (const Squad& s : ctx.squads->squads) {
            if (s.type != SquadType::Engineer) continue;
            for (const SoldierId& m : s.members)
                if (ctx.soldiers->valid(m) && ctx.soldiers->alive(m.index) && d2D(ctx.soldiers->pos[m.index], at) < bd) { bd = d2D(ctx.soldiers->pos[m.index], at); best = &s; }
        }
        if (best)
            for (const SoldierId& m : best->members) if (ctx.soldiers->valid(m) && ctx.soldiers->alive(m.index)) carriers.push_back(m.index);
    }
    startTrips(ctx, st, (int)sources_.size() - 1, carriers);
    char t[96];
    std::snprintf(t, sizeof(t), "Car disassembled: %.0f l of fuel for the base", l);
    notices_.push_back({t, false});
}

void FuelLogistics::walkTo(GameContext& ctx, uint32_t i, V3 goal) {
    SoldierPool& P = *ctx.soldiers;
    if (ctx.nav && ctx.nav->ready()) {
        V3 g;
        if (ctx.nav->nearestWalkable(goal, 3.f, g, ctx.nav->island(P.pos[i].x, P.pos[i].z))) goal = g;
        goal.y = ctx.nav->surface(goal.x, goal.z);
    }
    PathFollow& pf = P.path[i];
    if (pf.request && ctx.nav) ctx.nav->cancel(pf.request);
    pf = PathFollow{};
    P.goal[i] = goal;
    P.home[i] = goal;
    P.stuckTime[i] = 0; P.progressPos[i] = P.pos[i]; P.repaths[i] = 0;
    if (ctx.nav && ctx.nav->ready()) pf.request = ctx.nav->requestPath(P.pos[i], goal);
    else pf.points = {goal};
    P.target[i].active = false;
    P.setState(i, SoldierState::Moving);
}

void FuelLogistics::startTrips(GameContext& ctx, Structures& st, int source, const std::vector<uint32_t>& carriers) {
    if (!ctx.soldiers || !ctx.cfg || source < 0) return;
    SoldierPool& P = *ctx.soldiers;
    if (carry_.size() < P.capacity()) carry_.resize(P.capacity());
    Source& S = sources_[(size_t)source];
    for (uint32_t i : carriers) {
        if (S.litres <= 0.f) break;
        if (i >= P.capacity() || !P.used[i] || !P.alive(i) || carry_[i].phase != 0) continue;
        const int store = st.storeFor(P.pos[i]);
        if (store < 0) break;
        Carry& c = carry_[i];
        c.litres = std::min(S.litres, ctx.cfg->structures.jerrycanLitres);
        S.litres -= c.litres;
        c.source = source; c.store = store; c.phase = 1; c.t = 0.f;
        walkTo(ctx, i, st.deliveryPoint(store, ctx.cfg->structures));
    }
}

float FuelLogistics::inTransit() const {
    float l = 0.f;
    for (const Carry& c : carry_) l += c.litres;
    for (const Source& s : sources_) l += s.litres;
    return l;
}

void FuelLogistics::tick(GameContext& ctx, Structures& st) {
    if (!ctx.soldiers || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    const StructureConfig& S = ctx.cfg->structures;
    if (carry_.size() < P.capacity()) carry_.resize(P.capacity());
    for (uint32_t i = 0; i < carry_.size() && i < P.capacity(); ++i) {
        Carry& c = carry_[i];
        if (c.phase == 0) continue;
        if (!P.used[i] || !P.alive(i)) {   // killed on the way: the jerrycan is dropped (lost)
            stats_.lost += c.litres;
            c = Carry{};
            continue;
        }
        c.t += ctx.dt;
        const V3 goal = c.phase == 1 ? (st.all().size() > (size_t)c.store && st.all()[(size_t)c.store].solid() ? st.deliveryPoint(c.store, S) : P.pos[i])
                                     : sources_[(size_t)c.source].pos;
        if (c.phase == 1 && !(st.all().size() > (size_t)c.store && st.all()[(size_t)c.store].solid())) {   // store gone: another one
            c.store = st.storeFor(P.pos[i]);
            if (c.store < 0) { stats_.lost += c.litres; c = Carry{}; continue; }
            walkTo(ctx, i, st.deliveryPoint(c.store, S));
            continue;
        }
        const float d = d2D(P.pos[i], goal);
        const SoldierState s = P.state[i];
        const bool arrived = d < (c.phase == 1 ? S.deliverRange : 3.5f) && (s == SoldierState::Idle || s == SoldierState::Moving);
        if (!arrived) {
            if (s == SoldierState::Idle && P.stateTime[i] > 2.f) walkTo(ctx, i, goal);   // interrupted (threat): walk on
            continue;
        }
        if (c.phase == 1) {   // pour it into the store
            const Structure& store = st.all()[(size_t)c.store];
            const float room = std::max(0.f, S.fuelStoreCapacity - store.fuel);
            const float in = std::min(room, c.litres);
            st.addFuel(c.store, in);
            stats_.delivered += in;
            stats_.lost += c.litres - in;
            ++stats_.trips;
            c.litres = 0.f;
            Source& src = sources_[(size_t)c.source];
            if (src.litres > 0.f) { c.phase = 2; walkTo(ctx, i, src.pos); }   // more waiting at the car
            else {
                c = Carry{};
                if (P.state[i] == SoldierState::Moving) { if (P.path[i].request && ctx.nav) ctx.nav->cancel(P.path[i].request); P.path[i] = PathFollow{}; P.setState(i, SoldierState::Idle); }
            }
        } else {   // back at the car: take the next jerrycan
            Source& src = sources_[(size_t)c.source];
            if (src.litres <= 0.f) { c = Carry{}; continue; }
            c.litres = std::min(src.litres, S.jerrycanLitres);
            src.litres -= c.litres;
            c.phase = 1;
            c.store = st.storeFor(P.pos[i]);
            if (c.store < 0) { stats_.lost += c.litres; c = Carry{}; continue; }
            walkTo(ctx, i, st.deliveryPoint(c.store, S));
        }
    }
    // orders whose car vanished (cleared, burnt) are dropped
    for (Order& o : orders_)
        if (!o.done && carCondition && carCondition(o.vehicle) != 0) o.done = true;
}

} // namespace ttz::game
