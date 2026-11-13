// The tools a figure holds: axe, flashlight, flare gun, rifle, hand-crank radio. Built with the KIT
// Builder in ITEM SPACE: the origin is the centre of the fist that holds it, the handle runs through
// the fist along -Z toward the thumb, +Y points from the wrist toward the knuckles. `points` are
// named places in item space (where the other hand goes, the lamp, the muzzle, the crank).
// itemGeometry() moves an item into a hand's bind space and binds it rigidly to that hand, so it is
// drawn with the figure material in the figure's own row.
import * as THREE from 'three/webgpu';
import type { ToolId } from '../sim/types';
import { Builder, MAT, PAL, hex, type V3 } from '../models/kit';
import { PB, PLAYER_BIND } from './player_model';
import { A_POSE } from './player_model';

export interface ItemDef {
  tool: ToolId;
  /** Which hand holds it. */
  hand: 'R' | 'L';
  geometry: THREE.BufferGeometry;
  points: Record<string, V3>;
  tris: number;
}

const DEG = Math.PI / 180;

function finish(b: Builder): { geometry: THREE.BufferGeometry; tris: number } {
  const def = b.build({ ao: 0.8, ground: false, aoRadius: 0.03 });
  return { geometry: def.geometry!, tris: def.tris };
}

/** Felling axe: hickory handle (0.7 m), steel head. The fist holds it 0.45 m from the head. */
function axe(lod: number): Omit<ItemDef, 'hand'> {
  const b = new Builder(0xa8e);
  const sides = lod === 0 ? 10 : 6;
  b.ink({ color: hex(0x7a5634), mat: MAT.WOOD, wear: 0.55, snow: 0.3, grain: 'y' });
  // handle along Z: head at z = -0.45, end at z = +0.25, a slight S curve and a swell at the end
  const handle = b.cyl(0.0155, 0.7, { sides, r2: 0.0135, rows: lod === 0 ? 6 : 2, bevel: 0.004 });
  handle.rotX(Math.PI / 2).move(0, 0, -0.1);
  handle.warp((p) => {
    const t = (p.z + 0.45) / 0.7;
    p.y += 0.008 * Math.sin(t * Math.PI * 2) - 0.004 * t;
    const swell = 1 + 0.35 * Math.max(0, (t - 0.9) / 0.1);
    p.x *= swell;
    p.y *= 1 + 0.15 * Math.max(0, (t - 0.9) / 0.1);
  });
  // steel head: cheek wedge toward +Y (the edge faces where the knuckles point), poll toward -Y
  b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.6, snow: 0.3, rough: 0.5 });
  const head = b.extrude([[-0.012, -0.05], [0.012, -0.05], [0.012, 0.03], [0.004, 0.09], [-0.004, 0.09], [-0.012, 0.03]], 0.06, { bevel: 0.003 });
  head.rotX(Math.PI / 2).move(0, 0, -0.45);
  // extrude is along Y; after rotX the profile's Z became Y: edge toward +Y
  head.each((v) => {
    // the bright ground edge
    if (v.y > 0.075) { v.r = PAL.steel[0] * 1.3; v.g = PAL.steel[1] * 1.3; v.b = PAL.steel[2] * 1.3; v.wear = 0.2; }
  });
  void head;
  const g = finish(b);
  return { tool: 'axe', ...g, points: { end: [0, -0.004, 0.22], head: [0, 0.02, -0.45], edge: [0, 0.09, -0.45] } };
}

