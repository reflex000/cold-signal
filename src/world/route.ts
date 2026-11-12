// The route: wreck -> tail -> cabin -> lake shore -> hut (out on the ice and back) -> cave ->
// camp -> tower. Each leg is found by A* on a 4 m grid where an edge costs its length, more
// for a steep grade (grades over GRADE_MAX are not allowed), more across steep ground, less
// along the skid scar. The path is then pulled straight where the ground allows, smoothed,
// and carved into the heightmap: a graded track (flat across, never steeper than TRAIL_GRADE
// along) blended into the slope, which is what makes the traverses and the ways in and out of
// the ravine walkable. The packed trail is written to a mask.
import { dlen, smooth01 } from './dmath';
import * as L from './layout';
import type { PoiId } from './types';

const N = L.N;
const EXT = L.EXTENT;
const CELL = L.CELL;

/** Planning grid: 4 m over [-G_EXT, G_EXT]. */
const G_CELL = 4;
const G_EXT = 772;
const GN = (G_EXT * 2) / G_CELL + 1; // 387

/** Largest grade of one planning edge (about 25 degrees). */
const GRADE_MAX = 0.47;
/** Largest grade of the carved track (about 27 degrees; the test allows 35). */
const TRAIL_GRADE = 0.5;
/** Half width of the flat core of the carved track, and of the blend into the slope. */
const CORE = 3.6;
const BLEND = 10;

export interface Stop { x: number; z: number; poi?: PoiId; /** straight segment from the previous stop (over the ice) */ straight?: boolean }
export interface Circle { x: number; z: number; r: number }

export interface RouteInput {
  h: Float32Array;
  seed: number;
  stops: Stop[];
  /** Circles the route may not enter (structures). */
  avoid: Circle[];
  /** Segments the route likes to follow (the skid scar). */
  prefer: { ax: number; az: number; bx: number; bz: number; w: number }[];
  /** Extra no-go test (the boulder choke). */
  blocked?: (x: number, z: number) => boolean;
}

export interface RouteResult {
  /** Dense polyline, about 2 m apart, of the walked route (the ice spur goes out and back). */
  path: { x: number; z: number }[];
  /** Index into `path` of each stop. */
  stopAt: number[];
  /** Waypoints about every 20 m (closer on bends) with the place tags. */
  waypoints: { x: number; z: number; poi?: PoiId }[];
  /** Packed trail, 0..255 per heightmap vertex. */
  trail: Uint8Array;
  length: number;
}

function hAt(h: Float32Array, x: number, z: number): number {
  let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
  if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
  if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const k = j * N + i;
  const a = h[k], b = h[k + 1], c = h[k + N], d = h[k + N + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ------------------------------------------------------------------------------------------
// A*
// ------------------------------------------------------------------------------------------
const MOVES: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
];

class Heap {
  key = new Float64Array(1 << 16);
  val = new Int32Array(1 << 16);
  size = 0;
  push(k: number, v: number): void {
    if (this.size === this.key.length) {
      const nk = new Float64Array(this.size * 2), nv = new Int32Array(this.size * 2);
      nk.set(this.key);
      nv.set(this.val);
      this.key = nk;
      this.val = nv;
    }
    let i = this.size++;
    const K = this.key, V = this.val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] < k || (K[p] === k && V[p] <= v)) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = k;
    V[i] = v;
  }
  pop(): number {
    const K = this.key, V = this.val;
    const top = V[0];
    const n = --this.size;
    const k = K[n], v = V[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (K[c + 1] < K[c] || (K[c + 1] === K[c] && V[c + 1] < V[c]))) c++;
      if (K[c] > k || (K[c] === k && V[c] >= v)) break;
      K[i] = K[c];
      V[i] = V[c];
      i = c;
    }
    K[i] = k;
    V[i] = v;
    return top;
  }
}

interface Grid {
  gh: Float64Array; // height
  pen: Float64Array; // per-node cost factor (>= 1), Infinity = forbidden
  prefer: Float64Array; // per-node discount factor (<= 1)
}

