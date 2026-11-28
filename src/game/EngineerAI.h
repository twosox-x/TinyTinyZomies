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
//   Autonomy (owner round 15, WS D: "fix and clear things based on what's going on, never run off without orders"):
//                         with no player job in range, an idle squad takes autonomous jobs within autoLeash m of its
//                         post only: re-seal a breach (a solid piece the horde destroyed: rebuilt as a blueprint, the
//                         piece price charged; skipped when unaffordable), repair a damaged wall / gate piece (hp <
//                         repairBelow of max; zombies pressing / hp lost first), repair a damaged structure (Structures
//                         external repair jobs). Any player order drops them (the squad serial), as for player jobs.
//   Cover (owner #12)   : zombies (horde field) within coverRadius of the job: one engineer keeps working (the one
//                         already on it / nearest; SoldierAI::workFirst: he only fights a zombie within workerFight m),
//                         the others take cover spots between the threat and him (same side of the wall, walkable) and
//                         fight. A single engineer left works unless a zombie is within workerFight m.
//   Status              : status(squad) -> "auto: repairing wall", "building", "auto: covering worker", ... (UI).
//   Debug cheat         : instantBuild (script: `cheat build 1`) builds at once and anywhere (old B2 tests, debugging).
#include "game/GameContext.h"
#include "game/Walls.h"

#include <functional>
#include <string>
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
    // WS D: why inRange is false at x z ("no access to this roof" / "outside engineer range" / "no engineers"), "" if in range
    const char* rangeWhy(const GameContext& ctx, float x, float z) const;
    // a roof point engineer squad s can reach: a member stands on that roof, or the stair core leads up from his street
    bool roofReachable(const GameContext& ctx, float x, float z, const Squad& s) const;
    bool anyEngineers(const GameContext& ctx) const;

    // Car clearing order (the caller charged it). false: already ordered / out of range (why).
    bool orderCar(const GameContext& ctx, uint32_t vehicle, const Obb& box, const char** why);
    bool carOrdered(uint32_t vehicle) const;
    std::vector<Obb> clearingBoxes() const;        // cars ordered and not yet removed (wall planning ignores them)

    void tick(GameContext& ctx);                   // before SoldierAI: jobs, assignment (homes), car completions
    bool work(GameContext& ctx, uint32_t i);       // SoldierAI::workHook
    void postAi(GameContext& ctx);                 // after SoldierAI: work clip for the engineers that worked

    enum class JobKind : uint8_t { Piece = 0, GateConvert = 1, Car = 2, External = 3, Repair = 4 /* wall piece hp */ };
    // GAME_DESIGN 14e: jobs owned by other modules (Structures: tower / generator / floodlight / fuel store blueprints;
    // FuelLogistics: siphoning cars). `externalJobs` appends them each tick (after the wall jobs); an engineer at work
    // calls `externalWork(job, engineer-seconds share)` which advances it and returns the new progress (0..1). `busy`:
    // soldier slots another module drives right now (fuel carriers), skipped by the assignment.
    struct ExternalJob { uint32_t owner = 0, id = 0; Obb box; float progress = 0.f, time = 1.f; uint8_t anim = 1; /* 1 build loops, 3 hammer, 4 car */
                         bool repair = false; float urgency = 0.f; /* autonomous repair (leash, after player jobs) */ };
    std::function<void(const GameContext&, std::vector<ExternalJob>&)> externalJobs;
    std::function<float(GameContext&, const ExternalJob&, float add, uint32_t engineer)> externalWork;
    std::function<bool(uint32_t)> busy;
    struct Job {
        JobKind kind = JobKind::Piece;
        uint32_t index = 0;                        // piece index / car order index
        Obb box;                                   // footprint (piece box / vehicle box)
        float progress = 0.f;                      // 0..1
        float time = 1.f;                          // engineer-seconds for the whole job
        int workers = 0;                           // engineers working on it this tick
        bool inRange = false, blocked = false;     // some engineer squad can reach it / waits for a car
        int squad = -1;                            // engineer squad slot that took it (-1 none)
        bool trap = false;                         // finishing it now would wall someone in: held at 98 %
        bool autonomous = false;                   // not a player job (repair): autoLeash, after the player jobs
        float urgency = 0.f;                       // autonomous jobs: higher first
    };
    const std::vector<Job>& jobs() const { return jobs_; }
    struct CarOrder { uint32_t vehicle = 0; Obb box; float progress = 0.f; bool done = false; };
    const std::vector<CarOrder>& cars() const { return cars_; }
    uint64_t carsCleared() const { return carsCleared_; }
    uint64_t piecesBuilt() const { return piecesBuilt_; }
    uint64_t gatesConverted() const { return gatesConverted_; }
    int workingNow() const { return workingNow_; }
    bool working(uint32_t i) const { return i < worked_.size() && worked_[i]; }
    bool workFirst(uint32_t i) const { return i < role_.size() && role_[i] == 1; }   // SoldierAI: keeps working under threat
    bool covering(uint32_t i) const { return i < role_.size() && role_[i] == 2; }
    // SoldierAI::workFirstHook: the worker keeps working unless the nearest zombie is within workerFight m and not
    // behind a solid wall / gate piece (zombies pressing the wall he repairs cannot reach him)
    bool keepWorking(const GameContext& ctx, uint32_t i, V3 threat, float dist) const;
    static constexpr float workerFight = 6.f;
    const char* status(SquadId s) const;          // short squad status for the UI ("" none)
    uint64_t repairs() const { return repairs_; }        // wall pieces / structures repaired to full
    uint64_t reseals() const { return reseals_; }        // breaches re-sealed (blueprint placed on its own)
    uint64_t coverTicks() const { return coverTicks_; }  // engineer-ticks spent covering a worker
    float repairedHp() const { return repairedHp_; }
    static constexpr float autoLeash = 20.f;      // m from the squad's post: autonomous jobs only within this
    static constexpr float coverRadius = 25.f;    // m: zombies this close to the job -> 1 works, the others cover
    static constexpr float repairBelow = 0.9f;    // wall piece / structure hp fraction that makes a repair job

