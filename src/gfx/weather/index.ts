// The weather system: all the air. Fog for every lit material (scene.fogNode), the storm volume
// (HDR stage 'storm', order 100), falling and blowing snow around the camera, spindrift over the
// ground, and the whiteout wash (overlay 'whiteout', order 100).
//
//   const weather = createWeatherSystem(engine, world);   engine.add(weather);   // after 'sky'
//   hud.whiteout = weather.whiteout;
//
// Reads f.view.env (storm, snowfall, visibility, windX, windZ, gust) and f.view.camera. Writes
// U.windDir, windSpeed, gust, storm, snowfall, visibility, fogColor, fogDensity, fogHeight and
// ATMOS.fogColor. The light it fogs with comes from the sky system (U.skyAmbient, U.sunColor ...).
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Engine, Frame, GfxSystem, Quality } from '../api';
import type { PostApi } from '../post';
import type { World } from '../../world/types';
import { ATMOS, U } from '../shared';
import { AIR, fogAmount, fogColor, syncGlobals } from '../sky/common';
import { SNOWU, SNOW_PERIOD, SnowLayer } from './snow';
import { DRIFTU, Spindrift } from './spindrift';
import { StormVolumeNode, VOLU, compositeVolume, screenStreaks } from './volume';

const { fog, uniform, vec3, mix, max, length, luminance, positionWorld, cameraPosition } = TSL as any;

export interface WeatherSystem extends GfxSystem {
  /** 0..1 how far the whiteout wash is applied (for the HUD). */
  readonly whiteout: number;
  /** Visibility in metres this frame. */
  readonly visibility: number;
}

