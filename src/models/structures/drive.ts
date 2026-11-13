// THE STRUCTURE DRIVER: moves and lights the named parts of the placed structures from what the
// game shows (f.view), so the doors you open swing, the crank turns as the charge rises, the radio
// modules appear in the panel as they are installed and the cabin windows glow while the stove
// burns. Presentation only: it reads the View and touches nothing else.
//
//   engine.add(createStructureDriver(props));     // props: KIT's props system with the placed models
//
// Part names it knows (declared by the models in this folder and in ../wreck):
//   door             hinged; DeviceEnt 'door' nearby (progress 0..1, or on), and while a player
//                    stands within 1.2 m of the model's 'door' anchor
//   locker_door*     hinged; CrateEnt 'locker' nearby (open)
//   cupboard_door*   hinged; CrateEnt 'cupboard' nearby (open)
//   slot_<part>      a radio module in the tower panel: shown when objective.parts[part] is 'installed'
//   panel_lights     the panel's indicator lamps: shown while the generator holds charge
//   crank            turns about its axis as objective.generator rises (40 turns for a full charge)
//   needle           the generator's charge meter
//   lamps            the mast's red obstruction lamps: slow flash once the generator is charged
//   beacon           the deck strobe: DeviceEnt 'beacon' on
//   glow*            warm window / lamp light: the stove (FireEnt 'stove') in that structure burns
// Hinged parts swing to openAngle * t about their axis; the angle eases so a door snapping open in
// the simulation still swings.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem } from '../../gfx/api';
import type { CrateEnt, DeviceEnt, FireEnt, PartId, PlayerEnt } from '../../sim/types';
import type { PropsSystem } from '../instances';

const PART_IDS: readonly PartId[] = ['battery', 'handset', 'coil', 'tube', 'fuse'];
/** Turns of the crank for a full charge. */
export const CRANK_TURNS = 40;

export interface StructureState {
  /** Every hinged part, 0 shut .. 1 open. */
  open: number;
  /** Stove heat 0..1 (window glow above 0). */
  stove: number;
  /** Radio modules in the panel: a count (first n of battery, handset, coil, tube, fuse) or a set. */
  installed: number | Partial<Record<PartId, boolean>>;
  /** Generator charge 0..1. */
  charge: number;
  /** Crank angle in radians. */
  crank: number;
  /** Deck strobe on. */
  beacon: boolean;
}

interface Hinge { id: number; obj: THREE.Object3D; axis: THREE.Vector3; angle: number; t: number; x: number; z: number; want: number; dx: number; dz: number }
interface Spot { id: number; obj: THREE.Object3D; x: number; z: number; axis: THREE.Vector3 }

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Every named part of every placed prop, sorted by kind, with its world position. */
function survey(props: PropsSystem) {
  const doors: Hinge[] = [], lockers: Hinge[] = [], cupboards: Hinge[] = [];
  const slots: { id: number; obj: THREE.Object3D; part: PartId }[] = [];
  const panelLights: Spot[] = [], cranks: Spot[] = [], needles: Spot[] = [], lamps: Spot[] = [], beacons: Spot[] = [];
  const glows: Spot[] = [];
  for (let id = 0; id < props.count; id++) {
    const def = props.model(id);
    if (!def || !props.has(id)) continue;
    const names = Object.keys(def.parts);
    if (!names.length) continue;
    props.matrix(id, _m);
    for (const name of names) {
      const obj = props.part(id, name);
      if (!obj) continue;
      const pd = def.parts[name];
      _v.copy(pd.pivot).applyMatrix4(_m);
      const x = _v.x, z = _v.z;
      // the doorway centre (the model's 'door' anchor) for doors, else the pivot
      const da = name === 'door' ? def.anchors.door : undefined;
      if (da) _v.copy(da.position).applyMatrix4(_m);
      const hinge: Hinge = { id, obj, axis: pd.axis.clone(), angle: pd.openAngle, t: 0, x, z, want: 0, dx: da ? _v.x : x, dz: da ? _v.z : z };
      if (name === 'door') doors.push(hinge);
      else if (name.startsWith('locker_door')) lockers.push(hinge);
      else if (name.startsWith('cupboard_door')) cupboards.push(hinge);
      else if (name.startsWith('slot_')) {
        const part = name.slice(5) as PartId;
        if (PART_IDS.includes(part)) slots.push({ id, obj, part });
      } else if (name === 'panel_lights') panelLights.push({ id, obj, x, z, axis: pd.axis });
      else if (name === 'crank') cranks.push({ id, obj, x, z, axis: pd.axis.clone() });
      else if (name === 'needle') needles.push({ id, obj, x, z, axis: pd.axis.clone() });
      else if (name === 'lamps') lamps.push({ id, obj, x, z, axis: pd.axis });
      else if (name === 'beacon') beacons.push({ id, obj, x, z, axis: pd.axis });
      else if (name.startsWith('glow')) {
        // matched to its stove by the 'stove' anchor's world position
        const st = def.anchors.stove;
        _v.copy(st ? st.position : pd.pivot).applyMatrix4(_m);
        glows.push({ id, obj, x: _v.x, z: _v.z, axis: pd.axis });
      }
    }
  }
  return { doors, lockers, cupboards, slots, panelLights, cranks, needles, lamps, beacons, glows };
}

