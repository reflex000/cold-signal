// The renderer: THREE.WebGPURenderer on the WebGPU backend, or on WebGL2 where WebGPU is missing
// (or `?webgl=1` / opts.forceWebGL asks for it). Owns the scene, the camera, the canvas size, the
// frame, the stats and the post pipeline (./post.ts). Implements Engine from ./api.ts.
//
// Colour: linear working space, scene-referred half-float scene buffer; exposure, tone mapping
// and the sRGB transfer happen once, in the post pipeline. renderer.toneMapping stays off.
// Depth: reversed float depth (near 0.08 m, far 6000 m without z-fighting) on WebGPU and on WebGL2
// with EXT_clip_control; a standard depth buffer otherwise (see `depthMode`).
// Owner: ENGINE.
import * as THREE from 'three/webgpu';
import type { Engine, Frame, GfxSystem, Quality, QualityName } from './api';
import { detectDevice, probeWebGL2, type DeviceInfo } from './detect';
import { Post } from './post';
import { getQuality, lowerQuality } from './quality';
import { U } from './shared';

export interface EngineOptions {
  quality: QualityName;
  /** Use the WebGL2 backend even where WebGPU works. `?webgl=1` in the URL does the same. */
  forceWebGL?: boolean;
  /** Dev: use the 8-bit scene buffer even where half-float targets work (tests that fallback). */
  forceLDR?: boolean;
  /** Dev: 'standard' turns reversed depth off (tests the path of a WebGL2 without EXT_clip_control). */
  depth?: 'auto' | 'standard';
  /** Measure GPU time per frame with timestamp queries where the backend has them. Default off. */
  gpuTiming?: boolean;
  /** Start with dynamic resolution on. It can be switched at any time. */
  dynamicResolution?: boolean;
}

export interface DeviceLostInfo {
  api: string;
  message: string;
  reason: string | null;
}

/** Engine plus what the ENGINE module adds to the contract. createEngine returns this. */
export interface CsEngine extends Engine {
  readonly post: Post;
  readonly device: DeviceInfo;
  /** The scene buffer is half float (true everywhere except very old WebGL2 devices). */
  readonly hdr: boolean;
  readonly depthMode: 'reversed' | 'standard';
  /** The GPU device or WebGL context is gone. frame() does nothing; the page must be reloaded. */
  readonly lost: boolean;
  /** Called once when the device is lost. Show a message and offer a reload; do not reload in a loop. */
  onDeviceLost: ((info: DeviceLostInfo) => void) | null;
  /** The player's render-scale setting (0.5..1), multiplied into quality.renderScale. */
  userScale: number;
  /** Nudge the render scale to hold the frame-time target (60 fps, or 30 on the 'mobile' preset). */
  dynamicResolution: boolean;
  /** The factor dynamic resolution currently applies, 0.6..1. */
  readonly dynScale: number;
  /**
   * Compile the materials of one object that is about to be added to the scene (a fire, a flare,
   * a model loaded mid-game) so its first frame does not hitch. Safe while frames are running.
   */
  compile(object: THREE.Object3D): Promise<void>;
}

const LOST_KEY = 'cs.gfx.lost';
const NEAR = 0.08;
const FAR = 6000;

interface LostRecord {
  t: number;
  backend: string;
  quality: QualityName;
}

