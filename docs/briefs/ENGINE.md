# Brief: ENGINE
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: ENGINE. Files you own: src/gfx/engine.ts, src/gfx/quality.ts, src/gfx/post.ts, src/gfx/detect.ts,
src/gfx/shared.ts (exists; you may append uniforms), dev/bench.ts, dev/engine.html, dev/engine.ts.

Build:
1. src/gfx/quality.ts — the five presets ('mobile', 'low', 'medium', 'high', 'ultra') as Quality objects per
   src/gfx/api.ts, tuned so 'medium' can hold 60 fps at 1080p on an Intel Arc integrated GPU and 'mobile' can
   hold 30+ fps on a recent phone. getQuality(name).
2. src/gfx/detect.ts — detect the device: touch / phone / tablet, WebGPU availability, adapter description, a
   rough GPU tier, and pickQuality() for the 'auto' setting (phones -> 'mobile'; integrated -> 'medium'; discrete
   -> 'high'). Never throws.
3. src/gfx/engine.ts — export async function createEngine(canvas: HTMLCanvasElement, opts: { quality: QualityName;
   forceWebGL?: boolean }): Promise<Engine>, implementing Engine from src/gfx/api.ts on THREE.WebGPURenderer
   (WebGPU backend with automatic WebGL2 fallback; forceWebGL from opts or ?webgl=1). Correct colour management
   (linear workflow, HDR scene-referred until tone mapping), camera near 0.08 / far about 6000 with depth precision
   handled (reversed or logarithmic depth if r187 supports it cleanly on BOTH backends; verify, do not assume),
   shadow maps enabled, resize with renderScale and maxPixelRatio, a frame() that updates shared uniforms it owns
   (U.time, U.camPos), runs every GfxSystem.update in order, renders through the post pipeline, and fills
   engine.stats (draw calls, triangles, smoothed frame ms and fps; GPU time if cheaply available). warmup() uses
   renderer.compileAsync so the first frame does not hitch. Handle device loss without a crash loop.
   Optional dynamic resolution: when enabled, nudge the render scale to hold the frame-time target.
4. src/gfx/post.ts — the post pipeline on THREE.RenderPipeline (read node_modules/three/src/renderers/common/
   RenderPipeline.js and the display nodes in node_modules/three/examples/jsm/tsl/display). Scene pass (with MRT
   only where a later stage needs it) -> ambient occlusion (quality.ao, GTAO) -> bloom (quality.bloom; tuned so
   fire, flares and the low sun glow but snow does not blow out) -> exposure (U.exposure) -> filmic tone mapping
   (pick AgX or ACES by looking at snow in sun and in shade: snow must keep detail, never clip to flat white) ->
   colour grade (a cold, slightly desaturated grade with clean blacks) -> anti-aliasing per quality.aa -> vignette
   and subtle film grain (quality.grain). It must be extensible, because later modules add: (a) HDR stages that
   need scene colour and depth before tone mapping (volumetric storm fog, god rays, heat haze) and (b) screen
   overlays after tone mapping (frost creeping from the screen edges, melt drops on the lens, damage and low-health
   vignettes, whiteout wash). Provide a small, documented API for that, e.g. post.addHdrStage(name, order,
   (input: { color, depth, normal?, uv }) => colorNode) and post.addOverlay(name, order, (color, uv) => colorNode),
   with uniforms the owner can drive, and rebuild the node graph when stages or quality change. On the 'mobile'
   and 'low' tiers and on the WebGL2 backend the chain must degrade to something cheap and correct (few full-screen
   passes; no half-float dependence without a check).
5. dev/bench.ts — a helper for every other engineer's bench page: export async function createBench(o?: { light?:
   'day' | 'dusk' | 'night' | 'storm'; quality?: QualityName; orbit?: boolean; ground?: boolean }): creates the
   canvas and engine, writes plausible values into U / ATMOS for that light (sun and ambient lights added to the
   scene, a simple gradient sky background, fog), orbit camera controls (mouse and touch), reads ?light= ?q=
   ?webgl= ?az= ?el= ?dist= from the URL, runs the loop, sets window.DONE after a few frames and window.BACKEND,
   and returns { engine, scene, camera, setLight, onFrame(fn) }. Keep it small; the real sky system comes later.
6. dev/engine.html + dev/engine.ts — a test scene on the bench that stresses the pipeline: snow-white ground in
   sun and shadow, dark rock, a small emissive fire-coloured light at night, thin geometry for anti-aliasing,
   shadows. Shoot it in day, dusk, night and storm light, on webgpu, with --backend webgl and with --mobile 1, at
   each quality tier that changes the chain. Read the shots. Snow must look like snow in sun (soft, slightly warm
   highlights, blue shade), not grey plastic and not clipped.

Report the exact post extension API and how a system adds a full-screen HDR stage and an overlay.


STATE ON DISK (handoff note: docs/status/ENGINE.md): src/gfx/quality.ts, detect.ts, engine.ts (18 KB), post.ts
(34 KB), dev/bench.ts (17 KB), dev/engine.html, dev/engine.ts. The bench already renders on WebGPU (shots/
eng_day_medium.jpg, eng_dusk_medium.jpg, eng_night_medium.jpg exist: reversed depth, AO, bloom, FXAA working).
U.resolution was added to shared.ts.
REMAINING: the storm light; --backend webgl and --mobile 1 runs; every quality tier that changes the chain; judge
and tune the look; the post extension API documented. The dusk shot reported 135 ms frames and 48 ms GPU time for
a trivial scene on 'medium' at 1360 x 765 (the GPU was shared at the time): find out what each stage really costs
by toggling AO / bloom / AA / shadows / render scale and make sure 'medium' and 'mobile' are cheap by design;
report the numbers.
ALSO WRITE docs/THREE_NOTES.md (under 250 lines): verified facts about three r187 WebGPURenderer / TSL /
RenderPipeline that the other graphics engineers need so they do not have to re-read the three.js sources:
imports, pass / mrt / depth and normal access, tone mapping and output colour space, shadows and CSM, render
targets, what differs or breaks on the WebGL2 backend and on phones, compileAsync, and the pitfalls you hit, each
with the source file it comes from.
