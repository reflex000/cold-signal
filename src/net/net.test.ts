import { describe, expect, it } from 'vitest';
import { makeLog, makePickup, makeWolf } from '../sim/entities';
import { Sim } from '../sim/sim';
import { cmd, jsonIssues, scriptCmd } from '../sim/testkit';
import { createTestWorld } from '../sim/testworld';
import { cost, LONG_TEST_MS } from '../sim/timing';
import { DT, DYNAMIC_KINDS, type InputCmd, type PlayerEnt, type SimEvent } from '../sim/types';
import { ClientSession, INTERP_DELAY } from './client';
import { Host } from './host';
import { createLoopback } from './loopback';
import type { ClientMsg, HostMsg, LoopbackOptions, Snapshot, Transport } from './protocol';

const world = createTestWorld();
const MS = DT * 1000;
const EAST = -Math.PI / 2;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/**
 * Wrap a transport end to record what passes through it. With `freeze`, every message handed to
 * the receiver is deep-frozen first: a receiver that writes into what it was given throws.
 */
function tap<Out, In>(t: Transport<Out, In>, sent: Out[], got: In[], freeze = false): Transport<Out, In> {
  const queue: In[] = [];
  let handler: ((m: In) => void) | null = null;
  const w: Transport<Out, In> = {
    send(m: Out) {
      sent.push(m);
      t.send(m);
    },
    get onMessage() {
      return handler;
    },
    set onMessage(fn: ((m: In) => void) | null) {
      handler = fn;
      while (fn && queue.length > 0) fn(queue.shift()!);
    },
    onClose: null,
    close() {
      t.close();
    },
  };
  t.onMessage = (m: In) => {
    if (freeze) deepFreeze(m);
    got.push(m);
    if (handler) handler(m);
    else queue.push(m);
  };
  t.onClose = () => w.onClose?.();
  return w;
}

interface Rig {
  sim: Sim;
  host: Host;
  client: ClientSession;
  pump(): void;
  /** Client -> host messages and host -> client messages, as seen at the client end. */
  sent: ClientMsg[];
  got: HostMsg[];
  /** Host events per tick (ticks after the client's welcome only) and every event the client drained. */
  hostEvents: { tick: number; events: SimEvent[] }[];
  clientEvents: SimEvent[];
  welcomeTick: number;
  /** One 30 Hz tick: the client's command, a host tick, then `sub` presentation frames. */
  tick(c?: Partial<InputCmd>, sub?: number, each?: () => void): void;
  /** Real time in ms. */
  now: number;
}

function rig(o: LoopbackOptions & { freeze?: boolean; predict?: boolean; seed?: number } = {}, sim?: Sim): Rig {
  sim ??= new Sim(world, { seed: o.seed ?? 21, debug: true });
  const host = new Host(sim);
  const lb = createLoopback(o);
  const sent: ClientMsg[] = [], got: HostMsg[] = [];
  const r = {} as Rig;
  r.now = 0;
  host.connect(lb.host);
  const client = new ClientSession(tap(lb.client, sent, got, o.freeze), { name: 'Ann' });
  Object.assign(r, { sim, host, client, sent, got, hostEvents: [], clientEvents: [] });
  r.pump = () => lb.pump(r.now);
  let guard = 0;
  while (!client.ready && guard++ < 100) {
    host.tick();
    r.now += MS;
    r.pump();
  }
  const welcome = got.find((m) => m.t === 'welcome');
  r.welcomeTick = welcome && welcome.t === 'welcome' ? welcome.state.tick : -1;
  // Snapshots that left before the welcome arrived still count: they carry ticks after it.
  if (o.predict !== false) client.setWorld(world);
  r.tick = (c = {}, sub = 1, each) => {
    r.pump();
    client.sendInput(cmd(0, c));
    const events = host.tick();
    r.hostEvents.push({ tick: sim!.state.tick, events });
    for (let i = 0; i < sub; i++) {
      r.now += MS / sub;
      r.pump();
      client.advance(DT / sub);
      r.clientEvents.push(...client.drainEvents());
      each?.();
    }
  };
  return r;
}

