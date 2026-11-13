import { describe, expect, it } from 'vitest';
import type { SimCtx, System } from './api';
import { makePickup, makeWolf, START_CLOCK } from './entities';
import { Sim } from './sim';
import { stormAt, visibilityFor, VIS_CLEAR, WHITEOUT, WIND_MAX, WIND_MIN } from './systems/env';
import { SYSTEMS } from './systems/index';
import { cmd, jsonIssues, scriptCmd } from './testkit';
import { createTestWorld } from './testworld';
import { cost, LONG_TEST_MS } from './timing';
import { BTN, DT, type Action, type PlayerEnt, type SimEvent } from './types';

const world = createTestWorld();

/** Counts presses into state.vars, so edge detection is part of what the save tests compare. */
const probe: System = {
  name: 'probe',
  step(ctx: SimCtx) {
    for (const p of ctx.players()) {
      for (const [b, name] of [[BTN.SPRINT, 'sprint'], [BTN.JUMP, 'jump'], [BTN.CROUCH, 'crouch']] as const) {
        if (ctx.pressed(p.id, b)) ctx.setV(`probe.${name}.${p.id}`, ctx.v(`probe.${name}.${p.id}`) + 1);
      }
    }
    // A little randomness from the stream, so the rng state is exercised too.
    ctx.setV('probe.rand', ctx.rand());
  },
};
const TEST_SYSTEMS = [...SYSTEMS, probe];

function newGame(seed = 42, players = 2) {
  const sim = new Sim(world, { seed, debug: true, players }, TEST_SYSTEMS);
  const ids: number[] = [];
  for (let k = 0; k < players; k++) ids.push(sim.addPlayer('P' + k, { bot: k > 0 }).id);
  return { sim, ids };
}

/** A few actions at fixed ticks: equip, weather and clock overrides, a teleport. */
function acts(sim: Sim, ids: number[]) {
  return (tick: number) => {
    const at: Record<number, [number, Action]> = {
      100: [0, { t: 'equip', tool: 'flashlight' }],
      140: [1, { t: 'equip', tool: 'rifle' }], // refused: not carried
      300: [0, { t: 'debug', cmd: 'storm', args: [0.8] }],
      420: [1, { t: 'debug', cmd: 'clock', args: [22] }],
      610: [0, { t: 'debug', cmd: 'storm', args: [-1] }],
      650: [1, { t: 'debug', cmd: 'tp', args: [-30, -15] }],
      800: [0, { t: 'equip', tool: 'hands' }],
    };
    const a = at[tick];
    if (a && ids[a[0]] !== undefined) sim.act(ids[a[0]], a[1]);
  };
}

/** Scripted commands for every player, then one tick; `n` times. Returns the events. */
function drive(sim: Sim, ids: number[], n: number, before?: (tick: number) => void): SimEvent[] {
  const c = cmd(0);
  const evs: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const tick = sim.state.tick;
    for (let k = 0; k < ids.length; k++) {
      scriptCmd(k, tick, c);
      c.seq = tick + 1;
      sim.setInput(ids[k], c);
    }
    before?.(tick);
    for (const e of sim.step()) evs.push(e);
  }
  return evs;
}

describe('Sim: a new game', () => {
  it('starts at dusk with the world spawn table as entities', () => {
    const sim = new Sim(world, { seed: 5 });
    const st = sim.state;
    expect(st.tick).toBe(0);
    expect(st.env.clock).toBe(START_CLOCK);
    expect(st.env.storm).toBeCloseTo(0.45, 9);
    expect(st.ents.length).toBe(world.spawn.defs.length);
    const ids = new Set(st.ents.map((e) => e.id));
    expect(ids.size).toBe(st.ents.length);
    expect(Math.max(...ids)).toBeLessThan(st.nextId);
    expect(sim.ctx.all('fire').length).toBe(2);
    expect(sim.ctx.all('fire').every((f) => f.rev === 1 && !f.lit)).toBe(true);
    expect(sim.ctx.all('crate')[0].loot).toEqual([{ item: 'ration', n: 2 }, { item: 'bandage', n: 1 }]);
  });

  it('places players on the spawn slots with the starting kit', () => {
    const sim = new Sim(world, { seed: 5 });
    const ps = [0, 1, 2, 3].map((k) => sim.addPlayer('P' + k, { bot: k === 3 }));
    ps.forEach((p, k) => {
      expect(p.slot).toBe(k);
      expect([p.x, p.z]).toEqual([world.spawn.players[k].x, world.spawn.players[k].z]);
      expect(p.inv).toEqual({ flashlight: 1, matches: 4 });
      expect(p.held).toBe('hands');
      expect(p.life).toBe('alive');
    });
    expect(ps[3].bot).toBe(true);
    // A freed slot is reused.
    sim.removePlayer(ps[1].id);
    expect(sim.addPlayer('Late').slot).toBe(1);
  });

  it('cleans up after a player who leaves', () => {
    const sim = new Sim(world, { seed: 5 });
    const p = sim.addPlayer('Gone');
    for (let i = 0; i < 60; i++) {
      sim.setInput(p.id, cmd(i + 1, { mz: 1, b: i % 20 < 10 ? BTN.SPRINT : 0 }));
      sim.step();
    }
    expect(Object.keys(sim.state.vars).some((k) => k.endsWith('.' + p.id))).toBe(true);
    sim.removePlayer(p.id);
    expect(sim.ctx.get(p.id)).toBeUndefined();
    expect(sim.ctx.players().length).toBe(0);
    expect(Object.keys(sim.state.vars).filter((k) => k.endsWith('.' + p.id))).toEqual([]);
    expect(sim.removed).toEqual([p.id]);
  });
});

