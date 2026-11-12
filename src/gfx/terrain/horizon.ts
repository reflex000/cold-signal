// Baked terrain shadows (horizon maps) for the light that matters: the sun by day, the moon at
// night. For every texel, a GPU pass marches the heightmap and the far map toward the light's
// azimuth and stores the elevation angle of the terrain horizon. The material compares that with
// the light's current elevation, so distant ridges shade valleys far beyond the shadow-map
// distance, and the sun can climb or sink without a rebuild.
//
// Two slots (A, B) hold maps for two azimuths STEP apart that bracket the light; the material
// blends them by the light's azimuth, so shadow edges glide instead of jumping. When the light
// leaves the bracket, the slot behind it is re-rendered one STEP ahead (one inner 512^2 + one outer
// 256^2 pass, about a millisecond on the target iGPU); a jump (time skip, sun -> moon) rebuilds both.
//
// Encoding (RGBA8): angle = (r + g / 255) * RANGE + LOW, radians. Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, atan, float, max, mix, smoothstep, texture, uniform, uv, vec4 } from 'three/tsl';
import { DOMAIN_HALF, HORIZON_INNER, HORIZON_OUTER } from './config';
import type { TerrainData } from './data';
import type { HeightFns } from './height';

type N = any;

const LOW = -0.25;
const RANGE = 1.45;
const STEP = (3 * Math.PI) / 180;
const EARTH_R2 = 2 * 6371000;

interface Slot {
  inner: THREE.RenderTarget;
  outer: THREE.RenderTarget;
  az: number;
}

function makeRT(size: number): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

const angleDiff = (a: number, b: number): number => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

export class HorizonMaps {
  /** Weight of slot B in the blend. */
  readonly uBlend = uniform(0);
  /** 1 once the maps hold something. */
  readonly uOn = uniform(0);
  /** Unit xz vector toward the light the maps were made for (the bracket's middle). */
  readonly uDir = uniform(new THREE.Vector2(0, -1));
  /** Number of passes rendered so far (stats). */
  builds = 0;

  private slots: [Slot, Slot];
  private base = 0; // slot nearest behind the light
  private sgn = 1; // direction the azimuth is moving
  private quad: THREE.QuadMesh;
  private mat: THREE.NodeMaterial;
  private uOrigin = uniform(new THREE.Vector2());
  private uSize = uniform(1);
  private uMarchDir = uniform(new THREE.Vector2(0, -1));
  private uT0 = uniform(6);
  private uRatio = uniform(1.07);
  private uMaxH: N;
  private state: any;
  private texIA: N;
  private texIB: N;
  private texOA: N;
  private texOB: N;
  private extent: number;
  private valid = false;

  constructor(data: TerrainData, private h: HeightFns) {
    this.slots = [
      { inner: makeRT(HORIZON_INNER), outer: makeRT(HORIZON_OUTER), az: 0 },
      { inner: makeRT(HORIZON_INNER), outer: makeRT(HORIZON_OUTER), az: 0 },
    ];
    this.extent = data.fineExtent;
    const top = data.minmax.levels[data.minmax.levels.length - 1];
    let maxH = data.far.max;
    for (let i = 0; i < top.max.length; i++) maxH = Math.max(maxH, top.max[i]);
    this.uMaxH = uniform(maxH + 10);
    this.texIA = texture(this.slots[0].inner.texture);
    this.texIB = texture(this.slots[1].inner.texture);
    this.texOA = texture(this.slots[0].outer.texture);
    this.texOB = texture(this.slots[1].outer.texture);

    const mat = new THREE.NodeMaterial();
    mat.name = 'terrain-horizon';
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.fragmentNode = Fn(() => {
      const p0 = this.uOrigin.add(uv().mul(this.uSize)).toVar();
      const h0 = h.height(p0, false).add(0.4).toVar();
      const best = float(-0.25).toVar(); // tan of the horizon elevation
      const t = this.uT0.toVar();
      Loop(160, () => {
        const p = p0.add(this.uMarchDir.mul(t));
        If(max(p.x.abs(), p.y.abs()).greaterThan(DOMAIN_HALF), () => {
          Break();
        });
        const hh = h.height(p, false).sub(t.mul(t).div(EARTH_R2));
        best.assign(max(best, hh.sub(h0).div(t)));
        // nothing further away can rise above the horizon found so far
        If(this.uMaxH.sub(h0).div(t).lessThan(best), () => {
          Break();
        });
        t.mulAssign(this.uRatio);
      });
      const enc = atan(best).sub(LOW).div(RANGE).clamp(0, 1).mul(255);
      const hi = enc.floor();
      return vec4(hi.div(255), enc.sub(hi), 0, 1);
    })();
    this.mat = mat;
    this.quad = new THREE.QuadMesh(mat);
    this.quad.name = 'Terrain [ horizon ]';
  }

