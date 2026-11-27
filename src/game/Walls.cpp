// Wall network, placement validation, joints, damage and breaches (Milestone B2). See Walls.h.
#include "game/Walls.h"

#include "game/Config.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
constexpr float kPieceLen = 4.f;        // approved straight / gate asset length
constexpr float kMinLeg = 2.5f;         // shorter legs would squash the asset below 0.63x
constexpr float kSnapNode = 1.5f;       // m: the cursor snaps to an existing node within this
constexpr float kSameNode = 0.3f;       // m: endpoints this close are the same node
constexpr float kMinJointDeg = 35.f;

float segDist(float ax, float az, float bx, float bz, float cx, float cz, float dx, float dz) {
    auto pointSeg = [](float px, float pz, float ax, float az, float bx, float bz) {
        const float ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz;
        float t = l2 > 1e-9f ? ((px - ax) * ux + (pz - az) * uz) / l2 : 0.f;
        t = std::clamp(t, 0.f, 1.f);
        const float qx = ax + ux * t - px, qz = az + uz * t - pz;
        return std::sqrt(qx * qx + qz * qz);
    };
    // proper intersection -> 0
    auto orient = [](float ax, float az, float bx, float bz, float cx, float cz) { return (bx - ax) * (cz - az) - (bz - az) * (cx - ax); };
    const float o1 = orient(ax, az, bx, bz, cx, cz), o2 = orient(ax, az, bx, bz, dx, dz), o3 = orient(cx, cz, dx, dz, ax, az), o4 = orient(cx, cz, dx, dz, bx, bz);
    if (((o1 > 0) != (o2 > 0)) && ((o3 > 0) != (o4 > 0)) && o1 != 0 && o2 != 0 && o3 != 0 && o4 != 0) return 0.f;
    return std::min(std::min(pointSeg(ax, az, cx, cz, dx, dz), pointSeg(bx, bz, cx, cz, dx, dz)),
                    std::min(pointSeg(cx, cz, ax, az, bx, bz), pointSeg(dx, dz, ax, az, bx, bz)));
}

Obb boxOf(float ax, float az, float bx, float bz, WallType t, float top) {
    Obb o;
    const float dx = bx - ax, dz = bz - az, len = std::sqrt(dx * dx + dz * dz);
    o.cx = 0.5f * (ax + bx); o.cz = 0.5f * (az + bz);
    o.hx = 0.5f * len;
    o.hz = 0.5f * Walls::width(t) * std::clamp(len / kPieceLen, 0.6f, 1.4f);
    o.yaw = std::atan2(-dz, dx);
    o.top = top;
    return o;
}

// angle (deg) between the directions from a shared joint to the two other ends
float jointAngle(float jx, float jz, float px, float pz, float qx, float qz) {
    const float ax = px - jx, az = pz - jz, bx = qx - jx, bz = qz - jz;
    const float la = std::sqrt(ax * ax + az * az), lb = std::sqrt(bx * bx + bz * bz);
    if (la < 1e-4f || lb < 1e-4f) return 180.f;
    return std::acos(std::clamp((ax * bx + az * bz) / (la * lb), -1.f, 1.f)) * 180.f / kPi;
}
} // namespace

void Walls::configure(const FortConfig& c) {
    for (int t = 0; t < 2; ++t) { height_[t] = c.wallHeight[(size_t)t]; health_[t] = c.wallHealth[(size_t)t]; price_[t] = c.wallPrice[(size_t)t]; }
    gateMul_ = c.gatePriceMul; dmgPerZombie_ = c.damagePerZombie; threshold_ = c.pressureThreshold; buildTime_ = c.buildTime;
}

int Walls::piecePrice(WallType t, bool gate) const { return (int)std::lround(price_[(size_t)t] * (gate ? gateMul_ : 1.f)); }

