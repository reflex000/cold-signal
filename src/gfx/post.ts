// The post pipeline: one THREE.RenderPipeline that turns the lit scene into the picture.
//
//   scene pass (linear, scene-referred, half float)
//     -> ambient occlusion (GTAO at half resolution, depth-aware blur)          quality.ao
//     -> HDR stages added by other systems (storm volume, god rays, heat haze)   addHdrStage()
//     -> bloom (threshold on the exposed image, dual-filter mip chain)           quality.bloom
//     -> exposure (U.exposure) -> ACES filmic (or AgX) -> cold grade -> sRGB
//     -> anti-aliasing (FXAA / SMAA; TAA resolves the scene before all of this)  quality.aa
//     -> overlays added by other systems (frost, lens drops, damage, whiteout)   addOverlay()
//     -> vignette -> film grain (quality.grain && userGrain) -> dither
//
// How a system extends it (see PostApi below; docs/THREE_NOTES.md has a worked example):
//
//   const uFog = uniform(0);                                         // created once, driven per frame
//   engine.post.addHdrStage('storm', 100, (i) => mix(i.color, U.fogColor, uFog.mul(fogAmount(i.worldPos))));
//   const uFrost = uniform(0);
//   engine.post.addOverlay('frost', 200, (color, uv, i) => mix(color, frostColor, frostMask(uv, i.aspect).mul(uFrost)));
//
// A stage is a function from TSL nodes to a TSL colour node. It is called again whenever the
// graph is rebuilt (a quality change, a stage added, removed or toggled), so it must be pure:
// create uniforms once outside the function and drive them every frame from the system's update.
// A stage that throws while building is logged once and skipped; the picture stays up.
//
// Degradation. 'mobile' and 'low' never bake an intermediate HDR target: stages are inlined into
// the single composite pass and bloom is a quarter-resolution glow. On the WebGL2 backend SMAA
// and TAA become FXAA and GTAO runs on 'high' and up only. Where the device cannot render to
// half-float targets at all (`hdr === false`) the scene is written pre-exposed and square-root
// encoded into RGBA8 and every stage decodes it; nothing here needs a float target without that
// check. Full-resolution passes after the scene pass: mobile 1 (+ a quarter-res glow chain), low
// and medium 2 (the second feeds FXAA; medium adds GTAO at half res), and each resampling HDR
// stage on medium and up adds one.
// Owner: ENGINE.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { ao as gtaoNode } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa as fxaaNode } from 'three/addons/tsl/display/FXAANode.js';
import { smaa as smaaNode } from 'three/addons/tsl/display/SMAANode.js';
import { traa as traaNode } from 'three/addons/tsl/display/TRAANode.js';
import type { Quality } from './api';
import { U } from './shared';

// TSL is used untyped here: the node typings lag the library and add nothing to shader code.
const {
  pass, mrt, output, velocity, rtt, uv, texture, uniform, reference, passTexture, context,
  vec2, vec3, vec4, float, Fn, mix, smoothstep, max, min, clamp, dot, sqrt, luminance,
  agxToneMapping, acesFilmicToneMapping, sRGBTransferOETF, interleavedGradientNoise, screenCoordinate,
  getViewPosition, getNormalFromDepth, perspectiveDepthToViewZ, logarithmicDepthToViewZ,
  viewZToPerspectiveDepth, rand, NodeUpdateType, isBackgroundDepth,
} = TSL as any;

/** A TSL node. */
export type N = any;

export type ToneMap = 'agx' | 'aces';

/** What an HDR stage is given. Every member is a TSL node (or a function returning one). */
export interface HdrStageInput {
  /** vec3. Linear, scene-referred colour of this pixel so far: scene, AO, earlier stages. */
  color: N;
  /** vec2. Screen position, 0..1, origin top-left. */
  uv: N;
  /** Texture node of the scene depth buffer. Device depth (reversed on most devices): do not
   *  interpret `depth.sample(uv).r` yourself, use `viewDepth` / `worldPos` / the `...At` helpers. */
  depth: N;
  /** float. Distance along the view axis in metres, positive. The sky reads as the far plane. */
  viewDepth: N;
  /** vec3. View-space position of the surface under this pixel (z negative). */
  viewPos: N;
  /** vec3. World-space position of the surface under this pixel. */
  worldPos: N;
  /** vec3. View-space geometric normal, reconstructed from depth (costly: nine depth reads). */
  normal: N;
  /** bool. True where only the background was drawn (scene.background / backgroundNode write no
   *  depth). A sky dome mesh that writes depth reads as geometry at its own distance. */
  isSky: N;
  /** vec3 colour at another screen position. Without `resample` this is the scene before any
   *  stage; with `resample: true` everything up to this stage is baked first (one more pass). */
  sample(uv: N): N;
  viewDepthAt(uv: N): N;
  worldPosAt(uv: N): N;
  quality: Quality;
  backend: 'webgpu' | 'webgl2';
  /** False on the 8-bit fallback: colour above about 4x the exposed white is clipped. */
  hdr: boolean;
}

