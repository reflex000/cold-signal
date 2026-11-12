// Everything built or dropped on the mountain: the sites from blueprints.ts placed at their
// places, the 200 m skid scar of wreckage leading to the fuselage, trail markers along the
// route (tall poles with flags, every 60 to 90 m, closer across the lake ice), old fence posts
// and trail signs. Returns the props to draw and the colliders, floors, shelters and named
// anchors that come with them (the wall you see is the wall you hit).
import { hash01 } from '../core/rng';
import { blueprint, placeBlueprint, placeSite, SITES, toWorld, type PlacedSolid, type Pose } from './blueprints';
import { dcos, dlen, dsin, PI, TAU } from './dmath';
import * as L from './layout';
import type { Floor, PoiId, PropInst, ShelterVol } from './types';

export interface Circle { x: number; z: number; r: number }

export interface Structures {
  props: PropInst[];
  colliders: PlacedSolid[];
  floors: Floor[];
  shelters: ShelterVol[];
  /** 'poi:part.anchor' (e.g. 'cabin:cabin.stove', 'tower:shed.panel') and 'poi:site.name'. */
  anchors: Record<string, Pose>;
  /** Footprints kept free of trees, rocks and scattered items. */
  clears: Circle[];
}

/** The skid scar: from the fuselage break back along the line the plane came in on. */
export function scarLine(): { ax: number; az: number; bx: number; bz: number; len: number } {
  const p = L.PLACES.wreck;
  const pose: Pose = { x: p.x, y: 0, z: p.z, yaw: p.yaw };
  const a = toWorld(pose, 0, 0, -9.6);
  const len = 200;
  const dx = -dsin(p.yaw), dz = -dcos(p.yaw); // behind the break
  return { ax: a.x, az: a.z, bx: a.x + dx * len, bz: a.z + dz * len, len };
}

/** Site poses (y = pad height, or the ice level for the hut). */
export function sitePoses(padY: Partial<Record<PoiId, number>>): Record<Exclude<PoiId, 'lake'>, Pose> {
  const out = {} as Record<Exclude<PoiId, 'lake'>, Pose>;
  for (const id of ['wreck', 'tail', 'cabin', 'hut', 'cave', 'camp', 'tower'] as const) {
    const p = L.PLACES[id];
    out[id] = { x: p.x, y: id === 'hut' ? L.LAKE_LEVEL : padY[id] ?? 0, z: p.z, yaw: p.yaw };
  }
  return out;
}

export interface StructureInput {
  seed: number;
  heightAt: (x: number, z: number) => number;
  poses: Record<Exclude<PoiId, 'lake'>, Pose>;
  /** Dense route polyline and the index of each stop on it. */
  path: { x: number; z: number }[];
  stopAt: number[];
  /** Route indices where the path is on the ice. */
  onIce: (x: number, z: number) => boolean;
}

/** Old fence lines and other small site dressing, in site-local space: [model, x, z, yaw]. */
const DRESSING: Partial<Record<PoiId, [string, number, number, number][]>> = {
  cabin: [
    ['fence_post', -6.2, -4.5, 0.1], ['fence_post', -6.4, -2.0, -0.05], ['fence_post', -6.3, 0.5, 0.2], ['fence_post', -6.6, 3.0, 0.0],
    ['fence_post', -6.4, 5.5, 0.15], ['fence_post', -5.6, 8.2, 0.4],
  ],
  tower: [
    ['fence_post', -11.5, 9.5, 0.0], ['fence_post', -8.9, 11.2, 0.2], ['fence_post', -6.0, 12.4, -0.1], ['fence_post', 0.5, 12.9, 0.1],
    ['fence_post', 3.4, 12.6, 0.3], ['fence_post', 10.4, 7.5, -0.2],
  ],
  camp: [['barrel', 6.1, -0.8, 0.0]],
};

