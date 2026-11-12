// Seeded value / gradient noise on the CPU. Pure functions of (seed, coordinates).
import { hash32 } from './rng';

const h01 = (s: number, x: number, y: number) => hash32(s, x, y) / 4294967296;
const q = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 1D value noise in [-1, 1]. */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash32(seed, i) / 2147483648 - 1;
  const b = hash32(seed, i + 1) / 2147483648 - 1;
  return a + (b - a) * q(f);
}

/** 2D gradient noise in about [-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const g = (cx: number, cy: number) => {
    const a = h01(seed, ix + cx, iy + cy) * 6.283185307;
    return Math.cos(a) * (fx - cx) + Math.sin(a) * (fy - cy);
  };
  const u = q(fx), v = q(fy);
  const a = g(0, 0), b = g(1, 0), c = g(0, 1), d = g(1, 1);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 1.4142;
}

/** Fractal sum of noise2, in about [-1, 1]. */
export function fbm2(seed: number, x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * noise2(seed + o * 131, x * f, y * f);
    n += a;
    a *= gain;
    f *= lacunarity;
  }
  return s / n;
}

/** Ridged multifractal in [0, 1]: sharp crests, good for mountain ridges. */
export function ridged2(seed: number, x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let a = 1, f = 1, s = 0, n = 0, w = 1;
  for (let o = 0; o < octaves; o++) {
    let r = 1 - Math.abs(noise2(seed + o * 197, x * f, y * f));
    r = r * r * w;
    w = Math.min(1, r * 2);
    s += a * r;
    n += a;
    a *= gain;
    f *= lacunarity;
  }
  return s / n;
}

/** Cellular (Worley) F1 distance in [0, ~1]. */
export function worley2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let d = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const px = cx + h01(seed, cx, cy), py = cy + h01(seed + 7, cx, cy);
      const dd = (px - x) * (px - x) + (py - y) * (py - y);
      if (dd < d) d = dd;
    }
  return Math.sqrt(d);
}
