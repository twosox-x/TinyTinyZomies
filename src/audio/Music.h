#pragma once
// Adaptive music director (sessionD/sound). Tracks, tiers, thresholds, transition lengths and loop points come from
// assets/audio/music/music.json, so compositions can be added or retuned without code changes.
//
// Intensity is computed only from what the game already reports to audio (shots, zombie kills, explosions, live zombie
// count, soldier casualties, breaches); no separate threat simulation. Music lives on its own bus and never produces
// gameplay noise (it cannot attract zombies).
//
// Playback: each track keeps its own playhead (continuity: a track resumes where it was, snapped to its bar grid).
// A switch waits for the next bar line of the playing track, then crossfades over N bars (equal power). Each track plays
// its intro once, then loops [loopStart, loopEnd) with a bar-length crossfade at the seam.
#include <cstdint>
#include <string>
#include <vector>

namespace ttz::audio {

enum class MusicIn : uint8_t { Shot, ZombieKill, Explosion, Casualty, Breach, Count };

struct MusicTrack {
    std::string id, title, file;
    int tier = 0;
    float gain = 1.f;
    double bar = 2.6, origin = 0, entry = 0, loopStart = 0, loopEnd = 0, loopXfBars = 1;
    std::vector<int16_t> pcm;   // 48 kHz stereo
    uint64_t frames = 0;
    double pos = 0;             // playhead in frames (kept while silent: continuity)
    bool started = false;
    float g = 0.f;              // current fade gain
    double secondsPlayed = 0;
};

struct MusicConfig {
    float volumeDb = -9.f, duckDb = -5.f, duckAttack = 0.06f, duckRelease = 0.6f, duckThreshold = 0.08f;
    struct In { float full = 1.f, weight = 0.f; };
    In shotsPerSec, killsPerSec, explPerMin, live, casPerMin, breachPerMin;
    bool liveOnlyInCombat = true;
    float rateWindow = 6.f, rise = 3.f, fall = 12.f;
    float escAbove = 0.55f, escHold = 8.f, deescBelow = 0.28f, deescHold = 25.f, minOnTrack = 30.f;
    float escBars = 4.f, deescBars = 8.f;
};

class MusicDirector {
public:
    bool load(const std::string& musicDir, int rate);   // music.json + track files; false: no music (silent)
    void note(MusicIn what, float amount = 1.f) { if ((size_t)what < pending_.size()) pending_[(size_t)what] += amount; }
    void setLiveZombies(uint32_t n) { live_ = n; }
    void setOverride(float intensity) { override_ = intensity; }   // < 0: automatic (game data)
    void update(float dt);                                      // intensity + decisions (call once per frame)
    void render(float* out, int frames, float gain);            // adds the music bus into interleaved stereo
    void advance(int frames);                                   // no device: move playheads / fades without rendering

    float intensity() const { return I_; }
    float rawIntensity() const { return raw_; }
    int activeTrack() const { return active_; }
    const std::vector<MusicTrack>& tracks() const { return tracks_; }
    const MusicConfig& config() const { return cfg_; }
    int transitions() const { return transitions_; }
    float maxIntensity() const { return maxI_; }
    bool loaded() const { return !tracks_.empty(); }

private:
    void schedule(int to, float bars);
    void step(int frames, float* out, float gain);
    float sample(const MusicTrack& t, uint64_t f, int c) const;
    double nextBarFrame(const MusicTrack& t, double pos) const;

    MusicConfig cfg_;
    std::vector<MusicTrack> tracks_;
    std::vector<int> byTier_;
    int rate_ = 48000;
    std::vector<float> pending_ = std::vector<float>((size_t)MusicIn::Count, 0.f);
    float rates_[(size_t)MusicIn::Count] = {};
    uint32_t live_ = 0;
    float override_ = -1.f, raw_ = 0.f, I_ = 0.f, maxI_ = 0.f;
    float above_ = 0.f, below_ = 0.f, onTrack_ = 0.f;
    int active_ = -1;                 // index of the track that is (or is becoming) the main one
    int from_ = -1;                   // track fading out
    int64_t startIn_ = -1;            // frames until the scheduled crossfade starts (-1: none)
    int pendingTo_ = -1;
    double xfLen_ = 1, xfPos_ = 0;    // crossfade length / progress in frames
    bool fading_ = false;
    int transitions_ = 0;
};

} // namespace ttz::audio
