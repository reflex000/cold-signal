// The local player's arms in first person: parka sleeves (the slot colour, quilted), expedition
// mitts (black nylon backs, brown leather palms, a gauntlet over the sleeve with a cinch cord, a
// wrist strap, a separate thumb) matching FIGURES' third-person figure. Built with the KIT Builder
// and drawn as ONE THREE.SkinnedMesh (14 bones, two per vertex) with the viewmodel material.
//
// BIND SPACE: both arms straight along -Z from a shoulder at the origin, overlapping; the left arm is
// the right arm mirrored in x. Bones per arm: upper, foreA (elbow, follows the upper arm's roll),
// foreB (mid forearm, follows the hand's roll: the forearm's twist is spread between the two), hand
// (the hand frame of tools/common.ts: origin = the fist centre, +Y wrist -> knuckles, -Z thumb side),
// f1 / f2 (the mitt's finger pocket, curling round a handle), thumb.
//
// ArmRig.solve() takes a shoulder and a hand frame per arm (camera space) and writes the bones:
// two-bone IK with an elbow pole, the swing-twist split above, finger curl and thumb.
import * as THREE from 'three/webgpu';
import { Builder, MAT, hex, mixRGB, type Part, type RGB, type V3 } from '../../models/kit';
import { loft, type Ring } from '../shape';

export const UPPER = 0.29;
export const FORE = 0.255;
/** The wrist in hand coordinates of a right hand (the left mirrors x): behind the handle, toward the back of the hand. */
const WRIST_H: V3 = [-0.03, -0.085, 0];
/** Finger-pocket hinges and the thumb root, right hand coordinates. */
const K1: V3 = [-0.036, 0.021, 0.002];
const K2: V3 = [-0.036, 0.064, 0.002];
const T0: V3 = [-0.027, -0.052, -0.038];
/** Thumb direction (right hand coordinates) open, and wrapped round a handle. */
const THUMB_OPEN = new THREE.Vector3(0.18, 0.82, -0.55).normalize();
const THUMB_GRIP = new THREE.Vector3(0.62, 0.72, -0.3).normalize();

export const BONES_PER_ARM = 7;
const B = { upper: 0, foreA: 1, foreB: 2, hand: 3, f1: 4, f2: 5, thumb: 6 } as const;

const MITT = hex(0x3b3e43);
const PALM = hex(0x56402f);
const FLEECE = hex(0x6a6862);
const STRAP = hex(0x26282b);

// chains (tagged into Part.st before build, read back from aEnv.w)
const CH_SLEEVE = 1, CH_GAUNT = 2, CH_MITT = 3, CH_THUMB = 4, CH_HAND = 5;

/** The bind rotation shared by every bone: X = -x, Y = -z (along the arm), Z = -y. */
const R_BIND = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0));
const F0 = new THREE.Vector3(-0.03, 0, -(UPPER + FORE + 0.085)); // right fist centre at bind
const M_HAND0 = new THREE.Matrix4().copy(R_BIND).setPosition(F0);

function tag<T extends Part>(p: T, chain: number): T {
  p.st.fill(chain / 255);
  return p;
}

const sstep = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Superellipse outline for loft rings. */
function rounded(hw: number, ht: number, e = 2.6): (a: number) => readonly [number, number] {
  return (a: number) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * hw, Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * ht];
  };
}

/** Sleeve radius along the arm (s metres from the shoulder): quilted baffles, narrowing to the cuff. */
function sleeveR(s: number): number {
  // (under the mitt's gauntlet, past s = 0.43, the sleeve narrows to the cuff so it never shows through)
  const base = (s < 0.12 ? 0.083 : s < 0.29 ? 0.083 - 0.008 * sstep(0.12, 0.29, s) : 0.075 - 0.013 * sstep(0.29, 0.53, s)) * (1 - 0.3 * sstep(0.43, 0.54, s));
  const baffle = Math.pow(Math.sin(((s - 0.02) / 0.066) * Math.PI), 2);
  return base * (1 - 0.045) + base * 0.045 * baffle;
}

