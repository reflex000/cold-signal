import { describe, expect, it } from 'vitest';
import { makeFire } from '../entities';
import { Sim } from '../sim';
import { cmd } from '../testkit';
import { createTestWorld, TEST_FLOOR, TEST_LAKE, TEST_TREE } from '../testworld';
import { BTN, type FireEnt, type PlayerEnt, type SimEvent } from '../types';
import { BURN, burnRate, EMBER_SECONDS, LAY_DIST, LAY_WOOD, woodOf } from './fire';

const world = createTestWorld();
const OPEN = { x: 30, z: 60 };

function setup(o: { storm?: number; clock?: number; lock?: boolean; at?: { x: number; z: number }; yaw?: number } = {}) {
  const sim = new Sim(world, { seed: 5, debug: true });
  const p = sim.addPlayer('A');
  if (o.lock !== false) {
    sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [1] });
    sim.act(p.id, { t: 'debug', cmd: 'lockClock', args: [1] });
  }
  sim.act(p.id, { t: 'debug', cmd: 'storm', args: [o.storm ?? 0] });
  sim.act(p.id, { t: 'debug', cmd: 'clock', args: [o.clock ?? 16.5] });
  const at = o.at ?? OPEN;
  sim.act(p.id, { t: 'debug', cmd: 'tp', args: [at.x, at.z] });
  look(sim, p, o.yaw ?? 0);
  sim.step();
  return { sim, p };
}

function look(sim: Sim, p: PlayerEnt, yaw: number, b = 0, focus = 0): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw, b, focus }));
}

/** A campfire 1.2 m in front of the player (north), with `wood` seconds on it. */
function lay(sim: Sim, p: PlayerEnt, wood: number, o: { shelter?: number; lit?: boolean } = {}): FireEnt {
  const x = p.x, z = p.z - 1.2;
  const f = sim.ctx.spawn<FireEnt>(makeFire('campfire', x, world.heightAt(x, z), z, { shelter: o.shelter ?? 0 }));
  if (wood > 0) sim.ctx.setV('fire.wood.' + f.id, wood);
  if (o.lit) {
    f.lit = true;
    f.heat = 0.5;
  }
  return f;
}

/** Press USE on the focus for a tick, then let go. Returns the events. */
function use(sim: Sim, p: PlayerEnt, id: number): SimEvent[] {
  look(sim, p, p.yaw, BTN.USE, id);
  const evs = sim.step();
  look(sim, p, p.yaw, 0, id);
  return [...evs, ...sim.step()];
}

function steps(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    each?.();
    for (const e of sim.step()) out.push(e);
  }
  return out;
}

const toasts = (evs: SimEvent[]) => evs.filter((e) => e.t === 'toast').map((e) => (e.t === 'toast' ? e.text : ''));

