# STRUCTURES — handoff note

Module: the wreck and every place on the mountain (M4). Brief: docs/briefs/STRUCTURES.md.
Owned files: src/models/structures/**, src/models/wreck/**, new props in src/models/props/ (do not rewrite
KIT's nine), dev/places.html, dev/places.ts, one registration change in src/game/visuals.ts,
tools/scenarios/places.mjs (own collision-walk scenario).

## Status
- [x] Read contracts (kit.ts, blueprints.ts, KIT.md, WORLD.md, LOOK.md, standin/structures.ts, instances.ts)
- [x] Models (17, all named by src/world): wreck/ fuselage, tail_section, wing, engine_nacelle, seat_row,
      debris_panel; structures/ cabin, woodshed (sheds.ts), fishing_hut (sheds.ts), cave_rocks, tent_torn +
      survey_mast (camp.ts), tower_mast + tower_shed + generator (tower.ts), fence_post + sign_post (posts.ts).
      All build, tsc clean. (crate, barrel, luggage, trail_marker are KIT's.)
- [x] src/models/structures/drive.ts: GfxSystem 'structures' driving parts from f.view (doors, crank, slots, glow)
- [x] Bench dev/places.html
- [x] Registration in src/game/visuals.ts: static import of createStructureDriver from '../models/structures'
      (registers all models) + `engine.add(createStructureDriver(structures.props))` after the props system.
- [x] Collision walk: tools/scenarios/places.mjs walks into every collider face near every site (135) and through
      every door, raycasts the drawn triangles: 0 mismatches, doors pass, console clean (after fixes to the cave
      walls/caps/portal, tail stubs, nose length, seat recline, cabin chair + sill, tent eaves 1.2).
- [x] Visual review (bench + game tour). Fixed: shed roof sloped backward (sky gap), shed/cabin eave and board
      gaps leaking light, tent roofs flat (ridge now 1.95), cave read as a bunker (joints, grooves, weathering,
      blocky top), cave outer mass had no snow, cabin logs too orange/uniform, fuselage break (crush, holes,
      pale primer, spilled floor/cables/cushion, ploughed snow at the nose).
- [x] tour.mjs passes on WebGPU, WebGL2 (--backend webgl) and --mobile 1; no console output from these modules.
- Remaining polish ideas (not blockers): the fuselage break still reads as a round tube end-on from 20 m; the
  installed radio modules are small on the panel; tents could flap more; cave sides are straight walls (they
  must stand on the box colliders).

## Progress log
- wreck/: hull.ts (surface/holePatch/loft helpers, hull map, livery, seatUnit), fuselage.ts (35.7k tris, ~0.8 s
  build), tail.ts (9.7k), wing.ts (2 variants, 3k), nacelle.ts (2 variants), debris.ts (seat_row 4 v, debris_panel
  4 v) — all build, tsc clean. structures/: lib.ts, drive.ts (driver + applyStructureState), index.ts.
- dev/places.html/.ts bench works (shot.mjs). Bench lighting has no ground bounce: shaded sides read too dark
  there; judge final tone in the real game.
- Build-time rule learned: never merge big shells into one part (its AO near-list becomes every part);
  keep 1-2 m segments as separate ghost parts (fuselage bake 1.2 s -> 0.35 s). Default pillow() is ~600 tris:
  always pass seg/ring.

## Plan / design decisions
- Models register under the plain names; GAME's standin/structures.ts then uses them automatically
  (hasModel(p.model)). Blueprint numbers are copied from src/world/blueprints.ts (import BLUEPRINTS where useful).
- Curved shells (fuselage skin, tail cone, cave shell) are ghost() parts: the kit's box-proxy AO would black out
  everything inside them. Interiors get their darkness from lib.roomLight(): per-vertex occlusion multiplier from
  form factors of the openings (break, door, windows), so insides read dark by day except near openings.
  Interior parts are inked snow: 0.
- Named parts: cabin 'door' (hinged; the only part with openAngle so setOpen() = door), 'glow' (window light,
  driver shows it when the stove burns), 'cupboard_door'; fishing_hut 'door'; tower_shed 'door', 'locker_door',
  'slot_battery|handset|coil|tube|fuse' (installed modules, hidden until installed), 'panel_lights';
  generator 'crank' (axis +Z), 'needle'; tower_mast 'lamps', 'beacon'; fuselage 'locker_door'.
- Fuselage: outer skin circle R 1.8 centred y 1.22 (belly buried 0.58 m) so the floor (y 0.36, |x| 1.56) fits;
  vertical dado panels at |x| 1.565 up to y 0.62 stand on the hull collider face; nose tip z 9.0. Low-wing twin turboprop (Saab 340-like), over-wing exit on +X.
- Tower guy anchors kept on the site pad: NW (-6.4,-9.4), NE (6.4,-9.4), S (1.5, 9.5) in mast-local coords.
- Survey mast: standing guyed pole (matches its post collider) + a fallen antenna section lying beside it.

- Big structures bake with build({ aoRadius: 0.15..0.2 }) (default 0.3 cost 2-3x the time for nothing visible).
- Bench (dev/places.ts) adds stand-in lights: 'fire' emitters, a stove light at every 'stove' anchor (the stove is a
  FireEnt in the game), 'light' emitters (powered ones need &charge>0, the lantern needs fire). Game lights are FX's.
- Driver also swings a 'door' open while any player is within 1.2 m of the model's 'door' anchor (no sim system
  toggles door devices yet; the doorways are open gaps in the colliders).

## Test commands
- `npx tsc --noEmit -p . 2>&1 | grep -E "src/models/(wreck|structures)|dev/places"`
- build stats: `node <scratchpad>/measure.mjs fuselage cabin ...` (Vite ssrLoadModule; prints ms, bake ms, tris)
  — script text is easy to recreate: createServer({root, server:{middlewareMode:true, watch:null}}), ssrLoadModule
  registry + '/src/models/structures/index.ts', getModel(name, seed).
- bench: `node tools/shot.mjs "dev/places.html?place=cabin&view=out&light=dusk" --out pl_cabin --w 1280 --h 720`
  views: out | honest | in | back | top; &open=1 &installed=5 &charge=1 &beacon=1 &fire=0|1 &snow=0..1
- game: `node tools/play.mjs tools/scenarios/tour.mjs` (+ --backend webgl, --mobile 1)
- collision: `node tools/play.mjs tools/scenarios/places.mjs [--query "only=cave"]` (prints site-local face, box,
  gaps knee/waist/eye/top/mid; accepted by design: open seat/table fronts, guy ropes, the crank handle)

## Final report

**Files.** src/models/wreck/{hull, fuselage, tail, wing, nacelle, debris, index}.ts; src/models/structures/{lib, drive, cabin, sheds, cave, camp, tower, posts, index}.ts; dev/places.html + places.ts; tools/scenarios/places.mjs; src/game/visuals.ts (static import from '../models/structures' + `engine.add(createStructureDriver(structures.props))` after the props system).

**Models**, registered under the world's names, so GAME's stand-ins give way automatically: fuselage (36.9k tris), tail_section (9.7k), wing (2 variants: upright / upside down), engine_nacelle (2), seat_row (4), debris_panel (4), cabin (38.2k), woodshed, fishing_hut, cave_rocks, tent_torn (3; variant 2 half collapsed), survey_mast (plus a fallen antenna), tower_mast (36.1k: 30 m guyed lattice and deck), tower_shed (19.6k), generator, fence_post (4), sign_post (4). Walls, floors and furniture follow blueprints.ts. Interiors are darkened from the size of their openings.

**API.**
- `createStructureDriver(props: PropsSystem): GfxSystem` ('structures'). It drives:
  - `door`: from DeviceEnt progress/on, and while a player stands in the doorway.
  - `locker_door`, `cupboard_door*`: from CrateEnt `open`.
  - `slot_<part>`: shown when `objective.parts[part] === 'installed'`.
  - `panel_lights`; `crank` (objective.generator, `CRANK_TURNS` 40); `needle`; `lamps` (flash once charged); `beacon` (DeviceEnt beacon on); `glow*` (stove FireEnt lit).
- `applyStructureState(props, Partial<StructureState>)` for benches.
- Anchors: every blueprint anchor, plus tower_shed `slot_battery|handset|coil|tube|fuse`, tail `elt`, nacelle `hub`. `PANEL_SLOTS` is exported from tower.ts.
- Emitters: `smoke` at the cabin chimney and the hut stovepipe (`source: 'stove'`); `light` (cabin lantern; shed lamp `powered: true`); `beacon` (four `lamp_red`, the deck `strobe`).

**Contract additions:** none.

**Verified.** tools/scenarios/places.mjs walks into all 135 collider faces at the sites and through the 3 doors, raycasting the drawn triangles: 0 mismatches. tour.mjs passes on WebGPU, WebGL2 and --mobile 1, with no console output from these modules.

**Open / for others.**
- GAME standin/markers.ts still draws boxes for door, panel, generator and bed devices and for locker and cupboard crates, on top of the built-in ones. It should skip those types.
- FX: read `smoke` emitters with `source: 'stove'` for chimney smoke, and the `light` and `beacon` emitters.
- All structures together take about 4 to 5 s to build on this machine (fuselage about 1 s, cabin about 1.1 s).
- Accepted by design: seat and table fronts are open while their colliders are solid boxes. End-on, the fuselage break still reads as a round tube.
