#pragma once
// GAME_DESIGN 14e fuel logistics (mechanic APPROVED, values UNAPPROVED in balance.json "structures"):
//   Siphon fuel  : with engineers selected, a parked car (intact / damaged: wrecks and burning cars hold no fuel) is
//                  ordered for siphoning (hover menu / script). It becomes an engineer job (EngineerAI external job,
//                  owner 2, siphonTime engineer-seconds). When done the car is marked drained (CityVehicles::setDrained:
//                  it can no longer ignite or explode) and its fuel (carFuel l) is carried PHYSICALLY to the nearest
//                  fuel store: each engineer who worked on it carries one jerrycan (jerrycanLitres) per trip, walks to
//                  the store's delivery point, pours it in (base stock), walks back for the rest until the car is empty.
//                  Carriers are "busy" for EngineerAI (not assigned to other jobs) and still fight when threatened.
//   Disassemble  : the existing car clearing (EngineerAI car job) also yields the car's fuel: when the clearing finishes
//                  the engineers of the clearing squad carry it to the store the same way (the car itself is gone).
//   No fuel store: siphoning is refused ("no fuel store"); a disassembled car's fuel is lost (notice).
#include "game/EngineerAI.h"
#include "game/GameContext.h"

#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ttz::game {

class Structures;

class FuelLogistics {
public:
    // App hooks (StructuresGame.cpp)
    std::function<int(uint32_t vehicle)> carCondition;   // 0 intact / damaged (fuel), 1 burning / wrecked / removed (none)
    std::function<void(uint32_t vehicle)> drain;         // CityVehicles::setDrained

    bool orderSiphon(const GameContext& ctx, const Structures& st, uint32_t vehicle, const Obb& box, const char** why);
    bool siphonOrdered(uint32_t vehicle) const;
    float litresLeft(const GameContext& ctx, uint32_t vehicle) const;   // in the car (not yet siphoned)
    // EngineerAI::removeVehicle wrapper: a cleared (disassembled) car's fuel goes to the base; call before the removal
    void carDisassembled(GameContext& ctx, Structures& st, uint32_t vehicle, V3 at);

    void jobs(const GameContext& ctx, std::vector<EngineerAI::ExternalJob>& out) const;   // owner 2
    float work(GameContext& ctx, Structures& st, const EngineerAI::ExternalJob& j, float add, uint32_t engineer);
    void tick(GameContext& ctx, Structures& st);         // after SoldierAI: carriers (to the store / back to the car)
    bool busy(uint32_t soldier) const { return soldier < carry_.size() && carry_[soldier].phase != 0; }
    float carrying(uint32_t soldier) const { return soldier < carry_.size() ? carry_[soldier].litres : 0.f; }

    struct Stats { uint32_t ordered = 0, siphoned = 0, disassembled = 0, trips = 0; double delivered = 0, lost = 0; };
    const Stats& stats() const { return stats_; }
    float inTransit() const;                             // litres carried or waiting at cars
    std::vector<std::pair<std::string, bool>>& notices() { return notices_; }

private:
    struct Order { uint32_t vehicle = 0; Obb box; float progress = 0.f; bool done = false; std::vector<uint32_t> workers; };
    struct Source { V3 pos; float litres = 0.f; };      // fuel waiting at a car (jerrycans filled, not yet carried)
    struct Carry { uint8_t phase = 0; /* 0 none, 1 to the store, 2 back to the source */ int source = -1; int store = -1; float litres = 0.f; float t = 0.f; };
    void startTrips(GameContext& ctx, Structures& st, int source, const std::vector<uint32_t>& carriers);
    void walkTo(GameContext& ctx, uint32_t i, V3 goal);
    std::vector<Order> orders_;
    std::vector<Source> sources_;
    std::vector<Carry> carry_;
    std::unordered_map<uint32_t, float> taken_;          // vehicle -> litres already taken
    std::vector<std::pair<std::string, bool>> notices_;
    Stats stats_;
};

} // namespace ttz::game
