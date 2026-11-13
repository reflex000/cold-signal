// The GPU side of the snow: one RGBA8 render target, a 2:1 atlas [near | far], drawn by instanced
// quads with procedural shapes (boot, paw, groove, body, kick, pit) and MAX blending, so stamps
// union the way pressed snow does (the deeper print wins, edge distances union, rims stack to the
// highest). RGBA8 targets render and blend everywhere (WebGL2 phones included); no compute.
//
// A window that moves (snapped to whole texels, so a print lands on the same texels every time it
// is drawn and nothing smears) or whose fill has grown is re-rendered from the record store in one
// pass: a clear quad over its half, then one instanced draw. New records between re-renders are
// drawn on top without clearing. Usually a frame renders nothing; at most one pass.
//
// Clip mapping (three r187, both backends, as QuadMesh samples its targets): atlas uv (u, v) is
// clip (2u - 1, 1 - 2v). The vertex shader writes clip positions itself (vertexNode), so there is
// no camera. Owner: SNOW.
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, abs, attribute, clamp, dot, exp, float, floor, fract, max, min, mix, positionGeometry, select, sin, smoothstep, sqrt, uniform,
  varying, vec2, vec4,
} from 'three/tsl';
import {
  DEPTH_FILL_RATE, DEPTH_MAX, F_DEEP, F_FRONT, F_LEFT, F_PACKED, F_RUN, F_SOFT, FRESH_FILL, K_BODY, K_BOOT, K_GROOVE, K_KICK, K_PAW, K_PIT, RIM_FILL_RATE,
  RIM_MAX, SDF_RANGE, type SnowTier,
} from './config';
import type { RecordStore, Remaining } from './records';

type N = any;

/** freshness is stored x 0.8, leaving room for the decrement of the incremental stamps */
const FRESH_K = 0.8;

