// Device detection: what kind of machine this is, what its GPU can do, and which quality preset
// the 'auto' setting should mean. Nothing here throws; an unknown device reads as a mid desktop.
// Owner: ENGINE.
import type { QualityName } from './api';

/** software = CPU rasteriser; mobile = phone / tablet SoC; integrated = laptop iGPU; discrete = a graphics card. */
export type GpuClass = 'software' | 'mobile' | 'integrated' | 'discrete' | 'unknown';

export interface DeviceInfo {
  /** Phone or tablet: touch is the primary input, no pointer lock, no keyboard assumed. */
  touch: boolean;
  phone: boolean;
  tablet: boolean;
  /** navigator.maxTouchPoints; a laptop with a touch screen has points but `touch` stays false. */
  touchPoints: number;
  /** A WebGPU adapter was actually obtained (not just navigator.gpu present). */
  webgpu: boolean;
  webgl2: boolean;
  /** Human-readable GPU description, best source available; '' when the browser hides it. */
  adapter: string;
  vendor: string;
  gpuClass: GpuClass;
  /** 0 software / very weak .. 1 phone or old iGPU .. 2 current iGPU .. 3 discrete. */
  tier: 0 | 1 | 2 | 3;
  /** WebGL2 can render to RGBA16F targets (HDR scene buffer). Always true on WebGPU. */
  halfFloat: boolean;
  /** WebGL2 has EXT_clip_control (reversed depth). Always available on WebGPU. */
  clipControl: boolean;
  maxTextureSize: number;
  pixelRatio: number;
  /** navigator.deviceMemory in GB when exposed, else 0. */
  memoryGb: number;
  cores: number;
}

const RX_SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|warp/i;
const RX_MOBILE = /adreno|mali|powervr|immortalis|xclipse|videocore|tegra|apple a\d|apple gpu/i;
const RX_DISCRETE = /nvidia|geforce|\brtx\b|\bgtx\b|quadro|titan|radeon (rx|pro|r\d)|radeon\(tm\) (rx|pro)|\brx ?\d{3,4}|firepro|arc\(tm\) (pro )?[ab]\d{3}|arc (pro )?[ab]\d{3}/i;
const RX_INTEGRATED = /intel|iris|uhd graphics|hd graphics|radeon\(tm\) graphics|radeon graphics|radeon vega|vega \d|apple m\d|apple/i;
/** Integrated GPUs too old for 'medium'. */
const RX_WEAK_IGPU = /hd graphics( \d{3,4})?\b|uhd graphics (6[0-3]\d|5\d\d)|gma|\bhd \d{4}\b|radeon r[2-7] graphics|vega [3-6]\b/i;

function classify(desc: string): GpuClass {
  if (!desc) return 'unknown';
  if (RX_SOFTWARE.test(desc)) return 'software';
  if (RX_MOBILE.test(desc)) return 'mobile';
  if (RX_DISCRETE.test(desc)) return 'discrete';
  if (RX_INTEGRATED.test(desc)) return 'integrated';
  return 'unknown';
}

interface GlProbe {
  ok: boolean;
  renderer: string;
  vendor: string;
  halfFloat: boolean;
  clipControl: boolean;
  maxTextureSize: number;
}

let glProbeCache: GlProbe | null = null;

/** One throwaway WebGL2 context: capability bits the WebGL2 backend needs before it is created. */
export function probeWebGL2(): GlProbe {
  if (glProbeCache) return glProbeCache;
  const out: GlProbe = { ok: false, renderer: '', vendor: '', halfFloat: false, clipControl: false, maxTextureSize: 0 };
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (gl) {
      out.ok = true;
      out.halfFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
      out.clipControl = !!gl.getExtension('EXT_clip_control');
      out.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.renderer = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
      out.vendor = String((dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) || '');
      // Phones allow only a handful of live contexts: give this one back straight away.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* no WebGL2 */
  }
  glProbeCache = out;
  return out;
}

function formFactor(): { phone: boolean; tablet: boolean; touchPoints: number } {
  let phone = false;
  let tablet = false;
  let touchPoints = 0;
  try {
    const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } };
    const ua = nav.userAgent || '';
    touchPoints = nav.maxTouchPoints || 0;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const uaMobile = nav.userAgentData?.mobile === true;
    const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1); // iPadOS says it is a Mac
    const android = /Android/i.test(ua);
    phone = /iPhone|iPod|Windows Phone/i.test(ua) || (android && /Mobile/i.test(ua)) || (uaMobile && !iPad && !android);
    tablet = !phone && (iPad || android || /Tablet|Silk|Kindle|PlayBook/i.test(ua));
    // An unknown device whose only pointer is a finger: decide by the shorter screen side.
    if (!phone && !tablet && coarse && touchPoints > 0 && !/Windows NT|Mac OS X|CrOS|Linux x86_64/i.test(ua)) {
      const short = Math.min(screen.width, screen.height);
      if (short < 600) phone = true;
      else tablet = true;
    }
  } catch {
    /* treat as desktop */
  }
  return { phone, tablet, touchPoints };
}

