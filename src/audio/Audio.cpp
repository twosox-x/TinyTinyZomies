// Tiny Tiny Zombies audio: bank loading (stb_vorbis), software mixer, camera-height mix, horde aggregation.
// See Audio.h for the API and the mixing rules.
#include "audio/Audio.h"
#include "audio/Music.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <map>
#include <random>
#include <vector>

#define STB_VORBIS_NO_PUSHDATA_API
#define STB_VORBIS_NO_STDIO_OFF
#include "stb_vorbis.c"
#undef L
#undef C
#undef R

namespace ttz::audio {
namespace {

constexpr int kRate = 48000;
constexpr int kMaxVoices = 48;
constexpr float kPi = 3.14159265f;

enum class Bus : uint8_t { Sfx, Voice, Amb, Ui, Music, Count };
// camera-mix class: how a sound behaves when the camera rises
enum class Cls : uint8_t { Individual, Weapon, Big, Aggregate, Amb, Ui };

struct Clip { std::vector<int16_t> s; uint32_t frames = 0; };
struct Sound { std::string name; std::vector<Clip> var; int lastVar = -1; };

struct Voice {
    const Clip* clip = nullptr;
    int sound = -1;
    uint32_t pos = 0;
    bool loop = false, positional = false, alive = false;
    Bus bus = Bus::Sfx; Cls cls = Cls::Individual;
    int prio = 0;
    V3 p;
    float base = 1.f;                 // linear gain from table * intensity (loops: driven by targetLoop)
    float gl = 0, gr = 0, tl = 0, tr = 0;   // current / target channel gains
    float lpA = 1.f, zl = 0, zr = 0;  // one-pole lowpass
};

struct Map { const char* sound; Bus bus; Cls cls; float db; float minGap; int maxInst; int prio; };

const Map kMap[(size_t)Ev::Count] = {
    {"rifle_shot", Bus::Sfx, Cls::Weapon, -2, 0.035f, 10, 2},           // ShotRifle
    {"mg_sustained", Bus::Sfx, Cls::Weapon, -2, 0.6f, 3, 3},            // ShotMG (one burst covers ~0.8 s of rounds)
    {"sniper_suppressed", Bus::Sfx, Cls::Weapon, 0, 0.2f, 2, 3},        // ShotSniper
    {"carbine_shot", Bus::Sfx, Cls::Weapon, -2, 0.04f, 6, 2},           // ShotCarbine
    {"reload", Bus::Sfx, Cls::Individual, -3, 0.3f, 3, 1},
    {"empty_click", Bus::Sfx, Cls::Individual, -3, 0.3f, 2, 1},
    {"impact_flesh", Bus::Sfx, Cls::Individual, -8, 0.05f, 6, 0},
    {"impact_metal", Bus::Sfx, Cls::Individual, -8, 0.05f, 4, 0},
    {"impact_concrete", Bus::Sfx, Cls::Individual, -8, 0.05f, 4, 0},
    {"impact_wood", Bus::Sfx, Cls::Individual, -8, 0.05f, 4, 0},
    {"car_explosion", Bus::Sfx, Cls::Big, 0, 0.05f, 6, 5},              // Explosion (chain detection in emit)
    {"fire_whoosh", Bus::Sfx, Cls::Big, -4, 0.2f, 3, 3},
    {"zombie_aggro", Bus::Voice, Cls::Individual, -3, 0.25f, 4, 1},
    {"zattack_flesh", Bus::Sfx, Cls::Individual, -3, 0.2f, 4, 1},
    {"zombie_death", Bus::Voice, Cls::Individual, -4, 0.08f, 6, 1},
    {"zombie_reanimate", Bus::Voice, Cls::Individual, 0, 0.3f, 2, 2},
    {"roof_fall", Bus::Sfx, Cls::Individual, 0, 0.25f, 3, 2},
    {"gore_splat", Bus::Sfx, Cls::Individual, -5, 0.1f, 3, 1},
    {"", Bus::Sfx, Cls::Aggregate, 0, 0, 0, 0},                         // Footstep: aggregated into squad_march
    {"impact_flesh", Bus::Sfx, Cls::Individual, -10, 0.1f, 2, 0},       // BodyFall
    {"crate_thud", Bus::Sfx, Cls::Individual, -6, 0.1f, 3, 1},          // Landing (soldier / tower / wall piece)
    {"crate_thud", Bus::Sfx, Cls::Individual, 0, 0.1f, 3, 2},           // CrateLand
    {"container_land", Bus::Sfx, Cls::Big, 0, 0.5f, 2, 4},
    {"plane_flyover", Bus::Sfx, Cls::Big, 0, 5.f, 1, 4},
    {"chute_deploy", Bus::Sfx, Cls::Individual, -2, 0.15f, 3, 1},
    {"", Bus::Sfx, Cls::Weapon, 0, 0, 0, 0},                            // Flame: loop driven
    {"flame_stop", Bus::Sfx, Cls::Weapon, -2, 0.3f, 2, 2},
    {"vo_contact", Bus::Voice, Cls::Individual, 0, 1.2f, 2, 3},
    {"vo_ammo", Bus::Voice, Cls::Individual, 0, 1.2f, 2, 3},
    {"vo_kill", Bus::Voice, Cls::Individual, 0, 1.0f, 2, 3},
    {"vo_panic", Bus::Voice, Cls::Individual, 0, 1.2f, 2, 3},
    {"vo_orders", Bus::Voice, Cls::Individual, 0, 0.8f, 2, 3},
    {"vo_hurt", Bus::Voice, Cls::Individual, -1, 0.3f, 3, 2},
    {"vo_death", Bus::Voice, Cls::Individual, 0, 0.3f, 3, 3},
    {"radio_chirp", Bus::Voice, Cls::Individual, -3, 2.f, 1, 2},
    {"gen_start", Bus::Sfx, Cls::Individual, -2, 0.5f, 2, 2},
    {"gen_stop", Bus::Sfx, Cls::Individual, -2, 0.5f, 2, 2},
    {"gen_out_of_fuel", Bus::Sfx, Cls::Individual, -2, 0.5f, 2, 2},
    {"tower_collapse", Bus::Sfx, Cls::Big, 0, 0.5f, 2, 4},
    {"tower_creak", Bus::Sfx, Cls::Individual, -4, 1.5f, 2, 1},
    {"alert_attack", Bus::Ui, Cls::Ui, 0, 3.f, 1, 5},
    {"alert_breach", Bus::Ui, Cls::Ui, 0, 3.f, 1, 5},
    {"alert_ammo", Bus::Ui, Cls::Ui, 0, 3.f, 1, 5},
    {"alert_casualty", Bus::Ui, Cls::Ui, 0, 2.f, 1, 5},
    {"sting_daynight", Bus::Ui, Cls::Ui, 0, 5.f, 1, 5},
    {"zattack_wood", Bus::Sfx, Cls::Individual, -3, 0.35f, 3, 1},
    {"zattack_metal", Bus::Sfx, Cls::Individual, -3, 0.35f, 3, 1},
    {"zattack_sandbag", Bus::Sfx, Cls::Individual, -3, 0.35f, 3, 1},
    {"tower_climb", Bus::Sfx, Cls::Individual, -2, 1.0f, 2, 1},
};

const char* kEvNames[(size_t)Ev::Count] = {
    "ShotRifle", "ShotMG", "ShotSniper", "ShotCarbine", "Reload", "EmptyClick",
    "ImpactFlesh", "ImpactMetal", "ImpactConcrete", "ImpactWood", "Explosion", "FireWhoosh",
    "ZombieAggro", "ZombieAttack", "ZombieDeath", "ZombieReanimate", "ZombieFall", "Gore",
    "Footstep", "BodyFall", "Landing", "CrateLand", "ContainerLand", "PlaneFlyover", "ChuteDeploy", "Flame", "FlameStop",
    "CalloutContact", "CalloutAmmo", "CalloutKill", "CalloutPanic", "CalloutOrder", "SoldierHurt", "SoldierDeath", "Radio",
    "GenStart", "GenStop", "GenOutOfFuel", "StructureCollapse", "TowerCreak",
    "AlertAttack", "AlertBreach", "AlertAmmo", "AlertCasualty", "DayNight",
    "ZombieAttackWood", "ZombieAttackMetal", "ZombieAttackSandbag", "TowerClimb"};

// managed loops (aggregation + ambience)
enum LoopId { L_HordeS, L_HordeM, L_HordeL, L_March, L_Day, L_Night, L_Flame, L_Count };
const char* kLoopSound[L_Count] = {"horde_small", "horde_medium", "horde_large", "squad_march", "amb_day", "amb_night", "flame_roar"};
const Bus kLoopBus[L_Count] = {Bus::Amb, Bus::Amb, Bus::Amb, Bus::Amb, Bus::Amb, Bus::Amb, Bus::Sfx};

struct State {
    bool enabled = false;
    SDL_AudioStream* stream = nullptr;
    std::vector<Sound> sounds;
    std::map<std::string, int> byName;
    Voice voices[kMaxVoices];
    float busGain[(size_t)Bus::Count] = {1.f, 1.f, 0.8f, 0.7f, 0.f};
    float master = 0.9f;
    double now = 0;
    double lastPlay[(size_t)Ev::Count] = {};
    double uiLast = -1;
    V3 lis; float camH = 30.f, yaw = 0.f, hn = 0.3f;
    uint32_t live = 0;
    bool night = false;
    float stepRate = 0;               // footsteps per second (EMA) -> squad_march loop
    uint32_t stepsThisFrame = 0;
    double lastFlame = -10; V3 flamePos; bool flameOn = false;
    std::vector<double> blasts;       // recent explosion times (chain detection)
    double lastChain = -10;
    int loopVoice[L_Count];
    float loopGain[L_Count] = {}, loopTarget[L_Count] = {};
    std::mt19937 rng{1234};
    std::vector<float> mixBuf;
    float limEnv = 1.f;
    MusicDirector music;
    float musicVol = 1.f, duck = 1.f;
    Stats st;
};
State* S = nullptr;

float dbToLin(float db) { return std::pow(10.f, db / 20.f); }

bool loadOgg(const std::string& path, Clip& c) {
    int ch = 0, rate = 0;
    short* out = nullptr;
    int n = stb_vorbis_decode_filename(path.c_str(), &ch, &rate, &out);
    if (n <= 0 || !out) return false;
    c.frames = (uint32_t)n;
    c.s.resize((size_t)n * 2);
    for (int i = 0; i < n; ++i) {   // to 48 kHz stereo int16 (pipeline output already is; resample nearest otherwise)
        c.s[(size_t)i * 2] = out[(size_t)i * ch];
        c.s[(size_t)i * 2 + 1] = out[(size_t)i * ch + (ch > 1 ? 1 : 0)];
    }
    free(out);
    if (rate != kRate) {
        const double r = (double)rate / kRate;
        const uint32_t nf = (uint32_t)(n / r);
        std::vector<int16_t> o((size_t)nf * 2);
        for (uint32_t i = 0; i < nf; ++i) { uint32_t j = std::min<uint32_t>((uint32_t)(i * r), (uint32_t)n - 1); o[i * 2] = c.s[j * 2]; o[i * 2 + 1] = c.s[j * 2 + 1]; }
        c.s.swap(o); c.frames = nf;
    }
    return true;
}

void loadBank(const std::string& root) {
    namespace fs = std::filesystem;
    std::error_code ec;
    const fs::path dir = fs::path(root);
    std::vector<fs::path> files;
    for (auto it = fs::recursive_directory_iterator(dir, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec))
        if (it->is_regular_file() && it->path().extension() == ".ogg") files.push_back(it->path());
    std::sort(files.begin(), files.end());
    for (const fs::path& f : files) {
        std::string stem = f.stem().string();               // <id>_<n>
        const size_t us = stem.rfind('_');
        const std::string id = us == std::string::npos ? stem : stem.substr(0, us);
        Clip c;
        if (!loadOgg(f.string(), c)) { SDL_Log("audio: cannot decode %s", f.string().c_str()); continue; }
        auto [itn, fresh] = S->byName.try_emplace(id, (int)S->sounds.size());
        if (fresh) { S->sounds.push_back({}); S->sounds.back().name = id; }
        S->sounds[(size_t)itn->second].var.push_back(std::move(c));
        ++S->st.clips;
    }
    S->st.sounds = (int)S->sounds.size();
}

int findSound(const char* name) {
    auto it = S->byName.find(name);
    return it == S->byName.end() ? -1 : it->second;
}

const Clip* pickVar(int si) {
    Sound& s = S->sounds[(size_t)si];
    if (s.var.empty()) return nullptr;
    int v = (int)(S->rng() % s.var.size());
    if (s.var.size() > 1 && v == s.lastVar) v = (v + 1) % (int)s.var.size();   // no immediate repeat
    s.lastVar = v;
    return &s.var[(size_t)v];
}

// camera-height mix, distance falloff, pan and air absorption for one voice
void spatialise(Voice& v) {
    float g = v.base, pan = 0.f, cutoff = 20000.f;
    const float hn = S->hn;
    if (v.positional) {
        const float dx = v.p.x - S->lis.x, dz = v.p.z - S->lis.z;
        const float d = std::sqrt(dx * dx + dz * dz);
        const float ref = 10.f + 0.5f * S->camH;              // audible radius grows with camera height
        g *= 1.f / (1.f + (d / ref) * (d / ref));
        if (d > 0.5f) pan = std::clamp((dx * std::cos(S->yaw) - dz * std::sin(S->yaw)) / d, -1.f, 1.f) * std::min(1.f, d / 6.f);
        cutoff = 18000.f / (1.f + d / (3.f * ref));
    }
    switch (v.cls) {
        case Cls::Individual: g *= std::pow(1.f - hn, 1.6f) + 0.04f; cutoff = std::min(cutoff, 18000.f * (1.f - hn) * (1.f - hn) + 1400.f); break;
        case Cls::Weapon: g *= 0.3f + 0.7f * (1.f - hn); cutoff = std::min(cutoff, 16000.f * (1.f - hn) + 3000.f); break;
        case Cls::Aggregate: cutoff = std::min(cutoff, 9000.f * (1.f - hn) * (1.f - hn) + 1000.f); break;   // far swarm: muffled
        default: break;
    }
    const float a = (pan + 1.f) * kPi * 0.25f;
    v.tl = g * std::cos(a) * 1.4142f; v.tr = g * std::sin(a) * 1.4142f;
    v.lpA = 1.f - std::exp(-2.f * kPi * std::min(cutoff, 20000.f) / kRate);
}

int allocVoice(int prio, float loud) {
    int freeI = -1, worst = -1; float worstScore = 1e9f; int n = 0;
    for (int i = 0; i < kMaxVoices; ++i) {
        Voice& v = S->voices[i];
        if (!v.alive) { if (freeI < 0) freeI = i; continue; }
        ++n;
        if (v.loop) continue;
        const float score = v.prio * 10.f + (v.tl + v.tr);
        if (score < worstScore) { worstScore = score; worst = i; }
    }
    if (freeI >= 0) return freeI;
    if (worst >= 0 && worstScore < prio * 10.f + loud) { ++S->st.stolen; return worst; }
    return -1;
}

int start(int si, Bus bus, Cls cls, float gain, int prio, bool positional, V3 p, bool loop) {
    const Clip* c = pickVar(si);
    if (!c) return -1;
    Voice tmp; tmp.base = gain; tmp.positional = positional; tmp.p = p; tmp.cls = cls; tmp.bus = bus;
    spatialise(tmp);
    if (!loop && positional && tmp.tl + tmp.tr < 0.004f) { ++S->st.culledFar; return -1; }   // inaudible: not a voice
    const int i = allocVoice(prio, tmp.tl + tmp.tr);
    if (i < 0) { ++S->st.dropped; return -1; }
    Voice& v = S->voices[i];
    v = tmp; v.clip = c; v.sound = si; v.pos = loop ? (uint32_t)(S->rng() % std::max<uint32_t>(1, c->frames)) : 0;
    v.loop = loop; v.alive = true; v.prio = prio;
    v.gl = loop ? 0.f : v.tl; v.gr = loop ? 0.f : v.tr;
    ++S->st.started;
    int n = 0; for (const Voice& w : S->voices) n += w.alive;
    S->st.peakVoices = std::max(S->st.peakVoices, n);
    return i;
}

void playMapped(Ev e, V3 pos, float intensity, const char* override = nullptr) {
    const Map& m = kMap[(size_t)e];
    const char* name = override ? override : m.sound;
    const int si = findSound(name);
    if (si < 0) { ++S->st.missing; return; }
    int inst = 0;
    for (const Voice& v : S->voices) inst += v.alive && v.sound == si;
    if (inst >= m.maxInst) { ++S->st.rateLimited; return; }
    const bool positional = m.cls != Cls::Ui;
    start(si, m.bus, m.cls, dbToLin(m.db) * std::clamp(intensity, 0.2f, 2.f), m.prio, positional, pos, false);
}

void mix(int frames) {
    std::vector<float>& out = S->mixBuf;
    out.assign((size_t)frames * 2, 0.f);
    for (Voice& v : S->voices) {
        if (!v.alive) continue;
        const float bg = S->busGain[(size_t)v.bus] * S->master;
        const float dl = (v.tl - v.gl) / frames, dr = (v.tr - v.gr) / frames;   // per-block linear ramp
        const int16_t* s = v.clip->s.data();
        for (int i = 0; i < frames; ++i) {
            if (v.pos >= v.clip->frames) {
                if (v.loop) v.pos = 0; else { v.alive = false; break; }
            }
            const float l = s[v.pos * 2] * (1.f / 32768.f), r = s[v.pos * 2 + 1] * (1.f / 32768.f);
            v.zl += v.lpA * (l - v.zl); v.zr += v.lpA * (r - v.zr);
            v.gl += dl; v.gr += dr;
            out[(size_t)i * 2] += v.zl * v.gl * bg;
            out[(size_t)i * 2 + 1] += v.zr * v.gr * bg;
            ++v.pos;
        }
        v.gl = v.tl; v.gr = v.tr;
    }
    if (S->music.loaded()) {   // music bus, ducked under the battlefield (sfx + voices stay clearly audible)
        float pk = 0.f;
        for (int i = 0; i < frames * 2; ++i) pk = std::max(pk, std::fabs(out[(size_t)i]));
        const MusicConfig& mc = S->music.config();
        const float want = pk > mc.duckThreshold ? dbToLin(mc.duckDb * std::min(1.f, pk / 0.5f)) : 1.f;
        const float blk = (float)frames / kRate;
        S->duck += (want - S->duck) * (1.f - std::exp(-blk / (want < S->duck ? mc.duckAttack : mc.duckRelease)));
        S->music.render(out.data(), frames, S->musicVol * S->master * S->duck);
    }
    for (int i = 0; i < frames; ++i) {   // master peak limiter (fast attack, 150 ms release), then soft clip
        const float pk = std::max(std::fabs(out[(size_t)i * 2]), std::fabs(out[(size_t)i * 2 + 1]));
        const float want = pk > 0.89f ? 0.89f / pk : 1.f;
        S->limEnv = want < S->limEnv ? want : S->limEnv + (1.f - S->limEnv) * (1.f / (0.15f * kRate));
        for (int c = 0; c < 2; ++c) { float& x = out[(size_t)i * 2 + c]; x = std::tanh(x * S->limEnv); }
    }
    S->st.framesMixed += (uint64_t)frames;
}

float smooth01(float x, float a, float b) { const float t = std::clamp((x - a) / (b - a), 0.f, 1.f); return t * t * (3.f - 2.f * t); }

void updateLoops(float dt) {
    const float hn = S->hn, n = (float)S->live;
    float* T = S->loopTarget;
    // owner feedback: from far away the horde must get quieter and muffled, never louder. The swarm layer replaces the
    // individual voices as the camera rises, but the overall level falls with height (and spatialise() lowpasses it).
    const float far = 1.f - 0.45f * hn;
    T[L_HordeS] = smooth01(n, 0.f, 25.f) * (1.f - hn) * 0.8f;                       // a street group, close up
    T[L_HordeM] = smooth01(n, 15.f, 300.f) * (1.f - 0.6f * hn) * 0.75f * far;
    T[L_HordeL] = smooth01(n, 150.f, 2500.f) * (0.15f + 0.35f * hn) * far;        // the swarm roar from above
    T[L_March] = std::clamp(S->stepRate / 25.f, 0.f, 1.f) * (0.35f + 0.65f * hn) * 0.7f;
    T[L_Day] = S->night ? 0.f : 0.8f - 0.25f * hn;
    T[L_Night] = S->night ? 0.8f - 0.25f * hn : 0.f;
    const bool flame = S->now - S->lastFlame < 0.25;
    if (S->flameOn && !flame) playMapped(Ev::FlameStop, S->flamePos, 1.f);
    S->flameOn = flame;
    T[L_Flame] = flame ? 0.9f : 0.f;
    for (int l = 0; l < L_Count; ++l) {
        const float k = 1.f - std::exp(-dt / (l == L_Flame ? 0.05f : 0.6f));
        S->loopGain[l] += (T[l] - S->loopGain[l]) * k;
        int& vi = S->loopVoice[l];
        if (vi < 0 && S->loopGain[l] > 0.01f) {
            const int si = findSound(kLoopSound[l]);
            if (si >= 0) vi = start(si, kLoopBus[l], l == L_Flame ? Cls::Weapon : Cls::Aggregate, 0.f, 9, l == L_Flame, S->flamePos, true);
        }
        if (vi < 0) continue;
        Voice& v = S->voices[vi];
        if (!v.alive || !v.loop) { vi = -1; continue; }
        if (S->loopGain[l] <= 0.005f && T[l] <= 0.f) { v.alive = false; vi = -1; continue; }
        v.base = S->loopGain[l]; v.p = S->flamePos;
        spatialise(v);
    }
}

} // namespace

bool decodeOggStereo48k(const std::string& path, std::vector<int16_t>& pcm, uint64_t& frames) {
    Clip c;
    if (!loadOgg(path, c)) return false;
    pcm.swap(c.s); frames = c.frames;
    return true;
}

const char* evName(Ev e) { return (size_t)e < (size_t)Ev::Count ? kEvNames[(size_t)e] : "?"; }
const Stats& stats() { static Stats empty; return S ? S->st : empty; }
bool enabled() { return S && S->enabled; }

bool init(const std::string& assetsRoot, bool on, bool headless) {
    S = new State();
    for (int& v : S->loopVoice) v = -1;
    S->enabled = on; S->st.enabled = on;
    if (!on) { SDL_Log("audio: disabled (--no-audio)"); return true; }
    if (headless) SDL_SetHint(SDL_HINT_AUDIO_DRIVER, "dummy");
    loadBank(assetsRoot);
    S->music.load((std::filesystem::path(assetsRoot).parent_path() / "music").string(), kRate);
    if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) {
        SDL_Log("audio: SDL audio init failed (%s); events are still counted", SDL_GetError());
    } else {
        SDL_AudioSpec spec{SDL_AUDIO_F32, 2, kRate};
        S->stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, nullptr, nullptr);
        if (S->stream) { SDL_ResumeAudioStreamDevice(S->stream); S->st.deviceOpen = true; }
        else SDL_Log("audio: cannot open playback device (%s)", SDL_GetError());
        const char* d = SDL_GetCurrentAudioDriver();
        S->st.driver = d ? d : "none";
    }
    SDL_Log("audio: driver %s, device %s, %d sounds / %d clips from %s", S->st.driver.c_str(),
            S->st.deviceOpen ? "open" : "closed", S->st.sounds, S->st.clips, assetsRoot.c_str());
    return true;
}

