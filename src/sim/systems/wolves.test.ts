import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../../core/math';
import type { System } from '../api';
import { makeFire, makeFlare, makeWolf } from '../entities';
import { EYE_STAND } from '../move';
import { Sim } from '../sim';
import { cmd, jsonIssues, scriptCmd } from '../testkit';
import { createTestWorld } from '../testworld';
import { BTN, type FireEnt, type FlareEnt, type InputCmd, type PlayerEnt, type SimEvent, type WolfEnt } from '../types';
import { SYSTEMS } from './index';
import {
  CIRCLE_MAX, CIRCLE_MIN, DEAD_STAY, FLARE_FEAR, PHASE, SCATTER_KILL, WOLF_GALLOP, WOLF_HEAD, damageWolf, fireFear, packPhase, packTarget,
  spawnPack, wolves,
} from './wolves';

const world = createTestWorld();

interface Rig { sim: Sim; ps: PlayerEnt[]; p: PlayerEnt }

function setup(o: { n?: number; clock?: number; storm?: number; seed?: number; systems?: System[]; den?: boolean } = {}): Rig {
  const n = o.n ?? 1;
  const sim = new Sim(world, { seed: o.seed ?? 41, debug: true, players: n }, o.systems ?? SYSTEMS);
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  const p = ps[0];
  sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(p.id, { t: 'debug', cmd: 'lockClock', args: [1] });
  sim.act(p.id, { t: 'debug', cmd: 'storm', args: [o.storm ?? 0] });
  sim.act(p.id, { t: 'debug', cmd: 'clock', args: [o.clock ?? 22] });
  // the test world's own pack (it wakes at 300 s) stays asleep unless a test wants it
  if (!o.den) sim.state.vars['wolves.aw.0'] = 1;
  return { sim, ps, p };
}

function place(sim: Sim, p: PlayerEnt, x: number, z: number, yaw = 0): void {
  sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw }));
}

function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    each?.();
    out.push(...sim.step());
  }
  return out;
}

/** Step until `done` (checked before each tick) or `max` seconds; returns the seconds it took (Infinity if never). */
function until(sim: Sim, max: number, done: () => boolean, each?: () => void): number {
  for (let i = 0; i < max * 30; i++) {
    if (done()) return i / 30;
    each?.();
    sim.step();
  }
  return done() ? max : Infinity;
}

/** A pack of `n` at (x, z) through the debug action; returns its pack index. */
function debugPack(sim: Sim, p: PlayerEnt, x: number, z: number, n: number): number {
  const k = Math.max(world.spawn.packs.length, sim.ctx.v('wolves.next', world.spawn.packs.length));
  expect(sim.act(p.id, { t: 'debug', cmd: 'wolves', args: [x, z, n] })).toBe(true);
  return k;
}

const living = (sim: Sim) => sim.ctx.all('wolf').filter((w) => w.mood !== 'dead');
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const of = <T extends SimEvent['t']>(evs: SimEvent[], t: T) => evs.filter((e) => e.t === t) as Extract<SimEvent, { t: T }>[];
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** A lone player at (0, 40) facing north at night; a hungry pack of four coming from `from` metres north. */
function hunt(o: { clock?: number; storm?: number; from?: number; seed?: number } = {}) {
  const r = setup({ clock: o.clock ?? 22, storm: o.storm ?? 0, seed: o.seed });
  place(r.sim, r.p, 0, 40, 0);
  const k = debugPack(r.sim, r.p, -20, 40 - (o.from ?? 80), 4);
  return { ...r, k };
}

function litFire(sim: Sim, x: number, z: number): FireEnt {
  const f = sim.ctx.spawn<FireEnt>(makeFire('campfire', x, world.heightAt(x, z), z, { shelter: 0.6 }));
  f.lit = true;
  f.heat = 0.9;
  sim.ctx.setV('fire.wood.' + f.id, 1400);
  return f;
}

