# three r187 notes (verified)

Facts checked against `node_modules/three` 0.187.0 and in headless Chrome on this machine (Intel
Arc iGPU, WebGPU and WebGL2 through ANGLE D3D11). Paths are relative to `node_modules/three/`.
Read this before opening the three.js sources. Owner of sections 1-11: ENGINE.

## 1. Imports
- `import * as THREE from 'three/webgpu'` (core plus WebGPURenderer, RenderPipeline, QuadMesh,
  NodeMaterial, Mesh*NodeMaterial, RenderTarget, RendererUtils, NodeUpdateType ...).
- TSL: `import { uniform, vec3, mix, pass, mrt ... } from 'three/tsl'`. The export list is
  `build/three.tsl.js`: grep a name there before using it. Values may be typed `any`.
- Addons: `three/addons/tsl/display/GTAONode.js` (`ao`), `FXAANode.js` (`fxaa`), `SMAANode.js`
  (`smaa`), `TRAANode.js` (`traa`), `BloomNode.js` (`bloom`); `three/addons/csm/CSMShadowNode.js`.
- Never `import 'three'`: it loads a second copy of the core.

## 2. Renderer (src/renderers/common/Renderer.js, src/renderers/webgpu/*)
- `new THREE.WebGPURenderer({ canvas, antialias, alpha, depth, stencil, samples, forceWebGL,
  reversedDepthBuffer, logarithmicDepthBuffer, outputBufferType, powerPreference, trackTimestamp })`
  then `await renderer.init()`. Defaults: alpha true, outputBufferType HalfFloatType.
- Without `forceWebGL` it tries WebGPU and falls back to WebGL2 with a console warning
  (WebGPURenderer.js `getFallback`). Backend test: `renderer.backend.isWebGPUBackend === true`.
  The engine asks for WebGL2 outright when no adapter exists, so the warning never shows.
- The adapter is requested with `featureLevel: 'compatibility'`; without the device feature
  `core-features-and-limits` the backend runs in compatibility mode and forces MSAA samples to 0
  (WebGPUBackend.init). Expect that on some Android devices.
- Chrome on Windows warns on every load that `powerPreference` is ignored: the engine omits it there.
- Device loss: `renderer.onDeviceLost(info)` is called for WebGPU `device.lost` and WebGL
  `webglcontextlost` (no restore); the default logs and makes render() a no-op. Uncaptured GPU
  errors go to `renderer.onError`. Use `engine.lost` / `engine.onDeviceLost` / canvas event
  `cs:devicelost`; the engine remembers the loss in sessionStorage and comes back one step safer.
- The first `render()` / `compute()` starts three's own rAF loop (Animation.js `start()`) even
  without `setAnimationLoop`; each tick it advances `nodeFrame` and resets `renderer.info` when
  `info.autoReset`. The engine sets `autoReset = false` and calls `nodeFrame.update()` once per
  engine frame, so per-frame nodes (passes, AO, bloom) run exactly once per engine.frame().

## 3. Colour, tone mapping, units
- Working space is linear sRGB. `renderer.toneMapping` / `outputColorSpace` apply only when
  drawing to the canvas, and `renderer.render()` straight to the canvas with either set renders
  into an extra half-float target plus an output pass (`needsFrameBufferTarget`).
- RenderPipeline runs its passes with NoToneMapping and the working space, then its final quad
  applies `renderOutput()` unless `outputColorTransform = false` (RenderPipeline.js). The engine
  sets it false: post.ts does exposure -> ACES -> grade -> `sRGBTransferOETF` itself. Materials
  never tone map; keep everything scene-referred linear.
- `agxToneMapping`, `acesFilmicToneMapping` (divides by 0.6 inside), `neutralToneMapping` take
  `(color, exposure)` (src/nodes/display/ToneMappingFunctions.js). Grey response, exposed value ->
  sRGB 8-bit: AgX 0.18->128, 1->202, 4->239, 16->254; ACES 0.18->127, 1->226, 2->242, 4->250.
  The engine uses ACES: AgX needs ~1.3 stops more exposure for the same snow and turns rock grey.
- Light units the bench uses (copy them): DirectionalLight colour is irradiance premultiplied
  (day sun [10.5, 8.9, 6.9]); a white surface facing a light of 3.14 has radiance 1. Hemisphere
  colour C gives radiance C x albedo / pi (HemisphereLightNode -> PhysicalLightingModel). After
  `U.exposure`: 0.18 = mid grey, sunlit snow ~1, bloom starts at exposed 2 (threshold 3, knee 1),
  so give fire / flares / embers emissive of 5 to 70 and they glow while snow never does.

## 4. Depth (ViewportDepthNode.js, PostProcessingUtils.js, PassNode.js)
- `reversedDepthBuffer: true` works on WebGPU and on WebGL2 with `EXT_clip_control` (otherwise
  WebGLBackend warns and falls back). Logarithmic depth is ignored when reversed is on.
  Cleared reversed depth is 0.
