import { describe, expect, it, vi } from 'vitest';
import { makeDevice, makeFlare } from '../entities';
import { Sim } from '../sim';
import { cmd, jsonIssues, scriptCmd } from '../testkit';
import { createTestWorld, TEST_BEACON, TEST_BED, TEST_DOOR, TEST_FLOOR, TEST_PAD } from '../testworld';
import {
  BTN, type DeviceEnt, type FlareEnt, type HeliEnt, type InputCmd, type PartId, type PlayerEnt, type SimEvent, type Stage,
} from '../types';
import { SYSTEMS } from './index';
import {
  BED_TIME, CHARGE_DECAY, CRANK_PAIR, CRANK_RATE, deviceOf, HELI_LEAD, HOLDOUT_ETA, HOVER_ALT, INSTALL_TIME, padOf, PARTS, PART_ITEM,
  SEARCH_AFTER, SEARCH_MAX, STAGES, TX_DRAIN, TX_MIN, TX_TIME, WINCH_DOWN, WINCH_UP, WRECK_LEAVE,
} from './objective';
import { CP, hurt } from './vitals';

// minutes of game time with every system on (the wolves too): room for a busy machine
vi.setConfig({ testTimeout: 30_000 });

const world = createTestWorld();
const TOWER = world.poi('tower');

function setup(n = 1, o: { bots?: number } = {}) {
  const sim = new Sim(world, { seed: 23, debug: true, players: n });
  // the test world's spawn table has the panel and the generator; these three are put in here
  sim.ctx.spawn(makeDevice('beacon', 'tower', TEST_BEACON.x, world.heightAt(TEST_BEACON.x, TEST_BEACON.z), TEST_BEACON.z));
  sim.ctx.spawn(makeDevice('door', 'cabin', TEST_DOOR.x, TEST_FLOOR.y, TEST_DOOR.z));
  sim.ctx.spawn(makeDevice('bed', 'cabin', TEST_BED.x, TEST_FLOOR.y + 0.56, TEST_BED.z));
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k, { bot: k >= n - (o.bots ?? 0) }));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [0] });
  return { sim, ps, p: ps[0] };
}
const tp = (sim: Sim, p: PlayerEnt, x: number, z: number) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
function input(sim: Sim, p: PlayerEnt, o: Partial<InputCmd> = {}): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: p.yaw, ...o }));
}
function run(sim: Sim, seconds: number, each?: () => void, until?: () => boolean): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    each?.();
    out.push(...sim.step());
    if (until?.()) break;
  }
  return out;
}
const of = <T extends SimEvent['t']>(evs: SimEvent[], t: T) => evs.filter((e) => e.t === t) as Extract<SimEvent, { t: T }>[];
const stagesOf = (evs: SimEvent[]) => of(evs, 'stage').map((e) => e.stage);
const giveAll = (p: PlayerEnt) => PARTS.forEach((q) => (p.inv[PART_ITEM[q]] = 1));
const dev = (sim: Sim, type: DeviceEnt['type']) => deviceOf(sim.ctx, type)!;
/** Stand 1.2 m in front (south) of a device, looking at it. */
function standAt(sim: Sim, p: PlayerEnt, d: DeviceEnt, dx = 0): void {
  tp(sim, p, d.x + dx, d.z + 1.2);
}
const heliOf = (sim: Sim) => sim.ctx.all('heli')[0] as HeliEnt | undefined;
/** Everything installed, the stage at 'power', the players at the tower. */
function powered(n = 1) {
  const g = setup(n);
  for (const q of PARTS) g.sim.state.objective.parts[q] = 'installed';
  g.sim.state.objective.stage = 'power';
  g.ps.forEach((p, k) => standAt(g.sim, p, dev(g.sim, 'generator'), k * 1.1 - 0.5));
  return g;
}
const stageIs = (sim: Sim, s: Stage) => sim.state.objective.stage === s;

