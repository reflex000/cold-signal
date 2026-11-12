// Focus picking: which entity is under the crosshair within reach, what E would do to it, and
// its name, for hud.focus and InputCmd.focus (the host validates the choice). Picked by the
// distance from the view ray to the thing's centre, so small items are as easy to aim at as
// crates; walls and terrain in between block it.
// Owner: GAME.
import { ITEM, PART_NAME } from '../ui/text';
import type { CrateEnt, DeviceEnt, Entity, FireEnt, LogEnt, PickupEnt, PlayerEnt, WoodEnt } from '../sim/types';
import type { World } from '../world/types';
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

const CRATE_NAME: Record<CrateEnt['type'], string> = {
  luggage: 'Suitcase', locker: 'Locker', crate: 'Crate', medkit: 'First aid kit', cupboard: 'Cupboard', toolbox: 'Toolbox',
};
const WOOD_NAME: Record<WoodEnt['type'], string> = { snag: 'Dead tree', deadfall: 'Deadfall', stump: 'Stump', branchpile: 'Branch pile' };
const FIRE_NAME: Record<FireEnt['type'], string> = { campfire: 'Campfire', stove: 'Stove', barrel: 'Barrel fire' };

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
      return { ...base, verb: 'Open', name: CRATE_NAME[e.type] ?? 'Crate' };
    case 'fire': {
      const name = FIRE_NAME[e.type] ?? 'Fire';
      if (e.lit) {
        const wood = has(me, 'stick') || has(me, 'log') || has(me, 'tinder');
        return { ...base, verb: 'Feed fire', name, ...(wood ? {} : { note: 'needs wood' }) };
      }
      if (e.embers > 0) return { ...base, verb: 'Light', name, note: 'embers' };
      return { ...base, verb: 'Light', name, ...(has(me, 'matches') ? {} : { note: 'needs matches' }) };
    }
    case 'wood':
      return { ...base, verb: 'Chop', name: WOOD_NAME[e.type] ?? 'Dead wood', ...(me.held === 'axe' ? {} : { note: has(me, 'axe') ? 'take the axe' : 'needs an axe' }) };
    case 'log': {
      const l = e as LogEnt;
      if (me.carry === l.id) return { ...base, verb: 'Put down', name: 'Heavy log' };
      if (l.a && l.b) return null;
      return { ...base, verb: l.a || l.b ? 'Take the other end' : 'Lift', name: 'Heavy log' };
    }
    case 'device':
      return describeDevice(e, me, base);
    case 'player': {
      const p = e as PlayerEnt;
      if (p.id === me.id || p.life !== 'downed') return null;
      return { ...base, verb: 'Revive', name: p.name, hold: p.reviver === me.id ? p.revive : null };
    }
    default:
      return null;
  }
}

function describeDevice(d: DeviceEnt, me: PlayerEnt, base: { id: number; kind: Entity['kind']; hold: number | null; key: string }): Focus | null {
  switch (d.type) {
    case 'panel': {
      const parts = (Object.keys(PART_NAME) as (keyof typeof PART_NAME)[]).filter((p) => has(me, `part_${p}`));
      return parts.length ? { ...base, verb: 'Install', name: 'Transmitter', note: PART_NAME[parts[0]] } : { ...base, verb: 'Look', name: 'Transmitter' };
    }
    case 'generator':
      return { ...base, verb: 'Crank', name: 'Generator', hold: d.progress > 0 && d.progress < 1 ? d.progress : null };
    case 'door':
      return { ...base, verb: d.on || d.progress > 0.5 ? 'Close' : 'Open', name: 'Door' };
    case 'beacon':
      return { ...base, verb: d.on ? 'Switch off' : 'Switch on', name: 'Beacon' };
    case 'bed':
      return { ...base, verb: 'Rest', name: 'Bed' };
    case 'note':
      return { ...base, verb: 'Read', name: 'Note' };
    default:
      return null;
  }
}

const KINDS = ['pickup', 'crate', 'fire', 'wood', 'log', 'device', 'player'] as const;

export class FocusPicker {
  /** The current pick (also in view.hud.focus), and its id for the next command (0 = none). */
  focus: Focus | null = null;
  id = 0;

  constructor(private readonly world: World) {}

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
      const sh = SHAPE[kind];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.id === me.id) continue;
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
      const sh = SHAPE[best.kind];
      // Something solid in between (a wall, the ground) hides it. The segment stops short of the
      // thing itself: a crate or a stove stands inside its own collider.
      const tx = best.x - ox, ty = best.y + sh.y - oy, tz = best.z - oz;
      const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const k = d > 1e-3 ? Math.max(0, d - sh.r - 0.15) / d : 0;
      if (k <= 0 || this.world.lineClear(ox, oy, oz, ox + tx * k, oy + ty * k, oz + tz * k)) f = describe(best, me, keyLabel);
    }
    if (f && this.focus && this.focus.id === f.id && this.focus.verb === f.verb && this.focus.name === f.name && this.focus.note === f.note) {
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
