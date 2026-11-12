# Brief: ATMOSPHERE — sky, light and weather (milestone M1)
(Read docs/briefs/COMMON.md first. Ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and on reading narrowly: your module is new.)

YOUR MODULE: ATMOSPHERE. Files you own: src/gfx/sky/**, src/gfx/weather/**, dev/sky.html, dev/sky.ts,
dev/weather.html, dev/weather.ts. You may append uniforms to src/gfx/shared.ts (append only; re-read it right
before editing, others append too).
Read first: docs/status/ENGINE.md, docs/THREE_NOTES.md, src/gfx/shared.ts, src/gfx/api.ts, src/game/view.ts and
the Env type in src/sim/types.ts, dev/bench.ts.

Deliver `createSkySystem(engine, world): GfxSystem` ('sky') and `createWeatherSystem(engine, world): GfxSystem`
('weather'), driven each frame by f.view.env (clock, day, storm, windX, windZ, gust, snowfall, visibility,
airTemp, cloud, aurora) and f.view.camera. Together they own all global light and all air. In your benches drive
them from sliders.

SKY (src/gfx/sky)
- Sun and moon from env.clock and env.day at about 46 degrees north in early winter: low sun (noon elevation
  about 22 degrees), sunset about 16:45, a long dusk; the moon on its own track with a phase.
- A physically based sky: transmittance and sky-view lookup tables rebuilt when the sun moves (single-scattering
  Rayleigh + Mie with an ozone tint), an analytic fallback for 'mobile'. Correct twilight: blue hour, belt of
  Venus, earth shadow. Thousands of stars faded by moon and cloud; the moon disc with phase and halo; a sun disc
  with a soft limb.
- Clouds: a moving layer (few-step 2.5D ray-march or layered noise) lit by sun and moon; env.cloud and env.storm
  thicken it into a flat grey ceiling.
- Aurora on clear nights (env.aurora): green curtains with red tops and violet hems folding slowly, ray-marched
  with quality.auroraSteps (0 = off), faintly tinting the ambient.
- Drives: the sun DirectionalLight (colour from transmittance, dimmed by cloud) with cascaded shadows from
  quality.shadowCascades / shadowMapSize / shadowDistance (r187 CSMShadowNode, examples/jsm/csm/CSMShadowNode.js:
  follow the camera, stable texel snapping, no shimmer); a weak cool moonlight at night; image-based ambient (a
  PMREM of the sky refreshed when it changes enough, or spherical harmonics) so snow and metal reflect the right
  sky; U.sunDir, sunColor, moonDir, moonColor, skyAmbient, groundAmbient (snow bounce about 0.6-0.8 of the sky
  ambient), night, exposure (auto exposure: noon snow about 0.75 display, moonlit snow dim blue but readable), and
  the ATMOS mirror.

WEATHER (src/gfx/weather)
- scene.fogNode: height fog with density from env.visibility (about 3.9 / visibility), in-scattering brighter
  toward the sun, a luminous near-white fog in storms that also swallows the sky so a whiteout dissolves the world
  within metres.
- Volumetric blizzard as an HDR stage (engine.post.addHdrStage, order 100): ray-march 3D noise advected by the
  wind, so streaks and gust fronts visibly cross the slope; lit by sun and ambient; density from env.storm and
  env.snowfall; quality.volumetricSteps (0 = analytic only); blue-noise jitter plus temporal accumulation or a
  cheap blur; depth-aware. On WebGL2 and 'mobile': analytic fog plus a cheap screen-space streak layer.
- Falling snow around the camera: instanced quads, no compute shaders (it must run on WebGL2), in a box wrapping
  around the camera, animated in the vertex shader from per-instance seeds, time, wind and gust (flakes stream
  sideways in a gale), stretched along velocity relative to the camera, soft, lit by sun and ambient, depth-faded
  near surfaces; count from quality.snowParticles and env.snowfall; near flakes, mid streaks, far haze. Spindrift:
  low sheets of blowing snow over the ground in strong wind.
- Whiteout overlay (engine.post.addOverlay, order 100) flattening and brightening below about 15 m visibility;
  export the amount as weather.whiteout for the HUD.
- Every effect scales with Quality; 'mobile' and WebGL2 stay cheap and correct.

Budgets at 'medium' 1080p on this Intel Arc: sky + clouds < 1 ms, volumetric storm < 2 ms, particles < 1 ms.

Benches: dev/sky.html (?clock= &cloud= &aurora= &storm= &q= &webgl=1 and ?strip=1, eight clock times tiled into
one image) and dev/weather.html (?storm= &wind= &clock=, a simple ground with dark posts at 2, 5, 10, 20, 50, 100
and 200 m to judge visibility). Shoot noon, 16:00, 16:45 sunset, 17:15 blue hour, 22:00 clear with aurora, 22:00
moonlit, overcast day, storm 0.5, storm 1.0 whiteout, on WebGPU, --backend webgl and --mobile 1. Read every shot;
compare with real photographs of mountains in winter that you know; iterate.

STATE ON DISK: nothing of yours exists yet. Create docs/status/ATMOS.md first and keep it current.
