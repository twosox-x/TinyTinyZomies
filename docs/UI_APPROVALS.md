# UI approvals

Phase 1 is an HTML preview only (`docs/ui_preview/`, published as an Artifact). Nothing goes into the game until the
owner approves a screen. Phase 2 implements approved screens in the ImGui HUD (`HudBar.cpp`, `GameUI`, `FortUI`).

- v1 "Field Kit" (framed plates, stencil tags, voxel item previews): **rejected** 2026-11-28. The owner found it too AI-generated, the arrangement not clean or intuitive, and asked to drop the item previews and use gamified icons, with less interference with the world.
- v2 "Counters" (icon-first, frameless, game-icons.net icons, info shown at the object): **direction approved** by the owner 2026-11-28 ("really like it"). Follow-up asked for: juicy, snappy, satisfying animation and feedback (v2.1). Per-screen approvals still open.

| # | Screen (v2) | Status | Date | Owner notes |
|---|---|---|---|---|
| 0 | Design language | draft | | |
| 1 | Whole screen | draft | | |
| 2 | Build dock | draft | | |
| 3 | Selected squads | draft | | |
| 4 | Buildings and structures (world cards) | draft | | |
| 5 | World markers | draft | | |
| 6 | Placing | draft | | |
| 7 | Alerts | draft | | |
| 8 | Pause and settings | draft | | |
| 9 | Main menu | draft | | |
| 10 | Key bindings | draft | | |

## Sounds in the preview
Resolved 2026-11-28: the preview's temporary synth blips were replaced by the sound design session's approved UI sounds
(ui_hover, ui_select, ui_purchase, ui_refused, ui_tab, ui_pause_open/close; mp3 copies in docs/ui_preview/snd/, sources
assets/audio/sfx/ui/*.ogg on sessionD/sound). In game the HUD plays sounds only through ttz::audio::ui / uiAction.

## Phase 2 (in game), branch sessionE/ui-p2
Done 2026-11-28 after the owner approved the v2 direction and A merged WS-A + sound (7e9891a). Look and theme only;
WS-A's fixed layout, keys (1-7, Tab, Ctrl+n, Esc) and D's sound hooks are unchanged. Sounds only through audio::ui / uiAction.
- Counters palette, Archivo font, game-icons atlas (icons everywhere), token dock, frameless top bar with icons and funds bump,
  selection as round tokens with health rings + ammo lines, token action buttons, alert stack on the right edge, slim
  placement banner, world-card hover menus, frameless world labels (red plate for alerts), building panel restyle (slot dots,
  defence tracks with pips), info cards on hovered structures (nothing selected), pause menu / settings (Music, UI scale,
  DOF, clouds) / key bindings / main menu (windowed only), hover / press / pop / shake tweens.
- Tests (lavapipe, headless): ui_hud 20/20 at 1280x720, 1920x1080, 2560x1440; b1_input 12/12; b2_input 7/7; ui_tower 11/11.
  Captures: docs/media/ui_v2/.
- Not verified headless: structure info cards (the script hover snaps onto parked cars next to the test tower), pause /
  settings / main menu (no capture yet). Audio settings show Music only until D's setBusVolume lands.
- Known gaps: Esc on a settings sub-page closes the menu instead of stepping back; main menu has no keyboard navigation.
