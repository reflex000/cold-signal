// CPU particles drawn as instanced quads (no compute: the same path on WebGPU and WebGL2).
//
// One simulation (structure of arrays, swap-remove, no allocation per frame) and three looks:
//   PuffPool    smoke, steam, breath vapour, snow dust: soft lit billboards, alpha blended,
//               sorted back to front, lit per particle by the sky, the sun / moon (forward
//               scattering, the baked ridge shadow) and the eight best pool lights; fogged.
//   GlowPool    embers, sparks, flare cores, muzzle sparks: additive motion streaks, emissive,
//               dimmed by the fog in front of them, never smaller than a pixel.
//   DebrisPool  ice shards, wood chips, water drops, snow clumps: small lit tumbling flakes.
//
// A particle's motion: gravity, a buoyant lift that decays, coupling to the wind (the wind is
// weaker near the ground, and `shear` makes the coupling grow with height above the source, so
// smoke rises first and then shears off), turbulence, and an optional bounce on the ground.
// Owner: FX.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U, horizonLit } from '../shared';
import { fogAmount, fogColor, hgPhase } from '../sky/common';
import { PARTICLE_LIGHT_COUNT, PARTICLE_LIGHTS } from './lights';
import { noiseTexture } from './noise';

type N = any;
const {
  Fn, attribute, varying, texture, vec2, vec3, vec4, float, abs, clamp, max, min, dot, sin, cos, sqrt, pow, mix, smoothstep, select,
  length, normalize, asin, exp, fwidth, atan, positionGeometry, cameraViewMatrix, cameraProjectionMatrix,
} = TSL as any;

/** Behaviour flags. */
export const PF = {
  BOUNCE: 1, // settle on the spawn ground height
  HUG: 2, // puffs that roll along the ground instead of sinking into it
  COOL: 4, // glow colour cools from yellow-white to red to dark over life (embers)
  TWINKLE: 8, // glow brightness flickers (tumbling embers)
} as const;

/** Spawn description. Fill the object returned by pool.spec(), then pool.emit(it). */
export interface PSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  /** Radius at birth and at death, metres. */
  s0: number; s1: number;
  /** Growth curve exponent (< 1 grows fast early). */
  grow: number;
  rot: number; spin: number;
  /** Peak opacity (puffs, debris) or brightness multiplier (glow). */
  op: number;
  /** Albedo (puffs, debris) or emission colour (glow). */
  r: number; g: number; b: number;
  /** Ground height under the spawn point; the height the shear is measured from. */
  gy: number; y0: number;
  grav: number; lift: number; tau: number;
  drag: number; shear: number; turb: number;
  /** Fractions of life spent fading in and out. */
  fin: number; fout: number;
  flags: number;
  /** Glow: shutter seconds (streak length). Debris: tumble rate (rad/s). Puffs: noise drift. */
  ex: number;
  seed: number;
}

function defaults(s: PSpec): PSpec {
  s.x = s.y = s.z = 0;
  s.vx = s.vy = s.vz = 0;
  s.life = 1;
  s.s0 = 0.1; s.s1 = 0.1; s.grow = 1;
  s.rot = 0; s.spin = 0;
  s.op = 1;
  s.r = s.g = s.b = 1;
  s.gy = -1e9; s.y0 = 0;
  s.grav = 0; s.lift = 0; s.tau = 1;
  s.drag = 0; s.shear = 0; s.turb = 0;
  s.fin = 0.1; s.fout = 0.5;
  s.flags = 0;
  s.ex = 0;
  s.seed = 0;
  return s;
}

/** Wind, camera and clock the simulation reads each frame. */
export interface SimEnv {
  windX: number;
  windZ: number;
  time: number;
}

