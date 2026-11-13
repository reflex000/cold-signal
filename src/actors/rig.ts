// Skeletons and poses for the procedural figures. A skeleton is a list of joints in model space
// (bind pose: every bone's rotation is the identity, so a bone's frame at bind is the model frame).
// A pose holds every bone's WORLD rotation (quaternion) and world joint position; the animation code
// fills it by forward kinematics (local rotations down the hierarchy) and by two-bone IK (limbs),
// and writeRow() turns it into the 3x4 skinning matrices of one row of the shared bone texture:
//   M = [R | P - R * J0]   (J0 = bind joint position)   so   skinned = R * (v - J0) + P.
// Model space: metres, Y up, the figure faces -Z (yaw 0 = north), its right hand is +X.
// No allocation in the per-frame paths: scratch vectors live at module scope.
import * as THREE from 'three/webgpu';

export type V3 = readonly [number, number, number];

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** Joint (head of the bone) in model space at bind. */
  at: V3;
  /** End of the bone for skin binding (default: the first child's joint, else `at`). */
  tail?: V3;
}

export class SkelDef {
  readonly n: number;
  readonly names: string[];
  readonly parent: Int16Array;
  /** Joint positions at bind, xyz per bone. */
  readonly bind: Float32Array;
  /** Bone ends at bind (for binding the skin), xyz per bone. */
  readonly tail: Float32Array;
  readonly index: Record<string, number> = {};

  constructor(specs: BoneSpec[]) {
    this.n = specs.length;
    this.names = specs.map((s) => s.name);
    this.parent = new Int16Array(this.n);
    this.bind = new Float32Array(this.n * 3);
    this.tail = new Float32Array(this.n * 3);
    specs.forEach((s, i) => (this.index[s.name] = i));
    specs.forEach((s, i) => {
      const p = s.parent === null ? -1 : this.index[s.parent];
      if (p === undefined || p >= i) throw new Error(`rig: bone ${s.name} must come after its parent ${s.parent}`);
      this.parent[i] = p;
      this.bind.set(s.at, i * 3);
    });
    specs.forEach((s, i) => {
      let t: V3 | undefined = s.tail;
      if (!t) {
        const child = specs.findIndex((c) => c.parent === s.name);
        t = child >= 0 ? specs[child].at : s.at;
      }
      this.tail.set(t, i * 3);
    });
  }

  i(name: string): number {
    const k = this.index[name];
    if (k === undefined) throw new Error('rig: no bone ' + name);
    return k;
  }

  /** Bind offset of bone b from its parent's joint (model space = parent space at bind). */
  offset(b: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.parent[b];
    const B = this.bind;
    if (p < 0) return out.set(B[b * 3], B[b * 3 + 1], B[b * 3 + 2]);
    return out.set(B[b * 3] - B[p * 3], B[b * 3 + 1] - B[p * 3 + 1], B[b * 3 + 2] - B[p * 3 + 2]);
  }

  joint(b: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.bind[b * 3], this.bind[b * 3 + 1], this.bind[b * 3 + 2]);
  }

  /** Bind length of the bone (joint to tail). */
  length(b: number): number {
    const B = this.bind, T = this.tail;
    return Math.hypot(T[b * 3] - B[b * 3], T[b * 3 + 1] - B[b * 3 + 1], T[b * 3 + 2] - B[b * 3 + 2]);
  }
}

