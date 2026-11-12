// Falling snow around the camera: instanced quads animated entirely in the vertex shader (no
// compute, so it runs on WebGL2), wrapped in a box that follows the camera.
//
// Each instance carries four random numbers. Its position is base + velocity * time + flutter,
// wrapped into the box; the quad is a streak from where the flake is to where it was one shutter
// time ago relative to the camera, so flakes stream sideways in a gale and smear as the player
// turns or runs. Sub-pixel flakes are clamped to about a pixel and fade instead, so far flakes
// never sparkle. Two layers: near flakes (soft round sprites) and mid streaks (long, faint).
// Lit by the sun (strong forward scattering when backlit) and the ambient; fogged like the world.
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../shared';
import { fogAmount, fogColor, hgPhase, type N } from '../sky/common';

const {
  Fn, attribute, uniform, varying, vec2, vec3, vec4, float, abs, clamp, max, dot, sin, cos, floor, mix, smoothstep, select,
  length, mod, cameraViewMatrix, cameraProjectionMatrix, positionGeometry,
} = TSL as any;

export interface SnowLayerOptions {
  name: string;
  /** Instances allocated (the most this layer ever draws). */
  max: number;
  /** Half extents of the wrap box around the camera, metres (x/z, and y below / above the eye). */
  half: number;
  below: number;
  above: number;
  /** Flake radius range, metres. */
  size: [number, number];
  /** Shutter time for the motion streak, seconds. */
  shutter: number;
  /** Opacity of one flake. */
  opacity: number;
  /** Fraction of instances that are drawn at full snowfall. */
  seed: number;
}

/** Uniforms shared by every snow layer; written by the weather system. */
export const SNOWU = {
  /** Wind velocity, m/s (x, z), mean plus gust. */
  wind: uniform(new THREE.Vector2(2, 0)),
  /** 0..1 how chaotic the air is (storm). */
  turbulence: uniform(0),
  /** Camera velocity, m/s (world). */
  camVel: uniform(new THREE.Vector3()),
  /** Seconds, continuous (wraps rarely, see weather index). */
  time: uniform(0),
  /** 0..1 intensity the layers fade with (snowfall). */
  amount: uniform(0),
};

/** Seconds after which the snow clock wraps (see the material). */
export const SNOW_PERIOD = 600;

export class SnowLayer {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  /** Wind drift of this layer, metres (x, z), integrated on the CPU and wrapped by the box. */
  readonly drift: any = uniform(new THREE.Vector2());
  private opts: SnowLayerOptions;

