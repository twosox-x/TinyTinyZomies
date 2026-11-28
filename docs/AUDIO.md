# Audio (Phase 2, sessionD/sound)

Approved sound set: docs/SOUND_APPROVALS.md. Sources: docs/SOUND_SOURCES.md. Pipeline: tools/audio/.

## Code
- `src/audio/Audio.{h,cpp}`: SDL3 audio stream (48 kHz stereo float), software mixer, stb_vorbis decoding of
  `assets/audio/sfx/<category>/<id>_<n>.ogg` (all variations loaded at start), buses sfx / voice / ambience / ui / music.
- `src/audio/GameAudioBridge.{h,cpp}`: the only adapter. Reads `TickEvents` (shots, kills, fx, cues) and the sim stats
  (live zombies, roof-edge falls, reanimations) at the end of `GameWorld::tick` and calls `audio::emit`.
- `GameEvents.h`: `AudioCue` / `AudioCueKind` + `TickEvents::cues` for events with no other source. The bridge consumes
  and clears them. Producers can push cues from their own modules; a missing cue is silent.
- Hooks, all marked `// [SOUND HOOK]`: main.cpp (`--no-audio`), App.h (`noAudio`), App.cpp (init, car blasts,
  per-frame listener, shutdown), GameWorld.cpp (one `bridgeTick` call), HudBar.cpp (card / selection / digit-key
  clicks, refused, tab switch), CMakeLists (two sources).

## Mix
- Positional: pan + distance falloff around the camera target; the audible radius grows with camera height.
- Camera height crossfade: individual voices / steps / impacts fade and lowpass as the camera rises (weapons less);
  aggregated loops (horde small / medium / swarm, squad march) take over.
- Horde aggregation: three layered loops driven by the live zombie count and camera height, never one voice per zombie.
  Footsteps are aggregated into the squad-march loop by step rate.
- Explosions: 3 blasts within 2 s -> chain reaction sound (deep layer) + debris; otherwise car explosion + fire whoosh.
- Voice limit 48, priority stealing, per-event rate limits and instance caps, variation without immediate repeats,
  master peak limiter.

## Test
Headless (dummy driver): `./build/ttz --city <synthetic city> --game --headless --count 1 --game-sync --game-script tests/game/b1_combat_loop.txt`
prints `audio: driver dummy, device open, ...` at start and `audio: stats ...` / `audio: events ...` counters at exit.

## Adaptive music (owner request 2026-11-28)
- Tracks: the owner's "The Infection" (default, tier 0) and "The Last Stand" (high intensity, tier 1), used as supplied
  (transcoded Opus -> Ogg Vorbis only; no pitch / speed / level edits). `assets/audio/music/music.json` holds every value:
  tracks, tiers, bar grid, entry / loop points, intensity weights, thresholds, holds, cooldown, crossfade bars, ducking.
  A new composition = a new entry with the next tier; no code change.
- `src/audio/Music.{h,cpp}` (MusicDirector). Intensity = weighted, normalised rates of what the game already reports to
  audio: shots, zombie kills, explosions, live zombies (only while there is shooting), soldier casualties (soldier pool
  alive -> dead in the bridge), breaches / territory lost (bad territory notices -> AlertBreach cue). Smoothed (rise 3 s,
  fall 12 s). Music is its own bus, never a NoiseEvent: it cannot attract zombies.
- Escalate: intensity (smoothed and live) > 0.55 for 12 s; de-escalate: < 0.28 for 25 s; at least 30 s on a track.
  Switches wait for the next bar line (both tracks 92.3 BPM, bar 2.6 s) and crossfade over 4 bars (up) / 8 bars (down).
  Each track keeps its playhead (resumes where it was, snapped to its bar grid); The Last Stand enters at 18.8 s (after its
  quiet intro). Loops: Infection 27.35-120.49 s, Last Stand 71.29-154.37 s (bar-aligned, most similar 2-bar context found
  by chroma / MFCC analysis), 1-bar crossfade at the seam. The track endings are not heard in endless play.
- Mix: music volume -9 dB by default, `audio::setMusicVolume()`, ducked up to -5 dB under loud sfx / voices.
  Manual intensity for testing: `audio::setMusicIntensity(v)` (v < 0 = automatic).
- Test: `tests/audio/music_director_test.cpp` (build line in the file): escalation after a sustained fight, no switching
  while intensity fluctuates 0.5 / 0.2, gradual de-escalation, a 10 s spike ignored.

## Horde mix (owner feedback 2026-11-28)
Zoomed out, the horde now gets quieter and muffled (swarm layer max 0.5 x a height falloff, lowpass down to ~1 kHz at the
top camera height) instead of louder.
