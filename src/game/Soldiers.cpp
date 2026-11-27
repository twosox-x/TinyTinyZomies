// Soldier / squad storage (WS-C). Implemented: slot allocation (needed by every workstream's tests).
#include "game/Soldiers.h"

namespace ttz::game {

SoldierId SoldierPool::spawn(SoldierClass c, int infantryIndex, SquadId sq, int slot, V3 p, float yawRad, uint32_t seed) {
    uint32_t i;
    if (!free_.empty()) { i = free_.back(); free_.pop_back(); }
    else {
        i = (uint32_t)gen.size();
        gen.push_back(0); used.push_back(0); cls.push_back(c); infantry.push_back(0); squad.emplace_back(); slotInSquad.push_back(0);
        pos.emplace_back(); vel.emplace_back(); yaw.push_back(0); path.emplace_back();
        health.push_back(0); mag.push_back(0); reserve.push_back(0); target.emplace_back(); fireCooldown.push_back(0);
        state.push_back(SoldierState::Idle); stateTime.push_back(0); supply.emplace_back(); rng.push_back(0); anim.emplace_back();
    }
    used[i] = 1; cls[i] = c; infantry[i] = (uint16_t)infantryIndex; squad[i] = sq; slotInSquad[i] = (uint8_t)slot;
    pos[i] = p; vel[i] = {}; yaw[i] = yawRad; path[i] = {}; health[i] = 0; mag[i] = 0; reserve[i] = 0; target[i] = {};
    fireCooldown[i] = 0; state[i] = SoldierState::Descending; stateTime[i] = 0; supply[i] = {}; rng[i] = pcg(seed ^ (i * 2654435761u));
    anim[i] = {};
    return idOf(i);
}

void SoldierPool::release(SoldierId id) {
    if (!valid(id)) return;
    used[id.index] = 0;
    ++gen[id.index];
    free_.push_back(id.index);
}

size_t SoldierPool::liveCount() const {
    size_t n = 0;
    for (uint32_t i = 0; i < (uint32_t)gen.size(); ++i) n += alive(i) ? 1 : 0;
    return n;
}

SquadId SquadList::create(SquadType t) {
    Squad s;
    s.id.index = (uint32_t)squads.size();
    s.id.gen = 1;
    s.type = t;
    uint32_t n = 1;
    for (const Squad& o : squads) n += o.type == t ? 1 : 0;
    s.number = n;
    squads.push_back(s);
    gen.push_back(1);
    return s.id;
}

Squad* SquadList::get(SquadId id) { return id.index < squads.size() && gen[id.index] == id.gen ? &squads[id.index] : nullptr; }
const Squad* SquadList::get(SquadId id) const { return id.index < squads.size() && gen[id.index] == id.gen ? &squads[id.index] : nullptr; }

int SquadList::aliveMembers(const Squad& s, const SoldierPool& pool) const {
    int n = 0;
    for (const SoldierId& m : s.members) n += pool.valid(m) && pool.alive(m.index) ? 1 : 0;
    return n;
}

} // namespace ttz::game
