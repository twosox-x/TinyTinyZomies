# City Lab vehicle library (`CityCore.Vehicles`, city_core.js section 7b)

One renderer-free voxel library for every vehicle in the city. Models are `CityCore.VoxModel`s at the
street-furniture voxel (`CityCore.PV` = 5 cm), meshed with `CityCore.meshVoxels3D` (positions in metres).

## Frame

- **+x is the front** (nose), z is centred on the vehicle axis (**+z = right-hand side**), **y = 0 on the ground**.
- Lengths / widths reported in metres from the actual voxel bounds (mirrors included).

## API (stable)

```js
const V = CityCore.Vehicles;
V.KINDS            // ['sedan','hatchback','coupe','suv','pickup','minivan','taxi','police','ambulance','fire_engine',
                   //  'city_bus','school_bus','panel_van','delivery_van','box_truck','garbage_truck','fuel_tanker',
                   //  'tanker_cab','tanker_trailer','semi','semi_cab','semi_trailer','rolloff_truck','rolloff']
V.INFO[kind]       // { len, wid, h (nominal m), cls: 'car'|'van'|'truck'|'bus'|'trailer'|'prop' }
V.model(kind, opts) // -> { M: VoxModel, len, wid, h, x0, x1, z0, z1 (m, bounds around the model origin), kind, key }
V.mesh(kind, opts)  // -> same object plus .mesh (meshVoxels3D result: pos (m), mat, nrm, idx, quads), cached
V.emit(E, kind, opts, x, y, z, dir, scale, fit)
                   // places the mesh into any emitter with E.quad(p, q, r, s, mat, normal) (city_arch Emitter, yardkit S.E):
                   // (x, z) = centre of the footprint, y = ground, dir 0..3 = nose towards -z, +z, -x, +x,
                   // scale = emitter units per metre (4 for building voxels), fit = [maxLen, maxWid] m (optional,
                   // shrinks uniformly to fit). Bottom faces lying on y = 0 are skipped. Returns the quad count.
V.paints           // { car: [[mat, weight]...] US colour mix, fleet: [...] work-vehicle mix,
                   //   pick(seed) -> mat, pickFleet(seed) -> mat, liveries: { taxi, police, ambulance, fire_engine,
                   //   school_bus, city_bus, garbage_truck, fuel_tanker } (fictional operators) }
V.VM               // vehicle material ids (also CityCore.VM): palette 160..199 (registered in PROP_PALETTE)
```

`opts` (all optional):

| key | meaning |
|---|---|
| `paint` | body material id (e.g. `V.paints.pick(seed)`, `V.VM.RED`). Default: livery for liveried kinds, else drawn from `seed` (cars: US mix; work vans: fleet mix) |
| `seed` | integer variant: paint (when no `paint`), trim / options (roof rails, ladder rack, bands, sleeper cab...), damage pattern |
| `state` | `'ok'` (default), `'damaged'` (dents, scrapes, broken side window / headlight), `'crashed'` (crumpled front, buckled hood, shattered glass, dark engine bay), `'burnt'` (charred black / ash / rust, no glass), `'rolled'` (crashed then flipped onto its roof or side, resting on the ground; sometimes also burnt) |
| `doors` | `true`: car front doors swung open (adds ~0.6 m each side), van / ambulance / step-van rear doors open |
| `lights` | `true`: lit headlights (lamp lens material), lit tail lights, flashing light bars (police, ambulance, fire, school bus, garbage beacon) |
| `band`, `container` | panel-van livery band / roll-off container colour override |

Cached by key: identical `(kind, paint, seed, state, doors, lights, ...)` mesh once. **Do not mutate** the returned `M`.

Cost (triangles after meshing, seed 1, see `node dev/vehicles_stats.js`): cars ~550-900, vans ~550-1000,
trucks / buses ~800-1800, full tractor-trailers ~1800-2700. Damaged states cost more.

## Example (traffic instancing)

```js
const r = CityCore.Vehicles.mesh('city_bus', { seed: 3, lights: true });
// r.mesh is a quad mesh in metres, +x front: rotate by yaw = atan2(-dirZ, dirX) about y, translate to the lane.
```

Typical sizes (m): sedan 4.8 x 2.0, suv 4.9 x 2.1, pickup 5.8 x 2.1, panel_van 5.7 x 2.2, box_truck 7.6 x 2.5,
garbage_truck 9.5 x 2.5, fire_engine 10.4 x 2.7, school_bus 11.2 x 2.7, city_bus 12.1 x 2.8, semi 18.1 x 2.9,
fuel_tanker 17.1 x 2.8 (cab and trailer also separately: `semi_cab` / `semi_trailer`, `tanker_cab` / `tanker_trailer`;
a trailer's front (kingpin end) is at +x; place it 0.0 m behind the cab's x0 + 1.2 m overlap over the fifth wheel).
