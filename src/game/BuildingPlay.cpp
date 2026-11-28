// B3a building gameplay: capture, roles, garrison posts, hospital, barricades. See BuildingPlay.h.
#include "game/BuildingPlay.h"

#include "game/Config.h"
#include "game/Economy.h"
#include "game/HordeInterface.h"
#include "game/NavGrid.h"
#include "game/SoldierAnim.h"
#include "game/Soldiers.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ttz::game {

namespace {
float d2D(V3 a, V3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)); }
float wrapA(float a) { while (a > 3.14159265f) a -= 6.2831853f; while (a < -3.14159265f) a += 6.2831853f; return a; }
bool deploying(SoldierState s) { return s == SoldierState::Descending || s == SoldierState::Landing || s == SoldierState::Recovering; }
} // namespace

V3 BuildingPlay::doorExit(const Building& B, int k) {
    if (k < 0 || k >= (int)B.openings.size()) return B.centre();
    const Opening& o = B.openings[(size_t)k];
    return {o.pos.x + o.nx * 1.6f, o.pos.y, o.pos.z + o.nz * 1.6f};
}

bool BuildingPlay::posted(uint32_t i) const { (void)i; return false; }

int BuildingPlay::firingSlotOf(const Building& B, uint32_t i, const SoldierPool& P) const {
    const SoldierId id = P.idOf(i);
    for (size_t k = 0; k < B.firing.size(); ++k) if (B.firing[k].occupant == id) return (int)k;
    return -1;
}

void BuildingPlay::walkTo(GameContext& ctx, uint32_t i, V3 goal) {
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
    P.phase[i] |= PH_RETURNING;   // not a player order: threats interrupt it, the leash keeps him at the door after
}

// ---------------------------------------------------------------------------------------------------------------------
bool BuildingPlay::setRole(GameContext& ctx, BuildingId id, BuildingRole role, std::string& msg) {
    Building* B = reg_.get(id);
    if (!B) { msg = "no building"; return false; }
    if (!B->supported) { msg = std::string("unsupported building: ") + B->unsupportedWhy; return false; }
    if (B->capture != CaptureState::Captured) { msg = "capture it first (a squad at the entrance, no zombies inside)"; return false; }
    if (B->role == role) { msg = std::string("already a ") + roleName(role); return false; }
    const BuildingConfig& bc = ctx.cfg->buildings;
    const int price = role == BuildingRole::Garrison ? bc.garrisonPrice : role == BuildingRole::Hospital ? bc.hospitalPrice : 0;
    if (price > 0 && (!ctx.economy || !ctx.economy->spend(price, role == BuildingRole::Garrison ? "garrison" : "hospital", ctx.time))) { msg = "Not enough funding"; return false; }
    // leaving the old role: garrison soldiers step out, patients are discharged where they stand (healed so far)
    SoldierPool& P = *ctx.soldiers;
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i)
        if (P.used[i] && P.building[i] == id.v && P.post[i] != POST_NONE) release(ctx, i);
    B->role = role;
    if (ammo_.size() <= id.v) ammo_.resize(id.v + 1, 0);
    ammo_[id.v] = role == BuildingRole::Garrison ? bc.garrisonAmmo : 0;
    B->capacity = role == BuildingRole::Hospital ? bc.hospitalBeds : (int)B->firing.size();
    char t[128];
    std::snprintf(t, sizeof(t), "%s set up (%s, %d %s)", roleName(role), kindName(B->kind), B->capacity, role == BuildingRole::Hospital ? "beds" : "firing positions");
    msg = t;
    return true;
}

bool BuildingPlay::garrison(GameContext& ctx, SquadId sqId, BuildingId id, std::string& msg) {
    Building* B = reg_.get(id);
    Squad* sq = ctx.squads ? ctx.squads->get(sqId) : nullptr;
    if (!B || !sq) { msg = "select a squad and a building"; return false; }
    if (B->role != BuildingRole::Garrison) { msg = "the building is not a garrison"; return false; }
    SoldierPool& P = *ctx.soldiers;
    int assigned = 0;
    for (const SoldierId& m : sq->members) {
        if (!P.valid(m) || !P.alive(m.index) || deploying(P.state[m.index])) continue;
        const uint32_t i = m.index;
        if (P.post[i] != POST_NONE) continue;
        const int slot = pickSlot(ctx, *B);   // windows facing the threats first, spread over the facades

        if (slot < 0) break;
        B->firing[(size_t)slot].occupant = m;
        B->garrison.push_back(m);
        if (orderSerial_.size() < P.capacity()) { orderSerial_.resize(P.capacity(), 0); enterT_.resize(P.capacity(), 0.f); enterFrom_.resize(P.capacity()); hospitalTrip_.resize(P.capacity(), 0); }
        orderSerial_[i] = sq->order.serial;
        hospitalTrip_[i] = 0;
        P.post[i] = POST_APPROACH;
        P.building[i] = id.v;
        const int door = reg_.nearestEntrance(id, P.pos[i].x, P.pos[i].z);
        V3 g = doorExit(*B, door);
        const float side = (float)((assigned % 3) - 1) * 0.9f;   // queue beside the door, not on top of each other
        g.x += B->e1x * side; g.z += B->e1z * side;
        walkTo(ctx, i, g);
        ++assigned;
    }
    if (!assigned) { msg = "no free firing position (or no soldier available)"; return false; }
    char t[96];
    std::snprintf(t, sizeof(t), "%d soldiers moving into the garrison", assigned);
    msg = t;
    return true;
}

