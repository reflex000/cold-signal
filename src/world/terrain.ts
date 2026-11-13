// The heightmap. Built in three resolutions:
//  1. a coarse 257 x 257 grid (8 m) holds the shape of the flank: the regional slope, the
//     staircase of plateaus (the cabin bench, the cirque floor on its rock step), the shoulder,
//     the ridge, the ravine and its side gully, the creek under the west spur, broad
//     undulations and spurs. A stream-power erosion pass turns that into drainage: gullies
//     that gather and cut down, spurs that stay high.
//  2. a 513 x 513 grid (4 m) holds the ground that closes the square: mountainsides with cliff
//     bands to the west, east and north, the drop past the south edge.
//  3. the full 1025 x 1025 grid (2 m) gets both by interpolation, then detail noise and
//     everything that must be sharp: the ravine walls, the cliff band with its strata, the
//     cirque headwall and the perfectly level lake, the pads under the structures.
// Pure and deterministic (fastnoise + dmath only). Values that depend only on x or only on z
// are computed once per column / row: the last pass touches a million vertices.
import { blueprint, SITES, toWorld, type Pose } from './blueprints';
import { bump, datan2, dcos, dlen, dsin, smooth01, wrapPi } from './dmath';
import { erode } from './erosion';
import { Noise } from './fastnoise';
import * as L from './layout';
import type { PoiId } from './types';

const N = L.N;
const EXT = L.EXTENT;
const CELL = L.CELL;
export const CN = 257; // coarse grid
export const CCELL = (EXT * 2) / (CN - 1); // 8 m
const MN = 513; // wall grid
const MCELL = (EXT * 2) / (MN - 1); // 4 m

export interface Noises {
  warp: Noise; broad: Noise; rib: Noise; med: Noise; detail: Noise; rock: Noise; wall: Noise; peak: Noise; misc: Noise;
}
export function makeNoises(seed: number): Noises {
  return {
    warp: new Noise(seed * 7 + 1), broad: new Noise(seed * 7 + 2), rib: new Noise(seed * 7 + 3), med: new Noise(seed * 7 + 4),
    detail: new Noise(seed * 7 + 5), rock: new Noise(seed * 7 + 6), wall: new Noise(seed * 7 + 8), peak: new Noise(seed * 7 + 9),
    misc: new Noise(seed * 7 + 10),
  };
}

