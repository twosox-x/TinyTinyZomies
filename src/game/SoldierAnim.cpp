// Soldier animation playback in the game tick (WS-B). See SoldierAnim.h.
#include "game/SoldierAnim.h"

#include "game/Config.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
const char* clipName(AnimAction a) {
    switch (a) {
    case AnimAction::Idle: return "idle";
    case AnimAction::Walk: return "walk";
    case AnimAction::Run: return "run";
    case AnimAction::Aim: return "aim";
    case AnimAction::Fire: return "fire";
    case AnimAction::CrouchAim: return "crouch_aim";
    case AnimAction::CrouchFire: return "crouch_fire";
    case AnimAction::Reload: return "reload";
    case AnimAction::Hit: return "hit";
    case AnimAction::Death: return "death_a";
    case AnimAction::CollectAmmo: return "collect_ammo";
    case AnimAction::TurnL: return "turn_l";
    case AnimAction::TurnR: return "turn_r";
    case AnimAction::ParaDescent: return "para_descent";
    case AnimAction::ParaLand: return "para_land";
    case AnimAction::ParaRecover: return "para_recover";
    case AnimAction::EnterBuilding: return "enter_building";
    case AnimAction::BuildHammer: return "build_hammer";
    case AnimAction::BuildShovel: return "build_shovel";
    case AnimAction::BuildSandbag: return "build_sandbag";
    case AnimAction::CutCar: return "cut_car";
    case AnimAction::PryCar: return "pry_car";
    case AnimAction::FlameIgnite: return "ignite";
    case AnimAction::FlameStop: return "stop";
    case AnimAction::BurnGround: return "burn_ground";
    default: return "idle";
    }
}
int exactClip(const MilInfantry& inf, const char* name) {   // exact name only (no substring fallback: "fire" vs "crouch_fire")
    for (size_t i = 0; i < inf.clips.size(); ++i) if (inf.clips[i].available && inf.clips[i].name == name) return (int)i;
    return -1;
}
// what a one-shot leaves to when the request that started it is still standing
AnimAction fallbackOf(AnimAction a) {
    switch (a) {
    case AnimAction::Reload: return AnimAction::Aim;
    case AnimAction::ParaLand: return AnimAction::ParaRecover;
    default: return AnimAction::Idle;
    }
}
const char* endEvent(AnimAction a) {
    switch (a) {
    case AnimAction::Reload: return "reload_end";
    case AnimAction::CollectAmmo: return "collect_end";
    case AnimAction::Hit: return "hit_end";
    case AnimAction::Death: return "death_end";
    case AnimAction::ParaLand: return "land_end";
    case AnimAction::ParaRecover: return "recover_end";
    case AnimAction::TurnL: case AnimAction::TurnR: return "turn_end";
    default: return nullptr;
    }
}
} // namespace

bool SoldierAnimator::oneShot(AnimAction a) {
    return a == AnimAction::Reload || a == AnimAction::Hit || a == AnimAction::CollectAmmo || a == AnimAction::TurnL || a == AnimAction::TurnR ||
           a == AnimAction::ParaLand || a == AnimAction::ParaRecover || a == AnimAction::EnterBuilding || a == AnimAction::FlameIgnite ||
           a == AnimAction::FlameStop;
}