describe('fire: building', () => {
  it('lays a campfire from three sticks in front of the player, sheltered as the world says', () => {
    const { sim, p } = setup();
    p.inv.stick = 2;
    sim.act(p.id, { t: 'buildFire' });
    expect(toasts(sim.step())).toEqual(['You need three sticks to lay a fire.']);
    expect(sim.ctx.all('fire').length).toBe(2);
    p.inv.stick = 4;
    sim.act(p.id, { t: 'buildFire' });
    const evs = sim.step();
    const f = sim.ctx.all('fire').find((e) => e.type === 'campfire')!;
    expect(f).toBeDefined();
    expect(evs).toContainEqual({ t: 'fireBuilt', id: f.id, by: p.id });
    expect(p.inv.stick).toBe(1);
    expect(f.x).toBeCloseTo(p.x, 6);
    expect(f.z).toBeCloseTo(p.z - LAY_DIST, 6);
    expect(f.y).toBe(world.heightAt(f.x, f.z));
    expect(f.lit).toBe(false);
    expect(woodOf(sim.ctx, f)).toBe(LAY_WOOD);
    expect(f.size).toBeGreaterThan(0.2);
    expect(f.shelter).toBe(world.shelterAt(f.x, f.y + 0.5, f.z, 1, 0).amount);
    expect(f.by).toBe(p.id);
  });

  it('refuses the ice, a floor, a wall, a trunk and the spot of another fire', () => {
    const cases: [string, { x: number; z: number }, number, string][] = [
      ['ice', { x: TEST_LAKE.x, z: TEST_LAKE.z + 5 }, 0, 'Not on the ice.'],
      ['floor', { x: TEST_FLOOR.x, z: TEST_FLOOR.z + 1 }, 0, 'Not on the floor.'],
      ['wall', { x: 0, z: -18.7 }, 0, 'There is no room here.'],
      ['tree', { x: TEST_TREE.x, z: TEST_TREE.z + 1.2 }, 0, 'There is no room here.'],
    ];
    for (const [what, at, yaw, why] of cases) {
      const { sim, p } = setup({ at, yaw });
      p.inv.stick = 3;
      sim.act(p.id, { t: 'buildFire' });
      expect(toasts(sim.step()), what).toEqual([why]);
      expect(p.inv.stick, what).toBe(3);
    }
    const { sim, p } = setup();
    lay(sim, p, 0);
    p.inv.stick = 3;
    sim.act(p.id, { t: 'buildFire' });
    expect(toasts(sim.step())).toEqual(['There is a fire here already.']);
  });
});

describe('fire: lighting', () => {
  /** Strike `n` matches at a fresh lay of the same fire; returns the outcomes. */
  function trials(o: { storm: number; tinder?: boolean; wet?: number; shelter?: number }, n = 40) {
    const { sim, p } = setup({ storm: o.storm });
    const f = lay(sim, p, 200, { shelter: o.shelter });
    p.inv.matches = n;
    let lit = 0;
    const fails: string[] = [];
    for (let i = 0; i < n; i++) {
      f.lit = false;
      f.embers = 0;
      f.heat = 0;
      f.shelter = o.shelter ?? 0;
      if (o.tinder) p.inv.tinder = 1;
      p.wet = o.wet ?? 0;
      sim.act(p.id, { t: 'ignite', fire: f.id });
      for (const e of sim.step()) {
        if (e.t === 'fireLit') lit++;
        if (e.t === 'igniteFail') fails.push(e.why);
      }
    }
    return { lit, fails, matches: p.inv.matches ?? 0, tinder: p.inv.tinder ?? 0, stats: sim.state.stats.firesLit };
  }

  it('always spends a match; in calm air it nearly always catches', () => {
    const r = trials({ storm: 0 });
    expect(r.matches).toBe(0);
    expect(r.lit + r.fails.length).toBe(40);
    expect(r.lit).toBeGreaterThanOrEqual(32);
    expect(r.fails.every((w) => w === 'luck')).toBe(true);
    expect(r.stats).toBe(r.lit);
  });

  it('wind on an open fire makes it likely to fail; tinder makes it near certain', () => {
    const wind = trials({ storm: 0.8 });
    expect(wind.lit).toBeLessThanOrEqual(12);
    expect(wind.fails.filter((w) => w === 'wind').length).toBe(wind.fails.length);
    const tinder = trials({ storm: 0.8, tinder: true });
    expect(tinder.lit).toBeGreaterThanOrEqual(32);
    expect(tinder.tinder).toBe(0); // used with each match
    // a sheltered fire does not care about the wind
    const sheltered = trials({ storm: 0.8, shelter: 1 });
    expect(sheltered.lit).toBeGreaterThanOrEqual(32);
  });

  it('a wet player fumbles the match', () => {
    const wet = trials({ storm: 0, wet: 1 });
    expect(wet.lit).toBeLessThanOrEqual(30);
    expect(wet.fails.length).toBeGreaterThan(5);
    expect(wet.fails.every((w) => w === 'wet')).toBe(true);
  });

  it('says why it failed, refuses without matches or wood, and USE lights or adds wood', () => {
    const { sim, p } = setup();
    const bare = lay(sim, p, 0);
    p.inv.matches = 0;
    p.inv.stick = 2;
    sim.act(p.id, { t: 'ignite', fire: bare.id });
    expect(toasts(sim.step())).toEqual(['There is nothing on it to burn.']);
    // USE on a fire with nothing on it puts a stick on
    let evs = use(sim, p, bare.id);
    expect(evs).toContainEqual({ t: 'fireFed', id: bare.id, by: p.id, item: 'stick' });
    expect(woodOf(sim.ctx, bare)).toBe(BURN.stick);
    // then USE strikes a match: none left
    evs = use(sim, p, bare.id);
    expect(toasts(evs)).toEqual(['You have no matches.']);
    expect(bare.lit).toBe(false);
    p.inv.matches = 1;
    evs = use(sim, p, bare.id);
    expect(p.inv.matches ?? 0).toBe(0);
    expect(evs.some((e) => e.t === 'fireLit' || e.t === 'igniteFail')).toBe(true);
    expect(p.act).toBe('ignite');
  });
});

