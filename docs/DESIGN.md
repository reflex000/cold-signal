# Cold Signal — design and module contracts

A first-person co-op survival game for the browser. three.js 0.187 `WebGPURenderer` (WebGPU, with
automatic WebGL2 fallback), TSL node materials, TypeScript, Vite. Every mesh, texture, sound and
note of music is generated in code at load. There are no art or audio files.

Runs on desktop (keyboard + mouse, gamepad) and on phones and tablets (touch, landscape).

## 1. The game

Flight 417 has gone down on the south flank of a mountain in a blizzard. You crawl out of the
fuselage at dusk. The emergency radio is dead: its parts are scattered over the mountain with the
wreckage and in the places people left behind. Find five parts, climb to the old signal tower on
the north ridge, rebuild the transmitter, crank the generator and hold out until the helicopter
comes. The cold is the enemy; the wolves are what the cold sends.

One run is about an hour. Tone: realistic, tense, grounded. No magic, no jokes, no cartoon shapes.

**Loop.** Warm up, plan a leg, go out into the weather, find something, get back to warmth before
the cold or the pack takes you. Every leg is a bet against the storm clock.

**The threat is body temperature.** `core` (deg C): 37 healthy, 35 cold (shiver, slower stamina),
33 freezing (frost over the screen edges, slowed, shaky aim), 31 severe (health drains, vision
tunnels), 30 collapse (downed). What moves it: air temperature (falls with height and at night),
wind chill (scaled by `1 - shelter`), wet clothes (snowfall soaks slowly, falling through ice
soaks at once; wet triples heat loss and only dries by a fire or indoors), exertion (sprinting
warms a little and tires a lot), fire warmth (radius about 6 m, falls with distance, blocked by
wind unless sheltered), huddle (players within 2.5 m share warmth), hot drink and food.
Rough pace: exposed in a storm, healthy to freezing in 4 to 5 minutes; wet in a whiteout, 90
seconds; a good fire brings you back in about 2 minutes.

**Fire.** Lay a campfire from 3 sticks, light it with a match (tinder makes it near certain; wind
on an unsheltered fire makes it likely to fail and burns the match anyway). Feed sticks (40 s),
split logs (3 min) or a heavy log (12 min). Wind raises burn rate; a strong gust or heavy
snowfall on a starved, unsheltered fire kills it. A dead fire keeps embers for a while and
relights without a match. Fixed fireplaces: the cabin stove, the barrel at the wreck.

**Wood.** Sticks lie under trees and beside the trail, in bundles of one to three, with a few by the
wreck for the first fire. The dead lower branches of any pine, fir or snag snap off by hand: a hold
of use at the trunk for a second gives two sticks (a snag three or four), once per tree. The axe
turns dead standing trees and deadfall into sticks and split logs. Heavy logs cannot go in a pack:
one player drags one slowly, two carry it at walking pace (one at each end).

**Wolves.** Packs of 3 to 6 with an alpha. They howl before they come. They stalk at the edge of
sight, circle, send one in to feint, and charge whoever is most isolated, weakest, or downed.
They fear fire (will not enter its light while it is strong), burning flares, and gunshots (a
shot scatters the pack for a while; a kill scatters it for longer). They grow bolder with hunger,
darkness, whiteout and a dying fire. A wolf's eyes shine in the flashlight beam.

**Tools.** Axe (chop, last-ditch melee). Flashlight (cell drains; the beam makes eyes shine).
Flare gun (one cartridge loaded; a flare burns 40 s, lights the ground, holds wolves off, and at
the end marks the pickup point). Rifle (bolt action, 5 rounds, ammunition is scarce; aim sways
with cold and exhaustion). Hand-crank radio (crank to charge; hold it up and the static clears
into a tone as you face the nearest missing part, and later the tower).

**Weather.** Storm intensity rises and falls on a seeded curve with scripted peaks. In a whiteout
visibility is a few metres, wind doubles, fires struggle. Clear spells are the time to travel.
A day lasts 24 real minutes; the game starts at dusk. Clear nights bring the aurora.

**Places.**

| Id | Place | Where (x, z) | What |
| --- | --- | --- | --- |
| `wreck` | The fuselage | (-120, 520) | start; barrel fire, luggage, flashlight, matches, radio, flare gun |
| `tail` | Tail section | (270, 380) | down a ravine to the east; the ELT **battery**; axe in the cargo |
| `cabin` | Ranger cabin | (-430, 130) | stove, bed, rifle, ammunition, the **handset**; deep forest |
| `lake` / `hut` | Frozen lake and the ice-fishing hut | (190, -40) | the **fuse** is in the hut in the middle; thin ice |
| `cave` | The cave | (-310, -290) | shelter from any storm; a wolf den; the **tube** in an old survey cache |
| `camp` | Survey camp | (480, -330) | torn tents on an exposed shoulder; the antenna **coil** |
| `tower` | Signal tower | (40, -610) | the ridge; panel, generator, the ending |