describe('Sim: determinism and saves', () => {
  it('gives identical states and events for the same seed and commands', () => {
    const a = newGame(), b = newGame();
    for (let round = 0; round < 6; round++) {
      const ea = drive(a.sim, a.ids, 150, acts(a.sim, a.ids));
      const eb = drive(b.sim, b.ids, 150, acts(b.sim, b.ids));
      expect(b.sim.serialize()).toBe(a.sim.serialize());
      expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
    }
    expect(a.sim.state.tick).toBe(900);
    const st = a.sim.state;
    expect(st.vars['probe.sprint.' + a.ids[0]]).toBeGreaterThan(0);
    expect(st.vars['probe.jump.' + a.ids[0]]).toBeGreaterThan(0);
    // Another seed is another game.
    const c = newGame(43);
    drive(c.sim, c.ids, 900, acts(c.sim, c.ids));
    expect(c.sim.serialize()).not.toBe(a.sim.serialize());
  });

  it('continues a saved game exactly as if it had never stopped', () => {
    for (const at of [100, 467, 700]) {
      const a = newGame(7, 3);
      drive(a.sim, a.ids, at, acts(a.sim, a.ids));
      const save = a.sim.serialize();
      const b = Sim.fromState(world, save, { seed: 0, debug: true }, TEST_SYSTEMS);
      const c = Sim.fromState(world, JSON.parse(JSON.stringify(a.sim.state)), { seed: 0, debug: true }, TEST_SYSTEMS);
      expect(b.serialize()).toBe(save);
      const ea = drive(a.sim, a.ids, 900 - at, acts(a.sim, a.ids));
      const eb = drive(b, a.ids, 900 - at, acts(b, a.ids));
      const ec = drive(c, a.ids, 900 - at, acts(c, a.ids));
      expect(b.serialize()).toBe(a.sim.serialize());
      expect(c.serialize()).toBe(a.sim.serialize());
      expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
      expect(JSON.stringify(ec)).toBe(JSON.stringify(ea));
    }
  });

  it('keeps a state that is plain JSON and survives a round trip unchanged', () => {
    const a = newGame(9, 4);
    drive(a.sim, a.ids, 700, acts(a.sim, a.ids));
    a.sim.ctx.spawn(makeWolf(5, 0, 5, { pack: 1, alpha: true }));
    expect(jsonIssues(a.sim.state)).toEqual([]);
    expect(JSON.parse(a.sim.serialize())).toStrictEqual(a.sim.state);
  });

  it('refuses a save from another version', () => {
    const st = JSON.parse(new Sim(world, { seed: 1 }).serialize());
    st.version = 999;
    expect(() => Sim.fromState(world, st, { seed: 1 })).toThrow(/version/);
  });
});

