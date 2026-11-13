// The host: wraps a Sim, accepts clients over any HostSideTransport and sends each one a
// snapshot per tick. Dynamic entities (DYNAMIC_KINDS) go out every tick; the rest only when
// their `rev` has changed since that client last got them. Snapshot contents are copies: the sim
// keeps mutating its own objects, and with the 'ref' wire the client holds what it is handed.
// Companion bots are players with no transport, driven through the same input and action path.
// Owner: NET.
import { MAX_PLAYERS, type Sim } from '../sim/sim';
import { copyInput, ENTITY_KINDS, neutralInput } from '../sim/entities';
import { DYNAMIC_KINDS, type Action, type Entity, type EntityKind, type Env, type IceCell, type InputCmd, type NetId, type Objective, type PlayerEnt, type SimEvent, type Stats } from '../sim/types';
import { PROTOCOL, type ClientMsg, type HostSideTransport, type Snapshot } from './protocol';

const STATIC_KINDS: readonly EntityKind[] = ENTITY_KINDS.filter((k) => !DYNAMIC_KINDS.includes(k));

/** Commands waiting beyond this are a lag burst: the oldest are skipped (their buttons are kept). */
const MAX_BACKLOG = 5;
const KEEP_BACKLOG = 2;
/** Ticks without a command before a silent client's player stops walking. */
const STARVE_TICKS = 15;
const STATS_EVERY = 10; // ticks between stats updates, at most
const NAME_MAX = 24;
const EMPTY_IDS: readonly NetId[] = Object.freeze([]) as readonly NetId[];
const EMPTY_ICE: readonly IceCell[] = Object.freeze([]) as readonly IceCell[];

interface Conn {
  t: HostSideTransport;
  /** Player id once 'hello' has been accepted, else 0. */
  id: NetId;
  queue: InputCmd[];
  lastSeq: number;
  starved: number;
  /** rev of every slow entity as last sent to this client. */
  sent: Map<NetId, number>;
  /** The wire form (JSON) of every dynamic entity as last sent to this client: unchanged ones are skipped. */
  dynSent: Map<NetId, string>;
  open: boolean;
}

/**
 * The wire copy of an entity, env or objective: a deep copy with every fractional number rounded to
 * a thousandth (a millimetre, a milliradian). Remote things are drawn 100 ms in the past between two
 * such samples, so nothing a player sees changes; the snapshot shrinks by about a third. The receiving
 * client's own player goes at full precision (its prediction replays commands on top of it).
 */
function wire<T>(v: T): T {
  if (Array.isArray(v)) {
    const a = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      a[i] = typeof x === 'object' && x !== null ? wire(x) : typeof x === 'number' ? q3(x) : x;
    }
    return a as unknown as T;
  }
  const o = { ...(v as object) } as Record<string, unknown>;
  for (const k in o) {
    const x = o[k];
    if (typeof x === 'number') o[k] = q3(x);
    else if (typeof x === 'object' && x !== null) o[k] = wire(x);
  }
  return o as T;
}

const q3 = (x: number): number => (Number.isInteger(x) ? x : Math.round(x * 1000) / 1000);

/**
 * Deep copy of plain JSON data (entities, env, objective). The spread copies an object's shape in
 * one go; only nested objects (a pack, a crate's loot) are then replaced by their own copies.
 */
function clone<T>(v: T): T {
  if (Array.isArray(v)) {
    const a = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      a[i] = typeof x === 'object' && x !== null ? clone(x) : x;
    }
    return a as unknown as T;
  }
  const o = { ...(v as object) } as Record<string, unknown>;
  for (const k in o) {
    const x = o[k];
    if (typeof x === 'object' && x !== null) o[k] = clone(x);
  }
  return o as T;
}

function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';
  return s || 'Survivor';
}

