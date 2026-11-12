// The simulation core: owns SimState (plain JSON), advances it in fixed 1/30 s ticks, and gives
// systems their context. Everything that must survive a save lives in `state`; what is kept
// beside it here (the id index, per-kind lists, the latest commands) is rebuilt on load.
// No three, no DOM, no Math.random, no wall clock.
// Owner: SIM.
import { rngStep } from '../core/rng';
import type { World } from '../world/types';
import type { SimCtx, SimOptions, System } from './api';
import { copyInput, ENTITY_KINDS, makePlayer, makeState, neutralInput, STATE_VERSION } from './entities';
import { SYSTEMS } from './systems/index';
import { DT, type Action, type Entity, type EntityKind, type InputCmd, type NetId, type PlayerEnt, type SimEvent, type SimState } from './types';

export { copyInput, ENTITY_KINDS };

export const MAX_PLAYERS = 4;

const KINDS = ENTITY_KINDS;

/** What the sim remembers about a player's controls between ticks (not part of the saved state, except `prevKey`). */
interface Controls {
  cmd: InputCmd;
  /** Buttons held on the previous tick, mirrored into state.vars so edges survive a save. */
  prev: number;
  prevKey: string;
}

const NEUTRAL: Readonly<InputCmd> = Object.freeze(neutralInput());

export class Sim {
  readonly world: World;
  readonly state: SimState;
  readonly ctx: SimCtx;
  readonly systems: readonly System[];
  readonly debug: boolean;
  /**
   * Ids removed since the previous step() returned (by that step's systems or by actions before
   * it). Valid until the next act(), removePlayer() or step().
   */
  readonly removed: NetId[] = [];

  private readonly index = new Map<NetId, number>();
  private readonly lists = {} as Record<EntityKind, Entity[]>;
  private readonly controls = new Map<NetId, Controls>();
  private events: SimEvent[] = [];
  private readonly doomed: NetId[] = [];
  private readonly doomedSet = new Set<NetId>();
  private removedStale = false;

  constructor(world: World, opts: SimOptions, systems: readonly System[] = SYSTEMS, state?: SimState) {
    this.world = world;
    this.systems = systems;
    this.debug = !!opts.debug;
    const resumed = state !== undefined;
    this.state = state ?? makeState(opts.seed);
    this.ctx = this.makeCtx();
    this.reindex();
    if (!resumed) {
      this.state.vars['sim.players'] = Math.max(1, Math.min(MAX_PLAYERS, Math.floor(opts.players ?? 1)));
      for (const s of systems) {
        s.init?.(this.ctx);
        this.flushRemoved();
      }
      // Nobody is listening yet; a new game starts with a clean slate of events.
      this.events.length = 0;
      this.removed.length = 0;
    }
  }

  /** Resume a saved game. `state` is the object or its JSON; the Sim takes ownership of the object. */
  static fromState(world: World, state: SimState | string, opts: SimOptions, systems: readonly System[] = SYSTEMS): Sim {
    const s: SimState = typeof state === 'string' ? JSON.parse(state) : state;
    if (!s || s.version !== STATE_VERSION) throw new Error(`Cold Signal save version ${s ? s.version : '?'} cannot be loaded (expected ${STATE_VERSION})`);
    if (!Array.isArray(s.ents)) throw new Error('Cold Signal save is damaged');
    return new Sim(world, { ...opts, seed: s.seed }, systems, s);
  }

  // --- players ----------------------------------------------------------------------------------

  /** Add a player at the next free spawn slot and run every system's join hook. */
  addPlayer(name: string, o: { bot?: boolean } = {}): PlayerEnt {
    const players = this.lists.player as PlayerEnt[];
    let slot = 0;
    for (; slot < MAX_PLAYERS; slot++) {
      let used = false;
      for (const q of players) if (q.slot === slot) used = true;
      if (!used) break;
    }
    if (slot === MAX_PLAYERS) slot = players.length % MAX_PLAYERS;
    const spots = this.world.spawn.players;
    const sp = spots.length > 0 ? spots[slot % spots.length] : { x: 0, y: this.world.heightAt(0, 0), z: 0, yaw: 0 };
    const y = this.world.groundAt(sp.x, sp.z, sp.y).y;
    const p = this.ctx.spawn<PlayerEnt>(makePlayer(name, slot, sp.x, y, sp.z, sp.yaw, !!o.bot));
    p.surface = this.world.groundAt(sp.x, sp.z, y).surface;
    const c = this.controlsOf(p.id);
    c.cmd.yaw = sp.yaw;
    for (const s of this.systems) {
      s.join?.(this.ctx, p);
      this.flushRemoved();
    }
    return p;
  }

  /** A player leaves: every system's leave hook runs while the entity still exists, then it is removed. */
  removePlayer(id: NetId): void {
    const e = this.ctx.get(id);
    if (!e || e.kind !== 'player') return;
    for (const s of this.systems) {
      s.leave?.(this.ctx, e);
      this.flushRemoved();
    }
    this.ctx.remove(id);
    this.flushRemoved();
  }

  /** Latest command for a player. It stays in force until replaced. The object is copied. */
  setInput(id: NetId, cmd: InputCmd): void {
    const e = this.ctx.get(id);
    if (!e || e.kind !== 'player') return;
    copyInput(this.controlsOf(id).cmd, cmd);
  }

  /** A discrete request from a player. Returns true if a system handled it. */
  act(id: NetId, a: Action): boolean {
    const p = this.ctx.get(id);
    if (!p || p.kind !== 'player' || !a || typeof a.t !== 'string') return false;
    if (a.t === 'debug' && !this.debug) return false;
    let handled = false;
    for (const s of this.systems) {
      if (s.action && s.action(this.ctx, p, a)) {
        handled = true;
        break;
      }
    }
    this.flushRemoved();
    return handled;
  }

