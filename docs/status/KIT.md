# KIT — handoff note

Module: the model toolkit and the first models. Owner files: `src/models/kit.ts`, `registry.ts`,
`material.ts`, `instances.ts`, `src/models/props/**`, `dev/models.html`, `dev/models.ts`,
`tools/shot-models.mjs`. Also owes a section "Materials, vertex attributes and instancing" in
`docs/THREE_NOTES.md`.

## State (update after every step)

- [x] kit.ts (Builder, Part, Group, Path, PAL, MAT, build() with AO / sky exposure / snow push bake) — written, type-checks, NOT yet run
- [x] registry.ts — written, type-checks
- [x] material.ts — written; 2 type errors at line 90 (floor() result typing); NOT yet run
- [x] instances.ts — written, type-checks, NOT yet run
- [x] dev/models.html — written
- [ ] dev/models.ts — the viewer (in progress)
- [ ] tools/shot-models.mjs
- [ ] src/models/props/: crate, barrel, luggage, campfire, stick_bundle, log_heavy, trail_marker, jerrycan, toolbox (+ index.ts importing all)
- [ ] docs/THREE_NOTES.md section

## Order of work

1. viewer + shot tool + crate on screen on WebGPU and WebGL2 (`?webgl=1`); fix kit / material until clean
2. the other eight models
3. look: day and dusk, snow 0 and 0.8, both backends; judge harshly; iterate
4. THREE_NOTES section; final report

## Decisions / facts a successor needs

- Light units follow dev/bench.ts (ENGINE): DirectionalLight colour is premultiplied irradiance
  (day sun about [10.5, 8.9, 6.9]), exposure day 0.62 / dusk 1.5 / night 4.2 / storm 0.85, AgX.
  The viewer copies those presets so the look matches the engine; it does not import the engine.
- CrateEnt has `open`: crate / toolbox / suitcase models carry a named part `lid` with its hinge pivot.
- Campfire `opts.stage`: 0 laid (unlit), 1 burning, 2 embers (collapsed, glowing), 3 dead (cold char and ash).
- r187 instancing: `instancedMesh()` runs before `positionNode`; geometry must have at most 6
  attributes so instance matrix (+ previous matrix for motion vectors) stays within 8 vertex buffers
  and the shared (non object-specific) program path is used (three/src/nodes/accessors/Instance.js).

## Test commands

- `npx tsc --noEmit -p . 2>&1 | grep -E "src/models|dev/models"`
- `node tools/shot-models.mjs --m crate --seed 1-4 --light dusk --views "30,20;200,35" --snow 0.8 --out crate_dusk` (then Read shots/crate_dusk.jpg)
- add `--backend webgl` for the WebGL2 path
