# Sound sources

Every recording used by the Tiny Tiny Zombies sound pipeline. **All sources are CC0 1.0** (public-domain dedication) from
OpenGameArt.org, so no attribution is legally required; authors are credited here anyway. No CC-BY, NC, ND or unclear licences are used.
No sounds were recorded, voice-generated or synthesised by us: the pipeline only edits these recordings. The only generated
signal is the small-room reverb impulse response (a decaying noise burst used as a processor).

Machine-readable version: `assets/audio/sources.json` (per pack: URL, author, licence, download URLs, which files fed which sound).
Reproduce: `python3 tools/audio/fetch_sources.py /tmp/ttz_raw` then `TTZ_AUDIO_RAW=/tmp/ttz_raw python3 tools/audio/build.py /tmp/ttz_preview --repo .`
Raw downloads are not committed (about 400 MB). Processing for every sound is in `tools/audio/recipes.py` (function per sound id).

## Source packs

| Pack | Author | Licence | Used for |
|---|---|---|---|
| [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | rubberduck | CC0 | chain_explosion, container_land, crate_thud, debris_rain, gabion_done, gear_rattle, sledgehammer, tower_climb, tower_collapse, tower_creak, ui_place_confirm, ui_squad_engineer, ui_squad_flame, zombie_reanimate |
| [15 vocal male strain/hurt/pain/jump sounds](https://opengameart.org/content/15-vocal-male-strainhurtpainjump-sounds) | qubodup | CC0 | vo_hurt |
| [202 More Sound Effects](https://opengameart.org/content/202-more-sound-effects) | owlishmedia | CC0 | alert_attack, chute_flutter, ui_order_attack, ui_order_garrison, ui_purchase, ui_select, ui_squad_mg, ui_upgrade_done |
| [33 metal clang sounds from cast iron pans](https://opengameart.org/content/33-metal-clang-sounds-cast-iron-pans) | bart | CC0 | chain_explosion, container_land, debris_rain, impact_metal, zattack_metal |
| [35 wooden cracks/hits/destructions](https://opengameart.org/content/35-wooden-crackshitsdestructions) | qubodup | CC0 | chain_explosion, container_land, debris_rain, impact_wood, roof_fall, tower_collapse, zattack_wood |
| [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0 | burning_puddle, fuel_siphon, gas_bubble, zombie_reanimate |
| [50 RPG sound effects](https://opengameart.org/content/50-rpg-sound-effects) | kenney | CC0 | gear_rattle, sandbag_place, ui_purchase, ui_squad_rifle, zattack_sandbag |
| [51 UI sound effects (buttons, switches and clicks)](https://opengameart.org/content/51-ui-sound-effects-buttons-switches-and-clicks) | kenney | CC0 | ui_order_move, ui_pause_close, ui_pause_open, ui_squad_sniper, ui_tab |
| [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | bart | CC0 | alert_breach, car_dismantle, gabion_done, gabion_place, pry_bar, sledgehammer, ui_order_garrison, ui_place_invalid, ui_place_valid, ui_rotate, ui_upgrade_done |
| [8 wet squish, slurp impacts](https://opengameart.org/content/8-wet-squish-slurp-impacts) | qubodup | CC0 | gore_splat, impact_flesh, roof_fall, zattack_flesh |
| [85 Short music jingles](https://opengameart.org/content/85-short-music-jingles) | kenney | CC0 | sting_daynight |
| [Battle at sea](https://opengameart.org/content/battle-at-sea) | thimras | CC0 | chain_explosion |
| [Bird,cricket,frog and mosquito sounds](https://opengameart.org/content/birdcricketfrog-and-mosquito-sounds) | aj-0 | CC0 | amb_night |
| [Car engine start 01](https://opengameart.org/content/car-engine-start-01) | looneybits | CC0 | gen_start |
| [Car signal](https://opengameart.org/content/car-signal) | yaroslavnovikov | CC0 | amb_day, car_alarm |
| [Catching fire](https://opengameart.org/content/catching-fire) | themightyglider | CC0 | flame_ignite |
| [Cheers](https://opengameart.org/content/cheers-0) | nocturnalvanguard | CC0 | vo_kill |
| [Come on, let's run!](https://opengameart.org/content/come-on-lets-run) | nocturnalvanguard | CC0 | vo_panic |
| [Compressed Gas Leak SFX](https://opengameart.org/content/compressed-gas-leak-sfx) | 0new4y | CC0 | cutting_torch, flame_pilot, flame_roar, flame_stop |
| [Crickets Ambient Noise - loopable](https://opengameart.org/content/crickets-ambient-noise-loopable) | wolfgang | CC0 | amb_night |
| [Different steps on wood, stone, leaves, gravel and mud](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud) | tinyworlds | CC0 | chain_explosion, container_land, crate_thud, debris_rain, gabion_done, gabion_place, impact_concrete, shovel, squad_march, steps_grass, steps_gravel_roof, tower_climb |
| [Electric Buzz](https://opengameart.org/content/electric-buzz) | themightyglider | CC0 | floodlight_hum |
| [Electricity Sound Effects](https://opengameart.org/content/electricity-sound-effects-0) | bmaczero | CC0 | cutting_torch |
| [Equipment Clicks II](https://opengameart.org/content/equipment-clicks-ii) | lfa | CC0 | empty_click |
| [equipment clicks III](https://opengameart.org/content/equipment-clicks-iii) | lfa | CC0 | sniper_suppressed |
| [Explosion](https://opengameart.org/content/explosion-0) | tinyworlds | CC0 | car_explosion, chain_explosion |
| [Explosions](https://opengameart.org/content/explosions-4) | ezduzziteh | CC0 | car_explosion, chain_explosion |
| [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | qubodup | CC0 | sandbag_place, squad_march, steps_asphalt_run, steps_asphalt_walk, steps_grass, zattack_sandbag |
| [Female Scream 1](https://opengameart.org/content/female-scream-1) | nocturnalvanguard | CC0 | amb_day, distant_scream |
| [Fire Crackling](https://opengameart.org/content/fire-crackling) | antumdeluge | CC0 | corpse_fire |
| [Fireplace Sound loop](https://opengameart.org/content/fireplace-sound-loop) | pagdev | CC0 | burning_puddle, corpse_fire, fire_whoosh, flame_pilot, flame_roar, flame_stop |
| [Flare ignition](https://opengameart.org/content/flare-ignition) | qubodup | CC0 | fire_whoosh, flame_ignite |
| [Fly Swatter Squish sound](https://opengameart.org/content/fly-swatter-squish-sound) | qubodup | CC0 | zombie_death |
| [Gastric Distress](https://opengameart.org/content/gastric-distress) | lfa | CC0 | gas_bubble |
| [Generator (loop)](https://opengameart.org/content/generator-loop) | ycbcr | CC0 | gen_out_of_fuel, gen_run, gen_start, gen_stop |
| [Glass Break](https://opengameart.org/content/glass-break) | tinyworlds | CC0 | car_explosion |
| [Gotcha!](https://opengameart.org/content/gotcha) | nocturnalvanguard | CC0 | vo_kill |
| [grunts of male death and pain](https://opengameart.org/content/grunts-male-death-and-pain) | thebardofblasphemy | CC0 | vo_death |
| [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds) | springyspringo | CC0 | reload |
| [Impact](https://opengameart.org/content/impact) | qubodup | CC0 | impact_concrete, impact_flesh |
| [Interface Sounds](https://opengameart.org/content/interface-sounds) | kenney | CC0 | alert_ammo, alert_breach, alert_casualty, ui_hover, ui_pause_close, ui_pause_open, ui_place_invalid, ui_place_valid, ui_refused, ui_squad_engineer, ui_squad_flame, ui_squad_mg, ui_squad_rifle, ui_squad_sniper, ui_upgrade_done |
| [Liquid Bottle Drink Set](https://opengameart.org/content/liquid-bottle-drink-set) | qubodup | CC0 | jerrycan_slosh |
| [Machine shutting down](https://opengameart.org/content/machine-shutting-down) | cough-e | CC0 | gen_out_of_fuel, gen_stop |
| [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | nenadsimic | CC0 | container_land |
| [oh alright!](https://opengameart.org/content/oh-alright) | nocturnalvanguard | CC0 | vo_kill |
| [Park ambiences](https://opengameart.org/content/park-ambiences) | thimras | CC0 | amb_day |
| [Please help somebody!](https://opengameart.org/content/please-help-somebody) | nocturnalvanguard | CC0 | vo_panic |
| [Ripping Into Meat](https://opengameart.org/content/ripping-into-meat) | eldritch-grim | CC0 | gore_splat |
| [RPG Sound Pack](https://opengameart.org/content/rpg-sound-pack) | artisticdude | CC0 | chute_deploy, gear_rattle, sandbag_place, squad_march, steps_asphalt_run, ui_purchase, zattack_flesh |
| [Shovel Sound](https://opengameart.org/content/shovel-sound) | themightyglider | CC0 | shovel |
| [Silencers - By EmoPreben](https://opengameart.org/content/silencers-by-emopreben) | emopreben | CC0 | sniper_suppressed |
| [Sirens and Alarm Noise](https://opengameart.org/content/sirens-and-alarm-noise) | aquinn | CC0 | alert_attack, car_alarm |
| [Static](https://opengameart.org/content/static) | xhunterko | CC0 | radio_chirp |
| [Steam release sounds](https://opengameart.org/content/steam-release-sounds) | bart | CC0 | flame_stop, gas_hiss |
| [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | CC0 | chute_deploy, fire_whoosh, roof_fall |
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | bart | CC0 | carbine_shot, mg_sustained, rifle_burst, rifle_shot |
| [Thwack Sounds](https://opengameart.org/content/thwack-sounds) | antumdeluge | CC0 | alert_ammo, alert_attack, alert_breach, alert_casualty, crate_thud, roof_fall, sting_daynight, ui_order_attack, ui_order_garrison, ui_order_move, ui_pause_close, ui_pause_open, ui_place_confirm, ui_place_invalid, ui_purchase, ui_refused, ui_select, ui_squad_engineer, ui_squad_flame, ui_squad_mg, ui_squad_rifle, ui_squad_sniper, ui_tab, ui_upgrade_done |
| [tree chop fall thud](https://opengameart.org/content/tree-chop-fall-thud) | kheetor | CC0 | crate_thud |
| [Tree Creaking](https://opengameart.org/content/tree-creaking) | antumdeluge | CC0 | tower_creak |
| [Undead Moans](https://opengameart.org/content/undead-moans) | antumdeluge | CC0 | zombie_idle |
| [Voiceover Pack (40+ lines)](https://opengameart.org/content/voiceover-pack-40-lines) | kenney | CC0 | vo_ammo, vo_contact, vo_kill, vo_orders |
| [War on Water: SNDFX](https://opengameart.org/content/war-on-water-sndfx) | yd | CC0 | alert_ammo, car_explosion, chain_explosion, distant_scream, empty_click, plane_flyover, radio_chirp |
| [What, no no that can't happen!](https://opengameart.org/content/what-no-no-that-cant-happen) | nocturnalvanguard | CC0 | vo_panic |
| [Wind](https://opengameart.org/content/wind) | ignasd | CC0 | amb_day, amb_night |
| [Wolf Monster Sound](https://opengameart.org/content/wolf-monster-sound) | caveboytup | CC0 | amb_night |
| [Zombie / Skeleton / Monster Voice Effects](https://opengameart.org/content/zombie-skeleton-monster-voice-effects) | arcadeparty | CC0 | horde_large, horde_medium, horde_small, roof_fall, vo_death, vo_panic, zombie_aggro, zombie_death |
| [Zombie Moans 01 - By EmoPreben](https://opengameart.org/content/zombie-moans-01-by-emopreben) | emopreben | CC0 | zombie_idle |
| [Zombies Sound Pack](https://opengameart.org/content/zombies-sound-pack) | artisticdude | CC0 | amb_night, horde_large, horde_medium, horde_small, zattack_flesh, zattack_metal, zattack_sandbag, zattack_wood, zombie_idle, zombie_reanimate |

## Sounds and processing

| Sound | Category | Variations | Processing |
|---|---|---|---|
| `rifle_shot` | Weapons | 4 | Single rifle shot: AR-15 / SKS / AK recordings, tape x1.7, tail cut, tabletop room. |
| `rifle_burst` | Weapons | 3 | 3-5 round burst (AK-47 short burst), tape x1.65. |
| `mg_sustained` | Weapons | 3 | Long bursts (PPSh, Carl Gustav M45), tape x1.5 - heavier than the rifle, small low layer. |
| `sniper_suppressed` | Weapons | 3 | Silenced shots (EmoPreben) x1.25 + tiny bolt cycle (equipment clicks). |
| `carbine_shot` | Weapons | 3 | Lighter carbine pop (Ruger Mk III .22 / Walther PPQ), tape x1.85. |
| `reload` | Weapons | 3 | Mag out / mag in / charge (gun reload recordings), tape x1.45. |
| `empty_click` | Weapons | 3 | Dry-fire click, tape x1.5. |
| `impact_flesh` | Weapons | 4 | Wet bullet hits (qubodup splats / meat), tape x1.6, 0.25 s. |
| `impact_metal` | Weapons | 3 | Cast-iron and sheet-metal pings, tape x1.7. |
| `impact_concrete` | Weapons | 3 | Stone hit / chip, tape x1.7. |
| `impact_wood` | Weapons | 3 | Wood impacts (35 wooden cracks/hits), tape x1.6. |
| `flame_ignite` | Flamethrower | 3 | Flare ignition + catching fire, tape x1.3. |
| `flame_roar` | Flamethrower | 2 | Pressurised gas jet x1.15 layered with fire roar x1.3; low-mid kept so it feels dangerous. |
| `flame_stop` | Flamethrower | 2 | Jet cut-off: roar tail + steam hiss puff. |
| `flame_pilot` | Flamethrower | 1 | Quiet gas hiss + small flicker. |
| `corpse_fire` | Flamethrower | 2 | Fireplace crackle x1.4 + crackling, small and spitty. |
| `burning_puddle` | Flamethrower | 1 | Low flame + bubbling fuel. |
| `car_explosion` | Explosions | 4 | Crack + body tape x1.45, tight room, controlled low layer (-12 dB) at original pitch. |
| `chain_explosion` | Explosions | 2 | 4-5 car blasts cascading + debris rain; the low layer is raised to -3 dB here - deep impact reserved for chains. |
| `fire_whoosh` | Explosions | 3 | Swish + flare + gas burst - the fireball after a car blows. |
| `debris_rain` | Explosions | 2 | Tiny metal / wood / gravel bits pattering down, tape x1.8. |
| `zombie_idle` | Zombies | 8 | Recorded zombie moans (artisticdude, darsycho, antumdeluge, EmoPreben), pitch x1.32 - squeaky but still gross. |
| `zombie_aggro` | Zombies | 4 | Snarling yells (arcadeparty) pitch x1.3. |
| `zattack_flesh` | Zombies | 3 | Bite + rip + grunt. |
| `zattack_wood` | Zombies | 3 | Fists on planks / doors. |
| `zattack_metal` | Zombies | 3 | Banging on car / container metal. |
| `zattack_sandbag` | Zombies | 3 | Dull thumps on sacks. |
| `horde_small` | Zombies | 1 | ~10 individual squeaky voices layered - what a street group sounds like close up. |
| `horde_medium` | Zombies | 1 | ~40 voices - individual growls start to merge. |
| `horde_large` | Zombies | 1 | ~150 voices + collective low roar (pitched-down lowpassed copy) - thousands from above. |
| `zombie_death` | Zombies | 4 | Death gurgles (arcadeparty) pitch x1.3 + small splat. |
| `zombie_reanimate` | Zombies | 3 | Wet slime squelch + a groan fading in - a corpse getting back up. |
| `roof_fall` | Zombies | 3 | Falling whoosh + short scream-groan + wet crunch landing. |
| `gore_splat` | Zombies | 4 | Wet squish impacts (qubodup / fly swatter), tape x1.4. |
| `steps_asphalt_walk` | Soldiers | 2 | Stone steps x1.75, quick tiny cadence. |
| `steps_asphalt_run` | Soldiers | 2 | Running + gear jingle. |
| `steps_grass` | Soldiers | 2 | Soft sand / leaf steps x1.7. |
| `steps_gravel_roof` | Soldiers | 2 | Gravel crunch x1.7. |
| `squad_march` | Soldiers | 1 | ~40 soldiers' steps + gear layered: the hectic miniature patter of a big squad push. |
| `gear_rattle` | Soldiers | 4 | Chainmail / belt / keys / buckle clicks x1.7 - webbing and kit. |
| `vo_contact` | Soldiers | 2 | "Target engaged!" / "Look out!" (Kenney voiceover, CC0) pitch x1.42, tempo x1.14. |
| `vo_orders` | Soldiers | 6 | "Go go go!", "Cover me!", "Suppressing fire!", "Get down!", "Hold!", "Fire in the hole!". |
| `vo_ammo` | Soldiers | 3 | "Reloading!" / "Call for backup!" - NOTE: no CC0 recording of the word "Ammo!" found yet. |
| `vo_kill` | Soldiers | 4 | "Target destroyed!", "Gotcha!", cheer, "Oh alright!". |
| `vo_panic` | Soldiers | 5 | "Please help somebody!", "Come on, let's run!", "No no no...", yells (nocturnalvanguard / arcadeparty). |
| `vo_hurt` | Soldiers | 4 | Pain grunts (qubodup strain/hurt) pitch x1.42. |
| `vo_death` | Soldiers | 3 | Death cries (arcadeparty humanDeath, grunts of male death). |
| `radio_chirp` | Soldiers | 3 | Radio squelch + static burst, band-limited 300 Hz-3 kHz. |
| `plane_flyover` | Supply | 2 | Prop-plane pass tape x1.35 (toy-like RC buzz) with pan sweep, low layer -12 dB keeps it big. |
| `chute_deploy` | Supply | 3 | Fabric snap: swish + heavy cloth x1.4. |
| `chute_flutter` | Supply | 1 | Cloth rustle looped with a 9 Hz flap tremolo. |
| `crate_thud` | Supply | 3 | Wooden crate thud x1.3 + small low layer (-8 dB). |
| `container_land` | Supply | 2 | Steel slam x1.2 + metal debris + strong low layer (-3 dB): the one supply sound with real weight. |
| `sledgehammer` | Engineering | 3 | Metal hammering hits (bart workshop / rubberduck) x1.5. |
| `shovel` | Engineering | 3 | Shovel dig + gravel scoop x1.5. |
| `cutting_torch` | Engineering | 1 | Gas jet x1.4 + continuous spark crackle. |
| `pry_bar` | Engineering | 3 | Metal scrape / drag (workshop) x1.5. |
| `sandbag_place` | Engineering | 3 | Heavy sack thump + sand shuffle. |
| `gabion_place` | Engineering | 2 | Wire mesh clatter + gravel pour. |
| `gabion_done` | Engineering | 1 | Final clank + settling gravel + a satisfied tap. |
| `car_dismantle` | Engineering | 3 | Ratchet + metal drops + short drill. |
| `fuel_siphon` | Engineering | 1 | Trickling liquid + glugging bubbles x1.3. |
| `jerrycan_slosh` | Engineering | 3 | Bottle shake recordings x1.2 - a little fuel can. |
| `tower_climb` | Structures | 2 | Ladder creaks + wood steps x1.6. |
| `tower_creak` | Structures | 3 | Tree creak + wood squeak x1.4 - strained timber. |
| `tower_collapse` | Structures | 2 | Breaking + cracking + falling timbers x1.4, low layer -6 dB. |
| `gen_start` | Structures | 2 | Engine crank (car engine start) x1.4 into the generator loop. |
| `gen_run` | Structures | 1 | Small petrol generator x1.35 - buzzy little engine. |
| `gen_stop` | Structures | 1 | Run + machine shutting down x1.35. |
| `gen_out_of_fuel` | Structures | 2 | Engine coughs and sputters (gated run), then dies. |
| `floodlight_hum` | Structures | 1 | Electric buzz looped, x1.1, with a faint 50 Hz-ish body. |
| `amb_day` | Environment | 1 | Wind x1.2 + birds x1.4 + far tiny car alarm + distant tiny scream - a quiet street. |
| `amb_night` | Environment | 1 | Crickets x1.3 + low wind + distant tiny howl and groan. |
| `car_alarm` | Environment | 2 | Car signal / siren x1.5 - a toy-sized alarm. |
| `distant_scream` | Environment | 3 | Screams pitched x1.42, lowpassed, roomy - far off in the city. |
| `gas_hiss` | Environment | 1 | Steam hiss x1.3, filtered. |
| `gas_bubble` | Environment | 1 | Gastric bubbling + bubble loop x1.3 - rot gas from corpses. |
| `ui_tab` | UI | 3 | Model-kit toggle switch x1.3 + small body. |
| `ui_hover` | UI | 3 | Tiny dry tick x1.4. |
| `ui_select` | UI | 3 | Small metal latch x1.4 + body. |
| `ui_purchase` | UI | 3 | Crisp latch ka-chunk with body, then a small cash tick (coin). |
| `ui_refused` | UI | 2 | Short muted double buzz (error buzz lowpassed) + dull thunk. |
| `ui_place_valid` | UI | 2 | Light toggle snick + tiny clink. |
| `ui_place_invalid` | UI | 2 | Dull low buzz + muffled clunk. |
| `ui_place_confirm` | UI | 3 | Wooden thud with real low body + latch tick. |
| `ui_rotate` | UI | 3 | Ratchet tooth x1.4. |
| `ui_squad_rifle` | UI | 2 | Per-class chirp: its own latch/click + a tiny pitched blip. |
| `ui_squad_mg` | UI | 2 | Per-class chirp: its own latch/click + a tiny pitched blip. |
| `ui_squad_sniper` | UI | 2 | Per-class chirp: its own latch/click + a tiny pitched blip. |
| `ui_squad_engineer` | UI | 2 | Per-class chirp: its own latch/click + a tiny pitched blip. |
| `ui_squad_flame` | UI | 2 | Per-class chirp: its own latch/click + a tiny pitched blip. |
| `ui_order_move` | UI | 2 | Quick switch double-tick. |
| `ui_order_attack` | UI | 2 | Sharp metal latch snap + body. |
| `ui_order_garrison` | UI | 2 | Little door latch closing + clink. |
| `ui_pause_open` | UI | 1 | Panel switch up + body. |
| `ui_pause_close` | UI | 1 | Panel switch down + body. |
| `alert_attack` | UI | 1 | Tiny alarm blip (siren x1.4) over a latch snap. |
| `alert_breach` | UI | 1 | Glitchy double warning + metal clunk. |
| `alert_ammo` | UI | 1 | Question blip + tiny dry-fire click. |
| `alert_casualty` | UI | 1 | Low bong with weight. |
| `ui_upgrade_done` | UI | 2 | Ratchet zip + latch + coin ping. |
| `sting_daynight` | UI | 2 | Short percussive jingle (Kenney jingles), dry, with body. |