describe('objective: from the crash to the tower', () => {
  it('starts at the crash; the search begins with the radio in hand, a walk away from the wreck, or in time', () => {
    const a = setup();
    expect(a.sim.state.objective).toEqual({
      stage: 'crash', parts: { battery: 'lost', handset: 'lost', coil: 'lost', tube: 'lost', fuse: 'lost' }, generator: 0, transmit: 0, eta: -1, signalled: false,
    });
    run(a.sim, 2, () => input(a.sim, a.p));
    expect(stageIs(a.sim, 'crash')).toBe(true);
    a.p.inv.radio = 1;
    const evs = run(a.sim, 0.1);
    expect(stagesOf(evs)).toEqual(['search']);
    expect(of(evs, 'toast').some((e) => e.to === 0 && e.kind === 'objective')).toBe(true);

    const b = setup();
    const wreck = world.poi('wreck');
    tp(b.sim, b.p, wreck.x, wreck.z + WRECK_LEAVE + 5);
    run(b.sim, 0.1);
    expect(stageIs(b.sim, 'search')).toBe(true);

    const c = setup();
    run(c.sim, SEARCH_AFTER - 1, () => input(c.sim, c.p));
    expect(stageIs(c.sim, 'crash')).toBe(true);
    run(c.sim, 2, () => input(c.sim, c.p));
    expect(stageIs(c.sim, 'search')).toBe(true);
  });

  it('counts a part held by anyone, however it got into the pack; all five lead to the tower; a lost one back to the search', () => {
    const { sim, ps } = setup(2);
    const [a, b] = ps;
    a.inv.part_battery = 1; // as the tool hook does: straight into the pack
    let evs = run(sim, 0.1);
    expect(of(evs, 'partFound')).toEqual([{ t: 'partFound', by: a.id, part: 'battery' }]);
    expect(sim.state.objective.parts.battery).toBe('held');
    expect(stageIs(sim, 'search')).toBe(true);
    a.inv.part_handset = 1;
    a.inv.part_coil = 1;
    b.inv.part_tube = 1;
    run(sim, 0.1);
    expect(stageIs(sim, 'search')).toBe(true);
    b.inv.part_fuse = 1;
    evs = run(sim, 0.1);
    expect(stagesOf(evs)).toEqual(['tower']);
    expect(sim.state.objective.parts).toEqual({ battery: 'held', handset: 'held', coil: 'held', tube: 'held', fuse: 'held' });
    // b sets the fuse down: it is lost again, and so is the stage
    sim.act(b.id, { t: 'drop', item: 'part_fuse', n: 1 });
    evs = run(sim, 0.1);
    expect(sim.state.objective.parts.fuse).toBe('lost');
    expect(stagesOf(evs)).toEqual(['search']);
    // handed over instead of dropped: never lost on the way
    const fuse = sim.ctx.all('pickup').find((e) => e.item === 'part_fuse')!;
    sim.ctx.remove(fuse.id);
    b.inv.part_fuse = 1;
    run(sim, 0.1);
    sim.act(b.id, { t: 'give', to: a.id, item: 'part_fuse', n: 1 });
    expect(sim.state.objective.parts.fuse).toBe('held');
    run(sim, 0.1);
    expect(stageIs(sim, 'tower')).toBe(true);
  });

  it('reaching the tower with the parts begins the last stage', () => {
    const { sim, p } = setup();
    giveAll(p);
    run(sim, 0.1);
    expect(stageIs(sim, 'tower')).toBe(true);
    tp(sim, p, TOWER.x, TOWER.z + TOWER.radius + 10);
    run(sim, 1);
    expect(stageIs(sim, 'tower')).toBe(true);
    tp(sim, p, TOWER.x + 2, TOWER.z + 3);
    const evs = run(sim, 0.1);
    expect(stagesOf(evs)).toEqual(['power']);
  });
});

