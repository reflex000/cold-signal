// THE PLAYER FIGURE: an adult bundled for a mountain storm, built in code with the KIT Builder and
// skinned to a 22-bone skeleton. Insulated parka with horizontal baffles, a deep hood with a fur
// ruff, goggles over a balaclava and scarf, insulated trousers with gaiters, winter boots, mitts
// with gauntlets, a pack with a rolled foam mat. No face. Parka cloth is painted with a neutral
// reference grey and class 1, so each slot gets its own colour attribute (slotGeometry) on shared
// geometry. Three levels of detail.
//
// Model space: metres, Y up, the figure faces -Z, its right hand is +X, feet on y = 0. The bind
// pose is an A-pose (arms 26 degrees out), legs straight.
import * as THREE from 'three/webgpu';
import { Builder, MAT, PAL, hex, mixRGB, type RGB, type V3 } from '../models/kit';
import { bindGeometry, klass, planeWeights, recolor, tag, type ChainSpec, type SkinOut } from './bind';
import { SkelDef } from './rig';
import { add, frame, hash, loft, mul, noise1, noise2, norm, smooth, sub, superEllipse, type Ring } from './shape';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------
// Skeleton
// ------------------------------------------------------------------------------------------

export const A_POSE = 26 * DEG;
export const UPPER_ARM = 0.3;
export const FOREARM = 0.255;
export const HAND_LEN = 0.17;
export const THIGH = 0.42;
export const SHIN = 0.43;

const ARM_DIR = (side: 1 | -1): V3 => [side * Math.sin(A_POSE), -Math.cos(A_POSE), 0];
const SHOULDER = (side: 1 | -1): V3 => [side * 0.182, 1.425, 0.006];
const ELBOW = (side: 1 | -1): V3 => add(SHOULDER(side), mul(ARM_DIR(side), UPPER_ARM));
const WRIST = (side: 1 | -1): V3 => add(ELBOW(side), mul(ARM_DIR(side), FOREARM));
const HAND_TIP = (side: 1 | -1): V3 => add(WRIST(side), mul(ARM_DIR(side), HAND_LEN));
const HIP = (side: 1 | -1): V3 => [side * 0.092, 0.95, 0.006];
const KNEE = (side: 1 | -1): V3 => [side * 0.098, 0.53, -0.01];
const ANKLE = (side: 1 | -1): V3 => [side * 0.1, 0.1, 0.02];
const TOE = (side: 1 | -1): V3 => [side * 0.1, 0.03, -0.165];

export const PLAYER_SKEL = new SkelDef([
  { name: 'pelvis', parent: null, at: [0, 0.98, 0.012] },
  { name: 'spine', parent: 'pelvis', at: [0, 1.12, 0.018] },
  { name: 'chest', parent: 'spine', at: [0, 1.3, 0.012] },
  { name: 'neck', parent: 'chest', at: [0, 1.475, 0.004] },
  { name: 'head', parent: 'neck', at: [0, 1.595, -0.006], tail: [0, 1.79, -0.006] },
  { name: 'clavL', parent: 'chest', at: [-0.03, 1.44, -0.012], tail: SHOULDER(-1) },
  { name: 'uparmL', parent: 'clavL', at: SHOULDER(-1), tail: ELBOW(-1) },
  { name: 'foarmL', parent: 'uparmL', at: ELBOW(-1), tail: WRIST(-1) },
  { name: 'handL', parent: 'foarmL', at: WRIST(-1), tail: HAND_TIP(-1) },
  { name: 'clavR', parent: 'chest', at: [0.03, 1.44, -0.012], tail: SHOULDER(1) },
  { name: 'uparmR', parent: 'clavR', at: SHOULDER(1), tail: ELBOW(1) },
  { name: 'foarmR', parent: 'uparmR', at: ELBOW(1), tail: WRIST(1) },
  { name: 'handR', parent: 'foarmR', at: WRIST(1), tail: HAND_TIP(1) },
  { name: 'thighL', parent: 'pelvis', at: HIP(-1), tail: KNEE(-1) },
  { name: 'shinL', parent: 'thighL', at: KNEE(-1), tail: ANKLE(-1) },
  { name: 'footL', parent: 'shinL', at: ANKLE(-1), tail: TOE(-1) },
  { name: 'thighR', parent: 'pelvis', at: HIP(1), tail: KNEE(1) },
  { name: 'shinR', parent: 'thighR', at: KNEE(1), tail: ANKLE(1) },
  { name: 'footR', parent: 'shinR', at: ANKLE(1), tail: TOE(1) },
  { name: 'pack', parent: 'chest', at: [0, 1.3, 0.2], tail: [0, 0.98, 0.22] },
]);

const S = PLAYER_SKEL;
export const PB = {
  pelvis: S.i('pelvis'), spine: S.i('spine'), chest: S.i('chest'), neck: S.i('neck'), head: S.i('head'),
  clavL: S.i('clavL'), uparmL: S.i('uparmL'), foarmL: S.i('foarmL'), handL: S.i('handL'),
  clavR: S.i('clavR'), uparmR: S.i('uparmR'), foarmR: S.i('foarmR'), handR: S.i('handR'),
  thighL: S.i('thighL'), shinL: S.i('shinL'), footL: S.i('footL'),
  thighR: S.i('thighR'), shinR: S.i('shinR'), footR: S.i('footR'),
  pack: S.i('pack'),
};

/** Bind-space facts the animation needs. */
export const PLAYER_BIND = {
  armDir: ARM_DIR,
  shoulder: SHOULDER,
  wrist: WRIST,
  hip: HIP,
  ankle: ANKLE,
  /** Palm centre, in hand-bind space offset from the wrist (along the arm, toward the palm). */
  palm: (side: 1 | -1): V3 => add(mul(ARM_DIR(side), 0.085), [-side * 0.012 * Math.cos(A_POSE), -0.012 * Math.sin(A_POSE), 0]),
};

// ------------------------------------------------------------------------------------------
// Binding chains (ids stored per part)
// ------------------------------------------------------------------------------------------

const CH = {
  TORSO: 0, HEAD: 1, NECK: 2, ARM_L: 3, ARM_R: 4, HAND_L: 5, HAND_R: 6, FORE_L: 7, FORE_R: 8,
  LEG_L: 9, LEG_R: 10, SHIN_L: 11, SHIN_R: 12, FOOT_L: 13, FOOT_R: 14, PACK: 15, CHEST: 16, BELT: 17,
} as const;

