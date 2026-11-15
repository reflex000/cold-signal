// Focus picking: which entity is under the crosshair within reach, what E would do to it, and
// its name, for hud.focus and InputCmd.focus (the host validates the choice). Picked by the
// distance from the view ray to the thing's centre, so small items are as easy to aim at as
// crates; walls and terrain in between block it.
// With no entity in focus, the trunk of a pine, fir or snag the view ray meets within reach (its bark
// within GATHER_REACH of the body, at the height of its dead lower branches) is offered: E held snaps
// them off (sim/systems/wood.ts). Trees are world instances, not entities: such a focus has id 0 and
// the tree's index; game.ts sends the 'gather' action for it. A stripped tree (view.gathered) is not
// offered again.
// Owner: GAME.
import { ITEM, PART_NAME } from '../ui/text';
import { CARRY_LIMIT } from '../sim/entities';
import { SWIM_DEPTH } from '../sim/move';
import { PULL_RANGE, PULL_TIME } from '../sim/systems/ice';
import { CRATE_HOLD } from '../sim/systems/items';
import { BED_TIME, DEVICE_AIM, INSTALL_TIME } from '../sim/systems/objective';
import { REVIVE_RANGE } from '../sim/systems/vitals';
import { BRANCH_HIGH, BRANCH_LOW, GATHER_REACH, GATHER_TIME, hasBranches, trunkRadius } from '../sim/systems/wood';
import type { CrateEnt, DeviceEnt, Entity, FireEnt, LogEnt, PickupEnt, PlayerEnt, WoodEnt } from '../sim/types';
import type { TreeInst, World } from '../world/types';
import type { Camera, Focus, View, ViewEnt } from './view';

/** Metres from the eye. */
export const REACH = 2.6;

/** Radius (m) around an entity's aim point that counts as "on it", and the aim point's height. */
const SHAPE: Record<string, { r: number; y: number }> = {
  pickup: { r: 0.28, y: 0.1 },
  crate: { r: 0.45, y: 0.35 },
  fire: { r: 0.6, y: 0.3 },
  wood: { r: 0.5, y: 0.6 },
  log: { r: 0.45, y: 0.25 },
  device: { r: 0.45, y: 0.9 },
  player: { r: 0.5, y: 0.35 },
};
/** A teammate in the water under the ice: aimed at by the head, just above the water. (OBJECTIVE) */
const SWIMMER = { r: 0.5, y: SWIM_DEPTH + 0.1 };

/** The shape of one entity: devices by type (the sim checks reach with the same table), swimmers by the head. */
function shapeOf(e: Entity): { r: number; y: number } {
  if (e.kind === 'device') return DEVICE_AIM[e.type] ?? SHAPE.device;
  if (e.kind === 'player' && e.swim) return SWIMMER;
  return SHAPE[e.kind];
}

const CRATE_NAME: Record<CrateEnt['type'], string> = {
  luggage: 'Suitcase', locker: 'Locker', crate: 'Crate', medkit: 'First aid kit', cupboard: 'Cupboard', toolbox: 'Toolbox',
};
const WOOD_NAME: Record<WoodEnt['type'], string> = { snag: 'Dead tree', deadfall: 'Deadfall', stump: 'Stump', branchpile: 'Branch pile' };
const FIRE_NAME: Record<FireEnt['type'], string> = { campfire: 'Campfire', stove: 'Stove', barrel: 'Barrel fire' };
const TREE_NAME: Record<TreeInst['kind'], string> = { pine: 'Pine', fir: 'Fir', snag: 'Dead tree', sapling: 'Sapling' };
export const GATHER_VERB = 'Snap dead branches';
/** A trunk counts as aimed at within this much of its bark, metres (a forgiving ring round a thin pole). */
const TRUNK_MARGIN = 0.12;

/** What E does at the trunk of world.trees[i] for `me` (a hold: the host's progress fills the ring). */
export function describeTree(t: TreeInst, i: number, me: PlayerEnt, keyLabel: string): Focus {
  const full = (me.inv.stick ?? 0) >= CARRY_LIMIT.stick;
  return {
    id: 0, kind: 'tree', tree: i, verb: GATHER_VERB, name: TREE_NAME[t.kind] ?? 'Tree', key: keyLabel,
    hold: me.act === 'use' ? Math.min(1, me.actT / GATHER_TIME) : null,
    ...(full ? { note: 'pack full' } : {}),
  };
}

function itemName(p: PickupEnt): string {
  const t = ITEM[p.item];
  const name = t ? t.name : p.item;
  return p.n > 1 ? `${name} (${p.n})` : name;
}

const has = (me: PlayerEnt, item: keyof PlayerEnt['inv']) => (me.inv[item] ?? 0) > 0;

