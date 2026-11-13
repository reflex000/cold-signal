// The body's view of the cold, as screen overlays on the finished picture (engine.post.addOverlay):
//   'frost' (200)  ice crystals growing in from the edges and corners of the goggles as hud.frost
//                  rises: feathered branches first, then the gaps between them fill and thicken.
//                  A texture made at load holds, per texel, the frost level at which it freezes
//                  (a branching growth from the border, then a slower sideways fill), so the
//                  shader is one threshold. Frost scatters the light that comes through it: a
//                  milky veil whose brightness follows the scene (never glowing white at night),
//                  bright crystal ridges, a few glints, and refraction where the device allows.
//   'lens'  (300)  melt drops on the goggles when warming by a fire or indoors (hud.wetLens):
//                  small lenses that show the world upside down with a dark rim and a highlight;
//                  and in a storm, facing the wind, flakes that hit the lens, sit there blurred
//                  and melt into drops.
//   'hurt'  (400)  a red flash from the edges on damage; at low health the colour drains, the
//                  edges darken and pulse with the heartbeat.
// All three cost almost nothing when their uniforms are 0 (a uniform branch skips the work).
// On 'mobile' (no anti-aliasing texture) they never ask for a resample pass: no refraction.
// Owner: FX.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Quality } from '../api';
import type { CsEngine } from '../engine';
import type { View } from '../../game/view';
import { U } from '../shared';
import { Rand } from './noise';

type N = any;
const {
  Fn, If, uniform, texture, vec2, vec3, float, clamp, max, min, dot, sin, pow, mix, smoothstep, floor, fract, length, atan, hash, luminance, select,
} = TSL as any;

// ---------------------------------------------------------------------------------------------
// The frost growth map
// ---------------------------------------------------------------------------------------------

