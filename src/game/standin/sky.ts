// STAND-IN for gfx/sky (ATMOSPHERE), until the real system replaces it through src/game/visuals.ts.
// One directional light for whichever body lights the scene (the sun by day, the moon at night),
// a hemisphere ambient, a gradient background with a sun glow, and the shared light uniforms
// (U.sunDir, sunColor, moonDir, moonColor, skyAmbient, groundAmbient, night, exposure + ATMOS),
// all following env.clock and env.storm. Light units follow dev/bench.ts (THREE_NOTES section 3).
// Owner: GAME.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, lerp, sat, smoothstep } from '../../core/math';
import type { Frame, GfxSystem, Quality } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import { ATMOS, U } from '../../gfx/shared';

const { positionWorldDirection, uniform, float, mix, max, dot, pow } = TSL as any;
const DEG = Math.PI / 180;
const LAT = 46 * DEG;
const DEC = -17.5 * DEG; // early winter: sunset about 16:45, noon elevation about 26 degrees
const MOON_DEC = 16 * DEG;

type RGB = [number, number, number];
interface Key { el: number; sun: RGB; sky: RGB; ground: RGB; zenith: RGB; horizon: RGB; glow: RGB; exposure: number }

// Clear-sky light by sun elevation (degrees). Scene-referred linear units: a white surface facing
// a light of 3.14 has radiance 1. Ground = bounce off the snowfield (about twice the bench's, as
// KIT measured: sun-averted faces over sunlit snow are not black).
const KEYS: Key[] = [
  { el: -14, sun: [0, 0, 0], sky: [0.008, 0.012, 0.026], ground: [0.006, 0.0075, 0.012], zenith: [0.0015, 0.003, 0.009], horizon: [0.006, 0.01, 0.022], glow: [0, 0, 0], exposure: 1.6 },
  { el: -7, sun: [0, 0, 0], sky: [0.05, 0.075, 0.17], ground: [0.04, 0.05, 0.09], zenith: [0.008, 0.017, 0.06], horizon: [0.06, 0.06, 0.12], glow: [0.08, 0.05, 0.06], exposure: 2.0 },
  { el: -2, sun: [0, 0, 0], sky: [0.14, 0.2, 0.42], ground: [0.12, 0.14, 0.24], zenith: [0.025, 0.05, 0.17], horizon: [0.45, 0.26, 0.24], glow: [1.0, 0.42, 0.18], exposure: 1.7 },
  { el: 2, sun: [3.6, 1.7, 0.7], sky: [0.22, 0.32, 0.62], ground: [0.3, 0.3, 0.42], zenith: [0.04, 0.08, 0.26], horizon: [0.7, 0.42, 0.32], glow: [2.6, 1.1, 0.4], exposure: 1.4 },
  { el: 7, sun: [7.2, 4.9, 2.9], sky: [0.4, 0.54, 0.92], ground: [0.9, 0.85, 0.9], zenith: [0.07, 0.16, 0.46], horizon: [0.72, 0.66, 0.66], glow: [2.0, 1.3, 0.7], exposure: 0.85 },
  { el: 20, sun: [10.5, 8.9, 6.9], sky: [0.58, 0.78, 1.15], ground: [1.6, 1.6, 1.7], zenith: [0.1, 0.24, 0.62], horizon: [0.62, 0.78, 1.02], glow: [1.6, 1.25, 0.8], exposure: 0.62 },
];
// Inside a blizzard by day: flat light, short sight. Scaled by how bright the clear sky would be.
const STORM = { sun: [0.9, 0.95, 1.05] as RGB, sky: [1.25, 1.36, 1.55] as RGB, ground: [0.95, 1.02, 1.15] as RGB, zenith: [0.42, 0.46, 0.53] as RGB, horizon: [0.5, 0.54, 0.6] as RGB };
const MOONLIGHT: RGB = [0.07, 0.095, 0.15];
const DAY_SKY_LUM = lum(KEYS[KEYS.length - 1].sky);

function lum(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Direction toward a body at hour angle h (rad) and declination dec; azimuth 0 = north, clockwise. */
function bodyDir(h: number, dec: number, out: THREE.Vector3): number {
  const sinEl = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(h);
  const el = Math.asin(clamp(sinEl, -1, 1));
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(LAT) - Math.tan(dec) * Math.cos(LAT)) + Math.PI;
  out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  return el / DEG;
}

