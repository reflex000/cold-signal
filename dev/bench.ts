// Bench helper for every dev page: a canvas, the real engine and post pipeline, a stand-in for the
// sky (sun, ambient, gradient background, fog) in four lights, and an orbit camera.
//
//   import { createBench } from './bench';
//   const b = await createBench({ light: 'dusk' });
//   b.scene.add(myThing);
//   b.onFrame((dt, time) => { ... });
//
// URL parameters (all optional):
//   ?light=day|dusk|night|storm   ?q=mobile|low|medium|high|ultra   ?webgl=1
//   ?az=35 ?el=12 ?dist=14        orbit camera: azimuth and elevation in degrees, distance in metres
//   ?tx=0 ?ty=1 ?tz=0             orbit target        ?fov=55
//   ?t=12.5                       freeze the clock at this time (stable screenshots)
//   ?frames=8                     frames rendered before window.DONE is set
//   ?hud=1                        show fps / draw calls / backend in a corner
//   ?exp=1.2                      multiply the exposure       ?tm=aces   tone mapper (default agx)
//   ?dyn=1                        dynamic resolution          ?ldr=1 ?depth=standard   fallback paths
//   ?gpu=0                        no GPU timestamp queries
//
// The page must have <link rel="icon" href="data:,"> in its head. It sets window.BACKEND and, once
// the picture is on screen, window.DONE = true (tools/shot.mjs waits for that).
// Owner: ENGINE. Keep it small: the real sky, weather and terrain are their own modules.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Frame, QualityName } from '../src/gfx/api';
import { detectDevice, pickQuality } from '../src/gfx/detect';
import { createEngine, type CsEngine } from '../src/gfx/engine';
import { isQualityName } from '../src/gfx/quality';
import { ATMOS, U } from '../src/gfx/shared';

const { fog, positionView, positionWorldDirection, positionWorld, uniform, vec3, float, mix, smoothstep, max, dot, pow, mx_noise_float } = TSL as any;

export type LightName = 'day' | 'dusk' | 'night' | 'storm';

export interface BenchOptions {
  light?: LightName;
  quality?: QualityName;
  /** Orbit camera controls (mouse and touch). Default true. */
  orbit?: boolean;
  /** A large snow ground plane at y = 0. Default true. */
  ground?: boolean;
}

export interface Bench {
  engine: CsEngine;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** The stand-in sun (or moon at night). Casts the shadows. */
  sun: THREE.DirectionalLight;
  light: LightName;
  setLight(name: LightName): void;
  /** Called every frame before the engine renders. `time` is the bench clock in seconds. */
  onFrame(fn: (dt: number, time: number) => void): void;
  /** Orbit camera state: change it and it applies on the next frame. */
  orbit: { az: number; el: number; dist: number; target: THREE.Vector3 };
  /** Hold window.DONE back until this promise settles (a page that builds its scene asynchronously). */
  busy(p: Promise<unknown>): void;
  /** URL parameter helpers for pages that add their own. */
  param(name: string): string | null;
  num(name: string, fallback: number): number;
}

interface LightPreset {
  sunAz: number; // degrees, 0 = north (-Z), clockwise seen from above
  sunEl: number; // degrees above the horizon
  sun: [number, number, number]; // linear colour times intensity, of whichever body lights the scene
  moon: boolean; // the lit body is the moon
  sky: [number, number, number]; // hemisphere sky colour
  ground: [number, number, number]; // hemisphere ground (bounce) colour
  zenith: [number, number, number]; // background gradient
  horizon: [number, number, number];
  glow: [number, number, number]; // colour of the haze around the sun
  fog: [number, number, number];
  fogDensity: number;
  exposure: number;
  night: number;
  storm: number;
  snowfall: number;
  wind: number;
}