void emit(Ev e, V3 pos, float intensity) {
    if (!S || (size_t)e >= (size_t)Ev::Count) return;
    ++S->st.emitted[(size_t)e];
    if (!S->enabled) return;
    switch (e) {   // music intensity: only from what the game already reports (no separate threat model)
        case Ev::ShotRifle: case Ev::ShotMG: case Ev::ShotSniper: case Ev::ShotCarbine: S->music.note(MusicIn::Shot); break;
        case Ev::ZombieDeath: S->music.note(MusicIn::ZombieKill); break;
        case Ev::Explosion: S->music.note(MusicIn::Explosion, intensity); break;
        case Ev::SoldierDeath: case Ev::AlertCasualty: S->music.note(MusicIn::Casualty); break;
        case Ev::AlertBreach: S->music.note(MusicIn::Breach); break;
        case Ev::CalloutAmmo: playMapped(Ev::Radio, pos, 0.8f); break;   // "Ammo!" = radio squelch + the callout
        default: break;
    }
    if (e == Ev::Footstep) { ++S->stepsThisFrame; return; }
    if (e == Ev::Flame) { S->lastFlame = S->now; S->flamePos = pos; return; }
    double& last = S->lastPlay[(size_t)e];
    if (S->now - last < kMap[(size_t)e].minGap) { ++S->st.rateLimited; return; }
    last = S->now;
    if (e == Ev::Explosion) {
        auto& b = S->blasts;
        b.erase(std::remove_if(b.begin(), b.end(), [](double t) { return S->now - t > 2.0; }), b.end());
        b.push_back(S->now);
        if (b.size() >= 3 && S->now - S->lastChain > 3.0) {   // chain reaction: the deep layer is reserved for this
            S->lastChain = S->now;
            playMapped(e, pos, intensity, "chain_explosion");
            playMapped(e, pos, 0.8f, "debris_rain");
            return;
        }
        playMapped(e, pos, intensity);
        playMapped(Ev::FireWhoosh, pos, intensity * 0.8f);
        return;
    }
    playMapped(e, pos, intensity);
}

