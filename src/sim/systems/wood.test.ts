import { describe, expect, it } from 'vitest';
import { CARRY_LIMIT, HEAVY_LOG_BURN, makeFire } from '../entities';
import { DRAG_SPEED, WALK_SPEED } from '../move';
import { Sim } from '../sim';
import { cmd, jsonIssues } from '../testkit';
import { createTestWorld, TEST_TREE } from '../testworld';
import type { TreeInst } from '../../world/types';
import { BTN, type FireEnt, type LogEnt, type PlayerEnt, type SimEvent, type WoodEnt } from '../types';
import { woodOf } from './fire';
import { DEADFALL_LEN, GATHER_LIVE, GATHER_REACH, GATHER_TIME, logEnds, SWING_STAMINA, SWING_TIME, treeSticks } from './wood';

const world = createTestWorld();

function setup(n = 1) {
  const sim = new Sim(world, { seed: 13, debug: true, players: n });
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [0] });
  return { sim, ps, p: ps[0] };
}

const faceYaw = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));

function input(sim: Sim, p: PlayerEnt, o: { yaw?: number; b?: number; focus?: number; mz?: number } = {}): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: o.yaw ?? p.yaw, b: o.b ?? 0, focus: o.focus ?? 0, mz: o.mz ?? 0 }));
}

function stand(sim: Sim, p: PlayerEnt, x: number, z: number, tx: number, tz: number): void {
  sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
  p.yaw = faceYaw(x, z, tx, tz);
  input(sim, p);
  sim.step();
}

function run(sim: Sim, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) out.push(...sim.step());
  return out;
}

const woodAt = (sim: Sim, type: WoodEnt['type']) => sim.ctx.all('wood').find((w) => w.type === type)!;

describe('wood: the axe', () => {
  it('PRIMARY with the axe swings it; each swing that lands takes a chop; bare hands do nothing', () => {
    const { sim, p } = setup();
    const snag = woodAt(sim, 'snag');
    expect(snag.hp).toBe(7);
    stand(sim, p, snag.x, snag.z + 1, snag.x, snag.z);
    input(sim, p, { b: BTN.PRIMARY });
    expect(run(sim, 2).some((e) => e.t === 'swing')).toBe(false);
    p.inv.axe = 1;
    sim.act(p.id, { t: 'equip', tool: 'axe' });
    const st0 = p.stamina;
    input(sim, p, { b: BTN.PRIMARY, focus: snag.id });
    const evs = run(sim, SWING_TIME * 3 + 0.1);
    const tired = p.stamina;
    const swings = evs.filter((e) => e.t === 'swing');
    expect(swings.length).toBe(3);
    expect(swings.every((e) => e.t === 'swing' && e.hit === 'wood' && e.by === p.id)).toBe(true);
    expect(snag.hp).toBe(4);
    expect(st0 - tired).toBeGreaterThan(0.05); // hard work: it outruns the regen
    // out of reach the blade meets nothing (or the snow)
    stand(sim, p, snag.x, snag.z + 4, snag.x, snag.z);
    input(sim, p, { b: BTN.PRIMARY });
    const miss = run(sim, SWING_TIME + 0.1).filter((e) => e.t === 'swing');
    expect(miss.length).toBe(1);
    expect(miss[0].t === 'swing' && miss[0].hit).not.toBe('wood');
    expect(snag.hp).toBe(4);
  });

  it('a snag falls away from the axe and lies as deadfall; deadfall yields split logs and sticks', () => {
    const { sim, p } = setup();
    const snag = woodAt(sim, 'snag');
    p.inv.axe = 1;
    sim.act(p.id, { t: 'equip', tool: 'axe' });
    stand(sim, p, snag.x, snag.z + 1, snag.x, snag.z);
    input(sim, p, { b: BTN.PRIMARY, focus: snag.id });
    let evs = run(sim, SWING_TIME * 7 + 0.1);
    expect(evs).toContainEqual({ t: 'chopped', by: p.id, id: snag.id, x: snag.x, y: snag.y, z: snag.z });
    expect(sim.ctx.get(snag.id)).toBeUndefined();
    const felled = sim.ctx.all('wood').filter((w) => w.type === 'deadfall' && w.seed === snag.seed);
    expect(felled.length).toBe(1);
    const log = felled[0];
    // it lies north of the stump (away from the player, who stood south of it), along its own axis
    expect(log.z).toBeLessThan(snag.z - 1);
    const axis = { x: Math.cos(log.yaw), z: -Math.sin(log.yaw) };
    expect(Math.abs(axis.z)).toBeGreaterThan(0.99);
    expect(sim.ctx.all('pickup').some((e) => e.item === 'stick' && Math.hypot(e.x - snag.x, e.z - snag.z) < 2)).toBe(true);

    // now the deadfall from the world, scale 1.2: six chops, three split logs and two sticks
    input(sim, p);
    run(sim, 1);
    const df = sim.ctx.all('wood').find((w) => w.type === 'deadfall' && w.seed !== snag.seed)!;
    expect(df.hp).toBe(6);
    const px = df.x + Math.sin(df.yaw), pz = df.z + Math.cos(df.yaw); // beside its middle, off the axis
    stand(sim, p, px, pz, df.x, df.z);
    input(sim, p, { b: BTN.PRIMARY, focus: df.id });
    evs = run(sim, SWING_TIME * 6 + 0.1);
    expect(evs.some((e) => e.t === 'chopped' && e.id === df.id)).toBe(true);
    const near = sim.ctx.all('pickup').filter((e) => Math.hypot(e.x - df.x, e.z - df.z) < 2);
    expect(near.find((e) => e.item === 'log')?.n).toBe(3);
    expect(near.find((e) => e.item === 'stick')?.n).toBe(2);
    expect(DEADFALL_LEN).toBeGreaterThan(2);
  });

  it('USE on dead wood takes the axe out of the pack, then chops', () => {
    const { sim, p } = setup();
    const snag = woodAt(sim, 'snag');
    p.inv.axe = 1;
    stand(sim, p, snag.x, snag.z + 1, snag.x, snag.z);
    p.pitch = 0;
    input(sim, p, { b: BTN.USE, focus: snag.id });
    const evs = run(sim, SWING_TIME * 2 + 0.2);
    expect(evs).toContainEqual({ t: 'equip', id: p.id, tool: 'axe' });
    expect(evs.filter((e) => e.t === 'swing').length).toBeGreaterThanOrEqual(2);
    expect(snag.hp).toBeLessThanOrEqual(5);
  });
});

