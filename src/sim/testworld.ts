// A small, analytic stand-in for the real world generator: it implements the whole World
// interface from closed-form shapes so simulation and net tests are fast, deterministic and
// independent of src/world. Not used by the game.
//
// Layout (metres; X east, Z south, Y up; flat ground at y = 0 around the origin):
//   origin            four player spawn slots on flat, shallow snow
//   z < -50           a gentle climb to the north (about 4.6 degrees)
//   x 60 .. 70        a cliff: 20 m up over 10 m (71 degrees at its steepest), plateau beyond
//   x -60 .. -80      a walkable ramp: 10 m up over 20 m (26.6 degrees), plateau beyond
//   x -40..-20, z -30..-10   a drift of deep snow (0.5 m)
//   (0, 120) r 30     the frozen lake, thin in the middle; ice surface at y = 0
//   (10, 0)           a pine trunk (cylinder r 0.35);  (15, -8) a boulder (cylinder r 1.2)
//   (0, -20)          a wall (box 8 x 0.3 m, turned 0.3 rad);  (20, 5) a low stump you step over
//   (-20, 20)         a wooden floor 6 x 4 m raised 0.3 m, inside an indoor shelter volume
//   (30, 30)          a deck 3 m up (too high to step on: you walk under it)
//   (40, -40)         an outdoor windbreak: a 10 x 10 m shelter volume (0.75), not indoors
// Owner: SIM.
import { sat, smoothstep } from '../core/math';
import { hash01 } from '../core/rng';
import type { PartId, Surface } from './types';
import type { Collider, Floor, LakeInfo, PackDef, Poi, PoiId, PropInst, RockInst, ShelterVol, SpawnDef, TreeInst, World } from '../world/types';

export interface TestWorldOptions {
  seed?: number;
  /** Half the side of the square, metres. */
  half?: number;
}

export const TEST_LAKE = { x: 0, z: 120, r: 30 };
export const TEST_CLIFF = { x0: 60, x1: 70, height: 20 };
export const TEST_RAMP = { x0: -60, x1: -80, height: 10 };
export const TEST_DRIFT = { minX: -40, maxX: -20, minZ: -30, maxZ: -10, depth: 0.5 };
export const TEST_TREE = { x: 10, z: 0, r: 0.35 };
export const TEST_ROCK = { x: 15, z: -8, r: 1.2 };
export const TEST_WALL = { x: 0, z: -20, hx: 4, hz: 0.15, yaw: 0.3 };
export const TEST_FLOOR = { x: -20, z: 20, hx: 3, hz: 2, y: 0.3 };
export const TEST_DECK = { x: 30, z: 30, hx: 2, hz: 2, y: 3 };
/** An outdoor windbreak (a stand of firs, a rock wall): partial shelter, not indoors. (SURVIVAL) */
export const TEST_LEE = { x: 40, z: -40, hx: 5, hz: 5, amount: 0.75 };

const STEP = 0.4; // step height assumed by groundAt (matches move.ts STEP_HEIGHT)

/** Is the point inside a rectangle turned by yaw (same frame as Object3D.rotation.y)? */
function inRect(px: number, pz: number, x: number, z: number, hx: number, hz: number, yaw: number): boolean {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const dx = px - x, dz = pz - z;
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  return Math.abs(lx) <= hx && Math.abs(lz) <= hz;
}