describe('wolves: packs', () => {
  it('a pack wakes at its time with a howl and an alpha, with more wolves for more players', () => {
    const def = world.spawn.packs[0];
    for (const [n, want] of [[1, def.count], [2, def.count + 1], [3, def.count + 2]] as const) {
      const r = setup({ n, den: true });
      r.ps.forEach((p, i) => place(r.sim, p, 40 + 2 * i, 60));
      run(r.sim, def.wakeAt - 1);
      expect(r.sim.ctx.all('wolf')).toHaveLength(0);
      const evs = run(r.sim, 2);
      const ws = r.sim.ctx.all('wolf');
      expect(ws).toHaveLength(want);
      expect(ws.filter((w) => w.alpha)).toHaveLength(1);
      for (const w of ws) {
        expect(w.pack).toBe(0);
        expect(dist(w, def)).toBeLessThan(15);
      }
      const alpha = ws.find((w) => w.alpha)!;
      const howls = of(evs, 'howl');
      expect(howls.length).toBeGreaterThanOrEqual(1);
      expect(howls[0]).toMatchObject({ id: alpha.id, pack: 0 });
      expect(dist(howls[0], alpha)).toBeLessThan(0.5);
    }
  });

  it('walking up to a den wakes its pack early', () => {
    const def = world.spawn.packs[0];
    const r = setup({ den: true });
    place(r.sim, r.p, 40, 60);
    run(r.sim, 70);
    expect(r.sim.ctx.all('wolf')).toHaveLength(0);
    place(r.sim, r.p, def.x + 30, def.z);
    run(r.sim, 1.5);
    expect(r.sim.ctx.all('wolf').length).toBe(def.count);
  });

  it('other packs answer a howl from afar', () => {
    const r = setup();
    place(r.sim, r.p, 150, 150);
    const a = debugPack(r.sim, r.p, -150, -150, 3);
    run(r.sim, 40);
    const b = debugPack(r.sim, r.p, -150, 120, 3);
    const evs: { t: number; pack: number }[] = [];
    const t0 = r.sim.state.env.t;
    run(r.sim, 9);
    for (const e of of(run(r.sim, 0), 'howl')) evs.push({ t: 0, pack: e.pack });
    // replay to time them
    const r2 = setup();
    place(r2.sim, r2.p, 150, 150);
    debugPack(r2.sim, r2.p, -150, -150, 3);
    run(r2.sim, 40);
    debugPack(r2.sim, r2.p, -150, 120, 3);
    const times: { t: number; pack: number }[] = [];
    for (let i = 0; i < 9 * 30; i++) for (const e of of(r2.sim.step(), 'howl')) times.push({ t: r2.sim.state.env.t - t0, pack: e.pack });
    const first = times.find((h) => h.pack === b)!;
    const reply = times.find((h) => h.pack === a)!;
    expect(first).toBeDefined();
    expect(reply).toBeDefined();
    expect(reply.t - first.t).toBeGreaterThan(2);
    expect(reply.t - first.t).toBeLessThan(7.5);
    void evs;
  });
});

