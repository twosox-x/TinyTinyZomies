#pragma once
// Events passed between gameplay modules inside one game tick (GameWorld owns the queues and clears them per tick).
// Producers append, consumers read; no module calls another module's internals through these.
#include "game/GameTypes.h"

#include <vector>

namespace ttz::game {

// A round leaves a muzzle. Produced by Combat when the animator reports a `muzzle_flash` (or `suppressed`) clip event
// for a soldier whose fire request is active; consumed by HordeBridge (as a HitRequest), Noise, and the renderer (FX).
struct ShotEvent {
    SoldierId shooter;
    SoldierClass cls = SoldierClass::Rifleman;
    V3 origin, dir;                  // muzzle (world), unit direction after spread
    float maxDist = 0.f, damage = 0.f;
    bool headshot = false;           // rolled on the CPU (deterministic stream), applied on the GPU if the ray hits
};

// A zombie died. Read back from the GPU kill ring (HordeBridge); `seq` is strictly increasing over the whole session,
// so a record seen twice (ring slot harvested twice, overlapping readbacks) is dropped by seq <= lastSeq.
struct KillEvent {
    uint64_t seq = 0;
    KillCause cause = KillCause::Other;
    uint32_t shooterPacked = 0;      // Handle::packed() of the shooter (cause Soldier), else 0
    V3 pos;
};

// Spatial noise (GAME_DESIGN 8): gunfire, explosions, landings. Converted to horde attractors by HordeBridge.
struct NoiseEvent {
    V3 pos;
    float intensity = 1.f, radius = 50.f, duration = 4.f;   // config per source (WeaponStats.noise / noiseRadius)
};

// Visual-only FX request for the soldier renderer (muzzle flash, tracer, casing, suppressor puff, dust, impact).
// The animator already knows where the muzzle is at render time; game code only says "soldier X fired".
enum class FxKind : uint8_t { Shot, Footstep, BodyFall, Landing, CrateTouch, Impact, Flame /* flamethrower spray: pos nozzle, dir */ };
struct FxEvent { FxKind kind; SoldierId soldier; V3 pos, dir; };

// Sound-only cues (sessionD/sound, agreed with A): events that have no other source on this bus. Producers push them in
// their own modules; GameAudioBridge consumes and clears them at the end of every tick. Missing cues are simply silent.
enum class AudioCueKind : uint8_t {
    ZombieAggro, ZombieAttack, ZombieReanimate, ZombieRoofFall,
    SoldierHurt, SoldierDeath, CalloutContact, CalloutAmmo, CalloutKill, CalloutPanic, CalloutOrder,
    Reload, EmptyClick, ImpactMetal, ImpactConcrete, ImpactWood,
    AlertAttack, AlertBreach, AlertCasualty, AlertAmmo,
    GenStart, GenStop, GenOutOfFuel, StructureCollapse, TowerCreak, PlaneFlyover, ChuteDeploy, ContainerLand, Radio
};
struct AudioCue { AudioCueKind kind; V3 pos; float intensity = 1.f; };

struct TickEvents {
    std::vector<ShotEvent> shots;
    std::vector<KillEvent> kills;
    std::vector<NoiseEvent> noise;
    std::vector<FxEvent> fx;
    std::vector<AudioCue> cues;
    void clear() { shots.clear(); kills.clear(); noise.clear(); fx.clear(); cues.clear(); }
};

} // namespace ttz::game