// Free firing position for the next soldier (GAME_DESIGN 14e: more soldiers open more windows, spread across the facades
// facing threats): list priority (front windows, a few roof posts, upper floors, side windows), minus a bonus for facades
// with zombies in front of them (coarse field, 60 m), minus a bonus for being far from the posts already taken.
int BuildingPlay::pickSlot(const GameContext& ctx, const Building& B) const {
    float threat[4] = {0, 0, 0, 0}, tot = 0;
    const V3 c = B.centre();
    const float sx[4] = {-B.e2x, B.e1x, B.e2x, -B.e1x}, sz[4] = {-B.e2z, B.e1z, B.e2z, -B.e1z};
    if (ctx.horde) {
        const ZombieField& f = ctx.horde->field();
        for (size_t t = 0; t < f.tiles.size() && f.tileSize > 0.f; ++t) {
            const ZombieFieldTile& T = f.tiles[t];
            for (uint32_t k = 0; k < T.samples; ++k) {
                const float dx = T.pos[k].x - c.x, dz = T.pos[k].z - c.z, d = std::sqrt(dx * dx + dz * dz);
                if (d > 60.f || d < 1e-3f) continue;
                int best = 0;
                for (int s = 1; s < 4; ++s) if (dx * sx[s] + dz * sz[s] > dx * sx[best] + dz * sz[best]) best = s;
                threat[best] += 1.f; tot += 1.f;
            }
        }
    }
    int slot = -1;
    float bestScore = 1e30f;
    for (size_t k = 0; k < B.firing.size(); ++k) {
        const FiringPosition& f = B.firing[k];
        if (f.occupant.valid()) continue;
        int side = 0;
        const float ox = std::sin(f.yaw), oz = std::cos(f.yaw);
        for (int s = 1; s < 4; ++s) if (ox * sx[s] + oz * sz[s] > ox * sx[side] + oz * sz[side]) side = s;
        float near = 1e9f;
        for (const FiringPosition& o : B.firing)
            if (o.occupant.valid()) near = std::min(near, d2D(o.pos, f.pos) + std::fabs(o.pos.y - f.pos.y));
        float score = (float)k;
        if (tot > 0.f) score -= 8.f * threat[side] / tot;
        if (near < 1e8f) score -= std::min(near, 12.f) * 0.25f;
        if (score < bestScore) { bestScore = score; slot = (int)k; }
    }
    return slot;
}

bool BuildingPlay::barricade(GameContext& ctx, BuildingId id, int opening, BarricadeType t, std::string& msg) {
    Building* B = reg_.get(id);
    if (!B) { msg = "no building"; return false; }
    if (B->capture != CaptureState::Captured) { msg = "capture it first"; return false; }
    if (t == BarricadeType::None || t >= BarricadeType::Count) { msg = "barricade type"; return false; }
    const BuildingConfig& bc = ctx.cfg->buildings;
    std::vector<int> ops;
    for (size_t k = 0; k < B->openings.size(); ++k)
        if ((opening < 0 && B->openings[k].type == OpeningType::Door) || (int)k == opening) ops.push_back((int)k);
    if (ops.empty()) { msg = "no such opening"; return false; }
    const int price = bc.barricadePrice[(size_t)t - 1] * (int)ops.size();
    if (!ctx.economy || !ctx.economy->spend(price, "barricade", ctx.time)) { msg = "Not enough funding"; return false; }
    for (int k : ops) reg_.setBarricade(id, (uint16_t)k, t, bc.barricadeHealth[(size_t)t - 1]);
    stats_.barricades += (uint32_t)ops.size();
    char s[96];
    std::snprintf(s, sizeof(s), "%zu opening%s barricaded (%s)", ops.size(), ops.size() > 1 ? "s" : "", barricadeName(t));
    msg = s;
    return true;
}

bool BuildingPlay::barricadeWindows(GameContext& ctx, BuildingId id, BarricadeType t, std::string& msg) {
    Building* B = reg_.get(id);
    if (!B) { msg = "no building"; return false; }
    if (B->capture != CaptureState::Captured) { msg = "capture it first"; return false; }
    if (t == BarricadeType::None || t >= BarricadeType::Count) { msg = "barricade type"; return false; }
    // the closed windows of the ground and first floor (Building::covers), never the windows soldiers fire from
    if (B->covers.empty()) { msg = "no closed lower-floor windows to cover"; return false; }
    if (B->coverType == t) { msg = std::string("windows already covered (") + barricadeName(t) + ")"; return false; }
    const BuildingConfig& bc = ctx.cfg->buildings;
    const int n = (int)B->covers.size();
    const int price = bc.windowCoverPrice[(size_t)t - 1];   // per building, not per panel (UNAPPROVED)
    if (!ctx.economy || !ctx.economy->spend(price, "barricade", ctx.time)) { msg = "Not enough funding"; return false; }
    B->coverType = t;
    stats_.barricades += (uint32_t)n;
    char s[96];
    std::snprintf(s, sizeof(s), "%d windows barricaded (%s)", n, barricadeName(t));
    msg = s;
    return true;
}