/** What an overlay is given besides colour and uv. */
export interface OverlayInput {
  /** vec3. Display-referred, sRGB-encoded colour of this pixel so far, 0..1. */
  color: N;
  /** vec2. Screen position, 0..1, origin top-left. */
  uv: N;
  /** vec3 picture at another screen position (for refraction through drops, smears). Needs
   *  `resample: true`, otherwise it returns this pixel's colour whatever uv is asked for. */
  sample(uv: N): N;
  /** float. Width / height of the picture. */
  aspect: N;
  quality: Quality;
  backend: 'webgpu' | 'webgl2';
}

export type HdrStageFn = (input: HdrStageInput) => N;
export type OverlayFn = (color: N, uv: N, input: OverlayInput) => N;

export interface StageOptions {
  /** The stage reads the picture at other screen positions through `input.sample(uv)`. */
  resample?: boolean;
  /** Start disabled; toggle with setEnabled(). Toggling rebuilds the graph, so use a uniform
   *  for anything that fades and keep this for stages that are off for a long time. */
  enabled?: boolean;
}

/** Numbers other systems may drive every frame. All are TSL uniforms: write `.value`. */
export interface PostUniforms {
  /** Additive strength of the bloom. */
  bloomStrength: N;
  /** Exposed brightness (1 = display white before tone mapping) where bloom starts. */
  bloomThreshold: N;
  bloomKnee: N;
  /** 0..1 how much of the ambient occlusion is applied (it fades out on sunlit surfaces). */
  aoStrength: N;
  /** Grade: 1 = neutral. */
  saturation: N;
  contrast: N;
  /** Grade: white balance multiplier, linear RGB. */
  temperature: N;
  /** Grade: tint multiplied into the shadows, linear RGB. */
  shadowTint: N;
  /** 0..1 darkening of the corners. */
  vignette: N;
  /** Amplitude of the film grain in display units (about 0.03). */
  grain: N;
}

/** The part of the pipeline other modules use. `engine.post` implements it. */
export interface PostApi {
  /**
   * Add (or replace, by name) a full-screen stage that runs on scene-referred linear colour
   * before bloom, exposure and tone mapping. Lower `order` runs first. Convention: 100 volumetric
   * fog / storm, 200 god rays, 300 heat haze.
   */
  addHdrStage(name: string, order: number, build: HdrStageFn, opts?: StageOptions): void;
  /**
   * Add (or replace, by name) a screen overlay that runs on the finished, sRGB-encoded picture
   * after anti-aliasing and before vignette and grain. Lower `order` runs first. Convention:
   * 100 whiteout wash, 200 frost, 300 lens drops, 400 damage / low health.
   */
  addOverlay(name: string, order: number, build: OverlayFn, opts?: StageOptions): void;
  /** Remove a stage or overlay by name. */
  remove(name: string): void;
  setEnabled(name: string, on: boolean): void;
  has(name: string): boolean;
  /** Force a rebuild of the node graph on the next frame (a stage's own structure changed). */
  invalidate(): void;
  readonly uniforms: PostUniforms;
  tonemap: ToneMap;
  /** The player's film-grain setting (Settings.grain). Grain is drawn when this and quality.grain are both on. */
  userGrain: boolean;
  readonly hdr: boolean;
  readonly backend: 'webgpu' | 'webgl2';
}

interface Stage {
  name: string;
  order: number;
  seq: number;
  enabled: boolean;
  resample: boolean;
  hdr?: HdrStageFn;
  overlay?: OverlayFn;
}

/** Range of the 8-bit fallback encoding: exposed colour 0..LDR_RANGE is stored as sqrt(c / range). */
const LDR_RANGE = 4;
const enc8 = (c: N): N => sqrt(clamp(c.div(LDR_RANGE), 0, 1));
const dec8 = (v: N): N => v.mul(v).mul(LDR_RANGE);

// ---------------------------------------------------------------------------------------------
// Bloom: threshold + 13-tap downsample chain with a Karis average on the first step (so a single
// hot pixel of an ember or a snow sparkle does not flicker), tent upsample back up, every level
// weighted equally. Far cheaper than a separable Gaussian per level and stable under motion.
// ---------------------------------------------------------------------------------------------
class GlowNode extends THREE.Node {
  static get type(): string {
    return 'CsGlowNode';
  }

  private src: N;
  private decodeSrc: (s: N) => N;
  private hdr: boolean;
  private levels: number;
  private scale: number;
  private threshold: N;
  private knee: N;
  private down: THREE.RenderTarget[] = [];
  private up: THREE.RenderTarget[] = [];
  private quad: THREE.QuadMesh = new (THREE.QuadMesh as any)();
  private state: any = undefined;
  private texel: N = uniform(new THREE.Vector2());
  private mixW: N = uniform(0.5);
  // Swapped per pass in updateBefore. (Created in the constructor: a node property must always
  // hold a texture, the node cache key walks every node-valued property.)
  private texA: N;
  private texB: N;
  private matPre: THREE.NodeMaterial | null = null;
  private matDown: THREE.NodeMaterial | null = null;
  private matUp: THREE.NodeMaterial | null = null;
  private out: N;

