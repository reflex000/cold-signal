// Small tileable noise textures for the terrain material, generated once on the CPU (no files).
//   detail (256^2 RGBA8): r = smooth gradient-noise height, g / b = its derivative along u / v
//     (so one tap gives a bump normal without screen derivatives), a = an independent finer noise.
//   cells (256^2 RGBA8): r = Voronoi crack distance (F2 - F1, 0 on the crack), g = F1, b = a random
//     value per cell, a = fine value noise (grain).
// Fixed seeds: the ground must look the same on every machine. Owner: TERRAIN.
import * as THREE from 'three/webgpu';

const SIZE = 256;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Periodic 2D gradient noise, period `p` lattice cells over the unit square, value about -1..1. */
function periodicNoise(p: number, seed: number): (u: number, v: number) => number {
  const r = rng(seed);
  const gx = new Float32Array(p * p), gy = new Float32Array(p * p);
  for (let i = 0; i < p * p; i++) {
    const a = r() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (u: number, v: number) => {
    const x = u * p, y = v * p;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const i0 = ((x0 % p) + p) % p, j0 = ((y0 % p) + p) % p;
    const i1 = (i0 + 1) % p, j1 = (j0 + 1) % p;
    const g = (i: number, j: number, dx: number, dy: number) => gx[j * p + i] * dx + gy[j * p + i] * dy;
    const n00 = g(i0, j0, fx, fy), n10 = g(i1, j0, fx - 1, fy);
    const n01 = g(i0, j1, fx, fy - 1), n11 = g(i1, j1, fx - 1, fy - 1);
    const a = fade(fx), b = fade(fy);
    const top = n00 + (n10 - n00) * a, bot = n01 + (n11 - n01) * a;
    return (top + (bot - top) * b) * 1.41;
  };
}

function makeTex(data: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

let detailTex: THREE.DataTexture | null = null;
let cellTex: THREE.DataTexture | null = null;

/** Scale of the stored derivative: g = 0.5 + dh/du / DERIV_RANGE (h in 0..1, u in texture units). */
export const DERIV_RANGE = 40;

export function getDetailTexture(): THREE.DataTexture {
  if (detailTex) return detailTex;
  const a = periodicNoise(8, 0x1234567), b = periodicNoise(16, 0x89abcde), c = periodicNoise(32, 0x2468ace);
  const e = periodicNoise(24, 0x13579bd), f = periodicNoise(48, 0x7f4a7c1);
  const h = new Float32Array(SIZE * SIZE);
  const q = new Float32Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const u = (i + 0.5) / SIZE, v = (j + 0.5) / SIZE;
    h[j * SIZE + i] = 0.5 + 0.5 * (0.6 * a(u, v) + 0.3 * b(u, v) + 0.12 * c(u, v));
    q[j * SIZE + i] = 0.5 + 0.5 * (0.65 * e(u, v) + 0.35 * f(u, v));
  }
  const data = new Uint8Array(SIZE * SIZE * 4);
  const at = (i: number, j: number) => h[((j + SIZE) % SIZE) * SIZE + ((i + SIZE) % SIZE)];
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const du = ((at(i + 1, j) - at(i - 1, j)) * SIZE) / 2;
    const dv = ((at(i, j + 1) - at(i, j - 1)) * SIZE) / 2;
    const k = (j * SIZE + i) * 4;
    data[k] = Math.max(0, Math.min(255, Math.round(at(i, j) * 255)));
    data[k + 1] = Math.max(0, Math.min(255, Math.round((0.5 + du / DERIV_RANGE) * 255)));
    data[k + 2] = Math.max(0, Math.min(255, Math.round((0.5 + dv / DERIV_RANGE) * 255)));
    data[k + 3] = Math.max(0, Math.min(255, Math.round(q[j * SIZE + i] * 255)));
  }
  detailTex = makeTex(data);
  return detailTex;
}

export function getCellTexture(): THREE.DataTexture {
  if (cellTex) return cellTex;
  const P = 10; // Voronoi cells per side
  const r = rng(0x5eedce11);
  const px = new Float32Array(P * P), py = new Float32Array(P * P), pv = new Float32Array(P * P);
  for (let k = 0; k < P * P; k++) {
    px[k] = 0.15 + 0.7 * r();
    py[k] = 0.15 + 0.7 * r();
    pv[k] = r();
  }
  const grain = periodicNoise(64, 0x0badf00d), grain2 = periodicNoise(128, 0x0ddba11);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const x = ((i + 0.5) / SIZE) * P, y = ((j + 0.5) / SIZE) * P;
    const cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const gx = cx + dx, gy = cy + dy;
      const k = (((gy % P) + P) % P) * P + (((gx % P) + P) % P);
      const qx = gx + px[k], qy = gy + py[k];
      const d = Math.hypot(qx - x, qy - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = k;
      } else if (d < f2) f2 = d;
    }
    const k4 = (j * SIZE + i) * 4;
    data[k4] = Math.max(0, Math.min(255, Math.round(Math.min(1, (f2 - f1) / 0.6) * 255)));
    data[k4 + 1] = Math.max(0, Math.min(255, Math.round(Math.min(1, f1 / 1.2) * 255)));
    data[k4 + 2] = Math.round(pv[id] * 255);
    const u = (i + 0.5) / SIZE, v = (j + 0.5) / SIZE;
    data[k4 + 3] = Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * (0.6 * grain(u, v) + 0.4 * grain2(u, v))) * 255)));
  }
  cellTex = makeTex(data);
  return cellTex;
}
