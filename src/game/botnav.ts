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
//
// Reach: a spot to work a thing from (a pickup, a device, a fire to light, feed or sit by) is one
// the host agrees can reach it (inReach mirrors items.ts canReach) and, by a fire, one its heat
// reaches (canWork): near is not enough, a wall in between puts it out of reach. The planner's goal
// and the walker's "arrived" both ask it (Planner.workSpot).
// Owner: TOGETHER.
import { smoothstep, wrapAngle } from '../core/math';
import type { SimCtx } from '../sim/api';
import { EYE_STAND } from '../sim/move';
import { iceCellState } from '../sim/systems/ice';
import { AIM, REACH } from '../sim/systems/items';
import { DEVICE_AIM } from '../sim/systems/objective';
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

// =============================================================================================== reach

/**
 * Could a body with its feet at (x, y, z) work `e` with its hands: the host's reach test (items.ts
 * canReach, objective.ts deviceReach for devices) without the allowance it makes for a lagging view,
 * so the host agrees. The eye must be within REACH of the thing's aim point (plus its radius) with
 * nothing solid in between; the sight line stops short of the thing, which stands inside its own
 * collider (the stove, the panel cabinet). Right behind the cabin wall the stove is near and out of
 * reach.
 */
export function inReach(world: WorldEx, x: number, y: number, z: number, e: Entity): boolean {
  const sh = e.kind === 'device' ? DEVICE_AIM[e.type] ?? DEVICE_AIM.panel : AIM[e.kind] ?? AIM.pickup;
  const ey = y + EYE_STAND;
  const dx = e.x - x, dy = e.y + sh.y - ey, dz = e.z - z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > REACH + sh.r) return false;
  const k = d > 1e-3 ? Math.max(0, d - sh.r - 0.15) / d : 0;
  return k <= 0 || world.lineClear(x, ey, z, x + dx * k, ey + dy * k, z + dz * k);
}

/**
 * Can a body with its feet at (x, y, z) work `e` from there: in its reach (inReach) and, by a fire,
 * in its warmth too (thermal.ts warmthFrom's wall test, the sight line from just outside the fire
 * to the chest: a wall or a rock in between leaves a tenth of the heat).
 */
export function canWork(world: WorldEx, x: number, y: number, z: number, e: Entity): boolean {
  if (!inReach(world, x, y, z, e)) return false;
  if (e.kind !== 'fire') return true;
  const dx = x - e.x, dz = z - e.z;
  const d = Math.hypot(dx, dz);
  if (d <= 0.6) return true;
  const k = 0.55 / d;
  return world.lineClear(e.x + dx * k, e.y + 0.5, e.z + dz * k, x, y + 1, z);
}

// =============================================================================================== planning

const CELL = 0.5;
const MAX_HALF = 46; // metres: half the side of the largest local plan window
const MAX_EXPAND = 16000;

/** A doorway: its centre and the unit normal pointing out of the building. */
interface Door { x: number; z: number; nx: number; nz: number }

/** Clearance a planned cell keeps from walls and trunks: a little under the body's radius (0.32 m),
 * so a doorway still has cell centres in it; the movement code slides the body along the rest. */
const CLEAR = 0.24;
const STEP = 0.4; // colliders this low are stepped over (move.ts STEP_HEIGHT)
const HEAD = 1.8; // ... and these high are walked under (PLAYER_HEIGHT)
const SLOPE_MAX = 40 / 90; // world WALK_SLOPE: slopeAt is the slope angle / 90 degrees

/**
 * Can a body stand at a point of the 0.5 m lattice: inside the map, not too steep (floors are flat),
 * and clear of every wall, trunk and rock in the band between a step above the feet and the head.
 * world.walkable() samples a point and misses thin walls (a hull, a plank wall); this keeps a margin.
 * Cached for the session: the static world never changes.
 */
class WalkCache {
  private readonly m = new Map<number, boolean>();
  private readonly near: import('../world/types').Collider[] = [];
  constructor(private readonly world: WorldEx, private readonly doors: Door[]) {}

  at(x: number, z: number): boolean {
    const i = Math.round(x / CELL), j = Math.round(z / CELL);
    const k = (i + 8192) * 16384 + (j + 8192);
    let v = this.m.get(k);
    if (v === undefined) {
      v = this.test(i * CELL, j * CELL);
      if (this.m.size > 400000) this.m.clear();
      this.m.set(k, v);
    }
    return v;
  }

