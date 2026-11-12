# KIT — handoff note

Module: the model toolkit and the first models. Owner files: `src/models/kit.ts`, `registry.ts`,
`material.ts`, `instances.ts`, `src/models/props/**`, `dev/models.html`, `dev/models.ts`,
`tools/shot-models.mjs`. Also owes a section "Materials, vertex attributes and instancing" in
`docs/THREE_NOTES.md` (done: section 12).

## State (update after every step)

- [x] kit.ts, registry.ts, material.ts, instances.ts RUN clean on WebGPU and WebGL2 (session 3)
- [x] dev/models.ts rebuilt on dev/bench.ts `createBench()` (the real engine, post, ACES grade); several
      views are rendered in turn and copied into a 2D overlay; tools/shot-models.mjs works
- [x] kit additions (session 3): Builder.each, VertexRef.mat, Paint.pith, lathe `arc`, `pillow()`, `log()`,
      `stencil()` (stroke font: A-Z 0-9 - . / ^), bake: faces turned to the ground get no snow exposure
- [x] material (session 3): fissured bark with wear-driven peeling, growth rings round a near pith,
      granite speckle, alligatored char, AA'd thin lines (`line()` / `edge()`), bump slope clamp, rust
      that follows the vertex albedo, scratches only through bare metal, emissive = scene radiance
- [x] all nine models: crate, barrel, luggage, campfire, stick_bundle, log_heavy, trail_marker, jerrycan,
      toolbox (+ props/index.ts). Shot in day / dusk / night / storm, snow 0 and 0.8, both backends.
- [x] docs/THREE_NOTES.md section 12
- [x] final report (below)

## Decisions / facts a successor needs

- Viewer light = the bench's (ENGINE). The stand-in fire is the engine's test fire (14, 18 m) scaled
  by light (day 0.06, dusk 0.35, night 1) and emitter strength; it is dev-only (game: gfx/fx).
- CrateEnt `open`: crate / toolbox / luggage (variants 0,1,3) carry part `lid` hinged on the back edge
  (axis +X, negative open angle); setOpen(id, t). Duffel (luggage 2) has none.
- Campfire `opts.stage`: 0 laid, 1 burning, 2 embers, 3 dead. Barrel `opts.lit` (default true).
- Material ids interpolate across triangles: per-vertex `mat` only between neighbours
  (BARK-WOOD, PAINT-METAL, CLOTH-PLASTIC). Charred wood is all MAT.CHAR painted bark-brown where unburnt.
- Wear as stored = wear * (0.4 + edge). Bark is lost above stored 0.35 (log() `peel` sets it).
- Stencils sit 1.2 mm proud; the engine's reversed depth keeps them clean.

## Test commands

- `npx tsc --noEmit -p . 2>&1 | grep -E "src/models|dev/models"`
- `node tools/shot-models.mjs --m crate --seed 0-3 --light dusk --views "30,20;200,35" --snow 0.8 --out crate_dusk` (then Read shots/crate_dusk.jpg)
- `--backend webgl`, `--debug 1`, `--open 0.7`, `--zoom 2`, `--fire 0`, `--q "q=medium"`; options: `--m "campfire:stage=2,barrel:lit=false"`

## Final report

**Files.** src/models/kit.ts (Builder, PAL, MAT, Path), registry.ts, material.ts, instances.ts,
src/models/props/{crate, barrel, luggage, campfire, stick_bundle, log_heavy, trail_marker, jerrycan,
toolbox, index}.ts, dev/models.html + models.ts (viewer on createBench), tools/shot-models.mjs,
docs/THREE_NOTES.md section 12. No contract changes.

**API.** `register(name, (seed, opts) => ModelDef, meta)`, `getModel(name, seed?, opts?)`,
`listModels()`, `modelKey()`. `import './models/props'` registers the nine models.
`createPropsSystem({ scene, camera }, props: PropInst[], { opts?(inst, id), shadows? })` returns
the GfxSystem 'props': `emitters(type?)`, `emittersOf(id)`, `anchor(id, name, out?)`, `anchorYaw`,
`part(id, name)`, `setOpen(id, 0..1)`, `matrix(id)`, `near(x, z, r)`, `find(model)`,
`add/remove/move`, `lights()`. Materials: `getPropMaterial()`, `getGlassMaterial()`, `PROP_U.wet`.

**Emitters.** `props.emitters('fire')` returns world-space `{ prop, model, type, position, dir, size,
def }`. `def` carries model extras (`strength`). The list is cached until add/move/remove.

**Builder.** Primitives: box, plank, extrude, lathe (arc), cyl, cone, tube, sphere, capsule, dome,
pillow, rock, log, cloth, sweep, pipe, strap, cable, torus, mesh, stencil. Part ops: move/rot/aim/span,
bend, taper, twist, crumple, noise, dent, warp, paint, tint, shade, each, sway, clone, mirror, merge.
Builder ops: ink, group, part (pivot, hinge), anchor, emitter, light, build(). See the kit.ts header.

**Vertex layout.** position, normal, color u8 (sqrt albedo, AO), aDetail f32 (detail xyz, MAT id),
aSurf u8 (rough, metal, wear, emissive), aEnv u8 (snow exposure, sway length, snow push, stiffness).
Six attributes fit WebGPU's 8 vertex buffers.

**Open.**
- The bench hemisphere `ground` (0.9) leaves sun-averted faces near black over sunlit snow; about 2 matches snow albedo (ENGINE / sky).
- crate variant 3 and barrel are 5.4–5.8k triangles, a little over the 5k prop budget.
- The viewer's tiling relies on Chrome copying a WebGPU canvas inside the same task. It works on both backends.