V3 Walls::snap(V3 p, const V3* from, bool fine, int& node) const {
    node = nearestNode(p.x, p.z, kSnapNode);
    if (node >= 0) return {nodes_[(size_t)node].x, nodes_[(size_t)node].y, nodes_[(size_t)node].z};
    if (from && !fine) {
        const float dx = p.x - from->x, dz = p.z - from->z, l = std::sqrt(dx * dx + dz * dz);
        if (l > 0.5f) {
            const float n = std::max(1.f, std::round(l / kPieceLen)), k = n * kPieceLen / l;
            return {from->x + dx * k, p.y, from->z + dz * k};
        }
    }
    return {std::round(p.x), p.y, std::round(p.z)};
}

int Walls::nearestNode(float x, float z, float maxR) const {
    int best = -1;
    float bd = maxR * maxR;
    for (size_t i = 0; i < nodes_.size(); ++i) {
        const WallNode& n = nodes_[i];
        if (!n.alive) continue;
        const float d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
        if (d <= bd) { bd = d; best = (int)i; }
    }
    return best;
}

int Walls::nearestPiece(float x, float z, float maxR) const {
    int best = -1;
    float bd = maxR;
    for (size_t i = 0; i < pieces_.size(); ++i) {
        const WallPiece& p = pieces_[i];
        if (!p.alive) continue;
        const WallNode &a = nodes_[p.a], &b = nodes_[p.b];
        const float d = segDist(a.x, a.z, b.x, b.z, x, z, x, z);
        if (d <= bd) { bd = d; best = (int)i; }
    }
    return best;
}

float Walls::pieceScale(uint32_t i) const {
    const WallPiece& p = pieces_[i];
    const WallNode &a = nodes_[p.a], &b = nodes_[p.b];
    return std::hypot(b.x - a.x, b.z - a.z) / kPieceLen;
}

Obb Walls::pieceBox(uint32_t i) const {
    const WallPiece& p = pieces_[i];
    const WallNode &a = nodes_[p.a], &b = nodes_[p.b];
    return boxOf(a.x, a.z, b.x, b.z, p.type, height_[(size_t)p.type]);
}

JointShape Walls::joint(uint32_t node, float& yaw, WallType& type) const {
    const WallNode& n = nodes_[node];
    float dir[8][2];
    int k = 0;
    type = WallType::Cheap;
    for (const WallPiece& p : pieces_) {
        if (!p.alive || (p.a != node && p.b != node)) continue;
        const WallNode& o = nodes_[p.a == node ? p.b : p.a];
        if (k < 8) { const float l = std::max(1e-4f, std::hypot(o.x - n.x, o.z - n.z)); dir[k][0] = (o.x - n.x) / l; dir[k][1] = (o.z - n.z) / l; }
        ++k;
        if (p.type == WallType::Reinforced) type = WallType::Reinforced;
    }
    yaw = 0.f;
    if (k == 0) return JointShape::None;
    if (k == 1) { yaw = std::atan2(dir[0][1], -dir[0][0]); return JointShape::End; }   // local -X towards the piece
    yaw = std::atan2(-dir[0][1], dir[0][0]);
    if (k == 2) {
        const float c = dir[0][0] * dir[1][0] + dir[0][1] * dir[1][1];
        return c < -std::cos(8.f * kPi / 180.f) ? JointShape::None : JointShape::Corner;
    }
    return k == 3 ? JointShape::T : JointShape::X;
}

Obb Walls::postBox(uint32_t node) const {
    float yaw;
    WallType t;
    joint(node, yaw, t);
    Obb o;
    o.cx = nodes_[node].x; o.cz = nodes_[node].z;
    o.hx = o.hz = 0.5f * postSize(t);
    o.yaw = yaw;
    o.top = height_[(size_t)t];
    return o;
}

