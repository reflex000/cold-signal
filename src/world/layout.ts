// The fixed layout of the mountain: where the places are, the lake outline, the ravine, the cliff
// band, the ridge and the walls that close the playable square. These are the same for every
// seed (the seed changes the noise, not the map of the game). Only deterministic math (dmath).
import { bump, datan2, dlen, dsin } from './dmath';
import type { PoiId } from './types';

/** Heightmap: N x N samples over [-EXTENT, EXTENT], CELL metres apart. data[j * N + i], row j is z. */
export const N = 1025;
export const EXTENT = 1024;
export const CELL = (EXTENT * 2) / (N - 1);
export const HALF = 800; // WORLD_HALF

/** Prevailing storm wind, unit vector the air moves toward (it blows from the west-north-west). */
export const WIND_X = 0.857;
export const WIND_Z = 0.515;

/** World.groundAt lets a walker step up this far onto a floor (more than the sim's 0.4 m step, so a floor
 * a little too high reads as a wall instead of being walked into). */
export const STEP_UP = 0.5;
/** slopeAt() above this (40 degrees) is not walkable. */
export const WALK_SLOPE = 40 / 90;
export const TREE_LINE = 360;

export const LAKE_X = 190;
export const LAKE_Z = -40;
export const LAKE_LEVEL = 262;
export const LAKE_R = 128;
/** Direction (atan2(dz, dx)) of the outlet, south-south-east, and of the inlet, north-north-west. */
export const LAKE_OUT = datan2(0.83, 0.55);
export const LAKE_IN = datan2(-0.95, -0.3);

export interface Place { name: string; x: number; z: number; yaw: number; radius: number; alt: number }

/** Targets from DESIGN.md section 1. Yaw is the facing of the main structure (see blueprints.ts);
 * alt is the altitude the terrain is steered toward (the pads then level it exactly). */
export const PLACES: Record<PoiId, Place> = {
  // The plane came in heading west-south-west; the nose points that way, the break faces the scar.
  wreck: { name: 'The fuselage', x: -120, z: 520, yaw: -1.22, radius: 45, alt: 121 },
  tail: { name: 'Tail section', x: 270, z: 380, yaw: 0.35, radius: 28, alt: 0 },
  cabin: { name: 'Ranger cabin', x: -430, z: 130, yaw: 0.4, radius: 32, alt: 0 },
  lake: { name: 'Frozen lake', x: LAKE_X, z: LAKE_Z, yaw: 0, radius: 150, alt: 0 },
  hut: { name: 'Fishing hut', x: LAKE_X, z: LAKE_Z, yaw: -1.18, radius: 9, alt: 0 },
  cave: { name: 'The cave', x: -310, z: -290, yaw: -0.08, radius: 30, alt: 0 },
  camp: { name: 'Survey camp', x: 480, z: -330, yaw: 0.7, radius: 36, alt: 366 },
  tower: { name: 'Signal tower', x: 40, z: -610, yaw: 0, radius: 40, alt: 431 },
};
export const POI_ORDER: PoiId[] = ['wreck', 'tail', 'cabin', 'lake', 'hut', 'cave', 'camp', 'tower'];