// Scene-referred units: a white surface facing a light of colour 3.14 has radiance 1.
const LIGHTS: Record<LightName, LightPreset> = {
  // Clear winter afternoon, low sun.
  day: {
    sunAz: 215, sunEl: 21, sun: [10.5, 8.9, 6.9], moon: false,
    sky: [0.5, 0.72, 1.15], ground: [0.5, 0.55, 0.66],
    zenith: [0.1, 0.24, 0.62], horizon: [0.62, 0.78, 1.02], glow: [1.6, 1.25, 0.8],
    fog: [0.6, 0.75, 0.98], fogDensity: 0.00035, exposure: 0.62, night: 0, storm: 0, snowfall: 0, wind: 3,
  },
  // Sun on the horizon: cream light, long blue shadows.
  dusk: {
    sunAz: 248, sunEl: 5.5, sun: [5.2, 2.7, 1.25], moon: false,
    sky: [0.2, 0.3, 0.6], ground: [0.16, 0.19, 0.3],
    zenith: [0.035, 0.07, 0.24], horizon: [0.6, 0.36, 0.3], glow: [2.6, 1.1, 0.4],
    fog: [0.32, 0.31, 0.43], fogDensity: 0.0006, exposure: 1.5, night: 0.25, storm: 0, snowfall: 0, wind: 4,
  },
  // Clear night, half moon. Dark: the fire and the flashlight are the light.
  night: {
    sunAz: 140, sunEl: 38, sun: [0.07, 0.095, 0.15], moon: true,
    sky: [0.008, 0.012, 0.026], ground: [0.004, 0.005, 0.009],
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

export async function createBench(o: BenchOptions = {}): Promise<Bench> {
  const url = new URLSearchParams(location.search);
  const param = (name: string): string | null => url.get(name);
  const num = (name: string, fallback: number): number => {
    const v = url.get(name);
    const n = v === null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const flag = (name: string): boolean => {
    const v = url.get(name);
    return v !== null && v !== '0' && v !== 'false';
  };

  // Page chrome: a full-window canvas, whatever the page's own CSS says.
  const css = document.createElement('style');
  css.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden;overscroll-behavior:none}canvas.bench{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none}#bench-hud{position:fixed;left:8px;top:8px;color:#dfe5ec;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000}';
  document.head.appendChild(css);
  const canvas = document.createElement('canvas');
  canvas.className = 'bench';
  document.body.appendChild(canvas);

  const device = await detectDevice();
  const qp = param('q');
  const quality: QualityName = isQualityName(qp) ? qp : o.quality ?? pickQuality(device);
  const engine = await createEngine(canvas, {
    quality,
    forceWebGL: flag('webgl'),
    forceLDR: flag('ldr'),
    depth: param('depth') === 'standard' ? 'standard' : 'auto',
    gpuTiming: param('gpu') !== '0',
    dynamicResolution: flag('dyn'),
  });
  (window as any).BACKEND = engine.backend;
  (window as any).ENGINE = engine;
  if (param('tm') === 'aces') engine.post.tonemap = 'aces';
  const { scene, camera } = engine;
  camera.fov = num('fov', 55);
  camera.updateProjectionMatrix();

  // ---- light: one directional body, a hemisphere, a gradient sky, distance fog ----
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = engine.quality.shadowCascades > 0;
  const smap = Math.min(engine.quality.shadowMapSize * 2, 4096); // one map stands in for the cascades
  sun.shadow.mapSize.set(smap, smap);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -26;
  sc.right = sc.top = 26;
  sc.near = 1;
  sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  scene.add(sun, sun.target, hemi);

  const zenith: any = uniform(new THREE.Color());
  const horizon: any = uniform(new THREE.Color());
  const glow: any = uniform(new THREE.Color());
  // The lit body as the background sees it: the sun by day, the moon at night.
  const bodyDir: any = uniform(new THREE.Vector3(0, 1, 0));
  const bodyColor: any = uniform(new THREE.Color());
  {
    const dir: any = positionWorldDirection;
    const up = max(dir.y, 0.0);
    const sky = mix(horizon, zenith, pow(up, float(0.45)));
    const below = mix(horizon, U.fogColor, smoothstep(0.0, -0.25, dir.y));
    const base = mix(below, sky, smoothstep(-0.02, 0.02, dir.y));
    // Haze around the lit body, and a small hot disc so bloom has something real to chew on.
    const cosA = max(dot(dir, bodyDir), 0.0);
    const halo = pow(cosA, float(8)).mul(0.22).add(pow(cosA, float(180)).mul(1.2));
    const disc = smoothstep(0.99985, 0.99996, cosA).mul(float(60).mul(float(1).sub(U.storm)));
    scene.backgroundNode = base.add(glow.mul(halo)).add(bodyColor.mul(disc));
  }
  {
    // Exponential distance fog in the scene pass, thinning with height above the camera.
    const dist = positionView.length();
    const h = max(positionWorld.y.sub(U.camPos.y), 0.0);
    const amount = float(1).sub(dist.mul(U.fogDensity).mul(h.mul(U.fogHeight).negate().exp()).negate().exp());
    scene.fogNode = fog(U.fogColor, amount);
  }

  if (o.ground !== false) {
    const g = new THREE.Mesh(new THREE.CircleGeometry(600, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 }));
    const n: any = mx_noise_float(positionWorld.xz.mul(0.35)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(2.3)).mul(0.25));
    (g.material as any).colorNode = vec3(0.86, 0.885, 0.93).mul(float(0.96).add(n.mul(0.05)));
    g.receiveShadow = true;
    g.name = 'bench-ground';
    scene.add(g);
  }

  const sunDir = new THREE.Vector3();
  const bench = {} as Bench;
  const exposureMul = num('exp', 1);
  function setLight(name: LightName): void {
    const L = LIGHTS[name] ?? LIGHTS.day;
    bench.light = name;
    const az = L.sunAz * DEG;
    const el = L.sunEl * DEG;
    // Azimuth 0 = north (-Z), clockwise from above: east is +X.
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const body = new THREE.Color(L.sun[0], L.sun[1], L.sun[2]);
    const dark = new THREE.Color(0, 0, 0);
    const far = new THREE.Vector3(-sunDir.x, -0.4, -sunDir.z).normalize(); // the other body, below the horizon
    U.sunDir.value.copy(L.moon ? far : sunDir);
    U.sunColor.value.copy(L.moon ? dark : body);
    U.moonDir.value.copy(L.moon ? sunDir : far);
    U.moonColor.value.copy(L.moon ? body : dark);
    U.skyAmbient.value.setRGB(L.sky[0], L.sky[1], L.sky[2]);
    U.groundAmbient.value.setRGB(L.ground[0], L.ground[1], L.ground[2]);
    U.fogColor.value.setRGB(L.fog[0], L.fog[1], L.fog[2]);
    U.fogDensity.value = L.fogDensity;
    U.fogHeight.value = name === 'storm' ? 0.0005 : 0.004;
    U.night.value = L.night;
    U.storm.value = L.storm;
    U.snowfall.value = L.snowfall;
    U.windSpeed.value = L.wind;
    U.gust.value = L.storm * 0.5;
    U.visibility.value = Math.min(4000, 3 / Math.max(L.fogDensity, 1e-5));
    U.exposure.value = L.exposure * exposureMul;
    ATMOS.sunDir.copy(U.sunDir.value);
    ATMOS.sunColor.copy(U.sunColor.value);
    ATMOS.sunIntensity = L.moon ? 0 : 1;
    ATMOS.moonDir.copy(U.moonDir.value);
    ATMOS.moonColor.copy(U.moonColor.value);
    ATMOS.skyAmbient.copy(U.skyAmbient.value);
    ATMOS.groundAmbient.copy(U.groundAmbient.value);
    ATMOS.fogColor.copy(U.fogColor.value);
    ATMOS.night = L.night;
    ATMOS.luminance = 0.18 / L.exposure;
    sun.color.copy(body);
    hemi.color.copy(U.skyAmbient.value);
    hemi.groundColor.copy(U.groundAmbient.value);
    zenith.value.setRGB(L.zenith[0], L.zenith[1], L.zenith[2]);
    horizon.value.setRGB(L.horizon[0], L.horizon[1], L.horizon[2]);
    glow.value.setRGB(L.glow[0], L.glow[1], L.glow[2]);
    bodyDir.value.copy(sunDir);
    bodyColor.value.copy(body);
  }
  const lp = param('light');
  setLight((lp && lp in LIGHTS ? lp : o.light ?? 'day') as LightName);

  // ---- orbit camera ----
  const orbit = {
    az: num('az', 30),
    el: num('el', 14),
    dist: num('dist', 12),
    target: new THREE.Vector3(num('tx', 0), num('ty', 1), num('tz', 0)),
  };
  if (o.orbit !== false) {
    const ptr = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch = 0;
    });
    const up = (e: PointerEvent): void => {
      ptr.delete(e.pointerId);
      pinch = 0;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointermove', (e) => {
      const p = ptr.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptr.size >= 2) {
        // Two fingers: pinch to zoom, drag to pan.
        const [a, b] = [...ptr.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) orbit.dist = Math.min(400, Math.max(0.3, (orbit.dist * pinch) / Math.max(d, 1)));
        pinch = d;
        pan(dx * 0.5, dy * 0.5);
      } else if (e.buttons === 2 || e.shiftKey) {
        pan(dx, dy);
      } else {
        orbit.az -= dx * 0.3;
        orbit.el = Math.min(89, Math.max(-20, orbit.el + dy * 0.3));
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbit.dist = Math.min(400, Math.max(0.3, orbit.dist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    const right = new THREE.Vector3();
    const upv = new THREE.Vector3();
    function pan(dx: number, dy: number): void {
      const k = (orbit.dist * Math.tan((camera.fov * DEG) / 2) * 2) / Math.max(1, canvas.clientHeight);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      upv.setFromMatrixColumn(camera.matrixWorld, 1);
      orbit.target.addScaledVector(right, -dx * k).addScaledVector(upv, dy * k);
    }
  }
  function placeCamera(): void {
    const az = orbit.az * DEG;
    const el = orbit.el * DEG;
    // Azimuth is where the camera looks toward: az 0 looks north (-Z), from the south.
    camera.position.set(orbit.target.x - Math.sin(az) * Math.cos(el) * orbit.dist, orbit.target.y + Math.sin(el) * orbit.dist, orbit.target.z + Math.cos(az) * Math.cos(el) * orbit.dist);
    camera.lookAt(orbit.target);
    // The shadow box follows the target so the stand-in sun always covers what is looked at.
    sun.target.position.copy(orbit.target);
    sun.position.copy(orbit.target).addScaledVector(sunDir, 80);
  }

  // ---- loop ----
  const hud = flag('hud') ? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'bench-hud' })) : null;
  const callbacks: ((dt: number, time: number) => void)[] = [];
  const frozen = url.has('t');
  const framesWanted = Math.max(2, num('frames', 8));
  const frame: Frame = { dt: 1 / 60, time: num('t', 0), view: undefined as unknown as Frame['view'] };
  let last = performance.now();
  let count = 0;
  let started = false;
  let waiting = 0;

  function tick(): void {
    if (engine.lost) {
      (window as any).DONE = true; // nothing more will be drawn: let a waiting tool report the console
      return;
    }
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
    last = now;
    frame.dt = frozen ? 1 / 60 : dt;
    if (!frozen) frame.time += dt;
    placeCamera();
    for (const fn of callbacks) fn(frame.dt, frame.time);
    engine.frame(frame);
    if (engine.lost) (window as any).DONE = true;
    if (hud && count % 10 === 0) {
      const s = engine.stats;
      const a = engine.post.active;
      hud.textContent = `${engine.backend} ${engine.quality.name} ${engine.width}x${engine.height}${engine.dynScale < 1 ? ' dyn ' + engine.dynScale.toFixed(2) : ''}  ${engine.hdr ? 'hdr' : 'ldr8'} ${engine.depthMode}\n${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms  gpu ${s.gpuMs.toFixed(1)} ms  ${s.calls} calls  ${(s.tris / 1000).toFixed(1)}k tris\nao ${a.ao ? 'on' : 'off'}  bloom ${a.bloom ? 'on' : 'off'}  aa ${a.aa}  ${bench.light}`;
    }
    // Temporal AA needs a few more frames to settle before a screenshot.
    if (waiting > 0) count = 0;
    else if (++count === (engine.post.active.aa === 'taa' ? Math.max(framesWanted, 40) : framesWanted)) (window as any).DONE = true;
  }

  bench.engine = engine;
  bench.scene = scene;
  bench.camera = camera;
  bench.canvas = canvas;
  bench.sun = sun;
  bench.setLight = setLight;
  bench.orbit = orbit;
  bench.param = param;
  bench.num = num;
  bench.onFrame = (fn) => {
    callbacks.push(fn);
  };
  bench.busy = (p) => {
    waiting++;
    const done = (): void => {
      waiting--;
    };
    p.then(done, done);
  };

  // The page builds its scene after this returns; start on the next task so the first frame
  // (and the warm-up compile) already sees it.
  setTimeout(async () => {
    if (started) return;
    started = true;
    placeCamera();
    await engine.warmup();
    last = performance.now();
    requestAnimationFrame(tick);
  }, 0);

  return bench;
}
