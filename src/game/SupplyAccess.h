#pragma once
// What SoldierAI / Combat need from the supply points (WS-C view of WS-D's Logistics). The default implementation
// forwards to GameContext::logistics; tests plug in FakeSupply (FakeHorde.h) so resupply trips are testable before
// and independently of Logistics. Ownership of the transfer: Combat calls collect() on the soldier's `grab` clip
// event while the soldier is Collecting and adds the returned rounds to its reserve (Logistics::tick must not
// transfer on its own, or rounds would be counted twice).
#include "game/Logistics.h"

namespace ttz::game {

class SupplyAccess {
public:
    virtual ~SupplyAccess() = default;
    virtual SupplyId findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) = 0;
    virtual bool reserve(SupplyId sp, SoldierId soldier, V3& slotPos) = 0;   // false: every slot taken (queue)
    virtual void release(SupplyId sp, SoldierId soldier) = 0;
    virtual int collect(SupplyId sp, AmmoType type, int wanted) = 0;       // rounds actually transferred
    virtual int stock(SupplyId sp, AmmoType type) const = 0;               // 0 for an unknown / removed point
    virtual bool position(SupplyId sp, V3& pos) const = 0;
};

class LogisticsSupply final : public SupplyAccess {
public:
    Logistics* lg = nullptr;
    SupplyId findNearest(const GameContext& ctx, V3 from, AmmoType type, float maxDist) override {
        return lg ? lg->findNearest(ctx, from, type, maxDist) : SupplyId{};
    }
    bool reserve(SupplyId sp, SoldierId soldier, V3& slotPos) override { return lg && lg->reserve(sp, soldier, slotPos); }
    void release(SupplyId sp, SoldierId soldier) override { if (lg) lg->releaseReservation(sp, soldier); }
    int collect(SupplyId sp, AmmoType type, int wanted) override { return lg ? lg->collect(sp, type, wanted) : 0; }
    int stock(SupplyId sp, AmmoType type) const override {
        const SupplyPoint* p = lg ? lg->get(sp) : nullptr;
        return p ? p->stock[(int)type] : 0;
    }
    bool position(SupplyId sp, V3& pos) const override {
        const SupplyPoint* p = lg ? lg->get(sp) : nullptr;
        if (p) pos = p->pos;
        return p != nullptr;
    }
};

} // namespace ttz::game
