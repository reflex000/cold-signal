// The dynamic light pool (DESIGN.md section 5): every point and spot light in the game comes from
// here, capped by quality.maxLights. Fires, flares, flashlight beams, muzzle flashes, lamps all ask
// through a persistent handle; once per frame (right before the scene is drawn, after every system
// has updated) the pool ranks the requests by importance and distance and hands the best ones the
// real THREE lights.
//
//   const fx = engine.get<FxSystem>('fx');
//   const beam = fx.lights.acquire('spot', 10);      // once
//   beam.on = me.lightOn;                            // every frame
//   beam.position.copy(hand); beam.direction.copy(aim);
//   beam.color.setRGB(1, 0.93, 0.82); beam.intensity = 60; beam.range = 35;
//   beam.angle = 0.42; beam.penumbra = 0.55;
//   ...
//   beam.release();                                  // when done for good
//
// The set of THREE lights never changes while the quality tier stays the same (a change in the
// number or kind of lights recompiles every lit material): unused lights sit at intensity 0.
// Point lights carry a colour node that shifts from `color` near the source to `colorFar` at the
// edge of the range (a fire is yellow on the stones and deep orange on the far snow). One point
// light may cast shadows (quality.fireShadows): it goes to the best request with `shadow` set.
// Particle materials (smoke, breath, steam) read the eight best requests from PARTICLE_LIGHTS,
// whether or not they got a real light, so a far fire still glows in its own smoke.
// Owner: FX.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Quality } from '../api';

const { uniform, uniformArray, positionWorld, distance, clamp, mix, renderGroup } = TSL as any;

export type LightKind = 'point' | 'spot';

/** Lights the particle materials consider (fixed: the shader loop is unrolled). */
export const PARTICLE_LIGHT_COUNT = 8;

/**
 * The best requests of the frame for particle lighting. pos: xyz world position, w range (m).
 * col: rgb = colour * intensity (candela), w = cos of the spot's outer cone (-2 for a point light).
 * dir: xyz unit beam direction, w = cos of the inner cone (spot only).
 */
export const PARTICLE_LIGHTS = {
  pos: uniformArray(Array.from({ length: PARTICLE_LIGHT_COUNT }, () => new THREE.Vector4(0, -1e4, 0, 1)), 'vec4').setGroup(renderGroup),
  col: uniformArray(Array.from({ length: PARTICLE_LIGHT_COUNT }, () => new THREE.Vector4(0, 0, 0, -2)), 'vec4').setGroup(renderGroup),
  dir: uniformArray(Array.from({ length: PARTICLE_LIGHT_COUNT }, () => new THREE.Vector4(0, -1, 0, 1)), 'vec4').setGroup(renderGroup),
};

/** A request for a light. Keep it, change its fields every frame, release() it when done. */
export class LightHandle {
  /** Only requests that are on (and have intensity > 0) compete for a light. */
  on = false;
  readonly position = new THREE.Vector3();
  /** Spot only: unit direction the beam points to. */
  readonly direction = new THREE.Vector3(0, 0, -1);
  /** Linear RGB, not premultiplied (intensity is separate). */
  readonly color = new THREE.Color(1, 1, 1);
  /** Point only: colour at the edge of the range. null = same as `color`. */
  colorFar: THREE.Color | null = null;
  /** As THREE.PointLight.intensity (candela; irradiance at d metres = intensity / d^2). */
  intensity = 1;
  /** Metres at which the light ends (THREE light.distance). */
  range = 10;
  decay = 2;
  /** Spot cone: half angle (radians, <= PI/2) and the soft fraction of it. */
  angle = Math.PI / 6;
  penumbra = 0.5;
  /** Importance weight. Fires and lamps 1, flares 1.5, other players' flashlights 2, the local flashlight 6, muzzle flashes 8. */
  priority = 1;
  /** This light may take the shadow-casting slot (fires; quality.fireShadows). */
  shadow = false;
  /** Seconds to fade in when it gets a light (0 = at once: muzzle flashes). */
  fadeIn = 0.18;
  /** Read only: the intensity actually drawn this frame (0 when it lost the competition), after fades. */
  level = 0;
  /** Read only: true while a real THREE light draws this request. */
  lit = false;
  /** Pool bookkeeping. */
  score = 0;
  slot: Slot | null = null;
  released = false;

  constructor(readonly kind: LightKind, private pool: LightPool) {}

  /** Give the light back for good. The handle must not be used afterwards. */
  release(): void {
    this.pool.release(this);
  }
}

