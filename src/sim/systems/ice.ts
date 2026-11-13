// Lake ice that creaks, cracks and breaks. The world gives a thickness for every cell of the lake grid
// (world.lake: 4 m cells, thick along the shores and along the pole-marked safe line to the hut, thin
// where water moves under it and in a few patches). This system keeps the sparse list of cells that
// carry stress (state.ice) and looks after the people who go through.
//
//   load      a player standing on the ice weighs 1 (more running, with a heavy log, less lying flat);
//             a wolf 0.45. A load bears on every cell within ICE_SPREAD of it, so two people close
//             together add up and a cell feels a load coming before it is stood on.
//   stress    the load ratio r = pressure * (ICE_REF / thickness)^2. Above ICE_ONSET a cell takes
//             stress (stressRate: faster and faster the further r is past 1); a player who walks on into
//             ice that is still overloaded carries most of the last cell's stress with them (the crack
//             runs ahead). Unloaded ice relaxes slowly and drops out of the list.
//   creak     each player hears the most strained cell within their reach (ICE_SPREAD) whenever it reaches
//             a creak level they have not heard yet: iceCreak with that stress (the audio grows louder and
//             cracks above 0.7). So thin ice talks as you come onto it, before the worst of it, and the
//             first creak a player hears comes with a warning.
//   break     at 1, under a player's own feet (only the cell a load stands on can break): iceBreak, the
//             cell becomes a hole and everyone standing on it goes in (p.swim: move.ts swims them,
//             thermal soaks and chills them).
//   water     swimmers stay inside the open water. Holding USE within reach of a solid edge climbs out;
//             a teammate within PULL_RANGE holding USE on the swimmer hauls them out faster.
//   refreeze  a hole nobody swims in skins over in a few minutes and thickens to a few centimetres:
//             thin, fractured new ice that goes again under the next person.
// The pole-marked safe line (0.56 m and more) never takes stress: the heaviest load the game can put on
// one spot is about 2.3 people, a ratio of 0.11 there. Wolves never break the ice on their own.
//
// Cells the world has no ice for (thickness 0) are left exactly as they are.
// Per-player vars: ice.at.<id> cell under them last tick, ice.heard.<id> the creak level they heard last,
// ice.in.<id> the hole they swim in, ice.pull.<id> the swimmer they are hauling out, ice.warned.<id> 1 once
// a creak has warned them.
// Owner: OBJECTIVE.
import { clamp, smoothstep } from '../../core/math';
import type { LakeInfo } from '../../world/types';
import type { SimCtx, System } from '../api';
import { PLAYER_RADIUS } from '../move';
import { BTN, type IceCell, type NetId, type PlayerEnt, type SimState } from '../types';
import { toast } from './items';

/** Thickness (m) that one person standing still loads exactly to its comfort limit (r = 1). */
export const ICE_REF = 0.12;
/** Load ratio at which a cell starts to take stress. */
export const ICE_ONSET = 0.6;
/** Stress per second per unit of ratio above the onset ... */
export const ICE_GAIN = 0.075;
/** ... growing by this much per unit of ratio above 1: far too thin ice goes fast, the margins slowly. */
export const ICE_STEEP = 0.25;
/** Stress lost per second by a cell nobody stands on. */
export const ICE_RELAX = 1 / 90;
/** Metres around a load within which a cell bears some of it. */
export const ICE_SPREAD = 2.5;
/** Share of the last cell's stress a player carries into the next one while the ice is still overloaded. */
export const ICE_CARRY = 0.75;
/**
 * Stress levels that creak: CREAK_FIRST, then every CREAK_STEP. A player hears the most strained cell
 * within reach each time it reaches a level they have not heard (and again once it has eased off by more
 * than a level), so walking onto ice that is already strained creaks at once.
 */