function nearest<T extends { x: number; z: number }>(list: T[], x: number, z: number, r: number): T | null {
  let best: T | null = null, bd = r * r;
  for (const h of list) {
    const d = (h.x - x) * (h.x - x) + (h.z - z) * (h.z - z);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

const ease = (t: number): number => t * t * (3 - 2 * t);
function swing(h: Hinge, t: number): void {
  h.t = t;
  h.obj.quaternion.setFromAxisAngle(h.axis, h.angle * ease(t));
}

/**
 * Put every structure of a props system into one state (benches, photo setups). The game uses
 * createStructureDriver() instead, which reads the View every frame.
 */
export function applyStructureState(props: PropsSystem, s: Partial<StructureState>): void {
  const S = survey(props);
  for (const h of [...S.doors, ...S.lockers, ...S.cupboards]) swing(h, s.open ?? 0);
  const inst = s.installed ?? 0;
  for (const sl of S.slots) sl.obj.visible = typeof inst === 'number' ? PART_IDS.indexOf(sl.part) < inst : !!inst[sl.part];
  const charge = s.charge ?? 0;
  for (const p of S.panelLights) p.obj.visible = charge > 0.05;
  for (const c of S.cranks) c.obj.quaternion.setFromAxisAngle(c.axis, s.crank ?? 0);
  for (const n of S.needles) n.obj.quaternion.setFromAxisAngle(n.axis, (charge - 0.5) * 1.6);
  for (const l of S.lamps) l.obj.visible = charge > 0.2;
  for (const bc of S.beacons) bc.obj.visible = !!s.beacon;
  for (const g of S.glows) g.obj.visible = (s.stove ?? 0) > 0;
}

/** The game's driver ('structures'): add it after the props system. */
export function createStructureDriver(props: PropsSystem): GfxSystem {
  let S: ReturnType<typeof survey> | null = null;
  let count = -1;
  // entity id -> its part, found once
  const doorOf = new Map<number, Hinge | null>();
  const crateOf = new Map<number, Hinge | null>();
  let crankAngle = 0, lastCharge = -1;
  const init = (): void => {
    S = survey(props);
    count = props.count;
    doorOf.clear();
    crateOf.clear();
    for (const sl of S.slots) sl.obj.visible = false;
    for (const p of [...S.panelLights, ...S.lamps, ...S.beacons, ...S.glows]) p.obj.visible = false;
  };
  return {
    name: 'structures',
    update(f: Frame): void {
      if (count !== props.count || !S) init();
      const s = S!;
      const view = f.view;
      if (!view) return;
      const dt = Math.min(0.1, Math.max(0, f.dt));
      // ---- doors and the lockers / cupboards built into the structures ----
      // A door opens when its device says so, and (the doorways are open gaps in the colliders)
      // while anyone stands in it, so nobody walks through a shut door leaf.
      for (const h of s.doors) h.want = 0;
      for (const d of view.list('device') as DeviceEnt[]) {
        if (d.type === 'door') {
          let h = doorOf.get(d.id);
          if (h === undefined) doorOf.set(d.id, (h = nearest(s.doors, d.x, d.z, 1.6)));
          if (!h) continue;
          h.want = Math.max(h.want, d.progress > 0 ? Math.min(1, d.progress) : d.on ? 1 : 0);
        } else if (d.type === 'beacon') {
          const bc = nearest(s.beacons, d.x, d.z, 3);
          if (bc) bc.obj.visible = d.on && (f.time * 1.25) % 1 < 0.12;
        }
      }
      for (const p of view.list('player') as PlayerEnt[]) {
        for (const h of s.doors) {
          const ddx = p.x - h.dx, ddz = p.z - h.dz;
          if (ddx * ddx + ddz * ddz < 1.2 * 1.2) h.want = 1;
        }
      }
      for (const h of s.doors) if (h.t !== h.want) swing(h, h.t + Math.sign(h.want - h.t) * Math.min(Math.abs(h.want - h.t), dt * 1.6));
      for (const c of view.list('crate') as CrateEnt[]) {
        if (c.type !== 'locker' && c.type !== 'cupboard') continue;
        let h = crateOf.get(c.id);
        if (h === undefined) crateOf.set(c.id, (h = nearest(c.type === 'locker' ? s.lockers : s.cupboards, c.x, c.z, 1.6)));
        if (!h) continue;
        const target = c.open ? 1 : 0;
        if (h.t !== target) swing(h, h.t + Math.sign(target - h.t) * Math.min(Math.abs(target - h.t), dt * 2));
      }
      // ---- the radio panel, the generator and the mast ----
      const o = view.objective;
      if (o) {
        for (const sl of s.slots) sl.obj.visible = o.parts[sl.part] === 'installed';
        const charge = Math.max(0, Math.min(1, o.generator));
        if (lastCharge >= 0 && charge > lastCharge) crankAngle += (charge - lastCharge) * CRANK_TURNS * Math.PI * 2;
        lastCharge = charge;
        for (const c of s.cranks) c.obj.quaternion.setFromAxisAngle(c.axis, -crankAngle);
        for (const n of s.needles) n.obj.quaternion.setFromAxisAngle(n.axis, (charge - 0.5) * 1.6);
        const powered = charge > 0.05 || o.stage === 'holdout' || o.stage === 'rescue' || o.stage === 'won';
        for (const p of s.panelLights) p.obj.visible = powered;
        const lampsOn = charge > 0.2 || o.stage === 'holdout' || o.stage === 'rescue' || o.stage === 'won';
        const flash = (f.time * 0.5) % 1 < 0.5;
        for (const l of s.lamps) l.obj.visible = lampsOn && flash;
      }
      // ---- warm windows while a stove burns inside ----
      if (s.glows.length) {
        for (const g of s.glows) g.obj.visible = false;
        for (const fe of view.list('fire') as FireEnt[]) {
          if (fe.type !== 'stove' || !(fe.lit || fe.embers > 0)) continue;
          const g = nearest(s.glows, fe.x, fe.z, 1.5);
          if (g) g.obj.visible = true;
        }
      }
    },
  };
}
