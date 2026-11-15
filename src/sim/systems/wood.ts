// The axe and the wood.
//   axe        PRIMARY with the axe in hand swings it (hold to keep chopping); so does USE on dead wood
//              (USE takes the axe out of the pack first). A swing lands 0.32 s in: on the dead tree,
//              deadfall, stump or branch pile in reach in front (the focus first) it takes a chop off;
//              the last chop yields split logs and sticks as pickups and emits 'chopped'. A standing
//              snag falls away from the axe and lies as deadfall, to be chopped again.
//   heavy logs 'carry' (or USE) takes the nearer free end, 'release' (or USE again, or G) puts it
//              down. One carrier drags it (move.ts reads p.carry), two carry it at a walk (p.carryPair).
//              The log follows its carriers and keeps its length between them; carriers who pull more
//              than 2 m apart lose it. Set down within 1.5 m of a fire, it goes on the fire (12 min).
//   branches   the dead lower branches of any pine, fir or snag (static world.trees, not entities) snap
//              off by hand: 'gather' (sent by the client once USE is held on a trunk in focus) starts a
//              hold of USE (PlayerAct 'use', GATHER_TIME); facing the trunk within GATHER_REACH of its bark
//              to the end gives sticks (GATHER_LIVE, a snag 3 or 4). Each tree gives once: it joins
//              SimState.gathered and 'gathered' tells every client. What the pack cannot hold falls at
//              the foot of the tree.
// Owner: SURVIVAL (branches: the gathering fix).
import { clamp } from '../../core/math';
import { hash01 } from '../../core/rng';
import type { TreeInst, World } from '../../world/types';
import type { SimCtx, System } from '../api';
import { makeWood, packRoom } from '../entities';
import { BTN, type FireEnt, type LogEnt, type PlayerEnt, type WoodEnt } from '../types';
import { feedFire } from './fire';
import { canReach, eyeHeight, focusOf, fullText, spawnPickup, takeItem, toast } from './items';
import { canEquip } from './players';

/** Seconds one swing of the axe takes, and when in it the blade lands. */
export const SWING_TIME = 0.8;
export const SWING_HIT = 0.32;
/** Metres from the body to the wood's surface the blade reaches. */
export const AXE_REACH = 2;
export const SWING_STAMINA = 0.12; // continuous chopping outruns the standing regen (move.ts 1/8 per second)
/** Length of deadfall at scale 1, metres (lying along (cos yaw, -sin yaw), as the stand-ins draw it). */
export const DEADFALL_LEN = 2.6;
/** A felled snag lies as deadfall this much larger than the snag's own scale. */
const FELLED_SCALE = 1.3;
/** Metres from a player to the end of a heavy log they can take. */
export const LOG_REACH = 2.6;
export const LOG_FIRE_RANGE = 1.5;
/** Carriers may stand this much farther apart than the log is long before it slips. */
export const PAIR_SLIP = 2;
const CARRY_LIFT = 0.5; // centre height above the ground, carried between two
const DRAG_LIFT = 0.15; // one end up, one dragging
const HAND_BACK = 0.35; // a lone carrier holds the end this far behind them

const SNAG_STICKS = 2; // branches that break off when a snag falls

function yieldOf(e: WoodEnt): { log: number; stick: number; tinder: number } {
  const s = e.scale || 1;
  switch (e.type) {
    case 'deadfall':
      return { log: clamp(Math.round(1 + 2 * s), 2, 5), stick: 2, tinder: 0 };
    case 'stump':
      return { log: 2, stick: 1, tinder: 0 };
    case 'branchpile':
      return { log: 0, stick: 5, tinder: 1 };
    default:
      return { log: 0, stick: SNAG_STICKS, tinder: 0 };
  }
}

/** Distance from a point to a dead wood's surface on the ground plane, and the nearest point on it. */
const near = { d: 0, x: 0, z: 0 };
function woodNear(e: WoodEnt, px: number, pz: number): typeof near {
  const s = e.scale || 1;
  if (e.type === 'deadfall') {
    const ux = Math.cos(e.yaw), uz = -Math.sin(e.yaw), hl = 0.5 * DEADFALL_LEN * s;
    const t = clamp((px - e.x) * ux + (pz - e.z) * uz, -hl, hl);
    near.x = e.x + ux * t;
    near.z = e.z + uz * t;
    near.d = Math.hypot(px - near.x, pz - near.z) - 0.2 * s;
    return near;
  }
  const r = e.type === 'snag' ? 0.2 * s : e.type === 'stump' ? 0.3 * s : 0.8 * s;
  const d = Math.hypot(px - e.x, pz - e.z);
  const k = d > 1e-6 ? r / d : 0;
  near.x = e.x + (px - e.x) * k;
  near.z = e.z + (pz - e.z) * k;
  near.d = d - r;
  return near;
}

