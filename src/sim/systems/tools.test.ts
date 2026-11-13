import { describe, expect, it } from 'vitest';
import { FLARE_LIFE, makeEnv, makePlayer, makeWolf } from '../entities';
import { EYE_STAND } from '../move';
import { Sim } from '../sim';
import { cmd } from '../testkit';
import { createTestWorld, TEST_TREE } from '../testworld';
import { BTN, type FlareEnt, type PartId, type PlayerEnt, type SimEvent, type WolfEnt } from '../types';
import {
  AXE_DAMAGE, BOLT_TIME, CELL_DIM, CELL_SECONDS, CELL_SWAP, CRANK_SECONDS, FLARE_RELOAD, FLARE_SPENT, RELOAD_CLOSE, RELOAD_OPEN,
  RELOAD_ROUND, RIFLE_MAG, beamLevel, radioSignal, rifleSway,
} from './tools';
import { WOLF_BODY } from './wolves';
import { SWING_TIME } from './wood';

const world = createTestWorld();

function setup(n = 1, o: { clock?: number; storm?: number } = {}) {
  const sim = new Sim(world, { seed: 23, debug: true, players: n });
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  const p = ps[0];
  sim.act(p.id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(p.id, { t: 'debug', cmd: 'lockClock', args: [1] });
  sim.act(p.id, { t: 'debug', cmd: 'storm', args: [o.storm ?? 0] });
  sim.act(p.id, { t: 'debug', cmd: 'clock', args: [o.clock ?? 12] });
  // the test world's pack stays asleep: these are the tools' tests (it would wake at 300 s)
  sim.state.vars['wolves.aw.0'] = 1;
  return { sim, ps, p };
}

/** The command for the next tick: look and buttons. */
function input(sim: Sim, p: PlayerEnt, o: { yaw?: number; pitch?: number; b?: number } = {}): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: o.yaw ?? p.yaw, pitch: o.pitch ?? p.pitch, b: o.b ?? 0 }));
}

function stand(sim: Sim, p: PlayerEnt, x: number, z: number, yaw: number, pitch = 0): void {
  sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
  input(sim, p, { yaw, pitch });
  sim.step();
}

function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    each?.();
    out.push(...sim.step());
  }
  return out;
}

/** Hold `b` for one tick, then let go for one. */
function press(sim: Sim, p: PlayerEnt, b: number, look: { yaw?: number; pitch?: number } = {}): SimEvent[] {
  input(sim, p, { ...look, b });
  const evs = sim.step();
  input(sim, p, look);
  return [...evs, ...sim.step()];
}

