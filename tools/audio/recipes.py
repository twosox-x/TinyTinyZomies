"""Sound recipes for Tiny Tiny Zombies ("Night of the Mini Dead" miniature treatment).

Each recipe builds one sound from recorded CC0 sources. The same recipe runs twice:
  MINI=True  -> miniaturised (the design),
  MINI=False -> "original": identical edit / layering but no pitch, speed, EQ or room treatment (A/B reference).

Miniature rules, per category (not just "pitch everything up"):
  weapons     tape x1.6-1.9 (transient + body up), hp 160-200 Hz, +3 dB presence, the full-size outdoor tail
              is cut and replaced by a tight 60-80 ms tabletop room.
  explosions  tape x1.4-1.5 for the crack / body, plus a controlled low layer = the ORIGINAL lowpassed at
              100-120 Hz at original pitch (-12 dB single, -3 dB chain reaction) so big events stay grounded.
  zombies     rubberband pitch x1.3 (tempo x1.08), keeps the gnarl; hordes = many layered voices plus, when
              large, a pitched-down lowpassed copy for the collective roar.
  voices      rubberband pitch x1.42 tempo x1.14 (squeaky, slightly sped up, still intelligible).
  foley       tape x1.5-1.8, hp, tiny room.
  ambience    gentler (x1.2-1.4), everything far is lowpassed.
  UI          non-diegetic: not miniaturised (only trimmed / levelled).
"""
import glob, os
import numpy as np
import dsp as D
from dsp import SR

RAW = os.environ.get("TTZ_AUDIO_RAW", "raw")
MINI = True
USED = {}          # pack -> set(files), filled while building (for the manifest)
CUR_ID = None


def S(pack, name):
    """Resolve a source file by pack slug prefix + basename (substring) and load it."""
    c = [p for p in glob.glob(f"{RAW}/{pack}*/**/*", recursive=True)
         if os.path.basename(p).startswith(name) and p.lower().endswith((".wav", ".ogg", ".flac", ".mp3")) and "__MACOSX" not in p]
    c = sorted(c, key=lambda p: (not p.endswith((".wav", ".flac")), len(p)))
    if not c: raise FileNotFoundError(f"{pack}/{name}")
    p = c[0]
    slug = p[len(RAW) + 1:].split("/")[0]
    USED.setdefault(slug, {}).setdefault(os.path.relpath(p, f"{RAW}/{slug}"), set()).add(CUR_ID)
    return p


def L(pack, name, start=None, dur=None):
    return D.load(S(pack, name), start, dur)


def ev(pack, name, i=0, **kw):
    e = D.events(L(pack, name), **kw)
    return e[i % len(e)]


# ---- treatment helpers (no-ops when MINI is False) -------------------------------------------
def T(x, k): return D.tape(x, k) if MINI else x


def P(x, r, tempo=1.0): return D.pitch(x, r, tempo) if MINI else x


def HP(x, f): return D.hp(x, f) if MINI else x


def LPm(x, f): return D.lp(x, f) if MINI else x


def EQ(x, f, g, q=1.0): return D.peq(x, f, g, q) if MINI else x


def ROOM(x, rt=0.07, wet=0.18): return D.room(x, rt, wet) if MINI else x


def CUT(x, dur, fade=0.08): return D.cut(x, dur, fade) if MINI else x


def LOW(orig, f=110, g=-12):
    """Controlled low-end layer for big events: original pitch, lowpassed."""
    return D.lp(orig, f, 4) * D.db(g) if MINI else orig * 0


def jit(a=0.06): return 1 + (D.RNG.random() * 2 - 1) * a


# ---- category processors ---------------------------------------------------------------------
def gun(x, k=1.7, tail=0.33, h=180):
    x = D.autotrim(x)
    y = T(x, k * jit(0.04)); y = HP(y, h); y = EQ(y, 3500, 3, 0.8); y = CUT(y, tail, 0.12)
    return ROOM(y, 0.07, 0.2)


def foley(x, k=1.6, h=150, rt=0.06, wet=0.16):
    x = D.autotrim(x)
    return ROOM(HP(T(x, k * jit()), h), rt, wet)


def voice(x):
    x = D.autotrim(x, -40)
    y = P(x, 1.42 * jit(0.03), 1.14); y = HP(y, 220); y = EQ(y, 4000, 3, 0.9)
    return ROOM(y, 0.05, 0.12)


def zvoice(x, r=1.32):
    x = D.autotrim(x, -40)
    y = P(x, r * jit(0.05), 1.08); y = HP(y, 140); y = EQ(y, 2500, 2, 0.7)
    return ROOM(y, 0.07, 0.15)


def boom(x, k=1.45, low=-12, tail=1.6):
    x = D.autotrim(x)
    y = T(x, k * jit(0.04)); y = HP(y, 70); y = CUT(y, tail, 0.5); y = ROOM(y, 0.12, 0.2)
    lo = LOW(x, 110, low)[:int(tail * 1.6 * SR)]
    return D.mix([(y, 0, 0), (D.fadeout(lo.copy(), 0.6), 0, 0)])


def amb(x, k=1.25, h=200):
    return HP(T(x, k), h)


# ---- sources (names) -------------------------------------------------------------------------
FA = "the-free-firearm"
ZOMB = [f"zombie-{i}." for i in range(1, 25)]
KEN = "voiceover-pack-40"


def kv(line):  # Kenney male war voice line
    c = [p for p in glob.glob(f"{RAW}/{KEN}*/**/{line}.ogg", recursive=True) if "Male" in p or "male" in p]
    p = sorted(c, key=lambda p: ("Female" in p, p))[0]
    slug = p[len(RAW) + 1:].split("/")[0]
    USED.setdefault(slug, {}).setdefault(os.path.relpath(p, f"{RAW}/{slug}"), set()).add(CUR_ID)
    return D.load(p)


