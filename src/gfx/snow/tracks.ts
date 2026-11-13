// What presses the snow: turns the simulation's events (steps, landings, falls, dropped logs, axe
// and bullet hits, flares) and the motion of what has no events (wolves, dragged logs, a downed
// player crawling) into records in the store. Every number here is metres and describes the snow,
// not the picture: how deep a boot sinks in this much loose snow, how wide a log's furrow is.
// No three.js here. Owner: SNOW.
import type { View } from '../../game/view';
import type { LogEnt, PlayerEnt, SimEvent, Surface, WolfEnt } from '../../sim/types';
import type { World } from '../../world/types';
import { F_DEEP, F_FRONT, F_LEFT, F_PACKED, F_RUN, F_SOFT, K_BODY, K_BOOT, K_GROOVE, K_KICK, K_PAW, K_PIT } from './config';
import type { RecordStore } from './records';

/** Small deterministic hash of a position: the same footfall always gets the same seed. */
function seedAt(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 97) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 89) | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How a body presses the snow at one spot. */
interface Give {
  ok: boolean; // there is snow to press (not rock, ice, a floor or water)
  loose: number; // loose snow depth, m
  packed: number; // 0..1 the packed route trail
  sink: number; // m a boot sinks
  deepK: number; // 0..1 powder deep enough to cave in around the boot
}

interface StepMemo {
  x: number;
  z: number;
  // last print of each foot (toe position) for the drag furrows of deep snow
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  hasL: boolean;
  hasR: boolean;
}

interface WolfMemo {
  x: number;
  z: number;
  acc: number;
  phase: number;
  px: number; // last print, for furrows in deep snow
  pz: number;
  has: boolean;
}

interface DragMemo {
  x: number;
  z: number;
}

interface CrawlMemo {
  x: number;
  z: number;
  still: number; // seconds without moving
  bx: number; // last body hollow
  bz: number;
}

export class Tracks {
  private steps = new Map<number, StepMemo>();
  private wolves = new Map<number, WolfMemo>();
  private drags = new Map<number, DragMemo>();
  private crawls = new Map<number, CrawlMemo>();
  private give: Give = { ok: false, loose: 0, packed: 0, sink: 0, deepK: 0 };
  private seen = new Set<number>();
  /** Records added since the last call to take(): the painter draws them at once. */
  fresh: number[] = [];

  constructor(private store: RecordStore, private world: World) {}

  reset(): void {
    this.steps.clear();
    this.wolves.clear();
    this.drags.clear();
    this.crawls.clear();
    this.fresh.length = 0;
  }

  // ------------------------------------------------------------------------------------------
  // The ground