function buildGrid(inp: RouteInput): Grid {
  const { h, seed } = inp;
  const size = GN * GN;
  const gh = new Float64Array(size);
  const pen = new Float64Array(size);
  const prefer = new Float64Array(size);
  for (let gj = 0; gj < GN; gj++) {
    const z = -G_EXT + gj * G_CELL;
    for (let gi = 0; gi < GN; gi++) {
      const x = -G_EXT + gi * G_CELL;
      gh[gj * GN + gi] = h[((z + EXT) / CELL) * N + (x + EXT) / CELL];
    }
  }
  for (let gj = 0; gj < GN; gj++) {
    const z = -G_EXT + gj * G_CELL;
    for (let gi = 0; gi < GN; gi++) {
      const x = -G_EXT + gi * G_CELL;
      const k = gj * GN + gi;
      let p = 1;
      if (gi === 0 || gj === 0 || gi === GN - 1 || gj === GN - 1) p = Infinity;
      else {
        // ground slope at the node: a traverse of steep ground needs a deep cut
        const gx = (gh[k + 1] - gh[k - 1]) / (2 * G_CELL), gz = (gh[k + GN] - gh[k - GN]) / (2 * G_CELL);
        const g = Math.sqrt(gx * gx + gz * gz);
        if (g > 0.53) p += 6 * (g - 0.53); // 28 degrees
        if (g > 1.2) p += 30; // 50 degrees: only if there is no other way
        if (L.lakeSdf(x, z, seed) < 5) p = Infinity;
        else if (inp.blocked && inp.blocked(x, z)) p = Infinity;
        else {
          for (const c of inp.avoid) {
            const dx = x - c.x, dz = z - c.z;
            if (dx * dx + dz * dz < (c.r + 1.5) * (c.r + 1.5)) {
              p = Infinity;
              break;
            }
          }
        }
      }
      pen[k] = p;
      let f = 1;
      for (const s of inp.prefer) {
        const vx = s.bx - s.ax, vz = s.bz - s.az;
        const l2 = vx * vx + vz * vz;
        let t = ((x - s.ax) * vx + (z - s.az) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = dlen(s.ax + vx * t - x, s.az + vz * t - z);
        if (d < s.w) f = Math.min(f, 0.62 + 0.38 * (d / s.w));
      }
      prefer[k] = f;
    }
  }
  return { gh, pen, prefer };
}

function nodeOf(x: number, z: number): number {
  let gi = Math.round((x + G_EXT) / G_CELL), gj = Math.round((z + G_EXT) / G_CELL);
  gi = gi < 1 ? 1 : gi > GN - 2 ? GN - 2 : gi;
  gj = gj < 1 ? 1 : gj > GN - 2 ? GN - 2 : gj;
  return gj * GN + gi;
}

function astar(g: Grid, ax: number, az: number, bx: number, bz: number, gradeMax: number): { x: number; z: number }[] | null {
  const size = GN * GN;
  const start = nodeOf(ax, az), goal = nodeOf(bx, bz);
  const gs = new Float64Array(size).fill(Infinity);
  const from = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const heap = new Heap();
  const gxg = goal % GN, gzg = (goal - gxg) / GN;
  const hfun = (n: number) => {
    const x = n % GN, z = (n - x) / GN;
    return dlen(x - gxg, z - gzg) * G_CELL;
  };
  gs[start] = 0;
  heap.push(hfun(start), start);
  const { gh, pen, prefer } = g;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % GN, cj = (cur - ci) / GN;
    const hc = gh[cur];
    for (let m = 0; m < 16; m++) {
      const mi = MOVES[m][0], mj = MOVES[m][1];
      const ni = ci + mi, nj = cj + mj;
      if (ni < 1 || nj < 1 || ni > GN - 2 || nj > GN - 2) continue;
      const nb = nj * GN + ni;
      if (closed[nb]) continue;
      const pn = nb === goal ? 1 : pen[nb];
      if (pn === Infinity) continue;
      const len = Math.sqrt(mi * mi + mj * mj) * G_CELL;
      let grade = Math.abs(gh[nb] - hc) / len;
      if (m >= 8) {
        // knight move: check the ground halfway (both half grades)
        const mid = 0.5 * (gh[cj * GN + ni] + gh[nj * GN + ci]);
        const g1 = Math.abs(mid - hc) / (len / 2), g2 = Math.abs(gh[nb] - mid) / (len / 2);
        if (g1 > grade) grade = g1;
        if (g2 > grade) grade = g2;
        const pm = Math.max(pen[cj * GN + ni], pen[nj * GN + ci]);
        if (pm === Infinity) continue;
      }
      if (grade > gradeMax) continue;
      const q = grade / gradeMax;
      const cost = len * (1 + 2.5 * q * q) * pn * prefer[nb];
      const ng = gs[cur] + cost;
      if (ng < gs[nb]) {
        gs[nb] = ng;
        from[nb] = cur;
        heap.push(ng + hfun(nb), nb);
      }
    }
  }
  if (from[goal] < 0 && goal !== start) return null;
  const out: { x: number; z: number }[] = [];
  for (let n = goal; n >= 0; n = n === start ? -1 : from[n]) {
    const x = n % GN, z = (n - x) / GN;
    out.push({ x: -G_EXT + x * G_CELL, z: -G_EXT + z * G_CELL });
  }
  out.reverse();
  return out;
}