export function createTestWorld(o: TestWorldOptions = {}): World {
  const seed = o.seed ?? 1;
  const half = o.half ?? 200;

  const heightAt = (x: number, z: number): number => {
    let h = 0;
    if (z < -50) h += 0.08 * (-50 - z);
    h += TEST_CLIFF.height * smoothstep(TEST_CLIFF.x0, TEST_CLIFF.x1, x);
    h += TEST_RAMP.height * sat((TEST_RAMP.x0 - x) / (TEST_RAMP.x0 - TEST_RAMP.x1));
    return h;
  };

  const normalAt = (x: number, z: number) => {
    const e = 0.25;
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    return { x: -gx / l, y: 1 / l, z: -gz / l };
  };

  const floors: Floor[] = [
    { x: TEST_FLOOR.x, z: TEST_FLOOR.z, hx: TEST_FLOOR.hx, hz: TEST_FLOOR.hz, yaw: 0, y: TEST_FLOOR.y, surface: 'wood' },
    { x: TEST_DECK.x, z: TEST_DECK.z, hx: TEST_DECK.hx, hz: TEST_DECK.hz, yaw: 0, y: TEST_DECK.y, surface: 'metal' },
  ];
  const onFloor = (x: number, z: number): boolean => {
    for (const f of floors) if (inRect(x, z, f.x, f.z, f.hx, f.hz, f.yaw)) return true;
    return false;
  };

  // --- lake ------------------------------------------------------------------------------------
  const LN = 32, LCELL = 2;
  const lake: LakeInfo = {
    x: TEST_LAKE.x, z: TEST_LAKE.z, level: 0, n: LN, cell: LCELL,
    minX: TEST_LAKE.x - (LN * LCELL) / 2, minZ: TEST_LAKE.z - (LN * LCELL) / 2,
    thickness: new Float32Array(LN * LN),
  };
  for (let cz = 0; cz < LN; cz++) {
    for (let cx = 0; cx < LN; cx++) {
      const x = lake.minX + (cx + 0.5) * LCELL, z = lake.minZ + (cz + 0.5) * LCELL;
      const d = Math.hypot(x - lake.x, z - lake.z);
      lake.thickness[cz * LN + cx] = d < TEST_LAKE.r ? 0.1 + 0.3 * (d / TEST_LAKE.r) : 0;
    }
  }
  const iceCell = (x: number, z: number): number => {
    const cx = Math.floor((x - lake.minX) / LCELL), cz = Math.floor((z - lake.minZ) / LCELL);
    if (cx < 0 || cz < 0 || cx >= LN || cz >= LN) return -1;
    const i = cz * LN + cx;
    return lake.thickness[i] > 0 ? i : -1;
  };
  const iceAt = (x: number, z: number): number => {
    const i = iceCell(x, z);
    return i < 0 ? 0 : lake.thickness[i];
  };

  const slopeAt = (x: number, z: number): number => 1 - normalAt(x, z).y;

  const snowDepthAt = (x: number, z: number): number => {
    if (iceAt(x, z) > 0 || onFloor(x, z)) return 0;
    if (slopeAt(x, z) > 0.3) return 0;
    if (x >= TEST_DRIFT.minX && x <= TEST_DRIFT.maxX && z >= TEST_DRIFT.minZ && z <= TEST_DRIFT.maxZ) return TEST_DRIFT.depth;
    return 0.08;
  };

  const surfaceAt = (x: number, z: number): Surface => {
    if (iceAt(x, z) > 0) return 'ice';
    if (slopeAt(x, z) > 0.3) return 'rock';
    return snowDepthAt(x, z) > 0.3 ? 'deep' : 'snow';
  };

  const groundAt = (x: number, z: number, y: number): { y: number; surface: Surface } => {
    let best = heightAt(x, z);
    let surface: Surface | null = null;
    for (const f of floors) {
      if (f.y > best && f.y <= y + STEP && inRect(x, z, f.x, f.z, f.hx, f.hz, f.yaw)) {
        best = f.y;
        surface = f.surface;
      }
    }
    return { y: best, surface: surface ?? surfaceAt(x, z) };
  };

  // --- static things ---------------------------------------------------------------------------
  const colliders: Collider[] = [
    { s: 'c', x: TEST_TREE.x, z: TEST_TREE.z, r: TEST_TREE.r, y0: 0, y1: 12 },
    { s: 'c', x: TEST_ROCK.x, z: TEST_ROCK.z, r: TEST_ROCK.r, y0: 0, y1: 1.6 },
    { s: 'b', x: TEST_WALL.x, z: TEST_WALL.z, hx: TEST_WALL.hx, hz: TEST_WALL.hz, yaw: TEST_WALL.yaw, y0: 0, y1: 2.5 },
    { s: 'c', x: 20, z: 5, r: 0.3, y0: 0, y1: 0.3 }, // a stump low enough to step over
  ];
  const reach = (c: Collider): number => (c.s === 'c' ? c.r : Math.hypot(c.hx, c.hz));
  const collidersNear = (x: number, z: number, r: number, out: Collider[] = []): Collider[] => {
    for (const c of colliders) {
      const d = r + reach(c);
      const dx = c.x - x, dz = c.z - z;
      if (dx * dx + dz * dz <= d * d) out.push(c);
    }
    return out;
  };
  const insideCollider = (x: number, y: number, z: number): 'tree' | 'rock' | 'wall' | null => {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (y < c.y0 || y > c.y1) continue;
      if (c.s === 'c') {
        if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) <= c.r * c.r) return i === 0 ? 'tree' : 'rock';
      } else if (inRect(x, z, c.x, c.z, c.hx, c.hz, c.yaw)) return 'wall';
    }
    return null;
  };

  const trees: TreeInst[] = [{ x: TEST_TREE.x, y: 0, z: TEST_TREE.z, scale: 1, yaw: 0, variant: 0, kind: 'pine', snow: 0.6 }];
  const rocks: RockInst[] = [{ x: TEST_ROCK.x, y: 0, z: TEST_ROCK.z, sx: 1.2, sy: 0.8, sz: 1.2, yaw: 0, tilt: 0, variant: 0 }];
  const props: PropInst[] = [];
  const shelters: ShelterVol[] = [
    { x: TEST_FLOOR.x, y: 1.5, z: TEST_FLOOR.z, hx: TEST_FLOOR.hx, hy: 1.5, hz: TEST_FLOOR.hz, yaw: 0, amount: 0.9, indoor: true, poi: 'cabin' },
    { x: TEST_LEE.x, y: 1.5, z: TEST_LEE.z, hx: TEST_LEE.hx, hy: 2, hz: TEST_LEE.hz, yaw: 0, amount: TEST_LEE.amount, indoor: false },
  ];

  const raycast: World['raycast'] = (ox, oy, oz, dx, dy, dz, maxDist) => {
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const step = 0.2;
    for (let d = step; d <= maxDist; d += step) {
      const x = ox + dx * d, y = oy + dy * d, z = oz + dz * d;
      if (y <= heightAt(x, z)) return { x, y, z, dist: d, what: 'ground' };
      const c = insideCollider(x, y, z);
      if (c) return { x, y, z, dist: d, what: c };
    }
    return null;
  };

  const poiAt = (id: PoiId, name: string, x: number, z: number, radius: number): Poi => ({ id, name, x, y: heightAt(x, z), z, yaw: 0, radius });
  const pois: Poi[] = [
    poiAt('wreck', 'The fuselage', 0, 4, 20),
    poiAt('tail', 'Tail section', 40, 40, 15),
    poiAt('cabin', 'Ranger cabin', TEST_FLOOR.x, TEST_FLOOR.z, 10),
    poiAt('lake', 'Frozen lake', TEST_LAKE.x, TEST_LAKE.z, TEST_LAKE.r),
    poiAt('hut', 'Fishing hut', TEST_LAKE.x, TEST_LAKE.z, 5),
    poiAt('cave', 'The cave', -100, -100, 12),
    poiAt('camp', 'Survey camp', 100, -100, 15),
    poiAt('tower', 'Signal tower', 0, -150, 18),
  ];
  const poiById = new Map<PoiId, Poi>();
  for (const p of pois) poiById.set(p.id, p);

  const at = (x: number, z: number) => ({ x, y: heightAt(x, z), z });
  const defs: SpawnDef[] = [
    { kind: 'pickup', item: 'stick', n: 3, ...at(3, -3), yaw: 0.4, lie: 'snow' },
    { kind: 'pickup', item: 'matches', n: 4, ...at(-2, -4), yaw: 1.1, lie: 'ground' },
    { kind: 'pickup', item: 'axe', n: 1, x: TEST_FLOOR.x, y: TEST_FLOOR.y, z: TEST_FLOOR.z, yaw: 0, lie: 'shelf' },
    { kind: 'crate', type: 'luggage', loot: [{ item: 'ration', n: 2 }, { item: 'bandage', n: 1 }], ...at(5, 6), yaw: 2 },
    { kind: 'wood', type: 'snag', ...at(-8, -12), yaw: 0, seed: 11, scale: 1 },
    { kind: 'wood', type: 'deadfall', ...at(12, -16), yaw: 1.3, seed: 12, scale: 1.2 },
    { kind: 'log', ...at(6, -6), yaw: 0.7, len: 2.4 },
    { kind: 'fire', type: 'barrel', ...at(-3, 3), shelter: 0.5 },
    { kind: 'fire', type: 'stove', x: TEST_FLOOR.x + 2, y: TEST_FLOOR.y, z: TEST_FLOOR.z, shelter: 1 },
    { kind: 'device', type: 'panel', poi: 'tower', ...at(0, -150), yaw: 0, data: 0 },
    { kind: 'device', type: 'generator', poi: 'tower', ...at(3, -150), yaw: 0, data: 0 },
    { kind: 'device', type: 'note', poi: 'wreck', ...at(1, 5), yaw: 0, data: 0 },
  ];
  const packs: PackDef[] = [{ x: -100, z: -100, range: 120, count: 3, wakeAt: 300 }];
  const partAt = (poi: PoiId): { poi: PoiId; x: number; y: number; z: number } => {
    const p = poiById.get(poi)!;
    return { poi, x: p.x + 1, y: p.y, z: p.z + 1 };
  };
  const parts: Record<PartId, { poi: PoiId; x: number; y: number; z: number }> = {
    battery: partAt('tail'), handset: partAt('cabin'), fuse: partAt('hut'), tube: partAt('cave'), coil: partAt('camp'),
  };

  // --- raw grids (coarse: nothing renders this world) ------------------------------------------
  const HN = 65;
  const hdata = new Float32Array(HN * HN);
  const mdata = new Uint8Array(HN * HN * 4);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < HN; j++) {
    for (let i = 0; i < HN; i++) {
      const x = -half + (2 * half * i) / (HN - 1), z = -half + (2 * half * j) / (HN - 1);
      const h = heightAt(x, z);
      hdata[j * HN + i] = h;
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
      const k = (j * HN + i) * 4;
      mdata[k] = Math.floor(hash01(seed, i, j) * 40);
      mdata[k + 1] = slopeAt(x, z) > 0.3 ? 255 : 0;
      mdata[k + 2] = iceAt(x, z) > 0 ? 255 : 0;
      mdata[k + 3] = 0;
    }
  }

  const world: World = {
    seed,
    size: half * 2,
    half,
    heightAt,
    groundAt,
    normalAt,
    slopeAt,
    snowDepthAt,
    surfaceAt,
    forestAt: (x, z) => (Math.hypot(x - TEST_TREE.x, z - TEST_TREE.z) < 6 ? 0.3 : 0),
    heightmap: { data: hdata, n: HN, extent: half, min: hmin, max: hmax },
    masks: { data: mdata, n: HN, extent: half },
    pois,
    poi: (id) => poiById.get(id)!,
    lake,
    iceAt,
    iceCell,
    trees,
    treesIn: (minX, minZ, maxX, maxZ, out = []) => {
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        if (t.x >= minX && t.x <= maxX && t.z >= minZ && t.z <= maxZ) out.push(i);
      }
      return out;
    },
    rocks,
    props,
    floors,
    shelters,
    collidersNear,
    shelterAt: (x, y, z) => {
      for (const s of shelters) {
        if (Math.abs(y - s.y) <= s.hy && inRect(x, z, s.x, s.z, s.hx, s.hz, s.yaw)) return { amount: s.amount, indoor: s.indoor };
      }
      return { amount: 0, indoor: false };
    },
    lineClear: (ax, ay, az, bx, by, bz) => {
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-6) return true;
      const hit = raycast(ax, ay, az, dx, dy, dz, d);
      return hit === null;
    },
    raycast,
    spawn: {
      players: [
        { x: 0, y: 0, z: 0, yaw: 0 },
        { x: 1.5, y: 0, z: 0.5, yaw: 0 },
        { x: -1.5, y: 0, z: 0.5, yaw: 0 },
        { x: 0, y: 0, z: 2, yaw: 0 },
      ],
      defs,
      packs,
      parts,
    },
    route: [
      { x: 0, z: 0, poi: 'wreck' },
      { x: -10, z: -60 },
      { x: 0, z: -150, poi: 'tower' },
    ],
    walkable: (x, z) => Math.abs(x) < half - 2 && Math.abs(z) < half - 2 && slopeAt(x, z) < 0.26,
  };
  return world;
}