  /** Packed route trail 0..1 from the world masks (A), bilinear. */
  private packedAt(x: number, z: number): number {
    const m = this.world.masks;
    const n = m.n;
    let fx = ((x + m.extent) / (2 * m.extent)) * (n - 1);
    let fz = ((z + m.extent) / (2 * m.extent)) * (n - 1);
    if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return 0;
    fx = Math.min(fx, n - 1.0001);
    fz = Math.min(fz, n - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const d = m.data;
    const k = (j * n + i) * 4 + 3;
    const a = d[k], b = d[k + 4], c = d[k + n * 4], e = d[k + n * 4 + 4];
    return (a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v) / 255;
  }

  /** How the snow at (x, z) takes a boot; `surface` from the event when known. */
  private ground(x: number, z: number, surface?: Surface, y?: number): Give {
    const g = this.give;
    const s: Surface = surface ?? (y !== undefined ? this.world.groundAt(x, z, y + 0.3).surface : this.world.surfaceAt(x, z));
    g.ok = s === 'snow' || s === 'deep';
    if (!g.ok) return g;
    g.loose = this.world.snowDepthAt(x, z);
    g.packed = clamp01((this.packedAt(x, z) - 0.15) / 0.5);
    let sink = Math.min(0.36, 0.02 + 0.45 * g.loose);
    if (s === 'deep') sink = Math.max(sink, 0.2);
    sink *= 1 - 0.85 * g.packed;
    g.sink = Math.max(0.012, sink);
    g.deepK = clamp01((g.sink - 0.12) / 0.18);
    return g;
  }

  private push(kind: number, x: number, z: number, fx: number, fz: number, hw: number, hl: number, depth: number, rim: number, fill: number, flags: number, salt: number): void {
    const i = this.store.add(kind, x, z, fx, fz, hw, hl, depth, rim, fill, flags, seedAt(x, z, salt));
    this.fresh.push(i);
  }

  /** A capsule from (ax, az) to (bx, bz). */
  private groove(ax: number, az: number, bx: number, bz: number, r: number, depth: number, rim: number, fill: number, flags: number): void {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    this.push(K_GROOVE, 0.5 * (ax + bx), 0.5 * (az + bz), dx / len, dz / len, r, 0.5 * len, depth, rim, fill, flags, 7);
  }

  // ------------------------------------------------------------------------------------------
  // Boots

  /** One boot print. (fx, fz) is the direction of travel; returns false on bare ground. */
  private boot(x: number, z: number, fx: number, fz: number, left: boolean, run: boolean, fill: number, surface?: Surface, punch = 1, memo?: StepMemo): boolean {
    const g = this.ground(x, z, surface);
    if (!g.ok) return false;
    // the foot lands beside the body's line, toes turned out a little
    const lx = fz, lz = -fx; // left of the travel direction
    const side = left ? 1 : -1;
    const px = x + lx * side * 0.1, pz = z + lz * side * 0.1;
    const out = 0.1 * side;
    const ca = Math.cos(out), sa = Math.sin(out);
    const bx = fx * ca + lx * sa, bz = fz * ca + lz * sa;
    const seed = seedAt(px, pz, left ? 3 : 4);
    const scale = 0.97 + 0.06 * seed;
    const sink = g.sink * (run ? 1.12 : 1) * punch;
    const deepK = g.deepK;
    // powder caves in around a deep boot: the hole is wider than the boot and its rim is a berm
    const hw = (0.056 + 0.022 * deepK) * scale;
    const hl = (0.15 + 0.035 * deepK + (run ? 0.02 : 0)) * scale;
    const rim = g.packed > 0.5 ? 0.004 : Math.min(0.05, 0.006 + 0.16 * sink) * (0.7 + 0.3 * punch);
    let flags = (left ? F_LEFT : 0) | (run ? F_RUN : 0);
    if (deepK > 0.3) flags |= F_DEEP;
    if (g.packed > 0.5) flags |= F_PACKED;
    this.push(K_BOOT, px, pz, bx, bz, hw, hl, sink, rim, fill, flags, left ? 1 : 2);
    if (memo) {
      // In deep snow the foot is dragged from one hole to the next: a furrow from the last print of
      // the same foot (its toe) to this one's heel.
      const tx = px + bx * hl * 0.8, tz = pz + bz * hl * 0.8;
      const hx = px - bx * hl * 0.7, hz = pz - bz * hl * 0.7;
      const has = left ? memo.hasL : memo.hasR;
      const ox = left ? memo.lx : memo.rx, oz = left ? memo.lz : memo.rz;
      if (has && deepK > 0.35) {
        const d = Math.hypot(hx - ox, hz - oz);
        const k = (deepK - 0.35) / 0.65;
        if (d > 0.05 && d < 1.9) this.groove(ox, oz, hx, hz, 0.035 + 0.025 * k, sink * (0.1 + 0.2 * k), rim * 0.3, fill, flags | F_SOFT);
      }
      if (left) {
        memo.lx = tx;
        memo.lz = tz;
        memo.hasL = true;
      } else {
        memo.rx = tx;
        memo.rz = tz;
        memo.hasR = true;
      }
    }
    if (run) {
      // the push-off throws a little snow ahead of the toe
      this.push(K_KICK, px + bx * (hl + 0.1), pz + bz * (hl + 0.1), bx, bz, 0.1 + 0.05 * deepK, 0.12, 0, 0.012 + 0.03 * deepK, fill, flags, 5);
    }
    return true;
  }

  /** Travel direction of a body: velocity, else facing. */
  private static heading(e: { vx?: number; vz?: number; yaw: number }, out: { x: number; z: number }): { x: number; z: number } {
    const vx = e.vx ?? 0, vz = e.vz ?? 0;
    const v = Math.hypot(vx, vz);
    if (v > 0.3) {
      out.x = vx / v;
      out.z = vz / v;
    } else {
      out.x = -Math.sin(e.yaw);
      out.z = -Math.cos(e.yaw);
    }
    return out;
  }
  private dir = { x: 0, z: -1 };

  // ------------------------------------------------------------------------------------------
  // Events

  onEvent(e: SimEvent, view: View | null, fill: number): void {
    switch (e.t) {
      case 'step': {
        let m = this.steps.get(e.id);
        let fx = 0, fz = 0;
        if (m) {
          const dx = e.x - m.x, dz = e.z - m.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.15 && d < 2.5) {
            fx = dx / d;
            fz = dz / d;
          } else if (d >= 2.5) {
            m.hasL = m.hasR = false; // a teleport or a respawn: no furrow across the gap
          }
        } else {
          m = { x: e.x, z: e.z, lx: 0, lz: 0, rx: 0, rz: 0, hasL: false, hasR: false };
          this.steps.set(e.id, m);
        }
        if (fx === 0 && fz === 0) {
          const p = view?.ents.get(e.id) as PlayerEnt | undefined;
          const h = p ? Tracks.heading(p, this.dir) : this.dir;
          fx = h.x;
          fz = h.z;
        }
        m.x = e.x;
        m.z = e.z;
        if (!this.boot(e.x, e.z, fx, fz, e.left, e.run, fill, e.surface, 1, m)) m.hasL = m.hasR = false;
        break;
      }
      case 'land': {
        const p = view?.ents.get(e.id) as PlayerEnt | undefined;
        if (!p) break;
        const h = Tracks.heading(p, this.dir);
        const punch = 1 + Math.min(1, e.speed / 6);
        const s = this.ground(p.x, p.z, undefined, p.y);
        if (!s.ok) break;
        const fx = h.x, fz = h.z;
        const sink = s.sink, deepK = s.deepK;
        this.boot(p.x, p.z, fx, fz, true, true, fill, undefined, punch);
        this.boot(p.x + fx * 0.06, p.z + fz * 0.06, fx, fz, false, true, fill, undefined, punch);
        // the snow thrown out ahead of the landing, and a little behind it
        const kick = Math.min(0.06, 0.015 + 0.006 * e.speed + 0.03 * deepK);
        this.push(K_KICK, p.x + fx * 0.45, p.z + fz * 0.45, fx, fz, 0.32 + 0.08 * deepK, 0.38, 0, kick, fill, 0, 11);
        this.push(K_KICK, p.x - fx * 0.3, p.z - fz * 0.3, -fx, -fz, 0.22, 0.2, 0, kick * 0.6, fill, 0, 12);
        // and the body's weight caving the snow between the feet
        this.push(K_PIT, p.x, p.z, fx, fz, 0.2, 0.2, sink * 0.35, 0, fill, 0, 13);
        const m = this.steps.get(e.id);
        if (m) {
          m.x = p.x;
          m.z = p.z;
          m.hasL = m.hasR = false;
        }
        break;
      }
      case 'downed':
      case 'died': {
        const p = view?.ents.get(e.id) as PlayerEnt | undefined;
        if (!p) break;
        const c = this.crawls.get(e.id);
        if (e.t === 'died' && c && Math.hypot(c.bx - p.x, c.bz - p.z) < 1) break; // already lying in it
        this.body(p, fill);
        break;
      }
      case 'logDrop': {
        const l = view?.ents.get(e.id) as LogEnt | undefined;
        if (!l) break;
        const g = this.ground(l.x, l.z);
        if (!g.ok) break;
        const fx = Math.sin(l.yaw), fz = Math.cos(l.yaw);
        const sink = Math.min(0.16, 0.03 + 0.3 * g.loose) * (1 - 0.7 * g.packed);
        this.push(K_GROOVE, l.x, l.z, fx, fz, 0.14, Math.max(0.2, 0.5 * l.len - 0.12), sink * 0.6, Math.min(0.04, 0.01 + 0.08 * g.loose), fill, 0, 21);
        this.drags.delete(e.id);
        break;
      }
      case 'swing': {
        if (e.hit !== 'ground') break;
        const g = this.ground(e.x, e.z);
        if (!g.ok) break;
        const p = view?.ents.get(e.by) as PlayerEnt | undefined;
        const fx = p ? -Math.sin(p.yaw) : 0, fz = p ? -Math.cos(p.yaw) : -1;
        this.push(K_GROOVE, e.x, e.z, fx, fz, 0.025, 0.07, Math.min(0.1, 0.03 + g.sink * 0.4), 0.01, fill, 0, 31);
        this.push(K_KICK, e.x + fx * 0.15, e.z + fz * 0.15, fx, fz, 0.16, 0.18, 0, 0.02, fill, 0, 32);
        break;
      }
      case 'shot': {
        if (e.hit !== 'ground') break;
        const g = this.ground(e.hx, e.hz);
        if (!g.ok) break;
        const d = Math.hypot(e.dx, e.dz) || 1;
        const fx = e.dx / d, fz = e.dz / d;
        this.push(K_PIT, e.hx, e.hz, fx, fz, 0.035, 0.035, Math.min(0.12, 0.04 + g.sink * 0.5), 0.008, fill, 0, 41);
        this.push(K_KICK, e.hx, e.hz, fx, fz, 0.2, 0.2, 0, 0.018, fill, 0, 42);
        break;
      }
      case 'flareLand': {
        const g = this.ground(e.x, e.z);
        if (!g.ok) break;
        // a burning flare sinks into the snow it melts
        this.push(K_PIT, e.x, e.z, 1, 0, 0.075, 0.075, Math.min(0.1, 0.05 + g.sink * 0.3), 0.01, fill, 0, 51);
        break;
      }
      case 'wolfDie': {
        const w = view?.ents.get(e.id) as WolfEnt | undefined;
        const g = this.ground(e.x, e.z);
        if (!g.ok) break;
        const fx = w ? -Math.sin(w.yaw) : 0, fz = w ? -Math.cos(w.yaw) : -1;
        this.push(K_GROOVE, e.x, e.z, fx, fz, 0.2, 0.32, Math.min(0.12, 0.03 + 0.2 * g.loose), Math.min(0.04, 0.012 + 0.05 * g.loose), fill, 0, 61);
        break;
      }
      case 'despawn':
        this.steps.delete(e.id);
        this.wolves.delete(e.id);
        this.drags.delete(e.id);
        this.crawls.delete(e.id);
        break;
      default:
        break;
    }
  }

