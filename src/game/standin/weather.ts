// STAND-IN for gfx/weather (ATMOSPHERE), until the real system replaces it through
// src/game/visuals.ts. Height fog on scene.fogNode with density from env.visibility, its colour
// from the light the sky system has just written (ATMOS), the wind / storm / snowfall uniforms,
// a cheap layer of falling snow around the camera, and `whiteout` for the HUD.
// Owner: GAME.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { lerp, smoothstep } from '../../core/math';
import type { Frame, GfxSystem, Quality } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import { ATMOS, U } from '../../gfx/shared';

const {
  fog, positionView, positionWorld, float, max, uniform, vec3, attribute, fract, positionLocal, cameraPosition, cameraWorldMatrix, uv,
  smoothstep: tslSmooth,
} = TSL as any;

export interface StandinWeather extends GfxSystem {
  /** 0..1 how far visibility has collapsed (HUD wash). */
  readonly whiteout: number;
}

const BOX = 22; // metres: the snow volume wraps around the camera inside this cube

export function createStandinWeather(engine: CsEngine): StandinWeather {
  const scene = engine.scene;
  {
    // exponential fog thinning with height above the camera (dev/bench.ts)
    const dist = positionView.length();
    const h = max(positionWorld.y.sub(U.camPos.y), 0.0);
    const amount = float(1).sub(dist.mul(U.fogDensity).mul(h.mul(U.fogHeight).negate().exp()).negate().exp());
    scene.fogNode = fog(U.fogColor, amount);
  }

  // --- falling snow: instanced thin quads, positions wrapped round the camera in the vertex
  // shader from a per-instance seed, time and wind. No compute, so it runs on WebGL2 as well.
  const MAX = 9000;
  const quad = new THREE.PlaneGeometry(1, 1);
  const seeds = new Float32Array(MAX * 4);
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < MAX * 4; i++) seeds[i] = rnd();
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = 0;
  const fall = uniform(1.4); // m/s
  const amountU = uniform(0);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.fog = true;
  {
    const seed = attribute('aSeed', 'vec4');
    const t = U.time;
    // wind carries the flakes; gusts add a sideways rush
    const wind = vec3(U.windDir.x, float(0), U.windDir.y).mul(U.windSpeed.mul(float(0.85).add(U.gust.mul(0.6))));
    const drift = vec3(seed.w.sub(0.5).mul(0.6), fall.mul(seed.z.mul(0.5).add(0.75)).negate(), seed.z.sub(0.5).mul(0.6));
    const vel = wind.add(drift);
    const span = float(BOX * 2);
    const p0 = vec3(seed.x, seed.y, seed.z).mul(span);
    const p = p0.add(vel.mul(t));
    // wrap into the box centred on the camera
    const rel = fract(p.sub(cameraPosition).div(span).add(0.5)).sub(0.5).mul(span);
    const world = cameraPosition.add(rel);
    // a camera-facing quad, a little longer in a gale (the mesh sits at the origin: local = world)
    const size = float(0.024).add(seed.w.mul(0.02));
    const stretch = float(1).add(vel.length().mul(0.03));
    const camRight = cameraWorldMatrix.element(0).xyz;
    const camUp = cameraWorldMatrix.element(1).xyz;
    const q = positionLocal;
    mat.positionNode = world.add(camRight.mul(q.x.mul(size))).add(camUp.mul(q.y.mul(size).mul(stretch)));
    // round soft flake; fade at the edge of the box and very close to the lens
    const d = uv().sub(0.5).length().mul(2);
    const soft = float(1).sub(tslSmooth(0.4, 1.0, d));
    const edge = float(1).sub(tslSmooth(BOX * 0.6, BOX * 0.98, rel.length()));
    const near = tslSmooth(0.25, 0.9, rel.length());
    // a flake is a small white scatterer: lit by the whole sky and a little by the sun
    const light = U.skyAmbient.mul(1.1).add(U.groundAmbient.mul(0.3)).add(U.sunColor.mul(0.06)).add(U.moonColor.mul(0.5));
    mat.colorNode = light;
    mat.opacityNode = soft.mul(edge).mul(near).mul(amountU).mul(0.85);
  }
  const flakes = new THREE.Mesh(geo, mat);
  flakes.frustumCulled = false;
  flakes.renderOrder = 10;
  flakes.name = 'standin-snowfall';
  scene.add(flakes);
  let budget = 3000;

  const fogCol = new THREE.Color();
  const stormCol = new THREE.Color();
  const sys = {
    name: 'weather',
    whiteout: 0,
    setQuality(q: Quality): void {
      budget = Math.min(MAX, Math.round(q.snowParticles * 0.6));
    },
    update(f: Frame): void {
      const env = f.view.env;
      const storm = env.storm;
      const ws = Math.hypot(env.windX, env.windZ);
      if (ws > 1e-4) U.windDir.value.set(env.windX / ws, env.windZ / ws);
      U.windSpeed.value = ws * (1 + env.gust * 0.5);
      U.gust.value = env.gust;
      U.storm.value = storm;
      U.snowfall.value = env.snowfall;
      U.visibility.value = env.visibility;
      U.snowCover.value = Math.min(1, 0.72 + env.snowAccum * 4);
      // fog: about 3 / visibility, thick at every height in a storm
      U.fogDensity.value = 3 / Math.max(env.visibility, 4);
      U.fogHeight.value = lerp(0.004, 0.0004, smoothstep(0.2, 0.8, storm));
      const sk = ATMOS.skyAmbient, sc = ATMOS.sunColor, sd = ATMOS.sunDir;
      const sunUp = Math.max(sd.y, 0);
      fogCol.setRGB(sk.r * 0.62 + sc.r * 0.03 * sunUp + sc.r * 0.02, sk.g * 0.62 + sc.g * 0.03 * sunUp + sc.g * 0.012, sk.b * 0.62 + sc.b * 0.03 * sunUp + sc.b * 0.006);
      stormCol.setRGB(sk.r * 0.55, sk.g * 0.55, sk.b * 0.55);
      fogCol.lerp(stormCol, smoothstep(0.2, 0.8, storm));
      U.fogColor.value.copy(fogCol);
      ATMOS.fogColor.copy(fogCol);
      sys.whiteout = smoothstep(45, 8, env.visibility);
      // snowfall
      const want = Math.round(budget * Math.min(1, env.snowfall * 1.15));
      geo.instanceCount = want;
      flakes.visible = want > 0;
      amountU.value = Math.min(1, 0.35 + env.snowfall);
      fall.value = 1.2 + env.snowfall * 0.6;
    },
    dispose(): void {
      scene.fogNode = null;
      scene.remove(flakes);
      geo.dispose();
      mat.dispose();
    },
  };
  return sys;
}
