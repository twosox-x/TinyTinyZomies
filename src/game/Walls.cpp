// Wall network, placement validation, joints, damage and breaches (Milestone B2). See Walls.h.
#include "game/Walls.h"

#include "game/Config.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
constexpr float kPieceLen = 4.f;        // approved straight / gate asset length
constexpr float kMinLeg = 0.5f;         // shortest piece (a filler basket closes a 0.5 m gap; GAME_DESIGN 14e finer grid)
constexpr float kSplitEnd = 1.0f;       // m: a mid-piece snap keeps at least this much of the piece on both sides
constexpr float kBuildingRise = 2.0f;   // m above the street: a building / water (facade trimming)
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
    o.hz = 0.5f * Walls::width(t) * std::clamp(len / kPieceLen, 1.0f, 1.4f);   // short pieces: full-width baskets
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
int Walls::piecePrice(WallType t, bool gate, float len) const {
    if (gate) return piecePrice(t, true);
    return std::max(1, (int)std::lround(price_[(size_t)t] * std::clamp(len / kPieceLen, 0.25f, 1.f)));
}

int Walls::pieceAt(float x, float z, float tol) const {
    int best = -1;
    float bd = tol;
    for (size_t i = 0; i < pieces_.size(); ++i) {
        const WallPiece& p = pieces_[i];
        if (!p.alive) continue;
        const WallNode &a = nodes_[p.a], &b = nodes_[p.b];
        const float d = segDist(a.x, a.z, b.x, b.z, x, z, x, z);
        if (d > bd || std::hypot(x - a.x, z - a.z) < kSplitEnd - 0.05f || std::hypot(x - b.x, z - b.z) < kSplitEnd - 0.05f) continue;
        bd = d; best = (int)i;
    }
    return best;
}