  /** A body-shaped hollow under a player lying face down, head toward the facing. */
  private body(p: PlayerEnt, fill: number): void {
    const g = this.ground(p.x, p.z, undefined, p.y);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    let c = this.crawls.get(p.id);
    if (!c) {
      c = { x: p.x, z: p.z, still: 0, bx: p.x, bz: p.z };
      this.crawls.set(p.id, c);
    }
    c.bx = p.x;
    c.bz = p.z;
    if (!g.ok) return;
    // a body spreads its weight: shallower than a boot, but the snow is pushed aside in a broad berm
    const depth = Math.min(0.13, 0.035 + 0.22 * g.loose) * (1 - 0.6 * g.packed);
    const rim = Math.min(0.06, 0.012 + 0.08 * g.loose) * (1 - 0.6 * g.packed);
    this.push(K_BODY, p.x - fx * 0.3, p.z - fz * 0.3, fx, fz, 0.26, 1.0, depth, rim, fill, 0, 71);
  }

  // ------------------------------------------------------------------------------------------
  // Motion without events: wolves, dragged logs, crawling

  frame(view: View, fill: number, dt: number): void {
    const seen = this.seen;
    seen.clear();

    for (const w of view.list('wolf')) {
      seen.add(w.id);
      this.wolf(w, fill);
    }
    for (const id of this.wolves.keys()) if (!seen.has(id)) this.wolves.delete(id);

    seen.clear();
    for (const l of view.list('log')) {
      seen.add(l.id);
      this.drag(l, fill);
    }
    for (const id of this.drags.keys()) if (!seen.has(id)) this.drags.delete(id);

    for (const p of view.list('player')) this.crawl(p, fill, dt);
  }

