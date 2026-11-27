// CPU fakes of the horde and the supply points (tests). See FakeHorde.h.
#include "game/FakeHorde.h"

#include "game/NavGrid.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

void FakeHorde::setBounds(float x0, float z0, float x1, float z1, float tile) {
    x0_ = x0; z0_ = z0; x1_ = x1; z1_ = z1;
    field_.originX = x0; field_.originZ = z0; field_.tileSize = tile;
    field_.tilesX = (uint32_t)std::ceil((x1 - x0) / tile);
    field_.tilesZ = (uint32_t)std::ceil((z1 - z0) / tile);
    field_.tiles.assign((size_t)field_.tilesX * field_.tilesZ, ZombieFieldTile{});
}

void FakeHorde::spawn(V3 c, float r, int n, uint32_t seed) {
    uint32_t s = pcg(seed + 1u);
    for (int k = 0; k < n; ++k) {
        const float a = rand01(s) * 6.2831853f, d = r * std::sqrt(rand01(s));
        V3 p{c.x + std::cos(a) * d, c.y, c.z + std::sin(a) * d};
        if (nav && nav->ready()) {
            V3 q;
            if (!nav->nearestWalkable(p, 3.f, q)) continue;
            p = q;
        }
        add(p);
    }
}

int FakeHorde::aliveCount() const {
    int n = 0;
    for (const Zombie& z : zombies) n += z.alive ? 1 : 0;
    return n;
}

void FakeHorde::resolveHits() {
    for (const HitRequest& h : hits_) {
        ++hitsQueued;
        const V3 d = normalize(h.dir);
        const float dl = std::sqrt(d.x * d.x + d.z * d.z);
        int best = -1;
        float bestT = h.maxDist;
        for (size_t k = 0; k < zombies.size(); ++k) {
            const Zombie& z = zombies[k];
            if (!z.alive) continue;
            // ray vs vertical capsule (cylinder): closest approach in the ground plane, height check at that point
            const float ox = z.pos.x - h.origin.x, oz = z.pos.z - h.origin.z;
            if (dl < 1e-4f) continue;
            const float t2 = (ox * d.x + oz * d.z) / (dl * dl);   // parameter along d where xz distance is minimal
            if (t2 < 0.f) continue;
            const float cx = h.origin.x + d.x * t2 - z.pos.x, cz = h.origin.z + d.z * t2 - z.pos.z;
            const float miss2 = cx * cx + cz * cz;
            if (miss2 > radius * radius) continue;
            const float t = t2 - std::sqrt(std::max(0.f, radius * radius - miss2)) / dl;   // entry
            const float y = h.origin.y + d.y * t;
            if (y < z.pos.y || y > z.pos.y + height || t > bestT) continue;
            bestT = t; best = (int)k;
        }
        if (best < 0) continue;
        Zombie& z = zombies[(size_t)best];
        if (nav && nav->ready() && !nav->lineOfSight(h.origin, h.origin + d * bestT)) { ++hitsBlocked; continue; }
        ++hitsLanded; ++z.hits;
        if (immortal) continue;
        z.health -= (h.flags & 1u) ? 1e9f : h.damage;
        if (z.health <= 0.f) {
            z.alive = false;
            ++killsTotal;
            KillEvent k;
            k.seq = ++seq_; k.cause = KillCause::Soldier; k.shooterPacked = h.shooterPacked; k.pos = z.pos;
            kills_.push_back(k);
        }
    }
    hits_.clear();
}

void FakeHorde::rebuildField() {
    for (ZombieFieldTile& t : field_.tiles) t = ZombieFieldTile{};
    for (const Zombie& z : zombies) {
        if (!z.alive) continue;
        int i = (int)std::floor((z.pos.x - field_.originX) / field_.tileSize), j = (int)std::floor((z.pos.z - field_.originZ) / field_.tileSize);
        if (i < 0 || j < 0 || i >= (int)field_.tilesX || j >= (int)field_.tilesZ) continue;
        ZombieFieldTile& t = field_.tiles[(size_t)j * field_.tilesX + (size_t)i];
        ++t.count;
        if (t.samples < kFieldSamples) t.pos[t.samples++] = z.pos;
    }
    ++field_.frame;
    contacts_.clear();
    for (const HordeSoldier& s : soldiers_) {
        SoldierContact c;
        c.packedId = s.packedId;
        for (const Zombie& z : zombies) {
            if (!z.alive) continue;
            const float dx = z.pos.x - s.pos.x, dz = z.pos.z - s.pos.z, d = std::sqrt(dx * dx + dz * dz);
            c.nearestDist = std::min(c.nearestDist, d);
            if (d <= s.radius + attackReach) ++c.attackers;
            if (d <= 8.f) ++c.nearby;
            if (d <= threatRadius) {   // exact nearest list (same contract as game_contacts.comp)
                float dd[SoldierContact::kNear];
                for (uint32_t q = 0; q < c.nNear; ++q) dd[q] = std::hypot(c.nearPos[q].x - s.pos.x, c.nearPos[q].z - s.pos.z);
                int j = c.nNear < SoldierContact::kNear ? (int)c.nNear++ : (int)SoldierContact::kNear;
                if (j == (int)SoldierContact::kNear) { if (d >= dd[j - 1]) continue; j = (int)SoldierContact::kNear - 1; }
                while (j > 0 && dd[j - 1] > d) { c.nearPos[j] = c.nearPos[j - 1]; c.nearVel[j] = c.nearVel[j - 1]; dd[j] = dd[j - 1]; --j; }
                c.nearPos[j] = z.pos; c.nearVel[j] = {}; dd[j] = d;
            }
        }
        contacts_.push_back(c);
    }
}

