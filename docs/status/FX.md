# FX status (handoff note)

Module: FX (fire, flares, light pool, breath, screen overlays, small effects).
Files owned: src/gfx/fx/**, dev/fx.html, dev/fx.ts, one registration line in src/game/visuals.ts.

## State (session 1)
- [x] All files written and type-checking: index (system, catch-up, eye adaptation), lights (pool),
      ctx, noise, particles (puff / glow / debris pools), flame (tongues, coal beds), fire, flare,
      breath, impacts (muzzle, puffs, chips, sparks, splash, shards), emitters (props emitters,
      lamps, beacons), overlays (frost, lens drops + lens snow, hurt / low health).
- [x] Registered in src/game/visuals.ts (one dynamic-import line after the markers).
- [x] Bench dev/fx.html works on WebGPU, WebGL2 and --mobile 1, console clean.
- [x] Real game: barrel at the wreck, a laid + lit campfire, smoke, embers, eye adaptation work.
- [ ] Remaining: look pass on ignition / breath / muzzle / bursts / flare in flight; flare shot in the
      real game (needs HUNT's flare gun); WebGL2 + mobile in the real game; final perf numbers.

## Public API (stable)
```ts
import type { FxSystem } from '../gfx/fx';
const fx = engine.get<FxSystem>('fx');                // GfxSystem name 'fx'
// lights: persistent handles, assigned once per frame right before the scene renders
const beam = fx.lights.acquire('spot', 6);             // priority: fires/lamps 1, flares 1.5,
beam.on = true;                                        //   remote flashlights 2, local 6, muzzle 8
beam.position.set(x, y, z); beam.direction.set(dx, dy, dz);   // unit
beam.color.setRGB(1, 0.93, 0.8); beam.intensity = 60; beam.range = 35; // candela, metres
beam.angle = 0.42; beam.penumbra = 0.55;               // spot cone
beam.level / beam.lit                                  // read: drawn intensity, has a real light
beam.release();
fx.lights.active                                       // best requests this frame (eye shine)
fx.burst('muzzle'|'snow'|'step'|'chips'|'sparks'|'splash'|'shards'|'steam'|'smoke', x,y,z, dx?,dy?,dz?, k?)
fx.forceOverlays(frost|null, wet|null, snow|null)      // benches / tools
fx.info, fx.debug()                                    // counts; wind, eye adaptation, fires
```

## Decisions / facts
- Light pool: fixed THREE lights per tier (point+spot = maxLights: mobile 1+1, low 2+1, medium 3+1,
  high 4+2 (+point 0 casts shadows), ultra 5+3). Unused lights at intensity 0 (no recompiles).
  Point lights use a colorNode mix(hot, cool, dist(positionWorld, at)/range) = hot near, cool far.
  Assignment runs in scene.onBeforeRender (camera === engine.camera), after every system updated.
- Particle lights: PARTICLE_LIGHTS uniform arrays (8 best requests) used per vertex by puffs/debris.
- Draw calls: coals, puffs, debris, glow, flames (5 meshes) + overlays in the post chain.
- Light scale: campfire 4 cd at full heat (range 12 m), barrel 3.7, stove 1.8, flare 30 (60 in
  flight). Flame ramp floor 2.4 so even tips are several times brighter than the firelit snow;
  flames use a premultiplied blend with 0.6 soot absorption so they read against bright snow.
- Eye adaptation: the sky's auto exposure only knows moonlit snow; fx lowers sky.exposureBias by up
  to 1.25 stops from the firelight around the camera (additive: only its own share is written).
- Catch-up: when frames are skipped (CS.step(n) in ?still=1 renders 1 of n), fx simulates the last
  up to 3 s of the gap in 1/30 s steps, so smoke columns exist in tool shots and after hitches.
- Stand-in markers (src/game/standin/markers.ts, GAME) still draw stand-in flames, campfire stones /
  sticks and 3 point lights for fires and flares: the integrator must drop that branch once fx is in.
  My scratch scenarios hide 'standin-flames', 'standin-stones', 'standin-firelight-*' to judge fx.
- Perf (medium, 1632x918, Arc iGPU in power-saving mode, ~8-10x slow): fire + flare adds ~2-11 ms
  to a 41-59 ms frame (noisy), i.e. roughly 0.2-1.2 ms at normal clocks.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/fx|dev/fx"
- node tools/shot.mjs "dev/fx.html?fire=1&light=night&t=12&az=30&el=8&dist=2.6&ty=0.6" --out fx_night
  (type=barrel|stove, fire=0..3, flare=1|2, breath=1, fp=1, frost=, wet=, lsnow= (+ wdir toward the
  camera, e.g. 210), hurt=, low=, fx=muzzle|snow|chips|sparks|splash|shards, ignite=1 (no &t),
  --backend webgl, --mobile 1; &perf=1 [&nofx=1] puts the median GPU ms in window.PERF)
- Real game: scratch scenarios (not in the repo) drive CS: build/ignite/feed a campfire with CS.act,
  CS.env({clock, storm, lock}), CS.go; see the report for what to look at.
