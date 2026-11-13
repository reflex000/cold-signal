import { describe, expect, it, vi } from 'vitest';
import { makeLog, makePlayer, makeWolf } from '../entities';
import { SWIM_SPEED } from '../move';
import { Sim } from '../sim';
import { cmd, jsonIssues } from '../testkit';
import { createTestWorld, TEST_SAFE, TEST_THIN } from '../testworld';
import { BTN, type InputCmd, type PlayerEnt, type SimEvent } from '../types';
import {
  bodyLoad, climbTime, ICE_RELAX, iceDanger, onOpenWater, PULL_RANGE, PULL_TIME, SCAR, SKIN_MAX, SKIN_WALK, stressRate,
} from './ice';
import { SYSTEMS } from './index';

// minutes of game time with every system on (the wolves too): room for a busy machine
vi.setConfig({ testTimeout: 30_000 });

const world = createTestWorld();
const lake = world.lake;
/** The middle of a cell in the thin patch's core (0.05 m). */
const CORE = { x: TEST_THIN.x + 1, z: TEST_THIN.z + 1 };
/** Middling ice, about 0.33 m: holds anyone. */
const MIDDLING = { x: 21, z: 109 };
/** The thin end of middling ice, about 0.15 m. */
const MARGIN = { x: 5, z: 121 };

function setup(n = 1, systems = SYSTEMS) {
  const sim = new Sim(world, { seed: 17, debug: true, players: n }, systems);
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [0] });
  return { sim, ps, p: ps[0] };
}
const tp = (sim: Sim, p: PlayerEnt, x: number, z: number) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
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
const maxStress = (sim: Sim) => sim.state.ice.reduce((m, c) => Math.max(m, c.hole ? 0 : c.stress), 0);
const cellBox = (i: number) => {
  const cx = i % lake.n, cz = Math.floor(i / lake.n);
  return { x0: lake.minX + cx * lake.cell, z0: lake.minZ + cz * lake.cell, x1: lake.minX + (cx + 1) * lake.cell, z1: lake.minZ + (cz + 1) * lake.cell };
};
/** Open a hole in the cell under (x, z). */
function hole(sim: Sim, x: number, z: number): number {
  const i = world.iceCell(x, z);
  sim.state.ice.push({ i, stress: 1, hole: true, skin: 0 });
  return i;
}
/** Put a player into an open hole at (x, z): they walk onto the open water and go in. */
function inTheWater(sim: Sim, p: PlayerEnt, x: number, z: number): void {
  tp(sim, p, x, z);
  input(sim, p);
  sim.step();
  expect(p.swim).toBe(true);
}

