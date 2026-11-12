# KIT — handoff note

Module: the model toolkit and the first models. Owner files: `src/models/kit.ts`, `registry.ts`,
`material.ts`, `instances.ts`, `src/models/props/**`, `dev/models.html`, `dev/models.ts`,
`tools/shot-models.mjs`. Also owes a section "Materials, vertex attributes and instancing" in
`docs/THREE_NOTES.md`.

## State (update after every step)

- [x] kit.ts, registry.ts, material.ts, instances.ts RUN clean on WebGPU and WebGL2 (session 3)
- [x] dev/models.html + dev/models.ts viewer runs on both backends; tools/shot-models.mjs works
- [x] kit additions (session 3): Builder.each, VertexRef.mat, Paint.pith, lathe `arc`, `pillow()`, `log()`
- [x] material (session 3): fissured bark with wear-driven peeling, growth rings for wood, AA'd thin
      lines (`line()` / `edge()` helpers), bump slope clamp, rust that follows the vertex albedo
- [x] all nine models written, registered, render on both backends: crate, barrel, luggage, campfire,
      stick_bundle, log_heavy, trail_marker, jerrycan, toolbox (+ props/index.ts imports them all)
- [x] docs/THREE_NOTES.md section 12 written
- [ ] polish pass: close-ups per model, day/dusk, snow 0/0.8, both backends; console clean
- [ ] final report (append under "## Final report")

## Decisions / facts a successor needs

- Viewer light: sun/sky/fog/exposure follow dev/bench.ts; the hemisphere `ground` is a snow bounce
  (day [2.0,1.88,1.8]) — without it faces turned from the sun read black. Stand-in fire lights are
  2.2 cd * size (dev only; the game's fire light is gfx/fx).
- CrateEnt has `open`: crate / toolbox / luggage (variants 0,1,3) carry a named part `lid` hinged on
  the back edge (axis +X, negative open angle). Duffel (luggage variant 2) has no lid.
- Campfire `opts.stage`: 0 laid, 1 burning, 2 embers, 3 dead. Barrel `opts.lit` (default true).
- Material ids are interpolated across triangles: per-vertex `mat` may only join neighbouring ids
  (BARK-WOOD, PAINT-METAL, CLOTH-PLASTIC). Charred wood is all MAT.CHAR painted bark-brown where unburnt.
- Wear as stored = wear * (0.4 + edge). Bark is lost above stored 0.35 (log() `peel` sets it).
- r187 instancing: `instancedMesh()` runs before `positionNode`; geometry has 6 attributes so instance
  matrix stays within 8 vertex buffers (three/src/nodes/accessors/Instance.js).

## Test commands

- `npx tsc --noEmit -p . 2>&1 | grep -E "src/models|dev/models"`
- `node tools/shot-models.mjs --m crate --seed 0-3 --light dusk --views "30,20;200,35" --snow 0.8 --out crate_dusk` (then Read shots/crate_dusk.jpg)
- add `--backend webgl` for the WebGL2 path; `--debug 1` anchors/emitters/parts; `--open 0.7` lids; `--zoom 2` closer; `--fire 0` no stand-in fire light
- model options: `--m "campfire:stage=2,barrel:lit=false"`
