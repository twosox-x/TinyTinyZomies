#pragma once
// Engineers (GAME_DESIGN 14d, APPROVED: a squad of 3 that builds walls, gates and fortifications and clears cars; the
// player can no longer build instantly or anywhere). Every value is in EngineerConfig (balance.json "engineers",
// UNAPPROVED / PROPOSED).
//
//   Construction radius : an order (wall, gate, gate into a wall, car clearing) is accepted only within
//                         `radius` of an engineer squad: its post (squad anchor = last order destination) or, before
//                         its first order, the members' centroid (landing). GameUI draws the rings while placing.
//   Jobs                : derived from the world every tick, never duplicated: every unfinished wall / gate piece
//                         (Walls: build < 1), every wall piece being converted into a gate (toGate) and every car
//                         ordered for clearing. Queue order: cars first (they block walls), then placements in order.
//                         A piece overlapping a car that is being cleared waits for it.
//   Assignment          : each engineer squad takes the first job within its radius that no other squad has taken
//                         (several squads share the queue; with nothing else left they help on the same job). Each
//                         member gets a work spot beside the job (the squad's side, spread along it); EngineerAI sets
//                         it as his home, so SoldierAI's leash walks him there (threats interrupt: engineers are
//                         riflemen and fight first). A player move order takes the squad over; after it arrives it
//                         picks up jobs within the radius of its new post.
//   Work                : SoldierAI::workHook -> work(): an Idle engineer within workRange of his spot faces the job and
//                         adds dt / time (pieceTime per 4 m piece pro rata, gateTime, carTime) to it; postAi()
//                         requests the work loop clip (collect_ammo, PLACEHOLDER until the approved engineer clips).
//                         A finished piece becomes solid (Walls::advance: collision, territory, joints); a car is
//                         removed from the city (CityVehicles::removeVehicle, persistent) when its clearing finishes.
//   Visual placeholder  : engineer squads drop as the "Engineer (placeholder)" rifleman variant (MilitaryLibrary adds
//                         it: hi-vis vest, orange helmet cover); approved engineer assets (class "engineer") replace it
//                         through DeployTiming::engineerVariants without code changes here.
//   Debug cheat         : instantBuild (script: `cheat build 1`) builds at once and anywhere (old B2 tests, debugging).
#include "game/GameContext.h"
#include "game/Walls.h"

#include <functional>
#include <vector>

namespace ttz::game {

class SoldierAI;
struct Squad;

class EngineerAI {
public:
    bool instantBuild = false;                     // DEBUG / TEST cheat: no engineers needed, no radius, no build time
    const SoldierAI* ai = nullptr;                 // formation slots when a squad's jobs are done
    std::function<void(uint32_t)> removeVehicle;   // GameWorld: CityVehicles::removeVehicle (instance + obstacle cells)

    struct Zone { V3 c; float r = 0.f; SquadId squad; };
    void zones(const GameContext& ctx, std::vector<Zone>& out) const;
    bool inRange(const GameContext& ctx, float x, float z) const;
    bool anyEngineers(const GameContext& ctx) const;

    // Car clearing order (the caller charged it). false: already ordered / out of range (why).
    bool orderCar(const GameContext& ctx, uint32_t vehicle, const Obb& box, const char** why);
    bool carOrdered(uint32_t vehicle) const;
    std::vector<Obb> clearingBoxes() const;        // cars ordered and not yet removed (wall planning ignores them)

    void tick(GameContext& ctx);                   // before SoldierAI: jobs, assignment (homes), car completions
    bool work(GameContext& ctx, uint32_t i);       // SoldierAI::workHook
    void postAi(GameContext& ctx);                 // after SoldierAI: work clip for the engineers that worked

    enum class JobKind : uint8_t { Piece = 0, GateConvert = 1, Car = 2 };
    struct Job {
        JobKind kind = JobKind::Piece;
        uint32_t index = 0;                        // piece index / car order index
        Obb box;                                   // footprint (piece box / vehicle box)
        float progress = 0.f;                      // 0..1
        float time = 1.f;                          // engineer-seconds for the whole job
        int workers = 0;                           // engineers working on it this tick
        bool inRange = false, blocked = false;     // some engineer squad can reach it / waits for a car
        int squad = -1;                            // engineer squad slot that took it (-1 none)
    };
    const std::vector<Job>& jobs() const { return jobs_; }
    struct CarOrder { uint32_t vehicle = 0; Obb box; float progress = 0.f; bool done = false; };
    const std::vector<CarOrder>& cars() const { return cars_; }
    uint64_t carsCleared() const { return carsCleared_; }
    uint64_t piecesBuilt() const { return piecesBuilt_; }
    uint64_t gatesConverted() const { return gatesConverted_; }
    int workingNow() const { return workingNow_; }
    bool working(uint32_t i) const { return i < worked_.size() && worked_[i]; }

private:
    struct Assign { int job = -1; V3 spot; bool active = false; };
    std::vector<Job> jobs_;
    std::vector<CarOrder> cars_;
    std::vector<Assign> assign_;                  // per soldier slot
    std::vector<uint8_t> worked_;                 // per soldier slot: worked this tick
    int workingNow_ = 0;
    uint64_t carsCleared_ = 0, piecesBuilt_ = 0, gatesConverted_ = 0;
    struct GateWork { uint32_t piece = 0; float progress = 0.f; };
    std::vector<GateWork> gateWork_;              // wall pieces being converted into gates
    std::vector<uint32_t> squadSerial_;           // per squad slot: last player order seen (a new one drops the jobs)
    float gateProgress_(uint32_t piece) const;
    V3 squadCentre(const GameContext& ctx, const Squad& s, int* alive) const;
};

} // namespace ttz::game