describe('SimCtx', () => {
  it('detects presses on the tick a button goes down, also across a save', () => {
    const log: string[] = [];
    const watch: System = {
      name: 'watch',
      step(ctx) {
        const p = ctx.players()[0];
        log.push((ctx.pressed(p.id, BTN.USE) ? 'P' : '-') + (ctx.held(p.id, BTN.USE) ? 'H' : '-'));
      },
    };
    const sys = [...SYSTEMS, watch];
    const a = new Sim(world, { seed: 3 }, sys);
    const id = a.addPlayer('A').id;
    const tickWith = (s: Sim, b: number, seq: number) => {
      s.setInput(id, cmd(seq, { b }));
      s.step();
    };
    tickWith(a, 0, 1);
    tickWith(a, BTN.USE, 2);
    tickWith(a, BTN.USE, 3);
    const b = Sim.fromState(world, a.serialize(), { seed: 3 }, sys);
    tickWith(b, BTN.USE | BTN.JUMP, 4);
    tickWith(b, 0, 5);
    tickWith(b, BTN.USE, 6);
    expect(log).toEqual(['--', 'PH', '-H', '-H', '--', 'PH']);
  });

  it('spawns, finds, lists, touches and removes entities; removals are reported once', () => {
    let doomed: number[] = [];
    let seenDuring: { get: unknown; inList: boolean } | null = null;
    const remover: System = {
      name: 'remover',
      step(ctx) {
        if (doomed.length === 0) return;
        for (const id of doomed) ctx.remove(id);
        seenDuring = { get: ctx.get(doomed[0]), inList: ctx.all('pickup').some((e) => e.id === doomed[0]) };
        doomed = [];
      },
    };
    const sim = new Sim(world, { seed: 3 }, [...SYSTEMS, remover]);
    const made = [];
    for (let i = 0; i < 20; i++) made.push(sim.ctx.spawn(makePickup('stick', 1, i, 0, 0)));
    expect(made[3].id).toBe(made[2].id + 1);
    expect(made[3].rev).toBe(1);
    expect(sim.ctx.get(made[5].id)).toBe(made[5]);
    sim.ctx.touch(made[5]);
    expect(made[5].rev).toBe(2);

    doomed = [made[2].id, made[9].id, made[10].id];
    sim.step();
    expect(seenDuring).toEqual({ get: undefined, inList: true });
    expect(sim.removed).toEqual([made[2].id, made[9].id, made[10].id]);
    for (const id of [made[2].id, made[9].id, made[10].id]) expect(sim.ctx.get(id)).toBeUndefined();
    // Every survivor is still found, and the per-kind list matches the table.
    for (const e of sim.state.ents) expect(sim.ctx.get(e.id)).toBe(e);
    expect(sim.ctx.all('pickup').length).toBe(sim.state.ents.filter((e) => e.kind === 'pickup').length);
    sim.step();
    expect(sim.removed).toEqual([]);
    // Ids are never reused.
    expect(sim.ctx.spawn(makePickup('log', 1, 0, 0, 0)).id).toBe(made[19].id + 1);
  });

  it('draws a reproducible random stream from the state', () => {
    const a = new Sim(world, { seed: 11 }), b = new Sim(world, { seed: 11 }), c = new Sim(world, { seed: 12 });
    const ra = [0, 1, 2, 3].map(() => a.ctx.rand());
    expect([0, 1, 2, 3].map(() => b.ctx.rand())).toEqual(ra);
    expect([0, 1, 2, 3].map(() => c.ctx.rand())).not.toEqual(ra);
    expect(ra.every((r) => r >= 0 && r < 1)).toBe(true);
    expect(a.state.rng).toBe(b.state.rng);
    expect(a.ctx.v('x.y', 4)).toBe(4);
    a.ctx.setV('x.y', 2);
    expect(a.ctx.v('x.y', 4)).toBe(2);
  });

  it('ignores debug actions unless the sim is in debug, and unknown players', () => {
    const sim = new Sim(world, { seed: 3 });
    const id = sim.addPlayer('A').id;
    expect(sim.act(id, { t: 'debug', cmd: 'storm', args: [1] })).toBe(false);
    expect(sim.state.env.storm).toBeCloseTo(0.45, 9);
    expect(sim.act(999, { t: 'equip', tool: 'hands' })).toBe(false);
    sim.setInput(999, cmd(1, { mz: 1 })); // no throw
  });
});