describe('wolves: the hunt', () => {
  /** Distances of stalking wolves (once settled) and circling wolves, sampled four times a second. */
  function sampleHunt(h: ReturnType<typeof hunt>, seconds: number) {
    const stalk: number[] = [], circle: number[] = [];
    let ph = -1, inPh = 0, i = 0;
    run(h.sim, seconds, () => {
      const now = packPhase(h.sim.ctx, h.k);
      inPh = now === ph ? inPh + 1 : 0;
      ph = now;
      if (i++ % 8 !== 0) return;
      for (const w of living(h.sim)) {
        const d = dist(w, h.p);
        if (now === PHASE.stalk && inPh > 12 * 30 && w.mood === 'stalk') stalk.push(d);
        if (now === PHASE.circle && inPh > 8 * 30 && w.mood === 'circle') circle.push(d);
      }
    });
    return { stalk, circle };
  }

  it('a hungry pack stalks at the edge of sight (closer in the whiteout), then circles at 15 to 30 m', () => {
    const night = sampleHunt(hunt(), 150);
    expect(night.stalk.length).toBeGreaterThan(20);
    expect(night.stalk.filter((d) => d > 25).length / night.stalk.length).toBeGreaterThan(0.85);
    expect(Math.min(...night.stalk)).toBeGreaterThan(12);
    expect(night.circle.length).toBeGreaterThan(20);
    const inRing = night.circle.filter((d) => d > CIRCLE_MIN - 3 && d < CIRCLE_MAX + 3).length / night.circle.length;
    expect(inRing).toBeGreaterThan(0.8);

    const white = sampleHunt(hunt({ storm: 1, from: 50 }), 120);
    expect(white.stalk.length).toBeGreaterThan(10);
    expect(median(white.stalk)).toBeLessThan(median(night.stalk) - 15);
    expect(median(white.stalk)).toBeGreaterThan(8);
  });

  it('at night a lone player in the open is circled and feinted at, then charged and bitten', () => {
    const h = hunt();
    const moods = new Set<string>();
    let firstBite = Infinity;
    const evs: SimEvent[] = [];
    for (let i = 0; i < 150 * 30; i++) {
      for (const w of living(h.sim)) moods.add(w.mood);
      const e = h.sim.step();
      if (firstBite === Infinity && e.some((x) => x.t === 'bite')) firstBite = i / 30;
      evs.push(...e);
    }
    for (const m of ['howl', 'stalk', 'circle', 'feint', 'charge', 'bite']) expect(moods.has(m), m).toBe(true);
    expect(firstBite).toBeGreaterThan(30); // they stalk and test first
    const bites = of(evs, 'bite').filter((b) => b.target === h.p.id);
    expect(bites.length).toBeGreaterThan(0);
    const hurts = of(evs, 'hurt').filter((x) => x.id === h.p.id);
    expect(hurts.length).toBeGreaterThan(0);
    expect(hurts.every((x) => x.cause === 'wolf')).toBe(true);
    expect(h.p.health).toBeLessThan(100);
  });

  it('two together are circled but not charged', () => {
    const r = setup({ n: 2 });
    place(r.sim, r.ps[0], 0, 40, 0);
    place(r.sim, r.ps[1], 1.5, 40.5, 1);
    debugPack(r.sim, r.p, -20, -40, 4);
    const evs = run(r.sim, 150);
    expect(of(evs, 'bite')).toHaveLength(0);
    expect(r.ps.every((p) => p.health === 100)).toBe(true);
  });

  it('the pack picks the lone player over two together, and passes over the one in the firelight', () => {
    const r = setup({ n: 3 });
    place(r.sim, r.ps[0], 0, 40, 0);
    place(r.sim, r.ps[1], 1.5, 40.5, 0);
    place(r.sim, r.ps[2], 40, 40, 0);
    const k = debugPack(r.sim, r.p, 20, -40, 4);
    expect(until(r.sim, 40, () => packTarget(r.sim.ctx, k) !== 0)).toBeLessThan(40);
    expect(packTarget(r.sim.ctx, k)).toBe(r.ps[2].id);

    const s = setup({ n: 2 });
    place(s.sim, s.ps[0], 0, 40, 0);
    place(s.sim, s.ps[1], 40, 40, 0);
    litFire(s.sim, 1.5, 40);
    const k2 = debugPack(s.sim, s.p, 20, -40, 4);
    const seen = new Set<number>();
    run(s.sim, 90, () => {
      const t = packTarget(s.sim.ctx, k2);
      if (t) seen.add(t);
    });
    expect([...seen]).toEqual([s.ps[1].id]);
    expect(s.ps[0].health).toBe(100);
  });

  it('no wolf crosses the light of a strong fire: the player in it is left alone, the pack waits at the edge, then gives up; a dead fire lets them in', () => {
    const h = hunt();
    expect(until(h.sim, 60, () => packPhase(h.sim.ctx, h.k) === PHASE.stalk)).toBeLessThan(60);
    run(h.sim, 8);
    const f = litFire(h.sim, 1.5, 40);
    let gap = Infinity, held = 0;
    const evs = run(h.sim, 100, () => {
      for (const w of living(h.sim)) gap = Math.min(gap, dist(w, f) - fireFear(f.heat));
      if (packPhase(h.sim.ctx, h.k) === PHASE.stalk && packTarget(h.sim.ctx, h.k) === h.p.id) held++;
    });
    expect(f.lit).toBe(true);
    expect(f.heat).toBeGreaterThan(0.5);
    expect(gap).toBeGreaterThan(-0.3);
    expect(of(evs, 'bite')).toHaveLength(0);
    expect(h.p.health).toBe(100);
    expect(held / 30).toBeGreaterThan(30); // waited at the edge of the light ...
    expect(packTarget(h.sim.ctx, h.k)).toBe(0); // ... and gave up

    // the fire burns out: nothing holds them now
    h.sim.ctx.setV('fire.wood.' + f.id, 2);
    let closest = Infinity;
    run(h.sim, 120, () => {
      for (const w of living(h.sim)) closest = Math.min(closest, dist(w, h.p));
    });
    expect(f.lit).toBe(false);
    expect(closest).toBeLessThan(8);
  });

  it('a gunshot scatters the pack for a while; a kill scatters it for longer', () => {
    const h = hunt();
    h.p.inv.rifle = 1;
    h.p.loaded = 5;
    h.sim.act(h.p.id, { t: 'equip', tool: 'rifle' });
    expect(until(h.sim, 90, () => packPhase(h.sim.ctx, h.k) === PHASE.circle)).toBeLessThan(90);
    run(h.sim, 4);
    const spread = () => living(h.sim).reduce((a, w) => a + dist(w, h.p), 0) / living(h.sim).length;
    const before = spread();
    h.sim.setInput(h.p.id, cmd(h.sim.state.tick + 1, { yaw: 0, pitch: 0.6, b: BTN.PRIMARY }));
    const evs = h.sim.step();
    h.sim.setInput(h.p.id, cmd(h.sim.state.tick + 1, { yaw: 0, pitch: 0.6 }));
    expect(of(evs, 'shot')).toHaveLength(1);
    h.sim.step();
    expect(packPhase(h.sim.ctx, h.k)).toBe(PHASE.scatter);
    expect(living(h.sim).every((w) => w.mood === 'flee')).toBe(true);
    run(h.sim, 6);
    expect(spread()).toBeGreaterThan(before + 25);
    const lasted = 6 + until(h.sim, 60, () => packPhase(h.sim.ctx, h.k) !== PHASE.scatter);
    expect(lasted).toBeGreaterThan(12);
    expect(lasted).toBeLessThan(36);

    // a kill: longer
    run(h.sim, 2);
    const w = living(h.sim)[0];
    damageWolf(h.sim.ctx, w, 999, h.p, 'rifle');
    const evs2 = h.sim.step();
    expect(of(evs2, 'wolfDie').map((e) => e.id)).toEqual([w.id]);
    expect(packPhase(h.sim.ctx, h.k)).toBe(PHASE.scatter);
    expect(until(h.sim, 120, () => packPhase(h.sim.ctx, h.k) !== PHASE.scatter)).toBeGreaterThan(SCATTER_KILL - 1.5);
  });

  it('a downed player is bitten and dragged off', () => {
    const h = hunt({ from: 40 });
    h.p.health = 0; // vitals takes them down next tick
    run(h.sim, 0.2);
    expect(h.p.life).toBe('downed');
    const x0 = h.p.x, z0 = h.p.z;
    let moved = 0, dragged = false;
    const evs = run(h.sim, 50, () => {
      moved = Math.max(moved, Math.hypot(h.p.x - x0, h.p.z - z0));
      if (living(h.sim).some((w) => w.mood === 'drag' && w.target === h.p.id)) dragged = true;
    });
    expect(dragged).toBe(true);
    expect(of(evs, 'bite').filter((b) => b.target === h.p.id).length).toBeGreaterThan(0);
    expect(of(evs, 'hurt').filter((x) => x.id === h.p.id).every((x) => x.cause === 'wolf')).toBe(true);
    expect(moved).toBeGreaterThan(3);
  });

  it('a burning flare breaks the circle and holds the pack off while it burns', () => {
    const h = hunt();
    expect(until(h.sim, 90, () => packPhase(h.sim.ctx, h.k) === PHASE.circle)).toBeLessThan(90);
    run(h.sim, 3);
    const f = h.sim.ctx.spawn<FlareEnt>(makeFlare(h.p.x + 2, world.heightAt(h.p.x + 2, h.p.z), h.p.z, 0, 0, 0, h.p.id));
    f.landed = true;
    run(h.sim, 1);
    expect(packPhase(h.sim.ctx, h.k)).toBe(PHASE.stalk);
    run(h.sim, 3);
    let closest = Infinity;
    const evs = run(h.sim, 30, () => {
      for (const w of living(h.sim)) closest = Math.min(closest, dist(w, f));
    });
    expect(f.life).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(FLARE_FEAR - 0.5);
    expect(of(evs, 'bite')).toHaveLength(0);
  });

  it('the flashlight beam in its face makes a charging wolf hesitate; in the dark it comes on and bites', () => {
    const charge = (lit: boolean, seed: number) => {
      const r = setup({ seed });
      place(r.sim, r.p, 30, 60, 0);
      if (lit) r.sim.act(r.p.id, { t: 'toggleLight' });
      r.sim.step();
      const w = r.sim.ctx.spawn<WolfEnt>(makeWolf(30, 0, 28, { pack: 20, yaw: Math.PI }));
      w.mood = 'charge';
      w.target = r.p.id;
      const moods = new Set<string>();
      let latch = 0;
      run(r.sim, 3.5, () => {
        const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
        const hx = w.x + fx * WOLF_HEAD.fwd, hy = w.y + WOLF_HEAD.y, hz = w.z + fz * WOLF_HEAD.fwd;
        const dx = hx - r.p.x, dy = hy - (r.p.y + EYE_STAND), dz = hz - r.p.z;
        r.sim.setInput(r.p.id, cmd(r.sim.state.tick + 1, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }));
        moods.add(w.mood);
        if (w.mood === 'bite') latch = Math.max(latch, dist(w, r.p));
      });
      return { moods, latch };
    };
    let hesitated = 0, bitten = 0;
    for (const seed of [1, 2, 3]) {
      if (charge(true, seed).moods.has('cower')) hesitated++;
      const dark = charge(false, seed);
      if (dark.moods.has('bite')) bitten++;
      // the lunge stops at the body: it does not slide on past
      expect(dark.latch).toBeLessThan(1.6);
    }
    expect(hesitated).toBeGreaterThanOrEqual(2);
    expect(bitten).toBe(3);
  });
});

