#pragma once
// Ray tracer kinematics (MilitaryRenderer::fxTracer, owner feedback 2026-11-28 / GAME_DESIGN 14e: "about 20 % slower,
// thinner, visible from the muzzle to the target"). Header-only so the self-test checks the same numbers the renderer
// draws (src/game/SoldierSelfTest.cpp "tracer").
//
//   * The streak is drawn on the frame it is spawned (age 0): its head starts kHead0 m past the muzzle, its tail at
//     the muzzle, so the first visible segment touches the barrel.
//   * The head travels at `speed` (600 m/s rifle / MG, 720 m/s sniper: 20 % below the old 750 / 900) to the round's
//     end `len`; the tail (`tail` m behind the head) follows and the tracer ends when the tail reaches the end.
//   * Frame pacing: the per-frame age step is capped so a shot of any length is drawn on at least kMinFrames frames
//     (a 60 m shot at 30 fps would otherwise be 2 frames: seen only near its end).
#include <algorithm>

namespace ttz {

struct TracerMotion {
    static constexpr float kHead0 = 1.2f;       // m: head past the muzzle on the spawn frame
    static constexpr float kMinFrames = 6.f;    // frames from muzzle to target, at least
    static constexpr float kSpeedRifle = 600.f, kSpeedSniper = 720.f;   // m/s (visual only: rounds are hit rays)
    // head / tail distance from the muzzle at age `age` for a round ending at `len`
    static void span(float age, float speed, float len, float tail, float& head, float& tailPos) {
        const float s = kHead0 + age * speed;
        head = std::min(s, len);
        tailPos = std::clamp(s - tail, 0.f, len);
    }
    // age at which the tail reaches the end (the tracer is gone)
    static float life(float speed, float len, float tail) { return std::max(0.f, len + tail - kHead0) / speed + 0.001f; }
    // age step of one rendered frame of fdt seconds: never more than 1 / kMinFrames of the head's flight
    static float step(float fdt, float speed, float len) {
        const float flight = std::max(len - kHead0, 1.f) / speed;
        return std::min(fdt, flight / kMinFrames);
    }
};

} // namespace ttz
