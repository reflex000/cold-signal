// MODEL VIEWER. Lays the requested models out on a snowy ground plane under one of four lights and
// frames them from one or more views, tiled in one picture. Self-contained: its own renderer, sun,
// ambient, sky gradient and fog; it does not use the engine, so it works while the engine changes.
//
//   dev/models.html?m=crate,barrel&seed=1-4&light=dusk&views=30,20;200,35&snow=0.8
//
//   m=name[,name...]      models (default: every registered model). Model options go after a
//                         colon: m=campfire:stage=2,campfire:stage=3:big=true
//   seed=1-4 | 3 | 0,2,5  seeds shown for each model (default 0). Seeds that fold onto the same
//                         variant are shown once.
//   light=day|dusk|night|storm   (default day)        snow=0..1  U.snowCover (default 0)
//   views=az,el;az,el     camera directions in degrees: az 0 looks at the front (+Z side) of the
//                         models, 90 from their +X side; el is the height angle. Default 35,20.
//   debug=1               bounds, anchors, emitters, lights and part pivots, with labels
//   open=0..1             swing every hinged part (lids, doors) open by this fraction
//   webgl=1               force the WebGL2 backend
//   yaw=deg  scale=k      placement of every prop (checks instancing with a rotated matrix)
//   wind=m/s  gust=0..1  wet=0..1  t=seconds (freeze the clock)  fov=deg  exp=k (exposure multiplier)
//   fire=0                do not put a stand-in point light on 'fire' emitters and model lights
//   labels=0              hide the name tags            zoom=k  move the cameras in (k > 1) or out
//
// Drag to orbit when a single view is shown. The page sets window.DONE when its frame is on
// screen, window.BACKEND, and window.MODEL_INFO (per model: triangles, size, anchors, emitters,
// parts) for tools/shot-models.mjs.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ATMOS, U } from '../src/gfx/shared';
import type { PropInst } from '../src/world/types';
import { createPropsSystem } from '../src/models/instances';
import { PAL, fbm3, type ModelDef } from '../src/models/kit';
import { PROP_U } from '../src/models/material';
import { getModel, hasModel, listModels, modelKey, modelMeta, type ModelOpts } from '../src/models/registry';

const { fog, positionView, positionWorld, positionWorldDirection, uniform, float, mix, smoothstep, max, dot, pow, vec3, mx_noise_float, normalWorld } = TSL as any;

// ------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------

const Q = new URLSearchParams(location.search);
const str = (k: string, d = ''): string => Q.get(k) ?? d;
const num = (k: string, d: number): number => {
  const v = Q.get(k);
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string, d: boolean): boolean => {
  const v = Q.get(k);
  return v === null ? d : v !== '0' && v !== 'false';
};

function parseSeeds(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.split(',')) {
    const m = tok.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]) && out.length < 64; i++) out.push(i);
    else if (tok.trim() !== '' && Number.isFinite(Number(tok))) out.push(Math.floor(Number(tok)));
  }
  return out.length ? out : [0];
}

interface Spec { name: string; opts: ModelOpts | undefined }
function parseSpecs(s: string): Spec[] {
  const out: Spec[] = [];
  for (const tok of s.split(',')) {
    const [name, ...rest] = tok.trim().split(':');
    if (!name) continue;
    let opts: ModelOpts | undefined;
    for (const kv of rest) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq), v = kv.slice(eq + 1);
      (opts ??= {})[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    out.push({ name, opts });
  }
  return out;
}

function parseViews(s: string): { az: number; el: number }[] {
  const out: { az: number; el: number }[] = [];
  for (const tok of s.split(';')) {
    const [a, e] = tok.split(',').map((v) => Number(v));
    if (Number.isFinite(a)) out.push({ az: a, el: Number.isFinite(e) ? Math.max(-5, Math.min(89, e)) : 20 });
  }
  return out.length ? out.slice(0, 9) : [{ az: 35, el: 20 }];
}

