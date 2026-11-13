// Shared rendering state: the TSL uniforms every material may read, and a plain JS mirror of
// the atmosphere. See docs/DESIGN.md section 5. Systems write, materials read.
// Owner: ENGINE keeps this file; anyone may add a uniform here (append, never rename).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const { If, texture, uniform: objUniform, renderGroup, abs, asin, cameraWorldMatrix, clamp, dot, float, length, max, mix, positionWorld, smoothstep, step, vec2 } = TSL as any;

/**
 * Every shared uniform lives in three's RENDER group: uploaded once per render call and seen by
 * every draw. In the default object group a uniform is only refreshed for materials that have node
 * properties of their own, so plain materials read stale values through scene.fogNode.
 */
const uniform = (v: unknown): any => objUniform(v).setGroup(renderGroup);

// A 1x1 black texture so texture uniforms are valid before their owner has made the real one.
const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blank.needsUpdate = true;

const _U = {
  time: uniform(0),
  // wind
  windDir: uniform(new THREE.Vector2(1, 0)), // world XZ unit vector the air moves toward
  windSpeed: uniform(4), // m/s, mean plus gust
  gust: uniform(0),
  // weather
  storm: uniform(0),
  snowfall: uniform(0),
  snowCover: uniform(0.8), // fresh snow lying on props and branches
  visibility: uniform(4000), // metres
  // light
  sunDir: uniform(new THREE.Vector3(0.3, 0.5, 0.8).normalize()),
  sunColor: uniform(new THREE.Color(1, 0.95, 0.88)),
  moonDir: uniform(new THREE.Vector3(-0.3, 0.6, -0.5).normalize()),
  moonColor: uniform(new THREE.Color(0.05, 0.07, 0.1)),
  skyAmbient: uniform(new THREE.Color(0.35, 0.45, 0.6)),
  groundAmbient: uniform(new THREE.Color(0.25, 0.27, 0.3)),
  night: uniform(0), // 0 day .. 1 night
  // fog
  fogColor: uniform(new THREE.Color(0.7, 0.76, 0.82)),
  fogDensity: uniform(0.0006), // 1/m at camera height
  fogHeight: uniform(0.004), // falloff with height above the camera, 1/m
  // view
  camPos: uniform(new THREE.Vector3()),
  playerPos: uniform(new THREE.Vector3()),
  exposure: uniform(1),
  // snow deformation map around the player: R = how far the snow is pressed down, 0..1
  trailTex: texture(blank),
  trailOrigin: uniform(new THREE.Vector2()), // world XZ of the map centre
  trailSize: uniform(64), // metres across
  trailOn: uniform(0), // 0 when the map is not available
  // screen (written by the engine on resize)
  resolution: uniform(new THREE.Vector2(1, 1)), // drawing-buffer size in pixels
  // Baked terrain horizon (written by gfx/terrain, read through horizonLit / keyLightHorizon):
  // the elevation angle of the terrain horizon toward the key light, so a valley in a ridge's
  // shadow is in shadow on every surface at any distance. Layout: see HORIZON_ATLAS.
  horizonTex: texture(blank),
  horizonMap: uniform(new THREE.Vector4(1, 0, 0, 6144)), // x inner half extent (m), y weight of slot B, z 1 once valid, w domain half extent (m)
  horizonDir: uniform(new THREE.Vector2(0, -1)), // unit world XZ toward the light the maps were baked for
};

/**
 * The shared uniforms. Members are typed `any` on purpose: TSL node typings are strict about
 * colour vs vec3 and get in the way; treat every member as a TSL node with a `.value`.
 */
export const U = _U as { [K in keyof typeof _U]: any };

/** Plain JS mirror for code that is not a shader (particles, audio, exposure, UI). */
export const ATMOS = {
  sunDir: new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
  sunColor: new THREE.Color(1, 0.95, 0.88),
  sunIntensity: 1,
  moonDir: new THREE.Vector3(-0.3, 0.6, -0.5).normalize(),
  moonColor: new THREE.Color(0.05, 0.07, 0.1),
  skyAmbient: new THREE.Color(0.35, 0.45, 0.6),
  groundAmbient: new THREE.Color(0.25, 0.27, 0.3),
  fogColor: new THREE.Color(0.7, 0.76, 0.82),
  night: 0,
  /** Scene-referred brightness the eye should adapt to, for auto exposure. */
  luminance: 1,
};

// ---------------------------------------------------------------------------------------------
// Baked terrain horizon (maps rendered by src/gfx/terrain/horizon.ts)
// ---------------------------------------------------------------------------------------------

