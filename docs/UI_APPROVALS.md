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

## Sounds in the preview: placeholders, must be replaced
The UI clicks in the HTML preview (hover tick, press, confirm, deny, tab) are temporary synth blips the UI design
session made for the preview (`docs/ui_preview/juice.js`). They are NOT the sound design session's sounds. Every one
of them must be replaced by the sound session's approved UI sounds. In game, the HUD triggers sounds only through
session D's `uiAction` hook in HudBar.cpp; none of the preview blips go into the game.