V3 Walls::snap(V3 p, const V3* from, bool fine, int& node, int* piece) const {
    if (piece) *piece = -1;
    node = nearestNode(p.x, p.z, kSnapNode);
    if (node >= 0) return {nodes_[(size_t)node].x, nodes_[(size_t)node].y, nodes_[(size_t)node].z};
    // onto an existing piece (T junction anywhere along it: the piece is split there on commit)
    {
        const int e = nearestPiece(p.x, p.z, 1.2f);
        if (e >= 0) {
            const WallNode &a = nodes_[pieces_[(size_t)e].a], &b = nodes_[pieces_[(size_t)e].b];
            const float ux = b.x - a.x, uz = b.z - a.z, L = std::max(1e-3f, std::hypot(ux, uz));
            float t = ((p.x - a.x) * ux + (p.z - a.z) * uz) / L;
            t = std::round(t * 2.f) * 0.5f;   // 0.5 m steps along the piece
            if (t < kSplitEnd || t > L - kSplitEnd) {   // near an end: that joint
                node = t < 0.5f * L ? (int)pieces_[(size_t)e].a : (int)pieces_[(size_t)e].b;
                const WallNode& n = nodes_[(size_t)node];
                return {n.x, n.y, n.z};
            }
            if (piece) *piece = e;
            return {a.x + ux * t / L, p.y, a.z + uz * t / L};
        }
    }
    if (from) {
        const float dx = p.x - from->x, dz = p.z - from->z, l = std::sqrt(dx * dx + dz * dz);
        if (l > 0.5f) {
            const float step = fine ? Walls::kGrid : kPieceLen;
            const float n = std::max(1.f, std::round(l / step)), k = n * step / l;
            return {from->x + dx * k, p.y, from->z + dz * k};
        }
    }
    return {std::round(p.x / kGrid) * kGrid, p.y, std::round(p.z / kGrid) * kGrid};
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
        if (!p.solid() || (p.a != node && p.b != node)) continue;   // joints of finished pieces only
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

WallPlan Walls::plan(const std::vector<V3>& ptsIn, WallType type, bool gate, const WallEnv& env) const {
    WallPlan P;
    P.type = type; P.gate = gate;
    if (ptsIn.size() < 2) { P.reason = "click to add points, double-click / Enter to confirm"; return P; }
    // Sealing (GAME_DESIGN 14e: walls meet facades with no gap): a free end inside a building, or within kSealReach in
    // front of a facade / a container / a wall piece along the run, is moved onto it (see Walls.h).
    std::vector<V3> pts = ptsIn;
    auto inBuilding = [&](float x, float z) { return env.ground && env.ground(x, z) - env.streetY > kBuildingRise; };
    auto vehicleAt = [&](float x, float z) {
        if (!env.solid || !env.ground || env.solid(x, z) - env.ground(x, z) <= 0.4f) return false;
        for (const Obb& c : env.clearing) if (c.contains(x, z, -0.3f)) return false;
        return true;
    };
    // ray (ox, oz) + t d vs an oriented box: entry distance (0 when starting inside), < 0 when missed within maxT
    auto rayBox = [](const Obb& o, float ox, float oz, float dx, float dz, float maxT) {
        const float c = std::cos(o.yaw), sn = std::sin(o.yaw);
        const float px = ox - o.cx, pz = oz - o.cz;
        const float u0 = px * c - pz * sn, v0 = px * sn + pz * c, du = dx * c - dz * sn, dv = dx * sn + dz * c;
        float t0 = 0.f, t1 = maxT;
        for (int k = 0; k < 2; ++k) {
            const float p0 = k ? v0 : u0, d = k ? dv : du, h = k ? o.hz : o.hx;
            if (std::fabs(d) < 1e-6f) { if (std::fabs(p0) > h) return -1.f; continue; }
            float a = (-h - p0) / d, b = (h - p0) / d;
            if (a > b) std::swap(a, b);
            t0 = std::max(t0, a); t1 = std::min(t1, b);
            if (t0 > t1) return -1.f;
        }
        return t0;
    };
    // facade distance along the leg from `other` (unit d towards the end): exact record footprint near the height
    // grid's facade tg when there is one, else a little behind the grid edge (the grid over-covers buildings)
    auto facadeAt = [&](const V3& other, float dx, float dz, float tg) {
        if (env.facadeRay) {
            const float te = env.facadeRay(other.x, other.z, dx, dz, other.x + dx * (tg + 0.4f), other.z + dz * (tg + 0.4f));
            if (te >= tg - 0.25f && te <= tg + 1.2f) return te;
        }
        return tg + 0.3f;
    };
    auto seal = [&](V3& end, const V3& other, uint8_t& kind, float& allow) {
        if (nearestNode(end.x, end.z, kSameNode) >= 0 || pieceAt(end.x, end.z, 0.3f) >= 0) return;   // already a joint / T
        {   // 0. a wall joint right next to the end (end-to-end runs): onto it
            const int nn = nearestNode(end.x, end.z, 1.0f);
            if (nn >= 0) { end = {nodes_[(size_t)nn].x, end.y, nodes_[(size_t)nn].z}; kind = 3; P.trimmed = true; return; }
        }
        const float ex = end.x - other.x, ez = end.z - other.z, L = std::hypot(ex, ez);
        if (L < 0.3f) return;
        const float dx = ex / L, dz = ez / L;
        if (inBuilding(other.x, other.z)) return;
        float best = -1.f;   // new length of the leg from `other`
        uint8_t bestKind = 0;
        float bestAllow = 0.6f;
        // 1. facade: the end is inside a building (pulled back) or a facade is within reach in front of it
        {
            float tg = -1.f;
            if (inBuilding(end.x, end.z)) {
                for (float t = 0.f; t < L; t += 0.1f)
                    if (inBuilding(other.x + dx * t, other.z + dz * t)) { tg = t; break; }
            } else {
                for (float t = L; t <= L + kSealReach; t += 0.1f) {
                    if (vehicleAt(other.x + dx * t, other.z + dz * t)) break;   // a car in between: not this facade
                    if (inBuilding(other.x + dx * t, other.z + dz * t)) { tg = t; break; }
                }
            }
            if (tg > 0.f) {
                const float f = facadeAt(other, dx, dz, tg);
                best = f + kSealDepth;
                bestKind = 1;
                bestAllow = best - tg + 0.9f;   // the grid's building cells between its edge and the sealed end
            }
        }
        // 2. a supply container in front of (or under) the end
        for (const Obb& c : env.containers) {
            const float te = rayBox(c, other.x, other.z, dx, dz, L + kSealReach);
            if (te <= 0.f || te < L - 6.f) continue;   // starts inside it / far behind the end: not a seal
            const float nl = te + kSealDepth;
            if (best < 0.f || nl < best) { best = nl; bestKind = 2; bestAllow = kSealDepth + 0.3f; }
        }
        // 3. an existing wall piece across the run in front of the end: onto its axis (T junction / its joint)
        for (size_t e = 0; e < pieces_.size(); ++e) {
            const WallPiece& p = pieces_[e];
            if (!p.alive) continue;
            const WallNode &na = nodes_[p.a], &nb = nodes_[p.b];
            const float sx = nb.x - na.x, sz = nb.z - na.z, den = dx * sz - dz * sx;
            if (std::fabs(den) < 0.2f * std::hypot(sx, sz)) continue;   // (nearly) parallel
            const float wx = na.x - other.x, wz = na.z - other.z;
            const float t = (wx * sz - wz * sx) / den, sp = (wx * dz - wz * dx) / den;
            if (t < L - 0.6f || t > L + kSealReach || sp < 0.f || sp > 1.f) continue;   // overshoots up to 0.6 m pull back
            if (best >= 0.f && t > best) continue;
            best = t; bestKind = 3; bestAllow = 0.6f;
        }
        if (bestKind == 0) return;
        V3 n{other.x + dx * best, end.y, other.z + dz * best};
        if (bestKind == 3) {   // near a joint of that piece: onto the joint
            const int nn = nearestNode(n.x, n.z, kSplitEnd);
            if (nn >= 0) n = {nodes_[(size_t)nn].x, end.y, nodes_[(size_t)nn].z};
        }
        end = n;
        kind = bestKind;
        allow = bestAllow;
        P.trimmed = true;
    };
    const bool loop = pts.size() > 2 && std::hypot(pts.front().x - pts.back().x, pts.front().z - pts.back().z) < 0.05f;
    if (!loop) seal(pts.front(), pts[1], P.sealFront, P.allowFront);
    if (!loop)
    seal(pts.back(), pts[pts.size() - 2], P.sealBack, P.allowBack);
    // connectivity of the existing network (loop closure): union-find over nodes, new points get ids after them
    std::vector<int> uf(nodes_.size());
    for (size_t i = 0; i < uf.size(); ++i) uf[i] = (int)i;
    std::function<int(int)> find = [&](int x) { while (uf[(size_t)x] != x) { uf[(size_t)x] = uf[(size_t)uf[(size_t)x]]; x = uf[(size_t)x]; } return x; };
    auto unite = [&](int a, int b) { a = find(a); b = find(b); if (a != b) uf[(size_t)a] = b; return a != b; };
    for (const WallPiece& p : pieces_) if (p.alive) unite((int)p.a, (int)p.b);
    std::vector<std::pair<float, float>> fresh;   // positions of new points (ids nodes_.size() + k)
    auto idOf = [&](float x, float z, int node, int split) {
        if (node >= 0) return find(node);
        if (split >= 0) return find((int)pieces_[(size_t)split].a);
        for (size_t k = 0; k < fresh.size(); ++k)
            if (std::fabs(fresh[k].first - x) + std::fabs(fresh[k].second - z) < 0.05f) return find((int)(nodes_.size() + k));
        fresh.push_back({x, z});
        uf.push_back((int)uf.size());
        return (int)uf.size() - 1;
    };
    for (size_t k = 0; k + 1 < pts.size(); ++k) {
        const V3 A = pts[k], B = pts[k + 1];
        const float L = std::hypot(B.x - A.x, B.z - A.z);
        if (L < 1e-3f) continue;
        // cuts along the leg: walls = whole 4 m pieces + an auto-fill end piece (>= 1 m), gates = n equal pieces
        std::vector<float> cut{0.f};
        if (gate) {
            const int n = std::max(1, (int)std::lround(L / kPieceLen));
            for (int j = 1; j <= n; ++j) cut.push_back(L * (float)j / (float)n);
        } else {
            // whole 4 m pieces + one filler piece for the remainder (>= 0.5 m: 0.5 m granularity, GAME_DESIGN 14e); a
            // smaller remainder stretches the 4 m pieces (at most 12 %). The filler sits at the sealed end (facade /
            // container / wall) when only the start is free, else at the end of the leg.
            const int n4 = (int)std::floor(L / kPieceLen + 1e-3f);
            const float r = L - kPieceLen * (float)n4;
            const bool fillFirst = k == 0 && P.sealFront && !(k + 2 == pts.size() && P.sealBack);
            if (n4 == 0) cut.push_back(L);
            else if (r < kMinLeg) for (int j = 1; j <= n4; ++j) cut.push_back(L * (float)j / (float)n4);
            else if (fillFirst) { cut.push_back(r); for (int j = 1; j <= n4; ++j) cut.push_back(r + kPieceLen * (float)j); }
            else { for (int j = 1; j <= n4; ++j) cut.push_back(kPieceLen * (float)j); cut.push_back(L); }
        }
        for (size_t j = 0; j + 1 < cut.size(); ++j) {
            WallPlanPiece q;
            const float t0 = cut[j] / L, t1 = cut[j + 1] / L;
            q.ax = A.x + (B.x - A.x) * t0; q.az = A.z + (B.z - A.z) * t0;
            q.bx = A.x + (B.x - A.x) * t1; q.bz = A.z + (B.z - A.z) * t1;
            q.nodeA = nearestNode(q.ax, q.az, kSameNode);
            q.nodeB = nearestNode(q.bx, q.bz, kSameNode);
            if (q.nodeA < 0) q.splitA = pieceAt(q.ax, q.az, 0.3f);
            if (q.nodeB < 0) q.splitB = pieceAt(q.bx, q.bz, 0.3f);
            q.fill = !gate && cut[j + 1] - cut[j] < kPieceLen - 0.5f;
            if (L < kMinLeg - 1e-3f) { q.ok = false; q.why = "segment too short (min 0.5 m)"; }
            q.closesLoop = !unite(idOf(q.ax, q.az, q.nodeA, q.splitA), idOf(q.bx, q.bz, q.nodeB, q.splitB));
            P.closesLoop |= q.closesLoop;
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
        q.price = piecePrice(type, gate, len);
        P.price += q.price;
        if (!q.ok) continue;
        auto fail = [&](const char* why) { if (q.ok) { q.ok = false; q.why = why; } };
        if (q.nodeA >= 0 && q.nodeA == q.nodeB) { fail("segment too short (min 0.5 m)"); continue; }
        if (env.buildable && (!env.buildable(q.ax, q.az) || !env.buildable(q.bx, q.bz))) { fail("outside engineer range"); continue; }
        // footprint samples
        float gmin = 1e9f, gmax = -1e9f, gall = 1e9f;
        std::vector<float> gs;
        // the run's sealed ends may overlap the facade / container they were sealed onto (allowFront / allowBack)
        const float allowA = i == 0 ? P.allowFront : 0.6f, allowB = i + 1 == P.pieces.size() ? P.allowBack : 0.6f;
        bool outside = false, vehicle = false, container = false, clearing = false;
        const int nu = std::max(2, (int)std::ceil(len / 0.5f)), nv = 2;
        for (int a = 0; a <= nu; ++a)
            for (int b = 0; b <= nv; ++b) {
                float x, z;
                box.at(-box.hx + 2.f * box.hx * (float)a / (float)nu, -box.hz + 2.f * box.hz * (float)b / (float)nv, x, z);
                if (env.simulated && !env.simulated(x, z)) { outside = true; continue; }
                // the last 0.6 m at each end may overlap a building / vehicle edge: walls butt against facades
                const float u = -box.hx + 2.f * box.hx * (float)a / (float)nu;
                const float g = env.ground ? env.ground(x, z) : 0.f;
                gall = std::min(gall, g);
                if (box.hx + u < allowA || box.hx - u < allowB) continue;
                gmin = std::min(gmin, g); gmax = std::max(gmax, g);
                gs.push_back(g);
                if (env.solid && env.solid(x, z) - g > 0.4f) {
                    bool cleared = false;
                    for (const Obb& c : env.clearing) cleared |= c.contains(x, z, -0.3f);
                    if (cleared) clearing = true;
                    else vehicle = true;
                }
                for (const Obb& c : env.containers) if (c.contains(x, z, 0.15f)) container = true;
            }
        q.y = gmin < 1e8f ? gmin : gall < 1e8f ? gall : 0.f;
        q.clearing = clearing;
        if (outside) { fail("outside the simulated area"); continue; }
        // a building / water / step blocks; a thin pole, bollard or tree in the line does not (the wall swallows it)
        int high = 0, tall = 0;
        const float ref = std::min(gmin, env.streetY + 0.3f);
        for (float g : gs) { high += g - ref > 0.6f ? 1 : 0; tall += g - ref > kBuildingRise ? 1 : 0; }
        if (high > 0 && (float)high > 0.2f * (float)gs.size()) { fail(tall * 2 >= high ? "a building or water is in the way" : "kerb or step too high"); continue; }
        if (vehicle) { fail("a vehicle is in the way (engineers can clear it)"); continue; }
        if (container) { fail("a supply container is in the way"); continue; }
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
            const bool onA = q.splitA == (int)e, onB = q.splitB == (int)e;
            if (onA && onB) { fail("a wall is already there"); break; }
            if (onA || onB) {   // T junction onto this piece: angle against both halves
                const float jx = onA ? q.ax : q.bx, jz = onA ? q.az : q.bz, ox = onA ? q.bx : q.ax, oz = onA ? q.bz : q.az;
                if (jointAngle(jx, jz, ox, oz, na.x, na.z) < kMinJointDeg || jointAngle(jx, jz, ox, oz, nb.x, nb.z) < kMinJointDeg) fail("joint angle too sharp");
                continue;
            }
            const float wp = width(p.type) * std::clamp(pieceScale((uint32_t)e), 1.0f, 1.4f);
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
            if (e + 2 == i && std::hypot(P.pieces[e + 1].bx - P.pieces[e + 1].ax, P.pieces[e + 1].bz - P.pieces[e + 1].az) < 2.f * wq) continue;   // around a short piece
            if (segDist(q.ax, q.az, q.bx, q.bz, o.ax, o.az, o.bx, o.bz) < wq * 0.95f) fail("overlaps itself");
        }
    }
    P.valid = true;
    P.reason = "";
    for (const WallPlanPiece& q : P.pieces)
        if (!q.ok) { P.valid = false; P.reason = q.why; break; }
    return P;
}

WallPlan Walls::planGate(V3 c, float yaw, WallType type, const WallEnv& env) const {
    // 1. over an existing wall piece: aligned to it, that part of the piece becomes the gate
    const int e = nearestPiece(c.x, c.z, 1.5f);
    if (e >= 0 && !pieces_[(size_t)e].gate) {
        const WallPiece& p = pieces_[(size_t)e];
        const WallNode &a = nodes_[p.a], &b = nodes_[p.b];
        const float ux = b.x - a.x, uz = b.z - a.z, L = std::max(1e-3f, std::hypot(ux, uz));
        WallPlan P;
        P.type = p.type; P.gate = true;
        P.replacePiece = e;
        WallPlanPiece q;
        if (L <= kPieceLen + 1.5f) {   // the whole piece
            q.ax = a.x; q.az = a.z; q.bx = b.x; q.bz = b.z; q.nodeA = (int)p.a; q.nodeB = (int)p.b;
        } else {
            float t = ((c.x - a.x) * ux + (c.z - a.z) * uz) / L;
            t = std::clamp(std::round(t * 2.f) * 0.5f, 0.5f * kPieceLen, L - 0.5f * kPieceLen);
            float t0 = t - 0.5f * kPieceLen, t1 = t + 0.5f * kPieceLen;
            if (t0 < kSplitEnd) { t0 = 0.f; t1 = kPieceLen; }                       // no sliver next to a joint
            if (L - t1 < kSplitEnd) { t1 = L; t0 = std::max(0.f, L - kPieceLen); }
            q.ax = a.x + ux * t0 / L; q.az = a.z + uz * t0 / L; q.bx = a.x + ux * t1 / L; q.bz = a.z + uz * t1 / L;
            q.nodeA = t0 <= 0.f ? (int)p.a : -1; q.nodeB = t1 >= L ? (int)p.b : -1;
            q.splitA = q.nodeA < 0 ? e : -1; q.splitB = q.nodeB < 0 ? e : -1;
        }
        q.y = std::min(a.y, b.y);
        q.price = piecePrice(p.type, true);
        if (env.buildable && !env.buildable(0.5f * (q.ax + q.bx), 0.5f * (q.az + q.bz))) { q.ok = false; q.why = "outside engineer range"; }
        P.price = q.price;
        P.length = std::hypot(q.bx - q.ax, q.bz - q.az);
        P.pieces.push_back(q);
        P.valid = q.ok;
        P.reason = q.ok ? "" : q.why;
        return P;
    }
    if (e >= 0) { WallPlan P; P.gate = true; P.type = type; P.reason = "a gate is already there"; return P; }
    // 2. an end on an existing joint (within 1.2 m): connect there (both ends: between the two joints)
    float dx = std::cos(yaw), dz = -std::sin(yaw);
    V3 A{c.x - dx * 0.5f * kPieceLen, c.y, c.z - dz * 0.5f * kPieceLen}, B{c.x + dx * 0.5f * kPieceLen, c.y, c.z + dz * 0.5f * kPieceLen};
    const int na = nearestNode(A.x, A.z, 1.2f), nb = nearestNode(B.x, B.z, 1.2f);
    auto at = [&](int n) { return V3{nodes_[(size_t)n].x, nodes_[(size_t)n].y, nodes_[(size_t)n].z}; };
    if (na >= 0 && nb >= 0 && na != nb) { A = at(na); B = at(nb); }
    else if (na >= 0) { const V3 n = at(na); B = {B.x + n.x - A.x, B.y, B.z + n.z - A.z}; A = n; }
    else if (nb >= 0) { const V3 n = at(nb); A = {A.x + n.x - B.x, A.y, A.z + n.z - B.z}; B = n; }
    else {   // 3. next to a wall end (within 2.5 m): continue that wall
        int best = -1;
        float bd = 2.5f;
        for (size_t i = 0; i < nodes_.size(); ++i) {
            const WallNode& n = nodes_[i];
            if (!n.alive || n.degree != 1) continue;
            const float d = std::min(std::hypot(n.x - A.x, n.z - A.z), std::hypot(n.x - B.x, n.z - B.z));
            if (d < bd) { bd = d; best = (int)i; }
        }
        if (best >= 0) {
            const WallNode& n = nodes_[(size_t)best];
            for (const WallPiece& p : pieces_)
                if (p.alive && (p.a == (uint32_t)best || p.b == (uint32_t)best)) {
                    const WallNode& o = nodes_[p.a == (uint32_t)best ? p.b : p.a];
                    const float l = std::max(1e-3f, std::hypot(n.x - o.x, n.z - o.z));
                    dx = (n.x - o.x) / l; dz = (n.z - o.z) / l;
                    if (p.type == WallType::Reinforced) type = WallType::Reinforced;
                    break;
                }
            A = {n.x, n.y, n.z};
            B = {n.x + dx * kPieceLen, c.y, n.z + dz * kPieceLen};
            const int nb2 = nearestNode(B.x, B.z, 1.f);
            if (nb2 >= 0) B = at(nb2);
        }
        // 4. otherwise on its own (end posts)
    }
    return plan({A, B}, type, true, env);
}

uint32_t Walls::addNode(float x, float z, float y) {
    for (uint32_t i = 0; i < nodes_.size(); ++i)
        if (!nodes_[i].alive && nodes_[i].obstacle == ~0u) { nodes_[i] = WallNode{}; nodes_[i].x = x; nodes_[i].z = z; nodes_[i].y = y; nodes_[i].alive = true; return i; }
    WallNode n;
    n.x = x; n.z = z; n.y = y; n.alive = true;
    nodes_.push_back(n);
    return (uint32_t)nodes_.size() - 1;
}

uint32_t Walls::splitAt(float x, float z, float y) {
    const int nn = nearestNode(x, z, kSameNode);
    if (nn >= 0) return (uint32_t)nn;
    const int e = pieceAt(x, z, 0.35f);
    if (e < 0) return addNode(x, z, y);
    const WallNode &a = nodes_[pieces_[(size_t)e].a], &b = nodes_[pieces_[(size_t)e].b];
    const float ux = b.x - a.x, uz = b.z - a.z, L2 = std::max(1e-6f, ux * ux + uz * uz);
    const float t = std::clamp(((x - a.x) * ux + (z - a.z) * uz) / L2, 0.f, 1.f);
    const uint32_t n = addNode(a.x + ux * t, a.z + uz * t, a.y + (b.y - a.y) * t);   // may reallocate nodes_
    WallPiece second = pieces_[(size_t)e];   // n -> b
    WallPiece& first = pieces_[(size_t)e];   // a -> n (keeps its index and obstacle id; re-stamped)
    second.a = n;
    second.obstacle = ~0u;
    second.restamp = false;
    second.price = (int)std::lround(first.price * (1.f - t));
    first.price -= second.price;
    first.b = n;
    first.restamp = first.obstacle != ~0u;
    nodes_[n].degree = 2;
    nodes_[n].solidDeg = first.solid() ? 2 : 0;
    uint32_t idx = (uint32_t)pieces_.size();
    for (uint32_t i = 0; i < pieces_.size(); ++i)
        if (!pieces_[i].alive && pieces_[i].obstacle == ~0u) { idx = i; break; }
    if (idx == pieces_.size()) pieces_.push_back(second);
    else { second.gen = pieces_[idx].gen + 1; pieces_[idx] = second; }
    changed_ = true;
    return n;
}

std::vector<uint32_t> Walls::commit(const WallPlan& plan, bool instant) {
    std::vector<uint32_t> added;
    if (!plan.valid) return added;
    ++batch_;
    if (plan.replacePiece >= 0 && plan.pieces.size() == 1) {   // gate placed into a wall piece
        const WallPlanPiece& q = plan.pieces[0];
        const uint32_t a = q.nodeA >= 0 ? (uint32_t)q.nodeA : splitAt(q.ax, q.az, q.y);
        const uint32_t b = q.nodeB >= 0 ? (uint32_t)q.nodeB : splitAt(q.bx, q.bz, q.y);
        for (uint32_t i = 0; i < pieces_.size(); ++i) {
            WallPiece& p = pieces_[i];
            if (!p.alive || !((p.a == a && p.b == b) || (p.a == b && p.b == a))) continue;
            p.batch = batch_;
            p.price += q.price;
            if (instant || !p.solid()) { p.gate = true; p.toGate = false; p.hp = p.maxHp; }
            else p.toGate = true;
            added.push_back(i);
            break;
        }
        changed_ = true;
        return added;
    }
    for (const WallPlanPiece& q : plan.pieces) {
        auto nodeFor = [&](int snapped, float x, float z) -> uint32_t {
            if (snapped >= 0 && nodes_[(size_t)snapped].alive) return (uint32_t)snapped;
            return splitAt(x, z, q.y);   // existing joint, a point on a piece (split) or a new joint
        };
        const uint32_t a = nodeFor(q.nodeA, q.ax, q.az), b = nodeFor(q.nodeB, q.bx, q.bz);
        if (a == b) continue;
        WallPiece p;
        p.a = a; p.b = b;
        p.type = plan.type; p.gate = plan.gate;
        p.alive = true;
        p.hp = p.maxHp = health_[(size_t)plan.type];
        p.build = instant ? 1.f : 0.f;
        p.batch = batch_;
        p.price = q.price;
        uint32_t idx = (uint32_t)pieces_.size();
        for (uint32_t i = 0; i < pieces_.size(); ++i)
            if (!pieces_[i].alive && pieces_[i].obstacle == ~0u) { idx = i; break; }
        if (idx == pieces_.size()) pieces_.push_back(p);
        else { p.gen = pieces_[idx].gen + 1; pieces_[idx] = p; }
        ++nodes_[a].degree; ++nodes_[b].degree;
        if (instant) { ++nodes_[a].solidDeg; ++nodes_[b].solidDeg; }
        added.push_back(idx);
        // rubble under the new piece is cleared
        const Obb box = pieceBox(idx);
        rubble_.erase(std::remove_if(rubble_.begin(), rubble_.end(), [&](const WallRubble& r) { return box.contains(r.box.cx, r.box.cz, -0.5f); }), rubble_.end());
    }
    changed_ = changed_ || !added.empty();
    return added;
}

bool Walls::advance(uint32_t i, float amount) {
    if (i >= pieces_.size() || !pieces_[i].alive || pieces_[i].build >= 1.f) return false;
    WallPiece& p = pieces_[i];
    p.build = std::min(1.f, p.build + amount);
    if (p.build < 1.f) return false;
    p.age = 0.f;   // rise animation from now
    ++nodes_[p.a].solidDeg; ++nodes_[p.b].solidDeg;
    changed_ = true;
    return true;
}

void Walls::finishGate(uint32_t i) {
    if (i >= pieces_.size() || !pieces_[i].alive || !pieces_[i].toGate) return;
    WallPiece& p = pieces_[i];
    p.toGate = false; p.gate = true; p.hp = p.maxHp; p.age = 0.f;
    changed_ = true;
}

bool Walls::cancel(uint32_t i) {
    if (i >= pieces_.size() || !pieces_[i].alive) return false;
    WallPiece& p = pieces_[i];
    if (p.toGate) { p.toGate = false; return true; }
    if (p.solid()) return false;
    p.alive = false;
    detach(p.a, false);
    detach(p.b, false);
    changed_ = true;
    return true;
}

void Walls::detach(uint32_t node, bool solid) {
    WallNode& n = nodes_[node];
    if (n.degree) --n.degree;
    if (solid && n.solidDeg) --n.solidDeg;
    if (!n.degree) n.alive = false;   // GameWorld removes its post obstacle (obstacle id stays set until then)
}

void Walls::damage(uint32_t i, float hp) {
    if (i >= pieces_.size() || !pieces_[i].alive || hp <= 0) return;
    WallPiece& p = pieces_[i];
    p.hp -= hp;
    if (p.hp <= 0.f) destroy(i);
}

void Walls::addPressure(uint32_t i, float zombies, float dt) {
    if (i >= pieces_.size() || !pieces_[i].solid()) return;
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
    const bool wasSolid = p.solid();
    p.alive = false;
    p.hp = 0;
    p.toGate = false;
    const float y = 0.5f * (nodes_[p.a].y + nodes_[p.b].y);
    if (wasSolid) rubble_.push_back({box, p.type, p.gate, y, 0.f});
    if (wasSolid) breaches_.push_back({nodes_[p.a].x, nodes_[p.a].z, nodes_[p.a].y, nodes_[p.b].x, nodes_[p.b].z, nodes_[p.b].y, p.type, p.gate, 0.f});
    if (rubble_.size() > 512) rubble_.erase(rubble_.begin());
    detach(p.a, wasSolid);
    detach(p.b, wasSolid);
    destroyed_.push_back({i, box.cx, y, box.cz, box});
    changed_ = true;
    return true;
}

int Walls::reseal(size_t k) {
    if (k >= breaches_.size()) return -1;
    const Breach br = breaches_[k];
    breaches_.erase(breaches_.begin() + (std::ptrdiff_t)k);
    auto nodeFor = [&](float x, float z, float y) -> uint32_t {
        const int nn = nearestNode(x, z, 0.3f);
        return nn >= 0 ? (uint32_t)nn : addNode(x, z, y);
    };
    const uint32_t a = nodeFor(br.ax, br.az, br.ay), b = nodeFor(br.bx, br.bz, br.by);
    if (a == b) return -1;
    WallPiece p;
    p.a = a; p.b = b;
    p.type = br.type; p.gate = br.gate;
    p.alive = true;
    p.hp = p.maxHp = health_[(size_t)br.type];
    p.build = 0.f;
    p.batch = 0;   // never undone with the player's last placement
    uint32_t idx = (uint32_t)pieces_.size();
    for (uint32_t i = 0; i < pieces_.size(); ++i)
        if (!pieces_[i].alive && pieces_[i].obstacle == ~0u) { idx = i; break; }
    if (idx == pieces_.size()) pieces_.push_back(p);
    else { p.gen = pieces_[idx].gen + 1; pieces_[idx] = p; }
    ++nodes_[a].degree; ++nodes_[b].degree;
    const Obb box = pieceBox(idx);
    rubble_.erase(std::remove_if(rubble_.begin(), rubble_.end(), [&](const WallRubble& r) { return box.contains(r.box.cx, r.box.cz, -0.5f); }), rubble_.end());
    changed_ = true;
    return (int)idx;
}

void Walls::tick(float dt, const std::function<bool(float, float, float)>& soldierNear) {
    // breaches: forgotten after breachMemory s, or once a piece stands in the gap again (the player rebuilt it)
    for (Breach& b : breaches_) b.t += dt;
    breaches_.erase(std::remove_if(breaches_.begin(), breaches_.end(), [&](const Breach& b) {
                        return b.t > breachMemory || pieceAt(0.5f * (b.ax + b.bx), 0.5f * (b.az + b.bz), 0.4f) >= 0;
                    }), breaches_.end());
    for (size_t i = 0; i < pieces_.size(); ++i) {
        WallPiece& p = pieces_[i];
        if (!p.solid()) continue;
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
uint32_t Walls::solidPieces() const { uint32_t n = 0; for (const WallPiece& p : pieces_) n += p.solid() ? 1 : 0; return n; }
uint32_t Walls::aliveGates() const { uint32_t n = 0; for (const WallPiece& p : pieces_) n += p.alive && p.gate ? 1 : 0; return n; }
float Walls::totalLength() const {
    float l = 0;
    for (const WallPiece& p : pieces_) if (p.alive) l += std::hypot(nodes_[p.b].x - nodes_[p.a].x, nodes_[p.b].z - nodes_[p.a].z);
    return l;
}

} // namespace ttz::game