namespace {
BarricadeType levelDoor(int L) { return L <= 1 ? BarricadeType::Planks : L == 2 ? BarricadeType::Plate : BarricadeType::Sandbags; }
BarricadeType levelCover(int L) { return L <= 1 ? BarricadeType::Planks : BarricadeType::Plate; }
} // namespace

int BuildingPlay::fortifyPrice(const BuildingConfig& bc, const Building& B) {
    const int L = B.defence + 1;
    if (L > 3) return 0;
    int doors = 0, roof = 0;
    for (const Opening& o : B.openings) doors += o.type == OpeningType::Door ? 1 : 0;
    for (const FiringPosition& f : B.firing) roof += f.kind == FiringKind::RoofEdge && !f.nest ? 1 : 0;
    int p = doors * bc.barricadePrice[(size_t)levelDoor(L) - 1];
    if (B.coverType != levelCover(L) || L == 3) p += B.covers.empty() ? 0 : bc.windowCoverPrice[(size_t)levelCover(L) - 1];
    if (L == 2) p += doors * bc.barricadePrice[(size_t)BarricadeType::Sandbags - 1];   // sandbag walls at the entrances
    if (L == 3) p += roof * bc.nestPrice + doors * bc.barricadePrice[(size_t)BarricadeType::Sandbags - 1];
    return p;
}