WallPlan Walls::plan(const std::vector<V3>& pts, WallType type, bool gate, const WallEnv& env) const {
    WallPlan P;
    P.type = type; P.gate = gate;
    if (pts.size() < 2) { P.reason = "click to add points, double-click / Enter to confirm"; return P; }
    for (size_t k = 0; k + 1 < pts.size(); ++k) {
        const V3 A = pts[k], B = pts[k + 1];
        const float L = std::hypot(B.x - A.x, B.z - A.z);
        if (L < 1e-3f) continue;
        const int n = std::max(1, (int)std::lround(L / kPieceLen));
        for (int j = 0; j < n; ++j) {
            WallPlanPiece q;
            q.ax = A.x + (B.x - A.x) * (float)j / (float)n; q.az = A.z + (B.z - A.z) * (float)j / (float)n;
            q.bx = A.x + (B.x - A.x) * (float)(j + 1) / (float)n; q.bz = A.z + (B.z - A.z) * (float)(j + 1) / (float)n;
            q.nodeA = nearestNode(q.ax, q.az, kSameNode);
            q.nodeB = nearestNode(q.bx, q.bz, kSameNode);
            if (L < kMinLeg) { q.ok = false; q.why = "segment too short (min 2.5 m)"; }
            P.pieces.push_back(q);
        }
        P.length += L;
    }
    if (P.pieces.empty()) { P.reason = "drag or click a second point"; return P; }
    for (size_t i = 0; i < P.pieces.size(); ++i) {
        WallPlanPiece& q = P.pieces[i];
        const float len = std::hypot(q.bx - q.ax, q.bz - q.az);
        const Obb box = boxOf(q.ax, q.az, q.bx, q.bz, type, height_[(size_t)type]);
        const float wq = 2.f * box.hz;
        P.price += piecePrice(type, gate);
        if (!q.ok) continue;
        auto fail = [&](const char* why) { if (q.ok) { q.ok = false; q.why = why; } };
        if (q.nodeA >= 0 && q.nodeA == q.nodeB) { fail("segment too short (min 2.5 m)"); continue; }
        // footprint samples
        float gmin = 1e9f, gmax = -1e9f;
        std::vector<float> gs;
        bool outside = false, vehicle = false, container = false;
        const int nu = std::max(2, (int)std::ceil(len / 0.5f)), nv = 2;
        for (int a = 0; a <= nu; ++a)
            for (int b = 0; b <= nv; ++b) {
                float x, z;
                box.at(-box.hx + 2.f * box.hx * (float)a / (float)nu, -box.hz + 2.f * box.hz * (float)b / (float)nv, x, z);
                if (env.simulated && !env.simulated(x, z)) { outside = true; continue; }
                // the last 0.6 m at each end may overlap a building / vehicle edge: walls butt against facades
                if (std::fabs(-box.hx + 2.f * box.hx * (float)a / (float)nu) > box.hx - 0.6f) continue;
                const float g = env.ground ? env.ground(x, z) : 0.f;
                gmin = std::min(gmin, g); gmax = std::max(gmax, g);
                gs.push_back(g);
                if (env.solid && env.solid(x, z) - g > 0.4f) vehicle = true;
                for (const Obb& c : env.containers) if (c.contains(x, z, 0.15f)) container = true;
            }
        q.y = gmin < 1e8f ? gmin : 0.f;
        if (outside) { fail("outside the simulated area"); continue; }
        // a building / water / step blocks; a thin pole, bollard or tree in the line does not (the wall swallows it)
        int high = 0;
        for (float g : gs) high += g - gmin > 0.6f ? 1 : 0;
        if (high > 0 && (float)high > 0.2f * (float)gs.size()) { fail("blocked by a building, water or a steep step"); continue; }
        if (vehicle) { fail("a vehicle is in the way"); continue; }
        if (container) { fail("overlaps a supply container"); continue; }
        // existing pieces and posts
        for (size_t e = 0; e < pieces_.size() && q.ok; ++e) {
            const WallPiece& p = pieces_[e];
            if (!p.alive) continue;
            const WallNode &na = nodes_[p.a], &nb = nodes_[p.b];
            const int shared = (q.nodeA >= 0 && ((uint32_t)q.nodeA == p.a || (uint32_t)q.nodeA == p.b)) ? q.nodeA
                             : (q.nodeB >= 0 && ((uint32_t)q.nodeB == p.a || (uint32_t)q.nodeB == p.b)) ? q.nodeB : -1;
            if (q.nodeA >= 0 && q.nodeB >= 0 && ((p.a == (uint32_t)q.nodeA && p.b == (uint32_t)q.nodeB) || (p.b == (uint32_t)q.nodeA && p.a == (uint32_t)q.nodeB))) { fail("a wall is already there"); break; }
            if (shared >= 0) {
                const WallNode& j = nodes_[(size_t)shared];
                const WallNode& other = nodes_[p.a == (uint32_t)shared ? p.b : p.a];
                const bool atA = shared == q.nodeA;
                if (jointAngle(j.x, j.z, atA ? q.bx : q.ax, atA ? q.bz : q.az, other.x, other.z) < kMinJointDeg) fail("joint angle too sharp");
                continue;
            }
            const float wp = width(p.type) * std::clamp(pieceScale((uint32_t)e), 0.6f, 1.4f);
            if (segDist(q.ax, q.az, q.bx, q.bz, na.x, na.z, nb.x, nb.z) < 0.5f * (wq + wp) * 0.95f) fail("overlaps a wall");
        }
        for (size_t nIdx = 0; nIdx < nodes_.size() && q.ok; ++nIdx) {
            const WallNode& nd = nodes_[nIdx];
            if (!nd.alive || (int)nIdx == q.nodeA || (int)nIdx == q.nodeB) continue;
            if (segDist(q.ax, q.az, q.bx, q.bz, nd.x, nd.z, nd.x, nd.z) < 0.5f * (wq + postSize(type)) * 0.95f) fail("overlaps a wall joint");
        }
        // earlier pieces of this plan
        for (size_t e = 0; e < i && q.ok; ++e) {
            const WallPlanPiece& o = P.pieces[e];
            auto same = [](float x0, float z0, float x1, float z1) { return std::fabs(x0 - x1) + std::fabs(z0 - z1) < 0.05f; };
            const bool sAA = same(q.ax, q.az, o.ax, o.az), sAB = same(q.ax, q.az, o.bx, o.bz), sBA = same(q.bx, q.bz, o.ax, o.az), sBB = same(q.bx, q.bz, o.bx, o.bz);
            if ((sAA && sBB) || (sAB && sBA)) { fail("overlaps itself"); break; }
            if (sAA || sAB || sBA || sBB) {
                const float jx = (sAA || sAB) ? q.ax : q.bx, jz = (sAA || sAB) ? q.az : q.bz;
                const float px = (sAA || sAB) ? q.bx : q.ax, pz = (sAA || sAB) ? q.bz : q.az;
                const float ox = (sAA || sBA) ? o.bx : o.ax, oz = (sAA || sBA) ? o.bz : o.az;
                if (jointAngle(jx, jz, px, pz, ox, oz) < kMinJointDeg) fail("joint angle too sharp");
                continue;
            }
            if (segDist(q.ax, q.az, q.bx, q.bz, o.ax, o.az, o.bx, o.bz) < wq * 0.95f) fail("overlaps itself");
        }
    }
    P.valid = true;
    P.reason = "";
    for (const WallPlanPiece& q : P.pieces)
        if (!q.ok) { P.valid = false; P.reason = q.why; break; }
    return P;
}

