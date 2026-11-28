#pragma once
// App side of the B3a buildings (BuildingPlay.h): loading the BLDG records of the tiles under the simulation window,
// selection / panel / markers (installed into GameUI's building hooks), props drawn through MilitaryRenderer
// (approved flags, banners, barricades, window nests, roof rings, roof positions, ammo stack, antenna, hospital
// awning / stretcher / crate), and the script verbs / metrics.
#include "game/BuildingPlay.h"

#include <string>
#include <vector>

namespace ttz {
struct AppState;
class MilitaryRenderer;
}

namespace ttz::game {

class GameUI;
class GameWorld;
struct BalanceConfig;
struct ScriptLine;

// Adds the tiles under the window and prepares buildings whose footprint the height grid (window cells) covers.
void syncBuildings(AppState& app, BuildingPlay& bp, const std::vector<float>& heights, const BalanceConfig& cfg);
// GameUI hooks (click selection, G = garrison the selected squads, Esc deselects, panel + markers).
void installBuildingUI(GameUI& ui, BuildingPlay& bp);
// 3D props (GameRender::extraDraw). With app: garrison window posts (opened windows: facade cutouts + rooms + interior
// lights, GAME_DESIGN 14e); shutdownBuildingRender releases them.
void drawBuildingProps(MilitaryRenderer& mil, const GameContext& ctx, const BuildingPlay& bp, AppState* app = nullptr);
void shutdownBuildingRender(AppState& app);

// Script verbs (true = handled; err on a usage error):
//   bselect X Z                      select the building at (X, Z) (prints it)
//   binfo                            print the selected building (openings, firing positions, state)
//   blist [R]                        supported / unsupported buildings within R m of the camera pivot (default 150)
//   bdoor N                          move squad N to the selected building's entrance (Move command)
//   brole garrison|hospital          set the role (charged; refused when not captured)
//   bgarrison N                      squad N occupies the selected garrison
//   brelease                         the garrison steps out
//   bbarricade doors|windows planks|plate|sandbags
//   bnest                            window nests / roof rings at every firing position
//   bfortify                         defence level +1 (L1 planks, L2 plates + sandbags, L3 heavy plating + perimeter + roof nests)
//   bcamera DIST [PITCH] [YAWOFF]    camera on the selected building's front
//   bcapture                         TEST HOOK: the selected building is captured
//   bdamage HP                       TEST HOOK: damage the first barricaded door of the selected building
//   bzombies N                       TEST HOOK: zombies inside (what B3b reports) for the selected building
// Metrics: building capture|progress|role|garrison|posted|patients|capacity|positions|supported|barricades|nests|ammo
//            |doors|windows|roofpos|floors|inside|covers|covered|defence|doorart|dooradded|facades|cover_on_firing|cover_low
//          bstat captured|entered|posted|admitted|discharged|healed|barricades|breached|nests|released|ammo
//          buildings | buildings_supported | buildings_prepared | posted_rounds | posted_min_y | posted_roof | posted_window
//          squad_posted N | squad_inside N | squad_maxhp N | squad_hp N
bool buildingVerb(GameWorld& w, const ScriptLine& L, std::string& err);
bool buildingMetric(GameWorld& w, const std::string& m, const std::vector<std::string>& a, size_t& k, double& out, std::string& err);

} // namespace ttz::game
