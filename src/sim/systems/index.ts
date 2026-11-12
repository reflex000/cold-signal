// The simulation's systems, in tick order. A system is one file in this folder exporting one
// `System` object (see ../api.ts); adding one is an import and a line in SYSTEMS below.
//
// Order matters: each tick a system sees what the ones above it just did. The same order is used
// for `init` (new game), `join` (a player arrives), `leave` (a player goes) and for offering an
// Action, which goes to each system's `action` in turn until one returns true.
//
//    0  spawn      world spawn table -> entities (init only, no step)    spawn.ts
//                  first, so every later init hook already sees the wreck, the crates, the fires
//    1  env        clock, storm, wind, gusts, air temperature             env.ts
//    2  players    commands -> movement, footsteps, equip, starting kit   players.ts
//    3  ice        lake ice stress, breaking, falling in, climbing out
//    4  wood       the axe (chop dead wood) and heavy logs: carry, drag, release (sets carryPair)   wood.ts
//    5  items      focus + USE: pick up, open crates, consume, drop, give                           items.ts
//    6  tools      flashlight, flare gun and flares, rifle, radio (the axe is wood's)
//    7  fire       build, ignite, feed, burn, wind and snow                                          fire.ts
//    8  thermal    shelter, wind chill, wetness, hunger, core temperature                            thermal.ts
//    9  wolves     packs, moods, attacks
//   10  vitals     health, falls, downed, bleed-out, revive, death, respawn, checkpoints, isolation  vitals.ts
//   11  objective  parts, panel, generator, transmit, helicopter, stages
//
// Movement (players) runs before anything that reacts to where people are standing, so ice,
// fire warmth and wolves all see this tick's positions.
// Owner: SIM (the survival lines: SURVIVAL).
import type { System } from '../api';
import { env } from './env';
import { fire } from './fire';
import { items } from './items';
import { players } from './players';
import { spawn } from './spawn';
import { thermal } from './thermal';
import { vitals } from './vitals';
import { wood } from './wood';

export const SYSTEMS: System[] = [
  spawn,
  env,
  players,
  wood,
  items,
  fire,
  thermal,
  vitals,
];
