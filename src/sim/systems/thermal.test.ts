import { describe, expect, it } from 'vitest';
import { makeFire } from '../entities';
import { Sim } from '../sim';
import { cmd } from '../testkit';
import { createTestWorld, TEST_FLOOR, TEST_LEE } from '../testworld';
import { LONG_TEST_MS } from '../timing';
import { BTN, type FireEnt, type InputCmd, type PlayerEnt } from '../types';
import { woodOf } from './fire';
import { FOOD_KEY, HOT_KEY } from './items';
import { airAt, BALANCE, coreRate, crashAltitude, HUNGER_TIME, LAPSE, windChill, type Exposure } from './thermal';

const world = createTestWorld();
const OPEN = { x: 30, z: 60 }; // flat open snow, nothing near

/** A sim with the weather and the clock held, and n players standing on open ground. */
function setup(o: { storm?: number; clock?: number; n?: number; at?: { x: number; z: number } } = {}) {
  const sim = new Sim(world, { seed: 11, debug: true, players: o.n ?? 1 });
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < (o.n ?? 1); k++) ps.push(sim.addPlayer('P' + k));
  const id = ps[0].id;
  sim.act(id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(id, { t: 'debug', cmd: 'lockClock', args: [1] });
  sim.act(id, { t: 'debug', cmd: 'storm', args: [o.storm ?? 0.45] });
  sim.act(id, { t: 'debug', cmd: 'clock', args: [o.clock ?? 16.5] });
  const at = o.at ?? OPEN;
  ps.forEach((p, k) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [at.x + k * 0.8, at.z] }));
  return { sim, ps, p: ps[0] };
}

/** Step until `done` or `max` seconds; returns the seconds taken (Infinity if never). */
function until(sim: Sim, done: () => boolean, max: number, each?: (tick: number) => void): number {
  for (let i = 1; i <= max * 30; i++) {
    each?.(i);
    sim.step();
    if (done()) return i / 30;
  }
  return Infinity;
}

/** Walk in a slow circle (so the body counts as walking) or stand still. */
function walker(sim: Sim, p: PlayerEnt, walk: boolean, b = 0): (tick: number) => void {
  const c: InputCmd = cmd(0);
  return (tick) => {
    c.seq = tick;
    c.mz = walk ? 1 : 0;
    c.yaw = walk ? tick * (0.6 / 30) : 0;
    c.b = b;
    sim.setInput(p.id, c);
  };
}

/** A campfire with `wood` seconds on it, lit and burning for `warm` seconds before returning. */
function campfire(sim: Sim, x: number, z: number, wood = 600, warm = 70, shelter = 0): FireEnt {
  const f = sim.ctx.spawn<FireEnt>(makeFire('campfire', x, world.heightAt(x, z), z, { shelter }));
  sim.ctx.setV('fire.wood.' + f.id, wood);
  f.lit = true;
  f.heat = 0.12;
  for (let i = 0; i < warm * 30; i++) {
    if (f.type === 'campfire') f.shelter = shelter; // hold it (the fire system refreshes it from the world)
    sim.step();
  }
  return f;
}