export const CREAK_FIRST = 0.005;
export const CREAK_STEP = 0.12;
/** Loads in people: a body, + per m/s of speed, a heavy log dragged alone, one end of a pair carry, lying flat, a wolf. */
export const LOAD = { body: 1, perSpeed: 0.1, drag: 0.8, pair: 0.45, downed: 0.6, wolf: 0.45, wolfPerSpeed: 0.06 } as const;
/** New ice on still water, metres per second at -15 C (a centimetre a minute). */
export const SKIN_RATE = 0.01 / 60;
/** Skin that closes a hole again (thin new ice you can stand on, briefly). */
export const SKIN_WALK = 0.025;
export const SKIN_MAX = 0.07;
/** Stress a refrozen hole never relaxes below: it stays fractured (and visible to presentation). */
export const SCAR = 0.3;
/** Seconds of USE at the edge to climb out when warm (up to twice that when freezing). */
export const CLIMB_TIME = 2;
/** Metres from the edge of the open water within which a swimmer can climb out. */
export const CLIMB_REACH = 0.8;
/** Metres between a teammate on the ice and the swimmer they haul out, and the seconds it takes. */
export const PULL_RANGE = 2;
export const PULL_TIME = 1.5;

const WALL = PLAYER_RADIUS + 0.03; // a swimmer keeps this far from the solid edge of the hole
const OUT = PLAYER_RADIUS + 0.28; // a climber lands this far past the edge
const ON_ICE = 1; // metres above the ice that still bear on it (the hut floor)
const PULL_SLACK = 0.3; // the puller's client saw the swimmer ~100 ms ago
const WOLF_CAP = 0.97; // wolves alone never break a cell

// ---------------------------------------------------------------------------------------------
// The sparse cell list, indexed by cell (rebuilt when the list object changes, e.g. after a load)
// ---------------------------------------------------------------------------------------------
interface CellIndex { arr: IceCell[]; len: number; map: Map<number, IceCell> }
const indexes = new WeakMap<SimState, CellIndex>();

/** The index of state.ice; rebuilt when the list is replaced or something else added or dropped cells. */
function cellsOf(st: SimState): Map<number, IceCell> {
  let ix = indexes.get(st);
  if (!ix || ix.arr !== st.ice || ix.len !== st.ice.length) {
    ix = { arr: st.ice, len: st.ice.length, map: new Map() };
    for (const c of st.ice) ix.map.set(c.i, c);
    indexes.set(st, ix);
  }
  return ix.map;
}

function addCell(st: SimState, map: Map<number, IceCell>, i: number): IceCell {
  const c: IceCell = { i, stress: 0, hole: false };
  st.ice.push(c);
  map.set(i, c);
  const ix = indexes.get(st);
  if (ix) ix.len = st.ice.length;
  return c;
}

function dropCell(st: SimState, map: Map<number, IceCell>, j: number): void {
  map.delete(st.ice[j].i);
  st.ice.splice(j, 1);
  const ix = indexes.get(st);
  if (ix) ix.len = st.ice.length;
}

/** The stressed or broken cell `i`, if the list has it. */
export function iceCellState(st: SimState, i: number): IceCell | undefined {
  return cellsOf(st).get(i);
}

const isOpen = (c: IceCell | undefined): boolean => c !== undefined && c.hole;

/** Thickness that bears load at cell i: the world's, or the new skin of a refrozen hole. */
function bearing(lake: LakeInfo, c: IceCell | undefined, i: number): number {
  const h = lake.thickness[i];
  return c !== undefined && c.skin !== undefined && !c.hole ? Math.min(h, c.skin) : h;
}

/**
 * How dangerous the ice is at a point, 0 (no ice, or ice that holds a person) .. 1 (open water). For the
 * wolves (who keep off it) and anyone else who wants to know: thin ice and stressed cells count.
 */
export function iceDanger(ctx: SimCtx, x: number, z: number): number {
  const w = ctx.world;
  const i = w.iceCell(x, z);
  if (i < 0) return 0;
  const c = cellsOf(ctx.state).get(i);
  if (c && c.hole) return 1;
  const thin = 1 - smoothstep(0.08, 0.2, bearing(w.lake, c, i));
  return Math.max(thin, c ? c.stress : 0);
}

