// THE PROPS SYSTEM: draws a list of placed models (PropInst, src/world/types.ts) with as few draw
// calls as possible, and answers "where in the world is that prop's emitter / anchor / part".
//
//   const props = createPropsSystem({ scene, camera }, world.props);
//   engine.add(props);                                  // a GfxSystem named 'props'
//   for (const e of props.emitters('fire')) ...         // world-space position, dir, size
//   props.anchor(id, 'top', v)                          // world-space anchor of prop number `id`
//   props.part(id, 'lid')!.rotation.x = -1.1            // a named part is a real Object3D
//
// BATCHING. Props are grouped by (model, variant, opts) and by a square world chunk (64 m by
// default); each group is ONE InstancedMesh with the shared prop material (plus one more for its
// glass, if the model has any). three culls each batch against the view and shadow frusta by its
// bounding sphere; update() also hides batches beyond the model's draw distance (by size class,
// scaled by the quality preset). Named parts (doors, lids) are ordinary meshes, one per placed
// prop, because the game moves them one by one.
//
// A prop's id is its index in the list passed in; add() returns the next free id. Placement is
// `position + Ry(yaw) * scale * local`, the same convention as src/world/blueprints.ts.
//
// This module does not import the engine: it takes the scene (any Object3D to attach to) and the
// camera as arguments.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem, Quality } from '../gfx/api';
import type { PropInst } from '../world/types';
import type { Emitter, EmitterType, LightDef, ModelDef } from './kit';
import { getGlassMaterial, getPropMaterial } from './material';
import { getModel, modelKey, modelMeta, type ModelOpts } from './registry';

export interface PropsHost {
  /** Where the batches are attached (the scene, or a group at identity). */
  scene: THREE.Object3D;
  /** The camera distance culling is measured from. */
  camera: THREE.Camera;
}

export interface PropsOptions {
  /** Chunk edge in metres for culling. Default 64. */
  chunk?: number;
  /** Per-prop model options (e.g. { stage: 2 } for a campfire). Called once per prop. */
  opts?: (inst: PropInst, id: number) => ModelOpts | undefined;
  /** Cast and receive sun shadows. Default true. */
  shadows?: boolean;
  /** Override the shared materials (tests, indoor sets). */
  material?: THREE.Material;
  glassMaterial?: THREE.Material;
}

/** An emitter of a placed prop, in world space. */
export interface PlacedEmitter {
  /** Id of the prop it belongs to. */
  prop: number;
  model: string;
  type: EmitterType;
  name?: string;
  position: THREE.Vector3;
  /** Unit direction the effect leaves in. */
  dir: THREE.Vector3;
  /** Source radius in metres (scaled with the prop). */
  size: number;
  /** The model-space definition, with whatever extra fields the model declared. */
  def: Emitter;
}

/** A lamp of a placed prop, in world space. */
export interface PlacedLight {
  prop: number;
  model: string;
  name?: string;
  position: THREE.Vector3;
  def: LightDef;
}

export interface PropsSystem extends GfxSystem {
  readonly name: 'props';
  /** Parent of everything this system draws. */
  readonly root: THREE.Group;
  /** Number of ids handed out (removed props keep their id; see has()). */
  readonly count: number;
  has(id: number): boolean;
  inst(id: number): PropInst | undefined;
  /** The built model of a placed prop (geometry, anchors, bounds ...). */
  model(id: number): ModelDef | undefined;
  /** Model-to-world matrix of a placed prop. */
  matrix(id: number, out?: THREE.Matrix4): THREE.Matrix4 | null;
  /** World-space position of a named anchor of a placed prop, or null if it has none by that name. */
  anchor(id: number, name: string, out?: THREE.Vector3): THREE.Vector3 | null;
  /** World yaw of a named anchor (prop yaw + anchor yaw), or 0. */
  anchorYaw(id: number, name: string): number;
  /** Every emitter of every placed prop, optionally of one type. Stable until props are added, moved or removed. */
  emitters(type?: EmitterType): readonly PlacedEmitter[];
  emittersOf(id: number): readonly PlacedEmitter[];
  lights(): readonly PlacedLight[];
  /** The pivot object of a named part: rotate or move it; its rest pose is the identity rotation. */
  part(id: number, name: string): THREE.Object3D | null;
  /** Swing every hinged part of a prop (lid, door) to fraction t of its open angle: 0 shut, 1 fully open. */
  setOpen(id: number, t: number): void;
  /** Ids of props whose origin lies within r of (x, z). */
  near(x: number, z: number, r: number, out?: number[]): number[];
  /** Ids of every placed prop of a model. */
  find(model: string): number[];
  add(inst: PropInst, opts?: ModelOpts): number;
  remove(id: number): void;
  /** Move a placed prop (dragged logs, things knocked over). */
  move(id: number, x: number, y: number, z: number, yaw?: number, scale?: number): void;
  /** Counts for the stats overlay: what exists and what the last update left visible. */
  readonly info: { batches: number; instances: number; visibleBatches: number; visibleTris: number; parts: number };
}

