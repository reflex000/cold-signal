// Shared pieces of the forest renderer: shader hashes and dither, a small value-noise texture, the
// lit material base (with an analytic sky reflection when the scene has no environment map, like
// the prop material), the snow-coverage rule every forest material agrees on, and the wind.
//
// Everything here is TSL and runs on the WebGPU and the WebGL2 backends alike.
import * as THREE from 'three/webgpu';
import {
  Fn, cameraProjectionMatrix, cameraWorldMatrix, cos, dot, float, fract, mix, normalView, normalWorld, pmremTexture, positionViewDirection,
  pow, roughness, screenCoordinate, sin, smoothstep, texture, vec2, vec3, vec4,
} from 'three/tsl';
import { HorizonPhongLighting, HorizonPhysicalLighting, U } from '../shared';

export type N = any;

// ------------------------------------------------------------------------------------------
// Hashes (no sin: precision of sin on large arguments differs between GPUs)
// ------------------------------------------------------------------------------------------

/** Hash of a float (keep |x| below a few thousand) into [0, 1). Dave Hoskins' hash without sine. */
export function hash11(x: N): N {
  const p: N = fract(float(x).mul(0.1031));
  const q: N = p.mul(p.add(33.33));
  return fract(q.mul(q.add(q)));
}

/** Two independent hashes of a float into [0, 1). */
export function hash12(x: N): N {
  const p: N = fract(vec2(x, x).mul(vec2(0.1031, 0.103)));
  const q: N = p.add(dot(p, p.yx.add(33.33)));
  return fract(q.x.add(q.y).mul(q));
}

/**
 * Interleaved gradient noise of the pixel: a stable screen-space dither in [0, 1). Under an
 * orthographic projection (a shadow map) it is a constant 0.5: a fading tree then switches its
 * shadow at the middle of its band instead of casting a stippled one.
 */
export function ditherNoise(): N {
  const p: N = screenCoordinate.xy.floor();
  const ign: N = fract(fract(dot(p, vec2(0.06711056, 0.00583715))).mul(52.9829189));
  const ortho: N = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.clamp(0, 1);
  return mix(ign, float(0.5), ortho);
}

/** CPU twin of hash11 (float32 differences make it differ in the last bits only). */
export function hash11cpu(x: number): number {
  let p = x * 0.1031;
  p -= Math.floor(p);
  p *= p + 33.33;
  p *= p + p;
  return p - Math.floor(p);
}

// ------------------------------------------------------------------------------------------
// Value noise texture: 256^2 RGBA8, four independent channels, tiling, mipmapped
// ------------------------------------------------------------------------------------------