uint32_t Walls::addNode(float x, float z, float y) {
    for (uint32_t i = 0; i < nodes_.size(); ++i)
        if (!nodes_[i].alive && nodes_[i].obstacle == ~0u) { nodes_[i] = WallNode{x, z, y, 0, true, ~0u}; return i; }
    nodes_.push_back(WallNode{x, z, y, 0, true, ~0u});
    return (uint32_t)nodes_.size() - 1;
}

std::vector<uint32_t> Walls::commit(const WallPlan& plan) {
    std::vector<uint32_t> added;
    if (!plan.valid) return added;
    for (const WallPlanPiece& q : plan.pieces) {
        auto nodeFor = [&](int snapped, float x, float z) -> uint32_t {
            if (snapped >= 0 && nodes_[(size_t)snapped].alive) return (uint32_t)snapped;
            const int n = nearestNode(x, z, kSameNode);
            return n >= 0 ? (uint32_t)n : addNode(x, z, q.y);
        };
        const uint32_t a = nodeFor(q.nodeA, q.ax, q.az), b = nodeFor(q.nodeB, q.bx, q.bz);
        if (a == b) continue;
        WallPiece p;
        p.a = a; p.b = b;
        p.type = plan.type; p.gate = plan.gate;
        p.alive = true;
        p.hp = p.maxHp = health_[(size_t)plan.type];
        uint32_t idx = (uint32_t)pieces_.size();
        for (uint32_t i = 0; i < pieces_.size(); ++i)
            if (!pieces_[i].alive && pieces_[i].obstacle == ~0u) { idx = i; break; }
        if (idx == pieces_.size()) pieces_.push_back(p);
        else { p.gen = pieces_[idx].gen + 1; pieces_[idx] = p; }
        ++nodes_[a].degree; ++nodes_[b].degree;
        added.push_back(idx);
        // rubble under the new piece is cleared
        const Obb box = pieceBox(idx);
        rubble_.erase(std::remove_if(rubble_.begin(), rubble_.end(), [&](const WallRubble& r) { return box.contains(r.box.cx, r.box.cz, -0.5f); }), rubble_.end());
    }
    changed_ = changed_ || !added.empty();
    return added;
}

