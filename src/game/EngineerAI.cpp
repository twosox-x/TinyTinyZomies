// Engineers: construction radius, job queue (derived from Walls + car orders), assignment, work. See EngineerAI.h.
#include "game/EngineerAI.h"

#include "game/Config.h"
#include "game/GameEvents.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
bool busyState(SoldierState s) {
    return s == SoldierState::Descending || s == SoldierState::Landing || s == SoldierState::Recovering || s == SoldierState::Dying || s == SoldierState::Dead;
}
float dist2(V3 a, V3 b) { return std::hypot(a.x - b.x, a.z - b.z); }
} // namespace

V3 EngineerAI::squadCentre(const GameContext& ctx, const Squad& s, int* alive) const {
    const SoldierPool& P = *ctx.soldiers;
    V3 c{};
    int n = 0;
    for (const SoldierId& m : s.members)
        if (P.valid(m) && P.alive(m.index)) { c = c + P.pos[m.index]; ++n; }
    if (alive) *alive = n;
    if (s.hasAnchor) return s.anchor;
    return n ? c * (1.f / (float)n) : c;
}

void EngineerAI::zones(const GameContext& ctx, std::vector<Zone>& out) const {
    out.clear();
    if (!ctx.squads || !ctx.soldiers || !ctx.cfg) return;
    for (const Squad& s : ctx.squads->squads) {
        if (s.type != SquadType::Engineer) continue;
        int alive = 0;
        const V3 c = squadCentre(ctx, s, &alive);
        if (alive > 0) out.push_back({c, ctx.cfg->engineer.radius, s.id});
    }
}

bool EngineerAI::anyEngineers(const GameContext& ctx) const {
    std::vector<Zone> z;
    zones(ctx, z);
    return !z.empty();
}

bool EngineerAI::inRange(const GameContext& ctx, float x, float z) const {
    if (instantBuild) return true;
    std::vector<Zone> zs;
    zones(ctx, zs);
    for (const Zone& q : zs)
        if (std::hypot(x - q.c.x, z - q.c.z) <= q.r) return true;
    return false;
}

bool EngineerAI::carOrdered(uint32_t vehicle) const {
    for (const CarOrder& c : cars_) if (c.vehicle == vehicle) return true;
    return false;
}

bool EngineerAI::orderCar(const GameContext& ctx, uint32_t vehicle, const Obb& box, const char** why) {
    if (carOrdered(vehicle)) { if (why) *why = "already being cleared"; return false; }
    if (!inRange(ctx, box.cx, box.cz)) { if (why) *why = "outside engineer range"; return false; }
    CarOrder c;
    c.vehicle = vehicle;
    c.box = box;
    if (instantBuild) {
        c.progress = 1.f;
    }
    cars_.push_back(c);
    return true;
}

std::vector<Obb> EngineerAI::clearingBoxes() const {
    std::vector<Obb> out;
    for (const CarOrder& c : cars_) if (!c.done) out.push_back(c.box);
    return out;
}