describe('thermal: the pace of the cold (DESIGN section 1)', () => {
  it('exposed in a full storm, 37 to 33 in 4 to 5 minutes', () => {
    const walking = setup({ storm: 1 });
    const tw = until(walking.sim, () => walking.p.core <= 33, 600, walker(walking.sim, walking.p, true));
    const standing = setup({ storm: 1 });
    const ts = until(standing.sim, () => standing.p.core <= 33, 600, walker(standing.sim, standing.p, false));
    console.log(`full storm: walking ${tw.toFixed(0)} s, standing ${ts.toFixed(0)} s`);
    expect(tw).toBeGreaterThanOrEqual(240);
    expect(tw).toBeLessThanOrEqual(300);
    expect(ts).toBeGreaterThanOrEqual(200);
    expect(ts).toBeLessThan(tw);
    expect(walking.p.trend).toBeLessThan(-0.6);
    expect(walking.p.feels).toBeLessThan(-25);
  });

  it('wet in a whiteout, about 90 s', () => {
    const { sim, p } = setup({ storm: 1 });
    p.wet = 1; // through the ice
    const t = until(sim, () => p.core <= 33, 300, walker(sim, p, true));
    console.log(`wet whiteout: ${t.toFixed(0)} s`);
    expect(t).toBeGreaterThanOrEqual(75);
    expect(t).toBeLessThanOrEqual(105);
    expect(p.wet).toBe(1); // nothing dries out there
  });

  it('a moderate storm is slower, a clear night slow enough to travel, a clear day mild', () => {
    const times: Record<string, number> = {};
    for (const [name, storm, clock] of [['moderate', 0.45, 16.5], ['clear night', 0, 1], ['clear day', 0, 14]] as const) {
      const { sim, p } = setup({ storm, clock });
      times[name] = until(sim, () => p.core <= 35, 1200, walker(sim, p, true));
    }
    console.log('37 -> 35 walking:', times);
    expect(times.moderate).toBeGreaterThan(200);
    expect(times.moderate).toBeLessThan(420);
    expect(times['clear night']).toBeGreaterThan(times.moderate * 0.8);
    expect(times['clear day']).toBe(Infinity);
  }, LONG_TEST_MS); // three traces of up to 20 game minutes: long, not a cost test

  it('next to a good fire, 33 back to 37 in about 2 minutes; less upwind, more downwind', () => {
    const run = (side: 'cross' | 'up' | 'down') => {
      const { sim, p } = setup({ storm: 0.45 });
      const f = campfire(sim, 0, 60, 900);
      const env = sim.state.env;
      const wl = Math.hypot(env.windX, env.windZ);
      const ux = env.windX / wl, uz = env.windZ / wl;
      // where to stand, 1.5 m from the fire: across the wind, upwind or downwind of it
      const [dx, dz] = side === 'cross' ? [-uz, ux] : side === 'up' ? [-ux, -uz] : [ux, uz];
      sim.act(p.id, { t: 'debug', cmd: 'tp', args: [f.x + dx * 1.5, f.z + dz * 1.5] });
      p.core = 33;
      const t = until(sim, () => p.core >= 36.99, 600, walker(sim, p, false));
      return { t, heat: f.heat, fireHeat: p.fireHeat };
    };
    const cross = run('cross'), up = run('up'), down = run('down');
    console.log(`fire 33 -> 37: across ${cross.t.toFixed(0)} s (fireHeat ${cross.fireHeat.toFixed(2)}), upwind ${up.t.toFixed(0)} s, downwind ${down.t.toFixed(0)} s`);
    expect(cross.heat).toBeGreaterThan(0.7); // an open fire in a moderate storm
    expect(cross.t).toBeGreaterThanOrEqual(95);
    expect(cross.t).toBeLessThanOrEqual(150);
    expect(up.t).toBeGreaterThan(cross.t);
    expect(down.t).toBeLessThan(cross.t);
  });

  it('indoors with the stove lit you warm even at night; without it you cool, slower than outside', () => {
    const inside = { x: TEST_FLOOR.x - 0.5, z: TEST_FLOOR.z };
    const lit = setup({ storm: 0.6, clock: 2, at: inside });
    const stove = lit.sim.ctx.all('fire').find((f) => f.type === 'stove')!;
    expect(woodOf(lit.sim.ctx, stove)).toBeGreaterThan(0); // laid, waiting for a match
    lit.p.inv.matches = 3;
    lit.sim.setInput(lit.p.id, cmd(1, { focus: stove.id, yaw: -Math.PI / 2 }));
    lit.sim.act(lit.p.id, { t: 'ignite', fire: stove.id });
    expect(stove.lit).toBe(true); // shelter 1: the wind has no say
    expect(lit.p.inv.matches).toBe(2);
    lit.p.core = 34;
    until(lit.sim, () => false, 90);
    expect(lit.p.shelter).toBeGreaterThanOrEqual(0.9);
    expect(lit.p.fireHeat).toBeGreaterThan(0.4);
    expect(lit.p.trend).toBeGreaterThan(0.8);
    expect(lit.p.core).toBeGreaterThan(36);

    const cold = setup({ storm: 0.6, clock: 2, at: inside });
    const out = setup({ storm: 0.6, clock: 2 });
    cold.p.core = out.p.core = 36;
    until(cold.sim, () => false, 120);
    until(out.sim, () => false, 120);
    console.log(`night, 2 min standing: cabin without fire ${cold.p.core.toFixed(2)}, outside ${out.p.core.toFixed(2)}`);
    expect(cold.p.core).toBeLessThan(36);
    expect(cold.p.core).toBeGreaterThan(out.p.core + 0.5);
  });
});