function baseInfo(): DeviceInfo {
  const ff = formFactor();
  const gl = probeWebGL2();
  let pixelRatio = 1;
  let memoryGb = 0;
  let cores = 4;
  try {
    pixelRatio = window.devicePixelRatio || 1;
    memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;
    cores = navigator.hardwareConcurrency || 4;
  } catch {
    /* defaults */
  }
  const info: DeviceInfo = {
    touch: ff.phone || ff.tablet,
    phone: ff.phone,
    tablet: ff.tablet,
    touchPoints: ff.touchPoints,
    webgpu: false,
    webgl2: gl.ok,
    adapter: gl.renderer,
    vendor: gl.vendor,
    gpuClass: 'unknown',
    tier: 2,
    halfFloat: gl.halfFloat,
    clipControl: gl.clipControl,
    maxTextureSize: gl.maxTextureSize,
    pixelRatio,
    memoryGb,
    cores,
  };
  rate(info);
  return info;
}

function rate(info: DeviceInfo): void {
  let cls = classify(info.adapter + ' ' + info.vendor);
  if (info.phone || info.tablet) {
    // A phone SoC is a phone SoC whatever the string says (Apple reports 'Apple GPU' everywhere).
    if (cls !== 'software') cls = 'mobile';
  } else if (cls === 'mobile' && /apple/i.test(info.adapter + ' ' + info.vendor)) {
    // Safari on a Mac hides the chip behind 'Apple GPU': not a phone, so an M-series (or a late
    // Intel) integrated GPU.
    cls = 'integrated';
  }
  info.gpuClass = cls;
  let tier: 0 | 1 | 2 | 3;
  if (cls === 'software') tier = 0;
  else if (cls === 'mobile') tier = 1;
  else if (cls === 'discrete') tier = 3;
  else if (cls === 'integrated') tier = RX_WEAK_IGPU.test(info.adapter) && !/iris|arc|xe/i.test(info.adapter) ? 1 : 2;
  else tier = info.cores <= 2 || (info.memoryGb > 0 && info.memoryGb <= 2) ? 1 : 2;
  info.tier = tier;
}

let cached: DeviceInfo | null = null;
let pending: Promise<DeviceInfo> | null = null;

/** What can be known without waiting (no WebGPU adapter query). */
export function detectDeviceSync(): DeviceInfo {
  return cached ?? baseInfo();
}

/** Full detection, including the WebGPU adapter. Cached; never rejects. */
export function detectDevice(): Promise<DeviceInfo> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = (async () => {
    const info = baseInfo();
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<any> } }).gpu;
      if (gpu) {
        const adapter: any = await gpu.requestAdapter();
        if (adapter) {
          info.webgpu = true;
          const ai = adapter.info ?? {};
          const desc = [ai.description, ai.vendor, ai.architecture, ai.device].filter((s: unknown) => typeof s === 'string' && s).join(' ');
          if (ai.isFallbackAdapter === true || adapter.isFallbackAdapter === true) info.adapter = 'software ' + (desc || info.adapter);
          else if (desc && (!info.adapter || classify(info.adapter) === 'unknown')) info.adapter = desc;
          if (!info.vendor && typeof ai.vendor === 'string') info.vendor = ai.vendor;
          const max = adapter.limits?.maxTextureDimension2D;
          if (typeof max === 'number' && max > info.maxTextureSize) info.maxTextureSize = max;
        }
      }
    } catch {
      /* WebGPU not usable: the WebGL2 numbers stand */
    }
    rate(info);
    cached = info;
    return info;
  })();
  return pending;
}

/**
 * The preset behind the 'auto' setting: phones and tablets 'mobile', software rendering 'mobile',
 * old integrated GPUs 'low', current integrated GPUs 'medium', graphics cards 'high'. 'ultra' is
 * never chosen automatically.
 */
export function pickQuality(info: DeviceInfo = detectDeviceSync()): QualityName {
  if (info.phone || info.tablet) return 'mobile';
  if (info.tier === 0) return 'mobile';
  if (info.tier === 1) return 'low';
  if (info.tier === 3) return 'high';
  return 'medium';
}