/** Steel flashlight: lamp toward -Z (the thumb). */
function flashlight(lod: number): Omit<ItemDef, 'hand'> {
  const b = new Builder(0xf1a);
  const sides = lod === 0 ? 12 : 7;
  b.ink({ color: hex(0x2a2c2e), mat: MAT.PAINT, wear: 0.5, snow: 0.2 });
  const body = b.cyl(0.017, 0.2, { sides, rows: 2, bevel: 0.003 });
  body.rotX(Math.PI / 2).move(0, 0, -0.01);
  const headP = b.cyl(0.027, 0.06, { sides, r2: 0.019, bevel: 0.004 });
  headP.rotX(-Math.PI / 2).move(0, 0, -0.125);
  b.ink({ color: hex(0xffe9c4), mat: MAT.EMISSIVE, emissive: 0.6, snow: 0 });
  const lens = b.cyl(0.0225, 0.004, { sides, bevel: 0.001 });
  lens.rotX(Math.PI / 2).move(0, 0, -0.156);
  b.ink({ color: PAL.rubber, mat: MAT.RUBBER, wear: 0.4, snow: 0.2 });
  const tail = b.cyl(0.0185, 0.02, { sides, bevel: 0.004 });
  tail.rotX(Math.PI / 2).move(0, 0, 0.095);
  const g = finish(b);
  return { tool: 'flashlight', ...g, points: { lamp: [0, 0, -0.16], tail: [0, 0, 0.1] } };
}

/** Orange flare pistol: grip along -Z, barrel along +Y from the top of the grip. */
function flaregun(lod: number): Omit<ItemDef, 'hand'> {
  const b = new Builder(0xf1e);
  const sides = lod === 0 ? 12 : 7;
  b.ink({ color: PAL.orange, mat: MAT.PLASTIC, wear: 0.45, snow: 0.3, rough: 0.55 });
  const grip = b.pillow(0.028, 0.034, 0.11, { round: 0.01, seg: 1, ring: 1 });
  grip.rotX(-12 * DEG).move(0, -0.002, -0.005);
  const frame = b.pillow(0.03, 0.05, 0.06, { round: 0.01, seg: 1, ring: 1 });
  frame.move(0, 0.02, -0.065);
  const barrel = b.cyl(0.021, 0.17, { sides, r2: 0.02, bevel: 0.004 });
  barrel.move(0, 0.11, -0.082);
  b.ink({ color: hex(0x151515), mat: MAT.PLASTIC, wear: 0.3, snow: 0.1 });
  const bore = b.cyl(0.013, 0.004, { sides, bevel: 0.001 });
  bore.move(0, 0.196, -0.082);
  const guard = b.torus(0.017, 0.0035, { sides: 4, segs: lod === 0 ? 10 : 6 });
  guard.rotZ(Math.PI / 2).move(0, 0.03, -0.03);
  const g = finish(b);
  return { tool: 'flaregun', ...g, points: { muzzle: [0, 0.2, -0.082] } };
}

