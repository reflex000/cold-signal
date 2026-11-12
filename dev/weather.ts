// Weather bench: the real sky and weather systems over a flat snowfield with dark posts at 2, 5, 10,
// 20, 50, 100 and 200 m straight ahead (north), so visibility can be read off the picture, plus a
// few trees' worth of dark trunks off to the side for the storm to stream past.
//
//   dev/weather.html?storm=0.5&wind=14&winddir=135&clock=13&gust=0&q=medium[&webgl=1]
//   &ui=0   no slider panel (screenshots)
//   plus everything dev/bench.ts reads (az, el, dist, tx, ty, tz, fov, t, frames, hud ...)
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import { createSkySystem } from '../src/gfx/sky';
import { deriveEnv, makeBenchView, removeStandIns, sliderPanel, syncViewCamera, withView } from '../src/gfx/sky/benchkit';
import { createWeatherSystem } from '../src/gfx/weather';
import { VOL_DEBUG } from '../src/gfx/weather/volume';
import { U } from '../src/gfx/shared';
import { AIR } from '../src/gfx/sky/common';
import { createBench } from './bench';

const q = new URLSearchParams(location.search);
const b = await createBench({ light: 'day', ground: true, orbit: true });
const { engine, scene, camera } = b;
removeStandIns(scene, b.sun);
// Stand at the origin, eye height, looking north along the posts.
if (!q.has('az')) b.orbit.az = 0;
if (!q.has('el')) b.orbit.el = -2;
if (!q.has('dist')) b.orbit.dist = 0.4;
if (!q.has('ty')) b.orbit.target.y = 1.7;
if (!q.has('tz')) b.orbit.target.z = -0.4;

const { view, env } = makeBenchView(camera, { clock: b.num('clock', 13), day: b.num('day', 0), storm: b.num('storm', 0.5) });
const settings = { wind: q.has('wind') ? b.num('wind', 10) : -1, dir: b.num('winddir', 120), gust: b.num('gust', 0) };
const derive = (): void => {
  deriveEnv(env, { wind: settings.wind >= 0 ? settings.wind : undefined, windDeg: settings.dir, aurora: b.num('aurora', 0), cloud: q.has('cloud') ? b.num('cloud', 0.5) : undefined });
  env.gust = settings.gust;
};
derive();

VOL_DEBUG.mode = b.num('voldebug', 0);
const sky = createSkySystem(engine, null);
engine.add(withView(sky, view));
const weather = createWeatherSystem(engine, null);
engine.add(withView(weather, view));

// ---- posts along -Z (north) ----
{
  const wood = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.035, 0.03, 0.026), roughness: 0.9 });
  const geo = new THREE.CylinderGeometry(0.09, 0.1, 2.4, 10);
  for (const d of [2, 5, 10, 20, 50, 100, 200]) {
    const scale = Math.max(1, d / 18); // far posts thicker so they stay a few pixels wide
    const m = new THREE.Mesh(geo, wood);
    m.scale.set(scale, Math.max(1, d / 40), scale);
    m.position.set(0.6, 1.2 * m.scale.y, -d);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  // A loose stand of dark trunks to the left: something for the streaks to cross.
  const trunk = new THREE.CylinderGeometry(0.18, 0.26, 9, 8);
  let s = 11;
  const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(trunk, wood);
    m.position.set(-6 - rnd() * 40, 4.5, -4 - rnd() * 90);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
}

b.onFrame((_dt, time) => syncViewCamera(view, camera, time));

sliderPanel(
  [
    { key: 'storm', label: 'storm', min: 0, max: 1, step: 0.01, get: () => env.storm, set: (v) => ((env.storm = v), derive()) },
    { key: 'wind', label: 'wind m/s', min: -1, max: 26, step: 0.5, get: () => settings.wind, set: (v) => ((settings.wind = v), derive()) },
    { key: 'dir', label: 'wind dir', min: 0, max: 360, step: 5, get: () => settings.dir, set: (v) => ((settings.dir = v), derive()) },
    { key: 'gust', label: 'gust', min: 0, max: 1, step: 0.01, get: () => settings.gust, set: (v) => ((settings.gust = v), derive()) },
    { key: 'clock', label: 'clock', min: 0, max: 24, step: 0.05, get: () => env.clock, set: (v) => (env.clock = v) },
  ],
  b.param('ui') !== '0',
);
(window as any).WEATHER = weather;
(window as any).ATMOS_DEBUG = { U, AIR, env };
