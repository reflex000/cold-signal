// The simulation's systems, in tick order. A system is one file in this folder exporting one
// `System` object (see ../api.ts); adding one is an import and a line in SYSTEMS below.
//
// Order matters: each tick a system sees what the ones above it just did.
//
//    1  env        clock, storm, wind, gusts, air temperature        env.ts
//    2  players    commands -> movement, footsteps, equip             players.ts
//    3  ice        lake ice stress, breaking, falling in, climbing out
//    4  logs       heavy logs: carry, drag, release
//    5  items      focus + USE: pick up, open crates, consume, drop, give
//    6  tools      axe, flashlight, flare gun and flares, rifle, radio
//    7  fire       build, ignite, feed, burn, wind and snow
//    8  thermal    shelter, wind chill, wetness, core temperature, stamina limits
//    9  wolves     packs, moods, attacks
//   10  health     damage, downed, bleed-out, revive, death, respawn
//   11  objective  parts, panel, generator, transmit, helicopter, stages, checkpoints
//   last spawn     world spawn table -> entities (init only)                spawn.ts
//
// `init` hooks run in the same order when a new game starts, `join` hooks when a player joins,
// and an Action is offered to each system's `action` in this order until one returns true.
// Owner: SIM.
import type { System } from '../api';
import { env } from './env';
import { players } from './players';
import { spawn } from './spawn';

export const SYSTEMS: System[] = [
  env,
  players,
  spawn,
];