# ---- recipes ---------------------------------------------------------------------------------
R = []


def recipe(id, cat, title, desc, nvar=3, target=-16, mode="max"):
    def deco(fn):
        R.append(dict(id=id, cat=cat, title=title, desc=desc, nvar=nvar, target=target, mode=mode, fn=fn))
        return fn
    return deco


# WEAPONS -------------------------------------------------------------------------------------
@recipe("rifle_shot", "Weapons", "Rifle shot", "Single rifle shot: AR-15 / SKS / AK recordings, tape x1.7, tail cut, tabletop room.", 4, -13)
def _(v):
    src = [("D_32P", 0), ("U_14P", 0), ("C_28P", 0), ("D_32P", 1)][v]
    return gun(ev(FA, src[0], src[1]))


@recipe("rifle_burst", "Weapons", "Rifle burst", "3-5 round burst (AK-47 short burst), tape x1.65.", 3, -13)
def _(v):
    return gun(ev(FA, ["C_29P", "C_29P", "G_33P"][v], v), 1.65, 0.75)


@recipe("mg_sustained", "Weapons", "MG sustained fire", "Long bursts (PPSh, Carl Gustav M45), tape x1.5 - heavier than the rifle, small low layer.", 3, -12)
def _(v):
    x = D.autotrim(ev(FA, ["P_34P", "G_35P", "C_27P"][v], 0, gap=0.2))
    y = gun(x, 1.5, 2.2, 140)
    return D.mix([(y, 0, 0), (LOW(x, 140, -16)[:len(y)], 0, 0)])


@recipe("sniper_suppressed", "Weapons", "Suppressed sniper", "Silenced shots (EmoPreben) x1.25 + tiny bolt cycle (equipment clicks).", 3, -17)
def _(v):
    shot = gun(L("silencers", f"Silencers - {[1, 4, 7][v]}."), 1.25, 0.3, 200)
    bolt = foley(ev("equipment-clicks-iii", "", 2 + v), 1.4)
    return D.mix([(shot, 0, 0), (bolt, 0.42, -6)])


@recipe("carbine_shot", "Weapons", "Engineer carbine", "Lighter carbine pop (Ruger Mk III .22 / Walther PPQ), tape x1.85.", 3, -15)
def _(v):
    return gun(ev(FA, ["R_35P", "X_39P", "R_35P"][v], v), 1.85, 0.25, 220)


@recipe("reload", "Weapons", "Reload", "Mag out / mag in / charge (gun reload recordings), tape x1.45.", 3, -20)
def _(v):
    files = sorted(os.path.basename(p) for p in glob.glob(f"{RAW}/gun-reload-sounds/*") if not os.path.isdir(p))
    x = L("gun-reload-sounds", files[v % len(files)])
    return foley(x, 1.45, 200)


@recipe("empty_click", "Weapons", "Empty click", "Dry-fire click, tape x1.5.", 3, -22)
def _(v):
    return foley(ev("equipment-clicks-ii", "", v * 3) if v else L("war-on-water", "gunempty"), 1.5, 300)


@recipe("impact_flesh", "Weapons", "Impact: flesh", "Wet bullet hits (qubodup splats / meat), tape x1.6, 0.25 s.", 4, -18)
def _(v):
    x = L("8-wet", f"impactsplat0{v + 1}") if v < 3 else L("impact", "qubodupImpactMeat01")
    return CUT(foley(x, 1.6), 0.3)


@recipe("impact_metal", "Weapons", "Impact: car metal", "Cast-iron and sheet-metal pings, tape x1.7.", 3, -19)
def _(v):
    x = L("33-metal", f"cast iron clangs - Marker #{[3, 12, 21][v]}.")
    return CUT(foley(x, 1.7, 300), 0.35)


@recipe("impact_concrete", "Weapons", "Impact: concrete", "Stone hit / chip, tape x1.7.", 3, -19)
def _(v):
    x = L("impact", "qubodupImpactStone") if v == 0 else ev("different-steps", "stone01", v)
    return CUT(foley(x, 1.7 + 0.15 * v, 250), 0.25)


@recipe("impact_wood", "Weapons", "Impact: wood", "Wood impacts (35 wooden cracks/hits), tape x1.6.", 3, -19)
def _(v):
    return CUT(foley(L("35-wooden", f"impactwood0{[2, 5, 8][v]}"), 1.6), 0.3)


# FLAMETHROWER --------------------------------------------------------------------------------
def gas(dur, k=1.15):
    return D.stretch_loop(amb(D.autotrim(L("compressed-gas-leak", "compressed_gas_leak_0")), k, 150), dur)


def fire(dur, k=1.3, start=3.0):
    return amb(L("fireplace-sound-loop", "fire", start, dur * k + 0.2), k, 250)[:int(dur * SR)]


@recipe("flame_ignite", "Flamethrower", "Ignite", "Flare ignition + catching fire, tape x1.3.", 3, -16)
def _(v):
    a = foley(L("flare-ignition", ""), 1.3 * jit(), 150)
    b = foley(L("catching-fire", ""), 1.2, 150)
    return D.mix([(a, 0, 0), (b, 0.05 + 0.05 * v, -3)])


@recipe("flame_roar", "Flamethrower", "Roar (loop)", "Pressurised gas jet x1.15 layered with fire roar x1.3; low-mid kept so it feels dangerous.", 2, -15)
def _(v):
    g = gas(4.0); f = fire(4.0, 1.3, 3 + 7 * v)
    return D.loopify(D.mix([(g, 0, -2), (f, 0, 0)]), 0.5)


@recipe("flame_stop", "Flamethrower", "Stop", "Jet cut-off: roar tail + steam hiss puff.", 2, -17)
def _(v):
    g = D.fadeout(D.mix([(gas(0.6), 0, -2), (fire(0.6), 0, 0)]), 0.5)
    h = foley(L("steam-release", f"steam hisses - Marker #{v + 1}."), 1.3, 300)
    return D.mix([(g, 0, 0), (CUT(h, 0.6, 0.3), 0.35, -6)])


