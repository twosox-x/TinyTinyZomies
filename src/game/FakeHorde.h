#pragma once
// CPU stand-ins for tests (WS-C; usable by every workstream): FakeHorde implements HordeInterface with point
// zombies on the CPU (zero latency), FakeSupply implements SupplyAccess with plain stock counters and slots.
// Deterministic: zombies are processed in index order, spawns use the pcg stream.
#include "game/HordeInterface.h"
#include "game/SupplyAccess.h"

#include <array>
#include <vector>

namespace ttz::game {

class NavGrid;

class FakeHorde final : public HordeInterface {
public:
    struct Zombie { V3 pos; float health = 1.f; bool alive = true; uint32_t hits = 0; };
    std::vector<Zombie> zombies;
    float speed = 1.0f;              // m/s toward the nearest soldier within `awareness`
    float awareness = 60.f;
    float radius = 0.3f, height = 1.8f;
    float attackReach = 0.9f;        // soldier capsule surface to zombie centre (ThreatConfig.attackReach)
    bool immortal = false;           // rounds hit but never kill (magazine / reload tests)
    const NavGrid* nav = nullptr;    // optional: rounds stopped by buildings, zombies stay on walkable cells

    void setBounds(float x0, float z0, float x1, float z1, float tile = 6.f);
    void spawn(V3 centre, float r, int n, uint32_t seed);
    void add(V3 p) { Zombie z; z.pos = p; zombies.push_back(z); }
    // One step: resolve the hits queued since the last step, move zombies, rebuild field + contacts.
    void step(float dt);
    int aliveCount() const;

    // HordeInterface
    void uploadSoldiers(const std::vector<HordeSoldier>& s) override { soldiers_ = s; }
    void queueHits(const std::vector<HitRequest>& hits) override { hits_.insert(hits_.end(), hits.begin(), hits.end()); }
    void setAttractors(const std::vector<Attractor>& a) override { attractors_ = a; }
    void requestExplosion(V3 pos, float scale) override { ++explosions; }
    const ZombieField& field() const override { return field_; }
    const std::vector<SoldierContact>& contacts() const override { return contacts_; }
    void takeKills(std::vector<KillEvent>& out) override { out.insert(out.end(), kills_.begin(), kills_.end()); kills_.clear(); }
    uint64_t killsOverflowed() const override { return 0; }
    bool simulated(float x, float z) const override { return x >= x0_ && z >= z0_ && x <= x1_ && z <= z1_; }

    uint64_t hitsQueued = 0, hitsLanded = 0, hitsBlocked = 0, killsTotal = 0, explosions = 0;
    const std::vector<Attractor>& attractors() const { return attractors_; }
    const std::vector<HordeSoldier>& soldiers() const { return soldiers_; }

private:
    float x0_ = -1e9f, z0_ = -1e9f, x1_ = 1e9f, z1_ = 1e9f;
    std::vector<HordeSoldier> soldiers_;
    std::vector<HitRequest> hits_;
    std::vector<Attractor> attractors_;
    ZombieField field_;
    std::vector<SoldierContact> contacts_;
    std::vector<KillEvent> kills_;
    uint64_t seq_ = 0;
    void resolveHits();
    void rebuildField();
};

class FakeSupply final : public SupplyAccess {
public:
    struct Point { SupplyId id; V3 pos; std::array<int, 3> stock = {0, 0, 0}; std::vector<V3> slots; std::vector<SoldierId> user; };
    std::vector<Point> points;
    SupplyId add(V3 pos, std::array<int, 3> stock, int slots, float slotRadius = 1.2f);
    SupplyId findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) override;
    bool reserve(SupplyId sp, SoldierId soldier, V3& slotPos) override;
    void release(SupplyId sp, SoldierId soldier) override;
    int collect(SupplyId sp, AmmoType type, int wanted) override;
    int stock(SupplyId sp, AmmoType type) const override;
    bool position(SupplyId sp, V3& pos) const override;
    int reservations(SupplyId sp) const;
    uint64_t collected = 0, reserveRefused = 0;
private:
    Point* get(SupplyId id);
    const Point* get(SupplyId id) const;
};

} // namespace ttz::game