/** The mitt (right hand) in hand coordinates: palm and finger pocket, thumb, gauntlet, straps. */
function buildMitt(b: Builder, detail: boolean): void {
  // ---- palm and finger pocket: one loft from the wrist to the fingertips ----
  const rows: [number, number, number, number, number][] = [
    // yh     hw      ht      cx       cz      (round at the wrist, under the gauntlet; flat palm)
    [-0.104, 0.042, 0.04, -0.03, 0.0],
    [-0.085, 0.045, 0.034, -0.0325, 0.001],
    [-0.058, 0.047, 0.0272, -0.0375, 0.003],
    [-0.025, 0.048, 0.0243, -0.04, 0.004],
    [0.0, 0.048, 0.0231, -0.0402, 0.004],
    [0.019, 0.047, 0.0211, -0.0392, 0.004],
    [0.034, 0.046, 0.0192, -0.0375, 0.004],
    [0.05, 0.0455, 0.0181, -0.0365, 0.004],
    [0.066, 0.0445, 0.0175, -0.036, 0.004],
    [0.081, 0.0428, 0.017, -0.036, 0.004],
    [0.095, 0.0392, 0.0161, -0.036, 0.004],
    [0.105, 0.0328, 0.0147, -0.036, 0.004],
    [0.1115, 0.0232, 0.0121, -0.036, 0.004],
  ];
  const rings: Ring[] = rows.map(([y, hw, ht, cx, cz]) => ({ c: [cx, y, cz] as V3, x: [0, 0, 1] as V3, y: [1, 0, 0] as V3, pt: rounded(hw, ht) }));
  b.ink({ color: MITT, mat: MAT.CLOTH, wear: 0.45, snow: 0, vary: 0, detailScale: 3.5, rough: 0.6 });
  const mitt = loft(b, rings, detail ? 22 : 14, { capStart: true, capEnd: true, bulge: 0.55 });
  // leather palm and finger fronts, a little worn at the knuckle crease
  mitt.each((v) => {
    const cx = v.y < 0.019 ? -0.04 : -0.036;
    if (v.x > cx + 0.006) {
      v.r = PALM[0]; v.g = PALM[1]; v.b = PALM[2];
      v.wear = 0.62 + 0.2 * sstep(0.01, 0.03, v.y) * sstep(0.05, 0.03, v.y);
    }
  });
  tag(mitt, CH_MITT);
  // ---- thumb pocket ----
  b.ink({ color: MITT, mat: MAT.CLOTH, wear: 0.5, snow: 0, vary: 0, detailScale: 3.5, rough: 0.6 });
  const thumb = b.capsule(0.0185, 0.085, { sides: detail ? 12 : 8, rings: detail ? 4 : 2 });
  thumb.warp((p) => {
    // flatter on the palm side, tapering to the tip
    const t = (p.y + 0.0425) / 0.085;
    const k = 1 - 0.18 * t;
    p.x *= k * 0.92;
    p.z *= k;
  });
  thumb.move(0, 0.03, 0).aim([THUMB_OPEN.x, THUMB_OPEN.y, THUMB_OPEN.z], T0);
  thumb.each((v) => {
    // leather on the inside of the thumb, fleece wipe on the back
    const dx = v.x - T0[0], dz = v.z - T0[2];
    if (dx > 0.008) { v.r = PALM[0]; v.g = PALM[1]; v.b = PALM[2]; v.wear = 0.6; }
    else if (dz < -0.012 && dx < 0.0) { v.r = FLEECE[0]; v.g = FLEECE[1]; v.b = FLEECE[2]; v.wear = 0.3; }
  });
  tag(thumb, CH_THUMB);
  // ---- gauntlet over the sleeve: outer wall, rolled binding at the opening, inner wall ----
  b.ink({ color: MITT, mat: MAT.CLOTH, wear: 0.4, snow: 0, vary: 0, detailScale: 3.5, rough: 0.62 });
  const gp: [number, number][] = [
    [0.044, -0.078], [0.049, -0.088], [0.056, -0.105], [0.0625, -0.135], [0.067, -0.17], [0.0705, -0.2], [0.072, -0.212],
    [0.0712, -0.219], [0.0685, -0.2202], [0.0668, -0.2155], [0.0655, -0.2],
  ];
  const gaunt = b.lathe(gp.map(([r, y]) => [r, -y] as [number, number]), { sides: detail ? 22 : 14, smooth: true });
  // made along +Y with y = -yh: turn so +Y becomes -yh, about the forearm axis (x = WRIST_H.x, z = 0)
  gaunt.rotX(Math.PI).move(WRIST_H[0], 0, 0);
  gaunt.each((v) => {
    v.wear = 0.35 + 0.3 * sstep(-0.2, -0.218, v.y);
  });
  tag(gaunt, CH_GAUNT);
  // the binding round the opening, darker and scuffed
  b.ink({ color: STRAP, mat: MAT.CLOTH, wear: 0.6, snow: 0 });
  tag(b.torus(0.0712, 0.0035, { sides: 5, segs: detail ? 24 : 14 }).move(WRIST_H[0], -0.2115, 0), CH_GAUNT);
  // cinch cord and its lock hanging on the outside (the back of the hand side)
  b.ink({ color: hex(0x2a2b2e), mat: MAT.PLASTIC, wear: 0.5, snow: 0, rough: 0.6 });
  tag(b.cyl(0.0045, 0.014, { sides: 8, bevel: 0.0012 }).rotX(0.4).move(WRIST_H[0] - 0.073, -0.195, 0.024), CH_GAUNT);
  b.ink({ color: hex(0x3b3c3f), mat: MAT.CLOTH, wear: 0.4, snow: 0 });
  tag(b.cable([WRIST_H[0] - 0.071, -0.204, 0.018], [WRIST_H[0] - 0.074, -0.19, 0.028], 0.004, 0.0013, { segs: 4, sides: 4 }), CH_GAUNT);
  // wrist strap across the back of the hand with its buckle
  b.ink({ color: STRAP, mat: MAT.CLOTH, wear: 0.55, snow: 0, rough: 0.9 });
  const strapPath: V3[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * 0.62 + (i / 8) * Math.PI * 0.76;
    strapPath.push([WRIST_H[0] + Math.cos(a) * 0.0565, -0.098, Math.sin(a) * 0.0565 * 1.08]);
  }
  tag(b.strap(strapPath, 0.016, 0.003, { up: [Math.cos(Math.PI * 0.62), 0, Math.sin(Math.PI * 0.62)] }), CH_HAND);
  b.ink({ color: hex(0x55575a), mat: MAT.METAL, wear: 0.45, snow: 0 });
  tag(b.box(0.004, 0.019, 0.014, { bevel: 0.0012 }).move(WRIST_H[0] - 0.0575, -0.098, 0.01), CH_HAND);
}

