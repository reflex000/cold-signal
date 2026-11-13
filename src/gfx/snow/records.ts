// The persistent memory of the snow: every print, drag and hollow ever pressed, as a compact
// record (typed arrays, a ring of CAPACITY), found by an 8 m spatial hash. The GPU windows are only
// views of this store: a window that moves, or that has to show the fill of the last minutes, is
// re-rendered from it. So trails come back when you return to them, at full resolution, and the
// whole route is remembered without a world-sized texture.
//
// Fill-in: `fill` is a clock in metres of snow laid into hollows since the session began (new snow
// plus wind drift, see SnowFill in index.ts). A record keeps the clock reading of the moment it was
// pressed; its remaining depth, rim, freshness and wall softness follow from the difference.
// No three.js here. Owner: SNOW.
import { DEPTH_FILL_RATE, FRESH_FILL, K_BODY, K_GROOVE, K_KICK, K_PIT, RIM_FILL_RATE, SOFT_FILL } from './config';

export const CAPACITY = 1 << 17;
const CELL = 8;
const DEAD = 255;
/** Largest distance (m) from a record's centre to the edge of what it draws (bodies, long grooves). */
export const MAX_REACH = 1.6;

/** Remaining state of one record at a fill reading (written by RecordStore.eval). */
export interface Remaining {
  depth: number; // m
  rim: number; // m
  fresh: number; // 0..1
  soft: number; // 0..1
}

export class RecordStore {
  readonly kind = new Uint8Array(CAPACITY).fill(DEAD);
  readonly flags = new Uint8Array(CAPACITY);
  readonly x = new Float32Array(CAPACITY);
  readonly z = new Float32Array(CAPACITY);
  /** Forward unit vector of the shape's local t axis (world xz). */
  readonly fx = new Float32Array(CAPACITY);
  readonly fz = new Float32Array(CAPACITY);
  /** Shape half extents: across (local s) and along (local t), metres. */
  readonly hw = new Float32Array(CAPACITY);
  readonly hl = new Float32Array(CAPACITY);
  readonly depth = new Float32Array(CAPACITY);
  readonly rim = new Float32Array(CAPACITY);
  readonly f0 = new Float64Array(CAPACITY);
  readonly seed = new Float32Array(CAPACITY);
  private readonly cellOf = new Int32Array(CAPACITY);
  private readonly cells = new Map<number, number[]>();
  private head = 0;
  /** Live records (approximate: dead ones are counted out when found). */
  count = 0;
  /** Bumped whenever a record is added: windows compare it to know they are stale. */
  serial = 0;

  private static key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Add a record; returns its index. Fields not given here are set by the caller right after. */
  add(kind: number, x: number, z: number, fx: number, fz: number, hw: number, hl: number, depth: number, rim: number, fill: number, flags: number, seed: number): number {
    const i = this.head;
    this.head = (this.head + 1) % CAPACITY;
    if (this.kind[i] !== DEAD) this.unlink(i);
    else this.count++;
    this.kind[i] = kind;
    this.flags[i] = flags;
    this.x[i] = x;
    this.z[i] = z;
    this.fx[i] = fx;
    this.fz[i] = fz;
    this.hw[i] = hw;
    this.hl[i] = hl;
    this.depth[i] = depth;
    this.rim[i] = rim;
    this.f0[i] = fill;
    this.seed[i] = seed;
    const k = RecordStore.key(Math.floor(x / CELL), Math.floor(z / CELL));
    this.cellOf[i] = k;
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(i);
    this.serial++;
    return i;
  }

  private unlink(i: number): void {
    const l = this.cells.get(this.cellOf[i]);
    if (!l) return;
    const j = l.indexOf(i);
    if (j >= 0) {
      l[j] = l[l.length - 1];
      l.pop();
    }
    if (l.length === 0) this.cells.delete(this.cellOf[i]);
  }

  /** Remaining depth / rim / freshness / softness of record i at fill reading `fill`. */
  eval(i: number, fill: number, out: Remaining): Remaining {
    const f = Math.max(0, fill - this.f0[i]);
    out.depth = Math.max(0, this.depth[i] - DEPTH_FILL_RATE * f);
    out.rim = Math.max(0, this.rim[i] - RIM_FILL_RATE * f);
    out.fresh = Math.max(0, 1 - f / FRESH_FILL);
    out.soft = Math.min(1, f / SOFT_FILL);
    return out;
  }

  /** True when nothing of record i is left to see at this fill reading. */
  gone(i: number, fill: number): boolean {
    const f = Math.max(0, fill - this.f0[i]);
    return this.depth[i] - DEPTH_FILL_RATE * f <= 0.002 && this.rim[i] - RIM_FILL_RATE * f <= 0.001;
  }

  /**
   * Visit every live record whose centre lies within the box grown by MAX_REACH; records found
   * filled in are deleted on the way. `fn` returns false to stop early.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, fill: number, fn: (i: number) => boolean | void): void {
    const c0x = Math.floor((minX - MAX_REACH) / CELL), c1x = Math.floor((maxX + MAX_REACH) / CELL);
    const c0z = Math.floor((minZ - MAX_REACH) / CELL), c1z = Math.floor((maxZ + MAX_REACH) / CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const k = RecordStore.key(cx, cz);
        const l = this.cells.get(k);
        if (!l) continue;
        for (let j = 0; j < l.length; j++) {
          const i = l[j];
          if (this.gone(i, fill)) {
            this.kind[i] = DEAD;
            this.count--;
            l[j] = l[l.length - 1];
            l.pop();
            j--;
            continue;
          }
          const x = this.x[i], z = this.z[i];
          if (x < minX - MAX_REACH || x > maxX + MAX_REACH || z < minZ - MAX_REACH || z > maxZ + MAX_REACH) continue;
          if (fn(i) === false) return;
        }
        if (l.length === 0) this.cells.delete(k);
      }
    }
  }

  /**
   * Metres the snow is pressed below its surface at (x, z) now (approximate shapes; 0 where
   * untouched). For things that should sit in the snow: a downed body, a dropped item.
   */
  pressAt(x: number, z: number, fill: number): number {
    let best = 0;
    const r: Remaining = { depth: 0, rim: 0, fresh: 0, soft: 0 };
    this.query(x, z, x, z, fill, (i) => {
      const k = this.kind[i];
      if (k === K_KICK) return;
      const dx = x - this.x[i], dz = z - this.z[i];
      const t = dx * this.fx[i] + dz * this.fz[i];
      const s = dx * -this.fz[i] + dz * this.fx[i];
      let inside: boolean;
      if (k === K_GROOVE) {
        const tc = Math.max(-this.hl[i], Math.min(this.hl[i], t));
        inside = Math.hypot(s, t - tc) <= this.hw[i];
      } else if (k === K_PIT) {
        inside = Math.hypot(s, t) <= this.hw[i];
      } else if (k === K_BODY) {
        inside = Math.abs(s) <= this.hw[i] * 0.8 && Math.abs(t + 0.18) <= this.hl[i];
      } else {
        inside = (s / this.hw[i]) ** 2 + (t / this.hl[i]) ** 2 <= 1;
      }
      if (inside) best = Math.max(best, this.eval(i, fill, r).depth);
    });
    return best;
  }

  clear(): void {
    this.kind.fill(DEAD);
    this.cells.clear();
    this.head = 0;
    this.count = 0;
    this.serial++;
  }
}
