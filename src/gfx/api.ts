// CONTRACT for the rendering layer. three.js WebGPURenderer (WebGPU backend, automatic WebGL2
// fallback) with TSL node materials only, so one material source runs on both backends.
// Owner: MAIN (interfaces); ENGINE implements src/gfx/engine.ts and src/gfx/shared.ts.
import type * as THREE from 'three/webgpu';
import type { View } from '../game/view';

/** 'mobile' is the phone tier: below 'low', tuned for tile-based mobile GPUs and thermal limits. */
export type QualityName = 'mobile' | 'low' | 'medium' | 'high' | 'ultra';

/** Every quality-dependent number lives here, so a preset is one object. Tuned in src/gfx/quality.ts. */
export interface Quality {
  name: QualityName;
  renderScale: number; // fraction of the canvas CSS size * devicePixelRatio (capped)
  maxPixelRatio: number;
  // shadows
  shadowCascades: number; // 0 = sun shadows off
  shadowMapSize: number;
  shadowDistance: number; // metres
  fireShadows: boolean; // point-light shadow on the nearest fire
  // world
  terrainDetail: number; // 0..3 mesh density tier
  viewDistance: number; // metres at which terrain / trees end in clear weather
  treeNear: number; // metres of full 3D trees; beyond that impostors
  treeDensity: number; // 0..1 fraction of world trees drawn
  groundCover: number; // 0..1 small rocks, twigs, grass tufts through snow
  snowDeform: number; // trail texture size (0 = footprints as decals only)
  // weather
  snowParticles: number; // particle count of the near snowfall volume
  volumetricSteps: number; // fog ray-march steps (0 = analytic fog only)
  cloudSteps: number;
  auroraSteps: number;
  // post
  ao: boolean;
  bloom: boolean;
  aa: 'none' | 'fxaa' | 'smaa' | 'taa';
  godrays: boolean;
  motionBlur: boolean;
  dof: boolean;
  grain: boolean;
  // misc
  maxLights: number; // dynamic point lights kept alive at once (fires, flares, flashlights)
  particleBudget: number; // 0..1 scale on embers / smoke / breath counts
}

/** Per-frame data handed to every system. */
export interface Frame {
  dt: number; // seconds since the last rendered frame (clamped)
  time: number; // render clock, seconds
  view: View;
}

export interface GfxSystem {
  name: string;
  /** Called once per rendered frame before the scene is drawn. */
  update(f: Frame): void;
  setQuality?(q: Quality): void;
  resize?(w: number, h: number): void;
  dispose?(): void;
}

export interface Engine {
  readonly renderer: THREE.WebGPURenderer;
  readonly backend: 'webgpu' | 'webgl2';
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  quality: Quality;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  add(sys: GfxSystem): void;
  get<T extends GfxSystem>(name: string): T | undefined;
  setQuality(name: QualityName): void;
  resize(): void;
  /** Update all systems then render one frame through the post pipeline. */
  frame(f: Frame): void;
  /** Compile materials ahead of time for what is in the scene now. */
  warmup(): Promise<void>;
  readonly stats: { calls: number; tris: number; frameMs: number; fps: number; gpuMs: number };
  dispose(): void;
}