/** The right sleeve in bind space (along -Z from the shoulder at the origin). */
function buildSleeve(b: Builder, color: RGB, detail: boolean): void {
  const prof: [number, number][] = [[0, -0.06]];
  const n = detail ? 64 : 30;
  for (let i = 0; i <= n; i++) {
    const s = -0.055 + (0.6 * i) / n;
    prof.push([sleeveR(s), s]);
  }
  prof.push([0, 0.548]);
  b.ink({ color, mat: MAT.CLOTH, wear: 0.18, snow: 0, vary: 0, detailScale: 1.8 });
  const sleeve = b.lathe(prof, { sides: detail ? 22 : 14, smooth: true });
  // folds: slack cloth bunches toward the elbow and the cuff
  const seed = 17;
  sleeve.warp((p) => {
    const s = p.y;
    const a = Math.atan2(p.z, p.x);
    const slack = 0.35 + sstep(0.2, 0.3, s) * sstep(0.4, 0.3, s) * 0.9 + sstep(0.42, 0.52, s) * 0.6;
    const fold = Math.sin(a * 3 + s * 37 + seed) * Math.sin(s * 23 + a * 1.3) * 0.0022 * slack;
    const k = 1 + fold / Math.max(0.03, Math.hypot(p.x, p.z));
    p.x *= k;
    p.z *= k;
  });
  sleeve.each((v) => {
    // forearms wear and soil first
    v.wear = 0.12 + 0.2 * sstep(0.3, 0.5, v.y);
    const dirt = 0.12 * sstep(0.35, 0.5, v.y);
    v.r *= 1 - dirt; v.g *= 1 - dirt; v.b *= 1 - dirt;
  });
  // y (length) -> -z
  sleeve.rotX(-Math.PI / 2);
  tag(sleeve, CH_SLEEVE);
}