export class Host {
  readonly sim: Sim;
  private readonly conns: Conn[] = [];
  /** Players that someone (a client or a bot brain) is driving. */
  private readonly claimed = new Set<NetId>();
  private readonly bots = new Set<NetId>();
  private readonly iceSent = new Map<number, number>();
  private readonly iceSeen = new Set<number>();
  private statsSent: Stats | null = null;
  private statsTick = 0;
  private readonly scratch = neutralInput();

  constructor(sim: Sim) {
    this.sim = sim;
    for (const c of sim.state.ice) this.iceSent.set(c.i, iceCode(c));
  }

  /** Number of clients that have joined. */
  get clients(): number {
    let n = 0;
    for (const c of this.conns) if (c.id) n++;
    return n;
  }

  /** Start listening to a transport. The client joins by sending 'hello'. */
  connect(t: HostSideTransport): void {
    const conn: Conn = { t, id: 0, queue: [], lastSeq: 0, starved: 0, sent: new Map(), dynSent: new Map(), open: true };
    this.conns.push(conn);
    t.onClose = () => this.drop(conn, false);
    t.onMessage = (m) => this.receive(conn, m);
  }

  /** Add a companion: a player with no transport. Resumes a saved bot of the same name if there is one. */
  addBot(name: string): PlayerEnt {
    const n = cleanName(name);
    let p = this.findUnclaimed(n, true);
    if (!p) p = this.sim.addPlayer(n, { bot: true });
    this.claimed.add(p.id);
    this.bots.add(p.id);
    return p;
  }

  removeBot(id: NetId): void {
    if (!this.bots.delete(id)) return;
    this.claimed.delete(id);
    this.sim.removePlayer(id);
  }

  setBotInput(id: NetId, cmd: InputCmd): void {
    if (this.bots.has(id)) this.sim.setInput(id, cmd);
  }

  /** A bot's discrete request: the same path a client's 'act' message takes. */
  botAct(id: NetId, a: Action): boolean {
    return this.bots.has(id) ? this.sim.act(id, a) : false;
  }