describe('objective: the panel, the generator and the call', () => {
  it('installs each carried part with a hold of USE at the panel, one at a time', () => {
    const { sim, p } = setup();
    const panel = dev(sim, 'panel');
    giveAll(p);
    standAt(sim, p, panel);
    run(sim, 0.2);
    expect(stageIs(sim, 'power')).toBe(true);
    // a hold cut short fits nothing
    let evs = run(sim, INSTALL_TIME * 0.6, () => input(sim, p, { b: BTN.USE, focus: panel.id }));
    expect(p.act).toBe('use');
    run(sim, 0.2, () => input(sim, p, { focus: panel.id }));
    expect(of(evs, 'partInstalled')).toEqual([]);
    expect(p.act).toBe('none');
    // a full hold fits the first, and holding on fits the rest
    evs = run(sim, INSTALL_TIME + 0.1, () => input(sim, p, { b: BTN.USE, focus: panel.id }));
    expect(of(evs, 'partInstalled')).toEqual([{ t: 'partInstalled', by: p.id, part: 'battery' }]);
    expect(sim.state.objective.parts.battery).toBe('installed');
    expect(p.inv.part_battery).toBeUndefined();
    expect(panel.progress).toBeCloseTo(0.2, 9);
    expect(panel.data).toBe(1);
    evs = run(sim, INSTALL_TIME * 4 + 0.5, () => input(sim, p, { b: BTN.USE, focus: panel.id }));
    expect(of(evs, 'partInstalled').map((e) => e.part)).toEqual(['handset', 'coil', 'tube', 'fuse']);
    expect(Object.values(sim.state.objective.parts).every((s) => s === 'installed')).toBe(true);
    expect(panel.data).toBe(31);
    expect(p.act).toBe('none');
    expect(stageIs(sim, 'power')).toBe(true);
    // with nothing left to fit, a press of USE says so
    run(sim, 0.1, () => input(sim, p, { focus: panel.id }));
    evs = run(sim, 0.2, () => input(sim, p, { b: BTN.USE, focus: panel.id }));
    expect(of(evs, 'toast').some((e) => e.to === p.id && /All five/.test(e.text))).toBe(true);
  });

  it('cranks only with all five in; one person charges it, two on the handles go 1.8 times as fast; idle, it runs down', () => {
    const { sim, p } = setup();
    const gen = dev(sim, 'generator');
    p.inv.part_battery = 1;
    standAt(sim, p, gen);
    let evs = run(sim, 3, () => input(sim, p, { b: BTN.USE, focus: gen.id }));
    expect(sim.state.objective.generator).toBe(0);
    expect(of(evs, 'toast').some((e) => e.to === p.id && /nothing to power/.test(e.text))).toBe(true);

    const timeToFull = (n: number) => {
      const g = powered(n);
      const gd = dev(g.sim, 'generator');
      let t = 0;
      run(g.sim, 60, () => {
        g.ps.forEach((q) => input(g.sim, q, { b: BTN.USE, focus: gd.id }));
        t += 1 / 30;
      }, () => g.sim.state.objective.generator >= 1);
      expect(g.ps.every((q) => q.act === 'crank')).toBe(true);
      return { t, g };
    };
    const one = timeToFull(1), two = timeToFull(2);
    expect(one.t).toBeCloseTo(1 / CRANK_RATE, 0);
    expect(one.t / two.t).toBeCloseTo(CRANK_PAIR, 1);
    // PRIMARY with bare hands cranks too
    const h = powered(1);
    run(h.sim, 6, () => input(h.sim, h.p, { b: BTN.PRIMARY, focus: dev(h.sim, 'generator').id }));
    expect(h.sim.state.objective.generator).toBeCloseTo(6 * CRANK_RATE, 2);
    // nobody cranking (and not sending yet): it runs down
    run(h.sim, 10, () => input(h.sim, h.p));
    expect(h.p.act).toBe('none');
    expect(h.sim.state.objective.generator).toBeCloseTo(6 * CRANK_RATE - 10 * CHARGE_DECAY, 2);
    // the generator catches and dies with events
    evs = run(one.g.sim, 0.1);
    expect(dev(one.g.sim, 'generator').on).toBe(true);
    void evs;
  });

  it('at full charge the call goes out over a minute while the charge holds, then the hold-out begins', () => {
    const { sim, p } = powered(1);
    const gen = dev(sim, 'generator');
    const o = sim.state.objective;
    let evs = run(sim, 40, () => input(sim, p, { b: BTN.USE, focus: gen.id }), () => o.generator >= 1);
    expect(of(evs, 'generator')).toEqual([{ t: 'generator', on: true }]);
    expect(o.transmit).toBe(0);
    // sending draws the charge down; nobody cranking it drops out below TX_MIN and the call pauses
    evs = run(sim, 45, () => input(sim, p));
    expect(o.generator).toBeLessThan(TX_MIN);
    const paused = o.transmit;
    expect(paused).toBeGreaterThan((1 - TX_MIN) / (TX_DRAIN + CHARGE_DECAY) / TX_TIME - 0.05);
    expect(paused).toBeLessThan(1);
    run(sim, 3, () => input(sim, p));
    expect(o.transmit).toBe(paused);
    expect(dev(sim, 'beacon').on).toBe(true); // the mast lit when the set keyed
    // cranking again carries the call through
    evs = run(sim, 120, () => input(sim, p, { b: BTN.USE, focus: gen.id }), () => o.stage === 'holdout');
    expect(of(evs, 'transmit')).toEqual([{ t: 'transmit' }]);
    expect(stagesOf(evs)).toEqual(['holdout']);
    expect(o.transmit).toBe(1);
    expect(o.eta).toBeCloseTo(HOLDOUT_ETA, 0);
    // the env system answers with the worst of the storm
    sim.act(p.id, { t: 'debug', cmd: 'storm', args: [-1] });
    sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [0] });
    run(sim, 30, () => input(sim, p));
    expect(sim.state.env.storm).toBe(1);
  });
});

