# VIEWMODEL status (first-person hands + tool models, M3)

Owner files: src/actors/fp/**, src/models/tools/**, dev/fp.html, dev/fp.ts, one registration line in src/game/visuals.ts.

## Done
- Read DESIGN, contracts, FIGURES/HUNT/SURVIVAL/FX/GAME/KIT notes (session 1).

## Remaining (priority order)
1. src/models/tools: axe, flashlight, flaregun, rifle, radio (+ fp extras) registered; index.ts helpers.
2. src/actors/fp: material.ts (FP vertex stage), arms.ts (SkinnedMesh sleeves + mitts), anim.ts, index.ts
   (system 'viewmodel'), scope.ts (post overlay + fov zoom), pickups.ts (tool pickups in the world).
3. dev/fp.html bench (?tool ?act ?light ?webgl=1 ?sheet=1), visuals.ts line.
4. Shots: bench contact sheet, real game (tools/play.mjs), fix look.

## Decisions / API facts (keep in sync with the code)
- FP meshes live in the MAIN scene as children of engine.camera (engine adds the camera to the scene),
  castShadow false, receiveShadow true, frustumCulled false. positionView is the true camera-space
  position (lighting, shadows, fog, FX pool lights all exact). Only the clip position is replaced
  (material.vertexNode): xy scaled by k = tan(fovMain/2)/tan(fovVm/2) (own FOV), NDC depth taken from
  the main projection of a COMPRESSED distance z' = near*1.05 + z*0.16 (everything within ~1.2 m lands in
  front of the nearest wall the 0.32 m player capsule allows). Works for reversed / standard depth and
  both backends because it reuses cameraProjectionMatrix.
- World-space things that must line up with the viewmodel (flashlight beam origin, match light) use the
  APPARENT position: camera-space (x*k, y*k, z).
- Tool MODEL SPACE (how tools are built): like the camera: forward -Z, up +Y, right +X, metres.
  HAND FRAME (grip): origin = fist centre (the handle axis), +Y wrist -> knuckles, -Z toward the thumb,
  X = Y x Z (right hand: palm side; left hand: back of the hand). = FIGURES' "item space".
- Registered models: getModel(tool) = lying on the ground (pickup); getModel(tool, 0, { pose: 'hand' }) =
  model space with named parts; anchors carry grip frames.
- FIGURES' actors draw the local beam only while actors.localBeam is true: the viewmodel sets it false
  and lights its own beam through FX's pool (priority 6).
- Scope: while the rifle is raised (aim > 0.8) the viewmodel zooms engine.camera.fov in its update
  (GAME resets it every frame), turns the camera to the sim's aim (camera - GAME wander - shiver +
  rifleSway) and draws a post overlay 'scope' (order 150) driven by a uniform.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/actors/fp|src/models/tools|dev/fp"
