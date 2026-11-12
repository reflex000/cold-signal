# ENGINE — handoff note

Module: renderer setup, quality presets, device detection, post pipeline + extension API, shared
bench helper, docs/THREE_NOTES.md. Owner files: `src/gfx/engine.ts`, `quality.ts`, `post.ts`,
`detect.ts`, `shared.ts` (append only), `dev/bench.ts`, `dev/engine.html`, `dev/engine.ts`,
`docs/THREE_NOTES.md`.

## State (update after every step)

- [x] quality.ts, detect.ts, engine.ts, post.ts, dev/bench.ts, dev/engine.* exist and type-check
- [x] session 2: fixed scene depth being depth24plus despite reversed depth (PassNode sets
      FloatType only in setup(), after warmup's compileAsync allocated it) -> post.ts forces
      FloatType at pass creation; this also fixed the TRAA (ultra) depth-copy validation error
- [x] no powerPreference on Windows (Chrome warned on every load)
- [x] tone mapper ACES by default (AgX kept, `post.tonemap = 'agx'` / bench `?tm=agx`); grade
      reworked (cool shadows/mids, highlights keep the sun's warmth); bloom threshold 3 / knee 1
      exposed (snow never blooms); bench night exposure 1.6, bench fire/flare much dimmer
- [x] GTAO verified working on WebGL2 (GLSL gather polyfill); enabled there for high/ultra only
- [x] all lights x tiers x webgpu / webgl / --mobile 1 shot, console clean
- [x] dev/engine.ts `?perf=1`: per-stage GPU cost table (console + window.PERF)
- [ ] user grain setting hook (post.userGrain), docs header of post.ts
- [ ] docs/THREE_NOTES.md
- [ ] final perf numbers, final report

## Decisions / facts a successor needs

- This machine's GPU is an Intel Arc iGPU (Xe-LPG): the 'medium' target hardware itself.
  Perf (1080p window, medium = 1632x918, bench scene 771 draws / 210k tris, GPU shared):
  scene ~3.4 ms, AO ~1.2 ms, bloom ~0.7 ms, FXAA ~0.3 ms, grain ~0.1 ms, whole post ~2 ms.
  mobile preset at 1440x810: total ~3.2 ms, post ~0.5 ms. WebGL2 timer numbers are noisy.
- First timestamp resolve takes > 0.3 s: stats.gpuMs reads 0 for the first ~30 frames.
- Exposure convention: U.exposure scales scene-referred linear colour; exposed 0.18 = mid grey,
  sunlit snow ~1.0, ACES white ~ exposed 8. Bench presets: day 0.62, dusk 1.5, night 1.6, storm 0.85.

## Test commands

- `npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/(engine|quality|post|detect|shared)|dev/(bench|engine)"`
- `node tools/shot.mjs "dev/engine.html?light=day&q=medium&hud=1&t=3&frames=30" --out eng_day_medium`
  (light = day|dusk|night|storm, q = mobile|low|medium|high|ultra, add `--backend webgl` or `--mobile 1`;
  `&stages=mist,haze&overlays=frost,drops` exercises the extension API; `&ldr=1`, `&depth=standard` fallbacks)
- per-stage cost: open `dev/engine.html?q=medium&perf=1&t=3` and read the PERF console table
  (or window.PERF) after DONE (takes ~25 s).
