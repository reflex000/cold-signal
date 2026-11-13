// Falling snow around the camera: instanced quads animated entirely in the vertex shader (no
// compute, so it runs on WebGL2), wrapped in a box that follows the camera.
//
// Each instance carries four random numbers. Its position is base + velocity * time + flutter,
// wrapped into the box; the quad is a streak from where the flake is to where it was one shutter
// time ago relative to the camera, so flakes stream sideways in a gale and smear as the player
// turns or runs. Sub-pixel flakes are clamped to about a pixel and fade instead, so far flakes
// never sparkle. Three layers: close streaks (big, soft, crossing the view), near flakes and mid
// streaks (long, faint). Lit by the sun and moon (strong forward scattering when backlit), the
// ambient, and the eight best fire / flare / flashlight lights of FX's pool (PARTICLE_LIGHTS): ice
// crystals glint, so near a fire they flicker orange and in a torch beam they blaze white.
// In a storm the crystals read brighter than the haze they fall through (they are lit by the bright
// overcast zenith; the haze is the horizon's light), and gust sheets sweep downwind: bands of denser
// snow tens of metres apart, so a still frame shows a blizzard and not only fog. Fogged like the world.
// Owner: ATMOS (local lights, close layer and gust sheets added by SNOW).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U, horizonLit } from '../shared';
import { fogAmount, fogColor, hgPhase, type N } from '../sky/common';
import { PARTICLE_LIGHTS, PARTICLE_LIGHT_COUNT } from '../fx/lights';

const {
  Discard, Fn, If, attribute, uniform, varying, vec2, vec3, vec4, float, abs, asin, clamp, max, dot, sin, cos, floor, mix, smoothstep, select,
  length, mod, sqrt, cameraViewMatrix, cameraProjectionMatrix, positionGeometry,
} = TSL as any;

/**
 * Radiance of a snow crystal at world `p` seen along `d` (camera -> flake). Sun and moon scatter
 * forward; the ambient lights it from the bright zenith (`bright` lifts it over the haze); a fire
 * or a beam within range lights it with a glint (a crystal is a tiny mirror: much brighter than a
 * matte surface would be, strongest toward the light).
 */