const torsoChain: ChainSpec = { bones: [PB.pelvis, PB.spine, PB.chest, PB.neck, PB.head], blend: 0.07 };
const _tmp: SkinOut = { b0: 0, b1: 0, w0: 1 };
/** Torso: the spine chain above the hips; below, the hem follows the thigh on its side a little. */
function torsoFn(x: number, y: number, z: number, out: SkinOut): void {
  if (y > 0.97) {
    // chainWeights would recurse through fn: inline the plain chain
    plainChain(torsoChain, x, y, z, out);
    return;
  }
  const side = x < 0 ? PB.thighL : PB.thighR;
  // more toward the hem, less near the centre line (no tear between the legs)
  const w = smooth(0.97, 0.74, y) * 0.6 * smooth(0.0, 0.07, Math.abs(x)) * (0.55 + 0.45 * smooth(0.05, -0.12, z));
  out.b0 = PB.pelvis;
  out.b1 = side;
  out.w0 = 1 - w;
}
function plainChain(c: ChainSpec, x: number, y: number, z: number, out: SkinOut): void {
  planeWeights(S, c.bones, c.blend ?? 0.05, x, y, z, out);
}

const CHAINS: ChainSpec[] = [];
CHAINS[CH.TORSO] = { bones: [PB.pelvis], fn: torsoFn };
CHAINS[CH.HEAD] = { bones: [PB.head] };
CHAINS[CH.NECK] = { bones: [PB.chest, PB.neck, PB.head], blend: 0.045 };
CHAINS[CH.ARM_L] = { bones: [PB.clavL, PB.uparmL, PB.foarmL], blend: 0.055 };
CHAINS[CH.ARM_R] = { bones: [PB.clavR, PB.uparmR, PB.foarmR], blend: 0.055 };
CHAINS[CH.HAND_L] = { bones: [PB.handL] };
CHAINS[CH.HAND_R] = { bones: [PB.handR] };
CHAINS[CH.FORE_L] = { bones: [PB.foarmL] };
CHAINS[CH.FORE_R] = { bones: [PB.foarmR] };
CHAINS[CH.LEG_L] = { bones: [PB.pelvis, PB.thighL, PB.shinL], blend: 0.06 };
CHAINS[CH.LEG_R] = { bones: [PB.pelvis, PB.thighR, PB.shinR], blend: 0.06 };
CHAINS[CH.SHIN_L] = { bones: [PB.shinL, PB.footL], blend: 0.035 };
CHAINS[CH.SHIN_R] = { bones: [PB.shinR, PB.footR], blend: 0.035 };
CHAINS[CH.FOOT_L] = { bones: [PB.footL] };
CHAINS[CH.FOOT_R] = { bones: [PB.footR] };
CHAINS[CH.PACK] = { bones: [PB.pack] };
CHAINS[CH.CHEST] = { bones: [PB.spine, PB.chest], blend: 0.08 };
CHAINS[CH.BELT] = { bones: [PB.pelvis, PB.spine], blend: 0.05 };
void _tmp;

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

/** Parka cloth is painted with this, then recoloured per slot (see slotGeometry). */
const REF = hex(0x808080);
/** Parka colours by slot: muted red, ochre, slate blue, olive. */
export const PARKA_COLORS: RGB[] = [hex(0x74281f), hex(0x8b6526), hex(0x3a4b5f), hex(0x4c5434)];
const TROUSER = hex(0x2a2b2f);
const GAITER = hex(0x1e1f22);
const BOOT = hex(0x2c241e);
const SOLE = hex(0x141414);
const MITT = hex(0x1d1e21);
const PALM = hex(0x3b2c22);
const PACK = hex(0x30342d);
const PACK_DARK = hex(0x1f2120);
const MAT_FOAM = hex(0x3e5060);
const KNIT = hex(0x34322f);
const SCARF = hex(0x4a4038);
const BALA = hex(0x26272b);
const RUFF = hex(0x6e604f);
const RUFF_TIP = hex(0x2b231d);
const RUFF_BASE = hex(0x8c7f6e);
const LINING = hex(0x1b1a1a);
const FRAME = hex(0x141416);
const LENS = hex(0x6b4818);

// ------------------------------------------------------------------------------------------
// Torso profile: half width, front and back half depth, centre z, by height
// ------------------------------------------------------------------------------------------

//          y      hw     dF     dB     cz
const TORSO: number[][] = [
  [0.735, 0.196, 0.126, 0.148, 0.012],
  [0.75, 0.207, 0.135, 0.158, 0.012],
  [0.8, 0.206, 0.134, 0.16, 0.013],
  [0.88, 0.2, 0.13, 0.158, 0.013],
  [0.96, 0.192, 0.128, 0.146, 0.013],
  [1.03, 0.186, 0.13, 0.136, 0.011],
  [1.12, 0.193, 0.139, 0.133, 0.008],
  [1.22, 0.207, 0.149, 0.133, 0.004],
  [1.3, 0.215, 0.151, 0.137, 0.001],
  [1.37, 0.215, 0.141, 0.141, 0.0],
  [1.42, 0.201, 0.123, 0.136, 0.002],
  [1.465, 0.16, 0.105, 0.118, 0.004],
  [1.5, 0.118, 0.094, 0.1, 0.004],
  [1.535, 0.104, 0.093, 0.094, 0.004],
  [1.575, 0.1, 0.092, 0.092, 0.002],
];

function torsoAt(y: number): { hw: number; dF: number; dB: number; cz: number } {
  const T = TORSO;
  if (y <= T[0][0]) return { hw: T[0][1], dF: T[0][2], dB: T[0][3], cz: T[0][4] };
  for (let i = 1; i < T.length; i++) {
    if (y <= T[i][0]) {
      const a = T[i - 1], b = T[i];
      const t = (y - a[0]) / (b[0] - a[0]);
      const s = t * t * (3 - 2 * t) * 0.5 + t * 0.5;
      return { hw: a[1] + (b[1] - a[1]) * s, dF: a[2] + (b[2] - a[2]) * s, dB: a[3] + (b[3] - a[3]) * s, cz: a[4] + (b[4] - a[4]) * s };
    }
  }
  const l = T[T.length - 1];
  return { hw: l[1], dF: l[2], dB: l[3], cz: l[4] };
}

