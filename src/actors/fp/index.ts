// THE VIEWMODEL SYSTEM ('viewmodel'): the local player's arms and the tool in hand in first person,
// animated procedurally from view.me / view.rig (./anim.ts), plus the five tools lying in the world
// as pickups (./pickups.ts) and the rifle scope (./scope.ts).
//
// Drawing: everything hangs under one group that is a child of engine.camera (the engine keeps the
// camera in the scene for this), in the main scene pass, so the world's light, shadows, fog and
// FX's light pool fall on the hands exactly as on everything else. The materials (./material.ts)
// replace only the clip position: the viewmodel has its own field of view and its depth is
// compressed in front of anything the player can stand against, so it never clips into walls.
// Draws: arms 1 (one SkinnedMesh), tool 1 + its moving parts, extras while an act shows them.
//
// Light: the flashlight beam comes from the lamp of the drawn flashlight through FX's light pool
// (priority 6; an own capped SpotLight without FX); FIGURES' own local beam is switched off
// (actors.localBeam = false). A lit match lights the mitts through a pooled point light.
// Hidden while the camera is third person (view.camera.third >= 0.5), dead or rescued.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem, Quality } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import type { View } from '../../game/view';
import type { LogEnt, SimEvent } from '../../sim/types';
import type { World } from '../../world/types';
import { logEnds } from '../../sim/systems/wood';
import type { RGB } from '../../models/kit';
import { TOOL_MODELS, getExtra, toolModel, type ExtraName, type Tool } from '../../models/tools';
import { FLARE_HINGE, RIFLE_BOLT_LIFT, RIFLE_BOLT_TRAVEL } from '../../models/tools';
import { PARKA_COLORS } from '../player_model';
import { FLARE_OPEN, FpAnimator } from './anim';
import { ArmRig, BONES_PER_ARM, buildArms, recolorArms } from './arms';
import { FP_U, createFlameMaterial, createFpMaterial } from './material';
import { createToolPickups } from './pickups';
import { Scope } from './scope';

/** The viewmodel's own vertical field of view, degrees. */
export const VM_FOV = 62;

/** Minimal shape of FX's light pool (src/gfx/fx/lights.ts), looked up at run time. */
interface LightReq {
  on: boolean;
  readonly position: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly color: THREE.Color;
  intensity: number;
  range: number;
  angle: number;
  penumbra: number;
  release(): void;
}
interface LightPoolLike {
  acquire(kind: 'point' | 'spot', priority?: number): LightReq;
}

export interface ViewmodelSystem extends GfxSystem {
  readonly anim: FpAnimator;
  /** False: nothing of the viewmodel is drawn (cinematics, dev third person). */
  enabled: boolean;
  /** The viewmodel's vertical field of view, degrees. */
  fov: number;
  /** Bench: put the held tool up at once (no equip motion). */
  snap(): void;
  /** Dev: the group everything hangs from (a child of the camera). */
  readonly root: THREE.Group;
  /**
   * Dev: the viewmodel keeps the plain projection (fovK 1) so it can be re-parented into the scene
   * and looked at from another camera (dev/fp.html?orbit=1).
   */
  debugFree: boolean;
  readonly stats: { visible: boolean; tool: string | null; draws: number; tris: number; pickups: number; scope: number };
}