describe('ice: loads and stress', () => {
  it('weighs people by what they do: running, a heavy log and company add, lying flat spreads it', () => {
    const p = makePlayer('A', 0, 0, 0, 0);
    const still = bodyLoad(p);
    p.vz = -2.6;
    const walk = bodyLoad(p);
    p.vz = -4.6;
    const sprint = bodyLoad(p);
    p.vz = 0;
    p.carry = 9;
    const drag = bodyLoad(p);
    p.carryPair = true;
    const pair = bodyLoad(p);
    p.carry = 0;
    p.life = 'downed';
    const flat = bodyLoad(p);
    expect(still).toBe(1);
    expect(walk).toBeGreaterThan(still);
    expect(sprint).toBeGreaterThan(walk);
    expect(drag).toBeGreaterThan(pair);
    expect(pair).toBeGreaterThan(still);
    expect(flat).toBeLessThan(still);
    // the stress law: nothing below the onset, then faster and faster
    expect(stressRate(0.5)).toBe(0);
    expect(stressRate(2)).toBeGreaterThan(stressRate(1.2));
    expect(stressRate(5) / stressRate(2.5)).toBeGreaterThan(2);
  });

  it('the pole-marked safe line holds: a log carried by two, a third close by and running, not a creak', () => {
    const { sim, ps } = setup(3);
    const y = TEST_SAFE.az;
    tp(sim, ps[0], -24, y);
    tp(sim, ps[1], -26.6, y);
    tp(sim, ps[2], -25, y + 0.8);
    for (const q of ps) expect(world.iceAt(q.x, q.z)).toBeGreaterThanOrEqual(0.55);
    const log = sim.ctx.spawn(makeLog(-25.3, 0, y, { yaw: Math.PI / 2, len: 2.6 }));
    sim.act(ps[0].id, { t: 'carry', log: log.id });
    sim.act(ps[1].id, { t: 'carry', log: log.id });
    expect(ps[0].carryPair).toBe(true);
    // east along the poles (the third one running), braking (ice is slow to stop on), then standing
    const t0 = sim.state.tick;
    const evs = run(sim, 24, () => {
      const t = (sim.state.tick - t0) / 30;
      for (const q of ps) {
        if (t < 3) input(sim, q, { mz: 1, yaw: yawTo(1, 0), b: q === ps[2] ? BTN.SPRINT : 0 });
        else if (t < 5 && Math.hypot(q.vx, q.vz) > 0.3) input(sim, q, { mz: -1, yaw: yawTo(1, 0) });
        else input(sim, q, { yaw: yawTo(1, 0) });
      }
    });
    expect(ps[2].x).toBeGreaterThan(-18);
    for (const q of ps) expect(Math.abs(q.z - y) < TEST_SAFE.half && q.x > TEST_SAFE.ax && q.x < TEST_SAFE.bx).toBe(true);
    expect(of(evs, 'iceCreak')).toEqual([]);
    expect(of(evs, 'iceBreak')).toEqual([]);
    expect(sim.state.ice).toEqual([]);
  });

  it('middling ice holds one person running; two standing together on its thin margin make it groan', () => {
    const { sim, p } = setup();
    tp(sim, p, -5, 98);
    const evs = run(sim, 6, () => input(sim, p, { mz: 1, yaw: yawTo(1, 0), b: BTN.SPRINT }));
    expect(p.sprint || p.stamina < 1).toBe(true);
    expect(of(evs, 'iceCreak')).toEqual([]);
    expect(sim.state.ice).toEqual([]);

    const one = setup();
    tp(one.sim, one.p, MARGIN.x, MARGIN.z);
    expect(world.iceAt(MARGIN.x, MARGIN.z)).toBeLessThan(0.17);
    run(one.sim, 10, () => input(one.sim, one.p));
    const alone = maxStress(one.sim);

    const two = setup(2);
    tp(two.sim, two.ps[0], MARGIN.x, MARGIN.z);
    tp(two.sim, two.ps[1], MARGIN.x + 0.6, MARGIN.z);
    const evs2 = run(two.sim, 10, () => two.ps.forEach((q) => input(two.sim, q)));
    const together = maxStress(two.sim);
    expect(alone).toBeLessThan(0.08);
    expect(together).toBeGreaterThan(0.3);
    expect(together).toBeGreaterThan(alone * 4);
    expect(of(evs2, 'iceCreak').length).toBeGreaterThan(2);
  });

  it('relaxes slowly once nobody is on it, and the cell drops out of the list', () => {
    const { sim, ps } = setup(2);
    tp(sim, ps[0], MARGIN.x, MARGIN.z);
    tp(sim, ps[1], MARGIN.x + 0.6, MARGIN.z);
    run(sim, 6, () => ps.forEach((q) => input(sim, q)));
    const s0 = maxStress(sim);
    expect(s0).toBeGreaterThan(0.2);
    tp(sim, ps[0], -20, TEST_SAFE.az);
    tp(sim, ps[1], -22, TEST_SAFE.az);
    run(sim, 10, () => ps.forEach((q) => input(sim, q)));
    expect(maxStress(sim)).toBeCloseTo(s0 - 10 * ICE_RELAX, 1);
    run(sim, s0 / ICE_RELAX, () => ps.forEach((q) => input(sim, q)));
    expect(sim.state.ice).toEqual([]);
  });
});

