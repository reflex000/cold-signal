// The far map: one R32F grid (FAR_N^2, FAR_CELL m) over the whole terrain domain. Inside the
// heightmap square it holds a box-filtered copy of world.heightmap (used by distant LODs and the
// horizon pass); outside it holds the ring of mountains around the play area, generated from the
// seed so every client sees the same horizon:
//   - the edge of the heightmap is extended outward from a smoothed edge profile, so the join
//     is continuous, then ramps into
//   - ridged, domain-warped mountains whose base height and relief depend on direction: the summit
//     massif rising behind the north wall, flanking ridges east and west, a broad valley south of
//     the crash site (open below the ravine mouth) and a lower range beyond it. Everything falls
//     away behind the crests before RING_OUTER, so the edge of the domain (and the camera far plane)
//     is never seen from the play area.
// Pure CPU, about 300 ms on this machine. Owner: TERRAIN.
import type { World } from '../../world/types';
import { Noise } from '../../world/fastnoise';
import { FAR_CELL, FAR_N, FAR_ORIGIN, RING_OUTER } from './config';

export interface FarMap {
  data: Float32Array;
  n: number;
  cell: number;
  origin: number;
  min: number;
  max: number;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Bilinear sample of world.heightmap, clamped to its square. */
export function sampleHeightmap(world: World, x: number, z: number): number {
  const hm = world.heightmap;
  const n = hm.n;
  const cell = (hm.extent * 2) / (n - 1);
  let fx = (x + hm.extent) / cell;
  let fz = (z + hm.extent) / cell;
  fx = Math.min(n - 1.000001, Math.max(0, fx));
  fz = Math.min(n - 1.000001, Math.max(0, fz));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const d = hm.data;
  const k = j * n + i;
  const a = d[k], b = d[k + 1], c = d[k + n], e = d[k + n + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
}

/**
 * Smoothed height along the border of the heightmap square, as a function of the nearest border
 * point. Averaged a little inward and along the border so that extruding it outward does not
 * streak.
 */
function edgeProfile(world: World): (ex: number, ez: number) => number {
  const E = world.heightmap.extent;
  const STEP = 8;
  const M = Math.round((2 * E) / STEP) + 1;
  // one array per side, indexed along the side from -E to +E
  const sides: Float32Array[] = [];
  for (let s = 0; s < 4; s++) {
    const raw = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const t = -E + i * STEP;
      let sum = 0, cnt = 0;
      for (let k = 0; k <= 24; k += 4) {
        // s: 0 north (z = -E), 1 south (z = +E), 2 west (x = -E), 3 east (x = +E); k = metres inward
        const x = s === 0 || s === 1 ? t : s === 2 ? -E + k : E - k;
        const z = s === 2 || s === 3 ? t : s === 0 ? -E + k : E - k;
        sum += sampleHeightmap(world, x, z);
        cnt++;
      }
      raw[i] = sum / cnt;
    }
    // box blur along the side, +-160 m, twice (close to a Gaussian)
    let a = raw;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(M);
      const R = 20;
      for (let i = 0; i < M; i++) {
        let sum = 0, cnt = 0;
        for (let k = -R; k <= R; k++) {
          const j = Math.min(M - 1, Math.max(0, i + k));
          sum += a[j];
          cnt++;
        }
        out[i] = sum / cnt;
      }
      a = out;
    }
    sides.push(a);
  }
  const at = (side: Float32Array, t: number): number => {
    const f = Math.min(M - 1.000001, Math.max(0, (t + E) / STEP));
    const i = Math.floor(f);
    return side[i] + (side[i + 1] - side[i]) * (f - i);
  };
  return (ex: number, ez: number): number => {
    // blend the two sides that meet near a corner so the extrusion has no seam on the diagonals
    const dN = ez + E, dS = E - ez, dW = ex + E, dE = E - ex;
    const w = (d: number) => 1 / (0.5 + d * d);
    const wn = w(dN), ws = w(dS), ww = w(dW), we = w(dE);
    const sum = wn * at(sides[0], ex) + ws * at(sides[1], ex) + ww * at(sides[2], ez) + we * at(sides[3], ez);
    return sum / (wn + ws + ww + we);
  };
}

