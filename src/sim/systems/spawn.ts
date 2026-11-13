// Turns the world's spawn table into entities when a new game starts. (A loaded game already has
// them in its state, so there is no step and nothing happens on load.)
//
// Co-op scaling of the loot: the world places supplies for one player. With n players expected
// (SimOptions.players, kept in state.vars['sim.players']; companion bots count) every stack of a
// consumable in a crate or on the ground holds LOOT_PER_PLAYER more per extra player, the fraction
// rounded up or down by the simulation's random stream. Tools, radio parts, wood and the makings of a
// fire (matches, tinder) never scale: one of each tool is enough for a group, more hands gather more
// wood, and one match lights a fire that warms everyone (each player also brings a few matches). (The wolves scale in
// wolves.ts packSize: one more per pack for two players, two more for three or four.)
// Owner: SIM (co-op scaling: TOGETHER).
import type { SimCtx, System } from '../api';
import { CARRY_LIMIT, makeFromSpawn } from '../entities';
import type { ItemId } from '../types';

/** Extra share of each consumable stack per player beyond the first. */
export const LOOT_PER_PLAYER = 0.35; // (RELEASE balance: was 0.5, matches and tinder included; a pair ended the hour with 25 matches spare)

/** Supplies that run out and so scale with the group. */
export const SCALED_LOOT: ReadonlySet<ItemId> = new Set<ItemId>(['flare', 'ammo', 'cell', 'bandage', 'ration', 'thermos']);

/** How many of `item` a stack of `n` placed for one player holds for the expected group. */
export function scaledCount(ctx: SimCtx, item: ItemId, n: number): number {
  const players = ctx.v('sim.players', 1);
  if (players <= 1 || !SCALED_LOOT.has(item)) return n;
  const want = n * (1 + LOOT_PER_PLAYER * (players - 1));
  const whole = Math.floor(want);
  const k = whole + (ctx.rand() < want - whole ? 1 : 0);
  // a pickup larger than a pack holds could never be taken in one go
  return Math.max(n, Math.min(k, CARRY_LIMIT[item]));
}

export const spawn: System = {
  name: 'spawn',

  init(ctx) {
    const defs = ctx.world.spawn.defs;
    for (let i = 0; i < defs.length; i++) {
      const e = ctx.spawn(makeFromSpawn(defs[i]));
      if (e.kind === 'pickup') e.n = scaledCount(ctx, e.item, e.n);
      else if (e.kind === 'crate') for (const l of e.loot) l.n = scaledCount(ctx, l.item, l.n);
    }
  },
};
