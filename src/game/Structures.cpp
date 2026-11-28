// GAME_DESIGN 14e structures: towers, generators, floodlights, fuel stores. See Structures.h.
#include "game/Structures.h"

#include "game/Config.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
float d2D(V3 a, V3 b) { return std::hypot(a.x - b.x, a.z - b.z); }
constexpr uint32_t kProxyIndex = 0xFFFFu;   // HordeSoldier::packedId low half of a tower proxy (never a soldier slot)
constexpr int kProxies = 4;
} // namespace

const char* structureName(StructureKind k) {
    switch (k) {
    case StructureKind::Tower: return "Defense tower";
    case StructureKind::Generator: return "Generator";
    case StructureKind::Light: return "Floodlight";
    case StructureKind::FuelStore: return "Fuel store";
    default: return "Structure";
    }
}

bool structureKindFrom(const std::string& s, StructureKind& out) {
    if (s == "tower") out = StructureKind::Tower;
    else if (s == "generator") out = StructureKind::Generator;
    else if (s == "light") out = StructureKind::Light;
    else if (s == "fuel") out = StructureKind::FuelStore;
    else return false;
    return true;
}

Obb Structures::footprint(StructureKind k, V3 pos, float yaw, const StructureConfig& S) {
    Obb b;
    b.cx = pos.x; b.cz = pos.z; b.yaw = yaw;
    switch (k) {
    case StructureKind::Tower: b.hx = b.hz = S.towerHalf; b.top = S.towerObstacleTop; break;
    case StructureKind::Generator: b.hx = 1.0f; b.hz = 0.5f; b.top = 1.1f; break;   // the skid; the cable reel stands beside it
    case StructureKind::Light: b.hx = b.hz = 0.9f; b.top = 0.f; break;              // tripod (no obstacle)
    case StructureKind::FuelStore: b.hx = 1.2f; b.hz = 0.8f; b.top = 1.1f; break;
    default: break;
    }
    return b;
}

int Structures::price(const BalanceConfig& cfg, StructureKind k) const {
    const StructureConfig& S = cfg.structures;
    switch (k) {
    case StructureKind::Tower: return S.towerPrice;
    case StructureKind::Generator: return S.generatorPrice;
    case StructureKind::Light: return S.lightPrice;
    case StructureKind::FuelStore: return S.fuelStorePrice;
    default: return 0;
    }
}

bool Structures::canPlace(const GameContext& ctx, StructureKind k, V3 pos, float yaw, const char** why) const {
    auto no = [&](const char* w) { if (why) *why = w; return false; };
    if (!ctx.cfg) return no("no config");
    const StructureConfig& S = ctx.cfg->structures;
    const bool instant = ctx.engineers && ctx.engineers->instantBuild;
    if (!instant) {
        if (!ctx.engineers || !ctx.engineers->anyEngineers(ctx)) return no("needs engineers");
        if (!ctx.engineers->inRange(ctx, pos.x, pos.z)) return no("outside engineer range");
    }
    const Obb b = footprint(k, pos, yaw, S);
    if (k == StructureKind::Light) {   // within cable range of a generator (built or planned)
        bool gen = false;
        for (const Structure& s : list_) gen |= s.alive && s.kind == StructureKind::Generator && d2D(s.pos, pos) <= S.cableRange;
        if (!gen) return no("no generator within cable range");
    }
    for (const Structure& s : list_) {
        if (!s.alive) continue;
        const Obb o = footprint(s.kind, s.pos, s.yaw, S);
        if (d2D(s.pos, pos) < std::hypot(o.hx, o.hz) + std::hypot(b.hx, b.hz) - 0.3f) return no("overlaps a structure");
    }
    if (ctx.walls) {
        for (uint32_t i = 0; i < ctx.walls->pieces().size(); ++i) {
            if (!ctx.walls->pieces()[i].alive) continue;
            const Obb w = ctx.walls->pieceBox(i);
            for (int sx = -1; sx <= 1; ++sx)
                for (int sz = -1; sz <= 1; ++sz) {
                    float x, z;
                    b.at(b.hx * 0.9f * (float)sx, b.hz * 0.9f * (float)sz, x, z);
                    if (w.contains(x, z, -0.2f)) return no("on a wall");
                }
        }
    }
    if (ctx.nav && ctx.nav->ready()) {
        const uint32_t isl = ctx.nav->island(pos.x, pos.z);
        for (int sx = -1; sx <= 1; ++sx)
            for (int sz = -1; sz <= 1; ++sz) {
                float x, z;
                b.at(b.hx * 0.8f * (float)sx, b.hz * 0.8f * (float)sz, x, z);
                if (std::fabs(ctx.nav->surface(x, z) - pos.y) > 0.6f) return no("uneven ground (kerb, step or roof edge)");
            }
        if (!ctx.nav->walkable(pos.x, pos.z) || !isl) return no("not on open ground");
    }
    if (blockedAt && blockedAt(pos.x, pos.z, std::max(b.hx, b.hz))) return no("blocked (vehicle or building)");
    return true;
}

