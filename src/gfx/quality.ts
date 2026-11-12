// The five quality presets. Every quality-dependent number in the game comes from one of these
// objects (see Quality in ./api.ts). Targets: 'medium' holds 60 fps at 1080p on an Intel Arc
// integrated GPU; 'mobile' holds 30+ fps on a recent phone (tile-based GPU, WebGL2 or WebGPU).
// Owner: ENGINE.
import type { Quality, QualityName } from './api';

export const QUALITY_NAMES: readonly QualityName[] = ['mobile', 'low', 'medium', 'high', 'ultra'];

const PRESETS: Record<QualityName, Quality> = {
  // Phones. One scene pass and one full-screen pass (plus a quarter-resolution glow). The device
  // pixel ratio of a phone is 2.6 to 3.5; 1.5 * 0.75 lands near 950 x 440 on a 6.1 inch screen.
  mobile: {
    name: 'mobile',
    renderScale: 0.75,
    maxPixelRatio: 1.5,
    shadowCascades: 1,
    shadowMapSize: 1024,
    shadowDistance: 36,
    fireShadows: false,
    terrainDetail: 0,
    viewDistance: 900,
    treeNear: 36,
    treeDensity: 0.4,
    groundCover: 0.15,
    snowDeform: 0,
    snowParticles: 1200,
    volumetricSteps: 0,
    cloudSteps: 0,
    auroraSteps: 0,
    ao: false,
    bloom: true, // the cheap quarter-resolution glow, see post.ts
    aa: 'none',
    godrays: false,
    motionBlur: false,
    dof: false,
    grain: false,
    maxLights: 2,
    particleBudget: 0.3,
  },
  // Old laptops and weak integrated GPUs.
  low: {
    name: 'low',
    renderScale: 0.75,
    maxPixelRatio: 1,
    shadowCascades: 2,
    shadowMapSize: 1024,
    shadowDistance: 60,
    fireShadows: false,
    terrainDetail: 1,
    viewDistance: 1600,
    treeNear: 55,
    treeDensity: 0.6,
    groundCover: 0.35,
    snowDeform: 256,
    snowParticles: 3000,
    volumetricSteps: 0,
    cloudSteps: 0,
    auroraSteps: 8,
    ao: false,
    bloom: true, // cheap glow
    aa: 'fxaa',
    godrays: false,
    motionBlur: false,
    dof: false,
    grain: true,
    maxLights: 3,
    particleBudget: 0.5,
  },
  // Intel Arc / Iris Xe / Apple M-series class at 1080p.
  medium: {
    name: 'medium',
    renderScale: 0.85,
    maxPixelRatio: 1,
    shadowCascades: 3,
    shadowMapSize: 1536,
    shadowDistance: 110,
    fireShadows: false,
    terrainDetail: 2,
    viewDistance: 2800,
    treeNear: 80,
    treeDensity: 0.85,
    groundCover: 0.6,
    snowDeform: 512,
    snowParticles: 7000,
    volumetricSteps: 10,
    cloudSteps: 12,
    auroraSteps: 16,
    ao: true,
    bloom: true,
    aa: 'fxaa',
    godrays: false,
    motionBlur: false,
    dof: false,
    grain: true,
    maxLights: 4,
    particleBudget: 0.75,
  },
  // Discrete GPUs.
  high: {
    name: 'high',
    renderScale: 1,
    maxPixelRatio: 1.5,
    shadowCascades: 3,
    shadowMapSize: 2048,
    shadowDistance: 170,
    fireShadows: true,
    terrainDetail: 3,
    viewDistance: 4200,
    treeNear: 120,
    treeDensity: 1,
    groundCover: 0.85,
    snowDeform: 1024,
    snowParticles: 14000,
    volumetricSteps: 20,
    cloudSteps: 24,
    auroraSteps: 24,
    ao: true,
    bloom: true,
    aa: 'smaa',
    godrays: true,
    motionBlur: false,
    dof: false,
    grain: true,
    maxLights: 6,
    particleBudget: 1,
  },
  // Fast discrete GPUs; screenshots.
  ultra: {
    name: 'ultra',
    renderScale: 1,
    maxPixelRatio: 2,
    shadowCascades: 4,
    shadowMapSize: 4096,
    shadowDistance: 260,
    fireShadows: true,
    terrainDetail: 3,
    viewDistance: 5600,
    treeNear: 180,
    treeDensity: 1,
    groundCover: 1,
    snowDeform: 2048,
    snowParticles: 24000,
    volumetricSteps: 36,
    cloudSteps: 40,
    auroraSteps: 40,
    ao: true,
    bloom: true,
    aa: 'taa',
    godrays: true,
    motionBlur: true,
    dof: true,
    grain: true,
    maxLights: 8,
    particleBudget: 1,
  },
};

/** A fresh copy of a preset, so a caller may adjust it (settings.renderScale, settings.grain). */
export function getQuality(name: QualityName): Quality {
  return { ...(PRESETS[name] ?? PRESETS.medium) };
}

export function isQualityName(v: unknown): v is QualityName {
  return typeof v === 'string' && (QUALITY_NAMES as readonly string[]).includes(v);
}

/** One step down, for the dynamic fallback after repeated slow frames or a lost device. */
export function lowerQuality(name: QualityName): QualityName {
  const i = QUALITY_NAMES.indexOf(name);
  return QUALITY_NAMES[Math.max(0, i - 1)];
}
