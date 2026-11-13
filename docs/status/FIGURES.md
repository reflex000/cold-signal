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
- src/actors/player_model.ts  20-bone skeleton (A-pose), parka figure LOD 0/1/2 (22.9k/6.5k/3.2k tris; wolf 15.7k/3.7k/1.3k), slotGeometry (parka colour).
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

## Session 1, later steps (done)
- Polish: clumpy fur ruff + blunt edge clumps, wool wraps over the mouth (rime), shoulder caps sunk, thinner pockets,
  lofted boots, bulkier trousers, visible baffles + weathering; webbing straps clear of the parka; goggle strap removed.
- Wolf: broader skull/muzzle, bigger ears, haunch tucked, fur grain along the body (ink grain 'z'), light frost only,
  tail carriage sign fixed (positive = raise), calmer carriage, howl sit at ~45 deg with the muzzle ~60 deg up.
- Gait start fix (the foot furthest behind lifts first), planted feet clamped to 0.6 m reach, pelvis dips for reach,
  shorter strides (0.32 + 0.18 v).
- Bus events -> wolf animators (yelp flinch, growl snarl, bark, bite snap).
- visuals.ts line 97 (after FX's line): createActorsSystem via dynamic import, try/catch warning like FX's.
- Local first-person flashlight beam (api.localBeam, default on) through FX's pool (priority 6) or the own SpotLight.
- Real game: scratchpad/figures.mjs (bots Mara/Ivo with flashlight/rifle, wolves via CS.sim.ctx.spawn, third person via
  CS.game.thirdDev = true) PASSES with a clean console; markers muted (players/wolves) confirmed.

## Lead feedback round (done)
- Wolf rework: head/neck carried lower (bind moved), long narrow but deep muzzle, upright pointed ears, deep narrow
  chest with level back, long lean legs, big paws, hanging bushy tail; smooth fur volume (no spiky tufts = no creases),
  finer fur strands (FUR_FINE detailScale 2.6), smooth grizzle, saddle/cape contrast, light back frost.
- ROOT CAUSE of the "paper fan" (howl/rest/dead): joint planes were perpendicular to the child bone; a limb bent at
  bind (dog hind leg ~100 deg at the stifle) got its thigh's back bound to the shank. bind.ts planeWeights now uses the
  BISECTOR of the two bones (child direction only when they point opposite ways). Legs bind from the joint down
  (no blend into the body), their lofts start on the joint with a dome. Shared by player and wolf.
- Howl: pursed mouth (jaw parts only), ears visible, tail laid behind; tail tip droops instead of curling up.
- Player idle: weight on one leg (pelvis shift + roll, free foot forward with heel up, settles), switches every
  ~6-11 s; arms off the body with a slow drift; deeper breathing at rest. Trousers slim under the parka.
- Bench: ?sil=1 (black on white), ?side=1 (sheet side view), ?joints=1 (joint dots).
- Real game: eye shine confirmed in the local flashlight beam (green-gold dot), FX pool beam on the snow.

## Session 2 (done)
- WebGL2 + --mobile 1: bench and real game shot, skinning identical; scenario PASS with a clean console on both backends.
- Perf (bench ?show=crowd, medium): 4 players + 16 wolves = 15 actor draws (44 calls in all), 324k tris, 0.68 ms CPU.
  LOD: players 16 / 55 m, wolves 18 / 60 m (hysteresis), culled past 320 m, at most 40 rows.
- Frame skips: index.ts feeds the animators the render-clock time since their last update (f.time delta), not f.dt
  (?still=1 tool runs render only the last of CS.step(n) frames; hitches skip frames). The animators integrate at most
  0.1 s, carry the feet along with any jump bigger than that time explains, take the entity's own velocity and turn
  the body over the whole gap. Fixed the lunge in fig_02 (feet left 1.3 m behind). A frozen render clock (pause menu,
  photo mode) freezes the figures. Pack spring sub-stepped.
- Deep snow: the boots sink into the drift with the body (legs straight) instead of standing on the surface with
  bent knees.
- Bench: ?t= now plays the scripts up to t first (a frozen clock is a frozen figure, like the contact sheet).
- Seen once: a pale wash over the local player's legs in third person (fig_05, near the wreck). Not reproduced at the
  same spot; the normal and silhouette renders there are crisp, so probably an air layer, not the figure.

## Remaining
- Nothing blocking. Ideas: fur shells for close wolves; foot IK against logs/rocks (only the ground is probed).

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
- node tools/shot.mjs "dev/actors.html?light=dusk&anim=walk&az=120&el=8&dist=3" --out act_walk   (single anim, orbit;
  add &t=1.5 for a fixed moment)
- Real game: node tools/play.mjs figures.mjs [--backend webgl]. The scenario was kept outside the repo (session
  scratchpad); it does: CS.go to open ground near poi('wreck'), host.addBot x2 + botAct equip flashlight/rifle,
  setBotInput to walk/sprint, CS.sim.ctx.spawn 5 wolves (moods stalk/circle/howl/rest/roam), CS.game.thirdDev = true,
  CS.env clock 22.5 + CS.act toggleLight, engine.get('actors').stats / debugFig(id) for checks.
- add --backend webgl or --mobile 1; ?bind=1 shows bind pose; ?lod=2 forces LOD
- Probe geometry in node: load a module through Vite's ssrLoadModule (createServer middlewareMode) and call it.

## Final report

**Files** (all new): src/actors/index.ts, rig.ts, gpu.ts, bind.ts, shape.ts, player_model.ts, player_anim.ts,
items.ts, wolf_model.ts, wolf_anim.ts; dev/actors.html, dev/actors.ts; one line in src/game/visuals.ts (line 97,
after FX's).

**Public API**: `createActorsSystem(engine, world): ActorsSystem`, name 'actors'. Beyond GfxSystem it has
`point(id, bone | 'muzzle' | 'lamp', out)`, `stats` {players, wolves, rows, draws}, `forceLod`, `bindPose`,
`localBeam` (first-person flashlight beam, on by default), `setSilhouette(on)` and `debugFig(id)`. For a future
first-person engineer, items.ts exports getItem, itemGeometry, ITEM_POINTS, ITEM_HAND and gripBind.

**How**: procedural animation (FK spine and head, two-bone IK limbs, planted feet with predicted landings, pose
blending). The poses go as 3x4 world matrices into ONE shared RGBA32F bone texture. Plain Meshes are drawn with
`count` instances, one draw per (kind, colour, LOD) bucket, and skinned in a TSL positionNode. I chose this over
SkinnedMesh because it gives one draw per bucket instead of one per figure, and the same path on WebGPU and WebGL2.
The material is KIT's createPropMaterial with only the position stage replaced.

**Light**: flashlights go through FX's light pool (priority 6 local, 2 remote); an own capped SpotLight is used
only if FX is absent. Wolf eye shine is read from fx.lights.active.

**Markers**: muted at run time for player/wolf by wrapping markers.update with a filtered view. GAME's file is
untouched.

**Contracts**: no changes.

**Checked**: bench and real game on WebGPU, WebGL2 and `--mobile 1`; scenario PASS, clean console. 4 players +
16 wolves (medium): 15 actor draws, 324k triangles, 0.68 ms CPU.

**Unfinished / unsure**:
- Fur is shading on a lofted volume only (no shells).
- Frame skips (hitches; CS.step(n) renders once) are absorbed by carrying the feet along. A frozen render clock
  freezes the figures.
- In deep snow the boots sink into the drift; this assumes the snow surface is drawn at the sim's ground height.
- The sim's 2.6 m/s walk is past the walk-run transition, so the gait blends into a light jog from 2.1 m/s.
- I saw a pale wash over the local legs in third person once (fig_05). It did not reproduce, and the silhouette
  there is intact, so I suspect an air layer.
