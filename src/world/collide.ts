// Static collision: a spatial hash over every collider (tree trunks, big rocks, structure walls
// and furniture), and rays against the terrain, the floors and the colliders.
//
// The hash is a compressed grid (4 m cells): each collider is listed in every cell its bounds
// touch; a stamp per collider removes duplicates within one query, so queries allocate nothing.
import type { Collider, Floor } from './types';

export const KIND_TREE = 0;
export const KIND_ROCK = 1;
export const KIND_WALL = 2;

const C = 4;
const EXT = 1024;
const GN = (EXT * 2) / C; // 512

export type RayHit = { x: number; y: number; z: number; dist: number; what: 'ground' | 'tree' | 'rock' | 'wall' };

function reach(c: Collider): number {
  return c.s === 'c' ? c.r : Math.sqrt(c.hx * c.hx + c.hz * c.hz);
}

export class ColliderIndex {
  readonly list: Collider[];
  readonly kind: Uint8Array;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  private readonly stamp: Uint32Array;
  private tick = 0;
  /** Box colliders' cos / sin of yaw, by index (0 for circles). */
  private readonly cs: Float64Array;
  private readonly sn: Float64Array;

  constructor(list: Collider[], kind: Uint8Array, cos: (a: number) => number, sin: (a: number) => number) {
    this.list = list;
    this.kind = kind;
    const n = list.length;
    this.stamp = new Uint32Array(n);
    this.cs = new Float64Array(n);
    this.sn = new Float64Array(n);
    const counts = new Uint32Array(GN * GN + 1);
    const span = (c: Collider, f: (cell: number) => void) => {
      const r = reach(c);
      const i0 = Math.max(0, Math.floor((c.x - r + EXT) / C)), i1 = Math.min(GN - 1, Math.floor((c.x + r + EXT) / C));
      const j0 = Math.max(0, Math.floor((c.z - r + EXT) / C)), j1 = Math.min(GN - 1, Math.floor((c.z + r + EXT) / C));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * GN + i);
    };
    for (let k = 0; k < n; k++) {
      const c = list[k];
      if (c.s === 'b') {
        this.cs[k] = cos(c.yaw);
        this.sn[k] = sin(c.yaw);
      }
      span(c, (cell) => counts[cell + 1]++);
    }
    for (let i = 0; i < GN * GN; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Uint32Array(counts[GN * GN]);
    const fill = counts.slice(0, GN * GN);
    for (let k = 0; k < n; k++) span(list[k], (cell) => (this.items[fill[cell]++] = k));
  }

  private nextStamp(): number {
    this.tick = (this.tick + 1) >>> 0;
    if (this.tick === 0) {
      this.stamp.fill(0);
      this.tick = 1;
    }
    return this.tick;
  }