void FakeHorde::step(float dt) {
    resolveHits();
    const float stop = 0.35f + radius * 0.9f;   // zombies press against the soldier capsule, never into it
    for (Zombie& z : zombies) {
        if (!z.alive || speed <= 0.f) continue;
        const HordeSoldier* tgt = nullptr;
        float best = awareness;
        for (const HordeSoldier& s : soldiers_) {
            if (s.attraction <= 0.f) continue;
            const float dx = s.pos.x - z.pos.x, dz = s.pos.z - z.pos.z, d = std::sqrt(dx * dx + dz * dz);
            if (d < best) { best = d; tgt = &s; }
        }
        if (!tgt || best <= stop) continue;
        const float step = std::min(speed * dt, best - stop);
        V3 np{z.pos.x + (tgt->pos.x - z.pos.x) / best * step, z.pos.y, z.pos.z + (tgt->pos.z - z.pos.z) / best * step};
        if (nav && nav->ready()) {
            if (!nav->walkable(np.x, np.z)) continue;
            np.y = nav->surface(np.x, np.z);
        }
        z.pos = np;
    }
    // light zombie separation (keeps samples distinct, like the crowd solver)
    for (size_t a = 0; a < zombies.size(); ++a)
        for (size_t b = a + 1; b < zombies.size(); ++b) {
            Zombie &za = zombies[a], &zb = zombies[b];
            if (!za.alive || !zb.alive) continue;
            const float dx = zb.pos.x - za.pos.x, dz = zb.pos.z - za.pos.z, d2 = dx * dx + dz * dz, m = radius * 2.f;
            if (d2 >= m * m || d2 < 1e-8f) continue;
            const float d = std::sqrt(d2), push = (m - d) * 0.5f;
            V3 pa{za.pos.x - dx / d * push, za.pos.y, za.pos.z - dz / d * push}, pb{zb.pos.x + dx / d * push, zb.pos.y, zb.pos.z + dz / d * push};
            if (!nav || !nav->ready() || nav->walkable(pa.x, pa.z)) za.pos = pa;
            if (!nav || !nav->ready() || nav->walkable(pb.x, pb.z)) zb.pos = pb;
        }
    rebuildField();
}

// ---- FakeSupply -----------------------------------------------------------------------------------------------------
SupplyId FakeSupply::add(V3 pos, std::array<int, kAmmoTypes> stock, int slots, float slotRadius) {
    Point p;
    p.id.index = (uint32_t)points.size(); p.id.gen = 1;
    p.pos = pos; p.stock = stock;
    for (int k = 0; k < slots; ++k) {
        const float a = 6.2831853f * (float)k / (float)std::max(1, slots);
        p.slots.push_back({pos.x + std::cos(a) * slotRadius, pos.y, pos.z + std::sin(a) * slotRadius});
    }
    p.user.assign(p.slots.size(), SoldierId{});
    points.push_back(p);
    return p.id;
}
FakeSupply::Point* FakeSupply::get(SupplyId id) { return id.index < points.size() && points[id.index].id == id ? &points[id.index] : nullptr; }
const FakeSupply::Point* FakeSupply::get(SupplyId id) const { return id.index < points.size() && points[id.index].id == id ? &points[id.index] : nullptr; }

SupplyId FakeSupply::findNearest(const GameContext&, V3 from, AmmoType type, float maxDist) {
    SupplyId best;
    float bd = maxDist * maxDist;
    for (const Point& p : points) {
        if (p.stock[(int)type] <= 0) continue;
        const float dx = p.pos.x - from.x, dz = p.pos.z - from.z, d2 = dx * dx + dz * dz;
        if (d2 <= bd) { bd = d2; best = p.id; }
    }
    return best;
}
bool FakeSupply::reserve(SupplyId sp, SoldierId soldier, V3& slotPos) {
    Point* p = get(sp);
    if (!p) return false;
    for (size_t k = 0; k < p->user.size(); ++k) if (p->user[k] == soldier) { slotPos = p->slots[k]; return true; }
    for (size_t k = 0; k < p->user.size(); ++k)
        if (!p->user[k].valid()) { p->user[k] = soldier; slotPos = p->slots[k]; return true; }
    ++reserveRefused;
    return false;
}
void FakeSupply::release(SupplyId sp, SoldierId soldier) {
    if (Point* p = get(sp))
        for (SoldierId& u : p->user) if (u == soldier) u = SoldierId{};
}
int FakeSupply::collect(SupplyId sp, AmmoType type, int wanted) {
    Point* p = get(sp);
    if (!p || wanted <= 0) return 0;
    const int n = std::min(wanted, p->stock[(int)type]);
    p->stock[(int)type] -= n;
    collected += (uint64_t)n;
    return n;
}
int FakeSupply::stock(SupplyId sp, AmmoType type) const { const Point* p = get(sp); return p ? p->stock[(int)type] : 0; }
bool FakeSupply::position(SupplyId sp, V3& pos) const { const Point* p = get(sp); if (p) pos = p->pos; return p != nullptr; }
int FakeSupply::reservations(SupplyId sp) const {
    const Point* p = get(sp);
    int n = 0;
    if (p) for (const SoldierId& u : p->user) n += u.valid() ? 1 : 0;
    return n;
}

} // namespace ttz::game
