// The lake ice: thickness on a 4 m grid over the lake's bounding square. Thick (0.5 m and
// more) along the shores and along a safe line from the west-south-west shore to the hut
// (marked by poles), thin (under 0.12 m) where water moves under it, at the inlet and the
// outlet, and in a few seeded patches out in the open; middling elsewhere.
import { hash01 } from '../core/rng';
import { dcos, dlen, dsin, smooth01, TAU } from './dmath';
import { Noise } from './fastnoise';
import * as L from './layout';
import type { LakeInfo } from './types';

export const ICE_CELL = 4;
const HALF = 168; // half side of the grid square, metres

export interface SafeLine { ax: number; az: number; bx: number; bz: number }

function segDist(x: number, z: number, s: SafeLine): number {
  const vx = s.bx - s.ax, vz = s.bz - s.az;
  const l2 = vx * vx + vz * vz;
  let t = ((x - s.ax) * vx + (z - s.az) * vz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dlen(s.ax + vx * t - x, s.az + vz * t - z);
}

export interface LakeBuild {
  info: LakeInfo;
  /** Thin patches (centre, radius) for the map and for the hints. */
  thin: { x: number; z: number; r: number }[];
}

export function buildLake(seed: number, hut: { x: number; z: number }, safe: SafeLine): LakeBuild {
  const n = Math.round((HALF * 2) / ICE_CELL);
  const minX = L.LAKE_X - HALF, minZ = L.LAKE_Z - HALF;
  const thickness = new Float32Array(n * n);
  const nz = new Noise(seed * 17 + 5);
  // where water moves under the ice
  const inlet = L.lakeShore(dcos(L.LAKE_IN), dsin(L.LAKE_IN), -6, seed);
  const outlet = L.lakeShore(dcos(L.LAKE_OUT), dsin(L.LAKE_OUT), -6, seed);
  const thin: { x: number; z: number; r: number }[] = [
    { x: inlet.x, z: inlet.z, r: 34 },
    { x: outlet.x, z: outlet.z, r: 30 },
  ];
  // a few seeded patches out in the open, away from the safe line and the hut
  for (let k = 0, tries = 0; k < 4 && tries < 300; tries++) {
    const a = hash01(seed, 9100, tries) * TAU, rr = 30 + hash01(seed, 9101, tries) * 85;
    const x = L.LAKE_X + rr * dcos(a), z = L.LAKE_Z + rr * dsin(a);
    if (L.lakeSdf(x, z, seed) > -22) continue;
    if (segDist(x, z, safe) < 26 || dlen(x - hut.x, z - hut.z) < 30) continue;
    let clash = false;
    for (const t of thin) if (dlen(t.x - x, t.z - z) < t.r + 20) clash = true;
    if (clash) continue;
    thin.push({ x, z, r: 9 + hash01(seed, 9102, tries) * 7 });
    k++;
  }
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const x = minX + (cx + 0.5) * ICE_CELL, z = minZ + (cz + 0.5) * ICE_CELL;
      const sdf = L.lakeSdf(x, z, seed);
      if (sdf > ICE_CELL * 0.75) continue; // no part of this cell is on the lake
      const inward = -sdf; // metres from the shore
      let v = 0.27 + 0.11 * nz.fbm(x / 40, z / 40, 2);
      // thick along the shore, thinning over the first twenty metres out
      if (inward < 22) v = Math.max(v, 0.5 + 0.18 * (1 - smooth01(2, 22, inward)));
      // thin where water moves or the patches are
      for (const t of thin) {
        const d = dlen(x - t.x, z - t.z);
        if (d < t.r) {
          const w = 1 - smooth01(t.r * 0.45, t.r, d);
          const tv = 0.05 + 0.05 * (1 - w) + 0.015 * nz.at(x / 9, z / 9);
          v += (Math.min(v, tv) - v) * w;
        }
      }
      // the safe line and the hut stay thick whatever else
      const ds = segDist(x, z, safe);
      if (ds < 6) v = Math.max(v, 0.56 + 0.06 * (1 - ds / 6));
      if (dlen(x - hut.x, z - hut.z) < 10) v = Math.max(v, 0.62);
      thickness[cz * n + cx] = Math.max(0.04, v);
    }
  }
  return { info: { x: L.LAKE_X, z: L.LAKE_Z, level: L.LAKE_LEVEL, n, cell: ICE_CELL, minX, minZ, thickness }, thin };
}

/** Cell index of the ice under (x, z), or -1 if the point is not on the lake. */
export function iceCellOf(info: LakeInfo, seed: number, x: number, z: number): number {
  const cx = Math.floor((x - info.minX) / info.cell), cz = Math.floor((z - info.minZ) / info.cell);
  if (cx < 0 || cz < 0 || cx >= info.n || cz >= info.n) return -1;
  if (L.lakeSdf(x, z, seed) > 0) return -1;
  const i = cz * info.n + cx;
  return info.thickness[i] > 0 ? i : -1;
}