@recipe("flame_pilot", "Flamethrower", "Pilot light (loop)", "Quiet gas hiss + small flicker.", 1, -26, "int")
def _(v):
    return D.loopify(D.mix([(LPm(gas(5.0), 4000), 0, -6), (fire(5.0, 1.5, 12), 0, -10)]), 0.5)


@recipe("corpse_fire", "Flamethrower", "Corpse fire crackle (loop)", "Fireplace crackle x1.4 + crackling, small and spitty.", 2, -24, "int")
def _(v):
    a = fire(6.0, 1.4, 5 + 9 * v)
    b = D.stretch_loop(amb(L("fire-crackling", ""), 1.3, 300), 6.0)
    return D.loopify(D.mix([(a, 0, 0), (b, 0, -4)]), 0.6)


@recipe("burning_puddle", "Flamethrower", "Burning puddle (loop)", "Low flame + bubbling fuel.", 1, -24, "int")
def _(v):
    a = fire(6.0, 1.2, 18)
    b = amb(D.stretch_loop(L("40-cc0-water", "loop_bubbles_1"), 6.0 * 1.3), 1.3, 150)[:6 * SR]
    return D.loopify(D.mix([(a, 0, 0), (b, 0, -8)]), 0.6)


# EXPLOSIONS ----------------------------------------------------------------------------------
BOOMS = [("explosions-4", "explosion1_0"), ("explosion-0", "explosion"), ("war-on-water", "boatexplode"),
         ("war-on-water", "shipexplode"), ("battle-at-sea", "ship_destroyed_short")]


@recipe("car_explosion", "Explosions", "Car explosion", "Crack + body tape x1.45, tight room, controlled low layer (-12 dB) at original pitch.", 4, -11)
def _(v):
    p, n = BOOMS[v]
    return D.mix([(boom(L(p, n)), 0, 0), (foley(L("glass-break", ""), 1.6, 300), 0.03, -10)])


def debris(dur=2.5, n=22, k=1.8):
    parts = []
    srcs = [("100-cc0-metal", "metal_falling_01"), ("100-cc0-metal", "wood_falling_02"), ("35-wooden", "impactwood1"),
            ("33-metal", "cast iron clangs - Marker #1"), ("different-steps", "gravel")]
    for i in range(n):
        p, s = srcs[i % len(srcs)]
        e = ev(p, s, i)
        x = CUT(foley(e, k * jit(0.15), 300), 0.25)
        t = (D.RNG.random() ** 1.6) * dur
        parts.append((D.pan(x, D.RNG.random() * 1.6 - 0.8), 0.15 + t, -6 - 10 * t / dur - D.RNG.random() * 6))
    return D.mix(parts)


@recipe("chain_explosion", "Explosions", "Chain reaction", "4-5 car blasts cascading + debris rain; the low layer is raised to -3 dB here - deep impact reserved for chains.", 2, -9)
def _(v):
    parts, t = [], 0.0
    for i in range(5):
        p, n = BOOMS[(i + v) % len(BOOMS)]
        x = L(p, n)
        parts.append((D.pan(boom(x, 1.45, -3), [-0.5, 0.3, -0.1, 0.6, -0.7][i]), t, -2 * i * 0.5))
        t += 0.28 + 0.25 * D.RNG.random()
    parts.append((debris(3.0, 30), 0.2, -2))
    return D.mix(parts)


@recipe("fire_whoosh", "Explosions", "Fire whoosh", "Swish + flare + gas burst - the fireball after a car blows.", 3, -15)
def _(v):
    sw = foley(L("swishes", f"swish-{[2, 6, 10][v]}."), 1.0 if not MINI else 0.9, 80)
    fl = foley(L("flare-ignition", ""), 1.1, 120)
    return D.mix([(sw, 0, 0), (fl, 0.02, -3), (D.fadeout(fire(1.2, 1.2, 10), 0.8), 0.05, -4)])


@recipe("debris_rain", "Explosions", "Debris rain", "Tiny metal / wood / gravel bits pattering down, tape x1.8.", 2, -18)
def _(v):
    return debris(2.5, 26)


# ZOMBIES -------------------------------------------------------------------------------------
@recipe("zombie_idle", "Zombies", "Idle groans", "Recorded zombie moans (artisticdude, darsycho, antumdeluge, EmoPreben), pitch x1.32 - squeaky but still gross.", 8, -19)
def _(v):
    if v < 6: x = L("zombies-sound-pack", ZOMB[[0, 3, 7, 11, 15, 19][v]])
    elif v == 6: x = L("zombie-moans-01", "")
    else: x = L("undead-moans", "")
    return zvoice(x)


@recipe("zombie_aggro", "Zombies", "Aggro", "Snarling yells (arcadeparty) pitch x1.3.", 4, -17)
def _(v):
    return zvoice(L("zombie-skeleton", f"zombieYell{[1, 3, 6, 9][v]}."), 1.3)


def attack(hit, v):
    z = zvoice(L("zombies-sound-pack", ZOMB[[2, 9, 17][v]]), 1.35)
    z = CUT(z, 0.6, 0.2)
    return D.mix([(hit, 0, 0), (z, 0.0, -6), (hit, 0.32, -3)])


@recipe("zattack_flesh", "Zombies", "Attack: flesh", "Bite + rip + grunt.", 3, -17)
def _(v):
    hit = CUT(foley(D.mix([(L("rpg-sound-pack", ["bite-small.", "bite-small2", "bite-small3"][v]), 0, 0),
                           (L("8-wet", f"impactsplat0{v + 4}"), 0.02, -4)]), 1.5), 0.35)
    return attack(hit, v)