describe('objective: the hold-out and the helicopter', () => {
  it('counts down; the helicopter shows up a minute out to the south and is due at zero', () => {
    const { sim, p } = setup();
    sim.act(p.id, { t: 'debug', cmd: 'obj.stage', args: [STAGES.indexOf('holdout')] });
    const o = sim.state.objective;
    expect(o.eta).toBe(HOLDOUT_ETA);
    expect(sim.ctx.all('wolf').length).toBe(0); // the test world's pack is not due for minutes
    run(sim, 0.1, () => input(sim, p));
    // the last packs wake and come for the tower (wolves.ts rallyWolves)
    expect(sim.ctx.all('wolf').length).toBeGreaterThan(0);
    expect(sim.state.vars['objective.rally']).toBe(1);
    run(sim, HOLDOUT_ETA - HELI_LEAD - 1.1, () => input(sim, p));
    expect(heliOf(sim)).toBeUndefined();
    let evs = run(sim, 2, () => input(sim, p));
    expect(sim.state.vars['objective.rally']).toBe(2);
    const h = heliOf(sim)!;
    expect(h.phase).toBe('inbound');
    expect(of(evs, 'heli')).toEqual([{ t: 'heli', phase: 'inbound' }]);
    expect(h.z).toBeGreaterThan(padOf(world).z + 1000); // down the mountain, to the south
    const d0 = Math.hypot(h.x - TEST_PAD.x, h.z - TEST_PAD.z);
    evs = run(sim, HELI_LEAD, () => input(sim, p), () => o.stage === 'rescue');
    expect(stagesOf(evs)).toEqual(['rescue']);
    expect(o.eta).toBe(0);
    expect(Math.hypot(h.x - TEST_PAD.x, h.z - TEST_PAD.z)).toBeLessThan(d0 * 0.2);
  });

  it('a flare burning on the deck while it is in the air marks the pickup; then it comes to a hover', () => {
    const { sim, p } = setup();
    sim.act(p.id, { t: 'debug', cmd: 'obj.stage', args: [STAGES.indexOf('holdout')] });
    const o = sim.state.objective;
    const pad = padOf(world);
    // a flare too early (no helicopter yet) marks nothing
    const early = sim.ctx.spawn<FlareEnt>(makeFlare(pad.x + 2, pad.y, pad.z, 0, 0, 0, p.id));
    early.landed = true;
    run(sim, 1, () => input(sim, p));
    expect(o.signalled).toBe(false);
    sim.ctx.remove(early.id);
    run(sim, HOLDOUT_ETA - HELI_LEAD, () => input(sim, p));
    expect(heliOf(sim)).toBeDefined();
    // one too far from the deck does not count either
    const far = sim.ctx.spawn<FlareEnt>(makeFlare(pad.x + 30, pad.y, pad.z, 0, 0, 0, p.id));
    far.landed = true;
    run(sim, 1, () => input(sim, p));
    expect(o.signalled).toBe(false);
    const f = sim.ctx.spawn<FlareEnt>(makeFlare(pad.x + 3, pad.y, pad.z - 2, 0, 0, 0, p.id));
    f.landed = true;
    const evs = run(sim, 0.2, () => input(sim, p));
    expect(o.signalled).toBe(true);
    expect(of(evs, 'toast').some((e) => /seen the flare/.test(e.text))).toBe(true);
    run(sim, 120, () => input(sim, p), () => heliOf(sim)!.phase === 'winch');
    const h = heliOf(sim)!;
    expect(h.phase).toBe('winch');
    expect(Math.hypot(h.x - pad.x, h.z - pad.z)).toBeLessThan(10);
    expect(h.y - pad.y).toBeGreaterThan(15);
  });

  it('unmarked, it circles the tower and finds the lights in the end', () => {
    const { sim, p } = setup();
    sim.act(p.id, { t: 'debug', cmd: 'obj.stage', args: [STAGES.indexOf('holdout')] });
    const o = sim.state.objective;
    run(sim, HOLDOUT_ETA + 30, () => input(sim, p), () => heliOf(sim)?.phase === 'search');
    const h = heliOf(sim)!;
    expect(h.phase).toBe('search');
    expect(o.signalled).toBe(false);
    let searched = 0;
    const evs = run(sim, SEARCH_MAX + 2, () => {
      input(sim, p);
      searched += 1 / 30;
    }, () => o.signalled);
    expect(o.signalled).toBe(true);
    expect(of(evs, 'toast').some((e) => /tower lights/.test(e.text))).toBe(true);
    expect(searched).toBeGreaterThanOrEqual(SEARCH_MAX - 0.1);
    expect(h.phase).toBe('hover');
  });
});

