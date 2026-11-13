# POLISH (M6) — handoff note

Owner scope: src/gfx, src/models, src/actors, src/game/visuals.ts and presentation files in src/game.
Not mine (RELEASE): src/sim tuning, src/ui text, docs (except this note), media.

## Status
- [ ] 0. Read briefs, final reports, DESIGN section 2, LOOK status (method + perf table)
- [ ] 1. Review shots (all seven places x light x weather, fire/night/wolf/tools/companions/ice/tower)
- [ ] 2. Ranked fix list (below) and work it
- [ ] 3. Performance: auto quality + dynamic resolution settle; medium keeps look; mobile light; load time
- [ ] 4. Phones: --mobile 1, 390x844 portrait, 740x360 landscape
- [ ] 5. npm run check / npm test / npm run build clean; every scenario passes

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

## Files touched
src/gfx/weather/index.ts, volume.ts, snow.ts; src/gfx/sky/index.ts; src/gfx/post.ts; src/gfx/forest/common.ts,
treemat.ts; src/gfx/fx/overlays.ts, breath.ts, particles.ts; src/actors/fp/index.ts, src/actors/index.ts;
src/models/props/pickups.ts (new), deadwood.ts (new), index.ts; src/game/standin/markers.ts.

## Test commands
- npm run check ; npm test ; npm run build
- node tools/shot.mjs "<page?query>" --out <name> [--w 1600 --h 900] [--backend webgl] [--mobile 1]
- scenarios: node tools/scenarios/<name>.mjs
