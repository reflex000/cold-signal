# LOOK (M1 final step: real systems in the game, cross-module fixes, look, perf) — handoff note

Brief: docs/briefs/LOOK.md (read COMMON.md first). Nobody else edits the project: any file may be edited,
keeping each module's design and the frozen contracts. List every file touched outside src/game in the report.

## State
- Session 1. Baseline: npm run check clean, vitest 153 green.
- FOUND: with ?real=all the terrain pipeline fails on BOTH backends: 17 sampled textures in the fragment stage
  (limit 16; WebGL2 MAX_TEXTURE_IMAGE_UNITS 16 too). A plain lit material already carries 6 scene textures
  (3 CSM depth maps, fog horizon LUT, env cube, IBL DFG LUT); terrain owns 11 (4 of them horizon maps).
  FIXED: horizon maps packed into ONE atlas (1536x512: slot s at x = 768 s, inner 512^2 + outer 256^2),
  exposed through U.horizonTex / U.horizonMap / U.horizonDir and horizonLit() in shared.ts. Terrain now 14.
  Count textures per material: scratchpad texcount.mjs (renderer.debug.getShaderAsync).
- DONE (step 1): DEFAULT_REAL = all four; structures = kit-built stand-ins ('standin:<model>') in KIT's props
  system with the prop material; first.mjs passes clean on WebGPU and WebGL2.
- DONE: 2a AO fade (post.ts: depth 35-75 m, fog transmittance^2), 2b U in render group + G mirrors removed
  (sky/common.ts, weather/volume.ts, sky/index.ts, weather/index.ts), 2c THREE_NOTES section 13,
  2d keyLightHorizon in ForestMaterial / ForestLambert / prop material (HorizonPhysicalLighting /
  HorizonPhongLighting in shared.ts), 2f gpuTimingWebGL option (engine.ts; game ?gpu=gl; bench ?gpu=gl).
- DONE: Lambert foliage/impostors had NO sky ambient in the game (r187 MeshLambertNodeMaterial ignores
  scene.environment): ForestLambert now adds the env irradiance (ForestEnvIrradiance in forest/common.ts).
  Shaded trees were black + fog-tinted navy; now dark green.
- DONE: 2e canopy shade on the forest floor beyond the tree shadows (terrain material trCanopy, applied to the
  key light + AO; tu.canopyFade from shadowDistance/treeNear), distant impostors darkened (V.m.z),
  U.snowCover now driven by the real weather (0.5 + 4 * env.snowAccum + 0.12 * snowfall; the stand-in did it,
  the real system never did: trees stayed at 0.8). 2g FU.perTree: without AA whole trees switch at a per-tree
  threshold (lodNoise in treemat.ts) instead of a per-pixel dither. 2h world/terrain.ts strata(): beds tilt
  and soften along the face (cave face untouched via the keep weight); terrain material: crisper broken
  snow/rock edges on cliffs, vertical joints, tone patches, facet relief (3 m over ~7 m slabs).
- DONE (look): tools now see the real light: Game.env() (CS.env) snaps the sky for 8 rendered frames (in
  ?still=1 runs systems only update on rendered frames, so env cube + exposure lagged far behind and every
  earlier look shot had a stale environment). Lake: mostly drifted snow, frosted ice (rough 0.3-0.5). Far
  forest: cooler/darker albedo, ragged edges. Stand-in flame: soft additive crossed cards. Clouds skipped where
  the storm hides the sky.
