# FIGURES status (handoff note)

Module: FIGURES (milestone M3). Owner files: src/actors/** (not src/actors/fp/**), dev/actors.html, dev/actors.ts,
one registration line in src/game/visuals.ts.

## Done (session 1)
- src/actors/rig.ts      SkelDef (bind joints + tails), Pose (world quats + joint positions + uniform scale), fk/attach,
                         Hinge (IK bone frames), solveTwoBone, qYXZ/qXYZ/qAxis/qLook, writeRow (3x4 skin matrices).
- src/actors/gpu.ts      BoneTexture (RGBA32F, 100 texels/row: 32 bones x 3 + data texel 96 = eye shine), skinPosition
                         (2-bone LBS from textureLoad, row = instanceIndex + per-object uniform csRow), figure material
                         (KIT createPropMaterial + skin vertex stage), eye material (retro-reflective shine from data texel).
- src/actors/bind.ts     chain tags in Part.st, paint class in Part.sl, bindGeometry -> aSkin + per-vertex classes, recolor.
- src/actors/shape.ts    loft (rings -> smooth KIT part; fixed winding, closed loops, caps), noise helpers.
- src/actors/player_model.ts  22-bone skeleton (A-pose), parka figure LOD 0/1/2 (~21k/6k/2k tris), slotGeometry (parka colour).
- src/actors/player_anim.ts   PlayerAnimator: gait w/ planted feet + predicted landings, rest stepping, crouch, deep-snow
                         wading, jump/land, lean, look (pitch/yaw), breath, shiver, tools (rifle low/aim/recoil/bolt/reload,
                         axe carry/swing, flashlight, flare gun aim/fire/reload, radio hold/crank), acts (use, ignite, eat,
                         climbOut), revive (kneel), log carry, swim, downed (prone, crawl), dead; bone-by-bone blend.
- src/actors/items.ts    axe, flashlight, flaregun, rifle, radio (KIT, item space: fist origin, handle -Z, knuckles +Y);
                         ITEM_HAND, ITEM_POINTS, gripBind, itemGeometry (rigid on the hand, drawn in the player's row).
- src/actors/wolf_model.ts  32-bone wolf (spine, neck, head+jaw, ears, 4 tail, scapulas, 3-segment hind legs), furred lofts,
                         lip skin, teeth, 4 coats (grey, dark, pale, brown) from per-vertex part class, eyes mesh.
- src/actors/wolf_anim.ts   WolfAnimator: walk/trot/rotary gallop footfalls, 3-segment leg IK, body pitch from ground,
                         moods (stalk, circle, feint, charge, bite lunge, drag, flee, cower, feed), head look at target,
                         jaw/ears/tail spring, events (yelp flinch, growl snarl, bark, bite snap), lying/sitting(howl)/dead.
- src/actors/index.ts    createActorsSystem(engine, world): buckets per (kind, colour, LOD), rows per frame, items, FX
                         light pool flashlight (own SpotLight fallback), eye shine from fx.lights.active, mutes GAME markers
                         for player/wolf (wraps markers.update with a filtered view), point(id, name), forceLod, bindPose.
- dev/actors.html/.ts    bench: ?anim= ?show= ?slot= ?sheet=player|wolf|1 ?phases= ?lod= ?bind=1 (+ bench params).

## Remaining (priority order)
1. Polish pass from close-ups: player hood ruff (reads as a tyre), boots too long/flat, goggles; wolf head/muzzle too thin,
   ears small, haunch blend, paws; howl sit too upright; gallop tail too high (carriage values); strafe step too wide.
2. Bus events -> wolf animators (yelp/growl/bark/bite) in index.ts (bus.on('sim')).
3. visuals.ts registration line (re-read the file first; put it after FX's line if present).
4. Shots: WebGPU / WebGL2 (--backend webgl) / --mobile 1; real game via tools/play.mjs (bots, CS.act debug wolves).
5. Perf check (draw calls / rows), LOD distances, fog (KIT material has fog = true).

## Decisions / API facts
- GPU skinning from ONE shared RGBA32F bone texture (textureLoad as three's BatchNode), plain THREE.Mesh with `count`
  instances (r187 RenderObject draws object.count instances; no instance matrix). Rows consecutive per mesh.
- Bone matrices are WORLD space (root folded in), meshes at the origin, frustumCulled = false, matrixAutoUpdate off.
- positionPrevious is assigned the skinned position (TAA velocity would read the bind pose at the origin otherwise).
- Figures face -Z in model space, right = +X. Root rotation = rotY(yaw). Positive local X rotation lowers a bone that
  points back-down (wolf tail) and raises one that points forward (neck/head).
- Parka cloth painted with REF grey + class 1; slotGeometry rescales those vertices to PARKA_COLORS[slot].
- KIT AO bake happens in bind pose; ground AO darkens the boots/paws.
- Tools in hand: one mesh per figure+tool (created on demand), drawn with csRow = the player's row.
- Light: FX pool via engine.get('fx').lights.acquire('spot', 6 local / 2 remote); own SpotLight only when FX absent at
  construction (fixed light count -> no recompiles).

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/actors|dev/actors"
- node tools/shot.mjs "dev/actors.html?light=day&sheet=player&phases=0.5,1.3" --out act_sheet_p --w 2000 --h 1250
- node tools/shot.mjs "dev/actors.html?light=day&sheet=wolf&phases=0.4,1.1" --out act_sheet_w --w 2000 --h 1000
- node tools/shot.mjs "dev/actors.html?light=dusk&anim=walk&az=120&el=8&dist=3" --out act_walk   (single anim, orbit)
- add --backend webgl or --mobile 1; ?bind=1 shows bind pose; ?lod=2 forces LOD
- Probe geometry in node: scratchpad inspect.mjs (Vite ssrLoadModule) - see session notes.