// ------------------------------------------------------------------------------------------
// shared helpers
// ------------------------------------------------------------------------------------------
/** Bilinear sample of an N x N grid at world (x, z). */
export function sampleGrid(g: Float32Array, x: number, z: number): number {
  let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
  if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
  if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * N + i;
  const a = g[k], b = g[k + 1], c = g[k + N], d = g[k + N + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

interface PlateauRt { p: L.Plateau; c: number; s: number; span: number }
function plateauRt(p: L.Plateau): PlateauRt {
  return { p, c: dcos(p.rot), s: dsin(p.rot), span: p.fall / ((p.rx + p.rz) * 0.5) };
}
const BENCH_RT = plateauRt(L.BENCH);
const CIRQUE_RT = plateauRt(L.CIRQUE);

function plateauWeight(q: PlateauRt, x: number, z: number, wob: number): number {
  const p = q.p;
  const dx = x - p.x, dz = z - p.z;
  const u = (dx * q.c - dz * q.s) / p.rx, v = (dx * q.s + dz * q.c) / p.rz;
  const d = Math.sqrt(u * u + v * v) + wob;
  return 1 - smooth01(1, 1 + q.span, d);
}

/** Strata: k steep steps with flat ledges between, for t in 0..1. */
function terrace(t: number, k: number): number {
  const s = t * k;
  const f = Math.floor(s);
  return (f + smooth01(0.22, 0.78, s - f)) / k;
}

/**
 * Strata that do not read as a staircase: the k beds rise and fall along the face (u, metres
 * along it) and their steps are only partly sharp, so ledges break, merge and fade instead of
 * running level for hundreds of metres. `amount` 0 gives the plain terrace (kept where a
 * structure is built against the face). Still 0 at t = 0 and 1 at t = 1.
 */
function strata(t: number, k: number, u: number, nz: Noises, off: number, amount: number): number {
  // the foot of a wall (the walkable lower part, where the route and the log carry pass) stays
  // exactly the plain terrace; the irregularity only shapes the faces above it
  amount *= smooth01(0.12, 0.3, t);
  if (amount <= 0) return terrace(t, k);
  const tilt = 0.55 * nz.misc.at(u / 230 + off, 3.7) + 0.25 * nz.misc.at(u / 70 + off, 5.3);
  const tt = Math.min(1, Math.max(0, t + (tilt / k) * Math.sin(Math.PI * t) * amount));
  const sharp = 1 - amount * (0.5 + 0.22 * nz.misc.at(u / 110 + off, 9.1));
  return t + (terrace(tt, k) - t) * sharp;
}

/** Nearest point on the gully polyline: distance and floor height there. */
function gullyQuery(x: number, z: number): { d: number; fh: number; along: number } {
  const g = L.GULLY;
  let best = 1e9, fh = 0, along = 0, acc = 0;
  for (let i = 0; i < g.length - 1; i++) {
    const ax = g[i][0], az = g[i][1], bx = g[i + 1][0], bz = g[i + 1][1];
    const vx = bx - ax, vz = bz - az;
    const len2 = vx * vx + vz * vz;
    let t = ((x - ax) * vx + (z - az) * vz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + vx * t - x, pz = az + vz * t - z;
    const d = px * px + pz * pz;
    const len = Math.sqrt(len2);
    if (d < best) {
      best = d;
      fh = g[i][2] + (g[i + 1][2] - g[i][2]) * t;
      along = acc + len * t;
    }
    acc += len;
  }
  return { d: Math.sqrt(best), fh, along };
}

/** Per-row values of the ravine (they depend on z only). */
interface RavineRow { cx: number; floor: number; w0: number; wall: number; fade: number }
function ravineRow(z: number): RavineRow {
  return {
    cx: L.ravineX(z), floor: L.ravineFloor(z), w0: L.ravineHalfFloor(z), wall: L.ravineWall(z),
    fade: z < L.RAVINE_TOP - 24 ? 0 : smooth01(L.RAVINE_TOP - 24, L.RAVINE_TOP + 6, z),
  };
}

function ravineCarve(h: number, x: number, z: number, r: RavineRow, extraFloor: number, nz: Noises | null): number {
  if (r.fade <= 0) return h;
  const d = Math.abs(x - r.cx);
  if (d > 240) return h;
  const w0 = r.w0 + extraFloor;
  let prof = r.floor + (d <= w0 ? 0.015 * d : 0.015 * w0 + r.wall * (d - w0));
  if (nz && d > w0) prof += 2.6 * nz.rock.at(x / 21, z / 21) * smooth01(w0, w0 + 8, d);
  if (prof >= h) return h;
  return h + (prof - h) * r.fade;
}

function gullyCarve(h: number, x: number, z: number, extraFloor: number): number {
  if (x < 20 || x > 320 || z < 230 || z > 420) return h;
  const q = gullyQuery(x, z);
  if (q.d > 90) return h;
  const w0 = 4 + extraFloor;
  const prof = q.fh + (q.d <= w0 ? 0.02 * q.d : 0.02 * w0 + 0.6 * (q.d - w0));
  if (prof >= h) return h;
  const fade = smooth01(0, 40, q.along);
  return h + (prof - h) * fade;
}

// ------------------------------------------------------------------------------------------
// 1. the coarse shape
// ------------------------------------------------------------------------------------------
function macro(x: number, z: number, nz: Noises, rr: RavineRow, ridgeZ: number, creekX: number): number {
  // a domain warp so the broad forms do not line up with anything
  const wx = x + 90 * nz.warp.at(x / 520, z / 520);
  const wz = z + 90 * nz.warp.at(x / 520 + 13.7, z / 520 - 4.1);
  let h = L.ramp(wz) + L.TILT_X * x;
  h += 20 * nz.broad.fbm(wx / 480, wz / 480, 3); // spurs and hollows
  const m = nz.misc.at(wx / 400, wz / 400 + 9);
  h += (4 + 5 * smooth01(-0.3, 0.5, m)) * (nz.rib.ridged(wx / 150, wz / 210, 3) - 0.45); // spurs running downslope
  h += 5 * nz.med.fbm(wx / 170, wz / 170, 2);
  // staircase of plateaus
  const wb = plateauWeight(BENCH_RT, x, z, 0.16 * m);
  if (wb > 0) {
    const t = L.BENCH.h + L.BENCH.tiltZ * (z - L.BENCH.z) + L.BENCH.tiltX * (x - L.BENCH.x) + 3 * nz.med.at(x / 60, z / 60);
    h += (t - h) * wb * 0.92;
  }
  // (the rock step under the cirque is broken into buttresses and gullies)
  const wc = plateauWeight(CIRQUE_RT, x, z, 0.1 * m + 0.16 * (nz.med.ridged(x / 48 + 4.1, z / 36, 2) - 0.45));
  if (wc > 0) {
    const t = L.CIRQUE.h + L.CIRQUE.tiltZ * (z - L.CIRQUE.z) + 2 * nz.med.at(x / 60 + 3, z / 60);
    h += (t - h) * wc;
  }
  // the shoulder: a spur down to the south-west from the east wall
  {
    const S = L.SHOULDER;
    const vx = S.bx - S.ax, vz = S.bz - S.az;
    const len2 = vx * vx + vz * vz;
    let t = ((x - S.ax) * vx + (z - S.az) * vz) / len2;
    t = t < -0.3 ? -0.3 : t > 1.25 ? 1.25 : t;
    const px = S.ax + vx * t - x, pz = S.az + vz * t - z;
    const d = Math.sqrt(px * px + pz * pz) / (S.w * (1 + 0.25 * m));
    if (d < 1) h += S.h * bump(d) * (1 - smooth01(0.85, 1.25, t));
  }
  // the north ridge and the trough behind it
  h += (L.RIDGE_H + 6 * m) * bump((z - ridgeZ) / 74) - 15 * bump((z - (ridgeZ - 82)) / 42);
  // knolls and rock ribs on the open slopes above the trees
  const up = smooth01(295, 375, h);
  if (up > 0) h += up * 10 * (nz.rib.ridged(wx / 115 + 7.3, wz / 125, 3) - 0.42);
  // spurs either side of the ravine make it deep
  if (z > 70 && z < 760) {
    const d = Math.abs(x - rr.cx);
    h += 13 * bump((d - 76) / 52) * smooth01(110, 200, z) * (1 - smooth01(620, 740, z));
  }
  // the creek under the west spur
  if (x < -480 && z > -220) h -= 13 * bump((x - creekX) / 75) * smooth01(-220, -120, z);
  h = ravineCarve(h, x, z, rr, 5, null);
  h = gullyCarve(h, x, z, 3);
  return h;
}

// ------------------------------------------------------------------------------------------
// 2. the ground that closes the square
// ------------------------------------------------------------------------------------------
/**
 * A mountainside rising beyond a line: `s` metres past its foot. Concave (gentle foot, steep
 * upper face) with irregular cliff bands (strata on the height fraction, so they follow the
 * wobbling foot line), buttresses that run down the face, crags, and more mountain beyond: it
 * never comes back down, so from inside it reads as a bigger mountain, not a rim.
 */
function mountainside(s: number, along: number, hw: number, x: number, z: number, nz: Noises, off: number, reach: number): number {
  // spur ridges come down from the face into the basin, with gullies between them; up the face
  // they turn into buttresses and couloirs
  let add = 0;
  if (s > -reach) {
    const w = smooth01(-reach, -10, s);
    const al = along + 45 * nz.warp.at(along / 190 + off, s / 140);
    add += 0.15 * hw * w * w * (nz.peak.ridged(al / 125 + off, s / 260, 3) - 0.4);
  }
  if (s <= 0) return add;
  const r = smooth01(0, 170, s);
  const f = r * r;
  add += hw * (0.5 * f + 0.5 * strata(f, 6, along, nz, off, 1));
  add += 0.15 * hw * r * (nz.rock.ridged(x / 70 + off, z / 70, 2) - 0.42); // crags
  if (s > 170) add += 0.32 * (s - 170) + 150 * smooth01(170, 420, s) * (nz.peak.ridged(x / 240, z / 240 + off, 3) - 0.35);
  return add;
}

/** A wandering line: big bays and headlands, never beyond `limit` (a soft knee, no flat stretch). */
function softLimit(raw: number, limit: number, knee: number): number {
  const k = limit - knee;
  if (raw <= k) return raw;
  const d = raw - k;
  return k + (knee * d) / (d + knee);
}
function footLine(base: number, amp: number, t: number, nz: Noises, off: number, limit: number): number {
  const raw = base + amp * nz.wall.at(t / 470, off) + 0.3 * amp * nz.wall.at(t / 150, off + 1.9) + 7 * nz.wall.at(t / 50, off + 3.7);
  return softLimit(raw, limit, 30);
}

/** Height after the ground that closes the square is applied to h. */
function walls(h: number, x: number, z: number, nz: Noises): number {
  let rise = 0;
  // west and east: the flank is held between two bigger mountainsides. Their foot wanders in and
  // out by a hundred metres (bays, headlands, spurs); even where it lies furthest out (714 m)
  // the face is too steep to climb by about 780 m, inside the sim's hard clamp at 798.5 m.
  if (x < -WALL_REGION_X) {
    const s = -x - footLine(636, 95, z, nz, 1.3, 714);
    rise = mountainside(s, z, 225 * (1 + 0.2 * nz.wall.at(z / 260, 5.1)), x, z, nz, 0, 160);
  } else if (x > WALL_REGION_X) {
    const s = x - footLine(636, 95, z, nz, 7.9, 714);
    rise = mountainside(s, z, 225 * (1 + 0.2 * nz.wall.at(z / 260, 9.7)), x, z, nz, 31, 160);
  }
  // north: the summit wall behind the trough, peaks beyond
  if (z < WALL_REGION_N) {
    const s = -z - footLine(-L.ridgeZ(x) + 96, 34, x, nz, 4.4, 724);
    const rn = mountainside(s, x, 330 * (1 + 0.15 * nz.wall.at(x / 260, 6.6)), x, z, nz, 57, 70);
    if (rn > rise) rise = rn + 0.25 * rise;
    else rise += 0.25 * rn;
  }
  h += rise;
  // south: the forest ends at an irregular cliff; below it a narrow valley runs along the foot of
  // the square, and its far side rises as a cliff into more mountain. The valley floor falls to
  // the ravine mouth, so anyone who falls or climbs down can walk out again up the ravine (no
  // pit to be stuck in), and the far cliff, not the edge of the world, is what stops them.
  if (z > WALL_REGION_S) {
    const ws = 1 - smooth01(610, 720, Math.abs(x)); // the mountainsides take the corners
    if (ws > 0) {
      // at the ravine mouth the valley is held to fixed numbers so the ravine floor runs out
      // onto the valley floor at a walkable grade
      const km = 1 - smooth01(25, 70, Math.abs(x - RAVINE_MOUTH_X));
      const zf = southFarFoot(x, nz) * (1 - km) + 795 * km;
      const zc = zf - (southValleyWidth(x, nz) * (1 - km) + 24 * km); // foot of the cliff
      const zl = zc - 12; // its lip
      const hv = 33 + 0.017 * Math.abs(x - 372) + 1.2 * nz.misc.at(x / 60, 5.3);
      if (z > zl - 70) {
        const roll = smooth01(zl - 70, zl, z);
        h -= 7 * roll * roll * ws;
        // the face, with buttresses and gullies in plan
        const g = smooth01(zl, zc, z + 4 * (nz.peak.ridged(x / 38, 2.7, 2) - 0.45));
        if (g > 0) h += (hv - h) * g * ws;
        // the far side: a cliff straight off the valley floor, then more mountain
        const s2 = z - zf - 2.5 * nz.misc.at(x / 25, 8.8);
        if (s2 > 0) {
          const far = 105 * smooth01(0, 24, s2) * (0.85 + 0.3 * nz.wall.at(x / 120, 12.1)) + 0.45 * s2 +
            110 * smooth01(30, 230, s2) * (nz.peak.ridged(x / 190, z / 190, 3) - 0.3);
          h += far * ws;
        }
      }
    }
  }
  return h;
}

const RAVINE_MOUTH_X = L.ravineX(775);
/** Where the walls can reach (spurs included): outside these the 4 m wall grid is computed. */
const WALL_REGION_X = 330;
const WALL_REGION_N = -520;
const WALL_REGION_S = 520;
function inWallRegion(x: number, z: number): boolean {
  return x < -WALL_REGION_X || x > WALL_REGION_X || z < WALL_REGION_N || z > WALL_REGION_S;
}

/** Foot of the far side of the south valley (z), between about 715 and 797. */
export function southFarFoot(x: number, nz: Noises): number {
  return softLimit(758 + 72 * nz.wall.at(x / 300, 2.2) + 14 * nz.wall.at(x / 95, 4.7), 797, 16);
}
/** Width of the south valley floor, 16 to about 70 m. */
export function southValleyWidth(x: number, nz: Noises): number {
  return Math.max(16, 38 + 34 * nz.wall.at(x / 170, 6.3));
}

// ------------------------------------------------------------------------------------------
// 3. full resolution
// ------------------------------------------------------------------------------------------
function upsample(c: Float64Array, out: Float32Array): void {
  // Catmull-Rom weights for the four fine samples between two coarse ones (factor 4)
  const W: number[][] = [];
  for (let s = 0; s < 4; s++) {
    const t = s / 4, t2 = t * t, t3 = t2 * t;
    W.push([-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2]);
  }
  const cl = (v: number) => (v < 0 ? 0 : v > CN - 1 ? CN - 1 : v);
  const rows = new Float64Array(CN * N); // coarse rows, fine columns
  for (let cj = 0; cj < CN; cj++) {
    for (let i = 0; i < N; i++) {
      const ci = i >> 2, w = W[i & 3];
      const r = cj * CN;
      rows[cj * N + i] = w[0] * c[r + cl(ci - 1)] + w[1] * c[r + ci] + w[2] * c[r + cl(ci + 1)] + w[3] * c[r + cl(ci + 2)];
    }
  }
  for (let j = 0; j < N; j++) {
    const cj = j >> 2, w = W[j & 3];
    const r0 = cl(cj - 1) * N, r1 = cj * N, r2 = cl(cj + 1) * N, r3 = cl(cj + 2) * N;
    for (let i = 0; i < N; i++) out[j * N + i] = w[0] * rows[r0 + i] + w[1] * rows[r1 + i] + w[2] * rows[r2 + i] + w[3] * rows[r3 + i];
  }
}

function cirqueAndLake(h: number, x: number, z: number, seed: number): number {
  const dx = x - L.LAKE_X, dz = z - L.LAKE_Z;
  if (dx > 430 || dx < -430 || dz > 430 || dz < -430) return h;
  const d = dlen(dx, dz);
  if (d > 430) return h;
  if (d < 1) return L.LAKE_LEVEL;
  const th = datan2(dz, dx);
  const t = d - L.lakeRadius(th, seed);
  if (t <= 0) return L.LAKE_LEVEL;
  const lv = L.LAKE_LEVEL;
  const north = smooth01(-0.25, 0.95, -dz / d);
  // the rim of the amphitheatre stands up behind the lake
  if (t > 20 && north > 0) h += 26 * north * bump((t - 105) / 80);
  // the bowl: a concave headwall to the north, low walls to the south
  const a = 0.1 + 0.28 * north, b = 0.001 + 0.009 * north;
  let bowl = lv + a * t + b * t * t;
  // the inlet comes down a notch in the headwall
  if (t < 150) {
    const li = Math.abs(wrapPi(th - L.LAKE_IN)) * d;
    if (li < 40) bowl -= (6 + 0.12 * t) * bump(li / 16) * (1 - smooth01(70, 150, t));
  }
  if (bowl < h) h = bowl;
  // a low lip all round so the lake is held in (the outlet is cut through it by the ravine)
  if (t < 34) {
    const lip = lv + 0.25 + 2.6 * smooth01(0, 7, t) - 0.45 * Math.max(0, t - 15);
    if (lip > h) h = lip;
  }
  return h;
}

/** World pose of a site (y filled in later). */
export function sitePose(id: PoiId): Pose {
  const p = L.PLACES[id];
  return { x: p.x, y: 0, z: p.z, yaw: p.yaw };
}

export interface PadInfo { id: PoiId; y: number; discs: { x: number; z: number; r: number; feather: number }[] }

/** Level the ground under every structure. Returns the pad height of each site. Pass `given` to
 * re-level with heights found earlier; `coreOnly` then flattens only the discs themselves. */
export function applyPads(h: Float32Array, given?: PadInfo[], coreOnly = false): PadInfo[] {
  const out: PadInfo[] = [];
  for (const id of ['wreck', 'tail', 'cabin', 'cave', 'camp', 'tower'] as const) {
    const site = SITES[id];
    const pose = sitePose(id);
    const prev = given?.find((p) => p.id === id);
    let padY: number;
    if (prev) padY = prev.y;
    else {
      const ref = site.ref ?? { x: site.pads[0].x, z: site.pads[0].z };
      const rw = toWorld(pose, ref.x, 0, ref.z);
      // the ground at the reference point, averaged over a few metres
      padY = 0;
      for (let k = 0; k < 5; k++) padY += sampleGrid(h, rw.x + (k === 1 ? 2 : k === 2 ? -2 : 0), rw.z + (k === 3 ? 2 : k === 4 ? -2 : 0));
      padY /= 5;
    }
    const discs = site.pads.map((p) => {
      const w = toWorld(pose, p.x, 0, p.z);
      return { x: w.x, z: w.z, r: p.r, feather: p.feather };
    });
    blendDiscs(h, coreOnly ? discs.map((d) => ({ x: d.x, z: d.z, r: d.r - 1, feather: 1.5 })) : discs, padY);
    out.push({ id, y: padY, discs });
  }
  return out;
}

/** Blend the grid toward height y inside the union of discs (max weight, smooth feather). */
export function blendDiscs(h: Float32Array, discs: { x: number; z: number; r: number; feather: number }[], y: number): void {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const d of discs) {
    x0 = Math.min(x0, d.x - d.r - d.feather);
    x1 = Math.max(x1, d.x + d.r + d.feather);
    z0 = Math.min(z0, d.z - d.r - d.feather);
    z1 = Math.max(z1, d.z + d.r + d.feather);
  }
  const i0 = Math.max(0, Math.floor((x0 + EXT) / CELL)), i1 = Math.min(N - 1, Math.ceil((x1 + EXT) / CELL));
  const j0 = Math.max(0, Math.floor((z0 + EXT) / CELL)), j1 = Math.min(N - 1, Math.ceil((z1 + EXT) / CELL));
  for (let j = j0; j <= j1; j++) {
    const z = -EXT + j * CELL;
    for (let i = i0; i <= i1; i++) {
      const x = -EXT + i * CELL;
      let w = 0;
      for (const d of discs) {
        const dd = dlen(x - d.x, z - d.z);
        const wd = dd <= d.r ? 1 : 1 - smooth01(d.r, d.r + d.feather, dd);
        if (wd > w) w = wd;
      }
      if (w > 0) {
        const k = j * N + i;
        h[k] = h[k] + (y - h[k]) * w;
      }
    }
  }
}

/** Broad correction so a place sits near its target altitude before its pad is levelled. */
function steer(h: Float32Array, x: number, z: number, target: number, radius: number): void {
  const off = target - sampleGrid(h, x, z);
  if (Math.abs(off) < 0.3) return;
  const i0 = Math.max(0, Math.floor((x - radius + EXT) / CELL)), i1 = Math.min(N - 1, Math.ceil((x + radius + EXT) / CELL));
  const j0 = Math.max(0, Math.floor((z - radius + EXT) / CELL)), j1 = Math.min(N - 1, Math.ceil((z + radius + EXT) / CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = dlen(-EXT + i * CELL - x, -EXT + j * CELL - z) / radius;
      if (d < 1) h[j * N + i] += off * bump(d);
    }
  }
}

/** Width of the level strip kept round the ice: a little more than a cell diagonal, so every point
 * on the ice (lakeSdf < 0) interpolates between vertices that are all exactly at the ice level. */
export const SHORE_FLAT = 2.9;

/** Set every vertex over the lake to the ice level exactly (after anything that may touch it). */
export function flattenLake(h: Float32Array, seed: number): void {
  const r = L.LAKE_R * 1.25;
  const i0 = Math.floor((L.LAKE_X - r + EXT) / CELL), i1 = Math.ceil((L.LAKE_X + r + EXT) / CELL);
  const j0 = Math.floor((L.LAKE_Z - r + EXT) / CELL), j1 = Math.ceil((L.LAKE_Z + r + EXT) / CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = -EXT + i * CELL, z = -EXT + j * CELL;
      const s = L.lakeSdf(x, z, seed);
      const k = j * N + i;
      if (s <= SHORE_FLAT) h[k] = L.LAKE_LEVEL;
      else if (s < SHORE_FLAT + 4 && h[k] < L.LAKE_LEVEL + 0.15 * (s - SHORE_FLAT)) h[k] = L.LAKE_LEVEL + 0.15 * (s - SHORE_FLAT);
    }
  }
}

export interface TerrainResult {
  h: Float32Array;
  pads: PadInfo[];
}

/** Build the heightmap (before the route is carved into it). */
export function buildTerrain(seed: number, progress: (p: number, label: string) => void): TerrainResult {
  const nz = makeNoises(seed);
  // --- coarse shape
  progress(0.02, 'Shaping the mountain');
  const c = new Float64Array(CN * CN);
  const colRidge = new Float64Array(CN);
  for (let i = 0; i < CN; i++) colRidge[i] = L.ridgeZ(-EXT + i * CCELL);
  for (let j = 0; j < CN; j++) {
    const z = -EXT + j * CCELL;
    const rr = ravineRow(z);
    const creek = L.westCreekX(z);
    for (let i = 0; i < CN; i++) c[j * CN + i] = macro(-EXT + i * CCELL, z, nz, rr, colRidge[i], creek);
  }
  progress(0.06, 'Eroding the slopes');
  // the ravine floor and the side gully are graded by hand (the route and the tail section
  // depend on their heights): erosion leaves them alone
  const hard = new Float32Array(CN * CN).fill(1);
  for (let j = 0; j < CN; j++) {
    const z = -EXT + j * CCELL;
    if (z < L.RAVINE_TOP - 30) continue;
    const cx = L.ravineX(z), w0 = L.ravineHalfFloor(z);
    for (let i = 0; i < CN; i++) {
      const x = -EXT + i * CCELL;
      let hd = smooth01(w0 + 5, w0 + 26, Math.abs(x - cx));
      if (x > 20 && x < 320 && z > 230 && z < 420) hd = Math.min(hd, smooth01(7, 26, gullyQuery(x, z).d));
      hard[j * CN + i] = hd;
    }
  }
  erode(c, CN, CCELL, { iterations: 11, k: 0.0115, diffuse: 0.075, hardness: hard });
  // coarse gradient magnitude, for detail roughness
  const cs = new Float32Array(CN * CN);
  for (let j = 1; j < CN - 1; j++) {
    for (let i = 1; i < CN - 1; i++) {
      const k = j * CN + i;
      const gx = (c[k + 1] - c[k - 1]) / (2 * CCELL), gz = (c[k + CN] - c[k - CN]) / (2 * CCELL);
      cs[k] = Math.sqrt(gx * gx + gz * gz);
    }
  }
  progress(0.11, 'Raising the walls');
  const h = new Float32Array(N * N);
  upsample(c, h);
  // the ground that closes the square, as a delta on a 4 m grid
  const wd = new Float32Array(MN * MN);
  for (let j2 = 0; j2 < MN; j2++) {
    const z = -EXT + j2 * MCELL;
    for (let i2 = 0; i2 < MN; i2++) {
      const x = -EXT + i2 * MCELL;
      if (!inWallRegion(x, z)) continue;
      const base = h[j2 * 2 * N + i2 * 2];
      wd[j2 * MN + i2] = walls(base, x, z, nz) - base;
    }
  }
  progress(0.16, 'Cutting the cliffs');
  // per-column values
  // the cliff band: its foot meanders, its height varies, buttresses jut from the face; all of
  // it held still for a few metres either side of the cave, which is built against the face
  const colCliffZ = new Float64Array(N), colCliffH = new Float64Array(N), colButt = new Float64Array(N);
  const colCoulDx = new Float64Array(N).fill(1e9), colCoulW = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = -EXT + i * CELL;
    if (x > L.CLIFF_X0 - 30 && x < L.CLIFF_X1 + 30) {
      const keep = smooth01(14, 60, Math.abs(x - L.CAVE_X));
      colCliffZ[i] = L.cliffZ(x) + keep * (58 * nz.wall.at(x / 240, 21.7) + 14 * nz.wall.at(x / 70, 23.1));
      colCliffH[i] = L.cliffH(x) * (1 + keep * 0.3 * nz.wall.at(x / 90, 25.3));
      colButt[i] = keep * 14 * (nz.peak.ridged(x / 36 + 3.3, 27.9, 2) - 0.45);
      L.COULOIRS.forEach((cx, ci) => {
        if (Math.abs(x - cx) < Math.abs(colCoulDx[i])) {
          colCoulDx[i] = x - cx;
          colCoulW[i] = 0.2 + 0.12 * ((ci * 0.618) % 1); // how fast each gully widens into its funnel
        }
      });
    }
  }
  // --- full resolution detail and sharp features
  for (let j = 0; j < N; j++) {
    const z = -EXT + j * CELL;
    const rr = ravineRow(z);
    const cj = Math.min(CN - 2, j >> 2), fv = (j & 3) / 4;
    const j2 = j >> 1, gv = (j & 1) * 0.5;
    for (let i = 0; i < N; i++) {
      const x = -EXT + i * CELL;
      const k = j * N + i;
      let v = h[k];
      // detail: rougher where the coarse slope is steep
      const ci = Math.min(CN - 2, i >> 2), fu = (i & 3) / 4;
      const q = cj * CN + ci;
      const sl = cs[q] + (cs[q + 1] - cs[q]) * fu + (cs[q + CN] - cs[q]) * fv;
      const rough = 0.5 + 1.5 * smooth01(0.15, 0.7, sl);
      v += rough * 1.25 * nz.detail.fbm(x / 30, z / 30, 2);
      if (sl > 0.45) v += (sl - 0.45) * 7 * (nz.rock.ridged(x / 46, z / 46, 2) - 0.45);
      // sharp ravine and gully
      v = ravineCarve(v, x, z, rr, 0, nz);
      v = gullyCarve(v, x, z, 0);
      // the cliff band
      const H = colCliffH[i];
      if (H > 0) {
        const s = colCliffZ[i] - z; // metres north of the foot
        if (s > -45) {
          // the face (with buttresses in plan and strata), and the step it makes in the slope
          // fading out toward the ridge
          const t = smooth01(-1, 11, s + colButt[i] + 2.2 * nz.misc.at(x / 16, z / 16));
          let add = H * strata(t, 4, x, nz, 0.37, smooth01(14, 60, Math.abs(x - L.CAVE_X))) * (1 - 0.55 * smooth01(40, 300, s));
          // a couloir: a V-shaped gully, its floor climbing at about 43 degrees, widening upward
          const cd = colCoulDx[i];
          if (cd < 60 && cd > -60) {
            const floor = 1.15 * (s + 5);
            const half = 1.8 + colCoulW[i] * (s > 3 ? s - 3 : 0) + 1.2 * nz.misc.at(x / 9, z / 9);
            const vf = 1 - Math.abs(cd) / half;
            if (vf > 0 && add > floor) add -= (add - (floor > 0 ? floor : 0)) * vf;
          }
          v += add;
          if (s < 0) {
            // talus along the foot, and a scree fan below each couloir
            const a = 1 + s / 45;
            let talus = 7 * a * a * Math.min(1, H / 30);
            if (cd < 60 && cd > -60) {
              const ft = 1 - Math.sqrt(cd * cd + s * s) / 32;
              if (ft > 0) talus += 0.17 * H * ft * ft;
            }
            v += talus;
          }
        }
      }
      // the walls, interpolated from the 4 m grid
      if (inWallRegion(x, z)) {
        const i2 = i >> 1, gu = (i & 1) * 0.5;
        const m = j2 * MN + i2;
        const a = wd[m];
        const b = gu > 0 ? wd[m + 1] : a;
        const cc = gv > 0 ? wd[m + MN] : a;
        const dd = gu > 0 && gv > 0 ? wd[m + MN + 1] : gu > 0 ? b : cc;
        v += a + (b - a) * gu + (cc - a) * gv + (a - b - cc + dd) * gu * gv;
      }
      v = cirqueAndLake(v, x, z, seed);
      // the ravine cuts through the lake's lip at the outlet, and past the south edge
      if (z < 150 || z > 690) v = ravineCarve(v, x, z, rr, 0, nz);
      h[k] = v;
    }
  }
  progress(0.3, 'Levelling the sites');
  for (const id of ['wreck', 'camp', 'tower'] as const) {
    const p = L.PLACES[id];
    steer(h, p.x, p.z, p.alt, 150);
  }
  flattenLake(h, seed);
  const pads = applyPads(h);
  return { h, pads };
}

/** Footprint circle (world) of every structure part of a site, for keeping trees and rocks off. */
export function siteClears(id: Exclude<PoiId, 'lake'>, y: number): { x: number; z: number; r: number }[] {
  const site = SITES[id];
  const pose = { ...sitePose(id), y };
  const out: { x: number; z: number; r: number }[] = [];
  for (const p of site.parts) {
    const bp = blueprint(p.model);
    if (!bp) continue;
    const pp = toWorld(pose, p.x, 0, p.z, p.yaw);
    const c = toWorld(pp, bp.clear.x, 0, bp.clear.z);
    out.push({ x: c.x, z: c.z, r: bp.clear.r });
  }
  return out;
}