describe('ice: creaking and breaking', () => {
  it('thin ice creaks louder and louder under someone who stays, warns them once, then breaks under them', () => {
    const { sim, p } = setup();
    tp(sim, p, CORE.x, CORE.z);
    expect(world.iceAt(CORE.x, CORE.z)).toBeLessThan(0.06);
    const evs = run(sim, 10, () => input(sim, p), () => p.swim);
    const creaks = of(evs, 'iceCreak');
    expect(creaks.length).toBeGreaterThanOrEqual(5);
    for (let k = 1; k < creaks.length; k++) expect(creaks[k].stress).toBeGreaterThan(creaks[k - 1].stress);
    expect(creaks[creaks.length - 1].stress).toBeGreaterThan(0.85);
    const warns = of(evs, 'toast').filter((e) => e.to === p.id && e.kind === 'warn' && /groans/.test(e.text));
    expect(warns.length).toBe(1);
    expect(evs.indexOf(warns[0])).toBeLessThan(evs.indexOf(of(evs, 'iceBreak')[0]));
    // the break: under their feet, a hole, into the water, soaked at once
    const brk = of(evs, 'iceBreak');
    expect(brk.length).toBe(1);
    expect(world.iceCell(brk[0].x, brk[0].z)).toBe(world.iceCell(CORE.x, CORE.z));
    const cell = sim.state.ice.find((c) => c.i === world.iceCell(CORE.x, CORE.z))!;
    expect(cell.hole).toBe(true);
    expect(p.swim).toBe(true);
    expect(p.wet).toBe(1);
    expect(of(evs, 'splash')).toEqual([{ t: 'splash', id: p.id, x: p.x, z: p.z }]);
    expect(onOpenWater(sim.ctx, CORE.x, CORE.z)).toBe(true);
    // the cold water takes the heat out fast
    const c0 = p.core;
    run(sim, 20, () => input(sim, p));
    expect(c0 - p.core).toBeGreaterThan(0.9);
    expect(p.surface).toBe('water');
  });

  it('the first creak comes in time: turn back at once and you get off; walk on and you go through', () => {
    /** Walk east into the thin patch from middling ice; with `turn`, head back at the first creak. */
    const walk = (turn: boolean) => {
      const { sim, p } = setup();
      tp(sim, p, TEST_THIN.x - 14, TEST_THIN.z);
      let back = false, xAtCreak = NaN;
      const evs: SimEvent[] = [];
      for (let i = 0; i < 30 * 14 && !p.swim; i++) {
        input(sim, p, { mz: 1, yaw: back ? yawTo(-1, 0) : yawTo(1, 0) });
        for (const e of sim.step()) {
          evs.push(e);
          if (e.t === 'iceCreak' && Number.isNaN(xAtCreak)) {
            xAtCreak = p.x;
            back = turn;
          }
        }
      }
      return { p, evs, xAtCreak };
    };
    const core = TEST_THIN.x - TEST_THIN.r * 0.45;
    // straight on: warned well before the thin core, then through
    const on = walk(false);
    expect(on.xAtCreak).toBeLessThan(core - 1.5);
    expect(on.p.swim).toBe(true);
    const first = of(on.evs, 'iceCreak')[0], brk = of(on.evs, 'iceBreak')[0];
    expect(on.evs.indexOf(first)).toBeLessThan(on.evs.indexOf(brk));
    // turning round at the first creak: it keeps groaning while you slide, and holds
    const back = walk(true);
    expect(of(back.evs, 'iceCreak').length).toBeGreaterThan(1);
    expect(of(back.evs, 'iceBreak')).toEqual([]);
    expect(back.p.swim).toBe(false);
    expect(back.p.x).toBeLessThan(TEST_THIN.x - TEST_THIN.r);
  });

  it('wolves make the ice talk but never break it on their own', () => {
    const { sim } = setup(1, SYSTEMS.filter((s) => s.name !== 'wolves'));
    const wf = sim.ctx.spawn(makeWolf(CORE.x, 0, CORE.z, { pack: 0 }));
    const evs = run(sim, 30);
    expect(sim.ctx.get(wf.id)).toBeDefined();
    const c = sim.state.ice.find((q) => q.i === world.iceCell(CORE.x, CORE.z));
    expect(c && c.stress).toBeGreaterThan(0.5);
    expect(c!.stress).toBeLessThan(1);
    expect(c!.hole).toBe(false);
    expect(of(evs, 'iceBreak')).toEqual([]);
    expect(of(evs, 'iceCreak').length).toBeGreaterThan(0);
  });

  it('says how dangerous a spot is: open water, thin ice, stressed ice, the safe line, dry land', () => {
    const { sim } = setup();
    hole(sim, MIDDLING.x, MIDDLING.z);
    expect(iceDanger(sim.ctx, MIDDLING.x, MIDDLING.z)).toBe(1);
    expect(iceDanger(sim.ctx, CORE.x, CORE.z)).toBeGreaterThan(0.9);
    expect(iceDanger(sim.ctx, -20, TEST_SAFE.az)).toBe(0);
    expect(iceDanger(sim.ctx, 0, 0)).toBe(0);
    expect(iceDanger(sim.ctx, MIDDLING.x + 4, MIDDLING.z)).toBe(0);
  });
});