describe('thermal: what moves the core', () => {
  it('air gets colder with height: 0.65 C per 100 m above the crash site', () => {
    const { sim } = setup();
    const a0 = crashAltitude(world);
    expect(airAt(sim.ctx, a0)).toBeCloseTo(sim.state.env.airTemp, 9);
    expect(airAt(sim.ctx, a0 + 300) - airAt(sim.ctx, a0)).toBeCloseTo(-300 * LAPSE, 9);
    expect(LAPSE * 100).toBeCloseTo(0.65, 9);
    // the core model: colder air, more loss
    const x: Exposure = { air: -10, wind: 5, balance: BALANCE.walk, wet: 0, hunger: 0, fire: 0, huddle: 0, boost: 0, swim: false };
    const warm = coreRate(x);
    const cold = coreRate({ ...x, air: -12 });
    expect(cold).toBeLessThan(warm);
  });

  it('shelter takes the wind away (wind chill scales by 1 - shelter)', () => {
    const open = setup({ storm: 0.8 });
    const lee = setup({ storm: 0.8, at: { x: TEST_LEE.x, z: TEST_LEE.z } });
    until(open.sim, () => false, 60);
    until(lee.sim, () => false, 60);
    expect(open.p.shelter).toBe(0);
    expect(lee.p.shelter).toBeCloseTo(TEST_LEE.amount, 6);
    expect(lee.p.feels).toBeGreaterThan(open.p.feels + 5);
    expect(lee.p.core).toBeGreaterThan(open.p.core + 0.3);
    // the index itself: more wind, colder
    expect(windChill(-15, 20)).toBeLessThan(windChill(-15, 5));
    expect(windChill(-15, 0.5)).toBe(-15);
  });

  it('falling snow soaks slowly unless sheltered; wet clothes dry by a fire or indoors, not out in the open', () => {
    const open = setup({ storm: 1 });
    const lee = setup({ storm: 1, at: { x: TEST_LEE.x, z: TEST_LEE.z } });
    until(open.sim, () => false, 120);
    until(lee.sim, () => false, 120);
    expect(open.p.wet).toBeGreaterThan(0.04); // slowly: about 0.03 a minute in a whiteout
    expect(open.p.wet).toBeLessThan(0.09);
    expect(lee.p.wet).toBeLessThan(open.p.wet * 0.4);

    const clear = setup({ storm: 0 });
    clear.p.wet = 0.8;
    until(clear.sim, () => false, 60);
    expect(clear.p.wet).toBeCloseTo(0.8, 6);
    const f = campfire(clear.sim, OPEN.x + 1.4, OPEN.z, 900, 0);
    until(clear.sim, () => false, 60);
    expect(f.lit).toBe(true);
    expect(clear.p.wet).toBeLessThan(0.5);
    until(clear.sim, () => false, 90);
    expect(clear.p.wet).toBe(0);

    const room = setup({ storm: 0, at: { x: TEST_FLOOR.x - 0.5, z: TEST_FLOOR.z } });
    room.p.wet = 0.5;
    until(room.sim, () => false, 60);
    expect(room.p.wet).toBeLessThan(0.4);
  });

  it('the water under the ice soaks at once and chills fast', () => {
    const { sim, p } = setup({ storm: 0.2, at: { x: 0, z: 120 } }); // on the lake
    p.swim = true; // the ice system puts people in the water; thermal only reads it
    sim.step();
    expect(p.wet).toBe(1);
    const c0 = p.core;
    for (let i = 0; i < 30 * 20; i++) {
      p.swim = true;
      sim.step();
    }
    expect(c0 - p.core).toBeGreaterThan(1);
  });

  it('sprinting warms a little; standing still loses more than walking', () => {
    const x: Exposure = { air: -12, wind: 8, balance: BALANCE.walk, wet: 0, hunger: 0, fire: 0, huddle: 0, boost: 0, swim: false };
    const walk = coreRate(x), still = coreRate({ ...x, balance: BALANCE.still }), sprint = coreRate({ ...x, balance: BALANCE.sprint });
    expect(still).toBeLessThan(walk);
    expect(sprint).toBeGreaterThan(walk);
    // in mild air a sprint actually warms
    expect(coreRate({ ...x, air: -8, wind: 2, balance: BALANCE.sprint })).toBeGreaterThan(0);

    const run = setup({ storm: 0.3 }), stroll = setup({ storm: 0.3 });
    until(run.sim, () => false, 10, walker(run.sim, run.p, true, BTN.SPRINT));
    until(stroll.sim, () => false, 10, walker(stroll.sim, stroll.p, true));
    expect(run.p.sprint).toBe(true);
    expect(run.p.core).toBeGreaterThan(stroll.p.core);
  });

  it('players within 2.5 m share warmth', () => {
    const pair = setup({ storm: 0.8, n: 2 }); // 0.8 m apart
    const lone = setup({ storm: 0.8 });
    until(pair.sim, () => false, 90);
    until(lone.sim, () => false, 90);
    expect(pair.p.huddle).toBeGreaterThan(0.3);
    expect(lone.p.huddle).toBe(0);
    expect(pair.p.core).toBeGreaterThan(lone.p.core + 0.1);
    expect(pair.p.feels).toBeGreaterThan(lone.p.feels);
  });

  it('hunger rises slowly, faster in the cold; a hungry body warms slowly', () => {
    const { sim, p } = setup({ storm: 0 , clock: 14 });
    until(sim, () => false, 60);
    expect(p.hunger).toBeGreaterThan(55 / HUNGER_TIME);
    expect(p.hunger).toBeLessThan(80 / HUNGER_TIME);
    const fed: Exposure = { air: -12, wind: 8, balance: BALANCE.still, wet: 0, hunger: 0, fire: 0.6, huddle: 0, boost: 0, swim: false };
    expect(coreRate({ ...fed, hunger: 1 })).toBeLessThan(coreRate(fed) - 0.5);
  });

  it('a ration resets hunger and warms a little; the thermos warms strongly', () => {
    const a = setup({ storm: 0.6 }), b = setup({ storm: 0.6 }), c = setup({ storm: 0.6 });
    for (const s of [a, b, c]) {
      s.p.core = 34;
      s.p.hunger = 0.7;
    }
    a.p.inv.thermos = 1;
    b.p.inv.ration = 1;
    a.sim.act(a.p.id, { t: 'consume', item: 'thermos' });
    b.sim.act(b.p.id, { t: 'consume', item: 'ration' });
    expect(a.p.inv.thermos ?? 0).toBe(0);
    expect(a.sim.state.vars[HOT_KEY + a.p.id]).toBeGreaterThan(0);
    expect(b.p.hunger).toBe(0);
    expect(b.sim.state.vars[FOOD_KEY + b.p.id]).toBeGreaterThan(0);
    for (const s of [a, b, c]) until(s.sim, () => false, 50);
    expect(a.p.core - c.p.core).toBeGreaterThan(1.4);
    expect(b.p.core).toBeGreaterThan(c.p.core);
    expect(a.sim.state.vars[HOT_KEY + a.p.id]).toBeUndefined(); // it wears off
  });

  it('fire warmth falls with distance, reaches about 6 m, and walls block it', () => {
    const { sim, p } = setup({ storm: 0 });
    const f = campfire(sim, OPEN.x + 10, OPEN.z, 900, 60);
    const at = (d: number) => {
      sim.act(p.id, { t: 'debug', cmd: 'tp', args: [f.x + d, f.z] });
      sim.step();
      return p.fireHeat;
    };
    const h = [1.2, 2.5, 4, 5.5, 6.5].map(at);
    for (let i = 1; i < h.length; i++) expect(h[i]).toBeLessThan(h[i - 1]);
    expect(h[0]).toBeGreaterThan(0.6);
    expect(h[4]).toBe(0);
    // a fire on the far side of the test wall (0, -20) does not warm through it
    const g = campfire(sim, 0, -21.2, 900, 30);
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [0, -18.6] });
    sim.step();
    const blocked = p.fireHeat;
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [g.x - 2.6, g.z] });
    sim.step();
    expect(p.fireHeat).toBeGreaterThan(0.3);
    expect(blocked).toBeLessThan(p.fireHeat * 0.2);
  });

  it('fills what the body feels every tick, plain numbers, and keeps the core within bounds', () => {
    const { sim, p } = setup({ storm: 0.5, n: 1 });
    p.core = 36.95;
    const f = campfire(sim, OPEN.x + 1.3, OPEN.z, 900, 30);
    expect(f.lit).toBe(true);
    until(sim, () => false, 30);
    expect(p.core).toBe(37);
    for (const k of ['feels', 'shelter', 'fireHeat', 'huddle', 'trend', 'core', 'wet', 'hunger'] as const) expect(Number.isFinite(p[k])).toBe(true);
    expect(sim.state.stats.coldest).toBeLessThanOrEqual(37);
  });
});
