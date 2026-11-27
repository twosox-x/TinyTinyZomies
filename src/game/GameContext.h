#pragma once
// The bundle every gameplay module's tick receives. GameWorld owns all the pointed-to objects; modules never keep
// pointers to each other, they get them here each tick (no hidden coupling, easy to fake in tests).
#include "game/GameTypes.h"

#include <vector>

namespace ttz::game {

struct BalanceConfig;
struct SoldierPool;
struct SquadList;
struct TickEvents;
struct AnimEvent;
class NavGrid;
class HordeInterface;
class SoldierAnimator;
class Economy;
class Logistics;
class Deploy;

struct GameContext {
    const BalanceConfig* cfg = nullptr;
    SoldierPool* soldiers = nullptr;
    SquadList* squads = nullptr;
    NavGrid* nav = nullptr;
    HordeInterface* horde = nullptr;
    SoldierAnimator* animator = nullptr;
    Economy* economy = nullptr;
    Logistics* logistics = nullptr;
    Deploy* deploy = nullptr;
    TickEvents* events = nullptr;
    std::vector<AnimEvent>* animEvents = nullptr;   // clip events crossed this tick (SoldierAnimator::tick)
    double time = 0.0;                              // game time (s), advances kTickDt per tick
    uint64_t tick = 0;
    float dt = (float)kTickDt;
};

} // namespace ttz::game
