import { describe, expect, it } from 'vitest';
import { CARRY_LIMIT, makePickup, packRoom } from '../entities';
import { Sim } from '../sim';
import { cmd } from '../testkit';
import { createTestWorld } from '../testworld';
import { BTN, type CrateEnt, type PickupEnt, type PlayerEnt, type SimEvent } from '../types';
import { BANDAGE_HEAL, CRATE_HOLD, EAT_TIME, GIVE_RANGE } from './items';

const world = createTestWorld();

function setup(n = 1) {
  const sim = new Sim(world, { seed: 9, debug: true, players: n });
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [0] });
  return { sim, ps, p: ps[0] };
}

/** Stand at x, z looking toward (tx, tz). */
function stand(sim: Sim, p: PlayerEnt, x: number, z: number, tx: number, tz: number): void {
  sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
  p.yaw = Math.atan2(-(tx - x), -(tz - z));
  hold(sim, p, 0, 0);
  sim.step();
}

function hold(sim: Sim, p: PlayerEnt, b: number, focus: number): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: p.yaw, b, focus }));
}

/** USE held on `focus` for `seconds`, then let go for a tick. */
function useFor(sim: Sim, p: PlayerEnt, focus: number, seconds: number): SimEvent[] {
  const out: SimEvent[] = [];
  hold(sim, p, BTN.USE, focus);
  for (let i = 0; i < Math.round(seconds * 30); i++) out.push(...sim.step());
  hold(sim, p, 0, focus);
  out.push(...sim.step());
  return out;
}
const tap = (sim: Sim, p: PlayerEnt, focus: number) => useFor(sim, p, focus, 1 / 30);
const toasts = (evs: SimEvent[]) => evs.filter((e) => e.t === 'toast').map((e) => (e.t === 'toast' ? e.text : ''));
const sticksAt = (sim: Sim) => sim.ctx.all('pickup').find((e) => e.item === 'stick' && e.x === 3 && e.z === -3);

describe('items: taking things', () => {
  it('USE on a pickup in reach puts it in the pack; too far, or behind a wall, nothing', () => {
    const { sim, p } = setup();
    const pk = sticksAt(sim)!;
    expect(pk.n).toBe(3);
    stand(sim, p, 3, 2.5, 3, -3); // 5.5 m off
    expect(tap(sim, p, pk.id).some((e) => e.t === 'pickup')).toBe(false);
    stand(sim, p, 3, -1.5, 3, -3);
    const evs = tap(sim, p, pk.id);
    expect(evs).toContainEqual({ t: 'pickup', by: p.id, item: 'stick', n: 3 });
    expect(p.inv.stick).toBe(3);
    expect(sim.ctx.get(pk.id)).toBeUndefined();
    // behind the test wall (0, -20)
    const hidden = sim.ctx.spawn<PickupEnt>(makePickup('flare', 1, 0, 0, -21.2));
    stand(sim, p, 0, -18.8, 0, -21.2);
    expect(tap(sim, p, hidden.id).some((e) => e.t === 'pickup')).toBe(false);
    expect(p.inv.flare).toBeUndefined();
  });

  it('respects carrying limits: takes what fits and leaves the rest, with a word', () => {
    const { sim, p } = setup();
    expect(CARRY_LIMIT.stick).toBe(12);
    expect(CARRY_LIMIT.log).toBe(4);
    p.inv.stick = 11;
    const pk = sticksAt(sim)!;
    stand(sim, p, 3, -1.5, 3, -3);
    let evs = tap(sim, p, pk.id);
    expect(evs).toContainEqual({ t: 'pickup', by: p.id, item: 'stick', n: 1 });
    expect(p.inv.stick).toBe(12);
    expect(pk.n).toBe(2);
    expect(toasts(evs)).toEqual(['Your pack holds no more sticks.']);
    evs = tap(sim, p, pk.id);
    expect(evs.some((e) => e.t === 'pickup')).toBe(false);
    expect(pk.n).toBe(2);
    expect(packRoom(p.inv, 'stick')).toBe(0);
    expect(packRoom(p.inv, 'axe')).toBe(1);
  });

  it('a crate opens after a short hold of USE; letting go early starts over; what does not fit is set down', () => {
    const { sim, p } = setup();
    const c = sim.ctx.all('crate')[0] as CrateEnt;
    stand(sim, p, c.x, c.z + 1.5, c.x, c.z);
    p.inv.ration = CARRY_LIMIT.ration; // full of rations: the crate's two will not fit
    let evs = useFor(sim, p, c.id, CRATE_HOLD * 0.6);
    expect(c.open).toBe(false);
    expect(p.act).toBe('none');
    expect(evs.some((e) => e.t === 'open')).toBe(false);
    hold(sim, p, BTN.USE, c.id);
    sim.step();
    expect(p.act).toBe('use');
    evs = useFor(sim, p, c.id, CRATE_HOLD + 0.1);
    expect(c.open).toBe(true);
    expect(evs).toContainEqual({ t: 'open', by: p.id, id: c.id });
    expect(evs).toContainEqual({ t: 'pickup', by: p.id, item: 'bandage', n: 1 });
    expect(p.inv.bandage).toBe(1);
    expect(c.loot).toEqual([]);
    expect(p.act).toBe('none');
    const spilled = sim.ctx.all('pickup').find((e) => e.item === 'ration' && Math.hypot(e.x - c.x, e.z - c.z) < 1.5);
    expect(spilled?.n).toBe(2);
    expect(toasts(evs)).toEqual(['Your pack is full. The rest is on the ground.']);
    // an open crate is done
    evs = useFor(sim, p, c.id, CRATE_HOLD + 0.1);
    expect(evs.some((e) => e.t === 'open' || e.t === 'pickup')).toBe(false);
  });

  it('radio parts are marked held when found, lost when set down', () => {
    const { sim, ps, p } = setup(2);
    const part = sim.ctx.spawn<PickupEnt>(makePickup('part_fuse', 1, 1, 0, -6));
    stand(sim, p, 1, -4.5, 1, -6);
    const evs = tap(sim, p, part.id);
    expect(evs).toContainEqual({ t: 'partFound', by: p.id, part: 'fuse' });
    expect(sim.state.objective.parts.fuse).toBe('held');
    // handed over it stays held
    const q = ps[1];
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [1.8, -4.5] });
    sim.act(p.id, { t: 'give', to: q.id, item: 'part_fuse', n: 1 });
    expect(q.inv.part_fuse).toBe(1);
    expect(p.inv.part_fuse).toBeUndefined();
    expect(sim.state.objective.parts.fuse).toBe('held');
    sim.act(q.id, { t: 'drop', item: 'part_fuse', n: 1 });
    expect(sim.state.objective.parts.fuse).toBe('lost');
    expect(sim.ctx.all('pickup').some((e) => e.item === 'part_fuse')).toBe(true);
  });
});