describe('fire: feeding and burning', () => {
  it('a stick adds 40 s, tinder 15 s, a split log 3 minutes; USE prefers sticks', () => {
    const { sim, p } = setup();
    const f = lay(sim, p, 100, { lit: true });
    p.inv.stick = 1;
    p.inv.log = 1;
    p.inv.tinder = 1;
    const w0 = woodOf(sim.ctx, f);
    sim.act(p.id, { t: 'feed', fire: f.id, item: 'tinder' });
    expect(woodOf(sim.ctx, f) - w0).toBe(BURN.tinder);
    let evs = use(sim, p, f.id);
    expect(evs).toContainEqual({ t: 'fireFed', id: f.id, by: p.id, item: 'stick' });
    evs = use(sim, p, f.id);
    expect(evs).toContainEqual({ t: 'fireFed', id: f.id, by: p.id, item: 'log' });
    expect(p.inv).toEqual(expect.not.objectContaining({ stick: expect.anything(), log: expect.anything(), tinder: expect.anything() }));
    expect(BURN).toEqual({ stick: 40, log: 180, tinder: 15 });
    evs = use(sim, p, f.id);
    expect(toasts(evs)).toEqual(['You have no wood.']);
  });

  it('burns faster in the wind; fuel is the time left at the present rate', () => {
    const calm = setup({ storm: 0 }), gale = setup({ storm: 0.9 });
    const a = lay(calm.sim, calm.p, 600, { lit: true }), b = lay(gale.sim, gale.p, 600, { lit: true });
    steps(calm.sim, 30, () => (a.shelter = 0));
    steps(gale.sim, 30, () => (b.shelter = 0));
    const usedA = 600 - woodOf(calm.sim.ctx, a), usedB = 600 - woodOf(gale.sim.ctx, b);
    expect(usedA).toBeGreaterThan(29);
    expect(usedA).toBeLessThan(33);
    expect(usedB).toBeGreaterThan(usedA * 1.8);
    expect(b.fuel).toBeCloseTo(woodOf(gale.sim.ctx, b) / burnRate(gale.sim.ctx, b), 6);
  });

  it('heat ramps up after lighting, sags when starved or snowed on', () => {
    const { sim, p } = setup({ storm: 0 });
    const f = lay(sim, p, 900);
    p.inv.matches = 5;
    p.inv.tinder = 5;
    sim.act(p.id, { t: 'ignite', fire: f.id });
    sim.step();
    expect(f.lit).toBe(true);
    expect(f.heat).toBeLessThan(0.2);
    const ramp: number[] = [];
    for (let s = 0; s < 6; s++) {
      steps(sim, 10);
      ramp.push(f.heat);
    }
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThan(ramp[i - 1]);
    expect(ramp[5]).toBeGreaterThan(0.8);
    // starved: a stick's worth left
    sim.ctx.setV('fire.wood.' + f.id, 25);
    steps(sim, 15);
    expect(f.heat).toBeLessThan(0.5);
    // the same good fire in a whiteout gives less
    const w = setup({ storm: 1 });
    const g = lay(w.sim, w.p, 900, { lit: true });
    steps(w.sim, 60, () => (g.shelter = 0));
    expect(g.heat).toBeLessThan(0.7);
    expect(g.lit).toBe(true); // well fed, it holds
  });

  it('a starved open fire dies in heavy snow or a strong gust; a sheltered one does not', () => {
    const snow = setup({ storm: 1 });
    const f = lay(snow.sim, snow.p, 20, { lit: true });
    const evs = steps(snow.sim, 15, () => (f.shelter = 0));
    expect(evs).toContainEqual({ t: 'fireOut', id: f.id, why: 'snow' });
    expect(f.lit).toBe(false);
    expect(f.embers).toBeGreaterThan(0);
    expect(woodOf(snow.sim.ctx, f)).toBeGreaterThan(0); // the wood is still there, wet

    // gusts: the weather runs free at a moderate storm (light snow), the fire is kept starved
    const gust = setup({ storm: 0.55, lock: false });
    const g = lay(gust.sim, gust.p, 20, { lit: true });
    let why = '';
    for (let i = 0; i < 240 * 30 && !why; i++) {
      g.shelter = 0;
      if (g.lit) gust.sim.ctx.setV('fire.wood.' + g.id, 20);
      for (const e of gust.sim.step()) if (e.t === 'fireOut') why = e.why;
    }
    expect(why).toBe('wind');

    const lee = setup({ storm: 1 });
    const h = lay(lee.sim, lee.p, 20, { lit: true, shelter: 0.8 });
    const evs2 = steps(lee.sim, 12, () => (h.shelter = 0.8));
    expect(evs2.some((e) => e.t === 'fireOut' && e.why !== 'fuel')).toBe(false);
  });

  it('out of wood it dies to embers, which relight without a match for a while', () => {
    const { sim, p } = setup({ storm: 0 });
    const f = lay(sim, p, 5, { lit: true });
    let evs = steps(sim, 6);
    expect(evs).toContainEqual({ t: 'fireOut', id: f.id, why: 'fuel' });
    expect(f.lit).toBe(false);
    expect(f.embers).toBeGreaterThan(EMBER_SECONDS - 2);
    expect(f.size).toBe(0);
    p.inv.stick = 2;
    p.inv.matches = 1;
    evs = use(sim, p, f.id); // a stick on the embers catches
    expect(evs).toContainEqual({ t: 'fireLit', id: f.id, by: p.id });
    expect(f.lit).toBe(true);
    expect(p.inv.matches).toBe(1);
    // embers fade: after they are gone it takes a match again
    f.lit = false;
    f.embers = 3;
    steps(sim, 4);
    expect(f.embers).toBe(0);
    expect(f.heat).toBe(0);
    evs = use(sim, p, f.id);
    expect(p.inv.matches ?? 0).toBe(0);
  });
});

describe('fire: the fixed fires', () => {
  it('the barrel at the wreck is burning when the first survivor arrives; the stove is laid and cold', () => {
    const sim = new Sim(world, { seed: 2, debug: true });
    const barrel = sim.ctx.all('fire').find((f) => f.type === 'barrel')!;
    const stove = sim.ctx.all('fire').find((f) => f.type === 'stove')!;
    expect(barrel.lit).toBe(false);
    expect(woodOf(sim.ctx, stove)).toBeGreaterThan(0);
    const p = sim.addPlayer('A');
    expect(barrel.lit).toBe(true);
    expect(barrel.heat).toBeGreaterThan(0.5);
    expect(stove.lit).toBe(false);
    sim.addPlayer('B'); // only once
    sim.step();
    expect(sim.state.vars['fire.kindled']).toBe(1);
    // standing by the barrel is warm
    sim.setInput(p.id, cmd(1));
    sim.step();
    expect(p.fireHeat).toBeGreaterThan(0.05); // the spawn slots are a few metres off
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [barrel.x + 1.4, barrel.z] });
    for (let i = 0; i < 30; i++) sim.step();
    expect(p.fireHeat).toBeGreaterThan(0.3);
  });
});