export interface ArmsGeometry {
  geometry: THREE.BufferGeometry;
  /** Bind matrices of the 14 bones (right arm 0..6, left 7..13). */
  bind: THREE.Matrix4[];
  tris: number;
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function bindMatrices(): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (const side of [1, -1]) {
    const sx = side;
    const at = (x: number, y: number, z: number) => new THREE.Matrix4().copy(R_BIND).setPosition(x * sx, y, z);
    const hand = (p: V3) => {
      _v.set(p[0], p[1], p[2]).applyMatrix4(M_HAND0);
      return at(_v.x, _v.y, _v.z);
    };
    out.push(at(0, 0, 0), at(0, 0, -UPPER), at(0, 0, -(UPPER + FORE * 0.5)), at(F0.x, F0.y, F0.z), hand(K1), hand(K2), hand(T0));
  }
  return out;
}

/**
 * Build both arms. `color` is the parka colour (linear RGB). `detail` false makes a lighter version.
 */
export function buildArms(color: RGB, detail = true): ArmsGeometry {
  const b = new Builder(0x4a2f);
  buildSleeve(b, color, detail);
  // the mitt is built in hand coordinates and placed at the bind hand frame
  const mitt = b.group(() => buildMitt(b, detail));
  mitt.apply(M_HAND0);
  const def = b.build({ ao: 0.85, ground: false, aoRadius: 0.025 });
  const src = def.geometry!;
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const env = src.getAttribute('aEnv') as THREE.BufferAttribute;
  const n = pos.count;
  const sIdx = new Uint16Array(n * 2 * 4);
  const sW = new Float32Array(n * 2 * 4);
  const invHand = new THREE.Matrix4().copy(M_HAND0).invert();
  const h = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const chain = Math.round(env.getW(i) * 255);
    _v.fromBufferAttribute(pos, i);
    let b0: number = B.hand, b1: number = B.hand, w0 = 1;
    if (chain === CH_SLEEVE) {
      const s = -_v.z;
      if (s < UPPER - 0.045) { b0 = b1 = B.upper; }
      else if (s < UPPER + 0.045) { b0 = B.upper; b1 = B.foreA; w0 = 1 - sstep(UPPER - 0.045, UPPER + 0.045, s); }
      else {
        // the twist spreads along the forearm
        b0 = B.foreA; b1 = B.foreB; w0 = 1 - sstep(UPPER + 0.03, UPPER + FORE * 0.62, s);
      }
    } else {
      h.copy(_v).applyMatrix4(invHand);
      if (chain === CH_GAUNT) { b0 = B.foreB; b1 = B.hand; w0 = 1 - sstep(-0.21, -0.105, h.y); }
      else if (chain === CH_MITT) {
        if (h.y < K1[1] - 0.012) { b0 = b1 = B.hand; }
        else if (h.y < K1[1] + 0.014) { b0 = B.hand; b1 = B.f1; w0 = 1 - sstep(K1[1] - 0.012, K1[1] + 0.014, h.y); }
        else if (h.y < K2[1] - 0.011) { b0 = b1 = B.f1; }
        else if (h.y < K2[1] + 0.011) { b0 = B.f1; b1 = B.f2; w0 = 1 - sstep(K2[1] - 0.011, K2[1] + 0.011, h.y); }
        else { b0 = b1 = B.f2; }
      } else if (chain === CH_THUMB) {
        const t = (h.x - T0[0]) * THUMB_OPEN.x + (h.y - T0[1]) * THUMB_OPEN.y + (h.z - T0[2]) * THUMB_OPEN.z;
        b0 = B.hand; b1 = B.thumb; w0 = 1 - sstep(0.0, 0.028, t);
      }
    }
    sIdx[i * 4] = b0; sIdx[i * 4 + 1] = b1;
    sW[i * 4] = w0; sW[i * 4 + 1] = 1 - w0;
  }
  // the left arm: the right one mirrored in x, on bones 7..13
  const geo = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'color', 'aDetail', 'aSurf'];
  for (const name of names) {
    const a = src.getAttribute(name) as THREE.BufferAttribute;
    const isz = a.itemSize;
    const Arr = a.array.constructor as new (len: number) => Float32Array | Uint8Array;
    const out = new Arr(n * 2 * isz);
    out.set(a.array as ArrayLike<number>, 0);
    out.set(a.array as ArrayLike<number>, n * isz);
    if (name === 'position' || name === 'normal') for (let i = 0; i < n; i++) out[(n + i) * isz] = -out[(n + i) * isz];
    if (name === 'aDetail') for (let i = 0; i < n; i++) out[(n + i) * isz] = -out[(n + i) * isz] + 3.7; // decorrelate the weave
    geo.setAttribute(name, new THREE.BufferAttribute(out, isz, a.normalized));
  }
  for (let i = 0; i < n; i++) {
    sIdx[(n + i) * 4] = sIdx[i * 4] + BONES_PER_ARM;
    sIdx[(n + i) * 4 + 1] = sIdx[i * 4 + 1] + BONES_PER_ARM;
    sW[(n + i) * 4] = sW[i * 4];
    sW[(n + i) * 4 + 1] = sW[i * 4 + 1];
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(sIdx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sW, 4));
  const idx = src.getIndex()!;
  const m = idx.count;
  const index = new Uint32Array(m * 2);
  for (let i = 0; i < m; i++) index[i] = idx.getX(i);
  // mirrored triangles: swap two corners to keep them facing out
  for (let i = 0; i < m; i += 3) {
    index[m + i] = idx.getX(i) + n;
    index[m + i + 1] = idx.getX(i + 2) + n;
    index[m + i + 2] = idx.getX(i + 1) + n;
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.4), 2);
  return { geometry: geo, bind: bindMatrices(), tris: def.tris * 2 };
}

