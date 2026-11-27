#pragma once
// Day / night cycle: a 24 h clock mapped onto a configurable real-time cycle (GAME_DESIGN: 20 real minutes of day, sun up
// 06:00 -> 18:00, then 7 real minutes of night, 18:00 -> 06:00), with dawn / dusk inside the transitions (the clock rate
// blends smoothly between the day and night rates over the hour around sunrise / sunset). evalTimeOfDay() turns the clock into the
// lighting of a frame: the key light (warm sun by day, cool moon by night, both fading to zero at their horizon so
// the direction can switch without a pop), hemisphere ambient, fog / sky colour, exposure, and how far the night
// emissives (windows, street lamps) are on.
#include "render/Math.h"

#include <algorithm>
#include <cmath>

namespace ttz {

struct TimeOfDaySettings {
    float hours = 16.5f;          // clock, 0..24 (6 = sunrise, 12 = noon, 18 = sunset, 0 = midnight)
    bool paused = false;
    float speed = 1.0f;           // multiplier on the cycle rate
    float dayMinutes = 20.f;      // real minutes from 06:00 to 18:00 (sun up)
    float nightMinutes = 7.f;     // real minutes from 18:00 to 06:00
    float sunMaxElevation = 52.f; // degrees at noon (lower = longer shadows all day)
    float sunAzimuthOffset = 25.f;// degrees: rotates the sun's path against the street grid (diagonal shadows)
    float moonMaxElevation = 50.f;
    float nightBrightness = 1.0f; // scales the night ambient + moonlight
    float sunStrength = 1.0f;     // scales the direct sun
    float cycleMinutes() const { return dayMinutes + nightMinutes; }
    // real seconds -> clock hours at clock time h: 12 h per dayMinutes by day, per nightMinutes by night; the rate
    // blends over 05:30-06:30 and 17:30-18:30 (no step in the shadow speed at sunrise / sunset)
    float hoursPerSecond(float h) const {
        // blended in seconds per clock hour (symmetric ramps: the day / night totals stay exact)
        const float daySph = std::max(dayMinutes, 0.05f) * 5.f, nightSph = std::max(nightMinutes, 0.05f) * 5.f;   // 60 s / 12 h
        auto sm = [](float a, float b, float x) { float t = std::clamp((x - a) / (b - a), 0.f, 1.f); return t * t * (3.f - 2.f * t); };
        const float day = sm(5.5f, 6.5f, h) * (1.f - sm(17.5f, 18.5f, h));
        return 1.f / (nightSph + (daySph - nightSph) * day);
    }
    // advance by dt real seconds
    void advance(float dt) {
        if (paused || cycleMinutes() <= 0.f) return;
        hours = std::fmod(hours + dt * speed * hoursPerSecond(hours), 24.f);
        if (hours < 0.f) hours += 24.f;
    }
};

struct TimeOfDayLight {
    V3 dir{0, 1, 0};              // towards the key light (sun or moon)
    V3 color{};                   // key light colour * intensity (linear)
    V3 sky{}, ground{}, fog{};    // hemisphere ambient, fog / sky colour (linear)
    float exposure = 1.f;
    float night = 1.f;            // 0 day .. 1 night: windows, lamp lenses, street-lamp point lights
    float sunElevation = 0.f;     // degrees
    bool moon = false;            // key light is the moon
};

namespace tod_detail {
struct Key { float elev; V3 sun, sky, ground, fog; float exposure, night; };
inline V3 lerp(V3 a, V3 b, float t) { return a + (b - a) * t; }
inline float smooth(float a, float b, float x) {
    float t = std::clamp((x - a) / (b - a), 0.f, 1.f);
    return t * t * (3.f - 2.f * t);
}
} // namespace tod_detail

inline TimeOfDayLight evalTimeOfDay(const TimeOfDaySettings& s) {
    using namespace tod_detail;
    constexpr float kPi = 3.14159265f, kDeg = kPi / 180.f;
    const float h = std::fmod(std::fmod(s.hours, 24.f) + 24.f, 24.f);
    // sun: 06:00 east -> 18:00 west; elevation shaped to linger low (long shadows in the morning / afternoon)
    const float phi = (h - 6.f) / 12.f;                        // 0 sunrise .. 1 sunset
    const float sphi = std::sin(kPi * phi);
    const float elev = (sphi >= 0.f ? s.sunMaxElevation * std::pow(sphi, 1.15f) : 18.f * sphi);   // below: twilight depth
    const float az = kPi * std::clamp(phi, -0.1f, 1.1f) + s.sunAzimuthOffset * kDeg;
    auto dirFrom = [](float azr, float elr) {
        return normalize(V3{std::cos(azr) * std::cos(elr), std::sin(elr), std::sin(azr) * std::cos(elr)});
    };
    // colour keys by sun elevation (degrees): deep night, blue hour, twilight, sunrise, golden hour, afternoon, noon
    // (sun = colour x intensity; ambient kept low against the sun for strong, blue-tinted shadows)
    static const Key keys[] = {
        {-12.f, {0, 0, 0}, {0.0045f, 0.0065f, 0.016f}, {0.0015f, 0.0015f, 0.0025f}, {0.004f, 0.0055f, 0.012f}, 1.00f, 1.0f},
        {-6.f, {0, 0, 0}, {0.022f, 0.026f, 0.058f}, {0.008f, 0.007f, 0.011f}, {0.035f, 0.034f, 0.070f}, 1.10f, 0.95f},
        {-2.f, {0, 0, 0}, {0.100f, 0.090f, 0.160f}, {0.045f, 0.034f, 0.036f}, {0.300f, 0.180f, 0.180f}, 1.20f, 0.65f},
        {2.f, {0.95f, 0.34f, 0.11f}, {0.085f, 0.085f, 0.150f}, {0.060f, 0.042f, 0.030f}, {0.480f, 0.290f, 0.200f}, 1.15f, 0.25f},
        {12.f, {1.45f, 0.72f, 0.30f}, {0.095f, 0.110f, 0.190f}, {0.070f, 0.055f, 0.038f}, {0.580f, 0.460f, 0.360f}, 1.08f, 0.0f},
        {26.f, {1.40f, 0.92f, 0.50f}, {0.125f, 0.160f, 0.260f}, {0.078f, 0.066f, 0.050f}, {0.520f, 0.540f, 0.620f}, 0.98f, 0.0f},
        {52.f, {1.20f, 0.97f, 0.68f}, {0.140f, 0.180f, 0.290f}, {0.082f, 0.072f, 0.058f}, {0.540f, 0.600f, 0.720f}, 0.80f, 0.0f},
    };
    constexpr int nk = (int)(sizeof(keys) / sizeof(keys[0]));
    int k = 0;
    while (k + 1 < nk - 1 && elev > keys[k + 1].elev) ++k;
    const Key &a = keys[k], &b = keys[k + 1];
    const float t = std::clamp((elev - a.elev) / (b.elev - a.elev), 0.f, 1.f);
    TimeOfDayLight o;
    o.sunElevation = elev;
    o.sky = lerp(a.sky, b.sky, t);
    o.ground = lerp(a.ground, b.ground, t);
    o.fog = lerp(a.fog, b.fog, t);
    o.exposure = a.exposure + (b.exposure - a.exposure) * t;
    o.night = a.night + (b.night - a.night) * t;
    // direct sun: warm colour x intensity from the keys, fading in from the horizon (0 at -1 deg)
    const float sunI = smooth(-1.f, 3.f, elev) * s.sunStrength;
    const V3 sunCol = lerp(a.sun, b.sun, t);
    if (elev > -1.f) {
        o.dir = dirFrom(az, std::max(elev, 0.5f) * kDeg);
        o.color = sunCol * sunI;
    } else {
        // moon: rises after dusk (18:20), sets before dawn (05:40), opposite path; fades at its horizon
        float hm = h < 12.f ? h + 24.f : h;
        float psi = (hm - 18.33f) / 11.34f;
        float sp = std::sin(kPi * std::clamp(psi, 0.f, 1.f));
        float mel = s.moonMaxElevation * std::pow(sp, 0.7f);
        o.dir = dirFrom(kPi + kPi * std::clamp(psi, 0.f, 1.f) + s.sunAzimuthOffset * kDeg + 0.5f, std::max(mel, 0.5f) * kDeg);
        float moonI = (psi > 0.f && psi < 1.f ? smooth(0.f, 10.f, mel) : 0.f) * smooth(-1.f, -6.f, elev);
        o.color = V3{0.018f, 0.026f, 0.056f} * (moonI * s.nightBrightness);   // dim blue: silhouettes, not a second sun
        o.moon = true;
        const float nb = 1.f + (s.nightBrightness - 1.f) * o.night;
        o.sky = o.sky * nb;
        o.ground = o.ground * nb;
    }
    return o;
}

} // namespace ttz
