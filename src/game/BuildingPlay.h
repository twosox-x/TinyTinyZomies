#pragma once
// B3a building gameplay (GAME_DESIGN 6 / 7 / 14b): capture (PROPOSED rule), roles Garrison / Hospital (costs
// UNAPPROVED), garrison firing positions (windows / roof edges; soldiers enter through a door with the enter_building
// clip, are shown at their window / roof position and fire from there; zombies that reach the floor / roof hurt them),
// hospital (wounded soldiers seek it through SoldierAI::medicalSeek, heal inside, then rejoin their squad), and
// fortification (approved barricades on doors / windows, window nests / roof rings at firing positions).
//
// Tick placement (GameWorld::tick):
//   preAi    : before SoldierAI: a new player order releases garrisoned soldiers (they step out of the door first)
//   tick     : after the animator: capture, approach -> entering -> posted, posted soldiers pinned to their
//              position, garrison ammo stack, hospital healing / discharge, barricade breach fallback
//   preCombat / postCombat : around Combat::tick (nest defence: contact damage scaled at nests)
// No GPU and no App here (the self-test links it); the App side (window loading, UI, drawing, script verbs) is in
// BuildingGame.cpp.
#include "game/Buildings.h"
#include "game/GameContext.h"

#include <string>
#include <vector>

namespace ttz::game {

struct BuildingNotice { std::string text; bool bad = false; };

class BuildingPlay {
public:
    BuildingRegistry& registry() { return reg_; }
    const BuildingRegistry& registry() const { return reg_; }

    // ---- player actions (UI / scripts). false + msg = refused (nothing charged).
    bool setRole(GameContext& ctx, BuildingId b, BuildingRole role, std::string& msg);
    bool garrison(GameContext& ctx, SquadId squad, BuildingId b, std::string& msg);   // squad occupies firing positions
    bool barricade(GameContext& ctx, BuildingId b, int opening, BarricadeType t, std::string& msg);   // opening -1: all doors
    bool barricadeWindows(GameContext& ctx, BuildingId b, BarricadeType t, std::string& msg);         // windows not used to fire from
    bool nest(GameContext& ctx, BuildingId b, int firing, std::string& msg);                          // -1: every position
    void release(GameContext& ctx, uint32_t soldier);       // step out of the building (door), slot freed

    // SoldierAI::medicalSeek hook: a wounded, idle soldier walks to the nearest hospital with a free bed.
    bool medicalSeek(GameContext& ctx, uint32_t i);

    void preAi(GameContext& ctx);
    void tick(GameContext& ctx);
    void preCombat(const GameContext& ctx);
    void postCombat(GameContext& ctx);
    void takeNotices(std::vector<BuildingNotice>& out) { out.insert(out.end(), notices_.begin(), notices_.end()); notices_.clear(); }

    BuildingId selected;              // UI selection (one building)

    // UI / script requests, applied at the start of the next tick (input never mutates game state directly)
    enum class Act : uint8_t { Role, Garrison, BarricadeDoors, BarricadeWindows, Nest, Release };
    struct Action { Act act; BuildingId b; SquadId squad; int arg = 0; };
    void request(const Action& a) { pending_.push_back(a); }
    void applyPending(GameContext& ctx);

    // stats (tests / HUD)
    struct Stats {
        uint32_t captured = 0, entered = 0, posted = 0, admitted = 0, discharged = 0, barricades = 0, nests = 0, breached = 0, released = 0;
        double healed = 0, ammoIssued = 0;
    };
    const Stats& stats() const { return stats_; }
    int ammoStock(BuildingId b) const { return b.v < ammo_.size() ? ammo_[b.v] : 0; }
    bool posted(uint32_t soldier) const;
    // door exit (walkable point 1.6 m outside the entrance) of opening k
    static V3 doorExit(const Building& B, int k);

private:
    void capture(GameContext& ctx, float dt);
    void approach(GameContext& ctx);
    void hospital(GameContext& ctx, float dt);
    void breachFallback(GameContext& ctx, float dt);
    void walkTo(GameContext& ctx, uint32_t i, V3 goal);
    void notice(const std::string& t, bool bad) { notices_.push_back({t, bad}); }
    int firingSlotOf(const Building& B, uint32_t soldier, const SoldierPool& P) const;

    BuildingRegistry reg_;
    std::vector<Action> pending_;
    std::vector<BuildingNotice> notices_;
    std::vector<int> ammo_;                  // per building: garrison ammo stack (rounds)
    std::vector<uint32_t> orderSerial_;      // per soldier: squad order serial when the building took him over
    std::vector<float> enterT_;              // per soldier: s into the enter clip
    std::vector<V3> enterFrom_;
    std::vector<float> hpBefore_;            // preCombat snapshot (nest damage scale)
    std::vector<uint8_t> hospitalTrip_;      // per soldier: 1 = approaching / inside a hospital (not a garrison)
    float captureClock_ = 0.f;
    Stats stats_;
};

} // namespace ttz::game