void EngineerAI::tick(GameContext& ctx) {
    workingNow_ = 0;
    if (!ctx.soldiers || !ctx.squads || !ctx.cfg) return;
    SoldierPool& P = *ctx.soldiers;
    const EngineerConfig& E = ctx.cfg->engineer;
    if (assign_.size() < P.capacity()) { assign_.resize(P.capacity()); worked_.resize(P.capacity(), 0); }
    std::fill(worked_.begin(), worked_.end(), 0);
    // finished car orders: the vehicle leaves the city (instance, collision / obstacle cells; persistent)
    for (CarOrder& c : cars_) {
        if (c.done || c.progress < 1.f) continue;
        c.done = true;
        ++carsCleared_;
        if (removeVehicle) removeVehicle(c.vehicle);
        if (ctx.events) {
            ctx.events->fx.push_back({FxKind::Landing, SoldierId{}, {c.box.cx, 0.f, c.box.cz}, {0, 1, 0}});
            ctx.events->noise.push_back({{c.box.cx, 0.f, c.box.cz}, 0.4f, 25.f, 2.f});
        }
    }
    cars_.erase(std::remove_if(cars_.begin(), cars_.end(), [](const CarOrder& c) { return c.done; }), cars_.end());
    // the job list (rebuilt from the world every tick: never out of sync with walls / orders)
    jobs_.clear();
    for (uint32_t k = 0; k < cars_.size(); ++k) {
        Job j;
        j.kind = JobKind::Car; j.index = k; j.box = cars_[k].box; j.progress = cars_[k].progress; j.time = std::max(0.5f, E.carTime);
        jobs_.push_back(j);
    }
    std::vector<std::pair<uint32_t, uint32_t>> order;   // (batch, piece)
    if (ctx.walls)
        for (uint32_t i = 0; i < ctx.walls->pieces().size(); ++i) {
            const WallPiece& p = ctx.walls->pieces()[i];
            if (p.alive && (!p.solid() || p.toGate)) order.push_back({p.batch, i});
        }
    std::sort(order.begin(), order.end());
    for (const auto& [batch, i] : order) {
        const WallPiece& p = ctx.walls->pieces()[i];
        Job j;
        j.kind = p.toGate ? JobKind::GateConvert : JobKind::Piece;
        j.index = i;
        j.box = ctx.walls->pieceBox(i);
        j.progress = p.toGate ? 0.f : p.build;
        const float len = 2.f * j.box.hx;
        j.time = p.gate || p.toGate ? std::max(0.5f, E.gateTime) : std::max(0.5f, E.pieceTime * std::clamp(len / 4.f, 0.3f, 1.2f));
        for (const CarOrder& c : cars_)
            for (int s = -2; s <= 2 && !j.blocked; ++s) { float x, z; j.box.at(j.box.hx * 0.45f * (float)s, 0.f, x, z); j.blocked = c.box.contains(x, z, -0.5f); }
        jobs_.push_back(j);
    }
    for (Job& j : jobs_) if (j.kind == JobKind::GateConvert) j.progress = gateProgress_(j.index);
    if (instantBuild) {   // cheat: everything completes at once
        for (Job& j : jobs_) {
            if (j.kind == JobKind::Car) cars_[j.index].progress = 1.f;
            else if (j.kind == JobKind::Piece && ctx.walls) { if (ctx.walls->advance(j.index, 1.f)) ++piecesBuilt_; }
            else if (ctx.walls) { ctx.walls->finishGate(j.index); ++gatesConverted_; }
        }
        return;
    }
    // squads -> jobs
    std::vector<Zone> zs;
    zones(ctx, zs);
    std::vector<int> taken(jobs_.size(), 0);
    for (Job& j : jobs_)
        for (const Zone& z : zs) j.inRange |= std::hypot(j.box.cx - z.c.x, j.box.cz - z.c.z) <= z.r + 1.f;
    for (size_t zi = 0; zi < zs.size(); ++zi) {
        Squad* sq = ctx.squads->get(zs[zi].squad);
        if (!sq) continue;
        // a player order takes the squad over (its jobs are dropped); it picks up jobs again once it arrived
        if (squadSerial_.size() <= sq->id.index) squadSerial_.resize(sq->id.index + 1, 0u);
        if (squadSerial_[sq->id.index] != sq->seenSerial) {
            squadSerial_[sq->id.index] = sq->seenSerial;
            for (const SoldierId& m : sq->members) if (P.valid(m)) assign_[m.index] = Assign{};
        }
        bool ordered = false;
        for (const SoldierId& m : sq->members)
            ordered |= P.valid(m) && P.alive(m.index) && P.state[m.index] == SoldierState::Moving && !(P.phase[m.index] & PH_RETURNING);
        int pick = -1;
        if (!ordered) {
            for (size_t k = 0; k < jobs_.size() && pick < 0; ++k)
                if (!jobs_[k].blocked && !taken[k] && std::hypot(jobs_[k].box.cx - zs[zi].c.x, jobs_[k].box.cz - zs[zi].c.z) <= zs[zi].r + 1.f) pick = (int)k;
            for (size_t k = 0; k < jobs_.size() && pick < 0; ++k)   // nothing free: help on a taken one
                if (!jobs_[k].blocked && std::hypot(jobs_[k].box.cx - zs[zi].c.x, jobs_[k].box.cz - zs[zi].c.z) <= zs[zi].r + 1.f) pick = (int)k;
        }
        if (pick >= 0) { ++taken[(size_t)pick]; jobs_[(size_t)pick].squad = (int)sq->id.index; }
        const V3 centre = zs[zi].c;
        int k = 0;
        for (const SoldierId& m : sq->members) {
            if (!P.valid(m) || !P.alive(m.index) || busyState(P.state[m.index])) continue;
            const uint32_t i = m.index;
            Assign& a = assign_[i];
            if (pick < 0) {
                if (a.active) {   // done: back to the formation slot at the squad's post
                    a = Assign{};
                    if (ai && sq->hasAnchor) { P.home[i] = ai->formationSlot(ctx, sq->id, P.slotInSquad[i], sq->anchor, sq->anchorFacing); P.homeYaw[i] = sq->anchorFacing; }
                }
                ++k;
                continue;
            }
            const Job& j = jobs_[(size_t)pick];
            const Obb& b = j.box;
            float zx, zz;   // local Z axis of the box: the side facing the squad's post
            b.at(0.f, 1.f, zx, zz);
            zx -= b.cx; zz -= b.cz;
            const float side = (centre.x - b.cx) * zx + (centre.z - b.cz) * zz >= 0.f ? 1.f : -1.f;
            const float along = (float)(k - 1) * std::min(1.4f, b.hx * 0.6f);
            V3 spot;
            b.at(along, side * (b.hz + 1.3f), spot.x, spot.z);
            spot.y = P.pos[i].y;
            if (ctx.nav && ctx.nav->ready()) {
                V3 o;
                if (!ctx.nav->walkable(spot.x, spot.z) && ctx.nav->nearestWalkable(spot, 3.f, o, ctx.nav->island(P.pos[i].x, P.pos[i].z))) spot = o;
                spot.y = ctx.nav->surface(spot.x, spot.z);
            }
            if (!a.active || a.job != pick || dist2(a.spot, spot) > 0.3f) {
                P.home[i] = spot;
                P.homeYaw[i] = std::atan2(b.cx - spot.x, b.cz - spot.z);
            }
            a.active = true;
            a.job = pick;
            a.spot = spot;
            ++k;
        }
    }
}