// ---------------------------------------------------------------------------------------------
// The axe
// ---------------------------------------------------------------------------------------------

function canSwing(p: PlayerEnt): boolean {
  return p.life === 'alive' && p.held === 'axe' && p.carry === 0 && !p.swim && p.stamina >= 0.05;
}

/** The dead wood this swing lands on: the focus if it is in reach, else the nearest in front. */
function swingTarget(ctx: SimCtx, p: PlayerEnt): WoodEnt | undefined {
  const f = focusOf(ctx, p, 'wood');
  if (f && Math.abs(f.y - p.y) < 3 && woodNear(f, p.x, p.z).d <= AXE_REACH + 0.4) return f;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  let best: WoodEnt | undefined;
  let bd = AXE_REACH;
  for (const e of ctx.all('wood')) {
    if (Math.abs(e.x - p.x) > 8 || Math.abs(e.z - p.z) > 8 || Math.abs(e.y - p.y) > 3) continue;
    const n = woodNear(e, p.x, p.z);
    if (n.d > bd) continue;
    const dx = n.x - p.x, dz = n.z - p.z, l = Math.hypot(dx, dz);
    if (n.d > 0.4 && l > 1e-6 && (dx * fx + dz * fz) / l < 0.5) continue; // not in front
    bd = n.d;
    best = e;
  }
  return best;
}

/** The last chop: pickups on the ground, and a snag falls. */
function fell(ctx: SimCtx, p: PlayerEnt, e: WoodEnt): void {
  ctx.emit({ t: 'chopped', by: p.id, id: e.id, x: e.x, y: e.y, z: e.z });
  ctx.remove(e.id);
  const y = yieldOf(e);
  // pickups round the spot, on the side the axe came from
  let ax = p.x - e.x, az = p.z - e.z;
  const al = Math.hypot(ax, az) || 1;
  ax /= al;
  az /= al;
  const put = (item: 'stick' | 'log' | 'tinder', n: number, side: number) => {
    if (n <= 0) return;
    const x = e.x + ax * 0.9 - az * side, z = e.z + az * 0.9 + ax * side;
    spawnPickup(ctx, item, n, x, z, e.y, Math.atan2(ax, az) + side);
  };
  put('log', y.log, -0.6);
  put('stick', y.stick, 0.6);
  put('tinder', y.tinder, 0);
  if (e.type !== 'snag') return;
  // it falls away from the axe and lies as deadfall
  const s = (e.scale || 1) * FELLED_SCALE;
  const half = 0.5 * DEADFALL_LEN * s;
  const cx = e.x - ax * half, cz = e.z - az * half;
  const gy = ctx.world.groundAt(cx, cz, e.y + 2).y;
  ctx.spawn<WoodEnt>(makeWood('deadfall', cx, gy, cz, { yaw: Math.atan2(az, -ax), seed: e.seed, scale: s }));
}

function resolveSwing(ctx: SimCtx, p: PlayerEnt): void {
  const e = swingTarget(ctx, p);
  if (e) {
    const n = woodNear(e, p.x, p.z);
    const top = e.type === 'snag' ? e.y + 6 : e.y + 0.4;
    ctx.emit({ t: 'swing', by: p.id, hit: 'wood', x: n.x, y: clamp(p.y + 1, e.y + 0.1, top), z: n.z });
    e.hp -= 1;
    ctx.touch(e);
    if (e.hp <= 0) fell(ctx, p, e);
    return;
  }
  // the blade into the snow, a living trunk, a rock, or the air
  const cp = Math.cos(p.pitch);
  const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch) - 0.35, dz = -Math.cos(p.yaw) * cp;
  const ey = p.y + eyeHeight(p);
  const hit = ctx.world.raycast(p.x, ey, p.z, dx, dy, dz, 2.2);
  if (hit) ctx.emit({ t: 'swing', by: p.id, hit: hit.what === 'tree' ? 'wood' : 'ground', x: hit.x, y: hit.y, z: hit.z });
  else {
    const l = Math.hypot(dx, dy, dz);
    ctx.emit({ t: 'swing', by: p.id, hit: 'none', x: p.x + (dx / l) * 1.4, y: ey + (dy / l) * 1.4, z: p.z + (dz / l) * 1.4 });
  }
}