/** Bolt-action hunting rifle: the right fist on the wrist of the stock; barrel along +Y. */
function rifle(lod: number): Omit<ItemDef, 'hand'> {
  const b = new Builder(0x41f);
  const sides = lod === 0 ? 10 : 6;
  // the bore axis runs along +Y at z = -0.045 (above the fist), from the butt (y = -0.27) to the muzzle (y = 0.84)
  const ax = -0.05;
  b.ink({ color: hex(0x5a3a22), mat: MAT.WOOD, wear: 0.5, snow: 0.35, grain: 'y' });
  // butt stock
  const butt = b.pillow(0.04, 0.24, 0.12, { round: 0.016, bulge: 0.003, seg: lod === 0 ? 2 : 1, ring: 1 });
  butt.move(0, -0.15, 0.0);
  butt.warp((p) => {
    // drop toward the butt plate, comb up top
    const t = Math.max(0, (-p.y - 0.03) / 0.24);
    p.z += t * 0.03;
  });
  // wrist (the grip), fore-end
  const wrist = b.cyl(0.018, 0.09, { sides, bevel: 0.004 });
  wrist.rotX(-0.35).move(0, 0.005, -0.01);
  const fore = b.pillow(0.036, 0.36, 0.042, { round: 0.014, seg: lod === 0 ? 2 : 1, ring: 1 });
  fore.move(0, 0.29, ax + 0.006);
  b.ink({ color: hex(0x1b1c1e), mat: MAT.METAL, wear: 0.35, snow: 0.2, rough: 0.45 });
  const receiver = b.cyl(0.0165, 0.2, { sides, bevel: 0.003 });
  receiver.move(0, 0.12, ax);
  const barrel = b.cyl(0.0105, 0.6, { sides, r2: 0.0085, bevel: 0.002 });
  barrel.move(0, 0.52, ax - 0.002);
  // bolt handle on the right, scope on top
  const bolt = b.cyl(0.004, 0.05, { sides: 5, bevel: 0.001 });
  bolt.rotZ(Math.PI / 2).move(0.03, 0.07, ax);
  const knob = b.sphere(0.008, { sides: 6, rings: 4 });
  knob.move(0.055, 0.07, ax + 0.002);
  if (lod === 0) {
    const scope = b.cyl(0.013, 0.26, { sides, bevel: 0.003 });
    scope.move(0, 0.13, ax - 0.042);
    const bell = b.cyl(0.02, 0.05, { sides, r2: 0.014, bevel: 0.003 });
    bell.move(0, 0.27, ax - 0.042);
    for (const y of [0.07, 0.19]) {
      const ring = b.box(0.012, 0.012, 0.03, { bevel: 0.002 });
      ring.move(0, y, ax - 0.026);
    }
    b.ink({ color: hex(0x241c16), mat: MAT.CLOTH, wear: 0.6, snow: 0.3 });
    // sling hanging under the stock
    const sling = b.strap([[0, -0.2, 0.06], [0, -0.05, 0.1], [0, 0.15, 0.09], [0, 0.42, ax + 0.03]], 0.022, 0.003, { up: [1, 0, 0] });
    void sling;
  }
  b.ink({ color: hex(0x101010), mat: MAT.RUBBER, wear: 0.4, snow: 0.3 });
  const pad = b.box(0.042, 0.02, 0.125, { bevel: 0.006 });
  pad.move(0, -0.275, 0.032);
  const g = finish(b);
  return {
    tool: 'rifle',
    ...g,
    points: { fore: [0, 0.34, ax + 0.03], butt: [0, -0.28, 0.02], muzzle: [0, 0.82, ax - 0.002], bolt: [0.055, 0.07, ax], cheek: [0, -0.12, -0.055] },
  };
}

/** Hand-crank radio carried by its top handle in the left fist; the box hangs toward +Y. */
function radio(lod: number): Omit<ItemDef, 'hand'> {
  const b = new Builder(0x4ad);
  b.ink({ color: hex(0x3d4433), mat: MAT.PAINT, wear: 0.55, snow: 0.4 });
  const box = b.pillow(0.07, 0.13, 0.19, { round: 0.015, bulge: 0.002, seg: lod === 0 ? 2 : 1, ring: 1 });
  box.move(0, 0.1, -0.01);
  b.ink({ color: hex(0x1a1a1a), mat: MAT.RUBBER, wear: 0.4, snow: 0.2 });
  const handle = b.cyl(0.012, 0.12, { sides: lod === 0 ? 8 : 5, bevel: 0.003 });
  handle.rotX(Math.PI / 2).move(0, 0.0, -0.01);
  for (const z of [-0.07, 0.05]) {
    const post = b.box(0.02, 0.035, 0.016, { bevel: 0.003 });
    post.move(0, 0.022, z);
  }
  // speaker grille and dial on the front (-X faces the holder's right... keep it simple: +X face)
  b.ink({ color: hex(0x202320), mat: MAT.METAL, wear: 0.3, snow: 0.1 });
  const grille = b.box(0.004, 0.07, 0.09, { bevel: 0.001 });
  grille.move(0.036, 0.11, -0.04);
  b.ink({ color: hex(0xb8a77a), mat: MAT.PLASTIC, wear: 0.4, snow: 0.1 });
  const dial = b.cyl(0.016, 0.006, { sides: 10, bevel: 0.002 });
  dial.rotZ(Math.PI / 2).move(0.037, 0.12, 0.045);
  // the crank: arm on the far end (+Z), knob sticking out to the side
  b.ink({ color: hex(0x1d1d1d), mat: MAT.METAL, wear: 0.5, snow: 0.2 });
  const arm = b.box(0.008, 0.06, 0.012, { bevel: 0.002 });
  arm.move(-0.045, 0.1 - 0.025, 0.083);
  const knob = b.cyl(0.008, 0.035, { sides: 6, bevel: 0.002 });
  knob.rotZ(Math.PI / 2).move(-0.058, 0.07, 0.083);
  const g = finish(b);
  return { tool: 'radio', ...g, points: { crankAxle: [-0.04, 0.1, 0.083], crankKnob: [-0.065, 0.07, 0.083] } };
}