/** True over open water (a hole that has not skinned over). */
export function onOpenWater(ctx: SimCtx, x: number, z: number): boolean {
  const i = ctx.world.iceCell(x, z);
  return i >= 0 && isOpen(cellsOf(ctx.state).get(i));
}

// ---------------------------------------------------------------------------------------------
// Per-player keys (derived strings only, no state)
// ---------------------------------------------------------------------------------------------
interface Keys { at: string; heard: string; in: string; pull: string; warned: string }
const keyCache = new Map<NetId, Keys>();
function keysOf(id: NetId): Keys {
  let k = keyCache.get(id);
  if (!k) {
    const s = '.' + id;
    keyCache.set(id, (k = { at: 'ice.at' + s, heard: 'ice.heard' + s, in: 'ice.in' + s, pull: 'ice.pull' + s, warned: 'ice.warned' + s }));
  }
  return k;
}

// ---------------------------------------------------------------------------------------------
// Scratch for one tick
// ---------------------------------------------------------------------------------------------
interface Press {
  i: number;
  p: number; // pressure, people
  // Somebody stands on this very cell: only such a cell creaks and breaks (its neighbours just take
  // stress), so a hole opens under the feet and one load makes one sound.
  own: boolean;
  human: boolean; // a player stands on it (only players break the ice)
  ox: number; oz: number; ow: number; // the heaviest load standing on it: where it creaks and breaks
  carry: number; // stress carried in by a player who walked onto it this tick
}
const press = new Map<number, Press>();
const pressPool: Press[] = [];
let pressUsed = 0;

function pressOf(i: number): Press {
  let q = press.get(i);
  if (!q) {
    q = pressPool[pressUsed];
    if (!q) pressPool[pressUsed] = q = { i, p: 0, own: false, human: false, ox: 0, oz: 0, ow: 0, carry: 0 };
    pressUsed++;
    q.i = i;
    q.p = 0;
    q.own = false;
    q.human = false;
    q.ow = 0;
    q.carry = 0;
    press.set(i, q);
  }
  return q;
}

interface Box { x0: number; z0: number; x1: number; z1: number }
const box: Box = { x0: 0, z0: 0, x1: 0, z1: 0 };
function cellBox(lake: LakeInfo, i: number, out: Box = box): Box {
  const cx = i % lake.n, cz = (i - cx) / lake.n;
  out.x0 = lake.minX + cx * lake.cell;
  out.z0 = lake.minZ + cz * lake.cell;
  out.x1 = out.x0 + lake.cell;
  out.z1 = out.z0 + lake.cell;
  return out;
}

/** Cell index of grid coordinates, or -1 off the grid or where the world has no ice. */
function cellAt(lake: LakeInfo, cx: number, cz: number): number {
  if (cx < 0 || cz < 0 || cx >= lake.n || cz >= lake.n) return -1;
  const i = cz * lake.n + cx;
  return lake.thickness[i] > 0 ? i : -1;
}

/** Spread a load of `load` people standing at (x, z) on cell `own` over the cells around it. */
function bear(lake: LakeInfo, own: number, x: number, z: number, load: number, human: boolean): void {
  const cell = lake.cell;
  const cx0 = Math.floor((x - lake.minX) / cell), cz0 = Math.floor((z - lake.minZ) / cell);
  const reach = Math.ceil(ICE_SPREAD / cell);
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const i = cellAt(lake, cx0 + dx, cz0 + dz);
      if (i < 0) continue;
      const b = cellBox(lake, i);
      const ex = Math.max(b.x0 - x, 0, x - b.x1), ez = Math.max(b.z0 - z, 0, z - b.z1);
      const d = Math.hypot(ex, ez);
      if (d >= ICE_SPREAD) continue;
      pressOf(i).p += load * (1 - d / ICE_SPREAD);
    }
  }
  if (own < 0) return;
  const q = pressOf(own);
  q.own = true;
  if (human) q.human = true;
  if (load > q.ow) {
    q.ow = load;
    q.ox = x;
    q.oz = z;
  }
}