// Entrance sandbag Us (L2+: beside each door, the doorway clear) and the L3 slit-wall perimeter (3 m out along every
// facade with an entrance, a gap on each door axis). Each piece is kept at the first candidate whose footprint is
// clear: walkable NavGrid cells at its base height, outside other buildings, no parked vehicle within 0.3 m, not over
// an accepted piece or a doorway. Candidates: as designed, closer to the facade (lot side), further out, shifted
// along the facade, rotated 90 deg, then a 0.6-scale (shorter) piece. Accepted pieces are stamped as obstacles.
void BuildingPlay::placeFortPieces(GameContext& ctx, Building& B) {
    if (B.fortLevel >= B.defence) return;
    struct Box { float cx, cz, hx, hz, c, s; };
    auto boxOf = [](const Building::FortPiece& p) {
        const float c = std::cos(p.yaw), s = std::sin(p.yaw), oz = p.kind == 1 ? 0.25f * p.scale : 0.f;   // slit: back face at z = 0
        return Box{p.pos.x + s * oz, p.pos.z + c * oz, p.hx, p.hz, c, s};
    };
    auto inBox = [](const Box& b, float x, float z, float m) {
        const float dx = x - b.cx, dz = z - b.cz;
        return std::fabs(dx * b.c - dz * b.s) < b.hx + m && std::fabs(dx * b.s + dz * b.c) < b.hz + m;
    };
    auto ground = [&](float x, float z, float def) { return ctx.nav && ctx.nav->ready() ? ctx.nav->surface(x, z) : def; };
    std::vector<const Building*> nearB;
    const V3 bc0 = B.centre();
    for (uint32_t k = 0; k < (uint32_t)reg_.size(); ++k) {
        const Building* o = reg_.get(BuildingId{k});
        if (!o || o == &B) continue;
        const V3 oc = o->centre();
        const float r = 0.5f * (std::hypot(B.w, B.d) + std::hypot(o->w, o->d)) + 8.f;
        if ((oc.x - bc0.x) * (oc.x - bc0.x) + (oc.z - bc0.z) * (oc.z - bc0.z) < r * r) nearB.push_back(o);
    }
    auto clear = [&](const Building::FortPiece& p) {
        const Box b = boxOf(p);
        for (int i = -1; i <= 1; ++i)
            for (int j = -1; j <= 1; ++j) {
                const float lx = (float)i * (b.hx + 0.15f), lz = (float)j * (b.hz + 0.15f);
                const float x = b.cx + lx * b.c + lz * b.s, z = b.cz - lx * b.s + lz * b.c;
                if (ctx.nav && ctx.nav->ready() && (!ctx.nav->walkable(x, z) || std::fabs(ctx.nav->surface(x, z) - p.pos.y) > 0.35f)) return false;
                if (B.contains(x, z)) return false;
                for (const Building* o : nearB) if (o->contains(x, z)) return false;
                for (const Building::FortPiece& q : B.fortPieces) if (inBox(boxOf(q), x, z, 0.1f)) return false;
                for (const Opening& o : B.openings) {   // doorway corridor: 1.5 m out, door width + 0.3 m
                    if (o.type != OpeningType::Door) continue;
                    const float dx = x - o.pos.x, dz = z - o.pos.z, out = dx * o.nx + dz * o.nz;
                    if (out > -0.5f && out < 1.8f && std::fabs(dx * o.nz - dz * o.nx) < 0.5f * o.width + 0.3f) return false;
                }
            }
        if (carNear && carNear(b.cx, b.cz, std::max(b.hx, b.hz) + 0.3f)) return false;
        return true;
    };
    auto place = [&](uint8_t kind, V3 at, float yaw, float nx, float nz) {
        const float tx = nz, tz = -nx;
        static const float outs[5] = {0.f, -0.6f, -1.2f, 1.0f, 2.0f}, alongs[3] = {0.f, 0.8f, -0.8f};
        for (int sc = 0; sc < 2; ++sc)
            for (int rot = 0; rot < 2; ++rot)
                for (float dO : outs)
                    for (float dA : alongs) {
                        Building::FortPiece p;
                        p.kind = kind; p.scale = sc ? 0.6f : 1.f;
                        p.yaw = yaw + (rot ? 1.5707963f : 0.f);
                        p.hx = (kind == 0 ? 1.3f : 1.0f) * p.scale; p.hz = (kind == 0 ? 0.9f : 0.25f) * p.scale; p.top = (kind == 0 ? 0.9f : 1.2f) * p.scale;
                        const float x = at.x + nx * dO + tx * dA, z = at.z + nz * dO + tz * dA;
                        p.pos = {x, ground(x, z, at.y), z};
                        if (!clear(p)) continue;
                        const Box b = boxOf(p);
                        if (addObstacle) p.obstacle = addObstacle(b.cx, b.cz, b.hx, b.hz, p.yaw, p.pos.y + p.top);
                        B.fortPieces.push_back(p);
                        return;
                    }
    };
    if (B.defence >= 2 && B.fortLevel < 2)
        for (const Opening& o : B.openings) {
            if (o.type != OpeningType::Door) continue;
            float u, v;
            B.toLocal(o.pos.x, o.pos.z, u, v);
            const float ins = std::max(0.f, std::max({-(o.nx * B.e2x + o.nz * B.e2z) * v, (o.nx * B.e1x + o.nz * B.e1z) * (B.w - u),
                                                      (o.nx * B.e2x + o.nz * B.e2z) * (B.d - v), -(o.nx * B.e1x + o.nz * B.e1z) * u}));
            const float tx = o.nz, tz = -o.nx, yaw = std::atan2(o.nx, o.nz);
            for (int sd = -1; sd <= 1; sd += 2) {
                const float off = 0.5f * o.width + 1.5f, out = ins + 1.0f;
                place(0, {o.pos.x + o.nx * out + tx * off * (float)sd, o.pos.y, o.pos.z + o.nz * out + tz * off * (float)sd}, yaw, o.nx, o.nz);
            }
        }
    if (B.defence >= 3 && B.fortLevel < 3) {
        const float ax[4][2] = {{-B.e2x, -B.e2z}, {B.e1x, B.e1z}, {B.e2x, B.e2z}, {-B.e1x, -B.e1z}};
        unsigned sides = 0;
        for (const Opening& o : B.openings) {
            if (o.type != OpeningType::Door) continue;
            int best = 0; float bd = -2.f;
            for (int k = 0; k < 4; ++k) { const float dd = o.nx * ax[k][0] + o.nz * ax[k][1]; if (dd > bd) { bd = dd; best = k; } }
            sides |= 1u << best;
        }
        for (int k = 0; k < 4; ++k) {
            if (!(sides & (1u << k))) continue;
            const float len = (k & 1) ? B.d : B.w, yaw = std::atan2(ax[k][0], ax[k][1]);
            const int n = std::max(1, (int)std::floor(len / 2.0f));
            for (int i = 0; i < n; ++i) {
                const float a = (len - 2.0f * (float)n) * 0.5f + 1.0f + 2.0f * (float)i;
                float u, v;
                if (k == 0) { u = a; v = -3.0f; } else if (k == 2) { u = len - a; v = B.d + 3.0f; }
                else if (k == 1) { u = B.w + 3.0f; v = a; } else { u = -3.0f; v = len - a; }
                const V3 p = B.toWorld(u, v, B.y0);
                bool gap = false;
                for (const Opening& o : B.openings) {
                    if (o.type != OpeningType::Door) continue;
                    const float dx = p.x - o.pos.x, dz = p.z - o.pos.z;
                    if (std::fabs(dx * o.nz - dz * o.nx) < 1.0f + 0.5f * std::max(o.width, 1.6f) && dx * o.nx + dz * o.nz > 0.f) gap = true;
                }
                if (!gap) place(1, p, yaw, ax[k][0], ax[k][1]);
            }
        }
    }
    B.fortLevel = B.defence;
}

bool BuildingPlay::fortify(GameContext& ctx, BuildingId id, std::string& msg, bool free) {
    Building* B = reg_.get(id);
    if (!B) { msg = "no building"; return false; }
    if (B->capture != CaptureState::Captured) { msg = "capture it first"; return false; }
    if (B->defence >= 3) { msg = "defence already at level 3"; return false; }
    const BuildingConfig& bc = ctx.cfg->buildings;
    const int price = fortifyPrice(bc, *B);
    if (!free && (!ctx.economy || !ctx.economy->spend(price, "fortification", ctx.time))) { msg = "Not enough funding"; return false; }
    const int L = ++B->defence;
    const BarricadeType dt = levelDoor(L);
    int n = 0;
    for (size_t k = 0; k < B->openings.size(); ++k)
        if (B->openings[k].type == OpeningType::Door) {
            // L3: sandbags in the door backed by the plate (health of both; the perimeter in front is visual)
            const float hp = L == 3 ? bc.barricadeHealth[(size_t)BarricadeType::Plate - 1] + bc.barricadeHealth[(size_t)BarricadeType::Sandbags - 1]
                                    : bc.barricadeHealth[(size_t)dt - 1];
            reg_.setBarricade(id, (uint16_t)k, dt, hp);
            ++n;
        }
    B->coverType = levelCover(L);
    n += (int)B->covers.size();
    placeFortPieces(ctx, *B);
    if (L == 3)
        for (FiringPosition& f : B->firing)
            if (f.kind == FiringKind::RoofEdge && !f.nest) { f.nest = true; ++stats_.nests; }
    stats_.barricades += (uint32_t)n;
    char s[128];
    std::snprintf(s, sizeof(s), "Defence level %d (%d doors / windows barricaded)", L, n);
    msg = s;
    return true;
}

