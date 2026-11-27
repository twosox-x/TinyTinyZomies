#pragma once
// Headless scripted scenarios for acceptance tests (WS-D): `ttz --map city --game --headless --game-script FILE`.
// One command per line, '#' comments; times in game seconds:
//
//   at 0.0  spawn 600 230 410 25           # zombies: count x z radius (requestSpawn rect)
//   at 0.5  buy rifle 240 400              # squad purchase + drop at (x, z)
//   at 0.5  buy mg 246 404
//   at 20   move 1 260 380                 # squad number (purchase order, 1-based) to (x, z); "run" suffix runs
//   at 30   airdrop 250 390
//   at 30   container 236 396 0            # x z yaw
//   at 40   expect squad 1 size 5          # acceptance checks: failures are printed and set the exit code
//   at 60   expect squad 1 ammo_below_start
//   at 90   expect kills >= 10
//   at 90   expect funding_reward_matches_kills
//   at 120  end
//
// The runner pushes Commands at their tick (deterministic with --game-sync, which waits for each readback in
// headless runs so GPU latency cannot change outcomes), evaluates expectations, prints a summary and sets the
// process exit code (0 = all expectations met).
#include "game/Commands.h"

#include <string>
#include <vector>

namespace ttz::game {

class GameWorld;

struct ScriptLine {
    double at = 0;
    std::string verb;
    std::vector<std::string> args;
    int line = 0;
};

class GameScript {
public:
    bool load(const std::string& path, std::string* error = nullptr);
    // Called once per game tick: runs due lines (commands / expectations). Returns false once `end` ran.
    bool tick(GameWorld& world, double time);
    int failures() const { return failures_; }
    bool loaded() const { return !lines_.empty(); }
private:
    std::vector<ScriptLine> lines_;
    size_t next_ = 0;
    int failures_ = 0;
    bool ended_ = false;
};

} // namespace ttz::game
