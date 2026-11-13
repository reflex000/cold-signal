// The five tool models. Importing this module registers them with ../registry:
//   import './models/tools';
//   getModel('rifle')                       lying on the ground (a pickup)
//   getModel('rifle', 0, { pose: 'hand' })  model space with named parts and grip frames
// See ./common.ts for the conventions. toolItem() gives a tool in FIGURES' item space (the inverse
// of its main grip frame) with the item points FIGURES' third-person code uses.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ToolId } from '../../sim/types';
import type { Anchor, ModelDef, V3 } from '../kit';
import { getModel } from '../registry';
import './axe';
import './flashlight';
import './flaregun';
import './rifle';
import './radio';

export type Tool = Exclude<ToolId, 'hands'>;
export const TOOL_MODELS: readonly Tool[] = ['axe', 'flashlight', 'flaregun', 'rifle', 'radio'];

export { getExtra, type ExtraName } from './extras';
export { handFrame } from './common';
export { AXE_HEAD_Y } from './axe';
export { FLASH_LENS_Z, FLASH_TAIL_Z } from './flashlight';
export { FLARE_BORE_Y, FLARE_BREECH_Z, FLARE_HAMMER, FLARE_HINGE, FLARE_MUZZLE_Z } from './flaregun';
export { RIFLE_BOLT_LIFT, RIFLE_BOLT_PIVOT, RIFLE_BOLT_TRAVEL, RIFLE_BORE_Y, RIFLE_EYE, RIFLE_MUZZLE_Z, RIFLE_SCOPE_Y } from './rifle';
export { RADIO_CRANK_ARM, RADIO_CRANK_AXLE, RADIO_D, RADIO_H, RADIO_NEEDLE, RADIO_NEEDLE_SWEEP, RADIO_W } from './radio';

/** The hand-pose model of a tool (cached by the registry). */
export function toolModel(tool: Tool, lod = 0): ModelDef {
  return getModel(tool, 0, { pose: 'hand', lod });
}

/** A grip frame anchor as a matrix (model space <- hand frame). */
export function gripMatrix(def: ModelDef, name: string, out = new THREE.Matrix4()): THREE.Matrix4 {
  const a = def.anchors[name] as (Anchor & { q?: number[] }) | undefined;
  if (!a) return out.identity();
  const q = a.q ? new THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]) : new THREE.Quaternion();
  return out.compose(a.position, q, new THREE.Vector3(1, 1, 1));
}

/** Which grip FIGURES' item space is taken from, and which hand holds the tool in third person. */
const ITEM_GRIP: Record<Tool, { grip: string; hand: 'R' | 'L' }> = {
  axe: { grip: 'gripR', hand: 'R' },
  flashlight: { grip: 'gripR', hand: 'R' },
  flaregun: { grip: 'item', hand: 'R' },
  rifle: { grip: 'item', hand: 'R' },
  radio: { grip: 'carry', hand: 'L' },
};

/** Item points by FIGURES' names (src/actors/items.ts ITEM_POINTS), as anchor names or fixed model points. */
const ITEM_NAMES: Record<Tool, Record<string, string | V3>> = {
  axe: { end: 'end', head: 'head', edge: 'edge' },
  flashlight: { lamp: 'lamp', tail: 'tail' },
  flaregun: { muzzle: 'muzzle' },
  rifle: { fore: 'gripL', butt: [0, 0.013, 0.336], muzzle: 'muzzle', bolt: 'boltKnob', cheek: 'cheek' },
  radio: { crankAxle: 'crankAxle', crankKnob: 'gripR' },
};

export interface ToolItem {
  tool: Tool;
  hand: 'R' | 'L';
  /** All parts merged in their rest positions, in item space (KIT vertex layout). */
  geometry: THREE.BufferGeometry;
  points: Record<string, V3>;
  tris: number;
}

const itemCache = new Map<string, ToolItem>();

/**
 * A tool in FIGURES' item space (fist origin, handle along -Z toward the thumb, knuckles +Y): a
 * drop-in for src/actors/items.ts getItem(tool, lod) (the third-person tool in hand).
 */
export function toolItem(tool: Tool, lod = 1): ToolItem {
  const key = tool + lod;
  const hit = itemCache.get(key);
  if (hit) return hit;
  const def = toolModel(tool, lod);
  const spec = ITEM_GRIP[tool];
  const inv = gripMatrix(def, spec.grip).invert();
  const geos: THREE.BufferGeometry[] = [];
  if (def.geometry) geos.push(def.geometry.clone());
  for (const p of Object.values(def.parts)) {
    if (!p.geometry) continue;
    geos.push(p.geometry.clone().translate(p.pivot.x, p.pivot.y, p.pivot.z));
  }
  const merged = mergeGeometries(geos, false) ?? geos[0];
  for (const g of geos) if (g !== merged) g.dispose();
  merged.applyMatrix4(inv);
  merged.computeBoundingSphere();
  const points: Record<string, V3> = {};
  const v = new THREE.Vector3();
  for (const [name, src] of Object.entries(ITEM_NAMES[tool])) {
    if (typeof src === 'string') {
      const a = def.anchors[src];
      if (!a) continue;
      v.copy(a.position);
    } else v.set(src[0], src[1], src[2]);
    v.applyMatrix4(inv);
    points[name] = [v.x, v.y, v.z];
  }
  const item: ToolItem = { tool, hand: spec.hand, geometry: merged, points, tris: def.tris };
  itemCache.set(key, item);
  return item;
}