**Co-op (2 to 4).** Every system is written for several players. Fire warmth and huddle are
shared. A downed player bleeds out over 90 s and can crawl; a teammate revives with a 5 s hold.
Heavy logs want two. Wolves pick the isolated. The radio parts can be carried by anyone. At the
tower one cranks, one installs, the others hold the wolves. Solo, a downed player with a bandage
gets one self-revive per checkpoint, otherwise the run reloads from the last fire rested at.
Companion bots (`settings.bots`) run through the same action path as humans and exist so co-op
systems are exercised and visible without networking.

**Ending.** All five parts installed, generator charged, call sent: the helicopter is 3 minutes
out and the worst of the storm arrives with the last pack. Mark the deck with a flare. Winch.

## 2. Art direction

Photographic, cold, quiet. Reference: a documentary shot on a real mountain at the edge of night.

- **Light.** Low sun through blowing snow, long blue shadows, a warm fire in a blue world. Night
  is dark: moon, aurora, fire, flare red, flashlight cone. Emissive things are small and hot.
- **Palette.** Snow is never pure white: blue-grey in shade, cream in low sun. Rock near black.
  Pines very dark green under snow. Colour is saved for fire, flare, parka cloth and the aurora.
- **Snow.** It is the main material: soft drifts, wind crust, sparkle at grazing angles, blue
  subsurface in shade, footprints and dragged trails that fill in again.
- **Air.** The storm is a volume, not a sprite sheet: layered fog, streaming snow near and far,
  gusts you can see coming across the slope.
- **Forms.** Real proportions. Worn, bent, torn, iced. Nothing chunky, glossy or toy-like.
- **Figures.** Parka with a fur-trimmed hood, goggles, scarf over the face, mitts, pack. No faces.
- **UI.** Sparse and diegetic where it can be. Thin type, off-white on dark, one amber accent.
  No cards, chips or badges. Reads at 1280 x 720 up to 4K, and on a phone in landscape.
- **Sound.** Wind is the bed. Everything else is small and close: boots, breath, fire. Music is
  sparse: a few bowed and struck tones that enter and leave with what is happening.
- **Writing.** Plain, short, no exclamation marks.

## 3. Architecture

```
            actions (InputCmd, Action)              snapshots + events
 input ---> ClientSession ---> Transport ---> Host ---> Sim (fixed 30 Hz)
              |   ^                                       |
   prediction |   | interpolation                         World (pure, from seed)
              v   |
             View (read-only)  --->  gfx / actors / audio / ui
```

- **World** (`src/world`) is a pure function of the seed. No three, no DOM. Host and clients
  build identical copies.
- **Sim** (`src/sim`) owns `SimState` (plain JSON) and advances it in fixed 1/30 s ticks from
  player commands. No three, no DOM, no `Math.random`, no wall clock. It emits `SimEvent`s.
- **Net** (`src/net`): `Host` wraps a `Sim`, accepts `ClientMsg`, sends `Snapshot`s (dynamic
  entities every tick, slow ones when their `rev` changes). `ClientSession` sends commands,
  predicts the local player with the same `stepPlayerMove` the host runs, reconciles on `ack`,
  and interpolates everything else about 100 ms in the past. `Loopback` joins the two in one
  page. `?wire=json&lag=120` serialises every message and delays it, to prove the path.
- **Game** (`src/game`) is client glue: input devices to commands, camera, focus picking, HUD
  view-model, saving (a save is `SimState` as JSON in localStorage), the bot brain.
- **Presentation** reads `View` and the bus only. It never mutates game state.
- Every entity has a `NetId`. Every state change is caused by an `InputCmd`, an `Action` or the
  tick itself. Saving, loading and (later) joining mid-game all use the same `SimState` JSON.

The frozen contracts are the TypeScript files below. Read the ones you touch before writing code.

