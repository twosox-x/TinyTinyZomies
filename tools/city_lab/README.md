# City Lab (phase 5A prototype)

Interactive Three.js prototype of the city layout and voxel road system. **Not part of the game** and not shipped; it exists to approve the urban foundation before final environment assets.

| File | Role |
|---|---|
| `city_core.js` | Everything that will be ported to C++. Pure JavaScript, no rendering library: street profiles, network generators, distance fields, voxel rasteriser, plots / buildings, greedy mesher, JSON export. Runs in Node too. |
| `city_arch.js` | Voxel-art buildings (phase 5B), renderer-free: each building is a standalone model on its own upright 25 cm grid, placed as a rigidly rotated mesh facing its street. |
| `city_worker.js` | Web Worker: runs the core for a share of the chunks. |
| `city_lab.html` | Three.js viewer and UI only. |

## How the road system works

1. **Network.** Roads are polylines with a profile (`PROFILES`: bands across the carriageway, sidewalk width, curb-return radius, median, centre line, crosswalks). The organic district grows from its arterials. Curves are Bezier curves sampled every 2–3 m.
2. **One field for the whole network.**
   - For every point: the signed distance to the carriageway, with roads combined by a smooth minimum whose radius is the curb-return radius.
   - The nearest road, with its lateral `u` and arc-length `s`.
   - The second-nearest road, and the sidewalk width blended at corners.
   - Sampled on a 0.5 m grid and interpolated.
3. **Junction intervals.** Each road gets the stretches of its length where another road's carriageway reaches its curb lines, measured on the actual merged geometry. Markings stop there; crosswalks and stop lines sit square to the road just outside. Intervals caused only by alleys are minor: markings run through and no crosswalk is placed.
4. **Voxels.**
   - Every world-aligned column (default 10 cm) is classified as asphalt, gutter, paint, curb, sidewalk, median, plaza, park or plot, with a height (curb and sidewalk 15 cm, rounded to whole voxels).
   - The whole network is one height and material field, so there is no overlapping geometry, no z-fighting and no holes.
   - Diagonals and curves step finely and naturally on the fixed grid.
5. **Mesh.** Greedy rectangles for tops and merged runs for walls, about 0.9 M triangles for a 660 × 550 m district at 10 cm. Every quad is grown by 0.03 voxel in its own plane to close T-junction pinholes.
6. **Acute corners.** The curb-return fillet grows with 1/sin(crossing angle), up to 2.6×. Sharp corners end in a rounded nose instead of a thin spike of sidewalk.
7. **Street furniture.** Voxel models at a fixed 5 cm (`PROP_TYPES`), built from boxes in code and meshed by a 3D greedy mesher. The rules, in `placeProps()`:
   - cobra-head lamps every 30–42 m, staggered; twin lamps in planted medians;
   - signal masts on the right-hand corner of every approach between two through streets, with heads over the inbound lanes;
   - stop signs with street-name blades on local-street approaches;
   - hydrants about every 85 m.

   Every spot is checked against the voxel classification. Signals run a 30 s cycle in the shader, with crossing roads alternating.
8. **Clean-up rules (from the visual review).** These are applied everywhere, not at single spots:
   - Curb, gutter and sidewalk widths use the field divided by its gradient (a true distance), so widths stay constant through the curb returns. Within 1 m of a curb the field is evaluated exactly, so edges don't wobble.
   - Enclosed areas under 60 m² that aren't road are filled with asphalt, plus a 1 m margin so no gutter ring is left. Connectivity is checked diagonally too, so sidewalk noses stay attached.
   - A crosswalk is drawn only where both ends land on a sidewalk. Otherwise it slides back up to 10 m, or is dropped.
   - The Grand / Division / Broadway crossing is laid out as three junctions around a triangular plaza, not as one six-way.
   - Open spaces (plazas, squares, lots) take whole blocks.
   - Junctions closer than 22 m merge into one, so no crosswalk or lane box is squeezed in between. Cross streets meet Broadway at least about 30 m from the avenue crossings.
   - Raised medians must run at least 16 m.
   - Markings and curb edges are at least 1.5 voxels wide, so diagonals stay connected.
   - Sidewalk joints are drawn only well inside one street's sidewalk.
9. **Plots.**
   - Frontage priority: the higher-ranked of the two nearest streets claims a cell inside its lot depth, and ties go to the lower id, so corner lots are rectangles. Alleys are ignored for frontage, so buildings back onto them.
   - Lots are cut square to the street.
   - Each plot is opened by 1 m to remove spikes and slivers, and plots under 60 m² are dropped.
   - Buildings of 9+ storeys become a podium with a tower set back 3 m. Plots are opened by 3 m (no part thinner than 6 m), height is capped on narrow plots, and gaps between buildings are 0 or 4–6 m.
   - Voxel blockouts on a 0.5 m grid aligned with each building's frontage street: facades are flat voxel walls, and other sides step in 0.5 m blocks. Corners are square to the streets, and towers are square blocks.


Run it locally (workers need http, not file://):

```bash
cd tools/city_lab && python3 -m http.server 8765
```

## Buildings (phase 5B, `city_arch.js`)

- **Lots → rectangles.** Plots are split into connected pieces (one per side of the street). Each piece is cut into clean rectangles, using the largest rectangle that fronts the street, repeated. A building is never carved: it's built upright and rotated whole.
- **Zones by density,** from the edge inward:
  - suburban houses: lap siding, shutters, gable shingle roof, chimney, porch;
  - DC / Brooklyn rowhouse terraces: brick or painted, projecting bays, sills and lintels, bracketed cornice, stoops, water tanks;
  - mid-rise: limestone or brick, rusticated base or storefronts with awnings, pilasters, cornice, penthouse, rooftop units;
  - towers within about 160 m of the core: Art Deco with three setback tiers, piers, a crown and a spire, or glass curtain wall on a limestone podium.
- **Construction.** Facades are relief maps (depth per 25 cm cell) meshed by the street mesher. Roofs are height maps. Small parts (porches, stoops, tanks, spires) are voxel boxes. Windows have lit variants that glow at night.

### Phase 5B, second pass

- **No coplanar faces.**
  - A facade relief's boundary faces that reach inside the building are pulled out to the wall plane, so roofs, podiums and corners no longer flicker.
  - Attached neighbours (found from the shared occupancy map after all footprints are placed) get plain party walls and no corner returns, so cornices never overlap.
  - Stoop and porch overlaps removed.
- **Planned suburbs.**
  - Houses at a fixed lot pitch on both sides of every local residential street, with a common setback, facing the street and following curves.
  - Pie lots around cul-de-sac bulbs.
  - Driveways, attached garages and front walks.
- **Density.** Dense districts use deep back-to-back lots, buildings fill the lot depth with a rear building where needed, and there are no side gaps downtown.
- **Pocket plazas.** Small blocks and wedge slivers along the avenues become paved squares with food carts, newsstands, café tables, benches and trees (also in Union Square and Six Corners).
- **Modern towers.**
  - Twisting floor plates (each storey a rigidly rotated slab).
  - Stacked cantilevered glass volumes.
  - Slanted voxel-stepped crowns with fins.
  - Glass on a limestone podium with a lantern.