/** Rescue under way: the helicopter hovering over the deck, the winch about to come down. */
function atTheWinch(n: number, bots = 0) {
  const g = setup(n, { bots });
  const { sim, p } = g;
  sim.act(p.id, { t: 'debug', cmd: 'obj.stage', args: [STAGES.indexOf('rescue')] });
  sim.state.objective.signalled = true;
  run(sim, 0.1);
  const h = heliOf(sim)!;
  const pad = padOf(world);
  h.x = pad.x + pad.fx * 5;
  h.y = pad.y + HOVER_ALT;
  h.z = pad.z + pad.fz * 5;
  h.vx = h.vy = h.vz = 0;
  run(sim, 6, () => g.ps.forEach((q) => input(sim, q)), () => h.phase === 'winch');
  expect(h.phase).toBe('winch');
  return { ...g, h, pad };
}

describe('objective: the winch and the end', () => {
  it('takes the people on the deck up one at a time, the downed first and companions last; then the ending', () => {
    const { sim, ps, h, pad } = atTheWinch(3, 1);
    const [a, b, bot] = ps;
    tp(sim, a, pad.x + 1, pad.z);
    tp(sim, b, pad.x - 1, pad.z + 0.5);
    tp(sim, bot, pad.x, pad.z - 1.2);
    hurt(sim.ctx, b, 60, 'wolf'); // b is down
    hurt(sim.ctx, b, 45, 'wolf');
    expect(b.life).toBe('downed');
    const order: number[] = [];
    let up = 0;
    const evs = run(sim, 3 * (WINCH_DOWN + WINCH_UP) + 10, () => ps.forEach((q) => input(sim, q)), () => {
      for (const q of ps) if (q.life === 'rescued' && !order.includes(q.id)) order.push(q.id);
      if (order.length === 1 && b.y > pad.y + 3) up = Math.max(up, b.y);
      return sim.state.objective.stage === 'won';
    });
    expect(order).toEqual([b.id, a.id, bot.id]);
    expect(up).toBeGreaterThan(pad.y + 3); // lifted on the line
    expect(ps.every((q) => q.life === 'rescued')).toBe(true);
    expect(of(evs, 'heli').map((e) => e.phase)).toEqual(['away']);
    expect(stagesOf(evs)).toEqual(['won']);
    // aboard, they ride with it
    for (const q of ps) expect(Math.hypot(q.x - h.x, q.z - h.z)).toBeLessThan(0.01);
    expect(of(evs, 'toast').filter((e) => /is aboard/.test(e.text)).length).toBe(3);
  });

  it('waits for every living person, but not for the dead, nor for a companion who is not on the deck', () => {
    const { sim, ps, h, pad } = atTheWinch(3, 1);
    const [a, b, bot] = ps;
    tp(sim, a, pad.x, pad.z);
    tp(sim, b, pad.x + 30, pad.z + 30);
    tp(sim, bot, pad.x - 25, pad.z + 20);
    run(sim, WINCH_DOWN + WINCH_UP + 8, () => ps.forEach((q) => input(sim, q)));
    expect(a.life).toBe('rescued');
    expect(h.phase).toBe('winch'); // b is still down there, alive
    hurt(sim.ctx, b, 200, 'wolf');
    expect(b.life).toBe('dead');
    const evs = run(sim, 10, () => ps.forEach((q) => input(sim, q)), () => sim.state.objective.stage === 'won');
    expect(stagesOf(evs)).toEqual(['won']);
    expect(bot.life).toBe('alive');
  });

  it('co-op: everyone dead at once loses the game, and a lost game refuses respawns', () => {
    const { sim, ps } = setup(2);
    run(sim, 0.1);
    hurt(sim.ctx, ps[0], 200, 'cold');
    run(sim, 0.5);
    expect(stageIs(sim, 'crash')).toBe(true); // one is still alive
    sim.act(ps[0].id, { t: 'respawn' });
    expect(ps[0].life).toBe('alive'); // and the dead come back meanwhile
    hurt(sim.ctx, ps[0], 200, 'cold');
    hurt(sim.ctx, ps[1], 200, 'wolf');
    const evs = run(sim, 0.2);
    expect(stagesOf(evs)).toEqual(['lost']);
    expect(of(evs, 'toast').some((e) => e.to === 0 && e.kind === 'objective')).toBe(true);
    expect(sim.act(ps[0].id, { t: 'respawn' })).toBe(true);
    expect(ps[0].life).toBe('dead');
    run(sim, 5);
    expect(stageIs(sim, 'lost')).toBe(true);
  });

  it('solo: death is not the end; you wake at the last fire you rested at (or the wreck) and the run goes on', () => {
    const { sim, p } = setup(1);
    run(sim, 0.1);
    p.inv.part_battery = 1;
    run(sim, 0.1);
    hurt(sim.ctx, p, 200, 'fall');
    run(sim, 2);
    expect(p.life).toBe('dead');
    expect(stageIs(sim, 'search')).toBe(true);
    sim.act(p.id, { t: 'respawn' });
    expect(p.life).toBe('alive');
    run(sim, 1);
    expect(stageIs(sim, 'search')).toBe(true);
    expect(sim.state.objective.parts.battery).toBe('held'); // still in the pack
  });
});