/** The simulation part every look shares. */
class ParticleSim {
  readonly cap: number;
  n = 0;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly s0: Float32Array; readonly s1: Float32Array; readonly grow: Float32Array;
  readonly rot: Float32Array; readonly spin: Float32Array;
  readonly op: Float32Array; readonly seed: Float32Array;
  readonly cr: Float32Array; readonly cg: Float32Array; readonly cb: Float32Array;
  readonly gy: Float32Array; readonly y0: Float32Array;
  readonly grav: Float32Array; readonly lift: Float32Array; readonly tau: Float32Array;
  readonly drag: Float32Array; readonly shear: Float32Array; readonly turb: Float32Array;
  readonly fin: Float32Array; readonly fout: Float32Array;
  readonly flags: Uint8Array; readonly ex: Float32Array;
  private all: (Float32Array | Uint8Array)[];
  private scratch = defaults({} as PSpec);
  private seq = 0;
  /** Multiplier on how many particles callers emit (quality.particleBudget). */
  budget = 1;

  constructor(cap: number) {
    this.cap = cap;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.s0 = f(); this.s1 = f(); this.grow = f();
    this.rot = f(); this.spin = f();
    this.op = f(); this.seed = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.gy = f(); this.y0 = f();
    this.grav = f(); this.lift = f(); this.tau = f();
    this.drag = f(); this.shear = f(); this.turb = f();
    this.fin = f(); this.fout = f();
    this.flags = new Uint8Array(cap);
    this.ex = f();
    this.all = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.s0, this.s1, this.grow, this.rot, this.spin, this.op, this.seed, this.cr, this.cg, this.cb, this.gy, this.y0, this.grav, this.lift, this.tau, this.drag, this.shear, this.turb, this.fin, this.fout, this.flags, this.ex];
  }

  /** The reusable spawn description, reset to defaults. */
  spec(): PSpec {
    return defaults(this.scratch);
  }

  /** Add one particle; returns false when the pool is full (the oldest are not evicted). */
  emit(s: PSpec): boolean {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    this.age[i] = 0; this.life[i] = Math.max(0.02, s.life);
    this.s0[i] = s.s0; this.s1[i] = s.s1; this.grow[i] = s.grow;
    this.rot[i] = s.rot; this.spin[i] = s.spin;
    this.op[i] = s.op;
    this.seed[i] = s.seed || ((this.seq++ * 0.618034) % 1);
    this.cr[i] = s.r; this.cg[i] = s.g; this.cb[i] = s.b;
    this.gy[i] = s.gy; this.y0[i] = s.y0;
    this.grav[i] = s.grav; this.lift[i] = s.lift; this.tau[i] = Math.max(0.01, s.tau);
    this.drag[i] = s.drag; this.shear[i] = s.shear; this.turb[i] = s.turb;
    this.fin[i] = Math.max(0.001, s.fin); this.fout[i] = Math.max(0.001, s.fout);
    this.flags[i] = s.flags;
    this.ex[i] = s.ex;
    return true;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of this.all) a[i] = a[j];
  }

  clear(): void {
    this.n = 0;
  }

  step(dt: number, env: SimEnv): void {
    if (dt <= 0) return;
    const t = env.time;
    let i = 0;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const sd = this.seed[i] * 6.2831853;
      const h = this.py[i] - this.gy[i];
      // the wind is weaker near the ground (log profile), full a few metres up
      const prof = h > 1e8 ? 1 : Math.min(1.15, 0.45 + 0.22 * Math.log(1 + Math.max(0, h) * 2));
      const above = this.py[i] - this.y0[i];
      const couple = this.drag[i] + this.shear[i] * Math.min(1, Math.max(0, above / 2.5));
      const k = 1 - Math.exp(-couple * dt);
      this.vx[i] += (env.windX * prof - this.vx[i]) * k;
      this.vz[i] += (env.windZ * prof - this.vz[i]) * k;
      this.vy[i] -= this.vy[i] * k * 0.5;
      this.vy[i] += (this.lift[i] * Math.exp(-age / this.tau[i]) - this.grav[i]) * dt;
      const tb = this.turb[i];
      if (tb > 0) {
        const px = this.px[i], py = this.py[i], pz = this.pz[i];
        this.vx[i] += tb * dt * (Math.sin(t * 1.7 + sd * 3 + py * 1.9) + 0.5 * Math.sin(t * 3.1 + sd * 7 + pz * 2.3));
        this.vz[i] += tb * dt * (Math.cos(t * 1.5 + sd * 5 + py * 1.7) + 0.5 * Math.cos(t * 2.7 + sd * 11 + px * 2.1));
        this.vy[i] += tb * dt * 0.5 * Math.sin(t * 2.3 + sd * 13 + px * 1.3);
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const fl = this.flags[i];
      if (fl & PF.BOUNCE && this.py[i] < this.gy[i]) {
        this.py[i] = this.gy[i];
        this.vy[i] = Math.abs(this.vy[i]) * 0.25;
        this.vx[i] *= 0.45;
        this.vz[i] *= 0.45;
        this.spin[i] *= 0.4;
        this.ex[i] *= 0.4;
      } else if (fl & PF.HUG) {
        const r = this.size(i) * 0.35;
        if (this.py[i] < this.gy[i] + r) {
          this.py[i] = this.gy[i] + r;
          if (this.vy[i] < 0) this.vy[i] = 0;
        }
      }
      this.rot[i] += this.spin[i] * dt;
      i++;
    }
  }

  /** Current radius. */
  size(i: number): number {
    const f = Math.min(1, this.age[i] / this.life[i]);
    return this.s0[i] + (this.s1[i] - this.s0[i]) * Math.pow(f, this.grow[i] || 1);
  }

  /** Fade envelope 0..1. */
  env(i: number): number {
    const f = this.age[i] / this.life[i];
    const a = Math.min(1, f / this.fin[i]);
    const b = Math.min(1, (1 - f) / this.fout[i]);
    return a * a * (3 - 2 * a) * b * b * (3 - 2 * b);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared shader pieces
// ---------------------------------------------------------------------------------------------

/**
 * Radiance per unit albedo of a small cloud of scatterers at world position p, seen along unit
 * direction d (camera -> p): sky ambient, sun and moon with forward scattering and the baked ridge
 * shadow, and the eight best pool lights. Per vertex: one value per particle.
 */
export function particleLight(p: N, d: N, forward = 0.45): N {
  const amb = vec3(U.skyAmbient).mul(0.62).add(vec3(U.groundAmbient).mul(0.38)).mul(1 / Math.PI);
  const g = float(forward);
  const sunPh = hgPhase(dot(d, U.sunDir), g).mul(4 * Math.PI).mul(0.65).add(0.35);
  const moonPh = hgPhase(dot(d, U.moonDir), g).mul(4 * Math.PI).mul(0.65).add(0.35);
  const sunVis = horizonLit(p.xz, asin(clamp(U.sunDir.y, -1, 1)));
  const sun = vec3(U.sunColor).mul(sunPh).mul(sunVis);
  const moon = vec3(U.moonColor).mul(moonPh);
  let acc: N = vec3(0);
  for (let i = 0; i < PARTICLE_LIGHT_COUNT; i++) {
    const P = PARTICLE_LIGHTS.pos.element(i);
    const C = PARTICLE_LIGHTS.col.element(i);
    const D = PARTICLE_LIGHTS.dir.element(i);
    const L = P.xyz.sub(p);
    // a wisp is metres across: closer than a metre the light no longer grows like 1/d^2
    const d2 = max(dot(L, L), 1.0);
    const dist = sqrt(d2);
    const x = clamp(dist.div(P.w), 0, 1);
    const x2 = x.mul(x);
    const win = clamp(float(1).sub(x2.mul(x2)), 0, 1);
    const toL = L.div(dist);
    const cosA = dot(toL.negate(), D.xyz);
    const cone = select(C.w.lessThan(-1.5), float(1), smoothstep(C.w, D.w, cosA));
    // forward scattering: a wisp between the eye and a fire or a beam lights up
    const ph = hgPhase(dot(toL, d), g).mul(4 * Math.PI).mul(0.6).add(0.4);
    acc = acc.add(C.xyz.mul(win.mul(win).mul(cone).mul(ph).div(d2)));
  }
  // A point source lights a wisp from all sides: a part of a facing surface's share.
  return amb.add(sun.add(moon).add(acc.mul(0.4)).mul(1 / Math.PI));
}

/** Metres per pixel at view depth `depth`. */
function metresPerPixel(depth: N): N {
  return depth.mul(2).div(cameraProjectionMatrix.element(1).element(1).mul(U.resolution.y));
}

function instGeometry(cap: number, attrs: string[]): { geo: THREE.InstancedBufferGeometry; bufs: Record<string, THREE.InstancedBufferAttribute> } {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const bufs: Record<string, THREE.InstancedBufferAttribute> = {};
  for (const a of attrs) {
    const b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    b.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(a, b);
    bufs[a] = b;
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return { geo: g, bufs };
}

function upload(b: THREE.InstancedBufferAttribute, n: number): void {
  b.clearUpdateRanges();
  if (n > 0) b.addUpdateRange(0, n * 4);
  b.needsUpdate = true;
}

const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------
// Puffs: smoke, steam, vapour, snow dust
// ---------------------------------------------------------------------------------------------

export class PuffPool extends ParticleSim {
  readonly mesh: THREE.Mesh;
  private bufs: Record<string, THREE.InstancedBufferAttribute>;
  private list: THREE.InstancedBufferAttribute[];
  private geo: THREE.InstancedBufferGeometry;
  private order: number[] = [];
  private depth: Float32Array;
  private farFirst: (a: number, b: number) => number;

  constructor(cap: number) {
    super(cap);
    const { geo, bufs } = instGeometry(cap, ['aP', 'aQ', 'aC']);
    this.geo = geo;
    this.bufs = bufs;
    this.list = Object.values(bufs);
    const depth = (this.depth = new Float32Array(cap));
    this.farFirst = (a, b) => depth[b] - depth[a];
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'fx-puffs';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'fx.puff';
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;
    const aP: N = attribute('aP', 'vec4');
    const aQ: N = attribute('aQ', 'vec4');
    const aC: N = attribute('aC', 'vec4');
    const corner: N = positionGeometry.xy;
    const vUv = varying(vec2(0), 'vPuffUv');
    const vCol = varying(vec3(0), 'vPuffCol');
    const vA = varying(float(0), 'vPuffA');
    const vSeed = varying(vec4(0), 'vPuffSeed');
    m.vertexNode = Fn(() => {
      const center = aP.xyz;
      const size = aP.w;
      const cv = cameraViewMatrix.mul(vec4(center, 1)).xyz;
      const c = cos(aQ.x), s = sin(aQ.x);
      const off = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(size);
      const pv = cv.add(vec3(off, 0));
      const toP = center.sub(U.camPos);
      const dist = max(length(toP), 1e-3);
      const d = toP.div(dist);
      const lit = aC.rgb.mul(particleLight(center, d, 0.4));
      const fa = fogAmount(dist, d);
      vCol.assign(mix(lit, fogColor(d), fa));
      // a puff right at the eye would fill the screen with one blurry blob: fade it there
      const depth = cv.z.negate();
      const near = smoothstep(0.06, max(size.mul(0.9), 0.12), depth);
      vA.assign(aQ.y.mul(near).mul(float(1).sub(fa.mul(0.35))));
      vUv.assign(corner);
      vSeed.assign(vec4(aQ.z, aQ.w, aC.w, size));
      return cameraProjectionMatrix.mul(vec4(pv, 1));
    })();
    const noise = noiseTexture();
    const uv = vUv;
    const seed = vSeed.x;
    const drift = vSeed.y; // the puff's age: its shape evolves slowly
    const r2 = dot(uv, uv);
    const fall = clamp(float(1).sub(r2), 0, 1);
    // two octaves, the fine one warped by the coarse one: billows, not discs
    const nA = texture(noise, uv.mul(0.3).add(vec2(seed.mul(7.31), seed.mul(3.17).add(drift.mul(0.05))))).r;
    const nB = texture(noise, uv.mul(0.62).add(vec2(nA.mul(0.45).add(seed.mul(5.13)).sub(drift.mul(0.04)), nA.mul(0.3).add(seed.mul(9.7))))).g;
    const n = nA.mul(0.55).add(nB.mul(0.45));
    // smoke: ragged cloudlets with holes; vapour and steam (aC.w = 1): a smooth soft cloud
    const soft = vSeed.z;
    const smokeD = smoothstep(0.3, 0.78, n.mul(fall.mul(0.6).add(0.55))).mul(min(fall.mul(1.6), 1));
    const vapD = fall.mul(fall).mul(n.mul(0.6).add(0.55));
    const shape = clamp(mix(smokeD, vapD, soft), 0, 1);
    // thin parts let more light through: a little brighter
    const col = vCol.mul(float(1.12).sub(shape.mul(0.24)));
    m.fragmentNode = vec4(col, clamp(shape.mul(vA), 0, 1));
    return m;
  }

  /** Write the live particles (sorted far to near) for drawing. */
  write(camera: THREE.Camera): void {
    const n = this.n;
    const P = this.bufs.aP.array as Float32Array;
    const Q = this.bufs.aQ.array as Float32Array;
    const C = this.bufs.aC.array as Float32Array;
    camera.getWorldPosition(_cam);
    camera.getWorldDirection(_fwd);
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      this.depth[i] = (this.px[i] - _cam.x) * _fwd.x + (this.py[i] - _cam.y) * _fwd.y + (this.pz[i] - _cam.z) * _fwd.z;
    }
    order.sort(this.farFirst);
    let w = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const a = this.op[i] * this.env(i);
      if (a <= 0.002) continue;
      const o = w * 4;
      P[o] = this.px[i]; P[o + 1] = this.py[i]; P[o + 2] = this.pz[i]; P[o + 3] = this.size(i);
      Q[o] = this.rot[i]; Q[o + 1] = a; Q[o + 2] = this.seed[i]; Q[o + 3] = this.age[i];
      C[o] = this.cr[i]; C[o + 1] = this.cg[i]; C[o + 2] = this.cb[i]; C[o + 3] = this.ex[i];
      w++;
    }
    for (const b of this.list) upload(b, w);
    this.geo.instanceCount = w;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Glow: embers, sparks, hot cores (additive streaks)
// ---------------------------------------------------------------------------------------------

export class GlowPool extends ParticleSim {
  readonly mesh: THREE.Mesh;
  private bufs: Record<string, THREE.InstancedBufferAttribute>;
  private list: THREE.InstancedBufferAttribute[];
  private geo: THREE.InstancedBufferGeometry;

  constructor(cap: number) {
    super(cap);
    const { geo, bufs } = instGeometry(cap, ['aP', 'aV', 'aC']);
    this.geo = geo;
    this.bufs = bufs;
    this.list = Object.values(bufs);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'fx-glow';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'fx.glow';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;
    const aP: N = attribute('aP', 'vec4');
    const aV: N = attribute('aV', 'vec4');
    const aC: N = attribute('aC', 'vec4');
    const corner: N = positionGeometry.xy;
    const vUv = varying(vec2(0), 'vGlowUv');
    const vCol = varying(vec3(0), 'vGlowCol');
    const vStretch = varying(float(1), 'vGlowStretch');
    m.vertexNode = Fn(() => {
      const pos = aP.xyz;
      const c1 = cameraViewMatrix.mul(vec4(pos, 1)).xyz;
      const c2 = cameraViewMatrix.mul(vec4(pos.sub(aV.xyz.mul(aV.w)), 1)).xyz;
      const mid = c1.add(c2).mul(0.5);
      const depth = max(mid.z.negate(), 0.03);
      const r = max(aP.w, metresPerPixel(depth).mul(0.75));
      const seg = c2.xy.sub(c1.xy);
      const sl = length(seg);
      const along = select(sl.greaterThan(1e-6), seg.div(max(sl, 1e-6)), vec2(0, 1));
      const side = vec2(along.y.negate(), along.x);
      const half = sl.mul(0.5).add(r);
      const p = mid.add(vec3(side.mul(corner.x.mul(r)).add(along.mul(corner.y.mul(half))), 0));
      vUv.assign(corner);
      vStretch.assign(half.div(r));
      // energy kept when the glow is smaller than a pixel or smeared along a streak
      const keep = pow(aP.w.div(r), 2).mul(min(float(1), r.div(half).mul(1.6)));
      const toP = pos.sub(U.camPos);
      const dist = max(length(toP), 1e-3);
      const trans = float(1).sub(fogAmount(dist, toP.div(dist)));
      // a spark right at the eye is a blur, not a blazing bar across the picture
      const nearK = smoothstep(0.15, 0.7, depth);
      vCol.assign(aC.rgb.mul(keep).mul(trans).mul(nearK));
      return cameraProjectionMatrix.mul(vec4(p, 1));
    })();
    const b = vUv.y.mul(vStretch);
    const db = max(abs(b).sub(vStretch.sub(1)), 0);
    const q = clamp(float(1).sub(vUv.x.mul(vUv.x).add(db.mul(db))), 0, 1);
    const shape = q.mul(q).mul(q);
    m.fragmentNode = vec4(vCol.mul(shape), 1);
    return m;
  }

  write(time: number): void {
    const n = this.n;
    const P = this.bufs.aP.array as Float32Array;
    const V = this.bufs.aV.array as Float32Array;
    const C = this.bufs.aC.array as Float32Array;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const f = this.age[i] / this.life[i];
      let k = this.op[i] * this.env(i);
      let r = this.cr[i], g = this.cg[i], bl = this.cb[i];
      const fl = this.flags[i];
      if (fl & PF.COOL) {
        // yellow-white -> orange -> deep red -> out, brightness falling with temperature
        const temp = Math.max(0, 1 - f * 1.15);
        r = 1;
        g = 0.12 + 0.62 * temp * temp;
        bl = 0.02 + 0.3 * Math.pow(temp, 4);
        k *= 0.15 + 0.85 * temp * temp;
      }
      if (fl & PF.TWINKLE) {
        const s = this.seed[i] * 97;
        k *= 0.55 + 0.45 * Math.sin(time * (14 + this.seed[i] * 21) + s) * Math.sin(time * 7.3 + s * 1.7);
      }
      if (k <= 0.001) continue;
      const o = w * 4;
      P[o] = this.px[i]; P[o + 1] = this.py[i]; P[o + 2] = this.pz[i]; P[o + 3] = this.size(i);
      // a streak never smears longer than 12 cm (an ember in a gale is still a spark, not a bar)
      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) * this.ex[i];
      const cap = sp > 0.12 ? 0.12 / sp : 1;
      V[o] = this.vx[i] * cap; V[o + 1] = this.vy[i] * cap; V[o + 2] = this.vz[i] * cap; V[o + 3] = this.ex[i];
      C[o] = r * k; C[o + 1] = g * k; C[o + 2] = bl * k; C[o + 3] = 0;
      w++;
    }
    for (const bb of this.list) upload(bb, w);
    this.geo.instanceCount = w;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Debris: shards, chips, drops (lit, tumbling)
// ---------------------------------------------------------------------------------------------

export class DebrisPool extends ParticleSim {
  readonly mesh: THREE.Mesh;
  private bufs: Record<string, THREE.InstancedBufferAttribute>;
  private list: THREE.InstancedBufferAttribute[];
  private geo: THREE.InstancedBufferGeometry;

  constructor(cap: number) {
    super(cap);
    const { geo, bufs } = instGeometry(cap, ['aP', 'aQ', 'aC']);
    this.geo = geo;
    this.bufs = bufs;
    this.list = Object.values(bufs);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'fx-debris';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'fx.debris';
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;
    const aP: N = attribute('aP', 'vec4');
    const aQ: N = attribute('aQ', 'vec4'); // rot, alpha, seed, tumble phase
    const aC: N = attribute('aC', 'vec4'); // albedo, glint (0 chip .. 1 ice)
    const corner: N = positionGeometry.xy;
    const vUv = varying(vec2(0), 'vDebUv');
    const vCol = varying(vec3(0), 'vDebCol');
    const vA = varying(vec2(0), 'vDebA');
    m.vertexNode = Fn(() => {
      const center = aP.xyz;
      const cv = cameraViewMatrix.mul(vec4(center, 1)).xyz;
      const depth = max(cv.z.negate(), 0.03);
      const size = max(aP.w, metresPerPixel(depth).mul(0.8));
      // tumbling: the flake turns edge-on and back
      const tum = abs(cos(aQ.w)).mul(0.8).add(0.2);
      const c = cos(aQ.x), s = sin(aQ.x);
      const lx = corner.x.mul(tum);
      const off = vec2(lx.mul(c).sub(corner.y.mul(s)), lx.mul(s).add(corner.y.mul(c))).mul(size);
      const pv = cv.add(vec3(off, 0));
      const toP = center.sub(U.camPos);
      const dist = max(length(toP), 1e-3);
      const d = toP.div(dist);
      const light = particleLight(center, d, 0.2);
      // ice glints as a face turns to the light
      const glint = pow(abs(sin(aQ.w.mul(2).add(aQ.z.mul(40)))), 24).mul(aC.w).mul(6);
      const lit = aC.rgb.mul(light).add(light.mul(glint));
      const fa = fogAmount(dist, d);
      vCol.assign(mix(lit, fogColor(d), fa));
      vA.assign(vec2(aQ.y.mul(pow(aP.w.div(size), 2)), aQ.z));
      vUv.assign(corner);
      return cameraProjectionMatrix.mul(vec4(pv, 1));
    })();
    // An irregular polygon: the radius wobbles with the angle (seeded), edges kept crisp.
    const ang = atan(vUv.y, vUv.x);
    const sd = vA.y.mul(31.7);
    const rad = float(0.72).add(sin(ang.mul(3).add(sd)).mul(0.14)).add(sin(ang.mul(5).sub(sd.mul(1.3))).mul(0.08));
    const dd = length(vUv).sub(rad);
    const aa = max(fwidth(dd), 1e-4);
    const cov = clamp(float(0.5).sub(dd.div(aa)), 0, 1);
    m.fragmentNode = vec4(vCol, cov.mul(vA.x));
    return m;
  }

  write(): void {
    const n = this.n;
    const P = this.bufs.aP.array as Float32Array;
    const Q = this.bufs.aQ.array as Float32Array;
    const C = this.bufs.aC.array as Float32Array;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const a = this.op[i] * this.env(i);
      if (a <= 0.002) continue;
      const o = w * 4;
      P[o] = this.px[i]; P[o + 1] = this.py[i]; P[o + 2] = this.pz[i]; P[o + 3] = this.size(i);
      Q[o] = this.rot[i]; Q[o + 1] = a; Q[o + 2] = this.seed[i]; Q[o + 3] = this.age[i] * this.ex[i] + this.seed[i] * 6.28;
      C[o] = this.cr[i]; C[o + 1] = this.cg[i]; C[o + 2] = this.cb[i]; C[o + 3] = this.flags[i] & PF.TWINKLE ? 1 : 0;
      w++;
    }
    for (const b of this.list) upload(b, w);
    this.geo.instanceCount = w;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

