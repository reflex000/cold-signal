// Co-op scaling: the loot and the packs grow with the group (companion bots count), and isolation
// tells the wolves who is alone. Run: npx vitest run src/sim/systems/spawn.test.ts
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { createTestWorld } from '../testworld';
import type { Inventory, ItemId, PlayerEnt } from '../types';
import { LOOT_PER_PLAYER } from './spawn';
import { packSize } from './wolves';

const world = createTestWorld();

/** Every item lying in the world or packed in a crate, totalled. */
function loot(sim: Sim): Inventory {
  const t: Inventory = {};
  const put = (item: ItemId, n: number) => (t[item] = (t[item] ?? 0) + n);
  for (const e of sim.state.ents) {
    if (e.kind === 'pickup') put(e.item, e.n);
    else if (e.kind === 'crate') for (const l of e.loot) put(l.item, l.n);
  }
  return t;
}

describe('co-op scaling', () => {
  it('scales consumables with the expected group; tools, parts and wood stay as placed', () => {
    const one = loot(new Sim(world, { seed: 3, players: 1 }));
    const two = loot(new Sim(world, { seed: 3, players: 2 }));
    const four = loot(new Sim(world, { seed: 3, players: 4 }));
    for (const item of ['matches', 'ration', 'bandage'] as ItemId[]) {
      const base = one[item]!;
      expect(base).toBeGreaterThan(0);
      for (const [n, got] of [[2, two[item]!], [4, four[item]!]] as const) {
        const want = base * (1 + LOOT_PER_PLAYER * (n - 1));
        // each stack rounds its fraction up or down: within one per stack of the exact share
        expect(got).toBeGreaterThanOrEqual(Math.floor(want) - 1);
        expect(got).toBeLessThanOrEqual(Math.ceil(want) + 1);
        expect(got).toBeGreaterThan(base);
      }
    }
    expect(four.stick).toBe(one.stick);
    expect(four.axe).toBe(one.axe);
  });

  it('gives a solo game exactly the placed loot (the random stream untouched)', () => {
    const a = new Sim(world, { seed: 9, players: 1 }), b = new Sim(world, { seed: 9 });
    expect(a.state.rng).toBe(b.state.rng);
    expect(loot(a)).toEqual(loot(b));
  });

  it('grows the packs: one more wolf for two, two more for three or four, at most six', () => {
    for (const [n, base, want] of [[1, 3, 3], [2, 3, 4], [3, 3, 5], [4, 3, 5], [4, 5, 6], [1, 6, 6]] as const) {
      const sim = new Sim(world, { seed: 3, players: n });
      expect(packSize(sim.ctx, base), `${n} players, base ${base}`).toBe(want);
    }
    // players who join later count too (a bot added mid-game)
    const sim = new Sim(world, { seed: 3, players: 1 });
    for (let k = 0; k < 4; k++) sim.addPlayer('P' + k, { bot: k > 0 });
    expect(packSize(sim.ctx, 3)).toBe(5);
  });

  it('isolation: alone is 1, together 0, and it rises as people drift apart', () => {
    const sim = new Sim(world, { seed: 4, debug: true, players: 2 });
    const a = sim.addPlayer('A');
    sim.step();
    expect(a.isolation).toBe(1); // solo
    const b = sim.addPlayer('B', { bot: true });
    const place = (p: PlayerEnt, x: number, z: number) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
    place(a, 0, 20);
    place(b, 3, 20);
    sim.step();
    expect(a.isolation).toBe(0);
    place(b, 40, 20);
    sim.step();
    expect(a.isolation).toBeGreaterThan(0.3);
    expect(a.isolation).toBeLessThan(1);
    place(b, 0, 100);
    sim.step();
    expect(a.isolation).toBe(1);
  });
});