/** Stress per second a cell takes at load ratio r. */
export function stressRate(r: number): number {
  return r <= ICE_ONSET ? 0 : ICE_GAIN * (r - ICE_ONSET) * (1 + ICE_STEEP * Math.max(0, r - 1));
}

/** Creak level index of a stress (-1 below the first). */
const creakLevel = (s: number): number => (s < CREAK_FIRST ? -1 : Math.floor((s - CREAK_FIRST) / CREAK_STEP));

/** What a player weighs on ice, in people: more running, with a heavy log, less lying flat. */
export function bodyLoad(p: PlayerEnt): number {
  let load = LOAD.body * (1 + LOAD.perSpeed * Math.hypot(p.vx, p.vz));
  if (p.carry) load += p.carryPair ? LOAD.pair : LOAD.drag;
  if (p.life === 'downed') load *= LOAD.downed;
  return load;
}

/** The load a player puts on the ice, or 0 when they are not standing on it. */
function playerLoad(ctx: SimCtx, p: PlayerEnt): number {
  if (p.swim || (p.life !== 'alive' && p.life !== 'downed') || !p.onGround) return 0;
  return p.y > ctx.world.lake.level + ON_ICE ? 0 : bodyLoad(p);
}

// ---------------------------------------------------------------------------------------------
// Into the water and out of it
// ---------------------------------------------------------------------------------------------

/** Keep a swimmer inside the open water of hole `i` (sides toward another hole are open). */
function keepIn(ctx: SimCtx, p: PlayerEnt, i: number, cells: Map<number, IceCell>): void {
  const lake = ctx.world.lake;
  const b = cellBox(lake, i);
  const cx = i % lake.n, cz = (i - cx) / lake.n;
  const openW = isOpen(cells.get(cellAt(lake, cx - 1, cz)));
  const openE = isOpen(cells.get(cellAt(lake, cx + 1, cz)));
  const openN = isOpen(cells.get(cellAt(lake, cx, cz - 1)));
  const openS = isOpen(cells.get(cellAt(lake, cx, cz + 1)));
  const x0 = b.x0 + (openW ? 0 : WALL), x1 = b.x1 - (openE ? 0 : WALL);
  const z0 = b.z0 + (openN ? 0 : WALL), z1 = b.z1 - (openS ? 0 : WALL);
  if (p.x < x0 || p.x > x1) {
    p.x = clamp(p.x, x0, x1);
    p.vx = 0;
  }
  if (p.z < z0 || p.z > z1) {
    p.z = clamp(p.z, z0, z1);
    p.vz = 0;
  }
}

function fallIn(ctx: SimCtx, p: PlayerEnt, i: number, cells: Map<number, IceCell>): void {
  const k = keysOf(p.id);
  p.swim = true;
  p.onGround = false;
  p.crouch = false;
  p.sprint = false;
  p.y = ctx.world.lake.level - 0.35;
  p.vy = -2.5;
  p.vx *= 0.3;
  p.vz *= 0.3;
  p.wet = 1;
  if (p.act !== 'none') {
    p.act = 'none';
    p.actT = 0;
  }
  if (p.held !== 'hands') {
    p.held = 'hands';
    ctx.emit({ t: 'equip', id: p.id, tool: 'hands' });
  }
  keepIn(ctx, p, i, cells);
  ctx.setV(k.in, i);
  delete ctx.state.vars[k.at];
  ctx.emit({ t: 'splash', id: p.id, x: p.x, z: p.z });
  toast(ctx, p, 'warn', 'Through the ice. Get to the edge and climb out.');
}

