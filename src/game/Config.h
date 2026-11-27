#pragma once
// Balance / tuning values for the gameplay layer, loaded from config/balance.json.
// EVERY value is PROVISIONAL and UNAPPROVED (GAME_DESIGN.md 2 and 14b): the file carries "status": "UNAPPROVED" and the
// UI shows that label while it does. Code never hard-codes a balance number: add a field here and in the JSON.
// Owner: WS-D (economy / logistics / UI). Other workstreams add fields for their module in their own sub-struct.
#include "game/GameTypes.h"

#include <array>
#include <string>

namespace ttz::game {

struct WeaponStats {                 // GAME_DESIGN 14b: configurable weapon stats
    float damage = 0.6f;             // zombie health units per hit (a zombie spawns with health 1.0)
    float headshotChance = 0.15f;    // a hit that kills outright and severs the head (existing gore path)
    float range = 45.f;              // m, max engagement distance
    float accuracy = 0.8f;           // probability scale of a hit at half range (spread cone derived from it)
    float spreadDeg = 1.5f;          // cone half-angle at accuracy 1
    float fireInterval = 0.3f;       // s between rounds (the fire clip's playback rate is scaled to match, clamped)
    int magazine = 30;               // rounds
    int reserve = 180;               // rounds carried besides the magazine
    float reloadTime = 2.4f;         // s (the reload clip's rate is scaled to match, clamped)
    float noise = 1.0f;              // noise intensity per shot (NoiseEvent.intensity)
    float noiseRadius = 80.f;        // m
    float acquireTime = 0.4f;        // s from spotting a target to the first shot
    float acquireRange = 50.f;       // m, spotting distance (>= range: they track before they shoot)
};

struct SoldierStats {
    float health = 100.f;
    float walkSpeed = 1.3f, runSpeed = 3.8f;   // m/s (clip speeds; rate = v / clip speed keeps feet planted)
    float lowAmmoFraction = 0.25f;             // total rounds / full load below which the soldier seeks a supply point
    float resupplySearchRadius = 60.f;         // m
};

struct SquadDef {
    SoldierClass cls = SoldierClass::Rifleman;
    int size = 5;                     // GAME_DESIGN 3 (APPROVED composition): rifle 5, MG 3, sniper 1
    int price = 1000;
    float formationSpacing = 2.0f;    // m
};

struct EconomyConfig {
    double startFunding = 5000;
    double baseIncomePerMin = 300;
    double territoryIncomePerKm2PerMin = 0;    // B2
    std::array<double, 3> killReward = {5, 0, 0};   // per KillCause (Soldier, Explosion, Other)
    int containerPrice = 1500, airdropPrice = 400;
};

struct LogisticsConfig {
    std::array<int, kAmmoTypes> containerStock = {3000, 2000, 300, 1200};   // rounds per AmmoType (Fuel: flamethrower fuel units)
    std::array<int, kAmmoTypes> crateStock = {600, 400, 60, 300};
    int containerSlots = 4, crateSlots = 2;                   // soldiers collecting at once (others queue)
    float collectRadius = 1.2f;                               // m from a slot
    float airdropAltitude = 60.f;                             // m above the landing surface
    float airdropScatter = 4.f;                               // m
    int runnerCarryMagazines = 6;    // ammo runner: magazines of his class carried for squad mates beyond his own load
    float runnerTrigger = 0.45f;     // squad rounds / full load below which the runner goes (before anyone runs dry)
};

struct ZombieThreatConfig {          // zombies vs soldiers (HordeBridge)
    float attackReach = 0.9f;        // m, soldier capsule surface to zombie centre
    float damagePerSecond = 12.f;    // per attacking zombie
    float awarenessRadius = 60.f;    // m: zombies farther from any attractor do not chase (wander)
    float soldierAttraction = 1.0f;  // attractor strength of a soldier: multiplies the awareness reach (awarenessRadius x strength)
};

struct ReanimationConfig {          // GAME_DESIGN 14c (APPROVED rule): dead soldiers rise again as tougher zombies
    bool enabled = true;
    float delayMin = 8.f, delayMax = 20.f;   // s the body lies dead before it starts to rise (uniform per soldier)
    float riseTime = 1.6f;           // s of the get-up transition before the zombie agent takes over
    float healthMul = 3.f;           // zombie health x (a normal zombie spawns with 1.0): harder to kill (headshots still kill)
};

struct StaminaConfig {               // soldiers run by default when they can; stamina limits sprinting
    float max = 100.f;
    float drainRun = 5.f;            // per s while running (100 -> 0 in 20 s)
    float regenWalk = 6.f;           // per s while walking
    float regenRest = 12.f;          // per s while standing (idle, engaging, reloading, ...)
    float minToRun = 15.f;           // below this a soldier walks until he has recovered to resumeRun
    float resumeRun = 40.f;
    float sprintScale = 1.15f;       // run speed x when threatened and fresh (clip rate follows: no foot sliding)
    float threatRadius = 30.f;       // m: zombies this close (or an attack) make it a high-stakes move
};

struct FortConfig {                  // B2 walls, territory, containers (GAME_DESIGN 5 / 14b / 14c); every value UNAPPROVED
    std::array<int, 2> wallPrice = {40, 110};         // per 4 m piece: cheap (1.6 m gabion), reinforced (2.4 m)
    std::array<float, 2> wallHealth = {600.f, 1800.f};
    std::array<float, 2> wallHeight = {1.6f, 2.4f};    // collision height above the ground (approved assets)
    float gatePriceMul = 3.f;        // gate piece price = wall piece price x this (PROPOSED gate)
    float damagePerZombie = 1.0f;    // hp / s per zombie pressing on a piece beyond the threshold
    int pressureThreshold = 3;       // zombies a piece shrugs off (a few stragglers never breach)
    float buildTime = 0.6f;          // s: rise animation (collision is immediate; no construction delay yet)
    float territoryCell = 1.0f;      // m: territory raster
    float minRegionArea = 16.f;      // m^2: smaller pockets are not territory
    double incomePerHectarePerMin = 1000;   // controlled area -> passive income
    float clearDelay = 3.f;          // s an enclosed region must stay free of zombies before it is controlled
    float lossTime = 20.f;           // s zombies may stay inside a controlled region before ownership is lost (income paused meanwhile)
    bool containerNeedsTerritory = false;   // PROPOSED false: containers also close gaps (14c), so they cannot need territory
    float containerAltitude = 40.f;  // m above the landing surface
    float containerDescentSpeed = 7.f;       // m/s: heavier than a crate (two cargo canopies)
    float containerLandDuration = 1.0f;     // s from touchdown until it is usable
};

// Engineers (GAME_DESIGN 14d, APPROVED squad of 3; every value UNAPPROVED / PROPOSED): construction jobs (walls, gates,
// gates placed into walls) and car clearing are only possible within `radius` of an engineer squad and take time.
struct EngineerConfig {
    float radius = 40.f;             // m around an engineer squad (its post / anchor) where construction can be ordered
    float pieceTime = 6.f;           // engineer-seconds per 4 m wall piece (shorter pieces pro rata, min 30 %); 3 men: 2 s
    float gateTime = 9.f;            // engineer-seconds per gate (new, or converting a wall piece into a gate)
    float carTime = 24.f;            // engineer-seconds to tow / dismantle one parked car
    int carPrice = 50;               // per car cleared (UNAPPROVED)
    float workRange = 3.2f;          // m from his work spot where an engineer works (crouch / collect loop)
    float carSearch = 3.f;           // m: a click selects the parked vehicle whose box is within this
};

struct BuildingConfig {              // B3a buildings (GAME_DESIGN 6 / 7 / 14b); every value UNAPPROVED / PROPOSED
    float captureTime = 5.f;         // s a squad must hold an entrance (no zombie inside / at the door) to capture
    float captureRadius = 7.f;       // m from an entrance (or inside the footprint) that counts as "at the building"
    float doorClearRadius = 6.f;     // m around the entrance that must be free of zombies (exact contact lists)
    int garrisonPrice = 150;         // role cost (UNAPPROVED)
    int hospitalPrice = 250;         // role cost (UNAPPROVED)
    int garrisonAmmo = 600;          // rounds stocked in the garrison ammo stack (posted soldiers refill from it)
    int hospitalBeds = 4;            // patients treated at once (PROPOSED)
    float healRate = 6.f;            // hp / s per patient (PROPOSED)
    float hospitalSearch = 150.f;    // m: wounded soldiers seek a hospital within this
    float dischargeFraction = 0.95f; // patients leave at this fraction of max health
    int maxFloors = 12;              // taller buildings are unsupported (towers: no usable firing floors yet)
    int windowFloors = 3;            // garrison windows only on floors 1..N (lower floors facing streets)
    float windowSpacing = 4.f;       // m between window positions along a facade
    float roofSpacing = 5.f;         // m between roof-edge positions
    int maxPositions = 12;           // firing positions per building (capacity cap)
    std::array<int, 3> barricadePrice = {30, 80, 60};            // planks, plate, sandbags (UNAPPROVED)
    std::array<float, 3> barricadeHealth = {300.f, 1200.f, 800.f};
    float breachDps = 4.f;           // hp / s per zombie pressing at a barricaded opening (CPU fallback until B3b)
    int nestPrice = 60;              // fort_window_nest / fort_roof_ring at a firing position (UNAPPROVED)
    float nestDamageScale = 0.6f;    // contact damage taken at a position with a nest (defence value, PROPOSED)
};

// B3b zombies in buildings (HordeVertical, GAME_DESIGN 7): every value UNAPPROVED. Barricade breach damage per zombie is
// BuildingConfig::breachDps (shared with B3a's fallback).
struct VerticalConfig {
    float walkSpeed = 1.1f;          // interior horizontal speed (m/s): door -> stair core
    float climbTimePerFloor = 4.5f;  // s per flight of stairs (one floor)
    float doorTime = 1.0f;           // s to squeeze through a door
    float hatchTime = 1.5f;          // s to climb out of the roof hatch
    int doorCapacity = 3;            // occupants in a doorway at once (more queue outside)
    int stairCapacity = 6;           // occupants on one flight at once (congestion at the stairs)
    int floorCapacity = 60;          // occupants on the soldiers' floor (fighting)
    int hatchCapacity = 2;
    float captureRadius = 1.2f;      // m around the door's street-side point
    float breachPerZombie = 4.0f;    // barricade health per second per battering zombie (game: BuildingConfig::breachDps)
    float defenderDps = 0.6f;        // zombie health per second per soldier on that floor (interior fight)
    int attackersPerSoldier = 3;     // at most this many occupants attack one soldier on its floor
    float entranceRadius = 1.5f;     // attractor footprint at a door
    float routeWeight = 0.5f;        // reach lost per metre of interior route (doors of tall buildings pull less far)
    float minReachFraction = 0.8f;
};

// GAME_DESIGN 14d (APPROVED mechanic, values UNAPPROVED): corpses rot and give off poisonous gas (CorpseGas.h).
struct RotConfig {
    bool enabled = true;
    float delay = 45.f;              // s a corpse lies before it starts to rot (gas emission starts)
    float ramp = 120.f;              // s from the start of rot to full emission (the gas spreads further the longer they stay)
    float emitPerCorpse = 0.010f;    // gas units / s per fully rotten corpse into its 2 m cell
    float diffusion = 0.30f;         // fraction exchanged with the 4 neighbours per second (spread)
    float decay = 0.020f;            // fraction lost per second (open air); a cleared pile's gas fades in ~1-2 min
    float maxGas = 4.f;              // cell cap (gas units)
    float damageThreshold = 0.15f;   // gas level below which troops take no damage (faint haze is only a warning)
    float damagePerSecond = 1.5f;    // hp / s at gas level 1 (scales linearly, capped at maxDamagePerSecond)
    float maxDamagePerSecond = 5.f;
    float warnLevel = 0.10f;         // squad "gas" pip / UI warning above this level at a member
    float navAvoidLevel = 0.35f;     // soldier paths treat cells above this as expensive (NavGrid cost), not blocked
    float navCost = 6.f;             // extra A* cost per cell at gas level 1 (scaled, capped at 4 x)
};

// Flamethrower squad (GAME_DESIGN 14d; size PROPOSED 2, every value UNAPPROVED). Weapon stats (fuel tank = magazine, spare
// tanks = reserve, one fuel unit per spray tick = fireInterval) are in weapons.flamethrower like any other class.
struct FlameConfig {
    float coneDeg = 18.f;            // half angle of the flame cone
    float zombieDps = 1.6f;          // zombie health / s inside the cone (a zombie spawns with 1.0)
    float groundFireTime = 4.f;      // s a sprayed 2 m cell keeps burning (contained: fire never spreads)
    float groundFireDps = 0.5f;      // zombie health / s standing in ground fire
    float corpseIgnite = 0.6f;       // s of spray / ground fire a corpse needs to ignite
    float corpseBurnTime = 4.f;      // s a burning corpse burns before it is gone (removed from the corpse field and list)
    float seekRadius = 35.f;         // m: leash around the squad's post where it seeks rotting piles / gas on its own
    float seekInterval = 2.f;        // s between autonomous target picks
    int seekMinCorpses = 3;          // corpses in a 2 m cell (or gas above rot.warnLevel) worth a trip
    float standoff = 6.f;            // m from the pile to spray from
    float friendlyClearance = 1.2f;  // m: never spray while a squad mate / soldier is inside the cone + this margin
};

struct BalanceConfig {
    std::string status = "UNAPPROVED";   // anything else must come from an owner decision
    std::array<WeaponStats, kSoldierClasses> weapon;   // per SoldierClass
    std::array<SoldierStats, kSoldierClasses> soldier;
    std::array<SquadDef, kSquadTypes> squad;       // per SquadType
    EconomyConfig economy;
    LogisticsConfig logistics;
    ZombieThreatConfig threat;
    FortConfig fort;
    ReanimationConfig reanimation;
    StaminaConfig stamina;
    BuildingConfig buildings;
    VerticalConfig vertical;             // B3b
    EngineerConfig engineer;             // GAME_DESIGN 14d engineers (EngineerAI)
    RotConfig rot;                       // GAME_DESIGN 14d corpse rot gas (CorpseGas)
    FlameConfig flame;                   // GAME_DESIGN 14d flamethrower squad (FlameAI / CorpseGas)
    bool load(const std::string& path, std::string* error = nullptr);   // missing keys keep the defaults above
    bool approved() const { return status == "APPROVED"; }
};

} // namespace ttz::game
