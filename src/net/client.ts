// The client session: where a player's machine meets the game. It sends commands and actions to
// a Host over any ClientTransport and turns the host's snapshots into what presentation reads:
//  - remote entities, shown about 100 ms in the past and interpolated between snapshots
//    (position and yaw; every other field from the newer of the two snapshots);
//  - the local player, predicted with the same stepPlayerMove the host runs: the newest
//    authoritative state with every command the host has not yet applied replayed on top;
//    small corrections are smoothed away, large ones (a teleport, a respawn) snap;
//  - the environment interpolated, and ice, stats, objective and events released when their
//    moment comes on the presentation clock. Events about the local player are released on
//    arrival (the local player lives in the present), and its footsteps, jumps and landings
//    come from the prediction itself, at once; the host's copies of those are dropped.
// Single-player is this class joined to a local Host by the loopback transport.
//
// Use, each frame:     pump the transport if it has lag, then for each 30 Hz tick
//                      sendInput(cmd) (and host.tick() when the host is local), then advance(dt),
//                      then read ents / me / env ... and drainEvents().
// Owner: NET.
import { lerpAngle, wrapAngle } from '../core/math';
import type { ViewEnt } from '../game/view';
import { copyInput, ENTITY_KINDS, makeEnv, makeObjective, makeStats, neutralInput } from '../sim/entities';
import { movePlayer, stepPlayerMove, strideLength, WALK_SPEED, type Gait } from '../sim/move';
import {
  DT, type Action, type Entity, type EntityKind, type Env, type IceCell, type InputCmd, type NetId, type Objective,
  type PlayerEnt, type SimEvent, type SimState, type Stats,
} from '../sim/types';
import type { World } from '../world/types';
import { PROTOCOL, type ClientTransport, type HostMsg, type Snapshot } from './protocol';

/** Remote entities are shown this far in the past, seconds: three snapshots of cushion. */
export const INTERP_DELAY = 0.1;
/** Prediction errors larger than this (metres) snap; smaller ones are smoothed away. */
export const SNAP_DIST = 1.5;
/** Presentation further behind its target than this (s) jumps forward: a stall or a hidden tab. */
const MAX_BEHIND = 0.5;
/** The presentation clock runs at most this much faster or slower than real time to hold its delay. */
const RATE_MAX = 0.15;
const RATE_GAIN = 1; // rate change per second of error
/** 1/s: a smoothed correction fades with a time constant of about 80 ms. */
const CORRECT_RATE = 12;
/** Commands repeated in every input message, so a lossy transport loses nothing. */
const SEND_LAST = 3;
/** Un-acked commands kept (5 s). Beyond this the host is not applying them; the oldest go. */
const MAX_PENDING = 150;
/**
 * The prediction runs at most this many commands (1.5 s) ahead of the host. A host that stops
 * answering (paused, stalled) leaves the predicted player standing instead of walking off alone.
 */
const MAX_PREDICT = 45;
const MAX_SAMPLES = 64; // per entity
const MAX_FRAMES = 300; // snapshots waiting for their presentation time (10 s)
const MAX_OUT = 2000; // undrained events

const EMPTY_EVENTS = Object.freeze([]) as unknown as SimEvent[];

/** Everything this client knows about one entity. */
interface Track {
  id: NetId;
  /** The object presentation holds: the same one for the whole life of the entity. */
  view: ViewEnt;
  /** Received states, oldest first, and their ticks. Samples are never modified. */
  ticks: number[];
  samples: Entity[];
  /** The sample whose fields were last copied into `view`. */
  applied: Entity | null;
  shown: boolean;
  /** Came with the welcome: shown at once, whatever the presentation clock says. */
  welcome: boolean;
  /** Client clock when it was first shown (for ViewEnt.age). */
  born: number;
  /** Presentation tick at which it disappears, Infinity while it exists. */
  removeTick: number;
  /** Index in the session's list of shown tracks, -1 when not shown. */
  slot: number;
}

/** One snapshot's world-wide part, waiting for its presentation time. */
interface Frame {
  tick: number;
  env: Env;
  objective: Objective;
  stats: Stats | undefined;
  ice: IceCell[];
  events: SimEvent[];
  done: boolean;
}

