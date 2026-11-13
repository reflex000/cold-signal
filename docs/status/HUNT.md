# HUNT status (wolves + tools, milestone M3)

Owner files: src/sim/systems/wolves.ts, tools.ts, wolves.test.ts, tools.test.ts, tools/scenarios/hunt.mjs,
HUNT lines in src/sim/systems/index.ts. May extend src/sim/entities.ts, testworld.ts; optional members in
src/sim/types.ts. Small alignment edits allowed in src/game/focus.ts, hudmodel.ts, input.ts (list them).

## Done
- tools.ts, wolves.ts written; registered in index.ts (tools after items, wolves after thermal); tsc clean.
- types.ts: optional PlayerEnt.beam; entities.ts makePlayer sets beam: 0.
- tools.test.ts: 11 tests pass (flashlight drain/dim/swap, rifle reload/bolt/ammo, hit/miss/wall, sway,
  flare arc/drag/wind/burn/removal, radio crank/lobe/nearest part/tower, axe on wolf, leave with rounds).
- AI tuned with traces (night: stalk ~25 s, circle, 2 feints, charges ~every 8 s; day: circles, no charge;
  a pair: circled, not charged; a player in firelight: left alone; whiteout: close in).

- wolves.test.ts: 16 tests pass. Full `npx vitest run`: 217 pass (18 files).
- Cost: 16 wolves hunting 4 players ~0.10 ms/tick (test world and real world seed 417, loaded CPU).
  Optimizations: sqrt instead of Math.hypot, terrain height instead of groundAt away from floors (8 m
  floor grid), no iceAt off the lake, indoor volumes precomputed, only changed pack vars written back,
  packs not hunting and 400 m+ from everyone lie still, nothing runs with nobody alive.

- tools/scenarios/hunt.mjs: player out in the open, companion bot by the barrel; wake+howl, stalk, circle,
  charge (bot left alone), flare breaks it, rifle scatters, axe yelp (staged away from the flare: a burning
  flare makes the player safe, so a charge there aborts - correct). shots/hunt_01..08.jpg.
- hudmodel.ts (allowed alignment edit): hints for wolves near, radio crank, flare gun load, rifle aim, light.

## Remaining (priority order)
1. hunt.mjs green on WebGPU (axe beat fix being verified), then --backend webgl
2. final report

## Design decisions (keep in sync with the code)
- Tick order: ... wood, items, TOOLS, fire, thermal, WOLVES, vitals. Tools calls into wolves.ts (damageWolf,
  hearNoise, wolfRayHit); wolves.ts never imports tools.ts.
- Axe: the swing is wood.ts's act ('swing', SWING_TIME 0.8, lands at SWING_HIT 0.32). tools.ts looks one
  tick ahead: when the blade will land next tick and a wolf is in reach in front, it lands on the wolf now
  (swing event hit 'wolf', damage, stagger, yelp) and sets actT = SWING_HIT so wood skips that landing.
  Exactly one 'swing' event per swing.
- Acts owned by tools: 'shoot', 'reload', 'crank' (radio). Var 'tools.act.<id>' = tool code marks them as
  mine (OBJECTIVE may use 'crank' for the generator); an act whose tool left the hand is cancelled.
- Flashlight: lit only while held. Optional PlayerEnt.beam (0..1 output now; dims below 25 % charge).
  12 min of light per cell; 'reload' swaps in a 'cell'. F (toggleLight) takes it out of the pack.
- Rifle/flare gun rounds never invented: a rifle that leaves the pack (drop/give) unloads into 'ammo';
  on leave the loaded round(s) are set down as pickups.
- Flare: life stays 40 in flight, burns down after landing (flareLand), flareOut at 0, removed 10 s later.
- Radio: source = nearest LOST part (its pickup entity, else world.spawn.parts), the tower panel when
  none is lost. sig = lobe(facing) * closeness(distance) * charge factor.
- Wolves spawn when their pack wakes (not at init: sim.test counts entities after construction).
  Pack state in vars 'wolves.<field>.<pack>'; per wolf 'wolves.<field>.<id>' only while needed.
  'wolves.aw.<k>' = 1 once world pack k woke (tests set 'wolves.aw.0' to keep the test world's den asleep).
- A bite latches: the wolf stops a jaw's length (1.1 m) from the body and moves with it (it used to slide
  5 m past the player at gallop, out of the axe's reach). Knock-down = the bite takes the rest of the
  health through vitals hurt(), so the player is downed (chance 5 % healthy .. ~30 % badly hurt).
- Boldness +0.15 in the hold-out / rescue stages (OBJECTIVE calls rallyWolves at the call and the rotors).
- A burning flare (and a strong fire) makes a player safe: no charge is pressed home there.
- Debug actions (sim.debug): 'wolves' [x, z, n] a pack, awake and howling; 'wolvesWake'; 'wolvesRally' [x, z];
  'wolvesClear'.

## Test commands
- npx vitest run src/sim/systems/tools.test.ts src/sim/systems/wolves.test.ts
- npx vitest run   (everything)
- npx tsc --noEmit -p .
