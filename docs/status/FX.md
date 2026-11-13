# FX status (handoff note)

Module: FX (fire, flares, light pool, breath, screen overlays, small effects).
Files owned: src/gfx/fx/**, dev/fx.html, dev/fx.ts, one registration line in src/game/visuals.ts.

## State
- [x] All source files written (session 1): index, lights, ctx, noise, particles, flame, fire, flare,
      breath, impacts, emitters, overlays. Type-checks.
- [ ] Bench dev/fx.html + dev/fx.ts
- [ ] Registration line in src/game/visuals.ts
- [ ] Shots (WebGPU, WebGL2, mobile, real game) and look iteration

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
```

## Decisions / facts
- Light pool: fixed THREE lights per tier (point+spot = maxLights: mobile 1+1, low 2+1, medium 3+1,
  high 4+2 (+point 0 casts shadows), ultra 5+3). Unused lights at intensity 0 (no recompiles).
  Point lights use a colorNode mix(hot, cool, dist(positionWorld, at)/range) = hot near, cool far.
  Assignment runs in scene.onBeforeRender (camera === engine.camera), after every system updated.
- Particle lights: PARTICLE_LIGHTS uniform arrays (8 best requests) used per vertex by puffs/debris.
- Draw calls: coals, puffs, debris, glow, flames (5 meshes) + overlays in the post chain.
- Stand-in markers (src/game/standin/markers.ts, GAME) still draw stand-in flames, campfire stones
  and 3 point lights for fires/flares: the integrator must drop that branch when 'fx' is present.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/fx|dev/fx"
