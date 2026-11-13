# VIEWMODEL status (first-person hands + tool models, M3)

Owner files: src/actors/fp/**, src/models/tools/**, dev/fp.html, dev/fp.ts, one registration line in src/game/visuals.ts.

## Done (session 1)
- src/models/tools: common.ts (conventions, handFrame, gripAnchor, layDown), axe.ts, flashlight.ts, flaregun.ts,
  rifle.ts, radio.ts (registered 'axe' 'flashlight' 'flaregun' 'rifle' 'radio'), extras.ts (matchbox, match, ration,
  thermos, bandage, cartridge, round, case, cell; NOT registered), index.ts (TOOL_MODELS, toolModel, gripMatrix,
  toolItem = FIGURES item-space drop-in, constants re-exported).
- src/actors/fp: material.ts (FP_U, fpClip, createFpMaterial({glow}), createFlameMaterial), arms.ts (buildArms:
  one SkinnedMesh, 14 bones, quilted sleeves + mitts; ArmRig two-bone IK + swing/twist split; recolorArms),
  anim.ts (FpAnimator: all tools and acts, springs, hp() hand-pose helper, POSES table), scope.ts (overlay 'scope'
  order 150 + fov zoom + sim aim), pickups.ts (tool pickups drawn with registered models; markers muted for them),
  index.ts (createViewmodelSystem -> GfxSystem 'viewmodel').
- src/game/visuals.ts: one line after SNOW's (dynamic import, try/catch like the others).
- dev/fp.html + dev/fp.ts bench (single view, &orbit=1 debug side view, &sheet=tools|acts|1, &cells=tool:act:at,...).
- Verified: project tsc 0 errors; bench on WebGPU and WebGL2; real game scenario (scratchpad vm.mjs: every tool,
  crank, swing, reload, scope + shot, bolt, flare fire + reload, night beam, eat, third person, pickups) PASS with a
  clean console on WebGPU, --backend webgl and --mobile 1; tools/scenarios/hunt.mjs PASS, console clean.
- Cost: 2-5 draws; arms 9.0k tris (4.8k on mobile/low), tools 1.3-3.4k.

## Remaining / ideas (none blocking)
1. Hip bolt cycle and flare reload still bring a big gauntlet close to the eye for a moment.
2. GAME: hud.crosshair is 'aim' while the rifle is raised, so the UI's small cross shows inside the scope.
3. GAME makes the camera third person when downed, so the crawling hands only show during the blend.
4. FIGURES: src/actors/items.ts getItem(tool, lod) can return toolItem(tool, lod) (same item space and point names).

## Decisions / API facts (keep in sync with the code)
- FP meshes live in the MAIN scene as children of engine.camera, castShadow false, receiveShadow true,
  frustumCulled false. positionView is the true camera-space position (lighting, shadows, fog, FX pool lights
  exact). Only the clip position is replaced (material.vertexNode): xy scaled by FP_U.fovK =
  tan(fovMain/2)/tan(vmFov/2) (VM_FOV 62), NDC depth from the main projection of a COMPRESSED distance
  near*1.05 + z*0.16. Reversed / standard depth and both backends, because it reuses cameraProjectionMatrix.
- FP material adds albedo * (U.skyAmbient * FP_U.ambient (0.45) + FP_U.fill) as emissive: near things read a bit
  brighter than the snow exposure makes them; the fill is the beam's bounce. Mitt albedo is charcoal (0x3b3e43),
  lighter than FIGURES' (near black reads as a hole against snow).
- World-space things that must line up with the viewmodel (beam origin, match light) use the APPARENT position:
  camera-space (x*fovK, y*fovK, z) -> camera.matrixWorld.
- Tool MODEL SPACE: forward -Z, up +Y, right +X, origin = main fist (radio: box centre). HAND FRAME: origin = fist
  centre (handle axis), +Y wrist -> knuckles, -Z thumb side, X = Y x Z = FIGURES' item space. Grip anchors carry
  `q`. 'item' anchors (rifle, flare gun) put the barrel along +Y for FIGURES. Poses in anim.ts are P6
  [x,y,z,pitch,yaw,roll] (YXZ) of the tool origin in camera space; hp(side, x,y,z, fingers, palm) for hands.
- getModel(tool) = lying on the ground (pickup); getModel(tool, 0, { pose: 'hand' }) = model space with named parts.
- actors.localBeam is set false every frame (the viewmodel lights its own beam: FX pool spot priority 6, match
  point priority 5). Own SpotLight only if FX is absent at construction.
- Scope: anim.out.scope (aim 0.8..0.97) -> Scope.apply() narrows engine.camera.fov (x4.5) after GAME placed it and
  turns it to look + rifleSway(me, env, env.t*30) minus GAME's wander/shiver; viewmodel hidden from 0.55.
- Act clock: local, pulled to me.actT (snap if |d| > 0.15 s); dt = render-clock delta (up to 1 s, ?still=1).
  'eat' item from the inventory decrease. Rifle reload close inferred from me.loaded = 5 or ammo 0.
- Bench events go straight to the animator unless &fx=1.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/actors/fp|src/models/tools|dev/fp"
- node tools/shot.mjs "dev/fp.html?sheet=tools&light=day&t=3" --out vm_sheet_tools --w 2000 --h 1250 [--backend webgl + &webgl=1]
- node tools/shot.mjs "dev/fp.html?sheet=acts&light=dusk&t=3" --out vm_sheet_acts --w 2000 --h 1250
- node tools/shot.mjs "dev/fp.html?sheet=x&cells=axe:swing:0.27,radio:crank:0.5&light=day&t=3" --out vm_cells
- node tools/shot.mjs "dev/fp.html?tool=flaregun&act=reload&at=0.6&orbit=1&az=100&el=20&dist=0.9&light=day&t=2" --out vm_orbit
- node tools/shot-models.mjs --m axe,flashlight,flaregun,rifle,radio --seed 0 --light day --views "20,35;200,30" --out vm_tools
- Real game: node tools/play.mjs <scenario> [--backend webgl | --mobile 1]; the scenario used (kept in the session
  scratchpad) gives the tools with CS.give, CS.equip each, CS.input({b}) for PRIMARY 8 / SECONDARY 16, CS.act
  reload / toggleLight / consume, CS.game.thirdDev, and reads engine.get('viewmodel').stats.

## Final report

**Files.** src/models/tools/{common, axe, flashlight, flaregun, rifle, radio, extras, index}.ts; src/actors/fp/{index,
material, arms, anim, scope, pickups}.ts; dev/fp.html, dev/fp.ts; one line in src/game/visuals.ts (after SNOW's).

**Tools.** The five tools are built with the KIT Builder and registered. `getModel(tool)` is the tool lying on the
ground; the system draws tool pickups with it, and the markers stop drawing them. `getModel(tool, 0, { pose: 'hand' })`
is the hand pose, with moving parts and grip-frame anchors.

**First person.** `createViewmodelSystem(engine, world)` registers as 'viewmodel'. It draws one skinned mesh for the
parka sleeves and mitts, plus the tool, in the main pass as a child of the camera. The material swaps only the clip
position (own 62° FOV, depth compressed in front of walls), so the same light, shadows, fog and FX lights fall on it.
Animation is procedural from view.me and view.rig: every act in the brief, with the axe landing on SWING_HIT.
- Flashlight beam: FX pool (priority 6); FIGURES' `localBeam` is set false.
- Rifle scope: a post overlay 'scope' (order 150), FOV zoom, and drift from `rifleSway`.
- Hidden in third person.
- API: `anim`, `enabled`, `fov`, `stats`, `snap()`, and the dev-only `root` and `debugFree`.

**Contracts.** No changes.

**For FIGURES.** In src/actors/items.ts, `getItem(tool, lod)` can return `toolItem(tool, lod)` from src/models/tools.
It uses the same item space and point names.

**Checked.** tsc reports 0 errors. Bench runs on WebGPU and WebGL2. The real-game scenario passes on WebGPU, WebGL2
and `--mobile 1`, and hunt.mjs passes; the console is clean on all four. A frame costs 2 to 5 draws, with 9k
triangles of arms (4.8k on mobile/low).

**Unsure / open.**
- The gauntlet comes close to the eye for a moment in the hip bolt cycle and the flare reload.
- The UI's 'aim' cross shows inside the scope; that is GAME's `hud.crosshair`.
- Crawl hands barely show, because GAME's camera goes third person when downed.
- Mitts are charcoal, lighter than FIGURES' near-black, so they read against snow.
