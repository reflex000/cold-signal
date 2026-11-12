// Table-driven gradient noise for world generation. core/noise is exact but hashes every
// lattice corner; building a 1025 x 1025 mountain needs tens of millions of samples, so this
// one uses a seeded permutation table. Pure: the same seed gives the same field on every JS
// engine (the gradient table uses the deterministic dcos / dsin; sampling is only + - * floor).
import { hash32, rngStep } from '../core/rng';
import { dcos, dsin } from './dmath';

export class Noise {
  private readonly p = new Uint8Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gy = new Float32Array(256);

  constructor(seed: number) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = hash32(seed, 0x51ed) | 0;
    for (let i = 255; i > 0; i--) {
      const r = rngStep(s);
      s = r[0];
      const j = Math.floor(r[1] * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    for (let i = 0; i < 256; i++) {
      // 256 evenly spread directions, shuffled: no axis-aligned bias, no trig per sample.
      const a = ((perm[(i * 97 + 13) & 255] + 0.5) / 256) * 6.283185307179586;
      this.gx[i] = dcos(a);
      this.gy[i] = dsin(a);
    }
  }

  /** Gradient noise in about [-1, 1]. */
  at(x: number, y: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const ix = x0 & 255, iy = y0 & 255;
    const p = this.p, gx = this.gx, gy = this.gy;
    const a = p[p[ix] + iy], b = p[p[ix + 1] + iy], c = p[p[ix] + iy + 1], d = p[p[ix + 1] + iy + 1];
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const n00 = gx[a] * fx + gy[a] * fy;
    const n10 = gx[b] * (fx - 1) + gy[b] * fy;
    const n01 = gx[c] * fx + gy[c] * (fy - 1);
    const n11 = gx[d] * (fx - 1) + gy[d] * (fy - 1);
    const top = n00 + (n10 - n00) * u;
    const bot = n01 + (n11 - n01) * u;
    return (top + (bot - top) * v) * 1.4142;
  }

  /** Fractal sum, about [-1, 1]. */
  fbm(x: number, y: number, octaves: number, gain = 0.5, lac = 2.03): number {
    let a = 1, s = 0, n = 0;
    for (let o = 0; o < octaves; o++) {
      s += a * this.at(x + o * 17.31, y - o * 9.73);
      n += a;
      a *= gain;
      x *= lac;
      y *= lac;
    }
    return s / n;
  }

  /** Ridged multifractal in [0, 1]: sharp crests, rounded hollows. */
  ridged(x: number, y: number, octaves: number, gain = 0.5, lac = 2.03): number {
    let a = 1, s = 0, n = 0, w = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(this.at(x + o * 31.7, y + o * 11.9));
      r = r * r * w;
      w = r * 2 > 1 ? 1 : r * 2;
      s += a * r;
      n += a;
      a *= gain;
      x *= lac;
      y *= lac;
    }
    return s / n;
  }
}
