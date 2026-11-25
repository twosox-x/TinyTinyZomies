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
   - Sampled on a 0.4 m grid and interpolated.
3. **Junction intervals.** Each road gets the stretches of its length where another road's carriageway reaches its curb lines, measured on the actual merged geometry. Markings stop there; crosswalks and stop lines sit square to the road just outside. Intervals caused only by alleys are minor: markings run through and no crosswalk is placed.
4. **Voxels.**
   - Every world-aligned column (default 10 cm) is classified as asphalt, gutter, paint, curb, sidewalk, median, plaza, park or plot, with a height (curb and sidewalk 15 cm, rounded to whole voxels).
   - The whole network is one height and material field, so there is no overlapping geometry, no z-fighting and no holes.
   - Diagonals and curves step finely and naturally on the fixed grid.
5. **Mesh.** Greedy rectangles for tops and merged runs for walls, about 0.9 M triangles for a 660 × 550 m district at 10 cm. Every quad is grown by 0.01 voxel in its own plane to close T-junction pinholes.
6. **Plots.**
   - Blocks are what lies behind the sidewalks.
   - Lots are cut along each street with random widths and depths per district. Corners join the lower-id street's lot. Interiors deeper than the lot depth stay open as courtyards.
   - Buildings are blockouts on a 0.5 m grid.

Run it locally (workers need http, not file://):

```bash
cd tools/city_lab && python3 -m http.server 8765
```
