import { describe, expect, it } from 'vitest';
import { makeFire } from '../entities';
import { CRAWL_SPEED } from '../move';
import { Sim } from '../sim';
import { cmd, jsonIssues, scriptCmd } from '../testkit';
import { createTestWorld } from '../testworld';
import { BTN, type Action, type FireEnt, type InputCmd, type PlayerEnt, type SimEvent } from '../types';
import {
  BLEED_TIME, CP, fallDamage, LETHAL_IMPACT, RESPAWN_CORE, RESPAWN_HEALTH, REVIVE_HEALTH, REVIVE_TIME, SAFE_IMPACT,
} from './vitals';

const world = createTestWorld();
const OPEN = { x: 30, z: 60 };

function setup(n = 1, o: { bots?: boolean; storm?: number } = {}) {
  const sim = new Sim(world, { seed: 17, debug: true, players: n });
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k, { bot: k > 0 && !!o.bots }));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [o.storm ?? 0] });
  ps.forEach((p, k) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [OPEN.x + k * 1.2, OPEN.z] }));
  return { sim, ps, p: ps[0] };
}

function input(sim: Sim, p: PlayerEnt, o: Partial<InputCmd> = {}): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: p.yaw, ...o }));
}

function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    each?.();
    out.push(...sim.step());
  }
  return out;
}

/** Drop the player from `h` metres above the ground; returns the events of the fall. */
function drop(sim: Sim, p: PlayerEnt, h: number): SimEvent[] {
  p.y = world.heightAt(p.x, p.z) + h;
  p.onGround = false;
  p.vy = 0;
  return run(sim, Math.sqrt((2 * h) / 14) + 0.3);
}

describe('vitals: falls', () => {
  it('a short drop does nothing, a few metres hurt, a long fall kills', () => {
    expect(fallDamage(SAFE_IMPACT, 'rock')).toBe(0);
    expect(fallDamage(LETHAL_IMPACT, 'rock')).toBeCloseTo(100, 6);
    expect(fallDamage(12, 'deep')).toBeLessThan(fallDamage(12, 'rock'));
    for (let v = 8; v < 30; v++) expect(fallDamage(v + 1, 'snow')).toBeGreaterThan(fallDamage(v, 'snow'));

    const { sim, p } = setup();
    let evs = drop(sim, p, 1.5);
    expect(evs.some((e) => e.t === 'land')).toBe(true);
    expect(evs.some((e) => e.t === 'hurt')).toBe(false);
    expect(p.health).toBe(100);
    evs = drop(sim, p, 6);
    const hurt = evs.find((e) => e.t === 'hurt');
    expect(hurt && hurt.t === 'hurt' && hurt.cause).toBe('fall');
    expect(p.health).toBeLessThan(90);
    expect(p.health).toBeGreaterThan(55);
    expect(p.life).toBe('alive');
    // the south cliff is 15 to 40 m: 20 m onto snow is the end
    evs = drop(sim, p, 20);
    expect(evs).toContainEqual({ t: 'died', id: p.id });
    expect(p.life).toBe('dead');
    expect(p.health).toBe(0);
  });
});