export class Pose {
  readonly q: THREE.Quaternion[];
  readonly p: THREE.Vector3[];
  /** Uniform size of the whole figure: bind offsets and the skin scale by it. */
  scale = 1;
  constructor(readonly def: SkelDef) {
    this.q = Array.from({ length: def.n }, () => new THREE.Quaternion());
    this.p = Array.from({ length: def.n }, () => new THREE.Vector3());
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** Forward kinematics for one bone: world = parent world * local; the joint rides on the parent. */
export function fk(pose: Pose, b: number, local: THREE.Quaternion): void {
  const def = pose.def;
  const p = def.parent[b];
  if (p < 0) {
    pose.q[b].copy(local);
    return;
  }
  def.offset(b, _v).multiplyScalar(pose.scale).applyQuaternion(pose.q[p]);
  pose.p[b].copy(pose.p[p]).add(_v);
  pose.q[b].multiplyQuaternions(pose.q[p], local);
}

/** Place bone b's joint on its parent (rotation set elsewhere). */
export function attach(pose: Pose, b: number): THREE.Vector3 {
  const def = pose.def;
  const p = def.parent[b];
  def.offset(b, _v).multiplyScalar(pose.scale).applyQuaternion(pose.q[p]);
  return pose.p[b].copy(pose.p[p]).add(_v);
}

/**
 * A bone frame for IK bones: y along the bone (joint -> tail), x the hinge axis it flexes about,
 * z = x cross y. The bind frame is fixed; the pose frame comes from the IK solution. The bone's
 * world rotation is F1 * F0^T.
 */
export class Hinge {
  private readonly inv0 = new THREE.Matrix4();
  constructor(def: SkelDef, b: number, hingeAxis: V3) {
    const y = new THREE.Vector3(def.tail[b * 3] - def.bind[b * 3], def.tail[b * 3 + 1] - def.bind[b * 3 + 1], def.tail[b * 3 + 2] - def.bind[b * 3 + 2]).normalize();
    const x = new THREE.Vector3(...hingeAxis);
    x.addScaledVector(y, -x.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    this.inv0.makeBasis(x, y, z).transpose();
  }
  /** World rotation that turns the bind frame into (x1 hinge, y1 bone direction); both unit, orthogonal. */
  rotation(out: THREE.Quaternion, x1: THREE.Vector3, y1: THREE.Vector3): THREE.Quaternion {
    _v3.crossVectors(x1, y1);
    _m.makeBasis(x1, y1, _v3);
    _m2.multiplyMatrices(_m, this.inv0);
    return out.setFromRotationMatrix(_m2);
  }
}

const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
/**
 * Two-bone IK. From root joint A toward target T with bone lengths l1, l2 and a pole direction (where
 * the middle joint should point). Writes the middle joint to outB and the hinge axis (normal of the
 * A-B-T plane, (B-A) x (T-B)) to outAxis. Returns the reach actually used (clamped).
 */
export function solveTwoBone(A: THREE.Vector3, T: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, outB: THREE.Vector3, outAxis: THREE.Vector3): number {
  _d.subVectors(T, A);
  let dist = _d.length();
  const lo = Math.abs(l1 - l2) + 1e-4, hi = (l1 + l2) * 0.9995;
  if (dist < 1e-6) _d.set(0, -1, 0);
  else _d.multiplyScalar(1 / dist);
  dist = Math.min(hi, Math.max(lo, dist));
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _pole.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_pole.lengthSq() < 1e-10) {
    // pole along the reach: pick anything perpendicular
    _pole.set(0, 0, -1).addScaledVector(_d, -_d.z);
    if (_pole.lengthSq() < 1e-10) _pole.set(1, 0, 0);
  }
  _pole.normalize();
  outB.copy(A).addScaledVector(_d, l1 * cosA).addScaledVector(_pole, l1 * sinA);
  // hinge axis: (B - A) x (T' - B), T' the clamped target
  _v.subVectors(outB, A);
  _v2.copy(A).addScaledVector(_d, dist).sub(outB);
  outAxis.crossVectors(_v, _v2);
  if (outAxis.lengthSq() < 1e-12) outAxis.crossVectors(_d, _pole);
  outAxis.normalize();
  return dist;
}

/** Quaternion from yaw (about Y), pitch (about X), roll (about Z), applied Y then X then Z. */
export function qYXZ(out: THREE.Quaternion, yaw: number, pitch: number, roll: number): THREE.Quaternion {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  const cz = Math.cos(roll / 2), sz = Math.sin(roll / 2);
  // q = qy * qx * qz
  const x = cy * sx * cz + sy * cx * sz;
  const y = sy * cx * cz - cy * sx * sz;
  const z = cy * cx * sz - sy * sx * cz;
  const w = cy * cx * cz + sy * sx * sz;
  return out.set(x, y, z, w);
}

/** Quaternion from rotations about X, then Y, then Z of the local frame (intrinsic X-Y-Z = q = qx * qy * qz). */
export function qXYZ(out: THREE.Quaternion, ax: number, ay: number, az: number): THREE.Quaternion {
  const cx = Math.cos(ax / 2), sx = Math.sin(ax / 2);
  const cy = Math.cos(ay / 2), sy = Math.sin(ay / 2);
  const cz = Math.cos(az / 2), sz = Math.sin(az / 2);
  const x = sx * cy * cz + cx * sy * sz;
  const y = cx * sy * cz - sx * cy * sz;
  const z = cx * cy * sz + sx * sy * cz;
  const w = cx * cy * cz - sx * sy * sz;
  return out.set(x, y, z, w);
}

export function qAxis(out: THREE.Quaternion, ax: number, ay: number, az: number, angle: number): THREE.Quaternion {
  const s = Math.sin(angle / 2);
  const l = Math.hypot(ax, ay, az) || 1;
  return out.set((ax / l) * s, (ay / l) * s, (az / l) * s, Math.cos(angle / 2));
}

/**
 * Rotation whose -Z axis looks along `fwd` and whose +Y leans toward `up` (both world).
 * Used for hands holding tools and feet set on a slope.
 */
export function qLook(out: THREE.Quaternion, fwd: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  _v.copy(fwd).normalize().negate(); // +Z axis
  _v2.crossVectors(up, _v);
  if (_v2.lengthSq() < 1e-10) _v2.set(1, 0, 0);
  _v2.normalize(); // +X
  _v3.crossVectors(_v, _v2); // +Y
  _m.makeBasis(_v2, _v3, _v);
  return out.setFromRotationMatrix(_m);
}

/** Rotation taking unit vector a onto unit vector b (shortest arc). */
export function qFromTo(out: THREE.Quaternion, a: THREE.Vector3, b: THREE.Vector3): THREE.Quaternion {
  return out.setFromUnitVectors(a, b);
}

/**
 * Write one row of the bone texture: for each bone the 3x4 skinning matrix as three RGBA texels
 * (matrix rows). `rowTexels` is the texture width.
 */
export function writeRow(pose: Pose, data: Float32Array, row: number, rowTexels: number): void {
  const def = pose.def;
  const B = def.bind;
  const k = pose.scale;
  let o = row * rowTexels * 4;
  for (let b = 0; b < def.n; b++, o += 12) {
    const q = pose.q[b];
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const m00 = (1 - (yy + zz)) * k, m01 = (xy - wz) * k, m02 = (xz + wy) * k;
    const m10 = (xy + wz) * k, m11 = (1 - (xx + zz)) * k, m12 = (yz - wx) * k;
    const m20 = (xz - wy) * k, m21 = (yz + wx) * k, m22 = (1 - (xx + yy)) * k;
    const jx = B[b * 3], jy = B[b * 3 + 1], jz = B[b * 3 + 2];
    const p = pose.p[b];
    data[o] = m00; data[o + 1] = m01; data[o + 2] = m02; data[o + 3] = p.x - (m00 * jx + m01 * jy + m02 * jz);
    data[o + 4] = m10; data[o + 5] = m11; data[o + 6] = m12; data[o + 7] = p.y - (m10 * jx + m11 * jy + m12 * jz);
    data[o + 8] = m20; data[o + 9] = m21; data[o + 10] = m22; data[o + 11] = p.z - (m20 * jx + m21 * jy + m22 * jz);
  }
}

/** World position of a point given in bind (model) space, carried by bone b of the pose. */
export function carried(pose: Pose, b: number, bx: number, by: number, bz: number, out: THREE.Vector3): THREE.Vector3 {
  const B = pose.def.bind;
  out.set(bx - B[b * 3], by - B[b * 3 + 1], bz - B[b * 3 + 2]).multiplyScalar(pose.scale).applyQuaternion(pose.q[b]);
  return out.add(pose.p[b]);
}

/** Copy one pose into another of the same skeleton. */
export function copyPose(dst: Pose, src: Pose): void {
  for (let i = 0; i < src.def.n; i++) {
    dst.q[i].copy(src.q[i]);
    dst.p[i].copy(src.p[i]);
  }
}

export const tmpQ = _q;
