# TERRAIN status (handoff note)

Owner files: src/gfx/terrain/**, dev/terrain.html, dev/terrain.ts. No contract changes, nothing added to
src/gfx/shared.ts.

## State
Complete for M1. Type-checks clean; renders with a clean console on WebGPU, WebGL2 (--backend webgl) and
phone emulation (--mobile 1); setQuality() switches tiers at run time on both backends without errors.
Shot matrix done (shots/m_<view>_<light>.jpg, g_* = WebGL2, p_* = phone, ter_* = development shots).

Files (src/gfx/terrain/):
- config.ts   constants (domain +-6144 m, RING_OUTER 5400, far map 513^2 x 24 m, horizon map sizes),
              lodConfig(terrainDetail) [n, cell0, k], materialTier(q)
- ring.ts     far map: box-filtered heightmap inside, generated ring outside (summit massif N, ridges E/W,
              open valley below the ravine mouth, lower range S, falls away behind the crests);
              sampleHeightmap / sampleFar (CPU)
- data.ts     textures: height + far mip atlases (R32F, mipAtlas), normal maps (RGBA8: slope as
              0.5+atan/pi, curvature, snow depth / far forest), masks, lake thickness; MinMax pyramid
- noise.ts    tileable 256^2 detail (height + derivatives) and cell (Voronoi) textures
- height.ts   TSL heights: bilinear / clamped Catmull-Rom (level 0), heightLod (mip per LOD), UVs
- lod.ts      grid geometry with skirts, LodSelector (CDLOD into full/quarter x near/far lists)
- horizon.ts  HorizonMaps: GPU march -> 2 slots x (512^2 + 256^2) RGBA8, blended by azimuth
- material.ts TerrainNodeMaterial, TerrainLighting (horizon shadow, snow wrap, glints), TerrainSkyNode
- index.ts    createTerrainSystem

## Open items (priority order)
1. Perf not measured reliably: the GPU is saturated by other agents' browsers (timestamp queries go
   stale; synced frame timing swings 3x run to run). Relative probes: terrain cost does not drop at 1/4
   resolution, so it is vertex/draw bound; medium draws ~124k tris in 4 instanced draws (+ near nodes in
   each shadow cascade). If over budget on a quiet GPU: medium -> [16, 0.5, 3.0] in lodConfig, or a
   cheaper castShadowPositionNode.
2. ENGINE: GTAO (post.ts) prints dark dots along terrain silhouettes and a black line at the lake shore,
   and is applied after fog, so dots show through a storm (verified: gone with aoStrength 0; no holes with
   &holes=1; no visible skirts with &debug=6). Suggest fading AO with view depth and fog.
3. WORLD's cliff band has regular strata steps; bench snow breaks them up with face-plane noise, some
   regularity remains. Couloirs in the cliff read as sharp white spikes (heightmap geometry).
4. Trees / props do not receive the baked horizon shadow (only the terrain does). HorizonMaps.lit(xz, elev)
   could be exposed through U if FOREST/KIT want it.

## Decisions / API facts
- three r187: FloatType textures bind as unfilterable-float on WebGPU; textureLoad = texture().setSampler(false).
  Float textures need NearestFilter or WebGL2 treats them as incomplete (texelFetch returns 0).
- material.colorNode non-null makes the shadow pass compile colorNode.a: the surface is built in
  setupDiffuseColor instead; properties feed normalNode / roughnessNode / aoNode / sky occlusion.
- material.receivedShadowNode only runs inside CSM cascades; LightsNode passes lightNode to
  lightingModel.direct(): the horizon term lives there (DirectionalLight whose azimuth matches the maps).
- Horizon maps follow the brighter of ATMOS.sunColor / ATMOS.moonColor (dir from ATMOS.sunDir / moonDir).
- Detail texture: one 256^2 tile holds ~8 features (a tile of T m gives ~T/8 m). Taps pass explicit
  gradients so layers sit in If() branches (WGSL uniformity).
- Coarse LODs read mip-filtered heights blended by the morph factor: crack-free, no aliasing.
- Crack-free CDLOD needs k > 2.36 (morph from 0.8 r to r); skirts are a safety net only.
- Prevailing wind (sastrugi, drifts on ice): world/layout WIND_X, WIND_Z.
- The scratchpad is shared with other agents: TERRAIN's scripts are in scratchpad/terrain_wk/
  (ringmap.mjs relief + panoramas, tperf2.mjs synced perf probe, tquality.mjs tier switching, matrix.sh).

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/gfx/terrain|dev/terrain"
- node tools/shot.mjs "dev/terrain.html?view=camp&light=dusk&q=medium&t=3&frames=4" --out x --w 1280 --h 720
  --eval "window.ENGINE.frame = () => {}"   (the eval freezes rendering after DONE; with the GPU this busy
  page.screenshot otherwise times out). Add --backend webgl or --mobile 1.
- Bench params: view=wreck|tail|cabin|lake|cave|camp|ridge|aerial|map, light=day|dusk|night|storm, q=,
  webgl=1, wire=1, prints=1, perf=1, debug=1..6 (LOD, horizon, normals, masks, NaN, skirts), holes=1,
  x= z= up= yaw= pitch= fwd=, sparkle= detail= skirt=.

## Final report

**Files**: src/gfx/terrain/{index, config, ring, data, noise, height, lod, horizon, material}.ts; dev/terrain.html, dev/terrain.ts. No contract changes, nothing added to shared.ts.

**API**: `createTerrainSystem(engine: Engine, world: World): TerrainSystem` adds its group to engine.scene; the caller runs `engine.add(terrain)`. `TerrainSystem` extends GfxSystem (name 'terrain', update / setQuality / dispose) with `object: THREE.Group`, `heightAt(x, z): number` (the drawn ground, far ring included), `debug: number` (0..6), `wireframe: boolean` and `stats {nodes, tris, visited, horizonBuilds}`. `TERRAIN_U` holds the tuning uniforms (snowAlbedo, sparkle, detail, printDepth, debug, skirt). It reads U.trailTex / trailOrigin / trailSize / trailOn (R = press depth 0..1) and ATMOS sun / moon colour and direction; the horizon shadow is applied to whichever DirectionalLight matches that direction.

**What it does**: CDLOD over 12 km in 4 instanced draws, with morphing, skirts and mip-filtered heights per LOD. Cells are 0.25 m near the camera, using Catmull-Rom heights plus drift noise. A seeded mountain ring runs out to 5.4 km, kept inside the engine's far plane. The material covers snow (sastrugi along the wind, crust, glints, curvature hollows, subsurface wrap), rock (strata, ledges, triplanar), ice (cracks, polish, drifts, thin ice greyer), the trail and footprints. Shadows: near nodes cast into the shadow map, everything receives, and GPU-baked horizon maps shade valleys from distant ridges at any distance. terrainDetail picks the mesh density; viewDistance sets where small detail stops; mobile gets no sparkle and fewer taps. The footprint hook was verified on both backends.

**Unsure / for others**:
- Performance is not measured reliably, because the GPU is saturated by other agents. The cost looks vertex-bound; medium draws about 124k triangles.
- ENGINE's GTAO puts dark dots along terrain silhouettes and a black line at the lake shore, and it is applied after fog, so the dots show through a storm. It should fade with depth and with fog.
- WORLD's cliff strata are regular; the snow pattern breaks them up only partly.
- Trees and props do not receive the horizon shadow.