export interface StandinSky extends GfxSystem {
  readonly light: THREE.DirectionalLight;
}

export function createStandinSky(engine: CsEngine): StandinSky {
  const scene = engine.scene;
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.name = 'standin-sun';
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  hemi.name = 'standin-ambient';
  scene.add(light, light.target, hemi);

  const zenith = uniform(new THREE.Color());
  const horizon = uniform(new THREE.Color());
  const glow = uniform(new THREE.Color());
  const sunDirU = uniform(new THREE.Vector3(0, 1, 0));
  const sunDisc = uniform(new THREE.Color());
  const moonDirU = uniform(new THREE.Vector3(0, -1, 0));
  const moonDisc = uniform(new THREE.Color());
  const stormU = uniform(0);
  {
    const dir = positionWorldDirection;
    const up = max(dir.y, 0.0);
    const sky = mix(horizon, zenith, pow(up, float(0.45)));
    const below = mix(horizon, U.fogColor, dir.y.negate().smoothstep(0.0, 0.25));
    const base = mix(below, sky, dir.y.smoothstep(-0.02, 0.02));
    const cs = max(dot(dir, sunDirU), 0.0);
    const halo = pow(cs, float(8)).mul(0.22).add(pow(cs, float(160)).mul(1.1));
    const disc = cs.smoothstep(0.99985, 0.99996);
    const cm = max(dot(dir, moonDirU), 0.0);
    const mdisc = cm.smoothstep(0.99992, 0.99997);
    const clear = base.add(glow.mul(halo)).add(sunDisc.mul(disc)).add(moonDisc.mul(mdisc));
    // the storm swallows the sky into the fog
    scene.backgroundNode = mix(clear, U.fogColor, stormU);
  }

  const key = { sun: [0, 0, 0] as RGB, sky: [0, 0, 0] as RGB, ground: [0, 0, 0] as RGB, zenith: [0, 0, 0] as RGB, horizon: [0, 0, 0] as RGB, glow: [0, 0, 0] as RGB, exposure: 1 };
  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const right = new THREE.Vector3();
  const upv = new THREE.Vector3();
  let shadowSize = 1024;
  let shadowsOn = true;
  const BOX = 42; // half size of the shadow box, metres

  function setQuality(q: Quality): void {
    shadowsOn = q.shadowCascades > 0;
    shadowSize = q.name === 'mobile' ? 1024 : Math.min(2048, Math.max(1024, q.shadowMapSize));
    light.castShadow = shadowsOn;
    // ShadowNode resizes its target to mapSize on every shadow render
    light.shadow.mapSize.set(shadowSize, shadowSize);
    const sc = light.shadow.camera;
    sc.left = sc.bottom = -BOX;
    sc.right = sc.top = BOX;
    sc.near = 1;
    sc.far = 400;
    sc.updateProjectionMatrix();
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.05;
  }

  function sample(el: number): void {
    let i = 0;
    while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = sat((el - a.el) / (b.el - a.el));
    for (const f of ['sun', 'sky', 'ground', 'zenith', 'horizon', 'glow'] as const) {
      for (let c = 0; c < 3; c++) key[f][c] = lerp(a[f][c], b[f][c], t);
    }
    key.exposure = lerp(a.exposure, b.exposure, t);
  }

  const sys: StandinSky = {
    name: 'sky',
    light,
    setQuality,
    update(f: Frame): void {
      const env = f.view.env;
      const h = (env.clock - 12) * 15 * DEG;
      const sunEl = bodyDir(h, DEC, sunDir);
      const moonEl = bodyDir(h + Math.PI - 0.5, MOON_DEC, moonDir);
      sample(sunEl);
      // storm: flat grey light, as bright as the clear sky would be
      const s = smoothstep(0.25, 0.85, env.storm);
      const k = clamp(lum(key.sky) / DAY_SKY_LUM, 0.004, 1);
      const mix3 = (dst: RGB, st: RGB) => {
        for (let c = 0; c < 3; c++) dst[c] = lerp(dst[c], st[c] * k, s);
      };
      mix3(key.sky, STORM.sky);
      mix3(key.ground, STORM.ground);
      mix3(key.zenith, STORM.zenith);
      mix3(key.horizon, STORM.horizon);
      const sunK = sunEl > -2 ? 1 : 0;
      const sunCol: RGB = [key.sun[0], key.sun[1], key.sun[2]];
      mix3(sunCol, STORM.sun);
      for (let c = 0; c < 3; c++) {
        sunCol[c] *= sunK * smoothstep(-2, 0.5, sunEl);
        key.glow[c] *= 1 - s;
      }
      const moonUp = smoothstep(-1, 12, moonEl) * (1 - s * 0.85) * (1 - smoothstep(-6, 2, sunEl));
      const moonCol: RGB = [MOONLIGHT[0] * moonUp, MOONLIGHT[1] * moonUp, MOONLIGHT[2] * moonUp];
      const exposure = key.exposure * lerp(1, 1.37, s);
      const night = 1 - smoothstep(-12, -2, sunEl);

      // the lit body: the sun while it is up (or just under), else the moon
      const useSun = sunEl > -2;
      lightDir.copy(useSun ? sunDir : moonDir);
      if (lightDir.y < 0.02) lightDir.y = 0.02; // a light from below the horizon would light the snow from under it
      lightDir.normalize();
      const lc = useSun ? sunCol : moonCol;
      light.color.setRGB(lc[0], lc[1], lc[2]);
      light.intensity = 1;
      hemi.color.setRGB(key.sky[0], key.sky[1], key.sky[2]);
      hemi.groundColor.setRGB(key.ground[0], key.ground[1], key.ground[2]);
      const lit = lc[0] + lc[1] + lc[2] > 0.02;
      light.castShadow = shadowsOn && lit;

      // the shadow box follows the camera, snapped to its texels so edges do not crawl
      const cam = f.view.camera;
      tmp.set(cam.x, cam.y, cam.z);
      right.set(0, 1, 0).cross(lightDir);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      upv.copy(lightDir).cross(right).normalize();
      const texel = (2 * BOX) / shadowSize;
      const pr = Math.round(tmp.dot(right) / texel) * texel - tmp.dot(right);
      const pu = Math.round(tmp.dot(upv) / texel) * texel - tmp.dot(upv);
      tmp.addScaledVector(right, pr).addScaledVector(upv, pu);
      light.target.position.copy(tmp);
      light.position.copy(tmp).addScaledVector(lightDir, 200);
      light.target.updateMatrixWorld();

      // shared uniforms and the JS mirror
      U.sunDir.value.copy(sunDir);
      U.sunColor.value.setRGB(sunCol[0], sunCol[1], sunCol[2]);
      U.moonDir.value.copy(moonDir);
      U.moonColor.value.setRGB(moonCol[0], moonCol[1], moonCol[2]);
      U.skyAmbient.value.setRGB(key.sky[0], key.sky[1], key.sky[2]);
      U.groundAmbient.value.setRGB(key.ground[0], key.ground[1], key.ground[2]);
      U.night.value = night;
      U.exposure.value = exposure;
      ATMOS.sunDir.copy(sunDir);
      ATMOS.sunColor.copy(U.sunColor.value);
      ATMOS.sunIntensity = useSun ? 1 : 0;
      ATMOS.moonDir.copy(moonDir);
      ATMOS.moonColor.copy(U.moonColor.value);
      ATMOS.skyAmbient.copy(U.skyAmbient.value);
      ATMOS.groundAmbient.copy(U.groundAmbient.value);
      ATMOS.night = night;
      ATMOS.luminance = 0.18 / exposure;

      zenith.value.setRGB(key.zenith[0], key.zenith[1], key.zenith[2]);
      horizon.value.setRGB(key.horizon[0], key.horizon[1], key.horizon[2]);
      glow.value.setRGB(key.glow[0], key.glow[1], key.glow[2]);
      sunDirU.value.copy(sunDir);
      // the disc goes first when the cloud thickens: a pale smudge in a storm, nothing in a blizzard
      const disc = sunEl > -1 ? 60 * (1 - smoothstep(0.12, 0.5, env.storm)) : 0;
      sunDisc.value.setRGB(key.sun[0] * disc * 0.1 + disc * 0.2, key.sun[1] * disc * 0.1 + disc * 0.15, key.sun[2] * disc * 0.1 + disc * 0.1);
      moonDirU.value.copy(moonDir);
      const md = moonEl > 0 ? 0.6 * (1 - s) * night : 0;
      moonDisc.value.setRGB(0.8 * md, 0.85 * md, 0.95 * md);
      stormU.value = smoothstep(0.35, 0.9, env.storm);
    },
    dispose(): void {
      scene.remove(light, light.target, hemi);
      light.dispose();
      scene.backgroundNode = null;
    },
  };
  return sys;
}