const TORSO_E = 2.45;
/** Baffle puff 0..1 at height y (0 on a stitch line). */
function baffle(y: number, y0: number, pitch: number): number {
  const f = (y - y0) / pitch;
  const fr = f - Math.floor(f);
  // full and round between the stitch lines, pinched sharply at them
  return Math.pow(Math.sin(Math.PI * fr), 0.35);
}

/** Point on the torso surface at height y, lateral x, front (-Z) or back, pushed out by `off`. */
function torsoSurface(x: number, y: number, front: boolean, off: number): V3 {
  const t = torsoAt(y);
  const d = front ? t.dF : t.dB;
  const ax = Math.min(0.999, Math.abs(x) / (t.hw + off));
  const v = (d + off) * Math.pow(1 - Math.pow(ax, TORSO_E), 1 / TORSO_E);
  return [x, y, t.cz + (front ? -v : v)];
}

/** Point on the torso outline at height y and angle a (0 = right, pi/2 = front), pushed out by `off`. */
function torsoRing(y: number, a: number, off: number): V3 {
  const t = torsoAt(y);
  const c = Math.cos(a), s = Math.sin(a);
  const e = 2 / TORSO_E;
  const u = (t.hw + off) * Math.sign(c) * Math.pow(Math.abs(c), e);
  const v = ((s > 0 ? t.dF : t.dB) + off) * Math.sign(s) * Math.pow(Math.abs(s), e);
  return [u, y, t.cz - v];
}

