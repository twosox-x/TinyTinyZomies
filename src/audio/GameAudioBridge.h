#pragma once
// The ONE adapter between gameplay and audio: reads TickEvents (shots, kills, fx, cues) and horde stats each tick and
// maps them to audio::emit. No gameplay module calls audio directly.
#include <cstdint>

namespace ttz { struct AppState; }
namespace ttz::game { struct TickEvents; struct SoldierPool; }

namespace ttz::audio {

// Call once at the end of GameWorld::tick. Consumes and clears ev.cues.
void bridgeTick(const ttz::AppState& app, ttz::game::TickEvents& ev, const ttz::game::SoldierPool& soldiers);

} // namespace ttz::audio