/** Build the far map for this world. Deterministic in the seed. */
export function buildFarMap(world: World): FarMap {
  const seed = world.seed;
  const n = FAR_N, cell = FAR_CELL, origin = FAR_ORIGIN;
  const data = new Float32Array(n * n);
  const E = world.heightmap.extent;
  const noise = new Noise((seed ^ 0x7a3d91) >>> 0);
  const warp = new Noise((seed ^ 0x1c55e3) >>> 0);
  const broad = new Noise((seed ^ 0x4b2a17) >>> 0);
  // The valley south of the crash site leaves the map at the ravine mouth: find it on the edge.
  let mouthX = 0;
  {
    let lo = Infinity;
    for (let x = -E + 100; x <= E - 100; x += 8) {
      const h = sampleHeightmap(world, x, E - 4);
      if (h < lo) {
        lo = h;
        mouthX = x;
      }
    }
  }
  const edge = edgeProfile(world);

  let mn = Infinity, mx = -Infinity;
  for (let j = 0; j < n; j++) {
    const z = origin + j * cell;
    for (let i = 0; i < n; i++) {
      const x = origin + i * cell;
      let h: number;
      if (Math.abs(x) <= E && Math.abs(z) <= E) {
        // inside: box filter of the heightmap over the far cell (2 m samples, +-12 m)
        let sum = 0, cnt = 0;
        for (let dz = -12; dz <= 12; dz += 4) {
          for (let dx = -12; dx <= 12; dx += 4) {
            sum += sampleHeightmap(world, x + dx, z + dz);
            cnt++;
          }
        }
        h = sum / cnt;
      } else {
        const ex = Math.min(E, Math.max(-E, x));
        const ez = Math.min(E, Math.max(-E, z));
        const d = Math.hypot(x - ex, z - ez); // metres outside the square
        const r = Math.max(1, Math.hypot(x, z));
        const he = edge(ex, ez);
        // Regions by direction: the summit massif rises behind the north wall, ridges flank east and
        // west, and the south opens into a broad valley with a lower range beyond it.
        const dn = -z / r, ds = z / r;
        const wN = smooth(0.15, 0.8, dn), wS = smooth(0.15, 0.8, ds);
        const wSide = Math.max(0, 1 - wN - wS);
        const baseN = 960 + 1350 * smooth(0, 3200, d);
        const baseW = 640 + 760 * smooth(0, 2600, d);
        const baseS = 300 - 210 * smooth(0, 1200, d) + 820 * smooth(1900, 3700, d);
        const ampN = 1150, ampW = 820, ampS = 90 + 1050 * smooth(1900, 3400, d);
        const base = wN * baseN + wS * baseS + wSide * baseW;
        let amp = wN * ampN + wS * ampS + wSide * ampW;
        // the valley floor south of the ravine mouth stays open and low
        const vx = x - mouthX - 0.22 * (z - E);
        const valley = wS * smooth(700, 0, Math.abs(vx)) * smooth(2900, 1800, d);
        amp *= 1 - 0.85 * valley;
        // Ridges: domain-warped ridged multifractal, sharpened so crests are narrow and valleys broad.
        const qx = x + 900 * warp.fbm(x / 3100, z / 3100, 3);
        const qz = z + 900 * warp.fbm(x / 3100 + 7.3, z / 3100 - 2.1, 3);
        const rg = noise.ridged(qx / 3300, qz / 3300, 7, 0.5);
        const massif = 0.75 + 0.5 * broad.fbm(x / 5200 + 1.7, z / 5200 - 4.4, 2); // big highs and lows
        const relief = amp * massif * (Math.pow(rg, 1.7) - 0.18);
        let hm = base + relief - 140 * valley;
        // behind the far crest the land falls away out of sight of the play area
        hm = hm - (hm - 60) * 0.85 * smooth(4700, RING_OUTER, r);
        // the heightmap's edge continues outward, ramping quickly into the generated land
        const ramp = smooth(0, 420, d);
        h = he + (hm - he) * ramp;
      }
      data[j * n + i] = h;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return { data, n, cell, origin, min: mn, max: mx };
}

/** Bilinear sample of the far map. */
export function sampleFar(f: FarMap, x: number, z: number): number {
  let fx = (x - f.origin) / f.cell;
  let fz = (z - f.origin) / f.cell;
  fx = Math.min(f.n - 1.000001, Math.max(0, fx));
  fz = Math.min(f.n - 1.000001, Math.max(0, fz));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * f.n + i;
  const d = f.data;
  const a = d[k], b = d[k + 1], c = d[k + f.n], e = d[k + f.n + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
}