// ------------------------------------------------------------------------------------------
// splines
// ------------------------------------------------------------------------------------------
/** Catmull-Rom through [x, y] points sorted by x (uneven spacing allowed), clamped at the ends. */
export function spline(p: readonly (readonly [number, number])[], x: number): number {
  if (x <= p[0][0]) return p[0][1];
  const last = p.length - 1;
  if (x >= p[last][0]) return p[last][1];
  let i = 1;
  while (x > p[i][0]) i++;
  const p0 = p[i > 1 ? i - 2 : 0], p1 = p[i - 1], p2 = p[i], p3 = p[i < last ? i + 1 : last];
  const w = p2[0] - p1[0];
  const t = (x - p1[0]) / w;
  const m1 = p2[0] === p0[0] ? 0 : ((p2[1] - p0[1]) / (p2[0] - p0[0])) * w;
  const m2 = p3[0] === p1[0] ? 0 : ((p3[1] - p1[1]) / (p3[0] - p1[0])) * w;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/** Piecewise linear through [x, y] points sorted by x, clamped. */
export function plin(p: readonly (readonly [number, number])[], x: number): number {
  if (x <= p[0][0]) return p[0][1];
  const last = p.length - 1;
  if (x >= p[last][0]) return p[last][1];
  let i = 1;
  while (x > p[i][0]) i++;
  const a = p[i - 1], b = p[i];
  return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
}

// ------------------------------------------------------------------------------------------
// the regional slope
// ------------------------------------------------------------------------------------------
/** Altitude of the flank against z (north is up): gentle at the foot, steeper up high. */
const RAMP: [number, number][] = [
  [-1024, 480], [-700, 434], [-610, 413], [-500, 386], [-300, 330], [-150, 290], [-40, 255], [130, 208],
  [380, 150], [520, 119], [700, 86], [800, 70], [1024, 44],
];
export function ramp(z: number): number {
  return spline(RAMP, z);
}
/** East is a little higher than west. */
export const TILT_X = 0.008;

// ------------------------------------------------------------------------------------------
// the lake
// ------------------------------------------------------------------------------------------
/** Shore radius of the lake in direction theta = atan2(dz, dx). About 260 m across. */
export function lakeRadius(theta: number, seed: number): number {
  const ph = ((seed % 97) / 97) * 6.283;
  return LAKE_R * (1 + 0.06 * dsin(2 * theta + 0.6) + 0.045 * dsin(3 * theta + 2.1 + ph) + 0.03 * dsin(5 * theta + ph * 2) +
    0.02 * dsin(7 * theta + 1.3 + ph * 3) + 0.012 * dsin(11 * theta + ph * 5));
}

/** Signed distance (approximate, metres) to the lake shore: negative on the ice. */
export function lakeSdf(x: number, z: number, seed: number): number {
  const dx = x - LAKE_X, dz = z - LAKE_Z;
  const d = dlen(dx, dz);
  if (d > LAKE_R * 1.3 + 160) return d - LAKE_R; // far away: the exact value does not matter
  if (d < 1) return -LAKE_R;
  return d - lakeRadius(datan2(dz, dx), seed);
}

/** Point on the shore in direction (dx, dz), pushed `out` metres outward (negative: onto the ice). */
export function lakeShore(dx: number, dz: number, out: number, seed: number): { x: number; z: number } {
  const l = dlen(dx, dz);
  const r = lakeRadius(datan2(dz, dx), seed) + out;
  return { x: LAKE_X + (dx / l) * r, z: LAKE_Z + (dz / l) * r };
}

// ------------------------------------------------------------------------------------------
// the ravine: drains the lake from the outlet on the south-south-east shore, down past the tail
// section, through a boulder choke and over a frozen fall into the gorge beyond the south rim.
// It runs north to south, so the centre line is stored as x(z).
// ------------------------------------------------------------------------------------------
const RAVINE_PTS: [number, number][] = [
  [58, 258], [130, 284], [200, 299], [290, 291], [380, 270], [460, 284], [560, 316], [680, 348], [800, 370], [1100, 400],
];
export const RAVINE_TOP = 58;
export function ravineX(z: number): number {
  return spline(RAVINE_PTS, z);
}
/** Height of the ravine floor (the frozen stream) against z. */
const RAVINE_FLOOR: [number, number][] = [
  [40, 262.4], [62, 261.6], [110, 249], [190, 213], [290, 167], [380, 133], [470, 108], [560, 87],
  [650, 69], [700, 57], [740, 45], [760, 38.5], [771, 35], [790, 33], [799, 32], [807, 8], [1024, 2],
];
export function ravineFloor(z: number): number {
  return spline(RAVINE_FLOOR, z);
}
/** Half width of the flat floor (metres). Wide at the tail, a slot at the boulder choke. */
export function ravineHalfFloor(z: number): number {
  return 5.5 + 4 * bump((z - 380) / 70) - 2 * bump((z - 700) / 40);
}
/** Gradient of the walls above the floor (1 = 45 degrees). Steeper toward the south rim. */
export function ravineWall(z: number): number {
  return 1.0 + 0.5 * smoothRange(600, 690, z);
}
/** Where the lower ravine narrows to a slot strewn with fallen blocks (z of its centre). */
export const CHOKE_Z = 704;

/**
 * A side gully that joins the ravine from the west-north-west just above the tail section:
 * the natural way down into the ravine, and the way the route takes.
 * Points are [x, z, floor height].
 */
export const GULLY: [number, number, number][] = [
  [96, 286, 186], [140, 304, 176], [182, 324, 164], [218, 344, 151], [246, 362, 140], [264, 375, 134.5],
];

// ------------------------------------------------------------------------------------------
// the cliff band across the upper west, with the cave at its foot
// ------------------------------------------------------------------------------------------
/** Foot of the cliff, z(x). */
const CLIFF_Z: [number, number][] = [
  [-860, -214], [-760, -236], [-660, -256], [-560, -272], [-460, -285], [-380, -291], [-310, -293.5],
  [-240, -299], [-180, -312], [-130, -330], [-90, -354], [-55, -388],
];
/** Height of the cliff, h(x). */
const CLIFF_H: [number, number][] = [
  [-860, 40], [-720, 50], [-600, 58], [-470, 63], [-380, 62], [-310, 58], [-230, 48], [-160, 30], [-100, 12], [-55, 0],
];
export const CLIFF_X0 = -860;
export const CLIFF_X1 = -55;
export function cliffZ(x: number): number {
  return spline(CLIFF_Z, x);
}
export function cliffH(x: number): number {
  // the band dies out smoothly to the east (no crease where it ends)
  return Math.max(0, spline(CLIFF_H, x)) * smoothRange(CLIFF_X1, CLIFF_X1 - 110, x);
}
/** Couloirs: steep V-shaped gullies through the band, each with a scree fan below (x of the gully). */
export const COULOIRS = [-712, -566, -436, -206, -128];
/** The cave needs the face straight and full height for a few metres either side. */
export const CAVE_X = -310;

// ------------------------------------------------------------------------------------------
// the north ridge, the trough behind it and the summit wall beyond
// ------------------------------------------------------------------------------------------
/** z of the ridge crest against x; passes through the tower knoll at (40, -610). */
export function ridgeZ(x: number): number {
  const u = x - 40;
  return -610 + 16 * dsin(u / 170) - 0.00003 * u * u;
}
export const RIDGE_H = 22;

// (The ground that closes the square, the mountainsides to the west, east and north and the
// valley past the south edge, is built in terrain.ts: see walls().)

export function smoothRange(a: number, b: number, v: number): number {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------------------------------
// the plateaus that make the staircase of the flank
// ------------------------------------------------------------------------------------------
export interface Plateau { x: number; z: number; rx: number; rz: number; rot: number; fall: number; h: number; tiltZ: number; tiltX: number }
/** The forested bench in the west that holds the cabin. */
export const BENCH: Plateau = { x: -440, z: 122, rx: 190, rz: 105, rot: 0.17, fall: 120, h: 214, tiltZ: -0.05, tiltX: 0.008 };
/** The floor of the cirque that holds the lake, perched on a rock step (the riegel) to the south. */
export const CIRQUE: Plateau = { x: 198, z: 66, rx: 215, rz: 112, rot: 0, fall: 122, h: LAKE_LEVEL + 1, tiltZ: -0.02, tiltX: 0 };
/** The exposed shoulder in the upper east: a spur running down to the south-west from the east wall. */
export const SHOULDER = { ax: 760, az: -470, bx: 400, bz: -262, w: 135, h: 34 };
/** A creek along the foot of the west spur, draining the slopes below the cliff band. */
export function westCreekX(z: number): number {
  return -628 + 26 * dsin(z / 190 + 0.7);
}
