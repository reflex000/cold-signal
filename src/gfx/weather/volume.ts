// The storm as a volume: an HDR stage (order 100) that ray-marches 3D noise advected by the wind
// at half resolution, so gust fronts and streaks visibly cross the slope, then composites it at
// full resolution with a depth-aware upsample.
//
// Share. The fog every material gets (scene.fogNode, sky/common.ts) carries a fraction
// (1 - AIR.volShare) of the density; this volume carries the rest, with structure: noise of mean
// one out to VOL_RANGE metres, the analytic remainder beyond. So the mean extinction always equals
// the visibility the simulation asks for, with or without the volume.
//
// WebGL2, 'mobile' and 'low' (quality.volumetricSteps 0) skip the march: the scene fog carries all
// of the density and a cheap screen-space layer of wind streaks is drawn instead (no extra pass).
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { HdrStageInput } from '../post';
import { U } from '../shared';
import { AIR, fogColor, fogDepth, type N } from '../sky/common';
import { getNoise2D, getNoise3D } from '../sky/textures';

const {
  Fn, If, Loop, uniform, texture, texture3D, passTexture, context, uv, vec2, vec3, vec4, float, abs, clamp, max, min, dot, exp, mix, smoothstep,
  length, normalize, interleavedGradientNoise, screenCoordinate, NodeUpdateType, reference, perspectiveDepthToViewZ,
} = TSL as any;

/** Dev: 1 shows the volume transmittance, 2 its in-scattered light (set before the graph builds). */
export const VOL_DEBUG = { mode: 0 };

/** Metres the march covers; the rest of the volume's share is analytic. */
export const VOL_RANGE = 140;

/** Uniforms the weather system drives. */
export const VOLU = {
  /** Wind drift of the noise field, metres (x, y, z), integrated on the CPU. */
  drift: uniform(new THREE.Vector3()),
  /** Faster drift for the fine streaks. */
  drift2: uniform(new THREE.Vector3()),
  /** Wind direction (unit, world XZ) for stretching the streaks along it. */
  windDir: uniform(new THREE.Vector2(1, 0)),
  /** 0..1 contrast of the structure (gusts carve deeper holes and denser fronts). */
  contrast: uniform(0.6),
  /** Frame index for the jitter pattern. */
  frame: uniform(0),
  /** Screen-space streak layer strength (fallback path). */
  streaks: uniform(0),
  /** Wind seen on screen: scroll direction of the fallback streaks (uv units / s). */
  screenWind: uniform(new THREE.Vector2(0.1, 0)),
};

/** Density shape of the storm at world position p: mean about one. */
function stormShape(tex3: N, p: N): N {
  // Big puffs and gust fronts (about 40 m), and streaks stretched along the wind (about 9 m).
  const q1 = p.sub(VOLU.drift).mul(1 / 44);
  const wd = VOLU.windDir;
  // rotate into wind space, compress along the wind so features stream with it
  const along = p.x.mul(wd.x).add(p.z.mul(wd.y));
  const across = p.z.mul(wd.x).sub(p.x.mul(wd.y));
  const q2 = vec3(along.mul(0.35), p.y, across).sub(VOLU.drift2).mul(1 / 9);
  const a = tex3.sample(q1).level(0).r;
  const b = tex3.sample(q2).level(0).g;
  const n = a.mul(0.58).add(b.mul(0.42));
  // Remap around the mean: holes clear, fronts thicken. A soft threshold rather than a scale, so
  // the field has real gaps between sheets (the mean stays near one).
  const c = VOLU.contrast;
  const lo = float(0.5).sub(c.mul(0.32));
  const hi = float(0.5).add(c.mul(0.3));
  return smoothstep(lo, hi, n).mul(1.9).add(float(0.05));
}

/**
 * Renders the march at half resolution into a half-float target: rgb = in-scattered light,
 * a = transmittance, of the volume's share along each view ray (premultiplied).
 */
export class StormVolumeNode extends THREE.Node {
  static get type(): string {
    return 'CsStormVolumeNode';
  }

  private rt: THREE.RenderTarget;
  private quad: THREE.QuadMesh = new (THREE.QuadMesh as any)();
  private state: any = undefined;
  private mat: THREE.NodeMaterial | null = null;
  private out: N;
  private depthTex: N;

  private steps = 10;
  private scale = 0.5;
  /** The scene camera's world matrix (by reference, so always current): a post quad's own
   *  cameraPosition is the quad's camera, not the eye. */
  readonly camWorld: N;
  private projInv: N;
  private camNear: N;
  private camFar: N;

