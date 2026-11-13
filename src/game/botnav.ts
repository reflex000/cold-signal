// What the bot brain (bots.ts) knows and how it walks.
//
// Reader: the game state a mind reads, from either side of the wire. Companion bots run beside the
// host and read the authoritative state (SimReader), as a host-side AI would; the autopilot that
// plays the local player in the release scenario reads the client's View (ViewReader), so it plays
// through prediction, interpolation and the transport exactly like a person.
//
// Nav: getting a body from where it is to a goal without walking into the lake, off a cliff or into
// a fire. Far goals follow the packed route trail the world was carved with; near goals (inside 40 m)
// are planned on a fine local grid (A*, 0.5 m cells) over the world's walkable test, with the ice,
// cliffs and lit fires masked out, and doorways snapped to their exact centre. Every step is checked
// again just ahead of the feet (safeStep), so a moving hazard (a fresh hole, a new fire) still stops it.
// Owner: TOGETHER.
import { smoothstep, wrapAngle } from '../core/math';
import type { SimCtx } from '../sim/api';
import { iceCellState } from '../sim/systems/ice';
import type { Entity, EntityKind, Env, IceCell, NetId, Objective, PlayerEnt } from '../sim/types';
import type { WorldEx } from '../world/index';
import type { View } from './view';

// =============================================================================================== reading

export interface Reader {
  readonly world: WorldEx;
  env(): Env;
  objective(): Objective;
  get(id: NetId): Entity | undefined;
  list<K extends EntityKind>(kind: K): readonly Extract<Entity, { kind: K }>[];
  /** Stressed, broken or refrozen lake cell i, if any. */
  ice(i: number): IceCell | undefined;
}

/** The authoritative state, read beside the host (companion bots). */
export class SimReader implements Reader {
  constructor(readonly world: WorldEx, private ctx: SimCtx) {}
  setCtx(ctx: SimCtx): void {
    this.ctx = ctx;
  }
  env(): Env {
    return this.ctx.state.env;
  }
  objective(): Objective {
    return this.ctx.state.objective;
  }
  get(id: NetId): Entity | undefined {
    return id ? this.ctx.get(id) : undefined;
  }
  list<K extends EntityKind>(kind: K): readonly Extract<Entity, { kind: K }>[] {
    return this.ctx.all(kind);
  }
  ice(i: number): IceCell | undefined {
    return iceCellState(this.ctx.state, i);
  }
}

/** The client's view: what a remote player's machine knows (the autopilot of the release test). */
export class ViewReader implements Reader {
  constructor(readonly world: WorldEx, private readonly view: View) {}
  env(): Env {
    return this.view.env;
  }
  objective(): Objective {
    return this.view.objective;
  }
  get(id: NetId): Entity | undefined {
    return id ? this.view.ents.get(id) : undefined;
  }
  list<K extends EntityKind>(kind: K): readonly Extract<Entity, { kind: K }>[] {
    return this.view.list(kind);
  }
  ice(i: number): IceCell | undefined {
    return this.view.ice.get(i);
  }
}

// =============================================================================================== hazards

/** Ice this thin or thinner (m) is never stepped on; the pole-marked safe line is 0.56 m and more. */
export const ICE_SAFE = 0.2;

/** How dangerous the lake is at a point for a body, 0 (no ice, or ice that holds) .. 1 (open water). */
export function iceRisk(r: Reader, x: number, z: number): number {
  const w = r.world;
  const i = w.iceCell(x, z);
  if (i < 0) return 0;
  const h = w.lake.thickness[i];
  if (!(h > 0)) return 0;
  const c = r.ice(i);
  if (c && c.hole) return 1;
  // a refrozen hole bears only its new skin (snapshots carry it as IceCell.skin)
  const bearing = c && c.skin !== undefined ? Math.min(h, c.skin) : h;
  const thin = 1 - smoothstep(0.08, ICE_SAFE + 0.06, bearing);
  return Math.max(thin, c ? c.stress : 0);
}

const yawTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

// =============================================================================================== planning

const CELL = 0.5;
const MAX_HALF = 40; // metres: local plans reach this far from the goal
const MAX_EXPAND = 26000;