interface Batch {
  key: string;
  def: ModelDef;
  cx: number;
  cz: number;
  mesh: THREE.InstancedMesh | null;
  glass: THREE.InstancedMesh | null;
  ids: number[];
  capacity: number;
  drawDistance: number;
  castShadow: boolean;
  /** World bounding sphere of the batch, for distance culling. */
  center: THREE.Vector3;
  radius: number;
  dirty: boolean;
}

interface Placed {
  inst: PropInst;
  opts: ModelOpts | undefined;
  def: ModelDef;
  batch: Batch;
  slot: number;
  matrix: THREE.Matrix4;
  holder: THREE.Group | null;
  parts: Record<string, THREE.Object3D> | null;
}

const DRAW_DISTANCE = { item: 60, prop: 140, structure: Infinity } as const;
const QUALITY_REACH: Record<string, number> = { mobile: 0.6, low: 0.8, medium: 1, high: 1.3, ultra: 1.6 };

const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _cam = new THREE.Vector3();
const _sphere = new THREE.Sphere();

function compose(inst: PropInst, out: THREE.Matrix4): THREE.Matrix4 {
  const s = inst.scale || 1;
  return out.compose(_p.set(inst.x, inst.y, inst.z), _q.setFromAxisAngle(_up, inst.yaw), _s.set(s, s, s));
}