describe('ice: in the water', () => {
  it('swims slowly and stays inside the open water', () => {
    const { sim, p } = setup();
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    inTheWater(sim, p, MIDDLING.x, MIDDLING.z);
    const b = cellBox(i);
    let top = 0;
    run(sim, 6, () => {
      input(sim, p, { mz: 1, yaw: yawTo(1, 0.3) });
      top = Math.max(top, Math.hypot(p.vx, p.vz));
    });
    expect(p.swim).toBe(true);
    expect(top).toBeLessThanOrEqual(SWIM_SPEED + 1e-6);
    expect(p.x).toBeGreaterThan(b.x0);
    expect(p.x).toBeLessThan(b.x1);
    expect(p.z).toBeGreaterThan(b.z0);
    expect(p.z).toBeLessThan(b.z1);
    expect(p.x).toBeGreaterThan(b.x1 - 0.5); // pressed up against the east edge
    expect(p.y).toBeLessThan(lake.level - 1);
  });

  it('climbs out at an edge with a hold of USE, not from the middle, not without holding on', () => {
    const { sim, p } = setup();
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    inTheWater(sim, p, MIDDLING.x, MIDDLING.z);
    const b = cellBox(i);
    // the middle of a 2 m hole is out of reach of every edge
    run(sim, 4, () => input(sim, p, { b: BTN.USE }));
    expect(p.swim).toBe(true);
    // at the west edge: a few taps do nothing, a hold climbs out
    p.x = b.x0 + 0.45;
    p.z = MIDDLING.z;
    run(sim, 3, () => input(sim, p, { b: sim.state.tick % 20 < 10 ? BTN.USE : 0 }));
    expect(p.swim).toBe(true);
    const need = climbTime(p.core);
    const evs = run(sim, need + 1, () => input(sim, p, { b: BTN.USE }), () => !p.swim);
    expect(p.swim).toBe(false);
    expect(p.onGround).toBe(true);
    expect(p.x).toBeLessThan(b.x0);
    expect(p.y).toBeCloseTo(lake.level, 5);
    expect(p.act).toBe('none');
    expect(p.wet).toBe(1);
    expect(of(evs, 'toast').some((e) => e.to === p.id && /drag yourself out/.test(e.text))).toBe(true);
    // and the hole stays
    expect(sim.state.ice.find((c) => c.i === i)!.hole).toBe(true);
  });

  it('a teammate within 2 m holding USE on the swimmer hauls them out; from further away they cannot', () => {
    const { sim, ps } = setup(2);
    const [s, q] = ps;
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    inTheWater(sim, s, MIDDLING.x, MIDDLING.z);
    // too far
    tp(sim, q, MIDDLING.x, MIDDLING.z - (PULL_RANGE + 0.9));
    run(sim, PULL_TIME + 1, () => {
      input(sim, s);
      input(sim, q, { b: BTN.USE, focus: s.id });
    });
    expect(s.swim).toBe(true);
    expect(q.act).toBe('none');
    // close enough
    tp(sim, q, MIDDLING.x, MIDDLING.z - 1.6);
    let saw = false;
    const evs = run(sim, PULL_TIME + 1, () => {
      input(sim, s);
      input(sim, q, { b: BTN.USE, focus: s.id });
      if (q.act === 'use' && s.act === 'climbOut') saw = true;
    }, () => !s.swim);
    expect(saw).toBe(true);
    expect(s.swim).toBe(false);
    expect(Math.hypot(s.x - q.x, s.z - q.z)).toBeLessThan(1);
    expect(world.iceCell(s.x, s.z)).not.toBe(i);
    expect(q.act).toBe('none');
    expect(of(evs, 'toast').some((e) => e.to === s.id && /hauls you out/.test(e.text))).toBe(true);
  });

  it('the hole refreezes thinly over minutes, and goes again under the next person', () => {
    const { sim, p } = setup();
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    tp(sim, p, -20, TEST_SAFE.az);
    run(sim, 90, () => input(sim, p));
    const c = sim.state.ice.find((q) => q.i === i)!;
    expect(c.hole).toBe(true); // still open after a minute and a half
    run(sim, 240, () => input(sim, p));
    expect(c.hole).toBe(false);
    expect(c.skin!).toBeGreaterThanOrEqual(SKIN_WALK);
    expect(c.skin!).toBeLessThanOrEqual(SKIN_MAX);
    expect(c.stress).toBeGreaterThanOrEqual(SCAR);
    expect(iceDanger(sim.ctx, MIDDLING.x, MIDDLING.z)).toBeGreaterThan(0.9);
    // someone walks onto it
    tp(sim, p, MIDDLING.x, MIDDLING.z);
    const evs = run(sim, 3, () => input(sim, p), () => p.swim);
    expect(p.swim).toBe(true);
    expect(of(evs, 'iceBreak').length).toBe(1);
    expect(c.hole).toBe(true);
    expect(c.skin).toBe(0);
  });

  it('nobody can keep a hole from skinning over while they are in it: it stays open', () => {
    const { sim, p } = setup();
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    inTheWater(sim, p, MIDDLING.x, MIDDLING.z);
    run(sim, 300, () => input(sim, p));
    // (long dead of the cold by now, still in the water)
    expect(sim.state.ice.find((q) => q.i === i)!.hole).toBe(true);
    expect(p.swim).toBe(true);
  });
});