function readLost(): LostRecord | null {
  try {
    const raw = sessionStorage.getItem(LOST_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as LostRecord;
    // Only a recent loss says anything about this run.
    return typeof r.t === 'number' && Date.now() - r.t < 10 * 60 * 1000 ? r : null;
  } catch {
    return null;
  }
}

function writeLost(r: LostRecord): void {
  try {
    sessionStorage.setItem(LOST_KEY, JSON.stringify(r));
  } catch {
    /* private mode: nothing to remember */
  }
}

class EngineImpl implements CsEngine {
  readonly renderer: THREE.WebGPURenderer;
  readonly backend: 'webgpu' | 'webgl2';
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly post: Post;
  readonly device: DeviceInfo;
  readonly hdr: boolean;
  readonly depthMode: 'reversed' | 'standard';
  readonly stats = { calls: 0, tris: 0, frameMs: 16.7, fps: 60, gpuMs: 0 };
  quality: Quality;
  width = 1;
  height = 1;
  lost = false;
  onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;
  dynamicResolution: boolean;
  dynScale = 1;

  private scale = 1; // userScale
  private systems: GfxSystem[] = [];
  private faulted = new Set<string>();
  private sizeDirty = true;
  private cssW = 0;
  private cssH = 0;
  private dpr = 0;
  private observer: ResizeObserver | null = null;
  private onWindowResize = (): void => {
    this.sizeDirty = true;
  };
  private lastFrameAt = 0;
  private gpuTiming: boolean;
  private gpuPending = false;
  private renderFailures = 0;
  private disposed = false;
  // dynamic resolution state
  private dynClock = 0;
  private dynHold = 0; // seconds of headroom seen in a row
  private dynBackoff = 4; // seconds of headroom required before trying a higher scale
  private dynRaisedAt = -1; // dynClock when the scale was last raised (to judge the raise)
  private size = new THREE.Vector2();

  constructor(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement, quality: Quality, device: DeviceInfo, hdr: boolean, o: EngineOptions) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.quality = quality;
    this.device = device;
    this.hdr = hdr;
    this.backend = (renderer.backend as any).isWebGPUBackend === true ? 'webgpu' : 'webgl2';
    this.depthMode = (renderer as any).reversedDepthBuffer === true ? 'reversed' : 'standard';
    this.dynamicResolution = o.dynamicResolution === true;
    this.gpuTiming = o.gpuTiming === true && (renderer.backend as any).trackTimestamp === true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, NEAR, FAR);
    this.camera.rotation.order = 'YXZ'; // yaw, then pitch, then roll: a first-person camera
    this.scene.add(this.camera); // so things parented to the camera (hands, tools) are drawn

    // The post pipeline does exposure, tone mapping and the output transfer.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
    // info is reset by this engine once per frame() (three resets it per animation-loop tick,
    // which is not what drives this renderer).
    renderer.info.autoReset = false;
    this.applyShadowQuality();

    this.post = new Post(renderer, this.scene, this.camera, quality, { backend: this.backend, hdr });

    renderer.onDeviceLost = (info: any): void => this.deviceLost(info);

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(this.onWindowResize);
      this.observer.observe(canvas);
    }
    // Also catches a devicePixelRatio change (browser zoom, moving to another screen).
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onWindowResize);
    this.resize();
  }

  // ---- systems ----

  add(sys: GfxSystem): void {
    const i = this.systems.findIndex((s) => s.name === sys.name);
    if (i >= 0) this.systems.splice(i, 1);
    this.systems.push(sys);
    sys.setQuality?.(this.quality);
    sys.resize?.(this.width, this.height);
  }

  get<T extends GfxSystem>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  // ---- quality and size ----

  setQuality(name: QualityName): void {
    this.quality = getQuality(name);
    this.dynScale = 1;
    this.dynHold = 0;
    this.applyShadowQuality();
    this.post.setQuality(this.quality);
    for (const s of this.systems) s.setQuality?.(this.quality);
    this.resize();
  }

  get userScale(): number {
    return this.scale;
  }

  set userScale(v: number) {
    const s = Math.min(1, Math.max(0.25, Number.isFinite(v) ? v : 1));
    if (s === this.scale) return;
    this.scale = s;
    this.sizeDirty = true;
  }

  private applyShadowQuality(): void {
    const sm = this.renderer.shadowMap;
    sm.enabled = this.quality.shadowCascades > 0;
    sm.type = THREE.PCFShadowMap;
  }

  resize(): void {
    this.sizeDirty = false;
    const canvas = this.canvas;
    // CSS size of the canvas; a canvas that is not laid out yet falls back to the window.
    const cssW = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth || 1));
    const cssH = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight || 1));
    const dpr = window.devicePixelRatio || 1;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const q = this.quality;
    const ratio = Math.min(dpr, q.maxPixelRatio) * Math.min(1, Math.max(0.25, q.renderScale * this.scale * this.dynScale));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(cssW, cssH, false);
    this.renderer.getDrawingBufferSize(this.size);
    this.width = Math.max(1, this.size.x);
    this.height = Math.max(1, this.size.y);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    U.resolution.value.set(this.width, this.height);
    for (const s of this.systems) s.resize?.(this.width, this.height);
  }

  // ---- frame ----

  frame(f: Frame): void {
    if (this.lost || this.disposed) return;
    const renderer = this.renderer;
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      // Wall-clock time between frames, clamped so a background tab does not poison the average.
      const ms = Math.min(250, Math.max(0.1, now - this.lastFrameAt));
      const st = this.stats;
      st.frameMs += (ms - st.frameMs) * 0.08;
      st.fps = 1000 / st.frameMs;
      if (this.dynamicResolution) this.adaptResolution(ms / 1000);
    }
    this.lastFrameAt = now;

    if (this.sizeDirty || window.devicePixelRatio !== this.dpr) this.resize();

    U.time.value = f.time;
    this.syncCamera();
    for (const s of this.systems) {
      if (this.faulted.has(s.name)) continue;
      try {
        s.update(f);
      } catch (e) {
        // A system that throws would throw again next frame: park it and keep the picture alive.
        this.faulted.add(s.name);
        console.error(`[engine] system '${s.name}' threw in update() and is disabled`, e);
      }
    }
    this.syncCamera(); // a system (the camera rig) has usually just moved it

    // One engine frame is one node frame: per-frame nodes (passes, AO, bloom) must run exactly
    // once even when the caller steps several frames inside one animation tick.
    const nodeFrame = (renderer as any)._nodes?.nodeFrame;
    if (nodeFrame) {
      nodeFrame.update();
      (renderer.info as any).frame = nodeFrame.frameId;
    }
    renderer.info.reset();

    try {
      this.post.render();
      this.renderFailures = 0;
    } catch (e) {
      // A render that throws three frames running will not fix itself; stop instead of looping.
      if (++this.renderFailures >= 3) this.deviceLost({ api: this.backend, message: 'render failed: ' + ((e as Error)?.message ?? e), reason: 'error' });
      else console.error('[engine] render failed', e);
      return;
    }

    const info = renderer.info.render;
    this.stats.calls = info.drawCalls;
    this.stats.tris = Math.round(info.triangles);
    if (this.gpuTiming && !this.gpuPending) {
      this.gpuPending = true;
      renderer
        .resolveTimestampsAsync('render' as any)
        .then((ms: unknown) => {
          if (typeof ms === 'number' && ms > 0 && ms < 1000) this.stats.gpuMs += (ms - this.stats.gpuMs) * (this.stats.gpuMs === 0 ? 1 : 0.1);
        })
        .catch(() => {
          this.gpuTiming = false;
        })
        .finally(() => {
          this.gpuPending = false;
        });
    }
  }

  private syncCamera(): void {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    U.camPos.value.set(e[12], e[13], e[14]);
  }

  /**
   * Dynamic resolution. Over budget: step the scale down at once. Under budget: the frame time
   * of a v-synced page says nothing about headroom, so use GPU time when it is measured and
   * otherwise probe upward after a quiet spell, backing off for longer each time a probe fails.
   */
  private adaptResolution(dt: number): void {
    const target = this.quality.name === 'mobile' ? 1000 / 30 : 1000 / 60;
    const ms = this.stats.frameMs;
    const gpu = this.stats.gpuMs;
    this.dynClock += dt;
    let next = this.dynScale;
    if (ms > target * 1.12) {
      this.dynHold = 0;
      // Judge a recent raise: if it broke the budget, wait longer before the next one.
      if (this.dynRaisedAt >= 0 && this.dynClock - this.dynRaisedAt < 3) this.dynBackoff = Math.min(60, this.dynBackoff * 2);
      this.dynRaisedAt = -1;
      // Pixel cost is roughly linear in area, so the scale goes with the square root.
      next = this.dynScale * Math.min(0.95, Math.max(0.8, Math.sqrt(target / ms)));
    } else {
      const headroom = gpu > 0 ? gpu < target * 0.72 : ms < target * 1.04;
      this.dynHold = headroom ? this.dynHold + dt : 0;
      if (this.dynScale < 1 && this.dynHold >= (gpu > 0 ? 1.5 : this.dynBackoff)) {
        next = this.dynScale + 0.05;
        this.dynHold = 0;
        this.dynRaisedAt = this.dynClock;
      }
    }
    // Quantised and rate-limited: every change reallocates the render targets.
    next = Math.min(1, Math.max(0.6, Math.round(next * 20) / 20));
    if (next !== this.dynScale && this.dynClock >= 0.75) {
      this.dynScale = next;
      this.dynClock = 0;
      if (this.dynRaisedAt >= 0) this.dynRaisedAt = 0;
      this.stats.frameMs = Math.min(this.stats.frameMs, target * 1.1); // let the average settle from a fair start
      this.sizeDirty = true;
    }
  }

  async compile(object: THREE.Object3D): Promise<void> {
    if (this.lost || this.disposed) return;
    try {
      object.updateMatrixWorld(true);
      await this.post.compile(object);
    } catch (e) {
      console.error('[engine] compile failed', e);
    }
  }

  async warmup(): Promise<void> {
    if (this.lost || this.disposed) return;
    this.camera.updateMatrixWorld();
    try {
      await this.post.compile();
    } catch (e) {
      console.error('[engine] warmup compile failed', e);
    }
    if (this.lost || this.disposed) return;
    // One real frame: builds the post materials and anything compileAsync does not reach
    // (shadow passes), while a loading screen is still up.
    try {
      this.syncCamera();
      this.post.render();
    } catch (e) {
      console.error('[engine] warmup render failed', e);
    }
  }

  private deviceLost(info: any): void {
    if (this.lost) return;
    this.lost = true;
    (this.renderer as any)._isDeviceLost = true; // what three's own handler does; render() becomes a no-op
    const detail: DeviceLostInfo = { api: String(info?.api ?? this.backend), message: String(info?.message ?? 'unknown'), reason: info?.reason ?? null };
    // Remembered for this tab: the next createEngine starts one step safer instead of
    // walking into the same loss again.
    writeLost({ t: Date.now(), backend: this.backend, quality: this.quality.name });
    console.warn(`[engine] graphics device lost (${detail.api}: ${detail.message}). Rendering has stopped.`);
    try {
      this.onDeviceLost?.(detail);
      this.canvas.dispatchEvent(new CustomEvent('cs:devicelost', { detail }));
    } catch (e) {
      console.error(e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onWindowResize);
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch (e) {
        console.error(e);
      }
    }
    this.systems.length = 0;
    this.post.dispose();
    this.renderer.dispose();
  }
}

