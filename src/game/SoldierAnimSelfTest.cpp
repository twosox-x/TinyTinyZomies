// Self-test section "anim" (WS-B, CPU only): SoldierAnimator on the approved clips (assets/military/anims.*).
// Fire sync (one muzzle_flash per round at the weapon's fire interval), reload mag_in exactly once, death always
// interrupts, one-shots are not restarted by a standing request, para sequence events, turn root motion, determinism.
#include "game/SoldierAnim.h"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace ttz::game {

namespace {
int g_animFail = 0;
void check(bool ok, const char* what, const std::string& detail) {
    std::printf("  [%s] %s  (%s)\n", ok ? "PASS" : "FAIL", what, detail.c_str());
    if (!ok) ++g_animFail;
}
std::string fmt(const char* f, double a = 0, double b = 0, double c = 0) {
    char buf[256];
    std::snprintf(buf, sizeof(buf), f, a, b, c);
    return buf;
}
int count(const std::vector<AnimEvent>& ev, const char* type) {
    int n = 0;
    for (const AnimEvent& e : ev) n += e.type == type ? 1 : 0;
    return n;
}
struct Run {   // one soldier ticking at 30 Hz
    SoldierAnimator& A;
    int inf;
    AnimPlayback a;
    std::vector<AnimEvent> ev;
    float yawSum = 0.f;
    Run(SoldierAnimator& an, int infantry, AnimAction start) : A(an), inf(infantry) { A.reset(a, inf, start); }
    void ticks(int n, AnimAction req, float speed = 0.f) {
        for (int k = 0; k < n; ++k) {
            A.request(a, req, speed);
            float r[3];
            A.tick(0, inf, a, (float)kTickDt, ev, r);
            yawSum += r[2];
        }
    }
};
} // namespace

