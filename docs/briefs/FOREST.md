# Brief: FOREST — trees, rocks, ground cover (milestone M1)
(Read docs/briefs/COMMON.md first. Ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and on reading narrowly: your module is new.)

YOUR MODULE: FOREST. Files you own: src/gfx/forest/**, src/models/nature/** (if you build rocks or snags with the
kit), dev/forest.html, dev/forest.ts.
Read first: docs/status/WORLD.md (TreeInst, RockInst, treesIn, kinds, snow load), docs/status/KIT.md and the
header of src/models/kit.ts (the model toolkit and the shared prop material with snow cover: reuse it where it
fits), docs/status/ENGINE.md, docs/THREE_NOTES.md, src/gfx/shared.ts.

Deliver `createForestSystem(engine, world): GfxSystem` ('forest') drawing world.trees (about 32k) and
world.rocks (about 10k), plus ground cover.

1. Trees that read as real subalpine spruce and fir under snow: a straight barked trunk, whorls of drooping
   branches shortening to a narrow spire, needles as dense alpha-tested foliage (needle textures generated in
   code), heavy snow lying on the upper sides of branch layers as white masses with thickness (amount from
   TreeInst.snow), some trees half buried, saplings poking out of the snow, snags as dead grey trunks with broken
   tops. 6 to 8 variants per kind. Silhouettes matter most: from 50 to 300 m the forest is dark spires with white
   loads.
2. Wind in the vertex shader from U.windDir, U.windSpeed, U.gust: stiff trunk, whole-tree sway, branch bounce.
3. Level of detail: full mesh near (quality.treeNear), simplified mid, impostors far (multi-view billboard atlases
   with albedo and normal baked at load with the real renderer; keep the bake under about 2 s on desktop),
   dithered crossfades, instanced by chunk with culling. Near trees cast real shadows; far trees cheap or none.
   quality.treeDensity thins evenly. Under about 60 draw calls for the forest at 'medium'.
4. Rocks: instanced boulders and outcrops from world.rocks (a few procedural variants with chips and strata, near
   black, snow caps on top surfaces), scaled by sx, sy, sz and sunk into the ground.
5. Ground cover around the camera (quality.groundCover): twigs, small stones, dry grass tufts and shrub tips through
   the snow, sparse, placed by a deterministic hash with no per-frame allocation, not on the trail or the ice.
6. Collision is not yours (World handles it).

Budget at 'medium' 1080p on this Intel Arc: forest + rocks + ground cover under 4 ms GPU in the densest view.

Bench dev/forest.html on createBench({ ground: false }) with createWorld(417) and, in the bench only, a coarse
terrain mesh of your own from world.heightmap with a plain white material (TERRAIN is being written in parallel):
?view=forest (dense forest near the cabin) | edge (forest edge looking upslope) | aerial (300 m up over the
slope) | clearing | snags, ?light=day|dusk|night|storm, ?q=, ?webgl=1, ?wind=0..25, ?lod=1 (tint by LOD).
Shoot each view in day and dusk on WebGPU, --backend webgl and --mobile 1. Read every shot and judge harshly: a
real snowy conifer forest at every distance? Popping, tiling, clones in a row? Iterate.

STATE ON DISK: nothing of yours exists yet. Create docs/status/FOREST.md first and keep it current.
