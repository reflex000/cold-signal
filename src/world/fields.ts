// Surface fields over the heightmap: the RGBA masks the renderer reads (R forest, G bare rock,
// B lake ice, A packed trail) and the loose snow depth the simulation reads.
//
// Wind shapes the snow: a coarse (8 m) pass looks upwind of every cell along the prevailing
// storm wind for higher ground (lee), compares each cell with its neighbourhood (ridges stand
// proud and are scoured, hollows fill) and notes slopes facing into the wind. Snow is deep in
// forest hollows and lee slopes, thin on wind-scoured ridges and steep rock, zero on the lake
// ice and on cliffs. Forest is dense on the lower slopes and the bench and thins with height
// to the tree line, with clearings and clumps from noise; none on the lake, cliffs, ridges.
import { dlen, smooth01 } from './dmath';
import { Noise } from './fastnoise';
import * as L from './layout';

const N = L.N;
const EXT = L.EXTENT;
const CELL = L.CELL;
const CN = 257;
const CC = 8;

export interface Fields {
  masks: Uint8Array; // N*N*4
  snow: Uint8Array; // N*N, metres * 255
  /** Coarse 257 x 257 wind fields (0..1): lee of higher ground upwind, and exposure. */
  lee: Float32Array;
  exposure: Float32Array;
}

/** Clearings the forest keeps away from: structure circles, the skid scar, extra spots. */
export interface Clearing { x: number; z: number; r: number; feather: number }
export interface Strip { ax: number; az: number; bx: number; bz: number; w0: number; w1: number }

export const SNOW_SCALE = 255; // snow grid value per metre
export const TAN30 = 0.5774, TAN32 = 0.6249, TAN35 = 0.7002, TAN38 = 0.7813, TAN40 = 0.8391, TAN44 = 0.9657;