  private test(x: number, z: number): boolean {
    const w = this.world;
    const lim = w.half - 2;
    if (x <= -lim || x >= lim || z <= -lim || z >= lim) return false;
    // feet on the terrain; only where it is too steep can a floor (a deck, a cabin floor) save the cell
    let feet = w.heightAt(x, z);
    if (w.slopeAt(x, z) >= SLOPE_MAX) {
      const g = w.groundAt(x, z, feet + 1);
      if (g.y <= feet + 0.05) return false;
      feet = g.y;
    }
    // in a doorway's corridor only a solid right at the point blocks (the jambs are the movement's)
    let r = CLEAR;
    for (const d of this.doors) {
      const dx = x - d.x, dz = z - d.z;
      const along = dx * d.nx + dz * d.nz, across = Math.abs(dx * d.nz - dz * d.nx);
      if (Math.abs(along) < 1.6 && across < 0.36) r = 0.04;
    }
    const cols = this.near;
    cols.length = 0;
    w.collidersNear(x, z, r + 0.6, cols);
    for (let k = 0; k < cols.length; k++) {
      const c = cols[k];
      if (c.y1 <= feet + STEP || c.y0 >= feet + HEAD) continue;
      const dx = x - c.x, dz = z - c.z;
      if (c.s === 'c') {
        if (dx * dx + dz * dz < (c.r + r) * (c.r + r)) return false;
      } else {
        const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
        const qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
        if ((lx - qx) * (lx - qx) + (lz - qz) * (lz - qz) < r * r) return false;
      }
    }
    return true;
  }
}

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
    for (const [k, a] of Object.entries(world.anchors)) {
      if (!/\.door$/.test(k)) continue;
      // anchors carry the building's yaw; a door is in the front (+Z) wall, so out is +Z turned by yaw
      this.doors.push({ x: a.x, z: a.z, nx: Math.sin(a.yaw), nz: Math.cos(a.yaw) });
    }
    this.walk = new WalkCache(world, this.doors);
  }

  /** Can a body stand here and walk on: walkable ground, not thin ice or open water, not in a fire. */
  passable(r: Reader, x: number, z: number): boolean {
    return this.walk.at(x, z) && this.hazardFree(r, x, z);
  }

  /** No thin ice, open water or lit fire here (the hazards that come and go). */
  hazardFree(r: Reader, x: number, z: number): boolean {
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
   * A goal test for plan() and steer(): a spot between `lo` and `hi` metres from `e` across the
   * ground from which a body can work it (canWork, with its feet on the ground or floor there), so
   * on its side of any wall: inside the cabin by the stove, never just behind the wall from it.
   */
  workSpot(e: Entity, lo: number, hi: number): (x: number, z: number) => boolean {
    const w = this.world;
    return (x, z) => {
      const d = Math.hypot(x - e.x, z - e.z);
      return d > lo && d < hi && canWork(w, x, w.groundAt(x, z, e.y + 0.5).y, z, e);
    };
  }

  /**
   * A* on 0.5 m cells from (sx, sz) to the cell nearest (gx, gz) that satisfies `goal` (default: the
   * goal cell itself), inside a square of half-size up to 40 m around the goal. Returns smoothed
   * waypoints (start excluded), or null when there is no way inside the window.
   */
  plan(r: Reader, sx: number, sz: number, gx: number, gz: number, goal?: (x: number, z: number) => boolean, o: { partial?: boolean; wide?: boolean } = {}): Pt[] | null {
    // the window: centred between start and goal, with room to go round (a ledge may only open far
    // to one side), on the walk cache's lattice so every cell is tested exactly where it is
    const half = o.wide ? MAX_HALF : Math.min(MAX_HALF, Math.max(14, 0.5 * Math.hypot(sx - gx, sz - gz) + 22));
    const n = Math.ceil((half * 2) / CELL) + 1;
    const mx = o.wide ? sx : 0.5 * (sx + gx), mz = o.wide ? sz : 0.5 * (sz + gz);
    const ox = Math.round((mx - half) / CELL) * CELL, oz = Math.round((mz - half) / CELL) * CELL;
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
    let isGoal = goal;
    if (!isGoal) {
      // the goal point itself may be inside something (a part on a shelf): then the free spot nearest it
      const q = this.nearestPassable(r, gx, gz, 3);
      const qx = q ? q.x : gx, qz = q ? q.z : gz;
      isGoal = (x: number, z: number) => Math.hypot(x - qx, z - qz) < CELL * 0.75;
    }
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
    let found = -1, expanded = 0, best = -1, bestH = Infinity;
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
      const hc = h(c);
      if (hc < bestH) {
        bestH = hc;
        best = c;
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
    if (found < 0) {
      // no way all the way: as close as it gets, only when asked (it can lead into a dead end)
      if (!o.partial || best < 0 || bestH > h(start) - 2) return null;
      found = best;
    }
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

  private trailGrid: Map<number, number[]> | null = null;

  /** True if a trail point with index in [lo, hi] lies within 1.3 m of (x, z). */
  nearTrail(x: number, z: number, lo: number, hi: number): boolean {
    const t = this.world.trail;
    if (!this.trailGrid) {
      this.trailGrid = new Map();
      for (let k = 0; k < t.length; k++) {
        const key = Math.floor(t[k].x / 4) * 4096 + Math.floor(t[k].z / 4);
        let l = this.trailGrid.get(key);
        if (!l) this.trailGrid.set(key, (l = []));
        l.push(k);
      }
    }
    const ci = Math.floor(x / 4), cj = Math.floor(z / 4);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const l = this.trailGrid.get((ci + di) * 4096 + cj + dj);
      if (!l) continue;
      for (const k of l) if (k >= lo && k <= hi && Math.hypot(t[k].x - x, t[k].z - z) < 1.3) return true;
    }
    return false;
  }

  /** The nearest point of the trail off the lake ice, searching along the trail both ways from (x, z). */
  shore(x: number, z: number): Pt {
    const t = this.world.trail;
    const i = this.trailIndex(x, z);
    for (let k = 0; k < t.length; k++) {
      for (const j of [i - k, i + k]) {
        if (j < 0 || j >= t.length) continue;
        if (this.world.iceAt(t[j].x, t[j].z) <= 0) {
          // a few metres further off the ice, so a fire there is not on the shore ice
          const n = Math.min(t.length - 1, Math.max(0, j + (j < i ? -3 : 3)));
          return { x: t[n].x, z: t[n].z };
        }
      }
    }
    return { x, z };
  }

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

  /**
   * Index of a trail point near (x, z), choosing among the passes of the trail that come this close
   * (the route goes out to a place and back the same way) the one nearest in order to index `toward`.
   * Without this a walker on an out-and-back stretch flips between the two passes and never leaves.
   */
  trailIndexToward(x: number, z: number, toward: number): number {
    const t = this.world.trail;
    const i0 = this.trailIndex(x, z);
    const d0 = Math.hypot(t[i0].x - x, t[i0].z - z);
    const lim = (d0 + 3) * (d0 + 3);
    let best = i0, bk = Math.abs(i0 - toward);
    for (let i = 0; i < t.length; i++) {
      const d = (t[i].x - x) * (t[i].x - x) + (t[i].z - z) * (t[i].z - z);
      if (d <= lim && Math.abs(i - toward) < bk) {
        bk = Math.abs(i - toward);
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
  /** Seconds in a row with no way on (no plan, nothing safe ahead). */
  blockedT = 0;
  /**
   * Breadcrumbs: where this body has walked, a point every 2 m, newest last. A way it came by is a
   * way out: a body boxed in on a ledge walks back along them and tries again from there.
   */
  readonly crumbs: Pt[] = [];

  constructor(side: number) {
    this.side = side;
  }

  /** Drop a breadcrumb when 2 m from the last one. */
  track(x: number, z: number): void {
    const c = this.crumbs, last = c[c.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < 2) return;
    if (last && Math.hypot(x - last.x, z - last.z) > 12) c.length = 0; // a teleport or a respawn: the old trail is no way out
    c.push({ x, z });
    if (c.length > 80) c.shift();
  }

  /** Walk back the way we came, about `metres` (the crumbs used are spent). True if there were any. */
  retreat(metres: number): boolean {
    const c = this.crumbs;
    if (c.length < 2) return false;
    const back: Pt[] = [];
    let run = 0;
    for (let k = c.length - 1; k >= 0 && run < metres; k--) {
      if (back.length > 0) run += Math.hypot(c[k].x - back[back.length - 1].x, c[k].z - back[back.length - 1].z);
      back.push(c[k]);
    }
    c.length = Math.max(0, c.length - back.length);
    this.path = back;
    this.planAge = 0;
    return true;
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
 * `near` is how close counts as there; with a `goal` test the spot must also pass it (near a
 * stove behind the cabin wall is not there: the plan goes round through the door). The walker
 * keeps its plan between ticks.
 */
export function steer(pl: Planner, r: Reader, w: Walker, p: PlayerEnt, gx: number, gz: number, near: number, dt: number, out: Steer, opts: { run?: boolean; goal?: (x: number, z: number) => boolean } = {}): Steer {
  out.jump = false;
  out.sprint = false;
  out.blocked = false;
  const d = Math.hypot(gx - p.x, gz - p.z);
  if (d <= near && (!opts.goal || opts.goal(p.x, p.z))) {
    out.arrived = true;
    out.mz = 0;
    out.yaw = p.yaw;
    w.path.length = 0;
    w.stuck = 0;
    return out;
  }
  out.arrived = false;
  w.track(p.x, p.z);
  if (!(Math.hypot(gx - w.goalX, gz - w.goalZ) <= Math.max(1.5, d * 0.15))) {
    // a new goal (or the old one moved, or none yet: NaN): plan again
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
    // which pass of the trail: the goal's nearest to where we are, ours nearest to the goal's
    const gi = pl.trailIndexToward(gx, gz, pl.trailIndex(p.x, p.z));
    const i = pl.trailIndexToward(p.x, p.z, gi);
    const onTrail = Math.hypot(t[i].x - p.x, t[i].z - p.z) < 12;
    if (onTrail && Math.abs(gi - i) > 3 && Math.hypot(t[gi].x - gx, t[gi].z - gz) < d * 0.6) {
      const dir = gi > i ? 1 : -1;
      let k = i;
      // aim about 7 m ahead along the trail
      while (k !== gi && Math.hypot(t[k].x - p.x, t[k].z - p.z) < 7) k += dir;
      tx = t[k].x;
      tz = t[k].z;
    } else {
      // off the trail: straight for a point 30 m along the way
      const k = Math.min(1, 30 / d);
      tx = p.x + (gx - p.x) * k;
      tz = p.z + (gz - p.z) * k;
    }
    // something in the way of that (a wall of the building we are in, a rock, a cliff below a
    // ledge): plan to the nearest stretch of the trail further on that can be reached, and follow
    // that plan to its end before taking up the trail again
    if (w.path.length === 0 && w.planAge > 1.2 && !pl.lineOk(r, p.x, p.z, tx, tz)) {
      w.planAge = 0;
      const lo = Math.min(i, gi), hi = Math.max(i, gi);
      const ahead = gi >= i ? (x: number, z: number) => pl.nearTrail(x, z, i + 2, hi) : (x: number, z: number) => pl.nearTrail(x, z, lo, i - 2);
      w.path = (onTrail ? pl.plan(r, p.x, p.z, tx, tz, ahead) : null) ?? pl.plan(r, p.x, p.z, tx, tz) ?? pl.plan(r, p.x, p.z, tx, tz, ahead, { wide: true }) ?? [];
      if (w.path.length === 0) out.blocked = w.age > 3;
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
  // The next metres must be safe: turn away from a hazard right ahead, toward the goal side. On a
  // plan the walls are already accounted for: only what moves or melts is checked (thin ice, open
  // water, a lit fire, a drop); steering straight also checks for walls and trunks.
  const planned = path.length > 0;
  const ok = (a: number): boolean => {
    for (const s of planned ? [0.6, 1.1] : [0.6, 1.2, 1.7]) {
      const x = p.x - Math.sin(a) * s, z = p.z - Math.cos(a) * s;
      if (!pl.noDrop(p.x, p.z, x, z)) return false;
      if (planned ? !pl.hazardFree(r, x, z) : !pl.passable(r, x, z)) return false;
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
      boxedIn(w, dt, out);
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
    // pushing against something for a long while: back out the way we came
    if (w.stuck >= 6 && w.retreat(20)) w.stuck = 0;
  }
  if (w.stuck >= 3) yaw += 0.9 * w.side;

  out.yaw = wrapAngle(yaw);
  const left = path.length > 0 ? Infinity : d - near;
  out.mz = left < 1.2 ? 0.45 : 1;
  out.sprint = !!opts.run && d > 14 && p.stamina > 0.45 && iceRisk(r, p.x, p.z) === 0 && p.carry === 0;
  boxedIn(w, dt, out);
  return out;
}

/** No way on for 5 s (a ledge, a pocket between drifts and rock): walk back 30 m the way we came. */
function boxedIn(w: Walker, dt: number, out: Steer): void {
  w.blockedT = out.blocked ? w.blockedT + dt : 0;
  if (w.blockedT > 5 && w.retreat(30)) w.blockedT = 0;
}