describe('ice: state', () => {
  it('is plain JSON and a game saved with someone in the water continues exactly', () => {
    const script = (sim: Sim, ps: PlayerEnt[], t: number) => {
      input(sim, ps[0], { mz: t % 90 < 45 ? 0.6 : 0, yaw: yawTo(-1, 0), b: t > 150 ? BTN.USE : 0 });
      input(sim, ps[1], { mz: t < 60 ? 1 : 0, yaw: yawTo(1, 0), b: t > 200 ? BTN.USE : 0, focus: t > 200 ? ps[0].id : 0 });
    };
    const make = () => {
      const g = setup(2);
      tp(g.sim, g.ps[0], CORE.x, CORE.z);
      tp(g.sim, g.ps[1], CORE.x - 5, CORE.z);
      return g;
    };
    const a = make();
    for (let t = 0; t < 120; t++) {
      script(a.sim, a.ps, a.sim.state.tick);
      a.sim.step();
    }
    expect(a.ps[0].swim).toBe(true);
    expect(jsonIssues(a.sim.state)).toEqual([]);
    const save = a.sim.serialize();
    const b = Sim.fromState(world, save, { seed: 0, debug: true });
    const bps = [b.ctx.get<PlayerEnt>(a.ps[0].id)!, b.ctx.get<PlayerEnt>(a.ps[1].id)!];
    const ea: SimEvent[] = [], eb: SimEvent[] = [];
    for (let t = 0; t < 240; t++) {
      script(a.sim, a.ps, a.sim.state.tick);
      ea.push(...a.sim.step());
      script(b, bps, b.state.tick);
      eb.push(...b.step());
    }
    expect(b.serialize()).toBe(a.sim.serialize());
    expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
    expect(JSON.parse(a.sim.serialize())).toStrictEqual(a.sim.state);
  });

  it('leaves cells it has no ice for alone, and cleans up after a player who leaves', () => {
    const { sim, ps } = setup(2);
    sim.state.ice.push({ i: 40, stress: 0.5, hole: false }); // off the lake in this world
    expect(lake.thickness[40]).toBe(0);
    const i = hole(sim, MIDDLING.x, MIDDLING.z);
    inTheWater(sim, ps[1], MIDDLING.x, MIDDLING.z);
    run(sim, 2, () => ps.forEach((q) => input(sim, q)));
    expect(sim.state.ice.find((c) => c.i === 40)).toEqual({ i: 40, stress: 0.5, hole: false });
    sim.removePlayer(ps[1].id);
    expect(Object.keys(sim.state.vars).filter((k) => k.endsWith('.' + ps[1].id))).toEqual([]);
    expect(sim.state.ice.find((c) => c.i === i)!.hole).toBe(true);
  });
});