void ui(const char* name) {
    if (!S) return;
    ++S->st.uiPlayed;
    if (!S->enabled) return;
    const int si = findSound(name);
    if (si < 0) { ++S->st.missing; return; }
    start(si, Bus::Ui, Cls::Ui, 1.f, 6, false, {}, false);
}

void uiAction(const std::string& id, bool ok) {
    if (!ok) { ui("ui_refused"); return; }
    if (id.rfind("unit.", 0) == 0) {   // squad cards: per-class chirp
        const std::string c = id.substr(5);
        const std::string n = "ui_squad_" + std::string(c == "rifle" ? "rifle" : c == "mg" ? "mg" : c == "sniper" ? "sniper" : c == "engineer" ? "engineer" : "flame");
        ui(n.c_str()); return;
    }
    if (id == "sel.garrison") { ui("ui_order_garrison"); return; }
    if (id == "sel.burn") { ui("ui_order_attack"); return; }
    if (id.rfind("sel.", 0) == 0) { ui("ui_order_move"); return; }
    ui("ui_select");
}

void setHorde(uint32_t live) { if (S) { S->live = live; S->music.setLiveZombies(live); } }
void setMusicVolume(float v) { if (S) S->musicVol = std::clamp(v, 0.f, 2.f); }
void setMusicIntensity(float v) { if (S) S->music.setOverride(v); }
float musicIntensity() { return S ? S->music.intensity() : 0.f; }
void setNight(bool night) {
    if (!S) return;
    if (night != S->night && S->now > 1.0) emit(Ev::DayNight, S->lis);
    S->night = night;
}

