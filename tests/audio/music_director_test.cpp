// Headless test of the music director in playlist mode (assets/audio/music/music.json): song in full, fade-out,
// break, song again. No audio device; silent PCM of the real track length.
// Build (from repo root, after the main build):
//   g++ -std=c++20 -O1 -Isrc -Ibuild/_deps/sdl3-src/include tests/audio/music_director_test.cpp src/audio/Music.cpp \
//       build/_deps/sdl3-build/libSDL3.a -lm -ldl -lpthread -o build/music_director_test && ./build/music_director_test
#include "audio/Music.h"
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
    const auto& c = m.config();
    int fails = 0;
    if (!c.playlist || m.tracks().size() != 1 || m.tracks()[0].id != "infection") { std::puts("FAIL: expected playlist [infection]"); ++fails; }
    double t = 0, songStart = -1, breakStart = -1, restart = -1;
    bool wasBreak = m.inBreak();
    for (; t < 1300; t += 0.5) {                     // 0.5 s steps, intensity changes must not matter
        m.setOverride(t > 60 && t < 120 ? 1.f : 0.1f);
        m.update(0.5f);
        m.advance(24000);
        const bool br = m.inBreak();
        if (wasBreak && !br) { if (songStart < 0) songStart = t; else if (restart < 0) restart = t; }
        if (!wasBreak && br && breakStart < 0) breakStart = t;
        wasBreak = br;
    }
    std::printf("first song starts t=%.1f s, break starts t=%.1f s (song %.1f s), song again t=%.1f s (break %.1f s), transitions=%d\n",
                songStart, breakStart, breakStart - songStart, restart, restart - breakStart, m.transitions());
    if (songStart < 0 || songStart > c.startDelay + 1) { std::puts("FAIL: first song did not start after the start delay"); ++fails; }
    if (breakStart - songStart < 194 || breakStart - songStart > 196) { std::puts("FAIL: song not played in full"); ++fails; }
    if (restart - breakStart < c.gap - 1 || restart - breakStart > c.gap + 1) { std::puts("FAIL: break length"); ++fails; }
    if (m.transitions() != 0) { std::puts("FAIL: adaptive switching happened in playlist mode"); ++fails; }
    std::puts(fails ? "FAILED" : "PASS");
    return fails;
}
