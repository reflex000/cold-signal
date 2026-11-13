# SNOW — status / handoff

Owner files: src/gfx/snow/** ; may edit src/gfx/terrain/**, weather/**, sky/**, forest/** for look fixes;
one registration line in src/game/visuals.ts. Appended uniforms to src/gfx/shared.ts (allowed: append only).

## Design (decided, being built)
- Persistent CPU store of stamp RECORDS (stamps.ts): boot / paw / body / capsule (drag, crawl, log) / kick /
  melt, each with its depth, rim, and the fill clock F at stamp time. Spatial hash (8 m cells), ring capacity.
- GPU painter (painter.ts): ONE RGBA8 render target, a 2:1 atlas [near | far] (one sampled texture in the
  terrain shader: the terrain is near the 16-texture limit). near = high-res window around the camera
  (snowDeform texels over 20..32 m), far = low-res window (<=1024 texels over 256..384 m). Mobile: near only.
  Stamps = instanced quads, clip-space vertexNode, procedural SDF shapes, MAX blending (union).
  Window re-centres snap to whole texels; a re-centred half is re-rendered from records (clear quad + one
  instanced draw); new stamps between re-renders are drawn incrementally (no clear). One render pass per frame
  at most, usually none.
- Encoding (near): R floor depth 0..1 (x DEPTH_MAX m, dilated past the edge), G edge SDF (0.5 = edge, >0.5
  inside, +-SDF_RANGE m), B raised snow (rims, berms, kicked clumps; x RIM_MAX m), A freshness (compacted look).
  Far: R area-weighted depth, G presence (dilated), B 0, A freshness.
- Fill-in for free: records store F at stamp time; F integrates d(env.snowAccum) + wind drift. At re-render
  each record is drawn with its remaining depth/rim/freshness and softened walls; between re-renders the terrain
  shader subtracts U.trailFill (per-channel decrement since that half's last re-render). Re-render when the
  decrement grows past a threshold (seconds in a storm, never in calm).
- Terrain (sample.ts helpers called from terrain/material.ts): crisp walls from the SDF (width = max(1.2 cm,
  pixel)), analytic gradient, rims, compacted darker/smoother/bluer floor, deep holes bluer, shadow march toward
  the key light inside prints (desktop tiers), low-passed vertex dents (4 taps), far trails as soft grooves.
- U.trailOn: 0 off, 1 legacy (R only, as the TERRAIN bench painter writes), 2 = SNOW encoding.

## Done
- src/gfx/snow/{config,records,tracks,painter,sample,index}.ts: complete, type-checks, runs in the game
  (registered in src/game/visuals.ts, last line of addVisualSystems). Console clean on WebGPU.
- Terrain material uses it: crisp SDF walls, analytic gradient, rims, compacted floor, blue deep holes,
  print shadow march in TerrainLighting.direct (desktop), PARALLAX (12-step march + 4 halvings, desktop),
  low-passed vertex dents (varying vTrailDent feeds the parallax). Debug views terrain.debug = 7 / 8.
- shared.ts: appended trailFar / trailAtlas / trailTexel / trailFill; trailTex + horizonTex made
  NON-MERGEABLE (three merges texture uniforms by uuid at compile time; both started as `blank`).
- dev/snow.html bench (scripted View); tools/scenarios/snow.mjs (beats walk,dusk,deep,down,log,wolves,fill).
- post.ts (ENGINE, at the lead's request): GTAO faded where the depth jumps > 4-15 % within 2 px: removed the
  hard black dashes along snow crests seen against trees (shots/snow_dusk_trail.jpg).

- Fill tuned (DEPTH_FILL_RATE 0.85, wind drift 0.8e-5 (v-6)^1.5): 3 min of storm 0.85 = ~0.17 m of fill,
  boot prints become soft dimples. Landing punch capped. Groove noise in world space (drags join cleanly).
- Records bug fixed (cell key overflowed the Int32 cellOf: stale entries after the ring wrapped).
  src/gfx/snow/snow.test.ts: 5 vitest tests (fill arithmetic, query / pressAt, ring, boots, body).
- WebGL2 (--backend webgl) and --mobile 1: scenario passes, console clean, prints render (mobile: no parallax).
- Perf (live, 1920x1080 medium, prints filling the view): trail sampling +0.3 ms; re-rendering both windows
  every frame within noise (~0.1 ms). Budget 0.5 ms met.
- LOOK FIXES:
  * Blizzard (weather/snow.ts, index.ts, volume.ts + post.ts HdrStageInput.alpha): flakes lit by FX's
    PARTICLE_LIGHTS with a glint (orange by a fire, white in the torch beam, capped), brighter than the haze in
    storms (SNOWU.bright), gust sheets (bands 24 m apart sweeping downwind), a close layer of big streaks,
    turbulence scaled with the wind. ROOT CAUSE of "fog in stills": flakes write no depth, so the storm volume
    laid the whole storm behind each flake over it. Now flakes blend alpha to 1 - coverage and the volume
    composite spares covered pixels (one optional getter `alpha` on HdrStageInput in post.ts).
  * Olive rock: sky/common.ts fogColor eases the green of warm (low-sun) haze toward gold; post.ts shadowTint
    blue-magenta instead of teal; rock albedo (0.03, 0.025, 0.02). Backlit dusk rock now warm grey-brown.
  * Trees from above: forest/common.ts snowCoverage threshold floor (~0.32) and effectiveSnow 0.36 + 0.62 cover;
    impostor.ts thins snow with distance (V.m.z): stands read grey with dark needles, not white cones.
  * Cliff above the cave: the trail mask (2D) projected up the wall and suppressed rock there; now only on
    walkable slopes (terrain/material.ts trailKeep). Sheer faces hold snow only on ledges.
  * Horizon band: not present in the game shots (it was GTAO on grazing ground; faded).

- Shot sets: shots/snow_*_gpu.jpg, snow_*_gl.jpg (WebGL2), snow_*_mob.jpg (--mobile 1); bench wolves
  shots/snow_bench_wolves.jpg; aerial forest shots/f_aerial_game4.jpg; cave shots/cave_after.jpg.
- npm check clean (whole project); vitest 227/227.

## Remaining (nice to have)
1. Wolf toes only resolve at high/ultra texel sizes; medium shows oval holes.
2. WebGPU storm: the volume still veils mid-distance flakes more than the WebGL2 path does.
3. Trails are not saved with the game (records are presentation state).
4. FIGURES could sink a downed body / dropped items with snow.pressAt(x, z).

## Decisions / API facts
- RT clip mapping (three r187, both backends, from QuadMesh): sampling uv (u, v) <-> clip (2u-1, 1-2v).
- MaxEquation blending works on WebGPU (factors One/One) and WebGL2 (gl.MAX); CustomBlending applies without
  transparent = true.
- Step events carry the body position: the foot is offset +-0.1 m sideways from the travel direction (taken
  from the previous step of the same id, else the entity velocity / yaw). forward(yaw) = (-sin yaw, -cos yaw).
- Downed figure (actors/player_anim.ts lying()): face down, head toward the facing, pelvis 0.36 m behind the
  entity position, legs further behind.
- Dragged log: only one carrier -> the far end drags (a carries -> end b at x - sin(yaw) * len/2).
- env.snowAccum grows snowfall * (0.0004 + 0.0004 storm) m/s (sim/systems/env.ts): ~5 cm/min in a whiteout.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/(snow|terrain|shared|post)|dev/snow"
- node tools/play.mjs tools/scenarios/snow.mjs [--query "beats=walk,dusk"] [--backend webgl] [--mobile 1]
- node tools/shot.mjs "dev/snow.html?frames=44&t=3&at=fresh|deep|packed&light=day|dusk&el=88&az=180&dist=9&what=walk,log" --out x
- In a page: CS.engine.get('snow').debug.{painter,store,tracks}; CS.engine.get('terrain').debug = 7 (red pressed,
  green compacted, blue raised) or 8 (raw near texels).
- Pitfalls: the scenario's walk must avoid the packed route trail (masks A) or prints are 2 cm deep.

## Final report

**Done.** The snow deformation system works in the game on WebGPU, WebGL2 and `--mobile 1`. Consoles are clean, the type-check passes and vitest is 227/227 (5 new tests).

**Files.**
- New: `src/gfx/snow/{config,records,tracks,painter,sample,index}.ts`, `snow.test.ts`, the bench `dev/snow.{html,ts}` and the scenario `tools/scenarios/snow.mjs`.
- Edited: `terrain/material.ts` and `index.ts`, `weather/{snow,index,volume}.ts`, `sky/common.ts`, `forest/{common,impostor}.ts`, `shared.ts`, and one line in `game/visuals.ts`.
- Outside my list: `post.ts` (ENGINE).

**API.** `createSnowSystem(engine, world): SnowSystem` (GfxSystem `'snow'`). It provides `pressAt(x, z)` (metres pressed, for sinking bodies or items), `fill` (m), `stats` and `clear()`. It reads the bus `'sim'` events plus the players, wolves and logs in View.

**How it works.**
- Persistent records hold boots (sized by snow depth, a furrow in deep snow, a scuff when running), wolf paws by gait, log drags, crawls, body hollows, landings, axe and bullet hits, and flares.
- A single RGBA8 atlas holds a near window and a far window. Windows snap to whole texels. They are re-rendered from the records when they move, and new stamps are drawn on top in between. Stamps are procedural SDF shapes with MAX blending.
- Fill-in is free: records carry the fill clock (`snowAccum` plus wind drift), and the shader subtracts `U.trailFill`.
- The terrain gets crisp walls, rims, a compacted blue floor, shadows inside the prints and parallax on desktop.
- Cost at medium: about 0.3 ms.

**Contract additions.**
- `shared.ts`: `trailFar`, `trailAtlas`, `trailTexel`, `trailFill`. `trailOn = 2` means SNOW's encoding.
- `trailTex` and `horizonTex` are now non-mergeable. Three merged them by uuid, so the terrain was reading the horizon atlas.
- `HdrStageInput.alpha` (optional).

**Look fixes.**
- Blizzard: flakes wrote no depth, so the storm volume buried them. They now write coverage into alpha, and the volume spares covered pixels. Flakes are lit by fires and the flashlight, there are gust sheets and a close layer of streaks.
- Olive rock: warm haze is shifted toward gold, the grade's teal shadow tint is now blue, and the albedo is warmer.
- Trees from above: snow coverage is capped and thinned with distance on impostors.
- Cave cliff: the 2D trail mask had been projected up the wall.
- No dark horizon band shows in the game.
- At the lead's request, GTAO is faded at depth jumps (the black dashes along the crest).

**Open.** Wolf toes only resolve at high and ultra. The WebGPU storm is less dense than WebGL2. Trails are not saved.
