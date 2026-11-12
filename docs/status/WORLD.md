# WORLD — handoff note

Module: the deterministic seeded mountain. Owner files: `src/world/**` except `src/world/types.ts`
(frozen contract), and `tools/world-map.mjs`.

## State (update after every step)

Everything in scope exists, type-checks (`npx tsc --noEmit -p .` clean) and the 13 tests pass.
createWorld(417) takes ~1.4-1.6 s on this machine while the CPU is at 100 % from other agents.

- [x] dmath.ts — deterministic sin / cos / atan / atan2 (only + - * / sqrt floor): every JS engine builds the same world
- [x] fastnoise.ts — table gradient noise (gradient table now via dmath)
- [x] layout.ts — places (PLACES with target altitudes), ramp profile, lake outline, ravine line + floor profile,
      side gully, cliff band line / height / couloirs, ridge line, plateaus (bench, cirque floor), shoulder spur
- [x] blueprints.ts — structure data, sites, placeBlueprint / placeSite (previous engineer; now uses dmath)
- [x] erosion.ts — MFD drainage area + implicit stream power + diffusion on the 257² coarse grid, hardness mask
- [x] terrain.ts — coarse macro shape -> erosion -> Catmull-Rom upsample -> 4 m wall grid -> 2 m detail and sharp
      features (ravine, gully, cliff band with strata/buttresses/V couloirs/scree fans, cirque + level lake) -> pads
- [x] route.ts — A* (4 m grid, 16 moves, grade limit 0.47) per leg, pulled straight (short chords), Chaikin,
      carved as a graded track (flat 3.6 m core, blend to 10 m, grade <= 0.5), trail mask, ~20 m waypoints
- [x] fields.ts — wind lee / exposure / hollows (8 m), masks RGBA (forest, rock, ice, trail), snow depth grid
- [x] scatter.ts — trees (jittered grid + min distance, ~32k), rocks (~10k, talus, outcrops, erratics, ravine blocks)
- [x] structures.ts — sites, skid scar wreckage, trail markers (60-90 m; 16 m on the ice), fence posts, signs
- [x] collide.ts — spatial hash (4 m CSR), near / inside / ray (DDA) + floor rays
- [x] lake.ts — 4 m ice grid: thick shores + safe line + hut, thin inlet / outlet / 4 seeded patches
- [x] spawn.ts — fixed loot on blueprint anchors, devices, fires, parts, 400 sticks, 150 wood, 13 heavy logs, packs
- [x] index.ts — createWorld + every World query; returns WorldEx (extras: anchors, trail, safeLine, thinIce, stats)
- [x] world.test.ts — determinism, flat places, walkable route, spawn validity, counts, parts, level lake,
      sealed edges (flood fill), collision / sight, floors / shelter, other seeds
- [x] tools/world-map.mjs — shots/world_map.png + shots/world_profile.png

## Remaining (priority order)

1. Look/polish: the rock step (riegel) under the lake is still one long dark band; the open slopes between the
   cliff band and the ridge are plain (knolls, scoured rock, boulders only).
2. Speed on phones (not measured): the 2 m terrain pass, fields and the route A* are the big costs (the map
   tool prints the time of every step).
3. The south cliff is 15-40 m: the sim should apply fall damage on 'land' (HurtCause 'fall').

## Lead feedback handled

- N-S streaks: single-direction drainage replaced by multiple-flow-direction area (erosion.ts); ribs warped.
- Square frame: W/E/N are mountainsides whose foot wanders ~100 m (soft-limited so faces are unclimbable by
  ~780 m) with spur ridges, buttresses, couloirs and peaks beyond; S is an irregular cliff + valley + far side.
- Seam at x = -50: the cliff-band uplift now tapers smoothly and fades northward.
- Cliff band: meandering foot, varying height, buttresses, V-shaped couloirs widening into funnels, scree fans.
- Trees: 32k (density lowered evenly).

## Decisions and API facts a successor needs

- Grids: `data[j * n + i]`, x = -extent + i * cell, z = -extent + j * cell (row = z), n 1025, cell 2 m, extent 1024.
  Masks RGBA8 interleaved: R forest, G bare rock, B lake ice (anti-aliased, > 127 = on the ice), A packed trail.
- heightAt over the lake returns exactly `lake.level` (the ice IS the terrain surface there); the ground is also
  level for a 2.9 m strip round the shore so every ice point is exactly level.
