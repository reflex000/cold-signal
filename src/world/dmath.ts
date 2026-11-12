// Deterministic trigonometry for world generation. Math.sin / cos / atan2 / exp / hypot are only
// "implementation-approximated" by the spec and can differ in the last bit between JS engines;
// host and clients build the world independently from the seed, so everything that decides
// where things are uses these instead. Only + - * / sqrt floor (all exactly specified by IEEE
// 754) are used. Accuracy is about 1e-15 relative on the reduced ranges, far more than needed.

const PIO2_HI = 1.5707963267341256; // pi/2 split for an exact-enough range reduction
const PIO2_LO = 6.077100506506192e-11;
export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

function sinPoly(x: number): number {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))));
}
function cosPoly(x: number): number {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200)))))));
}

/** sin(x), deterministic. Intended for |x| < 1e5. */
export function dsin(x: number): number {
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch (k & 3) {
    case 0: return sinPoly(r);
    case 1: return cosPoly(r);
    case 2: return -sinPoly(r);
    default: return -cosPoly(r);
  }
}

/** cos(x), deterministic. */
export function dcos(x: number): number {
  const k = Math.floor(x / HALF_PI + 0.5);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch (k & 3) {
    case 0: return cosPoly(r);
    case 1: return -sinPoly(r);
    case 2: return -cosPoly(r);
    default: return sinPoly(r);
  }
}

/** atan(x), deterministic. */
export function datan(x: number): number {
  let sign = 1;
  if (x < 0) {
    sign = -1;
    x = -x;
  }
  let base = 0;
  if (x > 1) {
    base = HALF_PI;
    x = -1 / x; // atan(x) = pi/2 + atan(-1/x)
  }
  // Two half-angle steps bring |t| under 0.21: atan(t) = 2 atan(t / (1 + sqrt(1 + t^2))).
  let t = x / (1 + Math.sqrt(1 + x * x));
  t = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t * t;
  // Taylor series of atan to t^23: the next term is below 1e-17 for |t| < 0.21.
  let s = 1 / 23;
  for (let k = 21; k >= 1; k -= 2) s = 1 / k - t2 * s;
  return sign * (base + 4 * t * s);
}

/** atan2(y, x), deterministic, in (-pi, pi]. */
export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** sqrt(x*x + y*y) without Math.hypot (which is not exactly specified). */
export function dlen(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Smooth compact bump: 1 at t = 0, 0 for |t| >= 1, zero slope at both ends. */
export function bump(t: number): number {
  if (t <= -1 || t >= 1) return 0;
  const a = 1 - t * t;
  return a * a;
}

export function smooth01(a: number, b: number, v: number): number {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Wrap an angle into (-pi, pi]. */
export function wrapPi(a: number): number {
  a = (a + PI) % TAU;
  if (a <= 0) a += TAU;
  return a - PI;
}