void frame(V3 camTarget, float camHeight, float camYaw, float dt) {
    if (!S || !S->enabled) return;
    dt = std::clamp(dt, 0.f, 0.25f);
    S->now += dt;
    S->lis = camTarget; S->camH = std::max(1.f, camHeight); S->yaw = camYaw;
    S->hn = std::clamp(std::sqrt(std::max(0.f, (S->camH - 4.f) / 116.f)), 0.f, 1.f);
    const float rate = dt > 0 ? S->stepsThisFrame / dt : 0.f;
    S->stepRate += (rate - S->stepRate) * (1.f - std::exp(-dt / 1.0f));
    S->stepsThisFrame = 0;
    updateLoops(dt);
    S->music.update(dt);
    for (Voice& v : S->voices) if (v.alive && !v.loop) spatialise(v);
    if (!S->stream) {   // no device: advance voices in time so the voice accounting stays realistic
        const uint32_t adv = (uint32_t)(dt * kRate);
        S->music.advance((int)adv);
        for (Voice& v : S->voices) if (v.alive && !v.loop) { v.pos += adv; if (v.pos >= v.clip->frames) v.alive = false; }
        return;
    }
    const int queued = SDL_GetAudioStreamQueued(S->stream) / (int)(2 * sizeof(float));
    const int want = 3072 - queued;   // keep ~64 ms queued
    if (want <= 0) return;
    mix(want);
    SDL_PutAudioStreamData(S->stream, S->mixBuf.data(), want * 2 * (int)sizeof(float));
}

