// What the simulation starts with. Fixed things are placed on the anchors of the blueprints
// (so a rifle lies on the cabin's rack and the fuse on the hut's shelf); scattered things (sticks
// under trees, snags and deadfall for the axe, heavy logs) are drawn from the trees and the forest
// with a seeded hash, kept on walkable ground, off the packed trail and out of every collider.
//
// Totals across the map (beyond what players start with: a flashlight and six matches each):
// about 20 matches, 14 rifle rounds, 7 flares, 150 snags / deadfall, and about 460 stick pickups
// in bundles of 1 to 3 (some 880 sticks): 9 to 11 sticks round the fuselage, about 140 beside the
// trail where it runs through forest, the rest at the foot of trunks (scatterSticks).
// The five radio parts are pickups in `defs` AND listed in `parts` (same positions): the spawn
// system turns defs into entities; `parts` is for the radio's signal and the objective.
import type { ItemId, PartId, Surface } from '../sim/types';
import { hash01 } from '../core/rng';
import type { Pose } from './blueprints';
import { datan2, dcos, dlen, dsin, PI, TAU, wrapPi } from './dmath';
import { pathDistance } from './route';
import type { TreeObj } from './scatter';
import type { PackDef, PoiId, SpawnCrate, SpawnDef, SpawnDevice, SpawnItem } from './types';

export interface SpawnCtx {
  seed: number;
  anchors: Record<string, Pose>;
  groundAt(x: number, z: number, y: number): { y: number; surface: Surface };
  walkable(x: number, z: number): boolean;
  /** A solid (tree, rock, wall) within r of the point at height y. */
  blocked(x: number, y: number, z: number, r: number): boolean;
  forestAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  trailAt(x: number, z: number): number;
  onIce(x: number, z: number): boolean;
  inClearing(x: number, z: number, pad: number): boolean;
  trees: TreeObj[];
  path: { x: number; z: number }[];
  /** The skid scar, from the fuselage break (a) to the touchdown point (b). */
  scar: { ax: number; az: number; bx: number; bz: number };
}

export interface SpawnOut {
  players: { x: number; y: number; z: number; yaw: number }[];
  defs: SpawnDef[];
  packs: PackDef[];
  parts: Record<PartId, { poi: PoiId; x: number; y: number; z: number }>;
}