/** A smooth path through waypoints (Catmull-Rom), `per` points per span. */
function spline(pts: V3[], per: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ------------------------------------------------------------------------------------------
// Limb lofts
// ------------------------------------------------------------------------------------------

/** Rings along a polyline of joints; radius(s) gives [rx, ry] at arc length s (m from the start). */
function limbRings(path: V3[], radius: (s: number, a: number) => readonly [number, number], hint: V3, step: number, s0: number, s1: number): Ring[] {
  // cumulative lengths
  const L: number[] = [0];
  for (let i = 1; i < path.length; i++) L.push(L[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
  const at = (s: number): { c: V3; d: V3 } => {
    // extrapolate before the start / after the end along the end segments
    let i = 1;
    while (i < path.length - 1 && s > L[i]) i++;
    const a = path[i - 1], b = path[i];
    const seg = L[i] - L[i - 1] || 1;
    const t = (s - L[i - 1]) / seg;
    const d = norm(sub(b, a));
    // smooth the direction through the joints
    let dd = d;
    if (i < path.length - 1 && t > 0.75) dd = norm(add(mul(d, 1 - (t - 0.75) * 2), mul(norm(sub(path[i + 1], b)), (t - 0.75) * 2)));
    if (i > 1 && t < 0.25) dd = norm(add(mul(d, 0.5 + t * 2), mul(norm(sub(a, path[i - 2])), 0.5 - t * 2)));
    return { c: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], d: dd };
  };
  const rings: Ring[] = [];
  const n = Math.max(2, Math.round((s1 - s0) / step));
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const { c, d } = at(s);
    const f = frame(d, hint);
    rings.push({
      c,
      x: f.x,
      y: f.y,
      pt: (a) => {
        const r = radius(s, a);
        return [r[0] * Math.cos(a), r[1] * Math.sin(a)];
      },
    });
  }
  return rings;
}

// ------------------------------------------------------------------------------------------
// Builder
// ------------------------------------------------------------------------------------------

export interface PlayerMesh {
  geometry: THREE.BufferGeometry;
  /** Paint class per vertex (1 = parka cloth). */
  cls: Uint8Array;
  tris: number;
}

/** Build the figure at a level of detail: 0 near (full), 1 mid, 2 far. */
export function buildPlayerMesh(lod: number): PlayerMesh {
  const b = new Builder(0x417 + lod);
  const N = lod === 0 ? 30 : lod === 1 ? 16 : 9; // points per torso ring
  const NL = lod === 0 ? 16 : lod === 1 ? 10 : 6; // per limb ring
  const step = lod === 0 ? 0.018 : lod === 1 ? 0.045 : 0.11;
  const detail = lod === 0;

  // ---------------- torso (parka body and collar) ----------------
  b.ink({ color: REF, mat: MAT.CLOTH, wear: 0.32, snow: 0.7, vary: 0 });
  {
    const rings: Ring[] = [];
    const y0 = 0.735, y1 = 1.575;
    const n = Math.max(4, Math.round((y1 - y0) / step));
    for (let k = 0; k <= n; k++) {
      const y = y0 + ((y1 - y0) * k) / n;
      const t = torsoAt(y);
      // baffles from the hem band to the shoulders, a gathered drawcord at the waist
      const puff = detail && y > 0.77 && y < 1.43 ? baffle(y, 0.775, 0.108) : lod === 1 && y > 0.77 && y < 1.43 ? 0.6 + 0.4 * baffle(y, 0.775, 0.108) : 0.6;
      const cord = smooth(0.06, 0.0, Math.abs(y - 1.03));
      const scale = 1 + 0.045 * (puff - 0.6) - 0.02 * cord;
      const hemRoll = y < 0.75 ? -0.01 : 0;
      rings.push({
        c: [0, y, t.cz],
        x: [1, 0, 0],
        y: [0, 0, -1],
        pt: (a) => {
          const c = Math.cos(a), s = Math.sin(a);
          const e = 2 / TORSO_E;
          let u = (t.hw * scale + hemRoll) * Math.sign(c) * Math.pow(Math.abs(c), e);
          let v = ((s > 0 ? t.dF : t.dB) * scale + hemRoll) * Math.sign(s) * Math.pow(Math.abs(s), e);
          if (detail) {
            // creases: gathers at the cord, slack folds over the belly and the small of the back
            const g = cord * 0.006 * Math.sin(a * 15 + 0.7);
            const fold = 0.004 * noise2(a * 3.2, y * 9, 7, 0) * smooth(1.43, 1.2, y);
            const k2 = 1 + (g + fold) / Math.max(0.1, Math.hypot(u, v));
            u *= k2;
            v *= k2;
          }
          return [u, v];
        },
      });
    }
    const torso = loft(b, rings, N, { capStart: false });
    tag(torso, CH.TORSO);
    klass(torso, 1);
    // weathering: grime toward the hem, the shoulders and hood side bleached by sun and snow,
    // blotches of soiling, the stitch lines darker
    torso.each((v) => {
      const grime = 0.16 * smooth(0.95, 0.74, v.y) + 0.06 * (noise2(v.x * 9 + v.z * 4, v.y * 7, 51, 0) * 0.5 + 0.5);
      const fade = 0.12 * smooth(0.2, 0.9, v.ny) * smooth(1.25, 1.45, v.y);
      const stitch = detail && v.y > 0.77 && v.y < 1.43 ? 0.1 * (1 - baffle(v.y, 0.775, 0.108)) : 0;
      // (parka cloth keeps only its brightness when recoloured per slot: fade = brighter)
      const k = (1 - grime - stitch) * (1 + fade * 2.8);
      v.r *= k;
      v.g *= k;
      v.b *= k;
      v.wear = 0.3 + 0.25 * smooth(0.95, 0.74, v.y);
    });
  }
  if (detail) {
    // front zip placket with a storm flap
    b.ink({ color: mixRGB(REF, [0.02, 0.02, 0.02], 0.25), mat: MAT.CLOTH, wear: 0.35, snow: 0.6, vary: 0 });
    const zp: V3[] = [];
    for (let y = 0.745; y <= 1.56; y += 0.04) zp.push(torsoSurface(0.012, y, true, 0.004));
    const placket = b.strap(spline(zp, 2), 0.034, 0.006, { up: [0, 0, -1] });
    tag(placket, CH.TORSO);
    klass(placket, 1);
    // chest pocket (left) and hand-warmer pockets
    for (const [x, y, w, h] of [[-0.1, 1.27, 0.12, 0.13], [-0.12, 0.98, 0.13, 0.12], [0.12, 0.98, 0.13, 0.12]] as number[][]) {
      const p = torsoSurface(x, y, true, 0.004);
      b.ink({ color: REF, mat: MAT.CLOTH, wear: 0.4, snow: 0.6, vary: 0.04 });
      const pk = b.pillow(w, h, 0.011, { round: 0.005, bulge: 0.003, seg: 2, ring: 1 });
      pk.rotY(Math.atan2(x, 0.25) * 0.8).move(p[0], p[1], p[2] + 0.002);
      tag(pk, CH.TORSO);
      klass(pk, 1);
    }
  }

  // ---------------- sleeves, cuffs, mitts ----------------
  for (const side of [-1, 1] as const) {
    const sh = SHOULDER(side), el = ELBOW(side), wr = WRIST(side);
    const dir = ARM_DIR(side);
    const radius = (s: number, a: number): readonly [number, number] => {
      // deltoid cap -> upper arm -> elbow -> forearm -> wrist
      const R = s < 0.0 ? 0.078 + 0.008 * smooth(-0.07, 0.0, s)
        : s < 0.3 ? 0.088 - 0.014 * smooth(0, 0.3, s)
        : 0.074 - 0.012 * smooth(0.3, 0.54, s);
      const puff = detail ? 1 + 0.03 * (baffle(s, 0.02, 0.085) - 0.6) : 1;
      // the elbow crease: folds on the inner side when it bends, a little slack at rest
      const elbow = smooth(0.08, 0.0, Math.abs(s - 0.3));
      const folds = detail ? 1 + elbow * 0.05 * Math.sin(a * 5 + s * 40) * 0.5 + 0.012 * noise2(a * 2.5, s * 12, side + 3, 0) : 1;
      // the cap's top sinks into the shoulder slope (no padded shelf): ring y is up-out on the
      // right arm and in-down on the left
      const top = (side > 0 ? Math.sin(a) : -Math.sin(a)) > 0 ? 1 : 0;
      const cap = 1 - 0.38 * top * smooth(0.07, -0.05, s);
      return [R * puff * folds, R * puff * folds * 0.96 * cap];
    };
    b.ink({ color: REF, mat: MAT.CLOTH, wear: 0.34, snow: 0.6, vary: 0 });
    const sleeve = loft(b, limbRings([sh, el, wr], radius, [0, 0, -1], step * 0.9, -0.075, UPPER_ARM + FOREARM - 0.01), NL, {});
    tag(sleeve, side < 0 ? CH.ARM_L : CH.ARM_R);
    klass(sleeve, 1);
    sleeve.each((v) => {
      // forearms wear and soil first
      const s = (v.x - sh[0]) * dir[0] + (v.y - sh[1]) * dir[1] + (v.z - sh[2]) * dir[2];
      v.wear = 0.3 + 0.3 * smooth(0.25, 0.5, s);
    });
    // cuff: elastic band, dark
    b.ink({ color: hex(0x1f2023), mat: MAT.CLOTH, wear: 0.4, snow: 0.3, vary: 0.03 });
    const cuffC = add(wr, mul(dir, -0.012));
    const cuff = b.cyl(0.061, 0.035, { sides: NL, r2: 0.058, bevel: 0.006 }).aim(dir, cuffC);
    tag(cuff, side < 0 ? CH.FORE_L : CH.FORE_R);
    // mitt with gauntlet over the cuff
    b.ink({ color: MITT, mat: MAT.CLOTH, wear: 0.45, snow: 0.5, vary: 0.04 });
    const gaunt = b.cyl(0.07, 0.085, { sides: NL, r2: 0.062, bevel: 0.008, top: false, bottom: false }).aim(dir, add(wr, mul(dir, -0.015)));
    tag(gaunt, side < 0 ? CH.HAND_L : CH.HAND_R);
    const palm = PLAYER_BIND.palm(side);
    const mittC = add(wr, add(palm, mul(dir, 0.005)));
    const mitt = b.pillow(0.06, 0.13, 0.092, { round: 0.026, bulge: 0.006, seg: detail ? 2 : 1, ring: detail ? 2 : 1 });
    // the pillow's long axis (Y) along the arm, its thin axis (X) across the palm
    mitt.rotZ(side * A_POSE).move(mittC[0], mittC[1], mittC[2]);
    tag(mitt, side < 0 ? CH.HAND_L : CH.HAND_R);
    // leather palm: tint the inner face
    const inward: V3 = [-side * Math.cos(A_POSE), -Math.sin(A_POSE), 0];
    mitt.each((v) => {
      const f = (v.x - mittC[0]) * inward[0] + (v.y - mittC[1]) * inward[1];
      if (f > 0.012) { v.r = PALM[0]; v.g = PALM[1]; v.b = PALM[2]; v.wear = 0.6; }
    });
    // thumb, forward and in
    const thumb = b.capsule(0.019, 0.075, { sides: detail ? 8 : 5, rings: 2 });
    const thC = add(add(wr, mul(dir, 0.055)), [-side * 0.016, -0.004, -0.04]);
    thumb.aim(norm(add(mul(dir, 0.7), [-side * 0.15, 0, -0.65])), thC);
    tag(thumb, side < 0 ? CH.HAND_L : CH.HAND_R);
  }

  // ---------------- trousers, gaiters, boots ----------------
  for (const side of [-1, 1] as const) {
    const hip = HIP(side), knee = KNEE(side), ank = ANKLE(side);
    const top: V3 = [hip[0] * 0.9, hip[1] + 0.09, hip[2]];
    b.ink({ color: TROUSER, mat: MAT.CLOTH, wear: 0.45, snow: 0.45, vary: 0.03 });
    const radius = (s: number, a: number): readonly [number, number] => {
      // s from the waist (top) down: thigh, knee, calf, ankle
      // slim where the parka covers it (no poking through its sides), full below the hem
      const R = s < 0.22 ? 0.094 : s < 0.32 ? 0.094 + 0.012 * smooth(0.22, 0.32, s) : s < 0.5 ? 0.106 - 0.026 * smooth(0.32, 0.5, s) : s < 0.62 ? 0.08 : 0.08 - 0.012 * smooth(0.62, 0.9, s);
      const knee = smooth(0.07, 0.0, Math.abs(s - 0.52));
      // knee pad bulge on the front, inner thigh flatter (the legs meet at the crotch)
      const c = Math.cos(a), sn = Math.sin(a);
      const inner = side * c < 0 ? 1 - 0.12 * smooth(0.25, 0.0, s) : 1;
      const front = sn > 0 ? 1 + 0.08 * knee * sn : 1;
      const folds = detail ? 1 + 0.02 * noise2(a * 2.2, s * 10, side + 11, 0) + knee * 0.025 * Math.sin(a * 4 + s * 60) : 1;
      return [R * inner * folds, R * front * folds * 1.02];
    };
    const leg = loft(b, limbRings([top, hip, knee, ank], radius, [1, 0, 0], step, 0, 0.98), NL, {});
    tag(leg, side < 0 ? CH.LEG_L : CH.LEG_R);
    leg.each((v) => {
      // worn knees, wet and dirty toward the boots
      const k = smooth(0.08, 0.0, Math.abs(v.y - 0.53));
      v.wear = 0.4 + 0.35 * k;
      const d = smooth(0.35, 0.15, v.y) * 0.25;
      v.r *= 1 - d; v.g *= 1 - d; v.b *= 1 - d;
    });
    // gaiter over the lower leg
    if (lod < 2) {
      b.ink({ color: GAITER, mat: MAT.CLOTH, wear: 0.5, snow: 0.6, vary: 0.03 });
      const gr = (s: number, a: number): readonly [number, number] => {
        const R = 0.088 - 0.012 * smooth(0.05, 0.25, s) + 0.006 * smooth(0.22, 0.29, s);
        const f = detail ? 1 + 0.03 * noise2(a * 2, s * 14, side + 21, 0) : 1;
        return [R * f, R * f * 1.04];
      };
      const g = loft(b, limbRings([knee, ank], gr, [1, 0, 0], step, 0.14, 0.43), NL, {});
      tag(g, side < 0 ? CH.SHIN_L : CH.SHIN_R);
      if (detail) {
        // top strap and buckle
        b.ink({ color: hex(0x111214), mat: MAT.RUBBER, wear: 0.4, snow: 0.4, vary: 0 });
        const gt = add(knee, mul(norm(sub(ank, knee)), 0.155));
        const strap = b.torus(0.08, 0.006, { sides: 4, segs: NL }).aim(norm(sub(knee, ank)), gt);
        tag(strap, side < 0 ? CH.SHIN_L : CH.SHIN_R);
      }
    }
    // boot shaft (follows shin and foot across the ankle), a padded collar at the top
    b.ink({ color: BOOT, mat: MAT.CLOTH, wear: 0.55, snow: 0.75, vary: 0.04 });
    const shaft = b.cyl(0.072, 0.16, { sides: NL, r2: 0.069, bevel: 0.012, rows: detail ? 4 : 2 });
    shaft.scale(1, 1, 1.14).move(ank[0], 0.17, ank[2] + 0.006);
    tag(shaft, side < 0 ? CH.SHIN_L : CH.SHIN_R);
    // lower boot: a loft along the foot, heel to toe, the toe box round and high
    {
      //        z (from the ankle)  half width  height  y bottom
      const Bt = [
        [0.095, 0.03, 0.06, 0.035],
        [0.08, 0.05, 0.1, 0.03],
        [0.03, 0.054, 0.115, 0.03],
        [-0.04, 0.058, 0.1, 0.03],
        [-0.1, 0.06, 0.082, 0.03],
        [-0.15, 0.058, 0.072, 0.03],
        [-0.19, 0.05, 0.062, 0.031],
        [-0.215, 0.032, 0.05, 0.034],
      ];
      const rings: Ring[] = Bt.map(([dz, hw, hh, yb]) => ({
        c: [ank[0], yb + hh / 2, ank[2] + dz],
        x: [1, 0, 0],
        y: [0, 1, 0],
        pt: (a: number) => {
          const c = Math.cos(a), s = Math.sin(a);
          // flat underneath, round on top
          const e = s > 0 ? 2.1 : 3.2;
          return [hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), (hh / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)];
        },
      }));
      const lower = loft(b, rings, detail ? 16 : 8, { capStart: true, capEnd: true, bulge: 0.45 });
      lower.each((v) => {
        // rubber rand round the bottom, scuffed leather above it
        if (v.y < 0.058) { v.mat = MAT.RUBBER; v.r = SOLE[0] * 1.7; v.g = SOLE[1] * 1.7; v.b = SOLE[2] * 1.7; v.rough = 0.8; v.wear = 0.5; }
        else v.wear = 0.5 + 0.3 * smooth(-0.1, -0.2, v.z - ank[2]);
      });
      tag(lower, side < 0 ? CH.FOOT_L : CH.FOOT_R);
    }
    // the sole: barely wider than the boot, a heel block
    b.ink({ color: SOLE, mat: MAT.RUBBER, wear: 0.6, snow: 0.15, vary: 0.02 });
    const sole = b.pillow(0.124, 0.032, 0.318, { round: 0.012, seg: 1, ring: 1 });
    sole.move(ank[0], 0.016, ank[2] - 0.06);
    sole.warp((p) => {
      // narrower at the heel and the toe
      const t = (p.z - (ank[2] - 0.06)) / 0.159;
      p.x = ank[0] + (p.x - ank[0]) * (1 - 0.12 * Math.max(0, t) - 0.18 * Math.max(0, -t - 0.6));
    });
    tag(sole, side < 0 ? CH.FOOT_L : CH.FOOT_R);
    if (detail) {
      // laces: a few dark crossings on the tongue
      b.ink({ color: hex(0x15130f), mat: MAT.CLOTH, wear: 0.5, snow: 0.5, vary: 0 });
      for (let i = 0; i < 4; i++) {
        const y = 0.11 + i * 0.032;
        const lace = b.box(0.07, 0.007, 0.012, { bevel: 0.002 });
        lace.rotX(0.25).move(ank[0], y, ank[2] - 0.07 + i * 0.005 + (y < 0.13 ? -0.01 : 0));
        tag(lace, side < 0 ? (y < 0.12 ? CH.FOOT_L : CH.SHIN_L) : y < 0.12 ? CH.FOOT_R : CH.SHIN_R);
      }
    }
  }

  // ---------------- hood, ruff, face ----------------
  {
    const hc: V3 = [0, 1.655, 0.0];
    // rings along -Z from the back of the hood to the rim, then rolling into the lining
    //   z      cy     rx     ryT    ryB
    const H: number[][] = [
      [0.165, 1.668, 0.035, 0.04, 0.04],
      [0.148, 1.668, 0.088, 0.098, 0.1],
      [0.115, 1.664, 0.128, 0.138, 0.15],
      [0.065, 1.66, 0.148, 0.156, 0.172],
      [0.005, 1.656, 0.154, 0.162, 0.184],
      [-0.055, 1.655, 0.151, 0.16, 0.178],
      [-0.1, 1.655, 0.144, 0.153, 0.165],
      [-0.122, 1.655, 0.133, 0.142, 0.15],
      [-0.13, 1.655, 0.118, 0.127, 0.134],
      [-0.122, 1.655, 0.104, 0.112, 0.118],
      [-0.09, 1.655, 0.1, 0.108, 0.114],
      [-0.04, 1.655, 0.098, 0.106, 0.112],
    ];
    const rings: Ring[] = H.map(([z, cy, rx, ryT, ryB], k) => ({
      c: [hc[0], cy, z],
      x: [1, 0, 0],
      y: [0, 1, 0],
      pt: (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        const lump = detail && k > 1 && k < 8 ? 1 + 0.03 * noise2(a * 2.4, k * 0.9, 31, 0) : 1;
        return [rx * c * lump, (s > 0 ? ryT : ryB) * s * lump];
      },
    }));
    b.ink({ color: REF, mat: MAT.CLOTH, wear: 0.3, snow: 0.75, vary: 0 });
    const hood = loft(b, rings, N, { capStart: true, fixed: true, bulge: 0.3 });
    tag(hood, CH.HEAD);
    klass(hood, 1);
    // the lining inside the rim is dark (rings past the fold; loft points are stored ring by ring)
    hood.each((v) => {
      const ring = Math.floor(v.i / N);
      if (ring >= 8 && ring < H.length) { v.r = LINING[0]; v.g = LINING[1]; v.b = LINING[2]; v.snow = 0; }
    });
    // the hood's lower back meets the collar: a skirt from the hood down onto the shoulders
    const skirt: Ring[] = [];
    for (let k = 0; k <= (detail ? 6 : 3); k++) {
      const t = k / (detail ? 6 : 3);
      const y = 1.6 - t * 0.12;
      const rx = 0.135 + 0.03 * t, rz = 0.13 + 0.025 * t;
      skirt.push({ c: [0, y, 0.035 + t * 0.01], x: [1, 0, 0], y: [0, 0, 1], pt: (a) => [rx * Math.cos(a), rz * Math.sin(a)] });
    }
    // only the back half: squash the front of the skirt in to the collar
    const sk = loft(b, skirt, N, {});
    sk.warp((p) => {
      if (p.z < 0.02) {
        const f = smooth(0.02, -0.08, p.z);
        p.x *= 1 - 0.3 * f;
        p.z = p.z + (0.02 - p.z) * 0.35 * f;
      }
    });
    sk.paint({ color: REF, mat: MAT.CLOTH, wear: 0.3, snow: 0.7 });
    tag(sk, CH.NECK);
    klass(sk, 1);

    // fur ruff: a soft, clumpy ring of long fur round the rim, standing forward and out, fullest at
    // the brow and the sides, short under the chin; a fringe of blunt clumps breaks its outline.
    // Root dark, pale banded tips (coyote guard hair).
    const RN = lod === 0 ? 72 : lod === 1 ? 32 : 14;
    const ruffRings: Ring[] = [];
    const rimZ = -0.128;
    const RX = 0.126, RY = 0.14;
    for (let k = 0; k < RN; k++) {
      const th = (k / RN) * Math.PI * 2;
      const c: V3 = [Math.cos(th) * RX, 1.655 + Math.sin(th) * RY, rimZ + 0.006 * Math.sin(th)];
      const tangent = norm([-Math.sin(th) * RX, Math.cos(th) * RY, 0]);
      const out = norm([Math.cos(th) * RY, Math.sin(th) * RX, 0]);
      const f = frame(tangent, out);
      const full = 0.75 + 0.25 * Math.sin(th) + 0.12 * Math.abs(Math.cos(th));
      ruffRings.push({
        c, x: f.x, y: f.y,
        pt: (a) => {
          // ring axes: x out from the opening, y forward(ish). The fur lies out and forward, thin toward the face.
          const lobe = Math.max(0, Math.cos(a - 0.75));
          const clump = lod === 2 ? 0 : 0.55 * (noise2(th * 7.5, a * 1.6, 61, Math.round(7.5 * Math.PI * 2)) * 0.5 + 0.5) + 0.35 * Math.max(0, hash(Math.round(th * 26), Math.round(a * 2.2), 63));
          const r = (0.016 + 0.034 * lobe * full) * (1 + clump * lobe);
          return [r * Math.cos(a), r * Math.sin(a)];
        },
      });
    }
    b.ink({ color: RUFF, mat: MAT.FUR, wear: 0.2, snow: 0.45, vary: 0 });
    const ruff = loft(b, ruffRings, lod === 0 ? 12 : 6, { closed: true });
    tag(ruff, CH.HEAD);
    ruff.each((v) => {
      // grizzled: clumps of paler and darker hair, dark roots against the hood, banded tips
      const r = Math.hypot(v.x / RX, (v.y - 1.655) / RY);
      const outer = smooth(1.05, 1.35, r) + smooth(-0.14, -0.175, v.z) * 0.6;
      const clump = noise2(Math.atan2(v.y - 1.655, v.x) * 9, r * 6, 67, 0);
      const n = 0.82 + 0.36 * (hash(Math.round(v.x * 260), Math.round(v.y * 260), 5) * 0.5 + 0.5);
      let c = mixRGB(RUFF_TIP, RUFF, smooth(0.92, 1.1, r));
      c = mixRGB(c, clump > 0 ? RUFF_BASE : RUFF_TIP, Math.min(1, outer) * (0.35 + 0.35 * Math.abs(clump)));
      v.r = c[0] * n; v.g = c[1] * n; v.b = c[2] * n;
    });
    if (lod === 0) {
      const TN = 56;
      for (let k = 0; k < TN; k++) {
        const th = ((k + 0.7 * hash(k, 3, 91)) / TN) * Math.PI * 2;
        const top = Math.sin(th); // +1 brow, -1 chin
        // two layers: an outer one standing out, an inner one lying forward over the face opening
        const len = (0.026 + 0.016 * (top * 0.5 + 0.5)) * (0.7 + 0.6 * (hash(k, 7, 93) * 0.5 + 0.5));
        const out: V3 = [Math.cos(th), Math.sin(th) * 1.08, 0];
        const fwd = 0.7 + 0.35 * hash(k, 11, 95);
        const d = norm([out[0] + 0.3 * hash(k, 13, 97), out[1] + 0.3 * hash(k, 17, 99) - 0.12, -fwd]);
        const base: V3 = [Math.cos(th) * RX * 1.2, 1.655 + Math.sin(th) * RY * 1.2, rimZ - 0.012];
        const r0 = 0.014 * (0.75 + 0.5 * (hash(k, 19, 101) * 0.5 + 0.5));
        const tuft = b.cone(r0, len, { sides: 5 });
        tuft.warp((p) => {
          // a slight droop and twist along the hair
          const t = p.y / len + 0.5;
          p.x += 0.004 * t * t;
          p.z += r0 * 0.4 * Math.sin(t * 3 + k);
        });
        tuft.aim(d, [base[0] + (d[0] * len) / 2, base[1] + (d[1] * len) / 2, base[2] + (d[2] * len) / 2]);
        tag(tuft, CH.HEAD);
        // root dark, a dark band, then the pale tip (coyote guard hair), every tuft a little different
        const tint = 0.85 + 0.3 * (hash(k, 23, 103) * 0.5 + 0.5);
        tuft.each((v) => {
          const s = ((v.x - base[0]) * d[0] + (v.y - base[1]) * d[1] + (v.z - base[2]) * d[2]) / len;
          let c = mixRGB(RUFF_TIP, RUFF, smooth(0.0, 0.45, s));
          c = mixRGB(c, RUFF_TIP, smooth(0.55, 0.7, s) * (1 - smooth(0.75, 0.85, s)));
          c = mixRGB(c, RUFF_BASE, smooth(0.8, 1.0, s));
          v.r = c[0] * tint; v.g = c[1] * tint; v.b = c[2] * tint;
          v.snow = 0.4 * smooth(0.5, 1, s);
        });
      }
    }

    // face: a dark balaclava, a wool scarf pulled up over the mouth and nose, frosted by the breath
    b.ink({ color: BALA, mat: MAT.CLOTH, wear: 0.45, snow: 0.1, vary: 0 });
    const face = b.sphere([0.086, 0.108, 0.09], { sides: detail ? 14 : 8, rings: detail ? 9 : 6 });
    face.move(0, 1.65, -0.012);
    tag(face, CH.HEAD);
    // the scarf wound twice round the lower face, up to the goggles, rimed where the breath freezes
    b.ink({ color: SCARF, mat: MAT.CLOTH, wear: 0.7, snow: 0.04, vary: 0 });
    for (const [y, R, r, tilt] of [[1.596, 0.082, 0.03, 0.1], [1.624, 0.08, 0.026, -0.06]] as number[][]) {
      const w = b.torus(R, r, { sides: detail ? 7 : 5, segs: detail ? 18 : 10 });
      w.scale(1, 0.8, 1.08).rotX(tilt).move(0, y, -0.016);
      if (detail) w.crumple(0.006, 24);
      tag(w, CH.HEAD);
      w.each((v) => {
        // a small patch of rime over the mouth
        const m = smooth(0.035, 0.0, Math.hypot(v.x, v.y - 1.6)) * smooth(-0.09, -0.115, v.z);
        v.r += (0.42 - v.r) * m * 0.45; v.g += (0.44 - v.g) * m * 0.45; v.b += (0.47 - v.b) * m * 0.45;
      });
    }
    // goggles: frame, lens, strap round the hood
    const arc = (r: number, a0: number, a1: number, y: number, cz: number, n: number): V3[] => {
      const pts: V3[] = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([Math.sin(a) * r, y, cz - Math.cos(a) * r]);
      }
      return pts;
    };
    const gy = 1.675;
    b.ink({ color: FRAME, mat: MAT.PLASTIC, rough: 0.45, wear: 0.3, snow: 0.3, vary: 0 });
    const frm = b.strap(arc(0.098, -0.98, 0.98, gy, 0.0, detail ? 12 : 6), 0.062, 0.016, { up: [0, 0, -1] });
    // the strap's 'up' at its start must be radial: build along the arc with the up computed per start
    tag(frm, CH.HEAD);
    b.ink({ color: LENS, mat: MAT.PLASTIC, rough: 0.07, metal: 0.65, wear: 0.05, snow: 0.0, vary: 0 });
    const lens = b.strap(arc(0.107, -0.86, 0.86, gy, 0.0, detail ? 12 : 6), 0.047, 0.006, { up: [0, 0, -1] });
    tag(lens, CH.HEAD);
    // scarf wrapped round the neck and chin
    b.ink({ color: KNIT, mat: MAT.CLOTH, wear: 0.45, snow: 0.5, vary: 0 });
    const scarf = b.torus(0.088, 0.036, { sides: detail ? 8 : 5, segs: detail ? 20 : 10 });
    scarf.scale(1, 1, 1.05).rotX(-0.18).move(0, 1.545, -0.02);
    if (detail) scarf.crumple(0.008, 18);
    tag(scarf, CH.NECK);
  }

  // ---------------- pack, mat, straps ----------------
  {
    b.ink({ color: PACK, mat: MAT.CLOTH, wear: 0.5, snow: 0.85, vary: 0.03 });
    const body = b.pillow(0.31, 0.47, 0.19, { round: 0.06, bulge: 0.02, seg: detail ? 3 : 1, ring: detail ? 2 : 1 });
    body.move(0, 1.205, 0.252);
    if (detail) body.crumple(0.006, 6);
    tag(body, CH.PACK);
    const lid = b.pillow(0.3, 0.085, 0.215, { round: 0.035, bulge: 0.012, seg: detail ? 2 : 1, ring: detail ? 2 : 1 });
    lid.rotX(0.12).move(0, 1.452, 0.258);
    tag(lid, CH.PACK);
    if (lod < 2) {
      const pocket = b.pillow(0.22, 0.24, 0.055, { round: 0.025, bulge: 0.01, seg: detail ? 2 : 1, ring: 1 });
      pocket.move(0, 1.13, 0.36);
      tag(pocket, CH.PACK);
      // compression straps on the sides
      b.ink({ color: PACK_DARK, mat: MAT.CLOTH, wear: 0.5, snow: 0.6, vary: 0 });
      for (const y of [1.1, 1.3]) {
        const st = b.box(0.322, 0.022, 0.2, { bevel: 0.004 });
        st.move(0, y, 0.252);
        tag(st, CH.PACK);
      }
    }
    // the foam mat under the pack
    b.ink({ color: MAT_FOAM, mat: MAT.PLASTIC, rough: 0.9, wear: 0.4, snow: 0.8, vary: 0 });
    const mat = b.cyl(0.066, 0.5, { sides: NL + 2, bevel: 0.01, rows: detail ? 8 : 1 });
    mat.rotZ(Math.PI / 2).move(0, 0.925, 0.255);
    if (detail) mat.each((v) => {
      // the rolled ridges
      const k = 0.92 + 0.08 * Math.sin(v.x * 140);
      v.r *= k; v.g *= k; v.b *= k;
    });
    tag(mat, CH.PACK);
    b.ink({ color: PACK_DARK, mat: MAT.CLOTH, wear: 0.5, snow: 0.6, vary: 0 });
    for (const x of [-0.16, 0.16]) {
      const ms = b.torus(0.07, 0.006, { sides: 4, segs: 10 });
      ms.rotZ(Math.PI / 2).move(x, 0.925, 0.255);
      tag(ms, CH.PACK);
    }

    // shoulder straps: padded over the shoulder and down the chest to the lower ribs; from there
    // a webbing strap runs round the side, clear of the parka, to the bottom corner of the pack
    b.ink({ color: PACK_DARK, mat: MAT.CLOTH, wear: 0.5, snow: 0.7, vary: 0 });
    for (const side of [-1, 1]) {
      const pts: V3[] = [
        [side * 0.09, 1.43, 0.16],
        [side * 0.112, 1.495, 0.07],
        [side * 0.118, 1.505, 0.0],
        torsoSurface(side * 0.118, 1.45, true, 0.012),
        torsoSurface(side * 0.122, 1.34, true, 0.013),
        torsoSurface(side * 0.132, 1.22, true, 0.013),
        torsoSurface(side * 0.145, 1.13, true, 0.012),
      ];
      const path = spline(pts, lod === 0 ? 4 : lod === 1 ? 2 : 1);
      const strap = b.strap(path, 0.058, 0.014, { up: [0, 1, 0] });
      tag(strap, CH.CHEST);
      if (lod < 2) {
        const web: V3[] = [];
        const n = lod === 0 ? 10 : 5;
        // from the front of the ribs round the side to the back (angles about the torso)
        const a0 = Math.PI / 2 - 0.62, a1 = -Math.PI / 2 + 0.75;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const a = a0 + (a1 - a0) * t;
          const p = torsoRing(1.125 - 0.06 * t, side > 0 ? a : Math.PI - a, 0.016);
          web.push(p);
        }
        web.push([side * 0.15, 1.04, 0.165]);
        const w = b.strap(web, 0.026, 0.005, { up: [side, 0, 0] });
        tag(w, CH.CHEST);
      }
    }
    if (lod < 2) {
      // sternum strap and hip belt
      const st: V3[] = [torsoSurface(-0.125, 1.3, true, 0.022), torsoSurface(0, 1.3, true, 0.022), torsoSurface(0.125, 1.3, true, 0.022)];
      const ss = b.strap(spline(st, 3), 0.018, 0.005, { up: [0, 0, -1] });
      tag(ss, CH.CHEST);
      const belt: V3[] = [];
      for (let i = 0; i <= (detail ? 14 : 7); i++) {
        const t = i / (detail ? 14 : 7);
        const x = -0.19 + 0.38 * t;
        belt.push(torsoSurface(x * 0.98, 0.995, true, 0.01));
      }
      const hb = b.strap([[-0.15, 0.995, 0.15], ...belt, [0.15, 0.995, 0.15]], 0.045, 0.012, { up: [-1, 0, 0] });
      tag(hb, CH.BELT);
      b.ink({ color: hex(0x101012), mat: MAT.PLASTIC, rough: 0.4, wear: 0.4, snow: 0.3, vary: 0 });
      const buckle = b.box(0.05, 0.035, 0.012, { bevel: 0.003 });
      const bp = torsoSurface(0, 0.995, true, 0.022);
      buckle.move(bp[0], bp[1], bp[2]);
      tag(buckle, CH.BELT);
    }
  }

  const def = b.build({ ao: 0.85, aoRadius: 0.07, ground: true });
  const geometry = def.geometry!;
  const cls = bindGeometry(geometry, S, CHAINS);
  // generous bounds: meshes are drawn at the origin with frustum culling off
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.2);
  return { geometry, cls, tris: def.tris };
}

/** The base geometry with the parka in a slot's colour (shares every other attribute). */
export function slotGeometry(base: PlayerMesh, slot: number): THREE.BufferGeometry {
  const c = PARKA_COLORS[((slot % 4) + 4) % 4];
  const ref = REF[0];
  return recolor(base.geometry, (i, rgb) => {
    if (base.cls[i] !== 1) return;
    const k = (rgb[0] + rgb[1] + rgb[2]) / (3 * ref);
    rgb[0] = c[0] * k;
    rgb[1] = c[1] * k;
    rgb[2] = c[2] * k;
  });
}

export const PLAYER_PALETTE = { PAL };