// ------------------------------------------------------------------------------------------
// Light presets. Units follow dev/bench.ts (ENGINE): a white surface facing a light of colour
// 3.14 has radiance 1; AgX tone map. Sun, sky gradient, fog and exposure are the bench's. The
// hemisphere is not: over sunlit snow the ground bounce is the strongest ambient there is
// (snow albedo 0.85 times the sun on a horizontal surface), so `ground` here is that bounce and
// `sky` the open-sky irradiance. Without it every face turned from the sun reads black, which
// is wrong for a snowfield (real sun : shade on snow is about 5 : 1, not 15 : 1).
// ------------------------------------------------------------------------------------------

type LightName = 'day' | 'dusk' | 'night' | 'storm';
interface LightPreset {
  sunAz: number; // degrees, 0 = north (-Z), clockwise seen from above
  sunEl: number;
  sun: [number, number, number]; // linear colour times intensity of the body that lights the scene
  moon: boolean;
  sky: [number, number, number];
  ground: [number, number, number];
  zenith: [number, number, number];
  horizon: [number, number, number];
  glow: [number, number, number];
  fog: [number, number, number];
  fogDensity: number;
  exposure: number;
  night: number;
  storm: number;
  snowfall: number;
  wind: number;
}
const LIGHTS: Record<LightName, LightPreset> = {
  // Clear winter afternoon, low sun from the front left of the models.
  day: {
    sunAz: 215, sunEl: 24, sun: [10.5, 8.9, 6.9], moon: false,
    sky: [0.8, 1.05, 1.55], ground: [2.0, 1.88, 1.8],
    zenith: [0.1, 0.24, 0.62], horizon: [0.62, 0.78, 1.02], glow: [1.6, 1.25, 0.8],
    fog: [0.6, 0.75, 0.98], fogDensity: 0.00035, exposure: 0.62, night: 0, storm: 0, snowfall: 0, wind: 3,
  },
  // Sun on the horizon: cream light, long blue shadows.
  dusk: {
    sunAz: 236, sunEl: 7, sun: [5.2, 2.7, 1.25], moon: false,
    sky: [0.24, 0.34, 0.66], ground: [0.55, 0.45, 0.5],
    zenith: [0.035, 0.07, 0.24], horizon: [0.6, 0.36, 0.3], glow: [2.6, 1.1, 0.4],
    fog: [0.32, 0.31, 0.43], fogDensity: 0.0006, exposure: 1.5, night: 0.25, storm: 0, snowfall: 0, wind: 4,
  },
  // Clear night, half moon. Dark: fire and lamps are the light.
  night: {
    sunAz: 140, sunEl: 38, sun: [0.07, 0.095, 0.15], moon: true,
    sky: [0.008, 0.012, 0.026], ground: [0.03, 0.04, 0.066],
    zenith: [0.0015, 0.003, 0.009], horizon: [0.006, 0.01, 0.022], glow: [0.01, 0.014, 0.022],
    fog: [0.005, 0.008, 0.017], fogDensity: 0.0009, exposure: 4.2, night: 1, storm: 0, snowfall: 0, wind: 2,
  },
  // Inside a blizzard by day: flat light, short sight.
  storm: {
    sunAz: 200, sunEl: 30, sun: [0.9, 0.95, 1.05], moon: false,
    sky: [1.25, 1.36, 1.55], ground: [0.95, 1.02, 1.15],
    zenith: [0.42, 0.46, 0.53], horizon: [0.5, 0.54, 0.6], glow: [0.1, 0.1, 0.1],
    fog: [0.47, 0.51, 0.58], fogDensity: 0.03, exposure: 0.85, night: 0, storm: 0.9, snowfall: 1, wind: 16,
  },
};

const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------

const info = document.getElementById('info') as HTMLDivElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;