describe('vitals: down, bleeding out, revived', () => {
  it('the cold drains health below 31 C and collapses the body at 30 C', () => {
    const { sim, p } = setup(1, { storm: 1 });
    p.core = 30.9;
    const evs = run(sim, 60, () => input(sim, p));
    const cold = evs.filter((e) => e.t === 'hurt' && e.cause === 'cold');
    expect(cold.length).toBeGreaterThan(2);
    expect(p.health).toBeLessThan(100);
    expect(evs).toContainEqual({ t: 'downed', id: p.id });
    expect(p.life).toBe('downed');
    expect(p.bleed).toBeGreaterThan(BLEED_TIME - 60);
    expect(sim.state.stats.downs).toBe(1);
  });

  it('health 0 puts a player down; a downed player crawls, and dies when the 90 s run out', () => {
    const { sim, p } = setup();
    p.health = 0;
    let evs = run(sim, 0.1);
    expect(evs).toContainEqual({ t: 'downed', id: p.id });
    expect(p.bleed).toBeCloseTo(BLEED_TIME, 0);
    const z0 = p.z;
    input(sim, p, { mz: 1, yaw: 0 });
    run(sim, 4);
    expect((z0 - p.z) / 4).toBeGreaterThan(CRAWL_SPEED * 0.8);
    expect((z0 - p.z) / 4).toBeLessThan(CRAWL_SPEED * 1.05);
    input(sim, p);
    evs = run(sim, BLEED_TIME - 5);
    expect(p.life).toBe('downed');
    evs = run(sim, 2);
    expect(evs).toContainEqual({ t: 'died', id: p.id });
    expect(p.life).toBe('dead');
  });

  it('a teammate holding USE for 5 s within 1.5 m gets them up with health 30 and a little warmth', () => {
    const { sim, ps } = setup(2);
    const [p, q] = ps;
    p.core = 30.4;
    p.health = 0;
    run(sim, 0.1);
    expect(p.life).toBe('downed');
    // too far: nothing
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [p.x + 2.6, p.z] });
    input(sim, q, { b: BTN.USE, focus: p.id });
    run(sim, 2);
    expect(p.revive).toBe(0);
    // close: two seconds, then let go: it fades
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [p.x + 1.1, p.z] });
    input(sim, q, { b: BTN.USE, focus: p.id });
    const bleed0 = p.bleed;
    run(sim, 2);
    expect(p.revive).toBeCloseTo(2 / REVIVE_TIME, 1);
    expect(p.reviver).toBe(q.id);
    expect(q.act).toBe('revive');
    expect(p.bleed).toBeCloseTo(bleed0, 6); // the bleeding waits while someone works on you
    input(sim, q);
    run(sim, 3);
    expect(p.revive).toBe(0);
    expect(q.act).toBe('none');
    input(sim, q, { b: BTN.USE, focus: p.id });
    const evs = run(sim, REVIVE_TIME + 0.2);
    expect(evs).toContainEqual({ t: 'revived', id: p.id, by: q.id });
    expect(p.life).toBe('alive');
    expect(p.health).toBe(REVIVE_HEALTH);
    expect(p.core).toBeGreaterThan(31.9); // 32 when it happened, a few ticks of cold since
    expect(sim.state.stats.revives).toBe(1);
  });

  it('alone, a bandage gets you up once per checkpoint; with others it stops the bleeding', () => {
    const solo = setup();
    const p = solo.p;
    p.inv.bandage = 3;
    p.health = 0;
    run(solo.sim, 0.1);
    solo.sim.act(p.id, { t: 'consume', item: 'bandage' });
    expect(p.life).toBe('alive');
    expect(p.inv.bandage).toBe(2);
    p.health = 0;
    run(solo.sim, 0.1);
    solo.sim.act(p.id, { t: 'consume', item: 'bandage' });
    expect(p.life).toBe('downed');
    expect(p.inv.bandage).toBe(2);
    // a new checkpoint gives it back
    solo.sim.state.vars[CP.t] = 0;
    solo.sim.state.vars['vitals.self.' + p.id] = 1;
    p.life = 'alive';
    p.health = 60;
    const f = solo.sim.ctx.spawn<FireEnt>(makeFire('campfire', p.x + 1.2, world.heightAt(p.x + 1.2, p.z), p.z, {}));
    solo.sim.ctx.setV('fire.wood.' + f.id, 600);
    f.lit = true;
    f.heat = 0.8;
    p.core = 37;
    input(solo.sim, p);
    const evs = run(solo.sim, 7);
    expect(evs).toContainEqual({ t: 'checkpoint' });
    expect(solo.sim.state.vars['vitals.self.' + p.id]).toBeUndefined();
    p.health = 0;
    run(solo.sim, 0.1);
    solo.sim.act(p.id, { t: 'consume', item: 'bandage' });
    expect(p.life).toBe('alive');

    // companion bots do not count as company: alone with a bot is still alone
    const withBot = setup(2, { bots: true });
    withBot.p.inv.bandage = 1;
    withBot.p.health = 0;
    run(withBot.sim, 0.1);
    withBot.sim.act(withBot.p.id, { t: 'consume', item: 'bandage' });
    expect(withBot.p.life).toBe('alive');

    const coop = setup(2);
    const c = coop.p;
    c.inv.bandage = 1;
    c.health = 0;
    run(coop.sim, 30);
    expect(c.bleed).toBeLessThan(BLEED_TIME - 25);
    coop.sim.act(c.id, { t: 'consume', item: 'bandage' });
    expect(c.life).toBe('downed');
    expect(c.bleed).toBe(BLEED_TIME);
    expect(c.inv.bandage).toBeUndefined();
  });
});