describe('objective: doors, the bunk, the beacon', () => {
  it('opens and closes a door with USE', () => {
    const { sim, p } = setup();
    const door = dev(sim, 'door');
    tp(sim, p, TEST_DOOR.x, TEST_DOOR.z + 1.2);
    let evs = run(sim, 0.1, () => input(sim, p, { b: BTN.USE, focus: door.id }));
    expect(of(evs, 'door')).toEqual([{ t: 'door', id: door.id, open: true }]);
    run(sim, 1, () => input(sim, p, { focus: door.id }));
    expect(door.on).toBe(true);
    expect(door.progress).toBe(1);
    evs = run(sim, 0.1, () => input(sim, p, { b: BTN.USE, focus: door.id }));
    run(sim, 1, () => input(sim, p));
    expect(of(evs, 'door')).toEqual([{ t: 'door', id: door.id, open: false }]);
    expect(door.progress).toBe(0);
  });

  it('rests on the bunk with a hold of USE: the place to wake, unless too cold, and not again at once', () => {
    const { sim, p } = setup();
    const bed = dev(sim, 'bed');
    tp(sim, p, TEST_BED.x + 1.2, TEST_BED.z);
    expect(p.y).toBeCloseTo(TEST_FLOOR.y, 5);
    p.core = 33;
    let evs = run(sim, BED_TIME + 0.5, () => input(sim, p, { b: BTN.USE, focus: bed.id }));
    expect(of(evs, 'checkpoint')).toEqual([]);
    expect(of(evs, 'toast').some((e) => /Too cold/.test(e.text))).toBe(true);
    run(sim, 0.2, () => input(sim, p));
    p.core = 36.5;
    evs = run(sim, BED_TIME + 0.5, () => input(sim, p, { b: BTN.USE, focus: bed.id }));
    expect(of(evs, 'checkpoint')).toEqual([{ t: 'checkpoint' }]);
    const v = sim.state.vars;
    expect([v[CP.x], v[CP.z]]).toEqual([bed.x, bed.z]);
    run(sim, 0.2, () => input(sim, p));
    evs = run(sim, BED_TIME + 0.5, () => input(sim, p, { b: BTN.USE, focus: bed.id }));
    expect(of(evs, 'checkpoint')).toEqual([]);
    // death: you wake by the bunk
    hurt(sim.ctx, p, 200, 'cold');
    run(sim, 0.1);
    sim.act(p.id, { t: 'respawn' });
    expect(Math.hypot(p.x - bed.x, p.z - bed.z)).toBeLessThan(3.5);
  });
});