  /** Horizon elevation angle (radians) at world xz, blended between the two slots. */
  angle(xz: N): N {
    const ext = this.extent;
    const uvI = xz.add(ext).div(2 * ext);
    const uvO = xz.add(DOMAIN_HALF).div(2 * DOMAIN_HALF);
    const inner = smoothstep(0, 48, float(ext).sub(max(xz.x.abs(), xz.y.abs())));
    const dec = (s: N): N => s.x.add(s.y.div(255)).mul(RANGE).add(LOW);
    const a = mix(dec(this.texOA.sample(uvO).level(0)), dec(this.texIA.sample(uvI).level(0)), inner);
    const b = mix(dec(this.texOB.sample(uvO).level(0)), dec(this.texIB.sample(uvI).level(0)), inner);
    return mix(a, b, this.uBlend);
  }

  /** Lit fraction 0..1 for a light at elevation `elev` (radians) seen from world xz. */
  lit(xz: N, elev: N): N {
    const a = this.angle(xz);
    // the sun's disc is 0.53 deg; the extra width hides the 4 m texels
    return mix(float(1), smoothstep(-0.009, 0.009, elev.sub(a)), this.uOn);
  }

  /** Keep the maps bracketing the light direction (unit, toward the light). */
  update(renderer: THREE.WebGPURenderer, dir: THREE.Vector3, force = false): void {
    const horiz = Math.hypot(dir.x, dir.z);
    if (horiz < 1e-4) return; // light at the zenith: no azimuth, keep what we have
    const az = Math.atan2(dir.x, -dir.z);
    if (!this.valid || force) {
      this.rebuildAround(renderer, az);
      return;
    }
    const sA = this.slots[this.base], sB = this.slots[1 - this.base];
    const span = angleDiff(sB.az, sA.az); // = sgn * STEP
    const t = angleDiff(az, sA.az) / span;
    if (t >= 0 && t <= 1) {
      this.setBlend(t);
    } else if (t > 1 && t < 2) {
      // moved past the far slot: it becomes the base, re-render the old base one step further
      this.base = 1 - this.base;
      const nb = this.slots[1 - this.base];
      nb.az = sB.az + span;
      this.render(renderer, nb);
      this.setBlend(angleDiff(az, sB.az) / span);
    } else if (t < 0 && t > -1) {
      // turned back: re-render the far slot one step behind the base
      this.sgn = -this.sgn;
      sB.az = sA.az - span;
      this.render(renderer, sB);
      this.setBlend(angleDiff(az, sA.az) / -span);
    } else {
      this.rebuildAround(renderer, az);
    }
  }

  private setBlend(tFromBase: number): void {
    const t = Math.min(1, Math.max(0, tFromBase));
    // uBlend is the weight of slot index 1
    this.uBlend.value = this.base === 0 ? t : 1 - t;
    const a = this.slots[this.base].az, b = this.slots[1 - this.base].az;
    const mid = a + angleDiff(b, a) * t;
    this.uDir.value.set(Math.sin(mid), -Math.cos(mid));
  }

  private rebuildAround(renderer: THREE.WebGPURenderer, az: number): void {
    this.base = 0;
    this.slots[0].az = az;
    this.slots[1].az = az + this.sgn * STEP;
    this.render(renderer, this.slots[0]);
    this.render(renderer, this.slots[1]);
    this.valid = true;
    this.uOn.value = 1;
    this.setBlend(0);
  }

  private render(renderer: THREE.WebGPURenderer, s: Slot): void {
    this.uMarchDir.value.set(Math.sin(s.az), -Math.cos(s.az));
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    // inner: 4 m texels, start past the texel's own neighbourhood (the shadow map has that)
    this.uOrigin.value.set(-this.extent, -this.extent);
    this.uSize.value = 2 * this.extent;
    this.uT0.value = 6;
    this.uRatio.value = 1.065;
    renderer.setRenderTarget(s.inner);
    this.quad.render(renderer);
    // outer: 48 m texels over the whole domain
    this.uOrigin.value.set(-DOMAIN_HALF, -DOMAIN_HALF);
    this.uSize.value = 2 * DOMAIN_HALF;
    this.uT0.value = 60;
    this.uRatio.value = 1.07;
    renderer.setRenderTarget(s.outer);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    this.builds++;
  }

  dispose(): void {
    for (const s of this.slots) {
      s.inner.dispose();
      s.outer.dispose();
    }
    this.mat.dispose();
  }
}