/** Out of the water onto the ice (or the shore) at x, z. */
function standOut(ctx: SimCtx, p: PlayerEnt, x: number, z: number): void {
  const w = ctx.world;
  const k = keysOf(p.id);
  p.x = x;
  p.z = z;
  const g = w.groundAt(x, z, w.lake.level + 0.3);
  p.y = g.y;
  p.surface = g.surface;
  p.swim = false;
  p.onGround = true;
  p.vx = p.vy = p.vz = 0;
  if (p.act === 'climbOut') {
    p.act = 'none';
    p.actT = 0;
  }
  delete ctx.state.vars[k.in];
  delete ctx.state.vars[k.at];
}

/** Seconds of USE a swimmer needs at the edge: 2 s warm, up to 4 s at 30 C. */
export function climbTime(core: number): number {
  return CLIMB_TIME * (1 + clamp((35 - core) / 5, 0, 1));
}

interface Edge { x: number; z: number; d: number }
const edge: Edge = { x: 0, z: 0, d: 0 };
/**
 * The nearest solid edge of hole `i` within CLIMB_REACH of the swimmer and the spot just past it, or
 * null. A side is solid when the cell beyond it is ice that has not broken, or not lake at all.
 */
function solidEdge(ctx: SimCtx, p: PlayerEnt, i: number, cells: Map<number, IceCell>): Edge | null {
  const lake = ctx.world.lake;
  const b = cellBox(lake, i);
  const cx = i % lake.n, cz = (i - cx) / lake.n;
  const inset = 0.3; // land well inside the neighbour along the edge
  const ax = clamp(p.x, b.x0 + inset, b.x1 - inset), az = clamp(p.z, b.z0 + inset, b.z1 - inset);
  let best = Infinity;
  const side = (ncx: number, ncz: number, d: number, x: number, z: number) => {
    if (d > CLIMB_REACH || d >= best) return;
    const n = ncx >= 0 && ncz >= 0 && ncx < lake.n && ncz < lake.n ? ncz * lake.n + ncx : -1;
    if (n >= 0 && isOpen(cells.get(n))) return;
    best = d;
    edge.x = x;
    edge.z = z;
    edge.d = d;
  };
  side(cx - 1, cz, p.x - b.x0, b.x0 - OUT, az);
  side(cx + 1, cz, b.x1 - p.x, b.x1 + OUT, az);
  side(cx, cz - 1, p.z - b.z0, ax, b.z0 - OUT);
  side(cx, cz + 1, b.z1 - p.z, ax, b.z1 + OUT);
  return best === Infinity ? null : edge;
}

/** Where a hauled-out swimmer ends up: beside the puller, on ice that has not broken. */
function besidePuller(ctx: SimCtx, q: PlayerEnt, s: PlayerEnt): { x: number; z: number } {
  const w = ctx.world, cells = cellsOf(ctx.state);
  const solid = (x: number, z: number): boolean => {
    const i = w.iceCell(x, z);
    return i < 0 ? w.walkable(x, z) : !isOpen(cells.get(i));
  };
  let dx = s.x - q.x, dz = s.z - q.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) {
    dx /= d;
    dz /= d;
  } else {
    dx = -Math.sin(q.yaw);
    dz = -Math.cos(q.yaw);
  }
  const r = 0.7;
  const tries: [number, number][] = [[dx * r, dz * r], [-dz * r, dx * r], [dz * r, -dx * r], [-dx * r, -dz * r]];
  for (const [ox, oz] of tries) if (solid(q.x + ox, q.z + oz)) return { x: q.x + ox, z: q.z + oz };
  return { x: q.x, z: q.z };
}

/**
 * Teammates holding USE on a swimmer within reach (the swimmer in focus, or the nearest with nothing in
 * focus): progress is the puller's own act 'use' / actT. Swimmers being hauled go into `hauling`.
 */
