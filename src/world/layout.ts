// The fixed layout of the mountain: where the places are, the lake outline, the ravine line.
// These are the same for every seed (the seed changes the noise, not the map of the game).
import { smoothstep } from '../core/math';
import type { PoiId } from './types';

/** Heightmap: N x N samples over [-EXTENT, EXTENT], CELL metres apart. */
export const N = 1025;
export const EXTENT = 1024;
export const CELL = (EXTENT * 2) / (N - 1);

/** Prevailing storm wind, unit vector the air moves toward (from the west-north-west). */
export const WIND_X = 0.857;
export const WIND_Z = 0.515;

/** World.groundAt lets a walker step up this far onto a floor. */
export const STEP_UP = 0.5;
/** slopeAt() above this (40 degrees) is not walkable. */
export const WALK_SLOPE = 40 / 90;
export const TREE_LINE = 360;

export const LAKE_X = 190;
export const LAKE_Z = -40;
export const LAKE_LEVEL = 262;
export const LAKE_R = 128;
/** Direction (angle of atan2(dz, dx)) of the outlet, south-east, and of the inlet, north-north-west. */
export const LAKE_OUT = Math.atan2(0.83, 0.55);
export const LAKE_IN = Math.atan2(-0.95, -0.3);

export interface Place { name: string; x: number; z: number; yaw: number; radius: number }

/** Targets from DESIGN.md section 1. Yaw is the facing of the main structure (see blueprints.ts). */
export const PLACES: Record<PoiId, Place> = {
  // The plane came in heading west-south-west; the nose points that way, the break faces the scar.
  wreck: { name: 'Crash site', x: -120, z: 520, yaw: -1.22, radius: 45 },
  tail: { name: 'Tail section', x: 270, z: 380, yaw: 0.35, radius: 28 },
  cabin: { name: 'Ranger cabin', x: -430, z: 130, yaw: 0.4, radius: 32 },
  lake: { name: 'Frozen lake', x: LAKE_X, z: LAKE_Z, yaw: 0, radius: 150 },
  hut: { name: 'Fishing hut', x: LAKE_X, z: LAKE_Z, yaw: -1.18, radius: 9 },
  cave: { name: 'The cave', x: -310, z: -290, yaw: -0.08, radius: 30 },
  camp: { name: 'Survey camp', x: 480, z: -330, yaw: 0.7, radius: 36 },
  tower: { name: 'Signal tower', x: 40, z: -610, yaw: 0, radius: 40 },
};
export const POI_ORDER: PoiId[] = ['wreck', 'tail', 'cabin', 'lake', 'hut', 'cave', 'camp', 'tower'];

/** Shore radius of the lake in direction theta = atan2(dz, dx). About 260 m across. */
export function lakeRadius(theta: number, seed: number): number {
  const ph = ((seed % 97) / 97) * 6.283;
  return LAKE_R * (1 + 0.06 * Math.sin(2 * theta + 0.6) + 0.04 * Math.sin(3 * theta + 2.1 + ph) + 0.025 * Math.sin(5 * theta + ph * 2));
}

/** Signed distance (approximate, metres) to the lake shore: negative on the ice. */
export function lakeSdf(x: number, z: number, seed: number): number {
  const dx = x - LAKE_X, dz = z - LAKE_Z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > LAKE_R * 1.3 + 160) return d - LAKE_R; // far away: the exact value does not matter
  if (d < 1) return -LAKE_R;
  return d - lakeRadius(Math.atan2(dz, dx), seed);
}

/** Point on the shore in direction (dx, dz), pushed `out` metres outward (negative: onto the ice). */
export function lakeShore(dx: number, dz: number, out: number, seed: number): { x: number; z: number } {
  const l = Math.hypot(dx, dz);
  const r = lakeRadius(Math.atan2(dz, dx), seed) + out;
  return { x: LAKE_X + (dx / l) * r, z: LAKE_Z + (dz / l) * r };
}

// The ravine drains the lake: from the outlet on the south-east shore down past the tail
// section and out over the south edge. It runs north to south, so it is stored as x(z).
const RAVINE_PTS: [number, number][] = [
  [60, 258], [130, 284], [200, 299], [290, 291], [380, 270], [460, 284], [560, 316], [680, 348], [800, 370], [1100, 400],
];
export const RAVINE_TOP = 72;

export function ravineX(z: number): number {
  const p = RAVINE_PTS;
  if (z <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (z <= p[i][0]) {
      // Catmull-Rom through the control points
      const p0 = p[Math.max(0, i - 2)], p1 = p[i - 1], p2 = p[i], p3 = p[Math.min(p.length - 1, i + 1)];
      const t = (z - p1[0]) / (p2[0] - p1[0]);
      const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * (p2[0] - p1[0]);
      const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * (p2[0] - p1[0]);
      const t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
    }
  }
  return p[p.length - 1][1];
}
/** Depth of the ravine cut (metres) at z. */
export function ravineDepth(z: number): number {
  return 24 * smoothstep(RAVINE_TOP, 190, z) + 5 * smoothstep(190, 380, z);
}
export function ravineHalfWidth(z: number): number {
  return 28 + ravineDepth(z) * 1.1;
}
