// Entity and state factories. Every entity the simulation spawns comes from here, so every
// object of a kind has the same complete set of fields in the same order (stable JSON, stable
// object shapes). `id` and `rev` are 0 until SimCtx.spawn assigns them.
// Owner: SIM.
import type { SpawnDef } from '../world/types';
import { PITCH_LIMIT } from './move';
import type {
  CrateEnt, DeviceEnt, Entity, EntityKind, Env, FireEnt, FireType, FlareEnt, HeliEnt, InputCmd, ItemId, LogEnt, Objective,
  PickupEnt, PlayerEnt, SimState, Stats, WolfEnt, WoodEnt,
} from './types';

export const STATE_VERSION = 1;

/** Every entity kind (the order per-kind lists are created in). */
export const ENTITY_KINDS: readonly EntityKind[] = ['player', 'wolf', 'fire', 'pickup', 'crate', 'wood', 'log', 'flare', 'device', 'heli'];
/** Hour of day at which a new game starts (dusk). */
export const START_CLOCK = 16.5;

export function neutralInput(): InputCmd {
  return { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0 };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Copy a command into `dst`, making it safe: finite numbers, axes in -1..1, pitch within the
 * limit, integer bits and ids. Used on everything that arrives from a client or a bot.
 */
export function copyInput(dst: InputCmd, src: InputCmd): InputCmd {
  const mx = num(src.mx), mz = num(src.mz), pitch = num(src.pitch);
  dst.seq = Math.floor(num(src.seq));
  dst.mx = mx < -1 ? -1 : mx > 1 ? 1 : mx;
  dst.mz = mz < -1 ? -1 : mz > 1 ? 1 : mz;
  dst.yaw = num(src.yaw);
  dst.pitch = pitch < -PITCH_LIMIT ? -PITCH_LIMIT : pitch > PITCH_LIMIT ? PITCH_LIMIT : pitch;
  dst.b = num(src.b) | 0;
  dst.focus = Math.floor(num(src.focus));
  return dst;
}

export function makeEnv(): Env {
  return {
    t: 0, clock: START_CLOCK, day: 0, storm: 0.45, windX: 6, windZ: 6, gust: 0, snowfall: 0.4,
    visibility: 400, airTemp: -12, cloud: 0.8, aurora: 0, snowAccum: 0,
  };
}

export function makeObjective(): Objective {
  return {
    stage: 'crash',
    parts: { battery: 'lost', handset: 'lost', coil: 'lost', tube: 'lost', fuse: 'lost' },
    generator: 0, transmit: 0, eta: -1, signalled: false,
  };
}

export function makeStats(): Stats {
  return { distance: 0, firesLit: 0, wolvesKilled: 0, revives: 0, downs: 0, coldest: 37, shots: 0 };
}

export function makeState(seed: number): SimState {
  return {
    version: STATE_VERSION,
    seed,
    tick: 0,
    nextId: 1,
    // The simulation stream must not mirror the world generator's, which is seeded with `seed` itself.
    rng: (seed ^ 0x5bd1e995) | 0,
    env: makeEnv(),
    objective: makeObjective(),
    ents: [],
    ice: [],
    vars: {},
    stats: makeStats(),
  };
}

export function makePlayer(name: string, slot: number, x: number, y: number, z: number, yaw = 0, bot = false): PlayerEnt {
  return {
    id: 0, kind: 'player', x, y, z, yaw, rev: 0,
    name, slot, bot,
    vx: 0, vy: 0, vz: 0, pitch: 0, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 37, wet: 0, stamina: 1, hunger: 0,
    feels: 0, shelter: 0, fireHeat: 0, huddle: 0, trend: 0,
    bleed: 0, revive: 0, reviver: 0,
    inv: {}, held: 'hands', act: 'none', actT: 0, loaded: 0, flareLoaded: 0, lightOn: false,
    cellCharge: 1, radioCharge: 0, radioSig: 0, radioDist: -1, aim: 0, carry: 0, carryPair: false,
    isolation: 0, kills: 0,
  };
}

export function makeWolf(x: number, y: number, z: number, o: { pack?: number; alpha?: boolean; variant?: number; yaw?: number } = {}): WolfEnt {
  const alpha = o.alpha ?? false;
  return {
    id: 0, kind: 'wolf', x, y, z, yaw: o.yaw ?? 0, rev: 0,
    pack: o.pack ?? 0, alpha, mood: 'rest', moodT: 0, target: 0, vx: 0, vz: 0, speed: 0,
    health: alpha ? 80 : 60, fear: 0, hunger: 0.4, variant: o.variant ?? 0,
  };
}

export function makeFire(type: FireType, x: number, y: number, z: number, o: { shelter?: number; by?: number; yaw?: number } = {}): FireEnt {
  return {
    id: 0, kind: 'fire', x, y, z, yaw: o.yaw ?? 0, rev: 0,
    type, lit: false, fuel: 0, heat: 0, size: 0, shelter: o.shelter ?? 0, embers: 0, by: o.by ?? 0,
  };
}

export function makePickup(item: ItemId, n: number, x: number, y: number, z: number, o: { yaw?: number; lie?: PickupEnt['lie'] } = {}): PickupEnt {
  return { id: 0, kind: 'pickup', x, y, z, yaw: o.yaw ?? 0, rev: 0, item, n, lie: o.lie ?? 'ground' };
}

export function makeCrate(type: CrateEnt['type'], loot: { item: ItemId; n: number }[], x: number, y: number, z: number, yaw = 0): CrateEnt {
  const copy: { item: ItemId; n: number }[] = [];
  for (const l of loot) copy.push({ item: l.item, n: l.n });
  return { id: 0, kind: 'crate', x, y, z, yaw, rev: 0, type, loot: copy, open: false };
}

/** Chops needed to fell or clear each kind of dead wood, before `scale`. */
const WOOD_HP: Record<WoodEnt['type'], number> = { snag: 7, deadfall: 5, stump: 3, branchpile: 2 };

export function makeWood(type: WoodEnt['type'], x: number, y: number, z: number, o: { yaw?: number; seed?: number; scale?: number } = {}): WoodEnt {
  const scale = o.scale ?? 1;
  return {
    id: 0, kind: 'wood', x, y, z, yaw: o.yaw ?? 0, rev: 0,
    type, hp: Math.max(1, Math.round(WOOD_HP[type] * scale)), seed: o.seed ?? 0, scale,
  };
}

/** Seconds a heavy log burns (12 minutes, see DESIGN "Fire"). */
export const HEAVY_LOG_BURN = 720;

export function makeLog(x: number, y: number, z: number, o: { yaw?: number; len?: number; burn?: number } = {}): LogEnt {
  return { id: 0, kind: 'log', x, y, z, yaw: o.yaw ?? 0, rev: 0, a: 0, b: 0, len: o.len ?? 2.4, burn: o.burn ?? HEAVY_LOG_BURN };
}

/** Seconds a flare burns. */
export const FLARE_LIFE = 40;

export function makeFlare(x: number, y: number, z: number, vx: number, vy: number, vz: number, by = 0): FlareEnt {
  return { id: 0, kind: 'flare', x, y, z, yaw: 0, rev: 0, vx, vy, vz, life: FLARE_LIFE, landed: false, by };
}

export function makeDevice(type: DeviceEnt['type'], poi: string, x: number, y: number, z: number, o: { yaw?: number; data?: number; on?: boolean; progress?: number } = {}): DeviceEnt {
  return { id: 0, kind: 'device', x, y, z, yaw: o.yaw ?? 0, rev: 0, type, poi, on: o.on ?? false, progress: o.progress ?? 0, data: o.data ?? 0 };
}

export function makeHeli(x: number, y: number, z: number, yaw = 0): HeliEnt {
  return { id: 0, kind: 'heli', x, y, z, yaw, rev: 0, phase: 'inbound', vx: 0, vy: 0, vz: 0, t: 0 };
}

/** The entity a world spawn definition stands for. */
export function makeFromSpawn(d: SpawnDef): Entity {
  switch (d.kind) {
    case 'pickup': return makePickup(d.item, d.n, d.x, d.y, d.z, { yaw: d.yaw, lie: d.lie });
    case 'crate': return makeCrate(d.type, d.loot, d.x, d.y, d.z, d.yaw);
    case 'wood': return makeWood(d.type, d.x, d.y, d.z, { yaw: d.yaw, seed: d.seed, scale: d.scale });
    case 'log': return makeLog(d.x, d.y, d.z, { yaw: d.yaw, len: d.len });
    case 'fire': return makeFire(d.type, d.x, d.y, d.z, { shelter: d.shelter });
    case 'device': return makeDevice(d.type, d.poi, d.x, d.y, d.z, { yaw: d.yaw, data: d.data });
  }
}
