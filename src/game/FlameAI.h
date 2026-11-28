#pragma once
// Flamethrower squad behaviour (GAME_DESIGN 14d: APPROVED squad, size PROPOSED 2; values UNAPPROVED, balance.json
// "flame" + weapons / soldiers / squads "flamethrower"). Runs every game tick after SoldierAI::tick (which keeps doing
// everything generic: deploy, move orders, threats, reload = tank swap, resupply = fuel from containers / crates).
//
//   Zombies    : the generic engagement (weapon range 9 m) fires the class weapon; Combat::fire hands each round of a
//                flamethrower to spray() instead of a hit ray: a flame cone (CorpseGas: zombie damage, ground fire,
//                corpse ignition), fuel by spray time, flame FX, high noise.
//   Corpses    : autonomous burning. Every flame.seekInterval s an idle squad looks for the best pile / rotting gas
//                source (CorpseGas readback) within flame.seekRadius of its post (the player's last order point, else
//                its landing point), walks to a stand-off point (flame.standoff m, issued as the squad's move order and
//                marked as its own) and sprays the pile until no corpse is left there (or a timeout), then returns to
//                the post. A player order onto a pile = burn that pile (player-ordered target area).
//   Safety     : never sprays while another soldier is inside the cone + flame.friendlyClearance m.
//   Placeholder: until the approved flamethrower model / clips exist (tools/military_lab, visual approval pending),
//                flamethrowers use the rifleman variants and clips (DeployTiming::variants via
//                usePlaceholderAssets) with the flame stream drawn from the rifle muzzle. Swap: give the library an
//                infantry class "flamethrower" and drop the placeholder call in GameWorld (one line).
#include "game/CorpseGas.h"
#include "game/GameContext.h"
#include "game/GameEvents.h"
#include "game/HordeInterface.h"

#include <vector>

namespace ttz::game {

struct DeployTiming;
struct Squad;

class FlameAI {
public:
    void tick(GameContext& ctx);                          // after SoldierAI::tick, before the animator
    // One spray of soldier i toward `aim` (Combat for zombie targets, FlameAI for piles). Spray time since the
    // soldier's previous spray (clamped), fuel by spray time. False: blocked (friendly in the cone / no fuel).
    // arcUp: rad the drawn jet is lifted over a low obstacle (cars) between the nozzle and the aim (FX only).
    bool spray(GameContext& ctx, uint32_t i, V3 aim, float arcUp = 0.f);
    std::vector<NoiseEvent>& noise() { return noise_; }  // loud spray noise (GameWorld -> Combat::addNoise), drained per tick
    static void usePlaceholderAssets(DeployTiming& t);    // flamethrower = rifleman variants / clip timings
    // Zombie damage of one cone: 15 hit rays over the cone (centre, 6 at half angle, 8 at the rim; pattern rotates per
    // spray), each zombieDps x c.seconds, flag quiet, credited to the shooter (HordeBridge hit path: first zombie per ray).
    static void coneRays(const FlameCone& c, float zombieDps, uint32_t pattern, std::vector<HitRequest>& out);

    uint64_t sprays() const { return sprays_; }
    uint64_t blocked() const { return blocked_; }
    uint64_t trips() const { return trips_; }
    uint64_t fuelUsed() const { return fuelUsed_; }
    uint64_t repositions() const { return repositions_; }   // walked round a pile because soldiers stood in the cone
    bool burning(SquadId s) const;                        // the squad is on a burn trip / spraying a pile
    // owner round 15 (WS D): autonomy leash (m from the post, also caps flame.seekRadius); squad status for the UI
    static constexpr float autoLeash = 25.f;
    const char* status(SquadId s) const;                  // "auto: burning corpses", "auto: defending wall", ""
    uint64_t exposedPicks() const { return exposedPicks_; }   // piles picked because they gassed friendly soldiers
    uint64_t wallTrips() const { return wallTrips_; }         // trips to a wall / gate zombies were breaking
private:
    struct Mem {
        uint32_t gen = ~0u;
        bool hasPost = false;
        V3 post;
        uint32_t ownSerial = 0, seenSerial = 0;
        int phase = 0;                // 0 idle, 1 approaching a pile, 2 spraying, 3 defending a pressed wall piece
        V3 target;
        float seekT = 0.f, phaseT = 0.f, blockedT = 0.f;
        uint32_t wallPiece = 0;
        bool autoTrip = false;        // phase 1 / 2 started on its own (not a player order onto a pile)       // phase 3: the wall piece being defended
    };
    std::vector<Mem> mem_;
    std::vector<double> last_;        // per soldier slot: game time of the last spray (-1 none)
    std::vector<uint8_t> burnAnim_;   // per soldier slot: burn_ground clip running (ignite / stop edges)
    std::vector<float> fuelAcc_;      // per soldier slot: fractional fuel units used
    std::vector<uint32_t> lastGen_;
    std::vector<double> burstStart_, pauseUntil_;   // per soldier slot: start of the current burst, end of the pause after it
    std::vector<V3> lastAim_;                       // per soldier slot: aim of the last spray (zombie bursts continue there)
    std::vector<NoiseEvent> noise_;
    std::vector<double> noiseAt_;
    uint64_t exposedPicks_ = 0, wallTrips_ = 0;
    uint64_t sprays_ = 0, blocked_ = 0, trips_ = 0, fuelUsed_ = 0, repositions_ = 0;
    void ensure(const GameContext& ctx);
    bool pickStand(const GameContext& ctx, V3 pile, V3 from, float standoff, V3& out, float& facing) const;
    void order(GameContext& ctx, Squad& s, Mem& m, V3 dest, float facing);
};

} // namespace ttz::game
