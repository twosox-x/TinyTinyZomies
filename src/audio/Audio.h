#pragma once
// Tiny Tiny Zombies audio (sessionD/sound, Phase 2). SDL3 audio stream + a small software mixer.
//
//   audio::init(assetsRoot, enabled)      once, after SDL_Init. enabled=false (--no-audio): every call is a no-op
//   audio::emit(Ev, pos, intensity)       a world sound (positional), from GameAudioBridge (TickEvents) or App (blasts)
//   audio::ui(name)                       a UI sound by bank name (non-positional), e.g. "ui_tab"
//   audio::frame(camTarget, camHeight, camYaw, dt)   once per rendered frame: listener + horde/ambience + mixing
//   audio::setHorde(live) / setNight(bool)            aggregate state (horde loops, day / night ambience)
//   audio::shutdown()                     prints the event counters (headless verification)
//
// Mixing rules (approved preview, docs/SOUND_APPROVALS.md):
//   - buses sfx / voice / ambience / ui / music(placeholder)
//   - stereo pan + distance falloff around the camera target; the audible radius grows with camera height
//   - camera height crossfade: individual voices and steps dominate close up, aggregated horde / squad loops far away
//   - voice limit (48) with priority + per-sound rate limits; 1000 zombies = 3 layered loops scaled by count, not 1000 voices
//   - random variation per play
#include "render/Math.h"

#include <cstdint>
#include <string>

namespace ttz::audio {

enum class Ev : uint16_t {
    ShotRifle, ShotMG, ShotSniper, ShotCarbine, Reload, EmptyClick,
    ImpactFlesh, ImpactMetal, ImpactConcrete, ImpactWood,
    Explosion, FireWhoosh,
    ZombieAggro, ZombieAttack, ZombieDeath, ZombieReanimate, ZombieFall, Gore,
    Footstep, BodyFall, Landing, CrateLand, ContainerLand, PlaneFlyover, ChuteDeploy,
    Flame, FlameStop,
    CalloutContact, CalloutAmmo, CalloutKill, CalloutPanic, CalloutOrder, SoldierHurt, SoldierDeath, Radio,
    GenStart, GenStop, GenOutOfFuel, StructureCollapse, TowerCreak,
    AlertAttack, AlertBreach, AlertAmmo, AlertCasualty, DayNight,
    ZombieAttackWood, ZombieAttackMetal, ZombieAttackSandbag, TowerClimb,
    Count
};
const char* evName(Ev e);

struct Stats {
    uint64_t emitted[(size_t)Ev::Count] = {};
    uint64_t uiPlayed = 0, started = 0, rateLimited = 0, culledFar = 0, stolen = 0, dropped = 0, missing = 0;
    int peakVoices = 0, clips = 0, sounds = 0;
    uint64_t framesMixed = 0;
    bool enabled = false, deviceOpen = false;
    std::string driver;
};

bool init(const std::string& sfxDir, bool enabled, bool headless = false);   // sfxDir = assets/audio/sfx
void shutdown();
void emit(Ev e, V3 pos, float intensity = 1.f);
void ui(const char* name);
void uiAction(const std::string& actionId, bool ok);   // HUD card / selection action clicked (ok=false: refused)
void setHorde(uint32_t live);
void setNight(bool night);
void setMusicVolume(float linear);      // independent music volume (1 = config level)
void setMusicIntensity(float v);        // manual intensity 0..1 for testing; < 0 = automatic (battlefield data)
float musicIntensity();
void frame(V3 camTarget, float camHeight, float camYaw, float dt);
const Stats& stats();
bool enabled();

} // namespace ttz::audio
