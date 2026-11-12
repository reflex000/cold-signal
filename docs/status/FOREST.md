# FOREST status (handoff note)

Module: FOREST (trees, rocks, ground cover). Files owned: src/gfx/forest/**, src/models/nature/**
(unused: rocks are built in src/gfx/forest/rocks.ts), dev/forest.html, dev/forest.ts.

## State
- Everything in scope exists, type-checks and runs on WebGPU (shots of all five views in day and
  dusk look right). Remaining: WebGL2 / mobile / night / storm shots, perf re-measure, report.
- Files: common.ts (hashes, dither, noise texture, ForestMaterial (standard + analytic sky
  reflection, envScale), ForestLambert (foliage), snow rule, wind), textures.ts (canvas needle
  atlas, per-region coverage-preserving mips), treegen.ts (spruce / fir / snag geometry, full + mid,
  shadow proxies), treemat.ts (variant shape, depth / lit / proxy / bake materials), impostor.ts
  (atlas bake + depth / lit billboard materials), rocks.ts, cover.ts, index.ts (the system).

## Architecture (as built)
- One geometry per (kind, LOD); Mesh + InstancedBufferGeometry with instance attributes
  iA = (x, y_sunk, z, scale), iB = (yaw, kind*8+variant, snow, rnd). Eight variants per kind come
  from the vertex shader (crown base, dropped branches, length jitter, fuller side, lean; snags:
  break height, splinters, stubs) and depend on the variant only, so impostors match.
- Each tree level = depth prepass (cheap alpha test, colorWrite off, renderOrder -2/-1: drawn before
  terrain so hidden terrain is early-Z rejected) + lit pass (Lambert, LessEqual + polygonOffset,
  depthWrite off, same alpha function). EqualDepth was tried and dropped (programs compiled apart).
- LOD: full to 0.3*treeNear, mid to treeNear, impostors beyond; per-instance distance in the vertex
  shader, complementary screen-space dither between levels. treeDensity thins impostors only.
- CPU per frame (only when the camera moved): candidates from a 32 m grid; frustum-visible first,
  the rest only in shadow passes (onBeforeShadow / onAfterShadow swap instanceCount).
- Shadows: shadow-only proxy meshes per conifer kind (tiered crown envelope, geometric holes,
  FrontSide, no discard), main-pass instanceCount 0 via onBeforeRender (no draw). Snags cast via
  their depth mesh, rocks near/mid cast. Impostors neither cast nor get their own proxy.
- Impostor atlas: 20 types x 8 az x 3 el (0/30/60 deg), 64x128 frames, 2048x1920, MRT albedo +
  aux (normal xz, AO, snow potential), baked in 3 instanced draws (~60 ms). NOTE: the baked atlas
  runs top-down in v on both backends; impostor sampling flips v (measured).
- Rocks: 8 variants in a half-float texture (textureLoad by vertexIndex), nested icosphere levels
  near 1280 / mid 320 / far 20 tris. Cover: toroidal 1.6 m grid, stones (rock material) + plants.

## Gotchas found (keep)
- Foliage snow potential must scale with facing (an additive noise term whitened down-facing
  needles at heavy loads and got baked into impostors).
- Specular on needle cards (standard material) made crowns khaki-grey: foliage is Lambert.
- Empty cover slots have size 0: clamp before dividing (NaN vertices made huge triangles).
- InstancedBufferGeometry.instanceCount defaults to Infinity: initialise to 0.
- The bench terrain is plain white: trees standing on a slope above the camera look "cut off".

## Numbers (shared GPU, so relative only)
- Forest view medium 1360x765: forest adds ~34 ms over a ~48 ms baseline (was +490 at first).
  37 draw calls with the forest (16 without). Triangles: spruce 3450/726, fir 2906/1410,
  snag 476/300, proxies ~100. Bake ~60 ms; createForestSystem ~0.9-1.1 s total (CPU, shared).

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/forest|dev/forest"
- node tools/shot.mjs "dev/forest.html?view=forest&light=day&t=3&frames=8" --out f_forest_day
  (view = forest|edge|aerial|clearing|snags; light = day|dusk|night|storm; &lod=1 tint; &q=;
  &wind=; --backend webgl; --mobile 1)
- debug: &hide=impostor,rocks,cover,-full,-mid,snag,proxy  &atlas=1|2|3  &fov=&az=&el=
  &perf=1&pf=200 prints GPU ms (compare with &forest=0 in separate page loads; the in-page
  &perf=ab interleave is unreliable on the shared GPU)