  // --- time -------------------------------------------------------------------------------------

  /** Advance exactly one tick. Returns the events of this tick (and of actions since the last one). */
  step(): SimEvent[] {
    const st = this.state;
    if (this.removedStale) {
      // Nothing was removed since the last step returned: its list is spent.
      this.removed.length = 0;
      this.removedStale = false;
    }
    st.tick++;
    for (const s of this.systems) {
      if (s.step) {
        s.step(this.ctx);
        if (this.doomed.length > 0) this.flushRemoved();
      }
    }
    // Remember the buttons for next tick's edge detection.
    for (const c of this.controls.values()) {
      const b = c.cmd.b;
      if (b !== c.prev) {
        c.prev = b;
        if (b !== 0) st.vars[c.prevKey] = b;
        else delete st.vars[c.prevKey];
      }
    }
    const out = this.events;
    this.events = [];
    this.removedStale = true;
    return out;
  }

  serialize(): string {
    return JSON.stringify(this.state);
  }

  // --- internals --------------------------------------------------------------------------------

  private controlsOf(id: NetId): Controls {
    let c = this.controls.get(id);
    if (!c) {
      const prevKey = 'sim.btn.' + id;
      c = { cmd: neutralInput(), prev: this.state.vars[prevKey] ?? 0, prevKey };
      const e = this.ctx.get(id);
      if (e) {
        // A resumed player keeps looking where they looked.
        c.cmd.yaw = e.yaw;
        if (e.kind === 'player') {
          c.cmd.pitch = e.pitch;
          c.cmd.seq = e.seq;
        }
      }
      this.controls.set(id, c);
    }
    return c;
  }

  private reindex(): void {
    this.index.clear();
    for (const k of KINDS) {
      const l = this.lists[k];
      if (l) l.length = 0;
      else this.lists[k] = [];
    }
    const ents = this.state.ents;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      this.index.set(e.id, i);
      (this.lists[e.kind] ??= []).push(e);
    }
    this.controls.clear();
    for (const p of this.lists.player) this.controlsOf(p.id);
  }

  /** Removals are deferred to the end of the running system so lists stay stable while it iterates. */
  private flushRemoved(): void {
    const doomed = this.doomed;
    if (doomed.length === 0) return;
    const ents = this.state.ents;
    if (this.removedStale) {
      this.removed.length = 0;
      this.removedStale = false;
    }
    let first = ents.length;
    for (let k = 0; k < doomed.length; k++) {
      const id = doomed[k];
      const i = this.index.get(id);
      if (i === undefined) continue;
      const e = ents[i];
      ents.splice(i, 1);
      this.index.delete(id);
      for (let j = i; j < ents.length; j++) this.index.set(ents[j].id, j);
      if (i < first) first = i;
      const l = this.lists[e.kind];
      const li = l.indexOf(e);
      if (li >= 0) l.splice(li, 1);
      if (e.kind === 'player') {
        const c = this.controls.get(id);
        if (c) {
          delete this.state.vars[c.prevKey];
          this.controls.delete(id);
        }
      }
      this.removed.push(id);
    }
    doomed.length = 0;
    this.doomedSet.clear();
  }

  private makeCtx(): SimCtx {
    const sim = this;
    const state = this.state;
    const ctx: SimCtx = {
      state,
      world: this.world,
      dt: DT,
      get tick() {
        return state.tick;
      },
      debug: this.debug,
      rand(): number {
        const r = rngStep(state.rng);
        state.rng = r[0];
        return r[1];
      },
      emit(ev: SimEvent): void {
        sim.events.push(ev);
      },
      spawn<E extends Entity>(e: Omit<E, 'id' | 'rev'>): E {
        // The object passed in becomes the entity (factories in entities.ts build complete ones).
        const ent = e as unknown as E;
        ent.id = state.nextId++;
        ent.rev = 1;
        sim.index.set(ent.id, state.ents.length);
        state.ents.push(ent);
        (sim.lists[ent.kind] ??= []).push(ent);
        return ent;
      },
      remove(id: NetId): void {
        if (sim.index.has(id) && !sim.doomedSet.has(id)) {
          sim.doomedSet.add(id);
          sim.doomed.push(id);
        }
      },
      get<E extends Entity = Entity>(id: NetId): E | undefined {
        const i = sim.index.get(id);
        if (i === undefined || (sim.doomedSet.size > 0 && sim.doomedSet.has(id))) return undefined;
        return state.ents[i] as E;
      },
      all<K extends EntityKind>(kind: K): Extract<Entity, { kind: K }>[] {
        return sim.lists[kind] as Extract<Entity, { kind: K }>[];
      },
      players(): PlayerEnt[] {
        return sim.lists.player as PlayerEnt[];
      },
      input(id: NetId): InputCmd {
        const c = sim.controls.get(id);
        return c ? c.cmd : NEUTRAL;
      },
      pressed(id: NetId, btn: number): boolean {
        const c = sim.controls.get(id);
        return c !== undefined && (c.cmd.b & btn) !== 0 && (c.prev & btn) === 0;
      },
      held(id: NetId, btn: number): boolean {
        const c = sim.controls.get(id);
        return c !== undefined && (c.cmd.b & btn) !== 0;
      },
      touch(e: Entity): void {
        e.rev++;
      },
      v(key: string, def = 0): number {
        const x = state.vars[key];
        return x === undefined ? def : x;
      },
      setV(key: string, value: number): void {
        state.vars[key] = value;
      },
    };
    return ctx;
  }
}
