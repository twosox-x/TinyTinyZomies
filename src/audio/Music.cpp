#include "audio/Music.h"

#include "city/Json.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

namespace ttz::audio {

bool decodeOggStereo48k(const std::string& path, std::vector<int16_t>& pcm, uint64_t& frames);   // Audio.cpp

namespace {
constexpr float kHalfPi = 1.5707963f;
float dbl(float db) { return std::pow(10.f, db / 20.f); }
}

bool MusicDirector::load(const std::string& dir, int rate) {
    rate_ = rate;
    std::ifstream f(dir + "/music.json");
    if (!f) { SDL_Log("music: no %s/music.json (music off)", dir.c_str()); return false; }
    std::stringstream ss; ss << f.rdbuf();
    const std::string text = ss.str();
    json::Value root;
    if (!json::Parser(text).parse(root)) { SDL_Log("music: parse error in music.json (music off)"); return false; }
    MusicConfig& c = cfg_;
    c.volumeDb = (float)root["musicVolumeDb"].n(c.volumeDb);
    const json::Value& d = root["duck"];
    c.duckDb = (float)d["depthDb"].n(c.duckDb); c.duckAttack = (float)d["attack"].n(c.duckAttack);
    c.duckRelease = (float)d["release"].n(c.duckRelease); c.duckThreshold = (float)d["threshold"].n(c.duckThreshold);
    const json::Value& in = root["intensity"];
    auto rd = [&](const char* k, MusicConfig::In& o) { o.full = (float)in[k]["full"].n(o.full); o.weight = (float)in[k]["weight"].n(o.weight); };
    rd("shotsPerSec", c.shotsPerSec); rd("zombieKillsPerSec", c.killsPerSec); rd("explosionsPerMin", c.explPerMin);
    rd("liveZombies", c.live); rd("casualtiesPerMin", c.casPerMin); rd("breachesPerMin", c.breachPerMin);
    c.liveOnlyInCombat = in["liveZombies"]["onlyInCombat"].n(1) != 0;
    c.rateWindow = (float)in["rateWindow"].n(c.rateWindow); c.rise = (float)in["rise"].n(c.rise); c.fall = (float)in["fall"].n(c.fall);
    const json::Value& r = root["director"];
    c.escAbove = (float)r["escalateAbove"].n(c.escAbove); c.escHold = (float)r["escalateHold"].n(c.escHold);
    c.deescBelow = (float)r["deescalateBelow"].n(c.deescBelow); c.deescHold = (float)r["deescalateHold"].n(c.deescHold);
    c.minOnTrack = (float)r["minTimeOnTrack"].n(c.minOnTrack);
    c.escBars = (float)r["escalateBars"].n(c.escBars); c.deescBars = (float)r["deescalateBars"].n(c.deescBars);
    const json::Value& pl = root["playlist"];
    c.playlist = root["mode"].str != "adaptive";
    for (size_t i = 0; i < pl["order"].size(); ++i) c.order.push_back(pl["order"][i].str);
    c.gap = (float)pl["gapSeconds"].n(c.gap); c.fadeOut = (float)pl["fadeOutSeconds"].n(c.fadeOut);
    c.startDelay = (float)pl["startDelaySeconds"].n(c.startDelay);
    const json::Value& tr = root["tracks"];
    for (size_t i = 0; i < tr.size(); ++i) {
        const json::Value& t = tr[i];
        MusicTrack m;
        m.id = t["id"].str; m.title = t["title"].str; m.file = t["file"].str;
        m.tier = (int)t["tier"].n(0); m.gain = dbl((float)t["gainDb"].n(0));
        const double bpm = t["bpm"].n(92.31), bpb = t["beatsPerBar"].n(4);
        m.bar = 60.0 / bpm * bpb * rate; m.origin = t["gridOrigin"].n(0) * rate;
        m.entry = t["entryPoint"].n(0) * rate; m.loopStart = t["loopStart"].n(0) * rate; m.loopEnd = t["loopEnd"].n(0) * rate;
        m.loopXfBars = t["loopCrossfadeBars"].n(1);
        if (c.playlist && std::find(c.order.begin(), c.order.end(), m.id) == c.order.end()) continue;   // not in the playlist: not loaded
        if (!decodeOggStereo48k(dir + "/" + m.file, m.pcm, m.frames)) { SDL_Log("music: cannot decode %s", m.file.c_str()); continue; }
        if (m.loopEnd <= m.loopStart || m.loopEnd > (double)m.frames) { m.loopStart = 0; m.loopEnd = (double)m.frames; }
        m.pos = m.entry;
        tracks_.push_back(std::move(m));
    }
    if (tracks_.empty()) return false;
    if (c.playlist) {
        std::sort(tracks_.begin(), tracks_.end(), [&](const MusicTrack& a, const MusicTrack& b) {
            return std::find(c.order.begin(), c.order.end(), a.id) < std::find(c.order.begin(), c.order.end(), b.id); });
        active_ = 0; tracks_[0].pos = 0; tracks_[0].g = 0.f;
        gapLeft_ = (int64_t)(c.startDelay * rate);   // a short silence, then the first song
        SDL_Log("music: playlist of %zu (%s first), full song + %.0f s fade-out, then %.0f s break", tracks_.size(),
                tracks_[0].title.c_str(), c.fadeOut, c.gap);
        return true;
    }
    std::sort(tracks_.begin(), tracks_.end(), [](const MusicTrack& a, const MusicTrack& b) { return a.tier < b.tier; });
    active_ = 0; tracks_[0].g = 1.f; tracks_[0].started = true;
    SDL_Log("music: %zu tracks (%s .. %s), escalate > %.2f for %.0f s, de-escalate < %.2f for %.0f s, min %.0f s per track",
            tracks_.size(), tracks_.front().title.c_str(), tracks_.back().title.c_str(), c.escAbove, c.escHold, c.deescBelow, c.deescHold, c.minOnTrack);
    return true;
}

void MusicDirector::update(float dt) {
    if (tracks_.empty() || dt <= 0) return;
    const MusicConfig& c = cfg_;
    const float k = 1.f - std::exp(-dt / std::max(0.1f, c.rateWindow));
    for (size_t i = 0; i < pending_.size(); ++i) { rates_[i] += (pending_[i] / dt - rates_[i]) * k; pending_[i] = 0; }
    auto term = [](float v, const MusicConfig::In& in) { return std::min(1.f, v / std::max(1e-3f, in.full)) * in.weight; };
    const float shots = rates_[(size_t)MusicIn::Shot];
    float raw = term(shots, c.shotsPerSec) + term(rates_[(size_t)MusicIn::ZombieKill], c.killsPerSec)
              + term(rates_[(size_t)MusicIn::Explosion] * 60.f, c.explPerMin) + term(rates_[(size_t)MusicIn::Casualty] * 60.f, c.casPerMin)
              + term(rates_[(size_t)MusicIn::Breach] * 60.f, c.breachPerMin);
    if (!c.liveOnlyInCombat || shots > 1.f) raw += term((float)live_, c.live);
    raw_ = override_ >= 0.f ? override_ : std::clamp(raw, 0.f, 1.f);
    I_ += (raw_ - I_) * (1.f - std::exp(-dt / std::max(0.05f, raw_ > I_ ? c.rise : c.fall)));
    maxI_ = std::max(maxI_, I_);
    onTrack_ += dt;
    above_ = (I_ > c.escAbove && raw_ > c.escAbove) ? above_ + dt : 0.f;   // sustained: the live signal must stay high too
    below_ = I_ < c.deescBelow ? below_ + dt : 0.f;
    if (c.playlist || pendingTo_ >= 0 || fading_ || onTrack_ < c.minOnTrack) return;   // playlist: intensity is informational only
    const int tier = tracks_[(size_t)active_].tier;
    if (above_ >= c.escHold && active_ + 1 < (int)tracks_.size()) schedule(active_ + 1, c.escBars);
    else if (below_ >= c.deescHold && tier > 0) schedule(active_ - 1, c.deescBars);
}

double MusicDirector::nextBarFrame(const MusicTrack& t, double pos) const {
    const double k = std::ceil((pos - t.origin) / t.bar - 1e-6);
    return t.origin + std::max(0.0, k) * t.bar;
}

void MusicDirector::schedule(int to, float bars) {
    const MusicTrack& a = tracks_[(size_t)active_];
    double nb = nextBarFrame(a, a.pos);
    if (nb > a.loopEnd) nb = a.loopEnd;   // the loop seam is itself a bar line
    startIn_ = (int64_t)std::max(0.0, nb - a.pos);
    pendingTo_ = to;
    xfLen_ = std::max(1.0, bars * tracks_[(size_t)to].bar);
    SDL_Log("music: %s -> %s at the next bar (intensity %.2f), %.0f-bar crossfade", a.title.c_str(), tracks_[(size_t)to].title.c_str(), I_, bars);
}

float MusicDirector::sample(const MusicTrack& t, uint64_t f, int c) const {
    const uint64_t ls = (uint64_t)t.loopStart, le = (uint64_t)t.loopEnd, len = le - ls;
    const uint64_t xf = (uint64_t)std::min<double>(t.loopXfBars * t.bar, (double)len * 0.5);
    float s = t.pcm[std::min(f, t.frames - 1) * 2 + c] * (1.f / 32768.f);
    if (xf > 0 && f + xf >= le && f < le && f >= len) {   // loop seam: crossfade the end into the bars before loopStart
        const float u = (float)(f + xf - le) / (float)xf;
        const float s2 = t.pcm[(f - len) * 2 + c] * (1.f / 32768.f);
        s = s * std::cos(u * kHalfPi) + s2 * std::sin(u * kHalfPi);
    }
    return s;
}

void MusicDirector::step(int frames, float* out, float gain) {
    if (cfg_.playlist) {   // full song, fade-out at its end, silence, next song (no loop points)
        for (int i = 0; i < frames; ++i) {
            if (gapLeft_ > 0) {
                if (--gapLeft_ == 0) { active_ = (active_ + 1) % (int)tracks_.size(); tracks_[(size_t)active_].pos = 0; }
                continue;
            }
            MusicTrack& t = tracks_[(size_t)active_];
            const uint64_t f = (uint64_t)t.pos;
            if (f >= t.frames) { t.g = 0.f; gapLeft_ = std::max<int64_t>(1, (int64_t)(cfg_.gap * rate_)); continue; }
            const double fadeF = cfg_.fadeOut * rate_, left = (double)(t.frames - f);
            t.g = left < fadeF ? std::cos((float)(1.0 - left / fadeF) * kHalfPi) : 1.f;
            if (out) {
                const float g = t.g * t.gain * gain;
                out[i * 2] += t.pcm[f * 2] * (1.f / 32768.f) * g;
                out[i * 2 + 1] += t.pcm[f * 2 + 1] * (1.f / 32768.f) * g;
            }
            t.pos += 1; t.secondsPlayed += 1.0 / rate_;
        }
        return;
    }
    for (int i = 0; i < frames; ++i) {
        if (startIn_ == 0 && pendingTo_ >= 0) {   // bar line reached: start the crossfade
            MusicTrack& in = tracks_[(size_t)pendingTo_];
            if (!in.started) { in.pos = in.entry; in.started = true; }
            else { double p = nextBarFrame(in, in.pos); if (p >= in.loopEnd) p = in.loopStart + std::fmod(p - in.loopStart, in.loopEnd - in.loopStart); in.pos = p; }
            from_ = active_; active_ = pendingTo_; pendingTo_ = -1; startIn_ = -1;
            fading_ = true; xfPos_ = 0; onTrack_ = 0; above_ = below_ = 0; ++transitions_;
        }
        if (startIn_ > 0) --startIn_;
        if (fading_) {
            const float u = (float)std::min(1.0, xfPos_ / xfLen_);
            tracks_[(size_t)active_].g = std::sin(u * kHalfPi);
            if (from_ >= 0) tracks_[(size_t)from_].g = std::cos(u * kHalfPi);
            xfPos_ += 1;
            if (u >= 1.f) { fading_ = false; if (from_ >= 0) tracks_[(size_t)from_].g = 0.f; from_ = -1; }
        }
        for (MusicTrack& t : tracks_) {
            if (t.g <= 0.f) continue;
            if (out) {
                const float g = t.g * t.gain * gain;
                const uint64_t f = (uint64_t)t.pos;
                out[i * 2] += sample(t, f, 0) * g;
                out[i * 2 + 1] += sample(t, f, 1) * g;
            }
            t.pos += 1;
            if (t.pos >= t.loopEnd) t.pos -= (t.loopEnd - t.loopStart);
            t.secondsPlayed += 1.0 / rate_;
        }
    }
}

void MusicDirector::render(float* out, int frames, float gain) { if (!tracks_.empty()) step(frames, out, gain * dbl(cfg_.volumeDb)); }
void MusicDirector::advance(int frames) { if (!tracks_.empty()) step(frames, nullptr, 0.f); }

} // namespace ttz::audio