bool BuildingPlay::nest(GameContext& ctx, BuildingId id, int firing, std::string& msg) {
    Building* B = reg_.get(id);
    if (!B) { msg = "no building"; return false; }
    if (B->capture != CaptureState::Captured) { msg = "capture it first"; return false; }
    std::vector<int> fs;
    for (size_t k = 0; k < B->firing.size(); ++k) if (!B->firing[k].nest && (firing < 0 || (int)k == firing)) fs.push_back((int)k);
    if (fs.empty()) { msg = "nothing to fortify"; return false; }
    const int price = ctx.cfg->buildings.nestPrice * (int)fs.size();
    if (!ctx.economy || !ctx.economy->spend(price, "fortification", ctx.time)) { msg = "Not enough funding"; return false; }
    for (int k : fs) B->firing[(size_t)k].nest = true;
    stats_.nests += (uint32_t)fs.size();
    char s[96];
    std::snprintf(s, sizeof(s), "%zu firing positions fortified (window nests / roof rings)", fs.size());
    msg = s;
    return true;
}

void BuildingPlay::release(GameContext& ctx, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    if (i >= P.capacity()) return;
    BuildingId id; id.v = P.building[i];
    Building* B = reg_.get(id);
    const uint8_t post = P.post[i];
    if (B) {
        const SoldierId sid = P.idOf(i);
        for (FiringPosition& f : B->firing) if (f.occupant == sid) f.occupant = {};
        B->garrison.erase(std::remove(B->garrison.begin(), B->garrison.end(), sid), B->garrison.end());
        B->patients.erase(std::remove(B->patients.begin(), B->patients.end(), sid), B->patients.end());
        if (post == POST_FIRING || post == POST_INSIDE || post == POST_ENTERING) {
            // step out of the nearest door (walkable street point)
            const int door = reg_.nearestEntrance(id, P.pos[i].x, P.pos[i].z);
            V3 g = doorExit(*B, door);
            if (ctx.nav && ctx.nav->ready()) { V3 o; if (ctx.nav->nearestWalkable(g, 3.f, o)) g = o; g.y = ctx.nav->surface(g.x, g.z); }
            P.pos[i] = g;
            P.home[i] = g;
            P.vel[i] = {};
        }
    }
    P.post[i] = POST_NONE;
    P.building[i] = ~0u;
    P.postOut[i] = {};
    if (i < hospitalTrip_.size()) hospitalTrip_[i] = 0;
    ++stats_.released;
}

bool BuildingPlay::medicalSeek(GameContext& ctx, uint32_t i) {
    SoldierPool& P = *ctx.soldiers;
    if (P.post[i] != POST_NONE || !P.alive(i)) return false;
    const BuildingConfig& bc = ctx.cfg->buildings;
    // nearest hospital with a free bed (patients + soldiers already on the way)
    std::vector<BuildingId> c;
    const V3 p = P.pos[i];
    reg_.inRect(p.x - bc.hospitalSearch, p.z - bc.hospitalSearch, p.x + bc.hospitalSearch, p.z + bc.hospitalSearch, c);
    BuildingId best;
    float bd = bc.hospitalSearch;
    for (BuildingId id : c) {
        const Building& B = *reg_.get(id);
        if (B.role != BuildingRole::Hospital || B.capture != CaptureState::Captured) continue;
        int load = (int)B.patients.size();
        for (uint32_t k = 0; k < (uint32_t)P.capacity(); ++k) load += (P.used[k] && P.building[k] == id.v && P.post[k] == POST_APPROACH) ? 1 : 0;
        if (load >= bc.hospitalBeds) continue;
        const float d = d2D(p, B.centre());
        if (d < bd) { bd = d; best = id; }
    }
    if (!best.valid()) return false;
    if (orderSerial_.size() < P.capacity()) { orderSerial_.resize(P.capacity(), 0); enterT_.resize(P.capacity(), 0.f); enterFrom_.resize(P.capacity()); hospitalTrip_.resize(P.capacity(), 0); }
    const Squad* sq = ctx.squads ? ctx.squads->get(P.squad[i]) : nullptr;
    orderSerial_[i] = sq ? sq->order.serial : 0;
    hospitalTrip_[i] = 1;
    P.post[i] = POST_APPROACH;
    P.building[i] = best.v;
    const Building& B = *reg_.get(best);
    walkTo(ctx, i, doorExit(B, reg_.nearestEntrance(best, p.x, p.z)));
    return true;
}

