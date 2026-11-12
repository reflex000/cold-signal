# FOREST status (handoff note)

Module: FOREST (trees, rocks, ground cover). Files owned: src/gfx/forest/**, src/models/nature/**,
dev/forest.html, dev/forest.ts.

## State
- All files written and type-check: common.ts, textures.ts, treegen.ts, treemat.ts, impostor.ts,
  rocks.ts, cover.ts, index.ts, dev/forest.html + dev/forest.ts. Bench renders on WebGPU (first
  look: reads as snow-loaded spruce; slabs too board-like, curtains look like black drips).
- Perf restructure done (was 530 ms vs 38 ms baseline on the shared GPU, now ~130 ms):
  * trees: depth prepass (cheap alpha test, colorWrite off) + lit pass with depthFunc EqualDepth,
    depthWrite off, no discard (one lit fragment per pixel). Both share ONE position node object.
  * shadows: shadow-only proxy meshes per conifer kind (tiered crown envelope with noise holes,
    treegen proxyGeometry, treemat createProxyMaterial); main-pass instanceCount forced to 0 in
    onBeforeRender (no draw), restored in onBeforeShadow. Snags cast through their depth mesh.
  * fixed: NaN vertices from zero-size empty cover slots (rC = 0 -> normal / 0) made huge triangles;
    InstancedBufferGeometry.instanceCount defaults to Infinity (warm-up draw error) -> init 0.
  * far rocks use the 20-triangle icosahedron; impostors 4 taps (2 azimuth frames, elevation row by
    dither, explicit mip).
- NOW: interleaved A/B timing (?perf=ab&cfg=none,all,full,mid,proxy,snag,imp,rocks,cover), then
  shots of every view / light / backend and look polish (slabs reworked as lumpy pillows).

## Plan / architecture (decided, keep unless broken)
- Files: common.ts (TSL hash/dither/noise tex/sky-reflection material base, wind), textures.ts (canvas
  needle atlas + CPU mips with coverage-preserving alpha), treegen.ts (CPU geometry: spruce='pine',
  fir, snag; 'full' and 'mid' LOD), treemat.ts (3D tree material + bake material), impostor.ts (atlas
  bake with the real renderer + billboard material), rocks.ts, cover.ts, index.ts (createForestSystem).
- Draw-call budget (< 60 at medium incl. shadow cascades): ONE geometry per (kind, LOD) drawn as a
  Mesh + InstancedBufferGeometry with per-instance attributes iA = (x, y, z, scale), iB = (yaw,
  kind*8+variant, snow, rnd). The 8 variants per kind are made in the VERTEX SHADER from per-branch
  attributes (branch length factor / dropped branches / crown base / asymmetry keyed by variant), so
  impostors baked per variant match the 3D trees exactly.
- LOD: full mesh to ~0.38*treeNear, simplified mid mesh to treeNear, impostors beyond. LOD fade and
  culling are computed per instance in the vertex shader from U.camPos (dithered crossfade in the
  fragment shader with a screen-space noise; complementary between LODs). CPU only picks candidate
  instances for the 3D LODs each frame (frustum-visible first; off-screen ones are drawn only in shadow
  passes via onBeforeShadow/onAfterShadow changing geometry.instanceCount). Impostors: one static
  buffer with all trees, culled in the vertex shader.
- Impostor atlas: 20 types (spruce v0-7, fir v0-7, snag v0-3) x 8 azimuths x 3 elevations (0,30,60
  deg), frames 64x128, albedo(premultiplied, alpha=coverage) + aux (tree-local normal, snow
  potential). Baked in one instanced draw per geometry (vertexNode places each view into its frame).
- Snow: per-fragment coverage = f(effective snow, potential); slabs of snow geometry on the upper
  side of every branch (thickness scales with snow); same function in the impostor shader.
- Rocks: 8 variants share one icosphere topology; per-variant positions/normals in a half-float
  DataTexture read with textureLoad(vertexIndex) -> all variants in one draw; nested icosphere LODs.
- Ground cover: toroidal grid of cells around the camera (no per-frame allocation), one geometry
  holding 4 item types (vertex collapse by instance type), one draw.

## Remaining (priority order)
1. createForestSystem(engine, world): GfxSystem ('forest') in src/gfx/forest/index.ts
2. Bench dev/forest.html + dev/forest.ts
3. Shots in all views / lights / backends, polish

## Decisions / API facts
- World: 32.2k trees (pine 16.4k, fir 10.6k, sapling 4.4k, snag 0.8k); scale pine/fir 0.45-1.54,
  sapling 0.16-0.40, snag 0.55-1.0. Densest: ~820 trees within 80 m, ~150 within 32 m.
- Bench spots (seed 417): dense forest near cabin (-446,194); snag cluster (-480,200) (13 in 40 m);
  clearing (-400,20); forest edge looking upslope from (10,190) (north).
- r187 shadow pass: override material takes positionNode, colorNode.a and alphaTest from the material
  (Renderer._getShadowNodes); onBeforeShadow/onAfterShadow are called around each shadow draw.
- RenderObject.getDrawParameters: InstancedBufferGeometry -> geometry.instanceCount (0 = no draw).

## Test commands
(none yet)