/**
 * Create the renderer and everything around it. Resolves when the backend is initialised; the
 * caller then adds systems, calls warmup(), and drives frame() from its own loop.
 */
export async function createEngine(canvas: HTMLCanvasElement, opts: { quality: QualityName; forceWebGL?: boolean } & Partial<EngineOptions>): Promise<CsEngine> {
  const device = await detectDevice();
  let qualityName = opts.quality;
  let forceWebGL = opts.forceWebGL === true;
  try {
    const p = new URLSearchParams(location.search).get('webgl');
    if (p !== null && p !== '0' && p !== 'false') forceWebGL = true;
  } catch {
    /* no location: keep the option */
  }
  // No WebGPU adapter: ask for WebGL2 outright, so three does not have to fail first (and warn).
  if (!device.webgpu) forceWebGL = true;

  // A device lost earlier in this tab: come back one step safer, never the same way twice.
  const lost = readLost();
  if (lost) {
    if (lost.backend === 'webgpu' && !forceWebGL) forceWebGL = true;
    else qualityName = lowerQuality(qualityName);
    try {
      sessionStorage.removeItem(LOST_KEY);
    } catch {
      /* ignore */
    }
  }

  const gl = forceWebGL ? probeWebGL2() : null;
  // Half-float colour targets: always on WebGPU; on WebGL2 only with the extension.
  const hdr = opts.forceLDR === true ? false : gl ? gl.halfFloat : true;
  // Reversed depth: always on WebGPU; on WebGL2 it needs EXT_clip_control.
  const reversed = opts.depth === 'standard' ? false : gl ? gl.clipControl : true;

  // Chrome on Windows ignores the adapter power preference and warns about it on every page
  // load; elsewhere (dual-GPU Macs and Linux laptops) it picks the discrete GPU.
  let windows = false;
  try {
    windows = /Windows/i.test(navigator.userAgent);
  } catch {
    /* no navigator */
  }
  const params = {
    canvas,
    antialias: false, // the scene is drawn into the post pipeline's own target
    alpha: false,
    stencil: false,
    forceWebGL,
    reversedDepthBuffer: reversed,
    outputBufferType: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    powerPreference: windows ? undefined : 'high-performance',
    trackTimestamp: opts.gpuTiming === true,
  };
  const renderer = new THREE.WebGPURenderer(params as any);
  await renderer.init();

  // WebGPU was expected but three fell back to WebGL2 (device creation failed): re-check what
  // that context can do, since the choices above assumed WebGPU.
  let hdrFinal = hdr;
  if (!forceWebGL && (renderer.backend as any).isWebGPUBackend !== true) {
    const probe = probeWebGL2();
    if (hdr && !probe.halfFloat) {
      hdrFinal = false;
      (renderer as any)._outputBufferType = THREE.UnsignedByteType;
    }
  }

  return new EngineImpl(renderer, canvas, getQuality(qualityName), device, hdrFinal, { ...opts, quality: qualityName });
}
