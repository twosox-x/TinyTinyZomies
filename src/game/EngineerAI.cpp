// Engineers: construction radius, job queue (derived from Walls + car orders), assignment, work. See EngineerAI.h.
#include "game/EngineerAI.h"

#include "game/Config.h"
#include "game/Economy.h"
#include "game/HordeInterface.h"
#include "game/GameEvents.h"
#include "game/NavGrid.h"
#include "game/SoldierAI.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace ttz::game {

namespace {
bool busyState(SoldierState s) {
    return s == SoldierState::Descending || s == SoldierState::Landing || s == SoldierState::Recovering || s == SoldierState::Dying || s == SoldierState::Dead;
}
float dist2(V3 a, V3 b) { return std::hypot(a.x - b.x, a.z - b.z); }
// nearest zombie (coarse horde field samples) within r of p
bool nearestZombie(const GameContext& ctx, V3 p, float r, V3& out) {
    if (!ctx.horde) return false;
    const ZombieField& f = ctx.horde->field();
    if (!f.tilesX || f.tileSize <= 0.f) return false;
    const int i0 = std::max(0, (int)std::floor((p.x - r - f.originX) / f.tileSize)), i1 = std::min((int)f.tilesX - 1, (int)std::floor((p.x + r - f.originX) / f.tileSize));
    const int j0 = std::max(0, (int)std::floor((p.z - r - f.originZ) / f.tileSize)), j1 = std::min((int)f.tilesZ - 1, (int)std::floor((p.z + r - f.originZ) / f.tileSize));
    float best = r;
    bool found = false;
    for (int j = j0; j <= j1; ++j)
        for (int i = i0; i <= i1; ++i) {
            const ZombieFieldTile& t = f.tiles[(size_t)j * f.tilesX + (size_t)i];
            for (uint32_t k = 0; k < t.samples; ++k) {
                const float d = dist2(p, t.pos[k]);
                if (d <= best) { best = d; out = t.pos[k]; found = true; }
            }
        }
    return found;
}
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

bool EngineerAI::roofReachable(const GameContext& ctx, float x, float z, const Squad& s) const {
    if (!ctx.nav || !ctx.nav->ready() || !ctx.soldiers) return true;
    const NavGrid& nav = *ctx.nav;
    const uint32_t isl = nav.island(x, z);
    if (!isl || !nav.roofIsland(isl)) return true;   // not a roof
    const SoldierPool& P = *ctx.soldiers;
    const V3 p{x, nav.surface(x, z), z};
    for (const SoldierId& m : s.members) {
        if (!P.valid(m) || !P.alive(m.index)) continue;
        const uint32_t mi = nav.island(P.pos[m.index].x, P.pos[m.index].z);
        if (mi == isl || SoldierAI::roofAccess(ctx, p, mi)) return true;
    }
    return false;
}

bool EngineerAI::inRange(const GameContext& ctx, float x, float z) const {
    return !*rangeWhy(ctx, x, z);
}

const char* EngineerAI::rangeWhy(const GameContext& ctx, float x, float z) const {
    if (instantBuild) return "";
    std::vector<Zone> zs;
    zones(ctx, zs);
    if (zs.empty()) return "no engineers";
    bool near = false;
    for (const Zone& q : zs) {
        if (std::hypot(x - q.c.x, z - q.c.z) > q.r) continue;
        near = true;
        const Squad* s = ctx.squads ? ctx.squads->get(q.squad) : nullptr;
        if (!s || roofReachable(ctx, x, z, *s)) return "";
    }
    return near ? "no access to this roof" : "outside engineer range";
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

void EngineerAI::updateFuture(const GameContext& ctx) {
    future_.age += ctx.dt;
    if (!ctx.walls || !ctx.nav || !ctx.nav->ready()) { future_.w = future_.h = 0; return; }
    const Walls& W = *ctx.walls;
    uint64_t sig = 1469598103934665603ull;
    float x0 = 1e30f, z0 = 1e30f, x1 = -1e30f, z1 = -1e30f;
    int pending = 0;
    for (uint32_t i = 0; i < W.pieces().size(); ++i) {
        const WallPiece& p = W.pieces()[i];
        if (!p.alive) continue;
        sig = (sig ^ (i * 2654435761u + (p.gate ? 7u : 0u) + (p.solid() ? 13u : 0u) + p.gen)) * 1099511628211ull;
        pending += p.solid() ? 0 : 1;
        const Obb b = W.pieceBox(i);
        x0 = std::min(x0, b.cx - b.hx - 1.f); z0 = std::min(z0, b.cz - b.hx - 1.f); x1 = std::max(x1, b.cx + b.hx + 1.f); z1 = std::max(z1, b.cz + b.hx + 1.f);
    }
    // the raster depends on the plan and on what soldiers can walk (cars cleared, walls finished): on change or every 2 s
    if (sig == future_.sig && future_.age < 2.f) return;
    future_.sig = sig; future_.age = 0.f;
    if (!pending || x0 > x1) { future_.w = future_.h = 0; return; }
    constexpr float kCell = 1.f, kMargin = 8.f;
    future_.ox = std::floor(x0 - kMargin); future_.oz = std::floor(z0 - kMargin);
    future_.w = std::min(320, (int)std::ceil(x1 + kMargin - future_.ox));
    future_.h = std::min(320, (int)std::ceil(z1 + kMargin - future_.oz));
    const int w = future_.w, h = future_.h;
    std::vector<uint8_t> g((size_t)w * h, 0);   // 0 open, 2 blocked, 1 outside
    const NavGrid& nav = *ctx.nav;
    for (int j = 0; j < h; ++j)
        for (int i = 0; i < w; ++i) {
            const float x = future_.ox + (i + 0.5f) * kCell, z = future_.oz + (j + 0.5f) * kCell;
            if (!nav.walkable(x, z) && !nav.reserved(x, z)) g[(size_t)j * w + i] = 2;   // buildings, cars, finished walls
        }
    auto stampBox = [&](const Obb& b, uint8_t v) { forEachObbCell(b, future_.ox, future_.oz, kCell, w, h, [&](int cx, int cz) { g[(size_t)cz * w + cx] = v; }); };
    for (uint32_t i = 0; i < W.pieces().size(); ++i) if (W.pieces()[i].alive && !W.pieces()[i].gate) stampBox(W.pieceBox(i), 2);
    for (uint32_t i = 0; i < W.pieces().size(); ++i) if (W.pieces()[i].alive && W.pieces()[i].gate) {   // gates: soldiers pass
        Obb b = W.pieceBox(i); b.hx -= 0.8f; stampBox(b, 0);
    }
    std::vector<uint32_t> st;
    auto seed = [&](int i, int j) { const size_t c = (size_t)j * w + i; if (!g[c]) { g[c] = 1; st.push_back((uint32_t)c); } };
    for (int i = 0; i < w; ++i) { seed(i, 0); seed(i, h - 1); }
    for (int j = 0; j < h; ++j) { seed(0, j); seed(w - 1, j); }
    while (!st.empty()) {
        const uint32_t c = st.back(); st.pop_back();
        const int ci = (int)(c % w), cj = (int)(c / w);
        const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (auto& o : d) {
            const int x = ci + o[0], z = cj + o[1];
            if (x < 0 || z < 0 || x >= w || z >= h) continue;
            const size_t n = (size_t)z * w + x;
            if (!g[n]) { g[n] = 1; st.push_back((uint32_t)n); }
        }
    }
    future_.out.assign(g.size(), 0);
    for (size_t c = 0; c < g.size(); ++c) future_.out[c] = g[c] == 1 ? 1 : g[c] == 0 ? 2 : 0;   // 1 outside, 2 enclosed, 0 blocked
}

int EngineerAI::futureSide(const Obb& b) const {
    if (!future_.w) return 0;
    auto at = [&](float side) {   // majority over a few samples on that side
        int out = 0, in = 0;
        for (int k = -1; k <= 1; ++k)
            for (float d : {1.0f, 1.8f, 2.6f}) {
                float x, z;
                b.at(b.hx * 0.6f * (float)k, side * (b.hz + d), x, z);
                const int i = (int)std::floor(x - future_.ox), j = (int)std::floor(z - future_.oz);
                if (i < 0 || j < 0 || i >= future_.w || j >= future_.h) { ++out; continue; }
                const uint8_t v = future_.out[(size_t)j * future_.w + i];
                out += v == 1; in += v == 2;
            }
        return std::pair<int, int>{out, in};
    };
    const auto [po, pi] = at(1.f);
    const auto [no, ni] = at(-1.f);
    if (pi > po && no > ni) return -1;   // +Z side lies inside a perimeter the plan closes: work from -Z
    if (ni > no && po > pi) return 1;
    return 0;
}

bool EngineerAI::workSpot(const GameContext& ctx, const Obb& b, float side, int k, uint32_t island, V3& out) const {
    if (!ctx.nav || !ctx.nav->ready()) return false;
    const NavGrid& nav = *ctx.nav;
    const float spread = std::min(1.4f, b.hx * 0.6f);
    uint32_t roofIsl = 0;   // the job stands on a roof: the roof island under (a corner of) its footprint
    for (int c = 0; c < 5 && !roofIsl; ++c) {
        float x, z;
        b.at(c == 0 ? 0.f : (c & 1 ? 1.f : -1.f) * b.hx * 0.8f, c == 0 ? 0.f : (c & 2 ? 1.f : -1.f) * b.hz * 0.8f, x, z);
        const uint32_t is = nav.island(x, z);
        if (is && nav.roofIsland(is)) roofIsl = is;
    }
    if (roofIsl) island = 0;   // the engineer's own (street) island never applies
    const float alongs[5] = {(float)(k - 1) * spread, 0.f, -spread, spread, (float)(k - 1) * spread * 0.5f};
    auto offPieces = [&](float x, float z) {
        if (!ctx.walls) return true;
        const Walls& W = *ctx.walls;
        for (uint32_t i = 0; i < W.pieces().size(); ++i) {
            if (!W.pieces()[i].alive) continue;
            const Obb o = W.pieceBox(i);
            if (std::fabs(o.cx - x) > o.hx + 3.f || std::fabs(o.cz - z) > o.hx + 3.f) continue;
            if (o.contains(x, z, -0.55f)) return false;   // inside a piece / blueprint (+ body clearance)
        }
        for (uint32_t n = 0; n < W.nodes().size(); ++n)
            if (W.nodes()[n].alive && std::hypot(W.nodes()[n].x - x, W.nodes()[n].z - z) < 1.1f) return false;
        return true;
    };
    for (int pass = 0; pass < 2; ++pass)
        for (float d : {1.2f, 1.6f, 2.1f, 2.7f})
            for (float al : alongs) {
                V3 q;
                b.at(std::clamp(al, -b.hx, b.hx), side * (b.hz + d), q.x, q.z);
                if (!nav.walkable(q.x, q.z) || (island && nav.island(q.x, q.z) != island) || !offPieces(q.x, q.z)) continue;
                if (roofIsl && nav.island(q.x, q.z) != roofIsl) continue;   // WS D: a roof job is worked from that roof
                if (pass == 0 && nav.reserved(q.x, q.z)) continue;
                q.y = nav.surface(q.x, q.z);
                out = q;
                return true;
            }
    return false;
}

bool EngineerAI::wouldTrap(const GameContext& ctx, const Obb& b, std::vector<uint32_t>* who) const {
    if (!ctx.nav || !ctx.nav->ready() || !ctx.soldiers) return false;
    const NavGrid& nav = *ctx.nav;
    const SoldierPool& P = *ctx.soldiers;
    const float cs = nav.cell(), ox = nav.originX(), oz = nav.originZ();
    const int gw = nav.width(), gh = nav.height();
    Obb grown = b;
    grown.hx += 0.35f; grown.hz += 0.35f;
    auto blockedCell = [&](int i, int j) {
        const float x = ox + (i + 0.5f) * cs, z = oz + (j + 0.5f) * cs;
        return grown.contains(x, z) || !nav.walkable(x, z);
    };
    bool any = false;
    for (uint32_t s = 0; s < (uint32_t)P.capacity(); ++s) {
        if (!P.used[s] || !P.alive(s) || P.post[s] >= POST_FIRING || busyState(P.state[s])) continue;
        const V3 p = P.pos[s];
        if (std::hypot(p.x - b.cx, p.z - b.cz) > b.hx + 8.f) continue;
        bool trapped = grown.contains(p.x, p.z);   // standing in the footprint
        if (!trapped && nav.walkable(p.x, p.z)) {
            // flood the walk cells around him with the piece solid: escaping 14 m from it = not trapped
            std::vector<uint32_t> st;
            std::unordered_set<uint32_t> seen;
            int i0 = (int)std::floor((p.x - ox) / cs), j0 = (int)std::floor((p.z - oz) / cs);
            st.push_back((uint32_t)(j0 * gw + i0)); seen.insert(st.back());
            bool escaped = false;
            while (!st.empty() && !escaped && seen.size() < 6000) {
                const uint32_t c = st.back(); st.pop_back();
                const int ci = (int)(c % gw), cj = (int)(c / gw);
                const V3 cc{ox + (ci + 0.5f) * cs, 0.f, oz + (cj + 0.5f) * cs};
                if (std::hypot(cc.x - b.cx, cc.z - b.cz) > b.hx + 14.f) { escaped = true; break; }
                const int d[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
                for (auto& o : d) {
                    const int x = ci + o[0], z = cj + o[1];
                    if (x < 0 || z < 0 || x >= gw || z >= gh || blockedCell(x, z)) continue;
                    const uint32_t n = (uint32_t)(z * gw + x);
                    if (!seen.insert(n).second) continue;
                    const V3 nc{ox + (x + 0.5f) * cs, 0.f, oz + (z + 0.5f) * cs};
                    if (!nav.walkLine({cc.x, nav.surface(cc.x, cc.z), cc.z}, {nc.x, nav.surface(nc.x, nc.z), nc.z})) continue;
                    st.push_back(n);
                }
            }
            trapped = !escaped && seen.size() < 6000;
        }
        if (trapped) { any = true; if (who) who->push_back(s); }
    }
    return any;
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
    ext_.clear();   // 14e external jobs (Structures / FuelLogistics), after the walls
    if (externalJobs) externalJobs(ctx, ext_);
    for (uint32_t k = 0; k < ext_.size(); ++k) {
        Job j;
        j.kind = JobKind::External; j.index = k; j.box = ext_[k].box; j.progress = ext_[k].progress; j.time = std::max(0.5f, ext_[k].time);
        j.autonomous = ext_[k].repair; j.urgency = ext_[k].urgency;
        jobs_.push_back(j);
    }
    // owner round 15 (WS D): damaged solid wall / gate pieces are autonomous repair jobs (below repairBelow, then kept
    // until full); pieces under pressure / losing hp first. Repair time = the build time for the whole health bar.
    if (ctx.walls) {
        const Walls& W = *ctx.walls;
        repairing_.erase(std::remove_if(repairing_.begin(), repairing_.end(), [&](uint32_t p) {
                             return p >= W.pieces().size() || !W.pieces()[p].solid() || W.pieces()[p].hp >= W.pieces()[p].maxHp; }), repairing_.end());
        for (uint32_t i = 0; i < W.pieces().size(); ++i) {
            const WallPiece& p = W.pieces()[i];
            if (!p.solid() || p.toGate || p.maxHp <= 0.f) continue;
            const float frac = p.hp / p.maxHp;
            const bool cont = std::find(repairing_.begin(), repairing_.end(), i) != repairing_.end();
            if (frac >= 1.f || (frac >= repairBelow && !cont)) continue;
            Job j;
            j.kind = JobKind::Repair; j.index = i; j.box = W.pieceBox(i); j.progress = frac;
            const float len = 2.f * j.box.hx;
            j.time = p.gate ? std::max(0.5f, E.gateTime) : std::max(0.5f, E.pieceTime * std::clamp(len / 4.f, 0.3f, 1.2f));
            j.autonomous = true;
            j.urgency = (1.f - frac) + std::min(p.pressure, 10.f) * 0.2f + (p.damageRate > 0.f ? 1.f : 0.f);
            jobs_.push_back(j);
        }
    }
    if (instantBuild) {   // cheat: everything completes at once
        for (Job& j : jobs_) {
            if (j.kind == JobKind::Car) cars_[j.index].progress = 1.f;
            else if (j.kind == JobKind::Piece && ctx.walls) { if (ctx.walls->advance(j.index, 1.f)) ++piecesBuilt_; }
            else if (j.kind == JobKind::External) { if (externalWork) externalWork(ctx, ext_[j.index], 1.f, UINT32_MAX); }
            else if (j.kind == JobKind::Repair) continue;
            else if (ctx.walls) { ctx.walls->finishGate(j.index); ++gatesConverted_; }
        }
        return;
    }
    updateFuture(ctx);
    if (ctx.walls)   // flipped sides of pieces that are finished / gone are forgotten
        flip_.erase(std::remove_if(flip_.begin(), flip_.end(), [&](uint32_t p) { return p >= ctx.walls->pieces().size() || !ctx.walls->pieces()[p].alive || ctx.walls->pieces()[p].solid(); }), flip_.end());
    // squads -> jobs
    std::vector<Zone> zs;
    zones(ctx, zs);
    std::vector<int> taken(jobs_.size(), 0);
    for (Job& j : jobs_)
        for (const Zone& z : zs) j.inRange |= std::hypot(j.box.cx - z.c.x, j.box.cz - z.c.z) <= (j.autonomous ? autoLeash : z.r) + 1.f;
    if (status_.size() < ctx.squads->squads.size() + 64) { status_.resize(ctx.squads->squads.size() + 64); worker_.resize(status_.size(), -1); resealT_.resize(status_.size(), 0.f); }
    if (role_.size() < P.capacity()) role_.resize(P.capacity(), 0);
    std::fill(role_.begin(), role_.end(), 0);
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
        const uint32_t si = sq->id.index;
        if (si >= status_.size()) { status_.resize(si + 1); worker_.resize(si + 1, -1); resealT_.resize(si + 1, 0.f); }
        status_[si].clear();
        if (!ordered) {
            auto reach = [&](const Job& j) { return std::hypot(j.box.cx - zs[zi].c.x, j.box.cz - zs[zi].c.z) <= (j.autonomous ? autoLeash : zs[zi].r) + 1.f; };
            // player jobs first (queue order) ...
            for (size_t k = 0; k < jobs_.size() && pick < 0; ++k)
                if (!jobs_[k].autonomous && !jobs_[k].blocked && !taken[k] && reach(jobs_[k])) pick = (int)k;
            for (size_t k = 0; k < jobs_.size() && pick < 0; ++k)   // nothing free: help on a taken one
                if (!jobs_[k].autonomous && !jobs_[k].blocked && reach(jobs_[k])) pick = (int)k;
            // ... then autonomous jobs within autoLeash of the post, most urgent first (free before taken)
            // hysteresis: the squad keeps its current autonomous job unless another is clearly more urgent (+0.5)
            int keep = -1;
            if (si < autoJob_.size() && pick < 0)
                for (size_t k = 0; k < jobs_.size(); ++k)
                    if (jobs_[k].autonomous && !jobs_[k].blocked && (uint32_t)jobs_[k].kind == (autoJob_[si] >> 32) && jobs_[k].index == (uint32_t)autoJob_[si] && reach(jobs_[k])) keep = (int)k;
            for (int pass = 0; pass < 2 && pick < 0; ++pass) {
                float bu = -1e9f;
                if (keep >= 0) { pick = keep; bu = jobs_[(size_t)keep].urgency + 0.5f; }
                for (size_t k = 0; k < jobs_.size(); ++k)
                    if (jobs_[k].autonomous && !jobs_[k].blocked && (pass || !taken[k]) && reach(jobs_[k]) && jobs_[k].urgency > bu) { bu = jobs_[k].urgency; pick = (int)k; }
            }
            // nothing at all to do: re-seal a breach within autoLeash (a blueprint, price charged; next tick a job)
            resealT_[si] = std::max(0.f, resealT_[si] - ctx.dt);
            if (pick < 0 && ctx.walls && resealT_[si] <= 0.f) {
                Walls& W = *ctx.walls;
                for (size_t b = 0; b < W.breaches().size(); ++b) {
                    const Walls::Breach& br = W.breaches()[b];
                    if (std::hypot((br.ax + br.bx) * 0.5f - zs[zi].c.x, (br.az + br.bz) * 0.5f - zs[zi].c.z) > autoLeash) continue;
                    const int price = W.piecePrice(br.type, br.gate, std::hypot(br.bx - br.ax, br.bz - br.az));
                    if (ctx.economy && !ctx.economy->spend(price, "re-seal breach", ctx.time)) continue;
                    if (W.reseal(b) >= 0) { ++reseals_; status_[si] = "auto: re-sealing breach"; }
                    break;
                }
                resealT_[si] = 2.f;
            }
        }
        if (pick >= 0) { ++taken[(size_t)pick]; jobs_[(size_t)pick].squad = (int)si; }
        if (autoJob_.size() <= si) autoJob_.resize(si + 1, ~0ull);
        autoJob_[si] = pick >= 0 && jobs_[(size_t)pick].autonomous ? ((uint64_t)jobs_[(size_t)pick].kind << 32) | jobs_[(size_t)pick].index : ~0ull;
        const V3 centre = zs[zi].c;
        // owner #12 roles: zombies within coverRadius of the job -> one engineer keeps working, the others cover him
        std::vector<uint32_t> avail;
        for (const SoldierId& m : sq->members)
            if (P.valid(m) && P.alive(m.index) && !busyState(P.state[m.index]) && !(busy && busy(m.index))) avail.push_back(m.index);
        V3 threat{};
        const bool threatened = pick >= 0 && nearestZombie(ctx, {jobs_[(size_t)pick].box.cx, 0.f, jobs_[(size_t)pick].box.cz}, coverRadius, threat);
        int workerIdx = -1;
        if (pick >= 0 && threatened && !avail.empty()) {
            const Obb& jb = jobs_[(size_t)pick].box;
            if (std::find(avail.begin(), avail.end(), (uint32_t)worker_[si]) != avail.end()) workerIdx = worker_[si];
            else {
                float bd = 1e9f;
                for (uint32_t i : avail) { const float d = std::hypot(P.pos[i].x - jb.cx, P.pos[i].z - jb.cz); if (d < bd) { bd = d; workerIdx = (int)i; } }
            }
            role_[(size_t)workerIdx] = 1;
            for (uint32_t i : avail) if ((int)i != workerIdx) role_[i] = 2;
        }
        worker_[si] = workerIdx;
        if (pick >= 0 && status_[si].empty()) {
            const Job& j = jobs_[(size_t)pick];
            const char* what = j.kind == JobKind::Repair ? (ctx.walls && ctx.walls->pieces()[j.index].gate ? "auto: repairing gate" : "auto: repairing wall")
                             : j.kind == JobKind::External ? (ext_[j.index].repair ? "auto: repairing structure" : ext_[j.index].owner == 2 ? "siphoning fuel" : "building structure")
                             : j.kind == JobKind::Car ? "clearing car" : j.kind == JobKind::GateConvert ? "building gate" : "building wall";
            status_[si] = what;
            if (workerIdx >= 0 && avail.size() > 1) status_[si] += " (covered)";
        }
        int coverK = 0;
        int k = 0;
        for (const SoldierId& m : sq->members) {
            if (!P.valid(m) || !P.alive(m.index) || busyState(P.state[m.index]) || (busy && busy(m.index))) continue;
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
            if (role_[i] == 2 && workerIdx >= 0) {
                // cover: between the threat and the worker (his side, walkable, same island), spread sideways
                const V3 wp = assign_[(size_t)workerIdx].active ? assign_[(size_t)workerIdx].spot : P.pos[(size_t)workerIdx];
                V3 dir{threat.x - wp.x, 0.f, threat.z - wp.z};
                const float dl = std::max(0.01f, std::hypot(dir.x, dir.z));
                dir = dir * (1.f / dl);
                const float lat = (coverK & 1) ? -1.8f : 1.8f;
                V3 spot{wp.x + dir.x * 2.5f - dir.z * lat, wp.y, wp.z + dir.z * 2.5f + dir.x * lat};
                if (ctx.nav && ctx.nav->ready()) {
                    const uint32_t isl = ctx.nav->walkable(wp.x, wp.z) ? ctx.nav->island(wp.x, wp.z) : 0u;
                    V3 o;
                    if (!ctx.nav->walkable(spot.x, spot.z) || (isl && ctx.nav->island(spot.x, spot.z) != isl)) {
                        if (ctx.nav->nearestWalkable(spot, 3.f, o, isl)) spot = o; else spot = wp;
                    }
                    spot.y = ctx.nav->surface(spot.x, spot.z);
                }
                if (dist2(spot, centre) > autoLeash) spot = wp;   // never beyond the leash
                if (!a.active || a.job != pick || dist2(a.spot, spot) > 0.5f) { P.home[i] = spot; P.homeYaw[i] = std::atan2(dir.x, dir.z); }
                a.active = true; a.job = pick; a.spot = spot;
                ++coverK; ++k; ++coverTicks_;
                continue;
            }
            // Work side (GAME_DESIGN 14e): the outside of a perimeter the plan will close; else the side the squad
            // stands on (where they came from), else its post's side. Flipped when finishing would wall someone in.
            float zx, zz;   // local Z axis of the box
            b.at(0.f, 1.f, zx, zz);
            zx -= b.cx; zz -= b.cz;
            float side = (float)(j.kind == JobKind::Car ? 0 : futureSide(b));
            if (side == 0.f) {
                float votes = 0.f;
                for (const SoldierId& mm : sq->members)
                    if (P.valid(mm) && P.alive(mm.index)) votes += ((P.pos[mm.index].x - b.cx) * zx + (P.pos[mm.index].z - b.cz) * zz) >= 0.f ? 1.f : -1.f;
                side = votes != 0.f ? (votes > 0.f ? 1.f : -1.f) : ((centre.x - b.cx) * zx + (centre.z - b.cz) * zz >= 0.f ? 1.f : -1.f);
            }
            if (j.kind == JobKind::Piece && std::find(flip_.begin(), flip_.end(), j.index) != flip_.end()) side = -side;
            const float along = (float)(k - 1) * std::min(1.4f, b.hx * 0.6f);
            V3 spot;
            b.at(along, side * (b.hz + 1.3f), spot.x, spot.z);
            spot.y = P.pos[i].y;
            if (ctx.nav && ctx.nav->ready()) {
                // a spot the engineer can reach (same island as where he is, or the street), off every other piece,
                // blueprint and joint; the other side when this one has none
                const uint32_t isl = ctx.nav->walkable(P.pos[i].x, P.pos[i].z) ? ctx.nav->island(P.pos[i].x, P.pos[i].z) : 0u;
                V3 o;
                if (workSpot(ctx, b, side, k, isl, o) || workSpot(ctx, b, -side, k, isl, o) || workSpot(ctx, b, side, k, 0u, o)) spot = o;
                else if (!ctx.nav->walkable(spot.x, spot.z) && ctx.nav->nearestWalkable(spot, 3.f, o, isl)) spot = o;
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

bool EngineerAI::keepWorking(const GameContext& ctx, uint32_t i, V3 threat, float dist) const {
    if (!workFirst(i)) return false;
    if (dist > workerFight) return true;
    if (!ctx.walls || !ctx.soldiers) return false;
    const V3 p = ctx.soldiers->pos[i];
    const Walls& W = *ctx.walls;
    for (uint32_t k = 0; k < W.pieces().size(); ++k) {
        if (!W.pieces()[k].solid()) continue;
        const Obb b = W.pieceBox(k);
        if (std::fabs(b.cx - p.x) > b.hx + dist + 1.f || std::fabs(b.cz - p.z) > b.hx + dist + 1.f) continue;
        for (int s = 1; s < 12; ++s) {
            const float t = (float)s / 12.f;
            if (b.contains(p.x + (threat.x - p.x) * t, p.z + (threat.z - p.z) * t)) return true;   // a wall in between
        }
    }
    return false;
}

const char* EngineerAI::status(SquadId s) const {
    return s.index < status_.size() ? status_[s.index].c_str() : "";
}

float EngineerAI::gateProgress_(uint32_t piece) const {
    for (const GateWork& g : gateWork_) if (g.piece == piece) return g.progress;
    return 0.f;
}

bool EngineerAI::work(GameContext& ctx, uint32_t i) {
    if (i >= assign_.size() || !assign_[i].active || assign_[i].job < 0 || (size_t)assign_[i].job >= jobs_.size() || !ctx.cfg) return false;
    if (covering(i)) return false;   // owner #12: covers the worker (fights, SoldierAI)
    SoldierPool& P = *ctx.soldiers;
    const Assign& a = assign_[i];
    const float far = dist2(P.pos[i], a.spot);
    if (far > ctx.cfg->engineer.workRange) return false;   // still walking (the leash takes him there)
    if (std::fabs(P.pos[i].y - a.spot.y) > 1.5f) return false;   // WS D: below a roof job (on his way up the stairs)
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
    worked_[i] = j.kind == JobKind::Car ? 4 : j.kind == JobKind::GateConvert || j.kind == JobKind::Repair ? 3 : j.kind == JobKind::External ? std::max<uint8_t>(1, ext_[j.index].anim) : 1;   // 1 piece, 3 gate, 4 car (2: stepping)
    ++workingNow_;
    switch (j.kind) {
    case JobKind::External:   // 14e structures / siphoning (the owner module advances it)
        j.progress = externalWork && j.index < ext_.size() ? externalWork(ctx, ext_[j.index], add, i) : 1.f;
        if (j.index < ext_.size()) { ext_[j.index].progress = j.progress; if (ext_[j.index].repair && j.progress >= 1.f) { ++repairs_; ext_[j.index].repair = false; } }
        break;
    case JobKind::Repair:     // owner round 15: wall / gate hp back to full
        if (ctx.walls && j.index < ctx.walls->pieces().size()) {
            WallPiece& p = ctx.walls->pieces()[j.index];
            const float before = p.hp;
            p.hp = std::min(p.maxHp, p.hp + add * p.maxHp);
            repairedHp_ += p.hp - before;
            j.progress = p.hp / std::max(1e-3f, p.maxHp);
            if (std::find(repairing_.begin(), repairing_.end(), j.index) == repairing_.end()) repairing_.push_back(j.index);
            if (p.hp >= p.maxHp && before < p.maxHp) ++repairs_;
        } else j.progress = 1.f;
        break;
    case JobKind::Car:
        if (j.index < cars_.size()) cars_[j.index].progress = std::min(1.f, cars_[j.index].progress + add);
        j.progress = j.index < cars_.size() ? cars_[j.index].progress : 1.f;
        break;
    case JobKind::Piece:
        if (ctx.walls && ctx.walls->pieces()[j.index].build + add >= 1.f) {
            // never wall anyone in (GAME_DESIGN 14e): finishing waits at 98 % while it would seal a soldier into a
            // pocket or someone stands in the footprint; engineers caught on the wrong side work from the other side
            std::vector<uint32_t> who;
            if (wouldTrap(ctx, j.box, &who)) {
                j.trap = true;
                bool mine = false;
                for (uint32_t s : who) mine |= s < assign_.size() && assign_[s].active && assign_[s].job >= 0 && (size_t)assign_[s].job < jobs_.size() && jobs_[(size_t)assign_[s].job].index == j.index;
                if (mine && std::find(flip_.begin(), flip_.end(), j.index) == flip_.end()) flip_.push_back(j.index);
                const float cur = ctx.walls->pieces()[j.index].build;
                ctx.walls->advance(j.index, std::max(0.f, 0.98f - cur));
                j.progress = ctx.walls->pieces()[j.index].build;
                break;
            }
        }
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
