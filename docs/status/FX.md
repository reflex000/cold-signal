# FX status (handoff note)

Module: FX (fire, flares, light pool, breath, screen overlays, small effects).
Files owned: src/gfx/fx/**, dev/fx.html, dev/fx.ts, one registration line in src/game/visuals.ts.

## State (session 1): complete
- src/gfx/fx: index (system, catch-up, eye adaptation, markers mute), lights (pool), ctx, noise,
  particles (puff / glow / debris pools), flame (tongues, coal beds), fire, flare, breath, impacts,
  emitters (props smoke / steam / spark / light / beacon emitters and lamps), overlays (frost, lens
  drops + lens snow, hurt / low health). Type-checks (project tsc clean).
- Registered in src/game/visuals.ts (one dynamic-import line after the markers, try/catch).
- Bench dev/fx.html: WebGPU, WebGL2, --mobile 1, 'high' (fire shadow): consoles clean.
- Real game: first.mjs and survive.mjs PASS, consoles clean; scratch scenarios (wreck barrel, a laid /
  lit / fed campfire, rifle muzzle flash, flare gun shot + landed flare, frost from a cold core, lens
  snow in a storm) on WebGPU, WebGL2 and --mobile 1.

## Possible next steps (not required)
1. Heat haze above fires (HDR stage 300) was not done (budget: one extra baked pass).
2. Remove the stand-in markers' fire/flare branch and its 3 point lights (fx mutes the branch at run
   time, but the 3 lights still cost per pixel); the heli light should come from the pool.
3. Re-measure GPU cost on a GPU at full clocks (this one is in power-saving mode, numbers swing).

## Public API (stable)
```ts
import type { FxSystem } from '../gfx/fx';
const fx = engine.get<FxSystem>('fx');                // GfxSystem name 'fx'
const beam = fx.lights.acquire('spot', 6);             // priority: fires/lamps 1, flares 1.5,
beam.on = true;                                        //   remote flashlights 2, local 6, muzzle 8
beam.position.set(x, y, z); beam.direction.set(dx, dy, dz);   // unit
beam.color.setRGB(1, 0.93, 0.8); beam.intensity = 60; beam.range = 35; // candela, metres
beam.angle = 0.42; beam.penumbra = 0.55;  beam.colorFar / decay / shadow / fadeIn (optional)
beam.level / beam.lit                                  // read: drawn intensity, has a real light
beam.release();
fx.lights.active                                       // best requests this frame (eye shine)
fx.burst('muzzle'|'snow'|'step'|'chips'|'sparks'|'splash'|'shards'|'steam'|'smoke', x,y,z, dx?,dy?,dz?, k?)
fx.forceOverlays(frost|null, wet|null, snow|null); fx.info; fx.debug()
```

## Decisions / facts
- Pool: fixed THREE lights per tier (mobile 1 point+1 spot, low 2+1, medium 3+1, high 4+2 with point
  0 casting the fire shadow, ultra 5+3); unused lights at intensity 0 (no recompiles). Point lights:
  colorNode mix(hot, cool, dist/range) (hot near, cool far), uniforms in the render group. Assigned
  in scene.onBeforeRender (camera === engine.camera) after every system updated, with fades.
- PARTICLE_LIGHTS: the 8 best requests as uniform arrays; puffs / debris lit per vertex (with forward
  scattering), so smoke and breath glow in front of fires and flares.
- Light scale: campfire 4 cd (12 m), barrel 3.7, stove 1.8 (in front of its door), match 0.5,
  flare 30 (60 in flight), muzzle 40 for 70 ms. Flame ramp floor 2.4; premultiplied blend with 0.6
  soot absorption so flames read in front of their own firelit snow.
- Eye adaptation: fx lowers sky.exposureBias by up to 1.25 stops from firelight near the camera
  (additive: only its own share).
- Catch-up: skipped frames (CS.step(n) renders 1 of n) are simulated (last 3 s, 1/30 s steps);
  pause / photo freeze fx.
- Markers: fx wraps the markers' update so it sees no 'fire' / 'flare' (flag __fxMuted; FIGURES
  does the same for players / wolves with __csMuted; the wrappers chain).
- Campfire FireEnts get KIT's 'campfire' model through the props system (stage 0 laid, 1 burning,
  2 embers, 3 dead). Stove chimney smoke: a props 'smoke' emitter within 6 m above it, else 3.4 m up.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/fx|dev/fx"
- node tools/shot.mjs "dev/fx.html?fire=1&light=night&t=12&az=30&el=8&dist=2.6&ty=0.6" --out fx_night
  (type=barrel|stove, fire=0..3, flare=1|2, breath=1, fp=1&fov=70, frost=, wet=, lsnow=&wdir=210,
  hurt=, low=, fx=muzzle|snow|chips|sparks|splash|shards, ignite=1|match, die=fuel|wind|snow, gust=,
  wind=, post=1 (fire shadow on q=high), --backend webgl, --mobile 1; &perf=1 [&nofx=1] puts the
  median GPU ms in window.PERF)
- node tools/play.mjs tools/scenarios/survive.mjs ; first.mjs

## Final report

**Files.** src/gfx/fx/{index, lights, ctx, noise, particles, flame, fire, flare, breath, impacts, emitters, overlays}.ts; dev/fx.html, dev/fx.ts; one line in src/game/visuals.ts (dynamic import after the markers).

**API.** `createFxSystem(engine, world): FxSystem` ('fx'). `fx.lights.acquire('point'|'spot', priority?) → LightHandle` (fields `on, position, direction, color, colorFar, intensity, range, decay, angle, penumbra, priority, shadow, fadeIn`; read `level, lit`; `release()`), `fx.lights.active`; `fx.burst(kind, x, y, z, dx?, dy?, dz?, k?)`; `fx.forceOverlays(frost, wet, snow)`; `fx.info`, `fx.debug()`. FIGURES' flashlight already uses the pool.

**What it does.** Fires (campfire with KIT's staged model, barrel, stove): licking, wind-leaning noise flame tongues, coal beds, embers, smoke that rises, shears and fogs out, rim steam, match strike / fail, catching, gust guttering, feed sparks, dying to embers, snuffed steam. Pooled lights capped by maxLights: multi-frequency flicker, hot-near/cool-far colour, nearest-fire shadow on high/ultra. Flares in flight and landed. Breath for every player (own breath in the view) and panting wolves. Overlays: growing frost crystals, melt drops, lens snow facing a storm, hurt / low health (no resample on mobile). Muzzle flash + smoke, axe chips / sparks, snow puffs (steps in deep snow, landings, drops, wolves), splash + ice shards. Lamps and beacons from props.

**No contract changes.** Cross-module touches, at run time only: fx wraps the stand-in markers' update to hide fires/flares (as FIGURES does for players), and adds its eye adaptation to `sky.exposureBias` (only its own share).

**Checks.** tsc clean; first and survive scenarios pass, consoles clean on WebGPU, WebGL2, --mobile 1.

**Open.** GPU cost is unreliable in this power mode: fire + flare measured −3…+18 ms against a 43–61 ms medium frame and +5.6 ms of 18 ms on mobile (roughly 0.3–1.5 ms at normal clocks). The markers' 3 idle point lights should be removed by GAME. Stove flames show only through openings in STRUCTURES' stove. No heat haze.