// ---------------------------------------------------------------------------------------------------------------------
void BuildingPlay::preAi(GameContext& ctx) {
    SoldierPool& P = *ctx.soldiers;
    if (orderSerial_.size() < P.capacity()) { orderSerial_.resize(P.capacity(), 0); enterT_.resize(P.capacity(), 0.f); enterFrom_.resize(P.capacity()); hospitalTrip_.resize(P.capacity(), 0); }
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || P.post[i] == POST_NONE || structurePost(P.building[i])) continue;   // 14e towers: Structures
        const Squad* sq = ctx.squads ? ctx.squads->get(P.squad[i]) : nullptr;
        if (!P.alive(i)) {   // dead at a window: the body stays where it fell; the position is free again
            if (P.post[i] != POST_FIRING) release(ctx, i);
            else if (Building* B = reg_.get(BuildingId{P.building[i]})) {
                const SoldierId sid = P.idOf(i);
                for (FiringPosition& f : B->firing) if (f.occupant == sid) f.occupant = {};
                B->garrison.erase(std::remove(B->garrison.begin(), B->garrison.end(), sid), B->garrison.end());
            }
            continue;
        }
        if (sq && sq->order.serial != orderSerial_[i] && !(hospitalTrip_[i] && P.post[i] == POST_INSIDE)) release(ctx, i);   // a new player order
    }
}

void BuildingPlay::applyPending(GameContext& ctx) {
    std::vector<Action> todo;
    todo.swap(pending_);
    for (const Action& a : todo) {
        std::string msg;
        bool ok = false;
        switch (a.act) {
        case Act::Role: ok = setRole(ctx, a.b, (BuildingRole)a.arg, msg); break;
        case Act::Garrison: ok = garrison(ctx, a.squad, a.b, msg); break;
        case Act::BarricadeDoors: ok = barricade(ctx, a.b, -1, (BarricadeType)a.arg, msg); break;
        case Act::BarricadeWindows: ok = barricadeWindows(ctx, a.b, (BarricadeType)a.arg, msg); break;
        case Act::Nest: ok = nest(ctx, a.b, -1, msg); break;
        case Act::Fortify: ok = fortify(ctx, a.b, msg, a.arg == 1); break;
        case Act::Release: {
            SoldierPool& P = *ctx.soldiers;
            int n = 0;
            for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i)
                if (P.used[i] && P.building[i] == a.b.v && P.post[i] != POST_NONE && !(i < hospitalTrip_.size() && hospitalTrip_[i])) { release(ctx, i); ++n; }
            ok = n > 0; msg = ok ? "Garrison left the building" : "nobody to release";
            break;
        }
        }
        notice(ok ? msg : "Refused: " + msg, !ok);
    }
}

void BuildingPlay::tick(GameContext& ctx) {
    if (!ctx.soldiers || !ctx.cfg) return;
    const float dt = ctx.dt;
    if (ammo_.size() < reg_.size()) ammo_.resize(reg_.size(), 0);
    applyPending(ctx);
    capture(ctx, dt);
    approach(ctx);
    hospital(ctx, dt);
    breachFallback(ctx, dt);
}

void BuildingPlay::capture(GameContext& ctx, float dt) {
    SoldierPool& P = *ctx.soldiers;
    const BuildingConfig& bc = ctx.cfg->buildings;
    const std::vector<SoldierContact>* cs = ctx.horde ? &ctx.horde->contacts() : nullptr;
    std::vector<int> contactOf(P.capacity(), -1);
    if (cs)
        for (size_t k = 0; k < cs->size(); ++k) {
            const uint32_t i = (*cs)[k].packedId & 0xFFFFu;
            if (i < P.capacity() && P.used[i] && (P.gen[i] & 0xFFFFu) == ((*cs)[k].packedId >> 16)) contactOf[i] = (int)k;
        }
    // presence: soldiers at an entrance or inside the footprint (garrisoned / entering included)
    std::vector<uint8_t> present(reg_.size(), 0), contested(reg_.size(), 0);
    std::vector<BuildingId> near;
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i) || deploying(P.state[i])) continue;
        const V3 p = P.pos[i];
        const float r = bc.captureRadius;
        reg_.inRect(p.x - r, p.z - r, p.x + r, p.z + r, near);
        for (BuildingId id : near) {
            const Building& B = *reg_.get(id);
            if (!B.prepared || !B.supported) continue;
            bool at = P.building[i] == id.v || B.contains(p.x, p.z, 0.5f);
            int door = -1;
            for (size_t k = 0; k < B.openings.size() && !at; ++k)
                if (B.openings[k].type == OpeningType::Door && d2D(p, B.openings[k].pos) < r && std::fabs(p.y - B.openings[k].pos.y) < 2.f) { at = true; door = (int)k; }
            if (!at) continue;
            present[id.v] = 1;
            // zombies at the door (exact nearest lists of the soldiers there)
            if (cs && contactOf[i] >= 0) {
                const SoldierContact& c = (*cs)[(size_t)contactOf[i]];
                for (uint32_t k = 0; k < c.nNear; ++k)
                    for (const Opening& o : B.openings)
                        if (o.type == OpeningType::Door && d2D(c.nearPos[k], o.pos) < bc.doorClearRadius && std::fabs(c.nearPos[k].y - o.pos.y) < 2.f) contested[id.v] = 1;
            }
            (void)door;
        }
    }
    for (uint32_t b = 0; b < (uint32_t)reg_.size(); ++b) {
        Building& B = *reg_.get(BuildingId{b});
        if (B.capture == CaptureState::Captured) continue;
        const int forced = b < forced_.size() ? forced_[b] : -1;
        const bool inside = forced >= 0 ? forced > 0 : B.zombiesInside > 0;   // B3b counts (-1 unknown: not simulated -> not blocking)
        if (present[b]) {
            if (contested[b] || inside) B.capture = CaptureState::Contested;
            else {
                B.capture = CaptureState::Capturing;
                B.captureProgress += dt / std::max(0.1f, bc.captureTime);
                if (B.captureProgress >= 1.f) {
                    B.captureProgress = 1.f;
                    B.capture = CaptureState::Captured;
                    ++stats_.captured;
                    char t[96];
                    std::snprintf(t, sizeof(t), "Building captured (%s, %d floors)", kindName(B.kind), (int)B.floors);
                    notice(t, false);
                }
            }
        } else if (B.captureProgress > 0.f) {
            B.captureProgress = std::max(0.f, B.captureProgress - 0.5f * dt / std::max(0.1f, bc.captureTime));
            B.capture = B.captureProgress > 0.f ? CaptureState::Capturing : CaptureState::Unclaimed;
        }
    }
}