describe('wood: heavy logs', () => {
  function nearEnd(sim: Sim, p: PlayerEnt, l: LogEnt, end: 'a' | 'b', back = 0.9): void {
    const e = logEnds(l);
    const [ex, ez] = end === 'a' ? [e.ax, e.az] : [e.bx, e.bz];
    const ux = Math.sin(l.yaw) * (end === 'a' ? 1 : -1), uz = Math.cos(l.yaw) * (end === 'a' ? 1 : -1);
    stand(sim, p, ex + ux * back, ez + uz * back, ex, ez);
  }

  it('one carrier takes the nearer end and drags it slowly; the log trails at its own length', () => {
    const { sim, p } = setup();
    const l = sim.ctx.all('log')[0];
    nearEnd(sim, p, l, 'b');
    sim.act(p.id, { t: 'carry', log: l.id });
    const evs = sim.step();
    expect(evs).toContainEqual({ t: 'logLift', id: l.id, by: p.id });
    expect(l.b).toBe(p.id);
    expect(l.a).toBe(0);
    expect(p.carry).toBe(l.id);
    expect(p.carryPair).toBe(false);
    const x0 = p.x, z0 = p.z;
    input(sim, p, { yaw: Math.PI, mz: 1 }); // walk south
    run(sim, 5);
    const speed = Math.hypot(p.x - x0, p.z - z0) / 5;
    expect(speed).toBeGreaterThan(DRAG_SPEED * 0.85);
    expect(speed).toBeLessThan(DRAG_SPEED * 1.05);
    const e = logEnds(l);
    expect(Math.hypot(e.ax - e.bx, e.az - e.bz)).toBeCloseTo(l.len, 6);
    // the held end is at the carrier's back, the other trails north of them
    expect(Math.hypot(e.bx - p.x, e.bz - p.z)).toBeLessThan(0.5);
    expect(e.az).toBeLessThan(p.z - l.len + 0.6);
    expect(l.y).toBeGreaterThan(world.heightAt(l.x, l.z));
  });

  it('two carriers carry it at a walk, the log between them; release puts it down', () => {
    const { sim, ps } = setup(2);
    const [p, q] = ps;
    const l = sim.ctx.all('log')[0];
    nearEnd(sim, p, l, 'a');
    nearEnd(sim, q, l, 'b');
    sim.act(p.id, { t: 'carry', log: l.id });
    sim.act(q.id, { t: 'carry', log: l.id });
    expect([l.a, l.b]).toEqual([p.id, q.id]);
    expect(p.carryPair && q.carryPair).toBe(true);
    // both walk the same way (along the log, the front carrier first)
    const yaw = Math.atan2(-Math.sin(l.yaw), -Math.cos(l.yaw));
    input(sim, p, { yaw, mz: 1 });
    input(sim, q, { yaw, mz: 1 });
    const x0 = p.x, z0 = p.z;
    run(sim, 5);
    const speed = Math.hypot(p.x - x0, p.z - z0) / 5;
    expect(speed).toBeGreaterThan(WALK_SPEED * 0.85);
    expect(Math.hypot(l.x - (p.x + q.x) / 2, l.z - (p.z + q.z) / 2)).toBeLessThan(0.01);
    expect(l.y).toBeGreaterThan(world.heightAt(l.x, l.z) + 0.3);
    input(sim, p);
    input(sim, q);
    sim.act(q.id, { t: 'release' });
    expect(l.b).toBe(0);
    expect(p.carryPair).toBe(false);
    expect(q.carry).toBe(0);
    sim.act(p.id, { t: 'release' });
    const evs = sim.step();
    expect(evs).toContainEqual({ t: 'logDrop', id: l.id });
    expect(l.a).toBe(0);
    expect(l.y).toBeCloseTo(world.heightAt(l.x, l.z), 1);
  });

  it('carriers who pull apart lose it; a carrier who goes down lets go', () => {
    const { sim, ps } = setup(2);
    const [p, q] = ps;
    const l = sim.ctx.all('log')[0];
    nearEnd(sim, p, l, 'a');
    nearEnd(sim, q, l, 'b');
    sim.act(p.id, { t: 'carry', log: l.id });
    sim.act(q.id, { t: 'carry', log: l.id });
    // q walks off backwards (away from p)
    const away = l.yaw + Math.PI; // facing p (toward end a), so backing up leaves
    input(sim, q, { yaw: away, mz: -1 });
    input(sim, p, { yaw: away });
    const evs = run(sim, 4);
    expect(evs.filter((e) => e.t === 'toast' && e.text === 'The log slipped.').length).toBe(2);
    expect(l.b).toBe(0);
    expect(l.a).toBe(p.id);
    expect(q.carry).toBe(0);
    p.life = 'downed';
    const evs2 = run(sim, 0.1);
    expect(l.a).toBe(0);
    expect(p.carry).toBe(0);
    expect(evs2).toContainEqual({ t: 'logDrop', id: l.id });
  });

  it('USE lifts it and puts it down; set down beside a fire it goes on the fire for 12 minutes', () => {
    const { sim, p } = setup();
    const l = sim.ctx.all('log')[0];
    nearEnd(sim, p, l, 'a', 0.6);
    input(sim, p, { b: BTN.USE, focus: l.id });
    sim.step();
    expect(p.carry).toBe(l.id);
    input(sim, p, { focus: l.id });
    sim.step();
    input(sim, p, { b: BTN.USE, focus: l.id });
    sim.step();
    expect(p.carry).toBe(0);
    input(sim, p);
    sim.step();
    // a lit campfire right under the log's middle
    const f = sim.ctx.spawn<FireEnt>(makeFire('campfire', l.x + 0.4, 0, l.z, {}));
    sim.ctx.setV('fire.wood.' + f.id, 60);
    f.lit = true;
    f.heat = 0.6;
    sim.act(p.id, { t: 'carry', log: l.id });
    sim.act(p.id, { t: 'release' });
    const evs = sim.step();
    expect(evs).toContainEqual({ t: 'fireFed', id: f.id, by: p.id, item: 'log' });
    expect(sim.ctx.get(l.id)).toBeUndefined();
    expect(woodOf(sim.ctx, f)).toBeGreaterThan(60 + HEAVY_LOG_BURN - 5);
    expect(HEAVY_LOG_BURN).toBe(720);
  });
});

