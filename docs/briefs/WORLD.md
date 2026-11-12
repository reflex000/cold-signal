# Brief: WORLD
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: WORLD. Files you own: src/world/** except types.ts (frozen contract), tools/world-map.mjs.

Build export function createWorld(seed: number, onProgress?: (p: number, label: string) => void): World in
src/world/index.ts, implementing every member of World in src/world/types.ts. Pure and deterministic: the same
seed gives the same world on every machine; no three, no DOM, no Math.random, no Date.

The mountain (default seed 417; other seeds must also produce a playable world with the same places):
- Playable square 1600 m centred on the origin; the heightmap covers [-1024, 1024] on both axes at n = 1025
  (2 m cells) so the renderer has margin. Uphill is north (-Z). Altitude about 120 m at the crash site rising to
  about 430 m at the tower ridge, with higher ground and peaks toward the north edge and beyond.
- Shape it like a real mountain flank, by hand plus noise: a broad forested lower slope in the south; a
  ravine running down the east side (the tail section lies in it); a forested bench in the west (cabin); a
  cirque basin in the middle holding a frozen lake about 260 m across with a perfectly level surface; a cliff
  band across the upper west with a cave at its foot; an exposed, wind-scoured shoulder in the upper east
  (survey camp); a narrow ridge along the north with the tower on a levelled knoll. Use ridged noise, domain
  warping and a cheap erosion or terracing pass so slopes read as geology, not as smooth blobs. Flatten a pad
  under every structure. The edges of the playable square must be naturally impassable (cliffs, drop-offs,
  very steep slopes) so nobody walks out; walkable() is false outside.
- Places exactly per the table in DESIGN.md section 1 (coordinates are targets; snap y to the terrain and nudge
  a few metres if the ground demands it). Each Poi has a radius and a name.
- A walkable route: wreck -> tail -> cabin -> lake/hut -> cave -> camp -> tower must exist with slopes under
  about 35 degrees (carve gentle traverses and couloirs through the cliff bands where needed), written to
  world.route as waypoints roughly every 20 m and into the trail mask. Verify it with a test that walks the
  route checking slopeAt and walkable at 1 m steps.
- snowDepthAt: deep in forest hollows and lee slopes, thin on wind-scoured ridges and steep rock, zero on the
  lake ice, on floors and on steep cliffs. surfaceAt accordingly. forestAt: dense on the lower slopes and
  the bench, thinning with altitude, none on the lake, cliffs, ridge and the shoulder (tree line about 360 m).
- Trees: about 25 to 40 thousand, placed by forestAt with a blue-noise-like distribution (no grid look, natural
  clearings and clumps), kinds pine / fir / snag (dead standing, about 3 %) / sapling, scale and snow load varied,
  none inside structures, on the route's packed trail or on slopes over 40 degrees. A grid index for treesIn.
  Rocks: boulders and outcrops concentrated on cliff bands, the ravine, the shoulder and the ridge.
- src/world/blueprints.ts: pure data for every structure the player walks into or collides with, in the
  structure's local space (origin on the ground, +Z front): fuselage (a broken tube about 3.6 m wide, 18 m long,
  open at the break, floor inside), tail section, ranger cabin (about 6 x 5 m, one door, two windows, stove, bed,
  table, shelves), ice-fishing hut (2.5 x 2.5 m), cave (an enclosed rock chamber about 9 m deep with a 3 m
  mouth; it is built of rock meshes against the cliff, so give its wall boxes, floor and shelter volume),
  survey camp (two torn tents, crates, a mast), tower (lattice mast footprint, equipment shed 3 x 4 m with door,
  generator pad, deck). For each: wall boxes with door gaps, floors with surface type, shelter volumes
  (indoor flag and amount), and named anchors (door, stove, bed, table, shelf1.., loot spots, panel,
  generator, part location, bot stand points). Export the types and a function that places a blueprint at a Poi
  (position, yaw) and returns world-space colliders, floors, shelters and anchors. The model engineers will
  build the visible structures from this same data, so be precise and document each one with a small ASCII plan.
- props: PropInst list naming models that will exist in src/models (use these names: 'fuselage', 'tail_section',
  'wing', 'engine_nacelle', 'seat_row', 'debris_panel', 'luggage', 'cabin', 'woodshed', 'fishing_hut', 'cave_rocks',
  'tent_torn', 'survey_mast', 'crate', 'barrel', 'tower_mast', 'tower_shed', 'generator', 'trail_marker',
  'fence_post', 'sign_post') placed sensibly: a 200 m skid scar of debris leading to the fuselage, trail markers
  (tall poles with flags) along the route every 60 to 90 m so it can be followed in bad visibility, and so on.
- colliders (trees as thin cylinders, big rocks, structure walls) in a spatial hash for collidersNear; lineClear and
  raycast against terrain (march the heightmap) and colliders; shelterAt combining shelter volumes, terrain lee
  (sample upwind: is the ground upwind higher than here within 30 m), big rocks upwind, and forest canopy.
- lake: thickness grid (4 m cells): thick (0.5 m+) near the shores and along a safe line marked by poles to the
  hut, thin patches (under 0.12 m) especially near the inlet, the outlet and a few seeded spots. iceAt, iceCell.
- spawn: four player slots just outside the fuselage break; defs for everything the design needs: the barrel
  fire at the wreck, luggage and lockers with sensible loot, the tools where the table in DESIGN.md says, sticks
  ('pickup' stick, lie 'snow') scattered under trees (denser in forest; about 400 across the map), snags and
  deadfall ('wood') for the axe (about 150), heavy logs ('log') near the cabin woodshed and in the forest,
  the cabin stove ('fire' type 'stove', shelter 1), ammunition and flares in small amounts spread across places
  (the whole map holds about 14 rifle rounds and 7 flares), bandages, rations, a thermos, matches (scarce:
  about 20 in the whole world beyond the starting 6), tinder, devices (cabin door, tower panel, generator,
  notes). parts: where each of the five radio parts lies, per the design table. packs: four wolf packs (forest
  near the cabin, the cave den, the lake shore, the ridge) with wakeAt times that escalate over the hour.
- Speed: createWorld must finish in under 2.5 s on a desktop (measure it) and report progress. Keep memory sane
  for phones (typed arrays, no per-tree objects beyond the TreeInst list).

Tests (vitest): determinism (two builds with the same seed are byte-identical in heightmap and equal in lists),
every Poi stands on ground flatter than 12 degrees, the route is walkable, spawn defs are on walkable ground and
not inside colliders, parts exist for all five ids, the lake surface is level, the world edge is not walkable.
tools/world-map.mjs: render a top-down PNG (pngjs) to shots/world_map.png: hillshaded relief with slope tint,
forest, lake and ice thickness, route, POIs with labels drawn as simple marks, trees as dots, spawn items as
coloured dots; plus shots/world_profile.png, the altitude profile along the route. Read both images and iterate
on the terrain until it looks like a real mountain map with believable drainage, ridges and benches, and until
the places sit where a person would expect them. Report the final POI coordinates and altitudes.


STATE ON DISK (handoff note: docs/status/WORLD.md): src/world/fastnoise.ts, blueprints.ts (35 KB, the structure
data), layout.ts (4.6 KB). MISSING: src/world/index.ts (createWorld) and everything behind it: the heightmap, masks,
snow depth, forest, trees, rocks, props, colliders and spatial hash, shelter, raycast, lake ice, spawn tables,
parts, packs, route; the tests; tools/world-map.mjs. This is most of the module: get createWorld complete and
type-checking first, then the map tool and the tests, then iterate on how the mountain looks.
