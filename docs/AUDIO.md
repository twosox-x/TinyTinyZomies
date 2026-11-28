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