describe('wood: dead branches off standing trees', () => {
  const T = 0; // the test world's one tree: a pine at TEST_TREE
  /** Stand `d` m west of the pine's trunk, facing it, holding nothing. */
  function atPine(sim: Sim, p: PlayerEnt, d = 1.2): void {
    stand(sim, p, TEST_TREE.x - d, TEST_TREE.z, TEST_TREE.x, TEST_TREE.z);
  }
  const sticks = (p: PlayerEnt) => p.inv.stick ?? 0;

  it('a hold of USE on the trunk snaps off two sticks from a living pine, once', () => {
    const { sim, p } = setup();
    atPine(sim, p);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    expect(p.act).toBe('use');
    run(sim, GATHER_TIME - 0.15);
    expect(sticks(p)).toBe(0);
    expect(p.actT).toBeGreaterThan(0.7);
    const evs = run(sim, 0.25);
    expect(sticks(p)).toBe(GATHER_LIVE);
    expect(GATHER_LIVE).toBe(2);
    expect(evs).toContainEqual({ t: 'gathered', by: p.id, tree: T });
    expect(evs).toContainEqual({ t: 'pickup', by: p.id, item: 'stick', n: 2 });
    expect(sim.state.gathered).toEqual([T]);
    expect(p.act).toBe('none');
    expect(jsonIssues(sim.state)).toEqual([]);
    // the same tree gives nothing more, and says so
    input(sim, p);
    sim.step();
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    const again = run(sim, GATHER_TIME + 0.5);
    expect(sticks(p)).toBe(2);
    expect(p.act).toBe('none');
    expect(again.some((e) => e.t === 'toast' && e.to === p.id && e.text === 'Its dead branches are gone.')).toBe(true);
    expect(sim.state.gathered).toEqual([T]);
  });

  it('letting go, looking away or stepping back stops it; nothing out of reach starts', () => {
    const { sim, p } = setup();
    // too far: the bark more than GATHER_REACH (and the allowance) away
    atPine(sim, p, GATHER_REACH + 1.2);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    expect(p.act).toBe('none');
    // let go half way
    atPine(sim, p);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    run(sim, 0.5);
    input(sim, p);
    run(sim, 1);
    expect(p.act).toBe('none');
    expect(sticks(p)).toBe(0);
    // turn away half way
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    run(sim, 0.5);
    input(sim, p, { b: BTN.USE, yaw: p.yaw + Math.PI });
    run(sim, 1);
    expect(p.act).toBe('none');
    // the crosshair on something else (the client sends its id) stops it too
    atPine(sim, p);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    run(sim, 0.3);
    input(sim, p, { b: BTN.USE, focus: sim.ctx.all('pickup')[0].id });
    run(sim, 1);
    expect(sticks(p)).toBe(0);
    expect(sim.state.gathered ?? []).toEqual([]);
    // a sapling, a tree index that is not there, nonsense: nothing
    for (const tree of [-1, 99, 0.5, NaN]) {
      sim.act(p.id, { t: 'gather', tree });
      expect(p.act).toBe('none');
    }
  });

  it('waits a moment for the held USE that left with the request (commands queue, actions do not)', () => {
    const { sim, p } = setup();
    atPine(sim, p);
    input(sim, p);
    sim.act(p.id, { t: 'gather', tree: T });
    run(sim, 0.2); // USE not seen yet: still on
    expect(p.act).toBe('use');
    input(sim, p, { b: BTN.USE });
    run(sim, GATHER_TIME + 0.1);
    expect(sticks(p)).toBe(2);
    // and a request whose USE never comes ends by itself
    const { sim: s2, p: p2 } = setup();
    atPine(s2, p2);
    input(s2, p2);
    s2.act(p2.id, { t: 'gather', tree: T });
    run(s2, 1.5);
    expect(p2.act).toBe('none');
    expect(sticks(p2)).toBe(0);
  });

  it('a full pack refuses; a nearly full one takes what fits and the rest falls at the foot of the tree', () => {
    const { sim, p } = setup();
    atPine(sim, p);
    p.inv.stick = CARRY_LIMIT.stick;
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: T });
    expect(p.act).toBe('none');
    p.inv.stick = CARRY_LIMIT.stick - 1;
    const before = sim.ctx.all('pickup').length;
    sim.act(p.id, { t: 'gather', tree: T });
    const evs = run(sim, GATHER_TIME + 0.1);
    expect(p.inv.stick).toBe(CARRY_LIMIT.stick);
    const fresh = sim.ctx.all('pickup').slice(before);
    expect(fresh.length).toBe(1);
    expect(fresh[0].item).toBe('stick');
    expect(fresh[0].n).toBe(1);
    expect(Math.hypot(fresh[0].x - TEST_TREE.x, fresh[0].z - TEST_TREE.z)).toBeLessThan(1.5);
    expect(evs.some((e) => e.t === 'gathered')).toBe(true);
  });

  it('a snag gives three or four; saplings give nothing; the yield is the tree\'s, not luck', () => {
    const w = createTestWorld();
    const trees = w.trees as TreeInst[];
    trees.push({ x: -10, y: 0, z: 6, scale: 0.8, yaw: 0, variant: 0, kind: 'snag', snow: 0.1 });
    trees.push({ x: -10, y: 0, z: -6, scale: 0.3, yaw: 0, variant: 0, kind: 'sapling', snow: 0.5 });
    const sim = new Sim(w, { seed: 13, debug: true, players: 1 });
    const p = sim.addPlayer('P0');
    expect([3, 4]).toContain(treeSticks(w, 1));
    expect(treeSticks(w, 1)).toBe(treeSticks(w, 1));
    expect(treeSticks(w, 2)).toBe(0);
    stand(sim, p, -11.2, 6, -10, 6);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: 1 });
    run(sim, GATHER_TIME + 0.1);
    expect(p.inv.stick).toBe(treeSticks(w, 1));
    stand(sim, p, -11, -6, -10, -6);
    input(sim, p, { b: BTN.USE });
    sim.act(p.id, { t: 'gather', tree: 2 });
    expect(p.act).toBe('none');
    // a save carries the stripped trees
    const back = Sim.fromState(w, sim.serialize(), { seed: 13 });
    expect(back.state.gathered).toEqual([1]);
  });
});
