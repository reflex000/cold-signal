// createWorld(seed): the whole static mountain as a pure function of the seed. Host and clients
// build identical copies. No three, no DOM, no clock, no Math.random.
//
// Build order: terrain (coarse shape + erosion, walls, sharp features, pads) -> route (A* legs,
// carved into the terrain as a graded trail) -> pads and lake re-levelled -> structures (sites,
// wreckage, trail markers) -> masks and snow -> trees and rocks -> collision index -> lake ice
// -> spawn tables. See docs/status/WORLD.md for the layout of the grids and the conventions.
import type { PartId, Surface } from '../sim/types';
import { SITES, toWorld, type Pose } from './blueprints';
import { ColliderIndex, KIND_ROCK, KIND_TREE, KIND_WALL, rayFloors, type RayHit } from './collide';
import { datan, dcos, dlen, dsin, PI, smooth01, wrapPi } from './dmath';
import { buildFields, SNOW_SCALE, type Clearing } from './fields';
import { buildLake, iceCellOf } from './lake';
import * as L from './layout';
import { buildRoute, type Stop } from './route';
import { makeClearGrid, scatterRocks, scatterTrees, type RockObj, type TreeObj } from './scatter';
import { buildSpawn } from './spawn';
import { buildStructures, scarLine, sitePoses } from './structures';
import { applyPads, buildTerrain, flattenLake, sampleGrid, siteClears } from './terrain';
import {
  WORLD_HALF, WORLD_SIZE,
  type Collider, type Floor, type PackDef, type Poi, type PoiId, type PropInst, type ShelterVol, type SpawnDef, type World,
} from './types';

export type { Pose } from './blueprints';
export { BLUEPRINTS, SITES, blueprint, placeBlueprint, placeSite } from './blueprints';

/** The World plus a few extras other modules may use (all optional to them). */
export interface WorldEx extends World {
  /** World-space anchors of every placed structure: 'poi:part.anchor' (e.g. 'cabin:cabin.stove',
   * 'tower:shed.panel', 'wreck:fuselage.locker') and 'poi:site.name' ('cabin:site.approach'). */
  readonly anchors: Record<string, Pose>;
  /** The dense route polyline (about 2 m apart) the trail was carved along. */
  readonly trail: { x: number; z: number }[];
  /** The safe line across the lake ice, shore to hut. */
  readonly safeLine: { ax: number; az: number; bx: number; bz: number };
  /** Thin ice patches (centre and radius), for hints and debugging. */
  readonly thinIce: { x: number; z: number; r: number }[];
  /** Route length in metres and object counts. */
  readonly stats: { routeLength: number; trees: number; rocks: number; props: number; colliders: number; defs: number };
}

const N = L.N;
const EXT = L.EXTENT;
const CELL = L.CELL;