interface ToolVis {
  group: THREE.Group;
  /** Meshes in the group (draw calls when shown). */
  draws: number;
  parts: Record<string, THREE.Mesh>;
  pivots: Record<string, THREE.Vector3>;
  tris: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export function createViewmodelSystem(engine: CsEngine, world: World | null): ViewmodelSystem {
  void world;
  const cam = engine.camera;
  const root = new THREE.Group();
  root.name = 'viewmodel';
  root.matrixAutoUpdate = false;
  cam.add(root);
  const mat = createFpMaterial();
  const glowMat = createFpMaterial({ glow: true });
  const flameMat = createFlameMaterial();

  const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.Mesh => {
    const o = new THREE.Mesh(geo, m);
    o.name = name;
    o.castShadow = false;
    o.receiveShadow = true;
    o.frustumCulled = false;
    o.matrixAutoUpdate = false;
    return o;
  };

  // ---------------- tools ----------------
  const tools = new Map<Tool, ToolVis>();
  for (const t of TOOL_MODELS) {
    const def = toolModel(t, 0);
    const group = new THREE.Group();
    group.name = 'vm-' + t;
    group.matrixAutoUpdate = false;
    root.add(group);
    if (def.geometry) group.add(mesh(def.geometry, mat, 'vm-' + t + '-body'));
    const parts: Record<string, THREE.Mesh> = {};
    const pivots: Record<string, THREE.Vector3> = {};
    for (const [name, p] of Object.entries(def.parts)) {
      if (!p.geometry) continue;
      const m = mesh(p.geometry, name === 'lamp' || name === 'glow' ? glowMat : mat, 'vm-' + t + '-' + name);
      m.matrix.makeTranslation(p.pivot.x, p.pivot.y, p.pivot.z);
      group.add(m);
      parts[name] = m;
      pivots[name] = p.pivot.clone();
    }
    tools.set(t, { group, draws: group.children.length, parts, pivots, tris: def.tris });
  }

  // ---------------- extras, the match flame, spent cases ----------------
  const extras = new Map<ExtraName, THREE.Mesh>();
  for (const name of ['matchbox', 'match', 'ration', 'thermos', 'bandage', 'cartridge', 'round', 'cell'] as ExtraName[]) {
    const m = mesh(getExtra(name).geometry!, name === 'match' ? glowMat : mat, 'vm-x-' + name);
    root.add(m);
    extras.set(name, m);
  }
  const flameGeo = new THREE.PlaneGeometry(0.016, 0.036).translate(0, 0.018, 0);
  const flame = mesh(flameGeo, flameMat, 'vm-flame');
  flame.receiveShadow = false;
  root.add(flame);
  interface Case { m: THREE.Mesh; t: number; pos: THREE.Vector3; vel: THREE.Vector3; spin: THREE.Vector3; rot: THREE.Euler }
  const cases: Case[] = [];
  for (let i = 0; i < 3; i++) {
    const m = mesh(getExtra('case').geometry!, mat, 'vm-case');
    root.add(m);
    cases.push({ m, t: 9, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), rot: new THREE.Euler() });
  }

  // ---------------- arms ----------------
  const rig = new ArmRig();
  const bones: THREE.Bone[] = [];
  let arms: THREE.SkinnedMesh | null = null;
  let armsColor: RGB | null = null;
  let armsTris = 0;
  let detail = engine.quality.name !== 'mobile' && engine.quality.name !== 'low';
  for (let i = 0; i < BONES_PER_ARM * 2; i++) {
    const b = new THREE.Bone();
    b.name = 'vm-bone-' + i;
    b.matrixAutoUpdate = false;
    root.add(b);
    bones.push(b);
  }
  function buildArmsFor(color: RGB): void {
    if (arms && armsColor) {
      if (armsColor === color) return;
      recolorArms(arms.geometry, armsColor, color);
      armsColor = color;
      return;
    }
    const a = buildArms(color, detail);
    const skeleton = new THREE.Skeleton(bones, a.bind.map((m) => m.clone().invert()));
    const sm = new THREE.SkinnedMesh(a.geometry, mat);
    sm.name = 'vm-arms';
    sm.castShadow = false;
    sm.receiveShadow = true;
    sm.frustumCulled = false;
    sm.matrixAutoUpdate = false;
    sm.bind(skeleton, new THREE.Matrix4());
    root.add(sm);
    arms = sm;
    armsColor = color;
    armsTris = a.tris;
  }
  // built now (slot 0's colour) so the first warm-up compiles the skinned pipeline
  buildArmsFor(PARKA_COLORS[0]);

