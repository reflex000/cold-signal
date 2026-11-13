// Baked terrain shadows (horizon maps) for the light that matters: the sun by day, the moon at
// night. For every texel, a GPU pass marches the heightmap and the far map toward the light's
// azimuth and stores the elevation angle of the terrain horizon. Materials compare that with the
// light's current elevation, so distant ridges shade valleys far beyond the shadow-map distance,
// and the sun can climb or sink without a rebuild.
//
// Two slots (A, B) hold maps for two azimuths STEP apart that bracket the light; materials blend
// them by the light's azimuth, so shadow edges glide instead of jumping. When the light leaves the
// bracket, the slot behind it is re-rendered one STEP ahead (one pass over its inner 512^2 + outer
// 256^2 texels, about a millisecond on the target iGPU); a jump (time skip, sun -> moon) rebuilds
// both.
//
// Both slots live in ONE texture (layout: HORIZON_ATLAS in ../shared.ts), published as
// U.horizonTex / U.horizonMap / U.horizonDir, so the terrain, the forest and the props all read
// the same maps through horizonLit() / keyLightHorizon(), and the terrain material stays inside
// the 16 sampled textures per stage of WebGL2. A slot is re-rendered with a scissor over its own
// columns; the scissor spans the full height, so its y convention does not matter on either
// backend, and the bake and the lookup share the same uv mapping.
//
// Encoding (RGBA8): angle = (r + g / 255) * RANGE + LOW, radians. Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, atan, float, floor, max, select, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { HORIZON_ATLAS as A, U, horizonAngle, horizonLit } from '../shared';
import { DOMAIN_HALF } from './config';
import type { TerrainData } from './data';
import type { HeightFns } from './height';

type N = any;

const STEP = (3 * Math.PI) / 180;
const EARTH_R2 = 2 * 6371000;

const angleDiff = (a: number, b: number): number => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

export class HorizonMaps {
  /** Number of slot passes rendered so far (stats). */
  builds = 0;

  private az: [number, number] = [0, 0];
  private base = 0; // slot nearest behind the light
  private sgn = 1; // direction the azimuth is moving
  private rt: THREE.RenderTarget;
  private quad: THREE.QuadMesh;
  private mat: THREE.NodeMaterial;
  private uMarchDir = uniform(new THREE.Vector2(0, -1));
  private uMaxH: N;
  private state: any;
  private extent: number;
  private valid = false;

  constructor(data: TerrainData, private h: HeightFns) {
    this.rt = new THREE.RenderTarget(A.w, A.h, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.rt.texture.name = 'Terrain.horizon';
    this.extent = data.fineExtent;
    const top = data.minmax.levels[data.minmax.levels.length - 1];
    let maxH = data.far.max;
    for (let i = 0; i < top.max.length; i++) maxH = Math.max(maxH, top.max[i]);
    this.uMaxH = uniform(maxH + 10);

    // Published before any material compiles: everything that samples it reads this atlas.
    U.horizonTex.value = this.rt.texture;
    U.horizonMap.value.set(this.extent, 0, 0, DOMAIN_HALF);

    const ext = this.extent;
    const mat = new THREE.NodeMaterial();
    mat.name = 'terrain-horizon';
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.fragmentNode = Fn(() => {
      // which map this texel belongs to: the inner (4 m texels, march from 6 m) or the outer
      // (48 m texels over the whole domain, march from 60 m); the spare corner exits at once
      const px = uv().x.mul(A.w);
      const lx = px.sub(floor(px.div(A.slotW)).mul(A.slotW));
      const py = uv().y.mul(A.h);
      const isInner = lx.lessThan(A.inner);
      const qo = vec2(lx.sub(A.inner).div(A.outer), py.div(A.outer));
      const qi = vec2(lx.div(A.inner), py.div(A.inner));
      const p0 = select(isInner, qi.mul(2 * ext).sub(ext), qo.mul(2 * DOMAIN_HALF).sub(DOMAIN_HALF)).toVar();
      const spare = isInner.not().and(qo.y.greaterThan(1));
      const ratio = select(isInner, float(1.065), float(1.07));
      const h0 = h.height(p0, false).add(0.4).toVar();
      const best = float(-0.25).toVar(); // tan of the horizon elevation
      const t = select(isInner, float(6), float(60)).toVar();
      If(spare, () => {
        t.assign(1e9);
      });
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
        t.mulAssign(ratio);
      });
      const enc = atan(best).sub(A.low).div(A.range).clamp(0, 1).mul(255);
      const hi = enc.floor();
      return vec4(hi.div(255), enc.sub(hi), 0, 1);
    })();
    this.mat = mat;
    this.quad = new THREE.QuadMesh(mat);
    this.quad.name = 'Terrain [ horizon ]';
    void texture; // (the atlas is read through ../shared.ts)
  }

  /** Unit xz vector toward the light the maps were made for (the bracket's middle). */
  get uDir(): N {
    return U.horizonDir;
  }

  /** Horizon elevation angle (radians) at world xz, blended between the two slots. */
  angle(xz: N): N {
    return horizonAngle(xz);
  }

  /** Lit fraction 0..1 for a light at elevation `elev` (radians) seen from world xz. */
  lit(xz: N, elev: N): N {
    return horizonLit(xz, elev);
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
    const a = this.base, b = 1 - this.base;
    const span = angleDiff(this.az[b], this.az[a]); // = sgn * STEP
    const t = angleDiff(az, this.az[a]) / span;
    if (t >= 0 && t <= 1) {
      this.setBlend(t);
    } else if (t > 1 && t < 2) {
      // moved past the far slot: it becomes the base, re-render the old base one step further
      this.base = b;
      this.az[a] = this.az[b] + span;
      this.render(renderer, a);
      this.setBlend(angleDiff(az, this.az[b]) / span);
    } else if (t < 0 && t > -1) {
      // turned back: re-render the far slot one step behind the base
      this.sgn = -this.sgn;
      this.az[b] = this.az[a] - span;
      this.render(renderer, b);
      this.setBlend(angleDiff(az, this.az[a]) / -span);
    } else {
      this.rebuildAround(renderer, az);
    }
  }

  private setBlend(tFromBase: number): void {
    const t = Math.min(1, Math.max(0, tFromBase));
    // horizonMap.y is the weight of slot index 1
    U.horizonMap.value.y = this.base === 0 ? t : 1 - t;
    const a = this.az[this.base], b = this.az[1 - this.base];
    const mid = a + angleDiff(b, a) * t;
    U.horizonDir.value.set(Math.sin(mid), -Math.cos(mid));
  }

  private rebuildAround(renderer: THREE.WebGPURenderer, az: number): void {
    this.base = 0;
    this.az[0] = az;
    this.az[1] = az + this.sgn * STEP;
    this.render(renderer, 0);
    this.render(renderer, 1);
    this.valid = true;
    U.horizonMap.value.z = 1;
    this.setBlend(0);
  }

  private render(renderer: THREE.WebGPURenderer, slot: number): void {
    const az = this.az[slot];
    this.uMarchDir.value.set(Math.sin(az), -Math.cos(az));
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    // No clear: a WebGPU clear ignores the scissor and would wipe the other slot.
    renderer.autoClear = false;
    // the slot's columns only, full height
    this.rt.scissor.set(slot * A.slotW, 0, A.slotW, A.h);
    this.rt.scissorTest = true;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    this.builds++;
  }

  dispose(): void {
    if (U.horizonTex.value === this.rt.texture) {
      U.horizonMap.value.z = 0;
    }
    this.rt.dispose();
    this.mat.dispose();
  }
}