/** Interpolate the environment; numbers lerp (the hour across midnight), anything else from b. */
function lerpEnv(dst: Env, a: Env, b: Env, f: number): void {
  const d = dst as unknown as Record<string, unknown>;
  const A = a as unknown as Record<string, unknown>;
  const B = b as unknown as Record<string, unknown>;
  for (const k in B) {
    const x = A[k], y = B[k];
    d[k] = typeof x === 'number' && typeof y === 'number' ? x + (y - x) * f : y;
  }
  let dc = b.clock - a.clock;
  if (dc < -12) dc += 24;
  else if (dc > 12) dc -= 24;
  let c = a.clock + dc * f;
  if (c >= 24) c -= 24;
  else if (c < 0) c += 24;
  dst.clock = c;
  dst.day = f < 0.5 ? a.day : b.day;
}

function isMoveEvent(ev: SimEvent): boolean {
  return ev.t === 'step' || ev.t === 'jump' || ev.t === 'land';
}

/** Drop the first k elements in place (splice would allocate the removed ones every call). */
function dropFront<T>(a: T[], k: number): void {
  const n = a.length;
  for (let i = k; i < n; i++) a[i - k] = a[i];
  a.length = n - k;
}

export class ClientSession {
  readonly name: string;
  /** World seed, from the welcome. */
  seed = 0;
  /** The local player's id, from the welcome. */
  myId: NetId = 0;
  /** True once the welcome has arrived. */
  ready = false;
  /** True once the host said bye or refused, or the transport closed. */
  closed = false;
  /** Why the host turned this client away, or null. */
  refused: string | null = null;

  /** Every entity presentation should draw, by id. A ViewEnt keeps its identity for the entity's life. */
  readonly ents = new Map<NetId, ViewEnt>();
  /** The local player (predicted and smoothed), also in `ents`; null before the welcome. */
  me: ViewEnt<PlayerEnt> | null = null;
  /** Interpolated environment (one object, updated in place). */
  readonly env: Env = makeEnv();
  readonly objective: Objective = makeObjective();
  readonly ice = new Map<number, IceCell>();
  readonly stats: Stats = makeStats();
  /** Bumped whenever an entity appears in or leaves `ents`. */
  version = 0;
  /** Newest snapshot tick received. */
  tick = 0;
  /** Presentation clock, seconds of simulated time: remote things are drawn as they were then. */
  time = 0;
  /** Newest command seq the host has applied. */
  ack = 0;

  private readonly t: ClientTransport;
  private world: World | null = null;
  private readonly tracks = new Map<NetId, Track>();
  /** Tracks that need work on the next advance (moving, appearing, leaving). */
  private readonly active = new Set<Track>();
  /** Every shown track, in no particular order (ages are updated from this each frame). */
  private readonly shownList: Track[] = [];
  private frames: Frame[] = [];
  private out: SimEvent[] = [];
  /** Client seconds since the session started (ages). */
  private clock = 0;
  private readonly lists = {} as Record<EntityKind, ViewEnt[]>;
  private listsVersion = -1;

  // --- the local player
  private meTrack: Track | null = null;
  /** Newest authoritative state of the local player (a received object, never modified). */
  private auth: PlayerEnt | null = null;
  private authApplied: PlayerEnt | null = null;
  /** A snapshot moved `auth` or `ack`: replay before the prediction is next used. */
  private dirty = false;
  /** The predicted local player (auth + every pending command). */
  private pred: PlayerEnt | null = null;
  private readonly pending: InputCmd[] = [];
  private seq = 0;
  /** Seconds since the last command: the drawn position moves across the tick with it. */
  private sinceCmd = 0;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  /** What is left of smoothed corrections, metres, fading to 0. */
  private offX = 0;
  private offY = 0;
  private offZ = 0;
  private readonly gait: Gait = { dist: 0.5 * strideLength(WALK_SPEED), left: false };
  private readonly emitLocal = (ev: SimEvent): void => this.push(ev);

  constructor(t: ClientTransport, o: { name: string }) {
    this.t = t;
    this.name = o.name;
    for (const k of ENTITY_KINDS) this.lists[k] = [];
    t.onMessage = (m) => this.receive(m);
    t.onClose = () => {
      this.closed = true;
    };
    t.send({ t: 'hello', proto: PROTOCOL, name: o.name });
  }

  /** The raw predicted local player (unsmoothed), or null without a world or before the welcome. */
  get predicted(): Readonly<PlayerEnt> | null {
    return this.world ? this.pred : null;
  }

