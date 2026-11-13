# POLISH (M6) — handoff note

Owner scope: src/gfx, src/models, src/actors, src/game/visuals.ts and presentation files in src/game.
Not mine (RELEASE): src/sim tuning, src/ui text, docs (except this note), media.

## Status
- [x] 0. Read briefs, final reports, DESIGN section 2, LOOK status (method + perf table)
- [x] 1. Review shots (all seven places x light x weather, fire/night/wolf/tools/companions/ice/tower)
- [x] 2. Ranked fix list (below) worked top-down; 1-11 and 14 done, 12 partly (night lifted), 13 half
      (floating rock done; the tail's dark ring is the site pad's geometry in src/world: not mine)
- [x] 3. Performance: measured (table below); dynamic resolution / auto settle; load time measured
- [x] 4. Phones: --mobile 1, 390x844 portrait (rotate screen), 740x360 landscape
- [ ] 5. npm run check / npm test / npm run build clean; every scenario passes (in progress)
Review tools (scratchpad, not in the repo): review.mjs (plan-driven shots), phone.mjs, autoq.mjs, sheet.mjs.

## Ranked fix list (review in progress; worst "this looks real" damage first)
1. WHITEOUT / HEAVY STORM IS A GREY SCREEN. storm 1.0: nothing at all, not the ground at the feet, not the
   barrel fire at 20 m (look_*_whiteout, endgame_11/13/14: the climax is grey). Fog = 3.9/vis with vis 6 m,
   plus volume share, plus whiteout wash (50% to fog grey, 70% desaturate). Fix in gfx/weather: floor the
   rendered fog so the near field (feet .. ~8 m) stays, keep streaks/gust structure, lights glow through.
2. FOREST GETS ~NO AMBIENT: near trees black (2,2,4) even at noon; key light off -> trees fully black while
   snow/props stay lit. Foliage albedo ~0.03 x weak env irradiance x baked AO. Add the snow bounce from
   below and lift (forest/common.ts ForestEnvIrradiance, treemat.ts).
3. PICKUPS / CRATES / WOOD ARE COLOURED BOXES (standin/markers.ts): 418 pickups, luggage, crates, toolbox,
   medkit, woodpiles, notes, heavy logs, snags as 7 m poles. KIT has luggage, crate, toolbox, stick_bundle,
   log_heavy models; FIGURES items.ts has item geometry. Draw real models (instanced, prop material).
4. CLIFFS READ AS SMOOTH CONCRETE WALLS (cave, camp, tower, lake, cabin backdrops); cave face has crayon
   "scribble" joints; the cave mouth is a grey bunker box in front of a flat wall.
5. FIRE-LIT SNOW STREAKS look like a rain of brown sticks (survive_04/05): every streak on screen lit,
   thick, 0.6 m long; firelit snow reads as brown mud.
6. LAKE: crisp axis-aligned pale-blue rectangles on the ice (look_lake_noon), blurry dark blotches.
7. ICE HOLE: water is a flat light-grey plane, slabs are paper cut-outs (endgame_05).
8. FUSELAGE end-on reads as a perfect round tube / glass bubble from 20 m (known, STRUCTURES).
9. LENS SNOW draws dark grey discs (endgame_13): should be bright, soft melt drops.
10. Wolf coat tan/coyote in warm light (known, FIGURES): grey with darker saddle.
11. VIEWMODEL known items: mitt cuff near the eye (hip bolt, flare reload); aim cross inside the scope.
12. Night exposure crushed (moon/overcast forest ~ (10,12,25)); frost overlay at night = black ragged frame.
13. Tail section: dark ring/halo on the snow round it; floating flat rock at the cave cliff foot.
14. WebGPU storm less dense than WebGL2 (SNOW known item): make backends match.

## Done so far (in order)
- #1 whiteout: weather/index.ts VIS_FLOOR (drawn visibility sqrt(v^2+22^2); sim visibility untouched), gentler
  whiteout wash (0.4 desat, 0.22 to grey); volume.ts localAirlight(): fires/flares/torches glow in snowy air
  (closed-form point in-scatter + 6-step march for the top two spot slots; AIRLIGHT.on gate) on both paths.
- night: sky/index.ts exposure cap 3 -> 4.5; overcast snow/cloud interreflection (ovcT / (1 - 0.5 coverBlend)).
- torches: actors/fp/index.ts + actors/index.ts 45..85 cd -> 10..18 cd, penumbra 0.85-0.9 (was a clipped white
  ellipse); wolf eye shine gain x1000 (was 260) to keep the shine.
- #2 forest ambient: forest/common.ts ForestEnvIrradiance adds sunlit-snow bounce from below (SNOW_BOUNCE);
  treemat.ts foliage albedo x1.3. post.ts: film toe (+~0.6 stop at 1/400 white), black lift 0.0012 -> 0.0004.
  (Tried eGround 0.22 in sky: washed the blue out of snow shadows; reverted to 0.11.)
- #5 fire-lit flakes: weather/snow.ts glints 1.5 + lobe x1.5 (was 4.5 + x3), range window 0.6, per-flake
  sparkle (most dull, ~20% flash); close layer shutter 1/50; streak opacity floor 0.2.
- #9 lens: fx/overlays.ts flakes soft uneven blobs (no 5-lobe stars), drop rims 0.16 (were dark discs).
- breath: fx/breath.ts own puff op x0.38, lower; fx/particles.ts sun forward lobe 0.45 (a glowing orb at noon).
- #3 entity models: NEW src/models/props/pickups.ts (pickup_sticks/logs/tinder/ammo/medkit, note, part_*),
  NEW src/models/props/deadwood.ts (snag, deadfall, stump, branchpile), props/index.ts imports them;
  game/standin/markers.ts draws pickups/crates/wood/logs/notes with KIT models (InstancedMesh per model variant,
  hinged lids open when looted), extras (matchbox, cartridge, cell, ration, thermos, bandage) for small items.

