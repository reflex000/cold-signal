// Nodes and uniforms shared by the sky (src/gfx/sky) and the weather (src/gfx/weather): the
// sky-view tables, the light the sky was built for, and the one fog model every pixel agrees on
// (lit materials through scene.fogNode, the sky dome, the storm volume, the particles).
//
// Fog model. Density falls with height above the camera: rho(y) = fogDensity * exp(-fogHeight *
// (y - camY)); the optical depth along a ray of length d with direction dy has a closed form. The
// colour is what the air scatters toward the eye: the horizon of the sky (clear-air haze, built on
// the CPU per world azimuth, cloud included) blended by AIR.stormMix into the storm's luminous
// snow fog (U.fogColor, its ambient part) plus a forward glow toward the sun and the moon.
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../shared';
import { MIE_G } from './atmosphere';

const { texture, uniform: objUniform, renderGroup, vec2, vec3, float, abs, clamp, max, min, dot, exp, pow, sqrt, asin, acos, atan, sign, mix, select, length } = TSL as any;

export type N = any;

/**
 * Every uniform here is in three's render group: refreshed for every draw. The default (object)
 * group is only refreshed for materials that have node properties of their own, and the fog node
 * reaches every material in the scene, plain ones included (NodeMaterialObserver.containsNode).
 */
const uniform = (v: unknown): N => objUniform(v).setGroup(renderGroup);

function blankHalf(w = 1, h = 1): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** The horizon colour table: radiance of the air just above the horizon, per world azimuth. */
export const HORIZON_W = 128;
export const horizonTexture = (() => {
  const t = blankHalf(HORIZON_W, 1);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.name = 'Sky.horizon';
  return t;
})();

/** Written by the sky system every frame; read by any shader that needs the sky. */
export const SKY = {
  sunA: texture(blankHalf()),
  sunB: texture(blankHalf()),
  moonA: texture(blankHalf()),
  moonB: texture(blankHalf()),
  /** Table scale times the light's top-of-atmosphere irradiance (linear RGB). */
  sunE: uniform(new THREE.Vector3(0, 0, 0)),
  moonE: uniform(new THREE.Vector3(0, 0, 0)),
  horizon: texture(horizonTexture),
  /** Airglow and integrated starlight: what a moonless clear night is lit by. */
  nightFloor: uniform(new THREE.Vector3(0, 0, 0)),
  /** 0..1 how much of the sky the cloud deck hides (0 clear, 1 a flat grey ceiling). */
  cover: uniform(0),
  /** Radiance of an overcast ceiling seen from below. */
  overcast: uniform(new THREE.Vector3(0.3, 0.32, 0.36)),
};

/** Written by the weather system. */
export const AIR = {
  /** 0 clear-air haze .. 1 the storm's snow fog. */
  stormMix: uniform(0),
  /** Strength of the forward glow of the snow fog toward the sun and the moon. */
  glow: uniform(1),
  /** Asymmetry of that glow (ice crystals scatter forward). */
  glowG: uniform(0.65),
  /** Fraction of the fog density the storm volume (weather/volume.ts) carries with structure. */
  volShare: uniform(0),
  /** The rest, carried by the analytic fog of every material and the sky: 1 - volShare. */
  sceneShare: uniform(1),
};

// ---------------------------------------------------------------------------------------------
// Sky-view tables
// ---------------------------------------------------------------------------------------------

/** Table coordinates for view direction d (unit) and light direction s (unit). */
export function lutUV(d: N, s: N): N {
  const l = asin(clamp(d.y, -1, 1));
  const v = float(0.5).add(sign(l).mul(sqrt(abs(l).mul(2 / Math.PI))).mul(0.5));
  const dh = vec2(d.x, d.z);
  const sh = vec2(s.x, s.z);
  const c = dot(dh, sh).div(max(length(dh).mul(length(sh)), 1e-6));
  const u = acos(clamp(c, -1, 1)).mul(1 / Math.PI);
  return vec2(u, v);
}

/** Cornette-Shanks phase with the atmosphere's g, matching atmosphere.ts miePhase. */
export function miePhase(c: N, g = MIE_G): N {
  const g2 = g * g;
  const k = (3 / (8 * Math.PI)) * ((1 - g2) / (2 + g2));
  return float(k).mul(c.mul(c).add(1)).div(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5));
}

/** Henyey-Greenstein phase with a node-valued g. */
export function hgPhase(c: N, g: N): N {
  const g2 = g.mul(g);
  return g2.oneMinus().div(pow(max(g2.add(1).sub(g.mul(c).mul(2)), 1e-4), 1.5).mul(4 * Math.PI));
}

/** Clear-sky radiance toward d: sun and moon tables plus the night floor (no discs, no clouds). */
export function clearSky(d: N): N {
  // (level 0: the tables have no mips, and an explicit level is legal inside any branch)
  const us = lutUV(d, U.sunDir);
  const sun = SKY.sunA.sample(us).level(0).rgb.add(SKY.sunB.sample(us).level(0).rgb.mul(miePhase(dot(d, U.sunDir)))).mul(SKY.sunE);
  const um = lutUV(d, U.moonDir);
  const moon = SKY.moonA.sample(um).level(0).rgb.add(SKY.moonB.sample(um).level(0).rgb.mul(miePhase(dot(d, U.moonDir)))).mul(SKY.moonE);
  // Airglow brightens toward the horizon (the van Rhijn effect: a longer path through the layer).
  const glowGrad = float(1).add(float(1.6).mul(float(1).sub(clamp(d.y, 0, 1)).pow(3)));
  return sun.add(moon).add(SKY.nightFloor.mul(glowGrad));
}

// ---------------------------------------------------------------------------------------------
// Fog
// ---------------------------------------------------------------------------------------------

/**
 * Optical depth from the camera along a ray of length dist (m) whose direction has vertical part
 * dy, for the given share of the density (default: the part the scene fog carries; the storm
 * volume carries the rest, see AIR.volShare).
 */
export function fogDepth(dist: N, dy: N, share: N = AIR.sceneShare): N {
  const x = clamp(U.fogHeight.mul(dist).mul(dy), -14, 80);
  // (1 - e^-x) / x, with its limit 1 - x/2 near zero
  const f = select(abs(x).lessThan(1e-3), float(1).sub(x.mul(0.5)), float(1).sub(exp(x.negate())).div(x));
  return U.fogDensity.mul(share).mul(dist).mul(f);
}

/** Optical depth from the camera to the edge of the world along a sky direction (dy = d.y). */
export function fogDepthSky(dy: N, share: N = AIR.sceneShare): N {
  return fogDepth(float(12000), dy, share);
}

/** The colour the fog adds toward direction d (unit). */
export function fogColor(d: N): N {
  const az = atan(d.z, d.x).mul(1 / (2 * Math.PI)).add(0.5);
  const haze = SKY.horizon.sample(vec2(az, 0.5)).level(0).rgb;
  const g: N = AIR.glowG;
  const storm = vec3(U.fogColor)
    .add(vec3(U.sunColor).mul(hgPhase(dot(d, U.sunDir), g)).mul(AIR.glow))
    .add(vec3(U.moonColor).mul(hgPhase(dot(d, U.moonDir), g)).mul(AIR.glow));
  return mix(haze, storm, AIR.stormMix);
}

/** 0..1 fog amount for a surface at distance dist along unit direction d. */
export function fogAmount(dist: N, d: N): N {
  return float(1).sub(exp(fogDepth(dist, d.y).negate()));
}