/** Walkability per 0.5 m cell for the whole session (the static world never changes). */
class WalkCache {
  private readonly m = new Map<number, boolean>();
  constructor(private readonly world: WorldEx) {}
  at(x: number, z: number): boolean {
    const i = Math.round(x / CELL), j = Math.round(z / CELL);
    const k = (i + 8192) * 16384 + (j + 8192);
    let v = this.m.get(k);
    if (v === undefined) {
      v = this.world.walkable(i * CELL, j * CELL);
      if (this.m.size > 400000) this.m.clear();
      this.m.set(k, v);
    }
    return v;
  }
}

/** A doorway: its centre and the unit normal pointing out of the building. */
interface Door { x: number; z: number; nx: number; nz: number }

/** Binary heap of grid indices keyed by f. */
class Heap {
  private ids: number[] = [];
  private fs: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  clear(): void {
    this.ids.length = 0;
    this.fs.length = 0;
  }
  push(id: number, f: number): void {
    const ids = this.ids, fs = this.fs;
    let i = ids.length;
    ids.push(id);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= f) break;
      ids[i] = ids[p];
      fs[i] = fs[p];
      i = p;
    }
    ids[i] = id;
    fs[i] = f;
  }
  pop(): number {
    const ids = this.ids, fs = this.fs;
    const top = ids[0];
    const lid = ids.pop()!, lf = fs.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mf = lf;
        if (l < n && fs[l] < mf) {
          m = l;
          mf = fs[l];
        }
        if (r < n && fs[r] < mf) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        fs[i] = fs[m];
        i = m;
      }
      ids[i] = lid;
      fs[i] = lf;
    }
    return top;
  }
}

export interface Pt { x: number; z: number }

/**
 * The route planner shared by every mind of a session: trail following for far goals, a fine local
 * A* for near ones, the doorways of the buildings, and the hazard tests.
 */
export class Planner {
  readonly walk: WalkCache;
  private readonly doors: Door[] = [];
  private readonly heap = new Heap();
  private g = new Float32Array(0);
  private from = new Int32Array(0);
  private state = new Uint8Array(0); // 0 unknown, 1 open, 2 closed, 3 blocked
  /** Lit fires to keep out of this tick (x, z pairs), set by the brain. */
  fires: number[] = [];

  constructor(readonly world: WorldEx) {
    this.walk = new WalkCache(world);
    for (const [k, a] of Object.entries(world.anchors)) {
      if (!/\.door$/.test(k)) continue;
      // anchors carry the building's yaw; a door is in the front (+Z) wall, so out is +Z turned by yaw
      this.doors.push({ x: a.x, z: a.z, nx: Math.sin(a.yaw), nz: Math.cos(a.yaw) });
    }
  }

  /** Can a body stand here and walk on: walkable ground, not thin ice or open water, not in a fire. */
  passable(r: Reader, x: number, z: number): boolean {
    if (!this.walk.at(x, z)) return false;
    if (iceRisk(r, x, z) > 0.25) return false;
    const f = this.fires;
    for (let i = 0; i < f.length; i += 2) {
      const dx = x - f[i], dz = z - f[i + 1];
      if (dx * dx + dz * dz < 0.85 * 0.85) return false;
    }
    return true;
  }

  /** The terrain does not fall away between two near points (a cornice, a ravine edge). */
  noDrop(ax: number, az: number, bx: number, bz: number): boolean {
    const w = this.world;
    const d = Math.hypot(bx - ax, bz - az);
    if (d < 1e-3) return true;
    const dh = w.heightAt(ax, az) - w.heightAt(bx, bz);
    return dh < Math.max(0.9, d * 1.1);
  }