/**
 * One RGBA8 atlas holds both azimuth slots. Slot s spans x = [s * slotW, (s + 1) * slotW): its
 * inner map (inner^2 texels over the heightmap square) at the left, its outer map (outer^2 texels
 * over the whole domain) at the right in the rows [0, outer). Angle = (r + g / 255) * range + low
 * (radians). Packing keeps the terrain material inside the 16 sampled textures per stage that
 * WebGL2 and baseline WebGPU allow.
 */
export const HORIZON_ATLAS = { inner: 512, outer: 256, slotW: 768, w: 1536, h: 512, low: -0.25, range: 1.45 } as const;

/** Horizon elevation angle (radians) at world xz, blended between the two azimuth slots. */
export function horizonAngle(xz: any): any {
  const A = HORIZON_ATLAS;
  const m = U.horizonMap;
  const ext = m.x, dom = m.w;
  const ci = 0.5 / A.inner, co = 0.5 / A.outer; // half-texel insets: bilinear taps stay inside the map
  const uvI = xz.add(ext).div(ext.mul(2)).clamp(ci, 1 - ci);
  const uvO = xz.add(dom).div(dom.mul(2)).clamp(co, 1 - co);
  const inner = smoothstep(0, 48, ext.sub(max(abs(xz.x), abs(xz.y))));
  const dec = (s: any): any => s.x.add(s.y.div(255)).mul(A.range).add(A.low);
  const tap = (u: any): any => dec(U.horizonTex.sample(u).level(0));
  const iA = tap(vec2(uvI.x.mul(A.inner).div(A.w), uvI.y.mul(A.inner / A.h)));
  const iB = tap(vec2(uvI.x.mul(A.inner).add(A.slotW).div(A.w), uvI.y.mul(A.inner / A.h)));
  const a = mix(iA, iB, m.y).toVar();
  // the outer maps only matter outside the heightmap square: skip their taps everywhere else
  // (explicit-level taps are legal in a per-pixel branch on both backends)
  If(inner.lessThan(0.999), () => {
    const oA = tap(vec2(uvO.x.mul(A.outer).add(A.inner).div(A.w), uvO.y.mul(A.outer / A.h)));
    const oB = tap(vec2(uvO.x.mul(A.outer).add(A.slotW + A.inner).div(A.w), uvO.y.mul(A.outer / A.h)));
    a.assign(mix(mix(oA, oB, m.y), a, inner));
  });
  return a;
}

/** Lit fraction 0..1 of a light at elevation `elev` (radians) seen from world xz (1 until baked). */
export function horizonLit(xz: any, elev: any): any {
  // the sun's disc is 0.53 deg; the extra width hides the 4 m texels
  return mix(float(1), smoothstep(-0.009, 0.009, elev.sub(horizonAngle(xz))), U.horizonMap.z);
}

/**
 * For a LightingModel.direct() input: the factor that puts the baked terrain shadow on the light
 * the horizon maps were baked for (the key light; any other light gets 1). `lightDirection` is in
 * view space, as three hands it to direct(). Multiply it into input.lightColor.
 */
export function keyLightHorizon(input: { lightDirection: any; lightNode?: any }): any {
  const light = input.lightNode?.light;
  if (!light || light.isDirectionalLight !== true) return null;
  const lw = input.lightDirection.transformDirection(cameraWorldMatrix);
  const len = length(lw.xz);
  const flat = lw.xz.div(max(len, 1e-4));
  const aligned = smoothstep(0.985, 0.996, dot(flat, U.horizonDir)).mul(step(0.02, len)).mul(U.horizonMap.z);
  const elev = asin(clamp(lw.y, -1, 1));
  return mix(float(1), horizonLit(positionWorld.xz, elev), aligned);
}

/** PhysicalLightingModel (MeshStandardNodeMaterial) with the baked terrain shadow on the key light. */
export class HorizonPhysicalLighting extends THREE.PhysicalLightingModel {
  direct(input: any, builder: any): void {
    const k = keyLightHorizon(input);
    super.direct(k ? { ...input, lightColor: input.lightColor.mul(k) } : input, builder);
  }
}

/** PhongLightingModel (MeshLambertNodeMaterial: specular off) with the baked terrain shadow on the key light. */
export class HorizonPhongLighting extends THREE.PhongLightingModel {
  direct(input: any, builder: any): void {
    const k = keyLightHorizon(input);
    super.direct(k ? { ...input, lightColor: input.lightColor.mul(k) } : input, builder);
  }
}
