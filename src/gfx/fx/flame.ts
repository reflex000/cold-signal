// Flames and coal beds, drawn for every fire, flare and match in one instanced draw each.
//
// A flame is a handful of tongues. A tongue is a thin strip (8 rows) that always faces the
// camera: its long axis follows the flame's (leaning) axis as seen on screen, and when the camera
// looks down into the fire the strip keeps at least about half its length, so flames never
// collapse into slivers from above. The fragment shader draws the tongue inside the strip: rising,
// domain-warped noise (metre-scaled, so a big flame has more detail than a small one), a profile
// that tapers to a licking tip, erosion that breaks the top into separate flamelets, and a colour
// ramp by temperature (white-yellow core, orange body, deep red tips) in scene-referred HDR, so
// the core blooms and the tips fade into nothing. Additive: flame is light.
//
// Coal beds: discs over the fuel, cellular lumps glowing in their cracks, breathing slowly and
// brightening when the wind fans them.
// Owner: FX.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../shared';
import { fogAmount } from '../sky/common';
import { noiseTexture } from './noise';

type N = any;
const {
  Fn, attribute, varying, texture, vec2, vec3, vec4, float, abs, clamp, max, min, dot, sin, pow, mix, smoothstep,
  length, normalize, cross, positionGeometry, cameraViewMatrix, cameraProjectionMatrix,
} = TSL as any;

const ROWS = 8;

/** Fire colour by temperature 0..1, scene-referred radiance (multiply by intensity). */
export function fireRamp(t: N): N {
  const g = pow(t, 1.6).mul(0.78).add(t.mul(0.06));
  const b = pow(t, 4).mul(0.42);
  // Even the dull red tips of a flame are several times brighter than the snow its light falls
  // on: a floor of a few units keeps them in front of a firelit background (the hue stays deep
  // red there, its green is low).
  const k = float(2.4).add(pow(t, 2.2).mul(34));
  return vec3(1, g, b).mul(k);
}