describe('vitals: checkpoints, respawn, isolation', () => {
  it('resting warm at a lit fire makes a checkpoint (once per fire for a while); respawn wakes you there', () => {
    const { sim, p } = setup();
    const f = sim.ctx.spawn<FireEnt>(makeFire('campfire', OPEN.x + 1.5, world.heightAt(OPEN.x + 1.5, OPEN.z), OPEN.z, {}));
    sim.ctx.setV('fire.wood.' + f.id, 1200);
    f.lit = true;
    f.heat = 0.8;
    p.core = 35.5; // not warm yet
    input(sim, p);
    let evs = run(sim, 8);
    expect(evs.some((e) => e.t === 'checkpoint')).toBe(false);
    p.core = 37;
    evs = run(sim, 7);
    expect(evs.filter((e) => e.t === 'checkpoint').length).toBe(1);
    const v = sim.state.vars;
    expect(v[CP.x]).toBeCloseTo(p.x, 6);
    expect(v[CP.z]).toBeCloseTo(p.z, 6);
    expect(v[CP.fire]).toBe(f.id);
    evs = run(sim, 30);
    expect(evs.some((e) => e.t === 'checkpoint')).toBe(false);
    // die far away, wake by that fire with little warmth and health
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [-30, 70] });
    sim.act(p.id, { t: 'respawn' }); // alive: nothing
    expect(p.x).toBeCloseTo(-30, 6);
    p.health = 0;
    run(sim, 0.1);
    p.bleed = 0.01;
    run(sim, 0.1);
    expect(p.life).toBe('dead');
    sim.act(p.id, { t: 'respawn' });
    expect(p.life).toBe('alive');
    expect(Math.hypot(p.x - v[CP.x], p.z - v[CP.z])).toBeLessThan(2.5);
    expect(Math.hypot(p.x - f.x, p.z - f.z)).toBeGreaterThan(0.85);
    expect(p.health).toBe(RESPAWN_HEALTH);
    expect(p.core).toBe(RESPAWN_CORE);
    expect(p.wet).toBe(0);
  });

  it('with no checkpoint yet, respawn is at the spawn slot', () => {
    const { sim, p } = setup();
    p.health = 0;
    run(sim, 0.1);
    p.bleed = 0.01;
    run(sim, 0.1);
    sim.act(p.id, { t: 'respawn' });
    const s = world.spawn.players[p.slot];
    expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeLessThan(3.5);
    expect(p.life).toBe('alive');
  });

  it('isolation: 0 beside a teammate, 1 alone or far away', () => {
    const solo = setup();
    run(solo.sim, 0.1);
    expect(solo.p.isolation).toBe(1);
    const { sim, ps } = setup(2);
    const [p, q] = ps;
    const at = (d: number) => {
      sim.act(q.id, { t: 'debug', cmd: 'tp', args: [p.x + d, p.z] });
      sim.step();
      return p.isolation;
    };
    expect(at(4)).toBe(0);
    const mid = at(30);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(at(100)).toBe(1);
    q.life = 'dead';
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [p.x + 2, p.z] });
    sim.step();
    expect(p.isolation).toBe(1);
  });
});

