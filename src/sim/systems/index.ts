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
//    3  ice        lake ice stress, creaks, breaking, falling in, climbing / hauled out, refreeze   ice.ts
//    4  wood       the axe (chop dead wood) and heavy logs: carry, drag, release (sets carryPair)   wood.ts
//    5  items      focus + USE: pick up, open crates, consume, drop, give                           items.ts
//    6  tools      flashlight, flare gun and flares, rifle, radio; the axe's blow on a wolf          tools.ts
//                  (the swing itself is wood's)
//    7  fire       build, ignite, feed, burn, wind and snow                                          fire.ts
//    8  thermal    shelter, wind chill, wetness, hunger, core temperature                            thermal.ts
//    9  wolves     packs wake, roam, gather, stalk, circle, feint, charge, bite, drag, flee, feed    wolves.ts
//   10  objective  stages, parts, panel, generator, transmit, helicopter, winch, doors, bunk        objective.ts
//                  before vitals so a lost game can refuse 'respawn' (it sees a death a tick later)
//   11  vitals     health, falls, downed, bleed-out, revive, death, respawn, checkpoints, isolation  vitals.ts
//   12  story      notes, the first howl, whiteout warnings, the radio's first tone, the first cough  story.ts
//
// Movement (players) runs before anything that reacts to where people are standing, so ice,
// fire warmth and wolves all see this tick's positions.
// Owner: SIM (the survival lines: SURVIVAL).
import type { System } from '../api';
import { env } from './env';
import { fire } from './fire';
import { ice } from './ice';
import { items } from './items';
import { objective } from './objective';
import { players } from './players';
import { spawn } from './spawn';
import { story } from './story';
import { thermal } from './thermal';
import { tools } from './tools';
import { vitals } from './vitals';
import { wolves } from './wolves';
import { wood } from './wood';

export const SYSTEMS: System[] = [
  spawn,
  env,
  players,
  ice,
  wood,
  items,
  tools,
  fire,
  thermal,
  wolves,
  objective,
  vitals,
  story,
];
