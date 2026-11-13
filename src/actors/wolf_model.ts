// THE WOLF: a large grey timber wolf in winter coat, built in code with the KIT Builder (fur
// material) and skinned to a 32-bone skeleton: spine, neck, head with a jaw that opens, ears, a
// four-bone tail, and legs with shoulder blades (front) and the dog's three-segment hind leg.
// The coat's shaggy outline is in the geometry (tufted rings: neck ruff, cheeks, belly fringe,
// trousers, brush of the tail); the strands are the KIT fur shading. Colour comes from a body-part
// class per vertex and its position: darker saddle, pale belly and legs, a face mask, a black
// tail tip; coatGeometry() paints one of four coats on shared geometry. Eyes are a separate tiny
// mesh (eyeGeometry, the eye-shine material).
//
// Model space: metres, Y up, the wolf faces -Z, standing on y = 0. Shoulder height ~0.8 m.
import * as THREE from 'three/webgpu';
import { Builder, MAT, hex, mixRGB, type RGB, type V3 } from '../models/kit';
import { bindGeometry, klass, recolor, tag, type ChainSpec, type SkinOut } from './bind';
import { SkelDef } from './rig';
import { frame, hash, loft, noise2, norm, smooth, sub, type Ring } from './shape';

// ------------------------------------------------------------------------------------------
// Skeleton
// ------------------------------------------------------------------------------------------

const mir = (p: V3): V3 => [-p[0], p[1], p[2]];
const SHOULDER_L: V3 = [-0.095, 0.58, -0.32];
const ELBOW_L: V3 = [-0.09, 0.4, -0.25];
const WRIST_L: V3 = [-0.085, 0.115, -0.27];
const FPAW_L: V3 = [-0.085, 0.035, -0.3];
const FTIP_L: V3 = [-0.085, 0.012, -0.355];
const HIP_L: V3 = [-0.085, 0.7, 0.4];
const KNEE_L: V3 = [-0.09, 0.46, 0.29];
const HOCK_L: V3 = [-0.085, 0.22, 0.47];
const HPAW_L: V3 = [-0.08, 0.035, 0.43];
const HTIP_L: V3 = [-0.08, 0.012, 0.375];
const HEAD_AT: V3 = [0, 0.96, -0.62];
const NOSE: V3 = [0, 0.905, -0.92];

export const WOLF_SKEL = new SkelDef([
  { name: 'pelvis', parent: null, at: [0, 0.74, 0.4] },
  { name: 'spine1', parent: 'pelvis', at: [0, 0.76, 0.18] },
  { name: 'spine2', parent: 'spine1', at: [0, 0.77, -0.04] },
  { name: 'chest', parent: 'spine2', at: [0, 0.76, -0.24] },
  { name: 'neck1', parent: 'chest', at: [0, 0.78, -0.38] },
  { name: 'neck2', parent: 'neck1', at: [0, 0.88, -0.52] },
  { name: 'head', parent: 'neck2', at: HEAD_AT, tail: NOSE },
  { name: 'jaw', parent: 'head', at: [0, 0.935, -0.66], tail: [0, 0.885, -0.885] },
  { name: 'earL', parent: 'head', at: [-0.05, 1.035, -0.645], tail: [-0.068, 1.135, -0.655] },
  { name: 'earR', parent: 'head', at: [0.05, 1.035, -0.645], tail: [0.068, 1.135, -0.655] },
  { name: 'tail1', parent: 'pelvis', at: [0, 0.73, 0.55] },
  { name: 'tail2', parent: 'tail1', at: [0, 0.65, 0.66] },
  { name: 'tail3', parent: 'tail2', at: [0, 0.55, 0.75] },
  { name: 'tail4', parent: 'tail3', at: [0, 0.45, 0.82], tail: [0, 0.35, 0.87] },
  { name: 'scapL', parent: 'chest', at: [-0.065, 0.79, -0.24], tail: SHOULDER_L },
  { name: 'fUpL', parent: 'scapL', at: SHOULDER_L, tail: ELBOW_L },
  { name: 'fLowL', parent: 'fUpL', at: ELBOW_L, tail: WRIST_L },
  { name: 'fFootL', parent: 'fLowL', at: WRIST_L, tail: FPAW_L },
  { name: 'fToeL', parent: 'fFootL', at: FPAW_L, tail: FTIP_L },
  { name: 'scapR', parent: 'chest', at: [0.065, 0.79, -0.24], tail: mir(SHOULDER_L) },
  { name: 'fUpR', parent: 'scapR', at: mir(SHOULDER_L), tail: mir(ELBOW_L) },
  { name: 'fLowR', parent: 'fUpR', at: mir(ELBOW_L), tail: mir(WRIST_L) },
  { name: 'fFootR', parent: 'fLowR', at: mir(WRIST_L), tail: mir(FPAW_L) },
  { name: 'fToeR', parent: 'fFootR', at: mir(FPAW_L), tail: mir(FTIP_L) },
  { name: 'thighL', parent: 'pelvis', at: HIP_L, tail: KNEE_L },
  { name: 'shankL', parent: 'thighL', at: KNEE_L, tail: HOCK_L },
  { name: 'metaL', parent: 'shankL', at: HOCK_L, tail: HPAW_L },
  { name: 'toeL', parent: 'metaL', at: HPAW_L, tail: HTIP_L },
  { name: 'thighR', parent: 'pelvis', at: mir(HIP_L), tail: mir(KNEE_L) },
  { name: 'shankR', parent: 'thighR', at: mir(KNEE_L), tail: mir(HOCK_L) },
  { name: 'metaR', parent: 'shankR', at: mir(HOCK_L), tail: mir(HPAW_L) },
  { name: 'toeR', parent: 'metaR', at: mir(HPAW_L), tail: mir(HTIP_L) },
]);