- #4 cliffs: terrain/material.ts buttress/gully ribs (~40 m, 12 m relief) + vertical stains on cliff faces,
  far ledge snow on 19 m benches (near and far ring), straighter fainter joints (no crayon scribbles);
  forest/index.ts rocks bedded into steep slopes (floating outcrop at the cave); structures/cave.ts outer mass
  climbs into the cliff (no bunker).
- #6 lake: terrain/material.ts drift lanes scalloped by 23 m + 6 m noise (no straight-edged parallelograms).
- #7 ice hole: game/icevis.ts wind ripples on open water (normalNode), slabs 7-15 cm, greyer tops.
- #8 fuselage: models/wreck/fuselage.ts break crushed and peeled over the crown/belly (walls at body height
  unchanged for the colliders).
- #10 wolf coats neutral grey (actors/wolf_model.ts WOLF_COATS).
- #11 viewmodel: hudmodel.ts crosshair 'none' while the rifle is raised (one line, RELEASE's file, the brief's
  known item); actors/fp/anim.ts hip bolt cycle further out/lower, flare reload poses lower/right.
- sky/common.ts warm haze green -18% (+4% red): less olive rock at golden hour.
- #14 WebGL2 storm veils 0.55 -> 0.38 (weather/index.ts) so both backends read alike.
- interiors: game/interior.ts fill 9 x min(2.4, size/2) (cave and cabin were near black), no per-frame
  Color alloc; structures/cave.ts inner shell rock paler.
- (lead's notes) cabin.ts: top plates on the long walls + eave blocking boards + gable boards down over the
  top side log (no daylight band under the roof); heat shield dull sooty sheet (MAT.PAINT, soot gradient,
  screws) instead of bare metal (was a flat black hole); window glow cards one-sided facing out (glowed
  white from inside at night).
- crushed darks, second pass: the ACES fit scales the darks by ~0.36, which is why shaded crowns stayed near
  black at dusk whatever the light (measured: x10 sky ambient lit them; the math gives sRGB ~7 for a 4% albedo
  in overcast dusk). post.ts toe 0.35 -> 0.55 (+1.1 stops at 1/400 white, +12% at 1/6); night exposure cap
  4.5 -> 4.0 to keep nights dark. forest/common.ts: irradiance never below the sky's hemisphere light.
- fx/overlays.ts frost veil floor follows the adapted scene (uVeil): no black ragged frame at night.
- actors/player_model.ts snow exposure on hood 0.75 -> 0.35, parka 0.7 -> 0.5, pack 0.85 -> 0.55 (white caps).
- perf: markers merge closed lids into one draw (open crates draw body + lid), fold sticks/deadfall/logs
  to 2 variants and luggage to 3, no shadows from suitcases/toolboxes/first-aid cases: wreck view 282 -> 243
  draw calls.

## Performance (this machine; the GPU state swings a lot: one perf run stalled 45 min, the next ran 4x faster)
perf.mjs --live 1, 1920x1080 window, medium renders 1632x918 (fps / GPU ms / draw calls):
| view   | medium            | mobile (--mobile 1, WebGL2, 949x438) |
| wreck  | 48.4 / 18.2 / 243 | 108 / - / 135 |
| forest | 49.3 / 15.4 / 184 | 124 / - / 101 |
| lake   | 64.3 / 12.7 / 150 | 190 / - / 78  |
| ridge  | 77.0 / 10.3 / 114 | 149 / - / 73  |
| storm  | 56.0 / 13.1 / 141 | 223 / - / 71  |
- auto -> medium here; dynamic resolution reaches its floor (0.65) in ~5 s after a dip, probes up after a quiet
  spell and backs off; the tier did not thrash (frame times around the budget keep resetting the 3 s timer).
- load to first frame ~8.9 s; engine.warmup compile 2.1-2.3 s + first frame 0.26 s (engine.stats.warmCompileMs /
  warmFrameMs, new). Most of the compile is TSL code generation on the main thread. Cut not taken: the clean win is
  to start the black opening (RELEASE) while warmup runs, which is a boot-order change in game.ts (not mine).

## Phones
- phone.mjs (scratchpad): title -> New game by touch, stick walks (6.7 m), drag turns, pack opens/closes, pause and
  resume by touch, at 844x390 and 740x360: all pass; WebGL2 console clean; JS heap ~255 MB. Portrait 390x844 shows
  the UI's "Rotate your phone" screen (by design). Smallest text: compass degree labels 7.8 CSS px (UI's).
- mobile.mjs: 'button pri on screen' fails (the primary button's visibility at that instant; UI/flow, RELEASE).
- markers: dead wood draw range follows the tier (snags min(400, 5 x treeNear), wood min(200, 3 x treeNear)).

## Files touched
src/gfx/weather/index.ts, volume.ts, snow.ts; src/gfx/sky/index.ts; src/gfx/post.ts; src/gfx/forest/common.ts,
treemat.ts; src/gfx/fx/overlays.ts, breath.ts, particles.ts; src/actors/fp/index.ts, src/actors/index.ts;
src/models/props/pickups.ts (new), deadwood.ts (new), index.ts; src/game/standin/markers.ts.

## Test commands
- npm run check ; npm test ; npm run build
- node tools/shot.mjs "<page?query>" --out <name> [--w 1600 --h 900] [--backend webgl] [--mobile 1]
- scenarios: node tools/scenarios/<name>.mjs