function pullers(ctx: SimCtx, players: readonly PlayerEnt[], hauling: Set<NetId>): void {
  const vars = ctx.state.vars, dt = ctx.dt;
  for (let a = 0; a < players.length; a++) {
    const q = players[a];
    const k = keysOf(q.id);
    const pulling = vars[k.pull];
    let target: PlayerEnt | undefined;
    if (q.life === 'alive' && !q.swim && q.onGround && ctx.held(q.id, BTN.USE) && (q.act === 'none' || pulling !== undefined)) {
      const f = ctx.input(q.id).focus;
      let bd = PULL_RANGE + PULL_SLACK;
      for (let b = 0; b < players.length; b++) {
        const s = players[b];
        if (s === q || !s.swim || s.life === 'dead' || s.life === 'rescued') continue;
        if (f !== 0 && f !== s.id) continue;
        const d = Math.hypot(s.x - q.x, s.z - q.z);
        if (d <= bd) {
          bd = d;
          target = s;
        }
      }
    }
    if (!target) {
      if (pulling !== undefined) {
        delete vars[k.pull];
        if (q.act === 'use') {
          q.act = 'none';
          q.actT = 0;
        }
      }
      continue;
    }
    if (pulling !== target.id || q.act !== 'use') {
      q.act = 'use';
      q.actT = 0;
      vars[k.pull] = target.id;
    }
    q.actT += dt;
    if (q.actT < PULL_TIME) {
      hauling.add(target.id);
      continue;
    }
    const spot = besidePuller(ctx, q, target);
    standOut(ctx, target, spot.x, spot.z);
    q.act = 'none';
    q.actT = 0;
    delete vars[k.pull];
    toast(ctx, target, 'info', `${q.name} hauls you out of the water. Get to a fire.`);
    toast(ctx, q, 'info', `You haul ${target.name} out.`);
  }
}

/** The nearest open hole cell within `r` metres of a point, or -1. */
function nearestOpen(lake: LakeInfo, cells: Map<number, IceCell>, x: number, z: number, r: number): number {
  let best = -1, bd = r;
  for (const c of cells.values()) {
    if (!c.hole || !(lake.thickness[c.i] > 0)) continue;
    const b = cellBox(lake, c.i);
    const d = Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
    if (d <= bd) {
      bd = d;
      best = c.i;
    }
  }
  return best;
}

function swimmers(ctx: SimCtx, players: readonly PlayerEnt[], cells: Map<number, IceCell>): void {
  const w = ctx.world, lake = w.lake, vars = ctx.state.vars, dt = ctx.dt;
  const hauling = haulingScratch;
  hauling.clear();
  pullers(ctx, players, hauling);
  for (let n = 0; n < players.length; n++) {
    const p = players[n];
    const k = keysOf(p.id);
    if (!p.swim) {
      if (vars[k.in] !== undefined) delete vars[k.in];
      continue;
    }
    // Which hole: the open cell they are in, else the one they were in, else one close by. A swimmer
    // with no hole near (put in the water by something else) is left to move.ts.
    const c = w.iceCell(p.x, p.z);
    let hole = -1;
    if (c >= 0 && isOpen(cells.get(c))) hole = c;
    else {
      const was = vars[k.in];
      hole = was !== undefined && isOpen(cells.get(was)) ? was : nearestOpen(lake, cells, p.x, p.z, 3);
    }
    if (hole < 0) {
      if (vars[k.in] !== undefined) delete vars[k.in];
      continue;
    }
    keepIn(ctx, p, hole, cells);
    if (vars[k.in] !== hole) vars[k.in] = hole;
    if (p.life === 'dead' || p.life === 'rescued') continue;
    // Climbing out: hold USE at a solid edge. Letting go or swimming off starts it over.
    const e = p.life === 'alive' && ctx.held(p.id, BTN.USE) ? solidEdge(ctx, p, hole, cells) : null;
    if (e) {
      if (p.act !== 'climbOut') {
        p.act = 'climbOut';
        p.actT = 0;
      }
      p.actT += dt;
      if (p.actT >= climbTime(p.core)) {
        standOut(ctx, p, e.x, e.z);
        toast(ctx, p, 'info', 'You drag yourself out onto the ice. Get to a fire.');
      }
      continue;
    }
    // not climbing: shown struggling while a teammate hauls them, otherwise just swimming
    const want = hauling.has(p.id) ? 'climbOut' : 'none';
    if (p.act !== want || p.actT !== 0) {
      p.act = want;
      p.actT = 0;
    }
  }
}
const haulingScratch = new Set<NetId>();

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

