// The five tools lying in the world as pickups (PickupEnt with item axe / flashlight / flaregun /
// rifle / radio), drawn with their registered KIT models (src/models/tools, the ground pose) and the
// shared prop material, so snow settles on them like on every prop. One InstancedMesh per tool.
// GAME's stand-in markers stop drawing tool pickups once this runs (their update is wrapped with a
// view whose pickup list leaves the tools out; the wrappers of FX and FIGURES chain the same way).
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import type { View, ViewEnt } from '../../game/view';
import type { EntityKind, PickupEnt } from '../../sim/types';
import { getPropMaterial } from '../../models/material';
import { getModel } from '../../models/registry';
import { TOOL_MODELS, type Tool } from '../../models/tools';

const CAP = 6;
/** Not drawn past this (metres): a hand-sized thing is a speck. */
const FAR = 120;

const isTool = (item: string): item is Tool => (TOOL_MODELS as readonly string[]).includes(item);

export interface ToolPickups {
  update(view: View): void;
  dispose(): void;
  readonly drawn: number;
}

export function createToolPickups(engine: CsEngine): ToolPickups {
  const group = new THREE.Group();
  group.name = 'vm-pickups';
  engine.scene.add(group);
  const mat = getPropMaterial();
  const meshes = new Map<Tool, THREE.InstancedMesh>();
  const heights = new Map<Tool, number>();
  for (const t of TOOL_MODELS) {
    const def = getModel(t);
    if (!def.geometry) continue;
    const m = new THREE.InstancedMesh(def.geometry, mat, CAP);
    m.name = 'vm-pickup-' + t;
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    meshes.set(t, m);
    heights.set(t, def.bounds.max.y);
  }
  const counts = new Map<Tool, number>();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const _y = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  // ---- the markers stop drawing tool pickups ----
  let muted = false;
  const kept: ViewEnt[] = [];
  function mute(): boolean {
    const m = engine.get('markers') as (GfxSystem & { __vmMuted?: boolean }) | undefined;
    if (!m) return false;
    if (m.__vmMuted) return true;
    const orig = m.update.bind(m);
    let seen: View | null = null;
    let proxy: View | null = null;
    const frame: Frame = { dt: 0, time: 0, view: null as unknown as View };
    m.update = (f: Frame): void => {
      if (f.view !== seen) {
        seen = f.view;
        const real = f.view;
        proxy = Object.create(real, {
          list: {
            value: (k: EntityKind) => {
              const src = real.list(k);
              if (k !== 'pickup') return src;
              kept.length = 0;
              for (const e of src as ViewEnt<PickupEnt>[]) if (!isTool(e.item)) kept.push(e);
              return kept;
            },
          },
        }) as View;
      }
      frame.dt = f.dt;
      frame.time = f.time;
      frame.view = proxy as View;
      orig(frame);
    };
    m.__vmMuted = true;
    return true;
  }

  return {
    get drawn() {
      return drawn;
    },
    update(view: View): void {
      if (!muted) muted = mute();
      for (const t of TOOL_MODELS) counts.set(t, 0);
      const cx = view.camera.x, cz = view.camera.z;
      drawn = 0;
      for (const e of view.list('pickup') as ViewEnt<PickupEnt>[]) {
        if (!isTool(e.item)) continue;
        const dx = e.x - cx, dz = e.z - cz;
        if (dx * dx + dz * dz > FAR * FAR) continue;
        const mesh = meshes.get(e.item);
        if (!mesh) continue;
        const n = counts.get(e.item) ?? 0;
        if (n >= CAP) continue;
        // half sunk where it lies in the snow
        const sink = e.lie === 'snow' ? (heights.get(e.item) ?? 0.05) * 0.45 : 0;
        _q.setFromAxisAngle(_y, e.yaw);
        _m.compose(_p.set(e.x, e.y - sink, e.z), _q, _s);
        mesh.setMatrixAt(n, _m);
        counts.set(e.item, n + 1);
        drawn++;
      }
      for (const [t, mesh] of meshes) {
        const n = counts.get(t) ?? 0;
        mesh.count = n;
        mesh.visible = n > 0;
        if (n > 0) mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose(): void {
      engine.scene.remove(group);
      for (const m of meshes.values()) m.dispose();
    },
  };
}