describe('players system', () => {
  it('equips only tools the player has; hands always', () => {
    const sim = new Sim(world, { seed: 3 });
    const p = sim.addPlayer('A');
    expect(sim.act(p.id, { t: 'equip', tool: 'rifle' })).toBe(true);
    expect(p.held).toBe('hands');
    sim.act(p.id, { t: 'equip', tool: 'flashlight' });
    expect(p.held).toBe('flashlight');
    sim.act(p.id, { t: 'equip', tool: 'hands' });
    expect(p.held).toBe('hands');
    const evs = sim.step();
    expect(evs.filter((e) => e.t === 'equip')).toEqual([
      { t: 'equip', id: p.id, tool: 'flashlight' },
      { t: 'equip', id: p.id, tool: 'hands' },
    ]);
  });

  it('moves players by their commands, records seq, steps and distance', () => {
    const sim = new Sim(world, { seed: 3 });
    const p = sim.addPlayer('A');
    const evs: SimEvent[] = [];
    for (let i = 1; i <= 300; i++) {
      sim.setInput(p.id, cmd(i, { yaw: Math.PI, mz: 1 }));
      evs.push(...sim.step());
    }
    expect(p.seq).toBe(300);
    expect(p.z).toBeGreaterThan(24);
    expect(sim.state.stats.distance).toBeCloseTo(Math.hypot(p.x - world.spawn.players[0].x, p.z - world.spawn.players[0].z), 6);
    const steps = evs.filter((e) => e.t === 'step');
    expect(steps.length).toBeGreaterThanOrEqual(20);
    expect(steps.every((e) => e.t === 'step' && e.id === p.id && e.surface === 'snow')).toBe(true);
  });

  it('keeps the last command in force until the next arrives', () => {
    const sim = new Sim(world, { seed: 3 });
    const p = sim.addPlayer('A');
    sim.setInput(p.id, cmd(1, { mz: 1 }));
    for (let i = 0; i < 30; i++) sim.step();
    expect(p.z).toBeLessThan(-2);
    expect(p.seq).toBe(1);
  });
});

describe('env system', () => {
  /** Storm once a second for `seconds`, from a sim with nobody in it. */
  function stormTrace(seed: number, seconds: number): number[] {
    const sim = new Sim(world, { seed });
    const out: number[] = [];
    for (let s = 0; s < seconds; s++) {
      for (let i = 0; i < 30; i++) sim.step();
      out.push(sim.state.env.storm);
    }
    return out;
  }

  it('opens moderate, clears from minute 6 to 12, and has at least two 2-4 minute whiteouts in 50 minutes', () => {
    for (const seed of [1, 77, 4242]) {
      const tr = stormTrace(seed, 3000);
      expect(stormAt(seed, 0)).toBeCloseTo(0.45, 9);
      expect(Math.abs(tr[0] - 0.45)).toBeLessThan(0.05);
      for (let t = 400; t < 700; t++) expect(tr[t]).toBeLessThan(0.15);
      const spells: [number, number][] = [];
      let start = -1;
      for (let t = 0; t < tr.length; t++) {
        if (tr[t] > WHITEOUT && start < 0) start = t;
        if (tr[t] <= WHITEOUT && start >= 0) {
          spells.push([start, t]);
          start = -1;
        }
      }
      expect(start).toBe(-1);
      expect(spells.length).toBeGreaterThanOrEqual(2);
      for (const [a, b] of spells) {
        expect(b - a).toBeGreaterThanOrEqual(120);
        expect(b - a).toBeLessThanOrEqual(240);
      }
    }
  }, LONG_TEST_MS); // 270k ticks: a long trace, not a cost test

  it('derives wind, snow, visibility, temperature, cloud and aurora from the storm and the hour', () => {
    const sim = new Sim(world, { seed: 5, debug: true });
    const id = sim.addPlayer('A').id;
    const e = sim.state.env;
    const read = (storm: number, clock: number) => {
      sim.act(id, { t: 'debug', cmd: 'storm', args: [storm] });
      sim.act(id, { t: 'debug', cmd: 'clock', args: [clock] });
      for (let i = 0; i < 10; i++) sim.step();
      return { ...e, wind: Math.hypot(e.windX, e.windZ) };
    };
    const clearDay = read(0, 14), clearNight = read(0, 1), whiteNight = read(1, 1), whiteDay = read(1, 14);
    expect(clearDay.wind).toBeGreaterThanOrEqual(WIND_MIN);
    expect(clearDay.wind).toBeLessThan(4);
    expect(whiteDay.wind).toBeGreaterThan(18);
    expect(whiteDay.wind).toBeLessThanOrEqual(WIND_MAX);
    expect(clearDay.visibility).toBeCloseTo(VIS_CLEAR, 6);
    expect(whiteDay.visibility).toBeCloseTo(visibilityFor(1), 6);
    expect(whiteDay.visibility).toBeLessThan(8);
    expect(clearDay.airTemp).toBeCloseTo(-8, 1);
    expect(clearNight.airTemp).toBeLessThan(-22);
    expect(whiteNight.airTemp).toBeLessThan(clearNight.airTemp - 4);
    expect(clearDay.snowfall).toBe(0);
    expect(whiteDay.snowfall).toBe(1);
    expect(whiteDay.cloud).toBe(1);
    expect(clearNight.aurora).toBeGreaterThan(0.4);
    expect(clearDay.aurora).toBe(0);
    expect(whiteNight.aurora).toBe(0);
    expect(e.snowAccum).toBeGreaterThan(0);
  });

  it('runs the clock: a day is 24 minutes', () => {
    const sim = new Sim(world, { seed: 5 });
    for (let i = 0; i < 60 * 30; i++) sim.step();
    expect(sim.state.env.clock).toBeCloseTo(START_CLOCK + 1, 6);
    expect(sim.state.env.t).toBeCloseTo(60, 9);
  });

  it('forces the full storm during the hold-out', () => {
    const sim = new Sim(world, { seed: 5 });
    sim.state.objective.stage = 'holdout';
    for (let i = 0; i < 30 * 30; i++) sim.step();
    expect(sim.state.env.storm).toBe(1);
    expect(sim.state.env.visibility).toBeLessThan(8);
  });

  it('blows gusts and says so', () => {
    const sim = new Sim(world, { seed: 5 });
    const evs: SimEvent[] = [];
    let peak = 0;
    for (let i = 0; i < 120 * 30; i++) {
      evs.push(...sim.step());
      peak = Math.max(peak, sim.state.env.gust);
    }
    const gusts = evs.filter((e) => e.t === 'gust');
    expect(gusts.length).toBeGreaterThan(3);
    expect(gusts.every((g) => g.t === 'gust' && g.strength > 0 && g.strength <= 1)).toBe(true);
    expect(peak).toBeGreaterThan(0.05);
  });

  it('honours debug overrides: storm, clock, lockWeather, tp', () => {
    const sim = new Sim(world, { seed: 5, debug: true });
    const p = sim.addPlayer('A');
    sim.act(p.id, { t: 'debug', cmd: 'storm', args: [0.95] });
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.state.env.storm).toBe(0.95);
    sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [1] });
    sim.act(p.id, { t: 'debug', cmd: 'storm', args: [-1] });
    const w = [sim.state.env.windX, sim.state.env.windZ];
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.state.env.storm).toBe(0.95);
    expect([sim.state.env.windX, sim.state.env.windZ]).toEqual(w);
    sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [0] });
    sim.act(p.id, { t: 'debug', cmd: 'clock', args: [3.5] });
    expect(sim.state.env.clock).toBe(3.5);
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [-20, 20] });
    expect([p.x, p.y, p.z]).toEqual([-20, 0.3, 20]); // onto the cabin floor
    expect(sim.act(p.id, { t: 'debug', cmd: 'nonsense' })).toBe(false);
  });
});

