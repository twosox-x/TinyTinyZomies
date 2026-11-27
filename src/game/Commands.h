#pragma once
// Player intent (WS-D). Input (mouse / keys) and scripts (--game-script) both produce Commands; GameWorld applies
// them at the start of the next game tick, in order. That keeps orders responsive (<= 1 tick, 33 ms) and makes runs
// reproducible (a script is a command list with timestamps).
//
// Input mapping in --game mode (City Lab RTS rig kept):
//   LMB click / drag box   : select squads (shift adds); click on empty ground clears
//   RMB click (< 6 px move): move order for the selection to the ground point (RMB DRAG still pans the camera)
//   Shift + RMB            : run
//   purchase tools (UI)    : LMB places (deploy, container, airdrop) with preview; Esc / RMB cancels the tool
//   1..9 / Ctrl+1..9       : select / assign control groups (B4 polish)
#include "game/GameTypes.h"

#include <vector>

namespace ttz::game {

enum class CommandType : uint8_t { Select, Move, Stop, BuySquad, BuyContainer, BuyAirdrop, Spawn /* debug / scripts */ };

struct Command {
    CommandType type = CommandType::Stop;
    std::vector<SquadId> squads;     // Select / Move / Stop
    V3 pos;                          // Move / Buy* / Spawn
    float facing = 0.f;
    bool run = false, additive = false;
    SquadType squadType = SquadType::Rifle;
    int count = 0;                   // Spawn: zombies (debug / scripted scenarios only)
};

struct Selection {
    std::vector<SquadId> squads;
    bool contains(SquadId id) const { for (const SquadId& s : squads) if (s == id) return true; return false; }
};

class CommandQueue {
public:
    void push(const Command& c) { pending_.push_back(c); }
    void take(std::vector<Command>& out) { out.swap(pending_); pending_.clear(); }
private:
    std::vector<Command> pending_;
};

} // namespace ttz::game