async function main(): Promise<void> {
  // Every model file of every group registers itself when it is loaded. A file that fails to
  // load (someone else's work in progress) must not take the viewer down with it.
  const files = import.meta.glob(['../src/models/*/*.ts', '!../src/models/*/*.test.ts']);
  const failed: string[] = [];
  await Promise.all(Object.entries(files).map(async ([path, load]) => {
    try {
      await load();
    } catch (err) {
      failed.push(path.replace('../src/models/', ''));
      console.warn(`[models] ${path} failed to load:`, err);
    }
  }));

  const forceWebGL = flag('webgl', false);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  await renderer.init();
  const backend = (renderer.backend as any).isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  (window as any).BACKEND = backend;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const lightName = (str('light', 'day') in LIGHTS ? str('light', 'day') : 'day') as LightName;
  const L = LIGHTS[lightName];
  const views = parseViews(str('views', '35,20'));
  const debug = flag('debug', false);
  const fov = num('fov', 32);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 4000);
  scene.add(camera);

  // ---- what to show ----
  const seeds = parseSeeds(str('seed', '0'));
  let specs = parseSpecs(str('m', ''));
  if (specs.length === 0) specs = listModels().map((e) => ({ name: e.name, opts: undefined }));
  interface Item { spec: Spec; seed: number; def: ModelDef; hx: number; hz: number; x: number; z: number; id: number }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const seed of seeds) {
      const key = modelKey(spec.name, seed, spec.opts);
      if (seen.has(key)) continue;
      seen.add(key);
      const def = getModel(spec.name, seed, spec.opts);
      // footprint about the origin: the model is placed by its origin
      const b = def.bounds;
      const hx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), 0.05), hz = Math.max(Math.abs(b.min.z), Math.abs(b.max.z), 0.05);
      items.push({ spec, seed, def, hx, hz, x: 0, z: 0, id: -1 });
    }
  }

  // ---- layout: rows along X, wrapped so the block is roughly 2:1 ----
  const yaw = num('yaw', 0) * DEG, scale = num('scale', 1);
  {
    const big = items.reduce((m, it) => Math.max(m, it.hx, it.hz), 0.05) * scale;
    const gap = Math.max(0.12, big * 0.45);
    // a yawed box needs its diagonal
    const ext = (it: Item): [number, number] => {
      const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
      return [(it.hx * c + it.hz * s) * scale, (it.hx * s + it.hz * c) * scale];
    };
    let area = 0, widest = 0;
    for (const it of items) {
      const [ex, ez] = ext(it);
      area += (2 * ex + gap) * (2 * ez + gap);
      widest = Math.max(widest, 2 * ex + gap);
    }
    const rowW = Math.max(widest, Math.sqrt(area * 2.4));
    let x = 0, z = 0, rowD = 0;
    const rows: Item[][] = [[]];
    for (const it of items) {
      const [ex, ez] = ext(it);
      if (x > 0 && x + 2 * ex + gap > rowW + 1e-6) {
        z -= rowD;
        x = 0;
        rowD = 0;
        rows.push([]);
      }
      it.x = x + ex + gap / 2;
      it.z = z - ez - gap / 2;
      x += 2 * ex + gap;
      rowD = Math.max(rowD, 2 * ez + gap);
      rows[rows.length - 1].push(it);
    }
    // centre every row, then the block
    let minZ = 0;
    for (const row of rows) {
      const w = row.reduce((m, it) => Math.max(m, it.x + ext(it)[0] + gap / 2), 0);
      for (const it of row) {
        it.x -= w / 2;
        minZ = Math.min(minZ, it.z - ext(it)[1] - gap / 2);
      }
    }
    for (const it of items) it.z -= minZ / 2;
  }

  // ---- the props, drawn the way the game draws them ----
  const list: PropInst[] = items.map((it) => ({ model: it.spec.name, seed: it.seed, x: it.x, y: 0, z: it.z, yaw, scale }));
  const props = createPropsSystem({ scene, camera }, list, { opts: (_inst, id) => items[id].spec.opts });
  items.forEach((it, i) => (it.id = i));
  (window as any).PROPS = props;

  // bounds of everything, in world space
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  for (const it of items) {
    props.matrix(it.id, m4);
    box.union(it.def.bounds.clone().applyMatrix4(m4));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  box.min.y = Math.min(box.min.y, 0);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  // ---- light ----
  const sunDir = new THREE.Vector3();
  {
    const az = L.sunAz * DEG, el = L.sunEl * DEG;
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }
  const body = new THREE.Color(L.sun[0], L.sun[1], L.sun[2]);
  const far = new THREE.Vector3(-sunDir.x, -0.4, -sunDir.z).normalize();
  U.sunDir.value.copy(L.moon ? far : sunDir);
  U.sunColor.value.copy(L.moon ? new THREE.Color(0, 0, 0) : body);
  U.moonDir.value.copy(L.moon ? sunDir : far);
  U.moonColor.value.copy(L.moon ? body : new THREE.Color(0, 0, 0));
  U.skyAmbient.value.setRGB(L.sky[0], L.sky[1], L.sky[2]);
  U.groundAmbient.value.setRGB(L.ground[0], L.ground[1], L.ground[2]);
  U.fogColor.value.setRGB(L.fog[0], L.fog[1], L.fog[2]);
  U.fogDensity.value = L.fogDensity;
  U.fogHeight.value = lightName === 'storm' ? 0.0005 : 0.004;
  U.night.value = L.night;
  U.storm.value = L.storm;
  U.snowfall.value = L.snowfall;
  U.windSpeed.value = num('wind', L.wind);
  U.gust.value = num('gust', L.storm * 0.5);
  U.windDir.value.set(0.92, 0.39).normalize();
  U.snowCover.value = Math.max(0, Math.min(1, num('snow', 0)));
  U.exposure.value = L.exposure * num('exp', 1);
  PROP_U.wet.value = Math.max(0, Math.min(1, num('wet', 0)));
  ATMOS.sunDir.copy(U.sunDir.value);
  ATMOS.sunColor.copy(U.sunColor.value);
  ATMOS.moonDir.copy(U.moonDir.value);
  ATMOS.moonColor.copy(U.moonColor.value);
  ATMOS.skyAmbient.copy(U.skyAmbient.value);
  ATMOS.groundAmbient.copy(U.groundAmbient.value);
  ATMOS.fogColor.copy(U.fogColor.value);
  ATMOS.night = L.night;
  renderer.toneMappingExposure = U.exposure.value;

  const sun = new THREE.DirectionalLight(body, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  {
    const r = radius * 1.15 + 0.3;
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -r;
    sc.right = sc.top = r;
    sc.near = 0.1;
    sc.far = r * 8 + 20;
    sc.updateProjectionMatrix();
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(sunDir, r * 4 + 10);
    const texel = (2 * r) / 4096;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = texel * 2.5;
  }
  const hemi = new THREE.HemisphereLight(U.skyAmbient.value, U.groundAmbient.value, 1);
  scene.add(sun, sun.target, hemi);

  // sky gradient with a haze around the lit body
  {
    const zenith = uniform(new THREE.Color(L.zenith[0], L.zenith[1], L.zenith[2]));
    const horizon = uniform(new THREE.Color(L.horizon[0], L.horizon[1], L.horizon[2]));
    const glow = uniform(new THREE.Color(L.glow[0], L.glow[1], L.glow[2]));
    const bodyDir = uniform(sunDir.clone());
    const dir = positionWorldDirection;
    const sky = mix(horizon, zenith, pow(max(dir.y, 0.0), float(0.45)));
    const below = mix(horizon, U.fogColor, smoothstep(0.0, -0.25, dir.y));
    const base = mix(below, sky, smoothstep(-0.02, 0.02, dir.y));
    const cosA = max(dot(dir, bodyDir), 0.0);
    scene.backgroundNode = base.add(glow.mul(pow(cosA, float(8)).mul(0.22).add(pow(cosA, float(180)).mul(1.2))));
    // exponential distance fog, thinning with height above the camera (stand-in for gfx/weather)
    const dist = positionView.length();
    const h = max(positionWorld.y.sub(U.camPos.y), 0.0);
    scene.fogNode = fog(U.fogColor, float(1).sub(dist.mul(U.fogDensity).mul(h.mul(U.fogHeight).negate().exp()).negate().exp()));
  }

  // snowy ground: never white. Flat where the models stand, wind-drifted around them so the
  // light has something to roll over, a far disc for the horizon.
  {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const n = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(4.3)).mul(0.3)).add(mx_noise_float(positionWorld.xz.mul(37)).mul(0.2));
    const sunFacing = max(dot(normalWorld, vec3(U.sunDir)), 0.0);
    mat.colorNode = vec3(0.86, 0.885, 0.93).mul(float(0.95).add(n.mul(0.05))).mul(mix(vec3(0.84, 0.91, 1.0), vec3(1.0, 0.985, 0.95), sunFacing));
    mat.fog = true;
    const size = Math.max(24, radius * 10);
    const geo = new THREE.PlaneGeometry(size, size, 192, 192).rotateX(-Math.PI / 2).translate(centre.x, 0, centre.z);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const flatR = radius * 1.05 + 0.3;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x - centre.x, z - centre.z);
      const k = Math.min(1, Math.max(0, (d - flatR) / (1.5 + radius)));
      const edge = Math.min(1, Math.max(0, (size * 0.5 - Math.max(Math.abs(x - centre.x), Math.abs(z - centre.z))) / (size * 0.08)));
      // drifts stretched across the wind (windDir is roughly +X), small ripples on top
      const h = fbm3(11, x * 0.16, 0, z * 0.32, 3) * 0.55 + fbm3(5, x * 1.3, 0, z * 2.2, 2) * 0.05;
      pos.setY(i, h * k * edge - 0.02 * (1 - edge));
    }
    geo.computeVertexNormals();
    const g = new THREE.Mesh(geo, mat);
    g.receiveShadow = true;
    g.name = 'ground';
    const far = new THREE.Mesh(new THREE.CircleGeometry(900, 48).rotateX(-Math.PI / 2).translate(centre.x, -0.02, centre.z), mat);
    far.receiveShadow = true;
    scene.add(g, far);
  }

  // stand-in fire and lamp light, so a model can be judged by its own glow
  if (flag('fire', true)) {
    // about 2 lux-equivalents at a metre from a full campfire: a warm pool, not a second sun
    for (const e of props.emitters('fire')) {
      if (e.def.lit === false) continue;
      const k = Math.max(0.3, Math.min(2, e.size / 0.2)) * (typeof e.def.strength === 'number' ? Math.max(0.2, e.def.strength) : 1);
      const p = new THREE.PointLight(new THREE.Color(PAL.fire[0], PAL.fire[1], PAL.fire[2]), 2.2 * k, 7, 2);
      p.position.copy(e.position).addScaledVector(e.dir, 0.06 + e.size * 0.5);
      scene.add(p);
    }
    for (const l of props.lights()) {
      const p = new THREE.PointLight(new THREE.Color(l.def.color[0], l.def.color[1], l.def.color[2]), l.def.intensity, l.def.range, 2);
      p.position.copy(l.position);
      scene.add(p);
    }
  }

  // hinged parts
  const open = Math.max(0, Math.min(1, num('open', 0)));
  if (open > 0) for (const it of items) props.setOpen(it.id, open);

  // ---- debug drawing ----
  interface Tag { p: THREE.Vector3; text: string; dbg: boolean }
  const tags: Tag[] = [];
  if (flag('labels', true)) {
    for (const it of items) {
      props.matrix(it.id, m4);
      const p = new THREE.Vector3(0, 0, it.def.bounds.max.z + 0.02).applyMatrix4(m4);
      p.y = 0;
      const o = it.spec.opts ? ' ' + Object.entries(it.spec.opts).map(([k, v]) => `${k}=${v}`).join(' ') : '';
      tags.push({ p, text: `${it.spec.name} #${it.seed}${o}  ${it.def.tris}t`, dbg: false });
    }
  }
  if (debug) {
    const pos: number[] = [], col: number[] = [];
    const line = (a: THREE.Vector3, b: THREE.Vector3, c: [number, number, number]): void => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      col.push(...c, ...c);
    };
    const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix4(m4);
    for (const it of items) {
      props.matrix(it.id, m4);
      const b = it.def.bounds;
      const cs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) line(cs[i], cs[j], [0.25, 0.6, 1]);
      const k = Math.max(0.03, it.def.radius * 0.06);
      const cross = (p: THREE.Vector3, c: [number, number, number]): void => {
        line(p.clone().setX(p.x - k), p.clone().setX(p.x + k), c);
        line(p.clone().setY(p.y - k), p.clone().setY(p.y + k), c);
        line(p.clone().setZ(p.z - k), p.clone().setZ(p.z + k), c);
      };
      for (const a of Object.values(it.def.anchors)) {
        const p = a.position.clone().applyMatrix4(m4);
        cross(p, [0.3, 1, 0.4]);
        tags.push({ p, text: a.name, dbg: true });
      }
      for (const e of props.emittersOf(it.id)) {
        cross(e.position, [1, 0.5, 0.1]);
        line(e.position, e.position.clone().addScaledVector(e.dir, e.size * 2 + 0.1), [1, 0.5, 0.1]);
        tags.push({ p: e.position, text: e.type + (e.name ? ' ' + e.name : ''), dbg: true });
      }
      for (const l of it.def.lights) {
        const p = l.position.clone().applyMatrix4(m4);
        cross(p, [1, 1, 0.3]);
        tags.push({ p, text: 'light' + (l.name ? ' ' + l.name : ''), dbg: true });
      }
      for (const part of Object.values(it.def.parts)) {
        const p = part.pivot.clone().applyMatrix4(m4);
        cross(p, [1, 0.3, 1]);
        line(p, p.clone().add(part.axis.clone().transformDirection(m4).multiplyScalar(k * 4)), [1, 0.3, 1]);
        tags.push({ p, text: 'part ' + part.name, dbg: true });
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lm = new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false });
    const lines = new THREE.LineSegments(g, lm);
    lines.renderOrder = 10;
    lines.frustumCulled = false;
    scene.add(lines);
  }

  // ---- views ----
  const n = views.length;
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rowsN = Math.ceil(n / cols);
  const zoom = num('zoom', 1);
  const tagLayers: HTMLDivElement[] = [];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none';
    document.body.appendChild(d);
    tagLayers.push(d);
    for (const t of tags) {
      const e = document.createElement('div');
      e.className = t.dbg ? 'tag dbg' : 'tag';
      e.textContent = t.text;
      d.appendChild(e);
    }
  }

  const corner = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), toCam = new THREE.Vector3();
  /** Put the camera on the (az, el) direction at the distance that just fits the bounds in a tile. */
  function frame(view: { az: number; el: number }, aspect: number): void {
    const az = view.az * DEG, el = view.el * DEG;
    toCam.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    right.set(Math.cos(az), 0, -Math.sin(az));
    up.crossVectors(toCam, right).normalize();
    const ty = Math.tan((fov * DEG) / 2), tx = ty * aspect;
    let dist = 0.2;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      const z = corner.dot(toCam);
      dist = Math.max(dist, z + Math.abs(corner.dot(up)) / ty, z + Math.abs(corner.dot(right)) / tx);
    }
    dist = (dist * 1.12) / zoom;
    camera.aspect = aspect;
    camera.near = Math.max(0.02, dist * 0.02);
    camera.far = 4000;
    camera.position.copy(centre).addScaledVector(toCam, dist);
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  let controls: OrbitControls | null = null;
  if (n === 1) {
    frame(views[0], window.innerWidth / window.innerHeight);
    controls = new OrbitControls(camera, canvas);
    controls.target.copy(centre);
    controls.enableDamping = false;
    controls.update();
  }

  const proj = new THREE.Vector3();
  function placeTags(i: number, x: number, y: number, w: number, h: number): void {
    const layer = tagLayers[i];
    layer.style.left = x + 'px';
    layer.style.top = y + 'px';
    layer.style.width = w + 'px';
    layer.style.height = h + 'px';
    for (let k = 0; k < tags.length; k++) {
      const e = layer.children[k] as HTMLDivElement;
      proj.copy(tags[k].p).project(camera);
      const vis = proj.z > -1 && proj.z < 1;
      e.style.display = vis ? '' : 'none';
      e.style.position = 'absolute';
      e.style.left = ((proj.x * 0.5 + 0.5) * w).toFixed(1) + 'px';
      e.style.top = ((0.5 - proj.y * 0.5) * h + (tags[k].dbg ? -14 : 4)).toFixed(1) + 'px';
    }
  }

  const fixedTime = Q.has('t') ? num('t', 2.5) : null;
  const clock0 = performance.now();
  const frameInfo = { dt: 1 / 60, time: 0, view: null as any };
  let frames = 0;
  let calls = 0, tris = 0;

  function render(): void {
    const W = window.innerWidth, H = window.innerHeight;
    const time = fixedTime ?? (performance.now() - clock0) / 1000;
    U.time.value = time;
    frameInfo.time = time;
    const tw = W / cols, th = H / rowsN;
    calls = 0;
    tris = 0;
    for (let i = 0; i < n; i++) {
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      if (controls) {
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      } else frame(views[i], tw / th);
      camera.getWorldPosition(U.camPos.value);
      if (i === 0) props.update(frameInfo);
      if (n > 1) {
        renderer.setViewport(x, y, tw, th);
        renderer.setScissor(x, y, tw, th);
        renderer.setScissorTest(true);
      }
      renderer.render(scene, camera);
      const ri = (renderer.info as any).render;
      calls += ri.drawCalls ?? ri.calls ?? 0;
      tris += ri.triangles ?? 0;
      placeTags(i, x, y, tw, th);
    }
    frames++;
  }

  function resize(): void {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', resize);

  (window as any).MODEL_INFO = items.map((it) => {
    const s = it.def.bounds.getSize(new THREE.Vector3());
    return {
      name: it.spec.name, seed: it.seed, opts: it.spec.opts ?? null, tris: it.def.tris,
      size: [s.x, s.y, s.z].map((v) => Math.round(v * 1000) / 1000),
      anchors: Object.keys(it.def.anchors), emitters: it.def.emitters.map((e) => e.type + (e.name ? ':' + e.name : '')),
      lights: it.def.lights.length, parts: Object.keys(it.def.parts), glass: !!it.def.glass,
      registered: hasModel(it.spec.name), size_class: modelMeta(it.spec.name).size,
    };
  });

  // Compile before the first visible frame so the screenshot never catches a half-built pipeline.
  frame(views[0], n > 1 ? window.innerWidth / cols / (window.innerHeight / rowsN) : window.innerWidth / window.innerHeight);
  await renderer.compileAsync(scene, camera);

  const writeInfo = (): void => {
    const totalTris = items.reduce((s, it) => s + it.def.tris, 0);
    info.textContent = `three r${THREE.REVISION} ${backend}  ${lightName}  snow ${U.snowCover.value}  ${items.length} models ${totalTris} tris  ${props.info.batches} batches  ${calls} calls ${(tris / 1000).toFixed(1)}k tris drawn` + (failed.length ? `\nfailed to load: ${failed.join(', ')}` : '');
  };

  renderer.setAnimationLoop(() => {
    if (fixedTime !== null && frames >= 4 && !controls) return; // a still: nothing changes any more
    render();
    if (frames === 3) {
      writeInfo();
      (window as any).DONE = true;
    } else if (frames % 30 === 0) writeInfo();
  });
}

main().catch((err) => {
  console.error(err);
  info.textContent = String(err && err.stack ? err.stack : err);
});