function axe(ctx: SimCtx, p: PlayerEnt): void {
  if (p.act === 'swing') {
    const t0 = p.actT;
    p.actT += ctx.dt;
    if (p.life !== 'alive') {
      p.act = 'none';
      p.actT = 0;
      return;
    }
    if (t0 < SWING_HIT && p.actT >= SWING_HIT) resolveSwing(ctx, p);
    if (p.actT >= SWING_TIME) {
      p.act = 'none';
      p.actT = 0;
    }
  }
  if (p.life !== 'alive' || p.act !== 'none') return;
  // USE on dead wood: the axe comes out of the pack, then it chops
  const w = ctx.held(p.id, BTN.USE) ? focusOf(ctx, p, 'wood') : undefined;
  const useWood = w !== undefined && canReach(ctx, p, w);
  if (useWood && p.held !== 'axe' && ctx.pressed(p.id, BTN.USE) && canEquip(p, 'axe')) {
    p.held = 'axe';
    ctx.emit({ t: 'equip', id: p.id, tool: 'axe' });
    return;
  }
  if (canSwing(p) && (ctx.held(p.id, BTN.PRIMARY) || useWood)) {
    p.act = 'swing';
    p.actT = 0;
    p.stamina = Math.max(0, p.stamina - SWING_STAMINA);
  }
}

// ---------------------------------------------------------------------------------------------
// Heavy logs
// ---------------------------------------------------------------------------------------------

const ends = { ax: 0, az: 0, bx: 0, bz: 0 };
/** The two ends of a log: a is the front, along (sin yaw, cos yaw) from the centre. */
export function logEnds(l: LogEnt): typeof ends {
  const ux = Math.sin(l.yaw), uz = Math.cos(l.yaw), h = 0.5 * l.len;
  ends.ax = l.x + ux * h;
  ends.az = l.z + uz * h;
  ends.bx = l.x - ux * h;
  ends.bz = l.z - uz * h;
  return ends;
}

function pairUp(ctx: SimCtx, l: LogEnt): void {
  const a = l.a ? ctx.get<PlayerEnt>(l.a) : undefined;
  const b = l.b ? ctx.get<PlayerEnt>(l.b) : undefined;
  const pair = a !== undefined && b !== undefined;
  if (a) a.carryPair = pair;
  if (b) b.carryPair = pair;
}

function lift(ctx: SimCtx, p: PlayerEnt, l: LogEnt): void {
  if (p.life !== 'alive' || p.carry !== 0 || p.swim) return;
  const e = logEnds(l);
  const da = l.a ? Infinity : Math.hypot(p.x - e.ax, p.z - e.az);
  const db = l.b ? Infinity : Math.hypot(p.x - e.bx, p.z - e.bz);
  if (da === Infinity && db === Infinity) {
    toast(ctx, p, 'info', 'Both ends are taken.');
    return;
  }
  if (Math.min(da, db) > LOG_REACH + 0.4 || Math.abs(l.y - p.y) > 2) {
    toast(ctx, p, 'info', 'Get closer to an end.');
    return;
  }
  if (da <= db) l.a = p.id;
  else l.b = p.id;
  p.carry = l.id;
  if (p.held !== 'hands') {
    p.held = 'hands';
    ctx.emit({ t: 'equip', id: p.id, tool: 'hands' });
  }
  if (p.act !== 'none') {
    p.act = 'none';
    p.actT = 0;
  }
  ctx.emit({ t: 'logLift', id: l.id, by: p.id });
  pairUp(ctx, l);
}

