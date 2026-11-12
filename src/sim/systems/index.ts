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
//    4  logs       heavy logs: carry, drag, release (sets carryPair)
//    5  items      focus + USE: pick up, open crates, consume, drop, give
//    6  tools      axe, flashlight, flare gun and flares, rifle, radio
//    7  fire       build, ignite, feed, burn, wind and snow
//    8  thermal    shelter, wind chill, wetness, core temperature, stamina limits
//    9  wolves     packs, moods, attacks
//   10  health     damage, downed, bleed-out, revive, death, respawn
//   11  objective  parts, panel, generator, transmit, helicopter, stages, checkpoints
//
// Movement (players) runs before anything that reacts to where people are standing, so ice,
// fire warmth and wolves all see this tick's positions.
// Owner: SIM.
import type { System } from '../api';
import { env } from './env';
import { players } from './players';
import { spawn } from './spawn';

export const SYSTEMS: System[] = [
  spawn,
  env,
  players,
];