void shutdown() {
    if (!S) return;
    const Stats& s = S->st;
    std::string line;
    for (size_t i = 0; i < (size_t)Ev::Count; ++i)
        if (s.emitted[i]) { line += kEvNames[i]; line += '='; line += std::to_string(s.emitted[i]); line += ' '; }
    SDL_Log("audio: stats enabled=%d driver=%s device=%d sounds=%d clips=%d started=%llu ui=%llu rateLimited=%llu culledFar=%llu "
            "stolen=%llu dropped=%llu missing=%llu peakVoices=%d mixedSec=%.1f", (int)s.enabled, s.driver.c_str(), (int)s.deviceOpen,
            s.sounds, s.clips, (unsigned long long)s.started, (unsigned long long)s.uiPlayed, (unsigned long long)s.rateLimited,
            (unsigned long long)s.culledFar, (unsigned long long)s.stolen, (unsigned long long)s.dropped, (unsigned long long)s.missing,
            s.peakVoices, s.framesMixed / (double)kRate);
    SDL_Log("audio: events %s", line.empty() ? "(none)" : line.c_str());
    if (S->music.loaded()) {
        std::string m;
        for (const MusicTrack& t : S->music.tracks()) { char b[96]; std::snprintf(b, sizeof(b), "%s=%.1fs ", t.id.c_str(), t.secondsPlayed); m += b; }
        SDL_Log("audio: music %stransitions=%d maxIntensity=%.2f final=%.2f active=%s", m.c_str(), S->music.transitions(),
                S->music.maxIntensity(), S->music.intensity(), S->music.tracks()[(size_t)S->music.activeTrack()].id.c_str());
    }
    if (S->stream) SDL_DestroyAudioStream(S->stream);
    if (S->enabled) SDL_QuitSubSystem(SDL_INIT_AUDIO);
    delete S; S = nullptr;
}

} // namespace ttz::audio
