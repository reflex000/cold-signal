// Sky bench: the real sky and weather systems over a snowfield with far ridges, a few posts, a
// chrome ball and a snowball, driven by sliders (or URL parameters).
//
//   dev/sky.html?clock=16.75&cloud=0.3&aurora=0&storm=0&day=0&q=medium[&webgl=1]
//   &strip=1      eight clock times tiled into one image (08:30 .. 22:00) at the other settings
//   &run=60       let the clock run (game hours per real hour; 60 = one game hour a minute)
//   &ui=0         no slider panel (screenshots)
//   plus everything dev/bench.ts reads (az, el, dist, tx, ty, tz, fov, t, frames, hud, exp ...)
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createSkySystem } from '../src/gfx/sky';
import { deriveEnv, makeBenchView, removeStandIns, sliderPanel, syncViewCamera, withView } from '../src/gfx/sky/benchkit';
import { createWeatherSystem } from '../src/gfx/weather';
import { fbm2, ridged2 } from '../src/core/noise';
import { createBench } from './bench';

const { vec3, float, mix, smoothstep, positionWorld, normalWorld, mx_noise_float } = TSL as any;

const strip = new URLSearchParams(location.search).get('strip') === '1';
const b = await createBench({ light: 'day', ground: true, orbit: true });
const { engine, scene, camera } = b;
removeStandIns(scene, b.sun);
if (!new URLSearchParams(location.search).has('az')) b.orbit.az = 215;
if (!new URLSearchParams(location.search).has('el')) b.orbit.el = 3;
if (!new URLSearchParams(location.search).has('dist')) b.orbit.dist = 16;
if (!new URLSearchParams(location.search).has('ty')) b.orbit.target.y = 2.2;

const cloudParam = b.param('cloud');
const { view, env } = makeBenchView(camera, { clock: b.num('clock', 12.4), day: b.num('day', 0), storm: b.num('storm', 0) });
const settings = { cloud: cloudParam !== null ? b.num('cloud', 0.1) : -1, aurora: b.num('aurora', 0) };
const derive = (): void => deriveEnv(env, { cloud: settings.cloud >= 0 ? settings.cloud : undefined, aurora: settings.aurora });
derive();

const sky = createSkySystem(engine, null);
engine.add(withView(sky, view));
const weather = createWeatherSystem(engine, null);
engine.add(withView(weather, view));
// debugging switches: &noao=1 (no ambient occlusion), &nostorm=1 (no storm stage)
if (b.param('noao') === '1') engine.post.uniforms.aoStrength.value = 0;
if (b.param('nostorm') === '1') engine.post.remove('storm');

// ---- scenery ----
{
  // A ring of mountains 0.9 to 6 km out: aerial perspective, snowlines, the low sun on slopes.
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const steep: any = smoothstep(0.55, 0.8, normalWorld.y);
  const n: any = mx_noise_float(positionWorld.xz.mul(0.01)).mul(0.5).add(0.5);
  (mat as any).colorNode = mix(vec3(0.045, 0.047, 0.052), vec3(0.8, 0.82, 0.86).mul(float(0.9).add(n.mul(0.1))), steep);
  const SIZE = 12000, SEG = 240;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), z = p.getZ(k);
    const r = Math.hypot(x, z);
    const ring = Math.min(1, Math.max(0, (r - 1500) / 1400));
    const m = ridged2(29, x / 2100, z / 2100, 5) * 0.75 + fbm2(31, x / 900, z / 900, 4) * 0.25;
    p.setY(k, ring * ring * (3 - 2 * ring) * (60 + 640 * Math.max(0, m)) - 0.05);
  }
  geo.computeVertexNormals();
  const mountains = new THREE.Mesh(geo, mat);
  mountains.receiveShadow = true;
  scene.add(mountains);
  // Near: dark posts, a chrome ball (reflects the sky), a snowball, a rock.
  const post = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.05, 0.04, 0.035), roughness: 0.85 });
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 2.2, 10), post);
    m.position.set(-3 + i * 1.6, 1.1, -2 - i * 0.7);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  const chrome = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 24), new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 1, roughness: 0.08 }));
  chrome.position.set(1.8, 0.7, 1.5);
  chrome.castShadow = chrome.receiveShadow = true;
  const snowball = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 24), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.86, 0.885, 0.93), roughness: 0.8 }));
  snowball.position.set(-1.2, 0.7, 1.8);
  snowball.castShadow = snowball.receiveShadow = true;
  const rockGeo = new THREE.IcosahedronGeometry(1.1, 3);
  const rp = rockGeo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < rp.count; k++) {
    const v = new THREE.Vector3(rp.getX(k), rp.getY(k), rp.getZ(k));
    v.multiplyScalar(1 + 0.18 * Math.sin(v.x * 3.1) * Math.cos(v.z * 2.3) + 0.08 * Math.sin(v.y * 7));
    rp.setXYZ(k, v.x * 1.3, v.y * 0.7, v.z);
  }
  rockGeo.computeVertexNormals();
  const rock = new THREE.Mesh(rockGeo, new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.045, 0.045, 0.05), roughness: 0.9 }));
  rock.position.set(4.5, 0.3, -1);
  rock.castShadow = rock.receiveShadow = true;
  scene.add(chrome, snowball, rock);
}

