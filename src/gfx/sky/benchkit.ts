// Dev-only helpers shared by dev/sky.ts and dev/weather.ts (nothing in the game imports this):
// a stand-in View whose env and camera the bench drives, removal of the bench's stand-in sky, a
// slider panel, and the wrapper that feeds the systems that View.
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem } from '../api';
import type { View } from '../../game/view';
import type { Env } from '../../sim/types';

export interface BenchView {
  view: View;
  env: Env;
}

/** Visibility for a storm intensity, as the simulation derives it (src/sim/systems/env.ts). */
export function visibilityFor(storm: number): number {
  const s = Math.max(0, Math.min(1, storm));
  return 4000 * Math.exp(Math.log(6 / 4000) * Math.pow(s, 1.3));
}

/** Everything the sim derives from the storm, for benches that set only the storm. */
export function deriveEnv(env: Env, o: { cloud?: number; aurora?: number; windDeg?: number; wind?: number }): void {
  const s = env.storm;
  env.visibility = visibilityFor(s);
  env.snowfall = Math.max(0, Math.min(1, ((x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)))((s - 0.08) / 0.77) + (s > 0.85 ? (s - 0.85) * 2 : 0)));
  env.cloud = o.cloud ?? Math.max(0, Math.min(1, 0.1 + 1.45 * s));
  env.aurora = o.aurora ?? 0;
  const speed = o.wind ?? 2 + 20 * Math.pow(s, 1.15);
  const dir = ((o.windDeg ?? 135) * Math.PI) / 180; // degrees clockwise from north the air moves toward
  env.windX = Math.sin(dir) * speed;
  env.windZ = -Math.cos(dir) * speed;
  env.airTemp = -12 - 6 * s;
}

export function makeBenchView(camera: THREE.PerspectiveCamera, env0: Partial<Env>): BenchView {
  const env: Env = { t: 0, clock: 12, day: 0, storm: 0, windX: 2, windZ: 2, gust: 0, snowfall: 0, visibility: 4000, airTemp: -12, cloud: 0.1, aurora: 0, snowAccum: 0, ...env0 };
  const cam = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0, roll: 0, fov: camera.fov, third: 0 };
  const view = {
    env,
    camera: cam,
    time: 0,
    mode: 'play',
    touch: false,
    me: null,
    myId: 0,
    ents: new Map(),
    ice: new Map(),
    list: () => [],
  } as unknown as View;
  return { view, env };
}

/** Copy the engine camera into the stand-in view (the bench orbit camera drives the engine camera). */
export function syncViewCamera(view: View, camera: THREE.PerspectiveCamera, time: number): void {
  const c = view.camera;
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  c.x = e[12];
  c.y = e[13];
  c.z = e[14];
  const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]);
  c.yaw = Math.atan2(-fwd.x, -fwd.z);
  c.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  c.fov = camera.fov;
  (view as any).time = time;
}

/** Remove the bench's stand-in sun, hemisphere light, background and fog. */
export function removeStandIns(scene: THREE.Scene, sun: THREE.DirectionalLight): void {
  sun.castShadow = false;
  scene.remove(sun, sun.target);
  const hemis: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as any).isHemisphereLight) hemis.push(o);
  });
  for (const h of hemis) scene.remove(h);
  scene.backgroundNode = null;
  scene.fogNode = null;
}

/** A system that forwards to `inner` with the stand-in view in the frame. */
export function withView<T extends GfxSystem>(inner: T, view: View): GfxSystem {
  const frame: Frame = { dt: 0, time: 0, view };
  return {
    name: inner.name + '.bench',
    update(f: Frame) {
      frame.dt = f.dt;
      frame.time = f.time;
      inner.update(frame);
    },
    setQuality: (q) => inner.setQuality?.(q),
    resize: (w, h) => inner.resize?.(w, h),
    dispose: () => inner.dispose?.(),
  };
}

export interface Slider {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
}

/** A small slider panel in the bottom-left corner. Hidden with ?ui=0. */
export function sliderPanel(sliders: Slider[], show: boolean): void {
  if (!show) return;
  const css = document.createElement('style');
  css.textContent = '#atmos-ui{position:fixed;left:8px;bottom:8px;background:rgba(10,14,20,.62);color:#dfe5ec;font:11px/1.2 ui-monospace,Consolas,monospace;padding:6px 8px;border-radius:3px;z-index:9}#atmos-ui label{display:grid;grid-template-columns:62px 150px 44px;align-items:center;gap:6px;margin:2px 0}#atmos-ui input{width:150px}';
  document.head.appendChild(css);
  const panel = document.createElement('div');
  panel.id = 'atmos-ui';
  for (const s of sliders) {
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(s.get());
    const val = document.createElement('span');
    const show = (): void => {
      val.textContent = s.get().toFixed(s.step < 0.1 ? 2 : 1);
    };
    show();
    input.addEventListener('input', () => {
      s.set(Number(input.value));
      show();
    });
    row.append(name, input, val);
    panel.appendChild(row);
  }
  document.body.appendChild(panel);
}