float EngineerAI::gateProgress_(uint32_t piece) const {
    for (const GateWork& g : gateWork_) if (g.piece == piece) return g.progress;
    return 0.f;
}

bool EngineerAI::work(GameContext& ctx, uint32_t i) {
    if (i >= assign_.size() || !assign_[i].active || assign_[i].job < 0 || (size_t)assign_[i].job >= jobs_.size() || !ctx.cfg) return false;
    SoldierPool& P = *ctx.soldiers;
    const Assign& a = assign_[i];
    const float far = dist2(P.pos[i], a.spot);
    if (far > ctx.cfg->engineer.workRange) return false;   // still walking (the leash takes him there)
    Job& j = jobs_[(size_t)a.job];
    if (j.progress >= 1.f) return false;
    if (far > 0.6f) {   // the last metres onto the spot (inside the leash): never work standing on the footprint
        const float v = std::min(ctx.cfg->soldier[(size_t)P.cls[i]].walkSpeed, far * 3.f) * ctx.dt;
        V3 n{P.pos[i].x + (a.spot.x - P.pos[i].x) * v / far, P.pos[i].y, P.pos[i].z + (a.spot.z - P.pos[i].z) * v / far};
        if (!ctx.nav || !ctx.nav->ready() || ctx.nav->walkable(n.x, n.z)) {
            if (ctx.nav && ctx.nav->ready()) n.y = ctx.nav->surface(n.x, n.z);
            P.vel[i] = (n - P.pos[i]) * (1.f / ctx.dt);
            P.pos[i] = n;
            P.yaw[i] = std::atan2(a.spot.x - P.pos[i].x + 1e-4f, a.spot.z - P.pos[i].z);
            worked_[i] = 2;
            return true;
        }
    }
    // face the job, work
    const float want = std::atan2(j.box.cx - P.pos[i].x, j.box.cz - P.pos[i].z);
    float d = want - P.yaw[i];
    while (d > 3.14159265f) d -= 6.2831853f;
    while (d < -3.14159265f) d += 6.2831853f;
    P.yaw[i] += std::clamp(d, -4.f * ctx.dt, 4.f * ctx.dt);
    P.vel[i] = {};
    const float add = ctx.dt / std::max(0.1f, j.time);
    ++j.workers;
    worked_[i] = j.kind == JobKind::Car ? 4 : j.kind == JobKind::GateConvert ? 3 : 1;   // 1 piece, 3 gate, 4 car (2: stepping)
    ++workingNow_;
    switch (j.kind) {
    case JobKind::Car:
        if (j.index < cars_.size()) cars_[j.index].progress = std::min(1.f, cars_[j.index].progress + add);
        j.progress = j.index < cars_.size() ? cars_[j.index].progress : 1.f;
        break;
    case JobKind::Piece:
        if (ctx.walls && ctx.walls->advance(j.index, add)) ++piecesBuilt_;
        j.progress = ctx.walls ? ctx.walls->pieces()[j.index].build : 1.f;
        break;
    case JobKind::GateConvert: {
        GateWork* g = nullptr;
        for (GateWork& w : gateWork_) if (w.piece == j.index) g = &w;
        if (!g) { gateWork_.push_back({j.index, 0.f}); g = &gateWork_.back(); }
        g->progress = std::min(1.f, g->progress + add);
        j.progress = g->progress;
        if (g->progress >= 1.f && ctx.walls) {
            ctx.walls->finishGate(j.index);
            ++gatesConverted_;
            gateWork_.erase(std::remove_if(gateWork_.begin(), gateWork_.end(), [&](const GateWork& w) { return w.piece == j.index; }), gateWork_.end());
        }
        break;
    }
    }
    return true;
}