int runSoldierAnimSelfTest(const std::string& assetDir) {
    g_animFail = 0;
    std::printf("anim (WS-B, approved clips)\n");
    MilitaryLibrary lib;
    if (!lib.load(assetDir, 1.7f / 18.f) || lib.keyClips.empty()) {
        check(false, "assets/military loads (clips)", assetDir);
        return g_animFail;
    }
    SoldierAnimator A;
    A.init(lib);
    int rifle = -1, mg = -1;
    for (size_t i = 0; i < lib.infantry.size(); ++i) {
        if (rifle < 0 && lib.infantry[i].cls == "rifleman") rifle = (int)i;
        if (mg < 0 && lib.infantry[i].cls == "mg") mg = (int)i;
    }
    check(rifle >= 0 && mg >= 0 && std::fabs(A.clipShotInterval(SoldierClass::Rifleman) - 0.3f) < 1e-3f &&
              std::fabs(A.clipShotInterval(SoldierClass::MachineGunner) - 1.f / 12.f) < 1e-3f,
          "clip shot spacing from the fire clips (rifle 0.3 s, MG 1/12 s)", fmt("%.3f / %.4f", A.clipShotInterval(SoldierClass::Rifleman), A.clipShotInterval(SoldierClass::MachineGunner)));
    if (rifle < 0 || mg < 0) return g_animFail;

    // fire sync: rounds = muzzle_flash events, rate matched to the weapon's fire interval (clip rate clamped [0.6, 1.8])
    auto fireCount = [&](int inf, SoldierClass c, float interval, int nTicks, int& expect) {
        A.setWeaponTiming(c, interval, 2.4f);
        Run r(A, inf, AnimAction::Aim);
        r.ticks(10, AnimAction::Aim);
        r.ev.clear();
        r.ticks(nTicks, AnimAction::Fire);
        const float rate = std::fmin(1.8f, std::fmax(0.6f, A.clipShotInterval(c) / interval));
        expect = (int)std::floor((float)nTicks * (float)kTickDt * rate / A.clipShotInterval(c) + 1e-3f) + 1;   // first round at once
        return count(r.ev, "muzzle_flash");
    };
    int e1 = 0, e2 = 0, e3 = 0;
    const int n1 = fireCount(rifle, SoldierClass::Rifleman, 0.25f, 89, e1);
    const int n2 = fireCount(mg, SoldierClass::MachineGunner, 0.1f, 61, e2);
    const int n3 = fireCount(rifle, SoldierClass::Rifleman, 0.3f, 89, e3);
    check(n1 == e1 && n2 == e2 && n3 == e3, "fire clip: one muzzle_flash per round at the configured fire interval (first round immediate)",
          fmt("rifle 0.25 s: %.0f, MG 0.1 s: %.0f, rifle 0.3 s: %.0f (expected " , n1, n2, n3) + fmt("%.0f / %.0f / %.0f)", e1, e2, e3));

    // reload: mag_in once even with the request standing for 6 s; start / end reported; back to aim
    {
        A.setWeaponTiming(SoldierClass::Rifleman, 0.3f, 2.4f);
        Run r(A, rifle, AnimAction::Aim);
        r.ticks(10, AnimAction::Aim);
        r.ticks(180, AnimAction::Reload);
        check(count(r.ev, "mag_in") == 1 && count(r.ev, "reload_start") == 1 && count(r.ev, "reload_end") == 1 && r.a.action == AnimAction::Aim,
              "reload: mag_in exactly once under a standing request, then aim", fmt("mag_in %.0f, start %.0f, end %.0f", count(r.ev, "mag_in"), count(r.ev, "reload_start"), count(r.ev, "reload_end")));
        Run q(A, rifle, AnimAction::Aim);   // reload time matching: 1.2 s reload plays the 2.4 s clip at 1.8x (clamped)
        A.setWeaponTiming(SoldierClass::Rifleman, 0.3f, 1.2f);
        int endTick = -1;
        for (int k = 0; k < 120 && endTick < 0; ++k) { q.ticks(1, AnimAction::Reload); if (count(q.ev, "reload_end")) endTick = k; }
        A.setWeaponTiming(SoldierClass::Rifleman, 0.3f, 2.4f);
        check(endTick > 35 && endTick < 45, "reload rate matched to reloadTime (clamped to 1.8x)", fmt("reload_end after %.0f ticks", endTick));
    }
    // death interrupts a reload, holds, never fires mag_in afterwards; Idle requests do not revive
    {
        Run r(A, rifle, AnimAction::Aim);
        r.ticks(5, AnimAction::Aim);
        r.ticks(15, AnimAction::Reload);   // 0.5 s into the reload (mag_in at 1.5 s)
        r.ticks(1, AnimAction::Death);
        const bool interrupted = r.a.action == AnimAction::Death;
        r.ticks(90, AnimAction::Idle);
        check(interrupted && r.a.action == AnimAction::Death && count(r.ev, "mag_in") == 0 && count(r.ev, "death_end") == 1 && count(r.ev, "weapon_drop") == 1 &&
                  A.finished(r.a, rifle),
              "death always interrupts (reload cut, weapon dropped, body holds its last frame)", "");
    }
    // a standing Hit request plays the reaction once (no constantly restarted animation)
    {
        Run r(A, rifle, AnimAction::Idle);
        r.ticks(90, AnimAction::Hit);
        check(count(r.ev, "hit_end") == 1 && count(r.ev, "hit") == 1, "hit reaction plays once under a standing request", fmt("%.0f", count(r.ev, "hit_end")));
    }
    // parachute: descent loops until ParaLand; touchdown / canopy_ground / harness_release / weapon_draw once each
    {
        Run r(A, rifle, AnimAction::ParaDescent);
        r.ticks(200, AnimAction::Idle);   // Idle must not end the descent
        const bool held = r.a.action == AnimAction::ParaDescent;
        r.ticks(60, AnimAction::ParaLand);
        r.ticks(120, AnimAction::ParaRecover);
        r.ticks(30, AnimAction::Idle);
        check(held && count(r.ev, "touchdown") == 1 && count(r.ev, "canopy_ground") == 1 && count(r.ev, "harness_release") == 1 &&
                  count(r.ev, "weapon_draw") == 1 && r.a.action == AnimAction::Idle,
              "para sequence: descent holds, land / recover events once each, then idle", "");
    }
    // turn: the committed root motion turns the soldier by the clip's 90 degrees
    {
        Run r(A, rifle, AnimAction::Idle);
        r.ticks(40, AnimAction::TurnL);
        r.ticks(10, AnimAction::Idle);
        check(std::fabs(r.yawSum - 1.5708f) < 1e-3f && count(r.ev, "turn_end") == 1, "turn_l commits +90 deg of root yaw once", fmt("%.4f rad", r.yawSum));
    }
    // determinism: the same requests give the same events
    {
        auto script = [&]() {
            Run r(A, mg, AnimAction::Idle);
            r.ticks(20, AnimAction::Walk, 1.3f); r.ticks(20, AnimAction::Run, 3.8f); r.ticks(20, AnimAction::Aim); r.ticks(60, AnimAction::Fire);
            r.ticks(150, AnimAction::Reload); r.ticks(30, AnimAction::CrouchFire); r.ticks(60, AnimAction::Death);
            std::string s;
            for (const AnimEvent& e : r.ev) s += e.type + "@" + std::to_string(e.t) + ";";
            return s;
        };
        const std::string a = script(), b = script();
        check(a == b && !a.empty(), "animator is deterministic (same requests, same events)", "");
    }
    return g_animFail;
}

} // namespace ttz::game