describe('wolves: the ground they move on', () => {
  it('never on a steep slope, thin ice, a wall or a trunk; gaits and turns stay in bounds', () => {
    const r = setup();
    place(r.sim, r.p, 0, 168, Math.PI); // south of the lake: the pack must go round its thin middle
    spawnPack(r.sim.ctx, 30, 45, 80, 60, 5, true);
    let bad = 0, fastest = 0, sharpest = 0;
    const yaws = new Map<number, number>();
    run(r.sim, 150, () => {
      for (const w of living(r.sim)) {
        if (!world.walkable(w.x, w.z)) bad++;
        const ice = world.iceAt(w.x, w.z);
        if (ice > 0 && ice < 0.2) bad++;
        fastest = Math.max(fastest, w.speed);
        const y0 = yaws.get(w.id);
        if (y0 !== undefined) sharpest = Math.max(sharpest, Math.abs(wrapAngle(w.yaw - y0)));
        yaws.set(w.id, w.yaw);
      }
    });
    expect(bad).toBe(0);
    expect(fastest).toBeLessThanOrEqual(WOLF_GALLOP + 1e-9);
    expect(sharpest).toBeLessThan(6.5 / 30 + 1e-6);
    // they did get to the far side of the lake (by going round it)
    expect(living(r.sim).some((w) => w.z > 140)).toBe(true);
  });

  it('a dead wolf lies where it fell, then is gone', () => {
    const r = setup({ clock: 12 });
    place(r.sim, r.p, 30, 60);
    const w = r.sim.ctx.spawn<WolfEnt>(makeWolf(-30, 0, 60, { pack: 30 }));
    damageWolf(r.sim.ctx, w, 999, null, 'axe');
    const evs = r.sim.step();
    expect(of(evs, 'wolfDie')).toEqual([{ t: 'wolfDie', id: w.id, x: w.x, y: w.y, z: w.z }]);
    const x = w.x, z = w.z;
    run(r.sim, DEAD_STAY - 1);
    expect(r.sim.ctx.get(w.id)).toBe(w);
    expect(w.mood).toBe('dead');
    expect([w.x, w.z, w.speed]).toEqual([x, z, 0]);
    run(r.sim, 2);
    expect(r.sim.ctx.get(w.id)).toBeUndefined();
  });
});