export function buildStructures(inp: StructureInput): Structures {
  const { seed, heightAt, poses } = inp;
  const props: PropInst[] = [];
  const colliders: PlacedSolid[] = [];
  const floors: Floor[] = [];
  const shelters: ShelterVol[] = [];
  const anchors: Record<string, Pose> = {};
  const clears: Circle[] = [];
  let pid = 0;
  const pseed = () => (hash01(seed, 7001, pid++) * 4294967296) >>> 0;
  const addProp = (model: string, x: number, y: number, z: number, yaw: number, scale: number, poi?: PoiId) => {
    const pr: PropInst = { model, seed: pseed(), x, y, z, yaw, scale };
    if (poi) pr.poi = poi;
    props.push(pr);
    return pr;
  };
  /** A loose prop on the slope: placed on the ground, with the blueprint's colliders and floors. */
  const looseProp = (model: string, x: number, z: number, yaw: number, scale: number, poi?: PoiId, clearR?: number) => {
    const y = heightAt(x, z);
    addProp(model, x, y, z, yaw, scale, poi);
    const bp = blueprint(model);
    if (bp) {
      const pl = placeBlueprint(bp, { x, y, z, yaw }, poi);
      for (const c of pl.colliders) colliders.push(c);
      for (const f of pl.floors) floors.push(f);
      for (const s of pl.shelters) shelters.push(s);
      const c = toWorld({ x, y, z, yaw }, bp.clear.x, 0, bp.clear.z);
      clears.push({ x: c.x, z: c.z, r: bp.clear.r * scale });
    } else if (clearR) clears.push({ x, z, r: clearR });
  };

  // --- the sites
  for (const id of ['wreck', 'tail', 'cabin', 'hut', 'cave', 'camp', 'tower'] as const) {
    const site = SITES[id];
    const pose = poses[id];
    const pl = placeSite(site, pose);
    for (const part of pl.parts) {
      addProp(part.model, part.pose.x, pose.y, part.pose.z, part.pose.yaw, 1, id);
      const bp = blueprint(part.model);
      if (bp) {
        const c = toWorld(part.pose, bp.clear.x, 0, bp.clear.z);
        clears.push({ x: c.x, z: c.z, r: bp.clear.r });
      }
    }
    for (const c of pl.colliders) colliders.push(c);
    for (const f of pl.floors) floors.push(f);
    for (const s of pl.shelters) shelters.push(s);
    for (const k in pl.anchors) anchors[id + ':' + k] = pl.anchors[k];
    // dressing
    for (const d of DRESSING[id] ?? []) {
      const w = toWorld(pose, d[1], 0, d[2], d[3]);
      looseProp(d[0], w.x, w.z, w.yaw, 1, id, 0.6);
    }
    // the trail sign
    const sign = site.anchors.sign;
    if (sign) {
      const w = toWorld(pose, sign.x, 0, sign.z, sign.yaw);
      looseProp('sign_post', w.x, w.z, w.yaw, 1, id, 0.8);
    }
  }
  // the barrel fire at the wreck
  {
    const b = anchors['wreck:site.barrel'];
    looseProp('barrel', b.x, b.z, 0.4, 1, 'wreck');
  }

  // --- the skid scar: wreckage strewn from the touchdown point to the fuselage
  {
    const s = scarLine();
    const ux = (s.bx - s.ax) / s.len, uz = (s.bz - s.az) / s.len; // from the break toward the touchdown
    const px = -uz, pz = ux; // across
    const along = (t: number, off: number) => ({ x: s.ax + ux * t + px * off, z: s.az + uz * t + pz * off });
    const yawAlong = L.PLACES.wreck.yaw; // the fuselage's heading
    const r = (k: number) => hash01(seed, 7100, k);
    // the torn-off wing and an engine: big pieces, off to the sides
    {
      const p = along(112, 13.5);
      looseProp('wing', p.x, p.z, yawAlong + PI / 2 + 0.35, 1, 'wreck');
    }
    {
      const p = along(158, -9.5);
      looseProp('engine_nacelle', p.x, p.z, yawAlong + 0.6, 1, 'wreck');
    }
    {
      const p = along(64, -7.2);
      looseProp('engine_nacelle', p.x, p.z, yawAlong - 2.2, 0.92, 'wreck');
    }
    // seat rows
    const seatT = [24, 41, 57, 79, 96, 131];
    seatT.forEach((t, k) => {
      const off = (r(k) - 0.5) * 16;
      const p = along(t, off);
      looseProp('seat_row', p.x, p.z, r(k + 20) * TAU, 1, 'wreck');
    });
    // panels and luggage all along it, denser near the fuselage
    for (let k = 0; k < 30; k++) {
      const t = 6 + Math.sqrt(r(100 + k)) * 192;
      const off = (r(140 + k) - 0.5) * (8 + t * 0.07);
      const p = along(t, off);
      looseProp('debris_panel', p.x, p.z, r(180 + k) * TAU, 0.6 + 0.8 * r(220 + k), 'wreck', 1.2);
    }
    for (let k = 0; k < 11; k++) {
      const t = 4 + r(300 + k) * 150;
      const off = (r(330 + k) - 0.5) * 18;
      const p = along(t, off);
      looseProp('luggage', p.x, p.z, r(360 + k) * TAU, 0.85 + 0.3 * r(390 + k), 'wreck', 0.7);
    }
    // the touchdown gouge has no prop: the forest mask and snow show it
  }

  // --- trail markers along the route
  {
    const { path, stopAt } = inp;
    const stopSet = stopAt.map((i) => path[i]);
    let next = 40;
    let acc = 0;
    let side = 1;
    let k = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const seg = dlen(b.x - a.x, b.z - a.z);
      acc += seg;
      const ice = inp.onIce(b.x, b.z);
      if (acc < next) continue;
      // keep clear of the sites themselves
      let near = false;
      for (const s of stopSet) if (dlen(s.x - b.x, s.z - b.z) < (ice ? 6 : 22)) near = true;
      if (near) {
        next = acc + 6;
        continue;
      }
      const dx = (b.x - a.x) / seg, dz = (b.z - a.z) / seg;
      const off = ice ? 0.9 : 1.8;
      const x = b.x - dz * off * side, z = b.z + dx * off * side;
      looseProp('trail_marker', x, z, hash01(seed, 7400, k) * TAU, 1, undefined, 0.8);
      k++;
      side = -side;
      next = acc + (ice ? 16 : 60 + 30 * hash01(seed, 7500, k));
    }
  }

  return { props, colliders, floors, shelters, anchors, clears };
}