  // ---------------- light ----------------
  let pool: LightPoolLike | null = null;
  let poolChecked = false;
  let beam: LightReq | null = null;
  let matchLight: LightReq | null = null;
  let ownSpot: THREE.SpotLight | null = null;
  const findPool = (): void => {
    if (poolChecked) return;
    const fx = engine.get('fx') as (GfxSystem & { lights?: LightPoolLike }) | undefined;
    if (fx && fx.lights && typeof fx.lights.acquire === 'function') pool = fx.lights;
    poolChecked = true;
  };
  findPool();
  poolChecked = false;
  if (!pool) {
    ownSpot = new THREE.SpotLight(0xfff0d8, 0, 38, 0.42, 0.55, 2);
    ownSpot.name = 'vm-flashlight';
    engine.scene.add(ownSpot, ownSpot.target);
  }

  const scope = new Scope(engine);
  scope.install();
  const pickups = createToolPickups(engine);
  const anim = new FpAnimator();

  // ---------------- events ----------------
  let busOff: (() => void) | null = null;
  let busView: View | null = null;
  function listen(view: View): void {
    if (busView === view) return;
    busOff?.();
    busView = view;
    busOff = view.bus?.on?.('sim', (ev: SimEvent) => {
      const me = view.myId;
      switch (ev.t) {
        case 'shot':
        case 'flareShot':
        case 'dry':
        case 'igniteFail':
          if (ev.by === me) anim.event(ev.t);
          break;
        case 'swing':
          if (ev.by === me) anim.event('swing', ev.hit);
          break;
      }
    }) ?? null;
  }

  const stats = { visible: false, tool: null as string | null, draws: 0, tris: 0, pickups: 0, scope: 0 };
  let lastTime = -1;
  const logEnd = new THREE.Vector3();
  let slot = -1;