  constructor(camera: THREE.Camera) {
    super('vec4');
    this.camWorld = uniform(camera.matrixWorld);
    this.projInv = uniform(camera.projectionMatrixInverse);
    this.camNear = reference('near', 'float', camera);
    this.camFar = reference('far', 'float', camera);
    this.rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, generateMipmaps: false });
    this.rt.texture.name = 'StormVolume';
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.out = passTexture(this, this.rt.texture);
    this.depthTex = texture(new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType));
    (this as any).updateBeforeType = NodeUpdateType.FRAME;
  }

  /** Bind the inputs of the current post graph (called by the stage builder on every rebuild). */
  bind(i: HdrStageInput, steps: number, scale: number): void {
    this.depthTex = i.depth;

    this.steps = Math.max(2, steps | 0);
    this.scale = scale;
  }

  getTextureNode(): N {
    return this.out;
  }

  get target(): THREE.RenderTarget {
    return this.rt;
  }

  updateBefore(frame: any): undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const map = this.depthTex.value as THREE.Texture | null;
    if (!map || !this.mat) return undefined;
    const w = Math.max(1, Math.round(((map.image as any).width as number) * this.scale));
    const h = Math.max(1, Math.round(((map.image as any).height as number) * this.scale));
    this.rt.setSize(w, h);
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    this.quad.material = this.mat;
    this.quad.name = 'Storm [ volume ]';
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    return undefined;
  }

  setup(builder: any): N {
    const uvN = uv();
    const tex3 = texture3D(getNoise3D());
    const steps = this.steps;
    const march = Fn(() => {
      // The view ray of this pixel from the camera's own matrices (uv has its origin top left),
      // and its length from the linear view depth.
      const eye = this.camWorld.element(3).xyz;
      const ndc = vec2(uvN.x.mul(2).sub(1), uvN.y.mul(-2).add(1));
      const vh = this.projInv.mul(vec4(ndc, 1, 1));
      const vdir = normalize(vh.xyz.div(vh.w));
      const d = normalize(this.camWorld.mul(vec4(vdir, 0)).xyz);
      // Depth read with an explicit level: at half resolution an implicit one picks a mip the
      // depth texture does not have.
      const viewZ = perspectiveDepthToViewZ(this.depthTex.sample(uvN).level(0).r, this.camNear, this.camFar).negate();
      const dist = max(viewZ.div(max(vdir.z.negate(), 1e-4)), 0.01);
      const share = AIR.volShare;
      // March only as far as there is light left to lose (about 6 optical depths of the mean
      // density); past that the analytic tail is exact enough. In a whiteout that is 15 m, so the
      // steps stay short where everything happens.
      const tEnd = min(min(dist, VOL_RANGE), float(6).div(max(U.fogDensity.mul(share), 1e-5)));
      // Blue-noise-like jitter, rotated every frame by the golden ratio.
      const j = interleavedGradientNoise(screenCoordinate.xy).add(VOLU.frame.mul(0.618034)).fract();
      const T = float(1).toVar();
      const tPrev = float(0).toVar();
      const Ls = float(0).toVar(); // in-scattered light, in units of the fog colour
      // Clear weather: the share is zero and the march is skipped (a uniform branch, no rebuild).
      If(share.greaterThan(0.0005), () => {
      Loop(steps, ({ i }: { i: N }) => {
        // Denser near the eye, where the structure is big on screen.
        const u1 = float(i).add(j).div(steps);
        const t = u1.mul(u1).mul(tEnd).toVar();
        // materialise before tPrev changes: an expression node is emitted where it is used
        const dt = t.sub(tPrev).toVar();
        tPrev.assign(t);
        const p = eye.add(d.mul(t));
        // the shared height falloff of the fog
        const rho = U.fogDensity.mul(exp(U.fogHeight.mul(p.y.sub(U.camPos.y)).negate().clamp(-14, 80))).mul(share);
        const shape = stormShape(tex3, p);
        const sig = rho.mul(shape);
        const st = exp(sig.mul(dt).negate());
        // Dense sheets shade themselves: against bright air they read as moving grey veils.
        const shade = float(1.12).sub(shape.mul(0.17));
        Ls.addAssign(T.mul(st.oneMinus()).mul(shade));
        T.mulAssign(st);
      });
      });
      // the last stretch to the end of the march, and the analytic remainder past it
      const tail = fogDepth(dist, d.y, share).sub(fogDepth(tEnd, d.y, share)).max(0);
      const tLast = fogDepth(tEnd, d.y, share).sub(fogDepth(tPrev, d.y, share)).max(0);
      const Trest = exp(tail.add(tLast).negate());
      const Tall = T.mul(Trest);
      return vec4(fogColor(d).mul(Ls.add(T.mul(Trest.oneMinus()))), Tall);
    });
    const m = this.mat ?? new THREE.NodeMaterial();
    m.name = 'StormVolume';
    (m as any).contextNode = context(builder.getSharedContext());
    m.fragmentNode = march();
    m.needsUpdate = true;
    this.mat = m;
    return this.out;
  }

  dispose(): void {
    super.dispose();
    this.rt.dispose();
    this.mat?.dispose();
  }
}