describe('wolves: determinism', () => {
  function make(): Rig {
    const r = setup({ n: 2, seed: 77 });
    place(r.sim, r.ps[0], 0, 40, 0);
    place(r.sim, r.ps[1], 6, 44, 0);
    const p = r.ps[0];
    p.inv.rifle = 1;
    p.loaded = 5;
    p.inv.flaregun = 1;
    p.flareLoaded = 1;
    debugPack(r.sim, p, -20, -30, 5);
    return r;
  }
  const c0: InputCmd = cmd(0), c1: InputCmd = cmd(0);
  /** Both players for one tick: one walks a script, the other fires a flare at 20 s and a round at 30 s. */
  function drive(r: Rig): void {
    const t = r.sim.state.tick;
    const [p, q] = r.ps;
    if (t === 590) r.sim.act(p.id, { t: 'equip', tool: 'flaregun' });
    if (t === 890) r.sim.act(p.id, { t: 'equip', tool: 'rifle' });
    c0.seq = t + 1;
    c0.yaw = 0.3;
    c0.pitch = 0.25;
    c0.b = t === 600 || t === 900 ? BTN.PRIMARY : 0;
    r.sim.setInput(p.id, c0);
    scriptCmd(1, t, c1);
    c1.seq = t + 1;
    r.sim.setInput(q.id, c1);
    r.sim.step();
  }

  it('two runs agree to the bit with every system on, the state stays plain JSON, and a save resumes the same hunt', () => {
    const a = make(), b = make();
    for (let i = 0; i < 40 * 30; i++) {
      drive(a);
      drive(b);
    }
    expect(a.sim.serialize()).toBe(b.sim.serialize());
    expect(jsonIssues(a.sim.state)).toEqual([]);
    expect(a.sim.ctx.all('wolf').length).toBeGreaterThan(0);
    expect(a.sim.state.stats.shots).toBe(1);
    const saved = a.sim.serialize();
    const c: Rig = { sim: Sim.fromState(world, saved, { seed: 77, debug: true }), ps: [], p: a.p };
    c.ps = a.ps.map((p) => c.sim.ctx.get<PlayerEnt>(p.id)!);
    for (let i = 0; i < 30 * 30; i++) {
      drive(a);
      drive(c);
    }
    expect(c.sim.serialize()).toBe(a.sim.serialize());
    expect(jsonIssues(c.sim.state)).toEqual([]);
  });
});