/** Swap the parka colour of an arms geometry built with `from` (slot change) in place. */
export function recolorArms(geo: THREE.BufferGeometry, from: RGB, to: RGB): void {
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const arr = col.array as Uint8Array;
  const f = from.map((c) => Math.round(Math.sqrt(c) * 255));
  for (let i = 0; i < col.count; i++) {
    const r = arr[i * 4], g = arr[i * 4 + 1], bb = arr[i * 4 + 2];
    // parka cloth vertices: same hue as `from` (they were painted with it, then darkened by dirt)
    const k = f[0] > 0 ? r / f[0] : 0;
    if (k > 0.6 && k < 1.15 && Math.abs(g - f[1] * k) < 6 && Math.abs(bb - f[2] * k) < 6) {
      arr[i * 4] = Math.min(255, Math.round(Math.sqrt(to[0]) * 255 * k));
      arr[i * 4 + 1] = Math.min(255, Math.round(Math.sqrt(to[1]) * 255 * k));
      arr[i * 4 + 2] = Math.min(255, Math.round(Math.sqrt(to[2]) * 255 * k));
    }
  }
  col.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------
// The rig: IK and bones
// ------------------------------------------------------------------------------------------

export interface HandPose {
  /** Fist centre and hand frame, camera space. */
  pos: THREE.Vector3;
  q: THREE.Quaternion;
  /** 0 open flat .. 1 wrapped round a 35 mm handle. */
  curl: number;
  /** 0 thumb out .. 1 thumb wrapped. */
  thumb: number;
  /** Shoulder, camera space. */
  shoulder: THREE.Vector3;
  /** Where the elbow points (camera space direction). */
  pole: THREE.Vector3;
}

export function makeHandPose(): HandPose {
  return { pos: new THREE.Vector3(), q: new THREE.Quaternion(), curl: 1, thumb: 1, shoulder: new THREE.Vector3(), pole: new THREE.Vector3(1, -1, 0) };
}

const _S = new THREE.Vector3();
const _W = new THREE.Vector3();
const _E = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _x = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qUp = new THREE.Quaternion();
const _qh = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const Y = new THREE.Vector3(0, 1, 0);
const ZAX = new THREE.Vector3(0, 0, 1);
const _t = new THREE.Vector3();

/** Rotation that turns R's +Y onto `dir` by the shortest arc, applied to R (the twist about Y is kept). */
function swing(r: THREE.Quaternion, dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _t.copy(Y).applyQuaternion(r);
  _q2.setFromUnitVectors(_t, dir);
  return out.copy(_q2).multiply(r);
}

/** Bone frames of both arms; write them into a skeleton's bones (matrix = camera space). */
export class ArmRig {
  /** World (camera-space) matrices, 14. */
  readonly mats: THREE.Matrix4[] = [];
  /** Elbow and wrist positions of the last solve, per side (dev / debug). */
  readonly elbow = [new THREE.Vector3(), new THREE.Vector3()];

  constructor() {
    for (let i = 0; i < BONES_PER_ARM * 2; i++) this.mats.push(new THREE.Matrix4());
  }

  /** Solve one arm. side 1 right, -1 left. */
  solve(side: 1 | -1, hp: HandPose): void {
    const o = side > 0 ? 0 : BONES_PER_ARM;
    const sx = side;
    _qh.copy(hp.q);
    // wrist from the hand frame
    _W.set(WRIST_H[0] * sx, WRIST_H[1], WRIST_H[2]).applyQuaternion(_qh).add(hp.pos);
    _S.copy(hp.shoulder);
    _d.subVectors(_W, _S);
    let dist = _d.length();
    const reach = UPPER + FORE - 0.004;
    if (dist > reach) {
      // the shoulder reaches forward rather than the hand letting go
      _S.addScaledVector(_d, (dist - reach) / dist);
      _d.subVectors(_W, _S);
      dist = reach;
    }
    dist = Math.max(dist, Math.abs(UPPER - FORE) + 0.01);
    _d.normalize();
    const a = (UPPER * UPPER - FORE * FORE + dist * dist) / (2 * dist);
    const hgt = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
    _p.copy(hp.pole).addScaledVector(_d, -hp.pole.dot(_d));
    if (_p.lengthSq() < 1e-8) _p.set(sx, -1, 0).addScaledVector(_d, -(_d.x * sx - _d.y));
    _p.normalize();
    _E.copy(_S).addScaledVector(_d, a).addScaledVector(_p, hgt);
    this.elbow[side > 0 ? 0 : 1].copy(_E);

    // upper: +Y along the bone, +Z toward camera-down projected (a stable roll)
    _y.subVectors(_E, _S).normalize();
    _z.set(0, -1, 0).addScaledVector(_y, _y.y);
    if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    _z.normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x, _y, _z);
    _qUp.setFromRotationMatrix(_m);
    this.mats[o + B.upper].compose(_S, _qUp, _one);
    // forearm direction
    _y.subVectors(_W, _E).normalize();
    swing(_qUp, _y, _q);
    this.mats[o + B.foreA].compose(_E, _q, _one);
    swing(_qh, _y, _q);
    _t.addVectors(_E, _W).multiplyScalar(0.5);
    this.mats[o + B.foreB].compose(_t, _q, _one);
    // hand
    this.mats[o + B.hand].compose(hp.pos, _qh, _one);
    // finger pocket: two hinges about the hand's Z (toward the palm: -angle for a right hand)
    const c = Math.max(0, Math.min(1.2, hp.curl));
    const a1 = c * 1.72, a2 = c * 1.62;
    _t.set(K1[0] * sx, K1[1], K1[2]).applyQuaternion(_qh).add(hp.pos);
    _q.setFromAxisAngle(ZAX, -sx * a1);
    _q2.copy(_qh).multiply(_q);
    this.mats[o + B.f1].compose(_t, _q2, _one);
    _p.set((K2[0] - K1[0]) * sx, K2[1] - K1[1], K2[2] - K1[2]).applyQuaternion(_q2).add(_t);
    _q.setFromAxisAngle(ZAX, -sx * a2);
    _q2.multiply(_q);
    this.mats[o + B.f2].compose(_p, _q2, _one);
    // thumb: from open toward wrapped (directions mirrored for the left hand)
    const th = Math.max(0, Math.min(1, hp.thumb));
    _t.set(THUMB_OPEN.x * sx, THUMB_OPEN.y, THUMB_OPEN.z);
    _x.set(THUMB_GRIP.x * sx, THUMB_GRIP.y, THUMB_GRIP.z).lerp(_t, 1 - th).normalize();
    _q.setFromUnitVectors(_t, _x);
    _q2.copy(_qh).multiply(_q);
    _p.set(T0[0] * sx, T0[1], T0[2]).applyQuaternion(_qh).add(hp.pos);
    this.mats[o + B.thumb].compose(_p, _q2, _one);
  }

  /** Copy the solved matrices into skeleton bones (bone.matrix, parent = the camera-space root). */
  apply(bones: THREE.Bone[]): void {
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      bone.matrix.copy(this.mats[i]);
      bone.matrixWorldNeedsUpdate = true;
    }
  }
}

/** Mix two parka colours (for a slot colour that is not in the table). */
export function parkaMix(a: RGB, b: RGB, t: number): RGB {
  return mixRGB(a, b, t);
}