void EngineerAI::postAi(GameContext& ctx) {
    if (!ctx.soldiers) return;
    SoldierPool& P = *ctx.soldiers;
    for (uint32_t i = 0; i < worked_.size() && i < P.capacity(); ++i) {
        if (!worked_[i] || P.state[i] != SoldierState::Idle) continue;
        if (worked_[i] == 2) {   // stepping onto the spot
            const float v = std::hypot(P.vel[i].x, P.vel[i].z);
            if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::Walk, v);
            else { P.anim[i].requested = AnimAction::Walk; P.anim[i].requestedSpeed = v; }
            continue;
        }
        // approved engineer work loops (specialist_anims.json): wall pieces -> shovel / sandbag / sledgehammer by member,
        // gates -> sledgehammer, cars -> torch cutting / crowbar by member. Other classes fall back to idle.
        static const AnimAction kPiece[3] = {AnimAction::BuildShovel, AnimAction::BuildSandbag, AnimAction::BuildHammer};
        const AnimAction act = worked_[i] == 4 ? ((i & 1u) ? AnimAction::PryCar : AnimAction::CutCar)
                             : worked_[i] == 3 ? AnimAction::BuildHammer : kPiece[i % 3u];
        if (ctx.animator) ctx.animator->request(P.anim[i], act, 0.f);
        else { P.anim[i].requested = act; P.anim[i].requestedSpeed = 0.f; }
    }
    // gate conversions whose piece is gone (destroyed / undone) are forgotten
    if (ctx.walls)
        gateWork_.erase(std::remove_if(gateWork_.begin(), gateWork_.end(), [&](const GateWork& w) {
                            return w.piece >= ctx.walls->pieces().size() || !ctx.walls->pieces()[w.piece].alive || !ctx.walls->pieces()[w.piece].toGate;
                        }), gateWork_.end());
}

} // namespace ttz::game
