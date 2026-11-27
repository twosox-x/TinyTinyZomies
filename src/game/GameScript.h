#pragma once
// Headless scripted scenarios for acceptance tests (WS-D): `ttz --map city --game --headless --game-script FILE`.
// One command per line, '#' comments; times in game seconds:
//
//   at 0.0  spawn 600 230 410 25           # zombies: count x z radius (requestSpawn rect)
//   at 0.5  buy rifle 240 400              # squad purchase + drop at (x, z)  (rifle | mg | sniper)
//   at 0.5  buy mg 246 404
//   at 20   move 1 260 380                 # squad number (purchase order, 1-based) to (x, z); "run" suffix runs
//   at 25   stop 1
//   at 30   airdrop 250 390
//   at 30   container 236 396 0            # x z yaw
//   at 40   expect squad 1 size == 5       # acceptance checks: failures are printed and set the exit code
//   at 60   expect squad 1 ammo < squad 1 ammo_start
//   at 90   expect kills >= 10
//   at 90   expect funding_reward_matches_kills
//   at 120  end
//
// expect <metric> <op> <metric | number>, op in == != >= <= > <. Metrics:
//   kills kills_soldier kills_explosion kills_other dupes funding spent passive_total reward_total reward_expected
//   ledger_sum shots soldiers soldiers_alive squads dropped landed refused zombies_live time
//   squad N size | alive | ammo | ammo_start | mag | reserve | health | parachuted | deploying | dist X Z | maxdist X Z
//   supply N stock | initial | delivered | landed | users            (supply points in creation order, 1-based)
//   delivered (all rounds handed out by supply points)
// Special checks: expect funding_reward_matches_kills | expect ledger_balanced | expect no_duplicate_rewards
// Other verbs: log (prints a status line), camera X Z YAW PITCH DIST, select N.., preview TOOL X Z, preview off,
// shot FILE.png (screenshot incl. HUD), squadinfo N (prints every member).
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
    int passes() const { return passes_; }
    bool loaded() const { return !lines_.empty(); }
    // A screenshot requested by `shot` (App takes it after the frame's UI is drawn), consumed by the App.
    std::string takeShot() { std::string s; s.swap(shot_); return s; }
private:
    bool metric(GameWorld& w, const std::vector<std::string>& a, size_t& k, double& out, std::string& err) const;
    void expect(GameWorld& w, const ScriptLine& L);
    std::vector<ScriptLine> lines_;
    size_t next_ = 0;
    int failures_ = 0, passes_ = 0;
    bool ended_ = false;
    std::string shot_;
};

} // namespace ttz::game