const S = WOLF_SKEL;
export const WB = {
  pelvis: S.i('pelvis'), spine1: S.i('spine1'), spine2: S.i('spine2'), chest: S.i('chest'),
  neck1: S.i('neck1'), neck2: S.i('neck2'), head: S.i('head'), jaw: S.i('jaw'), earL: S.i('earL'), earR: S.i('earR'),
  tail1: S.i('tail1'), tail2: S.i('tail2'), tail3: S.i('tail3'), tail4: S.i('tail4'),
  scapL: S.i('scapL'), fUpL: S.i('fUpL'), fLowL: S.i('fLowL'), fFootL: S.i('fFootL'), fToeL: S.i('fToeL'),
  scapR: S.i('scapR'), fUpR: S.i('fUpR'), fLowR: S.i('fLowR'), fFootR: S.i('fFootR'), fToeR: S.i('fToeR'),
  thighL: S.i('thighL'), shankL: S.i('shankL'), metaL: S.i('metaL'), toeL: S.i('toeL'),
  thighR: S.i('thighR'), shankR: S.i('shankR'), metaR: S.i('metaR'), toeR: S.i('toeR'),
};

// ------------------------------------------------------------------------------------------
// Head outline (shared by the mesh and the eyes, so the eyes sit on the skull)
// ------------------------------------------------------------------------------------------