/**
 * Composite of the half-resolution volume over the picture: four taps around the pixel, weighted
 * by how close their depth is to this pixel's (no halos around trees and posts against the fog).
 */
export function compositeVolume(i: HdrStageInput, vol: StormVolumeNode, scale: number): N {
  const tex = vol.getTextureNode();
  // depth first, so the scene pass is registered ahead of the volume in the frame's update order
  const zc = i.viewDepth;
  const size = U.resolution.mul(scale).round().max(1);
  const px = i.uv.mul(size).sub(0.5);
  const base = px.floor();
  const f = px.sub(base);
  let acc: N = vec4(0);
  let wsum: N = float(0);
  for (let k = 0; k < 4; k++) {
    const o = vec2(k & 1, k >> 1);
    const at = base.add(o).add(0.5).div(size);
    const z = i.viewDepthAt(at);
    const wb = mix(float(1).sub(f.x), f.x, o.x).mul(mix(float(1).sub(f.y), f.y, o.y));
    const wd = float(1).div(abs(z.sub(zc)).div(max(zc, 0.1)).mul(40).add(0.02));
    const w = wb.mul(wd).add(1e-5);
    acc = acc.add(tex.sample(at).mul(w));
    wsum = wsum.add(w);
  }
  const v = acc.div(wsum);
  if (VOL_DEBUG.mode === 1) return vec3(v.a);
  if (VOL_DEBUG.mode === 2) return v.rgb;
  const fogged = i.color.mul(v.a).add(v.rgb);
  // Falling snow writes no depth: without this the whole storm behind a flake would be laid over
  // it and a blizzard would show no flakes. The flakes leave their coverage in the scene alpha
  // (weather/snow.ts); a covered pixel keeps (most of) its own colour. (Added by SNOW.)
  if (i.alpha === undefined) return fogged;
  const cover = clamp(float(1).sub(i.alpha), 0, 1);
  return mix(fogged, i.color, cover.mul(0.9));
}

/**
 * The cheap path (WebGL2, phones, low): streaks of blowing snow drawn in screen space over the
 * analytic fog, scrolling with the wind, thicker with distance until the fog swallows them.
 */
export function screenStreaks(i: HdrStageInput, camWorld: N): N {
  const tex = texture(getNoise2D());
  const t = U.time;
  const sw = VOLU.screenWind;
  const speed = length(sw);
  const dir = normalize(sw.add(vec2(1e-4, 0)));
  const nrm = vec2(dir.y.negate(), dir.x);
  const p = vec2(dot(i.uv, dir), dot(i.uv, nrm).mul(U.resolution.y.div(U.resolution.x)));
  // Broad veils of blowing snow and a finer layer over them, each scrolling with the wind at its
  // own speed (parallax). Soft, wide shapes: thin lines would print stripes on dark trunks.
  const a = tex.sample(vec2(p.x.mul(0.7).sub(t.mul(speed)), p.y.mul(2.4))).r;
  const b = tex.sample(vec2(p.x.mul(1.6).sub(t.mul(speed).mul(1.7)), p.y.mul(5.0).add(0.37))).g;
  const veil = smoothstep(0.42, 0.85, a).mul(0.7).add(smoothstep(0.5, 0.88, b).mul(0.3));
  const depth = i.viewDepth;
  const near = smoothstep(2.0, 10.0, depth);
  const far = exp(depth.mul(U.fogDensity).mul(-0.7));
  const amount = veil.mul(VOLU.streaks).mul(near).mul(far.mul(0.75).add(0.25));
  const fogC = fogColor(normalize(i.worldPos.sub(camWorld.element(3).xyz))).mul(1.15);
  return mix(i.color, fogC, clamp(amount, 0, 0.4));
}