bool SoldierAnimator::init(const MilitaryLibrary& lib) {
    lib_ = &lib;
    inf_.clear();
    float spacing[3] = {0, 0, 0};
    for (const MilInfantry& inf : lib.infantry) {
        InfClips ic;
        ic.cls = inf.cls == "mg" ? 1 : inf.cls == "sniper" ? 2 : 0;
        for (int a = 0; a < (int)AnimAction::Count; ++a) ic.clip[(size_t)a] = exactClip(inf, clipName((AnimAction)a));
        for (int a = 0; a < (int)AnimAction::Count; ++a)   // placeholders / missing clips: substring match, else idle
            if (ic.clip[(size_t)a] < 0) ic.clip[(size_t)a] = milClipByAction(inf, clipName((AnimAction)a));
        const char* deaths[3] = {"death_a", "death_b", "death_c"};
        for (int k = 0; k < 3; ++k) ic.death[k] = exactClip(inf, deaths[k]);
        for (int k = 0; k < 3; ++k) if (ic.death[k] < 0) ic.death[k] = ic.clip[(size_t)AnimAction::Death];
        auto speedOf = [&](AnimAction a, float def) {
            int c = ic.clip[(size_t)a];
            if (c < 0 || inf.clips[(size_t)c].keyClip < 0) return def;
            float v = lib.keyClips[(size_t)inf.clips[(size_t)c].keyClip].speed;
            return v > 0.f ? v : def;
        };
        ic.walkSpeed = speedOf(AnimAction::Walk, 1.3f);
        ic.runSpeed = speedOf(AnimAction::Run, 3.8f);
        int fc = ic.clip[(size_t)AnimAction::Fire];
        if (spacing[ic.cls] == 0.f && fc >= 0 && inf.clips[(size_t)fc].keyClip >= 0) {
            const MilKeyClip& k = lib.keyClips[(size_t)inf.clips[(size_t)fc].keyClip];
            int n = 0;
            for (const MilFxEvent& e : k.events) n += e.type == "muzzle_flash" ? 1 : 0;
            if (n > 0) spacing[ic.cls] = k.duration / (float)n;
        }
        inf_.push_back(ic);
    }
    for (int c = 0; c < 3; ++c) if (spacing[c] > 0.f) shotInterval_[c] = spacing[c];
    return !inf_.empty();
}

void SoldierAnimator::configure(const BalanceConfig& cfg) {
    for (int c = 0; c < 3; ++c) setWeaponTiming((SoldierClass)c, cfg.weapon[(size_t)c].fireInterval, cfg.weapon[(size_t)c].reloadTime);
}

void SoldierAnimator::setWeaponTiming(SoldierClass c, float fireInterval, float reloadTime) {
    if ((unsigned)c >= 3u) return;
    fireInterval_[(int)c] = fireInterval;
    reloadTime_[(int)c] = reloadTime;
}

float SoldierAnimator::clipShotInterval(SoldierClass c) const { return (unsigned)c < 3u ? shotInterval_[(int)c] : 0.3f; }

int SoldierAnimator::clipFor(int infantry, AnimAction action, uint8_t deathVariant) const {
    if (infantry < 0 || infantry >= (int)inf_.size() || (int)action >= (int)AnimAction::Count) return -1;
    const InfClips& ic = inf_[(size_t)infantry];
    if (action == AnimAction::Death) return ic.death[std::clamp((int)deathVariant - 1, 0, 2)];
    int c = ic.clip[(size_t)action];
    return c >= 0 ? c : ic.clip[(size_t)AnimAction::Idle];
}

float SoldierAnimator::clipLength(int infantry, int clip) const {
    if (!lib_ || infantry < 0 || infantry >= (int)lib_->infantry.size()) return 0.f;
    const MilInfantry& inf = lib_->infantry[(size_t)infantry];
    return clip >= 0 && clip < (int)inf.clips.size() ? inf.clips[(size_t)clip].length : 0.f;
}

void SoldierAnimator::reset(AnimPlayback& a, int infantry, AnimAction start) {
    a = AnimPlayback{};
    a.action = a.requested = start;
    a.clip = clipFor(infantry, start, a.deathVariant ? a.deathVariant : 1);
    a.locked = oneShot(start) || start == AnimAction::ParaDescent || start == AnimAction::Death;
    a.fresh = true;
}

void SoldierAnimator::request(AnimPlayback& a, AnimAction action, float speed) {
    // edge: a new one-shot request (not the one already playing, e.g. started as the fallback of the previous one)
    if (oneShot(action) && a.requested != action && !(a.action == action && !a.ended)) a.pending = true;
    a.requested = action;
    a.requestedSpeed = speed;
}

