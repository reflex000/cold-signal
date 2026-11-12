// Pure helpers that turn view state into what the interface shows. No DOM here, so they can be
// tested in node (model.test.ts) and shared by the HUD, the touch controls and the pack.
import type { Camera } from '../game/view';
import type { Env, Inventory, ItemId, PlayerEnt, ToolId } from '../sim/types';

/** Body-temperature stage: 0 healthy, 1 cold, 2 freezing, 3 severe (DESIGN.md section 1). */
export type ColdStage = 0 | 1 | 2 | 3;
export const STAGE_NAME: readonly string[] = ['', 'Cold', 'Freezing', 'Severe'];
/** Upper core temperature of each stage: at or below 35 is cold, 33 freezing, 31 severe. */
const STAGE_TOP = [Infinity, 35, 33, 31];

/** Stage with a small hysteresis so a core sitting on a boundary does not flicker. */
export function coldStage(core: number, prev: ColdStage = 0): ColdStage {
  let s: ColdStage = 0;
  if (core <= STAGE_TOP[3]) s = 3;
  else if (core <= STAGE_TOP[2]) s = 2;
  else if (core <= STAGE_TOP[1]) s = 1;
  if (s < prev && core < STAGE_TOP[prev] + 0.08) return prev; // warming: wait until clearly out
  return s;
}

/** The instrument scale: collapse (30) at the left end, a little above healthy at the right. */
export const CORE_MIN = 30;
export const CORE_MAX = 37.5;
export const coreFrac = (core: number) => clamp01((core - CORE_MIN) / (CORE_MAX - CORE_MIN));

/** Trend arrow from deg C per minute: '' (steady), 'dn', 'dn fast', 'up', 'up fast'. */
export function trendClass(trend: number): string {
  if (trend <= -0.9) return 'dn fast';
  if (trend <= -0.12) return 'dn';
  if (trend >= 0.9) return 'up fast';
  if (trend >= 0.12) return 'up';
  return '';
}

export interface Readout {
  /** Large number (rounds in the chamber), or ''. */
  big: string;
  /** Small text after it (reserve), or ''. */
  small: string;
  /** Nothing loaded. */
  empty: boolean;
  /** 0..1 charge line, or -1 when the tool has none. */
  bar: number;
  low: boolean;
  /** 0..5 signal bars, or -1. */
  sig: number;
  /** Short text beside the line ('On', '240 m'), or ''. */
  note: string;
}

const n = (inv: Inventory, item: ItemId) => inv[item] ?? 0;

/** What the held tool shows: ammunition, charge or signal. Null for hands and the axe. */
export function toolReadout(me: PlayerEnt, tool: ToolId = me.held): Readout | null {
  const inv = me.inv;
  switch (tool) {
    case 'rifle':
      return { big: String(me.loaded), small: '/ ' + n(inv, 'ammo'), empty: me.loaded <= 0, bar: -1, low: false, sig: -1, note: '' };
    case 'flaregun':
      return { big: String(me.flareLoaded), small: '/ ' + n(inv, 'flare'), empty: me.flareLoaded <= 0, bar: -1, low: false, sig: -1, note: '' };
    case 'flashlight': {
      const cells = n(inv, 'cell');
      return {
        big: '', small: cells ? cells + (cells === 1 ? ' cell' : ' cells') : '', empty: me.cellCharge <= 0.001,
        bar: clamp01(me.cellCharge), low: me.cellCharge < 0.2, sig: -1, note: me.lightOn ? 'On' : 'Off',
      };
    }
    case 'radio': {
      const sig = me.radioCharge > 0.001 ? Math.round(clamp01(me.radioSig) * 5) : 0;
      const near = me.radioDist >= 0 && me.radioSig > 0.55 && me.radioCharge > 0.001;
      return { big: '', small: '', empty: me.radioCharge <= 0.001, bar: clamp01(me.radioCharge), low: me.radioCharge < 0.15, sig, note: near ? fmtNear(me.radioDist) : '' };
    }
    default:
      return null;
  }
}

/** Coarse distance for the radio: the needle is a tone, not a range finder. */
function fmtNear(m: number): string {
  if (m < 40) return 'close';
  if (m < 1000) return 'about ' + Math.round(m / 50) * 50 + ' m';
  return 'about ' + (m / 1000).toFixed(1) + ' km';
}

/** Is there something for the context button (reload / light)? Returns the action or null. */
export function contextAction(me: PlayerEnt): 'reload' | 'light' | null {
  if (me.held === 'rifle' && me.loaded < 5 && n(me.inv, 'ammo') > 0) return 'reload';
  if (me.held === 'flaregun' && me.flareLoaded < 1 && n(me.inv, 'flare') > 0) return 'reload';
  if (me.held === 'flashlight') return 'light';
  return null;
}

/** Owns this tool (hands are always there). */
export const hasTool = (me: PlayerEnt, t: ToolId) => t === 'hands' || n(me.inv, t) > 0;

/** Wind the body actually feels, m/s: mean plus gust, scaled down by shelter. */
export function windFelt(env: Env, me: PlayerEnt): number {
  const w = Math.hypot(env.windX, env.windZ) * (1 + env.gust * 0.5);
  return w * (1 - clamp01(me.shelter));
}

/** Bearing from one point to another: radians, 0 = north (-Z), clockwise (east = +PI/2). */
export function bearingTo(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(tx - fx, -(tz - fz));
}

/** Wrap an angle to -PI..PI. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/**
 * Project a world point to CSS pixels for a w x h viewport. Writes out[0..2] = x, y, depth
 * (metres in front of the eye) and returns false when the point is behind the camera.
 * Yaw 0 looks north (-Z) and grows counter-clockwise seen from above; pitch up is positive.
 */
export function project(cam: Camera, x: number, y: number, z: number, w: number, h: number, out: number[]): boolean {
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  // right = (cy, 0, -sy); forward = (-sy cp, sp, -cy cp); up = (sy sp, cp, cy sp)
  const xr = dx * cy - dz * sy;
  const zf = -dx * sy * cp + dy * sp - dz * cy * cp;
  const yu = dx * sy * sp + dy * cp + dz * cy * sp;
  out[2] = zf;
  if (zf < 0.05) return false;
  const t = Math.tan(((cam.fov || 70) * Math.PI) / 360);
  out[0] = (0.5 + (xr / (zf * t * (w / h))) * 0.5) * w;
  out[1] = (0.5 - (yu / (zf * t)) * 0.5) * h;
  return true;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