void Walls::detach(uint32_t node) {
    WallNode& n = nodes_[node];
    if (n.degree) --n.degree;
    if (!n.degree) n.alive = false;   // GameWorld removes its post obstacle (obstacle id stays set until then)
}

void Walls::damage(uint32_t i, float hp) {
    if (i >= pieces_.size() || !pieces_[i].alive || hp <= 0) return;
    WallPiece& p = pieces_[i];
    p.hp -= hp;
    if (p.hp <= 0.f) destroy(i);
}

void Walls::addPressure(uint32_t i, float zombies, float dt) {
    if (i >= pieces_.size() || !pieces_[i].alive) return;
    WallPiece& p = pieces_[i];
    p.pressure = zombies;
    const float excess = std::max(0.f, zombies - (float)threshold_);
    const float rate = excess * dmgPerZombie_;
    p.damageRate = rate;
    if (rate > 0.f) damage(i, rate * dt);
}

bool Walls::destroy(uint32_t i) {
    if (i >= pieces_.size() || !pieces_[i].alive) return false;
    WallPiece& p = pieces_[i];
    const Obb box = pieceBox(i);
    p.alive = false;
    p.hp = 0;
    const float y = 0.5f * (nodes_[p.a].y + nodes_[p.b].y);
    rubble_.push_back({box, p.type, p.gate, y, 0.f});
    if (rubble_.size() > 512) rubble_.erase(rubble_.begin());
    detach(p.a);
    detach(p.b);
    destroyed_.push_back({i, box.cx, y, box.cz, box});
    changed_ = true;
    return true;
}

void Walls::tick(float dt, const std::function<bool(float, float, float)>& soldierNear) {
    for (size_t i = 0; i < pieces_.size(); ++i) {
        WallPiece& p = pieces_[i];
        if (!p.alive) continue;
        p.age += dt;
        p.damageRate *= std::exp(-dt * 0.5f);
        if (p.gate) {
            const Obb b = pieceBox((uint32_t)i);
            const bool open = soldierNear && soldierNear(b.cx, b.cz, 5.f);
            p.gateOpen = std::clamp(p.gateOpen + (open ? dt : -dt) / 1.2f, 0.f, 1.f);
        }
    }
    for (WallRubble& r : rubble_) r.t += dt;
}

uint32_t Walls::alivePieces() const { uint32_t n = 0; for (const WallPiece& p : pieces_) n += p.alive ? 1 : 0; return n; }
uint32_t Walls::aliveGates() const { uint32_t n = 0; for (const WallPiece& p : pieces_) n += p.alive && p.gate ? 1 : 0; return n; }
float Walls::totalLength() const {
    float l = 0;
    for (const WallPiece& p : pieces_) if (p.alive) l += std::hypot(nodes_[p.b].x - nodes_[p.a].x, nodes_[p.b].z - nodes_[p.a].z);
    return l;
}

} // namespace ttz::game
