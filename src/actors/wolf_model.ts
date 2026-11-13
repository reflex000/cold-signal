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
import { bindGeometry, klass, planeWeights, recolor, tag, type ChainSpec, type SkinOut } from './bind';
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
// The head is carried low and forward on a neck ~30 degrees above level, the muzzle long and
// sloping a little down to the nose; the tail hangs, a hand behind the hocks.
const HEAD_AT: V3 = [0, 0.885, -0.6];
const HEAD0: V3 = [0, 0.925, -0.565];
const HEAD_DIR = norm([0, -0.085, -0.355]);
const HEAD_LEN = 0.365;
const along = (s: number, dy = 0): V3 => [HEAD0[0] + HEAD_DIR[0] * s, HEAD0[1] + HEAD_DIR[1] * s + dy, HEAD0[2] + HEAD_DIR[2] * s];
const NOSE: V3 = along(HEAD_LEN - 0.005);
const TAIL_PATH: V3[] = [[0, 0.725, 0.55], [0, 0.63, 0.635], [0, 0.52, 0.69], [0, 0.41, 0.725], [0, 0.3, 0.745]];

export const WOLF_SKEL = new SkelDef([
  { name: 'pelvis', parent: null, at: [0, 0.74, 0.4] },
  { name: 'spine1', parent: 'pelvis', at: [0, 0.76, 0.18] },
  { name: 'spine2', parent: 'spine1', at: [0, 0.77, -0.04] },
  { name: 'chest', parent: 'spine2', at: [0, 0.76, -0.24] },
  { name: 'neck1', parent: 'chest', at: [0, 0.77, -0.37] },
  { name: 'neck2', parent: 'neck1', at: [0, 0.83, -0.5] },
  { name: 'head', parent: 'neck2', at: HEAD_AT, tail: NOSE },
  { name: 'jaw', parent: 'head', at: along(0.09, -0.05), tail: along(0.33, -0.045) },
  { name: 'earL', parent: 'head', at: [-0.048, 0.975, -0.612], tail: [-0.062, 1.095, -0.622] },
  { name: 'earR', parent: 'head', at: [0.048, 0.975, -0.612], tail: [0.062, 1.095, -0.622] },
  { name: 'tail1', parent: 'pelvis', at: TAIL_PATH[0] },
  { name: 'tail2', parent: 'tail1', at: TAIL_PATH[1] },
  { name: 'tail3', parent: 'tail2', at: TAIL_PATH[2] },
  { name: 'tail4', parent: 'tail3', at: TAIL_PATH[3], tail: TAIL_PATH[4] },
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

/** Head ring at arc length s from the back of the skull: half width, half height above / below. */
function headSize(s: number): [number, number, number] {
  // a broad crown with fur at the cheeks, a long narrow muzzle
  //        s      hw     hT     hB
  const T = [
    [0.0, 0.045, 0.05, 0.05],
    [0.03, 0.08, 0.068, 0.074],
    [0.07, 0.092, 0.072, 0.082],
    [0.115, 0.07, 0.058, 0.068],
    [0.155, 0.049, 0.048, 0.058],
    [0.2, 0.037, 0.042, 0.049],
    [0.26, 0.031, 0.038, 0.042],
    [0.32, 0.027, 0.032, 0.034],
    [0.365, 0.012, 0.012, 0.012],
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
const EYE_S = 0.132;
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
  planeWeights(S, bones, blend, x, y, z, out);
}

const BODY_BONES = [WB.pelvis, WB.spine1, WB.spine2, WB.chest];
/** Body: the spine; the haunches follow the thighs and the shoulder fronts the upper arms. */
function bodyFn(x: number, y: number, z: number, out: SkinOut): void {
  plain(BODY_BONES, 0.09, x, y, z, out);
  const side = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // haunch: below the spine, outside, around the hip joint. Kept small: a thigh folds right up to sit
  // or lie down, and skin that follows it far drags the rump out into a sheet.
  const dh = Math.hypot(ax - 0.085, (y - 0.62) * 0.8, z - 0.38);
  const wh = smooth(0.15, 0.05, dh) * smooth(0.02, 0.08, ax) * smooth(0.72, 0.6, y) * 0.35;
  // shoulder: the point of the shoulder and the upper arm's top
  const ds = Math.hypot(ax - 0.09, (y - 0.56) * 0.9, z + 0.3);
  const ws = smooth(0.14, 0.05, ds) * smooth(0.02, 0.08, ax) * smooth(0.7, 0.56, y) * 0.4;
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
CHAINS[C.TAIL] = { bones: [WB.pelvis, WB.tail1, WB.tail2, WB.tail3, WB.tail4], blend: 0.075 };
// Legs bind from the shoulder / hip joint down, with no blend into the body above it: a leg folds
// ~90 degrees to sit or lie, and a fat ring blended across that joint collapses into a flat sheet.
// The leg's top is a dome on the joint (a ball joint) under the body's own skin.
CHAINS[C.FRONT_L] = { bones: [WB.fUpL, WB.fLowL, WB.fFootL, WB.fToeL], blend: 0.035 };
CHAINS[C.FRONT_R] = { bones: [WB.fUpR, WB.fLowR, WB.fFootR, WB.fToeR], blend: 0.035 };
CHAINS[C.HIND_L] = { bones: [WB.thighL, WB.shankL, WB.metaL, WB.toeL], blend: 0.04 };
CHAINS[C.HIND_R] = { bones: [WB.thighR, WB.shankR, WB.metaR, WB.toeR], blend: 0.04 };
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
/**
 * Grey (most), dark, pale, brown-grey. (POLISH: the warm greys and tan legs read as a coyote in a
 * low sun; timber wolves are grizzled, nearly neutral grey with a dark saddle, only the legs and
 * the backs of the ears a little tawny.)
 */
export const WOLF_COATS: Coat[] = [
  coat(0x7d7b76, 0x2f2d2a, 0xb3b0a8, 0x938b7e, 0xa9a69e, 0x504c46, 0x161514),
  coat(0x4b4946, 0x1e1d1c, 0x8a8781, 0x67625b, 0x85827c, 0x2b2927, 0x111010),
  coat(0xb1afaa, 0x6f6c66, 0xdcd9d2, 0xbcb5a8, 0xd0cdc6, 0x7f7b75, 0x302e2b),
  coat(0x78706a, 0x332e29, 0xbcb4a6, 0x958775, 0xb0a898, 0x4f473f, 0x181512),
];

// ------------------------------------------------------------------------------------------
// Mesh
// ------------------------------------------------------------------------------------------

export interface WolfMesh {
  geometry: THREE.BufferGeometry;
  cls: Uint8Array;
  tris: number;
}

/**
 * Scale on the fur's detail coordinates: the KIT fur shading draws strands ~4 mm across, which alias
 * into wood-grain lines at a few metres; finer strands average into a soft coat and still show close up.
 */
const FUR_FINE = 2.6;

/**
 * Soft fur volume, 0..1: smooth, rounded lobes of coat (no spikes: a low-poly spike reads as a crease in
 * card, not as hair). Periodic in the ring angle a.
 */
function tuft(a: number, s: number, seed: number, freqA: number, freqS: number): number {
  const p = Math.max(1, Math.round(freqA * Math.PI * 2));
  const fa = p / (Math.PI * 2);
  const n = noise2(a * fa, s * freqS, seed, p) * 0.65 + noise2(a * fa * 2, s * freqS * 2, seed + 5, p * 2) * 0.35;
  return n * 0.5 + 0.5;
}

export function buildWolfMesh(lod: number): WolfMesh {
  const b = new Builder(0x3011 + lod);
  const N = lod === 0 ? 30 : lod === 1 ? 16 : 8;
  const NL = lod === 0 ? 12 : lod === 1 ? 8 : 5;
  const step = lod === 0 ? 0.018 : lod === 1 ? 0.045 : 0.11;
  const fur = lod === 0 ? 1 : lod === 1 ? 0.6 : 0;
  const grey = hex(0x857e72);
  // frost on the coat stays light: a full snow cap would hide the saddle. The fur's strands (KIT fur
  // shading runs them along the part's grain axis) lie along the body: grain 'z' on body and head.
  b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.13, vary: 0, grain: 'z', detailScale: FUR_FINE });

  // ---------------- body ----------------
  {
    // a deep, narrow chest, a level back (top line ~0.785 from withers to hips), the tuck-up
    //        z      cy     hw     hT     hB
    const T = [
      [0.6, 0.705, 0.048, 0.045, 0.055],
      [0.555, 0.695, 0.092, 0.084, 0.1],
      [0.49, 0.68, 0.11, 0.104, 0.13],
      [0.4, 0.675, 0.124, 0.11, 0.14],
      [0.3, 0.68, 0.115, 0.105, 0.124],
      [0.18, 0.69, 0.1, 0.095, 0.098],
      [0.06, 0.672, 0.108, 0.113, 0.15],
      [-0.06, 0.646, 0.115, 0.138, 0.196],
      [-0.18, 0.636, 0.12, 0.149, 0.212],
      [-0.28, 0.645, 0.117, 0.142, 0.198],
      [-0.36, 0.67, 0.104, 0.12, 0.166],
      [-0.42, 0.7, 0.076, 0.094, 0.114],
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
            // the coat's volume: soft lobes, fuller along the back (the cape) and the belly fringe
            const back = smooth(0.3, 0.95, s), belly = smooth(-0.6, -0.95, s) * smooth(0.25, -0.1, z);
            const amp = 0.005 + 0.004 * back + 0.008 * belly;
            const r = 1 + (tuft(a, z, 3, 2.2, 7) * amp * fur) / Math.max(0.08, Math.hypot(u, v));
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
    const p0: V3 = [0, 0.705, -0.34], p1: V3 = [0, 0.9, -0.585];
    const dir = norm(sub(p1, p0));
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const f = frame(dir, [1, 0, 0]);
    const rings: Ring[] = [];
    const n = Math.max(3, Math.round(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c: V3 = [p0[0] + dir[0] * len * t, p0[1] + dir[1] * len * t, p0[2] + dir[2] * len * t];
      // winter: a thick neck, the mane over the nape, the ruff round the throat and up to the cheeks
      const hw = 0.104 - 0.018 * t + 0.012 * Math.sin(t * Math.PI);
      const hT = 0.114 - 0.03 * t; // the mane
      const hB = 0.12 - 0.024 * t + 0.016 * Math.sin(t * Math.PI); // the throat ruff
      rings.push({
        c, x: f.x, y: f.y,
        pt: (a) => {
          const cs = Math.cos(a), sn = Math.sin(a);
          let u = hw * cs, v = (sn > 0 ? hT : hB) * sn;
          if (fur > 0) {
            const r = 1 + (tuft(a, t, 5, 2.5, 4) * 0.012 * fur) / Math.max(0.07, Math.hypot(u, v));
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
  b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.1, vary: 0, grain: 'z', detailScale: FUR_FINE });
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
          // the muzzle's underside flattens a little toward the upper lip line
          const flat = smooth(0.12, 0.2, s);
          let v = (sn > 0 ? hT : hB * (1 - 0.18 * flat)) * sn;
          let u = hw * cs * (1 + cheek * 0.25 * Math.max(0, -sn + 0.3));
          if (sn < 0 && flat > 0) v = Math.max(v, -hB * 0.8);
          if (fur > 0 && s < 0.13) {
            const r = 1 + (tuft(a, s, 7, 2.5, 12) * 0.008 * fur * (1 + cheek * 1.5)) / Math.max(0.04, Math.hypot(u, v));
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
    const ns = b.sphere([0.021, 0.017, 0.02], { sides: lod === 0 ? 10 : 6, rings: lod === 0 ? 6 : 4 });
    const np: V3 = along(0.352, 0.01);
    ns.move(np[0], np[1], np[2]);
    tag(ns, C.HEAD);
    klass(ns, K.NOSE);
  }

  // ---------------- lower jaw, cheeks, teeth ----------------
  {
    const rings: Ring[] = [];
    const j0 = 0.12, j1 = 0.338;
    const n = Math.max(3, Math.round((j1 - j0) / (step * 0.6)));
    for (let k = 0; k <= n; k++) {
      const s = j0 + ((j1 - j0) * k) / n;
      const t = (s - j0) / (j1 - j0);
      const [hw] = headSize(s);
      const c: V3 = along(s, -0.044 + t * 0.01);
      const w = hw * 0.78, h = 0.022 - 0.006 * t;
      rings.push({ c, x: hf.x, y: hf.y, pt: (a) => [w * Math.cos(a), h * Math.sin(a) * (Math.sin(a) > 0 ? 0.7 : 1)] });
    }
    b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.1, vary: 0, grain: 'z', detailScale: FUR_FINE });
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
          const s = 0.15 + (0.18 * i) / cols;
          const [hw] = headSize(s);
          const base: V3 = [HEAD0[0] + HEAD_DIR[0] * s, HEAD0[1] + HEAD_DIR[1] * s, HEAD0[2] + HEAD_DIR[2] * s];
          // just inside the muzzle's outline: closed, only the lip line shows
          const x = side * hw * 0.7;
          pts.push([base[0] + x, base[1] - 0.026, base[2]]);
          pts.push([base[0] + x * 0.95, base[1] - 0.046, base[2]]);
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
        for (const [s, up] of [[0.295, true], [0.28, false]] as [number, boolean][]) {
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
    // pointed, upright, set high on the crown, a little out
    b.ink({ color: grey, mat: MAT.FUR, wear: 0.15, snow: 0.15, vary: 0, detailScale: FUR_FINE });
    const ear = b.cone(0.039, 0.106, { sides: lod === 0 ? 6 : 3 });
    ear.scale(1, 1, 0.45).warp((p) => {
      // cupped: the front face hollow
      if (p.z < 0) p.z *= 0.4;
    });
    ear.rotZ(-side * 0.17).rotX(-0.08).move(side * 0.052, 1.03, -0.616);
    tag(ear, side < 0 ? C.EAR_L : C.EAR_R);
    klass(ear, K.EAR);
  }

  // ---------------- tail ----------------
  {
    const path: V3[] = TAIL_PATH.map((p, i) => (i === 0 ? [p[0], p[1] + 0.01, p[2] - 0.012] : p));
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
      // the brush: thick and full down its length, a pointed black tip
      const R = 0.036 + 0.034 * Math.sin(Math.min(1, u * 1.1) * Math.PI) * (1 - u * 0.3) - 0.022 * smooth(0.85, 1, u);
      rings.push({
        c: ctr, x: f.x, y: f.y,
        pt: (ang) => {
          let r = Math.max(0.006, R);
          if (fur > 0) r *= 1 + (tuft(ang, u, 11, 2, 5) - 0.5) * 0.16 * fur;
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
    const leg = loft(b, rings, NL, { capStart: true, capEnd: true, bulge: 0.6 });
    tag(leg, chain);
    klass(leg, cls);
  };
  for (const side of [-1, 1]) {
    const sx = (p: V3): V3 => [p[0] * -side, p[1], p[2]];
    // front leg: shoulder -> elbow -> wrist -> paw (the loft starts on the shoulder joint)
    const top: V3 = sx([-0.093, 0.605, -0.33]);
    const fpath = [top, sx(SHOULDER_L), sx(ELBOW_L), sx(WRIST_L), sx(FPAW_L)];
    legLoft(fpath, (s, a) => {
      // long and lean below the elbow
      const R = s < 0.1 ? 0.055 : s < 0.24 ? 0.055 - 0.015 * smooth(0.1, 0.24, s) : s < 0.5 ? 0.04 - 0.013 * smooth(0.24, 0.5, s) : 0.027 - 0.003 * smooth(0.5, 0.6, s);
      // feathering: longer hair down the back of the forearm
      const back = Math.sin(a) < 0 ? 1 : 0;
      const feather = back * smooth(0.3, 0.4, s) * smooth(0.6, 0.48, s) * 0.008 * fur * (0.6 + tuft(a, s, 13 + side, 1.5, 8));
      return [R + feather * 0.3, R * 1.08 + feather];
    }, 0, 0.62, side < 0 ? C.FRONT_L : C.FRONT_R, K.FRONT);
    // hind leg: hip -> knee -> hock -> paw, the big furred thigh (the loft starts on the hip joint)
    const htop: V3 = sx([-0.084, 0.725, 0.405]);
    const hpath = [htop, sx(HIP_L), sx(KNEE_L), sx(HOCK_L), sx(HPAW_L)];
    legLoft(hpath, (s, a) => {
      // a heavy thigh down to the stifle, a lean gaskin to the hock, a thin metatarsus
      const R = s < 0.05 ? 0.07 + 0.012 * smooth(0, 0.05, s) : s < 0.3 ? 0.082 - 0.02 * smooth(0.05, 0.3, s) : s < 0.45 ? 0.062 - 0.022 * smooth(0.3, 0.45, s) : s < 0.62 ? 0.04 - 0.014 * smooth(0.45, 0.62, s) : 0.024 - 0.003 * smooth(0.62, 0.85, s);
      // trousers: fuller hair at the back of the thigh
      const pants = Math.sin(a) < 0.2 ? smooth(0.05, 0.15, s) * smooth(0.45, 0.3, s) * 0.012 * fur * (0.6 + tuft(a, s, 17 + side, 1.5, 8)) : 0;
      return [R * 0.92 + pants * 0.3, R * 1.1 + pants];
    }, 0, 0.82, side < 0 ? C.HIND_L : C.HIND_R, K.HIND);
    // paws
    b.ink({ color: hex(0x6e6254), mat: MAT.FUR, wear: 0.3, snow: 0.5, vary: 0, detailScale: FUR_FINE });
    for (const [paw, tip, chain] of [[sx(FPAW_L), sx(FTIP_L), side < 0 ? C.PAW_FL : C.PAW_FR], [sx(HPAW_L), sx(HTIP_L), side < 0 ? C.PAW_HL : C.PAW_HR]] as [V3, V3, number][]) {
      // big snowshoe paws
      const p = b.pillow(0.082, 0.044, 0.112, { round: 0.022, bulge: 0.006, seg: lod === 0 ? 2 : 1, ring: lod === 0 ? 2 : 1 });
      p.move((paw[0] + tip[0]) / 2, 0.022, (paw[2] + tip[2]) / 2 - 0.006);
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
    // grizzle: soft patches of paler and darker guard hair (smooth: a per-vertex hash looks like crumpled card)
    const g = 0.9 + 0.2 * (noise2(x * 31 + z * 17, y * 29 - z * 11, 3, 0) * 0.5 + 0.5);
    let col: RGB;
    switch (k) {
      case K.NOSE: col = hex(0x141211); break;
      case K.LIP: col = hex(0x15110e); break;
      case K.TEETH: col = hex(0xcfc6b0); break;
      case K.MOUTH: col = hex(0x3a1a18); break;
      case K.PAW: col = mixRGB(c.legs, c.belly, 0.25); break;
      case K.EAR: {
        // dark rims and backs, paler inside
        // pale fur inside, the backs the saddle's grey, only the rims and tips dark
        const front = z < -0.62 ? 1 : 0;
        col = front ? mixRGB(c.face, c.belly, 0.5) : mixRGB(c.flank, c.saddle, 0.55);
        if (y > 1.06) col = mixRGB(col, c.dark, 0.5);
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
        // body and neck: the dark saddle over the back, a darker cape across the shoulders, grey flanks,
        // a pale belly and throat
        const top = smooth(0.0, 0.62, ny);
        const cape = k === K.NECK ? 1 : smooth(0.05, -0.2, z) * smooth(-0.42, -0.3, z);
        const saddleZone = k === K.NECK ? 0.85 : 0.72 + 0.28 * cape;
        col = mixRGB(c.flank, c.saddle, Math.min(1, top * saddleZone * 1.1));
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