const hostPlayer = (r: Rig) => r.sim.ctx.get<PlayerEnt>(r.client.myId)!;

describe('loopback', () => {
  it('delivers in order, after the lag, as copies on the json wire', () => {
    const lb = createLoopback({ wire: 'json', lagMs: 100, jitterMs: 40 });
    const got: ClientMsg[] = [];
    lb.host.onMessage = (m) => got.push(m);
    const msgs: ClientMsg[] = [];
    for (let i = 0; i < 20; i++) {
      const m: ClientMsg = { t: 'input', cmds: [cmd(i + 1)] };
      msgs.push(m);
      lb.pump(i * 10);
      lb.client.send(m);
    }
    lb.pump(195);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(20);
    lb.pump(400);
    expect(got).toEqual(msgs);
    expect(got[0]).not.toBe(msgs[0]);
    expect(got.map((m) => (m.t === 'input' ? m.cmds[0].seq : 0))).toEqual(msgs.map((_, i) => i + 1));
  });

  it('passes references on the ref wire, synchronously without lag, and queues until someone listens', () => {
    const lb = createLoopback();
    const m: HostMsg = { t: 'bye' };
    lb.host.send(m);
    const got: HostMsg[] = [];
    lb.client.onMessage = (x) => got.push(x);
    expect(got[0]).toBe(m);
    lb.host.send(m);
    expect(got.length).toBe(2);
    let closed = 0;
    lb.host.onClose = () => closed++;
    lb.client.close();
    expect(closed).toBe(1);
    lb.host.send(m);
    expect(got.length).toBe(2);
  });

  it('jitters the same way every run', () => {
    /** One message every 20 ms; returns each one's delay in ms. */
    const delays = () => {
      const lb = createLoopback({ lagMs: 50, jitterMs: 50 });
      const out: number[] = [];
      let now = 0;
      lb.host.onMessage = (m) => out.push(now - (m.t === 'input' ? m.cmds[0].seq : 0));
      for (now = 0; now <= 1200; now++) {
        if (now % 20 === 0 && now < 1000) lb.client.send({ t: 'input', cmds: [cmd(now)] });
        lb.pump(now);
      }
      return out;
    };
    const d = delays();
    expect(d.length).toBe(50);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...d)).toBeLessThanOrEqual(101);
    expect(Math.max(...d) - Math.min(...d)).toBeGreaterThan(20);
    expect(delays()).toEqual(d);
  });
});