@recipe("zattack_wood", "Zombies", "Attack: wood", "Fists on planks / doors.", 3, -17)
def _(v):
    return attack(CUT(foley(L("35-wooden", f"impactwood1{v + 3}"), 1.5), 0.3), v)


@recipe("zattack_metal", "Zombies", "Attack: metal", "Banging on car / container metal.", 3, -17)
def _(v):
    return attack(CUT(foley(L("33-metal", f"cast iron clangs - Marker #{[5, 15, 25][v]}."), 1.6, 200), 0.35), v)


@recipe("zattack_sandbag", "Zombies", "Attack: sandbags", "Dull thumps on sacks.", 3, -18)
def _(v):
    hit = CUT(foley(D.mix([(L("50-rpg", ["dropLeather", "handleSmallLeather", "cloth4"][v]), 0, 0),
                           (L("fantozzi", ["Fantozzi-SandL1", "Fantozzi-SandR2", "Fantozzi-SandL3"][v]), 0, -2)]), 1.4), 0.3)
    return attack(hit, v)


def horde(n, dur=12.0, seed=0, spread=1.0):
    D.seed(1000 + n + seed)
    parts = []
    srcs = ZOMB + ["zombieYell"]
    for i in range(n):
        if i % 7 == 6: x = L("zombie-skeleton", f"zombieYell{1 + i % 10}.")
        else: x = L("zombies-sound-pack", ZOMB[i % 24])
        x = D.autotrim(x, -40)
        x = T(x, 1.25 + 0.3 * D.RNG.random()) if MINI else x
        x = HP(x, 140)
        g = -6 - 10 * D.RNG.random() - 10 * np.log10(max(n, 1) / 4)
        parts.append((D.pan(x, (D.RNG.random() * 2 - 1) * spread), D.RNG.random() * dur, g))
    y = D.mix(parts, dur + 1.0)
    # wrap the overhang into the head so the loop is seamless
    tail = y[int(dur * SR):]; y = y[:int(dur * SR)].copy(); y[:len(tail)] += tail
    return ROOM(y, 0.09, 0.2)[:int(dur * SR)]


@recipe("horde_small", "Zombies", "Horde: small (loop)", "~10 individual squeaky voices layered - what a street group sounds like close up.", 1, -20, "int")
def _(v):
    return horde(10)


@recipe("horde_medium", "Zombies", "Horde: medium (loop)", "~40 voices - individual growls start to merge.", 1, -18, "int")
def _(v):
    return horde(40, seed=1)


@recipe("horde_large", "Zombies", "Horde: swarm roar (loop)", "~150 voices + collective low roar (pitched-down lowpassed copy) - thousands from above.", 1, -16, "int")
def _(v):
    y = horde(150, seed=2)
    if MINI:
        roar = D.lp(D.tape(y, 0.72), 900, 2)[:len(y)]
        roar = np.concatenate([roar, roar])[:len(y)]
        y = D.lp(y, 5500) + roar * D.db(-4)
    return y


@recipe("zombie_death", "Zombies", "Death", "Death gurgles (arcadeparty) pitch x1.3 + small splat.", 4, -17)
def _(v):
    z = zvoice(L("zombie-skeleton", f"zombieDeath{v + 1}."), 1.3)
    return D.mix([(z, 0, 0), (CUT(foley(L("fly-swatter", ["flyswatter.", "flyswatter2", "flyswatter3", "flyswatter4"][v]), 1.5), 0.3), 0.1, -8)])


@recipe("zombie_reanimate", "Zombies", "Reanimation", "Wet slime squelch + a groan fading in - a corpse getting back up.", 3, -18)
def _(v):
    sl = foley(L("40-cc0-water", f"slime_0{v + 2}"), 1.3)
    g = D.fadein(zvoice(L("zombies-sound-pack", ZOMB[[4, 13, 21][v]]), 1.25), 0.4)
    bones = foley(L("100-cc0-metal", "wood_squeak_01"), 1.8, 300)
    return D.mix([(sl, 0, 0), (bones, 0.15, -8), (g, 0.35, -2)])


@recipe("roof_fall", "Zombies", "Roof fall + splat", "Falling whoosh + short scream-groan + wet crunch landing.", 3, -15)
def _(v):
    sw = foley(L("swishes", f"swish-{[3, 7, 11][v]}."), 0.8 if MINI else 1.0, 100)
    z = CUT(zvoice(L("zombie-skeleton", f"zombieYell{[2, 5, 8][v]}."), 1.4), 0.5, 0.2)
    land = D.mix([(foley(L("8-wet", f"impactsplat0{[1, 3, 6][v]}"), 1.3), 0, 0),
                  (foley(L("35-wooden", f"crack0{v + 2}"), 1.6, 200), 0.0, -6),
                  (LOW(D.autotrim(L("thwack", f"thwack-0{v + 1}")), 120, -10), 0, 0)])
    return D.mix([(z, 0, -3), (sw, 0.1, -4), (land, 0.75, 0)])


@recipe("gore_splat", "Zombies", "Gore splat", "Wet squish impacts (qubodup / fly swatter), tape x1.4.", 4, -17)
def _(v):
    x = L("8-wet", f"impactsplat0{v + 5}") if v < 3 else L("ripping-into-meat", "")
    return CUT(foley(x, 1.4), 0.6)


