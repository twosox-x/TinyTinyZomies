// Headless test of the adaptive music director's decisions (no audio device, silent PCM of the real track lengths).
// Build (from repo root, after the main build):
//   g++ -std=c++20 -O1 -Isrc -Ibuild/_deps/sdl3-src/include tests/audio/music_director_test.cpp src/audio/Music.cpp \
//       build/_deps/sdl3-build/libSDL3.a -lm -ldl -lpthread -o build/music_director_test && ./build/music_director_test
#include "audio/Music.h"
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace ttz::audio {
bool decodeOggStereo48k(const std::string& path, std::vector<int16_t>& pcm, uint64_t& frames) {
    frames = (uint64_t)((path.find("last_stand") != std::string::npos ? 222.5 : 194.7) * 48000);
    pcm.assign(frames * 2, 0);
    return true;
}
}

int main() {
    using namespace ttz::audio;
    MusicDirector m;
    if (!m.load("assets/audio/music", 48000)) { std::puts("FAIL load"); return 1; }
    struct Seg { float sec; float level; const char* what; };
    const Seg plan[] = {{40, 0.10f, "quiet ops"}, {30, 0.85f, "big fight"}, {60, -1, "fluctuating 0.5 / 0.2"}, {20, 0.85f, "fight again"},
                        {90, 0.05f, "battle over"}, {10, 0.9f, "short spike"}, {40, 0.1f, "quiet"}};
    const float dt = 1.f / 60.f;
    double t = 0; int fails = 0, last = m.activeTrack(), switches = 0;
    std::vector<std::pair<double, int>> log;
    for (const Seg& s : plan) {
        const int sw0 = switches;
        for (float u = 0; u < s.sec; u += dt, t += dt) {
            m.setOverride(s.level >= 0 ? s.level : (std::fmod(u, 6.f) < 3.f ? 0.5f : 0.2f));
            m.update(dt);
            m.advance((int)(dt * 48000));
            if (m.activeTrack() != last) { last = m.activeTrack(); ++switches; log.push_back({t, last});
                std::printf("  t=%6.1f s  -> %s (intensity %.2f)\n", t, m.tracks()[(size_t)last].title.c_str(), m.intensity()); }
        }
        std::printf("%-22s until t=%5.0f s: track %-15s intensity %.2f, switches in segment %d\n", s.what, t,
                    m.tracks()[(size_t)m.activeTrack()].title.c_str(), m.intensity(), switches - sw0);
    }
    // expectations
    auto at = [&](double time) { int a = 0; for (auto& e : log) if (e.first <= time) a = e.second; return a; };
    if (at(40) != 0) { std::puts("FAIL: escalated during quiet ops"); ++fails; }
    if (at(70) != 1) { std::puts("FAIL: no escalation in the big fight"); ++fails; }
    int fl = 0; for (auto& e : log) if (e.first > 70 && e.first < 130) ++fl;
    if (fl > 0) { std::puts("FAIL: switched while intensity fluctuated"); ++fails; }
    if (at(240) != 0) { std::puts("FAIL: no de-escalation after the battle"); ++fails; }
    int sp = 0; for (auto& e : log) if (e.first > 240 && e.first < 290) ++sp;
    if (sp > 0) { std::puts("FAIL: a 10 s spike switched the music"); ++fails; }
    std::printf("%s (%d switches, %d transitions)\n", fails ? "FAILED" : "PASS", switches, m.transitions());
    return fails;
}