  /** Colliders whose footprint comes within r of (x, z). */
  near(x: number, z: number, r: number, out: Collider[]): Collider[] {
    const st = this.nextStamp();
    const i0 = Math.max(0, Math.floor((x - r + EXT) / C)), i1 = Math.min(GN - 1, Math.floor((x + r + EXT) / C));
    const j0 = Math.max(0, Math.floor((z - r + EXT) / C)), j1 = Math.min(GN - 1, Math.floor((z + r + EXT) / C));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * GN + i;
        for (let q = this.start[cell]; q < this.start[cell + 1]; q++) {
          const k = this.items[q];
          if (this.stamp[k] === st) continue;
          this.stamp[k] = st;
          const c = this.list[k];
          const dx = c.x - x, dz = c.z - z;
          if (c.s === 'c') {
            const rr = r + c.r;
            if (dx * dx + dz * dz <= rr * rr) out.push(c);
          } else {
            // distance from the point to the box, in the box frame (as Object3D.rotation.y)
            const lx = -dx * this.cs[k] + dz * this.sn[k], lz = -dx * this.sn[k] - dz * this.cs[k];
            const ex = Math.max(0, Math.abs(lx) - c.hx), ez = Math.max(0, Math.abs(lz) - c.hz);
            if (ex * ex + ez * ez <= r * r) out.push(c);
          }
        }
      }
    }
    return out;
  }

  /** Is the point inside a solid (any collider spanning height y, or any at all if y is NaN)? */
  inside(x: number, y: number, z: number, minKind = 0): boolean {
    const i = Math.floor((x + EXT) / C), j = Math.floor((z + EXT) / C);
    if (i < 0 || j < 0 || i >= GN || j >= GN) return false;
    const cell = j * GN + i;
    for (let q = this.start[cell]; q < this.start[cell + 1]; q++) {
      const k = this.items[q];
      if (this.kind[k] < minKind) continue;
      const c = this.list[k];
      if (y === y && (y < c.y0 || y > c.y1)) continue;
      const dx = x - c.x, dz = z - c.z;
      if (c.s === 'c') {
        if (dx * dx + dz * dz < c.r * c.r) return true;
      } else {
        const lx = dx * this.cs[k] - dz * this.sn[k], lz = dx * this.sn[k] + dz * this.cs[k];
        if (Math.abs(lx) < c.hx && Math.abs(lz) < c.hz) return true;
      }
    }
    return false;
  }

  /**
   * Nearest hit of the ray o + t d (d unit, t in (0, maxT]) with a collider, or Infinity.
   * Cells are walked along the ray's ground track (2D DDA). `minKind` skips trees (1) or trees and rocks (2).
   */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, minKind: number, hit: { t: number; k: number }): void {
    hit.t = Infinity;
    hit.k = -1;
    const st = this.nextStamp();
    let ci = Math.floor((ox + EXT) / C), cj = Math.floor((oz + EXT) / C);
    const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-12 ? C / Math.abs(dx) : Infinity;
    const tdz = Math.abs(dz) > 1e-12 ? C / Math.abs(dz) : Infinity;
    const bx = -EXT + (ci + (dx > 0 ? 1 : 0)) * C, bz = -EXT + (cj + (dz > 0 ? 1 : 0)) * C;
    let tmx = Math.abs(dx) > 1e-12 ? (bx - ox) / dx : Infinity;
    let tmz = Math.abs(dz) > 1e-12 ? (bz - oz) / dz : Infinity;
    let tcell = 0;
    for (let guard = 0; guard < 4096; guard++) {
      if (ci >= 0 && cj >= 0 && ci < GN && cj < GN) {
        const cell = cj * GN + ci;
        for (let q = this.start[cell]; q < this.start[cell + 1]; q++) {
          const k = this.items[q];
          if (this.stamp[k] === st) continue;
          this.stamp[k] = st;
          if (this.kind[k] < minKind) continue;
          const t = this.hitOne(k, ox, oy, oz, dx, dy, dz);
          if (t > 0 && t <= maxT && t < hit.t) {
            hit.t = t;
            hit.k = k;
          }
        }
      }
      // a hit inside this cell's span cannot be beaten by later cells
      const tnext = tmx < tmz ? tmx : tmz;
      if (hit.t <= tnext || tnext > maxT || tcell > maxT) break;
      tcell = tnext;
      if (tmx < tmz) {
        ci += stepI;
        tmx += tdx;
      } else {
        cj += stepJ;
        tmz += tdz;
      }
    }
  }

  private hitOne(k: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const c = this.list[k];
    let t0 = 0, t1 = Infinity;
    // vertical extent
    if (Math.abs(dy) < 1e-12) {
      if (oy < c.y0 || oy > c.y1) return -1;
    } else {
      let a = (c.y0 - oy) / dy, b = (c.y1 - oy) / dy;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    if (c.s === 'c') {
      const px = ox - c.x, pz = oz - c.z;
      const A = dx * dx + dz * dz;
      const B = px * dx + pz * dz;
      const Cc = px * px + pz * pz - c.r * c.r;
      if (A < 1e-12) return Cc <= 0 ? t0 : -1;
      const disc = B * B - A * Cc;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      const a = (-B - sq) / A, b = (-B + sq) / A;
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
      return Cc <= 0 && t0 <= 0 ? -1 : t0; // starting inside a trunk does not count
    }
    const cs = this.cs[k], sn = this.sn[k];
    const px = ox - c.x, pz = oz - c.z;
    const lx = px * cs - pz * sn, lz = px * sn + pz * cs;
    const ldx = dx * cs - dz * sn, ldz = dx * sn + dz * cs;
    const slab = (o: number, d: number, h: number): boolean => {
      if (Math.abs(d) < 1e-12) return o >= -h && o <= h;
      let a = (-h - o) / d, b = (h - o) / d;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      return t0 <= t1;
    };
    if (!slab(lx, ldx, c.hx) || !slab(lz, ldz, c.hz)) return -1;
    return t0 <= 0 ? -1 : t0;
  }
}

/** Ray against horizontal walkable floors (as Object3D.rotation.y rectangles). */
export function rayFloors(floors: Floor[], fcs: Float64Array, fsn: Float64Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  if (Math.abs(dy) < 1e-9) return Infinity;
  let best = Infinity;
  for (let k = 0; k < floors.length; k++) {
    const f = floors[k];
    const t = (f.y - oy) / dy;
    if (t <= 0 || t > maxT || t >= best) continue;
    const x = ox + dx * t - f.x, z = oz + dz * t - f.z;
    const lx = x * fcs[k] - z * fsn[k], lz = x * fsn[k] + z * fcs[k];
    if (Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz) best = t;
  }
  return best;
}