const HEAD0: V3 = [0, 0.99, -0.585];
const HEAD_DIR = norm(sub([0, 0.918, -0.918], HEAD0));
const HEAD_LEN = 0.342;
/** Head ring at arc length s from the back of the skull: half width, half height above / below. */
function headSize(s: number): [number, number, number] {
  //        s     hw     hT     hB
  const T = [
    [0.0, 0.04, 0.045, 0.045],
    [0.03, 0.074, 0.064, 0.07],
    [0.075, 0.084, 0.068, 0.076],
    [0.12, 0.066, 0.054, 0.066],
    [0.16, 0.052, 0.045, 0.058],
    [0.21, 0.041, 0.038, 0.046],
    [0.27, 0.034, 0.032, 0.036],
    [0.31, 0.029, 0.027, 0.03],
    [0.342, 0.012, 0.012, 0.012],
  ];
  if (s <= 0) return [T[0][1], T[0][2], T[0][3]];
  for (let i = 1; i < T.length; i++) {
    if (s <= T[i][0]) {
      const a = T[i - 1], b = T[i];
      const t = (s - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  const l = T[T.length - 1];
  return [l[1], l[2], l[3]];
}
const EYE_S = 0.142;
const EYE_A = 0.62; // angle up from the side
/** Eye centre (bind, model space) on side -1 / 1, and the direction it looks. */
export function eyeBind(side: number): { at: V3; dir: V3 } {
  const [hw, hT] = headSize(EYE_S);
  const c: V3 = [HEAD0[0] + HEAD_DIR[0] * EYE_S, HEAD0[1] + HEAD_DIR[1] * EYE_S, HEAD0[2] + HEAD_DIR[2] * EYE_S];
  const f = frame(HEAD_DIR, [1, 0, 0]);
  const u = Math.cos(EYE_A) * hw * 0.93, v = Math.sin(EYE_A) * hT * 0.93;
  const at: V3 = [c[0] + f.x[0] * u * side + f.y[0] * v, c[1] + f.x[1] * u * side + f.y[1] * v, c[2] + f.x[2] * u * side + f.y[2] * v];
  // wolves' eyes look forward and a little out
  const dir = norm([side * 0.35, 0.1, -1]);
  return { at, dir };
}

// ------------------------------------------------------------------------------------------
// Binding
// ------------------------------------------------------------------------------------------

const C = {
  BODY: 0, NECK: 1, HEAD: 2, JAW: 3, CHEEK: 4, EAR_L: 5, EAR_R: 6, TAIL: 7,
  FRONT_L: 8, FRONT_R: 9, HIND_L: 10, HIND_R: 11, PAW_FL: 12, PAW_FR: 13, PAW_HL: 14, PAW_HR: 15,
} as const;

function plain(bones: number[], blend: number, x: number, y: number, z: number, out: SkinOut): void {
  const B = S.bind, T = S.tail;
  let seg = 0, nearK = -1, nearS = Infinity;
  for (let k = 1; k < bones.length; k++) {
    const b = bones[k];
    let ax = T[b * 3] - B[b * 3], ay = T[b * 3 + 1] - B[b * 3 + 1], az = T[b * 3 + 2] - B[b * 3 + 2];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    const s = (x - B[b * 3]) * ax + (y - B[b * 3 + 1]) * ay + (z - B[b * 3 + 2]) * az;
    if (s > 0) seg = k;
    if (Math.abs(s) < Math.abs(nearS)) { nearS = s; nearK = k; }
  }
  if (nearK > 0 && Math.abs(nearS) < blend) {
    out.b0 = bones[nearK];
    out.b1 = bones[nearK - 1];
    out.w0 = smooth(-blend, blend, nearS);
    return;
  }
  out.b0 = out.b1 = bones[seg];
  out.w0 = 1;
}

const BODY_BONES = [WB.pelvis, WB.spine1, WB.spine2, WB.chest];
/** Body: the spine; the haunches follow the thighs and the shoulder fronts the upper arms. */
function bodyFn(x: number, y: number, z: number, out: SkinOut): void {
  plain(BODY_BONES, 0.09, x, y, z, out);
  const side = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // haunch: below the spine, outside, around the hip joint
  const dh = Math.hypot(ax - 0.085, (y - 0.62) * 0.8, z - 0.38);
  const wh = smooth(0.2, 0.06, dh) * smooth(0.02, 0.08, ax) * smooth(0.74, 0.6, y) * 0.75;
  // shoulder: the point of the shoulder and the upper arm's top
  const ds = Math.hypot(ax - 0.09, (y - 0.56) * 0.9, z + 0.3);
  const ws = smooth(0.17, 0.05, ds) * smooth(0.02, 0.08, ax) * smooth(0.72, 0.56, y) * 0.7;
  if (wh > 0.02 || ws > 0.02) {
    const leg = wh > ws ? (side < 0 ? WB.thighL : WB.thighR) : side < 0 ? WB.fUpL : WB.fUpR;
    const w = Math.max(wh, ws);
    const dom = out.w0 >= 0.5 ? out.b0 : out.b1;
    out.b0 = dom;
    out.b1 = leg;
    out.w0 = 1 - w;
  }
}
/** Cheeks: the skin at the corner of the mouth stretches between the head and the jaw. */
function cheekFn(x: number, y: number, z: number, out: SkinOut): void {
  // height above the mouth line (which drops toward the nose)
  const s = (z - HEAD0[2]) / HEAD_DIR[2];
  const lineY = HEAD0[1] + HEAD_DIR[1] * s - 0.03;
  out.b0 = WB.head;
  out.b1 = WB.jaw;
  out.w0 = smooth(lineY - 0.022, lineY + 0.01, y);
  void x;
}

const CHAINS: ChainSpec[] = [];
CHAINS[C.BODY] = { bones: [WB.pelvis], fn: bodyFn };
CHAINS[C.NECK] = { bones: [WB.chest, WB.neck1, WB.neck2, WB.head], blend: 0.06 };
CHAINS[C.HEAD] = { bones: [WB.head] };
CHAINS[C.JAW] = { bones: [WB.jaw] };
CHAINS[C.CHEEK] = { bones: [WB.head], fn: cheekFn };
CHAINS[C.EAR_L] = { bones: [WB.earL] };
CHAINS[C.EAR_R] = { bones: [WB.earR] };
CHAINS[C.TAIL] = { bones: [WB.pelvis, WB.tail1, WB.tail2, WB.tail3, WB.tail4], blend: 0.05 };
CHAINS[C.FRONT_L] = { bones: [WB.scapL, WB.fUpL, WB.fLowL, WB.fFootL, WB.fToeL], blend: 0.035 };
CHAINS[C.FRONT_R] = { bones: [WB.scapR, WB.fUpR, WB.fLowR, WB.fFootR, WB.fToeR], blend: 0.035 };
CHAINS[C.HIND_L] = { bones: [WB.pelvis, WB.thighL, WB.shankL, WB.metaL, WB.toeL], blend: 0.04 };
CHAINS[C.HIND_R] = { bones: [WB.pelvis, WB.thighR, WB.shankR, WB.metaR, WB.toeR], blend: 0.04 };
CHAINS[C.PAW_FL] = { bones: [WB.fToeL] };
CHAINS[C.PAW_FR] = { bones: [WB.fToeR] };
CHAINS[C.PAW_HL] = { bones: [WB.toeL] };
CHAINS[C.PAW_HR] = { bones: [WB.toeR] };

// ------------------------------------------------------------------------------------------
// Coat
// ------------------------------------------------------------------------------------------

/** Paint classes (per vertex): what part of the wolf a vertex is, for the coat pattern. */
const K = { BODY: 1, NECK: 2, HEAD: 3, FRONT: 4, HIND: 5, TAIL: 6, EAR: 7, NOSE: 8, MOUTH: 9, TEETH: 10, PAW: 11, LIP: 12 } as const;

interface Coat { flank: RGB; saddle: RGB; belly: RGB; legs: RGB; face: RGB; mask: RGB; dark: RGB }
const coat = (flank: number, saddle: number, belly: number, legs: number, face: number, mask: number, dark: number): Coat => ({
  flank: hex(flank), saddle: hex(saddle), belly: hex(belly), legs: hex(legs), face: hex(face), mask: hex(mask), dark: hex(dark),
});
/** Grey (most), dark, pale, brown-grey. */
export const WOLF_COATS: Coat[] = [
  coat(0x857e72, 0x3a3631, 0xcfc6b4, 0xa89a84, 0xc2b8a6, 0x5e564c, 0x181614),
  coat(0x4e4a45, 0x211f1d, 0x8e877b, 0x6e655a, 0x8a8276, 0x2e2a26, 0x121110),
  coat(0xb8b2a6, 0x7c766c, 0xe0dbd0, 0xc9bfae, 0xd6cfc2, 0x8a8278, 0x34302c),
  coat(0x86735e, 0x3b3026, 0xcbbca2, 0xa88c6c, 0xbfae94, 0x5a4a3a, 0x1a1512),
];

// ------------------------------------------------------------------------------------------
// Mesh
// ------------------------------------------------------------------------------------------

export interface WolfMesh {
  geometry: THREE.BufferGeometry;
  cls: Uint8Array;
  tris: number;
}

/** Spiky clump noise for fur outlines, 0..1. */
function tuft(a: number, s: number, seed: number, freqA: number, freqS: number): number {
  const n = noise2(a * freqA, s * freqS, seed, Math.round(freqA * Math.PI * 2) || 0);
  const c = Math.max(0, hash(Math.floor(a * freqA * 1.7), Math.floor(s * freqS * 1.3), seed + 9));
  return Math.max(0, n) * 0.6 + c * c * 0.6;
}

export function buildWolfMesh(lod: number): WolfMesh {
  const b = new Builder(0x3011 + lod);
  const N = lod === 0 ? 26 : lod === 1 ? 14 : 8;
  const NL = lod === 0 ? 12 : lod === 1 ? 8 : 5;
  const step = lod === 0 ? 0.022 : lod === 1 ? 0.05 : 0.12;
  const fur = lod === 0 ? 1 : lod === 1 ? 0.6 : 0;
  const grey = hex(0x857e72);
  b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.55, vary: 0 });

  // ---------------- body ----------------
  {
    //        z      cy     hw     hT     hB
    const T = [
      [0.605, 0.7, 0.05, 0.045, 0.055],
      [0.56, 0.69, 0.103, 0.083, 0.103],
      [0.49, 0.675, 0.13, 0.1, 0.135],
      [0.4, 0.67, 0.14, 0.11, 0.15],
      [0.3, 0.675, 0.128, 0.1, 0.13],
      [0.18, 0.69, 0.11, 0.085, 0.1],
      [0.06, 0.672, 0.12, 0.104, 0.148],
      [-0.06, 0.648, 0.131, 0.128, 0.193],
      [-0.18, 0.637, 0.138, 0.144, 0.213],
      [-0.28, 0.646, 0.134, 0.14, 0.2],
      [-0.36, 0.67, 0.12, 0.124, 0.17],
      [-0.42, 0.705, 0.088, 0.098, 0.118],
    ];
    const at = (z: number): number[] => {
      for (let i = 1; i < T.length; i++) {
        if (z >= T[i][0]) {
          const a = T[i - 1], c = T[i];
          const t = (z - a[0]) / (c[0] - a[0]);
          const u = t * t * (3 - 2 * t) * 0.6 + t * 0.4;
          return a.map((v, k) => v + (c[k] - v) * u);
        }
      }
      return T[T.length - 1];
    };
    const rings: Ring[] = [];
    const z0 = 0.605, z1 = -0.42;
    const n = Math.max(5, Math.round((z0 - z1) / step));
    for (let k = 0; k <= n; k++) {
      const z = z0 + ((z1 - z0) * k) / n;
      const [, cy, hw, hT, hB] = at(z);
      rings.push({
        c: [0, cy, z],
        x: [1, 0, 0],
        y: [0, 1, 0],
        pt: (a) => {
          const c = Math.cos(a), s = Math.sin(a);
          // a deep, narrow chest; the back flatter than the belly
          const e = s > 0 ? 2.3 : 2.0;
          let u = hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
          let v = (s > 0 ? hT : hB) * Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
          if (fur > 0) {
            // guard hair: tufts, longer along the back (the cape) and in the belly fringe
            const back = smooth(0.3, 0.95, s), belly = smooth(-0.6, -0.95, s) * smooth(0.25, -0.1, z);
            const amp = 0.012 + 0.012 * back + 0.02 * belly;
            const r = 1 + (tuft(a, z, 3, 3.2, 14) * amp * fur) / Math.max(0.08, Math.hypot(u, v));
            u *= r;
            v *= r;
          }
          return [u, v];
        },
      });
    }
    const body = loft(b, rings, N, { capStart: true, capEnd: true, bulge: 0.35 });
    tag(body, C.BODY);
    klass(body, K.BODY);
  }

  // ---------------- neck (with the winter ruff) ----------------
  {
    const p0: V3 = [0, 0.72, -0.35], p1: V3 = [0, 0.955, -0.6];
    const dir = norm(sub(p1, p0));
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const f = frame(dir, [1, 0, 0]);
    const rings: Ring[] = [];
    const n = Math.max(3, Math.round(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c: V3 = [p0[0] + dir[0] * len * t, p0[1] + dir[1] * len * t, p0[2] + dir[2] * len * t];
      const hw = 0.118 - 0.034 * t + 0.012 * Math.sin(t * Math.PI);
      const hT = 0.125 - 0.04 * t; // the mane
      const hB = 0.13 - 0.04 * t + 0.015 * Math.sin(t * Math.PI); // the throat ruff
      rings.push({
        c, x: f.x, y: f.y,
        pt: (a) => {
          const cs = Math.cos(a), sn = Math.sin(a);
          let u = hw * cs, v = (sn > 0 ? hT : hB) * sn;
          if (fur > 0) {
            const r = 1 + (tuft(a, t, 5, 3.5, 9) * 0.03 * fur) / Math.max(0.07, Math.hypot(u, v));
            u *= r;
            v *= r;
          }
          return [u, v];
        },
      });
    }
    const neck = loft(b, rings, N, {});
    tag(neck, C.NECK);
    klass(neck, K.NECK);
  }

  // ---------------- head: skull and upper muzzle ----------------
  const hf = frame(HEAD_DIR, [1, 0, 0]);
  {
    const rings: Ring[] = [];
    const n = Math.max(4, Math.round(HEAD_LEN / (step * 0.6)));
    for (let k = 0; k <= n; k++) {
      const s = (HEAD_LEN * k) / n;
      const [hw, hT, hB] = headSize(s);
      const c: V3 = [HEAD0[0] + HEAD_DIR[0] * s, HEAD0[1] + HEAD_DIR[1] * s, HEAD0[2] + HEAD_DIR[2] * s];
      const cheek = smooth(0.02, 0.07, s) * smooth(0.15, 0.09, s);
      rings.push({
        c, x: hf.x, y: hf.y,
        pt: (a) => {
          const cs = Math.cos(a), sn = Math.sin(a);
          // the muzzle's underside is flat: the upper lip line
          const flat = smooth(0.12, 0.2, s);
          let v = (sn > 0 ? hT : hB * (1 - 0.35 * flat)) * sn;
          let u = hw * cs * (1 + cheek * 0.25 * Math.max(0, -sn + 0.3));
          if (sn < 0 && flat > 0) v = Math.max(v, -hB * 0.65);
          if (fur > 0 && s < 0.13) {
            const r = 1 + (tuft(a, s, 7, 4, 30) * 0.012 * fur * (1 + cheek * 1.5)) / Math.max(0.04, Math.hypot(u, v));
            u *= r;
            v *= r;
          }
          return [u, v];
        },
      });
    }
    const head = loft(b, rings, N, { capStart: true, capEnd: true, bulge: 0.4 });
    tag(head, C.HEAD);
    klass(head, K.HEAD);
    // the palate shows when the jaw opens
    head.each((v) => {
      const d = (v.x - HEAD0[0]) * HEAD_DIR[0] + (v.y - HEAD0[1]) * HEAD_DIR[1] + (v.z - HEAD0[2]) * HEAD_DIR[2];
      const ly = v.y - (HEAD0[1] + HEAD_DIR[1] * d);
      if (d > 0.16 && ly < -0.015 && v.ny < -0.5) v.mat = MAT.FUR;
    });
    // nose leather
    b.ink({ color: hex(0x151312), mat: MAT.RUBBER, rough: 0.45, wear: 0.1, snow: 0.0, vary: 0 });
    const ns = b.sphere([0.024, 0.02, 0.022], { sides: lod === 0 ? 10 : 6, rings: lod === 0 ? 6 : 4 });
    const np: V3 = [HEAD0[0] + HEAD_DIR[0] * 0.33, HEAD0[1] + HEAD_DIR[1] * 0.33 + 0.012, HEAD0[2] + HEAD_DIR[2] * 0.33];
    ns.move(np[0], np[1], np[2]);
    tag(ns, C.HEAD);
    klass(ns, K.NOSE);
  }

  // ---------------- lower jaw, cheeks, teeth ----------------
  {
    const rings: Ring[] = [];
    const j0 = 0.12, j1 = 0.315;
    const n = Math.max(3, Math.round((j1 - j0) / (step * 0.6)));
    for (let k = 0; k <= n; k++) {
      const s = j0 + ((j1 - j0) * k) / n;
      const t = (s - j0) / (j1 - j0);
      const [hw] = headSize(s);
      const c: V3 = [HEAD0[0] + HEAD_DIR[0] * s, HEAD0[1] + HEAD_DIR[1] * s - 0.048 + t * 0.008, HEAD0[2] + HEAD_DIR[2] * s];
      const w = hw * 0.78, h = 0.022 - 0.006 * t;
      rings.push({ c, x: hf.x, y: hf.y, pt: (a) => [w * Math.cos(a), h * Math.sin(a) * (Math.sin(a) > 0 ? 0.7 : 1)] });
    }
    b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.3, vary: 0 });
    const jaw = loft(b, rings, Math.max(6, N - 6), { capStart: true, capEnd: true, bulge: 0.5 });
    tag(jaw, C.JAW);
    klass(jaw, K.HEAD);
    jaw.each((v) => {
      if (v.ny > 0.5) v.mat = MAT.FUR;
    });
    // black lip skin at the corners of the mouth (stretches when it opens)
    if (lod < 2) {
      b.ink({ color: hex(0x16120f), mat: MAT.RUBBER, rough: 0.6, wear: 0.1, snow: 0, vary: 0 });
      for (const side of [-1, 1]) {
        const pts: V3[] = [];
        const faces: number[][] = [];
        const cols = 5;
        for (let i = 0; i <= cols; i++) {
          const s = 0.14 + (0.17 * i) / cols;
          const [hw] = headSize(s);
          const base: V3 = [HEAD0[0] + HEAD_DIR[0] * s, HEAD0[1] + HEAD_DIR[1] * s, HEAD0[2] + HEAD_DIR[2] * s];
          const x = side * hw * 0.8;
          pts.push([base[0] + x, base[1] - 0.024, base[2]]);
          pts.push([base[0] + x * 0.95, base[1] - 0.05, base[2]]);
        }
        for (let i = 0; i < cols; i++) {
          const a = i * 2, c = i * 2 + 2;
          faces.push(side > 0 ? [a, a + 1, c + 1, c] : [a, c, c + 1, a + 1]);
        }
        const lip = b.mesh(pts, faces, true);
        tag(lip, C.CHEEK);
        klass(lip, K.LIP);
      }
    }
    if (lod === 0) {
      // canines and a row of incisors
      b.ink({ color: hex(0xd8d0bc), mat: MAT.PLASTIC, rough: 0.35, wear: 0.2, snow: 0, vary: 0 });
      for (const side of [-1, 1]) {
        for (const [s, up] of [[0.27, true], [0.255, false]] as [number, boolean][]) {
          const [hw] = headSize(s);
          const base: V3 = [HEAD0[0] + HEAD_DIR[0] * s + side * hw * 0.72, HEAD0[1] + HEAD_DIR[1] * s + (up ? -0.026 : -0.04), HEAD0[2] + HEAD_DIR[2] * s];
          const tooth = b.cone(0.0045, 0.02, { sides: 4 });
          if (!up) tooth.rotX(Math.PI);
          tooth.move(base[0], base[1] + (up ? -0.01 : 0.01), base[2]);
          tag(tooth, up ? C.HEAD : C.JAW);
          klass(tooth, K.TEETH);
        }
      }
    }
  }

  // ---------------- ears ----------------
  for (const side of [-1, 1]) {
    b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.4, vary: 0 });
    const ear = b.cone(0.03, 0.085, { sides: lod === 0 ? 5 : 3 });
    ear.scale(1, 1, 0.42).warp((p) => {
      // cupped: the front face hollow
      if (p.z < 0) p.z *= 0.4;
    });
    ear.rotZ(-side * 0.2).rotX(-0.15).move(side * 0.056, 1.075, -0.65);
    tag(ear, side < 0 ? C.EAR_L : C.EAR_R);
    klass(ear, K.EAR);
  }

  // ---------------- tail ----------------
  {
    const path: V3[] = [[0, 0.735, 0.54], [0, 0.65, 0.66], [0, 0.55, 0.75], [0, 0.45, 0.82], [0, 0.34, 0.875]];
    const rings: Ring[] = [];
    const L: number[] = [0];
    for (let i = 1; i < path.length; i++) L.push(L[i - 1] + Math.hypot(path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    const total = L[L.length - 1];
    const n = Math.max(4, Math.round(total / step));
    for (let k = 0; k <= n; k++) {
      const s = (total * k) / n;
      let i = 1;
      while (i < path.length - 1 && s > L[i]) i++;
      const t = (s - L[i - 1]) / (L[i] - L[i - 1]);
      const a = path[i - 1], c = path[i];
      const ctr: V3 = [0, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
      const d = norm(sub(c, a));
      const f = frame(d, [1, 0, 0]);
      const u = s / total;
      // the brush: thick in the middle, pointed tip
      const R = 0.045 + 0.03 * Math.sin(Math.min(1, u * 1.15) * Math.PI) * (1 - u * 0.3) - 0.03 * smooth(0.85, 1, u);
      rings.push({
        c: ctr, x: f.x, y: f.y,
        pt: (ang) => {
          let r = Math.max(0.006, R);
          if (fur > 0) r *= 1 + tuft(ang, u, 11, 3, 10) * 0.35 * fur;
          return [r * Math.cos(ang), r * Math.sin(ang)];
        },
      });
    }
    const tail = loft(b, rings, Math.max(6, N - 8), { capStart: true, capEnd: true, bulge: 0.6 });
    tag(tail, C.TAIL);
    klass(tail, K.TAIL);
  }

  // ---------------- legs ----------------
  const legLoft = (path: V3[], radius: (s: number, a: number) => readonly [number, number], s0: number, s1: number, chain: number, cls: number): void => {
    const L: number[] = [0];
    for (let i = 1; i < path.length; i++) L.push(L[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    const rings: Ring[] = [];
    const n = Math.max(3, Math.round((s1 - s0) / (step * 0.8)));
    for (let k = 0; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n;
      let i = 1;
      while (i < path.length - 1 && s > L[i]) i++;
      const t = (s - L[i - 1]) / (L[i] - L[i - 1] || 1);
      const a = path[i - 1], c = path[i];
      const ctr: V3 = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
      let d = norm(sub(c, a));
      if (i < path.length - 1 && t > 0.8) d = norm([d[0] + (path[i + 1][0] - c[0]) * 2, d[1] + (path[i + 1][1] - c[1]) * 2, d[2] + (path[i + 1][2] - c[2]) * 2]);
      const f = frame(d, [1, 0, 0]);
      rings.push({ c: ctr, x: f.x, y: f.y, pt: (ang) => { const r = radius(s, ang); return [r[0] * Math.cos(ang), r[1] * Math.sin(ang)]; } });
    }
    const leg = loft(b, rings, NL, { capEnd: true, bulge: 0.5 });
    tag(leg, chain);
    klass(leg, cls);
  };
  for (const side of [-1, 1]) {
    const sx = (p: V3): V3 => [p[0] * -side, p[1], p[2]];
    // front leg: shoulder -> elbow -> wrist -> paw
    const top: V3 = sx([-0.08, 0.66, -0.31]);
    const fpath = [top, sx(SHOULDER_L), sx(ELBOW_L), sx(WRIST_L), sx(FPAW_L)];
    legLoft(fpath, (s, a) => {
      const R = s < 0.12 ? 0.062 : s < 0.28 ? 0.062 - 0.02 * smooth(0.12, 0.28, s) : s < 0.55 ? 0.042 - 0.014 * smooth(0.28, 0.55, s) : 0.028 - 0.004 * smooth(0.55, 0.64, s);
      // feathering: longer hair down the back of the forearm
      const back = Math.sin(a) < 0 ? 1 : 0;
      const feather = back * smooth(0.3, 0.4, s) * smooth(0.6, 0.48, s) * 0.012 * fur * (1 + tuft(a, s, 13 + side, 2, 20));
      return [R + feather * 0.3, R * 1.08 + feather];
    }, 0, 0.66, side < 0 ? C.FRONT_L : C.FRONT_R, K.FRONT);
    // hind leg: hip -> knee -> hock -> paw, the big furred thigh
    const htop: V3 = sx([-0.08, 0.76, 0.42]);
    const hpath = [htop, sx(HIP_L), sx(KNEE_L), sx(HOCK_L), sx(HPAW_L)];
    legLoft(hpath, (s, a) => {
      const R = s < 0.08 ? 0.09 : s < 0.34 ? 0.09 - 0.035 * smooth(0.08, 0.34, s) : s < 0.62 ? 0.052 - 0.022 * smooth(0.34, 0.62, s) : 0.028 - 0.004 * smooth(0.62, 0.85, s);
      // trousers: shaggy at the back of the thigh
      const pants = Math.sin(a) < 0.2 ? smooth(0.05, 0.15, s) * smooth(0.45, 0.3, s) * 0.016 * fur * (1 + tuft(a, s, 17 + side, 2.5, 16)) : 0;
      return [R * 0.92 + pants * 0.3, R * 1.1 + pants];
    }, 0, 0.86, side < 0 ? C.HIND_L : C.HIND_R, K.HIND);
    // paws
    b.ink({ color: hex(0x6e6254), mat: MAT.FUR, wear: 0.3, snow: 0.7, vary: 0 });
    for (const [paw, tip, chain] of [[sx(FPAW_L), sx(FTIP_L), side < 0 ? C.PAW_FL : C.PAW_FR], [sx(HPAW_L), sx(HTIP_L), side < 0 ? C.PAW_HL : C.PAW_HR]] as [V3, V3, number][]) {
      const p = b.pillow(0.055, 0.038, 0.075, { round: 0.016, bulge: 0.004, seg: lod === 0 ? 2 : 1, ring: lod === 0 ? 2 : 1 });
      p.move((paw[0] + tip[0]) / 2, 0.022, (paw[2] + tip[2]) / 2);
      tag(p, chain);
      klass(p, K.PAW);
    }
  }

  const def = b.build({ ao: 0.75, aoRadius: 0.06, ground: true });
  const geometry = def.geometry!;
  const cls = bindGeometry(geometry, S, CHAINS);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.3);
  return { geometry, cls, tris: def.tris };
}

/** The wolf in one of the coats (shares every attribute but the colour). */
export function coatGeometry(base: WolfMesh, coatIndex: number): THREE.BufferGeometry {
  const c = WOLF_COATS[((coatIndex % WOLF_COATS.length) + WOLF_COATS.length) % WOLF_COATS.length];
  const pos = base.geometry.getAttribute('position').array as Float32Array;
  const nor = base.geometry.getAttribute('normal').array as Float32Array;
  const out: number[] = [0, 0, 0];
  const set = (rgb: number[], col: RGB): void => {
    rgb[0] = col[0]; rgb[1] = col[1]; rgb[2] = col[2];
  };
  return recolor(base.geometry, (i, rgb) => {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const ny = nor[i * 3 + 1];
    const k = base.cls[i];
    // per-hair grizzle: agouti banding as a hash over the surface
    const g = 0.86 + 0.28 * (hash(Math.round(x * 300), Math.round(y * 300), Math.round(z * 300)) * 0.5 + 0.5);
    let col: RGB;
    switch (k) {
      case K.NOSE: col = hex(0x141211); break;
      case K.LIP: col = hex(0x15110e); break;
      case K.TEETH: col = hex(0xcfc6b0); break;
      case K.MOUTH: col = hex(0x3a1a18); break;
      case K.PAW: col = mixRGB(c.legs, c.mask, 0.35); break;
      case K.EAR: {
        // dark rims and backs, paler inside
        const front = z < -0.652 ? 1 : 0;
        col = front ? mixRGB(c.face, c.belly, 0.4) : mixRGB(c.saddle, c.dark, 0.35);
        if (y > 1.12) col = c.dark;
        break;
      }
      case K.TAIL: {
        // dark along the top, a black tip, pale underneath
        const u = smooth(0.62, 0.36, y);
        const top = smooth(-0.2, 0.6, -nor[i * 3 + 2] * 0.3 + ny);
        col = mixRGB(mixRGB(c.belly, c.flank, 0.6), c.saddle, top * 0.8);
        col = mixRGB(col, c.dark, smooth(0.45, 0.38, y) + u * 0);
        break;
      }
      case K.HEAD: {
        // face: pale cheeks and muzzle sides, a darker brow and bridge, white at the lips
        const s = (z - HEAD0[2]) / HEAD_DIR[2];
        const lineY = HEAD0[1] + HEAD_DIR[1] * s;
        const up = y - lineY;
        const bridge = smooth(0.01, 0.045, up) * smooth(0.05, 0.11, s);
        const crown = smooth(0.02, 0.06, up) * smooth(0.13, 0.04, s);
        col = mixRGB(c.face, c.flank, 0.25);
        col = mixRGB(col, c.mask, Math.max(bridge * 0.85, crown * 0.6));
        col = mixRGB(col, c.belly, smooth(-0.02, -0.05, up) * 0.8);
        // the eyebrow spots are pale
        const brow = Math.exp(-((Math.abs(x) - 0.03) ** 2 + (s - 0.12) ** 2 + (up - 0.045) ** 2) / 0.0002);
        col = mixRGB(col, c.belly, Math.min(1, brow) * 0.6);
        break;
      }
      case K.FRONT:
      case K.HIND: {
        // buff legs, paler inside, a dark stripe down the front of the forelegs
        col = mixRGB(c.legs, c.flank, smooth(0.35, 0.6, y));
        const inner = Math.sign(x) * nor[i * 3] < -0.2 ? 1 : 0;
        col = mixRGB(col, c.belly, inner * 0.6);
        if (k === K.FRONT && nor[i * 3 + 2] < -0.6 && y < 0.42 && y > 0.12) col = mixRGB(col, c.mask, 0.55);
        if (k === K.HIND) col = mixRGB(col, c.saddle, smooth(0.62, 0.74, y) * smooth(0.2, 0.7, ny) * 0.6);
        break;
      }
      default: {
        // body and neck: the saddle over the back and shoulders, grey flanks, a pale belly and throat
        const top = smooth(0.1, 0.75, ny);
        const saddleZone = k === K.NECK ? 0.75 : smooth(0.55, 0.3, z) * smooth(-0.42, -0.1, z) * 0.4 + 0.6;
        col = mixRGB(c.flank, c.saddle, top * saddleZone);
        const belly = smooth(-0.15, -0.65, ny) + (k === K.NECK ? smooth(0.0, -0.6, ny) * 0.6 : 0);
        col = mixRGB(col, c.belly, Math.min(1, belly));
        // the cape: dark guard hairs fringing the shoulders
        if (k === K.NECK) col = mixRGB(col, c.dark, smooth(0.6, 0.95, ny) * 0.25);
      }
    }
    set(out, col);
    rgb[0] = out[0] * g;
    rgb[1] = out[1] * g;
    rgb[2] = out[2] * g;
  });
}

/** Both eyes, bound rigidly to the head (position, normal, aSkin). */
export function eyeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const e = eyeBind(side);
    const g = new THREE.SphereGeometry(0.0118, 10, 8);
    g.scale(1, 0.8, 1);
    // turn the ball to look where the eye looks
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(...e.dir));
    g.applyQuaternion(q);
    g.translate(e.at[0], e.at[1], e.at[2]);
    parts.push(g);
  }
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const g of parts) {
    const base = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    const ia = g.getIndex()!.array;
    for (let k = 0; k < ia.length; k++) idx.push(base + ia[k]);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const n = pos.length / 3;
  const skin = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    skin[i * 4] = WB.head;
    skin[i * 4 + 1] = WB.head;
    skin[i * 4 + 2] = 255;
  }
  out.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4, true));
  out.setIndex(idx);
  out.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, -0.7), 0.2);
  return out;
}

export const WOLF_BIND = { HEAD0, HEAD_DIR, SHOULDER_L, ELBOW_L, WRIST_L, FPAW_L, HIP_L, KNEE_L, HOCK_L, HPAW_L, NOSE };
