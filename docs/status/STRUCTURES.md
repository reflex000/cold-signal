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
- [ ] Shots + fixes (bench + real game tour), collision walk scenario tools/scenarios/places.mjs
- [ ] Polish list: cabin logs too orange/uniform; fuselage break reads dark; check every place in the game.

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
- Fuselage: outer skin circle R 1.8 centred y 1.45 (belly buried), vertical dado panels at |x| = 1.56 to match
  the hull collider at the floor. Low-wing twin turboprop (Saab 340-like), over-wing exit on +X.
- Tower guy anchors kept on the site pad: NW (-6.4,-9.4), NE (6.4,-9.4), S (1.5, 9.5) in mast-local coords.
- Survey mast: standing guyed pole (matches its post collider) + a fallen antenna section lying beside it.

## Test commands
- `npx tsc --noEmit -p . 2>&1 | grep -E "src/models/(wreck|structures)|dev/places"`
- build stats: `node <scratchpad>/measure.mjs fuselage cabin ...` (Vite ssrLoadModule; prints ms, bake ms, tris)
  — script text is easy to recreate: createServer({root, server:{middlewareMode:true, watch:null}}), ssrLoadModule
  registry + '/src/models/structures/index.ts', getModel(name, seed).
- bench: `node tools/shot.mjs "dev/places.html?place=cabin&view=out&light=dusk" --out pl_cabin --w 1280 --h 720`
  views: out | honest | in | back | top; &open=1 &installed=5 &charge=1 &beacon=1 &fire=0|1 &snow=0..1
- game: `node tools/play.mjs tools/scenarios/tour.mjs` (+ --backend webgl, --mobile 1)