describe('all survival systems together', () => {
  /** Three players doing everything: fire, wood, logs, items, the cold, going down and coming back. */
  function newGame(seed = 23) {
    const sim = new Sim(world, { seed, debug: true, players: 3 });
    const ids = [0, 1, 2].map((k) => sim.addPlayer('P' + k, { bot: k === 2 }).id);
    const [a, b, c] = ids.map((id) => sim.ctx.get<PlayerEnt>(id)!);
    a.inv.stick = 9;
    a.inv.tinder = 2;
    b.inv.axe = 1;
    c.inv.bandage = 1;
    return { sim, ids };
  }

  function drive(sim: Sim, ids: number[], from: number, to: number): SimEvent[] {
    const evs: SimEvent[] = [];
    const c: InputCmd = cmd(0);
    const P = (k: number) => sim.ctx.get<PlayerEnt>(ids[k])!;
    const act = (k: number, a: Action) => sim.act(ids[k], a);
    for (let t = from; t < to; t++) {
      // scripted moves, then each beat
      for (let k = 0; k < ids.length; k++) {
        scriptCmd(k, t, c);
        c.seq = t + 1;
        const p = P(k);
        if (t >= 200 && t < 1400) {
          // stand still and work
          c.mx = c.mz = 0;
          c.b = 0;
          c.yaw = p.yaw;
        }
        if (k === 0 && t >= 260 && t < 270) {
          const f = sim.ctx.all('fire').find((e) => e.type === 'campfire');
          if (f) {
            c.focus = f.id;
            c.b = t === 262 ? BTN.USE : 0;
          }
        }
        if (k === 1 && t >= 300 && t < 600) {
          const w = sim.ctx.all('wood').find((e) => e.type === 'snag');
          c.focus = w ? w.id : 0;
          c.b = BTN.PRIMARY;
        }
        if (k === 0 && t >= 1250 && t < 1260) {
          // take back the stick dropped at 1200
          const pk = sim.ctx.all('pickup').find((e) => e.item === 'stick' && Math.hypot(e.x - p.x, e.z - p.z) < 1.5);
          c.focus = pk ? pk.id : 0;
          c.b = t === 1252 ? BTN.USE : 0;
        }
        if (k === 0 && t >= 900 && t < 1100) {
          c.focus = ids[2];
          c.b = BTN.USE;
        }
        sim.setInput(ids[k], c);
      }
      switch (t) {
        case 150: act(0, { t: 'debug', cmd: 'storm', args: [0.9] }); break;
        case 200: act(0, { t: 'debug', cmd: 'tp', args: [30, 60] }); P(0).yaw = 0; break;
        case 201: act(0, { t: 'buildFire' }); break;
        case 230: act(1, { t: 'equip', tool: 'axe' }); break;
        case 231: {
          const w = sim.ctx.all('wood').find((e) => e.type === 'snag')!;
          act(1, { t: 'debug', cmd: 'tp', args: [w.x, w.z + 1] });
          P(1).yaw = 0;
          break;
        }
        case 400: {
          const f = sim.ctx.all('fire').find((e) => e.type === 'campfire');
          if (f) act(0, { t: 'feed', fire: f.id, item: 'stick' });
          break;
        }
        case 500: {
          const l = sim.ctx.all('log')[0];
          act(2, { t: 'debug', cmd: 'tp', args: [l.x + 1.5, l.z] });
          break;
        }
        case 501: act(2, { t: 'carry', log: sim.ctx.all('log')[0].id }); break;
        case 700: act(2, { t: 'release' }); break;
        case 800: P(2).core = 30.05; break;
        case 880: act(0, { t: 'debug', cmd: 'tp', args: [P(2).x + 1, P(2).z] }); break;
        case 1200: act(0, { t: 'drop', item: 'stick', n: 1 }); break;
        case 1210: act(0, { t: 'give', to: ids[1], item: 'matches', n: 2 }); break;
        case 1300: P(1).health = 0; break;
        case 1310: act(1, { t: 'consume', item: 'bandage' }); break;
        case 1500: P(1).bleed = 0.05; break;
        case 1520: act(1, { t: 'respawn' }); break;
        case 1600: act(0, { t: 'debug', cmd: 'storm', args: [-1] }); break;
      }
      for (const e of sim.step()) evs.push(e);
    }
    return evs;
  }

  it('is deterministic, survives a save at any point, and stays plain JSON', () => {
    const a = newGame(), b = newGame();
    const ea = drive(a.sim, a.ids, 0, 1800);
    const eb = drive(b.sim, b.ids, 0, 1800);
    expect(b.sim.serialize()).toBe(a.sim.serialize());
    expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
    // the run did what it was meant to
    const kinds = new Set(ea.map((e) => e.t));
    for (const k of ['fireBuilt', 'fireFed', 'swing', 'logLift', 'logDrop', 'downed', 'revived', 'died', 'pickup', 'hurt'] as const) {
      expect(kinds.has(k), k).toBe(true);
    }
    expect(kinds.has('fireLit') || kinds.has('igniteFail')).toBe(true);
    expect(jsonIssues(a.sim.state)).toEqual([]);
    expect(JSON.parse(a.sim.serialize())).toStrictEqual(a.sim.state);

    for (const at of [250, 520, 950, 1505]) {
      const x = newGame();
      drive(x.sim, x.ids, 0, at);
      const save = x.sim.serialize();
      const y = Sim.fromState(world, save, { seed: 0, debug: true });
      const ex = drive(x.sim, x.ids, at, 1800);
      const ey = drive(y, x.ids, at, 1800);
      expect(y.serialize(), `save at ${at}`).toBe(x.sim.serialize());
      expect(JSON.stringify(ey)).toBe(JSON.stringify(ex));
    }
  });

  it('cleans every per-player var when players leave', () => {
    const g = newGame();
    drive(g.sim, g.ids, 0, 1000);
    for (const id of g.ids) g.sim.removePlayer(id);
    const left = Object.keys(g.sim.state.vars).filter((k) => g.ids.some((id) => k.endsWith('.' + id)));
    expect(left).toEqual([]);
  });
});
