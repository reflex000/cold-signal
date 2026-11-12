// Trees and rocks. Both are placed on a jittered grid (one candidate per cell at a hashed
// position, accepted by a density) with a minimum distance to the neighbours already taken:
// that gives a blue-noise-like spread with no grid look, and the forest mask's clump noise
// gives clearings and groves. Every placed object is also its own circle collider (extra
// fields s, r, y0, y1), so there are no per-tree collider objects beside the TreeInst list.
import { hash01 } from '../core/rng';
import { smooth01, TAU } from './dmath';
import { sampleCoarse, TAN40 } from './fields';
import * as L from './layout';
import type { RockInst, TreeInst } from './types';

const N = L.N;
const EXT = L.EXTENT;
const CELL = L.CELL;

export type TreeObj = TreeInst & { s: 'c'; r: number; y0: number; y1: number };
export type RockObj = RockInst & { s: 'c'; r: number; y0: number; y1: number };

export interface ClearGrid { has(x: number, z: number, pad: number): boolean }

/** A coarse grid of circles for "is this point inside any clearing" tests. */
export function makeClearGrid(circles: { x: number; z: number; r: number }[]): ClearGrid {
  const C = 32, GN = Math.ceil((EXT * 2) / C);
  const cells: number[][] = [];
  for (let i = 0; i < GN * GN; i++) cells.push([]);
  circles.forEach((c, idx) => {
    const R = c.r + 4;
    const i0 = Math.max(0, Math.floor((c.x - R + EXT) / C)), i1 = Math.min(GN - 1, Math.floor((c.x + R + EXT) / C));
    const j0 = Math.max(0, Math.floor((c.z - R + EXT) / C)), j1 = Math.min(GN - 1, Math.floor((c.z + R + EXT) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * GN + i].push(idx);
  });
  return {
    has(x, z, pad) {
      const i = Math.floor((x + EXT) / C), j = Math.floor((z + EXT) / C);
      if (i < 0 || j < 0 || i >= GN || j >= GN) return false;
      for (const idx of cells[j * GN + i]) {
        const c = circles[idx];
        const dx = x - c.x, dz = z - c.z, r = c.r + pad;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    },
  };
}

function grad(h: Float32Array, x: number, z: number): number {
  let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
  const i = Math.max(1, Math.min(N - 2, Math.round(fx))), j = Math.max(1, Math.min(N - 2, Math.round(fz)));
  const k = j * N + i;
  const gx = (h[k + 1] - h[k - 1]) / (2 * CELL), gz = (h[k + N] - h[k - N]) / (2 * CELL);
  fx = gx;
  fz = gz;
  return Math.sqrt(fx * fx + fz * fz);
}

function maskAt(m: Uint8Array, ch: number, x: number, z: number): number {
  let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
  if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
  if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = (j * N + i) * 4 + ch;
  const a = m[k], b = m[k + 4], c = m[k + N * 4], d = m[k + N * 4 + 4];
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) / 255;
}

export interface ScatterInput {
  seed: number;
  h: Float32Array;
  masks: Uint8Array;
  lee: Float32Array;
  exposure: Float32Array;
  clear: ClearGrid;
  heightAt: (x: number, z: number) => number;
}

export function scatterTrees(inp: ScatterInput): TreeObj[] {
  const { seed, h, masks, clear, heightAt } = inp;
  const C = 3.15;
  const X0 = -796;
  const GN = Math.floor((796 * 2) / C);
  const taken = new Int32Array(GN * GN).fill(-1);
  const trees: TreeObj[] = [];
  const S = seed * 31 + 17;
  for (let cj = 0; cj < GN; cj++) {
    for (let ci = 0; ci < GN; ci++) {
      const x = X0 + (ci + hash01(S, ci, cj)) * C;
      const z = X0 + (cj + hash01(S + 1, ci, cj)) * C;
      const f = maskAt(masks, 0, x, z);
      if (f < 0.02) continue;
      const p = 0.53 * f * Math.sqrt(f);
      const roll = hash01(S + 2, ci, cj);
      // a few saplings and young trees seed into the edges of the forest
      const edge = f < 0.35 && roll < p + 0.035 * smooth01(0.02, 0.2, f);
      if (roll >= p && !edge) continue;
      if (maskAt(masks, 3, x, z) > 0.25) continue; // the packed trail
      if (grad(h, x, z) > TAN40) continue;
      if (clear.has(x, z, 1.5)) continue;
      const kr = hash01(S + 3, ci, cj);
      const hv = heightAt(x, z);
      let kind: TreeInst['kind'];
      if (edge || kr < 0.04 + 0.14 * (1 - f)) kind = 'sapling';
      else if (kr > 0.97) kind = 'snag';
      else kind = hash01(S + 4, ci, cj) < 0.3 + 0.45 * smooth01(170, 330, hv) ? 'fir' : 'pine';
      const minD = kind === 'sapling' ? 1.3 : 2.4;
      // distance to neighbours already taken
      let ok = true;
      for (let dj = -1; dj <= 1 && ok; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= GN || nj >= GN) continue;
          const t = taken[nj * GN + ni];
          if (t < 0) continue;
          const o = trees[t];
          const md = o.kind === 'sapling' || kind === 'sapling' ? 1.3 : minD;
          if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < md * md) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      const lee = sampleCoarse(inp.lee, x, z), exp = sampleCoarse(inp.exposure, x, z);
      const r1 = hash01(S + 5, ci, cj), r2 = hash01(S + 6, ci, cj), r3 = hash01(S + 7, ci, cj);
      const high = smooth01(285, 362, hv);
      let scale: number, snow: number, r: number, top: number;
      if (kind === 'sapling') {
        scale = 0.16 + 0.24 * r1;
        snow = 0.4 + 0.5 * r2;
        r = 0;
        top = 5 * scale;
      } else if (kind === 'snag') {
        scale = 0.55 + 0.45 * r1;
        snow = 0.08 + 0.15 * r2;
        r = 0.1 + 0.14 * scale;
        top = 13 * scale;
      } else {
        // taller in sheltered hollows, stunted toward the tree line
        scale = (0.66 + 0.56 * r1 * r1 + 0.12 * lee) * (1 - 0.42 * high) * (0.85 + 0.3 * f);
        snow = Math.max(0.05, Math.min(1, 0.52 + 0.35 * lee - 0.42 * exp + 0.3 * (r2 - 0.5)));
        r = 0.12 + 0.2 * scale;
        top = 14 * scale;
      }
      taken[cj * GN + ci] = trees.length;
      trees.push({
        x, y: hv, z, scale, yaw: r3 * TAU, variant: Math.floor(hash01(S + 8, ci, cj) * 8), kind, snow,
        s: 'c', r, y0: hv - 0.5, y1: hv + top,
      });
    }
  }
  return trees;
}