private:
    struct Assign { int job = -1; V3 spot; bool active = false; };
    std::vector<uint8_t> role_;                   // per soldier slot: 0 normal, 1 worker under threat, 2 cover
    std::vector<std::string> status_;             // per squad slot
    std::vector<int> worker_;                     // per squad slot: soldier slot of the worker (-1)
    std::vector<uint64_t> autoJob_;               // per squad slot: current autonomous job (kind << 32 | index), ~0 none
    std::vector<float> resealT_;                  // per squad slot: s until the next autonomous re-seal
    std::vector<uint32_t> repairing_;             // wall pieces repaired last tick (kept as jobs until full)
    uint64_t repairs_ = 0, reseals_ = 0, coverTicks_ = 0;
    float repairedHp_ = 0.f;
    std::vector<Job> jobs_;
    std::vector<ExternalJob> ext_;               // 14e: this tick's external jobs (JobKind::External index)
    std::vector<CarOrder> cars_;
    std::vector<Assign> assign_;                  // per soldier slot
    std::vector<uint8_t> worked_;                 // per soldier slot: worked this tick
    int workingNow_ = 0;
    uint64_t carsCleared_ = 0, piecesBuilt_ = 0, gatesConverted_ = 0;
    struct GateWork { uint32_t piece = 0; float progress = 0.f; };
    std::vector<GateWork> gateWork_;              // wall pieces being converted into gates
    std::vector<uint32_t> squadSerial_;           // per squad slot: last player order seen (a new one drops the jobs)
    float gateProgress_(uint32_t piece) const;
    // ---- awareness (GAME_DESIGN 14e: "how everything will look in the end")
    // Future enclosure: a 1 m raster over every alive piece (blueprints included, gates open), posts, containers and
    // everything the soldiers cannot walk; flood from the border = outside. Engineers work from the outside of an
    // enclosure the plan will close (never from inside a perimeter that seals), else from the side they stand on.
    struct Future { float ox = 0, oz = 0; int w = 0, h = 0; std::vector<uint8_t> out; uint64_t sig = ~0ull; float age = 1e9f; };
    Future future_;
    void updateFuture(const GameContext& ctx);
    int futureSide(const Obb& b) const;          // +1 / -1: the local-Z side that is outside a future enclosure, 0 none
    // Work spot of member k beside box b on `side`: walkable, on `island` (0 any), off every other piece and blueprint.
    bool workSpot(const GameContext& ctx, const Obb& b, float side, int k, uint32_t island, V3& out) const;
    // Would a soldier be sealed into a small pocket (or stand in the footprint) when box b becomes solid? (out: who)
    bool wouldTrap(const GameContext& ctx, const Obb& b, std::vector<uint32_t>* who) const;
    std::vector<uint32_t> flip_;                  // pieces whose work side is flipped (someone would be walled in)
    V3 squadCentre(const GameContext& ctx, const Squad& s, int* alive) const;
};

} // namespace ttz::game
