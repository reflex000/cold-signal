// Shared conventions of the tool models (axe, flashlight, flare gun, rifle, radio) and the small
// things the first-person hands use (match, ration, thermos, cartridges ...).
//
// MODEL SPACE (how a tool is built): like a first-person camera looking at it in the hand:
// forward -Z, up +Y, right +X, metres. The origin is the centre of the main fist.
//
// HAND FRAME (a grip): origin = the fist centre, which is the axis of the handle it holds; +Y runs
// from the wrist toward the knuckles; -Z points out of the thumb side of the fist (the handle runs
// along Z); X = Y x Z (the palm side of a right hand, the back of a left hand). This is FIGURES'
// "item space" (src/actors/items.ts), so a tool in item space is the model under the inverse of its
// main grip frame. Grip frames are stored as anchors with the extra field `q` (the frame's rotation
// in model space as [x, y, z, w]); their position is the anchor position.
//
// POSES. getModel(tool) is the tool lying on the ground (a pickup; stands on y = 0, merged, snow
// exposure on, ground occlusion). getModel(tool, 0, { pose: 'hand' }) is model space with the moving
// bits as named parts (bolt, hammer, barrel, crank, needle, lamp ...), no ground occlusion and no
// snow exposure. `lod` 1 is the cheaper third-person / far version.
import * as THREE from 'three/webgpu';
import type { Builder, Group, V3 } from '../kit';
import type { ModelOpts } from '../registry';

export type ToolPose = 'hand' | 'ground';

export interface ToolCtx {
  b: Builder;
  pose: ToolPose;
  /** 0 first person, 1 third person / pickup. */
  lod: number;
  /** Lathe and loft side counts for this level of detail. */
  sides(n: number): number;
  /** A named part in the hand pose, plain geometry otherwise (pickups are one merged mesh). */
  part(name: string, pivot: V3, fn: () => void): void;
}

export function toolCtx(b: Builder, opts: ModelOpts): ToolCtx {
  const pose: ToolPose = opts.pose === 'hand' ? 'hand' : 'ground';
  const lod = Math.max(0, Math.min(1, Number(opts.lod ?? (pose === 'hand' ? 0 : 1)) | 0));
  return {
    b,
    pose,
    lod,
    sides: (n: number) => (lod === 0 ? n : Math.max(5, Math.round(n * 0.55))),
    part: (name, pivot, fn) => {
      if (pose === 'hand') b.part(name, fn, pivot);
      else fn();
    },
  };
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * The rotation of a hand frame from the direction the knuckles point (+Y, `knuckles`) and the
 * direction the thumb side of the fist points along the handle (-Z, `thumb`). `knuckles` is made
 * perpendicular to the handle.
 */
export function handFrame(knuckles: V3, thumb: V3, out = new THREE.Quaternion()): THREE.Quaternion {
  _z.set(-thumb[0], -thumb[1], -thumb[2]).normalize();
  _y.set(knuckles[0], knuckles[1], knuckles[2]);
  _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/** Declare a grip frame anchor (see the header). */
export function gripAnchor(b: Builder, name: string, at: V3, knuckles: V3, thumb: V3, extra: Record<string, unknown> = {}): void {
  const q = handFrame(knuckles, thumb);
  b.anchor(name, at, 0, { q: [q.x, q.y, q.z, q.w], ...extra });
}

/**
 * Lay a tool built in model space on the ground: turn the group by `rot` (Euler XYZ, radians), then
 * move it so it rests on y = 0, centred on the origin in x and z.
 */
export function layDown(g: Group, rx: number, ry: number, rz: number): void {
  g.apply(_m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')));
  const bb = g.bounds();
  g.move(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
}

/** Smoothstep. */
export function sstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