const VOL_SCALE = 0.5;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** ACES filmic (three's fit, with its 1/0.6 pre-scale) then the sRGB transfer: a display value. */
function displayOf(x: number): number {
  const v = x / 0.6;
  const a = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  const c = Math.max(0, Math.min(1, a));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function createWeatherSystem(engine: Engine, world: World | null = null): WeatherSystem {
  const scene = engine.scene;
  const post = (engine as any).post as PostApi | undefined;
  const hdr = (engine as any).hdr !== false;
  let quality = engine.quality;
  let volActive = false;

  // ---- fog on every lit material ----
  {
    const v = positionWorld.sub(cameraPosition);
    const dist = max(length(v), 1e-4);
    const d = v.div(dist);
    scene.fogNode = fog(fogColor(d), fogAmount(dist, d));
  }

  // ---- storm volume (or screen-space streaks) ----
  const volume = new StormVolumeNode(engine.camera);
  const steps = (q: Quality): number => q.volumetricSteps;
  const canVolume = (q: Quality): boolean => q.volumetricSteps > 0 && engine.backend === 'webgpu' && hdr;
  post?.addHdrStage('storm', 100, (i) => {
    if (canVolume(i.quality)) {
      volume.bind(i, steps(i.quality), VOL_SCALE);
      return compositeVolume(i, volume, VOL_SCALE);
    }
    return screenStreaks(i, volume.camWorld);
  });

  // ---- whiteout wash ----
  const uWo = uniform(0);
  const uWoCol = uniform(new THREE.Color(0.85, 0.87, 0.9));
  post?.addOverlay('whiteout', 100, (color) => {
    // Contrast drains out and everything sinks into one luminous grey.
    const l = luminance(color);
    const flat = mix(color, vec3(l), uWo.mul(0.7));
    return mix(flat, vec3(uWoCol), uWo.mul(0.5));
  });

  // ---- snow ----
  const near = new SnowLayer({ name: 'snow.near', max: 24000, half: 11, below: 4, above: 9, size: [0.006, 0.016], shutter: 1 / 40, opacity: 0.9, seed: 1 });
  const mid = new SnowLayer({ name: 'snow.mid', max: 9000, half: 26, below: 8, above: 18, size: [0.012, 0.03], shutter: 1 / 20, opacity: 0.55, seed: 2 });
  scene.add(near.mesh, mid.mesh);
  const drift = new Spindrift(world);
  scene.add(drift.mesh);

  // ---- state ----
  let whiteout = 0;
  let visibility = 4000;
  let snowClock = 0;
  const lastCam = new THREE.Vector3(NaN, 0, 0);
  const camVel = new THREE.Vector3();
  const right = new THREE.Vector3();
  let frameNo = 0;

  function setQuality(q: Quality): void {
    quality = q;
    volActive = canVolume(q);
  }
  setQuality(quality);

  function update(f: Frame): void {
    const view = f.view;
    if (!view) return;
    const env = view.env;
    const cam = view.camera;
    const dt = Math.min(0.1, Math.max(0, f.dt));
    const storm = Math.max(0, Math.min(1, env.storm));
    const snowfall = Math.max(0, Math.min(1, env.snowfall));
    visibility = Math.max(1, env.visibility);
    const wl = Math.hypot(env.windX, env.windZ);
    const wdx = wl > 1e-4 ? env.windX / wl : 1, wdz = wl > 1e-4 ? env.windZ / wl : 0;
    const gust = Math.max(0, Math.min(1, env.gust));
    const speed = wl * (1 + 0.65 * gust);

    U.windDir.value.set(wdx, wdz);
    U.windSpeed.value = speed;
    U.gust.value = gust;
    U.storm.value = storm;
    U.snowfall.value = snowfall;
    U.visibility.value = visibility;

    // Fog: Koschmieder (3.9 / visibility) in snow; clear air keeps distant ridges readable.
    const haze = 0.11 + 0.89 * smooth(0.0, 0.32, storm);
    U.fogDensity.value = (3.9 / visibility) * haze;
    U.fogHeight.value = 1 / (650 + 2600 * smooth(0.05, 0.5, storm));
    const sa = U.skyAmbient.value, ga = U.groundAmbient.value;
    // Snow-laden air: single-scattering albedo ~0.95, lit by the sky from above and the snow below.
    const k = 0.95 / (2 * Math.PI);
    U.fogColor.value.setRGB((sa.r + ga.r) * k, (sa.g + ga.g) * k, (sa.b + ga.b) * k);
    ATMOS.fogColor.copy(U.fogColor.value);
    AIR.stormMix.value = smooth(0.06, 0.5, storm);
    AIR.glow.value = 0.95;
    AIR.glowG.value = 0.62;
    const share = volActive ? 0.78 * smooth(0.08, 0.35, storm) : 0;
    AIR.volShare.value = share;
    AIR.sceneShare.value = 1 - share;

    // Volume drift (wrapped by the noise periods so it never loses precision).
    const vd = VOLU.drift.value as THREE.Vector3;
    vd.x = (vd.x + env.windX * (1 + 0.5 * gust) * dt) % 44;
    vd.z = (vd.z + env.windZ * (1 + 0.5 * gust) * dt) % 44;
    vd.y = (vd.y - 0.6 * dt) % 44;
    const v2 = VOLU.drift2.value as THREE.Vector3;
    v2.x = (v2.x + speed * 0.35 * 1.45 * dt) % 9;
    v2.y = (v2.y - 0.9 * dt) % 9;
    VOLU.windDir.value.set(wdx, wdz);
    VOLU.contrast.value = 0.55 + 0.35 * gust + 0.1 * storm;
    VOLU.frame.value = frameNo++ % 64;
    VOLU.streaks.value = volActive ? 0 : smooth(0.12, 0.55, storm) * 0.85;

    // Camera velocity (for the streaks of the falling snow), smoothed.
    const cx = cam.x, cy = cam.y, cz = cam.z;
    if (Number.isNaN(lastCam.x) || dt <= 0) camVel.set(0, 0, 0);
    else {
      const k2 = 1 - Math.exp(-dt * 12);
      const vx = (cx - lastCam.x) / dt, vy = (cy - lastCam.y) / dt, vz = (cz - lastCam.z) / dt;
      // a teleport is not a velocity
      if (vx * vx + vy * vy + vz * vz > 900) camVel.set(0, 0, 0);
      else camVel.set(camVel.x + (vx - camVel.x) * k2, camVel.y + (vy - camVel.y) * k2, camVel.z + (vz - camVel.z) * k2);
    }
    lastCam.set(cx, cy, cz);
    // Screen-space wind for the cheap streaks: the wind across the view.
    right.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    const across = env.windX * right.x + env.windZ * right.z;
    VOLU.screenWind.value.set(across * 0.012, 0.004 + 0.002 * storm);

    // Falling snow.
    snowClock = (snowClock + dt) % SNOW_PERIOD;
    SNOWU.time.value = snowClock;
    SNOWU.wind.value.set(env.windX * (1 + 0.65 * gust), env.windZ * (1 + 0.65 * gust));
    SNOWU.turbulence.value = Math.min(1, storm * 0.8 + gust * 0.4);
    SNOWU.camVel.value.copy(camVel);
    SNOWU.amount.value = smooth(0, 0.15, snowfall);
    const count = quality.snowParticles;
    near.setCount(Math.min(near.max, count) * Math.min(1, snowfall * 1.15));
    mid.setCount(Math.min(mid.max, count * 0.5) * Math.min(1, snowfall * 1.15));
    const wx = env.windX * (1 + 0.65 * gust) * dt, wz = env.windZ * (1 + 0.65 * gust) * dt;
    near.advance(wx, wz);
    mid.advance(wx, wz);

    // Spindrift: strong wind lifts the surface snow.
    DRIFTU.amount.value = smooth(7, 15, speed) * (0.55 + 0.45 * storm);
    DRIFTU.dir.value.set(wdx, wdz);
    const sc = DRIFTU.scroll.value as THREE.Vector3;
    sc.x = (sc.x + (speed * 0.55 * dt) / 46) % 1;
    sc.y = (sc.y + (speed * 0.8 * dt) / 46) % 1;
    sc.z = (sc.z + (speed * 1.0 * dt) / 46) % 1;
    drift.mesh.visible = DRIFTU.amount.value > 0.002;
    if (drift.mesh.visible) drift.follow(cx, cz);

    // Whiteout wash below ~15 m of visibility, toward the fog as the display shows it.
    whiteout = smooth(15, 4, visibility) * smooth(0.6, 0.9, storm);
    uWo.value = whiteout;
    const e = U.exposure.value;
    const fc = U.fogColor.value;
    uWoCol.value.setRGB(displayOf(fc.r * e * 1.1), displayOf(fc.g * e * 1.1), displayOf(fc.b * e * 1.1));
    syncGlobals();
  }

  return {
    name: 'weather',
    get whiteout() {
      return whiteout;
    },
    get visibility() {
      return visibility;
    },
    update,
    setQuality,
    dispose() {
      post?.remove('storm');
      post?.remove('whiteout');
      scene.remove(near.mesh, mid.mesh, drift.mesh);
      near.dispose();
      mid.dispose();
      drift.dispose();
      volume.dispose();
      if (scene.fogNode) scene.fogNode = null;
    },
  };
}