  constructor(o: SnowLayerOptions) {
    this.opts = o;
    const g = new THREE.InstancedBufferGeometry();
    // A unit quad: x across the streak, y along it.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(o.max * 4);
    let s = (o.seed * 2654435761) >>> 0 || 1;
    const rnd = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < o.max * 4; i++) seeds[i] = rnd();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = 0;
    // The box moves with the camera; the bounds only need to be big enough never to be culled.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, this.material());
    this.mesh.name = o.name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  private material(): THREE.NodeMaterial {
    const o = this.opts;
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'Snow.' + o.name;
    m.transparent = true;
    m.depthWrite = false;
    m.depthTest = true;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;

    const seed: N = attribute('aSeed', 'vec4');
    const corner: N = positionGeometry.xy;
    const boxY = o.below + o.above;
    const box = vec3(o.half * 2, boxY, o.half * 2);
    // Everything is periodic in SNOW_PERIOD seconds so the clock can wrap without a jump: fall
    // speeds are whole numbers of box heights per period, flutter frequencies whole turns.
    const t: N = SNOWU.time;
    const P = SNOW_PERIOD;
    const TAU = Math.PI * 2;
    const fall = floor(mix(float((0.6 * P) / boxY), float((1.6 * P) / boxY), seed.w)).mul(boxY / P); // 0.6..1.6 m/s
    const w1 = floor(mix(float((1.1 * P) / TAU), float((2.3 * P) / TAU), seed.y)).mul(TAU / P);
    const w2 = floor(mix(float((0.7 * P) / TAU), float((1.9 * P) / TAU), seed.z)).mul(TAU / P);
    const w3 = floor(mix(float((0.9 * P) / TAU), float((2.1 * P) / TAU), seed.x)).mul(TAU / P);
    const ph = seed.xyz.mul(TAU);
    const fl = mix(float(0.25), float(1.6), SNOWU.turbulence);
    const swirl = vec3(sin(t.mul(w1).add(ph.x)), sin(t.mul(w2).add(ph.y)).mul(0.4), cos(t.mul(w3).add(ph.z))).mul(fl);
    const vel = vec3(SNOWU.wind.x, fall.negate(), SNOWU.wind.y).add(swirl);
    // Integrated position: the wind drift comes from the CPU (wrapped per layer), the fall is
    // linear in time, the flutter integrates to -cos / sin.
    const flutter = vec3(cos(t.mul(w1).add(ph.x)).negate().div(w1), cos(t.mul(w2).add(ph.y)).negate().div(w2).mul(0.4), sin(t.mul(w3).add(ph.z)).div(w3)).mul(fl);
    const drift = vec3(this.drift.x, fall.negate().mul(t), this.drift.y);
    const origin = vec3(U.camPos).sub(vec3(o.half, o.below, o.half));
    const raw = seed.xyz.mul(box).add(drift).add(flutter);
    // wrap into the box that follows the camera
    const pos = mod(raw.sub(origin), box).add(origin).toVar();
    const rel = vel.sub(SNOWU.camVel);
    const size = mix(float(o.size[0]), float(o.size[1]), seed.y.mul(seed.y));

    const vpos = varying(vec3(0), 'vSnowWorld');
    const vuv = varying(vec2(0), 'vSnowUv');
    const vfade = varying(float(0), 'vSnowFade');
    const vstretch = varying(float(1), 'vSnowStretch');
    m.vertexNode = Fn(() => {
      const c1 = cameraViewMatrix.mul(vec4(pos, 1)).xyz;
      const c2 = cameraViewMatrix.mul(vec4(pos.sub(rel.mul(o.shutter)), 1)).xyz;
      const mid = c1.add(c2).mul(0.5);
      const depth = max(mid.z.negate(), 0.05);
      // metres per pixel at this depth
      const mpp = depth.mul(2).div(cameraProjectionMatrix.element(1).element(1).mul(U.resolution.y));
      const r = max(size, mpp.mul(0.7));
      const seg = c2.xy.sub(c1.xy);
      const sl = length(seg);
      const along = select(sl.greaterThan(1e-5), seg.div(max(sl, 1e-5)), vec2(0, 1));
      const side = vec2(along.y.negate(), along.x);
      const half = sl.mul(0.5).add(r);
      const p = mid.add(vec3(side.mul(corner.x.mul(r)).add(along.mul(corner.y.mul(half))), 0));
      vpos.assign(pos);
      vuv.assign(corner);
      vstretch.assign(half.div(r));
      // Sub-pixel flakes keep a pixel of size and lose opacity instead; the box edges fade.
      const area = size.div(r).pow(2).mul(r.div(half).add(0.15).min(1));
      const dc = pos.sub(U.camPos);
      const edge = smoothstep(float(o.half), float(o.half * 0.7), max(abs(dc.x), abs(dc.z)))
        .mul(smoothstep(float(-o.below), float(-o.below * 0.7), dc.y))
        .mul(smoothstep(float(o.above), float(o.above * 0.75), dc.y));
      const near = smoothstep(0.12, 0.6, depth);
      vfade.assign(area.mul(edge).mul(near));
      return cameraProjectionMatrix.mul(vec4(p, 1));
    })();

    // A soft capsule: a round flake stretched along its streak, brightest at its head (the end
    // where the flake is now, corner.y = -1).
    const b = vuv.y.mul(vstretch);
    const db = max(abs(b).sub(vstretch.sub(1)), 0);
    const soft = clamp(float(1).sub(vuv.x.mul(vuv.x).add(db.mul(db))), 0, 1);
    const head = mix(float(1), float(0.55), vuv.y.add(1).mul(0.5));
    const shape = soft.mul(soft).mul(head);
    const toCam = vec3(U.camPos).sub(vpos);
    const dist = length(toCam);
    const d = toCam.div(max(dist, 1e-4)).negate(); // camera -> flake
    // Ice scatters forward: flakes against the sun light up.
    const sunPh = hgPhase(dot(d, U.sunDir), float(0.55)).mul(4 * Math.PI).mul(0.45).add(0.35);
    const moonPh = hgPhase(dot(d, U.moonDir), float(0.55)).mul(4 * Math.PI).mul(0.45).add(0.35);
    const amb = vec3(U.skyAmbient).add(vec3(U.groundAmbient)).mul(0.5 / Math.PI);
    // Ice crystals are brighter than the air they fall through (specular glints), so they read
    // against dark trees and rock and, faintly, against the sky.
    const lit = amb.add(vec3(U.sunColor).mul(sunPh).mul(1 / Math.PI)).add(vec3(U.moonColor).mul(moonPh).mul(1 / Math.PI)).mul(1.3);
    const fa = fogAmount(dist, d);
    const col = mix(lit, fogColor(d), fa);
    const alpha = shape.mul(vfade).mul(o.opacity).mul(SNOWU.amount).mul(fa.oneMinus().mul(0.85).add(0.15));
    m.fragmentNode = vec4(col, clamp(alpha, 0, 1));
    return m;
  }

  /** Draw `n` instances (0..max). */
  setCount(n: number): void {
    this.geometry.instanceCount = Math.max(0, Math.min(this.opts.max, Math.round(n)));
  }

  /** Advance the wind drift by (dx, dz) metres, wrapped by the box so it never grows large. */
  advance(dx: number, dz: number): void {
    const w = this.opts.half * 2;
    const v = this.drift.value as THREE.Vector2;
    v.x = (((v.x + dx) % w) + w) % w;
    v.y = (((v.y + dz) % w) + w) % w;
  }

  get max(): number {
    return this.opts.max;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