void BuildingPlay::approach(GameContext& ctx) {
    SoldierPool& P = *ctx.soldiers;
    const float dt = ctx.dt;
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) {
        if (!P.used[i] || !P.alive(i) || P.post[i] == POST_NONE || structurePost(P.building[i])) continue;   // 14e towers: Structures
        Building* B = reg_.get(BuildingId{P.building[i]});
        if (!B) { P.post[i] = POST_NONE; continue; }
        const BuildingId id{P.building[i]};
        if (P.post[i] == POST_APPROACH) {
            const int door = reg_.nearestEntrance(id, P.pos[i].x, P.pos[i].z);
            if (door < 0) { release(ctx, i); continue; }
            const V3 ex = doorExit(*B, door);
            const SoldierState s = P.state[i];
            const float d = d2D(P.pos[i], ex);
            if ((s == SoldierState::Idle && d < 3.0f) || (s == SoldierState::Moving && d < 1.2f)) {
                if (P.path[i].request && ctx.nav) ctx.nav->cancel(P.path[i].request);
                P.path[i] = PathFollow{};
                P.vel[i] = {};
                P.target[i].active = false;
                P.setState(i, SoldierState::Idle);
                P.post[i] = POST_ENTERING;
                enterT_[i] = 0.f;
                enterFrom_[i] = P.pos[i];
                const Opening& o = B->openings[(size_t)door];
                P.yaw[i] = std::atan2(-o.nx, -o.nz);
                if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::EnterBuilding);
                else { P.anim[i].requested = AnimAction::EnterBuilding; }
                ++stats_.entered;
            } else if (s == SoldierState::Idle && P.stateTime[i] > 3.f && d >= 3.0f) {
                walkTo(ctx, i, ex);   // interrupted (threat stop) or arrived short: walk on
            }
            continue;
        }
        if (P.post[i] == POST_ENTERING) {
            enterT_[i] += dt;
            const int door = reg_.nearestEntrance(id, enterFrom_[i].x, enterFrom_[i].z);
            const Opening& o = B->openings[(size_t)std::max(0, door)];
            const float t = std::clamp(enterT_[i] / 1.8f, 0.f, 1.f);
            P.pos[i] = enterFrom_[i] + (o.pos - enterFrom_[i]) * t;   // walks into the door; then hidden inside
            P.vel[i] = {};
            if (enterT_[i] >= 2.2f) {
                if (hospitalTrip_[i]) {
                    P.post[i] = POST_INSIDE;
                    P.pos[i] = B->toWorld(B->stairU, B->stairV, B->y0);
                    B->patients.push_back(P.idOf(i));
                    ++stats_.admitted;
                } else {
                    const int k = firingSlotOf(*B, i, P);
                    if (k < 0) { release(ctx, i); continue; }
                    const FiringPosition& f = B->firing[(size_t)k];
                    P.post[i] = POST_FIRING;
                    P.pos[i] = f.pos;
                    P.yaw[i] = f.yaw;
                    P.home[i] = f.pos;
                    P.homeYaw[i] = f.yaw;
                    // firing point (SoldierPool::firePos = pos + postOut * 0.9): outside the facade / past the roof edge,
                    // so his own building never blocks his sight lines (window posts stand inside the room)
                    P.postOut[i] = V3{std::sin(f.yaw), 0, std::cos(f.yaw)} * (f.outReach / 0.9f);
                    ++stats_.posted;
                }
                P.setState(i, SoldierState::Idle);
                if (ctx.animator) ctx.animator->request(P.anim[i], AnimAction::Idle);
            }
            continue;
        }
        if (P.post[i] == POST_FIRING) {   // pinned at the window / roof edge, facing out within the arc
            const int k = firingSlotOf(*B, i, P);
            if (k < 0) { release(ctx, i); continue; }
            const FiringPosition& f = B->firing[(size_t)k];
            P.pos[i] = f.pos;
            P.vel[i] = {};
            const float off = wrapA(P.yaw[i] - f.yaw);
            if (std::fabs(off) > f.arcHalf) P.yaw[i] = wrapA(f.yaw + std::clamp(off, -f.arcHalf, f.arcHalf));
            // garrison ammo stack: an idle soldier refills his reserve (one magazine per second)
            const WeaponStats& w = ctx.cfg->weapon[(int)P.cls[i]];
            int& stock = ammo_[id.v];
            if (stock > 0 && P.state[i] == SoldierState::Idle && P.reserve[i] < w.reserve && (ctx.tick + i) % 30 == 0) {
                const int n = std::min({stock, w.reserve - P.reserve[i], w.magazine});
                P.reserve[i] += n; stock -= n; stats_.ammoIssued += n;
            }
        }
    }
}