interface Slot {
  light: THREE.PointLight | THREE.SpotLight;
  kind: LightKind;
  shadow: boolean;
  req: LightHandle | null;
  fade: number;
  hot?: any;
  cool?: any;
  at?: any;
  reach?: any;
}

/** How many lights of each kind a tier gets (point + spot = maxLights). */
function split(maxLights: number): { point: number; spot: number } {
  const n = Math.max(2, Math.round(maxLights));
  const spot = n >= 8 ? 3 : n >= 6 ? 2 : 1;
  return { point: n - spot, spot };
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _c = new THREE.Color();

export class LightPool {
  /** Parent of every pooled light (in the scene). */
  readonly group = new THREE.Group();
  private handles: LightHandle[] = [];
  private slots: Slot[] = [];
  private quality: Quality;
  private cand: LightHandle[] = [];
  private top: LightHandle[] = [];
  private lastDt = 1 / 60;
  private dirty = true;
  /** Frame counter of the last assignment (the pool runs once per frame). */
  private assignedFrame = -1;
  frame = 0;

  constructor(private scene: THREE.Scene, quality: Quality) {
    this.group.name = 'fx-lights';
    this.quality = quality;
    scene.add(this.group);
    this.build();
  }

  /** Ask for a light. Priority: see LightHandle.priority. */
  acquire(kind: LightKind, priority = 1): LightHandle {
    const h = new LightHandle(kind, this);
    h.priority = priority;
    this.handles.push(h);
    return h;
  }

  release(h: LightHandle): void {
    if (h.released) return;
    h.released = true;
    h.on = false;
    const i = this.handles.indexOf(h);
    if (i >= 0) this.handles.splice(i, 1);
    if (h.slot) {
      h.slot.req = null;
      h.slot.fade = 0;
      this.off(h.slot);
      h.slot = null;
    }
  }

  /** Requests that are drawing this frame (real light or particle light), best first. */
  get active(): readonly LightHandle[] {
    return this.top;
  }

  /** Number of real lights of each kind at this tier. */
  get counts(): { point: number; spot: number; shadow: boolean } {
    const s = split(this.quality.maxLights);
    return { ...s, shadow: this.quality.fireShadows };
  }

  setQuality(q: Quality): void {
    const a = split(this.quality.maxLights);
    const b = split(q.maxLights);
    const rebuild = a.point !== b.point || a.spot !== b.spot || this.quality.fireShadows !== q.fireShadows || this.quality.name !== q.name;
    this.quality = q;
    if (rebuild) this.build();
  }

  private build(): void {
    for (const s of this.slots) {
      if (s.req) s.req.slot = null;
      this.group.remove(s.light);
      if (s.light instanceof THREE.SpotLight) this.group.remove(s.light.target);
      s.light.dispose();
    }
    this.slots = [];
    const { point, spot } = split(this.quality.maxLights);
    for (let i = 0; i < point; i++) {
      const shadow = i === 0 && this.quality.fireShadows;
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = 'fx-point-' + i;
      const hot = uniform(new THREE.Color(0, 0, 0));
      const cool = uniform(new THREE.Color(0, 0, 0));
      const at = uniform(new THREE.Vector3());
      const reach = uniform(10);
      // Hot near, cool far: the colour of the light depends on how far the lit surface is.
      (l as any).colorNode = mix(hot, cool, clamp(distance(positionWorld, at).div(reach), 0, 1));
      l.castShadow = shadow;
      if (shadow) {
        const sz = this.quality.name === 'ultra' ? 1024 : 512;
        l.shadow.mapSize.set(sz, sz);
        l.shadow.camera.near = 0.15;
        l.shadow.camera.far = 16;
        l.shadow.bias = -0.004;
        l.shadow.normalBias = 0.03;
        l.shadow.radius = 2;
        l.shadow.autoUpdate = false;
      }
      this.group.add(l);
      this.slots.push({ light: l, kind: 'point', shadow, req: null, fade: 0, hot, cool, at, reach });
    }
    for (let i = 0; i < spot; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 30, Math.PI / 6, 0.5, 2);
      l.name = 'fx-spot-' + i;
      l.castShadow = false;
      this.group.add(l, l.target);
      this.slots.push({ light: l, kind: 'spot', shadow: false, req: null, fade: 0 });
    }
    for (const h of this.handles) h.slot = null;
    this.dirty = true;
  }

  private off(s: Slot): void {
    s.light.intensity = 0;
    if (s.hot) {
      s.hot.value.setRGB(0, 0, 0);
      s.cool.value.setRGB(0, 0, 0);
    }
    if (s.shadow) s.light.shadow.autoUpdate = false;
  }

  /** Called by the fx system every frame with the frame's dt (fades). */
  tick(dt: number): void {
    this.lastDt = Math.min(0.1, Math.max(0, dt));
    this.frame++;
  }

  /**
   * Rank the requests and hand out the lights. Runs once per frame, right before the scene is
   * drawn (scene.onBeforeRender), so requests made by systems updated after fx are seen.
   */
  assign(camera: THREE.Camera): void {
    if (this.assignedFrame === this.frame && !this.dirty) return;
    this.assignedFrame = this.frame;
    this.dirty = false;
    const dt = this.lastDt;
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv, (camera as any).coordinateSystem, (camera as any).reversedDepth);
    const cx = camera.matrixWorld.elements[12], cy = camera.matrixWorld.elements[13], cz = camera.matrixWorld.elements[14];

    // ---- score every live request ----
    const cand = this.cand;
    cand.length = 0;
    for (const h of this.handles) {
      if (!h.on || h.intensity <= 0 || h.range <= 0) {
        h.score = 0;
        continue;
      }
      const dx = h.position.x - cx, dy = h.position.y - cy, dz = h.position.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = h.range * 1.6;
      let s = h.priority * Math.sqrt(h.intensity) / (1 + d2 / (reach * reach));
      // A light whose sphere is entirely off screen cannot light anything visible.
      _sphere.center.copy(h.position);
      _sphere.radius = h.range;
      if (!_frustum.intersectsSphere(_sphere)) s *= 0.04;
      if (h.slot) s *= 1.3; // stickiness: no swapping back and forth between equals
      h.score = s;
      cand.push(h);
    }
    cand.sort((a, b) => b.score - a.score);

    // ---- the shadow slot: best shadow-capable point request within reach ----
    const shadowSlot = this.slots.find((s) => s.shadow) ?? null;
    let shadowWant: LightHandle | null = null;
    if (shadowSlot) {
      for (const h of cand) {
        if (h.kind !== 'point' || !h.shadow || h.score <= 0) continue;
        const d = h.position.distanceTo(_sphere.center.set(cx, cy, cz));
        if (d < 30 + h.range) shadowWant = h;
        break;
      }
    }

    // ---- per kind: keep, fade out, fill ----
    for (const kind of ['point', 'spot'] as LightKind[]) {
      const slots = this.slots.filter((s) => s.kind === kind && !s.shadow);
      const want: LightHandle[] = [];
      for (const h of cand) {
        if (h.kind !== kind || h === shadowWant) continue;
        if (want.length >= slots.length) break;
        want.push(h);
      }
      this.fill(slots, want, dt);
    }
    if (shadowSlot) this.fill([shadowSlot], shadowWant ? [shadowWant] : [], dt);

    // ---- write the lights ----
    for (const s of this.slots) {
      const h = s.req;
      if (!h || s.fade <= 0) {
        if (h) h.level = 0;
        this.off(s);
        continue;
      }
      const k = h.intensity * s.fade;
      h.level = k;
      h.lit = true;
      const l = s.light;
      l.position.copy(h.position);
      l.distance = h.range;
      l.decay = h.decay;
      if (s.kind === 'point') {
        l.intensity = k; // unused by the colour node, kept for anyone reading the light
        s.hot.value.copy(h.color).multiplyScalar(k);
        s.cool.value.copy(h.colorFar ?? h.color).multiplyScalar(k);
        s.at.value.copy(h.position);
        s.reach.value = h.range;
        if (s.shadow) {
          l.shadow.autoUpdate = true;
          l.shadow.camera.far = Math.max(2, h.range);
        }
      } else {
        const sl = l as THREE.SpotLight;
        sl.color.copy(h.color);
        sl.intensity = k;
        sl.angle = Math.min(Math.PI / 2, Math.max(0.01, h.angle));
        sl.penumbra = Math.min(1, Math.max(0, h.penumbra));
        sl.target.position.copy(h.position).add(h.direction);
        sl.target.updateMatrixWorld();
      }
      l.updateMatrixWorld();
    }

    // ---- particle lights: the best requests, real light or not ----
    const top = this.top;
    top.length = 0;
    for (const h of cand) {
      if (top.length >= PARTICLE_LIGHT_COUNT) break;
      if (h.score <= 0) continue;
      top.push(h);
      if (!h.slot) h.level = h.intensity; // drawn in particles only
    }
    const P = PARTICLE_LIGHTS.pos.array as THREE.Vector4[];
    const C = PARTICLE_LIGHTS.col.array as THREE.Vector4[];
    const D = PARTICLE_LIGHTS.dir.array as THREE.Vector4[];
    for (let i = 0; i < PARTICLE_LIGHT_COUNT; i++) {
      const h = top[i];
      if (!h) {
        P[i].set(0, -1e4, 0, 1);
        C[i].set(0, 0, 0, -2);
        continue;
      }
      // a light that is fading out of its slot keeps its particle glow (no pop in the smoke)
      const k = h.intensity;
      _c.copy(h.color).lerp(h.colorFar ?? h.color, 0.35);
      P[i].set(h.position.x, h.position.y, h.position.z, h.range);
      if (h.kind === 'spot') {
        const outer = Math.cos(Math.min(Math.PI / 2, h.angle));
        const inner = Math.cos(Math.min(Math.PI / 2, h.angle) * (1 - Math.min(1, Math.max(0, h.penumbra))));
        C[i].set(_c.r * k, _c.g * k, _c.b * k, outer);
        D[i].set(h.direction.x, h.direction.y, h.direction.z, Math.max(inner, outer + 1e-3));
      } else {
        C[i].set(_c.r * k, _c.g * k, _c.b * k, -2);
        D[i].set(0, -1, 0, 1);
      }
    }
  }

  /** Keep requests that are still wanted, fade out the rest, give free slots to the next wanted. */
  private fill(slots: Slot[], want: LightHandle[], dt: number): void {
    for (const s of slots) {
      const h = s.req;
      if (!h) continue;
      if (want.includes(h) && !h.released) {
        s.fade = h.fadeIn <= 0 ? 1 : Math.min(1, s.fade + dt / h.fadeIn);
      } else {
        // fade out quickly, then free the slot (an instant light frees it at once)
        s.fade = h.fadeIn <= 0 || !h.on ? 0 : Math.max(0, s.fade - dt / 0.12);
        if (s.fade <= 0) {
          h.slot = null;
          h.lit = false;
          h.level = 0;
          s.req = null;
        }
      }
    }
    for (const h of want) {
      if (h.slot) continue;
      let free = slots.find((s) => s.req === null);
      // An instant light (muzzle flash) may take the weakest slot outright.
      if (!free && h.fadeIn <= 0) {
        let worst: Slot | null = null;
        for (const s of slots) if (s.req && s.req.fadeIn > 0 && (!worst || s.req.score < worst.req!.score)) worst = s;
        if (worst && worst.req!.score < h.score) {
          worst.req!.slot = null;
          worst.req!.lit = false;
          worst.req = null;
          free = worst;
        }
      }
      if (!free) continue;
      free.req = h;
      h.slot = free;
      free.fade = h.fadeIn <= 0 ? 1 : Math.min(1, dt / h.fadeIn);
    }
  }

  dispose(): void {
    for (const s of this.slots) s.light.dispose();
    this.scene.remove(this.group);
    this.slots = [];
    this.handles = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Flicker: a sum of smooth value noise at several unrelated frequencies (a sine reads as a
// machine). Deterministic in (t, seed).
// ---------------------------------------------------------------------------------------------

function hash1(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [0, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const s = Math.imul(seed | 0, 7919);
  return hash1(i + s) * (1 - u) + hash1(i + 1 + s) * u;
}

/**
 * Fire flicker around 1: slow breathing, a mid flutter and a fast shimmer; `gust` adds deep,
 * quick dips (the flames laid flat by the wind). Range about 0.55 .. 1.25.
 */
export function fireFlicker(t: number, seed: number, gust = 0): number {
  const slow = noise1(t * 0.9, seed) - 0.5;
  const mid = noise1(t * 4.3, seed + 11) - 0.5;
  const fast = noise1(t * 11.7, seed + 23) - 0.5;
  const shimmer = noise1(t * 23.1, seed + 37) - 0.5;
  let f = 1 + slow * 0.28 + mid * 0.24 + fast * 0.14 + shimmer * 0.06;
  if (gust > 0) {
    const dip = Math.max(0, noise1(t * 6.1, seed + 51) - 0.45) * 2;
    f -= gust * (0.18 + dip * 0.35);
    f += gust * (noise1(t * 17, seed + 63) - 0.5) * 0.3;
  }
  return Math.max(0.3, f);
}