function strip(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= ROWS; r++) {
    const v = r / ROWS;
    pos.push(-1, v, 0, 1, v, 0);
    if (r < ROWS) {
      const a = r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

interface Inst {
  geo: THREE.InstancedBufferGeometry;
  bufs: THREE.InstancedBufferAttribute[];
  arrs: Float32Array[];
}

function instanced(base: THREE.BufferGeometry, cap: number, names: string[]): Inst {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  const bufs: THREE.InstancedBufferAttribute[] = [];
  const arrs: Float32Array[] = [];
  for (const n of names) {
    const a = new Float32Array(cap * 4);
    const b = new THREE.InstancedBufferAttribute(a, 4);
    b.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(n, b);
    bufs.push(b);
    arrs.push(a);
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return { geo: g, bufs, arrs };
}

function flush(inst: Inst, n: number): void {
  for (const b of inst.bufs) {
    b.clearUpdateRanges();
    if (n > 0) b.addUpdateRange(0, n * 4);
    b.needsUpdate = true;
  }
  inst.geo.instanceCount = n;
}

/** One tongue as the fire system describes it each frame. */
export interface Tongue {
  x: number; y: number; z: number;
  /** Height and half width of the strip, metres. */
  h: number; w: number;
  /** Lean of the tip per metre of height (wind), world x / z. */
  lx: number; lz: number;
  seed: number;
  /** Brightness multiplier on the ramp (about 1 for a healthy campfire). */
  intensity: number;
  /** 0..1 overall fade. */
  alpha: number;
  /** Added to the temperature (-0.3 cool and sooty .. +0.3 white hot). */
  temp: number;
  /** Lateral licking, 0..1. */
  wobble: number;
  /** Ramp tint for the cooler parts (1,1,1 for wood fire; a flare is magenta-red). */
  tr: number; tg: number; tb: number;
}

export class FlamePool {
  readonly mesh: THREE.Mesh;
  private inst: Inst;
  private n = 0;
  readonly cap: number;

  constructor(cap = 160) {
    this.cap = cap;
    const base = strip();
    this.inst = instanced(base, cap, ['aBase', 'aShape', 'aLook', 'aTint']);
    this.mesh = new THREE.Mesh(this.inst.geo, this.material());
    this.mesh.name = 'fx-flames';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 31;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'fx.flame';
    m.transparent = true;
    m.depthWrite = false;
    // Premultiplied: the flame adds its light, and its sooty body holds back a little of what is
    // behind it (a wood flame is not perfectly clear), so it still reads in front of snow that
    // its own light has made bright.
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;
    const aBase: N = attribute('aBase', 'vec4');
    const aShape: N = attribute('aShape', 'vec4');
    const aLook: N = attribute('aLook', 'vec4');
    const aTint: N = attribute('aTint', 'vec4');
    const vUv = varying(vec2(0), 'vFlUv');
    const vInfo = varying(vec4(0), 'vFlInfo'); // h, w, seed, intensity
    const vLook = varying(vec3(0), 'vFlLook'); // alpha * fog transmittance, temp bias, unused
    const vTint = varying(vec3(1), 'vFlTint');
    m.vertexNode = Fn(() => {
      const v = positionGeometry.y;
      const side = positionGeometry.x;
      const B = aBase.xyz;
      const h = aBase.w;
      const W = aShape.x;
      const seed = aShape.w;
      const A = normalize(vec3(aShape.y, 1, aShape.z));
      const Bv = cameraViewMatrix.mul(vec4(B, 1)).xyz;
      const Av = normalize(cameraViewMatrix.mul(vec4(A, 0)).xyz);
      const Vv = normalize(Bv);
      const Ap = Av.sub(Vv.mul(dot(Av, Vv)));
      const la = length(Ap);
      // looking down the flame's axis: fall back to the screen's up direction
      const up = vec3(0, 1, 0).sub(Vv.mul(Vv.y));
      const axis = normalize(mix(normalize(up), Ap.div(max(la, 1e-4)), smoothstep(0.12, 0.45, la)));
      const right = normalize(cross(axis, Vv));
      const L = h.mul(max(la, 0.55));
      const t = U.time;
      const wob = sin(t.mul(6.3).add(seed.mul(17)).add(v.mul(4.5))).mul(0.55)
        .add(sin(t.mul(11.2).add(seed.mul(9)).sub(v.mul(7.5))).mul(0.3))
        .add(sin(t.mul(17.9).add(seed.mul(3)).add(v.mul(11))).mul(0.15))
        .mul(aLook.w).mul(v).mul(v).mul(0.22);
      const P = Bv.add(axis.mul(L.mul(v))).add(right.mul(wob.mul(h)));
      const pv = P.add(right.mul(side.mul(W)));
      vUv.assign(vec2(side, v));
      vInfo.assign(vec4(h, W, seed, aLook.x));
      const toB = B.sub(U.camPos);
      const dist = max(length(toB), 1e-3);
      const trans = float(1).sub(fogAmount(dist, toB.div(dist)));
      vLook.assign(vec3(aLook.y.mul(trans), aLook.z, 0));
      vTint.assign(aTint.xyz);
      return cameraProjectionMatrix.mul(vec4(pv, 1));
    })();

    const noise = noiseTexture();
    const u = vUv.x;
    const v = vUv.y;
    const h = vInfo.x, W = vInfo.y, seed = vInfo.z, I = vInfo.w;
    const t = U.time;
    const spd = float(1.1).add(h.mul(0.9));
    const across = u.mul(W);
    const upm = v.mul(h);
    const n1 = texture(noise, vec2(across.mul(1.1).add(seed.mul(5.3)), upm.mul(0.85).sub(t.mul(spd).mul(0.5)))).r;
    const n2 = texture(noise, vec2(across.mul(2.4).sub(seed.mul(2.1)), upm.mul(1.8).sub(t.mul(spd).mul(1.05)))).g;
    const n3 = texture(noise, vec2(across.mul(4.3).add(seed.mul(1.7)), upm.mul(3.5).sub(t.mul(spd).mul(1.8)))).b;
    // the tongue licks sideways more toward its tip
    const warp = n1.sub(0.5).mul(1.3).add(n2.sub(0.5).mul(0.5));
    const uw = u.add(warp.mul(pow(v, 0.85)).mul(0.85));
    const prof = pow(float(1).sub(v), 0.6).mul(mix(float(0.62), float(1), smoothstep(0, 0.18, v)));
    const d = abs(uw).div(max(prof, 0.03));
    const body = float(1).sub(smoothstep(0.42, 1.0, d));
    // erosion grows with height: the top tears into flamelets that rise and vanish
    const erode = smoothstep(0.18, 0.98, v).mul(float(1.3).sub(n2.mul(0.95)).sub(n3.mul(0.6)));
    const dens = clamp(body.sub(max(erode, 0)), 0, 1).mul(smoothstep(0, 0.07, v));
    // hottest in the body's thick lower middle (not at the root, where the gas is still mixing);
    // only small spots reach white
    const root = smoothstep(0.0, 0.22, v).mul(0.35).add(0.65);
    const temp = clamp(dens.mul(dens).mul(float(0.95).sub(v.mul(0.55))).mul(root).add(vLook.y).add(n3.sub(0.5).mul(0.16)), 0, 1);
    const hot = fireRamp(temp);
    // tint the cooler body; the hottest core stays white whatever burns
    const col = mix(hot.mul(vTint), hot, pow(temp, 4)).mul(I);
    const alpha = clamp(dens.mul(1.7), 0, 1).mul(vLook.x);
    m.fragmentNode = vec4(col.mul(alpha), alpha.mul(dens).mul(0.6));
    return m;
  }

  /** Tongues in the current draw list. */
  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  add(t: Tongue): void {
    if (this.n >= this.cap || t.alpha <= 0.001 || t.h <= 0.005) return;
    const o = this.n * 4;
    const [B, S, L, T] = this.inst.arrs;
    B[o] = t.x; B[o + 1] = t.y; B[o + 2] = t.z; B[o + 3] = t.h;
    S[o] = t.w; S[o + 1] = t.lx; S[o + 2] = t.lz; S[o + 3] = t.seed;
    L[o] = t.intensity; L[o + 1] = t.alpha; L[o + 2] = t.temp; L[o + 3] = t.wobble;
    T[o] = t.tr; T[o + 1] = t.tg; T[o + 2] = t.tb; T[o + 3] = 0;
    this.n++;
  }

  end(): void {
    flush(this.inst, this.n);
  }

  dispose(): void {
    this.inst.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** A glowing bed of coals as the fire system describes it each frame. */
export interface Bed {
  x: number; y: number; z: number;
  radius: number;
  /** Scene-referred brightness of the hottest cracks (about 1..6). */
  glow: number;
  /** 0..1: how much of the bed is still alight (embers going out shrink to a few spots). */
  live: number;
  seed: number;
}

export class CoalPool {
  readonly mesh: THREE.Mesh;
  private inst: Inst;
  private n = 0;
  readonly cap: number;

  constructor(cap = 24) {
    this.cap = cap;
    const disc = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    this.inst = instanced(disc, cap, ['aBed', 'aGlow']);
    this.mesh = new THREE.Mesh(this.inst.geo, this.material());
    this.mesh.name = 'fx-coals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'fx.coals';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.fog = false;
    m.lights = false;
    // sits a hair above the model's bed: no z-fight
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    const aBed: N = attribute('aBed', 'vec4');
    const aGlow: N = attribute('aGlow', 'vec4');
    const vP = varying(vec2(0), 'vCoalP');
    const vG = varying(vec4(0), 'vCoalG');
    m.vertexNode = Fn(() => {
      const local = positionGeometry; // unit disc in xz
      const wp = aBed.xyz.add(local.mul(vec3(aBed.w, 1, aBed.w)));
      vP.assign(local.xz);
      const toB = aBed.xyz.sub(U.camPos);
      const dist = max(length(toB), 1e-3);
      const trans = float(1).sub(fogAmount(dist, toB.div(dist)));
      vG.assign(vec4(aGlow.x.mul(trans), aGlow.y, aGlow.z, aBed.w));
      return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(wp, 1)));
    })();
    const noise = noiseTexture();
    const p = vP; // -1..1 across the bed
    const r = length(p);
    const seed = vG.z;
    const t = U.time;
    const scale = vG.w.mul(2.2); // lumps of about 6 cm whatever the bed size
    const cells = texture(noise, p.mul(scale).add(vec2(seed.mul(3.1), seed.mul(7.7)))).a;
    const fine = texture(noise, p.mul(scale.mul(2.3)).add(vec2(seed.mul(1.9), t.mul(0.01)))).a;
    const breathe = texture(noise, p.mul(0.6).add(vec2(t.mul(0.07), seed.mul(5.0).sub(t.mul(0.05))))).r;
    // glow lives in the gaps between lumps (low cell value) and in the heart of the bed
    const crack = float(1).sub(smoothstep(0.25, 0.75, cells.mul(0.7).add(fine.mul(0.3))));
    const heart = float(1).sub(smoothstep(0.35, 1.0, r));
    const live = vG.y;
    const alive = smoothstep(float(1).sub(live), float(1).sub(live).add(0.25), breathe.mul(0.8).add(heart.mul(0.4)));
    const k = crack.mul(crack).mul(heart).mul(alive).mul(breathe.mul(0.8).add(0.45));
    const temp = clamp(k.mul(0.55).add(0.18), 0, 0.62);
    m.fragmentNode = vec4(fireRamp(temp).mul(vG.x).mul(0.02), clamp(k.mul(1.4), 0, 1));
    return m;
  }

  begin(): void {
    this.n = 0;
  }

  add(b: Bed): void {
    if (this.n >= this.cap || b.glow <= 0.001 || b.live <= 0.001) return;
    const o = this.n * 4;
    const [P, G] = this.inst.arrs;
    P[o] = b.x; P[o + 1] = b.y; P[o + 2] = b.z; P[o + 3] = b.radius;
    G[o] = b.glow; G[o + 1] = b.live; G[o + 2] = b.seed; G[o + 3] = 0;
    this.n++;
  }

  end(): void {
    flush(this.inst, this.n);
  }

  dispose(): void {
    this.inst.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
