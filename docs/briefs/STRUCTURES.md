# Brief: STRUCTURES — the wreck and every place on the mountain (milestone M4)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: STRUCTURES. Files you own: src/models/structures/**, src/models/wreck/**, new props you need in
src/models/props/ (add, do not rewrite KIT's nine), dev/places.html, dev/places.ts, and ONE registration change in
src/game/visuals.ts that swaps the blueprint stand-ins for your models (re-read the file right before editing;
others add their own line at the same time).
Read first: docs/status/KIT.md and the header of src/models/kit.ts (the Builder, PAL, MAT, emitters, anchors,
parts; build every model with it so the prop material, snow cover and instancing work), src/world/blueprints.ts
and docs/status/WORLD.md (every structure's footprint, walls, door gaps, floors, anchors: the walls you build must
be the walls the player collides with, exactly), docs/status/LOOK.md (blueprint stand-ins), DESIGN.md sections 1-2.

Build, as photographed objects, not primitives:
- The wreck of Flight 417, a twin-turboprop regional airliner: the fuselage broken open at the wing root
  (walkable floor inside, torn skin, ribs and stringers at the break, seat rows, overhead bins hanging, a cockpit
  with crazed glass), a wing torn off lying in the snow, an engine nacelle with bent propeller blades, debris panels
  and luggage strewn along the skid scar, the tail section in the ravine with the fin and the ELT bay.
- The ranger cabin: log walls with notched corners, a metal roof with a deep snow load and icicles, a porch, a
  door that opens (part 'door'), small windows with warm light when the stove burns, interior with the iron stove
  and its pipe, bunk bed, table and chairs, shelves, a lamp; the woodshed beside it.
- The ice-fishing hut on the lake: a small plywood shack on runners, a stovepipe, a hole in the floor.
- The cave: a mouth in the cliff band and a chamber built from rock geometry matching the blueprint, with a
  survey cache (crates, a tarp) inside and old bones near the den.
- The survey camp: two torn expedition tents flapping (sway), crates, a fallen antenna mast with guy wires.
- The signal tower: a steel lattice mast (tens of metres, guyed), the equipment shed with its door, the panel
  inside (named anchors for the five part slots, parts 'slot_battery' ... with an installed state), the generator
  on its pad (part 'crank'), a small deck or landing pad marked for the helicopter, warning lamps.
- Fence posts, sign posts, trail markers along the route (KIT's trail_marker exists), anything else the
  blueprints name.
Triangle budgets per DESIGN.md section 6. Snow load from the material, icicles as geometry. Emitters for the stove
smoke, chimney, lamps. Interiors must read in their own light (dark inside by day except windows and fire).

Bench dev/places.html: ?place=wreck|tail|cabin|hut|cave|camp|tower, outside and inside views, ?light=day|dusk|
night|storm, ?webgl=1. Shoot every place in two lights from a flattering and an honest angle, inside where there
is an inside, on WebGPU, WebGL2 and --mobile 1, in the bench and then in the real game (node tools/play.mjs
tools/scenarios/tour.mjs). Read every shot; judge harshly against a real photograph; fix scale, seating on the
terrain, collision mismatches (walk the player into every wall and through every door in a scenario of your own),
and anything cheap.

STATE ON DISK: nothing of yours exists. Create docs/status/STRUCTURES.md first and keep it current.