describe('objective: saves and determinism', () => {
  /**
   * One tick of a whole game from the crash to the ending, driven by a script that depends only on the
   * tick and the state (so a loaded copy is driven exactly like the live one).
   */
  const c = cmd(0);
  function tickOnce(sim: Sim, ps: PlayerEnt[]): SimEvent[] {
    const tick = sim.state.tick;
    const o = sim.state.objective;
    const gen = dev(sim, 'generator'), panel = dev(sim, 'panel');
    for (let k = 0; k < ps.length; k++) {
      scriptCmd(k, tick, c);
      c.seq = tick + 1;
      if (o.stage === 'power' || o.stage === 'tower') {
        // one fits the parts, the other cranks
        c.mx = c.mz = 0;
        c.b = BTN.USE;
        c.focus = k === 0 ? panel.id : gen.id;
      } else if (o.stage !== 'crash' && o.stage !== 'search') {
        c.mx = c.mz = 0;
        c.b = 0;
        c.focus = 0;
      }
      sim.setInput(ps[k].id, c);
    }
    beats(sim, ps, tick);
    return sim.step();
  }
  function playThrough(sim: Sim, ps: PlayerEnt[], ticks: number): SimEvent[] {
    const out: SimEvent[] = [];
    for (let n = 0; n < ticks; n++) for (const e of tickOnce(sim, ps)) out.push(e);
    return out;
  }
  /** Scripted beats: the radio, the parts, up to the tower, a short wait, a flare and the deck. */
  function beats(sim: Sim, ps: PlayerEnt[], tick: number): void {
    const o = sim.state.objective, pad = padOf(world);
    if (tick === 60) ps[0].inv.radio = 1;
    if (tick === 120) PARTS.forEach((q: PartId, k) => (ps[k % ps.length].inv[PART_ITEM[q]] = 1));
    if (tick === 150) {
      standAt(sim, ps[0], dev(sim, 'panel'));
      standAt(sim, ps[1], dev(sim, 'generator'));
      // the second player's parts go to the first, at the panel
      for (const q of PARTS) {
        if (ps[1].inv[PART_ITEM[q]]) sim.act(ps[1].id, { t: 'give', to: ps[0].id, item: PART_ITEM[q], n: 1 });
      }
    }
    // the tests do not need the whole three minutes
    if (o.stage === 'holdout' && o.eta > HELI_LEAD) sim.act(ps[0].id, { t: 'debug', cmd: 'obj.eta', args: [HELI_LEAD - 1] });
    if (o.stage === 'rescue') {
      if (!o.signalled && !sim.ctx.all('flare').some((f) => f.life > 0)) {
        const f = sim.ctx.spawn<FlareEnt>(makeFlare(pad.x + 1, pad.y, pad.z + 1, 0, 0, 0, ps[0].id));
        f.landed = true;
      }
      for (const p of ps) if (p.life === 'alive' && Math.hypot(p.x - pad.x, p.z - pad.z) > 2) tp(sim, p, pad.x + (p === ps[0] ? -0.8 : 0.8), pad.z);
    }
  }
  const newGame = () => {
    const g = setup(2);
    return g;
  };

  // (the two below run whole games with the wolves on: give them time on a busy machine)
  it('plays from the crash to the ending the same way twice, with every system on, in plain JSON', () => {
    const a = newGame(), b = newGame();
    const ea = playThrough(a.sim, a.ps, 30 * 420);
    const eb = playThrough(b.sim, b.ps, 30 * 420);
    expect(b.sim.serialize()).toBe(a.sim.serialize());
    expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
    expect(stagesOf(ea)).toEqual(['search', 'tower', 'power', 'holdout', 'rescue', 'won']);
    expect(jsonIssues(a.sim.state)).toEqual([]);
    expect(JSON.parse(a.sim.serialize())).toStrictEqual(a.sim.state);
  }, 60_000);

  it('a game saved in any stage continues exactly as if it had never stopped', () => {
    // one game runs on; at the first tick of each stage it is saved, and the loaded copy is driven beside it
    const ref = newGame();
    const forks: { stage: Stage; sim: Sim; ps: PlayerEnt[]; left: number; ea: SimEvent[]; eb: SimEvent[] }[] = [];
    const seen = new Set<Stage>();
    for (let n = 0; n < 30 * 420; n++) {
      const s = ref.sim.state.objective.stage;
      if (!seen.has(s)) {
        seen.add(s);
        const loaded = Sim.fromState(world, ref.sim.serialize(), { seed: 0, debug: true });
        forks.push({ stage: s, sim: loaded, ps: ref.ps.map((p) => loaded.ctx.get<PlayerEnt>(p.id)!), left: 600, ea: [], eb: [] });
      }
      const er = tickOnce(ref.sim, ref.ps);
      for (const f of forks) {
        if (f.left <= 0) continue;
        f.ea.push(...er);
        f.eb.push(...tickOnce(f.sim, f.ps));
        if (--f.left === 0) {
          expect(f.sim.serialize(), f.stage).toBe(ref.sim.serialize());
          expect(JSON.stringify(f.eb), f.stage).toBe(JSON.stringify(f.ea));
        }
      }
    }
    expect(forks.map((f) => f.stage)).toEqual(['crash', 'search', 'tower', 'power', 'holdout', 'rescue', 'won']);
    expect(forks.every((f) => f.left === 0)).toBe(true);
  }, 60_000);
});