  /**
   * @param src texture node holding the picture to bloom
   * @param decodeSrc maps one sample of `src` to exposed linear colour (vec3)
   */
  constructor(src: N, decodeSrc: (s: N) => N, o: { levels: number; scale: number; hdr: boolean; threshold: N; knee: N }) {
    super('vec4');
    this.src = src;
    this.decodeSrc = decodeSrc;
    this.hdr = o.hdr;
    this.levels = Math.max(2, o.levels | 0);
    this.scale = o.scale;
    this.threshold = o.threshold;
    this.knee = o.knee;
    const type = o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    for (let i = 0; i < this.levels; i++) {
      const d = new THREE.RenderTarget(1, 1, { depthBuffer: false, type, generateMipmaps: false });
      d.texture.name = 'Glow.down' + i;
      this.down.push(d);
      if (i < this.levels - 1) {
        const u = new THREE.RenderTarget(1, 1, { depthBuffer: false, type, generateMipmaps: false });
        u.texture.name = 'Glow.up' + i;
        this.up.push(u);
      }
    }
    this.texA = texture(this.down[0].texture);
    this.texB = texture(this.down[0].texture);
    this.out = passTexture(this, this.up[0].texture);
    (this as any).updateBeforeType = NodeUpdateType.FRAME;
  }

  /** Texture node of the finished glow: exposed linear colour (decode with `decode`). */
  getTextureNode(): N {
    return this.out;
  }

  /** Maps one sample of the glow texture to linear colour. */
  decode(s: N): N {
    return this.hdr ? s.rgb : dec8(s.rgb);
  }

  private encode(c: N): N {
    return this.hdr ? c : enc8(c);
  }

  private setSize(w: number, h: number): void {
    let x = Math.max(2, Math.round(w * this.scale));
    let y = Math.max(2, Math.round(h * this.scale));
    for (let i = 0; i < this.levels; i++) {
      this.down[i].setSize(x, y);
      if (i < this.up.length) this.up[i].setSize(x, y);
      x = Math.max(1, x >> 1);
      y = Math.max(1, y >> 1);
    }
  }

  updateBefore(frame: any): undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const map = this.src.value as THREE.Texture | null;
    if (!map || !this.matPre || !this.matDown || !this.matUp) return undefined;
    const sw = (map.image as any).width as number;
    const sh = (map.image as any).height as number;
    this.setSize(sw, sh);
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    const quad = this.quad;

    // 1. threshold and first downsample, straight from the source. The 13 taps are laid out for
    // a 2x reduction; at a 4x reduction the spacing doubles (bilinear taps keep it gap-free enough).
    const spread = this.scale < 0.4 ? 2 : 1;
    this.texel.value.set(spread / sw, spread / sh);
    quad.material = this.matPre;
    quad.name = 'Glow [ prefilter ]';
    renderer.setRenderTarget(this.down[0]);
    quad.render(renderer);

    // 2. down the chain
    quad.material = this.matDown;
    quad.name = 'Glow [ down ]';
    for (let i = 1; i < this.levels; i++) {
      const from = this.down[i - 1];
      this.texA.value = from.texture;
      this.texel.value.set(1 / from.width, 1 / from.height);
      renderer.setRenderTarget(this.down[i]);
      quad.render(renderer);
    }

    // 3. back up: up[i] = average of level i and everything below it, each level weighted the same
    quad.material = this.matUp;
    quad.name = 'Glow [ up ]';
    for (let i = this.levels - 2; i >= 0; i--) {
      const low = i === this.levels - 2 ? this.down[this.levels - 1] : this.up[i + 1];
      const n = this.levels - 1 - i; // levels already folded into `low`
      this.texA.value = low.texture;
      this.texB.value = this.down[i].texture;
      this.texel.value.set(1 / low.width, 1 / low.height);
      this.mixW.value = n / (n + 1);
      renderer.setRenderTarget(this.up[i]);
      quad.render(renderer);
    }