| File | What it fixes |
| --- | --- |
| `src/sim/types.ts` | state, entities, items, commands, actions, events |
| `src/sim/api.ts` | `System`, `SimCtx` |
| `src/world/types.ts` | `World` and everything placed in it |
| `src/net/protocol.ts` | messages, `Transport` |
| `src/game/view.ts` | `View`, `Hud`, `Settings`, `GameActions`, `TouchSink`, bus messages |
| `src/gfx/api.ts` | `Engine`, `GfxSystem`, `Frame`, `Quality` |
| `src/audio/api.ts` | `AudioApi`, the sound names |
| `src/ui/api.ts` | `UiApi`, `UiGame` |

## 4. Code layout and ownership

```
index.html, src/main.ts     release shell and boot                        MAIN
src/core/                   rng, noise, math, bus                         MAIN
src/sim/types.ts, api.ts    contracts                                     MAIN
src/sim/                    Sim core, movement, systems (one file each)   SIM
src/world/                  heightmap, places, placement, queries         WORLD
src/net/                    host, client session, loopback                NET
src/game/                   input, camera, focus, hud model, save, bots   GAME
src/gfx/                    engine, quality, shared uniforms, post        ENGINE
src/gfx/sky/  weather/  terrain/  snow/  forest/  fx/                      one owner per folder
src/models/kit.ts, registry.ts, material.ts   the model toolkit           KIT
src/models/<group>/         models                                        one owner per folder
src/actors/                 player figure, wolf, first-person hands/tools ACTORS
src/audio/                  all sound and music                           AUDIO
src/ui/                     all DOM interface, touch controls             UI
dev/                        bench pages (each module adds its own)
tools/                      headless browser tools, scenarios
shots/                      captures (never committed)
```

Rules for everyone:

- Edit only files you own. If a contract is not enough, add an optional member to it in the right
  section, keep it JSON-safe, and say so in your final report. Do not edit another module.
- TypeScript, ES modules, no framework, no new npm dependencies. `import * as THREE from
  'three/webgpu'`, TSL from `'three/tsl'`, addons from `'three/addons/...'`. Never import plain
  `'three'` (it pulls a second copy of the core).
- **three.js moves fast and this is r187.** Do not trust memory for the WebGPU / TSL API. Read
  the source in `node_modules/three/src/nodes`, `node_modules/three/src/renderers`,
  `node_modules/three/examples/jsm/tsl` and the `webgpu_*` examples' addons before using it.
  The post pipeline class is `RenderPipeline` (`PostProcessing` is the old name).
- Materials are TSL node materials only (`MeshStandardNodeMaterial`, `SpriteNodeMaterial`, ...).
  No `ShaderMaterial`, no raw GLSL / WGSL, no `onBeforeCompile`: those break one backend.
  Do not use compute shaders or storage buffers without a WebGL2 path (check
  `engine.backend`); prefer techniques that run on both.
- TSL values may be typed `any`. Do not spend time fighting node typings.
- No `Math.random()` and no `Date.now()` in `src/world` or `src/sim`. Use `core/rng`.
- Textures are generated: canvas 2D, `DataTexture`, or TSL procedural noise. No `fetch`, no
  `url()`, no image or audio files, no web fonts.
- Units are metres, seconds, radians, degrees Celsius. Y up, X east, Z south, north is -Z.
  Yaw 0 faces north (-Z) and increases counter-clockwise seen from above.
- Performance is part of done: 60 fps at 1080p on the `medium` preset on an integrated GPU
  (Intel Arc class), 30+ fps on a recent phone on the `mobile` preset. Instance repeated things,
  merge static geometry, keep draw calls for a full view under about 400, allocate nothing per
  frame in hot paths.
- Do not `git commit`; MAIN commits at the end of each milestone. Several agents work in this
  folder at once: a type error in a file you do not own may be someone else's work in progress.
  Fix only your own files.
- Comments say what the code cannot: constraints, units, why. Game text is plain English.

## 5. Shared rendering state (`src/gfx/shared.ts`, owner ENGINE)

One module holds the TSL uniforms every material may read, so the whole frame agrees on the
light and the weather. Systems write the JS mirrors; materials read the nodes.

```ts
import { U, ATMOS } from '../gfx/shared';
U.time            // float, seconds
U.windDir         // vec2, world XZ unit vector the air moves toward
U.windSpeed       // float, m/s (mean + gust)
U.gust            // float 0..1
U.storm           // float 0..1
U.snowfall        // float 0..1
U.snowCover       // float 0..1 fresh snow lying on props and branches
U.sunDir          // vec3, unit, toward the sun
U.sunColor        // vec3, linear, premultiplied by intensity
U.moonDir, U.moonColor
U.skyAmbient      // vec3 hemisphere sky colour      U.groundAmbient // vec3 bounce
U.fogColor        // vec3   U.fogDensity // float (1/m)   U.fogHeight // float falloff
U.camPos          // vec3
U.playerPos       // vec3
U.trailTex, U.trailOrigin, U.trailSize   // snow deformation map around the player (R = depth 0..1)
U.exposure        // float
ATMOS             // plain JS mirror: { sunDir: Vector3, sunColor: Color, ..., night: number }
```