export function createPropsSystem(host: PropsHost, props: readonly PropInst[] = [], o: PropsOptions = {}): PropsSystem {
  const chunk = o.chunk ?? 64;
  const shadows = o.shadows ?? true;
  const material = o.material ?? getPropMaterial();
  const glassMaterial = o.glassMaterial ?? getGlassMaterial();
  const root = new THREE.Group();
  root.name = 'props';
  root.matrixAutoUpdate = false;
  host.scene.add(root);

  const placed: (Placed | null)[] = [];
  const batches = new Map<string, Batch>();
  let reach = 1;
  let emittersDirty = true;
  let emitterList: PlacedEmitter[] = [];
  let lightList: PlacedLight[] = [];
  const byType = new Map<EmitterType, PlacedEmitter[]>();
  const info = { batches: 0, instances: 0, visibleBatches: 0, visibleTris: 0, parts: 0 };

  const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, b: Batch, glass: boolean): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(geo, mat, b.capacity);
    m.name = b.key + (glass ? ':glass' : '');
    m.count = 0;
    m.matrixAutoUpdate = false;
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    m.castShadow = shadows && b.castShadow && !glass;
    m.receiveShadow = shadows && !glass;
    if (glass) m.renderOrder = 2;
    root.add(m);
    return m;
  };

  const allocate = (b: Batch, capacity: number): void => {
    for (const m of [b.mesh, b.glass]) if (m) {
      root.remove(m);
      m.dispose();
    }
    b.capacity = capacity;
    b.mesh = b.def.geometry ? makeMesh(b.def.geometry, material, b, false) : null;
    b.glass = b.def.glass ? makeMesh(b.def.glass, glassMaterial, b, true) : null;
    b.dirty = true;
  };

  /** Write the batch's instance matrices and refit its bounds. */
  const flush = (b: Batch): void => {
    b.dirty = false;
    const n = b.ids.length;
    for (const m of [b.mesh, b.glass]) {
      if (!m) continue;
      for (let i = 0; i < n; i++) m.setMatrixAt(i, placed[b.ids[i]]!.matrix);
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      m.boundingSphere = null;
      m.boundingBox = null;
      if (n > 0) m.computeBoundingSphere();
    }
    // distance-culling sphere: every instance's model sphere
    b.center.set(0, 0, 0);
    b.radius = 0;
    if (n === 0) return;
    for (let i = 0; i < n; i++) b.center.add(_p.setFromMatrixPosition(placed[b.ids[i]]!.matrix));
    b.center.divideScalar(n);
    for (let i = 0; i < n; i++) {
      const pl = placed[b.ids[i]]!;
      const d = b.center.distanceTo(_p.setFromMatrixPosition(pl.matrix)) + pl.def.radius * (pl.inst.scale || 1);
      if (d > b.radius) b.radius = d;
    }
  };

  const batchFor = (inst: PropInst, opts: ModelOpts | undefined, def: ModelDef): Batch => {
    const cx = Math.floor(inst.x / chunk), cz = Math.floor(inst.z / chunk);
    const key = modelKey(inst.model, inst.seed, opts) + '@' + cx + ',' + cz;
    let b = batches.get(key);
    if (!b) {
      const meta = modelMeta(inst.model);
      b = {
        key, def, cx, cz, mesh: null, glass: null, ids: [], capacity: 0,
        drawDistance: meta.drawDistance ?? DRAW_DISTANCE[meta.size],
        castShadow: meta.castShadow,
        center: new THREE.Vector3(), radius: 0, dirty: true,
      };
      batches.set(key, b);
    }
    return b;
  };

  const attach = (id: number, pl: Placed): void => {
    const b = pl.batch;
    if (b.ids.length >= b.capacity) allocate(b, Math.max(4, b.capacity * 2));
    pl.slot = b.ids.length;
    b.ids.push(id);
    b.dirty = true;
  };
  const detach = (pl: Placed): void => {
    const b = pl.batch;
    const last = b.ids.pop() as number;
    if (pl.slot < b.ids.length) {
      b.ids[pl.slot] = last;
      placed[last]!.slot = pl.slot;
    }
    b.dirty = true;
  };

  const buildParts = (pl: Placed): void => {
    const names = Object.keys(pl.def.parts);
    if (names.length === 0) return;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(pl.matrix);
    pl.holder = holder;
    pl.parts = {};
    for (const name of names) {
      const part = pl.def.parts[name];
      const pivot = new THREE.Group();
      pivot.name = name;
      pivot.position.copy(part.pivot);
      if (part.geometry) {
        const m = new THREE.Mesh(part.geometry, material);
        m.castShadow = shadows && pl.batch.castShadow;
        m.receiveShadow = shadows;
        pivot.add(m);
      }
      if (part.glass) {
        const m = new THREE.Mesh(part.glass, glassMaterial);
        m.renderOrder = 2;
        pivot.add(m);
      }
      holder.add(pivot);
      pl.parts[name] = pivot;
      info.parts++;
    }
    root.add(holder);
  };

  const add = (inst: PropInst, opts?: ModelOpts, preallocate = false): number => {
    const id = placed.length;
    const def = getModel(inst.model, inst.seed, opts);
    const batch = batchFor(inst, opts, def);
    const pl: Placed = { inst, opts, def, batch, slot: -1, matrix: compose(inst, new THREE.Matrix4()), holder: null, parts: null };
    placed.push(pl);
    if (preallocate) {
      pl.slot = batch.ids.length;
      batch.ids.push(id);
    } else attach(id, pl);
    buildParts(pl);
    emittersDirty = true;
    info.instances++;
    return id;
  };

  // The initial list: count first so every batch is allocated once at its exact size.
  for (let i = 0; i < props.length; i++) add(props[i], o.opts ? o.opts(props[i], i) : undefined, true);
  for (const b of batches.values()) {
    allocate(b, b.ids.length);
    flush(b);
  }

  const rebuildEmitters = (): void => {
    emittersDirty = false;
    emitterList = [];
    lightList = [];
    byType.clear();
    for (let id = 0; id < placed.length; id++) {
      const pl = placed[id];
      if (!pl) continue;
      const s = pl.inst.scale || 1;
      for (const e of pl.def.emitters) {
        const pe: PlacedEmitter = {
          prop: id, model: pl.inst.model, type: e.type, name: e.name,
          position: e.position.clone().applyMatrix4(pl.matrix),
          dir: e.dir.clone().transformDirection(pl.matrix),
          size: e.size * s,
          def: e,
        };
        emitterList.push(pe);
        let list = byType.get(e.type);
        if (!list) byType.set(e.type, (list = []));
        list.push(pe);
      }
      for (const l of pl.def.lights) lightList.push({ prop: id, model: pl.inst.model, name: l.name, position: l.position.clone().applyMatrix4(pl.matrix), def: l });
    }
  };

  const EMPTY: readonly PlacedEmitter[] = [];

  const sys: PropsSystem = {
    name: 'props',
    root,
    info,
    get count() {
      return placed.length;
    },
    has: (id) => !!placed[id],
    inst: (id) => placed[id]?.inst,
    model: (id) => placed[id]?.def,
    matrix(id, out = new THREE.Matrix4()) {
      const pl = placed[id];
      return pl ? out.copy(pl.matrix) : null;
    },
    anchor(id, name, out = new THREE.Vector3()) {
      const pl = placed[id];
      const a = pl?.def.anchors[name];
      return pl && a ? out.copy(a.position).applyMatrix4(pl.matrix) : null;
    },
    anchorYaw(id, name) {
      const pl = placed[id];
      const a = pl?.def.anchors[name];
      return pl && a ? pl.inst.yaw + a.yaw : 0;
    },
    emitters(type) {
      if (emittersDirty) rebuildEmitters();
      return type ? byType.get(type) ?? EMPTY : emitterList;
    },
    emittersOf(id) {
      if (emittersDirty) rebuildEmitters();
      return emitterList.filter((e) => e.prop === id);
    },
    lights() {
      if (emittersDirty) rebuildEmitters();
      return lightList;
    },
    part(id, name) {
      return placed[id]?.parts?.[name] ?? null;
    },
    setOpen(id, t) {
      const pl = placed[id];
      if (!pl || !pl.parts) return;
      for (const name in pl.parts) {
        const def = pl.def.parts[name];
        if (def.openAngle !== 0) pl.parts[name].quaternion.setFromAxisAngle(def.axis, def.openAngle * t);
      }
    },
    near(x, z, r, out = []) {
      out.length = 0;
      const r2 = r * r;
      for (let id = 0; id < placed.length; id++) {
        const pl = placed[id];
        if (!pl) continue;
        const dx = pl.inst.x - x, dz = pl.inst.z - z;
        if (dx * dx + dz * dz <= r2) out.push(id);
      }
      return out;
    },
    find(model) {
      const out: number[] = [];
      for (let id = 0; id < placed.length; id++) if (placed[id]?.inst.model === model) out.push(id);
      return out;
    },
    add: (inst, opts) => add(inst, opts),
    remove(id) {
      const pl = placed[id];
      if (!pl) return;
      detach(pl);
      if (pl.holder) {
        root.remove(pl.holder);
        info.parts -= Object.keys(pl.parts ?? {}).length;
      }
      placed[id] = null;
      emittersDirty = true;
      info.instances--;
    },
    move(id, x, y, z, yaw, scale) {
      const pl = placed[id];
      if (!pl) return;
      // PropInst objects belong to the World: move a copy, not the caller's data.
      pl.inst = { ...pl.inst, x, y, z, yaw: yaw ?? pl.inst.yaw, scale: scale ?? pl.inst.scale };
      compose(pl.inst, pl.matrix);
      pl.holder?.matrix.copy(pl.matrix);
      const b = batchFor(pl.inst, pl.opts, pl.def);
      if (b !== pl.batch) {
        detach(pl);
        pl.batch = b;
        attach(id, pl);
      } else b.dirty = true;
      emittersDirty = true;
    },
    update(_f: Frame) {
      host.camera.getWorldPosition(_cam);
      let visible = 0, tris = 0, live = 0;
      for (const b of batches.values()) {
        if (b.dirty) flush(b);
        const n = b.ids.length;
        if (n > 0) live++;
        const show = n > 0 && _cam.distanceTo(b.center) - b.radius < b.drawDistance * reach;
        if (b.mesh) b.mesh.visible = show;
        if (b.glass) b.glass.visible = show;
        if (show) {
          visible++;
          tris += b.def.tris * n;
        }
      }
      info.batches = live;
      info.visibleBatches = visible;
      info.visibleTris = tris;
    },
    setQuality(q: Quality) {
      reach = QUALITY_REACH[q.name] ?? 1;
    },
    dispose() {
      // Geometries belong to the registry cache and materials are shared: only the instance buffers go.
      for (const b of batches.values()) for (const m of [b.mesh, b.glass]) if (m) m.dispose();
      batches.clear();
      placed.length = 0;
      host.scene.remove(root);
    },
  };
  // Keep the unused scratch sphere out of tree-shaking complaints and available to flush() users.
  void _sphere;
  return sys;
}