- PITFALL (fixed in post.ts): `pass()` creates its depth texture as UnsignedIntType and switches
  it to FloatType only in `setup()`. If `compileAsync` runs first the target is allocated as
  depth24plus and stays that way (verified), which wastes reversed depth and makes TRAA's depth
  copy fail validation. Set `scenePass.renderTarget.depthTexture.type = THREE.FloatType` (and
  `.texture.type = renderer.getOutputBufferType()`) right after `pass()`.
- `perspectiveDepthToViewZ(d, near, far)`, `getViewPosition(uv, d, projInv)`,
  `isBackgroundDepth(d)` and `getNormalFromDepth` all honour reversed depth. Shadow cameras get
  reversed depth automatically (ShadowNode.setupShadow). Near 0.08 / far 6000: no z-fighting on
  the 1.5 to 4.5 km ridges of dev/engine.html.
- In a post stage use the engine's helpers (`i.viewDepth`, `i.worldPos`) instead of raw samples.

## 5. RenderPipeline, passes, render targets
- `const rp = new THREE.RenderPipeline(renderer); rp.outputNode = node; rp.needsUpdate = true;
  rp.render();` (`PostProcessing` is the old name).
- `const sp = pass(scene, camera)`: `sp.getTextureNode()` colour, `sp.getTextureNode('depth')`,
  `sp.getViewZNode()`, `sp.getLinearDepthNode()`, `sp.setResolutionScale(s)`, `sp.setLayers(l)`.
  MRT: `sp.setMRT(mrt({ output, normal: directionToColor(normalView), velocity }))`, then
  `sp.getTextureNode('normal')` and `colorToDirection(...)`. MRT widens every scene draw, so the
  engine only uses it for TAA velocity; stages get normals reconstructed from depth.
- `rtt(node, w?, h?, { type, depthBuffer })` bakes a node into a texture (one full-screen pass);
  its default type is HalfFloatType, so pass `type` on devices without half-float targets.
  `convertToTexture(node)` passes textures through and rtt()s anything else.
- Custom multi-pass node (post.ts GlowNode / AoBlurNode): extend `THREE.Node`, set
  `updateBeforeType = NodeUpdateType.FRAME`, render a `QuadMesh` between
  `RendererUtils.resetRendererState` / `restoreRendererState` in `updateBefore(frame)`, return
  `passTexture(this, rt.texture)` from `setup()`. Node-valued properties feed the cache key:
  never leave one null (create the texture node in the constructor and swap `.value`).
- Display addons: GTAO (`ao(depth, normal|null, camera)`, 8-bit red target, `resolutionScale`,
  `samples`, `radius`, `thickness`), FXAA, SMAA (three half-float targets), TRAA (velocity MRT,
  half-float history, copies the depth texture), bloom. GTAO's `textureGather` has a GLSL
  polyfill (GLSLNodeBuilder `tsl_textureGather`): it runs on WebGL2 (verified).
- `new THREE.RenderTarget(w, h, { type, format, depthBuffer, samples })`: textures default to
  UnsignedByteType. `renderer.copyTextureToTexture` needs identical formats on WebGPU.
- `renderer.getDrawingBufferSize(v)` = CSS size x pixel ratio; the engine applies render scale
  through `setPixelRatio` and writes the size to `U.resolution`.

## 6. The engine's post extension API (src/gfx/post.ts, `engine.post`)
Two hooks. Each takes a builder function that returns a TSL colour node; it is called again on
every graph rebuild (quality change, stage added / removed / toggled), so create uniforms once
and drive `.value` from your GfxSystem.update. A builder that throws is logged once and skipped.
```ts
import { uniform, mix, smoothstep, min, vec3 } from 'three/tsl';
import { U } from '../gfx/shared';
const uFog = uniform(0);      // 0..1, written every frame by the weather system
engine.post.addHdrStage('storm', 100, (i) =>
  // i.color: linear scene-referred vec3 so far; i.viewDepth metres; i.worldPos; i.uv (top-left 0,0)
  mix(i.color, U.fogColor, smoothstep(2, 60, i.viewDepth).mul(uFog)));
const uFrost = uniform(0);
engine.post.addOverlay('frost', 200, (color, uv, i) => {
  // color: display-referred sRGB 0..1 after tone mapping and AA; i.aspect = width / height
  const edge = min(min(uv.x, uv.x.oneMinus()).mul(i.aspect), min(uv.y, uv.y.oneMinus()));
  return mix(color, vec3(0.8, 0.86, 0.92), smoothstep(uFrost.mul(0.25), 0, edge));
});
```
- HDR stage input: `color, uv, depth (texture node), viewDepth, viewPos, worldPos, normal`
  (from depth, 9 taps), `isSky` (nothing but background drawn), `sample(uv)`, `viewDepthAt(uv)`,
  `worldPosAt(uv)`, `quality`, `backend`, `hdr`. Overlay input: `color, uv, sample(uv), aspect,
  quality, backend`. Members are getters: unused ones cost nothing.
