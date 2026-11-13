// The entity things nobody else draws: pickups, crates, dead wood, heavy logs and notes, each with
// its KIT model and the shared prop material (snow settles on them like on every prop): one
// InstancedMesh per (model, variant), plus one per hinged part (crate lids open when looted),
// rewritten every frame from view.list(kind) (no allocation). (POLISH: these were coloured boxes.)
// Models: src/models/props (luggage, crate, toolbox, log_heavy, pickups.ts, deadwood.ts) and the
// first-person extras of src/models/tools/extras.ts (matchbox, cartridge, cell, ration, ...).
// Plain shapes remain only as fallbacks for kinds that others take over at run time by wrapping
// update() with a filtered view (keep `update` a plain assignable property): FX hides fires and
// flares (and lights them from its own pool), FIGURES hides players and wolves, VIEWMODEL hides
// the tool pickups. STRUCTURES draws the door, panel, generator, bed and beacon devices and the
// locker and cupboard crates as parts of its buildings, so they are skipped here.
// No lights: an idle point light costs every lit pixel (fires and flares are FX's pool).
// Owner: GAME (models: POLISH).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../../gfx/shared';
import type { Frame, GfxSystem } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import type { CrateEnt, DeviceEnt, FireEnt, ItemId, LogEnt, PickupEnt, PlayerEnt, WoodEnt } from '../../sim/types';
import type { ViewEnt } from '../view';
import type { ModelDef } from '../../models/kit';
import { getModel, hasModel, modelMeta } from '../../models/registry';
import { getPropMaterial } from '../../models/material';
import { getExtra, type ExtraName } from '../../models/tools/extras';
import '../../models/props';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type RGB = [number, number, number];
const PARKA: RGB[] = [[0.5, 0.12, 0.05], [0.07, 0.14, 0.36], [0.2, 0.24, 0.09], [0.55, 0.34, 0.05]];

const ITEM_LOOK: Partial<Record<ItemId, { s: [number, number, number]; c: RGB }>> = {
  stick: { s: [0.55, 0.05, 0.06], c: [0.17, 0.11, 0.06] },
  log: { s: [0.42, 0.14, 0.14], c: [0.22, 0.15, 0.09] },
  tinder: { s: [0.18, 0.06, 0.14], c: [0.5, 0.42, 0.28] },
  matches: { s: [0.1, 0.03, 0.06], c: [0.55, 0.12, 0.06] },
  flare: { s: [0.05, 0.05, 0.2], c: [0.6, 0.08, 0.04] },
  ammo: { s: [0.1, 0.05, 0.07], c: [0.35, 0.28, 0.12] },
  cell: { s: [0.06, 0.06, 0.12], c: [0.12, 0.12, 0.14] },
  bandage: { s: [0.12, 0.06, 0.12], c: [0.75, 0.74, 0.7] },
  ration: { s: [0.16, 0.05, 0.1], c: [0.3, 0.32, 0.18] },
  thermos: { s: [0.08, 0.26, 0.08], c: [0.12, 0.2, 0.3] },
  axe: { s: [0.12, 0.06, 0.7], c: [0.35, 0.08, 0.05] },
  flashlight: { s: [0.06, 0.06, 0.26], c: [0.2, 0.2, 0.22] },
  flaregun: { s: [0.08, 0.16, 0.24], c: [0.65, 0.22, 0.04] },
  rifle: { s: [0.08, 0.1, 1.05], c: [0.2, 0.13, 0.08] },
  radio: { s: [0.16, 0.22, 0.08], c: [0.18, 0.2, 0.16] },
};

const CRATE_LOOK: Record<CrateEnt['type'], { s: [number, number, number]; c: RGB }> = {
  luggage: { s: [0.7, 0.28, 0.48], c: [0.1, 0.13, 0.22] },
  locker: { s: [0.5, 1.8, 0.5], c: [0.33, 0.35, 0.37] },
  crate: { s: [0.8, 0.6, 0.6], c: [0.3, 0.21, 0.12] },
  medkit: { s: [0.42, 0.26, 0.16], c: [0.7, 0.68, 0.64] },
  cupboard: { s: [0.8, 1.6, 0.42], c: [0.22, 0.15, 0.1] },
  toolbox: { s: [0.52, 0.26, 0.24], c: [0.52, 0.1, 0.05] },
};