export function buildSpawn(ctx: SpawnCtx): SpawnOut {
  const { seed, anchors } = ctx;
  const defs: SpawnDef[] = [];
  const S = seed * 41 + 7;
  const A = (key: string): Pose => {
    const a = anchors[key];
    if (!a) throw new Error('missing anchor ' + key);
    return a;
  };
  const ground = (x: number, z: number, y: number) => ctx.groundAt(x, z, y + 0.4).y;

  const item = (key: string, it: ItemId, n: number, lie: SpawnItem['lie'], dx = 0, dz = 0): SpawnItem => {
    const a = A(key);
    const x = a.x + dx, z = a.z + dz;
    const y = lie === 'shelf' ? a.y : ground(x, z, a.y);
    const d: SpawnItem = { kind: 'pickup', item: it, n, x, y, z, yaw: wrapPi(a.yaw + 0.3 * (hash01(S, defs.length, 1) - 0.5)), lie };
    defs.push(d);
    return d;
  };
  const crate = (key: string, type: SpawnCrate['type'], loot: { item: ItemId; n: number }[]) => {
    const a = A(key);
    defs.push({ kind: 'crate', type, loot, x: a.x, y: ground(a.x, a.z, a.y), z: a.z, yaw: wrapPi(a.yaw) });
  };
  const device = (key: string, type: SpawnDevice['type'], poi: PoiId, data = 0) => {
    const a = A(key);
    defs.push({ kind: 'device', type, poi, x: a.x, y: a.y, z: a.z, yaw: wrapPi(a.yaw), data });
  };

  // --- the wreck
  {
    const b = A('wreck:site.barrel');
    defs.push({ kind: 'fire', type: 'barrel', x: b.x, y: ground(b.x, b.z, b.y) + 0.9, z: b.z, shelter: 0.35 });
    crate('wreck:fuselage.locker', 'locker', [{ item: 'flaregun', n: 1 }, { item: 'flare', n: 1 }, { item: 'flashlight', n: 1 }, { item: 'cell', n: 1 }]);
    crate('wreck:fuselage.medkit', 'medkit', [{ item: 'bandage', n: 2 }]);
    crate('wreck:site.luggage1', 'luggage', [{ item: 'matches', n: 3 }, { item: 'ration', n: 1 }, { item: 'tinder', n: 1 }]);
    crate('wreck:site.luggage2', 'luggage', [{ item: 'thermos', n: 1 }, { item: 'bandage', n: 1 }]);
    item('wreck:fuselage.loot1', 'radio', 1, 'ground');
    item('wreck:fuselage.galley', 'ration', 2, 'shelf');
    item('wreck:fuselage.loot2', 'cell', 1, 'ground');
    device('wreck:fuselage.note', 'note', 'wreck', 0);
  }
  // --- the tail section
  {
    item('tail:tail.cargo1', 'axe', 1, 'ground');
    item('tail:tail.part', 'part_battery', 1, 'shelf');
    crate('tail:tail.cargo2', 'crate', [{ item: 'flare', n: 1 }, { item: 'ration', n: 1 }, { item: 'tinder', n: 1 }, { item: 'matches', n: 1 }]);
    device('tail:tail.note', 'note', 'tail', 1);
  }
  // --- the cabin
  {
    const s = A('cabin:cabin.stove');
    defs.push({ kind: 'fire', type: 'stove', x: s.x, y: s.y + 0.45, z: s.z, shelter: 1 });
    item('cabin:cabin.rack', 'rifle', 1, 'shelf');
    item('cabin:cabin.shelf2', 'ammo', 5, 'shelf');
    item('cabin:cabin.table', 'part_handset', 1, 'shelf');
    item('cabin:cabin.shelf1', 'bandage', 1, 'shelf');
    item('cabin:cabin.shelf1b', 'thermos', 1, 'shelf');
    crate('cabin:cabin.cupboard', 'cupboard', [{ item: 'matches', n: 4 }, { item: 'tinder', n: 2 }, { item: 'ration', n: 1 }, { item: 'cell', n: 1 }, { item: 'ammo', n: 1 }]);
    item('cabin:cabin.hearth', 'stick', 3, 'ground');
    item('cabin:woodshed.pile', 'log', 4, 'shelf');
    device('cabin:cabin.door', 'door', 'cabin', 0);
    device('cabin:cabin.bed', 'bed', 'cabin', 0);
    device('cabin:cabin.note', 'note', 'cabin', 2);
    for (const k of ['log1', 'log2', 'log3', 'log4']) {
      const a = A('cabin:site.' + k);
      defs.push({ kind: 'log', x: a.x, y: ground(a.x, a.z, a.y), z: a.z, yaw: wrapPi(a.yaw), len: 2.6 + 0.5 * hash01(S, 11, defs.length) });
    }
    const bp = A('cabin:site.branchpile');
    defs.push({ kind: 'wood', type: 'branchpile', x: bp.x, y: ground(bp.x, bp.z, bp.y), z: bp.z, yaw: wrapPi(bp.yaw), seed: (hash01(S, 12, 0) * 1e9) >>> 0, scale: 1 });
  }
  // --- the hut on the ice
  {
    item('hut:hut.part', 'part_fuse', 1, 'shelf');
    crate('hut:hut.toolbox', 'toolbox', [{ item: 'matches', n: 2 }, { item: 'flare', n: 1 }, { item: 'tinder', n: 1 }]);
    device('hut:hut.door', 'door', 'hut', 0);
    device('hut:hut.note', 'note', 'hut', 3);
  }
  // --- the cave
  {
    item('cave:cave.part', 'part_tube', 1, 'ground');
    crate('cave:cave.cache', 'crate', [{ item: 'ammo', n: 2 }, { item: 'matches', n: 3 }, { item: 'ration', n: 1 }, { item: 'bandage', n: 1 }]);
    item('cave:cave.sticks', 'stick', 4, 'ground');
    device('cave:cave.note', 'note', 'cave', 4);
  }
  // --- the survey camp
  {
    item('camp:site.part', 'part_coil', 1, 'shelf');
    crate('camp:site.lootA', 'crate', [{ item: 'ammo', n: 3 }, { item: 'flare', n: 2 }]);
    crate('camp:site.lootB', 'crate', [{ item: 'matches', n: 3 }, { item: 'cell', n: 1 }, { item: 'ration', n: 1 }]);
    item('camp:site.lootC', 'bandage', 1, 'ground');
    device('camp:site.note', 'note', 'camp', 5);
  }
  // --- the signal tower
  {
    crate('tower:shed.locker', 'locker', [{ item: 'ammo', n: 3 }, { item: 'flare', n: 1 }, { item: 'matches', n: 2 }, { item: 'thermos', n: 1 }]);
    device('tower:shed.panel', 'panel', 'tower', 0);
    device('tower:gen.crank', 'generator', 'tower', 0);
    device('tower:mast.beacon', 'beacon', 'tower', 0);
    device('tower:shed.door', 'door', 'tower', 0);
    device('tower:shed.note', 'note', 'tower', 6);
    item('tower:shed.shelf', 'ration', 1, 'shelf');
  }

  // --- parts
  const partOf = (it: ItemId): { poi: PoiId; x: number; y: number; z: number } => {
    const d = defs.find((q) => q.kind === 'pickup' && q.item === it) as SpawnItem;
    const poi: PoiId = it === 'part_battery' ? 'tail' : it === 'part_handset' ? 'cabin' : it === 'part_fuse' ? 'hut' : it === 'part_tube' ? 'cave' : 'camp';
    return { poi, x: d.x, y: d.y, z: d.z };
  };
  const parts: Record<PartId, { poi: PoiId; x: number; y: number; z: number }> = {
    battery: partOf('part_battery'), handset: partOf('part_handset'), coil: partOf('part_coil'), tube: partOf('part_tube'), fuse: partOf('part_fuse'),
  };

  // --- scattered wood and sticks
  const distRoute = pathDistance(ctx.path);
  const okSpot = (x: number, z: number, y: number, r: number) =>
    x > -760 && x < 760 && z > -760 && z < 760 &&
    ctx.walkable(x, z) && !ctx.onIce(x, z) && ctx.trailAt(x, z) < 0.35 && !ctx.inClearing(x, z, 1) && !ctx.blocked(x, y + 0.2, z, r);

  // luggage burst open along the skid scar
  {
    const sc = ctx.scar;
    const len = dlen(sc.bx - sc.ax, sc.bz - sc.az);
    const ux = (sc.bx - sc.ax) / len, uz = (sc.bz - sc.az) / len;
    const loots: { item: ItemId; n: number }[][] = [
      [{ item: 'matches', n: 2 }, { item: 'flare', n: 1 }],
      [{ item: 'ration', n: 1 }, { item: 'tinder', n: 1 }],
      [{ item: 'bandage', n: 1 }, { item: 'cell', n: 1 }],
    ];
    const at = [36, 87, 141];
    for (let k = 0; k < 3; k++) {
      for (let tries = 0; tries < 40; tries++) {
        const t = at[k] + (hash01(S, 51, k * 64 + tries) - 0.5) * 16;
        const off = (hash01(S, 52, k * 64 + tries) - 0.5) * 14;
        const x = sc.ax + ux * t - uz * off, z = sc.az + uz * t + ux * off;
        const y = ctx.groundAt(x, z, 1e4).y;
        if (!ctx.walkable(x, z) || ctx.blocked(x, y + 0.2, z, 0.7) || distRoute(x, z) < 3.5) continue;
        defs.push({ kind: 'crate', type: 'luggage', loot: loots[k], x, y, z, yaw: wrapPi(hash01(S, 53, k) * TAU) });
        break;
      }
    }
  }
  const trees = ctx.trees;
  // snags and deadfall for the axe, mostly within reach of the route, spread out
  const wood: { x: number; z: number }[] = [];
  for (let k = 0, tries = 0; wood.length < 150 && tries < 20000; tries++) {
    const t = trees[Math.floor(hash01(S, 21, tries) * trees.length)];
    if (!t || t.kind === 'sapling' || t.kind === 'snag') continue;
    const dr = distRoute(t.x, t.z);
    if (dr > 230 && hash01(S, 22, tries) > 0.12) continue;
    const a = hash01(S, 23, tries) * TAU, rr = 3 + hash01(S, 24, tries) * 5;
    const x = t.x + rr * dcos(a), z = t.z + rr * dsin(a);
    let near = false;
    for (const w of wood) if ((w.x - x) * (w.x - x) + (w.z - z) * (w.z - z) < 16 * 16) { near = true; break; }
    if (near) continue;
    const type: 'snag' | 'deadfall' | 'stump' = hash01(S, 25, tries) < 0.55 ? 'snag' : hash01(S, 26, tries) < 0.9 ? 'deadfall' : 'stump';
    if (type === 'deadfall' && ctx.slopeAt(x, z) > 25 / 90) continue;
    const y = ctx.groundAt(x, z, 1e4).y;
    if (!okSpot(x, z, y, type === 'deadfall' ? 1.4 : 0.6)) continue;
    wood.push({ x, z });
    defs.push({ kind: 'wood', type, x, y, z, yaw: wrapPi(hash01(S, 27, tries) * TAU), seed: (hash01(S, 28, tries) * 1e9) >>> 0, scale: 0.8 + 0.5 * hash01(S, 29, tries) });
    k++;
  }
  // heavy logs in the forest near the route
  for (let k = 0, tries = 0; k < 9 && tries < 6000; tries++) {
    const t = trees[Math.floor(hash01(S, 31, tries) * trees.length)];
    if (!t || t.kind === 'sapling') continue;
    if (distRoute(t.x, t.z) > 45) continue;
    const a = hash01(S, 32, tries) * TAU;
    const x = t.x + 3.5 * dcos(a), z = t.z + 3.5 * dsin(a);
    if (ctx.slopeAt(x, z) > 18 / 90) continue;
    const y = ctx.groundAt(x, z, 1e4).y;
    if (!okSpot(x, z, y, 1.6)) continue;
    let near = false;
    for (const d of defs) if (d.kind === 'log' && dlen(d.x - x, d.z - z) < 60) near = true;
    if (near) continue;
    defs.push({ kind: 'log', x, y, z, yaw: wrapPi(hash01(S, 33, tries) * TAU), len: 2.4 + 0.9 * hash01(S, 34, tries) });
    k++;
  }
  // --- sticks, in bundles of 1 to 3 (a careful player walking the forest finds a few a minute): debris
  // round the fuselage for the first fire, fallen branches beside the trail, and more at the foot of
  // trunks all through the forest. Under a dense canopy the snow is thin and they lie on top ('ground');
  // in the open they lie half buried ('snow'). (Each standing conifer also gives its dead branches once,
  // by hand: sim/systems/wood.ts.)
  scatterSticks(ctx, S, defs, distRoute, okSpot);

  // --- players: four slots just outside the fuselage break, facing out down the scar
  const players = [0, 1, 2, 3].map((i) => {
    const a = A('wreck:site.spawn' + i);
    return { x: a.x, y: ground(a.x, a.z, a.y), z: a.z, yaw: wrapPi(a.yaw + PI) };
  });

  // --- wolf packs, waking as the hour goes on
  const den = A('cave:cave.den');
  const cabin = A('cabin:cabin.door');
  const packs: PackDef[] = [
    { x: cabin.x + 95, z: cabin.z - 70, range: 190, count: 3, wakeAt: 420 },
    { x: 330, z: -95, range: 200, count: 3, wakeAt: 1080 },
    { x: den.x, z: den.z, range: 170, count: 4, wakeAt: 1680 },
    { x: 250, z: -560, range: 230, count: 5, wakeAt: 2460 },
  ];
  return { players, defs, packs, parts };
}