describe('wolves: cost', () => {
  it('sixteen wolves hunting four players cost well under 0.2 ms a tick', () => {
    let acc = 0, calls = 0;
    const timed: System = {
      ...wolves,
      step(ctx) {
        const t0 = performance.now();
        wolves.step!(ctx);
        acc += performance.now() - t0;
        calls++;
      },
    };
    const r = setup({ n: 4, systems: SYSTEMS.map((s) => (s === wolves ? timed : s)) });
    const spots = [[0, 40], [8, 42], [-30, 60], [30, 70]];
    r.ps.forEach((p, i) => place(r.sim, p, spots[i][0], spots[i][1]));
    for (const [x, z] of [[-50, -40], [45, -40], [-50, 100], [40, -120]]) debugPack(r.sim, r.p, x, z, 4);
    expect(living(r.sim)).toHaveLength(16);
    const c = cmd(0);
    const tick = () => {
      for (let k = 0; k < 4; k++) {
        scriptCmd(k, r.sim.state.tick, c);
        c.seq = r.sim.state.tick + 1;
        c.b &= ~BTN.SPRINT;
        r.sim.setInput(r.ps[k].id, c);
      }
      r.sim.step();
    };
    for (let i = 0; i < 300; i++) tick();
    acc = 0;
    calls = 0;
    for (let i = 0; i < 1500; i++) tick();
    const ms = acc / calls;
    expect(ms, `${ms.toFixed(4)} ms per tick`).toBeLessThan(0.2);
  });
});
