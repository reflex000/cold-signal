// Constants of the snow-deformation system, shared by the painter (stamps.ts / painter.ts), the
// terrain shader helpers (sample.ts) and the CPU queries. No three.js here (records.ts and
// tracks.ts run in unit tests). Owner: SNOW.
import type { Quality } from '../api';

/** Metres of press depth that R = 1 stands for (a body in deep powder, a boot sunk to the shin). */
export const DEPTH_MAX = 0.45;
/** Metres of raised snow (rims, berms, kicked clumps) that B = 1 stands for. */
export const RIM_MAX = 0.12;
/** Half range of the edge distance stored in G: G = 0.5 + sdf / (2 * SDF_RANGE), sdf > 0 inside. */
export const SDF_RANGE = 0.08;
/** Physical width of a pressed wall (m): snow pressed by a boot stands almost vertical. */
export const WALL = 0.012;
/** Depth scale the TERRAIN bench's legacy painter means by R = 1 (U.trailOn = 1). */
export const LEGACY_DEPTH = 0.14;

/** Fill (m of new or drifted snow) that hides the compacted look of a print floor. */
export const FRESH_FILL = 0.015;
/** Fill that rounds a print's walls completely. */
export const SOFT_FILL = 0.05;
/** Rims are knocked down and buried faster than the hollows fill. */
export const RIM_FILL_RATE = 2.5;
/**
 * Depth a hollow loses per metre of fill. Below 1: new snow bridges and drapes a narrow hole rather
 * than levelling it, so a deep print survives a few minutes of storm as a soft dimple.
 */
export const DEPTH_FILL_RATE = 0.85;

export interface SnowTier {
  /** Near window: texels across and metres across. */
  nearN: number;
  nearSize: number;
  /** Far window (0 texels = none). */
  farN: number;
  farSize: number;
  /** Inside prints: march toward the key light for crisp shadows. */
  shadows: boolean;
  /** Most records drawn by one re-render of the near / far window. */
  nearCap: number;
  farCap: number;
}

/**
 * Window sizes per quality. Quality.snowDeform is the near texture size; 'mobile' asks for 0 (the
 * contract's "decals only"), which here means the smallest window and no far map: the same code
 * path, one 256^2 RGBA8 target, no extra passes.
 */
export function snowTier(q: Quality): SnowTier {
  const mobile = q.name === 'mobile';
  const n = Math.max(256, Math.min(2048, q.snowDeform || 256));
  const nearN = mobile ? 256 : n;
  const nearSize = nearN <= 256 ? 16 : nearN <= 512 ? 20 : nearN <= 1024 ? 24 : 32;
  const farN = mobile ? 0 : Math.min(1024, nearN);
  const farSize = farN <= 256 ? 192 : farN <= 512 ? 256 : 384;
  return {
    nearN,
    nearSize,
    farN,
    farSize,
    shadows: !mobile && q.name !== 'low',
    nearCap: mobile ? 2048 : 8192,
    farCap: 32768,
  };
}

/** Stamp kinds (the painter's shapes). Plain numbers: they travel to the GPU as floats. */
export const K_BOOT = 0;
export const K_PAW = 1;
/** Capsule along local t: drags, crawls, a log's bed, toe drags in deep snow. */
export const K_GROOVE = 2;
export const K_BODY = 3;
/** Kicked snow only: raised clumps, no hollow. */
export const K_KICK = 4;
/** Round hollow: flare melt, bullet hole. */
export const K_PIT = 5;

/** Record flags. */
export const F_LEFT = 1;
export const F_RUN = 2;
export const F_DEEP = 4;
export const F_PACKED = 8;
export const F_FRONT = 16; // wolf front paw (larger, toes spread)
export const F_SOFT = 32; // a dragged foot's furrow: sloped, crumbling sides instead of a pressed wall
