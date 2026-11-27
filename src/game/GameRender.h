#pragma once
// Game -> MilitaryRenderer adapter (WS-B). Once per render frame: gathers the visible soldiers (pose inputs from the
// SoldierPool / AnimPlayback, interpolated between game ticks), deploy canopies (Deploy::drops), supply containers and
// airdrop crates (Logistics::points, approved props + crate clips with canopy dissolve), clip FX (muzzle flashes,
// tracers, casings, puffs, footsteps from the same clip timeline the gameplay events come from, LOD-gated), FxEvents
// (landing dust, impacts), and registers the MilitaryRenderer as a Renderer extension (several clients may coexist:
// the lab and the game no longer fight over one hook).
// World-space RTS feedback for GameUI (WS-D): selection rings under the soldiers of the selected squads, small class
// icons above every squad (chevron = rifle, double chevron = MG, crosshair = sniper; readable at RTS distance) and
// any extra markers the UI queues (move target, ...). Screen-space HUD stays in GameUI.
// --game-demo-render: a static set of soldiers playing clips through this exact path (SoldierAnimator at 30 Hz +
// GameRender), plus a parachute drop, an airdrop crate, a container and markers, for screenshots.
#include "game/GameContext.h"
#include "game/SoldierAnim.h"
#include "lab/MilitaryRenderer.h"

#include <vector>

namespace ttz {
struct AppState;
}

namespace ttz::game {

struct FxEvent;

struct WorldMarker {                   // one world-space marker (GameUI fills GameRender::markers())
    MilMarker shape = MilMarker::MoveTarget;
    uint8_t color = MK_WHITE;          // MilMarkerColor
    V3 pos;
    float yaw = 0.f;
};

class GameRender {
public:
    bool init(AppState& app);          // creates the MilitaryRenderer, registers it with the Renderer
    void shutdown(AppState& app);
    // Render frame: `alpha` = fraction of the current game tick elapsed (pose interpolation).
    void update(AppState& app, const GameContext& ctx, float frameDt, float alpha, const std::vector<FxEvent>& fx);
    MilitaryRenderer* renderer() { return mil_; }
    const MilitaryLibrary* library() const { return mil_ ? &mil_->library() : nullptr; }

    // ---- UI hooks (WS-D)
    void setSelection(const std::vector<SquadId>& squads) { selected_ = squads; }   // rings under their soldiers
    std::vector<WorldMarker>& markers() { return markers_; }   // drawn every frame until the caller changes them
    bool classIcons = true;            // class icon above every squad
    bool soldierRings = false;         // faint ring under every soldier (not only the selected squads)
    static uint8_t classColor(SoldierClass c) { return c == SoldierClass::MachineGunner ? MK_AMBER : c == SoldierClass::Sniper ? MK_CYAN : MK_GREEN; }
    static MilMarker classIcon(SoldierClass c) { return c == SoldierClass::MachineGunner ? MilMarker::IconMG : c == SoldierClass::Sniper ? MilMarker::IconSniper : MilMarker::IconRifle; }

private:
    struct FxTrack { uint32_t gen = ~0u; int clip = -1; float t = 0.f; };
    struct CanopyClock { uint32_t gen = ~0u; float groundT = -1.f; };
    struct CrateSeq { uint32_t gen = ~0u; bool seen = false, landed = false; MilDrop drop; };
    struct DemoSoldier { int infantry = 0; SoldierClass cls = SoldierClass::Rifleman; V3 pos; float yaw = 0; AnimPlayback anim;
                         AnimAction action = AnimAction::Idle; float every = 0.f, clock = 0.f; bool para = false; float alt = 0.f, paraT = 0.f; int squad = 0; };
    void soldierPose(const AnimPlayback& a, int infantry, V3 pos, float yaw, float ahead, MilPoseInput& out) const;
    void clipFx(uint32_t slot, uint32_t gen, const MilPoseInput& p, bool visible, float frameDt, std::vector<FxTrack>& tracks);
    void initDemo(AppState& app);
    void updateDemo(AppState& app, float frameDt);

    MilitaryRenderer* mil_ = nullptr;
    SoldierAnimator anim_;             // render-side helpers (sampleAhead) + the demo's own playback
    std::vector<SquadId> selected_;
    std::vector<WorldMarker> markers_;
    std::vector<FxTrack> fxTracks_, demoFx_;
    std::vector<CanopyClock> canopy_;
    std::vector<CrateSeq> crates_;
    // demo
    bool demo_ = false;
    std::vector<DemoSoldier> demo_s_;
    std::vector<MilDrop> demoDrops_;
    V3 demoOrigin_{};
    float demoYaw_ = 0.f, demoAcc_ = 0.f;
    std::vector<AnimEvent> demoEvents_;
};

} // namespace ttz::game