- OPEN (look): steep cliff faces near the cave still read smooth from afar and five soft white streaks run up
  the face right above the cave (not the COULOIRS list; likely the cave site's pad cutting the face);
  storm 0.5 by day reads as fog more than as a blizzard in stills (flakes faint); trees heavy with snow
  seen from above. Mountains in low sun go olive (orange sun + blue sky on near-black rock + the cold grade).
- GPU STATE OF THIS MACHINE (measured 2026-11-12): the Arc iGPU runs far below spec. Raw WebGPU probe
  (scratchpad fill.mjs / fill2.mjs, GPU timestamps): 3.0 ms per trivial 1080p full-screen pass; 20 full-screen
  draws in one pass 22 ms, in 20 passes 64 ms (~2 ms per extra pass, ~8 GB/s). ENGINE's own bench
  (dev/engine.html?q=medium&perf=1) measures 53-74 ms GPU today vs 5.5-6.7 ms in ENGINE.md. Our process holds
  the 3D engine ~95% busy; nothing else uses the GPU but the desktop app (~5-11%). The lead says no other agent
  runs, so these are the real costs on this machine today; they are reported raw below.
- Baseline perf (medium, 1920x1080 window = 1632x918): 7.5-8.4 fps, GPU ~100-148 ms, CPU stepFrame ~127 ms
  of which post.render 135 ms (blocked on the GPU), 102-180 draw calls, 1.0-1.7 M tris.

## Plan (priority order)
1. Real systems by default in visuals.ts (terrain, sky before weather, weather, forest, props); stand-in only as
   fallback on throw (console.warn). weather.whiteout -> hud.whiteout. Forest before engine.warmup().
   Blueprint shapes use the prop material.
2. Cross-module fixes a-h (see brief).
3. Look pass: tour + own views, 7 places x (dusk, noon, aurora night, moonlit night, storm 0.5, whiteout).
4. Perf on Arc iGPU at medium 1080p (perf.mjs --live 1): table below.
5. npm run check / npm test / npm run build; all scenarios pass.

## Files touched outside src/game
src/gfx/shared.ts, engine.ts, post.ts, quality.ts; src/gfx/terrain/horizon.ts, material.ts, config.ts, index.ts;
src/gfx/forest/common.ts, treemat.ts, impostor.ts, index.ts, cover.ts; src/gfx/sky/common.ts, index.ts, nodes.ts;
src/gfx/weather/index.ts, volume.ts, snow.ts; src/models/material.ts; src/world/terrain.ts; dev/bench.ts;
docs/THREE_NOTES.md (section 13); tools/scenarios/look.mjs (new look matrix), tools/scenarios/gpusplit.mjs (new GPU split profiler).
In src/game: visuals.ts, game.ts, params.ts, standin/structures.ts, standin/markers.ts.

## Decisions / facts
- shared.ts: every U uniform is renderGroup; U.horizonTex / horizonMap (x inner half extent, y slot-B weight,
  z valid, w domain half) / horizonDir; HORIZON_ATLAS layout; horizonAngle / horizonLit / keyLightHorizon;
  HorizonPhysicalLighting / HorizonPhongLighting (lighting models that put the ridge shadow on the key light).
- Engine option gpuTimingWebGL (default off): WebGL2 never requests timer queries unless asked (?gpu=gl).
- Stand-in structures register as 'standin:<model>' kit models (blueprint boxes, Builder, prop material);
  a real model registered under the plain name takes over without code changes.
- Tool runs: call CS.env() and step >= 2 frames before a shot; the sky snaps for 8 rendered frames.

## Test commands
- npm run check ; npm test ; npm run build
- node tools/play.mjs tools/scenarios/look.mjs [--query "lights=dusk,noon&views=wreck,aerial"] [--backend webgl] [--mobile 1]
- node tools/play.mjs tools/scenarios/tour.mjs   (add --backend webgl, --mobile 1)
- node tools/play.mjs tools/scenarios/perf.mjs --live 1 --q medium --w 1920 --h 1080
- GPU split per pass: node tools/play.mjs tools/scenarios/gpusplit.mjs --live 1 --q medium --w 1920 --h 1080 --query "at=wreck"

## Performance (Arc iGPU, this machine, 1920x1080 window, live loop, GPU = timestamp sum of render passes)
Method: tools/scenarios/gpusplit.mjs (live, ?gpu=1): per frame, the render calls before the longest pass
(shadow cascades), the scene pass, and the rest (post), median over 40-90 frames, one thing switched off
at a time. Run-to-run noise is about +-6 ms. At half resolution even the fixed-size shadow passes get
3.6x faster, i.e. this GPU clocks down under load (power/thermal limited), so cuts pay superlinearly.
Raw probe today: a trivial 1080p full-screen pass costs ~3 ms and each extra pass ~2 ms (8 GB/s);
ENGINE's own bench (dev/engine.html?q=medium&perf=1) measures 53-74 ms GPU today.

Found at the wreck, medium before the pass (1632x918): total ~112 = shadows 12 + scene 78 + post 26.
Scene: impostors ~26 (they sampled the 3 CSM cascades on every far pixel), snow particles ~20 (fog +
two phase functions per pixel of every streak), ground cover ~14 (1600 instances drawn, ~530 used),
terrain ~12, rocks ~11, sky ~10. Post: GTAO ~13, bloom ~12 (5 half-res levels), storm volume ~6.

Changes: impostors and far rocks no longer receive shadow maps (horizon term still shades them);
snow flake light + fog per vertex; cover draws only its packed active window; clouds skipped where
the storm hides the sky; medium = render scale 0.75, 2 cascades 1024 / 90 m, terrain [16, 0.5, 3.0],
tree density 0.7, cover 0.4, 4000 flakes, 8 fog / 8 cloud / 12 aurora steps, no GTAO, quarter-res
4-level glow; low = scale 0.65, 1 cascade / 50 m, terrain [16, 0.5, 2.6], trees 50 m / 0.55,
cover 0.25, 2500 flakes.

| preset (res)            | wreck | forest | lake | ridge | storm | GPU ms   |
| ----------------------- | ----- | ------ | ---- | ----- | ----- | -------- |
| medium before (1632x918)| 7.7   | 7.5    | 7.6  | 8.4   | 7.5   | 99-148   |
| medium now (1440x810)   | 10.7  | 9.9    | 11.5 | 11.8  | 10.6  | 65-73    |
| low now (1248x702)      | 15.9  | 14.8   | 15.1 | 15.7  | 14.2  | 50-60    |
| mobile (--mobile 1, WebGL2, 949x438) | 49.9 | 36.4 | 44.2 | 52.4 | 42.3 | (no timer) |
(fps; perf.mjs views; mobile frames on WebGL2 queue up: p50 2-3 ms with p95 stalls of 20-370 ms)