/** What E does to `e` for `me`, or null when there is nothing to do. */
export function describe(e: Entity, me: PlayerEnt, keyLabel: string): Focus | null {
  const base = { id: e.id, kind: e.kind, hold: null as number | null, key: keyLabel };
  switch (e.kind) {
    case 'pickup':
      return { ...base, verb: 'Take', name: itemName(e) };
    case 'crate':
      if (e.open) return null;
      // a short hold opens it (sim/systems/items.ts): the ring follows the host's progress
      return { ...base, verb: 'Open', name: CRATE_NAME[e.type] ?? 'Crate', hold: me.act === 'use' ? Math.min(1, me.actT / CRATE_HOLD) : null };
    case 'fire': {
      // E feeds a stick (else a split log) to a lit fire or a bare hearth; tinder is kept for lighting
      const name = FIRE_NAME[e.type] ?? 'Fire';
      const wood = has(me, 'stick') || has(me, 'log');
      if (e.lit) return { ...base, verb: 'Feed fire', name, ...(wood ? {} : { note: 'needs wood' }) };
      if (e.size <= 0) return { ...base, verb: 'Add wood', name, ...(wood ? {} : { note: 'needs wood' }) };
      if (e.embers > 0) return { ...base, verb: 'Light', name, note: 'embers' };
      return { ...base, verb: 'Light', name, ...(has(me, 'matches') ? {} : { note: 'needs matches' }) };
    }
    case 'wood':
      return { ...base, verb: 'Chop', name: WOOD_NAME[e.type] ?? 'Dead wood', ...(me.held === 'axe' ? {} : { note: has(me, 'axe') ? 'take the axe' : 'needs an axe' }) };
    case 'log': {
      const l = e as LogEnt;
      if (me.carry === l.id) return { ...base, verb: 'Put down', name: 'Heavy log' };
      if (me.carry || (l.a && l.b)) return null;
      return { ...base, verb: l.a || l.b ? 'Take the other end' : 'Lift', name: 'Heavy log' };
    }
    case 'device':
      return describeDevice(e, me, base);
    case 'player': {
      const p = e as PlayerEnt;
      if (p.id === me.id) return null;
      if (p.swim && p.life !== 'dead' && p.life !== 'rescued') {
        // a hold hauls them out of the hole (sim/systems/ice.ts): the ring is the puller's own act
        const far = Math.hypot(p.x - me.x, p.z - me.z) > PULL_RANGE;
        return { ...base, verb: 'Pull out', name: p.name, hold: me.act === 'use' ? Math.min(1, me.actT / PULL_TIME) : null, ...(far ? { note: 'move closer' } : {}) };
      }
      if (p.life !== 'downed') return null;
      // the host revives only within REVIVE_RANGE on the ground (sim/systems/vitals.ts)
      const far = Math.hypot(p.x - me.x, p.z - me.z) > REVIVE_RANGE;
      return { ...base, verb: 'Revive', name: p.name, hold: p.reviver === me.id ? p.revive : null, ...(far ? { note: 'move closer' } : {}) };
    }
    default:
      return null;
  }
}

function describeDevice(d: DeviceEnt, me: PlayerEnt, base: { id: number; kind: Entity['kind']; hold: number | null; key: string }): Focus | null {
  // (sim/systems/objective.ts: the panel's progress is the share of parts in, the generator's its charge)
  switch (d.type) {
    case 'panel': {
      const parts = (Object.keys(PART_NAME) as (keyof typeof PART_NAME)[]).filter((p) => has(me, `part_${p}`));
      if (parts.length) return { ...base, verb: 'Install', name: 'Transmitter', note: PART_NAME[parts[0]], hold: me.act === 'use' ? Math.min(1, me.actT / INSTALL_TIME) : null };
      const n = Math.round(d.progress * 5);
      return { ...base, verb: 'Check', name: 'Transmitter', note: n >= 5 ? 'all five parts in' : `${n} of 5 parts in` };
    }
    case 'generator':
      return { ...base, verb: 'Crank', name: 'Generator', hold: me.act === 'crank' || (d.progress > 0 && d.progress < 1) ? d.progress : null };
    case 'door':
      return { ...base, verb: d.on || d.progress > 0.5 ? 'Close' : 'Open', name: 'Door' };
    case 'beacon':
      return null; // it lights by itself when the call goes out
    case 'bed':
      return { ...base, verb: 'Rest', name: 'Bunk', hold: me.act === 'use' ? Math.min(1, me.actT / BED_TIME) : null };
    case 'note':
      return { ...base, verb: 'Read', name: 'Note' };
    default:
      return null;
  }
}

const KINDS = ['pickup', 'crate', 'fire', 'wood', 'log', 'device', 'player'] as const;

export class FocusPicker {
  /** The current pick (also in view.hud.focus), and its id for the next command (0 = none, or a tree). */
  focus: Focus | null = null;
  id = 0;
  private readonly near: number[] = [];

  constructor(private readonly world: World) {}