  /** Step the simulation once and send every client its snapshot. Returns the tick's events (do not modify). */
  tick(): SimEvent[] {
    const sim = this.sim;

    // One command per player per tick, in order, so the client's prediction replays exactly what ran here.
    for (const c of this.conns) {
      if (!c.id) continue;
      const q = c.queue;
      if (q.length > MAX_BACKLOG) {
        let held = 0;
        while (q.length > KEEP_BACKLOG) held |= q.shift()!.b;
        q[0].b |= held; // a press that fell in the skipped commands still registers
      }
      if (q.length > 0) {
        sim.setInput(c.id, q.shift()!);
        c.starved = 0;
      } else if (++c.starved === STARVE_TICKS) {
        // Silent for half a second: let go of the controls, keep the view direction.
        const last = sim.ctx.input(c.id);
        const n = copyInput(this.scratch, last);
        n.mx = 0;
        n.mz = 0;
        n.b = 0;
        sim.setInput(c.id, n);
      }
    }

    const events = sim.step();
    const st = sim.state;
    if (this.clients === 0) {
      // Nobody to tell; keep the ice and stats baselines current for whoever joins (they get the full state).
      return events;
    }

    // --- what every client gets, copied once (the wire copies, rounded; see wire()) --------------
    const env: Env = wire(st.env);
    const objective: Objective = clone(st.objective);
    const dyn = this.dyn;
    const dynJson = this.dynJson;
    dyn.length = 0;
    dynJson.length = 0;
    for (const k of DYNAMIC_KINDS) {
      const list = sim.ctx.all(k);
      for (let i = 0; i < list.length; i++) {
        const copy = wire(list[i] as Entity);
        dyn.push(copy);
        dynJson.push(JSON.stringify(copy));
      }
    }
    const removed = sim.removed.length > 0 ? sim.removed.slice() : (EMPTY_IDS as NetId[]);
    const ice = this.iceChanges();
    let stats: Stats | undefined;
    if (st.tick - this.statsTick >= STATS_EVERY && !sameStats(this.statsSent, st.stats)) {
      stats = clone(st.stats);
      this.statsSent = stats;
      this.statsTick = st.tick;
    }
    let targeted = false;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.t === 'toast' && e.to !== 0) {
        targeted = true;
        break;
      }
    }

    // --- per client: slow entities whose rev moved, its ack, its toasts --------------------------
    // A transport without lag delivers inside send(), and the receiver may leave on the spot:
    // walk a copy of the connection list.
    const copies = this.copies;
    copies.clear();
    const conns = this.connScratch;
    conns.length = 0;
    for (const c of this.conns) conns.push(c);
    for (const c of conns) {
      if (!c.id || !c.open) continue;
      const me = sim.ctx.get<PlayerEnt>(c.id);
      // Dynamic entities: the client's own player always, at full precision (its prediction starts
      // from it); every other one only when its wire form changed since this client last got it (a
      // heavy log lying in the snow, a dead wolf, a fire between two changes): the client holds an
      // entity that is not in a snapshot at its last state, exactly as it does slow entities.
      const ents: Entity[] = [];
      const ds = c.dynSent;
      for (let i = 0; i < dyn.length; i++) {
        const e = dyn[i];
        if (e.id === c.id) {
          if (me) ents.push(clone(me as Entity));
          continue;
        }
        if (ds.get(e.id) === dynJson[i]) continue;
        ds.set(e.id, dynJson[i]);
        ents.push(e);
      }
      for (const k of STATIC_KINDS) {
        const list = sim.ctx.all(k);
        for (let i = 0; i < list.length; i++) {
          const e = list[i] as Entity;
          if (c.sent.get(e.id) === e.rev) continue;
          c.sent.set(e.id, e.rev);
          let copy = copies.get(e.id);
          if (!copy) copies.set(e.id, (copy = clone(e)));
          ents.push(copy);
        }
      }
      for (let i = 0; i < removed.length; i++) {
        c.sent.delete(removed[i]);
        ds.delete(removed[i]);
      }
      const snap: Snapshot = {
        t: 'snap',
        tick: st.tick,
        ack: me ? me.seq : 0,
        env,
        objective,
        ents,
        removed,
        ice,
        events: targeted ? events.filter((e) => e.t !== 'toast' || e.to === 0 || e.to === c.id) : events,
      };
      if (stats) snap.stats = stats;
      c.t.send(snap);
    }
    conns.length = 0;
    return events;
  }

  /** Tell every client the session is over and stop listening. */
  close(): void {
    for (const c of this.conns.slice()) {
      if (c.open) c.t.send({ t: 'bye' });
      this.drop(c, true);
    }
  }

  // --- internals ----------------------------------------------------------------------------------

  private readonly copies = new Map<NetId, Entity>();
  private readonly connScratch: Conn[] = [];
  /** This tick's wire copies of the dynamic entities and their JSON (shared by every client). */
  private readonly dyn: Entity[] = [];
  private readonly dynJson: string[] = [];

  private receive(c: Conn, m: ClientMsg): void {
    if (!c.open || !m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        this.hello(c, m.proto, m.name);
        break;
      case 'input': {
        if (!c.id || !Array.isArray(m.cmds)) return;
        for (const cmd of m.cmds) {
          if (!cmd || typeof cmd !== 'object' || !(cmd.seq > c.lastSeq)) continue;
          if (c.queue.length >= 64) c.queue.shift();
          const q = copyInput(neutralInput(), cmd);
          c.lastSeq = q.seq;
          c.queue.push(q);
        }
        break;
      }
      case 'act':
        if (c.id && m.a && typeof m.a === 'object') this.sim.act(c.id, m.a);
        break;
      case 'bye':
        this.drop(c, true);
        break;
    }
  }

  private hello(c: Conn, proto: number, rawName: string): void {
    if (c.id) return;
    if (proto !== PROTOCOL) {
      c.t.send({ t: 'refuse', why: 'This game is a different version.' });
      this.drop(c, true);
      return;
    }
    const sim = this.sim;
    const name = cleanName(rawName);
    // A loaded game already has its players: take one back rather than adding another.
    let p = this.findUnclaimed(name, false);
    if (!p) {
      if (sim.ctx.players().length >= MAX_PLAYERS) {
        c.t.send({ t: 'refuse', why: 'The game is full.' });
        this.drop(c, true);
        return;
      }
      p = sim.addPlayer(name);
    } else if (p.name !== name) {
      p.name = name;
    }
    c.id = p.id;
    c.lastSeq = p.seq;
    this.claimed.add(p.id);
    // Baseline: the welcome carries everything, so the client has every slow entity at its current rev.
    c.sent.clear();
    c.dynSent.clear();
    for (const k of STATIC_KINDS) for (const e of sim.ctx.all(k)) c.sent.set(e.id, e.rev);
    c.t.send({ t: 'welcome', proto: PROTOCOL, you: p.id, seed: sim.state.seed, state: JSON.parse(sim.serialize()) });
  }

  private findUnclaimed(name: string, bot: boolean): PlayerEnt | undefined {
    let any: PlayerEnt | undefined;
    for (const p of this.sim.ctx.players()) {
      if (p.bot !== bot || this.claimed.has(p.id)) continue;
      if (p.name === name) return p;
      any ??= p;
    }
    // A human takes over any free body (a renamed player continuing a save); a bot only its own.
    return bot ? undefined : any;
  }

  private drop(c: Conn, closeTransport: boolean): void {
    if (!c.open) return;
    c.open = false;
    const i = this.conns.indexOf(c);
    if (i >= 0) this.conns.splice(i, 1);
    c.t.onMessage = null;
    c.t.onClose = null;
    if (c.id) {
      this.claimed.delete(c.id);
      this.sim.removePlayer(c.id);
      c.id = 0;
    }
    if (closeTransport) c.t.close();
  }

  /** Ice cells whose stress moved by a hundredth or more, opened, or healed away, since last sent. */
  private iceChanges(): IceCell[] {
    const cells = this.sim.state.ice;
    const sent = this.iceSent;
    let out: IceCell[] | null = null;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const code = iceCode(c);
      if (sent.get(c.i) !== code) {
        sent.set(c.i, code);
        // the new ice over a broken cell goes too (in millimetres): clients draw the film and the scar
        const cell: IceCell = { i: c.i, stress: c.stress, hole: c.hole };
        if (c.skin !== undefined) cell.skin = Math.round(c.skin * 1000) / 1000;
        (out ??= []).push(cell);
      }
    }
    if (sent.size > cells.length) {
      // Cells the sim dropped (healed): tell clients they are sound again.
      const seen = this.iceSeen;
      seen.clear();
      for (let i = 0; i < cells.length; i++) seen.add(cells[i].i);
      for (const i of sent.keys()) {
        if (!seen.has(i)) {
          sent.delete(i);
          (out ??= []).push({ i, stress: 0, hole: false });
        }
      }
    }
    return out ?? (EMPTY_ICE as IceCell[]);
  }
}

/** A cell's state at the resolution worth sending: a hole, or stress in hundredths; and its new skin in millimetres. */
function iceCode(c: IceCell): number {
  return (c.hole ? 1000 : Math.round(c.stress * 100)) + (c.skin !== undefined ? 2000 + Math.round(c.skin * 1000) * 4096 : 0);
}

function sameStats(a: Stats | null, b: Stats): boolean {
  return (
    a !== null && a.distance === b.distance && a.firesLit === b.firesLit && a.wolvesKilled === b.wolvesKilled &&
    a.revives === b.revives && a.downs === b.downs && a.coldest === b.coldest && a.shots === b.shots
  );
}