let noiseTex: THREE.DataTexture | null = null;
export function getForestNoise(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  let s = 0x6c8e9cf5;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  // Four octaves of smoothed lattice noise per channel so a single tap already looks organic.
  const lat = new Float32Array(n * n);
  const acc = new Float32Array(n * n);
  for (let ch = 0; ch < 4; ch++) {
    acc.fill(0);
    let amp = 1, tot = 0;
    for (let oct = 0; oct < 4; oct++) {
      const cell = 32 >> oct; // lattice spacing in texels, divides 256 so it tiles
      const m = n / cell;
      for (let i = 0; i < m * m; i++) lat[i] = rnd();
      for (let y = 0; y < n; y++) {
        const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < n; x++) {
          const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % m, x1 = (ix + 1) % m, y0 = iy % m, y1 = (iy + 1) % m;
          const a = lat[y0 * m + x0], b = lat[y0 * m + x1], c = lat[y1 * m + x0], d = lat[y1 * m + x1];
          acc[y * n + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        }
      }
      tot += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < n * n; i++) {
      // stretch the contrast back out (a sum of octaves bunches up around 0.5)
      const v = (acc[i] / tot - 0.5) * 1.9 + 0.5;
      data[i * 4 + ch] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

/** RGBA noise in 0..1 at uv (texture repeats every unit). */
export function noiseAt(uv: N): N {
  return texture(getForestNoise(), uv);
}

// ------------------------------------------------------------------------------------------
// Lit material base: MeshStandardNodeMaterial with an analytic sky reflection fallback
// ------------------------------------------------------------------------------------------

class ForestSkyReflection extends THREE.LightingNode {
  static get type(): string {
    return 'ColdSignalForestSkyReflection';
  }
  setup(builder: any): any {
    const refl: N = positionViewDirection.negate().reflect(normalView);
    const dir: N = pow(roughness, 4).mix(refl, normalView).normalize().transformDirection(cameraWorldMatrix);
    const blur: N = roughness.mul(0.6).add(0.12);
    const zenith: N = vec3(U.skyAmbient).mul(0.42);
    const horizon: N = vec3(U.fogColor);
    const ground: N = vec3(U.groundAmbient).mul(0.5);
    const sky: N = mix(horizon, zenith, dir.y.max(0).pow(0.6));
    const k: number = (builder.material as ForestMaterial).envScale ?? 1;
    builder.context.radiance.addAssign(mix(ground, sky, smoothstep(blur.negate(), blur, dir.y)).mul(k));
    return null;
  }
}

/** The lit material every forest mesh uses (fog on, sky reflection when there is no env map). */
export class ForestMaterial extends THREE.MeshStandardNodeMaterial {
  /**
   * Scale on the sky reflection. Foliage cards are flat stand-ins for bundles of needles: with the
   * full Fresnel of a smooth plane they glare grey at grazing angles, so tree materials use ~0.2.
   */
  envScale = 1;
  static get type(): string {
    return 'ColdSignalForestMaterial';
  }
  constructor() {
    super();
    this.fog = true;
  }
  setupEnvironment(builder: any): any {
    const node = super.setupEnvironment(builder);
    return node ?? new ForestSkyReflection();
  }
  /** Standard lighting plus TERRAIN's baked ridge shadow on the key light (see ../shared.ts). */
  setupLightingModel(): any {
    return new HorizonPhysicalLighting();
  }
}

/**
 * Lambert (diffuse only) for foliage and impostors. A card stands in for a bundle of needles: a
 * smooth-plane specular lobe (F0 0.04 against an albedo of 0.03) turned whole crowns khaki-grey in
 * the sun. Cheaper too, which matters for the most-shaded pixels of the frame.
 */
export class ForestLambert extends THREE.MeshLambertNodeMaterial {
  static get type(): string {
    return 'ColdSignalForestLambert';
  }
  constructor() {
    super();
    this.fog = true;
  }
  /**
   * In r187 a Lambert material ignores scene.environment (only the standard material picks it up),
   * so without this the crowns would get no sky light at all: black in shade, tinted navy by the fog.
   */
  setupEnvironment(builder: any): any {
    const node = super.setupEnvironment(builder);
    if (node) return node;
    return builder.environmentNode ? new ForestEnvIrradiance(builder.environmentNode) : null;
  }
  /** Lambert (Phong without specular) plus TERRAIN's baked ridge shadow on the key light. */
  setupLightingModel(): any {
    return new HorizonPhongLighting(false);
  }
}

/**
 * The diffuse part of the image-based light for Lambert materials: the environment's irradiance
 * along the normal (its blurriest level, as three's EnvironmentNode does for standard materials),
 * added to the irradiance the Phong model's indirect term reads.
 */
class ForestEnvIrradiance extends THREE.LightingNode {
  static get type(): string {
    return 'ColdSignalForestEnvIrradiance';
  }
  private pmrem: N = null;
  constructor(private envNode: N) {
    super();
    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
  }
  setup(builder: any): any {
    this.pmrem ??= pmremTexture(this.envNode.value);
    const irr: N = this.pmrem.context({ getUV: () => normalWorld, getTextureLevel: () => float(1) }).mul(Math.PI);
    builder.context.irradiance.addAssign(irr);
    return null;
  }
  updateBefore(frame: any): boolean | undefined {
    // the environment can be swapped without a rebuild (as in three's EnvironmentNode)
    const t = this.envNode.value;
    if (t && this.pmrem && this.pmrem.value !== t) {
      this.pmrem.value = t;
      this.pmrem.updateBefore(frame);
    }
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------
// Snow
// ------------------------------------------------------------------------------------------

/** Snow albedo (linear), as on props: never pure white. */
export const SNOW_ALBEDO: [number, number, number] = [0.86, 0.89, 0.93];

/** Effective snow load 0..1 of a tree from its own load and the fresh cover of the weather. */
export function effectiveSnow(load: N): N {
  return float(load).mul(U.snowCover.mul(0.75).add(0.4)).clamp(0, 1);
}

/**
 * Coverage 0..1 of snow on a surface whose snow potential is `p` (0 never .. 1 always first) under
 * an effective load `s`. Every forest material and the impostor use this, so a baked impostor shows
 * the same snow as the mesh for any load.
 */
export function snowCoverage(s: N, p: N, w: N = 0.08): N {
  const th: N = float(1.04).sub(float(s).mul(0.94));
  return smoothstep(th.sub(w), th.add(w), p);
}

/**
 * Snow colour as lit by the material: cream toward the sun, blue-grey away from it, with a little
 * light coming back out of the snow on the shaded side (emissive). `nW` is the world normal.
 */
export function snowShade(nW: N): { color: N; emissive: N } {
  const sunFacing: N = dot(nW, vec3(U.sunDir)).max(0);
  const color: N = vec3(SNOW_ALBEDO[0], SNOW_ALBEDO[1], SNOW_ALBEDO[2]).mul(mix(vec3(0.84, 0.91, 1.0), vec3(1.0, 0.985, 0.95), sunFacing));
  const emissive: N = vec3(U.skyAmbient).mul(vec3(0.25, 0.5, 1.0)).mul(0.06).mul(sunFacing.oneMinus());
  return { color, emissive };
}

// ------------------------------------------------------------------------------------------
// Wind
// ------------------------------------------------------------------------------------------

/**
 * Strength 0..~1.5 of the gust passing over a world XZ point: bands of stronger wind roll downwind
 * across the forest at the wind speed, so gusts can be seen coming over the slope.
 */
export function gustAt(xz: N): N {
  const dir: N = vec2(U.windDir.x, U.windDir.y);
  const along: N = dot(xz, dir);
  const across: N = dot(xz, vec2(dir.y.negate(), dir.x));
  const k = (Math.PI * 2) / 90; // 90 m between gust fronts
  const ph: N = along.mul(k).sub(U.time.mul(U.windSpeed.max(1)).mul(k)).add(sin(across.mul(0.021)).mul(1.7));
  const band: N = sin(ph).mul(0.5).add(0.5);
  return float(0.35).add(U.gust.mul(1.1)).mul(band.mul(band).mul(0.8).add(0.2));
}

/**
 * Whole-tree sway: world-space displacement of a point at height h (m above the base) on a tree of
 * height ht (m). The trunk is stiff: the bend grows with (h / ht)^2. `rnd` de-phases trees; `g` is
 * gustAt(base). Taller trees swing slower.
 */
export function treeSway(h: N, ht: N, rnd: N, g: N): N {
  const speed: N = U.windSpeed;
  const dir: N = vec3(U.windDir.x, 0, U.windDir.y);
  const side: N = vec3(U.windDir.y.negate(), 0, U.windDir.x);
  const k: N = h.div(ht.max(0.5)).clamp(0, 1.2);
  const bend: N = k.mul(k);
  const f0: N = float(2.3).div(ht.max(1).sqrt()); // rad/s: ~0.6 for a 14 m tree
  const t: N = U.time;
  const ph: N = rnd.mul(6.2831);
  // static lean grows with the drag (speed squared), capped: a big spruce bends a few degrees
  const lean: N = speed.mul(speed).mul(0.00011).add(speed.mul(0.0016)).mul(g.mul(0.6).add(0.7)).min(0.075);
  const osc: N = speed.mul(0.0011).add(0.0012).mul(g.add(0.25));
  const a: N = lean.add(osc.mul(sin(t.mul(f0).add(ph))));
  const b: N = osc.mul(0.45).mul(sin(t.mul(f0.mul(1.37)).add(ph.mul(1.9))));
  const top: N = dir.mul(a).add(side.mul(b)).mul(ht);
  const d: N = top.mul(bend);
  // keep the length: a point that swings sideways drops a little
  const drop: N = dot(d, d).div(h.max(0.5).mul(2));
  return d.sub(vec3(0, drop, 0));
}

/**
 * Branch bounce: vertical and sideways flutter of a branch point, in metres. `reach` is the distance
 * from the branch attachment (m), `along` 0..1 along the branch, `ph` the branch phase (0..1).
 * Loaded branches move less.
 */
export function branchBounce(reach: N, along: N, ph: N, g: N, load: N): N {
  const speed: N = U.windSpeed;
  const t: N = U.time;
  const amp: N = speed.mul(0.0065).add(0.004).mul(g.add(0.3)).mul(float(load).mul(-0.45).add(1));
  const w: N = float(2.1).add(ph.mul(1.6)).add(speed.mul(0.05));
  const p: N = ph.mul(6.2831);
  const v: N = sin(t.mul(w).add(p)).mul(0.7).add(sin(t.mul(w.mul(2.7)).add(p.mul(3.1))).mul(0.3));
  const curl: N = along.mul(along.sqrt());
  const side: N = vec3(U.windDir.y.negate(), 0, U.windDir.x);
  const s: N = cos(t.mul(w.mul(1.3)).add(p.mul(1.7))).mul(0.35);
  return vec3(0, v, 0).add(side.mul(s)).mul(reach.mul(curl).mul(amp));
}

/** Rotate a vector about +Y by angle a (three.js rotation.y convention). */
export function rotY(v: N, a: N): N {
  const c: N = cos(a), s: N = sin(a);
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
}

export { Fn };