bool SoldierAnimator::finished(const AnimPlayback& a, int infantry) const {
    if (!lib_ || infantry < 0 || infantry >= (int)lib_->infantry.size()) return true;
    const MilInfantry& inf = lib_->infantry[(size_t)infantry];
    if (a.clip < 0 || a.clip >= (int)inf.clips.size()) return true;
    const MilClip& c = inf.clips[(size_t)a.clip];
    return !c.loop && a.t >= std::max(1.f / 30.f, c.length) - 1e-4f;
}

void SoldierAnimator::emit(std::vector<AnimEvent>& ev, uint32_t s, const char* type, float t, AnimAction a) const {
    AnimEvent e;
    e.soldier = s; e.type = type; e.t = t; e.action = a;
    ev.push_back(std::move(e));
}

float SoldierAnimator::rateFor(const InfClips& ic, const AnimPlayback& a, AnimAction act) const {
    const int cls = ic.cls;
    switch (act) {
    case AnimAction::Fire:
    case AnimAction::CrouchFire:
        return fireInterval_[cls] > 0.f ? std::clamp(shotInterval_[cls] / fireInterval_[cls], 0.6f, 1.8f) : 1.f;
    case AnimAction::Reload: {
        const float len = clipLength((int)(&ic - inf_.data()), ic.clip[(size_t)AnimAction::Reload]);
        return reloadTime_[cls] > 0.f && len > 0.f ? std::clamp(len / reloadTime_[cls], 0.6f, 1.8f) : 1.f;
    }
    case AnimAction::Walk: return a.requestedSpeed > 0.f ? std::clamp(a.requestedSpeed / ic.walkSpeed, 0.5f, 1.6f) : 1.f;
    case AnimAction::Run: return a.requestedSpeed > 0.f ? std::clamp(a.requestedSpeed / ic.runSpeed, 0.5f, 1.6f) : 1.f;
    default: return 1.f;
    }
}

// Switch to the clip of `act` (cross-fade per the transition table; committed root motion of the clip left -> rootDelta).
void SoldierAnimator::start(uint32_t soldier, int infantry, AnimPlayback& a, AnimAction act, std::vector<AnimEvent>& events, float rootDelta[3]) {
    const MilInfantry& inf = lib_->infantry[(size_t)infantry];
    if (act == AnimAction::Death && a.deathVariant == 0) a.deathVariant = (uint8_t)(1 + pcg(soldier * 2654435761u + 17u) % 3u);
    const int clip = clipFor(infantry, act, a.deathVariant ? a.deathVariant : 1);
    a.action = act;
    a.locked = oneShot(act) || act == AnimAction::ParaDescent || act == AnimAction::Death;
    a.ended = false;
    if (clip >= 0 && clip != a.clip) {
        V3 p{};
        float y = 0.f;
        milSwitchClip(*lib_, inf, a, p, y, clip);
        rootDelta[0] += p.x; rootDelta[1] += p.z; rootDelta[2] += y;
        a.fresh = true;
    } else if (clip >= 0 && oneShot(act)) {   // the same one-shot again (reload twice): restart from 0
        a.t = 0.f;
        a.fresh = true;
    }
    if (act == AnimAction::Reload) emit(events, soldier, "reload_start", 0.f, act);
}

AnimPlayback SoldierAnimator::sampleAhead(const AnimPlayback& a0, int infantry, float ahead) const {
    AnimPlayback a = a0;
    if (!lib_ || infantry < 0 || infantry >= (int)lib_->infantry.size() || ahead <= 0.f) return a;
    V3 p{};
    float y = 0.f;
    milAdvance(*lib_, lib_->infantry[(size_t)infantry], a, p, y, ahead);
    return a;
}

