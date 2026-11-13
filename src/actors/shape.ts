// Organic surfaces for the figures, built as KIT parts: a LOFT is a tube through a list of rings
// (centre, two in-plane axes, a closed outline in ring coordinates), smooth shaded, with optional
// domed caps. Torso, sleeves, legs, the wolf's body, neck, head and tail are lofts. Everything here
// runs once at load.
import type { Builder, Part, V3 } from '../models/kit';

export interface Ring {
  /** Centre. */
  c: V3;
  /** In-plane axes (unit, orthogonal). The outline point (u, v) sits at c + x u + y v. */
  x: V3;
  y: V3;
  /** Outline: (u, v) at angle a (0..2 pi, from x toward y). */
  pt: (a: number) => readonly [number, number];
}

export interface LoftOpts {
  /** Close the first / last ring with a domed fan. */
  capStart?: boolean;
  capEnd?: boolean;
  /** How far the cap's centre bulges out, as a fraction of the ring's mean radius. */
  bulge?: number;
  /**
   * Keep the winding of the first segment for the whole sheet (a sheet that folds back on itself,
   * like a hood rolling into its lining, keeps its normals on the same side).
   */
  fixed?: boolean;
  /** The rings form a loop: join the last ring back to the first (no caps). */
  closed?: boolean;
}

const _P: [number, number] = [0, 0];

/** A smooth tube through `rings` with n points per ring. Faces are wound outward. */
export function loft(b: Builder, rings: readonly Ring[], n: number, o: LoftOpts = {}): Part {
  const pts: V3[] = [];
  const faces: number[][] = [];
  const K = rings.length;
  for (const r of rings) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const [u, v] = r.pt(a);
      pts.push([r.c[0] + r.x[0] * u + r.y[0] * v, r.c[1] + r.x[1] * u + r.y[1] * v, r.c[2] + r.x[2] * u + r.y[2] * v]);
    }
  }
  // orientation: (x cross y) along the direction of travel means (k,i),(k,i+1),(k+1,i+1) is outward
  const dir = (k: number): V3 => {
    if (o.closed) {
      const a = rings[k % K].c, c = rings[(k + 1) % K].c;
      return [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    }
    const a = rings[Math.max(0, Math.min(K - 2, k))].c, c = rings[Math.max(1, Math.min(K - 1, k + 1))].c;
    return [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  };
  const fwdAt = (k: number): boolean => {
    const r = rings[k % K];
    const cx = r.x[1] * r.y[2] - r.x[2] * r.y[1], cy = r.x[2] * r.y[0] - r.x[0] * r.y[2], cz = r.x[0] * r.y[1] - r.x[1] * r.y[0];
    const d = dir(k);
    return cx * d[0] + cy * d[1] + cz * d[2] >= 0;
  };
  const fwd0 = fwdAt(0);
  const segs = o.closed ? K : K - 1;
  for (let k = 0; k < segs; k++) {
    const fwd = o.fixed ? fwd0 : fwdAt(k);
    const k1 = (k + 1) % K;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = k * n + i, bb = k * n + j, c = k1 * n + j, e = k1 * n + i;
      faces.push(fwd ? [a, bb, c, e] : [a, e, c, bb]);
    }
  }
  if (o.closed) return b.mesh(pts, faces, true);
  const cap = (k: number, end: boolean): void => {
    const r = rings[k];
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[k * n + i];
      mean += Math.hypot(p[0] - r.c[0], p[1] - r.c[1], p[2] - r.c[2]);
    }
    mean /= n;
    const d = dir(k);
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const s = ((end ? 1 : -1) * (o.bulge ?? 0.5) * mean) / dl;
    const ci = pts.length;
    pts.push([r.c[0] + d[0] * s, r.c[1] + d[1] * s, r.c[2] + d[2] * s]);
    const cx = r.x[1] * r.y[2] - r.x[2] * r.y[1], cy = r.x[2] * r.y[0] - r.x[0] * r.y[2], cz = r.x[0] * r.y[1] - r.x[1] * r.y[0];
    const fwd = cx * d[0] + cy * d[1] + cz * d[2] >= 0;
    // looking from outside the cap: the end cap is seen along +d, the start cap along -d
    const ccw = fwd === end;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(ccw ? [ci, k * n + i, k * n + j] : [ci, k * n + j, k * n + i]);
    }
  };
  if (o.capStart) cap(0, false);
  if (o.capEnd) cap(K - 1, true);
  return b.mesh(pts, faces, true);
}

// ------------------------------------------------------------------------------------------
// vector helpers (plain tuples, load time only)
// ------------------------------------------------------------------------------------------

export function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function mul(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
export function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * In-plane axes for a ring perpendicular to `axis`, with x as close as possible to `hint`
 * (projected). y = axis x x so that (x, y, axis) is right-handed.
 */
export function frame(axis: V3, hint: V3): { x: V3; y: V3 } {
  const a = norm(axis);
  let x = sub(hint, mul(a, dot(hint, a)));
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  x = norm(x);
  const y = cross(a, x);
  return { x, y };
}

/** A superellipse outline: half sizes rx, ry, exponent e (2 = ellipse, higher = boxier). */
export function superEllipse(rx: number, ry: number, e = 2): (a: number) => readonly [number, number] {
  const k = 2 / e;
  return (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    _P[0] = rx * Math.sign(c) * Math.pow(Math.abs(c), k);
    _P[1] = ry * Math.sign(s) * Math.pow(Math.abs(s), k);
    return [_P[0], _P[1]];
  };
}

/** Deterministic hash noise in -1..1 (load-time shape variation). */
export function hash(i: number, j = 0, k = 0): number {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth 1D value noise, -1..1. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}

/** Smooth 2D value noise, -1..1 (periodic in x with period px if given). */
export function noise2(x: number, y: number, seed = 0, px = 0): number {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => (px > 0 ? ((a % px) + px) % px : a);
  const h00 = hash(w(i), j, seed), h10 = hash(w(i + 1), j, seed), h01 = hash(w(i), j + 1, seed), h11 = hash(w(i + 1), j + 1, seed);
  return (h00 * (1 - ux) + h10 * ux) * (1 - uy) + (h01 * (1 - ux) + h11 * ux) * uy;
}

export const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