/** The fire a set-down log lies within LOG_FIRE_RANGE of, if any. */
function fireUnder(ctx: SimCtx, l: LogEnt): FireEnt | undefined {
  const ux = Math.sin(l.yaw), uz = Math.cos(l.yaw), h = 0.5 * l.len;
  let best: FireEnt | undefined;
  let bd = LOG_FIRE_RANGE;
  for (const f of ctx.all('fire')) {
    if (Math.abs(f.y - l.y) > 2) continue;
    const t = clamp((f.x - l.x) * ux + (f.z - l.z) * uz, -h, h);
    const d = Math.hypot(f.x - (l.x + ux * t), f.z - (l.z + uz * t));
    if (d <= bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/** `p` lets go of their end. A log nobody holds settles on the ground, or goes on a fire beside it. */
function letGo(ctx: SimCtx, l: LogEnt, p: PlayerEnt | undefined, id: number): void {
  if (l.a === id) l.a = 0;
  if (l.b === id) l.b = 0;
  if (p && p.carry === l.id) {
    p.carry = 0;
    p.carryPair = false;
  }
  pairUp(ctx, l);
  if (l.a || l.b) return;
  const e = logEnds(l);
  const w = ctx.world;
  l.y = 0.5 * (w.groundAt(e.ax, e.az, l.y + 1).y + w.groundAt(e.bx, e.bz, l.y + 1).y);
  ctx.emit({ t: 'logDrop', id: l.id });
  const f = fireUnder(ctx, l);
  if (f && p) {
    feedFire(ctx, f, l.burn, p, 'log');
    ctx.remove(l.id);
  }
}

/** A carrier who can no longer hold on (down, gone, in the water) lets go. */
function holder(ctx: SimCtx, l: LogEnt, id: number): PlayerEnt | undefined {
  if (!id) return undefined;
  const p = ctx.get<PlayerEnt>(id);
  if (p && p.kind === 'player' && p.life === 'alive' && p.carry === l.id && !p.swim) return p;
  letGo(ctx, l, p && p.kind === 'player' ? p : undefined, id);
  return undefined;
}

/** Keep a carried log between (or behind) its carriers, at its own length. */
function follow(ctx: SimCtx, l: LogEnt): void {
  const a = holder(ctx, l, l.a);
  const b = holder(ctx, l, l.b);
  if (!a && !b) return;
  const w = ctx.world;
  const half = 0.5 * l.len;
  let ax: number, az: number, bx: number, bz: number, lift: number;
  if (a && b) {
    const dx = a.x - b.x, dz = a.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d > l.len + PAIR_SLIP) {
      // the one pulling away loses their grip
      const ux = dx / d, uz = dz / d;
      const loser = a.vx * ux + a.vz * uz >= -(b.vx * ux + b.vz * uz) ? a : b;
      toast(ctx, a, 'info', 'The log slipped.');
      toast(ctx, b, 'info', 'The log slipped.');
      letGo(ctx, l, loser, loser.id);
      return;
    }
    const ux = d > 1e-6 ? dx / d : Math.sin(l.yaw), uz = d > 1e-6 ? dz / d : Math.cos(l.yaw);
    const mx = 0.5 * (a.x + b.x), mz = 0.5 * (a.z + b.z);
    ax = mx + ux * half;
    az = mz + uz * half;
    bx = mx - ux * half;
    bz = mz - uz * half;
    lift = CARRY_LIFT;
  } else {
    // one carrier drags: the held end in the hands behind them, the other trailing on the ground
    const c = (a ?? b)!;
    const hx = c.x + Math.sin(c.yaw) * HAND_BACK, hz = c.z + Math.cos(c.yaw) * HAND_BACK;
    const e = logEnds(l);
    const ox = a ? e.bx : e.ax, oz = a ? e.bz : e.az;
    let dx = ox - hx, dz = oz - hz;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      dx /= d;
      dz /= d;
    } else {
      dx = Math.sin(c.yaw);
      dz = Math.cos(c.yaw);
    }
    const fx = hx + dx * l.len, fz = hz + dz * l.len;
    if (a) {
      ax = hx; az = hz; bx = fx; bz = fz;
    } else {
      ax = fx; az = fz; bx = hx; bz = hz;
    }
    lift = DRAG_LIFT;
  }
  const c = (a ?? b)!;
  l.x = 0.5 * (ax + bx);
  l.z = 0.5 * (az + bz);
  l.yaw = Math.atan2(ax - bx, az - bz);
  l.y = 0.5 * (w.groundAt(ax, az, c.y + 0.6).y + w.groundAt(bx, bz, c.y + 0.6).y) + lift;
}

// ---------------------------------------------------------------------------------------------
// Dead branches off a standing tree
// ---------------------------------------------------------------------------------------------

/** Seconds USE is held at a trunk to snap off its dead lower branches. */
export const GATHER_TIME = 1;
/** Metres from the body to a trunk's bark within which its lower branches are in reach. */
export const GATHER_REACH = 2;
/** The client picked from a view up to ~100 ms old and the player kept moving: a little allowance. */
const GATHER_SLACK = 0.5;
/** The band of trunk, metres above its foot, where the dead lower branches grow (what the eye aims at). */
export const BRANCH_LOW = 0.25;
export const BRANCH_HIGH = 2.4;
/** Sticks a living pine or fir gives; a dead standing one (a snag) gives GATHER_SNAG or one more. */
export const GATHER_LIVE = 2;
export const GATHER_SNAG = 3;
/**
 * Ticks the host waits for the held USE that came with the request: actions are applied on arrival,
 * commands one per tick from a queue a few deep (net/host.ts MAX_BACKLOG 5).
 */
const GATHER_WAIT = 10;
const GATHER_KEY = 'wood.gather.'; // + player id -> the tree index being stripped
const GATHER_WAIT_KEY = 'wood.gatherWait.'; // + player id -> ticks waited for USE (gone once it is held)

/** A conifer whose dead lower branches snap off by hand (not a sapling). */
export function hasBranches(t: TreeInst): boolean {
  return t.kind === 'pine' || t.kind === 'fir' || t.kind === 'snag';
}

/** Trunk radius at the foot, metres: the world's collider, else world/scatter.ts's rule for the kind. */
export function trunkRadius(t: TreeInst): number {
  if (typeof t.r === 'number' && t.r > 0) return t.r;
  return t.kind === 'snag' ? 0.1 + 0.14 * t.scale : t.kind === 'sapling' ? 0.04 : 0.12 + 0.2 * t.scale;
}

/** Sticks tree `i` gives: two from a living tree, three or four (by the tree) from a snag. */
export function treeSticks(world: World, i: number): number {
  const t = world.trees[i];
  if (!t || !hasBranches(t)) return 0;
  return t.kind === 'snag' ? GATHER_SNAG + (hash01(world.seed * 7 + 977, i, 3) < 0.5 ? 1 : 0) : GATHER_LIVE;
}

/** Has tree `i` been stripped already. */
export function isGathered(ctx: SimCtx, i: number): boolean {
  const g = ctx.state.gathered;
  return g !== undefined && g.includes(i);
}

/** The tree an action names, if it is one with branches to snap. */
function branchTree(ctx: SimCtx, i: unknown): TreeInst | undefined {
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) return undefined;
  const t = ctx.world.trees[i];
  return t && hasBranches(t) ? t : undefined;
}

