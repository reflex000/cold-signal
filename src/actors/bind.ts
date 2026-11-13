// Skin binding for figures built with the KIT Builder. Each part is tagged with a CHAIN id (the bones
// it may follow), carried through Builder.build() in the part's sway-stiffness channel (aEnv.w: the
// figures replace KIT's vertex stage, so sway is unused), and with a paint CLASS in its sway-length
// channel (aEnv.y: 1 = parka cloth that takes the slot colour, ...). After build() every vertex gets
// two bones and a weight: the chain is cut by planes through its joints, each perpendicular to the
// bone that starts there; a vertex belongs to the bone between the planes around it and blends
// across a plane within `blend` metres. A one-bone chain binds rigidly (mitts, boots, the pack). A
// chain may bring its own function (the parka hem follows the thighs a little).
import * as THREE from 'three/webgpu';
import type { Part } from '../models/kit';
import type { SkelDef } from './rig';

export interface SkinOut {
  b0: number;
  b1: number;
  /** Weight of b0 (b1 gets 1 - w0). */
  w0: number;
}

export interface ChainSpec {
  /** Bones from root to tip. One bone: rigid. */
  bones: number[];
  /** Half-width of the blend across each joint plane, metres. */
  blend?: number;
  /** Custom binding (model-space bind position). */
  fn?: (x: number, y: number, z: number, out: SkinOut) => void;
}

/** Tag a part (and everything later merged into it) with a chain id. */
export function tag<T extends Part>(part: T, chain: number): T {
  part.st.fill(chain / 255);
  return part;
}

/** Give a part a paint class (0..255), read back as BoundMesh.cls. */
export function klass<T extends Part>(part: T, cls: number): T {
  part.sl.fill(cls / 100);
  return part;
}

const sstep = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Two-bone weights of point (x, y, z) along a chain. */
export function chainWeights(def: SkelDef, chain: ChainSpec, x: number, y: number, z: number, out: SkinOut): void {
  const bones = chain.bones;
  if (chain.fn) {
    chain.fn(x, y, z, out);
    return;
  }
  if (bones.length === 1) {
    out.b0 = out.b1 = bones[0];
    out.w0 = 1;
    return;
  }
  const B = def.bind, T = def.tail;
  const blend = chain.blend ?? 0.05;
  let seg = 0;
  let nearK = -1, nearS = Infinity;
  for (let k = 1; k < bones.length; k++) {
    const b = bones[k];
    let ax = T[b * 3] - B[b * 3], ay = T[b * 3 + 1] - B[b * 3 + 1], az = T[b * 3 + 2] - B[b * 3 + 2];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    const s = (x - B[b * 3]) * ax + (y - B[b * 3 + 1]) * ay + (z - B[b * 3 + 2]) * az;
    if (s > 0) seg = k;
    if (Math.abs(s) < Math.abs(nearS)) {
      nearS = s;
      nearK = k;
    }
  }
  if (nearK > 0 && Math.abs(nearS) < blend) {
    out.b0 = bones[nearK];
    out.b1 = bones[nearK - 1];
    out.w0 = sstep(-blend, blend, nearS);
    return;
  }
  out.b0 = out.b1 = bones[seg];
  out.w0 = 1;
}

/**
 * Add aSkin to a geometry from Builder.build(), reading each vertex's chain id from aEnv.w and its
 * paint class from aEnv.y, then clearing both (aEnv.x snow exposure and aEnv.z snow push stay).
 * Returns the per-vertex classes.
 */
export function bindGeometry(geo: THREE.BufferGeometry, def: SkelDef, chains: ChainSpec[]): Uint8Array {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const env = geo.getAttribute('aEnv') as THREE.BufferAttribute;
  const P = pos.array as Float32Array;
  const E = env.array as Uint8Array;
  const n = pos.count;
  const skin = new Uint8Array(n * 4);
  const cls = new Uint8Array(n);
  const o: SkinOut = { b0: 0, b1: 0, w0: 1 };
  for (let i = 0; i < n; i++) {
    const id = E[i * 4 + 3];
    const chain = chains[id] ?? chains[0];
    chainWeights(def, chain, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], o);
    // the larger weight first: the shader blends mix(b1, b0, w0)
    if (o.w0 < 0.5) {
      const t = o.b0;
      o.b0 = o.b1;
      o.b1 = t;
      o.w0 = 1 - o.w0;
    }
    skin[i * 4] = o.b0;
    skin[i * 4 + 1] = o.b1;
    skin[i * 4 + 2] = Math.round(o.w0 * 255);
    cls[i] = E[i * 4 + 1];
    skin[i * 4 + 3] = cls[i];
    E[i * 4 + 1] = 0;
    E[i * 4 + 3] = 0;
  }
  geo.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4, true));
  env.needsUpdate = true;
  return cls;
}

/**
 * A copy of `geo` that shares every attribute and the index, with its own colour attribute made by
 * `paint(i, rgbLinear)` (rgbLinear holds the vertex's linear albedo; change it in place).
 */
export function recolor(geo: THREE.BufferGeometry, paint: (i: number, rgb: number[]) => void): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) out.setAttribute(name, geo.getAttribute(name));
  out.setIndex(geo.getIndex());
  const src = geo.getAttribute('color') as THREE.BufferAttribute;
  const S = src.array as Uint8Array;
  const C = new Uint8Array(S.length);
  const rgb = [0, 0, 0];
  for (let i = 0; i < src.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = S[i * 4 + k] / 255;
      rgb[k] = v * v;
    }
    paint(i, rgb);
    for (let k = 0; k < 3; k++) C[i * 4 + k] = Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(0, rgb[k])) * 255)));
    C[i * 4 + 3] = S[i * 4 + 3];
  }
  out.setAttribute('color', new THREE.BufferAttribute(C, 4, true));
  out.boundingBox = geo.boundingBox;
  out.boundingSphere = geo.boundingSphere;
  return out;
}
