#include "audio/GameAudioBridge.h"

#include "app/App.h"
#include "audio/Audio.h"
#include "game/GameEvents.h"
#include "game/Soldiers.h"
#include "game/HordeInterface.h"

#include <vector>

namespace ttz::audio {
namespace {
uint64_t fxFrame = ~0ull;      // fx is cleared once per frame (GameWorld::preSim) and filled by every tick of the frame
size_t fxSeen = 0;
uint32_t lastFallSplats = 0, lastReactivated = 0;
bool statsInit = false;
uint32_t killCount = 0;
std::vector<uint8_t> wasAlive;
std::vector<uint8_t> wasNear;    // zombie aggro: a soldier's 8 m threat ring goes from empty to occupied
uint32_t attackTick = 0;   // casualty detection (alive -> dying / dead)

Ev cueEv(game::AudioCueKind k) {
    using K = game::AudioCueKind;
    switch (k) {
        case K::ZombieAggro: return Ev::ZombieAggro;         case K::ZombieAttack: return Ev::ZombieAttack;
        case K::ZombieReanimate: return Ev::ZombieReanimate; case K::ZombieRoofFall: return Ev::ZombieFall;
        case K::SoldierHurt: return Ev::SoldierHurt;         case K::SoldierDeath: return Ev::SoldierDeath;
        case K::CalloutContact: return Ev::CalloutContact;   case K::CalloutAmmo: return Ev::CalloutAmmo;
        case K::CalloutKill: return Ev::CalloutKill;         case K::CalloutPanic: return Ev::CalloutPanic;
        case K::CalloutOrder: return Ev::CalloutOrder;       case K::Reload: return Ev::Reload;
        case K::EmptyClick: return Ev::EmptyClick;           case K::ImpactMetal: return Ev::ImpactMetal;
        case K::ImpactConcrete: return Ev::ImpactConcrete;   case K::ImpactWood: return Ev::ImpactWood;
        case K::AlertAttack: return Ev::AlertAttack;         case K::AlertBreach: return Ev::AlertBreach;
        case K::AlertCasualty: return Ev::AlertCasualty;     case K::AlertAmmo: return Ev::AlertAmmo;
        case K::GenStart: return Ev::GenStart;               case K::GenStop: return Ev::GenStop;
        case K::GenOutOfFuel: return Ev::GenOutOfFuel;       case K::StructureCollapse: return Ev::StructureCollapse;
        case K::TowerCreak: return Ev::TowerCreak;           case K::PlaneFlyover: return Ev::PlaneFlyover;
        case K::ChuteDeploy: return Ev::ChuteDeploy;         case K::ContainerLand: return Ev::ContainerLand;
        case K::Radio: return Ev::Radio;
        case K::ZombieAttackWood: return Ev::ZombieAttackWood;   case K::ZombieAttackMetal: return Ev::ZombieAttackMetal;
        case K::ZombieAttackSandbag: return Ev::ZombieAttackSandbag; case K::TowerClimb: return Ev::TowerClimb;
    }
    return Ev::Radio;
}
} // namespace

void bridgeTick(const AppState& app, game::TickEvents& ev, const game::SoldierPool& soldiers, const std::vector<game::SoldierContact>& contacts) {
    using game::SoldierClass; using game::FxKind; using game::KillCause;
    for (const game::ShotEvent& s : ev.shots) {
        switch (s.cls) {
            case SoldierClass::Rifleman: emit(Ev::ShotRifle, s.origin); break;
            case SoldierClass::MachineGunner: emit(Ev::ShotMG, s.origin); break;
            case SoldierClass::Sniper: emit(Ev::ShotSniper, s.origin); break;
            default: break;   // flamethrower: FxKind::Flame drives the roar loop
        }
    }
    for (const game::KillEvent& k : ev.kills) {
        if (k.cause == KillCause::Explosion) { if ((++killCount & 3u) == 0) emit(Ev::Gore, k.pos); continue; }
        emit(Ev::ZombieDeath, k.pos);
        if ((++killCount % 5u) == 0) emit(Ev::Gore, k.pos, 0.7f);
    }
    if (app.frameIndex != fxFrame || ev.fx.size() < fxSeen) { fxFrame = app.frameIndex; fxSeen = 0; }
    for (size_t i = fxSeen; i < ev.fx.size(); ++i) {
        const game::FxEvent& f = ev.fx[i];
        switch (f.kind) {
            case FxKind::Footstep: emit(Ev::Footstep, f.pos); break;
            case FxKind::BodyFall: emit(Ev::BodyFall, f.pos); break;
            case FxKind::Landing: emit(Ev::Landing, f.pos); break;
            case FxKind::CrateTouch: emit(Ev::CrateLand, f.pos); break;
            case FxKind::Impact: emit(Ev::ImpactFlesh, f.pos); break;   // no material on the bus yet: flesh (agreed default)
            case FxKind::Flame: emit(Ev::Flame, f.pos); break;
            case FxKind::Shot: break;                                   // ShotEvent already covers it
        }
    }
    fxSeen = ev.fx.size();
    if (wasAlive.size() < soldiers.capacity()) wasAlive.resize(soldiers.capacity(), 0);
    for (uint32_t i = 0; i < (uint32_t)soldiers.capacity(); ++i) {
        const bool a = soldiers.alive(i);
        if (wasAlive[i] && !a && soldiers.used[i]) { emit(Ev::SoldierDeath, soldiers.pos[i]); emit(Ev::AlertCasualty, soldiers.pos[i]); }
        wasAlive[i] = a;
    }
    // zombie aggro / attacks on soldiers from the horde's soldier contacts (no separate source on the bus)
    if (wasNear.size() < soldiers.capacity()) wasNear.resize(soldiers.capacity(), 0);
    ++attackTick;
    for (const game::SoldierContact& c : contacts) {
        const uint32_t i = c.packedId & 0xFFFFu;
        if (i >= wasNear.size() || !soldiers.alive(i)) continue;
        const V3 zp = c.nNear ? c.nearPos[0] : soldiers.pos[i];
        if (c.nearby > 0 && !wasNear[i]) emit(Ev::ZombieAggro, zp);
        wasNear[i] = c.nearby > 0;
        if (c.attackers > 0 && ((attackTick + i) % 12u) == 0) emit(Ev::ZombieAttack, zp, std::min(1.5f, 0.7f + 0.1f * c.attackers));
    }
    for (const game::AudioCue& c : ev.cues) emit(cueEv(c.kind), c.pos, c.intensity);
    ev.cues.clear();
    // horde aggregate + GPU-side counters (roof-edge falls, reanimations) from the sim stats readback
    const SimStats& st = app.sim.stats();
    if (!statsInit) { lastFallSplats = st.fallSplats; lastReactivated = st.reactivated; statsInit = true; }
    const V3 c = app.camera.target();
    for (uint32_t n = st.fallSplats > lastFallSplats ? std::min(3u, st.fallSplats - lastFallSplats) : 0; n; --n) emit(Ev::ZombieFall, c);
    for (uint32_t n = st.reactivated > lastReactivated ? std::min(2u, st.reactivated - lastReactivated) : 0; n; --n) emit(Ev::ZombieReanimate, c);
    lastFallSplats = st.fallSplats; lastReactivated = st.reactivated;
    setHorde(st.live);
    const float h = app.renderSettings.tod.hours;
    setNight(h >= 18.f || h < 6.f);
}

} // namespace ttz::audio