/** Devices STRUCTURES draws as parts of its buildings (the driver moves the door, crank, lamps). */
const BUILT_IN_DEVICES: ReadonlySet<DeviceEnt['type']> = new Set(['door', 'panel', 'generator', 'bed', 'beacon']);
/** Crates that are furniture of STRUCTURES' buildings (the driver swings their doors). */
const BUILT_IN_CRATES: ReadonlySet<CrateEnt['type']> = new Set(['locker', 'cupboard']);

const DEVICE_LOOK: Partial<Record<DeviceEnt['type'], { s: [number, number, number]; y: number; c: RGB }>> = {
  note: { s: [0.22, 0.01, 0.3], y: 0.02, c: [0.75, 0.72, 0.62] },
};

// ---- real models -------------------------------------------------------------------------------

/**
 * How a pickup is drawn: a registered model (its variant picked by the entity id), or one of the
 * first-person extras laid down (`lay: 'x'` turns its long +Y axis along X), up to three side by
 * side when the stack holds several (`many`).
 */
interface Look { model?: string; extra?: ExtraName; lay?: 'x'; many?: boolean }
const PICKUP_MODEL: Partial<Record<ItemId, Look>> = {
  stick: { model: 'pickup_sticks' },
  log: { model: 'pickup_logs' },
  tinder: { model: 'pickup_tinder' },
  ammo: { model: 'pickup_ammo' },
  matches: { extra: 'matchbox', many: true },
  flare: { extra: 'cartridge', lay: 'x', many: true },
  cell: { extra: 'cell', lay: 'x', many: true },
  ration: { extra: 'ration', lay: 'x', many: true },
  thermos: { extra: 'thermos', lay: 'x' },
  bandage: { extra: 'bandage', many: true },
  part_battery: { model: 'part_battery' },
  part_handset: { model: 'part_handset' },
  part_coil: { model: 'part_coil' },
  part_tube: { model: 'part_tube' },
  part_fuse: { model: 'part_fuse' },
};
const CRATE_MODEL: Partial<Record<CrateEnt['type'], string>> = { luggage: 'luggage', crate: 'crate', toolbox: 'toolbox', medkit: 'pickup_medkit' };
const WOOD_MODEL: Record<WoodEnt['type'], string> = { snag: 'snag', deadfall: 'deadfall', stump: 'stump', branchpile: 'branchpile' };
/** Kinds drawn with fewer variants than they are built with (see modelBatch). */
const FOLD: Record<string, number> = { pickup_sticks: 2, deadfall: 2, pickup_logs: 2, luggage: 3 };
/** Open instances a batch can show at once (looted crates in view). */
const OPEN_CAP = 6;

/**
 * One (model, variant). Closed (and part-less) instances draw as ONE mesh, the hinged parts merged
 * in at rest; only the few that stand open (a looted crate) draw the body and each part on its own,
 * so a lid costs a draw (and its shadow draws) only while some crate of that kind is open.
 */
interface Batch {
  mesh: THREE.InstancedMesh;
  n: number;
  /** Open instances: the body without its parts, and one mesh per hinged part. */
  body: THREE.InstancedMesh | null;
  parts: { mesh: THREE.InstancedMesh; pivot: THREE.Vector3; axis: THREE.Vector3; angle: number }[];
  nOpen: number;
  /** Whether `mesh` holds the parts merged at rest (else closed instances go the open way too). */
  merged: boolean;
  /** Lays the model down and rests it on y = 0 (identity for registered models). */
  base: THREE.Matrix4;
  /** Height above the ground once laid down (how far 'snow' sinks it). */
  height: number;
}

interface Pool {
  mesh: THREE.InstancedMesh;
  arr: Float32Array;
  col: Float32Array;
  n: number;
}