// ---- driving ----
const run = b.num('run', 0);
b.onFrame((dt, time) => {
  syncViewCamera(view, camera, time);
  if (run > 0 && !strip) {
    env.clock += (dt * run) / 3600;
    if (env.clock >= 24) {
      env.clock -= 24;
      env.day++;
    }
  }
});

sliderPanel(
  [
    { key: 'clock', label: 'clock', min: 0, max: 24, step: 0.05, get: () => env.clock, set: (v) => (env.clock = v) },
    { key: 'day', label: 'day', min: 0, max: 6, step: 1, get: () => env.day, set: (v) => (env.day = v) },
    { key: 'storm', label: 'storm', min: 0, max: 1, step: 0.01, get: () => env.storm, set: (v) => ((env.storm = v), derive()) },
    { key: 'cloud', label: 'cloud', min: -0.01, max: 1, step: 0.01, get: () => settings.cloud, set: (v) => ((settings.cloud = v), derive()) },
    { key: 'aurora', label: 'aurora', min: 0, max: 1, step: 0.01, get: () => settings.aurora, set: (v) => ((settings.aurora = v), derive()) },
    { key: 'bias', label: 'exp bias', min: -3, max: 3, step: 0.1, get: () => sky.exposureBias, set: (v) => (sky.exposureBias = v) },
  ],
  b.param('ui') !== '0' && !strip,
);

// ---- strip: eight clock times tiled into one picture ----
if (strip) {
  const times = (b.param('times') ?? '8.5,12.4,16,16.75,17.25,17.75,19.5,22').split(',').map(Number).slice(0, 8);
  const out = document.createElement('canvas');
  const cols = times.length > 4 ? 4 : times.length, rows = times.length > 4 ? 2 : 1;
  let tile = 0;
  let done!: () => void;
  b.busy(new Promise<void>((r) => (done = r)));
  const frame = { dt: 1 / 60, time: b.num('t', 0), view };
  b.onFrame(() => {
    if (tile >= times.length) return;
    if (tile === 0) {
      out.width = engine.canvas.width;
      out.height = engine.canvas.height;
    }
    env.clock = times[tile];
    syncViewCamera(view, camera, frame.time);
    sky.settle(frame);
    weather.update(frame);
    for (let k = 0; k < 4; k++) engine.frame(frame as any);
    const ctx = out.getContext('2d')!;
    const w = out.width / cols, h = out.height / rows;
    const x = (tile % cols) * w, y = Math.floor(tile / cols) * h;
    ctx.drawImage(engine.canvas, 0, 0, engine.canvas.width, engine.canvas.height, x, y, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + 6, y + 6, 64, 20);
    ctx.fillStyle = '#e8edf2';
    ctx.font = `${Math.round(h / 24)}px ui-monospace, Consolas, monospace`;
    const hh = Math.floor(times[tile]), mm = Math.round((times[tile] - hh) * 60);
    ctx.fillText(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, x + 10, y + 21);
    tile++;
    if (tile === times.length) {
      out.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:5';
      document.body.appendChild(out);
      done();
    }
  });
}
