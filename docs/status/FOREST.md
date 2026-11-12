# FOREST status (handoff note)

Module: FOREST (trees, rocks, ground cover). Files owned: src/gfx/forest/**, src/models/nature/**
(unused: rocks are built in src/gfx/forest/rocks.ts), dev/forest.html, dev/forest.ts.

## State
- DONE. Everything in scope exists, type-checks (0 errors in forest files) and runs clean on WebGPU,
  WebGL2 (--backend webgl, with &gpu=0: the engine's own timer queries warn on WebGL2 even with
  &forest=0) and --mobile 1, in day / dusk / night / storm. Final report at the end.
- Possible next steps: shadows for far trees (impostors cast nothing, so the aerial view is a white
  carpet); a cheaper mid level (mid + full are ~70% of the forest cost); real card shadows at
  medium if the budget allows (high / ultra already use them for the full level).
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

## Final report

**Files.** src/gfx/forest/: index.ts (system), treegen.ts (spruce/fir/snag geometry, full + mid, shadow proxies), treemat.ts (variants, wind, LOD, depth/lit/proxy/bake materials), impostor.ts (atlas bake, billboards), rocks.ts, cover.ts, textures.ts (canvas needle atlas, coverage-preserving mips), common.ts. Bench: dev/forest.html + dev/forest.ts. src/models/nature unused.

**API.** `createForestSystem(engine: Engine, world: World): ForestSystem` (GfxSystem 'forest'); add it before `engine.warmup()`. The impostor bake (~60 ms) and setup (~1 s CPU) run inside the call. Extras: `group`, `counts`, `impostorAtlas`, `setLodTint(on)`, `setWindScale(k)`; uniforms `FU`, `RU`. It reads U.windDir/windSpeed/gust/time/snowCover/sun/sky/fog/camPos and quality treeNear, treeDensity, groundCover, viewDistance, shadowCascades, shadowDistance, aa. No contract changes.

**What is drawn.** 
- **Trees:** 8 variants per kind made in the vertex shader (crown base, gaps, fullness, lean; snag break and splinters), so the impostors match. Snow slabs with thickness scale with TreeInst.snow × U.snowCover. Saplings and half-buried young trees are sunk into the snow. Wind gives trunk bend, sway and branch bounce, plus gust bands rolling downwind.
- **LOD:** full mesh to 0.3 × treeNear, mid to treeNear, impostors beyond (8 azimuths × 3 elevations), with a dithered crossfade. treeDensity thins only the impostors.
- **Pixel cost:** each level has a depth prepass drawn before the terrain, then a Lambert lit pass with no depth write.
- **Shadows:** medium uses shadow-only crown proxies; high/ultra add the full meshes' own card shadows.
- **Rocks:** 8 variants in one draw (positions from a texture by vertexIndex), with chips, strata and snow caps.
- **Ground cover:** toroidal grid, no per-frame allocation, keeps off the trail, ice and floors.

**Cost.** In the forest view at medium: 37 calls in total, 21 of them forest (about 32 with 3 shadow cascades). The forest adds about 33 ms to a 46 ms baseline on this shared GPU; the first version added 490 ms. Scaled by ENGINE's idle numbers that is roughly 4–5 ms. It is not verified against the 4 ms budget.

**Open issues.**
- Seen from 300 m up the forest reads mostly white: impostors cast no shadows.
- On mobile (no AA) the LOD dither stipple is visible.
- The bench terrain is plain white.