export function createWorld(seed: number, onProgress?: (p: number, label: string) => void): WorldEx {
  const prog = (p: number, label: string) => {
    if (onProgress) onProgress(p, label);
  };

  // --- terrain ------------------------------------------------------------------------------
  const terr = buildTerrain(seed, (p, l) => prog(p * 0.42 / 0.32, l));
  const h = terr.h;
  const padY: Partial<Record<PoiId, number>> = {};
  for (const p of terr.pads) padY[p.id] = p.y;
  const poses = sitePoses(padY);

  // --- route --------------------------------------------------------------------------------
  prog(0.44, 'Finding the way up');
  const approach = (id: Exclude<PoiId, 'lake'>): Stop => {
    const a = SITES[id].anchors.approach;
    const w = toWorld(poses[id], a.x, 0, a.z);
    return { x: w.x, z: w.z, poi: id };
  };
  const hutA = approach('hut');
  const hutYaw = poses.hut.yaw;
  const out = L.lakeShore(dsin(hutYaw), dcos(hutYaw), 3.5, seed);
  const shore: Stop = { x: out.x, z: out.z, poi: 'lake' };
  const stops: Stop[] = [
    approach('wreck'), approach('tail'), approach('cabin'), shore,
    { ...hutA, straight: true }, { x: shore.x, z: shore.z, straight: true },
    approach('cave'), approach('camp'), approach('tower'),
  ];
  const avoid: { x: number; z: number; r: number }[] = [];
  for (const id of ['wreck', 'tail', 'cabin', 'cave', 'camp', 'tower'] as const) for (const c of siteClears(id, padY[id] ?? 0)) avoid.push(c);
  const scar = scarLine();
  const route = buildRoute({
    h, seed, stops, avoid,
    prefer: [{ ax: scar.ax, az: scar.az, bx: scar.bx, bz: scar.bz, w: 10 }],
  });
  applyPads(h, terr.pads, true);
  flattenLake(h, seed);

  const heightAt = (x: number, z: number): number => sampleGrid(h, x, z);
  const onLake = (x: number, z: number): boolean => {
    const dx = x - L.LAKE_X, dz = z - L.LAKE_Z;
    if (dx < -170 || dx > 170 || dz < -170 || dz > 170) return false;
    return L.lakeSdf(x, z, seed) <= 0;
  };

  // --- structures ---------------------------------------------------------------------------
  prog(0.55, 'Building the places');
  const st = buildStructures({ seed, heightAt, poses, path: route.path, stopAt: route.stopAt, onIce: onLake });

  // --- masks and snow -----------------------------------------------------------------------
  prog(0.6, 'Laying the snow');
  const clearings: Clearing[] = st.clears.map((c) => ({ x: c.x, z: c.z, r: c.r + 1, feather: 6 }));
  const packed: Clearing[] = [];
  for (const p of terr.pads) for (const d of p.discs) packed.push({ x: d.x, z: d.z, r: d.r * 0.8, feather: d.feather * 0.7 });
  const fields = buildFields({
    h, seed, trail: route.trail, clearings, packed,
    strips: [{ ax: scar.bx, az: scar.bz, bx: scar.ax, bz: scar.az, w0: 9, w1: 15 }],
  });
  const masks = fields.masks;
  const snowGrid = fields.snow;

  // --- trees and rocks ----------------------------------------------------------------------
  prog(0.72, 'Growing the forest');
  const clearGrid = makeClearGrid(st.clears);
  const sc = { seed, h, masks, lee: fields.lee, exposure: fields.exposure, clear: clearGrid, heightAt };
  const trees: TreeObj[] = scatterTrees(sc);
  prog(0.82, 'Scattering rocks');
  const rocks: RockObj[] = scatterRocks(sc);

  // --- collision ----------------------------------------------------------------------------
  prog(0.88, 'Solid things');
  const colList: Collider[] = [];
  const kinds: number[] = [];
  for (const t of trees) if (t.r > 0) { colList.push(t); kinds.push(KIND_TREE); }
  for (const r of rocks) if (r.r > 0) { colList.push(r); kinds.push(KIND_ROCK); }
  for (const c of st.colliders) { colList.push(c); kinds.push(c.kind === 'rock' ? KIND_ROCK : KIND_WALL); }
  const cols = new ColliderIndex(colList, Uint8Array.from(kinds), dcos, dsin);
  const floors: Floor[] = st.floors;
  const fcs = new Float64Array(floors.length), fsn = new Float64Array(floors.length);
  const fx0 = new Float64Array(floors.length), fx1 = new Float64Array(floors.length), fz0 = new Float64Array(floors.length), fz1 = new Float64Array(floors.length);
  floors.forEach((f, k) => {
    fcs[k] = dcos(f.yaw);
    fsn[k] = dsin(f.yaw);
    const r = Math.sqrt(f.hx * f.hx + f.hz * f.hz);
    fx0[k] = f.x - r; fx1[k] = f.x + r; fz0[k] = f.z - r; fz1[k] = f.z + r;
  });
  const shelters: ShelterVol[] = st.shelters;
  const scs = shelters.map((s) => dcos(s.yaw)), ssn = shelters.map((s) => dsin(s.yaw));

  // --- lake ice -----------------------------------------------------------------------------
  prog(0.92, 'Freezing the lake');
  const safeLine = { ax: shore.x, az: shore.z, bx: hutA.x, bz: hutA.z };
  const lakeB = buildLake(seed, { x: L.PLACES.hut.x, z: L.PLACES.hut.z }, safeLine);
  const lake = lakeB.info;

  // --- queries ------------------------------------------------------------------------------
  const inFloor = (k: number, x: number, z: number): boolean => {
    if (x < fx0[k] || x > fx1[k] || z < fz0[k] || z > fz1[k]) return false;
    const f = floors[k];
    const dx = x - f.x, dz = z - f.z;
    const lx = dx * fcs[k] - dz * fsn[k], lz = dx * fsn[k] + dz * fcs[k];
    return Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz;
  };
  const gradAt = (x: number, z: number, o: { gx: number; gz: number }) => {
    let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
    if (fx < 1) fx = 1; else if (fx > N - 2.000001) fx = N - 2.000001;
    if (fz < 1) fz = 1; else if (fz > N - 2.000001) fz = N - 2.000001;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const k = j * N + i;
    const inv = 1 / (2 * CELL);
    const gx00 = (h[k + 1] - h[k - 1]) * inv, gx10 = (h[k + 2] - h[k]) * inv, gx01 = (h[k + N + 1] - h[k + N - 1]) * inv, gx11 = (h[k + N + 2] - h[k + N]) * inv;
    const gz00 = (h[k + N] - h[k - N]) * inv, gz10 = (h[k + N + 1] - h[k - N + 1]) * inv, gz01 = (h[k + 2 * N] - h[k]) * inv, gz11 = (h[k + 2 * N + 1] - h[k + 1]) * inv;
    o.gx = gx00 + (gx10 - gx00) * u + (gx01 - gx00) * v + (gx00 - gx10 - gx01 + gx11) * u * v;
    o.gz = gz00 + (gz10 - gz00) * u + (gz01 - gz00) * v + (gz00 - gz10 - gz01 + gz11) * u * v;
  };
  const gs = { gx: 0, gz: 0 };
  const normalAt = (x: number, z: number) => {
    gradAt(x, z, gs);
    const l = Math.sqrt(gs.gx * gs.gx + 1 + gs.gz * gs.gz);
    return { x: -gs.gx / l, y: 1 / l, z: -gs.gz / l };
  };
  const slopeAt = (x: number, z: number): number => {
    gradAt(x, z, gs);
    return datan(Math.sqrt(gs.gx * gs.gx + gs.gz * gs.gz)) / (PI / 2);
  };
  const maskAt = (ch: number, x: number, z: number): number => {
    let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
    if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
    if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const k = (j * N + i) * 4 + ch;
    const a = masks[k], b = masks[k + 4], c = masks[k + N * 4], d = masks[k + N * 4 + 4];
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) / 255;
  };
  const rawSnow = (x: number, z: number): number => {
    let fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
    if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
    if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const k = j * N + i;
    const a = snowGrid[k], b = snowGrid[k + 1], c = snowGrid[k + N], d = snowGrid[k + N + 1];
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) / SNOW_SCALE;
  };
  const onAnyFloor = (x: number, z: number): boolean => {
    for (let k = 0; k < floors.length; k++) if (inFloor(k, x, z)) return true;
    return false;
  };
  const iceCell = (x: number, z: number): number => iceCellOf(lake, seed, x, z);
  const iceAt = (x: number, z: number): number => {
    const i = iceCell(x, z);
    return i < 0 ? 0 : lake.thickness[i];
  };
  const snowDepthAt = (x: number, z: number): number => {
    if (onAnyFloor(x, z) || onLake(x, z)) return 0;
    return rawSnow(x, z);
  };
  const surfaceAt = (x: number, z: number): Surface => {
    if (onLake(x, z)) return 'ice';
    const s = rawSnow(x, z);
    if (maskAt(1, x, z) > 0.55 || s < 0.03) return 'rock';
    return s > 0.35 ? 'deep' : 'snow';
  };
  const groundAt = (x: number, z: number, y: number): { y: number; surface: Surface } => {
    let best = heightAt(x, z);
    let surf: Surface | null = null;
    for (let k = 0; k < floors.length; k++) {
      const f = floors[k];
      if (f.y > best && f.y <= y + L.STEP_UP && inFloor(k, x, z)) {
        best = f.y;
        surf = f.surface;
      }
    }
    return { y: best, surface: surf ?? surfaceAt(x, z) };
  };
  const forestAt = (x: number, z: number): number => maskAt(0, x, z);
  const walkable = (x: number, z: number): boolean => {
    if (x <= -WORLD_HALF + 2 || x >= WORLD_HALF - 2 || z <= -WORLD_HALF + 2 || z >= WORLD_HALF - 2) return false;
    if (slopeAt(x, z) >= L.WALK_SLOPE) return false;
    return !cols.inside(x, NaN, z);
  };

  // rays
  const rhit = { t: Infinity, k: -1 };
  const terrainRay = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, step: number): number => {
    let t0 = 0;
    let above = oy - heightAt(ox, oz);
    if (above < 0) return 0; // starts under ground
    for (let t = step; t <= maxT + step; t += step) {
      const tt = t > maxT ? maxT : t;
      const y = oy + dy * tt;
      const a = y - heightAt(ox + dx * tt, oz + dz * tt);
      if (a < 0) {
        // refine between t0 and tt
        let lo = t0, hi = tt;
        for (let q = 0; q < 10; q++) {
          const m = (lo + hi) * 0.5;
          if (oy + dy * m - heightAt(ox + dx * m, oz + dz * m) < 0) hi = m;
          else lo = m;
        }
        return hi;
      }
      above = a;
      t0 = tt;
      if (tt >= maxT) break;
    }
    void above;
    return Infinity;
  };
  const raycast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null => {
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l < 1e-9 || maxDist <= 0) return null;
    dx /= l; dy /= l; dz /= l;
    let best = terrainRay(ox, oy, oz, dx, dy, dz, maxDist, 0.75);
    let what: RayHit['what'] = 'ground';
    const tf = rayFloors(floors, fcs, fsn, ox, oy, oz, dx, dy, dz, Math.min(best, maxDist));
    if (tf < best) best = tf;
    cols.ray(ox, oy, oz, dx, dy, dz, Math.min(best, maxDist), 0, rhit);
    if (rhit.t < best) {
      best = rhit.t;
      const kd = cols.kind[rhit.k];
      what = kd === KIND_TREE ? 'tree' : kd === KIND_ROCK ? 'rock' : 'wall';
    }
    if (best === Infinity || best > maxDist) return null;
    return { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best, dist: best, what };
  };
  const lineClear = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean => {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.05) return true;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    // terrain (a little slack at both ends: feet on the ground do not block)
    const steps = Math.ceil(d / 1.5);
    for (let s = 1; s < steps; s++) {
      const t = (s / steps) * d;
      if (t < 0.4 || t > d - 0.4) continue;
      if (ay + uy * t < heightAt(ax + ux * t, az + uz * t) - 0.05) return false;
    }
    cols.ray(ax, ay, az, ux, uy, uz, d, KIND_ROCK, rhit);
    return rhit.t > d;
  };

  // shelter: volumes, the lee of the ground upwind, rocks and walls upwind, the canopy
  const colScratch: Collider[] = [];
  const LEE_D = [4, 8, 13, 19, 26, 30];
  const shelterAt = (x: number, y: number, z: number, windX: number, windZ: number): { amount: number; indoor: boolean } => {
    let vol = 0, indoor = false;
    for (let k = 0; k < shelters.length; k++) {
      const s = shelters[k];
      const dy = y - s.y;
      if (dy < -s.hy - 0.3 || dy > s.hy + 0.3) continue;
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > (s.hx + s.hz + 1) * (s.hx + s.hz + 1)) continue;
      const lx = dx * scs[k] - dz * ssn[k], lz = dx * ssn[k] + dz * scs[k];
      const e = Math.min(s.hx - Math.abs(lx), s.hz - Math.abs(lz));
      if (e < -0.3) continue;
      const a = s.amount * smooth01(-0.3, 0.35, e);
      if (a > vol) vol = a;
      if (s.indoor && e > 0) indoor = true;
    }
    if (indoor) return { amount: Math.max(vol, 0.9), indoor: true };
    let wl = Math.sqrt(windX * windX + windZ * windZ);
    let ux: number, uz: number;
    if (wl < 1e-3) { ux = -L.WIND_X; uz = -L.WIND_Z; wl = 1; }
    else { ux = -windX / wl; uz = -windZ / wl; }
    // terrain lee: is the ground upwind higher than a person standing here?
    const head = Math.max(y, heightAt(x, z)) + 1.2;
    let tmax = -1;
    for (const d of LEE_D) {
      const t = (heightAt(x + ux * d, z + uz * d) - head) / d;
      if (t > tmax) tmax = t;
    }
    const lee = 0.85 * smooth01(0.02, 0.45, tmax);
    // rocks and walls just upwind
    let block = 0;
    colScratch.length = 0;
    cols.near(x + ux * 3.5, z + uz * 3.5, 4.5, colScratch);
    for (const c of colScratch) {
      if (c.y1 < y + 0.9 || c.y0 > y + 1.6) continue;
      const isTree = c.s === 'c' && (c as TreeObj).kind !== undefined;
      if (isTree) continue;
      const rx = c.x - x, rz = c.z - z;
      const along = rx * ux + rz * uz;
      if (along <= 0) continue;
      const rad = c.s === 'c' ? c.r : Math.max(c.hx, c.hz);
      const lat = Math.abs(rx * uz - rz * ux);
      if (lat > rad + 0.6) continue;
      const b = 0.75 * (1 - smooth01(rad + 0.5, rad + 7, along)) * smooth01(0.4, 1.6, c.y1 - y);
      if (b > block) block = b;
    }
    const canopy = 0.45 * forestAt(x, z);
    const amount = 1 - (1 - vol) * (1 - lee) * (1 - block) * (1 - canopy);
    return { amount: amount > 1 ? 1 : amount, indoor: false };
  };

  // trees by grid
  const TC = 32, TGN = Math.ceil((EXT * 2) / TC);
  const tStart = new Uint32Array(TGN * TGN + 1);
  for (const t of trees) {
    const i = Math.min(TGN - 1, Math.max(0, Math.floor((t.x + EXT) / TC))), j = Math.min(TGN - 1, Math.max(0, Math.floor((t.z + EXT) / TC)));
    tStart[j * TGN + i + 1]++;
  }
  for (let i = 0; i < TGN * TGN; i++) tStart[i + 1] += tStart[i];
  const tItems = new Uint32Array(trees.length);
  {
    const fill = tStart.slice(0, TGN * TGN);
    trees.forEach((t, k) => {
      const i = Math.min(TGN - 1, Math.max(0, Math.floor((t.x + EXT) / TC))), j = Math.min(TGN - 1, Math.max(0, Math.floor((t.z + EXT) / TC)));
      tItems[fill[j * TGN + i]++] = k;
    });
  }
  const treesIn = (minX: number, minZ: number, maxX: number, maxZ: number, outArr: number[] = []): number[] => {
    const i0 = Math.max(0, Math.floor((minX + EXT) / TC)), i1 = Math.min(TGN - 1, Math.floor((maxX + EXT) / TC));
    const j0 = Math.max(0, Math.floor((minZ + EXT) / TC)), j1 = Math.min(TGN - 1, Math.floor((maxZ + EXT) / TC));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * TGN + i;
        for (let q = tStart[cell]; q < tStart[cell + 1]; q++) {
          const k = tItems[q];
          const t = trees[k];
          if (t.x >= minX && t.x <= maxX && t.z >= minZ && t.z <= maxZ) outArr.push(k);
        }
      }
    }
    return outArr;
  };

  // --- places -------------------------------------------------------------------------------
  const pois: Poi[] = L.POI_ORDER.map((id) => {
    const p = L.PLACES[id];
    const y = id === 'lake' || id === 'hut' ? L.LAKE_LEVEL : padY[id] ?? heightAt(p.x, p.z);
    return { id, name: p.name, x: p.x, y, z: p.z, yaw: p.yaw, radius: p.radius };
  });
  const poiMap = new Map<PoiId, Poi>();
  for (const p of pois) poiMap.set(p.id, p);

  let hmin = Infinity, hmax = -Infinity;
  for (let k = 0; k < h.length; k++) {
    const v = h[k];
    if (v < hmin) hmin = v;
    if (v > hmax) hmax = v;
  }

  // --- spawn tables -------------------------------------------------------------------------
  prog(0.95, 'Leaving things behind');
  const spawn = buildSpawn({
    seed, anchors: st.anchors, groundAt, walkable,
    blocked: (x, y, z, r) => {
      colScratch.length = 0;
      cols.near(x, z, r, colScratch);
      for (const c of colScratch) if (y >= c.y0 && y <= c.y1) return true;
      return false;
    },
    forestAt, slopeAt, trailAt: (x, z) => maskAt(3, x, z), onIce: onLake,
    inClearing: (x, z, pad) => clearGrid.has(x, z, pad), trees, path: route.path,
    scar: { ax: scar.ax, az: scar.az, bx: scar.bx, bz: scar.bz },
  });

  const props: PropInst[] = st.props;
  const world: WorldEx = {
    seed,
    size: WORLD_SIZE,
    half: WORLD_HALF,
    heightAt, groundAt, normalAt, slopeAt, snowDepthAt, surfaceAt, forestAt,
    heightmap: { data: h, n: N, extent: EXT, min: hmin, max: hmax },
    masks: { data: masks, n: N, extent: EXT },
    pois,
    poi: (id: PoiId): Poi => poiMap.get(id) as Poi,
    lake, iceAt, iceCell,
    trees, treesIn,
    rocks,
    props,
    floors,
    shelters,
    collidersNear: (x: number, z: number, r: number, outArr: Collider[] = []) => cols.near(x, z, r, outArr),
    shelterAt, lineClear, raycast,
    spawn: { players: spawn.players, defs: spawn.defs as SpawnDef[], packs: spawn.packs as PackDef[], parts: spawn.parts as Record<PartId, { poi: PoiId; x: number; y: number; z: number }> },
    route: route.waypoints,
    walkable,
    anchors: st.anchors,
    trail: route.path,
    safeLine,
    thinIce: lakeB.thin,
    stats: { routeLength: route.length, trees: trees.length, rocks: rocks.length, props: props.length, colliders: colList.length, defs: spawn.defs.length },
  };
  void wrapPi;
  void dlen;
  prog(1, 'Ready');
  return world;
}
