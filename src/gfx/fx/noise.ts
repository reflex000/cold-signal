// Noise for the fx shaders and the particle simulation: one tileable RGBA8 noise texture built at
// load (no files), and a small deterministic random stream for the CPU side.
//
// Texture channels (256 x 256, wraps on both axes, each channel stretched to the full 0..1 range):
//   R  fbm, 4 octaves from 4 cells across   (big billows: smoke shape, flame warp)
//   G  fbm, 4 octaves from 8 cells across   (flame tongues, detail)
//   B  fbm, 3 octaves from 16 cells across  (fine breakup)
//   A  cellular (1 - distance to the nearest of 10 x 10 jittered points): coal lumps, crystals
// Thresholding magnified 8-bit noise shows stair steps (THREE_NOTES 12): shaders always mix two
// channels before they threshold.
// Owner: FX.
import * as THREE from 'three/webgpu';

/** 32-bit integer hash to [0, 1). */
export function hashU(n: number): number {
  let x = Math.imul((n | 0) ^ 0x27d4eb2d, 0x85ebca6b);
  x ^= x >>> 15;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 13;
  x = Math.imul(x, 0x165667b1);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Hash of two integers to [0, 1). */
export function hash2(a: number, b: number): number {
  return hashU(Math.imul(a | 0, 0x1f1f1f1f) ^ Math.imul(b | 0, 0x2545f491));
}

/** A small, fast deterministic random stream (mulberry32). */
export class Rand {
  private s: number;
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Symmetric: -a .. a. */
  sym(a: number): number {
    return (this.next() * 2 - 1) * a;
  }
}

// ---------------------------------------------------------------------------------------------
// Tileable gradient noise
// ---------------------------------------------------------------------------------------------

function grad(ix: number, iy: number, period: number, seed: number, x: number, y: number): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  const a = hash2(px + seed * 1013, py - seed * 7919) * Math.PI * 2;
  return Math.cos(a) * x + Math.sin(a) * y;
}

/** Perlin noise of period `period` cells, about -0.7 .. 0.7. */
function perlin(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad(ix, iy, period, seed, fx, fy);
  const b = grad(ix + 1, iy, period, seed, fx - 1, fy);
  const c = grad(ix, iy + 1, period, seed, fx, fy - 1);
  const d = grad(ix + 1, iy + 1, period, seed, fx - 1, fy - 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, p = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(u * p, v * p, p, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function cellular(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
      const px = cx + 0.15 + 0.7 * hash2(wx * 3 + seed, wy * 5 - seed);
      const py = cy + 0.15 + 0.7 * hash2(wx * 7 - seed, wy * 11 + seed);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

let shared: THREE.DataTexture | null = null;

/** The shared fx noise texture (built once). */
export function noiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const N = 256;
  const ch = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = y * N + x;
      ch[0][i] = fbm(u, v, 4, 4, 11);
      ch[1][i] = fbm(u, v, 8, 4, 23);
      ch[2][i] = fbm(u, v, 16, 3, 37);
      ch[3][i] = 1 - cellular(u, v, 10, 41);
    }
  }
  const data = new Uint8Array(N * N * 4);
  for (let c = 0; c < 4; c++) {
    const a = ch[c];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < a.length; i++) {
      if (a[i] < lo) lo = a[i];
      if (a[i] > hi) hi = a[i];
    }
    const k = 1 / Math.max(1e-6, hi - lo);
    for (let i = 0; i < a.length; i++) data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, (a[i] - lo) * k)) * 255);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'fx.noise';
  t.needsUpdate = true;
  shared = t;
  return t;
}
