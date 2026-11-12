// CPU-side terrain data: the GPU textures built once from the World (heights, normals, masks,
// lake ice) and a min / max height pyramid for the quadtree's bounding boxes.
// Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import type { World } from '../../world/types';
import { Noise } from '../../world/fastnoise';
import { DOMAIN_HALF, FAR_CELL, FAR_N, FAR_ORIGIN } from './config';
import { buildFarMap, type FarMap } from './ring';

export interface TerrainData {
  far: FarMap;
  /**
   * world.heightmap and its filtered mip levels, packed in one R32F atlas (read with textureLoad):
   * level 0 (n x n) at the origin, levels 1.. stacked in a column to its right (see mipAtlas).
   */
  heightTex: THREE.DataTexture;
  /** The far map and its mip levels, packed the same way. */
  farTex: THREE.DataTexture;
  /** Mip levels in each atlas (level 0 included). */
  fineLevels: number;
  farLevels: number;
  /** RGBA8 over the heightmap: rg slope dh/dx, dh/dz as 0.5 + atan(s) / pi, b curvature (0.5 flat, > 0.5 hollow), a snow depth (1 = 1 m). */
  normFineTex: THREE.DataTexture;
  /** RGBA8 over the domain: rg slope (as above), b curvature, a forest cover of the far ring. */
  normFarTex: THREE.DataTexture;
  /** world.masks: r forest, g bare rock, b lake ice, a packed trail. */
  maskTex: THREE.DataTexture;
  /** Lake ice thickness, r = thickness / LAKE_MAX_THICK over the lake grid. */
  lakeTex: THREE.DataTexture;
  lakeMaxThick: number;
  /** Placement of lakeTex: uv = (xz - (minX, minZ)) / size. */
  lake: { minX: number; minZ: number; size: number };
  minmax: MinMax;
  /** Fine grid layout. */
  fineN: number;
  fineCell: number;
  fineExtent: number;
  dispose(): void;
}

function floatTex(data: Float32Array, w: number, h: number): THREE.DataTexture {
  // Nearest + no mips: R32F is not filterable on WebGL2 (or WebGPU without float32-filterable);
  // a linear filter would make the texture incomplete and texelFetch would read zeros.
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Vertex-aligned mip pyramid of an n x n height grid (n = 2^k + 1), packed into one atlas so a coarse
 * LOD can read heights filtered to its own cell size: no single noisy sample becomes a dent in a
 * coarse mesh, and distant silhouettes do not alias. Level 0 sits at (0, 0); level L >= 1 (size
 * (n - 1) / 2^L + 1) sits at x = n, y = (n - 1) * (1 - 2^(1 - L)) + (L - 1). Each level is a 1-2-1
 * tent filter of the one below, sampled at its even vertices.
 */
export function mipAtlas(src: Float32Array, n: number, levels: number): { data: Float32Array; w: number; h: number } {
  const w = n + (n >> 1) + 1;
  const h = n;
  const out = new Float32Array(w * h);
  for (let j = 0; j < n; j++) out.set(src.subarray(j * n, j * n + n), j * w);
  let prev = src, pn = n;
  for (let L = 1; L < levels; L++) {
    const m = (pn - 1) / 2 + 1;
    const cur = new Float32Array(m * m);
    const at = (i: number, j: number) => prev[Math.min(pn - 1, Math.max(0, j)) * pn + Math.min(pn - 1, Math.max(0, i))];
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const ci = 2 * i, cj = 2 * j;
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += at(ci + di, cj + dj) * (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
        cur[j * m + i] = sum / 16;
      }
    }
    const yo = Math.round((n - 1) * (1 - Math.pow(2, 1 - L)) + (L - 1));
    for (let j = 0; j < m; j++) out.set(cur.subarray(j * m, j * m + m), (yo + j) * w + n);
    prev = cur;
    pn = m;
  }
  return { data: out, w, h };
}

function byteTex(data: Uint8Array, w: number, h: number, format: THREE.PixelFormat, mips: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = mips ? 4 : 1;
  t.needsUpdate = true;
  return t;
}

/**
 * Slope + curvature bake. h is n x n with spacing `cell`. The slope is stored as 0.5 + atan(s) / pi:
 * even angular steps, so cliffs keep their normals in 8 bits (n = normalize(-hx, 1, -hz)). Curvature
 * is the Laplacian over a 2-cell stencil (reads as hollows and crests, not as grid noise).
 */