void SoldierAnimator::tick(uint32_t soldier, int infantry, AnimPlayback& a, float dt, std::vector<AnimEvent>& events, float rootDelta[3]) {
    rootDelta[0] = rootDelta[1] = rootDelta[2] = 0.f;
    if (!lib_ || infantry < 0 || infantry >= (int)lib_->infantry.size() || infantry >= (int)inf_.size()) { a.t += dt * a.rate; return; }
    const InfClips& ic = inf_[(size_t)infantry];
    const MilInfantry& inf = lib_->infantry[(size_t)infantry];
    if (a.clip < 0) { a.clip = clipFor(infantry, a.action, a.deathVariant ? a.deathVariant : 1); a.fresh = true; }

    // ---- decide what plays this tick
    const AnimAction want = a.requested;
    const bool done = finished(a, infantry);
    if (a.action == AnimAction::Death) {
        // holds the last frame until reset()
    } else if (want == AnimAction::Death) {
        start(soldier, infantry, a, AnimAction::Death, events, rootDelta);   // always wins
        a.pending = false;
    } else {
        bool free = !a.locked;
        if (a.locked && a.action == AnimAction::ParaDescent) free = want == AnimAction::ParaLand || want == AnimAction::ParaRecover;
        else if (a.locked && done) free = true;
        if (free) {
            AnimAction next = want;
            if (oneShot(want) && !a.pending) next = a.action == want && !done ? want : fallbackOf(want);   // stale request: its clip already played
            if (next == AnimAction::Walk && a.requestedSpeed > ic.walkSpeed * 1.6f) next = AnimAction::Run;   // speed matching
            else if (next == AnimAction::Run && a.requestedSpeed > 0.f && a.requestedSpeed < ic.runSpeed * 0.5f) next = AnimAction::Walk;
            if (next != a.action || (oneShot(next) && a.pending)) {
                start(soldier, infantry, a, next, events, rootDelta);
                if (oneShot(next)) a.pending = false;
            } else if (a.locked && done) a.locked = false;   // a one-shot finished and nothing new: hold it unlocked
        }
    }
    a.rate = rateFor(ic, a, a.action);

    // ---- advance + events
    const bool fresh = a.fresh;
    a.fresh = false;
    V3 p{};
    float y = 0.f;
    MilAdvance r = milAdvance(*lib_, inf, a, p, y, dt);
    rootDelta[0] += p.x; rootDelta[1] += p.z; rootDelta[2] += y;   // looping root motion (stairs): per cycle
    if (r.key)
        for (const MilFxEvent& e : r.key->events) {
            const bool hit = fresh ? (r.wrapped ? (e.t >= r.prev || e.t <= a.t) : (e.t >= r.prev && e.t <= a.t)) : r.crossed(e.t, a.t);
            if (hit) emit(events, soldier, e.type.c_str(), e.t, a.action);
        }
    if (!a.ended && finished(a, infantry)) {   // one-shot end (once per clip)
        a.ended = true;
        if (const char* ee = endEvent(a.action)) emit(events, soldier, ee, a.t, a.action);
    }
}

AnimAction SoldierAnimator::turnFor(float err, float threshold) {
    while (err > kPi) err -= 2.f * kPi;
    while (err < -kPi) err += 2.f * kPi;
    return err > threshold ? AnimAction::TurnL : err < -threshold ? AnimAction::TurnR : AnimAction::Count;
}

float SoldierAnimator::turnToward(float yaw, float target, float maxStep) {
    float d = target - yaw;
    while (d > kPi) d -= 2.f * kPi;
    while (d < -kPi) d += 2.f * kPi;
    return yaw + std::clamp(d, -maxStep, maxStep);
}

void SoldierAnimator::applyRootMotion(V3& pos, float& yaw, const float rd[3]) {
    if (rd[0] == 0.f && rd[1] == 0.f && rd[2] == 0.f) return;
    float c = std::cos(yaw), s = std::sin(yaw);
    pos = pos + V3{rd[0] * c + rd[1] * s, 0.f, -rd[0] * s + rd[1] * c};
    yaw += rd[2];
}

} // namespace ttz::game