// ------------------------------------------------------------------------------------------
// shaping the path
// ------------------------------------------------------------------------------------------
/** Is the straight segment a-b fine to walk: no grade over max, no forbidden node, no steep ground? */
function segmentOk(g: Grid, h: Float32Array, ax: number, az: number, bx: number, bz: number, gradeMax: number): boolean {
  const len = dlen(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 2));
  let ph = hAt(h, ax, az);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const hh = hAt(h, x, z);
    if (Math.abs(hh - ph) / (len / steps) > gradeMax) return false;
    ph = hh;
    const n = nodeOf(x, z);
    if (g.pen[n] === Infinity || g.pen[n] > 2.2) return false;
  }
  return true;
}

function pullStraight(g: Grid, h: Float32Array, pts: { x: number; z: number }[]): { x: number; z: number }[] {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = Math.min(pts.length - 1, i + 13); // short chords: a trail bends with the ground
    while (j > i + 1 && !segmentOk(g, h, pts[i].x, pts[i].z, pts[j].x, pts[j].z, GRADE_MAX * 0.94)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

function chaikin(pts: { x: number; z: number }[], iterations: number): { x: number; z: number }[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const o = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      o.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      o.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}

function resample(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const out = [{ x: pts[0].x, z: pts[0].z }];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = dlen(b.x - a.x, b.z - a.z);
    if (len < 1e-9) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      d += step;
    }
    carry = len - (d - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (dlen(last.x - tail.x, last.z - tail.z) > step * 0.3) out.push({ x: last.x, z: last.z });
  else out[out.length - 1] = { x: last.x, z: last.z };
  return out;
}

/** Douglas-Peucker with a maximum segment length. */
function simplify(pts: { x: number; z: number }[], tol: number, maxLen: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const ax = pts[a].x, az = pts[a].z, bx = pts[b].x, bz = pts[b].z;
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz;
    let worst = -1, wd = 0;
    for (let i = a + 1; i < b; i++) {
      let t = l2 > 0 ? ((pts[i].x - ax) * vx + (pts[i].z - az) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = dlen(ax + vx * t - pts[i].x, az + vz * t - pts[i].z);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (wd > tol || Math.sqrt(l2) > maxLen) {
      const m = wd > tol ? worst : (a + b) >> 1;
      keep[m] = 1;
      stack.push([a, m], [m, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

// ------------------------------------------------------------------------------------------
// carving
// ------------------------------------------------------------------------------------------
/** Grade the track along `pts` (2 m apart) into the heightmap and write the trail mask. */
function carve(h: Float32Array, pts: { x: number; z: number }[], noCarve: boolean[], trail: Uint8Array, best: Float32Array, target: Float32Array, touched: number[]): void {
  const n = pts.length;
  if (n < 2) return;
  // the profile: the ground, smoothed, then limited in grade both ways
  const raw = new Float64Array(n);
  for (let k = 0; k < n; k++) raw[k] = hAt(h, pts[k].x, pts[k].z);
  const p = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - 5); q <= Math.min(n - 1, k + 5); q++) {
      s += raw[q];
      c++;
    }
    p[k] = s / c;
  }
  p[0] = raw[0];
  p[n - 1] = raw[n - 1];
  const ds = new Float64Array(n);
  for (let k = 1; k < n; k++) ds[k] = dlen(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  for (let k = 1; k < n; k++) {
    const m = TRAIL_GRADE * ds[k];
    if (p[k] > p[k - 1] + m) p[k] = p[k - 1] + m;
    else if (p[k] < p[k - 1] - m) p[k] = p[k - 1] - m;
  }
  for (let k = n - 2; k >= 0; k--) {
    const m = TRAIL_GRADE * ds[k + 1];
    if (p[k] > p[k + 1] + m) p[k] = p[k + 1] + m;
    else if (p[k] < p[k + 1] - m) p[k] = p[k + 1] - m;
  }
  // splat: nearest segment per vertex
  for (let k = 0; k < n - 1; k++) {
    const ax = pts[k].x, az = pts[k].z, bx = pts[k + 1].x, bz = pts[k + 1].z;
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz || 1e-9;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - BLEND + EXT) / CELL)), i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + BLEND + EXT) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - BLEND + EXT) / CELL)), j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + BLEND + EXT) / CELL));
    const skip = noCarve[k] && noCarve[k + 1];
    for (let j = j0; j <= j1; j++) {
      const z = -EXT + j * CELL;
      for (let i = i0; i <= i1; i++) {
        const x = -EXT + i * CELL;
        let t = ((x - ax) * vx + (z - az) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = dlen(ax + vx * t - x, az + vz * t - z);
        if (d >= BLEND) continue;
        const v = j * N + i;
        const tv = Math.round(255 * (1 - smooth01(0.8, 2.3, d)));
        if (!skip && tv > trail[v]) trail[v] = tv;
        if (skip) continue;
        if (best[v] === Infinity) touched.push(v);
        if (d < best[v]) {
          best[v] = d;
          target[v] = p[k] + (p[k + 1] - p[k]) * t;
        }
      }
    }
  }
}