/** Radius round the fuselage's centre (m) that holds exactly the wreck's own sticks (WRECK_STICKS). */
export const WRECK_RADIUS = 40;
/** Bundles of debris wood, broken crate slats and fallen branches round the fuselage: 9 to 11 sticks in all. */
const WRECK_STICKS = [3, 2, 2, 1, 0] as const; // the last bundle: 1 to 3, by the seed
/** Bundles scattered under the trees all through the forest (beyond the wreck and the trail). */
export const FOREST_BUNDLES = 400;
/** Chance, per point of the dense trail polyline (about 2 m apart), of a bundle beside it in full forest. */
const TRAIL_RATE = 1 / 15;

/** A bundle's size from a hash: one stick (35 %), two (40 %) or three (25 %). */
const bundle = (h: number): number => (h < 0.35 ? 1 : h < 0.75 ? 2 : 3);

/**
 * The world's loose sticks (see buildSpawn): the wreck's debris first, then fallen branches along the
 * trail through the forest, then bundles at the foot of trunks everywhere (most within reach of the
 * route). Every spot passes `ok` (walkable, off the ice and the packed trail, out of clearings and
 * colliders), except round the wreck, where the debris may lie on the site's pad. No bundle lands
 * within 1 m of another.
 */
function scatterSticks(
  ctx: SpawnCtx, S: number, defs: SpawnDef[], distRoute: (x: number, z: number) => number,
  ok: (x: number, z: number, y: number, r: number) => boolean,
): void {
  const trees = ctx.trees;
  // trunks on an 8 m grid, for "the nearest trunk to here"
  const TC = 8, TO = 800, TN = 200;
  const cellOf = (x: number, z: number): number => {
    const i = Math.floor((x + TO) / TC), j = Math.floor((z + TO) / TC);
    return i < 0 || j < 0 || i >= TN || j >= TN ? -1 : j * TN + i;
  };
  const start = new Int32Array(TN * TN + 1);
  for (const t of trees) {
    const c = cellOf(t.x, t.z);
    if (c >= 0 && t.r > 0) start[c + 1]++;
  }
  for (let c = 0; c < TN * TN; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[TN * TN]);
  {
    const fill = start.slice(0, TN * TN);
    for (let k = 0; k < trees.length; k++) {
      const t = trees[k];
      const c = cellOf(t.x, t.z);
      if (c >= 0 && t.r > 0) items[fill[c]++] = k;
    }
  }
  /** The trunk (not a sapling) whose bark is nearest (x, z), within maxD metres of it, and that distance. */
  const near = { t: trees[0], d: 0 };
  const nearTrunk = (x: number, z: number, maxD: number): typeof near | null => {
    let best: TreeObj | null = null, bd = maxD;
    const i0 = Math.max(0, Math.floor((x - maxD - 1 + TO) / TC)), i1 = Math.min(TN - 1, Math.floor((x + maxD + 1 + TO) / TC));
    const j0 = Math.max(0, Math.floor((z - maxD - 1 + TO) / TC)), j1 = Math.min(TN - 1, Math.floor((z + maxD + 1 + TO) / TC));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * TN + i;
        for (let q = start[c]; q < start[c + 1]; q++) {
          const t = trees[items[q]];
          if (t.kind === 'sapling') continue;
          const d = dlen(t.x - x, t.z - z) - t.r;
          if (d < bd) {
            bd = d;
            best = t;
          }
        }
      }
    }
    if (!best) return null;
    near.t = best;
    near.d = bd;
    return near;
  };
  /** Thin snow under a dense canopy by a trunk: on top. A drift or the open: half buried. Bare rock: on top. */
  const lieAt = (x: number, z: number, y: number): SpawnItem['lie'] => {
    const s = ctx.groundAt(x, z, y + 0.5).surface;
    if (s === 'deep') return 'snow';
    if (s !== 'snow') return 'ground';
    return ctx.forestAt(x, z) > 0.45 && nearTrunk(x, z, 2.4) ? 'ground' : 'snow';
  };
  // every bundle placed, on a 4 m grid, so none lands on another
  const placed = new Map<number, number[]>();
  const key = (i: number, j: number) => (j + 1000) * 4096 + (i + 1000);
  const overlaps = (x: number, z: number, r: number): boolean => {
    const ci = Math.floor(x / 4), cj = Math.floor(z / 4);
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const l = placed.get(key(i, j));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 2) if (dlen(l[q] - x, l[q + 1] - z) < r) return true;
      }
    }
    return false;
  };
  const put = (x: number, y: number, z: number, n: number, yaw: number, lie: SpawnItem['lie']): void => {
    defs.push({ kind: 'pickup', item: 'stick', n, x, y, z, yaw: wrapPi(yaw), lie });
    const k = key(Math.floor(x / 4), Math.floor(z / 4));
    const l = placed.get(k);
    if (l) l.push(x, z);
    else placed.set(k, [x, z]);
  };

  // --- the wreck: debris wood and broken crate slats along the skid scar behind the break, fallen branches
  // at the trees round the site. Exactly these lie within WRECK_RADIUS of the fuselage: the first fire.
  const sc = ctx.scar;
  const sl = dlen(sc.bx - sc.ax, sc.bz - sc.az) || 1;
  const ux = (sc.bx - sc.ax) / sl, uz = (sc.bz - sc.az) / sl; // along the scar, away from the fuselage
  const fx = sc.ax - ux * 9.6, fz = sc.az - uz * 9.6; // the fuselage's centre (structures.ts scarLine: the break is 9.6 m behind it)
  const others = defs.filter((d) => dlen(d.x - fx, d.z - fz) < WRECK_RADIUS + 12);
  const wreckSpot = (x: number, z: number, y: number): boolean => {
    const ax = (x - fx) * ux + (z - fz) * uz, lat = Math.abs((z - fz) * ux - (x - fx) * uz);
    if (lat < 3.3 && ax > -11.8 && ax < 11.8) return false; // in or against the hull
    if (dlen(x - fx, z - fz) > WRECK_RADIUS - 3 || !ctx.walkable(x, z) || ctx.onIce(x, z) || ctx.blocked(x, y + 0.2, z, 0.25)) return false;
    const s = ctx.groundAt(x, z, y + 0.5).surface;
    if (s === 'wood' || s === 'metal') return false; // on a floor
    for (const d of others) if (dlen(d.x - x, d.z - z) < 1.4) return false;
    return !overlaps(x, z, 1.6);
  };
  const wreckTrees = trees.filter((t) => t.kind !== 'sapling' && t.r > 0 && dlen(t.x - fx, t.z - fz) > 12 && dlen(t.x - fx, t.z - fz) < WRECK_RADIUS - 6);
  for (let b = 0; b < WRECK_STICKS.length; b++) {
    const n = WRECK_STICKS[b] || 1 + Math.floor(hash01(S, 70, 1) * 3);
    const branches = b >= 3 && wreckTrees.length > 0;
    for (let tries = 0; tries < 80; tries++) {
      const h1 = hash01(S, 71 + b, tries), h2 = hash01(S, 76 + b, tries), h3 = hash01(S, 81 + b, tries);
      let x: number, z: number;
      if (branches && tries < 50) {
        // fallen from a tree at the edge of the site, at its foot on the wreck's side
        const t = wreckTrees[Math.floor(h1 * wreckTrees.length)];
        const a = datan2(fx - t.x, fz - t.z) + (h2 - 0.5) * 2.2;
        const rr = t.r + 0.5 + 1.3 * h3;
        x = t.x + rr * dsin(a);
        z = t.z + rr * dcos(a);
      } else {
        // thrown out along the scar: 3 to 28 m behind the break, a little to either side
        const along = 3 + 25 * h1, off = (1.5 + 7.5 * h2) * (h3 < 0.5 ? -1 : 1);
        x = sc.ax + ux * along - uz * off;
        z = sc.az + uz * along + ux * off;
      }
      const y = ctx.groundAt(x, z, 1e4).y;
      if (!wreckSpot(x, z, y)) continue;
      put(x, y, z, n, hash01(S, 86 + b, tries) * TAU, 'ground');
      break;
    }
  }
  const nearWreck = (x: number, z: number): boolean => dlen(x - fx, z - fz) < WRECK_RADIUS + 4;

  // --- fallen branches beside the trail, where it runs through forest (none in the open)
  const path = ctx.path;
  let lx = 1e9, lz = 1e9;
  for (let k = 1; k + 1 < path.length; k++) {
    const p = path[k], q0 = path[k - 1], q1 = path[k + 1];
    let tx = q1.x - q0.x, tz = q1.z - q0.z;
    const tl = dlen(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const nx = -tz, nz = tx;
    const fo = Math.max(ctx.forestAt(p.x + nx * 7, p.z + nz * 7), ctx.forestAt(p.x - nx * 7, p.z - nz * 7));
    const rate = TRAIL_RATE * Math.min(1, Math.max(0, (fo - 0.12) / 0.45));
    if (hash01(S, 61, k) >= rate) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = k * 4 + attempt;
      const side = hash01(S, 62, h) < 0.5 ? -1 : 1;
      const off = 2.5 + 7 * hash01(S, 63, h);
      let x = p.x + nx * side * off, z = p.z + nz * side * off;
      const t = nearTrunk(x, z, 3.5);
      if (t) {
        // at the foot of that trunk, on the trail's side of it
        let ax = p.x - t.t.x, az = p.z - t.t.z;
        const al = dlen(ax, az) || 1;
        ax /= al;
        az /= al;
        const a = (hash01(S, 64, h) - 0.5) * 1.6, ca = dcos(a), sa = dsin(a);
        const rr = t.t.r + 0.45 + 1.2 * hash01(S, 65, h);
        x = t.t.x + (ax * ca - az * sa) * rr;
        z = t.t.z + (ax * sa + az * ca) * rr;
      }
      if (dlen(x - lx, z - lz) < 8 || nearWreck(x, z)) continue;
      const y = ctx.groundAt(x, z, 1e4).y;
      if (!ok(x, z, y, 0.15) || overlaps(x, z, 1.2)) continue;
      put(x, y, z, bundle(hash01(S, 66, k)), hash01(S, 67, k) * TAU, lieAt(x, z, y));
      lx = x;
      lz = z;
      break;
    }
  }

  // --- under trees all through the forest: denser where it is thick, most of them within reach of the route
  for (let k = 0, tries = 0; k < FOREST_BUNDLES && tries < 40000; tries++) {
    const t = trees[Math.floor(hash01(S, 41, tries) * trees.length)];
    if (!t || t.kind === 'sapling') continue;
    const f = ctx.forestAt(t.x, t.z);
    if (hash01(S, 42, tries) > 0.25 + f) continue;
    if (distRoute(t.x, t.z) > 160 && hash01(S, 43, tries) > 0.35) continue;
    const a = hash01(S, 44, tries) * TAU, rr = t.r + 0.4 + hash01(S, 45, tries) * 2;
    const x = t.x + rr * dcos(a), z = t.z + rr * dsin(a);
    if (nearWreck(x, z)) continue;
    const y = ctx.groundAt(x, z, 1e4).y;
    if (!ok(x, z, y, 0.15) || overlaps(x, z, 1)) continue;
    put(x, y, z, bundle(hash01(S, 46, tries)), hash01(S, 47, tries) * TAU, lieAt(x, z, y));
    k++;
  }
}