const loadCell: number[] = []; // per player this tick: the cell they stand on, or -1
const occupied = new Set<number>();
const creaked = new Set<number>(); // cells that creaked this tick

export const ice: System = {
  name: 'ice',

  step(ctx) {
    const st = ctx.state, w = ctx.world, lake = w.lake, vars = st.vars, dt = ctx.dt;
    const players = ctx.players();
    // nobody on the mountain (an empty session): the ice waits too
    if (!lake || !(lake.n > 0) || players.length === 0) return;
    const cells = cellsOf(st);

    // --- 1. loads: players standing on the ice, then wolves -------------------------------------
    press.clear();
    pressUsed = 0;
    loadCell.length = 0;
    for (let n = 0; n < players.length; n++) {
      const p = players[n];
      const k = keysOf(p.id);
      const load = playerLoad(ctx, p);
      const i = load > 0 ? w.iceCell(p.x, p.z) : -1;
      loadCell.push(i);
      if (i < 0) {
        if (vars[k.at] !== undefined) delete vars[k.at];
        if (vars[k.heard] !== undefined) delete vars[k.heard];
        continue;
      }
      bear(lake, i, p.x, p.z, load, true);
      // walking on into ice that is still overloaded carries the crack along
      const prev = vars[k.at];
      if (prev !== undefined && prev !== i) {
        const pc = cells.get(prev);
        const own = load * (ICE_REF / bearing(lake, cells.get(i), i)) ** 2;
        if (pc && !pc.hole && own > 1) {
          const q = pressOf(i);
          q.carry = Math.max(q.carry, ICE_CARRY * pc.stress);
        }
      }
      if (prev !== i) vars[k.at] = i;
    }
    for (const wf of ctx.all('wolf')) {
      if (wf.mood === 'dead' || wf.y > lake.level + ON_ICE) continue;
      const i = w.iceCell(wf.x, wf.z);
      if (i >= 0) bear(lake, i, wf.x, wf.z, LOAD.wolf * (1 + LOAD.wolfPerSpeed * Math.max(0, wf.speed)), false);
    }

    // --- 2. stress; a break only under someone's feet --------------------------------------------
    for (const q of press.values()) {
      const i = q.i;
      let c = cells.get(i);
      if (c && c.hole) continue; // open water bears nothing
      const r = q.p * (ICE_REF / bearing(lake, c, i)) ** 2;
      if (r <= ICE_ONSET && q.carry <= 0) continue;
      if (!c) c = addCell(st, cells, i);
      const s0 = c.stress;
      let s = Math.max(s0, q.carry);
      if (r > ICE_ONSET) s += stressRate(r) * dt;
      if (!q.human) s = Math.min(s, Math.max(s0, WOLF_CAP));
      if (s >= 1 && q.own && q.human) {
        c.stress = 1;
        c.hole = true;
        c.skin = 0;
        ctx.emit({ t: 'iceBreak', x: q.ox, z: q.oz });
        continue;
      }
      c.stress = Math.min(s, 0.999);
      // a wolf out on the ice makes it talk too (players hear it below)
      if (q.own && !q.human && creakLevel(c.stress) > creakLevel(s0)) ctx.emit({ t: 'iceCreak', x: q.ox, z: q.oz, stress: Math.round(c.stress * 1000) / 1000 });
    }

    // --- 2b. what each player hears: the most strained ice within their reach ---------------------
    creaked.clear();
    for (let n = 0; n < players.length; n++) {
      const k = keysOf(players[n].id);
      if (loadCell[n] < 0) continue;
      const p = players[n];
      const cell = lake.cell;
      const cx0 = Math.floor((p.x - lake.minX) / cell), cz0 = Math.floor((p.z - lake.minZ) / cell);
      const reach = Math.ceil(ICE_SPREAD / cell);
      let best = -1, bs = 0, bi = -1;
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const i = cellAt(lake, cx0 + dx, cz0 + dz);
          const c = i >= 0 ? cells.get(i) : undefined;
          if (!c || c.hole || c.stress <= bs) continue;
          const b = cellBox(lake, i);
          if (Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.z0 - p.z, 0, p.z - b.z1)) >= ICE_SPREAD) continue;
          bs = c.stress;
          bi = i;
        }
      }
      if (bi >= 0) best = creakLevel(bs);
      const heard = vars[k.heard] ?? -1;
      if (best > heard) {
        vars[k.heard] = best;
        if (!creaked.has(bi)) {
          creaked.add(bi);
          const b = cellBox(lake, bi);
          ctx.emit({ t: 'iceCreak', x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, stress: Math.round(bs * 1000) / 1000 });
        }
        // the first creak a player hears is a warning
        if (!vars[k.warned]) {
          vars[k.warned] = 1;
          toast(ctx, p, 'warn', 'The ice groans under you. Go back the way you came.');
        }
      } else if (best < heard - 1) {
        // it has eased off: the next strain is news again
        if (best < 0) delete vars[k.heard];
        else vars[k.heard] = best;
      }
    }

    // --- 3. into the water: anyone standing on open water ----------------------------------------
    for (let n = 0; n < players.length; n++) {
      const p = players[n];
      if (p.swim || (p.life !== 'alive' && p.life !== 'downed') || !p.onGround || p.y > lake.level + 0.5) continue;
      const i = w.iceCell(p.x, p.z);
      if (i >= 0 && isOpen(cells.get(i))) fallIn(ctx, p, i, cells);
    }

    // --- 4. swimmers: kept in the water, climbing out, hauled out --------------------------------
    swimmers(ctx, players, cells);

    // --- 5. relax, refreeze ----------------------------------------------------------------------
    occupied.clear();
    for (let n = 0; n < players.length; n++) {
      const p = players[n];
      if (!p.swim) continue;
      const h = vars[keysOf(p.id).in];
      if (h !== undefined) occupied.add(h);
    }
    const cold = clamp(-st.env.airTemp / 15, 0.4, 1.8);
    const list = st.ice;
    for (let j = list.length - 1; j >= 0; j--) {
      const c = list[j];
      if (!(lake.thickness[c.i] > 0)) continue; // not ours: the world has no ice there
      if (c.hole) {
        if (occupied.has(c.i)) c.skin = 0;
        else {
          c.skin = (c.skin ?? 0) + SKIN_RATE * cold * dt;
          if (c.skin >= SKIN_WALK) {
            // skinned over: badly fractured at first, easing down to SCAR
            c.hole = false;
            c.stress = 0.5;
          }
        }
        continue;
      }
      if (c.skin !== undefined && c.skin < SKIN_MAX) c.skin = Math.min(SKIN_MAX, c.skin + 0.5 * SKIN_RATE * cold * dt);
      const q = press.get(c.i);
      const r = q ? q.p * (ICE_REF / bearing(lake, c, c.i)) ** 2 : 0;
      if (r > ICE_ONSET) continue;
      const floor = c.skin !== undefined ? SCAR : 0;
      if (c.stress > floor) c.stress = Math.max(floor, c.stress - ICE_RELAX * (1 - r / ICE_ONSET) * dt);
      if (c.stress <= 0 && c.skin === undefined) dropCell(st, cells, j);
    }
  },

  leave(ctx, p) {
    const k = keysOf(p.id);
    const vars = ctx.state.vars;
    delete vars[k.at];
    delete vars[k.heard];
    delete vars[k.in];
    delete vars[k.pull];
    delete vars[k.warned];
    keyCache.delete(p.id);
  },
};