  /** Commands sent that the host has not yet applied. */
  get unacked(): number {
    return this.pending.length;
  }

  /** The static world, built from `seed`. Turns on prediction of the local player. */
  setWorld(world: World): void {
    this.world = world;
    this.dirty = true;
  }

  /**
   * One command per 30 Hz tick. The session copies it and assigns its seq (the caller's seq is
   * ignored), predicts it at once, and sends it together with the last few unacknowledged ones.
   */
  sendInput(cmd: InputCmd): void {
    if (!this.ready || this.closed) return;
    if (this.dirty) this.reconcile();
    const c = copyInput(neutralInput(), cmd);
    c.seq = ++this.seq;
    const q = this.pending;
    q.push(c);
    if (q.length > MAX_PENDING) q.shift();
    const p = this.pred;
    if (p && this.world && q.length <= MAX_PREDICT) {
      // The drawn position starts the new step from where it is now, so a burst of commands
      // (catching up after a slow frame) speeds the player up for a moment rather than jumping.
      const a = this.sinceCmd >= DT ? 1 : this.sinceCmd / DT;
      this.prevX += (p.x - this.prevX) * a;
      this.prevY += (p.y - this.prevY) * a;
      this.prevZ += (p.z - this.prevZ) * a;
      movePlayer(p, c, this.world, DT, this.gait, this.emitLocal);
    }
    this.sinceCmd = 0;
    const n = q.length < SEND_LAST ? q.length : SEND_LAST;
    this.t.send({ t: 'input', cmds: q.slice(q.length - n) });
  }

  /** A discrete request (equip, feed, ...). The host validates it. */
  sendAction(a: Action): void {
    if (!this.ready || this.closed || !a) return;
    const copy = { ...a } as Action;
    if (copy.t === 'debug' && copy.args) copy.args = copy.args.slice();
    this.t.send({ t: 'act', a: copy });
  }

  /** Move the presentation clock by real seconds and bring everything presentation reads up to it. */
  advance(dt: number): void {
    if (!(dt > 0)) dt = 0;
    this.clock += dt;
    this.sinceCmd += dt;
    if (!this.ready) return;

    // The clock aims INTERP_DELAY behind the newest snapshot, drifting at most RATE_MAX off real
    // time to get there; it never runs past what has arrived and never goes back.
    const newest = this.tick * DT;
    const target = newest - INTERP_DELAY;
    let t = this.time;
    const err = target - t;
    if (err > MAX_BEHIND) t = target;
    else {
      let r = err * RATE_GAIN;
      r = r < -RATE_MAX ? -RATE_MAX : r > RATE_MAX ? RATE_MAX : r;
      t += dt * (1 + r);
    }
    if (t > newest) t = newest;
    if (t > this.time) this.time = t;

    const rt = this.time / DT;
    this.presentFrames(rt);
    this.presentEntities(rt);
    this.presentMe(dt);
    const shown = this.shownList, clock = this.clock;
    for (let i = 0; i < shown.length; i++) shown[i].view.age = clock - shown[i].born;
  }

  /**
   * Events whose presentation time has come, oldest first. A non-empty array is the caller's to
   * keep; "nothing" is one shared frozen empty array. The event objects themselves are read-only.
   */
  drainEvents(): SimEvent[] {
    if (this.out.length === 0) return EMPTY_EVENTS;
    const o = this.out;
    this.out = [];
    return o;
  }

  /** Entities of one kind, from `ents`. The array is the session's (one per kind, updated in place). */
  list<K extends EntityKind>(kind: K): ViewEnt<Extract<Entity, { kind: K }>>[] {
    if (this.listsVersion !== this.version) this.rebuildLists();
    let l = this.lists[kind];
    if (!l) this.lists[kind] = l = [];
    return l as unknown as ViewEnt<Extract<Entity, { kind: K }>>[];
  }

  /** Leave the game. */
  close(): void {
    if (this.closed) return;
    this.t.send({ t: 'bye' });
    this.closed = true;
    this.t.close();
  }

  // --- receiving ----------------------------------------------------------------------------------

