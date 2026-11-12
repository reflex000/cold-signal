# ATMOS status (sky, light, weather)

## State
- Done, type-checks, vitest passes (src/gfx/sky/*.test.ts). Shot on WebGPU (medium), WebGL2 and
  --mobile 1: day strip 08:30-22:00, sunset, blue hour, moonlit night, aurora, partly cloudy,
  overcast, storm 0.5, storm 1.0 whiteout. Console clean on WebGPU; on WebGL2 clean with &gpu=0.
- Files: src/gfx/sky/{astro,atmosphere,common,textures,nodes,env,index,benchkit}.ts (+ astro.test.ts,
  atmosphere.test.ts), src/gfx/weather/{index,snow,volume,spindrift}.ts, dev/sky.{html,ts},
  dev/weather.{html,ts}.
- Pitfalls hit (all fixed, worth knowing): TSL assigns need Fn(); textureSample inside a per-pixel
  If needs .level(); shared U uniforms are object-group and go stale through scene.fogNode on
  materials without node properties -> common.ts G.* render-group mirrors (syncGlobals); inside a
  post quad, cameraPosition is the quad camera (use uniform(camera.matrixWorld)); an expression of
  a var used after var.assign() is emitted after the assign (materialise with toVar()); the env
  cube must be rendered once before any material samples it.

## Remaining (nice to have)
1. Temporal accumulation for the storm volume (now: static IGN jitter + depth-aware 4-tap upsample).
2. Soft depth fade of snow particles near surfaces (flakes are small; spindrift fades by distance).
3. Judge the storm structure and snow streaks in motion (stills only so far); TAA ('ultra') sky velocity untested.

## Decisions / API facts
- Sky on the CPU (atmosphere.ts): transmittance + multiple-scattering tables at load (~100 ms);
  sky-view tables per light (sun 32x48x20 ~7.5 ms, moon smaller) rebuilt a few rows per frame when
  the light moved. Phases applied per pixel. Same numbers feed ambient, fog colour, sun colour.
  'mobile' uses smaller tables instead of an analytic sky (no GPU LUT passes on any tier).
- Dome = own mesh at the far plane (depth test, no depth write, renderOrder 1e6): only visible sky
  is shaded; post isSky still works.
- Ambient = scene.environment: own prefiltered cube, 64 per face (32 on mobile) (GGX taps unrolled as
  constants), refreshed over 3 frames when the sky changes; HemisphereLight if no half-float targets.
- One shadow-casting key light (CSMShadowNode): sun by day, moon at night. Units follow ENGINE's
  bench (noon sun ~[10,9,7]); exposure fully adapts in daylight, partly toward night (cap 3.0).
- Fog density 3.9/visibility (clear air x0.085 so ridges stay readable); volume carries 78% of it
  with structure on WebGPU medium+, the scene fog the rest.

## Issues found in other modules
- ENGINE post.ts GTAO: far ground at grazing angles (~150 m-2 km) turns near black at dusk, night and
  in storms (AO only fades on bright pixels). Repro: dev/sky.html?clock=16.75&el=2&ty=6&dist=10 vs
  &noao=1. Fix idea: also fade AO by view depth (1 - smoothstep(40, 120, viewDepth)).
- ENGINE shared.ts: U uniforms are object-group; materials without node properties read stale values
  through scene.fogNode. Suggest .setGroup(renderGroup) on them (I mirror what I need).
- WebGL2 + gpuTiming + 3 CSM cascades: three warns "beginQuery: a query is already active" (bench
  only; the game runs without gpuTiming). Use &gpu=0 on WebGL benches.

## Test commands
- npx vitest run src/gfx/sky   (ATMOS_VERBOSE=1 ... --silent=false prints numbers)
- node tools/shot.mjs "dev/sky.html?clock=16.75&ui=0&t=3" --out sky_sunset
  (&strip=1 eight times; &aurora=1&clock=22&az=0; &cloud=1; &noao=1 hides the GTAO band)
- node tools/shot.mjs "dev/weather.html?storm=0.5&ui=0&t=7" --out wx_storm  (storm=1 whiteout,
  &voldebug=1 volume transmittance, add --backend webgl with &gpu=0, or --mobile 1)
- The GPU is shared: tools/shot.mjs may time out at its 30 s screenshot limit; retry or use a copy
  with longer timeouts.

## Final report

**Files:** src/gfx/sky/{astro, atmosphere, common, textures, nodes, env, index, benchkit}.ts plus two vitest files; src/gfx/weather/{index, snow, volume, spindrift}.ts; dev/sky.{html,ts}, dev/weather.{html,ts}. Type-checks, tests pass. Shot on WebGPU, WebGL2 and --mobile 1. Console is clean (WebGL2 needs &gpu=0, see below).

**API**
- `createSkySystem(engine, world?) → SkySystem`, name 'sky', with `key` (the DirectionalLight), `exposureBias` (stops), `snap()`, `settle(frame)`, `bodies`.
- `createWeatherSystem(engine, world?) → WeatherSystem`, name 'weather', with `whiteout` (0..1, for hud.whiteout) and `visibility`.
- Add 'sky' before 'weather'. Both read f.view.env and f.view.camera.
- They write the U light and fog uniforms, ATMOS, scene.environment, scene.fogNode, HDR stage 'storm' (100) and overlay 'whiteout' (100).
- No contract changes. shared.ts is untouched.

**What exists**
- Sun and moon placed by clock at 46°N: noon sun at 22°, sunset 16:45, the moon with its phase. The sky is CPU-built Rayleigh/Mie/ozone tables with multiple scattering, giving blue hour, belt of Venus and earth shadow.
- Stars turn about the pole. Moon disc shows its phase. Sun disc has a soft limb.
- 2.5D cloud deck closes into a grey ceiling. Aurora: green with red tops and violet hems.
- Lighting: CSM key light (sun or moon), image-based ambient, auto exposure.
- Weather: height fog. Half-resolution storm volume on WebGPU medium and up; screen-space veils on WebGL2, phones and 'low'. Instanced snow streaks, spindrift, whiteout wash.

**Problems in other modules**
- ENGINE GTAO turns far grazing ground nearly black at dusk, at night and in storms. Repro: `&noao=1`. Fix idea: also fade AO with view depth.
- shared.ts U uniforms are object-group. Plain materials read stale values through scene.fogNode, so I mirror the ones I need in render-group copies. Suggest `.setGroup(renderGroup)` on them.
- WebGL2 with gpuTiming and 3 shadow cascades: three logs "query already active" warnings. Only in benches; the game has gpuTiming off.

**Not done or unsure**
- Storm volume has no temporal accumulation; it uses jitter plus a depth-aware upsample.
- Snow has no soft depth fade.
- Storm structure checked only in still frames.
- TAA sky velocity untested.
- Budgets not measured: the shared GPU runs the engine bench at 80 ms. Under the same load my benches cost about a quarter to half of the engine bench.