/** Bilinear sample of a coarse 257 grid at world (x, z). */
export function sampleCoarse(g: Float32Array, x: number, z: number): number {
  let fx = (x + EXT) / CC, fz = (z + EXT) / CC;
  if (fx < 0) fx = 0; else if (fx > CN - 1.000001) fx = CN - 1.000001;
  if (fz < 0) fz = 0; else if (fz > CN - 1.000001) fz = CN - 1.000001;
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * CN + i;
  const a = g[k], b = g[k + 1], c = g[k + CN], d = g[k + CN + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function windFields(h: Float32Array): { lee: Float32Array; exposure: Float32Array; hollow: Float32Array; windward: Float32Array } {
  const size = CN * CN;
  const ch = new Float64Array(size);
  for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) ch[j * CN + i] = h[j * 4 * N + i * 4];
  // neighbourhood mean (box of radius 5 cells = 40 m) with a summed-area table
  const sat = new Float64Array((CN + 1) * (CN + 1));
  for (let j = 0; j < CN; j++) {
    let row = 0;
    for (let i = 0; i < CN; i++) {
      row += ch[j * CN + i];
      sat[(j + 1) * (CN + 1) + i + 1] = sat[j * (CN + 1) + i + 1] + row;
    }
  }
  const R = 5;
  const lee = new Float32Array(size), exposure = new Float32Array(size), hollow = new Float32Array(size), windward = new Float32Array(size);
  const ux = -L.WIND_X, uz = -L.WIND_Z; // toward where the wind comes from
  const DIST = [10, 20, 32, 46, 64];
  for (let j = 0; j < CN; j++) {
    for (let i = 0; i < CN; i++) {
      const k = j * CN + i;
      const i0 = Math.max(0, i - R), i1 = Math.min(CN - 1, i + R), j0 = Math.max(0, j - R), j1 = Math.min(CN - 1, j + R);
      const sum = sat[(j1 + 1) * (CN + 1) + i1 + 1] - sat[j0 * (CN + 1) + i1 + 1] - sat[(j1 + 1) * (CN + 1) + i0] + sat[j0 * (CN + 1) + i0];
      const mean = sum / ((i1 - i0 + 1) * (j1 - j0 + 1));
      const tpi = ch[k] - mean;
      // upwind horizon
      let tmax = -1;
      for (const d of DIST) {
        const fi = i + (ux * d) / CC, fj = j + (uz * d) / CC;
        if (fi < 0 || fj < 0 || fi > CN - 1.001 || fj > CN - 1.001) break;
        const a = Math.floor(fi), b = Math.floor(fj), u = fi - a, v = fj - b;
        const q = b * CN + a;
        const hu = ch[q] * (1 - u) * (1 - v) + ch[q + 1] * u * (1 - v) + ch[q + CN] * (1 - u) * v + ch[q + CN + 1] * u * v;
        const t = (hu - ch[k]) / d;
        if (t > tmax) tmax = t;
      }
      const ld = smooth01(0.05, 0.38, tmax);
      lee[k] = ld;
      // slope facing into the wind (ground rising along the wind direction)
      const gi = i > 0 && i < CN - 1 ? (ch[k + 1] - ch[k - 1]) / (2 * CC) : 0;
      const gj = j > 0 && j < CN - 1 ? (ch[k + CN] - ch[k - CN]) / (2 * CC) : 0;
      const ww = smooth01(0.04, 0.35, gi * L.WIND_X + gj * L.WIND_Z);
      windward[k] = ww;
      const high = smooth01(320, 420, ch[k]);
      exposure[k] = Math.min(1, (smooth01(0.5, 9, tpi) * 0.75 + ww * 0.35 + high * 0.35) * (1 - 0.8 * ld));
      hollow[k] = smooth01(0.5, 8, -tpi);
    }
  }
  return { lee, exposure, hollow, windward };
}

export interface FieldInput {
  h: Float32Array;
  seed: number;
  trail: Uint8Array;
  clearings: Clearing[];
  strips: Strip[];
  /** Pads (packed snow round the sites). */
  packed: Clearing[];
}

export function buildFields(inp: FieldInput): Fields {
  const { h, seed, trail } = inp;
  const wf = windFields(h);
  const masks = new Uint8Array(N * N * 4);
  const snow = new Uint8Array(N * N);
  const nf = new Noise(seed * 13 + 3);
  const nr = new Noise(seed * 13 + 4);
  // clearing weight grid: multiply the forest by this (1 = untouched)
  const clear = new Float32Array(N * N).fill(1);
  const packed = new Float32Array(N * N);
  const disc = (c: Clearing, target: Float32Array, mode: 'min' | 'max') => {
    const R = c.r + c.feather;
    const i0 = Math.max(0, Math.floor((c.x - R + EXT) / CELL)), i1 = Math.min(N - 1, Math.ceil((c.x + R + EXT) / CELL));
    const j0 = Math.max(0, Math.floor((c.z - R + EXT) / CELL)), j1 = Math.min(N - 1, Math.ceil((c.z + R + EXT) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = dlen(-EXT + i * CELL - c.x, -EXT + j * CELL - c.z);
        const w = smooth01(c.r, R, d); // 0 inside, 1 outside
        const k = j * N + i;
        if (mode === 'min') { if (w < target[k]) target[k] = w; }
        else if (1 - w > target[k]) target[k] = 1 - w;
      }
    }
  };
  for (const c of inp.clearings) disc(c, clear, 'min');
  for (const c of inp.packed) disc(c, packed, 'max');
  for (const s of inp.strips) {
    const R = s.w1;
    const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - R + EXT) / CELL)), i1 = Math.min(N - 1, Math.ceil((Math.max(s.ax, s.bx) + R + EXT) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(s.az, s.bz) - R + EXT) / CELL)), j1 = Math.min(N - 1, Math.ceil((Math.max(s.az, s.bz) + R + EXT) / CELL));
    const vx = s.bx - s.ax, vz = s.bz - s.az;
    const l2 = vx * vx + vz * vz;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -EXT + i * CELL, z = -EXT + j * CELL;
        let t = ((x - s.ax) * vx + (z - s.az) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = dlen(s.ax + vx * t - x, s.az + vz * t - z);
        const half = s.w0 * (0.55 + 0.45 * t); // the scar widens toward the wreck
        const w = smooth01(half, half + (s.w1 - s.w0), d);
        const k = j * N + i;
        if (w < clear[k]) clear[k] = w;
        const pv = (1 - w) * 0.6;
        if (pv > packed[k]) packed[k] = pv;
      }
    }
  }

  // groves and clearings (40 to 150 m forms): on the 8 m grid, interpolated below
  const clumpG = new Float32Array(CN * CN);
  for (let cj = 0; cj < CN; cj++) {
    for (let ci = 0; ci < CN; ci++) {
      const x = -EXT + ci * CC, z = -EXT + cj * CC;
      clumpG[cj * CN + ci] = smooth01(-0.45, 0.25, nf.fbm(x / 150, z / 150, 3) + 0.4 * nr.fbm(x / 42, z / 42, 2));
    }
  }
  const wl = wf.lee, we = wf.exposure, wh = wf.hollow, ww2 = wf.windward;
  for (let j = 0; j < N; j++) {
    const z = -EXT + j * CELL;
    const jm = j > 0 ? j - 1 : j, jp = j < N - 1 ? j + 1 : j;
    const inRav = z > L.RAVINE_TOP && z < 800;
    const ravX = inRav ? L.ravineX(z) : 0, ravW = inRav ? L.ravineHalfFloor(z) : 0;
    const fj = j / 4;
    const cj = Math.min(CN - 2, Math.floor(fj));
    const v = fj - cj;
    for (let i = 0; i < N; i++) {
      const x = -EXT + i * CELL;
      const k = j * N + i;
      const im = i > 0 ? i - 1 : i, ip = i < N - 1 ? i + 1 : i;
      const gx = (h[j * N + ip] - h[j * N + im]) / ((ip - im) * CELL);
      const gz = (h[jp * N + i] - h[jm * N + i]) / ((jp - jm) * CELL);
      const g = Math.sqrt(gx * gx + gz * gz);
      const hv = h[k];
      // lake
      let sdf = 1e9;
      const ldx = x - L.LAKE_X, ldz = z - L.LAKE_Z;
      if (ldx > -180 && ldx < 180 && ldz > -180 && ldz < 180) sdf = L.lakeSdf(x, z, seed);
      const ice = sdf < 2 ? Math.max(0, Math.min(1, 0.5 - sdf / 2)) : 0;
      // wind fields (coarse, interpolated)
      const fi = i / 4;
      const ci = Math.min(CN - 2, Math.floor(fi));
      const u = fi - ci;
      const q = cj * CN + ci;
      const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
      const lee = wl[q] * w00 + wl[q + 1] * w10 + wl[q + CN] * w01 + wl[q + CN + 1] * w11;
      const exp = we[q] * w00 + we[q + 1] * w10 + we[q + CN] * w01 + we[q + CN + 1] * w11;
      const hol = wh[q] * w00 + wh[q + 1] * w10 + wh[q + CN] * w01 + wh[q + CN + 1] * w11;
      const ww = ww2[q] * w00 + ww2[q + 1] * w10 + ww2[q + CN] * w01 + ww2[q + CN + 1] * w11;
      // bare rock: steep ground, and scoured ground above the trees
      let rock = smooth01(TAN32 + 0.04, TAN44, g);
      const scour = smooth01(0.45, 0.85, exp) * smooth01(335, 390, hv) * 0.75;
      if (scour > rock) rock = scour;
      if (ice > 0) rock *= 1 - ice;
      // forest
      const alt = hv > L.TREE_LINE - 100 && hv < L.TREE_LINE + 20 ? hv + 16 * nf.at(x / 90, z / 90) : hv;
      let f = 1 - smooth01(L.TREE_LINE - 80, L.TREE_LINE + 4, alt);
      if (f > 0) {
        f *= 1 - smooth01(TAN30, TAN40, g);
        f *= smooth01(5, 16, sdf);
        f *= clumpG[q] * w00 + clumpG[q + 1] * w10 + clumpG[q + CN] * w01 + clumpG[q + CN + 1] * w11;
        f *= 1 - 0.5 * exp;
        f *= 1 - 0.85 * rock;
        f *= 1 + 0.3 * smooth01(250, 140, hv);
        f *= clear[k];
        f *= 1 - 0.95 * (trail[k] / 255);
        if (f > 1) f = 1;
        if (f < 0) f = 0;
      }
      // the ravine floor is a frozen stream: few trees on it
      if (inRav && f > 0) {
        const rd = Math.abs(x - ravX) - ravW;
        if (rd < 3) f *= 0.2 + 0.8 * smooth01(-2, 3, rd);
      }
      // loose snow
      let s = 0;
      if (ice <= 0.5) {
        s = 0.33 + 0.06 * smooth01(120, 330, hv);
        s += 0.42 * lee + 0.28 * hol - 0.4 * exp - 0.1 * ww;
        s *= 1 - smooth01(TAN30, TAN40, g);
        s *= 1 - 0.85 * rock;
        s *= 1 - 0.18 * f;
        s *= 1 - 0.7 * Math.max(trail[k] / 255, packed[k]);
        s *= 0.8 + 0.4 * (0.5 + 0.5 * nr.at(x / 7.3, z / 9.1));
        if (s < 0) s = 0;
        if (s > 0.9) s = 0.9;
        if (sdf < 4) s *= smooth01(0.5, 4, sdf);
      }
      snow[k] = Math.round(s * SNOW_SCALE);
      const m = k * 4;
      masks[m] = Math.round(f * 255);
      masks[m + 1] = Math.round(rock * 255);
      masks[m + 2] = Math.round(ice * 255);
      masks[m + 3] = Math.max(trail[k], Math.round(packed[k] * 255));
    }
  }
  return { masks, snow, lee: wf.lee, exposure: wf.exposure };
}