type Tool = Exclude<ToolId, 'hands'>;
/** Which hand holds each tool: 1 right, -1 left. */
export const ITEM_HAND: Record<Tool, 1 | -1> = { axe: 1, flashlight: 1, flaregun: 1, rifle: 1, radio: -1 };
/** Named points of each tool in item space (the same the builders use). */
export const ITEM_POINTS: Record<Tool, Record<string, V3>> = {
  axe: { end: [0, -0.004, 0.22], head: [0, 0.02, -0.45], edge: [0, 0.09, -0.45] },
  flashlight: { lamp: [0, 0, -0.16], tail: [0, 0, 0.1] },
  flaregun: { muzzle: [0, 0.2, -0.082] },
  rifle: { fore: [0, 0.34, -0.02], butt: [0, -0.28, 0.02], muzzle: [0, 0.82, -0.052], bolt: [0.055, 0.07, -0.05], cheek: [0, -0.12, -0.055] },
  radio: { crankAxle: [-0.04, 0.1, 0.083], crankKnob: [-0.065, 0.07, 0.083] },
};

const BUILDERS: Record<Exclude<ToolId, 'hands'>, { hand: 'R' | 'L'; fn: (lod: number) => Omit<ItemDef, 'hand'> }> = {
  axe: { hand: 'R', fn: axe },
  flashlight: { hand: 'R', fn: flashlight },
  flaregun: { hand: 'R', fn: flaregun },
  rifle: { hand: 'R', fn: rifle },
  radio: { hand: 'L', fn: radio },
};

export const TOOLS: Exclude<ToolId, 'hands'>[] = ['axe', 'flashlight', 'flaregun', 'rifle', 'radio'];

const cache = new Map<string, ItemDef>();
/** An item in ITEM space (cached). */
export function getItem(tool: Exclude<ToolId, 'hands'>, lod = 0): ItemDef {
  const key = tool + lod;
  let d = cache.get(key);
  if (!d) {
    const spec = BUILDERS[tool];
    d = { ...spec.fn(lod), hand: spec.hand };
    cache.set(key, d);
  }
  return d;
}

// ------------------------------------------------------------------------------------------
// Grip: item space -> a hand's bind space
// ------------------------------------------------------------------------------------------

/** The fist centre in bind (model) space, and the rotation from item axes to the hand's bind axes. */
export function gripBind(side: 1 | -1): { at: THREE.Vector3; rot: THREE.Quaternion } {
  const w = PLAYER_BIND.wrist(side);
  const d = PLAYER_BIND.armDir(side);
  const inward = [-side * Math.cos(A_POSE), -Math.sin(A_POSE), 0];
  const at = new THREE.Vector3(w[0] + d[0] * 0.085 + inward[0] * 0.03, w[1] + d[1] * 0.085 + inward[1] * 0.03, w[2]);
  // item +Y (knuckles) -> arm direction, item -Z (thumb) stays -Z
  const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side > 0 ? Math.PI + A_POSE : Math.PI - A_POSE);
  return { at, rot };
}

/** The item's geometry moved into its hand's bind space, bound rigidly to that hand (aSkin). */
export function itemGeometry(def: ItemDef): THREE.BufferGeometry {
  const side = def.hand === 'R' ? 1 : -1;
  const { at, rot } = gripBind(side);
  const g = def.geometry.clone();
  const m = new THREE.Matrix4().compose(at, rot, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  const n = g.getAttribute('position').count;
  const skin = new Uint8Array(n * 4);
  const bone = side > 0 ? PB.handR : PB.handL;
  for (let i = 0; i < n; i++) {
    skin[i * 4] = bone;
    skin[i * 4 + 1] = bone;
    skin[i * 4 + 2] = 255;
  }
  g.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4, true));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.6);
  return g;
}
