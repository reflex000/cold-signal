# WORLD — handoff note

Module: the deterministic seeded mountain. Owner files: `src/world/**` except `src/world/types.ts`
(frozen contract), and `tools/world-map.mjs`.

## State (update after every step)

- [x] blueprints.ts (structure data, sites, placeBlueprint / placeSite) — from the previous engineer, sound
- [x] fastnoise.ts, layout.ts — from the previous engineer
- [ ] dmath.ts — deterministic sin / cos / atan2 (only + - * / sqrt floor), so every JS engine builds the same world
- [ ] terrain.ts + erosion.ts — heightmap
- [ ] route.ts — A* route + trail carving
- [ ] fields.ts — slope, lee / exposure, masks, snow depth
- [ ] scatter.ts — trees, rocks
- [ ] structures.ts — placed sites, props, debris, markers
- [ ] collide.ts — spatial hash, collidersNear, raycast, lineClear
- [ ] lake.ts — ice grid
- [ ] spawn.ts — defs, players, packs, parts
- [ ] index.ts — createWorld
- [ ] world.test.ts
- [ ] tools/world-map.mjs

## Plan / decisions

- Heightmap layout: `data[j * n + i]`, x = -extent + i * cell, z = -extent + j * cell (row = z), n 1025, cell 2 m.
- heightAt over the lake returns exactly `lake.level` (the ice surface is the terrain surface; mask B marks it).
- slopeAt = slope angle / 90 degrees (linear in angle). WALK_SLOPE 40/90.
- Tree objects double as their own circle colliders (extra fields s, r, y0, y1) so there are no per-tree collider objects.

## Test commands

- `npx vitest run src/world` — world tests
- `node tools/world-map.mjs [seed]` — writes shots/world_map.png and shots/world_profile.png
