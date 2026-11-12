// The sky system: sun, moon and stars from the clock, the physically based sky, clouds and aurora,
// and every global light: the shadow-casting key light (the sun by day, the moon by night), the
// image-based ambient, the shared light uniforms and the auto exposure.
//
//   const sky = createSkySystem(engine, world);   engine.add(sky);   // add before 'weather'
//
// Reads f.view.env (clock, day, cloud, storm, visibility, aurora, wind) and f.view.camera.
// Writes U.sunDir, sunColor, moonDir, moonColor, skyAmbient, groundAmbient, night, exposure and the
// ATMOS mirror; owns scene.environment and the key DirectionalLight. Light units follow the engine
// bench: noon sun about [10.5, 8.9, 6.9], moonlight about 0.1, exposure 0.6 by day, ~1.8 at night.
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { Engine, Frame, GfxSystem, Quality } from '../api';
import type { World } from '../../world/types';
import { ATMOS, U } from '../shared';
import { skyBodies, starFrame, type SkyBodies } from './astro';
import { Atmosphere, SkyLut, RG } from './atmosphere';
import { HORIZON_W, SKY, horizonTexture, syncGlobals } from './common';
import { SkyEnv } from './env';
import { SKYU, createDomeMaterial, createEnvMaterial, type SkyDetail } from './nodes';

export interface SkySystem extends GfxSystem {
  /** The shadow-casting directional light: the sun by day, the moon by night. */
  readonly key: THREE.DirectionalLight;
  /** Stops added to the auto exposure (indoors, photo mode). */
  exposureBias: number;
  /** Jump straight to the current light (exposure, tables, environment) on the next update. */
  snap(): void;
  /** Rebuild everything for the current env at once (benches): tables, environment, exposure. */
  settle(f: Frame): void;
  /** Current positions of the sun and moon. */
  readonly bodies: SkyBodies;
}

const DEG = Math.PI / 180;
const SUN_E = 12; // top-of-atmosphere solar irradiance, scene units
const MOON_FULL = 0.5; // top-of-atmosphere irradiance of a full moon (art-directed, ~1e5 x real)
const MOON_TINT = [0.72, 0.84, 1.0]; // moonlight reads blue to night-adapted eyes
const NIGHT_FLOOR = [0.0042, 0.0052, 0.0085]; // airglow + starlight, radiance
const LIFT = 0.42; // twilight lift per degree of solar depression (see sky brightness note below)
const SUN_DISC_K = 180;
const MOON_DISC_K = 9; // the disc is drawn 1.7x larger (nodes.ts), so dimmer per pixel
const STAR_FLUX = 3.2e-7;
const AURORA_K = 0.7;
const BASE_ALT_KM = 1.5; // the mountain's base above sea level
const SNOW_ALBEDO = 0.85;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Phase law of the moon's brightness (Allen): fraction of full-moon light at elongation e. */
function moonPhaseLaw(elong: number): number {
  const alpha = Math.abs(180 - (elong / DEG) % 360); // phase angle, degrees
  return Math.pow(10, -0.4 * (0.026 * alpha + 4e-9 * Math.pow(alpha, 4)));
}

interface Detail {
  sunLut: [number, number, number];
  moonLut: [number, number, number];
  rows: number;
  env: number;
}

function detailFor(q: Quality): Detail {
  if (q.name === 'mobile') return { sunLut: [24, 32, 14], moonLut: [16, 24, 12], rows: 4, env: 32 };
  if (q.name === 'low') return { sunLut: [32, 40, 16], moonLut: [20, 28, 14], rows: 6, env: 32 };
  return { sunLut: [32, 48, 20], moonLut: [24, 32, 16], rows: 8, env: 64 };
}