function bakeNormals(h: Float32Array, n: number, cell: number, out: Uint8Array, curvScale: number): void {
  const at = (i: number, j: number) => h[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const hz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const c = at(i, j);
      const lap = (at(i + 2, j) + at(i - 2, j) + at(i, j + 2) + at(i, j - 2) - 4 * c) / (4 * cell * cell);
      const k = (j * n + i) * 4;
      out[k] = Math.round((0.5 + Math.atan(hx) / Math.PI) * 255);
      out[k + 1] = Math.round((0.5 + Math.atan(hz) / Math.PI) * 255);
      out[k + 2] = Math.max(0, Math.min(255, Math.round(128 + lap * curvScale)));
    }
  }
}

export class MinMax {
  /** levels[0] is 64 m cells (192^2); each next level halves the resolution, down to 3^2 of 4096 m. */
  readonly levels: { n: number; min: Float32Array; max: Float32Array }[] = [];
  readonly base = 64;

  constructor(world: World, far: FarMap) {
    const D = DOMAIN_HALF;
    const n0 = Math.round((2 * D) / this.base);
    const min = new Float32Array(n0 * n0).fill(Infinity);
    const max = new Float32Array(n0 * n0).fill(-Infinity);
    const hm = world.heightmap;
    const fc = (hm.extent * 2) / (hm.n - 1);
    for (let j = 0; j < n0; j++) {
      const z0 = -D + j * this.base, z1 = z0 + this.base;
      for (let i = 0; i < n0; i++) {
        const x0 = -D + i * this.base, x1 = x0 + this.base;
        let lo = Infinity, hi = -Infinity;
        // far samples whose bilinear cells touch this cell
        const fi0 = Math.max(0, Math.floor((x0 - far.origin) / far.cell)), fi1 = Math.min(far.n - 1, Math.ceil((x1 - far.origin) / far.cell));
        const fj0 = Math.max(0, Math.floor((z0 - far.origin) / far.cell)), fj1 = Math.min(far.n - 1, Math.ceil((z1 - far.origin) / far.cell));
        for (let fj = fj0; fj <= fj1; fj++) for (let fi = fi0; fi <= fi1; fi++) {
          const v = far.data[fj * far.n + fi];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        // heightmap samples
        if (x1 >= -hm.extent && x0 <= hm.extent && z1 >= -hm.extent && z0 <= hm.extent) {
          const hi0 = Math.max(0, Math.floor((x0 + hm.extent) / fc)), hi1 = Math.min(hm.n - 1, Math.ceil((x1 + hm.extent) / fc));
          const hj0 = Math.max(0, Math.floor((z0 + hm.extent) / fc)), hj1 = Math.min(hm.n - 1, Math.ceil((z1 + hm.extent) / fc));
          for (let hj = hj0; hj <= hj1; hj++) for (let hi2 = hi0; hi2 <= hi1; hi2++) {
            const v = hm.data[hj * hm.n + hi2];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        min[j * n0 + i] = lo;
        max[j * n0 + i] = hi;
      }
    }
    this.levels.push({ n: n0, min, max });
    let prev = this.levels[0];
    while (prev.n > 3) {
      const n = prev.n >> 1;
      const mn = new Float32Array(n * n), mx = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = (2 * j) * prev.n + 2 * i;
        mn[j * n + i] = Math.min(prev.min[a], prev.min[a + 1], prev.min[a + prev.n], prev.min[a + prev.n + 1]);
        mx[j * n + i] = Math.max(prev.max[a], prev.max[a + 1], prev.max[a + prev.n], prev.max[a + prev.n + 1]);
      }
      prev = { n, min: mn, max: mx };
      this.levels.push(prev);
    }
  }

  /** Height range of the square node [x0, x0 + size] x [z0, z0 + size] (size a power of two times 0.25 m). */
  query(x0: number, z0: number, size: number, out: { min: number; max: number }): void {
    const D = DOMAIN_HALF;
    let lvl = 0;
    let s = this.base;
    while (s < size && lvl < this.levels.length - 1) {
      s *= 2;
      lvl++;
    }
    const L = this.levels[lvl];
    const i = Math.min(L.n - 1, Math.max(0, Math.floor((x0 + D + 1e-3) / s)));
    const j = Math.min(L.n - 1, Math.max(0, Math.floor((z0 + D + 1e-3) / s)));
    out.min = L.min[j * L.n + i];
    out.max = L.max[j * L.n + i];
  }
}

export const LAKE_MAX_THICK = 0.8;

export function buildTerrainData(world: World): TerrainData {
  const hm = world.heightmap;
  const n = hm.n;
  const cell = (hm.extent * 2) / (n - 1);

  const far = buildFarMap(world);
  const fineLevels = 8; // 2 m .. 256 m
  const farLevels = 6; // 24 m .. 768 m
  const fa = mipAtlas(hm.data, n, fineLevels);
  const ra = mipAtlas(far.data, far.n, farLevels);
  const heightTex = floatTex(fa.data, fa.w, fa.h);
  const farTex = floatTex(ra.data, ra.w, ra.h);

  // --- fine normals + curvature + snow depth ---
  const nf = new Uint8Array(n * n * 4);
  bakeNormals(hm.data, n, cell, nf, 600);
  {
    // snow depth: world.snowDepthAt on a 4 m grid, bilinear up to the 2 m texels
    const sn = (n - 1) / 2 + 1;
    const sd = new Float32Array(sn * sn);
    for (let j = 0; j < sn; j++) for (let i = 0; i < sn; i++) sd[j * sn + i] = world.snowDepthAt(-hm.extent + i * 4, -hm.extent + j * 4);
    for (let j = 0; j < n; j++) {
      const fj = j / 2, j0 = Math.min(sn - 2, Math.floor(fj)), v = fj - j0;
      for (let i = 0; i < n; i++) {
        const fi = i / 2, i0 = Math.min(sn - 2, Math.floor(fi)), u = fi - i0;
        const k = j0 * sn + i0;
        const a = sd[k], b = sd[k + 1], c = sd[k + sn], d = sd[k + sn + 1];
        const s = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        nf[(j * n + i) * 4 + 3] = Math.max(0, Math.min(255, Math.round(s * 255)));
      }
    }
  }
  const normFineTex = byteTex(nf, n, n, THREE.RGBAFormat, true);

  // --- far normals + curvature + far-ring forest ---
  const fn = new Uint8Array(far.n * far.n * 4);
  bakeNormals(far.data, far.n, far.cell, fn, 8000);
  {
    // Forest on the far ring: below a wandering tree line, on slopes a tree can hold, thinning
    // with altitude, broken by noise into stands and avalanche paths.
    const nz = new Noise((world.seed ^ 0x2f00e5) >>> 0);
    for (let j = 0; j < far.n; j++) {
      const z = FAR_ORIGIN + j * FAR_CELL;
      for (let i = 0; i < far.n; i++) {
        const x = FAR_ORIGIN + i * FAR_CELL;
        const k = (j * far.n + i) * 4;
        if (Math.abs(x) < hm.extent - 40 && Math.abs(z) < hm.extent - 40) {
          fn[k + 3] = 0; // the real forest is drawn there
          continue;
        }
        const h = far.data[j * far.n + i];
        const sx = Math.tan((fn[k] / 255 - 0.5) * Math.PI), sz = Math.tan((fn[k + 1] / 255 - 0.5) * Math.PI);
        const ny = 1 / Math.sqrt(1 + sx * sx + sz * sz);
        const line = 1050 + 220 * nz.fbm(x / 2200, z / 2200, 3);
        const alt = 1 - Math.min(1, Math.max(0, (h - line + 160) / 320));
        const slope = Math.min(1, Math.max(0, (ny - 0.72) / 0.14));
        const stands = Math.min(1, Math.max(0, 0.62 + 0.9 * nz.fbm(x / 520 + 4.1, z / 520 - 1.7, 4)));
        const f = alt * slope * stands;
        fn[k + 3] = Math.round(Math.min(1, f) * 255);
      }
    }
  }
  const normFarTex = byteTex(fn, far.n, far.n, THREE.RGBAFormat, true);

  // --- masks ---
  const maskTex = byteTex(world.masks.data, world.masks.n, world.masks.n, THREE.RGBAFormat, true);

  // --- lake ice thickness ---
  const L = world.lake;
  const lk = new Uint8Array(Math.max(1, L.n * L.n));
  for (let k = 0; k < L.n * L.n; k++) lk[k] = Math.max(0, Math.min(255, Math.round((L.thickness[k] / LAKE_MAX_THICK) * 255)));
  const lakeTex = byteTex(lk, Math.max(1, L.n), Math.max(1, L.n), THREE.RedFormat, false);

  const minmax = new MinMax(world, far);

  return {
    far, heightTex, farTex, fineLevels, farLevels, normFineTex, normFarTex, maskTex, lakeTex, lakeMaxThick: LAKE_MAX_THICK,
    lake: { minX: L.minX, minZ: L.minZ, size: Math.max(1, L.n) * L.cell },
    minmax,
    fineN: n, fineCell: cell, fineExtent: hm.extent,
    dispose() {
      for (const t of [heightTex, farTex, normFineTex, normFarTex, maskTex, lakeTex]) t.dispose();
    },
  };
}

// FAR_N is re-exported for callers that size things from the data.
export { FAR_N };
