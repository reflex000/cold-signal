# ENGINE — handoff note

Module: renderer setup, quality presets, device detection, post pipeline + extension API, shared
bench helper, docs/THREE_NOTES.md. Owner files: `src/gfx/engine.ts`, `quality.ts`, `post.ts`,
`detect.ts`, `shared.ts` (append only), `dev/bench.ts`, `dev/engine.html`, `dev/engine.ts`,
`docs/THREE_NOTES.md` sections 1-11 (KIT owns section 12).

## State

All in scope is done, type-checks, runs clean (no console errors or warnings) on WebGPU, WebGL2
(`--backend webgl`) and phone emulation (`--mobile 1`) in day / dusk / night / storm at every tier.

Session 2 changes:
- Fixed: scene depth was depth24plus despite reversed depth (PassNode sets FloatType only in
  setup(), after warmup's compileAsync had allocated it) -> post.ts sets FloatType (and the colour
  type) right after pass(); this also fixed the TRAA ('ultra') depth-copy validation error.
- Fixed: compileAsync leaked the scene-pass MRT into frames (TAA): post.compile() restores state
  synchronously and post.render() binds canvas + null MRT every frame. New `engine.compile(obj)`.
- No powerPreference on Windows (Chrome warned on every load).
- ACES by default (AgX kept: `post.tonemap = 'agx'`, bench `?tm=agx`); grade reworked (cold
  shadows / mids, highlights keep the sun's warmth, saturation 0.9, contrast 1.03); bloom
  threshold 3 / knee 1 / strength 0.4 in exposed units (snow never blooms, fire / sun / flare do).
- Bench: night exposure 4.2 -> 1.6, day sky / bounce ambient adjusted, test fire 60 -> 14,
  flare 220 -> 45, neutral snow albedo. Snow in sun ~216-222 sRGB slightly warm, shade (79,99,131),
  rock 22-90, night moonlit snow ~(34,36,53), fire pool warm.
- GTAO verified on WebGL2 (GLSL textureGather polyfill): enabled there for high / ultra only.
- `post.userGrain` (Settings.grain). isSky uses isBackgroundDepth.
- dev/engine.ts: `?perf=1` per-stage cost table, `?late=1` mid-run engine.compile() test, nicer
  frost sample overlay.

## Possible next steps (none required)
- Bench far ridges are plain cones (fine for a bench; real terrain is WORLD / gfx/terrain).
- Mobile has no AA (sub-pixel wires show as dashes); FXAA costs ~0.2-0.3 ms there if wanted.

## Decisions / facts a successor needs

- This machine's GPU is an Intel Arc iGPU (Xe-LPG): the 'medium' target hardware itself; auto
  picks 'medium' here and 'mobile' under phone emulation.
- Perf (1080p window, bench scene 771 draws / 210k tris, GPU shared so noisy): medium 1632x918
  total ~5.5-6.7 ms GPU: scene ~3.5, GTAO ~1.3-2, bloom ~0.6-1, FXAA ~0.3, grain ~0.1, post
  ~2-3 ms. mobile 1440x810 ~3.3 ms, post ~0.3-0.5 ms. Shadows off halves draw calls (CPU).
  WebGL2 timer values are unreliable (CPU-bound with 770 draws).
- First timestamp resolve takes > 0.3 s: stats.gpuMs reads 0 at first. GPU timing is off unless
  `createEngine(canvas, { quality, gpuTiming: true })` (the bench turns it on).
- Exposure convention: U.exposure scales scene-referred linear colour; exposed 0.18 = mid grey,
  sunlit snow ~1.0. Bench presets: day 0.62, dusk 1.5, night 1.6, storm 0.85 (KIT's viewer copied
  the old night 4.2 / AgX and should follow).
- Frames must go through engine.frame(); three's own rAF loop runs too (started by render()),
  engine advances nodeFrame itself and owns info.reset().

## Test commands

- `npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/(engine|quality|post|detect|shared)|dev/(bench|engine)"`
- `node tools/shot.mjs "dev/engine.html?light=day&q=medium&hud=1&t=3&frames=30" --out eng_day_medium`
  (light = day|dusk|night|storm, q = mobile|low|medium|high|ultra, add `--backend webgl` or `--mobile 1`;
  `&stages=mist,haze&overlays=frost,drops` exercises the extension API; `&ldr=1`, `&depth=standard`
  fallbacks; `&late=1` mid-run compile; `&az=245&el=3` looks into the dusk sun)
- per-stage cost: `dev/engine.html?q=medium&perf=1&t=3`, read the PERF console table (or
  window.PERF) after DONE (~30 s).

## Final report

Files: src/gfx/engine.ts, quality.ts, detect.ts, post.ts, shared.ts (U.resolution, added earlier), dev/bench.ts, dev/engine.html, dev/engine.ts, docs/THREE_NOTES.md sections 1-11 (KIT wrote 12). Everything type-checks. Console is clean on WebGPU, WebGL2 and --mobile 1, in all four lights, at every tier.

API:
- `createEngine(canvas, { quality, forceWebGL?, gpuTiming?, dynamicResolution?, forceLDR?, depth? }): Promise<CsEngine>` (extends Engine). Setup: `engine.add(sys)`, then `await engine.warmup()`; after that call `engine.frame({ dt, time, view })` once per rAF.
- Extras: `engine.compile(obj): Promise<void>` (call before `scene.add` for anything created mid-game), `engine.userScale` (Settings.renderScale), `engine.post.userGrain` (Settings.grain), `engine.dynamicResolution`, `engine.lost`, `engine.onDeviceLost`, canvas event `cs:devicelost`, `engine.device`.
- `getQuality(name)`, `lowerQuality`, `isQualityName`; `detectDevice()`, `pickQuality(info?)` (for 'auto': `engine.setQuality(pickQuality(engine.device))`).
- `createBench({ light, quality, orbit, ground })` returns `{ engine, scene, camera, sun, setLight, onFrame, orbit, busy, param, num }`.

Post extension (`engine.post`):
- `addHdrStage(name, order, (i) => vec3, { resample?, enabled? })` runs before bloom and exposure. `i` has: color (linear, scene-referred), uv, depth, viewDepth (m), viewPos, worldPos, normal, isSky, sample(uv), viewDepthAt, worldPosAt, quality, backend, hdr. Orders: 100 storm, 200 god rays, 300 haze.
- `addOverlay(name, order, (color, uv, i) => vec3, opts)` runs after tone mapping and AA; `color` is display sRGB, and `i` adds aspect and sample(uv) (sample needs resample). Orders: 100 whiteout, 200 frost, 300 drops, 400 damage.
- Also: `remove`, `setEnabled`, `has`, `invalidate`, `uniforms` (bloom/AO/grade/vignette/grain), `tonemap`.
- Example: `const u = uniform(0); engine.post.addHdrStage('storm', 100, (i) => mix(i.color, U.fogColor, smoothstep(2, 60, i.viewDepth).mul(u)));` then set `u.value` in update(). Builders re-run on every rebuild, so create uniforms outside them.

Fixed: the scene depth was depth24plus even with reversed depth on (now depth32float). This also fixed the TAA validation error. compileAsync's MRT leaked into frames. The powerPreference warning is gone.

Look: switched to ACES, with a split grade. Snow in sun is about 218 sRGB and slightly warm, shade is blue, rock is dark. Snow never blooms; fire, sun and flares do. Bench night exposure is now 1.6, and the fire is dimmer.

Cost (Arc iGPU, this machine, shared GPU, 1080p): medium at 1632x918 takes 5.5-6.7 ms on the GPU. The scene is 3.5 ms, GTAO 1.3-2, bloom 0.6-1, FXAA 0.3; the whole post chain is 2-3 ms. mobile at 1440x810 takes 3.3 ms, of which post is 0.3-0.5.

No contract changes. Not verified: WebGL2 GPU timings are unreliable. mobile has no AA. KIT's viewer copied the old night exposure (4.2) and AgX.