int Structures::place(GameContext& ctx, StructureKind k, V3 pos, float yaw) {
    Structure s;
    s.kind = k; s.pos = pos; s.yaw = yaw;
    s.health = maxHealth(ctx, k);
    list_.push_back(s);
    const int idx = (int)list_.size() - 1;
    ++stats_.placed[(size_t)k];
    if (ctx.engineers && ctx.engineers->instantBuild) { list_[(size_t)idx].build = 1.f; finish(ctx, idx); }
    return idx;
}

void Structures::finish(GameContext& ctx, int i) {
    Structure& s = list_[(size_t)i];
    ++stats_.built[(size_t)s.kind];
    if (addObstacle && (s.kind == StructureKind::Tower || s.kind == StructureKind::Generator || s.kind == StructureKind::FuelStore)) s.obstacle = addObstacle(s);
    if (s.kind == StructureKind::FuelStore && ctx.cfg) s.fuel = std::min(ctx.cfg->structures.fuelStoreStart, ctx.cfg->structures.fuelStoreCapacity);
    if (ctx.events) {
        ctx.events->fx.push_back({FxKind::Landing, SoldierId{}, s.pos, {0, 1, 0}});
    }
    {
        noise_.push_back({s.pos, 0.3f, 20.f, 2.f});
    }
    char t[80];
    std::snprintf(t, sizeof(t), "%s built", structureName(s.kind));
    notice(t, false, s.pos);
}

void Structures::jobs(const GameContext& ctx, std::vector<EngineerAI::ExternalJob>& out) const {
    if (!ctx.cfg) return;
    const StructureConfig& S = ctx.cfg->structures;
    for (uint32_t i = 0; i < list_.size(); ++i) {
        const Structure& s = list_[i];
        if (!s.alive || s.build >= 1.f) continue;
        EngineerAI::ExternalJob j;
        j.owner = 1; j.id = i;
        j.box = footprint(s.kind, s.pos, s.yaw, S);
        j.progress = s.build;
        j.time = s.kind == StructureKind::Tower ? S.towerTime : s.kind == StructureKind::Generator ? S.generatorTime : s.kind == StructureKind::Light ? S.lightTime : S.fuelStoreTime;
        j.anim = s.kind == StructureKind::Tower ? 3 : 1;   // tower: sledgehammer; others: the build loops
        out.push_back(j);
    }
    // owner round 15 (WS D): damaged solid structures are autonomous repair jobs (engineers near them, idle); towers
    // under attack first. Repair time = the build time for the whole health bar.
    for (uint32_t i = 0; i < list_.size(); ++i) {
        const Structure& s = list_[i];
        const float mx = maxHealth(ctx, s.kind);
        if (!s.solid() || s.health >= mx * 0.9f) continue;
        EngineerAI::ExternalJob j;
        j.owner = 1; j.id = i; j.repair = true;
        j.box = footprint(s.kind, s.pos, s.yaw, S);
        j.progress = std::clamp(s.health / mx, 0.f, 0.999f);
        j.time = s.kind == StructureKind::Tower ? S.towerTime : s.kind == StructureKind::Generator ? S.generatorTime : s.kind == StructureKind::Light ? S.lightTime : S.fuelStoreTime;
        j.anim = 3;
        j.urgency = (1.f - j.progress) + (s.attackers > 0 ? 1.5f : 0.f);
        out.push_back(j);
    }
}

