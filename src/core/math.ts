export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (v - a) / (b - a);
export const remap = (v: number, a: number, b: number, c: number, d: number) => c + (d - c) * sat((v - a) / (b - a));
export function smoothstep(a: number, b: number, v: number): number {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** Frame-rate independent approach: moves a toward b with time constant 1/rate. */
export const damp = (a: number, b: number, rate: number, dt: number) => b + (a - b) * Math.exp(-rate * dt);
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDiff = (from: number, to: number) => wrapAngle(to - from);
export const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;
export const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
export const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
export const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const sign = (v: number) => (v < 0 ? -1 : 1);
export const fract = (v: number) => v - Math.floor(v);
/** Move v toward target by at most step. */
export function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}
