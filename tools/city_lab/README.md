# City Lab (phase 5A prototype)

Interactive Three.js prototype of the city layout and voxel road system. **Not part of the game** and not shipped; it exists to approve the urban foundation before final environment assets.

| File | Role |
|---|---|
| `city_core.js` | Everything that will be ported to C++. Pure JavaScript, no rendering library: street profiles, network generators, distance fields, voxel rasteriser, plots / buildings, greedy mesher, JSON export. Runs in Node too. |
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
   - Enclosed areas under 45 m² that aren't road are filled with asphalt, so there are no curb islands inside junctions.
   - Open spaces (plazas, squares, lots) take whole blocks.
   - Junctions closer than 22 m merge into one, so no crosswalk or lane box is squeezed in between.
   - Raised medians must run at least 16 m.
   - Markings and curb edges are at least 1.5 voxels wide, so diagonals stay connected.
   - Sidewalk joints are drawn only well inside one street's sidewalk.
9. **Plots.**
   - Frontage priority: the higher-ranked of the two nearest streets claims a cell inside its lot depth, and ties go to the lower id, so corner lots are rectangles. Alleys are ignored for frontage, so buildings back onto them.
   - Lots are cut square to the street.
   - Each plot is opened by 1 m to remove spikes and slivers, and plots under 60 m² are dropped.
   - Buildings of 9+ storeys become a podium with a tower set back 3 m. Plots are opened by 3 m (no part thinner than 6 m), height is capped on narrow plots, and gaps between buildings are 0 or 4–6 m.
   - Footprints are traced on a grid aligned with the frontage street, simplified into straight edges and extruded as polygon blockouts. Walls along diagonal and curved streets are straight and evenly lit, and corners are square to the streets.


Run it locally (workers need http, not file://):

```bash
cd tools/city_lab && python3 -m http.server 8765
```
