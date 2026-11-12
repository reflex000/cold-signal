// CONTRACT for simulation systems. A system is a plain object with a name and a step function.
// Systems never import three, the DOM, or each other's internals; they talk through SimState.
// Owner: MAIN.
import type { World } from '../world/types';
import type { Action, Entity, EntityKind, InputCmd, NetId, PlayerEnt, SimEvent, SimState } from './types';

export interface SimCtx {
  readonly state: SimState;
  readonly world: World;
  readonly dt: number; // always DT
  readonly tick: number;
  readonly debug: boolean;
  /** Deterministic random in [0,1) from the stream stored in state.rng. */
  rand(): number;
  emit(ev: SimEvent): void;
  /** Create an entity. `id` and `rev` are assigned here. */
  spawn<E extends Entity>(e: Omit<E, 'id' | 'rev'>): E;
  remove(id: NetId): void;
  get<E extends Entity = Entity>(id: NetId): E | undefined;
  /** All entities of one kind (a cached list, do not keep it across ticks). */
  all<K extends EntityKind>(kind: K): Extract<Entity, { kind: K }>[];
  players(): PlayerEnt[];
  /** Latest command of a player this tick (a neutral command if none arrived). */
  input(id: NetId): InputCmd;
  /** True on the tick a button goes from up to down. */
  pressed(id: NetId, btn: number): boolean;
  held(id: NetId, btn: number): boolean;
  /** Mark a slow-changing entity as changed so it is resent. */
  touch(e: Entity): void;
  /** Named number in state.vars with a default. */
  v(key: string, def?: number): number;
  setV(key: string, value: number): void;
}

export interface System {
  name: string;
  /** Called once when a new game starts (not on load). Spawn initial entities here. */
  init?(ctx: SimCtx): void;
  /** Called every tick, in registration order. */
  step?(ctx: SimCtx): void;
  /** Return true if this system handled the action. */
  action?(ctx: SimCtx, player: PlayerEnt, a: Action): boolean;
  /** Called when a player joins, after the player entity exists. */
  join?(ctx: SimCtx, player: PlayerEnt): void;
  /**
   * Called when a player leaves the session (disconnect, bot removed), while the entity still
   * exists; it is removed right after. Drop what they carry, clear references, delete per-player vars.
   * (Optional member added by SIM.)
   */
  leave?(ctx: SimCtx, player: PlayerEnt): void;
}

export interface SimOptions {
  seed: number;
  debug?: boolean;
  /** Number of human players expected; scales wolves and loot. */
  players?: number;
}
