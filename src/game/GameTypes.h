#pragma once
// Shared vocabulary of the gameplay layer (Phase 7 Stage B). Plain data only: no GPU, no SDL, no ImGui.
// Every other src/game header includes this one; changes here touch every workstream, so keep it small and
// coordinate edits (docs/GAMEPLAY_ARCHITECTURE.md section 4).
#include "render/Math.h"

#include <cstdint>

namespace ttz::game {

// Fixed game tick (AI, combat logic, logistics, economy). The GPU horde keeps its own 60 Hz step (SimParams::fixedDt);
// the game tick runs at 30 Hz from the same scaled frame time (pause / sim speed apply to both).
constexpr double kTickDt = 1.0 / 30.0;
constexpr int kMaxTicksPerFrame = 4;         // beyond this, game time is dropped (like the sim), never spirals

// ---- handles: slot index + generation, so a stale handle never aliases a reused slot -----------------------------
struct Handle {
    uint32_t index = ~0u;
    uint32_t gen = 0;
    bool valid() const { return index != ~0u; }
    bool operator==(const Handle& o) const { return index == o.index && gen == o.gen; }
    bool operator!=(const Handle& o) const { return !(*this == o); }
    uint32_t packed() const { return (index & 0xFFFFu) | (gen << 16); }   // GPU records (hit shooter, kill credit)
};
struct SoldierId : Handle {};
struct SquadId : Handle {};
struct SupplyId : Handle {};

// ---- classes (GAME_DESIGN.md 3: exactly these, no others) --------------------------------------------------------
enum class SoldierClass : uint8_t { Rifleman = 0, MachineGunner = 1, Sniper = 2, Count };
enum class SquadType : uint8_t { Rifle = 0, MachineGun = 1, Sniper = 2, Count };
enum class AmmoType : uint8_t { Rifle = 0, MachineGun = 1, Sniper = 2, Count };   // what a supply point stocks
inline AmmoType ammoOf(SoldierClass c) { return (AmmoType)c; }
inline const char* className(SoldierClass c) { return c == SoldierClass::Rifleman ? "rifleman" : c == SoldierClass::MachineGunner ? "mg" : "sniper"; }

// ---- soldier behaviour (SoldierAI.h: one lightweight state machine) ----------------------------------------------
enum class SoldierState : uint8_t {
    Descending,     // under canopy (Deploy owns position)
    Landing,        // para_land clip
    Recovering,     // para_recover: harness release, weapon draw (weapon_draw event ends it)
    Forming,        // walking to its formation slot after landing
    Idle,           // holding position, scanning
    Moving,         // following the squad's move order
    Engaging,       // aim / fire at a target (may hold or advance per order)
    Reloading,      // reload clip; mag_in event moves rounds reserve -> magazine
    Resupplying,    // walking to a reserved supply-point slot
    Collecting,     // collect_ammo clip at the supply point; grab event transfers ammo
    Hit,            // short hit reaction (not interruptible by retargeting)
    Dying,          // death clip
    Dead,           // body stays (bounded list), slot released when the body is removed
    Count
};
const char* stateName(SoldierState s);

// What the AI asks the animator to show (SoldierAnim.h maps action -> class clip, cross-fades per anims.json).
enum class AnimAction : uint8_t {
    Idle, Walk, Run, Aim, Fire, CrouchAim, CrouchFire, Reload, Hit, Death, CollectAmmo, TurnL, TurnR,
    ParaDescent, ParaLand, ParaRecover, EnterBuilding /* B3a */, Count
};
const char* actionName(AnimAction a);   // anims.json action names ("idle", "para_descent", ...)

// Squad status flags for the UI markers (GAME_DESIGN 14b: low / out of ammo, casualties, moving, resupplying, attacked)
enum SquadFlags : uint32_t {
    SQ_LOW_AMMO = 1u << 0, SQ_OUT_OF_AMMO = 1u << 1, SQ_CASUALTIES = 1u << 2, SQ_MOVING = 1u << 3,
    SQ_RESUPPLYING = 1u << 4, SQ_UNDER_ATTACK = 1u << 5, SQ_DEPLOYING = 1u << 6, SQ_ENGAGED = 1u << 7,
};

// Why a zombie died (rewards may differ per cause; OPEN: owner decides whether non-soldier kills pay).
enum class KillCause : uint8_t { Soldier = 0, Explosion = 1, Other = 2 };

// Deterministic per-entity random stream (same hash as the shaders' pcgHash).
inline uint32_t pcg(uint32_t v) {
    uint32_t s = v * 747796405u + 2891336453u;
    uint32_t w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
inline float rand01(uint32_t& s) { s = pcg(s); return (float)(s & 0x00FFFFFFu) / 16777216.f; }

} // namespace ttz::game