  private receive(m: HostMsg): void {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome':
        if (m.proto !== PROTOCOL) this.refuse('This game is a different version.');
        else this.welcome(m.you, m.seed, m.state);
        break;
      case 'snap':
        this.snapshot(m);
        break;
      case 'refuse':
        this.refuse(typeof m.why === 'string' && m.why ? m.why : 'The host refused.');
        break;
      case 'bye':
        this.closed = true;
        break;
    }
  }

  private refuse(why: string): void {
    this.refused = why;
    this.closed = true;
  }

  private welcome(you: NetId, seed: number, st: SimState): void {
    if (!st || !Array.isArray(st.ents) || !st.env || !st.objective) {
      this.refuse('The host sent a damaged game.');
      return;
    }
    this.reset();
    this.seed = seed;
    this.myId = you;
    this.tick = st.tick;
    this.time = st.tick * DT - INTERP_DELAY;
    Object.assign(this.env, st.env);
    Object.assign(this.objective, st.objective);
    if (st.stats) Object.assign(this.stats, st.stats);
    if (Array.isArray(st.ice)) {
      for (const c of st.ice) {
        const cell: IceCell = { i: c.i, stress: c.stress, hole: c.hole };
        if (typeof c.skin === 'number') cell.skin = c.skin;
        this.ice.set(c.i, cell);
      }
    }
    this.frames.push({ tick: st.tick, env: st.env, objective: st.objective, stats: undefined, ice: [], events: [], done: true });
    for (const e of st.ents) {
      const tr = this.makeTrack(e, true);
      tr.ticks.push(st.tick);
      tr.samples.push(e);
      this.tracks.set(e.id, tr);
      if (e.id === you) {
        this.meTrack = tr;
        this.auth = e as PlayerEnt;
      }
      this.show(tr);
    }
    this.ack = this.auth ? this.auth.seq : 0;
    this.seq = this.ack; // a body taken back from a save continues its numbering
    this.dirty = true;
    this.ready = true;
  }

  private snapshot(s: Snapshot): void {
    if (!this.ready || !(s.tick > this.tick)) return;
    this.tick = s.tick;
    const me = this.myId;
    const predicting = this.world !== null;

    const ents = s.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.id === me) {
        this.auth = e as PlayerEnt;
        this.dirty = true;
        if (!this.meTrack) {
          const tr = this.makeTrack(e, true);
          this.tracks.set(e.id, tr);
          this.meTrack = tr;
          this.show(tr);
        }
        continue;
      }
      let tr = this.tracks.get(e.id);
      if (!tr) {
        tr = this.makeTrack(e, false);
        this.tracks.set(e.id, tr);
      } else {
        const n = tr.ticks.length;
        if (n > 0 && tr.ticks[n - 1] < s.tick - 1) {
          // A slow entity, unchanged since its last sample: it held that state until the tick before this.
          tr.ticks.push(s.tick - 1);
          tr.samples.push(tr.samples[n - 1]);
        }
      }
      tr.ticks.push(s.tick);
      tr.samples.push(e);
      if (tr.ticks.length > MAX_SAMPLES) {
        tr.ticks.shift();
        tr.samples.shift();
      }
      this.active.add(tr);
    }
    this.ack = s.ack;

    const removed = s.removed;
    for (let i = 0; i < removed.length; i++) {
      const tr = this.tracks.get(removed[i]);
      if (tr && tr.removeTick === Infinity) {
        tr.removeTick = s.tick;
        this.active.add(tr);
      }
    }

    // Events about the local player belong to the present, with the predicted body.
    const evs = s.events;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (this.isMine(ev) && !(predicting && isMoveEvent(ev))) this.push(ev);
    }

    const f = this.frames;
    f.push({ tick: s.tick, env: s.env, objective: s.objective, stats: s.stats, ice: s.ice, events: evs, done: false });
    while (f.length > MAX_FRAMES) {
      const old = f.shift()!;
      if (!old.done) this.presentFrame(old);
    }
  }

  // --- presenting ---------------------------------------------------------------------------------

  private presentFrames(rt: number): void {
    const f = this.frames;
    let k = -1;
    for (let i = 0; i < f.length; i++) {
      const fr = f[i];
      if (fr.tick > rt) break;
      if (!fr.done) this.presentFrame(fr);
      k = i;
    }
    if (f.length === 0) return;
    if (k < 0) Object.assign(this.env, f[0].env);
    else if (k + 1 < f.length) {
      const a = f[k], b = f[k + 1];
      lerpEnv(this.env, a.env, b.env, (rt - a.tick) / (b.tick - a.tick));
    } else Object.assign(this.env, f[k].env);
    if (k > 0) dropFront(f, k);
  }

  private presentFrame(fr: Frame): void {
    fr.done = true;
    const ice = fr.ice;
    for (let i = 0; i < ice.length; i++) {
      const c = ice[i];
      if (!c.hole && !(c.stress > 0) && c.skin === undefined) this.ice.delete(c.i);
      else {
        let m = this.ice.get(c.i);
        if (!m) this.ice.set(c.i, (m = { i: c.i, stress: 0, hole: false }));
        m.stress = c.stress;
        m.hole = c.hole;
        // new ice over a broken cell (IceCell.skin): present on such cells only
        if (typeof c.skin === 'number') m.skin = c.skin;
        else delete m.skin;
      }
    }
    if (fr.stats) Object.assign(this.stats, fr.stats);
    Object.assign(this.objective, fr.objective);
    const evs = fr.events;
    for (let i = 0; i < evs.length; i++) if (!this.isMine(evs[i])) this.push(evs[i]);
  }

  private presentEntities(rt: number): void {
    for (const tr of this.active) {
      if (rt >= tr.removeTick) {
        this.drop(tr);
        continue;
      }
      if (tr === this.meTrack) {
        this.active.delete(tr); // drawn from the prediction, never interpolated
        continue;
      }
      const ticks = tr.ticks, samples = tr.samples;
      let n = ticks.length;
      let k = n - 1;
      while (k >= 0 && ticks[k] > rt) k--;
      if (k > 0) {
        dropFront(ticks, k);
        dropFront(samples, k);
        n -= k;
        k = 0;
      }
      if (!tr.shown) {
        if (k < 0 && !tr.welcome) continue; // its first moment is still ahead
        this.show(tr);
      }
      const v = tr.view;
      const a = samples[k < 0 ? 0 : k];
      const b = k >= 0 && k + 1 < n ? samples[k + 1] : null;
      if (b) {
        if (tr.applied !== b) {
          Object.assign(v, b);
          tr.applied = b;
        }
        const f = (rt - ticks[k]) / (ticks[k + 1] - ticks[k]);
        v.x = a.x + (b.x - a.x) * f;
        v.y = a.y + (b.y - a.y) * f;
        v.z = a.z + (b.z - a.z) * f;
        v.yaw = wrapAngle(lerpAngle(a.yaw, b.yaw, f));
        if (a.kind === 'player' && b.kind === 'player') (v as ViewEnt<PlayerEnt>).pitch = a.pitch + (b.pitch - a.pitch) * f;
      } else {
        if (tr.applied !== a) {
          Object.assign(v, a);
          tr.applied = a;
        }
        v.x = a.x;
        v.y = a.y;
        v.z = a.z;
        v.yaw = a.yaw;
        if (a.kind === 'player') (v as ViewEnt<PlayerEnt>).pitch = a.pitch;
        // At rest until something new arrives (a pending removal keeps it on the list).
        if (n === 1 && tr.removeTick === Infinity) this.active.delete(tr);
      }
    }
  }

  private presentMe(dt: number): void {
    const tr = this.meTrack;
    if (!tr || !tr.shown) return;
    if (this.dirty) this.reconcile();
    const v = tr.view as ViewEnt<PlayerEnt>;
    const auth = this.auth;
    if (auth && this.authApplied !== auth) {
      Object.assign(v, auth);
      this.authApplied = auth;
    }
    const p = this.pred;
    if (!p || !this.world) return; // no prediction: the newest authoritative state as it is
    const k = Math.exp(-CORRECT_RATE * dt);
    this.offX *= k;
    this.offY *= k;
    this.offZ *= k;
    if (this.offX * this.offX + this.offY * this.offY + this.offZ * this.offZ < 1e-8) this.offX = this.offY = this.offZ = 0;
    const a = this.sinceCmd >= DT ? 1 : this.sinceCmd / DT;
    v.x = this.prevX + (p.x - this.prevX) * a + this.offX;
    v.y = this.prevY + (p.y - this.prevY) * a + this.offY;
    v.z = this.prevZ + (p.z - this.prevZ) * a + this.offZ;
    v.vx = p.vx;
    v.vy = p.vy;
    v.vz = p.vz;
    v.yaw = p.yaw;
    v.pitch = p.pitch;
    v.onGround = p.onGround;
    v.crouch = p.crouch;
    v.sprint = p.sprint;
    v.surface = p.surface;
    v.swim = p.swim;
    v.stamina = p.stamina;
  }

  /**
   * Rebuild the prediction: the newest authoritative state, then every command the host has not
   * applied yet. The difference from the old prediction is kept as an offset that fades (or, past
   * SNAP_DIST, dropped at once), so the drawn player does not jump.
   */
  private reconcile(): void {
    this.dirty = false;
    const q = this.pending;
    let n = 0;
    while (n < q.length && q[n].seq <= this.ack) n++;
    if (n > 0) dropFront(q, n);
    const auth = this.auth, world = this.world;
    if (!auth || !world) return;
    const old = this.pred;
    const ox = old ? old.x : 0, oy = old ? old.y : 0, oz = old ? old.z : 0;
    const p = old ?? ({} as PlayerEnt);
    Object.assign(p, auth);
    const replay = q.length < MAX_PREDICT ? q.length : MAX_PREDICT;
    for (let i = 0; i < replay; i++) stepPlayerMove(p, q[i], world, DT);
    this.pred = p;
    const dx = ox - p.x, dy = oy - p.y, dz = oz - p.z;
    if (!old || dx * dx + dy * dy + dz * dz > SNAP_DIST * SNAP_DIST) {
      this.prevX = p.x;
      this.prevY = p.y;
      this.prevZ = p.z;
      this.offX = this.offY = this.offZ = 0;
      this.sinceCmd = DT;
      return;
    }
    this.prevX -= dx;
    this.prevY -= dy;
    this.prevZ -= dz;
    this.offX += dx;
    this.offY += dy;
    this.offZ += dz;
    if (this.offX * this.offX + this.offY * this.offY + this.offZ * this.offZ > SNAP_DIST * SNAP_DIST) this.offX = this.offY = this.offZ = 0;
  }

  // --- bookkeeping --------------------------------------------------------------------------------

  private makeTrack(e: Entity, welcome: boolean): Track {
    return {
      id: e.id,
      view: { ...e, age: 0 } as ViewEnt,
      ticks: [],
      samples: [],
      applied: e,
      shown: false,
      welcome,
      born: this.clock,
      removeTick: Infinity,
      slot: -1,
    };
  }

  private show(tr: Track): void {
    if (tr.shown) return;
    tr.shown = true;
    tr.born = this.clock;
    tr.view.age = 0;
    tr.slot = this.shownList.length;
    this.shownList.push(tr);
    this.ents.set(tr.id, tr.view);
    this.version++;
    if (tr === this.meTrack) this.me = tr.view as ViewEnt<PlayerEnt>;
  }

  /** Forget an entity entirely (it was removed and its time has come). */
  private drop(tr: Track): void {
    this.active.delete(tr);
    this.tracks.delete(tr.id);
    if (tr.shown) {
      tr.shown = false;
      const list = this.shownList;
      const last = list.pop()!;
      if (last !== tr) {
        list[tr.slot] = last;
        last.slot = tr.slot;
      }
      tr.slot = -1;
      this.ents.delete(tr.id);
      this.version++;
    }
    if (tr === this.meTrack) {
      this.meTrack = null;
      this.me = null;
      this.auth = this.authApplied = this.pred = null;
    }
  }

  private isMine(ev: SimEvent): boolean {
    const me = this.myId;
    if (me === 0) return false;
    const o = ev as { id?: NetId; by?: NetId };
    return o.id === me || o.by === me || (ev.t === 'toast' && ev.to === me);
  }

  private push(ev: SimEvent): void {
    if (this.out.length >= MAX_OUT) this.out.shift();
    this.out.push(ev);
  }

  private rebuildLists(): void {
    const lists = this.lists;
    for (const k in lists) lists[k as EntityKind].length = 0;
    for (const v of this.ents.values()) {
      let l = lists[v.kind];
      if (!l) lists[v.kind] = l = [];
      l.push(v);
    }
    this.listsVersion = this.version;
  }

  private reset(): void {
    this.tracks.clear();
    this.active.clear();
    this.shownList.length = 0;
    if (this.ents.size > 0) this.version++;
    this.ents.clear();
    this.frames = [];
    this.ice.clear();
    this.pending.length = 0;
    this.meTrack = null;
    this.me = null;
    this.auth = this.authApplied = this.pred = null;
    this.offX = this.offY = this.offZ = 0;
    this.sinceCmd = DT;
  }
}