function crystalLight(p: N, d: N, bright: N): N {
  const amb = vec3(U.skyAmbient).mul(0.62).add(vec3(U.groundAmbient).mul(0.38)).mul(1 / Math.PI);
  const sunPh = hgPhase(dot(d, U.sunDir), float(0.55)).mul(4 * Math.PI).mul(0.45).add(0.35);
  const moonPh = hgPhase(dot(d, U.moonDir), float(0.55)).mul(4 * Math.PI).mul(0.45).add(0.35);
  const sunVis = horizonLit(p.xz, asin(clamp(U.sunDir.y, -1, 1)));
  const sky = amb.add(vec3(U.sunColor).mul(sunPh).mul(sunVis).add(vec3(U.moonColor).mul(moonPh)).mul(1 / Math.PI)).mul(bright);
  let acc: N = vec3(0);
  for (let i = 0; i < PARTICLE_LIGHT_COUNT; i++) {
    const P = PARTICLE_LIGHTS.pos.element(i);
    const C = PARTICLE_LIGHTS.col.element(i);
    const D = PARTICLE_LIGHTS.dir.element(i);
    const L = P.xyz.sub(p);
    // a flake nearer than ~40 cm to a flame no longer brightens like 1/d^2
    const d2 = max(dot(L, L), 0.16);
    const dist = sqrt(d2);
    const x = clamp(dist.div(P.w), 0, 1);
    const x2 = x.mul(x);
    const win = clamp(float(1).sub(x2.mul(x2)), 0, 1);
    const toL = L.div(dist);
    const cone = select(C.w.lessThan(-1.5), float(1), smoothstep(C.w, D.w, dot(toL.negate(), D.xyz)));
    // facets flash: several times a matte surface's share from any side, far more toward the light
    const glint = hgPhase(dot(toL, d), float(0.6)).mul(4 * Math.PI).mul(3).add(4.5);
    acc = acc.add(C.xyz.mul(win.mul(win).mul(cone).mul(glint).div(d2)));
  }
  // a flake a hand's width from the torch would be hundreds of times too bright: cap it (keeps the hue)
  const loc = acc.mul(1 / Math.PI);
  return sky.add(loc.mul(float(2.5).div(max(max(loc.x, max(loc.y, loc.z)), 2.5))));
}

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
  /** 0..1 how strongly the gust sheets thin and thicken this layer. */
  sheets?: number;
  /** > 0: write depth where a flake's opacity exceeds this, and discard below it (see material()). */
  depthCore?: number;
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
  /** How much brighter than the haze a crystal reads (1 calm .. ~2 in a storm by day). */
  bright: uniform(1.3),
  /** 0..1 strength of the gust sheets (storm, gusts). */
  sheets: uniform(0),
  /** Metres the gust sheets have travelled downwind (wrapped). */
  sheetShift: uniform(0),
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
    // The storm volume (an HDR stage after the scene) fogs every pixel up to the depth in the
    // depth buffer, and flakes write no depth: a flake would be buried under the whole storm
    // behind it. So colour blends as usual while alpha keeps 1 - coverage (the scene clears alpha
    // to 1 and opaque things write 1): the storm composite (volume.ts) spares covered pixels.
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    // (optional) a solid core that also writes depth; off by default: fog thins most flakes below it
    const core = o.depthCore ?? 0;
    m.depthWrite = core > 0;
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
    // a gale is eddying air: in a storm the flutter grows and turns vertical, so streaks cross at
    // different angles instead of running in parallel lines
    const fl = mix(float(0.25), length(SNOWU.wind).mul(0.28).add(0.6), SNOWU.turbulence);
    const vf = mix(float(0.4), float(1.1), SNOWU.turbulence);
    const swirl = vec3(sin(t.mul(w1).add(ph.x)), sin(t.mul(w2).add(ph.y)).mul(vf), cos(t.mul(w3).add(ph.z))).mul(fl);
    const vel = vec3(SNOWU.wind.x, fall.negate(), SNOWU.wind.y).add(swirl);
    // Integrated position: the wind drift comes from the CPU (wrapped per layer), the fall is
    // linear in time, the flutter integrates to -cos / sin.
    const flutter = vec3(cos(t.mul(w1).add(ph.x)).negate().div(w1), cos(t.mul(w2).add(ph.y)).negate().div(w2).mul(vf), sin(t.mul(w3).add(ph.z)).div(w3)).mul(fl);
    const drift = vec3(this.drift.x, fall.negate().mul(t), this.drift.y);
    const origin = vec3(U.camPos).sub(vec3(o.half, o.below, o.half));
    const raw = seed.xyz.mul(box).add(drift).add(flutter);
    // wrap into the box that follows the camera
    const pos = mod(raw.sub(origin), box).add(origin).toVar();
    const rel = vel.sub(SNOWU.camVel);
    const size = mix(float(o.size[0]), float(o.size[1]), seed.y.mul(seed.y));

    const vuv = varying(vec2(0), 'vSnowUv');
    const vfade = varying(float(0), 'vSnowFade');
    const vstretch = varying(float(1), 'vSnowStretch');
    // Light and fog are the same over a flake a few pixels wide: computed per vertex, so the
    // fragment shader (the cost of thousands of overlapping streaks) is only the soft shape.
    const vcol = varying(vec3(0), 'vSnowCol');
    const vfog = varying(float(1), 'vSnowFog');
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
      vuv.assign(corner);
      const toCam = vec3(U.camPos).sub(pos);
      const dist = length(toCam);
      const d = toCam.div(max(dist, 1e-4)).negate(); // camera -> flake
      // Ice scatters forward: flakes against the sun, a fire or a beam light up (FX's particle
      // light: sun, moon, ambient and the eight best point / spot lights). Crystals read brighter
      // than the haze (SNOWU.bright), so they show against dark trees and rock and against the grey.
      const lit = crystalLight(pos, d, SNOWU.bright);
      const fa = fogAmount(dist, d);
      vcol.assign(mix(lit, fogColor(d), fa));
      vfog.assign(fa.oneMinus().mul(0.85).add(0.15));
      vstretch.assign(half.div(r));
      // Sub-pixel flakes keep a pixel of size and lose opacity instead; the box edges fade.
      const area = size.div(r).pow(2).mul(r.div(half).add(0.15).min(1));
      const dc = pos.sub(U.camPos);
      const edge = smoothstep(float(o.half), float(o.half * 0.7), max(abs(dc.x), abs(dc.z)))
        .mul(smoothstep(float(-o.below), float(-o.below * 0.7), dc.y))
        .mul(smoothstep(float(o.above), float(o.above * 0.75), dc.y));
      const near = smoothstep(0.12, 0.6, depth);
      // Gust sheets: wavy bands ~24 m apart across the wind, travelling downwind; a flake in a band
      // is denser (more opaque), between bands the air thins. World-space, so they sweep past.
      const wd: N = U.windDir;
      const downwind: N = pos.x.mul(wd.x).add(pos.z.mul(wd.y));
      const across: N = pos.z.mul(wd.x).sub(pos.x.mul(wd.y));
      const front: N = downwind.sub(SNOWU.sheetShift).add(sin(across.mul(0.071).add(sin(across.mul(0.023)).mul(2.1))).mul(5.5));
      const band: N = sin(front.mul((2 * Math.PI) / 24)).mul(0.5).add(0.5);
      const sheet: N = mix(float(1), band.mul(band).mul(1.6).add(0.25), SNOWU.sheets.mul(o.sheets ?? 0));
      vfade.assign(area.mul(edge).mul(near).mul(sheet));
      return cameraProjectionMatrix.mul(vec4(p, 1));
    })();

    // A soft capsule: a round flake stretched along its streak, brightest at its head (the end
    // where the flake is now, corner.y = -1).
    const b = vuv.y.mul(vstretch);
    const db = max(abs(b).sub(vstretch.sub(1)), 0);
    const soft = clamp(float(1).sub(vuv.x.mul(vuv.x).add(db.mul(db))), 0, 1);
    const head = mix(float(1), float(0.55), vuv.y.add(1).mul(0.5));
    const shape = soft.mul(soft).mul(head);
    const alpha = shape.mul(vfade).mul(o.opacity).mul(SNOWU.amount).mul(vfog);
    if (core > 0) {
      // the solid core keeps its full opacity (it now hides what is behind it from the volume too)
      m.fragmentNode = Fn(() => {
        If(alpha.lessThan(core), () => {
          Discard();
        });
        return vec4(vcol, clamp(alpha.mul(1.25), 0, 1));
      })();
    } else {
      m.fragmentNode = vec4(vcol, clamp(alpha, 0, 1));
    }
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