Ownership of the light: `gfx/sky` owns the sun and moon directional lights, the ambient, the sky
dome and the environment; `gfx/weather` owns `scene.fogNode`, the snowfall and the fog volume.
Every lit material sets `fog = true` and gets the shared atmosphere for free. Point lights for
fires, flares and flashlights come from one pool (`gfx/fx/lights.ts`) capped by `quality.maxLights`.

## 6. Models (`src/models`)

One toolkit builds every static thing; one prop material draws them all. Read `src/models/kit.ts`
first, and the reference model named in it for style.

- A model is `register('name', (seed, opts) => Builder -> ModelDef, meta)`. Metres, Y up, stands
  on y = 0 centred on the origin, +Z is its front.
- Geometry ends up merged, with per-vertex colour, a material id (snow, rock, bark, wood, metal,
  painted metal, cloth, plastic, glass, ice, rubber, fur, emissive) and detail coordinates, so
  the shared material adds grain, scratches, rust and weave procedurally.
- **Snow sits on everything.** The prop material blends snow onto up-facing surfaces by
  `U.snowCover`, noise and a per-vertex exposure weight; models mark covered spots (under a roof)
  as sheltered. No model paints its own snow except drifts that are geometry.
- Named parts (things the game moves or lights), anchors (named points), emitters (fire, smoke,
  steam, sparks, light) and lights are declared on the builder.
- Structures the player walks in or collides with take their footprint from
  `src/world/blueprints.ts` (pure data shared with the simulation), so the walls you see are the
  walls you hit. A model never invents a collider.
- Triangle budgets: small items 0.3 to 2k, props 1 to 5k, structures 8 to 40k.
- Check your work with `node tools/shot-models.mjs` (see its header) and Read the image. Look at
  every model from two angles in two lights before calling it done.

## 7. Tools and how to look at your work

- `node tools/gpucheck.mjs` — the headless browser is on the real GPU with WebGPU.
- `tools/pw.mjs` — `launch({ width, height, backend: 'webgpu' | 'webgl', mobile })`.
- `tools/serve.mjs` — `startServer()` starts a private Vite dev server on a free port with no
  file watching (other people are editing files while your tool runs).
- `node tools/play.mjs tools/scenarios/<name>.mjs [--q high] [--backend webgl] [--mobile 1]`
  drives the real game. The page exposes `window.CS` (the tool hook): `CS.step(n, dt)` advances
  the game deterministically (`?still=1`: no real-time loop), `CS.go(x, z, yawDeg, pitchDeg)`,
  `CS.env({ storm, clock, ... })`, `CS.give(item, n)`, `CS.view`, `CS.engine`, `CS.stats()`.
  A scenario gets `{ page, ev, step, shot, log }` and writes JPEGs to `shots/`.
- Bench pages under `dev/` mount one module alone (a model, the sky, the terrain, the audio, the
  UI) so it can be judged without the rest of the game.
- **Look at what you made.** Read the screenshot with the Read tool and judge it harshly against
  section 2: does it look like a photograph of a real place, or like a tech demo? Fix what looks
  cheap, flat, plastic, repetitive, noisy or broken before you report. Check the page log for
  errors and warnings; a clean console is part of done.
- `npm run check` type-checks everything; `npm test` runs the simulation tests (no browser).

## 8. Phones

- Input: left thumb stick to move, right side drag to look, buttons for use, primary, aim, jump,
  crouch, sprint toggle, tool wheel. All of it reports through `TouchSink` and becomes the same
  `InputCmd`. No pointer lock, no hover, no keyboard assumed.
- Layout: landscape; respects safe-area insets; HUD and menus scale with `clamp()`; tap targets
  at least 44 CSS px; nothing depends on right-click, wheel or hover.
- Rendering: the `mobile` quality tier. Half-float targets may be unavailable or slow, memory is
  tight, the GPU is tile-based: fewer full-screen passes, lower render scale, no ray-marched
  volumes, smaller shadow maps, fewer trees. The WebGL2 path must be clean, because many phones
  will take it. Never require a feature without checking it.
- Audio must start from a tap; the page must survive losing focus and coming back.
- `tools/pw.mjs` `mobile: true` emulates a phone viewport with touch and the WebGL2 backend.
