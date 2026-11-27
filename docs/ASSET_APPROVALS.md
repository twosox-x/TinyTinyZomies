# Asset approval record

Only the owner can approve. Status values: **pending review**, **changes requested** (with notes), **approved** (with the date and the owner's words).

## Phase 7 Stage A — military assets

| Asset | Models | Animations | Notes |
|---|---|---|---|
| Rifleman (5 variants) | approved 2026-11-26 | approved 2026-11-27 | |
| Machine gunner | approved 2026-11-26 | approved 2026-11-27 | |
| Suppressed sniper | approved 2026-11-26 | approved 2026-11-27 | |
| Infantry parachute | approved 2026-11-26 | approved 2026-11-27 | |
| Supply-crate parachute | approved 2026-11-26 | approved 2026-11-27 | |
| Small ammo crate | approved 2026-11-26 | n/a | |
| Central ammo supply container | approved 2026-11-26 | n/a | |
| Wall segment / corner / T / end / gate | approved 2026-11-26 | n/a | |
| Building reinforcements | approved 2026-11-26 | n/a | |
| Window and entrance barricades | approved 2026-11-26 | n/a | |
| Garrison indicators and props | approved 2026-11-26 | n/a | |
| Hospital indicators and props | approved 2026-11-26 | n/a | |
| Weapon FX (muzzle flash, tracer, suppressed shot) | n/a | approved 2026-11-27 | |

Animation approval 2026-11-27, owner: "All animations are approved." Two corrections were requested: (1) a death animation where the soldier lies on his weapon; (2) parachutes (infantry and crate) must slowly dissolve and disappear after landing. Both were fixed and are covered by the Stage A sign-off below.

**Stage A COMPLETE (2026-11-27).** Owner: "I have personally reviewed the military 3D models, visual designs and animations. I approve them. Stage A is officially complete. You are now authorized to begin Stage B." This includes the death weapon-drop and parachute-dissolve corrections. Approved assets must not be redesigned without owner permission.

**Stage B gate: OPEN.**

Model approval 2026-11-26, owner: "Yes, amazing, amazing stuff." (reply to the model review sheets: lineup, class sheets, props, RTS crops). Defaults kept for the open questions: gabion walls at 1.6 / 2.4 m, olive chevron garrison flag, green-cross hospital flag, 10 cm canopy voxels, carry pose as default. Machine-gunner readability at 100–150 m is to be handled by a class or squad marker in the Stage B UI, not by changing the model.

## Earlier approvals (for reference)
- Zombie Lab v3 characters: approved (phase 3).
- Downtown and high-rises: approved and locked (phase 5B).
- City layout: tensor generator seed 1, approved by the owner (phase 5).

## Phase 7b — new squads (engineers, flamethrower)

Separate files (`assets/military/specialists.*`, `specialist_anims.*`); the Stage A files are byte-identical (md5 checked).

| Asset | Models | Animations | Notes |
|---|---|---|---|
| Engineer (3 variants) | pending review | changes requested → pending review (v2) | hi-vis helmet band / shoulder panels, big ruck with tools; carbine; build / carry / dismantle clips. Owner: "hands entering their heads while they swing" → v2: swing beside the head, hands kept in front, converter limb-interpenetration check |
| Engineer hand tools (sledgehammer, shovel, cutting torch, pry bar, sandbag, gabion panel) + sandbag pile | pending review | n/a | |
| Flamethrower (2 variants, squad size proposed 2) | pending review | pending review | twin fuel tanks, hood / mask, flame gun with pilot light, procedural hose |
| Flame FX (stream, smoke, ground fire, pilot, corpse burn) + work FX (sparks, dust, dirt) | n/a | changes requested → pending review (v2) | owner: flame "looks ugly — particles; should be the explosion voxel-volume style" → v2 voxel volume; owner: "still terrible — big blocks with space between them; should be one continuous tongue of flame" → v3 continuous 5 cm voxel tongue; orchestrator: wide end read as a maroon blob → v4 bright yellow-orange rope, red only as a thin tip fringe, smoke above the flame (`fx.flame_tongue`), MILITARY_ANIMS.md §7.5 |