  /** Camera space (viewmodel) -> world, through the apparent position (x, y scaled by fovK). */
  function toWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const k = FP_U.fovK.value as number;
    return out.set(p.x * k, p.y * k, p.z).applyMatrix4(cam.matrixWorld);
  }
  function dirToWorld(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const k = FP_U.fovK.value as number;
    return out.set(d.x * k, d.y * k, d.z).normalize().transformDirection(cam.matrixWorld);
  }

  const api: ViewmodelSystem = {
    name: 'viewmodel',
    anim,
    enabled: true,
    fov: VM_FOV,
    stats,
    root,
    debugFree: false,
    snap(): void {
      lastTime = -1;
    },
    update(f: Frame): void {
      const view = f.view;
      if (!view) return;
      listen(view);
      findPool();
      // the first-person beam is this system's: FIGURES' stand-in local beam goes off
      const actors = engine.get('actors') as (GfxSystem & { localBeam?: boolean }) | undefined;
      if (actors && actors.localBeam !== undefined) actors.localBeam = false;
      pickups.update(view);
      stats.pickups = pickups.drawn;

      // the render-clock time since the last update, not f.dt: tools step several frames per rendered
      // one (?still=1) and a hitch skips frames; everything here is eased or sub-stepped, so up to a
      // second at once is fine. A frozen clock (pause, photo) freezes the hands.
      const elapsed = lastTime < 0 ? f.dt : f.time - lastTime;
      const dt = Math.min(1, Math.max(0, elapsed < 2 ? elapsed : f.dt));
      lastTime = f.time;
      const me = view.me;
      if (me && me.slot !== slot) {
        slot = me.slot;
        buildArmsFor(PARKA_COLORS[((slot % 4) + 4) % 4]);
      }

      // the carried log's held end, in viewmodel space
      let end: THREE.Vector3 | null = null;
      if (me && me.carry) {
        const l = view.ents.get(me.carry) as LogEnt | undefined;
        if (l && l.kind === 'log') {
          const e = logEnds(l);
          const front = l.a === me.id;
          _v.set(front ? e.ax : e.bx, l.y + 0.05, front ? e.az : e.bz);
          _inv.copy(cam.matrixWorld).invert();
          _v.applyMatrix4(_inv);
          const k = FP_U.fovK.value as number;
          if (_v.z < -0.05) end = logEnd.set(_v.x / k, _v.y / k, _v.z);
        }
      }

      const out = anim.update({ dt, time: f.time, view, logEnd: end });
      const third = view.camera.third;
      // the scope narrows the camera before anything is placed
      scope.apply(view, third < 0.01 && api.enabled ? out.scope : 0);
      stats.scope = out.scope;
      FP_U.fovK.value = api.debugFree ? 1 : Math.tan((cam.fov * Math.PI) / 360) / Math.tan((api.fov * Math.PI) / 360);
      FP_U.near.value = cam.near;
      const visible = api.enabled && out.visible && third < 0.5 && view.mode !== 'title' && view.mode !== 'boot';
      root.visible = visible;
      stats.visible = visible;
      stats.tool = out.tool;
      let draws = 0;
      let tris = 0;

      // ---------------- tool ----------------
      for (const [t, tv] of tools) {
        const on = visible && out.tool === t;
        tv.group.visible = on;
        if (!on) continue;
        tv.group.matrix.copy(out.toolM);
        tv.group.matrixWorldNeedsUpdate = true;
        draws += tv.draws;
        tris += tv.tris;
        const P = tv.parts, V = tv.pivots;
        const at = (name: string, rot: THREE.Matrix4 | null, dx = 0, dy = 0, dz = 0): void => {
          const m = P[name];
          if (!m) return;
          const p = V[name];
          m.matrix.makeTranslation(p.x + dx, p.y + dy, p.z + dz);
          if (rot) m.matrix.multiply(rot);
          m.matrixWorldNeedsUpdate = true;
        };
        switch (t) {
          case 'rifle':
            at('bolt', _m.makeRotationZ(out.bolt.lift * RIFLE_BOLT_LIFT), 0, 0, out.bolt.back * RIFLE_BOLT_TRAVEL);
            at('trigger', _m.makeRotationX(-0.35 * out.trigger));
            break;
          case 'flaregun':
            at('barrel', _m.makeRotationX(-FLARE_OPEN * out.barrel));
            at('hammer', _m.makeRotationX(-0.62 * (1 - out.hammer)));
            at('trigger', _m.makeRotationX(-0.35 * out.trigger));
            break;
          case 'radio':
            at('crank', _m.makeRotationX(out.crank));
            at('needle', _m.makeRotationZ(-out.needle));
            if (P.glow) P.glow.userData.glow = out.radioGlow;
            break;
          case 'flashlight':
            if (P.lamp) P.lamp.userData.glow = out.lampGlow;
            if (P.cap) {
              P.cap.matrix.multiplyMatrices(out.capM, _m2.makeTranslation(V.cap.x, V.cap.y, V.cap.z));
              P.cap.matrixWorldNeedsUpdate = true;
            }
            break;
        }
      }
      void FLARE_HINGE;

      // ---------------- extras, flame, cases ----------------
      for (const x of out.extras) {
        const m = extras.get(x.name);
        if (!m) continue;
        m.visible = visible && x.on;
        if (!m.visible) continue;
        m.matrix.copy(x.m);
        m.matrixWorldNeedsUpdate = true;
        m.userData.glow = x.glow;
        draws++;
      }
      flame.visible = visible && out.flame.on;
      if (flame.visible) {
        // a card turned to face the eye
        _m.lookAt(_zero, out.flame.pos, _up);
        flame.matrix.copy(_m).setPosition(out.flame.pos);
        flame.matrixWorldNeedsUpdate = true;
        flame.userData.glow = out.flame.k;
        draws++;
      }
      if (out.eject.pending) {
        const c = cases.reduce((a, b) => (b.t > a.t ? b : a));
        c.t = 0;
        c.pos.copy(out.eject.pos);
        c.vel.copy(out.eject.vel);
        c.spin.set(11, 4, 17);
        c.rot.set(0, 0, 0);
      }
      // camera-space gravity for the cases (they fly for half a second)
      _v2.set(0, -9.8, 0).transformDirection(_inv.copy(cam.matrixWorld).invert()).multiplyScalar(9.8);
      for (const c of cases) {
        c.t += dt;
        const live = c.t < 0.55;
        c.m.visible = visible && live;
        if (!live) continue;
        c.vel.addScaledVector(_v2, dt);
        c.pos.addScaledVector(c.vel, dt);
        c.rot.x += c.spin.x * dt;
        c.rot.y += c.spin.y * dt;
        c.rot.z += c.spin.z * dt;
        _q.setFromEuler(c.rot);
        c.m.matrix.compose(c.pos, _q, _v.set(1, 1, 1));
        c.m.matrixWorldNeedsUpdate = true;
        draws++;
      }

      // ---------------- arms ----------------
      if (arms) {
        arms.visible = visible && out.arms;
        if (arms.visible) {
          rig.solve(1, out.hands[0]);
          rig.solve(-1, out.hands[1]);
          rig.apply(bones);
          draws++;
          tris += armsTris;
        }
      }
      stats.draws = draws;
      stats.tris = tris;
      root.updateMatrixWorld(true);

      // ---------------- light ----------------
      const beamOn = out.beam.on && third < 0.01 && api.enabled;
      const focus = out.beam.focus;
      const warm = out.beam.warm;
      if (beamOn) {
        toWorld(out.beam.pos, _v);
        dirToWorld(out.beam.dir, _v2);
        // just in front of the lens, so the cone does not light the torch itself
        _v.addScaledVector(_v2, 0.02);
      }
      // (POLISH: 45..70 cd drew a clipped white ellipse with a hard edge at the night exposure; a
      // torch lights the snow a few metres out to about the white point and still reaches ~30 m)
      const intensity = (10 + 8 * focus) * out.beam.k;
      // the snow the beam lights throws a little of it back onto the hands
      const bounce = beamOn ? 0.05 * out.beam.k : 0;
      (FP_U.fill.value as THREE.Color).setRGB(bounce, bounce * (0.93 - 0.25 * warm), bounce * (0.8 - 0.42 * warm));
      if (pool) {
        if (beamOn && !beam) beam = pool.acquire('spot', 6);
        if (beam) {
          beam.on = beamOn;
          if (beamOn) {
            beam.position.copy(_v);
            beam.direction.copy(_v2);
            // an incandescent bulb on a dying cell goes orange
            beam.color.setRGB(1, 0.93 - 0.25 * warm, 0.8 - 0.42 * warm);
            beam.intensity = intensity;
            beam.range = 34 + 12 * focus;
            beam.angle = 0.42 - 0.14 * focus;
            beam.penumbra = 0.9;
          }
        }
        const mOn = visible && out.flame.on;
        if (mOn && !matchLight) matchLight = pool.acquire('point', 5);
        if (matchLight) {
          matchLight.on = mOn;
          if (mOn) {
            toWorld(out.flame.pos, matchLight.position);
            matchLight.color.setRGB(1, 0.6, 0.28);
            matchLight.intensity = 0.65 * out.flame.k;
            matchLight.range = 3.2;
          }
        }
      } else if (ownSpot) {
        ownSpot.intensity = beamOn ? intensity : 0;
        if (beamOn) {
          ownSpot.position.copy(_v);
          ownSpot.target.position.copy(_v).add(_v2);
          ownSpot.target.updateMatrixWorld();
          ownSpot.angle = 0.42 - 0.14 * focus;
          ownSpot.color.setRGB(1, 0.93 - 0.25 * warm, 0.8 - 0.42 * warm);
        }
      }
    },
    setQuality(q: Quality): void {
      detail = q.name !== 'mobile' && q.name !== 'low';
    },
    dispose(): void {
      busOff?.();
      busOff = null;
      beam?.release();
      matchLight?.release();
      beam = matchLight = null;
      scope.dispose();
      pickups.dispose();
      cam.remove(root);
      if (ownSpot) {
        engine.scene.remove(ownSpot, ownSpot.target);
        ownSpot.dispose();
      }
      arms?.geometry.dispose();
      arms?.skeleton.dispose();
      flameGeo.dispose();
      mat.dispose();
      glowMat.dispose();
      flameMat.dispose();
    },
  };
  return api;
}