// ---------------------------------------------------------------------------------------------
// TSL shape helpers (metres, local frame: x across (right), y along (forward))
// ---------------------------------------------------------------------------------------------
const smin = (a: N, b: N, k: number): N => {
  const h: N = max(float(k).sub(abs(a.sub(b))), 0).div(k);
  return min(a, b).sub(h.mul(h).mul(k * 0.25));
};
const sdSeg = (p: N, ax: number, ay: number, bx: number, by: number, r: number): N => {
  const pa: N = p.sub(vec2(ax, ay));
  const ba: N = vec2(bx - ax, by - ay);
  const h: N = clamp(dot(pa, ba).div((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return pa.sub(ba.mul(h)).length().sub(r);
};
const sdEll = (p: N, r: N): N => p.div(r).length().sub(1).mul(min(r.x, r.y));
/** iq's uneven capsule: circles r1 at the origin and r2 at (0, h); p.x already folded to >= 0. */
const sdUneven = (p: N, r1: number, r2: number, h: number): N => {
  const b = (r1 - r2) / h;
  const a = Math.sqrt(1 - b * b);
  const k: N = dot(p, vec2(-b, a));
  return select(k.lessThan(0), p.length().sub(r1), select(k.greaterThan(a * h), p.sub(vec2(0, h)).length().sub(r2), dot(p, vec2(a, b)).sub(r1)));
};
const hash21 = (p: N): N => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const vnoise = (p: N): N => {
  const i: N = floor(p);
  const f: N = fract(p);
  const u: N = f.mul(f).mul(f.mul(-2).add(3));
  const a: N = hash21(i), b: N = hash21(i.add(vec2(1, 0))), c: N = hash21(i.add(vec2(0, 1))), d: N = hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
};
const bit = (flags: N, b: number): N => floor(flags.div(b)).mod(2);

/** Window of the atlas: which half, where it is in the world. */
class Win {
  ox = 0;
  oz = 0;
  /** Fill reading at the last full re-render. */
  base = 0;
  valid = false;
  /** Seconds since the last full re-render. */
  age = 0;
  readonly uOrigin = uniform(new THREE.Vector2());
  readonly uSize: N;
  /** Atlas placement: u scale, u offset, v scale. */
  readonly uPlace = uniform(new THREE.Vector3(1, 0, 1));
  constructor(public n: number, public size: number) {
    this.uSize = uniform(size);
  }
  get texel(): number {
    return this.size / this.n;
  }
}

export interface PainterStats {
  passes: number;
  nearRenders: number;
  farRenders: number;
  stamped: number;
  lastNear: number;
  lastFar: number;
}

export class Painter {
  rt!: THREE.RenderTarget;
  near!: Win;
  far: Win | null = null;
  tier!: SnowTier;
  readonly stats: PainterStats = { passes: 0, nearRenders: 0, farRenders: 0, stamped: 0, lastNear: 0, lastFar: 0 };

  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadGeo: THREE.BufferGeometry;
  private nearSet!: InstSet;
  private farSet: InstSet | null = null;
  private clearNear!: THREE.Mesh;
  private clearFar: THREE.Mesh | null = null;
  private state: any;
  private uTexel = uniform(0.04); // metres per near texel (shape detail that would alias is dropped)
  private rem: Remaining = { depth: 0, rim: 0, fresh: 0, soft: 0 };
  private atlasW = 1;
  private atlasH = 1;

  constructor(private renderer: THREE.WebGPURenderer, tier: SnowTier) {
    this.quadGeo = new THREE.BufferGeometry();
    this.quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.build(tier);
  }

  /** Atlas layout for U.trailAtlas: near u scale, far u offset, far u scale, far v scale. */
  layout(): [number, number, number, number] {
    const nN = this.near.n, nF = this.far ? this.far.n : 0;
    return [nN / this.atlasW, nN / this.atlasW, nF / this.atlasW, nF / this.atlasH];
  }
  get texture(): THREE.Texture {
    return this.rt.texture;
  }
  get atlasSize(): [number, number] {
    return [this.atlasW, this.atlasH];
  }

  /** (Re)build the target and meshes for a tier. Everything is re-rendered on the next update. */
  build(tier: SnowTier): void {
    this.disposeTargets();
    this.tier = tier;
    this.near = new Win(tier.nearN, tier.nearSize);
    this.far = tier.farN > 0 ? new Win(tier.farN, tier.farSize) : null;
    this.atlasW = tier.nearN + (this.far ? this.far.n : 0);
    this.atlasH = tier.nearN;
    this.rt = new THREE.RenderTarget(this.atlasW, this.atlasH, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.rt.texture.name = 'Snow.trail';
    const [nu, fo, fu, fv] = this.layout();
    this.near.uPlace.value.set(nu, 0, 1);
    if (this.far) this.far.uPlace.value.set(fu, fo, fv);
    this.uTexel.value = this.near.texel;

    this.nearSet = new InstSet(this.quadGeo, tier.nearCap);
    const nm = new THREE.Mesh(this.nearSet.geo, this.stampMaterial(this.near));
    nm.name = 'Snow [ near stamps ]';
    nm.frustumCulled = false;
    nm.renderOrder = 1;
    this.nearSet.mesh = nm;
    this.clearNear = this.clearQuad(this.near);
    this.scene.add(this.clearNear, nm);
    if (this.far) {
      this.farSet = new InstSet(this.quadGeo, tier.farCap);
      const fm = new THREE.Mesh(this.farSet.geo, this.blobMaterial(this.far));
      fm.name = 'Snow [ far stamps ]';
      fm.frustumCulled = false;
      fm.renderOrder = 1;
      this.farSet.mesh = fm;
      this.clearFar = this.clearQuad(this.far);
      this.scene.add(this.clearFar, fm);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Materials

  /** Clip position of a world point in a window's half of the atlas. */
  private clipOf(win: Win, world: N): N {
    const uvw: N = world.sub(win.uOrigin).div(win.uSize).add(0.5);
    const au: N = uvw.x.mul(win.uPlace.x).add(win.uPlace.y);
    const av: N = uvw.y.mul(win.uPlace.z);
    return vec4(au.mul(2).sub(1), float(1).sub(av.mul(2)), 0, 1);
  }

  private clearQuad(win: Win): THREE.Mesh {
    const m = new THREE.NodeMaterial();
    m.name = 'snow-clear';
    m.depthTest = m.depthWrite = false;
    m.blending = THREE.NoBlending;
    const c: N = positionGeometry.xy.mul(0.5).add(0.5); // 0..1 over the window
    const au: N = c.x.mul(win.uPlace.x).add(win.uPlace.y);
    const av: N = c.y.mul(win.uPlace.z);
    m.vertexNode = vec4(au.mul(2).sub(1), float(1).sub(av.mul(2)), 0, 1);
    m.fragmentNode = vec4(0, 0, 0, 0);
    const mesh = new THREE.Mesh(this.quadGeo, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;
    mesh.visible = false;
    return mesh;
  }

  private maxBlend(m: THREE.Material): void {
    m.depthTest = m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.MaxEquation;
    m.blendEquationAlpha = THREE.MaxEquation;
    m.blendSrc = m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = m.blendDstAlpha = THREE.OneFactor;
  }

  /** Common vertex stage: the instance quad in its window; returns (local, window uv) varyings. */
  private vertex(m: THREE.NodeMaterial, win: Win): { local: N; win: N; B: N; C: N; D: N } {
    const A: N = attribute('iA', 'vec4');
    const B: N = attribute('iB', 'vec4');
    const C: N = attribute('iC', 'vec4');
    const D: N = attribute('iD', 'vec4');
    const local: N = positionGeometry.xy.mul(vec2(D.y, D.z));
    const right: N = vec2(A.w.negate(), A.z);
    const fwd: N = vec2(A.z, A.w);
    const world: N = vec2(A.x, A.y).add(right.mul(local.x)).add(fwd.mul(local.y));
    m.vertexNode = this.clipOf(win, world);
    return {
      local: varying(local, 'vSnowLocal'),
      win: varying(world.sub(win.uOrigin).div(win.uSize).add(0.5), 'vSnowWin'),
      B: varying(B, 'vSnowB'),
      C: varying(C, 'vSnowC'),
      D: varying(D, 'vSnowD'),
    };
  }

  /** Near window: full shapes with edge distance, floor profile, rims and kicked clumps. */
  private stampMaterial(win: Win): THREE.NodeMaterial {
    const m = new THREE.NodeMaterial();
    m.name = 'snow-stamp';
    this.maxBlend(m);
    const v = this.vertex(m, win);
    const texel: N = this.uTexel;
    m.fragmentNode = Fn(() => {
      If(v.win.x.lessThan(0).or(v.win.x.greaterThan(1)).or(v.win.y.lessThan(0)).or(v.win.y.greaterThan(1)), () => {
        Discard();
      });
      const p: N = v.local;
      const kind: N = floor(v.B.z.add(0.5));
      const flags: N = floor(v.B.w.add(0.5));
      const hw: N = v.B.x, hl: N = v.B.y;
      const depth01: N = v.C.x, rim01: N = v.C.y, fresh: N = v.C.z, soft: N = v.C.w;
      const seed: N = v.D.x;
      const left: N = bit(flags, F_LEFT), run: N = bit(flags, F_RUN), deep: N = bit(flags, F_DEEP), packed: N = bit(flags, F_PACKED), front: N = bit(flags, F_FRONT);
      void front;

      const d: N = float(1).toVar(); // signed distance, < 0 inside
      const prof: N = float(1).toVar(); // floor depth multiplier
      const softK: N = soft.mul(4).toVar(); // wall widening
      const rimP: N = float(0.012).toVar(); // distance outside the wall of the rim's crest
      const rimW: N = float(0.03).toVar(); // width of its outer slope
      const kick: N = float(0).toVar();

      If(kind.equal(K_BOOT), () => {
        const sx: N = hw.div(0.056), sy: N = hl.div(0.15);
        const q: N = vec2(p.x.div(sx), p.y.div(sy));
        const med: N = left.mul(2).sub(1); // the big-toe side: +s on a left boot
        const qx: N = q.x.sub(med.mul(0.009).mul(smoothstep(-0.04, 0.08, q.y)));
        // heel block 7.6 cm wide, ball 11 cm, a waist under the arch
        let s: N = sdUneven(vec2(abs(qx), q.y.add(0.11)), 0.038, 0.055, 0.2);
        s = s.add(exp(q.y.add(0.035).div(0.034).pow(2).negate()).mul(0.011));
        const rag: N = vnoise(p.mul(30).add(seed.mul(57))).sub(0.5);
        d.assign(s.mul(min(sx, sy)).add(rag.mul(0.012).mul(deep)));
        const walk: N = mix(float(1), float(0.86), smoothstep(-0.1, 0.1, q.y));
        const runP: N = mix(float(0.76), float(1), smoothstep(-0.08, 0.1, q.y));
        const arch: N = exp(q.y.add(0.035).div(0.028).pow(2).negate()).mul(0.16).mul(deep.oneMinus());
        // lugs of the sole, where the texels are fine enough to hold them and the snow is hard
        const lugsOn: N = float(1).sub(smoothstep(0.018, 0.026, texel));
        const lug: N = smoothstep(0.35, 0.5, fract(q.y.mul(34).add(abs(qx).mul(12)))).mul(packed).mul(lugsOn);
        prof.assign(mix(walk, runP, run).mul(arch.oneMinus()).mul(lug.mul(0.22).oneMinus()));
        softK.addAssign(deep.mul(1.3));
        rimP.assign(mix(float(0.01), float(0.035), deep));
        rimW.assign(mix(float(0.025), float(0.09), deep));
      })
        .ElseIf(kind.equal(K_PAW), () => {
          const sc: N = hw.div(0.036);
          const pad: N = sdEll(p.sub(vec2(0, sc.mul(-0.012))), vec2(0.026, 0.023).mul(sc));
          const t1: N = vec2(abs(p.x), p.y).sub(vec2(0.02, 0.022).mul(sc)).length().sub(sc.mul(0.0125));
          const t2: N = vec2(abs(p.x), p.y).sub(vec2(0.0072, 0.037).mul(sc)).length().sub(sc.mul(0.0125));
          const shallow: N = smin(pad, min(t1, t2), 0.006);
          const hole: N = sdEll(p, vec2(hw, hl)).add(vnoise(p.mul(40).add(seed.mul(31))).sub(0.5).mul(0.012));
          d.assign(mix(shallow, hole, deep));
          prof.assign(float(1).sub(smoothstep(0.0, 0.03, p.y).mul(0.15)));
          softK.addAssign(deep.mul(1.5));
          rimP.assign(mix(float(0.008), float(0.025), deep));
          rimW.assign(mix(float(0.02), float(0.06), deep));
        })
        .ElseIf(kind.equal(K_GROOVE), () => {
          const sft: N = bit(flags, F_SOFT);
          d.assign(vec2(p.x, p.y.sub(clamp(p.y, hl.negate(), hl))).length().sub(hw));
          const across: N = max(float(1).sub(p.x.div(hw).pow(2)), 0);
          // a log's bed is round; a dragged foot leaves a V of crumbled snow
          prof.assign(mix(sqrt(across).mul(0.38).add(0.62), across, sft));
          softK.addAssign(mix(float(0.6), float(3.5), sft));
          rimP.assign(hw.mul(0.15).add(0.015));
          rimW.assign(hw.mul(0.45).add(0.04));
        })
        .ElseIf(kind.equal(K_BODY), () => {
          const sbx: N = hw.div(0.26), sby: N = hl.div(1.0);
          const q: N = vec2(p.x.div(sbx), p.y.div(sby));
          const qa: N = vec2(abs(q.x), q.y);
          const head: N = q.sub(vec2(0, 0.78)).length().sub(0.105);
          const torso: N = sdSeg(q, 0, 0.12, 0, 0.5, 0.2);
          const hips: N = sdSeg(q, 0, -0.28, 0, 0.1, 0.165);
          const leg: N = sdSeg(qa, 0.09, -0.3, 0.15, -1.12, 0.072);
          const arm: N = sdSeg(qa, 0.2, 0.42, 0.25, 0.82, 0.055);
          const s: N = smin(smin(smin(smin(torso, hips, 0.06), head, 0.05), leg, 0.05), arm, 0.04);
          d.assign(s.mul(min(sbx, sby)).add(vnoise(p.mul(14).add(seed.mul(23))).sub(0.5).mul(0.02)));
          const legs: N = smoothstep(0.3, 0.7, q.y.negate());
          const headK: N = smoothstep(0.62, 0.7, q.y);
          const arms: N = smoothstep(0.17, 0.23, abs(q.x)).mul(smoothstep(0.3, 0.4, q.y));
          prof.assign(float(1).sub(legs.mul(0.3)).sub(headK.mul(0.35)).sub(arms.mul(0.4)));
          softK.addAssign(0.5);
          rimP.assign(0.02);
          rimW.assign(0.1);
        })
        .ElseIf(kind.equal(K_PIT), () => {
          const r: N = p.length();
          d.assign(r.sub(hw));
          prof.assign(sqrt(max(float(1).sub(r.div(hw).pow(2)), 0)).mul(0.45).add(0.55));
          softK.addAssign(0.8);
          rimP.assign(hw.mul(0.1).add(0.01));
          rimW.assign(hw.mul(0.4).add(0.02));
        })
        .Else(() => {
          // kicked snow: a thin layer and clumps the size of a few texels, thinning outward
          const e: N = p.div(vec2(hw, hl)).length();
          const fall: N = float(1).sub(smoothstep(0.35, 1.0, e));
          const cs: N = max(float(0.03), texel.mul(1.6));
          const g: N = p.div(cs).add(seed.mul(37));
          const ci: N = floor(g);
          const h1: N = hash21(ci), h2: N = hash21(ci.add(7.31));
          const f: N = fract(g).sub(0.5).sub(vec2(h2, h1).sub(0.5).mul(0.3));
          const clump: N = float(1).sub(smoothstep(0.18, 0.42, f.length())).mul(step01(h1, 0.45));
          kick.assign(fall.mul(0.35).add(clump.mul(fall).mul(h2.mul(0.4).add(0.6))));
          d.assign(1);
        });

      const isKick: N = kind.equal(K_KICK);
      const dil: N = texel.mul(1.5).add(softK.mul(0.012));
      const in0: N = select(isKick, float(0), select(d.lessThan(dil), float(1), float(0)));
      const R: N = depth01.mul(prof).mul(in0);
      const G: N = select(isKick, float(0), clamp(float(0.5).sub(d.div(softK.add(1).mul(2 * SDF_RANGE))), 0, 1));
      const rimShape: N = smoothstep(-0.004, rimP, d).mul(float(1).sub(smoothstep(rimP, rimP.add(rimW), d)));
      const Bv: N = rim01.mul(select(isKick, kick, rimShape));
      const Av: N = fresh.mul(in0);
      return vec4(R, G, Bv, Av);
    })();
    return m;
  }

  /** Far window: every record as a soft blob (its area spread over at least a texel or two). */
  private blobMaterial(win: Win): THREE.NodeMaterial {
    const m = new THREE.NodeMaterial();
    m.name = 'snow-blob';
    this.maxBlend(m);
    const v = this.vertex(m, win);
    m.fragmentNode = Fn(() => {
      If(v.win.x.lessThan(0).or(v.win.x.greaterThan(1)).or(v.win.y.lessThan(0)).or(v.win.y.greaterThan(1)), () => {
        Discard();
      });
      const p: N = v.local;
      const kind: N = floor(v.B.z.add(0.5));
      const hl: N = v.B.y;
      const ext: N = vec2(v.D.y, v.D.z).div(1.4); // the blob's half extents (the quad is 1.4x that)
      const eG: N = vec2(p.x, p.y.sub(clamp(p.y, hl.negate(), hl))).length().div(ext.x);
      const eE: N = p.div(ext).length();
      const e: N = select(kind.equal(K_GROOVE), eG, eE);
      const blob: N = float(1).sub(smoothstep(0.45, 1.0, e));
      return vec4(v.C.x.mul(v.D.w).mul(blob), float(1).sub(smoothstep(1.0, 1.35, e)), 0, v.C.z.mul(blob));
    })();
    return m;
  }

  // ------------------------------------------------------------------------------------------
  // Frame

  /**
   * Keep both windows current. `cx, cz` = where the near window should be centred, `px, pz` = the
   * camera (far window centre); `fill` = the fill clock now; `fresh` = records added since the
   * last call. Returns the decrements for U.trailFill.
   */
  update(store: RecordStore, cx: number, cz: number, px: number, pz: number, fill: number, fresh: readonly number[], dt: number): void {
    const near = this.near, far = this.far;
    near.age += dt;
    if (far) far.age += dt;
    const ns = near.size / 16;
    let nearFull = !near.valid || Math.max(Math.abs(cx - near.ox), Math.abs(cz - near.oz)) > ns * 1.5;
    const dN = this.decrements(near, fill);
    if (dN[2] > 0.18 || dN[0] > 0.05 || dN[1] > 0.12) nearFull = true;
    let farFull = false;
    if (far) {
      const fs = far.size / 16;
      farFull = !far.valid || Math.max(Math.abs(px - far.ox), Math.abs(pz - far.oz)) > fs * 2;
      const dF = this.decrements(far, fill);
      if (dF[0] > 0.05) farFull = true;
    }

    // ---- near ----
    let draw = false;
    const nset = this.nearSet;
    nset.begin();
    if (nearFull) {
      near.ox = Math.round(cx / ns) * ns;
      near.oz = Math.round(cz / ns) * ns;
      near.uOrigin.value.set(near.ox, near.oz);
      near.base = fill;
      near.valid = true;
      near.age = 0;
      const h = near.size / 2;
      store.query(near.ox - h, near.oz - h, near.ox + h, near.oz + h, fill, (i) => {
        this.pushNear(store, i, fill, near);
        return nset.n < nset.cap;
      });
      this.clearNear.visible = true;
      this.stats.nearRenders++;
      this.stats.lastNear = nset.n;
      draw = true;
    } else {
      this.clearNear.visible = false;
      const h = near.size / 2 + 1.6;
      for (const i of fresh) {
        if (Math.abs(store.x[i] - near.ox) > h || Math.abs(store.z[i] - near.oz) > h) continue;
        if (nset.n >= nset.cap) break;
        this.pushNear(store, i, fill, near);
      }
      if (nset.n > 0) draw = true;
    }
    nset.end();

    // ---- far ----
    if (far && this.farSet && this.clearFar) {
      const fset = this.farSet;
      fset.begin();
      if (farFull) {
        const fs = far.size / 16;
        far.ox = Math.round(px / fs) * fs;
        far.oz = Math.round(pz / fs) * fs;
        far.uOrigin.value.set(far.ox, far.oz);
        far.base = fill;
        far.valid = true;
        far.age = 0;
        const h = far.size / 2;
        store.query(far.ox - h, far.oz - h, far.ox + h, far.oz + h, fill, (i) => {
          this.pushFar(store, i, fill, far);
          return fset.n < fset.cap;
        });
        this.clearFar.visible = true;
        this.stats.farRenders++;
        this.stats.lastFar = fset.n;
        draw = true;
      } else {
        this.clearFar.visible = false;
        const h = far.size / 2 + 1.6;
        for (const i of fresh) {
          if (Math.abs(store.x[i] - far.ox) > h || Math.abs(store.z[i] - far.oz) > h) continue;
          if (fset.n >= fset.cap) break;
          this.pushFar(store, i, fill, far);
        }
        if (fset.n > 0) draw = true;
      }
      fset.end();
    }

    if (draw) this.render();
  }

  private dec: [number, number, number] = [0, 0, 0];
  /** Per-channel decrements (encoded units) since a window's last re-render: [R, B, A] (reused array). */
  decrements(win: Win, fill: number): [number, number, number] {
    const f = Math.max(0, fill - win.base);
    const o = this.dec;
    o[0] = (f * DEPTH_FILL_RATE) / DEPTH_MAX;
    o[1] = (f * RIM_FILL_RATE) / RIM_MAX;
    o[2] = (f / FRESH_FILL) * FRESH_K;
    return o;
  }

  private pushNear(store: RecordStore, i: number, fill: number, win: Win): void {
    const r = store.eval(i, fill, this.rem);
    const [dR, dB, dA] = this.decrements(win, fill);
    const kind = store.kind[i];
    const hw = store.hw[i], hl = store.hl[i];
    let mS: number, mT: number;
    if (kind === K_KICK) {
      mS = mT = win.texel;
    } else {
      const m = SDF_RANGE + 0.02 + Math.min(0.14, 2.5 * r.rim) + 0.015 * r.soft * 4;
      mS = mT = m;
    }
    this.nearSet.push(
      store.x[i], store.z[i], store.fx[i], store.fz[i],
      hw, hl, kind, store.flags[i],
      Math.min(1, r.depth / DEPTH_MAX + dR), Math.min(1, r.rim / RIM_MAX + dB), Math.min(1, r.fresh * FRESH_K + dA), r.soft,
      store.seed[i], hw + mS, hl + mT, 1,
    );
    this.stats.stamped++;
  }

  private pushFar(store: RecordStore, i: number, fill: number, win: Win): void {
    const kind = store.kind[i];
    if (kind === K_KICK) return;
    const r = store.eval(i, fill, this.rem);
    if (r.depth <= 0.002) return;
    const [dR, , dA] = this.decrements(win, fill);
    const hw = store.hw[i], hl = store.hl[i];
    // at least ~1.6 texels across, its depth spread over the larger area
    const minR = 1.6 * win.texel;
    const ew = Math.max(hw, minR);
    const el = kind === K_GROOVE ? hl : Math.max(hl, minR);
    const area = kind === K_GROOVE ? hw * (hl + hw) : hw * hl;
    const areaE = kind === K_GROOVE ? ew * (el + ew) : ew * el;
    const k = Math.min(1, area / areaE);
    const qS = ew * 1.4;
    const qT = kind === K_GROOVE ? el + ew * 1.4 : el * 1.4;
    this.farSet!.push(
      store.x[i], store.z[i], store.fx[i], store.fz[i],
      hw, hl, kind, store.flags[i],
      Math.min(1, r.depth / DEPTH_MAX + dR), 0, Math.min(1, r.fresh * FRESH_K + dA), r.soft,
      store.seed[i], qS, qT, k,
    );
  }

  private render(): void {
    const renderer = this.renderer;
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    renderer.autoClear = false; // the clear quads clear only the half they belong to
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    this.stats.passes++;
  }

  /** Forget the windows: everything is re-rendered on the next update. */
  invalidate(): void {
    this.near.valid = false;
    if (this.far) this.far.valid = false;
  }

  private disposeTargets(): void {
    if (!this.rt) return;
    this.rt.dispose();
    for (const o of [...this.scene.children]) {
      this.scene.remove(o);
      const mesh = o as THREE.Mesh;
      (mesh.material as THREE.Material).dispose();
      if (mesh.geometry !== this.quadGeo) mesh.geometry.dispose();
    }
  }

  dispose(): void {
    this.disposeTargets();
    this.quadGeo.dispose();
  }
}

/** 1 when v >= e (a hard step without the GLSL / WGSL argument-order ambiguity). */
function step01(v: N, e: number): N {
  return select(v.greaterThanEqual(e), float(1), float(0));
}

/** A fixed-capacity instance buffer (four vec4 attributes) over a shared quad. */
class InstSet {
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly a: THREE.InstancedBufferAttribute;
  readonly b: THREE.InstancedBufferAttribute;
  readonly c: THREE.InstancedBufferAttribute;
  readonly d: THREE.InstancedBufferAttribute;
  mesh: THREE.Mesh | null = null;
  n = 0;
  constructor(quad: THREE.BufferGeometry, readonly cap: number) {
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const mk = (name: string): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      at.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, at);
      return at;
    };
    this.a = mk('iA');
    this.b = mk('iB');
    this.c = mk('iC');
    this.d = mk('iD');
    this.geo.instanceCount = 0;
  }
  begin(): void {
    this.n = 0;
  }
  push(a0: number, a1: number, a2: number, a3: number, b0: number, b1: number, b2: number, b3: number, c0: number, c1: number, c2: number, c3: number, d0: number, d1: number, d2: number, d3: number): void {
    const o = this.n * 4;
    const A = this.a.array as Float32Array, B = this.b.array as Float32Array, C = this.c.array as Float32Array, D = this.d.array as Float32Array;
    A[o] = a0; A[o + 1] = a1; A[o + 2] = a2; A[o + 3] = a3;
    B[o] = b0; B[o + 1] = b1; B[o + 2] = b2; B[o + 3] = b3;
    C[o] = c0; C[o + 1] = c1; C[o + 2] = c2; C[o + 3] = c3;
    D[o] = d0; D[o + 1] = d1; D[o + 2] = d2; D[o + 3] = d3;
    this.n++;
  }
  end(): void {
    if (this.n > 0) {
      for (const at of [this.a, this.b, this.c, this.d]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, this.n * 4);
        at.needsUpdate = true;
      }
    }
    this.geo.instanceCount = this.n;
    if (this.mesh) this.mesh.visible = this.n > 0;
  }
}