/**
 * `p` can reach the lower branches of `t`: within GATHER_REACH of the bark (plus the allowance), the
 * feet near the height of its foot, and nothing solid (a rock, a wall; lineClear ignores trees) between
 * the eye and the trunk.
 */
function treeInReach(ctx: SimCtx, p: PlayerEnt, t: TreeInst): boolean {
  const r = trunkRadius(t);
  const dx = t.x - p.x, dz = t.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d - r > GATHER_REACH + GATHER_SLACK) return false;
  if (p.y < t.y - 2.5 || p.y > t.y + 2.5) return false;
  const ey = p.y + eyeHeight(p);
  const k = d > 1e-3 ? Math.max(0, d - r - 0.1) / d : 0;
  const ty = clamp(ey - 0.4, t.y + BRANCH_LOW + 0.2, t.y + BRANCH_HIGH);
  return k <= 0 || ctx.world.lineClear(p.x, ey, p.z, p.x + dx * k, ty, p.z + dz * k);
}

/** Still turned to the trunk, with the crosshair on no other thing (the client sends focus 0 for a tree). */
function facingTree(ctx: SimCtx, p: PlayerEnt, t: TreeInst): boolean {
  if (ctx.input(p.id).focus !== 0) return false;
  const dx = t.x - p.x, dz = t.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < trunkRadius(t) + 0.6) return true;
  return (dx * -Math.sin(p.yaw) + dz * -Math.cos(p.yaw)) / d > 0.3;
}

function stopGather(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars;
  delete vars[GATHER_KEY + p.id];
  delete vars[GATHER_WAIT_KEY + p.id];
  if (p.act === 'use') {
    p.act = 'none';
    p.actT = 0;
  }
}