describe('host and client', () => {
  it('joins: the welcome carries the whole game', () => {
    const r = rig({ wire: 'json' });
    const c = r.client;
    expect(c.ready).toBe(true);
    expect(c.seed).toBe(21);
    expect(c.myId).toBe(r.sim.ctx.players()[0].id);
    expect(c.me).not.toBeNull();
    expect(c.ents.get(c.myId)).toBe(c.me);
    expect(c.ents.size).toBe(r.sim.state.ents.length);
    expect(c.list('pickup').length).toBe(r.sim.ctx.all('pickup').length);
    expect(c.list('player')).toEqual([c.me]);
    expect(c.env.clock).toBeCloseTo(r.sim.state.env.clock, 9);
    expect(c.objective).toEqual(r.sim.state.objective);
    expect(r.host.clients).toBe(1);
  });

  for (const cfg of [{ wire: 'ref' as const, freeze: true }, { wire: 'json' as const }, { wire: 'json' as const, lagMs: 150 }]) {
    it(`predicts the local player exactly and converges to the host (${JSON.stringify(cfg)})`, () => {
      const r = rig(cfg);
      const predicted = new Map<number, string>();
      const authoritative = new Map<number, string>();
      const pos = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
      for (let n = 0; n < 240; n++) {
        r.tick(scriptCmd(0, n), 2);
        const p = r.client.predicted!;
        predicted.set(n + 1, pos(p));
        const h = hostPlayer(r);
        if (!authoritative.has(h.seq)) authoritative.set(h.seq, pos(h));
      }
      for (let n = 0; n < 45; n++) r.tick({}, 2);
      // Every command gave the same position on both sides.
      let compared = 0;
      for (const [seq, at] of authoritative) {
        if (seq === 0) continue;
        expect(predicted.get(seq), `seq ${seq}`).toBe(at);
        compared++;
      }
      expect(compared).toBeGreaterThan(200);
      const me = r.client.me!, h = hostPlayer(r);
      expect(Math.hypot(me.x - h.x, me.y - h.y, me.z - h.z)).toBeLessThan(1e-6);
      expect(Math.hypot(h.x, h.z)).toBeGreaterThan(5);
      // The ack trails what the host has applied by the trip back.
      expect(h.seq - r.client.ack).toBeGreaterThanOrEqual(0);
      expect(h.seq - r.client.ack).toBeLessThanOrEqual(cfg.lagMs ? 6 : 0);
      expect(r.client.unacked).toBeLessThan(cfg.lagMs ? 14 : 2);
    });
  }

  it('gives the same result over the ref wire, the json wire and 150 ms of lag', () => {
    const final = (cfg: LoopbackOptions) => {
      const r = rig(cfg);
      const bot = r.host.addBot('Bo');
      const digest: string[] = [];
      for (let n = 0; n < 200; n++) {
        r.host.setBotInput(bot.id, scriptCmd(1, n));
        r.tick(scriptCmd(0, n), 3, () => {
          const b = r.client.ents.get(bot.id);
          digest.push(`${r.client.me!.x.toFixed(9)} ${r.client.me!.z.toFixed(9)} ${b ? b.x.toFixed(9) : '-'} ${r.client.env.storm}`);
        });
      }
      r.host.setBotInput(bot.id, cmd(0)); // stop (a command stays in force until replaced)
      for (let n = 0; n < 60; n++) r.tick({}, 3);
      const me = r.client.me!, b = r.client.ents.get(bot.id)!;
      return { r, digest, me: [me.x, me.y, me.z], bot: [b.x, b.y, b.z], hostBot: [bot.x, bot.y, bot.z] };
    };
    const ref = final({ wire: 'ref' }), json = final({ wire: 'json' }), lag = final({ wire: 'json', lagMs: 150 });
    expect(json.digest).toEqual(ref.digest);
    expect(json.r.sim.serialize()).toBe(ref.r.sim.serialize());
    // remote entities travel rounded to a thousandth (host.ts wire()): a millimetre of the host's position
    for (const x of [ref, json, lag]) for (let i = 0; i < 3; i++) expect(x.bot[i]).toBeCloseTo(x.hostBot[i], 3);
    for (let i = 0; i < 3; i++) {
      expect(lag.me[i]).toBeCloseTo(ref.me[i], 9);
      expect(lag.bot[i]).toBeCloseTo(ref.bot[i], 9);
    }
  });

  it('interpolates a remote player smoothly, about 100 ms plus the lag in the past', () => {
    const r = rig({ wire: 'json', lagMs: 150 });
    const bot = r.host.addBot('Bo');
    let view: unknown = null;
    const xs: number[] = [], behind: number[] = [];
    for (let n = 0; n < 120; n++) {
      r.host.setBotInput(bot.id, cmd(n + 1, { yaw: EAST, mz: 1 }));
      r.tick({}, 4, () => {
        const v = r.client.ents.get(bot.id);
        if (!v) return;
        if (view) expect(v).toBe(view); // the same object every frame
        view = v;
        xs.push(v.x);
        behind.push(bot.x - v.x);
      });
    }
    expect(xs.length).toBeGreaterThan(400);
    // Steady walking pace in the last 40 frames: every frame moves a quarter tick's worth.
    const step = 2.6 * (DT / 4);
    for (let i = xs.length - 40; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      expect(d).toBeGreaterThan(step * 0.75);
      expect(d).toBeLessThan(step * 1.25);
    }
    const lagged = behind.slice(-40).reduce((a, b) => a + b, 0) / 40 / 2.6; // seconds behind the host
    expect(lagged).toBeGreaterThan(INTERP_DELAY + 0.15 - 0.06);
    expect(lagged).toBeLessThan(INTERP_DELAY + 0.15 + 0.08);
    // Yaw and the newer snapshot's other fields came along.
    const v = r.client.ents.get(bot.id) as PlayerEnt;
    expect(v.yaw).toBeCloseTo(EAST, 3); // a milliradian on the wire
    expect(v.bot).toBe(true);
    expect(v.name).toBe('Bo');
  });

  it('delivers every event exactly once; local footsteps come from the prediction at once', () => {
    const r = rig({ wire: 'json', lagMs: 150, jitterMs: 30 });
    const bot = r.host.addBot('Bo');
    const me = r.client.myId;
    for (let n = 0; n < 360; n++) {
      r.host.setBotInput(bot.id, scriptCmd(1, n));
      if (n === 30) r.client.sendAction({ t: 'equip', tool: 'flashlight' });
      if (n === 31) r.host.botAct(bot.id, { t: 'equip', tool: 'flashlight' });
      if (n === 60) r.client.sendAction({ t: 'debug', cmd: 'storm', args: [0.9] });
      if (n === 12) {
        // The host has not yet applied a single walking command, but the client has already stepped.
        expect(hostPlayer(r).seq).toBeLessThan(8);
        expect(r.clientEvents.some((e) => e.t === 'step' && e.id === me)).toBe(true);
      }
      r.tick(scriptCmd(0, n), 2);
    }
    for (let n = 0; n < 40; n++) r.tick({}, 2);
    const localMove = (e: SimEvent) => (e.t === 'step' || e.t === 'jump' || e.t === 'land') && e.id === me;
    const count = (evs: SimEvent[]) => {
      const m = new Map<string, number>();
      for (const e of evs) if (!localMove(e)) m.set(JSON.stringify(e), (m.get(JSON.stringify(e)) ?? 0) + 1);
      return m;
    };
    const hostEvs = r.hostEvents.filter((h) => h.tick > r.welcomeTick).flatMap((h) => h.events);
    const hostCount = count(hostEvs), clientCount = count(r.clientEvents);
    expect(clientCount).toEqual(hostCount);
    expect([...hostCount.keys()].some((k) => k.includes('"gust"'))).toBe(true);
    expect([...hostCount.keys()].some((k) => k.includes('"step"'))).toBe(true); // the bot's
    expect(r.clientEvents.filter((e) => e.t === 'equip').length).toBe(2);
    // The script hops every 50 ticks (a landing restarts the stride), so a dozen steps a cycle.
    const hostSteps = hostEvs.filter((e) => e.t === 'step' && e.id === me).length;
    const mySteps = r.clientEvents.filter((e) => e.t === 'step' && e.id === me).length;
    expect(hostSteps).toBeGreaterThan(8);
    expect(Math.abs(mySteps - hostSteps)).toBeLessThanOrEqual(2);
    expect(r.clientEvents.filter((e) => e.t === 'land' && e.id === me).length).toBe(hostEvs.filter((e) => e.t === 'land' && e.id === me).length);
  });

  it("presents the local player's own events on arrival, everyone else's at presentation time", () => {
    const r = rig({ wire: 'ref' });
    const bot = r.host.addBot('Bo');
    r.tick();
    r.client.sendAction({ t: 'equip', tool: 'flashlight' });
    r.host.botAct(bot.id, { t: 'equip', tool: 'flashlight' });
    r.clientEvents.length = 0;
    r.tick();
    expect(r.clientEvents.filter((e) => e.t === 'equip').map((e) => e.t === 'equip' && e.id)).toEqual([r.client.myId]);
    expect(r.client.me!.held).toBe('flashlight'); // the newest state, not delayed
    for (let i = 0; i < 4; i++) r.tick();
    expect(r.clientEvents.filter((e) => e.t === 'equip').map((e) => e.t === 'equip' && e.id)).toEqual([r.client.myId, bot.id]);
  });

  it('sends slow entities only when they change, and removals once', () => {
    const r = rig({ wire: 'ref', freeze: true });
    const snaps = () => r.got.filter((m): m is Snapshot => m.t === 'snap');
    for (let i = 0; i < 5; i++) r.tick();
    expect(snaps().length).toBe(5);
    for (const s of snaps()) expect(s.ents.every((e) => DYNAMIC_KINDS.includes(e.kind))).toBe(true);
    const pk = r.sim.ctx.all('pickup')[0];
    r.sim.ctx.touch(pk);
    r.tick();
    r.tick();
    const [s1, s2] = snaps().slice(-2);
    expect(s1.ents.filter((e) => e.id === pk.id).length).toBe(1);
    expect(s1.ents.find((e) => e.id === pk.id)).not.toBe(pk); // a copy
    expect(s2.ents.some((e) => e.id === pk.id)).toBe(false);

    // A new entity: sent once, shown when its moment comes, with an age.
    const fresh = r.sim.ctx.spawn(makePickup('flare', 2, 1, 0, 1));
    r.tick();
    expect(snaps().at(-1)!.ents.some((e) => e.id === fresh.id)).toBe(true);
    expect(r.client.ents.has(fresh.id)).toBe(false);
    for (let i = 0; i < 4; i++) r.tick();
    expect(r.client.ents.has(fresh.id)).toBe(true);
    expect(r.client.list('pickup').some((e) => e.id === fresh.id)).toBe(true);
    const age0 = r.client.ents.get(fresh.id)!.age;
    expect(age0).toBeLessThan(2 * DT + 1e-9);
    for (let i = 0; i < 6; i++) r.tick();
    expect(r.client.ents.get(fresh.id)!.age - age0).toBeCloseTo(6 * DT, 9);

    r.sim.ctx.remove(pk.id);
    r.tick();
    r.tick();
    const [r1, r2] = snaps().slice(-2);
    expect(r1.removed).toEqual([pk.id]);
    expect(r2.removed).toEqual([]);
    expect(r.client.ents.has(pk.id)).toBe(true); // still being presented
    for (let i = 0; i < 4; i++) r.tick();
    expect(r.client.ents.has(pk.id)).toBe(false);
    expect(r.client.list('pickup').some((e) => e.id === pk.id)).toBe(false);
  });

  it('sends ice changes, and heals them away', () => {
    const r = rig({ wire: 'json' });
    r.sim.state.ice.push({ i: 40, stress: 0.5, hole: false });
    for (let i = 0; i < 5; i++) r.tick();
    expect(r.client.ice.get(40)).toEqual({ i: 40, stress: 0.5, hole: false });
    r.sim.state.ice[0].hole = true;
    for (let i = 0; i < 5; i++) r.tick();
    expect(r.client.ice.get(40)!.hole).toBe(true);
    r.sim.state.ice.length = 0;
    for (let i = 0; i < 5; i++) r.tick();
    expect(r.client.ice.size).toBe(0);
  });

  it('interpolates the environment between snapshots', () => {
    const r = rig({ wire: 'json' });
    const ts: number[] = [];
    for (let n = 0; n < 30; n++) r.tick({}, 3, () => ts.push(r.client.env.t));
    for (let i = ts.length - 30; i < ts.length; i++) {
      expect(ts[i] - ts[i - 1]).toBeGreaterThan((DT / 3) * 0.8);
      expect(ts[i] - ts[i - 1]).toBeLessThan((DT / 3) * 1.2);
    }
    expect(r.sim.state.env.t - ts.at(-1)!).toBeGreaterThan(INTERP_DELAY - DT);
    expect(r.sim.state.env.t - ts.at(-1)!).toBeLessThan(INTERP_DELAY + DT);
  });

  it('keeps every message plain JSON, both ways', () => {
    const sim = new Sim(world, { seed: 3, debug: true });
    const r = rig({ wire: 'ref' }, sim);
    const bot = r.host.addBot('Bo');
    for (let n = 0; n < 60; n++) {
      if (n === 10) r.client.sendAction({ t: 'equip', tool: 'flashlight' });
      if (n === 20) r.client.sendAction({ t: 'debug', cmd: 'storm', args: [0.7] });
      r.host.setBotInput(bot.id, scriptCmd(1, n));
      r.tick(scriptCmd(0, n));
    }
    sim.state.ice.push({ i: 3, stress: 0.25, hole: false });
    r.tick();
    r.host.addBot('Cy');
    r.host.addBot('Di');
    // A fifth player is turned away.
    const lb2 = createLoopback();
    r.host.connect(lb2.host);
    const sent2: ClientMsg[] = [], got2: HostMsg[] = [];
    const late = new ClientSession(tap(lb2.client, sent2, got2), { name: 'Late' });
    expect(late.refused).toMatch(/full/);
    expect(late.closed).toBe(true);
    r.host.close();
    expect(r.client.closed).toBe(true);
    const all = [...r.sent, ...r.got, ...sent2, ...got2];
    const kinds = new Set(all.map((m) => m.t));
    for (const k of ['hello', 'input', 'act', 'welcome', 'snap', 'refuse', 'bye']) expect(kinds.has(k as never), k).toBe(true);
    for (const m of all) {
      expect(jsonIssues(m), m.t).toEqual([]);
      expect(JSON.parse(JSON.stringify(m))).toStrictEqual(m);
    }
  });

  it('repeats the last few unacknowledged commands in every input message, newest last', () => {
    const r = rig({ wire: 'json', lagMs: 150 });
    for (let n = 0; n < 30; n++) r.tick({ mz: 1 });
    const inputs = r.sent.filter((m): m is Extract<ClientMsg, { t: 'input' }> => m.t === 'input');
    expect(inputs.length).toBe(30);
    expect(inputs[0].cmds.map((c) => c.seq)).toEqual([1]);
    expect(inputs[1].cmds.map((c) => c.seq)).toEqual([1, 2]);
    expect(inputs.at(-1)!.cmds.map((c) => c.seq)).toEqual([28, 29, 30]);
    // Without lag every command is acknowledged before the next: one per message.
    const q = rig({ wire: 'json' });
    for (let n = 0; n < 5; n++) q.tick({ mz: 1 });
    expect(q.sent.filter((m) => m.t === 'input').every((m) => m.t === 'input' && m.cmds.length === 1)).toBe(true);
  });

  it('removes the player when the client leaves, and lets a new one in', () => {
    const r = rig({ wire: 'json' });
    const id = r.client.myId;
    r.tick({ mz: 1 });
    r.client.close();
    expect(r.client.closed).toBe(true);
    expect(r.sim.ctx.get(id)).toBeUndefined();
    expect(r.host.clients).toBe(0);
    r.host.tick();
    const lb = createLoopback({ wire: 'json' });
    r.host.connect(lb.host);
    const again = new ClientSession(lb.client, { name: 'Bea' });
    expect(again.ready).toBe(true);
    expect(again.myId).not.toBe(id);
    expect(again.ents.has(id)).toBe(false);
  });

  it('two clients see each other, and neither disturbs the other through shared snapshot objects', () => {
    const sim = new Sim(world, { seed: 4, debug: true });
    const host = new Host(sim);
    const ends = [createLoopback(), createLoopback()];
    const clients = ends.map((lb, k) => {
      host.connect(lb.host);
      const c = new ClientSession(tap(lb.client, [], [], true), { name: 'P' + k });
      c.setWorld(world);
      return c;
    });
    const [a, b] = clients;
    expect(a.myId).not.toBe(b.myId);
    for (let n = 0; n < 150; n++) {
      a.sendInput(scriptCmd(0, n));
      b.sendInput(scriptCmd(1, n));
      host.tick();
      for (const c of clients) c.advance(DT);
    }
    for (let n = 0; n < 30; n++) {
      for (const c of clients) c.sendInput(cmd(0));
      host.tick();
      for (const c of clients) c.advance(DT);
    }
    const pa = sim.ctx.get<PlayerEnt>(a.myId)!, pb = sim.ctx.get<PlayerEnt>(b.myId)!;
    expect(a.me!.x).toBeCloseTo(pa.x, 6);
    expect(b.me!.z).toBeCloseTo(pb.z, 6);
    // the other player arrives rounded to a millimetre (host.ts wire()); each own player at full precision
    expect(a.ents.get(b.myId)!.x).toBeCloseTo(pb.x, 3);
    expect(b.ents.get(a.myId)!.z).toBeCloseTo(pa.z, 3);
    expect(a.list('player').length).toBe(2);
  });

  it('holds still while the host is paused and picks up smoothly after', () => {
    const r = rig({ wire: 'json' });
    const bot = r.host.addBot('Bo');
    r.host.setBotInput(bot.id, cmd(1, { yaw: EAST, mz: 1 }));
    for (let n = 0; n < 60; n++) r.tick();
    const v = r.client.ents.get(bot.id)!;
    for (let i = 0; i < 30; i++) r.client.advance(DT); // paused: frames without ticks
    const held = v.x;
    expect(r.client.time).toBeCloseTo(r.client.tick * DT, 9);
    for (let i = 0; i < 30; i++) r.client.advance(DT);
    expect(v.x).toBe(held);
    const xs: number[] = [];
    for (let n = 0; n < 60; n++) r.tick({}, 2, () => xs.push(v.x));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]); // never backwards
      expect(xs[i] - xs[i - 1]).toBeLessThan(2.6 * DT * 1.3);
    }
    expect(bot.x - v.x).toBeGreaterThan(0.1);
    expect(bot.x - v.x).toBeLessThan(0.5);
  });

  it('stops predicting 1.5 s ahead of a host that has stopped answering, and catches up after', () => {
    const r = rig({ wire: 'json' });
    r.tick({ yaw: Math.PI, mz: 1 });
    const z0 = r.client.predicted!.z;
    for (let n = 0; n < 120; n++) {
      r.client.sendInput(cmd(0, { yaw: Math.PI, mz: 1 })); // the host is not ticking
      r.client.advance(DT);
    }
    const ahead = r.client.predicted!.z - z0;
    expect(ahead).toBeGreaterThan(2.6 * 1.2);
    expect(ahead).toBeLessThan(2.6 * 1.6);
    expect(r.client.unacked).toBe(120);
    // The host wakes up and works through its backlog (skipping a burst it cannot keep up with).
    for (let n = 0; n < 90; n++) r.tick({ yaw: Math.PI, mz: 1 });
    for (let n = 0; n < 30; n++) r.tick({ yaw: Math.PI });
    const h = hostPlayer(r), me = r.client.me!;
    expect(Math.hypot(me.x - h.x, me.z - h.z)).toBeLessThan(1e-6);
  });

  it('keeps a snapshot at 4 players and 16 wolves under 8 KB: numbers rounded, unchanged entities not resent', () => {
    const sim = new Sim(world, { seed: 8, debug: true, players: 4 });
    const r = rig({ wire: 'json' }, sim);
    const bots = [1, 2, 3].map((k) => r.host.addBot('B' + k));
    for (let i = 0; i < 16; i++) sim.ctx.spawn(makeWolf(10 + (i % 4) * 3, 0, -20 - Math.floor(i / 4) * 3, { pack: i % 4, alpha: i % 4 === 0 }));
    const log = sim.ctx.spawn(makeLog(-6, 0, 12, { len: 2.4 })); // a heavy log nobody touches
    const from = r.got.length;
    for (let n = 0; n < 150; n++) {
      for (let k = 0; k < 3; k++) r.host.setBotInput(bots[k].id, scriptCmd(k + 1, n));
      r.tick(scriptCmd(0, n));
    }
    const snaps = r.got.slice(from).filter((m): m is Snapshot => m.t === 'snap');
    const bytes = snaps.map((s) => JSON.stringify(s).length);
    const avg = bytes.reduce((a, b) => a + b, 0) / bytes.length;
    expect(snaps.length).toBeGreaterThan(140);
    expect(avg, `${(avg / 1024).toFixed(2)} KB per snapshot`).toBeLessThan(8 * 1024);
    // the log went out once, then not again until it changes
    expect(snaps.filter((s) => s.ents.some((e) => e.id === log.id)).length).toBe(1);
    // remote numbers come rounded to a thousandth; the client's own player at full precision
    const last = snaps[snaps.length - 1];
    const wolf = last.ents.find((e) => e.kind === 'wolf')!;
    expect(Math.abs(wolf.x * 1000 - Math.round(wolf.x * 1000))).toBeLessThan(1e-6);
    const mine = last.ents.find((e) => e.id === r.client.myId)!;
    expect(mine.x).toBe(hostPlayer(r).x);
  });

  it('runs a host tick and a client frame for 4 players, 12 wolves and 600 statics in well under 1 ms', () => {
    const sim = new Sim(world, { seed: 8, debug: true, players: 4 });
    for (let i = 0; i < 12; i++) sim.ctx.spawn(makeWolf(20 + i, 0, -30, { pack: i % 2 }));
    while (sim.state.ents.length < 12 + 600) sim.ctx.spawn(makePickup('stick', 1, (sim.state.ents.length % 40) * 2 - 40, 0, 40));
    const host = new Host(sim);
    const lb = createLoopback({ wire: 'ref' });
    host.connect(lb.host);
    const client = new ClientSession(lb.client, { name: 'Ann' });
    client.setWorld(world);
    const bots = [1, 2, 3].map((k) => host.addBot('B' + k));
    const c = cmd(0);
    let n = 0, events = 0;
    const loop = () => {
      for (let k = 0; k < 3; k++) host.setBotInput(bots[k].id, scriptCmd(k + 1, n, c));
      if (n % 30 === 0) sim.ctx.touch(sim.ctx.all('pickup')[n % 600]);
      client.sendInput(scriptCmd(0, n, c));
      host.tick();
      client.advance(DT / 2);
      client.advance(DT / 2);
      events += client.drainEvents().length;
      n++;
    };
    for (let i = 0; i < 600; i++) loop(); // warm up the JIT
    // best of five rounds of 180 ticks; the budget follows the machine's measured slowdown (sim/timing.ts)
    const { ms, slow } = cost(loop, 180, 5);
    expect(client.ents.size).toBe(616);
    expect(events).toBeGreaterThan(0);
    // the design budget; measured about 0.1 ms on an idle machine
    expect(ms, `${ms.toFixed(4)} ms per tick (machine ${slow.toFixed(2)}x slower than idle)`).toBeLessThan(1.0 * slow);
  }, LONG_TEST_MS);

  it('a client continuing a saved game takes back its body and numbering', () => {
    const r = rig({ wire: 'json' });
    for (let n = 0; n < 30; n++) r.tick({ mz: 1 });
    const save = r.sim.serialize();
    const sim2 = Sim.fromState(world, save, { seed: 0, debug: true });
    const r2 = rig({ wire: 'json' }, sim2);
    const p = sim2.ctx.players();
    expect(p.length).toBe(1);
    expect(r2.client.myId).toBe(p[0].id);
    expect(r2.client.ack).toBe(p[0].seq);
    r2.tick({ mz: 1 });
    expect(p[0].seq).toBe(r2.client.ack);
    expect(p[0].seq).toBeGreaterThan(30);
  });
});
