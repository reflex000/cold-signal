// Terrain constants and the level-of-detail configuration per quality tier.
// Owner: TERRAIN.
import type { Quality } from '../api';
import { HORIZON_ATLAS } from '../shared';

/** Half size of the whole terrain domain: 3 x 3 root nodes of ROOT metres. */
export const DOMAIN_HALF = 6144;
/** Size of a quadtree root node (the coarsest LOD), metres. */
export const ROOT = 4096;
/** Nothing is drawn beyond this distance from the world origin (the far ring falls away behind its crest). */
export const RING_OUTER = 5400;
/** Width of the band inside the heightmap edge where heights blend from the heightmap to the far map. */
export const EDGE_BLEND = 96;

/** Far map: the mountain ring and a smoothed copy of the heightmap, one R32F texture. */
export const FAR_N = 513;
export const FAR_CELL = 24;
export const FAR_ORIGIN = -DOMAIN_HALF;

/** Horizon (terrain shadow) maps: one atlas shared with every material, layout in ../shared.ts. */
export const HORIZON_INNER = HORIZON_ATLAS.inner; // texels over the heightmap square (4 m)
export const HORIZON_OUTER = HORIZON_ATLAS.outer; // texels over the whole domain (48 m)

export interface LodConfig {
  /** Quads per node side (power of two). Quarter nodes use n / 2. */
  n: number;
  /** Finest cell size in metres (LOD 0). */
  cell0: number;
  /** LOD range = k * node size. CDLOD needs k > 2.36 for crack-free joins with a 0.8 morph start. */
  k: number;
  /** Number of LOD levels; the coarsest has nodes of ROOT metres. */
  levels: number;
  /** LOD levels below this one have cells finer than the 2 m heightmap: Catmull-Rom heights there. */
  cubicLod: number;
  /** Most nodes drawn per mesh per frame. */
  maxNodes: number;
}

/** quality.terrainDetail (0..3) -> mesh layout. Detail 0 is the phone tier. */
export function lodConfig(detail: number): LodConfig {
  const d = Math.max(0, Math.min(3, Math.round(detail)));
  // [quads per node, finest cell, range / node size]. Cells per LOD band = n * k: the mesh density.
  const table: [number, number, number][] = [
    [16, 0.5, 2.5], // mobile: 40 cells per band, 0.5 m cells within 20 m
    [16, 0.5, 2.6], // low: 42
    [16, 0.25, 3.4], // medium: 54, 0.25 m cells within 14 m, 2 m from 55 m
    [32, 0.25, 3.0], // high / ultra: 96
  ];
  const [n, cell0, k] = table[d];
  const s0 = n * cell0;
  const levels = Math.round(Math.log2(ROOT / s0)) + 1;
  const cubicLod = Math.max(0, Math.round(Math.log2(2 / cell0)));
  return { n, cell0, k, levels, cubicLod, maxNodes: 2048 };
}

/** Range of LOD level l (metres, effective distance). */
export function lodRange(c: LodConfig, l: number): number {
  return c.k * c.n * c.cell0 * Math.pow(2, l);
}

/** Material feature level from the quality preset. */
export interface MaterialTier {
  /** Phone path: fewer noise taps, no sparkle, no triplanar rock. */
  mobile: boolean;
  sparkle: boolean;
}

export function materialTier(q: Quality): MaterialTier {
  const mobile = q.name === 'mobile';
  return { mobile, sparkle: !mobile && q.terrainDetail >= 1 };
}
