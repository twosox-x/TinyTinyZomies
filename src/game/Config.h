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
    std::array<int, 3> containerStock = {3000, 2000, 300};   // rounds per AmmoType
    std::array<int, 3> crateStock = {600, 400, 60};
    int containerSlots = 4, crateSlots = 2;                   // soldiers collecting at once (others queue)
    float collectRadius = 1.2f;                               // m from a slot
    float airdropAltitude = 60.f;                             // m above the landing surface
    float airdropScatter = 4.f;                               // m
};

struct ZombieThreatConfig {          // zombies vs soldiers (HordeBridge)
    float attackReach = 0.9f;        // m, soldier capsule surface to zombie centre
    float damagePerSecond = 12.f;    // per attacking zombie
    float awarenessRadius = 60.f;    // m: zombies farther from any attractor do not chase (wander)
    float soldierAttraction = 1.0f;  // attractor strength of a soldier (nav distance offset, m-equivalent)
};

struct BalanceConfig {
    std::string status = "UNAPPROVED";   // anything else must come from an owner decision
    std::array<WeaponStats, 3> weapon;   // per SoldierClass
    std::array<SoldierStats, 3> soldier;
    std::array<SquadDef, 3> squad;       // per SquadType
    EconomyConfig economy;
    LogisticsConfig logistics;
    ZombieThreatConfig threat;
    bool load(const std::string& path, std::string* error = nullptr);   // missing keys keep the defaults above
    bool approved() const { return status == "APPROVED"; }
};

} // namespace ttz::game