  /**
   * The conifer trunk the view ray (origin o, unit direction d) meets first, within REACH of the eye, at
   * the height of the dead lower branches, its bark within GATHER_REACH of the body, still unstripped and
   * in sight (walls and rocks block; lineClear ignores trees). Returns its index or -1.
   */
  private pickTree(view: View, me: PlayerEnt, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const w = this.world;
    const a = dx * dx + dz * dz;
    if (a < 1e-4) return -1; // looking straight down or up
    const near = this.near;
    near.length = 0;
    const R = GATHER_REACH + 1;
    w.treesIn(me.x - R, me.z - R, me.x + R, me.z + R, near);
    const gone = view.gathered;
    let best = -1, bestS = Infinity, bx = 0, by = 0, bz = 0;
    for (let k = 0; k < near.length; k++) {
      const i = near[k];
      const t = w.trees[i];
      if (!hasBranches(t) || (gone !== undefined && gone.has(i))) continue;
      const r = trunkRadius(t);
      if (Math.hypot(t.x - me.x, t.z - me.z) - r > GATHER_REACH) continue;
      // the ray against the trunk as an upright cylinder of radius r + TRUNK_MARGIN
      const rr = r + TRUNK_MARGIN;
      const fx = ox - t.x, fz = oz - t.z;
      const b = fx * dx + fz * dz;
      const c = fx * fx + fz * fz - rr * rr;
      let s = 0;
      if (c > 0) {
        const disc = b * b - a * c;
        if (disc < 0) continue;
        s = (-b - Math.sqrt(disc)) / a;
        if (s < 0) continue; // behind the eye
      }
      if (s > REACH || s >= bestS) continue;
      const y = oy + dy * s;
      if (y < t.y + BRANCH_LOW || y > t.y + BRANCH_HIGH) continue;
      best = i;
      bestS = s;
      bx = ox + dx * s;
      by = y;
      bz = oz + dz * s;
    }
    if (best < 0 || !w.lineClear(ox, oy, oz, bx, by, bz)) return -1;
    return best;
  }

  update(view: View, cam: Camera, keyLabel: string, enabled: boolean): Focus | null {
    const me = view.me;
    if (!enabled || !me || me.life !== 'alive' || cam.third > 0.5) {
      this.focus = null;
      this.id = 0;
      return null;
    }
    const ox = cam.x, oy = cam.y, oz = cam.z;
    const cp = Math.cos(cam.pitch);
    const dx = -Math.sin(cam.yaw) * cp, dy = Math.sin(cam.pitch), dz = -Math.cos(cam.yaw) * cp;
    let best: ViewEnt | null = null;
    let bestScore = Infinity;
    const reach2 = (REACH + 0.8) * (REACH + 0.8);
    for (const kind of KINDS) {
      const list = view.list(kind) as ViewEnt[];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.id === me.id) continue;
        const sh = shapeOf(e);
        const ex = e.x - ox, ey = e.y + sh.y - oy, ez = e.z - oz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > reach2) continue;
        const along = ex * dx + ey * dy + ez * dz;
        if (along < 0.15 || along > REACH + sh.r) continue;
        const px = ex - dx * along, py = ey - dy * along, pz = ez - dz * along;
        const off = Math.sqrt(px * px + py * py + pz * pz);
        if (off > sh.r + 0.12) continue;
        // prefer what the ray passes closest to, then the nearer one
        const score = off / (sh.r + 0.12) + along * 0.08;
        if (score < bestScore) {
          bestScore = score;
          best = e;
        }
      }
    }
    let f: Focus | null = null;
    if (best) {
      const sh = shapeOf(best);
      // Something solid in between (a wall, the ground) hides it. The segment stops short of the
      // thing itself: a crate or a stove stands inside its own collider.
      const tx = best.x - ox, ty = best.y + sh.y - oy, tz = best.z - oz;
      const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const k = d > 1e-3 ? Math.max(0, d - sh.r - 0.15) / d : 0;
      if (k <= 0 || this.world.lineClear(ox, oy, oz, ox + tx * k, oy + ty * k, oz + tz * k)) f = describe(best, me, keyLabel);
    }
    if (!f && !me.swim && me.carry === 0) {
      // nothing else in focus: a trunk whose dead branches can be snapped off
      const i = this.pickTree(view, me, ox, oy, oz, dx, dy, dz);
      if (i >= 0) f = describeTree(this.world.trees[i], i, me, keyLabel);
    }
    if (f && this.focus && this.focus.id === f.id && this.focus.kind === f.kind && this.focus.tree === f.tree && this.focus.verb === f.verb && this.focus.name === f.name && this.focus.note === f.note) {
      // same thing: keep the object (the HUD compares by identity) and refresh the progress
      this.focus.hold = f.hold;
      this.focus.key = f.key;
      f = this.focus;
    }
    this.focus = f;
    this.id = f ? f.id : 0;
    return f;
  }
}