function pool(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, shadow = true): Pool {
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = name;
  mesh.castShadow = shadow;
  mesh.receiveShadow = shadow;
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  return { mesh, arr: mesh.instanceMatrix.array as Float32Array, col: mesh.instanceColor!.array as Float32Array, n: 0 };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Instance with translation, Euler rotation (YXZ: yaw, pitch, roll) and scale. */
function add(pl: Pool, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number, c: RGB, k = 1): void {
  if (pl.n >= pl.mesh.instanceMatrix.count) return;
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  _m.toArray(pl.arr, pl.n * 16);
  pl.col[pl.n * 3] = c[0] * k;
  pl.col[pl.n * 3 + 1] = c[1] * k;
  pl.col[pl.n * 3 + 2] = c[2] * k;
  pl.n++;
}

function done(pl: Pool): void {
  pl.mesh.count = pl.n;
  pl.mesh.instanceMatrix.needsUpdate = true;
  if (pl.mesh.instanceColor) pl.mesh.instanceColor.needsUpdate = true;
}

/** Three crossed vertical cards, 1 wide and 1 tall, standing on y = 0 (uv: x across, y up). */
function flameGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) parts.push(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY((i * Math.PI) / 3));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const g of parts) {
    const b = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    uv.push(...(g.getAttribute('uv').array as Float32Array));
    const ia = g.index!.array;
    for (let k = 0; k < ia.length; k++) idx.push(b + ia[k]);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * A soft flame (stand-in until gfx/fx): additive, white-hot at the root, orange and thin toward a
 * licking tip, flickering; the instance colour carries the fire colour times its strength.
 */
function flameMaterial(): THREE.MeshBasicNodeMaterial {
  const { uv, float, smoothstep, sin, abs, mix, vec3, vec4, exp, length, positionWorld, instanceIndex } = TSL as any;
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'standin-flame';
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  m.side = THREE.DoubleSide;
  // Additive light is dimmed by the air in front of it, never mixed toward the fog colour (that
  // would paint a grey card into the storm): attenuate by the fog's transmittance instead.
  m.fog = false;
  const t = U.time;
  const p = uv();
  const v = p.y;
  const ph = positionWorld.x.mul(3.1).add(positionWorld.z.mul(1.7)).add(float(instanceIndex).mul(1.3));
  // the tongue sways and wavers more toward the tip
  const sway = sin(t.mul(9.0).add(v.mul(5.0)).add(ph)).mul(0.07).add(sin(t.mul(15.0).sub(v.mul(9.0)).add(ph.mul(1.7))).mul(0.04)).mul(v);
  const u = abs(p.x.sub(0.5).sub(sway)).mul(2);
  const width = float(1).sub(v).pow(0.75).mul(0.85).add(0.06);
  const body = smoothstep(width, width.mul(0.3), u);
  const fade = smoothstep(0.0, 0.08, v).mul(smoothstep(1.0, 0.45, v.add(sin(t.mul(11.0).add(ph)).mul(0.06))));
  const core = smoothstep(0.55, 0.0, v).mul(smoothstep(width.mul(0.55), 0.0, u));
  const col = mix(vec3(0.55, 0.16, 0.04), vec3(1.0, 0.82, 0.55), core);
  const seen = exp(U.fogDensity.mul(length(positionWorld.sub(U.camPos))).negate());
  m.colorNode = vec4(col.mul(body.mul(fade)).mul(seen).mul(0.6), 1);
  return m;
}

export function createStandinMarkers(engine: CsEngine): GfxSystem {
  const scene = engine.scene;
  const group = new THREE.Group();
  group.name = 'standin-markers';
  const lit = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 });
  const glow = new THREE.MeshBasicNodeMaterial();
  glow.fog = true;

  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8).rotateZ(Math.PI / 2); // along X
  const unitPost = new THREE.CylinderGeometry(1, 1, 1, 7).translate(0, 0.5, 0);
  const capsule = new THREE.CapsuleGeometry(0.5, 1, 4, 10).translate(0, 1, 0); // 2 tall
  const sphere = new THREE.IcosahedronGeometry(1, 1);
  const flame = flameGeometry();
  const stone = new THREE.IcosahedronGeometry(1, 0);

  const boxes = pool(unitBox, lit, 600, 'standin-boxes');
  const cyls = pool(unitCyl, lit, 400, 'standin-logs');
  // items on the ground cast no shadow: at a low sun every stick would draw a long dark line
  const items = pool(unitBox, lit, 800, 'standin-items', false);
  const sticks = pool(unitCyl, lit, 900, 'standin-sticks', false);
  const posts = pool(unitPost, lit, 600, 'standin-posts');
  const bodies = pool(capsule, lit, 64, 'standin-bodies');
  const heads = pool(sphere, lit, 64, 'standin-heads');
  const stones = pool(stone, lit, 400, 'standin-stones');
  const flameMat = flameMaterial();
  const flames = pool(flame, flameMat, 64, 'standin-flames', false);
  const sparks = pool(sphere, glow, 64, 'standin-glow', false);
  const all = [boxes, cyls, items, sticks, posts, bodies, heads, stones, flames, sparks];
  for (const p of all) group.add(p.mesh);
  scene.add(group);

  // ---- real models: one batch per (model, variant) ----
  const propMat = getPropMaterial();
  const batches = new Map<string, Batch>();
  const batchList: Batch[] = [];
  /** Geometries this system made (the merged closed models): the registry owns the rest. */
  const ownGeo: THREE.BufferGeometry[] = [];
  const _box = new THREE.Box3();
  const _rz = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  function makeBatch(def: ModelDef, cap: number, shadow: boolean, lay: 'x' | undefined, name: string): Batch {
    const base = new THREE.Matrix4();
    _box.copy(def.bounds);
    if (lay === 'x') {
      base.copy(_rz);
      _box.applyMatrix4(_rz);
    }
    // extras are centred on their origin: rest them on the ground (registered models already are)
    const lift = -_box.min.y;
    base.premultiply(new THREE.Matrix4().makeTranslation(0, lift, 0));
    const inst = (geo: THREE.BufferGeometry, n: number, label: string): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(geo, propMat, n);
      m.name = 'markers-' + label;
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = shadow;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };
    const withParts = Object.values(def.parts).filter((p) => p.geometry);
    const closed: THREE.BufferGeometry[] = [def.geometry!];
    for (const p of withParts) closed.push(p.geometry!.clone().translate(p.pivot.x, p.pivot.y, p.pivot.z));
    // the closed model, parts merged at rest: one draw (if the layouts ever disagree, every
    // instance goes the open way instead, body and parts, and nothing is lost)
    const merged = withParts.length ? mergeGeometries(closed, false) : null;
    for (let i = 1; i < closed.length; i++) closed[i].dispose();
    const openCap = merged ? OPEN_CAP : cap;
    const parts: Batch['parts'] = withParts.map((p) => ({ mesh: inst(p.geometry!, openCap, name + '-' + p.name), pivot: p.pivot.clone(), axis: p.axis.clone(), angle: p.openAngle }));
    const mesh = inst(merged ?? def.geometry!, cap, name);
    const body = withParts.length ? inst(def.geometry!, openCap, name + '-open') : null;
    const b: Batch = { mesh, n: 0, body, parts, nOpen: 0, base, height: _box.max.y - _box.min.y, merged: !!merged };
    if (merged) ownGeo.push(merged);
    batchList.push(b);
    return b;
  }
  /** The batch of a registered model's variant for `seed` (built on first use). */
  function modelBatch(name: string, seed: number, cap: number, shadow: boolean): Batch | null {
    if (!hasModel(name)) return null;
    // a few small kinds draw fewer variants than they have: every variant in view is a draw (and
    // three shadow draws), and two kinds of dropped sticks or deadfall read as well as four
    const vmax = Math.min(Math.max(1, modelMeta(name).variants), FOLD[name] ?? 99);
    const v = Math.abs(Math.floor(seed)) % vmax;
    const key = name + '#' + v;
    let b = batches.get(key);
    if (!b) {
      const def = getModel(name, v);
      if (!def.geometry) return null;
      b = makeBatch(def, cap, shadow, undefined, key);
      batches.set(key, b);
    }
    return b;
  }
  function extraBatch(name: ExtraName, lay: 'x' | undefined, cap: number): Batch | null {
    const key = 'extra:' + name;
    let b = batches.get(key);
    if (!b) {
      const def = getExtra(name);
      if (!def.geometry) return null;
      b = makeBatch(def, cap, false, lay, key);
      batches.set(key, b);
    }
    return b;
  }
  const _q2 = new THREE.Quaternion();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _inst = new THREE.Matrix4();
  const _pm = new THREE.Matrix4();
  const _pr = new THREE.Matrix4();
  /** One instance: world position, yaw, scale (x, y, z), lid opening 0..1. */
  function put(b: Batch, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, open = 0): void {
    _q2.setFromAxisAngle(_yAxis, yaw);
    _inst.compose(_p.set(x, y, z), _q2, _s.set(sx, sy, sz)).multiply(b.base);
    if (!b.body || (open <= 0 && b.merged)) {
      if (b.n >= b.mesh.instanceMatrix.count) return;
      b.mesh.setMatrixAt(b.n++, _inst);
      return;
    }
    if (b.nOpen >= b.body.instanceMatrix.count) return;
    b.body.setMatrixAt(b.nOpen, _inst);
    for (const part of b.parts) {
      // the part's geometry is relative to its pivot: place the pivot, then swing about the hinge
      _pm.makeTranslation(part.pivot.x, part.pivot.y, part.pivot.z);
      if (part.angle !== 0) _pm.multiply(_pr.makeRotationAxis(part.axis, part.angle * open));
      _pm.premultiply(_inst);
      part.mesh.setMatrixAt(b.nOpen, _pm);
    }
    b.nOpen++;
  }
  /** Small stable per-entity number for variants. */
  const vseed = (id: number): number => (id * 2654435761) >>> 0;

  // Build the batches the world will certainly need now, under the loading screen, so the first
  // sight of a snag or a suitcase does not stall a frame (the rare ones build on first use).
  for (let v = 0; v < 4; v++) {
    modelBatch('pickup_sticks', v, 160, false);
    modelBatch('snag', v, 48, true);
    modelBatch('deadfall', v, 48, true);
    modelBatch('luggage', v, 16, false);
    modelBatch('log_heavy', v, 12, true);
  }

  const FIRE: RGB = [1.0, 0.42, 0.12];
  const FLARE: RGB = [1.0, 0.12, 0.06];

  return {
    name: 'markers',
    update(f: Frame): void {
      const view = f.view;
      const t = f.time;
      for (const p of all) p.n = 0;
      for (const b of batchList) {
        b.n = 0;
        b.nOpen = 0;
      }
      // small things are not drawn far away (sub-pixel specks): metres, squared
      const cx = view.camera.x, cz = view.camera.z;
      const beyond = (e: { x: number; z: number }, r: number) => (e.x - cx) * (e.x - cx) + (e.z - cz) * (e.z - cz) > r * r;
      const tn = engine.quality.treeNear;
      const snagFar = Math.min(400, tn * 5), woodFar = Math.min(200, tn * 3);

      for (const e of view.list('pickup') as ViewEnt<PickupEnt>[]) {
        if (beyond(e, e.item.startsWith('part_') ? 200 : 110)) continue;
        const look = PICKUP_MODEL[e.item];
        const b = look?.model ? modelBatch(look.model, vseed(e.id), look.model === 'pickup_sticks' ? 160 : 48, false) : look?.extra ? extraBatch(look.extra, look.lay, 48) : null;
        if (b) {
          // half sunk where it lies in the snow
          const sink = e.lie === 'snow' ? b.height * 0.45 : 0;
          const n = look?.many ? Math.min(3, Math.max(1, e.n)) : 1;
          for (let i = 0; i < n; i++) {
            const off = (i - (n - 1) / 2) * 0.07;
            put(b, e.x + Math.cos(e.yaw) * off, e.y - sink, e.z - Math.sin(e.yaw) * off, e.yaw + i * 0.4, 1, 1, 1);
          }
          continue;
        }
        const fb = ITEM_LOOK[e.item] ?? { s: [0.16, 0.16, 0.16] as [number, number, number], c: [0.4, 0.4, 0.4] as RGB };
        add(items, e.x, e.y - (e.lie === 'snow' ? fb.s[1] * 0.5 : 0), e.z, e.yaw, 0, 0, fb.s[0], fb.s[1], fb.s[2], fb.c);
      }
      for (const e of view.list('crate') as ViewEnt<CrateEnt>[]) {
        if (BUILT_IN_CRATES.has(e.type) || beyond(e, 250)) continue;
        const name = CRATE_MODEL[e.type];
        const b = name ? modelBatch(name, vseed(e.id), 16, e.type === 'crate') : null;
        if (b) {
          put(b, e.x, e.y, e.z, e.yaw, 1, 1, 1, e.open ? 1 : 0);
          continue;
        }
        const look = CRATE_LOOK[e.type] ?? CRATE_LOOK.crate;
        add(boxes, e.x, e.y, e.z, e.yaw, 0, 0, look.s[0], look.s[1], look.s[2], look.c, e.open ? 0.55 : 1);
      }
      for (const e of view.list('wood') as ViewEnt<WoodEnt>[]) {
        // (draw range from the tier: a phone draws the forest itself only to ~36 m)
        if (beyond(e, e.type === 'snag' ? snagFar : woodFar)) continue;
        const s = e.scale || 1;
        const b = modelBatch(WOOD_MODEL[e.type], e.seed ?? vseed(e.id), 48, true);
        if (b) {
          // snags and stumps stand a little into the snow; deadfall lies in it (the model is sunk already)
          put(b, e.x, e.y - (e.type === 'snag' ? 0.12 : e.type === 'stump' ? 0.05 : 0), e.z, e.yaw, s, s, s);
          continue;
        }
        if (e.type === 'snag') add(posts, e.x, e.y - 0.2, e.z, e.yaw, 0, 0, 0.17 * s, 7 * s, 0.17 * s, [0.21, 0.2, 0.19]);
        else if (e.type === 'stump') add(posts, e.x, e.y - 0.05, e.z, e.yaw, 0, 0, 0.28 * s, 0.5 * s, 0.28 * s, [0.2, 0.15, 0.1]);
        else if (e.type === 'deadfall') add(cyls, e.x, e.y + 0.18 * s, e.z, e.yaw, 0, 0.06, 2.6 * s, 0.2 * s, 0.2 * s, [0.19, 0.17, 0.15]);
        else add(boxes, e.x, e.y - 0.1, e.z, e.yaw, 0, 0, 1.4 * s, 0.55 * s, 1.0 * s, [0.12, 0.1, 0.08]);
      }
      for (const e of view.list('log') as ViewEnt<LogEnt>[]) {
        if (beyond(e, 250)) continue;
        const b = modelBatch('log_heavy', vseed(e.id), 12, true);
        // the model is a 2.4 m log along Z, standing on y = 0
        if (b) put(b, e.x, e.y, e.z, e.yaw, 1, 1, Math.max(1, e.len) / 2.4);
        else add(cyls, e.x, e.y + 0.22, e.z, e.yaw + Math.PI / 2, 0, 0, Math.max(1, e.len), 0.22, 0.22, [0.23, 0.17, 0.11]);
      }
      for (const e of view.list('device') as ViewEnt<DeviceEnt>[]) {
        if (BUILT_IN_DEVICES.has(e.type) || beyond(e, 250)) continue;
        const nb = e.type === 'note' ? modelBatch('note', 0, 16, false) : null;
        if (nb) {
          put(nb, e.x, e.y, e.z, e.yaw, 1, 1, 1);
          continue;
        }
        const look = DEVICE_LOOK[e.type];
        if (!look) continue;
        add(boxes, e.x, e.y + look.y, e.z, e.yaw, 0, 0, look.s[0], look.s[1], look.s[2], look.c);
      }
      for (const e of view.list('fire') as ViewEnt<FireEnt>[]) {
        if (e.type === 'campfire') {
          // a ring of stones and a few crossed sticks
          for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2 + e.id;
            add(stones, e.x + Math.sin(a) * 0.48, e.y + 0.04, e.z + Math.cos(a) * 0.48, a, 0.3, 0, 0.13, 0.09, 0.11, [0.09, 0.088, 0.085]);
          }
          const sz = 0.3 + 0.6 * e.size;
          for (let i = 0; i < 3; i++) add(sticks, e.x, e.y + 0.08, e.z, (i / 3) * Math.PI + e.id, 0, 0.35, 0.32 * sz, 0.04, 0.04, e.lit ? [0.06, 0.04, 0.03] : [0.2, 0.14, 0.08]);
        }
        const heat = e.lit ? Math.max(0.15, e.heat) : e.embers > 0 ? 0.08 : 0;
        if (heat <= 0) continue;
        const fl = 0.85 + 0.15 * Math.sin(t * 13 + e.id) * Math.sin(t * 7.3 + e.id * 2);
        const base = e.type === 'barrel' ? 0.95 : e.type === 'stove' ? 0.25 : 0.05;
        if (e.lit) {
          const h = (e.type === 'stove' ? 0.25 : 0.55) * (0.5 + heat) * fl;
          add(flames, e.x, e.y + base, e.z, t * 0.7, 0, 0, 0.5 * (0.6 + heat * 0.6), h * 1.15, 0.5 * (0.6 + heat * 0.6), FIRE, 10 * heat);
          add(flames, e.x, e.y + base, e.z, -t * 1.3, 0, 0, 0.26, h * 1.45, 0.26, [1, 0.62, 0.25], 12 * heat);
        } else add(sparks, e.x, e.y + base + 0.03, e.z, 0, 0, 0, 0.18, 0.04, 0.18, FIRE, 3);
      }
      for (const e of view.list('flare')) {
        const burning = e.life > 0;
        const fl = 0.8 + 0.2 * Math.sin(t * 23 + e.id);
        add(sparks, e.x, e.y + 0.05, e.z, 0, 0, 0, 0.07, 0.07, 0.07, FLARE, burning ? 60 * fl : 0.5);
      }
      const third = view.camera.third > 0.3;
      for (const e of view.list('player') as ViewEnt<PlayerEnt>[]) {
        if (e.id === view.myId && !third) continue;
        const c = PARKA[e.slot % PARKA.length];
        const down = e.life === 'downed' || e.life === 'dead';
        const h = down ? 0.35 : e.crouch ? 0.62 : 0.86;
        if (down) {
          add(bodies, e.x, e.y + 0.25, e.z, e.yaw, Math.PI / 2, 0, 0.55, 0.85, 0.5, c);
          continue;
        }
        add(bodies, e.x, e.y, e.z, e.yaw, 0, 0, 0.62, h, 0.5, c);
        add(heads, e.x - Math.sin(e.yaw) * 0.04, e.y + h * 2 - 0.02, e.z - Math.cos(e.yaw) * 0.04, e.yaw, 0, 0, 0.15, 0.17, 0.15, [0.08, 0.075, 0.07]);
      }
      for (const e of view.list('wolf')) {
        if (e.mood === 'dead') {
          add(bodies, e.x, e.y + 0.18, e.z, e.yaw, Math.PI / 2, Math.PI / 2, 0.42, 0.55, 0.42, [0.22, 0.21, 0.2]);
          continue;
        }
        const c: RGB = e.alpha ? [0.2, 0.19, 0.18] : [0.3, 0.29, 0.27];
        // body along the facing (yaw 0 faces north like a player): the capsule starts at the chest
        // and runs back; legs as posts
        add(bodies, e.x - Math.sin(e.yaw) * 0.55, e.y + 0.42, e.z - Math.cos(e.yaw) * 0.55, e.yaw, Math.PI / 2, 0, 0.42, 0.55, 0.4, c);
        add(heads, e.x - Math.sin(e.yaw) * 0.72, e.y + 0.78, e.z - Math.cos(e.yaw) * 0.72, e.yaw, 0, 0, 0.15, 0.14, 0.22, c);
        for (const [fx, fz] of [[0.14, 0.42], [-0.14, 0.42], [0.14, -0.42], [-0.14, -0.42]]) {
          const s = Math.sin(e.yaw), co = Math.cos(e.yaw);
          add(posts, e.x + co * fx + s * -fz, e.y, e.z - s * fx + co * -fz, 0, 0, 0, 0.045, 0.5, 0.045, c);
        }
      }
      for (const p of all) done(p);
      for (const b of batchList) {
        const n = b.n, no = b.nOpen;
        b.mesh.count = n;
        b.mesh.visible = n > 0;
        if (n > 0) b.mesh.instanceMatrix.needsUpdate = true;
        if (!b.body) continue;
        b.body.count = no;
        b.body.visible = no > 0;
        if (no > 0) b.body.instanceMatrix.needsUpdate = true;
        for (const part of b.parts) {
          part.mesh.count = no;
          part.mesh.visible = no > 0;
          if (no > 0) part.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    dispose(): void {
      scene.remove(group);
      for (const g of [unitBox, unitCyl, unitPost, capsule, sphere, flame, stone]) g.dispose();
      flameMat.dispose();
      lit.dispose();
      glow.dispose();
      // the model geometries belong to the registry's cache: only the instance buffers go
      for (const b of batchList) {
        b.mesh.dispose();
        b.body?.dispose();
        for (const part of b.parts) part.mesh.dispose();
      }
      for (const g of ownGeo) g.dispose();
    },
  };
}