export function scatterRocks(inp: ScatterInput): RockObj[] {
  const { seed, h, masks, clear, heightAt } = inp;
  const C = 6.5;
  const X0 = -830;
  const GN = Math.floor((830 * 2) / C);
  const rocks: RockObj[] = [];
  const S = seed * 37 + 101;
  const push = (x: number, z: number, sx: number, sy: number, sz: number, yaw: number, tilt: number, variant: number) => {
    const y = heightAt(x, z);
    const big = Math.max(sx, sz) >= 0.55;
    const r = big ? 0.8 * (sx + sz) * 0.5 : 0;
    rocks.push({ x, y, z, sx, sy, sz, yaw, tilt, variant, s: 'c', r, y0: y - 1, y1: y + sy * 0.9 });
  };
  for (let cj = 0; cj < GN; cj++) {
    for (let ci = 0; ci < GN; ci++) {
      const x = X0 + (ci + hash01(S, ci, cj)) * C;
      const z = X0 + (cj + hash01(S + 1, ci, cj)) * C;
      if (maskAt(masks, 2, x, z) > 0.02) continue; // lake
      const rk = maskAt(masks, 1, x, z);
      // talus: below rock, the ground is strewn with what fell off it
      let near = 0;
      for (let q = 0; q < 4; q++) {
        const ox = q === 0 ? 7 : q === 1 ? -7 : 0, oz = q === 2 ? 7 : q === 3 ? -7 : 0;
        const v = maskAt(masks, 1, x + ox, z + oz);
        if (v > near) near = v;
      }
      const talus = near * (1 - rk);
      const f = maskAt(masks, 0, x, z);
      const inRavine = z > L.RAVINE_TOP && z < 820 && Math.abs(x - L.ravineX(z)) < 40 ? 1 : 0;
      const p = 0.01 + 0.3 * rk + 0.5 * talus + 0.12 * inRavine + 0.015 * f;
      if (hash01(S + 2, ci, cj) >= p) continue;
      if (maskAt(masks, 3, x, z) > 0.2) continue;
      if (clear.has(x, z, 2)) continue;
      const g = grad(h, x, z);
      const r1 = hash01(S + 3, ci, cj), r2 = hash01(S + 4, ci, cj), r3 = hash01(S + 5, ci, cj), r4 = hash01(S + 6, ci, cj);
      let sx: number, sy: number, sz: number;
      if (rk > 0.55 && r4 < 0.55) {
        // outcrop: broad and low, bedded with the slope
        sx = 1.5 + 2.4 * r1;
        sz = sx * (0.5 + 0.4 * r2);
        sy = 0.7 + 1.0 * r3;
      } else if (f > 0.4 && r4 < 0.2) {
        // an erratic boulder in the forest
        sx = 1.0 + 1.3 * r1;
        sz = sx * (0.7 + 0.3 * r2);
        sy = sx * (0.6 + 0.3 * r3);
      } else {
        // talus block
        const s = 0.3 + 1.5 * r1 * r1;
        sx = s;
        sz = s * (0.6 + 0.4 * r2);
        sy = s * (0.5 + 0.4 * r3);
      }
      const tilt = Math.min(0.5, g * 0.4) * (r2 - 0.5) * 2;
      push(x, z, sx, sy, sz, hash01(S + 7, ci, cj) * TAU, tilt, Math.floor(hash01(S + 8, ci, cj) * 8));
    }
  }
  // house-sized blocks fallen into the slot of the lower ravine (with ways between them: the
  // floor below must stay connected to the floor above, or it would be a pit to fall into)
  const cz = L.CHOKE_Z;
  const blocks: [number, number, number][] = [
    [-3.9, -6, 2.2], [3.6, 3, 2.5], [-2.8, 16, 1.9], [2.9, 31, 2.1],
  ];
  blocks.forEach((b, k) => {
    const z = cz + b[1];
    const x = L.ravineX(z) + b[0];
    const s = b[2];
    push(x, z, s, s * 0.95, s * 0.85, hash01(S + 9, k, 0) * TAU, 0.15 * (hash01(S + 10, k, 0) - 0.5), k % 8);
  });
  return rocks;
}