    THREE.RendererUtils.restoreRendererState(renderer, this.state);
  }

  setup(builder: any): N {
    const shared = context(builder.getSharedContext());
    const uvN = uv();
    const t = this.texel;
    const hdr = this.hdr;
    const dec = (s: N): N => (hdr ? s.rgb : dec8(s.rgb));
    const T = this.threshold;
    const K = this.knee;

    // Soft-knee threshold on the brightest channel, so a saturated flame keeps its colour.
    const bright = (c: N): N => {
      const br = max(c.r, max(c.g, c.b));
      const soft = clamp(br.sub(T).add(K), 0, K.mul(2));
      const knee = soft.mul(soft).div(K.mul(4).add(1e-4));
      return c.mul(max(knee, br.sub(T)).div(max(br, 1e-4)));
    };

    const pre = Fn(() => {
      const s = (dx: number, dy: number): N => min(max(this.decodeSrc(this.src.sample(uvN.add(t.mul(vec2(dx, dy))))), vec3(0)), vec3(64)).toVar();
      const a = s(-2, -2), b = s(0, -2), c = s(2, -2);
      const d = s(-2, 0), e = s(0, 0), f = s(2, 0);
      const g = s(-2, 2), h = s(0, 2), i = s(2, 2);
      const j = s(-1, -1), k = s(1, -1), l = s(-1, 1), m = s(1, 1);
      const groups: [N, number][] = [
        [j.add(k).add(l).add(m), 0.5],
        [a.add(b).add(d).add(e), 0.125],
        [b.add(c).add(e).add(f), 0.125],
        [d.add(e).add(g).add(h), 0.125],
        [e.add(f).add(h).add(i), 0.125],
      ];
      const sum = vec3(0).toVar();
      const wsum = float(0).toVar();
      for (const [grp, wgt] of groups) {
        const col = bright(grp.mul(0.25)).toVar();
        const w = float(wgt).div(luminance(col).add(1)).toVar(); // Karis: bright outliers count less
        sum.addAssign(col.mul(w));
        wsum.addAssign(w);
      }
      return vec4(this.encode(sum.div(max(wsum, 1e-4))), 1);
    });

    const down = Fn(() => {
      const s = (dx: number, dy: number): N => dec(this.texA.sample(uvN.add(t.mul(vec2(dx, dy)))));
      const centre = s(0, 0).mul(0.125);
      const inner = s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)).mul(0.125);
      const edge = s(0, -2).add(s(-2, 0)).add(s(2, 0)).add(s(0, 2)).mul(0.0625);
      const corner = s(-2, -2).add(s(2, -2)).add(s(-2, 2)).add(s(2, 2)).mul(0.03125);
      return vec4(this.encode(centre.add(inner).add(edge).add(corner)), 1);
    });

    const up = Fn(() => {
      const s = (dx: number, dy: number): N => dec(this.texA.sample(uvN.add(t.mul(vec2(dx, dy)))));
      const tent = s(0, 0).mul(4)
        .add(s(-1, 0).add(s(1, 0)).add(s(0, -1)).add(s(0, 1)).mul(2))
        .add(s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)))
        .mul(1 / 16);
      const own = dec(this.texB.sample(uvN));
      return vec4(this.encode(mix(own, tent, this.mixW)), 1);
    });

    const make = (old: THREE.NodeMaterial | null, name: string, node: N): THREE.NodeMaterial => {
      const m = old ?? new THREE.NodeMaterial();
      m.name = name;
      (m as any).contextNode = shared;
      m.fragmentNode = node;
      m.needsUpdate = true;
      return m;
    };
    this.matPre = make(this.matPre, 'Glow.prefilter', pre());
    this.matDown = make(this.matDown, 'Glow.down', down());
    this.matUp = make(this.matUp, 'Glow.up', up());
    return this.out;
  }

  dispose(): void {
    super.dispose();
    for (const r of this.down) r.dispose();
    for (const r of this.up) r.dispose();
    this.matPre?.dispose();
    this.matDown?.dispose();
    this.matUp?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Depth-aware 4x4 box blur of the half-resolution AO: removes the GTAO sampling noise without
// bleeding occlusion across silhouettes.
// ---------------------------------------------------------------------------------------------
class AoBlurNode extends THREE.Node {
  static get type(): string {
    return 'CsAoBlurNode';
  }

  private aoTex: N;
  private depthTex: N;
  private viewDepth: (d: N) => N;
  private rt: THREE.RenderTarget;
  private quad: THREE.QuadMesh = new (THREE.QuadMesh as any)();
  private state: any = undefined;
  private texel: N = uniform(new THREE.Vector2());
  private mat: THREE.NodeMaterial | null = null;
  private out: N;

  constructor(aoTex: N, depthTex: N, viewDepth: (d: N) => N) {
    super('float');
    this.aoTex = aoTex;
    this.depthTex = depthTex;
    this.viewDepth = viewDepth;
    this.rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, format: THREE.RedFormat, generateMipmaps: false });
    this.rt.texture.name = 'AoBlur';
    this.out = passTexture(this, this.rt.texture);
    (this as any).updateBeforeType = NodeUpdateType.FRAME;
  }

  getTextureNode(): N {
    return this.out;
  }

  updateBefore(frame: any): undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const map = this.aoTex.value as THREE.Texture | null;
    if (!map || !this.mat) return undefined;
    const w = Math.max(1, (map.image as any).width as number);
    const h = Math.max(1, (map.image as any).height as number);
    this.rt.setSize(w, h);
    this.texel.value.set(1 / w, 1 / h);
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    renderer.setClearColor(0xffffff, 1);
    this.quad.material = this.mat;
    this.quad.name = 'AO [ blur ]';
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
  }

  setup(builder: any): N {
    const uvN = uv();
    const blur = Fn(() => {
      const zc = this.viewDepth(this.depthTex.sample(uvN).r).toVar();
      const sum = float(0).toVar();
      const wsum = float(0).toVar();
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const at = uvN.add(this.texel.mul(vec2(x - 1.5, y - 1.5)));
          const z = this.viewDepth(this.depthTex.sample(at).r);
          // Weight falls to zero at a 4% difference in view depth.
          const w = max(float(1).sub(z.sub(zc).abs().div(zc).mul(25)), 0.0).toVar();
          sum.addAssign(this.aoTex.sample(at).r.mul(w));
          wsum.addAssign(w);
        }
      }
      return vec4(vec3(sum.div(max(wsum, 1e-4))), 1);
    });
    const m = this.mat ?? new THREE.NodeMaterial();
    m.name = 'AoBlur';
    (m as any).contextNode = context(builder.getSharedContext());
    m.fragmentNode = blur();
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