/** Yaw and pitch from the player's eye to a point. */
function lookAt(p: PlayerEnt, x: number, y: number, z: number): { yaw: number; pitch: number } {
  const dx = x - p.x, dy = y - (p.y + EYE_STAND), dz = z - p.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

const of = <T extends SimEvent['t']>(evs: SimEvent[], t: T) => evs.filter((e) => e.t === t) as Extract<SimEvent, { t: T }>[];
const toasts = (evs: SimEvent[]) => of(evs, 'toast').map((e) => e.text);

describe('tools: the flashlight', () => {
  it('F takes it out and lights it; a cell lasts 12 minutes, dims below a quarter, then dies; a spare cell brings it back', () => {
    const { sim, p } = setup();
    expect(p.inv.flashlight).toBe(1);
    expect(p.held).toBe('hands');
    sim.act(p.id, { t: 'toggleLight' });
    expect(p.held).toBe('flashlight');
    expect(p.lightOn).toBe(true);
    let evs = run(sim, 0.1);
    expect(of(evs, 'equip')).toEqual([{ t: 'equip', id: p.id, tool: 'flashlight' }]);
    expect(p.beam).toBe(1);

    let secs = 0, dimAt = -1, lowBeam = 1;
    evs = [];
    while (p.lightOn && secs < CELL_SECONDS + 60) {
      evs.push(...sim.step());
      secs += 1 / 30;
      if (dimAt < 0 && (p.beam ?? 0) < 1) dimAt = secs;
      if (p.cellCharge > 0.09 && p.cellCharge < 0.11) lowBeam = p.beam ?? 1;
    }
    expect(Math.abs(secs - CELL_SECONDS)).toBeLessThan(2);
    expect(Math.abs(dimAt - CELL_SECONDS * (1 - CELL_DIM))).toBeLessThan(2);
    expect(lowBeam).toBeGreaterThan(0.3);
    expect(lowBeam).toBeLessThan(0.6);
    expect(p.beam).toBe(0);
    expect(toasts(evs)).toContain('The flashlight dies.');

    // a flat cell will not light; a spare one goes in with 'reload'
    sim.act(p.id, { t: 'toggleLight' });
    expect(p.lightOn).toBe(false);
    expect(toasts(sim.step())).toContain('The cell is dead.');
    p.inv.cell = 1;
    sim.act(p.id, { t: 'reload' });
    expect(p.act).toBe('reload');
    run(sim, CELL_SWAP + 0.1);
    expect(p.act).toBe('none');
    expect(p.cellCharge).toBe(1);
    expect(p.inv.cell).toBeUndefined();
    sim.act(p.id, { t: 'toggleLight' });
    run(sim, 0.1);
    expect(p.beam).toBe(1);
    // SECONDARY raises and focuses it
    input(sim, p, { b: BTN.SECONDARY });
    run(sim, 0.5);
    expect(p.aim).toBe(1);
    // put away, it goes out
    sim.act(p.id, { t: 'equip', tool: 'hands' });
    run(sim, 0.1);
    expect(p.lightOn).toBe(false);
    expect(p.beam).toBe(0);
  });

  it('the beam is full above a quarter charge and fades below it', () => {
    expect(beamLevel(1)).toBe(1);
    expect(beamLevel(CELL_DIM)).toBe(1);
    expect(beamLevel(CELL_DIM / 2)).toBeCloseTo(0.6, 6);
    expect(beamLevel(0.001)).toBeLessThan(0.25);
    expect(beamLevel(0)).toBe(0);
  });
});

describe('tools: the rifle', () => {
  it('empty it clicks; R loads round by round from the pack; a shot spends one and the bolt must be worked; no round is made up', () => {
    const { sim, p } = setup();
    stand(sim, p, 20, 60, 0, 0.5);
    p.inv.rifle = 1;
    p.inv.ammo = 7;
    sim.act(p.id, { t: 'equip', tool: 'rifle' });
    const rounds = () => p.loaded + (p.inv.ammo ?? 0);
    let evs = press(sim, p, BTN.PRIMARY);
    expect(of(evs, 'dry')).toEqual([{ t: 'dry', by: p.id }]);
    expect(of(evs, 'shot')).toHaveLength(0);

    sim.act(p.id, { t: 'reload' });
    expect(p.act).toBe('reload');
    evs = run(sim, RELOAD_OPEN + RELOAD_ROUND + 0.05);
    expect(of(evs, 'reload')).toEqual([{ t: 'reload', by: p.id }]);
    expect(p.loaded).toBe(1);
    expect(rounds()).toBe(7);
    run(sim, 4 * RELOAD_ROUND + RELOAD_CLOSE + 0.1);
    expect(p.loaded).toBe(RIFLE_MAG);
    expect(p.inv.ammo).toBe(2);
    expect(p.act).toBe('none');

    evs = press(sim, p, BTN.PRIMARY);
    const shots = of(evs, 'shot');
    expect(shots).toHaveLength(1);
    expect(shots[0].hit).toBe('none'); // into the sky
    expect(shots[0].by).toBe(p.id);
    expect(p.loaded).toBe(4);
    expect(sim.state.stats.shots).toBe(1);
    // the bolt is being worked: nothing
    expect(of(press(sim, p, BTN.PRIMARY), 'shot')).toHaveLength(0);
    run(sim, BOLT_TIME);
    expect(of(press(sim, p, BTN.PRIMARY), 'shot')).toHaveLength(1);
    expect(rounds()).toBe(5);

    // PRIMARY during a reload stops it after the round going in
    run(sim, BOLT_TIME + 0.1);
    sim.act(p.id, { t: 'reload' });
    run(sim, RELOAD_OPEN + 0.1);
    press(sim, p, BTN.PRIMARY);
    run(sim, RELOAD_ROUND + RELOAD_CLOSE + 0.1);
    expect(p.act).toBe('none');
    expect(p.loaded).toBe(4);
    expect(p.inv.ammo).toBe(1);

    // dropped, it is unloaded into the pack first
    sim.act(p.id, { t: 'drop', item: 'rifle', n: 1 });
    run(sim, 0.1);
    expect(p.loaded).toBe(0);
    expect(p.inv.ammo).toBe(5);
    expect(rounds()).toBe(5);
    expect(sim.ctx.all('pickup').some((k) => k.item === 'rifle')).toBe(true);
  });

  it('a raised rifle hits the wolf in its sights and kills it; misses go into the sky, a tree or the snow; a wall stops a round', () => {
    const { sim, p } = setup();
    stand(sim, p, 20, 60, 0);
    p.inv.rifle = 1;
    p.loaded = 5;
    sim.act(p.id, { t: 'equip', tool: 'rifle' });
    const w = sim.ctx.spawn<WolfEnt>(makeWolf(20, 0, 35, { pack: 7, yaw: Math.PI / 2 }));
    // raise it, keeping the sights on the wolf's shoulder
    const sights = () => lookAt(p, w.x, w.y + WOLF_BODY.y, w.z);
    for (let i = 0; i < 12; i++) {
      input(sim, p, { ...sights(), b: BTN.SECONDARY });
      sim.step();
    }
    expect(p.aim).toBe(1);
    input(sim, p, { ...sights(), b: BTN.SECONDARY | BTN.PRIMARY });
    let evs = sim.step();
    input(sim, p, { b: BTN.SECONDARY });
    evs.push(...sim.step());
    const shot = of(evs, 'shot')[0];
    expect(shot.hit).toBe('wolf');
    expect(Math.hypot(shot.hx - w.x, shot.hz - w.z)).toBeLessThan(1.2);
    expect(of(evs, 'wolfDie')).toEqual([{ t: 'wolfDie', id: w.id, x: w.x, y: w.y, z: w.z }]);
    expect(w.mood).toBe('dead');
    expect(sim.state.stats.wolvesKilled).toBe(1);
    expect(p.kills).toBe(1);

    run(sim, BOLT_TIME + 0.1);
    expect(of(press(sim, p, BTN.PRIMARY, { yaw: 0, pitch: 0.6 }), 'shot')[0].hit).toBe('none');
    run(sim, BOLT_TIME + 0.1);
    expect(of(press(sim, p, BTN.PRIMARY, { yaw: 0, pitch: -0.6 }), 'shot')[0].hit).toBe('ground');
    run(sim, BOLT_TIME + 0.1);
    stand(sim, p, TEST_TREE.x, TEST_TREE.z + 6, 0);
    const tree = of(press(sim, p, BTN.PRIMARY, { yaw: 0, pitch: 0 }), 'shot')[0];
    expect(tree.hit).toBe('wood');
    expect(tree.hz).toBeGreaterThan(TEST_TREE.z);
    expect(tree.hz).toBeLessThan(TEST_TREE.z + 1);

    // a wolf behind the wall (box at 0, -20) is out of reach
    run(sim, BOLT_TIME + 0.1);
    stand(sim, p, 0, -12, 0);
    const hid = sim.ctx.spawn<WolfEnt>(makeWolf(0, 0, -27, { pack: 8, yaw: Math.PI / 2 }));
    evs = press(sim, p, BTN.PRIMARY, lookAt(p, hid.x, hid.y + WOLF_BODY.y, hid.z));
    expect(of(evs, 'shot')[0].hit).not.toBe('wolf');
    expect(hid.health).toBe(60);
    expect(p.loaded).toBe(0);
    expect(of(press(sim, p, BTN.PRIMARY), 'dry')).toHaveLength(0); // still working the bolt
    run(sim, BOLT_TIME + 0.1);
    expect(of(press(sim, p, BTN.PRIMARY), 'dry')).toHaveLength(1);
  });

  it('sway grows with cold, exhaustion and wind, and is far worse from the hip', () => {
    const env = makeEnv();
    env.windX = 0;
    env.windZ = 0;
    env.gust = 0;
    const base = makePlayer('A', 0, 0, 0, 0);
    base.id = 3;
    base.aim = 1;
    const amp = (p: PlayerEnt, e = env) => {
      let m = 0;
      for (let t = 0; t < 1800; t++) {
        const s = rifleSway(p, e, t);
        m = Math.max(m, Math.hypot(s.yaw, s.pitch));
      }
      return m;
    };
    const calm = amp(base);
    expect(calm).toBeLessThan(0.008);
    expect(amp({ ...base, core: 33 })).toBeGreaterThan(calm * 1.8);
    expect(amp({ ...base, stamina: 0.05 })).toBeGreaterThan(calm * 2);
    expect(amp(base, { ...env, windX: 15 })).toBeGreaterThan(calm * 1.8);
    expect(amp({ ...base, shelter: 1 }, { ...env, windX: 15 })).toBeCloseTo(calm, 9);
    expect(amp({ ...base, aim: 0 })).toBeGreaterThan(calm * 5);
    expect(rifleSway(base, env, 123)).toEqual(rifleSway(base, env, 123));
  });
});

describe('tools: the flare gun', () => {
  function shootFlare(wind: { x: number; z: number }) {
    const { sim, p } = setup();
    sim.state.env.windX = wind.x;
    sim.state.env.windZ = wind.z;
    stand(sim, p, -40, 60, -Math.PI / 2, 0.35); // facing east, 20 degrees up
    p.inv.flaregun = 1;
    p.inv.flare = 2;
    sim.act(p.id, { t: 'equip', tool: 'flaregun' });
    return { sim, p };
  }

  it('one cartridge at a time; the flare flies an arc with drag, lands, burns 40 s, goes out and is gone', () => {
    const { sim, p } = shootFlare({ x: 0, z: 0 });
    expect(of(press(sim, p, BTN.PRIMARY), 'dry')).toHaveLength(1);
    sim.act(p.id, { t: 'reload' });
    run(sim, FLARE_RELOAD + 0.05);
    expect(p.flareLoaded).toBe(1);
    expect(p.inv.flare).toBe(1);
    expect(p.act).toBe('none');

    input(sim, p, { b: BTN.PRIMARY });
    let evs = sim.step();
    input(sim, p);
    const fs = of(evs, 'flareShot');
    expect(fs).toHaveLength(1);
    expect(p.flareLoaded).toBe(0);
    const f = sim.ctx.get<FlareEnt>(fs[0].id)!;
    expect(f.kind).toBe('flare');
    const y0 = f.y, h0 = Math.hypot(f.vx, f.vz);
    let top = y0, hLate = h0, t = 0;
    evs = [];
    while (!f.landed && t < 20) {
      evs.push(...sim.step());
      t += 1 / 30;
      top = Math.max(top, f.y);
      if (!f.landed) hLate = Math.hypot(f.vx, f.vz);
    }
    expect(f.landed).toBe(true);
    expect(top).toBeGreaterThan(y0 + 5); // up, then down
    expect(hLate).toBeLessThan(h0 * 0.7); // the air slows it
    const land = of(evs, 'flareLand');
    expect(land).toEqual([{ t: 'flareLand', id: f.id, x: f.x, y: f.y, z: f.z }]);
    const range = Math.hypot(f.x - p.x, f.z - p.z);
    expect(range).toBeGreaterThan(30);
    expect(range).toBeLessThan(120);
    expect(Math.abs(f.z - p.z)).toBeLessThan(1); // no wind, straight
    expect(f.y).toBeCloseTo(world.groundAt(f.x, f.z, f.y + 1).y, 6);
    expect(f.life).toBe(FLARE_LIFE); // it burns on the snow

    evs = run(sim, FLARE_LIFE - 0.1);
    expect(of(evs, 'flareOut')).toHaveLength(0);
    evs = run(sim, 0.2);
    expect(of(evs, 'flareOut')).toEqual([{ t: 'flareOut', id: f.id }]);
    expect(f.life).toBe(0);
    run(sim, FLARE_SPENT - 0.5);
    expect(sim.ctx.get(f.id)).toBe(f);
    run(sim, 0.6);
    expect(sim.ctx.get(f.id)).toBeUndefined();
  });

  it('the wind carries a flare downwind', () => {
    const land = (wz: number) => {
      const { sim, p } = shootFlare({ x: 0, z: wz });
      p.flareLoaded = 1;
      p.inv.flare = 1; // (the one in the gun came from the pack)
      press(sim, p, BTN.PRIMARY);
      const f = sim.ctx.all('flare')[0];
      for (let i = 0; i < 600 && !f.landed; i++) sim.step();
      return f.z - p.z;
    };
    expect(land(0)).toBeCloseTo(0, 0);
    expect(land(10)).toBeGreaterThan(6); // the air moves toward +z (south)
    expect(land(-10)).toBeLessThan(-6);
  });
});

describe('tools: the radio', () => {
  it('PRIMARY cranks it; with charge it hears the nearest missing part, loudest facing it and closer; then the tower; silent when flat or put away', () => {
    const { sim, p } = setup();
    p.inv.radio = 1;
    sim.act(p.id, { t: 'equip', tool: 'radio' });
    stand(sim, p, 0, 40, 0);
    run(sim, 0.1);
    expect(p.radioSig).toBe(0);
    expect(p.radioDist).toBe(-1);

    input(sim, p, { b: BTN.PRIMARY });
    run(sim, CRANK_SECONDS / 2);
    expect(p.act).toBe('crank');
    expect(p.radioCharge).toBeGreaterThan(0.45);
    expect(p.radioCharge).toBeLessThan(0.5);
    input(sim, p);
    run(sim, 0.1);
    expect(p.act).toBe('none');

    const parts = sim.state.objective.parts;
    const nearest = () => {
      let best: { part: PartId; d: number; x: number; z: number } | null = null;
      for (const part of Object.keys(parts) as PartId[]) {
        if (parts[part] !== 'lost') continue;
        const s = world.spawn.parts[part];
        const d = Math.hypot(s.x - p.x, s.z - p.z);
        if (!best || d < best.d) best = { part, d, x: s.x, z: s.z };
      }
      return best!;
    };
    const near = nearest();
    const face = Math.atan2(-(near.x - p.x), -(near.z - p.z));
    input(sim, p, { yaw: face });
    run(sim, 0.1);
    const facing = p.radioSig;
    expect(facing).toBeGreaterThan(0.5);
    expect(p.radioDist).toBeCloseTo(near.d, 0);
    input(sim, p, { yaw: face + Math.PI });
    run(sim, 0.1);
    expect(p.radioSig).toBeLessThan(0.05);
    input(sim, p, { yaw: face + 0.5 });
    run(sim, 0.1);
    expect(p.radioSig).toBeLessThan(facing);
    expect(p.radioSig).toBeGreaterThan(0.05);
    // closer in, louder
    stand(sim, p, p.x + (near.x - p.x) * 0.7, p.z + (near.z - p.z) * 0.7, face);
    run(sim, 0.1);
    expect(p.radioSig).toBeGreaterThan(facing);

    // found: the next nearest; all found: the tower panel
    p.inv[`part_${near.part}` as 'part_battery'] = 1;
    parts[near.part] = 'held';
    run(sim, 0.1);
    const next = nearest();
    expect(next.part).not.toBe(near.part);
    expect(p.radioDist).toBeCloseTo(next.d, 0);
    for (const part of Object.keys(parts) as PartId[]) {
      p.inv[`part_${part}` as 'part_battery'] = 1;
      parts[part] = 'held';
    }
    run(sim, 0.1);
    const panel = sim.ctx.all('device').find((d) => d.type === 'panel')!;
    expect(p.radioDist).toBeCloseTo(Math.hypot(panel.x - p.x, panel.z - p.z), 0);

    // listening drains it; put away it is silent
    const c0 = p.radioCharge;
    run(sim, 3);
    expect(p.radioCharge).toBeLessThan(c0);
    sim.act(p.id, { t: 'equip', tool: 'hands' });
    run(sim, 0.1);
    expect(p.radioSig).toBe(0);
    expect(p.radioDist).toBe(-1);
  });

  it('the signal: a narrow lobe that sharpens when raised, stronger close in, gone on a flat battery', () => {
    expect(radioSignal(0, -300, 0, 0, 1, 0)).toBeGreaterThan(radioSignal(0, -900, 0, 0, 1, 0));
    expect(radioSignal(0, -300, 0, 0, 1, 0)).toBeGreaterThan(radioSignal(300, 0, 0, 0, 1, 0) * 20);
    const off = radioSignal(Math.sin(0.5) * -300, -Math.cos(0.5) * 300, 0, 0, 1, 0);
    expect(radioSignal(Math.sin(0.5) * -300, -Math.cos(0.5) * 300, 0, 1, 1, 0)).toBeLessThan(off);
    expect(radioSignal(0, -300, 0, 0, 0, 0)).toBe(0);
    expect(radioSignal(0, -300, 0, 0, 1, 1)).toBeLessThan(radioSignal(0, -300, 0, 0, 1, 0));
  });
});

describe('tools: the axe on a wolf', () => {
  it('the blade lands once, on the wolf: it yelps and staggers back; a blow on a hurt wolf kills it', () => {
    const { sim, p } = setup();
    stand(sim, p, 30, 60, 0);
    p.inv.axe = 1;
    sim.act(p.id, { t: 'equip', tool: 'axe' });
    const w = sim.ctx.spawn<WolfEnt>(makeWolf(30, 0, 58.4, { pack: 9, yaw: 0 }));
    input(sim, p, { b: BTN.PRIMARY });
    const evs: SimEvent[] = [];
    let hitTick = -1;
    for (let i = 0; i < Math.round(SWING_TIME * 30) - 1; i++) {
      const e = sim.step();
      if (hitTick < 0 && e.some((x) => x.t === 'swing')) hitTick = i;
      evs.push(...e);
    }
    input(sim, p);
    const swings = of(evs, 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0].hit).toBe('wolf');
    expect(of(evs, 'yelp')).toHaveLength(1);
    expect(w.health).toBeLessThanOrEqual(60 - AXE_DAMAGE);
    expect(w.health).toBeGreaterThan(60 - AXE_DAMAGE - 10);
    expect(hitTick).toBeGreaterThan(5);
    expect(hitTick).toBeLessThan(11);
    // knocked back and off
    const d0 = Math.hypot(w.x - p.x, w.z - p.z);
    run(sim, 1.5);
    expect(Math.hypot(w.x - p.x, w.z - p.z)).toBeGreaterThan(d0 + 1.5);

    // a hurt one goes down to one blow
    run(sim, SWING_TIME);
    const v = sim.ctx.spawn<WolfEnt>(makeWolf(30, 0, 58.4, { pack: 10, yaw: Math.PI }));
    v.health = 20;
    input(sim, p, { b: BTN.PRIMARY });
    const evs2 = run(sim, SWING_TIME - 0.05);
    input(sim, p);
    expect(of(evs2, 'swing').map((s) => s.hit)).toEqual(['wolf']);
    expect(of(evs2, 'wolfDie').map((e) => e.id)).toEqual([v.id]);
    expect(v.mood).toBe('dead');

    // one coming at a gallop meets the blade
    run(sim, SWING_TIME);
    p.health = 100;
    const c = sim.ctx.spawn<WolfEnt>(makeWolf(30, 0, 51, { pack: 11, yaw: 0, alpha: true }));
    c.mood = 'charge';
    c.target = p.id;
    c.speed = 6;
    input(sim, p, { b: BTN.PRIMARY });
    let met = -1;
    const evs4 = run(sim, 3, () => {
      if (met < 0 && c.health < 80) met = sim.state.tick;
    });
    input(sim, p);
    expect(of(evs4, 'swing').some((s) => s.hit === 'wolf')).toBe(true);
    expect(of(evs4, 'yelp').map((e) => e.id)).toContain(c.id);
    expect(c.health).toBeLessThan(80);
    expect(met).toBeGreaterThan(0);

    // no wolf: the swing is wood's, into the snow
    run(sim, SWING_TIME * 2);
    stand(sim, p, -30, 60, 0);
    input(sim, p, { b: BTN.PRIMARY });
    const evs3 = run(sim, SWING_TIME - 0.05);
    input(sim, p);
    expect(of(evs3, 'swing')).toHaveLength(1);
    expect(of(evs3, 'swing')[0].hit).not.toBe('wolf');
  });
});

describe('tools: nothing made up, nothing lost', () => {
  it('a player who leaves with loaded guns sets the rounds down beside the pack', () => {
    const { sim, ps } = setup(2);
    const q = ps[1];
    q.inv.rifle = 1;
    q.inv.ammo = 3;
    q.loaded = 4;
    q.inv.flaregun = 1;
    q.inv.flare = 2;
    q.flareLoaded = 1;
    const before = sim.ctx.all('pickup').length;
    sim.removePlayer(q.id);
    const near = sim.ctx.all('pickup').slice(before);
    const count = (item: string) => near.filter((k) => k.item === item).reduce((a, k) => a + k.n, 0);
    expect(count('ammo')).toBe(7);
    expect(count('flare')).toBe(3);
    expect(count('rifle')).toBe(1);
  });
});