describe('performance', () => {
  it('steps 4 players, 12 wolves and 600 static entities well under 1 ms', () => {
    const sim = new Sim(world, { seed: 8, players: 4 });
    const ids = [0, 1, 2, 3].map((k) => sim.addPlayer('P' + k).id);
    for (let i = 0; i < 12; i++) sim.ctx.spawn(makeWolf(20 + i, 0, -30, { pack: i % 2, alpha: i % 6 === 0 }));
    for (let i = sim.state.ents.length; i < 4 + 12 + 600; i++) sim.ctx.spawn(makePickup('stick', 1, (i % 40) * 2 - 40, 0, Math.floor(i / 40) * 2 - 30));
    const c = cmd(0);
    const tick = () => {
      for (let k = 0; k < 4; k++) {
        scriptCmd(k, sim.state.tick, c);
        c.seq = sim.state.tick + 1;
        sim.setInput(ids[k], c);
      }
      sim.step();
    };
    for (let i = 0; i < 300; i++) tick(); // warm up the JIT
    // best of five rounds of 300 ticks; the budget follows the machine's measured slowdown (timing.ts)
    const { ms, slow } = cost(tick, 300, 5);
    expect(sim.state.ents.length).toBe(616);
    expect(ms, `${ms.toFixed(4)} ms per tick (machine ${slow.toFixed(2)}x slower than idle)`).toBeLessThan(0.5 * slow);
  }, LONG_TEST_MS);
});

// A player entity in the state is the same object the context hands out.
it('players() and get() hand out the live state objects', () => {
  const sim = new Sim(world, { seed: 1 });
  const p = sim.addPlayer('A');
  expect(sim.ctx.players()[0]).toBe(p);
  expect(sim.state.ents.includes(p as PlayerEnt)).toBe(true);
  expect(sim.ctx.input(p.id).yaw).toBe(world.spawn.players[0].yaw);
  expect(sim.ctx.input(12345)).toEqual(cmd(0));
  expect(DT).toBeCloseTo(1 / 30, 12);
});