float Structures::maxHealth(const GameContext& ctx, StructureKind k) {
    return ctx.cfg ? (k == StructureKind::Tower ? ctx.cfg->structures.towerHealth : 400.f) : 1.f;
}

float Structures::work(GameContext& ctx, const EngineerAI::ExternalJob& j, float add) {
    if (j.id >= list_.size()) return 1.f;
    Structure& s = list_[j.id];
    if (!s.alive) return 1.f;
    if (j.repair) {
        const float mx = maxHealth(ctx, s.kind);
        s.health = std::min(mx, s.health + add * mx);
        return s.health >= mx ? 1.f : s.health / mx;
    }
    if (s.build >= 1.f) return 1.f;
    s.build = std::min(1.f, s.build + add);
    if (s.build >= 1.f) finish(ctx, (int)j.id);
    return s.build;
}

// ---------------------------------------------------------------------------------------------------------------------
// towers
int Structures::nearest(StructureKind k, float x, float z, float r, bool solidOnly) const {
    int best = -1;
    float bd = r;
    for (size_t i = 0; i < list_.size(); ++i) {
        const Structure& s = list_[i];
        if (!s.alive || s.kind != k || (solidOnly && !s.solid())) continue;
        const float d = std::hypot(s.pos.x - x, s.pos.z - z);
        if (d <= bd) { bd = d; best = (int)i; }
    }
    return best;
}

V3 Structures::postPos(int t, int slot, const StructureConfig& S) const {
    const Structure& s = list_[(size_t)t];
    const float u = (slot & 1) ? 0.55f : -0.55f, v = slot < 2 ? 0.55f : -0.35f;   // two front posts, two rear (capacity > 2)
    Obb b = footprint(s.kind, s.pos, s.yaw, S);
    V3 p;
    b.at(u, v, p.x, p.z);
    p.y = s.pos.y + S.deckHeight;
    return p;
}

V3 Structures::ladderFoot(int t, const StructureConfig& S) const {
    const Structure& s = list_[(size_t)t];
    Obb b = footprint(s.kind, s.pos, s.yaw, S);
    V3 p;
    b.at(0.f, -(S.towerHalf + 0.9f), p.x, p.z);   // ladder on the rear (-Z) face
    p.y = s.pos.y;
    return p;
}

int Structures::occupants(int t) const {
    if (t < 0 || (size_t)t >= list_.size()) return 0;
    int n = 0;
    for (const SoldierId& o : list_[(size_t)t].occ) n += o.valid() ? 1 : 0;
    return n;
}