void BuildingPlay::hospital(GameContext& ctx, float dt) {
    SoldierPool& P = *ctx.soldiers;
    const BuildingConfig& bc = ctx.cfg->buildings;
    for (uint32_t b = 0; b < (uint32_t)reg_.size(); ++b) {
        Building& B = *reg_.get(BuildingId{b});
        if (B.role != BuildingRole::Hospital || B.patients.empty()) continue;
        for (size_t k = 0; k < B.patients.size();) {
            const SoldierId s = B.patients[k];
            if (!P.valid(s) || !P.alive(s.index)) { B.patients.erase(B.patients.begin() + (long)k); continue; }
            const uint32_t i = s.index;
            const float before = P.health[i];
            P.health[i] = std::min(P.maxHealth[i], P.health[i] + bc.healRate * dt);
            stats_.healed += P.health[i] - before;
            if (P.health[i] >= bc.dischargeFraction * P.maxHealth[i]) {
                release(ctx, i);   // erases him from B.patients
                ++stats_.discharged;
                P.wounded[i] = 0;
                // back to the squad: its anchor (last order / landing point)
                const Squad* sq = ctx.squads ? ctx.squads->get(P.squad[i]) : nullptr;
                if (sq && sq->hasAnchor) walkTo(ctx, i, sq->anchor);
                notice("A soldier left the hospital and rejoins his squad", false);
                continue;
            }
            ++k;
        }
    }
}

void BuildingPlay::breachFallback(GameContext& ctx, float dt) {
    // CPU fallback until B3b drives breaching on the GPU: zombies from the coarse field at a barricaded door damage it
    if (!ctx.horde) return;
    const ZombieField& f = ctx.horde->field();
    if (!f.tilesX || f.tileSize <= 0.f) return;
    const BuildingConfig& bc = ctx.cfg->buildings;
    for (uint32_t b = 0; b < (uint32_t)reg_.size(); ++b) {
        Building& B = *reg_.get(BuildingId{b});
        if (B.zombiesInside >= 0) continue;   // B3b simulates this building
        for (size_t k = 0; k < B.openings.size(); ++k) {
            const Opening& o = B.openings[k];
            if (o.type != OpeningType::Door || o.open()) continue;
            const int ti = (int)std::floor((o.pos.x - f.originX) / f.tileSize), tj = (int)std::floor((o.pos.z - f.originZ) / f.tileSize);
            if (ti < 0 || tj < 0 || ti >= (int)f.tilesX || tj >= (int)f.tilesZ) continue;
            const ZombieFieldTile& t = f.tiles[(size_t)tj * f.tilesX + (size_t)ti];
            int n = 0;
            for (uint32_t s = 0; s < t.samples; ++s) n += d2D(t.pos[s], o.pos) < 1.6f ? 1 : 0;
            if (!n) continue;
            if (reg_.damageBarricade(BuildingId{b}, (uint16_t)k, (float)n * bc.breachDps * dt)) {
                ++stats_.breached;
                notice("A barricade was breached", true);
            }
        }
    }
}

void BuildingPlay::preCombat(const GameContext& ctx) {
    const SoldierPool& P = *ctx.soldiers;
    hpBefore_.resize(P.capacity());
    for (uint32_t i = 0; i < (uint32_t)P.capacity(); ++i) hpBefore_[i] = P.used[i] ? P.health[i] : 0.f;
}

void BuildingPlay::postCombat(GameContext& ctx) {
    SoldierPool& P = *ctx.soldiers;
    const float scale = ctx.cfg->buildings.nestDamageScale;
    for (uint32_t i = 0; i < (uint32_t)P.capacity() && i < hpBefore_.size(); ++i) {
        if (!P.used[i] || P.post[i] != POST_FIRING || P.health[i] >= hpBefore_[i]) continue;
        const Building* B = reg_.get(BuildingId{P.building[i]});
        const int k = B ? firingSlotOf(*B, i, P) : -1;
        if (k >= 0 && B->firing[(size_t)k].nest) P.health[i] = hpBefore_[i] - (hpBefore_[i] - P.health[i]) * scale;
    }
}

} // namespace ttz::game