// ---------------------------------------------------------------------------------------------

export interface PostCaps {
  backend: 'webgpu' | 'webgl2';
  /** The scene buffer is half float. False: RGBA8, pre-exposed, sqrt-encoded (see LDR_RANGE). */
  hdr: boolean;
}

export class Post implements PostApi {
  readonly pipeline: THREE.RenderPipeline;
  readonly backend: 'webgpu' | 'webgl2';
  readonly hdr: boolean;
  readonly uniforms: PostUniforms = {
    // Exposed units (1 = display white before the tone curve). Sunlit snow sits near 1 and a
    // slope facing a low sun near 2.5, so the glow starts at 2: only fire, flares, embers, the
    // sun and specular glints bloom.
    bloomStrength: uniform(0.4),
    bloomThreshold: uniform(3.0),
    bloomKnee: uniform(1.0),
    aoStrength: uniform(0.9),
    saturation: uniform(0.9),
    contrast: uniform(1.03),
    temperature: uniform(new THREE.Vector3(0.955, 0.995, 1.06)),
    shadowTint: uniform(new THREE.Vector3(0.9, 0.97, 1.08)),
    vignette: uniform(0.22),
    grain: uniform(0.028),
  };

  /** Chain actually built for the current quality and backend (for the bench HUD and tests). */
  readonly active = { ao: false, bloom: false, aa: 'none' as Quality['aa'], bakes: 0, hdrStages: 0, overlays: 0 };

  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private quality: Quality;
  private stages: Stage[] = [];
  private seq = 0;
  private dirty = true;
  // ACES over AgX: with snow exposed near display white, AgX's long, flat shoulder needs about
  // 1.3 stops more exposure for the same snow brightness, which lifts rock and shade into a
  // milky grey; ACES keeps rock near black, shade blue, and 20+ levels per stop of snow detail.
  private tone: ToneMap = 'aces';
  private grainOn = true;
  private scenePassNode: N = null;
  private graph: { dispose(): void }[] = [];
  private failed = new Set<string>();
  private grainSeed: N = uniform(new THREE.Vector2());
  private frameNo = 0;
  private camNear: N;
  private camFar: N;
  private camProjInv: N;
  private camWorld: N;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, quality: Quality, caps: PostCaps) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.backend = caps.backend;
    this.hdr = caps.hdr;
    this.pipeline = new THREE.RenderPipeline(renderer);
    // Tone mapping and the sRGB transfer are done by this file, in the composite pass.
    this.pipeline.outputColorTransform = false;
    this.camNear = reference('near', 'float', camera);
    this.camFar = reference('far', 'float', camera);
    this.camProjInv = uniform(camera.projectionMatrixInverse);
    this.camWorld = uniform(camera.matrixWorld);
  }

  // ---- extension API ----

  addHdrStage(name: string, order: number, build: HdrStageFn, opts: StageOptions = {}): void {
    this.put({ name, order, seq: this.seq++, enabled: opts.enabled !== false, resample: opts.resample === true, hdr: build });
  }

  addOverlay(name: string, order: number, build: OverlayFn, opts: StageOptions = {}): void {
    this.put({ name, order, seq: this.seq++, enabled: opts.enabled !== false, resample: opts.resample === true, overlay: build });
  }

  remove(name: string): void {
    const i = this.stages.findIndex((s) => s.name === name);
    if (i < 0) return;
    this.stages.splice(i, 1);
    this.dirty = true;
  }

  setEnabled(name: string, on: boolean): void {
    const s = this.stages.find((x) => x.name === name);
    if (!s || s.enabled === on) return;
    s.enabled = on;
    this.dirty = true;
  }

  has(name: string): boolean {
    return this.stages.some((s) => s.name === name);
  }

  invalidate(): void {
    this.dirty = true;
  }

  get userGrain(): boolean {
    return this.grainOn;
  }

  set userGrain(v: boolean) {
    if (v === this.grainOn) return;
    this.grainOn = v;
    this.dirty = true;
  }

  get tonemap(): ToneMap {
    return this.tone;
  }

  set tonemap(v: ToneMap) {
    if (v === this.tone) return;
    this.tone = v;
    this.dirty = true;
  }

  /** The scene pass of the current graph (it is recreated on every rebuild). */
  get scenePass(): N {
    if (this.dirty) this.build();
    return this.scenePassNode;
  }

  // ---- engine side ----

  setQuality(q: Quality): void {
    this.quality = q;
    this.dirty = true;
  }

  /** Render one frame: the scene pass and everything after it, to the canvas. */
  render(): void {
    if (this.dirty) this.build();
    // A new grain pattern every frame; the golden-ratio walk never repeats visibly.
    this.frameNo = (this.frameNo + 1) % 4096;
    this.grainSeed.value.set((this.frameNo * 0.61803398875) % 1, (this.frameNo * 0.75487766625) % 1);
    // The final pass draws to whatever target is bound: make sure it is the canvas with no MRT,
    // whatever a pending compileAsync (or another system) left behind.
    const r = this.renderer as any;
    r.setRenderTarget(null);
    r.setMRT(null);
    this.pipeline.render();
  }

  /**
   * Compile the pipelines the scene pass needs, for the whole scene or for one object that is
   * about to be added to it (compiled with the scene's lights), without blocking a frame.
   * Pipelines are keyed by the render target's formats and the MRT, so this compiles against the
   * scene pass's own target. Unlike PassNode.compileAsync, which leaves that target bound until
   * the promise settles, the renderer state is restored synchronously (Renderer.compileAsync
   * snapshots it before its first await), so frames may keep rendering meanwhile.
   */
  async compile(object?: THREE.Object3D): Promise<void> {
    if (this.dirty) this.build();
    const r = this.renderer as any;
    const sp = this.scenePassNode;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    sp.setSize(size.x, size.y);
    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    let done: Promise<void>;
    r.setRenderTarget(sp.renderTarget);
    r.setMRT(sp.getMRT());
    try {
      done = object ? r.compileAsync(object, this.camera, this.scene) : r.compileAsync(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMRT);
    }
    try {
      await done;
    } finally {
      // compileAsync puts back the MRT it started with each time it yields (Renderer
      // _finishPreCompile), i.e. the scene pass's; render() also resets it before every frame.
      r.setMRT(prevMRT);
    }
  }

  dispose(): void {
    this.disposeGraph();
    this.pipeline.dispose();
  }

  // ---- internals ----

  private put(s: Stage): void {
    const i = this.stages.findIndex((x) => x.name === s.name);
    if (i >= 0) this.stages.splice(i, 1);
    this.stages.push(s);
    this.failed.delete(s.name);
    this.dirty = true;
  }

  private disposeGraph(): void {
    for (const n of this.graph) {
      try {
        n.dispose();
      } catch {
        /* a node that was never built has nothing to free */
      }
    }
    this.graph.length = 0;
  }

  private track<T>(node: T): T {
    this.graph.push(node as unknown as { dispose(): void });
    return node;
  }

  /** Device depth sample -> positive distance along the view axis, metres. */
  private viewDepthOf = (d: N): N => {
    const r = this.renderer as any;
    const z = r.logarithmicDepthBuffer === true ? logarithmicDepthToViewZ(d, this.camNear, this.camFar) : perspectiveDepthToViewZ(d, this.camNear, this.camFar);
    return z.negate();
  };

  private viewPosOf(at: N, depthTex: N): N {
    const r = this.renderer as any;
    let d: N = depthTex.sample(at).r;
    // getViewPosition expects a perspective depth; a logarithmic buffer is converted first.
    if (r.logarithmicDepthBuffer === true) d = viewZToPerspectiveDepth(logarithmicDepthToViewZ(d, this.camNear, this.camFar), this.camNear, this.camFar);
    return getViewPosition(at, d, this.camProjInv);
  }

  private runStage(s: Stage, fn: () => N, fallback: N): N {
    if (this.failed.has(s.name)) return fallback;
    try {
      const out = fn();
      return out === undefined || out === null ? fallback : out;
    } catch (e) {
      // One bad stage must not take the picture down with it: report once and skip it.
      this.failed.add(s.name);
      console.error(`[post] stage '${s.name}' failed to build and is skipped`, e);
      return fallback;
    }
  }

  private build(): void {
    this.dirty = false;
    this.disposeGraph();
    const q = this.quality;
    const hdr = this.hdr;
    const gl = this.backend === 'webgl2';
    const cheap = q.name === 'mobile' || q.name === 'low';
    const u = this.uniforms;
    const uvN: N = uv();
    const sorted = this.stages.filter((s) => s.enabled).sort((a, b) => a.order - b.order || a.seq - b.seq);
    const hdrStages = sorted.filter((s) => s.hdr);
    const overlays = sorted.filter((s) => s.overlay);

    // What this device can actually run.
    let aa: Quality['aa'] = q.aa;
    if (aa === 'taa' && (gl || !hdr)) aa = 'smaa'; // TAA needs a velocity target and float history
    if (aa === 'smaa' && (gl || !hdr)) aa = 'fxaa'; // SMAA keeps three half-float targets
    // GTAO renders to an 8-bit red target and its depth gather has a GLSL polyfill in r187
    // (GLSLNodeBuilder tsl_textureGather), so it also runs on WebGL2 (verified); there it is kept
    // for 'high' and up, so the WebGL2 'medium' chain stays at three full-screen passes.
    const useAo = q.ao && hdr && (!gl || q.name === 'high' || q.name === 'ultra');
    const useBloom = q.bloom;

    // ---- scene pass ----
    const scenePass: N = this.track(pass(this.scene, this.camera));
    this.scenePassNode = scenePass;
    // PassNode switches its depth texture to FloatType only in setup(), which runs after
    // compileAsync() (warmup) has already allocated it as depth24plus; reversed depth on a 24-bit
    // fixed-point buffer gains nothing, and TRAA's depth copy then fails on the format mismatch.
    // (three/src/nodes/display/PassNode.js setup(), src/renderers/common/Textures.js)
    if ((this.renderer as any).reversedDepthBuffer === true && scenePass.renderTarget?.depthTexture) {
      scenePass.renderTarget.depthTexture.type = THREE.FloatType;
    }
    // Same for the colour format (setup() copies the output buffer type): compile() must see the
    // format the frames will render to, or its pipelines do not match (the RGBA8 fallback).
    if (scenePass.renderTarget?.texture) scenePass.renderTarget.texture.type = (this.renderer as any).getOutputBufferType();
    if (aa === 'taa') scenePass.setMRT(mrt({ output, velocity }));
    else if (!hdr) scenePass.setMRT(mrt({ output: vec4(enc8(output.rgb.mul(U.exposure)), output.a) }));
    let sceneTex: N = scenePass.getTextureNode('output');
    const depthTex: N = scenePass.getTextureNode('depth');
    if (aa === 'taa') {
      const resolve: N = this.track((traaNode as any)(sceneTex, depthTex, scenePass.getTextureNode('velocity'), this.camera));
      sceneTex = resolve.getTextureNode();
    }

    // Every intermediate colour texture uses one convention: half float holds scene-referred
    // linear colour; the 8-bit fallback holds exposed colour, sqrt-encoded.
    const read = (tex: N, at: N): N => (hdr ? tex.sample(at).rgb : dec8(tex.sample(at).rgb).div(U.exposure));
    const readExposed = (s: N): N => (hdr ? s.rgb.mul(U.exposure) : dec8(s.rgb));
    const bake = (c: N): N => {
      this.active.bakes++;
      const stored = hdr ? c : enc8(c.mul(U.exposure));
      return this.track(rtt(vec4(stored, 1), null, null, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false }));
    };
    this.active.bakes = 0;

    let latest: N = sceneTex; // newest texture that holds the picture
    let pending = false; // `c` has stage work that `latest` does not
    let c: N = read(sceneTex, uvN);

    // ---- ambient occlusion ----
    if (useAo) {
      const gt: N = this.track((gtaoNode as any)(depthTex, null, this.camera));
      gt.resolutionScale = q.name === 'ultra' ? 1 : 0.5;
      gt.samples.value = q.name === 'medium' ? 9 : 16;
      gt.radius.value = 0.7; // metres: contact shadow under props, creases in drifts
      gt.thickness.value = 1.2;
      const blur = this.track(new AoBlurNode(gt.getTextureNode(), depthTex, this.viewDepthOf));
      const occ: N = blur.getTextureNode().sample(uvN).r;
      // AO belongs to ambient light only. Without a depth pre-pass it is applied to the lit
      // result, so it is faded out where direct light dominates (sunlit snow stays clean).
      const lit = smoothstep(0.3, 1.0, luminance(c.mul(U.exposure)));
      c = c.mul(mix(float(1), occ, u.aoStrength.mul(lit.oneMinus())));
    }
    this.active.ao = useAo;

    // ---- HDR stages ----
    const viewDepthAt = (at: N): N => this.viewDepthOf(depthTex.sample(at).r);
    const worldPosAt = (at: N): N => this.camWorld.mul(vec4(this.viewPosOf(at, depthTex), 1)).xyz;
    for (const s of hdrStages) {
      if (s.resample && pending) {
        latest = bake(c);
        c = read(latest, uvN);
        pending = false;
      }
      const from = latest;
      const colorIn = c;
      const self = this;
      // Getters: a node is only created (and only costs shader time) if the stage asks for it.
      const input: HdrStageInput = {
        color: colorIn,
        uv: uvN,
        depth: depthTex,
        get viewDepth() {
          return viewDepthAt(uvN);
        },
        get viewPos() {
          return self.viewPosOf(uvN, depthTex);
        },
        get worldPos() {
          return worldPosAt(uvN);
        },
        get normal() {
          return getNormalFromDepth(uvN, depthTex.value, self.camProjInv);
        },
        get isSky() {
          return isBackgroundDepth(depthTex.sample(uvN).r); // reversed-depth aware
        },
        sample: (at: N) => read(from, at),
        viewDepthAt,
        worldPosAt,
        quality: q,
        backend: this.backend,
        hdr,
      };
      const out = this.runStage(s, () => vec3(s.hdr!(input)), colorIn);
      if (out !== colorIn) pending = true;
      c = out;
    }
    this.active.hdrStages = hdrStages.length;

    // ---- bloom, exposure ----
    let exposed: N;
    if (useBloom) {
      // The glow must see the storm and the haze, or a fire hidden in a whiteout still shines.
      // The cheap tiers skip that bake: their stages are light and the scene fog is in the pass.
      if (pending && !cheap) {
        latest = bake(c);
        c = read(latest, uvN);
        pending = false;
      }
      const glow = this.track(
        new GlowNode(latest, readExposed, {
          levels: q.name === 'mobile' ? 3 : q.name === 'low' ? 4 : q.name === 'medium' ? 5 : 6,
          scale: cheap ? 0.25 : 0.5,
          hdr,
          threshold: u.bloomThreshold,
          knee: u.bloomKnee,
        }),
      );
      exposed = c.mul(U.exposure).add(glow.decode(glow.getTextureNode().sample(uvN)).mul(u.bloomStrength));
    } else {
      exposed = c.mul(U.exposure);
    }
    this.active.bloom = useBloom;

    // ---- tone mapping, grade, transfer ----
    const tone = this.tone;
    // AgX leaves a milky toe that needs a larger black lift than ACES.
    const blackLift = tone === 'agx' ? 0.0035 : 0.0012;
    const display = Fn(([x]: N[]) => {
      const hdrIn = max(x, vec3(0));
      const mapped = tone === 'agx' ? agxToneMapping(hdrIn, float(1)) : acesFilmicToneMapping(hdrIn, float(1));
      // Grade, on display-linear colour.
      const g = mapped.toVar();
      const l0 = luminance(g).toVar();
      // Cold white balance in the shadows and mid tones, fading out toward the highlights so
      // snow in a low sun keeps the light's warmth (blue shade, cream highlights).
      g.assign(g.mul(mix(u.temperature, vec3(1), smoothstep(0.3, 0.8, l0))));
      // Less colour in the mid tones; the darks and the hottest highlights (fire) keep theirs.
      const l = luminance(g).toVar();
      const satW = mix(u.saturation, float(1), smoothstep(0.75, 1.0, max(g.r, max(g.g, g.b))));
      g.assign(mix(vec3(l), g, satW));
      // Blue in the deep shadows only, multiplied so black stays black.
      g.assign(g.mul(mix(u.shadowTint, vec3(1), smoothstep(0.0, 0.3, l))));
      // A gentle S curve in perceptual space (contrast 1 = none).
      const p = sqrt(clamp(g, 0, 1)).toVar();
      const sCurve = p.mul(p).mul(float(3).sub(p.mul(2)));
      p.assign(mix(p, sCurve, u.contrast.sub(1).mul(2.5)));
      g.assign(p.mul(p));
      // Clean blacks.
      g.assign(max(g.sub(blackLift), 0).div(1 - blackLift));
      return sRGBTransferOETF(clamp(g, 0, 1));
    });
    let ldr: N = display(exposed);

    // ---- anti-aliasing ----
    const ign: N = interleavedGradientNoise(screenCoordinate.xy);
    const needTex = aa === 'fxaa' || aa === 'smaa' || overlays.some((o) => o.resample);
    let ldrTex: N = null;
    if (needTex) {
      // Dithered on the way into 8 bits so the gradients of sky and fog survive the round trip.
      const stored = ldr.add(ign.sub(0.5).div(255));
      ldrTex = this.track(rtt(vec4(stored, 1), null, null, { type: THREE.UnsignedByteType, depthBuffer: false }));
      if (aa === 'fxaa') ldr = this.track((fxaaNode as any)(ldrTex)).rgb;
      else if (aa === 'smaa') ldr = this.track((smaaNode as any)(ldrTex)).rgb;
      else ldr = ldrTex.sample(uvN).rgb;
    }
    this.active.aa = aa;

    // ---- overlays ----
    const aspect: N = U.resolution.x.div(U.resolution.y);
    for (const s of overlays) {
      const colorIn = ldr;
      const tex = ldrTex;
      const input: OverlayInput = {
        color: colorIn,
        uv: uvN,
        sample: (at: N) => (tex ? tex.sample(at).rgb : colorIn),
        aspect,
        quality: q,
        backend: this.backend,
      };
      ldr = this.runStage(s, () => vec3(s.overlay!(colorIn, uvN, input)), colorIn);
    }
    this.active.overlays = overlays.length;

    // ---- vignette, grain, dither ----
    const finish = Fn(([x]: N[]) => {
      const o = x.toVar();
      const d = uvN.sub(0.5).mul(vec2(aspect, 1));
      const r = d.length().div(vec2(aspect, 1).mul(0.5).length());
      o.mulAssign(float(1).sub(u.vignette.mul(smoothstep(0.42, 1.08, r))));
      if (q.grain && this.grainOn) {
        const n = rand(uvN.add(this.grainSeed)).sub(0.5);
        // Grain lives in the mid tones and shadows; highlights (snow in sun) stay clean.
        const lum = luminance(o);
        o.addAssign(n.mul(u.grain).mul(mix(float(1), float(0.35), smoothstep(0.45, 0.95, lum))));
      }
      o.addAssign(ign.sub(0.5).div(255));
      return vec4(clamp(o, 0, 1), 1);
    });

    this.pipeline.outputNode = finish(ldr);
    this.pipeline.needsUpdate = true;
  }
}