- slopeAt = slope angle / 90 degrees (linear in angle). WALK_SLOPE 40/90. walkable = inside ±798, slope < 40°,
  not inside any collider footprint (trees, rocks, walls, furniture).
- groundAt steps up 0.5 m onto floors (STEP_UP; more than move.ts's 0.4 so a too-high floor reads as a wall).
- Yaw: props / anchors / floors / shelters / box colliders use three.js rotation.y (front = (sin yaw, cos yaw)).
  spawn.players[].yaw is a PLAYER yaw (0 looks north): anchor yaw + PI.
- Tree and rock objects double as their own circle colliders (extra fields s, r, y0, y1); saplings and small rocks
  have r = 0 and are not in the collision index.
- RockInst sx/sy/sz are half extents in metres of a unit rock (radius 1); y is the ground at its centre.
- The five radio parts are pickups in spawn.defs (item 'part_*') AND listed in spawn.parts at the same positions:
  do not spawn them again from spawn.parts.
- Edges: W/E/N are mountainsides rising beyond a wandering foot (steep by ~780 m); S is an irregular cliff where
  the forest ends, a valley strip below joined to the ravine mouth (no pit), and the far side rising as a cliff.
  Nothing a player can slide into is a dead end.
- Anchors (WorldEx.anchors): 'poi:part.anchor', e.g. 'cabin:cabin.stove', 'tower:shed.panel', 'wreck:site.spawn0'.

## Test commands

- `npx vitest run src/world` — world tests (~6 s)
- `node tools/world-map.mjs [seed]` — writes shots/world_map.png and shots/world_profile.png, prints places,
  counts, route slope and the time of each build step

## Final report

**Files** (src/world unless noted): index.ts (createWorld + queries), terrain.ts, erosion.ts, route.ts, fields.ts, scatter.ts, structures.ts, collide.ts, lake.ts, spawn.ts, dmath.ts, layout.ts, fastnoise.ts, blueprints.ts, world.test.ts; tools/world-map.mjs.

**API**: `createWorld(seed: number, onProgress?: (p: number, label: string) => void): WorldEx` implements every World member. `WorldEx` (exported from src/world/index.ts; types.ts untouched) adds `anchors: Record<string, Pose>` ('cabin:cabin.stove', 'tower:shed.panel', 'wreck:site.spawn0'...), `trail` (dense route polyline), `safeLine`, `thinIce`, `stats`. index.ts re-exports `BLUEPRINTS, SITES, blueprint, placeBlueprint, placeSite`.

**Conventions**: grids `data[j*n+i]`, x = -1024 + 2i, z = -1024 + 2j; masks RGBA = forest, rock, lake ice, trail. heightAt on the lake = lake.level exactly (the ice is the terrain surface). slopeAt = angle / 90 deg. Props, anchors, floors, box colliders use three.js rotation.y; spawn.players[].yaw is a player yaw. Tree and rock objects are their own circle colliders (extra s, r, y0, y1). The five parts are pickups in spawn.defs AND listed in spawn.parts at the same positions: do not spawn them twice. groundAt steps 0.5 m onto floors. All generation math is deterministic across JS engines (dmath).

**Places (x, z, altitude)**: wreck (-120, 520) 122 m; tail (270, 380) 133 m, ravine floor; cabin (-430, 130) 212 m; lake / hut (190, -40) 262 m, ice; cave (-310, -290) 322 m; camp (480, -330) 366 m; tower (40, -610) 431 m. All on level pads.

**Seed 417**: route 3.82 km, 281 waypoints, steepest 26 deg; 32.2k trees (2.6 % snags), 9.9k rocks, 146 props, 612 defs (402 sticks, 151 wood, 13 heavy logs, 20 matches, 14 rounds, 7 flares). createWorld 1.4-1.6 s measured with the CPU at 100 % from other agents. 13 tests pass (`npx vitest run src/world`); tsc clean.

**Edges**: W/E/N rise as cliff-banded mountainsides, unclimbable by about 780 m; S is an irregular cliff where the forest ends, a valley strip below joined to the ravine mouth (no dead-end pit), then the far side rising. Flood fill: reachable x -740..748, z -762..796.

**Unsure / for others**: the sim should apply fall damage on 'land' (the south cliff is 15-40 m). Phone build time not measured. The rock step under the lake still reads as one long dark band.