  private wolf(w: WolfEnt, fill: number): void {
    let m = this.wolves.get(w.id);
    if (!m) {
      m = { x: w.x, z: w.z, acc: 0, phase: 0, px: 0, pz: 0, has: false };
      this.wolves.set(w.id, m);
      return;
    }
    const dx = w.x - m.x, dz = w.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d > 6) {
      // a jump in position (spawn, snapshot gap): start over
      m.x = w.x;
      m.z = w.z;
      m.acc = 0;
      m.has = false;
      return;
    }
    if (d < 1e-4) return;
    m.x = w.x;
    m.z = w.z;
    if (w.mood === 'dead') return;
    const fx = dx / d, fz = dz / d;
    const spd = w.speed;
    const gallop = spd > 5.5;
    const spacing = gallop ? 2.5 : spd > 1.9 ? 0.62 : 0.36;
    m.acc += d;
    if (m.acc > spacing * 4) m.acc = spacing; // fell far behind (a hitch): do not stamp a burst
    while (m.acc >= spacing) {
      m.acc -= spacing;
      // the footfall happened `acc` metres back along the path
      const bx = w.x - fx * m.acc, bz = w.z - fz * m.acc;
      const lx = fz, lz = -fx;
      if (gallop) {
        // a rotary gallop: four prints spread over a metre, then a long bound
        const P = [[-0.07, 0, F_FRONT], [0.06, 0.28, F_FRONT], [-0.08, 0.78, 0], [0.07, 0.98, 0]];
        for (const [s, t, fl] of P) this.paw(bx + lx * s + fx * (t - 1), bz + lz * s + fz * (t - 1), fx, fz, fl | (s < 0 ? F_LEFT : 0), fill, m, false);
      } else {
        // walk and trot: the hind paw falls in (or just beside) the front paw's print
        const side = m.phase & 1 ? 1 : -1;
        const off = spd > 1.9 ? 0.03 : 0.06;
        const px = bx + lx * side * off, pz = bz + lz * side * off;
        this.paw(px, pz, fx, fz, F_FRONT | (side > 0 ? F_LEFT : 0), fill, m, true);
        const r = seedAt(px, pz, 81);
        if (r < 0.35) this.paw(px - fx * (0.03 + 0.04 * r) + lx * side * 0.015, pz - fz * (0.03 + 0.04 * r) + lz * side * 0.015, fx, fz, side > 0 ? F_LEFT : 0, fill, null, false);
      }
      m.phase++;
    }
  }

  private paw(x: number, z: number, fx: number, fz: number, flags: number, fill: number, m: WolfMemo | null, furrow: boolean): void {
    const g = this.ground(x, z);
    if (!g.ok) {
      if (m) m.has = false;
      return;
    }
    const front = (flags & F_FRONT) !== 0;
    const sink = Math.min(0.3, 0.015 + 0.38 * g.loose) * (1 - 0.8 * g.packed);
    const deepK = g.deepK;
    const s = front ? 1.08 : 0.95;
    const hw = (0.036 + 0.02 * deepK) * s, hl = (0.046 + 0.025 * deepK) * s;
    const rim = Math.min(0.035, 0.004 + 0.12 * sink);
    if (deepK > 0.3) flags |= F_DEEP;
    this.push(K_PAW, x, z, fx, fz, hw, hl, Math.max(0.01, sink), rim, fill, flags, 9);
    if (m) {
      // a wolf in deep snow drags its feet between the holes
      if (furrow && m.has && deepK > 0.4) {
        const d = Math.hypot(x - m.px, z - m.pz);
        const k = (deepK - 0.4) / 0.6;
        if (d > 0.1 && d < 1.2) this.groove(m.px, m.pz, x - fx * hl, z - fz * hl, 0.025 + 0.02 * k, sink * (0.1 + 0.25 * k), rim * 0.3, fill, flags | F_SOFT);
      }
      m.px = x + fx * hl;
      m.pz = z + fz * hl;
      m.has = true;
    }
  }

  private drag(l: LogEnt, fill: number): void {
    const one = (l.a !== 0) !== (l.b !== 0);
    if (!one) {
      this.drags.delete(l.id);
      return;
    }
    // one carrier: the far end trails on the ground (end b when a holds the log)
    const ux = Math.sin(l.yaw), uz = Math.cos(l.yaw), h = 0.5 * l.len;
    const sgn = l.a !== 0 ? -1 : 1;
    const ex = l.x + ux * h * sgn, ez = l.z + uz * h * sgn;
    // the end of a round log touches the snow a little in from its tip
    const tx = ex - ux * 0.25 * sgn, tz = ez - uz * 0.25 * sgn;
    let m = this.drags.get(l.id);
    if (!m) {
      this.drags.set(l.id, { x: tx, z: tz });
      return;
    }
    const d = Math.hypot(tx - m.x, tz - m.z);
    if (d > 3) {
      m.x = tx;
      m.z = tz;
      return;
    }
    if (d < 0.22) return;
    const g = this.ground(tx, tz);
    if (g.ok) {
      const sink = Math.min(0.17, 0.03 + 0.28 * g.loose) * (1 - 0.75 * g.packed);
      const rim = Math.min(0.06, 0.012 + 0.1 * g.loose) * (1 - 0.6 * g.packed);
      this.groove(m.x, m.z, tx, tz, 0.13, sink, rim, fill, 0);
    }
    m.x = tx;
    m.z = tz;
  }

  private crawl(p: PlayerEnt, fill: number, dt: number): void {
    if (p.life !== 'downed') {
      if (p.life === 'alive') this.crawls.delete(p.id);
      return;
    }
    let c = this.crawls.get(p.id);
    if (!c) {
      // downed before we saw the event (joined late, or the event fell in a skipped frame)
      this.body(p, fill);
      return;
    }
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d > 4) {
      c.x = c.bx = p.x;
      c.z = c.bz = p.z;
      return;
    }
    if (d >= 0.3) {
      const g = this.ground(p.x, p.z, undefined, p.y);
      if (g.ok) {
        const depth = Math.min(0.1, 0.025 + 0.16 * g.loose) * (1 - 0.6 * g.packed);
        const rim = Math.min(0.05, 0.01 + 0.07 * g.loose) * (1 - 0.6 * g.packed);
        this.groove(c.x, c.z, p.x, p.z, 0.23, depth, rim, fill, 0);
      }
      c.x = p.x;
      c.z = p.z;
      c.still = 0;
    } else {
      c.still += dt;
      // lying still again somewhere new: the body presses its shape there
      if (c.still > 1.5 && Math.hypot(p.x - c.bx, p.z - c.bz) > 0.7) this.body(p, fill);
    }
  }
}