  /** The straight walk from a to b stays on passable ground (sampled every 0.35 m). */
  lineOk(r: Reader, ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / 0.35));
    let px = ax, pz = az;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (!this.passable(r, x, z) || !this.noDrop(px, pz, x, z)) return false;
      px = x;
      pz = z;
    }
    return true;
  }

  /** The nearest passable spot to (x, z) within `reach` metres, or null. */
  nearestPassable(r: Reader, x: number, z: number, reach = 4): Pt | null {
    if (this.passable(r, x, z)) return { x, z };
    for (let rad = CELL; rad <= reach; rad += CELL) {
      const n = Math.max(8, Math.round((rad * 2 * Math.PI) / CELL));
      let best: Pt | null = null;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const sx = x + Math.sin(a) * rad, sz = z + Math.cos(a) * rad;
        if (this.passable(r, sx, sz)) {
          best = { x: sx, z: sz };
          break;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * A* on 0.5 m cells from (sx, sz) to the cell nearest (gx, gz) that satisfies `goal` (default: the
   * goal cell itself), inside a square of half-size up to 40 m around the goal. Returns smoothed
   * waypoints (start excluded), or null when there is no way inside the window.
   */
  plan(r: Reader, sx: number, sz: number, gx: number, gz: number, goal?: (x: number, z: number) => boolean): Pt[] | null {
    const half = Math.min(MAX_HALF, Math.max(10, Math.hypot(sx - gx, sz - gz) + 8));
    const n = Math.ceil((half * 2) / CELL) + 1;
    const ox = gx - half, oz = gz - half;
    const size = n * n;
    if (this.g.length < size) {
      this.g = new Float32Array(size);
      this.from = new Int32Array(size);
      this.state = new Uint8Array(size);
    } else this.state.fill(0, 0, size);
    const cellOf = (x: number, z: number): number => {
      const i = Math.round((x - ox) / CELL), j = Math.round((z - oz) / CELL);
      return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i;
    };
    const cx = (c: number) => ox + (c % n) * CELL;
    const cz = (c: number) => oz + Math.floor(c / n) * CELL;
    const isGoal = goal ?? ((x: number, z: number) => Math.hypot(x - gx, z - gz) < CELL * 0.75);
    const st = this.state, g = this.g, from = this.from;
    const free = (c: number): boolean => {
      const s = st[c];
      if (s === 3) return false;
      if (s !== 0) return true;
      if (!this.passable(r, cx(c), cz(c))) {
        st[c] = 3;
        return false;
      }
      return true;
    };
    let start = cellOf(sx, sz);
    if (start < 0) return null;
    if (!free(start)) {
      // standing on an edge cell (a wall's skin, a fire's ring): start from the nearest free neighbour
      let alt = -1;
      for (let dj = -2; dj <= 2 && alt < 0; dj++) for (let di = -2; di <= 2 && alt < 0; di++) {
        const c = start + dj * n + di;
        if (c >= 0 && c < size && Math.abs((c % n) - (start % n)) <= 2 && free(c)) alt = c;
      }
      if (alt < 0) return null;
      start = alt;
    }
    const heap = this.heap;
    heap.clear();
    const h = (c: number): number => {
      const dx = Math.abs(cx(c) - gx), dz = Math.abs(cz(c) - gz);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    g[start] = 0;
    from[start] = -1;
    st[start] = 1;
    heap.push(start, h(start));
    let found = -1, expanded = 0;
    while (heap.size > 0 && expanded < MAX_EXPAND) {
      const c = heap.pop();
      if (st[c] === 2) continue;
      st[c] = 2;
      expanded++;
      const x = cx(c), z = cz(c);
      if (isGoal(x, z)) {
        found = c;
        break;
      }
      const i = c % n, j = (c - i) / n;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= n) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ii = i + di;
          if (ii < 0 || ii >= n) continue;
          const nb = jj * n + ii;
          if (st[nb] === 2 || !free(nb)) continue;
          if (di !== 0 && dj !== 0 && (!free(j * n + ii) || !free(jj * n + i))) continue; // no corner cutting
          const nx = cx(nb), nz = cz(nb);
          if (!this.noDrop(x, z, nx, nz)) continue;
          const step = di !== 0 && dj !== 0 ? CELL * 1.4142 : CELL;
          // a little extra for thin-ish ice and steep ground, so plans keep to the safe line and the trail
          const risk = iceRisk(r, nx, nz);
          const ng = g[c] + step * (1 + 3 * risk);
          if (st[nb] === 1 && ng >= g[nb]) continue;
          g[nb] = ng;
          from[nb] = c;
          st[nb] = 1;
          heap.push(nb, ng + h(nb));
        }
      }
    }
    if (found < 0) return null;
    const raw: Pt[] = [];
    for (let c = found; c !== -1 && c !== start; c = from[c]) raw.push({ x: cx(c), z: cz(c) });
    raw.reverse();
    return this.snapDoors(this.smooth(r, sx, sz, raw));
  }

  /** Drop waypoints a straight walk can skip (string pulling). */
  private smooth(r: Reader, sx: number, sz: number, pts: Pt[]): Pt[] {
    if (pts.length <= 2) return pts;
    const out: Pt[] = [];
    let ax = sx, az = sz;
    let k = 0;
    while (k < pts.length) {
      let far = k;
      for (let m = pts.length - 1; m > k; m--) {
        if (this.lineOk(r, ax, az, pts[m].x, pts[m].z)) {
          far = m;
          break;
        }
      }
      out.push(pts[far]);
      ax = pts[far].x;
      az = pts[far].z;
      k = far + 1;
    }
    return out;
  }

  /** A path through a doorway goes through its exact centre, square to the wall. */
  private snapDoors(pts: Pt[]): Pt[] {
    if (this.doors.length === 0 || pts.length === 0) return pts;
    const out: Pt[] = [];
    let px = pts[0].x, pz = pts[0].z;
    out.push(pts[0]);
    for (let k = 1; k < pts.length; k++) {
      const q = pts[k];
      for (const d of this.doors) {
        // does the leg p -> q cross the door's wall line near the door?
        const sa = (px - d.x) * d.nx + (pz - d.z) * d.nz;
        const sb = (q.x - d.x) * d.nx + (q.z - d.z) * d.nz;
        if (sa * sb >= 0 || Math.abs(sa - sb) < 1e-6) continue;
        const t = sa / (sa - sb);
        const ix = px + (q.x - px) * t, iz = pz + (q.z - pz) * t;
        if (Math.hypot(ix - d.x, iz - d.z) > 1.4) continue;
        const sgn = sa > 0 ? 1 : -1; // which side the leg starts on
        out.push({ x: d.x + d.nx * 0.9 * sgn, z: d.z + d.nz * 0.9 * sgn });
        out.push({ x: d.x, z: d.z });
        out.push({ x: d.x - d.nx * 0.9 * sgn, z: d.z - d.nz * 0.9 * sgn });
      }
      out.push(q);
      px = q.x;
      pz = q.z;
    }
    return out;
  }

  // --------------------------------------------------------------------------------------- trail

  /** Index of the trail point nearest (x, z). */
  trailIndex(x: number, z: number): number {
    const t = this.world.trail;
    let best = 0, bd = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = (t[i].x - x) * (t[i].x - x) + (t[i].z - z) * (t[i].z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}

// =============================================================================================== walking

/** One body's way to its current goal. */
export class Walker {
  path: Pt[] = [];
  goalX = NaN;
  goalZ = NaN;
  planAge = 99;
  lastX = 0;
  lastZ = 0;
  checkT = 0;
  stuck = 0;
  /** Which way to veer round an obstacle (+1 / -1); flips when stuck. */
  side = 1;
  /** Seconds the current goal has been pursued. */
  age = 0;

  constructor(side: number) {
    this.side = side;
  }

  reset(): void {
    this.path.length = 0;
    this.goalX = NaN;
    this.goalZ = NaN;
    this.planAge = 99;
    this.stuck = 0;
    this.age = 0;
  }
}

export interface Steer {
  yaw: number;
  mz: number;
  sprint: boolean;
  jump: boolean;
  arrived: boolean;
  /** No way found (the goal is unreachable from here for now). */
  blocked: boolean;
}

const FAR = 34; // metres: beyond this a goal is approached along the trail first

/**
 * One tick of walking toward (gx, gz): returns the yaw to face and how hard to push forward.
 * `near` is how close counts as there. The walker keeps its plan between ticks.
 */
export function steer(pl: Planner, r: Reader, w: Walker, p: PlayerEnt, gx: number, gz: number, near: number, dt: number, out: Steer, opts: { run?: boolean; goal?: (x: number, z: number) => boolean } = {}): Steer {
  out.jump = false;
  out.sprint = false;
  out.blocked = false;
  const d = Math.hypot(gx - p.x, gz - p.z);
  if (d <= near) {
    out.arrived = true;
    out.mz = 0;
    out.yaw = p.yaw;
    w.path.length = 0;
    w.stuck = 0;
    return out;
  }
  out.arrived = false;
  if (Math.hypot(gx - w.goalX, gz - w.goalZ) > Math.max(1.5, d * 0.15)) {
    // a new goal (or the old one moved): plan again
    w.goalX = gx;
    w.goalZ = gz;
    w.path.length = 0;
    w.planAge = 99;
    w.age = 0;
  }
  w.age += dt;
  w.planAge += dt;

  let tx = gx, tz = gz;
  if (d > FAR) {
    // far: along the trail, toward the trail point nearest the goal
    const t = pl.world.trail;
    const i = pl.trailIndex(p.x, p.z), gi = pl.trailIndex(gx, gz);
    const onTrail = Math.hypot(t[i].x - p.x, t[i].z - p.z) < 12;
    if (onTrail && Math.abs(gi - i) > 3 && Math.hypot(t[gi].x - gx, t[gi].z - gz) < d * 0.6) {
      const dir = gi > i ? 1 : -1;
      let k = i;
      // aim about 7 m ahead along the trail
      while (k !== gi && Math.hypot(t[k].x - p.x, t[k].z - p.z) < 7) k += dir;
      tx = t[k].x;
      tz = t[k].z;
      w.path.length = 0;
    } else if (!pl.lineOk(r, p.x, p.z, p.x + (gx - p.x) * (8 / d), p.z + (gz - p.z) * (8 / d))) {
      // off the trail with something in the way: plan to a point 30 m along the way
      const k = 30 / d;
      if (w.path.length === 0 && w.planAge > 1.5) {
        w.planAge = 0;
        w.path = pl.plan(r, p.x, p.z, p.x + (gx - p.x) * k, p.z + (gz - p.z) * k) ?? [];
      }
    }
  } else if (w.path.length === 0 && w.planAge > 0.8 && (opts.goal || !pl.lineOk(r, p.x, p.z, gx, gz))) {
    w.planAge = 0;
    const path = pl.plan(r, p.x, p.z, gx, gz, opts.goal);
    if (path) w.path = path;
    else out.blocked = w.age > 3;
  }

  // follow the plan
  const path = w.path;
  while (path.length > 0 && Math.hypot(path[0].x - p.x, path[0].z - p.z) < 0.55) path.shift();
  if (path.length > 0) {
    tx = path[0].x;
    tz = path[0].z;
  }

  let yaw = yawTo(tx - p.x, tz - p.z);
  // the next 1.6 m must be safe: turn away from a hazard right ahead, toward the goal side
  const ok = (a: number): boolean => {
    for (const s of [0.6, 1.2, 1.7]) {
      const x = p.x - Math.sin(a) * s, z = p.z - Math.cos(a) * s;
      if (!pl.passable(r, x, z) || !pl.noDrop(p.x, p.z, x, z)) return false;
    }
    return true;
  };
  if (!ok(yaw)) {
    let found = false;
    for (const off of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9]) {
      const a = yaw + off * w.side;
      if (ok(a)) {
        yaw = a;
        found = true;
        break;
      }
    }
    if (!found) {
      // nowhere safe ahead: stand still and plan around (the ice edge, a cliff top)
      out.mz = 0;
      out.yaw = yaw;
      out.blocked = true;
      if (path.length === 0 && w.planAge > 0.8) {
        w.planAge = 0;
        w.path = pl.plan(r, p.x, p.z, gx, gz, opts.goal) ?? [];
      }
      return out;
    }
  }

  // stuck: pushing on but not getting anywhere for a while -> hop, veer, plan again
  w.checkT += dt;
  if (w.checkT >= 1.2) {
    const moved = Math.hypot(p.x - w.lastX, p.z - w.lastZ);
    w.stuck = moved < 0.35 ? w.stuck + 1 : 0;
    w.lastX = p.x;
    w.lastZ = p.z;
    w.checkT = 0;
    if (w.stuck >= 2) {
      w.side = -w.side;
      w.path.length = 0;
      w.planAge = 99;
    }
    if (w.stuck >= 2 && w.stuck % 2 === 0) out.jump = true;
  }
  if (w.stuck >= 3) yaw += 0.9 * w.side;

  out.yaw = wrapAngle(yaw);
  const left = path.length > 0 ? Infinity : d - near;
  out.mz = left < 1.2 ? 0.45 : 1;
  out.sprint = !!opts.run && d > 14 && p.stamina > 0.45 && iceRisk(r, p.x, p.z) === 0 && p.carry === 0;
  return out;
}
