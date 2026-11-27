// Soldier animation playback (WS-B): STUB. See SoldierAnim.h; port the lab's advance() / switchClip() / events.
#include "game/SoldierAnim.h"

namespace ttz::game {

bool SoldierAnimator::init(const MilitaryLibrary& lib) { lib_ = &lib; return true; }
void SoldierAnimator::reset(AnimPlayback& a, int infantry, AnimAction start) { a = AnimPlayback{}; a.action = a.requested = start; }
void SoldierAnimator::request(AnimPlayback& a, AnimAction action, float speed) { a.requested = action; a.requestedSpeed = speed; }
void SoldierAnimator::tick(uint32_t soldier, int infantry, AnimPlayback& a, float dt, std::vector<AnimEvent>& events, float rootDelta[3]) {
    a.t += dt * a.rate;
}
bool SoldierAnimator::finished(const AnimPlayback& a, int infantry) const { return true; }
float SoldierAnimator::clipShotInterval(SoldierClass c) const { return c == SoldierClass::MachineGunner ? 1.f / 12.f : c == SoldierClass::Sniper ? 1.9f : 0.3f; }

} // namespace ttz::game