describe('items: using, dropping and giving', () => {
  it('a bandage heals, a ration feeds, the thermos is drunk; each takes a moment', () => {
    const { sim, p } = setup();
    p.inv.bandage = 2;
    p.health = 50;
    sim.act(p.id, { t: 'consume', item: 'bandage' });
    expect(p.health).toBe(50 + BANDAGE_HEAL);
    expect(p.inv.bandage).toBe(1);
    expect(p.act).toBe('eat');
    for (let i = 0; i < EAT_TIME * 30 + 2; i++) sim.step();
    expect(p.act).toBe('none');
    p.health = 100;
    sim.act(p.id, { t: 'consume', item: 'bandage' });
    expect(toasts(sim.step())).toEqual(['You are not hurt.']);
    expect(p.inv.bandage).toBe(1);
    sim.act(p.id, { t: 'consume', item: 'ration' });
    expect(toasts(sim.step())).toEqual(['You have no rations.']);
  });

  it('dropping sets a pickup down in front; dropping the tool in hand empties the hand', () => {
    const { sim, p } = setup();
    stand(sim, p, 30, 60, 30, 50);
    p.inv.stick = 5;
    sim.act(p.id, { t: 'drop', item: 'stick', n: 2 });
    const pk = sim.ctx.all('pickup').find((e) => e.item === 'stick' && Math.hypot(e.x - 30, e.z - 59.3) < 0.05)!;
    expect(pk.n).toBe(2);
    expect(pk.lie).toBe('snow');
    expect(p.inv.stick).toBe(3);
    sim.act(p.id, { t: 'drop', item: 'stick', n: 99 }); // clamped to what is carried
    expect(p.inv.stick).toBeUndefined();
    sim.act(p.id, { t: 'equip', tool: 'flashlight' });
    sim.act(p.id, { t: 'drop', item: 'flashlight', n: 1 });
    const evs = sim.step();
    expect(p.held).toBe('hands');
    expect(evs.filter((e) => e.t === 'equip').map((e) => e.t === 'equip' && e.tool)).toEqual(['flashlight', 'hands']);
    // nonsense is ignored
    sim.act(p.id, { t: 'drop', item: 'gold' as never, n: 1 });
    sim.act(p.id, { t: 'drop', item: 'matches', n: -3 });
    expect(p.inv.matches).toBe(4);
  });

  it('gives to a player within 3 m, up to what their pack holds', () => {
    const { sim, ps, p } = setup(2);
    const q = ps[1];
    sim.act(p.id, { t: 'debug', cmd: 'tp', args: [30, 60] });
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [32, 60] });
    sim.act(p.id, { t: 'give', to: q.id, item: 'matches', n: 2 });
    const evs = sim.step();
    expect(p.inv.matches).toBe(2);
    expect(q.inv.matches).toBe(6);
    expect(evs).toContainEqual({ t: 'pickup', by: q.id, item: 'matches', n: 2 });
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [30 + GIVE_RANGE + 1, 60] });
    sim.act(p.id, { t: 'give', to: q.id, item: 'matches', n: 1 });
    expect(toasts(sim.step())).toEqual(['P1 is too far away.']);
    expect(p.inv.matches).toBe(2);
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [31, 60] });
    q.inv.stick = 11;
    p.inv.stick = 3;
    sim.act(p.id, { t: 'give', to: q.id, item: 'stick', n: 3 });
    expect(q.inv.stick).toBe(12);
    expect(p.inv.stick).toBe(2);
    sim.act(p.id, { t: 'give', to: p.id, item: 'stick', n: 1 }); // not to yourself
    expect(p.inv.stick).toBe(2);
  });

  it('a player who leaves sets down everything they carried', () => {
    const { sim, ps } = setup(2);
    const q = ps[1];
    sim.act(q.id, { t: 'debug', cmd: 'tp', args: [30, 60] });
    q.inv.part_coil = 1;
    sim.state.objective.parts.coil = 'held';
    const before = sim.ctx.all('pickup').length;
    sim.removePlayer(q.id);
    const near = sim.ctx.all('pickup').filter((e) => Math.hypot(e.x - 30, e.z - 60) < 1.5);
    expect(sim.ctx.all('pickup').length - before).toBe(3); // flashlight, matches, the coil
    expect(near.map((e) => e.item).sort()).toEqual(['flashlight', 'matches', 'part_coil']);
    expect(sim.state.objective.parts.coil).toBe('lost');
  });
});