# SOLDIERS ------------------------------------------------------------------------------------
def steps(srcs, n, spacing, k, gear=False, j=0.06):
    parts, t = [], 0.0
    for i in range(n):
        p, s = srcs[i % len(srcs)]
        x = CUT(foley(ev(p, s, i), k * jit(0.05), 300, 0.04, 0.1), 0.2, 0.05)
        parts.append((x, t, -1.5 * (i % 2)))
        if gear and i % 2 == 0:
            parts.append((CUT(foley(ev("rpg-sound-pack", ["chainmail1", "chainmail2"][i // 2 % 2], i), 1.7, 400), 0.25), t + 0.02, -12))
        t += spacing * (1 + (D.RNG.random() * 2 - 1) * j)
    return D.mix(parts)


STONE = [("fantozzi", f"Fantozzi-Stone{s}") for s in ["L1", "R1", "L2", "R2", "L3", "R3"]]
SAND = [("fantozzi", f"Fantozzi-Sand{s}") for s in ["L1", "R1", "L2", "R2", "L3", "R3"]]
LEAF = [("different-steps", "leaves01"), ("different-steps", "leaves02")]
GRAV = [("different-steps", "gravel")]


@recipe("steps_asphalt_walk", "Soldiers", "Footsteps: asphalt walk", "Stone steps x1.75, quick tiny cadence.", 2, -24)
def _(v): return steps(STONE[v:] + STONE[:v], 6, 0.36 if MINI else 0.5, 1.75)


@recipe("steps_asphalt_run", "Soldiers", "Footsteps: asphalt run", "Running + gear jingle.", 2, -22)
def _(v): return steps(STONE[v:] + STONE[:v], 8, 0.21 if MINI else 0.3, 1.8, True)


@recipe("steps_grass", "Soldiers", "Footsteps: grass", "Soft sand / leaf steps x1.7.", 2, -26)
def _(v): return steps((SAND + LEAF)[v:] + (SAND + LEAF)[:v], 6, 0.36 if MINI else 0.5, 1.7)


@recipe("steps_gravel_roof", "Soldiers", "Footsteps: gravel roof", "Gravel crunch x1.7.", 2, -24)
def _(v): return steps(GRAV, 6, 0.36 if MINI else 0.5, 1.7 + 0.1 * v)


@recipe("squad_march", "Soldiers", "Many soldiers moving (loop)", "~40 soldiers' steps + gear layered: the hectic miniature patter of a big squad push.", 1, -22, "int")
def _(v):
    parts = []
    for s in range(40):
        D.seed(500 + s)
        x = steps(STONE + GRAV, 10, 0.22 if MINI else 0.3, 1.75, s % 3 == 0, 0.12)
        parts.append((D.pan(x, D.RNG.random() * 2 - 1), D.RNG.random() * 3.0, -8 - D.RNG.random() * 8))
    y = D.mix(parts, 6.0)
    return D.loopify(y, 0.8)


@recipe("gear_rattle", "Soldiers", "Gear rattle", "Chainmail / belt / keys / buckle clicks x1.7 - webbing and kit.", 4, -24)
def _(v):
    x = [L("rpg-sound-pack", "chainmail1"), L("50-rpg", "beltHandle1"), L("100-cc0-metal", "keys_03"), L("50-rpg", "clothBelt")][v]
    return foley(x, 1.7, 300)


VO = dict(contact=["war_target_engaged", "war_look_out"], orders=["war_go_go_go", "war_cover_me", "war_suppressing_fire", "war_get_down", "war_hold", "war_fire_in_the_hole"],
          ammo=["war_reloading", "war_call_for_backup", "war_cover_me"])


@recipe("vo_contact", "Soldiers", "Callout: contact", "\"Target engaged!\" / \"Look out!\" (Kenney voiceover, CC0) pitch x1.42, tempo x1.14.", 2, -15)
def _(v): return voice(kv(VO["contact"][v]))


@recipe("vo_orders", "Soldiers", "Orders", "\"Go go go!\", \"Cover me!\", \"Suppressing fire!\", \"Get down!\", \"Hold!\", \"Fire in the hole!\".", 6, -15)
def _(v): return voice(kv(VO["orders"][v]))


@recipe("vo_ammo", "Soldiers", "Asking for ammo", "\"Reloading!\" / \"Call for backup!\" - NOTE: no CC0 recording of the word \"Ammo!\" found yet.", 3, -15)
def _(v): return voice(kv(VO["ammo"][v]))


@recipe("vo_kill", "Soldiers", "Celebrating kills", "\"Target destroyed!\", \"Gotcha!\", cheer, \"Oh alright!\".", 4, -15)
def _(v):
    x = [kv("war_target_destroyed"), L("gotcha", ""), L("cheers", ""), L("oh-alright", "")][v]
    return voice(x)


@recipe("vo_panic", "Soldiers", "Panic", "\"Please help somebody!\", \"Come on, let's run!\", \"No no no...\", yells (nocturnalvanguard / arcadeparty).", 5, -15)
def _(v):
    x = [L("please-help", ""), L("come-on-lets-run", ""), L("what-no-no", ""), L("zombie-skeleton", "humanYell2"), L("zombie-skeleton", "humanYell4")][v]
    return D.cut(voice(x), 2.2, 0.3)


@recipe("vo_hurt", "Soldiers", "Hurt", "Pain grunts (qubodup strain/hurt) pitch x1.42.", 4, -16)
def _(v): return voice(L("15-vocal", f"slightscream-{[1, 4, 8, 12][v]:02d}"))


@recipe("vo_death", "Soldiers", "Death", "Death cries (arcadeparty humanDeath, grunts of male death).", 3, -16)
def _(v):
    x = [L("zombie-skeleton", "humanDeath1"), L("zombie-skeleton", "humanDeath2"), ev("grunts-male", "", 3)][v]
    return voice(x)


@recipe("radio_chirp", "Soldiers", "Radio chirp", "Radio squelch + static burst, band-limited 300 Hz-3 kHz.", 3, -20)
def _(v):
    x = L("war-on-water", f"radiomsg{v + 1}")
    s = L("static", "", 3 + v * 4, 0.25)
    y = D.mix([(D.cut(D.autotrim(x), 1.1, 0.15), 0, 0), (D.fadeout(D.fadein(s, 0.01), 0.1), 0, -12)])
    y = foley(y, 1.25, 300) if MINI else y
    return D.lp(D.hp(y, 300), 3200) if MINI else y


# SUPPLY --------------------------------------------------------------------------------------
@recipe("plane_flyover", "Supply", "Plane flyover", "Prop-plane pass tape x1.35 (toy-like RC buzz) with pan sweep, low layer -12 dB keeps it big.", 2, -16)
def _(v):
    x = L("war-on-water", ["airplane1", "paratroopersplane"][v])
    y = HP(T(x, 1.35), 100)
    if MINI:
        n = len(y); p = np.linspace(-1, 1, n); a = (p + 1) * np.pi / 4
        m = y.mean(1); y = np.stack([m * np.cos(a), m * np.sin(a)], 1).astype(np.float32) * 1.41
        y = D.mix([(y, 0, 0), (LOW(x, 110, -12)[:n], 0, 0)])
    return D.fadein(D.fadeout(y, 1.5), 1.0)


@recipe("chute_deploy", "Supply", "Parachute deploy", "Fabric snap: swish + heavy cloth x1.4.", 3, -18)
def _(v):
    return D.mix([(foley(L("swishes", f"swish-{[1, 5, 9][v]}."), 1.2, 150), 0, 0), (foley(L("rpg-sound-pack", "cloth-heavy"), 1.4), 0.08, -1)])


@recipe("chute_flutter", "Supply", "Parachute flutter (loop)", "Cloth rustle looped with a 9 Hz flap tremolo.", 1, -26, "int")
def _(v):
    parts = [foley(L("202-more", f"Cloth_0{i}"), 1.3) for i in range(1, 8)]
    y = D.stretch_loop(np.concatenate(parts), 5.0)
    return D.loopify(D.tremolo(y, 9, 0.5) if MINI else y, 0.4)


@recipe("crate_thud", "Supply", "Crate landing", "Wooden crate thud x1.3 + small low layer (-8 dB).", 3, -15)
def _(v):
    x = [L("thwack", "thwack-03"), L("tree-chop", ""), L("100-cc0-metal", "wood_slam_02")][v]
    x = D.autotrim(x)
    return D.mix([(CUT(foley(x, 1.3), 0.7), 0, 0), (D.fadeout(LOW(x, 120, -8)[:int(0.6 * SR)].copy(), 0.3), 0, 0),
                  (foley(ev("different-steps", "gravel", v), 1.6, 300), 0.03, -10)])


@recipe("container_land", "Supply", "Container heavy landing", "Steel slam x1.2 + metal debris + strong low layer (-3 dB): the one supply sound with real weight.", 2, -12)
def _(v):
    x = D.autotrim(L("100-cc0-metal", ["metal_slam_01", "metal_falling_02"][v]))
    thump = D.autotrim(L("muffled-distant", ""))
    return D.mix([(foley(x, 1.2, 80, 0.1), 0, 0), (LOW(thump, 100, -3)[:int(1.2 * SR)], 0, 0),
                  (CUT(foley(L("33-metal", "cast iron clangs - Marker #8."), 1.4), 0.5), 0.04, -6),
                  (debris(1.0, 8, 1.8), 0.1, -8)])


# ENGINEERING ---------------------------------------------------------------------------------
@recipe("sledgehammer", "Engineering", "Sledgehammer", "Metal hammering hits (bart workshop / rubberduck) x1.5.", 3, -18)
def _(v):
    x = [ev("68-workshop", "workshop - metal hammering.", 0), ev("100-cc0-metal", "hammer_02", 0), ev("68-workshop", "workshop - low hammering", 1)][v]
    return CUT(foley(x, 1.5), 0.6)


@recipe("shovel", "Engineering", "Shovel", "Shovel dig + gravel scoop x1.5.", 3, -19)
def _(v):
    return D.mix([(foley(L("shovel-sound", ""), 1.4 * jit()), 0, 0), (foley(ev("different-steps", "gravel", v + 2), 1.6), 0.05, -5)])


@recipe("cutting_torch", "Engineering", "Cutting torch (loop)", "Gas jet x1.4 + continuous spark crackle.", 1, -20, "int")
def _(v):
    g = gas(4.0, 1.4)
    s = D.stretch_loop(amb(L("electricity-sound", "continuousspark"), 1.2, 400), 4.0)
    return D.loopify(D.mix([(g, 0, -2), (s, 0, -6)]), 0.4)


@recipe("pry_bar", "Engineering", "Pry bar", "Metal scrape / drag (workshop) x1.5.", 3, -19)
def _(v):
    x = [L("68-workshop", "workshop - scrape1"), L("68-workshop", "workshop - dragging metal"), L("68-workshop", "workshop - scrape3")][v]
    return CUT(foley(x, 1.5), 1.2, 0.3)


@recipe("sandbag_place", "Engineering", "Sandbag drop", "Heavy sack thump + sand shuffle.", 3, -19)
def _(v):
    return D.mix([(foley(L("50-rpg", "dropLeather"), 1.3 * jit()), 0, 0), (foley(L("rpg-sound-pack", "cloth-heavy"), 1.4), 0.02, -4),
                  (foley(L("fantozzi", ["Fantozzi-SandL1", "Fantozzi-SandR2", "Fantozzi-SandL3"][v]), 1.5), 0.05, -4)])


@recipe("gabion_place", "Engineering", "Gabion wall: place", "Wire mesh clatter + gravel pour.", 2, -19)
def _(v):
    return D.mix([(foley(L("68-workshop", ["workshop - metal clatter", "workshop - tool clatter"][v]), 1.5), 0, 0),
                  (steps(GRAV, 6, 0.07, 1.8), 0.1, -4)])


@recipe("gabion_done", "Engineering", "Gabion wall: complete", "Final clank + settling gravel + a satisfied tap.", 1, -18)
def _(v):
    return D.mix([(foley(L("68-workshop", "workshop - metal drop"), 1.4), 0, 0), (steps(GRAV, 4, 0.09, 1.8), 0.1, -6),
                  (foley(ev("100-cc0-metal", "hammer_01", 0), 1.6), 0.5, -3)])


@recipe("car_dismantle", "Engineering", "Car dismantling", "Ratchet + metal drops + short drill.", 3, -19)
def _(v):
    r = foley(L("68-workshop", ["workshop - ratchet1", "workshop - ratchet2", "workshop - ratchet1"][v]), 1.5)
    d = CUT(foley(L("68-workshop", ["workshop - drill short 1", "workshop - drill short 2", "workshop - drill1"][v]), 1.5), 0.8)
    m = foley(L("68-workshop", ["workshop - metal drop 2", "workshop - metal drop 3", "workshop - metal drop"][v]), 1.4)
    return D.mix([(r, 0, 0), (d, 0.6, -3), (m, 1.3, -2)])


@recipe("fuel_siphon", "Engineering", "Fuel siphon (loop)", "Trickling liquid + glugging bubbles x1.3.", 1, -24, "int")
def _(v):
    a = amb(D.stretch_loop(L("40-cc0-water", "loop_water_02"), 5.0 * 1.3), 1.3, 200)
    b = amb(D.stretch_loop(L("40-cc0-water", "loop_bubbles_02"), 5.0 * 1.3), 1.3, 200)
    return D.loopify(D.mix([(a, 0, -2), (b, 0, -6)], 5.0), 0.5)


@recipe("jerrycan_slosh", "Engineering", "Jerrycan slosh", "Bottle shake recordings x1.2 - a little fuel can.", 3, -20)
def _(v):
    return foley(L("liquid-bottle", f"bottle-shake-0{[2, 5, 8][v]}"), 1.2, 150)


# STRUCTURES ----------------------------------------------------------------------------------
@recipe("tower_climb", "Structures", "Tower climb", "Ladder creaks + wood steps x1.6.", 2, -20)
def _(v):
    parts = []
    for i in range(5):
        parts.append((CUT(foley(ev("different-steps", ["wood01", "wood02", "wood03"][i % 3], i), 1.6, 250), 0.25), i * 0.3, -2))
        if i % 2 == v: parts.append((CUT(foley(L("100-cc0-metal", ["wood_squeak_01", "wood_squeak_02"][i % 2]), 1.5, 250), 0.5), i * 0.3 + 0.05, -6))
    return D.mix(parts)


@recipe("tower_creak", "Structures", "Tower creaking under attack", "Tree creak + wood squeak x1.4 - strained timber.", 3, -20)
def _(v):
    x = [L("tree-creaking", ""), L("100-cc0-metal", "wood_squeak_02"), L("100-cc0-metal", "wood_cracking_03")][v]
    return CUT(foley(x, 1.4, 120, 0.09), 2.0, 0.4)


@recipe("tower_collapse", "Structures", "Tower collapse", "Breaking + cracking + falling timbers x1.4, low layer -6 dB.", 2, -13)
def _(v):
    b = D.autotrim(L("100-cc0-metal", ["wood_breaking_01", "wood_breaking_02"][v]))
    parts = [(foley(b, 1.4, 100, 0.1), 0, 0), (D.fadeout(LOW(b, 120, -6)[:int(1.5 * SR)].copy(), 0.6), 0, 0)]
    for i, n in enumerate(["wood_falling_01", "wood_falling_03", "wood_falling_05", "wood_falling_06"]):
        parts.append((foley(L("100-cc0-metal", n), 1.5), 0.25 + i * 0.22, -4 - i))
    parts.append((foley(L("35-wooden", "crack05"), 1.5), 0.05, -3))
    return D.mix(parts)


GEN = ("generator-loop", "loop_generator_1")


def gen_run(dur, k=1.35):
    x = L(*GEN)
    y = HP(T(x, k), 120)
    return D.stretch_loop(y, dur)


@recipe("gen_start", "Structures", "Generator start", "Engine crank (car engine start) x1.4 into the generator loop.", 2, -17)
def _(v):
    c = foley(L("car-engine-start", ""), 1.4, 120)
    return D.mix([(c, 0, 0), (D.fadeout(D.fadein(gen_run(2.0), 0.3), 0.8), len(c) / SR - 0.3, -2)])


@recipe("gen_run", "Structures", "Generator run (loop)", "Small petrol generator x1.35 - buzzy little engine.", 1, -22, "int")
def _(v): return D.loopify(gen_run(6.0), 0.3)


@recipe("gen_stop", "Structures", "Generator stop", "Run + machine shutting down x1.35.", 1, -18)
def _(v):
    return D.mix([(D.fadeout(gen_run(1.0), 0.6), 0, 0), (foley(L("machine-shutting-down", ""), 1.35, 120), 0.2, -2)])


@recipe("gen_out_of_fuel", "Structures", "Generator out of fuel", "Engine coughs and sputters (gated run), then dies.", 2, -18)
def _(v):
    y = gen_run(2.4)
    t = np.arange(len(y)) / SR
    gate = np.ones(len(y))
    for c in ([0.6, 1.1, 1.4, 1.75, 2.0] if v == 0 else [0.5, 0.8, 1.3, 1.6, 2.1]):
        gate *= 1 - 0.95 * np.exp(-((t - c) / 0.07) ** 2)
    y = D.fadeout(y * gate[:, None] * np.linspace(1, 0.5, len(y))[:, None], 0.4)
    return D.mix([(y.astype(np.float32), 0, 0), (foley(L("machine-shutting-down", ""), 1.5, 120), 2.1, -6)])


@recipe("floodlight_hum", "Structures", "Floodlight hum (loop)", "Electric buzz looped, x1.1, with a faint 50 Hz-ish body.", 1, -30, "int")
def _(v):
    x = D.stretch_loop(L("electric-buzz", ""), 4.0)
    return D.loopify(HP(T(x, 1.1), 90), 0.3)


# ENVIRONMENT ---------------------------------------------------------------------------------
@recipe("amb_day", "Environment", "Day city (loop)", "Wind x1.2 + birds x1.4 + far tiny car alarm + distant tiny scream - a quiet street.", 1, -26, "int")
def _(v):
    D.seed(77)
    dur = 20.0
    w = D.stretch_loop(amb(L("wind", "Wind."), 1.2, 150), dur)
    b = amb(L("park-ambiences", "park_ambience_birds", 60, dur * 1.4 + 1), 1.4, 400)[:int(dur * SR)]
    alarm = D.stretch_loop(foley(L("car-signal", ""), 1.5, 400), 3.0)
    alarm = D.fadein(D.fadeout(LPm(alarm, 3500), 0.8), 0.3)
    scream = LPm(voice(L("female-scream-1", "")), 3000)
    return D.loopify(D.mix([(w, 0, -2), (b, 0, -6), (alarm, 6.0, -20), (ROOM(scream, 0.15, 0.4), 13.5, -22)], dur), 1.0)


@recipe("amb_night", "Environment", "Night (loop)", "Crickets x1.3 + low wind + distant tiny howl and groan.", 1, -27, "int")
def _(v):
    D.seed(78)
    dur = 20.0
    c = D.stretch_loop(amb(L("crickets-ambient", ""), 1.3, 800), dur)
    c2 = D.stretch_loop(amb(L("birdcricket", "cricket2"), 1.2, 800), dur)
    w = LPm(D.stretch_loop(amb(L("wind", "Wind2"), 1.1, 100), dur), 1500)
    howl = LPm(zvoice(L("wolf-monster", ""), 1.3), 2500)
    groan = LPm(zvoice(L("zombies-sound-pack", ZOMB[22]), 1.3), 2000)
    return D.loopify(D.mix([(c, 0, -2), (c2, 0, -10), (w, 0, -6), (ROOM(howl, 0.2, 0.4), 5.0, -16), (ROOM(groan, 0.2, 0.4), 14.0, -16)], dur), 1.0)


@recipe("car_alarm", "Environment", "Miniature car alarm", "Car signal / siren x1.5 - a toy-sized alarm.", 2, -20)
def _(v):
    x = L("car-signal", "") if v == 0 else L("sirens-and-alarm", "", 2, 3)
    return D.fadeout(foley(D.stretch_loop(x, 2.5) if v == 0 else x, 1.5, 400), 0.3)


@recipe("distant_scream", "Environment", "Distant tiny scream", "Screams pitched x1.42, lowpassed, roomy - far off in the city.", 3, -24)
def _(v):
    x = [L("female-scream-1", ""), L("war-on-water", "scream1"), L("war-on-water", "scream3")][v]
    return ROOM(LPm(voice(x), 3000), 0.15, 0.45)


@recipe("gas_hiss", "Environment", "Toxic gas hiss (loop)", "Steam hiss x1.3, filtered.", 1, -26, "int")
def _(v):
    x = np.concatenate([D.autotrim(L("steam-release", f"steam hisses - Marker #{i}.")) for i in (1, 2, 4)])
    return D.loopify(D.stretch_loop(amb(x, 1.3, 400), 5.0), 0.5)


@recipe("gas_bubble", "Environment", "Toxic bubbling (loop)", "Gastric bubbling + bubble loop x1.3 - rot gas from corpses.", 1, -26, "int")
def _(v):
    a = amb(L("gastric-distress", "", 0, 8), 1.3, 150)
    b = amb(D.stretch_loop(L("40-cc0-water", "loop_bubbles_1"), 6.5), 1.3, 150)
    return D.loopify(D.mix([(a, 0, 0), (b, 0, -6)], 5.0), 0.5)


# UI (not miniaturised) -----------------------------------------------------------------------
def ui(x): return D.autotrim(x, -50)


@recipe("ui_tab", "UI", "Tab click", "Kenney interface click (UI is not miniaturised).", 3, -20)
def _(v): return ui(L("interface-sounds", f"click_00{v + 1}"))


@recipe("ui_hover", "UI", "Hover", "Soft rollover tick.", 3, -28)
def _(v): return ui(L("51-ui", f"rollover{v + 2}"))


@recipe("ui_purchase", "UI", "Purchase", "Confirmation chime.", 2, -18)
def _(v): return ui(L("interface-sounds", f"confirmation_00{v + 1}"))


@recipe("ui_refused", "UI", "Refused", "Error buzz.", 2, -18)
def _(v): return ui(L("interface-sounds", f"error_00{[4, 6][v]}"))


@recipe("alert_attack", "UI", "Alert: under attack", "Short alarm blip.", 1, -16)
def _(v): return D.cut(ui(L("sirens-and-alarm", "", 0, 1.2)), 1.0, 0.2)


@recipe("alert_breach", "UI", "Alert: breach", "Glitchy double warning.", 1, -16)
def _(v):
    x = ui(L("interface-sounds", "glitch_003"))
    return D.mix([(x, 0, 0), (x, 0.22, 0)])


@recipe("alert_ammo", "UI", "Alert: out of ammo", "Question blip + empty click.", 1, -18)
def _(v):
    return D.mix([(ui(L("interface-sounds", "question_002")), 0, 0), (ui(L("war-on-water", "gunempty")), 0.25, -4)])


@recipe("alert_casualty", "UI", "Alert: casualty", "Low bong.", 1, -18)
def _(v): return ui(L("interface-sounds", "bong_001"))


@recipe("sting_daynight", "UI", "Day / night sting", "Short percussive jingle (Kenney jingles).", 2, -16)
def _(v): return ui(L("85-short-music", ["jingles_HIT00", "jingles_HIT05"][v]))