void Structures::walkTo(GameContext& ctx, uint32_t i, V3 goal) {
    SoldierPool& P = *ctx.soldiers;
    if (ctx.nav && ctx.nav->ready()) {
        V3 g;
        if (ctx.nav->nearestWalkable(goal, 2.5f, g, ctx.nav->island(P.pos[i].x, P.pos[i].z))) goal = g;
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

bool Structures::occupy(GameContext& ctx, SquadId squad, int t, std::string& msg) {
    if (!ctx.soldiers || !ctx.squads || !ctx.cfg) { msg = "not ready"; return false; }
    if (t < 0 || (size_t)t >= list_.size() || list_[(size_t)t].kind != StructureKind::Tower) { msg = "no defense tower there"; return false; }
    Structure& T = list_[(size_t)t];
    if (!T.solid()) { msg = "the tower is not built yet"; return false; }
    Squad* sq = ctx.squads->get(squad);
    if (!sq) { msg = "no squad"; return false; }
    if (sq->type == SquadType::Engineer || sq->type == SquadType::Flamethrower) { msg = "only snipers and riflemen man towers (PROPOSED)"; return false; }
    SoldierPool& P = *ctx.soldiers;
    const StructureConfig& S = ctx.cfg->structures;
    const int cap = std::clamp(S.towerCapacity, 1, 4);
    if (tower_.size() < P.capacity()) { tower_.resize(P.capacity(), -1); slot_.resize(P.capacity(), -1); phase_.resize(P.capacity(), 0); t_.resize(P.capacity(), 0.f); serial_.resize(P.capacity(), 0u); from_.resize(P.capacity()); }
    // snipers first, then the others in squad order
    std::vector<uint32_t> cand;
    for (int pass = 0; pass < 2; ++pass)
        for (const SoldierId& m : sq->members) {
            if (!P.valid(m) || !P.alive(m.index) || P.post[m.index] != POST_NONE || (tower_[m.index] >= 0)) continue;
            if ((P.cls[m.index] == SoldierClass::Sniper) == (pass == 0)) cand.push_back(m.index);
        }
    int sent = 0;
    for (uint32_t i : cand) {
        int slot = -1;
        for (int k = 0; k < cap && slot < 0; ++k) if (!T.occ[(size_t)k].valid()) slot = k;
        if (slot < 0) break;
        T.occ[(size_t)slot] = P.idOf(i);
        tower_[i] = t; slot_[i] = slot; phase_[i] = 1; t_[i] = 0.f; serial_[i] = sq->order.serial;
        P.building[i] = kStructurePost | (uint32_t)t;
        walkTo(ctx, i, ladderFoot(t, S));
        ++sent;
    }
    if (!sent) { msg = occupants(t) >= cap ? "the tower is full" : "no free soldier in the squad"; return false; }
    char b[96];
    std::snprintf(b, sizeof(b), "%d soldier%s climbing the tower", sent, sent == 1 ? "" : "s");
    msg = b;
    return true;
}

void Structures::release(GameContext& ctx, uint32_t i) {
    if (!ctx.soldiers || i >= tower_.size() || tower_[i] < 0) return;
    SoldierPool& P = *ctx.soldiers;
    const int t = tower_[i];
    if ((size_t)t < list_.size()) {
        Structure& T = list_[(size_t)t];
        for (SoldierId& o : T.occ) if (o == P.idOf(i)) o = {};
        if (phase_[i] >= 2 && ctx.cfg) {   // down the ladder (instant, PROPOSED), standing at its foot
            V3 g = ladderFoot(t, ctx.cfg->structures);
            if (ctx.nav && ctx.nav->ready()) { V3 o; if (ctx.nav->nearestWalkable(g, 3.f, o)) g = o; g.y = ctx.nav->surface(g.x, g.z); }
            P.pos[i] = g; P.vel[i] = {};
            if (P.state[i] != SoldierState::Moving) P.home[i] = g;
        }
    }
    if (P.post[i] == POST_FIRING || P.post[i] == POST_ENTERING) P.post[i] = POST_NONE;
    P.building[i] = ~0u;
    tower_[i] = -1; slot_[i] = -1; phase_[i] = 0;
    ++stats_.released;
}

void Structures::preAi(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.squads) return;
    SoldierPool& P = *ctx.soldiers;
    for (uint32_t i = 0; i < tower_.size() && i < P.capacity(); ++i) {
        if (tower_[i] < 0) continue;
        if (!P.used[i] || !P.alive(i)) { // dead on the deck: the body stays; the post is free again
            const int t = tower_[i];
            if ((size_t)t < list_.size()) for (SoldierId& o : list_[(size_t)t].occ) if (o.index == i) o = {};
            tower_[i] = -1; phase_[i] = 0;
            continue;
        }
        const Squad* sq = ctx.squads->get(P.squad[i]);
        if (sq && sq->order.serial != serial_[i]) release(ctx, i);   // a new player order: down the ladder
    }
}

void Structures::damage(int s, float hp) {
    if (s < 0 || (size_t)s >= list_.size() || !list_[(size_t)s].alive) return;
    list_[(size_t)s].health -= hp;
}

void Structures::collapse(GameContext& ctx, int t) {
    Structure& T = list_[(size_t)t];
    T.alive = false;
    ++stats_.towersDestroyed;
    if (T.obstacle != ~0u && removeObstacle) removeObstacle(T.obstacle);
    T.obstacle = ~0u;
    if (ctx.soldiers) {
        SoldierPool& P = *ctx.soldiers;
        for (uint32_t i = 0; i < tower_.size() && i < P.capacity(); ++i) {
            if (tower_[i] != t) continue;
            const bool up = phase_[i] >= 2;
            release(ctx, i);
            if (up && ctx.cfg) {   // fell with it: beside the base, hurt
                const float a = (float)i * 2.3999f;
                V3 g{T.pos.x + std::cos(a) * (ctx.cfg->structures.towerHalf + 1.2f), T.pos.y, T.pos.z + std::sin(a) * (ctx.cfg->structures.towerHalf + 1.2f)};
                if (ctx.nav && ctx.nav->ready()) { V3 o; if (ctx.nav->nearestWalkable(g, 3.f, o)) g = o; g.y = ctx.nav->surface(g.x, g.z); }
                P.pos[i] = g; P.home[i] = g;
                P.health[i] -= ctx.cfg->structures.fallDamage;
                ++stats_.fell;
            }
        }
    }
    if (ctx.events) {
        ctx.events->fx.push_back({FxKind::Landing, SoldierId{}, T.pos, {0, 1, 0}});
    }
    {
        noise_.push_back({T.pos, 1.0f, 60.f, 3.f});
    }
    notice("Defense tower destroyed", true, T.pos);
}

void Structures::preCombat(const GameContext& ctx, std::vector<HordeSoldier>& caps) const {
    caps.clear();
    if (!ctx.cfg) return;
    const StructureConfig& S = ctx.cfg->structures;
    for (size_t t = 0; t < list_.size(); ++t) {
        const Structure& T = list_[t];
        if (T.kind != StructureKind::Tower || !T.solid()) continue;
        const Obb b = footprint(T.kind, T.pos, T.yaw, S);
        for (int k = 0; k < kProxies; ++k) {   // one proxy just inside each face of the base
            const float u = k == 0 ? 0.f : k == 1 ? 0.f : (k == 2 ? 1.f : -1.f), v = k == 0 ? 1.f : k == 1 ? -1.f : 0.f;
            HordeSoldier h;
            b.at(u * (S.towerHalf - 0.45f), v * (S.towerHalf - 0.45f), h.pos.x, h.pos.z);
            h.pos.y = T.pos.y;
            h.radius = 0.6f; h.height = 2.0f;
            h.attraction = 0.f;
            h.packedId = kProxyIndex | ((uint32_t)(t * kProxies + (size_t)k) << 16);
            caps.push_back(h);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
void Structures::tick(GameContext& ctx) {
    if (!ctx.cfg) return;
    const StructureConfig& S = ctx.cfg->structures;
    const float dt = ctx.dt;
    // ---- tower occupants: walk to the ladder, climb, hold the post
    if (ctx.soldiers) {
        SoldierPool& P = *ctx.soldiers;
        for (uint32_t i = 0; i < tower_.size() && i < P.capacity(); ++i) {
            const int t = tower_[i];
            if (t < 0 || !P.used[i] || !P.alive(i)) continue;
            const Structure& T = list_[(size_t)t];
            if (!T.solid()) { release(ctx, i); continue; }
            const V3 foot = ladderFoot(t, S), post = postPos(t, slot_[i], S);
            if (phase_[i] == 1) {
                const float d = d2D(P.pos[i], foot);
                const SoldierState st = P.state[i];
                if ((st == SoldierState::Idle && d < 3.0f) || (st == SoldierState::Moving && d < 1.2f)) {
                    if (P.path[i].request && ctx.nav) ctx.nav->cancel(P.path[i].request);
                    P.path[i] = PathFollow{};
                    P.vel[i] = {};
                    P.target[i].active = false;
                    P.setState(i, SoldierState::Idle);
                    P.post[i] = POST_ENTERING;
                    phase_[i] = 2; t_[i] = 0.f; from_[i] = P.pos[i];
                    P.yaw[i] = T.yaw;   // faces the ladder (tower front = +Z, ladder on -Z)
                } else if (st == SoldierState::Idle && P.stateTime[i] > 3.f && d >= 3.0f) walkTo(ctx, i, foot);
                continue;
            }
            if (phase_[i] == 2) {   // up the ladder: rise at the ladder, then step onto the post
                t_[i] += dt;
                const float k = std::clamp(t_[i] / std::max(0.1f, S.climbTime), 0.f, 1.f);
                V3 top = foot;
                top.y = post.y;
                P.pos[i] = k < 0.8f ? from_[i] + (top - from_[i]) * (k / 0.8f) : top + (post - top) * ((k - 0.8f) / 0.2f);
                P.vel[i] = {};
                if (k >= 1.f) {
                    phase_[i] = 3;
                    P.post[i] = POST_FIRING;
                    P.postOut[i] = {};
                    P.home[i] = post; P.homeYaw[i] = T.yaw;
                    ++stats_.climbed;
                }
                continue;
            }
            // posted: pinned on the deck (SoldierAI holds POST_FIRING soldiers; they fire over the parapet)
            P.pos[i] = post; P.vel[i] = {};
            P.home[i] = post;
            if (P.mag[i] + P.reserve[i] <= 0) {   // out of ammo: climbs down to resupply, but only when no zombie is close
                float nearest = 1e9f;                // (the deck is safe: climbing down into the heap at the base is death)
                const uint32_t id = P.idOf(i).packed();
                bool seen = false;
                if (ctx.horde)
                    for (const SoldierContact& c : ctx.horde->contacts())
                        if (c.packedId == id) {   // nearPos: exact nearest zombies at any height; nearby: coarse count within 8 m
                            seen = true;
                            nearest = c.nearby > 0 ? 0.f : 1e9f;
                            for (uint32_t q = 0; q < c.nNear; ++q) nearest = std::min(nearest, std::hypot(c.nearPos[q].x - P.pos[i].x, c.nearPos[q].z - P.pos[i].z));
                            break;
                        }
                if (seen && nearest > S.safeDescent) release(ctx, i);
            }
        }
    }
    // ---- tower pressure (zombies at the base, latest contacts of the proxies)
    std::vector<int> att(list_.size(), 0);
    if (ctx.horde)
        for (const SoldierContact& c : ctx.horde->contacts()) {
            if ((c.packedId & 0xFFFFu) != kProxyIndex) continue;
            const size_t t = (size_t)(c.packedId >> 16) / kProxies;
            if (t < att.size()) att[t] += c.attackers;
        }
    for (size_t t = 0; t < list_.size(); ++t) {
        Structure& T = list_[t];
        if (T.kind != StructureKind::Tower || !T.solid()) continue;
        T.attackers = t < forced_.size() && forced_[t] >= 0 ? forced_[t] : att[t];
        const int over = T.attackers - S.towerPressureThreshold;
        if (over > 0) T.health -= (float)over * S.towerDamagePerZombie * dt;
        if (T.health <= 0.f) collapse(ctx, (int)t);
    }
    // ---- generators: tank refill from a fuel store, lights assigned nearest first, run, burn
    std::vector<int> gens;
    for (size_t g = 0; g < list_.size(); ++g)
        if (list_[g].kind == StructureKind::Generator && list_[g].solid()) gens.push_back((int)g);
    for (int g : gens) {
        Structure& G = list_[(size_t)g];
        G.powered = 0;
        if (G.tank < 0.5f * S.generatorTank) {
            int best = -1; float bd = S.fuelLinkRange;
            for (size_t s = 0; s < list_.size(); ++s)
                if (list_[s].kind == StructureKind::FuelStore && list_[s].solid() && list_[s].fuel > 0.f && d2D(list_[s].pos, G.pos) <= bd) { bd = d2D(list_[s].pos, G.pos); best = (int)s; }
            if (best >= 0) {
                const float take = std::min(S.generatorTank - G.tank, list_[(size_t)best].fuel);
                list_[(size_t)best].fuel -= take;
                G.tank += take;
            }
        }
    }
    const bool demand = forceLights || night || !S.lightsOnlyAtNight;
    for (size_t l = 0; l < list_.size(); ++l) {
        Structure& L = list_[l];
        if (L.kind != StructureKind::Light) continue;
        L.source = -1; L.lit = false;
        if (!L.solid()) continue;
        int best = -1; float bd = S.cableRange;
        for (int g : gens) {
            const Structure& G = list_[(size_t)g];
            if (G.powered >= S.generatorMaxLights || G.tank <= 0.f) continue;
            const float d = d2D(G.pos, L.pos);
            if (d < bd) { bd = d; best = g; }
        }
        if (best >= 0) { L.source = best; ++list_[(size_t)best].powered; }
    }
    for (int g : gens) {
        Structure& G = list_[(size_t)g];
        G.running = demand && G.powered > 0 && G.tank > 0.f;
        if (!G.running) continue;
        const float burn = (S.generatorBurn + S.burnPerLight * (float)G.powered) * dt;
        const float b = std::min(burn, G.tank);
        G.tank -= b;
        stats_.fuelBurned += b;
        if (G.tank <= 0.f) { G.running = false; notice("Generator out of fuel: the lights go dark", true, G.pos); }
    }
    for (Structure& L : list_)
        if (L.kind == StructureKind::Light) L.lit = L.solid() && L.source >= 0 && list_[(size_t)L.source].running;
    // ---- generator noise: areas within noiseStackRadius add up (capped), one pulse per area per noiseInterval
    noiseT_ += dt;
    if (noiseT_ >= S.noiseInterval) {
        noiseT_ = 0.f;
        areas_.clear();
        std::vector<uint8_t> used(list_.size(), 0);
        for (int g : gens) {
            if (used[(size_t)g] || !list_[(size_t)g].running) continue;
            Area a;
            V3 c{};
            for (int h : gens) {
                if (used[(size_t)h] || !list_[(size_t)h].running || d2D(list_[(size_t)h].pos, list_[(size_t)g].pos) > S.noiseStackRadius) continue;
                used[(size_t)h] = 1;
                c = c + list_[(size_t)h].pos;
                ++a.generators;
            }
            a.pos = c * (1.f / (float)a.generators);
            a.strength = std::min(S.noiseCap, S.noiseIntensity * (float)a.generators);
            a.radius = std::min(S.noiseRadiusCap, S.noiseRadius * std::sqrt(a.strength / std::max(1e-3f, S.noiseIntensity)));
            areas_.push_back(a);
            noise_.push_back({a.pos, a.strength, a.radius, S.noiseInterval + 2.f * (float)kTickDt});
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
float Structures::fuelStock() const {
    float f = 0.f;
    for (const Structure& s : list_) if (s.kind == StructureKind::FuelStore && s.solid()) f += s.fuel;
    return f;
}

float Structures::fuelCapacity() const {
    float f = 0.f;
    for (const Structure& s : list_) if (s.kind == StructureKind::FuelStore && s.solid()) f += 1.f;
    return f;   // stores (x StructureConfig::fuelStoreCapacity)
}

int Structures::storeFor(V3 from) const {
    int best = -1;
    float bd = 1e9f;
    for (size_t i = 0; i < list_.size(); ++i) {
        const Structure& s = list_[i];
        if (s.kind != StructureKind::FuelStore || !s.solid()) continue;
        const float d = d2D(s.pos, from);
        if (d < bd) { bd = d; best = (int)i; }
    }
    return best;
}

V3 Structures::deliveryPoint(int store, const StructureConfig& S) const {
    const Structure& s = list_[(size_t)store];
    Obb b = footprint(s.kind, s.pos, s.yaw, S);
    V3 p;
    b.at(0.8f, b.hz + 0.8f, p.x, p.z);   // front of the bund, beside the jerrycan rack
    p.y = s.pos.y;
    return p;
}

float Structures::addFuel(int store, float litres) {
    if (store < 0 || (size_t)store >= list_.size()) return 0.f;
    Structure& s = list_[(size_t)store];
    s.fuel += litres;   // capacity is applied by the caller (FuelLogistics knows the config); overflow is kept (PROPOSED)
    stats_.fuelIn += litres;
    return litres;
}

} // namespace ttz::game
