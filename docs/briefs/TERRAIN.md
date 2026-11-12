# Brief: TERRAIN (milestone M1)
(Read docs/briefs/COMMON.md first. Ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and on reading narrowly: your module is new.)

YOUR MODULE: TERRAIN. Files you own: src/gfx/terrain/**, dev/terrain.html, dev/terrain.ts. You may append
uniforms to src/gfx/shared.ts (append only; re-read it right before editing, others append too).
Read first: docs/status/WORLD.md (heightmap and mask layout, places), docs/status/ENGINE.md and
docs/THREE_NOTES.md (verified renderer facts, post API, shadows), src/gfx/shared.ts, src/gfx/api.ts, dev/bench.ts.

Deliver `createTerrainSystem(engine: Engine, world: World): GfxSystem` (name 'terrain') in
src/gfx/terrain/index.ts. The game adds it; nothing else draws the ground.

1. Geometry: the whole heightmap (2048 m square, 2 m cells) with continuous level of detail around the camera:
   a geometry clipmap or a chunk quadtree with morphing or skirts, no cracks, no visible popping. Heights sampled on
   the GPU from one texture of world.heightmap (one upload) so one small grid mesh serves every ring; normals from
   central differences. Within about 60 m of the camera refine below 2 m (bicubic plus small noise) so drifts and
   footprints have shape. Check float-texture filtering on the WebGL2 backend (fallback: manual bilinear, or heights
   packed into RGBA8). Beyond the heightmap the land continues: a ring of low-detail mountains generated
   deterministically from the seed out to about 6 km, so the horizon is mountains, never an edge.
2. Material (TSL node material, fog = true, receives shadows). Snow fills most of the screen: make it look
   photographed. Very bright but never clipped; blue in shade, warm in low sun; stable micro-sparkle at grazing
   sun angles fading with distance; fine wind-crust normals and larger sastrugi ripples along the prevailing wind;
   slightly darker hollows from a cheap curvature term. Rock on steep slopes and where masks.G says (near-black,
   strata following the slope, snow caught on ledges: snow wins on flatter normals inside rock areas). Lake ice
   (masks.B): dark blue-black clear ice with cracks and wind-polished patches, drifts over parts of it, thin ice a
   little greyer (bake world.lake.thickness into a texture). Trail (masks.A): packed, slightly darker, smoother.
   Blend by noise, never straight lines; no shimmer, no visible tiling (multi-scale or stochastic blending).
   Snow deformation hook: read U.trailTex / U.trailOrigin / U.trailSize / U.trailOn; where R > 0 lower the surface
   near the camera and use a compressed-snow look. The real trail painter comes in M6: prove the hook in your bench
   with a tiny test painter that stamps footprints into a canvas texture, on both backends.
3. Shadows: the terrain receives and casts sun shadows. Ridges shading valleys at low sun matters a lot: add a
   baked terrain-shadow (horizon) term for the sun direction, rebuilt at low resolution when the sun has moved
   enough, so distant ridges cast shadows beyond the shadow-map distance.
4. Performance: at 'medium' 1080p on this Intel Arc the terrain alone under 2.5 ms GPU; a handful of draw calls;
   quality.terrainDetail (0..3) and quality.viewDistance drive it and setQuality works at run time; 'mobile'
   uses coarser rings and a simpler material (no sparkle, fewer noise taps).
5. Bench dev/terrain.html on createBench({ ground: false }) with createWorld(417): ?view=wreck|tail|cabin|lake|
   cave|camp|ridge|aerial (camera 1.7 m above the ground at a place from world.pois, looking at something
   worth seeing), ?light=day|dusk|night|storm, ?q=, ?webgl=1, ?wire=1, ?prints=1. Shoot every view in day and dusk,
   storm and night once, on WebGPU, with --backend webgl and with --mobile 1. The sky is the bench's gradient until
   ATMOSPHERE lands (being written in parallel): judge the ground, not the sky. Read every shot and judge it
   harshly against DESIGN.md section 2: is this a photograph of snow on a mountain? Iterate.

STATE ON DISK: nothing of yours exists yet. Create docs/status/TERRAIN.md first and keep it current.