/** RGBA8: R = frost level at which this texel freezes (0..1), G = crystal ridge, B = glint noise. */
export function buildFrostTexture(W: number, H: number, seed = 7): THREE.DataTexture {
  const T = new Float32Array(W * H).fill(1e9);
  const D = new Float32Array(W * H).fill(1e9);
  const R = new Rand(seed);
  const sc = W / 1024;
  interface Walker { x: number; y: number; a: number; t: number; w: number; life: number; speed: number; gen: number }
  const stack: Walker[] = [];

  const stamp = (x: number, y: number, r: number, t: number): void => {
    const x0 = Math.max(0, Math.floor(x - r - 1)), x1 = Math.min(W - 1, Math.ceil(x + r + 1));
    const y0 = Math.max(0, Math.floor(y - r - 1)), y1 = Math.min(H - 1, Math.ceil(y + r + 1));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - x, yy - y);
        if (d > r + 0.75) continue;
        const i = yy * W + xx;
        const tt = t + d * 2.5;
        if (tt < T[i]) T[i] = tt;
        const dd = Math.max(0, d - r * 0.35);
        if (dd < D[i]) D[i] = dd;
      }
    }
  };

  // seeds all round the border, denser and earlier in the corners (frost starts where the
  // goggle frame is coldest)
  const perim = 2 * (W + H);
  const nSeeds = Math.round(perim / (13 * sc));
  for (let k = 0; k < nSeeds; k++) {
    const p = R.next() * perim;
    let x: number, y: number, nx: number, ny: number;
    if (p < W) { x = p; y = 0; nx = 0; ny = 1; }
    else if (p < W + H) { x = W - 1; y = p - W; nx = -1; ny = 0; }
    else if (p < 2 * W + H) { x = p - W - H; y = H - 1; nx = 0; ny = -1; }
    else { x = 0; y = p - 2 * W - H; nx = 1; ny = 0; }
    // corner closeness 0..1
    const cx = Math.min(x, W - 1 - x) / (W * 0.5), cy = Math.min(y, H - 1 - y) / (H * 0.5);
    const corner = Math.max(0, 1 - Math.min(cx, cy) * 2.2);
    const a = Math.atan2(ny, nx) + R.sym(0.6);
    stack.push({
      x, y, a,
      t: (1 - corner * 0.75) * R.next() * 110 * sc,
      w: (0.75 + R.next() * 0.6) * sc,
      life: (0.06 + 0.2 * Math.pow(R.next(), 1.3) + corner * 0.22) * H,
      speed: 0.75 + R.next() * 0.5,
      gen: 0,
    });
  }
  // Fern-like dendrites: a stem grows nearly straight and throws short side arms at about 60
  // degrees, which throw shorter ones; an arm stops where it meets frost that formed earlier.
  let budget = 3_000_000;
  while (stack.length && budget > 0) {
    const w = stack.pop()!;
    let len = 0;
    let dx = Math.cos(w.a), dy = Math.sin(w.a);
    const turn = R.sym(0.006);
    const every = (w.gen === 0 ? 5 : 7) * sc * (0.7 + R.next() * 0.6);
    let next = every * (0.5 + R.next());
    let side = R.next() < 0.5 ? -1 : 1;
    while (len < w.life && budget-- > 0) {
      const k = len / w.life;
      stamp(w.x, w.y, Math.max(0.5 * sc, w.w * (1 - 0.6 * k)), w.t);
      w.x += dx;
      w.y += dy;
      w.t += 1 / w.speed;
      len += 1;
      if (w.x < 0 || w.y < 0 || w.x >= W || w.y >= H) break;
      w.a += turn + R.sym(0.03);
      dx = Math.cos(w.a);
      dy = Math.sin(w.a);
      const i = (w.y | 0) * W + (w.x | 0);
      if (len > 3 && T[i] < w.t - 3) break; // met older frost
      if (w.gen < 3 && len >= next) {
        next += every * (0.6 + R.next() * 0.8);
        side = -side; // arms alternate left and right, like a feather
        const rest = w.life - len;
        stack.push({ x: w.x, y: w.y, a: w.a + side * (1.05 + R.sym(0.1)), t: w.t + 2, w: w.w * 0.7, life: rest * (0.22 + 0.25 * R.next()) + 4 * sc, speed: w.speed * 0.85, gen: w.gen + 1 });
      }
    }
  }
  // the sheet between the branches freezes later; a thin rime grows straight in from the frame
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const e = Math.min(x, W - 1 - x, y, H - 1 - y);
      const i = y * W + x;
      const rime = e * 5.5 / sc + 40 * sc + 25 * R.next();
      if (rime < T[i]) T[i] = rime;
    }
  }
  const FILL = 3.2;
  const chamfer = (A: Float32Array, k: number): void => {
    const d1 = k, d2 = k * Math.SQRT2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = A[i];
        if (x > 0) v = Math.min(v, A[i - 1] + d1);
        if (y > 0) {
          v = Math.min(v, A[i - W] + d1);
          if (x > 0) v = Math.min(v, A[i - W - 1] + d2);
          if (x < W - 1) v = Math.min(v, A[i - W + 1] + d2);
        }
        A[i] = v;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let v = A[i];
        if (x < W - 1) v = Math.min(v, A[i + 1] + d1);
        if (y < H - 1) {
          v = Math.min(v, A[i + W] + d1);
          if (x < W - 1) v = Math.min(v, A[i + W + 1] + d2);
          if (x > 0) v = Math.min(v, A[i + W - 1] + d2);
        }
        A[i] = v;
      }
    }
  };
  chamfer(T, FILL / Math.max(0.5, sc));
  chamfer(D, 1);
  // normalise: at full frost about half the picture is covered (the middle stays clear)
  const sorted = Float32Array.from(T).sort();
  const tmax = sorted[Math.floor(sorted.length * 0.5)] || 1;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = Math.round(Math.min(1, T[i] / tmax) * 255);
    data[i * 4 + 1] = Math.round(Math.exp(-D[i] / (1.1 * Math.max(0.5, sc))) * 255);
    data[i * 4 + 2] = Math.round(R.next() * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.name = 'fx.frost';
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------------------------

const _f = new THREE.Vector3();
const _e = new THREE.Euler();

export class Overlays {
  readonly uFrost = uniform(0);
  readonly uWet = uniform(0);
  readonly uSnow = uniform(0);
  readonly uHurt = uniform(0);
  readonly uLow = uniform(0);
  private frostTex: THREE.DataTexture;
  private frostNode: N;
  private frost = 0;
  private wet = 0;
  private snow = 0;
  private quality: Quality;

  constructor(private engine: CsEngine, quality: Quality) {
    this.quality = quality;
    const mobile = quality.name === 'mobile';
    this.frostTex = mobile ? buildFrostTexture(512, 256) : buildFrostTexture(1024, 512);
    this.frostNode = texture(this.frostTex);
    this.install();
  }

  /** (Re)register the overlays; refraction only where the AA texture already exists. */
  private install(): void {
    const post = this.engine.post;
    const resample = this.quality.aa === 'fxaa' || this.quality.aa === 'smaa';
    post.addOverlay('frost', 200, (color, uv, i) => this.frostFn(color, uv, i, resample), { resample });
    post.addOverlay('lens', 300, (color, uv, i) => this.lensFn(color, uv, i, resample), { resample });
    post.addOverlay('hurt', 400, (color, uv, i) => this.hurtFn(color, uv, i));
  }

  setQuality(q: Quality): void {
    const was = this.quality;
    this.quality = q;
    if ((was.name === 'mobile') !== (q.name === 'mobile')) {
      this.frostTex.dispose();
      this.frostTex = q.name === 'mobile' ? buildFrostTexture(512, 256) : buildFrostTexture(1024, 512);
      this.frostNode.value = this.frostTex;
    }
    if (was.aa !== q.aa || was.name !== q.name) this.install();
  }

  private frostFn(color: N, uv: N, i: N, resample: boolean): N {
    const f = this.uFrost;
    const tex = this.frostNode;
    return Fn(() => {
      const out = vec3(color).toVar();
      If(f.greaterThan(0.002), () => {
        const s = tex.sample(uv);
        const T = s.r, ridge = s.g, spark = s.b;
        const thr = f.mul(1.02);
        const grown = float(1).sub(smoothstep(thr.sub(0.03), thr, T));
        const thick = clamp(thr.sub(T).mul(3.2), 0, 1);
        const front = grown.mul(float(1).sub(smoothstep(0, 0.045, thr.sub(T))));
        let seen: N = out;
        if (resample) {
          const off = vec2(spark.sub(0.5), ridge.sub(0.5)).mul(0.006).mul(grown).add(vec2(0, thick.mul(0.002)));
          seen = i.sample(uv.add(off)).add(i.sample(uv.sub(off.mul(1.7)))).mul(0.5);
        }
        const lum = luminance(seen);
        const veil = vec3(0.85, 0.9, 0.96).mul(lum.mul(0.85).add(0.03));
        const milk = clamp(grown.mul(thick.mul(0.5).add(0.3)).add(ridge.mul(grown).mul(0.25)), 0, 0.92);
        const c = mix(seen, veil, milk).toVar();
        c.addAssign(vec3(0.78, 0.85, 0.93).mul(ridge.mul(grown)).mul(lum.mul(0.55).add(0.02)).mul(0.5));
        c.addAssign(vec3(pow(spark, 48).mul(ridge).mul(grown).mul(lum.add(0.05)).mul(1.2)));
        c.addAssign(vec3(front.mul(lum.add(0.08)).mul(0.05)));
        out.assign(mix(out, c, grown));
      });
      return out;
    })();
  }

  private lensFn(color: N, uv: N, i: N, resample: boolean): N {
    const wet = this.uWet, snow = this.uSnow;
    const asp = i.aspect;
    const t = U.time;
    return Fn(() => {
      const out = vec3(color).toVar();
      If(wet.add(snow).greaterThan(0.002), () => {
        const P = vec2(uv.x.mul(asp), uv.y);
        // ---- melt drops: big lenses ----
        {
          const cells = 6.5;
          const p = P.mul(cells);
          const c = floor(p);
          const f = fract(p).sub(0.5);
          const id = c.x.mul(157.1).add(c.y.mul(113.7));
          const h1 = hash(id), h2 = hash(id.add(1.3)), h3 = hash(id.add(2.7)), h4 = hash(id.add(4.1));
          const exist = float(1).sub(smoothstep(wet.mul(0.55).sub(0.05), wet.mul(0.55), h1));
          // sizes vary a lot: a few big beads among small ones
          const r = mix(float(0.08), float(0.32), h4.mul(h4)).mul(smoothstep(0, 0.35, wet).mul(0.4).add(0.6));
          const off = vec2(h2.sub(0.5), h3.sub(0.5)).mul(float(0.9).sub(r.mul(2))).add(vec2(0, sin(t.mul(0.25).add(h1.mul(6))).mul(0.02)));
          // beads sag a little under their weight: rounder at the bottom
          const q0 = f.sub(off);
          const q = vec2(q0.x.mul(float(1.08).add(h2.mul(0.12))), q0.y.mul(select(q0.y.greaterThan(0), float(0.9), float(1.05))));
          const d = length(q).div(r);
          const inside = float(1).sub(smoothstep(0.82, 1.0, d)).mul(exist);
          const n = q.div(r);
          let seen: N = out;
          if (resample) {
            const k = r.div(cells).mul(1.6);
            seen = i.sample(uv.sub(vec2(n.x.div(asp), n.y).mul(k)));
          }
          const rim = smoothstep(0.55, 0.98, d);
          const spec = pow(max(dot(n.div(max(length(n), 1e-4)), vec2(-0.6, -0.75)), 0), 5).mul(smoothstep(0.35, 0.85, d));
          const drop = seen.mul(float(1.02).sub(rim.mul(0.4))).add(vec3(spec.mul(0.22)));
          out.assign(mix(out, drop, inside));
        }
        // ---- small droplets: a darker, clearer speckle ----
        {
          const cells = 17;
          const p = P.mul(cells);
          const c = floor(p);
          const f = fract(p).sub(0.5);
          const id = c.x.mul(91.3).add(c.y.mul(71.9)).add(17);
          const h1 = hash(id), h2 = hash(id.add(1.1)), h3 = hash(id.add(2.3));
          const exist = float(1).sub(smoothstep(wet.mul(0.6).sub(0.05), wet.mul(0.6), h1));
          const r = mix(float(0.06), float(0.18), h3);
          const q = f.sub(vec2(h2.sub(0.5), h3.sub(0.5)).mul(0.5));
          const d = length(q).div(r);
          const inside = float(1).sub(smoothstep(0.7, 1.0, d)).mul(exist);
          const rim = smoothstep(0.45, 1.0, d);
          out.assign(mix(out, out.mul(float(1.03).sub(rim.mul(0.18))), inside.mul(0.8)));
        }
        // ---- flakes that hit the lens and melt ----
        {
          const cells = 4.6;
          const p = P.mul(cells);
          const c = floor(p);
          const f = fract(p).sub(0.5);
          const id = c.x.mul(37.7).add(c.y.mul(59.3)).add(31);
          const period = 4.2;
          const ph = t.div(period).add(hash(id));
          const epoch = floor(ph);
          const age = fract(ph).mul(period);
          const e = id.add(epoch.mul(13.37));
          const h1 = hash(e), h2 = hash(e.add(1.7)), h3 = hash(e.add(3.1)), h4 = hash(e.add(5.3));
          const exist = float(1).sub(smoothstep(snow.mul(0.55).sub(0.04), snow.mul(0.55), h1));
          const r = mix(float(0.1), float(0.25), h4).mul(float(1).sub(smoothstep(0.4, 3.5, age).mul(0.45)));
          const q = f.sub(vec2(h2.sub(0.5), h3.sub(0.5)).mul(0.55));
          const ang = atan(q.y, q.x);
          // an out-of-focus clump: a soft blob with a ragged rim, not a drawn crystal
          const rag = sin(ang.mul(5).add(h1.mul(20))).mul(0.1).add(sin(ang.mul(9).sub(h2.mul(31))).mul(0.06));
          const d = length(q).div(r).mul(float(1).add(rag));
          const melt = smoothstep(0.3, 2.4, age);
          const flake = float(1).sub(smoothstep(0.15, 1.0, d)).mul(float(1).sub(melt)).mul(exist);
          const dropK = float(1).sub(smoothstep(0.7, 1.0, d)).mul(smoothstep(0.9, 2.4, age)).mul(float(1).sub(smoothstep(3.2, 4.2, age))).mul(exist);
          const lum = luminance(out);
          // ice scatters the light coming through it: a little brighter than what is behind
          out.assign(mix(out, vec3(0.93, 0.95, 0.98).mul(min(lum.mul(1.08).add(0.1), 1)), flake.mul(0.75)));
          // the melted drop: only a faint darker rim where its edge bends the light away
          out.assign(out.mul(float(1).sub(dropK.mul(smoothstep(0.6, 0.95, d)).mul(0.06))));
        }
      });
      return out;
    })();
  }

  private hurtFn(color: N, uv: N, i: N): N {
    const hurt = this.uHurt, low = this.uLow;
    const asp = i.aspect;
    const t = U.time;
    return Fn(() => {
      const out = vec3(color).toVar();
      If(hurt.add(low).greaterThan(0.002), () => {
        const d = uv.sub(0.5).mul(vec2(asp, 1));
        const r = length(d).div(length(vec2(asp, 1).mul(0.5)));
        const edge = smoothstep(0.3, 1.0, r);
        // heartbeat: a double knock, faster as health falls
        const rate = low.mul(0.7).add(1.15);
        const ph = fract(t.mul(rate));
        const beat = smoothstep(0, 0.06, ph).mul(float(1).sub(smoothstep(0.06, 0.2, ph)))
          .add(smoothstep(0.22, 0.28, ph).mul(float(1).sub(smoothstep(0.28, 0.45, ph))).mul(0.6));
        const lum = luminance(out);
        const drained = mix(out, vec3(lum), low.mul(0.8));
        const dark = drained.mul(float(1).sub(edge.mul(low).mul(beat.mul(0.25).add(0.5))));
        const red = mix(dark, dark.mul(vec3(1.0, 0.32, 0.28)).add(vec3(0.22, 0, 0).mul(edge)), clamp(hurt.mul(edge.mul(0.85).add(0.1)), 0, 1));
        out.assign(red);
      });
      return out;
    })();
  }

  /** Drive the uniforms from the HUD model (first person only: the goggles are the camera). */
  update(view: View | null, dt: number, windX: number, windZ: number, storm: number, snowfall: number): void {
    if (!view) {
      this.uFrost.value = this.uWet.value = this.uSnow.value = this.uHurt.value = this.uLow.value = 0;
      return;
    }
    const hud = view.hud;
    const fp = 1 - Math.min(1, Math.max(0, view.camera.third * 2));
    const live = view.mode === 'play' || view.mode === 'inventory' || view.mode === 'pause' || view.mode === 'dead';
    const k = live ? fp : 0;
    // crystals take time to grow and a little less to melt
    const ft = (hud.frost || 0) * k;
    this.frost += Math.sign(ft - this.frost) * Math.min(Math.abs(ft - this.frost), dt * (ft > this.frost ? 0.22 : 0.12));
    const wt = (hud.wetLens || 0) * k;
    this.wet += (wt - this.wet) * Math.min(1, dt * (wt > this.wet ? 1.2 : 0.25));
    // flakes on the lens: storm and snowfall, facing into the wind, out in the open
    const cam = view.camera;
    _e.set(cam.pitch, cam.yaw, 0, 'YXZ');
    _f.set(0, 0, -1).applyEuler(_e);
    const ws = Math.hypot(windX, windZ);
    const facing = ws > 0.1 ? Math.max(0, -(_f.x * windX + _f.z * windZ) / ws) : 0;
    const open = view.me ? 1 - view.me.shelter : 1;
    const st = storm * snowfall * Math.pow(facing, 1.5) * Math.min(1, ws / 8) * open * k;
    this.snow += (st - this.snow) * Math.min(1, dt * 1.5);
    this.uFrost.value = this.frost;
    this.uWet.value = this.wet;
    this.uSnow.value = this.snow;
    this.uHurt.value = Math.min(1, hud.hurt || 0);
    this.uLow.value = live ? Math.min(1, hud.lowHealth || 0) : 0;
  }

  /** Bench / tool control: set the overlay levels directly. */
  force(frost: number | null, wet: number | null, snow: number | null): void {
    if (frost !== null) this.frost = frost;
    if (wet !== null) this.wet = wet;
    if (snow !== null) this.snow = snow;
    this.uFrost.value = this.frost;
    this.uWet.value = this.wet;
    this.uSnow.value = this.snow;
  }

  dispose(): void {
    const post = this.engine.post;
    post.remove('frost');
    post.remove('lens');
    post.remove('hurt');
    this.frostTex.dispose();
  }
}