export function createSkySystem(engine: Engine, world: World | null = null): SkySystem {
  void world; // the sky does not depend on the terrain
  const scene = engine.scene;
  const renderer = engine.renderer;
  const reversed = (renderer as any).reversedDepthBuffer === true;
  const hdr = (engine as any).hdr !== false;
  let quality = engine.quality;
  let detail = detailFor(quality);

  const atm = new Atmosphere(BASE_ALT_KM);
  let sunLut = new SkyLut(atm, ...detail.sunLut);
  let moonLut = new SkyLut(atm, ...detail.moonLut);
  const bindLuts = (): void => {
    SKY.sunA.value = sunLut.texA;
    SKY.sunB.value = sunLut.texB;
    SKY.moonA.value = moonLut.texA;
    SKY.moonB.value = moonLut.texB;
  };
  bindLuts();

  // ---- dome ----
  const skyDetail = (q: Quality): SkyDetail => ({ cloudSteps: q.cloudSteps, auroraSteps: q.auroraSteps, stars: true, discs: true });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), createDomeMaterial(skyDetail(quality), reversed));
  dome.name = 'sky.dome';
  dome.frustumCulled = false;
  dome.renderOrder = 1e6; // after every opaque thing: only visible sky is shaded
  dome.castShadow = false;
  dome.receiveShadow = false;
  dome.matrixAutoUpdate = false;
  scene.add(dome);

  // ---- environment (or a hemisphere light where float targets are missing) ----
  let envMat = createEnvMaterial(skyDetail(quality));
  let env: SkyEnv | null = hdr ? new SkyEnv(detail.env, envMat) : null;
  let hemi: THREE.HemisphereLight | null = null;
  // Render the cube once now: its GPU texture must be created as a render target before any
  // material samples it (a warm-up compile would otherwise create it as a plain texture, and the
  // first refresh would replace it under the materials' bindings).
  env?.refreshNow(renderer);
  if (env) scene.environment = env.texture;
  else {
    hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    hemi.name = 'sky.hemi';
    scene.add(hemi);
  }
  const envSig = new Float64Array(12);
  const sigNow = new Float64Array(12);
  let envAge = 99;

  // ---- key light with cascaded shadows ----
  let key!: THREE.DirectionalLight;
  let csm: CSMShadowNode | null = null;
  const camSig = { fov: 0, aspect: 0, near: 0, far: 0 };
  function buildKey(q: Quality): void {
    if (key) {
      scene.remove(key, key.target);
      csm?.dispose();
      key.dispose();
    }
    key = new THREE.DirectionalLight(0xffffff, 0);
    key.name = 'sky.key';
    csm = null;
    if (q.shadowCascades > 0) {
      key.castShadow = true;
      key.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      // bias is multiplied by (cascade + 1) inside CSMShadowNode; normal bias is not
      key.shadow.bias = -0.00035;
      key.shadow.normalBias = q.shadowCascades > 1 ? 0.045 : 0.03;
      key.shadow.camera.near = 1;
      key.shadow.camera.far = 1600;
      csm = new CSMShadowNode(key as any, { cascades: q.shadowCascades, maxFar: q.shadowDistance, mode: 'practical', lightMargin: 500 } as any);
      (csm as any).fade = q.shadowCascades > 1;
      (key.shadow as any).shadowNode = csm;
    }
    scene.add(key, key.target);
    camSig.fov = 0;
  }
  buildKey(quality);

  // ---- state ----
  const bodies = skyBodies(16.5, 0);
  const T = new Float64Array(3);
  const L = new Float64Array(3);
  const L2 = new Float64Array(3);
  const sunDirect = new THREE.Vector3();
  const moonDirect = new THREE.Vector3();
  const eClear = new THREE.Vector3();
  const eSky = new THREE.Vector3();
  const eGround = new THREE.Vector3();
  const moonSkyCpu = new THREE.Vector3();
  const above = new THREE.Vector3();
  const eOvc = new THREE.Vector3();
  const gTot = new THREE.Vector3();
  const starM = new Array<number>(9);
  const horizonData = horizonTexture.image.data as Uint16Array;
  const toHalf = THREE.DataUtils.toHalfFloat;
  let snapNext = true;
  let lastClock = NaN;
  let expLog = Math.log(0.6);
  let horizonFrame = 0;

  // Cosine-weighted directions over the upper hemisphere (Malley), for the ambient integral.
  const AMB_N = 40;
  const ambDirs: number[] = [];
  for (let i = 0; i < AMB_N; i++) {
    const r = Math.sqrt((i + 0.5) / AMB_N);
    const a = i * 2.399963229728653;
    const x = r * Math.cos(a), z = r * Math.sin(a);
    ambDirs.push(x, Math.sqrt(Math.max(0, 1 - r * r)), z);
  }

  /** Clear-sky radiance toward (dx, dy, dz) from both tables, with the given light scales. */
  function skyRad(dx: number, dy: number, dz: number, sunScale: number, moonScale: THREE.Vector3, out: Float64Array): void {
    const l = Math.asin(Math.max(-1, Math.min(1, dy)));
    out[0] = NIGHT_FLOOR[0] * (1 + 1.6 * Math.pow(1 - Math.max(0, dy), 3));
    out[1] = NIGHT_FLOOR[1] * (1 + 1.6 * Math.pow(1 - Math.max(0, dy), 3));
    out[2] = NIGHT_FLOOR[2] * (1 + 1.6 * Math.pow(1 - Math.max(0, dy), 3));
    const hz = Math.hypot(dx, dz) || 1e-6;
    const s = bodies.sun, m = bodies.moon;
    if (sunScale > 0) {
      const sh = Math.hypot(s.x, s.z) || 1e-6;
      const phi = Math.acos(Math.max(-1, Math.min(1, (dx * s.x + dz * s.z) / (hz * sh))));
      sunLut.sample(l, phi, dx * s.x + dy * s.y + dz * s.z, L2);
      out[0] += L2[0] * sunScale;
      out[1] += L2[1] * sunScale;
      out[2] += L2[2] * sunScale;
    }
    if (moonScale.x > 0) {
      const mh = Math.hypot(m.x, m.z) || 1e-6;
      const phi = Math.acos(Math.max(-1, Math.min(1, (dx * m.x + dz * m.z) / (hz * mh))));
      moonLut.sample(l, phi, dx * m.x + dy * m.y + dz * m.z, L2);
      out[0] += L2[0] * moonScale.x;
      out[1] += L2[1] * moonScale.y;
      out[2] += L2[2] * moonScale.z;
    }
  }

  function manageLut(lut: SkyLut, el: number, force: boolean): boolean {
    const cur = lut.target;
    const diff = Math.abs(el - cur);
    // Twilight colours change fast with the light's height; the day sky barely does.
    const thr = (el < 12 * DEG ? 0.12 : 0.45) * DEG;
    if (force || Number.isNaN(cur) || diff > 3 * DEG) {
      lut.buildNow(el);
      return true;
    }
    if (!lut.busy && diff > thr) lut.start(el);
    return lut.step(detail.rows);
  }

  const moonScaleSky = new THREE.Vector3();
  const sunTop = new THREE.Vector3();

  function update(f: Frame, settle = false): void {
    const view = f.view;
    if (!view) return;
    const envS = view.env;
    const cam = view.camera;
    const dt = Math.min(0.25, Math.max(0, f.dt));
    const jump = !Number.isNaN(lastClock) && Math.abs(envS.clock - lastClock) > 0.25 && Math.abs(envS.clock - lastClock) < 23.75;
    lastClock = envS.clock;
    const force = settle || snapNext || jump;

    skyBodies(envS.clock, envS.day, bodies);
    atm.observerKm = BASE_ALT_KM + Math.max(0, cam ? cam.y : 0) / 1000;
    const sunEl = bodies.sunElevation;
    const moonEl = bodies.moonElevation;
    manageLut(sunLut, sunEl, force);
    manageLut(moonLut, moonEl, force);

    // ---- weather that touches the light ----
    const storm = Math.max(0, Math.min(1, envS.storm));
    const cover = Math.max(0, Math.min(1, envS.cloud));
    const coverBlend = smooth(0.4, 1.0, cover);
    const cloudT = 1 - 0.965 * smooth(0.5, 0.97, cover);
    const fogD = 3.9 / Math.max(1, envS.visibility);
    const fogStorm = Math.max(0, fogD - 3.9 / 4000);
    const beam = (sinEl: number): number => Math.exp((-fogStorm * 120) / Math.max(0.08, sinEl));
    const night = smooth(-2 * DEG, -10 * DEG, sunEl);

    // ---- direct light ----
    const r0 = atm.r0;
    atm.lightTransmittance(r0, bodies.sun.y, T);
    const sunVis = smooth(-0.6 * DEG, 0.8 * DEG, sunEl);
    sunTop.set(SUN_E * T[0] * sunVis, SUN_E * T[1] * sunVis, SUN_E * T[2] * sunVis); // above cloud and storm
    const sunBeam = beam(Math.max(0, bodies.sun.y));
    sunDirect.copy(sunTop).multiplyScalar(cloudT * sunBeam);

    const moonE = MOON_FULL * moonPhaseLaw(bodies.moonElongation);
    atm.lightTransmittance(r0, bodies.moon.y, T);
    const moonVis = smooth(-0.6 * DEG, 0.8 * DEG, moonEl);
    // The moon only takes over as the sky darkens (it is ~1e-6 of the sun in truth).
    const moonAdapt = smooth(-0.6 * DEG, -8 * DEG, sunEl);
    const moonBeam = beam(Math.max(0, bodies.moon.y));
    moonDirect.set(MOON_TINT[0] * T[0], MOON_TINT[1] * T[1], MOON_TINT[2] * T[2]).multiplyScalar(moonE * moonVis * moonAdapt * cloudT * moonBeam);

    // ---- sky light ----
    // Sky brightness note: the physical twilight sky falls ~1 decade per 2.5 degrees of solar
    // depression, far below the art-directed moonlight; the lift keeps blue hour a gentle bridge
    // from sunset into night instead of a black gap.
    const lift = Math.exp(LIFT * Math.min(16, Math.max(0, -sunEl / DEG)));
    const sunSky = SUN_E * lift * sunLut.scale;
    moonScaleSky.set(MOON_TINT[0], MOON_TINT[1], MOON_TINT[2]).multiplyScalar(moonE * Math.max(0.15, moonAdapt) * moonLut.scale);
    SKY.sunE.value.set(sunSky, sunSky, sunSky);
    SKY.moonE.value.copy(moonScaleSky);
    SKY.nightFloor.value.set(NIGHT_FLOOR[0], NIGHT_FLOOR[1], NIGHT_FLOOR[2]);
    const sunSkyCpu = SUN_E * lift;
    moonSkyCpu.copy(moonScaleSky).multiplyScalar(1 / Math.max(1e-12, moonLut.scale));

    // Irradiance on an up-facing surface from the clear sky: pi * mean radiance over cosine samples.
    eClear.set(0, 0, 0);
    for (let i = 0; i < AMB_N; i++) {
      skyRad(ambDirs[i * 3], ambDirs[i * 3 + 1], ambDirs[i * 3 + 2], sunSkyCpu, moonSkyCpu, L);
      eClear.x += L[0];
      eClear.y += L[1];
      eClear.z += L[2];
    }
    eClear.multiplyScalar(Math.PI / AMB_N);

    // Under a closed deck the light comes through grey: a fraction of everything above it.
    const sinS = Math.max(0, bodies.sun.y), sinM = Math.max(0, bodies.moon.y);
    above.set(
      eClear.x + sunTop.x * sinS + moonDirect.x * sinM,
      eClear.y + sunTop.y * sinS + moonDirect.y * sinM,
      eClear.z + sunTop.z * sinS + moonDirect.z * sinM,
    );
    const ovcT = 0.36 - 0.16 * storm;
    const aLum = lum(above.x, above.y, above.z);
    eOvc.set(
      (aLum * 0.7 + above.x * 0.3) * ovcT,
      (aLum * 0.7 + above.y * 0.3) * ovcT,
      (aLum * 0.7 + above.z * 0.3) * ovcT * 1.04,
    );
    eSky.copy(eClear).lerp(eOvc, coverBlend);
    // What the storm takes out of the beams it scatters about: whiteouts are bright and shadowless.
    const lostSun = (1 - sunBeam) * cloudT * 0.85;
    eSky.x += sunTop.x * sinS * lostSun;
    eSky.y += sunTop.y * sinS * lostSun;
    eSky.z += sunTop.z * sinS * lostSun;
    // Aurora: a faint green wash over the snow.
    const auroraOn = Math.max(0, Math.min(1, envS.aurora)) * smooth(-6 * DEG, -14 * DEG, sunEl) * (1 - smooth(0.3, 0.75, cover));
    eSky.x += 0.002 * auroraOn;
    eSky.y += 0.011 * auroraOn;
    eSky.z += 0.005 * auroraOn;

    // Bounce from the snow: 0.6 to 0.8 of the sky ambient, warmed by the sun on it.
    eGround.copy(eSky).multiplyScalar(0.62);
    eGround.x += 0.11 * (sunDirect.x * sinS + moonDirect.x * sinM);
    eGround.y += 0.11 * (sunDirect.y * sinS + moonDirect.y * sinM);
    eGround.z += 0.11 * (sunDirect.z * sinS + moonDirect.z * sinM);

    SKY.cover.value = cover;
    SKY.overcast.value.copy(eOvc).multiplyScalar(1 / Math.PI);

    // ---- key light: the sun, or the moon once the sun is down ----
    const useSun = sunEl > -0.6 * DEG;
    const kd = useSun ? bodies.sun : bodies.moon;
    const kc = useSun ? sunDirect : moonDirect;
    const cx = cam ? cam.x : 0, cy = cam ? cam.y : 0, cz = cam ? cam.z : 0;
    key.target.position.set(cx, cy, cz);
    key.position.set(cx + kd.x * 200, cy + kd.y * 200, cz + kd.z * 200);
    key.color.setRGB(kc.x, kc.y, kc.z);
    key.intensity = 1;
    key.updateMatrixWorld();
    key.target.updateMatrixWorld();
    if (csm) {
      const c = engine.camera;
      if (c.fov !== camSig.fov || c.aspect !== camSig.aspect || c.near !== camSig.near || c.far !== camSig.far) {
        if ((csm as any).camera) {
          (csm as any).updateFrustums();
          camSig.fov = c.fov;
          camSig.aspect = c.aspect;
          camSig.near = c.near;
          camSig.far = c.far;
        }
      }
    }

    // ---- sky shader uniforms ----
    starFrame(bodies.sidereal, starM);
    SKYU.starRot.value.set(starM[0], starM[1], starM[2], starM[3], starM[4], starM[5], starM[6], starM[7], starM[8]);
    // Stars come out in nautical twilight (they are boosted far above their true brightness).
    SKYU.starFlux.value = STAR_FLUX * smooth(-3 * DEG, -11 * DEG, sunEl);
    atm.lightTransmittance(r0, bodies.sun.y, T);
    const sv = smooth(-0.35 * DEG, 0.3 * DEG, sunEl + 0.267 * DEG);
    SKYU.sunDisc.value.set(T[0], T[1], T[2]).multiplyScalar(SUN_E * SUN_DISC_K * sv);
    atm.lightTransmittance(r0, bodies.moon.y, T);
    SKYU.moonDisc.value.set(MOON_TINT[0] * T[0], MOON_TINT[1] * T[1], MOON_TINT[2] * T[2]).multiplyScalar(MOON_FULL * MOON_DISC_K * Math.max(0.25, moonAdapt));
    // clouds: lower, thicker and denser with the storm; drifting with the wind aloft
    SKYU.cloudBase.value = 2.1 - 1.1 * storm;
    SKYU.cloudThick.value = 0.9 + 1.6 * storm;
    SKYU.cloudDensity.value = 8 + 14 * storm;
    const wx = envS.windX, wz = envS.windZ;
    const wl = Math.hypot(wx, wz) || 1;
    const aloft = 0.012 + 0.0012 * wl; // km/s
    SKYU.cloudOffset.value.x -= (wx / wl) * aloft * dt;
    SKYU.cloudOffset.value.y -= (wz / wl) * aloft * dt;
    if (Math.abs(SKYU.cloudOffset.value.x) > 2200) SKYU.cloudOffset.value.x %= 22;
    if (Math.abs(SKYU.cloudOffset.value.y) > 2200) SKYU.cloudOffset.value.y %= 22;
    const cloudSun = sunEl > -3 * DEG;
    const cd = cloudSun ? bodies.sun : bodies.moon;
    atm.lightTransmittance(RG + atm.observerKm + SKYU.cloudBase.value + 0.5, cd.y, T);
    const cs = cloudSun ? SUN_E : moonE * Math.max(0.15, moonAdapt);
    const ctint = cloudSun ? [1, 1, 1] : MOON_TINT;
    SKYU.cloudLight.value.set(T[0] * cs * ctint[0], T[1] * cs * ctint[1], T[2] * cs * ctint[2]);
    SKYU.cloudLightDir.value.set(cd.x, cd.y, cd.z);
    SKYU.cloudAmbTop.value.copy(eClear).multiplyScalar(0.85 / Math.PI);
    gTot.copy(eSky).addScaledVector(sunDirect, sinS).addScaledVector(moonDirect, sinM);
    SKYU.cloudAmbBottom.value.copy(gTot).multiplyScalar((SNOW_ALBEDO * 0.55) / Math.PI);
    SKYU.auroraE.value = AURORA_K * auroraOn;
    SKYU.groundRad.value.copy(eGround).multiplyScalar(1 / Math.PI);

    // ---- horizon colour per azimuth (the clear-air haze the fog uses) ----
    if (force || ++horizonFrame >= 3) {
      horizonFrame = 0;
      const sl = Math.sin(1.5 * DEG), cl = Math.cos(1.5 * DEG);
      const ox = SKY.overcast.value;
      for (let k = 0; k < HORIZON_W; k++) {
        const a = ((k + 0.5) / HORIZON_W - 0.5) * Math.PI * 2;
        skyRad(Math.cos(a) * cl, sl, Math.sin(a) * cl, sunSkyCpu, moonSkyCpu, L);
        const o = k * 4;
        horizonData[o] = toHalf(L[0] + (ox.x * 0.95 - L[0]) * coverBlend);
        horizonData[o + 1] = toHalf(L[1] + (ox.y * 0.95 - L[1]) * coverBlend);
        horizonData[o + 2] = toHalf(L[2] + (ox.z * 0.95 - L[2]) * coverBlend);
        horizonData[o + 3] = toHalf(1);
      }
      horizonTexture.needsUpdate = true;
    }

    // ---- shared uniforms and mirror ----
    U.sunDir.value.set(bodies.sun.x, bodies.sun.y, bodies.sun.z);
    U.sunColor.value.setRGB(sunDirect.x, sunDirect.y, sunDirect.z);
    U.moonDir.value.set(bodies.moon.x, bodies.moon.y, bodies.moon.z);
    U.moonColor.value.setRGB(moonDirect.x, moonDirect.y, moonDirect.z);
    U.skyAmbient.value.setRGB(eSky.x, eSky.y, eSky.z);
    U.groundAmbient.value.setRGB(eGround.x, eGround.y, eGround.z);
    U.night.value = night;
    ATMOS.sunDir.copy(U.sunDir.value);
    ATMOS.sunColor.copy(U.sunColor.value);
    ATMOS.sunIntensity = lum(sunDirect.x, sunDirect.y, sunDirect.z) / 9;
    ATMOS.moonDir.copy(U.moonDir.value);
    ATMOS.moonColor.copy(U.moonColor.value);
    ATMOS.skyAmbient.copy(U.skyAmbient.value);
    ATMOS.groundAmbient.copy(U.groundAmbient.value);
    ATMOS.night = night;
    if (hemi) {
      hemi.color.setRGB(eSky.x, eSky.y, eSky.z);
      hemi.groundColor.setRGB(eGround.x, eGround.y, eGround.z);
    }

    // ---- environment ----
    if (env) {
      envAge += dt;
      const sig = sigNow;
      sig[0] = bodies.sun.x; sig[1] = bodies.sun.y; sig[2] = bodies.sun.z; sig[3] = bodies.moon.y; sig[4] = cover; sig[5] = storm;
      sig[6] = auroraOn; sig[7] = Math.log(1e-4 + lum(eSky.x, eSky.y, eSky.z)); sig[8] = U.fogColor.value.r; sig[9] = U.fogDensity.value * 50; sig[10] = night;
      let change = 0;
      for (let i = 0; i < sig.length; i++) change = Math.max(change, Math.abs(sig[i] - envSig[i]));
      if (force) {
        env.refreshNow(renderer);
        envSig.set(sig);
        envAge = 0;
      } else {
        if (!env.busy && envAge > 0.3 && change > 0.004) {
          env.request();
          envSig.set(sig);
          envAge = 0;
        }
        env.step(renderer);
      }
    }

    // ---- auto exposure ----
    // What a sheet of flat snow returns: the eye adapts to that, but only partly (night stays dark).
    const keyLum = (SNOW_ALBEDO * lum(sunDirect.x * sinS + moonDirect.x * sinM + eSky.x, sunDirect.y * sinS + moonDirect.y * sinM + eSky.y, sunDirect.z * sinS + moonDirect.z * sinM + eSky.z)) / Math.PI;
    // Daylight, sunny or overcast, is adapted to fully; below it the eye keeps less and less of
    // the loss (slopes in log10: 0.55 through dusk, 0.95 at night), so night stays dark.
    const lk = Math.log10(Math.max(1e-6, keyLum));
    const DAY = Math.log10(0.6), DUSK = Math.log10(0.08);
    const adapt = lk >= DAY ? 0 : lk >= DUSK ? 0.55 * (lk - DAY) : 0.55 * (DUSK - DAY) + 0.95 * (lk - DUSK);
    const target = 0.86 * Math.pow(10, adapt);
    const expT = Math.min(3.0, Math.max(0.25, target / Math.max(1e-6, keyLum)));
    if (force) expLog = Math.log(expT);
    else expLog += (Math.log(expT) - expLog) * (1 - Math.exp(-dt * 1.4));
    U.exposure.value = Math.exp(expLog) * Math.pow(2, sys.exposureBias);
    ATMOS.luminance = keyLum;
    syncGlobals();
    snapNext = false;
  }

  function setQuality(q: Quality): void {
    if (q === quality) return;
    const prevName = quality.name;
    quality = q;
    const nd = detailFor(q);
    if (nd.sunLut.join() !== detail.sunLut.join() || nd.moonLut.join() !== detail.moonLut.join()) {
      sunLut.dispose();
      moonLut.dispose();
      sunLut = new SkyLut(atm, ...nd.sunLut);
      moonLut = new SkyLut(atm, ...nd.moonLut);
      bindLuts();
    }
    const envSize = nd.env;
    detail = nd;
    const oldDome = dome.material as THREE.Material;
    dome.material = createDomeMaterial(skyDetail(q), reversed);
    oldDome.dispose();
    const oldEnv = envMat;
    envMat = createEnvMaterial(skyDetail(q));
    if (env && env.size !== envSize) {
      env.dispose();
      env = new SkyEnv(envSize, envMat);
      env.refreshNow(renderer);
      scene.environment = env.texture;
    } else env?.setSkyMaterial(envMat);
    oldEnv.dispose();
    if (prevName !== q.name) buildKey(q);
    snapNext = true;
  }

  const sys: SkySystem = {
    name: 'sky',
    get key() {
      return key;
    },
    get bodies() {
      return bodies;
    },
    exposureBias: 0,
    update: (f) => update(f),
    settle: (f) => update(f, true),
    snap() {
      snapNext = true;
    },
    setQuality,
    resize() {
      camSig.fov = 0; // CSM frustums follow on the next update
    },
    dispose() {
      scene.remove(dome, key, key.target);
      if (hemi) scene.remove(hemi);
      if (scene.environment === env?.texture) scene.environment = null;
      csm?.dispose();
      key.dispose();
      dome.geometry.dispose();
      (dome.material as THREE.Material).dispose();
      envMat.dispose();
      env?.dispose();
      sunLut.dispose();
      moonLut.dispose();
    },
  };
  return sys;
}