- Options `{ resample: true }` when the stage reads other pixels through `sample(uv)` (haze,
  drops; costs one baked pass), `{ enabled: false }` to start off. `setEnabled(name, on)`,
  `remove(name)`, `has(name)`, `invalidate()`. Toggling rebuilds the graph: fade with a uniform.
- Order conventions: HDR 100 fog / storm volume, 200 god rays, 300 heat haze. Overlays 100
  whiteout wash, 200 frost, 300 lens drops, 400 damage / low health. Same name replaces.
- `engine.post.uniforms`: bloomStrength, bloomThreshold, bloomKnee, aoStrength, saturation,
  contrast, temperature, shadowTint, vignette, grain (all `.value`). `post.tonemap = 'aces' |
  'agx'`, `post.userGrain` (Settings.grain), `post.active` = what the device actually built.
- Working examples: dev/engine.ts `?stages=mist,haze&overlays=frost,drops`.

## 7. Shadows and CSM (src/nodes/lighting/ShadowNode.js, examples/jsm/csm/CSMShadowNode.js)
- `renderer.shadowMap.enabled`, `.type`: PCFShadowMap (5-tap Vogel disc, `light.shadow.radius`
  widens it, hardware compare), VSMShadowMap, BasicShadowMap. PCFSoftShadowMap was removed:
  compileAsync warns and switches to PCF.
- CSM: `light.shadow.shadowNode = new CSMShadowNode(light, { cascades: q.shadowCascades,
  maxFar: q.shadowDistance, mode: 'practical', lightMargin: 200 })`. It clones `light.shadow`
  per cascade (mapSize; bias x (cascade + 1)), adds hidden cascade lights to `light.parent` (the
  light must be in the scene), takes the direction from `light.position` -> `light.target.position`
  (keep light and target under the same parent), binds the camera of its first build and honours
  reversed depth. Call `csm.updateFrustums()` after the camera's fov / aspect / near / far change
  (GfxSystem.resize, FOV setting, aiming). `csm.fade = true` blends between cascades.
- A shadowed point light renders six faces: the bench fire with `fireShadows` goes from 745 to
  1148 draw calls. Keep it to the one nearest fire (quality.fireShadows).

## 8. compileAsync (Renderer.js `compileAsync`, PassNode.js `compileAsync`)
- `renderer.compileAsync(sceneOrObject, camera, targetScene?, onProgress?)` compiles for the
  render target and MRT bound at the call: pipelines are keyed by attachment formats and MRT, so a
  compile against the canvas does not help the scene pass. Use `engine.warmup()` (whole scene)
  and `await engine.compile(obj)` before `scene.add(obj)` for things created mid-game.
- It snapshots renderer state synchronously, then yields; each time it yields it re-applies the
  MRT it started with (`_finishPreCompile`). `PassNode.compileAsync` keeps its target bound until
  it resolves: frames rendered meanwhile go to the wrong target. `engine.compile` restores the
  state synchronously and `post.render()` rebinds canvas / null MRT every frame, so it is safe
  while frames run.

## 9. WebGL2 backend and phones
- Same TSL source, compiled to GLSL ES 3.0. Compute is transform-feedback emulation (writes to
  vertex buffers only; no storage textures, no atomics): keep a non-compute path.
- Needs probing (src/gfx/detect.ts `probeWebGL2`): `EXT_color_buffer_half_float` for half-float
  targets (else the engine renders RGBA8, pre-exposed and sqrt-encoded), `EXT_clip_control` for
  reversed depth, `EXT_disjoint_timer_query_webgl2` for GPU timing (Chrome has it; noisy).
- Context attributes ignore `powerPreference`. Phones in tools/pw.mjs `--mobile 1` take WebGL2.
- WebGPU has 8 vertex buffers per draw: see "Materials, vertex attributes and instancing".

## 10. Stats and GPU timing (Backend.js, webgpu/utils/WebGPUTimestampQueryPool.js)
- `renderer.info.render.drawCalls / triangles`; reset once per frame (engine does).
- `trackTimestamp: true`, then `await renderer.resolveTimestampsAsync('render')` -> ms of all
  render passes of the latest frame in the batch. Query ids include `info.frame`, so it must
  advance per frame. The first value takes 0.3 s or more to arrive (engine.stats.gpuMs is 0
  until then).

## 11. Measured costs (Arc iGPU = the 'medium' target, GPU shared, 1080p window)
- 'medium' at 1632x918, bench scene 771 draws / 210k tris: scene ~3.4 ms, GTAO ~1.2 ms, bloom
  ~0.7 ms, FXAA ~0.3 ms, grain ~0.1 ms, whole post ~2 ms. Shadows halve the draw calls when off.
- 'mobile' at 1440x810: ~3.2 ms total, post ~0.5 ms (one full-screen pass + quarter-res glow).
- Run `dev/engine.html?q=<tier>&perf=1&t=3` and read the PERF table in the console.
