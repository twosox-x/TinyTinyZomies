# Adding buildings and variations

Downtown and the high-rises were approved by the owner. The approved state is commit `1bc2d2e`; the regression check `dev/regress.js` protects it. Everything new is added as a **plug-in file**, so approved designs are never edited by accident.

| To add | Do this |
|---|---|
| A high-rise design | Copy `templates/tower_template.js` to `towers/<name>.js`, add it to `towers/manifest.js`. It joins the shuffled tower deck automatically. |
| A mid-rise design (3–14 storeys) | Copy `templates/mid_template.js`, register with `zones`, `minW`/`maxW` (frontage, m) and `minFloors`/`maxFloors`. The placer picks types whose range fits the lot and the requested height. |
| Rooftop equipment | Add a model and a rule in `towers/roofkit.js` (`CityArch.lib.roofKit`). Every mid-rise and row house calls it. |
| Street furniture | Add a `model…()` and an entry in `PROP_TYPES` in `city_core.js`, and a rule in `placeProps()`. Instanced, so it is cheap. |
| Service yards (dumpsters, loading) | `towers/servicekit.js` (`CityArch.lib.serviceKit`). |
| Variation inside a design | Draw from `R()` (seeded per lot): materials with `L.pick`, proportions, which top / crown. Two copies of a design should never look alike. |

## Toolkit

The toolkit is `CityArch.lib`; see `towers/AGENT_BRIEF.md` for the full API.

**Building blocks**
- `buildTiers` stacks tiers (rectangle, notched or mask), handling soffits and roofs automatically.
- Skins: `skinPodium`, `skinCurtain`, `skinFins`, `skinDeco`, `skinBronze`, `skinPomo`, `skinPrecast`, and others.
- Free-form facades: `Relief`.
- Parts: `VoxModel` + `E.vox`.

**Materials:** `L.BM` (stone, brick, metal, glass with lit variants, neon / LED / beacon).

**Geometry rules**
- No two different surfaces may lie in the same plane: build parts as one VoxModel, or offset them by 1 voxel.
- Nothing may be see-through.
- Party walls stay plain and flush.

## Workflow

Start a server first: `cd tools/city_lab && python3 -m http.server 8765`.

1. **Preview the design alone:**

   ```bash
   node dev/preview.js <name> out.png "w=30&d=30&floors=10&seed=7"
   ```

   Try several seeds, narrow and wide lots, and night.
2. **See it in the city:**

   ```bash
   node dev/spots.js '[["a",-200,60,"rts"]]'
   ```

   ```bash
   node dev/cam.js '[["a",tx,ty,tz,px,py,pz]]'
   ```
3. **Check the numbers:**

   ```bash
   node dev/build_stats.js 1
   ```

   Prints build time, triangles, and how often each design appears.
4. **Confirm the approved downtown is unchanged:**

   ```bash
   node dev/regress.js
   ```

   Adding a new design shuffles which design lands on which lot. Re-record the baseline with `--update` after the owner approves the new look.