/** Action 'gather': start the hold on tree `i`, or say why not. */
function startGather(ctx: SimCtx, p: PlayerEnt, i: unknown): void {
  if (p.life !== 'alive' || p.swim || p.carry !== 0) return;
  const t = branchTree(ctx, i);
  if (!t) return;
  const tree = i as number;
  if (isGathered(ctx, tree)) {
    toast(ctx, p, 'info', 'Its dead branches are gone.');
    return;
  }
  if (!treeInReach(ctx, p, t)) return; // (the client offers only trees in reach: a stale view, nothing to tell)
  if (packRoom(p.inv, 'stick') <= 0) {
    toast(ctx, p, 'warn', fullText('stick'), 'stick');
    return;
  }
  const vars = ctx.state.vars;
  const key = GATHER_KEY + p.id;
  // busy with something else (a swing, a match, a crate, eating): this press does nothing
  if (p.act !== 'none' && !(p.act === 'use' && vars[key] !== undefined)) return;
  vars[key] = tree;
  vars[GATHER_WAIT_KEY + p.id] = 0;
  p.act = 'use';
  p.actT = 0;
}

/** The branches come away: sticks into the pack (the rest at the foot of the tree), the tree is spent. */
function snapBranches(ctx: SimCtx, p: PlayerEnt, tree: number, t: TreeInst): void {
  const n = treeSticks(ctx.world, tree);
  (ctx.state.gathered ??= []).push(tree);
  ctx.emit({ t: 'gathered', by: p.id, tree });
  const k = takeItem(ctx, p, 'stick', n);
  if (k >= n) return;
  let ax = p.x - t.x, az = p.z - t.z;
  const al = Math.hypot(ax, az) || 1;
  ax /= al;
  az /= al;
  const r = trunkRadius(t) + 0.55;
  spawnPickup(ctx, 'stick', n - k, t.x + ax * r - az * 0.3, t.z + az * r + ax * 0.3, Math.max(p.y, t.y), Math.atan2(ax, az) + 1.2);
  toast(ctx, p, 'warn', 'Your pack is full. The rest is on the ground.');
}

/** A hold under way: keeps going while USE is held, facing the trunk, in reach; done after GATHER_TIME. */
function gathering(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars;
  const tree = vars[GATHER_KEY + p.id];
  if (tree === undefined) return;
  const t = branchTree(ctx, tree);
  if (!t || p.life !== 'alive' || p.swim || p.carry !== 0 || p.act !== 'use' || isGathered(ctx, tree) || !treeInReach(ctx, p, t) || !facingTree(ctx, p, t)) {
    stopGather(ctx, p);
    return;
  }
  const waitKey = GATHER_WAIT_KEY + p.id;
  if (!ctx.held(p.id, BTN.USE)) {
    // let go (or the USE that came with the request is still on its way)
    const w = vars[waitKey];
    if (w === undefined || w >= GATHER_WAIT) stopGather(ctx, p);
    else vars[waitKey] = w + 1;
    return;
  }
  if (vars[waitKey] !== undefined) delete vars[waitKey];
  p.actT += ctx.dt;
  if (p.actT < GATHER_TIME - 1e-6) return;
  stopGather(ctx, p);
  snapBranches(ctx, p, tree, t);
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

export const wood: System = {
  name: 'wood',

  step(ctx) {
    const list = ctx.players();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      axe(ctx, p);
      gathering(ctx, p);
      if (p.life !== 'alive' || !ctx.pressed(p.id, BTN.USE)) continue;
      const l = focusOf(ctx, p, 'log');
      if (!l || !canReach(ctx, p, l)) continue;
      if (p.carry === l.id) letGo(ctx, l, p, p.id);
      else if (p.carry === 0) lift(ctx, p, l);
    }
    const logs = ctx.all('log');
    for (let i = 0; i < logs.length; i++) if (logs[i].a || logs[i].b) follow(ctx, logs[i]);
  },

  action(ctx, p, a) {
    if (a.t === 'carry') {
      const l = ctx.get(a.log);
      if (l && l.kind === 'log') lift(ctx, p, l);
      return true;
    }
    if (a.t === 'release') {
      const l = p.carry ? ctx.get(p.carry) : undefined;
      if (l && l.kind === 'log') letGo(ctx, l, p, p.id);
      else {
        p.carry = 0;
        p.carryPair = false;
      }
      return true;
    }
    if (a.t === 'gather') {
      startGather(ctx, p, (a as { tree?: unknown }).tree);
      return true;
    }
    return false;
  },

  leave(ctx, p) {
    const l = p.carry ? ctx.get(p.carry) : undefined;
    if (l && l.kind === 'log') letGo(ctx, l, p, p.id);
    delete ctx.state.vars[GATHER_KEY + p.id];
    delete ctx.state.vars[GATHER_WAIT_KEY + p.id];
  },
};
