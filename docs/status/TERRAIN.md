# TERRAIN status (handoff note)

Owner files: src/gfx/terrain/**, dev/terrain.html, dev/terrain.ts (+ append-only uniforms in src/gfx/shared.ts).

## Design (decided, being implemented)
- Geometry: CDLOD (Strugar) chunk quadtree over a 12288 m square (3 x 3 roots of 4096 m), one N x N grid
  mesh (+ skirts) drawn instanced; quarter nodes use an (N/2)^2 mesh. Per-vertex morph to the parent grid
  (2D distance + camera height above ground), height sampled after the morph. 4 draws: full/quarter x
  near (castShadow, within quality.shadowDistance, frustum + 30 m margin) / far (no shadow casting).
- Heights: world.heightmap uploaded once as R32F (textureLoad, manual bilinear / Catmull-Rom: R32F is not
  filterable on WebGL2 nor on WebGPU without float32-filterable). Catmull-Rom where cells < 2 m (exact at
  samples, so LOD joins stay crack-free), + small detail noise fading out by ~60 m.
- Far ring: a 513^2 R32F "far map" (24 m cells, +-6144 m) generated from the seed (ring.ts): inner square
  = box-filtered heightmap, outside = ridged mountains blended from the smoothed edge, crest ~3.5-4.6 km,
  falling behind the crest so the domain edge is never seen (engine FAR is 6000 m).
- Normal maps (RGBA8, mipmapped) baked on the CPU: RG normal xz, B curvature, A snow depth (inner) /
  forest-ish data (far).
- Horizon shadows: GPU pass (QuadMesh -> RGBA8 RT) marching the heightmap toward the sun azimuth; two
  slots (A/B) at bracketing azimuths blended by the current azimuth, inner 512^2 (4 m) + outer 256^2.
  Applied in a custom PhysicalLightingModel.direct() to directional lights whose azimuth matches.
- Material: MeshStandardNodeMaterial subclass; surface computed in setupDiffuseColor (colorNode stays
  null so the shadow pass stays depth-only); properties feed normalNode / roughnessNode / aoNode.

## Done
- (in progress) writing src/gfx/terrain/*.ts

## Remaining (priority order)
1. createTerrainSystem(engine, world) in src/gfx/terrain/index.ts, type-checks.
2. Bench dev/terrain.html + dev/terrain.ts with all views / lights / flags.
3. Material polish, horizon shadows, mountain ring, perf.

## Decisions / API facts
- three r187: FloatType textures are bound as unfilterable-float on WebGPU (no float32-filterable);
  textureLoad = texture().setSampler(false). Float textures need NearestFilter or WebGL2 makes them
  incomplete (texelFetch returns 0).
- material.colorNode non-null makes the shadow pass compile colorNode.a: avoided on purpose.
- ShadowNode: material.receivedShadowNode is only evaluated inside CSM cascades, so it cannot carry the
  horizon term beyond the shadow distance; LightsNode passes lightNode to lightingModel.direct().
- Prevailing wind (sastrugi): world/layout WIND_X, WIND_Z = (0.857, 0.515), toward ESE.

## Test commands
(none yet)