/** Distance from a point to a dense polyline, through a bucket grid of its points (approximate to
 * half the point spacing). */
export function pathDistance(path: { x: number; z: number }[]): (x: number, z: number) => number {
  const C = 40, GN = Math.ceil((EXT * 2) / C);
  const cells: number[][] = [];
  for (let i = 0; i < GN * GN; i++) cells.push([]);
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    const i = Math.floor((p.x + EXT) / C), j = Math.floor((p.z + EXT) / C);
    if (i >= 0 && j >= 0 && i < GN && j < GN) cells[j * GN + i].push(k);
  }
  return (x, z) => {
    const ci = Math.floor((x + EXT) / C), cj = Math.floor((z + EXT) / C);
    let best = Infinity;
    for (let r = 0; r < 10; r++) {
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (i < 0 || j < 0 || i >= GN || j >= GN) continue;
          for (const k of cells[j * GN + i]) {
            const d = dlen(path[k].x - x, path[k].z - z);
            if (d < best) best = d;
          }
        }
      }
      if (best < r * C) break;
    }
    return best;
  };
}

// ------------------------------------------------------------------------------------------
// the whole route
// ------------------------------------------------------------------------------------------
export function buildRoute(inp: RouteInput): RouteResult {
  const g = buildGrid(inp);
  const { h, seed, stops } = inp;
  const path: { x: number; z: number }[] = [];
  const noCarve: boolean[] = [];
  const stopAt: number[] = [];
  for (let s = 0; s < stops.length; s++) {
    const st = stops[s];
    if (s === 0) {
      path.push({ x: st.x, z: st.z });
      noCarve.push(false);
      stopAt.push(0);
      continue;
    }
    const prev = stops[s - 1];
    let leg: { x: number; z: number }[];
    let onIce = false;
    if (st.straight) {
      leg = resample([{ x: prev.x, z: prev.z }, { x: st.x, z: st.z }], 2);
      onIce = true;
    } else {
      let raw = astar(g, prev.x, prev.z, st.x, st.z, GRADE_MAX);
      if (!raw) raw = astar(g, prev.x, prev.z, st.x, st.z, GRADE_MAX * 1.6);
      if (!raw) raw = [{ x: prev.x, z: prev.z }, { x: st.x, z: st.z }];
      raw[0] = { x: prev.x, z: prev.z };
      raw[raw.length - 1] = { x: st.x, z: st.z };
      leg = resample(chaikin(pullStraight(g, h, raw), 3), 2);
    }
    for (let k = 1; k < leg.length; k++) {
      path.push(leg[k]);
      noCarve.push(onIce || L.lakeSdf(leg[k].x, leg[k].z, seed) < 1.5);
    }
    stopAt.push(path.length - 1);
  }
  // carve
  const trail = new Uint8Array(N * N);
  const best = new Float32Array(N * N).fill(Infinity);
  const target = new Float32Array(N * N);
  const touched: number[] = [];
  carve(h, path, noCarve, trail, best, target, touched);
  for (const v of touched) {
    const d = best[v];
    const w = d <= CORE ? 1 : 1 - smooth01(CORE, BLEND, d);
    const i = v % N, j = (v - i) / N;
    if (L.lakeSdf(-EXT + i * CELL, -EXT + j * CELL, seed) < 0.5) continue;
    h[v] = h[v] + (target[v] - h[v]) * w;
  }
  // waypoints
  const waypoints: { x: number; z: number; poi?: PoiId }[] = [];
  const tagged = new Set<PoiId>();
  for (let s = 0; s < stops.length - 1; s++) {
    const a = stopAt[s], b = stopAt[s + 1];
    const seg = path.slice(a, b + 1);
    const idx = simplify(seg, 0.7, 20);
    for (let q = 0; q < idx.length; q++) {
      if (s > 0 && q === 0) continue; // shared with the previous leg
      const pt = seg[idx[q]];
      const wp: { x: number; z: number; poi?: PoiId } = { x: pt.x, z: pt.z };
      const stopIdx = q === 0 ? s : q === idx.length - 1 ? s + 1 : -1;
      if (stopIdx >= 0) {
        const poi = stops[stopIdx].poi;
        if (poi && !tagged.has(poi)) {
          wp.poi = poi;
          tagged.add(poi);
        }
      }
      waypoints.push(wp);
    }
  }
  let length = 0;
  for (let k = 1; k < path.length; k++) length += dlen(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
  return { path, stopAt, waypoints, trail, length };
}
