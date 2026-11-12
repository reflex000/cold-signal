// Procedural noise textures generated once at load (no image files): a tileable 2D texture for
// the clouds and the aurora, a tileable 3D texture for the storm volume. Deterministic.
// Owner: ATMOS (src/gfx/weather imports these too).
import * as THREE from 'three/webgpu';

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise on a lattice that wraps every `p` cells, in about -1..1. */
function gnoise2(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash3(((ix % p) + p) % p, ((iy % p) + p) % p, 0, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(fx), v = fade(fy);
  const n00 = g(xi, yi, fx, fy), n10 = g(xi + 1, yi, fx - 1, fy);
  const n01 = g(xi, yi + 1, fx, fy - 1), n11 = g(xi + 1, yi + 1, fx - 1, fy - 1);
  return 1.41 * (n00 + (n10 - n00) * u + (n01 - n00) * v + (n00 - n10 - n01 + n11) * u * v);
}

/** Value noise on a lattice that wraps every `p` cells, 0..1. */
function vnoise3(x: number, y: number, z: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const w3 = (i: number): number => ((i % p) + p) % p;
  const x0 = w3(xi), x1 = w3(xi + 1), y0 = w3(yi), y1 = w3(yi + 1), z0 = w3(zi), z1 = w3(zi + 1);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(hash3(x0, y0, z0, seed), hash3(x1, y0, z0, seed), u), l(hash3(x0, y1, z0, seed), hash3(x1, y1, z0, seed), u), v),
    l(l(hash3(x0, y0, z1, seed), hash3(x1, y0, z1, seed), u), l(hash3(x0, y1, z1, seed), hash3(x1, y1, z1, seed), u), v),
    w,
  );
}

let noise2D: THREE.DataTexture | null = null;

/**
 * 128 x 128 RGBA8, wraps in both directions, mipmapped.
 *   R  fbm, 4 octaves from a 4-cell lattice     (cloud masses, aurora warp)
 *   G  fbm, 4 octaves from an 8-cell lattice    (cloud detail)
 *   B  billowy |fbm| from a 16-cell lattice     (cauliflower edges, curtain rays)
 *   A  white noise                              (dither, stars)
 */
export function getNoise2D(): THREE.DataTexture {
  if (noise2D) return noise2D;
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  const fbm = (x: number, y: number, base: number, seed: number, billow: boolean): number => {
    let sum = 0, amp = 0.5, norm = 0, f = base;
    for (let o = 0; o < 4; o++) {
      const n = gnoise2((x / S) * f, (y / S) * f, f, seed + o * 17);
      sum += (billow ? Math.abs(n) : n) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const r = 0.5 + 0.5 * fbm(x, y, 4, 11, false) * 1.25;
      const g = 0.5 + 0.5 * fbm(x, y, 8, 37, false) * 1.25;
      const b = fbm(x, y, 16, 73, true) * 1.6;
      data[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      data[i + 3] = Math.floor(hash3(x, y, 5, 99) * 256);
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'Noise2D';
  t.needsUpdate = true;
  noise2D = t;
  return t;
}

let noise3D: THREE.Data3DTexture | null = null;

/**
 * 32^3 RGBA8, wraps on every axis.
 *   R  value-noise fbm, 3 octaves from a 4-cell lattice (gust fronts, big puffs)
 *   G  value-noise fbm, 3 octaves from an 8-cell lattice (streaks)
 *   B  value noise, 16-cell lattice (fine grain)
 *   A  1 - R, so a single fetch gives an anti-correlated pair
 */
export function getNoise3D(): THREE.Data3DTexture {
  if (noise3D) return noise3D;
  const S = 32;
  const data = new Uint8Array(S * S * S * 4);
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fb = (base: number, seed: number, oct: number): number => {
          let sum = 0, amp = 0.5, norm = 0, f = base;
          for (let o = 0; o < oct; o++) {
            sum += vnoise3((x / S) * f, (y / S) * f, (z / S) * f, f, seed + o * 31) * amp;
            norm += amp;
            amp *= 0.5;
            f *= 2;
          }
          return sum / norm;
        };
        const i = ((z * S + y) * S + x) * 4;
        const r = fb(4, 3, 3);
        // stretch the contrast of the fbm, which clusters around 0.5
        const c = (v: number): number => Math.max(0, Math.min(255, Math.round((0.5 + (v - 0.5) * 1.9) * 255)));
        data[i] = c(r);
        data[i + 1] = c(fb(8, 7, 3));
        data[i + 2] = c(fb(16, 13, 1));
        data[i + 3] = 255 - data[i];
      }
    }
  }
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  t.name = 'Noise3D';
  t.needsUpdate = true;
  noise3D = t;
  return t;
}
