// Turns the world's spawn table into entities when a new game starts. (A loaded game already has
// them in its state, so there is no step and nothing happens on load.)
// Owner: SIM.
import type { System } from '../api';
import { makeFromSpawn } from '../entities';

export const spawn: System = {
  name: 'spawn',

  init(ctx) {
    const defs = ctx.world.spawn.defs;
    for (let i = 0; i < defs.length; i++) ctx.spawn(makeFromSpawn(defs[i]));
  },
};
